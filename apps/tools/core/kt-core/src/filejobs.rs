// The Files page's jobs — copy, move, delete — and rename, in plain std: the port of the Android app's
// native/android/KtFileJobs.java, rule for rule, with the same events, so the page (src/views/files.ts) reads a
// computer's jobs exactly as a phone's. Std only, checked alone: `rustc --edition 2021 --test filejobs.rs` (the tests
// are tests/native/FilesT.java's, on temp folders, with a second volume where /dev/shm is one).
//
// The rule of a move: a source item is removed only when that item itself was copied whole (its size checked) to a
// place that is not itself; a folder only when all inside it moved and it is empty; whatever was skipped, failed or
// cancelled stays where it was, and the end event says how many files were left and which of the chosen paths are
// still there. A name taken and replaced: the new copy is written beside it first («name.ktpart»), and the old one goes
// only once it is complete. A folder is never copied into itself (whatever the spelling: a trailing separator, a link,
// another letter case where the disk ignores it). A link to a folder is neither followed (no loops) nor deleted
// through.
//
// Events (one JSON object each, Event::to_json — the shell sends them to the page as «kt:files»):
//   { id, status: 'progress', done, total, files, ofFiles, name }               at most every 200 ms, and after each file
//   { id, status: 'conflict', from, to, size, existingSize, mtime, existingMtime, dir }   then the job waits for answer()
//   { id, status: 'done' | 'cancelled', done, total, files, failed: [«name: why»], skipped, left?, remaining? }
//   { id, status: 'failed', message }
use std::collections::HashMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/* ---------- the events ---------- */

/// One event of a job (the fields its status uses; the rest stay None and are not written).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Event {
    pub id: String,
    pub status: &'static str,
    pub done: Option<u64>,
    pub total: Option<u64>,
    pub files: Option<u64>,
    pub of_files: Option<u64>,
    pub name: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub size: Option<u64>,
    pub existing_size: Option<u64>,
    pub mtime: Option<u64>,
    pub existing_mtime: Option<u64>,
    pub dir: Option<bool>,
    pub failed: Option<Vec<String>>,
    pub skipped: Option<u64>,
    pub left: Option<u64>,
    pub remaining: Option<Vec<String>>,
    pub message: Option<String>,
}

/// A string as JSON writes it.
pub fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 || c == '\u{2028}' || c == '\u{2029}' => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

impl Event {
    fn new(id: &str, status: &'static str) -> Event {
        Event { id: id.to_string(), status, ..Event::default() }
    }

    /// The event as the page reads it (the Android plugin's keys: ofFiles, existingSize, existingMtime).
    pub fn to_json(&self) -> String {
        let mut parts: Vec<String> = vec![format!("\"id\":{}", json_str(&self.id)), format!("\"status\":{}", json_str(self.status))];
        let mut num = |k: &str, v: Option<u64>| {
            if let Some(n) = v {
                parts.push(format!("\"{}\":{}", k, n));
            }
        };
        num("done", self.done);
        num("total", self.total);
        num("files", self.files);
        num("ofFiles", self.of_files);
        num("size", self.size);
        num("existingSize", self.existing_size);
        num("mtime", self.mtime);
        num("existingMtime", self.existing_mtime);
        num("skipped", self.skipped);
        num("left", self.left);
        let text = |k: &str, v: &Option<String>, parts: &mut Vec<String>| {
            if let Some(s) = v {
                parts.push(format!("\"{}\":{}", k, json_str(s)));
            }
        };
        text("name", &self.name, &mut parts);
        text("from", &self.from, &mut parts);
        text("to", &self.to, &mut parts);
        text("message", &self.message, &mut parts);
        if let Some(d) = self.dir {
            parts.push(format!("\"dir\":{}", d));
        }
        let list = |k: &str, v: &Option<Vec<String>>, parts: &mut Vec<String>| {
            if let Some(l) = v {
                let items: Vec<String> = l.iter().map(|s| json_str(s)).collect();
                parts.push(format!("\"{}\":[{}]", k, items.join(",")));
            }
        };
        list("failed", &self.failed, &mut parts);
        list("remaining", &self.remaining, &mut parts);
        format!("{{{}}}", parts.join(","))
    }
}

/* ---------- the jobs under way: cancel and the page's answers ---------- */

struct Ask {
    /// The standing answer: ask, skip, replace, keep.
    standing: String,
    /// The page's answer to the question asked last (None while it is awaited).
    answer: Option<String>,
}

/// A job under way.
pub struct Job {
    pub id: String,
    cancel: AtomicBool,
    ask: Mutex<Ask>,
    cv: Condvar,
    pace_ms: u64,
}

impl Job {
    fn new(id: &str, conflict: &str) -> Job {
        let standing = match conflict {
            "skip" | "replace" | "keep" => conflict.to_string(),
            _ => "ask".to_string(),
        };
        Job { id: id.to_string(), cancel: AtomicBool::new(false), ask: Mutex::new(Ask { standing, answer: None }), cv: Condvar::new(), pace_ms: 0 }
    }
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
    fn standing(&self) -> String {
        match self.ask.lock() {
            Ok(g) => g.standing.clone(),
            Err(p) => p.into_inner().standing.clone(),
        }
    }
}

fn registry() -> &'static Mutex<HashMap<String, Arc<Job>>> {
    static R: OnceLock<Mutex<HashMap<String, Arc<Job>>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

fn job_of(id: &str) -> Option<Arc<Job>> {
    match registry().lock() {
        Ok(m) => m.get(id).cloned(),
        Err(p) => p.into_inner().get(id).cloned(),
    }
}

/// Whether a job of that id is under way.
pub fn running(id: &str) -> bool {
    job_of(id).is_some()
}

/// The job stopped: what is under way is left as the rules say, and a question waiting is answered «skip».
pub fn cancel(id: &str) {
    if let Some(j) = job_of(id) {
        j.cancel.store(true, Ordering::SeqCst);
        if let Ok(mut g) = j.ask.lock() {
            g.answer = Some("skip".to_string());
        }
        j.cv.notify_all();
    }
}

/// The page's answer to a name already taken: skip, replace, keep (both), or the same for all that follow (…All).
pub fn answer(id: &str, what: &str) {
    if let Some(j) = job_of(id) {
        if let Ok(mut g) = j.ask.lock() {
            if let Some(s) = what.strip_suffix("All") {
                g.standing = s.to_string();
            }
            g.answer = Some(what.replace("All", ""));
        }
        j.cv.notify_all();
    }
}

