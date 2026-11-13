// The start (stage R6b): how long it takes and the colour the window opens in. The bridge tells the shell when the
// page first paints and when its first screen is in place (kr_boot_mark, bridge.js) and which colour its interface
// has (the page's <meta name="theme-color">); the colour is kept in <config>/boot.json and given to the window at
// the next start where this build's Tauri can (bootdetect.rs: `background_color`), so the window opens in the
// interface's own colour — no white flash. The times count from the program's start (main(), before Tauri), the
// self-test prints them (kr_boot_times), and with KR_BOOTTIME=<file> set the program writes them there and ends once
// its first screen is in place (the workflow starts the installed app twice: a cold start, then a warm one).
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::bootlogic::{self, Times};

static START: OnceLock<Instant> = OnceLock::new();
static TIMES: Mutex<Times> = Mutex::new(Times { paint: None, ready: None });

/// The program's start: called first thing in main().
pub fn mark_start() {
    START.get_or_init(Instant::now);
}

fn since_start() -> u64 {
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("boot.json"))
}

/// The colour the window opens in: the interface's at the last run, else the app's dark one.
#[allow(dead_code)]
pub fn splash(app: &AppHandle) -> (u8, u8, u8) {
    file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .map(|t| bootlogic::bg_of_file(&t))
        .unwrap_or(bootlogic::DEFAULT_BG)
}

/// The page's start marks: `what` «paint» (first paint), «ready» (its first screen in place) or «theme» (its colour
/// changed); `bg` its interface's colour (#rrggbb) → the times so far.
#[tauri::command]
pub async fn kr_boot_mark(app: AppHandle, what: String, bg: Option<String>) -> Result<Value, String> {
    let ms = since_start();
    let times = {
        let mut t = TIMES.lock().map_err(|e| e.to_string())?;
        t.mark(&what, ms);
        *t
    };
    if let Some(c) = bg.as_deref().and_then(bootlogic::parse_hex) {
        if let Some(f) = file(&app) {
            let text = bootlogic::file_of_bg(c);
            if std::fs::read_to_string(&f).ok().as_deref() != Some(text.as_str()) {
                if let Some(d) = f.parent() {
                    let _ = std::fs::create_dir_all(d);
                }
                let _ = std::fs::write(&f, text);
            }
        }
    }
    if what == "ready" {
        if let Some(out) = std::env::var_os("KR_BOOTTIME").filter(|v| !v.is_empty()) {
            let line = json!({ "paint": times.paint, "ready": times.ready, "line": times.line(), "version": app.package_info().version.to_string() });
            let _ = std::fs::write(PathBuf::from(out), format!("{}\n", line));
            let h = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(300));
                h.exit(0);
            });
        }
    }
    Ok(json!({ "paint": times.paint, "ready": times.ready, "now": ms }))
}

/// The start-up times (the self-test's row): first paint and app ready, in ms from the program's start.
#[tauri::command]
pub async fn kr_boot_times() -> Result<Value, String> {
    let t = *TIMES.lock().map_err(|e| e.to_string())?;
    Ok(json!({ "paint": t.paint, "ready": t.ready, "now": since_start(), "line": t.line(), "colourAtStart": cfg!(kr_bg_color) }))
}
