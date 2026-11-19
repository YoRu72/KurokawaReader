//! Search as you type over the folded names: each word must be in the name (or match it whole when it has `*` / `?`),
//! «path:…» or a word with a slash must be in the path, «ext:mp4,mkv» and «kind:video» narrow like the filters.
//! One pass over the columns, checked against the ticket's generation every few thousand entries: a newer query (the
//! next key typed) stops an older one instead of waiting behind it. The first N hits come back with the total.
use std::cmp::Ordering as Ord;
use std::collections::{BinaryHeap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use super::fold::{ext_of, fold, Kind};
use super::store::{grams, EntryId, Index, F_DEAD, F_DIR, F_LINK, F_ROOT, NONE};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum SortKey {
    /// Exact name, then the name without its extension, then the start, a word's start, anywhere; shorter first.
    #[default]
    Relevance,
    Name,
    Path,
    Size,
    Modified,
}

#[derive(Clone, Debug, Default)]
pub struct Query {
    /// What is typed: words, "quoted words", `*`/`?`, path:…, ext:…, kind:…
    pub text: String,
    /// Each must be in the full path (besides any path: in the text).
    pub path_contains: Vec<String>,
    /// Extensions without the dot (any of them).
    pub exts: Vec<String>,
    /// Any of these kinds.
    pub kinds: Vec<Kind>,
    pub size_min: Option<u64>,
    pub size_max: Option<u64>,
    /// Milliseconds since 1970, inclusive.
    pub mtime_min: Option<i64>,
    pub mtime_max: Option<i64>,
    pub sort: SortKey,
    pub descending: bool,
    /// The most hits returned (0: 200).
    pub limit: usize,
}

impl Query {
    pub fn text(t: &str) -> Query {
        Query { text: t.to_string(), ..Query::default() }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    pub id: EntryId,
    pub name: String,
    pub path: PathBuf,
    pub size: u64,
    pub mtime: i64,
    pub is_dir: bool,
    pub is_link: bool,
    pub kind: Kind,
}

#[derive(Clone, Debug)]
pub struct QueryResult {
    /// Every entry that matched (the hits are the first `limit` of them in the chosen order).
    pub total: usize,
    pub hits: Vec<Hit>,
    pub micros: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Cancelled;

/// One per search box: each `begin` makes the queries begun before it stop.
#[derive(Clone, Default)]
pub struct Searcher {
    gen: Arc<AtomicU64>,
}
pub struct Ticket {
    gen: Arc<AtomicU64>,
    mine: u64,
}
impl Searcher {
    pub fn new() -> Searcher {
        Searcher::default()
    }
    pub fn begin(&self) -> Ticket {
        let mine = self.gen.fetch_add(1, Ordering::SeqCst) + 1;
        Ticket { gen: self.gen.clone(), mine }
    }
    /// Stops every query begun so far (the page closed).
    pub fn cancel_all(&self) {
        self.gen.fetch_add(1, Ordering::SeqCst);
    }
}
impl Ticket {
    pub fn is_current(&self) -> bool {
        self.gen.load(Ordering::Relaxed) == self.mine
    }
}

/// The relevance order as a key (field order is the comparison order): tier, length, folded name, name, id.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct RelKey<'a> {
    tier: u8,
    len: u16,
    name: &'a str,
    raw: &'a [u8],
    id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Term {
    Sub(String),
    Glob(String, String), // the pattern and its longest literal run (a quick reject)
}

#[derive(Debug, Default)]
struct Parsed {
    terms: Vec<Term>,
    paths: Vec<String>,
    exts: Vec<String>,
    kinds: Vec<Kind>,
}

fn tokens(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in s.chars() {
        if c == '"' {
            quoted = !quoted;
            if !quoted && !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
        } else if c.is_whitespace() && !quoted {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
        } else {
            cur.push(c);
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn norm_path(s: &str) -> String {
    fold(s).replace('\\', "/")
}

fn longest_literal(p: &str) -> String {
    p.split(|c| c == '*' || c == '?').max_by_key(|s| s.len()).unwrap_or("").to_string()
}

fn parse(q: &Query) -> Parsed {
    let mut p = Parsed::default();
    for t in tokens(&q.text) {
        let lower = t.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("path:").map(|_| &t[5..]) {
            if !v.is_empty() {
                p.paths.push(norm_path(v));
            }
        } else if lower.starts_with("ext:") {
            p.exts.extend(t[4..].split(|c| c == ',' || c == ';').filter(|e| !e.is_empty()).map(|e| fold(e.trim_start_matches('.'))));
        } else if lower.starts_with("kind:") {
            p.kinds.extend(t[5..].split(|c| c == ',' || c == ';').filter_map(|k| Kind::parse(&k.to_ascii_lowercase())));
        } else if t.contains('/') || t.contains('\\') {
            p.paths.push(norm_path(&t));
        } else {
            let f = fold(&t);
            if f.is_empty() {
                continue;
            }
            if f.contains('*') || f.contains('?') {
                let lit = longest_literal(&f);
                p.terms.push(Term::Glob(f, lit));
            } else {
                p.terms.push(Term::Sub(f));
            }
        }
    }
    p.paths.extend(q.path_contains.iter().filter(|s| !s.is_empty()).map(|s| norm_path(s)));
    p.exts.extend(q.exts.iter().map(|e| fold(e.trim_start_matches('.'))));
    p.kinds.extend(q.kinds.iter().copied());
    p
}

/// `*` any run, `?` one character; the whole name must match. Byte-wise with UTF-8 steps for `?` and `*`.
pub fn glob_match(pat: &[u8], name: &[u8]) -> bool {
    let (mut p, mut n) = (0usize, 0usize);
    let mut star: Option<(usize, usize)> = None;
    let step = |b: u8| -> usize {
        if b < 0x80 { 1 } else if b >= 0xF0 { 4 } else if b >= 0xE0 { 3 } else { 2 }
    };
    while n < name.len() {
        if p < pat.len() && pat[p] == b'*' {
            star = Some((p, n));
            p += 1;
        } else if p < pat.len() && pat[p] == b'?' {
            p += 1;
            n = (n + step(name[n])).min(name.len());
        } else if p < pat.len() && pat[p] == name[n] {
            p += 1;
            n += 1;
        } else if let Some((sp, sn)) = star {
            let nn = sn + step(name[sn]);
            star = Some((sp, nn));
            p = sp + 1;
            n = nn;
        } else {
            return false;
        }
    }
    while p < pat.len() && pat[p] == b'*' {
        p += 1;
    }
    p == pat.len() && n == name.len()
}

fn tier(name: &str, term: &str) -> u8 {
    let (h, t) = (name.as_bytes(), term.as_bytes());
    if h == t {
        return 0;
    }
    if h.starts_with(t) {
        let ext = ext_of(name);
        if !ext.is_empty() && h.len() == t.len() + ext.len() + 1 {
            return 1;
        }
        return 2;
    }
    // A word's start: the match follows a character that is not a letter or a digit (byte scan, no searcher set-up).
    if t.is_empty() || h.len() < t.len() {
        return 4;
    }
    for i in 1..=h.len() - t.len() {
        if h[i] == t[0] && &h[i..i + t.len()] == t {
            let p = h[i - 1];
            let word_start = if p < 0x80 {
                !p.is_ascii_alphanumeric()
            } else {
                name[..i].chars().next_back().map_or(true, |c| !c.is_alphanumeric())
            };
            if word_start {
                return 3;
            }
        }
    }
    4
}

impl Index {
    /// Runs a query. Err(Cancelled) when a newer query began meanwhile (its answer is the one wanted).
    pub fn search(&self, q: &Query, ticket: &Ticket) -> Result<QueryResult, Cancelled> {
        let t0 = Instant::now();
        let pq = parse(q);
        let limit = if q.limit == 0 { 200 } else { q.limit };
        let primary: Option<&str> = pq.terms.iter().find_map(|t| if let Term::Sub(s) = t { Some(s.as_str()) } else { None });
        let has_globs = pq.terms.iter().any(|t| matches!(t, Term::Glob(..)));
        // The longest plain word first: it rejects most names.
        let mut subs: Vec<&str> = pq.terms.iter().filter_map(|t| if let Term::Sub(s) = t { Some(s.as_str()) } else { None }).collect();
        subs.sort_by_key(|s| std::cmp::Reverse(s.len()));
        let min_len = subs.first().map_or(0, |s| s.len());
        // Every pair of bytes of every word (and of the globs' literal runs) must be in a name's sketch.
        let need: u64 = pq.terms.iter().fold(0u64, |m, t| match t {
            Term::Sub(s) => m | grams(s.as_bytes()),
            Term::Glob(p, _) => p.split(|c| c == '*' || c == '?').fold(m, |m, part| m | grams(part.as_bytes())),
        });
        let single: Option<u8> = match subs.as_slice() {
            [one] if one.len() == 1 => Some(one.as_bytes()[0]),
            _ => None,
        };
        let globs: Vec<(&[u8], &str)> = pq.terms.iter().filter_map(|t| if let Term::Glob(p, l) = t { Some((p.as_bytes(), l.as_str())) } else { None }).collect();
        let kind_mask: u8 = pq.kinds.iter().fold(0u8, |m, k| m | (1 << (*k as u8)));
        let (smin, smax) = (q.size_min, q.size_max);
        let (tmin, tmax) = (q.mtime_min, q.mtime_max);
        let mut parent_memo: HashMap<u32, String> = HashMap::new();
        let mut matched: Vec<(u32, u8)> = Vec::new();
        // Relevance (the usual order) keeps only the best `limit` while scanning: a name that cannot beat the worst
        // kept one is not ranked in full (a first letter typed matches most names).
        let use_heap = q.sort == SortKey::Relevance && !q.descending;
        let mut heap: BinaryHeap<RelKey> = BinaryHeap::with_capacity(if use_heap { limit + 1 } else { 0 });
        let mut total = 0usize;
        let n = self.slots();
        for i in 0..n {
            if i & 0x1FFF == 0 && !ticket.is_current() {
                return Err(Cancelled);
            }
            let fl = self.flags[i];
            if fl & (F_DEAD | F_ROOT) != 0 {
                continue;
            }
            if kind_mask != 0 && kind_mask & (1 << self.kind[i]) == 0 {
                continue;
            }
            if smin.is_some() || smax.is_some() {
                if fl & F_DIR != 0 {
                    continue; // a folder has no size of its own
                }
                let s = self.size[i];
                if smin.map_or(false, |m| s < m) || smax.map_or(false, |m| s > m) {
                    continue;
                }
            }
            if tmin.is_some() || tmax.is_some() {
                let t = self.mtime[i];
                if tmin.map_or(false, |m| t < m) || tmax.map_or(false, |m| t > m) {
                    continue;
                }
            }
            if (self.fold_len[i] as usize) < min_len || self.grams[i] & need != need {
                continue;
            }
            let name = self.folded(i as u32);
            match single {
                Some(b) => {
                    if !name.as_bytes().contains(&b) {
                        continue;
                    }
                }
                None => {
                    if !subs.iter().all(|s| name.contains(*s)) {
                        continue;
                    }
                }
            }
            if !globs.iter().all(|(p, lit)| name.contains(*lit) && glob_match(p, name.as_bytes())) {
                continue;
            }
            if !pq.exts.is_empty() {
                let e = ext_of(name);
                if fl & F_DIR != 0 || !pq.exts.iter().any(|x| x == e) {
                    continue;
                }
            }
            if !pq.paths.is_empty() && !self.path_has(i as u32, name, &pq.paths, &mut parent_memo) {
                continue;
            }
            total += 1;
            if use_heap {
                let len = self.fold_len[i];
                if heap.len() >= limit {
                    let w = heap.peek().unwrap();
                    // The cheapest bound first: no tier below the kept worst's can come from a longer name unless it
                    // is a prefix (tiers 0–2), and the full word scan (tiers 3–4) is needed only when the worst is 3+.
                    let quick = match primary {
                        Some(p) => {
                            if name.as_bytes().starts_with(p.as_bytes()) {
                                Some(tier(name, p))
                            } else if w.tier < 3 {
                                None
                            } else {
                                Some(tier(name, p))
                            }
                        }
                        None if has_globs => Some(5),
                        None => Some(0),
                    };
                    let Some(t) = quick else { continue };
                    let k = RelKey { tier: t, len, name, raw: self.name_bytes(i as u32), id: i as u32 };
                    if k < *w {
                        heap.pop();
                        heap.push(k);
                    }
                } else {
                    let t = match primary {
                        Some(p) => tier(name, p),
                        None if has_globs => 5,
                        None => 0,
                    };
                    heap.push(RelKey { tier: t, len, name, raw: self.name_bytes(i as u32), id: i as u32 });
                }
            } else {
                let t = match (q.sort, primary) {
                    (SortKey::Relevance, Some(p)) => tier(name, p),
                    (SortKey::Relevance, None) if has_globs => 5,
                    _ => 0,
                };
                matched.push((i as u32, t));
            }
        }
        if !ticket.is_current() {
            return Err(Cancelled);
        }
        if use_heap {
            matched = heap.into_sorted_vec().into_iter().map(|k| (k.id, k.tier)).collect();
        }
        let ranks = if q.sort == SortKey::Path { Some(self.path_ranks()) } else { None };
        let cmp = |a: &(u32, u8), b: &(u32, u8)| -> Ord {
            let by_name = || {
                self.folded(a.0).cmp(self.folded(b.0)).then_with(|| self.name_bytes(a.0).cmp(self.name_bytes(b.0)))
            };
            let o = match q.sort {
                SortKey::Relevance => a.1.cmp(&b.1).then_with(|| self.fold_len[a.0 as usize].cmp(&self.fold_len[b.0 as usize])).then_with(by_name),
                SortKey::Name => by_name(),
                SortKey::Path => {
                    let r = ranks.as_ref().unwrap();
                    r[a.0 as usize].cmp(&r[b.0 as usize])
                }
                SortKey::Size => self.size[a.0 as usize].cmp(&self.size[b.0 as usize]).then_with(by_name),
                SortKey::Modified => self.mtime[a.0 as usize].cmp(&self.mtime[b.0 as usize]).then_with(by_name),
            };
            let o = o.then(a.0.cmp(&b.0));
            if q.descending { o.reverse() } else { o }
        };
        if matched.len() > limit {
            matched.select_nth_unstable_by(limit - 1, cmp);
            matched.truncate(limit);
        }
        if !use_heap {
            matched.sort_unstable_by(cmp);
        }
        let hits = matched
            .iter()
            .map(|&(id, _)| {
                let i = id as usize;
                Hit {
                    id,
                    name: self.name(id),
                    path: self.path_of(id),
                    size: self.size[i],
                    mtime: self.mtime[i],
                    is_dir: self.flags[i] & F_DIR != 0,
                    is_link: self.flags[i] & F_LINK != 0,
                    kind: self.kind(id),
                }
            })
            .collect();
        Ok(QueryResult { total, hits, micros: t0.elapsed().as_micros() as u64 })
    }

    fn path_has(&self, id: u32, folded_name: &str, terms: &[String], memo: &mut HashMap<u32, String>) -> bool {
        let p = self.parent[id as usize];
        let dir = memo.entry(p).or_insert_with(|| if p == NONE { String::new() } else { norm_path(&self.path_of(p).to_string_lossy()) });
        terms.iter().all(|t| {
            if dir.contains(t.as_str()) {
                return true;
            }
            let mut full = String::with_capacity(dir.len() + 1 + folded_name.len());
            full.push_str(dir);
            full.push('/');
            full.push_str(folded_name);
            full.contains(t.as_str())
        })
    }

    /// Each entry's place in path order (roots by path, then folder by folder by folded name), cached until a change.
    fn path_ranks(&self) -> Arc<Vec<u32>> {
        let mut g = self.path_rank.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((gen, r)) = g.as_ref() {
            if *gen == self.gen {
                return r.clone();
            }
        }
        let mut rank = vec![u32::MAX; self.slots()];
        let mut roots: Vec<(String, u32)> = self.roots.iter().map(|r| (norm_path(&r.spec.path.to_string_lossy()), r.id)).collect();
        roots.sort();
        let mut next = 0u32;
        for (_, rid) in roots {
            let mut stack = vec![rid];
            while let Some(x) = stack.pop() {
                rank[x as usize] = next;
                next += 1;
                let mut kids: Vec<u32> = self.children(x).collect();
                kids.sort_by(|a, b| self.folded(*a).cmp(self.folded(*b)).then_with(|| self.name_bytes(*a).cmp(self.name_bytes(*b))));
                stack.extend(kids.into_iter().rev());
            }
        }
        let rank = Arc::new(rank);
        *g = Some((self.gen, rank.clone()));
        rank
    }
}
