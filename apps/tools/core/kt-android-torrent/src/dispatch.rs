//! The `tor.*` methods of libkt_torrent.so (std only; the backend is src/rqbit.rs, or src/fake.rs in host tests).
//! Java (KtTorrentRs) holds the tasks; this holds the torrents librqbit has, by the app's task id:
//!   tor.start {dataDir, listenPort, dht, upnp, trackers, addTrackers, down, up}    the session (once)
//!   tor.add {id, hash, magnet | torrent (base64), dir, name?, multi?, files?, paused}  answers at once; the add
//!        (metadata for a magnet, the files on the disk checked) runs on a thread of its own and shows in tor.poll
//!   tor.poll {now, seed, ratioPct, minutes, held}   every task whose row changed, and the failures (each told once,
//!        with what Java does next: restart on libtorrent, or pause it for libtorrent); finished torrents whose
//!        seeding ends by the rules are stopped here
//!   tor.pause / tor.resume / tor.remove {id, deleteFiles} / tor.files {id, files} / tor.limits {down, up}
//!   bytes.tor.read {id, file, off, len, timeoutMs}   the bytes of a file at an offset (fewer at a piece's end),
//!        waited for — librqbit fetches the pieces under a stream's position first, so this is what KtStream calls
//!   tor.shutdown   every torrent let go with its files kept, the list handed back to Java
//! Every argument is read strictly (a missing one is an error, never a default).

use crate::backend as be;
use crate::contract::{Added, Src};
use kt_core::tormobile::{self, OnFail, SeedRules, Settings, Stats, TaskView};
use kt_core::vidjson::{self, J};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

/// The call shape's version (KtTorrentCore.PROTOCOL).
pub const PROTOCOL: i64 = 1;

pub const METHODS: &[&str] = &["core.version", "core.panic", "tor.start", "tor.add", "tor.poll", "tor.pause", "tor.resume", "tor.remove", "tor.files", "tor.limits", "tor.shutdown", "bytes.tor.read"];

#[derive(Clone, Debug, PartialEq)]
enum Phase {
    /// The add under way on its thread (a magnet's metadata, the check).
    Adding,
    Ready(usize),
    /// Paused by dropping it from librqbit (a build without librqbit's pause), its files kept; resume adds it again.
    Parked,
    Failed(String),
}

struct Entry {
    hash: String,
    src: Src,
    folder: String,
    only: Option<Vec<usize>>,
    phase: Phase,
    paused: bool,
    have_meta: bool,
    name: String,
    files: Vec<(String, u64)>,
    bytes: u64,
    last: Option<TaskView>,
    files_sent: bool,
    done_at: i64,
    /// Bumped by each add, so an add that ends after a remove or a newer add is dropped.
    gen: u64,
    /// The stall watchdog: the verified bytes last seen, since when (poll's `now`), and how many times this torrent
    /// was dropped and added again because it stood still short of its end (CI run 43684755996: librqbit 8.1.1 stopped
    /// one 32 KiB piece short with its only peer connected and never asked for it again).
    seen: u64,
    seen_at: i64,
    nudges: u32,
}

#[derive(Default)]
struct Table {
    started: bool,
    plan: Option<tormobile::SessionPlan>,
    t: HashMap<String, Entry>,
    gen: u64,
    /// The failures not yet told to Java: (id, hash, error, haveMetadata, bytes).
    told: Vec<(String, String, String, bool, u64)>,
}

fn table() -> MutexGuard<'static, Table> {
    shared().lock().unwrap_or_else(|e| e.into_inner())
}
fn shared() -> &'static Arc<Mutex<Table>> {
    static T: OnceLock<Arc<Mutex<Table>>> = OnceLock::new();
    T.get_or_init(|| Arc::new(Mutex::new(Table::default())))
}

/// A backend call with its panic caught (a librqbit panic is an ordinary failure of that torrent).
fn safe<T>(f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(r) => r,
        Err(p) => Err(crate::panic_text(&p)),
    }
}

