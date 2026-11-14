// Which of Tauri's and its plugins' newer functions this build resolved has, found by reading their own source — the
// versions in Cargo.lock, their files in Cargo's registry — so the code that uses one is compiled only where it exists,
// with the signature written for it; anything not found leaves that part out (the build's log says which: «KT build:
// …»). The Reader's way (apps/reader/desktop-tauri/src-tauri/apidetect.rs, whose helpers these are, unchanged), with
// Tools' own cfg names. Used by build.rs; std only, checked alone with `rustc --edition 2021 --test apidetect.rs`.
use std::path::{Path, PathBuf};

/// A function found, its cfg name (`kt_<name>`), and what it gives (for the build's log).
pub struct Found {
    pub cfg: &'static str,
    pub what: &'static str,
    pub on: bool,
}

/// The cfg names this can set (for `rustc-check-cfg`).
pub const CFGS: [&str; 4] = ["kt_reveal", "kt_set_icon", "kt_default_icon", "kt_progress"];
/// (Stage P6, desktop.rs) the cfg names of the tray's left click, the dock's count and the global shortcuts.
pub const CFGS_P6: [&str; 5] = ["kt_tray_left", "kt_tray_left_old", "kt_badge", "kt_all_spaces", "kt_shortcuts"];

/// The version of `name` in a Cargo.lock's text.
pub fn locked_version(lock: &str, name: &str) -> Option<String> {
    let want = format!("name = \"{}\"", name);
    let mut lines = lock.lines();
    while let Some(l) = lines.next() {
        if l.trim() == want {
            let v = lines.next()?.trim();
            let v = v.strip_prefix("version = \"")?.strip_suffix('"')?;
            return Some(v.to_string());
        }
    }
    None
}

/// Rust source without its comments' text (from «//» to the line's end), without any whitespace and without the
/// comma that may end a list: what is left can be searched for a signature however it was laid out.
pub fn squeeze(src: &str) -> String {
    let mut out = String::with_capacity(src.len() / 2);
    for line in src.lines() {
        let code = match line.find("//") {
            Some(i) => &line[..i],
            None => line,
        };
        out.extend(code.chars().filter(|c| !c.is_whitespace()));
    }
    // (A list laid out one item a line ends with a comma: «Url,)» is «Url)».)
    out.replace(",)", ")").replace(",}", "}").replace(",>", ">")
}

/// Every .rs file under `dir`, squeezed and joined.
pub fn squeeze_tree(dir: &Path) -> String {
    let mut out = String::new();
    let mut stack: Vec<PathBuf> = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let rd = match std::fs::read_dir(&d) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().map(|x| x == "rs").unwrap_or(false) {
                if let Ok(t) = std::fs::read_to_string(&p) {
                    out.push_str(&squeeze(&t));
                    out.push('\n');
                }
            }
        }
    }
    out
}

/// Where Cargo keeps a crate's source: <cargo home>/registry/src/<index>/<name>-<version>/src.
pub fn crate_src(cargo_home: &Path, name: &str, version: &str) -> Option<PathBuf> {
    let reg = cargo_home.join("registry").join("src");
    for e in std::fs::read_dir(&reg).ok()?.flatten() {
        let p = e.path().join(format!("{}-{}", name, version)).join("src");
        if p.is_dir() {
            return Some(p);
        }
    }
    None
}

/// Cargo's home: $CARGO_HOME, else ~/.cargo.
pub fn cargo_home() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("CARGO_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(h));
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".cargo"))
}

/// What the squeezed source of tauri-plugin-opener offers: «show in folder» with the item chosen (kt:open −1).
pub fn detect_opener(src: &str) -> Vec<Found> {
    let reveal = src.contains(&squeeze("pub fn reveal_item_in_dir<P: AsRef<Path>>(&self, p: P)"))
        || src.contains(&squeeze("pub fn reveal_item_in_dir<P: AsRef<Path>>(&self, path: P)"));
    vec![Found { cfg: "kt_reveal", what: "an item shown in its folder (Opener::reveal_item_in_dir)", on: reveal }]
}

