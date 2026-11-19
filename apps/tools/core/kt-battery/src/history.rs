// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery), W2: a device's battery history and the time-left estimate.
// Derived from Wireless Device Battery Monitor (now BatteryHub) v1.1.0, src/history_model.h and src/runtime_estimate.h,
// by krisgfx9 and its contributors, GPL-3.0-or-later.
// Changed here: a reading keeps its own kind — a coarse word or «n of max» steps is stored as it is, never as a made-up
// percentage, and only exact percentages feed the estimate; «away» (asleep or not connected) is recorded as a mark so
// the chart shows a gap instead of a line across a time nobody saw; charging may be unknown (it never counts as
// charging); a level is also recorded when it changes (at most once a minute per device), not only every half hour;
// each device has its own bounded ring (and the devices are bounded, and all rows together: MAX_ROWS, so the file always
// fits its bound); the file is one text file with a header and a checked footer (a count and an FNV-1a hash): a damaged
// file is set aside (`.bad`, one kept) and started afresh, never half-read; how long readings are
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
/// The file's bound (format 2); a larger one is not read (set aside, started afresh).
pub const MAX_FILE: usize = 4 * 1024 * 1024;
/// A format-1 file (each row carrying its device's key) may be up to this and is still read, then trimmed to MAX_ROWS.
pub const MAX_FILE_V1: usize = 16 * 1024 * 1024;
/// The longest row of format 2: a 10-digit time, a tab, the longest level («cmedium», 7), a tab, y|n|u, a newline.
pub const MAX_ROW_BYTES: usize = 10 + 1 + 7 + 1 + 1 + 1;
/// The longest device section line: «k», a tab, the key in hex, a newline.
pub const MAX_SECTION_BYTES: usize = 2 + 2 * MAX_KEY + 1;
/// All the rows kept, every device together (the oldest go first, whichever device they are of): the worst case —
/// MAX_DEVICES sections of the longest key, MAX_ROWS rows of the longest kind, the header and the footer — fits
/// MAX_FILE (21 × 170,000 + 64 × 403 + 64 < 4 MiB; checked by a test).
pub const MAX_ROWS: usize = 170_000;
/// How long readings may be kept (days), and the default (the original's 30).
pub const KEEP_CHOICES: [u64; 3] = [7, 30, 90];
pub const KEEP_DEFAULT: u64 = 30;
/// The chart breaks its line where two readings are further apart than this (at least; see `gap_s`).
pub const GAP_MIN_S: u64 = 2 * 3600;
/// A time before 2000 or after 2100 is not a reading's.
const T_MIN: u64 = 946_684_800;
const T_MAX: u64 = 4_102_444_800;
const HEADER: &str = "kt-battery-history 2";
const HEADER_V1: &str = "kt-battery-history 1";

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
        self.trim_rows(MAX_ROWS);
        true
    }

    /// Every row, every device together.
    pub fn rows(&self) -> usize {
        self.devices.values().map(VecDeque::len).sum()
    }

    /// At most `max` rows: the oldest dropped first, whichever device they are of (a ring left starting with «away»
    /// loses that mark too; an empty device is forgotten).
    pub fn trim_rows(&mut self, max: usize) {
        let mut total = self.rows();
        while total > max {
            let Some(k) = self.devices.iter().filter(|(_, r)| !r.is_empty()).min_by_key(|(_, r)| r.front().map_or(u64::MAX, |x| x.t)).map(|(k, _)| k.clone()) else { break };
            let Some(ring) = self.devices.get_mut(&k) else { break };
            ring.pop_front();
            total -= 1;
            while ring.front().map_or(false, |r| r.level.is_none()) {
                ring.pop_front();
                total -= 1;
            }
            if ring.is_empty() {
                self.devices.remove(&k);
            }
        }
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

    /// The file's text (format 2): a header; per device a section line (its key in hex, so no key can break a line),
    /// then its rows «time, level, y|n|u»; a checked footer (the rows' count and the body's hash). Never larger than
    /// MAX_FILE: should it be (it cannot while MAX_ROWS holds), the oldest rows are dropped until it fits.
    pub fn serialize(&self) -> String {
        let text = self.render();
        if text.len() <= MAX_FILE {
            return text;
        }
        let mut h = self.clone();
        let mut text = text;
        while text.len() > MAX_FILE && h.rows() > 0 {
            // (A row is at least 16 bytes: dropping this many takes off at least the excess.)
            let drop = (text.len() - MAX_FILE) / 16 + 1;
            h.trim_rows(h.rows().saturating_sub(drop));
            text = h.render();
        }
        text
    }

    fn render(&self) -> String {
        let mut body = String::new();
        let mut n = 0usize;
        for (k, ring) in &self.devices {
            if ring.is_empty() {
                continue;
            }
            body.push_str("k\t");
            body.push_str(&hex(k));
            body.push('\n');
            for r in ring {
                let c = match r.charging {
                    Charging::Yes => 'y',
                    Charging::No => 'n',
                    Charging::Unknown => 'u',
                };
                body.push_str(&format!("{}\t{}\t{}\n", r.t, level_code(r.level), c));
                n += 1;
            }
        }
        format!("{}\n{}end\t{}\t{:016x}\n", HEADER, body, n, fnv(body.as_bytes()))
    }

    /// The file read back, or None when it is not one of ours whole (too large, wrong header, a bad row, a count or hash
    /// that does not match, cut short): the caller then sets it aside and starts afresh. Format 2, or format 1 (up to
    /// MAX_FILE_V1). Old readings are pruned, and at most MAX_ROWS rows kept (the oldest dropped).
    pub fn parse(text: &str, now: u64, keep_s: u64) -> Option<History> {
        let mut h = if text.starts_with(HEADER_V1) {
            if text.len() > MAX_FILE_V1 {
                return None;
            }
            parse_v1(text)?
        } else {
            if text.len() > MAX_FILE {
                return None;
            }
            parse_v2(text)?
        };
        h.prune(now, keep_s);
        h.trim_rows(MAX_ROWS);
        Some(h)
    }

    /// The file at `path` read (History::parse): a missing file is an empty history; one too large or unreadable as
    /// ours is set aside (`set_aside`, one `.bad` kept) and an empty history begins — never half-read, never silently
    /// overwritten. A file that cannot be opened just now (another program holds it) is left where it is.
    pub fn load_file(path: &std::path::Path, now: u64, keep_s: u64) -> History {
        let Ok(meta) = std::fs::metadata(path) else { return History::new() };
        if !meta.is_file() {
            return History::new();
        }
        if meta.len() > MAX_FILE_V1 as u64 {
            set_aside(path);
            return History::new();
        }
        let Ok(bytes) = std::fs::read(path) else { return History::new() };
        match String::from_utf8(bytes).ok().and_then(|t| History::parse(&t, now, keep_s)) {
            Some(h) => h,
            None => {
                set_aside(path);
                History::new()
            }
        }
    }
}

