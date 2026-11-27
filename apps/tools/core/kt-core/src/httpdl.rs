//! The Android HTTP downloader's decisions (stage M2): KrDownloader.java's rules as a state machine with no I/O.
//! Java keeps moving the bytes (HttpURLConnection with its DNS over HTTPS, cookies, proxy and Android's certificates,
//! the file writes, the threads); every choice is asked of this module and answered as an action:
//!
//! - `probe`: the answer to the first one-byte range — a web page in the file's place, the server's own name to take,
//!   the whole file in this answer (200), one plain request (no ranges), a refusal, or a file to cut (206 with a size).
//! - `Planner`: going on from before — the record read (`Record`, byte for byte KrDownloader.State's «kt1» text, so
//!   either engine resumes the other's download), the chunks whose tails are zero asked of Java, a few chunks compared
//!   with the server's (by Java) when the validator changed or is missing, the chunks of a file with no record found
//!   by their bytes; or a fresh plan: connections, chunk size.
//! - `Dl`: the run — which range a connection takes next (a chunk, a part given back, or the second half of the part
//!   that will take longest), what of the bytes read may be written (a part shortened by a split), the speeds, the
//!   record kept, what an error means (try again after how long, from the first address or the direct one; a refusal
//!   — 429/503, a 403 among accepted ones, a connection dropped twice before its first byte — that retires this
//!   connection and gives its part back; give up), connections added while the speed still rises, and the end (done,
//!   a second round over the connections still accepted, incomplete).
//!
//! Time is given by the caller (`now`, milliseconds), so every rule is tested here without a clock. Std only, stands
//! alone: `rustc --edition 2021 --test httpdl.rs`.
use std::collections::{BTreeMap, BTreeSet, VecDeque};

/// A part is cut in two only when each half keeps at least this much (KrDownloader's MIN_SPLIT).
pub const MIN_SPLIT: i64 = 256 << 10;
const MB: i64 = 1 << 20;
/// The bytes read at a done chunk's end to tell whether the disk really has it (KrDownloader.localCheck's buffer).
pub const ZERO_WINDOW: i64 = 4096;

/* ---------- Java's number reading ---------- */

/// Java's `String.trim()`: every char up to U+0020 off both ends.
fn jtrim(s: &str) -> &str {
    s.trim_matches(|c: char| c <= ' ')
}
/// `Long.parseLong` (a sign, then digits).
fn jlong(s: &str) -> Option<i64> {
    let d = s.strip_prefix('-').or_else(|| s.strip_prefix('+')).unwrap_or(s);
    if d.is_empty() || !d.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<i64>().ok()
}
fn jint(s: &str) -> Option<i64> {
    jlong(s).filter(|v| *v >= i32::MIN as i64 && *v <= i32::MAX as i64)
}

/* ---------- the record kept between runs ---------- */

/// KrDownloader.State: «kt1», the size, the validator, the chunk size, the done chunks' numbers, the begun chunks'
/// «number:bytes». Plain text, so Java's engine and this one read each other's.
#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub total: i64,
    pub validator: String,
    pub chunk: i64,
    pub done: BTreeSet<i64>,
    pub partial: BTreeMap<i64, i64>,
}

impl Record {
    pub fn new(total: i64, chunk: i64) -> Record {
        Record { total, validator: String::new(), chunk, done: BTreeSet::new(), partial: BTreeMap::new() }
    }
    /// State.read: None for anything Java would not take (another format, a bad number, no size or chunk).
    pub fn parse(text: &str) -> Option<Record> {
        let l: Vec<&str> = text.split('\n').collect();
        if l.len() < 5 || l[0] != "kt1" {
            return None;
        }
        let mut r = Record::new(jlong(jtrim(l[1]))?, 0);
        r.validator = jtrim(l[2]).to_string();
        r.chunk = jlong(jtrim(l[3]))?;
        for n in l[4].split(',') {
            let n = jtrim(n);
            if n.is_empty() {
                continue;
            }
            let i = jint(n)?;
            if i < 0 {
                return None; // (BitSet.set(-1) throws: the record is not taken)
            }
            r.done.insert(i);
        }
        if l.len() > 5 {
            for kv in l[5].split(',') {
                if let Some(c) = kv.find(':') {
                    if c > 0 {
                        if let (Some(k), Some(v)) = (jint(jtrim(&kv[..c])), jlong(jtrim(&kv[c + 1..]))) {
                            r.partial.insert(k, v);
                        }
                    }
                }
            }
        }
        if r.total > 0 && r.chunk > 0 {
            Some(r)
        } else {
            None
        }
    }
    /// State.write's text. (Java lists the begun chunks in its HashMap's order, this one in ascending order; both read
    /// either.)
    pub fn write(&self) -> String {
        let mut b = format!("kt1\n{}\n{}\n{}\n", self.total, self.validator.replace('\n', " "), self.chunk);
        for i in &self.done {
            b.push_str(&format!("{},", i));
        }
        b.push('\n');
        for (k, v) in &self.partial {
            if *v > 0 && !self.done.contains(k) {
                b.push_str(&format!("{}:{},", k, v));
            }
        }
        b
    }
    pub fn has(&self, i: i64) -> bool {
        self.done.contains(&i)
    }
    pub fn mark(&mut self, i: i64) {
        self.done.insert(i);
        self.partial.remove(&i);
    }
    pub fn partial_of(&self, i: i64) -> i64 {
        *self.partial.get(&i).unwrap_or(&0)
    }
    pub fn set_partial(&mut self, i: i64, v: i64) {
        if v > 0 {
            self.partial.insert(i, v);
        } else {
            self.partial.remove(&i);
        }
    }
    pub fn chunks(&self) -> i64 {
        (self.total + self.chunk - 1) / self.chunk
    }
}

/// Chunks: about a quarter of each connection's share, between 1 and 8 MB.
pub fn chunk_size(total: i64, n: i64) -> i64 {
    MB.max((8 * MB).min(total / 1.max(n * 4)))
}
/// Connections for a file: at most one per 512 KB, at least one.
pub fn connections_for(total: i64, max: i64) -> i64 {
    1.max(max.min(total / (512 * 1024)))
}

/* ---------- the first answer ---------- */

/// What Java read of the first answer (headers as HttpURLConnection.getHeaderField gives them, None when absent).
#[derive(Clone, Debug, Default)]
pub struct Head {
    pub code: i64,
    pub content_type: Option<String>,
    pub cf_mitigated: Option<String>,
    pub content_range: Option<String>,
    pub content_length: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    /// 200: the whole file comes in this answer (the record is dropped).
    Whole,
    /// No ranges (or no size): one plain request for the whole file.
    Single,
    /// A refusal with this status.
    Fail(i64),
    /// 206 with a size: cut into chunks.
    Ranged,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Probe {
    /// A web page (a site's check, a sign-in) where a file was expected.
    pub page: bool,
    /// The server's name and type to be given to the caller's `named` before going on.
    pub ask_name: bool,
    pub kind: Kind,
    /// The size as now known (`total_before` kept when this answer does not say).
    pub total: i64,
    pub ranged: bool,
    pub validator: String,
}

/// What tells this version of the file from another: its strong ETag and its date, kept as «etag @date» (either alone
/// when the other is missing; an older record holds one of them only) — KrDownloader.validatorOf.
pub fn validator_of(etag: Option<&str>, last_modified: Option<&str>) -> String {
    let e = match etag {
        Some(e) if !e.is_empty() && !e.starts_with("W/") => e,
        _ => "",
    };
    let l = jtrim(last_modified.unwrap_or(""));
    if e.is_empty() {
        l.to_string()
    } else if l.is_empty() {
        e.to_string()
    } else {
        format!("{} @{}", e, l)
    }
}

/// A validator's ETag and date (an older record's one value: an ETag when quoted, else a date).
fn version_parts(v: &str) -> (&str, &str) {
    if v.is_empty() {
        return ("", "");
    }
    match v.find(" @") {
        Some(i) => (&v[..i], &v[i + 2..]),
        None if v.starts_with('"') => (v, ""),
        None => ("", v),
    }
}

/// The same version: the same strong ETag, or — no ETag either side — the same date (KrDownloader.sameVersion).
pub fn same_version(before: &str, now: &str) -> bool {
    let (ae, al) = version_parts(before);
    let (be, bl) = version_parts(now);
    if !ae.is_empty() && ae == be {
        return true;
    }
    ae.is_empty() && be.is_empty() && !al.is_empty() && al == bl
}

/// The same date on both answers (KrDownloader.sameDate): the parts begun are kept when only the ETag changed.
pub fn same_date(before: &str, now: &str) -> bool {
    let (_, al) = version_parts(before);
    let (_, bl) = version_parts(now);
    !al.is_empty() && al == bl
}

/// Changed for sure: both dates there and different, and no common ETag (KrDownloader.changedVersion): begun afresh.
pub fn changed_version(before: &str, now: &str) -> bool {
    let (ae, al) = version_parts(before);
    let (be, bl) = version_parts(now);
    if !ae.is_empty() && ae == be {
        return false;
    }
    !al.is_empty() && !bl.is_empty() && al != bl
}

fn is_line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{85}' | '\u{2028}' | '\u{2029}')
}

