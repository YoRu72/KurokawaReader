//! The floating translator's memory of the screen (stage M4): KtScreenTrack.java's rules — which piece of text is which
//! from one reading to the next, the loose comparison of texts (Java's `Character` answers, tables in javachar.in), and
//! what to translate ahead — with no Android and no Java object: the reading and what is followed come in as plain
//! values, the decisions go out as indices the Java side applies to its own items. Std only; checked alone with
//! `rustc --edition 2021 --test screentrack.rs` (the cases of tests/native/TkT.java and more).
//!
//! Text is UTF-16 units throughout (`&[u16]`), as Java's `String`: lengths, the 160-unit cut and «a letter» are the
//! units Java counts. `KtTranslate.norm` (Unicode NFC, which std cannot do) is the caller's: each text comes with its
//! normalised form beside it.

include!("javachar.in");
include!("javachar_fns.in");

/// Alike enough to be the same words read again.
pub const SAME: f64 = 0.8;
/// Within this many pixels a box stays where it is; beyond `GLIDE` it is put there at once.
pub const STILL: i32 = 3;
pub const GLIDE: i32 = 32;

/* ---------- text, compared loosely ---------- */

/// KtScreenTrack.loose: lower case, letters and digits only.
pub fn loose(s: &[u16]) -> Vec<u16> {
    s.iter().filter(|&&u| j_is_letter_or_digit_unit(u)).map(|&u| j_lower_unit(u)).collect()
}
/// KtScreenTrack.similarLoose: 1 − edit distance / the longer length (first 160 units).
pub fn similar_loose(x: &[u16], y: &[u16]) -> f64 {
    if x == y {
        return 1.0;
    }
    if x.is_empty() || y.is_empty() {
        return 0.0;
    }
    let lx = x.len().min(160) as i32;
    let ly = y.len().min(160) as i32;
    let longer = lx.max(ly);
    if (lx - ly).abs() > longer / 2 {
        return 1.0 - (lx - ly).abs() as f64 / longer as f64;
    }
    let ly_ = ly as usize;
    let mut prev: Vec<i32> = (0..=ly).collect();
    let mut cur = vec![0i32; ly_ + 1];
    for i in 1..=lx as usize {
        cur[0] = i as i32;
        let c = x[i - 1];
        for j in 1..=ly_ {
            cur[j] = (cur[j - 1].min(prev[j]) + 1).min(prev[j - 1] + if c == y[j - 1] { 0 } else { 1 });
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    1.0 - prev[ly_] as f64 / longer as f64
}
pub fn similar(a: &[u16], b: &[u16]) -> f64 {
    similar_loose(&loose(a), &loose(b))
}
/// KtScreenTrack.digits: the numbers standing alone, each followed by a space.
pub fn digits(s: &[u16]) -> Vec<u16> {
    let mut b = Vec::new();
    let n = s.len();
    let mut k = 0;
    while k < n {
        if !j_is_letter_or_digit_unit(s[k]) {
            k += 1;
            continue;
        }
        let mut e = k;
        let mut letters = false;
        while e < n && j_is_letter_or_digit_unit(s[e]) {
            if j_is_letter_unit(s[e]) {
                letters = true;
            }
            e += 1;
        }
        if !letters {
            b.extend_from_slice(&s[k..e]);
            b.push(0x20);
        }
        k = e;
    }
    b
}
fn contains(hay: &[u16], needle: &[u16]) -> bool {
    needle.is_empty() || hay.windows(needle.len()).any(|w| w == needle)
}
/// KtScreenTrack.containsLoose: `part` is a piece of `whole` (a line cut at the screen's edge).
pub fn contains_loose(whole: &[u16], part: &[u16]) -> bool {
    part.len() >= 3
        && whole.len() > part.len()
        && (contains(whole, part)
            || similar_loose(&whole[..whole.len().min(part.len())], part) >= SAME
            || similar_loose(&whole[whole.len() - whole.len().min(part.len())..], part) >= SAME)
}

/// Java's Math.hypot (fdlibm's e_hypot.c, as java.lang.FdLibm and Android's libm both compute it): the same last bit
/// as Java, which a platform's own hypot does not promise.
pub fn hypot(x: f64, y: f64) -> f64 {
    let hi = |v: f64| (v.to_bits() >> 32) as i32;
    let lo = |v: f64| v.to_bits() as u32;
    let with_hi = |v: f64, h: i32| f64::from_bits(((h as u32 as u64) << 32) | (v.to_bits() & 0xffff_ffff));
    let mut a = x.abs();
    let mut b = y.abs();
    let (mut ha, mut hb) = (hi(a) & 0x7fff_ffff, hi(b) & 0x7fff_ffff);
    if hb > ha {
        std::mem::swap(&mut a, &mut b);
        std::mem::swap(&mut ha, &mut hb);
    }
    a = with_hi(a, ha);
    b = with_hi(b, hb);
    if ha - hb > 0x3c00000 {
        return a + b;
    }
    let mut k: i32 = 0;
    if ha > 0x5f300000 {
        if ha >= 0x7ff00000 {
            let mut w = a + b;
            if ((ha & 0xfffff) | lo(a) as i32) == 0 {
                w = a;
            }
            if ((hb ^ 0x7ff00000) | lo(b) as i32) == 0 {
                w = b;
            }
            return w;
        }
        ha -= 0x25800000;
        hb -= 0x25800000;
        k += 600;
        a = with_hi(a, ha);
        b = with_hi(b, hb);
    }
    if hb < 0x20b00000 {
        if hb <= 0x000fffff {
            if (hb | lo(b) as i32) == 0 {
                return a;
            }
            let t1 = f64::from_bits(0x7fd00000u64 << 32);
            b *= t1;
            a *= t1;
            k -= 1022;
        } else {
            ha += 0x25800000;
            hb += 0x25800000;
            k -= 600;
            a = with_hi(a, ha);
            b = with_hi(b, hb);
        }
    }
    let mut w = a - b;
    if w > b {
        let t1 = f64::from_bits((ha as u32 as u64) << 32);
        let t2 = a - t1;
        w = (t1 * t1 - (b * (-b) - t2 * (a + t1))).sqrt();
    } else {
        a = a + a;
        let y1 = f64::from_bits((hb as u32 as u64) << 32);
        let y2 = b - y1;
        let t1 = f64::from_bits(((ha + 0x00100000) as u32 as u64) << 32);
        let t2 = a - t1;
        w = (t1 * y1 - (w * (-w) - (t1 * y2 + t2 * b))).sqrt();
    }
    if k != 0 {
        let t1 = f64::from_bits(((0x3ff00000 + (k << 20)) as u32 as u64) << 32);
        t1 * w
    } else {
        w
    }
}

/// f64's total order (f64::total_cmp) as an i64 key.
fn total_key(x: f64) -> i64 {
    let b = x.to_bits() as i64;
    b ^ (((b >> 63) as u64) >> 1) as i64
}
/// The positions of `keys` in ascending order, equal keys in their order (a merge sort, as Java's Collections.sort is
/// stable; one small function for every sort here, where std's would be built once per closure).
fn stable_order(keys: Vec<i64>) -> Vec<usize> {
    let n = keys.len();
    let mut a: Vec<usize> = (0..n).collect();
    let mut b = vec![0usize; n];
    let mut width = 1;
    while width < n {
        let mut lo = 0;
        while lo < n {
            let mid = (lo + width).min(n);
            let hi = (lo + 2 * width).min(n);
            let (mut i, mut j, mut k) = (lo, mid, lo);
            while i < mid && j < hi {
                if keys[a[j]] < keys[a[i]] {
                    b[k] = a[j];
                    j += 1;
                } else {
                    b[k] = a[i];
                    i += 1;
                }
                k += 1;
            }
            b[k..k + mid - i].copy_from_slice(&a[i..mid]);
            k += mid - i;
            b[k..k + hi - j].copy_from_slice(&a[j..hi]);
            lo = hi;
        }
        std::mem::swap(&mut a, &mut b);
        width *= 2;
    }
    a
}

/* ---------- following the pieces of text ---------- */

/// One piece followed (KtScreenTrack.Item as the update reads it). `blind`: the caller's predicate's answer for it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Item {
    pub text: Vec<u16>,
    pub norm: Vec<u16>,
    pub tr: Option<Vec<u16>>,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub miss: i32,
    pub clipped: bool,
    pub blind: bool,
}
/// One piece of text in a new reading (KtScreenTrack.Obs, its `data` left with Java).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Obs {
    pub text: Vec<u16>,
    pub norm: Vec<u16>,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Conf {
    pub vw: i32,
    pub vh: i32,
    pub keep_misses: i32,
    pub keep_off: bool,
    pub cap: i32,
    /// (left, top, right, bottom): the part of the screen read; None: all of it.
    pub area: Option<[i32; 4]>,
}
/// One piece after the update, in the extended list (the old pieces first, in their order, then the new ones).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Out {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub miss: i32,
    pub clipped: bool,
    /// The reading whose words it took (-1: kept its own).
    pub text_from: i32,
    /// The reading whose `data` it took (-1: kept its own).
    pub data_from: i32,
    pub dropped: bool,
}
/// What the update decided; every list holds indices into `items`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Answer {
    pub feedback: i32,
    pub of: Vec<usize>,
    pub items: Vec<Out>,
    pub added: Vec<usize>,
    pub dropped: Vec<usize>,
    pub retext: Vec<usize>,
    pub resized: Vec<usize>,
    pub glide: Vec<usize>,
    pub snap: Vec<usize>,
}

