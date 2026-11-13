// The parts of the apps' commands that touch Tauri — the system's folders, file dialogs, the clipboard, opening a
// file or an address with the system — as plain functions of an AppHandle. Each app wraps them in its own
// `#[tauri::command]`s under its own channel names (Tools: kt_*, the Reader: kr_*), so no command is defined in this
// crate. The bodies are those of Kurokawa Tools' src-tauri/src/commands.rs (branch work-tauri), which compiled and
// passed its self-test on Windows, Linux and macOS; only the wrapping changed.
//
// The dialogs block: call them from an `async` command (it runs on the async runtime, never on the main thread).
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::{files, util};

/// A key of a JSON object as JS's String() would write it ('' when missing or null).
pub fn text_of(o: &Value, key: &str) -> String {
    match o.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

pub fn lossy(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/* ---------- the system's folders ---------- */

pub fn home_dir(app: &AppHandle) -> PathBuf {
    match app.path().home_dir() {
        Ok(p) => p,
        Err(_) => PathBuf::from("."),
    }
}

pub fn downloads_dir(app: &AppHandle) -> PathBuf {
    match app.path().download_dir() {
        Ok(p) => p,
        Err(_) => home_dir(app),
    }
}

/* ---------- files (files.rs, as the page wants the answers) ---------- */

/// kt:listDir → { entries: [{ name, path, dir, size, mtime }], exists }.
pub fn list_dir_value(p: &str) -> Value {
    match files::list_dir(p) {
        Some(entries) => {
            let list: Vec<Value> = entries
                .iter()
                .map(|e| json!({ "name": e.name, "path": e.path, "dir": e.dir, "size": e.size, "mtime": e.mtime }))
                .collect();
            json!({ "entries": list, "exists": true })
        }
        None => json!({ "entries": [], "exists": false }),
    }
}

/// kt:pathInfo → { exists, dir?, size?, name?, parent? }.
pub fn path_info_value(p: &str) -> Value {
    match files::path_info(p) {
        Some(i) => {
            json!({ "exists": true, "dir": i.dir, "size": i.size, "name": i.name, "parent": i.parent })
        }
        None => json!({ "exists": false }),
    }
}

/// A file's bytes, handed to the page as an ArrayBuffer (not a JSON array of numbers).
pub fn read_file_response(p: &str) -> Result<tauri::ipc::Response, String> {
    let bytes: Vec<u8> = std::fs::read(p).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/* ---------- dialogs ---------- */

/// A folder chosen by the user, None when cancelled.
pub fn pick_dir(app: &AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    match picked {
        Some(fp) => {
            let p = fp.into_path().map_err(|e| e.to_string())?;
            Ok(Some(lossy(&p)))
        }
        None => Ok(None),
    }
}

/// { multiple?, filters?: [{ name, extensions }] } → the paths chosen, None when cancelled.
pub fn pick_files(app: &AppHandle, o: &Value) -> Result<Option<Vec<String>>, String> {
    let mut b = app.dialog().file();
    if let Some(Value::Array(filters)) = o.get("filters") {
        for f in filters.iter() {
            let name = text_of(f, "name");
            let mut exts: Vec<String> = Vec::new();
            if let Some(Value::Array(xs)) = f.get("extensions") {
                for x in xs.iter() {
                    if let Some(s) = x.as_str() {
                        exts.push(s.to_string());
                    }
                }
            }
            let refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
            b = b.add_filter(name, &refs);
        }
    }
    let multiple = o.get("multiple").and_then(|m| m.as_bool()).unwrap_or(false);
    let mut out: Vec<String> = Vec::new();
    if multiple {
        match b.blocking_pick_files() {
            Some(list) => {
                for fp in list {
                    let p = fp.into_path().map_err(|e| e.to_string())?;
                    out.push(lossy(&p));
                }
            }
            None => return Ok(None),
        }
    } else {
        match b.blocking_pick_file() {
            Some(fp) => {
                let p = fp.into_path().map_err(|e| e.to_string())?;
                out.push(lossy(&p));
            }
            None => return Ok(None),
        }
    }
    Ok(Some(out))
}

/// kt:saveText({ name, text }): a save dialog in Downloads; the text written where chosen → { path | null }.
pub fn save_text(app: &AppHandle, o: &Value) -> Result<Value, String> {
    let mut name = text_of(o, "name");
    if name.is_empty() {
        name = "kurokawa.txt".to_string();
    }
    let picked = app
        .dialog()
        .file()
        .set_directory(downloads_dir(app))
        .set_file_name(name)
        .blocking_save_file();
    let fp = match picked {
        Some(fp) => fp,
        None => return Ok(json!({ "path": null })),
    };
    let p = fp.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&p, text_of(o, "text").as_bytes()).map_err(|e| e.to_string())?;
    Ok(json!({ "path": lossy(&p) }))
}

/* ---------- clipboard ---------- */

/// The clipboard's text ('' when it is empty or holds no text — as Electron's clipboard.readText() gives).
pub fn clipboard_text(app: &AppHandle) -> String {
    app.clipboard().read_text().unwrap_or_default()
}

/// Text put on the clipboard.
pub fn set_clipboard_text(app: &AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

/* ---------- opening things with the system ---------- */

/// A file or folder opened with its program.
pub fn open_path(app: &AppHandle, p: String) -> Result<(), String> {
    app.opener()
        .open_path(p, None::<&str>)
        .map_err(|e| e.to_string())
}

/// An address opened in the system's browser (or its program); a file:// address opened as a path.
pub fn open_external(app: &AppHandle, u: String) -> Result<(), String> {
    let windows = cfg!(target_os = "windows");
    match util::file_url_to_path(&u, windows) {
        Some(p) => app
            .opener()
            .open_path(p, None::<&str>)
            .map_err(|e| e.to_string()),
        None => app
            .opener()
            .open_url(u, None::<&str>)
            .map_err(|e| e.to_string()),
    }
}

/// The folder holding `p`, opened (Electron's showItemInFolder, without selecting the item).
pub fn show_in_folder(app: &AppHandle, p: &str) -> Result<(), String> {
    let path = Path::new(p);
    let dir: PathBuf = match path.parent() {
        Some(d) if !d.as_os_str().is_empty() => d.to_path_buf(),
        _ => path.to_path_buf(),
    };
    app.opener()
        .open_path(lossy(&dir), None::<&str>)
        .map_err(|e| e.to_string())
}
