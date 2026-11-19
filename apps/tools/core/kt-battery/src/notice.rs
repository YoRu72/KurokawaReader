// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): when a low-battery or a fully-charged notice is due, per device.
// Derived from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor), src/main.cpp
// (UpdateTrayIcon: one «Low battery» balloon at 15 %, again only once the level is past 25 % or the device charges) at
// commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later.
// Changed here: the mark is the user's, per device (10/15/20/30 %, or off), and it re-arms at mark + 5 %; a coarse
// device (XInput's steps) is told at «Low» and re-armed at «Medium», never through a made-up percentage; nothing is
// told from a reading older than the checking interval, from an asleep device or from one not connected (the original
// warned from the last value it kept); an optional «fully charged» notice, only after the device was seen charging
// below full. Pure and std only: the shell keeps one Memo per device and shows what `step` returns.
// Copyright (C) 2026 Kurokawa contributors.
use crate::model::{Charging, Coarse, Level, Reading};

/// The marks a user can choose (the page's list), and the one used when he chose none.
pub const CHOICES: [u8; 4] = [10, 15, 20, 30];
pub const DEFAULT_MARK: u8 = 20;
/// A device told once is told again only after rising above its mark by this much (or after charging).
pub const REARM: u8 = 5;

/// A device's low mark: a percentage, or no notice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mark {
    Off,
    At(u8),
}

impl Mark {
    /// A kept per-device value: 0 is «off», one of CHOICES its mark; anything else is not a mark (None: use the
    /// default).
    pub fn from_setting(v: u64) -> Option<Mark> {
        if v == 0 {
            Some(Mark::Off)
        } else {
            CHOICES.iter().find(|c| u64::from(**c) == v).map(|c| Mark::At(*c))
        }
    }
}

/// The default mark as kept: the nearest of CHOICES (a value from an older version, e.g. 25, snapped), DEFAULT_MARK
/// when there is none.
pub fn snap(v: Option<u64>) -> u8 {
    let Some(v) = v else { return DEFAULT_MARK };
    let mut best = CHOICES[0];
    for c in CHOICES {
        if (i64::from(c) - v.min(1000) as i64).abs() < (i64::from(best) - v.min(1000) as i64).abs() {
            best = c;
        }
    }
    best
}

/// What the shell remembers per device between readings.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Memo {
    /// A low notice was shown and the device has not since risen past its mark + REARM nor charged.
    pub low_told: bool,
    /// The device was seen charging while not full: reaching full then is told (once).
    pub charge_seen: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Notice {
    /// The level that crossed the mark (exact or coarse, as the device gave it).
    Low(Level),
    Full,
}

/// One reading of a device as the rule needs it.
#[derive(Clone, Copy, Debug)]
pub struct Seen<'a> {
    pub reading: Option<&'a Reading>,
    /// The device answered this round (runner Status::Ok): not asleep, not away, not silent, not left alone.
    pub live: bool,
    pub now: u64,
    /// The checking interval: a reading older than it is not news.
    pub max_age_ms: u64,
}

fn is_full(l: Level) -> bool {
    matches!(l, Level::Exact(p) if p.get() >= 100) || l.as_coarse() == Some(Coarse::Full)
}

