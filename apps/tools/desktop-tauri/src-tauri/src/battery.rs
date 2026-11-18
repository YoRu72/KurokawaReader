// SPDX-License-Identifier: GPL-3.0-or-later
// Device battery (Tools 0.21, pieces 1–2): the page's commands over kt-battery (apps/tools/core/kt-battery, derived from
// Wireless Device Battery Monitor — apps/tools/NOTICE.md). The loop (kt-battery runner.rs) enumerates once a minute and
// on device arrival, asks each device on its own thread with a deadline, and sends every change to the page as
// kt:battery. It starts on the page's first call — or, with «keep running in the background» on, at the app's start.
// Windows only for now: elsewhere the page is told «not on this system yet».
// Piece 2, the background: with that setting on, closing the window leaves the app in the tray (desktop.rs's one tray
// icon, which gains a short device list, «Check now» and «Open Device battery», and names the lowest device in its
// tooltip) and the loop goes on; «start with the system, hidden» writes this feature's own Run value (kt-battery
// win/autostart.rs) or XDG autostart file (macOS: not yet), launching the program with --hidden; low-battery and
// fully-charged notices follow kt-battery notice.rs (per device mark, re-armed at mark + 5 % or by charging, nothing
// from an old reading or an absent device) and are shown through the notification plugin.
// The bridge's methods (../../bridge.js): batteryList() → { available, now, devices, settings, system: { autostart:
// 'yes' | 'notYet', tray } }; batteryRefresh({ key? }) → true (one device, or all); batterySettings({ set? }) → the
// settings (set: a part of them, kept in <app data>/battery.json; turning the start with the system on or off writes
// or removes its entry first — an error leaves the settings as they were); onBattery(cb) — { now, devices } after each
// change.
// Copyright (C) 2026 Kurokawa contributors.
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
#[cfg(windows)]
use tauri::Emitter;

use kt_battery::autostart;
use kt_battery::model::{Charging, Level, Reading};
use kt_battery::notice::{self, Mark, Memo, Notice, Seen};
use kt_battery::runner::{self, DeviceState, Msg, Prefs, Status};
use kt_battery::summary;

struct Live {
    handle: runner::Handle,
    last: Arc<Mutex<Vec<Value>>>,
    #[cfg(windows)]
    _watch: Option<kt_battery::win::ArrivalWatch>,
}

