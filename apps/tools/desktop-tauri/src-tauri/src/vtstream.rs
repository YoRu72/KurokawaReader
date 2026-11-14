// Stage P5: the transcode stream the player uses (desktop/transcode.cjs, served in Electron by streamproxy.cjs) — a
// server on 127.0.0.1 (a free port, started on first use) answering
//   /video?src=&ss=&a=&c=  the picture as H.264 (or VP9 with c=vp9) + AAC, from `ss` seconds, as fragmented MP4 (WebM)
//                          made by ffmpeg as it plays: the graphics card's encoder when one works (asked once: NVENC,
//                          Quick Sync, AMF, VideoToolbox — KT_TRANSCODE_ENCODER names one), else x264; the answer's head
//                          goes out with ffmpeg's first bytes, so an encoder that fails at once is replaced by x264 within
//                          the same request; 502 with ffmpeg's last line (or «pack:ffmpeg») when nothing came;
//   /audio?src=&ss=&a=     one sound track from `ss` as AAC (ADTS), for sound the player cannot decode;
// (kt:videoUrl / kt:audioUrl give the two addresses.) The body runs until ffmpeg ends (no length; the connection
// closes); a reader that goes away ends ffmpeg's whole tree. ffmpeg runs as everywhere in the video tools (vtproc.rs).
// NOTE: this is the shell's own small server, kept apart from the torrent stream's Range server (stage P4, written
// in parallel); the two are to be merged into one loopback server later — streamproxy.cjs's /p, /f, /audio and /video.
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use kt_core::videotools as vt;
use kurokawa_shell::util;

use crate::{vtffmpeg, vtproc};

static PORT: Mutex<Option<u16>> = Mutex::new(None);
/// The encoder chosen (once; x264 after a card's encoder refused a file).
static CHOSEN: Mutex<Option<String>> = Mutex::new(None);
static PROBING: OnceLock<Mutex<()>> = OnceLock::new();

/// The server's port (started on first use).
pub fn port() -> Result<u16, String> {
    let mut g = PORT.lock().map_err(|_| "lock".to_string())?;
    if let Some(p) = *g {
        return Ok(p);
    }
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let p = l.local_addr().map_err(|e| e.to_string())?.port();
    thread::spawn(move || {
        for c in l.incoming().flatten() {
            thread::spawn(move || {
                let _ = serve(c);
            });
        }
    });
    *g = Some(p);
    Ok(p)
}

/// transcode.cjs encoder(): the first of the graphics card's encoders that works here, else x264 (asked once).
fn encoder() -> String {
    if let Ok(e) = std::env::var("KT_TRANSCODE_ENCODER") {
        if !e.is_empty() {
            return e;
        }
    }
    let _one = PROBING.get_or_init(|| Mutex::new(())).lock();
    if let Some(e) = CHOSEN.lock().ok().and_then(|g| g.clone()) {
        return e;
    }
    let mut pick = "libx264".to_string();
    for e in vt::encoder_candidates(util::node_platform()) {
        let ok = vtproc::run(&vtffmpeg::binary(), &vt::encoder_test_args(e), Duration::from_secs(15), 1 << 16).map(|r| r.code == Some(0) && !r.timed_out).unwrap_or(false);
        if ok {
            pick = e.to_string();
            break;
        }
    }
    if let Ok(mut g) = CHOSEN.lock() {
        *g = Some(pick.clone());
    }
    pick
}

fn head(out: &mut TcpStream, status: u16, ctype: Option<&str>, extra: &[(&str, &str)], length: Option<usize>) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Bad Gateway",
    };
    let mut h = format!("HTTP/1.1 {} {}\r\naccess-control-allow-origin: *\r\nconnection: close\r\n", status, reason);
    if let Some(t) = ctype {
        h.push_str(&format!("content-type: {}\r\ncache-control: no-store\r\n", t));
    }
    for (k, v) in extra {
        h.push_str(&format!("{}: {}\r\n", k, v));
    }
    if let Some(n) = length {
        h.push_str(&format!("content-length: {}\r\n", n));
    }
    h.push_str("\r\n");
    out.write_all(h.as_bytes())
}

