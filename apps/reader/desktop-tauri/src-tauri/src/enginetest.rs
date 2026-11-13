// The Reader's engine test (stage R1, CI): with KR_ENGINETEST=<file> set, the window's initialization script also
// carries ../../enginetest.js and its settings (a run id, the OS, the time budget). The page then runs the web app's
// key cases in this system's web view — books imported, opened, searched, highlighted, a PDF drawn, the converter, the
// fonts, Arabic — and hands its results to the self-test commands (kr_selftest_progress / kr_selftest_done, selftest.rs),
// which write them to <file> and end the process: 0 every required check passed, 1 not; the shared frame's watchdog
// ends it with 2 after KR_ENGINETEST_TIMEOUT seconds. Two commands of its own: kr_engine_shot (the screen captured to
// a PNG with the system's tool, for a person to compare) and kr_engine_profile (where the web view keeps its data).
// Without KR_ENGINETEST none of this runs, and a self-test run (KR_SELFTEST) takes precedence. Std only, apart from
// the frame and Tauri's handle.
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use kurokawa_shell::{selftest as frame, shell, util};

const ENGINETEST_JS: &str = include_str!("../../enginetest.js");
/// The shared frame's prefix: it reads KR_ENGINE_SELFTEST / KR_ENGINE_SELFTEST_TIMEOUT, set here from KR_ENGINETEST /
/// KR_ENGINETEST_TIMEOUT.
const PREFIX: &str = "KR_ENGINE";

/// The script added to the window's initialization script (None in a normal run or a self-test run). Starts the
/// watchdog.
pub fn script(app: &AppHandle) -> Option<String> {
    if frame::active() {
        return None;
    }
    match std::env::var_os("KR_ENGINETEST") {
        Some(v) if !v.is_empty() => std::env::set_var("KR_ENGINE_SELFTEST", v),
        _ => return None,
    }
    if let Some(v) = std::env::var_os("KR_ENGINETEST_TIMEOUT") {
        std::env::set_var("KR_ENGINE_SELFTEST_TIMEOUT", v);
    }
    if !frame::begin(PREFIX) {
        return None;
    }
    let run_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let budget: u64 = std::env::var("KR_ENGINETEST_BUDGET")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(360);
    let cfg = json!({
        "runId": run_id.to_string(),
        "os": util::node_platform(),
        "version": app.package_info().version.to_string(),
        "budgetMs": budget * 1000,
    });
    Some(format!("window.__KR_ENGINETEST__ = {};\n{}", cfg, ENGINETEST_JS))
}

fn only_in_test() -> Result<(), String> {
    if frame::active() {
        Ok(())
    } else {
        Err("not a test run".to_string())
    }
}

/// The screen captured now to <KR_ENGINETEST_SHOTS or the results file's folder>/<name>.png: its path and size.
#[tauri::command]
pub async fn kr_engine_shot(name: String) -> Result<String, String> {
    only_in_test()?;
    let dir = match std::env::var_os("KR_ENGINETEST_SHOTS") {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => frame::out_path(PREFIX)
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_else(std::env::temp_dir),
    };
    let _ = std::fs::create_dir_all(&dir);
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let file = dir.join(format!("{}.png", safe));
    let _ = std::fs::remove_file(&file);
    let mut cmd = capture_command(&file);
    run_with_timeout(&mut cmd, Duration::from_secs(25))?;
    match std::fs::metadata(&file) {
        Ok(m) if m.len() > 0 => Ok(format!(
            "{} ({} KB)",
            file.to_string_lossy(),
            m.len() / 1024
        )),
        _ => Err("the capture tool wrote no picture".to_string()),
    }
}

#[cfg(target_os = "linux")]
fn capture_command(file: &Path) -> Command {
    // (ImageMagick's import, of the X display the app runs on — Xvfb in CI.)
    let mut c = Command::new("import");
    c.arg("-window").arg("root").arg(file);
    c
}

#[cfg(target_os = "macos")]
fn capture_command(file: &Path) -> Command {
    let mut c = Command::new("screencapture");
    c.arg("-x").arg(file);
    c
}

