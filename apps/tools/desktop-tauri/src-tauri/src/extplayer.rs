// A player on this computer (desktop/extplayer.cjs and desktop/relay.cjs's twin; the page's side is
// src/player/external; the plain rules — the players known, the request's checks, the arguments — are relaylogic.rs).
// The shell finds the players it knows (absolute paths, or a bare name on the PATH's absolute folders), keeps the
// program the user picked in its own dialog in the app's data folder (never in the page's settings: no backup or
// import can bring a program to run), and starts one only from a typed request it checks and turns into arguments
// itself (no shell: each argument one item). How it goes: running or ended, and for mpv where it is (its JSON IPC
// observed). And the relay: a session per playback on the stream server (/r/<session>/…, outside the run's token), closed when the
// playback ends or after six idle hours (a sweeper marks such sessions gone); the cookie and the page's other headers
// only to the source's own origin; no CORS. Compiled in CI only (tauri, reqwest); kept thin.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use kt_core::streamlogic as sl;
use kurokawa_shell::{reqwest, shell};

use crate::relaylogic::{self as rl, Ask, MpvNote, Req, Session, Sub};
use crate::streamserver;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const IDLE: Duration = Duration::from_secs(6 * 3600);

/// A head with no CORS (the relay serves players, not pages).
fn head(s: &mut TcpStream, code: u16, mut h: Vec<(String, String)>) -> std::io::Result<()> {
    h.push(("Connection".into(), "close".into()));
    s.write_all(sl::head_text(code, &h).as_bytes())
}
fn plain(s: &mut TcpStream, code: u16) {
    let _ = head(s, code, vec![("Content-Length".into(), "0".into())]);
}