fn serve(mut c: TcpStream) -> std::io::Result<()> {
    c.set_read_timeout(Some(Duration::from_secs(15)))?;
    let mut req: Vec<u8> = Vec::new();
    let mut b = [0u8; 1024];
    while !req.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = c.read(&mut b)?;
        if n == 0 || req.len() > 32768 {
            return Ok(());
        }
        req.extend_from_slice(&b[..n]);
    }
    c.set_read_timeout(None)?;
    let text = String::from_utf8_lossy(&req).into_owned();
    let first = text.lines().next().unwrap_or("");
    let mut parts = first.split(' ');
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target.clone(), String::new()),
    };
    let is_head = method == "HEAD";
    match path.as_str() {
        "/video" => video(c, &query, is_head),
        "/audio" => audio(c, &query, is_head),
        _ => {
            head(&mut c, 404, None, &[], Some(0))?;
            Ok(())
        }
    }
}

/// ffmpeg's stdout copied to the reader; the reader gone → the tree ended. → (any bytes sent, ffmpeg's stderr tail).
fn pump(c: &mut TcpStream, args: &[String], mut before_first: impl FnMut(&mut TcpStream) -> std::io::Result<()>) -> (bool, String) {
    let mut child = match vtproc::command(&vtffmpeg::binary(), args).spawn() {
        Ok(ch) => ch,
        Err(e) => return (false, if e.kind() == std::io::ErrorKind::NotFound { "pack:ffmpeg".to_string() } else { e.to_string() }),
    };
    let pid = child.id();
    let mut so = match child.stdout.take() {
        Some(s) => s,
        None => return (false, "no stdout".to_string()),
    };
    let se = child.stderr.take();
    let tail = thread::spawn(move || {
        let mut t: Vec<u8> = Vec::new();
        if let Some(mut se) = se {
            let mut b = [0u8; 4096];
            while let Ok(n) = se.read(&mut b) {
                if n == 0 {
                    break;
                }
                t.extend_from_slice(&b[..n]);
                if t.len() > 4000 {
                    t.drain(..t.len() - 2000);
                }
            }
        }
        String::from_utf8_lossy(&t).into_owned()
    });
    let mut buf = vec![0u8; 64 * 1024];
    let mut any = false;
    loop {
        let n = match so.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if !any {
            any = true;
            if before_first(c).is_err() {
                vtproc::kill_tree(pid);
                break;
            }
        }
        if c.write_all(&buf[..n]).is_err() {
            // (The player has gone: ffmpeg and anything it started ended.)
            vtproc::kill_tree(pid);
            break;
        }
    }
    let _ = child.wait();
    let err = tail.join().unwrap_or_default();
    (any, err)
}

fn video(mut c: TcpStream, query: &str, is_head: bool) -> std::io::Result<()> {
    let (src, ss, a, vp9) = vt::video_query(query);
    let ctype = if vp9 { "video/webm" } else { "video/mp4" };
    if is_head || src.is_empty() {
        head(&mut c, if src.is_empty() { 400 } else { 200 }, Some(ctype), &[], None)?;
        return Ok(());
    }
    let mut enc = if vp9 { "libvpx-vp9".to_string() } else { encoder() };
    for _ in 0..2 {
        let e2 = enc.clone();
        let (sent, err) = pump(&mut c, &vt::transcode_args(&src, ss, a, &enc), |c| head(c, 200, Some(ctype), &[("x-kt-encoder", e2.as_str())], None));
        if sent {
            return Ok(());
        }
        let last = err.trim().split('\n').last().unwrap_or("").to_string();
        if enc == "libx264" || enc == "libvpx-vp9" || err.contains("pack:ffmpeg") {
            let msg = if last.is_empty() { "ffmpeg failed".to_string() } else { last };
            head(&mut c, 502, None, &[], Some(msg.len()))?;
            c.write_all(msg.as_bytes())?;
            return Ok(());
        }
        // (The card's encoder refused this file: x264 from now on.)
        if let Ok(mut g) = CHOSEN.lock() {
            *g = Some("libx264".to_string());
        }
        enc = "libx264".to_string();
    }
    Ok(())
}

fn audio(mut c: TcpStream, query: &str, is_head: bool) -> std::io::Result<()> {
    let (src, ss, a) = vt::audio_query(query);
    head(&mut c, 200, Some("audio/aac"), &[], None)?;
    if is_head || src.is_empty() {
        return Ok(());
    }
    let _ = pump(&mut c, &vt::audio_args(&src, &ss, &a), |_| Ok(()));
    Ok(())
}

/// kt:videoUrl → { url } of /video.
#[tauri::command]
pub async fn kt_video_url() -> Result<Value, String> {
    Ok(json!({ "url": format!("http://127.0.0.1:{}/video", port()?) }))
}

/// kt:audioUrl → { url } of /audio.
#[tauri::command]
pub async fn kt_audio_url() -> Result<Value, String> {
    Ok(json!({ "url": format!("http://127.0.0.1:{}/audio", port()?) }))
}
