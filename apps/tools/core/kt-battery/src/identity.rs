// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): one entry per physical unit.
// Derived from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/generic.cpp (PollGenericHid's and PollBluetooth's duplicate checks: btContainers, ContainerOf, the name
// check) and src/drivers/xinput.cpp (PollXInput's «already shown precisely» rule) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later.
// Changed here: keys are per unit — the serial number when the device has one, else Windows' container id, else its
// interface path — not «hid:VID:PID» (two identical mice were one entry, a re-plugged one a new one); entries are merged
// only by explicit rules, never by name: (1) the same container id, (2) the same vendor, product and non-empty serial,
// (3) XInput's pads give way to Windows.Gaming.Input's or to an Xbox pad on Bluetooth when there is any (XInput cannot
// tell which pad is which; the original's rule), (4) Windows.Gaming.Input's copy of a pad Windows also lists on Bluetooth with Microsoft's vendor
// id gives way to the Bluetooth one (the original matched «Xbox» in the name), (5) two keys the user joined himself.
// The winner is the reader that ranks higher (model.rs Source::rank); the loser's key is kept in `merged`.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::model::{Device, Kind, Reading, Source};

fn hex4(v: u16) -> String {
    format!("{:04X}", v)
}

/// A short stable digest of a text (FNV-1a, 64 bits) for keys made from paths.
pub fn digest(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.to_ascii_lowercase().bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01B3);
    }
    format!("{:016x}", h)
}

/// A HID device's key: «hid:VID:PID:s:<serial>», else «hid:VID:PID:c:<container>», else «hid:VID:PID:p:<digest of
/// the interface path>» (its collection number cut off, so a device's collections share one key).
pub fn hid_key(vid: u16, pid: u16, serial: &str, container: &str, path: &str) -> String {
    let base = format!("hid:{}:{}", hex4(vid), hex4(pid));
    let serial = serial.trim();
    if !serial.is_empty() && serial.chars().all(|c| !c.is_control()) {
        return format!("{}:s:{}", base, serial);
    }
    let container = container.trim();
    if !container.is_empty() && container != "{00000000-0000-0000-0000-000000000000}" {
        return format!("{}:c:{}", base, container.to_ascii_uppercase());
    }
    // (\\?\hid#vid_046d&pid_c547&mi_02&col01#…: «&col01» names the collection, not the device.)
    let lower = path.to_ascii_lowercase();
    let unit = match lower.find("&col") {
        Some(i) => {
            let rest = &lower[i + 4..];
            let skip = rest.chars().take_while(|c| c.is_ascii_hexdigit()).count();
            format!("{}{}", &lower[..i], &rest[skip..])
        }
        None => lower,
    };
    format!("{}:p:{}", base, digest(&unit))
}

/// A controller's key: its unit's key, and for a receiver with several pad slots (pads::Model::per_interface) the
/// slot's interface path too.
pub fn pad_key(vid: u16, pid: u16, serial: &str, container: &str, path: &str, per_interface: bool) -> String {
    let unit = hid_key(vid, pid, serial, container, path);
    if per_interface {
        let lower = path.to_ascii_lowercase();
        let iface = lower.find("&mi_").map(|i| lower[i + 4..].chars().take(2).collect::<String>()).unwrap_or_else(|| digest(&lower)[..8].to_string());
        format!("{}:i:{}", unit, iface)
    } else {
        unit
    }
}

/// The generic reader's entries without the units a controller reader claims (their keys `pad_keys`).
pub fn drop_claimed(generic: Vec<Candidate>, pad_keys: &[String]) -> Vec<Candidate> {
    generic.into_iter().filter(|c| !pad_keys.iter().any(|k| k == &c.device.key || k.starts_with(&format!("{}:i:", c.device.key)))).collect()
}

pub fn bt_key(container: &str) -> String {
    format!("bt:{}", container.to_ascii_uppercase())
}

pub fn wgi_key(non_roamable_id: &str, vid: u16, pid: u16) -> String {
    format!("xbox:{}:{}:{}", hex4(vid), hex4(pid), digest(non_roamable_id))
}

/// XInput has no identity but its slot: the key says so.
pub fn xinput_key(user: u8, headset: bool) -> String {
    format!("xinput:{}:{}", user, if headset { "headset" } else { "pad" })
}

/// A device found in this round, with the reading its reader brought along (Bluetooth, Xbox) or none yet (HID).
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub device: Device,
    pub reading: Option<Reading>,
    /// Not connected now (Bluetooth: paired, off or away).
    pub offline: bool,
}

