// KurokawaReader Setup — the designed Windows setup program (stage R6c). A frameless Tauri window (the same Tauri/wry
// stack the app uses) shows ../ui (Material 3 Expressive, five languages, right to left for Arabic); underneath, R6b's
// tested NSIS installer — embedded in this program at build time (build.rs: KR_SETUP_INNER) — is run SILENTLY with
// the choices made (logic.rs: /S /KRDESK= /KRASSOC= /D=), so files, registry, uninstaller, file types, shortcuts and
// the Electron replacement stay exactly R6b's. What it does, in order:
//   1. its own command line with /S, /P or --silent (unattended installs, the app's updater: `/P /R /UPDATE`,
//      `/S /UPDATE`): no window — the installer run with the same switches, its exit code returned;
//   2. WebView2 looked for (its Evergreen runtime's registry keys): missing (a rare Windows 10), or `--classic` → the
//      installer run with its own one-page window (it fetches WebView2 itself) — never a blank window here;
//   3. otherwise the window, in Windows' app colour from its first frame (where this Tauri has background_color —
//      ../../src-tauri/bootdetect.rs, as the app does), while the installer is written out to the temporary folder
//      and the installed copy is looked for, in the background;
//   4. the page's calls (the contract at the top of ../ui/setup.js): setup_detect, setup_browse, setup_install,
//      setup_progress, setup_open_app, setup_classic, setup_close, setup_window.
// The decisions are in logic.rs (std only, unit-tested alone); this file makes the Windows calls.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod logic;

use logic::Phase;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tauri::Manager;

/// R6b's NSIS installer (build.rs copies KR_SETUP_INNER here; empty when it was not given — then `--inner <path>` or
/// a `kr-inner-setup.exe` beside this program is used, else the install says «missing»).
static INNER: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/inner.bin"));
/// The version it installs (apps/reader/package.json, read by build.rs).
const VERSION: &str = env!("KR_SETUP_VERSION");
/// The size of the KurokawaReader.exe it installs (KR_SETUP_APP_BYTES at build time; "0" = unknown): the progress
/// of «Copying files» by bytes.
const APP_BYTES: &str = env!("KR_SETUP_APP_BYTES");
/// The program the installer puts in the folder.
const APP_EXE: &str = "KurokawaReader.exe";

// ───────────────────────────────── Windows calls ─────────────────────────────────

fn quiet(c: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c.stdin(Stdio::null())
}