pub fn call_bytes(method: &[u8], args: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    let m = std::str::from_utf8(method).map_err(|_| "method: not UTF-8".to_string())?;
    let text = std::str::from_utf8(args).map_err(|_| "args: not UTF-8".to_string())?;
    let a = if text.trim().is_empty() { J::Obj(Vec::new()) } else { vidjson::parse(text)? };
    if !matches!(a, J::Obj(_)) {
        return Err("args: not an object".to_string());
    }
    if m == "bytes.tor.read" {
        let _ = data;
        return read(&a);
    }
    let r = call_json(m, &a)?;
    Ok(J::Obj(vec![("r".to_string(), r)]).to_json().into_bytes())
}

pub fn call_json(m: &str, a: &J) -> Result<J, String> {
    match m {
        "core.version" => Ok(obj(vec![
            ("version", J::s(env!("CARGO_PKG_VERSION"))),
            ("protocol", num(PROTOCOL)),
            ("backend", J::s(be::NAME)),
            ("build", J::s(be::BUILD)),
            ("target", J::s(&format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS))),
            ("methods", J::Arr(METHODS.iter().map(|x| J::s(x)).collect())),
        ])),
        "core.panic" => panic!("asked to panic (core.panic)"),
        "tor.start" => start(a),
        "tor.add" => add(a),
        "tor.poll" => poll(a),
        "tor.pause" => pause(&string(a, "id")?),
        "tor.resume" => resume(&string(a, "id")?),
        "tor.remove" => remove(&string(a, "id")?, boolean(a, "deleteFiles")?),
        "tor.files" => set_files(&string(a, "id")?, ints(a, "files")?),
        "tor.limits" => {
            let lim = |k: &str| -> Result<Option<u64>, String> { Ok(Some(int(a, k)?).filter(|v| *v > 0).map(|v| v as u64)) };
            let applied = safe(|| be::limits(lim("down")?, lim("up")?))?;
            Ok(J::Bool(applied))
        }
        "tor.shutdown" => shutdown(),
        _ => Err(format!("no such method: {}", m)),
    }
}

fn start(a: &J) -> Result<J, String> {
    let s = Settings {
        data_dir: string(a, "dataDir")?,
        listen_port: int(a, "listenPort")?,
        dht: boolean(a, "dht")?,
        upnp: boolean(a, "upnp")?,
        trackers: strs(a, "trackers")?,
        add_trackers: boolean(a, "addTrackers")?,
        down_limit: int(a, "down")?,
        up_limit: int(a, "up")?,
    };
    let plan = tormobile::session_plan(&s)?;
    let mut t = table();
    if t.started {
        return Ok(obj(vec![("started", J::Bool(true)), ("again", J::Bool(true))]));
    }
    safe(|| be::start(&plan))?;
    t.started = true;
    t.plan = Some(plan);
    Ok(obj(vec![("started", J::Bool(true)), ("again", J::Bool(false))]))
}

fn add(a: &J) -> Result<J, String> {
    let id = string(a, "id")?;
    let hash = string(a, "hash")?.to_ascii_lowercase();
    if hash.len() != 40 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("not an info-hash".into());
    }
    let dir = string(a, "dir")?;
    let paused = boolean(a, "paused")?;
    let only = match a.get("files") {
        None | Some(J::Null) => None,
        Some(_) => Some(ints(a, "files")?.into_iter().filter(|i| *i >= 0).map(|i| i as usize).collect::<Vec<usize>>()),
    };
    let (src, have_meta) = match (a.get("magnet"), a.get("torrent")) {
        (_, Some(J::Str(t))) => (Src::Bytes(tormobile::b64_decode(t)?), true),
        (Some(J::Str(m)), _) => (Src::Magnet(m.clone()), false),
        _ => return Err("args: «magnet» or «torrent» missing".into()),
    };
    // (librqbit only writes to a real path: a SAF tree never comes here — tormobile::eligible — but a call that tried
    // is refused, not guessed at.)
    if !dir.starts_with('/') {
        return Err("safFolder".into());
    }
    let name = match a.get("name") {
        Some(J::Str(s)) => s.clone(),
        _ => String::new(),
    };
    let multi = matches!(a.get("multi"), Some(J::Bool(true)));
    let mut t = table();
    if !t.started {
        return Err("not started".into());
    }
    if let Some(e) = t.t.get(&id) {
        if e.hash == hash && !matches!(e.phase, Phase::Failed(_)) {
            return Ok(obj(vec![("again", J::Bool(true))]));
        }
        return Err("this task already holds a torrent".into());
    }
    // (One engine per info-hash: another task holding it here is refused, as libtorrent's duplicate_is_error.)
    if t.t.values().any(|e| e.hash == hash) {
        return Err("duplicate torrent".into());
    }
    t.gen += 1;
    let gen = t.gen;
    // (A .torrent's folder is known now; a magnet's only after its metadata — the thread asks for it first.)
    let folder = if have_meta { tormobile::rqbit_folder(&dir, multi, &name) } else { dir.clone() };
    t.t.insert(id.clone(), Entry { hash, src, folder, only, phase: Phase::Adding, paused, have_meta, name, files: Vec::new(), bytes: 0, last: None, files_sent: false, done_at: 0, gen, seen: 0, seen_at: 0, nudges: 0 });
    drop(t);
    spawn_add(id, gen, !have_meta, dir);
    Ok(obj(vec![("again", J::Bool(false))]))
}

