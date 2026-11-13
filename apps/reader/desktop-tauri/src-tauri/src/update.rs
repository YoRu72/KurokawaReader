// The in-app updater (stage R6b): main.cjs's kr:install-update, kr:update-download and kr:update-install, and the
// kr:update-progress events, for this build. The decisions are updatelogic.rs's (std only, unit-tested); this file
// does the network, the files and the processes.
//
// - installUpdate(url, o) — the update sheet's «Download and install»: the release file for this kind of copy is
//   downloaded (with progress; a connection that breaks off is resumed from where it stopped, up to six tries) into
//   <temp>/KurokawaReader-update/, its size and SHA-256 checked against the release (GitHub's digest of the file, sent
//   by the page as `o.digest`, and the release's KurokawaReader-<v>-SHA256SUMS.txt — a file that neither names, or
//   that does not match, is refused and removed), then installed: Windows (the NSIS installer's copy) — the new
//   installer run as an update with a progress window, the app started again after; Linux AppImage — the file
//   replaced in place at once (written beside it, then renamed over it) and started again; Linux .deb — the package
//   opened in the system's installer; a Mac — the disk image opened (the app is not signed: the page says what to do
//   and what macOS may ask). The portable zip and a bare program are refused before anything is downloaded
//   («kr-update:portable», «kr-update:bare»: the page says to download the new build by hand).
// - downloadUpdate({beta}) — background updates (Settings): the release list read (GitHub's API; a test's loopback
//   feed with KR_UPDATE_FEED), the newest release for this copy fetched and checked quietly → 'downloaded' / 'none' /
//   'unsupported' (a copy that cannot install by itself). installDownloadedUpdate() installs it now and restarts;
//   otherwise it is installed when the app quits (at_exit), as electron-updater's autoInstallOnAppQuit.
// - With KR_UPDATETEST=<file> (CI): the page drives downloadUpdate → installDownloadedUpdate itself and notes each step
//   in that file (the workflow's «update over the installed app» step).
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use kurokawa_shell::{hash, net, shell, util};

use crate::updatelogic::{self as logic, Kind};

/// An update downloaded and checked, not installed yet.
#[derive(Clone)]
struct Ready {
    file: PathBuf,
    version: String,
    installed: bool,
}

static READY: Mutex<Option<Ready>> = Mutex::new(None);
static BUSY: AtomicBool = AtomicBool::new(false);
static KIND: OnceLock<Kind> = OnceLock::new();

/// What kind of copy this is (updatelogic::kind_of), worked out once.
pub fn kind() -> Kind {
    *KIND.get_or_init(|| {
        let exe = std::env::current_exe().unwrap_or_default();
        let dir = exe.parent().map(|d| d.to_path_buf()).unwrap_or_default();
        let has_uninstaller = std::fs::read_dir(&dir)
            .map(|rd| {
                rd.flatten().any(|e| {
                    let n = e.file_name().to_string_lossy().to_ascii_lowercase();
                    n.starts_with("uninstall") && n.ends_with(".exe")
                })
            })
            .unwrap_or(false);
        let marker = dir.join(logic::PORTABLE_MARKER).is_file();
        let appimage = std::env::var("APPIMAGE").ok();
        logic::kind_of(util::node_platform(), &exe.to_string_lossy(), appimage.as_deref(), has_uninstaller, marker)
    })
}

/// The kind's name, for the page (window.__KR_BOOT__.kind: src/updates.ts picks the release file by it).
pub fn kind_name() -> &'static str {
    kind().name()
}

fn folder() -> PathBuf {
    std::env::temp_dir().join("KurokawaReader-update")
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

async fn pause(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_millis(ms))).await;
}

