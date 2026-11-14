// The hand-over's reading half (Tools' stage P9; ../../PORTING.md «P9 — the hand-over»): the folder the last Electron
// build wrote (desktop/handover.cjs) found — through the pointer it left in this build's data folder, beside a
// portable .exe, or in Electron's own data folder —, checked (each file's size, then its SHA-256 against the marker),
// read file by file for the page (src/handover.ts brings the settings, lists and database into this web view's
// profile), what became of it kept (restored, declined: never offered twice), and deleted only when the person asks
// («Free the space»), only a folder that is a hand-over. An adapted copy of the Reader's
// apps/reader/desktop-tauri/src-tauri/src/handover.rs (stage R6a), Tools' names; its pure parts are kt-core's
// handoverlogic.rs.
//
// Tools' own, before anything else starts (`engine_prestart`, called by main.rs ahead of the video tools and the
// engine): the download engine's files — aria2's session, the app's notes on each download, the engine's settings,
// the DHT's nodes, the video jobs — put into this build's data folder, once, when this build has none of its own, with
// the downloads that were moving when the bridge build paused them set going again (handoverlogic session_unpause).
// The downloaded files and aria2's .aria2 control files stay where they are (the person's download folders): aria2
// here takes each download up from its control file, as a restart of the Electron build would. The screen
// translator's own fonts are copied into <app data>/screen-fonts. Nothing here writes into the hand-over folder or
// touches Electron's data folder.
//
// With KTH_SELFTEST=<file> set (and no other self-test), the page also runs ../../handovercheck.js — CI's proof that
// what an Electron profile handed over arrived (KTH_EXPECT: the Electron profile's snapshot) — and ends the process
// through the shared self-test frame, as selftest.rs does.
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use kurokawa_shell::{hash, selftest as frame, shell, util};

use kt_core::handoverlogic as logic;

/// window.kurokawaHandover, added to the window's initialization script after bridge.js.
pub const BRIDGE_JS: &str = include_str!("../../handover-bridge.js");
const CHECK_JS: &str = include_str!("../../handovercheck.js");

fn env_get(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

fn os_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_json(p: &Path) -> Option<Value> {
    std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok())
}

fn write_atomic(p: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("kt-handover.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

fn state_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(logic::STATE))
}

/// The folders the Electron build's pointers name: in this build's data folder, and beside this program (a portable
/// .exe's).
fn pointed(app: &AppHandle) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = Vec::new();
    if let Ok(d) = app.path().app_data_dir() {
        files.push(d.join(logic::POINTER));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            files.push(d.join(logic::PORTABLE_POINTER));
        }
    }
    files
        .iter()
        .filter_map(|f| read_json(f))
        .filter_map(|v| v.get("dir").and_then(|x| x.as_str()).map(PathBuf::from))
        .collect()
}

/// A hand-over folder checked cheaply: its marker is a hand-over's, of a format this build reads, and every file it
/// lists is there at its size → the marker; else what is wrong.
fn check(dir: &Path) -> Result<Value, Vec<String>> {
    let name = shell::lossy(dir);
    let m = match read_json(&dir.join(logic::MARKER)) {
        Some(m) => m,
        None => return Err(vec![format!("{}: no readable marker", name)]),
    };
    if m.get("app").and_then(|x| x.as_str()) != Some(logic::APP) || m.get("kind").and_then(|x| x.as_str()) != Some("handover") {
        return Err(vec![format!("{}: not a Kurokawa Tools hand-over", name)]);
    }
    let format = m.get("format").and_then(|x| x.as_u64()).unwrap_or(0);
    if format == 0 || format > logic::FORMAT {
        return Err(vec![format!("{}: format {} (this build reads up to {})", name, format, logic::FORMAT)]);
    }
    let files = match m.get("files").and_then(|x| x.as_array()) {
        Some(f) => f,
        None => return Err(vec![format!("{}: the marker lists no files", name)]),
    };
    let mut bad: Vec<String> = Vec::new();
    for f in files.iter() {
        let rel = f.get("rel").and_then(|x| x.as_str()).unwrap_or("");
        let size = f.get("size").and_then(|x| x.as_u64());
        let p = match logic::join_rel(dir, rel) {
            Some(p) => p,
            None => {
                bad.push(format!("{}: not a path in the hand-over", rel));
                continue;
            }
        };
        match (std::fs::metadata(&p), size) {
            (Ok(md), Some(s)) if md.is_file() && md.len() == s => {}
            (Ok(md), Some(s)) => bad.push(format!("{}: {} bytes, {} expected", rel, md.len(), s)),
            (Err(_), _) => bad.push(format!("{}: missing", rel)),
            (_, None) => bad.push(format!("{}: no size in the marker", rel)),
        }
        if bad.len() > 20 {
            break;
        }
    }
    if bad.is_empty() {
        Ok(m)
    } else {
        Err(bad)
    }
}

