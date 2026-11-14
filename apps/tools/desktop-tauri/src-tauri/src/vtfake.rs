// Stage P5's self-test stand-ins (CI only): the app's own program, copied under the names yt-dlp, gallery-dl, ffmpeg and
// ffprobe, answers as those programs do — so the self-test fetches, verifies, runs, updates, rolls back, probes and
// streams without any real program, site or script interpreter. Active only when BOTH environment variables are set:
// KT_SELFTEST (the self-test's own, set by CI) and KT_FAKE_TOOLS=1 (set by the self-test on the programs it starts,
// vtproc.rs FAKE_ENV); and only for an executable whose own file name is one of those four. A normal start never gets
// here (main() asks `maybe_run` first; it answers None at once).
// Also the loopback server the self-test fetches them from (`Server`): fixed routes, Range answered, a route sent slowly
// or broken off after part of it, as a release server or a dropped connection would.
// Std only; checked alone with `rustc --edition 2021 --test vtfake.rs`.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// The end of a stand-in's file: «#KT-FAKE-TOOL|<version>|<mode>|#» (appended to the copy the server hands out; a
/// program's trailing bytes are ignored by every system's loader).
const TAG: &[u8] = b"#KT-FAKE-TOOL|";
/// The version a stand-in without a trailer gives.
pub const DEFAULT_VERSION: &str = "2025.11.20";

pub fn trailer(version: &str, mode: &str) -> Vec<u8> {
    let mut t = b"\n".to_vec();
    t.extend_from_slice(TAG);
    t.extend_from_slice(format!("{}|{}|#", version, mode).as_bytes());
    t
}
/// The trailer read from a file's last bytes → (version, mode).
pub fn read_trailer(tail: &[u8]) -> Option<(String, String)> {
    let at = tail.windows(TAG.len()).rposition(|w| w == TAG)?;
    let rest = std::str::from_utf8(&tail[at + TAG.len()..]).ok()?;
    let rest = rest.strip_suffix('#')?;
    let mut p = rest.split('|');
    let v = p.next()?.to_string();
    let m = p.next()?.to_string();
    if v.is_empty() || v.len() > 40 || m.len() > 20 {
        return None;
    }
    Some((v, m))
}

/// Which stand-in an executable's file name makes it.
pub fn tool_of(stem: &str) -> Option<&'static str> {
    match stem.to_ascii_lowercase().as_str() {
        "yt-dlp" => Some("yt-dlp"),
        "gallery-dl" => Some("gallery-dl"),
        "ffmpeg" => Some("ffmpeg"),
        "ffprobe" => Some("ffprobe"),
        _ => None,
    }
}

/// Whether the fakes may answer here (both variables; see the top).
pub fn enabled() -> bool {
    std::env::var("KT_FAKE_TOOLS").map(|v| v == "1").unwrap_or(false)
        && std::env::var_os("KT_SELFTEST").map(|v| !v.is_empty()).unwrap_or(false)
}

/// Asked first thing in main(): Some(exit code) when this process is a stand-in (it has done its work), None otherwise.
pub fn maybe_run() -> Option<i32> {
    if !enabled() {
        return None;
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(|a| a == "--kt-fake-sleep").unwrap_or(false) {
        // (A grandchild for the tree-kill checks: it only waits.)
        thread::sleep(Duration::from_secs(120));
        return Some(0);
    }
    let exe = std::env::current_exe().ok()?;
    let stem = exe.file_stem()?.to_string_lossy().into_owned();
    let tool = tool_of(&stem)?;
    let (version, mode) = own_trailer(&exe).unwrap_or_else(|| (DEFAULT_VERSION.to_string(), "ok".to_string()));
    let mut out = std::io::stdout();
    let mut err = std::io::stderr();
    Some(run_tool(tool, &version, &mode, &args, &mut out, &mut err, &exe))
}

fn own_trailer(exe: &Path) -> Option<(String, String)> {
    let mut f = std::fs::File::open(exe).ok()?;
    let len = f.metadata().ok()?.len();
    let n = len.min(128);
    use std::io::Seek;
    f.seek(std::io::SeekFrom::Start(len - n)).ok()?;
    let mut b = vec![0u8; n as usize];
    f.read_exact(&mut b).ok()?;
    read_trailer(&b)
}

fn arg_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    let i = args.iter().position(|a| a == flag)?;
    args.get(i + 1).map(|s| s.as_str())
}

