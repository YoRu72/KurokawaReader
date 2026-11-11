// desktop/main.cjs's `ipcMain.handle('kt:*')` channels as Tauri commands: kt:xyz → kt_xyz (stage 1: files, dialogs,
// clipboard, http, update check; stage 2: the download engine, engine.rs). Every command is async so it runs on the
// async runtime, never on the main thread (the blocking dialogs need that); the engine's work, which is synchronous,
// goes through spawn_blocking. Arguments come from bridge.js under the keys named here (p, ps, o, id, index, …).
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::engine::{self, Engine};
use crate::{files, hash, net, util};

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
pub fn default_dir(app: &AppHandle) -> PathBuf {
    downloads_dir(app).join("Kurokawa")
}

/* ---------- the engine (engine.rs) ---------- */

/// The engine's work run off the async runtime: f(engine) → its result.
async fn with_engine<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce(Arc<Engine>) -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    let e = match engine::get() {
        Some(e) => e,
        None => return Err("engine".to_string()),
    };
    let joined = tauri::async_runtime::spawn_blocking(move || f(e)).await;
    match joined {
        Ok(r) => r,
        Err(err) => Err(err.to_string()),
    }
}

fn id_text(id: &Value) -> String {
    match id {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn state_now() -> Value {
    match engine::get() {
        Some(e) => e.state(),
        None => {
            json!({ "available": false, "reason": "", "os": util::node_platform(), "arch": util::node_arch() })
        }
    }
}

/// kt:state: { available, reason, os, arch }.
#[tauri::command]
pub async fn kt_state() -> Result<Value, String> {
    Ok(state_now())
}

/// kt:engineRetry: aria2c started if it is not running («Try again»), then the state.
#[tauri::command]
pub async fn kt_engine_retry() -> Result<Value, String> {
    let _ = with_engine(|e| Ok(e.ensure())).await;
    Ok(state_now())
}

/// kt:list: the downloads (the last list while aria2c is down).
#[tauri::command]
pub async fn kt_list() -> Result<Value, String> {
    with_engine(|e| Ok(e.list().unwrap_or_else(|_| e.last()))).await
}

/// kt:add(o): a download (o.video — yt-dlp — is not in this build); aria2c started first if it is not running.
#[tauri::command]
pub async fn kt_add(o: Value) -> Result<Value, String> {
    if o.get("video").map(|v| !v.is_null()).unwrap_or(false) {
        return Err("Video downloads are not in this preview build yet".to_string());
    }
    with_engine(move |e| {
        e.ensure();
        e.add(&o)
    })
    .await
}

#[tauri::command]
pub async fn kt_pause(id: Value) -> Result<(), String> {
    let id = id_text(&id);
    with_engine(move |e| e.pause(&id)).await
}

#[tauri::command]
pub async fn kt_resume(id: Value) -> Result<(), String> {
    let id = id_text(&id);
    with_engine(move |e| e.resume(&id)).await
}

#[tauri::command]
pub async fn kt_remove(id: Value, del: bool) -> Result<(), String> {
    let id = id_text(&id);
    with_engine(move |e| e.remove(&id, del)).await
}

/// kt:setFiles(id, priorities): which files of a torrent are fetched.
#[tauri::command]
pub async fn kt_set_files(id: Value, p: Value) -> Result<(), String> {
    let id = id_text(&id);
    let mut pr: Vec<i64> = Vec::new();
    if let Value::Array(xs) = &p {
        for x in xs.iter() {
            pr.push(x.as_i64().unwrap_or(0));
        }
    }
    with_engine(move |e| e.set_files(&id, &pr)).await
}

/// kt:setUrl(id, url) → the download's id (a new one when it had to be added again).
#[tauri::command]
pub async fn kt_set_url(id: Value, url: Value) -> Result<String, String> {
    let id = id_text(&id);
    let url = id_text(&url);
    with_engine(move |e| e.set_url(&id, &url)).await
}

/// kt:move(id, how): −2 first, −1 up, 1 down, 2 last in the queue.
#[tauri::command]
pub async fn kt_move(id: Value, how: Value) -> Result<(), String> {
    let id = id_text(&id);
    let how = how
        .as_i64()
        .or_else(|| how.as_f64().map(|f| f as i64))
        .unwrap_or(0);
    with_engine(move |e| e.move_task(&id, how)).await
}

/// kt:setLimits({ down, up }): bytes per second, 0 none.
#[tauri::command]
pub async fn kt_set_limits(l: Value) -> Result<(), String> {
    with_engine(move |e| e.set_limits(&l)).await
}

/// kt:configure(o): the engine's settings (aria2-config.json), applied to the running aria2c where it can.
#[tauri::command]
pub async fn kt_configure(o: Value) -> Result<(), String> {
    with_engine(move |e| e.configure(&o)).await
}

/// kt:torrentInfo(source): { name, infoHash, total, files }.
#[tauri::command]
pub async fn kt_torrent_info(s: Value) -> Result<Value, String> {
    with_engine(move |e| {
        e.ensure();
        e.torrent_info(&s)
    })
    .await
}

/// kt:rename({ id, name }) → the name given.
#[tauri::command]
pub async fn kt_rename(o: Value) -> Result<String, String> {
    let id = text_of(&o, "id");
    let name = text_of(&o, "name");
    with_engine(move |e| e.rename(&id, &name)).await
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

/// The folder holding `p`, opened (Electron's showItemInFolder, without selecting the item).
fn show_in_folder(app: &AppHandle, p: &str) -> Result<(), String> {
    let path = Path::new(p);
    let dir: PathBuf = match path.parent() {
        Some(d) if !d.as_os_str().is_empty() => d.to_path_buf(),
        _ => path.to_path_buf(),
    };
    app.opener()
        .open_path(lossy(&dir), None::<&str>)
        .map_err(|e| e.to_string())
}

/// kt:open(id, fileIndex): a task's file opened with its program, or its folder shown (fileIndex −1, or a file
/// that cannot be opened).
#[tauri::command]
pub async fn kt_open(app: AppHandle, id: Value, index: Option<i64>) -> Result<(), String> {
    let idt = id_text(&id);
    let i = index.unwrap_or(0);
    let p = with_engine(move |e| e.file_of(&idt, i)).await?;
    if index == Some(-1) || (index.is_none() && p.is_empty()) {
        return show_in_folder(&app, &p);
    }
    match app.opener().open_path(p.clone(), None::<&str>) {
        Ok(()) => Ok(()),
        Err(_) => show_in_folder(&app, &p),
    }
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