/* ---------- the file system's facts ---------- */

/// A symbolic link (not followed).
pub fn link(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

fn is_dir(p: &Path) -> bool {
    p.is_dir()
}

fn len_of(p: &Path) -> u64 {
    fs::metadata(p).map(|m| if m.is_file() { m.len() } else { 0 }).unwrap_or(0)
}

fn mtime_ms(p: &Path) -> u64 {
    fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Something is at `p` (a link counts, even a broken one).
fn there(p: &Path) -> bool {
    p.exists() || link(p)
}

/// The same file or folder, whatever the spelling: one inode (Unix), one canonical path, letter case aside (Windows,
/// whose disks ignore it).
pub fn same(a: &Path, b: &Path) -> bool {
    if !a.exists() || !b.exists() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(x), Ok(y)) = (fs::metadata(a), fs::metadata(b)) {
            return x.dev() == y.dev() && x.ino() == y.ino();
        }
        false
    }
    #[cfg(not(unix))]
    {
        match (fs::canonicalize(a), fs::canonicalize(b)) {
            (Ok(x), Ok(y)) => x.to_string_lossy().to_lowercase() == y.to_string_lossy().to_lowercase(),
            _ => false,
        }
    }
}

/// `dest` is `f` or lies below it: the canonical paths compared by whole parts, and each folder above `dest` asked
/// whether it is `f` (the same folder by another spelling: another letter case, a link).
pub fn inside(dest: &Path, f: &Path) -> bool {
    let fc = match fs::canonicalize(f) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let dc = match fs::canonicalize(dest) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let mut a: Option<&Path> = Some(dc.as_path());
    while let Some(x) = a {
        if x == fc.as_path() || same(x, f) {
            return true;
        }
        a = x.parent();
    }
    false
}

/// `a` and the folder `b` on one disk (a move there is a rename).
pub fn same_storage(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (fs::symlink_metadata(a), fs::metadata(b)) {
            (Ok(x), Ok(y)) => x.dev() == y.dev(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        // (The drive or share: the canonical path's first part.)
        let first = |p: &Path| -> Option<String> {
            let c = fs::canonicalize(p).ok()?;
            let s = c.components().next()?.as_os_str().to_string_lossy().to_lowercase();
            Some(s)
        };
        let pa = a.parent().unwrap_or(a);
        match (first(pa), first(b)) {
            (Some(x), Some(y)) => x == y,
            _ => false,
        }
    }
}

/// The extension of a name as the page counts one (at most 7 characters after the last dot, not a leading dot).
pub fn ext_of(name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    match name.rfind('.') {
        Some(i) if i > 0 && i < name.len() - 1 => {
            let tail = &name[i + 1..];
            let n = tail.chars().count();
            if n + 1 <= 8 && chars.len() > n {
                tail.to_lowercase()
            } else {
                String::new()
            }
        }
        _ => String::new(),
    }
}

/// A free name beside `to`: «name (2).ext» (the second of that name, as other file managers count) — a folder's whole
/// name numbered, its dots no extension.
pub fn keep_both(to: &Path, dir: bool) -> PathBuf {
    let n = to.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default();
    let parent = to.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let ext = if dir { String::new() } else { ext_of(&n) };
    let (stem, e) = if ext.is_empty() {
        (n.clone(), String::new())
    } else {
        let cut = n.len() - ext.len() - 1;
        (n[..cut].to_string(), n[cut..].to_string())
    };
    for i in 2..10000 {
        let c = parent.join(format!("{} ({}){}", stem, i, e));
        if !there(&c) {
            return c;
        }
    }
    to.to_path_buf()
}

fn name_of(p: &Path) -> String {
    p.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string_lossy().into_owned())
}

fn text_of(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// The files (and their bytes) under `f`: a folder walked (a link to one counted as one file, not followed).
fn count(f: &Path, t: &mut [u64; 2], cancel: Option<&Job>) {
    if cancel.map(|j| j.cancelled()).unwrap_or(false) {
        return;
    }
    if is_dir(f) && !link(f) {
        if let Ok(rd) = fs::read_dir(f) {
            for e in rd.flatten() {
                count(&e.path(), t, cancel);
            }
        }
    } else {
        t[0] += len_of(f);
        t[1] += 1;
    }
}

/// Bytes, files and folders inside `d` (for a delete's total).
fn walk_size(d: &Path, t: &mut [u64; 3], j: &Job) {
    let rd = match fs::read_dir(d) {
        Ok(r) => r,
        Err(_) => return,
    };
    for e in rd.flatten() {
        if j.cancelled() {
            return;
        }
        let c = e.path();
        if is_dir(&c) && !link(&c) {
            t[2] += 1;
            walk_size(&c, t, j);
        } else {
            t[1] += 1;
            t[0] += len_of(&c);
        }
    }
}

/* ---------- a job ---------- */

/// One job under way: where it stands, what failed, what was skipped and left behind.
struct Run<'a> {
    j: Arc<Job>,
    on: &'a dyn Fn(&Event),
    mv: bool,
    same_vol: bool,
    done: [u64; 2],
    total: [u64; 2],
    told: Option<Instant>,
    failed: Vec<String>,
    skipped: u64,
    left: u64,
}

