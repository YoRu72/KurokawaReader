// Stage P3's file functions as Tauri commands (desktop/main.cjs's channels, kt:xyz → kt_xyz, the same results):
//   kt:deletePath      to the system's recycle bin (trash.rs), else removed — as main.cjs falls back to fs.rm
//   kt:archiveFree     the free space of the disk holding a folder (the nearest one that exists)
//   kt:fontDirs        the system's and the user's font folders; kt:fontIndex their fonts' family names (kt-core)
//   kt:megaDecrypt     a MEGA file decrypted in place (kt-core, AES-128-CTR)
//   kt:screenFontAdd / kt:screenFontRemove   the screen translator's own fonts, in <app data>/screen-fonts
// and the Files page's jobs, which the Electron shell never had (only the phone's): copy, move and delete with the
// phone's rules and events (kt-core's filejobs — the port of KtFileJobs.java), each on a thread of its own, its events
// sent to the page as «kt:files» (bridge.js's onFilesJob), its questions answered with kt_files_answer, stopped with
// kt_files_cancel. These four are the Tauri shell's own: the page uses them where the bridge has them.
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use kurokawa_shell::shell::{lossy, text_of};
use kurokawa_shell::{selftest, util};
use kt_core::{filejobs, fontnames, mega, places};

use crate::trash;

/// Blocking work run off the async runtime.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(r) => r,
        Err(e) => Err(e.to_string()),
    }
}

/* ---------- the recycle bin ---------- */

/// kt:deletePath(p) → { ok, trashed }: to the recycle bin; when the system will not take it there, removed (a folder
/// with all inside), as main.cjs does; { ok: false } when neither worked. (`trashed`, which main.cjs does not give,
/// says which — the self-test reads it.)
#[tauri::command]
pub async fn kt_delete_path(p: String) -> Result<Value, String> {
    blocking(move || {
        let path = PathBuf::from(&p);
        if trash::trash(&path).is_ok() {
            return Ok(json!({ "ok": true, "trashed": true }));
        }
        let gone = match std::fs::symlink_metadata(&path) {
            Ok(m) if m.is_dir() => std::fs::remove_dir_all(&path).is_ok(),
            Ok(_) => std::fs::remove_file(&path).is_ok(),
            // (Nothing there: as fs.rm with force, nothing to do.)
            Err(_) => true,
        };
        Ok(json!({ "ok": gone, "trashed": false }))
    })
    .await
}

/* ---------- free space ---------- */

/// Bytes free for this user on the disk holding `p` (Node's statfs bavail × bsize); 2^53 − 1 when unknown.
pub fn free_space(p: &Path) -> u64 {
    disk_space(p).map(|(free, _)| free).unwrap_or(MAX_SAFE)
}

/// (free for this user, total) bytes of the disk holding `p`; None when the system will not say.
#[cfg(unix)]
pub fn disk_space(p: &Path) -> Option<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(p.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    let r = unsafe { libc::statvfs(c.as_ptr(), &mut st) };
    if r != 0 {
        return None;
    }
    let unit = st.f_frsize as u64;
    Some(((st.f_bavail as u64).saturating_mul(unit), (st.f_blocks as u64).saturating_mul(unit)))
}

#[cfg(windows)]
pub fn disk_space(p: &Path) -> Option<(u64, u64)> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(dir: *const u16, avail: *mut u64, total: *mut u64, free: *mut u64) -> i32;
    }
    let w: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut avail: u64 = 0;
    let mut total: u64 = 0;
    let mut free: u64 = 0;
    let ok = unsafe { GetDiskFreeSpaceExW(w.as_ptr(), &mut avail, &mut total, &mut free) };
    if ok != 0 {
        Some((avail, total))
    } else {
        None
    }
}

#[cfg(not(any(unix, windows)))]
pub fn disk_space(_p: &Path) -> Option<(u64, u64)> {
    None
}

/// JavaScript's largest exact integer: «unknown» (the page treats anything ≥ 1e15 as unknown).
const MAX_SAFE: u64 = 9_007_199_254_740_991;

