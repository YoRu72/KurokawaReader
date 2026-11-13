// The hand-over's pure parts (stage R6a; handover.rs uses them): where the Electron build leaves its hand-over, which
// paths inside it may be read, which folder may be deleted. Std only, so CI tests it alone (rustc --test).
use std::path::{Path, PathBuf};

/// The hand-over format this build reads (desktop/handover.cjs FORMAT).
pub const FORMAT: u64 = 1;
/// The folder's name in Electron's data folder, and its marker (written last: no marker, no hand-over).
pub const DIR: &str = "handover";
pub const MARKER: &str = "marker.json";
/// The pointer the Electron build writes into this build's data folder, and the one beside a portable .exe.
pub const POINTER: &str = "handover-from.json";
pub const PORTABLE_POINTER: &str = "KurokawaReader-handover.json";
/// This build's own record of what became of a hand-over (restored, declined), in its data folder.
pub const STATE: &str = "handover-state.json";
/// Electron's data folder names: the installed app's (its productName) and a bare `electron .` run's (desktop/
/// package.json's name — CI's).
pub const ELECTRON_NAMES: [&str; 2] = ["KurokawaReader", "kurokawa-reader-desktop"];

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

/// Where to look for the hand-over, in order, each once: a folder named by KR_HANDOVER_FROM, the folders the pointers
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

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kr-handoverlogic-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn rel_paths() {
        assert!(safe_rel("books/3/file"));
        assert!(safe_rel("handover/books.jsonl"));
        assert!(safe_rel("marker.json"));
        for bad in ["", "/etc/passwd", "../x", "a/../b", "a//b", "a/./b", "C:/x", "a\\b", "książka", "a b"] {
            assert!(!safe_rel(bad), "{}", bad);
        }
        assert!(!safe_rel(&"a".repeat(300)));
        let d = Path::new("base");
        assert_eq!(join_rel(d, "books/3/file"), Some(Path::new("base").join("books").join("3").join("file")));
        assert_eq!(join_rel(d, "../x"), None);
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
                PathBuf::from("/a").join("KurokawaReader").join("handover"),
                PathBuf::from("/a").join("kurokawa-reader-desktop").join("handover"),
            ]
        );
        assert_eq!(candidates(None, vec![], None), Vec::<PathBuf>::new());
    }

    #[test]
    fn picked_and_deleted() {
        let d = tmp("pick");
        let h = d.join("handover");
        std::fs::create_dir_all(h.join("books").join("0")).unwrap();
        assert!(!deletable(&h), "no marker yet");
        std::fs::write(h.join(MARKER), "{}").unwrap();
        std::fs::write(h.join("books").join("0").join("file"), b"12345").unwrap();
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
}
