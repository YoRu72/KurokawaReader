// The screen translator on a computer (stage P9 part — desktop/screentr.cjs, the «Translate on screen» add-on): its
// eight channels (kt:screenConfig, kt:screenStatus, kt:screenAction, kt:screenJob, kt:screenRegion, kt:screenClose,
// kt:screenOcrLangs, kt:screenCaption — the caption's size — and the kt:screenCaption event), its shortcuts (one
// registry with the clipboard hotkeys: desktop.rs's hotkeys_apply lets every key go and then calls register_keys), its
// tray icon and menu, close-to-tray while it is on, starting with the computer (--hidden), and its windows: the frozen
// screen (`kts-overlay`, #/overlay), «auto»'s caption under the watched region (`kts-caption`, click-through, not
// focusable where the build has it, transparent but on a Mac), the clipboard's translation by the mouse (`kts-popup`).
// The capture is screencap.rs (each system's own facility); the OCR the same helpers Electron runs — Windows OCR through
// the same PowerShell script, Vision through the same JavaScript for Automation script, Tesseract's TSV —, each run
// directly (no shell; no console window; its tree ended when «auto» stops). The rules are kt-core's screenlogic.rs.
// What differs from Electron is said where it happens and in ../PORTING.md («The screen translator»).
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager};

use kt_core::screenlogic as logic;
use logic::{DipRect, Mon, Rect};

use crate::screencap;

pub const OVERLAY: &str = "kts-overlay";
pub const CAPTION: &str = "kts-caption";
pub const POPUP: &str = "kts-popup";
const TEST_WIN: &str = "kts-test";
const TRAY_ID: &str = "kt-screen";
const APP: &str = "Kurokawa Tools";

struct Job {
    mode: String,
    image: String,
    width: u32,
    height: u32,
    scale: f64,
    text: Option<String>,
    display: String,
    rgba: Arc<Vec<u8>>,
}

#[derive(Default)]
struct St {
    loaded: bool,
    cfg: Value,
    region: Option<Value>,
    job: Option<Job>,
    /// The shortcuts registered: (the plugin's words, the action).
    #[allow(dead_code)]
    bound: Vec<(String, String)>,
    key_ok: Map<String, Value>,
    tray_on: bool,
    tray_why: String,
    auto: bool,
    auto_text: logic::AutoText,
    auto_sent: u64,
    last_error: String,
    /// Why «auto» last stopped (the self-test says it when a run ends unasked).
    auto_stop_why: String,
    /// The front window before and after the caption was shown (Windows), for the self-test.
    caption_fg: String,
    /// The current caption's Win32 title (Windows: how the self-test asks the system about it).
    caption_title: String,
    caption_click_through: Option<bool>,
    asked_permission: bool,
    login_set: bool,
    /// Start-at-log-in as this app last saw it (None before its first settings): screenlogic login_act.
    startup_prev: Option<bool>,
}

static ST: OnceLock<Mutex<St>> = OnceLock::new();
/// «auto»'s run: bumped at each start and stop, so a tick of a stopped run ends.
static AUTO_GEN: AtomicU64 = AtomicU64::new(0);
/// The OCR helpers running now (their process ids), ended with their trees when «auto» stops or the app ends.
static OCR_PIDS: Mutex<Vec<u32>> = Mutex::new(Vec::new());
static APP_DIR: OnceLock<PathBuf> = OnceLock::new();

fn st() -> MutexGuard<'static, St> {
    let m = ST.get_or_init(|| Mutex::new(St::default()));
    match m.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
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
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|x| x != 0.0 && !x.is_nan()).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn pc(cfg: &Value) -> Value {
    cfg.get("pc").filter(|v| v.is_object()).cloned().unwrap_or_else(|| json!({}))
}

fn enabled(s: &St) -> bool {
    truthy(s.cfg.get("pcOn"))
}

fn label(cfg: &Value, k: &str, d: &str) -> String {
    cfg.get("labels").and_then(|l| l.get(k)).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| d.to_string())
}

fn keys_of(cfg: &Value) -> Vec<(String, String)> {
    let p = pc(cfg);
    let given = p.get("keys").cloned().unwrap_or(Value::Null);
    logic::merged_keys(&|k: &str| match given.get(k) {
        None => None,
        Some(Value::String(s)) => Some(Some(s.clone())),
        Some(_) => Some(None),
    })
}

fn data_dir() -> PathBuf {
    APP_DIR.get().cloned().unwrap_or_else(|| std::env::temp_dir().join("kurokawa-tools"))
}

fn cfg_path() -> PathBuf {
    data_dir().join("screen.json")
}
fn region_path() -> PathBuf {
    data_dir().join("screen-region.json")
}
fn state_path() -> PathBuf {
    data_dir().join("screen-state.json")
}

