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
// Piece 3, connecting Bluetooth devices (kt-battery connect.rs over win/btconn.rs): btList() → { available, reason?,
// radio: 'on' | 'off' | 'missing', stale, now, scanUntil, devices, found, busy } (each device { addr, name, kind,
// picture, brand, le, paired, connected, battery, can: 'both' | 'disconnectOnly' | 'settings' | 'pair' }; busy
// [{ addr, op, until }]); btScan({ stop?, seconds? }) → the same (a scan of 5–60 s, 20 by default, in rounds; stop ends
// it); btAct({ op: 'connect' | 'disconnect' | 'pair' | 'cancel', addr }) → { result, code } once the action ends (its
// limit, the device's answer, or a cancel — 'cancel' answers { result: 'cancelled' | 'none' } at once); btOpenSettings()
// opens Windows' Bluetooth settings (ms-settings:bluetooth); onBt(cb) — the same object as btList's after each change
// (kt:bt). Pairing is Windows' own window (no PIN of ours). With the background on, the tray gains Connect /
// Disconnect lines for the paired devices that allow it. Elsewhere than Windows: available false.
// Piece 4, game controllers (kt-battery pads/*.rs): a device may carry { driver, family, proven: 'tested' |
// 'untested', way: 'passive' | 'query', picture } and a reading { level: { kind: 'steps', value, max } …, note:
// '' | 'needsQuery' | 'queryOff' | 'noPad' }; batteryList() also gives pads: [{ family, brand, proven, ask, listen,
// models, on }] (one row per reader family), and the setting padQueries — the families whose status request the user allows (off by
// default; only families whose reader sends a request are kept).
// Piece 5, mice and keyboards (kt-battery mice/*.rs): batteryList() also gives mice: [{ family, brand, proven, ask,
// listen, on }] (one row per family, every family), and two settings: mkAsk — the families whose status request the
// user allows (off by default) — and mkMute — the families read by listening that the user turned off (on by default).
// A device read by one of them carries its { driver, family, proven, way } as a controller's does; a reading's note
// may be 'unlinked' (a receiver with no device linked to it).
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
use kt_battery::mice;
use kt_battery::pads::{self, Way};
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
const KEYS: [&str; 14] = ["intervalMin", "low", "names", "hidden", "noQuery", "links", "background", "startup", "notifyLow", "notifyFull", "thresholds", "padQueries", "mkAsk", "mkMute"];

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn level_json(l: Level) -> Value {
    match l {
        Level::Exact(p) => json!({ "kind": "exact", "value": p.get() }),
        Level::Coarse(c) => json!({ "kind": "coarse", "value": c.as_str(), "bars": c.bars() }),
        Level::Steps(st) => json!({ "kind": "steps", "value": st.n(), "max": st.max() }),
        Level::Unknown => json!({ "kind": "unknown" }),
    }
}

fn reading_json(r: &Reading) -> Value {
    // (Piece 6: a device of several cells — earbuds' left, right and case — each as it reports it.)
    let parts: Vec<Value> = r.parts.iter().flatten().map(|p| json!({ "part": p.name.as_str(), "level": level_json(p.level), "charging": p.charging.as_str(), "inUse": p.in_use })).collect();
    json!({ "level": level_json(r.level), "charging": r.charging.as_str(), "asleep": r.asleep, "takenAt": r.taken_at, "note": r.note.as_str(), "parts": parts })
}

fn way_str(w: Way) -> &'static str {
    match w {
        Way::Passive => "passive",
        Way::Query => "query",
    }
}

