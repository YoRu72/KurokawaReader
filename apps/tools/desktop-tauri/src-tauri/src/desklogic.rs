// The computer's side of the downloads (stage P6), the rules that need no window: desktop/main.cjs's onDesktopTasks
// (the taskbar's progress, the computer kept awake while something downloads, what to do when all are done, the tray's
// tooltip, which finished downloads get a notice), its takeArg (what a launch hands the app: magnets, links, the app's
// own kurokawatools:// links, .torrent files), the clipboard hotkeys' accelerators turned into the global-shortcut
// plugin's words, the tray's library on Linux, the system's «register as the magnet app» steps, and the nearest thing
// to a notification's click this shell can give. desktop.rs does the windows. Std only, checked alone with
// `rustc --edition 2021 --test desklogic.rs`.
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// main.cjs's states that count as «moving».
pub fn is_moving(state: &str) -> bool {
    matches!(state, "downloading" | "metadata" | "checking")
}

/// A task as the computer's side reads it (from kt:tasks' JSON).
#[derive(Clone, Debug, Default)]
pub struct TaskLite {
    pub id: String,
    pub name: String,
    pub state: String,
    pub done: f64,
    pub total: f64,
    pub down: f64,
}

/// The choices of kt:desktopPrefs (main.cjs's deskPrefs; the hotkeys are desktop.rs's).
#[derive(Clone, Debug)]
pub struct Prefs {
    pub keep_awake: bool,
    pub when_done: String,
    pub notify_done: bool,
    pub tray: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { keep_awake: true, when_done: "nothing".to_string(), notify_done: true, tray: false }
    }
}

/// A when-done choice main.cjs takes ('nothing' | 'quit' | 'sleep' | 'shutdown').
pub fn when_done_ok(s: &str) -> bool {
    matches!(s, "nothing" | "quit" | "sleep" | "shutdown")
}

/// What one list of tasks asks of the computer.
#[derive(Debug, PartialEq)]
pub struct Step {
    /// The taskbar's progress: None takes it away (main.cjs's −1), Some(2.0) indeterminate, else 0–1.
    pub progress: Option<f64>,
    pub moving: usize,
    /// The speed down over every moving download (the tray's tooltip).
    pub down: f64,
    /// Whether the computer should be kept awake now.
    pub awake: bool,
    /// All done, as chosen: 'quit' | 'sleep' | 'shutdown'.
    pub when_done: Option<String>,
    /// Finished downloads to tell of: (id, title, body).
    pub notify: Vec<(String, String, String)>,
}

/// main.cjs's state between two lists: wasActive, wasActiveIds, doneSeen.
#[derive(Default)]
pub struct Watch {
    was_active: bool,
    was_active_ids: HashSet<String>,
    done_seen: HashSet<String>,
}

impl Watch {
    /// onDesktopTasks + notifyDone, in main.cjs's order.
    pub fn step(&mut self, tasks: &[TaskLite], p: &Prefs) -> Step {
        let moving: Vec<&TaskLite> = tasks.iter().filter(|x| is_moving(&x.state)).collect();
        let total: f64 = moving.iter().map(|x| num(x.total)).sum();
        let done: f64 = moving.iter().map(|x| num(x.done)).sum();
        let progress = if moving.is_empty() {
            None
        } else if total > 0.0 {
            Some((done / total).min(1.0))
        } else {
            Some(2.0)
        };
        let queued = tasks.iter().any(|x| x.state == "queued");
        let when_done = if self.was_active && moving.is_empty() && !queued && p.when_done != "nothing" && when_done_ok(&p.when_done) {
            Some(p.when_done.clone())
        } else {
            None
        };
        for x in moving.iter() {
            self.was_active_ids.insert(x.id.clone());
        }
        let mut notify = Vec::new();
        // (main.cjs: nothing at all — not even «seen» — while notices are off.)
        if p.notify_done {
            for x in tasks.iter() {
                if x.state != "done" || self.done_seen.contains(&x.id) {
                    continue;
                }
                self.done_seen.insert(x.id.clone());
                if !self.was_active_ids.contains(&x.id) {
                    continue;
                }
                let title = if x.name.trim().is_empty() { "Download finished".to_string() } else { x.name.clone() };
                let body = if num(x.total) > 0.0 { human(num(x.total)) } else { String::new() };
                notify.push((x.id.clone(), title, body));
            }
        }
        self.was_active = !moving.is_empty();
        Step {
            progress,
            moving: moving.len(),
            down: moving.iter().map(|x| num(x.down)).sum(),
            awake: !moving.is_empty() && p.keep_awake,
            when_done,
            notify,
        }
    }
}

