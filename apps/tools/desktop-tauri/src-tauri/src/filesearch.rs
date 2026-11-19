// Fast file search on the computer (Tools 0.21): kt-core's file index (fileindex/) put to work for the Files page's
// «Everywhere in my folders». The folders the user chose, their exclusions and the pause are kept in
// <app data>/filesearch.json; the index itself in <app data>/fileindex.ktfi (kt-core's checked file). The service is
// started on first use — or at start, on a thread of its own, only when folders were chosen before —, never otherwise;
// its walker runs at background priority, paused while the user asks, and on battery when the user leaves that on and
// the system says so cheaply (shellrules::on_battery). The app-data folder is always left out. Nothing is sent
// anywhere and no file's contents are read: names and metadata only. All the rules are kt-core's (std only, tested by
// stdroots/fileindex.rs); here only the commands, the settings file and the service's life.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use kt_core::fileindex::shellrules::{self as rules, Refusal};
use kt_core::fileindex::{self as fi, Change, DirWalker, Kind, Query, RootSpec, Service, ServiceOptions, SortKey, StdFs};
use kurokawa_shell::shell::{lossy, text_of};

const SETTINGS: &str = "filesearch.json";
const INDEX: &str = "fileindex.ktfi";

#[derive(Clone, Default)]
struct RootSet {
    path: PathBuf,
    exclude: Vec<PathBuf>,
}

#[derive(Clone)]
struct Settings {
    roots: Vec<RootSet>,
    exclude_names: Vec<String>,
    paused: bool,
    pause_on_battery: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { roots: Vec::new(), exclude_names: Vec::new(), paused: false, pause_on_battery: true }
    }
}

struct Running {
    svc: Service,
    power_stop: AtomicBool,
    on_battery: Mutex<Option<bool>>,
}

struct Inner {
    dir: Option<PathBuf>,
    settings: Option<Settings>,
    running: Option<Arc<Running>>,
}

static STATE: Mutex<Inner> = Mutex::new(Inner { dir: None, settings: None, running: None });
/// The power thread, unparked when the service stops or the pause changes.
static POWER: Mutex<Option<std::thread::Thread>> = Mutex::new(None);

fn lock() -> std::sync::MutexGuard<'static, Inner> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Blocking work off the async runtime.
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

/* ---------- the settings file ---------- */

fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

fn paths_of(v: Option<&Value>, max: usize) -> Vec<PathBuf> {
    match v {
        Some(Value::Array(xs)) => xs.iter().filter_map(|x| x.as_str()).filter(|s| !s.is_empty()).take(max).map(PathBuf::from).collect(),
        _ => Vec::new(),
    }
}

fn read_settings(dir: &Path) -> Settings {
    let v: Value = std::fs::read_to_string(dir.join(SETTINGS)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let mut s = Settings::default();
    if let Some(Value::Array(rs)) = v.get("roots") {
        for r in rs.iter().take(rules::MAX_ROOTS) {
            let p = r.get("path").and_then(|x| x.as_str()).unwrap_or("");
            if p.is_empty() || !Path::new(p).is_absolute() {
                continue;
            }
            let path = PathBuf::from(p);
            // (Never trusted: a nested or doubled root in a hand-edited file is dropped.)
            let chosen: Vec<PathBuf> = s.roots.iter().map(|x| x.path.clone()).collect();
            if rules::check_new_root(&chosen, &path, true, None).is_err() {
                continue;
            }
            let exclude = paths_of(r.get("exclude"), rules::MAX_EXCLUDES).into_iter().filter(|e| rules::folder_under(&path, e)).collect();
            s.roots.push(RootSet { path, exclude });
        }
    }
    if let Some(Value::Array(ns)) = v.get("excludeNames") {
        s.exclude_names = ns.iter().filter_map(|x| x.as_str()).map(|x| x.trim().to_string()).filter(|x| rules::good_excluded_name(x)).take(rules::MAX_EXCLUDES).collect();
    }
    s.paused = v.get("paused").and_then(|x| x.as_bool()).unwrap_or(false);
    s.pause_on_battery = v.get("pauseOnBattery").and_then(|x| x.as_bool()).unwrap_or(true);
    s
}

fn write_settings(dir: &Path, s: &Settings) -> Result<(), String> {
    let v = json!({
        "roots": s.roots.iter().map(|r| json!({ "path": lossy(&r.path), "exclude": r.exclude.iter().map(|e| lossy(e)).collect::<Vec<_>>() })).collect::<Vec<_>>(),
        "excludeNames": s.exclude_names,
        "paused": s.paused,
        "pauseOnBattery": s.pause_on_battery,
    });
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let file = dir.join(SETTINGS);
    let tmp = dir.join(format!("{SETTINGS}.tmp"));
    let text = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, &file)) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

