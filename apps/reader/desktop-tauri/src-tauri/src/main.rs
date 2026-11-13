// KurokawaReader — the Tauri shell (stages R0–R1 of docs/RUST-PORT-READER.md, beside the Electron one in ../../desktop):
// the same web app (../../dist) in a window made here, with bridge.js run before the page's own scripts on every load
// so the page finds the same `window.kurokawaDesktop` the Electron preload gives it. The commands are thin wrappers
// (commands.rs) over the crate both apps' shells share (shared/shell-rs, `kurokawa_shell`); what is not ported yet is
// a stub in bridge.js (see ../PORTING.md).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod enginetest;
mod openargs;
mod openfile;
mod scan;
mod selftest;
mod titlebar;

use kurokawa_shell::{net, util, winstate};
#[allow(unused_imports)]
use tauri::Manager;

/// The page's bridge (../../bridge.js), injected as the window's initialization script.
const BRIDGE_JS: &str = include_str!("../../bridge.js");

/// desktop/main.cjs's createWindow: 1180×820 when nothing was saved, at least 420×600.
pub const WINDOW: winstate::Defaults = winstate::Defaults {
    width: 1180.0,
    height: 820.0,
    min_width: 420.0,
    min_height: 600.0,
};

/// The identity of the app's own requests: a plain browser's, as the Electron shell gives (its user agent with the
/// Electron and app tokens taken out — some sites put a check in front of anything else). A request that names its
/// own User-Agent (the sources send the page's) keeps it.
fn user_agent() -> String {
    let system = if cfg!(target_os = "windows") {
        "Windows NT 10.0; Win64; x64"
    } else if cfg!(target_os = "macos") {
        "Macintosh; Intel Mac OS X 10_15_7"
    } else {
        "X11; Linux x86_64"
    };
    format!(
        "Mozilla/5.0 ({}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        system
    )
}

fn main() {
    net::configure(user_agent());
    let mut builder = tauri::Builder::default();
    // (Single instance — main.cjs's requestSingleInstanceLock: a second launch hands its files and links to this
    // window and ends. Registered first, as its documentation asks. On Linux only with a D-Bus session bus.)
    if openfile::single_instance_possible() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            openfile::second_launch(app, argv, cwd);
        }));
    }
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::kr_read_file,
            commands::kr_file_size,
            commands::kr_folder_read,
            commands::kr_folder_write,
            commands::kr_write_binary,
            commands::kr_scan_device,
            commands::kr_scan_folder,
            commands::kr_folder_pick,
            commands::kr_archive_pick_dir,
            commands::kr_archive_pick_file,
            commands::kr_default_apps,
            commands::kr_http,
            selftest::kr_selftest_progress,
            selftest::kr_selftest_done,
            selftest::kr_selftest_remove,
            selftest::kr_selftest_clipboard,
            selftest::kr_selftest_winstate,
            selftest::kr_selftest_update,
            selftest::kr_selftest_launch,
            selftest::kr_selftest_mkdir,
            selftest::kr_selftest_rmdir,
            openfile::kr_open_take,
            titlebar::kr_title_bar,
            enginetest::kr_engine_shot,
            enginetest::kr_engine_profile
        ])
        .on_window_event(|window, event| {
            winstate::on_event(window, event);
            titlebar::on_event(window, event);
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // (What Electron's preload knows before the first call: the OS, in Node's words — its `platform`.)
            let boot = serde_json::json!({ "os": util::node_platform(), "arch": util::node_arch() });
            let mut script: String = format!("window.__KR_BOOT__ = {};\n{}", boot, BRIDGE_JS);
            // (Only with KR_SELFTEST set: the self-test, after the bridge.)
            if let Some(t) = selftest::script(&handle) {
                script.push('\n');
                script.push_str(&t);
            }
            // (Only with KR_ENGINETEST set, and no self-test: the engine test, after the bridge — stage R1.)
            if let Some(t) = enginetest::script(&handle) {
                script.push('\n');
                script.push_str(&t);
            }
            // (The window of desktop/main.cjs's createWindow: 1180×820 or as it was left, at least 420×600, titled
            // KurokawaReader — with the app's own title bar unless the system's was chosen (titlebar.rs): no system
            // frame on Windows and Linux, the page draws the bar and its buttons; on a Mac the system's lights over
            // the page, its title hidden. Made here rather than in tauri.conf.json so it can carry the
            // initialization script. Tauri's own drag-and-drop handling is off so the page gets the HTML drop events
            // it uses to import books.)
            let own = titlebar::own_at_start(&handle);
            let saved = winstate::load(&handle, &WINDOW);
            let mut b = tauri::WebviewWindowBuilder::new(
                app.handle(),
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("KurokawaReader")
            .inner_size(saved.width, saved.height)
            .min_inner_size(WINDOW.min_width, WINDOW.min_height)
            .disable_drag_drop_handler()
            .initialization_script(script.as_str());
            if let (Some(x), Some(y)) = (saved.x, saved.y) {
                b = b.position(x, y);
            }
            #[cfg(not(target_os = "macos"))]
            {
                b = b.decorations(!own);
            }
            #[cfg(target_os = "macos")]
            {
                if own {
                    b = b
                        .title_bar_style(tauri::TitleBarStyle::Overlay)
                        .hidden_title(true);
                }
            }
            if saved.maximized {
                b = b.maximized(true);
            }
            b.build()?;
            // (Files and links on this launch's own command line, kept until the page takes them: openfile.rs.)
            openfile::at_start(&handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building KurokawaReader");
    app.run(|handle, event| {
        // (A Mac hands files opened with the app — double-click, «Open with», dropped on its icon — and the app's
        // own links as Apple Events, at a cold start too.)
        #[cfg(target_os = "macos")]
        {
            if let tauri::RunEvent::Opened { urls } = &event {
                let list: Vec<String> = urls.iter().map(|u| u.to_string()).collect();
                openfile::opened(handle, list);
            }
        }
        let _ = (handle, event);
    });
}
