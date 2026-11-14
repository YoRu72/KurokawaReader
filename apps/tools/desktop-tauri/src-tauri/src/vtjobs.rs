// Stage P5: the video jobs (desktop/ytdlp.cjs VideoJobs) — each a task like aria2's, of kind «video», run by yt-dlp
// with its progress read from the progress template (kt-core's LineReader), listed after aria2's downloads in kt:list
// and the kt:tasks event (main.cjs allTasks), kept in <app data>/video-jobs.json (one running when the app ended
// comes back paused). kt:add with `o.video`, and kt:pause / kt:resume / kt:remove / kt:open for a video task's id,
// come here (commands.rs). The page is told at most every 400 ms, and at once when the phase changes.
// Differences from Electron: pause and remove end yt-dlp's whole tree (its ffmpeg too), not yt-dlp alone.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};

use kt_core::videotools as vt;

use crate::vtools::{self, now_ms};
use crate::vtproc;

pub struct Jobs {
    app: AppHandle,
    path: PathBuf,
    st: Mutex<State>,
}
#[derive(Default)]
struct State {
    /// The tasks in the order they were added.
    tasks: Vec<Value>,
    procs: HashMap<String, u32>,
}

static JOBS: OnceLock<Arc<Jobs>> = OnceLock::new();
static SEQ: AtomicU64 = AtomicU64::new(0);
/// aria2's list as last pushed (main.cjs lastAria), so a video's change goes out with it.
static ARIA: Mutex<Option<Value>> = Mutex::new(None);
/// One push at a time: the list is read and sent under it, so an older list never overtakes a newer one.
static EMIT: Mutex<()> = Mutex::new(());

pub fn init(app: &AppHandle) {
    let path = vtools::dirs().data.join("video-jobs.json");
    let mut st = State::default();
    if let Ok(t) = std::fs::read_to_string(&path) {
        if let Ok(Value::Array(xs)) = serde_json::from_str::<Value>(&t) {
            for mut x in xs {
                if let Value::Object(m) = &mut x {
                    let s = m.get("state").and_then(|v| v.as_str()).unwrap_or("");
                    if s == "downloading" || s == "queued" {
                        m.insert("state".into(), json!("paused"));
                    }
                }
                st.tasks.push(x);
            }
        }
    }
    let _ = JOBS.set(Arc::new(Jobs { app: app.clone(), path, st: Mutex::new(st) }));
}

fn get() -> Option<Arc<Jobs>> {
    JOBS.get().cloned()
}

fn id_of(t: &Value) -> &str {
    t.get("id").and_then(|v| v.as_str()).unwrap_or("")
}

/// Whether `id` is a video task (main.cjs isVideoId).
pub fn has(id: &str) -> bool {
    id.starts_with('v') && get().map(|j| j.lock().tasks.iter().any(|t| id_of(t) == id)).unwrap_or(false)
}

/// The video tasks.
pub fn list() -> Vec<Value> {
    get().map(|j| j.lock().tasks.clone()).unwrap_or_default()
}

/// aria2's list followed by the video tasks (main.cjs allTasks).
pub fn merged(aria: Value) -> Value {
    let mut all = match aria {
        Value::Array(xs) => xs,
        _ => Vec::new(),
    };
    all.extend(list());
    Value::Array(all)
}

/// The engine's push (engine.rs): aria2's list kept, and sent with the video tasks.
pub fn emit_tasks(app: &AppHandle, aria: Value) {
    let _g = EMIT.lock();
    if let Ok(mut a) = ARIA.lock() {
        *a = Some(aria.clone());
    }
    let _ = app.emit("kt:tasks", merged(aria));
}

/// A video task changed: the whole list sent.
fn push(app: &AppHandle) {
    let _g = EMIT.lock();
    let aria = ARIA.lock().ok().and_then(|a| a.clone()).unwrap_or(Value::Array(Vec::new()));
    let _ = app.emit("kt:tasks", merged(aria));
}

