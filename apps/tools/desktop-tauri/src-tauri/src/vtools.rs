// Stage P5: yt-dlp and gallery-dl on the Tauri shell — desktop/ytdlp.cjs and desktop/gallerydl.cjs, channel for
// channel (kt:videoInfo, kt:videoReady, kt:videoVersion, kt:videoUpdate, kt:videoRollback, kt:videoBinary,
// kt:isVideoHost, kt:galleryList, kt:galleryReady), with kt-core's videotools.rs / vidjson.rs deciding.
// - The programs: fetched from their GitHub releases into <app data>/bin (yt-dlp checked against SHA2-256SUMS,
//   gallery-dl against the release's digest), resumed when a connection drops (vtfetch.rs); the yt-dlp in use kept as
//   yt-dlp.<version>.old (the newest three) before a new one replaces it; a new one that does not answer `--version` is
//   taken away and the one before put back at once (kt-core's Swap — Electron left that to Settings → Roll back, which
//   stays). A program of the user's own choosing (Settings → Video → path) runs instead when it exists.
// - Running: an argument list, never a shell; stdin closed; no window; the whole tree ended on cancel (vtproc.rs).
// - yt-dlp's JavaScript runtime: Electron gave its own Node; this shell has none, so the first of deno / node / bun on
//   the PATH is named (--js-runtimes), only to a yt-dlp that knows the option.
// The video jobs are vtjobs.rs; ffmpeg and the packs vtffmpeg.rs; the self-test's side vtselftest.rs.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use kt_core::videotools as vt;
use kt_core::vidjson;
use kurokawa_shell::util;

use crate::{vtfetch, vtproc};

/// Where the programs and the jobs' list live: <app data>/bin and <app data> — in a self-test run a folder of its own
/// in the temp folder, so a developer's own yt-dlp is never touched.
pub struct Dirs {
    pub bin: PathBuf,
    pub data: PathBuf,
    pub packs: PathBuf,
}
static DIRS: OnceLock<Dirs> = OnceLock::new();

/// The release addresses (the self-test points them at its loopback server).
#[derive(Clone)]
pub struct Urls {
    /// yt-dlp's «latest/download» folder (SHA2-256SUMS and the program beside it).
    pub yt_dl: String,
    /// yt-dlp's newest release (its tag).
    pub yt_api: String,
    /// gallery-dl's newest release (its assets).
    pub gdl_api: String,
}
static URLS: Mutex<Option<Urls>> = Mutex::new(None);

fn real_urls() -> Urls {
    Urls {
        yt_dl: "https://github.com/yt-dlp/yt-dlp/releases/latest/download".to_string(),
        yt_api: "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest".to_string(),
        gdl_api: "https://api.github.com/repos/mikf/gallery-dl/releases/latest".to_string(),
    }
}
pub fn urls() -> Urls {
    match URLS.lock().ok().and_then(|g| g.clone()) {
        Some(u) => u,
        // (A self-test run never reaches GitHub, even before its own server is set up.)
        None if selftest_run() => Urls { yt_dl: "http://127.0.0.1:9/none".into(), yt_api: "http://127.0.0.1:9/none".into(), gdl_api: "http://127.0.0.1:9/none".into() },
        None => real_urls(),
    }
}
pub fn set_urls(u: Urls) {
    if let Ok(mut g) = URLS.lock() {
        *g = Some(u);
    }
}

/// Whether this run is the self-test (KT_SELFTEST set).
pub fn selftest_run() -> bool {
    kurokawa_shell::selftest::out_path("KT").is_some()
}

/// Called once at start (main.rs setup).
pub fn init(app: &AppHandle) {
    let data = if selftest_run() {
        // (The stand-ins answer only to programs this run starts — vtfake.rs.)
        vtproc::FAKE_ENV.store(true, Ordering::SeqCst);
        std::env::temp_dir().join(format!("kt-selftest-vt-{}", std::process::id()))
    } else {
        app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("kurokawa-tools"))
    };
    let _ = DIRS.set(Dirs { bin: data.join("bin"), packs: data.join("packs"), data });
    crate::vtjobs::init(app);
}

pub fn dirs() -> &'static Dirs {
    DIRS.get_or_init(|| {
        let data = std::env::temp_dir().join("kurokawa-tools");
        Dirs { bin: data.join("bin"), packs: data.join("packs"), data }
    })
}