/// The add on a thread of its own: a magnet's metadata first (for its folder), then librqbit's add (the files on the
/// disk checked), then the entry made ready — or failed.
fn spawn_add(id: String, gen: u64, need_meta: bool, dir: String) {
    let id0 = id.clone();
    let spawned = std::thread::Builder::new().name("kt-tor-add".into()).spawn(move || {
        let (src, only, mut folder) = {
            let t = table();
            match t.t.get(&id) {
                Some(e) if e.gen == gen => (e.src.clone(), e.only.clone(), e.folder.clone()),
                _ => return,
            }
        };
        if need_meta {
            if let Src::Magnet(m) = &src {
                match safe(|| be::meta(m)) {
                    Ok(meta) => {
                        folder = tormobile::rqbit_folder(&dir, meta.multi, &meta.name);
                        let mut t = table();
                        if let Some(e) = t.t.get_mut(&id) {
                            if e.gen == gen {
                                e.folder = folder.clone();
                                e.name = meta.name.clone();
                                e.files = meta.files.clone();
                                e.have_meta = true;
                            }
                        }
                    }
                    Err(e) => return fail(&id, gen, &e),
                }
            }
        }
        let r: Result<Added, String> = safe(|| be::add(&src, &folder, only.as_deref()));
        let mut t = table();
        let alive = matches!(t.t.get(&id), Some(e) if e.gen == gen);
        match r {
            Ok(added) if alive => {
                let e = t.t.get_mut(&id).unwrap();
                e.phase = Phase::Ready(added.rid);
                e.have_meta = true;
                if !added.name.is_empty() {
                    e.name = added.name;
                }
                if !added.files.is_empty() {
                    e.files = added.files;
                }
                if e.paused {
                    let rid = added.rid;
                    drop(t);
                    let _ = do_pause(&id, rid);
                }
            }
            Ok(added) => {
                // (Removed while it was being added: let go, files kept — a remove with files deletes them itself.)
                drop(t);
                let _ = safe(|| be::remove(added.rid, false));
            }
            Err(e) => {
                drop(t);
                fail(&id, gen, &e)
            }
        }
    });
    if let Err(e) = spawned {
        fail(&id0, gen, &format!("no thread: {}", e));
    }
}

fn fail(id: &str, gen: u64, err: &str) {
    let mut t = table();
    if let Some(e) = t.t.get_mut(id) {
        if e.gen == gen {
            e.phase = Phase::Failed(err.to_string());
        }
    }
}

fn do_pause(id: &str, rid: usize) -> Result<(), String> {
    // (librqbit's own pause when this build has it; else the torrent dropped with its files kept — resume adds it
    // again and its files are checked, which on a big torrent takes a while.)
    if safe(|| be::pause(rid))? {
        return Ok(());
    }
    safe(|| be::remove(rid, false))?;
    if let Some(e) = table().t.get_mut(id) {
        if e.phase == Phase::Ready(rid) {
            e.phase = Phase::Parked;
        }
    }
    Ok(())
}

