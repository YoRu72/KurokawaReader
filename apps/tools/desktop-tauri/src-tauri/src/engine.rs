// The download engine (desktop/aria2.cjs + the task handlers of desktop/main.cjs): aria2c run beside the app on a
// free loopback port with a secret, spoken to over its HTTP JSON-RPC endpoint (rpc.rs, plain std — no WebSocket),
// the list polled and pushed to the page as the `kt:tasks` event only when it changed, `kt:engineState` when aria2c
// comes or goes. Everything here is synchronous on plain threads; the commands run it with spawn_blocking. The pure
// parts (arguments, options, the Task mapping) are in engine_core.rs.
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};

use crate::engine_core as ec;
use crate::{rpc, util};

static ENGINE: OnceLock<Arc<Engine>> = OnceLock::new();
static SEQ: AtomicU64 = AtomicU64::new(0);

pub fn get() -> Option<Arc<Engine>> {
    ENGINE.get().cloned()
}

pub struct Engine {
    app: AppHandle,
    data_dir: PathBuf,
    pub default_dir: PathBuf,
    res_dirs: Vec<PathBuf>,
    st: Mutex<Inner>,
    start_lock: Mutex<()>,
    wake: Mutex<Sender<()>>,
}

struct Inner {
    child: Option<Child>,
    port: u16,
    secret: String,
    available: bool,
    reason: String,
    restarts: u32,
    stopping: bool,
    said: Arc<Mutex<String>>,
    keep: Map<String, Value>,
    config: Value,
    last: Value,
    last_json: Option<String>,
    /// When a download the app kept nothing of was first seen / seen done (so its times hold still).
    first_seen: HashMap<String, i64>,
    done_seen: HashMap<String, i64>,
}

/* ---------- small JSON helpers (JS's truthiness and String()) ---------- */

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|x| x != 0.0 && !x.is_nan()).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

fn opt_text(v: Option<&Value>) -> Option<String> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => Some(other.to_string()),
    }
}

/// JS's Number(v) (undefined/null → None).
fn number(v: Option<&Value>) -> Option<f64> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                Some(0.0)
            } else {
                Some(t.parse::<f64>().unwrap_or(f64::NAN))
            }
        }
        Some(_) => Some(f64::NAN),
    }
}

fn int_of(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        _ => None,
    }
}

/// `String(x || 0)` for a speed limit: a text as it is («100K»), a number as JS writes it.
fn limit_text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        Some(Value::Number(n)) => ec::js_num(n.as_f64().unwrap_or(0.0)),
        _ => "0".to_string(),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn read_json(p: &Path) -> Option<Value> {
    let t = fs::read_to_string(p).ok()?;
    serde_json::from_str::<Value>(&t).ok()
}

fn opts_value(o: &[(String, String)]) -> Value {
    let mut m = Map::new();
    for (k, v) in o {
        m.insert(k.clone(), Value::String(v.clone()));
    }
    Value::Object(m)
}

/* ---------- JSON ⇄ engine_core ---------- */

pub fn net_config(n: Option<&Value>) -> ec::NetConfig {
    let empty = json!({});
    let n = match n {
        Some(v) if v.is_object() => v,
        _ => &empty,
    };
    ec::NetConfig {
        ua: if truthy(n.get("ua")) {
            text(n.get("ua"))
        } else {
            String::new()
        },
        retries: number(n.get("retries")),
        timeout: number(n.get("timeout")),
        proxy: if truthy(n.get("proxy")) {
            text(n.get("proxy"))
        } else {
            String::new()
        },
        conflict: if truthy(n.get("conflict")) {
            text(n.get("conflict"))
        } else {
            String::new()
        },
    }
}

pub fn engine_config(c: &Value) -> ec::EngineConfig {
    ec::EngineConfig {
        seed: truthy(c.get("seed")),
        listen_port: number(c.get("listenPort")).unwrap_or(0.0),
        max_connections: number(c.get("maxConnections")).unwrap_or(f64::NAN),
        seed_ratio: number(c.get("seedRatio")).unwrap_or(0.0),
        seed_minutes: number(c.get("seedMinutes")).unwrap_or(0.0),
        dht_off: c.get("dht") == Some(&Value::Bool(false)),
        lsd_off: c.get("lsd") == Some(&Value::Bool(false)),
        enc_forced: c.get("enc").and_then(|x| x.as_str()) == Some("forced"),
        net: net_config(c.get("net")),
    }
}