/// A grandchild started and both pids written to `pids` («<own> <child>»), for the tree-kill checks.
fn start_grandchild(exe: &Path, pids: &Path) {
    let child = Command::new(exe).arg("--kt-fake-sleep").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
    let cpid = child.map(|c| c.id()).unwrap_or(0);
    let _ = std::fs::write(pids, format!("{} {}", std::process::id(), cpid));
}

/// The bytes a stand-in writes as a downloaded video (and the stream's after its first line).
pub fn pattern(n: usize, seed: u8) -> Vec<u8> {
    (0..n).map(|i| (i as u32).wrapping_mul(31).wrapping_add(seed as u32) as u8).collect()
}

/// One stand-in's run → its exit code. `exe` its own file (for a grandchild).
pub fn run_tool(tool: &str, version: &str, mode: &str, args: &[String], out: &mut dyn Write, err: &mut dyn Write, exe: &Path) -> i32 {
    if mode == "broken" {
        // (A release that does not start: what a bad build or a missing library gives.)
        let _ = writeln!(err, "{}: cannot start (a broken stand-in)", tool);
        return 3;
    }
    match tool {
        "yt-dlp" => ytdlp(version, args, out, err, exe),
        "gallery-dl" => gallery(args, out, err),
        "ffmpeg" => ffmpeg(args, out, err, exe),
        "ffprobe" => ffprobe(args, out, err),
        _ => 2,
    }
}

const VIDEO_JSON: &str = r#"{"id":"abc","title":"Fake video","thumbnail":"https://fake.test/t.jpg","duration":12,"extractor_key":"Fake","webpage_url":"https://fake.test/watch?v=abc","uploader":"KT","subtitles":{"en":[],"ar":[]},"chapters":[{"title":"one"}],"is_live":false,"formats":[
{"format_id":"140","url":"https://fake.test/a","vcodec":"none","acodec":"mp4a.40.2","abr":129.5,"ext":"m4a","filesize":3000},
{"format_id":"18","url":"https://fake.test/v18","vcodec":"avc1","acodec":"mp4a.40.2","height":360,"fps":30,"tbr":500,"ext":"mp4","filesize":20000},
{"format_id":"137","url":"https://fake.test/v137","vcodec":"avc1","acodec":"none","height":1080,"fps":30,"tbr":4000,"ext":"mp4","filesize":900000}]}"#;
const PLAYLIST_JSON: &str = r#"{"_type":"playlist","title":"Fake list","webpage_url":"https://fake.test/playlist?list=p","entries":[{"url":"https://fake.test/watch?v=a","title":"A","duration":3,"id":"a"},{"url":"https://fake.test/watch?v=b","title":"B","duration":4,"id":"b"}]}"#;

fn pause(ms: u64) {
    thread::sleep(Duration::from_millis(ms));
}

fn ytdlp(version: &str, args: &[String], out: &mut dyn Write, err: &mut dyn Write, exe: &Path) -> i32 {
    if args.iter().any(|a| a == "--version") {
        let _ = writeln!(out, "{}", version);
        return 0;
    }
    let url = args.last().cloned().unwrap_or_default();
    if url.contains("fail") {
        let _ = writeln!(err, "ERROR: [generic] Unsupported URL: {}", url);
        return 1;
    }
    if args.first().map(|a| a == "-J").unwrap_or(false) {
        let _ = writeln!(out, "{}", if url.contains("playlist") { PLAYLIST_JSON } else { VIDEO_JSON });
        return 0;
    }
    // A job: the folder from -P, else from the -o template's.
    let dir: PathBuf = match arg_after(args, "-P") {
        Some(p) => PathBuf::from(p),
        None => match args.iter().position(|a| a == "-o").and_then(|i| args.get(i + 1)) {
            Some(t) => Path::new(t).parent().map(|p| p.to_path_buf()).unwrap_or_default(),
            None => PathBuf::new(),
        },
    };
    let _ = std::fs::create_dir_all(&dir);
    let stem = "Fake video [abc]";
    let v = dir.join(format!("{}.f137.mp4", stem));
    let a = dir.join(format!("{}.f140.m4a", stem));
    let whole = dir.join(format!("{}.mp4", stem));
    let vs = v.to_string_lossy().into_owned();
    let say = |out: &mut dyn Write, l: &str| {
        let _ = writeln!(out, "{}", l);
        let _ = out.flush();
    };
    say(out, "[youtube] abc: Downloading webpage");
    say(out, &format!("[download] Destination: {}", vs));
    if url.contains("slow") {
        start_grandchild(exe, &dir.join("kt-fake-pids.txt"));
        for i in 0..1200u64 {
            say(out, &format!("KT|{}|100000000|NA|1000000|99|NA|NA|{}", i * 1000, vs));
            pause(100);
        }
        return 0;
    }
    for (k, i) in [(1u64, 10u64), (2, 20), (4, 40)].iter() {
        say(out, &format!("KT|{}|100000|NA|50000|{}|{}|40|{}", k * 25_000, 4 - k, i, vs));
        pause(60);
    }
    say(out, &format!("[download] Destination: {}", a.to_string_lossy()));
    for k in 1..=2u64 {
        say(out, &format!("KT|{}|20000|NA|10000|1|NA|NA|{}", k * 10_000, a.to_string_lossy()));
        pause(60);
    }
    say(out, &format!("[Merger] Merging formats into \"{}\"", whole.to_string_lossy()));
    if std::fs::write(&whole, pattern(120_000, 7)).is_err() {
        let _ = writeln!(err, "ERROR: cannot write {}", whole.to_string_lossy());
        return 1;
    }
    pause(60);
    say(out, &format!("[Metadata] Adding metadata to \"{}\"", whole.to_string_lossy()));
    0
}

