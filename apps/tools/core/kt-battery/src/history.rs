// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery), W2: a device's battery history and the time-left estimate.
// Derived from Wireless Device Battery Monitor (now BatteryHub) v1.1.0, src/history_model.h and src/runtime_estimate.h,
// by krisgfx9 and its contributors, GPL-3.0-or-later.
// Changed here: a reading keeps its own kind — a coarse word or «n of max» steps is stored as it is, never as a made-up
// percentage, and only exact percentages feed the estimate; «away» (asleep or not connected) is recorded as a mark so
// the chart shows a gap instead of a line across a time nobody saw; charging may be unknown (it never counts as
// charging); a level is also recorded when it changes (at most once a minute per device), not only every half hour;
// each device has its own bounded ring (and the devices are bounded); the file is one text file with a header and a
// checked footer (a count and an FNV-1a hash): a damaged file is started afresh, never half-read; how long readings are
// kept is the user's choice (7, 30 or 90 days); an estimate «full in about …» while charging, from the same kind of
// evidence as the original's discharge one (it gave none while charging). No charge-cycle count: the original has none.
// Copyright (C) 2026 Kurokawa contributors. Std only.
//
// The estimate is a rough trend from recorded readings, never a device-reported runtime: when the readings cannot
// support one (too few, too short, too flat, too old, not percentages, mixed with charging) it is None, and nothing is
// said.

use std::collections::{BTreeMap, VecDeque};

use crate::model::{Charging, Coarse, Level, Percent, Steps};

/// A reading is recorded at least this often while a device answers (the original's 30 minutes)…
pub const REGULAR_S: u64 = 30 * 60;
/// …and when its level, charging or presence changes, but never twice within this (the original's one minute).
pub const MIN_STEP_S: u64 = 60;
/// One device's ring (90 days at the regular pace with room for changes).
pub const MAX_PER_DEVICE: usize = 6_000;
/// Devices kept; the one seen longest ago goes first.
pub const MAX_DEVICES: usize = 64;
/// A device key's length, as the settings keep it.
pub const MAX_KEY: usize = 200;
/// The file's bound; a larger one is not read (started afresh).
pub const MAX_FILE: usize = 4 * 1024 * 1024;
/// How long readings may be kept (days), and the default (the original's 30).
pub const KEEP_CHOICES: [u64; 3] = [7, 30, 90];
pub const KEEP_DEFAULT: u64 = 30;
/// The chart breaks its line where two readings are further apart than this (at least; see `gap_s`).
pub const GAP_MIN_S: u64 = 2 * 3600;
/// A time before 2000 or after 2100 is not a reading's.
const T_MIN: u64 = 946_684_800;
const T_MAX: u64 = 4_102_444_800;
const HEADER: &str = "kt-battery-history 1";

/// The kept-days setting, snapped to a choice.
pub fn keep_days(v: Option<u64>) -> u64 {
    match v {
        Some(d) if KEEP_CHOICES.contains(&d) => d,
        _ => KEEP_DEFAULT,
    }
}

/// The longest silence the chart still joins with a line: two missed checks at the user's pace, two hours at least.
pub fn gap_s(interval_s: u64) -> u64 {
    GAP_MIN_S.max(interval_s.saturating_mul(3))
}

/// One recorded moment: a level (never Unknown), or None — the device was away or asleep from here on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rec {
    /// UTC seconds.
    pub t: u64,
    pub level: Option<Level>,
    pub charging: Charging,
}

impl Rec {
    pub fn pct(&self) -> Option<u8> {
        match self.level {
            Some(Level::Exact(p)) => Some(p.get()),
            _ => None,
        }
    }
}

/// What the loop saw of a device just now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Seen {
    /// It answered with a level (Unknown is not recorded).
    Live(Level, Charging),
    /// It is asleep or not connected.
    Away,
}