fn set(m: &mut Map<String, Value>, k: &str, v: Option<Value>) {
    match v {
        Some(Value::Null) | None => {
            m.remove(k);
        }
        Some(x) => {
            m.insert(k.to_string(), x);
        }
    }
}
fn s_of(o: &Value, k: &str) -> Option<String> {
    match o.get(k) {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(Value::Bool(b)) => Some(b.to_string()),
        _ => None,
    }
}
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|x| x != 0.0 && !x.is_nan()).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}
fn num(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse::<f64>().unwrap_or(0.0),
        Some(Value::Bool(true)) => 1.0,
        _ => 0.0,
    }
}

/// A task's settings for kt-core's argument lists (ytdlp.cjs reads `t.meta`).
fn job_meta(m: &Value) -> vt::JobMeta {
    let args = match m.get("args") {
        Some(Value::Array(xs)) => Some(xs.iter().map(|x| match x {
            Value::String(s) => s.clone(),
            // (A non-string in the list: vetArgs refuses the list — a NUL makes kt-core refuse it too.)
            _ => "\0".to_string(),
        }).collect()),
        _ => None,
    };
    let headers = match m.get("headers") {
        Some(Value::Object(h)) => h.iter().map(|(k, v)| (k.clone(), match v {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        })).collect(),
        _ => Vec::new(),
    };
    vt::JobMeta {
        args,
        audio_only: truthy(m.get("audioOnly")),
        format: s_of(m, "format"),
        container: s_of(m, "container"),
        subs: s_of(m, "subs"),
        bilingual: truthy(m.get("bilingual")),
        embed_thumb: truthy(m.get("embedThumb")),
        info_json: truthy(m.get("infoJson")),
        comments: truthy(m.get("comments")),
        live_chat: truthy(m.get("liveChat")),
        cover: truthy(m.get("cover")),
        embed_meta: m.get("embedMeta") != Some(&Value::Bool(false)),
        sponsor_mode: s_of(m, "sponsorMode"),
        sponsorblock: truthy(m.get("sponsorblock")),
        sponsor_cats: s_of(m, "sponsorCats"),
        cookies_from_browser: s_of(m, "cookiesFromBrowser"),
        chapters: truthy(m.get("chapters")),
        section: s_of(m, "section"),
        chapter_match: s_of(m, "chapterMatch"),
        split_chapters: truthy(m.get("splitChapters")),
        headers,
        out_name: s_of(m, "outName"),
        template: s_of(m, "template"),
        playlist_index: s_of(m, "playlistIndex"),
    }
}

/// ytdlp.cjs add(o): o is `{ ...o.video, url, dir, paused, meta }` (main.cjs kt:add).
pub fn add(o: &Value) -> Result<Value, String> {
    let j = get().ok_or_else(|| "video jobs not ready".to_string())?;
    // (ytdlp.cjs: «v» + the time in base 36 + four random characters; here a counter mixed in, so two added in the
    // same millisecond differ.)
    let seq = SEQ.fetch_add(1, Ordering::SeqCst);
    let mix = (now_ms() ^ seq.wrapping_mul(0x9E37_79B9) ^ (std::process::id() as u64) << 20).wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 40;
    let tail = radix36(mix + 36u64.pow(4));
    let id = format!("v{}{}", radix36(now_ms()), &tail[tail.len() - 4..]);
    let url = s_of(o, "url").unwrap_or_default();
    let mut meta = match o.get("meta") {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    };
    // (The keys ytdlp.cjs writes after `...o.meta`: each replaces the page's own, an undefined one removes it.)
    let pick = |k: &str| o.get(k).cloned();
    set(&mut meta, "kind", Some(json!("video")));
    set(&mut meta, "site", pick("site"));
    set(&mut meta, "quality", pick("label"));
    set(&mut meta, "format", pick("format"));
    set(&mut meta, "audioOnly", Some(json!(truthy(o.get("audioOnly")))));
    for k in ["container", "headers", "outName", "subs", "embedThumb", "embedMeta", "sponsorblock"] {
        set(&mut meta, k, pick(k));
    }
    set(&mut meta, "args", match o.get("args") {
        Some(a @ Value::Array(_)) => Some(a.clone()),
        _ => None,
    });
    set(&mut meta, "expect", if truthy(o.get("expect")) { pick("expect") } else { None });
    for k in ["audioFmt", "playlistIndex"] {
        set(&mut meta, k, pick(k));
    }
    set(&mut meta, "cookiesFromBrowser", if truthy(o.get("cookies")) { pick("cookies") } else { pick("cookiesFromBrowser") });
    for k in ["chapters", "template", "section"] {
        set(&mut meta, k, pick(k));
    }
    let name = match o.get("title") {
        Some(t) if truthy(Some(t)) => t.clone(),
        _ => json!(url),
    };
    let mut t = json!({ "id": id, "kind": "video", "name": name, "source": { "url": url }, "state": "queued", "done": 0, "total": 0,
        "downSpeed": 0, "upSpeed": 0, "files": [], "addedAt": now_ms(), "meta": Value::Object(meta), "engine": "native" });
    if let (Value::Object(m), Some(d)) = (&mut t, o.get("dir").filter(|d| !d.is_null())) {
        m.insert("dir".into(), d.clone());
    }
    {
        let mut g = j.lock();
        g.tasks.push(t.clone());
    }
    j.save();
    push(&j.app);
    if !truthy(o.get("paused")) {
        let j2 = j.clone();
        let id2 = id.clone();
        tauri::async_runtime::spawn(async move { j2.start(&id2).await });
    }
    Ok(t)
}