fn gallery(args: &[String], out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    if args.iter().any(|a| a == "--version") {
        let _ = writeln!(out, "1.30.2");
        return 0;
    }
    let url = args.last().cloned().unwrap_or_default();
    if url.contains("fail") {
        let _ = writeln!(err, "[gallery-dl][error] No suitable extractor found for '{}'", url);
        return 64;
    }
    let _ = writeln!(
        out,
        r#"[[2,{{"title":"Fake gallery","category":"fake"}}],[3,"https://fake.test/i/1.jpg",{{"filename":"one","extension":"jpg","width":10,"height":20,"id":1,"category":"fake"}}],[3,"https://fake.test/i/2.png?x=1",{{"num":2,"category":"fake","_http_headers":{{"Referer":"https://fake.test/"}}}}]]"#
    );
    0
}

fn ffprobe(args: &[String], out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    let file = args.last().cloned().unwrap_or_default();
    if !Path::new(&file).is_file() {
        let _ = writeln!(err, "{}: No such file or directory", file);
        return 1;
    }
    let _ = writeln!(
        out,
        r#"{{"streams":[{{"index":0,"codec_name":"h264","codec_type":"video","width":1280,"height":720,"pix_fmt":"yuv420p10le"}},{{"index":1,"codec_name":"ac3","codec_type":"audio","channels":6,"tags":{{"language":"jpn"}}}}],"chapters":[],"format":{{"filename":"x","nb_streams":2,"format_name":"matroska,webm","duration":"12.500000","size":"120000"}}}}"#
    );
    0
}

