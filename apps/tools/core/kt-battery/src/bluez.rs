// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery), piece P1: what `bluetoothctl` says on Linux — the radio, the paired
// devices, one device's details (its battery among them), a scan's new devices, how a connect or disconnect ended.
// Written for Tools (the original has no connecting). The program is called with fixed arguments only (linux/bt.rs);
// an address goes in only as «AA:BB:CC:DD:EE:FF» made from a parsed number, never as text from elsewhere. Pairing is
// never done here: the system's own Bluetooth settings do it (no PIN of ours). Parsed defensively: colour codes and
// prompts stripped, unknown lines skipped, every list bounded.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::connect::{self, Addr, Classic, End, Radio, Svc};

/// The fixed places bluetoothctl may be.
pub const BLUETOOTHCTL: &[&str] = &["/usr/bin/bluetoothctl", "/bin/bluetoothctl"];

/// The argument an address is given as: only ever made from a number.
pub fn addr_arg(a: Addr) -> Option<String> {
    if a == 0 || a >> 48 != 0 {
        return None;
    }
    Some(connect::addr_text(a))
}

/// Text without terminal colour codes and bluetoothctl's prompts.
pub fn clean(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut it = text.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\u{1b}' {
            // (ESC [ … letter)
            if it.peek() == Some(&'[') {
                it.next();
                while let Some(&n) = it.peek() {
                    it.next();
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        if c == '\u{1}' || c == '\u{2}' || c == '\r' {
            continue;
        }
        out.push(c);
    }
    out.lines().map(|l| match l.find("]# ") {
        Some(i) if l.starts_with('[') => &l[i + 3..],
        _ => l,
    }).collect::<Vec<_>>().join("\n")
}

/// `bluetoothctl show`: the default controller's state.
pub fn radio(text: &str) -> Radio {
    let t = clean(text);
    if !t.lines().any(|l| l.starts_with("Controller ")) {
        return Radio::Missing;
    }
    match t.lines().map(str::trim).find_map(|l| l.strip_prefix("Powered:")).map(str::trim) {
        Some("yes") => Radio::On,
        _ => Radio::Off,
    }
}

/// `bluetoothctl devices Paired` (or `paired-devices`): «Device AA:BB:CC:DD:EE:FF Name» lines → (address, name).
pub fn device_lines(text: &str) -> Vec<(Addr, String)> {
    let mut out: Vec<(Addr, String)> = Vec::new();
    for l in clean(text).lines() {
        let l = l.trim();
        let rest = match l.strip_prefix("[NEW] Device ").or_else(|| l.strip_prefix("Device ")) {
            Some(r) => r,
            None => continue,
        };
        let (a, name) = rest.split_once(' ').unwrap_or((rest, ""));
        if a.len() != 17 || a.chars().filter(|c| *c == ':').count() != 5 {
            continue;
        }
        let Some(addr) = connect::parse_addr(a) else { continue };
        // (A device with no name is listed with its address in dashes.)
        let name = name.trim();
        let name = if connect::parse_addr(name) == Some(addr) { "" } else { name };
        if !out.iter().any(|(x, _)| *x == addr) && out.len() < 64 {
            out.push((addr, name.chars().filter(|c| !c.is_control()).take(128).collect()));
        }
    }
    out
}

/// One device's details (`bluetoothctl info <addr>`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Info {
    pub classic: Classic,
    pub icon: String,
    pub battery: Option<u8>,
    pub bonded: bool,
}

/// «UUID: Audio Sink (0000110b-0000-1000-8000-00805f9b34fb)» → 0x110B.
fn uuid16(line: &str) -> Option<u16> {
    let open = line.rfind('(')?;
    let u = line[open + 1..].trim_end_matches(')').trim().to_ascii_lowercase();
    if u.len() != 36 || !u.ends_with("-0000-1000-8000-00805f9b34fb") || !u.starts_with("0000") {
        return None;
    }
    u16::from_str_radix(&u[4..8], 16).ok()
}