/// What the squeezed source of the tauri crate offers (the window's icon — appicon —, its taskbar progress). A
/// method counts only when it is there twice: on Window and on WebviewWindow.
pub fn detect_tauri(src: &str) -> Vec<Found> {
    let twice = |s: &str| src.matches(&squeeze(s)).count() >= 2;
    let has = |s: &str| src.contains(&squeeze(s));
    let set_icon = twice("pub fn set_icon(&self, icon: Image<'_>) -> crate::Result<()>");
    let default_icon = has("pub fn default_window_icon(&self) -> Option<&Image<'_>>") && has("pub fn to_owned(self) -> Image<'static>");
    let progress = twice("pub fn set_progress_bar(&self, progress_state:")
        && src
            .find(&squeeze("pub struct ProgressBarState {"))
            .map(|i| {
                let mut a = i.saturating_sub(160);
                while !src.is_char_boundary(a) {
                    a -= 1;
                }
                src[a..i].contains("Deserialize")
            })
            .unwrap_or(false);
    vec![
        Found { cfg: "kt_set_icon", what: "the window's icon set (set_icon)", on: set_icon },
        Found { cfg: "kt_default_icon", what: "the default icon given back (default_window_icon)", on: default_icon },
        Found { cfg: "kt_progress", what: "taskbar progress (set_progress_bar)", on: progress },
    ]
}

/// (Stage P6) What the squeezed source of the tauri crate offers desktop.rs: the tray's left click kept from opening
/// its menu (show_menu_on_left_click, before it menu_on_left_click), the dock's count (set_badge_count, on Window and
/// WebviewWindow).
pub fn detect_tauri_p6(src: &str) -> Vec<Found> {
    let has = |s: &str| src.contains(&squeeze(s));
    let twice = |s: &str| src.matches(&squeeze(s)).count() >= 2;
    vec![
        Found { cfg: "kt_tray_left", what: "the tray's left click (show_menu_on_left_click)", on: has("pub fn show_menu_on_left_click(mut self, enable: bool) -> Self") },
        Found { cfg: "kt_tray_left_old", what: "the tray's left click, older name (menu_on_left_click)", on: has("pub fn menu_on_left_click(mut self, enable: bool) -> Self") },
        Found { cfg: "kt_badge", what: "the dock's count (set_badge_count)", on: twice("pub fn set_badge_count(&self, count: Option<i64>) -> crate::Result<()>") },
        // (WindowBuilder's and WebviewWindowBuilder's: the mini window on every desktop.)
        Found { cfg: "kt_all_spaces", what: "a window on every desktop (visible_on_all_workspaces)", on: twice("pub fn visible_on_all_workspaces(mut self, visible_on_all_workspaces: bool) -> Self") },
    ]
}

/// (Stage P7, browser.rs) the cfg names of the browser's cookie and download calls.
pub const CFGS_P7: [&str; 3] = ["kt_cookie_read", "kt_cookie_all", "kt_download_api"];

/// (Stage P7) What the squeezed tauri source offers the in-app browser — the Reader's detection (its apidetect.rs),
/// under Tools' names: a site's cookies read, every cookie read, downloads caught (each on Webview and WebviewWindow).
pub fn detect_tauri_p7(src: &str) -> Vec<Found> {
    let twice = |s: &str| src.matches(&squeeze(s)).count() >= 2;
    let has = |s: &str| src.contains(&squeeze(s));
    let download = twice("pub fn on_download<F: Fn(Webview<R>, DownloadEvent<'_>) -> bool + Send + Sync + 'static>(")
        && has("pub enum DownloadEvent<'a> {")
        && has("Requested { url: Url, destination: &'a mut PathBuf");
    vec![
        Found { cfg: "kt_cookie_read", what: "the browser's cookies of a site read (cookies_for_url)", on: twice("pub fn cookies_for_url(&self, url: Url) -> crate::Result<Vec<Cookie<'static>>>") },
        Found { cfg: "kt_cookie_all", what: "all the browser's cookies read (cookies)", on: twice("pub fn cookies(&self) -> crate::Result<Vec<Cookie<'static>>>") },
        Found { cfg: "kt_download_api", what: "downloads in the browser caught (on_download)", on: download },
    ]
}

