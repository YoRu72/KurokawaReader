// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Flydigi Vader 5 Pro (37D7:2401, its receiver or cable).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/flydigi.cpp (PollFlydigi, Reply) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its
// contributors, GPL-3.0-or-later. Protocol references there: SDL's SDL_hidapi_flydigi.c and HeyOkay/HaloBattery issue
// 191 (Windows traces). Vendor collection FFA0:0001; unnumbered output reports (Windows' report id 0 first):
//     00 5A A5 07 00 00   «architecture»  → 5A A5 07 …: bytes 3–4 = 01 00 on the newer firmware
//     00 5A A5 01 02 00   «device info»   → 5A A5 01 …: byte 5 = 130 (the Vader 5 Pro), byte 6 the connection,
//                                            byte 11: bits 0–3 the level 0–5, bits 4–7 0 on battery / 1 charging / 2 full
//   Some firmware keeps a report id 04 before the reply. Both requests only ask (no takeover, no setting). Sent only
//   once the user turned Flydigi's reading on.
// D1 (the original's v1.1.0 flydigi.cpp at commit 7cc44f2): the Apex 5 (37D7:2501) the same way, its requests as output
// report 03 (SDL's FLYDIGI_V2_CMD_REPORT_ID) and its identity one of 128, 129, 133, 134, 135 (135 seen on a real Apex 5,
// not in SDL's table). Each model takes only its own report id and identities.
// Changed here: the level stays the pad's 0–5 steps (the original showed 20 × level %); an unknown connection value or
// identity is no reading; the replies are tied to their request by the echoed command.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::{ask, Link, Model};
use crate::model::{Charging, Level, Note, Reading, Steps};
use crate::sched::Outcome;
use crate::transport::{HidTransport, TErr};
use std::time::{Duration, Instant};

const fn fd(pid: u16, name: &'static str) -> Model {
    let mut m = Model::new("flydigi", 0x37D7, pid, 0xFFA0, &[0x01], name, "pad", Link::Pad);
    m.min_in = 12;
    m.min_out = 6;
    m
}
pub static MODELS: &[Model] = &[fd(0x2401, "Flydigi Vader 5 Pro"), fd(0x2501, "Flydigi Apex 5")];

pub const ARCH: [u8; 6] = [0x00, 0x5A, 0xA5, 0x07, 0x00, 0x00];
pub const INFO: [u8; 6] = [0x00, 0x5A, 0xA5, 0x01, 0x02, 0x00];
pub const APEX_ARCH: [u8; 6] = [0x03, 0x5A, 0xA5, 0x07, 0x00, 0x00];
pub const APEX_INFO: [u8; 6] = [0x03, 0x5A, 0xA5, 0x01, 0x02, 0x00];

/// The identities a model's «device info» may carry.
pub fn ids(pid: u16) -> &'static [u8] {
    match pid {
        0x2501 => &[128, 129, 133, 134, 135],
        _ => &[130],
    }
}
const STEP: Duration = Duration::from_millis(800);

/// The reply without the report id 04 some firmware keeps.
fn body(r: &[u8]) -> &[u8] {
    if r.len() >= 4 && r[0] == 0x04 && r[1] == 0x5A && r[2] == 0xA5 {
        &r[1..]
    } else {
        r
    }
}

fn is_reply(cmd: u8) -> impl Fn(&[u8]) -> bool {
    move |r: &[u8]| {
        let b = body(r);
        b.len() >= 5 && b[0] == 0x5A && b[1] == 0xA5 && b[2] == cmd
    }
}

/// What the «device info» reply says, given whether the architecture reply was the newer one. None: not a reading.
pub fn info(r: &[u8], modern: bool) -> Option<(Level, Charging, bool)> {
    info_of(r, modern, &[130])
}
pub fn info_of(r: &[u8], modern: bool, ids: &[u8]) -> Option<(Level, Charging, bool)> {
    let b = body(r);
    if b.len() < 12 || !ids.contains(&b[5]) {
        return None;
    }
    let level = b[11] & 0x0F;
    let state = b[11] >> 4;
    if state > 2 || level > 5 {
        return None;
    }
    let conn = b[6];
    let valid = if modern { conn <= 1 } else { conn == 1 || conn == 2 };
    if !valid {
        return None;
    }
    let receiver = conn == if modern { 1 } else { 2 };
    let (n, ch) = match state {
        2 => (5, Charging::No),
        1 => (level, Charging::Yes),
        _ => (level, Charging::No),
    };
    Some((Level::Steps(Steps::new(i64::from(n), 5)?), ch, receiver))
}

