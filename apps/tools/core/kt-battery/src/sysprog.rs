// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery), piece P1: running one of the system's own programs (upower,
// bluetoothctl on Linux; ioreg, system_profiler on a Mac) to read what it reports.
// Written for Tools; the original's §9.10 fault avoided: a program is never looked for through the current folder or
// the PATH (a planted program would run every minute) — only at fixed absolute places, a regular file; its arguments
// are a fixed list (an address is validated before it goes in); it gets no input, a plain C locale, a deadline after
// which it is killed and reaped, and at most `max_out` bytes of its output are kept (a program that writes more is
// stopped). Its absence is an ordinary answer (None), never an error shown as one.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// The first of `places` that is an absolute path to a regular file.
pub fn find(places: &[&str]) -> Option<PathBuf> {
    places.iter().map(Path::new).find(|p| p.is_absolute() && p.metadata().map_or(false, |m| m.is_file())).map(Path::to_path_buf)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunErr {
    /// Not on this system.
    Missing,
    /// Could not be started.
    Start,
    /// Killed at the deadline.
    TimedOut,
    /// Wrote more than allowed: killed.
    TooLong,
}

/// What the program wrote and whether it ended well.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ran {
    pub out: String,
    pub ok: bool,
}

/// Runs `prog` (an absolute path) with `args`, by `deadline`; keeps at most `max_out` bytes of its standard output.
pub fn run(prog: &Path, args: &[&str], deadline: Instant, max_out: usize) -> Result<Ran, RunErr> {
    if !prog.is_absolute() {
        return Err(RunErr::Missing);
    }
    let mut cmd = Command::new(prog);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).env_clear().env("LC_ALL", "C").env("LANG", "C");
    // (bluetoothctl and upower talk to the system bus; its address may be in the environment.)
    for k in ["DBUS_SYSTEM_BUS_ADDRESS", "HOME"] {
        if let Some(v) = std::env::var_os(k) {
            cmd.env(k, v);
        }
    }
    let mut child = cmd.spawn().map_err(|_| RunErr::Start)?;
    let mut stdout = child.stdout.take().ok_or(RunErr::Start)?;
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, ()>>();
    let cap = max_out;
    let reader = std::thread::Builder::new().name("kt-battery-prog".into()).spawn(move || {
        let mut buf = Vec::new();
        let r = (&mut stdout).take(cap as u64 + 1).read_to_end(&mut buf);
        let _ = tx.send(if r.is_ok() && buf.len() <= cap { Ok(buf) } else { Err(()) });
    });
    if reader.is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return Err(RunErr::Start);
    }
    let left = deadline.saturating_duration_since(Instant::now());
    let got = rx.recv_timeout(left.max(Duration::from_millis(1)));
    let result = match got {
        Ok(Ok(bytes)) => {
            // (The output is complete; the program ends now or is ended at the deadline.)
            let ok = wait_until(&mut child, deadline);
            Ok(Ran { out: String::from_utf8_lossy(&bytes).into_owned(), ok })
        }
        Ok(Err(())) => Err(RunErr::TooLong),
        Err(_) => Err(RunErr::TimedOut),
    };
    if result.is_err() {
        let _ = child.kill();
    }
    // (Always reaped: no process is left behind.)
    let _ = child.wait();
    result
}

/// Starts `prog` with `args` and lets it run on its own (a settings window): no input or output, reaped by a thread of
/// its own when it ends. false when it could not be started.
pub fn spawn_detached(prog: &Path, args: &[&str]) -> bool {
    if !prog.is_absolute() {
        return false;
    }
    match Command::new(prog).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        Ok(mut c) => {
            let _ = std::thread::Builder::new().name("kt-battery-reap".into()).spawn(move || {
                let _ = c.wait();
            });
            true
        }
        Err(_) => false,
    }
}

/// Waits for the child until `deadline` (its output already closed, so this is short): true when it exited well.
fn wait_until(child: &mut std::process::Child, deadline: Instant) -> bool {
    loop {
        match child.try_wait() {
            Ok(Some(st)) => return st.success(),
            Ok(None) if Instant::now() < deadline => {
                // (Its output has ended: it is exiting. A short yield, bounded by the deadline.)
                std::thread::sleep(Duration::from_millis(2).min(deadline.saturating_duration_since(Instant::now())));
            }
            _ => {
                let _ = child.kill();
                return false;
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn finds_only_absolute_regular_files() {
        assert!(find(&["relative/prog", "/nonexistent/kt-battery-x"]).is_none());
        let dir = std::env::temp_dir();
        assert!(find(&[dir.to_str().unwrap()]).is_none(), "a folder is not a program");
    }

    #[test]
    fn runs_with_a_deadline_and_a_cap() {
        let Some(sh) = find(&["/bin/sh", "/usr/bin/sh"]) else { return };
        let far = Instant::now() + Duration::from_secs(10);
        let r = run(&sh, &["-c", "echo hello"], far, 1024).unwrap();
        assert_eq!((r.out.as_str(), r.ok), ("hello\n", true));
        assert_eq!(run(&sh, &["-c", "echo $LC_ALL"], far, 1024).unwrap().out, "C\n", "a plain locale");
        assert_eq!(run(&sh, &["-c", "exit 3"], far, 1024).unwrap().ok, false);
        assert_eq!(run(&sh, &["-c", "echo 0123456789"], far, 4), Err(RunErr::TooLong));
        // (A program that never ends: killed at its deadline — the call returns soon after it.)
        let t0 = Instant::now();
        assert_eq!(run(&sh, &["-c", "exec sleep 30"], Instant::now() + Duration::from_millis(150), 1024), Err(RunErr::TimedOut));
        assert!(t0.elapsed() < Duration::from_secs(5));
        assert_eq!(run(Path::new("rel"), &[], far, 10), Err(RunErr::Missing));
    }
}
