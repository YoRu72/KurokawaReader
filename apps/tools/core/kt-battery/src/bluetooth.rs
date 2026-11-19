// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Windows' Bluetooth battery level.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/generic.cpp (PollBluetooth, StripServiceSuffix) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by
// krisgfx9 and its contributors, GPL-3.0-or-later.
// Windows keeps the level it reads over HFP (classic) or the GATT Battery Service (LE) in a device property, the value
// Settings › Bluetooth & devices shows; the platform part (win/bt.rs) reads the device nodes' properties, this decides.
// Changed here: a device that is not connected is still listed, as «not connected», with no level (the original hid it,
// and Windows' stored value for it is an old one: we never show it as current); a node with a problem or a value over
// 100 is never taken; the device is one entry per container id (the physical device), never merged with another by
// its name (the original dropped a Bluetooth device whose name equalled one already listed: two identical pads became
// one); the platform reads the nodes, so this is tested with made-up nodes.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::kind;
use crate::model::{Kind, Percent};
use std::collections::BTreeMap;

/// One Bluetooth device node, as the platform read it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BtNode {
    pub instance_id: String,
    /// The physical device's container id «{…}», when Windows gave one.
    pub container: Option<String>,
    pub name: String,
    pub class_of_device: Option<u32>,
    pub category: Option<String>,
    pub connected: Option<bool>,
    /// The battery property, when the node has it (a byte).
    pub battery: Option<u8>,
    /// The node reports a problem (DN_HAS_PROBLEM): its values are not trusted.
    pub problem: bool,
}

/// One Bluetooth device with a battery level property.
#[derive(Clone, Debug, PartialEq)]
pub struct BtFound {
    pub container: String,
    pub name: String,
    /// None when not connected (Windows' stored value is old then).
    pub level: Option<Percent>,
    pub connected: bool,
    pub kind: Kind,
}

/// A node of a Bluetooth device (classic BTHENUM, LE BTHLE / BTHLEDEVICE).
pub fn is_bt_instance(id: &str) -> bool {
    let u = id.to_ascii_uppercase();
    u.starts_with("BTHENUM\\") || u.starts_with("BTHLE\\") || u.starts_with("BTHLEDEVICE\\")
}

/// The device's own node (the others are its services).
pub fn is_main_node(id: &str) -> bool {
    let u = id.to_ascii_uppercase();
    u.starts_with("BTHENUM\\DEV_") || u.starts_with("BTHLE\\DEV_")
}

/// «WH-1000XM5 Hands-Free AG» → «WH-1000XM5».
pub fn strip_service_suffix(n: &str) -> String {
    for suf in [" Hands-Free AG", " Hands-Free", " Avrcp Transport", " Stereo", " Audio Gateway"] {
        if n.len() > suf.len() && n.ends_with(suf) {
            return n[..n.len() - suf.len()].to_string();
        }
    }
    n.to_string()
}

#[derive(Default)]
struct Acc {
    main_name: Option<String>,
    cod: Option<u32>,
    category: Option<String>,
    main_connected: Option<bool>,
    level: Option<(u8, bool, String)>,
}

