// Android stage M5: the Files add-on's job decisions as a PLANNER — native/android/KtFileJobs.java's rules (copy, move,
// delete; conflicts; «keep both» names; the folder-into-itself refusal; links not followed; a move that renames on one
// storage and copies across) taken out of its I/O and written as ordered steps, from a snapshot of the trees that Java
// took. Java (KtFileExec) executes the steps — every byte, every rename, every SAF call stays Java's — and Java's own
// planner (KtFilePlan.java) is the reference both are compared with, step for step.
//
// Why a planner and not kt-core's filejobs.rs: filejobs.rs is the PC's port of KtFileJobs with its I/O inside (it
// copies the files itself, with std::fs); Android must keep its I/O in Java (plain files today, SAF tomorrow), so the
// rules are the same but the shape is not. Where the two differ in a rule, Android's (Java's) is followed here — see
// ANDROID-PORT.md «M5» for the list.
//
// Also here, small rules of the same add-on: the bin's slot names and expiry (KtFiles.trash*), a rename's checks
// (KtFileJobs.rename), the archive's path safety and its «keep both» (KtArchive.unsafe / wanted / target), the vault's
// choice of files (KtVault.collect / open). Std only, alone: `rustc --edition 2021 --test fileplan.rs`.
use std::collections::{HashMap, HashSet};

/* ---------- the snapshot Java takes ---------- */

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    /// A file (or a link to one — File.isDirectory() false), or anything that is neither (a broken link: exists() false
    /// below the top level, read as a file that will fail to open).
    File,
    Dir,
    /// A symbolic link to a folder: never followed, never deleted through.
    LinkDir,
}

/// What stands at a node's natural place in the destination (dest/…/name) when the snapshot was taken.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tgt {
    pub exists: bool,
    pub dir: bool,
    pub file: bool,
    /// Files.isSameFile(source, target): the very same file or folder by another spelling.
    pub same: bool,
    /// Its names, when it is a folder (for «keep both» and the names a job makes).
    pub names: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Node {
    pub name: String,
    pub kind: Kind,
    /// File.length() (a folder's too, as Java counts a link to a folder).
    pub size: u64,
    /// isFile() — a file's size is what a delete counts.
    pub is_file: bool,
    /// The folder's entries in listFiles() order; None: it could not be read.
    pub kids: Option<Vec<Node>>,
    pub tgt: Tgt,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    /// File.getPath() of the chosen path.
    pub path: String,
    /// f.exists() when the job started.
    pub exists: bool,
    /// For a folder: KtFileJobs.inside(dest, f).
    pub into_itself: bool,
    /// For a move: KtFileJobs.sameStorage(f, dest).
    pub same_vol: bool,
    pub node: Node,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    /// copy | move | delete
    pub op: String,
    /// The standing answer: ask | skip | replace | keep (any other text is kept as it is, as Java keeps it).
    pub conflict: String,
    pub dest: String,
    pub dest_names: Vec<String>,
    pub items: Vec<Item>,
}

/* ---------- the steps ---------- */

/// One step of a plan. `item` is the chosen path's index; `frame` the folder being worked (frame numbers are given in
/// plan order; each item has a root frame of its own).
#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    /// The page is to be asked (the plan stops here until the answer is known).
    Ask { item: usize, from: String, to: String },
    /// A move on one storage: the whole of `from` renamed `to` (`files`, `bytes`: what it counts in the progress).
    Rename { item: usize, frame: usize, from: String, to: String, files: u64, bytes: u64 },
    /// A folder begun: `into` made when `mkdir` (`files`: what is left when that fails).
    Dir { item: usize, frame: usize, parent: usize, from: String, into: String, mkdir: bool, files: u64 },
    /// A file copied whole to `to` (by `to.ktpart`); `replace`: a file there set aside and dropped once the new one is
    /// in place; `mv`: the source deleted after.
    Copy { item: usize, frame: usize, from: String, to: String, size: u64, replace: bool, mv: bool },
    /// Skipped: a file counts as done (its size), a folder only as skipped; `files` left behind (a move).
    Skip { item: usize, frame: usize, from: String, size: u64, files: u64, dir: bool },
    /// Refused: the reason told as «name: why»; `files` left behind (a move).
    Fail { item: usize, frame: usize, from: String, why: String, files: u64 },
    /// A folder's end: when all inside it went well, the swap (a folder built under `into` put in the place of the file
    /// `to`) and, for a move, the emptied source folder removed.
    EndDir { item: usize, frame: usize, parent: usize, from: String, to: String, into: String, swap: bool, rmdir: bool },
    /// A delete job's one node (post-order), its size as counted.
    Del { item: usize, path: String, size: u64 },
    /// An item's end: `remaining` — a move lists it among the paths still there when it is.
    End { item: usize, remaining: bool },
}

pub fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 || (c as u32) > 0x7e => {
                let mut b = [0u16; 2];
                for u in c.encode_utf16(&mut b) {
                    o.push_str(&format!("\\u{:04x}", u));
                }
            }
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