impl<'a> Run<'a> {
    fn fail(&mut self, f: &Path, why: &str) {
        self.failed.push(format!("{}: {}", name_of(f), why));
    }
    /// `f` stays where it was (a move): its files counted as left.
    fn leave(&mut self, f: &Path) {
        if self.mv {
            let mut t = [0u64; 2];
            count(f, &mut t, None);
            self.left += std::cmp::max(1, t[1]);
        }
    }
    fn progress(&mut self, name: &str, force: bool) {
        let now = Instant::now();
        if !force {
            if let Some(t) = self.told {
                if now.duration_since(t) < Duration::from_millis(200) {
                    return;
                }
            }
        }
        self.told = Some(now);
        let mut e = Event::new(&self.j.id, "progress");
        e.done = Some(self.done[0]);
        e.total = Some(self.total[0]);
        e.files = Some(self.done[1]);
        e.of_files = Some(self.total[1]);
        e.name = Some(name.to_string());
        (self.on)(&e);
    }
    /// What to do about `to` already there: the job's standing answer, else the page asked and waited for.
    fn resolve(&mut self, from: &Path, to: &Path) -> String {
        let standing = self.j.standing();
        if standing != "ask" {
            return standing;
        }
        if let Ok(mut g) = self.j.ask.lock() {
            g.answer = None;
        }
        let mut e = Event::new(&self.j.id, "conflict");
        e.from = Some(text_of(from));
        e.to = Some(text_of(to));
        e.size = Some(if from.is_file() { len_of(from) } else { 0 });
        e.existing_size = Some(if to.is_file() { len_of(to) } else { 0 });
        e.mtime = Some(mtime_ms(from));
        e.existing_mtime = Some(mtime_ms(to));
        e.dir = Some(is_dir(from));
        // (Sent with nothing held: the page may answer at once, from inside this call.)
        (self.on)(&e);
        let j = self.j.clone();
        let mut g = match j.ask.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        while g.answer.is_none() && !j.cancelled() {
            g = match j.cv.wait_timeout(g, Duration::from_secs(60)) {
                Ok((g, _)) => g,
                Err(p) => p.into_inner().0,
            };
        }
        g.answer.clone().unwrap_or_else(|| "skip".to_string())
    }
}

/// `op` (copy | move | delete) on `paths`, into the folder `dest` for copy and move; `conflict` the standing answer
/// to a name taken (ask, skip, replace, keep); every event to `on`, the last one the end. Runs on the calling thread
/// (the shell gives it one of its own) and returns that end.
pub fn run(id: &str, op: &str, paths: &[PathBuf], dest: Option<&Path>, conflict: &str, on: &dyn Fn(&Event)) -> Event {
    run_paced(id, op, paths, dest, conflict, 0, on)
}

/// run(), each piece of a file copied (256 KiB) followed by a pause of `pace_ms` — only for the shells' self-tests,
/// which must catch a copy mid-way to try Cancel; 0 is no pause.
pub fn run_paced(id: &str, op: &str, paths: &[PathBuf], dest: Option<&Path>, conflict: &str, pace_ms: u64, on: &dyn Fn(&Event)) -> Event {
    let mut j0 = Job::new(id, conflict);
    j0.pace_ms = pace_ms;
    let j = Arc::new(j0);
    if let Ok(mut m) = registry().lock() {
        m.insert(id.to_string(), j.clone());
    }
    let end = run_job(j.clone(), op, paths, dest, on);
    if let Ok(mut m) = registry().lock() {
        if m.get(id).map(|x| Arc::ptr_eq(x, &j)).unwrap_or(false) {
            m.remove(id);
        }
    }
    on(&end);
    end
}

fn run_job(j: Arc<Job>, op: &str, paths: &[PathBuf], dest: Option<&Path>, on: &dyn Fn(&Event)) -> Event {
    let id = j.id.clone();
    let delete = op == "delete";
    if !delete && op != "copy" && op != "move" {
        let mut e = Event::new(&id, "failed");
        e.message = Some(format!("unknown operation: {}", op));
        return e;
    }
    let dest: PathBuf = match (delete, dest) {
        (true, _) => PathBuf::new(),
        (false, Some(d)) if d.is_dir() => d.to_path_buf(),
        (false, _) => {
            let mut e = Event::new(&id, "failed");
            e.message = Some("the destination is not a folder".to_string());
            return e;
        }
    };
    let mut r = Run { j: j.clone(), on, mv: op == "move", same_vol: false, done: [0, 0], total: [0, 0], told: None, failed: Vec::new(), skipped: 0, left: 0 };
    if !delete {
        for f in paths {
            count(f, &mut r.total, Some(&j));
        }
    } else {
        for f in paths {
            let mut t = [0u64; 3];
            if is_dir(f) && !link(f) {
                walk_size(f, &mut t, &j);
            } else {
                t[0] += len_of(f);
            }
            r.total[0] += t[0];
            r.total[1] += t[1] + t[2] + 1;
        }
    }
    let mut remaining: Vec<String> = Vec::new();
    for f in paths {
        if j.cancelled() {
            if r.mv && there(f) {
                r.leave(f);
                remaining.push(text_of(f));
            }
            continue;
        }
        if delete {
            if let Err(e) = delete_tree(f, &mut r) {
                if !j.cancelled() {
                    r.fail(f, &e.to_string());
                }
            }
            continue;
        }
        if !there(f) {
            r.fail(f, "not found");
            continue;
        }
        let fname = match f.file_name() {
            Some(n) => n.to_os_string(),
            None => {
                r.fail(f, "not a file or folder");
                continue;
            }
        };
        let mut to = dest.join(&fname);
        // (A folder into itself or a folder below it: it would copy itself until the disk is full.)
        if is_dir(f) && !link(f) && inside(&dest, f) {
            r.fail(f, "into itself");
            r.leave(f);
            remaining.push(text_of(f));
            continue;
        }
        // (Pasted where it already is: a move has nothing to do; a copy makes a second one beside it — never «replace»
        // it with itself.)
        if same(f, &to) {
            if r.mv {
                continue;
            }
            to = keep_both(&to, is_dir(f));
        }
        r.same_vol = r.mv && same_storage(f, &dest);
        transfer(f, to, &mut r);
        if r.mv && there(f) {
            remaining.push(text_of(f));
        }
    }
    let mut end = Event::new(&id, if j.cancelled() { "cancelled" } else { "done" });
    end.done = Some(r.done[0]);
    end.total = Some(r.total[0]);
    end.files = Some(r.done[1]);
    end.failed = Some(r.failed.clone());
    end.skipped = Some(r.skipped);
    if r.mv {
        end.left = Some(r.left);
        end.remaining = Some(remaining);
    }
    end
}

