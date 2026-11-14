// Archives (stage P7): desktop/main.cjs's kt:archive* channels as Tauri commands, over the shared crate's archive.rs
// (kurokawa_shell::archive — std only, the port of desktop/archive.cjs both apps' shells use; the Reader's archives.rs
// is this file's model). Here: the raw-deflate codec (flate2, pure Rust), the 7-Zip program the app ships (7zip-bin's
// 7za, bundled as resources/7zip/<plat>/<arch>/7za[.exe] — tauri.conf.json's bundle.resources, filled in CI from the
// npm package 7zip-bin that desktop/package.json names; then the PATH, as archive.cjs falls back to «7z»), the jobs
// that can be cancelled, and their progress as the kt:archiveProgress event ({ id, done, total, file }, at most every
// 250 ms and at the end — main.cjs's throttle). Tools' own parts of archive.cjs are switched on here: split volumes to
// 7-Zip, entry dates (local time: the offset set at start), a partial extraction (`only`), «cache:» as the
// destination (the system's temp folder's kurokawa-archive-view, as main.cjs). Every job runs on a blocking thread.
// Passwords go to 7-Zip as its -p switch (as main.cjs passes them) and are never logged or kept.
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use kurokawa_shell::archive::{self, Codec, Ctx, ExtractOpts, Pr};
use kurokawa_shell::{shell, util};

/// Raw deflate by flate2 (miniz_oxide, pure Rust).
struct Flate;
impl Codec for Flate {
    fn inflate(&self, src: &mut dyn Read, dst: &mut dyn Write) -> io::Result<u64> {
        let mut d = flate2::read::DeflateDecoder::new(src);
        io::copy(&mut d, dst)
    }
    fn deflate(&self, src: &mut dyn Read, dst: &mut dyn Write) -> io::Result<u64> {
        let mut e = flate2::write::DeflateEncoder::new(dst, flate2::Compression::new(6));
        let n = io::copy(src, &mut e)?;
        e.finish()?;
        Ok(n)
    }
}

fn free_of(p: &Path) -> u64 {
    crate::filecmds::free_space(p)
}

/* ---------- the local clock (entry dates are local times) ---------- */

/// Seconds east of UTC now (localtime_r's tm_gmtoff on Linux and macOS; GetTimeZoneInformation's bias on Windows); 0
/// when unknown.
#[cfg(unix)]
pub fn local_offset() -> i64 {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let r = unsafe { libc::localtime_r(&now, &mut tm) };
    if r.is_null() {
        return 0;
    }
    let off = tm.tm_gmtoff as i64;
    if off.abs() > 18 * 3600 {
        0
    } else {
        off
    }
}

#[cfg(windows)]
pub fn local_offset() -> i64 {
    #[repr(C)]
    #[allow(dead_code)]
    struct SystemTime {
        w: [u16; 8],
    }
    #[repr(C)]
    #[allow(non_snake_case, dead_code)]
    struct TimeZoneInformation {
        Bias: i32,
        StandardName: [u16; 32],
        StandardDate: SystemTime,
        StandardBias: i32,
        DaylightName: [u16; 32],
        DaylightDate: SystemTime,
        DaylightBias: i32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetTimeZoneInformation(tz: *mut TimeZoneInformation) -> u32;
    }
    let mut tz: TimeZoneInformation = unsafe { std::mem::zeroed() };
    let r = unsafe { GetTimeZoneInformation(&mut tz) };
    // (UTC = local + bias, in minutes; 2: daylight time now, 1: standard, 0: no daylight time there.)
    let bias = match r {
        2 => tz.Bias + tz.DaylightBias,
        1 => tz.Bias + tz.StandardBias,
        0 => tz.Bias,
        _ => return 0,
    };
    -(bias as i64) * 60
}

#[cfg(not(any(unix, windows)))]
pub fn local_offset() -> i64 {
    0
}

/* ---------- the 7-Zip program ---------- */

static RES: OnceLock<Vec<PathBuf>> = OnceLock::new();

