//! The Android download queue's decisions (stage M1), rule for rule as `apps/tools/native/android/KtDlRules.java` has
//! them: which name a download takes in a folder where other downloads are under way, whether a hold (Wi-Fi only on
//! mobile data, a low battery) keeps it from starting, what a host is asked next time, whether one resumed while it
//! was still stopping starts again. Java keeps its copy as the reference and the fallback; on a debuggable build with
//! the Rust core present each Java answer is checked against this one (KtCore's shadow mode). Std only: checked alone
//! with `rustc --edition 2021 --test dlrules.rs`; the cases below are tests/native/RuT.java's, one for one.

use std::collections::HashSet;
use std::path::Path;

/// The hold that keeps a download from starting now (the first that applies), or None. `anyway`: the user asked for
/// it now («Download now» on one waiting for Wi-Fi). A reason held by every download (the battery) is said before
/// the Wi-Fi one. `holds` None is Java's null collection.
pub fn hold_of(holds: Option<&[String]>, wifi_only_all: bool, task_wifi_only: bool, anyway: bool) -> Option<String> {
    let holds = match holds {
        Some(h) if !anyway => h,
        _ => return None,
    };
    let mut metered: Option<String> = None;
    for h in holds {
        if !self::holds(h, wifi_only_all, task_wifi_only) {
            continue;
        }
        if h != "metered" {
            return Some(h.clone());
        }
        metered = Some(h.clone());
    }
    metered
}

/// Whether `reason` holds a download: a metered network only those marked Wi-Fi only (or all, by the switch).
pub fn holds(reason: &str, wifi_only_all: bool, task_wifi_only: bool) -> bool {
    reason != "metered" || wifi_only_all || task_wifi_only
}

/// Java's `toLowerCase(Locale.ROOT)` for the names compared here (Rust's full Unicode lower case; both apply the
/// final-sigma rule and İ → i̇ alike).
pub fn lower(s: &str) -> String {
    s.to_lowercase()
}

/// The name a download not yet begun takes in a folder (None: skip it, the file is there). `exists(name)`: whether
/// that name is taken in the folder (a file or a folder). `reserved`: the lower-case names of the other downloads
/// into this folder not finished — never shared, whatever the setting. A file there already: as `conflict` says
/// («skip», «overwrite», anything else renames). A .part there that no other download holds is this one's from
/// before: its name kept.
pub fn pick_name_with(exists: &dyn Fn(&str) -> bool, safe: &str, begun: bool, conflict: &str, reserved: Option<&HashSet<String>>) -> Option<String> {
    if begun {
        return Some(safe.to_string());
    }
    if let Some(r) = reserved {
        if r.contains(&lower(safe)) {
            return Some(free_name_with(exists, safe, reserved));
        }
    }
    if exists(safe) && !exists(&format!("{}.part", safe)) {
        if conflict == "skip" {
            return None;
        }
        if conflict != "overwrite" {
            return Some(free_name_with(exists, safe, reserved));
        }
    }
    Some(safe.to_string())
}

/// «name (2).ext»: the first name not taken (by a file, a .part, or another download's name). Past 9999 tries, the
/// time in milliseconds stands in for the number (as Java's).
pub fn free_name_with(exists: &dyn Fn(&str) -> bool, name: &str, reserved: Option<&HashSet<String>>) -> String {
    let (stem, ext) = split_ext(name);
    for i in 2..10000 {
        let n = format!("{} ({}){}", stem, i, ext);
        if !exists(&n) && !exists(&format!("{}.part", n)) && reserved.map_or(true, |r| !r.contains(&lower(&n))) {
            return n;
        }
    }
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("{} ({}){}", stem, ms, ext)
}

/// Java's `lastIndexOf('.') > 0` split: «.hidden» has no extension, «a.b.c» → («a.b», «.c»).
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(d) if d > 0 => (&name[..d], &name[d..]),
        _ => (name, ""),
    }
}

