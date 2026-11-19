// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery), W3: a device definition — one device's battery reading as DATA, not code
// (PLAN-battery §8 «adaptable to any controller without new code», items 2 and 3). Written for Kurokawa Tools.
//
// A definition says only where the level is in an INPUT report the device sends by itself, and how to read it. It has
// no field for bytes to send — there is nothing in the format that could carry a request —, the reader made from it
// opens the collection to listen only (transport.rs OpenMode::Read; never ReadWrite, never Feature) and never calls
// `send`, and allow.rs's table is not touched: a definition can never make a write possible.
//
// The format (version 1), strict JSON, at most 16 KiB, every field checked and bounded, unknown fields refused:
//   { "kurokawaDevice": 1,
//     "name": "Desk pad", "kind": "controller", "note": "taught on my desk",
//     "match": { "vendor": "0x1234", "product": "0x5678", "usagePage": "0xFF00", "usage": 1, "interface": 2,
//                "productName": "Made Up Pad" },
//     "level": { "report": 3, "byte": 5, "mask": "0x7F", "shift": 0, "scale": { "min": 0, "max": 100 } },
//     "charging": { "report": 3, "byte": 6, "bit": 2, "on": 1 },
//     "asleepAfter": 120 }
// - match: vendor and product required (never a vendor alone); usage page, usage, USB interface and the product's own
//   name optional (each narrows it).
// - level: the report id (0 for a collection that does not number its reports), the byte (the report id is byte 0, as
//   the platform hands the report over), a mask and a right shift (the value is (byte & mask) >> shift), then either
//   "scale": { "min", "max", "steps"? } — min..max read as 0..100 % (min may be above max: a falling value), or with
//   "steps": true as «n of max» steps (at most 20) —, or "table": [ { "value": 3, "percent": 100 } | { "value": 3,
//   "word": "full" } … ] (1 to 16 rows, all per cent or all words: empty, low, medium, high, full). A value outside the
//   scale or the table is no level (never a made-up one).
// - charging: optional, one bit of a byte of an input report and the bit's value that means charging.
// - asleepAfter: optional, seconds (10..3600): a device that sent nothing for that long is shown asleep.
// Numbers are whole numbers, or for vendor / product / usage page / usage / mask also "0x…" text.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::allow::HidIdent;
use crate::model::{Charging, Coarse, Kind, Level, Percent, Reading, Steps};
use crate::sched::Outcome;
use crate::transport::{HidTransport, OpenMode, TErr};
use std::time::{Duration, Instant};

pub const VERSION: i64 = 1;
/// The file's limit (an import larger than this is refused before it is read as text).
pub const MAX_FILE: usize = 16 * 1024;
pub const MAX_NAME: usize = 64;
pub const MAX_NOTE: usize = 280;
pub const MAX_PRODUCT: usize = 64;
pub const MAX_TABLE: usize = 16;
/// The most definitions kept.
pub const MAX_DEFS: usize = 50;
pub const MAX_BYTE: u16 = 255;
pub const ASLEEP_MIN: u32 = 10;
pub const ASLEEP_MAX: u32 = 3_600;
/// How long one query listens for the level's report at most (the runner's deadline may end it sooner).
pub const LISTEN: Duration = Duration::from_millis(2_500);

/// Why a definition was refused: a code the page words (batDefErr_<code>) and the field it is about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DefErr {
    pub code: &'static str,
    pub field: String,
}

fn err(code: &'static str, field: &str) -> DefErr {
    DefErr { code, field: field.to_string() }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Match {
    pub vid: u16,
    pub pid: u16,
    pub usage_page: Option<u16>,
    pub usage: Option<u16>,
    pub interface: Option<i32>,
    /// The product's own name, "" for any (compared trimmed, in any case).
    pub product: String,
}

impl Match {
    pub fn matches(&self, id: &HidIdent, product: &str) -> bool {
        self.vid == id.vid
            && self.pid == id.pid
            && self.usage_page.map_or(true, |p| p == id.usage_page)
            && self.usage.map_or(true, |u| u == id.usage)
            && self.interface.map_or(true, |i| i == id.interface)
            && (self.product.is_empty() || self.product.trim().eq_ignore_ascii_case(product.trim()))
    }
}

/// Where one value is: a byte of an input report, masked and shifted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Field {
    pub report: u8,
    pub byte: u16,
    pub mask: u8,
    pub shift: u8,
}