impl Step {
    pub fn item(&self) -> usize {
        match self {
            Step::Ask { item, .. } | Step::Rename { item, .. } | Step::Dir { item, .. } | Step::Copy { item, .. } | Step::Skip { item, .. } | Step::Fail { item, .. } | Step::EndDir { item, .. } | Step::Del { item, .. } | Step::End { item, .. } => *item,
        }
    }
    /// A step that deletes, overwrites or moves users' data (cross-checked against Java's plan before it runs).
    pub fn destructive(&self) -> bool {
        match self {
            Step::Rename { .. } | Step::Del { .. } => true,
            Step::Copy { replace, mv, .. } => *replace || *mv,
            Step::EndDir { swap, rmdir, .. } => *swap || *rmdir,
            _ => false,
        }
    }
    /// The step as a JSON array, fixed positions (Java builds the same; ASCII only).
    pub fn to_json(&self) -> String {
        let s = json_str;
        let b = |x: bool| if x { "true" } else { "false" };
        match self {
            Step::Ask { item, from, to } => format!("[\"ask\",{},{},{}]", item, s(from), s(to)),
            Step::Rename { item, frame, from, to, files, bytes } => format!("[\"rename\",{},{},{},{},{},{}]", item, frame, s(from), s(to), files, bytes),
            Step::Dir { item, frame, parent, from, into, mkdir, files } => format!("[\"dir\",{},{},{},{},{},{},{}]", item, frame, parent, s(from), s(into), b(*mkdir), files),
            Step::Copy { item, frame, from, to, size, replace, mv } => format!("[\"copy\",{},{},{},{},{},{},{}]", item, frame, s(from), s(to), size, b(*replace), b(*mv)),
            Step::Skip { item, frame, from, size, files, dir } => format!("[\"skip\",{},{},{},{},{},{}]", item, frame, s(from), size, files, b(*dir)),
            Step::Fail { item, frame, from, why, files } => format!("[\"fail\",{},{},{},{},{}]", item, frame, s(from), s(why), files),
            Step::EndDir { item, frame, parent, from, to, into, swap, rmdir } => format!("[\"endDir\",{},{},{},{},{},{},{},{}]", item, frame, parent, s(from), s(to), s(into), b(*swap), b(*rmdir)),
            Step::Del { item, path, size } => format!("[\"del\",{},{},{}]", item, s(path), size),
            Step::End { item, remaining } => format!("[\"end\",{},{}]", item, b(*remaining)),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Plan {
    pub steps: Vec<Step>,
    /// The progress's totals: bytes, files (KtFileJobs.run's count / walkSize).
    pub total_bytes: u64,
    pub total_files: u64,
    /// True when the plan stops at an Ask (the rest waits for the answer).
    pub asks: bool,
    /// Bytes the copies will write (renames write none): what the destination must have free.
    pub copy_bytes: u64,
}

/* ---------- names ---------- */

/// `parent/name` as java.io.File writes it (no doubled separator at the root).
pub fn join(parent: &str, name: &str) -> String {
    if parent.ends_with('/') {
        format!("{}{}", parent, name)
    } else {
        format!("{}/{}", parent, name)
    }
}
fn parent_of(p: &str) -> String {
    match p.rfind('/') {
        Some(0) => "/".to_string(),
        Some(i) => p[..i].to_string(),
        None => String::new(),
    }
}
pub fn name_of(p: &str) -> &str {
    match p.rfind('/') {
        Some(i) => &p[i + 1..],
        None => p,
    }
}

/// KtFileJobs.extOf: the extension, lower case, when the last dot is not first nor last and at most 7 after it
/// (lengths in UTF-16 units, as Java counts).
pub fn ext_of(name: &str) -> String {
    let u: Vec<u16> = name.encode_utf16().collect();
    let i = match u.iter().rposition(|&c| c == b'.' as u16) {
        Some(i) => i,
        None => return String::new(),
    };
    if i > 0 && i < u.len() - 1 && u.len() - i <= 8 {
        String::from_utf16_lossy(&u[i + 1..]).to_lowercase()
    } else {
        String::new()
    }
}

/// KtFileJobs.keepBoth's candidates: «stem (i)ext» for i = 2…9999 (a folder's whole name numbered); the first that
/// `taken` does not hold, or the name itself when all are taken.
pub fn keep_both_name(name: &str, dir: bool, taken: &dyn Fn(&str) -> bool) -> String {
    let u: Vec<u16> = name.encode_utf16().collect();
    let ext = if dir { String::new() } else { ext_of(name) };
    let el = ext.encode_utf16().count();
    let (stem, e) = if ext.is_empty() || el + 1 > u.len() {
        (name.to_string(), String::new())
    } else {
        let cut = u.len() - el - 1;
        (String::from_utf16_lossy(&u[..cut]), String::from_utf16_lossy(&u[cut..]))
    };
    for i in 2..10000 {
        let c = format!("{} ({}){}", stem, i, e);
        if !taken(&c) {
            return c;
        }
    }
    name.to_string()
}

/* ---------- the planner ---------- */

#[derive(Clone, Copy, PartialEq)]
enum Have {
    Dir,
    File,
}

struct Planner<'a> {
    s: &'a Snapshot,
    mv: bool,
    standing: String,
    answers: &'a [String],
    next_answer: usize,
    rename_failed: &'a HashSet<String>,
    /// Names the job will have made (or moved away), by folder: path → what stands there now (None: gone).
    made: HashMap<String, Option<Have>>,
    /// The names folders had, by folder path.
    names: HashMap<String, HashSet<String>>,
    steps: Vec<Step>,
    frames: usize,
    copy_bytes: u64,
    stop: bool,
}

/// Java's count(): files below (a link to a folder is one), and their bytes.
fn count(n: &Node) -> (u64, u64) {
    if n.kind == Kind::Dir {
        let mut t = (0, 0);
        if let Some(k) = &n.kids {
            for c in k {
                let x = count(c);
                t.0 += x.0;
                t.1 += x.1;
            }
        }
        t
    } else {
        (n.size, 1)
    }
}
/// Run.leave(): the files a move leaves where they were (at least one).
fn leave_of(n: &Node) -> u64 {
    count(n).1.max(1)
}

impl<'a> Planner<'a> {
    /// What stands at `p` now: what the job made, else what the snapshot saw.
    fn have(&self, p: &str, snap: Option<&Tgt>) -> Option<Have> {
        if let Some(h) = self.made.get(p) {
            return *h;
        }
        match snap {
            Some(t) if t.exists => Some(if t.dir { Have::Dir } else { Have::File }),
            _ => None,
        }
    }
    fn taken(&self, folder: &str, name: &str) -> bool {
        let p = join(folder, name);
        if let Some(h) = self.made.get(&p) {
            return h.is_some();
        }
        self.names.get(folder).map(|s| s.contains(name)).unwrap_or(false)
    }
    fn keep_both(&self, to: &str, dir: bool) -> String {
        let folder = parent_of(to);
        let n = keep_both_name(name_of(to), dir, &|c| self.taken(&folder, c));
        join(&folder, &n)
    }
    fn frame(&mut self) -> usize {
        self.frames += 1;
        self.frames
    }
    /// The standing answer, else the next answer the page gave, else None (to be asked).
    fn resolve(&mut self) -> Option<String> {
        if self.standing != "ask" {
            return Some(self.standing.clone());
        }
        if self.next_answer >= self.answers.len() {
            return None;
        }
        let a = self.answers[self.next_answer].clone();
        self.next_answer += 1;
        if let Some(s) = a.strip_suffix("All") {
            self.standing = s.to_string();
        }
        Some(a.replace("All", ""))
    }
    fn ask(&mut self, item: usize, from: &str, to: &str) {
        self.steps.push(Step::Ask { item, from: from.to_string(), to: to.to_string() });
        self.stop = true;
    }
    fn note_names(&mut self, path: &str, t: &Tgt) {
        if t.exists && t.dir && !self.names.contains_key(path) {
            self.names.insert(path.to_string(), t.names.iter().cloned().collect());
        }
    }

    /// KtFileJobs.transfer for `n` at `from` into `to`; `natural`: `to` is the node's natural place (its snapshot
    /// stat applies). Returns nothing: the executor follows each frame's outcome.
    fn transfer(&mut self, item: usize, frame: usize, n: &Node, from: &str, to: &str, natural: bool) {
        if self.stop {
            return;
        }
        let snap = if natural { Some(&n.tgt) } else { None };
        let mut to = to.to_string();
        if self.mv && self.s.items[item].same_vol && self.have(&to, snap).is_none() && !self.rename_failed.contains(from) {
            let (bytes, files) = count(n);
            self.steps.push(Step::Rename { item, frame, from: from.to_string(), to: to.clone(), files, bytes });
            self.made.insert(to, Some(if n.kind == Kind::File { Have::File } else { Have::Dir }));
            return;
        }
        if n.kind == Kind::LinkDir {
            self.steps.push(Step::Fail { item, frame, from: from.to_string(), why: "a link to a folder, left as it is".into(), files: leave_of(n) });
            return;
        }
        if n.kind == Kind::Dir {
            let mut into = to.clone();
            let mut swap = false;
            let mut fresh = !natural;
            let h = self.have(&to, snap);
            if h == Some(Have::File) {
                let a = match self.resolve() {
                    Some(a) => a,
                    None => return self.ask(item, from, &to),
                };
                if a == "skip" {
                    self.steps.push(Step::Skip { item, frame, from: from.to_string(), size: 0, files: leave_of(n), dir: true });
                    return;
                }
                if a == "keep" {
                    to = self.keep_both(&to, true);
                    into = to.clone();
                } else {
                    into = self.keep_both(&join(&parent_of(&to), &format!("{}.ktpart", name_of(&to))), true);
                    swap = true;
                }
                fresh = true;
            }
            let into_have = if into == to { self.have(&into, snap) } else { self.have(&into, None) };
            let mkdir = into_have != Some(Have::Dir);
            let f = self.frame();
            self.steps.push(Step::Dir { item, frame: f, parent: frame, from: from.to_string(), into: into.clone(), mkdir, files: leave_of(n) });
            if mkdir {
                self.made.insert(into.clone(), Some(Have::Dir));
            } else if natural && !fresh {
                self.note_names(&into, &n.tgt);
            }
            let kids = match &n.kids {
                Some(k) => k,
                None => {
                    self.steps.push(Step::Fail { item, frame, from: from.to_string(), why: "cannot read".into(), files: leave_of(n) });
                    return;
                }
            };
            for c in kids {
                if self.stop {
                    return;
                }
                let cf = join(from, &c.name);
                let ct = join(&into, &c.name);
                // (A child's snapshot stat is its natural place's only when its folder is the natural one, already there.)
                let nat = natural && !fresh && !mkdir;
                self.transfer(item, f, c, &cf, &ct, nat);
            }
            if self.stop {
                return;
            }
            self.steps.push(Step::EndDir { item, frame: f, parent: frame, from: from.to_string(), to: to.clone(), into: into.clone(), swap, rmdir: self.mv });
            if swap {
                self.made.insert(into.clone(), None);
                self.made.insert(to.clone(), Some(Have::Dir));
            }
            return;
        }
        // a file
        if let Some(h) = self.have(&to, snap) {
            let same = snap.map(|t| t.same).unwrap_or(false);
            let a = if same {
                "keep".to_string()
            } else {
                match self.resolve() {
                    Some(a) => a,
                    None => return self.ask(item, from, &to),
                }
            };
            if a == "skip" {
                self.steps.push(Step::Skip { item, frame, from: from.to_string(), size: n.size, files: 1, dir: false });
                return;
            }
            if a == "keep" {
                to = self.keep_both(&to, false);
            } else if h == Have::Dir {
                self.steps.push(Step::Fail { item, frame, from: from.to_string(), why: format!("cannot replace the folder {}", name_of(&to)), files: 1 });
                return;
            } else {
                self.copy_bytes += n.size;
                self.steps.push(Step::Copy { item, frame, from: from.to_string(), to: to.clone(), size: n.size, replace: true, mv: self.mv });
                self.made.insert(to, Some(Have::File));
                return;
            }
        }
        self.copy_bytes += n.size;
        self.steps.push(Step::Copy { item, frame, from: from.to_string(), to: to.clone(), size: n.size, replace: false, mv: self.mv });
        self.made.insert(to, Some(Have::File));
    }

    fn delete(&mut self, item: usize, n: &Node, path: &str) {
        if n.kind == Kind::Dir {
            if let Some(k) = &n.kids {
                for c in k {
                    self.delete(item, c, &join(path, &c.name));
                }
            }
        }
        self.steps.push(Step::Del { item, path: path.to_string(), size: if n.is_file { n.size } else { 0 } });
    }
}

/// Java's walkSize on a top-level path (its entries listed even through a link; a file lists nothing).
fn walk_size(n: &Node, t: &mut (u64, u64, u64)) {
    if let Some(k) = &n.kids {
        for c in k {
            if c.kind == Kind::Dir {
                t.2 += 1;
                walk_size(c, t);
            } else {
                t.1 += 1;
                t.0 += c.size;
            }
        }
    }
}

/// The plan of a job: `answers` — the page's answers so far, in the order asked («skip», «replaceAll»…);
/// `rename_failed` — the sources whose rename (a move on one storage) failed when tried, now to be copied.
pub fn plan(s: &Snapshot, answers: &[String], rename_failed: &HashSet<String>) -> Plan {
    let mv = s.op == "move";
    let mut p = Planner { s, mv, standing: s.conflict.clone(), answers, next_answer: 0, rename_failed, made: HashMap::new(), names: HashMap::new(), steps: Vec::new(), frames: 0, copy_bytes: 0, stop: false };
    p.names.insert(s.dest.clone(), s.dest_names.iter().cloned().collect());
    let mut out = Plan::default();
    if s.op == "delete" {
        for it in &s.items {
            let mut t = (0, 0, 0);
            walk_size(&it.node, &mut t);
            out.total_bytes += t.0;
            out.total_files += t.1 + t.2 + 1;
        }
    } else {
        for it in &s.items {
            let (b, f) = count(&it.node);
            out.total_bytes += b;
            out.total_files += f;
        }
    }
    for (i, it) in s.items.iter().enumerate() {
        if p.stop {
            break;
        }
        if s.op == "delete" {
            // (A path already gone: Java's delete of it is a no-op, counted.)
            p.delete(i, &it.node, &it.path);
            p.steps.push(Step::End { item: i, remaining: false });
            continue;
        }
        let root = p.frame();
        if !it.exists {
            p.steps.push(Step::Fail { item: i, frame: root, from: it.path.clone(), why: "not found".into(), files: 0 });
            p.steps.push(Step::End { item: i, remaining: false });
            continue;
        }
        let name = name_of(&it.path).to_string();
        let mut to = join(&s.dest, &name);
        if it.node.kind != Kind::File && it.into_itself {
            p.steps.push(Step::Fail { item: i, frame: root, from: it.path.clone(), why: "into itself".into(), files: leave_of(&it.node) });
            p.steps.push(Step::End { item: i, remaining: true });
            continue;
        }
        let mut natural = true;
        if it.node.tgt.same {
            if mv {
                p.steps.push(Step::End { item: i, remaining: false });
                continue;
            }
            to = p.keep_both(&to, it.node.kind != Kind::File);
            natural = false;
        }
        p.transfer(i, root, &it.node, &it.path, &to, natural);
        if !p.stop {
            p.steps.push(Step::End { item: i, remaining: true });
        }
    }
    out.asks = p.stop;
    out.copy_bytes = p.copy_bytes;
    out.steps = p.steps;
    out
}

/// Data safety (the Rust engine): the items whose destructive steps in `rust` are not all, exactly, in `java`'s plan
/// for that item — those items are skipped and reported, never run.
pub fn disputed(rust: &[Step], java: &[Step]) -> Vec<usize> {
    let mut by: HashMap<usize, HashSet<String>> = HashMap::new();
    for s in java {
        by.entry(s.item()).or_default().insert(s.to_json());
    }
    let mut out: Vec<usize> = Vec::new();
    for s in rust {
        if s.destructive() && !by.get(&s.item()).map(|x| x.contains(&s.to_json())).unwrap_or(false) && !out.contains(&s.item()) {
            out.push(s.item());
        }
    }
    out
}

/* ---------- a rename (KtFileJobs.rename's checks) ---------- */

/// None: the name may be tried; Some(«bad name»).
pub fn rename_bad(name: &str) -> Option<&'static str> {
    if name.is_empty() || name.contains('/') || name.contains('\u{0}') || name == "." || name == ".." {
        Some("bad name")
    } else {
        None
    }
}

/// What a rename of `old` to `new` does, given whether a file stands at `new` (`taken`) and whether it is the same file
/// (`same`, a volume that ignores case): «nothing», «exists» (refused), «via» (by a passing name), «direct».
pub fn rename_way(old: &str, new: &str, taken: bool, same: bool) -> &'static str {
    if old == new {
        "nothing"
    } else if taken && !same {
        "exists"
    } else if same {
        "via"
    } else {
        "direct"
    }
}

