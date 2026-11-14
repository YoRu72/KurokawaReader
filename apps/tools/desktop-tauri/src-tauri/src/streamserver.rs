// The local stream server (stage P4): what desktop/torrentstream.cjs, webstream.cjs and streamproxy.cjs serve the
// page's player on 127.0.0.1, in one std server — loopback only, a port the system picks, every address carrying this
// run's random token (a wrong one: 403), and a torrent file's address its own session token too, withdrawn by
// kt:streamDone. Ranges (200 / 206 / 416, HEAD) by kt-core's streamlogic.rs; a thread per connection (at most 64 at
// once, more get 503); the answer written as the player takes it (a blocking socket with a write timeout: back-pressure,
// and a reader that stalls for a minute is let go); `Connection: close` on every answer; CORS open, as Electron's
// servers (the page fetches subtitles and HEADs from here). Routes:
//   /<token>/t/<session>/<name>  a file of a torrent being watched, its pieces waited for (stream_engine.rs)
//   /<token>/f?p=<path>          a file on this computer (kt:fileUrl) — subtitles beside a video the same way
//   /<token>/audio?src&ss&a      one audio track as AAC (kt:audioUrl; ffmpeg — streamproxy.rs)
//   /<token>/video?src&ss&a&c    the picture converted as it plays (kt:videoUrl; ffmpeg)
//   /<token>/p?u&h               an online source with its headers, HLS remuxed to MP4 (kt:proxyUrl)
// Stopped when the app quits (main.rs) — the port and every file let go.
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use kt_core::engine_core as ec;
use kt_core::streamlogic as sl;

use crate::stream_engine::{self as se, Aria2Stream, Source, StreamEngine};
use crate::streamproxy;

const MAX_CONNS: usize = 64;
const CHUNK: usize = 256 * 1024;
const HEAD_MAX: usize = 16 * 1024;

struct Server {
    port: u16,
    token: String,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

/// A file of a download being watched, under its session token.
pub struct Session {
    pub id: String,
    pub index: usize,
    // (Kept with the session for the log; nothing reads it yet — CI's only warning on this file.)
    #[allow(dead_code)]
    pub name: String,
    pub engine: Arc<dyn StreamEngine>,
    pub cancelled: Arc<AtomicBool>,
}

static SERVER: Mutex<Option<Server>> = Mutex::new(None);
static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
static ARIA2: OnceLock<Arc<Aria2Stream>> = OnceLock::new();
/// Connections being answered now (the self-test checks they all end).
static LIVE: AtomicUsize = AtomicUsize::new(0);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

fn sessions() -> MutexGuard<'static, HashMap<String, Arc<Session>>> {
    lock(SESSIONS.get_or_init(|| Mutex::new(HashMap::new())))
}

pub fn aria2() -> Arc<dyn StreamEngine> {
    ARIA2.get_or_init(|| Arc::new(Aria2Stream::new())).clone()
}

pub fn live() -> usize {
    LIVE.load(Ordering::SeqCst)
}

