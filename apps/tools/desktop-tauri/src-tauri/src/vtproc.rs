// Running the video tools (stage P5): yt-dlp, gallery-dl, ffmpeg and ffprobe started as 7-Zip is (the shared
// archive.rs) — an argument list, never a shell; stdin closed; no console window on Windows (CREATE_NO_WINDOW) — and
// each in a process group of its own off Windows, so a cancel ends the whole tree (yt-dlp's ffmpeg with it): the group
// killed (kill(-pgid, SIGKILL)); on Windows taskkill /T /F, the system's own tree kill. Std only (the C library's
// kill() declared here; kernel32's OpenProcess / GetExitCodeProcess for «is it still running» on Windows), checked
// alone with `rustc --edition 2021 --test vtproc.rs` (the tests run sh on Linux and macOS).
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
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
#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
    fn GetExitCodeProcess(h: isize, code: *mut u32) -> i32;
    fn CloseHandle(h: isize) -> i32;
}

/// Set by the self-test only (vtools.rs): the programs started get KT_FAKE_TOOLS=1, so the app's own copies standing in
/// for yt-dlp / gallery-dl / ffmpeg / ffprobe answer as those (vtfake.rs). Never set in a normal run.
pub static FAKE_ENV: AtomicBool = AtomicBool::new(false);

/// A folder put first on the programs' PATH (the «deno» pack's, once it is there: yt-dlp finds its JavaScript runtime
/// there too, besides --js-runtimes). Set by vtools.rs.
pub static PATH_FRONT: std::sync::Mutex<Option<std::path::PathBuf>> = std::sync::Mutex::new(None);

/// PATH with `front` first (the system's PATH as it is after it).
pub fn path_with_front(front: &Path, path: Option<std::ffi::OsString>) -> Option<std::ffi::OsString> {
    let mut parts: Vec<std::path::PathBuf> = vec![front.to_path_buf()];
    if let Some(p) = path {
        parts.extend(std::env::split_paths(&p).filter(|x| x != front));
    }
    std::env::join_paths(parts).ok()
}

/// The command for `bin` with `args`: stdin closed, stdout and stderr piped, no window, a group of its own.
pub fn command(bin: &Path, args: &[String]) -> Command {
    let mut c = Command::new(bin);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(front) = PATH_FRONT.lock().ok().and_then(|g| g.clone()).filter(|d| d.is_dir()) {
        if let Some(p) = path_with_front(&front, std::env::var_os("PATH")) {
            c.env("PATH", p);
        }
    }
    if FAKE_ENV.load(Ordering::SeqCst) {
        c.env("KT_FAKE_TOOLS", "1");
    }
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
    let how = kill_tree_report(pid);
    if let Ok(mut g) = LAST_KILL.lock() {
        *g = how;
    }
}

/// How the last tree kill went (the self-test prints it when a process survived).
pub static LAST_KILL: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

/// The tree ended → what was done and what, if anything, survived.
pub fn kill_tree_report(pid: u32) -> String {
    #[cfg(unix)]
    unsafe {
        // (Its own process group: the whole tree, a grandchild whose parent has already ended included.)
        let _ = kill(-(pid as i32), SIGKILL);
        let _ = kill(pid as i32, SIGKILL);
        let _ = Instant::now();
        return format!("killpg {}", pid);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // (1) Every descendant noted BEFORE anything is ended — a child whose parent is gone no longer hangs under it.
        let mut tree = winjob::descendants(pid);
        tree.insert(0, pid);
        let mut how: Vec<String> = Vec::new();
        // (2) Its job object (made at its start, kill-on-close): everything ever started inside it.
        if winjob::terminate(pid) {
            how.push("job".into());
        }
        // (3) Each one noted, ended by hand.
        let ended = tree.iter().filter(|p| winjob::terminate_pid(**p)).count();
        how.push(format!("TerminateProcess {}/{}", ended, tree.len()));
        // (4) The system's own tree kill as well.
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
            how.push("taskkill /T".into());
        }
        // (5) Checked: every one noted gone within 5 s, else named.
        let until = Instant::now() + Duration::from_secs(5);
        let mut left: Vec<u32> = tree.iter().copied().filter(|p| alive(*p)).collect();
        while !left.is_empty() && Instant::now() < until {
            for p in left.iter() {
                winjob::terminate_pid(*p);
            }
            thread::sleep(Duration::from_millis(100));
            left = tree.iter().copied().filter(|p| alive(*p)).collect();
        }
        winjob::forget(pid);
        let mut out = format!("{} of {:?}", how.join(" + "), tree);
        if !left.is_empty() {
            out.push_str(&format!("; STILL RUNNING: {}", left.iter().map(|p| format!("{} ({})", p, winjob::image(*p))).collect::<Vec<_>>().join(", ")));
        }
        return out;
    }
    #[allow(unreachable_code)]
    String::new()
}

