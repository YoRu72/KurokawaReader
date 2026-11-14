// The app's icon of the user's choosing (stage P6 part; desktop/appicon.cjs + main.cjs's kt:appIcon, done the Tauri
// way): the shared crate's steps (shared/shell-rs/src/appicon.rs + iconlogic.rs, the Reader's since its stage R5, both
// apps' since this one) with Tools' names and window calls. The page crops any picture to a 512×512 PNG
// (src/ui/iconCrop.ts) and bridge.js draws the .ico's sizes with its canvas; kept in <config>/custom-icon.png (and .ico
// on Windows) — the name Electron keeps in its userData, so the hand-over (P9) copies it as it is —; put on the
// window and its taskbar button (set_icon, where this build's Tauri has it: kt_set_icon), the page's own logos
// (src/ui/brandIcon.ts), Windows' shortcuts the installer made («Kurokawa Tools.lnk»), Linux's desktop entry (a marked
// copy in ~/.local/share/applications); again at every start; carried in backups by the page (src/backup.ts).
use serde_json::Value;
#[allow(unused_imports)]
use tauri::{AppHandle, Manager};

use kurokawa_shell::appicon::{self, Spec};

/// The app's own icon (Tauri's default window icon, else the bundle's 256 px picture — icons/ is made in CI by
/// `tauri icon`).
#[cfg(kt_default_icon)]
fn default_icon(app: &AppHandle) -> Option<tauri::image::Image<'static>> {
    app.default_window_icon().map(|i| i.clone().to_owned())
}
#[cfg(not(kt_default_icon))]
fn default_icon(_app: &AppHandle) -> Option<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/128x128@2x.png")).ok()
}

/// The main window's (and so its taskbar button's) icon set → whether it was.
#[cfg(kt_set_icon)]
fn set_window_icon(app: &AppHandle, img: tauri::image::Image<'static>) -> Result<(), String> {
    let w = app.get_webview_window("main").ok_or_else(|| "no main window".to_string())?;
    w.set_icon(img).map_err(|e| e.to_string())
}
#[cfg(not(kt_set_icon))]
fn set_window_icon(_app: &AppHandle, _img: tauri::image::Image<'static>) -> Result<(), String> {
    Err("this build's Tauri has no set_icon".to_string())
}

/// Tools' names (tauri.conf.json's productName «Kurokawa Tools»; the .deb names its entry after the program —
/// kurokawa-tools — or the product, so both are tried) and window calls.
static SPEC: Spec = Spec {
    lnk: "Kurokawa Tools.lnk",
    start_folder: "Kurokawa Tools",
    entries: &["kurokawa-tools.desktop", "Kurokawa Tools.desktop", "Kurokawa_Tools.desktop"],
    mark: "X-KurokawaTools-CustomIcon=true",
    set_window_icon,
    default_icon,
};

/// At every start (setup, after the window is made): the chosen icon, if any, put on again.
pub fn at_start(app: &AppHandle) {
    appicon::at_start(app, &SPEC);
}

/// kt:appIcon: `{}` → the chosen icon (a PNG data URL) or null; `{ set: dataUrl, sizes?: [[n, base64 PNG]…] }` →
/// chosen and put on (→ true); `{ set: null }` → back to the app's own (→ true). A picture that is not a PNG, is over
/// 4 MiB or not 16–4096 px a side is refused (an Error, as appicon.cjs's «not a PNG» / «too large»).
#[tauri::command]
pub async fn kt_app_icon(app: AppHandle, o: Value) -> Result<Value, String> {
    appicon::command(app, o, &SPEC).await
}

/// (Self-test only.) The icon's files and what the last apply did.
#[tauri::command]
pub async fn kt_selftest_icon(app: AppHandle) -> Result<Value, String> {
    appicon::selftest_info(&app, cfg!(kt_set_icon))
}
