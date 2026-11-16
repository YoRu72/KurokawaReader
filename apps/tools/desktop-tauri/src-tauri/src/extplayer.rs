// Another program as the player (desktop/extplayer.cjs and desktop/relay.cjs's twin; the page's side is
// src/player/external): which known players are on this computer, the chosen one started with its arguments (no
// shell: each argument one item), whether it still runs, and for mpv where it is — its JSON IPC observed
// (time-pos, duration, eof-reached), mpv telling each change. And the relay: a session per playback on the stream
// server (/<token>/r/<session>/…), closed when the playback ends; the plain logic is relaylogic.rs.
// Compiled in CI only (tauri, reqwest); kept thin.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use kt_core::streamlogic as sl;
use kurokawa_shell::{net, reqwest};

use crate::relaylogic::{self as rl, Ask, MpvNote, Session, Sub};
use crate::streamserver::{self, simple, write_head};

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const IDLE: Duration = Duration::from_secs(6 * 3600);

/* ---------- the relay ---------- */
struct Live {
    s: Session,
    last: Instant,
    gone: Arc<AtomicBool>,
}
fn sessions() -> &'static Mutex<HashMap<String, Live>> {
    static S: OnceLock<Mutex<HashMap<String, Live>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}
fn pairs(v: Option<&Value>) -> Vec<(String, String)> {
    match v {
        Some(Value::Object(m)) => m.iter().map(|(k, v)| (k.clone(), v.as_str().map(|s| s.to_string()).unwrap_or_else(|| v.to_string()))).collect(),
        _ => Vec::new(),
    }
}
fn name_part(n: &str, d: &str) -> String {
    let n = if n.is_empty() { d } else { n };
    let n: String = n.replace(['/', '\\'], "_").chars().take(100).collect();
    sl::encode_component(&n)
}

/// kt:relayOpen({ url, headers, subs: [{ url | path, name, headers }], name }) → { token, url, subs }.
#[tauri::command]
pub async fn kt_relay_open(o: Value) -> Result<Value, String> {
    let (port, token) = streamserver::ensure()?;
    let id = sl::new_token();
    let id: String = id.chars().filter(|c| c.is_ascii_hexdigit()).take(32).collect();
    let id = if id.len() == 32 { id } else { format!("{:0>32}", id) };
    let url = o.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let subs: Vec<Sub> = o.get("subs").and_then(|v| v.as_array()).cloned().unwrap_or_default().iter().map(|x| Sub {
        url: x.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        path: x.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        name: x.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        headers: pairs(x.get("headers")),
    }).collect();
    let at = format!("http://127.0.0.1:{}/{}/r/{}", port, token, id);
    let name = o.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let sub_urls: Vec<String> = subs.iter().enumerate().map(|(i, s)| {
        let base = if !s.name.is_empty() { s.name.clone() } else { Path::new(&s.path).file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default() };
        format!("{}/s/{}/{}", at, i, name_part(&base, &format!("sub{}.srt", i)))
    }).collect();
    let main = if url.is_empty() { String::new() } else { format!("{}/v/{}", at, name_part(name, "video")) };
    let live = Live { s: Session::new(url, pairs(o.get("headers")), subs), last: Instant::now(), gone: Arc::new(AtomicBool::new(false)) };
    if let Ok(mut m) = sessions().lock() {
        m.retain(|_, l| l.last.elapsed() < IDLE);
        m.insert(id.clone(), live);
    }
    Ok(json!({ "token": id, "url": main, "subs": sub_urls }))
}