/* ---------- the relay ---------- */
struct Live {
    s: Session,
    file: String,
    /// A torrent being watched (the stream server's session key), served by this relay session in-process.
    torrent: String,
    origin: String,
    last: Instant,
    last_ms: u64,
    reads: u64,
    reading: Arc<AtomicU64>,
    gone: Arc<AtomicBool>,
}
fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
static SESS: OnceLock<Mutex<HashMap<String, Live>>> = OnceLock::new();
fn sessions() -> &'static Mutex<HashMap<String, Live>> {
    SESS.get_or_init(|| {
        thread::spawn(sweep);
        Mutex::new(HashMap::new())
    })
}
/// Idle sessions dropped on a timer, marked gone so a read under way stops.
fn sweep() {
    loop {
        thread::sleep(Duration::from_secs(300));
        if let Some(m) = SESS.get() {
            if let Ok(mut g) = m.lock() {
                g.retain(|_, l| {
                    let keep = l.last.elapsed() < IDLE;
                    if !keep {
                        l.gone.store(true, Ordering::SeqCst);
                    }
                    keep
                });
            }
        }
    }
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

/// kt:relayOpen({ url, headers, subs: [{ url, name, headers }], name }) → { token, url, subs }. http(s) only.
#[tauri::command]
pub async fn kt_relay_open(o: Value) -> Result<Value, String> {
    let (port, token) = streamserver::ensure()?;
    let id: String = format!("{}{}", sl::new_token(), sl::new_token()).chars().filter(|c| c.is_ascii_hexdigit()).take(32).collect();
    if id.len() != 32 {
        return Err("token".into());
    }
    let mut url = o.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if !url.is_empty() && !rl::is_http(&url) {
        return Err("refused: target".into());
    }
    // (A file on this computer for another program's player: served by this session's address.)
    let mut file = match o.get("file").and_then(|v| v.as_str()) {
        Some(f) if !f.is_empty() => {
            let p = PathBuf::from(f);
            if !p.is_absolute() || !p.is_file() {
                return Err("refused: file".into());
            }
            p.to_string_lossy().to_string()
        }
        _ => String::new(),
    };
    // (This server's own address — a torrent being watched, a file —: served by the session in-process, so the run's
    // token in it never reaches another program's command line. Its other routes are not handed out.)
    let mut torrent = String::new();
    if let Some(t) = rl::own_target(&url, port) {
        let (p, q) = sl::split_target(&t);
        match sl::route(p, q, &token) {
            sl::Route::Torrent { session } => torrent = session,
            sl::Route::File { path } if file.is_empty() => file = path,
            _ => return Err("refused: target".into()),
        }
        url = String::new();
    }
    let subs: Vec<Sub> = o.get("subs").and_then(|v| v.as_array()).cloned().unwrap_or_default().iter().take(20).map(|x| {
        let u = x.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
        Sub { url: if rl::is_http(&u) { u } else { String::new() }, path: String::new(), name: x.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(), headers: pairs(x.get("headers")) }
    }).collect();
    let at = format!("http://127.0.0.1:{}/r/{}", port, id);
    let name = o.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let sub_urls: Vec<String> = subs.iter().enumerate().map(|(i, s)| if s.url.is_empty() { String::new() } else { format!("{}/s/{}/{}", at, i, name_part(&s.name, &format!("sub{}.srt", i))) }).collect();
    let main = if url.is_empty() && file.is_empty() && torrent.is_empty() { String::new() } else { format!("{}/v/{}", at, name_part(name, "video")) };
    let live = Live { file, torrent, origin: rl::origin(&url), s: Session::new(url, pairs(o.get("headers")), subs), last: Instant::now(), last_ms: now_ms(), reads: 0, reading: Arc::new(AtomicU64::new(0)), gone: Arc::new(AtomicBool::new(false)) };
    sessions().lock().map_err(|e| e.to_string())?.insert(id.clone(), live);
    Ok(json!({ "token": id, "url": main, "subs": sub_urls }))
}

/// kt:relayClose({ token }) → { closed }.
#[tauri::command]
pub async fn kt_relay_close(o: Value) -> Result<Value, String> {
    let t = o.get("token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let gone = sessions().lock().ok().and_then(|mut m| m.remove(&t));
    if let Some(l) = &gone {
        l.gone.store(true, Ordering::SeqCst);
    }
    Ok(json!({ "closed": gone.is_some() }))
}

/// kt:relayStatus({ token }) → { open, lastRead, reads, reading }.
#[tauri::command]
pub async fn kt_relay_status(o: Value) -> Result<Value, String> {
    let t = o.get("token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let m = sessions().lock().map_err(|e| e.to_string())?;
    Ok(match m.get(&t) {
        Some(l) => json!({ "open": true, "lastRead": l.last_ms, "reads": l.reads, "reading": l.reading.load(Ordering::SeqCst) }),
        None => json!({ "open": false }),
    })
}

/// The relay's client: the shell's client_no_redirect() — the DNS-over-HTTPS choice and the cookie jar of every other
/// request of the app (so a source that set its cookies through the app is let in, and a host the system's DNS
/// blocks is still found), with no redirect followed by itself (relay_one does it hop by hop). (The jar's own cookies
/// for a host go to that host only, as with any request of the app; a cookie the page handed over goes to the
/// source's origin only, and reqwest adds the jar's only when the request carries no Cookie of its own.)
fn relay_client() -> Option<&'static reqwest::Client> {
    kurokawa_shell::net::client_no_redirect().ok()
}

/// Called by streamserver::handle for /r/…: true when it was a relay address (answered here).
pub fn serve(s: &mut TcpStream, path: &str, req: &sl::Head, head_only: bool, stop: &Arc<AtomicBool>) -> bool {
    let (id, ask) = match rl::parse(path) {
        Some(x) => x,
        None => return false,
    };
    let port = streamserver::ensure().map(|(p, _)| p).unwrap_or(0);
    let at = format!("http://127.0.0.1:{}/r/{}", port, id);
    let (target, headers, origin, gone, reading, is_sub) = {
        let mut m = match sessions().lock() {
            Ok(m) => m,
            Err(_) => {
                plain(s, 500);
                return true;
            }
        };
        let l = match m.get_mut(&id) {
            Some(l) => l,
            None => {
                plain(s, 403);
                return true;
            }
        };
        l.last = Instant::now();
        l.last_ms = now_ms();
        l.reads += 1;
        if matches!(ask, Ask::Video) && !l.torrent.is_empty() {
            let k = l.torrent.clone();
            let reading = l.reading.clone();
            drop(m);
            reading.fetch_add(1, Ordering::SeqCst);
            streamserver::serve_torrent(s, &k, req, head_only, stop);
            reading.fetch_sub(1, Ordering::SeqCst);
            return true;
        }
        if matches!(ask, Ask::Video) && !l.file.is_empty() {
            let f = l.file.clone();
            let reading = l.reading.clone();
            drop(m);
            reading.fetch_add(1, Ordering::SeqCst);
            streamserver::serve_file(s, &f, req, head_only, stop);
            reading.fetch_sub(1, Ordering::SeqCst);
            return true;
        }
        let (t, h, sub) = match ask {
            Ask::Video => (l.s.url.clone(), l.s.headers.clone(), false),
            Ask::Url(n) => (l.s.urls.get(n).cloned().unwrap_or_default(), l.s.headers.clone(), false),
            Ask::Sub(i) => match l.s.subs.get(i) {
                Some(sub) => {
                    let mut h = l.s.headers.clone();
                    h.extend(sub.headers.iter().cloned());
                    (sub.url.clone(), h, true)
                }
                None => (String::new(), vec![], true),
            },
        };
        (t, h, l.origin.clone(), l.gone.clone(), l.reading.clone(), sub)
    };
    if target.is_empty() || !rl::is_http(&target) {
        plain(s, 404);
        return true;
    }
    reading.fetch_add(1, Ordering::SeqCst);
    relay_one(s, &id, &at, &target, &headers, &origin, req, head_only, stop, &gone, is_sub);
    reading.fetch_sub(1, Ordering::SeqCst);
    true
}
#[allow(clippy::too_many_arguments)]
fn relay_one(s: &mut TcpStream, id: &str, at: &str, target: &str, headers: &[(String, String)], origin: &str, req: &sl::Head, head_only: bool, stop: &Arc<AtomicBool>, gone: &Arc<AtomicBool>, is_sub: bool) {
    let client = match relay_client() {
        Some(c) => c,
        None => {
            plain(s, 502);
            return;
        }
    };
    let range = if rl::is_playlist("", target) { None } else { req.header("range") };
    // (Redirects followed here one hop at a time: the page's cookie and its other headers go to the source's origin
    // only, whatever host a redirect or a playlist names.)
    let mut url = target.to_string();
    let mut resp = None;
    for _ in 0..7 {
        if !rl::is_http(&url) {
            break;
        }
        let same = rl::origin(&url) == origin;
        let mut rb = client.request(if head_only { reqwest::Method::HEAD } else { reqwest::Method::GET }, url.as_str());
        for (k, v) in rl::fetch_headers(headers, range, UA, same) {
            if reqwest::header::HeaderName::from_bytes(k.as_bytes()).is_ok() && reqwest::header::HeaderValue::from_str(&v).is_ok() {
                rb = rb.header(k.as_str(), v.as_str());
            }
        }
        let r = match tauri::async_runtime::block_on(rb.send()) {
            Ok(r) => r,
            Err(_) => break,
        };
        let code = r.status().as_u16();
        let loc = r.headers().get("location").and_then(|v| v.to_str().ok()).map(|v| v.to_string());
        match (code, loc) {
            (300..=399, Some(l)) => url = rl::join(&url, &l),
            _ => {
                resp = Some(r);
                break;
            }
        }
    }
    let mut resp = match resp {
        Some(r) => r,
        None => {
            plain(s, 502);
            return;
        }
    };
    let ctype = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let final_url = url.clone();
    if !is_sub && resp.status().as_u16() < 400 && rl::is_playlist(&ctype, &final_url) {
        if resp.content_length().unwrap_or(0) as usize > rl::MAX_LIST {
            plain(s, 502);
            return;
        }
        let mut raw: Vec<u8> = Vec::new();
        if !head_only {
            while let Ok(Some(b)) = tauri::async_runtime::block_on(resp.chunk()) {
                raw.extend_from_slice(&b);
                if raw.len() > rl::MAX_LIST {
                    plain(s, 502);
                    return;
                }
            }
        }
        let text = String::from_utf8_lossy(&raw).to_string();
        let body = match sessions().lock() {
            Ok(mut m) => match m.get_mut(id) {
                Some(l) => rl::rewrite(&text, &final_url, at, &mut l.s),
                None => {
                    plain(s, 403);
                    return;
                }
            },
            Err(_) => String::new(),
        };
        let h = vec![("Content-Type".to_string(), "application/vnd.apple.mpegurl".to_string()), ("Content-Length".to_string(), body.len().to_string()), ("Cache-Control".to_string(), "no-store".to_string())];
        if head(s, 200, h).is_ok() && !head_only {
            let _ = s.write_all(body.as_bytes());
        }
        return;
    }
    let mut pass: Vec<(String, String)> = Vec::new();
    for k in sl::PASS_HEADERS.iter() {
        if let Some(v) = resp.headers().get(*k).and_then(|v| v.to_str().ok()) {
            pass.push((k.to_string(), v.to_string()));
        }
    }
    if head(s, resp.status().as_u16(), pass).is_err() || head_only {
        return;
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
}

/* ---------- the players ---------- */
struct Proc {
    child: Arc<Mutex<Option<Child>>>,
    running: Arc<AtomicBool>,
    code: Arc<Mutex<Option<i32>>>,
    pos: Arc<Mutex<Option<f64>>>,
    dur: Arc<Mutex<Option<f64>>>,
    eof: Arc<AtomicBool>,
    ipc: String,
    started: Instant,
}
fn procs() -> &'static Mutex<HashMap<String, Proc>> {
    static P: OnceLock<Mutex<HashMap<String, Proc>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}
static SEQ: AtomicU64 = AtomicU64::new(0);
const OS: &str = if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" };

/// %VAR% from the environment; an absolute path that is a file; a bare name on the PATH's absolute folders only.
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
        if !dir.is_absolute() {
            continue;
        }
        for e in &exts {
            let f = if x.to_ascii_lowercase().ends_with(e.as_str()) { dir.join(&x) } else { dir.join(format!("{}{}", x, e)) };
            if f.is_file() {
                return Some(f);
            }
        }
    }
    None
}
fn path_of(id: &str) -> Option<PathBuf> {
    let k = rl::known(id)?;
    let list = k.paths.iter().find(|(os, _)| *os == OS)?.1;
    list.iter().find_map(|p| resolve(p))
}
fn store_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("ext-player.json"))
}
fn store(app: &AppHandle) -> Value {
    store_file(app).ok().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}))
}
fn save(app: &AppHandle, v: &Value) -> Result<(), String> {
    let f = store_file(app)?;
    if let Some(d) = f.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    std::fs::write(f, v.to_string()).map_err(|e| e.to_string())
}

