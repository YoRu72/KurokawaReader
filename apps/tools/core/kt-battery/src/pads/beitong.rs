// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): BEITONG (Betop) KP20 / BTP-KP20 on its receiver (20BC:5128, XInput mode).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/beitong.cpp (PollBeitong, Enc, Dec) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and
// its contributors, GPL-3.0-or-later (reverse engineered there from BEITONG iControl 1.0.5 and USB traces).
// XInput sees a wired pad, so the battery comes from the vendor collection (page 00FF, usage 0003, report id 02) with
// the «get base info» request iControl sends for its home page. Every byte after the report id is scrambled with a fixed
// nibble cipher: enc(x) = S[x >> 4] << 4 | ((x & 0x0F) ^ 0x08), S = 0 A 6 F 1 C 2 9 E 3 7 D 4 B 5 8.
//     request (plain 02 15)  → on the wire 02 AD (zeros after)
//     reply   (plain) 02 15 <battery 0–100> 00 <charge state: 1 charging>
//   No configuration mode, ping or setting: it only asks. Sent only once the user turned BEITONG's reading on.
// D1 (the original's v1.1.0 beitong.cpp at commit 7cc44f2, from iControl's kp40d.js): the KP40D's receiver (20BC:515C)
// takes the same request and answers the same way, its charge state's low nibble only.
// Changed here: the decoded level checked 0–100 before use (as the original), the reply tied to its command, nothing
// else sent; other frames (key state, sync) skipped.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::{ask, Link, Model};
use crate::model::{Charging, Level, Note, Percent, Reading};
use crate::sched::Outcome;
use crate::transport::{HidTransport, TErr};
use std::time::{Duration, Instant};

const fn bt(pid: u16, name: &'static str) -> Model {
    let mut m = Model::new("beitong", 0x20BC, pid, 0x00FF, &[0x0003], name, "pad", Link::Receiver);
    m.min_in = 5;
    m.min_out = 3;
    m
}
pub static MODELS: &[Model] = &[bt(0x5128, "BEITONG KP20"), bt(0x515C, "BEITONG KP40D")];

const S: [u8; 16] = [0x0, 0xA, 0x6, 0xF, 0x1, 0xC, 0x2, 0x9, 0xE, 0x3, 0x7, 0xD, 0x4, 0xB, 0x5, 0x8];
const GET_BASE_INFO: u8 = 0x15;
/// The request as sent (allow.rs).
pub const BASE_INFO: [u8; 2] = [0x02, 0xAD];
const STEP: Duration = Duration::from_millis(800);

pub fn enc(x: u8) -> u8 {
    (S[(x >> 4) as usize] << 4) | ((x & 0x0F) ^ 0x08)
}

pub fn dec(x: u8) -> u8 {
    let hi = S.iter().position(|&v| v == x >> 4).unwrap_or(0) as u8;
    (hi << 4) | ((x & 0x0F) ^ 0x08)
}

pub fn query(t: &mut dyn HidTransport, m: &Model, deadline: Instant, now: u64) -> Outcome {
    let mask = if m.pid == 0x515C { 0x0F } else { 0xFF };
    match ask(t, &BASE_INFO, deadline, STEP, &|r: &[u8]| r.len() >= 5 && r[0] == 0x02 && dec(r[1]) == GET_BASE_INFO) {
        Ok(r) => match Percent::new(i64::from(dec(r[2]))) {
            Some(p) => Outcome::Read(Reading::new(Level::Exact(p), if dec(r[4]) & mask == 1 { Charging::Yes } else { Charging::No }, now)),
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

    #[test]
    fn the_cipher() {
        assert_eq!(enc(GET_BASE_INFO), 0xAD, "the request on the wire");
        assert_eq!(BASE_INFO, [0x02, enc(GET_BASE_INFO)]);
        for x in 0..=255u8 {
            assert_eq!(dec(enc(x)), x, "dec undoes enc for {:02X}", x);
        }
    }

    #[test]
    fn base_info() {
        let m = &MODELS[0];
        let mut f = fake(m);
        f.replies.push_back(vec![report(0x02, 64, &[(1, enc(0x25))]), report(0x02, 64, &[(1, enc(0x15)), (2, enc(67)), (3, enc(0)), (4, enc(1))])]);
        assert_eq!(read(&mut f, m, false, true, soon(), 3), Outcome::Read(Reading::new(Level::Exact(Percent::new(67).unwrap()), Charging::Yes, 3)));
        assert_eq!(f.sent, vec![BASE_INFO.to_vec()]);
        let mut f = fake(m);
        f.replies.push_back(vec![report(0x02, 64, &[(1, enc(0x15)), (2, enc(180))])]);
        assert_eq!(read(&mut f, m, false, true, soon(), 3), Outcome::Read(Reading::unknown(Note::None, Charging::Unknown, 3)), "180 %: no reading");
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x02, enc(0x15), enc(50)]]);
        assert_eq!(read(&mut f, m, false, true, soon(), 3), Outcome::NoAnswer, "short");
    }

    #[test]
    fn kp40d_low_nibble() {
        let m = &MODELS[1];
        let mut f = fake(m);
        f.replies.push_back(vec![report(0x02, 64, &[(1, enc(0x15)), (2, enc(80)), (4, enc(0x31))])]);
        assert_eq!(read(&mut f, m, false, true, soon(), 3), Outcome::Read(Reading::new(Level::Exact(Percent::new(80).unwrap()), Charging::Yes, 3)), "31: charging by its low nibble");
        let k = &MODELS[0];
        let mut f = fake(k);
        f.replies.push_back(vec![report(0x02, 64, &[(1, enc(0x15)), (2, enc(80)), (4, enc(0x31))])]);
        assert_eq!(read(&mut f, k, false, true, soon(), 3), Outcome::Read(Reading::new(Level::Exact(Percent::new(80).unwrap()), Charging::No, 3)), "the KP20 takes the whole byte");
    }
}
