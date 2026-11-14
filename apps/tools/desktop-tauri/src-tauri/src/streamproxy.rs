// The stream server's routes that run something (stage P4): desktop/streamproxy.cjs's /p (an online source fetched
// with the headers the page's <video> cannot send — the app's own client, its cookies and DNS over HTTPS —, ranges
// passed through, an HLS playlist remuxed into fragmented MP4 by ffmpeg) and /audio (one audio track as AAC), and
// desktop/transcode.cjs's /video (the picture turned into H.264 — the graphics card's encoder when one works, else x264
// — or VP9, as it plays). ffmpeg's arguments are kt-core's streamlogic.rs, word for word Electron's. ffmpeg itself: the
// pack in the app's data folder (<app data>/packs/ffmpeg/, where the packs stage — P5 — puts it), else one on the PATH;
// none → the route answers «pack:ffmpeg» as Electron's. Each ffmpeg is killed when its reader leaves or the server stops.
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use kt_core::streamlogic as sl;
use kurokawa_shell::{net, reqwest, util};

use crate::streamserver::{simple, write_head};

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
/// transcode.cjs's `chosen`: the encoder found to work here (asked once; x264 after a card's encoder failed a file).
static CHOSEN: Mutex<Option<String>> = Mutex::new(None);

/// Where the app keeps its data (the ffmpeg pack's folder is under it). Called once at start.
pub fn init(data_dir: PathBuf) {
    let _ = DATA_DIR.set(data_dir);
}

/// ffmpeg.cjs's binary(): the pack, else the PATH's.
pub fn ffmpeg_binary() -> String {
    let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    if let Some(d) = DATA_DIR.get() {
        let p = d.join("packs").join("ffmpeg").join(exe);
        if p.is_file() {
            return p.to_string_lossy().into_owned();
        }
    }
    exe.to_string()
}

#[cfg(windows)]
fn no_window(c: &mut Command) {
    use std::os::windows::process::CommandExt;
    c.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn no_window(_c: &mut Command) {}

fn spawn_ffmpeg(args: &[String]) -> std::io::Result<Child> {
    let mut c = Command::new(ffmpeg_binary());
    c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut c);
    c.spawn()
}

/// What a run of ffmpeg gave: whether any bytes went out, its exit code, the end of what it said.
struct Pumped {
    any: bool,
    code: Option<i32>,
    err: String,
}

/// ffmpeg's output copied to the reader; `first` called before the first bytes (to send the head). ffmpeg killed when
/// the reader leaves (a watcher looks every 300 ms) or the server stops.
fn pump(mut child: Child, s: &mut TcpStream, stop: &Arc<AtomicBool>, first: &mut dyn FnMut(&mut TcpStream) -> std::io::Result<()>) -> Pumped {
    let mut out = match child.stdout.take() {
        Some(o) => o,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Pumped { any: false, code: None, err: "no output".into() };
        }
    };
    let tail = Arc::new(Mutex::new(String::new()));
    if let Some(mut e) = child.stderr.take() {
        let t = tail.clone();
        thread::spawn(move || {
            let mut b = [0u8; 2048];
            while let Ok(n) = e.read(&mut b) {
                if n == 0 {
                    break;
                }
                if let Ok(mut g) = t.lock() {
                    g.push_str(&String::from_utf8_lossy(&b[..n]));
                    if g.len() > 4000 {
                        let cut = g.len() - 2000;
                        let at = (cut..g.len()).find(|i| g.is_char_boundary(*i)).unwrap_or(g.len());
                        g.drain(..at);
                    }
                }
            }
        });
    }
    let child = Arc::new(Mutex::new(child));
    let finished = Arc::new(AtomicBool::new(false));
    // (The watcher: a blocking peek with a short timeout on a copy of the socket — the copy shares the socket, so it
    // must not be made non-blocking while the copier writes —; the reader gone or the server stopping → ffmpeg killed.)
    if let Ok(watch) = s.try_clone() {
        let (c, f, st) = (child.clone(), finished.clone(), stop.clone());
        thread::spawn(move || {
            let _ = watch.set_read_timeout(Some(Duration::from_millis(300)));
            let mut b = [0u8; 1];
            loop {
                if f.load(Ordering::SeqCst) {
                    break;
                }
                let gone = st.load(Ordering::SeqCst)
                    || match watch.peek(&mut b) {
                        Ok(0) => true,
                        Ok(_) => {
                            thread::sleep(Duration::from_millis(300));
                            false
                        }
                        Err(e) => !matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut),
                    };
                if gone {
                    if let Ok(mut g) = c.lock() {
                        let _ = g.kill();
                    }
                    break;
                }
            }
        });
    }
    let mut any = false;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = match out.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if !any {
            any = true;
            if first(s).is_err() {
                break;
            }
        }
        if s.write_all(&buf[..n]).is_err() {
            break;
        }
    }
    finished.store(true, Ordering::SeqCst);
    let code = match child.lock() {
        Ok(mut g) => {
            let _ = g.kill();
            g.wait().ok().and_then(|st| st.code())
        }
        Err(_) => None,
    };
    let err = tail.lock().map(|g| g.trim().lines().last().unwrap_or("").to_string()).unwrap_or_default();
    Pumped { any, code, err }
}

