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
// (Stage P6: the computer's side of the downloads — tray, notices, hotkeys, keep-awake, when done, taskbar progress, the
// mini window, launches handed over, a Mac's menu bar; desklogic.rs its rules, std only.)
mod desklogic;
mod desktop;
// (Stage P6: kt:captureUrl and kt:siteWindow — the sign-in window and the site window.)
mod sitewin;
// (Stage P7: the in-app browser, kt:browse — its rules in the shared crate's browserlogic.rs.)
mod browser;
// (Stage P8: the Wi-Fi share, the local API, the antivirus check — lanlogic.rs their rules, std only.)
mod lanlogic;
mod lanshare;
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
// (Stage P5: the video tools — yt-dlp, gallery-dl, ffmpeg and its pack, the transcode stream; kt-core's videotools.rs
// and vidjson.rs decide. vtfake.rs: the self-test's stand-in programs, active only in a self-test run. The transcode
// stream's /video and /audio are routes of P4's stream server — streamproxy.rs —, no server of their own.)
mod vtfake;
mod vtfetch;
mod vtffmpeg;
mod vtjobs;
mod vtools;
mod vtproc;
mod vtselftest;
// (Screen translator — the last 8 channels: screentr.rs its windows, keys, tray, OCR helpers; screencap.rs the
// capture by each system's own facility; the rules in kt-core's screenlogic.rs.)
mod screencap;
mod screentr;
// (Stage P9: the hand-over from the Electron build — its reading half, the engine's files carried before aria2c starts,
// CI's hand-over check (KTH_SELFTEST); kt-core's handoverlogic.rs decides.)
mod handover;
// (Stage P9, after the hand-over: one program runs the downloads both sessions name — the owner file, its heartbeat;
// kt-core's ownerlogic.rs decides.)
mod ownerlock;
// (Start-up timing and the window's colour before the page paints — the Reader's boot.rs with Tools' names; its rules
// the Reader's bootlogic.rs, read in place.)
mod boot;
#[path = "../../../../reader/desktop-tauri/src-tauri/src/bootlogic.rs"]
mod bootlogic;

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
    // (Start-up timing: counted from here.)
    boot::mark_start();
    // (Stage P5, self-test runs only: this program started under the name yt-dlp / gallery-dl / ffmpeg / ffprobe
    // answers as that program and ends here — vtfake.rs; None at once otherwise. First, before any plugin: a stand-in
    // must never reach the single-instance hand-over.)
    if let Some(code) = vtfake::maybe_run() {
        std::process::exit(code);
    }
    let mut builder = tauri::Builder::default();
    // (Stage P6: a second launch hands its magnets, links and .torrent files to this window and ends — main.cjs's
    // requestSingleInstanceLock / second-instance. Registered first, as the plugin asks; on Linux only with a D-Bus
    // session bus, else each launch is its own window.)
    if desktop::single_instance_possible() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            desktop::second_launch(app, argv, cwd);
        }));
    }
    // (Stage P6: the clipboard hotkeys — where build.rs found the plugin's API, and on Linux with an X display.)
    #[cfg(kt_shortcuts)]
    {
        if desktop::shortcuts_possible() {
            builder = builder.plugin(desktop::shortcuts_plugin());
        }
    }
    builder
        // (Stage P6: notices when a download finishes — from Rust only, no JS permission granted.)
        .plugin(tauri_plugin_notification::init())
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
            desktop::kt_desktop_prefs,
            desktop::kt_mini,
            desktop::kt_open_take,
            desktop::kt_register_magnet,
            desktop::kt_selftest_desk,
            sitewin::kt_capture_url,
            sitewin::kt_site_window,
            sitewin::kt_selftest_site,
            browser::kt_browse,
            browser::kt_selftest_browse,
            lanshare::kt_share_wifi,
            lanshare::kt_share_wifi_stop,
            lanshare::kt_share_wifi_status,
            lanshare::kt_local_api,
            lanshare::kt_av_scan,
            lanshare::kt_av_available,
            lanshare::kt_selftest_lan,
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
            streamtest::kt_selftest_stream,
            // (Stage P5: the video tools.)
            vtools::kt_video_info,
            vtools::kt_video_js_runtime,
            vtools::kt_video_ready,
            vtools::kt_video_version,
            vtools::kt_video_update,
            vtools::kt_video_rollback,
            vtools::kt_video_binary,
            vtools::kt_is_video_host,
            vtools::kt_gallery_list,
            vtools::kt_gallery_ready,
            vtffmpeg::kt_ffmpeg_available,
            vtffmpeg::kt_ffmpeg,
            vtffmpeg::kt_ffmpeg_cancel,
            vtffmpeg::kt_ffprobe,
            vtffmpeg::kt_pack_status,
            vtffmpeg::kt_pack_install,
            vtffmpeg::kt_pack_cancel,
            vtffmpeg::kt_pack_remove,
            vtselftest::kt_selftest_vt,
            // (Screen translator.)
            screentr::kt_screen_config,
            screentr::kt_screen_status,
            screentr::kt_screen_action,
            screentr::kt_screen_job,
            screentr::kt_screen_region,
            screentr::kt_screen_close,
            screentr::kt_screen_ocr_langs,
            screentr::kt_screen_caption,
            screentr::kt_selftest_screen,
            // (Stage P9: the hand-over.)
            handover::kt_handover_find,
            handover::kt_handover_verify,
            handover::kt_handover_read,
            handover::kt_handover_mark,
            handover::kt_handover_free,
            handover::kt_handover_open_old,
            handover::kt_handover_check_progress,
            handover::kt_handover_check_done,
            ownerlock::kt_downloads_owner,
            ownerlock::kt_downloads_take,
            boot::kt_boot_mark,
            boot::kt_boot_times
        ])
        .on_window_event(|window, event| {
            winstate::on_event(window, event);
            titlebar::on_event(window, event);
            desktop::on_event(window, event);
            sitewin::on_event(window, event);
            browser::on_event(window, event);
            // (Screen translator: close to the tray while it is on; its windows' focus and ends.)
            screentr::on_event(window, event);
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
            // (Stage P9: before the video tools and the engine read their files — the downloads an Electron build handed
            // over put in place, once, when this build has none of its own; handover.rs engine_prestart.)
            handover::engine_prestart(&handle);
            // (Stage P9: the handed-over downloads' owner taken — or, another live owner holding them, their entries paused
            // in this build's session before aria2 reads it; ownerlock.rs.)
            ownerlock::before_engine(&handle);
            // (Stage P7: where the shipped 7-Zip is; Tools' parts of the shared archive code switched on.)
            archives::init(&handle);
            // (Stage P5: the video tools' folders and jobs; yt-dlp brought up to date now and then, as main.cjs does.)
            vtools::init(&handle);
            vtools::schedule_updates();
            let data_dir = match app.path().app_data_dir() {
                Ok(d) => d,
                Err(_) => std::env::temp_dir().join("kurokawa-tools"),
            };
            // (Stage P4's ffmpeg routes find ffmpeg as the video tools do — vtffmpeg::binary(), set up by vtools::init.)
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
            // (Stage P9: window.kurokawaHandover — the hand-over's reading half — after the bridge.)
            script.push('\n');
            script.push_str(handover::BRIDGE_JS);
            // (Stage P6: the mini window runs the page without the self-test.)
            let _ = desktop::WEB_SCRIPT.set(script.clone());
            // (Stage P9, only with KTH_SELFTEST set: CI's hand-over check, after the bridges.)
            if let Some(t) = handover::check_script(&handle) {
                script.push('\n');
                script.push_str(&t);
            }
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
            // (The window opens in the interface's own colour — kept from the last run — so nothing flashes white before
            // the page paints; where this build's Tauri has background_color: boot.rs, the Reader's bootdetect.rs.)
            #[cfg(kr_bg_color)]
            {
                let (r, g, bl) = boot::splash(&handle);
                b = b.background_color(tauri::utils::config::Color(r, g, bl, 255));
            }
            b.build()?;
            // (Stage P6 part: the icon of the user's choosing put on again — window, taskbar, shortcuts, entry.)
            appicon::at_start(&handle);
            // (Stage P6: magnets, links and .torrent files this launch was given, kept for the page.)
            desktop::at_start(&handle);
            // (Screen translator: its settings read, its keys / tray / start-with-the-computer applied; a --hidden
            // start left in the tray when chosen.)
            screentr::init(&handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Kurokawa Tools")
        .run(|app, event| {
            // (Stage P6: a Mac hands magnets, kurokawatools: links and .torrent files over as Apple Events.)
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = &event {
                desktop::opened(app, urls.iter().map(|u| u.to_string()).collect());
            }
            // (Quitting: aria2c's session saved and aria2c stopped; an update downloaded in the background and not
            // installed is installed quietly — update.rs, as electron-updater's autoInstallOnAppQuit.)
            if let tauri::RunEvent::Exit = event {
                // (Stage P4: the stream server stopped — its port and files let go, its ffmpegs ended.)
                streamserver::stop();
                if let Some(e) = engine::get() {
                    e.stop();
                }
                // (Stage P9: the handed-over downloads released, while this build owns them.)
                ownerlock::at_exit();
                // (Stage P5: running video jobs ended with their trees.)
                vtjobs::stop_all();
                // (Screen translator: «auto» and its OCR helpers ended.)
                screentr::at_exit();
                update::at_exit(app);
            }
        });
}