fn ffmpeg(args: &[String], out: &mut dyn Write, err: &mut dyn Write, exe: &Path) -> i32 {
    if args.iter().any(|a| a == "-version") {
        let _ = writeln!(out, "ffmpeg version 7.1-kt-fake Copyright (c) the Kurokawa self-test\nbuilt by nobody");
        return 0;
    }
    if args.iter().any(|a| a == "-encoders") {
        let _ = writeln!(out, "Encoders:\n V....D libx264              libx264 H.264 (fake)\n A....D aac                  AAC (fake)");
        return 0;
    }
    // (transcode.cjs's encoder test on a second of test picture: the graphics cards' encoders fail here, x264 works.)
    if args.iter().any(|a| a == "lavfi") {
        return if args.iter().any(|a| a == "libx264") { 0 } else { 1 };
    }
    let last = args.last().cloned().unwrap_or_default();
    if last == "pipe:1" {
        // The transcode stream / the sound track: a first line naming what was asked, then bytes until done or the
        // reader has gone.
        let enc = arg_after(args, "-c:v").or_else(|| arg_after(args, "-c:a")).unwrap_or("?");
        let ss = arg_after(args, "-ss").unwrap_or("0");
        let map = args.iter().enumerate().filter(|(_, a)| *a == "-map").filter_map(|(i, _)| args.get(i + 1)).cloned().collect::<Vec<_>>().join(",");
        let src = arg_after(args, "-i").unwrap_or("");
        if !Path::new(src).is_file() {
            let _ = writeln!(err, "{}: No such file or directory", src);
            return 1;
        }
        if out.write_all(format!("KTFAKE-STREAM enc={} ss={} map={}\n", enc, ss, map).as_bytes()).is_err() {
            return 1;
        }
        let chunk = pattern(16 * 1024, 3);
        for _ in 0..32 {
            if out.write_all(&chunk).is_err() || out.flush().is_err() {
                return 1;
            }
        }
        return 0;
    }
    // A conversion with `-progress pipe:1`: progress blocks, then the output file.
    let input = arg_after(args, "-i").unwrap_or("").to_string();
    if input.contains("kt-slow") {
        start_grandchild(exe, Path::new(&format!("{}.pids", last)));
        for k in 0..1200u64 {
            let _ = write!(out, "out_time_us={}\ntotal_size={}\nspeed=1x\nprogress=continue\n", k * 100_000, k * 10);
            let _ = out.flush();
            pause(100);
        }
        return 0;
    }
    let data = std::fs::read(&input).unwrap_or_else(|_| pattern(4096, 1));
    for k in 1..=5u64 {
        let _ = write!(out, "frame={}\nout_time_us={}\nout_time_ms={}\ntotal_size={}\nspeed={}x\nprogress={}\n", k * 24, k * 1_000_000, k * 1_000_000, k * 1000, k as f64 * 0.5, if k == 5 { "end" } else { "continue" });
        let _ = out.flush();
        pause(80);
    }
    let _ = writeln!(err, "[fake] {} → {}", input, last);
    if std::fs::write(&last, &data).is_err() {
        let _ = writeln!(err, "{}: cannot write", last);
        return 1;
    }
    0
}

/* ---------- the loopback server the stand-ins are fetched from ---------- */

/// One answer: its bytes and type; `slow` sends it in pieces with pauses (time to cancel); `cut` ends the first
/// connection after that many bytes (a dropped download, resumed by a Range request).
#[derive(Clone)]
pub struct Route {
    pub body: Arc<Vec<u8>>,
    pub ctype: &'static str,
    pub slow: bool,
    pub cut: Option<usize>,
}

#[derive(Clone, Default)]
pub struct Server {
    pub routes: Arc<Mutex<HashMap<String, Route>>>,
    /// The routes already cut once (each is cut on its first request only).
    cut_done: Arc<Mutex<Vec<String>>>,
    /// Requests seen, «METHOD path range» (for the checks).
    pub seen: Arc<Mutex<Vec<String>>>,
}

impl Server {
    pub fn new() -> Server {
        Server::default()
    }
    pub fn set(&self, path: &str, r: Route) {
        if let Ok(mut g) = self.routes.lock() {
            g.insert(path.to_string(), r);
        }
    }
    /// Started on 127.0.0.1:0 → its port.
    pub fn start(&self) -> std::io::Result<u16> {
        let l = TcpListener::bind("127.0.0.1:0")?;
        let port = l.local_addr()?.port();
        let me = self.clone();
        thread::spawn(move || {
            for c in l.incoming().flatten() {
                let m = me.clone();
                thread::spawn(move || {
                    let _ = m.answer(c);
                });
            }
        });
        Ok(port)
    }
    fn answer(&self, mut c: TcpStream) -> std::io::Result<()> {
        c.set_read_timeout(Some(Duration::from_secs(10)))?;
        let mut head: Vec<u8> = Vec::new();
        let mut b = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if c.read(&mut b)? == 0 || head.len() > 16384 {
                return Ok(());
            }
            head.push(b[0]);
        }
        let text = String::from_utf8_lossy(&head).into_owned();
        let first = text.lines().next().unwrap_or("").to_string();
        let mut parts = first.split(' ');
        let method = parts.next().unwrap_or("").to_string();
        let path = parts.next().unwrap_or("").split('?').next().unwrap_or("").to_string();
        let range = text.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            if k.trim().eq_ignore_ascii_case("range") {
                Some(v.trim().to_string())
            } else {
                None
            }
        });
        if let Ok(mut s) = self.seen.lock() {
            s.push(format!("{} {} {}", method, path, range.clone().unwrap_or_default()));
        }
        let route = self.routes.lock().ok().and_then(|g| g.get(&path).cloned());
        let r = match route {
            Some(r) => r,
            None => {
                c.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;
                return Ok(());
            }
        };
        let size = r.body.len();
        let (from, to, status) = match range.as_deref().and_then(|v| parse_range(v, size)) {
            Some((a, z)) => (a, z, 206),
            None => (0, size, 200),
        };
        if range.is_some() && status == 200 && size > 0 {
            // (A range past the end: 416 with the size, as a release server answers.)
            if let Some(a) = range.as_deref().and_then(range_start) {
                if a >= size {
                    c.write_all(format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", size).as_bytes())?;
                    return Ok(());
                }
            }
        }
        let mut h = format!(
            "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n",
            status,
            if status == 206 { "Partial Content" } else { "OK" },
            r.ctype,
            to - from
        );
        if status == 206 {
            h.push_str(&format!("Content-Range: bytes {}-{}/{}\r\n", from, to.saturating_sub(1), size));
        }
        h.push_str("\r\n");
        c.write_all(h.as_bytes())?;
        if method == "HEAD" {
            return Ok(());
        }
        let cut_now = match r.cut {
            Some(n) => {
                let mut g = self.cut_done.lock().map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "lock"))?;
                if g.contains(&path) {
                    None
                } else {
                    g.push(path.clone());
                    Some(n)
                }
            }
            None => None,
        };
        let body = &r.body[from..to];
        let piece = if r.slow { 32 * 1024 } else { 256 * 1024 };
        let mut sent = 0usize;
        for ch in body.chunks(piece) {
            if let Some(n) = cut_now {
                if sent + ch.len() >= n {
                    let k = n.saturating_sub(sent);
                    c.write_all(&ch[..k])?;
                    c.flush()?;
                    // (Broken off: the connection closed before the length it promised.)
                    return Ok(());
                }
            }
            c.write_all(ch)?;
            sent += ch.len();
            if r.slow {
                thread::sleep(Duration::from_millis(40));
            }
        }
        c.flush()
    }
}

