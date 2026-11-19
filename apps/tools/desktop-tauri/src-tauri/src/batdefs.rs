// SPDX-License-Identifier: GPL-3.0-or-later
// Device battery W3 (Tools 0.21): the user's own device definitions and «Teach me this device» — thin commands over
// kt-battery defs.rs (the format, its strict parser, the «defined» reader) and teach.rs (what may be listened to, the
// in-memory capture, the proposals). Nothing here sends anything to a device: a definition has no field for bytes to
// send, the reader made from it and the assistant's listening open the collection to listen only, and kt-battery's
// allow table is untouched. No network: definitions come from a file the user picks or from the assistant, and go out
// only as a file he saves.
// Kept in <app data>/battery-defs.json ({ version: 1, list: [{ id, on, mineFirst, text }] }, at most 50; written to a
// temp file, then renamed): each definition as its canonical text, read and checked again on every load (one that no
// longer passes is dropped). The loop gets the definitions that are on through runner::Prefs::defs.
// The bridge's methods (../../bridge.js): batteryDefs() → { list, max, teach } (an entry: { id, on, mineFirst, name,
// kind, note, vid, pid, usagePage, usage, interface, productName, builtin, level: { report, byte, mask, shift, how:
// 'scale' | 'steps' | 'table' }, charging }); batteryDefImport({ text, mineFirst? }) → { ok: true, id, list } or { ok:
// false, error: { code, field } } (code 'builtin' with field the family: the page asks «use mine instead?» and sends
// mineFirst: true); batteryDefExport({ id }) → { name, text }; batteryDefRemove({ id }) and batteryDefSet({ id, on?,
// mineFirst? }) → { list }. «Teach me»: batteryTeachList() → { available, devices: [{ id, unit, name, vid, pid,
// usagePage, usage, interface, verdict, family? }] }; batteryTeachStart({ id, seconds? }) and batteryTeachStop() →
// the state; batteryTeachState() → { open, id, name, listening, gone, until, now, rows: [{ id, count, rate10, bytes,
// changing }], marks: [{ kind, at }], level: [candidates with their preview], charging: [candidates] } (the proposals
// are worked out from the marks each time — «propose»); batteryTeachMark({ mark, undo? }) → the state (or { error:
// 'quiet' | 'tooMany' }); batteryTeachSave({ level, charging?, name, kind }) → { ok, id } — the definition made, kept,
// switched on, and the captured bytes dropped; batteryTeachClose() drops them too (the page calls it whenever its sheet
// closes). The captured bytes live only in this process's memory: never written, never logged.
// Copyright (C) 2026 Kurokawa contributors.
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use kt_battery::defs::{self, Active, Definition, Out, Scale};
use kt_battery::model::Kind;
use kt_battery::runner::Platform;
use kt_battery::teach::{self, Capture, Listening, MarkKind, Target};

const FILE: &str = "battery-defs.json";

#[derive(Clone)]
struct Stored {
    id: String,
    on: bool,
    mine_first: bool,
    def: Definition,
}

static DEFS: Mutex<Option<Vec<Stored>>> = Mutex::new(None);
/// The platform the loop runs over (set by battery.rs's start), for «Teach me».
static PLAT: Mutex<Option<Arc<dyn Platform>>> = Mutex::new(None);

struct Session {
    target: Target,
    cap: Arc<Mutex<Capture>>,
    run: Option<Listening>,
}

static TEACH: Mutex<Option<Session>> = Mutex::new(None);

pub(crate) fn set_platform(p: Arc<dyn Platform>) {
    *PLAT.lock().unwrap_or_else(|e| e.into_inner()) = Some(p);
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(FILE))
}

