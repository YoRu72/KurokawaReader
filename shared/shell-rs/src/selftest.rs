// The runtime self-tests' frame (CI), the same for both apps: with <PREFIX>_SELFTEST=<file> set (Tools: KT, the
// Reader: KR), the app adds its own self-test script to the window's initialization script, the page runs its checks
// through the app's bridge and hands the results to the app's progress / done commands, which call progress() and
// done() here; done() writes them to <file> and ends the process: 0 when every required check passed, 1 otherwise. A
// watchdog writes what it has and ends with 2 if no verdict comes within <PREFIX>_SELFTEST_TIMEOUT seconds (100).
// Without <PREFIX>_SELFTEST none of this runs. (From Kurokawa Tools' src-tauri/src/selftest.rs, branch work-tauri:
// the app-neutral part; the app's own part — its script and settings, its test commands — stays in the app.)
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::util;

static OUT: OnceLock<PathBuf> = OnceLock::new();
static PROGRESS: Mutex<Option<Value>> = Mutex::new(None);
static FINISHED: Mutex<bool> = Mutex::new(false);
static ON_EXIT: OnceLock<fn()> = OnceLock::new();

/// The results file named by <prefix>_SELFTEST, when this is a self-test run.
pub fn out_path(prefix: &str) -> Option<PathBuf> {
    match std::env::var_os(format!("{}_SELFTEST", prefix)) {
        Some(v) if !v.is_empty() => Some(PathBuf::from(v)),
        None | Some(_) => None,
    }
}

/// Whether begin() started a self-test in this process.
pub fn active() -> bool {
    OUT.get().is_some()
}

/// Starts the self-test if <prefix>_SELFTEST is set: the results file kept, the watchdog started. False in a normal
/// run (and nothing started).
pub fn begin(prefix: &str) -> bool {
    let out = match out_path(prefix) {
        Some(p) => p,
        None => return false,
    };
    if OUT.set(out).is_err() {
        return true;
    }
    let secs: u64 = std::env::var(format!("{}_SELFTEST_TIMEOUT", prefix))
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(100);
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(secs));
        let got = match PROGRESS.lock() {
            Ok(g) => g.clone(),
            Err(_) => None,
        };
        finish(
            2,
            got.unwrap_or_else(|| json!([])),
            &format!("watchdog: no verdict within {} s", secs),
        );
    });
    true
}

/// Something to do just before the process ends (Tools: aria2c stopped). Set once.
pub fn on_exit(f: fn()) {
    let _ = ON_EXIT.set(f);
}

/// 0 when there are results and every one not marked `required: false` has `ok: true`; 1 otherwise.
pub fn verdict(results: &Value) -> i32 {
    let list = match results {
        Value::Array(a) => a,
        _ => return 1,
    };
    if list.is_empty() {
        return 1;
    }
    for r in list.iter() {
        let required = r.get("required").and_then(|x| x.as_bool()).unwrap_or(true);
        let ok = r.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
        if required && !ok {
            return 1;
        }
    }
    0
}

/// The results written, the exit hook run, the process ended with `code` (once).
pub fn finish(code: i32, results: Value, note: &str) {
    {
        let mut f = match FINISHED.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if *f {
            return;
        }
        *f = true;
    }
    if let Some(p) = OUT.get() {
        let doc = json!({ "code": code, "note": note, "os": util::node_platform(), "arch": util::node_arch(), "results": results });
        let _ = std::fs::write(p, doc.to_string());
    }
    if let Some(f) = ON_EXIT.get() {
        f();
    }
    std::process::exit(code);
}

/// The results so far (what the watchdog writes if the page stalls).
pub fn progress(results: Value) -> Result<(), String> {
    if !active() {
        return Err("not a self-test run".to_string());
    }
    if let Ok(mut g) = PROGRESS.lock() {
        *g = Some(results);
    }
    Ok(())
}

/// The page's verdict: written, and the process ended (0 all required passed, 1 not).
pub fn done(results: Value) -> Result<(), String> {
    if !active() {
        return Err("not a self-test run".to_string());
    }
    let code = verdict(&results);
    finish(code, results, "");
    Ok(())
}
