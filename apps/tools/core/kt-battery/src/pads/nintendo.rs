// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Nintendo Switch Pro Controller (and pads that pretend to be one, as an
// 8BitDo or GameSir pad in Switch mode), Joy-Con (L) and Joy-Con (R).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/switch_pro.cpp (PollSwitchPro) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its
// contributors, GPL-3.0-or-later. Layout reference there: SDL's SDL_hidapi_switch.c; the Joy-Con share it
// (dekuNukem's Nintendo_Switch_Reverse_Engineering notes, «Standard input report»).
// The full input reports 30 / 31 and the sub-command replies 21 (byte 0 the report id) carry byte 2: bits 7–5 the
// level 0–4 (empty, critical, low, medium, full), bit 4 charging.
// Changed here: the level stays the pad's 0–4 steps (the original showed 25 × level %); the Joy-Con are read too (the
// original matched 057E:2009 only); reports 21 and 31 count as well as 30. As the original, it only listens: the pad
// sends these reports once a host (Steam, a game, an emulator) has asked for them — a sub-command that changes the
// report mode, which Tools never sends. Until then: «needs a query we do not send». Never written to.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::{Link, Model, Parsed};
use crate::model::{Charging, Level, Steps};
use std::time::Duration;

const fn pad(pid: u16, name: &'static str, picture: &'static str) -> Model {
    let mut m = Model::new("nintendo", 0x057E, pid, 0x01, &[0x04, 0x05], name, picture, Link::Pad);
    m.min_in = 13;
    m.mode_bound = true;
    m
}

pub static MODELS: &[Model] = &[pad(0x2009, "Nintendo Switch Pro Controller", "pad"), pad(0x2006, "Joy-Con (L)", "half"), pad(0x2007, "Joy-Con (R)", "half")];

/// Full reports come 60 times a second; the window covers a pad that is slow to start.
pub const WINDOW: Duration = Duration::from_millis(500);

pub fn parse(r: &[u8]) -> Parsed {
    match r.first() {
        Some(0x21) | Some(0x30) | Some(0x31) => {}
        _ => return Parsed::Skip,
    }
    if r.len() < 13 {
        return Parsed::Bad;
    }
    let b = r[2];
    let level = b >> 5;
    if level > 4 {
        return Parsed::Bad;
    }
    let Some(s) = Steps::new(i64::from(level), 4) else { return Parsed::Bad };
    let bit = b & 0x10 != 0;
    // (The charging bit stays on once full: full on the cable is charged, not charging.)
    let ch = if bit && level < 4 { Charging::Yes } else { Charging::No };
    Parsed::Got(Level::Steps(s), ch)
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::super::read;
    use super::*;
    use crate::model::{Note, Reading};
    use crate::sched::Outcome;

    fn st(n: i64) -> Level {
        Level::Steps(Steps::new(n, 4).unwrap())
    }

    #[test]
    fn levels_and_charging() {
        // (Report 30, 49 bytes; byte 2: 0x80 → 4 of 4; 0x60 → 3; 0x50 → 2 charging; 0x90 → full on the cable.)
        assert_eq!(parse(&report(0x30, 49, &[(2, 0x80)])), Parsed::Got(st(4), Charging::No));
        assert_eq!(parse(&report(0x30, 49, &[(2, 0x60)])), Parsed::Got(st(3), Charging::No));
        assert_eq!(parse(&report(0x30, 49, &[(2, 0x50)])), Parsed::Got(st(2), Charging::Yes));
        assert_eq!(parse(&report(0x30, 49, &[(2, 0x90)])), Parsed::Got(st(4), Charging::No));
        assert_eq!(parse(&report(0x21, 49, &[(2, 0x20)])), Parsed::Got(st(1), Charging::No), "a sub-command reply carries it too");
        assert_eq!(parse(&report(0x31, 49, &[(2, 0x00)])), Parsed::Got(st(0), Charging::No));
        assert_eq!(parse(&report(0x30, 49, &[(2, 0xA0)])), Parsed::Bad, "level 5: not on the scale");
        assert_eq!(parse(&report(0x30, 12, &[(2, 0x80)])), Parsed::Bad, "short");
        assert_eq!(parse(&report(0x3F, 12, &[])), Parsed::Skip, "the simple report has no battery");
        assert_eq!(parse(&[]), Parsed::Skip);
    }

    #[test]
    fn only_simple_reports_means_needs_a_query() {
        for m in MODELS {
            let mut f = fake(m);
            f.stream.extend([report(0x3F, 12, &[]), report(0x3F, 12, &[])]);
            assert_eq!(read(&mut f, m, true, true, soon(), 3), Outcome::Read(Reading::unknown(Note::NeedsQuery, Charging::Unknown, 3)), "{}", m.name);
            assert!(f.sent.is_empty());
            let mut f = fake(m);
            assert_eq!(read(&mut f, m, false, true, soon(), 3), Outcome::Read(Reading::unknown(Note::NeedsQuery, Charging::Unknown, 3)), "quiet by cable: no handshake from us");
            let mut f = fake(m);
            f.stream.push_back(report(0x30, 49, &[(2, 0x70)]));
            assert_eq!(read(&mut f, m, true, false, soon(), 3), Outcome::Read(Reading::new(st(3), Charging::Yes, 3)));
        }
    }
}
