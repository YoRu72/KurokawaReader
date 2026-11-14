// The hand-over's pure parts (Tools' stage P9; the Tauri shell's handover.rs uses them), std only, so CI tests it
// alone: `rustc --edition 2021 --test handoverlogic.rs`. An adapted copy of the Reader's
// apps/reader/desktop-tauri/src-tauri/src/handoverlogic.rs (stage R6a) — the same rules, Tools' names (its portable
// pointer, Electron's data folder names «Kurokawa Tools» / «kurokawa-tools-desktop»); tests/shared-copies.cjs keeps the
// functions both copies share the same, names aside. Below them, Tools' own: the download engine's files that cross
// before aria2c first starts here (so a paused or running download goes on where it stopped), aria2's session with
// the downloads that were moving before the hand-over set going again, and the keep/replace rule for an Electron
// install found beside this one.
#![allow(dead_code)]
use std::path::{Path, PathBuf};

/// The hand-over format this build reads (desktop/handover.cjs FORMAT).
pub const FORMAT: u64 = 1;
/// The folder's name in Electron's data folder, and its marker (written last: no marker, no hand-over).
pub const DIR: &str = "handover";
pub const MARKER: &str = "marker.json";
/// The pointer the Electron build writes into this build's data folder, and the one beside a portable .exe.
pub const POINTER: &str = "handover-from.json";
pub const PORTABLE_POINTER: &str = "KurokawaTools-handover.json";
/// This build's own record of what became of a hand-over (restored, declined), in its data folder.
pub const STATE: &str = "handover-state.json";
/// Electron's data folder names: the installed app's (its productName) and a bare `electron .` run's (desktop/
/// package.json's name — CI's).
pub const ELECTRON_NAMES: [&str; 2] = ["Kurokawa Tools", "kurokawa-tools-desktop"];
/// The marker's `app` (desktop/handover.cjs APP).
pub const APP: &str = "KurokawaTools";

/// A path inside the hand-over: plain ASCII names joined by «/», nothing that climbs out (handover.cjs safeRel).
pub fn safe_rel(rel: &str) -> bool {
    !rel.is_empty()
        && rel.len() < 300
        && rel.split('/').all(|s| {
            !s.is_empty() && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        })
}

/// A safe path inside `dir`, or None.
pub fn join_rel(dir: &Path, rel: &str) -> Option<PathBuf> {
    if !safe_rel(rel) {
        return None;
    }
    let mut p = dir.to_path_buf();
    for s in rel.split('/') {
        p.push(s);
    }
    Some(p)
}

/// Electron's appData (app.getPath('appData')): %APPDATA% on Windows, ~/Library/Application Support on a Mac,
/// $XDG_CONFIG_HOME or ~/.config on Linux. `get` reads an environment variable (empty counts as missing).
pub fn electron_app_data(os: &str, get: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let some = |k: &str| get(k).filter(|v| !v.is_empty());
    match os {
        "windows" => some("APPDATA").map(PathBuf::from),
        "macos" => some("HOME").map(|h| PathBuf::from(h).join("Library").join("Application Support")),
        _ => some("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| some("HOME").map(|h| PathBuf::from(h).join(".config"))),
    }
}

/// Where to look for the hand-over, in order, each once: a folder named by KT_HANDOVER_FROM, the folders the pointers
/// name, then <Electron's appData>/<each of its names>/handover.
pub fn candidates(over: Option<PathBuf>, pointed: Vec<PathBuf>, app_data: Option<PathBuf>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut add = |p: PathBuf| {
        if !out.iter().any(|x| x == &p) {
            out.push(p);
        }
    };
    if let Some(p) = over {
        add(resolve_given(&p));
    }
    for p in pointed {
        add(p);
    }
    if let Some(a) = app_data {
        for n in ELECTRON_NAMES.iter() {
            add(a.join(n).join(DIR));
        }
    }
    out
}

/// A folder the reader picked: itself when it holds the marker, else its `handover` folder (Electron's data folder
/// picked), else itself.
pub fn resolve_given(p: &Path) -> PathBuf {
    if p.join(MARKER).is_file() {
        return p.to_path_buf();
    }
    let inner = p.join(DIR);
    if inner.join(MARKER).is_file() {
        return inner;
    }
    p.to_path_buf()
}

/// Only a hand-over folder may be deleted («Free the space»): named `handover`, holding its marker.
pub fn deletable(dir: &Path) -> bool {
    dir.file_name().map(|n| n == DIR).unwrap_or(false) && dir.join(MARKER).is_file()
}

/// The bytes a folder holds (its files, all the way down).
pub fn folder_size(dir: &Path) -> u64 {
    let mut n = 0u64;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            match e.file_type() {
                Ok(t) if t.is_dir() => n += folder_size(&p),
                Ok(t) if t.is_file() => n += e.metadata().map(|m| m.len()).unwrap_or(0),
                _ => {}
            }
        }
    }
    n
}