#[cfg(target_os = "windows")]
fn capture_command(file: &Path) -> Command {
    use std::os::windows::process::CommandExt;
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = [System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $bmp.Save('{}', [System.Drawing.Imaging.ImageFormat]::Png)",
        file.to_string_lossy().replace('\'', "''")
    );
    let mut c = Command::new("powershell");
    c.args(["-NoProfile", "-NonInteractive", "-Command", script.as_str()]);
    // (No console window of its own over the app: CREATE_NO_WINDOW.)
    c.creation_flags(0x0800_0000);
    c
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn capture_command(_file: &Path) -> Command {
    Command::new("false")
}

/// `cmd` run to its end, or stopped after `limit`.
fn run_with_timeout(cmd: &mut Command, limit: Duration) -> Result<(), String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start the capture tool: {}", e))?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(());
                }
                let mut err = String::new();
                if let Some(mut s) = child.stderr.take() {
                    let _ = s.read_to_string(&mut err);
                }
                return Err(format!(
                    "the capture tool failed ({}): {}",
                    status,
                    err.trim()
                ));
            }
            Ok(None) => {
                if start.elapsed() > limit {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("the capture tool did not finish in time".to_string());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// A folder's files: (exists, bytes, files, the first folder inside whose name holds "indexeddb"). At most 20000
/// entries are looked at.
fn survey(root: &Path) -> (bool, u64, u64, Option<String>) {
    if !root.is_dir() {
        return (false, 0, 0, None);
    }
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    let (mut bytes, mut files, mut seen) = (0u64, 0u64, 0u32);
    let mut idb: Option<String> = None;
    while let Some(d) = stack.pop() {
        let rd = match std::fs::read_dir(&d) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for e in rd.flatten() {
            seen += 1;
            if seen > 20000 {
                return (true, bytes, files, idb);
            }
            let p = e.path();
            let ft = match e.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_dir() {
                if idb.is_none()
                    && e.file_name()
                        .to_string_lossy()
                        .to_lowercase()
                        .contains("indexeddb")
                {
                    idb = Some(p.to_string_lossy().into_owned());
                }
                stack.push(p);
            } else if ft.is_file() {
                files += 1;
                bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    (true, bytes, files, idb)
}

/// Where this system's web view may keep the app's data (the library's IndexedDB among it): each candidate folder,
/// whether it is there, its size, and the IndexedDB folder found in it.
#[tauri::command]
pub async fn kr_engine_profile(app: AppHandle) -> Result<Value, String> {
    only_in_test()?;
    let home = shell::home_dir(&app);
    let id = app.config().identifier.clone();
    let mut dirs: Vec<(String, PathBuf)> = Vec::new();
    if let Ok(d) = app.path().app_local_data_dir() {
        dirs.push(("app_local_data_dir".to_string(), d));
    }
    if let Ok(d) = app.path().app_data_dir() {
        dirs.push(("app_data_dir".to_string(), d));
    }
    if let Ok(d) = app.path().app_cache_dir() {
        dirs.push(("app_cache_dir".to_string(), d));
    }
    let lib = home.join("Library").join("WebKit");
    dirs.push(("~/Library/WebKit/<identifier>".to_string(), lib.join(&id)));
    dirs.push((
        "~/Library/WebKit/kurokawa-reader".to_string(),
        lib.join("kurokawa-reader"),
    ));
    let share = home.join(".local").join("share");
    dirs.push(("~/.local/share/<identifier>".to_string(), share.join(&id)));
    dirs.push((
        "~/.local/share/kurokawa-reader".to_string(),
        share.join("kurokawa-reader"),
    ));
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut out: Vec<Value> = Vec::new();
    for (label, p) in dirs {
        if seen.contains(&p) {
            continue;
        }
        seen.push(p.clone());
        let (exists, bytes, files, idb) = survey(&p);
        if !exists && label.starts_with('~') {
            continue;
        }
        out.push(json!({
            "name": label,
            "path": p.to_string_lossy().into_owned(),
            "exists": exists,
            "files": files,
            "kb": bytes / 1024,
            "indexeddb": idb,
        }));
    }
    Ok(Value::Array(out))
}
