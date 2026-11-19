// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery), W3: «Teach me this device» — read only (PLAN-battery §8 item 3). Written
// for Kurokawa Tools.
//
// For a connected HID collection no reader reads, the user watches what the device sends by itself, marks moments
// («full now», «about half», «low», «charging now», «not charging»), and this module proposes which byte (or bits) of
// which input report tracks the battery, and which bit tracks charging, ranked, with the facts for a plain explanation
// and a preview of what each would read now. The pick becomes a definition (defs.rs).
//
// Safety and privacy, enforced here:
// - Never sends anything: a session takes a handle opened to listen (OpenMode::Read) and refuses any other; it calls
//   only `read_input`. allow.rs is not touched.
// - Which collections may be listened to (`verdict`), from the collection's top-level usage page and usage as its report
//   descriptor declares them, and its unit's other collections: never a unit with a digitizer (0x0D); never a keyboard
//   or keypad (page 0x01 usage 0x06 / 0x07, or page 0x07), a pointer or mouse (0x01 usage 0x01 / 0x02), consumer or
//   system-control keys (page 0x0C, 0x01 usage 0x80) — reading those would be reading what the user types or does —,
//   nor a UPS or power supply (0x84 / 0x85); a device a built-in reader handles is sent to that family's switch instead;
//   only vendor-defined pages (0xFF00–0xFFFF), game controllers (0x01 usage 0x04 / 0x05 / 0x08) and generic device
//   controls (page 0x06, where a battery strength lives) are listened to.
// - Captured bytes stay in memory only (this module has no file, no log): a bounded ring (MAX_FRAMES reports of at most
//   MAX_LEN bytes), per-report counts, and the marks' small snapshots; a listening run ends by itself after its time
//   (at most MAX_SECONDS), or once nobody looked at it for IDLE_MS (then its bytes and marks are dropped); dropping the
//   Capture drops everything.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::allow::HidIdent;
use crate::defs::{self, ChargeRule, Definition, Field, Match, Scale};
use crate::model::{Kind, Level};
use crate::transport::{HidTransport, OpenMode, TErr};
use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub const MAX_FRAMES: usize = 2_048;
pub const MAX_LEN: usize = 128;
pub const MAX_IDS: usize = 16;
pub const MAX_MARKS: usize = 24;
pub const DEFAULT_SECONDS: u64 = 600;
pub const MAX_SECONDS: u64 = 1_800;
/// A mark looks at the reports of the last few seconds: their latest bytes, and which bits moved meanwhile (moving bits
/// are a stick, a counter or a clock — not a battery).
pub const MARK_WINDOW_MS: u64 = 5_000;
pub const MOVE_WINDOW_MS: u64 = 2_000;
/// A run nobody looks at — no state poll and no mark for this long (the page polls every second while its sheet is
/// open) — stops itself and drops what it heard: a sheet closed while its start was still on the way never leaves a
/// device listened to.
pub const IDLE_MS: u64 = 30_000;
pub const MAX_LEVEL: usize = 6;
pub const MAX_CHARGE: usize = 4;

/// Whether a collection may be listened to, and if not, why.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Allowed,
    /// A built-in reader handles it: its family's switch instead (the family's id).
    BuiltIn(&'static str),
    Digitizer,
    Keyboard,
    Pointer,
    /// Consumer or system-control keys.
    Keys,
    /// A UPS or power supply.
    Power,
    /// It sends no input report.
    NoInput,
    /// A page not on the list of those listened to.
    NotListed,
    /// Allowed, but this user may not open it (Linux: the node's permissions).
    NoAccess,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Allowed => "allowed",
            Verdict::BuiltIn(_) => "builtin",
            Verdict::Digitizer => "digitizer",
            Verdict::Keyboard => "keyboard",
            Verdict::Pointer => "pointer",
            Verdict::Keys => "keys",
            Verdict::Power => "power",
            Verdict::NoInput => "noInput",
            Verdict::NotListed => "notListed",
            Verdict::NoAccess => "noAccess",
        }
    }
}

/// The rule (the module's header): `id` the collection, `unit` every (page, usage) of its unit, `builtin` the family of
/// a built-in reader that handles this product, `input_len` its input report length.
pub fn verdict(id: &HidIdent, unit: &[(u16, u16)], builtin: Option<&'static str>, input_len: usize) -> Verdict {
    let (p, u) = (id.usage_page, id.usage);
    if p == 0x0D || unit.iter().any(|x| x.0 == 0x0D) {
        return Verdict::Digitizer;
    }
    if let Some(f) = builtin {
        return Verdict::BuiltIn(f);
    }
    if p == 0x07 || (p == 0x01 && (u == 0x06 || u == 0x07)) {
        return Verdict::Keyboard;
    }
    if p == 0x01 && (u == 0x01 || u == 0x02) {
        return Verdict::Pointer;
    }
    if p == 0x0C || (p == 0x01 && u == 0x80) {
        return Verdict::Keys;
    }
    if p == 0x84 || p == 0x85 {
        return Verdict::Power;
    }
    if input_len < 2 {
        return Verdict::NoInput;
    }
    if p >= 0xFF00 || p == 0x06 || (p == 0x01 && matches!(u, 0x04 | 0x05 | 0x08)) {
        Verdict::Allowed
    } else {
        Verdict::NotListed
    }
}

