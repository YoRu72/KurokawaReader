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
// D1 (the original's v1.1.0 aula.cpp, aula_mouse.cpp, aula_mouse_protocol.h at commit 7cc44f2; their references:
// HeyOkay/HaloBattery issue 325 and a fork's providers/lofree.py, Crucialjun/omarchy-aula-SC580 PROTOCOL.md):
//  - The BY request also to MCHOSE K87 / K99 receivers sold as 05AC:024F (Apple's id, which SONiX dongles use too): only
//    their own layout, interface 1, FF02:0002, 20-byte input and output (a SONiX dongle has FF60:0061 on interface 3).
//  - AULA X9 Ultra (and V9) on the «AULA-8K Dongle» (320F:22A0, interface 1, FF1C:0092, 64-byte reports): a read
//    transaction — START [04 00 00 01], battery [04 00 00 1A], END [04 00 00 02], each echoed as [04 00 00 cmd 00 00 00
//    00]; the battery reply [8] percent (0 = the receiver has none yet), [9] 0 on battery / 1 charging / 2 full. A pushed
//    [04 AA 00 AA … [8] 00] says the link is down. END is always sent once START was, so no transaction stays open.
//  - AULA SC580 / SC580X mouse (cable 088D:062E, receiver 089D:062F, FF02:0000, 33-byte reports): GetDeviceInfo
//    [00][30 00 01 00 …] (the vendor app's poll) → [30][status: 0 ok, 1 busy, 2 mouse offline, 3 data error][..][..]
//    [data 4–30][sum of 4–30]; data [8] charge state (0 battery, 1 charging, 2 full), [9] level, [10] online. Resent on
//    busy, a data error or a reply to another command, within one deadline. While charging the mouse reports a fixed
//    100: charging, level unknown. The cable and the receiver: one card by the pair rule.
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
    by(0x05AC, 0x024F, 0xFF02, "MCHOSE wireless keyboard").iface(1).input(Len::Eq(20)).output(Len::Eq(20)),
];

const fn sc(vid: u16, pid: u16, via: Via) -> Model {
    Model::new("mk-aula-sc580", vid, pid, "AULA SC580", Kind::Mouse, via).page(0xFF02).usage(0x0000).input(Len::Min(33)).output(Len::Min(33)).pair("aula:sc580")
}

/// D1's mice.
pub static MOUSE: &[Model] = &[
    Model::new("mk-aula-x9", 0x320F, 0x22A0, "AULA wireless mouse (X9 / V9)", Kind::Mouse, Via::Receiver).iface(1).page(0xFF1C).usage(0x0092).input(Len::Eq(64)).output(Len::Eq(64)).product_is("AULA-8K Dongle"),
    sc(0x088D, 0x062E, Via::Cable),
    sc(0x089D, 0x062F, Via::Receiver),
];

pub const fn x9(cmd: u8) -> [u8; 4] {
    [0x04, 0x00, 0x00, cmd]
}
pub const X9_START: [u8; 4] = x9(0x01);
pub const X9_BATTERY: [u8; 4] = x9(0x1A);
pub const X9_END: [u8; 4] = x9(0x02);
pub const SC580_INFO: [u8; 4] = [0x00, 0x30, 0x00, 0x01];

fn x9_heartbeat(r: &[u8]) -> Option<bool> {
    if r.len() >= 9 && r[0] == 4 && r[1] == 0xAA && r[2] == 0 && r[3] == 0xAA && (r[8] == 0 || r[8] == 0xFF) {
        Some(r[8] == 0)
    } else {
        None
    }
}
fn x9_is_reply(r: &[u8], cmd: u8) -> bool {
    r.len() >= 8 && r[0] == 4 && r[1] == 0 && r[2] == 0 && r[3] == cmd && r[4..8].iter().all(|&b| b == 0)
}

