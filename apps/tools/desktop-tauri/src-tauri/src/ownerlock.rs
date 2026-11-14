// Stage P9, after the hand-over: ONE program runs the downloads both programs' sessions name. The Electron build
// handed its aria2 session and video jobs over (handover.rs engine_prestart: «carried», with the owner file's place —
// next to the session that was handed over, in the Electron build's data folder — and the handed-over ids); both
// sessions name the same partial files and .aria2 control files in the person's folders, so an old copy kept open (a
// portable .exe, a Mac's, one kept side by side) and this app must never continue one at the same time.
// The rule is kt-core's ownerlogic.rs (the same in desktop/ownerlock.cjs, one table for both): this app writes itself
// as their owner at its start (atomically: a temp file, then a rename) and renews a heartbeat every 10 s while it runs;
// marks the record released when it quits. If the old app holds them (it took them back and still runs), this app's
// aria2 session gets ` pause=true` on those entries BEFORE aria2 reads it, `kt_resume` refuses them («kt-owner:held»,
// the page says so with «Take them back», asked first), and a heartbeat takes them over by itself once the old app is
// gone (stale). Taken back here (asked, or stale): the ones this app paused for the other are resumed.
// Nothing happens when nothing was handed over (no «carried» note, or no owner file named).
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use kt_core::handoverlogic as hlogic;
use kt_core::ownerlogic as logic;

struct Ctx {
    app: AppHandle,
    file: PathBuf,
    ids: Vec<String>,
    handover: String,
    me: logic::Me,
    data: PathBuf,
}
static CTX: OnceLock<Ctx> = OnceLock::new();
/// Another program holds the handed-over downloads: they stay paused here.
static HELD: AtomicBool = AtomicBool::new(false);
/// The ones this app paused for the other owner (kept in <app data>/owner-paused.json), resumed when taken back.
static PAUSED: Mutex<Vec<String>> = Mutex::new(Vec::new());
const PAUSED_FILE: &str = "owner-paused.json";

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn read_json(p: &Path) -> Option<Value> {
    std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok())
}

/// The owner file's record (None when it is missing or not one).
fn read_rec(file: &Path) -> Option<logic::Rec> {
    let v = read_json(file)?;
    if v.get("app").and_then(|x| x.as_str()) != Some(logic::APP) || v.get("kind").and_then(|x| x.as_str()) != Some(logic::KIND) {
        return None;
    }
    Some(logic::Rec {
        owner: v.get("owner").and_then(|x| x.as_str())?.to_string(),
        pid: v.get("pid").and_then(|x| x.as_u64())? as u32,
        started_at: v.get("startedAt").and_then(|x| x.as_i64()).unwrap_or(0),
        heartbeat: v.get("heartbeat").and_then(|x| x.as_i64())?,
        released: v.get("released").and_then(|x| x.as_bool()).unwrap_or(false),
    })
}

fn status(c: &Ctx) -> (logic::Status, Option<logic::Rec>) {
    let r = read_rec(&c.file);
    let alive = r.as_ref().map(|r| r.pid != 0 && crate::vtproc::alive(r.pid)).unwrap_or(false);
    (logic::status(now_ms(), r.as_ref(), &c.me, alive), r)
}

