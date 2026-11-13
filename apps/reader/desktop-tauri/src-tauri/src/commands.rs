// desktop/main.cjs's `ipcMain.handle('kr:*')` channels as Tauri commands, kr:a-b → kr_a_b — the ones this stage
// (R0) ports, all built on the shared crate (shared/shell-rs, `kurokawa_shell`); the rest of the bridge is stubbed in
// ../../bridge.js (see ../../PORTING.md). Every command is async so it runs on the async runtime, never on the main
// thread (the blocking dialogs need that); the long scan goes through spawn_blocking. Arguments come from bridge.js
// under the one-word keys named here (p, o, b64, append, text, exts).
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use kurokawa_shell::{files, net, shell};

use crate::scan;

/* ---------- files ---------- */

/// kr:read-file: the file's bytes, as an ArrayBuffer.
#[tauri::command]
pub async fn kr_read_file(p: String) -> Result<tauri::ipc::Response, String> {
    shell::read_file_response(&p)
}

/// kr:file-size: the size in bytes, -1 when there is no such file.
#[tauri::command]
pub async fn kr_file_size(p: String) -> Result<i64, String> {
    Ok(files::file_size(&p))
}

/// kr:folder-read: the file as text, null when it cannot be read.
#[tauri::command]
pub async fn kr_folder_read(p: String) -> Result<Option<String>, String> {
    Ok(files::read_text(&p))
}

/// kr:folder-write: the text written (UTF-8; the folder must be there, as Node's writeFile) → true.
#[tauri::command]
pub async fn kr_folder_write(p: String, text: String) -> Result<bool, String> {
    std::fs::write(&p, text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(true)
}

/// kr:write-binary: base64 bytes written, or added at the end (`append`) → true.
#[tauri::command]
pub async fn kr_write_binary(p: String, b64: String, append: bool) -> Result<bool, String> {
    let bytes = kurokawa_shell::util::b64_decode(&b64);
    files::write_bytes(&p, &bytes, append).map_err(|e| e.to_string())?;
    Ok(true)
}

/// kr:scan-device: the whole-computer scan for files with these extensions (scan.rs).
#[tauri::command]
pub async fn kr_scan_device(app: AppHandle, exts: Vec<String>) -> Result<Value, String> {
    let home = shell::home_dir(&app);
    let windows = cfg!(target_os = "windows");
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let roots = scan::roots(&home, windows);
        scan::scan(&roots, &exts)
    })
    .await;
    let s = match joined {
        Ok(s) => s,
        Err(e) => return Err(e.to_string()),
    };
    let list: Vec<Value> = s
        .files
        .iter()
        .map(|f| json!({ "path": f.path, "name": f.name, "size": f.size }))
        .collect();
    Ok(json!({ "root": s.root, "files": list, "truncated": s.truncated }))
}

/// The same walk in one folder the user picked (Tauri only: the bridge's scanFolder — the library's «Pick a folder»
/// scan by path, so its books can be linked where they are; Electron uses the web view's folder picker instead,
/// which WebKit has not). Any folder: another drive, outside the home folder — read as the user who runs the app.
#[tauri::command]
pub async fn kr_scan_folder(p: String, exts: Vec<String>) -> Result<Value, String> {
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let root = std::path::PathBuf::from(&p);
        if !root.is_dir() {
            return Err(format!("not a folder: {}", p));
        }
        Ok(scan::scan(&[root], &exts))
    })
    .await;
    let s = match joined {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(e),
        Err(e) => return Err(e.to_string()),
    };
    let list: Vec<Value> = s
        .files
        .iter()
        .map(|f| json!({ "path": f.path, "name": f.name, "size": f.size }))
        .collect();
    Ok(json!({ "root": s.root, "files": list, "truncated": s.truncated }))
}

/* ---------- dialogs ---------- */

/// kr:folder-pick: a folder chosen, null when cancelled.
#[tauri::command]
pub async fn kr_folder_pick(app: AppHandle) -> Result<Option<String>, String> {
    shell::pick_dir(&app)
}

/// kr:archive-pick-dir: the same dialog, for where an archive goes.
#[tauri::command]
pub async fn kr_archive_pick_dir(app: AppHandle) -> Result<Option<String>, String> {
    shell::pick_dir(&app)
}

/// kr:archive-pick-file({ multiple? }): the files chosen, [] when cancelled (not null, as main.cjs answers).
#[tauri::command]
pub async fn kr_archive_pick_file(app: AppHandle, o: Value) -> Result<Vec<String>, String> {
    let multiple = o.get("multiple").and_then(|m| m.as_bool()).unwrap_or(false);
    let picked = shell::pick_files(&app, &json!({ "multiple": multiple }))?;
    Ok(picked.unwrap_or_default())
}

/* ---------- the system ---------- */

/// kr:default-apps: the system's page for default apps opened (Windows, macOS) → null; false where there is none.
#[tauri::command]
pub async fn kr_default_apps(app: AppHandle) -> Result<Value, String> {
    let page = if cfg!(target_os = "windows") {
        "ms-settings:defaultapps"
    } else if cfg!(target_os = "macos") {
        "x-apple.systempreferences:"
    } else {
        return Ok(Value::Bool(false));
    };
    app.opener()
        .open_url(page.to_string(), None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

/* ---------- network ---------- */

/// kr:http: { url, method?, headers?, body?, bodyBase64?, binary? } → { status, url, headers, body }. (bridge.js asks
/// for the body as base64 and turns it into text in the page's charset itself, as main.cjs's decodeText does.)
#[tauri::command]
pub async fn kr_http(o: Value) -> Result<Value, String> {
    net::http(&o).await
}