/// The first whole hand-over where the Electron build leaves it → (its folder, its marker).
fn first_found(app: &AppHandle) -> Option<(PathBuf, Value)> {
    for d in logic::candidates(env_get("KT_HANDOVER_FROM").map(PathBuf::from), pointed(app), logic::electron_app_data(os_name(), &env_get)) {
        if !d.join(logic::MARKER).is_file() {
            continue;
        }
        if let Ok(m) = check(&d) {
            return Some((d, m));
        }
    }
    None
}

/// The hand-over to offer: `p` — a folder the person picked (it, or its `handover` folder) —, else the first found
/// whole where the Electron build leaves it → { found, dir, marker, state, engine, dataDir, looked } or { found: false,
/// state, looked, problems, electron }. `state`: what became of a hand-over here before; `engine`: what became of its
/// downloads at this build's first start (engine_prestart).
#[tauri::command]
pub async fn kt_handover_find(app: AppHandle, p: Option<String>) -> Result<Value, String> {
    let state = state_file(&app).and_then(|f| read_json(&f)).unwrap_or(Value::Null);
    let data_dir = app.path().app_data_dir().ok();
    let engine = data_dir.as_ref().and_then(|d| read_json(&d.join(logic::ENGINE_DONE))).unwrap_or(Value::Null);
    let data = json!(data_dir.as_ref().map(|d| shell::lossy(d)));
    let list: Vec<PathBuf> = match p.filter(|x| !x.is_empty()) {
        Some(given) => vec![logic::resolve_given(Path::new(&given))],
        None => logic::candidates(env_get("KT_HANDOVER_FROM").map(PathBuf::from), pointed(&app), logic::electron_app_data(os_name(), &env_get)),
    };
    let mut looked: Vec<String> = Vec::new();
    let mut problems: Vec<String> = Vec::new();
    for d in list.iter() {
        looked.push(shell::lossy(d));
        if !d.join(logic::MARKER).is_file() {
            continue;
        }
        match check(d) {
            Ok(m) => return Ok(json!({ "found": true, "dir": shell::lossy(d), "marker": m, "state": state, "engine": engine, "dataDir": data, "looked": looked })),
            Err(e) => problems.extend(e),
        }
    }
    Ok(json!({ "found": false, "state": state, "engine": engine, "dataDir": data, "looked": looked, "problems": problems, "electron": electron_left() }))
}

/// The earlier (Electron) Kurokawa Tools, when no hand-over was found: whether its data folder holds anything of the
/// person's (web storage, the database, notes on downloads — NOT here yet) and whether its program is still installed
/// beside this one (the installer keeps it until its data is handed over) → { library, program } — the first-run
/// screen's words.
fn electron_left() -> Value {
    let library = logic::electron_app_data(os_name(), &env_get)
        .map(|d| {
            logic::ELECTRON_NAMES.iter().any(|n| {
                let u = d.join(n);
                logic::electron_has_data(u.join("Local Storage").is_dir(), u.join("IndexedDB").is_dir(), u.join("tasks.json").is_file())
            })
        })
        .unwrap_or(false);
    json!({ "library": library, "program": electron_program().is_some() })
}

/// The earlier (Electron) Kurokawa Tools' program where it is still installed: Windows — electron-builder's per-user
/// folder; a Mac — an Electron bundle (app.asar inside) in /Applications or ~/Applications. (Linux: an AppImage can be
/// anywhere — not looked for.)
fn electron_program() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        let d = PathBuf::from(env_get("LOCALAPPDATA")?).join("Programs").join("Kurokawa Tools");
        if d.join("resources").join("app.asar").is_file() && d.join("Kurokawa Tools.exe").is_file() {
            return Some(d.join("Kurokawa Tools.exe"));
        }
        None
    } else if cfg!(target_os = "macos") {
        let mut c = vec![PathBuf::from("/Applications/Kurokawa Tools.app")];
        if let Some(h) = env_get("HOME") {
            c.push(PathBuf::from(h).join("Applications").join("Kurokawa Tools.app"));
        }
        c.into_iter().find(|a| a.join("Contents").join("Resources").join("app.asar").is_file())
    } else {
        None
    }
}

