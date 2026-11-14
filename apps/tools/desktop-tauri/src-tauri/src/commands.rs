// desktop/main.cjs's `ipcMain.handle('kt:*')` channels as Tauri commands: kt:xyz → kt_xyz (stage 1: files, dialogs,
// clipboard, http, update check; stage 2: the download engine, engine.rs; stage P3's file functions and the Files
// page's jobs: filecmds.rs). Every command is async so it runs on the async runtime, never on the main thread (the
// blocking dialogs need that); the engine's work, which is synchronous, goes through spawn_blocking. Arguments come
// from bridge.js under the keys named here (p, ps, o, id, index, …). Since stage P3 the bodies of the shell's own
// channels are the shared crate's (kurokawa_shell: shell, files, hash, net — the same code the Reader runs); these are
// thin wrappers under Tools' names.
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use kurokawa_shell::shell::{self, downloads_dir, home_dir, lossy, text_of};
use kurokawa_shell::{files, hash, net, util};

use crate::engine::{self, Engine};

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
    Ok(shell::list_dir_value(&p))
}

#[tauri::command]
pub async fn kt_path_info(p: String) -> Result<Value, String> {
    Ok(shell::path_info_value(&p))
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
    shell::read_file_response(&p)
}

#[tauri::command]
pub async fn kt_write_text(o: Value) -> Result<Value, String> {
    files::write_text(&text_of(&o, "path"), &text_of(&o, "text")).map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn kt_write_temp(o: Value) -> Result<String, String> {
    let f = files::write_temp(&std::env::temp_dir(), &text_of(&o, "name"), &text_of(&o, "text"))
        .map_err(|e| e.to_string())?;
    Ok(lossy(&f))
}

#[tauri::command]
pub async fn kt_write_temp_bytes(o: Value) -> Result<String, String> {
    let bytes = util::b64_decode(&text_of(&o, "b64"));
    let f = files::write_temp_bytes(&std::env::temp_dir(), &text_of(&o, "sub"), &text_of(&o, "name"), &bytes)
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
    shell::open_path(&app, p)
}

#[tauri::command]
pub async fn kt_open_external(app: AppHandle, u: String) -> Result<(), String> {
    shell::open_external(&app, u)
}

/// kt:open(id, fileIndex): a task's file opened with its program, or shown in its folder (fileIndex −1, or a file
/// that cannot be opened) — chosen there where this build's opener can (filecmds::reveal).
#[tauri::command]
pub async fn kt_open(app: AppHandle, id: Value, index: Option<i64>) -> Result<(), String> {
    let idt = id_text(&id);
    let i = index.unwrap_or(0);
    let p = with_engine(move |e| e.file_of(&idt, i)).await?;
    if index == Some(-1) || (index.is_none() && p.is_empty()) {
        return crate::filecmds::reveal(&app, &p);
    }
    match shell::open_path(&app, p.clone()) {
        Ok(()) => Ok(()),
        Err(_) => crate::filecmds::reveal(&app, &p),
    }
}

/* ---------- dialogs ---------- */

#[tauri::command]
pub async fn kt_pick_dir(app: AppHandle) -> Result<Option<String>, String> {
    shell::pick_dir(&app)
}

/// kt:pickFile({ multiple?, filters?: [{ name, extensions }] }) → the paths, or null when cancelled.
#[tauri::command]
pub async fn kt_pick_file(app: AppHandle, o: Value) -> Result<Option<Vec<String>>, String> {
    shell::pick_files(&app, &o)
}

/// kt:saveText({ name, text }): a save dialog in Downloads; the text written where chosen → { path | null }.
#[tauri::command]
pub async fn kt_save_text(app: AppHandle, o: Value) -> Result<Value, String> {
    shell::save_text(&app, &o)
}

/* ---------- clipboard ---------- */

#[tauri::command]
pub async fn kt_clipboard_text(app: AppHandle) -> Result<String, String> {
    Ok(shell::clipboard_text(&app))
}

/* ---------- network ---------- */

#[tauri::command]
pub async fn kt_http(o: Value) -> Result<Value, String> {
    net::http(&o).await
}

/// kt:checkUpdate: the newest tools-v* release (they are all pre-releases) newer than this one.
#[tauri::command]
pub async fn kt_check_update(app: AppHandle, o: Value) -> Result<Value, String> {
    let _ = o;
    let current = app.package_info().version.to_string();
    net::check_update(&current).await
}
