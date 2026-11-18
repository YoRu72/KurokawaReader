// SPDX-License-Identifier: GPL-3.0-or-later
// Device battery (Tools 0.21, piece 1): the page's commands over kt-battery (apps/tools/core/kt-battery, derived from
// Wireless Device Battery Monitor — apps/tools/NOTICE.md). Started on the page's first call, never at the app's start:
// the loop (kt-battery runner.rs) then enumerates once a minute and on device arrival, asks each device on its own
// thread with a deadline, and sends every change to the page as kt:battery. Windows only for now: elsewhere the page is
// told «not on this system yet».
// The bridge's methods (../../bridge.js): batteryList() → { available, now, devices, settings }; batteryRefresh({ key? })
// → true (one device, or all); batterySettings({ set? }) → the settings (set: a part of them, kept in
// <app data>/battery.json); onBattery(cb) — { now, devices } after each change.
// Copyright (C) 2026 Kurokawa contributors.
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
#[cfg(windows)]
use tauri::Emitter;

use kt_battery::model::{Level, Reading};
use kt_battery::runner::{self, DeviceState, Msg, Prefs};

struct Live {
    handle: runner::Handle,
    last: Arc<Mutex<Vec<Value>>>,
    #[cfg(windows)]
    _watch: Option<kt_battery::win::ArrivalWatch>,
}

static LIVE: OnceLock<Mutex<Option<Live>>> = OnceLock::new();
static SETTINGS: Mutex<Option<Value>> = Mutex::new(None);
const FILE: &str = "battery.json";

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn level_json(l: Level) -> Value {
    match l {
        Level::Exact(p) => json!({ "kind": "exact", "value": p.get() }),
        Level::Coarse(c) => json!({ "kind": "coarse", "value": c.as_str(), "bars": c.bars() }),
        Level::Unknown => json!({ "kind": "unknown" }),
    }
}

fn reading_json(r: &Reading) -> Value {
    json!({ "level": level_json(r.level), "charging": r.charging.as_str(), "asleep": r.asleep, "takenAt": r.taken_at })
}

fn state_json(s: &DeviceState) -> Value {
    let d = &s.device;
    json!({
        "key": d.key, "name": d.name, "kind": d.kind.as_str(), "brand": d.brand, "connection": d.connection.as_str(),
        "source": d.source.as_str(), "vid": d.vid, "pid": d.pid, "merged": d.merged,
        "status": s.status.as_str(), "reading": s.reading.as_ref().map(reading_json), "lastGood": s.last_good.as_ref().map(reading_json),
        "checkedAt": s.checked_at,
    })
}

// ---- settings ----

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(FILE))
}

fn clean_key(v: &Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|s| !s.is_empty() && s.len() <= 200 && !s.chars().any(char::is_control)).map(str::to_string)
}

fn clean_keys(v: Option<&Value>) -> Value {
    let mut out: Vec<String> = Vec::new();
    for k in v.and_then(Value::as_array).map(|a| a.as_slice()).unwrap_or(&[]).iter().take(500).filter_map(clean_key) {
        if !out.contains(&k) {
            out.push(k);
        }
    }
    json!(out)
}

/// The settings as kept: unknown fields dropped, every value checked and bounded.
fn clean(v: &Value) -> Value {
    let o = v.as_object();
    let num = |k: &str, lo: u64, hi: u64, def: u64| o.and_then(|o| o.get(k)).and_then(Value::as_u64).map_or(def, |n| n.clamp(lo, hi));
    let mut names = Map::new();
    if let Some(m) = o.and_then(|o| o.get("names")).and_then(Value::as_object) {
        for (k, n) in m.iter().take(500) {
            let (Some(k), Some(n)) = (clean_key(&json!(k)), n.as_str()) else { continue };
            let n: String = n.trim().chars().filter(|c| !c.is_control()).take(64).collect();
            if !n.is_empty() {
                names.insert(k, json!(n));
            }
        }
    }
    let mut links: Vec<Value> = Vec::new();
    for l in o.and_then(|o| o.get("links")).and_then(Value::as_array).map(|a| a.as_slice()).unwrap_or(&[]).iter().take(100) {
        if let Some([a, b]) = l.as_array().map(|x| x.as_slice()) {
            if let (Some(a), Some(b)) = (clean_key(a), clean_key(b)) {
                if a != b {
                    links.push(json!([a, b]));
                }
            }
        }
    }
    json!({
        "intervalMin": num("intervalMin", 1, 60, 1),
        "low": num("low", 5, 50, 15),
        "names": names,
        "hidden": clean_keys(o.and_then(|o| o.get("hidden"))),
        "noQuery": clean_keys(o.and_then(|o| o.get("noQuery"))),
        "links": links,
    })
}