/// «Open the previous Kurokawa Tools» (the first-run screen): the Electron program found above started — nothing the
/// page names is run — → true, false when there is none.
#[tauri::command]
pub async fn kt_handover_open_old() -> Result<bool, String> {
    let exe = match electron_program() {
        Some(p) => p,
        None => return Ok(false),
    };
    let r = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&exe).spawn()
    } else {
        std::process::Command::new(&exe).spawn()
    };
    r.map(|_| true).map_err(|e| e.to_string())
}

/// Every file `files` lists (the marker's entries) read and its SHA-256 compared → what is wrong (empty: all good).
fn hashes_bad(dir: &Path, files: &[Value], only: Option<&dyn Fn(&str) -> bool>) -> Vec<String> {
    let mut bad: Vec<String> = Vec::new();
    for f in files.iter() {
        let rel = f.get("rel").and_then(|x| x.as_str()).unwrap_or("");
        if let Some(keep) = only {
            if !keep(rel) {
                continue;
            }
        }
        let want = f.get("sha256").and_then(|x| x.as_str()).unwrap_or("").to_ascii_lowercase();
        let path = match logic::join_rel(dir, rel) {
            Some(x) => x,
            None => {
                bad.push(format!("{}: not a path in the hand-over", rel));
                continue;
            }
        };
        match hash::hash_file(&shell::lossy(&path)) {
            Ok(h) if h.sha256.to_ascii_lowercase() == want => {}
            Ok(_) => bad.push(format!("{}: its contents changed", rel)),
            Err(e) => bad.push(format!("{}: {}", rel, e)),
        }
    }
    bad
}

/// The whole check before a restore: every file the marker lists read and its SHA-256 compared → { ok, bad }.
#[tauri::command]
pub async fn kt_handover_verify(p: String) -> Result<Value, String> {
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(&p);
        let m = match check(&dir) {
            Ok(m) => m,
            Err(bad) => return json!({ "ok": false, "bad": bad }),
        };
        let empty: Vec<Value> = Vec::new();
        let bad = hashes_bad(&dir, m.get("files").and_then(|x| x.as_array()).unwrap_or(&empty), None);
        json!({ "ok": bad.is_empty(), "bad": bad })
    })
    .await;
    joined.map_err(|e| e.to_string())
}

/// The most one range read answers (the page asks for 8 MiB pieces).
const READ_MAX: u64 = 64 * 1024 * 1024;

/// One file of the hand-over (`rel`, a path the marker may list) → its bytes, as kt_read_file answers; with `at`
/// (and `len`, 8 MiB when not given, at most 64 MiB) only that piece of it — fewer bytes at the file's end, none
/// past it —, so a large file is brought piece by piece and never held whole in one IPC answer.
#[tauri::command]
pub async fn kt_handover_read(p: String, rel: String, at: Option<u64>, len: Option<u64>) -> Result<tauri::ipc::Response, String> {
    let path = logic::join_rel(Path::new(&p), &rel).ok_or_else(|| format!("not a path in the hand-over: {}", rel))?;
    if at.is_none() && len.is_none() {
        return shell::read_file_response(&shell::lossy(&path));
    }
    let from = at.unwrap_or(0);
    let want = len.unwrap_or(8 * 1024 * 1024).min(READ_MAX);
    let joined = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        use std::io::{Read, Seek, SeekFrom};
        let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        f.seek(SeekFrom::Start(from)).map_err(|e| e.to_string())?;
        let mut buf: Vec<u8> = Vec::with_capacity(want as usize);
        f.take(want).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        Ok(buf)
    })
    .await;
    let bytes: Vec<u8> = joined.map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// What became of a hand-over, kept in this build's data folder: { id, state: 'restored' | 'declined', counts } →
/// true. (A restored or declined hand-over is not offered at the start again; Settings still offers it.)
#[tauri::command]
pub async fn kt_handover_mark(app: AppHandle, o: Value) -> Result<bool, String> {
    let id = o.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let st = o.get("state").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if id.is_empty() || !(st == "restored" || st == "declined") {
        return Err("a hand-over's id and its state (restored, declined) are needed".to_string());
    }
    let f = state_file(&app).ok_or_else(|| "no data folder".to_string())?;
    let v = json!({ "id": id, "state": st, "at": now_ms(), "counts": o.get("counts").cloned().unwrap_or(Value::Null) });
    write_atomic(&f, v.to_string().as_bytes())?;
    Ok(true)
}