pub fn info(addr: Addr, text: &str) -> Option<Info> {
    let t = clean(text);
    let first = t.lines().map(str::trim).find(|l| l.starts_with("Device "))?;
    if connect::parse_addr(first.split_whitespace().nth(1)?) != Some(addr) {
        return None;
    }
    let mut i = Info { classic: Classic { addr, ..Default::default() }, ..Default::default() };
    let mut alias = String::new();
    for l in t.lines().map(str::trim).take(400) {
        let Some((k, v)) = l.split_once(':') else { continue };
        let v = v.trim();
        let yes = v == "yes";
        match k.trim() {
            "Name" => i.classic.name = v.chars().filter(|c| !c.is_control()).take(128).collect(),
            "Alias" => alias = v.chars().filter(|c| !c.is_control()).take(128).collect(),
            "Class" => i.classic.cod = u32::from_str_radix(v.trim_start_matches("0x"), 16).unwrap_or(0) & 0x00FF_FFFF,
            "Icon" => i.icon = v.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(40).collect(),
            "Paired" => i.classic.authenticated = yes,
            "Bonded" => i.bonded = yes,
            "Trusted" => i.classic.remembered = yes,
            "Connected" => i.classic.connected = yes,
            "UUID" => {
                if let Some(s) = uuid16(v).and_then(connect::svc_of_uuid16).or_else(|| (uuid16(v) == Some(0x1812)).then_some(Svc::Hid)) {
                    if !i.classic.services.contains(&s) {
                        i.classic.services.push(s);
                    }
                }
            }
            // («Battery Percentage: 0x46 (70)»)
            "Battery Percentage" => {
                i.battery = v.rsplit_once('(').and_then(|(_, n)| n.trim_end_matches(')').trim().parse::<u8>().ok()).filter(|p| *p <= 100);
            }
            _ => {}
        }
    }
    if i.classic.name.is_empty() && connect::parse_addr(&alias).is_none() {
        i.classic.name = alias;
    }
    i.classic.services.sort();
    Some(i)
}

/// UPower's / bluetoothctl's icon name → a kind word for kind.rs.
pub fn kind_of_icon(icon: &str) -> Option<crate::model::Kind> {
    use crate::model::Kind;
    Some(match icon {
        "input-mouse" | "input-tablet" => Kind::Mouse,
        "input-keyboard" => Kind::Keyboard,
        "input-gaming" => Kind::Controller,
        "audio-headset" | "audio-headphones" => Kind::Headset,
        "audio-card" | "audio-speakers" => Kind::Speaker,
        "phone" => Kind::Phone,
        _ => return None,
    })
}