fn os() -> &'static str {
    util::node_platform()
}
pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
fn lossy(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Blocking work off the async runtime.
pub async fn blocking<T: Send + 'static, F: FnOnce() -> T + Send + 'static>(f: F) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/* ---------- yt-dlp: where it is, its version ---------- */

static CUSTOM: Mutex<String> = Mutex::new(String::new());
static VER_CACHE: Mutex<Option<(String, Option<String>)>> = Mutex::new(None);

pub fn managed_path() -> PathBuf {
    dirs().bin.join(vt::ytdlp_file(os()))
}
pub fn bin_path() -> PathBuf {
    let c = CUSTOM.lock().map(|g| g.clone()).unwrap_or_default();
    if c.is_empty() {
        managed_path()
    } else {
        PathBuf::from(c)
    }
}
pub fn is_managed() -> bool {
    CUSTOM.lock().map(|g| g.is_empty()).unwrap_or(true)
}
/// ytdlp.cjs setCustomPath: the user's own program when it exists, else the managed one again.
fn set_custom_path(p: &str) -> bool {
    let keep = if !p.is_empty() && Path::new(p).exists() { p.to_string() } else { String::new() };
    let on = !keep.is_empty();
    if let Ok(mut g) = CUSTOM.lock() {
        *g = keep;
    }
    forget_version();
    on
}
pub fn have_binary() -> bool {
    bin_path().exists()
}
fn forget_version() {
    if let Ok(mut g) = VER_CACHE.lock() {
        *g = None;
    }
}

/// A program's `--version` (10 s at most), None when it fails.
pub fn version_of(bin: &Path, limit: Duration) -> Option<String> {
    let r = vtproc::run(bin, &["--version".to_string()], limit, 1 << 16).ok()?;
    if r.timed_out {
        return None;
    }
    vt::version_answer(r.code, &String::from_utf8_lossy(&r.out))
}
/// The version, asked once per file (keyed by its path, size and time).
pub fn version() -> Option<String> {
    let bin = bin_path();
    let st = std::fs::metadata(&bin).ok()?;
    let mt = st.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
    let key = format!("{}|{}|{}", lossy(&bin), st.len(), mt);
    if let Ok(g) = VER_CACHE.lock() {
        if let Some((k, v)) = g.as_ref() {
            if *k == key {
                return v.clone();
            }
        }
    }
    let v = version_of(&bin, Duration::from_secs(10));
    if let Ok(mut g) = VER_CACHE.lock() {
        *g = Some((key, v.clone()));
    }
    v
}

/// The older copies kept beside the program, newest first: (file name, version).
pub fn olds() -> Vec<(String, String)> {
    let mut v: Vec<(String, String, u128)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dirs().bin) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if let Some(ver) = vt::old_version(&name) {
                let at = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
                v.push((name, ver, at));
            }
        }
    }
    vt::sort_olds(&mut v);
    v.into_iter().map(|(n, ver, _)| (n, ver)).collect()
}

/// The program in use copied aside (ytdlp.cjs keepOld) → its version, or None when there was none.
fn keep_old() -> Option<String> {
    let cur = managed_path();
    if !cur.exists() {
        return None;
    }
    let v = version_of(&cur, Duration::from_secs(10)).unwrap_or_else(|| now_ms().to_string());
    let file = cur.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let to = dirs().bin.join(vt::old_name(&file, &v));
    if std::fs::copy(&cur, &to).is_ok() {
        // (Its time is the time it was put aside: the newest first, whatever the copy keeps.)
        if let Ok(f) = std::fs::File::options().write(true).open(&to) {
            let _ = f.set_modified(SystemTime::now());
        }
    }
    for (name, _) in olds().into_iter().skip(vt::KEEP_OLDS) {
        let _ = std::fs::remove_file(dirs().bin.join(name));
    }
    Some(v)
}

fn stamp_path() -> PathBuf {
    dirs().bin.join("yt-dlp.stamp.json")
}
fn read_stamp() -> Option<serde_json::Map<String, Value>> {
    let t = std::fs::read_to_string(stamp_path()).ok()?;
    match serde_json::from_str::<Value>(&t).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}
fn write_stamp(m: serde_json::Map<String, Value>) {
    let _ = std::fs::write(stamp_path(), Value::Object(m).to_string());
}

