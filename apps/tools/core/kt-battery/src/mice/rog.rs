// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): ASUS ROG wireless keyboards and mice (VID 0B05), on their receivers
// or cables (the unnumbered vendor channel).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/rog.cpp (kModels, Query, ReadModel) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and
// its contributors, GPL-3.0-or-later. Its references: SteveWang92/peripheral-battery-tray (rog-battery, after
// G-Helper), 1gcat/BatteryTool.
// Output [00][12][sub] (sub 01 keyboard battery, 07 mouse battery) on a vendor collection (≥ 12-byte output) of the
// model's interface; reply [12][sub]…: keyboard [offset] percent (Falchion: 11), [8] = 1 charging; mouse [offset]
// level (× 25 on the older 0–4 gauges), [9] charging. FF AA in [0..1]: the device behind the receiver did not answer.
// (Offsets here count from after the report id; the original's counted it.)
// Not ported: the ROG Omni Receiver (1ACE) and the models' Omni-channel entries (report ids 02 / 03 on col02 / col03):
// the original picks the channel by the collection's index in its path, which this port does not match by; the same
// models are read on their own unnumbered channel. The ROG Pelta and Delta II headsets are the headset piece's.
// Changed here: the 0–4 gauges as their own four steps (the original: × 25 per cent); 0 is «asleep» (as the original).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

/// arg: offset << 8 | scale.
const fn r(pid: u16, name: &'static str, kind: Kind, iface: i32, offset: u16, scale: u16) -> Model {
    let m = Model::new("mk-rog", 0x0B05, pid, name, kind, Via::Direct).vendor_page().output(Len::Min(12)).arg(offset << 8 | scale);
    if iface >= 0 {
        m.iface(iface)
    } else {
        m
    }
}

pub static MODELS: &[Model] = &[
    r(0x1A85, "ROG Azoth", Kind::Keyboard, 1, 6, 1),
    r(0x1A83, "ROG Azoth", Kind::Keyboard, 1, 6, 1),
    r(0x1B3F, "ROG Azoth Extreme", Kind::Keyboard, 1, 6, 1),
    r(0x1CEF, "ROG Azoth Extreme SE", Kind::Keyboard, 1, 6, 1),
    r(0x1C25, "ROG Azoth X", Kind::Keyboard, 1, 6, 1),
    r(0x1C24, "ROG Azoth X", Kind::Keyboard, 1, 6, 1),
    r(0x193E, "ROG Falchion", Kind::Keyboard, 1, 11, 1),
    r(0x193C, "ROG Falchion", Kind::Keyboard, 1, 11, 1),
    r(0x1B04, "ROG Falchion RX", Kind::Keyboard, -1, 11, 1),
    r(0x1AAE, "ROG Strix Scope II 96", Kind::Keyboard, 1, 6, 1),
    r(0x1B78, "ROG Strix Scope II 96 RX", Kind::Keyboard, 1, 6, 1),
    r(0x1A07, "ROG Strix Scope RX TKL", Kind::Keyboard, -1, 6, 1),
    r(0x18E5, "ROG Chakram", Kind::Mouse, 0, 5, 25),
    r(0x18E3, "ROG Chakram", Kind::Mouse, 0, 5, 25),
    r(0x1A1A, "ROG Chakram X", Kind::Mouse, 0, 5, 1),
    r(0x1A18, "ROG Chakram X", Kind::Mouse, 0, 5, 1),
    r(0x18A0, "ROG Gladius II Wireless", Kind::Mouse, 2, 5, 25),
    r(0x197F, "ROG Gladius III Wireless", Kind::Mouse, 0, 5, 1),
    r(0x197D, "ROG Gladius III Wireless", Kind::Mouse, 0, 5, 1),
    r(0x1A72, "ROG Gladius III Aimpoint", Kind::Mouse, 0, 5, 1),
    r(0x1A70, "ROG Gladius III Aimpoint", Kind::Mouse, 0, 5, 1),
    r(0x1B0C, "ROG Gladius III Aimpoint EVA-02", Kind::Mouse, 0, 5, 1),
    r(0x1B0A, "ROG Gladius III Aimpoint EVA-02", Kind::Mouse, 0, 5, 1),
    r(0x1A94, "ROG Harpe Ace Aim Lab Edition", Kind::Mouse, 0, 5, 1),
    r(0x1A92, "ROG Harpe Ace Aim Lab Edition", Kind::Mouse, 0, 5, 1),
    r(0x1B67, "ROG Harpe Ace Extreme", Kind::Mouse, 0, 5, 1),
    r(0x1B63, "ROG Harpe Ace Mini", Kind::Mouse, 0, 5, 1),
    r(0x1C69, "ROG Harpe II Ace", Kind::Mouse, 0, 5, 1),
    r(0x1960, "ROG Keris Wireless", Kind::Mouse, 0, 5, 25),
    r(0x195E, "ROG Keris Wireless", Kind::Mouse, 0, 5, 25),
    r(0x1A59, "ROG Keris Wireless EVA Edition", Kind::Mouse, 0, 5, 25),
    r(0x1A57, "ROG Keris Wireless EVA Edition", Kind::Mouse, 0, 5, 25),
    r(0x1A68, "ROG Keris Wireless Aimpoint", Kind::Mouse, 0, 5, 1),
    r(0x1A66, "ROG Keris Wireless Aimpoint", Kind::Mouse, 0, 5, 1),
    r(0x1B16, "ROG Keris II Ace", Kind::Mouse, 0, 5, 1),
    r(0x1C0C, "ROG Keris II Origin", Kind::Mouse, 0, 5, 1),
    r(0x1D4C, "ROG Keris II Origin KJP", Kind::Mouse, 0, 5, 1),
    r(0x1908, "ROG Pugio II", Kind::Mouse, 0, 5, 25),
    r(0x1906, "ROG Pugio II", Kind::Mouse, 0, 5, 25),
    r(0x1979, "ROG Spatha X", Kind::Mouse, 0, 5, 1),
    r(0x1977, "ROG Spatha X", Kind::Mouse, 0, 5, 1),
    r(0x18B4, "ROG Strix Carry", Kind::Mouse, 1, 7, 25),
    r(0x1949, "ROG Strix Impact II Wireless", Kind::Mouse, 0, 5, 25),
    r(0x1947, "ROG Strix Impact II Wireless", Kind::Mouse, 0, 5, 25),
];

