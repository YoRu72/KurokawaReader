// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): ATK / VXE — the NearLink mice on the «NK mouse NANO dongle»
// (373B:1216, ATK's BITMOUSE protocol) and the ATK V75X keyboard (320F:5088 receiver, 5055 cable). The Dragonfly R1
// family takes the «Compx 17» frames (kysona.rs); the ATK N9 headsets (atk_serial.cpp) are the headset piece's.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/atk_bitmouse.cpp and atk_keyboard.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9
// and its contributors, GPL-3.0-or-later. Their references: HeyOkay/HaloBattery (atk_bitmouse.py, atk_keyboard.py),
// qwr79/mouse-battery, ATK HUB 3.2.29's Evision keyboard driver.
//  - NK dongle, FF05:0001: output report 08, 64 bytes [08][sum of bytes 2–63][72][02][00][01 = the mouse][cmd][01];
//    reply [08][72][status: FF error][seq][00][cmd][01][value]. cmd 07 level, 0F charging. No reply: asleep.
//  - V75X, FF1C:0092: output report 04 [04][seq lo][seq hi][1A][00 …]; input report 04 [04][seq lo][seq hi][1A][..]
//    [00 00][..][percent][state: 0 on battery, 1 / 2 charging]. The ids are shared with other Evision keyboards, so the
//    product string is checked too (Model::product).
// D1 (the original's v1.1.0, atk_bitmouse.cpp, atk_keyboard.cpp, ajazz_ak992.cpp, redragon_evision.cpp at commit 7cc44f2;
// their references: ATK HUB 3.2.33 (AtkRadioGroup), VGN HUB (getElectricQuantity), HeyOkay/HaloBattery docs/protocols.md,
// a USB capture of Redragon's software):
//  - ATK 8K Nano dongle, 373B:1178, FF10:0001 (no report ids): GetConfigData — feature report 0, [00][82] — answered by
//    an input report [82][rate][dpi stage][light][brightness][speed][colour][..][battery: bit 7 charging, 0–6 percent]
//    [link: 0 no mouse]. Only GetConfigData is sent.
//  - The same Evision status request on more products: VGN / VXE keyboards on 320F:5088 / 5055 ([04][seq][1A][06], VGN
//    HUB's, the reply up to 2.5 s later), keyboards whose receiver is named «Wireless Gaming Keyboard» (the ATK frame),
//    the AJAZZ AK992 on its Telink receiver (320F:50C3, interface 1, the ATK frame) and Redragon mice on the Evision
//    receiver 320F:226F ([04][seq][1A][02], as Redragon's software sends). Each model by its product strings where the
//    ids are shared (Model::product, «|» between names).
// Changed here: one fixed sequence number (01 00) — the reply is tied to the request by the queue dropped first and
// the echo; the original's «ask over the receiver at most every 10 minutes» is the round's interval; nothing kept
// across rounds (the original's lastPercent).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn ev(driver: &'static str, pid: u16, name: &'static str, kind: Kind, via: Via) -> Model {
    Model::new(driver, 0x320F, pid, name, kind, via).page(0xFF1C).usage(0x0092)
}

/// VGN HUB's names on the shared Evision ids (the receiver's and the cable's).
pub const VGN_NAMES: &str = "VGN S99 2.4G Dongle|VGN S99|VGN V98pro V2 2.4G Dongle|VGN V98pro V2|VGN V98 PRO 2.4G Dongle|VGN V98pro|VGN N75 PRO 2.4G Dongle|VGN N75 PRO|VGN VXE75 V2 2.4G Dongle|VGN VXE75 V2|VGN VXE75 2.4G Dongle|VGN VXE75|VXE V87 2.4G Dongle|VXE V87|VXE V87 RGB";

pub static MODELS: &[Model] = &[
    Model::new("mk-atk-nk", 0x373B, 0x1216, "ATK / VXE NK mouse", Kind::Mouse, Via::Receiver).page(0xFF05).usage(0x0001).output(Len::Min(64)).input(Len::Min(8)),
    ev("mk-atk-kb", 0x5055, "ATK V75X", Kind::Keyboard, Via::Cable).pair("atk:v75x").product_is("ATK V75X"),
    ev("mk-atk-kb", 0x5088, "ATK V75X", Kind::Keyboard, Via::Receiver).pair("atk:v75x").product_is("ATK V75X 2.4G Dongle"),
    ev("mk-atk-kb", 0x5088, "Wireless keyboard", Kind::Keyboard, Via::Receiver).product_is("Wireless Gaming Keyboard"),
    ev("mk-vgn-kb", 0x5055, "VGN keyboard", Kind::Keyboard, Via::Cable).pair("vgn:kb").product_is(VGN_NAMES).product_name(),
    ev("mk-vgn-kb", 0x5088, "VGN keyboard", Kind::Keyboard, Via::Receiver).pair("vgn:kb").product_is(VGN_NAMES).product_name(),
    Model::new("mk-atk-8k", 0x373B, 0x1178, "ATK 8K Nano mouse", Kind::Mouse, Via::Receiver).page(0xFF10).usage(0x0001).feature(Len::Min(9)).input(Len::Min(11)),
    ev("mk-ajazz-ak992", 0x50C3, "AJAZZ AK992", Kind::Keyboard, Via::Receiver).iface(1).input(Len::Eq(64)).output(Len::Eq(64)).feature(Len::Eq(0)),
    ev("mk-redragon-ev", 0x226F, "Redragon wireless mouse", Kind::Mouse, Via::Receiver),
];