/// The controller readers, one row per family: its brand as text, the least proven of its readers, whether one of them
/// listens and whether one sends a request (with the products it sends it to), and whether that is allowed now.
fn pads_json(settings: &Value) -> Value {
    let on = settings.get("padQueries").and_then(Value::as_array).cloned().unwrap_or_default();
    let rows: Vec<Value> = pads::Family::ALL
        .iter()
        .map(|f| {
            let ds: Vec<&pads::Driver> = pads::DRIVERS.iter().filter(|d| d.family == *f).collect();
            let ask = ds.iter().any(|d| d.way == Way::Query);
            let listen = ds.iter().any(|d| d.way == Way::Passive);
            let tested = !ds.is_empty() && ds.iter().all(|d| d.proven == pads::Proven::Tested);
            let mut models: Vec<&str> = Vec::new();
            for m in pads::query_models(*f) {
                if !models.contains(&m.name) {
                    models.push(m.name);
                }
            }
            json!({ "family": f.as_str(), "brand": f.brand(), "proven": if tested { "tested" } else { "untested" }, "ask": ask, "listen": listen, "models": models, "on": ask && on.iter().any(|x| x.as_str() == Some(f.as_str())) })
        })
        .collect();
    json!(rows)
}

/// The mice' and keyboards' families (and piece 6's headsets', earbuds' and the rest, by `group`), one row each: brand as text, how far proven, whether a reader of it listens and
/// whether one sends a request, and whether its switch is on (a family that sends: in mkAsk; one that only listens: not
/// in mkMute).
fn mice_json(settings: &Value) -> Value {
    let list = |k: &str| settings.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
    let (ask_on, mute) = (list("mkAsk"), list("mkMute"));
    let has = |l: &[Value], f: &str| l.iter().any(|x| x.as_str() == Some(f));
    let rows: Vec<Value> = mice::Family::ALL
        .iter()
        .map(|f| {
            let ds: Vec<&mice::Driver> = mice::DRIVERS.iter().filter(|d| d.family == *f).collect();
            let ask = ds.iter().any(|d| d.way == Way::Query);
            let listen = ds.iter().any(|d| d.way == Way::Passive);
            let tested = !ds.is_empty() && ds.iter().all(|d| d.proven == pads::Proven::Tested);
            let on = if ask { has(&ask_on, f.as_str()) } else { !has(&mute, f.as_str()) };
            json!({ "family": f.as_str(), "brand": f.brand(), "group": f.group().as_str(), "connects": f.connects(), "proven": if tested { "tested" } else { "untested" }, "ask": ask, "listen": listen, "on": on })
        })
        .collect();
    json!(rows)
}

/// A device's reader: (family, proven, way) of a controller's or a mouse's / keyboard's reader.
fn reader_of(driver: &str) -> (&'static str, &'static str, &'static str) {
    if let Some(x) = pads::driver(driver) {
        return (x.family.as_str(), x.proven.as_str(), way_str(x.way));
    }
    if let Some(x) = mice::driver(driver) {
        return (x.family.as_str(), x.proven.as_str(), way_str(x.way));
    }
    ("", "", "")
}