/// The rule, one reading at a time. A reading that is missing, old, asleep or from a device that is not live leaves
/// the memo as it was and tells nothing.
pub fn step(memo: &mut Memo, mark: Mark, full_notice: bool, seen: Seen) -> Option<Notice> {
    let r = seen.reading?;
    if !seen.live || r.asleep || !r.is_fresh(seen.now, seen.max_age_ms) {
        return None;
    }
    let charging = r.charging == Charging::Yes;
    // Re-armed: charging, risen past the mark + REARM (a coarse device: back to Medium or more), or the notice off.
    let rearm = charging
        || match (mark, r.level) {
            (Mark::Off, _) => true,
            (Mark::At(t), Level::Exact(p)) => u16::from(p.get()) > u16::from(t) + u16::from(REARM),
            (Mark::At(_), Level::Coarse(c)) => c >= Coarse::Medium,
            (Mark::At(_), Level::Steps(s)) => s.coarse() >= Coarse::Medium,
            (Mark::At(_), Level::Unknown) => false,
        };
    if rearm {
        memo.low_told = false;
    }
    if !charging && !memo.low_told {
        if let Mark::At(t) = mark {
            let low = match r.level {
                Level::Exact(p) => p.get() <= t,
                Level::Coarse(c) => c <= Coarse::Low,
                Level::Steps(s) => s.coarse() <= Coarse::Low,
                Level::Unknown => false,
            };
            if low {
                memo.low_told = true;
                return Some(Notice::Low(r.level));
            }
        }
    }
    let full = is_full(r.level);
    if full {
        if memo.charge_seen {
            memo.charge_seen = false;
            if full_notice {
                return Some(Notice::Full);
            }
        }
    } else if charging {
        if r.level != Level::Unknown {
            memo.charge_seen = true;
        }
    } else if r.charging == Charging::No {
        // (Taken off the charger before full: nothing to tell later.)
        memo.charge_seen = false;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Percent;

    const MIN: u64 = 60_000;
    fn ex(p: i64, ch: Charging, at: u64) -> Reading {
        Reading::new(Level::Exact(Percent::new(p).unwrap()), ch, at)
    }
    fn co(c: Coarse, at: u64) -> Reading {
        Reading::new(Level::Coarse(c), Charging::Unknown, at)
    }
    fn go(m: &mut Memo, mark: Mark, full: bool, r: &Reading, now: u64) -> Option<Notice> {
        step(m, mark, full, Seen { reading: Some(r), live: true, now, max_age_ms: MIN })
    }

    #[test]
    fn told_once_when_crossing_then_rearmed_past_mark_plus_five() {
        let mut m = Memo::default();
        let k = Mark::At(20);
        assert_eq!(go(&mut m, k, false, &ex(30, Charging::No, 0), 0), None);
        assert_eq!(go(&mut m, k, false, &ex(21, Charging::No, 1), 1), None);
        assert!(matches!(go(&mut m, k, false, &ex(20, Charging::No, 2), 2), Some(Notice::Low(Level::Exact(p))) if p.get() == 20), "at the mark is low");
        assert_eq!(go(&mut m, k, false, &ex(18, Charging::No, 3), 3), None, "not again while it stays low");
        assert_eq!(go(&mut m, k, false, &ex(25, Charging::No, 4), 4), None, "mark + 5 is not yet past it");
        assert_eq!(go(&mut m, k, false, &ex(19, Charging::No, 5), 5), None, "a wobble under mark + 5 tells nothing new");
        assert_eq!(go(&mut m, k, false, &ex(26, Charging::No, 6), 6), None);
        assert!(!m.low_told, "past mark + 5: re-armed");
        assert!(matches!(go(&mut m, k, false, &ex(19, Charging::No, 7), 7), Some(Notice::Low(_))), "a new crossing is told");
    }

    #[test]
    fn already_low_at_the_first_reading_is_told_once() {
        let mut m = Memo::default();
        assert!(matches!(go(&mut m, Mark::At(15), false, &ex(9, Charging::No, 0), 0), Some(Notice::Low(_))));
        assert_eq!(go(&mut m, Mark::At(15), false, &ex(8, Charging::No, 1), 1), None);
    }

    #[test]
    fn charging_is_never_low_and_rearms() {
        let mut m = Memo::default();
        let k = Mark::At(20);
        assert_eq!(go(&mut m, k, false, &ex(10, Charging::Yes, 0), 0), None, "charging: no low notice");
        assert!(matches!(go(&mut m, k, false, &ex(12, Charging::No, 1), 1), Some(Notice::Low(_))));
        assert_eq!(go(&mut m, k, false, &ex(13, Charging::Yes, 2), 2), None);
        assert!(!m.low_told, "charging re-arms");
        assert!(matches!(go(&mut m, k, false, &ex(14, Charging::No, 3), 3), Some(Notice::Low(_))), "taken off the charger still low: told again");
        let mut u = Memo::default();
        assert!(matches!(go(&mut u, k, false, &ex(10, Charging::Unknown, 0), 0), Some(Notice::Low(_))), "charging unknown counts as not charging");
    }

    #[test]
    fn stale_asleep_away_and_missing_readings_tell_nothing_and_change_nothing() {
        let k = Mark::At(20);
        let old = ex(5, Charging::No, 0);
        let mut m = Memo::default();
        assert_eq!(go(&mut m, k, false, &old, MIN + 1), None, "older than the interval");
        assert_eq!(m, Memo::default());
        assert!(matches!(go(&mut m, k, false, &old, MIN), Some(Notice::Low(_))), "exactly the interval old is still fresh");
        let mut m = Memo { low_told: true, charge_seen: false };
        assert_eq!(go(&mut m, k, false, &ex(90, Charging::No, 0), 2 * MIN), None);
        assert!(m.low_told, "a stale high reading does not re-arm");
        let mut a = Memo::default();
        assert_eq!(step(&mut a, k, false, Seen { reading: Some(&ex(5, Charging::No, 0)), live: false, now: 0, max_age_ms: MIN }), None, "not connected / not live");
        assert_eq!(step(&mut a, k, false, Seen { reading: None, live: true, now: 0, max_age_ms: MIN }), None);
        assert_eq!(go(&mut a, k, false, &Reading::asleep(0), 0), None);
        assert_eq!(a, Memo::default());
        // (A clock gone back: age 0, fresh.)
        assert!(matches!(go(&mut a, k, false, &ex(5, Charging::No, 1_000), 10), Some(Notice::Low(_))));
    }

    #[test]
    fn coarse_devices_are_told_at_low_and_rearmed_at_medium() {
        let mut m = Memo::default();
        let k = Mark::At(10);
        assert_eq!(go(&mut m, k, false, &co(Coarse::Medium, 0), 0), None);
        assert!(matches!(go(&mut m, k, false, &co(Coarse::Low, 1), 1), Some(Notice::Low(Level::Coarse(Coarse::Low)))), "whatever the mark, Low is told");
        assert_eq!(go(&mut m, k, false, &co(Coarse::Empty, 2), 2), None, "Low then Empty: one notice");
        assert_eq!(go(&mut m, k, false, &co(Coarse::Low, 3), 3), None);
        assert_eq!(go(&mut m, k, false, &co(Coarse::Medium, 4), 4), None);
        assert!(matches!(go(&mut m, k, false, &co(Coarse::Empty, 5), 5), Some(Notice::Low(_))), "re-armed at Medium");
        let mut o = Memo::default();
        assert_eq!(go(&mut o, Mark::Off, false, &co(Coarse::Empty, 0), 0), None, "off: nothing");
        // (Steps follow their nearest word: 1 of 4 is Low, 3 of 4 re-arms, 4 of 4 is full.)
        let st = |n, m, ch, at| Reading::new(Level::Steps(crate::model::Steps::new(n, m).unwrap()), ch, at);
        let mut s = Memo::default();
        assert!(matches!(go(&mut s, k, false, &st(1, 4, Charging::No, 10), 10), Some(Notice::Low(Level::Steps(_)))));
        assert_eq!(go(&mut s, k, false, &st(1, 4, Charging::No, 11), 11), None);
        assert_eq!(go(&mut s, k, false, &st(3, 4, Charging::No, 12), 12), None);
        assert!(matches!(go(&mut s, k, false, &st(2, 10, Charging::No, 13), 13), Some(Notice::Low(_))), "re-armed at Medium");
        assert_eq!(go(&mut s, k, true, &st(5, 10, Charging::Yes, 14), 14), None);
        assert_eq!(go(&mut s, k, true, &st(10, 10, Charging::No, 15), 15), Some(Notice::Full), "charged to the top of its scale");
    }

    #[test]
    fn off_tells_nothing_and_unknown_levels_are_never_low() {
        let mut m = Memo::default();
        assert_eq!(go(&mut m, Mark::Off, false, &ex(1, Charging::No, 0), 0), None);
        assert!(!m.low_told);
        let r = Reading::new(Level::Unknown, Charging::No, 0);
        assert_eq!(go(&mut m, Mark::At(30), false, &r, 0), None);
    }

    #[test]
    fn full_is_told_once_after_charging_below_full() {
        let mut m = Memo::default();
        assert_eq!(go(&mut m, Mark::At(20), true, &ex(100, Charging::Yes, 0), 0), None, "plugged in already full: nothing");
        assert_eq!(go(&mut m, Mark::At(20), true, &ex(90, Charging::Yes, 1), 1), None);
        assert_eq!(go(&mut m, Mark::At(20), true, &ex(100, Charging::Yes, 2), 2), Some(Notice::Full));
        assert_eq!(go(&mut m, Mark::At(20), true, &ex(100, Charging::Yes, 3), 3), None, "once");
        assert_eq!(go(&mut m, Mark::At(20), true, &ex(97, Charging::Yes, 4), 4), None);
        assert_eq!(go(&mut m, Mark::At(20), true, &ex(100, Charging::No, 5), 5), Some(Notice::Full), "a device that stops saying «charging» at full");
        // Unplugged before full: forgotten.
        let mut u = Memo::default();
        go(&mut u, Mark::At(20), true, &ex(60, Charging::Yes, 0), 0);
        go(&mut u, Mark::At(20), true, &ex(61, Charging::No, 1), 1);
        assert_eq!(go(&mut u, Mark::At(20), true, &ex(100, Charging::No, 2), 2), None);
        // The notice off: nothing, and nothing left pending for when it is turned on.
        let mut f = Memo::default();
        go(&mut f, Mark::At(20), false, &ex(80, Charging::Yes, 0), 0);
        assert_eq!(go(&mut f, Mark::At(20), false, &ex(100, Charging::Yes, 1), 1), None);
        assert!(!f.charge_seen);
        // Coarse Full counts as full.
        let mut c = Memo::default();
        go(&mut c, Mark::At(20), true, &Reading::new(Level::Coarse(Coarse::High), Charging::Yes, 0), 0);
        assert_eq!(go(&mut c, Mark::At(20), true, &Reading::new(Level::Coarse(Coarse::Full), Charging::Yes, 1), 1), Some(Notice::Full));
    }

    #[test]
    fn marks_from_settings() {
        assert_eq!(Mark::from_setting(0), Some(Mark::Off));
        assert_eq!(Mark::from_setting(15), Some(Mark::At(15)));
        assert_eq!(Mark::from_setting(25), None);
        assert_eq!(Mark::from_setting(u64::MAX), None);
        assert_eq!(snap(None), 20);
        assert_eq!(snap(Some(25)), 20, "a tie goes to the lower");
        assert_eq!(snap(Some(5)), 10);
        assert_eq!(snap(Some(50)), 30);
        assert_eq!(snap(Some(u64::MAX)), 30);
        assert_eq!(snap(Some(15)), 15);
    }
}