struct St {
    text: Vec<u16>,
    lo: Vec<u16>,
    norm: Vec<u16>,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    miss: i32,
    clipped: bool,
    blind: bool,
}

fn near(o: &Obs, i: &St, f: f64) -> bool {
    let hh = o.h.max(i.h) as f64;
    let ww = o.w.max(i.w) as f64;
    ((o.y as f64 + o.h as f64 / 2.0) - (i.y as f64 + i.h as f64 / 2.0)).abs() <= hh * f + 24.0
        && ((o.x as f64 + o.w as f64 / 2.0) - (i.x as f64 + i.w as f64 / 2.0)).abs() <= ww * 0.5 * f + 48.0
}
fn iou(o: &Obs, i: &St) -> f64 {
    let l = o.x.max(i.x);
    let t = o.y.max(i.y);
    let r = (o.x + o.w).min(i.x + i.w);
    let b = (o.y + o.h).min(i.y + i.h);
    if r <= l || b <= t {
        return 0.0;
    }
    let inter = (r - l) as f64 * (b - t) as f64;
    inter / (o.w as f64 * o.h as f64 + i.w as f64 * i.h as f64 - inter)
}
fn on_screen(i: &St, c: &Conf) -> bool {
    i.y + i.h > 0 && i.y < c.vh && i.x + i.w > 0 && i.x < c.vw
}
fn centre_in(i: &St, a: &[i32; 4]) -> bool {
    i.x + i.w / 2 >= a[0] && i.x + i.w / 2 < a[2] && i.y + i.h / 2 >= a[1] && i.y + i.h / 2 < a[3]
}
fn off(i: &St, c: &Conf) -> i32 {
    if i.y + i.h < 0 {
        -(i.y + i.h)
    } else if i.y > c.vh {
        i.y - c.vh
    } else {
        0
    }
}