/// (Stage P6) What the squeezed source of tauri-plugin-global-shortcut offers: the handler with the shortcut and its
/// event, register by text, unregister_all — all three, or the clipboard hotkeys are left out.
pub fn detect_shortcut(src: &str) -> Vec<Found> {
    let has = |s: &str| src.contains(&squeeze(s));
    let on = has("pub fn with_handler<F: Fn(&AppHandle<R>, &Shortcut, ShortcutEvent)")
        && has("pub fn register<S>(&self, shortcut: S) -> Result<()>")
        && has("pub fn unregister_all(&self) -> Result<()>")
        && has("ShortcutEvent");
    vec![Found { cfg: "kt_shortcuts", what: "global shortcuts (with_handler, register, unregister_all)", on }]
}

/* ---------- screen translator (screentr.rs) ---------- */

/// The cfg names of the screen translator's calls: the mouse's place, a click-through window, a window that takes no
/// focus, an event to one window.
pub const CFGS_SCR: [&str; 4] = ["kt_cursor", "kt_ignore_cursor", "kt_focusable", "kt_emit_to"];

/// What the squeezed tauri source offers the screen translator (each method on Window and WebviewWindow, the builder's
/// on WindowBuilder and WebviewWindowBuilder): cursor_position; set_ignore_cursor_events (the caption's clicks go
/// through it); focusable(false) (the caption never takes the focus from the game under it); Emitter::emit_to (the
/// caption's text to its window only — without it, to every window, where only the caption listens).
pub fn detect_tauri_scr(src: &str) -> Vec<Found> {
    let twice = |s: &str| src.matches(&squeeze(s)).count() >= 2;
    let has = |s: &str| src.contains(&squeeze(s));
    vec![
        Found { cfg: "kt_cursor", what: "the mouse's place (cursor_position)", on: twice("pub fn cursor_position(&self) -> crate::Result<PhysicalPosition<f64>>") },
        Found { cfg: "kt_ignore_cursor", what: "a click-through window (set_ignore_cursor_events)", on: twice("pub fn set_ignore_cursor_events(&self, ignore: bool) -> crate::Result<()>") },
        Found { cfg: "kt_focusable", what: "a window that takes no focus (focusable)", on: twice("pub fn focusable(mut self, focusable: bool) -> Self") },
        Found { cfg: "kt_emit_to", what: "an event to one window (emit_to)", on: has("fn emit_to<I, S>(&self, target: I, event: &str, payload: S)") && has("I: Into<EventTarget>") && has("impl<T: AsRef<str>> From<T> for EventTarget {") },
    ]
}

/* ---------- the hybrid closures (notifier.rs, mediawatch.rs, cookiecarry.rs) ---------- */

/// The cfg names of the hybrid's native calls: a Linux notice's click waited for (notify-rust), the web view's own
/// object reached (with_webview; WebKitGTK's on Linux), WebKitGTK's responses watched, a cookie put into the browser's
/// store (set_cookie), a cookie read from its Set-Cookie line (the cookie crate's FromStr).
pub const CFGS_HYB: [&str; 5] = ["kt_notify_wait", "kt_webview_gtk", "kt_wk_resources", "kt_cookie_set", "kt_cookie_fromstr"];

/// Every version of `name` in a Cargo.lock's text (a crate the shell names itself must be the one its users resolve:
/// one version, or its types are not theirs).
pub fn locked_versions(lock: &str, name: &str) -> Vec<String> {
    let want = format!("name = \"{}\"", name);
    let mut out: Vec<String> = Vec::new();
    let mut lines = lock.lines();
    while let Some(l) = lines.next() {
        if l.trim() == want {
            if let Some(v) = lines.next().and_then(|v| v.trim().strip_prefix("version = \"").and_then(|v| v.strip_suffix('"')).map(String::from)) {
                out.push(v);
            }
        }
    }
    out
}

/// Two versions compared by their numbers («0.18.1» after «0.16.2»; a pre-release tag ignored).
pub fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let n = |v: &str| v.split(['-', '+']).next().unwrap_or("").split('.').map(|x| x.parse::<u64>().unwrap_or(0)).collect::<Vec<u64>>();
    n(a).cmp(&n(b))
}