/// kt:relayClose({ token }) → { closed }: the session's addresses answer 403 from now on; reads under way stop.
#[tauri::command]
pub async fn kt_relay_close(o: Value) -> Result<Value, String> {
    let t = o.get("token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let gone = sessions().lock().ok().and_then(|mut m| m.remove(&t));
    if let Some(l) = &gone {
        l.gone.store(true, Ordering::SeqCst);
    }
    Ok(json!({ "closed": gone.is_some() }))
}

/// Called by streamserver::handle for /<token>/r/…: true when it was a relay address (answered here).
pub fn serve(s: &mut TcpStream, path: &str, token: &str, req: &sl::Head, head_only: bool, stop: &Arc<AtomicBool>) -> bool {
    let (tok, id, ask) = match rl::parse(path) {
        Some(x) => x,
        None => return false,
    };
    if !sl::same_token(&sl::decode_component(&tok, false), token) {
        simple(s, 403, "");
        return true;
    }
    let port = streamserver::ensure().map(|(p, _)| p).unwrap_or(0);
    let at = format!("http://127.0.0.1:{}/{}/r/{}", port, token, id);
    // (What to fetch, read under the lock and let go of it before any network.)
    let (target, headers, gone, is_sub) = {
        let mut m = match sessions().lock() {
            Ok(m) => m,
            Err(_) => {
                simple(s, 500, "");
                return true;
            }
        };
        let l = match m.get_mut(&id) {
            Some(l) => l,
            None => {
                simple(s, 403, "closed");
                return true;
            }
        };
        l.last = Instant::now();
        match ask {
            Ask::Video => (l.s.url.clone(), l.s.headers.clone(), l.gone.clone(), false),
            Ask::Url(n) => (l.s.urls.get(n).cloned().unwrap_or_default(), l.s.headers.clone(), l.gone.clone(), false),
            Ask::Sub(i) => match l.s.subs.get(i) {
                Some(sub) if !sub.path.is_empty() => {
                    let p = sub.path.clone();
                    drop(m);
                    match std::fs::read(&p) {
                        Ok(b) => {
                            let h = vec![("Content-Type".to_string(), "text/plain; charset=utf-8".to_string()), ("Content-Length".to_string(), b.len().to_string())];
                            if write_head(s, 200, h).is_ok() && !head_only {
                                let _ = s.write_all(&b);
                            }
                        }
                        Err(_) => simple(s, 404, ""),
                    }
                    return true;
                }
                Some(sub) => {
                    let mut h = l.s.headers.clone();
                    h.extend(sub.headers.iter().cloned());
                    (sub.url.clone(), h, l.gone.clone(), true)
                }
                None => (String::new(), vec![], l.gone.clone(), true),
            },
        }
    };
    if target.is_empty() {
        simple(s, 404, "");
        return true;
    }
    let client = match net::client() {
        Ok(c) => c,
        Err(e) => {
            simple(s, 502, &e);
            return true;
        }
    };
    let range = if rl::is_playlist("", &target) { None } else { req.header("range") };
    let mut rb = client.request(if head_only { reqwest::Method::HEAD } else { reqwest::Method::GET }, target.as_str());
    for (k, v) in rl::fetch_headers(&headers, range, UA) {
        if reqwest::header::HeaderName::from_bytes(k.as_bytes()).is_ok() && reqwest::header::HeaderValue::from_str(&v).is_ok() {
            rb = rb.header(k.as_str(), v.as_str());
        }
    }
    let mut resp = match tauri::async_runtime::block_on(rb.send()) {
        Ok(r) => r,
        Err(e) => {
            simple(s, 502, &e.to_string());
            return true;
        }
    };
    let ctype = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let final_url = resp.url().to_string();
    if !is_sub && resp.status().as_u16() < 400 && rl::is_playlist(&ctype, &final_url) {
        let text = if head_only { String::new() } else { tauri::async_runtime::block_on(resp.text()).unwrap_or_default() };
        let body = match sessions().lock() {
            Ok(mut m) => match m.get_mut(&id) {
                Some(l) => rl::rewrite(&text, &final_url, &at, &mut l.s),
                None => {
                    simple(s, 403, "closed");
                    return true;
                }
            },
            Err(_) => String::new(),
        };
        let h = vec![("Content-Type".to_string(), "application/vnd.apple.mpegurl".to_string()), ("Content-Length".to_string(), body.len().to_string()), ("Cache-Control".to_string(), "no-store".to_string())];
        if write_head(s, 200, h).is_ok() && !head_only {
            let _ = s.write_all(body.as_bytes());
        }
        return true;
    }
    let mut pass: Vec<(String, String)> = Vec::new();
    for k in sl::PASS_HEADERS.iter() {
        if let Some(v) = resp.headers().get(*k).and_then(|v| v.to_str().ok()) {
            pass.push((k.to_string(), v.to_string()));
        }
    }
    if write_head(s, resp.status().as_u16(), pass).is_err() || head_only {
        return true;
    }
    while !stop.load(Ordering::SeqCst) && !gone.load(Ordering::SeqCst) {
        match tauri::async_runtime::block_on(resp.chunk()) {
            Ok(Some(b)) => {
                if s.write_all(&b).is_err() {
                    break;
                }
            }
            _ => break,
        }
    }
    true
}

/* ---------- the players ---------- */
struct Proc {
    child: Option<Child>,
    running: Arc<AtomicBool>,
    code: Arc<Mutex<Option<i32>>>,
    pos: Arc<Mutex<Option<f64>>>,
    dur: Arc<Mutex<Option<f64>>>,
    eof: Arc<AtomicBool>,
    ipc: String,
}
fn procs() -> &'static Mutex<HashMap<String, Proc>> {
    static P: OnceLock<Mutex<HashMap<String, Proc>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}
