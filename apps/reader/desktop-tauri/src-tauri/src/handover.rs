// The hand-over's reading half (stage R6a of docs/RUST-PORT-READER.md; ../../PORTING.md «The hand-over»): the folder
// the last Electron build wrote (desktop/handover.cjs) found — through the pointer it left in this build's data
// folder, beside a portable .exe, or in Electron's own data folder —, checked (each file's size, then its SHA-256
// against the marker), read file by file for the page (src/handover.ts brings it into this web view's profile), what
// became of it kept (restored, declined: never offered twice), and deleted only when the reader asks («Free the
// space»), only a folder that is a hand-over. Nothing here writes into the folder or touches Electron's profile.
// The page reaches these through window.kurokawaHandover (../../handover-bridge.js).
//
// With KRH_SELFTEST=<file> set (and no other self-test), the page also runs ../../handovercheck.js — CI's proof that
// what an Electron profile handed over arrived (KRH_EXPECT: the Electron profile's snapshot) — and ends the process
// through the shared self-test frame, as selftest.rs does.
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use kurokawa_shell::{hash, selftest as frame, shell, util};

use crate::handoverlogic as logic;

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
    if m.get("app").and_then(|x| x.as_str()) != Some("KurokawaReader") || m.get("kind").and_then(|x| x.as_str()) != Some("handover") {
        return Err(vec![format!("{}: not a KurokawaReader hand-over", name)]);
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

/// The hand-over to offer: `p` — a folder the reader picked (it, or its `handover` folder) —, else the first found
/// whole where the Electron build leaves it → { found, dir, marker, state, looked } or { found: false, state, looked,
/// problems }. `state`: what became of a hand-over here before ({ id, state: restored | declined, at }).
#[tauri::command]
pub async fn kr_handover_find(app: AppHandle, p: Option<String>) -> Result<Value, String> {
    let state = state_file(&app).and_then(|f| read_json(&f)).unwrap_or(Value::Null);
    let list: Vec<PathBuf> = match p.filter(|x| !x.is_empty()) {
        Some(given) => vec![logic::resolve_given(Path::new(&given))],
        None => logic::candidates(env_get("KR_HANDOVER_FROM").map(PathBuf::from), pointed(&app), logic::electron_app_data(os_name(), &env_get)),
    };
    let mut looked: Vec<String> = Vec::new();
    let mut problems: Vec<String> = Vec::new();
    for d in list.iter() {
        looked.push(shell::lossy(d));
        if !d.join(logic::MARKER).is_file() {
            continue;
        }
        match check(d) {
            Ok(m) => return Ok(json!({ "found": true, "dir": shell::lossy(d), "marker": m, "state": state, "looked": looked })),
            Err(e) => problems.extend(e),
        }
    }
    Ok(json!({ "found": false, "state": state, "looked": looked, "problems": problems, "electron": electron_left() }))
}

/// The earlier (Electron) KurokawaReader, when no hand-over was found: whether its data folder holds a library (an
/// IndexedDB folder — the library is NOT here yet) and whether its program is still installed beside this one (the
/// setup keeps it until the library is handed over) → { library, program } — for the first-run screen's words.
fn electron_left() -> Value {
    let library = logic::electron_app_data(os_name(), &env_get)
        .map(|d| logic::ELECTRON_NAMES.iter().any(|n| d.join(n).join("IndexedDB").is_dir()))
        .unwrap_or(false);
    json!({ "library": library, "program": electron_program().is_some() })
}

/// The earlier (Electron) KurokawaReader's program where it is still installed: Windows — electron-builder's per-user
/// folder; a Mac — an Electron bundle (app.asar inside) in /Applications or ~/Applications. (Linux: an AppImage can be
/// anywhere — not looked for.)
fn electron_program() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        let d = PathBuf::from(env_get("LOCALAPPDATA")?).join("Programs").join("KurokawaReader");
        if d.join("resources").join("app.asar").is_file() && d.join("KurokawaReader.exe").is_file() {
            return Some(d.join("KurokawaReader.exe"));
        }
        None
    } else if cfg!(target_os = "macos") {
        let mut c = vec![PathBuf::from("/Applications/KurokawaReader.app")];
        if let Some(h) = env_get("HOME") {
            c.push(PathBuf::from(h).join("Applications").join("KurokawaReader.app"));
        }
        c.into_iter().find(|a| a.join("Contents").join("Resources").join("app.asar").is_file())
    } else {
        None
    }
}

