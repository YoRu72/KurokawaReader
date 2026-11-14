// librqbit as torrent streaming's engine (stage P4) — compiled ONLY with `--features rqbit`, which is off: the main
// build never names librqbit (Cargo.toml says why and how the CI step «librqbit try» turns it on), so an API that moved
// can never break it. Written without librqbit's source at hand (no crates.io where this was written): every call
// marked GUESS below is librqbit 8.x's API as remembered, to be checked against that step's compiler errors.
//
// What it does, as Electron does with WebTorrent (desktop/main.cjs watchUrl / handBack): the download aria2 has is
// paused (forcePause) and librqbit takes the same torrent in the same folder, only the watched file wanted
// (overwrite: it continues what is on the disk); each read of the player is a librqbit file stream seeked there, which
// asks for the pieces under it first. When the player closes, librqbit lets the torrent go (its files stay) and aria2
// takes it back, checking what is there (check-integrity), unpaused unless it was paused before. A file aria2 already
// has whole is not handed over (add → Err → the server falls back to aria2, which serves it from the disk).
use std::collections::HashMap;
use std::io::SeekFrom;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::engine;
use crate::stream_engine::{Aria2Stream, FileEntry, Source, StreamEngine};

struct Held {
    // GUESS: the handle add_torrent gives back is Arc<ManagedTorrent>, and its id a usize.
    handle: Arc<librqbit::ManagedTorrent>,
    rq_id: usize,
    was_paused: bool,
}

pub struct RqbitStream {
    session: Arc<librqbit::Session>,
    held: Mutex<HashMap<String, Held>>,
    aria2: Aria2Stream,
}

static ENGINE: OnceLock<Option<Arc<RqbitStream>>> = OnceLock::new();

/// The engine (its session made once; None when librqbit could not start here).
pub fn engine() -> Option<Arc<dyn StreamEngine>> {
    let e = ENGINE.get_or_init(|| {
        let dir = std::env::temp_dir().join("kurokawa-rqbit");
        let _ = std::fs::create_dir_all(&dir);
        // GUESS: Session::new_with_opts(PathBuf, SessionOptions) → Result<Arc<Session>>; SessionOptions has Default,
        // and fields disable_dht, persistence, enable_upnp_port_forwarding.
        let opts = librqbit::SessionOptions { disable_dht: false, enable_upnp_port_forwarding: false, ..Default::default() };
        match tauri::async_runtime::block_on(librqbit::Session::new_with_opts(dir, opts)) {
            Ok(session) => Some(Arc::new(RqbitStream { session, held: Mutex::new(HashMap::new()), aria2: Aria2Stream::new() })),
            Err(e) => {
                eprintln!("rqbit: no session: {:#}", e);
                None
            }
        }
    });
    e.as_ref().map(|x| x.clone() as Arc<dyn StreamEngine>)
}

impl RqbitStream {
    fn handle(&self, id: &str) -> Option<Arc<librqbit::ManagedTorrent>> {
        self.held.lock().ok()?.get(id).map(|h| h.handle.clone())
    }
}