/// The settings, read once (and the app-data folder noted).
fn settings(app: &AppHandle) -> (Option<PathBuf>, Settings) {
    let mut g = lock();
    if g.dir.is_none() {
        g.dir = data_dir(app);
    }
    if g.settings.is_none() {
        let s = g.dir.as_deref().map(read_settings).unwrap_or_default();
        g.settings = Some(s);
    }
    (g.dir.clone(), g.settings.clone().unwrap_or_default())
}

fn save_settings(s: Settings) -> Result<(), String> {
    let mut g = lock();
    let dir = g.dir.clone().ok_or_else(|| "no app data folder".to_string())?;
    write_settings(&dir, &s)?;
    g.settings = Some(s);
    Ok(())
}

fn spec_of(r: &RootSet, s: &Settings, app_dir: Option<&Path>) -> RootSpec {
    rules::spec_for(&r.path, &r.exclude, &s.exclude_names, app_dir)
}

/* ---------- the service's life ---------- */

fn effective_pause(s: &Settings, on_battery: Option<bool>) -> bool {
    s.paused || (s.pause_on_battery && on_battery == Some(true))
}

/// The running service, started now when folders are chosen (never before).
fn ensure(app: &AppHandle) -> Option<Arc<Running>> {
    let (dir, s) = settings(app);
    let mut g = lock();
    if let Some(r) = &g.running {
        return Some(r.clone());
    }
    if s.roots.is_empty() {
        return None;
    }
    let specs: Vec<RootSpec> = s.roots.iter().map(|r| spec_of(r, &s, dir.as_deref())).collect();
    let svc = Service::start(ServiceOptions {
        file: dir.as_ref().map(|d| d.join(INDEX)),
        roots: specs,
        source: Arc::new(DirWalker::new(StdFs)),
        fs: Arc::new(StdFs),
        watcher: fi::native_watcher(),
        poll_interval: Duration::from_secs(10),
        save_every: Duration::from_secs(60),
        low_priority: true,
    });
    let battery = rules::on_battery();
    svc.set_paused(effective_pause(&s, battery));
    let run = Arc::new(Running { svc, power_stop: AtomicBool::new(false), on_battery: Mutex::new(battery) });
    g.running = Some(run.clone());
    drop(g);
    start_power_watch(Arc::downgrade(&run));
    Some(run)
}

/// Every 30 s while the service runs: the battery looked at (cheaply) and the pause set from it and the user's choice.
fn start_power_watch(run: Weak<Running>) {
    let spawned = std::thread::Builder::new().name("kt-filesearch-power".into()).spawn(move || {
        *POWER.lock().unwrap_or_else(|e| e.into_inner()) = Some(std::thread::current());
        loop {
            std::thread::park_timeout(Duration::from_secs(30));
            let Some(r) = run.upgrade() else { break };
            if r.power_stop.load(Ordering::SeqCst) {
                break;
            }
            let battery = rules::on_battery();
            *r.on_battery.lock().unwrap_or_else(|e| e.into_inner()) = battery;
            let s = lock().settings.clone().unwrap_or_default();
            r.svc.set_paused(effective_pause(&s, battery));
        }
        *POWER.lock().unwrap_or_else(|e| e.into_inner()) = None;
    });
    let _ = spawned;
}

/// Stops the service (saving, unless `discard`); waits a little for searches under way to let go of it.
fn stop(discard: bool) {
    let run = lock().running.take();
    let Some(run) = run else { return };
    run.power_stop.store(true, Ordering::SeqCst);
    if let Some(t) = POWER.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        t.unpark();
    }
    if discard {
        run.svc.discard();
    } else {
        run.svc.cancel_queries();
    }
    // (The last holder drops it: Service's Drop stops the threads and saves — or, discarded, does not.)
    let mut run = Some(run);
    for _ in 0..40 {
        match Arc::try_unwrap(run.take().unwrap()) {
            Ok(r) => {
                drop(r);
                return;
            }
            Err(back) => {
                run = Some(back);
                std::thread::park_timeout(Duration::from_millis(50));
            }
        }
    }
}