static LIVE: OnceLock<Mutex<Option<Live>>> = OnceLock::new();
static SETTINGS: Mutex<Option<Value>> = Mutex::new(None);
/// The loop's last list as it is (the tray's menu is made again from it when the words or the settings change).
static STATES: Mutex<Vec<DeviceState>> = Mutex::new(Vec::new());
/// notice.rs's memory per device key (this run only: a restart may tell a still-low device once more).
static MEMO: Mutex<BTreeMap<String, Memo>> = Mutex::new(BTreeMap::new());
const FILE: &str = "battery.json";
/// The settings the page may change.
const KEYS: [&str; 11] = ["intervalMin", "low", "names", "hidden", "noQuery", "links", "background", "startup", "notifyLow", "notifyFull", "thresholds"];

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
    let flag = |k: &str, def: bool| o.and_then(|o| o.get(k)).and_then(Value::as_bool).unwrap_or(def);
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
    // (A device's own low mark: 0 is «no notice», else one of notice::CHOICES; anything else dropped — the default.)
    let mut thresholds = Map::new();
    if let Some(m) = o.and_then(|o| o.get("thresholds")).and_then(Value::as_object) {
        for (k, n) in m.iter().take(500) {
            let (Some(k), Some(n)) = (clean_key(&json!(k)), n.as_u64()) else { continue };
            if Mark::from_setting(n).is_some() {
                thresholds.insert(k, json!(n));
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
        "low": notice::snap(o.and_then(|o| o.get("low")).and_then(Value::as_u64)),
        "names": names,
        "hidden": clean_keys(o.and_then(|o| o.get("hidden"))),
        "noQuery": clean_keys(o.and_then(|o| o.get("noQuery"))),
        "links": links,
        "background": flag("background", false),
        "startup": flag("startup", false),
        "notifyLow": flag("notifyLow", true),
        "notifyFull": flag("notifyFull", false),
        "thresholds": thresholds,
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

/// The settings once read (None before: the background then counts as off).
fn cached() -> Option<Value> {
    SETTINGS.lock().unwrap_or_else(|e| e.into_inner()).clone()
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

fn flag(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}

/// «Keep running in the background» in force: chosen, and on a system with a reader (Windows for now).
fn background_on(v: &Value) -> bool {
    cfg!(windows) && flag(v, "background")
}

/// Whether the start with the system should be there: both switches on (a hidden start needs the background).
fn startup_wanted(v: &Value) -> bool {
    background_on(v) && flag(v, "startup")
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
        changed(&app2, list);
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
    let _ = (state_json, changed);
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

// ---- piece 2: the background, the tray, the notices ----

/// One of the page's words (desktop.rs's labels, sent with the desktop prefs), `en` until the page has sent them.
fn word(k: &str, en: &str) -> String {
    crate::desktop::label(k, en)
}

/// A number in the interface's digits (the page sends its ten, «batDigits»).
fn digits(n: u8) -> String {
    let d: Vec<char> = word("batDigits", "0123456789").chars().collect();
    n.to_string().chars().map(|c| c.to_digit(10).and_then(|i| d.get(i as usize).copied()).filter(|_| d.len() == 10).unwrap_or(c)).collect()
}

fn level_word(l: Level) -> String {
    match l {
        Level::Exact(p) => word("batPct", "{n}%").replace("{n}", &digits(p.get())),
        Level::Coarse(c) => {
            let en = match c.as_str() {
                "empty" => "Empty",
                "low" => "Low",
                "medium" => "Medium",
                "high" => "High",
                _ => "Full",
            };
            word(&format!("batCoarse_{}", c.as_str()), en)
        }
        Level::Unknown => word("batLevelUnknown", "Level unknown"),
    }
}

fn name_of(s: &Value, d: &DeviceState) -> String {
    s.get("names").and_then(|m| m.get(&d.device.key)).and_then(Value::as_str).map(str::to_string).filter(|n| !n.is_empty()).or_else(|| Some(d.device.name.clone()).filter(|n| !n.trim().is_empty())).unwrap_or_else(|| word("batUnnamed", "Wireless device"))
}

fn hidden_keys(s: &Value) -> Vec<String> {
    s.get("hidden").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

/// A device's mark: its own (0 = no notice), else the default «low»; none at all with the low notices off.
fn mark_of(s: &Value, key: &str) -> Mark {
    if !s.get("notifyLow").and_then(Value::as_bool).unwrap_or(true) {
        return Mark::Off;
    }
    s.get("thresholds").and_then(|m| m.get(key)).and_then(Value::as_u64).and_then(Mark::from_setting).unwrap_or_else(|| Mark::At(notice::snap(s.get("low").and_then(Value::as_u64))))
}

/// After each change of the loop's list: the notices due, then the tray's list.
fn changed(app: &AppHandle, list: Vec<DeviceState>) {
    let s = load(app);
    notices(app, &s, &list);
    *STATES.lock().unwrap_or_else(|e| e.into_inner()) = list;
    tray_push(app, &s);
}

fn notices(app: &AppHandle, s: &Value, list: &[DeviceState]) {
    let hidden = hidden_keys(s);
    let full_on = flag(s, "notifyFull");
    let max_age = s.get("intervalMin").and_then(Value::as_u64).unwrap_or(1).clamp(1, 60) * 60_000;
    let now = now_ms();
    let mut due: Vec<(String, String)> = Vec::new();
    {
        let mut memo = MEMO.lock().unwrap_or_else(|e| e.into_inner());
        for d in list.iter().filter(|d| !hidden.contains(&d.device.key)) {
            let m = memo.entry(d.device.key.clone()).or_default();
            let seen = Seen { reading: d.reading.as_ref(), live: d.status == Status::Ok, now, max_age_ms: max_age };
            match notice::step(m, mark_of(s, &d.device.key), full_on, seen) {
                Some(Notice::Low(l)) => due.push((word("batNoticeLow", "Low battery"), word("batNoticeLowBody", "{name}: {level}").replace("{name}", &name_of(s, d)).replace("{level}", &level_word(l)))),
                Some(Notice::Full) => due.push((word("batNoticeFull", "Fully charged"), word("batNoticeFullBody", "{name} is fully charged.").replace("{name}", &name_of(s, d)))),
                None => {}
            }
        }
    }
    for (title, body) in due {
        let app = app.clone();
        let _ = std::thread::Builder::new().name("kt-battery-notice".into()).spawn(move || {
            use tauri_plugin_notification::NotificationExt;
            let _ = app.notification().builder().title(&title).body(&body).show();
        });
    }
}

/// The tray's part (desktop.rs): with the background on, the devices lowest first (at most six; hidden and
/// not-queried ones left out) and the lowest in the tooltip; with it off, none (the icon then follows the downloads'
/// own setting alone).
fn tray_push(app: &AppHandle, s: &Value) {
    if !background_on(s) {
        crate::desktop::set_battery_tray(app, None);
        return;
    }
    let hidden = hidden_keys(s);
    let list = STATES.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let shown: Vec<&DeviceState> = list.iter().filter(|d| !hidden.contains(&d.device.key) && d.status != Status::NotQueried).collect();
    let current = |d: &&DeviceState| if d.status == Status::Ok { d.reading.map(|r| r.level) } else { None };
    let ordered = summary::lowest_first(shown, current, summary::MAX_LINES);
    let lines: Vec<String> = ordered
        .iter()
        .map(|d| {
            let what = match (d.status, d.reading) {
                (Status::Ok, Some(r)) if r.charging == Charging::Yes => format!("{} · {}", level_word(r.level), word("batCharging", "Charging")),
                (Status::Ok, Some(r)) => level_word(r.level),
                (st, _) => word(&format!("batSt_{}", st.as_str()), st.as_str()),
            };
            format!("{} — {}", name_of(s, d), what)
        })
        .collect();
    let tip = ordered
        .iter()
        .find(|d| matches!(current(*d), Some(Level::Exact(_)) | Some(Level::Coarse(_))))
        .map(|d| word("batTrayLowest", "Lowest: {name}, {level}").replace("{name}", &name_of(s, d)).replace("{level}", &level_word(d.reading.map(|r| r.level).unwrap_or(Level::Unknown))))
        .unwrap_or_default();
    crate::desktop::set_battery_tray(app, Some(crate::desktop::BatTray { lines, tip }));
}

/// The page's words changed (desktop.rs): the tray's list said again in them.
pub fn tray_again(app: &AppHandle) {
    if let Some(s) = cached() {
        if background_on(&s) {
            let a2 = app.clone();
            let _ = std::thread::Builder::new().name("kt-battery-tray".into()).spawn(move || tray_push(&a2, &s));
        }
    }
}

/// The tray's «Check now».
pub fn check_now(app: &AppHandle) {
    let a2 = app.clone();
    let _ = std::thread::Builder::new().name("kt-battery-check".into()).spawn(move || {
        if let Some((h, _)) = live(&a2) {
            h.send(Msg::RefreshAll);
        }
    });
}

/// The tray's «Open Device battery» (and a device's line): the window back, on the page.
pub fn open_page(app: &AppHandle) {
    crate::desktop::show_main(app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval("location.hash = '#/battery';");
    }
}

/// Whether closing the main window leaves the app in the tray: the background on and the tray icon there (a system
/// without a tray keeps the old way — the app could not be reached otherwise).
pub fn keep_in_tray() -> bool {
    cached().map_or(false, |s| background_on(&s)) && crate::desktop::tray_is_on()
}

/// The main window closed with the background on: hidden instead, the loop goes on.
pub fn on_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let ("main", tauri::WindowEvent::CloseRequested { api, .. }) = (window.label(), event) {
        if keep_in_tray() {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

/// The program that a start with the system should launch: an AppImage's own file on Linux (the running one is a
/// mount that goes away), else this executable.
fn exe_path() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        if let Some(a) = std::env::var_os("APPIMAGE").map(PathBuf::from).filter(|p| p.is_absolute() && p.is_file()) {
            return Some(a.to_string_lossy().into_owned());
        }
    }
    std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned())
}

/// The start with the system put in place or taken away. Windows: this feature's own Run value; Linux: its XDG
/// autostart file; a Mac: not yet (asking for it is refused, taking it away is nothing to do).
fn autostart_apply(on: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let exe = exe_path().ok_or("this program's path is not known")?;
        kt_battery::win::autostart::apply(on, &exe)
    }
    #[cfg(target_os = "linux")]
    {
        let cfg = std::env::var("XDG_CONFIG_HOME").ok();
        let home = std::env::var("HOME").ok();
        let p = autostart::desktop_path(cfg.as_deref(), home.as_deref()).ok_or("no home folder")?;
        if !on {
            return match std::fs::remove_file(&p) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                _ => Ok(()),
            };
        }
        let exe = exe_path().ok_or("this program's path is not known")?;
        let text = autostart::desktop_entry(&exe, "Kurokawa Tools", &word("batAutostartComment", "Device battery in the background")).ok_or("this program's path cannot be written to an autostart file")?;
        if std::fs::read_to_string(&p).map_or(false, |t| t == text) {
            return Ok(());
        }
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        let tmp = p.with_extension("desktop.tmp");
        std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (exe_path, autostart::HIDDEN_FLAG);
        if on {
            Err("not on this system yet".to_string())
        } else {
            Ok(())
        }
    }
}

fn autostart_support() -> &'static str {
    if cfg!(any(windows, target_os = "linux")) {
        "yes"
    } else {
        "notYet"
    }
}

/// At the app's start (main.rs, after the window is made): with the background on, the loop started and the tray's
/// list made; the start with the system made to match the settings (the program may have moved); a --hidden launch
/// (the system's start) left in the tray, once the icon is there.
pub fn init(app: &AppHandle) {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let hidden = autostart::wants_hidden(&args);
    let a2 = app.clone();
    let _ = std::thread::Builder::new().name("kt-battery-init".into()).spawn(move || {
        let s = load(&a2);
        let want = startup_wanted(&s);
        // (Only when it should be there, or when this feature's own entry is left over: nothing written otherwise.)
        if want || flag(&s, "startup") {
            let _ = autostart_apply(want);
        }
        if !background_on(&s) {
            return;
        }
        let _ = live(&a2);
        tray_push(&a2, &s);
        if hidden && want {
            for _ in 0..40 {
                if crate::desktop::tray_is_on() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            if crate::desktop::tray_is_on() {
                if let Some(w) = a2.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
        }
    });
}

// ---- commands ----

fn system_json() -> Value {
    json!({ "autostart": autostart_support(), "tray": crate::desktop::tray_possible().0 })
}

#[tauri::command]
pub async fn kt_battery_list(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = load(&app);
        match live(&app) {
            Some((_, last)) => {
                let devices = last.lock().map(|g| g.clone()).unwrap_or_default();
                json!({ "available": true, "now": now_ms(), "devices": devices, "settings": settings, "system": system_json() })
            }
            None => json!({ "available": false, "reason": "platform", "now": now_ms(), "devices": [], "settings": settings, "system": system_json() }),
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
            if KEYS.contains(&k.as_str()) {
                merged.insert(k.clone(), v.clone());
            }
        }
        let next = clean(&Value::Object(merged));
        // (The start with the system first: when it cannot be written, nothing is kept and the page is told why.)
        if startup_wanted(&next) != startup_wanted(&cur) || (flag(&next, "startup") != flag(&cur, "startup")) {
            autostart_apply(startup_wanted(&next))?;
        }
        save(&app, &next)?;
        *SETTINGS.lock().unwrap_or_else(|e| e.into_inner()) = Some(next.clone());
        if background_on(&next) && !background_on(&cur) {
            // (Turned on: the loop running from now on, whether the page stays open or not.)
            let _ = live(&app);
        }
        // (The loop, when it runs, told — not started for this alone.)
        let mut running: Option<runner::Handle> = None;
        if let Some(c) = LIVE.get() {
            let g = c.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(l) = g.as_ref() {
                running = Some(l.handle.clone());
            }
        }
        if let Some(h) = running {
            h.send(Msg::Prefs(prefs_of(&next)));
        }
        tray_push(&app, &next);
        Ok(next)
    })
    .await
    .map_err(|e| e.to_string())?
}