/// aria2 paused (forcePause), waited for (5 s at most).
fn pause_aria2(id: &str) {
    if let Some(e) = engine::get() {
        let _ = e.call("forcePause", vec![json!(id)]);
        for _ in 0..25 {
            let st = e.call("tellStatus", vec![json!(id), json!(["status"])]).ok();
            let s = st.as_ref().and_then(|v| v.get("status")).and_then(|v| v.as_str()).unwrap_or("paused").to_string();
            if s != "active" && s != "waiting" {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

impl StreamEngine for RqbitStream {
    fn name(&self) -> &'static str {
        "rqbit"
    }

    fn add(&self, src: &Source) -> Result<Vec<FileEntry>, String> {
        // (The file list is aria2's — the torrent's own order —, so the page's indices mean the same.)
        let files = self.aria2.add(src)?;
        if src.torrent.is_none() && src.magnet.is_none() {
            return Err("not a torrent".into());
        }
        if self.handle(&src.id).is_some() {
            return Ok(files);
        }
        let was_paused = src.status == "paused";
        if src.status == "active" || src.status == "waiting" {
            pause_aria2(&src.id);
        }
        // GUESS: AddTorrent::from_bytes(Vec<u8>) / AddTorrent::from_url(String); AddTorrentOptions { only_files:
        // Option<Vec<usize>>, output_folder: Option<String>, overwrite: bool, .. Default }.
        let add = match (&src.torrent, &src.magnet) {
            (Some(t), _) => librqbit::AddTorrent::from_bytes(t.clone()),
            (None, Some(m)) => librqbit::AddTorrent::from_url(m.clone()),
            _ => return Err("not a torrent".into()),
        };
        let opts = librqbit::AddTorrentOptions { only_files: Some(vec![]), output_folder: Some(src.dir.clone()), overwrite: true, ..Default::default() };
        let resp = tauri::async_runtime::block_on(self.session.add_torrent(add, Some(opts))).map_err(|e| format!("{:#}", e))?;
        // GUESS: AddTorrentResponse::{Added(id, handle), AlreadyManaged(id, handle), ListOnly(_)}.
        let (rq_id, handle) = match resp {
            librqbit::AddTorrentResponse::Added(i, h) => (i, h),
            librqbit::AddTorrentResponse::AlreadyManaged(i, h) => (i, h),
            _ => return Err("rqbit: listed only".into()),
        };
        // GUESS: wait_until_initialized().await → Result<()>.
        let ready = tauri::async_runtime::block_on(async {
            tokio::time::timeout(Duration::from_secs(90), handle.wait_until_initialized()).await
        });
        match ready {
            Ok(Ok(())) => {}
            _ => {
                let _ = tauri::async_runtime::block_on(self.session.delete(librqbit::api::TorrentIdOrHash::Id(rq_id), false));
                hand_back(&src.id, was_paused);
                return Err("rqbit: no metadata in 90 s".into());
            }
        }
        if let Ok(mut m) = self.held.lock() {
            m.insert(src.id.clone(), Held { handle, rq_id, was_paused });
        }
        Ok(files)
    }

    fn select(&self, id: &str, index: usize) -> Result<(), String> {
        // (A file aria2 already has whole — main.cjs's watchUrl —: left to aria2, which serves it from the disk.)
        if let Some(e) = engine::get() {
            if let Ok(st) = e.call("tellStatus", vec![json!(id), json!(["files"])]) {
                let f = st.get("files").and_then(|f| f.get(index));
                let n = |k: &str| f.and_then(|x| x.get(k)).and_then(|v| v.as_str()).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
                if n("length") > 0 && n("completedLength") >= n("length") {
                    return Err("complete".into());
                }
            }
        }
        let h = self.handle(id).ok_or("rqbit: not added")?;
        // GUESS: Session::update_only_files(&Arc<ManagedTorrent>, &HashSet<usize>) → Result<()> (async).
        let only: std::collections::HashSet<usize> = [index].into_iter().collect();
        tauri::async_runtime::block_on(self.session.update_only_files(&h, &only)).map_err(|e| format!("{:#}", e))
    }

    fn file(&self, id: &str, index: usize) -> Result<FileEntry, String> {
        self.aria2.file(id, index)
    }

    fn prioritise(&self, _id: &str, _index: usize, _from: u64, _to: u64) {
        // (librqbit's file streams ask for the pieces under their own position first: read_at's stream does it.)
    }

    fn read_at(&self, id: &str, index: usize, pos: u64, buf: &mut [u8], gone: &dyn Fn() -> bool) -> Result<usize, String> {
        let h = self.handle(id).ok_or("rqbit: not added")?;
        // GUESS: ManagedTorrent::stream(self: Arc<Self>, file_id: usize) → Result<FileStream>; FileStream is
        // tokio's AsyncRead + AsyncSeek + Unpin, and its reads wait for the pieces.
        let mut stream = h.clone().stream(index).map_err(|e| format!("{:#}", e))?;
        let want = buf.len();
        tauri::async_runtime::block_on(async {
            stream.seek(SeekFrom::Start(pos)).await.map_err(|e| e.to_string())?;
            loop {
                if gone() {
                    return Err("gone".to_string());
                }
                // (A read waits for its pieces; looked at every second, so a reader that left is noticed.)
                match tokio::time::timeout(Duration::from_secs(1), stream.read(&mut buf[..want])).await {
                    Ok(Ok(n)) => return Ok(n),
                    Ok(Err(e)) => return Err(e.to_string()),
                    Err(_) => continue,
                }
            }
        })
    }

    fn stats(&self, id: &str, index: usize) -> Option<Value> {
        let h = self.handle(id)?;
        // GUESS: stats() → TorrentStats { progress_bytes, total_bytes, live: Option<LiveStats { download_speed: Speed
        // { mbps }, upload_speed, snapshot: { peer_stats: { live } } }> } (mbps in MiB/s).
        let st = h.stats();
        let (down, up, peers) = match st.live.as_ref() {
            Some(l) => (
                (l.download_speed.mbps * 1048576.0) as u64,
                (l.upload_speed.mbps * 1048576.0) as u64,
                l.snapshot.peer_stats.live as u64,
            ),
            None => (0, 0, 0),
        };
        let progress = if st.total_bytes > 0 { st.progress_bytes as f64 / st.total_bytes as f64 } else { 0.0 };
        let _ = index;
        Some(json!({ "down": down, "up": up, "peers": peers, "progress": progress, "buffered": [], "engine": "rqbit" }))
    }

    fn stop(&self, id: &str) {
        let held = self.held.lock().ok().and_then(|mut m| m.remove(id));
        if let Some(h) = held {
            // GUESS: Session::delete(TorrentIdOrHash, delete_files: bool) (async) — the files kept.
            let _ = tauri::async_runtime::block_on(self.session.delete(librqbit::api::TorrentIdOrHash::Id(h.rq_id), false));
            hand_back(id, h.was_paused);
        }
        self.aria2.stop(id);
    }
}

/// aria2 takes the download back: it checks what is on the disk, and goes on unless it was paused before.
fn hand_back(id: &str, was_paused: bool) {
    if let Some(e) = engine::get() {
        let _ = e.call("changeOption", vec![json!(id), json!({ "check-integrity": "true" })]);
        if !was_paused {
            let _ = e.call("unpause", vec![json!(id)]);
        }
        e.tick();
    }
}
