// Running the video tools (stage P5): yt-dlp, gallery-dl, ffmpeg and ffprobe started as 7-Zip is (the shared
// archive.rs) — an argument list, never a shell; stdin closed; no console window on Windows (CREATE_NO_WINDOW) — and
// each in a process group of its own off Windows, so a cancel ends the whole tree (yt-dlp's ffmpeg with it): the group
// killed (kill(-pgid, SIGKILL)); on Windows taskkill /T /F, the system's own tree kill. Std only (the C library's
// kill() declared here; kernel32's OpenProcess / GetExitCodeProcess for «is it still running» on Windows), checked
// alone with `rustc --edition 2021 --test vtproc.rs` (the tests run sh on Linux and macOS).
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}
#[cfg(unix)]
const SIGKILL: i32 = 9;
#[cfg(unix)]
const SIGINT: i32 = 2;

#[cfg(windows)]
#[allow(non_snake_case)]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
    fn GetExitCodeProcess(h: isize, code: *mut u32) -> i32;
    fn CloseHandle(h: isize) -> i32;
}

/// The command for `bin` with `args`: stdin closed, stdout and stderr piped, no window, a group of its own.
pub fn command(bin: &Path, args: &[String]) -> Command {
    let mut c = Command::new(bin);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    c
}

/// The process and everything it started, ended at once.
pub fn kill_tree(pid: u32) {
    #[cfg(unix)]
    unsafe {
        let _ = kill(-(pid as i32), SIGKILL);
        let _ = kill(pid as i32, SIGKILL);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let tk = std::env::var_os("SystemRoot")
            .map(|r| Path::new(&r).join("System32").join("taskkill.exe"))
            .filter(|p| p.is_file())
            .unwrap_or_else(|| std::path::PathBuf::from("taskkill"));
        let mut c = Command::new(tk);
        c.args(["/PID", &pid.to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        c.creation_flags(0x0800_0000);
        if let Ok(mut ch) = c.spawn() {
            let until = Instant::now() + Duration::from_secs(10);
            while Instant::now() < until {
                match ch.try_wait() {
                    Ok(Some(_)) | Err(_) => break,
                    Ok(None) => thread::sleep(Duration::from_millis(50)),
                }
            }
        }
    }
}

/// Asked to stop (ffmpeg finishes its file on SIGINT); on Windows, which has no such signal, the tree is ended.
pub fn interrupt(pid: u32) {
    #[cfg(unix)]
    unsafe {
        let _ = kill(pid as i32, SIGINT);
    }
    #[cfg(windows)]
    kill_tree(pid);
}

/// Whether a process is still running (a zombie is not).
pub fn alive(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        if let Ok(st) = std::fs::read_to_string(format!("/proc/{}/stat", pid)) {
            if let Some(i) = st.rfind(')') {
                let state = st[i + 1..].trim_start().chars().next().unwrap_or('?');
                return state != 'Z' && state != 'X';
            }
        }
        return false;
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    unsafe {
        return kill(pid as i32, 0) == 0;
    }
    #[cfg(windows)]
    unsafe {
        let h = OpenProcess(0x1000, 0, pid);
        if h == 0 {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(h, &mut code) != 0;
        CloseHandle(h);
        return ok && code == 259;
    }
    #[allow(unreachable_code)]
    false
}

/// A finished run: its exit code (None when killed by a signal), stdout, stderr.
#[derive(Debug)]
pub struct Ran {
    pub code: Option<i32>,
    pub out: Vec<u8>,
    pub err: String,
    pub timed_out: bool,
}

fn reader<R: Read + Send + 'static>(mut r: R, max: usize) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut v: Vec<u8> = Vec::new();
        let mut buf = vec![0u8; 16384];
        loop {
            match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    v.extend_from_slice(&buf[..n]);
                    // (Past the limit only the end is kept: an error's last lines are what is shown.)
                    if v.len() > max {
                        let cut = v.len() - max / 2;
                        v.drain(..cut);
                    }
                }
            }
        }
        v
    })
}

/// execFile: `bin` run to its end (or ended, its tree too, after `limit`) → its output; Err only when it could not
/// start («ENOENT» when there is no such program).
pub fn run(bin: &Path, args: &[String], limit: Duration, max_out: usize) -> Result<Ran, String> {
    let mut child = command(bin, args).spawn().map_err(spawn_error)?;
    let so = reader(child.stdout.take().ok_or("no stdout")?, max_out);
    let se = reader(child.stderr.take().ok_or("no stderr")?, 1 << 20);
    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {
                if started.elapsed() > limit {
                    timed_out = true;
                    kill_tree(child.id());
                    break child.wait().ok();
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(_) => break None,
        }
    };
    let out = so.join().unwrap_or_default();
    let err = se.join().unwrap_or_default();
    Ok(Ran { code: status.and_then(|s| s.code()), out, err: String::from_utf8_lossy(&err).into_owned(), timed_out })
}