fn pause(id: &str) -> Result<J, String> {
    let rid = {
        let mut t = table();
        let e = t.t.get_mut(id).ok_or("no such torrent")?;
        e.paused = true;
        match e.phase {
            Phase::Ready(r) => r,
            _ => return Ok(J::Bool(true)),
        }
    };
    do_pause(id, rid)?;
    Ok(J::Bool(true))
}

fn resume(id: &str) -> Result<J, String> {
    let (phase, gen) = {
        let mut t = table();
        t.gen += 1;
        let g = t.gen;
        let e = t.t.get_mut(id).ok_or("no such torrent")?;
        e.paused = false;
        let ph = e.phase.clone();
        if ph == Phase::Parked {
            e.phase = Phase::Adding;
            e.gen = g;
        }
        (ph, g)
    };
    match phase {
        Phase::Ready(rid) => {
            if !safe(|| be::unpause(rid))? {
                return Err("resume: this build cannot".into());
            }
        }
        Phase::Parked => spawn_add(id.to_string(), gen, false, String::new()),
        _ => {}
    }
    Ok(J::Bool(true))
}

fn remove(id: &str, delete_files: bool) -> Result<J, String> {
    let e = table().t.remove(id);
    match e {
        None => Ok(J::Bool(false)),
        Some(e) => {
            if let Phase::Ready(rid) = e.phase {
                safe(|| be::remove(rid, delete_files))?;
            } else if delete_files {
                // (Not held by librqbit now — parked, failed, still adding —: its files deleted by their paths.)
                for (p, _) in &e.files {
                    let _ = std::fs::remove_file(std::path::Path::new(&e.folder).join(p));
                }
            }
            Ok(J::Bool(true))
        }
    }
}

fn set_files(id: &str, prios: Vec<i64>) -> Result<J, String> {
    let (rid, n) = {
        let mut t = table();
        let e = t.t.get_mut(id).ok_or("no such torrent")?;
        let n = e.files.len().max(prios.len());
        let only = tormobile::only_files(Some(&prios), n);
        e.only = Some(only);
        match e.phase {
            Phase::Ready(r) => (r, n),
            _ => return Ok(J::Bool(true)),
        }
    };
    let only = tormobile::only_files(Some(&prios), n);
    safe(|| be::only_files(rid, &only))?;
    Ok(J::Bool(true))
}