/// KrDownloader.fetch's reading of the probe. `expect_name`: the file's expected name; `named`: whether the caller
/// takes the server's name; `total_before`: what the size was before (a second round keeps it when this answer has
/// none).
pub fn probe(h: &Head, expect_name: Option<&str>, named: bool, total_before: i64) -> Probe {
    let code = h.code;
    let mut p = Probe { page: false, ask_name: false, kind: Kind::Single, total: total_before, ranged: false, validator: String::new() };
    if h.cf_mitigated.as_deref().map(|v| v.eq_ignore_ascii_case("challenge")).unwrap_or(false) {
        p.page = true;
        return p;
    }
    let ct = h.content_type.as_deref().unwrap_or("").to_lowercase();
    if (ct.starts_with("text/html") || ct.starts_with("application/xhtml")) && [200, 206, 403, 503, 429].contains(&code) {
        if let Some(n) = expect_name {
            let low = n.to_lowercase();
            let page_name = !low.chars().any(is_line_end) && [".html", ".htm", ".xhtml", ".php", ".aspx", ".asp"].iter().any(|e| low.ends_with(e));
            if !page_name {
                let len = h.content_length.as_deref().and_then(jlong).unwrap_or(-1);
                if len < 2_000_000 {
                    p.page = true;
                    return p;
                }
            }
        }
    }
    p.ask_name = named && (code == 200 || code == 206);
    if code == 206 {
        if let Some(cr) = h.content_range.as_deref() {
            if let Some(i) = cr.rfind('/') {
                if let Some(t) = jlong(jtrim(&cr[i + 1..])) {
                    p.total = t;
                }
            }
        }
    }
    p.ranged = code == 206 && p.total > 0;
    if code == 200 {
        p.kind = Kind::Whole;
        if let Some(t) = h.content_length.as_deref().and_then(jlong) {
            p.total = t;
        }
    } else if !p.ranged {
        p.kind = if code >= 400 && code != 416 { Kind::Fail(code) } else { Kind::Single };
    } else {
        p.kind = Kind::Ranged;
        p.validator = validator_of(h.etag.as_deref(), h.last_modified.as_deref());
    }
    p
}

/// The plain request's answer (no ranges): Err(status) for a refusal, else the size as now known.
pub fn single(code: i64, content_length: Option<&str>, total_before: i64) -> Result<i64, i64> {
    if code >= 400 {
        return Err(code);
    }
    Ok(content_length.and_then(jlong).unwrap_or(total_before))
}

/// Retry-After as milliseconds from `now` (0: none, or not read). Digits are seconds (Java's long arithmetic, so a
/// huge value wraps as it does there); a date is an HTTP date (RFC 9110: IMF-fixdate, RFC 850, asctime).
pub fn retry_after_ms(v: Option<&str>, now: i64) -> i64 {
    let ra = match v {
        Some(x) => jtrim(x),
        None => return 0,
    };
    if !ra.is_empty() && ra.bytes().all(|b| b.is_ascii_digit()) {
        return match ra.parse::<i64>() {
            Ok(s) => s.wrapping_mul(1000),
            Err(_) => 0,
        };
    }
    match http_date(ra) {
        Some(t) => 0.max(t - now),
        None => 0,
    }
}

/// An HTTP date as milliseconds since 1970 (GMT).
pub fn http_date(s: &str) -> Option<i64> {
    const MON: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let low = s.to_ascii_lowercase();
    let w: Vec<&str> = low.split(|c: char| c == ' ' || c == ',' || c == '-').filter(|x| !x.is_empty()).collect();
    let mon = |m: &str| MON.iter().position(|x| *x == m).map(|i| i as i64 + 1);
    let num = |x: &str| x.parse::<i64>().ok();
    // IMF-fixdate «sun 06 nov 1994 08:49:37 gmt», RFC 850 «sunday 06 nov 94 08:49:37 gmt», asctime «sun nov 6 08:49:37 1994».
    let (d, m, y, t) = if w.len() >= 5 && mon(w[2]).is_some() {
        let y = num(w[3])?;
        (num(w[1])?, mon(w[2])?, if y < 100 { if y < 70 { 2000 + y } else { 1900 + y } } else { y }, w[4])
    } else if w.len() >= 5 && mon(w[1]).is_some() {
        (num(w[2])?, mon(w[1])?, num(w[4])?, w[3])
    } else {
        return None;
    };
    if w.len() >= 6 && !(w[5] == "gmt" || w[5] == "utc" || w[5] == "ut" || w[5] == "z") && mon(w[1]).is_none() {
        return None;
    }
    let tp: Vec<i64> = t.split(':').map(|x| x.parse::<i64>().ok()).collect::<Option<Vec<_>>>()?;
    if tp.len() != 3 || !(1..=31).contains(&d) || tp[0] > 23 || tp[1] > 59 || tp[2] > 60 {
        return None;
    }
    // (Days from 1970-01-01, the civil-calendar way.)
    let (yy, mm) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = (if yy >= 0 { yy } else { yy - 399 }) / 400;
    let yoe = yy - era * 400;
    let doy = (153 * mm + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 24 + tp[0]) * 60 + tp[1]) * 60_000 + tp[2] * 1000)
}

/* ---------- going on from before ---------- */

/// What the planner needs from Java next.
#[derive(Clone, Debug, PartialEq)]
pub enum Need {
    /// Whether the file's bytes from each of these places (ZERO_WINDOW of them, or to the file's end) are all zero.
    Zero(Vec<i64>),
    /// These chunks compared with the server's: for each, the windows [from, len] (its first and last 16 KB) read
    /// here and from the server and compared, over at most `threads` connections at once.
    Check { chunks: Vec<i64>, windows: Vec<Vec<(i64, i64)>>, threads: i64 },
    /// Planned: the run may begin.
    Go,
}

#[derive(Clone, Debug, PartialEq)]
enum Stage {
    LocalCheck { windows: Vec<(bool, i64, i64)> },
    Matches { picked: Vec<i64> },
    RecoverZero { at: Vec<i64> },
    RecoverCheck,
    Done,
}

/// The plan of one run over a cut file.
pub struct Planner {
    pub total: i64,
    pub validator: String,
    pub max_conn: i64,
    pub n: i64,
    prev: Option<Record>,
    stage: Stage,
    /// The record the run uses (set when planned).
    pub rec: Option<Record>,
    /// Java must empty the file and give it its size (a fresh download).
    pub fresh: bool,
    /// Java must give the file its size when shorter (chunks recovered from a file with no record).
    pub grow: bool,
}

/// The windows of a chunk compared with the server's: its first 16 KB, and its last when it is longer.
pub fn check_windows(rec: &Record, i: i64) -> Vec<(i64, i64)> {
    let start = i * rec.chunk;
    let end = rec.total.min((i + 1) * rec.chunk);
    let len = 16384.min(end - start);
    if len == end - start {
        vec![(start, len)]
    } else {
        vec![(start, len), (end - len, len)]
    }
}

