// The app's icon of the user's choosing — both apps' since Tools' stage P6 (moved here from the Reader's
// apps/reader/desktop-tauri/src-tauri/src/appicon.rs, stage R5, the same steps; what differs between the apps is the
// app's Spec: its shortcuts' and desktop entry's names, its entry's marker, and the two window calls whose presence each
// app's build detects — set_window_icon / default_icon, kept in the app so their cfgs stay its own). Each app keeps its
// command (the Reader's kr_app_icon, Tools' kt_app_icon) as a thin wrapper.
//
// (Stage R5; desktop/appicon.cjs + main.cjs's kr:appIcon / kt:appIcon, done the Tauri way.)
// The page crops any picture to a 512×512 PNG (src/ui/iconCrop.ts); the bridge renders it again at the .ico's sizes
// with its canvas (16–256) and hands both here. One choice is kept, outside the program's folder so it outlives
// updates: <config>/custom-icon.png (the picture — the same name Electron keeps in its userData, so R6's hand-over
// copies it as it is) and, on Windows, <config>/custom-icon.ico; no file means the app's own icon. It is put on
// (now, and at every start, setup → at_start):
//  - the window and its taskbar button: `set_icon` (Windows, Linux/X11; a Mac's windows have no icon);
//  - the app's own title bar and sidebar: the page (src/ui/brandIcon.ts — every img[data-brand]), told by the command;
//  - Windows: the shortcuts the installer made — desktop, Start menu, pinned on the taskbar — pointed at the .ico
//    (only shortcuts whose target is this program), through Windows' own WScript.Shell run by PowerShell with the
//    paths in its environment (no COM code here); and again at a start after an update made them anew (their stamp:
//    iconlogic.rs). Explorer may show the old picture until its icon cache is refreshed;
//  - Linux: where the .deb's desktop entry is (/usr/share/applications/<the app's>.desktop), a copy of it in
//    ~/.local/share/applications with its Icon pointed at the picture (the menus and the dock read that one first),
//    marked as the app's (Spec::mark) — never a file the user made; the AppImage has no entry to copy;
//  - macOS: nothing more — Tauri cannot change the Dock's icon at run time (NSApplication's
//    setApplicationIconImage needs Objective-C calls this build does not make), and the Finder shows the bundle's.
// «Reset to default» takes the files away, the window's icon back (Tauri's default icon), the shortcuts pointed at
// the program again, the Linux copy removed.
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::iconlogic;
use crate::util;

const PNG: &str = "custom-icon.png";
const ICO: &str = "custom-icon.ico";
const STAMP: &str = "custom-icon.shortcuts";

/// What differs between the apps.
pub struct Spec {
    /// The installer's shortcut's file name («KurokawaReader.lnk», «Kurokawa Tools.lnk»).
    pub lnk: &'static str,
    /// The Start menu folder the installer may put it in.
    pub start_folder: &'static str,
    /// The .deb's desktop entry's file names, tried in turn (the first found is the one copied, under its own name).
    pub entries: &'static [&'static str],
    /// The marker of the copy the app makes (iconlogic::MARK is the Reader's).
    pub mark: &'static str,
    /// The main window's icon set (the app's build knows whether its Tauri has set_icon).
    pub set_window_icon: fn(&AppHandle, tauri::image::Image<'static>) -> Result<(), String>,
    /// The app's own icon (Tauri's default window icon, else the app's bundled picture).
    pub default_icon: fn(&AppHandle) -> Option<tauri::image::Image<'static>>,
}

fn dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok()
}
pub fn png_path(app: &AppHandle) -> Option<PathBuf> {
    dir(app).map(|d| d.join(PNG))
}
pub fn ico_path(app: &AppHandle) -> Option<PathBuf> {
    dir(app).map(|d| d.join(ICO))
}

fn write_atomic(p: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let mut tmp = p.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(p);
    std::fs::rename(&tmp, p).map_err(|e| e.to_string())
}

/* ---------- the window's icon ---------- */

