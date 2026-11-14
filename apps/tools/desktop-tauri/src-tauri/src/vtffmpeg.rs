// Stage P5: ffmpeg and its pack on the Tauri shell — desktop/ffmpeg.cjs and desktop/packs.cjs, channel for channel:
// kt:ffmpegAvailable, kt:ffmpeg (progress from `-progress pipe:1` as kt:ffmpegProgress, at most every 300 ms and at the
// end), kt:ffmpegCancel, kt:ffprobe, kt:packStatus, kt:packInstall (progress as kt:packProgress), kt:packCancel,
// kt:packRemove.
// - Which ffmpeg: the pack's (<app data>/packs/ffmpeg/ffmpeg[.exe]), else one on the PATH (on a Mac also Homebrew's,
//   which a program started from the Finder is not given on its PATH); with none, a run answers «pack:ffmpeg» so the
//   page offers the pack. (Electron's third place, ffmpeg-static inside a source checkout, has no counterpart.)
//   ffprobe: beside that ffmpeg, else the PATH's.
// - The pack: the gzipped program the page names (url, sha256, version — from this version's release), fetched with
//   resume (vtfetch.rs), its SHA-256 checked, unpacked beside a marker holding its version.
// - Cancel: ffmpeg asked to stop (SIGINT, so it closes its file), and 3 s later the whole tree ended (Windows: the tree
//   at once — it has no such signal). Electron killed the process alone.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};

use kt_core::videotools as vt;
use kurokawa_shell::util;

use crate::vtools::{blocking, dirs};
use crate::{vtfetch, vtproc};

fn os() -> &'static str {
    util::node_platform()
}
fn lossy(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

pub fn pack_dir() -> PathBuf {
    dirs().packs.join("ffmpeg")
}
/// The pack's program (whether or not it is there).
pub fn pack_ffmpeg() -> PathBuf {
    pack_dir().join(vt::ffmpeg_file(os()))
}

/// ffmpeg.cjs binary().
pub fn binary() -> PathBuf {
    let p = pack_ffmpeg();
    // (A self-test run runs only the pack's stand-in, never an ffmpeg of the machine's.)
    if p.is_file() || crate::vtools::selftest_run() {
        return p;
    }
    if let Some(p) = vtproc::find_on_path("ffmpeg") {
        return p;
    }
    if cfg!(target_os = "macos") {
        for d in ["/opt/homebrew/bin", "/usr/local/bin"] {
            let p = Path::new(d).join("ffmpeg");
            if p.is_file() {
                return p;
            }
        }
    }
    PathBuf::from(vt::ffmpeg_file(os()))
}
/// ffmpeg.cjs probeBinary(): ffprobe beside ffmpeg, else the PATH's.
pub fn probe_binary() -> PathBuf {
    let b = binary();
    if let Some(d) = b.parent().filter(|d| !d.as_os_str().is_empty()) {
        let p = d.join(vt::ffprobe_file(os()));
        if p.is_file() {
            return p;
        }
    }
    if crate::vtools::selftest_run() {
        return pack_dir().join(vt::ffprobe_file(os()));
    }
    vtproc::find_on_path("ffprobe").unwrap_or_else(|| PathBuf::from(vt::ffprobe_file(os())))
}

/// ffmpeg.cjs available(): { ok, path, version } or { ok: false, why }.
pub fn available() -> Value {
    let b = binary();
    match vtproc::run(&b, &["-version".to_string()], Duration::from_secs(8), 1 << 20) {
        Ok(r) if r.code == Some(0) && !r.timed_out => {
            let out = String::from_utf8_lossy(&r.out).into_owned();
            json!({ "ok": true, "path": lossy(&b), "version": out.split('\n').next().unwrap_or("").trim_end_matches('\r') })
        }
        Ok(r) => json!({ "ok": false, "why": if r.timed_out { "timed out".to_string() } else { format!("Command failed: {} -version\n{}", lossy(&b), r.err.trim()) } }),
        Err(e) => json!({ "ok": false, "why": if e.starts_with("ENOENT") { format!("spawn {} ENOENT", lossy(&b)) } else { e } }),
    }
}

/* ---------- runs ---------- */

static JOBS: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

fn jobs_put(id: &str, pid: Option<u32>) {
    if let Ok(mut g) = JOBS.lock() {
        let m = g.get_or_insert_with(HashMap::new);
        match pid {
            Some(p) => {
                m.insert(id.to_string(), p);
            }
            None => {
                m.remove(id);
            }
        }
    }
}
fn job_pid(id: &str) -> Option<u32> {
    JOBS.lock().ok().and_then(|g| g.as_ref().and_then(|m| m.get(id).copied()))
}

/// ffmpeg.cjs run(id, args, onProgress) → { code, log } (blocking).
pub fn run<F: FnMut(Value) + Send + 'static>(id: &str, args: &[String], mut on_progress: F) -> Value {
    let mut rd = vt::FfReader::default();
    let lines = vtproc::spawn_lines(&binary(), args, 200_000, move |l| {
        if let Some((p, done)) = rd.line(l) {
            let mut m = Map::new();
            if let Some(t) = p.time {
                m.insert("time".into(), json!(t));
            }
            if let Some(s) = p.size {
                m.insert("size".into(), json!(s));
            }
            if let Some(s) = p.speed {
                m.insert("speed".into(), json!(s));
            }
            m.insert("done".into(), json!(done));
            on_progress(Value::Object(m));
        }
    });
    let p = match lines {
        Ok(p) => p,
        Err(e) => return json!({ "code": 127, "log": if e.starts_with("ENOENT") { "pack:ffmpeg".to_string() } else { e } }),
    };
    jobs_put(id, Some(p.pid));
    let (code, log) = p.wait();
    jobs_put(id, None);
    json!({ "code": code.unwrap_or(1), "log": log })
}

