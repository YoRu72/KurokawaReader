// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Keychron mice (VID 3434) — the Launcher protocol on their receivers and
// cables, the 1K receivers' feature report 51, and the Nape Pro trackball on the Link-KM receiver or its cable.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/keychron.cpp (Query, PollNape, Name4k, LegacyName, PollLegacy, PollKeychron) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later. Its references:
// Keychron's Launcher (launcher.keychron.com), nvalis/nape_pro, gtun/KeychronNapeBatteryWidget, ky0209/NapeBar.
//  - Launcher (a vendor collection with 65-byte input and output): unnumbered 64 bytes [cmd][00][81][sub][00 …]
//    [A1 − the sum of bytes 0–62]; 01 00 81 01 → [01][..][..][01][state][rate][vid lo][vid hi][pid…][charging][percent]
//    (the mouse's own vendor id: a genuine reply); 41 00 81 01 (bit 6: ask the mouse over the receiver) → the 8K
//    layout [10] state (1 charging), [11] percent, or on the 4K Link (FF0A:0001) [5] state, [6] percent;
//    40 00 81 00 → the 4K Link's paired mouse's product id at [4..5] (its name).
//  - 1K receivers D030 / D031 (page 8C): feature report 51 [51][06] → [51][06][01 ok][00][vid][pid][..][..][..]
//    [percent][charging].
//  - Nape Pro on the Link-KM (D026) or its cable (0440), FF60:0061, unnumbered 32 bytes: B2 → the receiver's slots
//    (at 2 / 7 / 12: vid, pid, status 1 = connected); A7 31 → [A7][31][percent][charging].
// D1 (the original's v1.1.0 keychron.cpp at commit 7cc44f2; its reference: launcher.keychron.com main.js): mice on the
// Ultra-Link 8K receiver (3434:D028), the Launcher's «8k» protocol on FFC1:0001 (numbered 64-byte reports): report B5
// [03] asks the receiver for its slots ([B5][03] then vid LE16, pid LE16, status at 3 / 8 / 13; not 0 = connected), report
// B3 [06] the mouse's base info, whose byte 20 is the power byte: bits 0–6 percent, bit 7 charging. Read only.
// Not ported: v1.1.0's Keychron keyboards on the Link receiver or their cable (B2, then A4): A4 is answered only by a
// community firmware patch (KC_GET_BATTERY); on stock firmware the id is in Keychron's own command range, its meaning
// not documented — not sent.
// Changed here: products by id — the original sent the Launcher request to every 3434 product with such a collection
// (Keychron keyboards among them); here the receivers and mice its sources name. Nothing else.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn launcher(pid: u16, name: &'static str, via: Via) -> Model {
    Model::new("mk-keychron", 0x3434, pid, name, Kind::Mouse, via).vendor_page().input(Len::Eq(65)).output(Len::Eq(65)).product_name()
}

/// arg: 0 Launcher, 1 the 1K receivers' report 51, 2 Nape Pro.
pub static MODELS: &[Model] = &[
    launcher(0xD038, "Keychron mouse", Via::Receiver),
    Model::new("mk-keychron", 0x3434, 0xD030, "Keychron mouse", Kind::Mouse, Via::Receiver).page(0x008C).feature(Len::Min(16)).arg(1),
    Model::new("mk-keychron", 0x3434, 0xD031, "Keychron mouse", Kind::Mouse, Via::Receiver).page(0x008C).feature(Len::Min(16)).arg(1),
    Model::new("mk-keychron", 0x3434, 0xD026, "Keychron Nape Pro", Kind::Mouse, Via::Receiver).page(0xFF60).usage(0x0061).output(Len::Eq(33)).arg(2).pair("kc:nape"),
    Model::new("mk-keychron", 0x3434, 0x0440, "Keychron Nape Pro", Kind::Mouse, Via::Cable).page(0xFF60).usage(0x0061).output(Len::Eq(33)).arg(2).pair("kc:nape"),
    Model::new("mk-keychron-ul", 0x3434, 0xD028, "Keychron mouse", Kind::Mouse, Via::Receiver).page(0xFFC1).usage(0x0001).input(Len::Min(21)).output(Len::Min(21)).product_name(),
];

pub const ULTRA_SLOTS: [u8; 2] = [0xB5, 0x03];
pub const ULTRA_INFO: [u8; 2] = [0xB3, 0x06];

