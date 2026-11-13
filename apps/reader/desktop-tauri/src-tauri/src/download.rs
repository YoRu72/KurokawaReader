// Downloads into the app's data folder with progress — desktop/main.cjs's kr:download / kr:delete-download (its
// built-in downloader, downloadSegmented; aria2c, which main.cjs prefers when it is installed, is not used: the
// result is the same file). The file goes to <app data>/downloads/<name made safe>; a first request asks for one
// byte (Range: bytes=0-0) to learn the size and whether the server answers ranges: a file over 2 MiB that it does is
// fetched in parts of 1–8 MiB by up to eight connections (each part tried again up to five times, the address the
// redirects led to first, then the one given), any other file in one stream (written from the first answer when the
// server ignored the range). Progress goes to the page as the kr:download-progress event, at most every 400 ms:
// { id, pct, got, total, speed, connections } — main.cjs's. The requests are the app's own (net.rs): its cookies,
// its identity, its DNS-over-HTTPS resolver. Unlike main.cjs, a download can be cancelled (kr_download_cancel, by
// its id: the bridge's extra cancelDownload) and what was written of a download that failed is removed.
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use kurokawa_shell::net;
use kurokawa_shell::reqwest;

use crate::dlplan;

/// The downloads under way that can be cancelled: (id, its stop flag).
static RUNNING: Mutex<Vec<(String, Arc<AtomicBool>)>> = Mutex::new(Vec::new());

/// main.cjs's folder: the app's data folder's «downloads».
pub fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("downloads"))
        .map_err(|e| e.to_string())
}

/// What is shown of a download's progress, shared by its connections.
struct Meter {
    got: u64,
    total: u64,
    conns: u64,
    last_t: Instant,
    last_got: u64,
    speed: f64,
}

/// One download's state, as its connections see it.
struct Job {
    app: AppHandle,
    id: String,
    meter: Mutex<Meter>,
    stop: Arc<AtomicBool>,
    /// The first real failure (a connection's), when one stopped the others.
    failure: Mutex<Option<String>>,
}

impl Job {
    /// `n` more bytes written: the page told, at most every 400 ms (or now, with `force`).
    fn add(&self, n: u64, force: bool) {
        let payload = {
            let mut m = match self.meter.lock() {
                Ok(m) => m,
                Err(_) => return,
            };
            m.got += n;
            let el = m.last_t.elapsed();
            if !force && el < Duration::from_millis(400) {
                return;
            }
            let secs = el.as_secs_f64();
            if secs > 0.0 {
                let inst = (m.got - m.last_got) as f64 / secs;
                m.speed = dlplan::smooth(m.speed, inst);
            }
            m.last_t = Instant::now();
            m.last_got = m.got;
            json!({
                "id": self.id.as_str(),
                "pct": dlplan::pct(m.got, m.total),
                "got": m.got,
                "total": m.total,
                "speed": m.speed.round(),
                "connections": m.conns,
            })
        };
        let _ = self.app.emit("kr:download-progress", payload);
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    /// A connection failed: the others stop, and this is the reason given.
    fn fail(&self, e: String) {
        if let Ok(mut f) = self.failure.lock() {
            if f.is_none() {
                *f = Some(e);
            }
        }
        self.stop.store(true, Ordering::SeqCst);
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// A pause without the async runtime's timers (a blocking thread sleeps).
async fn pause(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_millis(ms))).await;
}

/// kr:download(url, name, id) → the file's path.
pub async fn download(app: AppHandle, url: String, name: String, id: String) -> Result<String, String> {
    let dir = folder(&app)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    let file = dir.join(dlplan::safe_name(&name));
    let stop = Arc::new(AtomicBool::new(false));
    if !id.is_empty() {
        if let Ok(mut r) = RUNNING.lock() {
            r.push((id.clone(), stop.clone()));
        }
    }
    let job = Arc::new(Job {
        app: app.clone(),
        id: id.clone(),
        meter: Mutex::new(Meter { got: 0, total: 0, conns: 1, last_t: Instant::now(), last_got: 0, speed: 0.0 }),
        stop: stop.clone(),
        failure: Mutex::new(None),
    });
    let result = fetch(job.clone(), &url, &file).await;
    if !id.is_empty() {
        if let Ok(mut r) = RUNNING.lock() {
            r.retain(|(k, s)| !(k == &id && Arc::ptr_eq(s, &stop)));
        }
    }
    match result {
        Ok(()) => {
            job.add(0, true);
            Ok(file.to_string_lossy().into_owned())
        }
        Err(e) => {
            let _ = std::fs::remove_file(&file);
            Err(e)
        }
    }
}

/// The download with this id stopped (it then rejects with «cancelled») → whether one was under way.
pub fn cancel(id: &str) -> bool {
    let mut hit = false;
    if let Ok(r) = RUNNING.lock() {
        for (k, s) in r.iter() {
            if k == id {
                s.store(true, Ordering::SeqCst);
                hit = true;
            }
        }
    }
    hit
}

/// kr:delete-download(p): the file removed if it is in the downloads folder → true; false otherwise.
pub fn delete(app: &AppHandle, p: &str) -> bool {
    let dir = match folder(app) {
        Ok(d) => d,
        Err(_) => return false,
    };
    if !dlplan::inside(&dir, p) {
        return false;
    }
    std::fs::remove_file(dlplan::normalize(Path::new(p))).is_ok()
}

fn status_error(status: u16) -> String {
    format!("HTTP {}", status)
}

async fn fetch(job: Arc<Job>, url: &str, file: &Path) -> Result<(), String> {
    let client = net::client()?;
    let probe = client.get(url).header("range", "bytes=0-0").send().await.map_err(err)?;
    let status = probe.status().as_u16();
    let final_url = probe.url().to_string();
    let ranged_total: Option<u64> = probe
        .headers()
        .get("content-range")
        .and_then(|v| v.to_str().ok())
        .and_then(dlplan::range_total);
    if status == 206 {
        if let Some(total) = ranged_total {
            if dlplan::in_parts(total) {
                drop(probe);
                return in_parts(job, url, &final_url, file, total).await;
            }
        }
        drop(probe);
        let whole = client.get(url).send().await.map_err(err)?;
        return one_stream(job, whole, file).await;
    }
    // (A server that ignores the range sends the whole file now: written from this answer, not fetched twice.)
    if status == 200 {
        return one_stream(job, probe, file).await;
    }
    drop(probe);
    let again = client.get(url).send().await.map_err(err)?;
    one_stream(job, again, file).await
}

async fn one_stream(job: Arc<Job>, mut resp: reqwest::Response, file: &Path) -> Result<(), String> {
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(status_error(status));
    }
    let total: u64 = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0);
    if let Ok(mut m) = job.meter.lock() {
        m.total = total;
        m.conns = 1;
    }
    let mut out = std::fs::File::create(file).map_err(err)?;
    loop {
        if job.stopped() {
            return Err("cancelled".to_string());
        }
        let chunk = resp.chunk().await.map_err(err)?;
        match chunk {
            Some(bytes) => {
                out.write_all(&bytes).map_err(err)?;
                job.add(bytes.len() as u64, false);
            }
            None => break,
        }
    }
    out.flush().map_err(err)?;
    Ok(())
}