impl Field {
    /// The largest value the field can hold.
    pub fn top(&self) -> u32 {
        u32::from(self.mask >> self.shift)
    }
    pub fn value(&self, report: &[u8]) -> Option<u32> {
        if report.first() != Some(&self.report) {
            return None;
        }
        report.get(usize::from(self.byte)).map(|b| u32::from((b & self.mask) >> self.shift))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Out {
    Percent(u8),
    Word(Coarse),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scale {
    /// min..max read as 0..100 % (or as steps 0..|max-min|).
    Linear { min: u32, max: u32, steps: bool },
    Table(Vec<(u32, Out)>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChargeRule {
    pub report: u8,
    pub byte: u16,
    pub bit: u8,
    pub on: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Definition {
    pub name: String,
    pub kind: Kind,
    pub note: String,
    pub matcher: Match,
    pub level: Field,
    pub scale: Scale,
    pub charging: Option<ChargeRule>,
    pub asleep_after_s: Option<u32>,
}

impl Definition {
    /// The level a report carries (None: not the level's report, too short, or a value outside the scale).
    pub fn level_of(&self, report: &[u8]) -> Option<Level> {
        level_from(&self.level, &self.scale, report)
    }
    /// Charging as a report says it (Unknown when the definition has no rule or it is not that report).
    pub fn charging_of(&self, report: &[u8]) -> Option<Charging> {
        let c = self.charging?;
        if report.first() != Some(&c.report) {
            return None;
        }
        let b = report.get(usize::from(c.byte))?;
        Some(if ((b >> c.bit) & 1 == 1) == c.on { Charging::Yes } else { Charging::No })
    }
    /// The reports it listens for.
    pub fn reports(&self) -> Vec<u8> {
        let mut r = vec![self.level.report];
        if let Some(c) = self.charging {
            if c.report != self.level.report {
                r.push(c.report);
            }
        }
        r
    }
}

/// The level `report` carries by `field` and `scale` (the defined reader's, and «Teach me»'s preview).
pub fn level_from(field: &Field, scale: &Scale, report: &[u8]) -> Option<Level> {
    let v = field.value(report)?;
    match scale {
        Scale::Linear { min, max, steps } => {
            let (lo, hi) = (*min.min(max), *min.max(max));
            if v < lo || v > hi {
                return None;
            }
            let span = hi - lo;
            let up = if min <= max { v - lo } else { hi - v };
            if *steps {
                Steps::new(i64::from(up), i64::from(span)).map(Level::Steps)
            } else {
                Percent::new(((u64::from(up) * 100 + u64::from(span) / 2) / u64::from(span)) as i64).map(Level::Exact)
            }
        }
        Scale::Table(rows) => rows.iter().find(|r| r.0 == v).and_then(|r| match r.1 {
            Out::Percent(p) => Percent::new(i64::from(p)).map(Level::Exact),
            Out::Word(w) => Some(Level::Coarse(w)),
        }),
    }
}

/// Listens to what the device sends by itself — never sends anything, refuses a handle opened for writing — until the
/// level's report comes (and charging's, when it is another report, shortly after), within `LISTEN` and `deadline`.
/// `last_heard`: when this device last sent its level's report (ms); returns the outcome and the new time heard.
pub fn read(t: &mut dyn HidTransport, def: &Definition, deadline: Instant, last_heard: Option<u64>, now: u64) -> (Outcome, Option<u64>) {
    if t.mode() != OpenMode::Read {
        return (Outcome::Failed, last_heard);
    }
    let end = deadline.min(Instant::now() + LISTEN);
    let (mut level, mut charging): (Option<Level>, Option<Charging>) = (None, None);
    let mut heard = false;
    let mut until = end;
    loop {
        if Instant::now() >= until {
            break;
        }
        match t.read_input(until) {
            Ok(r) => {
                if r.first().map_or(false, |x| def.reports().contains(x)) {
                    heard = true;
                }
                if level.is_none() {
                    if let Some(l) = def.level_of(&r) {
                        level = Some(l);
                        // (Charging in another report: a short while more for it.)
                        until = end.min(Instant::now() + Duration::from_millis(400));
                    }
                }
                if charging.is_none() {
                    charging = def.charging_of(&r);
                }
                if level.is_some() && (charging.is_some() || def.charging.is_none()) {
                    break;
                }
            }
            Err(TErr::Gone) => return (Outcome::Failed, last_heard),
            Err(_) => break,
        }
    }
    let heard_at = if heard { Some(now) } else { last_heard };
    let ch = charging.unwrap_or(Charging::Unknown);
    if let Some(l) = level {
        return (Outcome::Read(Reading::new(l, ch, now)), heard_at);
    }
    if heard {
        // (Its report came, but with a value outside the scale: no level, never a made-up one.)
        return (Outcome::Read(Reading::unknown(crate::model::Note::None, ch, now)), heard_at);
    }
    match (def.asleep_after_s, last_heard) {
        (Some(s), Some(at)) if now.saturating_sub(at) >= u64::from(s) * 1_000 => (Outcome::Read(Reading::asleep(now)), last_heard),
        _ => (Outcome::NoAnswer, last_heard),
    }
}

// ---- the text ----

/// A small strict JSON reader: whole numbers only, bounded depth, lengths and counts; duplicate keys refused.
mod mini {
    use super::{err, DefErr};
    #[derive(Clone, Debug, PartialEq)]
    pub enum V {
        Null,
        Bool(bool),
        Int(i64),
        Str(String),
        Arr(Vec<V>),
        Obj(Vec<(String, V)>),
    }
    const DEPTH: usize = 5;
    const STR: usize = 512;
    const ITEMS: usize = 32;
    struct P<'a> {
        s: &'a [u8],
        i: usize,
    }
    pub fn parse(text: &str) -> Result<V, DefErr> {
        let mut p = P { s: text.trim_start_matches('\u{FEFF}').as_bytes(), i: 0 };
        let v = p.value(0)?;
        p.ws();
        if p.i != p.s.len() {
            return Err(err("notJson", ""));
        }
        Ok(v)
    }
    impl<'a> P<'a> {
        fn ws(&mut self) {
            while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
                self.i += 1;
            }
        }
        fn eat(&mut self, c: u8) -> bool {
            self.ws();
            if self.s.get(self.i) == Some(&c) {
                self.i += 1;
                true
            } else {
                false
            }
        }
        fn word(&mut self, w: &str, v: V) -> Result<V, DefErr> {
            if self.s[self.i..].starts_with(w.as_bytes()) {
                self.i += w.len();
                Ok(v)
            } else {
                Err(err("notJson", ""))
            }
        }
        fn value(&mut self, depth: usize) -> Result<V, DefErr> {
            if depth > DEPTH {
                return Err(err("notJson", ""));
            }
            self.ws();
            match self.s.get(self.i) {
                Some(b'{') => {
                    self.i += 1;
                    let mut out: Vec<(String, V)> = Vec::new();
                    if self.eat(b'}') {
                        return Ok(V::Obj(out));
                    }
                    loop {
                        self.ws();
                        let k = self.string()?;
                        if !self.eat(b':') {
                            return Err(err("notJson", ""));
                        }
                        let v = self.value(depth + 1)?;
                        if out.iter().any(|(x, _)| *x == k) {
                            return Err(err("duplicate", &k));
                        }
                        if out.len() >= ITEMS {
                            return Err(err("count", &k));
                        }
                        out.push((k, v));
                        if self.eat(b',') {
                            continue;
                        }
                        if self.eat(b'}') {
                            return Ok(V::Obj(out));
                        }
                        return Err(err("notJson", ""));
                    }
                }
                Some(b'[') => {
                    self.i += 1;
                    let mut out = Vec::new();
                    if self.eat(b']') {
                        return Ok(V::Arr(out));
                    }
                    loop {
                        if out.len() >= ITEMS {
                            return Err(err("count", ""));
                        }
                        out.push(self.value(depth + 1)?);
                        if self.eat(b',') {
                            continue;
                        }
                        if self.eat(b']') {
                            return Ok(V::Arr(out));
                        }
                        return Err(err("notJson", ""));
                    }
                }
                Some(b'"') => Ok(V::Str(self.string()?)),
                Some(b't') => self.word("true", V::Bool(true)),
                Some(b'f') => self.word("false", V::Bool(false)),
                Some(b'n') => self.word("null", V::Null),
                Some(b'-') | Some(b'0'..=b'9') => self.number(),
                _ => Err(err("notJson", "")),
            }
        }
        fn number(&mut self) -> Result<V, DefErr> {
            let start = self.i;
            if self.s[self.i] == b'-' {
                self.i += 1;
            }
            let digits = self.i;
            while self.i < self.s.len() && self.s[self.i].is_ascii_digit() {
                self.i += 1;
            }
            let n = self.i - digits;
            if n == 0 || n > 12 || (n > 1 && self.s[digits] == b'0') {
                return Err(err("notJson", ""));
            }
            // (A fraction or an exponent: not a whole number.)
            if matches!(self.s.get(self.i), Some(b'.') | Some(b'e') | Some(b'E')) {
                return Err(err("type", ""));
            }
            std::str::from_utf8(&self.s[start..self.i]).ok().and_then(|t| t.parse::<i64>().ok()).map(V::Int).ok_or_else(|| err("notJson", ""))
        }
        fn string(&mut self) -> Result<String, DefErr> {
            if self.s.get(self.i) != Some(&b'"') {
                return Err(err("notJson", ""));
            }
            self.i += 1;
            let mut out: Vec<u8> = Vec::new();
            loop {
                let Some(&c) = self.s.get(self.i) else { return Err(err("notJson", "")) };
                self.i += 1;
                match c {
                    b'"' => break,
                    b'\\' => {
                        let Some(&e) = self.s.get(self.i) else { return Err(err("notJson", "")) };
                        self.i += 1;
                        let ch = match e {
                            b'"' => '"',
                            b'\\' => '\\',
                            b'/' => '/',
                            b'n' => '\n',
                            b't' => '\t',
                            b'r' => '\r',
                            b'b' => '\u{8}',
                            b'f' => '\u{c}',
                            b'u' => {
                                let h = self.s.get(self.i..self.i + 4).and_then(|x| std::str::from_utf8(x).ok()).and_then(|x| u32::from_str_radix(x, 16).ok()).ok_or_else(|| err("notJson", ""))?;
                                self.i += 4;
                                // (Surrogates — characters outside the basic plane — are not needed in a name: refused.)
                                char::from_u32(h).ok_or_else(|| err("notJson", ""))?
                            }
                            _ => return Err(err("notJson", "")),
                        };
                        let mut b = [0u8; 4];
                        out.extend_from_slice(ch.encode_utf8(&mut b).as_bytes());
                    }
                    0..=0x1F => return Err(err("notJson", "")),
                    _ => out.push(c),
                }
                if out.len() > STR {
                    return Err(err("length", ""));
                }
            }
            String::from_utf8(out).map_err(|_| err("notJson", ""))
        }
    }
}

use mini::V;

fn obj<'a>(v: &'a V, field: &str, allowed: &[&str]) -> Result<&'a [(String, V)], DefErr> {
    let V::Obj(o) = v else { return Err(err("type", field)) };
    if let Some((k, _)) = o.iter().find(|(k, _)| !allowed.contains(&k.as_str())) {
        let f = if field.is_empty() { k.clone() } else { format!("{}.{}", field, k) };
        return Err(DefErr { code: "unknown", field: f });
    }
    Ok(o)
}

fn get<'a>(o: &'a [(String, V)], k: &str) -> Option<&'a V> {
    o.iter().find(|(x, _)| x == k).map(|(_, v)| v)
}