impl Planner {
    /// `prev`: the record read (only when the file is there, as Java reads it); `out_len` / `out_exists`: the file.
    pub fn new(total: i64, validator: &str, max_conn: i64, prev: Option<Record>, out_len: i64, out_exists: bool) -> (Planner, Need) {
        let n = connections_for(total, max_conn);
        let mut p = Planner { total, validator: validator.to_string(), max_conn, n, prev, stage: Stage::Done, rec: None, fresh: false, grow: false };
        let same_size = p.prev.as_ref().map(|r| r.total == total && out_len == total).unwrap_or(false);
        let need = if same_size {
            // localCheck: done chunks whose last bytes are all zero; begun ones whose last 4 KB before their mark are.
            let prev = p.prev.as_mut().unwrap();
            let chunks = prev.chunks();
            let mut windows = Vec::new();
            for &i in prev.done.iter().filter(|i| **i < chunks) {
                let end = prev.total.min((i + 1) * prev.chunk);
                windows.push((true, i, end - ZERO_WINDOW.min(end - i * prev.chunk)));
            }
            let mut drop = Vec::new();
            for (&k, &v) in prev.partial.iter() {
                if v < ZERO_WINDOW {
                    drop.push(k);
                } else {
                    windows.push((false, k, k * prev.chunk + v - ZERO_WINDOW));
                }
            }
            for k in drop {
                prev.set_partial(k, 0);
            }
            let at: Vec<i64> = windows.iter().map(|w| w.2).collect();
            p.stage = Stage::LocalCheck { windows };
            if at.is_empty() {
                p.zero(&[])
            } else {
                Need::Zero(at)
            }
        } else if p.prev.is_none() && out_exists && out_len > 0 && out_len <= total {
            // No record: the chunks with bytes in them found, then checked against the server's.
            let r = Record::new(total, chunk_size(total, n));
            let mut at = Vec::new();
            for i in 0..r.chunks() {
                let end = total.min((i + 1) * r.chunk);
                if end > out_len {
                    break;
                }
                at.push(end - ZERO_WINDOW.min(end - i * r.chunk));
            }
            p.rec = Some(r);
            p.stage = Stage::RecoverZero { at: at.clone() };
            if at.is_empty() {
                p.zero(&[])
            } else {
                Need::Zero(at)
            }
        } else {
            p.fresh_plan()
        };
        (p, need)
    }

    fn fresh_plan(&mut self) -> Need {
        let mut r = Record::new(self.total, chunk_size(self.total, self.n));
        r.validator = self.validator.clone();
        self.rec = Some(r);
        self.fresh = true;
        self.stage = Stage::Done;
        Need::Go
    }
    fn resumed(&mut self, mut r: Record) -> Need {
        if !self.validator.is_empty() {
            r.validator = self.validator.clone();
        }
        self.rec = Some(r);
        self.stage = Stage::Done;
        Need::Go
    }

    /// Java's answer to `Need::Zero`: one flag per place asked, true when all zero (or nothing to read).
    pub fn zero(&mut self, zero: &[bool]) -> Need {
        match std::mem::replace(&mut self.stage, Stage::Done) {
            Stage::LocalCheck { windows } => {
                let mut prev = self.prev.take().unwrap();
                for (k, w) in windows.iter().enumerate() {
                    if zero.get(k).copied().unwrap_or(false) {
                        if w.0 {
                            prev.done.remove(&w.1);
                        } else {
                            prev.set_partial(w.1, 0);
                        }
                    }
                }
                if same_version(&prev.validator, &self.validator) {
                    return self.resumed(prev);
                }
                // (D4: another date — the file changed on the server —: begun afresh; not known: the parts begun dropped,
                // since nothing checks them, and the done chunks checked by their bytes. Before, a changed file was spliced.)
                if changed_version(&prev.validator, &self.validator) {
                    return self.fresh_plan();
                }
                // (D4c: the same date on both — an ETag that changed alone, a CDN's —: the parts begun are kept.)
                if !same_date(&prev.validator, &self.validator) {
                    prev.partial.clear();
                }
                // matches(): a few done chunks (the first, the last, some between) compared with the server's.
                let done: Vec<i64> = prev.done.iter().copied().collect();
                if done.is_empty() {
                    return self.resumed(prev);
                }
                let samples: i64 = 12;
                let mut picked: Vec<i64> = Vec::new();
                let size = done.len() as i64;
                let mut k = 0;
                while k < samples && k < size {
                    let i = done[(k * (size - 1) / 1.max(samples - 1)) as usize];
                    if !picked.contains(&i) {
                        picked.push(i);
                    }
                    k += 1;
                }
                let windows = picked.iter().map(|i| check_windows(&prev, *i)).collect();
                self.prev = Some(prev);
                self.stage = Stage::Matches { picked: picked.clone() };
                Need::Check { chunks: picked, windows, threads: 1.max(4.min(self.max_conn)) }
            }
            Stage::RecoverZero { at } => {
                let cand: Vec<i64> = (0..at.len() as i64).filter(|k| !zero.get(*k as usize).copied().unwrap_or(false)).collect();
                if cand.is_empty() {
                    return self.fresh_plan();
                }
                let rec = self.rec.as_ref().unwrap();
                let windows = cand.iter().map(|i| check_windows(rec, *i)).collect();
                self.stage = Stage::RecoverCheck;
                Need::Check { chunks: cand, windows, threads: 1.max(8.min(self.max_conn)) }
            }
            s => {
                self.stage = s;
                Need::Go
            }
        }
    }

    /// Java's answer to `Need::Check`: the chunks found the same, and whether the server could not be asked
    /// (KrDownloader.check: a broken check with nothing found counts as no answer).
    pub fn checked(&mut self, ok: &[i64], broken: bool) -> Need {
        let none = broken && ok.is_empty();
        match std::mem::replace(&mut self.stage, Stage::Done) {
            Stage::Matches { picked } => {
                let prev = self.prev.take().unwrap();
                if !none && ok.len() == picked.len() {
                    self.resumed(prev)
                } else {
                    self.fresh_plan()
                }
            }
            Stage::RecoverCheck => {
                let mut r = self.rec.take().unwrap();
                let found = if none { 0 } else { ok.len() };
                if !none {
                    for i in ok {
                        r.mark(*i);
                    }
                }
                if found > 0 {
                    self.grow = true;
                    self.resumed(r)
                } else {
                    self.fresh_plan()
                }
            }
            s => {
                self.stage = s;
                Need::Go
            }
        }
    }
}

/* ---------- the run ---------- */

/// One range a connection fetches (KrDownloader.Seg, with what its connection's tries need).
#[derive(Clone, Debug)]
pub struct Seg {
    pub start: i64,
    pub end: i64,
    pub pos: i64,
    pub stop_at: i64,
    pub chunk: i64,
    pub speed: f64,
    pub active: bool,
    pub worker: i64,
    last_t: i64,
    last_pos: i64,
    from_start: bool,
    chunk_start: i64,
    try_from: i64,
    attempt: i64,
    leave: bool,
}

#[derive(Clone, Debug, Default)]
struct Worker {
    served_once: bool,
    blanks: i64,
    gone: bool,
}

/// What a connection does next.
#[derive(Clone, Debug, PartialEq)]
pub enum Next {
    /// Fetch [from, to) as segment `seg` of chunk `idx`; `split`: the segment whose end was brought to `from`.
    Range { seg: usize, idx: i64, from: i64, to: i64, split: Option<(usize, i64)> },
    /// Nothing left for it (or the download failed).
    Exit,
}

/// What an error on a connection means.
#[derive(Clone, Debug, PartialEq)]
pub enum OnError {
    /// Try again after `wait_ms`; `first`: from the first address again (redirects and all), not the direct one.
    Retry { wait_ms: i64, first: bool },
    /// The server refuses one connection too many: this one stops, its part goes to the others.
    Leave,
    /// Out of tries: the download fails with this error.
    Fail,
}

/// How a run ends.
#[derive(Clone, Debug, PartialEq)]
pub enum End {
    /// A connection's error ended it.
    Throw,
    /// Parts given back after the others had finished: a second round over `connections`.
    Again { connections: i64 },
    /// Not all of it came.
    Incomplete,
    /// Whole: the record can go.
    Done,
    /// Stopped by the user: the record stays.
    Cancelled,
}