fn absorb(win: &mut Candidate, lose: Candidate) {
    win.device.merged.push(lose.device.key.clone());
    for k in lose.device.merged {
        if !win.device.merged.contains(&k) {
            win.device.merged.push(k);
        }
    }
    if win.device.vid == 0 {
        win.device.vid = lose.device.vid;
        win.device.pid = lose.device.pid;
    }
    if win.device.serial.is_empty() {
        win.device.serial = lose.device.serial;
    }
    if win.device.brand.is_empty() {
        win.device.brand = lose.device.brand;
    }
    if win.device.kind == Kind::Other {
        win.device.kind = lose.device.kind;
    }
    if win.reading.is_none() && !win.offline {
        win.reading = lose.reading;
    }
}

fn same_unit(a: &Device, b: &Device, links: &[(String, String)]) -> bool {
    if !a.container.is_empty() && a.container.eq_ignore_ascii_case(&b.container) {
        return true;
    }
    if !a.serial.is_empty() && a.vid == b.vid && a.pid == b.pid && a.serial == b.serial {
        return true;
    }
    if a.source == Source::Pad && b.source == Source::Pad && !a.serial.is_empty() && a.serial == b.serial && a.vid == b.vid {
        let g = crate::pads::group_of(a.vid, a.pid);
        if !g.is_empty() && g == crate::pads::group_of(b.vid, b.pid) {
            return true;
        }
    }
    let keys = |d: &Device| std::iter::once(d.key.clone()).chain(d.merged.iter().cloned()).collect::<Vec<_>>();
    let (ka, kb) = (keys(a), keys(b));
    links.iter().any(|(x, y)| (ka.contains(x) && kb.contains(y)) || (ka.contains(y) && kb.contains(x)))
}

