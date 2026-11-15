//! The backend: librqbit 8.1.1, thin and linear. Every call that is NOT one the PC's stream_rqbit.rs compiled (CI runs
//! 43586049375, 43597302499) sits in one small function behind its own cargo feature (Cargo.toml «unproven»), with a
//! fallback made of proven calls when the feature is off — so CI can build all of it and, if that fails, the proven
//! part alone (build-android.sh). The proven calls, copied in their PC shapes:
//!   Session::new_with_opts(dir, SessionOptions { disable_dht, enable_upnp_port_forwarding, ..Default::default() }),
//!   AddTorrent::from_bytes / from_url, AddTorrentOptions { only_files, output_folder, overwrite, ..Default::default() },
//!   session.add_torrent(add, Some(opts)) → AddTorrentResponse::Added(id, h) | AlreadyManaged(id, h),
//!   h.wait_until_initialized(), session.update_only_files(&h, &HashSet<usize>), h.stats() (.progress_bytes,
//!   .total_bytes, .live → .download_speed.mbps, .upload_speed.mbps, .snapshot.peer_stats.live),
//!   h.clone().stream(index) + AsyncSeekExt::seek + AsyncReadExt::read, session.delete(TorrentIdOrHash::Id(id), bool).
//! Not proven anywhere (each listed in ANDROID-PORT.md M3): `pause` session.pause / session.unpause; `listen`
//! SessionOptions.listen_port_range; `nodhtfile` SessionOptions.disable_dht_persistence; `limits`
//! SessionOptions.ratelimits (LimitsConfig { upload_bps, download_bps }); `trackers` AddTorrentOptions.trackers;
//! `listonly` AddTorrentOptions.list_only → AddTorrentResponse::ListOnly(r) with r.info.name / r.info.files;
//! `fileprog` TorrentStats.file_progress; `upload` TorrentStats.uploaded_bytes; and the features' build itself
//! (no default features, «rust-tls»).
//!
//! ONE Tokio runtime (`rt`, two workers): librqbit spawns tasks from its calls and its drops, so every call runs inside
//! `run`, which enters the runtime for the whole call and awaits with its block_on (the PC's lesson: «there is no
//! reactor running» from a plain thread). A panic is caught one level up (dispatch.rs `safe`).

use crate::contract::{Added, Live, Meta, Src};
use kt_core::tormobile::{SessionPlan, Stats};
use std::collections::{HashMap, HashSet};
use std::io::SeekFrom;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::runtime::Runtime;

pub const NAME: &str = "librqbit 8.1.1";
pub const BUILD: &str = if cfg!(feature = "unproven") { "every call" } else { "proven calls only" };

type Handle = Arc<librqbit::ManagedTorrent>;

static RT: OnceLock<Option<Runtime>> = OnceLock::new();

fn rt() -> Result<&'static Runtime, String> {
    RT.get_or_init(|| tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_name("kt-rqbit").enable_all().build().ok()).as_ref().ok_or_else(|| "rqbit: no runtime".to_string())
}

fn run<T>(f: impl FnOnce(&'static Runtime) -> T) -> Result<T, String> {
    let rt = rt()?;
    let _inside = rt.enter();
    Ok(f(rt))
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn session_slot() -> &'static Mutex<Option<Arc<librqbit::Session>>> {
    static S: OnceLock<Mutex<Option<Arc<librqbit::Session>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}
fn handles() -> &'static Mutex<HashMap<usize, Handle>> {
    static H: OnceLock<Mutex<HashMap<usize, Handle>>> = OnceLock::new();
    H.get_or_init(|| Mutex::new(HashMap::new()))
}
fn session() -> Result<Arc<librqbit::Session>, String> {
    lock(session_slot()).clone().ok_or_else(|| "rqbit: no session".to_string())
}
fn handle(rid: usize) -> Result<Handle, String> {
    lock(handles()).get(&rid).cloned().ok_or_else(|| "rqbit: no such torrent".to_string())
}

/// The trackers the session adds to each torrent (the app's list; only with the «trackers» build).
static TRACKERS: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

pub fn start(p: &SessionPlan) -> Result<(), String> {
    // (A fresh folder each start, as on the PC: nothing librqbit kept of an earlier run is taken up by itself — the
    // app adds every torrent again, by its own list.)
    let dir = std::path::PathBuf::from(&p.data_dir);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("rqbit: {}", e))?;
    *lock(TRACKERS.get_or_init(|| Mutex::new(Vec::new()))) = p.trackers.clone();
    let opts = session_options(p);
    let s = run(|rt| rt.block_on(librqbit::Session::new_with_opts(dir, opts)).map_err(|e| format!("rqbit: {:#}", e)))??;
    *lock(session_slot()) = Some(s);
    Ok(())
}