pub fn read_x9(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Outcome {
    let mut down = false;
    let started = out_ask(ch, &X9_START, ms(450), deadline, &mut |r| {
        if let Some(d) = x9_heartbeat(r) {
            down = d;
            return None;
        }
        Some(()).filter(|_| x9_is_reply(r, 0x01))
    });
    if started == Err(TErr::Gone) {
        return Outcome::Failed;
    }
    let mut level = None;
    if started.is_ok() {
        level = out_ask(ch, &X9_BATTERY, ms(350), deadline, &mut |r| {
            if let Some(d) = x9_heartbeat(r) {
                down = d;
                return None;
            }
            Some((r.get(8).copied().unwrap_or(0), r.get(9).copied().unwrap_or(0xFF))).filter(|_| x9_is_reply(r, 0x1A) && r.len() >= 10)
        })
        .ok();
    }
    // (The transaction is closed even when the battery reply is missing.)
    let _ = out_ask(ch, &X9_END, ms(200), deadline, &mut |r| Some(()).filter(|_| x9_is_reply(r, 0x02)));
    match level {
        _ if down => dozing(now),
        Some((p, s)) if (1..=100).contains(&p) && s <= 2 => got(pct(i64::from(p)).unwrap_or(Level::Unknown), charging(s != 0), now),
        _ => dozing(now),
    }
}

#[derive(Debug, PartialEq)]
enum Sc {
    Data(Vec<u8>),
    Offline,
    Again,
}

pub fn read_sc580(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Outcome {
    let end = deadline.min(Instant::now() + ms(1000));
    let mut last = Err(TErr::Timeout);
    while Instant::now() < end {
        last = out_ask(ch, &SC580_INFO, ms(250), end, &mut |r| {
            if r.len() < 32 || r[0] == 0xD1 || r[0] == 0xD2 {
                return None;
            }
            if r[0] != 0x30 {
                return Some(Sc::Again);
            }
            match r[1] {
                0 if r[31] == sum8(&r[4..31]) => Some(Sc::Data(r[4..31].to_vec())),
                0 => None,
                2 => Some(Sc::Offline),
                1 => {
                    pause(ms(300), end);
                    Some(Sc::Again)
                }
                _ => Some(Sc::Again),
            }
        });
        match last {
            Ok(Sc::Again) | Err(TErr::Timeout) => continue,
            _ => break,
        }
    }
    match last {
        Ok(Sc::Offline) => dozing(now),
        Ok(Sc::Data(d)) if d[10] == 0 => dozing(now),
        Ok(Sc::Data(d)) if d[9] > 100 => no_level(Charging::Unknown, now),
        // (While charging the mouse says 100 whatever its charge.)
        Ok(Sc::Data(d)) if d[8] == 1 => no_level(Charging::Yes, now),
        Ok(Sc::Data(d)) => got(pct(i64::from(d[9])).unwrap_or(Level::Unknown), Charging::No, now),
        Ok(Sc::Again) | Err(TErr::Timeout) => Outcome::NoAnswer,
        Err(e) => failed(&e),
    }
}

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
    fn v110_mice() {
        // (X9: START, battery, END — END even when the battery reply is missing.)
        let m = model("mk-aula-x9", 0x22A0);
        assert!(m.product_ok("AULA-8K Dongle") && !m.product_ok("Evision receiver"));
        let mut f = fake(m);
        f.replies.extend([vec![report(0x04, 64, &[(3, 0x01)])], vec![report(0x04, 64, &[(1, 0xAA), (3, 0xAA), (8, 0xFF)]), report(0x04, 64, &[(3, 0x1A), (8, 77), (9, 1)])], vec![report(0x04, 64, &[(3, 0x02)])]]);
        assert_eq!(read1(&mut f, m), at(pctl(77), Charging::Yes));
        assert_eq!(f.sent, vec![X9_START.to_vec(), X9_BATTERY.to_vec(), X9_END.to_vec()]);
        let mut f = fake(m);
        f.replies.extend([vec![report(0x04, 64, &[(3, 0x01)])], vec![report(0x04, 64, &[(1, 0xAA), (3, 0xAA), (8, 0)])], vec![]]);
        assert_eq!(read1(&mut f, m), dozing(7), "the link down");
        assert_eq!(f.sent.last(), Some(&X9_END.to_vec()), "the transaction closed");
        let mut f = fake(m);
        f.replies.extend([vec![report(0x04, 64, &[(3, 0x01)])], vec![report(0x04, 64, &[(3, 0x1A), (8, 0)])], vec![]]);
        assert_eq!(read1(&mut f, m), dozing(7), "0: the receiver's empty cache");
        // (SC580: busy, then the data; the checksum over data 4–30.)
        let sc = model("mk-aula-sc580", 0x062F);
        let data = |state: u8, level: u8, online: u8| {
            let mut r = report(0x30, 33, &[(4 + 8, state), (4 + 9, level), (4 + 10, online)]);
            r[31] = sum8(&r[4..31]);
            r
        };
        let mut f = fake(sc);
        f.replies.extend([vec![report(0x30, 33, &[(1, 1)])], vec![report(0xD1, 33, &[]), data(0, 88, 1)]]);
        assert_eq!(read1(&mut f, sc), at(pctl(88), Charging::No));
        assert_eq!(f.sent, vec![SC580_INFO.to_vec(), SC580_INFO.to_vec()]);
        let mut f = fake(sc);
        f.replies.push_back(vec![data(1, 100, 1)]);
        assert_eq!(read1(&mut f, sc), no_level(Charging::Yes, 7), "charging: the fixed 100 is not a level");
        let mut f = fake(sc);
        f.replies.push_back(vec![report(0x30, 33, &[(1, 2)])]);
        assert_eq!(read1(&mut f, sc), dozing(7), "the mouse offline");
        let mut f = fake(sc);
        let mut bad = data(0, 50, 1);
        bad[31] ^= 1;
        f.replies.push_back(vec![bad]);
        assert_eq!(read1(&mut f, sc), Outcome::NoAnswer, "a bad sum is no reply");
        assert_eq!(merge_pairs(&[sc, model("mk-aula-sc580", 0x062E)]), vec![vec![1, 0]]);
        // (05AC:024F: only the MCHOSE layout; the SONiX dongle's FF60 is sonix.rs's.)
        let id = |iface: i32, page: u16| HidIdent { vid: 0x05AC, pid: 0x024F, usage_page: page, usage: 2, interface: iface };
        assert_eq!(find(&id(1, 0xFF02), 20, 20, 0).map(|m| m.driver), Some("mk-aula-by"));
        assert!(find(&id(1, 0xFF02), 64, 64, 0).is_none() && find(&id(3, 0xFF02), 20, 20, 0).is_none());
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
