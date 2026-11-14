// The computer's side of the downloads (stage P6; desktop/main.cjs's deskPrefs, onDesktopTasks, trayUpdate, notifyDone,
// hotkeysApply, whenAllDone, openMini / closeMini, takeArg, kt:registerMagnet): the taskbar's progress (and a Mac's dock
// count), the computer kept awake while something downloads, what to do when all are done, the tray icon with the
// speed in its tooltip and its menu in the interface's language, a notice when a download finishes, the clipboard
// hotkeys, the mini window, what a launch hands the app (magnets, links, .torrent files — this one's and a second
// one's, which then ends), «make this the magnet app», and a Mac's menu bar in the interface's language. The rules are
// desklogic.rs (std only); here the windows, the plugins and the system's calls. Each uncertain call is behind a cfg
// that build.rs sets only when the resolved crate has it (apidetect.rs).
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager};

use kurokawa_shell::util;

use crate::desklogic as logic;

/// The page's script without the self-test (bridge.js after its boot line), for the mini window: set by main.rs.
pub static WEB_SCRIPT: OnceLock<String> = OnceLock::new();

const APP: &str = "Kurokawa Tools";

/// Set while the self-test's «kept awake, then let go» row holds the keep-awake itself: the downloads' own rule
/// (on_tasks) leaves it alone meanwhile — in CI run 43543617161 (macOS universal) it put it back between the row's «let
/// go» and its look, a download of an earlier row still being seen.
static AWAKE_TEST: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

enum Awake {
    Child(std::process::Child),
    #[cfg(windows)]
    Thread(std::sync::mpsc::Sender<()>),
}

#[derive(Default)]
struct Desk {
    prefs: logic::Prefs,
    watch: logic::Watch,
    /// The hotkeys as the page sent them (mode → Electron accelerator), and those registered (plugin words, mode).
    hotkeys: Map<String, Value>,
    hotkey_errors: Map<String, Value>,
    #[allow(dead_code)]
    bound: Vec<(String, String)>,
    /// The interface's words for the tray's menu and a Mac's menu bar (labels from the page).
    labels: Value,
    notice: logic::NoticeOpen,
    awake: Option<Awake>,
    awake_how: String,
    tray_on: bool,
    tray_why: String,
    last_down: f64,
    last_moving: usize,
    mini_was_min: bool,
}

static DESK: OnceLock<Mutex<Desk>> = OnceLock::new();

fn desk() -> MutexGuard<'static, Desk> {
    let m = DESK.get_or_init(|| Mutex::new(Desk::default()));
    match m.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

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

fn word(l: &Value, k: &str, en: &str) -> String {
    l.get(k).and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && s.chars().count() < 80).unwrap_or_else(|| en.to_string())
}

/// (browser.rs) One of the page's words (desktopPrefs labels), `en` when the page sent none; a true flag as "1".
pub fn label(k: &str, en: &str) -> String {
    let l = desk().labels.clone();
    match l.get(k) {
        Some(Value::Bool(true)) => "1".to_string(),
        Some(Value::String(_)) => word(&l, k, en),
        _ => en.to_string(),
    }
}

/// The main window brought back (main.cjs: show, focus; restored when minimised).
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/* ---------- the tray ---------- */

/// Whether a tray icon can be made here: on Linux only when the appindicator library is there (the tray-icon crate
/// stops the program when it is not — this app is built with panic = abort).
pub fn tray_possible() -> (bool, String) {
    if !cfg!(target_os = "linux") {
        return (true, String::new());
    }
    let ld = std::env::var("LD_LIBRARY_PATH").ok();
    let dirs = logic::lib_dirs(ld.as_deref());
    if logic::tray_lib_in(&dirs, &|p: &Path| p.exists()) {
        (true, String::new())
    } else {
        (false, "no libayatana-appindicator3 / libappindicator3 on this system".to_string())
    }
}

const TRAY_ID: &str = "kt-downloads";

/// The tray icon once made (Tauri keeps it; looked up by its id rather than held here, so nothing of it crosses threads —
/// every tray call is made on the main thread).
fn tray_icon(app: &AppHandle) -> Option<tauri::tray::TrayIcon<tauri::Wry>> {
    app.tray_by_id(TRAY_ID)
}

fn tray_menu(app: &AppHandle, l: &Value) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    let show = MenuItem::with_id(app, "kt-tray-show", word(l, "app", APP), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "kt-tray-quit", word(l, "quit", "Quit"), true, None::<&str>)?;
    Menu::with_items(app, &[&show, &PredefinedMenuItem::separator(app)?, &quit])
}