/// kt:archiveFree({ dir }) → { free }: the folder, or the nearest folder above it that exists (the default folder when
/// none is given).
#[tauri::command]
pub async fn kt_archive_free(app: AppHandle, o: Value) -> Result<Value, String> {
    let mut d = text_of(&o, "dir");
    if d.is_empty() {
        d = lossy(&crate::commands::default_dir(&app));
    }
    blocking(move || {
        let mut p = PathBuf::from(&d);
        while !p.exists() {
            match p.parent() {
                Some(up) if up != p => p = up.to_path_buf(),
                _ => break,
            }
        }
        Ok(json!({ "free": free_space(&p) }))
    })
    .await
}

/* ---------- fonts ---------- */

/// kt:fontDirs → the font folders that exist.
#[tauri::command]
pub async fn kt_font_dirs(app: AppHandle) -> Result<Vec<String>, String> {
    let home = kurokawa_shell::shell::home_dir(&app);
    let windir = std::env::var("WINDIR").ok();
    let local = std::env::var("LOCALAPPDATA").ok();
    Ok(fontnames::font_dirs(util::node_platform(), &home, windir.as_deref(), local.as_deref())
        .iter()
        .map(|p| lossy(p))
        .collect())
}

/// kt:fontIndex(dirs) → [{ path, size, mtime, families }].
#[tauri::command]
pub async fn kt_font_index(dirs: Value) -> Result<Value, String> {
    let list: Vec<PathBuf> = match dirs {
        Value::Array(xs) => xs.iter().map(|x| PathBuf::from(x.as_str().map(|s| s.to_string()).unwrap_or_else(|| x.to_string()))).collect(),
        _ => Vec::new(),
    };
    blocking(move || {
        let ix = fontnames::index(&list);
        Ok(Value::Array(
            ix.into_iter()
                .map(|f| json!({ "path": f.path, "size": f.size, "mtime": f.mtime, "families": f.families }))
                .collect(),
        ))
    })
    .await
}

/* ---------- MEGA ---------- */

/// kt:megaDecrypt({ path, key }) → true.
#[tauri::command]
pub async fn kt_mega_decrypt(o: Value) -> Result<bool, String> {
    let path = text_of(&o, "path");
    let key = text_of(&o, "key");
    blocking(move || mega::decrypt_file(Path::new(&path), &key).map(|_| true)).await
}

/* ---------- the screen translator's fonts ---------- */

fn screen_fonts(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(d.join("screen-fonts"))
}

/// kt:screenFontAdd({ name, b64 }) → { path }: 1 kB to 40 MB, kept as <time>-<name>.
#[tauri::command]
pub async fn kt_screen_font_add(app: AppHandle, o: Value) -> Result<Value, String> {
    let dir = screen_fonts(&app)?;
    let b64 = text_of(&o, "b64");
    let mut name = text_of(&o, "name");
    if name.is_empty() {
        name = "font.ttf".to_string();
    }
    blocking(move || {
        let b = util::b64_decode(&b64);
        if b.len() < 1000 || b.len() > 40_000_000 {
            return Err("size".to_string());
        }
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let clean: String = name.chars().map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c }).collect();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let p = dir.join(format!("{}-{}", now, clean));
        std::fs::write(&p, &b).map_err(|e| e.to_string())?;
        Ok(json!({ "path": lossy(&p) }))
    })
    .await
}

/// kt:screenFontRemove({ path }) → { ok: true }: only a file of that folder.
#[tauri::command]
pub async fn kt_screen_font_remove(app: AppHandle, o: Value) -> Result<Value, String> {
    let dir = screen_fonts(&app)?;
    let p = PathBuf::from(text_of(&o, "path"));
    blocking(move || {
        if p.parent() == Some(dir.as_path()) {
            let _ = std::fs::remove_file(&p);
        }
        Ok(json!({ "ok": true }))
    })
    .await
}

/* ---------- the Files page's jobs ---------- */