/// ytdlp.cjs rollback: the newest older copy put back, pinned (an update then waits until it is forced).
pub fn rollback() -> Result<String, String> {
    let (name, version) = olds().into_iter().next().ok_or_else(|| "nothing to roll back to".to_string())?;
    let from = dirs().bin.join(&name);
    std::fs::copy(&from, managed_path()).map_err(|e| e.to_string())?;
    let _ = vtproc::make_executable(&managed_path());
    let _ = std::fs::remove_file(&from);
    forget_version();
    if let Some(mut cur) = read_stamp() {
        cur.insert("checked".into(), json!(now_ms()));
        cur.insert("pinned".into(), json!(version));
        write_stamp(cur);
    }
    Ok(version)
}

/* ---------- fetching a program ---------- */

/// One fetch at a time per program; a second caller waits for the first and takes what it left.
struct Flight(&'static AtomicBool);
impl Flight {
    async fn take(flag: &'static AtomicBool) -> Option<Flight> {
        if !flag.swap(true, Ordering::SeqCst) {
            return Some(Flight(flag));
        }
        let until = Instant::now() + Duration::from_secs(600);
        while flag.load(Ordering::SeqCst) && Instant::now() < until {
            let _ = blocking(|| std::thread::sleep(Duration::from_millis(150))).await;
        }
        None
    }
}
impl Drop for Flight {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
static FETCH_YT: AtomicBool = AtomicBool::new(false);
static FETCH_GDL: AtomicBool = AtomicBool::new(false);

/// What a fetch tells as it goes: (got, total).
pub type Progress = Box<dyn FnMut(u64, u64) + Send>;

/// The fetched `part` put in place as `target` through kt-core's Swap: checksum, the one in use kept aside (`keep`),
/// renamed in place, asked its version; one that does not answer taken away and the kept copy put back.
fn swap_in(tool: &str, part: &Path, target: &Path, want: Option<&str>, got_sha: &str, keep: bool) -> Result<String, String> {
    let s = vt::Swap::Fetched.verified(want, got_sha);
    if let vt::Swap::Refused(_) = s {
        let _ = std::fs::remove_file(part);
        return Err(s.error(tool).unwrap_or_default());
    }
    let old = if keep { keep_old() } else { None };
    let s = s.old_kept(old.clone());
    let _ = vtproc::make_executable(part);
    std::fs::rename(part, target).map_err(|e| {
        let _ = std::fs::remove_file(part);
        format!("{}: {}", tool, e)
    })?;
    let _ = vtproc::make_executable(target);
    let s = s.placed();
    // (Asked as execFile would; a release's first start may unpack itself, so it is given longer than a version
    // check.)
    let ans = vtproc::run(target, &["--version".to_string()], Duration::from_secs(45), 1 << 16).ok();
    let (code, out) = match ans {
        Some(r) if !r.timed_out => (r.code, String::from_utf8_lossy(&r.out).into_owned()),
        _ => (None, String::new()),
    };
    let s = s.checked(code, &out);
    match &s {
        vt::Swap::Done { version } => Ok(version.clone()),
        vt::Swap::RolledBack { old } => {
            let _ = std::fs::remove_file(target);
            if let Some(v) = old {
                let file = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let kept = dirs().bin.join(vt::old_name(&file, v));
                if std::fs::copy(&kept, target).is_ok() {
                    let _ = vtproc::make_executable(target);
                    let _ = std::fs::remove_file(&kept);
                }
            }
            Err(s.error(tool).unwrap_or_default())
        }
        _ => Err(s.error(tool).unwrap_or_default()),
    }
}

/// ytdlp.cjs fetchBinary: the newest release's program for this system, checked, put in place.
pub async fn fetch_ytdlp(mut progress: Option<Progress>) -> Result<PathBuf, String> {
    let _flight = match Flight::take(&FETCH_YT).await {
        Some(f) => f,
        None => {
            return if managed_path().exists() { Ok(bin_path()) } else { Err("yt-dlp: not installed".to_string()) };
        }
    };
    let u = urls();
    let asset = vt::ytdlp_asset(os(), util::node_arch());
    std::fs::create_dir_all(&dirs().bin).map_err(|e| e.to_string())?;
    let sums = vtfetch::text(&format!("{}/SHA2-256SUMS", u.yt_dl), None).await.map_err(|e| format!("yt-dlp: {}", e))?;
    let want = vt::sum_for(&sums, asset);
    let url = format!("{}/{}", u.yt_dl, asset);
    let part = PathBuf::from(format!("{}.part", lossy(&managed_path())));
    let never = AtomicBool::new(false);
    let got = vtfetch::fetch(&url, &part, &never, |g, t| {
        if let Some(p) = progress.as_mut() {
            p(g, t);
        }
    })
    .await
    .map_err(|e| format!("yt-dlp: {}", e))?;
    let target = managed_path();
    let part2 = got.path.clone();
    let sha = got.sha256.clone();
    let swapped = blocking(move || swap_in("yt-dlp", &part2, &target, want.as_deref(), &sha, true)).await?;
    forget_version();
    swapped?;
    let mut st = serde_json::Map::new();
    st.insert("at".into(), json!(now_ms()));
    st.insert("url".into(), json!(url));
    write_stamp(st);
    Ok(bin_path())
}

/// ytdlp.cjs ensure: fetched when missing; a managed one older than the oldest allowed replaced (offline: it runs).
pub async fn ensure(progress: Option<Progress>) -> Result<PathBuf, String> {
    if !have_binary() {
        fetch_ytdlp(progress).await?;
    } else if is_managed() {
        let v = blocking(version).await?;
        if let Some(v) = v {
            if vt::older_than(&v, vt::MIN_VERSION) {
                let _ = fetch_ytdlp(progress).await;
            }
        }
    }
    Ok(bin_path())
}

/// The newest release's tag (yt-dlp prints the same string for --version).
async fn latest_tag() -> Result<String, String> {
    let t = vtfetch::text(&urls().yt_api, Some("application/vnd.github+json")).await?;
    let v: Value = serde_json::from_str(&t).map_err(|e| e.to_string())?;
    Ok(v.get("tag_name").and_then(|x| x.as_str()).unwrap_or("").trim().to_string())
}

/// ytdlp.cjs update(force).
pub async fn update(force: bool) -> Result<Value, String> {
    if !have_binary() {
        fetch_ytdlp(None).await?;
        let v = blocking(version).await?;
        return Ok(json!({ "version": v, "updated": true }));
    }
    let st = read_stamp().unwrap_or_default();
    let checked = st.get("checked").and_then(|x| x.as_u64());
    if !vt::update_check_due(checked, now_ms(), force) {
        let v = blocking(version).await?;
        return Ok(json!({ "version": v, "updated": false }));
    }
    let have = blocking(version).await?;
    let tag = latest_tag().await?;
    let pinned = st.get("pinned").and_then(|x| x.as_str()).map(|s| s.to_string());
    let mut updated = false;
    if vt::update_due(have.as_deref(), &tag, pinned.as_deref(), force) {
        fetch_ytdlp(None).await?;
        updated = true;
    }
    if let Some(mut cur) = read_stamp() {
        cur.insert("checked".into(), json!(now_ms()));
        write_stamp(cur);
    }
    let v = blocking(version).await?;
    Ok(json!({ "version": v, "latest": tag, "updated": updated }))
}

/// ytdlp.cjs maybeUpdate: quietly, 15 s after start and every 6 h (offline: next time).
pub fn schedule_updates() {
    if selftest_run() {
        return;
    }
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(15));
        loop {
            if have_binary() {
                let _ = tauri::async_runtime::block_on(update(false));
            }
            std::thread::sleep(Duration::from_secs(6 * 3600));
        }
    });
}