fn range_start(v: &str) -> Option<usize> {
    let r = v.strip_prefix("bytes=")?;
    let (a, _) = r.split_once('-')?;
    a.trim().parse().ok()
}
/// «bytes=a-» / «bytes=a-b» within `size` → [from, to).
fn parse_range(v: &str, size: usize) -> Option<(usize, usize)> {
    let r = v.strip_prefix("bytes=")?;
    let (a, b) = r.split_once('-')?;
    let a: usize = a.trim().parse().ok()?;
    let z: usize = if b.trim().is_empty() { size } else { b.trim().parse::<usize>().ok()?.saturating_add(1).min(size) };
    if a >= size || z <= a {
        return None;
    }
    Some((a, z))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|x| x.to_string()).collect()
    }
    fn run(tool: &str, mode: &str, args: &[&str]) -> (i32, String, String) {
        let mut o: Vec<u8> = Vec::new();
        let mut e: Vec<u8> = Vec::new();
        let code = run_tool(tool, "2025.12.01", mode, &s(args), &mut o, &mut e, Path::new("/nonexistent"));
        (code, String::from_utf8_lossy(&o).into_owned(), String::from_utf8_lossy(&e).into_owned())
    }

    #[test]
    fn trailers_and_names() {
        let mut file = pattern(5000, 9);
        file.extend(trailer("2025.12.24", "broken"));
        assert_eq!(read_trailer(&file[file.len() - 128..]), Some(("2025.12.24".into(), "broken".into())));
        assert_eq!(read_trailer(&pattern(300, 1)), None);
        assert_eq!(read_trailer(b"x#KT-FAKE-TOOL|v|ok|"), None);
        assert_eq!((tool_of("yt-dlp"), tool_of("FFMPEG"), tool_of("ffprobe"), tool_of("gallery-dl"), tool_of("kurokawa-tools")), (Some("yt-dlp"), Some("ffmpeg"), Some("ffprobe"), Some("gallery-dl"), None));
    }

    #[test]
    fn stand_ins_answer() {
        assert_eq!(run("yt-dlp", "ok", &["--version"]), (0, "2025.12.01\n".into(), String::new()));
        let (c, _, e) = run("yt-dlp", "broken", &["--version"]);
        assert!(c != 0 && e.contains("broken"));
        let (c, o, _) = run("yt-dlp", "ok", &["-J", "--no-warnings", "https://fake.test/watch?v=abc"]);
        assert!(c == 0 && o.contains("\"formats\""));
        let (c, _, e) = run("yt-dlp", "ok", &["--newline", "https://fake.test/fail"]);
        assert!(c == 1 && e.starts_with("ERROR:"));
        // (A job writes its file in the folder -P names, and says what yt-dlp says.)
        let dir = std::env::temp_dir().join(format!("vtfake-{}", std::process::id()));
        let d = dir.to_string_lossy().into_owned();
        let (c, o, _) = run("yt-dlp", "ok", &["--newline", "-P", &d, "-f", "b", "https://fake.test/watch?v=abc"]);
        assert_eq!(c, 0);
        assert!(o.contains("[download] Destination:") && o.contains("KT|25000|100000|NA|50000|3|10|40|") && o.contains("[Merger] Merging formats into"));
        assert_eq!(std::fs::read(dir.join("Fake video [abc].mp4")).unwrap().len(), 120_000);
        let (c, o, _) = run("gallery-dl", "ok", &["-j", "--no-download", "https://fake.test/g"]);
        assert!(c == 0 && o.starts_with("[[2,"));
        // (ffmpeg: a conversion with progress blocks and its file; the encoder test; the stream.)
        let inp = dir.join("in.bin");
        std::fs::write(&inp, b"abc").unwrap();
        let outp = dir.join("out.bin");
        let (c, o, _) = run("ffmpeg", "ok", &["-i", &inp.to_string_lossy(), "-progress", "pipe:1", "-nostats", &outp.to_string_lossy()]);
        assert_eq!(c, 0);
        assert_eq!(o.matches("progress=").count(), 5);
        assert!(o.contains("progress=end"));
        assert_eq!(std::fs::read(&outp).unwrap(), b"abc");
        assert_eq!(run("ffmpeg", "ok", &["-f", "lavfi", "-i", "testsrc2", "-c:v", "h264_nvenc", "-f", "null", "-"]).0, 1);
        assert_eq!(run("ffmpeg", "ok", &["-f", "lavfi", "-i", "testsrc2", "-c:v", "libx264", "-f", "null", "-"]).0, 0);
        let (c, o, _) = run("ffmpeg", "ok", &["-ss", "5", "-i", &inp.to_string_lossy(), "-map", "0:v:0", "-c:v", "libx264", "-f", "mp4", "pipe:1"]);
        assert!(c == 0 && o.starts_with("KTFAKE-STREAM enc=libx264 ss=5 map=0:v:0\n"));
        let (c, o, _) = run("ffprobe", "ok", &["-v", "error", "-of", "json", &inp.to_string_lossy()]);
        assert!(c == 0 && o.contains("\"duration\":\"12.500000\""));
        assert_eq!(run("ffprobe", "ok", &["/no/such/file"]).0, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn get(port: u16, path: &str, range: Option<&str>) -> (u16, Vec<u8>, String) {
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let r = range.map(|r| format!("Range: {}\r\n", r)).unwrap_or_default();
        c.write_all(format!("GET {} HTTP/1.1\r\nHost: x\r\n{}\r\n", path, r).as_bytes()).unwrap();
        let mut all = Vec::new();
        let _ = c.read_to_end(&mut all);
        let at = all.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&all[..at]).into_owned();
        let status: u16 = head.split(' ').nth(1).unwrap().parse().unwrap();
        (status, all[at + 4..].to_vec(), head)
    }

    #[test]
    fn server_ranges_and_cuts() {
        let sv = Server::new();
        let body = Arc::new(pattern(100_000, 5));
        sv.set("/a", Route { body: body.clone(), ctype: "application/octet-stream", slow: false, cut: None });
        sv.set("/c", Route { body: body.clone(), ctype: "application/octet-stream", slow: true, cut: Some(40_000) });
        let port = sv.start().unwrap();
        let (st, b, _) = get(port, "/a", None);
        assert_eq!((st, b.len()), (200, 100_000));
        let (st, b, h) = get(port, "/a", Some("bytes=99000-"));
        assert_eq!((st, &b[..], h.contains("Content-Range: bytes 99000-99999/100000")), (206, &body[99_000..], true));
        assert_eq!(get(port, "/a", Some("bytes=100000-")).0, 416);
        assert_eq!(get(port, "/nothing", None).0, 404);
        // (Cut once: the first answer stops short, the next is whole.)
        let (st, b, _) = get(port, "/c", None);
        assert_eq!((st, b.len()), (200, 40_000));
        let (st, b, _) = get(port, "/c", Some("bytes=40000-"));
        assert_eq!((st, &b[..]), (206, &body[40_000..]));
        assert!(sv.seen.lock().unwrap().iter().any(|l| l == "GET /c bytes=40000-"));
    }
}
