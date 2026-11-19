// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Xbox controllers through Windows.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/xinput.cpp (WgiVendor, PollWgi's report handling, PollXInput's rules) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later.
// 1. Windows.Gaming.Input: every Xbox controller Windows knows (adapter, USB, Bluetooth) with a real battery report
//    (remaining / full mWh). 2. XInput: four coarse levels, also for headsets plugged into a controller.
// Changed here: XInput's levels stay coarse (the original turned Empty/Low/Medium/Full into 5/25/60/100 %); an unknown
// level value is Unknown (the original called it Full); a battery report with a negative or larger-than-full remaining
// capacity is clamped, with a full capacity of 0 or less it is no reading; a controller's key is Windows' non-roamable
// id, not its place in the list (the original's «xbox:pid:index» changed when another pad came or went).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::model::{Charging, Coarse, Percent};

/// Vendors whose pads report a real battery through Windows.Gaming.Input: Microsoft, and GameSir in Xbox (GIP) mode.
pub fn wgi_vendor(vid: u16) -> bool {
    vid == 0x045E || vid == 0x3537
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WgiStatus {
    NotPresent,
    Discharging,
    Idle,
    Charging,
}

/// One controller as Windows.Gaming.Input described it.
#[derive(Clone, Debug, PartialEq)]
pub struct WgiPad {
    pub vid: u16,
    pub pid: u16,
    /// Windows' NonRoamableId: stable for this controller on this computer.
    pub id: String,
    pub name: String,
    pub remaining_mwh: Option<i32>,
    pub full_mwh: Option<i32>,
    pub status: WgiStatus,
}

/// The pad's level and charging, or None when the report says nothing usable.
pub fn wgi_reading(p: &WgiPad) -> Option<(Percent, Charging)> {
    if !wgi_vendor(p.vid) || p.status == WgiStatus::NotPresent {
        return None;
    }
    let full = p.full_mwh? as i64;
    let rem = p.remaining_mwh? as i64;
    if full <= 0 {
        return None;
    }
    let pct = (rem.clamp(0, full) * 100 + full / 2) / full;
    let ch = match p.status {
        WgiStatus::Charging => Charging::Yes,
        WgiStatus::Discharging | WgiStatus::Idle => Charging::No,
        WgiStatus::NotPresent => Charging::Unknown,
    };
    Some((Percent::new(pct)?, ch))
}

/// The name shown: Windows' own, else a plain one; GIP calls third-party pads «Xbox One Game Controller».
pub fn wgi_name(p: &WgiPad) -> String {
    if p.vid == 0x3537 {
        return "GameSir controller".into();
    }
    if p.name.trim().is_empty() {
        "Xbox controller".into()
    } else {
        p.name.trim().to_string()
    }
}

// XInput's values (xinput.h).
pub const BATTERY_TYPE_DISCONNECTED: u8 = 0x00;
pub const BATTERY_TYPE_WIRED: u8 = 0x01;
pub const BATTERY_TYPE_UNKNOWN: u8 = 0xFF;

/// XInput's level, coarse: BATTERY_LEVEL_EMPTY 0, LOW 1, MEDIUM 2, FULL 3; anything else unknown.
pub fn xinput_level(v: u8) -> Option<Coarse> {
    match v {
        0 => Some(Coarse::Empty),
        1 => Some(Coarse::Low),
        2 => Some(Coarse::Medium),
        3 => Some(Coarse::Full),
        _ => None,
    }
}

/// One of XInput's four slots: whether a controller is there (XInputGetState answered), and what
/// XInputGetBatteryInformation said for the pad and for a headset, as (type, level).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct XSlot {
    pub user: u8,
    pub present: bool,
    pub pad: Option<(u8, u8)>,
    pub headset: Option<(u8, u8)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct XFound {
    pub user: u8,
    pub headset: bool,
    pub level: Option<Coarse>,
}

fn battery_ok(t: u8) -> bool {
    t != BATTERY_TYPE_DISCONNECTED && t != BATTERY_TYPE_WIRED
}

/// What XInput adds. `precise`: pads already listed with a real percentage (Windows.Gaming.Input); `third_party`: how
/// many of those are not Microsoft's; `bt_xbox`: an Xbox pad already listed from Windows' Bluetooth level.
pub fn xinput_found(slots: &[XSlot], precise: usize, third_party: usize, bt_xbox: bool) -> Vec<XFound> {
    // (GameSir pads answer the headset query with their own battery even with nothing plugged in.)
    let skip_headset = precise > 0 && third_party == precise;
    let mut out = Vec::new();
    for s in slots {
        // (The Xbox Wireless adapter answers for empty slots too: one pad showed as four headsets.)
        if !s.present {
            continue;
        }
        let pad = s.pad.filter(|&(t, _)| battery_ok(t));
        if let Some((_, lv)) = pad {
            if !(bt_xbox || precise > 0) {
                out.push(XFound { user: s.user, headset: false, level: xinput_level(lv) });
            }
        }
        if skip_headset {
            continue;
        }
        if let Some((t, lv)) = s.headset {
            if !battery_ok(t) || t == BATTERY_TYPE_UNKNOWN {
                continue;
            }
            // (Xbox One / Series pads echo their own battery for the headset query: a mirrored answer is no headset.)
            if pad == Some((t, lv)) {
                continue;
            }
            out.push(XFound { user: s.user, headset: true, level: xinput_level(lv) });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pad(vid: u16, rem: Option<i32>, full: Option<i32>, st: WgiStatus) -> WgiPad {
        WgiPad { vid, pid: 0x0B13, id: "{x}".into(), name: "Xbox Wireless Controller".into(), remaining_mwh: rem, full_mwh: full, status: st }
    }

    #[test]
    fn wgi_reports() {
        assert_eq!(wgi_reading(&pad(0x045E, Some(1500), Some(3000), WgiStatus::Discharging)), Some((Percent::new(50).unwrap(), Charging::No)));
        assert_eq!(wgi_reading(&pad(0x045E, Some(3000), Some(3000), WgiStatus::Charging)).map(|x| x.1), Some(Charging::Yes));
        assert_eq!(wgi_reading(&pad(0x045E, Some(5000), Some(3000), WgiStatus::Idle)).map(|x| x.0.get()), Some(100), "clamped");
        assert_eq!(wgi_reading(&pad(0x045E, Some(-5), Some(3000), WgiStatus::Idle)).map(|x| x.0.get()), Some(0));
        assert_eq!(wgi_reading(&pad(0x045E, Some(10), Some(0), WgiStatus::Idle)), None);
        assert_eq!(wgi_reading(&pad(0x045E, None, Some(3000), WgiStatus::Idle)), None);
        assert_eq!(wgi_reading(&pad(0x045E, Some(10), Some(30), WgiStatus::NotPresent)), None, "a wired pad without a battery");
        assert_eq!(wgi_reading(&pad(0x054C, Some(10), Some(30), WgiStatus::Idle)), None, "other vendors' WGI reports are not trusted");
        assert_eq!(wgi_reading(&pad(0x045E, Some(i32::MAX), Some(i32::MAX), WgiStatus::Idle)).map(|x| x.0.get()), Some(100), "no overflow");
        assert_eq!(wgi_name(&pad(0x3537, None, None, WgiStatus::Idle)), "GameSir controller");
        assert_eq!(wgi_name(&WgiPad { name: "  ".into(), ..pad(0x045E, None, None, WgiStatus::Idle) }), "Xbox controller");
    }

    #[test]
    fn xinput_levels_are_coarse() {
        assert_eq!(xinput_level(0), Some(Coarse::Empty));
        assert_eq!(xinput_level(3), Some(Coarse::Full));
        assert_eq!(xinput_level(9), None, "unknown, not «full»");
    }

    #[test]
    fn xinput_rules() {
        let s = |user, present, pad, headset| XSlot { user, present, pad, headset };
        // (Empty slots skipped; wired pads and disconnected batteries are not batteries.)
        let got = xinput_found(&[s(0, true, Some((2, 2)), None), s(1, false, Some((2, 1)), Some((2, 1))), s(2, true, Some((1, 3)), None)], 0, 0, false);
        assert_eq!(got, vec![XFound { user: 0, headset: false, level: Some(Coarse::Medium) }]);
        // (A headset echoing the pad is no headset; a real one is listed.)
        let got = xinput_found(&[s(0, true, Some((2, 2)), Some((2, 2))), s(1, true, Some((3, 3)), Some((2, 1)))], 0, 0, false);
        assert_eq!(got.iter().filter(|f| f.headset).count(), 1);
        assert_eq!(got.len(), 3);
        // (Pads shown precisely or from Bluetooth: XInput adds no pad; headsets still.)
        let got = xinput_found(&[s(0, true, Some((2, 2)), Some((2, 0)))], 1, 0, false);
        assert_eq!(got, vec![XFound { user: 0, headset: true, level: Some(Coarse::Empty) }]);
        assert!(xinput_found(&[s(0, true, Some((2, 2)), None)], 0, 0, true).is_empty());
        // (Every precise pad a third party's: headsets skipped — GameSir answers for itself.)
        assert!(xinput_found(&[s(0, true, Some((2, 2)), Some((2, 0)))], 1, 1, false).is_empty());
        // (A headset of unknown type is nothing.)
        assert!(xinput_found(&[s(0, true, None, Some((BATTERY_TYPE_UNKNOWN, 1)))], 0, 0, false).is_empty());
    }
}