/* ---------- running yt-dlp ---------- */

static JS_OK: AtomicBool = AtomicBool::new(true);
static JS_RUNTIME: OnceLock<Option<(String, String)>> = OnceLock::new();

/// ytdlp.cjs checkJs: whether the program knows --js-runtimes.
pub fn check_js() {
    let v = version();
    JS_OK.store(vt::js_ok(v.as_deref()), Ordering::SeqCst);
}
fn js_runtime() -> Option<(String, String)> {
    JS_RUNTIME
        .get_or_init(|| {
            for n in vt::JS_RUNTIMES.iter() {
                if let Some(p) = vtproc::find_on_path(n) {
                    return Some((n.to_string(), lossy(&p)));
                }
            }
            None
        })
        .clone()
}
fn js_args() -> Vec<String> {
    if !JS_OK.load(Ordering::SeqCst) {
        return Vec::new();
    }
    // (The version is not asked again: check_js has just decided.)
    let rt = js_runtime();
    vt::js_args(None, rt.as_ref().map(|(n, p)| (n.as_str(), p.as_str())))
}
/// ytdlp.cjs common(): what every job is given besides the page's list.
pub fn common_args() -> Vec<String> {
    let mut a = vec!["--no-warnings".to_string(), "--no-playlist-reverse".to_string()];
    a.extend(js_args());
    let ff = crate::vtffmpeg::pack_ffmpeg();
    if ff.exists() {
        a.push("--ffmpeg-location".into());
        a.push(lossy(&ff));
    }
    a
}