/// main.cjs's trayUpdate: the icon made (once) or hidden; its tooltip the speed over every moving download.
fn tray_update(app: &AppHandle) {
    let (on, labels, moving, down) = {
        let d = desk();
        (d.prefs.tray, d.labels.clone(), d.last_moving, d.last_down)
    };
    let mut g = tray_icon(app);
    if !on {
        if let Some(t) = g.as_ref() {
            let _ = t.set_visible(false);
        }
        desk().tray_on = false;
        return;
    }
    if g.is_none() {
        let (ok, why) = tray_possible();
        if !ok {
            let mut d = desk();
            d.tray_on = false;
            d.tray_why = why;
            return;
        }
        match build_tray(app, &labels) {
            Ok(t) => g = Some(t),
            Err(e) => {
                let mut d = desk();
                d.tray_on = false;
                d.tray_why = e;
                return;
            }
        }
    }
    if let Some(t) = g.as_ref() {
        let _ = t.set_visible(true);
        let _ = t.set_tooltip(Some(logic::tooltip(&word(&labels, "app", APP), moving, down)));
        let mut d = desk();
        d.tray_on = true;
        d.tray_why = String::new();
    }
}

fn build_tray(app: &AppHandle, labels: &Value) -> Result<tauri::tray::TrayIcon<tauri::Wry>, String> {
    use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
    let icon = tauri::image::Image::from_bytes(include_bytes!("../../../desktop/icon.png")).map_err(|e| e.to_string())?;
    let menu = tray_menu(app, labels).map_err(|e| e.to_string())?;
    let b = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(APP)
        .menu(&menu)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "kt-tray-show" => show_main(app),
            "kt-tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            // (A left click brings the window back, as Electron's; the menu is the right click's. Linux's tray gives no
            // clicks — its menu has the same item.)
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = ev {
                show_main(tray.app_handle());
            }
        });
    #[cfg(kt_tray_left)]
    let b = b.show_menu_on_left_click(false);
    #[cfg(all(kt_tray_left_old, not(kt_tray_left)))]
    let b = b.menu_on_left_click(false);
    b.build(app).map_err(|e| e.to_string())
}

/* ---------- keep awake ---------- */

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn SetThreadExecutionState(es: u32) -> u32;
}

/// Electron's powerSaveBlocker 'prevent-app-suspension': on → the system kept from sleeping (the screen may sleep);
/// off → let go. Windows: SetThreadExecutionState on a thread of its own that holds it; a Mac: caffeinate; Linux:
/// systemd-inhibit — each child ends by itself when the app does.
fn set_awake(on: bool) {
    let mut d = desk();
    if on == d.awake.is_some() {
        return;
    }
    match d.awake.take() {
        Some(Awake::Child(mut c)) => {
            let _ = c.kill();
            let _ = c.wait();
        }
        #[cfg(windows)]
        Some(Awake::Thread(tx)) => {
            let _ = tx.send(());
        }
        None => {}
    }
    if !on {
        d.awake_how = String::new();
        return;
    }
    #[cfg(windows)]
    {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let r = std::thread::Builder::new().name("kt-awake".into()).spawn(move || {
            const ES_CONTINUOUS: u32 = 0x8000_0000;
            const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
            unsafe {
                SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
            }
            let _ = rx.recv();
            unsafe {
                SetThreadExecutionState(ES_CONTINUOUS);
            }
        });
        if r.is_ok() {
            d.awake = Some(Awake::Thread(tx));
            d.awake_how = "SetThreadExecutionState".to_string();
        }
    }
    #[cfg(not(windows))]
    {
        if let Some((prog, args)) = logic::awake_command(os(), std::process::id()) {
            match std::process::Command::new(&prog).args(&args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn() {
                Ok(c) => {
                    d.awake = Some(Awake::Child(c));
                    d.awake_how = prog;
                }
                Err(e) => d.awake_how = format!("none ({}: {})", prog, e),
            }
        }
    }
}

/// Whether the keep-awake child is still running (it ends at once when its program refuses — no logind, say); when
/// it has ended, `awake_how` gets its exit code (its output is not kept: a pipe read after it ended could wait on a
/// child of its own still holding it).
fn awake_alive() -> bool {
    let mut d = desk();
    let mut why: Option<String> = None;
    let alive = match d.awake.as_mut() {
        Some(Awake::Child(c)) => match c.try_wait() {
            Ok(None) => true,
            Ok(Some(st)) => {
                why = Some(format!("ended at once, exit {}", st.code().map(|x| x.to_string()).unwrap_or_else(|| "by a signal".into())));
                false
            }
            Err(_) => false,
        },
        #[cfg(windows)]
        Some(Awake::Thread(_)) => true,
        None => false,
    };
    if let Some(w) = why {
        if !d.awake_how.contains("ended at once") {
            d.awake_how = format!("{} — {}", d.awake_how, w);
        }
    }
    alive
}

/* ---------- the taskbar ---------- */

#[cfg(kt_progress)]
fn set_progress(app: &AppHandle, p: Option<f64>) -> bool {
    let w = match app.get_webview_window("main") {
        Some(w) => w,
        None => return false,
    };
    let v = match p {
        None => json!({ "status": "none" }),
        Some(x) if x > 1.0 => json!({ "status": "indeterminate" }),
        Some(x) => json!({ "status": "normal", "progress": (x.clamp(0.0, 1.0) * 100.0).round() as u64 }),
    };
    match serde_json::from_value(v) {
        Ok(state) => w.set_progress_bar(state).is_ok(),
        Err(_) => false,
    }
}
#[cfg(not(kt_progress))]
fn set_progress(_app: &AppHandle, _p: Option<f64>) -> bool {
    false
}

#[cfg(kt_badge)]
fn set_badge(app: &AppHandle, n: usize) {
    // (main.cjs: not on Windows.)
    if cfg!(target_os = "windows") {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_badge_count(if n > 0 { Some(n as i64) } else { None });
    }
}
#[cfg(not(kt_badge))]
fn set_badge(_app: &AppHandle, _n: usize) {}

/* ---------- each list of tasks (engine.rs, when kt:tasks is sent) ---------- */

fn lite(v: &Value) -> Vec<logic::TaskLite> {
    let f = |x: &Value, k: &str| x.get(k).and_then(|n| n.as_f64()).unwrap_or(0.0);
    let s = |x: &Value, k: &str| x.get(k).and_then(|n| n.as_str()).unwrap_or("").to_string();
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|x| logic::TaskLite { id: s(x, "id"), name: s(x, "name"), state: s(x, "state"), done: f(x, "done"), total: f(x, "total"), down: f(x, "downSpeed") })
                .collect()
        })
        .unwrap_or_default()
}