struct LiveGuard;
impl Drop for LiveGuard {
    fn drop(&mut self) {
        LIVE.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The server running (started if it is not) → (port, token).
pub fn ensure() -> Result<(u16, String), String> {
    let mut g = lock(&SERVER);
    if let Some(s) = g.as_ref() {
        return Ok((s.port, s.token.clone()));
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("stream server: {}", e))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = sl::new_token();
    let stop = Arc::new(AtomicBool::new(false));
    let (stop2, token2) = (stop.clone(), token.clone());
    let thread = thread::Builder::new()
        .name("kt-stream-server".into())
        .spawn(move || accept_loop(listener, token2, stop2))
        .map_err(|e| e.to_string())?;
    *g = Some(Server { port, token: token.clone(), stop, thread: Some(thread) });
    Ok((port, token))
}

fn accept_loop(listener: TcpListener, token: String, stop: Arc<AtomicBool>) {
    for conn in listener.incoming() {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let mut s = match conn {
            Ok(s) => s,
            Err(_) => {
                thread::sleep(Duration::from_millis(20));
                continue;
            }
        };
        if LIVE.load(Ordering::SeqCst) >= MAX_CONNS {
            let _ = write_head(&mut s, 503, vec![("Content-Length".into(), "0".into())]);
            continue;
        }
        LIVE.fetch_add(1, Ordering::SeqCst);
        let (t, st) = (token.clone(), stop.clone());
        let spawned = thread::Builder::new().name("kt-stream-conn".into()).spawn(move || {
            let _g = LiveGuard;
            handle(s, &t, &st);
        });
        if spawned.is_err() {
            LIVE.fetch_sub(1, Ordering::SeqCst);
        }
    }
    // (The listener dropped here: the port is free.)
}

/// The server stopped: no new connection, every reader told to end, the sessions withdrawn; waits (3 s at most) for
/// the connections to end, so the files they read are let go → whether they all ended.
pub fn stop() -> bool {
    let srv = lock(&SERVER).take();
    if let Some(mut s) = srv {
        s.stop.store(true, Ordering::SeqCst);
        let addr = SocketAddr::from(([127u8, 0, 0, 1], s.port));
        let _ = TcpStream::connect_timeout(&addr, Duration::from_secs(1));
        if let Some(t) = s.thread.take() {
            let _ = t.join();
        }
    }
    let all: Vec<Arc<Session>> = sessions().drain().map(|(_, v)| v).collect();
    for x in all.iter() {
        x.cancelled.store(true, Ordering::SeqCst);
    }
    let until = Instant::now() + Duration::from_secs(3);
    while live() > 0 && Instant::now() < until {
        thread::sleep(Duration::from_millis(20));
    }
    live() == 0
}

/// The port the server listens on now (None when stopped).
pub fn port() -> Option<u16> {
    lock(&SERVER).as_ref().map(|s| s.port)
}

/* ---------- answers ---------- */

/// Every answer's own headers: CORS open (as Electron's), one request per connection.
fn common() -> Vec<(String, String)> {
    vec![
        ("Access-Control-Allow-Origin".into(), "*".into()),
        ("Access-Control-Expose-Headers".into(), "Content-Range, Content-Length, Accept-Ranges, Content-Type".into()),
        ("Connection".into(), "close".into()),
    ]
}

pub fn write_head(s: &mut TcpStream, code: u16, mut headers: Vec<(String, String)>) -> std::io::Result<()> {
    headers.extend(common());
    s.write_all(sl::head_text(code, &headers).as_bytes())
}

/// An answer with a short text body (or none).
pub fn simple(s: &mut TcpStream, code: u16, body: &str) {
    let mut h = vec![("Content-Length".to_string(), body.len().to_string())];
    if !body.is_empty() {
        h.push(("Content-Type".into(), "text/plain; charset=utf-8".into()));
    }
    if write_head(s, code, h).is_ok() && !body.is_empty() {
        let _ = s.write_all(body.as_bytes());
    }
}

/// Whether the reader closed its end (looked at without waiting; the socket is blocking again after).
pub fn peer_gone(s: &TcpStream) -> bool {
    if s.set_nonblocking(true).is_err() {
        return true;
    }
    let mut b = [0u8; 1];
    let r = s.peek(&mut b);
    let _ = s.set_nonblocking(false);
    match r {
        Ok(0) => true,
        Ok(_) => false,
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => false,
        Err(_) => true,
    }
}

fn handle(mut s: TcpStream, token: &str, stop: &Arc<AtomicBool>) {
    let _ = s.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(60)));
    let _ = s.set_nodelay(true);
    let mut raw: Vec<u8> = Vec::with_capacity(1024);
    let mut chunk = [0u8; 4096];
    let end = loop {
        if let Some(e) = sl::head_end(&raw) {
            break e;
        }
        if raw.len() > HEAD_MAX {
            simple(&mut s, 431, "");
            return;
        }
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => raw.extend_from_slice(&chunk[..n]),
        }
    };
    let req = match sl::parse_head(&raw[..end]) {
        Some(r) => r,
        None => {
            simple(&mut s, 400, "");
            return;
        }
    };
    if req.method == "OPTIONS" {
        let _ = write_head(
            &mut s,
            204,
            vec![
                ("Access-Control-Allow-Methods".into(), "GET, HEAD, OPTIONS".into()),
                ("Access-Control-Allow-Headers".into(), "Range".into()),
                // (Chromium's private-network preflight, for a page whose origin it does not count as local.)
                ("Access-Control-Allow-Private-Network".into(), "true".into()),
                ("Access-Control-Max-Age".into(), "600".into()),
                ("Content-Length".into(), "0".into()),
            ],
        );
        return;
    }
    if req.method != "GET" && req.method != "HEAD" {
        simple(&mut s, 405, "");
        return;
    }
    let head_only = req.method == "HEAD";
    let target = req.target.clone();
    let (path, query) = sl::split_target(&target);
    match sl::route(path, query, token) {
        sl::Route::Forbidden => simple(&mut s, 403, ""),
        sl::Route::NotFound => simple(&mut s, 404, ""),
        sl::Route::File { path } => serve_file(&mut s, &path, &req, head_only, stop),
        sl::Route::Torrent { session } => serve_torrent(&mut s, &session, &req, head_only, stop),
        sl::Route::Audio => streamproxy::audio(&mut s, query, head_only, stop),
        sl::Route::Video => streamproxy::video(&mut s, query, head_only, stop),
        sl::Route::Proxy => streamproxy::proxy(&mut s, query, &req, head_only, stop),
    }
    let _ = s.flush();
    let _ = s.shutdown(Shutdown::Both);
}