fn text_of(o: &Value, k: &str) -> String {
    match o.get(k) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(v) => v.to_string(),
    }
}
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|x| x != 0.0 && !x.is_nan()).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// kt:videoInfo(o) → ytdlp.cjs info: `-J` (90 s at most), shaped by normalise.
pub async fn info(o: Value) -> Result<Value, String> {
    ensure(None).await?;
    blocking(check_js).await?;
    let url = text_of(&o, "url");
    let cookies = text_of(&o, "cookiesFromBrowser");
    let playlist = truthy(o.get("playlist"));
    let ran = blocking(move || {
        let args = vt::info_args(&url, playlist, Some(cookies.as_str()).filter(|c| !c.is_empty()), &js_args());
        vtproc::run(&bin_path(), &args, Duration::from_secs(90), 64 << 20)
    })
    .await??;
    if ran.code != Some(0) || ran.timed_out {
        let why = if ran.timed_out { "timed out".to_string() } else { format!("yt-dlp exited with {}", ran.code.map(|c| c.to_string()).unwrap_or_else(|| "a signal".into())) };
        return Err(vt::last_line(&ran.err, &why));
    }
    let text = String::from_utf8_lossy(&ran.out).into_owned();
    let j = vidjson::parse(&text).map_err(|e| format!("yt-dlp: unreadable answer ({})", e))?;
    serde_json::from_str(&vidjson::normalise(&j).to_json()).map_err(|e| e.to_string())
}

/* ---------- gallery-dl ---------- */

pub fn gallery_path() -> PathBuf {
    dirs().bin.join(vt::gallery_file(os()))
}

/// gallerydl.cjs fetchBinary: the release's standalone program (its digest checked when published), put in place and
/// asked its version (one that does not answer is removed).
async fn fetch_gallery() -> Result<PathBuf, String> {
    let _flight = match Flight::take(&FETCH_GDL).await {
        Some(f) => f,
        None => return if gallery_path().exists() { Ok(gallery_path()) } else { Err("gallery-dl: not installed".to_string()) },
    };
    std::fs::create_dir_all(&dirs().bin).map_err(|e| e.to_string())?;
    let asset = vt::gallery_asset(os()).ok_or_else(|| "gallery-dl: no binary for this platform".to_string())?;
    let t = vtfetch::text(&urls().gdl_api, Some("application/vnd.github+json")).await.map_err(|e| format!("gallery-dl: {}", e))?;
    let rel: Value = serde_json::from_str(&t).map_err(|e| format!("gallery-dl: {}", e))?;
    let a = rel
        .get("assets")
        .and_then(|x| x.as_array())
        .and_then(|xs| xs.iter().find(|x| x.get("name").and_then(|n| n.as_str()) == Some(asset)))
        .cloned()
        .ok_or_else(|| "gallery-dl: no binary for this platform".to_string())?;
    let want = a.get("digest").and_then(|d| d.as_str()).and_then(vt::digest_hex);
    let url = a.get("browser_download_url").and_then(|u| u.as_str()).unwrap_or("").to_string();
    let part = PathBuf::from(format!("{}.part", lossy(&gallery_path())));
    let never = AtomicBool::new(false);
    let got = vtfetch::fetch(&url, &part, &never, |_, _| {}).await.map_err(|e| format!("gallery-dl: {}", e))?;
    let target = gallery_path();
    let p2 = got.path.clone();
    let sha = got.sha256.clone();
    blocking(move || swap_in("gallery-dl", &p2, &target, want.as_deref(), &sha, false)).await??;
    Ok(gallery_path())
}

