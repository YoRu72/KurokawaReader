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
