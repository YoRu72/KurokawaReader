// Stage P8: files shared over Wi-Fi (kt:shareWifi, kt:shareWifiStop, kt:shareWifiStatus — desktop/wifishare.cjs), the
// local API (kt:localApi — desktop/localapi.cjs) and the antivirus check of a finished download (kt:avScan,
// kt:avAvailable — desktop/antivirus.cjs). Plain std::net servers on threads (no new crate); their rules in
// lanlogic.rs (std only, tested with hostile inputs).
//
// As Electron's, and no more: the Wi-Fi share listens on every interface (0.0.0.0, a free port) and answers only under
// its random key — the list page and each shared file by its number (ranges, HEAD); nothing else is reachable, no
// upload (Electron has none: anything but GET / HEAD is refused). The local API listens on 127.0.0.1 only (port 8977
// unless given) and asks the token on every request but the CORS preflight (Electron's order). Stricter than Electron,
// said plainly: the key is 24 hex digits (Electron 12) and compared in constant time, as the token is; a shared file is
// resolved when shared and served only while it still resolves to the same real file (no link swapped in later);
// requests' heads are capped (16 KiB), the API's bodies too (1 MiB → 413), connections idle 30 s are closed, at most 32
// at once; a chunked body is refused (411). The address shown is this computer's default-route IPv4 (a private one
// first) — Electron looked at the interfaces' names, which std cannot list.
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::lanlogic as logic;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

/* ---------- random bytes (the system's generator, no crate) ---------- */

#[cfg(windows)]
#[link(name = "bcrypt")]
extern "system" {
    fn BCryptGenRandom(alg: *mut std::ffi::c_void, buf: *mut u8, len: u32, flags: u32) -> i32;
}

fn random_hex(n: usize) -> Result<String, String> {
    let mut b = vec![0u8; n];
    #[cfg(windows)]
    {
        // (BCRYPT_USE_SYSTEM_PREFERRED_RNG)
        let st = unsafe { BCryptGenRandom(std::ptr::null_mut(), b.as_mut_ptr(), n as u32, 2) };
        if st != 0 {
            return Err(format!("no random bytes ({})", st));
        }
    }
    #[cfg(not(windows))]
    {
        std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).map_err(|e| format!("no random bytes ({})", e))?;
    }
    Ok(b.iter().map(|x| format!("{:02x}", x)).collect())
}

/* ---------- the servers' frame ---------- */