/* ---------- Tools' own: the download engine's files ---------- */

/// The engine's files as the hand-over carries them (desktop/handover.cjs ENGINE_FILES) → the name each has in this
/// build's data folder (engine.rs and vtjobs.rs read the same names: aria2's session, the app's notes on each download,
/// the engine's settings, the DHT's known nodes, the video tools' jobs).
pub const ENGINE_FILES: [(&str, &str); 6] = [
    ("engine/aria2.session", "aria2.session"),
    ("engine/tasks.json", "tasks.json"),
    ("engine/aria2-config.json", "aria2-config.json"),
    ("engine/dht.dat", "dht.dat"),
    ("engine/dht6.dat", "dht6.dat"),
    ("engine/video-jobs.json", "video-jobs.json"),
];
/// The downloads that were moving (active or waiting) when the bridge build paused the engine: aria2 ids, one JSON
/// array (desktop/handover.cjs). Not copied: it decides which of the session's entries go on by themselves.
pub const ENGINE_MOVING: &str = "engine/moving.json";
/// Written in this build's data folder once the engine's files came over (or were found not wanted): never twice.
pub const ENGINE_DONE: &str = "handover-engine.json";

/// Whether this build's engine has nothing of its own yet, so the hand-over's engine files may be put in place: no
/// notes on any download (tasks.json), no session with an entry, no video job. (A build that already ran with
/// downloads keeps its own; the hand-over's downloads are then not carried — they stay in the old data folder.)
pub fn engine_target_empty(tasks_json: Option<&str>, session: Option<&str>, video_jobs: Option<&str>) -> bool {
    let blank_obj = |t: Option<&str>| match t {
        None => true,
        Some(s) => {
            let s = s.trim();
            s.is_empty() || s == "{}"
        }
    };
    let blank_arr = |t: Option<&str>| match t {
        None => true,
        Some(s) => {
            let s = s.trim();
            s.is_empty() || s == "[]"
        }
    };
    blank_obj(tasks_json) && session.map(|s| session_gids(s).is_empty() && s.trim().is_empty()).unwrap_or(true) && blank_arr(video_jobs)
}

/// aria2's session file, entry by entry: an entry is a line of URIs (not indented) followed by its options, each on a
/// line that starts with a space (« gid=…», « dir=…», « pause=true»). → each entry's gid, in order.
pub fn session_gids(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let l = line.trim_end_matches('\r');
        if let Some(rest) = l.strip_prefix(' ').or_else(|| l.strip_prefix('\t')) {
            if let Some(g) = rest.trim_start().strip_prefix("gid=") {
                out.push(g.trim().to_string());
            }
        }
    }
    out
}

/// The session with « pause=true» taken off the entries whose gid is in `moving` — the downloads the bridge build
/// paused only to hand them over, so they go on by themselves here, as they did there. Every other line kept as it
/// was (a download the person had paused stays paused); the line endings kept.
pub fn session_unpause(text: &str, moving: &[String]) -> String {
    // (An entry's gid can come after its pause line: the entry is gathered first, then written.)
    let mut out = String::with_capacity(text.len());
    let mut entry: Vec<&str> = Vec::new();
    let flush = |entry: &mut Vec<&str>, out: &mut String| {
        if entry.is_empty() {
            return;
        }
        let gid = entry.iter().find_map(|l| {
            let t = l.trim_end_matches(['\r', '\n']);
            t.strip_prefix(' ').or_else(|| t.strip_prefix('\t')).and_then(|r| r.trim_start().strip_prefix("gid=")).map(|g| g.trim().to_string())
        });
        let go = gid.map(|g| moving.iter().any(|m| m == &g)).unwrap_or(false);
        for l in entry.iter() {
            let t = l.trim_end_matches(['\r', '\n']);
            let is_pause = t.starts_with(' ') || t.starts_with('\t');
            if go && is_pause && t.trim() == "pause=true" {
                continue;
            }
            out.push_str(l);
        }
        entry.clear();
    };
    for l in text.split_inclusive('\n') {
        let t = l.trim_end_matches(['\r', '\n']);
        let option = t.starts_with(' ') || t.starts_with('\t');
        if !option && !t.is_empty() {
            flush(&mut entry, &mut out);
        }
        entry.push(l);
    }
    flush(&mut entry, &mut out);
    out
}