fn load(app: &AppHandle) -> Value {
    let mut g = SETTINGS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(v) = g.as_ref() {
        return v.clone();
    }
    let v = file(app).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(Value::Null);
    let v = clean(&v);
    *g = Some(v.clone());
    v
}

fn save(app: &AppHandle, v: &Value) -> Result<(), String> {
    let p = file(app).ok_or("no app data folder")?;
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    // (A temp file, then a rename: a crash never leaves half a file.)
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

fn prefs_of(v: &Value) -> Prefs {
    let keys = |k: &str| -> Vec<String> { v.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default() };
    let links: Vec<(String, String)> = v.get("links").and_then(Value::as_array).map(|a| a.iter().filter_map(|l| Some((l.get(0)?.as_str()?.to_string(), l.get(1)?.as_str()?.to_string()))).collect()).unwrap_or_default();
    Prefs { interval_ms: v.get("intervalMin").and_then(Value::as_u64).unwrap_or(1) * 60_000, deadline_ms: 0, no_query: keys("noQuery"), links }
}

// ---- the loop ----

/// The loop, started once (Windows); None where there is no reader yet.
fn live(app: &AppHandle) -> Option<(runner::Handle, Arc<Mutex<Vec<Value>>>)> {
    let cell = LIVE.get_or_init(|| Mutex::new(None));
    let mut g = cell.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(l) = g.as_ref() {
        return Some((l.handle.clone(), l.last.clone()));
    }
    let l = start(app)?;
    let out = (l.handle.clone(), l.last.clone());
    *g = Some(l);
    Some(out)
}

#[cfg(windows)]
fn start(app: &AppHandle) -> Option<Live> {
    let last: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let (l2, app2) = (last.clone(), app.clone());
    let publish = Box::new(move |list: Vec<DeviceState>| {
        let v: Vec<Value> = list.iter().map(state_json).collect();
        if let Ok(mut g) = l2.lock() {
            *g = v.clone();
        }
        let _ = app2.emit("kt:battery", json!({ "now": now_ms(), "devices": v }));
    });
    let platform = Arc::new(kt_battery::win::WinPlatform::new());
    let (handle, _join) = runner::spawn(platform, prefs_of(&load(app)), Arc::new(now_ms), publish).ok()?;
    let h2 = handle.clone();
    let watch = kt_battery::win::watch_arrivals(Box::new(move || {
        h2.send(Msg::Arrival);
    }));
    Some(Live { handle, last, _watch: watch })
}

#[cfg(not(windows))]
fn start(_app: &AppHandle) -> Option<Live> {
    let _ = state_json;
    None
}

/// Quitting: the loop told to stop (its threads end with the program).
pub fn at_exit() {
    if let Some(cell) = LIVE.get() {
        if let Ok(g) = cell.lock() {
            if let Some(l) = g.as_ref() {
                l.handle.send(Msg::Stop);
            }
        }
    }
}

// ---- commands ----

#[tauri::command]
pub async fn kt_battery_list(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = load(&app);
        match live(&app) {
            Some((_, last)) => {
                let devices = last.lock().map(|g| g.clone()).unwrap_or_default();
                json!({ "available": true, "now": now_ms(), "devices": devices, "settings": settings })
            }
            None => json!({ "available": false, "reason": "platform", "now": now_ms(), "devices": [], "settings": settings }),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn kt_battery_refresh(app: AppHandle, o: Value) -> Result<Value, String> {
    let key = o.get("key").and_then(clean_key);
    tauri::async_runtime::spawn_blocking(move || {
        let Some((h, _)) = live(&app) else { return json!(false) };
        let msg = match key {
            Some(k) => Msg::Refresh(k),
            None => Msg::RefreshAll,
        };
        let sent = h.send(msg);
        json!(sent)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn kt_battery_settings(app: AppHandle, o: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let cur = load(&app);
        let Some(set) = o.get("set").and_then(Value::as_object) else { return Ok(cur) };
        let mut merged = cur.as_object().cloned().unwrap_or_default();
        for (k, v) in set {
            if ["intervalMin", "low", "names", "hidden", "noQuery", "links"].contains(&k.as_str()) {
                merged.insert(k.clone(), v.clone());
            }
        }
        let next = clean(&Value::Object(merged));
        save(&app, &next)?;
        *SETTINGS.lock().unwrap_or_else(|e| e.into_inner()) = Some(next.clone());
        if let Some((h, _)) = live(&app) {
            h.send(Msg::Prefs(prefs_of(&next)));
        }
        Ok(next)
    })
    .await
    .map_err(|e| e.to_string())?
}
