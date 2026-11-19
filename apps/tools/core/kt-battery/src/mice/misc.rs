// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): smaller mouse brands — Motospeed X6, the Xenta receivers (Delux M900
// Pro, Attack Shark, ARDOR GAMING Fury V2), Delux M800 Pro, AJAZZ AJ139 V2, Incott G23 V2 / G24 and Wraith W1.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/misc_mice.cpp (PollMotospeed, PollXenta, PollDeluxM800, PollAjazzAj139, PollWraithW1, PollIncott),
// xenta_protocol.cpp / .h (ParseBatteryReport) and ardor_fury_v2_protocol.h (ArdorFuryV2Percent) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later. Their references:
// Jacobz888/LGSTrayBattery-MotospeedX6, AeonArcHQ/omarchy-delux-m900, qu1ncky/BatteryTray, werquess/ajazz-aj139-macos,
// nico2525nn/AjazzAJ139V2, OmarK6/Incott-Manager, HeHaoren/incott-mouse-app, FelixNg21/MouseBattery, the Wraith web
// driver (w1.software).
//  - Motospeed X6 (0BDA: FFE0, FFF2 receivers; interface 4): output B5 06 → report B4, [20] level (+128 charging).
//  - Xenta (1D57: FA60, FA65 receivers; FA55, 2155 cables; page 000A): nothing sent — the receiver pushes
//    [03][model][40 | 41][state][level] every ~2 s; state 1 on battery, 2 full, 3 charging (level frozen). A level
//    counts once two frames agree (every link-up starts with a false 100 %). ARDOR Fury V2 (FA60, model 00): its tier
//    in the high nibble of [3] (1, 3, 7, F → 1–4 of 4 steps; the original: 25/50/75/100 %).
//  - Delux M800 Pro (248A: 5B2F receiver, 5B2E cable; FF00:0001, 33-byte feature report 0C): [0C][01][20][00][seq]
//    → [18] percent, [19] 0 discharging, 1 charging, 2 full; [6] 0 from the receiver: not linked yet (asked once more).
//  - AJAZZ AJ139 V2 (A8A5 dongle, A8A4 cable, product 2255; FF01:0010): output [00][55][30][A5][2E][2E] or
//    [00][55][30][A5][0B][2E][01][01] → [AA][30]… [8] percent, [9] on USB power.
//  - Incott / Wraith W1 (093A: 522C dongle, 622C cable; FF05, 9-byte feature report 09): [09][8F] device info →
//    [3] the model (18 W1, 20 W1 Freestyle, others Incott); an Incott: [09][89] status → [2] percent | charging << 7.
// Not ported (the requests are not status reads, or the products are not known by id):
//  - Wraith W1's status: the original swept the per-button mapping read (86) over five buttons and repeated it as a
//    700 ms keep-alive to make the mouse push its status — not a status read; here the W1 is listened to (its status
//    input report 09) after the device-info read, else «needs a query we do not send».
//  - AJAZZ AJ179 (any 249A / 248A product with a 33-byte interface 2) and the AJ-series on 3151 (its F7 «brings the
//    2.4 GHz link up»): no product ids in the original's sources (it asked whole vendors), and F7 wakes a link.
//  - Motospeed's cable (FFF1): nothing to read (the original showed «charging» for it).
// Changed here: products by id only; no values kept across rounds (the original's g_xenta listeners, the ARDOR tier
// kept for 45 s, s_deluxSeq and the W1's knownModel, all globals): two agreeing frames within one listening window, the
// Delux sequence number from the clock; the ARDOR level as its four steps.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

pub const MOTOSPEED: [u8; 2] = [0xB5, 0x06];
pub const AJ139_A: [u8; 6] = [0x00, 0x55, 0x30, 0xA5, 0x2E, 0x2E];
pub const AJ139_B: [u8; 8] = [0x00, 0x55, 0x30, 0xA5, 0x0B, 0x2E, 0x01, 0x01];
pub const INCOTT_INFO: [u8; 2] = [0x09, 0x8F];
pub const INCOTT_STATUS: [u8; 2] = [0x09, 0x89];