struct Server {
    stop: Arc<AtomicBool>,
    port: u16,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// Accepts until stopped; each connection on a thread of its own (at most CONN_MAX), with timeouts.
fn serve(listener: TcpListener, handler: Arc<dyn Fn(&mut TcpStream) + Send + Sync>) -> Result<Server, String> {
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let st = stop.clone();
    let active = Arc::new(AtomicUsize::new(0));
    std::thread::Builder::new()
        .name("kt-lan-accept".into())
        .spawn(move || {
            while !st.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((s, _)) => {
                        if active.load(Ordering::SeqCst) >= logic::CONN_MAX {
                            drop(s);
                            continue;
                        }
                        let _ = s.set_nonblocking(false);
                        let _ = s.set_read_timeout(Some(Duration::from_secs(logic::IDLE_SECS)));
                        let _ = s.set_write_timeout(Some(Duration::from_secs(logic::IDLE_SECS)));
                        let (h, a) = (handler.clone(), active.clone());
                        a.fetch_add(1, Ordering::SeqCst);
                        if std::thread::Builder::new()
                            .name("kt-lan-conn".into())
                            .spawn(move || {
                                let mut s = s;
                                h(&mut s);
                                finish(&mut s);
                                a.fetch_sub(1, Ordering::SeqCst);
                            })
                            .is_err()
                        {
                            active.fetch_sub(1, Ordering::SeqCst);
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(40)),
                    Err(_) => std::thread::sleep(Duration::from_millis(40)),
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(Server { stop, port })
}

/// The answer sent: the connection's writing side closed, then what the client still sends read and dropped (at most
/// 4 MiB, half a second idle) — a socket closed with unread bytes is reset, and the client could lose the answer.
fn finish(s: &mut TcpStream) {
    let _ = s.flush();
    let _ = s.shutdown(std::net::Shutdown::Write);
    let _ = s.set_read_timeout(Some(Duration::from_millis(500)));
    let mut buf = [0u8; 16 * 1024];
    let mut left: usize = 4 << 20;
    while left > 0 {
        match s.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => left = left.saturating_sub(n),
        }
    }
}

/// A body not wanted read and dropped first (at most 4 MiB, beyond what came with the head), so the client is
/// reading when the refusal comes.
fn discard(s: &mut TcpStream, head: &logic::Head, already: usize) {
    let want: usize = head.header("content-length").and_then(|v| v.trim().parse().ok()).unwrap_or(0);
    let mut left = want.saturating_sub(already).min(4 << 20);
    let mut buf = [0u8; 16 * 1024];
    while left > 0 {
        match s.read(&mut buf[..left.min(16 * 1024)]) {
            Ok(0) | Err(_) => break,
            Ok(n) => left -= n,
        }
    }
}

/// A request's head read (at most HEAD_MAX bytes) → the head and what of the body came with it.
fn read_head(s: &mut TcpStream) -> Option<(logic::Head, Vec<u8>)> {
    let mut buf: Vec<u8> = Vec::with_capacity(2048);
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(end) = logic::head_end(&buf) {
            let head = logic::parse_head(&buf[..end])?;
            return Some((head, buf[end..].to_vec()));
        }
        if buf.len() > logic::HEAD_MAX {
            return None;
        }
        let n = s.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn reply(s: &mut TcpStream, status: &str, headers: &[(&str, String)], body: &[u8]) {
    let mut h: Vec<(&str, String)> = headers.to_vec();
    h.push(("Content-Length", body.len().to_string()));
    let _ = s.write_all(logic::response_head(status, &h).as_bytes());
    let _ = s.write_all(body);
    let _ = s.flush();
}

/* ---------- the Wi-Fi share ---------- */

struct Shared {
    /// The real path when shared, and the name shown.
    files: Vec<(PathBuf, String)>,
    key: String,
    sent: AtomicU64,
    hits: AtomicU64,
}

struct Share {
    server: Server,
    state: Arc<Shared>,
}

static SHARE: Mutex<Option<Share>> = Mutex::new(None);

/// This computer's IPv4 addresses that a route goes out by (no packet is sent: a UDP socket only «connected»).
fn lan_ip() -> Option<Ipv4Addr> {
    let mut cands: Vec<Ipv4Addr> = Vec::new();
    for to in ["192.168.0.1:9", "10.0.0.1:9", "172.16.0.1:9", "192.0.2.1:9", "8.8.8.8:53"] {
        if let Ok(u) = UdpSocket::bind("0.0.0.0:0") {
            if u.connect(to).is_ok() {
                if let Ok(SocketAddr::V4(a)) = u.local_addr() {
                    if !cands.contains(a.ip()) {
                        cands.push(*a.ip());
                    }
                }
            }
        }
    }
    logic::pick_lan_ip(&cands)
}

fn share_url(port: u16, key: &str) -> Value {
    match lan_ip() {
        Some(ip) => json!(format!("http://{}:{}/{}/", ip, port, key)),
        None => Value::Null,
    }
}

/// The file still the one shared: it resolves to the same real path and is a regular file.
fn still_there(p: &Path) -> Option<std::fs::File> {
    let now = std::fs::canonicalize(p).ok()?;
    if now != p {
        return None;
    }
    let f = std::fs::File::open(&now).ok()?;
    if !f.metadata().ok()?.is_file() {
        return None;
    }
    Some(f)
}

fn share_conn(st: &Arc<Shared>, s: &mut TcpStream) {
    let (head, extra) = match read_head(s) {
        Some(h) => h,
        None => {
            reply(s, "400 Bad Request", &[], b"");
            return;
        }
    };
    let route = logic::share_route(&head.target, &st.key, st.files.len());
    if route == logic::ShareRoute::NotFound {
        reply(s, "404 Not Found", &[], b"");
        return;
    }
    st.hits.fetch_add(1, Ordering::SeqCst);
    let head_only = head.method == "HEAD";
    if head.method != "GET" && !head_only {
        discard(s, &head, extra.len());
        reply(s, "405 Method Not Allowed", &[("Allow", "GET, HEAD".to_string())], b"");
        return;
    }
    match route {
        logic::ShareRoute::Index => {
            let list: Vec<(String, u64)> = st.files.iter().map(|(p, n)| (n.clone(), std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))).collect();
            let html = logic::index_html(&list);
            let h = [("Content-Type", "text/html; charset=utf-8".to_string())];
            if head_only {
                let _ = s.write_all(logic::response_head("200 OK", &[("Content-Type", h[0].1.clone()), ("Content-Length", html.len().to_string())]).as_bytes());
            } else {
                reply(s, "200 OK", &h, html.as_bytes());
            }
        }
        logic::ShareRoute::File(i) => {
            let (path, name) = &st.files[i];
            let mut f = match still_there(path) {
                Some(f) => f,
                None => {
                    reply(s, "404 Not Found", &[], b"");
                    return;
                }
            };
            let size = f.metadata().map(|m| m.len()).unwrap_or(0);
            let r = logic::range_of(head.header("range"), size);
            let (a, b) = match r {
                Some(Err(())) => {
                    reply(s, "416 Range Not Satisfiable", &[("Content-Range", format!("bytes */{}", size))], b"");
                    return;
                }
                Some(Ok(x)) => x,
                None => (0, size.saturating_sub(1)),
            };
            let len = if size == 0 { 0 } else { b - a + 1 };
            let mut h: Vec<(&str, String)> = vec![
                ("Content-Type", logic::mime_of(name).to_string()),
                ("Accept-Ranges", "bytes".to_string()),
                ("Content-Length", len.to_string()),
                ("Content-Disposition", format!("attachment; filename*=UTF-8''{}", logic::pct_encode(name))),
            ];
            let status = if r.is_some() {
                h.push(("Content-Range", format!("bytes {}-{}/{}", a, b, size)));
                "206 Partial Content"
            } else {
                "200 OK"
            };
            if s.write_all(logic::response_head(status, &h).as_bytes()).is_err() || head_only {
                return;
            }
            if f.seek(SeekFrom::Start(a)).is_err() {
                return;
            }
            let mut left = len;
            let mut buf = vec![0u8; 64 * 1024];
            while left > 0 {
                let want = left.min(buf.len() as u64) as usize;
                let n = match f.read(&mut buf[..want]) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                if s.write_all(&buf[..n]).is_err() {
                    break;
                }
                st.sent.fetch_add(n as u64, Ordering::SeqCst);
                left -= n as u64;
            }
        }
        _ => reply(s, "404 Not Found", &[], b""),
    }
}

fn share_stop() {
    *lock(&SHARE) = None;
}

/// kt:shareWifi({ paths, names }) → { url, files } (wifishare.cjs's start): the files that are there, shared.
#[tauri::command]
pub async fn kt_share_wifi(o: Value) -> Result<Value, String> {
    share_stop();
    let paths: Vec<String> = o.get("paths").and_then(|v| v.as_array()).map(|a| a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect()).unwrap_or_default();
    let names: Vec<String> = o.get("names").and_then(|v| v.as_array()).map(|a| a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect()).unwrap_or_default();
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    for (i, p) in paths.iter().enumerate() {
        let real = match std::fs::canonicalize(p) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if !std::fs::metadata(&real).map(|m| m.is_file()).unwrap_or(false) {
            continue;
        }
        let name = names.get(i).filter(|n| !n.is_empty()).cloned().unwrap_or_else(|| Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
        files.push((real, name));
    }
    if files.is_empty() {
        return Err("no files".to_string());
    }
    let key = random_hex(12)?;
    let n = files.len();
    let state = Arc::new(Shared { files, key: key.clone(), sent: AtomicU64::new(0), hits: AtomicU64::new(0) });
    let listener = TcpListener::bind(("0.0.0.0", 0)).map_err(|e| e.to_string())?;
    let st2 = state.clone();
    let server = serve(listener, Arc::new(move |s| share_conn(&st2, s)))?;
    let port = server.port;
    *lock(&SHARE) = Some(Share { server, state });
    Ok(json!({ "url": share_url(port, &key), "files": n }))
}

#[tauri::command]
pub async fn kt_share_wifi_stop() -> Result<(), String> {
    share_stop();
    Ok(())
}

/// → { running, url, sent, hits }.
#[tauri::command]
pub async fn kt_share_wifi_status() -> Result<Value, String> {
    let g = lock(&SHARE);
    Ok(match g.as_ref() {
        Some(sh) => json!({ "running": true, "url": share_url(sh.server.port, &sh.state.key), "sent": sh.state.sent.load(Ordering::SeqCst), "hits": sh.state.hits.load(Ordering::SeqCst) }),
        None => json!({ "running": false, "url": Value::Null, "sent": 0, "hits": 0 }),
    })
}

/* ---------- the local API ---------- */

struct Api {
    _server: Server,
    token: String,
    port: u16,
}

static API: Mutex<Option<Api>> = Mutex::new(None);
/// The token and port last in force (localapi.cjs's state() after a stop still gives them).
static API_LAST: Mutex<(String, u16)> = Mutex::new((String::new(), 0));

fn api_json(s: &mut TcpStream, status: &str, v: &Value) {
    let mut h: Vec<(&str, String)> = logic::CORS.iter().map(|(k, v)| (*k, v.to_string())).collect();
    h.push(("Content-Type", "application/json".to_string()));
    reply(s, status, &h, v.to_string().as_bytes());
}

fn api_conn(app: &AppHandle, token: &str, s: &mut TcpStream) {
    let (head, mut body) = match read_head(s) {
        Some(h) => h,
        None => {
            reply(s, "400 Bad Request", &[], b"");
            return;
        }
    };
    let route = logic::api_route(&head.method, &head.target);
    if route == logic::ApiRoute::Preflight {
        let h: Vec<(&str, String)> = logic::CORS.iter().map(|(k, v)| (*k, v.to_string())).collect();
        let _ = s.write_all(logic::response_head("204 No Content", &h).as_bytes());
        return;
    }
    if !logic::api_token_ok(&logic::api_token(head.header("authorization"), &head.target), token) {
        api_json(s, "401 Unauthorized", &json!({ "error": "token" }));
        return;
    }
    if head.header("transfer-encoding").is_some() {
        api_json(s, "411 Length Required", &json!({ "error": "length" }));
        return;
    }
    let want: usize = head.header("content-length").and_then(|v| v.trim().parse().ok()).unwrap_or(0);
    if want > logic::BODY_MAX || body.len() > logic::BODY_MAX {
        discard(s, &head, body.len());
        api_json(s, "413 Payload Too Large", &json!({ "error": "size" }));
        return;
    }
    while body.len() < want {
        let mut chunk = vec![0u8; (want - body.len()).min(64 * 1024)];
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => body.extend_from_slice(&chunk[..n]),
        }
    }
    body.truncate(want);
    let engine = crate::engine::get();
    let r: Result<Value, String> = match route {
        logic::ApiRoute::Tasks => {
            let list = engine.as_ref().map(|e| e.list().unwrap_or_else(|_| e.last())).unwrap_or(Value::Array(vec![]));
            // (Stage P5: the video tasks after aria2's, as main.cjs allTasks.)
            let list = crate::vtjobs::merged(list);
            let tasks: Vec<Value> = list
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|x| json!({ "id": x.get("id"), "kind": x.get("kind"), "name": x.get("name"), "state": x.get("state"), "done": x.get("done"), "total": x.get("total"), "downSpeed": x.get("downSpeed"), "dir": x.get("dir") }))
                        .collect()
                })
                .unwrap_or_default();
            Ok(json!({ "tasks": tasks }))
        }
        logic::ApiRoute::Version => Ok(json!({ "app": "Kurokawa Tools", "version": app.package_info().version.to_string() })),
        logic::ApiRoute::Add => (|| -> Result<Value, String> {
            let o: Value = if body.is_empty() { json!({}) } else { serde_json::from_slice(&body).map_err(|e| e.to_string())? };
            let urls: Vec<String> = match (o.get("urls").and_then(|v| v.as_array()), o.get("url")) {
                (Some(a), _) => a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect(),
                (None, Some(u)) if !u.is_null() && u.as_str() != Some("") => vec![u.as_str().map(String::from).unwrap_or_else(|| u.to_string())],
                _ => vec![],
            };
            if urls.is_empty() {
                return Ok(json!({ "__status": 400, "error": "url" }));
            }
            // (Stage P5: `video` / `audio` — localapi.cjs's !!o.video / !!o.audio — become video jobs run by yt-dlp, as
            // main.cjs's add: { url, dir: o.dir || the default folder, paused, meta: { audioOnly, format, title } }.)
            let audio = truthy(o.get("audio"));
            if truthy(o.get("video")) || audio {
                let dir = match o.get("dir") {
                    Some(d) if truthy(Some(d)) => d.clone(),
                    _ => json!(crate::commands::default_dir(app).to_string_lossy().into_owned()),
                };
                let mut meta = json!({ "audioOnly": audio });
                if audio {
                    meta["format"] = json!("bestaudio/best");
                }
                if let Some(n) = o.get("name").filter(|n| !n.is_null()) {
                    meta["title"] = n.clone();
                }
                let mut ids: Vec<Value> = Vec::new();
                for u in urls.iter() {
                    let job = json!({ "url": u, "dir": dir, "paused": truthy(o.get("paused")), "meta": meta });
                    let t = crate::vtjobs::add(&job)?;
                    ids.push(t.get("id").cloned().unwrap_or(Value::Null));
                }
                return Ok(json!({ "added": ids }));
            }
            let e = engine.as_ref().ok_or("engine")?;
            e.ensure();
            let mut ids: Vec<Value> = Vec::new();
            for u in urls.iter() {
                let mut add = json!({ "source": { "url": u }, "connections": 8, "paused": o.get("paused").map(|v| v.as_bool().unwrap_or(false)).unwrap_or(false) });
                if let Some(d) = o.get("dir").filter(|d| d.is_string()) {
                    add["dir"] = d.clone();
                }
                if let Some(n) = o.get("name").filter(|d| d.is_string()) {
                    add["name"] = n.clone();
                }
                let t = e.add(&add)?;
                ids.push(t.get("id").cloned().unwrap_or(Value::Null));
            }
            e.tick();
            Ok(json!({ "added": ids }))
        })(),
        logic::ApiRoute::Act(id, act) => (|| -> Result<Value, String> {
            // (Stage P5: a video task's id goes to its job, as main.cjs's act.)
            if crate::vtjobs::has(&id) {
                match act.as_str() {
                    "pause" => crate::vtjobs::pause(&id),
                    "resume" => crate::vtjobs::resume(&id),
                    _ => crate::vtjobs::remove(&id, false),
                }
                return Ok(json!({ "ok": true }));
            }
            let e = engine.as_ref().ok_or("engine")?;
            match act.as_str() {
                "pause" => e.pause(&id)?,
                "resume" => e.resume(&id)?,
                _ => e.remove(&id, false)?,
            }
            e.tick();
            Ok(json!({ "ok": true }))
        })(),
        _ => Ok(json!({ "__status": 404, "error": "route" })),
    };
    match r {
        Ok(mut v) => match v.get("__status").and_then(|x| x.as_u64()) {
            Some(400) => {
                if let Some(m) = v.as_object_mut() {
                    m.remove("__status");
                }
                api_json(s, "400 Bad Request", &v)
            }
            Some(_) => {
                if let Some(m) = v.as_object_mut() {
                    m.remove("__status");
                }
                api_json(s, "404 Not Found", &v)
            }
            None => api_json(s, "200 OK", &v),
        },
        Err(e) => api_json(s, "500 Internal Server Error", &json!({ "error": e })),
    }
}