/// `from` copied (moved, for a move) to `to`; true when all of it arrived whole — for a move, it is then gone from
/// where it was.
fn transfer(from: &Path, to: PathBuf, r: &mut Run) -> bool {
    let mut to = to;
    if r.j.cancelled() {
        r.leave(from);
        return false;
    }
    let is_link = link(from);
    // (A move on one disk: a rename, the whole of it at once — only when nothing is in the way.)
    if r.mv && r.same_vol && !there(&to) && fs::rename(from, &to).is_ok() {
        let mut t = [0u64; 2];
        count(&to, &mut t, None);
        r.done[0] += t[0];
        r.done[1] += t[1];
        r.progress(&name_of(&to), true);
        return true;
    }
    if is_dir(from) && is_link {
        r.fail(from, "a link to a folder, left as it is");
        r.leave(from);
        return false;
    }
    if is_dir(from) {
        let mut into = to.clone();
        let mut swap = false;
        if there(&to) && !is_dir(&to) {
            let a = r.resolve(from, &to);
            if r.j.cancelled() || a == "skip" {
                if !r.j.cancelled() {
                    r.skipped += 1;
                }
                r.leave(from);
                return false;
            }
            if a == "keep" {
                to = keep_both(&to, true);
                into = to.clone();
            } else {
                let parent = to.parent().map(|p| p.to_path_buf()).unwrap_or_default();
                into = keep_both(&parent.join(format!("{}.ktpart", name_of(&to))), true);
                swap = true;
            }
        }
        if !is_dir(&into) && fs::create_dir_all(&into).is_err() {
            r.fail(from, &format!("cannot make {}", name_of(&into)));
            r.leave(from);
            return false;
        }
        let kids: Vec<PathBuf> = match fs::read_dir(from) {
            Ok(rd) => rd.flatten().map(|e| e.path()).collect(),
            Err(_) => {
                r.fail(from, "cannot read");
                r.leave(from);
                return false;
            }
        };
        let mut all = true;
        for c in kids.iter() {
            if r.j.cancelled() {
                r.leave(c);
                all = false;
                continue;
            }
            let cto = into.join(c.file_name().unwrap_or_default());
            if !transfer(c, cto, r) {
                all = false;
            }
        }
        // (A folder replacing a file: built under another name, put in the file's place only once complete.)
        if swap && all && (fs::remove_file(&to).is_err() || fs::rename(&into, &to).is_err()) {
            r.fail(from, &format!("cannot replace {}", name_of(&to)));
            return false;
        }
        if !all || !r.mv {
            return all;
        }
        let empty = fs::read_dir(from).map(|mut rd| rd.next().is_none()).unwrap_or(false);
        if empty && fs::remove_dir(from).is_ok() {
            return true;
        }
        r.fail(from, "cannot remove the folder");
        return false;
    }
    if there(&to) {
        let a = if same(from, &to) { "keep".to_string() } else { r.resolve(from, &to) };
        if r.j.cancelled() {
            r.leave(from);
            return false;
        }
        if a == "skip" {
            r.skipped += 1;
            r.done[0] += len_of(from);
            r.done[1] += 1;
            r.leave(from);
            r.progress(&name_of(from), true);
            return false;
        }
        if a == "keep" {
            to = keep_both(&to, false);
        } else if is_dir(&to) {
            r.fail(from, &format!("cannot replace the folder {}", name_of(&to)));
            r.leave(from);
            return false;
        }
    }
    let parent = to.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let part = parent.join(format!("{}.ktpart", name_of(&to)));
    let size = len_of(from);
    let mut wrote: u64 = 0;
    let copied: io::Result<()> = (|| {
        let mut input = fs::File::open(from)?;
        let mut out = fs::File::create(&part)?;
        let mut b = vec![0u8; 1 << 18];
        loop {
            let n = input.read(&mut b)?;
            if n == 0 {
                break;
            }
            if r.j.cancelled() {
                break;
            }
            out.write_all(&b[..n])?;
            wrote += n as u64;
            r.done[0] += n as u64;
            r.progress(&name_of(from), false);
            if r.j.pace_ms > 0 {
                std::thread::sleep(Duration::from_millis(r.j.pace_ms));
            }
        }
        out.flush()?;
        Ok(())
    })();
    if let Err(e) = copied {
        let _ = fs::remove_file(&part);
        r.fail(from, &e.to_string());
        r.leave(from);
        return false;
    }
    if r.j.cancelled() {
        let _ = fs::remove_file(&part);
        r.leave(from);
        return false;
    }
    // (Whole, or not at all: a file that changed while it was read, or a short write, is not taken for a copy.)
    if wrote != size || len_of(&part) != size {
        let _ = fs::remove_file(&part);
        r.fail(from, "size changed while copying");
        r.leave(from);
        return false;
    }
    if !put_in_place(&part, &to) {
        let _ = fs::remove_file(&part);
        r.fail(from, &format!("cannot write {}", name_of(&to)));
        r.leave(from);
        return false;
    }
    keep_time(from, &to);
    r.done[1] += 1;
    r.progress(&name_of(from), true);
    if r.mv && fs::remove_file(from).is_err() {
        r.fail(from, "copied, but cannot remove the original");
        r.leave(from);
        return false;
    }
    true
}

/// The copy given the original's modification time (as Java's setLastModified; nothing if it cannot be).
fn keep_time(from: &Path, to: &Path) {
    if let Ok(t) = fs::metadata(from).and_then(|m| m.modified()) {
        if let Ok(f) = fs::OpenOptions::new().write(true).open(to) {
            let _ = f.set_modified(t);
        }
    }
}

/// The finished `part` named `to`; a file already there is set aside first and put back if the rename fails.
fn put_in_place(part: &Path, to: &Path) -> bool {
    if !there(to) {
        return fs::rename(part, to).is_ok();
    }
    let parent = to.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let old = keep_both(&parent.join(format!("{}.ktold", name_of(to))), false);
    if fs::rename(to, &old).is_err() {
        return false;
    }
    if fs::rename(part, to).is_err() {
        let _ = fs::rename(&old, to);
        return false;
    }
    let _ = fs::remove_file(&old);
    true
}

/// `f` and everything in it deleted (a link: the link only — never what it points at).
fn delete_tree(f: &Path, r: &mut Run) -> io::Result<()> {
    if r.j.cancelled() {
        return Ok(());
    }
    let is_link = link(f);
    if is_dir(f) && !is_link {
        let kids: Vec<PathBuf> = fs::read_dir(f)?.flatten().map(|e| e.path()).collect();
        for c in kids.iter() {
            delete_tree(c, r)?;
            if r.j.cancelled() {
                return Ok(());
            }
        }
    }
    let sz = if !is_link && f.is_file() { len_of(f) } else { 0 };
    let gone = if is_link {
        // (A link to a folder is a folder's entry on Windows, a file's on Unix.)
        fs::remove_file(f).or_else(|_| fs::remove_dir(f))
    } else if is_dir(f) {
        fs::remove_dir(f)
    } else {
        fs::remove_file(f)
    };
    if gone.is_err() && there(f) {
        return Err(io::Error::new(io::ErrorKind::Other, format!("cannot delete {}", name_of(f))));
    }
    r.done[0] += sz;
    r.done[1] += 1;
    r.progress(&name_of(f), false);
    Ok(())
}