/// What the squeezed source of notify-rust offers on Linux: a notice with an action, shown, and its answer waited for.
pub fn detect_notify(src: &str) -> Vec<Found> {
    let has = |s: &str| src.contains(&squeeze(s));
    let on = has("pub fn action(&mut self, identifier: &str, label: &str) -> &mut Notification")
        && has("pub fn summary(&mut self, summary: &str) -> &mut Notification")
        && has("pub fn body(&mut self, body: &str) -> &mut Notification")
        && has("pub fn appname(&mut self, appname: &str) -> &mut Notification")
        && (has("pub fn show(&self) -> Result<NotificationHandle>") || has("pub fn show(&self) -> Result<xdg::NotificationHandle>"))
        && has("pub fn wait_for_action<F>(self")
        && has("FnOnce(&str)");
    vec![Found { cfg: "kt_notify_wait", what: "a Linux notice's click (notify-rust wait_for_action)", on }]
}

/// What the squeezed tauri source offers the hybrid: the web view's own object (with_webview, on Webview and
/// WebviewWindow; WebKitGTK's WebView on Linux), a cookie put into a web view's store (set_cookie, on both).
pub fn detect_tauri_hyb(src: &str) -> Vec<Found> {
    let has = |s: &str| src.contains(&squeeze(s));
    let twice = |s: &str| src.matches(&squeeze(s)).count() >= 2;
    let with = with_webview_count(src) >= 2;
    let set = twice("pub fn set_cookie(&self, cookie: Cookie<'_>) -> crate::Result<()>") || twice("pub fn set_cookie(&self, cookie: Cookie<'static>) -> crate::Result<()>");
    vec![
        Found { cfg: "kt_webview_gtk", what: "the web view's own object (with_webview; WebKitGTK's inner)", on: with && has("pub fn inner(&self) -> webkit2gtk::WebView") },
        Found { cfg: "kt_cookie_set", what: "a cookie put into the browser's store (set_cookie)", on: set },
    ]
}

/// How many times the squeezed tauri source declares `with_webview` (on Webview and on WebviewWindow) — written with
/// `PlatformWebview` or with its path `crate::webview::PlatformWebview` (WebviewWindow's spelling; CI run 43599725459
/// found «no» on every system for the web view's own object with only the first one counted).
pub fn with_webview_count(src: &str) -> usize {
    ["pub fn with_webview<F: FnOnce(PlatformWebview) + Send + 'static>(", "pub fn with_webview<F: FnOnce(crate::webview::PlatformWebview) + Send + 'static>(", "pub fn with_webview<F: FnOnce(webview::PlatformWebview) + Send + 'static>("]
        .iter()
        .map(|s| src.matches(&squeeze(s)).count())
        .sum()
}

/// (The build's log, when the web view's own object is not found) what was: how often `with_webview` is declared, how
/// often under any spelling, and whether `inner()` gives WebKitGTK's WebView — so the next run says why.
pub fn webview_diag(src: &str) -> String {
    let any = src.matches("pubfnwith_webview<").count();
    let inner = src.contains(&squeeze("pub fn inner(&self) -> webkit2gtk::WebView"));
    let inner_any = src.matches("pubfninner(&self)->").count();
    format!("with_webview declared {} times as written for ({} under any spelling); inner() → webkit2gtk::WebView {}; inner() of any kind {} times", with_webview_count(src), any, if inner { "yes" } else { "no" }, inner_any)
}

/* ---------- the original system (PORTING.md «The original Rust system — piece by piece») ---------- */

/// The cfg names the original system's checks can set: webview2-com and windows each resolved once (the versions wry
/// and this shell name — Cargo.toml's `wv2` — are then the same crates, so wry's WebView2 objects are ours).
pub const CFGS_ORIG: [&str; 1] = ["kt_wv2_single"];

/// Whether `name` is resolved exactly once in the lock.
pub fn single_version(lock: &str, name: &str) -> bool {
    locked_versions(lock, name).len() == 1
}

/// The «KT build (original): …» line: each native path, whether this build has it, and why not.
pub fn original_line(items: &[(&str, bool, &str)]) -> String {
    items
        .iter()
        .map(|(what, on, why)| if *on { format!("yes {}", what) } else if why.is_empty() { format!("no {}", what) } else { format!("no {} ({})", what, why) })
        .collect::<Vec<_>>()
        .join("; ")
}

