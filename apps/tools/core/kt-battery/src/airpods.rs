// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): AirPods and Beats from what they broadcast (piece 6).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/airpods.cpp (ParseProximityTlv, Parse, IsSingleBatteryModel, PairedAppleAudio, Pick) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later. Its references for the
// layout: OpenPods, MagicPodsCore, AirPodsDesktop, librepods.
// Windows does not read AirPods' battery; they broadcast it in clear several times a second, in Apple's Bluetooth LE
// «proximity pairing» message (manufacturer data of company 004C, type 07, length 19): [2] 01 paired, [3–4] model
// (= the Bluetooth product id, 20xx), [5] bit 5 the left bud broadcasts, [6] low nibble the broadcasting bud and high
// nibble the other (0–10 = tenths, 15 unknown) — or one battery for single-battery models —, [7] high nibble charging
// bits (this bud, the other, the case), low nibble the case. Listening only: nothing is sent to anyone, no connection
// is made. Others' AirPods nearby broadcast the same message with random addresses: only a message whose model is a
// paired device's product id is taken, the strongest recent one winning.
// The listening needs Windows' BluetoothLEAdvertisementWatcher, a WinRT class: win/ble.rs, behind the `wgi` feature
// (off by default until CI has compiled it); without it a paired AirPods card says «not available in this build».
// Changed here: the buds and the case as parts of one card (the original showed the lower discharging bud and listed
// the parts in its «via» text); levels as tenths — the broadcast's own step — never finer; a bud that charges is in
// its case (not in use) for the card's level and the notices; a message older than 90 s (5 min while connected) is
// not taken; no value kept beyond the watcher's map of recent messages (the original's, bounded the same way).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::bluetooth::{is_main_node, BtNode};
use crate::model::{Charging, Level, Part, PartName, Reading, Steps};
use std::collections::BTreeMap;

/// One decoded broadcast. Levels are tenths (0–10), None when unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Advert {
    pub model: u16,
    pub single: bool,
    pub left: Option<u8>,
    pub right: Option<u8>,
    pub case: Option<u8>,
    pub left_chg: bool,
    pub right_chg: bool,
    pub case_chg: bool,
    pub rssi: i16,
    /// When it was heard (ms, the caller's clock).
    pub at: u64,
}

/// Single-battery headphones (AirPods Max, Beats headphones and neckbands): their level in the low nibble only.
pub fn is_single(model: u16) -> bool {
    matches!(model, 0x200A | 0x201F | 0x202D | 0x2003 | 0x2005 | 0x2006 | 0x2009 | 0x200C | 0x200D | 0x2010 | 0x2017 | 0x2025)
}

fn tenth(n: u8) -> Option<u8> {
    if n <= 10 {
        Some(n)
    } else {
        None
    }
}

fn proximity(d: &[u8]) -> Option<Advert> {
    if d.len() < 27 || d[0] != 0x07 || d[1] != 0x19 || d[2] != 0x01 {
        return None;
    }
    let model = u16::from(d[3]) | u16::from(d[4]) << 8;
    if model & 0xFF00 != 0x2000 {
        return None;
    }
    let mut a = Advert { model, single: is_single(model), ..Default::default() };
    let left_b = d[5] & 0x20 != 0;
    let (cur, other) = (d[6] & 0x0F, d[6] >> 4);
    let chg = d[7] >> 4;
    if a.single {
        let (lvl, c) = if cur == 0 && (1..=10).contains(&other) { (tenth(other), chg & 0x02 != 0) } else { (tenth(cur), chg & 0x01 != 0) };
        a.left = Some(lvl?);
        a.left_chg = c;
        return Some(a);
    }
    a.left = tenth(if left_b { cur } else { other });
    a.right = tenth(if left_b { other } else { cur });
    a.left_chg = a.left.is_some() && chg & (if left_b { 0x01 } else { 0x02 }) != 0;
    a.right_chg = a.right.is_some() && chg & (if left_b { 0x02 } else { 0x01 }) != 0;
    a.case = tenth(d[7] & 0x0F);
    a.case_chg = a.case.is_some() && chg & 0x04 != 0;
    if a.left.is_none() && a.right.is_none() && a.case.is_none() {
        return None;
    }
    Some(a)
}

/// Apple's manufacturer data (company 004C, its id not included): the TLV walk to the proximity message.
pub fn parse(buf: &[u8], rssi: i16, at: u64) -> Option<Advert> {
    let mut i = 0usize;
    while i + 1 < buf.len() {
        let len = usize::from(buf[i + 1]);
        if i + 2 + len > buf.len() {
            break;
        }
        if buf[i] == 0x07 {
            if let Some(mut a) = proximity(&buf[i..i + 2 + len]) {
                a.rssi = rssi;
                a.at = at;
                return Some(a);
            }
        }
        i += 2 + len;
    }
    None
}

/// A paired Apple audio device as Windows lists it.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Paired {
    pub container: String,
    pub name: String,
    /// The model (Bluetooth product id, 20xx) from its service nodes' «_VID&0001004C_PID&xxxx», 0 when not seen.
    pub pid: u16,
    pub connected: bool,
}

