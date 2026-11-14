// The original system, piece 1 (A, Windows — ../../PORTING.md «The original Rust system — piece by piece»): a
// download's notice as a toast made from Rust through WinRT (the `windows` crate: the 0.62 copy wry's webview2-com
// already brings), in place of the hybrid's PowerShell 5.1 script host started for each notice. Behind the
// `native-toast` feature (off until the self-test proves it); notifier.rs calls it first and, when it answers Err,
// shows PowerShell's toast as before — chosen at run time, per notice.
//
//  - Shown under the AppUserModelID app.kurokawa.tools (CreateToastNotifierWithId); a portable copy or a bare program
//    sets it as its own at start (`set_process_app_id`) — the installed one's shortcut carries it. The ID's entry under
//    HKCU\Software\Classes\AppUserModelId (its display name, what lets an unpackaged program's toasts show) is written
//    only when missing (notifier.rs ensure_app_id). Nothing removes it when a portable copy's folder is deleted — a
//    program that is not running cannot notice that; it is one small key of this user's, named after the app.
//  - Its click: a foreground activation, so the toast's Activated event reaches THIS process while it runs — the
//    download opened in-process, no second launch, the kurokawatools: links not needed (a portable copy's toasts work
//    too). The toast objects are kept (MAX_KEPT) while their handler must live.
//  - When the program quits, this run's toasts still in the Action Center are either shown again silently as protocol
//    toasts with the same tag — a click then starts the program with kurokawatools://task?id=… (main.rs → desktop.rs
//    queue → notifier.rs clicked → kept until the page asks: the download opens) — where those links open THIS
//    program, or removed (a portable copy: nothing could take their click). A crash skips this: those toasts' clicks
//    then reach nothing.
//
// Every WinRT call is fallible and answered as Err(why); nothing here panics. Rules: gaplogic.rs section 5.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::AppHandle;
use windows::core::{IInspectable, HSTRING};
use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::TypedEventHandler;
use windows::UI::Notifications::{NotificationSetting, ToastNotification, ToastNotificationManager};

use crate::gaplogic as logic;

struct Kept {
    tag: String,
    id: String,
    title: String,
    body: String,
    // (Held so its Activated handler lives; never read.)
    #[allow(dead_code)]
    toast: ToastNotification,
}

static KEPT: Mutex<logic::Ring<Kept>> = Mutex::new(logic::Ring::new());
static SEQ: AtomicU64 = AtomicU64::new(1);

fn err(e: windows::core::Error) -> String {
    format!("WinRT: {}", e)
}

/// (A portable copy, a bare program) this process's AppUserModelID set to the app's — at start, before any window.
pub fn set_process_app_id() -> Result<(), String> {
    unsafe { windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(windows::core::w!("app.kurokawa.tools")) }.map_err(err)
}

fn toast(xml: &str, tag: &str) -> windows::core::Result<ToastNotification> {
    let doc = XmlDocument::new()?;
    doc.LoadXml(&HSTRING::from(xml))?;
    let t = ToastNotification::CreateToastNotification(&doc)?;
    t.SetTag(&HSTRING::from(tag))?;
    t.SetGroup(&HSTRING::from(logic::TOAST_GROUP))?;
    Ok(t)
}

/// A download's toast, its click wired in-process → Ok, or Err(why) and nothing shown (notifier.rs then tries
/// PowerShell's).
pub fn show(app: &AppHandle, app_id: &str, id: &str, title: &str, body: &str) -> Result<(), String> {
    let link = logic::task_link(id).ok_or_else(|| "not a download's id".to_string())?;
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id)).map_err(err)?;
    // (Off in the system's settings, for this app or for all: nothing would show — the stand-in instead.)
    if let Ok(s) = notifier.Setting() {
        if s != NotificationSetting::Enabled {
            return Err("this app's notices are off in the system's settings".to_string());
        }
    }
    let tag = logic::toast_tag(SEQ.fetch_add(1, Ordering::SeqCst));
    let t = toast(&logic::toast_xml_as(title, body, &link, false), &tag).map_err(err)?;
    let (a2, id2) = (app.clone(), id.to_string());
    t.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, _| {
        crate::notifier::clicked(&a2, &id2);
        Ok(())
    }))
    .map_err(err)?;
    notifier.Show(&t).map_err(err)?;
    if let Ok(mut g) = KEPT.lock() {
        let _ = g.push(Kept { tag, id: id.to_string(), title: title.to_string(), body: body.to_string(), toast: t }, logic::MAX_KEPT);
    }
    Ok(())
}

/// The tags of this app's toasts in the Action Center now.
fn present(app_id: &str) -> windows::core::Result<Vec<String>> {
    let list = ToastNotificationManager::History()?.GetHistoryWithId(&HSTRING::from(app_id))?;
    let mut out: Vec<String> = Vec::new();
    for i in 0..list.Size()? {
        if let Ok(t) = list.GetAt(i) {
            if let Ok(tag) = t.Tag() {
                out.push(tag.to_string());
            }
        }
    }
    Ok(out)
}

/// The program quits: this run's toasts still shown re-posted as protocol toasts (`link_ours`: the kurokawatools:
/// links open this program) or removed — gaplogic.rs exit_plan.
pub fn at_exit(app_id: &str, link_ours: bool) {
    let kept: Vec<Kept> = match KEPT.lock() {
        Ok(mut g) => g.take_all(),
        Err(_) => return,
    };
    match logic::exit_plan(link_ours, kept.len()) {
        logic::ExitPlan::Nothing => {}
        logic::ExitPlan::Remove => {
            if let Ok(h) = ToastNotificationManager::History() {
                let _ = h.RemoveGroupWithId(&HSTRING::from(logic::TOAST_GROUP), &HSTRING::from(app_id));
            }
        }
        logic::ExitPlan::Repost => {
            let tags: Vec<String> = kept.iter().map(|k| k.tag.clone()).collect();
            let still = logic::still_shown(&tags, &present(app_id).unwrap_or_default());
            let notifier = match ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id)) {
                Ok(n) => n,
                Err(_) => return,
            };
            for k in kept.iter().filter(|k| still.contains(&k.tag)) {
                let link = match logic::task_link(&k.id) {
                    Some(l) => l,
                    None => continue,
                };
                if let Ok(t) = toast(&logic::toast_xml_as(&k.title, &k.body, &link, true), &k.tag) {
                    let _ = t.SetSuppressPopup(true);
                    let _ = notifier.Show(&t);
                }
            }
        }
    }
}

/// (Self-test) how many toasts are kept alive here.
pub fn kept() -> usize {
    KEPT.lock().map(|g| g.len()).unwrap_or(0)
}