/// One job at a time (a second «install» while one runs is refused, as the sheet's button is hidden meanwhile).
struct Busy;
impl Busy {
    fn take() -> Result<Busy, String> {
        if BUSY.swap(true, Ordering::SeqCst) {
            Err("kr-update:busy".to_string())
        } else {
            Ok(Busy)
        }
    }
}
impl Drop for Busy {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

/// Progress to the page, as main.cjs's kr:update-progress: { pct, got, total, speed } (and { verifying: true }).
struct Meter {
    app: AppHandle,
    loud: bool,
    started: Instant,
    last: u128,
    last_got: u64,
    last_t: u128,
    speed: f64,
}

impl Meter {
    fn new(app: &AppHandle, loud: bool) -> Meter {
        Meter { app: app.clone(), loud, started: Instant::now(), last: 0, last_got: 0, last_t: 0, speed: 0.0 }
    }
    fn tell(&mut self, got: u64, total: u64, done: bool) {
        if !self.loud {
            return;
        }
        let now = self.started.elapsed().as_millis();
        if !logic::tell(self.last, now, done) {
            return;
        }
        if now > self.last_t + 300 {
            self.speed = got.saturating_sub(self.last_got) as f64 / ((now - self.last_t) as f64 / 1000.0);
            self.last_t = now;
            self.last_got = got;
        }
        self.last = now;
        let _ = self.app.emit("kr:update-progress", json!({ "pct": logic::pct(got, total), "got": got, "total": total, "speed": self.speed.round() as u64 }));
    }
    fn verifying(&self) {
        if self.loud {
            let _ = self.app.emit("kr:update-progress", json!({ "pct": 100, "got": 0, "total": 0, "speed": 0, "verifying": true }));
        }
    }
}

/// `url` fetched into `dir`/`name`, resumed where a broken connection left it (up to six tries), → the file. `cut`
/// (the self-test): the first try is broken off after that many bytes, as a dropped connection would.
async fn fetch(url: &str, dir: &Path, name: &str, meter: &mut Meter, cut: Option<u64>) -> Result<(PathBuf, u64), String> {
    std::fs::create_dir_all(dir).map_err(err)?;
    let part = dir.join(format!("{}.part", name));
    let tag = dir.join(format!("{}.part.url", name));
    // (A part of another address is not this file's.)
    if std::fs::read_to_string(&tag).ok().as_deref() != Some(url) {
        let _ = std::fs::remove_file(&part);
        std::fs::write(&tag, url).map_err(err)?;
    }
    let client = net::client()?;
    let mut resumed_from: u64 = 0;
    let mut cut = cut;
    let mut last_error = String::new();
    for attempt in 0..6u64 {
        if attempt > 0 {
            pause(800 * attempt).await;
        }
        let mut have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
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
            logic::Resume::Fail(s) => return Err(format!("HTTP {}", s)),
            logic::Resume::Done => return finish(dir, name, &part, &tag, resumed_from),
            logic::Resume::Append => {
                if have > 0 && resumed_from == 0 {
                    resumed_from = have;
                }
                std::fs::OpenOptions::new().append(true).open(&part).map_err(err)?
            }
            logic::Resume::Restart => {
                have = 0;
                std::fs::File::create(&part).map_err(err)?
            }
        };
        let total = logic::total_of(have, cr.as_deref(), len).unwrap_or(0);
        let mut got = have;
        let mut broke = false;
        loop {
            match resp.chunk().await {
                Ok(Some(bytes)) => {
                    out.write_all(&bytes).map_err(err)?;
                    got += bytes.len() as u64;
                    meter.tell(got, total, false);
                    if let Some(c) = cut {
                        if got >= c {
                            cut = None;
                            broke = true;
                            last_error = "cut by the self-test".to_string();
                            break;
                        }
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    last_error = e.to_string();
                    broke = true;
                    break;
                }
            }
        }
        out.flush().map_err(err)?;
        drop(out);
        if broke || (total > 0 && got < total) {
            continue;
        }
        meter.tell(got, total, true);
        return finish(dir, name, &part, &tag, resumed_from);
    }
    Err(if last_error.is_empty() { "download failed".to_string() } else { last_error })
}

/// The whole file kept under its own name.
fn finish(dir: &Path, name: &str, part: &Path, tag: &Path, resumed_from: u64) -> Result<(PathBuf, u64), String> {
    let file = dir.join(name);
    let _ = std::fs::remove_file(&file);
    std::fs::rename(part, &file).map_err(err)?;
    let _ = std::fs::remove_file(tag);
    Ok((file, resumed_from))
}

/// A small text file of the release (its SHA256SUMS), or None.
async fn text_of(url: &str) -> Option<String> {
    let resp = net::client().ok()?.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let b = resp.bytes().await.ok()?;
    if b.len() > 1 << 20 {
        return None;
    }
    Some(String::from_utf8_lossy(&b).into_owned())
}

/// The file checked against the release: its size (when stated) and its SHA-256 (GitHub's digest and/or the SHA256SUMS
/// line). A file refused is removed.
fn check(file: &Path, size: u64, digest: Option<&str>, sums: Option<&str>, name: &str) -> Result<(), String> {
    let line = sums.and_then(|t| logic::sum_for(t, name));
    let want = match logic::expected_sha(digest, line.as_deref()) {
        Ok(w) => w,
        Err(r) => {
            let _ = std::fs::remove_file(file);
            return Err(r.code());
        }
    };
    let p = file.to_string_lossy().into_owned();
    let h = hash::hash_file(&p)?;
    if let Err(r) = logic::verify(size, h.size, &want, &h.sha256) {
        let _ = std::fs::remove_file(file);
        return Err(r.code());
    }
    Ok(())
}

/// Old downloads of other names taken away (one in use, or still locked, is left).
fn tidy(dir: &Path, keep: &str) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if !n.starts_with(keep) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

/// The checked file installed for this kind of copy. `now`: at the person's word (a progress window, the app started
/// again); otherwise quietly as the app quits. → what the page is told.
fn launch(app: &AppHandle, file: &Path, now: bool) -> Result<String, String> {
    match kind() {
        Kind::Nsis => {
            std::process::Command::new(file)
                .args(logic::installer_args(now))
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|e| format!("kr-update:run {}", e))?;
            if now {
                // (The installer closes the app if it is still running; leaving first lets it replace the files at once.)
                let h = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(700));
                    h.exit(0);
                });
            }
            Ok("installing".to_string())
        }
        Kind::AppImage => {
            let target = std::env::var("APPIMAGE").map_err(|_| "kr-update:bare".to_string())?;
            replace_appimage(file, Path::new(&target))?;
            if now {
                std::process::Command::new(&target)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(|e| format!("kr-update:run {}", e))?;
                let h = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(500));
                    h.exit(0);
                });
            }
            Ok("relaunching".to_string())
        }
        Kind::Deb => {
            shell::open_path(app, file.to_string_lossy().into_owned())?;
            Ok("kr-update:deb-opened".to_string())
        }
        Kind::MacApp => {
            shell::open_path(app, file.to_string_lossy().into_owned())?;
            Ok("kr-update:mac-opened".to_string())
        }
        Kind::Portable => Err("kr-update:portable".to_string()),
        Kind::Bare => Err("kr-update:bare".to_string()),
    }
}