fn api_state() -> Value {
    let g = lock(&API);
    match g.as_ref() {
        Some(a) => json!({ "on": true, "token": a.token, "port": a.port }),
        None => {
            let l = lock(&API_LAST);
            json!({ "on": false, "token": l.0, "port": l.1 })
        }
    }
}

/// kt:localApi(o) — { on: true, token?, port? } starts it (localapi.cjs's start: the token given or a new one, port
/// 8977 unless given) → { token, port, on }; { on: false } stops it; otherwise → its state. A port that is taken: the
/// answer says on: false and why (Electron's said on: true and listened nowhere).
#[tauri::command]
pub async fn kt_local_api(app: AppHandle, o: Value) -> Result<Value, String> {
    match o.get("on").and_then(|v| v.as_bool()) {
        Some(true) => {
            *lock(&API) = None;
            let token = match o.get("token").and_then(|v| v.as_str()).filter(|t| !t.is_empty()) {
                Some(t) => t.to_string(),
                None => random_hex(16)?,
            };
            let port = o.get("port").and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).filter(|p| *p > 0 && *p < 65536).map(|p| p as u16).unwrap_or(logic::API_PORT);
            *lock(&API_LAST) = (token.clone(), port);
            let listener = match TcpListener::bind((IpAddr::V4(Ipv4Addr::LOCALHOST), port)) {
                Ok(l) => l,
                Err(e) => return Ok(json!({ "token": token, "port": port, "on": false, "error": e.to_string() })),
            };
            let (a2, t2) = (app.clone(), token.clone());
            let server = serve(listener, Arc::new(move |s| api_conn(&a2, &t2, s)))?;
            *lock(&API) = Some(Api { _server: server, token: token.clone(), port });
            Ok(json!({ "token": token, "port": port, "on": true }))
        }
        Some(false) => {
            *lock(&API) = None;
            Ok(api_state())
        }
        None => Ok(api_state()),
    }
}