/// The definitions, read once (a damaged file or entry is dropped, never run).
fn load(app: &AppHandle) -> Vec<Stored> {
    let mut g = DEFS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(v) = g.as_ref() {
        return v.clone();
    }
    let text = file(app).and_then(|p| {
        let m = std::fs::metadata(&p).ok()?;
        if m.len() > (defs::MAX_DEFS * (defs::MAX_FILE + 256)) as u64 {
            return None;
        }
        std::fs::read_to_string(p).ok()
    });
    let v: Value = text.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let mut out: Vec<Stored> = Vec::new();
    for e in v.get("list").and_then(Value::as_array).map(|a| a.as_slice()).unwrap_or(&[]).iter().take(defs::MAX_DEFS) {
        let (Some(id), Some(t)) = (e.get("id").and_then(Value::as_str), e.get("text").and_then(Value::as_str)) else { continue };
        let Ok(def) = defs::parse(t) else { continue };
        if !clean_id(id) || out.iter().any(|s| s.id == id) {
            continue;
        }
        out.push(Stored { id: id.to_string(), on: e.get("on").and_then(Value::as_bool).unwrap_or(true), mine_first: e.get("mineFirst").and_then(Value::as_bool).unwrap_or(false), def });
    }
    *g = Some(out.clone());
    out
}

fn clean_id(id: &str) -> bool {
    (1..=24).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn save(app: &AppHandle, list: &[Stored]) -> Result<(), String> {
    let p = file(app).ok_or("no app data folder")?;
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let v = json!({ "version": 1, "list": list.iter().map(|s| json!({ "id": s.id, "on": s.on, "mineFirst": s.mine_first, "text": defs::to_text(&s.def) })).collect::<Vec<_>>() });
    // (A temp file, then a rename: a crash never leaves half a file.)
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    *DEFS.lock().unwrap_or_else(|e| e.into_inner()) = Some(list.to_vec());
    Ok(())
}

/// The definitions the loop reads (on, and — for a product a built-in reader handles — only with «use mine instead»).
pub(crate) fn active(app: &AppHandle) -> Vec<Active> {
    load(app).into_iter().filter(|s| s.on).map(|s| Active { id: s.id, def: s.def, mine_first: s.mine_first }).collect()
}

/// The same from what is read already (none before the first read — battery.rs's start reads them first).
pub(crate) fn active_cached() -> Vec<Active> {
    DEFS.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|l| l.iter().filter(|s| s.on).map(|s| Active { id: s.id.clone(), def: s.def.clone(), mine_first: s.mine_first }).collect()).unwrap_or_default()
}

fn new_id(list: &[Stored]) -> String {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let mut n = (t as u64) ^ ((list.len() as u64) << 48);
    loop {
        let id = format!("d{:x}", n & 0xFFFF_FFFF_FFFF);
        if !list.iter().any(|s| s.id == id) {
            return id;
        }
        n = n.wrapping_add(0x9E37_79B9);
    }
}

fn hex(n: u16) -> String {
    format!("{:04X}", n)
}

fn entry_json(s: &Stored) -> Value {
    let d = &s.def;
    let how = match &d.scale {
        Scale::Linear { steps: true, .. } => "steps",
        Scale::Linear { .. } => "scale",
        Scale::Table(_) => "table",
    };
    json!({
        "id": s.id, "on": s.on, "mineFirst": s.mine_first, "name": d.name, "kind": d.kind.as_str(), "note": d.note,
        "vid": hex(d.matcher.vid), "pid": hex(d.matcher.pid), "usagePage": d.matcher.usage_page.map(hex), "usage": d.matcher.usage.map(hex),
        "interface": d.matcher.interface, "productName": d.matcher.product, "builtin": defs::builtin_for(d.matcher.vid, d.matcher.pid),
        "level": { "report": d.level.report, "byte": d.level.byte, "mask": d.level.mask, "shift": d.level.shift, "how": how },
        "charging": d.charging.is_some(),
    })
}

fn list_json(list: &[Stored]) -> Value {
    json!(list.iter().map(entry_json).collect::<Vec<_>>())
}

