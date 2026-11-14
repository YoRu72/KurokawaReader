// The hybrid torrent engine (stage P4, «far seeks»): one StreamEngine in front of two back ends —
// - aria2 (stream_engine.rs's Aria2Stream): every download, and every watched file librqbit does not serve;
// - librqbit (stream_rqbit.rs, only with `--features rqbit`): a torrent the player opens, so a seek far ahead fetches the
//   pieces at the sought place first and the stream server answers the Range request as they arrive.
// hybridlogic.rs decides (std only, tested alone): which back end serves (`choose`), who may write the torrent's files
// (`Owners`: one owner per info-hash — aria2 is paused and confirmed quiet before librqbit adds, librqbit has deleted
// the torrent before aria2 is unpaused; a pause / resume from the page meanwhile is only remembered), when to give
// librqbit up (`Stall`), and where librqbit writes (`rqbit_folder`: aria2's own files, so each engine continues what
// the other fetched — both check the files on the disk when they take the torrent).
//
// Any librqbit failure — no session, the add, no metadata or no peer and no piece within 90 s, an error mid-stream —
// hands the torrent back to aria2 and the same reader goes on from aria2, as the server served before the hybrid; the
// page sees the same addresses and events (streamStats' «engine» says which one serves).
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::engine;
use crate::hybridlogic::{self as hl, Back, Facts, Owners, Purpose};
use crate::stream_engine::{FileEntry, Source, StreamEngine};
use crate::streamserver;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

static OWNERS: OnceLock<Mutex<Owners>> = OnceLock::new();

fn owners() -> MutexGuard<'static, Owners> {
    lock(OWNERS.get_or_init(|| Mutex::new(Owners::new())))
}

/// Where the librqbit back end comes from: the real one (built and its session up) or a self-test stand-in.
pub type RqSource = Box<dyn Fn() -> Option<Arc<dyn StreamEngine>> + Send + Sync>;

struct Taken {
    hash: String,
    rq: Arc<dyn StreamEngine>,
    was_paused: bool,
    aria2_at_take: u64,
    bitfield_at_take: String,
    piece_len: u64,
    rq_at_add: Option<u64>,
}

#[derive(Default)]
struct State {
    srcs: HashMap<String, Source>,
    routes: HashMap<(String, usize), Back>,
    taken: HashMap<String, Taken>,
    /// Info-hashes librqbit failed on in this run (not tried again).
    failed: HashSet<String>,
    /// gid → why librqbit does not serve it (for the log and the self-test).
    why: HashMap<String, String>,
}

pub struct Hybrid {
    label: &'static str,
    built: bool,
    aria2: Arc<dyn StreamEngine>,
    rq: RqSource,
    st: Mutex<State>,
    take_lock: Mutex<()>,
}

#[cfg(feature = "rqbit")]
fn rq_real() -> Option<Arc<dyn StreamEngine>> {
    crate::stream_rqbit::engine()
}

#[cfg(not(feature = "rqbit"))]
fn rq_real() -> Option<Arc<dyn StreamEngine>> {
    None
}

/// Why librqbit's session is not up (empty when it is, or was never asked).
#[cfg(feature = "rqbit")]
fn rq_why() -> String {
    crate::stream_rqbit::why()
}

#[cfg(not(feature = "rqbit"))]
fn rq_why() -> String {
    "librqbit is not in this build".to_string()
}

static GLOBAL: OnceLock<Arc<Hybrid>> = OnceLock::new();

/// The engine kt:streamUrl opens torrents with.
pub fn global() -> Arc<Hybrid> {
    GLOBAL
        .get_or_init(|| Arc::new(Hybrid::new("hybrid", cfg!(feature = "rqbit"), streamserver::aria2(), Box::new(rq_real))))
        .clone()
}

/* ---------- aria2's side of the hand-over (desktop/main.cjs watchUrl / handBack) ---------- */

fn tell(id: &str, keys: &[&str]) -> Option<Value> {
    engine::get()?.call("tellStatus", vec![json!(id), json!(keys)]).ok()
}