fn not_found(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::NotFound
}

/* ---------- /audio ---------- */

/// streamproxy.cjs's audio(): one audio track of `src` from `ss` seconds, as AAC (ADTS).
pub fn audio(s: &mut TcpStream, query: &str, head_only: bool, stop: &Arc<AtomicBool>) {
    let src = sl::query_get(query, "src").unwrap_or_default();
    let ss = sl::js_num(sl::num_or_zero(sl::query_get(query, "ss").as_deref()));
    let a = sl::js_num(sl::num_or_zero(sl::query_get(query, "a").as_deref()));
    let h = vec![("Content-Type".to_string(), "audio/aac".to_string()), ("Cache-Control".to_string(), "no-store".to_string())];
    if write_head(s, 200, h).is_err() || head_only || src.is_empty() {
        return;
    }
    if let Ok(c) = spawn_ffmpeg(&sl::audio_args(&src, &ss, &a)) {
        pump(c, s, stop, &mut |_s: &mut TcpStream| -> std::io::Result<()> { Ok(()) });
    }
}

/* ---------- /video ---------- */

/// transcode.cjs's works(): one second of test picture through `enc`, 15 s at most.
fn works(enc: &str) -> bool {
    let mut c = Command::new(ffmpeg_binary());
    c.args(sl::encoder_probe_args(enc)).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    no_window(&mut c);
    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(_) => return false,
    };
    let until = Instant::now() + Duration::from_secs(15);
    loop {
        match child.try_wait() {
            Ok(Some(st)) => return st.success(),
            Ok(None) if Instant::now() < until => thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// transcode.cjs's encoder(): KT_TRANSCODE_ENCODER, else the first of the card's encoders that works here, else x264
/// (asked once; the others wait for that answer).
fn encoder() -> String {
    if let Ok(e) = std::env::var("KT_TRANSCODE_ENCODER") {
        if !e.is_empty() {
            return e;
        }
    }
    let mut g = match CHOSEN.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    if let Some(e) = g.as_ref() {
        return e.clone();
    }
    let mut pick = "libx264".to_string();
    for e in sl::encoder_candidates(util::node_platform()) {
        if works(e) {
            pick = e.to_string();
            break;
        }
    }
    *g = Some(pick.clone());
    pick
}

/// transcode.cjs's serve(): /video?src=&ss=&a=&c= — the head sent with ffmpeg's first bytes, so a card's encoder that
/// fails at once is replaced by x264 within the same request.
pub fn video(s: &mut TcpStream, query: &str, head_only: bool, stop: &Arc<AtomicBool>) {
    let src = sl::query_get(query, "src").unwrap_or_default();
    let ss = sl::num_or_zero(sl::query_get(query, "ss").as_deref()).max(0.0);
    let a = sl::num_or_zero(sl::query_get(query, "a").as_deref()).max(0.0).floor() as u64;
    let vp9 = sl::query_get(query, "c").as_deref() == Some("vp9");
    let ctype = if vp9 { "video/webm" } else { "video/mp4" };
    if head_only || src.is_empty() {
        let h = vec![("Content-Type".to_string(), ctype.to_string()), ("Cache-Control".to_string(), "no-store".to_string()), ("Content-Length".to_string(), "0".to_string())];
        let _ = write_head(s, if src.is_empty() { 400 } else { 200 }, h);
        return;
    }
    let mut enc = if vp9 { "libvpx-vp9".to_string() } else { encoder() };
    for _attempt in 0..2 {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let child = match spawn_ffmpeg(&sl::transcode_args(&src, ss, a, &enc)) {
            Ok(c) => c,
            Err(e) => {
                simple(s, 502, &if not_found(&e) { "pack:ffmpeg".to_string() } else { e.to_string() });
                return;
            }
        };
        let e2 = enc.clone();
        let p = pump(child, s, stop, &mut |w: &mut TcpStream| -> std::io::Result<()> {
            write_head(
                w,
                200,
                vec![("Content-Type".into(), ctype.to_string()), ("Cache-Control".into(), "no-store".into()), ("X-KT-Encoder".into(), e2.clone())],
            )
        });
        if p.any {
            return;
        }
        if enc == "libx264" || enc == "libvpx-vp9" {
            let why = if p.err.is_empty() { format!("ffmpeg {}", p.code.map(|c| c.to_string()).unwrap_or_default()) } else { p.err };
            simple(s, 502, &why);
            return;
        }
        // (The card's encoder refused this file: x264 from now on.)
        if let Ok(mut g) = CHOSEN.lock() {
            *g = Some("libx264".into());
        }
        enc = "libx264".into();
    }
}

/* ---------- /p ---------- */

/// The page's headers from the address's «h» (JSON), the Chrome-like user agent first unless the page gave one.
fn page_headers(query: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    if let Some(h) = sl::query_get(query, "h") {
        if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(&h) {
            for (k, v) in m {
                let v = match v {
                    Value::String(s) => s,
                    Value::Null => "null".to_string(),
                    other => other.to_string(),
                };
                out.push((k, v));
            }
        }
    }
    sl::proxy_headers(&out)
}

/// streamproxy.cjs's remux(): an HLS stream copied into fragmented MP4 as it comes.
fn remux(s: &mut TcpStream, url: &str, headers: &[(String, String)], head_only: bool, stop: &Arc<AtomicBool>) {
    let h = vec![("Content-Type".to_string(), "video/mp4".to_string()), ("Cache-Control".to_string(), "no-store".to_string())];
    if write_head(s, 200, h).is_err() || head_only {
        return;
    }
    if let Ok(c) = spawn_ffmpeg(&sl::remux_args(url, headers)) {
        let p = pump(c, s, stop, &mut |_s: &mut TcpStream| -> std::io::Result<()> { Ok(()) });
        if p.code.unwrap_or(0) != 0 && !p.err.is_empty() {
            eprintln!("streamproxy ffmpeg: {}", p.err);
        }
    }
}

/// streamproxy.cjs's serve() for /p: the source fetched with the page's headers and the player's range; its status and
/// the headers a player needs passed back, the body as it comes.
pub fn proxy(s: &mut TcpStream, query: &str, req: &sl::Head, head_only: bool, stop: &Arc<AtomicBool>) {
    let u = sl::query_get(query, "u").unwrap_or_default();
    let headers = page_headers(query);
    if sl::is_playlist("", &u) {
        remux(s, &u, &headers, head_only, stop);
        return;
    }
    let client = match net::client() {
        Ok(c) => c,
        Err(e) => {
            simple(s, 502, &e);
            return;
        }
    };
    let method = if head_only { reqwest::Method::HEAD } else { reqwest::Method::GET };
    let mut rb = client.request(method, u.as_str());
    for (k, v) in headers.iter() {
        if reqwest::header::HeaderName::from_bytes(k.as_bytes()).is_ok() && reqwest::header::HeaderValue::from_str(v).is_ok() {
            rb = rb.header(k.as_str(), v.as_str());
        }
    }
    if let Some(r) = req.header("range") {
        rb = rb.header("range", r);
    }
    let mut resp = match tauri::async_runtime::block_on(rb.send()) {
        Ok(r) => r,
        Err(e) => {
            simple(s, 502, &e.to_string());
            return;
        }
    };
    let ctype = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let final_url = resp.url().to_string();
    if sl::is_playlist(&ctype, &final_url) {
        drop(resp);
        remux(s, &final_url, &headers, head_only, stop);
        return;
    }
    let mut pass: Vec<(String, String)> = Vec::new();
    for k in sl::PASS_HEADERS.iter() {
        if let Some(v) = resp.headers().get(*k).and_then(|v| v.to_str().ok()) {
            pass.push((k.to_string(), v.to_string()));
        }
    }
    if write_head(s, resp.status().as_u16(), pass).is_err() || head_only {
        return;
    }
    while !stop.load(Ordering::SeqCst) {
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