/// The loop told (when it runs): the definitions that are on, then a new look at the devices.
fn tell_loop(app: &AppHandle) {
    crate::battery::push_prefs(app);
}

/// Adds a checked definition: refused when the list is full, when the same one is kept already, or when a built-in
/// reader handles its product and the user has not said «use mine instead».
fn add(app: &AppHandle, def: Definition, mine_first: bool) -> Value {
    let mut list = load(app);
    if list.len() >= defs::MAX_DEFS {
        return json!({ "ok": false, "error": { "code": "count", "field": "list" } });
    }
    if let Some(f) = defs::builtin_for(def.matcher.vid, def.matcher.pid) {
        if !mine_first {
            return json!({ "ok": false, "error": { "code": "builtin", "field": f } });
        }
    }
    let text = defs::to_text(&def);
    if list.iter().any(|s| defs::to_text(&s.def) == text) {
        return json!({ "ok": false, "error": { "code": "exists", "field": "" } });
    }
    let id = new_id(&list);
    list.push(Stored { id: id.clone(), on: true, mine_first, def });
    if let Err(e) = save(app, &list) {
        return json!({ "ok": false, "error": { "code": "save", "field": e } });
    }
    tell_loop(app);
    json!({ "ok": true, "id": id, "list": list_json(&list) })
}

#[tauri::command]
pub async fn kt_battery_defs(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || json!({ "list": list_json(&load(&app)), "max": defs::MAX_DEFS, "teach": cfg!(any(windows, target_os = "linux")) })).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn kt_battery_def_import(app: AppHandle, o: Value) -> Result<Value, String> {
    let text = o.get("text").and_then(Value::as_str).unwrap_or("").to_string();
    let mine_first = o.get("mineFirst").and_then(Value::as_bool).unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || match defs::parse(&text) {
        Ok(def) => add(&app, def, mine_first),
        Err(e) => json!({ "ok": false, "error": { "code": e.code, "field": e.field } }),
    })
    .await
    .map_err(|e| e.to_string())
}

fn id_of(o: &Value) -> Result<String, String> {
    o.get("id").and_then(Value::as_str).filter(|s| clean_id(s)).map(str::to_string).ok_or_else(|| "no definition id".to_string())
}

