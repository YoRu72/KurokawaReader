// Archives (stage R5): desktop/main.cjs's kr:archive-* channels as Tauri commands, over archive.rs (std only — the
// port of desktop/archive.cjs; in the shared crate since Tools' stage P7, shared/shell-rs/src/archive.rs, unchanged for
// the Reader: what Tools added there is off unless asked). Here: the raw-deflate codec (flate2, pure Rust), the free space of a disk (the OS's
// own call), the 7-Zip program the app ships (7zip-bin's 7za, bundled as resources/7zip/<plat>/<arch>/7za[.exe] —
// tauri.conf.json's bundle.resources, filled in CI from desktop/node_modules/7zip-bin; then the PATH, as archive.cjs
// falls back to «7z»), the jobs that can be cancelled, and their progress as the kr:archive-progress event
// ({ id, done, total, file }, at most every 250 ms and at the end — main.cjs's throttle). Every job runs on a
// blocking thread. Passwords go to 7-Zip as its -p switch (as main.cjs passes them) and are never logged or kept.
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use kurokawa_shell::{shell, util};

use kurokawa_shell::archive::{self, Codec, Ctx, ExtractOpts, Pr, MAX_SAFE};

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

/* ---------- free space ---------- */

/// Bytes free for this user on the disk holding `p` (Node's statfs bavail × bsize); MAX_SAFE when unknown.
#[cfg(unix)]
pub fn free_space(p: &Path) -> u64 {
    use std::os::unix::ffi::OsStrExt;
    let c = match std::ffi::CString::new(p.as_os_str().as_bytes()) {
        Ok(c) => c,
        Err(_) => return MAX_SAFE,
    };
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    let r = unsafe { libc::statvfs(c.as_ptr(), &mut st) };
    if r != 0 {
        return MAX_SAFE;
    }
    (st.f_bavail as u64).saturating_mul(st.f_frsize as u64)
}

#[cfg(windows)]
pub fn free_space(p: &Path) -> u64 {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(dir: *const u16, avail: *mut u64, total: *mut u64, free: *mut u64) -> i32;
    }
    let w: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut avail: u64 = 0;
    let mut total: u64 = 0;
    let mut free: u64 = 0;
    let ok = unsafe { GetDiskFreeSpaceExW(w.as_ptr(), &mut avail, &mut total, &mut free) };
    if ok != 0 {
        avail
    } else {
        MAX_SAFE
    }
}

#[cfg(not(any(unix, windows)))]
pub fn free_space(_p: &Path) -> u64 {
    MAX_SAFE
}

fn free_of(p: &Path) -> u64 {
    free_space(p)
}

/* ---------- the 7-Zip program ---------- */

static RES: OnceLock<Vec<PathBuf>> = OnceLock::new();

/// Where the shipped 7-Zip may be: the app's resource folder, then the executable's own (a bare build in CI, where
/// Tauri's build copies the resources beside the program). Called once in setup.
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
fn job(id: &Option<String>) -> Arc<AtomicBool> {
    let stop = Arc::new(AtomicBool::new(false));
    if let Some(i) = id {
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
        let _ = app.emit("kr:archive-progress", json!({ "id": id, "done": done, "total": total, "file": file }));
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

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(r) => r,
        Err(e) => Err(e.to_string()),
    }
}