/// One collection the assistant shows: its id (stable while it stays plugged in), its unit's key, its product name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub id: String,
    pub unit: String,
    pub name: String,
    pub ident: HidIdent,
    pub verdict: Verdict,
}

/// The id of a collection: its unit's key and its page, usage and interface.
pub fn target_id(unit: &str, id: &HidIdent) -> String {
    format!("{}|{:04X}:{:04X}:{}", unit, id.usage_page, id.usage, id.interface)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum MarkKind {
    Full,
    Half,
    Low,
    Charging,
    NotCharging,
}

impl MarkKind {
    pub fn parse(s: &str) -> Option<MarkKind> {
        Some(match s {
            "full" => MarkKind::Full,
            "half" => MarkKind::Half,
            "low" => MarkKind::Low,
            "charging" => MarkKind::Charging,
            "notCharging" => MarkKind::NotCharging,
            _ => return None,
        })
    }
    pub fn as_str(self) -> &'static str {
        match self {
            MarkKind::Full => "full",
            MarkKind::Half => "half",
            MarkKind::Low => "low",
            MarkKind::Charging => "charging",
            MarkKind::NotCharging => "notCharging",
        }
    }
    /// The level the user means, in per cent (None: a charging mark).
    pub fn target(self) -> Option<u32> {
        match self {
            MarkKind::Full => Some(100),
            MarkKind::Half => Some(50),
            MarkKind::Low => Some(15),
            _ => None,
        }
    }
}

/// One report id at a mark: its latest bytes, and the bits that moved in the moments before.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snap {
    pub id: u8,
    pub bytes: Vec<u8>,
    pub moved: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mark {
    pub kind: MarkKind,
    pub at: u64,
    pub snaps: Vec<Snap>,
}

#[derive(Clone, Debug, Default)]
struct IdStat {
    count: u64,
    first: u64,
    last_at: u64,
    last: Vec<u8>,
    /// Bits that ever changed while listening (a byte with none is drawn dimmed).
    changed: Vec<u8>,
}

/// One report id as the page shows it live.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub id: u8,
    pub count: u64,
    /// Reports per second, times ten (over the time it has been heard).
    pub rate10: u64,
    pub bytes: Vec<u8>,
    pub changing: Vec<bool>,
}

/// What was heard: in memory only.
#[derive(Debug, Default)]
pub struct Capture {
    frames: VecDeque<(u64, Vec<u8>)>,
    ids: BTreeMap<u8, IdStat>,
    marks: Vec<Mark>,
    pub listening: bool,
    pub gone: bool,
    pub started: u64,
    pub until: u64,
    /// When the page last looked (a state poll or a mark), on the run's clock.
    pub touched: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkErr {
    /// Nothing heard in the last few seconds.
    Quiet,
    TooMany,
}

impl Capture {
    pub fn push(&mut self, t: u64, frame: &[u8]) {
        let Some(&id) = frame.first() else { return };
        if !self.ids.contains_key(&id) && self.ids.len() >= MAX_IDS {
            return;
        }
        let f: Vec<u8> = frame.iter().take(MAX_LEN).copied().collect();
        let st = self.ids.entry(id).or_default();
        if st.count == 0 {
            st.first = t;
            st.changed = vec![0; f.len()];
        } else {
            if st.changed.len() < f.len() {
                st.changed.resize(f.len(), 0);
            }
            for (i, b) in f.iter().enumerate() {
                st.changed[i] |= b ^ st.last.get(i).copied().unwrap_or(*b);
            }
        }
        st.count += 1;
        st.last_at = t;
        st.last = f.clone();
        if self.frames.len() >= MAX_FRAMES {
            self.frames.pop_front();
        }
        self.frames.push_back((t, f));
    }

    /// The live rows, by report id.
    pub fn rows(&self) -> Vec<Row> {
        self.ids
            .iter()
            .map(|(id, s)| {
                let span = s.last_at.saturating_sub(s.first).max(1);
                Row { id: *id, count: s.count, rate10: if s.count > 1 { (s.count - 1) * 10_000 / span } else { 0 }, bytes: s.last.clone(), changing: s.changed.iter().map(|c| *c != 0).collect() }
            })
            .collect()
    }

    /// The latest report of `id`.
    pub fn latest(&self, id: u8) -> Option<&[u8]> {
        self.ids.get(&id).map(|s| s.last.as_slice())
    }

    pub fn marks(&self) -> &[Mark] {
        &self.marks
    }

    /// The page looked at `now` (a state poll): the run keeps going.
    pub fn touch(&mut self, now: u64) {
        self.touched = self.touched.max(now);
    }