/// filesJob({ id?, op: copy | move | delete, paths, dest?, conflict? }) → { id }: started on a thread of its own; its
/// events come as «kt:files». Paths must be whole (absolute) ones.
#[tauri::command]
pub async fn kt_files_job(app: AppHandle, o: Value) -> Result<Value, String> {
    let op = text_of(&o, "op");
    if !matches!(op.as_str(), "copy" | "move" | "delete") {
        return Err(format!("unknown operation: {}", op));
    }
    let mut id = text_of(&o, "id");
    if id.is_empty() {
        id = format!("fj-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    }
    let paths: Vec<PathBuf> = match o.get("paths") {
        Some(Value::Array(xs)) => xs.iter().filter_map(|x| x.as_str()).map(PathBuf::from).collect(),
        _ => Vec::new(),
    };
    if paths.is_empty() || paths.iter().any(|p| !p.is_absolute()) {
        return Err("paths: whole paths wanted".to_string());
    }
    let dest = text_of(&o, "dest");
    let dest: Option<PathBuf> = if dest.is_empty() { None } else { Some(PathBuf::from(dest)) };
    if op != "delete" && !dest.as_ref().map(|d| d.is_absolute()).unwrap_or(false) {
        return Err("dest: a whole path wanted".to_string());
    }
    let mut conflict = text_of(&o, "conflict");
    if conflict.is_empty() {
        conflict = "ask".to_string();
    }
    // (Only in a self-test run: each piece of a copy followed by a pause, so the test can catch it mid-way.)
    let pace = if selftest::active() { o.get("pace").and_then(|x| x.as_u64()).unwrap_or(0).min(500) } else { 0 };
    // (Registered here, before the thread exists: a Cancel that comes at once — even before the thread runs — finds
    // the job; a Cancel that came before this call is kept for it by kt-core.)
    filejobs::prepare(&id, &conflict, pace)?;
    let jid = id.clone();
    let spawned = std::thread::Builder::new().name(format!("files-{}", id)).spawn(move || {
        let on = |e: &filejobs::Event| {
            let v: Value = serde_json::from_str(&e.to_json()).unwrap_or(Value::Null);
            let _ = app.emit("kt:files", v);
        };
        filejobs::run_paced(&jid, &op, &paths, dest.as_deref(), &conflict, pace, &on);
    });
    if let Err(e) = spawned {
        filejobs::unprepare(&id);
        return Err(e.to_string());
    }
    Ok(json!({ "id": id }))
}

/// filesCancel({ id }).
#[tauri::command]
pub async fn kt_files_cancel(o: Value) -> Result<(), String> {
    filejobs::cancel(&text_of(&o, "id"));
    Ok(())
}

/// filesAnswer({ id, answer }): skip | replace | keep, «All» added for the rest of the job.
#[tauri::command]
pub async fn kt_files_answer(o: Value) -> Result<(), String> {
    filejobs::answer(&text_of(&o, "id"), &text_of(&o, "answer"));
    Ok(())
}

/* ---------- the Files page's storages, stat, new folder, rename (the phone plugin's shapes) ---------- */

/// The disks worth showing: Linux's mount table, a Mac's /Volumes, Windows' drive letters.
fn disks() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetLogicalDrives() -> u32;
        }
        let mask = unsafe { GetLogicalDrives() };
        // (Only drives that answer — an empty card reader or DVD drive does not.)
        places::windows_drives(mask).into_iter().filter(|d| disk_space(d).is_some()).collect()
    }
    #[cfg(target_os = "macos")]
    {
        let mut names: Vec<String> = Vec::new();
        let mut root_links: Vec<String> = Vec::new();
        if let Ok(rd) = std::fs::read_dir("/Volumes") {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if std::fs::canonicalize(e.path()).map(|t| t == Path::new("/")).unwrap_or(false) {
                    root_links.push(n.clone());
                }
                names.push(n);
            }
        }
        names.sort();
        places::mac_volumes(&names, &root_links)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let t = std::fs::read_to_string("/proc/self/mounts").unwrap_or_default();
        places::linux_mounts(&t).into_iter().filter(|p| p.is_dir()).collect()
    }
    #[cfg(not(any(unix, windows)))]
    {
        Vec::new()
    }
}

/// homeDir() → the home folder (the page's first storage where it has no filesRoots).
#[tauri::command]
pub async fn kt_home_dir(app: AppHandle) -> Result<String, String> {
    Ok(lossy(&kurokawa_shell::shell::home_dir(&app)))
}