pub const fn nk(cmd: u8) -> [u8; 8] {
    [0x08, 0x76u8.wrapping_add(cmd), 0x72, 0x02, 0x00, 0x01, cmd, 0x01]
}
pub const NK_LEVEL: [u8; 8] = nk(0x07);
pub const NK_CHARGING: [u8; 8] = nk(0x0F);
pub const KB: [u8; 4] = [0x04, 0x01, 0x00, 0x1A];
pub const KB_VGN: [u8; 5] = [0x04, 0x01, 0x00, 0x1A, 0x06];
pub const KB_REDRAGON: [u8; 5] = [0x04, 0x01, 0x00, 0x1A, 0x02];
/// GetConfigData as feature report 0.
pub const NANO_8K: [u8; 2] = [0x00, 0x82];

fn nk_query(ch: &mut Chans, req: &[u8; 8], deadline: Instant) -> Result<u8, TErr> {
    let cmd = req[6];
    out_ask(ch, req, ms(700), deadline, &mut |r| {
        if r.len() < 8 || r[0] != 0x08 || r[1] != 0x72 || r[5] != cmd {
            return None;
        }
        Some(r[2])
            .filter(|&s| s != 0xFF)
            .map(|_| r[7])
            .or(Some(0xFF))
    })
}

pub fn read_nk(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Outcome {
    match nk_query(ch, &NK_LEVEL, deadline) {
        Ok(l) if (1..=100).contains(&l) => {
            let c = match nk_query(ch, &NK_CHARGING, deadline) {
                Ok(1) => Charging::Yes,
                Ok(0) => Charging::No,
                _ => Charging::Unknown,
            };
            got(pct(i64::from(l)).unwrap_or(Level::Unknown), c, now)
        }
        Ok(_) => no_level(Charging::Unknown, now),
        Err(TErr::Gone) => Outcome::Failed,
        // (The dongle stops answering while the mouse sleeps.)
        Err(_) => dozing(now),
    }
}

pub fn read_kb(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    let (req, step): (&[u8], u64) = match m.driver {
        "mk-vgn-kb" => (&KB_VGN, 2500),
        "mk-redragon-ev" => (&KB_REDRAGON, 1000),
        "mk-ajazz-ak992" => (&KB, 600),
        _ => (&KB, 1000),
    };
    match out_ask(ch, req, ms(step), deadline, &mut |r| if r.len() >= 10 && r[0] == 0x04 && r[1] == 0x01 && r[2] == 0x00 && r[3] == 0x1A && r[5] == 0 && r[6] == 0 { Some((r[8], r[9])) } else { None }) {
        Ok((p, s)) if p <= 100 && s <= 2 => got(pct(i64::from(p)).unwrap_or(Level::Unknown), charging(s == 1 || s == 2), now),
        Ok(_) => no_level(Charging::Unknown, now),
        Err(TErr::Gone) => Outcome::Failed,
        Err(_) => dozing(now),
    }
}

/// The 8K Nano dongle's GetConfigData reply: (level byte, link byte), or None for another report.
pub fn nano_8k(r: &[u8]) -> Option<(u8, u8)> {
    if r.len() >= 10 && r[0] == 0x82 {
        Some((r[8], r[9]))
    } else {
        None
    }
}

pub fn read_8k(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Outcome {
    match feat_then_read(ch, &NANO_8K, ms(700), deadline, &mut nano_8k) {
        Ok((_, 0)) => unlinked(now),
        Ok((b, _)) => match pct(i64::from(b & 0x7F)) {
            Some(l) if b & 0x7F >= 1 => got(l, charging(b & 0x80 != 0), now),
            _ => no_level(Charging::Unknown, now),
        },
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn atk() {
        assert_eq!(NK_LEVEL[1], sum8(&{
            let mut b = [0u8; 64];
            b[..8].copy_from_slice(&NK_LEVEL);
            b
        }[2..]));
        let m = model("mk-atk-nk", 0x1216);
        let mut f = fake(m);
        f.replies.extend([vec![report(0x08, 8, &[(1, 0x72), (2, 0), (5, 0x07), (6, 1), (7, 88)])], vec![report(0x08, 8, &[(1, 0x72), (5, 0x0F), (6, 1), (7, 1)])]]);
        assert_eq!(read1(&mut f, m), at(pctl(88), Charging::Yes));
        assert_eq!(f.sent, vec![NK_LEVEL.to_vec(), NK_CHARGING.to_vec()]);
        let mut f = fake(m);
        assert_eq!(read1(&mut f, m), dozing(7), "no reply: asleep");
        let k = model("mk-atk-kb", 0x5088);
        assert!(k.product_ok("ATK V75X 2.4G Dongle  ") && k.product_ok("atk v75x 2.4g dongle") && !k.product_ok("Evision keyboard"));
        let mut f = fake(k);
        f.replies.push_back(vec![report(0x04, 32, &[(1, 0x01), (3, 0x1A), (8, 45), (9, 2)])]);
        assert_eq!(read1(&mut f, k), at(pctl(45), Charging::Yes));
        let mut f = fake(k);
        f.replies.push_back(vec![report(0x04, 32, &[(1, 0x02), (3, 0x1A), (8, 45)])]);
        assert_eq!(read1(&mut f, k), dozing(7), "another sequence: not our reply");
    }

    #[test]
    fn v110_evision_and_8k() {
        // (The shared ids: each model by its product string.)
        let id = |pid: u16| HidIdent { vid: 0x320F, pid, usage_page: 0xFF1C, usage: 0x0092, interface: 1 };
        assert_eq!(find_for(&id(0x5088), 32, 32, 0, "VGN S99 2.4G Dongle").map(|m| m.driver), Some("mk-vgn-kb"));
        assert_eq!(find_for(&id(0x5055), 32, 32, 0, "vxe v87 rgb ").map(|m| m.driver), Some("mk-vgn-kb"));
        assert_eq!(find_for(&id(0x5088), 32, 32, 0, "ATK V75X 2.4G Dongle").map(|m| (m.driver, m.name)), Some(("mk-atk-kb", "ATK V75X")));
        assert_eq!(find_for(&id(0x5088), 32, 32, 0, "Wireless Gaming Keyboard").map(|m| m.driver), Some("mk-atk-kb"));
        assert_eq!(find_for(&id(0x5088), 32, 32, 0, "VGN S9"), None, "a name not listed: nothing asked");
        let v = model("mk-vgn-kb", 0x5088);
        let mut f = fake(v);
        f.replies.push_back(vec![report(0x04, 32, &[(1, 0x01), (3, 0x1A), (4, 0x06), (8, 93), (9, 0)])]);
        assert_eq!(read1(&mut f, v), at(pctl(93), Charging::No));
        assert_eq!(f.sent, vec![KB_VGN.to_vec()]);
        let r = model("mk-redragon-ev", 0x226F);
        let mut f = fake(r);
        f.replies.push_back(vec![report(0x04, 32, &[(1, 0x01), (3, 0x1A), (4, 0x02), (8, 0x61), (9, 1)])]);
        assert_eq!(read1(&mut f, r), at(pctl(97), Charging::Yes));
        assert_eq!(f.sent, vec![KB_REDRAGON.to_vec()]);
        let a = model("mk-ajazz-ak992", 0x50C3);
        let mut f = fake(a);
        f.replies.push_back(vec![report(0x04, 64, &[(1, 0x01), (3, 0x1A), (8, 101), (9, 0)])]);
        assert_eq!(read1(&mut f, a), no_level(Charging::Unknown, 7), "over 100");
        assert_eq!(f.sent, vec![KB.to_vec()]);
        // (8K Nano: GetConfigData as feature report 0, the reply an input report 82.)
        let n = model("mk-atk-8k", 0x1178);
        let mut f = fake(n);
        f.replies.push_back(vec![vec![0x12, 1, 2], report(0x82, 11, &[(8, 0x80 | 66), (9, 1)])]);
        assert_eq!(read1(&mut f, n), at(pctl(66), Charging::Yes), "a DPI notification skipped");
        assert_eq!((f.sent.clone(), f.kinds.clone()), (vec![NANO_8K.to_vec()], vec![crate::allow::ReportKind::Feature]));
        let mut f = fake(n);
        f.replies.push_back(vec![report(0x82, 11, &[(8, 50), (9, 0)])]);
        assert_eq!(read1(&mut f, n), unlinked(7), "link 0: no mouse");
        let mut f = fake(n);
        f.replies.push_back(vec![report(0x82, 11, &[(8, 0), (9, 1)])]);
        assert_eq!(read1(&mut f, n), no_level(Charging::Unknown, 7));
    }
}
