// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Valve's Steam Controller (2015, on its receiver) and the 2026 Steam
// Controller (cable, Bluetooth, its puck, the internal receiver).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/steam_controller.cpp (PollSteamController, ReadSteamBattery) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later. Layout reference
// there: Linux hid-steam. The vendor collection (page FF00) sends the battery on its own:
//   2015 receiver (28DE:1142), payload (Windows' zero report id dropped): 01 00 04 0B …, byte 14 the percentage.
//   2026 controller: report 43, byte 1 the charge state (2 = charging), byte 2 the percentage.
// Changed here: a value over 100 is no reading (the original skipped it too, and kept listening up to 5 s; here the
// listening ends at the caller's deadline); a puck slot or receiver with no pad says «no controller linked» instead of
// leaving a stale entry; each interface of a receiver is its own pad (as the original's per-path keys). Steam Deck:
// not in the original — the Deck's own battery is the computer's, not its pad's. Never written to.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::{Link, Model, Parsed};
use crate::model::{Charging, Level, Percent};
use std::time::Duration;

const fn sc(pid: u16, usages: &'static [u16], link: Link) -> Model {
    let mut m = Model::new("steam", 0x28DE, pid, 0xFF00, usages, "Steam Controller", "trackpads", link);
    m.min_in = 15;
    m.per_interface = true;
    m
}

pub static MODELS: &[Model] = &[
    sc(0x1142, &[], Link::Receiver),
    sc(0x1302, &[], Link::Pad),
    sc(0x1303, &[], Link::Pad),
    // (The puck's charging-contacts collection is another usage: only usage 1 is a pad slot.)
    sc(0x1304, &[0x01], Link::Receiver),
    sc(0x1305, &[], Link::Receiver),
];

/// The battery report comes every few seconds, not with every input report.
pub fn window(m: &Model) -> Duration {
    Duration::from_millis(if m.link == Link::Receiver && m.pid == 0x1304 { 1_500 } else { 3_500 })
}

pub fn parse(m: &Model, r: &[u8]) -> Parsed {
    if m.pid == 0x1142 {
        if r.len() < 4 || r[0] != 0x01 || r[1] != 0x00 || r[2] != 0x04 {
            return Parsed::Skip;
        }
        if r[3] != 11 || r.len() < 15 {
            return Parsed::Bad;
        }
        match Percent::new(i64::from(r[14])) {
            Some(p) => Parsed::Got(Level::Exact(p), Charging::Unknown),
            None => Parsed::Bad,
        }
    } else {
        if r.first() != Some(&0x43) {
            return Parsed::Skip;
        }
        if r.len() < 15 {
            return Parsed::Bad;
        }
        match Percent::new(i64::from(r[2])) {
            Some(p) => Parsed::Got(Level::Exact(p), if r[1] == 2 { Charging::Yes } else { Charging::Unknown }),
            None => Parsed::Bad,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::super::read;
    use super::*;
    use crate::model::{Note, Reading};
    use crate::sched::Outcome;

    fn m(pid: u16) -> &'static Model {
        MODELS.iter().find(|m| m.pid == pid).unwrap()
    }
    fn pct(n: i64) -> Level {
        Level::Exact(Percent::new(n).unwrap())
    }

    #[test]
    fn the_2015_receiver() {
        // (As Windows gives it: 00, then 01 00 04 0B …, the percentage at payload byte 14.)
        let old = m(0x1142);
        let mut r = report(0x00, 65, &[(1, 0x01), (3, 0x04), (4, 11), (15, 77)]);
        assert_eq!(parse(old, super::super::payload(&r)), Parsed::Got(pct(77), Charging::Unknown));
        r[15] = 101;
        assert_eq!(parse(old, super::super::payload(&r)), Parsed::Bad, "over 100");
        assert_eq!(parse(old, &[0x01, 0x00, 0x04, 0x0B, 0, 0]), Parsed::Bad, "short");
        assert_eq!(parse(old, &[0x01, 0x00, 0x04, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 50]), Parsed::Bad, "another length");
        assert_eq!(parse(old, &[0x01, 0x00, 0x01, 0x3C, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 50]), Parsed::Skip, "an input report");
    }

    #[test]
    fn the_2026_controller() {
        let new = m(0x1302);
        assert_eq!(parse(new, &report(0x43, 64, &[(1, 2), (2, 46)])), Parsed::Got(pct(46), Charging::Yes));
        assert_eq!(parse(new, &report(0x43, 64, &[(1, 0), (2, 100)])), Parsed::Got(pct(100), Charging::Unknown));
        assert_eq!(parse(new, &report(0x43, 64, &[(2, 200)])), Parsed::Bad);
        assert_eq!(parse(new, &report(0x43, 14, &[(2, 20)])), Parsed::Bad, "short");
        assert_eq!(parse(new, &report(0x42, 64, &[(2, 20)])), Parsed::Skip);
    }

    #[test]
    fn an_empty_puck_slot_says_so() {
        let puck = m(0x1304);
        let mut f = fake(puck);
        assert_eq!(read(&mut f, puck, false, false, soon(), 1), Outcome::Read(Reading::unknown(Note::NoPad, Charging::Unknown, 1)));
        let mut f = fake(puck);
        f.stream.extend([report(0x45, 64, &[]), report(0x43, 64, &[(2, 63)])]);
        assert_eq!(read(&mut f, puck, false, false, soon(), 1), Outcome::Read(Reading::new(pct(63), Charging::Unknown, 1)));
        assert!(f.sent.is_empty());
    }
}