static SEQ: AtomicU64 = AtomicU64::new(0);

/// %VAR% from the environment; a bare name on the PATH (with PATHEXT on Windows).
fn resolve(p: &str) -> Option<PathBuf> {
    let mut x = String::new();
    let mut rest = p;
    while let Some(i) = rest.find('%') {
        x.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let j = after.find('%')?;
        x.push_str(&std::env::var(&after[..j]).ok()?);
        rest = &after[j + 1..];
    }
    x.push_str(rest);
    if x.is_empty() {
        return None;
    }
    let pb = PathBuf::from(&x);
    if pb.is_absolute() {
        return if pb.is_file() { Some(pb) } else { None };
    }
    if x.contains('/') || x.contains('\\') {
        return None;
    }
    let exts: Vec<String> = if cfg!(windows) {
        let mut v = vec![String::new()];
        v.extend(std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".into()).split(';').map(|e| e.to_ascii_lowercase()));
        v
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        for e in &exts {
            let f = if x.to_ascii_lowercase().ends_with(e.as_str()) { dir.join(&x) } else { dir.join(format!("{}{}", x, e)) };
            if f.is_file() {
                return Some(f);
            }
        }
    }
    None
}

/// kt:extPlayers({ cands: [{ id, paths }] }) → { found: [{ id, path }] }.
#[tauri::command]
pub async fn kt_ext_players(o: Value) -> Result<Value, String> {
    let mut found = Vec::new();
    for c in o.get("cands").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        for p in c.get("paths").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
            if let Some(r) = p.as_str().and_then(resolve) {
                found.push(json!({ "id": id, "path": r.to_string_lossy() }));
                break;
            }
        }
    }
    Ok(json!({ "found": found }))
}