/// The devices among `nodes` that have a battery level, one per container.
pub fn gather(nodes: &[BtNode]) -> Vec<BtFound> {
    let mut by: BTreeMap<String, Acc> = BTreeMap::new();
    for n in nodes {
        if !is_bt_instance(&n.instance_id) {
            continue;
        }
        let cid = n.container.clone().filter(|c| !c.is_empty()).unwrap_or_else(|| n.instance_id.clone());
        let a = by.entry(cid).or_default();
        if is_main_node(&n.instance_id) {
            if !n.name.is_empty() {
                a.main_name = Some(n.name.clone());
            }
            if n.class_of_device.is_some() {
                a.cod = n.class_of_device;
            }
            if n.category.as_deref().map_or(false, |c| !c.is_empty()) {
                a.category = n.category.clone();
            }
            // (D1, the original's v1.1.0 MergeConnectedState: a classic and an LE main node can share one container;
            //  it is connected when either is, whatever the order Windows lists them in.)
            if let Some(c) = n.connected {
                a.main_connected = Some(a.main_connected.unwrap_or(false) || c);
            }
        }
        let Some(pct) = n.battery else { continue };
        if n.problem || pct > 100 {
            continue;
        }
        // (A service node's own flag is only a fallback — headphones keep their level on the Hands-Free node, which
        // reads as disconnected while sound runs over A2DP —; a live node's value beats one that is not.)
        let live = n.connected.unwrap_or(true);
        if let Some((_, prev_live, _)) = &a.level {
            if *prev_live && !live {
                continue;
            }
        }
        a.level = Some((pct, live, strip_service_suffix(&n.name)));
    }
    let mut out = Vec::new();
    for (cid, a) in by {
        let Some((pct, live, svc_name)) = a.level else { continue };
        let connected = a.main_connected.unwrap_or(live);
        let name = a.main_name.filter(|s| !s.is_empty()).unwrap_or(svc_name);
        let mut k = a.cod.map_or(Kind::Other, kind::from_class_of_device);
        if k == Kind::Other {
            if let Some(c) = &a.category {
                k = kind::from_category(c);
            }
        }
        // (Earbuds are headsets to Windows: the name tells them apart.)
        let guessed = kind::guess(&name);
        if k == Kind::Other || (k == Kind::Headset && guessed == Kind::Earbuds) {
            k = guessed;
        }
        out.push(BtFound { container: cid, name, level: if connected { Percent::new(pct as i64) } else { None }, connected, kind: k });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, cont: &str, name: &str) -> BtNode {
        BtNode { instance_id: id.into(), container: Some(cont.into()), name: name.into(), ..Default::default() }
    }

    #[test]
    fn instances_and_names() {
        assert!(is_bt_instance("BTHENUM\\{0000111E}_LOCALMFG&0002\\7&1"));
        assert!(is_bt_instance("bthle\\dev_aabbcc"));
        assert!(!is_bt_instance("USB\\VID_046D"));
        assert!(is_main_node("BTHENUM\\DEV_AABBCCDDEEFF\\7&1"));
        assert!(!is_main_node("BTHENUM\\{0000111E}_LOCALMFG"));
        assert_eq!(strip_service_suffix("Buds Hands-Free AG"), "Buds");
        assert_eq!(strip_service_suffix(" Stereo"), " Stereo", "never empty");
        assert_eq!(strip_service_suffix("Plain"), "Plain");
    }

    #[test]
    fn one_device_per_container_with_its_main_nodes_name_and_state() {
        let mut main = node("BTHENUM\\DEV_A1", "{A}", "Studio Phones");
        main.class_of_device = Some(0x240404);
        main.connected = Some(true);
        let mut hf = node("BTHENUM\\{111E}_X\\1", "{A}", "Studio Phones Hands-Free AG");
        hf.battery = Some(80);
        hf.connected = Some(false); // (the Hands-Free node reads as off while sound runs over A2DP)
        let got = gather(&[hf, main]);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "Studio Phones");
        assert!(got[0].connected, "the main node decides");
        assert_eq!(got[0].level.map(Percent::get), Some(80));
        assert_eq!(got[0].kind, Kind::Headset);
    }

    #[test]
    fn not_connected_is_listed_without_an_old_level() {
        let mut main = node("BTHLE\\DEV_B1", "{B}", "Shape Mouse");
        main.connected = Some(false);
        main.category = Some("Input.Mouse".into());
        main.battery = Some(55);
        let got = gather(&[main]);
        assert_eq!(got.len(), 1);
        assert!(!got[0].connected);
        assert_eq!(got[0].level, None);
        assert_eq!(got[0].kind, Kind::Mouse);
    }

    #[test]
    fn problems_and_nonsense_are_dropped_and_twins_stay_two() {
        let mut bad = node("BTHLE\\DEV_C1", "{C}", "Broken");
        bad.battery = Some(40);
        bad.problem = true;
        let mut over = node("BTHLE\\DEV_D1", "{D}", "Over");
        over.battery = Some(200);
        let mut p1 = node("BTHLE\\DEV_E1", "{E1}", "Wireless Controller");
        p1.battery = Some(30);
        let mut p2 = node("BTHLE\\DEV_E2", "{E2}", "Wireless Controller");
        p2.battery = Some(90);
        let usb = BtNode { instance_id: "USB\\VID_1".into(), battery: Some(10), ..Default::default() };
        let got = gather(&[bad, over, p1, p2, usb]);
        assert_eq!(got.len(), 2, "two identical pads stay two; the broken, the over-100 and the USB node are not taken");
        assert!(got.iter().all(|g| g.name == "Wireless Controller"));
        assert_eq!(got.iter().filter_map(|g| g.level).map(Percent::get).collect::<Vec<_>>(), vec![30, 90]);
    }

    #[test]
    fn a_live_value_beats_a_stale_one_and_earbuds_are_earbuds() {
        let mut a = node("BTHENUM\\{1}_A\\1", "{F}", "Pocket Buds Hands-Free");
        a.battery = Some(70);
        a.connected = Some(true);
        let mut b = node("BTHENUM\\{2}_B\\1", "{F}", "Pocket Buds Stereo");
        b.battery = Some(20);
        b.connected = Some(false);
        let mut m = node("BTHENUM\\DEV_F", "{F}", "Pocket Buds");
        m.class_of_device = Some(0x240404);
        let got = gather(&[a, b, m]);
        assert_eq!(got[0].level.map(Percent::get), Some(70));
        assert_eq!(got[0].kind, Kind::Earbuds);
        assert!(got[0].connected, "no main flag: the live service node's");
    }

    #[test]
    fn fuzz_odd_nodes() {
        let mut nodes = Vec::new();
        for i in 0..300u32 {
            nodes.push(BtNode {
                instance_id: ["BTHLE\\DEV_", "BTHENUM\\", "x", "", "BTHLEDEVICE\\{"][i as usize % 5].to_string() + &i.to_string(),
                container: if i % 3 == 0 { None } else { Some(format!("{{{}}}", i % 7)) },
                name: ["", " Stereo", "é Hands-Free", "名前"][i as usize % 4].into(),
                class_of_device: if i % 2 == 0 { Some(i.wrapping_mul(2654435761)) } else { None },
                category: if i % 5 == 0 { Some(String::new()) } else { None },
                connected: [None, Some(true), Some(false)][i as usize % 3],
                battery: if i % 4 == 0 { None } else { Some((i * 37) as u8) },
                problem: i % 11 == 0,
            });
        }
        for f in gather(&nodes) {
            assert!(f.level.map_or(true, |p| p.get() <= 100));
            assert!(f.connected || f.level.is_none());
        }
    }

    #[test]
    fn classic_and_le_nodes_of_one_container() {
        // (D1: either main node connected — in either order — is connected.)
        for order in [[true, false], [false, true]] {
            let mut a = node("BTHENUM\\DEV_A1A1A1A1A1A1\\X", "{M}", "Shape Mouse");
            a.connected = Some(order[0]);
            a.battery = Some(60);
            let mut b = node("BTHLE\\DEV_A1A1A1A1A1A1\\Y", "{M}", "Shape Mouse");
            b.connected = Some(order[1]);
            let got = gather(&[a, b]);
            assert!(got[0].connected && got[0].level.is_some(), "{:?}", order);
        }
    }
}