/// How `bluetoothctl connect` / `disconnect` ended, from its words (it exits 0 either way on some versions).
pub fn end_of(text: &str, connect: bool) -> End {
    let t = clean(text);
    if connect && t.contains("Connection successful") || !connect && (t.contains("Successful disconnected") || t.contains("Successfully disconnected")) {
        return End::Done;
    }
    if t.contains("not available") || t.contains("Host is down") || t.contains("page-timeout") || t.contains("br-connection-page-timeout") {
        return End::Unreachable;
    }
    if t.contains("No default controller") {
        return End::NoRadio;
    }
    if t.contains("NotReady") || t.contains("Not Ready") {
        return End::NoRadio;
    }
    if t.contains("AuthenticationFailed") || t.contains("Not Authorized") || t.contains("NotPermitted") {
        return End::Refused;
    }
    if t.contains("InProgress") || t.contains("In Progress") || t.contains("Busy") {
        return End::Busy;
    }
    if t.contains("Failed to") {
        return End::Unreachable;
    }
    End::Failed(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn radio_and_lists() {
        assert_eq!(radio("No default controller available\n"), Radio::Missing);
        assert_eq!(radio("Controller 00:11:22:33:44:55 (public)\n\tName: box\n\tPowered: yes\n"), Radio::On);
        assert_eq!(radio("Controller 00:11:22:33:44:55 (public)\n\tPowered: no\n"), Radio::Off);
        let l = device_lines("Device AA:BB:CC:DD:EE:01 Test Headset\n\u{1b}[0;94m[bluetooth]\u{1b}[0m# Device AA:BB:CC:DD:EE:02 AA-BB-CC-DD-EE-02\nDevice nonsense\nDevice AA:BB:CC:DD:EE:01 again\n");
        assert_eq!(l, vec![(0xAABBCCDDEE01, "Test Headset".to_string()), (0xAABBCCDDEE02, String::new())]);
        let scan = device_lines("Discovery started\n[CHG] Controller 00:11:22:33:44:55 Discovering: yes\n[NEW] Device 10:20:30:40:50:60 Test Pad\n[CHG] Device 10:20:30:40:50:60 RSSI: -60\n");
        assert_eq!(scan, vec![(0x102030405060, "Test Pad".to_string())]);
    }

    #[test]
    fn info_of_one_device() {
        let t = "Device AA:BB:CC:DD:EE:01 (public)\n\tName: Test Headset\n\tAlias: Test Headset\n\tClass: 0x00240404\n\tIcon: audio-headset\n\tPaired: yes\n\tBonded: yes\n\tTrusted: yes\n\tBlocked: no\n\tConnected: yes\n\tUUID: Audio Sink                (0000110b-0000-1000-8000-00805f9b34fb)\n\tUUID: Handsfree                 (0000111e-0000-1000-8000-00805f9b34fb)\n\tUUID: Vendor specific           (12345678-1234-1234-1234-123456789abc)\n\tBattery Percentage: 0x46 (70)\n";
        let i = info(0xAABBCCDDEE01, t).unwrap();
        assert_eq!(i.classic.name, "Test Headset");
        assert_eq!(i.classic.cod, 0x240404);
        assert!(i.classic.connected && i.classic.paired() && i.bonded);
        assert_eq!(i.classic.services, vec![Svc::Audio]);
        assert_eq!(i.battery, Some(70));
        assert_eq!(i.icon, "audio-headset");
        assert_eq!(connect::can_of(&i.classic), connect::Can::Both);
        assert!(info(0xAABBCCDDEE02, t).is_none(), "another device's answer");
        assert!(!info(1, "Device 00:00:00:00:00:01 not available\n").unwrap().classic.paired());
        let hog = info(0x102030405060, "Device 10:20:30:40:50:60 (random)\n\tAlias: Test Mouse\n\tPaired: yes\n\tUUID: Human Interface Device (00001812-0000-1000-8000-00805f9b34fb)\n\tBattery Percentage: 0xff (255)\n").unwrap();
        assert_eq!((hog.classic.name.as_str(), hog.battery), ("Test Mouse", None));
        assert_eq!(hog.classic.services, vec![Svc::Hid]);
    }

    #[test]
    fn ends_and_addresses() {
        assert_eq!(end_of("Attempting to connect to AA:BB:CC:DD:EE:01\n[CHG] Device AA:BB:CC:DD:EE:01 Connected: yes\nConnection successful\n", true), End::Done);
        assert_eq!(end_of("Attempting to disconnect from AA:BB:CC:DD:EE:01\nSuccessful disconnected\n", false), End::Done);
        assert_eq!(end_of("Device AA:BB:CC:DD:EE:01 not available\n", true), End::Unreachable);
        assert_eq!(end_of("Failed to connect: org.bluez.Error.Failed br-connection-page-timeout\n", true), End::Unreachable);
        assert_eq!(end_of("Failed to connect: org.bluez.Error.InProgress\n", true), End::Busy);
        assert_eq!(end_of("", true), End::Failed(0));
        assert_eq!(addr_arg(0xAABBCCDDEE01).as_deref(), Some("AA:BB:CC:DD:EE:01"));
        assert_eq!(addr_arg(0), None);
        assert_eq!(addr_arg(1 << 48), None, "never over 48 bits");
        assert_eq!(clean("\u{1b}[0;94m[bluetooth]\u{1b}[0m# Device X"), "Device X");
    }
}
