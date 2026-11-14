// The hybrid's notifier (../../PORTING.md «Closed by the hybrid»): a download's notice whose click opens that download,
// as Electron's Notification 'click' did — one interface, `show(app, id, title, body)` → Ok when the system shows it
// with its click wired (the click then comes back through `clicked`, which emits the same `kt:openTask` Electron's
// main.cjs sends, the main window brought to the front), Err(why) when this system cannot — desktop.rs then shows the
// notification plugin's notice and keeps its stand-in (the window brought to the front within two minutes opens the
// download).
//
//  - Windows: a toast through Windows PowerShell's WinRT (std only — no crate), whose click is a «protocol» activation
//    of kurokawatools://task?id=<id>: Windows starts this program with that address, the single-instance plugin hands
//    it to the running one (desktop.rs queue → `clicked`). Only where the kurokawatools: links open THIS program (the
//    installer registers them; a portable copy usually has none — then the plugin's way); the toast is shown under the
//    AppUserModelID app.kurokawa.tools, registered for this user under HKCU\Software\Classes\AppUserModelId when it is
//    not there yet (what lets an unpackaged program's toasts show at all, the installed one's shortcut aside).
//  - Linux: org.freedesktop.Notifications over D-Bus with a default action, its ActionInvoked waited for on a thread
//    (notify-rust — the notification plugin's own crate, the same version: build.rs finds its calls, kt_notify_wait).
//  - macOS: none — a notice's click reaches only a signed bundle with its own notification delegate; the stand-in.
//
// The original system, piece 1 (../../PORTING.md «The original Rust system — piece by piece»), behind the same
// `show` / `clicked`: Windows — a toast from Rust through WinRT (wintoast.rs, the `native-toast` feature), its click
// in-process; PowerShell's toast above stays the fallback, chosen per notice when the native call errs. macOS —
// UNUserNotificationCenter with a delegate (macnotice.rs, the `mac-unc` feature, off). Everywhere — a click that comes
// before the page listens (a cold start by the toast's address, a Mac's launch by its notice) is kept and handed to the
// page when it subscribes to kt:openTask (the bridge's onOpenTask asks kt_task_take): the download opens, which the
// hybrid did not do.
//
// rules (the address, the toast's XML, the registry's answer, the kept clicks): gaplogic.rs.
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::gaplogic as logic;

/// The AppUserModelID notices are shown under (tauri.conf.json's identifier: the installer's shortcuts carry it).
#[allow(dead_code)]
const APP_ID: &str = "app.kurokawa.tools";

/// (Self-test) how the last notice went: "native", or why not.
static LAST: Mutex<String> = Mutex::new(String::new());

fn note(s: &str) {
    if let Ok(mut g) = LAST.lock() {
        *g = s.to_string();
    }
}

/// How the last notice was shown (the self-test's report).
pub fn last() -> String {
    LAST.lock().map(|g| g.clone()).unwrap_or_default()
}

static PENDING: Mutex<logic::Pending> = Mutex::new(logic::Pending::new());
static ONCE: Mutex<logic::ClickOnce> = Mutex::new(logic::ClickOnce::new());

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A notice's click: the download opened (main.cjs's n.on('click'): the window shown and focused, kt:openTask sent) —
/// or, the page not listening yet, kept until it asks (kt_task_take). The same click twice (in-process and by its
/// address) opens once.
pub fn clicked(app: &AppHandle, id: &str) {
    if !logic::id_ok(id) {
        return;
    }
    if !ONCE.lock().map(|mut g| g.fresh(id, now_ms())).unwrap_or(true) {
        return;
    }
    crate::desktop::show_main(app);
    let now = match PENDING.lock() {
        Ok(mut g) => g.click(id),
        Err(p) => p.into_inner().click(id),
    };
    if now {
        let _ = app.emit("kt:openTask", id.to_string());
    }
}

/// (The bridge's onOpenTask, once the page subscribes) the clicks kept for it, once; from now on each goes out as the
/// event.
#[tauri::command]
pub async fn kt_task_take() -> Result<Value, String> {
    let ids = match PENDING.lock() {
        Ok(mut g) => g.take(),
        Err(p) => p.into_inner().take(),
    };
    Ok(json!(ids))
}