/// Where a damaged history file is kept: the same name with «.bad» after it.
pub fn bad_path(path: &std::path::Path) -> std::path::PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(".bad");
    std::path::PathBuf::from(s)
}

/// The file at `path` moved aside to `bad_path` (an earlier one there replaced: one kept); whether it was.
pub fn set_aside(path: &std::path::Path) -> bool {
    let bad = bad_path(path);
    let _ = std::fs::remove_file(&bad);
    std::fs::rename(path, &bad).is_ok()
}

/// The body and the rows' count of a file whose header is `header`, when its footer checks out.
fn checked_body<'a>(text: &'a str, header: &str) -> Option<(&'a str, usize)> {
    let rest = text.strip_prefix(header)?.strip_prefix('\n')?;
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
    Some((body, count))
}

fn parse_v2(text: &str) -> Option<History> {
    let (body, count) = checked_body(text, HEADER)?;
    let mut h = History::new();
    let mut n = 0usize;
    let mut cur: Option<String> = None;
    for row in body.lines() {
        if let Some(hk) = row.strip_prefix("k\t") {
            let key = unhex(hk)?;
            // (A key twice, or more devices than kept: not one of ours.)
            if !key_ok(&key) || h.devices.contains_key(&key) || h.devices.len() >= MAX_DEVICES {
                return None;
            }
            h.devices.insert(key.clone(), VecDeque::new());
            cur = Some(key);
            continue;
        }
        let ring = h.devices.get_mut(cur.as_deref()?)?;
        let mut c = row.split('\t');
        let t: u64 = c.next()?.parse().ok()?;
        let level = parse_level(c.next()?)?;
        let charging = match c.next()? {
            "y" => Charging::Yes,
            "n" => Charging::No,
            "u" => Charging::Unknown,
            _ => return None,
        };
        if c.next().is_some() || !(T_MIN..=T_MAX).contains(&t) || ring.back().map_or(false, |r| r.t > t) {
            return None;
        }
        ring.push_back(Rec { t, level, charging });
        if ring.len() > MAX_PER_DEVICE {
            ring.pop_front();
        }
        n += 1;
    }
    if n != count {
        return None;
    }
    h.devices.retain(|_, r| !r.is_empty());
    Some(h)
}

