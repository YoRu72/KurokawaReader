// The app's commands from the shell (stage R5; desktop/main.cjs's buildMenu and its kr:command): on a Mac, the menu
// bar a Mac app is expected to have — the app's menu (About, Settings… ⌘,, Hide, Hide Others, Show All, Quit), File
// (Add books…, Scan this computer…, Library, Close Window), Edit (Undo, Redo, Cut, Copy, Paste, Select All — without
// it ⌘C / ⌘V do nothing in a Mac web view), View (Visual options, Search in book, Full screen), Window (Minimize,
// Zoom) and Help (Check for updates, Releases on GitHub) — in the interface's language (the page sends the words
// with kr_menu once its language is known; English until then). The app's own items reach the page as the
// kr:command event — main.cjs's 'import', 'scan', 'library', 'settings', 'options', 'search', 'update' —, which the
// bridge's onCommand hands on. Windows and Linux get no menu bar: the window has the app's own title bar there, and
// Electron's menu was hidden there too (its items are the page's own keys and buttons).
use serde_json::Value;
use tauri::{AppHandle, Emitter};

/// The page's command for a menu item's id (None: not one of the app's own).
pub fn command_of(id: &str) -> Option<&'static str> {
    match id {
        "import" => Some("import"),
        "scan" => Some("scan"),
        "library" => Some("library"),
        "settings" => Some("settings"),
        "options" => Some("options"),
        "search" => Some("search"),
        "update" => Some("update"),
        _ => None,
    }
}

/// A word of the menu: the page's, else English.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn word(l: &Value, k: &str, en: &str) -> String {
    l.get(k).and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && s.len() < 80).unwrap_or_else(|| en.to_string())
}

#[cfg(target_os = "macos")]
pub fn set(app: &AppHandle, l: &Value) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
    let name = "KurokawaReader";
    let item = |id: &str, k: &str, en: &str, acc: Option<&str>| MenuItem::with_id(app, id, word(l, k, en), true, acc);
    let about = PredefinedMenuItem::about(app, Some(word(l, "about", "About KurokawaReader").as_str()), None)?;
    let settings = item("settings", "settings", "Settings…", Some("CmdOrCtrl+,"))?;
    let hide = PredefinedMenuItem::hide(app, Some(word(l, "hide", "Hide KurokawaReader").as_str()))?;
    let hide_others = PredefinedMenuItem::hide_others(app, Some(word(l, "hideOthers", "Hide Others").as_str()))?;
    let show_all = PredefinedMenuItem::show_all(app, Some(word(l, "showAll", "Show All").as_str()))?;
    let quit = PredefinedMenuItem::quit(app, Some(word(l, "quit", "Quit KurokawaReader").as_str()))?;
    let app_menu = Submenu::with_items(
        app,
        name,
        true,
        &[&about, &PredefinedMenuItem::separator(app)?, &settings, &PredefinedMenuItem::separator(app)?, &hide, &hide_others, &show_all, &PredefinedMenuItem::separator(app)?, &quit],
    )?;
    let import = item("import", "addBooks", "Add books…", None)?;
    let scan = item("scan", "scan", "Scan this computer…", None)?;
    let library = item("library", "library", "Library", None)?;
    let close = PredefinedMenuItem::close_window(app, Some(word(l, "closeWindow", "Close Window").as_str()))?;
    let file = Submenu::with_items(app, word(l, "file", "File"), true, &[&import, &scan, &PredefinedMenuItem::separator(app)?, &library, &PredefinedMenuItem::separator(app)?, &close])?;
    let edit = Submenu::with_items(
        app,
        word(l, "edit", "Edit"),
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(word(l, "undo", "Undo").as_str()))?,
            &PredefinedMenuItem::redo(app, Some(word(l, "redo", "Redo").as_str()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(word(l, "cut", "Cut").as_str()))?,
            &PredefinedMenuItem::copy(app, Some(word(l, "copy", "Copy").as_str()))?,
            &PredefinedMenuItem::paste(app, Some(word(l, "paste", "Paste").as_str()))?,
            &PredefinedMenuItem::select_all(app, Some(word(l, "selectAll", "Select All").as_str()))?,
        ],
    )?;
    let options = item("options", "options", "Visual options", None)?;
    let search = item("search", "search", "Search in book", None)?;
    let view = Submenu::with_items(
        app,
        word(l, "view", "View"),
        true,
        &[&options, &search, &PredefinedMenuItem::separator(app)?, &PredefinedMenuItem::fullscreen(app, Some(word(l, "fullscreen", "Enter Full Screen").as_str()))?],
    )?;
    let window = Submenu::with_items(
        app,
        word(l, "window", "Window"),
        true,
        &[&PredefinedMenuItem::minimize(app, Some(word(l, "minimize", "Minimize").as_str()))?, &PredefinedMenuItem::maximize(app, Some(word(l, "zoom", "Zoom").as_str()))?],
    )?;
    let update = item("update", "update", "Check for updates", None)?;
    let releases = item("releases", "releases", "Releases on GitHub", None)?;
    let help = Submenu::with_items(app, word(l, "help", "Help"), true, &[&update, &releases])?;
    let menu = Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])?;
    app.set_menu(menu)?;
    Ok(())
}

/// A menu item chosen: the app's own → the page (kr:command); «Releases on GitHub» → the system's browser.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn on_event(app: &AppHandle, id: &str) {
    if id == "releases" {
        let _ = kurokawa_shell::shell::open_external(app, "https://github.com/YoRu72/KurokawaReader/releases".to_string());
        return;
    }
    if let Some(c) = command_of(id) {
        let _ = app.emit("kr:command", c);
    }
}

/// (This shell's own: the bridge's menuText.) The menu bar in the interface's words (`labels`: { about, settings,
/// … }, any left out in English) → true on a Mac; false elsewhere (no menu bar).
#[tauri::command]
pub async fn kr_menu(app: AppHandle, labels: Value) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let a2 = app.clone();
        // (Menus are made on the main thread.)
        app.run_on_main_thread(move || {
            let _ = tx.send(set(&a2, &labels).map_err(|e| e.to_string()));
        })
        .map_err(|e| e.to_string())?;
        let r = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(10)).map_err(|e| e.to_string()))
            .await
            .map_err(|e| e.to_string())??;
        r?;
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, labels);
        Ok(false)
    }
}

/// (Self-test only.) A menu command sent to the page as a menu item sends it (`c` must be one of the app's own).
#[tauri::command]
pub async fn kr_selftest_command(app: AppHandle, c: String) -> Result<bool, String> {
    if !kurokawa_shell::selftest::active() {
        return Err("not a self-test run".to_string());
    }
    match command_of(&c) {
        Some(x) => {
            app.emit("kr:command", x).map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => Ok(false),
    }
}