/// At the app's start: only when the user chose folders before, on a thread of its own (the saved index is read
/// there), so the start of the window never waits for it.
pub fn at_start(app: &AppHandle) {
    let h = app.clone();
    let _ = std::thread::Builder::new().name("kt-filesearch-start".into()).spawn(move || {
        let (_, s) = settings(&h);
        if !s.roots.is_empty() {
            let _ = ensure(&h);
        }
    });
}

/// At the app's end: saved and stopped.
pub fn at_exit() {
    stop(false);
}

/* ---------- the shell's own file jobs ---------- */

fn running() -> Option<Arc<Running>> {
    lock().running.clone()
}

/// A rename or move this app made (Files' rename): the index told at once (the watcher would tell it a moment later).
pub fn moved(from: &Path, to: &Path) {
    if let Some(r) = running() {
        let meta = std::fs::symlink_metadata(to).ok().map(|m| fi::walk::meta_of(&m));
        r.svc.push_changes(vec![Change::Moved { from: from.to_path_buf(), to: to.to_path_buf(), meta }]);
    }
}

/// An item this app removed (to the bin or for good).
pub fn removed(p: &Path) {
    if let Some(r) = running() {
        if std::fs::symlink_metadata(p).is_err() {
            r.svc.push_changes(vec![Change::Removed { path: p.to_path_buf() }]);
        }
    }
}

/// A folder this app made.
pub fn created(p: &Path) {
    if let Some(r) = running() {
        if let Ok(m) = std::fs::symlink_metadata(p) {
            r.svc.push_changes(vec![Change::Created { path: p.to_path_buf(), meta: fi::walk::meta_of(&m) }]);
        }
    }
}

/* ---------- what the page is told ---------- */

fn status_value(app: &AppHandle) -> Value {
    let (dir, s) = settings(app);
    let run = ensure(app);
    let index_bytes = dir.as_ref().and_then(|d| std::fs::metadata(d.join(INDEX)).ok()).map_or(0, |m| m.len());
    let excl = |p: &Path| -> Vec<String> { s.roots.iter().find(|r| r.path == p).map(|r| r.exclude.iter().map(|e| lossy(e)).collect()).unwrap_or_default() };
    match run {
        None => json!({
            "running": false, "busy": false, "paused": s.paused, "pauseOnBattery": s.pause_on_battery, "onBattery": rules::on_battery(),
            "batteryPaused": false, "entries": 0, "folders": 0, "files": 0, "memory": 0, "fileBytes": index_bytes, "note": null,
            "progress": { "entries": 0, "current": "" },
            "roots": s.roots.iter().map(|r| json!({ "path": lossy(&r.path), "entries": 0, "walked": false, "lastWalk": 0, "unreadable": 0, "exclude": excl(&r.path) })).collect::<Vec<_>>(),
            "excludeNames": s.exclude_names,
        }),
        Some(r) => {
            let st = r.svc.status();
            let battery = *r.on_battery.lock().unwrap_or_else(|e| e.into_inner());
            json!({
                "running": true, "busy": st.busy, "paused": s.paused, "pauseOnBattery": s.pause_on_battery, "onBattery": battery,
                "batteryPaused": !s.paused && effective_pause(&s, battery),
                "entries": st.stats.entries, "folders": st.stats.folders, "files": st.stats.files, "memory": st.stats.memory_bytes,
                "fileBytes": st.file_bytes.max(index_bytes), "note": st.note,
                "progress": { "entries": st.progress.entries, "current": lossy(&st.progress.current_root) },
                "roots": st.roots.iter().map(|x| json!({ "path": lossy(&x.path), "entries": x.entries, "walked": x.walked, "lastWalk": x.last_walk_ms, "unreadable": x.unreadable, "exclude": excl(&x.path) })).collect::<Vec<_>>(),
                "excludeNames": s.exclude_names,
            })
        }
    }
}

fn num(o: &Value, k: &str) -> Option<f64> {
    o.get(k).and_then(|v| v.as_f64()).filter(|x| x.is_finite() && *x >= 0.0)
}

