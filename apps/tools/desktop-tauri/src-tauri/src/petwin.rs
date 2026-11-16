// The pets on the desktop (src/pets/desktop.ts): one small window per pet — transparent, frameless, above the others,
// not on the taskbar, never taking the focus — sized to the pet and moved as it walks; clicks pass through it except
// while the page says the pointer is over the pet. «screen» answers the work area and the pointer's place, «active»
// the window in front (activewin.rs), all in logical pixels. As main.cjs's kt:pet, plus «active», which Electron
// cannot answer.
// macOS: a transparent window needs Tauri's private-API feature, which this build does not turn on — «open» answers
// { ok: false, why: "transparency" } there and the page keeps the pets in its own window. Compiled only in CI.
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::activewin;

const PREFIX: &str = "pet-";
const MAIN_HASH: &str = "#/settings/pets";

fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}
fn title_of(id: &str) -> String {
    format!("Kurokawa Tools pet {}", id)
}
fn num(o: &Value, k: &str, d: f64) -> f64 {
    o.get(k).and_then(|v| v.as_f64()).filter(|v| v.is_finite()).unwrap_or(d)
}
/// The scale of the main window's monitor (physical pixels per logical one).
fn scale(app: &AppHandle) -> f64 {
    app.get_webview_window("main").and_then(|w| w.scale_factor().ok()).filter(|s| *s > 0.0).unwrap_or(1.0)
}

pub fn close_all(app: &AppHandle) {
    for (label, w) in app.webview_windows() {
        if label.starts_with(PREFIX) {
            let _ = w.close();
        }
    }
}

fn open(app: &AppHandle, id: &str, o: &Value) -> Result<Value, String> {
    let label = format!("{}{}", PREFIX, id);
    if app.get_webview_window(&label).is_some() {
        return Ok(json!({ "ok": true }));
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (o, &label);
        return Ok(json!({ "ok": false, "why": "transparency" }));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let hash = format!("#/pet/{}", id);
        let script = format!(
            "{}\n;try{{if(!String(location.hash).startsWith('#/pet/'))history.replaceState(null,'',{});}}catch(e){{}}",
            crate::desktop::WEB_SCRIPT.get().map(|s| s.as_str()).unwrap_or(""),
            Value::String(hash)
        );
        let title = title_of(id);
        let mut b = tauri::WebviewWindowBuilder::new(app, label.as_str(), tauri::WebviewUrl::App("index.html".into()))
            .title(title.as_str())
            .inner_size(num(o, "w", 4.0).clamp(4.0, 1600.0), num(o, "h", 4.0).clamp(4.0, 1600.0))
            .position(num(o, "x", 0.0), num(o, "y", 0.0))
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .disable_drag_drop_handler()
            .initialization_script(script.as_str());
        #[cfg(kt_focusable)]
        {
            b = b.focusable(false);
        }
        #[cfg(kt_all_spaces)]
        {
            b = b.visible_on_all_workspaces(true);
        }
        let w = b.build().map_err(|e| e.to_string())?;
        // (As the screen translator's caption, from what CI taught it: Windows — click-through set while hidden, then
        // shown without activation at the Win32 level; Linux — after the show, once GTK has the window.)
        #[cfg(all(windows, kt_ignore_cursor))]
        let _ = w.set_ignore_cursor_events(true);
        #[cfg(windows)]
        let quiet = noact::show_no_activate(&title);
        #[cfg(not(windows))]
        let quiet = false;
        if !quiet {
            let _ = w.show();
        }
        #[cfg(all(not(windows), kt_ignore_cursor))]
        let _ = w.set_ignore_cursor_events(true);
        Ok(json!({ "ok": true }))
    }
}

fn rect_json(r: activewin::Rect, k: f64) -> Value {
    json!({ "x": r.x as f64 / k, "y": r.y as f64 / k, "w": r.w as f64 / k, "h": r.h as f64 / k })
}