fn path(field: &str, k: &str) -> String {
    if field.is_empty() {
        k.to_string()
    } else {
        format!("{}.{}", field, k)
    }
}

/// A whole number in lo..=hi (or "0x…" text when `hex`).
fn num(v: Option<&V>, f: &str, lo: i64, hi: i64, hex: bool) -> Result<Option<i64>, DefErr> {
    let n = match v {
        None => return Ok(None),
        Some(V::Int(n)) => *n,
        Some(V::Str(s)) if hex => {
            let h = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")).filter(|h| (1..=4).contains(&h.len()) && h.bytes().all(|b| b.is_ascii_hexdigit())).ok_or_else(|| err("type", f))?;
            i64::from_str_radix(h, 16).map_err(|_| err("type", f))?
        }
        Some(_) => return Err(err("type", f)),
    };
    if n < lo || n > hi {
        return Err(err("range", f));
    }
    Ok(Some(n))
}

fn need(v: Option<i64>, f: &str) -> Result<i64, DefErr> {
    v.ok_or_else(|| err("missing", f))
}

/// Text: trimmed, no control characters, at most `max` characters (and at least one when `required`).
fn text(v: Option<&V>, f: &str, max: usize, required: bool) -> Result<String, DefErr> {
    let s = match v {
        None if required => return Err(err("missing", f)),
        None => return Ok(String::new()),
        Some(V::Str(s)) => s.trim().to_string(),
        Some(_) => return Err(err("type", f)),
    };
    if s.chars().any(|c| c.is_control() || matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')) {
        return Err(err("text", f));
    }
    if s.chars().count() > max || (required && s.is_empty()) {
        return Err(err("length", f));
    }
    Ok(s)
}

const KINDS: &[&str] = &["mouse", "keyboard", "headset", "earbuds", "controller", "speaker", "phone", "microphone", "other"];

fn word_of(s: &str) -> Option<Coarse> {
    Some(match s {
        "empty" => Coarse::Empty,
        "low" => Coarse::Low,
        "medium" => Coarse::Medium,
        "high" => Coarse::High,
        "full" => Coarse::Full,
        _ => return None,
    })
}