#[tauri::command]
pub async fn kt_battery_def_export(app: AppHandle, o: Value) -> Result<Value, String> {
    let id = id_of(&o)?;
    tauri::async_runtime::spawn_blocking(move || {
        let list = load(&app);
        let s = list.iter().find(|s| s.id == id).ok_or("no such definition")?;
        let safe: String = s.def.name.chars().filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_').collect::<String>().trim().chars().take(40).collect();
        let name = format!("{}.ktdevice.json", if safe.is_empty() { "device".to_string() } else { safe });
        Ok(json!({ "name": name, "text": defs::to_text(&s.def) }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kt_battery_def_remove(app: AppHandle, o: Value) -> Result<Value, String> {
    let id = id_of(&o)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut list = load(&app);
        list.retain(|s| s.id != id);
        save(&app, &list)?;
        tell_loop(&app);
        Ok(json!({ "list": list_json(&list) }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kt_battery_def_set(app: AppHandle, o: Value) -> Result<Value, String> {
    let id = id_of(&o)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut list = load(&app);
        let s = list.iter_mut().find(|s| s.id == id).ok_or("no such definition")?;
        if let Some(b) = o.get("on").and_then(Value::as_bool) {
            s.on = b;
        }
        if let Some(b) = o.get("mineFirst").and_then(Value::as_bool) {
            s.mine_first = b;
        }
        save(&app, &list)?;
        tell_loop(&app);
        Ok(json!({ "list": list_json(&list) }))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- «Teach me this device» ----

fn platform(app: &AppHandle) -> Option<Arc<dyn Platform>> {
    // (The loop started first: it is what made the platform.)
    let _ = crate::battery::ensure_live(app);
    PLAT.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
pub async fn kt_battery_teach_list(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(p) = platform(&app).filter(|_| cfg!(any(windows, target_os = "linux"))) else { return json!({ "available": false, "devices": [] }) };
        let devices: Vec<Value> = p
            .teach_targets()
            .iter()
            .map(|t| {
                let family = match t.verdict {
                    teach::Verdict::BuiltIn(f) => Some(f),
                    _ => None,
                };
                json!({ "id": t.id, "unit": t.unit, "name": t.name, "vid": hex(t.ident.vid), "pid": hex(t.ident.pid), "usagePage": hex(t.ident.usage_page), "usage": hex(t.ident.usage), "interface": t.ident.interface, "verdict": t.verdict.as_str(), "family": family })
            })
            .collect();
        json!({ "available": true, "devices": devices })
    })
    .await
    .map_err(|e| e.to_string())
}

fn level_val(l: Option<kt_battery::model::Level>) -> Value {
    l.map_or(Value::Null, crate::battery::level_json)
}

fn scale_json(s: &Scale) -> Value {
    match s {
        Scale::Linear { min, max, steps } => json!({ "min": min, "max": max, "steps": steps }),
        Scale::Table(rows) => json!({ "table": rows.iter().map(|(v, o)| match o { Out::Percent(p) => json!({ "value": v, "percent": p }), Out::Word(w) => json!({ "value": v, "word": w.as_str() }) }).collect::<Vec<_>>() }),
    }
}

fn state_json(s: Option<&Session>) -> Value {
    let Some(s) = s else { return json!({ "open": false }) };
    let c = s.cap.lock().unwrap_or_else(|e| e.into_inner());
    let p = c.propose();
    let rows: Vec<Value> = c.rows().iter().map(|r| json!({ "id": r.id, "count": r.count, "rate10": r.rate10, "bytes": r.bytes.iter().take(64).collect::<Vec<_>>(), "changing": r.changing.iter().take(64).collect::<Vec<_>>() })).collect();
    let level: Vec<Value> = p
        .level
        .iter()
        .enumerate()
        .map(|(i, l)| {
            json!({ "i": i, "report": l.field.report, "byte": l.field.byte, "mask": l.field.mask, "shift": l.field.shift, "fit": l.fit.as_str(), "scale": scale_json(&l.scale),
                "values": l.values.iter().map(|(k, v)| json!({ "mark": k.as_str(), "value": v })).collect::<Vec<_>>(), "falling": l.falling, "weak": l.weak, "score": l.score,
                "preview": level_val(teach::preview(l, &c)) })
        })
        .collect();
    let charging: Vec<Value> = p
        .charging
        .iter()
        .enumerate()
        .map(|(i, x)| {
            let r = x.rule;
            let now = c.latest(r.report).and_then(|b| b.get(usize::from(r.byte))).map(|b| if ((b >> r.bit) & 1 == 1) == r.on { "yes" } else { "no" });
            json!({ "i": i, "report": r.report, "byte": r.byte, "bit": r.bit, "on": r.on, "score": x.score, "now": now })
        })
        .collect();
    json!({
        "open": true, "id": s.target.id, "name": s.target.name, "vid": hex(s.target.ident.vid), "pid": hex(s.target.ident.pid),
        "listening": c.listening, "gone": c.gone, "until": c.until, "now": crate::battery::now_ms_pub(),
        "rows": rows, "marks": c.marks().iter().map(|m| json!({ "kind": m.kind.as_str(), "at": m.at })).collect::<Vec<_>>(),
        "level": level, "charging": charging,
    })
}

fn teach_lock() -> std::sync::MutexGuard<'static, Option<Session>> {
    TEACH.lock().unwrap_or_else(|e| e.into_inner())
}

#[tauri::command]
pub async fn kt_battery_teach_start(app: AppHandle, o: Value) -> Result<Value, String> {
    let id = o.get("id").and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 400).map(str::to_string).ok_or("no device id")?;
    let seconds = o.get("seconds").and_then(Value::as_u64).unwrap_or(teach::DEFAULT_SECONDS).min(teach::MAX_SECONDS);
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let p = platform(&app).ok_or("not on this system")?;
        let target = p.teach_targets().into_iter().find(|t| t.id == id).ok_or("this device is not connected now")?;
        if target.verdict != teach::Verdict::Allowed {
            return Err(format!("not listened to: {}", target.verdict.as_str()));
        }
        let mut g = teach_lock();
        // (Another device: its session ends and its bytes are dropped. The same one: its marks kept, a new run.)
        if g.as_ref().map_or(false, |s| s.target.id != id) {
            g.take();
        }
        if let Some(run) = g.as_mut().and_then(|s| s.run.take()) {
            run.stop();
        }
        let t = p.teach_open(&id).map_err(|e| format!("{:?}", e))?;
        let cap = g.as_ref().map(|s| s.cap.clone()).unwrap_or_else(|| Arc::new(Mutex::new(Capture::default())));
        let run = Listening::start(t, seconds, cap.clone(), Arc::new(crate::battery::now_ms_pub)).map_err(|e| format!("{:?}", e))?;
        *g = Some(Session { target, cap, run: Some(run) });
        Ok(state_json(g.as_ref()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kt_battery_teach_stop() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut g = teach_lock();
        if let Some(run) = g.as_mut().and_then(|s| s.run.take()) {
            run.stop();
        }
        state_json(g.as_ref())
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn kt_battery_teach_state() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || state_json(teach_lock().as_ref())).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn kt_battery_teach_mark(o: Value) -> Result<Value, String> {
    let undo = o.get("undo").and_then(Value::as_bool).unwrap_or(false);
    let kind = o.get("mark").and_then(Value::as_str).and_then(MarkKind::parse);
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let g = teach_lock();
        let s = g.as_ref().ok_or("no device is being listened to")?;
        {
            let mut c = s.cap.lock().unwrap_or_else(|e| e.into_inner());
            if undo {
                c.undo_mark();
            } else {
                let k = kind.ok_or("no such mark")?;
                if let Err(e) = c.mark(k, crate::battery::now_ms_pub()) {
                    return Ok(json!({ "error": match e { teach::MarkErr::Quiet => "quiet", teach::MarkErr::TooMany => "tooMany" } }));
                }
            }
        }
        Ok(state_json(Some(s)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kt_battery_teach_save(app: AppHandle, o: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let def = {
            let g = teach_lock();
            let s = g.as_ref().ok_or("no device is being listened to")?;
            let c = s.cap.lock().unwrap_or_else(|e| e.into_inner());
            let p = c.propose();
            let li = o.get("level").and_then(Value::as_u64).ok_or("no level chosen")? as usize;
            let level = p.level.get(li).ok_or("that proposal is gone")?;
            let charging = match o.get("charging").and_then(Value::as_u64) {
                Some(i) => Some(p.charging.get(i as usize).ok_or("that proposal is gone")?),
                None => None,
            };
            let name = o.get("name").and_then(Value::as_str).unwrap_or("");
            let kind = Kind::parse(o.get("kind").and_then(Value::as_str).unwrap_or("other"));
            match teach::definition(&s.target, &s.target.name, level, charging, name, kind) {
                Ok(d) => d,
                Err(e) => return Ok(json!({ "ok": false, "error": { "code": e.code, "field": e.field } })),
            }
        };
        let r = add(&app, def, false);
        if r.get("ok").and_then(Value::as_bool) == Some(true) {
            // (Saved: the captured bytes go.)
            teach_lock().take();
        }
        Ok(r)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kt_battery_teach_close() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // (The run stopped — its handle closed — and every captured byte dropped.)
        let had = teach_lock().take().is_some();
        json!(had)
    })
    .await
    .map_err(|e| e.to_string())
}
