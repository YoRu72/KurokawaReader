// The main window's size and place kept between runs (desktop/main.cjs's window-state.json): read when the window
// is made, written when it moves, is resized or is closed — in logical pixels, the place of its outer frame and the
// size of its inside; while it is maximized only that flag changes, so the size it comes back to is kept.
use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub struct Saved {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    match app.path().app_config_dir() {
        Ok(d) => Some(d.join("window-state.json")),
        Err(_) => None,
    }
}

fn read(p: &PathBuf) -> Value {
    match std::fs::read_to_string(p) {
        Ok(t) => serde_json::from_str::<Value>(&t).unwrap_or_else(|_| json!({})),
        Err(_) => json!({}),
    }
}

/// What was saved, with 1100×780 when nothing was (or nothing sensible).
pub fn load(app: &AppHandle) -> Saved {
    let v = match file(app) {
        Some(p) => read(&p),
        None => json!({}),
    };
    let f = |k: &str| v.get(k).and_then(|x| x.as_f64()).filter(|n| n.is_finite());
    let width = f("width").filter(|w| *w >= 420.0).unwrap_or(1100.0);
    let height = f("height").filter(|h| *h >= 560.0).unwrap_or(780.0);
    let (x, y) = match (f("x"), f("y")) {
        // (A place far off every screen is not restored: the system places the window.)
        (Some(x), Some(y)) if x > -10000.0 && y > -10000.0 && x < 100000.0 && y < 100000.0 => {
            (Some(x), Some(y))
        }
        _ => (None, None),
    };
    let maximized = v
        .get("maximized")
        .and_then(|m| m.as_bool())
        .unwrap_or(false);
    Saved {
        x,
        y,
        width,
        height,
        maximized,
    }
}

/// The main window's events: moved, resized or closing → saved.
pub fn on_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main" {
        return;
    }
    match event {
        tauri::WindowEvent::Moved(_)
        | tauri::WindowEvent::Resized(_)
        | tauri::WindowEvent::CloseRequested { .. } => save(window),
        _ => {}
    }
}

fn save(window: &tauri::Window) {
    let p = match file(window.app_handle()) {
        Some(p) => p,
        None => return,
    };
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let mut v = read(&p);
    if !v.is_object() {
        v = json!({});
    }
    if !maximized {
        let scale = window.scale_factor().unwrap_or(1.0);
        let scale = if scale > 0.0 { scale } else { 1.0 };
        if let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) {
            let w = size.width as f64 / scale;
            let h = size.height as f64 / scale;
            // (A minimizing window may say 0×0 first.)
            if w >= 100.0 && h >= 100.0 {
                v["x"] = json!(pos.x as f64 / scale);
                v["y"] = json!(pos.y as f64 / scale);
                v["width"] = json!(w);
                v["height"] = json!(h);
            }
        }
    }
    v["maximized"] = json!(maximized);
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&p, v.to_string());
}
