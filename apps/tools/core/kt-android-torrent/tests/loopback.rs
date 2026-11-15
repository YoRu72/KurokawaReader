//! Stage M3's proof of the real backend (CI only: librqbit cannot be built where this was written): the library's own
//! `tor.*` methods — the same ones Java calls through JNI — against LOOPBACK swarms made here: a made-up file, a
//! private .torrent of it (the PC self-test's torrentmake.rs), an HTTP tracker on 127.0.0.1 that names one peer, and
//! aria2c seeding it on 127.0.0.1 (KT_ARIA2C, else `aria2c`; upload held to 512 KiB/s; its debug log kept). DHT off, no
//! public tracker. Each case has a swarm of its own (its own file, seeder and tracker), so one case's trouble cannot
//! hide in another's:
//!   whole_file          add → done, identical bytes, nothing else done to it (the required row once green)
//!   far_read_then_done  the last 64 KiB read through the stream first, then to the end
//!   pause_resume_done   paused and resumed early, then to the end
//!   remove_and_failure  remove keeps the files; a folder librqbit cannot write is told as a failure
//! The poll's clock is real, so the library's stall watchdog acts (60 s without a verified byte → dropped and added
//! again, at most 3 times; each row carries `nudges`): whole_file requires 0 nudges; the others print theirs.
//! Whenever a download makes no progress for 10 s the test prints, every 30 s while it lasts: the pieces missing ON THE
//! DISK (compared with the made-up bytes, piece by piece), what librqbit reports, a 5 s stream read of the first
//! missing piece, the seeder's log lines about that piece and its last peer messages, and (with the `testtrace`
//! feature) librqbit's own last log lines. CI runs it with `--test-threads=1 --nocapture`.

#[path = "../../../desktop-tauri/src-tauri/src/torrentmake.rs"]
#[allow(dead_code)]
mod tm;

use kt_core::vidjson::{self, J};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const PIECE: usize = 32 * 1024;

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

/// librqbit's own log (feature `testtrace`): to a file whose tail the stall report prints.
fn trace_file() -> Option<PathBuf> {
    static F: OnceLock<Option<PathBuf>> = OnceLock::new();
    F.get_or_init(|| {
        #[cfg(feature = "testtrace")]
        {
            let p = std::env::temp_dir().join(format!("kt-rqbit-trace-{}.log", std::process::id()));
            let f = std::fs::File::create(&p).ok()?;
            let filter = std::env::var("KT_RQBIT_LOG").unwrap_or_else(|_| "librqbit=debug,librqbit_core=debug,librqbit_peer_protocol=debug".into());
            let _ = tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::new(filter)).with_writer(Mutex::new(f)).with_ansi(false).try_init();
            return Some(p);
        }
        #[allow(unreachable_code)]
        None
    })
    .clone()
}