/// main.cjs's onDesktopTasks.
pub fn on_tasks(app: &AppHandle, tasks: &Value) {
    if app.get_webview_window("main").is_none() {
        return;
    }
    let list = lite(tasks);
    let step = {
        let mut d = desk();
        let p = d.prefs.clone();
        let s = d.watch.step(&list, &p);
        d.last_moving = s.moving;
        d.last_down = s.down;
        s
    };
    set_progress(app, step.progress);
    set_badge(app, step.moving);
    if !AWAKE_TEST.load(std::sync::atomic::Ordering::SeqCst) {
        set_awake(step.awake);
    }
    if let Some(what) = step.when_done.clone() {
        when_all_done(app, &what);
    }
    // (Tray calls on the main thread.)
    let a2 = app.clone();
    let _ = app.run_on_main_thread(move || tray_update(&a2));
    notify(app, &step.notify);
}

fn notify(app: &AppHandle, list: &[(String, String, String)]) {
    if list.is_empty() {
        return;
    }
    use tauri_plugin_notification::NotificationExt;
    let front = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
    for (id, title, body) in list.iter() {
        if app.notification().builder().title(title).body(body).show().is_ok() {
            desk().notice.told(id, now_ms(), front);
        }
    }
}

/// main.cjs's whenAllDone: quit after 3 s; sleep or shut down after 5 s.
fn when_all_done(app: &AppHandle, what: &str) {
    let app = app.clone();
    let what = what.to_string();
    let _ = std::thread::Builder::new().name("kt-when-done".into()).spawn(move || {
        if what == "quit" {
            std::thread::sleep(Duration::from_secs(3));
            app.exit(0);
            return;
        }
        std::thread::sleep(Duration::from_secs(5));
        if let Some((prog, args)) = logic::when_done_command(&what, os()) {
            let _ = std::process::Command::new(prog).args(args).stdin(std::process::Stdio::null()).spawn();
        }
    });
}

/* ---------- the clipboard hotkeys ---------- */

#[cfg(kt_shortcuts)]
pub fn shortcuts_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_global_shortcut::{Shortcut, ShortcutEvent, ShortcutState};
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app: &AppHandle, sc: &Shortcut, ev: ShortcutEvent| {
            if !matches!(ev.state(), ShortcutState::Pressed) {
                return;
            }
            let mode = {
                let d = desk();
                d.bound.iter().find(|(w, _)| w.parse::<Shortcut>().map(|s| &s == sc).unwrap_or(false)).map(|(_, m)| m.clone())
            };
            if let Some(mode) = mode {
                hotkey_fired(app, &mode);
            }
        })
        .build()
}