fn poll(a: &J) -> Result<J, String> {
    let now = int(a, "now")?;
    let rules = SeedRules { seed_after_done: boolean(a, "seed")?, ratio: int(a, "ratioPct")? as f64 / 100.0, minutes: int(a, "minutes")? };
    let held = boolean(a, "held")?;
    // (The torrents looked at outside the lock: a librqbit call never runs with the table held.)
    let looks: Vec<(String, Phase)> = table().t.iter().map(|(k, e)| (k.clone(), e.phase.clone())).collect();
    let mut live = HashMap::new();
    for (id, ph) in &looks {
        if let Phase::Ready(rid) = ph {
            live.insert(id.clone(), safe(|| be::stats(*rid)));
        }
    }
    let mut rows = Vec::new();
    let mut to_stop = Vec::new();
    let mut to_nudge = Vec::new();
    let mut t = table();
    let mut gone = Vec::new();
    for (id, e) in t.t.iter_mut() {
        let (stats, file_done) = match &e.phase {
            Phase::Adding => (Stats { state: "initializing".into(), have_metadata: e.have_meta, total_bytes: e.files.iter().map(|f| f.1).sum(), ..Default::default() }, None),
            Phase::Parked => (Stats { state: "paused".into(), have_metadata: true, progress_bytes: e.bytes, total_bytes: e.files.iter().map(|f| f.1).sum(), ..Default::default() }, None),
            Phase::Failed(err) => {
                gone.push((id.clone(), e.hash.clone(), err.clone(), e.have_meta, e.bytes));
                continue;
            }
            Phase::Ready(_) => match live.remove(id) {
                Some(Ok(l)) => (l.stats, l.file_done),
                Some(Err(err)) => {
                    gone.push((id.clone(), e.hash.clone(), err, e.have_meta, e.bytes));
                    continue;
                }
                None => continue,
            },
        };
        if stats.state == "error" {
            gone.push((id.clone(), e.hash.clone(), stats.error.clone().unwrap_or_else(|| "error".into()), e.have_meta, e.bytes.max(stats.progress_bytes)));
            continue;
        }
        e.bytes = e.bytes.max(stats.progress_bytes);
        // (The watchdog: live, not paused, short of its end, and not one verified byte more for STALL_MS — dropped from
        // librqbit with its files kept and added again (its files checked, its requests made anew), at most
        // MAX_NUDGES times. The rows carry the count.)
        if stats.progress_bytes != e.seen || e.seen_at == 0 {
            e.seen = stats.progress_bytes;
            e.seen_at = now;
        } else if let Phase::Ready(rid) = e.phase {
            if stall_due(&stats, e.paused, now - e.seen_at, e.nudges) {
                e.nudges += 1;
                e.seen_at = now;
                to_nudge.push((id.clone(), rid));
            }
        }
        let mut v = tormobile::task_view(&stats, e.paused, rules.seed_after_done);
        if v.state == "done" || v.state == "seeding" {
            if e.done_at == 0 {
                e.done_at = now;
            }
            let keep = tormobile::keep_seeding(&rules, stats.uploaded_bytes, stats.progress_bytes, stats.total_bytes, e.done_at, now, held);
            if !keep {
                v.state = "done";
                v.up = 0;
                if let Phase::Ready(rid) = e.phase {
                    if stats.state == "live" {
                        to_stop.push((id.clone(), rid));
                    }
                }
            }
        }
        let files_new = !e.files.is_empty() && !e.files_sent;
        if tormobile::changed(e.last.as_ref(), &v) || files_new || file_done.is_some() {
            let mut row = vec![
                ("id", J::s(id)),
                ("hash", J::s(&e.hash)),
                ("name", J::s(&e.name)),
                ("state", J::s(v.state)),
                ("done", num(v.done as i64)),
                ("total", num(v.total as i64)),
                ("down", num(v.down as i64)),
                ("up", num(v.up as i64)),
                ("peers", num(v.peers as i64)),
                ("metadata", J::Bool(e.have_meta)),
                ("folder", J::s(&e.folder)),
                ("nudges", num(e.nudges as i64)),
            ];
            if !e.files.is_empty() {
                let fd = file_done.as_ref();
                row.push(("files", J::Arr(e.files.iter().enumerate().map(|(i, (p, s))| J::Arr(vec![J::s(p), num(*s as i64), num(fd.and_then(|d| d.get(i)).map(|x| *x as i64).unwrap_or(-1))])).collect())));
                e.files_sent = true;
            }
            if let Some(err) = &v.error {
                row.push(("error", J::s(err)));
            }
            // (Rows with only the per-file numbers changed would cross every poll: sent at most when the row moved.)
            if tormobile::changed(e.last.as_ref(), &v) || files_new {
                rows.push(obj(row));
            }
            e.last = Some(v);
        }
    }
    for g in &gone {
        t.t.remove(&g.0);
    }
    t.told.extend(gone);
    let failed: Vec<J> = t
        .told
        .drain(..)
        .map(|(id, hash, err, meta, bytes)| {
            let act = match tormobile::on_fail(meta, bytes, false) {
                OnFail::RestartClassic => "restartClassic",
                OnFail::PauseForClassic => "pauseForClassic",
                OnFail::Ignore => "ignore",
            };
            obj(vec![("id", J::s(&id)), ("hash", J::s(&hash)), ("error", J::s(&tormobile::error_text(&err))), ("metadata", J::Bool(meta)), ("bytes", num(bytes as i64)), ("then", J::s(act))])
        })
        .collect();
    drop(t);
    for (id, rid) in to_nudge {
        nudge(&id, rid);
    }
    for (id, rid) in to_stop {
        let _ = do_pause(&id, rid);
    }
    Ok(obj(vec![("rows", J::Arr(rows)), ("failed", J::Arr(failed))]))
}