fn apple_pid(instance: &str) -> Option<u16> {
    let u = instance.to_ascii_uppercase();
    let v = u.find("_VID&0001004C")?;
    let p = u[v..].find("_PID&")? + v + 5;
    u16::from_str_radix(u.get(p..p + 4)?, 16).ok()
}

/// The paired Apple headphones and earbuds among Windows' Bluetooth nodes, one per container.
pub fn paired(nodes: &[BtNode]) -> Vec<Paired> {
    let mut by: BTreeMap<String, (Paired, bool)> = BTreeMap::new();
    for n in nodes {
        let Some(c) = n.container.clone().filter(|c| !c.is_empty()) else { continue };
        let e = by.entry(c.clone()).or_insert_with(|| (Paired { container: c, ..Default::default() }, false));
        if let Some(p) = apple_pid(&n.instance_id) {
            e.1 = true;
            e.0.pid = p;
        }
        if is_main_node(&n.instance_id) {
            if !n.name.is_empty() {
                e.0.name = n.name.clone();
            }
            e.0.connected = n.connected.unwrap_or(false);
        }
    }
    by.into_values()
        .filter(|(p, apple)| {
            let u = p.name.to_ascii_uppercase();
            let looks = u.contains("AIRPODS") || u.contains("BEATS");
            (*apple && p.pid & 0xFF00 == 0x2000) || (p.connected && looks && p.pid == 0)
        })
        .map(|(p, _)| p)
        .collect()
}

/// The best message for one paired device: its model when known; heard within 90 s (5 min while connected) and loud
/// enough; the freshest strongest; with a missing side or case filled from another bud's message within 15 s.
pub fn pick(dev: &Paired, heard: &[Advert], now: u64) -> Option<Advert> {
    let max_age = if dev.connected { 5 * 60_000 } else { 90_000 };
    let min_rssi = if dev.connected { -90 } else { -80 };
    let fresh = |a: &Advert| now.saturating_sub(a.at) < 90_000;
    let mut best: Option<Advert> = None;
    for a in heard {
        if (dev.pid != 0 && a.model != dev.pid) || now.saturating_sub(a.at) > max_age || a.rssi < min_rssi || a.at > now {
            continue;
        }
        best = match best {
            None => Some(*a),
            Some(b) => {
                let (fa, fb) = (fresh(a), fresh(&b));
                if (fa && !fb) || (fa && fb && a.rssi > b.rssi) || (!fa && !fb && a.at > b.at) {
                    Some(*a)
                } else {
                    Some(b)
                }
            }
        };
    }
    let mut b = best?;
    if !b.single {
        for a in heard.iter().filter(|a| a.model == b.model && !a.single && a.at.abs_diff(b.at) <= 15_000) {
            if b.left.is_none() && a.left.is_some() {
                b.left = a.left;
                b.left_chg = a.left_chg;
            }
            if b.right.is_none() && a.right.is_some() {
                b.right = a.right;
                b.right_chg = a.right_chg;
            }
            if b.case.is_none() && a.case.is_some() {
                b.case = a.case;
                b.case_chg = a.case_chg;
            }
        }
    }
    Some(b)
}

fn tenths(n: Option<u8>) -> Level {
    n.and_then(|v| Steps::new(i64::from(v), 10)).map_or(Level::Unknown, Level::Steps)
}
fn ch(b: bool) -> Charging {
    if b {
        Charging::Yes
    } else {
        Charging::No
    }
}