/// Whether the global-shortcut plugin can start here: on Linux it needs an X display (it grabs keys through X11).
pub fn shortcuts_possible() -> bool {
    !cfg!(target_os = "linux") || std::env::var_os("DISPLAY").map(|v| !v.is_empty()).unwrap_or(false)
}

/// A hotkey pressed: the clipboard's text to the page with its mode (kt:hotkeyAdd), the window brought back.
fn hotkey_fired(app: &AppHandle, mode: &str) {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let text = app.clipboard().read_text().unwrap_or_default();
    let _ = app.emit("kt:hotkeyAdd", json!({ "mode": mode, "text": text }));
    show_main(app);
}

/// main.cjs's hotkeysApply: every one let go, each chosen registered; what could not be in hotkeyErrors { mode: why },
/// why being 'key' (a key or modifier this shell has no name for), 'taken' (the system refused it: another program
/// holds it) or 'none' (no global shortcuts here: Linux without an X display, or a build without the plugin's API) —
/// the page says each in its language. Electron dropped those silently. The system's own words go to the log.
fn hotkeys_apply(app: &AppHandle) {
    let wanted: Vec<(String, String)> = {
        let d = desk();
        d.hotkeys.iter().filter_map(|(m, a)| a.as_str().filter(|s| !s.trim().is_empty()).map(|s| (m.clone(), s.to_string()))).collect()
    };
    let mut errors = Map::new();
    let mut bound: Vec<(String, String)> = Vec::new();
    #[cfg(kt_shortcuts)]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        if shortcuts_possible() {
            let gs = app.global_shortcut();
            let _ = gs.unregister_all();
            for (mode, acc) in wanted.iter() {
                match logic::accelerator(acc) {
                    Err(e) => {
                        eprintln!("KT hotkey {} «{}»: {}", mode, acc, e);
                        errors.insert(mode.clone(), json!("key"));
                    }
                    Ok(w) => match gs.register(w.as_str()) {
                        Ok(()) => bound.push((w, mode.clone())),
                        Err(e) => {
                            eprintln!("KT hotkey {} «{}»: {}", mode, w, e);
                            errors.insert(mode.clone(), json!("taken"));
                        }
                    },
                }
            }
        } else {
            for (mode, _) in wanted.iter() {
                errors.insert(mode.clone(), json!("none"));
            }
        }
    }
    #[cfg(not(kt_shortcuts))]
    {
        let _ = app;
        for (mode, _) in wanted.iter() {
            errors.insert(mode.clone(), json!("none"));
        }
    }
    let mut d = desk();
    d.bound = bound;
    d.hotkey_errors = errors;
}

/* ---------- kt:desktopPrefs ---------- */

fn prefs_value(d: &Desk) -> Value {
    let mut v = json!({
        "keepAwake": d.prefs.keep_awake,
        "whenDone": d.prefs.when_done,
        "notifyDone": d.prefs.notify_done,
        "tray": d.prefs.tray,
        "hotkeys": Value::Object(d.hotkeys.clone()),
    });
    if !d.hotkey_errors.is_empty() {
        v["hotkeyErrors"] = Value::Object(d.hotkey_errors.clone());
    }
    v
}

