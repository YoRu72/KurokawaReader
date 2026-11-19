// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery), piece P1: Bluetooth devices' levels on Linux as BlueZ keeps them, read
// from `upower -d` (UPower lists BlueZ's Battery1 levels — HFP headsets, the GATT Battery Service — with the rest).
// Written for Tools (the original read BlueZ nowhere). Only BlueZ's entries are taken: the computer's own battery and
// the kernel's peripheral batteries (read from /sys directly, sysfs.rs) are left out. The text is parsed defensively:
// an unknown line is skipped, a percentage outside 0..=100 is no level, a block without an address is dropped.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::model::{Charging, Coarse, Kind};

/// The fixed places upower may be (never looked for on the PATH).
pub const UPOWER: &[&str] = &["/usr/bin/upower", "/bin/upower"];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UpDev {
    /// The Bluetooth address, «AA:BB:CC:DD:EE:FF».
    pub addr: String,
    pub model: String,
    pub kind_word: String,
    pub percent: Option<u8>,
    pub coarse: Option<Coarse>,
    pub charging: Charging,
}

impl Default for Charging {
    fn default() -> Charging {
        Charging::Unknown
    }
}

/// «/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF» → «AA:BB:CC:DD:EE:FF».
pub fn bluez_addr(native: &str) -> Option<String> {
    let n = native.trim();
    if !n.starts_with("/org/bluez/") {
        return None;
    }
    let tail = n.rsplit('/').next()?.strip_prefix("dev_")?;
    crate::connect::parse_addr(&tail.replace('_', ":")).map(crate::connect::addr_text)
}

/// UPower's device kind word → ours.
pub fn kind_of(word: &str, model: &str) -> Kind {
    match word {
        "mouse" | "touchpad" => Kind::Mouse,
        "keyboard" => Kind::Keyboard,
        "headset" | "headphones" => Kind::Headset,
        "gaming-input" | "game-controller" => Kind::Controller,
        "phone" => Kind::Phone,
        "speakers" => Kind::Speaker,
        _ => crate::kind::guess(model),
    }
}

fn percent_of(v: &str) -> Option<u8> {
    let n: f64 = v.trim().trim_end_matches('%').trim().parse().ok()?;
    if !(0.0..=100.0).contains(&n) {
        return None;
    }
    Some(n.round() as u8)
}