/// The reading of a message: one level for single-battery headphones; the buds and the case as parts otherwise (a bud
/// that charges is in its case: not in use).
pub fn reading(a: &Advert, taken_at: u64) -> Reading {
    if a.single {
        return Reading::new(tenths(a.left), ch(a.left_chg), taken_at);
    }
    let bud = |name, v: Option<u8>, c: bool| v.map(|_| Part { name, level: tenths(v), charging: ch(c), in_use: !c });
    let case = a.case.map(|_| Part { name: PartName::Case, level: tenths(a.case), charging: ch(a.case_chg), in_use: false });
    Reading::with_parts([bud(PartName::Left, a.left, a.left_chg), bud(PartName::Right, a.right, a.right_chg), case], taken_at)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(model: u16, s5: u8, s6: u8, s7: u8) -> Vec<u8> {
        let mut d = vec![0u8; 27];
        d[0] = 0x07;
        d[1] = 0x19;
        d[2] = 0x01;
        d[3] = model as u8;
        d[4] = (model >> 8) as u8;
        d[5] = s5;
        d[6] = s6;
        d[7] = s7;
        d
    }

    #[test]
    fn broadcasts() {
        // (AirPods Pro 2, the left bud broadcasting at 80 %, the right at 60 %, the case at 30 % charging.)
        let a = parse(&msg(0x2014, 0x20, 0x68, 0x43), -50, 1_000).unwrap();
        assert_eq!((a.left, a.right, a.case, a.case_chg, a.left_chg), (Some(8), Some(6), Some(3), true, false));
        let r = reading(&a, 1_000);
        assert_eq!(r.level, Level::Steps(Steps::new(6, 10).unwrap()), "the lower bud in use, never the case");
        assert_eq!(r.parts[2].map(|p| (p.name, p.in_use)), Some((PartName::Case, false)));
        // (The right one broadcasting: the nibbles swap.)
        let a = parse(&msg(0x2014, 0x00, 0x68, 0x10), -50, 1).unwrap();
        assert_eq!((a.left, a.right, a.right_chg), (Some(6), Some(8), true));
        let r = reading(&a, 1);
        assert_eq!(r.level, Level::Steps(Steps::new(6, 10).unwrap()), "the charging bud is in the case");
        // (AirPods Max: one battery.)
        let m = parse(&msg(0x200A, 0x00, 0x07, 0x90), -60, 1).unwrap();
        assert!(m.single);
        assert_eq!(reading(&m, 1), Reading::new(Level::Steps(Steps::new(7, 10).unwrap()), Charging::Yes, 1));
        // (Malformed: pairing mode, another type, not an audio model, short, every level unknown.)
        assert!(parse(&{ let mut d = msg(0x2014, 0, 0x68, 0); d[2] = 0; d }, 0, 0).is_none());
        assert!(parse(&msg(0x1234, 0, 0x68, 0), 0, 0).is_none());
        assert!(parse(&msg(0x2014, 0, 0x68, 0)[..20], 0, 0).is_none());
        assert!(parse(&msg(0x2014, 0, 0xFF, 0x0F), 0, 0).is_none());
        // (Another TLV before it: walked past.)
        let mut buf = vec![0x10, 0x02, 0xAA, 0xBB];
        buf.extend(msg(0x2014, 0x20, 0x55, 0x05));
        assert_eq!(parse(&buf, -40, 3).map(|a| a.left), Some(Some(5)));
    }

    #[test]
    fn only_the_paired_model_the_strongest_recent() {
        let dev = Paired { container: "{A}".into(), name: "My AirPods Pro".into(), pid: 0x2014, connected: false };
        let mine = Advert { model: 0x2014, left: Some(9), right: Some(9), rssi: -60, at: 100_000, ..Default::default() };
        let near = Advert { model: 0x2014, left: Some(2), rssi: -45, at: 99_000, ..Default::default() };
        let far = Advert { model: 0x2014, left: Some(1), rssi: -85, at: 100_000, ..Default::default() };
        let other = Advert { model: 0x200E, left: Some(1), rssi: -30, at: 100_000, ..Default::default() };
        assert_eq!(pick(&dev, &[mine, far, other], 101_000).map(|a| a.left), Some(Some(9)), "too weak and another model: not taken");
        assert_eq!(pick(&dev, &[mine, near], 101_000).map(|a| a.rssi), Some(-45), "the strongest");
        assert_eq!(pick(&dev, &[mine], 100_000 + 91_000), None, "older than 90 s while not connected");
        let conn = Paired { connected: true, ..dev.clone() };
        assert!(pick(&conn, &[mine], 100_000 + 91_000).is_some());
        // (The other bud's own message fills the missing side.)
        let l = Advert { model: 0x2014, left: Some(7), rssi: -50, at: 50_000, ..Default::default() };
        let r = Advert { model: 0x2014, right: Some(4), case: Some(9), rssi: -70, at: 45_000, ..Default::default() };
        let b = pick(&dev, &[l, r], 51_000).unwrap();
        assert_eq!((b.left, b.right, b.case), (Some(7), Some(4), Some(9)));
    }

    #[test]
    fn paired_apple_audio_only() {
        let node = |id: &str, c: &str, name: &str, conn: Option<bool>| BtNode { instance_id: id.into(), container: Some(c.into()), name: name.into(), connected: conn, ..Default::default() };
        let nodes = vec![
            node("BTHENUM\\DEV_A1B2C3D4E5F6\\X", "{1}", "Ana's AirPods Pro", Some(false)),
            node("BTHENUM\\{0000110B-0000-1000-8000-00805F9B34FB}_VID&0001004C_PID&2014\\Y", "{1}", "", None),
            node("BTHENUM\\DEV_111111111111\\X", "{2}", "Ana's iPhone", Some(true)),
            node("BTHENUM\\{X}_VID&0001004C_PID&1234\\Y", "{2}", "", None),
            node("BTHENUM\\DEV_222222222222\\X", "{3}", "Beats Flex", Some(true)),
            node("BTHENUM\\DEV_333333333333\\X", "{4}", "Some Headset", Some(true)),
        ];
        let p = paired(&nodes);
        assert_eq!(p.iter().map(|x| (x.container.as_str(), x.pid)).collect::<Vec<_>>(), vec![("{1}", 0x2014), ("{3}", 0)]);
        assert_eq!(apple_pid("bthenum\\{x}_vid&0001004c_pid&200a\\y"), Some(0x200A));
    }
}