/// kt:desktopPrefs(o) → the choices in force (main.cjs's deskPrefs). Each of keepAwake, whenDone, notifyDone, tray,
/// hotkeys taken when given, as main.cjs; this shell also takes `labels` (the interface's words for the tray's menu and
/// a Mac's menu bar: app, quit, …) and answers `hotkeyErrors` { mode: why } for the hotkeys it could not register.
#[tauri::command]
pub async fn kt_desktop_prefs(app: AppHandle, o: Value) -> Result<Value, String> {
    let mut tray_changed = false;
    let mut keys_changed = false;
    if o.is_object() {
        let mut d = desk();
        if let Some(v) = o.get("keepAwake") {
            d.prefs.keep_awake = truthy(v);
        }
        if let Some(w) = o.get("whenDone").and_then(|v| v.as_str()) {
            if logic::when_done_ok(w) {
                d.prefs.when_done = w.to_string();
            }
        }
        if let Some(v) = o.get("notifyDone") {
            d.prefs.notify_done = truthy(v);
        }
        if let Some(v) = o.get("tray") {
            d.prefs.tray = truthy(v);
            tray_changed = true;
        }
        if let Some(l) = o.get("labels").filter(|l| l.is_object()) {
            d.labels = l.clone();
            tray_changed = true;
        }
        if let Some(h) = o.get("hotkeys").and_then(|v| v.as_object()) {
            d.hotkeys = h.clone();
            keys_changed = true;
        }
    }
    if keys_changed {
        hotkeys_apply(&app);
    }
    if tray_changed {
        let a2 = app.clone();
        let relabel = o.get("labels").filter(|l| l.is_object()).cloned();
        let _ = app.run_on_main_thread(move || {
            // (A label change: the menu made again in the new words.)
            if let Some(l) = relabel {
                if let Some(t) = tray_icon(&a2) {
                    if let Ok(m) = tray_menu(&a2, &l) {
                        let _ = t.set_menu(Some(m));
                    }
                }
            }
            tray_update(&a2);
        });
        mac_menu_later(&app, &o);
    }
    if o.get("keepAwake").is_some() {
        let awake = {
            let d = desk();
            d.prefs.keep_awake && d.last_moving > 0
        };
        set_awake(awake);
    }
    let d = desk();
    Ok(prefs_value(&d))
}

/// The page's words given: a Mac's menu bar made again in them (on the main thread); nothing elsewhere.
#[cfg(target_os = "macos")]
fn mac_menu_later(app: &AppHandle, o: &Value) {
    if let Some(l) = o.get("labels").filter(|l| l.is_object()).cloned() {
        let a3 = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = mac_menu(&a3, &l);
        });
    }
}
#[cfg(not(target_os = "macos"))]
fn mac_menu_later(_app: &AppHandle, _o: &Value) {}

/* ---------- a Mac's menu bar (Electron's: the app's, File, Edit, View, Window — its roles), in the interface's words ---------- */

#[cfg(target_os = "macos")]
fn mac_menu(app: &AppHandle, l: &Value) -> tauri::Result<()> {
    use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
    let p = |k: &str, en: &str| word(l, k, en);
    let about = PredefinedMenuItem::about(app, Some(p("about", "About Kurokawa Tools").as_str()), None)?;
    let app_menu = Submenu::with_items(
        app,
        APP,
        true,
        &[
            &about,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(p("hide", "Hide Kurokawa Tools").as_str()))?,
            &PredefinedMenuItem::hide_others(app, Some(p("hideOthers", "Hide Others").as_str()))?,
            &PredefinedMenuItem::show_all(app, Some(p("showAll", "Show All").as_str()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(p("quitApp", "Quit Kurokawa Tools").as_str()))?,
        ],
    )?;
    let file = Submenu::with_items(app, p("file", "File"), true, &[&PredefinedMenuItem::close_window(app, Some(p("closeWindow", "Close Window").as_str()))?])?;
    let edit = Submenu::with_items(
        app,
        p("edit", "Edit"),
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(p("undo", "Undo").as_str()))?,
            &PredefinedMenuItem::redo(app, Some(p("redo", "Redo").as_str()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(p("cut", "Cut").as_str()))?,
            &PredefinedMenuItem::copy(app, Some(p("copy", "Copy").as_str()))?,
            &PredefinedMenuItem::paste(app, Some(p("paste", "Paste").as_str()))?,
            &PredefinedMenuItem::select_all(app, Some(p("selectAll", "Select All").as_str()))?,
        ],
    )?;
    let view = Submenu::with_items(app, p("view", "View"), true, &[&PredefinedMenuItem::fullscreen(app, Some(p("fullscreen", "Enter Full Screen").as_str()))?])?;
    let window = Submenu::with_items(
        app,
        p("window", "Window"),
        true,
        &[&PredefinedMenuItem::minimize(app, Some(p("minimize", "Minimize").as_str()))?, &PredefinedMenuItem::maximize(app, Some(p("zoom", "Zoom").as_str()))?],
    )?;
    let menu = Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])?;
    app.set_menu(menu)?;
    Ok(())
}

/* ---------- the mini window ---------- */

fn mini_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("mini-state.json"))
}

fn mini_state(app: &AppHandle) -> Value {
    mini_path(app).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(|v| v.is_object()).unwrap_or_else(|| json!({}))
}

fn mini_save(app: &AppHandle, patch: Value) {
    let mut st = mini_state(app);
    if let (Some(o), Some(p)) = (st.as_object_mut(), patch.as_object()) {
        for (k, v) in p.iter() {
            o.insert(k.clone(), v.clone());
        }
    }
    if let Some(p) = mini_path(app) {
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(p, st.to_string());
    }
}

