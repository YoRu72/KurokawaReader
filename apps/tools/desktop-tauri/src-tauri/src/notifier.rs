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
// rules (the address, the toast's XML, the registry's answer): hybridlogic.rs.
use std::sync::Mutex;

use tauri::{AppHandle, Emitter};

use crate::hybridlogic as logic;

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

/// A notice's click: the download opened (main.cjs's n.on('click'): the window shown and focused, kt:openTask sent).
pub fn clicked(app: &AppHandle, id: &str) {
    if !logic::id_ok(id) {
        return;
    }
    crate::desktop::show_main(app);
    let _ = app.emit("kt:openTask", id.to_string());
}

/// A download's notice with its click wired, where this system can (blocking: call it off the main thread) → Ok, or
/// Err(why) and nothing shown.
pub fn show(app: &AppHandle, id: &str, title: &str, body: &str) -> Result<(), String> {
    let r = show_here(app, id, title, body);
    note(match &r {
        Ok(()) => "native",
        Err(e) => e.as_str(),
    });
    r
}

#[cfg(windows)]
fn show_here(_app: &AppHandle, id: &str, title: &str, body: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const NO_WINDOW: u32 = 0x0800_0000;
    let link = logic::task_link(id).ok_or_else(|| "not a download's id".to_string())?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let out = Command::new("reg")
        .args(["query", r"HKCU\Software\Classes\kurokawatools\shell\open\command", "/ve"])
        .stdin(Stdio::null())
        .creation_flags(NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    if !logic::reg_runs(&String::from_utf8_lossy(&out.stdout), &exe.to_string_lossy()) {
        return Err("kurokawatools: links do not open this program (a portable copy?)".to_string());
    }
    // (This user's registration of the AppUserModelID, once: its name in the notice.)
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
fn show_here(app: &AppHandle, id: &str, title: &str, body: &str) -> Result<(), String> {
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
        Ok(r) => r,
        Err(_) => Err("no notification server answered".to_string()),
    }
}

#[cfg(all(target_os = "linux", not(kt_notify_wait)))]
fn show_here(_app: &AppHandle, _id: &str, _title: &str, _body: &str) -> Result<(), String> {
    Err("notify-rust's calls not found in this build (kt_notify_wait)".to_string())
}

#[cfg(not(any(windows, target_os = "linux")))]
fn show_here(_app: &AppHandle, _id: &str, _title: &str, _body: &str) -> Result<(), String> {
    Err("macOS: a notice's click reaches only a signed app's own delegate — the window's next focus stands in".to_string())
}