pub const KB: [u8; 3] = [0x00, 0x12, 0x01];
pub const MOUSE: [u8; 3] = [0x00, 0x12, 0x07];

pub fn read(ch: &mut Chans, m: &Model, _slot: Option<u8>, deadline: Instant, now: u64) -> Answer {
    let keyboard = m.kind == Kind::Keyboard;
    let req = if keyboard { KB } else { MOUSE };
    let (off, scale) = (usize::from(m.arg >> 8) - 1, m.arg & 0xFF);
    let r = out_ask(ch, &req, ms(500), deadline, &mut |r| {
        if r.len() < 11 {
            return None;
        }
        if r[0] == 0xFF && r[1] == 0xAA {
            return Some(None);
        }
        if r[0] == 0x12 && r[1] == req[2] && r.len() > off {
            return Some(Some(r.to_vec()));
        }
        None
    });
    let out = match r {
        Ok(None) => dozing(now),
        Ok(Some(r)) if keyboard => match pct(i64::from(r[off])) {
            Some(l) => got(l, charging(r[8] == 1), now),
            None => no_level(charging(r[8] == 1), now),
        },
        Ok(Some(r)) => {
            let v = r[off];
            let level = if scale == 25 { steps(i64::from(v), 4).filter(|_| v > 0) } else { pct(i64::from(v)).filter(|_| v > 0) };
            match level {
                Some(l) => got(l, charging(r[9] != 0), now),
                None => dozing(now),
            }
        }
        Err(e) => failed(&e),
    };
    out.into()
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn rog() {
        let k = model("mk-rog", 0x1A85);
        let mut f = fake(k);
        f.replies.push_back(vec![vec![0x00, 0x12, 0x01, 0, 0, 0, 74, 0, 0, 1, 0, 0]]);
        assert_eq!(read1(&mut f, k), at(pctl(74), Charging::Yes));
        assert_eq!(f.sent, vec![KB.to_vec()]);
        let old = model("mk-rog", 0x18E5);
        let mut f = fake(old);
        f.replies.push_back(vec![vec![0x00, 0x12, 0x07, 0, 0, 3, 0, 0, 0, 0, 1, 0]]);
        assert_eq!(read1(&mut f, old), at(steps(3, 4).unwrap(), Charging::Yes), "the 0–4 gauge as steps");
        let mut f = fake(old);
        f.replies.push_back(vec![vec![0x00, 0xFF, 0xAA, 0, 0, 0, 0, 0, 0, 0, 0, 0]]);
        assert_eq!(read1(&mut f, old), dozing(7));
        assert!(find(&HidIdent { vid: 0x0B05, pid: 0x1ACE, usage_page: 0xFF00, usage: 1, interface: 2 }, 64, 64, 0).is_none(), "the Omni receiver: not ported");
    }
}
