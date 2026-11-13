// KurokawaReader Setup — its decisions, std only (no crates), unit-tested alone:
//   rustc --edition 2021 --test src/logic.rs -o /tmp/setuplogic && /tmp/setuplogic
// (as the workflow's «Std-only unit tests» step runs updatelogic.rs and the others). main.rs does the Windows calls
// and hands what they answered to these functions:
//   - the choices made on the page → the NSIS installer's command line (R6b's installer, run silently);
//   - the program's own command line → passed straight through (/S, /P: the app's updater, unattended installs);
//   - `reg query` answers → whether WebView2 (the Evergreen runtime) is there, and Windows' light or dark app mode;
//   - a `reg export` of HKCU\…\Uninstall (UTF-16) → the copy installed now: this build's, the Electron build's, none;
//   - what can be seen of the install as it runs → its step and a percentage, honest and never going back;
//   - the installer's exit code → why it failed, in a word the page turns into a sentence.
#![allow(dead_code)]

/// The product's folder name, added to a folder chosen in the folder dialog (as the one-page installer does).
pub const PRODUCT: &str = "KurokawaReader";
/// The registry key Tauri's NSIS installer writes for this build (HKCU, per user): its uninstall entry.
pub const UNINSTALL_KEY: &str = r"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall";
/// WebView2's Evergreen runtime, as Microsoft documents its detection: `pv` under this client key, in HKLM (64-bit
/// and 32-bit views) or HKCU, neither empty nor 0.0.0.0.
pub const WEBVIEW2_KEYS: [&str; 3] = [
    r"HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    r"HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    r"HKCU\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
];
/// Windows' app mode: AppsUseLightTheme (REG_DWORD; 0 = dark).
pub const THEME_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

// ───────────────────────────────── The choices → the NSIS installer's command line ─────────────────────────────────

/// What the page chose.
#[derive(Debug, Clone, PartialEq)]
pub struct Choices {
    /// The folder ("" = the installer's own: this build's earlier folder, else %LOCALAPPDATA%\KurokawaReader).
    pub dir: String,
    pub desktop: bool,
    pub assoc: bool,
    /// The installed Electron copy: "replace" | "keep" (old_decision) | "" (none found: nothing passed).
    pub old: String,
}

/// R6b's installer run silently with the choices: `/S` (NSIS: no window), `/KRDESK=0|1` and `/KRASSOC=0|1` (read by
/// onepage.nsh's KrAfterInstall — see setup/INTEGRATION.md: the small addition it needs), and `/D=<folder>` last, as
/// NSIS requires. «Open when done» is not passed: the setup program opens the app itself once it shows «done».
pub fn nsis_args(c: &Choices) -> Vec<String> {
    let mut a = vec!["/S".to_string(), format!("/KRDESK={}", c.desktop as u8), format!("/KRASSOC={}", c.assoc as u8)];
    if c.old == "replace" || c.old == "keep" {
        a.push(format!("/KROLD={}", c.old));
    }
    let d = clean_dir(&c.dir);
    if !d.is_empty() {
        a.push(format!("/D={}", d));
    }
    a
}

/// A folder as NSIS takes it after /D=: no quotes, no trailing backslash (except a drive's root), no line breaks.
pub fn clean_dir(d: &str) -> String {
    let mut s: String = d.trim().chars().filter(|c| *c != '"' && *c != '\r' && *c != '\n').collect();
    while s.len() > 3 && (s.ends_with('\\') || s.ends_with('/')) {
        s.pop();
    }
    s
}

/// The command line, as Windows passes it (main.rs gives it whole with `raw_arg`): each argument quoted when it holds
/// a space or a quote — except /D=, which NSIS reads to the end of the line unquoted (it must stay last).
pub fn command_line(args: &[String]) -> String {
    let mut out: Vec<String> = Vec::new();
    for a in args {
        let is_dir = a.len() >= 3 && a[..3].eq_ignore_ascii_case("/D=");
        if is_dir || !(a.is_empty() || a.contains(' ') || a.contains('\t') || a.contains('"')) {
            out.push(a.clone());
        } else {
            out.push(quote(a));
        }
    }
    out.join(" ")
}