fn key_ok(k: &str) -> bool {
    !k.is_empty() && k.len() <= MAX_KEY && !k.chars().any(char::is_control)
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct History {
    devices: BTreeMap<String, VecDeque<Rec>>,
}

impl History {
    pub fn new() -> History {
        History::default()
    }

    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.devices.keys()
    }

    pub fn len(&self, key: &str) -> usize {
        self.devices.get(key).map_or(0, VecDeque::len)
    }

    /// Records what was seen when the policy says so; whether something was recorded. `keep_s`: how long readings stay.
    pub fn observe(&mut self, key: &str, now: u64, seen: Seen, keep_s: u64) -> bool {
        if !key_ok(key) || !(T_MIN..=T_MAX).contains(&now) {
            return false;
        }
        let rec = match seen {
            Seen::Live(Level::Unknown, _) => return false,
            Seen::Live(l, c) => Rec { t: now, level: Some(l), charging: c },
            Seen::Away => Rec { t: now, level: None, charging: Charging::Unknown },
        };
        if let Some(ring) = self.devices.get_mut(key) {
            // (A clock set back by more than an hour: the «future» readings go; a smaller step back waits for the clock.)
            while ring.back().map_or(false, |r| r.t > now + 3600) {
                ring.pop_back();
            }
            if let Some(last) = ring.back() {
                if now < last.t {
                    return false;
                }
                let elapsed = now - last.t;
                match (last.level, rec.level) {
                    // (Away once is enough; back from away is always recorded.)
                    (None, None) => return false,
                    (None, Some(_)) => {}
                    (Some(_), None) => {}
                    (Some(a), Some(b)) => {
                        if elapsed < MIN_STEP_S {
                            return false;
                        }
                        if elapsed < REGULAR_S && a == b && last.charging == rec.charging {
                            return false;
                        }
                    }
                }
            } else if rec.level.is_none() {
                return false;
            }
        } else if rec.level.is_none() {
            // (Nothing to close: a device first seen away has no line to break.)
            return false;
        }
        if !self.devices.contains_key(key) && self.devices.len() >= MAX_DEVICES {
            // (The device seen longest ago makes room.)
            if let Some(old) = self.devices.iter().min_by_key(|(_, r)| r.back().map_or(0, |x| x.t)).map(|(k, _)| k.clone()) {
                self.devices.remove(&old);
            }
        }
        let ring = self.devices.entry(key.to_string()).or_default();
        ring.push_back(rec);
        while ring.len() > MAX_PER_DEVICE {
            ring.pop_front();
        }
        self.prune(now, keep_s);
        true
    }

    /// Readings older than `keep_s` (or more than an hour in the future) dropped; empty devices forgotten.
    pub fn prune(&mut self, now: u64, keep_s: u64) {
        let from = now.saturating_sub(keep_s);
        for ring in self.devices.values_mut() {
            ring.retain(|r| r.t >= from && r.t <= now + 3600);
            // (A ring that now starts with «away» has nothing before it to close.)
            while ring.front().map_or(false, |r| r.level.is_none()) {
                ring.pop_front();
            }
        }
        self.devices.retain(|_, r| !r.is_empty());
    }

    /// One device's readings in [since, until], oldest first.
    pub fn points(&self, key: &str, since: u64, until: u64) -> Vec<Rec> {
        self.devices.get(key).map(|r| r.iter().filter(|x| x.t >= since && x.t <= until).copied().collect()).unwrap_or_default()
    }

    pub fn clear(&mut self, key: &str) -> bool {
        self.devices.remove(key).is_some()
    }

    pub fn clear_all(&mut self) {
        self.devices.clear();
    }

    /// The file's text: a header, one row per reading (the key in hex, so no key can break a row), a checked footer.
    pub fn serialize(&self) -> String {
        let mut body = String::new();
        let mut n = 0usize;
        for (k, ring) in &self.devices {
            let hk = hex(k);
            for r in ring {
                body.push_str(&format!("{}\t{}\t{}\t{}\n", hk, r.t, level_code(r.level), r.charging.as_str()));
                n += 1;
            }
        }
        format!("{}\n{}end\t{}\t{:016x}\n", HEADER, body, n, fnv(body.as_bytes()))
    }

    /// The file read back, or None when it is not one of ours whole (too large, wrong header, a bad row, a count or hash
    /// that does not match, cut short): the caller then starts afresh. Old readings are pruned.
    pub fn parse(text: &str, now: u64, keep_s: u64) -> Option<History> {
        if text.len() > MAX_FILE {
            return None;
        }
        let rest = text.strip_prefix(HEADER)?.strip_prefix('\n')?;
        let body_end = rest.rfind("end\t")?;
        if body_end != 0 && !rest[..body_end].ends_with('\n') {
            return None;
        }
        let (body, foot) = rest.split_at(body_end);
        let foot = foot.strip_suffix('\n')?;
        let mut f = foot.split('\t');
        let (_, count, hash) = (f.next()?, f.next()?.parse::<usize>().ok()?, u64::from_str_radix(f.next()?, 16).ok()?);
        if f.next().is_some() || hash != fnv(body.as_bytes()) {
            return None;
        }
        let mut h = History::new();
        let mut n = 0usize;
        for row in body.lines() {
            let mut c = row.split('\t');
            let key = unhex(c.next()?)?;
            let t: u64 = c.next()?.parse().ok()?;
            let level = parse_level(c.next()?)?;
            let charging = match c.next()? {
                "yes" => Charging::Yes,
                "no" => Charging::No,
                "unknown" => Charging::Unknown,
                _ => return None,
            };
            if c.next().is_some() || !key_ok(&key) || !(T_MIN..=T_MAX).contains(&t) {
                return None;
            }
            let ring = h.devices.entry(key).or_default();
            if ring.back().map_or(false, |r| r.t > t) {
                return None;
            }
            ring.push_back(Rec { t, level, charging });
            if ring.len() > MAX_PER_DEVICE {
                ring.pop_front();
            }
            n += 1;
        }
        if n != count || h.devices.len() > MAX_DEVICES {
            return None;
        }
        h.prune(now, keep_s);
        Some(h)
    }
}