/// The picture decoded (Tauri's PNG reader: the `image-png` feature) — a picture it cannot read is refused.
fn decode(bytes: &[u8]) -> Result<tauri::image::Image<'static>, String> {
    tauri::image::Image::from_bytes(bytes).map_err(|e| format!("not a PNG: {}", e))
}

/// What became of the last apply (for the self-test): the window's icon, the shortcuts, the Linux entry.
static LAST: std::sync::Mutex<Option<Value>> = std::sync::Mutex::new(None);
fn note(k: &str, v: Value) {
    if let Ok(mut l) = LAST.lock() {
        let mut o = l.take().unwrap_or_else(|| json!({}));
        o[k] = v;
        *l = Some(o);
    }
}

/* ---------- Windows: the installer's shortcuts ---------- */

#[cfg(windows)]
fn shortcut_places(app: &AppHandle, spec: &Spec) -> Vec<PathBuf> {
    let name = spec.lnk;
    let mut v: Vec<PathBuf> = Vec::new();
    if let Ok(d) = app.path().desktop_dir() {
        v.push(d.join(name));
    }
    if let Some(ad) = std::env::var_os("APPDATA").map(PathBuf::from) {
        let progs = ad.join("Microsoft").join("Windows").join("Start Menu").join("Programs");
        v.push(progs.join(name));
        v.push(progs.join(spec.start_folder).join(name));
        v.push(ad.join("Microsoft").join("Internet Explorer").join("Quick Launch").join("User Pinned").join("TaskBar").join(name));
    }
    if let Some(pd) = std::env::var_os("ProgramData").map(PathBuf::from) {
        let progs = pd.join("Microsoft").join("Windows").join("Start Menu").join("Programs");
        v.push(progs.join(name));
        v.push(progs.join(spec.start_folder).join(name));
    }
    if let Some(pu) = std::env::var_os("PUBLIC").map(PathBuf::from) {
        v.push(pu.join("Desktop").join(name));
    }
    v
}
#[cfg(windows)]
fn shortcut_stamp(places: &[PathBuf]) -> String {
    let list: Vec<(String, u64)> = places
        .iter()
        .filter_map(|p| {
            let t = std::fs::metadata(p).ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
            Some((p.to_string_lossy().into_owned(), t))
        })
        .collect();
    iconlogic::stamp(&list)
}
/// The shortcuts pointed at `icon` (None: the program's own) → the ones changed. Blocking (PowerShell: about a second).
#[cfg(windows)]
fn point_shortcuts(places: &[PathBuf], icon: Option<&Path>) -> Result<Vec<String>, String> {
    use std::os::windows::process::CommandExt;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let lnks: Vec<String> = places.iter().filter(|p| p.is_file()).map(|p| p.to_string_lossy().into_owned()).collect();
    if lnks.is_empty() {
        return Ok(Vec::new());
    }
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", iconlogic::SHORTCUT_PS])
        .env("KR_LNKS", lnks.join("|"))
        .env("KR_EXE", exe.as_os_str())
        .env("KR_ICON", icon.map(|p| p.as_os_str().to_os_string()).unwrap_or_default())
        .stdin(std::process::Stdio::null())
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    Ok(text.split('|').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
}
#[cfg(windows)]
fn shortcuts(app: &AppHandle, spec: &Spec, icon: Option<PathBuf>, only_if_changed: bool) {
    let places = shortcut_places(app, spec);
    let stamp_file = dir(app).map(|d| d.join(STAMP));
    std::thread::spawn(move || {
        let now = shortcut_stamp(&places);
        if only_if_changed {
            let kept = stamp_file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).unwrap_or_default();
            if kept == now {
                note("shortcuts", json!({ "changed": [], "why": "as they were" }));
                return;
            }
        }
        match point_shortcuts(&places, icon.as_deref()) {
            Ok(done) => note("shortcuts", json!({ "changed": done })),
            Err(e) => note("shortcuts", json!({ "error": e })),
        }
        if let Some(f) = stamp_file {
            if icon.is_some() {
                let _ = std::fs::write(&f, shortcut_stamp(&places));
            } else {
                let _ = std::fs::remove_file(&f);
            }
        }
    });
}
#[cfg(not(windows))]
fn shortcuts(_app: &AppHandle, _spec: &Spec, _icon: Option<PathBuf>, _only_if_changed: bool) {}