/// ffmpeg.cjs cancel(id).
pub fn cancel(id: &str) {
    if let Some(pid) = job_pid(id) {
        vtproc::interrupt(pid);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            vtproc::kill_tree(pid);
        });
    }
}

/// ffmpeg.cjs probe(file): ffprobe's JSON (streams, format, chapters), or null.
pub fn probe(file: &str) -> Value {
    let args: Vec<String> = ["-v", "error", "-show_streams", "-show_format", "-show_chapters", "-of", "json", file].iter().map(|s| s.to_string()).collect();
    match vtproc::run(&probe_binary(), &args, Duration::from_secs(120), 20 << 20) {
        Ok(r) if r.code == Some(0) && !r.timed_out => serde_json::from_slice(&r.out).unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

/* ---------- the pack ---------- */

static PACK_JOBS: Mutex<Option<HashMap<String, Arc<AtomicBool>>>> = Mutex::new(None);

fn marker() -> PathBuf {
    pack_dir().join(vt::PACK_MARKER)
}
/// packs.cjs installed('ffmpeg'): the marker's version when the program is there.
pub fn installed() -> Option<String> {
    if !pack_ffmpeg().exists() {
        return None;
    }
    std::fs::read_to_string(marker()).ok().map(|t| t.trim().to_string())
}
/// packs.cjs status().
pub fn status() -> Value {
    let v = installed();
    let size = if v.is_some() { std::fs::metadata(pack_ffmpeg()).map(|m| m.len()).unwrap_or(0) } else { 0 };
    json!({ "ffmpeg": { "version": v, "size": size }, "python": { "version": null, "size": 0 }, "platform": util::node_platform(), "arch": util::node_arch() })
}

fn text(o: &Value, k: &str) -> String {
    match o.get(k) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(v) => v.to_string(),
    }
}

/// packs.cjs install({ name, url, sha256, version }, onProgress).
pub async fn install(app: &AppHandle, o: &Value) -> Result<(), String> {
    let name = text(o, "name");
    if name != "ffmpeg" {
        return Err(format!("pack {}", name));
    }
    let url = text(o, "url");
    let sha = text(o, "sha256").to_ascii_lowercase();
    let version = text(o, "version");
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut g) = PACK_JOBS.lock() {
        g.get_or_insert_with(HashMap::new).insert(name.clone(), flag.clone());
    }
    let d = pack_dir();
    let tmp = d.join("download.gz");
    let r = async {
        std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
        let mut last = Instant::now() - Duration::from_secs(1);
        let app2 = app.clone();
        let n2 = name.clone();
        let got = vtfetch::fetch(&url, &tmp, &flag, move |done, total| {
            if last.elapsed() >= Duration::from_millis(250) {
                last = Instant::now();
                let _ = app2.emit("kt:packProgress", json!({ "name": n2, "done": done, "total": total }));
            }
        })
        .await?;
        let _ = app.emit("kt:packProgress", json!({ "name": name, "done": got.size, "total": got.size }));
        if flag.load(Ordering::SeqCst) {
            return Err("cancelled".to_string());
        }
        if !sha.is_empty() && got.sha256 != sha {
            return Err("checksum".to_string());
        }
        let dest = pack_ffmpeg();
        let tmp2 = tmp.clone();
        let ver = if version.is_empty() { "1".to_string() } else { version.clone() };
        blocking(move || -> Result<(), String> {
            let part = PathBuf::from(format!("{}.part", lossy(&dest)));
            let f = std::fs::File::open(&tmp2).map_err(|e| e.to_string())?;
            let mut gz = flate2::read::GzDecoder::new(std::io::BufReader::new(f));
            let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
            if let Err(e) = std::io::copy(&mut gz, &mut out) {
                drop(out);
                let _ = std::fs::remove_file(&part);
                return Err(e.to_string());
            }
            drop(out);
            vtproc::make_executable(&part).map_err(|e| e.to_string())?;
            std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
            std::fs::write(marker(), ver).map_err(|e| e.to_string())?;
            Ok(())
        })
        .await??;
        Ok(())
    }
    .await;
    if let Ok(mut g) = PACK_JOBS.lock() {
        if let Some(m) = g.as_mut() {
            m.remove(&name);
        }
    }
    let _ = std::fs::remove_file(&tmp);
    r
}