pub fn read_ultra(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Outcome {
    let slots = out_ask(ch, &ULTRA_SLOTS, ms(600), deadline, &mut |r| if r.len() >= 21 && r[1] == 0x03 { Some(r.to_vec()) } else { None });
    match slots {
        Ok(r) => {
            if ![3usize, 8, 13].iter().any(|&o| (r[o] | r[o + 1]) != 0 && r[o + 4] != 0) {
                return unlinked(now);
            }
        }
        Err(e) => return failed(&e),
    }
    match out_ask(ch, &ULTRA_INFO, ms(600), deadline, &mut |r| if r.len() >= 21 && r[1] == 0x06 { Some(r[20]) } else { None }) {
        Ok(p) => match pct(i64::from(p & 0x7F)) {
            Some(l) if p & 0x7F >= 1 => got(l, charging(p & 0x80 != 0), now),
            _ => no_level(Charging::Unknown, now),
        },
        Err(TErr::Gone) => Outcome::Failed,
        Err(_) => dozing(now),
    }
}

pub const fn frame(cmd: u8, sub: u8) -> [u8; 65] {
    let mut b = [0u8; 65];
    b[1] = cmd;
    b[3] = 0x81;
    b[4] = sub;
    b[64] = 0xA1u8.wrapping_sub(cmd.wrapping_add(0x81).wrapping_add(sub));
    b
}
pub static Q01: [u8; 65] = frame(0x01, 0x01);
pub static Q41: [u8; 65] = frame(0x41, 0x01);
pub static Q40: [u8; 65] = frame(0x40, 0x00);
pub const LEGACY: [u8; 2] = [0x51, 0x06];
pub const NAPE_SLOTS: [u8; 2] = [0x00, 0xB2];
pub const NAPE_BATTERY: [u8; 3] = [0x00, 0xA7, 0x31];

fn name_4k(pid: u16) -> Option<&'static str> {
    match pid {
        0x0620 | 0x0622 => Some("Keychron M3 mini 4K"),
        0x0621 => Some("Keychron M4 4K"),
        0x0624 => Some("Keychron M6 4K"),
        0x07A0 => Some("Keychron M3 4K"),
        _ => None,
    }
}
fn legacy_name(pid: u16) -> &'static str {
    match pid {
        0xD032 | 0xD033 => "Keychron M3",
        0xD035 => "Keychron M1",
        0xD036 | 0xD03E => "Keychron M3 mini",
        0xD03B => "Keychron M2",
        0xD03D => "Keychron M2 mini",
        0xD03F => "Keychron M6",
        0xD044 => "Keychron M7",
        _ => "Keychron mouse",
    }
}