/* ---------- Linux: the desktop entry ---------- */

#[cfg(target_os = "linux")]
fn xdg_home() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(d));
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share"))
}
/// The system's desktop entry of the app → (its path, its file name): each of the Spec's names in each data folder.
#[cfg(target_os = "linux")]
fn system_entry(spec: &Spec) -> Option<(PathBuf, &'static str)> {
    let dirs = std::env::var("XDG_DATA_DIRS").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "/usr/local/share:/usr/share".to_string());
    for name in spec.entries.iter() {
        if let Some(p) = dirs.split(':').map(|d| Path::new(d).join("applications").join(name)).find(|p| p.is_file()) {
            return Some((p, name));
        }
    }
    None
}
/// The user's copy of the desktop entry made (icon: Some) or taken away (None) — only the app's own copy.
#[cfg(target_os = "linux")]
fn desktop_entry(spec: &Spec, icon: Option<&Path>) {
    let sys = system_entry(spec);
    let entry = sys.as_ref().map(|s| s.1).or_else(|| spec.entries.first().copied()).unwrap_or("app.desktop");
    let user = match xdg_home() {
        Some(h) => h.join("applications").join(entry),
        None => return,
    };
    let mine = std::fs::read_to_string(&user).map(|t| iconlogic::is_ours_with(&t, spec.mark)).unwrap_or(true);
    if !mine {
        note("desktopEntry", json!("the user's own entry: left as it is"));
        return;
    }
    match (icon, sys.map(|s| s.0)) {
        (Some(i), Some(sys)) => {
            let text = match std::fs::read_to_string(&sys) {
                Ok(t) => t,
                Err(_) => return,
            };
            let want = iconlogic::desktop_override_with(&text, &i.to_string_lossy(), spec.mark);
            if std::fs::read_to_string(&user).ok().as_deref() != Some(want.as_str()) {
                let _ = write_atomic(&user, want.as_bytes());
            }
            note("desktopEntry", json!(user.to_string_lossy().into_owned()));
        }
        (Some(_), None) => note("desktopEntry", json!("no system entry (not installed from the .deb)")),
        (None, _) => {
            if user.is_file() {
                let _ = std::fs::remove_file(&user);
            }
            note("desktopEntry", json!("removed"));
        }
    }
}
#[cfg(not(target_os = "linux"))]
fn desktop_entry(_spec: &Spec, _icon: Option<&Path>) {}

/* ---------- applying ---------- */

/// The chosen icon put on everything this OS lets the app change (`fresh`: just chosen — the shortcuts pointed
/// whatever their state).
fn apply(app: &AppHandle, spec: &Spec, png: &[u8], fresh: bool) {
    match decode(png).and_then(|img| (spec.set_window_icon)(app, img)) {
        Ok(()) => note("window", json!(true)),
        Err(e) => note("window", json!(e)),
    }
    if let Some(p) = png_path(app) {
        desktop_entry(spec, Some(&p));
    }
    if cfg!(windows) {
        if let Some(ico) = ico_path(app).filter(|p| p.is_file()) {
            shortcuts(app, spec, Some(ico), !fresh);
        }
    }
}

/// At every start (setup, after the window is made): the chosen icon, if any, put on again.
pub fn at_start(app: &AppHandle, spec: &Spec) {
    let png = match png_path(app).and_then(|p| std::fs::read(p).ok()) {
        Some(b) => b,
        None => return,
    };
    if iconlogic::check_picture(&png).is_err() {
        return;
    }
    apply(app, spec, &png, false);
}

fn reset(app: &AppHandle, spec: &Spec) {
    for p in [png_path(app), ico_path(app)].into_iter().flatten() {
        let _ = std::fs::remove_file(p);
    }
    match (spec.default_icon)(app).ok_or_else(|| "no default icon".to_string()).and_then(|img| (spec.set_window_icon)(app, img)) {
        Ok(()) => note("window", json!("default")),
        Err(e) => note("window", json!(e)),
    }
    desktop_entry(spec, None);
    shortcuts(app, spec, None, false);
}