/// main.cjs's openMini: 320×200 (at least 260×120), no frame, above the others, not on the taskbar, on every desktop,
/// where it was last left; the page's #/mini (the bridge without the self-test).
pub fn open_mini(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("mini") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let st = mini_state(app);
    let script = format!(
        "{}\n;try{{if(!String(location.hash).startsWith('#/mini'))history.replaceState(null,'','#/mini');}}catch(e){{}}",
        WEB_SCRIPT.get().map(|s| s.as_str()).unwrap_or("")
    );
    let mut b = tauri::WebviewWindowBuilder::new(app, "mini", tauri::WebviewUrl::App("index.html".into()))
        .title(APP)
        .inner_size(320.0, 200.0)
        .min_inner_size(260.0, 120.0)
        .decorations(false)
        .resizable(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .maximizable(false)
        .minimizable(false)
        .disable_drag_drop_handler()
        .initialization_script(script.as_str());
    if let (Some(x), Some(y)) = (st.get("x").and_then(|v| v.as_f64()), st.get("y").and_then(|v| v.as_f64())) {
        b = b.position(x, y);
    }
    // (On every desktop, as Electron's setVisibleOnAllWorkspaces — where build.rs found the builder's call.)
    #[cfg(kt_all_spaces)]
    {
        b = b.visible_on_all_workspaces(true);
    }
    b.build().map(|_| ()).map_err(|e| e.to_string())
}

fn close_mini(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("mini") {
        let _ = w.close();
    }
}

/// The main window's and the mini window's events: the mini's place kept; the mini closed with the main window; the
/// mini opened when the main window is minimised and closed when it is restored, if chosen (main.cjs's miniOnMinimize);
/// a notice's download opened when the window comes to the front soon after it (the nearest thing to its click).
pub fn on_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let app = window.app_handle().clone();
    match (window.label(), event) {
        ("mini", tauri::WindowEvent::Moved(p)) => {
            if let Ok(sf) = window.scale_factor() {
                let l = p.to_logical::<f64>(sf);
                mini_save(&app, json!({ "x": l.x, "y": l.y }));
            }
        }
        ("main", tauri::WindowEvent::Destroyed) => close_mini(&app),
        ("main", tauri::WindowEvent::Focused(true)) => {
            let id = desk().notice.focused(now_ms());
            if let Some(id) = id {
                let _ = app.emit("kt:openTask", id);
            }
        }
        ("main", tauri::WindowEvent::Resized(_)) => {
            let min = window.is_minimized().unwrap_or(false);
            let was = {
                let mut d = desk();
                let w = d.mini_was_min;
                d.mini_was_min = min;
                w
            };
            if min != was && mini_state(&app).get("miniOnMinimize").and_then(|v| v.as_bool()).unwrap_or(false) {
                // (Windows are made off the event loop's own call.)
                let a2 = app.clone();
                let _ = std::thread::Builder::new().spawn(move || {
                    if min {
                        let _ = open_mini(&a2);
                    } else {
                        close_mini(&a2);
                    }
                });
            }
        }
        _ => {}
    }
}

/// kt:mini(o) → { open }: 'open', 'close', 'main' (the main window brought back), 'auto' (o.on: the mini window when
/// the main one is minimised) — main.cjs's.
#[tauri::command]
pub async fn kt_mini(app: AppHandle, o: Value) -> Result<Value, String> {
    match o.get("action").and_then(|v| v.as_str()).unwrap_or("") {
        "open" => open_mini(&app)?,
        "close" => close_mini(&app),
        "main" => show_main(&app),
        "auto" => mini_save(&app, json!({ "miniOnMinimize": o.get("on").map(truthy).unwrap_or(false) })),
        _ => {}
    }
    // (A window being closed still answers to its label for a moment.)
    let open = match app.get_webview_window("mini") {
        Some(_) if o.get("action").and_then(|v| v.as_str()) == Some("close") => false,
        Some(_) => true,
        None => false,
    };
    Ok(json!({ "open": open }))
}

/* ---------- what the system hands the app: launches, a second launch, a Mac's Apple Events ---------- */