/// streamproxy.cjs's localFile(): a file on this computer, with ranges.
fn serve_file(s: &mut TcpStream, path: &str, req: &sl::Head, head_only: bool, stop: &Arc<AtomicBool>) {
    let p = PathBuf::from(path);
    let size = match std::fs::metadata(&p) {
        Ok(m) if m.is_file() => m.len(),
        _ => {
            simple(s, 404, "");
            return;
        }
    };
    let span = sl::span(req.header("range"), size);
    let (code, hs) = sl::range_headers(&span, sl::file_type(path));
    if write_head(s, code, hs).is_err() || head_only {
        return;
    }
    let (from, count) = span.bytes();
    if count == 0 {
        return;
    }
    let mut f = match std::fs::File::open(&p) {
        Ok(f) => f,
        Err(_) => return,
    };
    if f.seek(SeekFrom::Start(from)).is_err() {
        return;
    }
    let mut buf = vec![0u8; CHUNK];
    let mut left = count;
    while left > 0 && !stop.load(Ordering::SeqCst) {
        let want = (CHUNK as u64).min(left) as usize;
        let n = match f.read(&mut buf[..want]) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if s.write_all(&buf[..n]).is_err() {
            break;
        }
        left -= n as u64;
    }
}

/// torrentstream.cjs's serve(): a file of a torrent being watched, each part sent once its pieces are in.
fn serve_torrent(s: &mut TcpStream, key: &str, req: &sl::Head, head_only: bool, stop: &Arc<AtomicBool>) {
    let sess = match sessions().get(key).cloned() {
        Some(x) if !x.cancelled.load(Ordering::SeqCst) => x,
        _ => {
            simple(s, 404, "");
            return;
        }
    };
    let f = match sess.engine.file(&sess.id, sess.index) {
        Ok(f) if f.size > 0 => f,
        _ => {
            simple(s, 404, "");
            return;
        }
    };
    let span = sl::span(req.header("range"), f.size);
    let (code, hs) = sl::range_headers(&span, sl::stream_type(&f.name));
    if write_head(s, code, hs).is_err() || head_only {
        return;
    }
    let (from, count) = span.bytes();
    if count == 0 {
        return;
    }
    sess.engine.prioritise(&sess.id, sess.index, from, from + count - 1);
    let mut buf = vec![0u8; CHUNK];
    let (mut pos, end) = (from, from + count);
    while pos < end {
        let want = (CHUNK as u64).min(end - pos) as usize;
        let got = {
            let sr: &TcpStream = s;
            let gone = || stop.load(Ordering::SeqCst) || sess.cancelled.load(Ordering::SeqCst) || peer_gone(sr);
            sess.engine.read_at(&sess.id, sess.index, pos, &mut buf[..want], &gone)
        };
        match got {
            Ok(n) if n > 0 => {
                if s.write_all(&buf[..n]).is_err() {
                    break;
                }
                pos += n as u64;
            }
            _ => break,
        }
    }
}

/* ---------- sessions ---------- */

/// A file of a download opened for watching with `engine` → its address (a live session of the same download, file
/// and engine is used again).
pub fn open(engine: Arc<dyn StreamEngine>, src: &Source, index: usize) -> Result<String, String> {
    let files = engine.add(src)?;
    let f = files
        .iter()
        .find(|f| f.index == index)
        .cloned()
        .ok_or_else(|| "no such file".to_string())?;
    engine.select(&src.id, index)?;
    let (port, token) = ensure()?;
    let mut m = sessions();
    let same = m
        .iter()
        .find(|(_, x)| x.id == src.id && x.index == index && x.engine.name() == engine.name() && !x.cancelled.load(Ordering::SeqCst))
        .map(|(k, _)| k.clone());
    let key = match same {
        Some(k) => k,
        None => {
            let k = sl::new_token()[..20].to_string();
            m.insert(
                k.clone(),
                Arc::new(Session { id: src.id.clone(), index, name: f.name.clone(), engine: engine.clone(), cancelled: Arc::new(AtomicBool::new(false)) }),
            );
            k
        }
    };
    Ok(sl::torrent_address(port, &token, &key, &f.name))
}