/// The running AppImage replaced by the new one at once: written beside it (the same disk), made runnable, then
/// renamed over it — the running copy keeps its own file until it ends.
#[cfg(unix)]
fn replace_appimage(new: &Path, target: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let dir = target.parent().ok_or_else(|| "kr-update:bare".to_string())?;
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{}.new-{}", name, std::process::id()));
    let r = (|| -> std::io::Result<()> {
        std::fs::copy(new, &tmp)?;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
        std::fs::File::open(&tmp)?.sync_all()?;
        std::fs::rename(&tmp, target)
    })();
    if let Err(e) = r {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("kr-update:readonly {} ({})", dir.to_string_lossy(), e));
    }
    Ok(())
}
#[cfg(not(unix))]
fn replace_appimage(_new: &Path, _target: &Path) -> Result<(), String> {
    Err("kr-update:bare".to_string())
}

fn take_ready() -> Option<Ready> {
    READY.lock().ok().and_then(|g| g.clone()).filter(|r| !r.installed && r.file.is_file())
}
fn set_installed() {
    if let Ok(mut g) = READY.lock() {
        if let Some(r) = g.as_mut() {
            r.installed = true;
        }
    }
}

fn text(o: &Value, k: &str) -> Option<String> {
    o.get(k).and_then(|v| v.as_str()).map(|s| s.to_string()).filter(|s| !s.is_empty())
}

