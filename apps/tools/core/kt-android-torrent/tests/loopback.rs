//! Stage M3's proof of the real backend (CI only: librqbit cannot be built where this was written): the library's own
//! `tor.*` methods — the same ones Java calls through JNI — against a LOOPBACK swarm made here: a made-up file, a
//! private .torrent of it (the PC self-test's torrentmake.rs), an HTTP tracker on 127.0.0.1 that names one peer, and
//! aria2c seeding it on 127.0.0.1 (KT_ARIA2C, else `aria2c` on the PATH; its upload held to 512 KiB/s so the download
//! takes seconds). DHT off, no public tracker. Checked: add → metadata → downloading → done with identical bytes on the
//! disk; a far range streamed before the middle is in; pause / resume; remove; a forced failure (a folder librqbit
//! cannot write) told as «restartClassic». Run: `cargo test --release --test loopback -- --nocapture`.

#[path = "../../../desktop-tauri/src-tauri/src/torrentmake.rs"]
#[allow(dead_code)]
mod tm;

use kt_core::vidjson::{self, J};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn c(m: &str, args: &str) -> Result<J, String> {
    kt_torrent::dispatch::call_json(m, &vidjson::parse(args).unwrap())
}
fn q(s: &str) -> String {
    J::s(s).to_json()
}
fn b64(b: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut o = String::new();
    for ch in b.chunks(3) {
        let n = (ch[0] as u32) << 16 | (*ch.get(1).unwrap_or(&0) as u32) << 8 | *ch.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= ch.len() {
                o.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                o.push('=');
            }
        }
    }
    o
}
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}
fn tracker(peer: u16) -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for s in l.incoming() {
            let Ok(mut s) = s else { continue };
            let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
            let mut b = [0u8; 4096];
            let _ = s.read(&mut b);
            let body = tm::tracker_reply(&[([127, 0, 0, 1], peer)], 3);
            let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes());
            let _ = s.write_all(&body);
        }
    });
    port
}
struct Seeder(Child);
impl Drop for Seeder {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn poll_row(id: &str, until: impl Fn(&J) -> bool, secs: u64) -> J {
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(secs) {
        let p = c("tor.poll", r#"{"now":1,"seed":false,"ratioPct":0,"minutes":0,"held":false}"#).unwrap();
        for f in p.get("failed").unwrap().as_arr().unwrap() {
            if f.get("id").and_then(|x| x.as_str()) == Some(id) {
                panic!("{} failed: {}", id, f.to_json());
            }
        }
        for r in p.get("rows").unwrap().as_arr().unwrap() {
            if r.get("id").and_then(|x| x.as_str()) == Some(id) {
                println!("  {}", r.to_json().chars().take(240).collect::<String>());
                if until(r) {
                    return r.clone();
                }
            }
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    panic!("{}: not reached in {} s", id, secs)
}
fn state_is(s: &'static str) -> impl Fn(&J) -> bool {
    move |r: &J| r.get("state").and_then(|x| x.as_str()) == Some(s)
}

#[test]
fn loopback_swarm() {
    let root = std::env::temp_dir().join(format!("kt-tor-loop-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let (seed, leech, data) = (root.join("seed"), root.join("leech"), root.join("rqbit"));
    std::fs::create_dir_all(&seed).unwrap();
    std::fs::create_dir_all(&leech).unwrap();
    let len = 12 << 20;
    let body = tm::noise(len, 7);
    std::fs::write(seed.join("made-up.mkv"), &body).unwrap();
    let seed_port = free_port();
    let tport = tracker(seed_port);
    let made = tm::make("made-up.mkv", &[("made-up.mkv", &body)], 32 * 1024, &format!("http://127.0.0.1:{}/announce", tport), true);
    let tfile = root.join("t.torrent");
    std::fs::write(&tfile, &made.torrent).unwrap();
    let bin = std::env::var("KT_ARIA2C").unwrap_or_else(|_| "aria2c".into());
    let child = Command::new(&bin)
        .args([
            format!("--dir={}", seed.display()),
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
            "--max-overall-upload-limit=512K".into(),
            "--file-allocation=none".into(),
            "--console-log-level=warn".into(),
            "--summary-interval=0".into(),
            format!("--torrent-file={}", tfile.display()),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap_or_else(|e| panic!("the seeder ({}) did not start: {} — install aria2", bin, e));
    let _seeder = Seeder(child);
    let t0 = Instant::now();
    while TcpStream::connect(("127.0.0.1", seed_port)).is_err() {
        assert!(t0.elapsed() < Duration::from_secs(30), "the seeder did not listen");
        std::thread::sleep(Duration::from_millis(200));
    }
    println!("seeder on {}, tracker on {}, info-hash {}", seed_port, tport, made.info_hash);

    let v = c("core.version", "{}").unwrap();
    println!("library: {}", v.to_json());
    c("tor.start", &format!(r#"{{"dataDir":{},"listenPort":0,"dht":false,"upnp":false,"trackers":[],"addTrackers":false,"down":0,"up":0}}"#, q(&data.to_string_lossy()))).unwrap();

    // (add → metadata → downloading)
    let started = Instant::now();
    c("tor.add", &format!(r#"{{"id":"t1","hash":"{}","torrent":"{}","dir":{},"name":"made-up.mkv","multi":false,"paused":false}}"#, made.info_hash, b64(&made.torrent), q(&leech.to_string_lossy()))).unwrap();
    poll_row("t1", |r| matches!(r.get("state").and_then(|x| x.as_str()), Some("downloading") | Some("done")), 120);

    // (a far range — the last 64 KiB — read before the middle is in: librqbit's stream asks for it first)
    let off = (len - 65536) as i64;
    let t_far = Instant::now();
    let mut got = Vec::new();
    while got.len() < 65536 {
        let a = format!(r#"{{"id":"t1","file":0,"off":{},"len":{},"timeoutMs":60000}}"#, off + got.len() as i64, 65536 - got.len());
        let b = kt_torrent::dispatch::call_bytes(b"bytes.tor.read", a.as_bytes(), &[]).expect("far read");
        assert!(!b.is_empty());
        got.extend_from_slice(&b);
    }
    assert_eq!(&got[..], &body[len - 65536..], "the far range's bytes");
    let at_far = poll_row("t1", |_| true, 30);
    let done_then = at_far.get("done").map(|x| x.number()).unwrap_or(0.0);
    println!("far range in {:.1} s, {} of {} bytes here then", t_far.elapsed().as_secs_f64(), done_then, len);
    assert!(done_then < len as f64, "the whole file was already here — the far read proved nothing (seeder too fast?)");

    // (pause / resume)
    c("tor.pause", r#"{"id":"t1"}"#).unwrap();
    poll_row("t1", state_is("paused"), 30);
    c("tor.resume", r#"{"id":"t1"}"#).unwrap();
    poll_row("t1", |r| r.get("state").and_then(|x| x.as_str()) != Some("paused"), 120);

    // (done, identical bytes on the disk)
    poll_row("t1", state_is("done"), 300);
    println!("whole file in {:.1} s", started.elapsed().as_secs_f64());
    let on_disk = std::fs::read(leech.join("made-up.mkv")).unwrap();
    assert!(on_disk == body, "the downloaded file differs");

    // (remove, files kept)
    assert_eq!(c("tor.remove", r#"{"id":"t1","deleteFiles":false}"#).unwrap(), J::Bool(true));
    assert!(leech.join("made-up.mkv").exists());

    // (a forced failure: a folder that cannot be written — told once, «restartClassic»)
    c("tor.add", &format!(r#"{{"id":"f1","hash":"{}","torrent":"{}","dir":"/proc/kt-nowhere","name":"made-up.mkv","multi":false,"paused":false}}"#, made.info_hash, b64(&made.torrent))).unwrap();
    let t1 = Instant::now();
    let mut told = None;
    while t1.elapsed() < Duration::from_secs(120) && told.is_none() {
        let p = c("tor.poll", r#"{"now":2,"seed":false,"ratioPct":0,"minutes":0,"held":false}"#).unwrap();
        told = p.get("failed").unwrap().as_arr().unwrap().iter().find(|f| f.get("id").and_then(|x| x.as_str()) == Some("f1")).cloned();
        std::thread::sleep(Duration::from_millis(300));
    }
    let f = told.expect("the forced failure was never told");
    println!("forced failure: {}", f.to_json());
    assert!(matches!(f.get("then").and_then(|x| x.as_str()), Some("restartClassic") | Some("pauseForClassic")));

    let back = c("tor.shutdown", "{}").unwrap();
    println!("shutdown: {}", back.to_json());
    let _ = std::fs::remove_dir_all(&root);
}
