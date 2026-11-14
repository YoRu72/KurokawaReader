// The self-test's side of torrent streaming (stage P4; only in a self-test run — the command refuses otherwise):
// - a stand-in engine whose pieces the test lets in one by one (`release`), so the stream server's waiting, seeking
//   while buffering, many readers at once and withdrawal are checked on every system, with no torrent at all;
// - a real swarm on loopback: a torrent MADE HERE from made-up bytes (torrentmake.rs: two files, a folder, private —
//   no DHT, no peer exchange), a tiny HTTP tracker on 127.0.0.1 that names one peer, and that peer a second aria2c
//   bound to 127.0.0.1 seeding the bytes (DHT, LPD and peer exchange off, its upload held to 256 KiB/s so the player's
//   reads wait for pieces); the app's own engine downloads it, the page streams it;
// - the server stopped: its port free again, every connection ended.
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use kt_core::streamlogic as sl;
use kurokawa_shell::util;

use crate::engine;
use crate::stream_engine::{FileEntry, Source, StreamEngine};
use crate::streamserver;
use crate::torrentmake as tm;

pub const FAKE_ID: &str = "kt-selftest-stream";

/* ---------- the stand-in engine ---------- */

pub struct FakeEngine {
    data: Vec<u8>,
    piece: u64,
    have: Mutex<Vec<bool>>,
}

impl FakeEngine {
    fn pieces(&self) -> u64 {
        (self.data.len() as u64).div_ceil(self.piece)
    }

    fn has(&self, a: u64, b: u64) -> bool {
        match self.have.lock() {
            Ok(h) => (a..=b).all(|i| h.get(i as usize).copied().unwrap_or(false)),
            Err(_) => false,
        }
    }

    fn bitfield(&self) -> String {
        let h = match self.have.lock() {
            Ok(h) => h.clone(),
            Err(_) => vec![],
        };
        let mut out = String::new();
        for c in h.chunks(4) {
            let mut n = 0u32;
            for (k, x) in c.iter().enumerate() {
                if *x {
                    n |= 8 >> k;
                }
            }
            out.push(std::char::from_digit(n, 16).unwrap_or('0'));
        }
        out
    }
}

impl StreamEngine for FakeEngine {
    fn name(&self) -> &'static str {
        "selftest"
    }
    fn add(&self, _src: &Source) -> Result<Vec<FileEntry>, String> {
        Ok(vec![self.file(FAKE_ID, 0)?])
    }
    fn select(&self, _id: &str, _index: usize) -> Result<(), String> {
        Ok(())
    }
    fn file(&self, _id: &str, index: usize) -> Result<FileEntry, String> {
        if index != 0 {
            return Err("no such file".into());
        }
        Ok(FileEntry { index: 0, name: "kt-selftest/stream test.mp4".into(), path: String::new(), size: self.data.len() as u64 })
    }
    fn prioritise(&self, _id: &str, _index: usize, _from: u64, _to: u64) {}
    fn read_at(&self, _id: &str, _index: usize, pos: u64, buf: &mut [u8], gone: &dyn Fn() -> bool) -> Result<usize, String> {
        let size = self.data.len() as u64;
        if pos >= size {
            return Ok(0);
        }
        let n = (buf.len() as u64).min(size - pos);
        let (a, b) = sl::pieces_of(0, pos, n, self.piece);
        loop {
            if gone() {
                return Err("gone".into());
            }
            if self.has(a, b) {
                buf[..n as usize].copy_from_slice(&self.data[pos as usize..(pos + n) as usize]);
                return Ok(n as usize);
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn stats(&self, _id: &str, _index: usize) -> Option<Value> {
        let bf = self.bitfield();
        let n = self.pieces();
        let got = sl::count_have(Some(&bf), n);
        let buffered: Vec<Value> = sl::buffered(Some(&bf), 0, self.data.len() as u64, self.piece, 64).into_iter().map(|(a, b)| json!([a, b])).collect();
        Some(json!({ "down": 0, "up": 0, "peers": 0, "progress": if n > 0 { got as f64 / n as f64 } else { 0.0 }, "buffered": buffered, "engine": "selftest" }))
    }
    fn stop(&self, _id: &str) {}
}

static FAKE: Mutex<Option<Arc<FakeEngine>>> = Mutex::new(None);

/* ---------- the swarm on loopback ---------- */

struct Swarm {
    seeder: Child,
    tracker_stop: Arc<AtomicBool>,
    tracker_port: u16,
    root: PathBuf,
    files: Vec<Vec<u8>>,
}

static SWARM: Mutex<Option<Swarm>> = Mutex::new(None);

#[cfg(windows)]
fn no_window(c: &mut Command) {
    use std::os::windows::process::CommandExt;
    c.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn no_window(_c: &mut Command) {}

/// A free port on 127.0.0.1 (asked of the system, then let go for the seeder to take).
fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let p = l.local_addr().map_err(|e| e.to_string())?.port();
    Ok(p)
}

/// The tracker: any request answered with the one peer (and a short interval, so a leecher that came before the seeder
/// listened asks again soon).
fn tracker(peer_port: u16, stop: Arc<AtomicBool>) -> Result<u16, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = l.local_addr().map_err(|e| e.to_string())?.port();
    thread::spawn(move || {
        for c in l.incoming() {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let mut s = match c {
                Ok(s) => s,
                Err(_) => continue,
            };
            let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
            let mut raw = Vec::new();
            let mut b = [0u8; 2048];
            while sl::head_end(&raw).is_none() && raw.len() < 16384 {
                match s.read(&mut b) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => raw.extend_from_slice(&b[..n]),
                }
            }
            let body = tm::tracker_reply(&[([127, 0, 0, 1], peer_port)], 3);
            let head = format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = s.write_all(head.as_bytes());
            let _ = s.write_all(&body);
        }
    });
    Ok(port)
}