/// KtScreenTrack.update, decision for decision: the same pairing (words first, place second, best first in Java's
/// stable order), the same reading of a clipped line, the same glide / snap / resize, misses, and the cap.
pub fn update(items: &[Item], obs: &[Obs], c: &Conf) -> Answer {
    let n = obs.len();
    let m0 = items.len();
    let mut ext: Vec<St> = items
        .iter()
        .map(|i| St { lo: loose(&i.text), text: i.text.clone(), norm: i.norm.clone(), x: i.x, y: i.y, w: i.w, h: i.h, miss: i.miss, clipped: i.clipped, blind: i.blind })
        .collect();
    let mut out: Vec<Out> = items.iter().map(|i| Out { x: i.x, y: i.y, w: i.w, h: i.h, miss: i.miss, clipped: i.clipped, text_from: -1, data_from: -1, dropped: false }).collect();
    let tr_lo: Vec<Option<Vec<u16>>> = items.iter().map(|i| i.tr.as_ref().map(|t| loose(t))).collect();
    let mut a = Answer::default();
    let mut of: Vec<Option<usize>> = vec![None; n];
    let lo: Vec<Vec<u16>> = obs.iter().map(|o| loose(&o.text)).collect();
    let mut own = vec![false; n];
    for k in 0..n {
        for (m, i) in ext.iter().enumerate() {
            let tl = match &tr_lo[m] {
                Some(t) => t,
                None => continue,
            };
            if lo[k].is_empty() || !near(&obs[k], i, 1.0) {
                continue;
            }
            let st = similar_loose(tl, &lo[k]);
            if st >= 0.9 && st > similar_loose(&i.lo, &lo[k]) + 0.1 {
                own[k] = true;
                a.feedback += 1;
                break;
            }
        }
    }
    // (score, k, m, sim), best first; Java's Collections.sort is stable, so is sort_by.
    let mut pairs: Vec<(f64, usize, usize, f64)> = Vec::new();
    for k in 0..n {
        if own[k] {
            continue;
        }
        let o = &obs[k];
        for (m, i) in ext.iter().enumerate() {
            let near_by = near(o, i, 1.5);
            let exact = i.lo == lo[k];
            if !near_by && !exact {
                continue;
            }
            let sim = if exact { 1.0 } else { similar_loose(&lo[k], &i.lo) };
            let io = iou(o, i);
            let ok = sim >= SAME || (near_by && io >= 0.5 && sim >= 0.3) || (contains_loose(&i.lo, &lo[k]) && near_by);
            if !ok {
                continue;
            }
            let dist = hypot((o.x as f64 + o.w as f64 / 2.0) - (i.x as f64 + i.w as f64 / 2.0), (o.y as f64 + o.h as f64 / 2.0) - (i.y as f64 + i.h as f64 / 2.0));
            let twin = o.norm == i.norm;
            let score = sim * 2.0 + if twin { 1.5 } else { 0.0 } + io + if near_by { 0.5 } else { 0.0 } - (1.0f64).min(dist / c.vh.max(1) as f64);
            pairs.push((score, k, m, sim));
        }
    }
    // (Best first: the score's total order, reversed; ties keep their order, as Java's stable sort.)
    let order = stable_order(pairs.iter().map(|p| !total_key(p.0)).collect());
    let pairs: Vec<(f64, usize, usize, f64)> = order.into_iter().map(|k| pairs[k]).collect();
    let clipped_at = |o: &Obs| o.y <= 2 || o.y + o.h >= c.vh - 2;
    let mut used = vec![false; m0];
    for &(_, k, m, sim) in &pairs {
        if of[k].is_some() || used[m] {
            continue;
        }
        used[m] = true;
        of[k] = Some(m);
        let o = &obs[k];
        let clipped_now = clipped_at(o);
        let i = &mut ext[m];
        let same = sim >= SAME && digits(&o.text) == digits(&i.text);
        let part = clipped_now && !i.clipped && contains_loose(&i.lo, &lo[k]);
        if part {
        } else if !same || (i.clipped && !clipped_now && lo[k].len() > i.lo.len()) {
            i.text = o.text.clone();
            i.lo = lo[k].clone();
            i.norm = o.norm.clone();
            a.retext.push(m);
            out[m].text_from = k as i32;
            out[m].data_from = k as i32;
            i.clipped = clipped_now;
        } else {
            i.clipped = clipped_now && i.clipped;
        }
        if !part {
            let cut_top = o.y <= 2 && o.h < i.h;
            let cut_bottom = o.y + o.h >= c.vh - 2 && o.h < i.h;
            let oy = if cut_top { o.y + o.h - i.h } else { o.y };
            let ex = o.x - i.x;
            let ey = oy - i.y;
            let e = ex.abs().max(ey.abs());
            if e > STILL {
                i.x = o.x;
                i.y = oy;
                if e <= GLIDE { a.glide.push(m) } else { a.snap.push(m) }
            }
            if !cut_top && !cut_bottom && ((o.w - i.w).abs() as f64 > (6.0f64).max(i.w as f64 * 0.08) || (o.h - i.h).abs() as f64 > (4.0f64).max(i.h as f64 * 0.12)) {
                i.w = o.w;
                i.h = o.h;
                if !a.retext.contains(&m) {
                    a.resized.push(m);
                    out[m].data_from = k as i32;
                }
            }
        }
        i.miss = 0;
    }
    // New pieces.
    for k in 0..n {
        if own[k] || of[k].is_some() {
            continue;
        }
        let o = &obs[k];
        let idx = ext.len();
        ext.push(St { text: o.text.clone(), lo: lo[k].clone(), norm: o.norm.clone(), x: o.x, y: o.y, w: o.w, h: o.h, miss: 0, clipped: clipped_at(o), blind: false });
        out.push(Out { x: o.x, y: o.y, w: o.w, h: o.h, miss: 0, clipped: clipped_at(o), text_from: k as i32, data_from: k as i32, dropped: false });
        of[k] = Some(idx);
        a.added.push(idx);
    }
    // Pieces not met again (Java walks its list from the end; removing keeps the others' order).
    let mut live: Vec<usize> = (0..ext.len()).collect();
    let mut p = live.len();
    while p > 0 {
        p -= 1;
        let m = live[p];
        if m < m0 && used[m] {
            continue;
        }
        if a.added.contains(&m) {
            continue;
        }
        let i = &mut ext[m];
        let in_read = match &c.area {
            None => on_screen(i, c),
            Some(ar) => centre_in(i, ar),
        };
        if in_read && i.blind {
            continue;
        }
        if in_read {
            i.miss += 1;
            if i.miss > c.keep_misses {
                live.remove(p);
                a.dropped.push(m);
            }
        } else if !on_screen(i, c) && !c.keep_off {
            live.remove(p);
            a.dropped.push(m);
        }
    }
    // Not more than `cap`: the farthest from the screen first (a stable sort, as Java's).
    if live.len() as i64 > c.cap as i64 {
        let far = live.clone();
        let far: Vec<usize> = stable_order(far.iter().map(|&p| -(off(&ext[p], c) as i64)).collect()).into_iter().map(|k| far[k]).collect();
        let mut k = 0;
        while live.len() as i64 > c.cap as i64 && k < far.len() {
            let x = far[k];
            if let Some(pos) = live.iter().position(|&v| v == x) {
                live.remove(pos);
            }
            a.dropped.push(x);
            k += 1;
        }
    }
    for (m, i) in ext.iter().enumerate() {
        let o = &mut out[m];
        o.x = i.x;
        o.y = i.y;
        o.w = i.w;
        o.h = i.h;
        o.miss = i.miss;
        o.clipped = i.clipped;
    }
    for &d in &a.dropped {
        out[d].dropped = true;
    }
    a.of = of.into_iter().map(|x| x.unwrap_or(usize::MAX)).collect();
    a.items = out;
    a
}

