// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): MCHOSE mice — the L7 / M7 / A7 / K7 families (5253:1020, and the
// Realtek ODM dongles 3837: 100C, 100B, 100A, 1001, 1012), the G3 V2 (3837: 4245 receiver, 418C cable), and the «new»
// Nordic mice' receivers (3837: 1014, 1018, 1016, 102C, 102D). The MCHOSE headset (mchose_headset.cpp) is the headset
// piece's; MCHOSE keyboards on the BY receivers are aula.rs's.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/mchose.cpp, mchose_g3.cpp, mchose_modern.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by
// krisgfx9 and its contributors, GPL-3.0-or-later. Their references: alexfrih/mchose-linux, Jstdi001/MCHOSE-Monitor,
// MCHOSE's M HUB web driver, HifumiDaisuki01/MchoseBatteryTray.
//  - arg 0: FF01:0001, 65-byte feature report 12 with EVERY payload byte inverted: [12][F9][FF …]; read back:
//    [12][F9][payload ^ FF]: vid (5253; 41E4 or 3837 on the 3837 dongles), model, firmware, [8] flags, [9] level,
//    [10] charging; an all-zero payload: the mouse asleep.
//  - arg 1 (G3 V2): FF01:0010, output 00 55 30 A5 0B 2E 01 01 01 → [AA][30]…[8] percent 1–100 [9] charging.
//  - arg 2 (new mice): FF01 / FF0B, output report 4D [4D][01][01 read][00 len][00 09 = device info][00][00][xor 2–7];
//    reply 4D, the same command, len data bytes and their xor: data [0..1] 3837, [10] link (0 not linked),
//    [11] charging, [12] percent; len < 14 (the header and one FF): the mouse off.
// Changed here: products by id (the original asked every 5253 product); the request's length fixed at 65 bytes (the
// original sized it to the collection: another length is another collection here).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn inv(vid: u16, pid: u16) -> Model {
    Model::new("mk-mchose", vid, pid, "MCHOSE mouse", Kind::Mouse, Via::Receiver).page(0xFF01).usage(0x0001).feature(Len::Eq(65)).product_name()
}
const fn g3(pid: u16, via: Via) -> Model {
    Model::new("mk-mchose", 0x3837, pid, "MCHOSE G3 V2", Kind::Mouse, via).page(0xFF01).usage(0x0010).output(Len::Min(65)).input(Len::Min(65)).arg(1).pair("mc:g3v2")
}
const fn modern(pid: u16, page: u16) -> Model {
    Model::new("mk-mchose", 0x3837, pid, "MCHOSE mouse", Kind::Mouse, Via::Receiver).page(page).output(Len::Min(64)).input(Len::Min(21)).arg(2).product_name()
}

pub static MODELS: &[Model] = &[
    inv(0x5253, 0x1020),
    inv(0x3837, 0x100C),
    inv(0x3837, 0x100B),
    inv(0x3837, 0x100A),
    inv(0x3837, 0x1001),
    inv(0x3837, 0x1012),
    g3(0x4245, Via::Receiver),
    g3(0x418C, Via::Cable),
    modern(0x1014, 0xFF01),
    modern(0x1014, 0xFF0B),
    modern(0x1018, 0xFF01),
    modern(0x1018, 0xFF0B),
    modern(0x1016, 0xFF01),
    modern(0x1016, 0xFF0B),
    modern(0x102C, 0xFF01),
    modern(0x102C, 0xFF0B),
    modern(0x102D, 0xFF01),
    modern(0x102D, 0xFF0B),
];

pub const fn inverted() -> [u8; 65] {
    let mut b = [0xFFu8; 65];
    b[0] = 0x12;
    b[1] = 0x06 ^ 0xFF;
    b
}
pub static INVERTED: [u8; 65] = inverted();
pub const G3: [u8; 11] = [0x00, 0x55, 0x30, 0xA5, 0x0B, 0x2E, 0x01, 0x01, 0x01, 0x00, 0x00];
pub const MODERN: [u8; 9] = [0x4D, 0x01, 0x01, 0x00, 0x00, 0x09, 0x00, 0x00, 0x08];