/// This app's record written atomically (a temp file in the same folder, then a rename over the old one).
fn write_rec(c: &Ctx, released: bool) -> Result<(), String> {
    let v = json!({
        "app": logic::APP, "kind": logic::KIND, "format": logic::FORMAT, "owner": c.me.owner, "pid": c.me.pid,
        "startedAt": c.me.started_at, "heartbeat": now_ms(), "released": released, "handover": c.handover, "ids": c.ids,
    });
    let tmp = c.file.with_file_name(format!("{}.{}.tmp", logic::FILE, std::process::id()));
    std::fs::write(&tmp, v.to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &c.file).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

fn paused_load(data: &Path) -> Vec<String> {
    read_json(&data.join(PAUSED_FILE)).and_then(|v| v.as_array().cloned()).unwrap_or_default().iter().filter_map(|x| x.as_str().map(String::from)).collect()
}
fn paused_add(c: &Ctx, ids: &[String]) {
    if let Ok(mut g) = PAUSED.lock() {
        for i in ids {
            if !g.contains(i) {
                g.push(i.clone());
            }
        }
        let _ = std::fs::write(c.data.join(PAUSED_FILE), json!(*g).to_string());
    }
}
fn paused_take(c: &Ctx) -> Vec<String> {
    let mut g = match PAUSED.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let out = std::mem::take(&mut *g);
    let _ = std::fs::remove_file(c.data.join(PAUSED_FILE));
    out
}

/// What the page shows → null when nothing was handed over; else { held, status, by, since, count, paused }.
fn info() -> Value {
    let c = match CTX.get() {
        Some(c) => c,
        None => return Value::Null,
    };
    let (st, r) = status(c);
    let held = HELD.load(Ordering::SeqCst) && st == logic::Status::Held;
    json!({
        "held": held, "status": st.name(), "by": r.as_ref().map(|r| r.owner.clone()), "since": r.as_ref().map(|r| r.heartbeat),
        "count": c.ids.len(), "paused": PAUSED.lock().map(|g| g.len()).unwrap_or(0),
    })
}

const MOVING: [&str; 5] = ["downloading", "queued", "metadata", "checking", "seeding"];

/// The handed-over downloads that run here paused (aria2's and the video jobs'), remembered.
fn pause_running(c: &Ctx) {
    let mut got: Vec<String> = Vec::new();
    for v in crate::vtjobs::list().iter() {
        let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
        let st = v.get("state").and_then(|x| x.as_str()).unwrap_or("");
        if c.ids.iter().any(|x| x == id) && MOVING.contains(&st) {
            crate::vtjobs::pause(id);
            got.push(id.to_string());
        }
    }
    if let Some(e) = crate::engine::get() {
        if e.available() {
            let list = e.list().unwrap_or_else(|_| e.last());
            for v in list.as_array().cloned().unwrap_or_default().iter() {
                let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
                let st = v.get("state").and_then(|x| x.as_str()).unwrap_or("");
                if c.ids.iter().any(|x| x == id) && MOVING.contains(&st) && e.pause(id).is_ok() {
                    got.push(id.to_string());
                }
            }
        }
    }
    paused_add(c, &got);
}

/// The ones paused for the other owner resumed (taken back here).
fn resume_paused(c: &Ctx) {
    for id in paused_take(c) {
        if crate::vtjobs::has(&id) {
            crate::vtjobs::resume(&id);
        } else if let Some(e) = crate::engine::get() {
            let _ = e.resume(&id);
        }
    }
}

fn told(c: &Ctx) {
    let _ = c.app.emit("kt:downloadsOwner", info());
}

/// Taken: this app's record written, read back after a moment → whether it still names this app.
fn take(c: &Ctx, asked: bool) -> bool {
    let (st, _) = status(c);
    if !logic::may_take(st, asked) {
        return false;
    }
    if write_rec(c, false).is_err() {
        return false;
    }
    std::thread::sleep(Duration::from_millis(logic::SETTLE_MS as u64));
    if status(c).0 != logic::Status::Mine {
        return false;
    }
    if HELD.swap(false, Ordering::SeqCst) || asked {
        resume_paused(c);
    }
    told(c);
    true
}

/// Called by main.rs after handover::engine_prestart, before the engine starts: the owner taken, or — another live
/// owner holding them — their entries in this app's aria2 session paused before aria2 reads it. Then the heartbeat.
pub fn before_engine(app: &AppHandle) {
    let data = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => return,
    };
    let note = match read_json(&data.join(hlogic::ENGINE_DONE)) {
        Some(n) => n,
        None => return,
    };
    if note.get("state").and_then(|x| x.as_str()) != Some("carried") {
        return;
    }
    let file = match note.get("ownerFile").and_then(|x| x.as_str()).filter(|x| !x.is_empty()) {
        Some(f) => PathBuf::from(f),
        None => return,
    };
    // (The old app's data folder gone — removed by the person —: nobody else can run them.)
    if !file.parent().map(|p| p.is_dir()).unwrap_or(false) {
        return;
    }
    let ids: Vec<String> = note.get("ids").and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    if ids.is_empty() {
        return;
    }
    let c = Ctx {
        app: app.clone(),
        file,
        ids,
        handover: note.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        me: logic::Me { owner: "tauri".to_string(), pid: std::process::id(), started_at: now_ms() },
        data: data.clone(),
    };
    if let Ok(mut g) = PAUSED.lock() {
        *g = paused_load(&data);
    }
    let (st, _) = status(&c);
    if st == logic::Status::Held {
        // (aria2 has not read its session yet: the entries the other program holds get ` pause=true` first.)
        let sess = data.join("aria2.session");
        if let Ok(text) = std::fs::read_to_string(&sess) {
            let (out, paused) = logic::session_pause(&text, &c.ids);
            if !paused.is_empty() {
                let tmp = sess.with_extension("session.kt-owner.tmp");
                if std::fs::write(&tmp, out).is_ok() && std::fs::rename(&tmp, &sess).is_err() {
                    let _ = std::fs::remove_file(&tmp);
                }
                paused_add(&c, &paused);
            }
        }
        HELD.store(true, Ordering::SeqCst);
        eprintln!("[owner] the handed-over downloads are run by the earlier Kurokawa Tools ({}): kept paused here", c.file.display());
    } else {
        let _ = write_rec(&c, false);
    }
    if CTX.set(c).is_err() {
        return;
    }
    let _ = std::thread::Builder::new().name("kt-owner".into()).spawn(|| loop {
        std::thread::sleep(Duration::from_millis(logic::HEARTBEAT_MS as u64));
        let c = match CTX.get() {
            Some(c) => c,
            None => return,
        };
        let (st, _) = status(c);
        if HELD.load(Ordering::SeqCst) {
            // (Held by the other: taken over by itself once that one is gone.)
            if logic::may_take(st, false) {
                take(c, false);
            }
            continue;
        }
        match logic::tick(st) {
            logic::Tick::Renew | logic::Tick::Take => {
                let _ = write_rec(c, false);
            }
            logic::Tick::Yield => {
                HELD.store(true, Ordering::SeqCst);
                pause_running(c);
                told(c);
            }
        }
    });
}