/// (Self-test) a click kept as at a cold start, before the page listened.
pub fn keep_cold(id: &str) {
    if let Ok(mut g) = PENDING.lock() {
        g.keep_cold(id);
    }
}

/// At start (setup): a portable copy's or bare program's AppUserModelID set (Windows, native-toast); a Mac's notice
/// delegate set (mac-unc).
pub fn at_start(app: &AppHandle) {
    #[cfg(all(windows, feature = "native-toast"))]
    {
        if matches!(crate::update::kind(), kt_core::updatelogic::Kind::Portable | kt_core::updatelogic::Kind::Bare) {
            let _ = crate::wintoast::set_process_app_id();
        }
    }
    #[cfg(all(target_os = "macos", feature = "mac-unc"))]
    crate::macnotice::init(app);
    let _ = app;
}

/// At exit: this run's toasts left in the Action Center re-posted to start this program, or removed (Windows,
/// native-toast — wintoast.rs at_exit).
pub fn at_exit() {
    #[cfg(all(windows, feature = "native-toast"))]
    crate::wintoast::at_exit(APP_ID, link_ours());
}

/// What this build has natively (the self-test's report).
pub fn built() -> Value {
    json!({ "winrt": cfg!(all(windows, feature = "native-toast")), "macUnc": cfg!(all(target_os = "macos", feature = "mac-unc")) })
}

/// A download's notice with its click wired, where this system can (blocking: call it off the main thread) → Ok, or
/// Err(why) and nothing shown.
pub fn show(app: &AppHandle, id: &str, title: &str, body: &str) -> Result<(), String> {
    let r = show_here(app, id, title, body);
    match &r {
        Ok(how) => note(&format!("native: {}", how)),
        Err(e) => note(e),
    }
    r.map(|_| ())
}

#[cfg(windows)]
const NO_WINDOW: u32 = 0x0800_0000;

/// (Windows) whether the kurokawatools: links open this program (the installer's registration).
#[cfg(windows)]
fn link_ours() -> bool {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(_) => return false,
    };
    Command::new("reg")
        .args(["query", r"HKCU\Software\Classes\kurokawatools\shell\open\command", "/ve"])
        .stdin(Stdio::null())
        .creation_flags(NO_WINDOW)
        .output()
        .map(|out| logic::reg_runs(&String::from_utf8_lossy(&out.stdout), &exe.to_string_lossy()))
        .unwrap_or(false)
}

