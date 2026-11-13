// The Reader's runtime self-test (CI): with KR_SELFTEST=<file> set, the window's initialization script also carries
// ../../selftest.js and its settings (the shared test server's address, the texts it serves, the temp and home
// folders), the page runs its checks through window.kurokawaDesktop and hands the results to kr_selftest_done, which
// writes them to <file> and ends the process (0 / 1; a watchdog ends it with 2 after KR_SELFTEST_TIMEOUT seconds).
// The frame — watchdog, verdict, results file — is the shared crate's (kurokawa_shell::selftest). Without
// KR_SELFTEST none of this runs: no script, no server, no watchdog, and the kr_selftest_* commands refuse.
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use kurokawa_shell::{files, net, selftest as frame, shell, testserver, util, winstate};

use crate::WINDOW;

const SELFTEST_JS: &str = include_str!("../../selftest.js");

/// The script added to the window's initialization script (None in a normal run). Starts the test server and the
/// watchdog.
pub fn script(app: &AppHandle) -> Option<String> {
    if !frame::begin("KR") {
        return None;
    }
    let base = match testserver::start() {
        Ok(port) => format!("http://127.0.0.1:{}", port),
        Err(_) => String::new(),
    };
    let bin: Vec<u8> = (0..=255u8).collect();
    let large: Vec<u8> = (0..testserver::LARGE_SIZE).map(testserver::big_byte).collect();
    // (KR_SELFTEST_OPEN: the file CI also gave this launch on its command line — the page must receive it.)
    let open = std::env::var("KR_SELFTEST_OPEN").ok().filter(|p| !p.is_empty());
    let open_size: i64 = open.as_deref().map(files::file_size).unwrap_or(-1);
    let open_dir: String = open
        .as_deref()
        .and_then(|p| std::path::Path::new(p).parent().map(|d| d.to_string_lossy().into_owned()))
        .unwrap_or_default();
    let cfg = json!({
        "base": base,
        "temp": std::env::temp_dir().to_string_lossy().into_owned(),
        "home": shell::home_dir(app).to_string_lossy().into_owned(),
        "text": testserver::TEXT,
        "gzText": testserver::GZ_TEXT,
        "latinText": testserver::LATIN_TEXT,
        "binB64": util::b64_encode(&bin),
        "os": util::node_platform(),
        "version": app.package_info().version.to_string(),
        "minWidth": WINDOW.min_width,
        "minHeight": WINDOW.min_height,
        "openFirst": open.as_deref().map(crate::openargs::name_of),
        "openFirstSize": open_size,
        "openDir": open_dir,
        // (KR_SELFTEST_NO_WM: CI's Xvfb has no window manager — nothing there maximises a window.)
        "noWm": std::env::var_os("KR_SELFTEST_NO_WM").map(|v| !v.is_empty()).unwrap_or(false),
        // (Stage R3: the files /big and /large send, to compare a download with; the cookie /cookie/set gives; the
        // made-up name /dns-query answers.)
        "bigSize": testserver::BIG_SIZE,
        "bigCrc": testserver::crc32(&testserver::big_bytes()),
        "largeSize": testserver::LARGE_SIZE,
        "largeCrc": testserver::crc32(&large),
        "cookie": testserver::COOKIE_VALUE,
        "dohHost": testserver::DOH_HOST,
        // (Stage R4: the in-app browser's test site, and what this build's browser can do — browser.rs.)
        "site": {
            "title": testserver::SITE_TITLE,
            "cookie": testserver::SITE_COOKIE,
            "token": testserver::SITE_TOKEN,
            "fileName": testserver::SITE_FILE_NAME,
            "fileSize": testserver::SITE_FILE.len(),
        },
        "browser": crate::browser::abilities(),
    });
    Some(format!("window.__KR_SELFTEST__ = {};\n{}", cfg, SELFTEST_JS))
}

fn only_in_selftest() -> Result<(), String> {
    if frame::active() {
        Ok(())
    } else {
        Err("not a self-test run".to_string())
    }
}

/// The results so far (what the watchdog writes if the page stalls).
#[tauri::command]
pub async fn kr_selftest_progress(results: Value) -> Result<(), String> {
    frame::progress(results)
}

