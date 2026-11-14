// The original system, piece 1 (B, macOS — ../../PORTING.md «The original Rust system — piece by piece»): a download's
// notice through UNUserNotificationCenter, its click by our own delegate (didReceiveNotificationResponse → notifier.rs
// clicked: in-process while the app runs; at a launch by the notice, kept until the page asks). Behind the `mac-unc`
// feature, OFF: its crates (objc2 0.6, objc2-foundation 0.3, objc2-user-notifications 0.3, block2 0.6) are not in the
// main build's lock — only CI's not-required «Hybrid and original try» adds them and prints the compiler's word. A first
// draft written without a compiler: its errors there are expected and say what to change.
//
// Safety at run time: UNUserNotificationCenter ends a process that is not an application bundle, so nothing is called
// outside one (gaplogic.rs mac_bundled); an unsigned or ad-hoc-signed bundle may be refused the authorisation — then
// Err, and notifier.rs's caller shows the plugin's notice with the focus stand-in, as before.
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread};
use objc2_foundation::{NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use tauri::AppHandle;

use crate::gaplogic as logic;

static APP: OnceLock<AppHandle> = OnceLock::new();
/// Whether the delegate was set (in a bundle) — and the authorisation's answer, once asked.
static READY: OnceLock<bool> = OnceLock::new();
static ALLOWED: OnceLock<bool> = OnceLock::new();

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "KTNoticeDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(&self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse, handler: &block2::DynBlock<dyn Fn()>) {
            let ident = unsafe { response.notification().request().identifier() }.to_string();
            if let (Some(id), Some(app)) = (logic::task_link_id(&ident), APP.get()) {
                crate::notifier::clicked(app, &id);
            }
            handler.call(());
        }

        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(&self, _center: &UNUserNotificationCenter, _n: &UNNotification, handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
            handler.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List | UNNotificationPresentationOptions::Sound,));
        }
    }
);

fn bundled() -> bool {
    std::env::current_exe().map(|p| logic::mac_bundled(&p.to_string_lossy())).unwrap_or(false)
}

/// At start (setup, the main thread): our delegate set — early, so a launch by a notice's click still reaches it.
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    if !bundled() {
        let _ = READY.set(false);
        return;
    }
    unsafe {
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let d: Retained<Delegate> = msg_send![Delegate::alloc(), init];
        center.setDelegate(Some(ProtocolObject::from_ref(&*d)));
        // (The centre holds its delegate weakly: ours lives as long as the program.)
        std::mem::forget(d);
    }
    let _ = READY.set(true);
}

/// The authorisation, asked once (off the main thread: its answer comes on another queue).
fn allowed() -> bool {
    *ALLOWED.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<bool>();
        let block = RcBlock::new(move |granted: Bool, _err: *mut NSError| {
            let _ = tx.send(granted.as_bool());
        });
        unsafe {
            UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &block);
        }
        rx.recv_timeout(Duration::from_secs(10)).unwrap_or(false)
    })
}

/// A download's notice, its click wired → Ok, or Err(why) and nothing shown.
pub fn show(id: &str, title: &str, body: &str) -> Result<(), String> {
    if READY.get() != Some(&true) {
        return Err("macOS: not an application bundle (UNUserNotificationCenter needs one)".to_string());
    }
    let link = logic::task_link(id).ok_or_else(|| "not a download's id".to_string())?;
    if !allowed() {
        return Err("macOS: notices not allowed for this app (an unsigned build may be refused)".to_string());
    }
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let done = RcBlock::new(move |err: *mut NSError| {
        let _ = tx.send(if err.is_null() { Ok(()) } else { Err("macOS: the notice was refused".to_string()) });
    });
    unsafe {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        let req = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&link), &content, None);
        UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&req, Some(&done));
    }
    rx.recv_timeout(Duration::from_secs(10)).unwrap_or_else(|_| Err("macOS: no answer from the notification centre".to_string()))
}