fn started() {
    static S: Mutex<bool> = Mutex::new(false);
    let mut g = S.lock().unwrap_or_else(|e| e.into_inner());
    if *g {
        return;
    }
    let _ = trace_file();
    let data = std::env::temp_dir().join(format!("kt-tor-loop-{}-rqbit", std::process::id()));
    println!("library: {}", c("core.version", "{}").unwrap().to_json());
    c("tor.start", &format!(r#"{{"dataDir":{},"listenPort":0,"dht":false,"upnp":false,"trackers":[],"addTrackers":false,"down":0,"up":0}}"#, q(&data.to_string_lossy()))).unwrap();
    *g = true;
}

struct Swarm {
    name: String,
    body: Vec<u8>,
    leech: PathBuf,
    torrent: Vec<u8>,
    hash: String,
    log: PathBuf,
    seeder: Child,
}
impl Drop for Swarm {
    fn drop(&mut self) {
        let _ = self.seeder.kill();
        let _ = self.seeder.wait();
    }
}

/// A swarm of its own: `len` made-up bytes (seed `seed`), a private torrent of 32 KiB pieces, a tracker, aria2c.
fn swarm(case: &str, len: usize, seed: u64) -> Swarm {
    let root = std::env::temp_dir().join(format!("kt-tor-loop-{}-{}", std::process::id(), case));
    let _ = std::fs::remove_dir_all(&root);
    let (sd, leech) = (root.join("seed"), root.join("leech"));
    std::fs::create_dir_all(&sd).unwrap();
    std::fs::create_dir_all(&leech).unwrap();
    let name = format!("{}.mkv", case);
    let body = tm::noise(len, seed);
    std::fs::write(sd.join(&name), &body).unwrap();
    let seed_port = free_port();
    let tport = tracker(seed_port);
    let made = tm::make(&name, &[(&name, &body)], PIECE, &format!("http://127.0.0.1:{}/announce", tport), true);
    let tfile = root.join("t.torrent");
    std::fs::write(&tfile, &made.torrent).unwrap();
    let log = root.join("aria2.log");
    let bin = std::env::var("KT_ARIA2C").unwrap_or_else(|_| "aria2c".into());
    let child = Command::new(&bin)
        .args([
            format!("--dir={}", sd.display()),
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
            format!("--log={}", log.display()),
            "--log-level=debug".into(),
            "--summary-interval=0".into(),
            format!("--torrent-file={}", tfile.display()),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap_or_else(|e| panic!("the seeder ({}) did not start: {} — install aria2", bin, e));
    let t0 = Instant::now();
    while TcpStream::connect(("127.0.0.1", seed_port)).is_err() {
        assert!(t0.elapsed() < Duration::from_secs(30), "the seeder did not listen");
        std::thread::sleep(Duration::from_millis(200));
    }
    println!("[{}] seeder on {}, tracker on {}, info-hash {}, {} bytes = {} pieces of {}", case, seed_port, tport, made.info_hash, len, len.div_ceil(PIECE), PIECE);
    Swarm { name, body, leech, torrent: made.torrent, hash: made.info_hash, log, seeder: child }
}

fn add(s: &Swarm, id: &str) {
    c("tor.add", &format!(r#"{{"id":{},"hash":"{}","torrent":"{}","dir":{},"name":{},"multi":false,"paused":false}}"#, q(id), s.hash, b64(&s.torrent), q(&s.leech.to_string_lossy()), q(&s.name))).unwrap();
}

/// The pieces whose bytes on the disk are not the made-up ones (short file → the rest missing).
fn missing_on_disk(s: &Swarm) -> (u64, Vec<usize>) {
    let disk = std::fs::read(s.leech.join(&s.name)).unwrap_or_default();
    let n = s.body.len().div_ceil(PIECE);
    let miss = (0..n)
        .filter(|&i| {
            let (a, b) = (i * PIECE, ((i + 1) * PIECE).min(s.body.len()));
            disk.get(a..b) != Some(&s.body[a..b])
        })
        .collect();
    (disk.len() as u64, miss)
}
fn ranges(v: &[usize]) -> String {
    let mut out = Vec::new();
    let mut i = 0;
    while i < v.len() {
        let mut j = i;
        while j + 1 < v.len() && v[j + 1] == v[j] + 1 {
            j += 1;
        }
        out.push(if i == j { v[i].to_string() } else { format!("{}–{}", v[i], v[j]) });
        i = j + 1;
    }
    out.join(", ")
}
fn tail(path: &Path, keep: impl Fn(&str) -> bool, n: usize) -> Vec<String> {
    let t = std::fs::read_to_string(path).unwrap_or_default();
    let v: Vec<String> = t.lines().filter(|l| keep(l)).map(|l| l.chars().take(300).collect()).collect();
    v[v.len().saturating_sub(n)..].to_vec()
}

/// The stall report (see the file's head).
fn stall_report(s: &Swarm, id: &str, row: &J) {
    let (disk_len, miss) = missing_on_disk(s);
    println!("[{}] ===== STALL: no progress for 10 s — {}", id, row.to_json().chars().take(300).collect::<String>());
    println!("[{}] on the disk: {} bytes; pieces missing or wrong: {} ({})", id, disk_len, miss.len(), ranges(&miss));
    if let Some(&p) = miss.first() {
        let (a, b) = (p * PIECE, ((p + 1) * PIECE).min(s.body.len()));
        let disk = std::fs::read(s.leech.join(&s.name)).unwrap_or_default();
        let zeros = disk.get(a..b).map(|x| x.iter().all(|&z| z == 0));
        println!("[{}] piece {}: bytes {}–{} on the disk are {}", id, p, a, b - 1, match zeros { Some(true) => "all zero (never written)", Some(false) => "written but WRONG (or not yet checked)", None => "beyond the file's end" });
        let r = kt_torrent::dispatch::call_bytes(b"bytes.tor.read", format!(r#"{{"id":{},"file":0,"off":{},"len":{},"timeoutMs":5000}}"#, q(id), a, b - a).as_bytes(), &[]);
        println!("[{}] a 5 s stream read of piece {}: {}", id, p, match r { Ok(v) => format!("{} bytes, {}", v.len(), if v[..] == s.body[a..a + v.len()] { "identical" } else { "DIFFERENT" }), Err(e) => format!("error: {}", e) });
        let idx = format!("index={}", p);
        let idx2 = format!("index:{}", p);
        println!("[{}] seeder's log about piece {}:", id, p);
        for l in tail(&s.log, |l| l.contains(&idx) || l.contains(&idx2), 15) {
            println!("    {}", l);
        }
    }
    println!("[{}] seeder's last peer messages:", id);
    for l in tail(&s.log, |l| { let u = l.to_ascii_uppercase(); ["CHOKE", "INTERESTED", "REQUEST", "PIECE", "HAVE", "BITFIELD", "DROP", "CLOSE", "DISCONNECT", "KEEP"].iter().any(|k| u.contains(k)) }, 25) {
        println!("    {}", l);
    }
    if let Some(t) = trace_file() {
        println!("[{}] librqbit's last log lines:", id);
        for l in tail(&t, |_| true, 40) {
            println!("    {}", l);
        }
    }
}

/// Polls until `until(row)` (or panics after `secs`), printing each changed row and a stall report whenever nothing
/// moved for 10 s (again every 30 s).
fn poll_row(s: &Swarm, id: &str, until: impl Fn(&J) -> bool, secs: u64) -> J {
    let t0 = Instant::now();
    let mut last_done = -1.0;
    let mut moved = Instant::now();
    let mut reported: Option<Instant> = None;
    let mut last: Option<J> = None;
    while t0.elapsed() < Duration::from_secs(secs) {
        let p = c("tor.poll", &format!(r#"{{"now":{},"seed":false,"ratioPct":0,"minutes":0,"held":false}}"#, now_ms())).unwrap();
        for f in p.get("failed").unwrap().as_arr().unwrap() {
            if f.get("id").and_then(|x| x.as_str()) == Some(id) {
                panic!("[{}] failed: {}", id, f.to_json());
            }
        }
        for r in p.get("rows").unwrap().as_arr().unwrap() {
            if r.get("id").and_then(|x| x.as_str()) == Some(id) {
                println!("  [{}] {:.1}s {}", id, t0.elapsed().as_secs_f64(), r.to_json().chars().take(200).collect::<String>());
                let d = r.get("done").map(|x| x.number()).unwrap_or(0.0);
                if d != last_done {
                    last_done = d;
                    moved = Instant::now();
                    reported = None;
                }
                last = Some(r.clone());
                if until(r) {
                    return r.clone();
                }
            }
        }
        if let Some(row) = &last {
            if until(row) {
                return row.clone();
            }
            let due = moved.elapsed() > Duration::from_secs(10) && reported.map_or(true, |t| t.elapsed() > Duration::from_secs(30));
            if due {
                stall_report(s, id, row);
                reported = Some(Instant::now());
            }
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    if let Some(row) = &last {
        stall_report(s, id, row);
    }
    panic!("[{}] not reached in {} s", id, secs)
}
/// The poll's clock (ms): real, so the library's stall watchdog (60 s still → dropped and added again) acts as on a phone.
fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
fn nudges(r: &J) -> f64 {
    r.get("nudges").map(|x| x.number()).unwrap_or(0.0)
}
fn state_is(st: &'static str) -> impl Fn(&J) -> bool {
    move |r: &J| r.get("state").and_then(|x| x.as_str()) == Some(st)
}
fn moving(r: &J) -> bool {
    matches!(r.get("state").and_then(|x| x.as_str()), Some("downloading") | Some("done"))
}
fn same_on_disk(s: &Swarm, id: &str) {
    let (len, miss) = missing_on_disk(s);
    assert!(miss.is_empty() && len == s.body.len() as u64, "[{}] the file on the disk differs: {} bytes, pieces wrong: {}", id, len, ranges(&miss));
    println!("[{}] identical bytes on the disk", id);
}

#[test]
fn whole_file() {
    started();
    let s = swarm("whole", 12 << 20, 11);
    let t0 = Instant::now();
    add(&s, "w");
    let r = poll_row(&s, "w", state_is("done"), 240);
    println!("[w] whole file in {:.1} s, watchdog nudges {}", t0.elapsed().as_secs_f64(), nudges(&r));
    // (Required: librqbit alone finishes a plain download — the watchdog may not have been needed.)
    assert_eq!(nudges(&r), 0.0, "[w] it finished only after the watchdog dropped and re-added it");
    same_on_disk(&s, "w");
    assert_eq!(c("tor.remove", r#"{"id":"w","deleteFiles":false}"#).unwrap(), J::Bool(true));
}

#[test]
fn far_read_then_done() {
    started();
    let s = swarm("far", 12 << 20, 7);
    let len = s.body.len();
    add(&s, "f");
    poll_row(&s, "f", moving, 120);
    let off = len - 65536;
    let t_far = Instant::now();
    let mut got = Vec::new();
    while got.len() < 65536 {
        let a = format!(r#"{{"id":"f","file":0,"off":{},"len":{},"timeoutMs":60000}}"#, off + got.len(), 65536 - got.len());
        let b = kt_torrent::dispatch::call_bytes(b"bytes.tor.read", a.as_bytes(), &[]).expect("far read");
        assert!(!b.is_empty());
        got.extend_from_slice(&b);
    }
    assert_eq!(&got[..], &s.body[len - 65536..], "the far range's bytes");
    let at = poll_row(&s, "f", |_| true, 30);
    let done_then = at.get("done").map(|x| x.number()).unwrap_or(0.0);
    println!("[f] far range in {:.1} s, {} of {} bytes here then", t_far.elapsed().as_secs_f64(), done_then, len);
    assert!(done_then < len as f64, "the whole file was already here — the far read proved nothing");
    let r = poll_row(&s, "f", state_is("done"), 240);
    println!("[f] done, watchdog nudges {} (0: librqbit finished by itself)", nudges(&r));
    same_on_disk(&s, "f");
    let _ = c("tor.remove", r#"{"id":"f","deleteFiles":false}"#);
}

#[test]
fn pause_resume_done() {
    started();
    let s = swarm("pause", 12 << 20, 5);
    add(&s, "p");
    poll_row(&s, "p", |r| r.get("done").map(|x| x.number()).unwrap_or(0.0) > 0.0, 120);
    c("tor.pause", r#"{"id":"p"}"#).unwrap();
    poll_row(&s, "p", state_is("paused"), 30);
    std::thread::sleep(Duration::from_secs(2));
    c("tor.resume", r#"{"id":"p"}"#).unwrap();
    poll_row(&s, "p", |r| r.get("state").and_then(|x| x.as_str()) != Some("paused"), 120);
    let r = poll_row(&s, "p", state_is("done"), 240);
    println!("[p] done, watchdog nudges {} (0: librqbit finished by itself)", nudges(&r));
    same_on_disk(&s, "p");
    let _ = c("tor.remove", r#"{"id":"p","deleteFiles":false}"#);
}

#[test]
fn remove_and_failure() {
    started();
    let s = swarm("remove", 2 << 20, 3);
    add(&s, "r");
    poll_row(&s, "r", moving, 120);
    assert_eq!(c("tor.remove", r#"{"id":"r","deleteFiles":false}"#).unwrap(), J::Bool(true));
    assert!(s.leech.join(&s.name).exists(), "remove without files kept the file");
    // (A forced failure: a folder that cannot be written — told once, for libtorrent.)
    c("tor.add", &format!(r#"{{"id":"x","hash":"{}","torrent":"{}","dir":"/proc/kt-nowhere","name":{},"multi":false,"paused":false}}"#, s.hash, b64(&s.torrent), q(&s.name))).unwrap();
    let t1 = Instant::now();
    let mut told = None;
    while t1.elapsed() < Duration::from_secs(120) && told.is_none() {
        let p = c("tor.poll", r#"{"now":2,"seed":false,"ratioPct":0,"minutes":0,"held":false}"#).unwrap();
        told = p.get("failed").unwrap().as_arr().unwrap().iter().find(|f| f.get("id").and_then(|x| x.as_str()) == Some("x")).cloned();
        std::thread::sleep(Duration::from_millis(300));
    }
    let f = told.expect("the forced failure was never told");
    println!("[x] forced failure: {}", f.to_json());
    assert!(matches!(f.get("then").and_then(|x| x.as_str()), Some("restartClassic") | Some("pauseForClassic")));
}