pub fn query(t: &mut dyn HidTransport, m: &Model, deadline: Instant, now: u64) -> Outcome {
    let (arch, inf) = if m.pid == 0x2501 { (APEX_ARCH, APEX_INFO) } else { (ARCH, INFO) };
    let modern = match ask(t, &arch, deadline, STEP, &is_reply(0x07)) {
        Ok(r) => {
            let b = body(&r);
            b.len() >= 5 && b[3] == 1 && b[4] == 0
        }
        Err(TErr::Gone) => return Outcome::Failed,
        Err(_) => false,
    };
    match ask(t, &inf, deadline, STEP, &is_reply(0x01)) {
        Ok(r) => match info_of(&r, modern, ids(m.pid)) {
            Some((l, c, _receiver)) => Outcome::Read(Reading::new(l, c, now)),
            None => Outcome::Read(Reading::unknown(Note::None, Charging::Unknown, now)),
        },
        Err(TErr::Gone) => Outcome::Failed,
        Err(_) => Outcome::NoAnswer,
    }
}

#[cfg(test)]
mod tests {
    use super::super::read;
    use super::super::testkit::*;
    use super::*;

    /// A reply as Windows gives it: 00, 5A A5 <cmd>, then `at` (payload offsets).
    fn rep(cmd: u8, at: &[(usize, u8)]) -> Vec<u8> {
        let mut r = vec![0u8; 33];
        r[1] = 0x5A;
        r[2] = 0xA5;
        r[3] = cmd;
        for &(i, v) in at {
            r[i + 1] = v;
        }
        r
    }
    fn st(n: i64) -> Level {
        Level::Steps(Steps::new(n, 5).unwrap())
    }

    #[test]
    fn info_replies() {
        // (Newer firmware: connection 1 = receiver, 0 = cable. Older: 2 = receiver, 1 = cable.)
        let r = super::super::payload(&rep(0x01, &[(5, 130), (6, 1), (11, 0x03)])).to_vec();
        assert_eq!(info(&r, true), Some((st(3), Charging::No, true)));
        assert_eq!(info(&r, false), Some((st(3), Charging::No, false)));
        let r = super::super::payload(&rep(0x01, &[(5, 130), (6, 0), (11, 0x14)])).to_vec();
        assert_eq!(info(&r, true), Some((st(4), Charging::Yes, false)));
        assert_eq!(info(&r, false), None, "older firmware has no connection 0");
        let r = super::super::payload(&rep(0x01, &[(5, 130), (6, 2), (11, 0x21)])).to_vec();
        assert_eq!(info(&r, false), Some((st(5), Charging::No, true)), "full");
        assert_eq!(info(super::super::payload(&rep(0x01, &[(5, 131), (6, 1), (11, 3)])), true), None, "another product");
        assert_eq!(info(super::super::payload(&rep(0x01, &[(5, 130), (6, 1), (11, 0x06)])), true), None, "level 6");
        assert_eq!(info(super::super::payload(&rep(0x01, &[(5, 130), (6, 1), (11, 0x31)])), true), None, "state 3");
        assert_eq!(info(&[0x5A, 0xA5, 0x01, 0, 0, 130], true), None, "short");
        // (A kept report id 04.)
        let mut k = vec![0x04];
        k.extend_from_slice(super::super::payload(&rep(0x01, &[(5, 130), (6, 1), (11, 0x02)])));
        assert_eq!(info(&k, true), Some((st(2), Charging::No, true)));
    }

    #[test]
    fn both_requests_and_nothing_else() {
        let m = &MODELS[0];
        let mut f = fake(m);
        f.replies.extend([vec![rep(0x07, &[(3, 1), (4, 0)])], vec![rep(0x05, &[]), rep(0x01, &[(5, 130), (6, 1), (11, 0x12)])]]);
        assert_eq!(read(&mut f, m, false, true, soon(), 8), Outcome::Read(Reading::new(st(2), Charging::Yes, 8)));
        assert_eq!(f.sent, vec![ARCH.to_vec(), INFO.to_vec()]);
        // (No architecture reply: the older rules; no info reply: no answer.)
        let mut f = fake(m);
        f.replies.extend([vec![], vec![]]);
        assert_eq!(read(&mut f, m, false, true, soon(), 8), Outcome::NoAnswer);
        // (D1: the Apex 5 — report 03, its own identities.)
        let a = &MODELS[1];
        let mut f = fake(a);
        f.replies.extend([vec![rep(0x07, &[(3, 1), (4, 0)])], vec![rep(0x01, &[(5, 135), (6, 1), (11, 0x04)])]]);
        assert_eq!(read(&mut f, a, false, true, soon(), 8), Outcome::Read(Reading::new(st(4), Charging::No, 8)));
        assert_eq!(f.sent, vec![APEX_ARCH.to_vec(), APEX_INFO.to_vec()]);
        let mut f = fake(a);
        f.replies.extend([vec![rep(0x07, &[(3, 1), (4, 0)])], vec![rep(0x01, &[(5, 130), (6, 1), (11, 0x04)])]]);
        assert_eq!(read(&mut f, a, false, true, soon(), 8), Outcome::Read(Reading::unknown(Note::None, Charging::Unknown, 8)), "the Vader's identity on the Apex id");
        assert!(crate::allow::permit(&ident(a), crate::allow::ReportKind::Output, &INFO).is_none(), "the Vader's report id on the Apex");
    }
}