/* ---------- the antivirus ---------- */

fn in_path(exe: &str) -> Option<PathBuf> {
    let p = std::env::var_os("PATH")?;
    std::env::split_paths(&p).map(|d| d.join(exe)).find(|c| c.is_file())
}

fn defender() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let base = PathBuf::from("C:\\ProgramData\\Microsoft\\Windows Defender\\Platform");
    let versions: Vec<String> = std::fs::read_dir(&base)
        .map(|rd| rd.flatten().filter(|e| e.path().join("MpCmdRun.exe").is_file()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    if let Some(v) = logic::defender_pick(&versions) {
        return Some(base.join(v).join("MpCmdRun.exe"));
    }
    let p = PathBuf::from("C:\\Program Files\\Windows Defender\\MpCmdRun.exe");
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

fn clamscan() -> Option<PathBuf> {
    in_path(if cfg!(windows) { "clamscan.exe" } else { "clamscan" })
}

/// The program run, its output (≤ 4 MiB) and exit code; killed after `limit` (code None).
fn run_limited(exe: &str, args: &[String], limit: Duration) -> Result<(Option<i32>, String), String> {
    let mut c = std::process::Command::new(exe);
    c.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let mut child = c.spawn().map_err(|e| e.to_string())?;
    let take = |r: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut out = Vec::new();
            if let Some(mut r) = r {
                let mut buf = [0u8; 8192];
                while let Ok(n) = r.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    if out.len() < (4 << 20) {
                        out.extend_from_slice(&buf[..n]);
                    }
                }
            }
            out
        })
    };
    let t1 = take(child.stdout.take().map(|x| Box::new(x) as Box<dyn Read + Send>));
    let t2 = take(child.stderr.take().map(|x| Box::new(x) as Box<dyn Read + Send>));
    let until = Instant::now() + limit;
    let code = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.code(),
            Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let mut text = String::from_utf8_lossy(&t1.join().unwrap_or_default()).into_owned();
    text.push_str(&String::from_utf8_lossy(&t2.join().unwrap_or_default()));
    Ok((code, text))
}