/// Format 1: each row «key in hex, time, level, yes|no|unknown».
fn parse_v1(text: &str) -> Option<History> {
    let (body, count) = checked_body(text, HEADER_V1)?;
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
    Some(h)
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
        assert!(text.starts_with("kt-battery-history 2\n") && text.lines().count() == 8, "{}", text);
        assert_eq!(text.matches("\nk\t").count(), 2, "each key once");
        assert_eq!(History::parse(&text, NOW, KEEP), Some(h.clone()));
        // (Cut short, a flipped character, an extra row, a wrong header, a bad level, junk: none read.)
        assert_eq!(History::parse(&text[..text.len() - 5], NOW, KEEP), None);
        assert_eq!(History::parse(&text.replacen("\tp85\t", "\tp86\t", 1), NOW, KEEP), None, "hash");
        let extra = text.replacen("end\t", "626f6f\t1795000000\tp5\tno\nend\t", 1);
        assert_eq!(History::parse(&extra, NOW, KEEP), None, "row not in the hash");
        assert_eq!(History::parse(&text.replacen("history 2", "history 9", 1), NOW, KEEP), None);
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

    /// A history of `devices` devices with keys of the longest length, `per` rows each of the longest kind, the rows of
    /// all devices interleaved in time (device d's row i at BASE + i × 64 + d).
    fn worst(devices: usize, per: usize) -> History {
        keyed(devices, per, MAX_KEY)
    }
    fn keyed(devices: usize, per: usize, key_len: usize) -> History {
        let base = NOW - 80 * 86_400;
        let mut h = History::new();
        for d in 0..devices {
            let key = format!("{:03}{}", d, "k".repeat(key_len - 3));
            let ring: VecDeque<Rec> = (0..per).map(|i| Rec { t: base + (i * 64 + d) as u64, level: Some(Level::Coarse(Coarse::Medium)), charging: Charging::Unknown }).collect();
            h.devices.insert(key, ring);
        }
        h
    }

    #[test]
    fn the_worst_case_fits_the_file_and_reads_back() {
        assert!(MAX_DEVICES * MAX_SECTION_BYTES + MAX_ROWS * MAX_ROW_BYTES + 64 <= MAX_FILE, "the bound holds by arithmetic");
        assert_eq!(format!("{}\t{}\t{}\n", T_MAX - 1, level_code(Some(Level::Coarse(Coarse::Medium))), 'u').len(), MAX_ROW_BYTES);
        let per = MAX_ROWS / MAX_DEVICES;
        let h = worst(MAX_DEVICES, per);
        let text = h.serialize();
        assert!(text.len() <= MAX_FILE, "{} bytes", text.len());
        assert_eq!(text, h.render(), "nothing trimmed: it fits");
        assert_eq!(History::parse(&text, NOW, 90 * 86_400), Some(h));
    }

    #[test]
    fn over_the_bound_the_oldest_rows_go_first() {
        // (observe keeps MAX_ROWS: the oldest row of all — whichever device — goes.)
        let mut h = worst(MAX_DEVICES, MAX_ROWS / MAX_DEVICES);
        let extra = MAX_ROWS - h.rows();
        for (i, d) in h.devices.values_mut().enumerate().take(extra) {
            let t = d.back().unwrap().t;
            d.push_back(Rec { t: t + 1 + i as u64, level: Some(Level::Coarse(Coarse::Medium)), charging: Charging::Unknown });
        }
        assert_eq!(h.rows(), MAX_ROWS);
        let oldest = h.devices.values().filter_map(|r| r.front()).map(|r| r.t).min().unwrap();
        // (Another device's new reading: the oldest row of all goes — device 0's first, not that device's own.)
        let k = h.devices.keys().nth(5).unwrap().clone();
        let before = h.len(&k);
        assert!(h.observe(&k, NOW, live(50), 90 * 86_400));
        assert_eq!(h.rows(), MAX_ROWS);
        assert!(h.devices.values().all(|r| r.front().map_or(true, |x| x.t > oldest)), "the oldest row went");
        assert_eq!(h.len(&k), before + 1);
        // (A history over the bound — 64 devices of 3,300 rows, more than 4 MiB as text: serialize trims oldest-first.)
        let big = worst(MAX_DEVICES, 3_300);
        assert!(big.render().len() > MAX_FILE);
        let text = big.serialize();
        assert!(text.len() <= MAX_FILE, "{} bytes", text.len());
        let back = History::parse(&text, NOW, 90 * 86_400).expect("reads back");
        assert!(back.rows() < big.rows());
        let cut = back.devices.values().filter_map(|r| r.front()).map(|r| r.t).min().unwrap();
        for (k, ring) in &big.devices {
            let kept: Vec<&Rec> = ring.iter().filter(|r| r.t >= cut).collect();
            assert_eq!(back.len(k), kept.len(), "only rows older than every kept one dropped");
        }
    }

    /// The text format 1 wrote (each row with its key).
    fn v1(h: &History) -> String {
        let mut body = String::new();
        let mut n = 0;
        for (k, ring) in &h.devices {
            for r in ring {
                body.push_str(&format!("{}\t{}\t{}\t{}\n", hex(k), r.t, level_code(r.level), r.charging.as_str()));
                n += 1;
            }
        }
        format!("kt-battery-history 1\n{}end\t{}\t{:016x}\n", body, n, fnv(body.as_bytes()))
    }

    #[test]
    fn a_format_1_file_still_loads_and_is_trimmed() {
        let mut h = History::new();
        h.observe("hid:a", NOW - 7200, live(85), KEEP);
        h.observe("hid:a", NOW - 3000, Seen::Live(ex(80), Charging::Yes), KEEP);
        h.observe("bt:b", NOW - 100, live(70), KEEP);
        assert_eq!(History::parse(&v1(&h), NOW, KEEP), Some(h.clone()));
        // (A large format-1 file — more than 4 MiB, more than MAX_ROWS rows: read, then the oldest rows dropped.)
        let big = keyed(MAX_DEVICES, 3_000, 10);
        let t1 = v1(&big);
        assert!(t1.len() > MAX_FILE && t1.len() <= MAX_FILE_V1);
        let back = History::parse(&t1, NOW, 90 * 86_400).expect("format 1 read");
        assert_eq!(back.rows(), MAX_ROWS);
        assert!(back.serialize().len() <= MAX_FILE);
        assert!(History::parse(&format!("kt-battery-history 1\n{}", "x".repeat(MAX_FILE_V1)), NOW, KEEP).is_none(), "beyond 16 MiB: not read");
    }

    #[test]
    fn a_damaged_or_too_large_file_is_set_aside_once() {
        let dir = std::env::temp_dir().join(format!("kt-bat-hist-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("battery-history.txt");
        let bad = bad_path(&p);
        assert_eq!(bad.file_name().unwrap(), "battery-history.txt.bad");
        // (No file: an empty history, nothing set aside.)
        assert_eq!(History::load_file(&p, NOW, KEEP), History::new());
        assert!(!bad.exists());
        // (A good file: read, left where it is.)
        let mut h = History::new();
        h.observe("k", NOW - 100, live(40), KEEP);
        std::fs::write(&p, h.serialize()).unwrap();
        assert_eq!(History::load_file(&p, NOW, KEEP), h);
        assert!(p.exists() && !bad.exists());
        // (Damaged: set aside, an empty history; a second damaged one replaces the first — one kept.)
        std::fs::write(&p, "kt-battery-history 2\nfirst damage").unwrap();
        assert_eq!(History::load_file(&p, NOW, KEEP), History::new());
        assert!(!p.exists() && std::fs::read_to_string(&bad).unwrap().contains("first damage"));
        std::fs::write(&p, [0xFFu8, 0xFE, 0x00]).unwrap();
        assert_eq!(History::load_file(&p, NOW, KEEP), History::new());
        assert_eq!(std::fs::read(&bad).unwrap(), vec![0xFF, 0xFE, 0x00], "the newer damage kept, once");
        let n_bad = std::fs::read_dir(&dir).unwrap().filter(|e| e.as_ref().map_or(false, |e| e.file_name().to_string_lossy().ends_with(".bad"))).count();
        assert_eq!(n_bad, 1);
        // (Too large to read: set aside without reading it.)
        let f = std::fs::File::create(&p).unwrap();
        f.set_len(MAX_FILE_V1 as u64 + 1).unwrap();
        drop(f);
        assert_eq!(History::load_file(&p, NOW, KEEP), History::new());
        assert!(!p.exists() && std::fs::metadata(&bad).unwrap().len() == MAX_FILE_V1 as u64 + 1);
        let _ = std::fs::remove_dir_all(&dir);
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