/// kt:galleryList(o) → { title, items } (gallerydl.cjs list: `-j --no-download`, 120 s at most).
pub async fn gallery_list(o: Value) -> Result<Value, String> {
    if !gallery_path().exists() {
        fetch_gallery().await?;
    }
    let url = text_of(&o, "url");
    let cookies = text_of(&o, "cookies");
    let range = text_of(&o, "range");
    let ran = blocking(move || {
        let mut args: Vec<String> = vec!["-j".into(), "--no-download".into()];
        if !cookies.is_empty() {
            args.push("--cookies".into());
            args.push(cookies);
        }
        if !range.is_empty() {
            args.push("--range".into());
            args.push(range);
        }
        args.push(url);
        vtproc::run(&gallery_path(), &args, Duration::from_secs(120), 64 << 20)
    })
    .await??;
    let out = String::from_utf8_lossy(&ran.out).into_owned();
    let failed = ran.code != Some(0) || ran.timed_out;
    if failed && out.is_empty() {
        let why = if ran.timed_out { "timed out".to_string() } else { format!("gallery-dl exited with {}", ran.code.map(|c| c.to_string()).unwrap_or_else(|| "a signal".into())) };
        return Err(vt::gallery_error(&ran.err, &why));
    }
    let j = vidjson::gallery_items(&out)?;
    serde_json::from_str(&j.to_json()).map_err(|e| e.to_string())
}

/* ---------- the commands ---------- */

/// kt:videoInfo(o).
#[tauri::command]
pub async fn kt_video_info(o: Value) -> Result<Value, String> {
    info(o).await
}

/// kt:videoReady → { ok, version } or { ok: false, why }; the fetch's progress as kt:update-progress (what: yt-dlp).
#[tauri::command]
pub async fn kt_video_ready(app: AppHandle) -> Result<Value, String> {
    let mut last = Instant::now() - Duration::from_secs(1);
    let tell: Progress = Box::new(move |got, total| {
        if last.elapsed() < Duration::from_millis(200) && got < total {
            return;
        }
        last = Instant::now();
        let pct = if total > 0 { ((got as f64 / total as f64) * 100.0).round() as u64 } else { 0 };
        let _ = app.emit("kt:update-progress", json!({ "pct": pct, "got": got, "total": total, "what": "yt-dlp" }));
    });
    match ensure(Some(tell)).await {
        Ok(_) => Ok(json!({ "ok": true, "version": blocking(version).await? })),
        Err(e) => Ok(json!({ "ok": false, "why": e })),
    }
}

/// kt:videoVersion → { version, ready }.
#[tauri::command]
pub async fn kt_video_version() -> Result<Value, String> {
    let ready = have_binary();
    let v = if ready { blocking(version).await? } else { None };
    Ok(json!({ "version": v, "ready": ready }))
}

/// kt:videoUpdate → { version, latest, updated } (forced).
#[tauri::command]
pub async fn kt_video_update() -> Result<Value, String> {
    update(true).await
}

/// kt:videoRollback → { version }.
#[tauri::command]
pub async fn kt_video_rollback() -> Result<Value, String> {
    let v = blocking(rollback).await??;
    Ok(json!({ "version": v }))
}

/// kt:videoBinary(o) → { path, managed, olds, min }; o.path (a string) chooses the user's own program ('' none).
#[tauri::command]
pub async fn kt_video_binary(o: Value) -> Result<Value, String> {
    if let Some(Value::String(p)) = o.get("path") {
        set_custom_path(p);
    }
    let olds: Vec<String> = blocking(olds).await?.into_iter().map(|(_, v)| v).collect();
    Ok(json!({ "path": lossy(&bin_path()), "managed": is_managed(), "olds": olds, "min": vt::MIN_VERSION }))
}

/// kt:isVideoHost(u): a site yt-dlp is always asked about.
#[tauri::command]
pub async fn kt_is_video_host(u: String) -> Result<bool, String> {
    Ok(vt::is_video_host(&u))
}

/// kt:galleryList(o) → { title, items }.
#[tauri::command]
pub async fn kt_gallery_list(o: Value) -> Result<Value, String> {
    gallery_list(o).await
}

/// kt:galleryReady → { ready, version }.
#[tauri::command]
pub async fn kt_gallery_ready() -> Result<Value, String> {
    let ready = gallery_path().exists();
    let v = if ready { blocking(|| version_of(&gallery_path(), Duration::from_secs(10))).await? } else { None };
    Ok(json!({ "ready": ready, "version": v }))
}