pub fn status_of(v: &Value) -> ec::Status {
    let mut files: Vec<ec::FileSt> = Vec::new();
    if let Some(Value::Array(fs_)) = v.get("files") {
        for f in fs_.iter() {
            let mut uris: Vec<String> = Vec::new();
            if let Some(Value::Array(us)) = f.get("uris") {
                for u in us.iter() {
                    uris.push(text(u.get("uri")));
                }
            }
            files.push(ec::FileSt {
                index: text(f.get("index")),
                path: text(f.get("path")),
                length: text(f.get("length")),
                completed_length: text(f.get("completedLength")),
                selected: text(f.get("selected")),
                first_uri: uris.first().cloned(),
                uris,
            });
        }
    }
    let bt = v.get("bittorrent");
    let bittorrent = !matches!(bt, None | Some(Value::Null));
    let bt_name = bt
        .and_then(|b| b.get("info"))
        .and_then(|i| i.get("name"))
        .and_then(|n| n.as_str())
        .map(|s| s.to_string());
    let mut followed_by: Vec<String> = Vec::new();
    if let Some(Value::Array(xs)) = v.get("followedBy") {
        for x in xs.iter() {
            followed_by.push(text(Some(x)));
        }
    }
    ec::Status {
        gid: text(v.get("gid")),
        status: text(v.get("status")),
        total_length: text(v.get("totalLength")),
        completed_length: text(v.get("completedLength")),
        download_speed: text(v.get("downloadSpeed")),
        upload_speed: text(v.get("uploadSpeed")),
        info_hash: opt_text(v.get("infoHash")),
        num_seeders: opt_text(v.get("numSeeders")),
        connections: text(v.get("connections")),
        error_code: opt_text(v.get("errorCode")),
        error_message: opt_text(v.get("errorMessage")),
        dir: text(v.get("dir")),
        files,
        bittorrent,
        bt_name,
        followed_by,
        bitfield: opt_text(v.get("bitfield")),
        num_pieces: text(v.get("numPieces")),
        piece_length: text(v.get("pieceLength")),
    }
}

fn extra_of(k: Option<&Value>) -> ec::Extra {
    match k {
        Some(k) => ec::Extra {
            name: if truthy(k.get("name")) {
                Some(text(k.get("name")))
            } else {
                None
            },
            renamed: if truthy(k.get("renamed")) {
                Some(text(k.get("renamed")))
            } else {
                None
            },
            added_at: int_of(k.get("addedAt")),
            done_at: int_of(k.get("doneAt")),
        },
        None => ec::Extra::default(),
    }
}

/// The page's Task (src/engine/types.ts) from the mapped core and what was kept (source, meta).
pub fn task_value(c: &ec::TaskCore, keep: Option<&Value>) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), json!(c.id));
    m.insert("kind".into(), json!(c.kind));
    m.insert("name".into(), json!(c.name));
    let kept_source = keep
        .and_then(|k| k.get("source"))
        .filter(|s| truthy(Some(*s)));
    let source = match kept_source {
        Some(s) => s.clone(),
        None => {
            if let Some(mg) = &c.magnet {
                json!({ "magnet": mg })
            } else if let Some(u) = &c.url {
                json!({ "url": u })
            } else {
                json!({})
            }
        }
    };
    m.insert("source".into(), source);
    m.insert("dir".into(), json!(c.dir));
    m.insert("state".into(), json!(c.state));
    m.insert("done".into(), json!(c.done));
    m.insert("total".into(), json!(c.total));
    m.insert("downSpeed".into(), json!(c.down_speed));
    m.insert("upSpeed".into(), json!(c.up_speed));
    if let Some(e) = c.eta {
        m.insert("eta".into(), json!(e));
    }
    if let Some(p) = c.peers {
        m.insert("peers".into(), json!(p));
    }
    if let Some(s) = c.seeds {
        m.insert("seeds".into(), json!(s));
    }
    if let Some(n) = c.connections {
        m.insert("connections".into(), json!(n));
    }
    if let Some(h) = &c.info_hash {
        m.insert("infoHash".into(), json!(h));
    }
    let files: Vec<Value> = c
        .files
        .iter()
        .map(|f| json!({ "index": f.index, "path": f.path, "size": f.size, "done": f.done, "priority": f.priority }))
        .collect();
    m.insert("files".into(), Value::Array(files));
    if let Some(segs) = &c.segments {
        let v: Vec<Value> = segs
            .iter()
            .map(|s| json!({ "start": s.start, "pos": s.end, "end": s.end, "active": false, "worker": 0 }))
            .collect();
        m.insert("segments".into(), Value::Array(v));
    }
    if let Some(e) = &c.error {
        m.insert("error".into(), json!(e));
    }
    m.insert("addedAt".into(), json!(c.added_at));
    if let Some(d) = c.done_at {
        m.insert("doneAt".into(), json!(d));
    }
    if let Some(meta) = keep.and_then(|k| k.get("meta")) {
        if !meta.is_null() {
            m.insert("meta".into(), meta.clone());
        }
    }
    m.insert("engine".into(), json!("native"));
    Value::Object(m)
}

/* ---------- the process ---------- */

#[cfg(windows)]
fn no_window(c: &mut Command) {
    use std::os::windows::process::CommandExt;
    c.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn no_window(_c: &mut Command) {}

/// A shipped aria2c that lost its executable bit on the way (a copy, an unzip) given it back, where it can be.
#[cfg(unix)]
fn ensure_exec(p: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(md) = fs::metadata(p) {
        let mode = md.permissions().mode();
        if mode & 0o111 == 0 {
            let mut perm = md.permissions();
            perm.set_mode(mode | 0o755);
            let _ = fs::set_permissions(p, perm);
        }
    }
}

#[cfg(not(unix))]
fn ensure_exec(_p: &Path) {}

fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let p = l.local_addr().map_err(|e| e.to_string())?.port();
    drop(l);
    Ok(p)
}