#[tauri::command]
pub async fn kt_pet(app: AppHandle, o: Value) -> Result<Value, String> {
    let action = o.get("action").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let id = o.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    match action.as_str() {
        "screen" => {
            let k = scale(&app);
            let work = activewin::work_area().map(|r| rect_json(r, k)).or_else(|| {
                app.get_webview_window("main").and_then(|w| w.primary_monitor().ok().flatten()).map(|m| {
                    let (p, s, mk) = (m.position(), m.size(), m.scale_factor().max(0.1));
                    json!({ "x": p.x as f64 / mk, "y": p.y as f64 / mk, "w": s.width as f64 / mk, "h": s.height as f64 / mk })
                })
            });
            #[cfg(kt_cursor)]
            let cursor = app.get_webview_window("main").and_then(|w| w.cursor_position().ok()).map(|p| json!({ "x": p.x / k, "y": p.y / k }));
            #[cfg(not(kt_cursor))]
            let cursor: Option<Value> = None;
            Ok(json!({ "work": work, "cursor": cursor, "scale": k }))
        }
        "active" => {
            let k = if activewin::PHYSICAL { scale(&app) } else { 1.0 };
            // (On a thread of its own: X11 and the window list are quick, but never on the event loop.)
            let a = tauri::async_runtime::spawn_blocking(activewin::active).await.map_err(|e| e.to_string())?;
            Ok(match a {
                activewin::Active::Window(r) => json!({ "rect": rect_json(r, k) }),
                activewin::Active::Nothing => json!({ "rect": null }),
                activewin::Active::Unsupported(why) => json!({ "rect": null, "why": why }),
            })
        }
        "closeAll" => {
            close_all(&app);
            Ok(json!({ "ok": true }))
        }
        "main" => {
            crate::desktop::show_main(&app);
            if o.get("hash").and_then(|v| v.as_str()) == Some(MAIN_HASH) {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.eval("location.hash='#/settings/pets'");
                }
            }
            Ok(json!({ "ok": true }))
        }
        _ if !safe_id(&id) => Ok(json!({ "ok": false })),
        "open" => open(&app, &id, &o),
        "move" | "through" | "close" => {
            let Some(w) = app.get_webview_window(&format!("{}{}", PREFIX, id)) else { return Ok(json!({ "ok": false })) };
            match action.as_str() {
                "move" => {
                    let _ = w.set_position(tauri::LogicalPosition::new(num(&o, "x", 0.0).round(), num(&o, "y", 0.0).round()));
                    let _ = w.set_size(tauri::LogicalSize::new(num(&o, "w", 4.0).clamp(4.0, 1600.0).round(), num(&o, "h", 4.0).clamp(4.0, 1600.0).round()));
                }
                "through" => {
                    #[cfg(kt_ignore_cursor)]
                    let _ = w.set_ignore_cursor_events(o.get("on").and_then(|v| v.as_bool()).unwrap_or(true));
                }
                _ => {
                    let _ = w.close();
                }
            }
            Ok(json!({ "ok": true }))
        }
        _ => Ok(json!({ "ok": false })),
    }
}

/// A pet window shown without being activated (Windows): a no-activate tool window, kept on top.
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
    const FLAGS: u32 = 0x0001 | 0x0002 | 0x0010; // SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
    pub fn show_no_activate(title: &str) -> bool {
        let t: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let h = FindWindowW(std::ptr::null(), t.as_ptr());
            if h.is_null() {
                return false;
            }
            let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
            SetWindowLongPtrW(h, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW);
            SetWindowPos(h, HWND_TOPMOST as *mut c_void, 0, 0, 0, 0, FLAGS | 0x0020);
            ShowWindow(h, SW_SHOWNOACTIVATE);
            SetWindowPos(h, HWND_TOPMOST as *mut c_void, 0, 0, 0, 0, FLAGS | 0x0040);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn ids() {
        assert!(super::safe_id("abc_1-2"));
        assert!(!super::safe_id("../x") && !super::safe_id("") && !super::safe_id(&"a".repeat(41)) && !super::safe_id("a b"));
    }
}
