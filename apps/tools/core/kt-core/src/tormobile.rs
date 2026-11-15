//! Android stage M3: the phone's torrent engines — which one takes a torrent, who owns it, what a failure means, how an
//! engine's numbers become the page's task fields, when seeding stops, and the hand-over record both engines read.
//! Std only, no I/O, no clock (`now_ms` given); checked with `rustc --edition 2021 --test tormobile.rs`.
//!
//! Three engines can be chosen in Settings → Advanced («Torrent engine»), phones only:
//! - `classic`: libtorrent4j as it is today (the default; Java's own streaming rules);
//! - `director`: libtorrent4j's wires, the streaming decisions (piece priorities and deadlines) from kt-core's
//!   tordirector — needs only libkt_android.so;
//! - `rust`: librqbit in libkt_torrent.so as the whole engine of that torrent — only when that library loaded, and only
//!   for a torrent it can take (`eligible`): a real folder path (librqbit writes files by path; a SAF tree is refused),
//!   no proxy (the classic engine's proxy settings have no librqbit equivalent this port relies on), no bound network
//!   interface, no anonymous mode, encryption not «forced» (librqbit has no forced-encryption setting).
//! A torrent's engine is chosen once, when it is added, and kept with the task; one engine per info-hash, never two.

use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    Classic,
    Director,
    Rust,
}

impl Engine {
    pub fn name(self) -> &'static str {
        match self {
            Engine::Classic => "classic",
            Engine::Director => "director",
            Engine::Rust => "rust",
        }
    }
    pub fn parse(s: &str) -> Engine {
        match s {
            "director" => Engine::Director,
            "rust" => Engine::Rust,
            _ => Engine::Classic,
        }
    }
}

/// What is known when a torrent is added.
#[derive(Clone, Debug, Default)]
pub struct AddFacts {
    pub choice: String,
    /// libkt_android.so loaded (for the director).
    pub core: bool,
    /// libkt_torrent.so loaded and its session up.
    pub torrent_lib: bool,
    pub dir: String,
    pub proxy: bool,
    pub bind_iface: String,
    pub anonymous: bool,
    pub enc: String,
    /// The Rust engine already failed this torrent (the task says so): classic from now on.
    pub rust_failed_before: bool,
}

/// The engine a torrent added now goes to, and why another was not taken (empty when the choice was granted).
pub fn choose(f: &AddFacts) -> (Engine, &'static str) {
    match Engine::parse(&f.choice) {
        Engine::Classic => (Engine::Classic, ""),
        Engine::Director => {
            if f.core {
                (Engine::Director, "")
            } else {
                (Engine::Classic, "noCore")
            }
        }
        Engine::Rust => {
            if !f.torrent_lib {
                return (Engine::Classic, "noTorrentLib");
            }
            if f.rust_failed_before {
                return (Engine::Classic, "failedBefore");
            }
            match eligible(f) {
                Ok(()) => (Engine::Rust, ""),
                Err(why) => (if f.core { Engine::Director } else { Engine::Classic }, why),
            }
        }
    }
}

/// Whether librqbit can take a torrent with these settings (Err: the reason, a key the page can show).
pub fn eligible(f: &AddFacts) -> Result<(), &'static str> {
    if f.dir.starts_with("content:") || !f.dir.starts_with('/') {
        return Err("safFolder");
    }
    if f.proxy {
        return Err("proxy");
    }
    if !f.bind_iface.trim().is_empty() {
        return Err("bindIface");
    }
    if f.anonymous {
        return Err("anonymous");
    }
    if f.enc == "forced" {
        return Err("forcedEncryption");
    }
    Ok(())
}

