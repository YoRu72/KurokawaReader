// Files and links the system hands the app (stage R2): desktop/main.cjs's queueFile / handleUrl / second-instance,
// done the Tauri way. What a launch carries — this one's command line (a double-click or «Open with» on Windows and
// Linux, a file given in a terminal anywhere), a second launch's (handed over by tauri-plugin-single-instance, which
// then ends the second process; this window is brought to the front), or a Mac's Apple Events (RunEvent::Opened) —
// is sorted by openargs.rs and kept here until the page takes it: the bridge's onOpenFile / onOpenUrl call
// kr_open_take when they are set up and again on each kr:openPending event. The page then reads each file's bytes
// by path (kr_read_file) — so nothing is lost when it comes before the page is ready, as main.cjs's `pending` and
// kr:ready ensure there.
use std::path::Path;
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::openargs;

static FILES: Mutex<Vec<String>> = Mutex::new(Vec::new());
static LINKS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn push(list: &Mutex<Vec<String>>, add: Vec<String>) -> bool {
    if add.is_empty() {
        return false;
    }
    let mut g = match list.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    g.extend(add);
    true
}

/// A launch's arguments (the program's own name left out) kept for the page, which is told.
pub fn queue(app: &AppHandle, args: &[String], cwd: &Path) {
    let (files, links) = openargs::sort(args, cwd, cfg!(target_os = "windows"));
    let a = push(&FILES, files);
    let b = push(&LINKS, links);
    if a || b {
        let _ = app.emit("kr:openPending", json!({}));
    }
}

/// This process's own command line (the cold start).
pub fn at_start(app: &AppHandle) {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir());
    queue(app, &args, &cwd);
}

/// A second launch, handed over by the single-instance plugin: its files and links kept, this window brought to the
/// front (main.cjs: restored if minimised, focused).
pub fn second_launch(app: &AppHandle, argv: Vec<String>, cwd: String) {
    let args: Vec<String> = argv.into_iter().skip(1).collect();
    queue(app, &args, Path::new(&cwd));
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Addresses a Mac hands over (files as file://, the app's own links): kept as a launch's arguments are.
#[allow(dead_code)]
pub fn opened(app: &AppHandle, urls: Vec<String>) {
    let cwd = std::env::temp_dir();
    queue(app, &urls, &cwd);
}

/// Whether the single-instance plugin can work here. On Linux it needs a D-Bus session bus (zbus): without one —
/// a bare X server, a CI runner — the plugin is not registered, and each launch is its own window, as before.
pub fn single_instance_possible() -> bool {
    if !cfg!(target_os = "linux") {
        return true;
    }
    if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").map(|v| !v.is_empty()).unwrap_or(false) {
        return true;
    }
    match std::env::var_os("XDG_RUNTIME_DIR") {
        Some(d) if !d.is_empty() => Path::new(&d).join("bus").exists(),
        _ => false,
    }
}

/// kr_open_take({ kind: "file" | "url" }): what is kept of that kind, handed over once — files as [{ name, path }],
/// links as their text.
#[tauri::command]
pub async fn kr_open_take(kind: String) -> Result<Value, String> {
    let list = if kind == "url" { &LINKS } else { &FILES };
    let taken: Vec<String> = {
        let mut g = match list.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        std::mem::take(&mut *g)
    };
    if kind == "url" {
        return Ok(json!(taken));
    }
    let out: Vec<Value> = taken
        .iter()
        .map(|p| json!({ "name": openargs::name_of(p), "path": p }))
        .collect();
    Ok(Value::Array(out))
}
