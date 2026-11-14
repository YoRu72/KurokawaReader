// librqbit as torrent streaming's back end (stage P4, the hybrid engine's «far seek» half) — compiled ONLY with
// `--features rqbit` (rqbit-feature.cjs turns it on in CI's copy of Cargo.toml; a plain build never names librqbit).
// Every librqbit call below is one that compiled against librqbit 8.1.1 in CI runs 43543045018 and 43586049375
// («librqbit try», exit 0); this file adds no other librqbit call.
//
// What it does: stream_hybrid.rs has paused aria2 (and owns the torrent for librqbit — hybridlogic's Owners) before
// `add`; librqbit takes the same torrent with aria2's files (`overwrite`: the files on the disk are checked and their
// good pieces kept), only the watched files wanted; each read of the player is a librqbit file stream seeked there,
// which asks for the pieces under it first — the far seek aria2 cannot do. A read that waits with no peer and no new
// byte for 90 s gives up (Err → stream_hybrid falls back to aria2). `stop` deletes the torrent from librqbit's session,
// its files kept; stream_hybrid then hands it back to aria2 (check-integrity).
use std::collections::{HashMap, HashSet};
use std::io::SeekFrom;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::hybridlogic as hl;
use crate::stream_engine::{Aria2Stream, FileEntry, Source, StreamEngine};

struct Held {
    handle: Arc<librqbit::ManagedTorrent>,
    rq_id: usize,
    files: HashSet<usize>,
}

pub struct RqbitStream {
    session: Arc<librqbit::Session>,
    held: Mutex<HashMap<String, Held>>,
    aria2: Aria2Stream,
}

static ENGINE: OnceLock<Option<Arc<RqbitStream>>> = OnceLock::new();
static WHY: OnceLock<String> = OnceLock::new();

/// The engine (its session made once; None when librqbit could not start here — `why` says why).
pub fn engine() -> Option<Arc<dyn StreamEngine>> {
    let e = ENGINE.get_or_init(|| {
        // (A fresh folder each run: nothing librqbit might have kept of an earlier run is taken up again — a torrent it
        // restored by itself would write aria2's files without stream_hybrid's ownership.)
        // (One app runs at a time — the single-instance plugin —, so one folder.)
        let dir = std::env::temp_dir().join("kurokawa-rqbit");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        // (No DHT in a self-test run: its swarm is loopback only — the made-up torrent's own tracker on 127.0.0.1.
        // Elsewhere DHT is on, as aria2's is, for magnets.)
        let opts = librqbit::SessionOptions { disable_dht: kurokawa_shell::selftest::active(), enable_upnp_port_forwarding: false, ..Default::default() };
        match tauri::async_runtime::block_on(librqbit::Session::new_with_opts(dir, opts)) {
            Ok(session) => Some(Arc::new(RqbitStream { session, held: Mutex::new(HashMap::new()), aria2: Aria2Stream::new() })),
            Err(e) => {
                let _ = WHY.set(format!("no session: {:#}", e));
                eprintln!("rqbit: no session: {:#}", e);
                None
            }
        }
    });
    e.as_ref().map(|x| x.clone() as Arc<dyn StreamEngine>)
}

/// Why the session did not start (empty when it did, or was never asked).
pub fn why() -> String {
    WHY.get().cloned().unwrap_or_default()
}

/// (verified bytes, live peers, down B/s, up B/s, total bytes wanted) of a torrent librqbit holds.
fn live(h: &Arc<librqbit::ManagedTorrent>) -> (u64, u64, u64, u64, u64) {
    let st = h.stats();
    let (down, up, peers) = match st.live.as_ref() {
        Some(l) => ((l.download_speed.mbps * 1048576.0) as u64, (l.upload_speed.mbps * 1048576.0) as u64, l.snapshot.peer_stats.live as u64),
        None => (0, 0, 0),
    };
    // (Cast: the field types are not known here; only that they are numbers — the earlier code compared them.)
    #[allow(clippy::unnecessary_cast)]
    let out = (st.progress_bytes as u64, peers, down, up, st.total_bytes as u64);
    out
}

impl RqbitStream {
    fn handle(&self, id: &str) -> Option<Arc<librqbit::ManagedTorrent>> {
        self.held.lock().ok()?.get(id).map(|h| h.handle.clone())
    }