    /// Everything heard and marked dropped (the run went idle).
    fn forget(&mut self) {
        self.frames.clear();
        self.ids.clear();
        self.marks.clear();
    }

    /// The user's mark at `now`: a snapshot of every report id heard in the last few seconds.
    pub fn mark(&mut self, kind: MarkKind, now: u64) -> Result<(), MarkErr> {
        self.touch(now);
        if self.marks.len() >= MAX_MARKS {
            return Err(MarkErr::TooMany);
        }
        let mut snaps = Vec::new();
        for (id, st) in &self.ids {
            if now.saturating_sub(st.last_at) > MARK_WINDOW_MS {
                continue;
            }
            let mut moved = vec![0u8; st.last.len()];
            let mut prev: Option<&Vec<u8>> = None;
            for (_, f) in self.frames.iter().filter(|(t, f)| f.first() == Some(id) && now.saturating_sub(*t) <= MOVE_WINDOW_MS) {
                if let Some(p) = prev {
                    for (i, b) in f.iter().enumerate().take(moved.len()) {
                        moved[i] |= b ^ p.get(i).copied().unwrap_or(*b);
                    }
                }
                prev = Some(f);
            }
            snaps.push(Snap { id: *id, bytes: st.last.clone(), moved });
        }
        if snaps.is_empty() {
            return Err(MarkErr::Quiet);
        }
        self.marks.push(Mark { kind, at: now, snaps });
        Ok(())
    }

    pub fn undo_mark(&mut self) -> bool {
        self.marks.pop().is_some()
    }

    pub fn propose(&self) -> Proposal {
        propose(&self.marks, &self.ids.iter().map(|(k, v)| (*k, v.changed.clone())).collect())
    }
}

/// Why a level candidate fits, for the page's plain explanation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fit {
    /// The value's own range is 0..100.
    Percent,
    /// 0..the field's top (255, 127, 15).
    Full,
    /// A few steps, the full mark's value the top.
    Steps,
}