fn info_value(i: &archive::ListInfo) -> Value {
    let entries: Vec<Value> = i
        .entries
        .iter()
        .map(|e| {
            let mut v = json!({ "path": e.path, "size": e.size, "dir": e.dir });
            if let Some(c) = e.compressed {
                v["compressed"] = json!(c);
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

/* ---------- the commands (main.cjs's kr:archive-*) ---------- */

/// kr:archive-list({ path, password? }) → { format, entries: [{ path, size, compressed?, dir }], total, encrypted,
/// inPlaceOk, resumable, largest, free, unsafe?, duplicate?, sfv? }.
#[tauri::command]
pub async fn kr_archive_list(o: Value) -> Result<Value, String> {
    let path = s(&o, "path");
    let password = opt_s(&o, "password");
    blocking(move || archive::list(Path::new(&path), password.as_deref(), &ctx()).map(|i| info_value(&i))).await
}

/// kr:archive-extract({ id?, path, dest?, inPlace?, deleteAfter?, replace?, password?, verifyFirst?, keepFree? }) →
/// { files, dest } (dest: the archive's folder when none is given); progress as kr:archive-progress.
#[tauri::command]
pub async fn kr_archive_extract(app: AppHandle, o: Value) -> Result<Value, String> {
    let id = id_of(&o);
    let path = s(&o, "path");
    let dest = opt_s(&o, "dest").unwrap_or_else(|| parent_of(&path));
    let opts = ExtractOpts {
        in_place: o.get("inPlace").and_then(|v| v.as_bool()).unwrap_or(false),
        delete_after: o.get("deleteAfter").and_then(|v| v.as_bool()).unwrap_or(false),
        replace: opt_s(&o, "replace").unwrap_or_else(|| "replace".to_string()),
        password: opt_s(&o, "password"),
        verify_first: o.get("verifyFirst").and_then(|v| v.as_bool()).unwrap_or(false),
        keep_free: o.get("keepFree").and_then(|v| v.as_f64()).filter(|x| *x >= 0.0).map(|x| x as u64),
        // (Tools' partial extraction; the Reader extracts whole archives.)
        only: None,
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

/// kr:archive-test({ id?, path, password? }) → { ok, files, bad }.
#[tauri::command]
pub async fn kr_archive_test(app: AppHandle, o: Value) -> Result<Value, String> {
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

/// kr:archive-restore({ path }) → { left } (-1 for a tar).
#[tauri::command]
pub async fn kr_archive_restore(o: Value) -> Result<Value, String> {
    let path = s(&o, "path");
    let left = blocking(move || archive::restore(Path::new(&path))).await?;
    Ok(json!({ "left": left }))
}

/// kr:archive-free({ dir }) → { free } (the nearest existing folder's disk).
#[tauri::command]
pub async fn kr_archive_free(o: Value) -> Result<Value, String> {
    let dir = s(&o, "dir");
    let free = blocking(move || Ok(free_space(&archive::existing_parent(Path::new(&dir))))).await?;
    Ok(json!({ "free": free }))
}

/// kr:archive-existing({ dest, names }) → { existing } (the names already there as files).
#[tauri::command]
pub async fn kr_archive_existing(o: Value) -> Result<Value, String> {
    let dest = s(&o, "dest");
    let names: Vec<String> = o
        .get("names")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().map(|x| x.as_str().map(|y| y.to_string()).unwrap_or_else(|| x.to_string())).collect())
        .unwrap_or_default();
    let ex = blocking(move || Ok(archive::existing(Path::new(&dest), &names))).await?;
    Ok(json!({ "existing": ex }))
}

/// kr:archive-cancel(id): the job with that id told to stop (it then rejects with «stopped»).
#[tauri::command]
pub async fn kr_archive_cancel(id: String) -> Result<(), String> {
    if let Ok(m) = jobs().lock() {
        if let Some(flag) = m.get(&id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
    Ok(())
}

/// kr:archive-create({ id?, out, inputs }) → { files, path, size }.
#[tauri::command]
pub async fn kr_archive_create(app: AppHandle, o: Value) -> Result<Value, String> {
    let id = id_of(&o);
    let out = s(&o, "out");
    let inputs: Vec<PathBuf> = o
        .get("inputs")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).map(PathBuf::from).collect())
        .unwrap_or_default();
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

/// (Self-test only.) The 7-Zip this build runs, run with `args` — the test makes its 7z and tar archives with it →
/// { path, own, code, out, err }; `args` empty: where it is only.
#[tauri::command]
pub async fn kr_selftest_7z(args: Vec<String>) -> Result<Value, String> {
    if !kurokawa_shell::selftest::active() {
        return Err("not a self-test run".to_string());
    }
    let found = seven();
    let (path, own) = match found {
        Some(x) => x,
        None => return Ok(json!({ "path": Value::Null, "own": false })),
    };
    if args.is_empty() {
        return Ok(json!({ "path": path.to_string_lossy().into_owned(), "own": own }));
    }
    let p2 = path.clone();
    let r = blocking(move || archive::run7z(&p2, &args, None, Some(Duration::from_secs(120)), &mut |_l: &str| {})).await?;
    Ok(json!({ "path": path.to_string_lossy().into_owned(), "own": own, "code": r.code, "out": r.out, "err": r.err }))
}