/* ---------- the bin (KtFiles.trash / trashList / trashRestore / trashEmpty) ---------- */

/// java.lang.String.hashCode over UTF-16.
pub fn java_hash(s: &str) -> i32 {
    let mut h: i32 = 0;
    for u in s.encode_utf16() {
        h = h.wrapping_mul(31).wrapping_add(u as i32);
    }
    h
}

/// A slot's folder name: «millis-hex(hashCode of the path)» (Integer.toHexString: the two's complement, no sign).
pub fn trash_slot(now_ms: i64, path: &str) -> String {
    format!("{}-{:x}", now_ms, java_hash(path) as u32)
}

/// Whether trashEmpty(olderThan) drops a slot noted at `at` (olderThan ≤ 0: every slot).
pub fn trash_expired(now_ms: i64, at_ms: i64, older_than_ms: i64) -> bool {
    older_than_ms <= 0 || now_ms - at_ms > older_than_ms
}

/// The bin for `path`: under the longest root (not the app's own) that holds it; None: the phone's main storage.
pub fn trash_root(path: &str, roots: &[(String, String)]) -> Option<String> {
    let mut best: Option<&String> = None;
    for (rp, kind) in roots {
        if kind == "app" {
            continue;
        }
        if path == rp || path.starts_with(&format!("{}/", rp)) {
            if best.map(|b| rp.len() > b.len()).unwrap_or(true) {
                best = Some(rp);
            }
        }
    }
    best.cloned()
}