static LINKS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// A launch's arguments (the program's name left out): links kept for the page (kt:open), .torrent files read into
/// data: addresses (main.cjs's takeArg); the page told (kt:openPending).
pub fn queue(app: &AppHandle, args: &[String], cwd: &Path) {
    let items = logic::sort_args(args, cwd, cfg!(windows), &|p: &Path| p.is_file());
    let mut add: Vec<String> = Vec::new();
    for it in items {
        match it {
            logic::Arg::Link(u) => add.push(u),
            logic::Arg::Torrent(p) => {
                let small = std::fs::metadata(&p).map(|m| m.len() <= logic::TORRENT_MAX).unwrap_or(false);
                if let (true, Ok(b)) = (small, std::fs::read(&p)) {
                    add.push(format!("data:application/x-bittorrent;base64,{}", util::b64_encode(&b)));
                }
            }
        }
    }
    if add.is_empty() {
        return;
    }
    match LINKS.lock() {
        Ok(mut g) => g.extend(add),
        Err(p) => p.into_inner().extend(add),
    }
    let _ = app.emit("kt:openPending", json!({}));
}

/// This process's own command line (a cold start).
pub fn at_start(app: &AppHandle) {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir());
    queue(app, &args, &cwd);
}

/// A second launch, handed over by the single-instance plugin (which ends it): its links kept, this window brought to
/// the front (main.cjs's second-instance).
pub fn second_launch(app: &AppHandle, argv: Vec<String>, cwd: String) {
    let args: Vec<String> = argv.into_iter().skip(1).collect();
    queue(app, &args, Path::new(&cwd));
    show_main(app);
}

/// Addresses a Mac hands over (magnet:, kurokawatools:, a .torrent as file://).
#[allow(dead_code)]
pub fn opened(app: &AppHandle, urls: Vec<String>) {
    queue(app, &urls, &std::env::temp_dir());
}

/// Whether the single-instance plugin can work here (on Linux it needs a D-Bus session bus) — the Reader's rule.
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

/// (This shell's own: the bridge hands each to the page as the preload's kt:open DOM event once the page listens.)
/// The links kept, handed over once.
#[tauri::command]
pub async fn kt_open_take() -> Result<Value, String> {
    let taken: Vec<String> = match LINKS.lock() {
        Ok(mut g) => std::mem::take(&mut *g),
        Err(p) => std::mem::take(&mut *p.into_inner()),
    };
    Ok(json!(taken))
}

/// kt:registerMagnet → true: this program made the system's magnet app, as Electron's setAsDefaultProtocolClient —
/// Windows: HKCU\Software\Classes\magnet (reg.exe); Linux: the desktop entry that runs this program set as the handler
/// (xdg-mime), where there is one (the .deb's; an AppImage registers nothing); a Mac: the bundle's Info.plist names the
/// scheme (tauri.conf.json) — the system asks the user, nothing to write.
#[tauri::command]
pub async fn kt_register_magnet() -> Result<bool, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        for a in logic::magnet_reg_args(&exe.to_string_lossy()) {
            let st = std::process::Command::new("reg").args(&a).creation_flags(0x0800_0000).status().map_err(|e| e.to_string())?;
            if !st.success() {
                return Err(format!("reg {}", a.join(" ")));
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        let name = exe.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let mut dirs: Vec<PathBuf> = vec![PathBuf::from("/usr/share/applications"), PathBuf::from("/usr/local/share/applications")];
        if let Some(h) = std::env::var_os("HOME") {
            dirs.insert(0, PathBuf::from(h).join(".local/share/applications"));
        }
        let entry = dirs.iter().filter_map(|d| std::fs::read_dir(d).ok()).flat_map(|rd| rd.flatten()).find_map(|e| {
            let p = e.path();
            let fname = p.file_name()?.to_string_lossy().into_owned();
            if !fname.ends_with(".desktop") {
                return None;
            }
            let t = std::fs::read_to_string(&p).ok()?;
            if logic::desktop_entry_runs(&t, &name) {
                Some(fname)
            } else {
                None
            }
        });
        if let Some(e) = entry {
            let _ = std::process::Command::new("xdg-mime").args(["default", e.as_str(), "x-scheme-handler/magnet"]).status();
        }
    }
    let _ = exe;
    Ok(true)
}

/* ---------- the self-test ---------- */