/// kt:extPlayerStart({ exe, args, ipc }) → { id }; «${ipc}» in an argument becomes mpv's socket.
#[tauri::command]
pub async fn kt_ext_player_start(o: Value) -> Result<Value, String> {
    let exe = o.get("exe").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let exe_path = resolve(&exe).unwrap_or_else(|| PathBuf::from(&exe));
    if exe.is_empty() {
        return Err("no program".into());
    }
    let want_ipc = o.get("ipc").and_then(|v| v.as_bool()).unwrap_or(false);
    let rnd: String = sl::new_token().chars().take(12).collect();
    let ipc = if !want_ipc {
        String::new()
    } else if cfg!(windows) {
        format!(r"\\.\pipe\kt-mpv-{}", rnd)
    } else {
        std::env::temp_dir().join(format!("kt-mpv-{}.sock", rnd)).to_string_lossy().to_string()
    };
    let args: Vec<String> = o.get("args").and_then(|v| v.as_array()).cloned().unwrap_or_default().iter().map(|a| a.as_str().unwrap_or("").replace("${ipc}", &ipc)).collect();
    let child = Command::new(&exe_path).args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    let id = (SEQ.fetch_add(1, Ordering::SeqCst) + 1).to_string();
    let p = Proc { child: Some(child), running: Arc::new(AtomicBool::new(true)), code: Arc::new(Mutex::new(None)), pos: Arc::new(Mutex::new(None)), dur: Arc::new(Mutex::new(None)), eof: Arc::new(AtomicBool::new(false)), ipc: ipc.clone() };
    if !ipc.is_empty() {
        let (running, pos, dur, eof) = (p.running.clone(), p.pos.clone(), p.dur.clone(), p.eof.clone());
        thread::spawn(move || observe(&ipc, running, pos, dur, eof));
    }
    procs().lock().map_err(|e| e.to_string())?.insert(id.clone(), p);
    Ok(json!({ "id": id }))
}
/// mpv's socket, tried for ten seconds after the start; then each line it writes read as it comes.
fn observe(ipc: &str, running: Arc<AtomicBool>, pos: Arc<Mutex<Option<f64>>>, dur: Arc<Mutex<Option<f64>>>, eof: Arc<AtomicBool>) {
    let open = || -> Option<(Box<dyn std::io::Read + Send>, Box<dyn Write + Send>)> {
        #[cfg(unix)]
        {
            let s = std::os::unix::net::UnixStream::connect(ipc).ok()?;
            let r = s.try_clone().ok()?;
            Some((Box::new(r), Box::new(s)))
        }
        #[cfg(windows)]
        {
            let f = std::fs::OpenOptions::new().read(true).write(true).open(ipc).ok()?;
            let r = f.try_clone().ok()?;
            Some((Box::new(r), Box::new(f)))
        }
    };
    let mut got = None;
    for _ in 0..40 {
        if !running.load(Ordering::SeqCst) {
            return;
        }
        if let Some(x) = open() {
            got = Some(x);
            break;
        }
        thread::sleep(Duration::from_millis(250));
    }
    let (r, mut w) = match got {
        Some(x) => x,
        None => return,
    };
    for (i, p) in [(1, "time-pos"), (2, "duration"), (3, "eof-reached")] {
        let _ = w.write_all(format!("{{\"command\":[\"observe_property\",{},\"{}\"]}}\n", i, p).as_bytes());
    }
    for line in BufReader::new(r).lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        match rl::mpv_line(&line) {
            Some(MpvNote::Pos(x)) => {
                if let Ok(mut g) = pos.lock() {
                    *g = Some(x);
                }
            }
            Some(MpvNote::Dur(x)) => {
                if let Ok(mut g) = dur.lock() {
                    *g = Some(x);
                }
            }
            Some(MpvNote::Eof) => eof.store(true, Ordering::SeqCst),
            None => {}
        }
    }
}

/// kt:extPlayerStatus({ id }) → { running, code, pos, dur, eof }; the record dropped once it is seen ended.
#[tauri::command]
pub async fn kt_ext_player_status(o: Value) -> Result<Value, String> {
    let id = o.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut m = procs().lock().map_err(|e| e.to_string())?;
    let p = match m.get_mut(&id) {
        Some(p) => p,
        None => return Ok(json!({ "running": false, "code": null, "pos": null, "dur": null, "eof": false, "error": "unknown" })),
    };
    if let Some(c) = p.child.as_mut() {
        if let Ok(Some(st)) = c.try_wait() {
            p.running.store(false, Ordering::SeqCst);
            if let Ok(mut g) = p.code.lock() {
                *g = st.code();
            }
            p.child = None;
            if !p.ipc.is_empty() && !cfg!(windows) {
                let _ = std::fs::remove_file(&p.ipc);
            }
        }
    }
    let running = p.running.load(Ordering::SeqCst);
    let r = json!({ "running": running, "code": *p.code.lock().unwrap_or_else(|e| e.into_inner()), "pos": *p.pos.lock().unwrap_or_else(|e| e.into_inner()), "dur": *p.dur.lock().unwrap_or_else(|e| e.into_inner()), "eof": p.eof.load(Ordering::SeqCst) });
    if !running {
        m.remove(&id);
    }
    Ok(r)
}

/// kt:extPlayerStop({ id }): the program ended.
#[tauri::command]
pub async fn kt_ext_player_stop(o: Value) -> Result<Value, String> {
    let id = o.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut m = procs().lock().map_err(|e| e.to_string())?;
    let ok = match m.get_mut(&id).and_then(|p| p.child.as_mut()) {
        Some(c) => c.kill().is_ok(),
        None => false,
    };
    Ok(json!({ "ok": ok }))
}