pub const STALL_MS: i64 = 60_000;
pub const MAX_NUDGES: u32 = 3;

/// Whether a torrent that stood still `still_ms` is given the watchdog's nudge.
fn stall_due(s: &Stats, paused: bool, still_ms: i64, nudges: u32) -> bool {
    !paused && s.state == "live" && s.total_bytes > 0 && s.progress_bytes < s.total_bytes && still_ms >= STALL_MS && nudges < MAX_NUDGES
}

/// Dropped from librqbit (files kept) and added again on its thread.
fn nudge(id: &str, rid: usize) {
    let _ = safe(|| be::remove(rid, false));
    let gen = {
        let mut t = table();
        t.gen += 1;
        let g = t.gen;
        match t.t.get_mut(id) {
            Some(e) if e.phase == Phase::Ready(rid) => {
                e.phase = Phase::Adding;
                e.gen = g;
                g
            }
            _ => return,
        }
    };
    spawn_add(id.to_string(), gen, false, String::new());
}

fn read(a: &J) -> Result<Vec<u8>, String> {
    let id = string(a, "id")?;
    let file = int(a, "file")?;
    let off = int(a, "off")?;
    let len = int(a, "len")?;
    let timeout = int(a, "timeoutMs")?;
    if file < 0 || off < 0 || !(1..=(4 << 20)).contains(&len) || timeout < 0 {
        return Err("args: out of range".into());
    }
    let rid = match table().t.get(&id).map(|e| e.phase.clone()) {
        Some(Phase::Ready(r)) => r,
        Some(_) => return Err("not ready".into()),
        None => return Err("no such torrent".into()),
    };
    safe(|| be::read(rid, file as usize, off as u64, len as usize, timeout as u64))
}

fn shutdown() -> Result<J, String> {
    let all: Vec<(String, Entry)> = table().t.drain().collect();
    let mut back = Vec::new();
    for (id, e) in all {
        if let Phase::Ready(rid) = e.phase {
            let _ = safe(|| be::remove(rid, false));
        }
        back.push(obj(vec![("id", J::s(&id)), ("hash", J::s(&e.hash)), ("bytes", num(e.bytes as i64)), ("folder", J::s(&e.folder)), ("paused", J::Bool(e.paused))]));
    }
    let _ = safe(be::shutdown);
    let mut t = table();
    t.started = false;
    t.plan = None;
    Ok(obj(vec![("handedBack", J::Arr(back))]))
}

/* ---------- arguments ---------- */

fn obj(v: Vec<(&str, J)>) -> J {
    J::Obj(v.into_iter().map(|(k, x)| (k.to_string(), x)).collect())
}
fn num(n: i64) -> J {
    J::num(n as f64)
}
fn field<'a>(a: &'a J, k: &str) -> Result<&'a J, String> {
    a.get(k).ok_or_else(|| format!("args: «{}» missing", k))
}
fn string(a: &J, k: &str) -> Result<String, String> {
    match field(a, k)? {
        J::Str(s) => Ok(s.clone()),
        _ => Err(format!("args: «{}» not a string", k)),
    }
}
fn boolean(a: &J, k: &str) -> Result<bool, String> {
    match field(a, k)? {
        J::Bool(b) => Ok(*b),
        _ => Err(format!("args: «{}» not a boolean", k)),
    }
}
fn int(a: &J, k: &str) -> Result<i64, String> {
    match field(a, k)? {
        J::Num(n, _) if n.fract() == 0.0 && n.abs() < 9.0e15 => Ok(*n as i64),
        _ => Err(format!("args: «{}» not a whole number", k)),
    }
}
fn ints(a: &J, k: &str) -> Result<Vec<i64>, String> {
    match field(a, k)? {
        J::Arr(v) => v.iter().map(|x| match x {
            J::Num(n, _) if n.fract() == 0.0 => Ok(*n as i64),
            _ => Err(format!("args: «{}» holds a non-integer", k)),
        }).collect(),
        _ => Err(format!("args: «{}» not a list", k)),
    }
}
fn strs(a: &J, k: &str) -> Result<Vec<String>, String> {
    match field(a, k)? {
        J::Arr(v) => v.iter().map(|x| x.as_str().map(|s| s.to_string()).ok_or_else(|| format!("args: «{}» holds a non-string", k))).collect(),
        _ => Err(format!("args: «{}» not a list", k)),
    }
}