fn num(v: f64) -> f64 {
    if v.is_finite() && v > 0.0 {
        v
    } else {
        0.0
    }
}

/// main.cjs's human(): «1.5 GB», «3.2 MB», «12 KB», «900 B».
pub fn human(n: f64) -> String {
    const G: f64 = (1u64 << 30) as f64;
    const M: f64 = (1u64 << 20) as f64;
    if n >= G {
        format!("{:.1} GB", n / G)
    } else if n >= M {
        format!("{:.1} MB", n / M)
    } else if n >= 1024.0 {
        format!("{} KB", (n / 1024.0).round() as u64)
    } else {
        format!("{} B", n.round() as u64)
    }
}

/// The tray's tooltip (main.cjs's trayUpdate).
pub fn tooltip(app: &str, moving: usize, down: f64) -> String {
    if moving == 0 {
        app.to_string()
    } else {
        format!("{} · ↓ {}/s · {}", app, human(down), moving)
    }
}

/// main.cjs's whenAllDone commands: the program and its arguments (None: nothing to run — 'quit' is the app's own).
pub fn when_done_command(what: &str, os: &str) -> Option<(String, Vec<String>)> {
    let v = |p: &str, a: &[&str]| Some((p.to_string(), a.iter().map(|s| s.to_string()).collect()));
    match (what, os) {
        ("sleep", "windows") => v("rundll32.exe", &["powrprof.dll,SetSuspendState", "0,1,0"]),
        ("sleep", "macos") => v("pmset", &["sleepnow"]),
        ("sleep", _) => v("systemctl", &["suspend"]),
        ("shutdown", "windows") => v("shutdown", &["/s", "/t", "60"]),
        ("shutdown", "macos") => v("osascript", &["-e", "tell app \"System Events\" to shut down"]),
        ("shutdown", _) => v("systemctl", &["poweroff"]),
        _ => None,
    }
}

/// The child that keeps the computer awake (Electron's powerSaveBlocker 'prevent-app-suspension': the system kept from
/// sleeping, the screen may go dark) and ends by itself when the app ends: a Mac's caffeinate -i -w <pid>; Linux's
/// systemd-inhibit over a «tail --pid» that waits for the app. None on Windows (SetThreadExecutionState there).
pub fn awake_command(os: &str, pid: u32) -> Option<(String, Vec<String>)> {
    let v = |p: &str, a: Vec<String>| Some((p.to_string(), a));
    match os {
        "macos" => v("caffeinate", vec!["-i".into(), "-w".into(), pid.to_string()]),
        "linux" => v(
            "systemd-inhibit",
            vec![
                "--what=idle:sleep".into(),
                "--who=Kurokawa Tools".into(),
                "--why=Downloads are running".into(),
                "--mode=block".into(),
                "tail".into(),
                format!("--pid={}", pid),
                "-f".into(),
                "/dev/null".into(),
            ],
        ),
        _ => None,
    }
}

/// What a launch argument is to the app (main.cjs's takeArg).
#[derive(Debug, PartialEq)]
pub enum Arg {
    /// A magnet, a web address, or what a kurokawatools://open?u= link carries — handed to the page (kt:open).
    Link(String),
    /// A .torrent file that is there: its bytes go to the page as a data: address.
    Torrent(PathBuf),
}

fn starts_ci(s: &str, p: &str) -> bool {
    s.len() >= p.len() && s.is_char_boundary(p.len()) && s[..p.len()].eq_ignore_ascii_case(p)
}