/// Where the shipped 7-Zip may be: the app's resource folder, then the executable's own (a bare build in CI, where
/// Tauri's build copies the resources beside the program); Tools' parts of the shared archive code switched on.
/// Called once in setup.
pub fn init(app: &AppHandle) {
    let mut v: Vec<PathBuf> = Vec::new();
    if let Ok(r) = app.path().resource_dir() {
        v.push(r);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            v.push(d.to_path_buf());
        }
    }
    let _ = RES.set(v);
    archive::route_split_volumes(true);
    archive::set_local_offset(local_offset());
}

/// The 7-Zip to run → (its path, whether it is the app's own).
pub fn seven() -> Option<(PathBuf, bool)> {
    let rel = archive::seven_rel(util::node_platform(), util::node_arch());
    if let Some(dirs) = RES.get() {
        for r in dirs.iter() {
            for p in [r.join("7zip").join(&rel), r.join("7zip").join(rel.file_name().unwrap_or_default())] {
                if p.is_file() {
                    archive::ensure_exec(&p);
                    return Some((p, true));
                }
            }
        }
    }
    let names: &[&str] = if cfg!(windows) { &["7za.exe", "7z.exe"] } else { &["7za", "7z", "7zz"] };
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for n in names {
            let p = dir.join(n);
            if p.is_file() {
                return Some((p, false));
            }
        }
    }
    None
}

fn ctx() -> Ctx<'static> {
    Ctx { codec: &Flate, seven: seven().map(|x| x.0), free: &free_of }
}

/* ---------- jobs ---------- */

fn jobs() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static J: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    J.get_or_init(|| Mutex::new(HashMap::new()))
}
/// A job's stop flag, registered before its work starts (a Cancel that comes at once finds it); one asked to stop
/// before it was registered (its id cancelled first) starts stopped.
fn job(id: &Option<String>) -> Arc<AtomicBool> {
    let stop = Arc::new(AtomicBool::new(false));
    if let Some(i) = id {
        if take_early(i) {
            stop.store(true, Ordering::SeqCst);
        }
        if let Ok(mut m) = jobs().lock() {
            m.insert(i.clone(), stop.clone());
        }
    }
    stop
}
fn end_job(id: &Option<String>) {
    if let Some(i) = id {
        if let Ok(mut m) = jobs().lock() {
            m.remove(i);
        }
    }
}
/// Cancels for ids no job had yet, kept a minute.
fn early() -> &'static Mutex<Vec<(String, Instant)>> {
    static E: OnceLock<Mutex<Vec<(String, Instant)>>> = OnceLock::new();
    E.get_or_init(|| Mutex::new(Vec::new()))
}
fn take_early(id: &str) -> bool {
    let mut g = match early().lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    g.retain(|(_, t)| t.elapsed() < Duration::from_secs(60));
    match g.iter().position(|(x, _)| x == id) {
        Some(i) => {
            g.remove(i);
            true
        }
        None => false,
    }
}

/// The job's progress to the page: { id, done, total, file }, at most every 250 ms, and always at the end.
fn emitter(app: AppHandle, id: Option<String>) -> impl Fn(u64, u64, &str) {
    let last: Mutex<Option<Instant>> = Mutex::new(None);
    move |done: u64, total: u64, file: &str| {
        let now = Instant::now();
        if let Ok(mut l) = last.lock() {
            if let Some(t) = *l {
                if now.duration_since(t) < Duration::from_millis(250) && done < total {
                    return;
                }
            }
            *l = Some(now);
        }
        let _ = app.emit("kt:archiveProgress", json!({ "id": id, "done": done, "total": total, "file": file }));
    }
}