/// kt:avScan({ cfg: { kind, command, args, extensions }, file }) → { result: clean | infected | error | skipped, detail?,
/// scanner? } (antivirus.cjs's scan: Defender's MpCmdRun on Windows, ClamAV's clamscan elsewhere, or the user's own
/// program — run directly, never through a shell — with {file}; ten minutes at most).
#[tauri::command]
pub async fn kt_av_scan(o: Value) -> Result<Value, String> {
    let cfg = o.get("cfg").cloned().unwrap_or(json!({}));
    let file = o.get("file").map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())).unwrap_or_default();
    let exts: Vec<String> = cfg.get("extensions").and_then(|v| v.as_array()).map(|a| a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect()).unwrap_or_default();
    if !logic::av_wanted(&exts, &file) {
        return Ok(json!({ "result": "skipped" }));
    }
    let kind = logic::av_kind(cfg.get("kind").and_then(|v| v.as_str()).unwrap_or(""), cfg!(windows));
    let exe: Option<String> = match kind.as_str() {
        "defender" => defender().map(|p| p.to_string_lossy().into_owned()),
        "clamav" => clamscan().map(|p| p.to_string_lossy().into_owned()),
        "custom" => cfg.get("command").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        _ => None,
    };
    let exe = match exe {
        Some(e) => e,
        None => return Ok(json!({ "result": "error", "detail": "no-scanner" })),
    };
    let args = logic::av_fill(&logic::av_args(&kind, cfg.get("args").and_then(|v| v.as_str()).unwrap_or("")), &file);
    let k2 = kind.clone();
    let r = tauri::async_runtime::spawn_blocking(move || run_limited(&exe, &args, Duration::from_secs(600))).await.map_err(|e| e.to_string())?;
    Ok(match r {
        Err(e) => json!({ "result": "error", "detail": e, "scanner": k2 }),
        Ok((code, out)) => {
            let v = logic::av_verdict(&k2, code);
            let detail = logic::av_detail(&out);
            match v {
                "clean" => json!({ "result": "clean", "scanner": k2 }),
                "infected" => json!({ "result": "infected", "detail": detail, "scanner": k2 }),
                _ => json!({ "result": "error", "detail": if detail.is_empty() { code.map(|c| format!("exit {}", c)).unwrap_or_else(|| "killed".to_string()) } else { detail }, "scanner": k2 }),
            }
        }
    })
}