/// (Self-test only.) { act }: 'state' → what this shell made of the prefs (tray, keep-awake, hotkeys, single
/// instance); 'progress' { p } → whether the taskbar took it; 'notify' → whether a notice was shown; 'hotkey' { mode }
/// → the hotkey's handling run as a press would (kt:hotkeyAdd); 'awake' { on }; 'second' { args } → a second launch of
/// this program with those arguments (without the self-test's settings), waited for; 'windows' → the windows' labels.
#[tauri::command]
pub async fn kt_selftest_desk(app: AppHandle, o: Value) -> Result<Value, String> {
    if !kurokawa_shell::selftest::active() {
        return Err("not a self-test run".to_string());
    }
    let act = o.get("act").and_then(|v| v.as_str()).unwrap_or("").to_string();
    match act.as_str() {
        "state" => {
            let (tray_ok, tray_why0) = tray_possible();
            let alive = awake_alive();
            let d = desk();
            Ok(json!({
                "trayPossible": tray_ok, "tray": d.tray_on, "trayWhy": if d.tray_why.is_empty() { tray_why0 } else { d.tray_why.clone() },
                "awake": d.awake.is_some(), "awakeAlive": alive, "awakeHow": d.awake_how,
                "bound": d.bound.iter().map(|(w, m)| json!([w, m])).collect::<Vec<_>>(),
                "shortcuts": cfg!(kt_shortcuts) && shortcuts_possible(),
                "single": single_instance_possible(), "progressApi": cfg!(kt_progress), "os": os(),
            }))
        }
        "progress" => Ok(json!(set_progress(&app, o.get("p").and_then(|v| v.as_f64()).filter(|p| *p >= 0.0)))),
        "notify" => {
            use tauri_plugin_notification::NotificationExt;
            Ok(json!(app.notification().builder().title(APP).body("Self-test notice").show().is_ok()))
        }
        "hotkey" => {
            hotkey_fired(&app, o.get("mode").and_then(|v| v.as_str()).unwrap_or("test"));
            Ok(json!(true))
        }
        "awake" => {
            // (The row's own: the downloads' rule kept off it from «on» until its «off» has been looked at.)
            let on = o.get("on").map(truthy).unwrap_or(false);
            AWAKE_TEST.store(true, std::sync::atomic::Ordering::SeqCst);
            set_awake(on);
            std::thread::sleep(Duration::from_millis(400));
            let alive = awake_alive();
            let r = {
                let d = desk();
                json!({ "awake": d.awake.is_some(), "alive": alive, "how": d.awake_how })
            };
            if !on {
                AWAKE_TEST.store(false, std::sync::atomic::Ordering::SeqCst);
            }
            Ok(r)
        }
        "second" => {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let args: Vec<String> = o.get("args").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
            let r = tauri::async_runtime::spawn_blocking(move || {
                let mut c = std::process::Command::new(exe);
                c.args(&args).env_remove("KT_SELFTEST").env_remove("KT_SELFTEST_TIMEOUT").env_remove("KT_SELFTEST_PART");
                // (What it says kept — the end of it — so a launch that does not end says why: CI run 43543617161 on
                // Linux only showed «ended: false». Read on a thread of its own and never waited for: a web view
                // process it started could hold the pipe after it is gone.)
                c.stderr(std::process::Stdio::piped());
                let mut child = c.spawn().map_err(|e| e.to_string())?;
                let said = std::sync::Arc::new(Mutex::new(Vec::<u8>::new()));
                if let Some(mut e) = child.stderr.take() {
                    let s2 = said.clone();
                    let _ = std::thread::Builder::new().name("kt-second-err".into()).spawn(move || {
                        use std::io::Read;
                        let mut b = [0u8; 2048];
                        while let Ok(n) = e.read(&mut b) {
                            if n == 0 {
                                break;
                            }
                            if let Ok(mut g) = s2.lock() {
                                g.extend_from_slice(&b[..n]);
                                if g.len() > 4000 {
                                    let cut = g.len() - 2000;
                                    g.drain(..cut);
                                }
                            }
                        }
                    });
                }
                let tail = |said: &std::sync::Arc<Mutex<Vec<u8>>>| -> String {
                    let t = said.lock().map(|g| String::from_utf8_lossy(&g[..]).into_owned()).unwrap_or_default();
                    let t = t.trim();
                    let n = t.chars().count();
                    t.chars().skip(n.saturating_sub(600)).collect()
                };
                for _ in 0..150 {
                    if let Ok(Some(st)) = child.try_wait() {
                        return Ok(json!({ "ended": true, "code": st.code() }));
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                let _ = child.kill();
                let _ = child.wait();
                std::thread::sleep(Duration::from_millis(200));
                Ok::<Value, String>(json!({ "ended": false, "said": tail(&said) }))
            })
            .await
            .map_err(|e| e.to_string())??;
            Ok(r)
        }
        "windows" => {
            let mut out: Vec<Value> = Vec::new();
            for (label, w) in app.webview_windows() {
                out.push(json!({ "label": label, "visible": w.is_visible().unwrap_or(false), "decorated": w.is_decorated().unwrap_or(true) }));
            }
            Ok(Value::Array(out))
        }
        _ => Err(format!("unknown act {}", act)),
    }
}