fn s(o: &Value, k: &str) -> String {
    shell::text_of(o, k)
}
fn opt_s(o: &Value, k: &str) -> Option<String> {
    o.get(k).and_then(|v| v.as_str()).map(|x| x.to_string()).filter(|x| !x.is_empty())
}
fn id_of(o: &Value) -> Option<String> {
    match o.get("id") {
        Some(Value::String(x)) => Some(x.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}
fn parent_of(p: &str) -> String {
    Path::new(p).parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default()
}
fn strings(o: &Value, k: &str) -> Option<Vec<String>> {
    o.get(k).and_then(|v| v.as_array()).map(|a| a.iter().map(|x| x.as_str().map(|y| y.to_string()).unwrap_or_else(|| x.to_string())).collect())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(r) => r,
        Err(e) => Err(e.to_string()),
    }
}

/// The page's ArchiveInfo: { format, entries: [{ path, size, compressed?, dir, mtime? }], total, encrypted, inPlaceOk,
/// resumable, largest, free, unsafe?, duplicate?, sfv? } — archive.cjs's list.
pub fn info_value(i: &archive::ListInfo) -> Value {
    let entries: Vec<Value> = i
        .entries
        .iter()
        .map(|e| {
            let mut v = json!({ "path": e.path, "size": e.size, "dir": e.dir });
            if let Some(c) = e.compressed {
                v["compressed"] = json!(c);
            }
            if let Some(m) = e.mtime {
                v["mtime"] = json!(m);
            }
            v
        })
        .collect();
    let mut v = json!({
        "format": i.format,
        "entries": entries,
        "total": i.total,
        "encrypted": i.encrypted,
        "inPlaceOk": i.in_place_ok,
        "resumable": i.resumable,
        "largest": i.largest,
        "free": i.free,
    });
    if let Some(u) = &i.unsafe_path {
        v["unsafe"] = json!(u);
    }
    if let Some(d) = &i.duplicate {
        v["duplicate"] = json!(d);
    }
    if let Some(f) = &i.sfv {
        v["sfv"] = json!(f);
    }
    v
}

/// Where «cache:» extracts to: main.cjs's <temp>/kurokawa-archive-view.
fn cache_dir() -> PathBuf {
    std::env::temp_dir().join("kurokawa-archive-view")
}

/* ---------- the commands (main.cjs's kt:archive*) ---------- */

/// kt:archiveList({ path, password? }) → the ArchiveInfo (a locked 7z without its password: «passwordNeeded», with a
/// wrong one «wrongPassword» — both say «password», which the page asks for again).
#[tauri::command]
pub async fn kt_archive_list(o: Value) -> Result<Value, String> {
    let path = s(&o, "path");
    let password = opt_s(&o, "password");
    blocking(move || archive::list(Path::new(&path), password.as_deref(), &ctx()).map(|i| info_value(&i))).await
}

/// kt:archiveExtract({ id?, path, dest? («cache:» the temp folder's), only?, inPlace?, deleteAfter?, replace?, password?,
/// verifyFirst?, keepFree? }) → { files, dest }; progress as kt:archiveProgress; «stopped» when cancelled.
#[tauri::command]
pub async fn kt_archive_extract(app: AppHandle, o: Value) -> Result<Value, String> {
    let id = id_of(&o);
    let path = s(&o, "path");
    let dest = match opt_s(&o, "dest") {
        Some(d) if d == "cache:" => cache_dir().to_string_lossy().into_owned(),
        Some(d) => d,
        None => parent_of(&path),
    };
    let only = strings(&o, "only");
    let opts = ExtractOpts {
        in_place: o.get("inPlace").and_then(|v| v.as_bool()).unwrap_or(false) && only.is_none(),
        delete_after: o.get("deleteAfter").and_then(|v| v.as_bool()).unwrap_or(false),
        replace: opt_s(&o, "replace").unwrap_or_else(|| "replace".to_string()),
        password: opt_s(&o, "password"),
        verify_first: o.get("verifyFirst").and_then(|v| v.as_bool()).unwrap_or(false),
        keep_free: o.get("keepFree").and_then(|v| v.as_f64()).filter(|x| *x >= 0.0).map(|x| x as u64),
        only,
    };
    let stop = job(&id);
    let on = emitter(app, id.clone());
    let d2 = dest.clone();
    let r = blocking(move || {
        let pr = Pr { on: &on, stop: &stop };
        archive::extract(Path::new(&path), Path::new(&d2), &opts, &ctx(), &pr)
    })
    .await;
    end_job(&id);
    let files = r?;
    Ok(json!({ "files": files, "dest": dest }))
}

/// kt:archiveTest({ id?, path, password? }) → { ok, files, bad }.
#[tauri::command]
pub async fn kt_archive_test(app: AppHandle, o: Value) -> Result<Value, String> {
    let id = id_of(&o);
    let path = s(&o, "path");
    let password = opt_s(&o, "password");
    let stop = job(&id);
    let on = emitter(app, id.clone());
    let r = blocking(move || {
        let pr = Pr { on: &on, stop: &stop };
        archive::test(Path::new(&path), password.as_deref(), &ctx(), &pr)
    })
    .await;
    end_job(&id);
    let t = r?;
    Ok(json!({ "ok": t.ok, "files": t.files, "bad": t.bad }))
}

/// kt:archiveRestore({ path }) → { left } (-1 for a tar).
#[tauri::command]
pub async fn kt_archive_restore(o: Value) -> Result<Value, String> {
    let path = s(&o, "path");
    let left = blocking(move || archive::restore(Path::new(&path))).await?;
    Ok(json!({ "left": left }))
}

/// kt:archiveExisting({ dest, names }) → { existing } (the names already there as files; one that would leave the
/// folder is not counted).
#[tauri::command]
pub async fn kt_archive_existing(o: Value) -> Result<Value, String> {
    let dest = s(&o, "dest");
    let names = strings(&o, "names").unwrap_or_default();
    let ex = blocking(move || Ok(archive::existing(Path::new(&dest), &names))).await?;
    Ok(json!({ "existing": ex }))
}

/// kt:archiveCancel(id): the job with that id told to stop (it then rejects with «stopped»); an id with no job yet
/// is kept a minute for the job that starts under it.
#[tauri::command]
pub async fn kt_archive_cancel(id: String) -> Result<(), String> {
    let found = match jobs().lock() {
        Ok(m) => m.get(&id).map(|flag| flag.store(true, Ordering::SeqCst)).is_some(),
        Err(_) => false,
    };
    if !found && !id.is_empty() {
        if let Ok(mut g) = early().lock() {
            g.retain(|(_, t)| t.elapsed() < Duration::from_secs(60));
            g.push((id, Instant::now()));
        }
    }
    Ok(())
}

/// kt:archiveCreate({ id?, out, inputs }) → { files, path, size } (a zip: stored for what gains nothing by squeezing,
/// deflate otherwise; written beside as «.part» and put in place when whole).
#[tauri::command]
pub async fn kt_archive_create(app: AppHandle, o: Value) -> Result<Value, String> {
    let id = id_of(&o);
    let out = s(&o, "out");
    let inputs: Vec<PathBuf> = strings(&o, "inputs").unwrap_or_default().into_iter().map(PathBuf::from).collect();
    let stop = job(&id);
    let on = emitter(app, id.clone());
    let out2 = out.clone();
    let r = blocking(move || {
        let pr = Pr { on: &on, stop: &stop };
        let n = archive::create_zip(Path::new(&out2), &inputs, &ctx(), &pr)?;
        let size = std::fs::metadata(&out2).map(|m| m.len()).map_err(|e| e.to_string())?;
        Ok((n, size))
    })
    .await;
    end_job(&id);
    let (files, size) = r?;
    Ok(json!({ "files": files, "path": out, "size": size }))
}

/* ---------- the self-test's own (KT_SELFTEST runs only) ---------- */

/// The 7-Zip this build runs, run with `args` — the test makes its 7z and tar archives with it → { path, own, code };
/// `args` empty: where it is only.
#[tauri::command]
pub async fn kt_selftest_7z(args: Vec<String>) -> Result<Value, String> {
    if !kurokawa_shell::selftest::active() {
        return Err("not a self-test run".to_string());
    }
    let (path, own) = match seven() {
        Some(x) => x,
        None => return Ok(json!({ "path": Value::Null, "own": false })),
    };
    if args.is_empty() {
        return Ok(json!({ "path": path.to_string_lossy().into_owned(), "own": own }));
    }
    let p2 = path.clone();
    let r = blocking(move || archive::run7z(&p2, &args, None, Some(Duration::from_secs(120)), &mut |_l: &str| {})).await?;
    Ok(json!({ "path": path.to_string_lossy().into_owned(), "own": own, "code": r.code }))
}

/// Bytes written to a path (its folder made) — the test's files and its hostile zip.
#[tauri::command]
pub async fn kt_selftest_write(p: String, b64: String) -> Result<bool, String> {
    if !kurokawa_shell::selftest::active() {
        return Err("not a self-test run".to_string());
    }
    blocking(move || {
        let path = PathBuf::from(&p);
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, util::b64_decode(&b64)).map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
}