// (The host tests: with the stand-in backend only — `rustc --cfg kt_fake --test`, test-host.sh. The real backend is
// tested by CI against a loopback swarm, tests/loopback.rs.)
#[cfg(all(test, kt_fake))]
mod tests {
    use super::*;

    fn c(m: &str, args: &str) -> Result<J, String> {
        call_json(m, &vidjson::parse(args).unwrap())
    }
    fn poll() -> J {
        c("tor.poll", r#"{"now":1000,"seed":false,"ratioPct":0,"minutes":0,"held":false}"#).unwrap()
    }
    fn wait_row(id: &str, state: &str) -> J {
        for _ in 0..200 {
            let p = poll();
            if let Some(r) = p.get("rows").unwrap().as_arr().unwrap().iter().find(|r| r.get("id").and_then(|x| x.as_str()) == Some(id) && r.get("state").and_then(|x| x.as_str()) == Some(state)) {
                return r.clone();
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("{} never {}", id, state)
    }
    fn wait_failed(id: &str) -> J {
        for _ in 0..200 {
            let p = poll();
            if let Some(r) = p.get("failed").unwrap().as_arr().unwrap().iter().find(|r| r.get("id").and_then(|x| x.as_str()) == Some(id)) {
                return r.clone();
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("{} never failed", id)
    }
    const H1: &str = "1111111111111111111111111111111111111111";

    #[test]
    fn the_whole_table() {
        let start = r#"{"dataDir":"/tmp/kt-tor-test","listenPort":0,"dht":false,"upnp":false,"trackers":[],"addTrackers":false,"down":0,"up":0}"#;
        assert!(c("tor.add", &format!(r#"{{"id":"a","hash":"{}","magnet":"magnet:?dn=x","dir":"/tmp","paused":false}}"#, H1)).unwrap_err().contains("not started"));
        c("tor.start", start).unwrap();
        assert_eq!(c("tor.start", start).unwrap().get("again"), Some(&J::Bool(true)));
        // (add → metadata → downloading → done; the row carries the files once.)
        c("tor.add", &format!(r#"{{"id":"a","hash":"{}","magnet":"magnet:?dn=ep.mkv&xl=4000","dir":"/tmp/d","paused":false}}"#, H1)).unwrap();
        assert!(c("tor.add", &format!(r#"{{"id":"b","hash":"{}","magnet":"magnet:?dn=y","dir":"/tmp","paused":false}}"#, H1.to_uppercase())).unwrap_err().contains("duplicate"));
        let r = wait_row("a", "downloading");
        assert_eq!(r.get("name").unwrap().as_str(), Some("ep.mkv"));
        assert_eq!(r.get("folder").unwrap().as_str(), Some("/tmp/d"));
        assert!(r.get("files").is_some());
        let r = wait_row("a", "done");
        assert_eq!(r.get("done").unwrap().number(), 4000.0);
        // (bytes of the file at an offset)
        let b = call_bytes(b"bytes.tor.read", br#"{"id":"a","file":0,"off":3990,"len":100,"timeoutMs":10}"#, &[]).unwrap();
        assert_eq!(b, (3990..4000u64).map(crate::backend::byte_at).collect::<Vec<u8>>());
        assert!(call_bytes(b"bytes.tor.read", br#"{"id":"a","file":0,"off":0,"len":0,"timeoutMs":10}"#, &[]).is_err());
        // (pause / resume with librqbit's pause; then without it — parked, added again)
        c("tor.add", r#"{"id":"p","hash":"2222222222222222222222222222222222222222","magnet":"magnet:?dn=p&xl=4000000&kt-nopause=1","dir":"/tmp","paused":false}"#).unwrap();
        wait_row("p", "downloading");
        c("tor.pause", r#"{"id":"p"}"#).unwrap();
        wait_row("p", "paused");
        c("tor.resume", r#"{"id":"p"}"#).unwrap();
        wait_row("p", "downloading");
        // (a failure before metadata: restart on libtorrent; after bytes: pause for libtorrent)
        c("tor.add", r#"{"id":"f1","hash":"3333333333333333333333333333333333333333","magnet":"magnet:?dn=f&kt-fail=meta","dir":"/tmp","paused":false}"#).unwrap();
        let f = wait_failed("f1");
        assert_eq!(f.get("then").unwrap().as_str(), Some("restartClassic"));
        assert!(f.get("error").unwrap().as_str().unwrap().starts_with("rust: "));
        c("tor.add", r#"{"id":"f2","hash":"4444444444444444444444444444444444444444","magnet":"magnet:?dn=g&xl=4000000&kt-fail=after","dir":"/tmp","paused":false}"#).unwrap();
        let f = wait_failed("f2");
        assert_eq!(f.get("then").unwrap().as_str(), Some("pauseForClassic"));
        // (the watchdog: a torrent that stands still one piece short for 60 s is dropped and added again, and ends)
        c("tor.add", r#"{"id":"k","hash":"6666666666666666666666666666666666666666","magnet":"magnet:?dn=k&xl=400000&kt-stuck=1","dir":"/tmp","paused":false}"#).unwrap();
        let mut now = 10_000i64;
        let mut seen_nudge = false;
        let mut finished = false;
        for _ in 0..200 {
            now += 20_000;
            let p = c("tor.poll", &format!(r#"{{"now":{},"seed":false,"ratioPct":0,"minutes":0,"held":false}}"#, now)).unwrap();
            for r in p.get("rows").unwrap().as_arr().unwrap() {
                if r.get("id").and_then(|x| x.as_str()) == Some("k") {
                    if r.get("nudges").map(|x| x.number()).unwrap_or(0.0) >= 1.0 { seen_nudge = true; }
                    if r.get("state").and_then(|x| x.as_str()) == Some("done") { finished = true; }
                }
            }
            if finished { break; }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(seen_nudge && finished, "nudged {} finished {}", seen_nudge, finished);
        c("tor.remove", r#"{"id":"k","deleteFiles":false}"#).unwrap();
        assert!(!stall_due(&Stats { state: "live".into(), total_bytes: 10, progress_bytes: 5, ..Default::default() }, true, STALL_MS, 0), "not when paused");
        assert!(!stall_due(&Stats { state: "live".into(), total_bytes: 10, progress_bytes: 10, ..Default::default() }, false, STALL_MS, 0), "not when whole");
        assert!(!stall_due(&Stats { state: "live".into(), total_bytes: 10, progress_bytes: 5, ..Default::default() }, false, STALL_MS, MAX_NUDGES), "not past the limit");
        // (a SAF folder refused; remove; shutdown hands back what is left)
        assert_eq!(c("tor.add", r#"{"id":"s","hash":"5555555555555555555555555555555555555555","magnet":"magnet:?dn=s","dir":"content://x","paused":false}"#).unwrap_err(), "safFolder");
        assert_eq!(c("tor.remove", r#"{"id":"a","deleteFiles":false}"#).unwrap(), J::Bool(true));
        assert_eq!(c("tor.remove", r#"{"id":"a","deleteFiles":false}"#).unwrap(), J::Bool(false));
        let back = c("tor.shutdown", "{}").unwrap();
        let ids: Vec<&str> = back.get("handedBack").unwrap().as_arr().unwrap().iter().map(|x| x.get("id").unwrap().as_str().unwrap()).collect();
        assert_eq!(ids, vec!["p"]);
        assert!(c("tor.poll", r#"{"now":1}"#).is_err());
        // (a panic comes back as an error through the JNI frame)
        let r = std::panic::catch_unwind(|| call_bytes(b"core.panic", b"{}", &[]));
        assert_eq!(crate::panic_text(&r.unwrap_err()), "panic: asked to panic (core.panic)");
        assert!(call_json("core.version", &J::Obj(vec![])).unwrap().to_json().contains("\"backend\":\"fake\""));
    }
}
