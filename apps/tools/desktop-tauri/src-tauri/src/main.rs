// Kurokawa Tools — the Tauri shell (stage 2, beside the Electron one in ../../desktop): the same web UI (../../dist)
// in a window made here, with bridge.js run before the page's own scripts on every load so the page finds the
// same `window.kurokawaTools` the Electron preload gives it, and the download engine (aria2c beside the app,
// engine.rs) started in the background (see ../PORTING.md for what is ported so far).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod engine;
mod engine_core;
mod files;
mod hash;
mod net;
mod rpc;
mod selftest;
mod testserver;
mod util;
mod winstate;

use std::path::PathBuf;

use tauri::Manager;

/// The page's bridge (../../bridge.js), injected as the window's initialization script.
const BRIDGE_JS: &str = include_str!("../../bridge.js");

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::kt_state,
            commands::kt_engine_retry,
            commands::kt_list,
            commands::kt_add,
            commands::kt_pause,
            commands::kt_resume,
            commands::kt_remove,
            commands::kt_set_files,
            commands::kt_set_url,
            commands::kt_move,
            commands::kt_set_limits,
            commands::kt_configure,
            commands::kt_torrent_info,
            commands::kt_rename,
            commands::kt_default_dir,
            commands::kt_roots,
            commands::kt_list_dir,
            commands::kt_path_info,
            commands::kt_exists,
            commands::kt_siblings,
            commands::kt_read_file,
            commands::kt_write_text,
            commands::kt_write_temp,
            commands::kt_write_temp_bytes,
            commands::kt_remove_file,
            commands::kt_hash_file,
            commands::kt_open_path,
            commands::kt_open_external,
            commands::kt_open,
            commands::kt_pick_dir,
            commands::kt_pick_file,
            commands::kt_save_text,
            commands::kt_clipboard_text,
            commands::kt_http,
            commands::kt_check_update,
            selftest::kt_selftest_progress,
            selftest::kt_selftest_done
        ])
        .on_window_event(|window, event| winstate::on_event(window, event))
        .setup(|app| {
            // The engine: its files in the app's data folder, aria2c looked for in the resource folder (then beside
            // the executable, then on the PATH), started in the background.
            let handle = app.handle().clone();
            let data_dir = match app.path().app_data_dir() {
                Ok(d) => d,
                Err(_) => std::env::temp_dir().join("kurokawa-tools"),
            };
            let mut res_dirs: Vec<PathBuf> = Vec::new();
            if let Ok(r) = app.path().resource_dir() {
                res_dirs.push(r);
            }
            if let Ok(exe) = std::env::current_exe() {
                if let Some(d) = exe.parent() {
                    res_dirs.push(d.to_path_buf());
                }
            }
            engine::init(
                handle.clone(),
                data_dir,
                commands::default_dir(&handle),
                res_dirs,
            );
            // (What Electron's preload knows before the first call: the OS and the CPU, in Node's words.)
            let boot =
                serde_json::json!({ "os": util::node_platform(), "arch": util::node_arch() });
            let mut script: String = format!("window.__KT_BOOT__ = {};\n{}", boot, BRIDGE_JS);
            // (Only with KT_SELFTEST set: the self-test, after the bridge.)
            if selftest::out_path().is_some() {
                let found = engine::get().and_then(|e| e.find_binary());
                if let Some(t) = selftest::script(found) {
                    script.push('\n');
                    script.push_str(&t);
                }
            }
            // (The window of desktop/main.cjs's createWindow: 1100×780 or as it was left, at least 420×560, the
            // system's own frame for now. Made here rather than in tauri.conf.json so it can carry the
            // initialization script.)
            let saved = winstate::load(&handle);
            let mut b = tauri::WebviewWindowBuilder::new(
                app.handle(),
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Kurokawa Tools")
            .inner_size(saved.width, saved.height)
            .min_inner_size(420.0, 560.0)
            .disable_drag_drop_handler()
            .initialization_script(script.as_str());
            if let (Some(x), Some(y)) = (saved.x, saved.y) {
                b = b.position(x, y);
            }
            if saved.maximized {
                b = b.maximized(true);
            }
            b.build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Kurokawa Tools")
        .run(|_app, event| {
            // (Quitting: aria2c's session saved and aria2c stopped.)
            if let tauri::RunEvent::Exit = event {
                if let Some(e) = engine::get() {
                    e.stop();
                }
            }
        });
}