/// What the gids file says → the ids (anything not a short hex id left out).
pub fn parse_moving(json: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut s = json.trim();
    if !(s.starts_with('[') && s.ends_with(']')) {
        return out;
    }
    s = &s[1..s.len() - 1];
    for part in s.split(',') {
        let p = part.trim().trim_matches('"');
        if !p.is_empty() && p.len() <= 16 && p.chars().all(|c| c.is_ascii_hexdigit()) {
            out.push(p.to_ascii_lowercase());
        }
    }
    out
}

/// The screen translator's fonts in the hand-over: each file at shell/screen-fonts/<n>, their own names listed here
/// (desktop/handover.cjs shellFiles).
pub const FONTS_INDEX: &str = "shell/screen-fonts.json";

/// A font's own name, to be a file in this build's screen-fonts folder: one name (no folder, no «..», no character
/// Windows refuses), not empty, not too long.
pub fn font_name_ok(name: &str) -> bool {
    let n = name.trim();
    !n.is_empty()
        && n == name
        && name.chars().count() <= 200
        && name != "."
        && name != ".."
        && !name.starts_with('.')
        && !name.chars().any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 32)
}

/* ---------- Tools' own: the Electron install found beside this one ---------- */

/// Whether the Electron copy's data folder holds anything of the person's: its web storage (the settings, the lists),
/// its database (add-ons, history), or the engine's notes on downloads. (A copy installed and never opened has none.)
pub fn electron_has_data(local_storage: bool, indexed_db: bool, tasks_json: bool) -> bool {
    local_storage || indexed_db || tasks_json
}