/// Delux M800's status query with sequence number `seq` (1–127), 33 bytes.
pub const fn delux_query(seq: u8) -> [u8; 33] {
    let mut b = [0u8; 33];
    b[0] = 0x0C;
    b[1] = 0x01;
    b[2] = 0x20;
    b[4] = seq;
    b
}
pub const DELUX_PATTERN: [crate::allow::B; 33] = {
    use crate::allow::B;
    let mut p = [B::Is(0); 33];
    p[0] = B::Is(0x0C);
    p[1] = B::Is(0x01);
    p[2] = B::Is(0x20);
    p[4] = B::In(0x01, 0x7F);
    p
};

const fn moto(pid: u16) -> Model {
    Model::new("mk-motospeed", 0x0BDA, pid, "Motospeed X6", Kind::Mouse, Via::Receiver).iface(4).output(Len::Min(21))
}
const fn xenta(pid: u16, via: Via) -> Model {
    Model::new("mk-xenta", 0x1D57, pid, "Wireless mouse", Kind::Mouse, via).page(0x000A).input(Len::Min(5))
}
const fn delux(pid: u16, via: Via) -> Model {
    Model::new("mk-delux", 0x248A, pid, "Delux M800 Pro", Kind::Mouse, via).page(0xFF00).usage(0x0001).feature(Len::Eq(33)).pair("dx:m800")
}
const fn aj(vid: u16, via: Via) -> Model {
    Model::new("mk-ajazz", vid, 0x2255, "AJAZZ wireless mouse", Kind::Mouse, via).page(0xFF01).usage(0x0010).output(Len::Min(65)).input(Len::Min(65))
}
const fn pix(pid: u16, via: Via) -> Model {
    Model::new("mk-incott", 0x093A, pid, "Incott mouse", Kind::Mouse, via).page(0xFF05).feature(Len::Min(9))
}

pub static MODELS: &[Model] = &[
    moto(0xFFE0),
    moto(0xFFF2),
    xenta(0xFA60, Via::Receiver),
    xenta(0xFA65, Via::Receiver),
    xenta(0xFA55, Via::Cable),
    xenta(0x2155, Via::Cable),
    delux(0x5B2F, Via::Receiver),
    delux(0x5B2E, Via::Cable),
    aj(0xA8A5, Via::Receiver),
    aj(0xA8A4, Via::Cable),
    pix(0x522C, Via::Receiver),
    pix(0x622C, Via::Cable),
];

// ---- Motospeed ----

fn motospeed(ch: &mut Chans, deadline: Instant, now: u64) -> Outcome {
    match out_ask(ch, &MOTOSPEED, ms(1500), deadline, &mut |r| if r.len() > 20 && r[0] == 0xB4 { Some(r[20]) } else { None }) {
        Ok(raw) => {
            let c = raw >= 128;
            match pct(i64::from(raw & 0x7F)) {
                Some(l) => got(l, charging(c), now),
                None => no_level(charging(c), now),
            }
        }
        Err(e) => failed(&e),
    }
}

// ---- Xenta (passive) ----

/// A Xenta frame (the report id 03 first): (model, state, level).
pub fn xenta_frame(r: &[u8]) -> Option<(u8, u8, u8)> {
    if r.len() < 5 || r[0] != 0x03 || (r[2] != 0x40 && r[2] != 0x41) {
        return None;
    }
    Some((r[1], r[3], r[4]))
}

/// ARDOR Fury V2's tier (1–4 of 4), from a frame of the FA60 receiver.
pub fn ardor_tier(r: &[u8]) -> Option<i64> {
    if r.len() < 5 || r[0] != 0x03 || r[1] != 0x00 || r[2] != 0x40 || r[3] & 0x0F != 0x03 {
        return None;
    }
    match r[3] >> 4 {
        0x1 => Some(1),
        0x3 => Some(2),
        0x7 => Some(3),
        0xF => Some(4),
        _ => None,
    }
}

/// The model's name and whether its level is in tens (0–10).
pub fn xenta_model(code: u8) -> Option<(&'static str, bool)> {
    match code {
        // (D1, v1.1.0: Inphic HUB's own model table — a unit sold as IN10 MAX reported 73, «IN10RMax» there.)
        0x73 => Some(("Inphic IN10R MAX", false)),
        0x74 => Some(("Inphic IN10 MAX", false)),
        0x3D | 0x30 | 0x50 => Some(("Delux M900 Pro", false)),
        0x55 => Some(("Attack Shark X11", false)),
        0x4E => Some(("Attack Shark X3 Max", false)),
        0xE5 => Some(("Attack Shark V3 Pro", false)),
        0x24 => Some(("Attack Shark V6", false)),
        0x10 => Some(("Attack Shark X6 / R1", true)),
        _ => None,
    }
}