fn text(v: Option<&Value>) -> String {
    v.and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn num(v: Option<&Value>) -> u64 {
    match v {
        Some(Value::String(s)) => s.trim().parse::<u64>().unwrap_or(0),
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0),
        _ => 0,
    }
}

/// aria2 paused (forcePause) and waited for, 5 s at most → its status then.
fn pause_aria2(id: &str) -> String {
    let e = match engine::get() {
        Some(e) => e,
        None => return "no engine".into(),
    };
    let mut s = text(tell(id, &["status"]).as_ref().and_then(|v| v.get("status")));
    if hl::quiet(&s) {
        return s;
    }
    let _ = e.call("forcePause", vec![json!(id)]);
    for _ in 0..25 {
        s = text(tell(id, &["status"]).as_ref().and_then(|v| v.get("status")));
        if hl::quiet(&s) {
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }
    s
}

/// aria2 takes the download back: it checks what is on the disk (librqbit's pieces kept), and goes on if `unpause`.
fn hand_back(id: &str, unpause: bool) {
    if let Some(e) = engine::get() {
        let _ = e.call("changeOption", vec![json!(id), json!({ "check-integrity": "true" })]);
        if unpause {
            let _ = e.call("unpause", vec![json!(id)]);
        }
        e.tick();
    }
}

/// aria2 has file `index` whole (served from the disk then, main.cjs's watchUrl).
fn file_complete(id: &str, index: usize) -> bool {
    let st = match tell(id, &["files"]) {
        Some(v) => v,
        None => return false,
    };
    let f = st.get("files").and_then(|f| f.get(index));
    let len = num(f.and_then(|x| x.get("length")));
    len > 0 && num(f.and_then(|x| x.get("completedLength"))) >= len
}

impl Hybrid {
    pub fn new(label: &'static str, built: bool, aria2: Arc<dyn StreamEngine>, rq: RqSource) -> Hybrid {
        Hybrid { label, built, aria2, rq, st: Mutex::new(State::default()), take_lock: Mutex::new(()) }
    }

    fn route(&self, id: &str, index: usize) -> Back {
        lock(&self.st).routes.get(&(id.to_string(), index)).copied().unwrap_or(Back::Aria2)
    }

    fn taken_rq(&self, id: &str) -> Option<Arc<dyn StreamEngine>> {
        lock(&self.st).taken.get(id).map(|t| t.rq.clone())
    }

    fn note(&self, id: &str, why: &str) {
        eprintln!("hybrid {}: {}", id, why);
        lock(&self.st).why.insert(id.to_string(), why.to_string());
    }

    /// librqbit takes the torrent: aria2 paused and confirmed quiet first (else the take is abandoned), then librqbit
    /// adds it over aria2's files. Any failure gives the torrent back to aria2 before returning.
    fn take(&self, src: &Source, index: usize, rq: &Arc<dyn StreamEngine>) -> Result<(), String> {
        let _g = lock(&self.take_lock);
        if lock(&self.st).taken.contains_key(&src.id) {
            return Ok(());
        }
        let hash = src.info_hash.clone().ok_or("not a torrent")?;
        owners().begin_take(&hash, &src.id)?;
        let before = text(tell(&src.id, &["status"]).as_ref().and_then(|v| v.get("status")));
        let was_paused = before == "paused";
        let now = pause_aria2(&src.id);
        if let Err(e) = owners().confirm_take(&hash, &now) {
            // (aria2 did not stop in 5 s: it keeps the torrent; a pause that lands later is undone.)
            if !hl::quiet(&before) {
                hand_back(&src.id, true);
            }
            return Err(e);
        }
        let snap = tell(&src.id, &["completedLength", "bitfield", "pieceLength"]).unwrap_or(Value::Null);
        let mut s2 = src.clone();
        s2.want = Some(index);
        match rq.add(&s2) {
            Ok(_) => {
                let rq_at_add = rq.have_bytes(&src.id);
                lock(&self.st).taken.insert(
                    src.id.clone(),
                    Taken {
                        hash,
                        rq: rq.clone(),
                        was_paused,
                        aria2_at_take: num(snap.get("completedLength")),
                        bitfield_at_take: text(snap.get("bitfield")),
                        piece_len: num(snap.get("pieceLength")),
                        rq_at_add,
                    },
                );
                Ok(())
            }
            Err(e) => {
                owners().begin_release(&hash);
                rq.stop(&src.id);
                let wish = owners().released(&hash).flatten();
                hand_back(&src.id, hl::unpause_after(was_paused, wish, true));
                Err(e)
            }
        }
    }

    /// librqbit lets the torrent go (deleted from its session, files kept), then aria2 takes it back.
    fn release(&self, id: &str, still_watching: bool) {
        let t = match lock(&self.st).taken.remove(id) {
            Some(t) => t,
            None => return,
        };
        owners().begin_release(&t.hash);
        t.rq.stop(id);
        let wish = owners().released(&t.hash).flatten();
        hand_back(id, hl::unpause_after(t.was_paused, wish, still_watching));
    }

    /// librqbit failed while the player watches: aria2 serves every file of the download from now on.
    fn fall_back(&self, id: &str, why: &str) {
        self.note(id, why);
        let hash = {
            let s = lock(&self.st);
            s.taken.get(id).map(|t| t.hash.clone()).or_else(|| s.srcs.get(id).and_then(|x| x.info_hash.clone()))
        };
        self.release(id, true);
        let mut s = lock(&self.st);
        if let Some(h) = hash {
            s.failed.insert(h);
        }
        for (k, v) in s.routes.iter_mut() {
            if k.0 == id {
                *v = Back::Aria2;
            }
        }
    }

    /// What the self-test reads: the owner, which back end serves file 0, why not librqbit, the bytes each had.
    pub fn report(&self, id: &str) -> Value {
        let owner = owners().owner_of_gid(id).name();
        let session_why = rq_why();
        let s = lock(&self.st);
        let back = s.routes.iter().filter(|(k, _)| k.0 == id).map(|(_, v)| v.name()).next().unwrap_or("none");
        let why = s.why.get(id).cloned().unwrap_or_default();
        let mut out = json!({ "owner": owner, "back": back, "why": why, "sessionWhy": session_why, "built": self.built });
        if let Some(t) = s.taken.get(id) {
            out["aria2AtTake"] = json!(t.aria2_at_take);
            out["rqAtAdd"] = json!(t.rq_at_add);
            out["rqNow"] = json!(t.rq.have_bytes(id));
            out["pieceLength"] = json!(t.piece_len);
            if let Ok(f) = self.aria2.file(id, 0) {
                if let Some((a, b)) = hl::far_missing(&t.bitfield_at_take, t.piece_len, 0, f.size, 2) {
                    out["farMissing"] = json!([a, b]);
                }
                out["size0"] = json!(f.size);
            }
        }
        out
    }

    /// The live figures of a download librqbit serves now (for the downloads list, as Electron showed WebTorrent's).
    fn watching(&self, id: &str) -> Option<(u64, u64, u64)> {
        let rq = self.taken_rq(id)?;
        let v = rq.stats(id, 0)?;
        Some((num(v.get("down")), num(v.get("up")), num(v.get("peers"))))
    }

    fn release_all(&self) {
        let ids: Vec<String> = lock(&self.st).taken.keys().cloned().collect();
        for id in ids {
            self.release(&id, false);
        }
    }
}

impl StreamEngine for Hybrid {
    fn name(&self) -> &'static str {
        self.label
    }

    fn add(&self, src: &Source) -> Result<Vec<FileEntry>, String> {
        let files = self.aria2.add(src)?;
        lock(&self.st).srcs.insert(src.id.clone(), src.clone());
        Ok(files)
    }

    fn select(&self, id: &str, index: usize) -> Result<(), String> {
        let (src, held, failed) = {
            let s = lock(&self.st);
            let src = s.srcs.get(id).cloned().unwrap_or_else(|| Source { id: id.to_string(), ..Default::default() });
            let failed = src.info_hash.as_ref().map(|h| s.failed.contains(h)).unwrap_or(false);
            (src, s.taken.contains_key(id), failed)
        };
        let is_torrent = src.info_hash.is_some() && (src.torrent.is_some() || src.magnet.is_some());
        let complete = file_complete(id, index);
        // (The session is started only for a torrent that may use it.)
        let rq = if self.built && is_torrent && (held || !complete) { (self.rq)() } else { None };
        let facts = Facts { purpose: Purpose::Stream, built: self.built, session_up: rq.is_some(), is_torrent, file_complete: complete, failed_before: failed, held };
        let mut back = hl::choose(&facts);
        if back == Back::Rqbit {
            let rq = match rq {
                Some(r) => r,
                None => return Err("librqbit".into()),
            };
            let r = if held { rq.select(id, index) } else { self.take(&src, index, &rq).and_then(|_| rq.select(id, index)) };
            if let Err(e) = r {
                self.fall_back(id, &e);
                back = Back::Aria2;
            }
        } else if self.built && is_torrent && !complete {
            self.note(id, if failed { "librqbit failed on it before" } else { "librqbit's session is not up" });
        }
        if back == Back::Aria2 {
            // (aria2's own streaming: its in-order fetch, head and tail first — as before the hybrid.)
            self.aria2.select(id, index)?;
        }
        lock(&self.st).routes.insert((id.to_string(), index), back);
        Ok(())
    }

    fn file(&self, id: &str, index: usize) -> Result<FileEntry, String> {
        self.aria2.file(id, index)
    }

    fn prioritise(&self, id: &str, index: usize, from: u64, to: u64) {
        match (self.route(id, index), self.taken_rq(id)) {
            (Back::Rqbit, Some(rq)) => rq.prioritise(id, index, from, to),
            _ => self.aria2.prioritise(id, index, from, to),
        }
    }

    fn read_at(&self, id: &str, index: usize, pos: u64, buf: &mut [u8], gone: &dyn Fn() -> bool) -> Result<usize, String> {
        if self.route(id, index) == Back::Rqbit {
            if let Some(rq) = self.taken_rq(id) {
                match rq.read_at(id, index, pos, buf, gone) {
                    Ok(n) => return Ok(n),
                    Err(e) => {
                        if gone() {
                            return Err(e);
                        }
                        // (The same reader goes on from aria2.)
                        self.fall_back(id, &e);
                        let _ = self.aria2.select(id, index);
                    }
                }
            }
        }
        self.aria2.read_at(id, index, pos, buf, gone)
    }

    fn stats(&self, id: &str, index: usize) -> Option<Value> {
        if self.route(id, index) == Back::Rqbit {
            if let Some(v) = self.taken_rq(id).and_then(|rq| rq.stats(id, index)) {
                return Some(v);
            }
        }
        self.aria2.stats(id, index)
    }

    fn stop(&self, id: &str) {
        self.release(id, false);
        {
            let mut s = lock(&self.st);
            s.routes.retain(|k, _| k.0 != id);
            s.srcs.remove(id);
        }
        self.aria2.stop(id);
    }

    fn have_bytes(&self, id: &str) -> Option<u64> {
        self.taken_rq(id).and_then(|rq| rq.have_bytes(id))
    }
}

/* ---------- for engine.rs and the stream server ---------- */

/// The page pauses (`run` false) or resumes download `gid`: while librqbit holds it aria2 is not touched, the wish kept
/// for the hand-back (Electron's aria2.cjs resume skipped a handed-over download) → whether it was held.
pub fn wish(gid: &str, run: bool) -> bool {
    owners().wish(gid, run)
}

/// (down, up, peers) of a download librqbit serves now — the downloads list shows them, as Electron showed WebTorrent's.
pub fn watching(gid: &str) -> Option<(u64, u64, u64)> {
    GLOBAL.get()?.watching(gid)
}

/// Quitting: every torrent librqbit holds handed back to aria2 before aria2 saves its session (main.cjs: stopAll).
pub fn release_all() {
    if let Some(g) = GLOBAL.get() {
        g.release_all();
    }
}

/// (Self-test.) Whether librqbit is built in and its session starts here, and why not.
pub fn info() -> Value {
    let up = rq_real().is_some();
    json!({ "built": cfg!(feature = "rqbit"), "up": up, "why": if up { String::new() } else { rq_why() } })
}
