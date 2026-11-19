// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): AULA and MCHOSE keyboards on the «BY» receivers (3554:FA09, 3554:FB40,
// 41E4:2001), and AULA HERO 68 Air on its «8K Wireless Receiver» (372E:106C) — the latter by listening only.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/aula.cpp (SendRequest, Exchange, the HERO link) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by
// krisgfx9 and its contributors, GPL-3.0-or-later. Its references: PyFlat/Device-Battery-Info, deepan-alve/womier-l65-
// linux, ushineko/sanshoku issue 36, MCHOSE's M HUB web driver, wushuai0802/myfinder-device-battery.
//  - BY: a 20-byte vendor collection (FF02 or FF04, usage 02): output report 13 [13][4A][00 / 01][00 …][sum of the 19
//    before]; the reply a 13 frame whose command (top bit off) is 4A, not all zero after byte 3, its checksum right
//    (MCHOSE leaves it 0 in a one-packet frame): [5] level 1–100, [6] high nibble 1 = charging. Resent every 1.3 s
//    within the deadline (a dozing keyboard misses the first), byte 2 alternating 00 / 01 as the two references do.
//  - HERO 68 Air, FF60:0061: an acknowledged message session (four data frames and a trailer, each acknowledged,
//    counters in the top bits) carries the request 09 87 …; the keyboard also pushes FE 05 <level> <flags> by itself.
//    The session is not opened here (it writes frames and acknowledgements the device answers to): the pushed frame
//    (or a reply to AULA Hub's own request) is read when it comes — 20-byte data frame 09 66, type 0E, index 1, its
//    sum right.
// Changed here: the six-byte model code (command 05) M HUB reads to name an MCHOSE model is not asked (only receivers
// named generically were asked it; the name is the receiver's product string); a reply without a level is no reading.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn by(vid: u16, pid: u16, page: u16, name: &'static str) -> Model {
    Model::new("mk-aula-by", vid, pid, name, Kind::Keyboard, Via::Receiver).page(page).usage(0x0002).input(Len::Min(20)).output(Len::Min(20)).product_name()
}

pub static MODELS: &[Model] = &[
    by(0x3554, 0xFA09, 0xFF02, "AULA wireless keyboard"),
    by(0x3554, 0xFA09, 0xFF04, "AULA wireless keyboard"),
    by(0x3554, 0xFB40, 0xFF02, "AULA wireless keyboard"),
    by(0x3554, 0xFB40, 0xFF04, "AULA wireless keyboard"),
    by(0x41E4, 0x2001, 0xFF02, "MCHOSE wireless keyboard"),
    by(0x41E4, 0x2001, 0xFF04, "MCHOSE wireless keyboard"),
    Model::new("mk-aula-hero", 0x372E, 0x106C, "AULA wireless keyboard", Kind::Keyboard, Via::Receiver).page(0xFF60).usage(0x0061).input(Len::Min(20)),
];

pub const fn by_frame(packets: u8) -> [u8; 20] {
    let mut b = [0u8; 20];
    b[0] = 0x13;
    b[1] = 0x4A;
    b[2] = packets;
    b[19] = 0x13u8.wrapping_add(0x4A).wrapping_add(packets);
    b
}
pub const BY_0: [u8; 20] = by_frame(0);
pub const BY_1: [u8; 20] = by_frame(1);

fn by_reply(r: &[u8]) -> Option<(u8, u8)> {
    if r.len() < 20 || r[0] != 0x13 || r[1] & 0x7F != 0x4A || r[4..19].iter().all(|&b| b == 0) {
        return None;
    }
    let sum_ok = r[19] == sum8(&r[..19]);
    let mchose = r[19] == 0 && r[2] == 1 && r[3] == 0;
    if !sum_ok && !mchose {
        return None;
    }
    Some((r[5], r[6]))
}