fn xor(b: &[u8]) -> u8 {
    b.iter().fold(0, |a, &x| a ^ x)
}

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    match m.arg {
        1 => match out_ask(ch, &G3, ms(1000), deadline, &mut |r| if r.len() >= 10 && r[0] == 0xAA && r[1] == 0x30 { Some((r[8], r[9])) } else { None }) {
            Ok((p, c)) if (1..=100).contains(&p) => got(pct(i64::from(p)).unwrap_or(Level::Unknown), charging(c == 1), now),
            Ok(_) => no_level(Charging::Unknown, now),
            Err(e) => failed(&e),
        },
        2 => {
            let parse = |r: &[u8]| -> Option<Option<(u8, u8)>> {
                if r.len() < 10 || r[0] != 0x4D || r[4] != 0x00 || r[5] != 0x09 {
                    return None;
                }
                let len = usize::from(r[3]);
                if 8 + len >= r.len() {
                    return None;
                }
                if len < 14 {
                    return Some(None);
                }
                if r[8 + len] != xor(&r[2..8 + len]) || (u16::from(r[8]) | u16::from(r[9]) << 8) != 0x3837 {
                    return None;
                }
                if r[18] == 0 {
                    return Some(None);
                }
                Some(Some((r[20], r[19])))
            };
            let mut last = Err(TErr::Timeout);
            for _ in 0..3 {
                last = out_ask(ch, &MODERN, ms(1000), deadline, &mut |r| parse(r));
                if last.is_ok() || last == Err(TErr::Gone) {
                    break;
                }
            }
            match last {
                Ok(Some((p, c))) if p <= 100 => got(pct(i64::from(p)).unwrap_or(Level::Unknown), charging(c == 1), now),
                Ok(Some(_)) => no_level(Charging::Unknown, now),
                Ok(None) => dozing(now),
                Err(e) => failed(&e),
            }
        }
        _ => {
            let (vf, alt) = if m.vid == 0x3837 { (0x41E4u16, 0x3837u16) } else { (0x5253, 0x5253) };
            let mut state: Option<Option<(u8, u8)>> = None;
            for attempt in 0..5 {
                if attempt > 0 {
                    pause(Duration::from_millis(100), deadline);
                }
                let r = feat_ask(&mut *ch.main, &INVERTED, 0x12, 65, ms(120), 1, deadline, &mut |r| {
                    if r.len() < 13 || r[0] != 0x12 || r[1] != 0xF9 {
                        return None;
                    }
                    let p: Vec<u8> = r[2..13].iter().map(|b| b ^ 0xFF).collect();
                    if p.iter().all(|&b| b == 0) {
                        return Some(None);
                    }
                    let field = u16::from(p[0]) | u16::from(p[1]) << 8;
                    if field != vf && field != alt || p[9] > 100 {
                        return None;
                    }
                    Some(Some((p[9], p[10])))
                });
                match r {
                    Ok(Some(v)) => {
                        state = Some(Some(v));
                        break;
                    }
                    Ok(None) => state = Some(None),
                    Err(TErr::Gone) => return Outcome::Failed,
                    Err(TErr::Timeout) => break,
                    Err(_) => {}
                }
            }
            match state {
                Some(Some((l, c))) => got(pct(i64::from(l)).unwrap_or(Level::Unknown), charging(c != 0), now),
                Some(None) => dozing(now),
                None => Outcome::NoAnswer,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn mchose() {
        assert!(INVERTED[2..].iter().all(|&b| b == 0xFF) && INVERTED[1] == 0xF9);
        let m = model("mk-mchose", 0x1020);
        let mut r = vec![0xFFu8; 65];
        r[0] = 0x12;
        r[1] = 0xF9;
        let plain = [0x53u8, 0x52, 0x20, 0x10, 1, 0, 0, 0, 0x09, 64, 1];
        for (i, b) in plain.iter().enumerate() {
            r[2 + i] = b ^ 0xFF;
        }
        let mut f = fake(m);
        f.feature_replies.push_back(r);
        assert_eq!(read1(&mut f, m), at(pctl(64), Charging::Yes));
        assert_eq!(f.sent, vec![INVERTED.to_vec()]);
        let mut asleep = vec![0xFFu8; 65];
        asleep[0] = 0x12;
        asleep[1] = 0xF9;
        let mut f = fake(m);
        f.features.insert(0x12, asleep);
        assert_eq!(read1(&mut f, m), dozing(7), "an all-zero payload: asleep");
        let g = model("mk-mchose", 0x4245);
        let mut f = fake(g);
        f.replies.push_back(vec![report(0x00, 65, &[(1, 0xAA), (2, 0x30), (9, 52), (10, 0)])]);
        assert_eq!(read1(&mut f, g), at(pctl(52), Charging::No));
        let n = all_models().find(|x| x.pid == 0x1014 && x.page == Page::Is(0xFF01)).unwrap();
        let mut rep = report(0x4D, 64, &[(1, 0x01), (2, 0x01), (3, 14), (5, 0x09), (8, 0x37), (9, 0x38), (18, 1), (19, 0), (20, 29)]);
        rep[22] = xor(&rep[2..22]);
        let mut f = fake(n);
        f.replies.push_back(vec![rep]);
        assert_eq!(read1(&mut f, n), at(pctl(29), Charging::No), "29 %, as M HUB showed");
        assert_eq!(f.sent, vec![MODERN.to_vec()]);
        let mut f = fake(n);
        f.replies.push_back(vec![report(0x4D, 64, &[(1, 0x01), (2, 0x01), (3, 1), (5, 0x09), (8, 0xFF)])]);
        assert_eq!(read1(&mut f, n), dozing(7), "the header and one FF: the mouse off");
    }
}