fn hexv(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// A file:// address (a Mac and Linux's file managers hand files over as these) → its path.
pub fn file_url_path(s: &str, windows: bool) -> Option<String> {
    if !starts_ci(s, "file://") {
        return None;
    }
    let mut rest = &s[7..];
    if starts_ci(rest, "localhost") {
        rest = &rest[9..];
    }
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let b = rest.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hexv(b[i + 1]), hexv(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    let p = String::from_utf8(out).ok()?;
    if windows {
        let t = p.strip_prefix('/').unwrap_or(&p);
        if t.len() >= 2 && t.as_bytes()[1] == b':' {
            return Some(t.replace('/', "\\"));
        }
        return Some(p.replace('/', "\\"));
    }
    Some(p)
}

/// A launch's arguments (the program's own name left out) → what to hand the page, in order, each once. `exists`
/// says whether a file is there. As main.cjs: switches and anything else are left alone; a kurokawatools://open?u=
/// link gives what follows «u=» as it stands (main.cjs's replace); here also a file:// address and a relative path
/// (from the launch's own folder) of a .torrent.
pub fn sort_args(args: &[String], cwd: &Path, windows: bool, exists: &dyn Fn(&Path) -> bool) -> Vec<Arg> {
    let mut out: Vec<Arg> = Vec::new();
    for a in args.iter() {
        let a = a.trim();
        if a.is_empty() || a.starts_with('-') {
            continue;
        }
        let item = if starts_ci(a, "magnet:") || starts_ci(a, "http:") || starts_ci(a, "https:") {
            Some(Arg::Link(a.to_string()))
        } else if starts_ci(a, "kurokawatools:") {
            let rest = if starts_ci(a, "kurokawatools://open?u=") { &a[23..] } else { a };
            if rest.is_empty() {
                None
            } else {
                Some(Arg::Link(rest.to_string()))
            }
        } else {
            let p = file_url_path(a, windows).unwrap_or_else(|| a.to_string());
            if p.to_ascii_lowercase().ends_with(".torrent") {
                let pb = PathBuf::from(&p);
                let full = if pb.is_absolute() { pb } else { cwd.join(pb) };
                if exists(&full) {
                    Some(Arg::Torrent(full))
                } else {
                    None
                }
            } else {
                None
            }
        };
        if let Some(it) = item {
            if !out.contains(&it) {
                out.push(it);
            }
        }
    }
    out
}

/// The most of a .torrent file the app reads into a data: address (Electron reads any; a torrent's metadata is a few
/// MB at most — a larger file is no torrent).
pub const TORRENT_MAX: u64 = 64 << 20;

/// An Electron accelerator ("CommandOrControl+Shift+V") → the global-shortcut plugin's words, or why not: a key or a
/// modifier the plugin has no name for (Electron's AltGr, media keys…). Modifiers once each, then one key.
pub fn accelerator(acc: &str) -> Result<String, String> {
    let parts: Vec<&str> = acc.split('+').map(|s| s.trim()).collect();
    // («Ctrl++» — Electron's Plus written as the sign itself — leaves an empty part last.)
    let mut toks: Vec<String> = Vec::new();
    let mut i = 0;
    while i < parts.len() {
        let p = parts[i];
        if p.is_empty() {
            if i + 1 == parts.len() - 1 && parts[i + 1].is_empty() {
                toks.push("Plus".to_string());
                break;
            }
            return Err(format!("empty part in «{}»", acc));
        }
        toks.push(p.to_string());
        i += 1;
    }
    if toks.is_empty() {
        return Err("empty".to_string());
    }
    let key = toks.pop().unwrap_or_default();
    let mut mods: Vec<&'static str> = Vec::new();
    for m in toks.iter() {
        let name = match m.to_ascii_lowercase().as_str() {
            "commandorcontrol" | "cmdorctrl" | "commandorctrl" | "cmdorcontrol" => "CommandOrControl",
            "command" | "cmd" | "super" | "meta" => "Super",
            "control" | "ctrl" => "Control",
            "alt" | "option" => "Alt",
            "shift" => "Shift",
            other => return Err(format!("modifier «{}» is not supported here", other)),
        };
        if mods.contains(&name) {
            return Err(format!("«{}» twice", name));
        }
        mods.push(name);
    }
    let k = key_name(&key).ok_or_else(|| format!("key «{}» is not supported here", key))?;
    let mut out: Vec<String> = mods.iter().map(|s| s.to_string()).collect();
    out.push(k);
    Ok(out.join("+"))
}

/// One key of an Electron accelerator → the W3C key code name the plugin parses.
fn key_name(k: &str) -> Option<String> {
    let l = k.to_ascii_lowercase();
    if k.len() == 1 {
        let c = k.chars().next()?;
        if c.is_ascii_alphabetic() {
            return Some(format!("Key{}", c.to_ascii_uppercase()));
        }
        if c.is_ascii_digit() {
            return Some(format!("Digit{}", c));
        }
        let p = match c {
            '`' => "Backquote",
            '\\' => "Backslash",
            '[' => "BracketLeft",
            ']' => "BracketRight",
            ',' => "Comma",
            '=' => "Equal",
            '-' => "Minus",
            '.' => "Period",
            '\'' => "Quote",
            ';' => "Semicolon",
            '/' => "Slash",
            _ => return None,
        };
        return Some(p.to_string());
    }
    if let Some(n) = l.strip_prefix('f') {
        if let Ok(v) = n.parse::<u8>() {
            if (1..=24).contains(&v) {
                return Some(format!("F{}", v));
            }
        }
    }
    if let Some(n) = l.strip_prefix("num") {
        if let Ok(v) = n.parse::<u8>() {
            if v <= 9 {
                return Some(format!("Numpad{}", v));
            }
        }
    }
    let named = match l.as_str() {
        "plus" => "Equal",
        "space" => "Space",
        "tab" => "Tab",
        "backspace" => "Backspace",
        "delete" | "del" => "Delete",
        "insert" | "ins" => "Insert",
        "return" | "enter" => "Enter",
        "up" => "ArrowUp",
        "down" => "ArrowDown",
        "left" => "ArrowLeft",
        "right" => "ArrowRight",
        "home" => "Home",
        "end" => "End",
        "pageup" => "PageUp",
        "pagedown" => "PageDown",
        "escape" | "esc" => "Escape",
        "printscreen" => "PrintScreen",
        "capslock" => "CapsLock",
        "scrolllock" => "ScrollLock",
        _ => return None,
    };
    Some(named.to_string())
}

/// The tray's library on Linux (the tray-icon crate loads libayatana-appindicator3 or libappindicator3 when the first
/// tray is made, and stops the program when neither is there): whether one is in these folders.
pub fn tray_lib_in(dirs: &[PathBuf], exists: &dyn Fn(&Path) -> bool) -> bool {
    const NAMES: [&str; 4] = ["libayatana-appindicator3.so.1", "libappindicator3.so.1", "libayatana-appindicator3.so", "libappindicator3.so"];
    dirs.iter().any(|d| NAMES.iter().any(|n| exists(&d.join(n))))
}

/// The folders the system's loader looks in for the tray's library ($LD_LIBRARY_PATH first).
pub fn lib_dirs(ld_path: Option<&str>) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = ld_path.unwrap_or("").split(':').filter(|s| !s.is_empty()).map(PathBuf::from).collect();
    for d in [
        "/usr/lib/x86_64-linux-gnu",
        "/usr/lib/aarch64-linux-gnu",
        "/lib/x86_64-linux-gnu",
        "/lib/aarch64-linux-gnu",
        "/usr/lib64",
        "/usr/lib",
        "/lib64",
        "/lib",
        "/usr/local/lib",
    ] {
        v.push(PathBuf::from(d));
    }
    v
}

/// Windows: what Electron's app.setAsDefaultProtocolClient('magnet') writes (HKCU\Software\Classes\magnet, the
/// program with "%1"), as reg.exe argument lists.
pub fn magnet_reg_args(exe: &str) -> Vec<Vec<String>> {
    let key = "HKCU\\Software\\Classes\\magnet".to_string();
    let s = |x: &str| x.to_string();
    vec![
        vec![s("add"), key.clone(), s("/ve"), s("/d"), s("URL:magnet"), s("/f")],
        vec![s("add"), key.clone(), s("/v"), s("URL Protocol"), s("/d"), s(""), s("/f")],
        vec![s("add"), format!("{}\\shell\\open\\command", key), s("/ve"), s("/d"), format!("\"{}\" \"%1\"", exe), s("/f")],
    ]
}

/// Whether a desktop entry's text runs this program (for «register as the magnet app» on Linux: the entry the .deb or
/// the AppImage's integration installed).
pub fn desktop_entry_runs(text: &str, exe_name: &str) -> bool {
    text.lines().any(|l| {
        let l = l.trim();
        l.starts_with("Exec=") && l[5..].split_whitespace().next().map(|p| p.trim_matches('"').rsplit('/').next().unwrap_or("") == exe_name).unwrap_or(false)
    })
}

/// The nearest thing to a notice's click: the system gives this shell no click on a computer (the notification plugin
/// has none there), so a download told of while the window was not in front is opened (kt:openTask) the first time
/// the window comes to the front within this many milliseconds.
pub const CLICK_WINDOW_MS: u64 = 120_000;

/// The last notice and when it was given (ms), while the window was away.
#[derive(Default)]
pub struct NoticeOpen {
    last: Option<(String, u64)>,
}

impl NoticeOpen {
    pub fn told(&mut self, id: &str, now: u64, window_in_front: bool) {
        if !window_in_front {
            self.last = Some((id.to_string(), now));
        }
    }
    /// The window came to the front: the download to open, once.
    pub fn focused(&mut self, now: u64) -> Option<String> {
        let (id, at) = self.last.take()?;
        if now >= at && now - at <= CLICK_WINDOW_MS {
            Some(id)
        } else {
            None
        }
    }
}

/// (sitewin.rs) Whether an address can be opened in the sign-in / site windows: http or https only (Electron's
/// siteWindow: https only; its captureUrl took anything — here no file:, javascript: or data: address).
pub fn site_openable(u: &str, https_only: bool) -> bool {
    let l = u.trim().to_ascii_lowercase();
    let https = l.starts_with("https://") && l.len() > 8;
    https || (!https_only && l.starts_with("http://") && l.len() > 7)
}

/// (sitewin.rs) main.cjs's check(u) for kt:captureUrl: the address carries the marker (an empty one: the first
/// address, as `includes('')`).
pub fn site_hit(url: &str, marker: &str) -> bool {
    url.contains(marker)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(id: &str, state: &str, done: f64, total: f64) -> TaskLite {
        TaskLite { id: id.into(), name: format!("{}.bin", id), state: state.into(), done, total, down: 100.0 }
    }

    #[test]
    fn steps_like_main_cjs() {
        let mut w = Watch::default();
        let p = Prefs { when_done: "sleep".into(), ..Prefs::default() };
        let s = w.step(&[t("a", "downloading", 50.0, 100.0), t("b", "metadata", 0.0, 0.0), t("c", "done", 9.0, 9.0)], &p);
        assert_eq!(s.progress, Some(0.5));
        assert_eq!(s.moving, 2);
        assert!(s.awake);
        assert_eq!(s.when_done, None);
        // (c was never seen moving: no notice.)
        assert!(s.notify.is_empty());
        let s = w.step(&[t("a", "done", 100.0, 100.0), t("b", "queued", 0.0, 0.0)], &p);
        assert_eq!(s.progress, None);
        assert!(!s.awake);
        // (Something is still queued: not all done.)
        assert_eq!(s.when_done, None);
        assert_eq!(s.notify, vec![("a".to_string(), "a.bin".to_string(), "100 B".to_string())]);
        // (Already told: not again; nothing moved since: no when-done.)
        let s = w.step(&[t("a", "done", 100.0, 100.0)], &p);
        assert!(s.notify.is_empty() && s.when_done.is_none());
        let s = w.step(&[t("d", "downloading", 0.0, 0.0)], &p);
        assert_eq!(s.progress, Some(2.0));
        let s = w.step(&[t("d", "done", 5.0, 5.0)], &p);
        assert_eq!(s.when_done.as_deref(), Some("sleep"));
        assert_eq!(s.notify.len(), 1);
        let s = w.step(&[t("d", "done", 5.0, 5.0)], &p);
        assert_eq!(s.when_done, None);
    }

    #[test]
    fn prefs_off() {
        let mut w = Watch::default();
        let p = Prefs { keep_awake: false, notify_done: false, ..Prefs::default() };
        let s = w.step(&[t("a", "downloading", 200.0, 100.0)], &p);
        assert_eq!(s.progress, Some(1.0));
        assert!(!s.awake);
        let s = w.step(&[t("a", "done", 1.0, 1.0)], &p);
        assert!(s.notify.is_empty() && s.when_done.is_none());
        // (Notices turned on later: «a» was never marked seen, as in main.cjs, so it is told now.)
        let s = w.step(&[t("a", "done", 1.0, 1.0)], &Prefs::default());
        assert_eq!(s.notify.len(), 1);
        let mut w = Watch::default();
        let bad = Prefs { when_done: "reboot".into(), ..Prefs::default() };
        w.step(&[t("a", "downloading", 1.0, 2.0)], &bad);
        assert_eq!(w.step(&[], &bad).when_done, None);
    }

    #[test]
    fn sizes_and_tooltip() {
        assert_eq!(human(900.0), "900 B");
        assert_eq!(human(1536.0), "2 KB");
        assert_eq!(human(3.0 * 1048576.0 + 200000.0), "3.2 MB");
        assert_eq!(human(1.5 * 1073741824.0), "1.5 GB");
        assert_eq!(tooltip("Kurokawa Tools", 0, 5.0), "Kurokawa Tools");
        assert_eq!(tooltip("Kurokawa Tools", 2, 2048.0), "Kurokawa Tools · ↓ 2 KB/s · 2");
    }

    #[test]
    fn commands() {
        assert_eq!(when_done_command("sleep", "linux").unwrap().0, "systemctl");
        assert_eq!(when_done_command("shutdown", "windows").unwrap().1, vec!["/s", "/t", "60"]);
        assert_eq!(when_done_command("quit", "macos"), None);
        assert_eq!(when_done_command("nothing", "linux"), None);
        assert_eq!(awake_command("macos", 42).unwrap().1, vec!["-i", "-w", "42"]);
        let l = awake_command("linux", 7).unwrap();
        assert_eq!(l.0, "systemd-inhibit");
        assert!(l.1.contains(&"--pid=7".to_string()) && l.1.contains(&"--mode=block".to_string()));
        assert_eq!(awake_command("windows", 1), None);
        let r = magnet_reg_args("C:\\P\\Kurokawa Tools.exe");
        assert_eq!(r.len(), 3);
        assert_eq!(r[2][4], "\"C:\\P\\Kurokawa Tools.exe\" \"%1\"");
        assert_eq!(r[1][3], "URL Protocol");
    }

    #[test]
    fn launch_args() {
        let cwd = Path::new("/home/u/dl");
        let there = |p: &Path| p == Path::new("/home/u/dl/a.torrent") || p == Path::new("/x/b c.torrent");
        let args: Vec<String> = [
            "--hidden", "magnet:?xt=urn:btih:abc", "HTTPS://e.org/f.iso", "kurokawatools://open?u=magnet%3A%3Fxt", "a.torrent", "missing.torrent",
            "file:///x/b%20c.torrent", "notes.txt", "magnet:?xt=urn:btih:abc", "kurokawatools://open?u=", "",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let got = sort_args(&args, cwd, false, &there);
        assert_eq!(
            got,
            vec![
                Arg::Link("magnet:?xt=urn:btih:abc".into()),
                Arg::Link("HTTPS://e.org/f.iso".into()),
                Arg::Link("magnet%3A%3Fxt".into()),
                Arg::Torrent(PathBuf::from("/home/u/dl/a.torrent")),
                Arg::Torrent(PathBuf::from("/x/b c.torrent")),
            ]
        );
        assert_eq!(file_url_path("file:///C:/a/b.torrent", true).as_deref(), Some("C:\\a\\b.torrent"));
        assert_eq!(file_url_path("file://localhost/a%2", false).as_deref(), Some("/a%2"));
        assert_eq!(file_url_path("magnet:x", false), None);
        // (Not a char boundary at the prefix's length: no panic.)
        assert!(sort_args(&["ééééééé".to_string()], cwd, false, &there).is_empty());
    }

    #[test]
    fn accelerators() {
        assert_eq!(accelerator("CommandOrControl+Shift+V").unwrap(), "CommandOrControl+Shift+KeyV");
        assert_eq!(accelerator("CmdOrCtrl+Alt+1").unwrap(), "CommandOrControl+Alt+Digit1");
        assert_eq!(accelerator("Ctrl+F12").unwrap(), "Control+F12");
        assert_eq!(accelerator("Super+Up").unwrap(), "Super+ArrowUp");
        assert_eq!(accelerator("Option+Return").unwrap(), "Alt+Enter");
        assert_eq!(accelerator("Ctrl+num5").unwrap(), "Control+Numpad5");
        assert_eq!(accelerator("Ctrl+Plus").unwrap(), "Control+Equal");
        assert_eq!(accelerator("Ctrl++").unwrap(), "Control+Equal");
        assert_eq!(accelerator("Shift+/").unwrap(), "Shift+Slash");
        assert!(accelerator("AltGr+V").is_err());
        assert!(accelerator("Ctrl+Ctrl+V").is_err());
        assert!(accelerator("Ctrl+VolumeUp").is_err());
        assert!(accelerator("Ctrl+F25").is_err());
        assert!(accelerator("").is_err());
        assert!(accelerator("Ctrl++V").is_err());
    }

    #[test]
    fn tray_lib() {
        let dirs = lib_dirs(Some("/opt/l::/x"));
        assert_eq!(dirs[0], PathBuf::from("/opt/l"));
        assert_eq!(dirs[1], PathBuf::from("/x"));
        assert!(tray_lib_in(&dirs, &|p: &Path| p == Path::new("/usr/lib/libappindicator3.so.1")));
        assert!(!tray_lib_in(&dirs, &|_p: &Path| false));
    }

    #[test]
    fn desktop_entry() {
        assert!(desktop_entry_runs("[Desktop Entry]\nName=K\nExec=/usr/bin/kurokawa-tools %u\n", "kurokawa-tools"));
        assert!(desktop_entry_runs("Exec=\"/opt/K/kurokawa-tools\"", "kurokawa-tools"));
        assert!(!desktop_entry_runs("Exec=/usr/bin/other %u\nTryExec=kurokawa-tools", "kurokawa-tools"));
    }

    #[test]
    fn notice_open() {
        let mut n = NoticeOpen::default();
        n.told("a", 1000, true);
        assert_eq!(n.focused(2000), None);
        n.told("b", 1000, false);
        assert_eq!(n.focused(1000 + CLICK_WINDOW_MS + 1), None);
        n.told("c", 5000, false);
        assert_eq!(n.focused(6000).as_deref(), Some("c"));
        assert_eq!(n.focused(6001), None);
    }

    #[test]
    fn site_windows() {
        assert!(site_openable("https://anilist.co/api/v2/oauth/authorize?x", false));
        assert!(site_openable("http://127.0.0.1:9/x", false));
        assert!(!site_openable("http://127.0.0.1:9/x", true));
        assert!(!site_openable("javascript:alert(1)", false));
        assert!(!site_openable("file:///etc/passwd", false));
        assert!(!site_openable("data:text/html,x", false));
        assert!(!site_openable("https://", true));
        assert!(site_openable(" HTTPS://e.org/", true));
        assert!(site_hit("https://anilist.co/api/v2/oauth/pin#access_token=abc", "access_token="));
        assert!(!site_hit("https://anilist.co/login", "access_token="));
        assert!(site_hit("https://x/", ""));
    }
}