/// Reads and checks a definition's text. Every number bounded, every text's length, every list's count; an unknown
/// field anywhere is refused; nothing in it is ever run.
pub fn parse(text_in: &str) -> Result<Definition, DefErr> {
    if text_in.len() > MAX_FILE {
        return Err(err("tooBig", ""));
    }
    let root = mini::parse(text_in)?;
    let V::Obj(_) = root else { return Err(err("notObject", "")) };
    let o = obj(&root, "", &["kurokawaDevice", "name", "kind", "note", "match", "level", "charging", "asleepAfter"])?;
    match get(o, "kurokawaDevice") {
        None => return Err(err("missing", "kurokawaDevice")),
        Some(V::Int(VERSION)) => {}
        Some(V::Int(_)) => return Err(err("version", "kurokawaDevice")),
        Some(_) => return Err(err("type", "kurokawaDevice")),
    }
    let name = text(get(o, "name"), "name", MAX_NAME, true)?;
    let note = text(get(o, "note"), "note", MAX_NOTE, false)?;
    let kind_s = text(get(o, "kind"), "kind", 16, false)?;
    let kind = if kind_s.is_empty() {
        Kind::Other
    } else if KINDS.contains(&kind_s.as_str()) {
        Kind::parse(&kind_s)
    } else {
        return Err(err("kind", "kind"));
    };
    let m = get(o, "match").ok_or_else(|| err("missing", "match"))?;
    let mo = obj(m, "match", &["vendor", "product", "usagePage", "usage", "interface", "productName"])?;
    let vid = need(num(get(mo, "vendor"), "match.vendor", 1, 0xFFFF, true)?, "match.vendor")? as u16;
    let pid = need(num(get(mo, "product"), "match.product", 0, 0xFFFF, true)?, "match.product")? as u16;
    let usage_page = num(get(mo, "usagePage"), "match.usagePage", 0, 0xFFFF, true)?.map(|n| n as u16);
    let usage = num(get(mo, "usage"), "match.usage", 0, 0xFFFF, true)?.map(|n| n as u16);
    // (A collection «Teach me» never listens to — a keyboard, a pointer, consumer or system keys, a digitizer, a UPS —
    // is refused here too: a definition imported by hand must not reach what the assistant would not.)
    if let Some(p) = usage_page {
        if forbidden_page(p) {
            return Err(err("forbidden", "match.usagePage"));
        }
        if let Some(u) = usage {
            if forbidden_usage(p, u) {
                return Err(err("forbidden", "match.usage"));
            }
        }
    }
    let interface = num(get(mo, "interface"), "match.interface", 0, 15, false)?.map(|n| n as i32);
    let product = text(get(mo, "productName"), "match.productName", MAX_PRODUCT, false)?;
    if get(mo, "productName").is_some() && product.is_empty() {
        return Err(err("length", "match.productName"));
    }
    let l = get(o, "level").ok_or_else(|| err("missing", "level"))?;
    let lo = obj(l, "level", &["report", "byte", "mask", "shift", "scale", "table"])?;
    let report = need(num(get(lo, "report"), "level.report", 0, 255, false)?, "level.report")? as u8;
    let byte = need(num(get(lo, "byte"), "level.byte", 1, i64::from(MAX_BYTE), false)?, "level.byte")? as u16;
    let mask = num(get(lo, "mask"), "level.mask", 1, 255, true)?.unwrap_or(255) as u8;
    let shift = num(get(lo, "shift"), "level.shift", 0, 7, false)?.unwrap_or(0) as u8;
    // (A shift that drops bits of the mask: the field would read something else than it says.)
    if (mask >> shift) << shift != mask {
        return Err(err("range", "level.shift"));
    }
    let field = Field { report, byte, mask, shift };
    let top = field.top();
    let scale = match (get(lo, "scale"), get(lo, "table")) {
        (Some(_), Some(_)) => return Err(err("scale", "level")),
        (None, None) => return Err(err("missing", "level.scale")),
        (Some(s), None) => {
            let so = obj(s, "level.scale", &["min", "max", "steps"])?;
            let min = need(num(get(so, "min"), "level.scale.min", 0, i64::from(top), false)?, "level.scale.min")? as u32;
            let max = need(num(get(so, "max"), "level.scale.max", 0, i64::from(top), false)?, "level.scale.max")? as u32;
            let steps = match get(so, "steps") {
                None => false,
                Some(V::Bool(b)) => *b,
                Some(_) => return Err(err("type", "level.scale.steps")),
            };
            if min == max {
                return Err(err("scale", "level.scale"));
            }
            if steps && min.abs_diff(max) > u32::from(Steps::MAX) {
                return Err(err("range", "level.scale.steps"));
            }
            Scale::Linear { min, max, steps }
        }
        (None, Some(t)) => {
            let V::Arr(rows) = t else { return Err(err("type", "level.table")) };
            if rows.is_empty() || rows.len() > MAX_TABLE {
                return Err(err("count", "level.table"));
            }
            let mut out: Vec<(u32, Out)> = Vec::new();
            for (i, r) in rows.iter().enumerate() {
                let f = format!("level.table.{}", i);
                let ro = obj(r, &f, &["value", "percent", "word"])?;
                let v = need(num(get(ro, "value"), &path(&f, "value"), 0, i64::from(top), false)?, &path(&f, "value"))? as u32;
                let o = match (get(ro, "percent"), get(ro, "word")) {
                    (Some(_), Some(_)) | (None, None) => return Err(err("scale", &f)),
                    (Some(p), None) => Out::Percent(need(num(Some(p), &path(&f, "percent"), 0, 100, false)?, &f)? as u8),
                    (None, Some(V::Str(w))) => Out::Word(word_of(w).ok_or_else(|| err("range", &path(&f, "word")))?),
                    (None, Some(_)) => return Err(err("type", &path(&f, "word"))),
                };
                if out.iter().any(|x| x.0 == v) {
                    return Err(err("duplicate", &path(&f, "value")));
                }
                out.push((v, o));
            }
            let pct = out.iter().filter(|x| matches!(x.1, Out::Percent(_))).count();
            if pct != 0 && pct != out.len() {
                return Err(err("scale", "level.table"));
            }
            Scale::Table(out)
        }
    };
    let charging = match get(o, "charging") {
        None => None,
        Some(c) => {
            let co = obj(c, "charging", &["report", "byte", "bit", "on"])?;
            Some(ChargeRule {
                report: need(num(get(co, "report"), "charging.report", 0, 255, false)?, "charging.report")? as u8,
                byte: need(num(get(co, "byte"), "charging.byte", 1, i64::from(MAX_BYTE), false)?, "charging.byte")? as u16,
                bit: need(num(get(co, "bit"), "charging.bit", 0, 7, false)?, "charging.bit")? as u8,
                on: num(get(co, "on"), "charging.on", 0, 1, false)?.unwrap_or(1) == 1,
            })
        }
    };
    let asleep_after_s = num(get(o, "asleepAfter"), "asleepAfter", i64::from(ASLEEP_MIN), i64::from(ASLEEP_MAX), false)?.map(|n| n as u32);
    Ok(Definition { name, kind, note, matcher: Match { vid, pid, usage_page, usage, interface, product }, level: field, scale, charging, asleep_after_s })
}

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// The definition as its canonical text (what is kept and what «Export» saves): `parse` reads it back the same.
pub fn to_text(d: &Definition) -> String {
    let m = &d.matcher;
    let mut mm = vec![format!("\"vendor\": \"0x{:04X}\"", m.vid), format!("\"product\": \"0x{:04X}\"", m.pid)];
    if let Some(p) = m.usage_page {
        mm.push(format!("\"usagePage\": \"0x{:04X}\"", p));
    }
    if let Some(u) = m.usage {
        mm.push(format!("\"usage\": \"0x{:04X}\"", u));
    }
    if let Some(i) = m.interface {
        mm.push(format!("\"interface\": {}", i));
    }
    if !m.product.is_empty() {
        mm.push(format!("\"productName\": {}", esc(&m.product)));
    }
    let f = &d.level;
    let scale = match &d.scale {
        Scale::Linear { min, max, steps } => format!("\"scale\": {{ \"min\": {}, \"max\": {}{} }}", min, max, if *steps { ", \"steps\": true" } else { "" }),
        Scale::Table(rows) => {
            let r: Vec<String> = rows
                .iter()
                .map(|(v, o)| match o {
                    Out::Percent(p) => format!("{{ \"value\": {}, \"percent\": {} }}", v, p),
                    Out::Word(w) => format!("{{ \"value\": {}, \"word\": \"{}\" }}", v, w.as_str()),
                })
                .collect();
            format!("\"table\": [{}]", r.join(", "))
        }
    };
    let mut out = vec![
        "\"kurokawaDevice\": 1".to_string(),
        format!("\"name\": {}", esc(&d.name)),
        format!("\"kind\": \"{}\"", d.kind.as_str()),
    ];
    if !d.note.is_empty() {
        out.push(format!("\"note\": {}", esc(&d.note)));
    }
    out.push(format!("\"match\": {{ {} }}", mm.join(", ")));
    out.push(format!("\"level\": {{ \"report\": {}, \"byte\": {}, \"mask\": \"0x{:02X}\", \"shift\": {}, {} }}", f.report, f.byte, f.mask, f.shift, scale));
    if let Some(c) = d.charging {
        out.push(format!("\"charging\": {{ \"report\": {}, \"byte\": {}, \"bit\": {}, \"on\": {} }}", c.report, c.byte, c.bit, u8::from(c.on)));
    }
    if let Some(s) = d.asleep_after_s {
        out.push(format!("\"asleepAfter\": {}", s));
    }
    format!("{{\n  {}\n}}\n", out.join(",\n  "))
}