/// What a frame (and the one before it, for agreement) says: Some(answer) when it is enough.
fn xenta_says(m: &Model, prev: Option<&[u8]>, r: &[u8], now: u64) -> Option<Answer> {
    let (code, st, level) = xenta_frame(r)?;
    let agreed = prev.map_or(false, |p| p.len() >= 5 && p[..5] == r[..5]);
    let cable = m.via == Via::Cable;
    let named = |out: Outcome, name: Option<&str>| Answer { out, slots: None, name: name.map(str::to_string), kind: None, unit: None };
    if m.pid == 0xFA60 && !cable {
        if let Some(t) = ardor_tier(r) {
            let same = prev.and_then(ardor_tier) == Some(t);
            return if same { Some(named(got(steps(t, 4).unwrap_or(Level::Unknown), Charging::Unknown, now), Some("ARDOR GAMING Fury V2"))) } else { None };
        }
    }
    let model = xenta_model(code);
    let name = model.map(|x| x.0);
    let delux = m.pid == 0xFA65 && (code == 0x30 || code == 0x50);
    if delux {
        return match st {
            0x02 => Some(named(got(pctl_or_unknown(100), Charging::Unknown, now), name)),
            0x03 => Some(named(got(pct(i64::from(level)).unwrap_or(Level::Unknown), Charging::Yes, now), name)),
            0x01 if agreed && (1..=100).contains(&level) => Some(named(got(pctl_or_unknown(i64::from(level)), Charging::No, now), name)),
            _ => None,
        };
    }
    if cable || st == 0x02 || st == 0x03 {
        // (On external power the level is frozen: charging, no level — full when it says so.)
        let l = if st == 0x02 && !cable { pctl_or_unknown(100) } else { Level::Unknown };
        return Some(named(got(l, Charging::Yes, now), name));
    }
    if !agreed {
        return None;
    }
    match model {
        Some((_, true)) if (1..=10).contains(&level) => Some(named(got(steps(i64::from(level), 10).unwrap_or(Level::Unknown), Charging::No, now), name)),
        Some((_, true)) => None,
        _ if st == 0x01 && (1..=100).contains(&level) => Some(named(got(pctl_or_unknown(i64::from(level)), Charging::No, now), name)),
        _ => None,
    }
}

fn pctl_or_unknown(v: i64) -> Level {
    pct(v).unwrap_or(Level::Unknown)
}

pub const XENTA_WINDOW: u64 = 4500;

fn xenta_listen(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Answer {
    let mut prev: Option<Vec<u8>> = None;
    let mut seen = false;
    let r = listen(&mut *ch.main, ms(XENTA_WINDOW), deadline, &mut |r| {
        if xenta_frame(r).is_none() {
            return None;
        }
        seen = true;
        let a = xenta_says(m, prev.as_deref(), r, now);
        prev = Some(r[..5].to_vec());
        a
    });
    match r {
        Ok(Some(a)) => a,
        // (Frames that never agreed, or another device's frames: a mouse asleep or changing state.)
        Ok(None) if seen => dozing(now).into(),
        Ok(None) => no_level(Charging::Unknown, now).into(),
        Err(TErr::Gone) => Outcome::Failed.into(),
        Err(_) if m.via == Via::Receiver => unlinked(now).into(),
        Err(_) => Outcome::NoAnswer.into(),
    }
}

// ---- Delux M800 Pro ----

/// The sequence number for this round (the dongle wants it to change from one query to the next): from the clock.
pub fn delux_seq(now: u64, k: u64) -> u8 {
    (((now / 1000 + k) % 127) + 1) as u8
}

fn delux_read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    let parse = |r: &[u8]| if r.len() >= 20 && r[0] == 0x0C && r[2] == 0x20 { Some(r[..20].to_vec()) } else { None };
    let mut r = match feat_ask(&mut *ch.main, &delux_query(delux_seq(now, 0)), 0x0C, 33, ms(20), 2, deadline, &mut |r| parse(r)) {
        Ok(r) => r,
        Err(e) => return failed(&e),
    };
    let receiver = m.via == Via::Receiver;
    if receiver && r[6] == 0 {
        if let Ok(r2) = feat_ask(&mut *ch.main, &delux_query(delux_seq(now, 1)), 0x0C, 33, ms(20), 2, deadline, &mut |r| parse(r)) {
            r = r2;
        }
    }
    let (p, st) = (r[18], r[19]);
    if p > 100 {
        return no_level(Charging::Unknown, now);
    }
    let linked = r[6] != 0 || p > 0;
    match st {
        2 => got(pctl_or_unknown(100), Charging::Yes, now),
        1 if linked && p > 0 => got(pctl_or_unknown(i64::from(p)), Charging::Yes, now),
        1 => no_level(Charging::Yes, now),
        _ if linked && p > 0 => got(pctl_or_unknown(i64::from(p)), Charging::No, now),
        _ if receiver => unlinked(now),
        _ => no_level(Charging::Unknown, now),
    }
}