/// Why a program did not start, in Node's words where the page looks for them («ENOENT»).
pub fn spawn_error(e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        format!("ENOENT: {}", e)
    } else {
        e.to_string()
    }
}

/// A program running with its stdout read line by line (yt-dlp's jobs, ffmpeg's progress).
pub struct Lines {
    pub child: Child,
    pub pid: u32,
    out: Option<thread::JoinHandle<()>>,
    err: Option<thread::JoinHandle<Vec<u8>>>,
}

/// `bin` started; each stdout line (split on \n, a \r before it dropped) to `on_line` on a thread of its own.
pub fn spawn_lines<F: FnMut(&str) + Send + 'static>(bin: &Path, args: &[String], mut on_line: F) -> Result<Lines, String> {
    let mut child = command(bin, args).spawn().map_err(spawn_error)?;
    let pid = child.id();
    let mut so = child.stdout.take().ok_or("no stdout")?;
    let se = child.stderr.take().ok_or("no stderr")?;
    let out = thread::spawn(move || {
        let mut buf = vec![0u8; 16384];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match so.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    while let Some(i) = pending.iter().position(|b| *b == b'\n') {
                        let mut line: Vec<u8> = pending.drain(..=i).collect();
                        line.pop();
                        if line.last() == Some(&b'\r') {
                            line.pop();
                        }
                        on_line(&String::from_utf8_lossy(&line));
                    }
                }
            }
        }
        if !pending.is_empty() {
            on_line(&String::from_utf8_lossy(&pending));
        }
    });
    let err = reader(se, 40000);
    Ok(Lines { child, pid, out: Some(out), err: Some(err) })
}

impl Lines {
    /// Waits for the end (and for every line read) → (exit code, stderr's tail).
    pub fn wait(mut self) -> (Option<i32>, String) {
        let st = self.child.wait().ok();
        if let Some(t) = self.out.take() {
            let _ = t.join();
        }
        let err = self.err.take().map(|t| t.join().unwrap_or_default()).unwrap_or_default();
        (st.and_then(|s| s.code()), String::from_utf8_lossy(&err).into_owned())
    }
}

/// Channel-based waiting with a limit, for a caller on another thread: → Some(code) when it ended in time.
pub fn wait_for(rx: &mpsc::Receiver<()>, limit: Duration) -> bool {
    rx.recv_timeout(limit).is_ok()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn sh(script: &str) -> Vec<String> {
        vec!["-c".to_string(), script.to_string()]
    }

    #[test]
    fn runs_and_times_out() {
        let r = run(Path::new("/bin/sh"), &sh("echo out; echo err 1>&2; exit 3"), Duration::from_secs(10), 1 << 20).unwrap();
        assert_eq!((r.code, String::from_utf8_lossy(&r.out).as_ref(), r.err.as_str(), r.timed_out), (Some(3), "out\n", "err\n", false));
        let t0 = Instant::now();
        let r = run(Path::new("/bin/sh"), &sh("sleep 30"), Duration::from_millis(300), 1024).unwrap();
        assert!(r.timed_out && t0.elapsed() < Duration::from_secs(5));
        let e = run(Path::new("/no/such/program"), &[], Duration::from_secs(1), 10).unwrap_err();
        assert!(e.starts_with("ENOENT"), "{}", e);
        // (stdin is closed: a program reading it sees its end at once.)
        let r = run(Path::new("/bin/sh"), &sh("cat; echo done"), Duration::from_secs(5), 1024).unwrap();
        assert_eq!(String::from_utf8_lossy(&r.out), "done\n");
    }

    #[test]
    fn lines_and_tree_kill() {
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let s2 = seen.clone();
        let p = spawn_lines(Path::new("/bin/sh"), &sh("printf 'a\\r\\nb\\nc'; echo e >&2"), move |l| s2.lock().unwrap().push(l.to_string())).unwrap();
        let (code, err) = p.wait();
        assert_eq!((code, err.as_str()), (Some(0), "e\n"));
        assert_eq!(*seen.lock().unwrap(), vec!["a", "b", "c"]);
        // (A child that started a grandchild: both gone after kill_tree.)
        let dir = std::env::temp_dir().join(format!("vtproc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pidf = dir.join("gc.pid");
        let script = format!("sleep 60 & echo $! > '{}'; echo started; wait", pidf.display());
        let p = spawn_lines(Path::new("/bin/sh"), &sh(&script), |_| {}).unwrap();
        let until = Instant::now() + Duration::from_secs(5);
        let gc = loop {
            if let Some(n) = std::fs::read_to_string(&pidf).ok().and_then(|t| t.trim().parse::<u32>().ok()) {
                break n;
            }
            assert!(Instant::now() < until, "no grandchild");
            thread::sleep(Duration::from_millis(20));
        };
        assert!(alive(gc) && alive(p.pid));
        kill_tree(p.pid);
        let (code, _) = p.wait();
        assert_eq!(code, None);
        let until = Instant::now() + Duration::from_secs(5);
        while alive(gc) && Instant::now() < until {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(!alive(gc), "the grandchild outlived the tree kill");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
