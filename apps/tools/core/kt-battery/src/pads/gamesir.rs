// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): GameSir Nova Lite / Nova 2 / Nova 2 Lite / Nova Lite 2 and Cyclone 2.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/gamesir.cpp (PollGameSir, PollGameSirCyclone) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by
// krisgfx9 and its contributors, GPL-3.0-or-later. (GameSir pads in Xbox mode, e.g. a G7 Pro, report a real level
// through Windows — xbox.rs.)
// Nova (receiver 3537:1098 or 1040, cable 100F): XInput sees a wired pad, so the battery comes from the vendor
// collection (page FF7A, unnumbered 64-byte reports) with the «device info» request GameSir's own app sends (protocol
// references there: WWWyyy452/GamesirBatteryTray and AJAY0406/Gamesir-Nova-2-Lite-Battery-Detection, both MIT):
//     request 01 01 (after Windows' report id 0)  → reply 01 …, byte 18: 0–100 the percentage, FF charging.
//   It asks for information only. Sent only once the user turned GameSir's reading on. «F4 00» state frames skipped.
// Cyclone 2 (3537:100B, XInput mode): the vendor collection FFF0:0040 sends report 12 with byte 35 the cable / charging
//   flag and byte 36 the percentage — but only after the request 0F 03, which starts the pad's state stream
//   (cyclone2-linux docs/protocol.md). Starting a stream changes what the pad does, so Tools does NOT send it: it
//   listens, and reads report 12 when the maker's app has the stream on; else «needs a query we do not send».
// Changed here: matched by product, page and usage (the original took any FF7A collection with an output report);
// FF (charging) is a charging state with no level, not «keep the last value»; values over 100 are no reading.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::{ask, Link, Model, Parsed};
use crate::model::{Charging, Level, Note, Percent, Reading};
use crate::sched::Outcome;
use crate::transport::{HidTransport, TErr};
use std::time::{Duration, Instant};

const fn nova(pid: u16, name: &'static str, link: Link) -> Model {
    let mut m = Model::new("gamesir-nova", 0x3537, pid, 0xFF7A, &[], name, "pad", link);
    m.min_in = 20;
    m.min_out = 3;
    m
}

pub static MODELS: &[Model] = &[
    nova(0x1098, "GameSir Nova", Link::Receiver),
    nova(0x1040, "GameSir Nova Lite 2", Link::Receiver),
    nova(0x100F, "GameSir Nova 2 Lite", Link::Pad),
    {
        let mut m = Model::new("gamesir-cyclone", 0x3537, 0x100B, 0xFFF0, &[0x40], "GameSir Cyclone 2", "pad", Link::Pad);
        m.min_in = 37;
        m.mode_bound = true;
            m
    },
];

/// The Nova's request: Windows' report id 0, then 01 01 (allow.rs).
pub const NOVA_INFO: [u8; 3] = [0x00, 0x01, 0x01];
pub const CYCLONE_WINDOW: Duration = Duration::from_millis(1_500);
const STEP: Duration = Duration::from_millis(800);

pub fn query_nova(t: &mut dyn HidTransport, deadline: Instant, now: u64) -> Outcome {
    match ask(t, &NOVA_INFO, deadline, STEP, &|r: &[u8]| r.len() >= 19 && r[0] == 0x01) {
        Ok(r) => match r[18] {
            0xFF => Outcome::Read(Reading::unknown(Note::None, Charging::Yes, now)),
            b => match Percent::new(i64::from(b)) {
                Some(p) => Outcome::Read(Reading::new(Level::Exact(p), Charging::Unknown, now)),
                None => Outcome::Read(Reading::unknown(Note::None, Charging::Unknown, now)),
            },
        },
        Err(TErr::Gone) => Outcome::Failed,
        Err(_) => Outcome::NoAnswer,
    }
}

/// Cyclone 2's report 12 (payload, byte 0 the report id).
pub fn parse_cyclone(r: &[u8]) -> Parsed {
    if r.first() != Some(&0x12) {
        return Parsed::Skip;
    }
    if r.len() < 37 {
        return Parsed::Bad;
    }
    match Percent::new(i64::from(r[36])) {
        Some(p) => Parsed::Got(Level::Exact(p), if r[35] == 1 { Charging::Yes } else { Charging::No }),
        None => Parsed::Bad,
    }
}

#[cfg(test)]
mod tests {
    use super::super::read;
    use super::super::testkit::*;
    use super::*;

    fn pct(n: i64) -> Level {
        Level::Exact(Percent::new(n).unwrap())
    }

    #[test]
    fn nova_info() {
        for m in &MODELS[..3] {
            // (As Windows gives it: 00, then 01, …, the level at payload byte 18.)
            let mut f = fake(m);
            f.replies.push_back(vec![report(0x00, 65, &[(1, 0xF4)]), report(0x00, 65, &[(1, 0x01), (19, 58)])]);
            assert_eq!(read(&mut f, m, false, true, soon(), 6), Outcome::Read(Reading::new(pct(58), Charging::Unknown, 6)), "{}", m.name);
            assert_eq!(f.sent, vec![NOVA_INFO.to_vec()]);
            let mut f = fake(m);
            f.replies.push_back(vec![report(0x00, 65, &[(1, 0x01), (19, 0xFF)])]);
            assert_eq!(read(&mut f, m, false, true, soon(), 6), Outcome::Read(Reading::unknown(Note::None, Charging::Yes, 6)), "FF: charging, no level");
            let mut f = fake(m);
            f.replies.push_back(vec![report(0x00, 65, &[(1, 0x01), (19, 140)])]);
            assert_eq!(read(&mut f, m, false, true, soon(), 6), Outcome::Read(Reading::unknown(Note::None, Charging::Unknown, 6)), "140: no reading");
            let mut f = fake(m);
            f.replies.push_back(vec![report(0x00, 12, &[(1, 0x01)])]);
            assert_eq!(read(&mut f, m, false, true, soon(), 6), Outcome::NoAnswer, "short");
        }
    }

    #[test]
    fn cyclone_listens_only() {
        let c = &MODELS[3];
        assert_eq!(parse_cyclone(&report(0x12, 64, &[(35, 1), (36, 81)])), Parsed::Got(pct(81), Charging::Yes));
        assert_eq!(parse_cyclone(&report(0x12, 64, &[(36, 100)])), Parsed::Got(pct(100), Charging::No));
        assert_eq!(parse_cyclone(&report(0x12, 64, &[(36, 101)])), Parsed::Bad);
        assert_eq!(parse_cyclone(&report(0x12, 36, &[])), Parsed::Bad, "short");
        assert_eq!(parse_cyclone(&report(0x10, 64, &[(36, 50)])), Parsed::Skip, "event reports carry no battery");
        let mut f = fake(c);
        f.stream.push_back(report(0x10, 64, &[]));
        assert_eq!(read(&mut f, c, false, true, soon(), 1), Outcome::Read(Reading::unknown(Note::NeedsQuery, Charging::Unknown, 1)));
        assert!(f.sent.is_empty(), "0F 03 is never sent");
        let mut f = fake(c);
        f.stream.push_back(report(0x12, 64, &[(36, 44)]));
        assert_eq!(read(&mut f, c, false, false, soon(), 1), Outcome::Read(Reading::new(pct(44), Charging::No, 1)));
    }
}