fn load(s: &mut St) {
    if s.loaded {
        return;
    }
    s.loaded = true;
    s.cfg = std::fs::read_to_string(cfg_path()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(|v| v.is_object()).unwrap_or_else(|| json!({}));
    s.region = std::fs::read_to_string(region_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|r| r.get("width").and_then(|w| w.as_f64()).map(|w| w > 4.0).unwrap_or(false));
    let mine = std::fs::read_to_string(state_path()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(Value::Null);
    s.asked_permission = truthy(mine.get("askedPermission"));
    s.login_set = truthy(mine.get("loginSet"));
    s.startup_prev = mine.get("startupPrev").and_then(|v| v.as_bool());
}

fn save_state(s: &St) {
    let _ = std::fs::create_dir_all(data_dir());
    let _ = std::fs::write(state_path(), json!({ "askedPermission": s.asked_permission, "loginSet": s.login_set, "startupPrev": s.startup_prev }).to_string());
}

/* ---------- set up (main.rs) ---------- */

/// Set up after the main window is made: the settings and the region kept read, shortcuts / tray / start-with-the-
/// computer applied, and a --hidden start (the computer's log-in) left in the tray when chosen.
pub fn init(app: &AppHandle) {
    if let Ok(d) = app.path().app_data_dir() {
        let _ = APP_DIR.set(d);
    }
    let hide = {
        let mut s = st();
        load(&mut s);
        std::env::args().any(|a| a == "--hidden") && enabled(&s) && truthy(pc(&s.cfg).get("tray"))
    };
    let a2 = app.clone();
    let _ = std::thread::Builder::new().name("kt-screen-init".into()).spawn(move || {
        apply(&a2);
        if hide {
            // (Hidden only once its tray icon is there — the tray is made on the main thread; a system with no tray
            // keeps the window, or the app could not be reached.)
            for _ in 0..40 {
                if keep_in_tray() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            if keep_in_tray() {
                if let Some(w) = a2.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
        }
    });
}

/// screentr.cjs's apply: the shortcuts (through desktop.rs's one registry), the tray, start with the computer, «auto»
/// stopped when turned off.
fn apply(app: &AppHandle) {
    crate::desktop::hotkeys_again(app);
    let a2 = app.clone();
    let _ = app.run_on_main_thread(move || tray_apply(&a2));
    login_apply();
    let off = !enabled(&st());
    if off {
        stop_auto_why(app, "the screen translator turned off");
    }
}

/// The screen translator's shortcuts, registered after the clipboard hotkeys (desktop.rs's hotkeys_apply calls this
/// after letting every key go); each one's state for kt:screenStatus.
pub fn register_keys(app: &AppHandle) {
    let (on, keys) = {
        let s = st();
        (enabled(&s), keys_of(&s.cfg))
    };
    let mut ok = Map::new();
    let mut bound: Vec<(String, String)> = Vec::new();
    #[cfg(kt_shortcuts)]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        if on && crate::desktop::shortcuts_possible() {
            let gs = app.global_shortcut();
            for (k, acc) in keys.iter() {
                if acc.trim().is_empty() {
                    continue;
                }
                match crate::desklogic::accelerator(acc) {
                    Ok(w) => match gs.register(w.as_str()) {
                        Ok(()) => {
                            bound.push((w, k.clone()));
                            ok.insert(k.clone(), json!(true));
                        }
                        Err(e) => eprintln!("KT screen key {} «{}»: {}", k, acc, e),
                    },
                    Err(e) => eprintln!("KT screen key {} «{}»: {}", k, acc, e),
                }
            }
        }
    }
    let _ = (app, on, &keys);
    let mut s = st();
    s.bound = bound;
    s.key_ok = ok;
}

/// A shortcut pressed that is not a clipboard hotkey (desktop.rs's handler asks here): its action, off the event loop.
#[cfg(kt_shortcuts)]
pub fn on_shortcut(app: &AppHandle, sc: &tauri_plugin_global_shortcut::Shortcut) {
    let what = {
        let s = st();
        s.bound.iter().find(|(w, _)| w.parse::<tauri_plugin_global_shortcut::Shortcut>().map(|x| &x == sc).unwrap_or(false)).map(|(_, a)| a.clone())
    };
    if let Some(w) = what {
        act_later(app, &w);
    }
}

fn act_later(app: &AppHandle, what: &str) {
    let a2 = app.clone();
    let w = what.to_string();
    let _ = std::thread::Builder::new().name("kt-screen-act".into()).spawn(move || act(&a2, &w));
}

/// The self-test's page on Linux, served over loopback (the server started once, in a self-test run only) → its address.
fn test_page_url(page: String) -> Result<String, String> {
    static SERVER: OnceLock<Option<(crate::vtfake::Server, u16)>> = OnceLock::new();
    let got = SERVER.get_or_init(|| {
        let s = crate::vtfake::Server::new();
        s.start().ok().map(|port| (s, port))
    });
    let (s, port) = got.as_ref().ok_or_else(|| "the test page's server did not start".to_string())?;
    s.set("/kt-screen-test.html", crate::vtfake::Route { body: std::sync::Arc::new(page.into_bytes()), ctype: "text/html; charset=utf-8", slow: false, cut: None });
    Ok(format!("http://127.0.0.1:{}/kt-screen-test.html", port))
}

/* ---------- starting with the computer ---------- */

/// Electron's setLoginItemSettings({ openAtLogin: on && startup, args: ['--hidden'] }) — not on Linux, as Electron.
/// Windows: the Run key (reg.exe); a Mac: a launch agent. Removed only when this app set it.
fn login_apply() {
    let (want, was, prev) = {
        let s = st();
        (enabled(&s) && truthy(pc(&s.cfg).get("startup")), s.login_set, s.startup_prev)
    };
    if cfg!(target_os = "linux") {
        return;
    }
    let exe = match std::env::current_exe() {
        Ok(e) => e.to_string_lossy().into_owned(),
        Err(_) => return,
    };
    // (Stage P9: an earlier Electron copy kept beside this one that starts with the computer itself — its own Run value
    // naming its program — gets no second beside it unless the person turns it on HERE; the hand-over's bridge build
    // and the installer's replace take the old one away — screenlogic login_act.)
    let act = logic::login_act(want, was, if want && !was { electron_login_live(&exe) } else { false }, prev);
    if prev != Some(want) {
        let mut s = st();
        s.startup_prev = Some(want);
        save_state(&s);
    }
    if act == logic::LoginAct::Nothing {
        return;
    }
    let want = act == logic::LoginAct::Add;
    let mut done = false;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let a = logic::run_key_args("Kurokawa Tools", &exe, want);
        done = std::process::Command::new("reg").args(&a).creation_flags(0x0800_0000).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().map(|s| s.success()).unwrap_or(false) || !want;
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(h) = std::env::var_os("HOME") {
            let dir = PathBuf::from(h).join("Library/LaunchAgents");
            let f = dir.join("app.kurokawa.tools.screen.plist");
            done = if want {
                let _ = std::fs::create_dir_all(&dir);
                std::fs::write(&f, logic::launch_agent_plist("app.kurokawa.tools.screen", &exe)).is_ok()
            } else {
                let _ = std::fs::remove_file(&f);
                true
            };
        }
    }
    if done {
        let mut s = st();
        s.login_set = want;
        save_state(&s);
    }
}

/// Whether the earlier Electron build starts with the computer by itself: Windows — its Run value (by its
/// AppUserModelId) names a program that is there and is not this one. (A Mac's Electron login item is the system's
/// own list, not readable without asking: not looked at — the bridge build turns its own off at the hand-over.)
fn electron_login_live(exe: &str) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        for name in logic::ELECTRON_RUN_VALUES.iter() {
            let out = std::process::Command::new("reg").args(["query", logic::RUN_KEY, "/v", name]).creation_flags(0x0800_0000).stderr(std::process::Stdio::null()).output();
            if let Ok(o) = out {
                if let Some(d) = logic::reg_value_data(&String::from_utf8_lossy(&o.stdout), name) {
                    let prog = logic::run_program(&d);
                    if !prog.is_empty() && !prog.eq_ignore_ascii_case(exe) && Path::new(&prog).is_file() {
                        return true;
                    }
                }
            }
        }
        false
    }
    #[cfg(not(windows))]
    {
        let _ = exe;
        false
    }
}

/* ---------- the tray ---------- */

fn tray_menu(app: &AppHandle, with_keys: bool) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    let (cfg, has_region, auto) = {
        let s = st();
        (s.cfg.clone(), s.region.is_some(), s.auto)
    };
    let keys: Map<String, Value> = keys_of(&cfg).into_iter().map(|(k, v)| (k, Value::String(v))).collect();
    let acc = |k: &str| -> Option<String> {
        if !with_keys {
            return None;
        }
        keys.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty() && crate::desklogic::accelerator(s).is_ok()).map(String::from)
    };
    let region = MenuItem::with_id(app, "kts-region", label(&cfg, "region", "Translate a region"), true, acc("region"))?;
    let full = MenuItem::with_id(app, "kts-full", label(&cfg, "translateScreen", "Translate the screen"), true, acc("full"))?;
    let again = MenuItem::with_id(app, "kts-repeat", label(&cfg, "fixed", "Translate the last region again"), has_region, acc("repeat"))?;
    let auto_item = MenuItem::with_id(
        app,
        "kts-auto",
        if auto { label(&cfg, "autoOff", "Stop auto translation") } else { label(&cfg, "autoOn", "Auto translate the last region") },
        has_region || auto,
        acc("auto"),
    )?;
    let clip = MenuItem::with_id(app, "kts-clipboard", label(&cfg, "clipboard", "Translate the clipboard"), true, acc("clipboard"))?;
    let open = MenuItem::with_id(app, "kts-open", label(&cfg, "openApp", "Open the app"), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "kts-quit", label(&cfg, "quit", "Quit"), true, None::<&str>)?;
    Menu::with_items(app, &[&region, &full, &again, &auto_item, &clip, &PredefinedMenuItem::separator(app)?, &open, &quit])
}

fn tray_menu_safe(app: &AppHandle) -> Result<tauri::menu::Menu<tauri::Wry>, String> {
    // (A shortcut the menu cannot show: the menu without them rather than none.)
    tray_menu(app, true).or_else(|_| tray_menu(app, false)).map_err(|e| e.to_string())
}

/// Open the app on the screen translator's page (Electron's showMain('/screen')).
fn show_main_at(app: &AppHandle, route: Option<&str>) {
    crate::desktop::show_main(app);
    if let (Some(r), Some(w)) = (route, app.get_webview_window("main")) {
        let _ = w.eval(&format!("location.hash = {};", Value::String(format!("#{}", r))));
    }
}

/// makeTray / its removal, as the settings say (on the main thread).
fn tray_apply(app: &AppHandle) {
    let want = {
        let s = st();
        enabled(&s) && truthy(pc(&s.cfg).get("tray"))
    };
    let have = app.tray_by_id(TRAY_ID);
    if !want {
        // (Hidden, as desktop.rs hides the downloads' icon: made once, kept for the run.)
        if let Some(t) = have.as_ref() {
            let _ = t.set_visible(false);
        }
        let mut s = st();
        s.tray_on = false;
        return;
    }
    if let Some(t) = have {
        if let Ok(m) = tray_menu_safe(app) {
            let _ = t.set_menu(Some(m));
        }
        let shown = t.set_visible(true).is_ok();
        st().tray_on = shown;
        return;
    }
    let (ok, why) = crate::desktop::tray_possible();
    if !ok {
        let mut s = st();
        s.tray_on = false;
        s.tray_why = why;
        return;
    }
    match build_tray(app) {
        Ok(_) => {
            let mut s = st();
            s.tray_on = true;
            s.tray_why = String::new();
        }
        Err(e) => {
            let mut s = st();
            s.tray_on = false;
            s.tray_why = e;
        }
    }
}