/// The round's entries made one per unit, by the rules above. `links`: the user's own joins (key, key).
pub fn merge(cands: Vec<Candidate>, links: &[(String, String)]) -> Vec<Candidate> {
    // (Rule 3 and 4 first: they drop whole groups.)
    let wgi_pads = cands.iter().filter(|c| c.device.source == Source::XboxWgi).count();
    let bt_xbox = cands.iter().any(|c| c.device.source == Source::Bluetooth && c.device.vid == 0x045E && c.device.kind == Kind::Controller);
    let mut out: Vec<Candidate> = Vec::new();
    for c in cands {
        if c.device.source == Source::XInput && c.device.kind == Kind::Controller && (wgi_pads > 0 || bt_xbox) {
            continue;
        }
        if c.device.source == Source::XboxWgi && bt_xbox {
            continue;
        }
        match out.iter().position(|o| same_unit(&o.device, &c.device, links)) {
            Some(i) => {
                if c.device.source.rank() > out[i].device.source.rank() {
                    let old = std::mem::replace(&mut out[i], c);
                    absorb(&mut out[i], old);
                } else {
                    absorb(&mut out[i], c);
                }
            }
            None => out.push(c),
        }
    }
    // (Same key from two collections of one device without serial or container: one entry.)
    let mut uniq: Vec<Candidate> = Vec::new();
    for c in out {
        if let Some(u) = uniq.iter_mut().find(|u| u.device.key == c.device.key) {
            if u.reading.is_none() {
                u.reading = c.reading;
            }
        } else {
            uniq.push(c);
        }
    }
    uniq
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Charging, Level, Percent};

    fn dev(key: &str, src: Source, kind: Kind, vid: u16, container: &str, serial: &str) -> Candidate {
        let mut d = Device::new(key.into(), src);
        d.kind = kind;
        d.vid = vid;
        d.pid = 0x0001;
        d.container = container.into();
        d.serial = serial.into();
        Candidate { device: d, reading: None, offline: false }
    }

    #[test]
    fn keys() {
        assert_eq!(hid_key(0x046D, 0xC547, "ABC123", "{X}", "p"), "hid:046D:C547:s:ABC123");
        assert_eq!(hid_key(0x046D, 0xC547, "", "{ab}", "p"), "hid:046D:C547:c:{AB}");
        assert!(hid_key(0x046D, 0xC547, "", "{00000000-0000-0000-0000-000000000000}", "p").contains(":p:"), "the empty container id is no id");
        let a = hid_key(1, 2, "", "", "\\\\?\\hid#vid_0001&pid_0002&mi_02&col01#8&1&0&0000#{4d1e55b2}");
        let b = hid_key(1, 2, "", "", "\\\\?\\HID#VID_0001&PID_0002&MI_02&Col03#8&1&0&0000#{4d1e55b2}");
        let c = hid_key(1, 2, "", "", "\\\\?\\hid#vid_0001&pid_0002&mi_02&col01#8&9&0&0000#{4d1e55b2}");
        assert_eq!(a, b, "a device's collections share its key");
        assert_ne!(a, c, "another unit of the same product does not");
        assert_eq!(bt_key("{ab}"), "bt:{AB}");
        assert_ne!(wgi_key("a", 1, 2), wgi_key("b", 1, 2));
        assert_eq!(xinput_key(2, true), "xinput:2:headset");
        assert_eq!(digest("ABC"), digest("abc"));
    }

    #[test]
    fn same_container_merges_with_the_bluetooth_level_winning() {
        let mut hid = dev("hid:1", Source::HidGeneric, Kind::Mouse, 0x1111, "{C1}", "");
        hid.reading = Some(Reading::new(Level::Exact(Percent::new(0).unwrap()), Charging::Unknown, 5));
        let mut bt = dev("bt:{C1}", Source::Bluetooth, Kind::Other, 0, "{c1}", "");
        bt.reading = Some(Reading::new(Level::Exact(Percent::new(64).unwrap()), Charging::Unknown, 5));
        let got = merge(vec![hid, bt], &[]);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].device.key, "bt:{C1}");
        assert_eq!(got[0].device.merged, vec!["hid:1".to_string()]);
        assert_eq!(got[0].device.kind, Kind::Mouse, "the kind the HID collections told");
        assert_eq!(got[0].device.vid, 0x1111);
        assert_eq!(got[0].reading.unwrap().level, Level::Exact(Percent::new(64).unwrap()));
    }

    #[test]
    fn two_identical_pads_stay_two_and_names_never_merge() {
        let mut a = dev("bt:{A}", Source::Bluetooth, Kind::Controller, 0x054C, "{A}", "");
        a.device.name = "Wireless Controller".into();
        let mut b = dev("bt:{B}", Source::Bluetooth, Kind::Controller, 0x054C, "{B}", "");
        b.device.name = "Wireless Controller".into();
        let got = merge(vec![a, b], &[]);
        assert_eq!(got.len(), 2);
    }

    #[test]
    fn dongle_and_bluetooth_by_serial_or_by_the_users_link() {
        let dongle = dev("hid:dongle", Source::HidGeneric, Kind::Mouse, 0x1111, "{D}", "SN9");
        let bt = dev("bt:{E}", Source::Bluetooth, Kind::Mouse, 0x1111, "{E}", "SN9");
        assert_eq!(merge(vec![dongle.clone(), bt.clone()], &[]).len(), 1, "same vendor, product and serial");
        let mut bt2 = bt.clone();
        bt2.device.serial.clear();
        assert_eq!(merge(vec![dongle.clone(), bt2.clone()], &[]).len(), 2, "no rule: two entries");
        let got = merge(vec![dongle, bt2], &[("bt:{E}".into(), "hid:dongle".into())]);
        assert_eq!(got.len(), 1, "the user joined them");
        assert_eq!(got[0].device.key, "bt:{E}");
    }

    fn pad(key: &str, vid: u16, pid: u16, container: &str, serial: &str) -> Candidate {
        let mut c = dev(key, Source::Pad, Kind::Controller, vid, container, serial);
        c.device.pid = pid;
        c.device.driver = "x";
        c
    }

    #[test]
    fn controllers() {
        // (A pad over Bluetooth: its reader's entry and Windows' Bluetooth entry, one container → one card, the
        //  reader's.)
        let p = pad("hid:054C:0CE6:c:{P}", 0x054C, 0x0CE6, "{P}", "");
        let mut b = dev("bt:{P}", Source::Bluetooth, Kind::Controller, 0, "{P}", "");
        b.reading = Some(Reading::new(Level::Exact(Percent::new(80).unwrap()), Charging::Unknown, 1));
        let got = merge(vec![b, p], &[]);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].device.key, "hid:054C:0CE6:c:{P}");
        assert_eq!(got[0].device.driver, "x");
        assert_eq!(got[0].device.merged, vec!["bt:{P}".to_string()]);
        // (Two identical pads: two cards.)
        let a = pad("hid:054C:0CE6:c:{A}", 0x054C, 0x0CE6, "{A}", "");
        let c = pad("hid:054C:0CE6:c:{C}", 0x054C, 0x0CE6, "{C}", "");
        assert_eq!(merge(vec![a, c], &[]).len(), 2);
        // (The Ultimate 2 by its cable (6012) and its receiver (310B), the same serial → one; another serial → two.)
        let cable = pad("hid:2DC8:6012:s:U1", 0x2DC8, 0x6012, "{X}", "U1");
        let rx = pad("hid:2DC8:310B:s:U1", 0x2DC8, 0x310B, "{Y}", "U1");
        assert_eq!(merge(vec![cable.clone(), rx.clone()], &[]).len(), 1);
        let mut rx2 = rx.clone();
        rx2.device.serial = "U2".into();
        assert_eq!(merge(vec![cable.clone(), rx2], &[]).len(), 2);
        // (Same serial, products of no one group: two.)
        let pro2 = pad("hid:2DC8:6003:s:U1", 0x2DC8, 0x6003, "{Z}", "U1");
        assert_eq!(merge(vec![cable, pro2], &[]).len(), 2);
        // (A unit a controller reader claims: the generic reader's entry for it dropped; a receiver's slots too.)
        let g1 = dev("hid:054C:0CE6:c:{P}", Source::HidGeneric, Kind::Controller, 0x054C, "{P}", "");
        let g2 = dev("hid:28DE:1142:c:{S}", Source::HidGeneric, Kind::Controller, 0x28DE, "{S}", "");
        let g3 = dev("hid:1111:2222:s:M", Source::HidGeneric, Kind::Mouse, 0x1111, "", "M");
        let kept = drop_claimed(vec![g1, g2, g3], &["hid:054C:0CE6:c:{P}".into(), "hid:28DE:1142:c:{S}:i:01".into()]);
        assert_eq!(kept.iter().map(|c| c.device.key.as_str()).collect::<Vec<_>>(), vec!["hid:1111:2222:s:M"]);
        // (XInput's pad is never joined to a controller of ours by guess.)
        let xi = dev("xinput:0:pad", Source::XInput, Kind::Controller, 0, "", "");
        let nova = pad("hid:3537:1098:c:{N}", 0x3537, 0x1098, "{N}", "");
        assert_eq!(merge(vec![xi, nova], &[]).len(), 2);
    }

    #[test]
    fn pad_keys() {
        let p1 = r"\\?\hid#vid_28de&pid_1142&mi_01#7&1&0&0000#{4d1e55b2}";
        let p2 = r"\\?\hid#vid_28de&pid_1142&mi_02#7&1&0&0001#{4d1e55b2}";
        assert_ne!(pad_key(0x28DE, 0x1142, "", "{R}", p1, true), pad_key(0x28DE, 0x1142, "", "{R}", p2, true), "a receiver's slots are two pads");
        assert_eq!(pad_key(0x28DE, 0x1142, "", "{R}", p1, true), "hid:28DE:1142:c:{R}:i:01");
        assert_eq!(pad_key(0x054C, 0x0CE6, "", "{R}", p1, false), hid_key(0x054C, 0x0CE6, "", "{R}", p1));
    }

    #[test]
    fn xbox_rules() {
        let wgi = dev("xbox:1", Source::XboxWgi, Kind::Controller, 0x045E, "", "");
        let xi = dev("xinput:0:pad", Source::XInput, Kind::Controller, 0, "", "");
        let xh = dev("xinput:0:headset", Source::XInput, Kind::Headset, 0, "", "");
        let got = merge(vec![wgi.clone(), xi.clone(), xh.clone()], &[]);
        let keys: Vec<_> = got.iter().map(|c| c.device.key.as_str()).collect();
        assert_eq!(keys, vec!["xbox:1", "xinput:0:headset"], "XInput's pads give way to the precise ones; its headsets stay");
        let bt = dev("bt:{X}", Source::Bluetooth, Kind::Controller, 0x045E, "{X}", "");
        let got = merge(vec![wgi, bt, xi], &[]);
        let keys: Vec<_> = got.iter().map(|c| c.device.key.as_str()).collect();
        assert_eq!(keys, vec!["bt:{X}"], "WGI's copy and XInput's give way to the Bluetooth one");
        let bt = dev("bt:{X}", Source::Bluetooth, Kind::Controller, 0x045E, "{X}", "");
        let xi = dev("xinput:0:pad", Source::XInput, Kind::Controller, 0, "", "");
        assert_eq!(merge(vec![bt, xi], &[]).len(), 1, "without WGI too");
    }
}
