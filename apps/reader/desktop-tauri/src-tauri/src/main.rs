// KurokawaReader — the Tauri shell (stages R0–R5 of docs/RUST-PORT-READER.md, beside the Electron one in ../../desktop):
// the same web app (../../dist) in a window made here, with bridge.js run before the page's own scripts on every load
// so the page finds the same `window.kurokawaDesktop` the Electron preload gives it. The commands are thin wrappers
// (commands.rs) over the crate both apps' shells share (shared/shell-rs, `kurokawa_shell`); what is not ported yet is
// a stub in bridge.js (see ../PORTING.md).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod appicon;
mod archive;
mod archives;
mod browser;
mod browserlogic;
mod commands;
mod dlplan;
mod download;
mod enginetest;
// (Stage R6a: the hand-over from the Electron build — handover.rs, its pure parts handoverlogic.rs.)
mod handover;
mod handoverlogic;
mod iconlogic;
mod menu;
mod openargs;
mod openfile;
mod scan;
mod selftest;
mod titlebar;
mod winbits;
// (Stage R6b: the updater, the start's times and colour.)
mod boot;
mod bootlogic;
mod update;
mod updatelogic;

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

/// Only the main window's page may call the app's commands. A window of the in-app browser (stage R4: a site's own
/// page, browser.rs) may call one — kr_browser_deliver, which takes an answer for that window only —, and nothing
/// else: every other command is refused before it runs. (The plugins' commands are refused there by Tauri itself:
/// capabilities/default.json grants them to the main window only.)
fn main_only<F>(handler: F) -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static
where
    F: Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static,
{
    move |invoke: tauri::ipc::Invoke<tauri::Wry>| {
        let label: String = invoke.message.webview().label().to_string();
        let command: String = invoke.message.command().to_string();
        let allowed = label == "main" || (label.starts_with(browser::PREFIX) && command == browser::DELIVER);
        if !allowed {
            invoke.resolver.reject(format!("{} may not be called from this window", command));
            return true;
        }
        handler(invoke)
    }
}

fn main() {
    // (Stage R6b: the start-up times count from here — boot.rs.)
    boot::mark_start();
    net::configure(user_agent());
    let mut builder = tauri::Builder::default();
    // (Single instance — main.cjs's requestSingleInstanceLock: a second launch hands its files and links to this
    // window and ends. Registered first, as its documentation asks. On Linux only with a D-Bus session bus.)
    if openfile::single_instance_possible() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            openfile::second_launch(app, argv, cwd);
        }));
    }
    // (Stage R5: a Mac's menu bar — menu.rs —, its items' commands to the page.)
    #[cfg(target_os = "macos")]
    {
        builder = builder.on_menu_event(|app, event| menu::on_event(app, event.id().as_ref()));
    }
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        // (Stage R3: system notifications — kr_notify, from Rust only, so no JS permission is granted.)
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(main_only(tauri::generate_handler![
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
            commands::kr_download,
            commands::kr_delete_download,
            commands::kr_download_cancel,
            commands::kr_set_doh,
            commands::kr_notify,
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
            enginetest::kr_engine_profile,
            browser::kr_open_webview,
            browser::kr_browser_fetch,
            browser::kr_browser_reset,
            browser::kr_browser_forget,
            browser::kr_browser_deliver,
            browser::kr_selftest_browser,
            archives::kr_archive_list,
            archives::kr_archive_extract,
            archives::kr_archive_test,
            archives::kr_archive_restore,
            archives::kr_archive_free,
            archives::kr_archive_existing,
            archives::kr_archive_cancel,
            archives::kr_archive_create,
            archives::kr_selftest_7z,
            appicon::kr_app_icon,
            appicon::kr_selftest_icon,
            winbits::kr_fullscreen,
            winbits::kr_immersive,
            winbits::kr_set_zoom,
            winbits::kr_progress,
            winbits::kr_copy_image,
            winbits::kr_print_file,
            winbits::kr_selftest_clipimage,
            menu::kr_menu,
            menu::kr_selftest_command,
            // (Stage R6b: the updater — update.rs —, the start's marks — boot.rs.)
            update::kr_install_update,
            update::kr_update_download,
            update::kr_update_install,
            update::kr_selftest_updatedl,
            update::kr_updatetest_note,
            boot::kr_boot_mark,
            boot::kr_boot_times,
            // (Stage R6a: the hand-over — handover.rs.)
            handover::kr_handover_find,
            handover::kr_handover_verify,
            handover::kr_handover_read,
            handover::kr_handover_mark,
            handover::kr_handover_free,
            handover::kr_handover_check_progress,
            handover::kr_handover_check_done
        ]))
        .on_window_event(|window, event| {
            winstate::on_event(window, event);
            titlebar::on_event(window, event);
            // (Stage R4: a browser window gone; the main window closing takes every browser window with it.)
            browser::on_event(window, event);
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // (Stage R3, before any request: the cookies kept from the last run — <app data>/cookies.txt — and the
            // DNS-over-HTTPS resolver chosen in Settings, as main.cjs applies its doh.json at every start.)
            if let Ok(dir) = handle.path().app_data_dir() {
                net::configure_cookies(dir.join("cookies.txt"));
            }
            net::set_doh(&commands::doh_kept(&handle));
            // (Stage R5: where the shipped 7-Zip is looked for — the resource folder, then the program's own.)
            archives::init(&handle);
            // (What Electron's preload knows before the first call: the OS, in Node's words — its `platform`.)
            // (Stage R6b: and what kind of copy this is — the installer's, the portable zip, an AppImage, a .deb, a
            // Mac's .app, a bare program —, which decides which release file updates it: update.rs.)
            let boot = serde_json::json!({ "os": util::node_platform(), "arch": util::node_arch(), "kind": update::kind_name() });
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
            // (Stage R6b, only with KR_UPDATETEST set — CI —: the page updates the app through its own updater.)
            if let Some(t) = update::script(&handle) {
                script.push('\n');
                script.push_str(&t);
            }
            // (Stage R6a: window.kurokawaHandover — the hand-over's reading half, handover.rs —, and, only with
            // KRH_SELFTEST set and no other test, CI's check that an Electron profile's hand-over arrived.)
            script.push('\n');
            script.push_str(handover::BRIDGE_JS);
            if let Some(t) = handover::check_script(&handle) {
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
            // (Stage R6b: the window opens in the interface's own colour — kept from the last run — so nothing flashes
            // white before the page paints; where this build's Tauri has background_color: boot.rs, bootdetect.rs.)
            #[cfg(kr_bg_color)]
            {
                let (r, g, bl) = boot::splash(&handle);
                b = b.background_color(tauri::utils::config::Color(r, g, bl, 255));
            }
            b.build()?;
            // (Stage R5: the icon the user chose, put on the window — and on Windows its shortcuts, on Linux its desktop
            // entry, if an update made them anew — at every start: appicon.rs.)
            appicon::at_start(&handle);
            // (Stage R5: a Mac's menu bar, in English until the page sends its words: menu.rs.)
            #[cfg(target_os = "macos")]
            {
                let _ = menu::set(&handle, &serde_json::Value::Null);
            }
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
        // (Stage R6b: an update downloaded in the background and not installed is installed as the app quits.)
        if let tauri::RunEvent::Exit = &event {
            update::at_exit(handle);
        }
        let _ = (handle, event);
    });
}