fn session_options(p: &SessionPlan) -> librqbit::SessionOptions {
    librqbit::SessionOptions {
        disable_dht: !p.dht,
        enable_upnp_port_forwarding: p.upnp,
        // (UNPROVEN, «nodhtfile»: no DHT file in a configuration folder Android does not give.)
        #[cfg(feature = "nodhtfile")]
        disable_dht_persistence: true,
        // (UNPROVEN, «listen».)
        #[cfg(feature = "listen")]
        listen_port_range: p.ports.map(|(a, b)| a..b.saturating_add(1)),
        // (UNPROVEN, «limits».)
        #[cfg(feature = "limits")]
        ratelimits: limits_config(p.down_limit, p.up_limit),
        ..Default::default()
    }
}

#[cfg(feature = "limits")]
fn limits_config(down: Option<u64>, up: Option<u64>) -> librqbit::limits::LimitsConfig {
    let nz = |v: Option<u64>| v.and_then(|x| std::num::NonZeroU32::new(x.min(u32::MAX as u64) as u32));
    librqbit::limits::LimitsConfig { download_bps: nz(down), upload_bps: nz(up) }
}

pub fn shutdown() -> Result<(), String> {
    let hs: Vec<(usize, Handle)> = lock(handles()).drain().collect();
    let s = lock(session_slot()).take();
    run(|rt| {
        if let Some(s) = &s {
            for (rid, h) in hs {
                drop(h);
                let _ = rt.block_on(s.delete(librqbit::api::TorrentIdOrHash::Id(rid), false));
            }
        }
        drop(s);
    })
}

// (A macro, not a function: librqbit's AddTorrent type is never named here — the PC never named it either.)
macro_rules! add_of {
    ($src:expr) => {
        match $src {
            Src::Bytes(b) => librqbit::AddTorrent::from_bytes(b.clone()),
            Src::Magnet(m) => librqbit::AddTorrent::from_url(m.clone()),
        }
    };
}

/// A magnet's name and files without adding it (UNPROVEN, «listonly»). Without it a magnet cannot be placed where
/// libtorrent would put it, so it is refused — the engine restarts it on libtorrent.
#[cfg(feature = "listonly")]
pub fn meta(magnet: &str) -> Result<Meta, String> {
    let s = session()?;
    let src = Src::Magnet(magnet.to_string());
    run(|rt| -> Result<Meta, String> {
        let opts = librqbit::AddTorrentOptions { list_only: true, ..Default::default() };
        let fut = s.add_torrent(add_of!(&src), Some(opts));
        let resp = rt.block_on(async { tokio::time::timeout(Duration::from_secs(90), fut).await }).map_err(|_| "rqbit: no metadata in 90 s".to_string())?.map_err(|e| format!("rqbit: {:#}", e))?;
        match resp {
            librqbit::AddTorrentResponse::ListOnly(r) => {
                let text = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
                let name = r.info.name.as_ref().map(|n| text(n.as_ref())).unwrap_or_default();
                let (multi, files) = match &r.info.files {
                    Some(fs) => (true, fs.iter().map(|f| (f.path.iter().map(|c| text(c.as_ref())).collect::<Vec<_>>().join("/"), f.length)).collect()),
                    None => (false, vec![(name.clone(), r.info.length.unwrap_or(0))]),
                };
                Ok(Meta { name, multi, files })
            }
            _ => Err("rqbit: not listed".into()),
        }
    })?
}
#[cfg(not(feature = "listonly"))]
pub fn meta(_magnet: &str) -> Result<Meta, String> {
    Err("rqbit: this build cannot read a magnet's metadata first".into())
}

pub fn add(src: &Src, folder: &str, only: Option<&[usize]>) -> Result<Added, String> {
    let s = session()?;
    let (rid, h) = run(|rt| -> Result<(usize, Handle), String> {
        let opts = librqbit::AddTorrentOptions {
            only_files: only.map(|o| o.to_vec()),
            output_folder: Some(folder.to_string()),
            overwrite: true,
            // (UNPROVEN, «trackers»: the app's extra trackers.)
            #[cfg(feature = "trackers")]
            trackers: extra_trackers(),
            ..Default::default()
        };
        let resp = rt.block_on(s.add_torrent(add_of!(src), Some(opts))).map_err(|e| format!("rqbit: {:#}", e))?;
        let (rid, h) = match resp {
            librqbit::AddTorrentResponse::Added(i, h) => (i, h),
            librqbit::AddTorrentResponse::AlreadyManaged(i, h) => (i, h),
            _ => return Err("rqbit: listed only".into()),
        };
        // (A magnet's metadata and the check of the files already on the disk: 5 minutes at most.)
        let ready = rt.block_on(async { tokio::time::timeout(Duration::from_secs(300), h.wait_until_initialized()).await });
        match ready {
            Ok(Ok(())) => Ok((rid, h)),
            Ok(Err(e)) => {
                drop(h);
                let _ = rt.block_on(s.delete(librqbit::api::TorrentIdOrHash::Id(rid), false));
                Err(format!("rqbit: {:#}", e))
            }
            Err(_) => {
                drop(h);
                let _ = rt.block_on(s.delete(librqbit::api::TorrentIdOrHash::Id(rid), false));
                Err("rqbit: not ready in 5 minutes".into())
            }
        }
    })??;
    lock(handles()).insert(rid, h);
    Ok(Added { rid, name: String::new(), files: Vec::new() })
}

