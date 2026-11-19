// Kurokawa Tools — device battery, piece W4: «Report a device» and the command line (--battery-json, --battery-help).
// GPL-3.0-or-later (the device battery feature derives from Wireless Device Battery Monitor — ../../../NOTICE.md).
// The rules and the texts are kt-battery's (report.rs, cli.rs, json.rs, tested with made-up devices); this file only brings
// in what the system gives: the devices the loop last saw (battery.rs), the HID collections this system lists, the
// system's name, and the names that must never be written (this computer's and this user's).
// - kt_battery_report: the report's text for the page — shown whole, then copied or saved by the user. Nothing is sent.
// - run_cli: called first in main(): with one of the two flags it prints and ends the program with 0 — before the single-instance
//   guard, the window, the tray and the start with the system are made, so it never touches a running copy.
// UNVERIFIED here: this shell cannot be compiled on the box that wrote it (GitHub's CI is the compiler).
use std::io::Write;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use kt_battery::cli;
use kt_battery::report;
use kt_battery::runner::{Platform, Prefs};

/// This system's reader, None where there is none.
fn platform() -> Option<Arc<dyn Platform>> {
    #[cfg(windows)]
    {
        return Some(Arc::new(kt_battery::win::WinPlatform::new()));
    }
    #[cfg(target_os = "linux")]
    {
        return Some(Arc::new(kt_battery::linux::LinuxPlatform::new()));
    }
    #[cfg(target_os = "macos")]
    {
        return Some(Arc::new(kt_battery::macos::MacPlatform::new()));
    }
    #[allow(unreachable_code)]
    None
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// This computer's and this user's names, to be masked wherever a device's name happens to hold one.
fn private_names() -> Vec<String> {
    let mut v: Vec<String> = ["USERNAME", "USER", "LOGNAME", "COMPUTERNAME", "HOSTNAME", "USERDOMAIN"].iter().filter_map(|k| std::env::var(k).ok()).collect();
    #[cfg(target_os = "linux")]
    {
        if let Ok(h) = std::fs::read_to_string("/etc/hostname") {
            v.push(h.trim().to_string());
        }
    }
    v.retain(|s| s.trim().chars().count() >= 3);
    v.sort();
    v.dedup();
    v
}

/// The program's version (apps/tools/package.json's, as tauri.conf.json takes it) before Tauri is up.
fn version() -> String {
    const PKG: &str = include_str!("../../../package.json");
    PKG.find("\"version\"")
        .and_then(|i| PKG[i + 9..].split('"').nth(1))
        .map(str::to_string)
        .unwrap_or_default()
}

/// Where the text goes: Windows' own choice (win/console.rs: a redirect, the console, or nowhere), else standard output.
struct Out {
    to: Box<dyn Write>,
    ascii: bool,
}

fn open_out() -> Out {
    #[cfg(windows)]
    {
        let o = kt_battery::win::console::open_output();
        return Out { to: o.to, ascii: o.ascii };
    }
    #[allow(unreachable_code)]
    Out { to: Box::new(std::io::stdout()), ascii: false }
}

/// `--battery-json` and `--battery-help`: the text printed and 0 returned; None when neither flag is there (the program
/// starts as usual). One reading pass with the loop's own deadlines; the default settings (a reader that sends a status
/// request stays off); no window, no tray, no background loop, no second-instance hand-over.
pub fn run_cli() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let action = cli::action(&args)?;
    let mut out = open_out();
    let text = match action {
        cli::Action::Help => cli::help_text(),
        cli::Action::Json => {
            let list = match platform() {
                Some(p) => cli::one_pass(p, &Prefs::default(), now_ms()),
                None => Vec::new(),
            };
            cli::devices_json(&list, &version(), &private_names()).render(out.ascii)
        }
    };
    let _ = out.to.write_all(text.as_bytes());
    let _ = out.to.flush();
    Some(0)
}

/// The page's «Report a device»: the report's text — the devices the loop last saw, this system's HID collections, the app's
/// and the system's version —, built here and given whole to the page to show, copy or save. Nothing is sent anywhere.
#[tauri::command]
pub async fn kt_battery_report(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let devices = crate::battery::states_now();
        let no_query = crate::battery::no_query_now(&app);
        let hid = platform().map(|p| p.inventory()).unwrap_or_default();
        let secrets = cli::secrets_of(&devices, &private_names());
        let (os_name, os_version) = cli::os_info();
        let app_text = format!("Kurokawa Tools {}", app.package_info().version);
        let text = report::build(&report::Input { app: &app_text, os_name: &os_name, os_version: &os_version, hid: &hid, devices: &devices, secrets: &secrets, no_query: &no_query });
        json!({ "text": text, "devices": devices.len(), "collections": hid.len() })
    })
    .await
    .map_err(|e| e.to_string())
}