/// «Open the previous KurokawaReader» (the first-run screen): the Electron program found above started — nothing the
/// page names is run — → true, false when there is none.
#[tauri::command]
pub async fn kr_handover_open_old() -> Result<bool, String> {
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

/// The whole check before a restore: every file the marker lists read and its SHA-256 compared → { ok, bad }.
#[tauri::command]
pub async fn kr_handover_verify(p: String) -> Result<Value, String> {
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(&p);
        let m = match check(&dir) {
            Ok(m) => m,
            Err(bad) => return json!({ "ok": false, "bad": bad }),
        };
        let mut bad: Vec<String> = Vec::new();
        let empty: Vec<Value> = Vec::new();
        for f in m.get("files").and_then(|x| x.as_array()).unwrap_or(&empty).iter() {
            let rel = f.get("rel").and_then(|x| x.as_str()).unwrap_or("");
            let want = f.get("sha256").and_then(|x| x.as_str()).unwrap_or("").to_ascii_lowercase();
            let path = match logic::join_rel(&dir, rel) {
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
        json!({ "ok": bad.is_empty(), "bad": bad })
    })
    .await;
    joined.map_err(|e| e.to_string())
}

/// The most one range read answers (the page asks for 8 MiB pieces).
const READ_MAX: u64 = 64 * 1024 * 1024;

/// One file of the hand-over (`rel`, a path the marker may list) → its bytes, as kr_read_file answers; with `at`
/// (and `len`, 8 MiB when not given, at most 64 MiB) only that piece of it — fewer bytes at the file's end, none
/// past it —, so a book of several GB is brought piece by piece and never held whole in one IPC answer.
#[tauri::command]
pub async fn kr_handover_read(p: String, rel: String, at: Option<u64>, len: Option<u64>) -> Result<tauri::ipc::Response, String> {
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
pub async fn kr_handover_mark(app: AppHandle, o: Value) -> Result<bool, String> {
    let id = o.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let st = o.get("state").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if id.is_empty() || !(st == "restored" || st == "declined") {
        return Err("a hand-over's id and its state (restored, declined) are needed".to_string());
    }
    let f = state_file(&app).ok_or_else(|| "no data folder".to_string())?;
    if let Some(d) = f.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let v = json!({ "id": id, "state": st, "at": now_ms(), "counts": o.get("counts").cloned().unwrap_or(Value::Null) });
    let tmp = f.with_extension("json.tmp");
    std::fs::write(&tmp, v.to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &f).map_err(|e| e.to_string())?;
    Ok(true)
}

/// «Free the space», after the reader said yes: the hand-over folder deleted — only a folder named `handover` that
/// holds a hand-over's marker; never Electron's profile → { freed } (bytes).
#[tauri::command]
pub async fn kr_handover_free(p: String) -> Result<Value, String> {
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

/* ---------- CI: the hand-over's own check (KRH_SELFTEST) ---------- */

/// The check script (None in a normal run, or when another self-test runs in this process).
pub fn check_script(app: &AppHandle) -> Option<String> {
    if frame::active() || std::env::var_os("KR_SELFTEST").is_some() || std::env::var_os("KR_ENGINETEST").is_some() {
        return None;
    }
    if !frame::begin("KRH") {
        return None;
    }
    // (The expectation is put in the page AS WRITTEN — JSON is JavaScript —, only checked to be JSON: parsed into a
    // serde_json Value and written again, a float can come back one unit in the last place off (serde_json's default
    // float parsing is not exact: CI run 43514013594 compared a book's `pct` 0.4649031833359958 the page wrote with
    // 0.46490318333599573 and failed the check). The page compares numbers as the Electron profile wrote them.)
    let expect = env_get("KRH_EXPECT")
        .and_then(|p| std::fs::read_to_string(p).ok())
        .filter(|t| serde_json::from_str::<Value>(t).is_ok())
        .unwrap_or_else(|| "null".to_string());
    let os = json!(util::node_platform());
    let data_dir = json!(app.path().app_data_dir().ok().map(|d| shell::lossy(&d)));
    Some(format!("window.__KRH_CHECK__ = {{ \"expect\": {}, \"os\": {}, \"dataDir\": {} }};\n{}", expect.trim(), os, data_dir, CHECK_JS))
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
pub async fn kr_handover_check_progress(o: Value) -> Result<(), String> {
    only_in_check()?;
    frame::progress(o)
}

/// The check's verdict: written to KRH_SELFTEST's file, the process ended (0 all required passed, 1 not).
#[tauri::command]
pub async fn kr_handover_check_done(o: Value) -> Result<(), String> {
    only_in_check()?;
    frame::done(o)
}