fn state_json(s: &DeviceState) -> Value {
    let d = &s.device;
    json!({
        "key": d.key, "name": d.name, "kind": d.kind.as_str(), "brand": d.brand, "connection": d.connection.as_str(),
        "source": d.source.as_str(), "vid": d.vid, "pid": d.pid, "merged": d.merged,
        "status": s.status.as_str(), "reading": s.reading.as_ref().map(reading_json), "lastGood": s.last_good.as_ref().map(reading_json),
        "checkedAt": s.checked_at, "picture": d.picture,
        "driver": d.driver, "family": reader_of(d.driver).0, "proven": reader_of(d.driver).1, "way": reader_of(d.driver).2,
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
    // (Only families whose reader sends a request can be switched; each once.)
    let mut pad_queries: Vec<Value> = Vec::new();
    let allowed: Vec<&str> = pads::query_families().iter().map(|f| f.as_str()).collect();
    for f in o.and_then(|o| o.get("padQueries")).and_then(Value::as_array).map(|a| a.as_slice()).unwrap_or(&[]).iter().take(20).filter_map(Value::as_str) {
        if allowed.contains(&f) && !pad_queries.iter().any(|x| x.as_str() == Some(f)) {
            pad_queries.push(json!(f));
        }
    }
    // (Piece 5: mkAsk only families whose reader sends, mkMute only families read by listening; each once.)
    let pick = |k: &str, allowed: &[&str]| -> Vec<Value> {
        let mut out: Vec<Value> = Vec::new();
        for f in o.and_then(|o| o.get(k)).and_then(Value::as_array).map(|a| a.as_slice()).unwrap_or(&[]).iter().take(100).filter_map(Value::as_str) {
            if allowed.contains(&f) && !out.iter().any(|x| x.as_str() == Some(f)) {
                out.push(json!(f));
            }
        }
        out
    };
    let mk_ask_ok: Vec<&str> = mice::query_families().iter().map(|f| f.as_str()).collect();
    let mk_mute_ok: Vec<&str> = mice::Family::ALL.iter().filter(|f| !mk_ask_ok.contains(&f.as_str())).map(|f| f.as_str()).collect();
    let (mk_ask, mk_mute) = (pick("mkAsk", &mk_ask_ok), pick("mkMute", &mk_mute_ok));
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
        "padQueries": pad_queries,
        "mkAsk": mk_ask,
        "mkMute": mk_mute,
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
    Prefs { interval_ms: v.get("intervalMin").and_then(Value::as_u64).unwrap_or(1) * 60_000, deadline_ms: 0, no_query: keys("noQuery"), links, pad_queries: keys("padQueries"), mk_ask: keys("mkAsk"), mk_mute: keys("mkMute") }
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
        Level::Steps(st) => word("batSteps", "{n} of {max}").replace("{n}", &digits(st.n())).replace("{max}", &digits(st.max())),
        Level::Unknown => word("batLevelUnknown", "Level unknown"),
    }
}

fn name_of(s: &Value, d: &DeviceState) -> String {
    s.get("names").and_then(|m| m.get(&d.device.key)).and_then(Value::as_str).map(str::to_string).filter(|n| !n.is_empty()).or_else(|| Some(d.device.name.clone()).filter(|n| !n.trim().is_empty())).or_else(|| xbox_name(&d.device.key)).unwrap_or_else(|| word("batUnnamed", "Wireless device"))
}

/// An XInput slot's name in the interface's words (the key «xinput:<user>:pad|headset»; the page names it the same way).
fn xbox_name(key: &str) -> Option<String> {
    let mut it = key.strip_prefix("xinput:")?.split(':');
    let user: u8 = it.next()?.parse().ok()?;
    match it.next()? {
        "headset" => Some(word("batXboxHeadset", "Xbox headset")),
        _ => Some(word("batXboxPad", "Xbox controller {n}").replace("{n}", &digits(user.saturating_add(1)))),
    }
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
    if background_on(&s) {
        bt_tray_tick(app);
    }
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
        .find(|d| matches!(current(*d), Some(Level::Exact(_)) | Some(Level::Coarse(_)) | Some(Level::Steps(_))))
        .map(|d| word("batTrayLowest", "Lowest: {name}, {level}").replace("{name}", &name_of(s, d)).replace("{level}", &level_word(d.reading.map(|r| r.level).unwrap_or(Level::Unknown))))
        .unwrap_or_default();
    let bt = bt_tray_lines();
    crate::desktop::set_battery_tray(app, Some(crate::desktop::BatTray { lines, tip, bt }));
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
                json!({ "available": true, "now": now_ms(), "devices": devices, "pads": pads_json(&settings), "mice": mice_json(&settings), "settings": settings, "system": system_json() })
            }
            None => json!({ "available": false, "reason": "platform", "now": now_ms(), "devices": [], "pads": pads_json(&settings), "mice": mice_json(&settings), "settings": settings, "system": system_json() }),
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

// ---- piece 3: connecting Bluetooth devices ----

use kt_battery::connect::{self, Can, ConnDev, End, Op, Snapshot};

fn conn_dev_json(d: &ConnDev) -> Value {
    json!({
        "addr": connect::addr_text(d.addr), "name": d.name, "kind": d.kind.as_str(), "picture": d.picture, "brand": d.brand,
        "le": d.le, "paired": d.paired, "connected": d.connected, "battery": d.battery, "can": d.can.as_str(),
    })
}

fn snap_json(s: &Snapshot) -> Value {
    let busy: Vec<Value> = s.busy.iter().map(|(a, b)| json!({ "addr": connect::addr_text(*a), "op": b.op.as_str(), "until": b.until })).collect();
    json!({
        "available": true, "radio": s.radio.as_str(), "stale": s.stale, "now": s.now, "scanUntil": s.scan_until,
        "devices": s.devices.iter().map(conn_dev_json).collect::<Vec<_>>(), "found": s.found.iter().map(conn_dev_json).collect::<Vec<_>>(), "busy": busy,
    })
}

/// The battery loop's levels by container, for the connected Bluetooth devices (its keys are «bt:{container}»).
fn bt_levels() -> Vec<(String, u8)> {
    STATES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|d| d.status == Status::Ok)
        .filter_map(|d| match (d.device.key.strip_prefix("bt:"), d.reading.map(|r| r.level)) {
            (Some(c), Some(Level::Exact(p))) => Some((c.to_string(), p.get())),
            _ => None,
        })
        .collect()
}