/// installUpdate(url, o) (main.cjs's kr:install-update): the release file downloaded, checked and installed (see the
/// top of this file) → 'installing' / 'relaunching' / 'kr-update:deb-opened' / 'kr-update:mac-opened'.
#[tauri::command]
pub async fn kr_install_update(app: AppHandle, url: String, o: Value) -> Result<String, String> {
    let k = kind();
    if matches!(k, Kind::Portable | Kind::Bare) {
        return Err(format!("kr-update:{}", k.name()));
    }
    let _busy = Busy::take()?;
    let (os, arch) = (util::node_platform(), util::node_arch());
    // (The page's choice of file, or — when it chose another build's — this copy's own file of the same release.)
    let given = logic::file_of_url(&url);
    let version = logic::version_of_asset(&given).ok_or_else(|| "kr-update:unknown".to_string())?;
    let mine = logic::asset_name(&version, os, arch, k).ok_or_else(|| format!("kr-update:{}", k.name()))?;
    let fits = logic::asset_fits(&given, &version, os, arch, k);
    let (name, url, size, digest) = if fits {
        (given.clone(), url.clone(), o.get("size").and_then(|v| v.as_u64()).unwrap_or(0), text(&o, "digest"))
    } else {
        (mine.clone(), logic::sibling_url(&url, &mine).ok_or_else(|| "kr-update:unknown".to_string())?, 0, None)
    };
    let name = logic::safe_name(&name);
    // (Downloaded in the background already and not installed: that file, nothing fetched again.)
    if let Some(r) = take_ready() {
        if r.version == version && r.file.file_name().map(|n| n.to_string_lossy() == name).unwrap_or(false) {
            let out = launch(&app, &r.file, true)?;
            set_installed();
            return Ok(out);
        }
    }
    let sums = match logic::sibling_url(&url, &logic::sums_name(&version)) {
        Some(u) => text_of(&u).await,
        None => None,
    };
    let dir = folder();
    tidy(&dir, &name);
    let mut meter = Meter::new(&app, true);
    let (file, _) = fetch(&url, &dir, &name, &mut meter, None).await?;
    meter.verifying();
    check(&file, size, digest.as_deref(), sums.as_deref(), &name)?;
    let out = launch(&app, &file, true)?;
    if let Ok(mut g) = READY.lock() {
        *g = Some(Ready { file, version, installed: true });
    }
    Ok(out)
}

/// The release list (GitHub's API, or KR_UPDATE_FEED on this computer) → releases.
async fn releases() -> Result<Vec<logic::Release>, String> {
    let feed = logic::feed_url(std::env::var("KR_UPDATE_FEED").ok().as_deref(), net::REPO);
    let resp = net::client()?
        .get(&feed)
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(err)?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let all: Value = serde_json::from_slice(&resp.bytes().await.map_err(err)?).map_err(err)?;
    let s = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    Ok(all
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or(&[])
        .iter()
        .map(|r| logic::Release {
            tag: s(r, "tag_name"),
            draft: r.get("draft").and_then(|x| x.as_bool()).unwrap_or(false),
            prerelease: r.get("prerelease").and_then(|x| x.as_bool()).unwrap_or(false),
            page: s(r, "html_url"),
            assets: r
                .get("assets")
                .and_then(|x| x.as_array())
                .map(|a| a.as_slice())
                .unwrap_or(&[])
                .iter()
                .map(|a| logic::Asset {
                    name: s(a, "name"),
                    url: s(a, "browser_download_url"),
                    size: a.get("size").and_then(|x| x.as_u64()).unwrap_or(0),
                    digest: a.get("digest").and_then(|x| x.as_str()).map(|x| x.to_string()),
                })
                .collect(),
        })
        .collect())
}

