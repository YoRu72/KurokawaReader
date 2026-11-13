// desktop/main.cjs's `ipcMain.handle('kr:*')` channels as Tauri commands, kr:a-b → kr_a_b — the ones stages R0–R3
// port, all built on the shared crate (shared/shell-rs, `kurokawa_shell`); the rest of the bridge is stubbed in
// ../../bridge.js (see ../../PORTING.md). Every command is async so it runs on the async runtime, never on the main
// thread (the blocking dialogs need that); the long scan goes through spawn_blocking. Arguments come from bridge.js
// under the one-word keys named here (p, o, b64, append, text, exts).
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use kurokawa_shell::{files, net, shell};

use crate::{download, scan};

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

/* ---------- downloads (stage R3: download.rs) ---------- */

/// kr:download(url, name, id): the file fetched into <app data>/downloads/<name made safe>, progress as the
/// kr:download-progress event ({ id, pct, got, total, speed, connections }) → its path.
#[tauri::command]
pub async fn kr_download(app: AppHandle, url: String, name: String, id: Option<String>) -> Result<String, String> {
    download::download(app, url, name, id.unwrap_or_default()).await
}

/// kr:delete-download(p): the file removed when it is in the downloads folder → true; false otherwise.
#[tauri::command]
pub async fn kr_delete_download(app: AppHandle, p: String) -> Result<bool, String> {
    Ok(download::delete(&app, &p))
}

/// (This shell's own: the bridge's cancelDownload(id).) The download with that id stopped — it rejects with
/// «cancelled» — → whether one was under way.
#[tauri::command]
pub async fn kr_download_cancel(id: String) -> Result<bool, String> {
    Ok(download::cancel(&id))
}

/* ---------- DNS over HTTPS (stage R3: the shared net.rs, doh.rs) ---------- */

/// Where the choice is kept: <config>/doh.json, { provider } (main.cjs: <userData>/doh.json).
fn doh_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("doh.json"))
}

/// The provider kept, 'off' when none (main.cjs reads it so).
pub fn doh_kept(app: &AppHandle) -> String {
    doh_file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("provider").and_then(|x| x.as_str()).map(|x| x.to_string()))
        .filter(|x| !x.is_empty())
        .unwrap_or_else(|| "off".to_string())
}

/// kr:set-doh(provider, test): a provider given is kept and put in force for the app's own requests (a name, an
/// https:// address, or 'off'); → { provider } — the one kept —, and with `test` also the site https://<test>/
/// reached with it: { provider, ok: true, status, ms } or { provider, ok: false, error }.
#[tauri::command]
pub async fn kr_set_doh(app: AppHandle, provider: Option<String>, test: Option<String>) -> Result<Value, String> {
    if let Some(p) = provider {
        if let Some(f) = doh_file(&app) {
            if let Some(dir) = f.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&f, json!({ "provider": p.as_str() }).to_string());
        }
        net::set_doh(&p);
    }
    let now = doh_kept(&app);
    let host = test.unwrap_or_default();
    if host.is_empty() {
        return Ok(json!({ "provider": now }));
    }
    let mut r = net::doh_try(&host).await;
    r["provider"] = Value::String(now);
    Ok(r)
}

/* ---------- notifications (stage R3: the official notification plugin) ---------- */

/// kr:notify({ title, body, hash? }): a system notification → true when shown, false when the system has none.
/// (A click on it is not handled: the plugin gives no click on a computer; Electron's opens the app at `hash`.)
#[tauri::command]
pub async fn kr_notify(app: AppHandle, o: Value) -> Result<bool, String> {
    let title = match shell::text_of(&o, "title") {
        t if t.is_empty() => "KurokawaReader".to_string(),
        t => t,
    };
    let body = shell::text_of(&o, "body");
    let shown = app.notification().builder().title(title).body(body).show();
    Ok(shown.is_ok())
}