/// The built-in family reader that already handles this vendor and product, if any (a definition for it needs the
/// user's «use mine instead» for that device).
pub fn builtin_for(vid: u16, pid: u16) -> Option<&'static str> {
    if let Some(m) = crate::pads::all_models().find(|m| m.vid == vid && m.pid == pid) {
        return Some(m.driver().family.as_str());
    }
    crate::mice::all_models().find(|m| m.vid == vid && m.pid == pid).map(|m| m.driver().family.as_str())
}

/// A page whose every collection is what the user types or does, or a power supply (teach.rs's rule): keyboard / keypad
/// 0x07, consumer 0x0C, digitizer 0x0D, power device 0x84, battery system 0x85.
pub fn forbidden_page(page: u16) -> bool {
    matches!(page, 0x07 | 0x0C | 0x0D | 0x84 | 0x85)
}

/// A generic-desktop collection of the same kind: pointer 1, mouse 2, keyboard 6, keypad 7, system control 0x80.
pub fn forbidden_usage(page: u16, usage: u16) -> bool {
    forbidden_page(page) || (page == 0x01 && matches!(usage, 0x01 | 0x02 | 0x06 | 0x07 | 0x80))
}

/// Whether a definition may read this collection, by teach.rs's own rule (`verdict`), the same one «Teach me» follows:
/// `unit` every (page, usage) of its unit, `builtin` the family of a built-in reader that handles its product. A
/// built-in reader's device passes only with «use mine instead» (`mine_first`), and then only when the collection would
/// be listened to without that reader.
pub fn collection_ok(id: &HidIdent, unit: &[(u16, u16)], builtin: Option<&'static str>, input_len: usize, mine_first: bool) -> bool {
    use crate::teach::{verdict, Verdict};
    match verdict(id, unit, builtin, input_len) {
        Verdict::Allowed => true,
        Verdict::BuiltIn(_) => mine_first && verdict(id, unit, None, input_len) == Verdict::Allowed,
        _ => false,
    }
}

/// One definition as the platform holds it: on, and whether it goes before a built-in reader of the same product
/// (only when the user said «use mine instead»).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Active {
    pub id: String,
    pub def: Definition,
    pub mine_first: bool,
}