/// One cut download under way.
pub struct Dl {
    pub total: i64,
    pub chunk: i64,
    pub chunks: i64,
    pub n: i64,
    pub first: i64,
    pub retries: i64,
    pub rec: Record,
    next: i64,
    back: VecDeque<(i64, i64, i64)>,
    parts: Vec<i64>,
    pub alive: i64,
    pub refused: bool,
    pub connections: i64,
    pub failed: bool,
    pub got: i64,
    pub have: i64,
    last_save: i64,
    pub save_seq: i64,
    pub segs: Vec<Seg>,
    workers: BTreeMap<i64, Worker>,
    pub started: i64,
    last_t: i64,
    last_got: i64,
    fast: f64,
    slow: f64,
    before: f64,
    wait: i64,
}

impl Dl {
    /// The run of a planned download. `refused`: a refusal already seen (a second round adds no connections).
    pub fn new(rec: Record, n: i64, scale: bool, retries: i64, refused: bool, now: i64) -> Dl {
        let total = rec.total;
        let chunk = rec.chunk;
        let chunks = rec.chunks();
        let mut have = 0;
        for i in 0..chunks {
            let len = total.min((i + 1) * chunk) - i * chunk;
            if rec.has(i) {
                have += len;
            } else if rec.partial_of(i) > 0 {
                have += rec.partial_of(i).min(len);
            }
        }
        let first = if scale && n > 3 { 3.max((n + 2) / 4) } else { n };
        Dl {
            total,
            chunk,
            chunks,
            n,
            first,
            retries,
            rec,
            next: 0,
            back: VecDeque::new(),
            parts: vec![0; chunks.max(0) as usize],
            alive: first,
            refused,
            connections: first,
            failed: false,
            got: have,
            have,
            last_save: now,
            save_seq: 0,
            segs: Vec::new(),
            workers: BTreeMap::new(),
            started: first,
            last_t: now,
            last_got: have,
            fast: 0.0,
            slow: 0.0,
            before: 0.0,
            wait: 1,
        }
    }

    /// The done stretches, for the file map: [start, end) of each run of done chunks.
    pub fn done_runs(&self) -> Vec<(i64, i64)> {
        let mut runs = Vec::new();
        let mut from = -1;
        for i in 0..=self.chunks {
            let d = i < self.chunks && self.rec.has(i);
            if d && from < 0 {
                from = i;
            }
            if !d && from >= 0 {
                runs.push((from * self.chunk, self.total.min(i * self.chunk)));
                from = -1;
            }
        }
        runs
    }

    fn save(&mut self) -> Option<String> {
        self.save_seq += 1;
        Some(self.rec.write())
    }

    /// The record's text now (with its sequence number, so Java never writes an older one over a newer).
    pub fn record(&mut self) -> (i64, String) {
        self.save_seq += 1;
        (self.save_seq, self.rec.write())
    }

    /// The next range for connection `w`.
    pub fn next(&mut self, w: i64, now: i64) -> Next {
        self.workers.entry(w).or_default();
        if self.failed {
            return Next::Exit;
        }
        let mut split = None;
        let (idx, from, to_incl, given) = if let Some(g) = self.back.pop_front() {
            (g.0, g.1, g.2, true)
        } else {
            let mut idx = self.next;
            self.next += 1;
            while idx < self.chunks && self.rec.has(idx) {
                idx = self.next;
                self.next += 1;
            }
            if idx < self.chunks {
                let from = idx * self.chunk + self.rec.partial_of(idx).min(self.chunk - 1);
                let to = self.total.min((idx + 1) * self.chunk) - 1;
                self.parts[idx as usize] += 1;
                (idx, from, to, false)
            } else {
                // The end of the file: the part that will take longest cut in two, its second half taken here.
                let mut victim = None;
                let mut worst = 0.0;
                for (k, sg) in self.segs.iter().enumerate() {
                    if !sg.active || sg.chunk < 0 {
                        continue;
                    }
                    let rem = sg.stop_at - sg.pos;
                    if rem < 2 * MIN_SPLIT {
                        continue;
                    }
                    let eta = rem as f64 / 16_384.0f64.max(sg.speed);
                    if eta > worst {
                        worst = eta;
                        victim = Some(k);
                    }
                }
                let k = match victim {
                    Some(k) => k,
                    None => return Next::Exit,
                };
                let v = &mut self.segs[k];
                let rem = v.stop_at - v.pos;
                let from = v.pos + rem / 2;
                let to = v.stop_at - 1;
                v.stop_at = from;
                let idx = v.chunk;
                self.parts[idx as usize] += 1;
                split = Some((k, from));
                (idx, from, to, false)
            }
        };
        let chunk_start = idx * self.chunk;
        let from_start = !given && from == chunk_start + self.rec.partial_of(idx);
        self.segs.push(Seg {
            start: from,
            end: to_incl + 1,
            pos: from,
            stop_at: to_incl + 1,
            chunk: idx,
            speed: 0.0,
            active: true,
            worker: w,
            last_t: now,
            last_pos: from,
            from_start,
            chunk_start,
            try_from: from,
            attempt: 0,
            leave: false,
        });
        Next::Range { seg: self.segs.len() - 1, idx, from, to: to_incl + 1, split }
    }

    /// `r` bytes read for `seg`: how many of them are still its own to write (a split may have shortened it).
    pub fn take(&mut self, seg: usize, r: i64) -> Result<i64, String> {
        let s = self.segs.get_mut(seg).ok_or("no such segment")?;
        let n = r.min(0.max(s.stop_at - s.pos));
        if n > 0 {
            s.pos += n;
            self.got += n;
            let w = self.workers.entry(s.worker).or_default();
            w.served_once = true;
            w.blanks = 0;
        }
        Ok(n)
    }

    /// Written (all that was read): the speed, how far a chunk's own run got, the record every 3 s.
    pub fn wrote(&mut self, seg: usize, now: i64) -> Result<Option<String>, String> {
        let s = self.segs.get_mut(seg).ok_or("no such segment")?;
        if now - s.last_t >= 500 {
            let inst = (s.pos - s.last_pos) as f64 / ((now - s.last_t) as f64 / 1000.0);
            s.speed = if s.speed == 0.0 { inst } else { s.speed * 0.6 + inst * 0.4 };
            s.last_t = now;
            s.last_pos = s.pos;
        }
        if s.from_start {
            let (c, v) = (s.chunk, s.pos - s.chunk_start);
            self.rec.set_partial(c, v);
        }
        if now - self.last_save > 3000 {
            self.last_save = now;
            return Ok(self.save());
        }
        Ok(None)
    }

    /// An attempt on `seg` failed. `status`: the HTTP status (0: none); `cut`: the connection was cut by the server
    /// (not a timeout, not a refused address); `retry_after`: the header as sent.
    pub fn error(&mut self, seg: usize, status: i64, cut: bool, retry_after: Option<&str>, now: i64) -> Result<OnError, String> {
        if seg >= self.segs.len() {
            return Err("no such segment".into());
        }
        let wid = self.segs[seg].worker;
        let moved = self.segs[seg].pos > self.segs[seg].try_from;
        let alive_now = self.alive;
        let got = self.got;
        let w = self.workers.entry(wid).or_default();
        if moved {
            self.segs[seg].attempt = -1;
            w.served_once = true;
            w.blanks = 0;
        }
        let mut sc = status;
        // (A cut taken as a refusal only when this connection never got a byte through and was cut before the first
        // one twice running while others go on.)
        if sc == 0 && !w.served_once && cut {
            w.blanks += 1;
            if w.blanks >= 2 && alive_now > 1 {
                sc = 429;
            }
        }
        // (Some storage answers 403 to one connection too many while the others go on.)
        if (sc == 403 || sc == 401) && alive_now > 1 && got > 0 {
            sc = 429;
        }
        if sc == 429 || sc == 503 {
            self.alive -= 1;
            if self.alive >= 1 {
                self.workers.get_mut(&wid).unwrap().gone = true;
                let s = &mut self.segs[seg];
                s.active = false;
                s.leave = true;
                self.back.push_back((s.chunk, s.pos, s.stop_at - 1));
                self.refused = true;
                self.connections = self.alive;
                return Ok(OnError::Leave);
            }
            self.alive += 1;
        }
        let s = &mut self.segs[seg];
        if s.attempt >= self.retries {
            self.failed = true;
            return Ok(OnError::Fail);
        }
        let wait_ms = if moved {
            250
        } else {
            let after = retry_after_ms(retry_after, now);
            if after > 0 {
                60_000.min(after)
            } else {
                8000.min(400 * (s.attempt + 1) * if sc == 429 || sc == 503 { 3 } else { 1 })
            }
        };
        s.attempt += 1;
        s.try_from = s.pos;
        Ok(OnError::Retry { wait_ms, first: s.attempt >= 2 })
    }