/// One argument quoted the way Windows' C runtime reads it back (backslashes before a quote doubled).
pub fn quote(a: &str) -> String {
    let mut s = String::from("\"");
    let mut slashes = 0usize;
    for ch in a.chars() {
        match ch {
            '\\' => slashes += 1,
            '"' => {
                s.push_str(&"\\".repeat(slashes * 2 + 1));
                s.push('"');
                slashes = 0;
                continue;
            }
            _ => {}
        }
        if ch != '\\' {
            s.push_str(&"\\".repeat(slashes));
            slashes = 0;
            s.push(ch);
        }
    }
    s.push_str(&"\\".repeat(slashes * 2));
    s.push('"');
    s
}

/// The setup program's own command line: when it asks for no window — `/S` (silent), `/P` (passive: the app's
/// updater runs `/P /R /UPDATE`), `--silent` —, the arguments to give the NSIS installer instead (the same, with
/// `--silent` turned into `/S`); `None`: show the window.
pub fn passthrough(argv: &[String]) -> Option<Vec<String>> {
    let quiet = argv.iter().any(|a| {
        let l = a.to_ascii_lowercase();
        l == "/s" || l == "/p" || l == "--silent" || l == "-silent" || l == "/silent" || l == "/passive" || l == "--passive"
    });
    if !quiet {
        return None;
    }
    let mut out: Vec<String> = Vec::new();
    let mut dir: Option<String> = None;
    for a in argv {
        let l = a.to_ascii_lowercase();
        if l == "--silent" || l == "-silent" || l == "/silent" {
            if !out.iter().any(|x| x.eq_ignore_ascii_case("/S")) {
                out.push("/S".into());
            }
        } else if l == "/passive" || l == "--passive" {
            out.push("/P".into());
        } else if l.starts_with("/d=") {
            dir = Some(a.clone());
        } else if l == "--classic" || l.starts_with("--inner") {
            // (The setup program's own.)
        } else {
            out.push(a.clone());
        }
    }
    if let Some(d) = dir {
        out.push(d);
    }
    Some(out)
}

/// `--inner <path>` / `--inner=<path>` (a test's installer in place of the embedded one).
pub fn inner_arg(argv: &[String]) -> Option<String> {
    for (i, a) in argv.iter().enumerate() {
        if let Some(p) = a.strip_prefix("--inner=") {
            return Some(p.to_string());
        }
        if a == "--inner" {
            return argv.get(i + 1).cloned();
        }
    }
    None
}

/// A folder chosen in the folder dialog → the folder installed into: the product's folder inside it, unless it is
/// already that one (as onepage.nsh's Browse does).
pub fn folder_for_pick(picked: &str) -> String {
    let p = clean_dir(picked);
    let last = p.rsplit(['\\', '/']).next().unwrap_or("");
    if last.eq_ignore_ascii_case(PRODUCT) {
        p
    } else if p.ends_with('\\') {
        format!("{}{}", p, PRODUCT)
    } else {
        format!("{}\\{}", p, PRODUCT)
    }
}

// ───────────────────────────────── Windows' answers: reg query, reg export ─────────────────────────────────

/// A value's data in `reg query <key> /v <name>`'s answer («    pv    REG_SZ    120.0.2210.91»).
pub fn reg_value(stdout: &str, name: &str) -> Option<String> {
    for line in stdout.lines() {
        if !line.starts_with("    ") {
            continue;
        }
        let parts: Vec<&str> = line.trim_start().splitn(3, "    ").collect();
        if parts.len() >= 2 && parts[0].trim().eq_ignore_ascii_case(name) && parts[1].trim().starts_with("REG_") {
            return Some(parts.get(2).map(|s| s.trim().to_string()).unwrap_or_default());
        }
    }
    None
}

/// WebView2's version from the three keys' answers (None where the key or value is missing), or None.
pub fn webview2_version(answers: &[Option<String>]) -> Option<String> {
    for a in answers.iter().flatten() {
        if let Some(v) = reg_value(a, "pv") {
            if !v.is_empty() && v != "0.0.0.0" {
                return Some(v);
            }
        }
    }
    None
}

/// Windows' app mode from `reg query <THEME_KEY> /v AppsUseLightTheme` (REG_DWORD 0x0 = dark); None: unknown.
pub fn dark_mode(stdout: &str) -> Option<bool> {
    let v = reg_value(stdout, "AppsUseLightTheme")?;
    let n = if let Some(h) = v.strip_prefix("0x") { u32::from_str_radix(h, 16).ok()? } else { v.parse().ok()? };
    Some(n == 0)
}

