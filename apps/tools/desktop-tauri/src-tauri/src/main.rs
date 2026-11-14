// Kurokawa Tools — the Tauri shell (stages P1–P3, beside the Electron one in ../../desktop): the same web UI
// (../../dist) in a window made here, with bridge.js run before the page's own scripts on every load so the page finds
// the same `window.kurokawaTools` the Electron preload gives it, and the download engine (aria2c beside the app,
// engine.rs) started in the background (see ../PORTING.md for what is ported so far). What both apps' shells share is
// the shared crate's (shared/shell-rs, `kurokawa_shell`); Tools' engine rules are kt-core's (apps/tools/core/kt-core).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// (Stage P6 part: the app's icon of the user's choosing — the shared crate's appicon.rs.)
mod appicon;
// (Stage P7: archives — the shared crate's archive.rs under Tools' kt:archive* channels.)
mod archives;
mod commands;
mod engine;
// (Stage P3: the recycle bin, free space, fonts, MEGA, the Files page's jobs.)
mod filecmds;
mod rpc;
mod selftest;
// (Stage P3: the window's own title bar, the Reader's — the page draws it, src/ui/winbar.ts.)
mod titlebar;
mod trash;
// (Stage P8: the in-app updater — kt-core's updatelogic.rs decides.)
mod update;
// (Stage P4: torrent streaming and the local stream server — the engine behind one trait (aria2 today; librqbit only
// with `--features rqbit`), the server, its ffmpeg and proxy routes, the self-test's torrent and swarm.)
mod stream_engine;
#[cfg(feature = "rqbit")]
mod stream_rqbit;
mod streamproxy;
mod streamserver;
mod streamtest;
mod torrentmake;

use std::path::PathBuf;

use kurokawa_shell::{util, winstate};
use tauri::Manager;

/// desktop/main.cjs's createWindow: 1100×780 when nothing was saved, at least 420×560.
pub const WINDOW: winstate::Defaults = winstate::Defaults {
    width: 1100.0,
    height: 780.0,
    min_width: 420.0,
    min_height: 560.0,
};

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
            commands::kt_set_doh,
            commands::kt_doh_probe,
            update::kt_install_update,
            update::kt_update_download,
            update::kt_update_install,
            update::kt_selftest_updatedl,
            filecmds::kt_delete_path,
            filecmds::kt_archive_free,
            filecmds::kt_font_dirs,
            filecmds::kt_font_index,
            filecmds::kt_mega_decrypt,
            filecmds::kt_screen_font_add,
            filecmds::kt_screen_font_remove,
            filecmds::kt_files_job,
            filecmds::kt_files_cancel,
            filecmds::kt_files_answer,
            filecmds::kt_home_dir,
            filecmds::kt_files_roots,
            filecmds::kt_files_stat,
            filecmds::kt_files_mkdir,
            filecmds::kt_files_rename,
            appicon::kt_app_icon,
            appicon::kt_selftest_icon,
            archives::kt_archive_list,
            archives::kt_archive_extract,
            archives::kt_archive_test,
            archives::kt_archive_restore,
            archives::kt_archive_existing,
            archives::kt_archive_cancel,
            archives::kt_archive_create,
            archives::kt_selftest_7z,
            archives::kt_selftest_write,
            titlebar::kt_title_bar,
            selftest::kt_selftest_progress,
            selftest::kt_selftest_done,
            // (Stage P4.)
            streamserver::kt_stream_url,
            streamserver::kt_stream_done,
            streamserver::kt_stream_stats,
            streamserver::kt_file_url,
            streamserver::kt_audio_url,
            streamserver::kt_video_url,
            streamserver::kt_proxy_url,
            streamtest::kt_selftest_stream
        ])
        .on_window_event(|window, event| {
            winstate::on_event(window, event);
            titlebar::on_event(window, event);
        })
        .setup(|app| {
            // (Before any request: the app's own requests named as Tools' (shared crate's net.rs), the cookies sites
            // set kept between runs in <app data>/cookies.txt, as Electron's session keeps them.)
            kurokawa_shell::net::configure(format!(
                "Mozilla/5.0 (compatible) KurokawaTools/{} (Tauri)",
                app.handle().package_info().version
            ));
            if let Ok(dir) = app.path().app_data_dir() {
                kurokawa_shell::net::configure_cookies(dir.join("cookies.txt"));
            }
            // The engine: its files in the app's data folder, aria2c looked for in the resource folder (then beside
            // the executable, then on the PATH), started in the background.
            let handle = app.handle().clone();
            // (Stage P7: where the shipped 7-Zip is; Tools' parts of the shared archive code switched on.)
            archives::init(&handle);
            let data_dir = match app.path().app_data_dir() {
                Ok(d) => d,
                Err(_) => std::env::temp_dir().join("kurokawa-tools"),
            };
            // (Stage P4: where the ffmpeg pack is looked for — <app data>/packs/ffmpeg/.)
            streamproxy::init(data_dir.clone());
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
            if kurokawa_shell::selftest::out_path("KT").is_some() {
                let found = engine::get().and_then(|e| e.find_binary());
                if let Some(t) = selftest::script(found) {
                    script.push('\n');
                    script.push_str(&t);
                }
            }
            // (The window of desktop/main.cjs's createWindow: 1100×780 or as it was left, at least 420×560 — with the
            // app's own title bar unless the system's was chosen (titlebar.rs, as the Reader's): no system frame on
            // Windows and Linux, the page draws the bar and its buttons; on a Mac the system's lights over the page,
            // its title hidden. Made here rather than in tauri.conf.json so it can carry the initialization script.)
            let own = titlebar::own_at_start(&handle);
            let saved = winstate::load(&handle, &WINDOW);
            let mut b = tauri::WebviewWindowBuilder::new(
                app.handle(),
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Kurokawa Tools")
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
            // (Stage P6 part: the icon of the user's choosing put on again — window, taskbar, shortcuts, entry.)
            appicon::at_start(&handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Kurokawa Tools")
        .run(|app, event| {
            // (Quitting: aria2c's session saved and aria2c stopped; an update downloaded in the background and not
            // installed is installed quietly — update.rs, as electron-updater's autoInstallOnAppQuit.)
            if let tauri::RunEvent::Exit = event {
                // (Stage P4: the stream server stopped — its port and files let go, its ffmpegs ended.)
                streamserver::stop();
                if let Some(e) = engine::get() {
                    e.stop();
                }
                update::at_exit(app);
            }
        });
}