/// downloadUpdate({beta}) (main.cjs's kr:update-download): the update fetched and checked in the background →
/// 'downloaded' / 'none' / 'unsupported'.
#[tauri::command]
pub async fn kr_update_download(app: AppHandle, o: Value) -> Result<String, String> {
    let k = kind();
    if !k.installs_itself() {
        return Ok("unsupported".to_string());
    }
    if take_ready().is_some() {
        return Ok("downloaded".to_string());
    }
    let _busy = match Busy::take() {
        Ok(b) => b,
        Err(_) => return Ok("none".to_string()),
    };
    let beta = o.get("beta").and_then(|v| v.as_bool()).unwrap_or(false);
    let current = app.package_info().version.to_string();
    let list = match releases().await {
        Ok(l) => l,
        // (The list could not be read — GitHub's hourly limit, no network —: the page's own check takes over.)
        Err(_) => return Ok("unsupported".to_string()),
    };
    let pick = match logic::pick_update(&list, &current, beta, util::node_platform(), util::node_arch(), k) {
        Some(p) => p,
        None => return Ok("none".to_string()),
    };
    let sums = match &pick.sums {
        Some(a) => text_of(&a.url).await,
        None => None,
    };
    let name = logic::safe_name(&pick.asset.name);
    let dir = folder();
    tidy(&dir, &name);
    let mut meter = Meter::new(&app, true);
    let (file, _) = match fetch(&pick.asset.url, &dir, &name, &mut meter, None).await {
        Ok(f) => f,
        Err(_) => return Ok("none".to_string()),
    };
    check(&file, pick.asset.size, pick.asset.digest.as_deref(), sums.as_deref(), &name)?;
    if let Ok(mut g) = READY.lock() {
        *g = Some(Ready { file, version: pick.version, installed: false });
    }
    Ok("downloaded".to_string())
}

/// installDownloadedUpdate() (main.cjs's kr:update-install): the update downloaded in the background installed now,
/// the app started again → whether there was one.
#[tauri::command]
pub async fn kr_update_install(app: AppHandle) -> Result<bool, String> {
    match take_ready() {
        Some(r) => {
            launch(&app, &r.file, true)?;
            set_installed();
            Ok(true)
        }
        None => Ok(false),
    }
}

/// The app quitting: an update downloaded in the background and not installed is installed now, quietly (Windows'
/// installer silently, an AppImage replaced), not started again — electron-updater's autoInstallOnAppQuit.
pub fn at_exit(app: &AppHandle) {
    if let Some(r) = take_ready() {
        if kind().installs_itself() && launch(app, &r.file, false).is_ok() {
            set_installed();
        }
    }
}