/// The player closed: the download's sessions withdrawn (their readers end), each engine told.
pub fn done(id: &str) {
    let gone: Vec<Arc<Session>> = {
        let mut m = sessions();
        let keys: Vec<String> = m.iter().filter(|(_, x)| x.id == id).map(|(k, _)| k.clone()).collect();
        keys.iter().filter_map(|k| m.remove(k)).collect()
    };
    let mut told: Vec<&'static str> = Vec::new();
    for x in gone.iter() {
        x.cancelled.store(true, Ordering::SeqCst);
        if !told.contains(&x.engine.name()) {
            told.push(x.engine.name());
            x.engine.stop(id);
        }
    }
}

/// The stats of a download being watched (None when nothing of it is).
pub fn stats(id: &str) -> Option<Value> {
    let s = sessions().values().find(|x| x.id == id && !x.cancelled.load(Ordering::SeqCst)).cloned()?;
    s.engine.stats(&s.id, s.index)
}

/* ---------- the commands ---------- */

fn text_of(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// JS's `Number(x) || 0` for a file's index (never below 0).
fn index_of(v: Option<&Value>) -> usize {
    let n = match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    };
    if n.is_finite() && n > 0.0 {
        n as usize
    } else {
        0
    }
}

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

/// kt:streamUrl({ id, fileIndex }) → { url }: the address the player reads a torrent's file from while it downloads.
/// With librqbit built in (`--features rqbit`), the torrent is handed over to it first, as Electron hands it to
/// WebTorrent; aria2's own in-order fetch otherwise, and whenever librqbit cannot take it.
#[tauri::command]
pub async fn kt_stream_url(o: Value) -> Result<Value, String> {
    let id = text_of(o.get("id"));
    let index = index_of(o.get("fileIndex"));
    blocking(move || {
        let src = se::source_of(&id).unwrap_or_else(|_| Source { id: id.clone(), ..Default::default() });
        #[cfg(feature = "rqbit")]
        {
            if let Some(r) = crate::stream_rqbit::engine() {
                match open(r.clone(), &src, index) {
                    Ok(u) => return Ok(json!({ "url": u })),
                    Err(e) => {
                        eprintln!("rqbit: {}", e);
                        r.stop(&id);
                    }
                }
            }
        }
        let u = open(aria2(), &src, index)?;
        Ok(json!({ "url": u }))
    })
    .await
}

/// kt:streamDone({ id }) → { ok: true }: the player closed.
#[tauri::command]
pub async fn kt_stream_done(o: Value) -> Result<Value, String> {
    let id = text_of(o.get("id"));
    blocking(move || {
        done(&id);
        Ok(json!({ "ok": true }))
    })
    .await
}

/// kt:streamStats({ id }) → { down, up, peers, progress, buffered, engine } or null.
#[tauri::command]
pub async fn kt_stream_stats(o: Value) -> Result<Value, String> {
    let id = text_of(o.get("id"));
    blocking(move || Ok(stats(&id).unwrap_or(Value::Null))).await
}

/// kt:fileUrl(path) → the address of a file on this computer (a string, as Electron's).
#[tauri::command]
pub async fn kt_file_url(p: String) -> Result<String, String> {
    let (port, token) = ensure()?;
    Ok(sl::file_address(port, &token, &ec::native_path(&p, cfg!(windows))))
}

/// kt:audioUrl() → { url }: the address the page adds «?src=&ss=&a=» to.
#[tauri::command]
pub async fn kt_audio_url() -> Result<Value, String> {
    let (port, token) = ensure()?;
    Ok(json!({ "url": format!("http://127.0.0.1:{}/{}/audio", port, token) }))
}

/// kt:videoUrl() → { url }: the address the page adds «?src=&ss=&a=&c=» to.
#[tauri::command]
pub async fn kt_video_url() -> Result<Value, String> {
    let (port, token) = ensure()?;
    Ok(json!({ "url": format!("http://127.0.0.1:{}/{}/video", port, token) }))
}

/// kt:proxyUrl({ url, headers }) → the address (a string, as Electron's) that fetches `url` with those headers.
#[tauri::command]
pub async fn kt_proxy_url(o: Value) -> Result<String, String> {
    let (port, token) = ensure()?;
    let url = text_of(o.get("url"));
    let headers = match o.get("headers") {
        Some(Value::Object(m)) => Value::Object(m.clone()),
        _ => json!({}),
    };
    Ok(sl::proxy_address(port, &token, &url, &headers.to_string()))
}
