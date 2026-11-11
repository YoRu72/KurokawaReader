// Kurokawa Tools — the Tauri shell (stage 1, beside the Electron one in ../../desktop): the same web UI (../../dist)
// in a window made here, with bridge.js run before the page's own scripts on every load so the page finds the
// same `window.kurokawaTools` the Electron preload gives it (see ../PORTING.md for what is ported so far).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod files;
mod hash;
mod net;
mod util;

/// The page's bridge (../../bridge.js), injected as the window's initialization script.
const BRIDGE_JS: &str = include_str!("../../bridge.js");

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::kt_state,
            commands::kt_list,
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
            commands::kt_check_update
        ])
        .setup(|app| {
            // (What Electron's preload knows before the first call: the OS and the CPU, in Node's words.)
            let boot =
                serde_json::json!({ "os": util::node_platform(), "arch": util::node_arch() });
            let script: String = format!("window.__KT_BOOT__ = {};\n{}", boot, BRIDGE_JS);
            // (The window of desktop/main.cjs's createWindow: 1100×780, at least 420×560, the system's own frame for
            // now. Made here rather than in tauri.conf.json so it can carry the initialization script.)
            tauri::WebviewWindowBuilder::new(
                app.handle(),
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Kurokawa Tools")
            .inner_size(1100.0, 780.0)
            .min_inner_size(420.0, 560.0)
            .disable_drag_drop_handler()
            .initialization_script(script.as_str())
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Kurokawa Tools");
}
