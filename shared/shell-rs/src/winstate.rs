// The main window's size and place kept between runs (desktop/main.cjs's window-state.json): read when the window
// is made, written when it moves, is resized or is closed — in logical pixels, the place of its outer frame and the
// size of its inside; while it is maximized only that flag changes, so the size it comes back to is kept.
// (From Kurokawa Tools' src-tauri/src/winstate.rs, branch work-tauri: the default and smallest sizes, which were
// Tools' 1100×780 and 420×560, are now each app's to give — Defaults —, and save() is public for the self-tests.)
use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// An app's window: its size when nothing (sensible) was saved, and the smallest it may be.
#[derive(Clone, Copy, Debug)]
pub struct Defaults {
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub min_height: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Saved {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}

/// Where the state is kept: <the app's config folder>/window-state.json.
pub fn file(app: &AppHandle) -> Option<PathBuf> {
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

/// What was saved, with the app's default size when nothing was (or nothing sensible).
pub fn load(app: &AppHandle, d: &Defaults) -> Saved {
    let v = match file(app) {
        Some(p) => read(&p),
        None => json!({}),
    };
    parse(&v, d)
}

/// A saved state read (a size below the smallest, or a place far off every screen, left out).
pub fn parse(v: &Value, d: &Defaults) -> Saved {
    let f = |k: &str| v.get(k).and_then(|x| x.as_f64()).filter(|n| n.is_finite());
    let width = f("width").filter(|w| *w >= d.min_width).unwrap_or(d.width);
    let height = f("height").filter(|h| *h >= d.min_height).unwrap_or(d.height);
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

/// The window's size, place and maximized state written now (a minimized window is not saved).
pub fn save(window: &tauri::Window) {
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
