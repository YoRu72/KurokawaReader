// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): «start with the system, hidden» — what is written, and where.
// Derived from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor), src/main.cpp
// (SetAutostart / AutostartEnabled: the Run value «"<exe>"») and src/linux/main_linux.cpp (ApplyAutostart: an XDG
// autostart .desktop file) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later.
// Changed here: the program starts hidden (--hidden: the tray only); a path that cannot be quoted safely is refused
// rather than written; the .desktop file's Exec is quoted by the Desktop Entry rules (the original wrote the path in
// quotes only, so a path with «"», «$», «\» or «%» broke it); an entry is ours only when it names this very program.
// Pure and std only; the Windows registry calls are win/autostart.rs, the file is written by the shell.
// Copyright (C) 2026 Kurokawa contributors.
use std::path::PathBuf;

/// The flag a start with the system carries: the shell then opens with its window hidden, in the tray.
pub const HIDDEN_FLAG: &str = "--hidden";
/// The Run value's name (HKCU\Software\Microsoft\Windows\CurrentVersion\Run): its own, apart from the screen
/// translator's «Kurokawa Tools», so turning one off never removes the other.
pub const RUN_VALUE: &str = "Kurokawa Tools Device battery";
/// The XDG autostart file's name.
pub const DESKTOP_FILE: &str = "kurokawa-tools-battery.desktop";

/// A program path fit to be written: absolute-looking, no quote, no control character.
fn plain_path(exe: &str) -> bool {
    !exe.is_empty() && exe.len() < 4096 && !exe.contains('"') && !exe.chars().any(char::is_control)
}

/// The Run value's data: «"<exe>" --hidden». None for a path that cannot be quoted (Windows paths never hold «"»).
pub fn run_command(exe: &str) -> Option<String> {
    if !plain_path(exe) || !(exe.contains(":\\") || exe.starts_with("\\\\")) {
        return None;
    }
    Some(format!("\"{}\" {}", exe, HIDDEN_FLAG))
}

/// Whether the Run value's data is ours for this program (case aside, as Windows paths are).
pub fn run_is_ours(data: &str, exe: &str) -> bool {
    run_command(exe).map_or(false, |c| c.eq_ignore_ascii_case(data.trim()))
}

/// One Exec argument quoted by the Desktop Entry rules: in double quotes, «"», «`», «$» and «\» escaped with «\»; then
/// the file's own string escaping («\» doubled) and field codes («%» doubled).
fn exec_arg(s: &str) -> String {
    let mut q = String::with_capacity(s.len() + 2);
    q.push('"');
    for c in s.chars() {
        if matches!(c, '"' | '`' | '$' | '\\') {
            q.push('\\');
        }
        q.push(c);
    }
    q.push('"');
    q.replace('\\', "\\\\").replace('%', "%%")
}

/// The XDG autostart file for this program. None for a path that is not absolute or holds a control character.
pub fn desktop_entry(exe: &str, name: &str, comment: &str) -> Option<String> {
    if exe.is_empty() || !exe.starts_with('/') || exe.chars().any(char::is_control) || exe.len() >= 4096 {
        return None;
    }
    let one_line = |s: &str| s.chars().filter(|c| !c.is_control()).collect::<String>();
    Some(format!(
        "[Desktop Entry]\nType=Application\nName={}\nComment={}\nExec={} {}\nTerminal=false\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n",
        one_line(name),
        one_line(comment),
        exec_arg(exe),
        HIDDEN_FLAG
    ))
}

/// Where the autostart file goes: $XDG_CONFIG_HOME/autostart (an absolute one), else $HOME/.config/autostart.
pub fn desktop_path(config_home: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    let base = match config_home.filter(|c| c.starts_with('/')) {
        Some(c) => PathBuf::from(c),
        None => PathBuf::from(home.filter(|h| h.starts_with('/'))?).join(".config"),
    };
    Some(base.join("autostart").join(DESKTOP_FILE))
}

/// Whether a launch's arguments (the program's name left out) ask for a hidden start.
pub fn wants_hidden(args: &[String]) -> bool {
    args.iter().any(|a| a == HIDDEN_FLAG)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_value_quotes_the_path_and_refuses_what_it_cannot_quote() {
        let exe = r"C:\Program Files\Kurokawa Tools\Kurokawa Tools.exe";
        assert_eq!(run_command(exe).as_deref(), Some(r#""C:\Program Files\Kurokawa Tools\Kurokawa Tools.exe" --hidden"#));
        assert_eq!(run_command(r"\\server\share\kt.exe").as_deref(), Some(r#""\\server\share\kt.exe" --hidden"#));
        assert!(run_command("").is_none());
        assert!(run_command(r#"C:\a"b.exe"#).is_none());
        assert!(run_command("C:\\a\nb.exe").is_none());
        assert!(run_command("kt.exe").is_none(), "a bare name would be looked for on the PATH");
        assert!(run_is_ours(r#""c:\program files\kurokawa tools\kurokawa tools.exe" --hidden"#, exe));
        assert!(!run_is_ours(r#""C:\Other\kt.exe" --hidden"#, exe));
        assert!(!run_is_ours(r#""C:\Program Files\Kurokawa Tools\Kurokawa Tools.exe""#, exe), "without the flag it is not ours");
        assert_ne!(RUN_VALUE, "Kurokawa Tools", "never the screen translator's value");
    }

    #[test]
    fn desktop_entry_quotes_exec_by_the_rules() {
        let e = desktop_entry("/opt/Kurokawa Tools/kurokawa-tools", "Kurokawa Tools", "Device battery").unwrap();
        assert!(e.starts_with("[Desktop Entry]\nType=Application\n"));
        assert!(e.contains("\nExec=\"/opt/Kurokawa Tools/kurokawa-tools\" --hidden\n"), "{e}");
        assert!(e.contains("\nNoDisplay=true\n") && e.contains("\nTerminal=false\n"));
        let odd = desktop_entry("/home/u/a$b\"c`d\\e%f/kt", "N", "C").unwrap();
        // ($ " ` \ escaped for the Exec rules, then «\» doubled and «%» doubled for the file.)
        assert!(odd.contains(r#"Exec="/home/u/a\\$b\\"c\\`d\\\\e%%f/kt" --hidden"#), "{odd}");
        assert!(desktop_entry("relative/kt", "N", "C").is_none());
        assert!(desktop_entry("/a\nb", "N", "C").is_none());
        let n = desktop_entry("/kt", "A\nExec=/bin/x", "C").unwrap();
        assert_eq!(n.matches("\nExec=").count(), 1, "a name cannot add a line");
    }

    #[test]
    fn desktop_path_and_flag() {
        assert_eq!(desktop_path(Some("/c"), Some("/h")), Some(PathBuf::from("/c/autostart/kurokawa-tools-battery.desktop")));
        assert_eq!(desktop_path(Some("rel"), Some("/h")), Some(PathBuf::from("/h/.config/autostart/kurokawa-tools-battery.desktop")));
        assert_eq!(desktop_path(None, None), None);
        assert_eq!(desktop_path(None, Some("")), None);
        assert!(wants_hidden(&["--hidden".to_string()]));
        assert!(!wants_hidden(&["--hiddenx".to_string(), "magnet:?x".to_string()]));
    }
}