/// kt_resume's guard: a handed-over download the other program runs now is not resumed here.
pub fn resume_refused(id: &str) -> bool {
    let c = match CTX.get() {
        Some(c) => c,
        None => return false,
    };
    if !HELD.load(Ordering::SeqCst) {
        return false;
    }
    !logic::resume_allowed(status(c).0, &c.ids, id)
}

/// At quit, while this app owns them: released, so the other program may take them up at once.
pub fn at_exit() {
    if let Some(c) = CTX.get() {
        if !HELD.load(Ordering::SeqCst) && status(c).0 == logic::Status::Mine {
            let _ = write_rec(c, true);
        }
    }
}

/// window.kurokawaHandover.owner() → null | { held, status, by, since, count, paused }.
#[tauri::command]
pub async fn kt_downloads_owner() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(info).await.map_err(|e| e.to_string())
}

/// window.kurokawaHandover.takeDownloads() — «Take them back», asked first by the page → { ok, …info }.
#[tauri::command]
pub async fn kt_downloads_take() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let c = match CTX.get() {
            Some(c) => c,
            None => return Value::Null,
        };
        let ok = take(c, true);
        let mut v = info();
        if let Some(o) = v.as_object_mut() {
            o.insert("ok".into(), json!(ok));
        }
        v
    })
    .await
    .map_err(|e| e.to_string())
}