/// «Free the space», after the person said yes: the hand-over folder deleted — only a folder named `handover` that
/// holds a hand-over's marker; never Electron's data folder, never the downloads → { freed } (bytes).
#[tauri::command]
pub async fn kt_handover_free(p: String) -> Result<Value, String> {
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(&p);
        if !logic::deletable(&dir) {
            return Err(format!("not a hand-over folder: {}", p));
        }
        let ok = read_json(&dir.join(logic::MARKER)).map(|m| m.get("kind").and_then(|x| x.as_str()) == Some("handover")).unwrap_or(false);
        if !ok {
            return Err(format!("not a hand-over folder: {}", p));
        }
        let freed = logic::folder_size(&dir);
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(json!({ "freed": freed }))
    })
    .await;
    match joined {
        Ok(r) => r,
        Err(e) => Err(e.to_string()),
    }
}

/* ---------- before the engine starts: the downloads carried (Tools' own) ---------- */

/// At this build's start, before the video tools and the download engine read their files (main.rs): when a whole
/// hand-over is found that this build has not taken the engine's files from yet, and this build's engine has nothing
/// of its own, the engine's files are checked (SHA-256 against the marker) and copied in — aria2's session with the
/// downloads that were moving set going again —, the screen translator's fonts too; what happened is written to
/// <app data>/handover-engine.json (the page says it). Never fails the start: any problem leaves this build's files as
/// they were. In a self-test run (KT_SELFTEST) nothing is done unless KT_HANDOVER_FROM names the folder.
pub fn engine_prestart(app: &AppHandle) {
    if frame::out_path("KT").is_some() && env_get("KT_HANDOVER_FROM").is_none() {
        return;
    }
    let data = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => return,
    };
    let done_file = data.join(logic::ENGINE_DONE);
    let (dir, marker) = match first_found(app) {
        Some(x) => x,
        None => return,
    };
    let id = marker.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if let Some(prev) = read_json(&done_file) {
        if prev.get("id").and_then(|x| x.as_str()) == Some(id.as_str()) {
            return;
        }
    }
    let note = |state: &str, extra: Value| {
        let mut v = json!({ "id": id, "state": state, "at": now_ms() });
        if let (Some(o), Value::Object(e)) = (v.as_object_mut(), extra) {
            for (k, x) in e {
                o.insert(k, x);
            }
        }
        let _ = write_atomic(&done_file, v.to_string().as_bytes());
    };
    let empty: Vec<Value> = Vec::new();
    let files = marker.get("files").and_then(|x| x.as_array()).unwrap_or(&empty);
    let listed = |rel: &str| files.iter().any(|f| f.get("rel").and_then(|x| x.as_str()) == Some(rel));
    // (The engine's files and the screen fonts: checked before anything is copied.)
    let wanted = |rel: &str| rel.starts_with("engine/") || rel.starts_with("shell/screen-fonts");
    let wanted_dyn: &dyn Fn(&str) -> bool = &wanted;
    let bad = hashes_bad(&dir, files, Some(wanted_dyn));
    if !bad.is_empty() {
        eprintln!("[handover] the engine's files are damaged, not carried: {}", bad.join("; "));
        note("damaged", json!({ "bad": bad.into_iter().take(5).collect::<Vec<String>>() }));
        return;
    }
    // Screen fonts: each copied in under its own name (never over a font of the same name).
    let fonts_dir = data.join("screen-fonts");
    let mut fonts = 0u32;
    let index: Vec<Value> = if listed(logic::FONTS_INDEX) {
        logic::join_rel(&dir, logic::FONTS_INDEX).and_then(|p| read_json(&p)).and_then(|v| v.as_array().cloned()).unwrap_or_default()
    } else {
        Vec::new()
    };
    for x in index.iter() {
        let rel = x.get("rel").and_then(|v| v.as_str()).unwrap_or("");
        let name = x.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if !rel.starts_with("shell/screen-fonts/") || !listed(rel) || !logic::font_name_ok(name) {
            continue;
        }
        let to = fonts_dir.join(name);
        if to.exists() {
            continue;
        }
        if let Some(from) = logic::join_rel(&dir, rel) {
            if std::fs::create_dir_all(&fonts_dir).is_ok() && std::fs::copy(&from, &to).is_ok() {
                fonts += 1;
            }
        }
    }
    let read = |name: &str| std::fs::read_to_string(data.join(name)).ok();
    if !logic::engine_target_empty(read("tasks.json").as_deref(), read("aria2.session").as_deref(), read("video-jobs.json").as_deref()) {
        note("kept-own", json!({ "fonts": fonts }));
        return;
    }
    let moving: Vec<String> = if listed(logic::ENGINE_MOVING) {
        logic::join_rel(&dir, logic::ENGINE_MOVING)
            .and_then(|p| std::fs::read_to_string(p).ok())
            .map(|t| logic::parse_moving(&t))
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let mut copied = 0u32;
    let mut downloads = 0usize;
    let mut videos = 0usize;
    // (The downloads both programs' sessions now name — aria2's gids and the video jobs' ids —, for the owner file
    // next to the session that was handed over: ownerlock.rs.)
    let mut ids: Vec<String> = Vec::new();
    for &(rel, name) in logic::ENGINE_FILES.iter() {
        if !listed(rel) {
            continue;
        }
        let from = match logic::join_rel(&dir, rel) {
            Some(p) => p,
            None => continue,
        };
        let bytes = match std::fs::read(&from) {
            Ok(b) => b,
            Err(e) => {
                note("error", json!({ "why": format!("{}: {}", rel, e) }));
                return;
            }
        };
        let out: Vec<u8> = if name == "aria2.session" {
            let text = String::from_utf8_lossy(&bytes).to_string();
            let gids = logic::session_gids(&text);
            downloads = gids.len();
            ids.extend(gids);
            logic::session_unpause(&text, &moving).into_bytes()
        } else {
            if name == "video-jobs.json" {
                let jobs = serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
                videos = jobs.len();
                ids.extend(jobs.iter().filter_map(|j| j.get("id").and_then(|x| x.as_str()).map(String::from)));
            }
            bytes
        };
        if let Err(e) = write_atomic(&data.join(name), &out) {
            note("error", json!({ "why": format!("{}: {}", name, e) }));
            return;
        }
        copied += 1;
    }
    let owner_file = marker.get("from").and_then(|f| f.get("userData")).and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(|d| shell::lossy(&Path::new(d).join(kt_core::ownerlogic::FILE)));
    note("carried", json!({ "files": copied, "downloads": downloads, "moving": moving.len(), "videos": videos, "fonts": fonts, "ownerFile": owner_file, "ids": ids }));
}