    /// The connection is done with `seg` (finished, stopped, out of tries or leaving): a chunk whose parts have all
    /// come is marked done (the record kept at most every 1.5 s).
    pub fn seg_end(&mut self, seg: usize, now: i64) -> Result<(i64, Option<String>), String> {
        let s = self.segs.get_mut(seg).ok_or("no such segment")?;
        s.pos = s.pos.min(s.stop_at);
        s.active = false;
        s.speed = 0.0;
        if s.leave || s.pos < s.stop_at {
            return Ok((s.pos, None));
        }
        let (pos, idx) = (s.pos, s.chunk as usize);
        self.parts[idx] -= 1;
        if self.parts[idx] == 0 {
            self.rec.mark(idx as i64);
            if now - self.last_save > 1500 {
                self.last_save = now;
                return Ok((pos, self.save()));
            }
        }
        Ok((pos, None))
    }

    /// A connection's thread ends (`failed`: by an error).
    pub fn worker_end(&mut self, w: i64, failed: bool) {
        if failed {
            self.failed = true;
        }
        let gone = self.workers.get(&w).map(|x| x.gone).unwrap_or(false);
        if !gone {
            self.alive -= 1;
        }
    }

    /// Connection scaling begins (only when fewer than all were started).
    pub fn scale_begin(&mut self, now: i64) {
        self.last_t = now;
        self.last_got = self.got;
        self.fast = 0.0;
        self.slow = 0.0;
        self.before = 0.0;
        self.wait = 1;
    }
    /// Whether to look again in a second.
    pub fn scaling(&self, cancelled: bool, failed: bool) -> bool {
        self.started < self.n && !self.failed && !failed && !cancelled && !self.refused
    }
    /// A second later: None to stop looking, Some(k) connections to start now (0: none yet).
    pub fn scale(&mut self, now: i64, any_alive: bool) -> Option<i64> {
        if !any_alive {
            return None;
        }
        let sp = (self.got - self.last_got) as f64 / 0.001f64.max((now - self.last_t) as f64 / 1000.0);
        self.last_t = now;
        self.last_got = self.got;
        self.fast = if self.fast == 0.0 { sp } else { self.fast * 0.5 + sp * 0.5 };
        self.slow = if self.slow == 0.0 { sp } else { self.slow * 0.8 + sp * 0.2 };
        self.wait -= 1;
        if self.wait > 0 {
            return Some(0);
        }
        if self.before > 0.0 && self.fast < self.before * 1.06 {
            return None; // (the last step brought nothing: the line is full)
        }
        let add = (self.n - self.started).min(2.max(self.started));
        self.before = self.fast.max(self.slow);
        self.alive += add;
        self.started += add;
        self.connections = self.started;
        self.wait = 2;
        Some(add)
    }

    /// Every connection has ended.
    pub fn finish(&mut self, cancelled: bool, failed: bool) -> End {
        self.connections = self.connections.min(self.started);
        if (self.failed || failed) && !cancelled {
            return End::Throw;
        }
        if cancelled {
            return End::Cancelled;
        }
        if self.refused && !self.back.is_empty() {
            return End::Again { connections: 1.max(self.connections) };
        }
        if (0..self.chunks).any(|i| !self.rec.has(i)) || self.got < self.total {
            return End::Incomplete;
        }
        End::Done
    }
}