fn set(app: &AppHandle, spec: &Spec, url: &str, sizes: &Value) -> Result<(), String> {
    let png = util::b64_decode(iconlogic::data_url_b64(url)?);
    iconlogic::check_picture(&png)?;
    decode(&png)?;
    // (The .ico of the sizes the page rendered: each a PNG of the size it says.)
    let mut entries: Vec<(u32, Vec<u8>)> = Vec::new();
    if let Some(list) = sizes.as_array() {
        for e in list {
            let size = e.get(0).and_then(|x| x.as_u64()).unwrap_or(0) as u32;
            let b = match e.get(1).and_then(|x| x.as_str()).map(util::b64_decode) {
                Some(b) => b,
                None => continue,
            };
            if iconlogic::ICO_SIZES.contains(&size) && iconlogic::png_size(&b) == Some((size, size)) {
                entries.push((size, b));
            }
        }
    }
    let p = png_path(app).ok_or_else(|| "no config folder".to_string())?;
    write_atomic(&p, &png)?;
    if let Some(ico) = ico_path(app) {
        if entries.is_empty() {
            let _ = std::fs::remove_file(&ico);
        } else {
            write_atomic(&ico, &iconlogic::ico(&entries))?;
        }
    }
    apply(app, spec, &png, true);
    Ok(())
}

/// The chosen icon as a data URL (Settings shows it; the page's logos take it at start), null for the app's own.
pub fn current(app: &AppHandle) -> Value {
    match png_path(app).and_then(|p| std::fs::read(p).ok()) {
        Some(b) if iconlogic::png_size(&b).is_some() => json!(format!("data:image/png;base64,{}", util::b64_encode(&b))),
        _ => Value::Null,
    }
}

/// The appIcon command (the Reader's kr:appIcon, Tools' kt:appIcon): `{}` → the chosen icon (a PNG data URL) or null;
/// `{ set: dataUrl, sizes?: [[n, base64 PNG]…] }` → chosen and put on (→ true); `{ set: null }` → back to the app's
/// own (→ true). A picture that is not a PNG, is over 4 MiB or not 16–4096 px a side is refused (an Error, as
/// appicon.cjs's «not a PNG» / «too large»).
pub async fn command(app: AppHandle, o: Value, spec: &'static Spec) -> Result<Value, String> {
    match o.get("set") {
        None => Ok(current(&app)),
        Some(Value::Null) => {
            reset(&app, spec);
            Ok(json!(true))
        }
        Some(Value::String(url)) => {
            let url = url.clone();
            let sizes = o.get("sizes").cloned().unwrap_or(Value::Null);
            let a2 = app.clone();
            tauri::async_runtime::spawn_blocking(move || set(&a2, spec, &url, &sizes)).await.map_err(|e| e.to_string())??;
            Ok(json!(true))
        }
        Some(_) => Err("not a PNG".to_string()),
    }
}

/// (Self-test only.) The icon's files and what the last apply did: { png, ico: [[w, h, bytes]…], window, shortcuts,
/// desktopEntry, setIcon (whether this build's Tauri has it — the app's build says: `set_icon`) }.
pub fn selftest_info(app: &AppHandle, set_icon: bool) -> Result<Value, String> {
    if !crate::selftest::active() {
        return Err("not a self-test run".to_string());
    }
    let app = app.clone();
    let png = png_path(&app).and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len());
    let ico: Vec<Value> = ico_path(&app)
        .and_then(|p| std::fs::read(p).ok())
        .map(|b| iconlogic::ico_entries(&b).into_iter().map(|(w, h, n)| json!([w, h, n])).collect())
        .unwrap_or_default();
    let last = LAST.lock().ok().and_then(|l| l.clone()).unwrap_or_else(|| json!({}));
    Ok(json!({
        "png": png,
        "ico": ico,
        "dir": dir(&app).map(|d| d.to_string_lossy().into_owned()),
        "last": last,
        "setIcon": set_icon,
    }))
}