/* ---------- archives (KtArchive) ---------- */

/// KtArchive.unsafe: an entry name that would write outside the folder.
pub fn archive_unsafe(name: &str) -> bool {
    let c: Vec<char> = name.chars().collect();
    name.starts_with('/') || name.contains("../") || name == ".." || (name.contains(':') && name.find(':').map(|i| name[..i].encode_utf16().count() < 3).unwrap_or(false) && c.len() > 1 && c[0].is_alphabetic() && c[1] == ':')
}

/// KtArchive.wanted: `only` None — every entry; else the entry named, or below a folder named «x/».
pub fn archive_wanted(only: Option<&[String]>, name: &str) -> bool {
    let only = match only {
        None => return true,
        Some(o) => o,
    };
    let n = name.replace('\\', "/");
    only.iter().any(|w| n == *w || (w.ends_with('/') && n.starts_with(w.as_str())))
}

/// KtArchive.target's «keep both» (not KtFileJobs's: the last dot of any length, the extension's case kept):
/// «base (i).ext» from 2 on, the first `taken` does not hold.
pub fn archive_both_name(name: &str, taken: &dyn Fn(&str) -> bool) -> String {
    let u: Vec<u16> = name.encode_utf16().collect();
    let (base, ext) = match u.iter().rposition(|&c| c == b'.' as u16) {
        Some(d) if d > 0 => (String::from_utf16_lossy(&u[..d]), String::from_utf16_lossy(&u[d..])),
        _ => (name.to_string(), String::new()),
    };
    let mut i: u64 = 2;
    loop {
        let c = format!("{} ({}){}", base, i, ext);
        if !taken(&c) {
            return c;
        }
        i += 1;
    }
}