/// A program's job let go once it has ended by itself (Windows; nothing elsewhere).
pub fn forget_job(pid: u32) {
    #[cfg(windows)]
    winjob::forget(pid);
    let _ = pid;
}

/// A program started for the video tools: on Windows started suspended, put into a job object of its own (ended
/// with it, kill-on-close) before its first instruction runs, then let go — so nothing it starts can slip out of a
/// cancel. Where the job cannot be had (an outer job that forbids it), it runs anyway and the tree is walked at the
/// kill. Elsewhere as `c.spawn()` (command() gave it a process group of its own).
pub fn spawn(c: &mut Command) -> std::io::Result<Child> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000 | 0x0000_0004);
        let child = c.spawn()?;
        winjob::adopt(&child);
        return Ok(child);
    }
    #[allow(unreachable_code)]
    c.spawn()
}

#[cfg(windows)]
#[allow(non_snake_case, non_camel_case_types, dead_code)]
mod winjob {
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::Mutex;

    #[repr(C)]
    struct BASIC {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    struct IO {
        a: u64,
        b: u64,
        c: u64,
        d: u64,
        e: u64,
        f: u64,
    }
    #[repr(C)]
    struct EXTENDED {
        basic: BASIC,
        io: IO,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }
    #[repr(C)]
    struct THREADENTRY32 {
        dw_size: u32,
        cnt_usage: u32,
        th32_thread_id: u32,
        th32_owner_process_id: u32,
        tp_base_pri: i32,
        tp_delta_pri: i32,
        dw_flags: u32,
    }
    #[repr(C)]
    struct PROCESSENTRY32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; 260],
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attr: *mut c_void, name: *const u16) -> isize;
        fn SetInformationJobObject(job: isize, class: i32, info: *mut c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: isize, process: isize) -> i32;
        fn TerminateJobObject(job: isize, code: u32) -> i32;
        fn CloseHandle(h: isize) -> i32;
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> isize;
        fn Thread32First(snap: isize, te: *mut THREADENTRY32) -> i32;
        fn Thread32Next(snap: isize, te: *mut THREADENTRY32) -> i32;
        fn Process32FirstW(snap: isize, pe: *mut PROCESSENTRY32W) -> i32;
        fn Process32NextW(snap: isize, pe: *mut PROCESSENTRY32W) -> i32;
        fn OpenThread(access: u32, inherit: i32, tid: u32) -> isize;
        fn ResumeThread(h: isize) -> u32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn TerminateProcess(h: isize, code: u32) -> i32;
    }
    const INVALID: isize = -1;
    static JOBS: Mutex<Option<HashMap<u32, isize>>> = Mutex::new(None);

    /// The suspended child put into a job of its own (kill-on-close), then its threads resumed.
    pub fn adopt(child: &Child) {
        let pid = child.id();
        unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job != 0 {
                let mut info: EXTENDED = std::mem::zeroed();
                info.basic.limit_flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                SetInformationJobObject(job, 9, &mut info as *mut EXTENDED as *mut c_void, std::mem::size_of::<EXTENDED>() as u32);
                if AssignProcessToJobObject(job, child.as_raw_handle() as isize) != 0 {
                    if let Ok(mut g) = JOBS.lock() {
                        g.get_or_insert_with(HashMap::new).insert(pid, job);
                    }
                } else {
                    CloseHandle(job);
                }
            }
        }
        resume(pid);
    }
    /// Every thread of `pid` resumed (it was started suspended); the process list asked again if none was found yet.
    fn resume(pid: u32) {
        for _ in 0..20 {
            if resume_once(pid) > 0 {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    fn resume_once(pid: u32) -> u32 {
        let mut n = 0u32;
        unsafe {
            let snap = CreateToolhelp32Snapshot(0x4, 0);
            if snap == INVALID || snap == 0 {
                return 0;
            }
            let mut te: THREADENTRY32 = std::mem::zeroed();
            te.dw_size = std::mem::size_of::<THREADENTRY32>() as u32;
            let mut ok = Thread32First(snap, &mut te) != 0;
            while ok {
                if te.th32_owner_process_id == pid {
                    let h = OpenThread(0x0002, 0, te.th32_thread_id); // THREAD_SUSPEND_RESUME
                    if h != 0 {
                        ResumeThread(h);
                        CloseHandle(h);
                        n += 1;
                    }
                }
                ok = Thread32Next(snap, &mut te) != 0;
            }
            CloseHandle(snap);
        }
        n
    }
    fn table() -> Vec<(u32, u32, String)> {
        let mut out = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(0x2, 0);
            if snap == INVALID || snap == 0 {
                return out;
            }
            let mut pe: PROCESSENTRY32W = std::mem::zeroed();
            pe.dw_size = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snap, &mut pe) != 0;
            while ok {
                let n = pe.sz_exe_file.iter().position(|c| *c == 0).unwrap_or(260);
                out.push((pe.th32_process_id, pe.th32_parent_process_id, String::from_utf16_lossy(&pe.sz_exe_file[..n])));
                ok = Process32NextW(snap, &mut pe) != 0;
            }
            CloseHandle(snap);
        }
        out
    }
    /// Every process below `pid` (children, theirs, …), by the system's process list.
    pub fn descendants(pid: u32) -> Vec<u32> {
        let t = table();
        let mut out: Vec<u32> = Vec::new();
        let mut front = vec![pid];
        while let Some(p) = front.pop() {
            for (c, parent, _) in t.iter() {
                if *parent == p && *c != pid && *c != 0 && !out.contains(c) {
                    out.push(*c);
                    front.push(*c);
                }
            }
        }
        out
    }
    /// A process's image name (for a report).
    pub fn image(pid: u32) -> String {
        table().into_iter().find(|(p, _, _)| *p == pid).map(|(_, _, n)| n).unwrap_or_else(|| "?".into())
    }
    /// Its job ended (everything in it) → whether it had one.
    pub fn terminate(pid: u32) -> bool {
        let job = JOBS.lock().ok().and_then(|g| g.as_ref().and_then(|m| m.get(&pid).copied()));
        match job {
            Some(j) => unsafe { TerminateJobObject(j, 1) != 0 },
            None => false,
        }
    }
    /// The job's handle let go (kill-on-close ends what is left in it).
    pub fn forget(pid: u32) {
        let job = JOBS.lock().ok().and_then(|mut g| g.as_mut().and_then(|m| m.remove(&pid)));
        if let Some(j) = job {
            unsafe {
                CloseHandle(j);
            }
        }
    }
    pub fn terminate_pid(pid: u32) -> bool {
        unsafe {
            let h = OpenProcess(0x0001, 0, pid); // PROCESS_TERMINATE
            if h == 0 {
                return false;
            }
            let ok = TerminateProcess(h, 1) != 0;
            CloseHandle(h);
            ok
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
    let mut child = spawn(&mut command(bin, args)).map_err(spawn_error)?;
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
    // (Ended: its job let go — on Windows whatever it left running in it ends with it.)
    forget_job(child.id());
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
/// stderr's last `max_err` bytes or so are kept (an error's last lines are what is shown).
pub fn spawn_lines<F: FnMut(&str) + Send + 'static>(bin: &Path, args: &[String], max_err: usize, mut on_line: F) -> Result<Lines, String> {
    let mut child = spawn(&mut command(bin, args)).map_err(spawn_error)?;
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
    let err = reader(se, max_err);
    Ok(Lines { child, pid, out: Some(out), err: Some(err) })
}

impl Lines {
    /// Waits for the end (and for every line read) → (exit code, stderr's tail).
    pub fn wait(mut self) -> (Option<i32>, String) {
        let st = self.child.wait().ok();
        forget_job(self.pid);
        if let Some(t) = self.out.take() {
            let _ = t.join();
        }
        let err = self.err.take().map(|t| t.join().unwrap_or_default()).unwrap_or_default();
        (st.and_then(|s| s.code()), String::from_utf8_lossy(&err).into_owned())
    }
}

/// A program found on the PATH (`name`, with .exe on Windows), as a spawn by bare name would find it.
pub fn find_on_path(name: &str) -> Option<std::path::PathBuf> {
    let file = if cfg!(windows) { format!("{}.exe", name) } else { name.to_string() };
    let path = std::env::var_os("PATH")?;
    for d in std::env::split_paths(&path) {
        let p = d.join(&file);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Made executable (rwxr-xr-x) off Windows.
pub fn make_executable(p: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755))?;
    }
    #[cfg(not(unix))]
    let _ = p;
    Ok(())
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
        let p = spawn_lines(Path::new("/bin/sh"), &sh("printf 'a\\r\\nb\\nc'; echo e >&2"), 4096, move |l| s2.lock().unwrap().push(l.to_string())).unwrap();
        let (code, err) = p.wait();
        assert_eq!((code, err.as_str()), (Some(0), "e\n"));
        assert_eq!(*seen.lock().unwrap(), vec!["a", "b", "c"]);
        // (A child that started a grandchild: both gone after kill_tree.)
        let dir = std::env::temp_dir().join(format!("vtproc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pidf = dir.join("gc.pid");
        let script = format!("sleep 60 & echo $! > '{}'; echo started; wait", pidf.display());
        let p = spawn_lines(Path::new("/bin/sh"), &sh(&script), 4096, |_| {}).unwrap();
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

#[cfg(test)]
mod path_tests {
    #[test]
    fn path_front_first() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let front = std::path::Path::new(if cfg!(windows) { "C:\\packs\\deno" } else { "/packs/deno" });
        let other = if cfg!(windows) { "C:\\bin" } else { "/bin" };
        let got = super::path_with_front(front, Some(format!("{}{}{}", other, sep, front.display()).into())).unwrap();
        assert_eq!(got.to_string_lossy(), format!("{}{}{}", front.display(), sep, other));
        assert_eq!(super::path_with_front(front, None).unwrap().to_string_lossy(), front.display().to_string());
    }
}

#[cfg(all(test, unix))]
mod orphan_tests {
    /// A child that starts a grandchild and ends at once: the grandchild — orphaned, no longer under it — is still ended
    /// by the tree kill (its process group).
    #[test]
    fn orphaned_grandchild_killed() {
        let dir = std::env::temp_dir().join(format!("kt-orphan-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let pidf = dir.join("gc.pid");
        let script = format!("sleep 30 & echo $! > '{}'; exit 0", pidf.display());
        let mut c = super::command(std::path::Path::new("/bin/sh"), &["-c".to_string(), script]);
        let mut child = super::spawn(&mut c).unwrap();
        let root = child.id();
        let _ = child.wait();
        let mut gc: u32 = 0;
        for _ in 0..100 {
            if let Ok(t) = std::fs::read_to_string(&pidf) {
                if let Ok(p) = t.trim().parse() {
                    gc = p;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(gc > 0 && super::alive(gc), "grandchild not running");
        let how = super::kill_tree_report(root);
        for _ in 0..100 {
            if !super::alive(gc) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(!super::alive(gc), "the orphaned grandchild survived: {}", how);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

