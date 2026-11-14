// Stage P6: the two small second windows of desktop/main.cjs — kt:captureUrl (a sign-in in a window of its own: the first
// address that carries the caller's marker, e.g. AniList's pin page with its token, or null when the window is closed
// first; nothing of the page is read beyond its address) and kt:siteWindow (an https page in a window of its own, the
// answer true once it is closed; new windows it asks for refused). Neither window gets the bridge or the app's title bar.
// What differs from Electron, said plainly: the sign-in window's own profile (Electron's partition «persist:signin») is a
// folder of its own on Windows and Linux (`<app local data>/signin`); on a Mac WKWebView's default store, the app's. The
// windows are not tied to the main window as children (Electron's `parent`), only closed with it.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const PREFIX: &str = "kt-site-";

static SEQ: AtomicU64 = AtomicU64::new(1);

use crate::desklogic::{site_hit as hit, site_openable as openable};

/// (Electron's setWindowOpenHandler → deny, for the site window): window.open answers null and links or forms aimed at
/// another window do nothing.
const NO_NEW_WINDOWS: &str = r#"(function () {
  try { window.open = function () { return null; }; } catch (e) {}
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[target]') : null;
    if (a && a.target && !/^_(self|top|parent)$/i.test(a.target)) e.preventDefault();
  }, true);
  document.addEventListener('submit', function (e) {
    var f = e.target; if (f && f.target && !/^_(self|top|parent)$/i.test(f.target)) e.preventDefault();
  }, true);
})();"#;

fn build(app: &AppHandle, label: &str, url: &str, title: &str, signin: bool, seen: Option<Arc<Mutex<Vec<String>>>>) -> Result<(), String> {
    let external = match url.parse() {
        Ok(u) => tauri::WebviewUrl::External(u),
        Err(_) => return Err("Bad address".to_string()),
    };
    #[allow(unused_mut)]
    let mut b = tauri::WebviewWindowBuilder::new(app, label, external).title(title).inner_size(520.0, 720.0);
    if let Some(seen) = seen {
        b = b.on_navigation(move |u| {
            if let Ok(mut g) = seen.lock() {
                g.push(u.to_string());
            }
            true
        });
    } else {
        b = b.initialization_script(NO_NEW_WINDOWS);
    }
    #[cfg(not(target_os = "macos"))]
    {
        if signin {
            if let Ok(d) = app.path().app_local_data_dir() {
                b = b.data_directory(d.join("signin"));
            }
        }
    }
    let _ = signin;
    b.build().map(|_| ()).map_err(|e| e.to_string())
}

/// kt:captureUrl({ url, marker, title }) → the first address (a navigation, a redirect, an in-page change) that carries
/// the marker, the window then closed; null when the reader closes the window first.
#[tauri::command]
pub async fn kt_capture_url(app: AppHandle, o: Value) -> Result<Value, String> {
    let url = o.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let marker = o.get("marker").map(|v| match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }).unwrap_or_else(|| "undefined".to_string());
    let title = o.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if !openable(&url, false) {
        return Err("Bad address".to_string());
    }
    let label = format!("{}capture-{}", PREFIX, SEQ.fetch_add(1, Ordering::SeqCst));
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    build(&app, &label, &url, &title, true, Some(seen.clone()))?;
    let a2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut gone_polls = 0;
        loop {
            // (Addresses the window was sent to — navigations and redirects —, then where it is now: an in-page change.)
            let mut list: Vec<String> = seen.lock().map(|mut g| std::mem::take(&mut *g)).unwrap_or_default();
            let w = a2.get_webview_window(&label);
            if let Some(w) = w.as_ref() {
                if let Ok(u) = w.url() {
                    list.push(u.to_string());
                }
            }
            if let Some(found) = list.into_iter().find(|u| hit(u, &marker)) {
                if let Some(w) = w {
                    std::thread::sleep(Duration::from_millis(50));
                    let _ = w.close();
                }
                return Value::String(found);
            }
            if w.is_none() {
                // (Not made yet, or closed: closed once it has been missing a moment.)
                gone_polls += 1;
                if gone_polls > 4 {
                    return Value::Null;
                }
            } else {
                gone_polls = 0;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// kt:siteWindow({ url, title }) → false for an address that is not https; else true once the window is closed.
#[tauri::command]
pub async fn kt_site_window(app: AppHandle, o: Value) -> Result<Value, String> {
    let url = o.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if !openable(&url, true) {
        return Ok(json!(false));
    }
    let title = o.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let label = format!("{}page-{}", PREFIX, SEQ.fetch_add(1, Ordering::SeqCst));
    build(&app, &label, &url, &title, false, None)?;
    let a2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut missing = 0;
        loop {
            if a2.get_webview_window(&label).is_none() {
                missing += 1;
                if missing > 4 {
                    return json!(true);
                }
            } else {
                missing = 0;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// The main window gone: these windows closed with it (they would keep the app running unseen).
pub fn on_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
        for (label, w) in window.app_handle().webview_windows() {
            if label.starts_with(PREFIX) {
                let _ = w.close();
            }
        }
    }
}

/// (Self-test only.) { act: 'list' } → the labels of these windows open now, and where each is;
/// { act: 'go', label, url } → that window sent to an address (as a site's own redirect would);
/// { act: 'close', label } → closed as the user would.
#[tauri::command]
pub async fn kt_selftest_site(app: AppHandle, o: Value) -> Result<Value, String> {
    if !kurokawa_shell::selftest::active() {
        return Err("not a self-test run".to_string());
    }
    let label = o.get("label").and_then(|v| v.as_str()).unwrap_or("").to_string();
    match o.get("act").and_then(|v| v.as_str()).unwrap_or("") {
        "list" => Ok(Value::Array(
            app.webview_windows()
                .into_iter()
                .filter(|(l, _)| l.starts_with(PREFIX))
                .map(|(l, w)| json!({ "label": l, "url": w.url().map(|u| u.to_string()).unwrap_or_default() }))
                .collect(),
        )),
        "go" => {
            let to = o.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let w = app.get_webview_window(&label).ok_or("no such window")?;
            w.eval(&format!("location.href = {};", Value::String(to.to_string()))).map_err(|e| e.to_string())?;
            Ok(json!(true))
        }
        "close" => {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.close();
            }
            Ok(json!(true))
        }
        _ => Err("unknown act".to_string()),
    }
}