/// kt:avAvailable → { defender, clamav, platform }.
#[tauri::command]
pub async fn kt_av_available() -> Result<Value, String> {
    Ok(json!({ "defender": defender().is_some(), "clamav": clamscan().is_some(), "platform": kurokawa_shell::util::node_platform() }))
}

/* ---------- the self-test ---------- */

/// (Self-test only.) { act: 'share' } → the share's port and key (to reach it from loopback); 'freeport' → a port free
/// on 127.0.0.1 now.
#[tauri::command]
pub async fn kt_selftest_lan(o: Value) -> Result<Value, String> {
    if !kurokawa_shell::selftest::active() {
        return Err("not a self-test run".to_string());
    }
    match o.get("act").and_then(|v| v.as_str()).unwrap_or("") {
        "share" => {
            let g = lock(&SHARE);
            Ok(g.as_ref().map(|s| json!({ "port": s.server.port, "key": s.state.key })).unwrap_or(Value::Null))
        }
        "freeport" => {
            let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
            Ok(json!(l.local_addr().map_err(|e| e.to_string())?.port()))
        }
        _ => Err("unknown act".to_string()),
    }
}

/// JavaScript's truthiness (localapi.cjs's `!!o.video`): absent, null, false, 0, NaN and "" are false.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|x| x != 0.0 && !x.is_nan()).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}