/* ---------- the session's plan from the settings ---------- */

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Settings {
    pub data_dir: String,
    pub listen_port: i64,
    pub dht: bool,
    pub upnp: bool,
    pub trackers: Vec<String>,
    pub add_trackers: bool,
    pub down_limit: i64,
    pub up_limit: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SessionPlan {
    pub data_dir: String,
    /// (first, last) port to listen on; None: librqbit's own choice.
    pub ports: Option<(u16, u16)>,
    pub dht: bool,
    pub upnp: bool,
    pub trackers: Vec<String>,
    pub down_limit: Option<u64>,
    pub up_limit: Option<u64>,
}

/// The Rust engine's session from the app's settings. A port outside 1024–65535 is the library's choice; the extra
/// trackers only when the setting adds them, only udp/http(s) (librqbit has no WebSocket trackers), no duplicates.
pub fn session_plan(s: &Settings) -> Result<SessionPlan, String> {
    if s.data_dir.is_empty() || !s.data_dir.starts_with('/') {
        return Err("data dir: not a path".into());
    }
    let ports = if (1024..=65535).contains(&s.listen_port) { Some((s.listen_port as u16, s.listen_port as u16)) } else { None };
    let mut trackers = Vec::new();
    if s.add_trackers {
        for t in &s.trackers {
            let t = t.trim();
            let lower = t.to_ascii_lowercase();
            if (lower.starts_with("udp://") || lower.starts_with("http://") || lower.starts_with("https://")) && !t.contains(char::is_whitespace) && !trackers.iter().any(|x: &String| x == t) {
                trackers.push(t.to_string());
            }
        }
    }
    let lim = |v: i64| if v > 0 { Some(v as u64) } else { None };
    Ok(SessionPlan { data_dir: s.data_dir.clone(), ports, dht: s.dht, upnp: s.upnp, trackers, down_limit: lim(s.down_limit), up_limit: lim(s.up_limit) })
}

/* ---------- one owner per info-hash ---------- */

/// Which engine holds each torrent (lower-case info-hash). Every change goes through these steps.
#[derive(Default, Debug)]
pub struct Owners {
    m: HashMap<String, Engine>,
}

impl Owners {
    pub fn new() -> Owners {
        Owners::default()
    }
    pub fn owner(&self, hash: &str) -> Option<Engine> {
        self.m.get(&hash.to_ascii_lowercase()).copied()
    }
    /// Taken by `e`; refused when another engine holds it (the same engine again is fine).
    pub fn take(&mut self, hash: &str, e: Engine) -> Result<(), String> {
        let h = hash.to_ascii_lowercase();
        if h.len() != 40 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("not an info-hash".into());
        }
        match self.m.get(&h) {
            Some(o) if *o != e => Err(format!("held by {}", o.name())),
            _ => {
                self.m.insert(h, e);
                Ok(())
            }
        }
    }
    /// Let go by `e` (nothing when another holds it).
    pub fn release(&mut self, hash: &str, e: Engine) -> bool {
        let h = hash.to_ascii_lowercase();
        if self.m.get(&h) == Some(&e) {
            self.m.remove(&h);
            true
        } else {
            false
        }
    }
    /// Handed from one engine to another in one step (the Rust engine failing, the shutdown).
    pub fn hand(&mut self, hash: &str, from: Engine, to: Engine) -> Result<(), String> {
        let h = hash.to_ascii_lowercase();
        match self.m.get(&h) {
            Some(o) if *o == from => {
                self.m.insert(h, to);
                Ok(())
            }
            Some(o) => Err(format!("held by {}", o.name())),
            None => Err("not held".into()),
        }
    }
}

/* ---------- a failure of the Rust engine ---------- */

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnFail {
    /// Nothing written yet (no metadata, or metadata but not one byte): the same source restarted on classic at once,
    /// counted.
    RestartClassic,
    /// Bytes on the disk: paused with a line, marked classic; resuming it hands the folder to libtorrent, which checks
    /// the files there and keeps every good piece.
    PauseForClassic,
    /// The user's own stop (pause, remove) — not a failure.
    Ignore,
}

pub fn on_fail(have_metadata: bool, bytes_on_disk: u64, user_stopped: bool) -> OnFail {
    if user_stopped {
        OnFail::Ignore
    } else if !have_metadata || bytes_on_disk == 0 {
        OnFail::RestartClassic
    } else {
        OnFail::PauseForClassic
    }
}