fn query_of(o: &Value) -> Query {
    let kinds = match o.get("kinds") {
        Some(Value::Array(xs)) => xs.iter().filter_map(|x| x.as_str()).filter_map(Kind::parse).collect(),
        _ => Vec::new(),
    };
    let sort = match text_of(o, "sort").as_str() {
        "name" => SortKey::Name,
        "path" => SortKey::Path,
        "size" => SortKey::Size,
        "date" => SortKey::Modified,
        _ => SortKey::Relevance,
    };
    let mut text = text_of(o, "text");
    text.truncate(text.char_indices().nth(512).map_or(text.len(), |(i, _)| i));
    Query {
        text,
        path_contains: Vec::new(),
        exts: Vec::new(),
        kinds,
        size_min: num(o, "sizeMin").map(|x| x as u64),
        size_max: num(o, "sizeMax").map(|x| x as u64),
        mtime_min: num(o, "after").map(|x| x as i64),
        mtime_max: num(o, "before").map(|x| x as i64),
        sort,
        descending: o.get("desc").and_then(|v| v.as_bool()).unwrap_or(false),
        limit: rules::clamp_limit(o.get("limit").and_then(|v| v.as_f64())),
    }
}

/* ---------- the commands ---------- */

/// fileSearchStatus() → the folders with their counts, the index's size, the walk's progress, the pause (the service
/// started here when folders are chosen).
#[tauri::command]
pub async fn kt_fsearch_status(app: AppHandle) -> Result<Value, String> {
    blocking(move || Ok(status_value(&app))).await
}

/// fileSearch({ text, kinds?, sizeMin?, sizeMax?, after?, before?, sort?, desc?, limit? }) → { hits: [{ name, path,
/// dir, size, mtime, folder, link, kind }], total, micros } — or { cancelled: true } when a newer search began
/// meanwhile, { idle: true } when no folder is chosen.
#[tauri::command]
pub async fn kt_fsearch_query(app: AppHandle, o: Value) -> Result<Value, String> {
    blocking(move || {
        let Some(run) = ensure(&app) else { return Ok(json!({ "idle": true })) };
        let q = query_of(&o);
        match run.svc.search(&q) {
            Err(_) => Ok(json!({ "cancelled": true })),
            Ok(r) => Ok(json!({
                "total": r.total,
                "micros": r.micros,
                "hits": r.hits.iter().map(|h| json!({
                    "name": h.name, "path": lossy(&h.path), "dir": h.path.parent().map(lossy).unwrap_or_default(),
                    "size": h.size, "mtime": h.mtime, "folder": h.is_dir, "link": h.is_link, "kind": h.kind.name(),
                })).collect::<Vec<_>>(),
            })),
        }
    })
    .await
}

fn refusal(r: Refusal) -> Value {
    let (code, other) = r.code();
    json!({ "ok": false, "reason": code, "other": other.map(lossy) })
}

/// fileSearchAdd({ path }) → { ok } or { ok: false, reason: missing | same | inside | holds | appData, other }.
#[tauri::command]
pub async fn kt_fsearch_add(app: AppHandle, o: Value) -> Result<Value, String> {
    blocking(move || {
        let path = PathBuf::from(text_of(&o, "path"));
        let (dir, mut s) = settings(&app);
        if s.roots.len() >= rules::MAX_ROOTS {
            return Ok(json!({ "ok": false, "reason": "tooMany", "other": null }));
        }
        let chosen: Vec<PathBuf> = s.roots.iter().map(|r| r.path.clone()).collect();
        if let Err(r) = rules::check_new_root(&chosen, &path, path.is_dir(), dir.as_deref()) {
            return Ok(refusal(r));
        }
        let set = RootSet { path, exclude: Vec::new() };
        let spec = spec_of(&set, &s, dir.as_deref());
        s.roots.push(set);
        save_settings(s)?;
        // (Running: the root joins it; not yet: ensure starts it with every root, this one included.)
        let was = running();
        let run = ensure(&app);
        if let (Some(_), Some(r)) = (was, run) {
            if let Err(other) = r.svc.add_root(spec) {
                return Ok(refusal(Refusal::Inside(other)));
            }
        }
        Ok(json!({ "ok": true }))
    })
    .await
}