/// A .reg file's bytes (what `reg export` writes: UTF-16 LE with its BOM) → text.
pub fn decode_reg_file(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// A key of a .reg file and its string values (REG_SZ: `"Name"="data"`, `@="data"` as the name "").
#[derive(Debug, Clone, PartialEq)]
pub struct RegKey {
    pub path: String,
    pub values: Vec<(String, String)>,
}
impl RegKey {
    pub fn get(&self, name: &str) -> Option<&str> {
        self.values.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
    /// The key's own name (after the last backslash).
    pub fn name(&self) -> &str {
        self.path.rsplit('\\').next().unwrap_or("")
    }
}

/// A .reg file's text → its keys (only string values are kept; dwords, hex and continuation lines are skipped).
pub fn parse_reg(text: &str) -> Vec<RegKey> {
    let mut keys: Vec<RegKey> = Vec::new();
    let mut cont = false;
    for raw in text.lines() {
        let line = raw.trim_end_matches('\r');
        if cont {
            cont = line.ends_with('\\');
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            keys.push(RegKey { path: line[1..line.len() - 1].to_string(), values: Vec::new() });
            continue;
        }
        let Some(k) = keys.last_mut() else { continue };
        let (name, rest) = if let Some(r) = line.strip_prefix("@=") {
            (String::new(), r)
        } else if line.starts_with('"') {
            match read_quoted(line) {
                Some((n, used)) if line[used..].starts_with('=') => (n, &line[used + 1..]),
                _ => continue,
            }
        } else {
            continue;
        };
        if rest.starts_with('"') {
            if let Some((v, _)) = read_quoted(rest) {
                k.values.push((name, v));
            }
        } else {
            cont = rest.ends_with('\\');
        }
    }
    keys
}

/// A quoted .reg string at the start of `s` (\\ and \" unescaped) → (text, bytes used).
fn read_quoted(s: &str) -> Option<(String, usize)> {
    let mut out = String::new();
    let mut it = s.char_indices();
    if it.next()?.1 != '"' {
        return None;
    }
    let mut esc = false;
    for (i, c) in it {
        if esc {
            out.push(c);
            esc = false;
        } else if c == '\\' {
            esc = true;
        } else if c == '"' {
            return Some((out, i + 1));
        } else {
            out.push(c);
        }
    }
    None
}

/// The folder of an uninstaller named in an UninstallString («"C:\…\KurokawaReader\uninstall.exe"» or with
/// arguments after it).
pub fn dir_of_uninstaller(s: &str) -> Option<String> {
    let t = s.trim();
    let exe = if let Some(r) = t.strip_prefix('"') { r.split('"').next()? } else { t.split(" /").next()?.trim() };
    let cut = exe.rfind('\\')?;
    if cut == 0 {
        return None;
    }
    Some(exe[..cut].to_string())
}

/// The copy of KurokawaReader installed now.
#[derive(Debug, Clone, PartialEq)]
pub struct Existing {
    /// "none" | "rust" (this build: Tauri's NSIS installer) | "electron" (the Electron build: replaced, its data kept)
    pub kind: &'static str,
    pub version: String,
    pub dir: String,
}

/// From a `reg export` of HKCU\…\Uninstall: this build's entry (key «KurokawaReader», its InstallLocation or its
/// uninstaller's folder) comes first; else an Electron entry (another key whose DisplayName is KurokawaReader and
/// whose folder holds resources\app.asar — hooks.nsh's own test), else electron-builder's default folder under
/// %LOCALAPPDATA%\Programs when it holds an Electron KurokawaReader. `exists`: whether a file is there.
pub fn find_copy(export: &str, local_appdata: &str, exists: &dyn Fn(&str) -> bool) -> Existing {
    let keys = parse_reg(export);
    if let Some(k) = keys.iter().find(|k| k.name().eq_ignore_ascii_case(PRODUCT) && k.get("DisplayVersion").is_some()) {
        let dir = k
            .get("InstallLocation")
            .map(|s| clean_dir(s))
            .filter(|s| !s.is_empty())
            .or_else(|| k.get("UninstallString").and_then(dir_of_uninstaller))
            .unwrap_or_else(|| format!("{}\\{}", local_appdata.trim_end_matches('\\'), PRODUCT));
        return Existing { kind: "rust", version: k.get("DisplayVersion").unwrap_or("").to_string(), dir };
    }
    find_electron(export, local_appdata, exists)
}

/// The Electron build's install alone, whether or not this build is installed too (after a first install that KEPT
/// it, both are there): an entry whose DisplayName is KurokawaReader under another key, its folder holding
/// resources\app.asar, else electron-builder's default folder → kind "electron", or "none".
pub fn find_electron(export: &str, local_appdata: &str, exists: &dyn Fn(&str) -> bool) -> Existing {
    let keys = parse_reg(export);
    for k in keys.iter() {
        if k.name().eq_ignore_ascii_case(PRODUCT) || !k.get("DisplayName").map(|n| n == PRODUCT).unwrap_or(false) {
            continue;
        }
        let dir = clean_dir(k.get("InstallLocation").unwrap_or(""));
        if !dir.is_empty() && exists(&format!("{}\\resources\\app.asar", dir)) {
            return Existing { kind: "electron", version: k.get("DisplayVersion").unwrap_or("").to_string(), dir };
        }
    }
    let def = format!("{}\\Programs\\{}", local_appdata.trim_end_matches('\\'), PRODUCT);
    if exists(&format!("{}\\resources\\app.asar", def)) {
        return Existing { kind: "electron", version: String::new(), dir: def };
    }
    Existing { kind: "none", version: String::new(), dir: String::new() }
}

/// Whether an installed Electron copy may be replaced (installer/hooks.nsh KR_OLD_DECISION, the same rule): only when
/// its library was handed over — a finished hand-over's marker (%APPDATA%\KurokawaReader\handover\marker.json, written
/// last by the Electron «bridge» build) — or when it has no library (no IndexedDB in its data folder). Otherwise it is
/// kept beside the new program, and the person is told to open it once: it updates itself to the bridge build, which
/// hands the library over and then replaces itself. → "replace" | "keep", or "" when the copy is not Electron's.
pub fn old_decision(kind: &str, handed_over: bool, has_library: bool) -> &'static str {
    if kind != "electron" {
        return "";
    }
    if handed_over || !has_library {
        "replace"
    } else {
        "keep"
    }
}

/// Windows' display language (GetUserDefaultUILanguage's LANGID) → one of the five, or "".
pub fn lang_from_langid(id: u16) -> &'static str {
    match id & 0x3ff {
        0x01 => "ar",
        0x09 => "en",
        0x11 => "ja",
        0x12 => "ko",
        0x04 => "zh",
        _ => "",
    }
}