/// The tray's Bluetooth lines: what each does (the menu's ids are their places in this list).
static BT_TRAY: Mutex<Vec<(u64, Op, String)>> = Mutex::new(Vec::new());
/// The last connect snapshot (the tray's lines are made from it).
static BT_LAST: Mutex<Option<Snapshot>> = Mutex::new(None);
/// When the tray's paired list was last read again (ms), with the background on.
static BT_READ_AT: Mutex<u64> = Mutex::new(0);

#[cfg(windows)]
type BtConn = connect::Conn<kt_battery::win::btconn::WinBt>;

#[cfg(windows)]
static BT: OnceLock<(BtConn, Arc<kt_battery::win::btconn::WinBt>)> = OnceLock::new();

#[cfg(windows)]
fn bt(app: &AppHandle) -> Option<&'static BtConn> {
    let (c, _) = BT.get_or_init(|| {
        let p = Arc::new(kt_battery::win::btconn::WinBt::new());
        let a2 = app.clone();
        let publish = Arc::new(move |s: Snapshot| {
            let _ = a2.emit("kt:bt", snap_json(&s));
            *BT_LAST.lock().unwrap_or_else(|e| e.into_inner()) = Some(s);
            if let Some(v) = cached() {
                tray_push(&a2, &v);
            }
        });
        (connect::Conn::new(p.clone(), connect::Limits::default(), Arc::new(now_ms), publish), p)
    });
    Some(c)
}

#[cfg(windows)]
fn bt_parent(app: &AppHandle) {
    if let (Some((_, p)), Some(w)) = (BT.get(), app.get_webview_window("main")) {
        if let Ok(h) = w.hwnd() {
            p.set_parent(h.0 as isize);
        }
    }
}

/// The tray's Connect / Disconnect lines (at most four): paired devices Tools can act on.
fn bt_tray_lines() -> Vec<String> {
    let last = BT_LAST.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mut acts: Vec<(u64, Op, String)> = Vec::new();
    if let Some(s) = last.filter(|s| s.radio == connect::Radio::On) {
        for d in s.devices.iter() {
            let op = match (d.can, d.connected) {
                (Can::Both | Can::DisconnectOnly, true) => Op::Disconnect,
                (Can::Both, false) => Op::Connect,
                _ => continue,
            };
            let name = if d.name.trim().is_empty() { word("batUnnamed", "Wireless device") } else { d.name.clone() };
            acts.push((d.addr, op, name));
            if acts.len() == 4 {
                break;
            }
        }
    }
    let lines = acts
        .iter()
        .map(|(_, op, name)| match op {
            Op::Disconnect => word("btcTrayDisconnect", "Disconnect {name}").replace("{name}", name),
            _ => word("btcTrayConnect", "Connect {name}").replace("{name}", name),
        })
        .collect();
    *BT_TRAY.lock().unwrap_or_else(|e| e.into_inner()) = acts;
    lines
}