/// `from` moved to `to` whole (nothing in the way), for a recycle bin and its restore: a rename, else a copy then a
/// delete of what arrived; an error when any of it stayed behind.
pub fn move_whole(from: &Path, to: &Path) -> Result<(), String> {
    let id = format!("x-{}", SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let j = Arc::new(Job::new(&id, "keep"));
    let quiet = |_: &Event| {};
    let mut r = Run { j, on: &quiet, mv: true, same_vol: true, done: [0, 0], total: [0, 0], told: None, failed: Vec::new(), skipped: 0, left: 0 };
    if transfer(from, to.to_path_buf(), &mut r) {
        Ok(())
    } else {
        Err(r.failed.first().cloned().unwrap_or_else(|| format!("cannot move {}", name_of(from))))
    }
}

/// `f` renamed `name` in its folder → its new path; a name taken by another file refused («exists») — a change of
/// letter case alone is let through only when the name taken is `f` itself (a disk that ignores case).
pub fn rename(f: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains('\u{0}') || name == "." || name == ".." {
        return Err("bad name".to_string());
    }
    if !there(f) {
        return Err("not found".to_string());
    }
    let parent = f.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let to = parent.join(name);
    if name_of(&to) == name_of(f) {
        return Ok(f.to_path_buf());
    }
    if there(&to) && !same(f, &to) {
        return Err("exists".to_string());
    }
    let ok = if same(f, &to) {
        // (The letter case alone on a disk that ignores it — `to` is `f` —: by way of a passing name.)
        let mid = keep_both(&parent.join(format!("{}.ktrename", name)), false);
        let ok = fs::rename(f, &mid).is_ok() && fs::rename(&mid, &to).is_ok();
        if !ok && there(&mid) {
            let _ = fs::rename(&mid, f);
        }
        ok
    } else {
        fs::rename(f, &to).is_ok()
    };
    if ok {
        Ok(to)
    } else {
        Err("cannot rename".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn mk(d: &Path, rel: &str, text: &str) -> PathBuf {
        let f = d.join(rel);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(&f, text.as_bytes()).unwrap();
        f
    }
    fn big(d: &Path, rel: &str, mb: usize) -> PathBuf {
        let f = d.join(rel);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        let mut b = vec![0u8; mb << 20];
        let mut x: u32 = 7;
        for v in b.iter_mut() {
            x = x.wrapping_mul(1103515245).wrapping_add(12345);
            *v = (x >> 16) as u8;
        }
        fs::write(&f, &b).unwrap();
        f
    }
    fn read(f: &Path) -> Option<String> {
        fs::read(f).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
    }
    fn fresh(root: &Path, name: &str) -> PathBuf {
        let d = root.join(format!("{}-{}", name, SEQ.fetch_add(1, Ordering::SeqCst)));
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn parts(d: &Path) -> bool {
        let rd = match fs::read_dir(d) {
            Ok(r) => r,
            Err(_) => return false,
        };
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if n.contains(".ktpart") || n.contains(".ktold") {
                return true;
            }
            if e.path().is_dir() && parts(&e.path()) {
                return true;
            }
        }
        false
    }
    fn names(d: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(d).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    /// A job run to its end, as FilesT.job: `conflict` the standing answer, or «ask:x» — asked, answered x; `cancel_at`
    /// cancels at the first progress («first») or at the forced one after the named file («done:name»).
    fn job(op: &str, paths: &[&Path], dest: Option<&Path>, conflict: &str, cancel_at: Option<&str>, asked: &Mutex<Vec<Event>>) -> Event {
        let id = format!("t{}", SEQ.fetch_add(1, Ordering::SeqCst));
        let ans: Option<String> = conflict.strip_prefix("ask:").map(|s| s.to_string());
        let standing = if ans.is_some() { "ask" } else { conflict };
        let list: Vec<PathBuf> = paths.iter().map(|p| p.to_path_buf()).collect();
        let idc = id.clone();
        let on = move |ev: &Event| {
            if ev.status == "conflict" {
                asked.lock().unwrap().push(ev.clone());
                answer(&idc, ans.as_deref().unwrap_or("skip"));
            } else if ev.status == "progress" {
                if let Some(c) = cancel_at {
                    let hit = c == "first" || c.strip_prefix("done:").map(|n| ev.name.as_deref() == Some(n) && ev.files.unwrap_or(0) > 0).unwrap_or(false);
                    if hit {
                        cancel(&idc);
                    }
                }
            }
        };
        run(&id, op, &list, dest, standing, &on)
    }
    fn none() -> Mutex<Vec<Event>> {
        Mutex::new(Vec::new())
    }
    fn failed(e: &Event) -> usize {
        e.failed.as_ref().map(|f| f.len()).unwrap_or(99)
    }

    fn roots() -> (PathBuf, Option<PathBuf>) {
        let root = std::env::temp_dir().join(format!("ktfiles-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::SeqCst)));
        fs::create_dir_all(&root).unwrap();
        let shm = Path::new("/dev/shm");
        let mut other = None;
        if shm.is_dir() {
            let o = shm.join(format!("ktfiles-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::SeqCst)));
            if fs::create_dir_all(&o).is_ok() && !same_storage(&o, &root) {
                other = Some(o);
            }
        }
        (root, other)
    }

    #[test]
    fn names_and_json() {
        assert_eq!(ext_of("a.txt"), "txt");
        assert_eq!(ext_of(".bashrc"), "");
        assert_eq!(ext_of("a."), "");
        assert_eq!(ext_of("archive.verylongext"), "");
        let (root, other) = roots();
        assert_eq!(name_of(&keep_both(&root.join("a.txt"), false)), "a (2).txt");
        mk(&root, "a (2).txt", "x");
        assert_eq!(name_of(&keep_both(&root.join("a.txt"), false)), "a (3).txt");
        assert_eq!(name_of(&keep_both(&root.join("my.folder"), true)), "my.folder (2)");
        let mut e = Event::new("j\"1", "done");
        e.done = Some(5);
        e.failed = Some(vec!["a: \u{645}\n".to_string()]);
        e.dir = Some(false);
        assert_eq!(e.to_json(), "{\"id\":\"j\\\"1\",\"status\":\"done\",\"done\":5,\"dir\":false,\"failed\":[\"a: \u{645}\\n\"]}");
        let mut p = Event::new("x", "progress");
        p.of_files = Some(2);
        p.existing_size = Some(1);
        p.existing_mtime = Some(3);
        assert_eq!(p.to_json(), "{\"id\":\"x\",\"status\":\"progress\",\"ofFiles\":2,\"existingSize\":1,\"existingMtime\":3}");
        let _ = fs::remove_dir_all(&root);
        if let Some(o) = other {
            let _ = fs::remove_dir_all(o);
        }
    }

    #[test]
    fn moves_keep_what_was_not_copied() {
        let (root, other) = roots();
        // ---- 1. a move whose copy was skipped keeps its source
        {
            let s = fresh(&root, "s");
            let d = fresh(&root, "d");
            let f = mk(&s, "a.txt", "NEW");
            mk(&d, "a.txt", "OLD");
            let e = job("move", &[&f], Some(&d), "skip", None, &none());
            assert_eq!(read(&f).as_deref(), Some("NEW"), "move + skip: the source stays");
            assert_eq!(read(&d.join("a.txt")).as_deref(), Some("OLD"));
            assert!(e.skipped == Some(1) && e.left == Some(1) && e.remaining.as_ref().map(|r| r.len()) == Some(1), "move + skip: one skipped, one left, the path remaining: {:?}", e);
            let asked = none();
            job("move", &[&f], Some(&d), "ask:skip", None, &asked);
            assert!(asked.lock().unwrap().len() == 1 && read(&f).as_deref() == Some("NEW"), "move + asked, Skip answered: the source stays");
            let q = asked.lock().unwrap()[0].clone();
            assert!(q.from.as_deref() == Some(f.to_str().unwrap()) && q.to.as_deref() == Some(d.join("a.txt").to_str().unwrap()) && q.size == Some(3) && q.existing_size == Some(3) && q.dir == Some(false), "the question names both: {:?}", q);
        }
        // replace and keep both
        {
            let s = fresh(&root, "s");
            let d = fresh(&root, "d");
            let f = mk(&s, "a.txt", "NEW");
            mk(&d, "a.txt", "OLD");
            job("move", &[&f], Some(&d), "ask:replace", None, &none());
            assert!(read(&d.join("a.txt")).as_deref() == Some("NEW") && !f.exists() && !parts(&d), "move + replace: replaced, the source gone, no part left");
        }
        {
            let s = fresh(&root, "s");
            let d = fresh(&root, "d");
            let f = mk(&s, "a.txt", "NEW");
            mk(&d, "a.txt", "OLD");
            job("move", &[&f], Some(&d), "ask:keep", None, &none());
            assert!(read(&d.join("a.txt")).as_deref() == Some("OLD") && read(&d.join("a (2).txt")).as_deref() == Some("NEW") && !f.exists(), "move + keep both");
        }
        // apply to all: asked once, the rest follow
        {
            let s = fresh(&root, "s");
            let d = fresh(&root, "d");
            let a = mk(&s, "a.txt", "A2");
            let b = mk(&s, "b.txt", "B2");
            mk(&d, "a.txt", "A1");
            mk(&d, "b.txt", "B1");
            let asked = none();
            job("copy", &[&a, &b], Some(&d), "ask:keepAll", None, &asked);
            assert_eq!(asked.lock().unwrap().len(), 1, "keep both for all: asked once");
            assert_eq!(names(&d), vec!["a (2).txt", "a.txt", "b (2).txt", "b.txt"]);
        }
        // the same folder: nothing ever deleted
        for c in ["replace", "skip", "keep"] {
            let s = fresh(&root, "s");
            let f = mk(&s, "a.txt", "MINE");
            let asked = none();
            let e = job("move", &[&f], Some(&s), &format!("ask:{}", c), None, &asked);
            assert!(read(&f).as_deref() == Some("MINE") && asked.lock().unwrap().is_empty() && names(&s).len() == 1 && failed(&e) == 0, "cut + paste into the same folder ({}): a no-op", c);
        }
        {
            let s = fresh(&root, "s");
            let f = mk(&s, "a.txt", "MINE");
            let asked = none();
            job("copy", &[&f], Some(&s), "ask:replace", None, &asked);
            assert!(read(&f).as_deref() == Some("MINE") && read(&s.join("a (2).txt")).as_deref() == Some("MINE") && asked.lock().unwrap().is_empty(), "copy into the same folder: a second one beside it");
            let dd = s.join("my.folder");
            mk(&dd, "x.txt", "X");
            job("copy", &[&dd], Some(&s), "ask:replace", None, &none());
            assert!(read(&s.join("my.folder (2)/x.txt")).as_deref() == Some("X") && read(&dd.join("x.txt")).as_deref() == Some("X"), "a folder copied into its own folder: «my.folder (2)»");
            job("move", &[&dd], Some(&s), "replace", None, &none());
            assert_eq!(read(&dd.join("x.txt")).as_deref(), Some("X"), "a folder cut and pasted where it is: untouched");
        }
        // folder merge with one file skipped
        {
            let s = fresh(&root, "s");
            let d = fresh(&root, "d");
            let dd = s.join("D");
            mk(&dd, "x.txt", "X");
            mk(&dd, "sub/y.txt", "Y-NEW");
            mk(&dd, "sub/z.txt", "Z");
            mk(&d, "D/sub/y.txt", "Y-OLD");
            let e = job("move", &[&dd], Some(&d), "ask:skip", None, &none());
            assert!(read(&dd.join("sub/y.txt")).as_deref() == Some("Y-NEW") && read(&d.join("D/sub/y.txt")).as_deref() == Some("Y-OLD"), "merge, one skipped: it and its folders stay");
            assert!(!dd.join("x.txt").exists() && !dd.join("sub/z.txt").exists() && read(&d.join("D/x.txt")).as_deref() == Some("X") && read(&d.join("D/sub/z.txt")).as_deref() == Some("Z"), "merge, one skipped: the rest moved");
            assert_eq!(e.left, Some(1), "merge, one skipped: one left");
        }
        // a copy that fails (a folder in the way of the part file): the old file kept, the failure told
        {
            let s = fresh(&root, "s");
            let d = fresh(&root, "d");
            let f = mk(&s, "a.txt", "NEW");
            mk(&d, "a.txt", "OLD");
            mk(&d, "a.txt.ktpart/block", "B");
            let e = job("copy", &[&f], Some(&d), "replace", None, &none());
            assert!(read(&d.join("a.txt")).as_deref() == Some("OLD") && failed(&e) == 1, "copy + replace that fails: {:?}", e);
        }
        // a cancelled copy over a file: the old one stays whole
        {
            let s = fresh(&root, "s");
            let d = fresh(&root, "d");
            let f = big(&s, "b.bin", 4);
            mk(&d, "b.bin", "OLD");
            let e = job("copy", &[&f], Some(&d), "replace", Some("first"), &none());
            assert!(read(&d.join("b.bin")).as_deref() == Some("OLD") && !parts(&d) && e.status == "cancelled", "copy + replace cancelled mid-file: {:?}", e);
        }
        // moves that copy (across disks)
        let far = other.clone().unwrap_or_else(|| root.clone());
        {
            let s = fresh(&root, "s");
            let d = fresh(&far, "d");
            let f = mk(&s, "a.txt", "NEW");
            mk(&d, "a.txt.ktpart/block", "B");
            let e = job("move", &[&f], Some(&d), "ask:replace", None, &none());
            if other.is_some() {
                assert!(read(&f).as_deref() == Some("NEW") && !d.join("a.txt").exists() && failed(&e) == 1 && e.left == Some(1), "move across that fails: the source stays");
            } else {
                assert!(read(&d.join("a.txt")).as_deref() == Some("NEW") && !f.exists(), "move on one disk past a blocked part name: renamed whole");
            }
        }
        if let Some(other) = other.as_ref() {
            {
                let s = fresh(&root, "s");
                let d = fresh(other, "d");
                let f = big(&s, "b.bin", 4);
                let e = job("move", &[&f], Some(&d), "ask:replace", Some("first"), &none());
                assert!(len_of(&f) == 4 << 20 && names(&d).is_empty() && e.status == "cancelled" && e.left == Some(1), "move across cancelled mid-file: the source stays, nothing half at the destination: {:?}", e);
            }
            {
                let s = fresh(&root, "s");
                let d = fresh(other, "d");
                let x = mk(&s, "x.txt", "X");
                let y = mk(&s, "y.txt", "Y");
                let z = mk(&s, "z.txt", "Z");
                let e = job("move", &[&x, &y, &z], Some(&d), "replace", Some("done:x.txt"), &none());
                assert!(!x.exists() && read(&d.join("x.txt")).as_deref() == Some("X") && read(&y).as_deref() == Some("Y") && read(&z).as_deref() == Some("Z") && !d.join("y.txt").exists(), "move across cancelled between files: the first moved, the rest stay");
                assert!(e.left == Some(2) && e.remaining.as_ref().map(|r| r.len()) == Some(2), "… the end tells two left, their paths remaining: {:?}", e);
            }
            {
                let s = fresh(&root, "s");
                let d = fresh(other, "d");
                let dd = s.join("D");
                mk(&dd, "x.txt", "X");
                mk(&dd, "sub/y.txt", "Y-NEW");
                mk(&dd, "sub/z.txt", "Z");
                mk(&d, "D/sub/y.txt", "Y-OLD");
                job("move", &[&dd], Some(&d), "ask:skip", None, &none());
                assert!(read(&dd.join("sub/y.txt")).as_deref() == Some("Y-NEW") && !dd.join("x.txt").exists() && !dd.join("sub/z.txt").exists() && read(&d.join("D/sub/z.txt")).as_deref() == Some("Z"), "merge across, one skipped");
            }
            {
                let s = fresh(&root, "s");
                let d = fresh(other, "d");
                let dd = s.join("D");
                mk(&dd, "x.txt", "X");
                mk(&dd, "sub/y.txt", "Y");
                let e = job("move", &[&dd], Some(&d), "ask:skip", None, &none());
                assert!(!dd.exists() && read(&d.join("D/sub/y.txt")).as_deref() == Some("Y"), "a whole folder moved across");
                assert!(e.files == Some(2) && e.left == Some(0) && e.remaining.as_ref().map(|r| r.is_empty()) == Some(true), "{:?}", e);
            }
            let _ = fs::remove_dir_all(other);
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn into_itself_links_rename_delete() {
        let (root, other) = roots();
        // ---- 2. a folder into itself
        {
            let s = fresh(&root, "s");
            let dd = s.join("D");
            mk(&dd, "x.txt", "X");
            fs::create_dir_all(dd.join("sub")).unwrap();
            let e = job("copy", &[&dd], Some(&dd), "replace", None, &none());
            assert!(!dd.join("D").exists() && failed(&e) == 1, "a folder copied into itself: refused");
            let e = job("move", &[&dd], Some(&dd.join("sub")), "replace", None, &none());
            assert!(read(&dd.join("x.txt")).as_deref() == Some("X") && !dd.join("sub/D").exists() && failed(&e) == 1, "a folder moved into its own sub-folder: refused, untouched");
            assert!(e.left == Some(1) && e.remaining.as_ref().map(|r| r.len()) == Some(1));
            let slash = PathBuf::from(format!("{}/sub/", dd.to_str().unwrap()));
            let e = job("copy", &[&dd], Some(&slash), "replace", None, &none());
            assert!(!dd.join("sub/D").exists() && failed(&e) == 1, "… a trailing separator changes nothing");
            #[cfg(unix)]
            {
                let ln = s.join("toSub");
                std::os::unix::fs::symlink(dd.join("sub"), &ln).unwrap();
                let e = job("copy", &[&dd], Some(&ln), "replace", None, &none());
                assert!(!dd.join("sub/D").exists() && failed(&e) == 1, "… nor a link to the sub-folder");
            }
            let bc = s.join("Dc");
            fs::create_dir_all(&bc).unwrap();
            let e = job("copy", &[&dd], Some(&bc), "replace", None, &none());
            assert!(read(&bc.join("D/x.txt")).as_deref() == Some("X") && failed(&e) == 0, "a sibling sharing the prefix (D → Dc) is not refused");
        }
        // links: a loop not followed, a delete not gone through
        #[cfg(unix)]
        {
            let s = fresh(&root, "s");
            let d = fresh(&root, "d");
            let dd = s.join("D");
            mk(&dd, "x.txt", "X");
            std::os::unix::fs::symlink(&dd, dd.join("loop")).unwrap();
            let e = job("copy", &[&dd], Some(&d), "replace", None, &none());
            assert!(read(&d.join("D/x.txt")).as_deref() == Some("X") && !d.join("D/loop/x.txt").exists() && failed(&e) == 1, "a folder holding a link to itself copies once: {:?}", e);
            let keep = fresh(&root, "keep");
            mk(&keep, "precious.txt", "P");
            std::os::unix::fs::symlink(&keep, dd.join("out")).unwrap();
            job("delete", &[&dd], None, "ask", None, &none());
            assert!(!there(&dd) && read(&keep.join("precious.txt")).as_deref() == Some("P"), "deleting a folder with a link out deletes the link, not what it points at");
        }
        // delete: files and folders, counted
        {
            let s = fresh(&root, "s");
            let a = mk(&s, "a.txt", "A");
            let dd = s.join("D");
            mk(&dd, "x.txt", "XX");
            mk(&dd, "sub/y.txt", "YYY");
            let e = job("delete", &[&a, &dd], None, "ask", None, &none());
            assert!(names(&s).is_empty() && e.status == "done" && failed(&e) == 0 && e.done == Some(6) && e.total == Some(6), "delete: all gone, sizes told: {:?}", e);
            assert_eq!(e.files, Some(5));
            let gone = s.join("nothing");
            let e = job("delete", &[&gone], None, "ask", None, &none());
            assert_eq!(failed(&e), 0, "deleting what is not there: nothing to report");
            let e = job("delete", &[&s], None, "ask", Some("first"), &none());
            assert_eq!(e.status, "cancelled");
        }
        // an unknown destination, an unknown operation
        {
            let s = fresh(&root, "s");
            let f = mk(&s, "a.txt", "A");
            let e = job("copy", &[&f], Some(&s.join("nope")), "ask", None, &none());
            assert!(e.status == "failed" && e.message.is_some());
            let e = job("shred", &[&f], Some(&s), "ask", None, &none());
            assert_eq!(e.status, "failed");
            assert!(!running("t0"));
        }
        // a copy keeps the original's time
        {
            let s = fresh(&root, "s");
            let d = fresh(&root, "d");
            let f = mk(&s, "old.txt", "O");
            let t = SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000);
            fs::OpenOptions::new().write(true).open(&f).unwrap().set_modified(t).unwrap();
            job("copy", &[&f], Some(&d), "ask", None, &none());
            assert_eq!(mtime_ms(&d.join("old.txt")), 1_600_000_000_000);
        }
        // ---- rename
        {
            let s = fresh(&root, "s");
            let x = mk(&s, "a.txt", "A");
            mk(&s, "b.txt", "B");
            assert_eq!(rename(&x, "b.txt"), Err("exists".to_string()));
            assert!(read(&x).as_deref() == Some("A") && read(&s.join("b.txt")).as_deref() == Some("B"), "rename onto another file: refused, both kept");
            assert_eq!(rename(&x, "../c.txt"), Err("bad name".to_string()));
            let up = mk(&s, "A.txt", "upper");
            // (On a disk that keeps case, «A.txt» and «a.txt» are two files: refused.)
            assert_eq!(rename(&up, "a.txt"), Err("exists".to_string()));
            let n = mk(&s, "Notes.txt", "N");
            assert_eq!(rename(&n, "notes.txt"), Ok(s.join("notes.txt")));
            assert_eq!(read(&s.join("notes.txt")).as_deref(), Some("N"));
            assert_eq!(rename(&s.join("notes.txt"), "notes.txt"), Ok(s.join("notes.txt")));
        }
        // move_whole: renamed or copied, never half
        {
            let s = fresh(&root, "s");
            let far = other.clone().unwrap_or_else(|| root.clone());
            let d = fresh(&far, "bin");
            let dd = s.join("D");
            mk(&dd, "x.txt", "X");
            assert!(move_whole(&dd, &d.join("D")).is_ok() && !dd.exists() && read(&d.join("D/x.txt")).as_deref() == Some("X"));
        }
        if let Some(o) = other {
            let _ = fs::remove_dir_all(o);
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn paced() {
        let (root, other) = roots();
        if let Some(o) = other {
            let _ = fs::remove_dir_all(o);
        }
        let s = fresh(&root, "s");
        let d = fresh(&root, "d");
        let f = big(&s, "p.bin", 1);
        let t = Instant::now();
        let n = std::sync::atomic::AtomicUsize::new(0);
        let on = |e: &Event| {
            if e.status == "progress" {
                n.fetch_add(1, Ordering::SeqCst);
            }
        };
        let end = run_paced("paced", "copy", &[f], Some(&d), "ask", 60, &on);
        assert_eq!(end.status, "done");
        assert!(t.elapsed() >= Duration::from_millis(4 * 60), "four pieces, a pause after each");
        assert!(n.load(Ordering::SeqCst) >= 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_question_answered_from_another_thread() {
        let (root, other) = roots();
        if let Some(o) = other {
            let _ = fs::remove_dir_all(o);
        }
        let s = fresh(&root, "s");
        let d = fresh(&root, "d");
        let f = mk(&s, "a.txt", "NEW");
        mk(&d, "a.txt", "OLD");
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        let on = move |e: &Event| {
            seen2.lock().unwrap().push(e.status.to_string());
            if e.status == "conflict" {
                let id = e.id.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(50));
                    answer(&id, "replace");
                });
            }
        };
        let end = run("thr", "copy", &[f.clone()], Some(&d), "ask", &on);
        assert_eq!(end.status, "done");
        assert_eq!(read(&d.join("a.txt")).as_deref(), Some("NEW"));
        assert_eq!(seen.lock().unwrap().first().map(|s| s.as_str()), Some("conflict"));
        // (Cancelled while the question waits: answered «skip», ended «cancelled».)
        let on2 = |e: &Event| {
            if e.status == "conflict" {
                let id = e.id.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(50));
                    cancel(&id);
                });
            }
        };
        let f2 = mk(&s, "a.txt", "NEWER");
        let end = run("thr2", "copy", &[f2], Some(&d), "ask", &on2);
        assert_eq!(end.status, "cancelled");
        assert_eq!(read(&d.join("a.txt")).as_deref(), Some("NEW"));
        let _ = fs::remove_dir_all(&root);
    }
}