/// What the squeezed source of webkit2gtk offers: each resource a page loads, its end, its response's MIME type.
pub fn detect_webkit(src: &str) -> Vec<Found> {
    let has = |s: &str| src.contains(&squeeze(s));
    let on = has("fn connect_resource_load_started<F: Fn(&Self, &WebResource, &URIRequest) + 'static>(")
        && has("fn connect_finished<F: Fn(&Self) + 'static>(")
        && has("fn response(&self) -> Option<URIResponse>")
        && has("fn mime_type(&self) -> Option<glib::GString>")
        && has("fn uri(&self) -> Option<glib::GString>")
        // (Each as a trait the code imports — a final class's methods would be its own, and the import would fail.)
        && has("pub trait WebViewExt")
        && has("pub trait WebResourceExt")
        && has("pub trait URIResponseExt");
    vec![Found { cfg: "kt_wk_resources", what: "WebKitGTK's responses watched (resource-load-started, mime_type)", on }]
}

/// What the squeezed source of the cookie crate offers: a Cookie read from a Set-Cookie line by `str::parse`.
pub fn detect_cookie(src: &str) -> Vec<Found> {
    let has = |s: &str| src.contains(&squeeze(s));
    let on = has("impl FromStr for Cookie<'static> {") || has("impl<'c> FromStr for Cookie<'c> {");
    vec![Found { cfg: "kt_cookie_fromstr", what: "a cookie read from its Set-Cookie line (FromStr)", on }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock() {
        let l = "[[package]]\nname = \"tauri-plugin-opener\"\nversion = \"2.4.0\"\n\n[[package]]\nname = \"tauri\"\nversion = \"2.9.3\"\nsource = \"x\"\n";
        assert_eq!(locked_version(l, "tauri").as_deref(), Some("2.9.3"));
        assert_eq!(locked_version(l, "tauri-plugin-opener").as_deref(), Some("2.4.0"));
        assert_eq!(locked_version(l, "wry"), None);
    }

    #[test]
    fn opener() {
        let src = squeeze("impl<R: Runtime> Opener<R> {\n    /// Reveal a path the system's file explorer.\n    pub fn reveal_item_in_dir<P: AsRef<Path>>(\n        &self,\n        p: P,\n    ) -> Result<()> {\n");
        assert!(detect_opener(&src)[0].on);
        let free_only = squeeze("pub fn reveal_item_in_dir<P: AsRef<Path>>(path: P) -> crate::Result<()> {");
        assert!(!detect_opener(&free_only)[0].on);
        assert!(!detect_opener("").iter().any(|f| f.on));
    }

    #[test]
    fn tauri_window() {
        let one = "pub fn set_icon(&self, icon: Image<'_>) -> crate::Result<()> {\n  pub fn set_progress_bar(\n    &self,\n    progress_state: crate::window::ProgressBarState,\n  ) -> crate::Result<()> {\n";
        let src = squeeze(&format!("{}{}pub fn default_window_icon(&self) -> Option<&Image<'_>> {{\npub fn to_owned(self) -> Image<'static> {{\n#[derive(Debug, Deserialize)]\npub struct ProgressBarState {{\n", one, one));
        let f = detect_tauri(&src);
        assert!(f.iter().all(|x| x.on));
        assert!(detect_tauri(&squeeze(one)).iter().all(|x| !x.on));
        let mut all: Vec<&str> = detect_opener("").iter().map(|x| x.cfg).collect();
        all.extend(f.iter().map(|x| x.cfg));
        assert_eq!(all, CFGS.to_vec());
    }

    #[test]
    fn p7() {
        let one = "pub fn cookies_for_url(\n &self,\n url: Url,\n ) -> crate::Result<Vec<Cookie<'static>>> {\npub fn on_download<F: Fn(Webview<R>, DownloadEvent<'_>) -> bool + Send + Sync + 'static>(\n";
        let src = squeeze(&format!("{}{}pub enum DownloadEvent<'a> {{\n Requested {{ url: Url, destination: &'a mut PathBuf }},", one, one));
        let f = detect_tauri_p7(&src);
        assert!(f[0].on && !f[1].on && f[2].on);
        assert!(detect_tauri_p7(&squeeze(one)).iter().all(|x| !x.on));
        assert_eq!(detect_tauri_p7("").iter().map(|x| x.cfg).collect::<Vec<_>>(), CFGS_P7.to_vec());
    }

    #[test]
    fn p6() {
        let t = squeeze("pub fn show_menu_on_left_click(mut self, enable: bool) -> Self {\n pub fn set_badge_count(\n &self,\n count: Option<i64>,\n ) -> crate::Result<()> {\npub fn set_badge_count(&self, count: Option<i64>) -> crate::Result<()> {");
        let f = detect_tauri_p6(&t);
        assert!(f[0].on && !f[1].on && f[2].on && !f[3].on);
        let vw = squeeze("pub fn visible_on_all_workspaces(\n mut self,\n visible_on_all_workspaces: bool,\n ) -> Self {");
        assert!(detect_tauri_p6(&format!("{}{}", vw, vw))[3].on && !detect_tauri_p6(&vw)[3].on);
        let old = detect_tauri_p6(&squeeze("pub fn menu_on_left_click(mut self, enable: bool) -> Self {"));
        assert!(!old[0].on && old[1].on && !old[2].on);
        let g = squeeze("pub fn with_handler<F: Fn(&AppHandle<R>, &Shortcut, ShortcutEvent) + Send + Sync + 'static>(\n mut self, handler: F) -> Self {\npub fn register<S>(&self, shortcut: S) -> Result<()>\nwhere\npub fn unregister_all(&self) -> Result<()> {");
        assert!(detect_shortcut(&g)[0].on);
        assert!(!detect_shortcut(&squeeze("pub fn register<S>(&self, shortcut: S) -> Result<()>"))[0].on);
        let mut all: Vec<&str> = detect_tauri_p6("").iter().map(|x| x.cfg).collect();
        all.extend(detect_shortcut("").iter().map(|x| x.cfg));
        assert_eq!(all, CFGS_P6.to_vec());
    }

    #[test]
    fn screen() {
        let one = "pub fn cursor_position(&self) -> crate::Result<PhysicalPosition<f64>> {\n pub fn set_ignore_cursor_events(\n &self,\n ignore: bool,\n ) -> crate::Result<()> {\n pub fn focusable(mut self, focusable: bool) -> Self {\n";
        let src = squeeze(&format!("{}{}fn emit_to<I, S>(&self, target: I, event: &str, payload: S) -> Result<()>\n where\n I: Into<EventTarget>,\nimpl<T: AsRef<str>> From<T> for EventTarget {{\n", one, one));
        assert!(detect_tauri_scr(&src).iter().all(|f| f.on));
        let half = squeeze(one);
        let f = detect_tauri_scr(&half);
        assert!(f.iter().all(|f| !f.on));
        assert_eq!(f.iter().map(|x| x.cfg).collect::<Vec<_>>(), CFGS_SCR.to_vec());
    }

    #[test]
    fn tree() {
        let d = std::env::temp_dir().join(format!("kt-apidetect-{}", std::process::id()));
        let reg = d.join("registry").join("src").join("index.crates.io-abc").join("tauri-plugin-opener-2.4.0").join("src");
        std::fs::create_dir_all(&reg).unwrap();
        std::fs::write(reg.join("lib.rs"), "pub fn reveal_item_in_dir<P: AsRef<Path>>(&self, p: P) -> Result<()> {}").unwrap();
        let src = crate_src(&d, "tauri-plugin-opener", "2.4.0").unwrap();
        assert!(crate_src(&d, "tauri-plugin-opener", "2.0.0").is_none());
        assert!(detect_opener(&squeeze_tree(&src))[0].on);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn hybrid() {
        let l = "[[package]]\nname = \"cookie\"\nversion = \"0.16.2\"\n\n[[package]]\nname = \"cookie\"\nversion = \"0.18.1\"\n";
        assert_eq!(locked_versions(l, "cookie"), vec!["0.16.2".to_string(), "0.18.1".to_string()]);
        assert!(locked_versions(l, "wry").is_empty());
        assert_eq!(version_cmp("0.18.1", "0.16.2"), std::cmp::Ordering::Greater);
        assert_eq!(version_cmp("2.0.10", "2.0.9"), std::cmp::Ordering::Greater);
        assert_eq!(version_cmp("1.0.0-rc.1", "1.0.0"), std::cmp::Ordering::Equal);
        let n = squeeze("pub fn appname(&mut self, appname: &str) -> &mut Notification {\npub fn summary(&mut self, summary: &str) -> &mut Notification {\npub fn body(&mut self, body: &str) -> &mut Notification {\npub fn action(&mut self, identifier: &str, label: &str) -> &mut Notification {\npub fn show(&self) -> Result<NotificationHandle> {\npub fn wait_for_action<F>(self, invocation_closure: F)\nwhere\n F: FnOnce(&str),\n{");
        assert!(detect_notify(&n)[0].on);
        assert!(!detect_notify(&squeeze("pub fn show(&self) -> Result<NotificationHandle> {"))[0].on);
        let w = "pub fn with_webview<F: FnOnce(PlatformWebview) + Send + 'static>(\n &self,\n f: F,\n ) -> crate::Result<()> {\npub fn set_cookie(&self, cookie: Cookie<'_>) -> crate::Result<()> {\n";
        let t = detect_tauri_hyb(&squeeze(&format!("{}{}pub fn inner(&self) -> webkit2gtk::WebView {{", w, w)));
        assert!(t[0].on && t[1].on);
        let t1 = detect_tauri_hyb(&squeeze(w));
        assert!(!t1[0].on && !t1[1].on);
        // (WebviewWindow's spelling counts too.)
        let w2 = "pub fn with_webview<F: FnOnce(crate::webview::PlatformWebview) + Send + 'static>(\n &self,\n f: F,\n ) -> crate::Result<()> {\n";
        let both = squeeze(&format!("{}{}pub fn inner(&self) -> webkit2gtk::WebView {{", w, w2));
        assert!(detect_tauri_hyb(&both)[0].on);
        assert_eq!(with_webview_count(&both), 2);
        assert!(webview_diag(&both).contains("declared 2 times") && webview_diag(&both).contains("WebView yes"));
        assert!(webview_diag("").contains("declared 0 times"));
        let k = squeeze("fn connect_resource_load_started<F: Fn(&Self, &WebResource, &URIRequest) + 'static>(\n &self, f: F) -> SignalHandlerId;\nfn connect_finished<F: Fn(&Self) + 'static>(&self, f: F) -> SignalHandlerId;\nfn response(&self) -> Option<URIResponse>;\nfn mime_type(&self) -> Option<glib::GString>;\nfn uri(&self) -> Option<glib::GString>;");
        assert!(!detect_webkit(&k)[0].on, "the traits not found");
        let k = format!("{}{}", k, squeeze("pub trait WebViewExt: 'static {\npub trait WebResourceExt: 'static {\npub trait URIResponseExt: 'static {"));
        assert!(detect_webkit(&k)[0].on && !detect_webkit("")[0].on);
        assert!(detect_cookie(&squeeze("impl FromStr for Cookie<'static> {\n type Err = ParseError;"))[0].on);
        assert!(!detect_cookie("")[0].on);
        let mut all: Vec<&str> = detect_notify("").iter().map(|x| x.cfg).collect();
        all.extend(detect_tauri_hyb("").iter().map(|x| x.cfg));
        all.extend(detect_webkit("").iter().map(|x| x.cfg));
        all.extend(detect_cookie("").iter().map(|x| x.cfg));
        let l2 = "[[package]]\nname = \"windows\"\nversion = \"0.62.2\"\n\n[[package]]\nname = \"webview2-com\"\nversion = \"0.39.1\"\n\n[[package]]\nname = \"windows\"\nversion = \"0.61.3\"\n";
        assert!(single_version(l2, "webview2-com") && !single_version(l2, "windows") && !single_version(l2, "wry"));
        assert_eq!(original_line(&[("a", true, ""), ("b", false, "off"), ("c", false, "")]), "yes a; no b (off); no c");
        let mut want = CFGS_HYB.to_vec();
        want.sort();
        all.sort();
        assert_eq!(all, want);
    }
}