// ---- AJAZZ AJ139 V2 ----

fn aj139(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    let is_battery = |r: &[u8]| if r.len() > 9 && r[0] == 0xAA && r[1] == 0x30 { Some((r[8], r[9])) } else { None };
    let r = match out_ask(ch, &AJ139_A, ms(700), deadline, &mut |r| is_battery(r)) {
        Err(TErr::Gone) => return Outcome::Failed,
        Err(_) => out_ask(ch, &AJ139_B, ms(800), deadline, &mut |r| is_battery(r)),
        ok => ok,
    };
    match r {
        Ok((p, _)) if p > 100 => no_level(Charging::Unknown, now),
        Ok((0, c)) if m.via == Via::Receiver => {
            if c != 0 {
                no_level(Charging::Yes, now)
            } else {
                unlinked(now)
            }
        }
        Ok((p, c)) => got(pctl_or_unknown(i64::from(p)), charging(c != 0), now),
        Err(e) => failed(&e),
    }
}

// ---- Incott / Wraith W1 ----

/// The device-info reply's model code: 18 W1, 20 W1 Freestyle; any other: an Incott.
pub fn w1_name(code: u8) -> Option<&'static str> {
    match code {
        18 => Some("Wraith W1"),
        20 => Some("Wraith W1 Freestyle"),
        _ => None,
    }
}

fn pix_status(b: u8, cable: bool, now: u64) -> Outcome {
    let p = b & 0x7F;
    let c = b & 0x80 != 0;
    if p > 100 {
        return no_level(charging(c), now);
    }
    if !cable && p == 0 && !c {
        return unlinked(now);
    }
    if p == 0 {
        return no_level(charging(c), now);
    }
    got(pctl_or_unknown(i64::from(p)), charging(c), now)
}