/// The self-test's row (CI): the test server's 3 MiB file fetched as an update is — broken off after 1 MiB and
/// resumed —, checked against its SHA-256 (passes) and against a wrong one (refused, the file removed); and this
/// copy's kind and what it would fetch.
#[tauri::command]
pub async fn kr_selftest_updatedl(app: AppHandle, url: String) -> Result<Value, String> {
    if !kurokawa_shell::selftest::active() {
        return Err("not a self-test run".to_string());
    }
    let dir = std::env::temp_dir().join(format!("kr-updtest-{}", std::process::id()));
    let mut meter = Meter::new(&app, false);
    let (file, resumed) = fetch(&url, &dir, "large.bin", &mut meter, Some(1 << 20)).await?;
    let h = hash::hash_file(&file.to_string_lossy())?;
    let sums = format!("{}  large.bin\n", h.sha256);
    let ok = check(&file, h.size, None, Some(sums.as_str()), "large.bin");
    let wrong = format!("{}  large.bin\n", "0".repeat(64));
    let refused = check(&file, h.size, None, Some(wrong.as_str()), "large.bin");
    let removed = !file.exists();
    let none = check(&dir.join("absent.bin"), 0, None, None, "absent.bin");
    let _ = std::fs::remove_dir_all(&dir);
    Ok(json!({
        "size": h.size,
        "sha256": h.sha256,
        "resumedFrom": resumed,
        "ok": ok.is_ok(),
        "refused": refused.err(),
        "removedWhenRefused": removed,
        "noChecksum": none.err(),
        "kind": kind_name(),
        "file": logic::asset_name(&app.package_info().version.to_string(), util::node_platform(), util::node_arch(), kind()),
    }))
}

/// With KR_UPDATETEST=<file> (CI): the script the page runs — downloadUpdate, then installDownloadedUpdate —, and a
/// watchdog that ends the program with 2 after KR_UPDATETEST_TIMEOUT seconds (180). None in a normal run.
pub fn script(app: &AppHandle) -> Option<String> {
    let out = std::env::var_os("KR_UPDATETEST").filter(|v| !v.is_empty())?;
    let _ = std::fs::write(PathBuf::from(&out), format!("start {} kind {}\n", app.package_info().version, kind_name()));
    let secs = std::env::var("KR_UPDATETEST_TIMEOUT").ok().and_then(|s| s.parse::<u64>().ok()).unwrap_or(180);
    let h = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(secs));
        note_line("FAIL watchdog");
        h.exit(2);
    });
    Some(UPDATETEST_JS.to_string())
}

const UPDATETEST_JS: &str = r#"(function () {
  'use strict';
  var kd = window.kurokawaDesktop; var inv = window.__TAURI_INTERNALS__;
  function note(t) { try { return (window.__TAURI__ ? window.__TAURI__.core.invoke : inv.invoke)('kr_updatetest_note', { text: String(t) }); } catch (e) { return Promise.resolve(); } }
  if (!kd || window.__KR_UPDATETEST_STARTED__) return; window.__KR_UPDATETEST_STARTED__ = true;
  var n = 0, last = -1;
  kd.onUpdateProgress(function (p) { n++; if (p && p.pct !== last && (p.pct % 25 === 0 || p.verifying)) { last = p.pct; void note('progress ' + JSON.stringify(p)); } });
  setTimeout(function () {
    kd.downloadUpdate({ beta: false }).then(function (r) {
      return note('download ' + r + ' (' + n + ' progress events)').then(function () {
        if (r !== 'downloaded') return note('FAIL not downloaded: ' + r);
        return kd.installDownloadedUpdate().then(function (ok) { return note(ok ? 'install started' : 'FAIL nothing to install'); });
      });
    }).catch(function (e) { void note('FAIL ' + (e && e.message || e)); });
  }, 1500);
})();"#;

fn note_line(text: &str) {
    if let Some(out) = std::env::var_os("KR_UPDATETEST").filter(|v| !v.is_empty()) {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(PathBuf::from(out)) {
            let _ = writeln!(f, "{}", text.replace(['\r', '\n'], " "));
        }
    }
}

/// A step of the CI update test noted in KR_UPDATETEST's file; a «FAIL …» ends the program with 3.
#[tauri::command]
pub async fn kr_updatetest_note(app: AppHandle, text: String) -> Result<(), String> {
    if std::env::var_os("KR_UPDATETEST").filter(|v| !v.is_empty()).is_none() {
        return Err("not an update test".to_string());
    }
    note_line(&text);
    if text.starts_with("FAIL") {
        app.exit(3);
    }
    Ok(())
}
