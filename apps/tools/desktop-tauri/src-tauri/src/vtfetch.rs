// Stage P5: a program or a pack fetched for the video tools — the updater's way (update.rs, kt-core updatelogic): into
// `<file>.part`, up to six tries with a growing pause (packs.cjs: 1.5 s doubled, 20 s at most), each taking up where
// the last stopped when the server answers a Range; an HTTP 4xx is final; cancellable between pieces; its SHA-256 taken
// as it is written (or of the whole file after a resume). The app's own web client (the shared crate's net::client:
// its DNS over HTTPS, its cookies, its name).
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use kt_core::updatelogic as logic;
use kt_core::videotools as vt;
use kurokawa_shell::{net, util};

/// A fetched file: where it is, its size and SHA-256 (hex).
pub struct Fetched {
    pub path: PathBuf,
    pub size: u64,
    pub sha256: String,
}

async fn pause(ms: u64, cancel: &AtomicBool) -> bool {
    let until = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < until {
        if cancel.load(Ordering::SeqCst) {
            return false;
        }
        let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(100))).await;
    }
    !cancel.load(Ordering::SeqCst)
}

/// The SHA-256 of a whole file (hex).
pub fn sha256_file(p: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(util::hex(h.finalize().as_slice()))
}

/// A small text (a checksum list, a release's JSON): GET → its body; Err «HTTP <status>» or the network's error.
pub async fn text(url: &str, accept: Option<&str>) -> Result<String, String> {
    let c = net::client()?;
    let mut req = c.get(url).timeout(Duration::from_secs(60));
    if let Some(a) = accept {
        req = req.header("accept", a);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let st = resp.status().as_u16();
    if !(200..300).contains(&st) {
        return Err(format!("HTTP {}", st));
    }
    let b = resp.bytes().await.map_err(|e| e.to_string())?;
    if b.len() > 8 << 20 {
        return Err("answer too large".to_string());
    }
    Ok(String::from_utf8_lossy(&b).into_owned())
}

/// `url` fetched into `part` (a `.part` file, removed first unless `keep` says it is this address's to resume).
/// `on_progress(done, total)` after each piece; `cancel` checked between pieces → Err("cancelled").
pub async fn fetch<F: FnMut(u64, u64)>(url: &str, part: &Path, cancel: &AtomicBool, mut on_progress: F) -> Result<Fetched, String> {
    if let Some(d) = part.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_file(part);
    let client = net::client()?;
    let mut last_error = String::new();
    // (The digest as the bytes come; after a resume the file is read whole again.)
    let mut hasher: Option<Sha256>;
    for attempt in 0..6u32 {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".to_string());
        }
        if attempt > 0 && !pause(vt::retry_pause_ms(attempt), cancel).await {
            return Err("cancelled".to_string());
        }
        let mut have = std::fs::metadata(part).map(|m| m.len()).unwrap_or(0);
        let mut req = client.get(url);
        if let Some(r) = logic::range_header(have) {
            req = req.header("range", r);
        }
        let mut resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                last_error = e.to_string();
                continue;
            }
        };
        let status = resp.status().as_u16();
        let cr = resp.headers().get("content-range").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
        let len = resp.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|s| s.trim().parse::<u64>().ok());
        let mut out = match logic::on_response(status, have, cr.as_deref()) {
            logic::Resume::Fail(s) => {
                let m = format!("HTTP {}", s);
                if vt::final_error(&m) {
                    let _ = std::fs::remove_file(part);
                    return Err(m);
                }
                last_error = m;
                continue;
            }
            logic::Resume::Done => {
                // (416 «nothing more»: what is kept is whole.)
                let sha = sha256_file(part)?;
                return Ok(Fetched { path: part.to_path_buf(), size: have, sha256: sha });
            }
            logic::Resume::Append => {
                hasher = None;
                std::fs::OpenOptions::new().append(true).open(part).map_err(|e| e.to_string())?
            }
            logic::Resume::Restart => {
                have = 0;
                hasher = Some(Sha256::new());
                std::fs::File::create(part).map_err(|e| e.to_string())?
            }
        };
        let total = logic::total_of(have, cr.as_deref(), len).unwrap_or(0);
        let mut got = have;
        let mut broke = false;
        loop {
            if cancel.load(Ordering::SeqCst) {
                drop(out);
                let _ = std::fs::remove_file(part);
                return Err("cancelled".to_string());
            }
            match resp.chunk().await {
                Ok(Some(bytes)) => {
                    out.write_all(&bytes).map_err(|e| e.to_string())?;
                    if let Some(h) = hasher.as_mut() {
                        h.update(&bytes);
                    }
                    got += bytes.len() as u64;
                    on_progress(got, total);
                }
                Ok(None) => break,
                Err(e) => {
                    last_error = e.to_string();
                    broke = true;
                    break;
                }
            }
        }
        out.flush().map_err(|e| e.to_string())?;
        drop(out);
        if broke || (total > 0 && got < total) {
            if last_error.is_empty() {
                last_error = "cut short".to_string();
            }
            continue;
        }
        on_progress(got, total);
        let sha = match hasher.take() {
            Some(h) => util::hex(h.finalize().as_slice()),
            None => sha256_file(part)?,
        };
        return Ok(Fetched { path: part.to_path_buf(), size: got, sha256: sha });
    }
    let _ = std::fs::remove_file(part);
    Err(if last_error.is_empty() { "download failed".to_string() } else { last_error })
}