/* ---------- the vault (KtVault) ---------- */

/// KtVault.collect: a file is taken for a lock when it is not locked yet, for an unlock when it is.
pub fn vault_takes(lock: bool, name: &str, is_file: bool) -> bool {
    is_file && lock != name.ends_with(".kurokawa")
}

/// KtVault.open's check of the name read back: 1…1024 bytes, no «/», no NUL — else the password was wrong.
pub fn vault_name_ok(len: usize, name: &str) -> bool {
    (1..=1024).contains(&len) && !name.contains('/') && !name.contains('\u{0}')
}

/// A locked file's name from its six random bytes: 12 hex digits and «.kurokawa».
pub fn vault_locked_name(rnd: &[u8]) -> String {
    let mut s: String = rnd.iter().map(|b| format!("{:02x}", b)).collect();
    s.push_str(".kurokawa");
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, size: u64) -> Node {
        Node { name: name.into(), kind: Kind::File, size, is_file: true, kids: None, tgt: Tgt::default() }
    }
    fn dir(name: &str, kids: Vec<Node>) -> Node {
        Node { name: name.into(), kind: Kind::Dir, size: 4096, is_file: false, kids: Some(kids), tgt: Tgt::default() }
    }
    fn at(mut n: Node, t: Tgt) -> Node {
        n.tgt = t;
        n
    }
    fn file_there() -> Tgt {
        Tgt { exists: true, file: true, ..Tgt::default() }
    }
    fn dir_there(names: &[&str]) -> Tgt {
        Tgt { exists: true, dir: true, names: names.iter().map(|s| s.to_string()).collect(), ..Tgt::default() }
    }
    fn item(path: &str, node: Node) -> Item {
        Item { path: path.into(), exists: true, into_itself: false, same_vol: false, node }
    }
    fn snap(op: &str, conflict: &str, dest_names: &[&str], items: Vec<Item>) -> Snapshot {
        Snapshot { op: op.into(), conflict: conflict.into(), dest: "/d".into(), dest_names: dest_names.iter().map(|s| s.to_string()).collect(), items }
    }
    fn js(p: &Plan) -> Vec<String> {
        p.steps.iter().map(|s| s.to_json()).collect()
    }
    fn none() -> HashSet<String> {
        HashSet::new()
    }

    #[test]
    fn names() {
        assert_eq!(ext_of("a.TXT"), "txt");
        assert_eq!(ext_of(".bashrc"), "");
        assert_eq!(ext_of("a."), "");
        assert_eq!(ext_of("a.verylongext"), "");
        assert_eq!(ext_of("a.1234567"), "1234567");
        let none = |_: &str| false;
        assert_eq!(keep_both_name("a.txt", false, &none), "a (2).txt");
        assert_eq!(keep_both_name("my.folder", true, &none), "my.folder (2)");
        assert_eq!(keep_both_name("a.TXT", false, &none), "a (2).TXT");
        assert_eq!(keep_both_name("noext", false, &|c| c == "noext (2)"), "noext (3)");
        assert_eq!(keep_both_name("صورة.jpg", false, &none), "صورة (2).jpg");
        assert_eq!(keep_both_name("😀.png", false, &none), "😀 (2).png");
        assert_eq!(keep_both_name("x.😀", false, &none), "x (2).😀");
        assert_eq!(keep_both_name("trail. ", false, &none), "trail (2). ");
        assert_eq!(keep_both_name("a", false, &|_| true), "a");
        assert_eq!(join("/", "x"), "/x");
        assert_eq!(join("/a", "x"), "/a/x");
    }

    #[test]
    fn copy_and_conflicts() {
        // a plain copy
        let s = snap("copy", "ask", &[], vec![item("/s/a.txt", file("a.txt", 3))]);
        let p = plan(&s, &[], &none());
        assert_eq!(js(&p), vec![r#"["copy",0,1,"/s/a.txt","/d/a.txt",3,false,false]"#, r#"["end",0,true]"#]);
        assert_eq!((p.total_bytes, p.total_files, p.asks, p.copy_bytes), (3, 1, false, 3));
        // a name taken: asked, then each answer
        let s = snap("move", "ask", &["a.txt"], vec![item("/s/a.txt", at(file("a.txt", 3), file_there()))]);
        let p = plan(&s, &[], &none());
        assert_eq!(js(&p), vec![r#"["ask",0,"/s/a.txt","/d/a.txt"]"#]);
        assert!(p.asks);
        let p = plan(&s, &["skip".into()], &none());
        assert_eq!(js(&p), vec![r#"["skip",0,1,"/s/a.txt",3,1,false]"#, r#"["end",0,true]"#]);
        let p = plan(&s, &["replace".into()], &none());
        assert_eq!(js(&p)[0], r#"["copy",0,1,"/s/a.txt","/d/a.txt",3,true,true]"#);
        let p = plan(&s, &["keep".into()], &none());
        assert_eq!(js(&p)[0], r#"["copy",0,1,"/s/a.txt","/d/a (2).txt",3,false,true]"#);
        // «…All»: the standing answer for what follows; an unknown answer is Java's replace
        let s2 = snap("copy", "ask", &["a.txt", "b.txt"], vec![item("/s/a.txt", at(file("a.txt", 1), file_there())), item("/s/b.txt", at(file("b.txt", 1), file_there()))]);
        let p = plan(&s2, &["keepAll".into()], &none());
        assert_eq!(js(&p)[2], r#"["copy",1,2,"/s/b.txt","/d/b (2).txt",1,false,false]"#);
        let p = plan(&s2, &["whatever".into()], &none());
        assert!(p.asks && js(&p)[0].contains("true,false"));
        // a file onto a folder, replaced: refused
        let s = snap("copy", "replace", &["a"], vec![item("/s/a", at(file("a", 1), dir_there(&[])))]);
        assert_eq!(js(&plan(&s, &[], &none()))[0], r#"["fail",0,1,"/s/a","cannot replace the folder a",1]"#);
    }

    #[test]
    fn same_place_and_into_itself() {
        let mut it = item("/d/a.txt", at(file("a.txt", 2), Tgt { exists: true, file: true, same: true, ..Tgt::default() }));
        let s = snap("move", "replace", &["a.txt"], vec![it.clone()]);
        assert_eq!(js(&plan(&s, &[], &none())), vec![r#"["end",0,false]"#]);
        let s = snap("copy", "replace", &["a.txt"], vec![it.clone()]);
        assert_eq!(js(&plan(&s, &[], &none()))[0], r#"["copy",0,1,"/d/a.txt","/d/a (2).txt",2,false,false]"#);
        it.node = dir("D", vec![file("x", 1)]);
        it.path = "/s/D".into();
        it.into_itself = true;
        let s = snap("move", "replace", &[], vec![it]);
        assert_eq!(js(&plan(&s, &[], &none())), vec![r#"["fail",0,1,"/s/D","into itself",1]"#, r#"["end",0,true]"#]);
    }

    #[test]
    fn folders_merge_swap_and_links() {
        // merge into an existing folder, one file skipped (standing «skip»)
        let d = at(dir("D", vec![file("x.txt", 1), at(dir("sub", vec![at(file("y.txt", 5), file_there()), file("z.txt", 1)]), dir_there(&["y.txt"]))]), dir_there(&["sub"]));
        let s = snap("move", "skip", &["D"], vec![item("/s/D", d)]);
        let p = plan(&s, &[], &none());
        assert_eq!(
            js(&p),
            vec![
                r#"["dir",0,2,1,"/s/D","/d/D",false,3]"#,
                r#"["copy",0,2,"/s/D/x.txt","/d/D/x.txt",1,false,true]"#,
                r#"["dir",0,3,2,"/s/D/sub","/d/D/sub",false,2]"#,
                r#"["skip",0,3,"/s/D/sub/y.txt",5,1,false]"#,
                r#"["copy",0,3,"/s/D/sub/z.txt","/d/D/sub/z.txt",1,false,true]"#,
                r#"["endDir",0,3,2,"/s/D/sub","/d/D/sub","/d/D/sub",false,true]"#,
                r#"["endDir",0,2,1,"/s/D","/d/D","/d/D",false,true]"#,
                r#"["end",0,true]"#,
            ]
        );
        // a folder onto a file, replaced: built as «D.ktpart (2)», swapped in at the end
        let s = snap("copy", "replace", &["D"], vec![item("/s/D", at(dir("D", vec![file("x", 1)]), file_there()))]);
        let p = plan(&s, &[], &none());
        assert_eq!(js(&p)[0], r#"["dir",0,2,1,"/s/D","/d/D.ktpart (2)",true,1]"#);
        assert_eq!(js(&p)[1], r#"["copy",0,2,"/s/D/x","/d/D.ktpart (2)/x",1,false,false]"#);
        assert_eq!(js(&p)[2], r#"["endDir",0,2,1,"/s/D","/d/D","/d/D.ktpart (2)",true,false]"#);
        // a link to a folder inside: refused, left
        let mut l = file("loop", 4096);
        l.kind = Kind::LinkDir;
        l.is_file = false;
        let s = snap("copy", "replace", &[], vec![item("/s/D", dir("D", vec![file("x", 1), l]))]);
        assert_eq!(js(&plan(&s, &[], &none()))[2], r#"["fail",0,2,"/s/D/loop","a link to a folder, left as it is",1]"#);
        // an unreadable folder
        let mut u = dir("U", vec![]);
        u.kids = None;
        let s = snap("copy", "replace", &[], vec![item("/s/U", u)]);
        assert_eq!(js(&plan(&s, &[], &none())), vec![r#"["dir",0,2,1,"/s/U","/d/U",true,1]"#, r#"["fail",0,1,"/s/U","cannot read",1]"#, r#"["end",0,true]"#]);
    }

    #[test]
    fn moves_rename_then_copy_when_rename_fails() {
        let mut it = item("/s/D", dir("D", vec![file("x", 2), file("y", 3)]));
        it.same_vol = true;
        let s = snap("move", "ask", &[], vec![it]);
        assert_eq!(js(&plan(&s, &[], &none()))[0], r#"["rename",0,1,"/s/D","/d/D",2,5]"#);
        let mut rf = HashSet::new();
        rf.insert("/s/D".to_string());
        let p = plan(&s, &[], &rf);
        // (its children are renamed one by one — Java tries each, as its transfer() does)
        assert_eq!(js(&p)[0], r#"["dir",0,2,1,"/s/D","/d/D",true,2]"#);
        assert_eq!(js(&p)[1], r#"["rename",0,2,"/s/D/x","/d/D/x",1,2]"#);
        rf.insert("/s/D/x".to_string());
        assert_eq!(js(&plan(&s, &[], &rf))[1], r#"["copy",0,2,"/s/D/x","/d/D/x",2,false,true]"#);
    }

    #[test]
    fn names_made_by_the_job_count() {
        // two items of one name from two folders, keep both: «a (2)», then «a (3)»
        let s = snap("copy", "keep", &["a"], vec![item("/s/a", at(file("a", 1), file_there())), item("/t/a", at(file("a", 1), file_there()))]);
        let p = plan(&s, &[], &none());
        assert_eq!(js(&p)[0], r#"["copy",0,1,"/s/a","/d/a (2)",1,false,false]"#);
        assert_eq!(js(&p)[2], r#"["copy",1,2,"/t/a","/d/a (3)",1,false,false]"#);
        // the second item meets the file the first made: asked
        let s = snap("copy", "ask", &[], vec![item("/s/a", file("a", 1)), item("/t/a", file("a", 1))]);
        let p = plan(&s, &[], &none());
        assert_eq!(js(&p)[2], r#"["ask",1,"/t/a","/d/a"]"#);
    }

    #[test]
    fn delete_and_totals() {
        let mut l = file("out", 4096);
        l.kind = Kind::LinkDir;
        l.is_file = false;
        let s = snap("delete", "ask", &[], vec![item("/s/D", dir("D", vec![file("x", 2), dir("e", vec![]), l])), item("/s/f", file("f", 9))]);
        let p = plan(&s, &[], &none());
        assert_eq!(js(&p), vec![r#"["del",0,"/s/D/x",2]"#, r#"["del",0,"/s/D/e",0]"#, r#"["del",0,"/s/D/out",0]"#, r#"["del",0,"/s/D",0]"#, r#"["end",0,false]"#, r#"["del",1,"/s/f",9]"#, r#"["end",1,false]"#]);
        // (Java's walkSize: a top-level file lists nothing — 0 bytes —, each path +1)
        assert_eq!((p.total_bytes, p.total_files), (4098, (2 + 1 + 1) + 1));
    }

    #[test]
    fn disputes() {
        let a = vec![Step::Copy { item: 0, frame: 1, from: "a".into(), to: "b".into(), size: 1, replace: true, mv: false }, Step::End { item: 0, remaining: true }];
        let mut b = a.clone();
        assert!(disputed(&a, &b).is_empty());
        b[0] = Step::Copy { item: 0, frame: 1, from: "a".into(), to: "c".into(), size: 1, replace: true, mv: false };
        assert_eq!(disputed(&a, &b), vec![0]);
        // a non-destructive difference passes
        let c = vec![Step::Copy { item: 0, frame: 1, from: "a".into(), to: "b".into(), size: 1, replace: false, mv: false }];
        assert!(disputed(&c, &[]).is_empty());
    }

    #[test]
    fn small_rules() {
        assert_eq!(rename_bad(""), Some("bad name"));
        assert_eq!(rename_bad("a/b"), Some("bad name"));
        assert_eq!(rename_bad(".."), Some("bad name"));
        assert_eq!(rename_bad("ok …. "), None);
        assert_eq!(rename_way("a", "a", true, true), "nothing");
        assert_eq!(rename_way("A", "a", true, true), "via");
        assert_eq!(rename_way("A", "a", true, false), "exists");
        assert_eq!(rename_way("A", "b", false, false), "direct");
        assert_eq!(java_hash("/storage/emulated/0/a.txt"), {
            let mut h: i32 = 0;
            for c in "/storage/emulated/0/a.txt".chars() {
                h = h.wrapping_mul(31).wrapping_add(c as i32);
            }
            h
        });
        assert_eq!(java_hash(""), 0);
        assert_eq!(java_hash("a"), 97);
        assert_eq!(trash_slot(1700000000000, "a"), "1700000000000-61");
        assert_eq!(trash_slot(1, "\u{ffff}\u{ffff}\u{ffff}"), format!("1-{:x}", java_hash("\u{ffff}\u{ffff}\u{ffff}") as u32));
        assert!(trash_expired(100, 0, 0));
        assert!(trash_expired(100, 0, 99));
        assert!(!trash_expired(100, 0, 100));
        let roots = vec![("/storage/emulated/0".to_string(), "phone".to_string()), ("/storage/emulated/0/Android/data/x".to_string(), "app".to_string()), ("/storage/AB12".to_string(), "sd".to_string())];
        assert_eq!(trash_root("/storage/emulated/0/Android/data/x/f", &roots).as_deref(), Some("/storage/emulated/0"));
        assert_eq!(trash_root("/storage/AB12/m.mp4", &roots).as_deref(), Some("/storage/AB12"));
        assert_eq!(trash_root("/storage/AB123/m.mp4", &roots), None);
        assert!(archive_unsafe("/etc/x") && archive_unsafe("a/../b") && archive_unsafe("..") && archive_unsafe("C:x"));
        assert!(!archive_unsafe("a..b/c") && !archive_unsafe("ab:c") && !archive_unsafe("..."));
        let only = vec!["dir/".to_string(), "x.txt".to_string()];
        assert!(archive_wanted(None, "q") && archive_wanted(Some(&only), "dir\\a") && archive_wanted(Some(&only), "x.txt") && !archive_wanted(Some(&only), "dirx/a"));
        assert_eq!(archive_both_name("a.tar.gz", &|_| false), "a.tar (2).gz");
        assert_eq!(archive_both_name(".hidden", &|_| false), ".hidden (2)");
        assert_eq!(archive_both_name("a.VeryLongExt", &|c| c.contains("(2)")), "a (3).VeryLongExt");
        assert!(vault_takes(true, "a.txt", true) && !vault_takes(true, "a.kurokawa", true) && vault_takes(false, "a.kurokawa", true) && !vault_takes(false, "a.kurokawa", false));
        assert!(vault_name_ok(3, "abc") && !vault_name_ok(0, "") && !vault_name_ok(1025, "x") && !vault_name_ok(3, "a/b"));
        assert_eq!(vault_locked_name(&[0, 1, 0xab, 0xff, 2, 3]), "0001abff0203.kurokawa");
    }
}