/// The page's verdict: written, and the process ended (0 all required passed, 1 not).
#[tauri::command]
pub async fn kr_selftest_done(results: Value) -> Result<(), String> {
    frame::done(results)
}

/// The test's own files taken away again (the Reader's bridge has no general «remove a file»).
#[tauri::command]
pub async fn kr_selftest_remove(p: String) -> Result<bool, String> {
    only_in_selftest()?;
    files::remove_file(&p);
    Ok(files::file_size(&p) < 0)
}

/// A folder made for the test (scanFolder's): true when it is there.
#[tauri::command]
pub async fn kr_selftest_mkdir(p: String) -> Result<bool, String> {
    only_in_selftest()?;
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(std::path::Path::new(&p).is_dir())
}

/// The test's folder taken away again, with what is in it (only one the test made: «kr-scanfolder-…», and since R5
/// the archives' «kr-archive-…»).
#[tauri::command]
pub async fn kr_selftest_rmdir(p: String) -> Result<bool, String> {
    only_in_selftest()?;
    let name = crate::openargs::name_of(&p);
    if !name.starts_with("kr-scanfolder-") && !name.starts_with("kr-archive-") {
        return Err("not the test's folder".to_string());
    }
    let _ = std::fs::remove_dir_all(&p);
    Ok(!std::path::Path::new(&p).exists())
}

/// The shared clipboard functions: `text` put on the clipboard and read back.
#[tauri::command]
pub async fn kr_selftest_clipboard(app: AppHandle, text: String) -> Result<String, String> {
    only_in_selftest()?;
    shell::set_clipboard_text(&app, text)?;
    Ok(shell::clipboard_text(&app))
}

/// The shared window state: the window saved now, the file read back, and what the next start would restore.
#[tauri::command]
pub async fn kr_selftest_winstate(window: tauri::Window) -> Result<Value, String> {
    only_in_selftest()?;
    winstate::save(&window);
    let app = window.app_handle();
    let path = match winstate::file(app) {
        Some(p) => p,
        None => return Err("no config folder".to_string()),
    };
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let file: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let s = winstate::load(app, &WINDOW);
    let scale = window.scale_factor().unwrap_or(1.0);
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let inner = window.inner_size().map_err(|e| e.to_string())?;
    Ok(json!({
        "path": path.to_string_lossy().into_owned(),
        "file": file,
        "restored": { "x": s.x, "y": s.y, "width": s.width, "height": s.height, "maximized": s.maximized },
        "now": { "width": inner.width as f64 / scale, "height": inner.height as f64 / scale },
    }))
}

/// The shared update check against the test server's canned releases list: what `current` would be offered.
#[tauri::command]
pub async fn kr_selftest_update(
    url: String,
    current: String,
    beta: bool,
) -> Result<Value, String> {
    only_in_selftest()?;
    net::check_update_at(&url, "v", &current, beta).await
}

/// This program started again with `args` — as a second launch from «Open with» would be —, without the test's
/// settings (it must not run a test of its own): with the single-instance plugin it hands its arguments to this
/// process and ends at once. Its exit code, and whether it had to be ended after 12 s (then nothing handed it over).
#[tauri::command]
pub async fn kr_selftest_launch(args: Vec<String>) -> Result<Value, String> {
    only_in_selftest()?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let started = std::time::Instant::now();
    let mut child = std::process::Command::new(&exe)
        .args(&args)
        .env_remove("KR_SELFTEST")
        .env_remove("KR_SELFTEST_OPEN")
        .env_remove("KR_ENGINETEST")
        .env_remove("KR_ENGINE_SELFTEST")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let joined = tauri::async_runtime::spawn_blocking(move || loop {
        match child.try_wait() {
            Ok(Some(status)) => return (status.code(), false),
            Ok(None) => {
                if started.elapsed() > std::time::Duration::from_secs(12) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return (None, true);
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(_) => return (None, false),
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(json!({
        "code": joined.0,
        "killed": joined.1,
        "ms": started.elapsed().as_millis() as u64,
        "singleInstance": crate::openfile::single_instance_possible(),
    }))
}