/// An engine's error text → what the task shows: the folder's refusal as the page's «noFolderAccess» (as KtEngine's
/// errOf), anything else prefixed «rust: » so the row says which engine it was.
pub fn error_text(e: &str) -> String {
    let l = e.to_ascii_lowercase();
    if l.contains("permission denied") || l.contains("operation not permitted") || l.contains("eperm") || l.contains("eacces") || l.contains("os error 13") || l.contains("os error 1)") {
        "noFolderAccess".into()
    } else if e.starts_with("rust: ") {
        e.to_string()
    } else {
        format!("rust: {}", e)
    }
}

/* ---------- the engine's numbers as the page's task ---------- */

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Stats {
    /// "initializing" | "live" | "paused" | "error"
    pub state: String,
    pub have_metadata: bool,
    pub progress_bytes: u64,
    pub total_bytes: u64,
    pub uploaded_bytes: u64,
    pub down_bps: u64,
    pub up_bps: u64,
    pub peers: u64,
    pub error: Option<String>,
    pub finished: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TaskView {
    pub state: &'static str,
    pub done: u64,
    pub total: u64,
    pub down: u64,
    pub up: u64,
    pub peers: u64,
    pub error: Option<String>,
}

/// The task's fields as KtEngine.refreshTorrents sets them for libtorrent (state names the page knows: paused, failed,
/// checking, metadata, seeding, done, downloading). librqbit counts no seeds apart from peers: `peers` is all of them.
pub fn task_view(s: &Stats, paused_by_user: bool, seed_after_done: bool) -> TaskView {
    let state = if paused_by_user {
        "paused"
    } else if s.state == "error" {
        "failed"
    } else if !s.have_metadata {
        "metadata"
    } else if s.state == "initializing" {
        "checking"
    } else if s.finished || (s.total_bytes > 0 && s.progress_bytes >= s.total_bytes) {
        if seed_after_done && s.state == "live" {
            "seeding"
        } else {
            "done"
        }
    } else if s.state == "paused" {
        "paused"
    } else {
        "downloading"
    };
    let moving = matches!(state, "downloading" | "seeding" | "metadata");
    TaskView {
        state,
        done: s.progress_bytes.min(if s.total_bytes > 0 { s.total_bytes } else { u64::MAX }),
        total: s.total_bytes,
        down: if moving { s.down_bps } else { 0 },
        up: if moving { s.up_bps } else { 0 },
        peers: s.peers,
        error: if state == "failed" { s.error.as_deref().map(error_text) } else { None },
    }
}

/// A task's fields as one JSON-ready row is compared with the last one sent: only changed rows cross JNI.
pub fn changed(old: Option<&TaskView>, new: &TaskView) -> bool {
    match old {
        None => true,
        Some(o) => o != new,
    }
}

/* ---------- seeding ---------- */

#[derive(Clone, Copy, Debug, Default)]
pub struct SeedRules {
    pub seed_after_done: bool,
    /// 0: no ratio limit.
    pub ratio: f64,
    /// 0: no time limit.
    pub minutes: i64,
}

/// Whether a finished torrent keeps seeding: the settings say so, the ratio and the time are under their limits, and
/// no hold (mobile data with «Wi-Fi only», a low battery) applies — the same holds KtEngine puts on downloads.
pub fn keep_seeding(r: &SeedRules, uploaded: u64, downloaded: u64, total: u64, done_at_ms: i64, now_ms: i64, held: bool) -> bool {
    if !r.seed_after_done || held {
        return false;
    }
    let base = if downloaded > 0 { downloaded } else { total };
    if r.ratio > 0.0 && base > 0 && uploaded as f64 / base as f64 >= r.ratio {
        return false;
    }
    if r.minutes > 0 && done_at_ms > 0 && now_ms - done_at_ms >= r.minutes * 60_000 {
        return false;
    }
    true
}

/* ---------- file selection ---------- */

/// The page's priorities (per file: 0 skip, 1 normal, 2 high; missing = normal) → the files librqbit fetches
/// (librqbit has wanted / not wanted only). An empty choice (every file skipped) keeps every file wanted: librqbit
/// refuses a torrent with nothing to fetch, and libtorrent's «all skipped» means a paused one.
pub fn only_files(prios: Option<&[i64]>, num_files: usize) -> Vec<usize> {
    let all: Vec<usize> = (0..num_files).collect();
    match prios {
        None => all,
        Some(p) => {
            let v: Vec<usize> = (0..num_files).filter(|&i| p.get(i).copied().unwrap_or(1) > 0).collect();
            if v.is_empty() {
                all
            } else {
                v
            }
        }
    }
}

/* ---------- the hand-over record ---------- */

/// What one engine leaves for the other (`<id>.torhand` beside the task): neither engine reads the other's own resume
/// format (libtorrent's fastresume, librqbit's session file), so the record says only what the next one needs to
/// take the torrent from the same folder: the info-hash, the folder, the files wanted, the engine that wrote it and
/// whether it failed, the bytes it had. Both engines check the files on the disk when they take a torrent (libtorrent
/// without resume data hashes what is there; librqbit with `overwrite` does the same) — the record never claims pieces.
#[derive(Clone, Debug, PartialEq)]
pub struct Hand {
    pub hash: String,
    pub dir: String,
    pub files: Vec<usize>,
    pub from: Engine,
    pub failed: bool,
    pub bytes: u64,
}

pub fn hand_text(h: &Hand) -> String {
    let files: Vec<String> = h.files.iter().map(|x| x.to_string()).collect();
    format!("kthand1\nhash={}\nfrom={}\nfailed={}\nbytes={}\nfiles={}\ndir={}\n", h.hash.to_ascii_lowercase(), h.from.name(), h.failed, h.bytes, files.join(","), h.dir)
}

pub fn hand_parse(t: &str) -> Result<Hand, String> {
    let mut lines = t.lines();
    if lines.next() != Some("kthand1") {
        return Err("not a hand-over record".into());
    }
    let mut kv = HashMap::new();
    for l in lines {
        if let Some((k, v)) = l.split_once('=') {
            kv.insert(k.to_string(), v.to_string());
        }
    }
    let get = |k: &str| kv.get(k).cloned().ok_or_else(|| format!("record: no {}", k));
    let hash = get("hash")?;
    if hash.len() != 40 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("record: bad hash".into());
    }
    let files = get("files")?;
    let files = if files.is_empty() { Vec::new() } else { files.split(',').map(|x| x.parse::<usize>().map_err(|_| "record: bad files".to_string())).collect::<Result<_, _>>()? };
    Ok(Hand { hash, dir: get("dir")?, files, from: Engine::parse(&get("from")?), failed: get("failed")? == "true", bytes: get("bytes")?.parse().map_err(|_| "record: bad bytes")? })
}