/// `pick_name_with` on a real folder (File.exists, as KtDlRules does).
pub fn pick_name(dir: &Path, safe: &str, begun: bool, conflict: &str, reserved: Option<&HashSet<String>>) -> Option<String> {
    pick_name_with(&|n: &str| dir.join(n).exists(), safe, begun, conflict, reserved)
}

/// `free_name_with` on a real folder.
pub fn free_name(dir: &Path, name: &str, reserved: Option<&HashSet<String>>) -> String {
    free_name_with(&|n: &str| dir.join(n).exists(), name, reserved)
}

/// What a host is asked next time, after a download that asked `want` connections with `lim` known before (None:
/// none) and ended with `connections`: a refusal keeps what it took; a download that used every connection the limit
/// allowed with no refusal doubles it, up to what is asked.
pub fn next_host_limit(lim: Option<i64>, want: i64, refused: bool, connections: i64) -> Option<i64> {
    if refused {
        return Some(connections.max(1));
    }
    if let Some(l) = lim {
        if l < want && connections >= l {
            return Some(want.min(l * 2));
        }
    }
    lim
}

/// A download resumed while its last run was still stopping: started again when that run ends — unless paused
/// again meanwhile, finished, or removed.
pub fn restart_after_stop(resumed_while_stopping: bool, paused: bool, state: &str) -> bool {
    resumed_while_stopping && !paused && state != "done" && state != "removed" && state != "seeding"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::path::PathBuf;

    fn set(xs: &[&str]) -> HashSet<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }
    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }
    fn s(x: &str) -> Option<String> {
        Some(x.to_string())
    }
    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kt-dlrules-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    // RuT.java's «Names», in its order (the files made between the cases as there).
    #[test]
    fn names() {
        let dir = scratch("names");
        let none = set(&[]);
        let first = set(&["ep.mkv"]);
        assert_eq!(pick_name(&dir, "ep.mkv", false, "rename", Some(&first)), s("ep (2).mkv"), "two of one name, nothing on disk yet");
        assert_eq!(pick_name(&dir, "ep.mkv", false, "rename", Some(&set(&["ep.mkv", "ep (2).mkv"]))), s("ep (3).mkv"), "a third, with (2) taken too");
        assert_eq!(pick_name(&dir, "EP.mkv", false, "rename", Some(&first)), s("EP (2).mkv"), "the other's name in another case");
        assert_eq!(pick_name(&dir, "ep.mkv", false, "overwrite", Some(&first)), s("ep (2).mkv"), "Google Drive's two files of one name, overwrite");
        assert_eq!(pick_name(&dir, "ep.mkv", false, "skip", Some(&first)), s("ep (2).mkv"), "skip: a download under way is not a file there");
        assert_eq!(pick_name(&dir, "ep.mkv", true, "rename", Some(&first)), s("ep.mkv"), "begun already: its name kept");
        assert_eq!(pick_name(&dir, "ep.mkv", false, "rename", Some(&none)), s("ep.mkv"), "alone: its name");
        File::create(dir.join("ep.mkv")).unwrap();
        assert_eq!(pick_name(&dir, "ep.mkv", false, "rename", Some(&none)), s("ep (2).mkv"), "the file there, rename");
        assert_eq!(pick_name(&dir, "ep.mkv", false, "skip", Some(&none)), None, "the file there, skip");
        assert_eq!(pick_name(&dir, "ep.mkv", false, "overwrite", Some(&none)), s("ep.mkv"), "the file there, overwrite");
        File::create(dir.join("ep.mkv.part")).unwrap();
        assert_eq!(pick_name(&dir, "ep.mkv", false, "rename", Some(&none)), s("ep.mkv"), "the file and its own .part: kept");
        std::fs::remove_file(dir.join("ep.mkv")).unwrap();
        assert_eq!(pick_name(&dir, "ep.mkv", false, "rename", Some(&first)), s("ep (2).mkv"), "only another download's .part there");
        assert_eq!(free_name(&dir, "ep.mkv", Some(&set(&["ep (2).mkv"]))), "ep (3).mkv", "a free name passes over files, .parts and names taken");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // RuT.java's «Holds».
    #[test]
    fn hold_cases() {
        let metered = v(&["metered"]);
        let battery = v(&["battery"]);
        let both = v(&["battery", "metered"]);
        assert_eq!(hold_of(Some(&metered), true, false, false), s("metered"), "mobile data, the Wi-Fi only switch on");
        assert_eq!(hold_of(Some(&metered), false, true, false), s("metered"), "mobile data, this download Wi-Fi only");
        assert_eq!(hold_of(Some(&metered), false, false, false), None, "mobile data, neither");
        assert_eq!(hold_of(Some(&battery), false, false, false), s("battery"), "a low battery holds every download");
        assert_eq!(hold_of(Some(&both), false, false, false), s("battery"), "both, not Wi-Fi only: the battery");
        assert_eq!(hold_of(Some(&[]), true, true, false), None, "no hold");
        assert_eq!(hold_of(Some(&both), true, true, true), None, "«download now» asked by the user");
        // (Beyond RuT: Java's null collection, and the order — the battery said first even after the Wi-Fi one.)
        assert_eq!(hold_of(None, true, true, false), None);
        assert_eq!(hold_of(Some(&v(&["metered", "battery"])), true, false, false), s("battery"));
        assert!(holds("battery", false, false));
        assert!(!holds("metered", false, false));
    }

    // RuT.java's «A host's limit after a download».
    #[test]
    fn host_limits() {
        assert_eq!(next_host_limit(None, 8, true, 3), Some(3), "refused: what it took");
        assert_eq!(next_host_limit(Some(6), 8, true, 2), Some(2), "refused again with a limit");
        assert_eq!(next_host_limit(None, 8, false, 8), None, "no limit known, not refused: none kept");
        assert_eq!(next_host_limit(Some(1), 24, false, 1), Some(2), "a limit of 1, every connection used: doubles");
        assert_eq!(next_host_limit(Some(4), 24, false, 4), Some(8), "4 → 8");
        assert_eq!(next_host_limit(Some(16), 24, false, 16), Some(24), "16 → 24 (no more than asked)");
        assert_eq!(next_host_limit(Some(4), 24, false, 2), Some(4), "fewer used than allowed: kept");
        let (mut lim, mut n) = (1i64, 0);
        while lim < 24 && n < 50 {
            lim = next_host_limit(Some(lim), 24, false, lim).unwrap();
            n += 1;
        }
        assert_eq!(n, 5, "downloads from 1 back to 24");
        assert_eq!(next_host_limit(None, 8, true, 0), Some(1), "refused with no connection: at least one");
    }

    // RuT.java's «Resumed while it was still stopping».
    #[test]
    fn restart_cases() {
        assert!(restart_after_stop(true, false, "queued"), "resumed while stopping");
        assert!(!restart_after_stop(true, true, "paused"), "resumed, then paused again");
        assert!(!restart_after_stop(false, false, "paused"), "not resumed");
        assert!(!restart_after_stop(true, false, "removed"), "removed meanwhile");
        assert!(!restart_after_stop(true, false, "done"));
        assert!(!restart_after_stop(true, false, "seeding"));
    }

    #[test]
    fn name_splits() {
        assert_eq!(split_ext("ep.mkv"), ("ep", ".mkv"));
        assert_eq!(split_ext(".hidden"), (".hidden", ""));
        assert_eq!(split_ext("a.b.c"), ("a.b", ".c"));
        assert_eq!(split_ext("noext"), ("noext", ""));
        let ex = |n: &str| n == "x" || n == "x (2)";
        assert_eq!(free_name_with(&ex, "x", None), "x (3)");
        let all = |_: &str| true;
        assert!(free_name_with(&all, "y.txt", None).starts_with("y ("), "past 9999: the time stands in");
    }
}