impl Fit {
    pub fn as_str(self) -> &'static str {
        match self {
            Fit::Percent => "percent",
            Fit::Full => "range",
            Fit::Steps => "steps",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LevelCand {
    pub field: Field,
    pub scale: Scale,
    pub fit: Fit,
    /// The value at each level mark, in the marks' order.
    pub values: Vec<(MarkKind, u32)>,
    /// It falls as the battery rises (min above max).
    pub falling: bool,
    /// Only one kind of level mark: it fits, but nothing yet shows it moves with the battery.
    pub weak: bool,
    pub score: i32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChargeCand {
    pub rule: ChargeRule,
    pub score: i32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Proposal {
    pub level: Vec<LevelCand>,
    pub charging: Vec<ChargeCand>,
}

const VARIANTS: &[(u8, u8)] = &[(0xFF, 0), (0x7F, 0), (0x0F, 0), (0xF0, 4)];

/// A value as per cent of a scale.
fn pct(v: u32, lo: u32, hi: u32, falling: bool) -> i64 {
    let span = i64::from(hi.max(lo) - hi.min(lo)).max(1);
    let up = if falling { i64::from(lo) - i64::from(v) } else { i64::from(v) - i64::from(lo) };
    up * 100 / span
}

/// Whether a per cent reading agrees with a mark (loosely: the user only knows roughly).
fn agrees(p: i64, kind: MarkKind) -> bool {
    match kind {
        MarkKind::Full => p >= 70,
        MarkKind::Half => (20..=80).contains(&p),
        MarkKind::Low => p <= 40,
        _ => true,
    }
}

/// The proposals from the marks (pure). `changed`: per report id, the bits that ever changed while listening.
pub fn propose(marks: &[Mark], changed: &BTreeMap<u8, Vec<u8>>) -> Proposal {
    let lv: Vec<&Mark> = marks.iter().filter(|m| m.kind.target().is_some()).collect();
    let mut level: Vec<LevelCand> = Vec::new();
    if !lv.is_empty() {
        let ids: Vec<u8> = lv[0].snaps.iter().map(|s| s.id).filter(|id| lv.iter().all(|m| m.snaps.iter().any(|s| s.id == *id))).collect();
        let mut kinds: Vec<MarkKind> = lv.iter().map(|m| m.kind).collect();
        kinds.sort();
        kinds.dedup();
        let weak = kinds.len() < 2;
        for id in ids {
            // (Every level mark's snapshot of this report — a mark without one leaves the report out, never a panic.)
            let snaps: Vec<&Snap> = lv.iter().filter_map(|m| m.snaps.iter().find(|s| s.id == id)).collect();
            if snaps.len() != lv.len() {
                continue;
            }
            let len = snaps.iter().map(|s| s.bytes.len()).min().unwrap_or(0).min(usize::from(defs::MAX_BYTE) + 1);
            for byte in 1..len {
                let mut best: Option<LevelCand> = None;
                for &(mask, shift) in VARIANTS {
                    if snaps.iter().any(|s| s.moved.get(byte).copied().unwrap_or(0) & mask != 0) {
                        continue;
                    }
                    let field = Field { report: id, byte: byte as u16, mask, shift };
                    let values: Vec<(MarkKind, u32)> = lv.iter().zip(&snaps).map(|(m, s)| (m.kind, u32::from((s.bytes.get(byte).copied().unwrap_or(0) & mask) >> shift))).collect();
                    if let Some(c) = fit(field, &values, weak, changed.get(&id).and_then(|c| c.get(byte)).copied().unwrap_or(0)) {
                        if best.as_ref().map_or(true, |b| c.score > b.score) {
                            best = Some(c);
                        }
                    }
                }
                level.extend(best);
            }
        }
    }
    level.sort_by(|a, b| b.score.cmp(&a.score).then(a.field.report.cmp(&b.field.report)).then(a.field.byte.cmp(&b.field.byte)));
    level.truncate(MAX_LEVEL);
    let charging = propose_charging(marks, level.first().map(|c| c.field));
    Proposal { level, charging }
}

/// One field's values at the level marks: a candidate when they move with the marks and sit in a plausible range.
fn fit(field: Field, values: &[(MarkKind, u32)], weak: bool, changed_bits: u8) -> Option<LevelCand> {
    let top = field.top();
    if top < 2 {
        return None;
    }
    // (Equal marks agree among themselves; different ones are ordered the same way, all rising or all falling.)
    let mut rising = 0;
    let mut falling = 0;
    for (i, a) in values.iter().enumerate() {
        for b in &values[i + 1..] {
            let (ta, tb) = (a.0.target()?, b.0.target()?);
            if ta == tb {
                if a.1.abs_diff(b.1) > (top / 10).max(1) {
                    return None;
                }
                continue;
            }
            let up = (tb > ta) == (b.1 > a.1);
            if a.1 == b.1 {
                return None;
            }
            if up {
                rising += 1;
            } else {
                falling += 1;
            }
        }
    }
    if rising > 0 && falling > 0 {
        return None;
    }
    let fall = falling > 0;
    let max_v = values.iter().map(|v| v.1).max()?;
    let full_v = values.iter().find(|v| v.0 == MarkKind::Full).map(|v| v.1);
    let mut cands: Vec<(Fit, Scale, i32)> = Vec::new();
    // (A few steps: the full mark's value is the top, 2..20 of them.)
    if let Some(fv) = full_v {
        if !fall && (2..=20).contains(&fv) && max_v <= fv {
            cands.push((Fit::Steps, Scale::Linear { min: 0, max: fv, steps: true }, 30));
        }
    }
    if max_v <= 100 && top >= 100 {
        let s = if fall { Scale::Linear { min: 100, max: 0, steps: false } } else { Scale::Linear { min: 0, max: 100, steps: false } };
        cands.push((Fit::Percent, s, if full_v == Some(if fall { 0 } else { 100 }) { 40 } else { 25 }));
    }
    if top > 20 {
        let s = if fall { Scale::Linear { min: top, max: 0, steps: false } } else { Scale::Linear { min: 0, max: top, steps: false } };
        let near_top = full_v.map_or(false, |f| if fall { f.saturating_mul(10) <= top } else { f.saturating_mul(10) >= top.saturating_mul(9) });
        cands.push((Fit::Full, s, if near_top { 30 } else { 10 }));
    }
    for (f, scale, bonus) in cands {
        let Scale::Linear { min, max, .. } = scale else { continue };
        let ok = values.iter().all(|(k, v)| agrees(pct(*v, min, max, min > max), *k));
        if !ok {
            continue;
        }
        let pairs = (rising + falling) as i32;
        let mut score = 100 * pairs.min(3) + bonus;
        if weak {
            score = bonus / 2 + 5;
        }
        if fall {
            score -= 20;
        }
        // (A nibble is a guess more often than a whole byte or its low seven bits.)
        if field.mask == 0x7F {
            score -= 5;
        } else if field.mask != 0xFF {
            score -= 30;
        }
        // (A byte that hardly changes while listening suits a battery; one whose other bits change often less so.)
        if changed_bits & !field.mask != 0 {
            score -= 10;
        }
        return Some(LevelCand { field, scale, fit: f, values: values.to_vec(), falling: fall, weak, score });
    }
    None
}

/// A bit that differs between «charging now» and «not charging», steady at each.
fn propose_charging(marks: &[Mark], level: Option<Field>) -> Vec<ChargeCand> {
    let on: Vec<&Mark> = marks.iter().filter(|m| m.kind == MarkKind::Charging).collect();
    let off: Vec<&Mark> = marks.iter().filter(|m| m.kind == MarkKind::NotCharging).collect();
    if on.is_empty() || off.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let ids: Vec<u8> = on[0].snaps.iter().map(|s| s.id).filter(|id| on.iter().chain(&off).all(|m| m.snaps.iter().any(|s| s.id == *id))).collect();
    for id in ids {
        let get = |m: &&Mark| m.snaps.iter().find(|s| s.id == id).cloned();
        let a: Vec<Snap> = on.iter().filter_map(get).collect();
        let b: Vec<Snap> = off.iter().filter_map(get).collect();
        // (A mark without this report leaves it out, never a panic.)
        let (Some(a0), Some(b0)) = (a.first(), b.first()) else { continue };
        if a.len() != on.len() || b.len() != off.len() {
            continue;
        }
        let len = a.iter().chain(&b).map(|s| s.bytes.len()).min().unwrap_or(0).min(usize::from(defs::MAX_BYTE) + 1);
        for byte in 1..len {
            let moved = a.iter().chain(&b).fold(0u8, |m, s| m | s.moved.get(byte).copied().unwrap_or(0));
            let at = |s: &Snap| s.bytes.get(byte).copied().unwrap_or(0);
            let diff_bits = (at(a0) ^ at(b0)).count_ones() as i32;
            for bit in 0..8u8 {
                if moved >> bit & 1 == 1 {
                    continue;
                }
                let v = |s: &Snap| at(s) >> bit & 1;
                let va = v(a0);
                if !a.iter().all(|s| v(s) == va) || !b.iter().all(|s| v(s) != va) {
                    continue;
                }
                let mut score = 100 - (diff_bits - 1).max(0) * 15;
                if level.map_or(false, |f| f.report == id && usize::from(f.byte) == byte && f.mask >> bit & 1 == 1) {
                    score -= 10;
                }
                out.push(ChargeCand { rule: ChargeRule { report: id, byte: byte as u16, bit, on: va == 1 }, score });
            }
        }
    }
    out.sort_by(|x, y| y.score.cmp(&x.score).then(x.rule.byte.cmp(&y.rule.byte)).then(x.rule.bit.cmp(&y.rule.bit)));
    out.truncate(MAX_CHARGE);
    out
}

/// What a level candidate would read from the latest report.
pub fn preview(c: &LevelCand, cap: &Capture) -> Option<Level> {
    defs::level_from(&c.field, &c.scale, cap.latest(c.field.report)?)
}

/// The definition the user's pick makes (checked by defs.rs's own rules: written and read back).
pub fn definition(t: &Target, product: &str, level: &LevelCand, charging: Option<&ChargeCand>, name: &str, kind: Kind) -> Result<Definition, defs::DefErr> {
    let product: String = product.trim().chars().filter(|c| !c.is_control()).take(defs::MAX_PRODUCT).collect();
    let d = Definition {
        name: name.trim().to_string(),
        kind,
        note: String::new(),
        matcher: Match { vid: t.ident.vid, pid: t.ident.pid, usage_page: Some(t.ident.usage_page), usage: Some(t.ident.usage), interface: if (0..=15).contains(&t.ident.interface) { Some(t.ident.interface) } else { None }, product },
        level: level.field,
        scale: level.scale.clone(),
        charging: charging.map(|c| c.rule),
        asleep_after_s: None,
    };
    defs::parse(&defs::to_text(&d))
}

/// A listening run: a thread reading what the device sends into the Capture until stopped, its time ends, or the
/// device goes. Dropping it stops it.
pub struct Listening {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl Listening {
    /// Starts listening on `t` (it must be opened to listen — anything else is refused) for `seconds` (at most
    /// MAX_SECONDS). `clock` gives ms.
    pub fn start(mut t: Box<dyn HidTransport + Send>, seconds: u64, cap: Arc<Mutex<Capture>>, clock: Arc<dyn Fn() -> u64 + Send + Sync>) -> Result<Listening, TErr> {
        if t.mode() != OpenMode::Read {
            return Err(TErr::Refused);
        }
        let secs = seconds.clamp(10, MAX_SECONDS);
        let end = Instant::now() + Duration::from_secs(secs);
        {
            let mut c = cap.lock().unwrap_or_else(|e| e.into_inner());
            c.listening = true;
            c.gone = false;
            c.started = clock();
            c.until = c.started.saturating_add(secs * 1_000);
            c.touched = c.started;
        }
        let stop = Arc::new(AtomicBool::new(false));
        let s2 = stop.clone();
        let join = std::thread::Builder::new()
            .name("kt-battery-teach".into())
            .spawn(move || {
                let mut gone = false;
                let mut idle = false;
                while !s2.load(Ordering::Relaxed) && Instant::now() < end {
                    {
                        // (Nobody looked for IDLE_MS: stop, and drop what was heard.)
                        let c = cap.lock().unwrap_or_else(|e| e.into_inner());
                        if clock().saturating_sub(c.touched) > IDLE_MS {
                            idle = true;
                            break;
                        }
                    }
                    let began = Instant::now();
                    match t.read_input((began + Duration::from_millis(200)).min(end)) {
                        Ok(r) => cap.lock().unwrap_or_else(|e| e.into_inner()).push(clock(), &r),
                        Err(TErr::Gone) => {
                            gone = true;
                            break;
                        }
                        Err(_) => {
                            // (A read that returned at once — nothing queued — waits a little before the next.)
                            if began.elapsed() < Duration::from_millis(10) {
                                std::thread::sleep(Duration::from_millis(10));
                            }
                        }
                    }
                }
                drop(t);
                let mut c = cap.lock().unwrap_or_else(|e| e.into_inner());
                c.listening = false;
                c.gone = gone;
                if idle {
                    c.forget();
                }
            })
            .map_err(|e| TErr::Failed(e.to_string()))?;
        Ok(Listening { stop, join: Some(join) })
    }

    pub fn stop(mut self) {
        self.halt();
    }

    fn halt(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

impl Drop for Listening {
    fn drop(&mut self) {
        self.halt();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Percent, Steps};
    use crate::transport::fake::FakeHid;

    fn id(page: u16, usage: u16) -> HidIdent {
        HidIdent { vid: 0x1234, pid: 0x5678, usage_page: page, usage, interface: 1 }
    }

    #[test]
    fn what_may_be_listened_to() {
        let v = |page, usage| verdict(&id(page, usage), &[(page, usage)], None, 64);
        assert_eq!(v(0xFF00, 1), Verdict::Allowed);
        assert_eq!(v(0xFFA0, 3), Verdict::Allowed);
        assert_eq!(v(0x01, 0x05), Verdict::Allowed, "a gamepad");
        assert_eq!(v(0x01, 0x04), Verdict::Allowed, "a joystick");
        assert_eq!(v(0x06, 0x20), Verdict::Allowed, "generic device controls");
        assert_eq!(v(0x01, 0x06), Verdict::Keyboard);
        assert_eq!(v(0x01, 0x07), Verdict::Keyboard);
        assert_eq!(v(0x07, 0x00), Verdict::Keyboard);
        assert_eq!(v(0x01, 0x02), Verdict::Pointer);
        assert_eq!(v(0x01, 0x01), Verdict::Pointer);
        assert_eq!(v(0x0C, 0x01), Verdict::Keys);
        assert_eq!(v(0x01, 0x80), Verdict::Keys);
        assert_eq!(v(0x84, 0x04), Verdict::Power);
        assert_eq!(v(0x0B, 0x05), Verdict::NotListed);
        assert_eq!(verdict(&id(0xFF00, 1), &[(0xFF00, 1)], None, 1), Verdict::NoInput);
        assert_eq!(verdict(&id(0xFF00, 1), &[(0xFF00, 1), (0x0D, 2)], None, 64), Verdict::Digitizer, "a tablet's other collection: never");
        assert_eq!(verdict(&id(0xFF00, 1), &[(0xFF00, 1)], Some("playstation"), 64), Verdict::BuiltIn("playstation"));
        assert_eq!(target_id("hid:1234:5678:c:x", &id(0xFF00, 1)), "hid:1234:5678:c:x|FF00:0001:1");
    }

    /// A made-up pad: report 1 (sticks moving: bytes 1 and 2), report 4 carrying a level in byte 3 (0..100) with a
    /// charging flag in byte 4 bit 7 and a counter in byte 5; report 5 a steps level (0..4) in byte 2's low nibble.
    fn feed(c: &mut Capture, t0: u64, level: u8, charging: bool, steps: u8) {
        for i in 0..40u64 {
            let t = t0 + i * 50;
            c.push(t, &[1, (i * 37 % 256) as u8, (i * 11 % 256) as u8, 0]);
            if i % 4 == 0 {
                c.push(t, &[4, 0xA5, 0, level, if charging { 0x80 | 0x01 } else { 0x01 }, (t0 / 1000 + i) as u8]);
                c.push(t, &[5, 0, 0x30 | steps]);
            }
        }
    }

    #[test]
    fn rows_live_and_the_bounds() {
        let mut c = Capture::default();
        feed(&mut c, 1_000, 80, false, 3);
        let rows = c.rows();
        assert_eq!(rows.iter().map(|r| r.id).collect::<Vec<_>>(), vec![1, 4, 5]);
        let r1 = &rows[0];
        assert_eq!(r1.count, 40);
        assert_eq!(r1.rate10, 39 * 10_000 / 1_950, "about 20 a second");
        assert_eq!(r1.changing, vec![false, true, true, false], "the report id and the steady byte dimmed");
        let r4 = &rows[1];
        assert_eq!(r4.changing, vec![false, false, false, false, false, true], "only the counter moves");
        for i in 0..5_000u64 {
            c.push(10_000 + i, &[9, 1, 2]);
        }
        assert_eq!(c.frames.len(), MAX_FRAMES, "the ring is bounded");
        for id in 20..60u8 {
            c.push(20_000, &[id, 0]);
        }
        assert_eq!(c.ids.len(), MAX_IDS, "at most sixteen report ids");
        c.push(30_000, &vec![9; 400]);
        assert_eq!(c.latest(9).unwrap().len(), MAX_LEN, "a report is cut to its first bytes");
        c.push(30_001, &[]);
    }

    #[test]
    fn proposals_track_the_marks() {
        let mut c = Capture::default();
        assert_eq!(c.mark(MarkKind::Full, 0), Err(MarkErr::Quiet), "nothing heard yet");
        feed(&mut c, 10_000, 100, true, 4);
        c.mark(MarkKind::Full, 12_000).unwrap();
        c.mark(MarkKind::Charging, 12_000).unwrap();
        // (One kind of level mark only: candidates that fit, but weak.)
        let one = c.propose();
        assert!(!one.level.is_empty() && one.level.iter().all(|l| l.weak), "{:?}", one.level);
        assert!(one.charging.is_empty(), "one charging mark is not enough");
        feed(&mut c, 60_000, 52, false, 2);
        c.mark(MarkKind::Half, 62_000).unwrap();
        c.mark(MarkKind::NotCharging, 62_000).unwrap();
        feed(&mut c, 120_000, 14, false, 1);
        c.mark(MarkKind::Low, 122_000).unwrap();
        let p = c.propose();
        let best = &p.level[0];
        assert_eq!((best.field.report, best.field.byte, best.field.mask), (4, 3, 0xFF), "{:?}", p.level);
        assert_eq!((best.fit, &best.scale, best.weak, best.falling), (Fit::Percent, &Scale::Linear { min: 0, max: 100, steps: false }, false, false));
        assert_eq!(best.values, vec![(MarkKind::Full, 100), (MarkKind::Half, 52), (MarkKind::Low, 14)]);
        let steps = p.level.iter().find(|l| l.field.report == 5).expect("the steps report too");
        assert_eq!((steps.field.byte, steps.field.mask, steps.fit), (2, 0x0F, Fit::Steps));
        assert_eq!(steps.scale, Scale::Linear { min: 0, max: 4, steps: true });
        assert!(p.level.iter().all(|l| l.field.report != 1), "the moving sticks are never proposed");
        assert!(p.level.iter().all(|l| !(l.field.report == 4 && l.field.byte == 5)), "nor the counter");
        assert_eq!(preview(best, &c), Some(Level::Exact(Percent::new(14).unwrap())));
        assert_eq!(preview(steps, &c), Some(Level::Steps(Steps::new(1, 4).unwrap())));
        // (Charging: byte 4's top bit, set while charging.)
        assert_eq!(p.charging[0].rule, ChargeRule { report: 4, byte: 4, bit: 7, on: true }, "{:?}", p.charging);
        // (The pick becomes a definition that reads the same.)
        let t = Target { id: "x".into(), unit: "u".into(), name: "Made Up Pad".into(), ident: id(0xFF00, 1), verdict: Verdict::Allowed };
        let d = definition(&t, "Made Up Pad", best, Some(&p.charging[0]), " Desk pad ", Kind::Controller).unwrap();
        assert_eq!((d.name.as_str(), d.matcher.usage_page, d.matcher.interface, d.matcher.product.as_str()), ("Desk pad", Some(0xFF00), Some(1), "Made Up Pad"));
        assert_eq!(d.level_of(c.latest(4).unwrap()), Some(Level::Exact(Percent::new(14).unwrap())));
        assert!(definition(&t, "", best, None, "", Kind::Other).is_err(), "a name is needed");
        assert!(c.undo_mark());
        assert_eq!(c.marks().len(), 4);
    }

    #[test]
    fn nothing_proposed_against_the_marks() {
        // (A value that rises while the user says the battery fell, then rises again: no candidate.)
        let snap = |v: u8| vec![Snap { id: 2, bytes: vec![2, v], moved: vec![0, 0] }];
        let m = |k, v| Mark { kind: k, at: 0, snaps: snap(v) };
        let p = propose(&[m(MarkKind::Full, 90), m(MarkKind::Half, 95), m(MarkKind::Low, 10)], &BTreeMap::new());
        assert!(p.level.is_empty(), "{:?}", p.level);
        // (A falling value: proposed, marked falling, ranked lower.)
        let f = propose(&[m(MarkKind::Full, 0), m(MarkKind::Half, 50), m(MarkKind::Low, 85)], &BTreeMap::new());
        assert_eq!(f.level[0].falling, true);
        assert_eq!(f.level[0].scale, Scale::Linear { min: 100, max: 0, steps: false });
        // (0..255: the full range.)
        let w = propose(&[m(MarkKind::Full, 250), m(MarkKind::Low, 30)], &BTreeMap::new());
        assert_eq!((w.level[0].fit, &w.level[0].scale), (Fit::Full, &Scale::Linear { min: 0, max: 255, steps: false }));
        // (A byte that moved at a mark: never.)
        let moving = vec![Snap { id: 2, bytes: vec![2, 100], moved: vec![0, 0xFF] }];
        assert!(propose(&[Mark { kind: MarkKind::Full, at: 0, snaps: moving }, m(MarkKind::Low, 10)], &BTreeMap::new()).level.is_empty());
    }

    #[test]
    fn a_listening_run_only_reads_and_ends() {
        let cap = Arc::new(Mutex::new(Capture::default()));
        let clock: Arc<dyn Fn() -> u64 + Send + Sync> = Arc::new(|| 5);
        // (A handle that could write: refused before anything starts.)
        let mut w = FakeHid::new(id(0xFF00, 1));
        w.mode = OpenMode::ReadWrite;
        assert_eq!(Listening::start(Box::new(w), 60, cap.clone(), clock.clone()).err(), Some(TErr::Refused));
        let mut t = FakeHid::new(id(0xFF00, 1));
        t.mode = OpenMode::Read;
        t.stream.extend([vec![4, 1, 2], vec![4, 1, 3], vec![6, 9]]);
        let l = Listening::start(Box::new(t), 60, cap.clone(), clock).unwrap();
        let until = Instant::now() + Duration::from_secs(5);
        while cap.lock().unwrap().rows().iter().map(|r| r.count).sum::<u64>() < 3 && Instant::now() < until {
            std::thread::yield_now();
        }
        assert!(cap.lock().unwrap().listening);
        l.stop();
        let c = cap.lock().unwrap();
        assert!(!c.listening, "stopped");
        assert_eq!(c.rows().len(), 2);
        assert_eq!(c.until, 5 + 60_000);
    }

    #[test]
    fn a_run_nobody_looks_at_stops_itself_and_drops_what_it_heard() {
        use std::sync::atomic::AtomicU64;
        let now = Arc::new(AtomicU64::new(1_000));
        let n2 = now.clone();
        let calls = Arc::new(AtomicU64::new(0));
        let k2 = calls.clone();
        let clock: Arc<dyn Fn() -> u64 + Send + Sync> = Arc::new(move || {
            k2.fetch_add(1, Ordering::SeqCst);
            n2.load(Ordering::SeqCst)
        });
        let cap = Arc::new(Mutex::new(Capture::default()));
        let mut t = FakeHid::new(id(0xFF00, 1));
        t.mode = OpenMode::Read;
        t.stream.extend([vec![4, 1, 2], vec![4, 1, 3]]);
        let l = Listening::start(Box::new(t), 600, cap.clone(), clock).unwrap();
        let wait = |f: &dyn Fn(&Capture) -> bool| {
            let until = Instant::now() + Duration::from_secs(5);
            while !f(&cap.lock().unwrap()) && Instant::now() < until {
                std::thread::yield_now();
            }
        };
        wait(&|c| c.rows().iter().map(|r| r.count).sum::<u64>() >= 2);
        cap.lock().unwrap().mark(MarkKind::Full, 1_500).unwrap();
        // (Looked at within IDLE_MS: still listening.)
        now.store(1_500 + IDLE_MS - 1, Ordering::SeqCst);
        cap.lock().unwrap().touch(1_500 + IDLE_MS - 1);
        now.store(1_500 + 2 * IDLE_MS - 2, Ordering::SeqCst);
        // (The run has looked at the clock a few times since: a condition, not a fixed wait.)
        let c0 = calls.load(Ordering::SeqCst);
        let until = Instant::now() + Duration::from_secs(5);
        while calls.load(Ordering::SeqCst) < c0 + 3 && Instant::now() < until {
            std::thread::yield_now();
        }
        assert!(calls.load(Ordering::SeqCst) >= c0 + 3);
        assert!(cap.lock().unwrap().listening, "a poll keeps it going");
        // (Then nobody looks for longer than IDLE_MS: it stops, its bytes and marks gone.)
        now.store(1_500 + 2 * IDLE_MS + 1, Ordering::SeqCst);
        wait(&|c| !c.listening);
        let c = cap.lock().unwrap();
        assert!(!c.listening && !c.gone, "stopped, the device not gone");
        assert!(c.rows().is_empty() && c.marks().is_empty() && c.frames.is_empty(), "frames and marks dropped");
        drop(c);
        drop(l);
    }

    #[test]
    fn a_device_that_goes_ends_the_run() {
        struct Gone(HidIdent);
        impl HidTransport for Gone {
            fn ident(&self) -> &HidIdent {
                &self.0
            }
            fn mode(&self) -> OpenMode {
                OpenMode::Read
            }
            fn get_feature(&mut self, _: u8, _: usize, _: Instant) -> Result<Vec<u8>, TErr> {
                Err(TErr::Refused)
            }
            fn get_input(&mut self, _: u8, _: usize, _: Instant) -> Result<Vec<u8>, TErr> {
                Err(TErr::Refused)
            }
            fn read_input(&mut self, _: Instant) -> Result<Vec<u8>, TErr> {
                Err(TErr::Gone)
            }
            fn send_allowed(&mut self, _: &crate::allow::AllowedWrite, _: Instant) -> Result<(), TErr> {
                panic!("never sends")
            }
        }
        let cap = Arc::new(Mutex::new(Capture::default()));
        let l = Listening::start(Box::new(Gone(id(0xFF00, 1))), 5, cap.clone(), Arc::new(|| 0)).unwrap();
        let until = Instant::now() + Duration::from_secs(5);
        while cap.lock().unwrap().listening && Instant::now() < until {
            std::thread::yield_now();
        }
        assert!(cap.lock().unwrap().gone);
        drop(l);
    }
}