pub fn read_by(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Answer {
    let mut last = Err(TErr::Timeout);
    for i in 0..3u8 {
        let req = if i % 2 == 0 { BY_0 } else { BY_1 };
        last = out_ask(ch, &req, ms(1300), deadline, &mut |r| by_reply(r));
        if last.is_ok() || last == Err(TErr::Gone) || Instant::now() >= deadline {
            break;
        }
    }
    match last {
        Ok((l, s)) if (1..=100).contains(&l) => got(pct(i64::from(l)).unwrap_or(Level::Unknown), charging(s >> 4 == 1), now).into(),
        Ok(_) => no_level(Charging::Unknown, now).into(),
        Err(e) => failed(&e).into(),
    }
}

/// A HERO 68 Air data frame carrying the level: (level, flags).
pub fn hero_frame(r: &[u8]) -> Option<(u8, u8)> {
    if r.len() < 20 || r[0] != 0x09 || r[1] != 0x66 || r[4] & 0x7F != 0x0E || r[3] & 0x7F != 1 || r[19] != sum8(&r[1..19]) {
        return None;
    }
    if r[5] == 0x87 && (1..=100).contains(&r[11]) {
        return Some((r[11], r[12]));
    }
    if r[5] == 0xFE && r[6] == 0x05 && (1..=100).contains(&r[7]) {
        return Some((r[7], r[8]));
    }
    None
}

pub fn read_hero(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Outcome {
    match listen(&mut *ch.main, Duration::from_secs(4), deadline, &mut |r| hero_frame(r)) {
        Ok(Some((l, f))) => got(pct(i64::from(l)).unwrap_or(Level::Unknown), charging(f & 0x10 != 0), now),
        Ok(None) => needs_query(now),
        Err(TErr::Gone) => Outcome::Failed,
        Err(_) => needs_query(now),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn by_receivers() {
        assert_eq!(BY_0[19], 0x5D);
        assert_eq!(BY_1[19], 0x5E);
        let m = model("mk-aula-by", 0xFA09);
        let mut ok = report(0x13, 20, &[(1, 0xCA), (5, 81), (6, 0x10)]);
        ok[19] = sum8(&ok[..19]);
        let mut f = fake(m);
        f.replies.push_back(vec![BY_0.to_vec(), ok.clone()]);
        assert_eq!(crate::mice::read(&mut Chans::one(&mut f), m, None, true, soon(), 7).out, at(pctl(81), Charging::Yes), "its own echo skipped");
        // (Unanswered, then answered on the resend with byte 2 = 01; a bad checksum is no reply.)
        let mut f = fake(m);
        let mut bad = ok.clone();
        bad[19] ^= 1;
        f.replies.extend([vec![bad], vec![ok.clone()]]);
        assert_eq!(crate::mice::read(&mut Chans::one(&mut f), m, None, true, soon(), 7).out, at(pctl(81), Charging::Yes));
        assert_eq!(f.sent, vec![BY_0.to_vec(), BY_1.to_vec()]);
        // (MCHOSE: the trailer 0 in a one-packet frame.)
        let mut mc = report(0x13, 20, &[(1, 0x4A), (2, 1), (5, 33), (6, 0x01)]);
        mc[19] = 0;
        let mut f = fake(m);
        f.replies.push_back(vec![mc]);
        assert_eq!(crate::mice::read(&mut Chans::one(&mut f), m, None, true, soon(), 7).out, at(pctl(33), Charging::No));
    }

    #[test]
    fn hero_listens_only() {
        let m = model("mk-aula-hero", 0x106C);
        let mut fr = report(0x09, 20, &[(1, 0x66), (2, 0x05), (3, 0x01), (4, 0x0E), (5, 0xFE), (6, 0x05), (7, 70), (8, 0x10)]);
        fr[19] = sum8(&fr[1..19]);
        let mut f = fake(m);
        f.stream.extend([vec![0x09, 0x66, 0, 0, 0], fr.clone()]);
        assert_eq!(read1(&mut f, m), at(pctl(70), Charging::Yes));
        assert!(f.sent.is_empty(), "no frame, no acknowledgement");
        fr[19] ^= 1;
        let mut f = fake(m);
        f.stream.push_back(fr);
        assert_eq!(read1(&mut f, m), needs_query(7), "a damaged frame: nothing; the session we do not open would ask");
    }
}
