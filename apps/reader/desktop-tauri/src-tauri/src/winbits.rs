// The window's smaller parts (stage R5; desktop/main.cjs's kr:fullscreen, kr:immersive, kr:progress, kr:copy-image,
// the preload's setZoom): full screen of the window itself (the app's own title bar hides then: titlebar.rs tells
// the page), the interface's size as the web view's zoom (Tauri's set_zoom where the resolved Tauri has it —
// apidetect.rs; elsewhere false, and the bridge zooms the page with CSS), the taskbar's progress (set_progress_bar,
// likewise), an image put on the system clipboard (the clipboard plugin), and — this shell's own — a PDF handed to
// the system's PDF program to print (a Mac's and Linux's web views cannot print a PDF in a frame).
use serde_json::{json, Value};
#[allow(unused_imports)]
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

use kurokawa_shell::{shell, util};

/// JavaScript's `!!v`.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|x| x != 0.0 && !x.is_nan()).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// kr:fullscreen(v): the window full screen (`'toggle'`: the other way round) → the new state.
#[tauri::command]
pub async fn kr_fullscreen(window: tauri::Window, v: Value) -> Result<bool, String> {
    let next = match &v {
        Value::String(s) if s == "toggle" => !window.is_fullscreen().unwrap_or(false),
        other => truthy(other),
    };
    window.set_fullscreen(next).map_err(|e| e.to_string())?;
    Ok(next)
}

/// kr:immersive(on): the reader's immersive mode on a computer is the window full screen → true.
#[tauri::command]
pub async fn kr_immersive(window: tauri::Window, on: bool) -> Result<bool, String> {
    window.set_fullscreen(on).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(kr_zoom)]
fn zoom(app: &AppHandle, f: f64) -> Result<bool, String> {
    let w = app.get_webview_window("main").ok_or_else(|| "no main window".to_string())?;
    w.set_zoom(f).map_err(|e| e.to_string())?;
    Ok(true)
}
#[cfg(not(kr_zoom))]
fn zoom(_app: &AppHandle, _f: f64) -> Result<bool, String> {
    Ok(false)
}

/// The preload's setZoom(f) (webFrame.setZoomFactor, 0.5–2): the web view zoomed → true; false where this build's
/// Tauri cannot (the bridge then zooms the page itself).
#[tauri::command]
pub async fn kr_set_zoom(app: AppHandle, f: f64) -> Result<bool, String> {
    if !(0.5..=2.0).contains(&f) {
        return Ok(false);
    }
    zoom(&app, f)
}

#[cfg(kr_progress)]
fn progress(app: &AppHandle, p: f64) -> Result<bool, String> {
    let w = app.get_webview_window("main").ok_or_else(|| "no main window".to_string())?;
    // (Tauri's ProgressBarState, made from the JSON its own JavaScript API sends: { status, progress 0–100 }.)
    let v = if p.is_finite() && p >= 0.0 {
        json!({ "status": "normal", "progress": (p.min(1.0) * 100.0).round() as u64 })
    } else {
        json!({ "status": "none" })
    };
    let state = serde_json::from_value(v).map_err(|e| e.to_string())?;
    w.set_progress_bar(state).map_err(|e| e.to_string())?;
    Ok(true)
}
#[cfg(not(kr_progress))]
fn progress(_app: &AppHandle, _p: f64) -> Result<bool, String> {
    Ok(false)
}

/// kr:progress(p): long work's progress (0–1) on the taskbar button; below 0 (or none) takes it away → whether this
/// build could. (Electron also lifts its background throttling meanwhile; a Tauri web view has no such switch.)
#[tauri::command]
pub async fn kr_progress(app: AppHandle, p: Option<f64>) -> Result<bool, String> {
    progress(&app, p.unwrap_or(-1.0))
}

/// kr:copy-image(b64): a PNG put on the system clipboard → true; false when it is not a picture this can read (the
/// page then tries the web's own clipboard). The bridge makes any other picture a PNG first.
#[tauri::command]
pub async fn kr_copy_image(app: AppHandle, b64: String) -> Result<bool, String> {
    let bytes = util::b64_decode(&b64);
    let img = match tauri::image::Image::from_bytes(&bytes) {
        Ok(i) => i,
        Err(_) => return Ok(false),
    };
    app.clipboard().write_image(&img).map_err(|e| e.to_string())?;
    Ok(true)
}

/// (This shell's own: the bridge's printFile, macOS and Linux.) A PDF written to the system's temporary folder
/// (<temp>/KurokawaReader-print/<name made safe>) and opened with the system's PDF program, to print from there →
/// true.
#[tauri::command]
pub async fn kr_print_file(app: AppHandle, b64: String, name: String) -> Result<bool, String> {
    let bytes = util::b64_decode(&b64);
    if !bytes.starts_with(b"%PDF") {
        return Err("not a PDF".to_string());
    }
    let dir = std::env::temp_dir().join("KurokawaReader-print");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut file = crate::dlplan::safe_name(&name);
    if !file.to_lowercase().ends_with(".pdf") {
        file.push_str(".pdf");
    }
    let p = dir.join(file);
    std::fs::write(&p, &bytes).map_err(|e| e.to_string())?;
    shell::open_path(&app, p.to_string_lossy().into_owned())?;
    Ok(true)
}

/// (Self-test only.) The clipboard's image read back → { width, height }.
#[tauri::command]
pub async fn kr_selftest_clipimage(app: AppHandle) -> Result<Value, String> {
    if !kurokawa_shell::selftest::active() {
        return Err("not a self-test run".to_string());
    }
    let img = app.clipboard().read_image().map_err(|e| e.to_string())?;
    Ok(json!({ "width": img.width(), "height": img.height() }))
}