fn radix36(mut n: u64) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(D[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

impl Jobs {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        match self.st.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }
    fn save(&self) {
        let text = Value::Array(self.lock().tasks.clone()).to_string();
        let _ = std::fs::create_dir_all(self.path.parent().unwrap_or(Path::new(".")));
        let _ = std::fs::write(&self.path, text);
    }
    /// A task changed in place (`f` on its object); false when it is gone.
    fn edit<F: FnOnce(&mut Map<String, Value>)>(&self, id: &str, f: F) -> bool {
        let mut g = self.lock();
        match g.tasks.iter_mut().find(|t| id_of(t) == id) {
            Some(Value::Object(m)) => {
                f(m);
                true
            }
            _ => false,
        }
    }
    fn task(&self, id: &str) -> Option<Value> {
        self.lock().tasks.iter().find(|t| id_of(t) == id).cloned()
    }

    /// ytdlp.cjs start(id).
    async fn start(self: &Arc<Self>, id: &str) {
        {
            let mut g = self.lock();
            if g.procs.contains_key(id) {
                return;
            }
            // (Marked running at once, so a second start does not begin while this one fetches yt-dlp.)
            g.procs.insert(id.to_string(), 0);
        }
        let ok = self.edit(id, |m| {
            m.insert("state".into(), json!("downloading"));
            m.remove("error");
        });
        if !ok {
            self.lock().procs.remove(id);
            return;
        }
        push(&self.app);
        if let Err(e) = vtools::ensure(None).await {
            self.lock().procs.remove(id);
            self.edit(id, |m| {
                m.insert("state".into(), json!("failed"));
                m.insert("error".into(), json!(e));
            });
            push(&self.app);
            self.save();
            return;
        }
        let me = self.clone();
        let id2 = id.to_string();
        let _ = vtools::blocking(move || me.run(&id2)).await;
    }

    /// The job run to its end (blocking).
    fn run(self: &Arc<Self>, id: &str) {
        vtools::check_js();
        let t = match self.task(id) {
            Some(t) => t,
            None => {
                self.lock().procs.remove(id);
                return;
            }
        };
        let meta = t.get("meta").cloned().unwrap_or(json!({}));
        let jm = job_meta(&meta);
        let dir = s_of(&t, "dir").unwrap_or_default();
        let url = t.get("source").and_then(|s| s.get("url")).and_then(|u| u.as_str()).unwrap_or("").to_string();
        let sep = if cfg!(windows) { '\\' } else { '/' };
        let args = match vt::job_args(&jm, &dir, &url, &vtools::common_args(), sep) {
            Ok(a) => a,
            Err(e) => {
                self.lock().procs.remove(id);
                self.edit(id, |m| {
                    m.insert("state".into(), json!("failed"));
                    m.insert("error".into(), json!(e));
                });
                push(&self.app);
                self.save();
                return;
            }
        };
        let phase = meta.get("phase").and_then(|p| p.as_str()).map(|s| s.to_string());
        let audio_fmt = s_of(&meta, "audioFmt").unwrap_or_default();
        let mut rd = vt::LineReader::new(jm.audio_only, &audio_fmt, num(meta.get("expect")).max(0.0) as u64, phase);
        let me = self.clone();
        let idl = id.to_string();
        let mut last = Instant::now() - Duration::from_secs(1);
        let mut seen_bytes = false;
        let spawned = vtproc::spawn_lines(&vtools::bin_path(), &args, 20_000, move |l| {
            let force = rd.line(l);
            if l.starts_with("KT|") {
                seen_bytes = true;
            }
            let p = rd.p.clone();
            let changed = me.edit(&idl, |m| apply(m, &p, seen_bytes));
            if changed && (force || last.elapsed() > Duration::from_millis(400)) {
                last = Instant::now();
                push(&me.app);
            }
        });
        let lines = match spawned {
            Ok(p) => p,
            Err(e) => {
                self.lock().procs.remove(id);
                self.edit(id, |m| {
                    m.insert("state".into(), json!("failed"));
                    m.insert("error".into(), json!(e));
                });
                push(&self.app);
                self.save();
                return;
            }
        };
        self.lock().procs.insert(id.to_string(), lines.pid);
        // (Paused or removed while it started: ended now.)
        let st = self.task(id).and_then(|t| s_of(&t, "state"));
        if st.as_deref() != Some("downloading") {
            vtproc::kill_tree(lines.pid);
        }
        let (code, err) = lines.wait();
        self.lock().procs.remove(id);
        let mut bilingual: Option<(PathBuf, String)> = None;
        self.edit(id, |m| {
            let s = m.get("state").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if s == "paused" || s == "removed" {
                return;
            }
            if code == Some(0) {
                m.insert("state".into(), json!("done"));
                let total = num(m.get("total"));
                if total > 0.0 {
                    m.insert("done".into(), json!(total as u64));
                }
                m.insert("doneAt".into(), json!(now_ms()));
                m.insert("downSpeed".into(), json!(0));
                if let Some(pair) = meta.get("bilingual").filter(|b| truthy(Some(b))) {
                    let pair = match pair {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    let f = m.get("files").and_then(|f| f.get(0)).and_then(|f| f.get("path").or_else(|| f.get("name"))).and_then(|p| p.as_str()).unwrap_or("").to_string();
                    if !f.is_empty() {
                        bilingual = Some((Path::new(&dir).join(f), pair));
                    }
                }
            } else {
                m.insert("state".into(), json!("failed"));
                m.insert("error".into(), json!(vt::job_error(&err, code)));
            }
        });
        if let Some((out, pair)) = bilingual {
            let _ = merge_bilingual(&out, &pair);
        }
        self.save();
        push(&self.app);
    }

    fn stop_proc(&self, id: &str) {
        let pid = self.lock().procs.get(id).copied().unwrap_or(0);
        if pid > 0 {
            vtproc::kill_tree(pid);
        }
    }
}

/// What the reader knows, put on the task (ytdlp.cjs lineReader's writes to `t`).
fn apply(m: &mut Map<String, Value>, p: &vt::Progress, seen_bytes: bool) {
    if seen_bytes {
        m.insert("done".into(), json!(p.done));
        m.insert("total".into(), json!(p.total));
        m.insert("downSpeed".into(), json!(p.speed));
        set(m, "eta", p.eta.map(|e| json!(e)));
    }
    if let Some(Value::Object(meta)) = m.get_mut("meta") {
        set(meta, "phase", p.phase.clone().map(Value::String));
        match p.frag {
            Some((i, n)) => {
                meta.insert("frag".into(), json!(i));
                meta.insert("frags".into(), json!(n));
            }
            None => {
                meta.remove("frag");
                meta.remove("frags");
            }
        }
    }
    if let Some(f) = &p.file {
        let total = m.get("total").cloned().unwrap_or(json!(0));
        let done = if p.file_whole { total.clone() } else { m.get("done").cloned().unwrap_or(json!(0)) };
        m.insert("files".into(), json!([{ "index": 0, "path": f, "size": total, "done": done, "priority": 1 }]));
        if let Some(n) = p.name.as_ref().filter(|n| !n.is_empty()) {
            m.insert("name".into(), json!(n));
        }
    }
    if let Some(d) = &p.detail {
        m.insert("detail".into(), json!(d));
    }
}

/// ytdlp.cjs bilingual(out, pair): the two languages' .srt beside the video merged cue by cue into «stem.la-lb.srt».
fn merge_bilingual(out: &Path, pair: &str) -> Option<()> {
    let mut it = pair.split(',');
    let (la, lb) = (it.next()?.to_string(), it.next()?.to_string());
    if la.is_empty() || lb.is_empty() {
        return None;
    }
    let dir = out.parent()?;
    let name = out.file_name()?.to_string_lossy().into_owned();
    let stem = match name.rfind('.') {
        Some(i) if i > 0 => name[..i].to_string(),
        _ => name.clone(),
    };
    let names: Vec<String> = std::fs::read_dir(dir).ok()?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    let find = |lang: &str| names.iter().find(|n| vt::srt_of_lang(n, &stem, lang)).cloned();
    let (fa, fb) = (find(&la)?, find(&lb)?);
    let ta = std::fs::read_to_string(dir.join(fa)).ok()?;
    let tb = std::fs::read_to_string(dir.join(fb)).ok()?;
    let text = vt::merge_srt(&ta, &tb)?;
    std::fs::write(dir.join(format!("{}.{}-{}.srt", stem, la, lb)), text).ok()
}

/* ---------- what commands.rs routes here ---------- */

/// ytdlp.cjs pause(id).
pub fn pause(id: &str) {
    if let Some(j) = get() {
        j.edit(id, |m| {
            m.insert("state".into(), json!("paused"));
            m.insert("downSpeed".into(), json!(0));
        });
        j.stop_proc(id);
        j.save();
        push(&j.app);
    }
}

/// ytdlp.cjs resume(id).
pub fn resume(id: &str) {
    if let Some(j) = get() {
        if j.task(id).is_some() {
            let id2 = id.to_string();
            tauri::async_runtime::spawn(async move { j.start(&id2).await });
        }
    }
}

/// ytdlp.cjs remove(id, deleteFiles): the files beside it that start with its name removed too when asked.
pub fn remove(id: &str, delete_files: bool) {
    let j = match get() {
        Some(j) => j,
        None => return,
    };
    let t = match j.task(id) {
        Some(t) => t,
        None => return,
    };
    j.edit(id, |m| {
        m.insert("state".into(), json!("removed"));
    });
    j.stop_proc(id);
    j.lock().tasks.retain(|x| id_of(x) != id);
    let dir = s_of(&t, "dir").unwrap_or_default();
    let first = t.get("files").and_then(|f| f.get(0)).and_then(|f| f.get("path")).and_then(|p| p.as_str()).map(|s| s.to_string());
    if delete_files && !dir.is_empty() {
        if let Some(f) = first {
            let stem = match f.rfind('.') {
                Some(i) => f[..i].to_string(),
                None => f.clone(),
            };
            if let Ok(rd) = std::fs::read_dir(&dir) {
                for e in rd.flatten() {
                    if e.file_name().to_string_lossy().starts_with(&stem) {
                        let _ = std::fs::remove_file(e.path());
                    }
                }
            }
        }
    }
    j.save();
    push(&j.app);
}

/// ytdlp.cjs fileOf(id): the file, else the folder.
pub fn file_of(id: &str) -> String {
    let t = match get().and_then(|j| j.task(id)) {
        Some(t) => t,
        None => return String::new(),
    };
    let dir = s_of(&t, "dir").unwrap_or_default();
    match t.get("files").and_then(|f| f.get(0)).and_then(|f| f.get("path")).and_then(|p| p.as_str()) {
        Some(p) => Path::new(&dir).join(p).to_string_lossy().into_owned(),
        None => dir,
    }
}

/// The app ends: every job's tree ended (ytdlp.cjs stop).
pub fn stop_all() {
    if let Some(j) = get() {
        let pids: Vec<u32> = j.lock().procs.values().copied().filter(|p| *p > 0).collect();
        for p in pids {
            vtproc::kill_tree(p);
        }
    }
}