/// `reg query <key> /v <value>`'s answer, or None (no key, no value, no reg.exe).
fn reg_query(key: &str, value: &str) -> Option<String> {
    let out = quiet(Command::new("reg").args(["query", key, "/v", value])).stderr(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The three WebView2 keys asked at once (each reg.exe takes a few tens of milliseconds).
fn webview2() -> Option<String> {
    let hs: Vec<_> = logic::WEBVIEW2_KEYS.iter().map(|k| std::thread::spawn(move || reg_query(k, "pv"))).collect();
    let answers: Vec<Option<String>> = hs.into_iter().map(|h| h.join().ok().flatten()).collect();
    logic::webview2_version(&answers)
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetUserDefaultUILanguage() -> u16;
}
/// Windows' display language, as one of the five ("" = another).
fn ui_lang() -> &'static str {
    #[cfg(windows)]
    {
        // SAFETY: a plain Win32 call with no arguments, returning a LANGID.
        logic::lang_from_langid(unsafe { GetUserDefaultUILanguage() })
    }
    #[cfg(not(windows))]
    {
        ""
    }
}

fn env_path(k: &str) -> String {
    std::env::var_os(k).map(|v| v.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The installed copy: a `reg export` of HKCU\…\Uninstall (UTF-16: names and folders in any script come through
/// whole), read by logic::find_copy.
fn find_copy(tmp: &Path) -> (logic::Existing, logic::Existing) {
    let f = tmp.join("uninstall.reg");
    let ok = quiet(Command::new("reg").arg("export").arg(logic::UNINSTALL_KEY).arg(&f).arg("/y"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let text = if ok { std::fs::read(&f).map(|b| logic::decode_reg_file(&b)).unwrap_or_default() } else { String::new() };
    let _ = std::fs::remove_file(&f);
    let la = env_path("LOCALAPPDATA");
    let exists = |p: &str| Path::new(p).exists();
    // (The copy installed now, and the Electron copy on its own: after an install that kept it, both are there.)
    (logic::find_copy(&text, &la, &exists), logic::find_electron(&text, &la, &exists))
}

/// The Electron copy's data folder (%APPDATA%\KurokawaReader): whether its library was handed over (a finished
/// hand-over's marker — written last by the Electron «bridge» build) and whether it has a library at all (IndexedDB).
fn electron_data() -> (bool, bool) {
    let d = PathBuf::from(env_path("APPDATA")).join("KurokawaReader");
    (d.join("handover").join("marker.json").is_file(), d.join("IndexedDB").is_dir())
}

/// Whether a desktop shortcut to KurokawaReader is there now (the user's desktop, or OneDrive's).
fn desktop_shortcut() -> bool {
    [env_path("USERPROFILE"), env_path("OneDrive"), env_path("OneDriveConsumer")]
        .iter()
        .filter(|b| !b.is_empty())
        .any(|b| Path::new(b).join("Desktop").join("KurokawaReader.lnk").exists())
}

/// A file written since `since` (with two seconds' slack for the file system's clock).
fn written_since(p: &Path, since: SystemTime) -> bool {
    let Ok(m) = std::fs::metadata(p).and_then(|m| m.modified()) else { return false };
    m + Duration::from_secs(2) >= since
}

fn size_of(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// The installer started with a command line given whole (NSIS's /D= must stay unquoted, which Command's own quoting
/// would break).
fn spawn_inner(inner: &Path, line: &str) -> std::io::Result<std::process::Child> {
    let mut c = Command::new(inner);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if !line.is_empty() {
            c.raw_arg(line);
        }
    }
    #[cfg(not(windows))]
    {
        c.args(line.split(' ').filter(|s| !s.is_empty()));
    }
    c.stdin(Stdio::null()).spawn()
}

// ───────────────────────────────── State ─────────────────────────────────

#[derive(Clone)]
struct Prog {
    phase: Phase,
    pct: u8,
    done: bool,
    ok: bool,
    code: Option<i32>,
    reason: String,
    detail: String,
    dir: String,
}
impl Prog {
    fn new() -> Prog {
        Prog { phase: Phase::Extract, pct: 0, done: false, ok: false, code: None, reason: String::new(), detail: String::new(), dir: String::new() }
    }
    fn json(&self) -> Value {
        json!({ "phase": self.phase.name(), "pct": self.pct, "done": self.done, "ok": self.ok, "code": self.code, "reason": self.reason, "detail": self.detail, "dir": self.dir })
    }
    /// Moved on only (a later sample never takes it back).
    fn advance(&mut self, (p, v): (Phase, u8)) {
        if p > self.phase {
            self.phase = p;
            self.pct = v.max(self.pct);
        } else if p == self.phase && v > self.pct {
            self.pct = v;
        }
    }
}

struct Shared {
    tmp: PathBuf,
    argv: Vec<String>,
    lang: &'static str,
    dark: Option<bool>,
    /// The installer written out (or found), or why not: ("missing" | "extract", detail).
    inner: Mutex<Option<Result<PathBuf, (String, String)>>>,
    found: Mutex<Option<(logic::Existing, bool, logic::Existing)>>,
    prog: Mutex<Prog>,
    running: AtomicBool,
    installed_dir: Mutex<String>,
}

fn wait_for<T: Clone>(m: &Mutex<Option<T>>, max: Duration) -> Option<T> {
    let until = Instant::now() + max;
    loop {
        if let Some(v) = m.lock().unwrap().clone() {
            return Some(v);
        }
        if Instant::now() > until {
            return None;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
}

impl Shared {
    /// The installer written out to <temp>\KurokawaReader-setup-<pid>\ (or the one given, or found beside this
    /// program).
    fn prepare(&self) {
        let r = (|| -> Result<PathBuf, (String, String)> {
            if !INNER.is_empty() {
                std::fs::create_dir_all(&self.tmp).map_err(|e| ("extract".to_string(), e.to_string()))?;
                let p = self.tmp.join(format!("KurokawaReader-{}-installer.exe", VERSION));
                std::fs::write(&p, INNER).map_err(|e| ("extract".to_string(), e.to_string()))?;
                if size_of(&p) != INNER.len() as u64 {
                    return Err(("extract".into(), "the written file is incomplete".into()));
                }
                return Ok(p);
            }
            if let Some(p) = logic::inner_arg(&self.argv) {
                if Path::new(&p).is_file() {
                    return Ok(PathBuf::from(p));
                }
            }
            let beside = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("kr-inner-setup.exe")));
            match beside {
                Some(b) if b.is_file() => Ok(b),
                _ => Err(("missing".into(), String::new())),
            }
        })();
        *self.inner.lock().unwrap() = Some(r);
    }

    fn fail(&self, reason: &str, detail: String, code: Option<i32>) {
        let mut p = self.prog.lock().unwrap();
        p.done = true;
        p.ok = false;
        p.reason = reason.into();
        p.detail = detail;
        p.code = code;
    }

    /// The install, on its own thread: the installer run silently with the choices, watched until it ends.
    fn install(&self, c: logic::Choices) {
        let dir = if c.dir.trim().is_empty() { format!("{}\\KurokawaReader", env_path("LOCALAPPDATA")) } else { logic::clean_dir(&c.dir) };
        *self.prog.lock().unwrap() = Prog { dir: dir.clone(), ..Prog::new() };
        let inner = match wait_for(&self.inner, Duration::from_secs(60)) {
            Some(Ok(p)) => p,
            Some(Err((r, d))) => return self.fail(&r, d, None),
            None => return self.fail("extract", "timed out".into(), None),
        };
        self.prog.lock().unwrap().advance(logic::stage(&logic::Obs { extracted: true, ..Default::default() }));
        // (The folder must take files: made, and a probe written and removed.)
        let probe = Path::new(&dir).join(".kr-setup-probe");
        if std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&probe, b"x")).is_err() {
            return self.fail("folder", dir, None);
        }
        let _ = std::fs::remove_file(&probe);
        let exe = Path::new(&dir).join(APP_EXE);
        let uninst = Path::new(&dir).join("uninstall.exe");
        let sm = PathBuf::from(env_path("APPDATA")).join("Microsoft").join("Windows").join("Start Menu").join("Programs");
        let lnks = [sm.join("KurokawaReader.lnk"), sm.join("KurokawaReader").join("KurokawaReader.lnk")];
        let before = size_of(&exe);
        let expected: u64 = APP_BYTES.parse().unwrap_or(0);
        let line = logic::command_line(&logic::nsis_args(&logic::Choices { dir: dir.clone(), ..c }));
        let start = SystemTime::now();
        let t0 = Instant::now();
        let mut child = match spawn_inner(&inner, &line) {
            Ok(ch) => ch,
            Err(e) => return self.fail("start", e.to_string(), None),
        };
        let mut seen_partial = false;
        loop {
            let exit = match child.try_wait() {
                Ok(Some(st)) => Some(st.code().unwrap_or(-1)),
                Ok(None) => None,
                Err(e) => return self.fail("start", e.to_string(), None),
            };
            let now = size_of(&exe);
            if now != before {
                seen_partial = true;
            }
            let o = logic::Obs {
                extracted: true,
                ms: t0.elapsed().as_millis().max(1) as u64,
                exe_now: now,
                exe_before: if seen_partial { 0 } else { before },
                exe_expected: expected,
                uninst_new: written_since(&uninst, start),
                lnk_new: lnks.iter().any(|l| written_since(l, start)),
                exit,
            };
            if let Some(code) = exit {
                if code == 0 {
                    let mut p = self.prog.lock().unwrap();
                    p.advance((Phase::Done, 100));
                    p.done = true;
                    p.ok = true;
                    p.code = Some(0);
                    *self.installed_dir.lock().unwrap() = dir.clone();
                } else {
                    self.fail(logic::exit_reason(code), String::new(), Some(code));
                }
                return;
            }
            self.prog.lock().unwrap().advance(logic::stage(&o));
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

/// The installer run as it is asked (the window not shown): its exit code.
fn run_inner_blocking(shared: &Shared, args: &[String]) -> i32 {
    shared.prepare();
    let code = match shared.inner.lock().unwrap().clone() {
        Some(Ok(p)) => match spawn_inner(&p, &logic::command_line(args)).and_then(|mut c| c.wait()) {
            Ok(st) => st.code().unwrap_or(1),
            Err(_) => 1,
        },
        _ => 1,
    };
    let _ = std::fs::remove_dir_all(&shared.tmp);
    code
}

// ───────────────────────────────── The page's calls ─────────────────────────────────

#[tauri::command]
async fn setup_detect(state: tauri::State<'_, Arc<Shared>>) -> Result<Value, String> {
    let none = || logic::Existing { kind: "none", version: String::new(), dir: String::new() };
    let (e, desk, el) = wait_for(&state.found, Duration::from_secs(8)).unwrap_or_else(|| (none(), false, none()));
    let inner_ok = matches!(wait_for(&state.inner, Duration::from_secs(30)), Some(Ok(_)));
    Ok(json!({
        "version": VERSION,
        "lang": state.lang,
        "dark": state.dark,
        "defaultDir": format!("{}\\KurokawaReader", env_path("LOCALAPPDATA")),
        "existing": { "kind": e.kind, "version": e.version, "dir": e.dir, "desktop": desk, "old": old_of(&el) },
        "inner": inner_ok,
    }))
}

#[tauri::command]
async fn setup_browse(app: tauri::AppHandle, current: Option<String>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut b = app.dialog().file();
    if let Some(parent) = current.as_deref().and_then(|c| Path::new(c).parent()) {
        if parent.is_dir() {
            b = b.set_directory(parent);
        }
    }
    match b.blocking_pick_folder() {
        Some(fp) => {
            let p = fp.into_path().map_err(|e| e.to_string())?;
            Ok(Some(logic::folder_for_pick(&p.to_string_lossy())))
        }
        None => Ok(None),
    }
}

/// The Electron copy's decision (logic::old_decision), from the Electron copy found on its own: "replace" | "keep" | "".
fn old_of(e: &logic::Existing) -> &'static str {
    let (handed, library) = electron_data();
    logic::old_decision(e.kind, handed, library)
}

#[tauri::command]
async fn setup_install(state: tauri::State<'_, Arc<Shared>>, options: Value) -> Result<(), String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("already installing".into());
    }
    *state.prog.lock().unwrap() = Prog::new();
    let c = logic::Choices {
        dir: options.get("dir").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        desktop: options.get("desktop").and_then(|v| v.as_bool()).unwrap_or(true),
        assoc: options.get("assoc").and_then(|v| v.as_bool()).unwrap_or(true),
        // (Decided here, from the disk — never by the page: kept unless it is safe to replace.)
        old: wait_for(&state.found, Duration::from_secs(8)).map(|(_, _, el)| old_of(&el).to_string()).unwrap_or_else(|| "keep".to_string()),
    };
    let s: Arc<Shared> = state.inner().clone();
    std::thread::spawn(move || {
        s.install(c);
        s.running.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[tauri::command]
async fn setup_progress(state: tauri::State<'_, Arc<Shared>>) -> Result<Value, String> {
    Ok(state.prog.lock().unwrap().json())
}

#[tauri::command]
async fn setup_open_app(state: tauri::State<'_, Arc<Shared>>) -> Result<(), String> {
    let dir = state.installed_dir.lock().unwrap().clone();
    let exe = Path::new(&dir).join(APP_EXE);
    Command::new(&exe).current_dir(&dir).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// The earlier (Electron) KurokawaReader opened, where it was kept beside this one: it updates itself and hands the
/// library over (the done screen's button).
#[tauri::command]
async fn setup_open_old(state: tauri::State<'_, Arc<Shared>>) -> Result<(), String> {
    let e = wait_for(&state.found, Duration::from_secs(8)).map(|(_, _, el)| el).ok_or_else(|| "not found".to_string())?;
    if e.kind != "electron" || e.dir.is_empty() {
        return Err("no earlier version".into());
    }
    let exe = Path::new(&e.dir).join(APP_EXE);
    Command::new(&exe).current_dir(&e.dir).spawn().map(|_| ()).map_err(|err| err.to_string())
}

/// The installer with its own one-page window; this window goes, and the program ends with it.
#[tauri::command]
async fn setup_classic(app: tauri::AppHandle, window: tauri::Window, state: tauri::State<'_, Arc<Shared>>) -> Result<(), String> {
    let s: Arc<Shared> = state.inner().clone();
    let inner = match wait_for(&s.inner, Duration::from_secs(30)) {
        Some(Ok(p)) => p,
        _ => return Err("missing".into()),
    };
    let mut child = spawn_inner(&inner, "").map_err(|e| e.to_string())?;
    let _ = window.hide();
    std::thread::spawn(move || {
        let _ = child.wait();
        app.exit(0);
    });
    Ok(())
}

/// Closed: at once — or, while installing, the window hidden and the program left to end when the install has.
#[tauri::command]
async fn setup_close(app: tauri::AppHandle, window: tauri::Window, state: tauri::State<'_, Arc<Shared>>) -> Result<(), String> {
    let s: Arc<Shared> = state.inner().clone();
    if s.running.load(Ordering::SeqCst) {
        let _ = window.hide();
        std::thread::spawn(move || {
            while s.running.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(200));
            }
            app.exit(0);
        });
    } else {
        app.exit(0);
    }
    Ok(())
}

#[tauri::command]
async fn setup_window(window: tauri::Window, act: String) -> Result<(), String> {
    match act.as_str() {
        "minimize" => window.minimize().map_err(|e| e.to_string()),
        "drag" => window.start_dragging().map_err(|e| e.to_string()),
        "show" => {
            window.show().map_err(|e| e.to_string())?;
            let _ = window.set_focus();
            Ok(())
        }
        other => Err(format!("unknown window action: {}", other)),
    }
}

// ───────────────────────────────── Start ─────────────────────────────────

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let tmp = std::env::temp_dir().join(format!("KurokawaReader-setup-{}", std::process::id()));
    let lang = ui_lang();

    // 1. No window asked: straight through to the installer.
    if let Some(args) = logic::passthrough(&argv) {
        let s = Shared::new(tmp, argv.clone(), lang, None);
        std::process::exit(run_inner_blocking(&s, &args));
    }
    // 2. No WebView2 (or the classic installer asked for): the installer's own window, which fetches WebView2.
    let (wv, dark) = {
        let t = std::thread::spawn(|| reg_query(logic::THEME_KEY, "AppsUseLightTheme").and_then(|o| logic::dark_mode(&o)));
        let wv = webview2();
        (wv, t.join().ok().flatten())
    };
    if wv.is_none() || argv.iter().any(|a| a == "--classic") {
        let s = Shared::new(tmp, argv.clone(), lang, None);
        let rest: Vec<String> = argv.iter().filter(|a| *a != "--classic" && !a.starts_with("--inner")).cloned().collect();
        std::process::exit(run_inner_blocking(&s, &rest));
    }
    // 3. The window; the installer written out and the installed copy looked for meanwhile.
    let shared = Arc::new(Shared::new(tmp, argv, lang, dark));
    {
        let s = shared.clone();
        std::thread::spawn(move || s.prepare());
        let s = shared.clone();
        std::thread::spawn(move || {
            let _ = std::fs::create_dir_all(&s.tmp);
            let (e, el) = find_copy(&s.tmp);
            *s.found.lock().unwrap() = Some((e, desktop_shortcut(), el));
        });
    }
    // (CI's switches, for its real screenshots and its end-to-end run: --options opens the options; --auto installs at
    // once without opening the app when done, with --no-desktop / --no-assoc as the choices.)
    let has = |f: &str| shared.argv.iter().any(|a| a == f);
    let boot = json!({
        "lang": lang,
        "dark": dark,
        "options": has("--options"),
        "auto": if has("--auto") { json!({ "desktop": !has("--no-desktop"), "assoc": !has("--no-assoc") }) } else { Value::Null },
    });
    let title = if lang == "ar" { "تثبيت KurokawaReader" } else { "KurokawaReader Setup" };
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(shared.clone())
        .invoke_handler(tauri::generate_handler![
            setup_detect,
            setup_browse,
            setup_install,
            setup_progress,
            setup_open_app,
            setup_open_old,
            setup_classic,
            setup_close,
            setup_window
        ])
        .setup(move |app| {
            let init = format!("window.__SETUP_BOOT__ = {};", boot);
            #[allow(unused_mut)]
            let mut b = tauri::WebviewWindowBuilder::new(app.handle(), "main", tauri::WebviewUrl::App("index.html".into()))
                .title(title)
                .inner_size(720.0, 480.0)
                .resizable(false)
                .maximizable(false)
                .decorations(false)
                .center()
                .initialization_script(init.as_str());
            // (Shown at once in the page's own colour where this Tauri can colour a window before its page paints;
            // otherwise shown when the page says it has painted — or after 1.5 s whatever happens.)
            #[cfg(kr_bg_color)]
            {
                let (r, g, bl) = if dark.unwrap_or(false) { (0x12, 0x13, 0x14) } else { (0xf7, 0xf8, 0xfa) };
                b = b.background_color(tauri::utils::config::Color(r, g, bl, 255)).visible(true);
            }
            #[cfg(not(kr_bg_color))]
            {
                b = b.visible(false);
            }
            b.build()?;
            let h = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(1500));
                if let Some(w) = h.get_webview_window("main") {
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while starting KurokawaReader Setup");
    let tmp = shared.tmp.clone();
    app.run(move |_handle, event| {
        if let tauri::RunEvent::Exit = event {
            let _ = std::fs::remove_dir_all(&tmp);
        }
    });
}

impl Shared {
    fn new(tmp: PathBuf, argv: Vec<String>, lang: &'static str, dark: Option<bool>) -> Shared {
        Shared {
            tmp,
            argv,
            lang,
            dark,
            inner: Mutex::new(None),
            found: Mutex::new(None),
            prog: Mutex::new(Prog::new()),
            running: AtomicBool::new(false),
            installed_dir: Mutex::new(String::new()),
        }
    }
}