// ───────────────────────────────── The install as it runs → its step ─────────────────────────────────

/// The four steps the page shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Phase {
    Extract,
    Install,
    Shortcuts,
    Done,
}
impl Phase {
    pub fn name(self) -> &'static str {
        match self {
            Phase::Extract => "extract",
            Phase::Install => "install",
            Phase::Shortcuts => "shortcuts",
            Phase::Done => "done",
        }
    }
}

/// What can be seen, sampled every ~100 ms while the installer runs (main.rs). Tauri's installer, in order: the
/// program's files (KurokawaReader.exe first, then its resources), the uninstaller (uninstall.exe — written new each
/// time), the registry, the shortcuts (Start menu, desktop — written new), the hooks (the Electron copy replaced);
/// then it exits. (The program's own file keeps its build time — NSIS restores it — so only its SIZE says it is
/// being written: truncated, then growing.)
#[derive(Debug, Clone, Default)]
pub struct Obs {
    /// The embedded installer written out to the temporary folder.
    pub extracted: bool,
    /// Milliseconds since the installer was started (0: not yet).
    pub ms: u64,
    /// KurokawaReader.exe's size now (0: not there), its size when the install began, and its final size when known
    /// (the build's, KR_SETUP_APP_BYTES; 0 = unknown).
    pub exe_now: u64,
    pub exe_before: u64,
    pub exe_expected: u64,
    /// uninstall.exe written since the start; the Start-menu shortcut written since the start.
    pub uninst_new: bool,
    pub lnk_new: bool,
    /// The installer's exit code, once it has ended.
    pub exit: Option<i32>,
}