fn build_tray(app: &AppHandle) -> Result<tauri::tray::TrayIcon<tauri::Wry>, String> {
    use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
    let icon = tauri::image::Image::from_bytes(include_bytes!("../../../desktop/icon.png")).map_err(|e| e.to_string())?;
    let menu = tray_menu_safe(app)?;
    let tip = {
        let s = st();
        format!("{} — {}", APP, label(&s.cfg, "bubble", "Screen translator"))
    };
    let b = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(tip)
        .menu(&menu)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "kts-region" => act_later(app, "region"),
            "kts-full" => act_later(app, "full"),
            "kts-repeat" => act_later(app, "repeat"),
            "kts-auto" => act_later(app, "auto"),
            "kts-clipboard" => act_later(app, "clipboard"),
            "kts-open" => show_main_at(app, Some("/screen")),
            "kts-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = ev {
                crate::desktop::show_main(tray.app_handle());
            }
        });
    #[cfg(kt_tray_left)]
    let b = b.show_menu_on_left_click(false);
    #[cfg(all(kt_tray_left_old, not(kt_tray_left)))]
    let b = b.menu_on_left_click(false);
    b.build(app).map_err(|e| e.to_string())
}

fn tray_refresh(app: &AppHandle) {
    let a2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(t) = a2.tray_by_id(TRAY_ID) {
            if let Ok(m) = tray_menu_safe(&a2) {
                let _ = t.set_menu(Some(m));
            }
        }
    });
}

/// Whether closing the main window leaves the app in the tray (screentr.cjs keepInTray).
pub fn keep_in_tray() -> bool {
    let s = st();
    enabled(&s) && truthy(pc(&s.cfg).get("tray")) && s.tray_on
}

/* ---------- monitors and the mouse ---------- */

fn monitors(app: &AppHandle) -> Vec<Mon> {
    let w = match app.get_webview_window("main") {
        Some(w) => w,
        None => return Vec::new(),
    };
    let mut out: Vec<Mon> = Vec::new();
    // (Tauri's monitor as ours: its place and size in physical pixels, its scale.)
    macro_rules! conv {
        ($m:expr) => {{
            let m = $m;
            Mon { id: logic::monitor_id(m.name().map(|s| s.as_str()), m.position().x, m.position().y), x: m.position().x, y: m.position().y, w: m.size().width, h: m.size().height, scale: m.scale_factor() }
        }};
    }
    if let Some(p) = w.primary_monitor().ok().flatten() {
        out.push(conv!(&p));
    }
    if let Ok(list) = w.available_monitors() {
        for m in list.iter() {
            let c = conv!(m);
            if !out.iter().any(|x| x.id == c.id) {
                out.push(c);
            }
        }
    }
    out
}

fn cursor(app: &AppHandle) -> Option<(f64, f64)> {
    #[cfg(kt_cursor)]
    {
        if let Some(w) = app.get_webview_window("main") {
            if let Ok(p) = w.cursor_position() {
                return Some((p.x, p.y));
            }
        }
    }
    let _ = app;
    screencap::cursor()
}

/// The monitor under the mouse (else the nearest; else the first).
fn monitor_under_mouse(app: &AppHandle) -> Option<Mon> {
    let ms = monitors(app);
    let i = match cursor(app) {
        Some((x, y)) => logic::nearest(&ms, x, y).unwrap_or(0),
        None => 0,
    };
    ms.get(i).cloned()
}

/* ---------- what a shortcut does ---------- */

/// screentr.cjs's act.
fn act(app: &AppHandle, what: &str) {
    let r = (|| -> Result<(), String> {
        if what == "clipboard" {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let t = app.clipboard().read_text().unwrap_or_default();
            return show_popup(app, &t);
        }
        if what == "auto" {
            // (One start or stop at a time — a quick toggle waits for the one under way; act_later runs each on a thread
            // of its own. A stop waits until its caption is gone, so the next start never meets it.)
            let _one = AUTO_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            if st().auto {
                stop_auto_why(app, "«auto» asked again (a toggle)");
                wait_caption_gone(app, 3000);
            } else {
                start_auto(app)?;
            }
            return Ok(());
        }
        if what == "permission" {
            permission_act(app);
            return Ok(());
        }
        let m = monitor_under_mouse(app).ok_or("no monitor")?;
        let shot = match capture(&m) {
            Ok(s) => s,
            Err(e) if e == "screen-permission" => {
                // (A Mac without the Screen Recording permission: the system's request shown once, then the page
                // that explains it — never a loop of requests.)
                permission_act(app);
                return Err(e);
            }
            Err(e) => {
                // (No way to take the screen here — Wayland without grim or the portal, no X display: the page that says
                // why, rather than a key that does nothing.)
                if e.starts_with("not available on this system") {
                    show_main_at(app, Some("/screen"));
                }
                return Err(e);
            }
        };
        let region_display = st().region.as_ref().and_then(|r| r.get("display")).and_then(|d| d.as_str()).map(String::from);
        let (mode, go) = logic::job_mode(what, region_display.as_deref(), &m.id);
        st().job = Some(Job { mode: mode.to_string(), ..shot });
        open_overlay(app, &m, go)
    })();
    if let Err(e) = r {
        eprintln!("KT screen {}: {}", what, e);
        st().last_error = e;
    }
}

/// The page explained, and on a Mac the system's request shown the first time only (its answer is remembered by the
/// system; later the page's button opens the settings).
fn permission_act(app: &AppHandle) {
    let first = {
        let mut s = st();
        let f = !s.asked_permission;
        s.asked_permission = true;
        save_state(&s);
        f
    };
    if first {
        let _ = screencap::ask_permission();
    } else if cfg!(target_os = "macos") {
        let _ = std::process::Command::new("open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture").spawn();
    }
    show_main_at(app, Some("/screen"));
}

/// capture(): the monitor whole, at its own resolution, as a job's picture (its PNG as a data: address for the page).
fn capture(m: &Mon) -> Result<Job, String> {
    let pic = screencap::grab(m, &Rect { x: 0, y: 0, w: m.w, h: m.h })?;
    let png = screencap::png_of(&pic);
    let scale = if m.dip_w() > 0.0 { pic.w as f64 / m.dip_w() } else { 1.0 };
    Ok(Job {
        mode: String::new(),
        image: format!("data:image/png;base64,{}", kurokawa_shell::util::b64_encode(&png)),
        width: pic.w,
        height: pic.h,
        scale,
        text: None,
        display: m.id.clone(),
        rgba: Arc::new(pic.rgba),
    })
}

/// The page's script for one of these windows: the bridge (without the self-test) and the route set before the page
/// reads it (the mini window's way).
fn window_script(hash: &str) -> String {
    format!(
        "{}\n;try{{if(!String(location.hash).startsWith('#/overlay'))history.replaceState(null,'',{});}}catch(e){{}}",
        crate::desktop::WEB_SCRIPT.get().map(|s| s.as_str()).unwrap_or(""),
        Value::String(hash.to_string())
    )
}

/// The screen translator's windows (frozen screen, caption, the self-test's) are made resizable on Linux only: GTK keeps
/// a window that is NOT resizable at the size it was built with (tao fixes its size request), so `set_size` was ignored
/// there — in run 43559071568 the test window stayed 800×600 and the frozen screen would not have covered a monitor nor
/// the caption followed its text. Frameless, they offer the person no edge to drag either way.
const LINUX_RESIZABLE: bool = cfg!(target_os = "linux");

fn place(w: &tauri::WebviewWindow, r: &Rect) {
    let _ = w.set_position(tauri::PhysicalPosition::new(r.x, r.y));
    let _ = w.set_size(tauri::PhysicalSize::new(r.w.max(1), r.h.max(1)));
}

fn close_window(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.close();
    }
}