fn pixart(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Answer {
    let cable = m.via == Via::Cable;
    let info = feat_ask(&mut *ch.main, &INCOTT_INFO, 0x09, 9, ms(50), 10, deadline, &mut |r| if r.len() >= 4 && r[0] == 0x09 && r[1] == 0x8F { Some(r[3]) } else { None });
    let code = match info {
        Ok(c) => Some(c),
        Err(TErr::Gone) => return Outcome::Failed.into(),
        // (Refused: this collection takes no feature report — the cable's first FF05 collection; the platform tries
        //  the next.)
        Err(TErr::Refused) => return Outcome::NoAnswer.into(),
        Err(_) => None,
    };
    if let Some(name) = code.and_then(w1_name) {
        // (A W1: its status comes as input report 09 when the mouse pushes it; the read that would provoke it is not
        //  a status read and is not sent.)
        let heard = match ch.reply.as_deref_mut() {
            Some(rx) => listen(rx, ms(1500), deadline, &mut |r| if r.len() >= 2 && r[0] == 0x09 && r[1] & 0x7F <= 100 { Some(r[1]) } else { None }),
            None => Err(TErr::Timeout),
        };
        let out = match heard {
            Ok(Some(b)) => pix_status(b, cable, now),
            Err(TErr::Gone) => Outcome::Failed,
            _ => needs_query(now),
        };
        return Answer { out, slots: None, name: Some(name.to_string()), kind: None, unit: None };
    }
    let st = feat_ask(&mut *ch.main, &INCOTT_STATUS, 0x09, 9, ms(50), 10, deadline, &mut |r| if r.len() >= 4 && r[0] == 0x09 && r[1] == 0x89 && (r[2] | r[3]) != 0 { Some(r[2]) } else { None });
    match st {
        Ok(b) => pix_status(b, cable, now).into(),
        Err(e) if code.is_some() => {
            if e == TErr::Gone {
                Outcome::Failed.into()
            } else {
                dozing(now).into()
            }
        }
        Err(e) => failed(&e).into(),
    }
}

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Answer {
    match m.driver {
        "mk-motospeed" => motospeed(ch, deadline, now).into(),
        "mk-xenta" => xenta_listen(ch, m, deadline, now),
        "mk-delux" => delux_read(ch, m, deadline, now).into(),
        "mk-ajazz" => aj139(ch, m, deadline, now).into(),
        "mk-incott" => pixart(ch, m, deadline, now),
        _ => Outcome::Failed.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn motospeed_x6() {
        let m = model("mk-motospeed", 0xFFE0);
        let mut f = fake(m);
        f.replies.push_back(vec![report(0xB4, 21, &[(20, 128 + 64)])]);
        assert_eq!(read1(&mut f, m), at(pctl(64), Charging::Yes));
        assert_eq!(f.sent, vec![MOTOSPEED.to_vec()]);
        let mut f = fake(m);
        f.replies.push_back(vec![report(0xB4, 21, &[(20, 120)])]);
        assert_eq!(read1(&mut f, m), no_level(Charging::No, 7), "over 100: no level");
        let mut f = fake(m);
        f.replies.push_back(vec![report(0xB4, 20, &[])]);
        assert_eq!(read1(&mut f, m), Outcome::NoAnswer, "short");
    }

    #[test]
    fn xenta_listens_and_needs_two_frames() {
        let m = model("mk-xenta", 0xFA65);
        let mut f = fake(m);
        f.stream.extend([vec![0x03, 0x55, 0x40, 0x01, 0x64], vec![0x03, 0x55, 0x40, 0x01, 0x48], vec![0x03, 0x55, 0x40, 0x01, 0x48]]);
        let a = crate::mice::read(&mut Chans::one(&mut f), m, None, true, soon(), 7);
        assert_eq!(a.out, at(pctl(72), Charging::No), "the false 100 % first, then two agreeing frames");
        assert_eq!(a.name.as_deref(), Some("Attack Shark X11"));
        assert!(f.sent.is_empty(), "nothing sent");
        // (Delux on FA65: charging at once; full at once.)
        let mut f = fake(m);
        f.stream.push_back(vec![0x03, 0x30, 0x40, 0x03, 0x37]);
        assert_eq!(read1(&mut f, m), at(pctl(55), Charging::Yes));
        // (Attack Shark X6: tens, as steps.)
        let mut f = fake(model("mk-xenta", 0xFA60));
        f.stream.extend([vec![0x03, 0x10, 0x40, 0x01, 0x07], vec![0x03, 0x10, 0x40, 0x01, 0x07]]);
        assert_eq!(read1(&mut f, model("mk-xenta", 0xFA60)), at(steps(7, 10).unwrap(), Charging::No));
        // (ARDOR: two equal tiers, the fifth byte free.)
        let mut f = fake(model("mk-xenta", 0xFA60));
        f.stream.extend([vec![0x03, 0x00, 0x40, 0x73, 0x08], vec![0x03, 0x00, 0x40, 0x73, 0x09]]);
        let a = crate::mice::read(&mut Chans::one(&mut f), model("mk-xenta", 0xFA60), None, true, soon(), 7);
        assert_eq!(a.out, at(steps(3, 4).unwrap(), Charging::Unknown));
        assert_eq!(a.name.as_deref(), Some("ARDOR GAMING Fury V2"));
        // (One frame only, malformed frames, a cable.)
        let mut f = fake(m);
        f.stream.extend([vec![0x03, 0x55, 0x40, 0x01, 0x48], vec![0x03, 0x55, 0x42, 0x01], vec![0x04, 0, 0, 0, 0]]);
        assert_eq!(read1(&mut f, m), dozing(7));
        let mut f = fake(model("mk-xenta", 0xFA55));
        f.stream.push_back(vec![0x03, 0x55, 0x40, 0x01, 0x48]);
        assert_eq!(read1(&mut f, model("mk-xenta", 0xFA55)), at(Level::Unknown, Charging::Yes));
        assert_eq!(read1(&mut fake(m), m), unlinked(7), "a quiet receiver");
        assert_eq!(ardor_tier(&[0x03, 0x00, 0x40, 0x53, 0x08]), None);
    }

    #[test]
    fn delux_m800() {
        let m = model("mk-delux", 0x5B2E);
        let mut f = fake(m);
        f.feature_replies.push_back(report(0x0C, 33, &[(2, 0x20), (6, 1), (18, 81), (19, 0)]));
        assert_eq!(read1(&mut f, m), at(pctl(81), Charging::No));
        assert_eq!(f.sent.len(), 1);
        assert_eq!(&f.sent[0][..4], &[0x0C, 0x01, 0x20, 0x00]);
        assert!((1..=0x7F).contains(&f.sent[0][4]));
        let mut f = fake(m);
        f.feature_replies.push_back(report(0x0C, 33, &[(2, 0x20), (18, 101)]));
        assert_eq!(read1(&mut f, m), no_level(Charging::Unknown, 7));
        let mut f = fake(m);
        f.feature_replies.push_back(report(0x0C, 19, &[(2, 0x20)]));
        assert_eq!(read1(&mut f, m), Outcome::NoAnswer, "short");
        // (The receiver, not linked at first: asked once more, with the next sequence number.)
        let rx = model("mk-delux", 0x5B2F);
        let mut f = fake(rx);
        f.feature_replies.extend([report(0x0C, 33, &[(2, 0x20)]), report(0x0C, 33, &[(2, 0x20), (6, 1), (18, 40), (19, 1)])]);
        assert_eq!(read1(&mut f, rx), at(pctl(40), Charging::Yes));
        assert_eq!(f.sent.len(), 2);
        assert_ne!(f.sent[0][4], f.sent[1][4]);
        assert!(delux_seq(126_000, 1) >= 1 && delux_seq(126_000, 1) <= 0x7F);
    }

    #[test]
    fn aj139_both_checksums() {
        let m = model("mk-ajazz", 0x2255);
        let mut f = fake(m);
        f.replies.extend([vec![vec![0xAA, 0xFA, 0, 0, 0, 0, 0, 0, 0, 0]], vec![report(0xAA, 64, &[(1, 0x30), (8, 66), (9, 1)])]]);
        assert_eq!(read1(&mut f, m), at(pctl(66), Charging::Yes));
        assert_eq!(f.sent, vec![AJ139_A.to_vec(), AJ139_B.to_vec()], "the second checksum after no reply to the first");
        let mut f = fake(m);
        f.replies.push_back(vec![report(0xAA, 64, &[(1, 0x30)])]);
        assert_eq!(read1(&mut f, m), unlinked(7));
    }

    #[test]
    fn incott_and_w1() {
        let m = model("mk-incott", 0x522C);
        let mut f = fake(m);
        f.feature_replies.extend([report(0x09, 9, &[(1, 0x8F), (3, 2)]), report(0x09, 9, &[(1, 0x89), (2, 0x80 | 45), (3, 0x11)])]);
        assert_eq!(read1(&mut f, m), at(pctl(45), Charging::Yes));
        assert_eq!(f.sent, vec![INCOTT_INFO.to_vec(), INCOTT_STATUS.to_vec()]);
        // (A W1: no status request; its pushed report 09 on the input collection.)
        let mut f = fake(m);
        f.feature_replies.push_back(report(0x09, 9, &[(1, 0x8F), (3, 20)]));
        let mut rx = fake(m);
        rx.keep_on_flush = true;
        rx.stream.push_back(vec![0x09, 77, 0x01]);
        let a = crate::mice::read(&mut Chans { main: &mut f, reply: Some(&mut rx), long: None }, m, None, true, soon(), 7);
        assert_eq!(a.out, at(pctl(77), Charging::No));
        assert_eq!(a.name.as_deref(), Some("Wraith W1 Freestyle"));
        assert_eq!(f.sent, vec![INCOTT_INFO.to_vec()], "never 89 or 86 to a W1");
        let mut f = fake(m);
        f.feature_replies.push_back(report(0x09, 9, &[(1, 0x8F), (3, 18)]));
        assert_eq!(read1(&mut f, m), needs_query(7));
        // (Stale reply 00 00: asked again until the deadline's tries end.)
        let mut f = fake(m);
        f.feature_replies.extend([report(0x09, 9, &[(1, 0x8F), (3, 2)]), report(0x09, 9, &[(1, 0x89)])]);
        assert_eq!(read1(&mut f, m), dozing(7));
    }
}