/* ---------- CI: the hand-over's own check (KTH_SELFTEST) ---------- */

/// The check script (None in a normal run, or when another self-test runs in this process).
pub fn check_script(app: &AppHandle) -> Option<String> {
    if frame::active() || std::env::var_os("KT_SELFTEST").is_some() {
        return None;
    }
    if !frame::begin("KTH") {
        return None;
    }
    // (The expectation is put in the page AS WRITTEN — JSON is JavaScript —, only checked to be JSON: serde_json's
    // default float parsing is not exact (the Reader's CI run 43514013594).)
    let expect = env_get("KTH_EXPECT")
        .and_then(|p| std::fs::read_to_string(p).ok())
        .filter(|t| serde_json::from_str::<Value>(t).is_ok())
        .unwrap_or_else(|| "null".to_string());
    let os = json!(util::node_platform());
    let data_dir = json!(app.path().app_data_dir().ok().map(|d| shell::lossy(&d)));
    Some(format!("window.__KTH_CHECK__ = {{ \"expect\": {}, \"os\": {}, \"dataDir\": {} }};\n{}", expect.trim(), os, data_dir, CHECK_JS))
}

fn only_in_check() -> Result<(), String> {
    if frame::active() {
        Ok(())
    } else {
        Err("not a hand-over check run".to_string())
    }
}

/// The check's results so far (what the watchdog writes if the page stalls).
#[tauri::command]
pub async fn kt_handover_check_progress(o: Value) -> Result<(), String> {
    only_in_check()?;
    frame::progress(o)
}

/// The check's verdict: written to KTH_SELFTEST's file, the process ended (0 all required passed, 1 not).
#[tauri::command]
pub async fn kt_handover_check_done(o: Value) -> Result<(), String> {
    only_in_check()?;
    frame::done(o)
}