fn level_code(l: Option<Level>) -> String {
    match l {
        None => "away".into(),
        Some(Level::Exact(p)) => format!("p{}", p.get()),
        Some(Level::Steps(s)) => format!("s{}/{}", s.n(), s.max()),
        Some(Level::Coarse(c)) => format!("c{}", c.as_str()),
        Some(Level::Unknown) => "away".into(),
    }
}

fn parse_level(s: &str) -> Option<Option<Level>> {
    if s == "away" {
        return Some(None);
    }
    if let Some(p) = s.strip_prefix('p') {
        return Percent::new(p.parse().ok()?).map(|p| Some(Level::Exact(p)));
    }
    if let Some(st) = s.strip_prefix('s') {
        let (n, m) = st.split_once('/')?;
        return Steps::new(n.parse().ok()?, m.parse().ok()?).map(|s| Some(Level::Steps(s)));
    }
    let c = match s.strip_prefix('c')? {
        "empty" => Coarse::Empty,
        "low" => Coarse::Low,
        "medium" => Coarse::Medium,
        "high" => Coarse::High,
        "full" => Coarse::Full,
        _ => return None,
    };
    Some(Some(Level::Coarse(c)))
}

fn hex(s: &str) -> String {
    s.bytes().map(|b| format!("{:02x}", b)).collect()
}