#[cfg(feature = "trackers")]
fn extra_trackers() -> Option<Vec<String>> {
    let t = TRACKERS.get().map(|m| lock(m).clone()).unwrap_or_default();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

pub fn stats(rid: usize) -> Result<Live, String> {
    let h = handle(rid)?;
    run(|_| {
        let st = h.stats();
        let (down, up, peers, live) = match st.live.as_ref() {
            Some(l) => ((l.download_speed.mbps * 1048576.0) as u64, (l.upload_speed.mbps * 1048576.0) as u64, l.snapshot.peer_stats.live as u64, true),
            None => (0, 0, 0, false),
        };
        #[allow(clippy::unnecessary_cast)]
        let (have, total) = (st.progress_bytes as u64, st.total_bytes as u64);
        let stats = Stats {
            state: if live { "live".into() } else { "initializing".into() },
            have_metadata: true,
            progress_bytes: have,
            total_bytes: total,
            uploaded_bytes: {
                // (UNPROVEN, «upload».)
                #[cfg(feature = "upload")]
                #[allow(clippy::unnecessary_cast)]
                let u = st.uploaded_bytes as u64;
                #[cfg(not(feature = "upload"))]
                let u = 0u64;
                u
            },
            down_bps: down,
            up_bps: up,
            peers,
            error: None,
            finished: total > 0 && have >= total,
        };
        // (UNPROVEN, «fileprog».)
        #[cfg(feature = "fileprog")]
        #[allow(clippy::unnecessary_cast)]
        let fd: Option<Vec<u64>> = Some(st.file_progress.iter().map(|x| *x as u64).collect());
        #[cfg(not(feature = "fileprog"))]
        let fd: Option<Vec<u64>> = None;
        drop(h);
        Live { stats, file_done: fd }
    })
}

/// Ok(true): paused by librqbit; Ok(false): this build has no pause (the dispatch then drops the torrent, files kept).
#[cfg(feature = "pause")]
pub fn pause(rid: usize) -> Result<bool, String> {
    let (s, h) = (session()?, handle(rid)?);
    run(|rt| rt.block_on(s.pause(&h)).map(|_| true).map_err(|e| format!("rqbit: {:#}", e)))?
}
#[cfg(not(feature = "pause"))]
pub fn pause(_rid: usize) -> Result<bool, String> {
    Ok(false)
}
#[cfg(feature = "pause")]
pub fn unpause(rid: usize) -> Result<bool, String> {
    let (s, h) = (session()?, handle(rid)?);
    run(|rt| rt.block_on(s.unpause(&h)).map(|_| true).map_err(|e| format!("rqbit: {:#}", e)))?
}
#[cfg(not(feature = "pause"))]
pub fn unpause(_rid: usize) -> Result<bool, String> {
    Ok(false)
}

pub fn remove(rid: usize, delete_files: bool) -> Result<(), String> {
    let s = session()?;
    let h = lock(handles()).remove(&rid);
    run(|rt| {
        drop(h);
        rt.block_on(s.delete(librqbit::api::TorrentIdOrHash::Id(rid), delete_files)).map_err(|e| format!("rqbit: {:#}", e))
    })?
}

pub fn only_files(rid: usize, only: &[usize]) -> Result<(), String> {
    let (s, h) = (session()?, handle(rid)?);
    let set: HashSet<usize> = only.iter().copied().collect();
    run(|rt| rt.block_on(s.update_only_files(&h, &set)).map_err(|e| format!("rqbit: {:#}", e)))?
}

/// `len` bytes (fewer at the end) of file `file` from `off`: a librqbit file stream seeked there — it asks for the
/// pieces under its position first — read with the time given.
pub fn read(rid: usize, file: usize, off: u64, len: usize, timeout_ms: u64) -> Result<Vec<u8>, String> {
    let h = handle(rid)?;
    run(|rt| {
        let r: Result<Vec<u8>, String> = rt.block_on(async {
            let mut stream = h.clone().stream(file).map_err(|e| format!("rqbit: {:#}", e))?;
            stream.seek(SeekFrom::Start(off)).await.map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; len];
            match tokio::time::timeout(Duration::from_millis(timeout_ms.max(1)), stream.read(&mut buf)).await {
                Ok(Ok(n)) => {
                    buf.truncate(n);
                    Ok(buf)
                }
                Ok(Err(e)) => Err(format!("rqbit: {}", e)),
                Err(_) => Err("rqbit: timeout".to_string()),
            }
        });
        drop(h);
        r
    })?
}

/// Ok(false): the limits apply from the next start of the session (librqbit's are set when it starts).
pub fn limits(_down: Option<u64>, _up: Option<u64>) -> Result<bool, String> {
    Ok(false)
}
