// The window's title bar, the app's own — the Reader's titlebar.rs (apps/reader/desktop-tauri/src-tauri/src), with
// Tools' names (kt_title_bar, kt:titleBarState) — (desktop/titlebar.cjs's part of the Electron shell, done the Tauri
// way): the page draws the whole bar — its buttons too (src/ui/winbar.ts) — on a window without the system's frame (Windows,
// Linux: decorations off), or, on a Mac, under the system's three lights kept over the page (an overlay title bar
// with its title hidden). The page asks for the bar it wants — the app's own or the system's (a setting) — and works
// the window through kt_title_bar; each change of the window's state (maximised, full screen, in front) is told to
// it as the kt:titleBarState event. The choice is kept in <config>/titlebar.json so the next start makes the window
// right away. On Windows and Linux a change is made at once (the system's frame put back or taken off); a Mac's
// window cannot change its kind of title bar after it is made, so there it waits for the next start.
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use kurokawa_shell::util;

/// The bar's height in CSS pixels: Windows' own caption buttons are 32 high (46 wide); a Mac's title bar is 28.
pub const HEIGHT: f64 = if cfg!(target_os = "macos") {
    28.0
} else {
    32.0
};

/// The bar in force on the window (true: the app's own), and the one asked for (they differ on a Mac until the next
/// start).
static OWN: AtomicBool = AtomicBool::new(true);
static WANTED: AtomicBool = AtomicBool::new(true);
/// The last state told to the page (told again only when it changes).
static LAST: Mutex<String> = Mutex::new(String::new());

fn file(app: &AppHandle) -> Option<PathBuf> {
    match app.path().app_config_dir() {
        Ok(d) => Some(d.join("titlebar.json")),
        Err(_) => None,
    }
}

/// The bar the window is made with: as kept, the app's own when nothing is (main.rs, before the window is built).
pub fn own_at_start(app: &AppHandle) -> bool {
    let kept = file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("own").and_then(|b| b.as_bool()));
    let own = kept.unwrap_or(true);
    OWN.store(own, Ordering::SeqCst);
    WANTED.store(own, Ordering::SeqCst);
    own
}

fn keep(app: &AppHandle, own: bool) {
    if let Some(p) = file(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&p, json!({ "own": own }).to_string());
    }
}

/// What the page is told: the OS (Node's words), the bar's height, the bar in force and the one asked for, whose
/// buttons the bar has ("own": the page's; "system": a Mac's lights), and the window's state.
pub fn state(window: &tauri::Window) -> Value {
    json!({
        "platform": util::node_platform(),
        "height": HEIGHT,
        "own": OWN.load(Ordering::SeqCst),
        "wanted": WANTED.load(Ordering::SeqCst),
        "controls": if cfg!(target_os = "macos") { "system" } else { "own" },
        "maximized": window.is_maximized().unwrap_or(false),
        "fullscreen": window.is_fullscreen().unwrap_or(false),
        "focused": window.is_focused().unwrap_or(true),
    })
}

fn tell(window: &tauri::Window) {
    let s = state(window);
    let text = s.to_string();
    if let Ok(mut last) = LAST.lock() {
        if *last == text {
            return;
        }
        *last = text;
    }
    let _ = window.emit("kt:titleBarState", s);
}

/// The main window's events: resized (maximised, restored, full screen) or brought to the front or left → the page
/// told, when that changed its state.
pub fn on_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main" {
        return;
    }
    match event {
        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_) => tell(window),
        _ => {}
    }
}

/// app:titleBar's place: { own?: bool, act?: "minimize" | "maximize" | "close" | "drag" } → the state. `own` asks for
/// the app's own bar or the system's frame (kept for the next start; made at once except on a Mac); `act` works the
/// window — "maximize" maximises it, or restores it when it is maximised; "drag" moves it with the mouse (called while
/// the button is held, from the page's mousedown).
#[tauri::command]
pub async fn kt_title_bar(window: tauri::Window, o: Value) -> Result<Value, String> {
    if let Some(own) = o.get("own").and_then(|b| b.as_bool()) {
        if WANTED.swap(own, Ordering::SeqCst) != own {
            keep(window.app_handle(), own);
        }
        if !cfg!(target_os = "macos") && OWN.load(Ordering::SeqCst) != own {
            window.set_decorations(!own).map_err(|e| e.to_string())?;
            OWN.store(own, Ordering::SeqCst);
        }
    }
    if let Some(act) = o.get("act").and_then(|a| a.as_str()) {
        match act {
            "minimize" => window.minimize().map_err(|e| e.to_string())?,
            "maximize" => {
                if window.is_maximized().unwrap_or(false) {
                    window.unmaximize().map_err(|e| e.to_string())?
                } else {
                    window.maximize().map_err(|e| e.to_string())?
                }
            }
            "close" => window.close().map_err(|e| e.to_string())?,
            "drag" => window.start_dragging().map_err(|e| e.to_string())?,
            other => return Err(format!("unknown window action: {}", other)),
        }
    }
    Ok(state(&window))
}