/* ---------- the binary form Java sends and reads (one copy each way, no JSON for a screenful of text) ---------- */
// Request: i32 M, i32 N; M items: x y w h miss clipped blind hasTr, text, norm, [tr]; N obs: x y w h, text, norm.
// A string: i32 count of UTF-16 units, then the units (little-endian). Answer: i32 feedback, i32 E, N × of, E × (x y w
// h miss clipped textFrom dataFrom dropped), then six lists (added dropped retext resized glide snap): i32 count, items.

pub struct Reader<'a> {
    b: &'a [u8],
    p: usize,
}
impl<'a> Reader<'a> {
    pub fn new(b: &'a [u8]) -> Self {
        Reader { b, p: 0 }
    }
    pub fn i32(&mut self) -> Result<i32, String> {
        let s = self.b.get(self.p..self.p + 4).ok_or("data: cut short")?;
        self.p += 4;
        Ok(i32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    pub fn count(&mut self) -> Result<usize, String> {
        let n = self.i32()?;
        if n < 0 || n as usize > self.b.len() {
            return Err("data: bad count".into());
        }
        Ok(n as usize)
    }
    pub fn units(&mut self) -> Result<Vec<u16>, String> {
        let n = self.count()?;
        let s = self.b.get(self.p..self.p + 2 * n).ok_or("data: cut short")?;
        self.p += 2 * n;
        Ok(s.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect())
    }
    pub fn done(&self) -> bool {
        self.p == self.b.len()
    }
}
pub fn read_request(b: &[u8]) -> Result<(Vec<Item>, Vec<Obs>), String> {
    let mut r = Reader::new(b);
    let m = r.count()?;
    let n = r.count()?;
    let mut items = Vec::with_capacity(m);
    for _ in 0..m {
        let (x, y, w, h, miss) = (r.i32()?, r.i32()?, r.i32()?, r.i32()?, r.i32()?);
        let (clipped, blind, has_tr) = (r.i32()? != 0, r.i32()? != 0, r.i32()? != 0);
        let text = r.units()?;
        let norm = r.units()?;
        let tr = if has_tr { Some(r.units()?) } else { None };
        items.push(Item { text, norm, tr, x, y, w, h, miss, clipped, blind });
    }
    let mut obs = Vec::with_capacity(n);
    for _ in 0..n {
        let (x, y, w, h) = (r.i32()?, r.i32()?, r.i32()?, r.i32()?);
        let text = r.units()?;
        let norm = r.units()?;
        obs.push(Obs { text, norm, x, y, w, h });
    }
    if !r.done() {
        return Err("data: trailing bytes".into());
    }
    Ok((items, obs))
}
pub fn write_answer(a: &Answer) -> Vec<u8> {
    let mut o: Vec<u8> = Vec::with_capacity(16 + 4 * (a.of.len() + 9 * a.items.len()));
    let put = |v: i32, o: &mut Vec<u8>| o.extend_from_slice(&v.to_le_bytes());
    put(a.feedback, &mut o);
    put(a.items.len() as i32, &mut o);
    for &k in &a.of {
        put(if k == usize::MAX { -1 } else { k as i32 }, &mut o);
    }
    for i in &a.items {
        for v in [i.x, i.y, i.w, i.h, i.miss, i.clipped as i32, i.text_from, i.data_from, i.dropped as i32] {
            put(v, &mut o);
        }
    }
    for l in [&a.added, &a.dropped, &a.retext, &a.resized, &a.glide, &a.snap] {
        put(l.len() as i32, &mut o);
        for &v in l.iter() {
            put(v as i32, &mut o);
        }
    }
    o
}

/* ---------- translating ahead ---------- */

/// A text of the app's tree (KtScreenTrack.Cand), with what Java alone can tell of it: `norm` — KtTranslate.norm of
/// the trimmed text —, and `known` — a translation already cached for it.
#[derive(Clone, Debug, Default)]
pub struct Cand {
    pub text: Vec<u16>,
    pub order: i32,
    pub on: bool,
    pub top: i32,
    pub bottom: i32,
    pub norm: Vec<u16>,
    pub known: bool,
}
/// KtScreenTrack.ahead: the indices of the candidates to translate ahead, in order (Java sends their trimmed text).
pub fn ahead(all: &[Cand], vh: i32, dir: i32, max: i32, max_chars: i32, screens: f64) -> Vec<usize> {
    let mut out = Vec::new();
    let (mut first, mut last) = (i32::MAX, i32::MIN);
    for c in all.iter().filter(|c| c.on) {
        first = first.min(c.order);
        last = last.max(c.order);
    }
    if last == i32::MIN || max <= 0 {
        return out;
    }
    let (mut below, mut above): (Vec<usize>, Vec<usize>) = (Vec::new(), Vec::new());
    for (k, c) in all.iter().enumerate() {
        if c.on {
            continue;
        }
        let placed = c.bottom > c.top;
        if placed && c.bottom > 0 && c.top < vh {
            continue;
        }
        if c.order > last {
            below.push(k);
        } else if c.order < first {
            above.push(k);
        }
    }
    let below: Vec<usize> = stable_order(below.iter().map(|&p| all[p].order as i64).collect()).into_iter().map(|k| below[k]).collect();
    let above: Vec<usize> = stable_order(above.iter().map(|&p| -(all[p].order as i64)).collect()).into_iter().map(|k| above[k]).collect();
    let (main, back) = if dir < 0 { (&above, &below) } else { (&below, &above) };
    let main_max = (max * 3 / 4).max(1);
    let mut chars = 0i32;
    let mut seen: Vec<Vec<u16>> = Vec::new();
    take(all, main, main_max, max_chars, vh, screens, if dir < 0 { -1 } else { 1 }, &mut seen, &mut chars, &mut out);
    let rest = max - out.len() as i32;
    take(all, back, rest, max_chars, vh, 0.5, if dir < 0 { 1 } else { -1 }, &mut seen, &mut chars, &mut out);
    out
}
#[allow(clippy::too_many_arguments)]
fn take(all: &[Cand], l: &[usize], max: i32, max_chars: i32, vh: i32, screens: f64, side: i32, seen: &mut Vec<Vec<u16>>, chars: &mut i32, out: &mut Vec<usize>) {
    let mut got = 0;
    for &k in l {
        let c = &all[k];
        if got >= max {
            return;
        }
        if c.bottom > c.top && (if side > 0 { c.top - vh } else { -c.bottom }) as f64 > screens * vh as f64 {
            return;
        }
        let t = j_trim(&c.text);
        if t.is_empty() || t.len() > 1500 || !t.iter().any(|&u| j_is_letter_unit(u)) {
            continue;
        }
        if seen.contains(&c.norm) {
            continue;
        }
        seen.push(c.norm.clone());
        if c.known {
            continue;
        }
        if *chars + t.len() as i32 > max_chars {
            return;
        }
        *chars += t.len() as i32;
        out.push(k);
        got += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(x: &str) -> Vec<u16> {
        u16s(x)
    }
    fn ob(t: &str, x: i32, y: i32, w: i32, h: i32) -> Obs {
        Obs { text: s(t), norm: s(t.trim()), x, y, w, h }
    }
    fn conf() -> Conf {
        Conf { vw: 1080, vh: 2400, keep_misses: 1, keep_off: true, cap: 400, area: None }
    }
    /// What a Java KtScreenTrack keeps between readings, applied from the answers (as KtScreenRs does).
    struct T {
        items: Vec<Item>,
        c: Conf,
    }
    impl T {
        fn new() -> T {
            T { items: Vec::new(), c: conf() }
        }
        fn up(&mut self, obs: &[Obs]) -> Answer {
            let a = update(&self.items, obs, &self.c);
            let mut ext: Vec<Item> = self.items.clone();
            for k in a.added.iter() {
                let _ = k;
                ext.push(Item::default());
            }
            for (m, o) in a.items.iter().enumerate() {
                let it = &mut ext[m];
                if o.text_from >= 0 {
                    it.text = obs[o.text_from as usize].text.clone();
                    it.norm = obs[o.text_from as usize].norm.clone();
                }
                it.x = o.x;
                it.y = o.y;
                it.w = o.w;
                it.h = o.h;
                it.miss = o.miss;
                it.clipped = o.clipped;
            }
            self.items = ext.into_iter().zip(a.items.iter()).filter(|(_, o)| !o.dropped).map(|(i, _)| i).collect();
            a
        }
        fn moved(&mut self, dx: i32, dy: i32) {
            for i in self.items.iter_mut() {
                i.x += dx;
                i.y += dy;
            }
        }
    }

    #[test]
    fn tables_match_java() {
        // (The checksum GenJavaChar.java printed from Java itself, over every code point.)
        let mut h: u64 = 0xcbf29ce484222325;
        for k in 0u32..=0x10FFFF {
            let v = (if k <= 0xFFFF { j_lower_unit(k as u16) as u64 } else { 0 }) * 4 + if j_is_letter(k) { 2 } else { 0 } + if j_is_digit(k) { 1 } else { 0 };
            h = (h ^ v).wrapping_mul(0x100000001b3);
        }
        assert_eq!(h, J_TABLES_CHECK);
        assert_eq!(j_digit(0x0663, 10), Some(3)); // ٣
        assert_eq!(j_digit(0xFF17, 10), Some(7)); // full-width 7
        assert_eq!(j_digit(0xFF26, 16), Some(15)); // full-width F
        assert_eq!(j_digit('g' as u16, 16), None);
        assert_eq!(j_parse(&s("+12"), 10, i32::MIN as i64, i32::MAX as i64), Some(12));
        assert_eq!(j_parse(&s("2147483648"), 10, i32::MIN as i64, i32::MAX as i64), None);
        assert_eq!(j_parse(&s("-2147483648"), 10, i32::MIN as i64, i32::MAX as i64), Some(-2147483648));
        assert_eq!(j_parse(&s("-"), 10, i64::MIN, i64::MAX), None);
        assert_eq!(j_parse(&s("٣٤"), 10, i64::MIN, i64::MAX), Some(34));
    }

    #[test]
    fn loose_texts_as_java() {
        // TkT's three.
        assert!(similar(&s("Hello world, again"), &s("HeIlo world. again")) >= SAME);
        assert!(similar(&s("Hello world"), &s("Goodbye moon")) < 0.5);
        assert_ne!(digits(&s("3 likes")), digits(&s("4 likes")));
        // Java's own answers (jshell): Arabic vowel marks are not letters to Character.isLetterOrDigit (Rust's
        // is_alphanumeric would keep them); «İ» lowers to «i» one for one; a letter outside the BMP is two
        // surrogates, neither a letter.
        assert_eq!(loose(&s("مَرْحَبًا")), s("مرحبا"));
        assert_eq!(loose(&s("İSTANBUL")), s("istanbul"));
        assert_eq!(loose(&s("a𠀋b")), s("ab"));
        assert_eq!(loose(&s("Ⅻ ²½ ٣")), s("٣")); // (letter numbers and other numbers are neither)
        assert_eq!(digits(&s("v2 has 10,5 x")), s("10 5 "));
        assert_eq!(similar_loose(&s("abc"), &s("abcdefgh")), 1.0 - 5.0 / 8.0);
        // (Long texts: only the first 160 units counted.)
        let a: Vec<u16> = std::iter::repeat('a' as u16).take(300).collect();
        let mut b = a.clone();
        b[200] = 'b' as u16;
        assert_eq!(similar_loose(&a, &b), 1.0);
        assert!(contains_loose(&s("thequickbrownfox"), &s("brownfox")));
        assert!(!contains_loose(&s("ab"), &s("a")));
    }

    #[test]
    fn stable_order_is_stable() {
        assert_eq!(stable_order(vec![3, 1, 2, 1, 3, 0]), vec![5, 1, 3, 2, 0, 4]);
        assert!(stable_order(vec![]).is_empty());
        let keys: Vec<i64> = (0..1000).map(|i| (i * 7919 % 13) as i64).collect();
        let o = stable_order(keys.clone());
        for w in o.windows(2) {
            assert!(keys[w[0]] < keys[w[1]] || (keys[w[0]] == keys[w[1]] && w[0] < w[1]));
        }
        let fs = [0.5, -0.0, 0.0, -1.0, 2.0, f64::MAX];
        let o = stable_order(fs.iter().map(|&f| total_key(f)).collect());
        assert_eq!(o, vec![3, 1, 2, 0, 4, 5]);
    }

    #[test]
    fn hypot_as_fdlibm() {
        // (Values from Java's Math.hypot.)
        assert_eq!(hypot(3.0, 4.0), 5.0);
        assert_eq!(hypot(0.0, 0.0), 0.0);
        assert_eq!(hypot(-1.5, 0.5).to_bits(), 1.5811388300841898f64.to_bits());
        assert_eq!(hypot(1e300, 1e300).to_bits(), 1.4142135623730952e300f64.to_bits());
        assert_eq!(hypot(f64::INFINITY, f64::NAN), f64::INFINITY);
        assert_eq!(hypot(5e-320, 0.0), 5e-320);
        assert_eq!(hypot(3e-310, 4e-310), 5e-310);
        assert_eq!(hypot(123.25, 0.001).to_bits(), 123.2500000040568f64.to_bits());
        assert_eq!(hypot(7.5, 1000.5).to_bits(), 1000.5281105496236f64.to_bits());
    }

    #[test]
    fn a_letter_misread_a_number_changed_a_line_missed() {
        let mut t = T::new();
        t.up(&[ob("Welcome back, traveller", 40, 300, 600, 50), ob("3 new messages", 40, 400, 400, 50)]);
        let u2 = t.up(&[ob("WeIcome back, traveIler.", 41, 302, 604, 49), ob("4 new messages", 40, 400, 400, 50)]);
        assert_eq!(u2.retext, vec![1]);
        assert_eq!(t.items[0].text, s("Welcome back, traveller"));
        assert!(u2.glide.is_empty() && u2.snap.is_empty() && u2.resized.is_empty());
        let u3 = t.up(&[ob("4 new messages", 40, 400, 400, 50)]);
        assert!(u3.dropped.is_empty() && t.items.len() == 2);
        let u4 = t.up(&[ob("4 new messages", 40, 400, 400, 50)]);
        assert_eq!(u4.dropped.len(), 1);
        let u5 = t.up(&[ob("4 new messages", 40, 420, 400, 50)]);
        assert!(u5.glide.len() == 1 && u5.snap.is_empty());
    }

    #[test]
    fn alike_lines_trading_places_are_not_swapped() {
        let mut t = T::new();
        t.up(&[ob("Yes, I know.", 40, 1000, 300, 50), ob("Yes, I know!", 40, 1060, 300, 50)]);
        t.moved(0, -60);
        let s1 = t.up(&[ob("Yes, I know.", 40, 940, 300, 50), ob("Yes, I know!", 40, 1000, 300, 50)]);
        assert_eq!(s1.of, vec![0, 1]);
        assert!(s1.retext.is_empty());
        let s2 = t.up(&[ob("Yes, I know.", 40, 880, 300, 50), ob("Yes, I know!", 40, 940, 300, 50)]);
        assert_eq!(s2.of, vec![0, 1]);
        assert!(s2.retext.is_empty());
    }

    #[test]
    fn own_translation_read_back_left_out() {
        let mut t = T::new();
        t.up(&[ob("Bonjour tout le monde", 40, 500, 500, 50)]);
        t.items[0].tr = Some(s("Hello everyone"));
        let u = t.up(&[ob("Bonjour tout le monde", 40, 500, 500, 50), ob("Hello everyone", 42, 505, 480, 45)]);
        assert_eq!(u.feedback, 1);
        assert!(u.added.is_empty() && t.items.len() == 1);
        assert_eq!(u.of[1], usize::MAX);
    }

    #[test]
    fn a_line_cut_at_the_edge() {
        let mut t = T::new();
        t.up(&[ob("The quick brown fox jumps over", 40, 2400 - 30, 800, 30)]);
        t.moved(0, -40);
        let u = t.up(&[ob("The quick brown fox jumps over the lazy dog", 40, 2400 - 70, 800, 60)]);
        assert_eq!(u.of[0], 0);
        assert_eq!(u.retext.len(), 1);
        t.moved(0, -(2400 - 50));
        let u = t.up(&[ob("the lazy dog", 40, 0, 800, 20)]);
        assert_eq!(u.of[0], 0);
        assert!(u.retext.is_empty());
        assert_eq!(t.items[0].text, s("The quick brown fox jumps over the lazy dog"));
    }

    #[test]
    fn leaving_and_coming_back_blind_area_and_cap() {
        let mut t = T::new();
        t.up(&[ob("A line that leaves", 40, 200, 600, 50)]);
        t.moved(0, -1500);
        t.up(&[]);
        t.up(&[]);
        t.moved(0, 1500);
        let b = t.up(&[ob("A line that leaves", 40, 201, 600, 50)]);
        assert!(b.of[0] == 0 && b.added.is_empty() && b.retext.is_empty());
        // Under our own box (blind) in a strip read: not missed.
        let mut t = T::new();
        t.up(&[ob("Under our box", 40, 2200, 500, 50)]);
        t.items[0].blind = true;
        t.c.area = Some([0, 2000, 1080, 2400]);
        t.up(&[]);
        t.up(&[]);
        assert_eq!(t.items.len(), 1);
        // Off the screen, not kept: dropped at once; the cap drops the farthest first.
        let mut t = T::new();
        t.c.cap = 2;
        t.up(&[ob("one line here", 40, 100, 300, 40), ob("two lines there", 40, 300, 300, 40)]);
        t.moved(0, -5000);
        let u = t.up(&[ob("three is new", 40, 900, 300, 40)]);
        assert_eq!(u.dropped, vec![0]);
        assert_eq!(t.items.len(), 2);
        t.c.keep_off = false;
        let u = t.up(&[ob("three is new", 40, 900, 300, 40)]);
        assert_eq!(u.dropped, vec![0]);
    }

    #[test]
    fn binary_round_trip() {
        let items = vec![Item { text: s("نص"), norm: s("نص"), tr: Some(s("text")), x: 1, y: -2, w: 3, h: 4, miss: 1, clipped: true, blind: false }];
        let obs = vec![ob("😀 x", 5, 6, 7, 8)];
        let mut b = Vec::new();
        let p = |v: i32, b: &mut Vec<u8>| b.extend_from_slice(&v.to_le_bytes());
        let ps = |t: &[u16], b: &mut Vec<u8>| {
            b.extend_from_slice(&(t.len() as i32).to_le_bytes());
            for u in t {
                b.extend_from_slice(&u.to_le_bytes());
            }
        };
        p(1, &mut b);
        p(1, &mut b);
        for v in [1, -2, 3, 4, 1, 1, 0, 1] {
            p(v, &mut b);
        }
        ps(&s("نص"), &mut b);
        ps(&s("نص"), &mut b);
        ps(&s("text"), &mut b);
        for v in [5, 6, 7, 8] {
            p(v, &mut b);
        }
        ps(&s("😀 x"), &mut b);
        ps(&s("😀 x"), &mut b);
        let (i2, o2) = read_request(&b).unwrap();
        assert_eq!(i2, items);
        assert_eq!(o2, obs);
        assert!(read_request(&b[..b.len() - 1]).is_err());
        let a = update(&i2, &o2, &conf());
        let w = write_answer(&a);
        assert_eq!(w.len(), 4 * (2 + 1 + 9 * a.items.len() + 6 + a.added.len() + a.dropped.len() + a.retext.len() + a.resized.len() + a.glide.len() + a.snap.len()));
    }

    #[test]
    fn ahead_as_tkt() {
        let vh = 2400;
        let mut cs = Vec::new();
        let cand = |t: String, order: i32, on: bool, top: i32, bottom: i32| Cand { norm: s(t.trim()), text: s(&t), order, on, top, bottom, known: false };
        for k in 0..10 {
            cs.push(cand(format!("Above {}", k), k, false, 0, 0));
        }
        cs.push(cand("Hidden tab".into(), 10, false, 500, 600));
        for k in 11..20 {
            cs.push(cand(format!("On screen {}", k), k, true, (k - 11) * 200, (k - 11) * 200 + 60));
        }
        for k in 20..80 {
            let t = if k == 25 { "Below 21".to_string() } else { format!("Below {}", k) };
            cs.push(cand(t, k, false, if k < 40 { vh + (k - 20) * 300 } else { 0 }, if k < 40 { vh + (k - 20) * 300 + 60 } else { 0 }));
        }
        let names = |v: &[usize], cs: &[Cand]| v.iter().map(|&k| String::from_utf16(&cs[k].text).unwrap()).collect::<Vec<_>>();
        let mut known = cs.clone();
        for c in known.iter_mut() {
            c.known = c.text == s("Below 22");
        }
        let ah = names(&ahead(&known, vh, 1, 20, 10_000, 2.0), &known);
        assert_eq!(&ah[..3], &["Below 20", "Below 21", "Below 23"]);
        assert!(!ah.contains(&"Hidden tab".to_string()) && !ah.contains(&"Below 22".to_string()));
        assert_eq!(ah.iter().filter(|x| *x == "Below 21").count(), 1);
        assert_eq!(ah.len(), 20);
        assert_eq!(ah.iter().filter(|x| x.starts_with("Below")).count(), 15);
        assert_eq!(ah[15], "Above 9");
        let ah2 = names(&ahead(&cs, vh, 1, 200, 10_000, 2.0), &cs);
        assert!(!ah2.contains(&"Below 39".to_string()) && ah2.contains(&"Below 35".to_string()));
        let up = names(&ahead(&cs, vh, -1, 8, 10_000, 2.0), &cs);
        assert_eq!(up[0], "Above 9");
        assert_eq!(up[5], "Above 4");
        assert!(up[6].starts_with("Below"));
        assert_eq!(ahead(&cs, vh, 1, 200, 30, 2.0).len(), 3);
        assert!(ahead(&cs[..10], vh, 1, 20, 1000, 2.0).is_empty());
        assert!(ahead(&cs, vh, 1, 0, 1000, 2.0).is_empty());
    }
}