    fn forget(&self, rq_id: usize) {
        let _ = tauri::async_runtime::block_on(self.session.delete(librqbit::api::TorrentIdOrHash::Id(rq_id), false));
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
        let add = match (&src.torrent, &src.magnet) {
            (Some(t), _) => librqbit::AddTorrent::from_bytes(t.clone()),
            (None, Some(m)) => librqbit::AddTorrent::from_url(m.clone()),
            _ => return Err("not a torrent".into()),
        };
        // (aria2's own files: the folder hybridlogic::rqbit_folder gives, overwrite on — librqbit checks what is there
        // and keeps every good piece; only the watched file wanted.)
        let only: Vec<usize> = src.want.map(|w| vec![w]).unwrap_or_default();
        let folder = src.folder.clone().unwrap_or_else(|| src.dir.clone());
        let opts = librqbit::AddTorrentOptions { only_files: Some(only.clone()), output_folder: Some(folder), overwrite: true, ..Default::default() };
        let resp = tauri::async_runtime::block_on(self.session.add_torrent(add, Some(opts))).map_err(|e| format!("rqbit: {:#}", e))?;
        let (rq_id, handle) = match resp {
            librqbit::AddTorrentResponse::Added(i, h) => (i, h),
            librqbit::AddTorrentResponse::AlreadyManaged(i, h) => (i, h),
            _ => return Err("rqbit: listed only".into()),
        };
        // (A magnet's metadata, and the check of the files on the disk: 90 s at most.)
        let ready = tauri::async_runtime::block_on(async { tokio::time::timeout(Duration::from_secs(90), handle.wait_until_initialized()).await });
        match ready {
            Ok(Ok(())) => {}
            _ => {
                self.forget(rq_id);
                return Err("rqbit: not ready in 90 s".into());
            }
        }
        if let Ok(mut m) = self.held.lock() {
            m.insert(src.id.clone(), Held { handle, rq_id, files: only.into_iter().collect() });
        }
        Ok(files)
    }

    fn select(&self, id: &str, index: usize) -> Result<(), String> {
        // (Another file of the same torrent: the files already watched stay wanted.)
        let (h, all) = {
            let m = self.held.lock().map_err(|e| e.to_string())?;
            let held = m.get(id).ok_or("rqbit: not added")?;
            (held.handle.clone(), hl::wanted(&held.files, index))
        };
        let only: HashSet<usize> = all.iter().copied().collect();
        tauri::async_runtime::block_on(self.session.update_only_files(&h, &only)).map_err(|e| format!("rqbit: {:#}", e))?;
        if let Ok(mut m) = self.held.lock() {
            if let Some(held) = m.get_mut(id) {
                held.files = only;
            }
        }
        Ok(())
    }

    fn file(&self, id: &str, index: usize) -> Result<FileEntry, String> {
        self.aria2.file(id, index)
    }

    fn prioritise(&self, _id: &str, _index: usize, _from: u64, _to: u64) {
        // (librqbit's file streams ask for the pieces under their own position first: read_at's stream does it.)
    }

    fn read_at(&self, id: &str, index: usize, pos: u64, buf: &mut [u8], gone: &dyn Fn() -> bool) -> Result<usize, String> {
        let h = self.handle(id).ok_or("rqbit: not added")?;
        let mut stream = h.clone().stream(index).map_err(|e| format!("rqbit: {:#}", e))?;
        let want = buf.len();
        let t0 = Instant::now();
        let (have0, _, _, _, _) = live(&h);
        let mut stall = hl::Stall::new(0, have0, hl::STALL_MS);
        tauri::async_runtime::block_on(async {
            stream.seek(SeekFrom::Start(pos)).await.map_err(|e| e.to_string())?;
            loop {
                if gone() {
                    return Err("gone".to_string());
                }
                // (A read waits for its pieces; looked at every second: a reader that left, or a swarm that gives
                // nothing for 90 s — then aria2 takes over, stream_hybrid.rs.)
                match tokio::time::timeout(Duration::from_secs(1), stream.read(&mut buf[..want])).await {
                    Ok(Ok(n)) => return Ok(n),
                    Ok(Err(e)) => return Err(format!("rqbit: {}", e)),
                    Err(_) => {
                        let (have, peers, _, _, _) = live(&h);
                        if stall.observe(t0.elapsed().as_millis() as u64, have, peers) {
                            return Err("rqbit: no peer and no new piece in 90 s".to_string());
                        }
                    }
                }
            }
        })
    }

    fn stats(&self, id: &str, _index: usize) -> Option<Value> {
        let h = self.handle(id)?;
        let (have, peers, down, up, total) = live(&h);
        let progress = if total > 0 { have as f64 / total as f64 } else { 0.0 };
        Some(json!({ "down": down, "up": up, "peers": peers, "progress": progress, "buffered": [], "engine": "rqbit" }))
    }

    fn stop(&self, id: &str) {
        let held = self.held.lock().ok().and_then(|mut m| m.remove(id));
        if let Some(h) = held {
            // (Its files kept; stream_hybrid.rs hands the download back to aria2 after this.)
            self.forget(h.rq_id);
        }
        self.aria2.stop(id);
    }

    fn have_bytes(&self, id: &str) -> Option<u64> {
        self.handle(id).map(|h| live(&h).0)
    }
}