/// Whether an Electron Tools found beside this build may be replaced (installer/hooks.nsh KR_OLD_DECISION and the
/// setup program use the same rule): only when its data was handed over (a finished hand-over's marker in its data
/// folder) or it has none; otherwise it is kept, so nothing of the person's is left behind with no program to read it.
pub fn old_decision(handed_over: bool, has_data: bool) -> &'static str {
    if handed_over || !has_data {
        "replace"
    } else {
        "keep"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kt-handoverlogic-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn rel_paths() {
        assert!(safe_rel("engine/aria2.session"));
        assert!(safe_rel("handover/local.json"));
        assert!(safe_rel("marker.json"));
        for bad in ["", "/etc/passwd", "../x", "a/../b", "a//b", "a/./b", "C:/x", "a\\b", "książka", "a b"] {
            assert!(!safe_rel(bad), "{}", bad);
        }
        assert!(!safe_rel(&"a".repeat(300)));
        let d = Path::new("base");
        assert_eq!(join_rel(d, "engine/tasks.json"), Some(Path::new("base").join("engine").join("tasks.json")));
        assert_eq!(join_rel(d, "../x"), None);
        for (rel, name) in ENGINE_FILES.iter() {
            assert!(safe_rel(rel) && !name.contains('/'), "{}", rel);
        }
    }

    #[test]
    fn electron_folders() {
        let env = |pairs: Vec<(&'static str, &'static str)>| move |k: &str| pairs.iter().find(|(a, _)| *a == k).map(|(_, v)| v.to_string());
        let w = env(vec![("APPDATA", "C:\\Users\\u\\AppData\\Roaming")]);
        assert_eq!(electron_app_data("windows", &w), Some(PathBuf::from("C:\\Users\\u\\AppData\\Roaming")));
        assert_eq!(electron_app_data("windows", &env(vec![])), None);
        let m = env(vec![("HOME", "/Users/u")]);
        assert_eq!(electron_app_data("macos", &m), Some(PathBuf::from("/Users/u/Library/Application Support")));
        let l = env(vec![("HOME", "/home/u"), ("XDG_CONFIG_HOME", "")]);
        assert_eq!(electron_app_data("linux", &l), Some(PathBuf::from("/home/u/.config")));
        let x = env(vec![("HOME", "/home/u"), ("XDG_CONFIG_HOME", "/cfg")]);
        assert_eq!(electron_app_data("linux", &x), Some(PathBuf::from("/cfg")));
    }

    #[test]
    fn where_to_look() {
        let c = candidates(Some(PathBuf::from("/nowhere/x")), vec![PathBuf::from("/p/handover"), PathBuf::from("/p/handover")], Some(PathBuf::from("/a")));
        assert_eq!(
            c,
            vec![
                PathBuf::from("/nowhere/x"),
                PathBuf::from("/p/handover"),
                PathBuf::from("/a").join("Kurokawa Tools").join("handover"),
                PathBuf::from("/a").join("kurokawa-tools-desktop").join("handover"),
            ]
        );
        assert_eq!(candidates(None, vec![], None), Vec::<PathBuf>::new());
    }

    #[test]
    fn picked_and_deleted() {
        let d = tmp("pick");
        let h = d.join("handover");
        std::fs::create_dir_all(h.join("engine")).unwrap();
        assert!(!deletable(&h), "no marker yet");
        std::fs::write(h.join(MARKER), "{}").unwrap();
        std::fs::write(h.join("engine").join("tasks.json"), b"12345").unwrap();
        assert_eq!(resolve_given(&d), h);
        assert_eq!(resolve_given(&h), h);
        assert!(deletable(&h));
        assert!(!deletable(&d), "only a folder named handover");
        assert_eq!(folder_size(&h), 7);
        let other = d.join("handover.part");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join(MARKER), "{}").unwrap();
        assert!(!deletable(&other));
        let _ = std::fs::remove_dir_all(&d);
    }

    const SESSION: &str = "https://example.test/a.bin\n dir=/home/u/Downloads/Kurokawa\n gid=00a1b2c3d4e5f601\n pause=true\n out=a.bin\n/home/u/Downloads/Kurokawa/0123abcd.torrent\n dir=/home/u/Downloads/Kurokawa\n pause=true\n gid=00a1b2c3d4e5f602\n select-file=1,2\nhttps://example.test/c.bin\thttps://mirror.test/c.bin\n gid=00a1b2c3d4e5f603\n pause=true\n";

    #[test]
    fn session_entries() {
        assert_eq!(session_gids(SESSION), vec!["00a1b2c3d4e5f601", "00a1b2c3d4e5f602", "00a1b2c3d4e5f603"]);
        assert!(session_gids("").is_empty());
        // (The two that were moving go on; the one the person had paused stays paused; nothing else changes.)
        let out = session_unpause(SESSION, &["00a1b2c3d4e5f601".to_string(), "00a1b2c3d4e5f602".to_string()]);
        assert_eq!(out, SESSION.replacen(" pause=true\n out=a.bin", " out=a.bin", 1).replacen(" pause=true\n gid=00a1b2c3d4e5f602", " gid=00a1b2c3d4e5f602", 1));
        assert_eq!(out.matches("pause=true").count(), 1);
        assert!(out.contains("gid=00a1b2c3d4e5f603\n pause=true\n"));
        assert_eq!(session_unpause(SESSION, &[]), SESSION);
        // (Windows' line ends kept; a session without a final line end kept so.)
        let crlf = SESSION.replace('\n', "\r\n");
        let o2 = session_unpause(&crlf, &["00a1b2c3d4e5f603".to_string()]);
        assert!(o2.ends_with("gid=00a1b2c3d4e5f603\r\n"));
        assert_eq!(o2.matches("pause=true").count(), 2);
        assert_eq!(session_unpause("u\n gid=ab\n pause=true", &["ab".to_string()]), "u\n gid=ab\n");
    }

    #[test]
    fn moving_and_empty() {
        assert_eq!(parse_moving("[\"00A1\", \"zz\", \"00b2\"]"), vec!["00a1", "00b2"]);
        assert!(parse_moving("{}").is_empty());
        assert!(engine_target_empty(None, None, None));
        assert!(engine_target_empty(Some("{}"), Some(""), Some("[]")));
        assert!(!engine_target_empty(Some("{\"ab\":{}}"), None, None));
        assert!(!engine_target_empty(None, Some(SESSION), None));
        assert!(!engine_target_empty(None, None, Some("[{\"id\":\"v1\"}]")));
    }

    #[test]
    fn old_copy() {
        assert_eq!(old_decision(true, true), "replace");
        assert_eq!(old_decision(false, false), "replace");
        assert_eq!(old_decision(false, true), "keep");
        assert!(electron_has_data(true, false, false));
        assert!(!electron_has_data(false, false, false));
    }

    #[test]
    fn font_names() {
        assert!(font_name_ok("1700000000000-My Font.ttf"));
        assert!(font_name_ok("1700000000000-خط النسخ.otf"));
        for bad in ["", " a.ttf", "a.ttf ", "..", ".hidden", "a/b.ttf", "a\\b.ttf", "C:x.ttf", "a\u{7}.ttf"] {
            assert!(!font_name_ok(bad), "{:?}", bad);
        }
        assert!(!font_name_ok(&"x".repeat(201)));
    }
}