fn q(ch: &mut Chans, req: &[u8], deadline: Instant) -> Result<Vec<u8>, TErr> {
    let (cmd, sub) = (req[1], req[4]);
    out_ask(ch, req, ms(600), deadline, &mut |r| if r.len() >= 13 && r[0] == cmd && r[3] == sub { Some(r.to_vec()) } else { None })
}

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Answer {
    match m.arg {
        1 => {
            let r = feat_ask(&mut *ch.main, &LEGACY, 0x51, 16, ms(40), 5, deadline, &mut |r| if r.len() >= 13 && r[0] == 0x51 && r[1] == 0x06 { Some(r.to_vec()) } else { None });
            match r {
                Ok(r) if r[2] == 0x01 && u16::from(r[4]) | u16::from(r[5]) << 8 == 0x3434 && r[11] <= 100 => {
                    let mpid = u16::from(r[6]) | u16::from(r[7]) << 8;
                    let mut a: Answer = got(pct(i64::from(r[11])).unwrap_or(Level::Unknown), charging(r[12] == 0x01), now).into();
                    a.name = Some(legacy_name(mpid).to_string());
                    a
                }
                Ok(_) => unlinked(now).into(),
                Err(e) => failed(&e).into(),
            }
        }
        2 => {
            if m.via == Via::Receiver {
                let slots = out_ask(ch, &NAPE_SLOTS, ms(600), deadline, &mut |r| if r.len() >= 17 && r[0] == 0xB2 { Some(r.to_vec()) } else { None });
                match slots {
                    Ok(r) => {
                        let linked = [2usize, 7, 12].iter().any(|&o| (u16::from(r[o + 2]) << 8 | u16::from(r[o + 3])) == 0x4004 && r[o + 4] == 1);
                        if !linked {
                            return unlinked(now).into();
                        }
                    }
                    Err(e) => return failed(&e).into(),
                }
            }
            match out_ask(ch, &NAPE_BATTERY, ms(600), deadline, &mut |r| if r.len() >= 4 && r[0] == 0xA7 && r[1] == 0x31 { Some((r[2], r[3])) } else { None }) {
                Ok((p, c)) if p <= 100 => got(pct(i64::from(p)).unwrap_or(Level::Unknown), charging(c != 0), now).into(),
                Ok(_) => no_level(Charging::Unknown, now).into(),
                Err(e) => failed(&e).into(),
            }
        }
        _ => {
            let r1 = q(ch, &Q01, deadline);
            if let Err(TErr::Gone) = r1 {
                return Outcome::Failed.into();
            }
            let r1 = r1.ok();
            let tag = r1.as_ref().map_or(0, |r| u16::from(r[6]) | u16::from(r[7]) << 8);
            let link4k = ch.main.ident().usage_page == 0xFF0A && ch.main.ident().usage == 0x0001;
            if r1.is_some() && link4k && tag != 0x3434 && tag != 0x362D {
                // (A 4K mouse on the 4K Link.)
                return match q(ch, &Q41, deadline) {
                    Ok(r) if (1..=100).contains(&r[6]) => {
                        let mut a: Answer = got(pct(i64::from(r[6])).unwrap_or(Level::Unknown), charging(r[5] != 0), now).into();
                        if let Ok(st) = q(ch, &Q40, deadline) {
                            a.name = name_4k(u16::from(st[4]) | u16::from(st[5]) << 8).map(str::to_string);
                        }
                        a
                    }
                    Ok(_) => unlinked(now).into(),
                    Err(e) => failed(&e).into(),
                };
            }
            if let Some(r) = &r1 {
                if tag == 0x3434 && r[11] <= 100 {
                    return got(pct(i64::from(r[11])).unwrap_or(Level::Unknown), charging(r[10] != 0), now).into();
                }
            }
            if let Ok(r) = q(ch, &Q41, deadline) {
                if r[10] <= 3 && r[11] <= 100 {
                    return got(pct(i64::from(r[11])).unwrap_or(Level::Unknown), charging(r[10] == 1), now).into();
                }
            }
            if let Some(r) = &r1 {
                // (An 8K mouse on its cable: no bit 6; [5] its highest polling-rate level.)
                if r[10] <= 3 && (1..=100).contains(&r[11]) && (1..=8).contains(&r[5]) {
                    return got(pct(i64::from(r[11])).unwrap_or(Level::Unknown), charging(r[10] == 1), now).into();
                }
            }
            Outcome::NoAnswer.into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn keychron() {
        assert_eq!(sum8(&Q01[1..65]), 0xA1, "the checksum: the 64 bytes sum to A1");
        assert_eq!(sum8(&Q41[1..65]), 0xA1);
        let m = model("mk-keychron", 0xD038);
        let mut f = fake(m);
        f.replies.push_back(vec![report(0x00, 65, &[(1, 0x01), (4, 0x01), (7, 0x34), (8, 0x34), (11, 1), (12, 70)])]);
        assert_eq!(read1(&mut f, m).clone(), at(pctl(70), Charging::Yes), "the classic reply: its vendor id");
        assert_eq!(f.sent, vec![Q01.to_vec()]);
        let l = model("mk-keychron", 0xD030);
        let mut f = fake(l);
        f.feature_replies.push_back(report(0x51, 16, &[(1, 0x06), (2, 1), (4, 0x34), (5, 0x34), (6, 0x33), (7, 0xD0), (11, 39), (12, 0)]));
        let a = crate::mice::read(&mut Chans::one(&mut f), l, None, true, soon(), 7);
        assert_eq!((a.out, a.name.as_deref()), (at(pctl(39), Charging::No), Some("Keychron M3")));
        let n = model("mk-keychron", 0xD026);
        let mut f = fake(n);
        let mut slots = report(0x00, 33, &[(1, 0xB2)]);
        // (Slot at 7: vid BE16, pid 4004 BE16, status 1.)
        slots[1 + 9] = 0x40;
        slots[1 + 10] = 0x04;
        slots[1 + 11] = 1;
        f.replies.extend([vec![slots], vec![report(0x00, 33, &[(1, 0xA7), (2, 0x31), (3, 55), (4, 1)])]]);
        assert_eq!(read1(&mut f, n), at(pctl(55), Charging::Yes));
        assert_eq!(f.sent, vec![NAPE_SLOTS.to_vec(), NAPE_BATTERY.to_vec()]);
        let mut f = fake(n);
        f.replies.push_back(vec![report(0x00, 33, &[(1, 0xB2)])]);
        assert_eq!(read1(&mut f, n), unlinked(7));
    }

    #[test]
    fn v110_ultra_link() {
        let m = model("mk-keychron-ul", 0xD028);
        let mut f = fake(m);
        f.replies.extend([vec![report(0xB5, 64, &[(1, 0x03), (8, 0x34), (9, 0x34), (12, 1)])], vec![report(0xB3, 64, &[(1, 0x06), (20, 0x80 | 62)])]]);
        assert_eq!(read1(&mut f, m), at(pctl(62), Charging::Yes));
        assert_eq!(f.sent, vec![ULTRA_SLOTS.to_vec(), ULTRA_INFO.to_vec()]);
        let mut f = fake(m);
        f.replies.push_back(vec![report(0xB5, 64, &[(1, 0x03), (3, 0x34), (4, 0x34)])]);
        assert_eq!(read1(&mut f, m), unlinked(7), "a slot without its connected status");
        assert_eq!(f.sent.len(), 1);
    }
}