/// With the background on, the tray's paired list read again now and then (at most once a minute, on its own thread
/// with the list's limit) — never while nothing asks for the tray.
fn bt_tray_tick(app: &AppHandle) {
    #[cfg(windows)]
    {
        let now = now_ms();
        {
            let mut at = BT_READ_AT.lock().unwrap_or_else(|e| e.into_inner());
            if now.saturating_sub(*at) < 60_000 {
                return;
            }
            *at = now;
        }
        let a2 = app.clone();
        let _ = std::thread::Builder::new().name("kt-bt-tray".into()).spawn(move || {
            if let Some(c) = bt(&a2) {
                c.set_levels(bt_levels());
                let _ = c.refresh();
            }
        });
    }
    #[cfg(not(windows))]
    {
        let _ = (app, &BT_READ_AT);
    }
}

/// A tray line chosen: its action, on its own thread; a failure told as a notice.
pub fn tray_bt(app: &AppHandle, i: usize) {
    let Some((addr, op, name)) = BT_TRAY.lock().unwrap_or_else(|e| e.into_inner()).get(i).cloned() else { return };
    #[cfg(windows)]
    {
        let a2 = app.clone();
        let _ = std::thread::Builder::new().name("kt-bt-tray-act".into()).spawn(move || {
            let Some(c) = bt(&a2) else { return };
            let end = c.act(addr, op);
            if end != End::Done && end != End::Cancelled {
                use tauri_plugin_notification::NotificationExt;
                let body = word(&format!("btcEnd_{}", end.as_str()), end.as_str()).replace("{code}", &end.code().to_string());
                let _ = a2.notification().builder().title(&word("btcTrayFailed", "Could not do it for {name}").replace("{name}", &name)).body(&body).show();
            }
        });
    }
    #[cfg(not(windows))]
    {
        let _ = (app, addr, op, name);
    }
}

fn bt_unavailable() -> Value {
    json!({ "available": false, "reason": "platform", "radio": "missing", "stale": false, "now": now_ms(), "scanUntil": null, "devices": [], "found": [], "busy": [] })
}

fn bt_addr(o: &Value) -> Option<u64> {
    o.get("addr").and_then(Value::as_str).and_then(connect::parse_addr)
}

#[tauri::command]
pub async fn kt_bt_list(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            let Some(c) = bt(&app) else { return bt_unavailable() };
            c.set_levels(bt_levels());
            snap_json(&c.refresh())
        }
        #[cfg(not(windows))]
        {
            let _ = (&app, snap_json as fn(&Snapshot) -> Value, bt_levels as fn() -> Vec<(String, u8)>);
            bt_unavailable()
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn kt_bt_scan(app: AppHandle, o: Value) -> Result<Value, String> {
    let stop = o.get("stop").and_then(Value::as_bool).unwrap_or(false);
    let secs = o.get("seconds").and_then(Value::as_u64).unwrap_or(20);
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            let Some(c) = bt(&app) else { return bt_unavailable() };
            snap_json(&if stop { c.scan_stop() } else { c.scan_start(secs.saturating_mul(1_000)) })
        }
        #[cfg(not(windows))]
        {
            let _ = (&app, stop, secs);
            bt_unavailable()
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn kt_bt_act(app: AppHandle, o: Value) -> Result<Value, String> {
    let addr = bt_addr(&o).ok_or("no device address")?;
    let what = o.get("op").and_then(Value::as_str).unwrap_or("").to_string();
    let op = Op::parse(&what);
    if op.is_none() && what != "cancel" {
        return Err("unknown action".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            let Some(c) = bt(&app) else { return json!({ "result": "noRadio", "code": 0 }) };
            let Some(op) = op else {
                return json!({ "result": if c.cancel(addr) { "cancelled" } else { "none" }, "code": 0 });
            };
            if op == Op::Pair {
                bt_parent(&app);
            }
            let end = c.act(addr, op);
            json!({ "result": end.as_str(), "code": end.code() })
        }
        #[cfg(not(windows))]
        {
            let _ = (&app, addr, op, End::Done);
            json!({ "result": "noRadio", "code": 0 })
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn kt_bt_settings(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_url("ms-settings:bluetooth", None::<&str>).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("not on this system yet".into())
    }
}