/// fileSearchRemove({ path }) → { ok }: the folder forgotten with what was found in it.
#[tauri::command]
pub async fn kt_fsearch_remove(app: AppHandle, o: Value) -> Result<Value, String> {
    blocking(move || {
        let path = PathBuf::from(text_of(&o, "path"));
        let (_, mut s) = settings(&app);
        let before = s.roots.len();
        s.roots.retain(|r| r.path != path);
        if s.roots.len() == before {
            return Ok(json!({ "ok": false }));
        }
        let empty = s.roots.is_empty();
        save_settings(s)?;
        if let Some(r) = running() {
            r.svc.remove_root(&path);
            r.svc.save_now();
        }
        if empty {
            stop(false);
        }
        Ok(json!({ "ok": true }))
    })
    .await
}

/// fileSearchExclude({ root, path, remove? }) → { ok }: a folder inside a chosen one left out (or taken back); that
/// chosen folder is then looked through again.
#[tauri::command]
pub async fn kt_fsearch_exclude(app: AppHandle, o: Value) -> Result<Value, String> {
    blocking(move || {
        let root = PathBuf::from(text_of(&o, "root"));
        let path = PathBuf::from(text_of(&o, "path"));
        let remove = o.get("remove").and_then(|v| v.as_bool()).unwrap_or(false);
        let (dir, mut s) = settings(&app);
        let Some(k) = s.roots.iter().position(|r| r.path == root) else { return Ok(json!({ "ok": false, "reason": "noRoot" })) };
        if remove {
            s.roots[k].exclude.retain(|e| *e != path);
        } else {
            if !rules::folder_under(&root, &path) {
                return Ok(json!({ "ok": false, "reason": "outside" }));
            }
            if s.roots[k].exclude.iter().any(|e| *e == path) {
                return Ok(json!({ "ok": true }));
            }
            if s.roots[k].exclude.len() >= rules::MAX_EXCLUDES {
                return Ok(json!({ "ok": false, "reason": "tooMany" }));
            }
            s.roots[k].exclude.push(path);
        }
        let spec = spec_of(&s.roots[k], &s, dir.as_deref());
        save_settings(s)?;
        if let Some(r) = running() {
            // (The service has no «change exclusions»: the root goes and comes back, and is walked again.)
            r.svc.remove_root(&root);
            let _ = r.svc.add_root(spec);
        }
        Ok(json!({ "ok": true }))
    })
    .await
}

/// fileSearchRebuild() → { ok }: every chosen folder looked through again (what is found meanwhile still answers).
#[tauri::command]
pub async fn kt_fsearch_rebuild(app: AppHandle) -> Result<Value, String> {
    blocking(move || {
        match ensure(&app) {
            Some(r) => {
                r.svc.rebuild();
                Ok(json!({ "ok": true }))
            }
            None => Ok(json!({ "ok": false })),
        }
    })
    .await
}

/// fileSearchForget() → { ok }: the index removed — the service stopped without saving, the file deleted, the chosen
/// folders forgotten (the search is off until a folder is chosen again).
#[tauri::command]
pub async fn kt_fsearch_forget(app: AppHandle) -> Result<Value, String> {
    blocking(move || {
        let (dir, mut s) = settings(&app);
        stop(true);
        s.roots.clear();
        save_settings(s)?;
        if let Some(d) = dir {
            let _ = std::fs::remove_file(d.join(INDEX));
            let _ = std::fs::remove_file(d.join(format!("{INDEX}.tmp")));
        }
        Ok(json!({ "ok": true }))
    })
    .await
}

/// fileSearchPause({ paused?, pauseOnBattery? }) → the status: the looking-through paused or resumed by the user, and
/// whether it pauses by itself on battery. Watching for changes goes on.
#[tauri::command]
pub async fn kt_fsearch_pause(app: AppHandle, o: Value) -> Result<Value, String> {
    blocking(move || {
        let (_, mut s) = settings(&app);
        if let Some(p) = o.get("paused").and_then(|v| v.as_bool()) {
            s.paused = p;
        }
        if let Some(p) = o.get("pauseOnBattery").and_then(|v| v.as_bool()) {
            s.pause_on_battery = p;
        }
        let s2 = s.clone();
        save_settings(s)?;
        if let Some(r) = running() {
            let battery = *r.on_battery.lock().unwrap_or_else(|e| e.into_inner());
            r.svc.set_paused(effective_pause(&s2, battery));
        }
        Ok(status_value(&app))
    })
    .await
}
