// Tools' part of the runtime self-test (CI). The frame — the results file named by KT_SELFTEST, the watchdog
// (KT_SELFTEST_TIMEOUT, 100 s), the verdict, the exit — is the shared crate's (kurokawa_shell::selftest, the same for
// both apps); here: the script added to the window's initialization script (../../selftest.js) with its settings — the
// loopback test server's address (kurokawa_shell::testserver), the expected digests, a second disk for the file jobs'
// moves across disks where this machine has one, a MEGA file's key and bytes —, and the two commands the page reports
// through. Without KT_SELFTEST none of this runs (no script, no server, no watchdog; the commands refuse).
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use kurokawa_shell::{selftest, testserver, util};

use crate::engine;

const SELFTEST_JS: &str = include_str!("../../selftest.js");

/// aria2c stopped (its session saved) before the process ends.
fn stop_engine() {
    if let Some(e) = engine::get() {
        e.stop();
    }
}

/// A writable folder on another disk than `temp` (made here, emptied by the page): /dev/shm on Linux, the runner's
/// own disk on Windows (its temp folder is on C:, the work on D:); None with the reason when there is none.
fn other_volume(temp: &Path) -> (Option<PathBuf>, String) {
    let mut cands: Vec<PathBuf> = Vec::new();
    if cfg!(unix) {
        cands.push(PathBuf::from("/dev/shm"));
    }
    if let Some(r) = std::env::var_os("RUNNER_TEMP").filter(|v| !v.is_empty()) {
        cands.push(PathBuf::from(r));
    }
    if let Ok(c) = std::env::current_dir() {
        cands.push(c);
    }
    for c in cands {
        if !c.is_dir() {
            continue;
        }
        let probe = c.join(format!("kt-selftest-vol-{}", std::process::id()));
        if std::fs::create_dir_all(&probe).is_err() {
            continue;
        }
        if !kt_core::filejobs::same_storage(&probe, temp) {
            return (Some(probe), String::new());
        }
        let _ = std::fs::remove_dir(&probe);
    }
    (None, "no second disk on this machine (tried /dev/shm, RUNNER_TEMP, the working folder)".to_string())
}

/// The script added to the window's initialization script (None in a normal run): the shared frame started, the test
/// server started. `aria2` is the aria2c the engine found → (path, whether it is the app's own).
pub fn script(aria2: Option<(String, bool)>) -> Option<String> {
    if !selftest::begin("KT") {
        return None;
    }
    selftest::on_exit(stop_engine);
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
    let temp = std::env::temp_dir();
    let (other, other_why) = other_volume(&temp);
    // (A MEGA file as aria2 leaves it: the bytes encrypted with a file key, which kt:megaDecrypt must undo.)
    let mega_key: Vec<u8> = (0u8..32).map(|i| i.wrapping_mul(29).wrapping_add(11)).collect();
    let mega_plain: Vec<u8> = "kurokawa mega selftest \u{2713} ".repeat(40).into_bytes();
    let mut mega_enc = mega_plain.clone();
    if let Some((k, iv)) = kt_core::mega::key_parts(&util::b64_encode(&mega_key)) {
        kt_core::mega::Ctr::new(&k, &iv).apply(&mut mega_enc);
    }
    let cfg = json!({
        "base": base,
        "temp": temp.to_string_lossy().into_owned(),
        "otherTemp": other.map(|p| p.to_string_lossy().into_owned()),
        "otherWhy": other_why,
        "aria2Bin": aria2_bin,
        "aria2Bundled": aria2_bundled,
        "wantBundled": want_bundled,
        // (Stage P7: the shipped 7-Zip must be found and work where CI bundles it — Windows and Linux; a Mac's reported.)
        "wantSeven": want_bundled && !cfg!(target_os = "macos"),
        "text": testserver::TEXT,
        "gzText": testserver::GZ_TEXT,
        "binB64": util::b64_encode(&bin),
        "bigSize": testserver::BIG_SIZE,
        "bigSha256": big_sha,
        "megaKey": util::b64_encode(&mega_key),
        "megaPlainB64": util::b64_encode(&mega_plain),
        "megaEncB64": util::b64_encode(&mega_enc),
        "os": util::node_platform(),
        // (Stage P8: the made-up name the test server's DNS-over-HTTPS resolver answers, and its 3 MiB file.)
        "dohHost": testserver::DOH_HOST,
        "largeSize": testserver::LARGE_SIZE,
    });
    Some(format!("window.__KT_SELFTEST__ = {};\n{}", cfg, SELFTEST_JS))
}

/// The results so far (what the watchdog writes if the page stalls).
#[tauri::command]
pub async fn kt_selftest_progress(results: Value) -> Result<(), String> {
    selftest::progress(results)
}

/// The page's verdict: written, and the process ended (0 all required passed, 1 not).
#[tauri::command]
pub async fn kt_selftest_done(results: Value) -> Result<(), String> {
    selftest::done(results)
}