/// kt:extPlayers() → { found: [{ id, name }], chosen: { path, args, there } | null }.
#[tauri::command]
pub async fn kt_ext_players(app: AppHandle) -> Result<Value, String> {
    static SWEPT: std::sync::Once = std::sync::Once::new();
    SWEPT.call_once(sweep_subs);
    let found: Vec<Value> = rl::KNOWN.iter().filter(|k| path_of(k.id).is_some()).map(|k| json!({ "id": k.id, "name": k.name })).collect();
    let s = store(&app);
    let chosen = s.get("path").and_then(|v| v.as_str()).filter(|p| !p.is_empty()).map(|p| json!({ "path": p, "args": s.get("args").and_then(|v| v.as_str()).unwrap_or(""), "there": PathBuf::from(p).is_file() }));
    Ok(json!({ "found": found, "chosen": chosen }))
}
/// kt:extPlayerChoose({ title }) → { path } | null: the program picked in this shell's own dialog, kept here.
#[tauri::command]
pub async fn kt_ext_player_choose(app: AppHandle, o: Value) -> Result<Value, String> {
    let picked = shell::pick_files(&app, &json!({ "title": o.get("title").cloned().unwrap_or(Value::Null) }))?;
    let p = match picked.and_then(|v| v.into_iter().next()) {
        Some(p) => PathBuf::from(p),
        None => return Ok(Value::Null),
    };
    // (A Mac's dialog gives the application bundle: its program is Contents/MacOS/<CFBundleExecutable>.)
    let p = if p.extension().map(|e| e.eq_ignore_ascii_case("app")).unwrap_or(false) && p.is_dir() { bundle_program(&p).ok_or("kt-ext:notprogram")? } else { p };
    // (No shell is ever used, so a .bat or .cmd cannot be run as a player.)
    if cfg!(windows) && p.extension().map(|e| e.eq_ignore_ascii_case("bat") || e.eq_ignore_ascii_case("cmd")).unwrap_or(false) {
        return Err("kt-ext:batch".into());
    }
    if !p.is_absolute() || !p.is_file() {
        return Err("kt-ext:notprogram".into());
    }
    let mut s = store(&app);
    s["path"] = json!(p.to_string_lossy());
    save(&app, &s)?;
    Ok(json!({ "path": p.to_string_lossy() }))
}
fn bundle_program(app: &std::path::Path) -> Option<PathBuf> {
    let mac = app.join("Contents").join("MacOS");
    // (IINA's own command-line door: IINA.app's main program opens a window and takes no mpv options.)
    let cli = mac.join("iina-cli");
    if cli.is_file() {
        return Some(cli);
    }
    let raw = std::fs::read(app.join("Contents").join("Info.plist")).unwrap_or_default();
    let name = if raw.starts_with(b"bplist00") {
        rl::bplist_string(&raw, "CFBundleExecutable")
    } else {
        let plist = String::from_utf8_lossy(&raw).to_string();
        plist.find("<key>CFBundleExecutable</key>").and_then(|i| {
            let rest = &plist[i..];
            let a = rest.find("<string>")? + 8;
            let b = rest[a..].find("</string>")?;
            Some(rest[a..a + b].trim().to_string())
        })
    };
    let name = match name {
        Some(n) if !n.is_empty() && !n.contains(['/', '\\']) && n != "." && n != ".." => n,
        _ => app.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
    };
    let f = mac.join(name);
    if f.is_file() { Some(f) } else { None }
}
fn sub_name_ok(n: &str) -> bool {
    n.starts_with("kt-sub-") && n.len() < 120 && n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.') && [".srt", ".ass", ".ssa", ".vtt"].iter().any(|e| n.ends_with(e))
}
/// The subtitle copies saved for players that read only files, an hour old or more: removed.
fn sweep_subs() {
    let tmp = std::env::temp_dir();
    for d in [tmp.clone(), tmp.join("kurokawa-clip")] {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                let old = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).map(|a| a.as_secs() > 3600).unwrap_or(false);
                if sub_name_ok(&n) && old {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
}
/// kt:extPlayerDropSub({ path }): one subtitle copy removed once its player has ended.
#[tauri::command]
pub async fn kt_ext_player_drop_sub(o: Value) -> Result<Value, String> {
    let p = PathBuf::from(o.get("path").and_then(|v| v.as_str()).unwrap_or(""));
    let tmp = std::env::temp_dir();
    let ok = p.is_absolute() && p.file_name().map(|n| sub_name_ok(&n.to_string_lossy())).unwrap_or(false) && p.parent().map(|d| d == tmp || d == tmp.join("kurokawa-clip")).unwrap_or(false);
    if ok {
        let _ = std::fs::remove_file(&p);
    }
    Ok(json!({ "ok": ok }))
}
/// kt:extPlayerArgs({ args }): the chosen program's arguments line, kept with it here.
#[tauri::command]
pub async fn kt_ext_player_args(app: AppHandle, o: Value) -> Result<Value, String> {
    let a: String = o.get("args").and_then(|v| v.as_str()).unwrap_or("").chars().take(2000).collect();
    let mut s = store(&app);
    s["args"] = json!(a);
    save(&app, &s)?;
    Ok(json!({ "ok": true }))
}
#[tauri::command]
pub async fn kt_ext_player_forget(app: AppHandle) -> Result<Value, String> {
    save(&app, &json!({}))?;
    Ok(json!({ "ok": true }))
}

fn strs(v: Option<&Value>) -> Vec<String> {
    v.and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default()
}
/// kt:extPlayerStart({ player, target, title, start, subs, headers, slang, alang }) → { id, reports }.
#[tauri::command]
pub async fn kt_ext_player_start(app: AppHandle, o: Value) -> Result<Value, String> {
    let player = o.get("player").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let (exe, template) = if player == "chosen" {
        let s = store(&app);
        let p = s.get("path").and_then(|v| v.as_str()).map(PathBuf::from).filter(|p| p.is_absolute() && p.is_file());
        (p, s.get("args").and_then(|v| v.as_str()).unwrap_or("").to_string())
    } else {
        (path_of(&player), String::new())
    };
    let exe = exe.ok_or("not installed")?;
    let h = o.get("headers").cloned().unwrap_or(json!({}));
    let req = Req {
        target: o.get("target").and_then(|v| v.as_str()).unwrap_or("").into(),
        title: o.get("title").and_then(|v| v.as_str()).unwrap_or("").into(),
        start: o.get("start").and_then(|v| v.as_f64()).unwrap_or(0.0),
        subs: o.get("subs").and_then(|v| v.as_array()).cloned().unwrap_or_default().iter().map(|x| (x.get("at").and_then(|v| v.as_str()).unwrap_or("").to_string(), x.get("isDefault").and_then(|v| v.as_bool()).unwrap_or(false))).collect(),
        ua: h.get("ua").and_then(|v| v.as_str()).map(|s| s.to_string()),
        referer: h.get("referer").and_then(|v| v.as_str()).map(|s| s.to_string()),
        others: h.get("others").and_then(|v| v.as_array()).cloned().unwrap_or_default().iter().filter_map(|kv| Some((kv.get(0)?.as_str()?.to_string(), kv.get(1)?.as_str()?.to_string()))).collect(),
        slang: strs(o.get("slang")),
        alang: strs(o.get("alang")),
        fonts_dir: o.get("fontsDir").and_then(|v| v.as_str()).unwrap_or("").into(),
    };
    let tmp = std::env::temp_dir();
    let q = rl::check(req, &[tmp.clone(), tmp.join("kurokawa-clip")]).map_err(|e| format!("refused: {}", e))?;
    let (args, ipc) = rl::build(if player == "chosen" { "custom" } else { &player }, &q, &template);
    let rnd: String = sl::new_token().chars().take(12).collect();
    let ipc_path = if !ipc {
        String::new()
    } else if cfg!(windows) {
        format!(r"\\.\pipe\kt-mpv-{}", rnd)
    } else {
        tmp.join(format!("kt-mpv-{}.sock", rnd)).to_string_lossy().to_string()
    };
    // (The socket's path goes into mpv's --input-ipc-server only, never into a title or an address.)
    let args: Vec<String> = args.into_iter().map(|a| if ipc && a == "--input-ipc-server=${ipc}" { format!("--input-ipc-server={}", ipc_path) } else { a }).collect();
    let child = Command::new(&exe).args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    let id = (SEQ.fetch_add(1, Ordering::SeqCst) + 1).to_string();
    let p = Proc { child: Arc::new(Mutex::new(Some(child))), running: Arc::new(AtomicBool::new(true)), code: Arc::new(Mutex::new(None)), pos: Arc::new(Mutex::new(None)), dur: Arc::new(Mutex::new(None)), eof: Arc::new(AtomicBool::new(false)), ipc: ipc_path.clone(), started: Instant::now() };
    // (Reaped here as soon as it ends, whether or not the page asks: no zombie when the page went away.)
    {
        let (child, running, code, ipcp) = (p.child.clone(), p.running.clone(), p.code.clone(), p.ipc.clone());
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(500));
            let mut g = match child.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            let ended = match g.as_mut() {
                Some(c) => match c.try_wait() {
                    Ok(Some(st)) => Some(st.code()),
                    Ok(None) => None,
                    Err(_) => Some(None),
                },
                None => Some(None),
            };
            if let Some(c) = ended {
                *g = None;
                if let Ok(mut k) = code.lock() {
                    *k = c;
                }
                running.store(false, Ordering::SeqCst);
                if !ipcp.is_empty() && !cfg!(windows) {
                    let _ = std::fs::remove_file(&ipcp);
                }
                return;
            }
        });
    }
    if ipc {
        let (running, pos, dur, eof) = (p.running.clone(), p.pos.clone(), p.dur.clone(), p.eof.clone());
        thread::spawn(move || observe(&ipc_path, running, pos, dur, eof));
    }
    let mut m = procs().lock().map_err(|e| e.to_string())?;
    // (Records a reloaded page no longer asks about: let go after a day.)
    m.retain(|_, x| x.running.load(Ordering::SeqCst) || x.started.elapsed() < Duration::from_secs(24 * 3600));
    m.insert(id.clone(), p);
    Ok(json!({ "id": id, "reports": ipc }))
}
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
    let running = p.running.load(Ordering::SeqCst);
    let pos = *p.pos.lock().unwrap_or_else(|e| e.into_inner());
    let dur = *p.dur.lock().unwrap_or_else(|e| e.into_inner());
    let code = *p.code.lock().unwrap_or_else(|e| e.into_inner());
    let r = json!({ "running": running, "code": code, "pos": pos, "dur": dur, "eof": p.eof.load(Ordering::SeqCst) });
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
    let ok = match m.get_mut(&id) {
        Some(p) => p.child.lock().ok().and_then(|mut g| g.as_mut().map(|c| c.kill().is_ok())).unwrap_or(false),
        None => false,
    };
    Ok(json!({ "ok": ok }))
}