/// (Windows) this user's registration of the AppUserModelID, once a run and only when missing: its name in the notice.
#[cfg(windows)]
fn ensure_app_id() {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    static DONE: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    DONE.get_or_init(|| {
        let key = format!(r"HKCU\Software\Classes\AppUserModelId\{}", APP_ID);
        let known = Command::new("reg").args(["query", key.as_str(), "/v", "DisplayName"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(NO_WINDOW).status().map(|s| s.success()).unwrap_or(false);
        if !known {
            let _ = Command::new("reg")
                .args(["add", key.as_str(), "/v", "DisplayName", "/t", "REG_SZ", "/d", "Kurokawa Tools", "/f"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(NO_WINDOW)
                .status();
        }
    });
}

#[cfg(windows)]
fn show_here(app: &AppHandle, id: &str, title: &str, body: &str) -> Result<&'static str, String> {
    ensure_app_id();
    // (The original system first: WinRT from Rust, its click in-process — any portable copy too.)
    #[cfg(feature = "native-toast")]
    let native_err = match crate::wintoast::show(app, APP_ID, id, title, body) {
        Ok(()) => return Ok("a toast from Rust (WinRT), its click in-process"),
        Err(e) => e,
    };
    #[cfg(not(feature = "native-toast"))]
    let native_err = String::new();
    let _ = app;
    match show_ps(id, title, body) {
        Ok(()) => Ok("PowerShell's toast, its click by the kurokawatools: address"),
        Err(e) if native_err.is_empty() => Err(e),
        Err(e) => Err(format!("{}; PowerShell: {}", native_err, e)),
    }
}

/// (Windows, the hybrid's way — the fallback) a toast through Windows PowerShell's WinRT, its click a protocol
/// activation of the kurokawatools://task address.
#[cfg(windows)]
fn show_ps(id: &str, title: &str, body: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let link = logic::task_link(id).ok_or_else(|| "not a download's id".to_string())?;
    if !link_ours() {
        return Err("kurokawatools: links do not open this program (a portable copy?)".to_string());
    }
    let ps = std::env::var_os("SystemRoot")
        .map(|r| std::path::PathBuf::from(r).join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe"))
        .filter(|p| p.is_file())
        .unwrap_or_else(|| std::path::PathBuf::from("powershell.exe"));
    let mut child = Command::new(ps)
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", logic::TOAST_PS])
        .env("KT_TOAST_XML", logic::toast_xml(title, body, &link))
        .env("KT_TOAST_APP", APP_ID)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(NO_WINDOW)
        .spawn()
        .map_err(|e| e.to_string())?;
    let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                return match st.code() {
                    Some(0) => Ok(()),
                    Some(3) => Err("this app's notices are off in the system's settings".to_string()),
                    c => Err(format!("the toast was not shown (PowerShell {:?})", c)),
                };
            }
            Ok(None) if std::time::Instant::now() < until => std::thread::sleep(std::time::Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("PowerShell did not answer".to_string());
            }
        }
    }
}

/// Linux notices waiting for their click.
#[cfg(all(target_os = "linux", kt_notify_wait))]
static WAITING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(all(target_os = "linux", kt_notify_wait))]
fn show_here(app: &AppHandle, id: &str, title: &str, body: &str) -> Result<&'static str, String> {
    use std::sync::atomic::Ordering;
    if !logic::id_ok(id) {
        return Err("not a download's id".to_string());
    }
    if WAITING.load(Ordering::SeqCst) >= logic::MAX_WAITING {
        return Err("too many notices waiting for a click".to_string());
    }
    let label = crate::desktop::label("noticeOpen", "Open");
    let (app, id, title, body) = (app.clone(), id.to_string(), title.to_string(), body.to_string());
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    WAITING.fetch_add(1, Ordering::SeqCst);
    let spawned = std::thread::Builder::new().name("kt-notice".into()).spawn(move || {
        let mut n = notify_rust::Notification::new();
        n.appname("Kurokawa Tools");
        n.summary(&title);
        n.body(&body);
        n.action("default", &label);
        match n.show() {
            Ok(h) => {
                let _ = tx.send(Ok(()));
                h.wait_for_action(move |a: &str| {
                    if logic::clicked(a) {
                        clicked(&app, &id);
                    }
                });
            }
            Err(e) => {
                let _ = tx.send(Err(e.to_string()));
            }
        }
        WAITING.fetch_sub(1, Ordering::SeqCst);
    });
    if let Err(e) = spawned {
        WAITING.fetch_sub(1, Ordering::SeqCst);
        return Err(e.to_string());
    }
    match rx.recv_timeout(std::time::Duration::from_secs(10)) {
        Ok(r) => r.map(|_| "a D-Bus notice with its default action"),
        Err(_) => Err("no notification server answered".to_string()),
    }
}

#[cfg(all(target_os = "linux", not(kt_notify_wait)))]
fn show_here(_app: &AppHandle, _id: &str, _title: &str, _body: &str) -> Result<&'static str, String> {
    Err("notify-rust's calls not found in this build (kt_notify_wait)".to_string())
}

#[cfg(all(target_os = "macos", feature = "mac-unc"))]
fn show_here(_app: &AppHandle, id: &str, title: &str, body: &str) -> Result<&'static str, String> {
    crate::macnotice::show(id, title, body).map(|_| "UNUserNotificationCenter, its click by our delegate")
}

#[cfg(not(any(windows, target_os = "linux", all(target_os = "macos", feature = "mac-unc"))))]
fn show_here(_app: &AppHandle, _id: &str, _title: &str, _body: &str) -> Result<&'static str, String> {
    Err("macOS: a notice's click reaches only a signed app's own delegate — the window's next focus stands in".to_string())
}