fn unhex(s: &str) -> Option<String> {
    if s.is_empty() || s.len() % 2 != 0 || s.len() > MAX_KEY * 2 {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect();
    String::from_utf8(bytes?).ok()
}

fn fnv(b: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for x in b {
        h ^= u64::from(*x);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

// ---------------------------------------------------------------- the summary and the estimate

/// What the history view says in words beside its chart: count, first and last, lowest and highest (percentages only;
/// none when the readings in range are not percentages).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub count: usize,
    pub lowest: Option<u8>,
    pub highest: Option<u8>,
    pub first: Option<u8>,
    pub last: Option<u8>,
}

pub fn stats(points: &[Rec]) -> Stats {
    let pcts: Vec<u8> = points.iter().filter_map(Rec::pct).collect();
    Stats {
        count: points.iter().filter(|r| r.level.is_some()).count(),
        lowest: pcts.iter().min().copied(),
        highest: pcts.iter().max().copied(),
        first: pcts.first().copied(),
        last: pcts.last().copied(),
    }
}

/// Why there is no estimate (said in the history view; the card says nothing).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
    /// Too few readings, or too short a stretch, of one discharge (or charge).
    Collecting,
    /// The level hardly moves.
    Flat,
    /// The last reading is too old, or the device is away.
    Stale,
    /// The device gives no percentage (a coarse word or steps).
    NotPercent,
    /// Charging, with too little to say when it will be full.
    Charging,
}

impl Why {
    pub fn as_str(self) -> &'static str {
        match self {
            Why::Collecting => "collecting",
            Why::Flat => "flat",
            Why::Stale => "stale",
            Why::NotPercent => "notPercent",
            Why::Charging => "charging",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Estimate {
    /// About this many minutes until empty, at `per_hour` percentage points an hour from `samples` readings.
    Empty { minutes: u32, per_hour: f64, samples: usize },
    /// About this many minutes until full (charging known), likewise.
    Full { minutes: u32, per_hour: f64, samples: usize },
    None(Why),
}

/// The original's discharge rules: a stretch of at least 4 readings over at least 2 hours, no gap over 4 hours, no rise
/// over one point, no fall over 25 at once, no charging; at least 3 points lost; between 0.02 and 12 points an hour;
/// at most 90 days. The last reading must be at most 3 hours old.
pub const EMPTY_MIN_SAMPLES: usize = 4;
pub const EMPTY_MIN_SPAN_S: u64 = 2 * 3600;
const LINK_MAX_S: u64 = 4 * 3600;
const STALE_S: u64 = 3 * 3600;
/// Charging (ours): at least 4 readings over at least 15 minutes, no gap over an hour, at least 3 points gained,
/// between 1 and 300 points an hour; at most a day.
pub const FULL_MIN_SAMPLES: usize = 4;
pub const FULL_MIN_SPAN_S: u64 = 15 * 60;
const FULL_LINK_MAX_S: u64 = 3600;

pub fn estimate(points: &[Rec], now: u64) -> Estimate {
    let Some(latest) = points.last() else { return Estimate::None(Why::Collecting) };
    if latest.level.is_none() || latest.t > now + 300 || now.saturating_sub(latest.t) > STALE_S {
        return Estimate::None(Why::Stale);
    }
    let Some(pct) = latest.pct() else { return Estimate::None(Why::NotPercent) };
    if latest.charging == Charging::Yes {
        return full(points, pct);
    }
    if pct == 0 {
        return Estimate::None(Why::Flat);
    }
    let mut start = points.len() - 1;
    while start > 0 {
        let (prev, cur) = (&points[start - 1], &points[start]);
        let (Some(a), Some(b)) = (prev.pct(), cur.pct()) else { break };
        let gap = cur.t.saturating_sub(prev.t);
        let diff = i16::from(b) - i16::from(a);
        if prev.charging == Charging::Yes || cur.charging == Charging::Yes || gap == 0 || gap > LINK_MAX_S || diff > 1 || diff < -25 {
            break;
        }
        start -= 1;
    }
    let samples = points.len() - start;
    let span = latest.t - points[start].t;
    if samples < EMPTY_MIN_SAMPLES || span < EMPTY_MIN_SPAN_S {
        return Estimate::None(Why::Collecting);
    }
    let first = points[start].pct().unwrap_or(pct);
    if first < pct + 3 {
        return Estimate::None(Why::Flat);
    }
    let per_hour = f64::from(first - pct) / (span as f64 / 3600.0);
    if !(0.02..=12.0).contains(&per_hour) {
        return Estimate::None(Why::Flat);
    }
    let hours = f64::from(pct) / per_hour;
    if !hours.is_finite() || hours > 90.0 * 24.0 {
        return Estimate::None(Why::Flat);
    }
    Estimate::Empty { minutes: (hours * 60.0).round() as u32, per_hour, samples }
}

fn full(points: &[Rec], pct: u8) -> Estimate {
    if pct >= 100 {
        return Estimate::None(Why::Charging);
    }
    let mut start = points.len() - 1;
    while start > 0 {
        let (prev, cur) = (&points[start - 1], &points[start]);
        let (Some(a), Some(b)) = (prev.pct(), cur.pct()) else { break };
        let gap = cur.t.saturating_sub(prev.t);
        let diff = i16::from(b) - i16::from(a);
        if prev.charging != Charging::Yes || gap == 0 || gap > FULL_LINK_MAX_S || diff < -1 || diff > 25 {
            break;
        }
        start -= 1;
    }
    let samples = points.len() - start;
    let span = points[points.len() - 1].t - points[start].t;
    let first = points[start].pct().unwrap_or(pct);
    if samples < FULL_MIN_SAMPLES || span < FULL_MIN_SPAN_S || pct < first + 3 {
        return Estimate::None(Why::Charging);
    }
    let per_hour = f64::from(pct - first) / (span as f64 / 3600.0);
    if !(1.0..=300.0).contains(&per_hour) {
        return Estimate::None(Why::Charging);
    }
    let hours = f64::from(100 - pct) / per_hour;
    if !hours.is_finite() || hours > 24.0 {
        return Estimate::None(Why::Charging);
    }
    Estimate::Full { minutes: ((hours * 60.0).round() as u32).max(1), per_hour, samples }
}

/// The chart's runs: indexes [from, to] of readings joined by a line — split at «away», at a change of kind (a
/// percentage, steps, a coarse word) and where two readings are more than `gap` apart.
pub fn runs(points: &[Rec], gap: u64) -> Vec<(usize, usize)> {
    let kind = |l: &Level| match l {
        Level::Exact(_) => 0u8,
        Level::Steps(s) => 10 + s.max(),
        Level::Coarse(_) => 1,
        Level::Unknown => 2,
    };
    let mut out = Vec::new();
    let mut from: Option<usize> = None;
    for (i, r) in points.iter().enumerate() {
        match (from, r.level) {
            (_, None) => {
                if let Some(f) = from.take() {
                    out.push((f, i - 1));
                }
            }
            (None, Some(_)) => from = Some(i),
            (Some(f), Some(l)) => {
                let p = &points[i - 1];
                if r.t.saturating_sub(p.t) > gap || p.level.map(|x| kind(&x)) != Some(kind(&l)) {
                    out.push((f, i - 1));
                    from = Some(i);
                }
            }
        }
    }
    if let Some(f) = from {
        out.push((f, points.len() - 1));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_795_000_000;
    const KEEP: u64 = 30 * 86_400;
    fn ex(p: i64) -> Level {
        Level::Exact(Percent::new(p).unwrap())
    }
    fn live(p: i64) -> Seen {
        Seen::Live(ex(p), Charging::No)
    }
    fn rec(hours_ago: u64, p: i64, ch: bool) -> Rec {
        Rec { t: NOW - hours_ago * 3600, level: Some(ex(p)), charging: if ch { Charging::Yes } else { Charging::No } }
    }
    fn mins(m_ago: u64, p: i64, ch: bool) -> Rec {
        Rec { t: NOW - m_ago * 60, level: Some(ex(p)), charging: if ch { Charging::Yes } else { Charging::No } }
    }

    #[test]
    fn records_on_change_on_interval_and_never_twice_a_minute() {
        let mut h = History::new();
        let t = NOW - 7200;
        assert!(h.observe("hid:a", t, live(85), KEEP));
        assert!(!h.observe("hid:a", t, live(85), KEEP), "same moment");
        assert!(!h.observe("hid:a", t + 10, Seen::Live(ex(80), Charging::Yes), KEEP), "under a minute, even a change");
        assert!(!h.observe("hid:a", t + 100, live(85), KEEP), "no change, under half an hour");
        assert!(h.observe("hid:a", t + 100, Seen::Live(ex(85), Charging::Yes), KEEP), "charging flipped");
        assert!(!h.observe("hid:a", t + 150, live(84), KEEP), "a minute's wait");
        assert!(h.observe("hid:a", t + 220, live(84), KEEP), "level changed");
        assert!(!h.observe("hid:a", t + 300, live(84), KEEP));
        assert!(h.observe("hid:a", t + 220 + REGULAR_S, live(84), KEEP), "the regular half hour");
        assert!(h.observe("bt:b", t + 600, live(70), KEEP), "another device is its own");
        assert_eq!(h.len("hid:a"), 4);
        assert!(!h.observe("hid:a", t + 3000, Seen::Live(Level::Unknown, Charging::No), KEEP), "unknown is not recorded");
        assert!(!h.observe("", t, live(5), KEEP) && !h.observe("a\nb", t, live(5), KEEP), "keys checked");
        assert!(!h.observe("hid:a", 5, live(5), KEEP), "a time before 2000");
    }

    #[test]
    fn away_is_a_mark_once_and_back_is_recorded() {
        let mut h = History::new();
        assert!(!h.observe("k", NOW - 900, Seen::Away, KEEP), "first seen away: nothing to close");
        assert!(h.observe("k", NOW - 800, live(50), KEEP));
        assert!(h.observe("k", NOW - 790, Seen::Away, KEEP), "away right away is still a mark");
        assert!(!h.observe("k", NOW - 500, Seen::Away, KEEP), "once");
        assert!(h.observe("k", NOW - 495, live(50), KEEP), "back: recorded at once, same level or not");
        let p = h.points("k", 0, NOW);
        assert_eq!(p.iter().map(|r| r.level.is_some()).collect::<Vec<_>>(), vec![true, false, true]);
        assert_eq!(runs(&p, GAP_MIN_S), vec![(0, 0), (2, 2)]);
    }

    #[test]
    fn coarse_and_steps_are_kept_as_they_are() {
        let mut h = History::new();
        let st = Level::Steps(Steps::new(3, 5).unwrap());
        assert!(h.observe("pad", NOW - 4000, Seen::Live(st, Charging::Unknown), KEEP));
        assert!(h.observe("pad", NOW - 3000, Seen::Live(Level::Coarse(Coarse::Medium), Charging::No), KEEP));
        let p = h.points("pad", 0, NOW);
        assert_eq!(p[0].level, Some(st));
        assert_eq!(p[0].pct(), None);
        assert_eq!(stats(&p), Stats { count: 2, lowest: None, highest: None, first: None, last: None });
        assert_eq!(estimate(&p, NOW), Estimate::None(Why::NotPercent));
        assert_eq!(runs(&p, GAP_MIN_S), vec![(0, 0), (1, 1)], "a change of kind breaks the line");
        let back = History::parse(&h.serialize(), NOW, KEEP).unwrap();
        assert_eq!(back, h);
    }

    #[test]
    fn file_round_trip_and_damage_starts_afresh() {
        let mut h = History::new();
        h.observe("hid:Mysz:ą🎧 x", NOW - 7200, live(85), KEEP);
        h.observe("hid:Mysz:ą🎧 x", NOW - 3000, Seen::Live(ex(80), Charging::Yes), KEEP);
        h.observe("hid:Mysz:ą🎧 x", NOW - 2000, Seen::Away, KEEP);
        h.observe("bt:other", NOW - 100, live(70), KEEP);
        let text = h.serialize();
        assert!(text.starts_with("kt-battery-history 1\n") && text.lines().count() == 6);
        assert_eq!(History::parse(&text, NOW, KEEP), Some(h.clone()));
        // (Cut short, a flipped character, an extra row, a wrong header, a bad level, junk: none read.)
        assert_eq!(History::parse(&text[..text.len() - 5], NOW, KEEP), None);
        assert_eq!(History::parse(&text.replacen("\tp85\t", "\tp86\t", 1), NOW, KEEP), None, "hash");
        let extra = text.replacen("end\t", "626f6f\t1795000000\tp5\tno\nend\t", 1);
        assert_eq!(History::parse(&extra, NOW, KEEP), None, "row not in the hash");
        assert_eq!(History::parse(&text.replacen("history 1", "history 9", 1), NOW, KEEP), None);
        assert_eq!(History::parse("", NOW, KEEP), None);
        assert_eq!(History::parse("\u{0}\u{1}garbage", NOW, KEEP), None);
        let big = "x".repeat(MAX_FILE + 1);
        assert_eq!(History::parse(&big, NOW, KEEP), None, "too large");
        // (A hand-made file with a bad level but a matching hash is still refused.)
        let body = "6b\t1795000000\tp101\tno\n";
        let forged = format!("kt-battery-history 1\n{}end\t1\t{:016x}\n", body, fnv(body.as_bytes()));
        assert_eq!(History::parse(&forged, NOW, KEEP), None);
        let body = "6b\t1795000000\tp55\tno\n";
        let good = format!("kt-battery-history 1\n{}end\t1\t{:016x}\n", body, fnv(body.as_bytes()));
        assert_eq!(History::parse(&good, NOW, KEEP).map(|h| h.len("k")), Some(1));
        assert_eq!(History::parse("kt-battery-history 1\nend\t0\tcbf29ce484222325\n", NOW, KEEP), Some(History::new()), "an empty file");
    }

    #[test]
    fn bounded_in_age_ring_and_devices() {
        let mut h = History::new();
        assert!(h.observe("old", NOW - KEEP - 1, live(30), KEEP));
        assert!(h.observe("fresh", NOW, live(70), KEEP));
        assert_eq!(h.keys().collect::<Vec<_>>(), vec!["fresh"], "older than kept: gone");
        let mut ring = History::new();
        for i in 0..(MAX_PER_DEVICE as u64 + 50) {
            ring.observe("k", NOW - 400_000 + i * 61, live((i % 2) as i64 + 40), 90 * 86_400);
        }
        assert_eq!(ring.len("k"), MAX_PER_DEVICE);
        let mut many = History::new();
        for i in 0..(MAX_DEVICES as u64 + 5) {
            many.observe(&format!("d{i}"), NOW - 10_000 + i, live(50), KEEP);
        }
        assert_eq!(many.keys().count(), MAX_DEVICES);
        assert!(!many.keys().any(|k| k == "d0") && many.keys().any(|k| k == "d68"), "the one seen longest ago went");
        // (Fewer days kept: pruned at the next look.)
        let mut p = History::new();
        p.observe("k", NOW - 20 * 86_400, live(60), KEEP);
        p.observe("k", NOW - 3600, live(50), KEEP);
        p.prune(NOW, 7 * 86_400);
        assert_eq!(p.len("k"), 1);
        assert!(p.clear("k") && p.keys().count() == 0 && !p.clear("k"));
        assert_eq!(keep_days(Some(90)), 90);
        assert_eq!(keep_days(Some(31)), 30);
        assert_eq!(keep_days(None), 30);
    }

    #[test]
    fn clock_steps() {
        let mut h = History::new();
        assert!(h.observe("k", NOW, live(50), KEEP));
        assert!(!h.observe("k", NOW - 600, live(49), KEEP), "a small step back waits");
        assert!(h.observe("k", NOW - 7200, live(48), KEEP), "set back by hours: the future readings go");
        assert_eq!(h.points("k", 0, u64::MAX).len(), 1);
    }

    #[test]
    fn estimate_as_the_original() {
        let e = estimate(&[rec(8, 80, false), rec(6, 77, false), rec(4, 74, false), rec(2, 71, false), rec(0, 68, false)], NOW);
        match e {
            Estimate::Empty { minutes, per_hour, samples } => {
                assert_eq!(samples, 5);
                assert!((per_hour - 1.5).abs() < 0.01);
                assert_eq!(minutes, (68.0 / 1.5 * 60.0f64).round() as u32);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(estimate(&[rec(2, 65, false), rec(1, 64, false)], NOW), Estimate::None(Why::Collecting));
        assert_eq!(estimate(&[rec(8, 68, false), rec(6, 68, false), rec(4, 67, false), rec(0, 67, false)], NOW), Estimate::None(Why::Flat));
        assert_eq!(estimate(&[rec(16, 80, false), rec(14, 77, false), rec(12, 74, false), rec(10, 71, false)], NOW), Estimate::None(Why::Stale));
        // (A charging phase does not pollute the discharge after it.)
        match estimate(&[rec(18, 26, false), rec(16, 80, true), rec(12, 90, true), rec(9, 91, false), rec(6, 87, false), rec(3, 84, false), rec(0, 80, false)], NOW) {
            Estimate::Empty { samples, .. } => assert_eq!(samples, 4),
            other => panic!("{other:?}"),
        }
        // (A long gap ends the stretch; a sudden jump starts a new one.)
        assert_eq!(estimate(&[rec(30, 90, false), rec(27, 87, false), rec(24, 84, false), rec(0, 80, false)], NOW), Estimate::None(Why::Collecting));
        match estimate(&[rec(15, 48, false), rec(12, 89, false), rec(9, 87, false), rec(6, 85, false), rec(3, 83, false), rec(0, 81, false)], NOW) {
            Estimate::Empty { samples, .. } => assert_eq!(samples, 5),
            other => panic!("{other:?}"),
        }
        assert_eq!(estimate(&[rec(7, 50, false), rec(6, 50, false), rec(5, 50, false), rec(0, 50, false)], NOW), Estimate::None(Why::Collecting), "as the original: Insufficient (the 5-hour gap)");
        assert_eq!(estimate(&[rec(6, 50, false), rec(4, 50, false), rec(2, 50, false), rec(0, 50, false)], NOW), Estimate::None(Why::Flat));
        assert_eq!(estimate(&[], NOW), Estimate::None(Why::Collecting));
        // (Away last, or charging unknown counted as not charging.)
        let mut away = vec![rec(8, 80, false), rec(6, 77, false), rec(4, 74, false), rec(2, 71, false)];
        away.push(Rec { t: NOW - 60, level: None, charging: Charging::Unknown });
        assert_eq!(estimate(&away, NOW), Estimate::None(Why::Stale));
        let unk: Vec<Rec> = [rec(8, 80, false), rec(6, 77, false), rec(4, 74, false), rec(0, 68, false)].iter().map(|r| Rec { charging: Charging::Unknown, ..*r }).collect();
        assert!(matches!(estimate(&unk, NOW), Estimate::Empty { .. }));
        // (A drop too fast to be true says nothing.)
        assert_eq!(estimate(&[rec(3, 100, false), mins(150, 75, false), mins(130, 50, false), mins(120, 30, false), rec(0, 10, false)], NOW), Estimate::None(Why::Flat));
    }

    #[test]
    fn estimate_full_while_charging() {
        // (40 % to 52 % in 30 minutes: 24 points an hour, 48 left — about two hours.)
        let pts = [mins(30, 40, true), mins(20, 44, true), mins(10, 48, true), mins(0, 52, true)];
        match estimate(&pts, NOW) {
            Estimate::Full { minutes, per_hour, samples } => {
                assert_eq!(samples, 4);
                assert!((per_hour - 24.0).abs() < 0.01);
                assert_eq!(minutes, 120);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(estimate(&[mins(6, 40, true), mins(4, 41, true), mins(2, 42, true), mins(0, 43, true)], NOW), Estimate::None(Why::Charging), "too short");
        assert_eq!(estimate(&[mins(1, 99, true), mins(0, 100, true)], NOW), Estimate::None(Why::Charging), "full");
        // (Charging just began after a discharge: the discharge readings do not count.)
        assert_eq!(estimate(&[mins(90, 60, false), mins(60, 58, false), mins(30, 56, false), mins(0, 57, true)], NOW), Estimate::None(Why::Charging));
        // (Charging unknown never gives «full in».)
        let unk: Vec<Rec> = pts.iter().map(|r| Rec { charging: Charging::Unknown, ..*r }).collect();
        assert!(!matches!(estimate(&unk, NOW), Estimate::Full { .. }));
    }

    #[test]
    fn runs_break_at_gaps() {
        let p = [rec(10, 90, false), rec(9, 89, false), rec(5, 80, false), rec(4, 79, false)];
        assert_eq!(runs(&p, GAP_MIN_S), vec![(0, 1), (2, 3)]);
        assert_eq!(runs(&p, gap_s(3600 * 2)), vec![(0, 3)], "a slow pace joins wider");
        assert_eq!(runs(&[], GAP_MIN_S), vec![]);
        assert_eq!(gap_s(60), GAP_MIN_S);
    }
}