/// Starts the engine (once): its state read from `data_dir`, aria2c started in the background.
pub fn init(app: AppHandle, data_dir: PathBuf, default_dir: PathBuf, res_dirs: Vec<PathBuf>) {
    let _ = fs::create_dir_all(&data_dir);
    let keep = match read_json(&data_dir.join("tasks.json")) {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    };
    let mut config = json!({ "seed": false, "listenPort": 0, "maxConnections": 8 });
    if let Some(Value::Object(saved)) = read_json(&data_dir.join("aria2-config.json")) {
        for (k, v) in saved {
            config[k.as_str()] = v;
        }
    }
    let (tx, rx) = channel::<()>();
    let e = Arc::new(Engine {
        app,
        data_dir,
        default_dir,
        res_dirs,
        st: Mutex::new(Inner {
            child: None,
            port: 0,
            secret: String::new(),
            available: false,
            reason: String::new(),
            restarts: 0,
            stopping: false,
            said: Arc::new(Mutex::new(String::new())),
            keep,
            config,
            last: json!([]),
            last_json: None,
            first_seen: HashMap::new(),
            done_seen: HashMap::new(),
        }),
        start_lock: Mutex::new(()),
        wake: Mutex::new(tx),
    });
    if ENGINE.set(e.clone()).is_err() {
        return;
    }
    let poller = e.clone();
    thread::spawn(move || poll_loop(poller, rx));
    let watcher = e.clone();
    thread::spawn(move || watch_loop(watcher));
    // (Not waited for: the window opens at once; the page is told when aria2c is up.)
    let starter = e;
    thread::spawn(move || {
        starter.ensure();
    });
}