/// packs.cjs cancel(name).
pub fn pack_cancel(name: &str) {
    if let Ok(g) = PACK_JOBS.lock() {
        if let Some(f) = g.as_ref().and_then(|m| m.get(name)) {
            f.store(true, Ordering::SeqCst);
        }
    }
}

/* ---------- the commands ---------- */

/// kt:ffmpegAvailable → { ok, path, version } | { ok: false, why }.
#[tauri::command]
pub async fn kt_ffmpeg_available() -> Result<Value, String> {
    blocking(available).await
}

/// kt:ffmpeg({ id, args }) → { code, log }; kt:ffmpegProgress { id, time, size, speed, done } meanwhile.
#[tauri::command]
pub async fn kt_ffmpeg(app: AppHandle, o: Value) -> Result<Value, String> {
    let id = text(&o, "id");
    let args: Vec<String> = match o.get("args") {
        Some(Value::Array(xs)) => xs.iter().map(|x| match x {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        }).collect(),
        _ => Vec::new(),
    };
    let id2 = id.clone();
    blocking(move || {
        let mut last = Instant::now() - Duration::from_secs(1);
        run(&id, &args, move |p| {
            let done = p.get("done").and_then(|d| d.as_bool()).unwrap_or(false);
            if last.elapsed() < Duration::from_millis(300) && !done {
                return;
            }
            last = Instant::now();
            let mut m = Map::new();
            m.insert("id".into(), json!(id2));
            if let Value::Object(x) = p {
                m.extend(x);
            }
            let _ = app.emit("kt:ffmpegProgress", Value::Object(m));
        })
    })
    .await
}

/// kt:ffmpegCancel(id).
#[tauri::command]
pub async fn kt_ffmpeg_cancel(id: String) -> Result<(), String> {
    blocking(move || cancel(&id)).await
}

/// kt:ffprobe(p) → ffprobe's JSON, or null.
#[tauri::command]
pub async fn kt_ffprobe(p: String) -> Result<Value, String> {
    blocking(move || probe(&p)).await
}

/// kt:packStatus → { ffmpeg: { version, size }, python: { version: null, size: 0 }, platform, arch }.
#[tauri::command]
pub async fn kt_pack_status() -> Result<Value, String> {
    Ok(status())
}

/// kt:packInstall({ name, url, sha256, version }); kt:packProgress { name, done, total } meanwhile.
#[tauri::command]
pub async fn kt_pack_install(app: AppHandle, o: Value) -> Result<(), String> {
    install(&app, &o).await
}

/// kt:packCancel(name).
#[tauri::command]
pub async fn kt_pack_cancel(n: String) -> Result<(), String> {
    pack_cancel(&n);
    Ok(())
}

/// kt:packRemove(name).
#[tauri::command]
pub async fn kt_pack_remove(n: String) -> Result<(), String> {
    let d = dirs().packs.join(&n);
    // (Only a pack's own folder: a name with a separator or «..» is no pack.)
    if n.is_empty() || n.contains(['/', '\\']) || n.contains("..") {
        return Ok(());
    }
    let _ = blocking(move || std::fs::remove_dir_all(&d)).await;
    Ok(())
}
