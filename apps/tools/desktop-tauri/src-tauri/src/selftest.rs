// The runtime self-test (CI): with KT_SELFTEST=<file> set, the window's initialization script also carries
// ../../selftest.js and its settings (a loopback test server's address, the expected digests), the page runs its
// checks through window.kurokawaTools and hands the results to kt_selftest_done, which writes them to <file> and
// ends the process: 0 when every required check passed, 1 otherwise; a watchdog writes what it has and ends with 2
// if nothing comes in time. Without KT_SELFTEST none of this runs (no script, no server, no watchdog; the two
// commands refuse).
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{engine, testserver, util};

const SELFTEST_JS: &str = include_str!("../../selftest.js");

static OUT: OnceLock<PathBuf> = OnceLock::new();
static PROGRESS: Mutex<Option<Value>> = Mutex::new(None);
static FINISHED: Mutex<bool> = Mutex::new(false);

/// The results file, when this is a self-test run.
pub fn out_path() -> Option<PathBuf> {
    match std::env::var_os("KT_SELFTEST") {
        Some(v) if !v.is_empty() => Some(PathBuf::from(v)),
        _ => None,
    }
}

/// The script added to the window's initialization script (None in a normal run). Starts the test server and the
/// watchdog. `aria2` is the aria2c the engine found → (path, whether it is the app's own).
pub fn script(aria2: Option<(String, bool)>) -> Option<String> {
    let out = out_path()?;
    let _ = OUT.set(out);
    let secs: u64 = std::env::var("KT_SELFTEST_TIMEOUT")
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
    let base = match testserver::start() {
        Ok(port) => format!("http://127.0.0.1:{}", port),
        Err(_) => String::new(),
    };
    let big = testserver::big_bytes();
    let big_sha = util::hex(Sha256::digest(&big).as_slice());
    let bin: Vec<u8> = (0..=255u8).collect();
    let (aria2_bin, aria2_bundled) = match aria2 {
        Some((p, b)) => (Value::String(p), b),
        None => (Value::Null, false),
    };
    let want_bundled = std::env::var("KT_SELFTEST_BUNDLED")
        .map(|v| v == "1")
        .unwrap_or(false);
    let cfg = json!({
        "base": base,
        "temp": std::env::temp_dir().to_string_lossy().into_owned(),
        "aria2Bin": aria2_bin,
        "aria2Bundled": aria2_bundled,
        "wantBundled": want_bundled,
        "text": testserver::TEXT,
        "gzText": testserver::GZ_TEXT,
        "binB64": util::b64_encode(&bin),
        "bigSize": testserver::BIG_SIZE,
        "bigSha256": big_sha,
        "os": util::node_platform(),
    });
    Some(format!(
        "window.__KT_SELFTEST__ = {};\n{}",
        cfg, SELFTEST_JS
    ))
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

/// The results written, aria2c stopped, the process ended with `code` (once).
fn finish(code: i32, results: Value, note: &str) {
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
    if let Some(e) = engine::get() {
        e.stop();
    }
    std::process::exit(code);
}

/// The results so far (what the watchdog writes if the page stalls).
#[tauri::command]
pub async fn kt_selftest_progress(results: Value) -> Result<(), String> {
    if OUT.get().is_none() {
        return Err("not a self-test run".to_string());
    }
    if let Ok(mut g) = PROGRESS.lock() {
        *g = Some(results);
    }
    Ok(())
}

/// The page's verdict: written, and the process ended (0 all required passed, 1 not).
#[tauri::command]
pub async fn kt_selftest_done(results: Value) -> Result<(), String> {
    if OUT.get().is_none() {
        return Err("not a self-test run".to_string());
    }
    let code = verdict(&results);
    finish(code, results, "");
    Ok(())
}
