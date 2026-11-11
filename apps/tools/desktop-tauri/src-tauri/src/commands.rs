// The stage-1 slice of desktop/main.cjs's `ipcMain.handle('kt:*')` channels as Tauri commands: kt:xyz → kt_xyz.
// Every command is async so it runs on the async runtime, never on the main thread (the blocking dialogs need
// that). Arguments come from bridge.js under the keys named here (p, ps, o, id, index).
use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::{files, hash, net, util};

pub const NO_ENGINE: &str = "The download engine is not in this preview build yet";

fn text_of(o: &Value, key: &str) -> String {
    match o.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn lossy(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

fn downloads_dir(app: &AppHandle) -> PathBuf {
    match app.path().download_dir() {
        Ok(p) => p,
        Err(_) => home_dir(app),
    }
}

fn home_dir(app: &AppHandle) -> PathBuf {
    match app.path().home_dir() {
        Ok(p) => p,
        Err(_) => PathBuf::from("."),
    }
}

/// Where downloads go when nothing else was chosen: <Downloads>/Kurokawa, as desktop/main.cjs gives aria2.
fn default_dir(app: &AppHandle) -> PathBuf {
    downloads_dir(app).join("Kurokawa")
}

/* ---------- state ---------- */

#[tauri::command]
pub async fn kt_state() -> Result<Value, String> {
    Ok(
        json!({ "available": false, "reason": NO_ENGINE, "os": util::node_platform(), "arch": util::node_arch() }),
    )
}

#[tauri::command]
pub async fn kt_list() -> Result<Value, String> {
    Ok(json!([]))
}

/* ---------- files ---------- */

#[tauri::command]
pub async fn kt_default_dir(app: AppHandle) -> Result<String, String> {
    Ok(lossy(&default_dir(&app)))
}

#[tauri::command]
pub async fn kt_roots(app: AppHandle) -> Result<Value, String> {
    let mut candidates: Vec<String> = vec![lossy(&default_dir(&app)), lossy(&downloads_dir(&app))];
    if let Ok(v) = app.path().video_dir() {
        candidates.push(lossy(&v));
    }
    candidates.push(lossy(&home_dir(&app)));
    let mut roots: Vec<String> = Vec::new();
    for c in candidates {
        if !c.is_empty() && !roots.contains(&c) {
            roots.push(c);
        }
    }
    Ok(json!({ "roots": roots }))
}

#[tauri::command]
pub async fn kt_list_dir(p: String) -> Result<Value, String> {
    match files::list_dir(&p) {
        Some(entries) => {
            let list: Vec<Value> = entries
                .iter()
                .map(|e| json!({ "name": e.name, "path": e.path, "dir": e.dir, "size": e.size, "mtime": e.mtime }))
                .collect();
            Ok(json!({ "entries": list, "exists": true }))
        }
        None => Ok(json!({ "entries": [], "exists": false })),
    }
}

#[tauri::command]
pub async fn kt_path_info(p: String) -> Result<Value, String> {
    match files::path_info(&p) {
        Some(i) => Ok(
            json!({ "exists": true, "dir": i.dir, "size": i.size, "name": i.name, "parent": i.parent }),
        ),
        None => Ok(json!({ "exists": false })),
    }
}

#[tauri::command]
pub async fn kt_exists(ps: Vec<String>) -> Result<Vec<bool>, String> {
    Ok(files::exists_all(&ps))
}

#[tauri::command]
pub async fn kt_siblings(p: String) -> Result<Vec<String>, String> {
    Ok(files::siblings(&p))
}

/// The file's bytes, handed to the page as an ArrayBuffer (not a JSON array of numbers).
#[tauri::command]
pub async fn kt_read_file(p: String) -> Result<tauri::ipc::Response, String> {
    let bytes: Vec<u8> = std::fs::read(&p).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn kt_write_text(o: Value) -> Result<Value, String> {
    files::write_text(&text_of(&o, "path"), &text_of(&o, "text")).map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn kt_write_temp(o: Value) -> Result<String, String> {
    let f = files::write_temp(
        &std::env::temp_dir(),
        &text_of(&o, "name"),
        &text_of(&o, "text"),
    )
    .map_err(|e| e.to_string())?;
    Ok(lossy(&f))
}

#[tauri::command]
pub async fn kt_write_temp_bytes(o: Value) -> Result<String, String> {
    let bytes = util::b64_decode(&text_of(&o, "b64"));
    let f = files::write_temp_bytes(
        &std::env::temp_dir(),
        &text_of(&o, "sub"),
        &text_of(&o, "name"),
        &bytes,
    )
    .map_err(|e| e.to_string())?;
    Ok(lossy(&f))
}

#[tauri::command]
pub async fn kt_remove_file(p: String) -> Result<Value, String> {
    files::remove_file(&p);
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn kt_hash_file(p: String) -> Result<Value, String> {
    let joined = tauri::async_runtime::spawn_blocking(move || hash::hash_file(&p)).await;
    let h = match joined {
        Ok(r) => r?,
        Err(e) => return Err(e.to_string()),
    };
    Ok(json!({ "md5": h.md5, "sha1": h.sha1, "sha256": h.sha256, "size": h.size }))
}

/* ---------- opening things ---------- */

#[tauri::command]
pub async fn kt_open_path(app: AppHandle, p: String) -> Result<(), String> {
    app.opener()
        .open_path(p, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn kt_open_external(app: AppHandle, u: String) -> Result<(), String> {
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

/// kt:open(id, fileIndex): a task's file opened, or shown in its folder (fileIndex -1). Tasks come with the engine
/// (stage 2, with the opener's reveal_item_in_dir); until then there is no task to open.
#[tauri::command]
pub async fn kt_open(id: Value, index: Option<i64>) -> Result<(), String> {
    let _ = (&id, index);
    Err(NO_ENGINE.to_string())
}

/* ---------- dialogs ---------- */

#[tauri::command]
pub async fn kt_pick_dir(app: AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    match picked {
        Some(fp) => {
            let p = fp.into_path().map_err(|e| e.to_string())?;
            Ok(Some(lossy(&p)))
        }
        None => Ok(None),
    }
}

/// kt:pickFile({ multiple?, filters?: [{ name, extensions }] }) → the paths, or null when cancelled.
#[tauri::command]
pub async fn kt_pick_file(app: AppHandle, o: Value) -> Result<Option<Vec<String>>, String> {
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
#[tauri::command]
pub async fn kt_save_text(app: AppHandle, o: Value) -> Result<Value, String> {
    let mut name = text_of(&o, "name");
    if name.is_empty() {
        name = "kurokawa.txt".to_string();
    }
    let picked = app
        .dialog()
        .file()
        .set_directory(downloads_dir(&app))
        .set_file_name(name)
        .blocking_save_file();
    let fp = match picked {
        Some(fp) => fp,
        None => return Ok(json!({ "path": null })),
    };
    let p = fp.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&p, text_of(&o, "text").as_bytes()).map_err(|e| e.to_string())?;
    Ok(json!({ "path": lossy(&p) }))
}

/* ---------- clipboard ---------- */

#[tauri::command]
pub async fn kt_clipboard_text(app: AppHandle) -> Result<String, String> {
    // (An empty clipboard, or one holding no text, is '' — as Electron's clipboard.readText() gives.)
    Ok(app.clipboard().read_text().unwrap_or_default())
}

/* ---------- network ---------- */

#[tauri::command]
pub async fn kt_http(o: Value) -> Result<Value, String> {
    net::http(&o).await
}

#[tauri::command]
pub async fn kt_check_update(app: AppHandle, o: Value) -> Result<Value, String> {
    let _ = o;
    let current = app.package_info().version.to_string();
    net::check_update(&current).await
}