/// The list asked again and again — soon while something moves —, pushed to the page when it changed.
fn poll_loop(e: Arc<Engine>, rx: Receiver<()>) {
    loop {
        let mut delay: u64 = 4000;
        let up = e.lock().available;
        if up {
            if let Ok(v) = e.list() {
                let states: Vec<String> = match &v {
                    Value::Array(a) => a.iter().map(|t| text(t.get("state"))).collect(),
                    _ => Vec::new(),
                };
                let refs: Vec<&str> = states.iter().map(|s| s.as_str()).collect();
                delay = ec::next_delay_ms(&refs);
                e.push_tasks(&v);
            }
        }
        match rx.recv_timeout(Duration::from_millis(delay)) {
            Ok(()) => {
                thread::sleep(Duration::from_millis(50));
                while rx.try_recv().is_ok() {}
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// aria2c watched: when it stops on its own while in use (not the app quitting), started again, a few times at most.
fn watch_loop(e: Arc<Engine>) {
    loop {
        thread::sleep(Duration::from_millis(500));
        if let Some(n) = e.reap() {
            thread::sleep(Duration::from_millis(2000 * n as u64));
            e.ensure();
        }
    }
}

impl Engine {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        match self.st.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    pub fn state(&self) -> Value {
        let g = self.lock();
        json!({ "available": g.available, "reason": g.reason, "os": util::node_platform(), "arch": util::node_arch() })
    }

    pub fn available(&self) -> bool {
        self.lock().available
    }

    fn emit_state(&self) {
        let s = self.state();
        let _ = self.app.emit("kt:engineState", s);
    }

    fn push_tasks(&self, v: &Value) {
        let text = v.to_string();
        let send = {
            let mut g = self.lock();
            if ec::changed(g.last_json.as_deref(), &text) {
                g.last_json = Some(text);
                true
            } else {
                false
            }
        };
        if send {
            let _ = self.app.emit("kt:tasks", v.clone());
        }
    }

    /// The list asked again soon (after a change made from the page).
    pub fn tick(&self) {
        if let Ok(tx) = self.wake.lock() {
            let _ = tx.send(());
        }
    }

    fn save_keep(&self, keep: &Map<String, Value>) {
        let text = Value::Object(keep.clone()).to_string();
        let _ = fs::write(self.data_dir.join("tasks.json"), text);
    }

    /// The aria2c to run → (its path or name, whether it is the app's own).
    pub fn find_binary(&self) -> Option<(String, bool)> {
        let os = util::node_platform();
        let mut cands = ec::binary_candidates(&self.res_dirs, os, util::node_arch());
        // (Beyond aria2.cjs's layout: the folder's files flattened into aria2/, should the bundler do that.)
        for r in self.res_dirs.iter() {
            let flat = r.join("aria2").join(ec::exe_name(os));
            if !cands.contains(&flat) {
                cands.push(flat);
            }
        }
        for c in cands.iter() {
            if c.is_file() {
                return Some((c.to_string_lossy().into_owned(), true));
            }
        }
        let exe = ec::exe_name(os);
        let mut cmd = Command::new(exe);
        cmd.arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        no_window(&mut cmd);
        if let Ok(s) = cmd.status() {
            if s.success() {
                return Some((exe.to_string(), false));
            }
        }
        if os == "darwin" {
            for c in ec::mac_extra_candidates() {
                if c.is_file() {
                    return Some((c.to_string_lossy().into_owned(), false));
                }
            }
        }
        None
    }

    /// Started if it is not running (one start at a time) → whether it runs now.
    pub fn ensure(&self) -> bool {
        let _one = match self.start_lock.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let up = self.lock().available;
        if up {
            return true;
        }
        self.start()
    }

    fn fail(&self, reason: String) -> bool {
        {
            let mut g = self.lock();
            g.available = false;
            g.reason = reason;
        }
        self.emit_state();
        false
    }

    fn start(&self) -> bool {
        let bin = match self.find_binary() {
            Some((b, bundled)) => {
                if bundled {
                    ensure_exec(Path::new(&b));
                }
                b
            }
            None => return self.fail(ec::missing_reason(util::node_platform()).to_string()),
        };
        let port = match free_port() {
            Ok(p) => p,
            Err(e) => return self.fail(e),
        };
        let secret = ec::random_hex(12);
        let _ = fs::create_dir_all(&self.default_dir);
        let _ = fs::create_dir_all(&self.data_dir);
        let session = self.data_dir.join("aria2.session");
        if !session.exists() {
            let _ = fs::write(&session, "");
        }
        let config = {
            let g = self.lock();
            engine_config(&g.config)
        };
        let paths = ec::StartPaths {
            default_dir: &self.default_dir,
            session_file: &session,
            data_dir: &self.data_dir,
        };
        let args = ec::start_args(&config, port, &secret, &paths, std::process::id());
        let mut cmd = Command::new(&bin);
        cmd.args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        no_window(&mut cmd);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return self.fail(format!("aria2c could not start: {}", e)),
        };
        let said = Arc::new(Mutex::new(String::new()));
        if let Some(err) = child.stderr.take() {
            let said2 = said.clone();
            thread::spawn(move || {
                for line in BufReader::new(err).lines() {
                    match line {
                        Ok(l) => {
                            let t = l.trim().to_string();
                            if !t.is_empty() {
                                eprintln!("[aria2c] {}", t);
                                if let Ok(mut s) = said2.lock() {
                                    *s = t;
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }
        {
            let mut g = self.lock();
            g.child = Some(child);
            g.port = port;
            g.secret = secret.clone();
            g.said = said;
            g.stopping = false;
        }
        // (Up to half a minute: on a first start Windows' antivirus may hold the new program that long.)
        let until = Instant::now() + Duration::from_secs(30);
        let mut up = false;
        while Instant::now() < until {
            let running = self.lock().child.is_some();
            if !running {
                break;
            }
            if call_at(port, &secret, "getVersion", vec![], Duration::from_secs(3)).is_ok() {
                up = true;
                break;
            }
            thread::sleep(Duration::from_millis(250));
        }
        if !up {
            {
                let mut g = self.lock();
                if let Some(mut c) = g.child.take() {
                    let _ = c.kill();
                    let _ = c.wait();
                    g.reason = "aria2c did not answer".to_string();
                } else {
                    let s = said_text(&g.said);
                    if !s.is_empty() && !g.reason.contains(&s) {
                        g.reason = format!("{}: {}", g.reason, s);
                    }
                }
                g.available = false;
            }
            self.emit_state();
            return false;
        }
        {
            let mut g = self.lock();
            g.available = true;
            g.reason = String::new();
        }
        self.emit_state();
        self.tick();
        true
    }

    /// aria2c gone by itself? Then marked so, the page told, and → Some(restart number) when it should be started
    /// again.
    fn reap(&self) -> Option<u32> {
        let (was, restart) = {
            let mut g = self.lock();
            let code: Option<String> = match g.child.as_mut() {
                Some(c) => match c.try_wait() {
                    Ok(Some(st)) => Some(match st.code() {
                        Some(n) => n.to_string(),
                        None => "null".to_string(),
                    }),
                    Ok(None) => None,
                    Err(_) => None,
                },
                None => None,
            };
            let code = code?;
            g.child = None;
            let was = g.available;
            g.available = false;
            let s = said_text(&g.said);
            g.reason = if s.is_empty() {
                format!("aria2c exited ({})", code)
            } else {
                format!("aria2c exited ({}): {}", code, s)
            };
            let mut restart: Option<u32> = None;
            if was && !g.stopping {
                g.restarts += 1;
                if g.restarts <= 3 {
                    restart = Some(g.restarts);
                }
            }
            (was, restart)
        };
        eprintln!("[aria2c] exited (was in use: {})", was);
        self.emit_state();
        restart
    }

    /// On the app's exit: the session saved, aria2c stopped (it also stops by itself: --stop-with-process).
    pub fn stop(&self) {
        let (port, secret) = {
            let mut g = self.lock();
            g.stopping = true;
            (g.port, g.secret.clone())
        };
        if port != 0 {
            let _ = call_at(port, &secret, "saveSession", vec![], Duration::from_secs(2));
        }
        let child = self.lock().child.take();
        if let Some(mut c) = child {
            let _ = c.kill();
            let _ = c.wait();
        }
        let mut g = self.lock();
        g.available = false;
    }

    pub fn call(&self, method: &str, params: Vec<Value>) -> Result<Value, String> {
        let (port, secret) = {
            let g = self.lock();
            (g.port, g.secret.clone())
        };
        if port == 0 {
            let r = self.lock().reason.clone();
            return Err(if r.is_empty() {
                "aria2c missing".to_string()
            } else {
                r
            });
        }
        call_at(port, &secret, method, params, Duration::from_secs(30))
    }

    fn must_run(&self) -> Result<(), String> {
        let g = self.lock();
        if g.available {
            Ok(())
        } else if g.reason.is_empty() {
            Err("aria2c missing".to_string())
        } else {
            Err(g.reason.clone())
        }
    }

    /* ---------- tasks ---------- */

    fn task_of(&self, v: &Value) -> Value {
        let st = status_of(v);
        let now = now_ms();
        let mut g = self.lock();
        let kept = g.keep.get(&st.gid).cloned();
        let mut ex = extra_of(kept.as_ref());
        if ex.added_at.unwrap_or(0) == 0 {
            let t = *g.first_seen.entry(st.gid.clone()).or_insert(now);
            ex.added_at = Some(t);
        }
        if st.status == "complete" && ex.done_at.unwrap_or(0) == 0 {
            let t = *g.done_seen.entry(st.gid.clone()).or_insert(now);
            ex.done_at = Some(t);
        }
        drop(g);
        task_value(&ec::task_core(&st, &ex, now), kept.as_ref())
    }

    /// kt:list: every download aria2 knows, newest first ([] while aria2c is not running).
    pub fn list(&self) -> Result<Value, String> {
        if !self.available() {
            return Ok(self.lock().last.clone());
        }
        let a = self.call("tellActive", vec![])?;
        let w = self.call("tellWaiting", vec![json!(0), json!(1000)])?;
        let s = self.call("tellStopped", vec![json!(0), json!(1000)])?;
        let mut raw: Vec<Value> = Vec::new();
        for part in [a, w, s] {
            if let Value::Array(xs) = part {
                raw.extend(xs);
            }
        }
        let now = now_ms();
        let mut kept_changed = false;
        {
            let mut g = self.lock();
            for v in raw.iter() {
                let st = status_of(v);
                if !ec::visible(&st) || st.status != "complete" {
                    continue;
                }
                if let Some(Value::Object(k)) = g.keep.get_mut(&st.gid) {
                    if !truthy(k.get("doneAt")) {
                        k.insert("doneAt".into(), json!(now));
                        kept_changed = true;
                    }
                }
            }
            // (A magnet's metadata step followed by the real download: what was kept goes to the follower.)
            for v in raw.iter() {
                let st = status_of(v);
                if st.followed_by.is_empty() {
                    continue;
                }
                let from = match g.keep.get(&st.gid) {
                    Some(k) => k.clone(),
                    None => continue,
                };
                for f in st.followed_by.iter() {
                    if !g.keep.contains_key(f) {
                        g.keep.insert(f.clone(), from.clone());
                        kept_changed = true;
                    }
                }
            }
            if kept_changed {
                let k = g.keep.clone();
                drop(g);
                self.save_keep(&k);
            }
        }
        let mut tasks: Vec<Value> = Vec::new();
        for v in raw.iter() {
            if ec::visible(&status_of(v)) {
                tasks.push(self.task_of(v));
            }
        }
        tasks.sort_by(|x, y| {
            let ax = x.get("addedAt").and_then(|t| t.as_i64()).unwrap_or(0);
            let ay = y.get("addedAt").and_then(|t| t.as_i64()).unwrap_or(0);
            ay.cmp(&ax)
        });
        let out = Value::Array(tasks);
        self.lock().last = out.clone();
        Ok(out)
    }

    /// The last list (kt:list when aria2c is down).
    pub fn last(&self) -> Value {
        self.lock().last.clone()
    }

    pub fn add(&self, o: &Value) -> Result<Value, String> {
        self.must_run()?;
        let empty = json!({});
        let source = match o.get("source") {
            Some(s) if s.is_object() => s,
            _ => &empty,
        };
        let has_url = truthy(source.get("url"));
        let headers: Option<Vec<(String, String)>> = match source.get("headers") {
            Some(Value::Object(h)) => {
                Some(h.iter().map(|(k, v)| (k.clone(), text(Some(v)))).collect())
            }
            _ => None,
        };
        let mut files: Vec<i64> = Vec::new();
        if let Some(Value::Array(xs)) = o.get("files") {
            for x in xs.iter() {
                files.push(int_of(Some(x)).unwrap_or(0));
            }
        }
        let a = ec::AddIn {
            dir: if truthy(o.get("dir")) {
                text(o.get("dir"))
            } else {
                String::new()
            },
            name: if truthy(o.get("name")) {
                text(o.get("name"))
            } else {
                String::new()
            },
            has_url,
            paused: truthy(o.get("paused")),
            connections: if truthy(o.get("connections")) {
                number(o.get("connections")).unwrap_or(0.0)
            } else {
                0.0
            },
            files,
            sequential: truthy(o.get("sequential")),
            headers,
            no_retry: truthy(o.get("meta").and_then(|m| m.get("noRetry"))),
        };
        // A file of that name there already, with «Skip» chosen: not downloaded again.
        let conflict = {
            let g = self.lock();
            text(g.config.get("net").and_then(|n| n.get("conflict")))
        };
        if conflict == "skip" && !a.name.is_empty() && has_url {
            let dir = if a.dir.is_empty() {
                self.default_dir.clone()
            } else {
                PathBuf::from(&a.dir)
            };
            if dir.join(&a.name).exists() {
                return Err("exists".to_string());
            }
        }
        let mut opts = Map::new();
        for (k, v) in ec::add_options(&a) {
            let val = match v {
                ec::OptVal::S(s) => Value::String(s),
                ec::OptVal::L(l) => json!(l),
            };
            opts.insert(k, val);
        }
        let opts = Value::Object(opts);
        let gid_v = if truthy(source.get("torrent")) {
            self.call(
                "addTorrent",
                vec![
                    source.get("torrent").cloned().unwrap_or(Value::Null),
                    json!([]),
                    opts,
                ],
            )?
        } else {
            let link = if truthy(source.get("magnet")) {
                text(source.get("magnet"))
            } else {
                text(source.get("url"))
            };
            self.call("addUri", vec![json!([link]), opts])?
        };
        let gid = text(Some(&gid_v));
        {
            let mut k = Map::new();
            if let Some(n) = o.get("name").filter(|x| !x.is_null()) {
                k.insert("name".into(), n.clone());
            }
            k.insert("source".into(), source.clone());
            k.insert("addedAt".into(), json!(now_ms()));
            if let Some(m) = o.get("meta").filter(|x| !x.is_null()) {
                k.insert("meta".into(), m.clone());
            }
            let mut g = self.lock();
            g.keep.insert(gid.clone(), Value::Object(k));
            let all = g.keep.clone();
            drop(g);
            self.save_keep(&all);
        }
        let st = self.call("tellStatus", vec![json!(gid)])?;
        self.tick();
        Ok(self.task_of(&st))
    }

    /// kt:move: a place in aria2's waiting queue (only what waits has one).
    pub fn move_task(&self, id: &str, how: i64) -> Result<(), String> {
        let (pos, mode) = ec::move_args(how);
        self.call("changePosition", vec![json!(id), json!(pos), json!(mode)])?;
        self.tick();
        Ok(())
    }

    /// kt:setUrl: a new address for a download whose link ran out — the same file, gone on from where it stopped.
    pub fn set_url(&self, id: &str, url: &str) -> Result<String, String> {
        let stv = self.call("tellStatus", vec![json!(id)])?;
        let st = status_of(&stv);
        if st.bittorrent {
            return Err("not a file download".to_string());
        }
        if matches!(st.status.as_str(), "active" | "waiting" | "paused") {
            let mut old: Vec<String> = Vec::new();
            if let Some(f) = st.files.first() {
                for u in f.uris.iter() {
                    if !old.contains(u) {
                        old.push(u.clone());
                    }
                }
            }
            self.call(
                "changeUri",
                vec![json!(id), json!(1), json!(old), json!([url])],
            )?;
            if st.status == "paused" {
                let _ = self.call("unpause", vec![json!(id)]);
            }
            {
                let mut g = self.lock();
                let mut k = match g.keep.get(id) {
                    Some(Value::Object(m)) => m.clone(),
                    _ => Map::new(),
                };
                let mut src = match k.get("source") {
                    Some(Value::Object(m)) => m.clone(),
                    _ => Map::new(),
                };
                src.insert("url".into(), json!(url));
                k.insert("source".into(), Value::Object(src));
                g.keep.insert(id.to_string(), Value::Object(k));
                let all = g.keep.clone();
                drop(g);
                self.save_keep(&all);
            }
            self.tick();
            return Ok(id.to_string());
        }
        // (Stopped with an error: added again over the same file, which aria2 continues.)
        let f = st.files.first().map(|x| x.path.clone()).unwrap_or_default();
        let k: Map<String, Value> = match self.lock().keep.get(id) {
            Some(Value::Object(m)) => m.clone(),
            _ => Map::new(),
        };
        let mut opts = Map::new();
        opts.insert("dir".into(), json!(st.dir));
        opts.insert("continue".into(), json!("true"));
        if !f.is_empty() {
            opts.insert("out".into(), json!(ec::base_name(&f)));
        }
        if let Some(Value::Object(h)) = k.get("source").and_then(|s| s.get("headers")) {
            let pairs: Vec<(String, String)> =
                h.iter().map(|(a, b)| (a.clone(), text(Some(b)))).collect();
            opts.insert("header".into(), json!(ec::header_lines(&pairs)));
        }
        let gid_v = self.call("addUri", vec![json!([url]), Value::Object(opts)])?;
        let gid = text(Some(&gid_v));
        let _ = self.call("removeDownloadResult", vec![json!(id)]);
        {
            let mut nk = k.clone();
            let mut src = match k.get("source") {
                Some(Value::Object(m)) => m.clone(),
                _ => Map::new(),
            };
            src.insert("url".into(), json!(url));
            nk.insert("source".into(), Value::Object(src));
            let mut g = self.lock();
            g.keep.insert(gid.clone(), Value::Object(nk));
            g.keep.remove(id);
            let all = g.keep.clone();
            drop(g);
            self.save_keep(&all);
        }
        self.tick();
        Ok(gid)
    }

    pub fn pause(&self, id: &str) -> Result<(), String> {
        self.call("pause", vec![json!(id)])?;
        self.tick();
        Ok(())
    }

    pub fn resume(&self, id: &str) -> Result<(), String> {
        self.call("unpause", vec![json!(id)])?;
        self.tick();
        Ok(())
    }

    pub fn remove(&self, id: &str, delete_files: bool) -> Result<(), String> {
        let st: Option<ec::Status> = self
            .call("tellStatus", vec![json!(id)])
            .ok()
            .map(|v| status_of(&v));
        if let Some(s) = &st {
            if matches!(s.status.as_str(), "active" | "waiting" | "paused") {
                let _ = self.call("forceRemove", vec![json!(id)]);
                // (forceRemove takes a moment: its result is there to be removed, its files let go, once it says
                // «removed» — up to a few seconds.)
                let until = Instant::now() + Duration::from_secs(3);
                while Instant::now() < until {
                    match self.call("tellStatus", vec![json!(id)]) {
                        Ok(v) => {
                            if text(v.get("status")) == "removed" {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }
        let _ = self.call("removeDownloadResult", vec![json!(id)]);
        if delete_files {
            if let Some(s) = &st {
                for f in s.files.iter() {
                    if f.path.is_empty() {
                        continue;
                    }
                    let p = Path::new(&f.path);
                    if p.exists() {
                        let _ = fs::remove_file(p);
                    }
                    let a = PathBuf::from(format!("{}.aria2", f.path));
                    if a.exists() {
                        let _ = fs::remove_file(&a);
                    }
                }
            }
        }
        {
            let mut g = self.lock();
            g.keep.remove(id);
            let all = g.keep.clone();
            drop(g);
            self.save_keep(&all);
        }
        self.tick();
        Ok(())
    }

    pub fn set_files(&self, id: &str, priorities: &[i64]) -> Result<(), String> {
        let sel = ec::select_files(priorities);
        self.call(
            "changeOption",
            vec![json!(id), json!({ "select-file": sel })],
        )?;
        self.tick();
        Ok(())
    }

    pub fn set_limits(&self, l: &Value) -> Result<(), String> {
        let o = json!({
            "max-overall-download-limit": limit_text(l.get("down").filter(|v| truthy(Some(*v)))),
            "max-overall-upload-limit": limit_text(l.get("up").filter(|v| truthy(Some(*v)))),
        });
        self.call("changeGlobalOption", vec![o])?;
        Ok(())
    }

    pub fn configure(&self, o: &Value) -> Result<(), String> {
        let config = {
            let mut g = self.lock();
            if let Value::Object(m) = o {
                for (k, v) in m.iter() {
                    g.config[k.as_str()] = v.clone();
                }
            }
            g.config.clone()
        };
        let _ = fs::write(self.data_dir.join("aria2-config.json"), config.to_string());
        if truthy(o.get("net")) {
            let net = ec::net_options(&net_config(o.get("net")));
            let _ = self.call("changeGlobalOption", vec![opts_value(&net)]);
        }
        if truthy(o.get("maxConnections")) {
            let n = number(o.get("maxConnections")).unwrap_or(1.0).max(1.0);
            let _ = self.call(
                "changeGlobalOption",
                vec![json!({ "max-concurrent-downloads": ec::js_num(n) })],
            );
        }
        let seed_key = |k: &str| matches!(o.get(k), Some(v) if !v.is_null());
        if seed_key("seed") || seed_key("seedRatio") || seed_key("seedMinutes") {
            let so = ec::seed_options(&engine_config(&config));
            let _ = self.call("changeGlobalOption", vec![opts_value(&so)]);
        }
        Ok(())
    }

    /// kt:torrentInfo: a torrent's name and files, from its file or its magnet (the metadata fetched alone).
    pub fn torrent_info(&self, source: &Value) -> Result<Value, String> {
        let gid_v = if truthy(source.get("torrent")) {
            self.call(
                "addTorrent",
                vec![
                    source.get("torrent").cloned().unwrap_or(Value::Null),
                    json!([]),
                    json!({ "pause": "true" }),
                ],
            )?
        } else {
            self.call(
                "addUri",
                vec![
                    json!([text(source.get("magnet"))]),
                    json!({ "bt-metadata-only": "true", "bt-save-metadata": "false" }),
                ],
            )?
        };
        let gid = text(Some(&gid_v));
        let r = self.torrent_info_wait(&gid);
        let _ = self.call("forceRemove", vec![json!(gid)]);
        let _ = self.call("removeDownloadResult", vec![json!(gid)]);
        r
    }

    fn torrent_info_wait(&self, gid: &str) -> Result<Value, String> {
        let until = Instant::now() + Duration::from_secs(60);
        loop {
            let v = self.call("tellStatus", vec![json!(gid)])?;
            let st = status_of(&v);
            let total = ec::num(&st.total_length);
            if let Some(name) = st.bt_name.clone().filter(|n| !n.is_empty()) {
                if total > 0 {
                    let dir = st.dir.trim_end_matches(['/', '\\']).to_string();
                    let files: Vec<Value> = st
                        .files
                        .iter()
                        .map(|f| {
                            json!({
                                "index": f.index.trim().parse::<i64>().unwrap_or(0) - 1,
                                "path": ec::rel_path(&f.path, &dir),
                                "size": ec::num(&f.length),
                            })
                        })
                        .collect();
                    return Ok(json!({
                        "name": name,
                        "infoHash": st.info_hash.clone().unwrap_or_default(),
                        "total": total,
                        "files": files,
                    }));
                }
            }
            if st.status == "error" {
                let m = st.error_message.clone().unwrap_or_default();
                return Err(if m.is_empty() { "aria2".to_string() } else { m });
            }
            if Instant::now() > until {
                return Err("timeout".to_string());
            }
            thread::sleep(Duration::from_millis(700));
        }
    }

    /// The path of a task's file (the renamed one if it was), or its folder.
    pub fn file_of(&self, id: &str, file_index: i64) -> Result<String, String> {
        let v = self.call("tellStatus", vec![json!(id)])?;
        let st = status_of(&v);
        let i = file_index.max(0) as usize;
        let renamed = {
            let g = self.lock();
            g.keep
                .get(id)
                .and_then(|k| k.get("renamed"))
                .and_then(|r| r.as_str())
                .map(|s| s.to_string())
        };
        if i == 0 {
            if let Some(r) = renamed {
                if Path::new(&r).exists() {
                    return Ok(r);
                }
            }
        }
        match st.files.get(i) {
            Some(f) => Ok(f.path.clone()),
            None => Ok(st.dir),
        }
    }

    /// kt:rename: a finished download renamed on disk (its extension included) and in the list.
    pub fn rename(&self, id: &str, name: &str) -> Result<String, String> {
        let nm = ec::clean_name(name).ok_or_else(|| "badName".to_string())?;
        let v = self.call("tellStatus", vec![json!(id)])?;
        let st = status_of(&v);
        if st.status != "complete" {
            return Err("notDone".to_string());
        }
        let mut k: Map<String, Value> = match self.lock().keep.get(id) {
            Some(Value::Object(m)) => m.clone(),
            _ => Map::new(),
        };
        let renamed = k
            .get("renamed")
            .and_then(|r| r.as_str())
            .map(|s| s.to_string())
            .filter(|r| Path::new(r).exists());
        let cur: Option<String> = match renamed {
            Some(r) => Some(r),
            None => st
                .files
                .first()
                .map(|f| f.path.clone())
                .filter(|p| !p.is_empty()),
        };
        let cur = match cur {
            Some(c) if Path::new(&c).exists() => c,
            _ => {
                k.insert("name".into(), json!(nm));
                self.put_keep(id, k);
                return Ok(nm);
            }
        };
        if st.bittorrent && st.files.len() > 1 {
            let first_rel = ec::rel_path(&st.files[0].path, &st.dir);
            let top_name = first_rel
                .split(['/', '\\'])
                .next()
                .unwrap_or("")
                .to_string();
            let top = Path::new(&st.dir).join(top_name);
            let parent = top.parent().map(|p| p.to_path_buf()).unwrap_or_default();
            let to = parent.join(&nm);
            if to.exists() {
                return Err("exists".to_string());
            }
            fs::rename(&top, &to).map_err(|e| e.to_string())?;
            k.insert("name".into(), json!(nm));
            self.put_keep(id, k);
            return Ok(nm);
        }
        let cur_p = PathBuf::from(&cur);
        let parent = cur_p.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        let to = parent.join(&nm);
        if to.exists() && to != cur_p {
            return Err("exists".to_string());
        }
        fs::rename(&cur_p, &to).map_err(|e| e.to_string())?;
        k.insert("renamed".into(), json!(to.to_string_lossy().into_owned()));
        k.insert("name".into(), json!(nm));
        self.put_keep(id, k);
        Ok(nm)
    }

    fn put_keep(&self, id: &str, k: Map<String, Value>) {
        let mut g = self.lock();
        g.keep.insert(id.to_string(), Value::Object(k));
        let all = g.keep.clone();
        drop(g);
        self.save_keep(&all);
        self.tick();
    }
}

fn said_text(s: &Arc<Mutex<String>>) -> String {
    match s.lock() {
        Ok(g) => g.clone(),
        Err(_) => String::new(),
    }
}

/// One JSON-RPC call to aria2c at `port`.
fn call_at(
    port: u16,
    secret: &str,
    method: &str,
    params: Vec<Value>,
    timeout: Duration,
) -> Result<Value, String> {
    let mut all: Vec<Value> = Vec::with_capacity(params.len() + 1);
    if !secret.is_empty() {
        all.push(Value::String(format!("token:{}", secret)));
    }
    all.extend(params);
    let id = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let body = json!({
        "jsonrpc": "2.0",
        "id": id.to_string(),
        "method": format!("aria2.{}", method),
        "params": all,
    });
    let (_status, text_body) = rpc::post(port, "/jsonrpc", &body.to_string(), timeout)?;
    let v: Value = serde_json::from_str(&text_body).map_err(|e| format!("aria2: {}", e))?;
    if let Some(err) = v.get("error") {
        if !err.is_null() {
            let m = err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("aria2 error")
                .to_string();
            return Err(m);
        }
    }
    Ok(v.get("result").cloned().unwrap_or(Value::Null))
}