/// filesRoots() → { allFiles: true, roots: [{ kind, path, name, readable, free, total }] }: home, Downloads, Desktop,
/// Documents (those that exist), then the disks with their space. The page names the first four in its language.
#[tauri::command]
pub async fn kt_files_roots(app: AppHandle) -> Result<Value, String> {
    let pr = app.path();
    let some = |r: Result<PathBuf, tauri::Error>| r.ok().filter(|p| p.is_dir());
    let home = Some(kurokawa_shell::shell::home_dir(&app)).filter(|p| p.is_dir());
    let downloads = some(pr.download_dir());
    let desktop = some(pr.desktop_dir());
    let documents = some(pr.document_dir());
    blocking(move || {
        let list = places::places(home, downloads, desktop, documents, &disks(), cfg!(any(windows, target_os = "macos")));
        let roots: Vec<Value> = list
            .into_iter()
            .map(|p| {
                let mut v = json!({ "kind": p.kind, "path": lossy(&p.path), "name": p.name, "readable": std::fs::read_dir(&p.path).is_ok() });
                if let Some((free, total)) = disk_space(&p.path) {
                    v["free"] = json!(free);
                    v["total"] = json!(total);
                }
                v
            })
            .collect();
        Ok(json!({ "allFiles": true, "roots": roots }))
    })
    .await
}

/// filesStat({ path }) → { exists, name, path, dir, size, mtime, readable, writable, hidden } — shallow (a folder's
/// size is not added up: the page asks it only for its writability and dates).
#[tauri::command]
pub async fn kt_files_stat(o: Value) -> Result<Value, String> {
    let p = PathBuf::from(text_of(&o, "path"));
    blocking(move || {
        let (exists, dir, size, mtime, writable, hidden) = places::stat(&p);
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| lossy(&p));
        let readable = exists && if dir { std::fs::read_dir(&p).is_ok() } else { std::fs::File::open(&p).is_ok() };
        Ok(json!({ "exists": exists, "name": name, "path": lossy(&p), "dir": dir, "size": size, "mtime": mtime, "readable": readable, "writable": writable, "hidden": hidden }))
    })
    .await
}

/// filesMkdir({ path }) → { ok, path }: the folder made (its parents too); «exists» when a file has that name.
#[tauri::command]
pub async fn kt_files_mkdir(o: Value) -> Result<Value, String> {
    let p = PathBuf::from(text_of(&o, "path"));
    blocking(move || {
        if !p.is_absolute() {
            return Err("path: a whole path wanted".to_string());
        }
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if !places::good_name(&name, cfg!(windows)) {
            return Err("bad name".to_string());
        }
        if p.exists() && !p.is_dir() {
            return Err("exists".to_string());
        }
        let ok = std::fs::create_dir_all(&p).is_ok() && p.is_dir();
        Ok(json!({ "ok": ok, "path": lossy(&p) }))
    })
    .await
}

/// filesRename({ path, name }) → { ok, path }: kt-core's rename (the phone's rules: «exists» when the name is taken,
/// a change of letter case alone by way of a passing name).
#[tauri::command]
pub async fn kt_files_rename(o: Value) -> Result<Value, String> {
    let p = PathBuf::from(text_of(&o, "path"));
    let name = text_of(&o, "name");
    blocking(move || {
        if !p.is_absolute() {
            return Err("path: a whole path wanted".to_string());
        }
        if !places::good_name(&name, cfg!(windows)) {
            return Err("bad name".to_string());
        }
        let to = filejobs::rename(&p, &name)?;
        Ok(json!({ "ok": true, "path": lossy(&to) }))
    })
    .await
}

/* ---------- show in folder ---------- */

/// The item shown in its folder, chosen there where this build's opener can (kt_reveal), else its folder opened.
pub fn reveal(app: &AppHandle, p: &str) -> Result<(), String> {
    #[cfg(kt_reveal)]
    {
        use tauri_plugin_opener::OpenerExt;
        if Path::new(p).exists() && app.opener().reveal_item_in_dir(PathBuf::from(p)).is_ok() {
            return Ok(());
        }
    }
    kurokawa_shell::shell::show_in_folder(app, p)
}