/// The folder librqbit is given so its files are where libtorrent puts them (and the hand-over finds them): libtorrent
/// writes a multi-file torrent under «<dir>/<name>/…» and a single file at «<dir>/<name>»; librqbit writes a file's
/// in-torrent path (without the torrent's name) under its folder — the same rule as the PC's hybridlogic::rqbit_folder.
pub fn rqbit_folder(dir: &str, multi: bool, name: &str) -> String {
    let clean = name.trim();
    if multi && !clean.is_empty() && clean != "." && clean != ".." && !clean.contains('/') && !clean.contains('\\') {
        format!("{}/{}", dir.trim_end_matches('/'), clean)
    } else {
        dir.to_string()
    }
}

/// Standard base64 (with or without padding, line breaks ignored) — the .torrent bytes Java keeps in a task's source.
pub fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut n = 0;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' | b'\n' | b'\r' | b' ' => continue,
            _ => return Err("base64: bad character".into()),
        } as u32;
        acc = (acc << 6) | v;
        n += 6;
        if n >= 8 {
            n -= 8;
            out.push((acc >> n) as u8);
        }
    }
    Ok(out)
}

/// A magnet's info-hash (btih, 40 hex or 32 base32), lower-case hex; None when it has none.
pub fn magnet_hash(m: &str) -> Option<String> {
    let i = m.to_ascii_lowercase().find("xt=urn:btih:")?;
    let rest = &m[i + 12..];
    let v: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
    if v.len() == 40 && v.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Some(v.to_ascii_lowercase());
    }
    if v.len() == 32 {
        let mut bits: u64 = 0;
        let mut n = 0;
        let mut out = String::new();
        for c in v.to_ascii_uppercase().bytes() {
            let x = match c {
                b'A'..=b'Z' => c - b'A',
                b'2'..=b'7' => c - b'2' + 26,
                _ => return None,
            } as u64;
            bits = (bits << 5) | x;
            n += 5;
            while n >= 8 {
                n -= 8;
                out.push_str(&format!("{:02x}", (bits >> n) & 0xff));
            }
        }
        return Some(out);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(choice: &str) -> AddFacts {
        AddFacts { choice: choice.into(), core: true, torrent_lib: true, dir: "/storage/emulated/0/Download/Kurokawa".into(), enc: "enabled".into(), ..Default::default() }
    }

    #[test]
    fn engine_choice() {
        assert_eq!(choose(&facts("classic")), (Engine::Classic, ""));
        assert_eq!(choose(&facts("")), (Engine::Classic, ""));
        assert_eq!(choose(&facts("director")), (Engine::Director, ""));
        assert_eq!(choose(&facts("rust")), (Engine::Rust, ""));
        let mut f = facts("rust");
        f.torrent_lib = false;
        assert_eq!(choose(&f), (Engine::Classic, "noTorrentLib"));
        let mut f = facts("rust");
        f.dir = "content://com.android.externalstorage.documents/tree/primary%3ADownload".into();
        assert_eq!(choose(&f), (Engine::Director, "safFolder"));
        f.core = false;
        assert_eq!(choose(&f), (Engine::Classic, "safFolder"));
        let mut f = facts("rust");
        f.proxy = true;
        assert_eq!(choose(&f).1, "proxy");
        let mut f = facts("rust");
        f.bind_iface = "tun0".into();
        assert_eq!(choose(&f).1, "bindIface");
        let mut f = facts("rust");
        f.enc = "forced".into();
        assert_eq!(choose(&f).1, "forcedEncryption");
        let mut f = facts("rust");
        f.rust_failed_before = true;
        assert_eq!(choose(&f), (Engine::Classic, "failedBefore"));
        let mut f = facts("director");
        f.core = false;
        assert_eq!(choose(&f), (Engine::Classic, "noCore"));
    }

    #[test]
    fn session_from_settings() {
        let s = Settings { data_dir: "/data/x/rqbit".into(), listen_port: 51413, dht: false, upnp: true, trackers: vec!["udp://a:1/announce".into(), "wss://b/announce".into(), " udp://a:1/announce ".into(), "http://c/announce".into()], add_trackers: true, down_limit: 0, up_limit: 1000 };
        let p = session_plan(&s).unwrap();
        assert_eq!(p.ports, Some((51413, 51413)));
        assert_eq!(p.trackers, vec!["udp://a:1/announce".to_string(), "http://c/announce".to_string()]);
        assert_eq!((p.down_limit, p.up_limit), (None, Some(1000)));
        assert!(!p.dht);
        assert_eq!(session_plan(&Settings { listen_port: 80, add_trackers: false, ..s.clone() }).unwrap().ports, None);
        assert!(session_plan(&Settings { add_trackers: false, ..s.clone() }).unwrap().trackers.is_empty());
        assert!(session_plan(&Settings { data_dir: "rel".into(), ..s }).is_err());
    }

    #[test]
    fn one_owner() {
        let h = "0123456789ABCDEF0123456789abcdef01234567";
        let mut o = Owners::new();
        o.take(h, Engine::Rust).unwrap();
        assert!(o.take(h, Engine::Classic).unwrap_err().contains("rust"));
        o.take(h, Engine::Rust).unwrap();
        assert!(!o.release(h, Engine::Classic));
        o.hand(h, Engine::Rust, Engine::Classic).unwrap();
        assert_eq!(o.owner(&h.to_lowercase()), Some(Engine::Classic));
        assert!(o.hand(h, Engine::Rust, Engine::Classic).is_err());
        assert!(o.release(h, Engine::Classic));
        assert_eq!(o.owner(h), None);
        assert!(o.take("xyz", Engine::Rust).is_err());
    }

    #[test]
    fn failures() {
        assert_eq!(on_fail(false, 0, false), OnFail::RestartClassic);
        assert_eq!(on_fail(true, 0, false), OnFail::RestartClassic);
        assert_eq!(on_fail(true, 5, false), OnFail::PauseForClassic);
        assert_eq!(on_fail(true, 5, true), OnFail::Ignore);
        assert_eq!(error_text("Permission denied (os error 13)"), "noFolderAccess");
        assert_eq!(error_text("tracker gone"), "rust: tracker gone");
        assert_eq!(error_text("rust: x"), "rust: x");
    }

    #[test]
    fn view_of_stats() {
        let mut s = Stats { state: "live".into(), have_metadata: true, progress_bytes: 50, total_bytes: 100, down_bps: 9, up_bps: 3, peers: 4, ..Default::default() };
        let v = task_view(&s, false, false);
        assert_eq!((v.state, v.done, v.total, v.down, v.peers), ("downloading", 50, 100, 9, 4));
        assert_eq!(task_view(&s, true, false).state, "paused");
        assert_eq!(task_view(&s, true, false).down, 0);
        s.have_metadata = false;
        assert_eq!(task_view(&s, false, false).state, "metadata");
        s.have_metadata = true;
        s.state = "initializing".into();
        assert_eq!(task_view(&s, false, false).state, "checking");
        s.state = "live".into();
        s.progress_bytes = 100;
        assert_eq!(task_view(&s, false, false).state, "done");
        assert_eq!(task_view(&s, false, true).state, "seeding");
        s.state = "error".into();
        s.error = Some("disk full".into());
        let v = task_view(&s, false, false);
        assert_eq!((v.state, v.error.as_deref()), ("failed", Some("rust: disk full")));
        assert!(changed(None, &v));
        assert!(!changed(Some(&v.clone()), &v));
    }

    #[test]
    fn seeding_rules() {
        let r = SeedRules { seed_after_done: true, ratio: 1.5, minutes: 60 };
        assert!(keep_seeding(&r, 100, 100, 100, 1, 1000, false));
        assert!(!keep_seeding(&r, 150, 100, 100, 1, 1000, false));
        assert!(!keep_seeding(&r, 0, 100, 100, 1, 1 + 3_600_000, false));
        assert!(!keep_seeding(&r, 0, 100, 100, 1, 1000, true));
        assert!(!keep_seeding(&SeedRules::default(), 0, 1, 1, 1, 1, false));
        assert!(keep_seeding(&SeedRules { seed_after_done: true, ratio: 0.0, minutes: 0 }, 1 << 40, 1, 1, 1, i64::MAX / 2, false));
    }

    #[test]
    fn files_wanted() {
        assert_eq!(only_files(None, 3), vec![0, 1, 2]);
        assert_eq!(only_files(Some(&[0, 2]), 3), vec![1, 2]);
        assert_eq!(only_files(Some(&[0, 0, 0]), 3), vec![0, 1, 2]);
    }

    #[test]
    fn hand_record() {
        let h = Hand { hash: "aa".repeat(20), dir: "/x/y z=1".into(), files: vec![0, 3], from: Engine::Rust, failed: true, bytes: 77 };
        let t = hand_text(&h);
        assert_eq!(hand_parse(&t).unwrap(), h);
        assert!(hand_parse("kthand0\n").is_err());
        assert_eq!(hand_parse(&t.replace("files=0,3", "files=")).unwrap().files, Vec::<usize>::new());
    }

    #[test]
    fn folders_and_base64() {
        assert_eq!(rqbit_folder("/d/", true, "Show S01"), "/d/Show S01");
        assert_eq!(rqbit_folder("/d", false, "ep.mkv"), "/d");
        assert_eq!(rqbit_folder("/d", true, "../x"), "/d");
        assert_eq!(b64_decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(b64_decode("aGVs\nbG8").unwrap(), b"hello");
        assert_eq!(b64_decode("").unwrap(), b"");
        assert!(b64_decode("a*").is_err());
    }

    #[test]
    fn magnets() {
        assert_eq!(magnet_hash("magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567&dn=x").as_deref(), Some("0123456789abcdef0123456789abcdef01234567"));
        // (base32 of 20 zero bytes, then of «Hello…»: decoded to hex)
        assert_eq!(magnet_hash("magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").as_deref(), Some(&"00".repeat(20)[..]));
        assert_eq!(magnet_hash("magnet:?dn=x"), None);
    }
}