fn swarm_start() -> Result<Value, String> {
    swarm_stop();
    let bin = match engine::get().and_then(|e| e.find_binary()) {
        Some((b, _)) => b,
        None => return Ok(json!({ "skip": "no aria2c" })),
    };
    let pid = std::process::id();
    let name = format!("kt-swarm-{}", pid);
    let root = std::env::temp_dir().join(&name);
    let _ = std::fs::remove_dir_all(&root);
    let seed = root.join("seed");
    let leech = root.join("leech");
    std::fs::create_dir_all(seed.join(&name)).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&leech).map_err(|e| e.to_string())?;
    // (A file that does not end on a piece's edge, and a small one after it — the second file's bytes start inside a
    // piece of the first.)
    let video = tm::noise(2 * 1024 * 1024 + 12345, 0x5eed_0001 ^ pid as u64);
    let subs = tm::noise(3001, 0x5eed_0002 ^ pid as u64);
    std::fs::write(seed.join(&name).join("video.mp4"), &video).map_err(|e| e.to_string())?;
    std::fs::write(seed.join(&name).join("video.srt"), &subs).map_err(|e| e.to_string())?;
    let seed_port = free_port()?;
    let stop = Arc::new(AtomicBool::new(false));
    let tport = tracker(seed_port, stop.clone())?;
    let made = tm::make(&name, &[("video.mp4", &video), ("video.srt", &subs)], 32 * 1024, &format!("http://127.0.0.1:{}/announce", tport), true);
    let tfile = root.join("swarm.torrent");
    std::fs::write(&tfile, &made.torrent).map_err(|e| e.to_string())?;
    let mut c = Command::new(&bin);
    c.args([
        format!("--dir={}", seed.to_string_lossy()),
        "--no-conf=true".into(),
        "--check-integrity=true".into(),
        "--seed-ratio=0.0".into(),
        "--enable-dht=false".into(),
        "--enable-dht6=false".into(),
        "--bt-enable-lpd=false".into(),
        "--enable-peer-exchange=false".into(),
        "--disable-ipv6=true".into(),
        "--interface=127.0.0.1".into(),
        format!("--listen-port={}", seed_port),
        "--max-overall-upload-limit=256K".into(),
        "--file-allocation=none".into(),
        "--console-log-level=warn".into(),
        "--summary-interval=0".into(),
        format!("--stop-with-process={}", pid),
        format!("--torrent-file={}", tfile.to_string_lossy()),
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    no_window(&mut c);
    let mut child = c.spawn().map_err(|e| format!("seeder: {}", e))?;
    // (The seeder checks its bytes, then listens: waited for, 20 s at most.)
    let until = Instant::now() + Duration::from_secs(20);
    let mut listening = false;
    while Instant::now() < until {
        if let Ok(Some(st)) = child.try_wait() {
            stop.store(true, Ordering::SeqCst);
            return Err(format!("seeder ended: {}", st));
        }
        if TcpStream::connect_timeout(&SocketAddr::from(([127u8, 0, 0, 1], seed_port)), Duration::from_millis(300)).is_ok() {
            listening = true;
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    if !listening {
        let _ = child.kill();
        let _ = child.wait();
        stop.store(true, Ordering::SeqCst);
        return Err("the seeder did not listen in 20 s".into());
    }
    let out = json!({
        "torrentB64": util::b64_encode(&made.torrent),
        "infoHash": made.info_hash,
        "dir": leech.to_string_lossy().into_owned(),
        "name": name,
        "sizes": [video.len(), subs.len()],
        "seedPort": seed_port,
        "trackerPort": tport,
    });
    if let Ok(mut g) = SWARM.lock() {
        *g = Some(Swarm { seeder: child, tracker_stop: stop, tracker_port: tport, root, files: vec![video, subs] });
    }
    Ok(out)
}

fn swarm_stop() {
    let s = SWARM.lock().ok().and_then(|mut g| g.take());
    if let Some(mut s) = s {
        let _ = s.seeder.kill();
        let _ = s.seeder.wait();
        s.tracker_stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect_timeout(&SocketAddr::from(([127u8, 0, 0, 1], s.tracker_port)), Duration::from_millis(500));
        let _ = std::fs::remove_dir_all(&s.root);
    }
}

fn num(o: &Value, k: &str) -> u64 {
    o.get(k).and_then(|v| v.as_u64()).unwrap_or(0)
}

/// The self-test's torrent-streaming helper: `op` fake | release | live | swarm | bytes | swarmStop | serverStop.
#[tauri::command]
pub async fn kt_selftest_stream(o: Value) -> Result<Value, String> {
    if !kurokawa_shell::selftest::active() {
        return Err("not a self-test run".to_string());
    }
    let op = o.get("op").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let joined = tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        match op.as_str() {
            "fake" => {
                let size = num(&o, "size").max(1) as usize;
                let piece = num(&o, "piece").max(1024);
                let data = tm::noise(size, 0xfa4e ^ num(&o, "seed"));
                let n = (size as u64).div_ceil(piece) as usize;
                let eng = Arc::new(FakeEngine { data, piece, have: Mutex::new(vec![false; n]) });
                if let Ok(mut g) = FAKE.lock() {
                    *g = Some(eng.clone());
                }
                streamserver::done(FAKE_ID);
                let url = streamserver::open(eng.clone(), &Source { id: FAKE_ID.into(), ..Default::default() }, 0)?;
                Ok(json!({ "url": url, "id": FAKE_ID, "size": size, "pieces": n, "b64": util::b64_encode(&eng.data) }))
            }
            "release" => {
                let eng = FAKE.lock().ok().and_then(|g| g.clone()).ok_or("no stand-in engine")?;
                let (a, b) = (num(&o, "from") as usize, num(&o, "to") as usize);
                if let Ok(mut h) = eng.have.lock() {
                    let last = h.len().saturating_sub(1);
                    for x in h.iter_mut().take(b.min(last) + 1).skip(a) {
                        *x = true;
                    }
                }
                Ok(json!({ "bitfield": eng.bitfield() }))
            }
            "live" => Ok(json!({ "live": streamserver::live(), "port": streamserver::port() })),
            "swarm" => swarm_start(),
            "bytes" => {
                let g = SWARM.lock().map_err(|e| e.to_string())?;
                let s = g.as_ref().ok_or("no swarm")?;
                let f = s.files.get(num(&o, "file") as usize).ok_or("no such file")?;
                let from = (num(&o, "from") as usize).min(f.len());
                let to = (from + num(&o, "len") as usize).min(f.len());
                Ok(json!({ "b64": util::b64_encode(&f[from..to]) }))
            }
            "swarmStop" => {
                swarm_stop();
                Ok(json!({}))
            }
            "serverStop" => {
                let port = streamserver::port();
                let ended = streamserver::stop();
                let free = match port {
                    Some(p) => TcpListener::bind(("127.0.0.1", p)).is_ok(),
                    None => false,
                };
                Ok(json!({ "ended": ended, "portFree": free, "port": port, "live": streamserver::live() }))
            }
            _ => Err(format!("op {}", op)),
        }
    })
    .await;
    match joined {
        Ok(r) => r,
        Err(e) => Err(e.to_string()),
    }
}