/// The step and percentage for what is seen. Bands: preparing 0–10, copying 10–80, shortcuts and file types 80–99,
/// done 100. Inside a band the bytes written move it where they are known; otherwise time eases it towards (never
/// to) the band's end — so it is never ahead of a real event, and the caller keeps it from going back.
pub fn stage(o: &Obs) -> (Phase, u8) {
    if o.exit == Some(0) {
        return (Phase::Done, 100);
    }
    if !o.extracted {
        return (Phase::Extract, 3);
    }
    if o.ms == 0 {
        return (Phase::Extract, 8);
    }
    if o.uninst_new || o.lnk_new {
        let base = if o.lnk_new { 90.0 } else { 82.0 };
        return (Phase::Shortcuts, (base + 8.0 * ease(o.ms, 1500)).min(99.0) as u8);
    }
    // Copying: by the bytes of the program's file where they can be told apart from what was there before.
    let writing = o.exe_now > 0 && (o.exe_before == 0 || o.exe_now != o.exe_before);
    if o.exe_expected > 0 && writing && o.exe_now <= o.exe_expected {
        let f = o.exe_now as f64 / o.exe_expected as f64;
        return (Phase::Install, (10.0 + 66.0 * f).min(79.0) as u8);
    }
    if o.ms < 250 && !writing {
        return (Phase::Extract, 9);
    }
    (Phase::Install, (12.0 + 64.0 * ease(o.ms, 2500)).min(79.0) as u8)
}

/// 0 → 1 over time, never reaching 1: 1 − e^(−ms/tau).
fn ease(ms: u64, tau: u64) -> f64 {
    1.0 - (-(ms as f64) / tau as f64).exp()
}

/// The installer's exit code → the reason the page puts in words: NSIS ends 1 when the person (or the installer)
/// cancelled, 2 when the script aborted (Tauri's: the app could not be closed, a file could not be written).
pub fn exit_reason(code: i32) -> &'static str {
    match code {
        0 => "",
        1 => "cancelled",
        2 => "aborted",
        _ => "code",
    }
}

/// Versions compared part by part (numbers as numbers): −1, 0, 1.
pub fn cmp_versions(a: &str, b: &str) -> i32 {
    let p = |v: &str| -> Vec<String> { v.trim().trim_start_matches('v').split(['.', '-', '+']).map(|s| s.to_string()).collect() };
    let (x, y) = (p(a), p(b));
    for i in 0..x.len().max(y.len()) {
        let m = x.get(i).cloned().unwrap_or_else(|| "0".into());
        let n = y.get(i).cloned().unwrap_or_else(|| "0".into());
        let o = match (m.parse::<u64>(), n.parse::<u64>()) {
            (Ok(a), Ok(b)) => a.cmp(&b),
            _ => m.cmp(&n),
        };
        if o != std::cmp::Ordering::Equal {
            return if o == std::cmp::Ordering::Less { -1 } else { 1 };
        }
    }
    0
}

/// The "version" of a package.json's text (build.rs: the version shown).
pub fn package_version(json: &str) -> Option<String> {
    let at = json.find("\"version\"")?;
    let rest = &json[at + 9..];
    let colon = rest.find(':')?;
    let rest = rest[colon + 1..].trim_start();
    let rest = rest.strip_prefix('"')?;
    Some(rest[..rest.find('"')?].to_string())
}