/// The BlueZ devices in `upower -d`'s output (at most 64).
pub fn parse(text: &str) -> Vec<UpDev> {
    let mut out = Vec::new();
    let mut cur: Option<(UpDev, bool)> = None;
    let flush = |c: Option<(UpDev, bool)>, out: &mut Vec<UpDev>| {
        if let Some((d, ok)) = c {
            if ok && !d.addr.is_empty() && out.len() < 64 {
                out.push(d);
            }
        }
    };
    for line in text.lines().take(20_000) {
        if line.starts_with("Device:") || line.starts_with("Daemon:") {
            flush(cur.take(), &mut out);
            if line.starts_with("Device:") {
                cur = Some((UpDev::default(), false));
            }
            continue;
        }
        let Some((d, ok)) = cur.as_mut() else { continue };
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        match t.split_once(':') {
            Some((k, v)) if !k.contains(' ') || k == "power supply" || k == "battery-level" => {
                let v = v.trim().trim_matches('\'');
                match k.trim() {
                    "native-path" => {
                        if let Some(a) = bluez_addr(v) {
                            d.addr = a;
                            *ok = true;
                        }
                    }
                    "model" => d.model = v.chars().filter(|c| !c.is_control()).take(128).collect(),
                    "percentage" => d.percent = percent_of(v),
                    "battery-level" => {
                        d.coarse = match v {
                            "critical" => Some(Coarse::Empty),
                            "low" => Some(Coarse::Low),
                            "normal" => Some(Coarse::Medium),
                            "high" => Some(Coarse::High),
                            "full" => Some(Coarse::Full),
                            _ => None,
                        }
                    }
                    "state" => {
                        d.charging = match v {
                            "charging" => Charging::Yes,
                            "discharging" | "fully-charged" | "pending-charge" => Charging::No,
                            _ => Charging::Unknown,
                        }
                    }
                    "power supply" if v == "yes" => *ok = false,
                    _ => {}
                }
            }
            // (The kind is a word alone on its line: «mouse», «headset», «gaming-input».)
            None if t.chars().all(|c| c.is_ascii_lowercase() || c == '-') && d.kind_word.is_empty() => d.kind_word = t.to_string(),
            _ => {}
        }
    }
    flush(cur.take(), &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "Device: /org/freedesktop/UPower/devices/battery_BAT0
  native-path:          BAT0
  vendor:               Made Up
  power supply:         yes
  battery
    percentage:          81%

Device: /org/freedesktop/UPower/devices/headset_dev_AA_BB_CC_DD_EE_01
  native-path:          /org/bluez/hci0/dev_AA_BB_CC_DD_EE_01
  model:                Test Headset One
  serial:               AA:BB:CC:DD:EE:01
  power supply:         no
  updated:              Thu 01 Jan 2026 00:00:00 (5 seconds ago)
  has history:          yes
  headset
    warning-level:       none
    percentage:          70%
    icon-name:          'battery-full-symbolic'

Device: /org/freedesktop/UPower/devices/mouse_dev_AA_BB_CC_DD_EE_02
  native-path:          /org/bluez/hci0/dev_AA_BB_CC_DD_EE_02
  model:                Test Mouse
  power supply:         no
  mouse
    state:               charging
    percentage:          55.0000%
    battery-level:       normal

Device: /org/freedesktop/UPower/devices/gaming_input_ps_controller_battery
  native-path:          ps-controller-battery-aa:bb:cc:dd:ee:03
  gaming-input
    percentage:          40%

Device: /org/freedesktop/UPower/devices/x
  native-path:          /org/bluez/hci0/dev_ZZ_BB_CC_DD_EE_02
  percentage:          140%

Daemon:
  daemon-version:  1.90.0
";

    #[test]
    fn bluez_entries_only() {
        let l = parse(SAMPLE);
        assert_eq!(l.len(), 2, "{l:?}");
        assert_eq!((l[0].addr.as_str(), l[0].model.as_str(), l[0].kind_word.as_str(), l[0].percent, l[0].charging), ("AA:BB:CC:DD:EE:01", "Test Headset One", "headset", Some(70), Charging::Unknown));
        assert_eq!((l[1].percent, l[1].coarse, l[1].charging), (Some(55), Some(Coarse::Medium), Charging::Yes));
        assert_eq!(kind_of(&l[1].kind_word, ""), Kind::Mouse);
        assert_eq!(kind_of("gaming-input", ""), Kind::Controller);
    }

    #[test]
    fn hostile_text() {
        assert!(parse("").is_empty());
        assert!(parse("garbage\n:::\nDevice:\n  native-path: /org/bluez/hci0/dev_AA\n").is_empty());
        assert_eq!(percent_of("-3%"), None);
        assert_eq!(percent_of("nan%"), None);
        assert_eq!(bluez_addr("/org/bluez/hci0/dev_aa_bb_cc_dd_ee_ff").as_deref(), Some("AA:BB:CC:DD:EE:FF"));
        assert_eq!(bluez_addr("/org/bluez/hci0/dev_aa_bb_cc_dd_ee_ff_00"), None);
        assert_eq!(bluez_addr("/sys/x/dev_aa_bb_cc_dd_ee_ff"), None);
        let many: String = (0..200).map(|i| format!("Device: x\n  native-path: /org/bluez/hci0/dev_AA_BB_CC_DD_EE_{:02X}\n", i % 256)).collect();
        assert_eq!(parse(&many).len(), 64);
    }
}
