// The app's icon of the user's choosing (stage R5; desktop/appicon.cjs + main.cjs's kr:appIcon, done the Tauri way).
// Since Tools' stage P6 the steps are the shared crate's (shared/shell-rs/src/appicon.rs, with iconlogic.rs — moved
// there unchanged from this folder), both apps' shells using one copy; what is the Reader's own is here: its names (the
// installer's «KurokawaReader.lnk», the .deb's KurokawaReader.desktop, the marker iconlogic::MARK) and the two window
// calls whose presence this build detects (kr_set_icon, kr_default_icon — build.rs, apidetect.rs). The files, their
// places and every answer are as they were: <config>/custom-icon.png (and .ico on Windows), the window and taskbar,
// the shortcuts (Windows), the desktop entry's copy (Linux), «Reset to default».
use serde_json::Value;
#[allow(unused_imports)]
use tauri::{AppHandle, Manager};

use kurokawa_shell::appicon::{self, Spec};

/// The app's own icon (Tauri's default window icon, else the bundle's 256 px picture).
#[cfg(kr_default_icon)]
fn default_icon(app: &AppHandle) -> Option<tauri::image::Image<'static>> {
    app.default_window_icon().map(|i| i.clone().to_owned())
}
#[cfg(not(kr_default_icon))]
fn default_icon(_app: &AppHandle) -> Option<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/128x128@2x.png")).ok()
}

/// The main window's (and so its taskbar button's) icon set → whether it was.
#[cfg(kr_set_icon)]
fn set_window_icon(app: &AppHandle, img: tauri::image::Image<'static>) -> Result<(), String> {
    let w = app.get_webview_window("main").ok_or_else(|| "no main window".to_string())?;
    w.set_icon(img).map_err(|e| e.to_string())
}
#[cfg(not(kr_set_icon))]
fn set_window_icon(_app: &AppHandle, _img: tauri::image::Image<'static>) -> Result<(), String> {
    Err("this build's Tauri has no set_icon".to_string())
}

/// The Reader's names and window calls.
static SPEC: Spec = Spec {
    lnk: "KurokawaReader.lnk",
    start_folder: "KurokawaReader",
    entries: &["KurokawaReader.desktop"],
    mark: kurokawa_shell::iconlogic::MARK,
    set_window_icon,
    default_icon,
};

/// At every start (setup, after the window is made): the chosen icon, if any, put on again.
pub fn at_start(app: &AppHandle) {
    appicon::at_start(app, &SPEC);
}

/// kr:appIcon: `{}` → the chosen icon (a PNG data URL) or null; `{ set: dataUrl, sizes?: [[n, base64 PNG]…] }` →
/// chosen and put on (→ true); `{ set: null }` → back to the app's own (→ true). A picture that is not a PNG, is over
/// 4 MiB or not 16–4096 px a side is refused (an Error, as appicon.cjs's «not a PNG» / «too large»).
#[tauri::command]
pub async fn kr_app_icon(app: AppHandle, o: Value) -> Result<Value, String> {
    appicon::command(app, o, &SPEC).await
}

/// (Self-test only.) The icon's files and what the last apply did: { png, ico: [[w, h, bytes]…], window, shortcuts,
/// desktopEntry, setIcon (whether this build's Tauri has it) }.
#[tauri::command]
pub async fn kr_selftest_icon(app: AppHandle) -> Result<Value, String> {
    appicon::selftest_info(&app, cfg!(kr_set_icon))
}