/// A string as a JSON string (main.rs's small answers are built by hand where serde_json is not at hand).
pub fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn choices_to_nsis() {
        let c = Choices { dir: r"C:\Users\هناء\AppData\Local\KurokawaReader".into(), desktop: true, assoc: false, old: String::new() };
        let a = nsis_args(&c);
        assert_eq!(a, s(&["/S", "/KRDESK=1", "/KRASSOC=0", r"/D=C:\Users\هناء\AppData\Local\KurokawaReader"]));
        assert_eq!(command_line(&a), r"/S /KRDESK=1 /KRASSOC=0 /D=C:\Users\هناء\AppData\Local\KurokawaReader");
        // (A folder with spaces: /D= unquoted, last; a trailing backslash and quotes taken off.)
        let c = Choices { dir: "\"D:\\My Apps\\KurokawaReader\\\"".into(), desktop: false, assoc: true, old: String::new() };
        assert_eq!(command_line(&nsis_args(&c)), r"/S /KRDESK=0 /KRASSOC=1 /D=D:\My Apps\KurokawaReader");
        // (No folder: the installer's own.)
        assert_eq!(nsis_args(&Choices { dir: "  ".into(), desktop: true, assoc: true, old: String::new() }), s(&["/S", "/KRDESK=1", "/KRASSOC=1"]));
        // (The Electron copy's decision passed before /D=, which NSIS needs last.)
        assert_eq!(nsis_args(&Choices { dir: r"D:\K".into(), desktop: true, assoc: true, old: "keep".into() }), s(&["/S", "/KRDESK=1", "/KRASSOC=1", "/KROLD=keep", r"/D=D:\K"]));
        assert_eq!(nsis_args(&Choices { dir: "".into(), desktop: false, assoc: false, old: "replace".into() }), s(&["/S", "/KRDESK=0", "/KRASSOC=0", "/KROLD=replace"]));
        assert_eq!(nsis_args(&Choices { dir: "".into(), desktop: false, assoc: false, old: "maybe".into() }), s(&["/S", "/KRDESK=0", "/KRASSOC=0"]));
        assert_eq!(clean_dir(r"D:\"), r"D:\");
    }

    #[test]
    fn quoting() {
        assert_eq!(quote("a b"), "\"a b\"");
        assert_eq!(quote(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote(r"C:\dir with space\"), r#""C:\dir with space\\""#);
        assert_eq!(command_line(&s(&["/ARGS", "a b", "/D=C:\\x y"])), r#"/ARGS "a b" /D=C:\x y"#);
    }

    #[test]
    fn passes_through() {
        assert_eq!(passthrough(&s(&[])), None);
        assert_eq!(passthrough(&s(&["--lang", "ar"])), None);
        // (The app's updater: /P /R /UPDATE, and /S /UPDATE at quit.)
        assert_eq!(passthrough(&s(&["/P", "/R", "/UPDATE"])), Some(s(&["/P", "/R", "/UPDATE"])));
        assert_eq!(passthrough(&s(&["/S", "/UPDATE"])), Some(s(&["/S", "/UPDATE"])));
        assert_eq!(passthrough(&s(&["--silent"])), Some(s(&["/S"])));
        assert_eq!(passthrough(&s(&["/D=C:\\x y", "/s", "--inner", "--classic"])).unwrap(), s(&["/s", "/D=C:\\x y"]));
        assert_eq!(inner_arg(&s(&["--inner", "a.exe"])).as_deref(), Some("a.exe"));
        assert_eq!(inner_arg(&s(&["--inner=b.exe"])).as_deref(), Some("b.exe"));
        assert_eq!(inner_arg(&s(&["/S"])), None);
    }

    #[test]
    fn folder_picked() {
        assert_eq!(folder_for_pick(r"D:\Apps"), r"D:\Apps\KurokawaReader");
        assert_eq!(folder_for_pick(r"D:\Apps\"), r"D:\Apps\KurokawaReader");
        assert_eq!(folder_for_pick(r"D:\Apps\kurokawareader"), r"D:\Apps\kurokawareader");
        assert_eq!(folder_for_pick(r"E:\"), r"E:\KurokawaReader");
    }

    #[test]
    fn webview2_and_theme() {
        let found = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}\r\n    pv    REG_SZ    131.0.2903.70\r\n\r\n";
        let zero = "\nHKEY_CURRENT_USER\\...\n    pv    REG_SZ    0.0.0.0\n";
        let empty = "\nHKEY_CURRENT_USER\\...\n    pv    REG_SZ    \n";
        assert_eq!(reg_value(found, "pv").as_deref(), Some("131.0.2903.70"));
        assert_eq!(webview2_version(&[None, Some(zero.into()), Some(found.into())]).as_deref(), Some("131.0.2903.70"));
        assert_eq!(webview2_version(&[Some(zero.into()), Some(empty.into()), None]), None);
        assert_eq!(webview2_version(&[None, None, None]), None);
        // (A name with spaces, "(Default)" in another language.)
        assert_eq!(reg_value("    (Standard)    REG_SZ    x y", "(Standard)").as_deref(), Some("x y"));
        assert_eq!(dark_mode("\nHKEY_CURRENT_USER\\...\\Personalize\n    AppsUseLightTheme    REG_DWORD    0x0\n"), Some(true));
        assert_eq!(dark_mode("    AppsUseLightTheme    REG_DWORD    0x1"), Some(false));
        assert_eq!(dark_mode("ERROR: The system was unable to find the specified registry key or value."), None);
    }

    fn utf16(t: &str) -> Vec<u8> {
        let mut b = vec![0xFF, 0xFE];
        for u in t.encode_utf16() {
            b.extend_from_slice(&u.to_le_bytes());
        }
        b
    }

    const EXPORT: &str = "Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall]\r\n\r\n[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other]\r\n\"DisplayName\"=\"Other app\"\r\n\"NoModify\"=dword:00000001\r\n\"Icon\"=hex(2):43,00,3a,00,5c,00,\\\r\n  41,00,00,00\r\n\r\n";

    #[test]
    fn reg_export_parsed() {
        let text = decode_reg_file(&utf16(&format!("{}[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\KurokawaReader]\r\n\"DisplayName\"=\"KurokawaReader\"\r\n\"DisplayVersion\"=\"0.71.0\"\r\n\"UninstallString\"=\"\\\"C:\\\\Users\\\\هناء\\\\AppData\\\\Local\\\\KurokawaReader\\\\uninstall.exe\\\"\"\r\n@=\"x \\\"q\\\"\"\r\n", EXPORT)));
        let keys = parse_reg(&text);
        assert_eq!(keys.len(), 3);
        assert_eq!(keys[1].get("DisplayName"), Some("Other app"));
        assert_eq!(keys[1].values.len(), 1, "dwords and hex skipped, with their continuation lines");
        assert_eq!(keys[2].name(), "KurokawaReader");
        assert_eq!(keys[2].get(""), Some("x \"q\""));
        let e = find_copy(&text, r"C:\Users\هناء\AppData\Local", &|_| false);
        assert_eq!(e, Existing { kind: "rust", version: "0.71.0".into(), dir: r"C:\Users\هناء\AppData\Local\KurokawaReader".into() });
    }

    #[test]
    fn copies_found() {
        let la = r"C:\Users\A\AppData\Local";
        // None.
        assert_eq!(find_copy(EXPORT, la, &|_| false).kind, "none");
        // The Electron build by its entry (its GUID key), only where its folder holds app.asar.
        let el = format!("{}[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\a1b2-c3]\r\n\"DisplayName\"=\"KurokawaReader\"\r\n\"DisplayVersion\"=\"0.70.2\"\r\n\"InstallLocation\"=\"D:\\\\Old\\\\KurokawaReader\"\r\n", EXPORT);
        let e = find_copy(&el, la, &|p| p == r"D:\Old\KurokawaReader\resources\app.asar");
        assert_eq!(e, Existing { kind: "electron", version: "0.70.2".into(), dir: r"D:\Old\KurokawaReader".into() });
        assert_eq!(find_copy(&el, la, &|_| false).kind, "none", "an entry whose folder is gone is not a copy");
        // electron-builder's default folder with no entry.
        let e = find_copy(EXPORT, la, &|p| p == r"C:\Users\A\AppData\Local\Programs\KurokawaReader\resources\app.asar");
        assert_eq!((e.kind, e.dir.as_str()), ("electron", r"C:\Users\A\AppData\Local\Programs\KurokawaReader"));
        // Both: this build first. InstallLocation preferred to the uninstaller's folder.
        let both = format!("{}[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\KurokawaReader]\r\n\"DisplayVersion\"=\"0.72.0\"\r\n\"InstallLocation\"=\"E:\\\\KR\\\\\"\r\n", el);
        assert_eq!(find_copy(&both, la, &|_| true), Existing { kind: "rust", version: "0.72.0".into(), dir: r"E:\KR".into() });
        // (…and the Electron copy still found beside it — kept by an earlier install: its decision is still made.)
        assert_eq!(find_electron(&both, la, &|p| p == r"D:\Old\KurokawaReader\resources\app.asar").dir, r"D:\Old\KurokawaReader");
        assert_eq!(find_electron(EXPORT, la, &|_| false).kind, "none");
        // Neither location nor uninstaller: the default folder.
        let bare = format!("{}[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\KurokawaReader]\r\n\"DisplayVersion\"=\"0.72.0\"\r\n", EXPORT);
        assert_eq!(find_copy(&bare, la, &|_| false).dir, r"C:\Users\A\AppData\Local\KurokawaReader");
    }

    #[test]
    fn old_copy_decision() {
        // (Replaced only when its library was handed over, or it has none; kept otherwise; nothing for other copies.)
        assert_eq!(old_decision("electron", true, true), "replace");
        assert_eq!(old_decision("electron", false, false), "replace");
        assert_eq!(old_decision("electron", false, true), "keep");
        assert_eq!(old_decision("rust", false, true), "");
        assert_eq!(old_decision("none", true, false), "");
    }

    #[test]
    fn uninstaller_folder() {
        assert_eq!(dir_of_uninstaller("\"C:\\a b\\KurokawaReader\\uninstall.exe\"").as_deref(), Some(r"C:\a b\KurokawaReader"));
        assert_eq!(dir_of_uninstaller(r"C:\x\uninstall.exe /currentuser").as_deref(), Some(r"C:\x"));
        assert_eq!(dir_of_uninstaller("uninstall.exe"), None);
    }

    #[test]
    fn languages() {
        assert_eq!(lang_from_langid(0x0401), "ar"); // Saudi Arabia
        assert_eq!(lang_from_langid(0x0C01), "ar"); // Egypt
        assert_eq!(lang_from_langid(0x0409), "en");
        assert_eq!(lang_from_langid(0x0411), "ja");
        assert_eq!(lang_from_langid(0x0412), "ko");
        assert_eq!(lang_from_langid(0x0804), "zh");
        assert_eq!(lang_from_langid(0x0407), ""); // German: the page's own choice
    }

    #[test]
    fn progress_phases() {
        let mut o = Obs::default();
        assert_eq!(stage(&o), (Phase::Extract, 3));
        o.extracted = true;
        assert_eq!(stage(&o), (Phase::Extract, 8));
        o.ms = 100;
        assert_eq!(stage(&o).0, Phase::Extract, "nothing seen yet, just started");
        // A first install: the program's file appears and grows (its final size known).
        o.exe_expected = 15_000_000;
        o.exe_now = 7_500_000;
        assert_eq!(stage(&o), (Phase::Install, 43));
        o.exe_now = 15_000_000;
        assert_eq!(stage(&o), (Phase::Install, 76));
        // Size unknown: time eases it, below 80.
        o.exe_expected = 0;
        o.ms = 1_000_000;
        assert_eq!(stage(&o), (Phase::Install, 76));
        // An update: the old file the same size as before → not counted as written; time only.
        let u = Obs { extracted: true, ms: 1000, exe_now: 9, exe_before: 9, exe_expected: 9, ..Obs::default() };
        assert_eq!(stage(&u).0, Phase::Install);
        assert!(stage(&u).1 < 40);
        // The uninstaller, then the Start-menu shortcut.
        o.uninst_new = true;
        o.ms = 1;
        let (p, v) = stage(&o);
        assert_eq!(p, Phase::Shortcuts);
        assert!((82..90).contains(&v));
        o.lnk_new = true;
        o.ms = 100_000;
        assert_eq!(stage(&o), (Phase::Shortcuts, 98));
        // Ended well: done, whatever was seen.
        let e = Obs { exit: Some(0), ..Obs::default() };
        assert_eq!(stage(&e), (Phase::Done, 100));
        assert!(Phase::Extract < Phase::Install && Phase::Install < Phase::Shortcuts && Phase::Shortcuts < Phase::Done);
        assert_eq!(Phase::Shortcuts.name(), "shortcuts");
    }

    #[test]
    fn exit_codes() {
        assert_eq!(exit_reason(0), "");
        assert_eq!(exit_reason(1), "cancelled");
        assert_eq!(exit_reason(2), "aborted");
        assert_eq!(exit_reason(5), "code");
    }

    #[test]
    fn versions() {
        assert_eq!(cmp_versions("0.71.0", "0.72.0"), -1);
        assert_eq!(cmp_versions("0.72.0", "0.72"), 0);
        assert_eq!(cmp_versions("0.72.10", "0.72.9"), 1);
        assert_eq!(cmp_versions("v1.0.0", "1.0.0"), 0);
        assert_eq!(package_version("{\n  \"name\": \"kr\",\n  \"version\": \"0.72.0-beta.1\",\n}").as_deref(), Some("0.72.0-beta.1"));
        assert_eq!(package_version("{}"), None);
        assert_eq!(json_str("a\"b\\c\nد"), "\"a\\\"b\\\\c\\nد\"");
    }
}