async fn in_parts(job: Arc<Job>, url: &str, final_url: &str, file: &Path, total: u64) -> Result<(), String> {
    let (n, chunk) = dlplan::plan(total);
    if let Ok(mut m) = job.meter.lock() {
        m.total = total;
        m.conns = n;
    }
    {
        let f = std::fs::File::create(file).map_err(err)?;
        f.set_len(total).map_err(err)?;
    }
    let next = Arc::new(AtomicU64::new(0));
    let mut lanes = Vec::new();
    for _ in 0..n {
        let (job, next) = (job.clone(), next.clone());
        let (url, final_url, file) = (url.to_string(), final_url.to_string(), file.to_path_buf());
        lanes.push(tauri::async_runtime::spawn(async move {
            let r = lane(&job, &url, &final_url, &file, total, chunk, &next).await;
            if let Err(e) = &r {
                if e != "cancelled" {
                    job.fail(e.clone());
                }
            }
            r
        }));
    }
    let mut cancelled = false;
    for h in lanes {
        match h.await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => cancelled = true,
            Err(e) => job.fail(e.to_string()),
        }
    }
    let failure: Option<String> = match job.failure.lock() {
        Ok(f) => f.clone(),
        Err(_) => None,
    };
    if let Some(e) = failure {
        return Err(e);
    }
    if cancelled || job.stopped() {
        return Err("cancelled".to_string());
    }
    Ok(())
}

/// One connection: takes the next part not yet taken, fetches it (again from where it stopped, up to five more
/// times), until none is left.
async fn lane(job: &Job, url: &str, final_url: &str, file: &Path, total: u64, chunk: u64, next: &AtomicU64) -> Result<(), String> {
    let client = net::client()?;
    let mut out = std::fs::OpenOptions::new().write(true).open(file).map_err(err)?;
    loop {
        let from = next.fetch_add(chunk, Ordering::SeqCst);
        if from >= total {
            return Ok(());
        }
        let to = (from + chunk - 1).min(total - 1);
        let mut pos = from;
        let mut attempt: u64 = 0;
        while pos <= to {
            if job.stopped() {
                return Err("cancelled".to_string());
            }
            let target = if attempt >= 2 { url } else { final_url };
            let r = part(job, client, target, &mut out, &mut pos, to).await;
            let r = match r {
                Ok(()) if pos <= to => Err("connection closed early".to_string()),
                other => other,
            };
            if let Err(e) = r {
                if job.stopped() {
                    return Err("cancelled".to_string());
                }
                if attempt >= 5 {
                    return Err(e);
                }
                attempt += 1;
                pause(400 * attempt).await;
            }
        }
    }
}

/// Bytes `*pos`..=`to` asked for and written where they go; `*pos` moves on with each piece written.
async fn part(job: &Job, client: &reqwest::Client, target: &str, out: &mut std::fs::File, pos: &mut u64, to: u64) -> Result<(), String> {
    let range = format!("bytes={}-{}", *pos, to);
    let mut resp = client.get(target).header("range", range.as_str()).send().await.map_err(err)?;
    let status = resp.status().as_u16();
    if status != 206 {
        return Err(status_error(status));
    }
    loop {
        if job.stopped() {
            return Err("cancelled".to_string());
        }
        let chunk = resp.chunk().await.map_err(err)?;
        let bytes = match chunk {
            Some(b) => b,
            None => return Ok(()),
        };
        // (Never past the part asked for, should a server send more.)
        let room = (to + 1 - *pos) as usize;
        let take = bytes.len().min(room);
        out.seek(SeekFrom::Start(*pos)).map_err(err)?;
        out.write_all(&bytes[..take]).map_err(err)?;
        *pos += take as u64;
        job.add(take as u64, false);
        if *pos > to {
            return Ok(());
        }
    }
}