/// openOverlay: a frameless window above the others over the monitor, the frozen screen in it (#/overlay, ?go=1 to read
/// the kept region at once); on every desktop where the build has it.
fn open_overlay(app: &AppHandle, m: &Mon, go: bool) -> Result<(), String> {
    close_window(app, OVERLAY);
    // (The old one's label is free once it is gone.)
    for _ in 0..50 {
        if app.get_webview_window(OVERLAY).is_none() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let script = window_script(if go { "#/overlay?go=1" } else { "#/overlay" });
    let mut b = tauri::WebviewWindowBuilder::new(app, OVERLAY, tauri::WebviewUrl::App("index.html".into()))
        .title(APP)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(LINUX_RESIZABLE)
        .visible(false)
        .disable_drag_drop_handler()
        .initialization_script(script.as_str());
    #[cfg(kt_all_spaces)]
    {
        b = b.visible_on_all_workspaces(true);
    }
    let w = b.build().map_err(|e| e.to_string())?;
    place(&w, &Rect { x: m.x, y: m.y, w: m.w, h: m.h });
    // (Wayland lets no window place itself: full screen on the monitor the compositor gives it.)
    if matches!(screencap::how().0, "grim" | "portal") {
        let _ = w.set_fullscreen(true);
    }
    let _ = w.show();
    let _ = w.set_focus();
    Ok(())
}

/// kt:screenRegion: the region drawn kept (for «again» and «auto»), its text read — or the crop for an AI model.
fn region_chosen(app: &AppHandle, r: &Value) -> Result<Value, String> {
    let (scale, iw, ih, rgba, display, cfg) = {
        let s = st();
        match s.job.as_ref() {
            Some(j) if !j.rgba.is_empty() => (j.scale, j.width, j.height, j.rgba.clone(), j.display.clone(), s.cfg.clone()),
            _ => return Ok(json!({ "blocks": [] })),
        }
    };
    let n = |k: &str| r.get(k).and_then(|v| v.as_f64());
    let dip = match (n("x"), n("y"), n("width"), n("height")) {
        (Some(x), Some(y), Some(w), Some(h)) => Some(DipRect { x, y, w, h }),
        _ => None,
    };
    let rect = logic::crop_rect(dip, scale, iw, ih);
    if dip.map(|d| d.w > 3.0).unwrap_or(false) {
        let mut kept = r.clone();
        if let Some(o) = kept.as_object_mut() {
            o.insert("display".into(), json!(display));
        }
        let _ = std::fs::create_dir_all(data_dir());
        let _ = std::fs::write(region_path(), kept.to_string());
        st().region = Some(kept);
        tray_refresh(app);
    }
    let (crop, cw, ch) = logic::crop_rgba(&rgba, iw, ih, &rect);
    if cw == 0 || ch == 0 {
        return Ok(json!({ "blocks": [] }));
    }
    let png = screencap::encode_png(cw, ch, &crop);
    let ai = cfg.get("read").and_then(|v| v.as_str()) == Some("ai") || pc(&cfg).get("ocr").and_then(|v| v.as_str()) == Some("ai");
    if ai {
        return Ok(json!({
            "ai": format!("data:image/png;base64,{}", kurokawa_shell::util::b64_encode(&png)),
            "offset": { "x": rect.x as f64 / scale, "y": rect.y as f64 / scale },
            "scale": scale,
        }));
    }
    let lang = cfg.get("source").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("auto").to_string();
    let blocks = ocr(&png, cw, ch, &lang)?;
    let out: Vec<Value> = blocks
        .iter()
        .map(|b| logic::block_to_page(b, &rect, scale))
        .map(|b| json!({ "text": b.text, "x": b.x, "y": b.y, "width": b.w, "height": b.h }))
        .collect();
    Ok(json!({ "blocks": out }))
}

/* ---------- auto: a region watched, its translation beneath it ---------- */

fn region_dip(r: &Value) -> Option<DipRect> {
    let n = |k: &str| r.get(k).and_then(|v| v.as_f64());
    Some(DipRect { x: n("x")?, y: n("y")?, w: n("width")?, h: n("height")? })
}

/// startAuto: the caption window under (or over) the kept region, a look every `interval` s, stopped after `autoStop`
/// minutes. (Electron took the region off the monitor under the mouse at each look; here off the monitor it was drawn
/// on, which is where it is.)
static AUTO_LOCK: Mutex<()> = Mutex::new(());

/// The caption as the system and Tauri see it (the self-test's focus samples): null when there is none; else { tauri:
/// { visible, focused }, win32: { visible, foreground } | null (not Windows, or its window not found) }.
fn caption_probe(app: &AppHandle, title: &str) -> Value {
    let w = match app.get_webview_window(CAPTION) {
        Some(w) => w,
        None => return Value::Null,
    };
    #[cfg(windows)]
    let win32 = noact::probe(title).map(|(v, f)| json!({ "visible": v, "foreground": f }));
    #[cfg(not(windows))]
    let win32: Option<Value> = {
        let _ = title;
        None
    };
    json!({ "tauri": { "visible": w.is_visible().ok(), "focused": w.is_focused().ok() }, "win32": win32 })
}

/// Waits (at most `ms`) until no caption window is left under its label → whether it is gone.
fn wait_caption_gone(app: &AppHandle, ms: u64) -> bool {
    let until = Instant::now() + Duration::from_millis(ms);
    while app.get_webview_window(CAPTION).is_some() {
        if Instant::now() >= until {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    true
}

fn start_auto(app: &AppHandle) -> Result<(), String> {
    let (region, cfg) = {
        let s = st();
        (s.region.clone(), s.cfg.clone())
    };
    let region = match region {
        Some(r) => r,
        None => {
            act(app, "region");
            return Ok(());
        }
    };
    let rd = region_dip(&region).ok_or("the kept region is not readable")?;
    let ms = monitors(app);
    let did = region.get("display").and_then(|v| v.as_str()).unwrap_or("");
    let m = ms.iter().find(|m| m.id == did).or_else(|| ms.first()).cloned().ok_or("no monitor")?;
    close_window(app, CAPTION);
    // (The run before's caption may still be closing — Tauri refuses a second window under the same label: waited for,
    // 5 s at most, else said.)
    if !wait_caption_gone(app, 5000) {
        return Err("the caption of the run before is still closing".to_string());
    }
    // (Each run's caption has a title of its own: the Win32 look-up below never finds a caption of a run before.)
    let run = AUTO_GEN.load(Ordering::SeqCst) + 1;
    let title = format!("{} #{}", CAPTION_TITLE, run);
    let script = window_script("#/overlay?caption=1");
    let mut b = tauri::WebviewWindowBuilder::new(app, CAPTION, tauri::WebviewUrl::App("index.html".into()))
        .title(title.as_str())
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(LINUX_RESIZABLE)
        .focused(false)
        .visible(false)
        .disable_drag_drop_handler()
        .initialization_script(script.as_str());
    // (Transparent where the system's web view can be without a private API: not on a Mac, where the caption keeps the
    // page's own dark box on an opaque window — PORTING.md, «Known losses».)
    #[cfg(not(target_os = "macos"))]
    {
        b = b.transparent(true);
    }
    #[cfg(kt_focusable)]
    {
        b = b.focusable(false);
    }
    #[cfg(kt_all_spaces)]
    {
        b = b.visible_on_all_workspaces(true);
    }
    let w = b.build().map_err(|e| e.to_string())?;
    place(&w, &logic::caption_rect(&m, &rd));
    // (The run is ON from here — before the caption is shown. kt:screenAction answers at once and the run starts on a
    // thread of its own (act_later): in runs 43563414074 and 43575071966 the page saw the caption on the screen while
    // this thread was still between the show and `auto = true` (the focus being given back waits up to 300 ms), read
    // «auto false» with no reason, and the caption still focused. Nothing had stopped it: it had not been marked yet.)
    let gen = AUTO_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = run;
    {
        let mut s = st();
        s.auto = true;
        s.auto_stop_why = String::new();
        s.auto_text = logic::AutoText::default();
    }
    // (Clicks go through it to what is under it — Electron's setIgnoreMouseEvents(true).
    // Windows: set while it is still hidden — tao re-derives the window's styles from its own flags at every such change,
    // and after the raw no-activate show below it took that style off and hid the window it believed hidden (run
    // 43579061871: the caption seen, then gone). Elsewhere: after the ordinary show — on Linux tao reaches the GTK
    // window's GdkWindow, which a window never shown has not got yet (run 43581873419: tao's event loop panicked at
    // event_loop.rs:459, `unwrap()` on None, and the self-test ended with SIGABRT).)
    #[cfg(windows)]
    let before = fg::foreground();
    #[cfg(all(windows, kt_ignore_cursor))]
    let through = Some(w.set_ignore_cursor_events(true).is_ok());
    // (Windows: the caption never takes the focus — made a no-activate tool window at the Win32 level and shown without
    // activation (SW_SHOWNOACTIVATE): a game or the page in front keeps the keyboard; nothing to give back. No call that
    // changes tao's flags follows. Where its window cannot be found, the show and the give-back as before.)
    #[cfg(windows)]
    let shown_quietly = noact::show_no_activate(&title);
    #[cfg(windows)]
    {
        st().caption_title = title.clone();
    }
    #[cfg(not(windows))]
    let shown_quietly = false;
    if !shown_quietly {
        let _ = w.show();
    }
    #[cfg(all(not(windows), kt_ignore_cursor))]
    let through = Some(w.set_ignore_cursor_events(true).is_ok());
    #[cfg(not(kt_ignore_cursor))]
    let through: Option<bool> = None;
    {
        let mut s = st();
        s.caption_click_through = through;
    }
    #[cfg(windows)]
    {
        if !shown_quietly {
            fg::give_back(before);
        }
        let after = fg::foreground();
        st().caption_fg = format!("front window before {:#x}, after {:#x}{}", before, after, if shown_quietly { ", shown without activation" } else { ", shown (focus given back)" });
    }
    tray_refresh(app);
    let every = Duration::from_millis(logic::interval_ms(cfg.get("interval").and_then(|v| v.as_f64()).or_else(|| cfg.get("interval").and_then(|v| v.as_str()).and_then(|s| s.trim().parse().ok()))));
    let until = logic::auto_stop_ms(cfg.get("autoStop").and_then(|v| v.as_f64())).map(|ms| Instant::now() + Duration::from_millis(ms));
    let a2 = app.clone();
    let lang = cfg.get("source").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("auto").to_string();
    let _ = std::thread::Builder::new().name("kt-screen-auto".into()).spawn(move || {
        // (The page's caption listens once it has loaded: the first look waits for it a little.)
        std::thread::sleep(Duration::from_millis(1200));
        loop {
            if AUTO_GEN.load(Ordering::SeqCst) != gen {
                return;
            }
            if until.map(|u| Instant::now() >= u).unwrap_or(false) {
                stop_auto_why(&a2, "its time ran out (autoStop)");
                return;
            }
            auto_tick(&a2, &m, gen, &lang);
            let next = Instant::now() + every;
            while Instant::now() < next {
                if AUTO_GEN.load(Ordering::SeqCst) != gen {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    });
    Ok(())
}

/// autoTick: the region taken again, read, and sent to the caption when it is new text (compared loosely).
fn auto_tick(app: &AppHandle, m: &Mon, gen: u64, lang: &str) {
    let r = match st().region.as_ref().and_then(region_dip) {
        Some(r) => r,
        None => return,
    };
    if app.get_webview_window(CAPTION).is_none() {
        return;
    }
    let s = m.scale();
    let rect = Rect { x: (r.x * s).round() as i32, y: (r.y * s).round() as i32, w: (r.w * s).round().max(1.0) as u32, h: (r.h * s).round().max(1.0) as u32 };
    let res = (|| -> Result<Vec<String>, String> {
        let pic = screencap::grab(m, &rect)?;
        let png = screencap::png_of(&pic);
        Ok(ocr(&png, pic.w, pic.h, lang)?.into_iter().map(|b| b.text).collect())
    })();
    if AUTO_GEN.load(Ordering::SeqCst) != gen {
        return;
    }
    match res {
        Ok(lines) => {
            let text = st().auto_text.next(&lines);
            if let Some(t) = text {
                st().auto_sent += 1;
                emit_caption(app, &t);
            }
        }
        Err(e) => {
            eprintln!("KT screen auto: {}", e);
            st().last_error = e;
        }
    }
}

fn emit_caption(app: &AppHandle, text: &str) {
    let payload = json!({ "text": text });
    #[cfg(kt_emit_to)]
    {
        let _ = app.emit_to(CAPTION, "kt:screenCaption", payload);
    }
    #[cfg(not(kt_emit_to))]
    {
        let _ = app.emit("kt:screenCaption", payload);
    }
}

/// stopAuto: the run ended, its caption closed, a reading under way ended with its helper's tree.
pub fn stop_auto(app: &AppHandle) {
    stop_auto_why(app, "stopped");
}
fn stop_auto_why(app: &AppHandle, why: &str) {
    AUTO_GEN.fetch_add(1, Ordering::SeqCst);
    let was = {
        let mut s = st();
        let w = s.auto;
        s.auto = false;
        if w {
            s.auto_stop_why = why.to_string();
        }
        w
    };
    kill_ocr();
    close_window(app, CAPTION);
    if was {
        tray_refresh(app);
    }
}

/* ---------- Windows: the focus given back after a window that must not take it is shown ---------- */

#[cfg(windows)]
mod fg {
    use std::ffi::c_void;
    use std::time::Duration;
    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> *mut c_void;
        fn SetForegroundWindow(h: *mut c_void) -> i32;
    }
    /// The window in front now (as a number: it crosses threads).
    pub fn foreground() -> usize {
        unsafe { GetForegroundWindow() as usize }
    }
    /// Once the front window is no longer `before` (a show is carried out on the main thread, perhaps a moment
    /// later), `before` brought to the front again; nothing when it stays in front for 300 ms.
    pub fn give_back(before: usize) {
        if before == 0 {
            return;
        }
        for _ in 0..10 {
            let now = foreground();
            if now != before {
                unsafe {
                    SetForegroundWindow(before as *mut c_void);
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(30));
        }
    }
}

/// The caption's own title (it has no frame, so no one reads it): how its Win32 window is found.
const CAPTION_TITLE: &str = "Kurokawa Tools \u{2014} caption";

#[cfg(windows)]
mod noact {
    use std::ffi::c_void;
    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(class: *const u16, title: *const u16) -> *mut c_void;
        fn GetWindowLongPtrW(h: *mut c_void, i: i32) -> isize;
        fn SetWindowLongPtrW(h: *mut c_void, i: i32, v: isize) -> isize;
        fn ShowWindow(h: *mut c_void, cmd: i32) -> i32;
        fn SetWindowPos(h: *mut c_void, after: *mut c_void, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    }
    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_NOACTIVATE: isize = 0x0800_0000;
    const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
    const SW_SHOWNOACTIVATE: i32 = 4;
    const HWND_TOPMOST: isize = -1;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_FRAMECHANGED: u32 = 0x0020;
    const SWP_SHOWWINDOW: u32 = 0x0040;
    /// The window titled `title` (this program's, hidden) made a no-activate tool window and shown without activation,
    /// kept on top → whether it was found.
    pub fn show_no_activate(title: &str) -> bool {
        let t: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let h = FindWindowW(std::ptr::null(), t.as_ptr());
            if h.is_null() {
                return false;
            }
            let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
            SetWindowLongPtrW(h, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW);
            SetWindowPos(h, HWND_TOPMOST as *mut c_void, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);
            ShowWindow(h, SW_SHOWNOACTIVATE);
            SetWindowPos(h, HWND_TOPMOST as *mut c_void, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        }
        true
    }
    /// The window titled `title`: (whether the system shows it, whether it is the front window); None when not found.
    pub fn probe(title: &str) -> Option<(bool, bool)> {
        #[link(name = "user32")]
        extern "system" {
            fn IsWindowVisible(h: *mut c_void) -> i32;
            fn GetForegroundWindow() -> *mut c_void;
        }
        let t: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let h = FindWindowW(std::ptr::null(), t.as_ptr());
            if h.is_null() {
                return None;
            }
            Some((IsWindowVisible(h) != 0, GetForegroundWindow() == h))
        }
    }
}

/// Whether the clipboard's window has had the focus since it opened: it closes when it loses it (Electron's «blur»,
/// which only follows a focus) — not on a loss of focus it never had.
static POPUP_FOCUSED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/* ---------- the clipboard's text, by the mouse ---------- */

fn show_popup(app: &AppHandle, text: &str) -> Result<(), String> {
    close_window(app, POPUP);
    if text.trim().is_empty() {
        return Ok(());
    }
    let ms = monitors(app);
    let c = cursor(app);
    let i = c.and_then(|(x, y)| logic::nearest(&ms, x, y)).unwrap_or(0);
    let m = ms.get(i).cloned().ok_or("no monitor")?;
    let at = c.unwrap_or((m.x as f64 + 40.0, m.y as f64 + 40.0));
    st().job = Some(Job { mode: "text".into(), image: String::new(), width: 0, height: 0, scale: 1.0, text: Some(text.chars().take(5000).collect()), display: m.id.clone(), rgba: Arc::new(Vec::new()) });
    for _ in 0..50 {
        if app.get_webview_window(POPUP).is_none() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let script = window_script("#/overlay?text=1");
    POPUP_FOCUSED.store(false, Ordering::SeqCst);
    let w = tauri::WebviewWindowBuilder::new(app, POPUP, tauri::WebviewUrl::App("index.html".into()))
        .title(APP)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .visible(false)
        .disable_drag_drop_handler()
        .initialization_script(script.as_str())
        .build()
        .map_err(|e| e.to_string())?;
    place(&w, &logic::popup_rect(&m, at));
    let _ = w.show();
    let _ = w.set_focus();
    Ok(())
}

/* ---------- OCR: the system's own, through the same helpers as Electron ---------- */

const PS_SCRIPT: &str = include_str!("kt-ocr.ps1");
const JXA_SCRIPT: &str = include_str!("kt-ocr.js");

fn has_tesseract() -> bool {
    static T: OnceLock<bool> = OnceLock::new();
    *T.get_or_init(|| {
        if cfg!(any(windows, target_os = "macos")) {
            return false;
        }
        crate::vtproc::run(Path::new("tesseract"), &["--version".to_string()], Duration::from_secs(4), 1 << 14).map(|r| r.code == Some(0) || !r.out.is_empty()).unwrap_or(false)
    })
}

fn ocr_kind() -> &'static str {
    let ai = pc(&st().cfg).get("ocr").and_then(|v| v.as_str()) == Some("ai");
    logic::ocr_kind(os(), ai, has_tesseract())
}

/// screentr.cjs's script(): the helper written to the app's data folder (again only when it differs).
fn script_file(name: &str, body: &str) -> PathBuf {
    let f = data_dir().join(name);
    let same = std::fs::read_to_string(&f).map(|t| t == body).unwrap_or(false);
    if !same {
        let _ = std::fs::create_dir_all(data_dir());
        let _ = std::fs::write(&f, body);
    }
    f
}

fn kill_ocr() {
    let pids: Vec<u32> = match OCR_PIDS.lock() {
        Ok(g) => g.clone(),
        Err(p) => p.into_inner().clone(),
    };
    for p in pids {
        crate::vtproc::kill_tree(p);
    }
}

fn ocr_running() -> usize {
    OCR_PIDS.lock().map(|g| g.len()).unwrap_or(0)
}

/// execFile with a 60 s limit: its stdout, or its stderr as the error; its pid kept while it runs.
fn run_helper(bin: &str, args: &[String]) -> Result<String, String> {
    let out = Arc::new(Mutex::new(String::new()));
    let o2 = out.clone();
    let mut lines = crate::vtproc::spawn_lines(Path::new(bin), args, 1 << 16, move |l| {
        if let Ok(mut g) = o2.lock() {
            g.push_str(l);
            g.push('\n');
        }
    })?;
    let pid = lines.pid;
    if let Ok(mut g) = OCR_PIDS.lock() {
        g.push(pid);
    }
    let started = Instant::now();
    loop {
        match lines.child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() > Duration::from_secs(60) {
                    crate::vtproc::kill_tree(pid);
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => break,
        }
    }
    let (code, err) = lines.wait();
    if let Ok(mut g) = OCR_PIDS.lock() {
        g.retain(|p| *p != pid);
    }
    let text = out.lock().map(|g| g.clone()).unwrap_or_default();
    if code != Some(0) {
        let e = if err.trim().is_empty() { format!("{} ended with {:?}", bin, code) } else { err };
        return Err(e.chars().take(400).collect());
    }
    Ok(text)
}

fn ps_args(script: &Path, rest: &[String]) -> Vec<String> {
    let mut a: Vec<String> = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"].iter().map(|s| s.to_string()).collect();
    a.push(script.to_string_lossy().into_owned());
    a.extend_from_slice(rest);
    a
}

/// ocr(png, lang): lines of text with their boxes, in the picture's pixels.
fn ocr(png: &[u8], w: u32, h: u32, lang: &str) -> Result<Vec<logic::Block>, String> {
    let kind = ocr_kind();
    if kind == "none" || kind == "ai" {
        return Err("ocr-missing".to_string());
    }
    static N: AtomicU64 = AtomicU64::new(0);
    let f = std::env::temp_dir().join(format!("kt-ocr-{}-{}.png", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    std::fs::write(&f, png).map_err(|e| e.to_string())?;
    let fp = f.to_string_lossy().into_owned();
    let r = match kind {
        "windows" => {
            let s = script_file("kt-ocr.ps1", PS_SCRIPT);
            run_helper("powershell.exe", &ps_args(&s, &["-path".into(), fp.clone(), "-lang".into(), logic::win_lang(lang)])).map(|o| logic::parse_lines(&o))
        }
        "vision" => {
            let s = script_file("kt-ocr.js", JXA_SCRIPT);
            run_helper("osascript", &["-l".into(), "JavaScript".into(), s.to_string_lossy().into_owned(), fp.clone(), logic::mac_lang(lang)])
                .map(|o| logic::parse_lines(&o).iter().map(|b| logic::vision_to_pixels(b, w, h)).collect())
        }
        _ => run_helper("tesseract", &[fp.clone(), "stdout".into(), "-l".into(), logic::tess_lang(lang).into(), "tsv".into()]).map(|o| logic::tsv_lines(&o)),
    };
    let _ = std::fs::remove_file(&f);
    r
}

/* ---------- the channels ---------- */

fn status_value() -> Value {
    let (on, cfg, region, tray, auto) = {
        let s = st();
        (enabled(&s), s.cfg.clone(), s.region.clone(), s.tray_on, s.auto)
    };
    let ok = st().key_ok.clone();
    let mut keys = Map::new();
    for (k, acc) in keys_of(&cfg) {
        keys.insert(k.clone(), json!({ "acc": acc, "ok": ok.get(&k).map(|v| truthy(Some(v))).unwrap_or(false) }));
    }
    let (ck, why) = screencap::how();
    let mut v = json!({
        "platform": kurokawa_shell::util::node_platform(),
        "on": on,
        "keys": keys,
        "tray": tray,
        "auto": auto,
        "region": region.unwrap_or(Value::Null),
        "ocr": ocr_kind(),
        // (This shell's own, beside Electron's: how the screen is taken here, and why it cannot be.)
        "capture": { "kind": ck, "why": why },
    });
    // (A Mac's Screen Recording permission: 'granted' or 'denied' — the page explains the latter.)
    if let Some(g) = screencap::permission() {
        v["permission"] = json!(if g { "granted" } else { "denied" });
    }
    v
}

/// kt:screenConfig({ config, clearFixed }) → the status: the page's settings kept (screen.json), the region forgotten
/// when asked, everything applied again.
#[tauri::command]
pub async fn kt_screen_config(app: AppHandle, o: Value) -> Result<Value, String> {
    {
        let mut s = st();
        load(&mut s);
        s.cfg = o.get("config").filter(|c| c.is_object()).cloned().unwrap_or_else(|| json!({}));
        let _ = std::fs::create_dir_all(data_dir());
        let _ = std::fs::write(cfg_path(), s.cfg.to_string());
        if truthy(o.get("clearFixed")) {
            s.region = None;
            let _ = std::fs::remove_file(region_path());
        }
    }
    let a2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        apply(&a2);
        // (The tray is made on the main thread: its state read once that is done — a second at most.)
        for _ in 0..40 {
            let settled = {
                let s = st();
                let want = enabled(&s) && truthy(pc(&s.cfg).get("tray"));
                want == s.tray_on || (want && !s.tray_why.is_empty())
            };
            if settled {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(status_value())
}

/// kt:screenStatus → { platform, on, keys { action: { acc, ok } }, tray, auto, region, ocr } (+ capture, permission).
#[tauri::command]
pub async fn kt_screen_status() -> Result<Value, String> {
    load(&mut st());
    Ok(status_value())
}

/// kt:screenAction(a) → true at once; the action runs (as its shortcut would).
#[tauri::command]
pub async fn kt_screen_action(app: AppHandle, a: String) -> Result<bool, String> {
    load(&mut st());
    act_later(&app, &a);
    Ok(true)
}

/// kt:screenJob → the job ({ mode, image, width, height, scale, text, cfg }) or null.
#[tauri::command]
pub async fn kt_screen_job() -> Result<Value, String> {
    let s = st();
    Ok(match s.job.as_ref() {
        None => Value::Null,
        Some(j) => {
            let mut v = json!({ "mode": j.mode, "cfg": s.cfg });
            if !j.image.is_empty() {
                v["image"] = json!(j.image);
                v["width"] = json!(j.width);
                v["height"] = json!(j.height);
                v["scale"] = json!(j.scale);
            }
            if let Some(t) = j.text.as_ref() {
                v["text"] = json!(t);
            }
            v
        }
    })
}

/// kt:screenRegion(r) → { blocks } (page pixels) or { ai, offset, scale }; r null → all of the picture.
#[tauri::command]
pub async fn kt_screen_region(app: AppHandle, r: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || region_chosen(&app, &r)).await.map_err(|e| e.to_string())?
}

/// kt:screenClose → true: the frozen screen and the clipboard's window closed.
#[tauri::command]
pub async fn kt_screen_close(app: AppHandle) -> Result<bool, String> {
    close_window(&app, OVERLAY);
    close_window(&app, POPUP);
    Ok(true)
}

/// kt:screenOcrLangs → { kind, langs } / { kind, error } / { kind }.
#[tauri::command]
pub async fn kt_screen_ocr_langs() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let kind = ocr_kind();
        match kind {
            "windows" => {
                let s = script_file("kt-ocr.ps1", PS_SCRIPT);
                match run_helper("powershell.exe", &ps_args(&s, &["-list".into()])) {
                    Ok(o) => json!({ "kind": kind, "langs": logic::parse_lines(&o).into_iter().map(|b| b.text).collect::<Vec<_>>() }),
                    Err(e) => json!({ "kind": kind, "error": e }),
                }
            }
            "tesseract" => match run_helper("tesseract", &["--list-langs".into()]) {
                Ok(o) => json!({ "kind": kind, "langs": logic::tess_langs(&o) }),
                Err(e) => json!({ "kind": kind, "error": e }),
            },
            _ => json!({ "kind": kind }),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// kt:screenCaption({ height }) → true: the caption window made that tall (40 to 400 page pixels).
#[tauri::command]
pub async fn kt_screen_caption(app: AppHandle, o: Value) -> Result<bool, String> {
    if let (Some(w), Some(h)) = (app.get_webview_window(CAPTION), o.get("height").and_then(|v| v.as_f64()).and_then(logic::caption_height)) {
        let sf = w.scale_factor().unwrap_or(1.0);
        if let Ok(sz) = w.inner_size() {
            let _ = w.set_size(tauri::PhysicalSize::new(sz.width, (h * sf).round() as u32));
        }
    }
    Ok(true)
}

/* ---------- the windows' events (main.rs) ---------- */

/// The main window closed while the translator keeps to the tray: hidden instead (main.cjs). The frozen screen closed
/// when it loses the focus (unless a region is being drawn, or as chosen), the clipboard's window too; «auto» stopped
/// when its caption is gone; everything closed with the main window.
pub fn on_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let app = window.app_handle().clone();
    match (window.label(), event) {
        ("main", tauri::WindowEvent::CloseRequested { api, .. }) => {
            if keep_in_tray() {
                api.prevent_close();
                let _ = window.hide();
            }
        }
        ("main", tauri::WindowEvent::Destroyed) => {
            stop_auto_why(&app, "the main window closed");
            for l in [OVERLAY, POPUP, TEST_WIN] {
                close_window(&app, l);
            }
        }
        (OVERLAY, tauri::WindowEvent::Focused(false)) => {
            let close = {
                let s = st();
                pc(&s.cfg).get("closeOnBlur") != Some(&Value::Bool(false)) && s.job.as_ref().map(|j| j.mode != "region").unwrap_or(false)
            };
            if close {
                let _ = window.close();
            }
        }
        (POPUP, tauri::WindowEvent::Focused(true)) => {
            POPUP_FOCUSED.store(true, Ordering::SeqCst);
        }
        (POPUP, tauri::WindowEvent::Focused(false)) => {
            // (Closed when the focus has really gone elsewhere: still without it a moment later — a loss of focus the
            // web view's own focus moves give and take back does not close it.)
            if POPUP_FOCUSED.load(Ordering::SeqCst) {
                let w = window.clone();
                let _ = std::thread::Builder::new().name("kt-popup-blur".into()).spawn(move || {
                    std::thread::sleep(Duration::from_millis(200));
                    if !w.is_focused().unwrap_or(false) {
                        let _ = w.close();
                    }
                });
            }
        }
        (CAPTION, tauri::WindowEvent::Destroyed) => {
            // (The person closed the caption: «auto» ends. Not when this is the caption of a run before — its Destroyed
            // can come after a new run made its own under the same label: only when no caption is there now.)
            if st().auto {
                let a2 = app.clone();
                let gen = AUTO_GEN.load(Ordering::SeqCst);
                let _ = std::thread::Builder::new().spawn(move || {
                    std::thread::sleep(Duration::from_millis(300));
                    if AUTO_GEN.load(Ordering::SeqCst) == gen && st().auto && a2.get_webview_window(CAPTION).is_none() {
                        stop_auto_why(&a2, "its caption window was closed");
                    }
                });
            }
        }
        _ => {}
    }
}

/// The app ends: «auto» and its helpers stopped.
pub fn at_exit() {
    AUTO_GEN.fetch_add(1, Ordering::SeqCst);
    kill_ocr();
}

/* ---------- the self-test ---------- */

/// (Self-test only.) { act }: 'state' → what this shell sees (capture, monitors, mouse, OCR, windows, helpers running,
/// auto, captions sent, last error); 'draw' { w, h } → a window the test draws (colour bars, black text on white) on the
/// monitor under the mouse, 60 px in → { x, y, w, h, monitor } (physical, relative to that monitor); 'grab' { x, y, w,
/// h } → the rectangle of the monitor under the mouse taken as the app takes it → { w, h, png (data:) }; 'ocr' { x, y,
/// w, h } → that rectangle read by the system's OCR → { kind, lines }; 'popup' { text } → the clipboard's window with
/// that text; 'undraw' → the test window closed.
#[tauri::command]
pub async fn kt_selftest_screen(app: AppHandle, o: Value) -> Result<Value, String> {
    if !kurokawa_shell::selftest::active() {
        return Err("not a self-test run".to_string());
    }
    let act = o.get("act").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let rect = |o: &Value| Rect {
        x: o.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
        y: o.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
        w: o.get("w").and_then(|v| v.as_u64()).unwrap_or(1) as u32,
        h: o.get("h").and_then(|v| v.as_u64()).unwrap_or(1) as u32,
    };
    let a2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let app = a2;
        match act.as_str() {
            "state" => {
                let ms = monitors(&app);
                let (ck, why) = screencap::how();
                let mut wins: Vec<Value> = Vec::new();
                for (l, w) in app.webview_windows() {
                    if l.starts_with("kts-") {
                        let at = w.outer_position().ok().map(|p| json!([p.x, p.y]));
                        let size = w.outer_size().ok().map(|z| json!([z.width, z.height]));
                        wins.push(json!({ "label": l, "visible": w.is_visible().unwrap_or(false), "focused": w.is_focused().unwrap_or(false), "decorated": w.is_decorated().unwrap_or(true), "at": at, "size": size }));
                    }
                }
                let ct = st().caption_title.clone();
                let cap = caption_probe(&app, &ct);
                let s = st();
                Ok(json!({
                    "capture": ck, "why": why, "os": os(),
                    "monitors": ms.iter().map(|m| json!({ "id": m.id, "x": m.x, "y": m.y, "w": m.w, "h": m.h, "scale": m.scale })).collect::<Vec<_>>(),
                    "cursor": cursor(&app).map(|(x, y)| json!([x, y])),
                    "under": monitor_under_mouse(&app).map(|m| m.id),
                    "ocr": logic::ocr_kind(os(), false, has_tesseract()),
                    "windows": wins, "ocrRunning": ocr_running(), "auto": s.auto, "sent": s.auto_sent, "lastError": s.last_error,
                    "clickThrough": s.caption_click_through, "autoStopWhy": s.auto_stop_why, "captionFg": s.caption_fg, "caption": cap, "ignoreApi": cfg!(kt_ignore_cursor), "focusableApi": cfg!(kt_focusable), "emitTo": cfg!(kt_emit_to),
                    "cursorApi": cfg!(kt_cursor), "shortcuts": cfg!(kt_shortcuts) && crate::desktop::shortcuts_possible(),
                    "bound": s.bound.iter().map(|(w, a)| json!([w, a])).collect::<Vec<_>>(), "tray": s.tray_on, "trayWhy": s.tray_why,
                    "permission": screencap::permission(), "keepInTray": enabled(&s) && truthy(pc(&s.cfg).get("tray")) && s.tray_on,
                }))
            }
            "draw" => {
                let m = monitor_under_mouse(&app).ok_or("no monitor")?;
                close_window(&app, TEST_WIN);
                for _ in 0..50 {
                    if app.get_webview_window(TEST_WIN).is_none() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                let r = Rect { x: 60, y: 60, w: o.get("w").and_then(|v| v.as_u64()).unwrap_or(480) as u32, h: o.get("h").and_then(|v| v.as_u64()).unwrap_or(240) as u32 };
                let at = Rect { x: m.x + r.x, y: m.y + r.y, w: r.w, h: r.h };
                // (Three bars of pure colour on the left half, black text on white on the right — in CSS pixels made to
                // fill the window whatever its scale. Linux: the page itself carries them, served from a loopback server
                // of the test's own (vtfake.rs Server), since in run 43549144577 WebKitGTK showed nothing of about:blank
                // and its script there — the window's own grey — and a data: address needs Tauri's `webview-data-url`
                // feature (refused in run 43550802095); elsewhere about:blank and the script, as Windows proved.)
                const BODY: &str = "<div style=\"width:50%;height:100%;display:flex;flex-direction:column\"><div style=\"flex:1;background:#ff0000\"></div><div style=\"flex:1;background:#00ff00\"></div><div style=\"flex:1;background:#0000ff\"></div></div><div style=\"width:50%;height:100%;background:#fff;color:#000;font:bold 15vh/1.15 Arial,Helvetica,sans-serif;display:flex;flex-direction:column;justify-content:center;align-items:center\"><div>TOOLS</div><div>2468</div></div>";
                let js = format!("document.documentElement.style.cssText='margin:0;height:100%;background:#fff';document.body.style.cssText='margin:0;height:100%;display:flex;overflow:hidden;background:#fff';document.body.innerHTML='{}';", BODY);
                let address = if cfg!(all(unix, not(target_os = "macos"))) {
                    let page = format!("<!doctype html><html style=\"margin:0;height:100%;background:#fff\"><body style=\"margin:0;height:100%;display:flex;overflow:hidden;background:#fff\">{}</body></html>", BODY);
                    test_page_url(page)?
                } else {
                    "about:blank".to_string()
                };
                let url = address.parse().map(tauri::WebviewUrl::External).map_err(|_| "the test page's address".to_string())?;
                // (Made hidden, then placed and shown — as the frozen screen, the caption and the clipboard's window are.)
                let w = tauri::WebviewWindowBuilder::new(&app, TEST_WIN, url).title("kt screen test").decorations(false).always_on_top(true).skip_taskbar(true).resizable(LINUX_RESIZABLE).visible(false).build().map_err(|e| e.to_string())?;
                place(&w, &at);
                let _ = w.show();
                // (Where the screen can be taken — Windows, X11 —: waited for until it is painted (a red pixel in the
                // first bar), as long as 8 s; then a size nudge, then hidden and shown again, 4 s each — what helped is
                // said, so a window of the app's that would stay blank shows here. Elsewhere three tries of the script.)
                let probe = Rect { x: at.x - m.x + (r.w / 4) as i32, y: at.y - m.y + (r.h / 6) as i32, w: 1, h: 1 };
                let red = || screencap::grab(&m, &probe).ok().map(|p| p.rgba.len() >= 3 && p.rgba[0] > 200 && p.rgba[1] < 80 && p.rgba[2] < 80).unwrap_or(false);
                let can_look = matches!(screencap::how().0, "gdi" | "x11");
                let t0 = Instant::now();
                let mut painted: Option<bool> = None;
                let mut how = String::new();
                if can_look {
                    painted = Some(false);
                    for (k, step) in ["shown", "after a size nudge", "hidden and shown again"].iter().enumerate() {
                        if k == 1 {
                            let _ = w.set_size(tauri::PhysicalSize::new(r.w + 1, r.h + 1));
                            std::thread::sleep(Duration::from_millis(200));
                            place(&w, &at);
                        } else if k == 2 {
                            let _ = w.hide();
                            std::thread::sleep(Duration::from_millis(200));
                            let _ = w.show();
                        }
                        let until = Instant::now() + Duration::from_secs(if k == 0 { 8 } else { 4 });
                        while Instant::now() < until {
                            let _ = w.eval(js.as_str());
                            std::thread::sleep(Duration::from_millis(300));
                            if red() {
                                painted = Some(true);
                                break;
                            }
                        }
                        if painted == Some(true) {
                            how = format!("painted {} ({} ms)", step, t0.elapsed().as_millis());
                            break;
                        }
                    }
                    if painted != Some(true) {
                        how = format!("never painted in {} ms (shown, a size nudge, hidden and shown again)", t0.elapsed().as_millis());
                    }
                } else {
                    for _ in 0..3 {
                        let _ = w.eval(js.as_str());
                        std::thread::sleep(Duration::from_millis(400));
                    }
                }
                // (The window's own size as the system made it: GTK kept a non-resizable one at its built size.)
                let actual = w.outer_size().ok().map(|z| json!([z.width, z.height]));
                Ok(json!({ "x": r.x, "y": r.y, "w": r.w, "h": r.h, "monitor": m.id, "scale": m.scale, "mx": m.x, "my": m.y, "painted": painted, "how": how, "actual": actual }))
            }
            "grab" => {
                let m = monitor_under_mouse(&app).ok_or("no monitor")?;
                let pic = screencap::grab(&m, &rect(&o))?;
                let png = screencap::png_of(&pic);
                Ok(json!({ "w": pic.w, "h": pic.h, "png": format!("data:image/png;base64,{}", kurokawa_shell::util::b64_encode(&png)), "monitor": m.id }))
            }
            "ocr" => {
                let m = monitor_under_mouse(&app).ok_or("no monitor")?;
                let pic = screencap::grab(&m, &rect(&o))?;
                let png = screencap::png_of(&pic);
                let kind = logic::ocr_kind(os(), false, has_tesseract());
                let lang = o.get("lang").and_then(|v| v.as_str()).unwrap_or("en").to_string();
                // (The system's OCR whatever the page chose — the row is about the helper.)
                let lines = match kind {
                    "none" => return Ok(json!({ "kind": kind, "lines": [] })),
                    _ => {
                        let keep = st().cfg.clone();
                        if let Some(p) = st().cfg.get_mut("pc").and_then(|p| p.as_object_mut()) {
                            p.insert("ocr".into(), json!("system"));
                        }
                        let r = ocr(&png, pic.w, pic.h, &lang);
                        st().cfg = keep;
                        r?
                    }
                };
                Ok(json!({ "kind": kind, "lines": lines.iter().map(|b| b.text.clone()).collect::<Vec<_>>() }))
            }
            "popup" => {
                show_popup(&app, o.get("text").and_then(|v| v.as_str()).unwrap_or(""))?;
                Ok(json!(true))
            }
            "undraw" => {
                close_window(&app, TEST_WIN);
                Ok(json!(true))
            }
            _ => Err(format!("unknown act {}", act)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