/// The definition that reads this collection, when one is on: before the built-in readers when the user said so (and
/// only then), else only for a collection no built-in reader claims.
pub fn find<'a>(defs: &'a [Active], id: &HidIdent, product: &str, builtin: bool) -> Option<&'a Active> {
    defs.iter().find(|a| a.def.matcher.matches(id, product) && (!builtin || a.mine_first))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::fake::FakeHid;

    const GOOD: &str = r#"{ "kurokawaDevice": 1, "name": "Desk pad", "kind": "controller", "note": "made up",
      "match": { "vendor": "0x1234", "product": "0x5678", "usagePage": "0xFF00", "usage": 1, "interface": 2, "productName": "Made Up Pad" },
      "level": { "report": 3, "byte": 5, "mask": "0x7F", "shift": 0, "scale": { "min": 0, "max": 100 } },
      "charging": { "report": 3, "byte": 6, "bit": 2, "on": 1 },
      "asleepAfter": 120 }"#;

    fn id() -> HidIdent {
        HidIdent { vid: 0x1234, pid: 0x5678, usage_page: 0xFF00, usage: 1, interface: 2 }
    }
    fn code(t: &str) -> (&'static str, String) {
        let e = parse(t).unwrap_err();
        (e.code, e.field)
    }
    fn with(from: &str, to: &str) -> String {
        assert!(GOOD.contains(from), "{}", from);
        GOOD.replacen(from, to, 1)
    }

    #[test]
    fn a_good_definition_reads_and_writes_back_the_same() {
        let d = parse(GOOD).unwrap();
        assert_eq!(d.name, "Desk pad");
        assert_eq!(d.kind, Kind::Controller);
        assert_eq!(d.matcher, Match { vid: 0x1234, pid: 0x5678, usage_page: Some(0xFF00), usage: Some(1), interface: Some(2), product: "Made Up Pad".into() });
        assert_eq!(d.level, Field { report: 3, byte: 5, mask: 0x7F, shift: 0 });
        assert_eq!(d.charging, Some(ChargeRule { report: 3, byte: 6, bit: 2, on: true }));
        assert_eq!(d.asleep_after_s, Some(120));
        let back = parse(&to_text(&d)).unwrap();
        assert_eq!(back, d);
        // (A table of words, steps, a falling scale: written back the same too.)
        let t = with(r#""scale": { "min": 0, "max": 100 }"#, r#""table": [{ "value": 0, "word": "empty" }, { "value": 1, "word": "low" }, { "value": 3, "word": "full" }]"#);
        let d2 = parse(&t).unwrap();
        assert_eq!(parse(&to_text(&d2)).unwrap(), d2);
        let s = with(r#""scale": { "min": 0, "max": 100 }"#, r#""scale": { "min": 10, "max": 0, "steps": true }"#);
        let d3 = parse(&s).unwrap();
        assert_eq!(parse(&to_text(&d3)).unwrap(), d3);
        // (The least: no optional field.)
        let least = r#"{"kurokawaDevice":1,"name":"X","match":{"vendor":4660,"product":0},"level":{"report":0,"byte":1,"scale":{"min":0,"max":255}}}"#;
        let d4 = parse(least).unwrap();
        assert_eq!((d4.kind, d4.level.mask, d4.charging, d4.asleep_after_s), (Kind::Other, 0xFF, None, None));
    }

    #[test]
    fn every_kind_of_bad_input_is_refused_with_its_reason() {
        assert_eq!(code(&"x".repeat(MAX_FILE + 1)).0, "tooBig");
        assert_eq!(code("{").0, "notJson");
        assert_eq!(code("{} x").0, "notJson");
        assert_eq!(code("[1]").0, "notObject");
        assert_eq!(code(r#"{"a":1,"a":2}"#), ("duplicate", "a".into()));
        assert_eq!(code(&with(r#""kurokawaDevice": 1"#, r#""kurokawaDevice": 2"#)).0, "version");
        assert_eq!(code(&with(r#""kurokawaDevice": 1, "#, "")), ("missing", "kurokawaDevice".into()));
        assert_eq!(code(&with(r#""note": "made up""#, r#""send": [1, 2]"#)), ("unknown", "send".into()), "no field to send anything");
        assert_eq!(code(&with(r#""shift": 0"#, r#""shift": 0, "output": 1"#)), ("unknown", "level.output".into()));
        assert_eq!(code(&with(r#""usage": 1"#, r#""usage": 1, "feature": 2"#)), ("unknown", "match.feature".into()));
        assert_eq!(code(&with(r#""name": "Desk pad""#, r#""name": """#)), ("length", "name".into()));
        assert_eq!(code(&with(r#""name": "Desk pad""#, &format!("\"name\": \"{}\"", "n".repeat(65)))), ("length", "name".into()));
        assert_eq!(code(&with(r#""name": "Desk pad""#, r#""name": "a\u0007b""#)), ("text", "name".into()));
        assert_eq!(code(&with(r#""name": "Desk pad""#, r#""name": 5"#)), ("type", "name".into()));
        assert_eq!(code(&with(r#""note": "made up""#, &format!("\"note\": \"{}\"", "n".repeat(281)))), ("length", "note".into()));
        assert_eq!(code(&with(r#""kind": "controller""#, r#""kind": "toaster""#)), ("kind", "kind".into()));
        assert_eq!(code(&with(r#""vendor": "0x1234""#, r#""vendor": 0"#)), ("range", "match.vendor".into()), "vendor 0 is no vendor");
        assert_eq!(code(&with(r#""vendor": "0x1234", "#, "")), ("missing", "match.vendor".into()));
        assert_eq!(code(&with(r#""product": "0x5678""#, r#""product": 70000"#)), ("range", "match.product".into()));
        assert_eq!(code(&with(r#""product": "0x5678""#, r#""product": "0x12345""#)), ("type", "match.product".into()));
        assert_eq!(code(&with(r#""product": "0x5678""#, r#""product": "5678""#)), ("type", "match.product".into()));
        assert_eq!(code(&with(r#""interface": 2"#, r#""interface": 16"#)), ("range", "match.interface".into()));
        assert_eq!(code(&with(r#""productName": "Made Up Pad""#, r#""productName": " ""#)), ("length", "match.productName".into()));
        assert_eq!(code(&with(r#""report": 3, "byte": 5"#, r#""report": 256, "byte": 5"#)), ("range", "level.report".into()));
        assert_eq!(code(&with(r#""report": 3, "byte": 5"#, r#""report": 3, "byte": 0"#)), ("range", "level.byte".into()), "byte 0 is the report id");
        assert_eq!(code(&with(r#""report": 3, "byte": 5"#, r#""report": 3, "byte": 256"#)), ("range", "level.byte".into()));
        assert_eq!(code(&with(r#""mask": "0x7F""#, r#""mask": 0"#)), ("range", "level.mask".into()));
        assert_eq!(code(&with(r#""shift": 0"#, r#""shift": 8"#)), ("range", "level.shift".into()));
        assert_eq!(code(&with(r#""shift": 0"#, r#""shift": 1"#)), ("range", "level.shift".into()), "a shift dropping mask bits");
        assert_eq!(code(&with(r#""max": 100"#, r#""max": 128"#)), ("range", "level.scale.max".into()), "above what the mask holds");
        assert_eq!(code(&with(r#""max": 100"#, r#""max": 0"#)), ("scale", "level.scale".into()));
        assert_eq!(code(&with(r#""max": 100 }"#, r#""max": 100, "steps": true }"#)), ("range", "level.scale.steps".into()));
        assert_eq!(code(&with(r#""max": 100"#, r#""max": 1.5"#)).0, "type", "whole numbers only");
        assert_eq!(code(&with(r#""max": 100"#, r#""max": 1e2"#)).0, "type");
        assert_eq!(code(&with(r#", "scale": { "min": 0, "max": 100 }"#, "")), ("missing", "level.scale".into()));
        assert_eq!(code(&with(r#""scale": { "min": 0, "max": 100 }"#, r#""scale": { "min": 0, "max": 100 }, "table": []"#)), ("scale", "level".into()));
        assert_eq!(code(&with(r#""scale": { "min": 0, "max": 100 }"#, r#""table": []"#)), ("count", "level.table".into()));
        let many: Vec<String> = (0..17).map(|i| format!("{{\"value\":{},\"percent\":{}}}", i, i)).collect();
        assert_eq!(code(&with(r#""scale": { "min": 0, "max": 100 }"#, &format!("\"table\": [{}]", many.join(",")))), ("count", "level.table".into()));
        assert_eq!(code(&with(r#""scale": { "min": 0, "max": 100 }"#, r#""table": [{"value":1,"percent":101}]"#)), ("range", "level.table.0.percent".into()));
        assert_eq!(code(&with(r#""scale": { "min": 0, "max": 100 }"#, r#""table": [{"value":1,"word":"half"}]"#)), ("range", "level.table.0.word".into()));
        assert_eq!(code(&with(r#""scale": { "min": 0, "max": 100 }"#, r#""table": [{"value":1,"percent":10},{"value":1,"percent":20}]"#)), ("duplicate", "level.table.1.value".into()));
        assert_eq!(code(&with(r#""scale": { "min": 0, "max": 100 }"#, r#""table": [{"value":1,"percent":10},{"value":2,"word":"full"}]"#)), ("scale", "level.table".into()), "per cent and words not mixed");
        assert_eq!(code(&with(r#""scale": { "min": 0, "max": 100 }"#, r#""table": [{"value":1,"percent":10,"word":"low"}]"#)), ("scale", "level.table.0".into()));
        assert_eq!(code(&with(r#""bit": 2"#, r#""bit": 8"#)), ("range", "charging.bit".into()));
        assert_eq!(code(&with(r#""on": 1"#, r#""on": 2"#)), ("range", "charging.on".into()));
        assert_eq!(code(&with(r#""asleepAfter": 120"#, r#""asleepAfter": 5"#)), ("range", "asleepAfter".into()));
        assert_eq!(code(&with(r#""asleepAfter": 120"#, r#""asleepAfter": 3601"#)), ("range", "asleepAfter".into()));
        // (Deep nesting and long strings: bounded before they are looked at.)
        assert_eq!(code(&format!("{}{}", "[".repeat(40), "]".repeat(40))).0, "notJson");
        assert_eq!(code(&format!("{{\"name\":\"{}\"}}", "x".repeat(600))).0, "length");
        assert_eq!(code(&format!("[{}]", vec!["1"; 40].join(","))).0, "count");
    }

    #[test]
    fn the_level_from_reports() {
        let d = parse(GOOD).unwrap();
        let rep = |b5: u8, b6: u8| vec![3, 0, 0, 0, 0, b5, b6];
        assert_eq!(d.level_of(&rep(64, 0)), Some(Level::Exact(Percent::new(64).unwrap())));
        assert_eq!(d.level_of(&rep(0x80 | 64, 0)), Some(Level::Exact(Percent::new(64).unwrap())), "the mask keeps the low seven bits");
        assert_eq!(d.level_of(&rep(120, 0)), None, "outside the scale: no level, never a made-up one");
        assert_eq!(d.level_of(&[4, 0, 0, 0, 0, 64, 0]), None, "another report");
        assert_eq!(d.level_of(&[3, 0, 0]), None, "too short");
        assert_eq!(d.charging_of(&rep(64, 0b100)), Some(Charging::Yes));
        assert_eq!(d.charging_of(&rep(64, 0)), Some(Charging::No));
        // (0..255 → 0..100, rounded; a falling scale; steps; a table of words.)
        let least = |scale: &str| parse(&format!(r#"{{"kurokawaDevice":1,"name":"X","match":{{"vendor":1,"product":2}},"level":{{"report":0,"byte":2,"mask":"0xF0","shift":4,{}}}}}"#, scale)).unwrap();
        let w = least(r#""scale":{"min":0,"max":15}"#);
        assert_eq!(w.level_of(&[0, 9, 0x80]), Some(Level::Exact(Percent::new(53).unwrap())), "8 of 15, rounded");
        let f = least(r#""scale":{"min":15,"max":5}"#);
        assert_eq!(f.level_of(&[0, 9, 0x50]), Some(Level::Exact(Percent::new(100).unwrap())));
        assert_eq!(f.level_of(&[0, 9, 0xF0]), Some(Level::Exact(Percent::new(0).unwrap())));
        assert_eq!(f.level_of(&[0, 9, 0x40]), None);
        let s = least(r#""scale":{"min":0,"max":4,"steps":true}"#);
        assert_eq!(s.level_of(&[0, 9, 0x30]), Some(Level::Steps(Steps::new(3, 4).unwrap())));
        let t = least(r#""table":[{"value":0,"word":"low"},{"value":2,"word":"full"}]"#);
        assert_eq!(t.level_of(&[0, 9, 0x20]), Some(Level::Coarse(Coarse::Full)));
        assert_eq!(t.level_of(&[0, 9, 0x10]), None, "a value the table does not list");
    }

    #[test]
    fn the_defined_reader_only_listens() {
        let d = parse(GOOD).unwrap();
        let far = Instant::now() + Duration::from_secs(2);
        let mut t = FakeHid::new(id());
        t.mode = OpenMode::Read;
        t.stream.extend([vec![1, 9, 9], vec![3, 0, 0, 0, 0, 77, 0b100]]);
        let (o, at) = read(&mut t, &d, far, None, 5_000);
        assert_eq!(o, Outcome::Read(Reading::new(Level::Exact(Percent::new(77).unwrap()), Charging::Yes, 5_000)));
        assert_eq!(at, Some(5_000));
        assert!(t.sent.is_empty(), "nothing sent, ever");
        // (A handle opened for writing is refused: the reader never runs on one.)
        let mut w = FakeHid::new(id());
        w.mode = OpenMode::ReadWrite;
        w.stream.push_back(vec![3, 0, 0, 0, 0, 77, 0]);
        assert_eq!(read(&mut w, &d, far, None, 1).0, Outcome::Failed);
        let mut fe = FakeHid::new(id());
        fe.mode = OpenMode::Feature;
        assert_eq!(read(&mut fe, &d, far, None, 1).0, Outcome::Failed);
        let mut qo = FakeHid::new(id());
        assert_eq!(qo.mode, OpenMode::QueryOnly);
        assert_eq!(read(&mut qo, &d, far, None, 1).0, Outcome::Failed, "only a handle opened to listen");
        // (Silent: no answer — or asleep once it has been quiet for asleepAfter.)
        let mut q = FakeHid::new(id());
        q.mode = OpenMode::Read;
        assert_eq!(read(&mut q, &d, far, Some(1_000), 60_000).0, Outcome::NoAnswer);
        assert_eq!(read(&mut q, &d, far, Some(1_000), 121_000).0, Outcome::Read(Reading::asleep(121_000)));
        assert_eq!(read(&mut q, &d, far, None, 121_000).0, Outcome::NoAnswer, "never heard: not asleep, just no answer");
        // (Its report with a value outside the scale: heard, no level.)
        let mut b = FakeHid::new(id());
        b.mode = OpenMode::Read;
        b.stream.push_back(vec![3, 0, 0, 0, 0, 120, 0]);
        let (o, at) = read(&mut b, &d, far, None, 9);
        assert_eq!(o, Outcome::Read(Reading::unknown(crate::model::Note::None, Charging::No, 9)));
        assert_eq!(at, Some(9));
        // (A deadline passed: no answer at once.)
        let mut p = FakeHid::new(id());
        p.mode = OpenMode::Read;
        p.stream.push_back(vec![3, 0, 0, 0, 0, 50, 0]);
        assert_eq!(read(&mut p, &d, Instant::now() - Duration::from_millis(1), None, 9).0, Outcome::NoAnswer);
    }

    #[test]
    fn a_definition_naming_a_forbidden_collection_is_refused() {
        let page = |p: &str| with(r#""usagePage": "0xFF00""#, &format!("\"usagePage\": \"{}\"", p));
        for p in ["0x07", "0x0C", "0x0D", "0x84", "0x85"] {
            assert_eq!(code(&page(p)), ("forbidden", "match.usagePage".into()), "page {}", p);
        }
        for u in ["1", "2", "6", "7", "128"] {
            let t = with(r#""usagePage": "0xFF00", "usage": 1"#, &format!("\"usagePage\": 1, \"usage\": {}", u));
            assert_eq!(code(&t), ("forbidden", "match.usage".into()), "generic desktop usage {}", u);
        }
        // (A keyboard page with no usage named, too; the pads' and vendors' own collections still read.)
        let no_usage = with(r#""usagePage": "0xFF00", "usage": 1"#, r#""usagePage": 7"#);
        assert_eq!(code(&no_usage), ("forbidden", "match.usagePage".into()));
        for (p, u) in [(1, 5), (1, 4), (1, 8), (6, 0x20), (0xFF00, 1), (0xFFA0, 0x80)] {
            let t = with(r#""usagePage": "0xFF00", "usage": 1"#, &format!("\"usagePage\": {}, \"usage\": {}", p, u));
            assert!(parse(&t).is_ok(), "{:#x}/{:#x} allowed", p, u);
        }
        assert!(forbidden_usage(0x01, 0x80) && forbidden_usage(0x0C, 1) && !forbidden_usage(0x01, 0x05));
    }

    #[test]
    fn collection_ok_follows_the_teach_rule() {
        let c = |page: u16, usage: u16| HidIdent { vid: 0x1234, pid: 0x5678, usage_page: page, usage, interface: 1 };
        // (A made-up unit whose keyboard is listed BEFORE its vendor collection: the vendor collection passes, the
        // keyboard never.)
        let unit = [(0x01, 0x06), (0xFF00, 0x01)];
        assert!(!collection_ok(&c(0x01, 0x06), &unit, None, 8, false), "the keyboard");
        assert!(!collection_ok(&c(0x01, 0x06), &unit, None, 8, true), "the keyboard, even «use mine instead»");
        assert!(collection_ok(&c(0xFF00, 0x01), &unit, None, 8, false), "its vendor collection");
        // (A pure keyboard, a mouse, consumer keys.)
        assert!(!collection_ok(&c(0x07, 0x00), &[(0x07, 0x00)], None, 8, true));
        assert!(!collection_ok(&c(0x01, 0x02), &[(0x01, 0x02)], None, 8, true), "a mouse");
        assert!(!collection_ok(&c(0x0C, 0x01), &[(0x0C, 0x01)], None, 8, true), "media keys");
        // (A controller: allowed; a built-in reader's controller only with «use mine instead».)
        assert!(collection_ok(&c(0x01, 0x05), &[(0x01, 0x05)], None, 8, false));
        assert!(!collection_ok(&c(0x01, 0x05), &[(0x01, 0x05)], Some("playstation"), 8, false), "a built-in reader's: not without «use mine instead»");
        assert!(collection_ok(&c(0x01, 0x05), &[(0x01, 0x05)], Some("playstation"), 8, true));
        // (A built-in reader's mouse: «use mine instead» does not open the pointer.)
        assert!(!collection_ok(&c(0x01, 0x02), &[(0x01, 0x02), (0xFF00, 1)], Some("logitech"), 8, true));
        assert!(collection_ok(&c(0xFF00, 0x01), &[(0x01, 0x02), (0xFF00, 1)], Some("logitech"), 8, true), "its vendor collection with «use mine instead»");
        // (A unit with a digitizer: nothing of it, even its vendor collection.)
        let pen = [(0xFF00, 0x01), (0x0D, 0x02)];
        assert!(!collection_ok(&c(0xFF00, 0x01), &pen, None, 8, true));
        // (No input report: nothing to read.)
        assert!(!collection_ok(&c(0xFF00, 0x01), &[(0xFF00, 1)], None, 1, false));
    }

    #[test]
    fn matching_and_the_built_in_readers() {
        let d = parse(GOOD).unwrap();
        assert!(d.matcher.matches(&id(), " made up pad "));
        assert!(!d.matcher.matches(&id(), "Other"), "the product's own name narrows it");
        let mut other = id();
        other.usage = 2;
        assert!(!d.matcher.matches(&other, "Made Up Pad"));
        let a = Active { id: "a".into(), def: d.clone(), mine_first: false };
        assert!(find(std::slice::from_ref(&a), &id(), "Made Up Pad", false).is_some());
        assert!(find(std::slice::from_ref(&a), &id(), "Made Up Pad", true).is_none(), "a built-in reader's device: only with «use mine instead»");
        let b = Active { mine_first: true, ..a };
        assert!(find(std::slice::from_ref(&b), &id(), "Made Up Pad", true).is_some());
        // (A DualSense is the PlayStation reader's; a made-up product nobody's.)
        assert_eq!(builtin_for(0x054C, 0x0CE6), Some("playstation"));
        assert_eq!(builtin_for(0x1234, 0x5678), None);
    }
}