#[cfg(test)]
mod d4_version_tests {
    use super::*;
    #[test]
    fn validator_and_versions() {
        assert_eq!(validator_of(Some("\"a\""), Some("Tue, 03 Nov 2026 10:00:00 GMT")), "\"a\" @Tue, 03 Nov 2026 10:00:00 GMT");
        assert_eq!(validator_of(Some("W/\"a\""), Some("d")), "d");
        assert_eq!(validator_of(None, None), "");
        assert!(same_version("\"a\" @d1", "\"a\" @d2"));
        assert!(same_version("\"a\"", "\"a\" @d1"));
        assert!(same_version("d1", "d1"));
        assert!(!same_version("", ""));
        assert!(changed_version("\"a\" @d1", "\"b\" @d2"));
        assert!(changed_version("d1", "d2"));
        assert!(!changed_version("\"a\" @d1", "\"b\" @d1"));
        assert!(!changed_version("\"a\"", "\"b\""));
        assert!(same_date("\"a\" @d1", "\"b\" @d1"));
        assert!(!same_date("\"a\"", "\"b\""));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head(code: i64) -> Head {
        Head { code, ..Default::default() }
    }

    #[test]
    fn record_reads_and_writes_as_java() {
        let t = "kt1\n20971520\n\"v1\"\n1310720\n0,1,2,\n3:65536,5:131072,";
        let r = Record::parse(t).unwrap();
        assert_eq!(r.total, 20971520);
        assert_eq!(r.validator, "\"v1\"");
        assert_eq!(r.chunk, 1310720);
        assert_eq!(r.done.iter().copied().collect::<Vec<_>>(), vec![0, 1, 2]);
        assert_eq!(r.partial_of(3), 65536);
        assert_eq!(r.write(), t);
        // (Java's: an empty validator, no partial line at all, spaces.)
        let r = Record::parse("kt1\n 100 \n\n10\n\n").unwrap();
        assert_eq!((r.total, r.chunk, r.done.len(), r.partial.len()), (100, 10, 0, 0));
        assert_eq!(Record::parse("kt1\n100\n\n10\n").unwrap().write(), "kt1\n100\n\n10\n\n");
        assert!(Record::parse("kt1\n100\n\n10").is_none());
        assert!(Record::parse("kt2\n100\n\n10\n\n").is_none());
        assert!(Record::parse("kt1\n0\n\n10\n\n").is_none());
        assert!(Record::parse("kt1\n100\n\n0\n\n").is_none());
        assert!(Record::parse("kt1\nx\n\n10\n\n").is_none());
        assert!(Record::parse("kt1\n100\n\n10\n1,x,\n").is_none());
        assert!(Record::parse("kt1\n100\n\n10\n-1,\n").is_none());
        assert!(Record::parse("kt1\n+100\n\n10\n\n").is_some());
        // (A bad pair in the partial line is skipped, as Java's catch does; «:5» has no key.)
        let r = Record::parse("kt1\n100\n\n10\n1,\nx:5,:5,2:7,3:y,4: 9 ,").unwrap();
        assert_eq!(r.partial.iter().map(|(k, v)| (*k, *v)).collect::<Vec<_>>(), vec![(2, 7), (4, 9)]);
        // (Written: a done chunk's partial and zero ones are left out; a newline in the validator becomes a space.)
        let mut r = Record::new(100, 10);
        r.validator = "a\nb".into();
        r.mark(1);
        r.partial.insert(1, 5);
        r.set_partial(2, 0);
        r.set_partial(3, 4);
        assert_eq!(r.write(), "kt1\n100\na b\n10\n1,\n3:4,");
        assert_eq!(r.chunks(), 10);
    }

    #[test]
    fn sizes() {
        assert_eq!(connections_for(20 << 20, 8), 8);
        assert_eq!(connections_for(1 << 20, 8), 2);
        assert_eq!(connections_for(100, 8), 1);
        assert_eq!(connections_for(100, 0), 1);
        assert_eq!(chunk_size(20 << 20, 8), 1 << 20);
        assert_eq!(chunk_size(20 << 20, 4), 1310720);
        assert_eq!(chunk_size(1 << 30, 4), 8 << 20);
        assert_eq!(chunk_size(20 << 20, 1), 5 << 20);
    }

    #[test]
    fn the_probe() {
        let mut h = head(206);
        h.content_range = Some("bytes 0-0/20971520".into());
        h.etag = Some("\"v1\"".into());
        h.last_modified = Some("Mon".into());
        let p = probe(&h, Some("f.bin"), false, -1);
        assert_eq!((p.page, p.ask_name, p.kind.clone(), p.total, p.ranged, p.validator.as_str()), (false, false, Kind::Ranged, 20971520, true, "\"v1\" @Mon"));
        h.etag = Some("W/\"weak\"".into());
        assert_eq!(probe(&h, None, true, -1).validator, "Mon");
        assert!(probe(&h, None, true, -1).ask_name);
        h.etag = None;
        h.last_modified = None;
        assert_eq!(probe(&h, None, false, -1).validator, "");
        // A size Java cannot read: kept from before; unknown: a plain request.
        h.content_range = Some("bytes 0-0/*".into());
        let p = probe(&h, None, false, -1);
        assert_eq!((p.kind, p.ranged), (Kind::Single, false));
        assert_eq!(probe(&h, None, false, 77).kind, Kind::Ranged);
        // 200: the whole file now, its size from Content-Length when it says.
        let mut h = head(200);
        h.content_length = Some("1234".into());
        assert_eq!((probe(&h, None, false, -1).kind, probe(&h, None, false, -1).total), (Kind::Whole, 1234));
        h.content_length = Some("12x".into());
        assert_eq!(probe(&h, None, false, 9).total, 9);
        // Refusals; 416 (an empty file) read in one piece.
        assert_eq!(probe(&head(404), None, false, -1).kind, Kind::Fail(404));
        assert_eq!(probe(&head(416), None, false, -1).kind, Kind::Single);
        assert_eq!(probe(&head(302), None, false, -1).kind, Kind::Single);
        assert!(!probe(&head(404), None, true, -1).ask_name);
        // A page where a file was expected; a big page, or one named as a page, is a file.
        let mut h = head(200);
        h.content_type = Some("Text/HTML; charset=utf-8".into());
        assert!(probe(&h, Some("movie.mkv"), false, -1).page);
        assert!(!probe(&h, None, false, -1).page);
        assert!(!probe(&h, Some("index.HTML"), false, -1).page);
        assert!(!probe(&h, Some("a.aspx"), false, -1).page);
        h.content_length = Some("2000000".into());
        assert!(!probe(&h, Some("movie.mkv"), false, -1).page);
        h.code = 503;
        h.content_length = None;
        assert!(probe(&h, Some("movie.mkv"), false, -1).page);
        h.code = 404;
        assert!(!probe(&h, Some("movie.mkv"), false, -1).page);
        let mut h = head(206);
        h.cf_mitigated = Some("Challenge".into());
        assert!(probe(&h, None, false, -1).page);
        assert_eq!(single(200, Some("10"), -1), Ok(10));
        assert_eq!(single(200, None, -1), Ok(-1));
        assert_eq!(single(403, None, -1), Err(403));
    }

    #[test]
    fn retry_after() {
        assert_eq!(retry_after_ms(None, 0), 0);
        assert_eq!(retry_after_ms(Some(" 3 "), 0), 3000);
        assert_eq!(retry_after_ms(Some("x"), 0), 0);
        assert_eq!(retry_after_ms(Some("-3"), 0), 0);
        assert_eq!(retry_after_ms(Some("99999999999999999999"), 0), 0);
        let t = http_date("Sun, 06 Nov 1994 08:49:37 GMT").unwrap();
        assert_eq!(t, 784111777000);
        assert_eq!(http_date("Sunday, 06-Nov-94 08:49:37 GMT"), Some(t));
        assert_eq!(http_date("Sun Nov  6 08:49:37 1994"), Some(t));
        assert_eq!(retry_after_ms(Some("Sun, 06 Nov 1994 08:49:47 GMT"), t), 10_000);
        assert_eq!(retry_after_ms(Some("Sun, 06 Nov 1994 08:49:27 GMT"), t), 0);
        assert_eq!(http_date("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0));
        assert_eq!(http_date("Sat, 29 Feb 2025 00:00:00 GMT").is_some(), true);
        assert_eq!(http_date("Tue, 29 Feb 2000 12:00:00 GMT"), Some(951825600000));
        assert!(http_date("soon").is_none());
    }

    fn rec_with(total: i64, chunk: i64, done: &[i64], partial: &[(i64, i64)], v: &str) -> Record {
        let mut r = Record::new(total, chunk);
        r.validator = v.into();
        for d in done {
            r.done.insert(*d);
        }
        for (k, p) in partial {
            r.partial.insert(*k, *p);
        }
        r
    }

    #[test]
    fn plan_fresh_and_resumed() {
        let total = 20 << 20;
        // Nothing before: fresh, chunks of a quarter share.
        let (p, need) = Planner::new(total, "\"v1\"", 8, None, 0, false);
        assert_eq!(need, Need::Go);
        assert!(p.fresh);
        assert_eq!(p.rec.as_ref().unwrap().chunk, 1 << 20);
        assert_eq!(p.rec.as_ref().unwrap().validator, "\"v1\"");
        // The same file: its done chunks' tails checked; one found zero is fetched again; the validator agrees.
        let prev = rec_with(total, 1 << 20, &[0, 1, 19], &[(2, 100), (3, 8192)], "\"v1\"");
        let (mut p, need) = Planner::new(total, "\"v1\"", 8, Some(prev), total, true);
        assert_eq!(need, Need::Zero(vec![(1 << 20) - 4096, (2 << 20) - 4096, (20 << 20) - 4096, (3 << 20) + 8192 - 4096]));
        assert_eq!(p.zero(&[false, true, false, false]), Need::Go);
        let r = p.rec.unwrap();
        assert_eq!(r.done.iter().copied().collect::<Vec<_>>(), vec![0, 19]);
        assert_eq!(r.partial.iter().map(|(k, v)| (*k, *v)).collect::<Vec<_>>(), vec![(3, 8192)]);
        assert!(!p.fresh);
        // Another validator: a few chunks compared with the server's; all the same → resumed with the new validator.
        let prev = rec_with(total, 1 << 20, &[0, 1, 2, 3], &[], "\"old\"");
        let (mut p, _) = Planner::new(total, "\"new\"", 8, Some(prev.clone()), total, true);
        // (Java's spread, k·(size−1)/11: with four done chunks every sample is the first one.)
        match p.zero(&[false; 4]) {
            Need::Check { chunks, windows, threads } => {
                assert_eq!(chunks, vec![0]);
                assert_eq!(threads, 4);
                assert_eq!(windows[0], vec![(0, 16384), ((1 << 20) - 16384, 16384)]);
            }
            n => panic!("{:?}", n),
        }
        assert_eq!(p.checked(&[0], false), Need::Go);
        assert!(!p.fresh);
        assert_eq!(p.rec.unwrap().validator, "\"new\"");
        // It differs, or the server could not be asked: begun afresh.
        let (mut p, _) = Planner::new(total, "\"new\"", 8, Some(prev.clone()), total, true);
        p.zero(&[false; 4]);
        p.checked(&[], false);
        assert!(p.fresh);
        let (mut p, _) = Planner::new(total, "", 8, Some(prev.clone()), total, true);
        p.zero(&[false; 4]);
        p.checked(&[], true);
        assert!(p.fresh);
        // (Broken after some were found: compared by count, as Java does.)
        let (mut p, _) = Planner::new(total, "", 8, Some(prev.clone()), total, true);
        p.zero(&[false; 4]);
        p.checked(&[0], true);
        assert!(!p.fresh);
        // No validator and no done chunk: resumed, but its begun chunks dropped — nothing can tell they are the same file
        // (D4: a file changed on the server was spliced from them).
        let prev = rec_with(total, 1 << 20, &[], &[(0, 10000)], "");
        let (mut p, need) = Planner::new(total, "", 8, Some(prev), total, true);
        assert_eq!(need, Need::Zero(vec![10000 - 4096]));
        assert_eq!(p.zero(&[false]), Need::Go);
        assert_eq!(p.rec.unwrap().partial_of(0), 0);
        // An ETag that changed alone, the same date (a CDN's): its begun chunks kept (D4c).
        let prev = rec_with(total, 1 << 20, &[], &[(0, 10000)], "\"e\" @d1");
        let (mut p, _) = Planner::new(total, "\"g\" @d1", 8, Some(prev), total, true);
        assert_eq!(p.zero(&[false]), Need::Go);
        assert_eq!(p.rec.unwrap().partial_of(0), 10000);
        // The same ETag: its begun chunks kept; another date: begun afresh.
        let prev = rec_with(total, 1 << 20, &[], &[(0, 10000)], "\"e\" @d1");
        let (mut p, _) = Planner::new(total, "\"e\" @d2", 8, Some(prev.clone()), total, true);
        assert_eq!(p.zero(&[false]), Need::Go);
        assert_eq!(p.rec.unwrap().partial_of(0), 10000);
        let (mut p, _) = Planner::new(total, "\"f\" @d2", 8, Some(prev), total, true);
        assert_eq!(p.zero(&[false]), Need::Go);
        assert!(p.fresh);
        // Another size: fresh.
        let (p, _) = Planner::new(total, "", 8, Some(rec_with(total + 1, 1 << 20, &[0], &[], "")), total, true);
        assert!(p.fresh);
        // Twelve samples spread over many done chunks: the first, the last, some between.
        let many: Vec<i64> = (0..20).collect();
        // (ETags alone that differ — a CDN's —: checked by the bytes. Two different dates would be a new file, begun afresh.)
        let (mut p, _) = Planner::new(total, "\"b\"", 8, Some(rec_with(total, 1 << 20, &many, &[], "\"a\"")), total, true);
        match p.zero(&[false; 20]) {
            Need::Check { chunks, .. } => assert_eq!(chunks, vec![0, 1, 3, 5, 6, 8, 10, 12, 13, 15, 17, 19]),
            n => panic!("{:?}", n),
        }
    }

    #[test]
    fn plan_recovers_without_a_record() {
        let total = 20 << 20;
        let (mut p, need) = Planner::new(total, "\"v\"", 4, None, 10 << 20, true);
        // (Chunks of 1.25 MB for 4 connections: the eight whose ends are in the 10 MB here.)
        match &need {
            Need::Zero(at) => assert_eq!(at.len(), 8),
            n => panic!("{:?}", n),
        }
        match p.zero(&[false, false, true, false, false, false, false, true]) {
            Need::Check { chunks, threads, .. } => {
                assert_eq!(chunks, vec![0, 1, 3, 4, 5, 6]);
                assert_eq!(threads, 4);
            }
            n => panic!("{:?}", n),
        }
        assert_eq!(p.checked(&[0, 1, 3], false), Need::Go);
        assert!(p.grow && !p.fresh);
        let r = p.rec.unwrap();
        assert_eq!(r.done.iter().copied().collect::<Vec<_>>(), vec![0, 1, 3]);
        assert_eq!(r.validator, "\"v\"");
        // Nothing with bytes, or none the same: fresh.
        let (mut p, _) = Planner::new(total, "", 4, None, 10 << 20, true);
        assert_eq!(p.zero(&[true; 8]), Need::Go);
        assert!(p.fresh);
        let (mut p, _) = Planner::new(total, "", 4, None, 10 << 20, true);
        p.zero(&[false; 8]);
        p.checked(&[], false);
        assert!(p.fresh);
        // A file longer than this one, or empty: fresh.
        assert!(Planner::new(total, "", 4, None, total + 1, true).0.fresh);
        assert!(Planner::new(total, "", 4, None, 0, true).0.fresh);
        // Shorter than a chunk: nothing to look at.
        assert!(Planner::new(total, "", 4, None, 1000, true).0.fresh);
    }

    fn run(total: i64, n: i64, scale: bool) -> Dl {
        let (p, _) = Planner::new(total, "", n, None, 0, false);
        Dl::new(p.rec.unwrap(), p.n, scale, 5, false, 0)
    }

    fn range(x: Next) -> (usize, i64, i64, i64, Option<(usize, i64)>) {
        match x {
            Next::Range { seg, idx, from, to, split } => (seg, idx, from, to, split),
            Next::Exit => panic!("exit"),
        }
    }

    #[test]
    fn chunks_in_order_and_done() {
        let mut d = run(4 << 20, 8, false);
        assert_eq!((d.n, d.first, d.chunk, d.chunks), (8, 8, 1 << 20, 4));
        for i in 0..4 {
            let (seg, idx, from, to, _) = range(d.next(i, 0));
            assert_eq!((idx, from, to), (i, i << 20, (i + 1) << 20));
            assert_eq!(d.take(seg, 1 << 20).unwrap(), 1 << 20);
            d.wrote(seg, 10).unwrap();
            assert_eq!(d.seg_end(seg, 10).unwrap().0, (i + 1) << 20);
        }
        // (Nothing left and nothing worth cutting: the others leave.)
        assert_eq!(d.next(4, 10), Next::Exit);
        for w in 0..8 {
            d.worker_end(w, false);
        }
        assert_eq!(d.finish(false, false), End::Done);
        assert_eq!(d.got, 4 << 20);
    }

    #[test]
    fn resumed_chunks_and_partials() {
        let mut r = Record::new(4 << 20, 1 << 20);
        r.mark(0);
        r.mark(2);
        r.set_partial(1, 1000);
        let mut d = Dl::new(r, 4, false, 5, false, 0);
        assert_eq!(d.have, (2 << 20) + 1000);
        assert_eq!(d.done_runs(), vec![(0, 1 << 20), (2 << 20, 3 << 20)]);
        let (seg, idx, from, _, _) = range(d.next(0, 0));
        assert_eq!((idx, from), (1, (1 << 20) + 1000));
        // (Its own run from where it got: how far it gets is kept.)
        d.take(seg, 500).unwrap();
        d.wrote(seg, 0).unwrap();
        assert_eq!(d.rec.partial_of(1), 1500);
        let (seg3, idx, _, _, _) = range(d.next(1, 0));
        assert_eq!(idx, 3);
        // The record every 3 s.
        d.take(seg3, 10).unwrap();
        assert!(d.wrote(seg3, 3000).unwrap().is_none());
        let saved = d.wrote(seg3, 3001).unwrap().unwrap();
        assert!(saved.starts_with("kt1\n4194304\n\n1048576\n0,2,\n1:1500,3:10,"), "{}", saved);
    }

    #[test]
    fn the_slow_part_is_cut_in_two() {
        let mut d = run(2 << 20, 2, false);
        assert_eq!(d.chunk, 1 << 20);
        let (a, _, _, _, _) = range(d.next(0, 0));
        let (b, _, _, _, _) = range(d.next(1, 0));
        // a crawls, b finishes.
        d.take(a, 100_000).unwrap();
        d.wrote(a, 600).unwrap();
        d.take(b, 1 << 20).unwrap();
        d.wrote(b, 600).unwrap();
        d.seg_end(b, 600).unwrap();
        let (c, idx, from, to, split) = range(d.next(1, 700));
        let rem = (1 << 20) - 100_000;
        assert_eq!((idx, from, to), (0, 100_000 + rem / 2, 1 << 20));
        assert_eq!(split, Some((a, from)));
        // a may write only up to the cut now.
        assert_eq!(d.take(a, rem).unwrap(), rem / 2);
        d.seg_end(a, 800).unwrap();
        assert!(!d.rec.has(0));
        d.take(c, rem).unwrap();
        d.seg_end(c, 900).unwrap();
        assert!(d.rec.has(0));
        // (Under 512 KB left: not cut again.)
        assert_eq!(d.next(0, 900), Next::Exit);
        d.worker_end(0, false);
        d.worker_end(1, false);
        assert_eq!(d.finish(false, false), End::Done);
    }

    #[test]
    fn errors_retry_back_off_and_give_up() {
        let mut d = run(4 << 20, 2, false);
        let (s, _, _, _, _) = range(d.next(0, 0));
        assert_eq!(d.error(s, 0, false, None, 0).unwrap(), OnError::Retry { wait_ms: 400, first: false });
        assert_eq!(d.error(s, 500, false, None, 0).unwrap(), OnError::Retry { wait_ms: 800, first: true });
        assert_eq!(d.error(s, 0, false, Some("2"), 0).unwrap(), OnError::Retry { wait_ms: 2000, first: true });
        assert_eq!(d.error(s, 0, false, Some("999"), 0).unwrap(), OnError::Retry { wait_ms: 60000, first: true });
        assert_eq!(d.error(s, 0, false, None, 0).unwrap(), OnError::Retry { wait_ms: 2000, first: true });
        assert_eq!(d.error(s, 0, false, None, 0).unwrap(), OnError::Fail);
        assert_eq!(d.next(0, 0), Next::Exit);
        assert_eq!(d.finish(false, false), End::Throw);
        assert_eq!(d.finish(true, false), End::Cancelled);
        // An attempt that brought bytes is no failure to count: 250 ms and on, however many times.
        let mut d = run(4 << 20, 2, false);
        let (s, _, _, _, _) = range(d.next(0, 0));
        for k in 0..20 {
            d.take(s, 1000).unwrap();
            assert_eq!(d.error(s, 0, true, None, k).unwrap(), OnError::Retry { wait_ms: 250, first: false });
        }
        // (No retries at all: still, a moved attempt goes on.)
        let (p, _) = Planner::new(4 << 20, "", 2, None, 0, false);
        let mut d = Dl::new(p.rec.unwrap(), 2, false, 0, false, 0);
        let (s, _, _, _, _) = range(d.next(0, 0));
        d.take(s, 1).unwrap();
        assert_eq!(d.error(s, 0, false, None, 0).unwrap(), OnError::Retry { wait_ms: 250, first: false });
        assert_eq!(d.error(s, 0, false, None, 0).unwrap(), OnError::Fail);
    }

    #[test]
    fn refusals_retire_a_connection() {
        let mut d = run(8 << 20, 4, false);
        let s: Vec<usize> = (0..4).map(|w| range(d.next(w, 0)).0).collect();
        // 503: this one leaves, its part back for the others.
        d.take(s[0], 100).unwrap();
        assert_eq!(d.error(s[0], 503, false, None, 0).unwrap(), OnError::Leave);
        assert!(d.refused);
        assert_eq!((d.alive, d.connections), (3, 3));
        d.seg_end(s[0], 0).unwrap();
        d.worker_end(0, false);
        assert_eq!(d.alive, 3);
        let (g, idx, from, to, _) = range(d.next(1, 0));
        assert_eq!((idx, from, to), (0, 100, 1 << 20));
        // 403 among accepted ones, bytes already here: a refusal too.
        assert_eq!(d.error(s[2], 403, false, None, 0).unwrap(), OnError::Leave);
        // 429 on the last but one, then the last one standing is not retired: it waits three times as long.
        assert_eq!(d.error(s[3], 429, false, None, 0).unwrap(), OnError::Leave);
        assert_eq!(d.alive, 1);
        assert_eq!(d.error(g, 429, false, None, 0).unwrap(), OnError::Retry { wait_ms: 1200, first: false });
        assert_eq!(d.alive, 1);
        // (403 alone, or before any byte came: an error like any other.)
        let mut e = run(8 << 20, 4, false);
        let a = range(e.next(0, 0)).0;
        range(e.next(1, 0));
        assert_eq!(e.error(a, 403, false, None, 0).unwrap(), OnError::Retry { wait_ms: 400, first: false });
        // A second round when parts came back after the others had finished.
        let mut f = run(8 << 20, 2, false);
        let a = range(f.next(0, 0)).0;
        let b = range(f.next(1, 0)).0;
        assert_eq!(f.error(a, 503, false, None, 0).unwrap(), OnError::Leave);
        f.seg_end(a, 0).unwrap();
        f.worker_end(0, false);
        f.error(b, 0, false, None, 0).unwrap();
        f.failed = false;
        f.worker_end(1, false);
        assert_eq!(f.finish(false, false), End::Again { connections: 1 });
    }

    #[test]
    fn dropped_connections() {
        // Cut twice before its first byte while others go on: a refusal.
        let mut d = run(8 << 20, 4, false);
        let s: Vec<usize> = (0..2).map(|w| range(d.next(w, 0)).0).collect();
        assert!(matches!(d.error(s[1], 0, true, None, 0).unwrap(), OnError::Retry { .. }));
        assert_eq!(d.error(s[1], 0, true, None, 0).unwrap(), OnError::Leave);
        // A cut after bytes came is the network: tried again, the connection kept, however often.
        let mut d = run(8 << 20, 4, false);
        let a = range(d.next(0, 0)).0;
        range(d.next(1, 0));
        d.take(a, 300 << 10).unwrap();
        for k in 0..10 {
            assert_eq!(d.error(a, 0, true, None, k).unwrap(), OnError::Retry { wait_ms: 250, first: false });
            assert!(matches!(d.error(a, 0, true, None, k).unwrap(), OnError::Retry { .. }));
            d.take(a, 1).unwrap();
        }
        assert!(!d.refused);
        // (A connection that brought bytes on an earlier part is not a refusing one either.)
        let seg_end = d.seg_end(a, 0).unwrap();
        assert!(seg_end.0 > 0);
        let b = range(d.next(0, 0)).0;
        assert!(matches!(d.error(b, 0, true, None, 0).unwrap(), OnError::Retry { .. }));
        assert!(matches!(d.error(b, 0, true, None, 0).unwrap(), OnError::Retry { .. }));
        assert!(!d.refused);
        // Alone: never taken as a refusal.
        let mut d = run(8 << 20, 1, false);
        let a = range(d.next(0, 0)).0;
        for _ in 0..3 {
            assert!(matches!(d.error(a, 0, true, None, 0).unwrap(), OnError::Retry { .. }));
        }
    }

    #[test]
    fn connections_added_while_the_speed_rises() {
        let mut d = run(20 << 20, 12, true);
        assert_eq!((d.n, d.first, d.alive), (12, 3, 3));
        d.scale_begin(0);
        assert!(d.scaling(false, false));
        assert!(!d.scaling(true, false));
        assert!(!d.scaling(false, true));
        // 1 MB/s for a second: the first step adds as many again (at least 2).
        d.got += 1 << 20;
        assert_eq!(d.scale(1000, true), Some(3));
        assert_eq!((d.started, d.alive, d.connections), (6, 6, 6));
        // Then a second of waiting, then the speed must have risen 6 %.
        d.got += 2 << 20;
        assert_eq!(d.scale(2000, true), Some(0));
        d.got += 2 << 20;
        assert_eq!(d.scale(3000, true), Some(6));
        assert_eq!(d.started, 12);
        assert!(!d.scaling(false, false));
        // The line full: no more.
        let mut d = run(20 << 20, 12, true);
        d.scale_begin(0);
        d.got += 1 << 20;
        d.scale(1000, true);
        d.got += 1 << 20;
        d.scale(2000, true);
        d.got += 1 << 20;
        assert_eq!(d.scale(3000, true), None);
        // No connection alive any more: stop looking.
        assert_eq!(run(20 << 20, 12, true).scale(1000, false), None);
        // A refusal stops it; scaling off starts them all.
        assert_eq!(run(20 << 20, 12, false).first, 12);
        assert_eq!(run(20 << 20, 3, true).first, 3);
        assert_eq!(run(20 << 20, 5, true).first, 3);
        assert_eq!(run(80 << 20, 24, true).first, 6);
    }

    #[test]
    fn incomplete_is_told() {
        let mut d = run(2 << 20, 2, false);
        let a = range(d.next(0, 0)).0;
        d.take(a, 1 << 20).unwrap();
        d.seg_end(a, 0).unwrap();
        d.worker_end(0, false);
        d.worker_end(1, false);
        assert_eq!(d.finish(false, false), End::Incomplete);
        assert!(d.take(99, 1).is_err());
    }
}
