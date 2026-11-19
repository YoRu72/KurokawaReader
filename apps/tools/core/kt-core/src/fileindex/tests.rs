//! The file index's tests: in-memory fixtures for the folding, the queries and the changes; made-up trees in a
//! temporary folder (KT_TEST_TMP when set, else the system's temp folder — never a user's folder) for the walk, the
//! file and the watchers. The 1,000,000-entry timing is `#[ignore]`d (run with `--ignored --nocapture`, built -O).
use super::fold::{ext_of, fold};
use super::persist::{checksum, LoadError, MAGIC};
use super::query::glob_match;
use super::store::NONE;
use super::watch::parse_notify;
use super::*;
use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// ---- helpers ----

static SEQ: AtomicU32 = AtomicU32::new(0);

struct Tmp(PathBuf);
impl Tmp {
    fn new(tag: &str) -> Tmp {
        let base = std::env::var_os("KT_TEST_TMP").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        let p = base.join(format!("kt-fileindex-{}-{}-{}", tag, std::process::id(), SEQ.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        // The canonical form, so the paths the watchers report compare equal.
        Tmp(std::fs::canonicalize(&p).unwrap())
    }
    fn p(&self, rel: &str) -> PathBuf {
        let mut x = self.0.clone();
        for c in rel.split('/') {
            x.push(c);
        }
        x
    }
    fn file(&self, rel: &str, bytes: usize) -> PathBuf {
        let p = self.p(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, vec![b'x'; bytes]).unwrap();
        p
    }
    fn dir(&self, rel: &str) -> PathBuf {
        let p = self.p(rel);
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn root(p: &str) -> PathBuf {
    if cfg!(windows) { PathBuf::from(format!("C:\\{}", p.replace('/', "\\"))) } else { PathBuf::from(format!("/{p}")) }
}
fn file(size: u64, mtime: i64) -> Meta {
    Meta { size, mtime, is_dir: false, is_link: false }
}
fn dirm() -> Meta {
    Meta { is_dir: true, ..Meta::default() }
}

/// A fixture index: one root «/r» (or C:\r) with the given relative paths (a trailing slash makes a folder).
fn fixture(paths: &[&str]) -> Index {
    let mut ix = Index::new();
    ix.add_root(RootSpec { path: root("r"), ..RootSpec::default() }).unwrap();
    for (n, p) in paths.iter().enumerate() {
        add_path(&mut ix, &root("r"), p, file(100 * (n as u64 + 1), 1_000 + n as i64));
    }
    ix
}

fn add_path(ix: &mut Index, base: &Path, rel: &str, meta: Meta) {
    let is_dir = rel.ends_with('/');
    let parts: Vec<&str> = rel.trim_end_matches('/').split('/').collect();
    let mut cur = ix.find(base).unwrap();
    for (i, part) in parts.iter().enumerate() {
        let last = i == parts.len() - 1;
        cur = match ix.find_child(cur, part.as_bytes()) {
            Some(c) => c,
            None => {
                let m = if last && !is_dir { meta } else { dirm() };
                ix.insert(cur, OsStr::new(part), m).unwrap()
            }
        };
    }
}

fn names(r: &QueryResult) -> Vec<String> {
    r.hits.iter().map(|h| h.name.clone()).collect()
}

fn q(ix: &Index, text: &str) -> QueryResult {
    let s = Searcher::new();
    ix.search(&Query::text(text), &s.begin()).unwrap()
}

fn qq(ix: &Index, query: Query) -> QueryResult {
    let s = Searcher::new();
    ix.search(&query, &s.begin()).unwrap()
}

fn rel(ix: &Index, p: &Path) -> Option<String> {
    let rest = p.strip_prefix(root("r")).ok()?;
    let _ = ix;
    Some(rest.to_string_lossy().replace('\\', "/"))
}

fn all_paths(ix: &Index) -> Vec<String> {
    let mut v: Vec<String> = q(ix, "").hits.iter().map(|h| h.path.to_string_lossy().replace('\\', "/")).collect();
    v.sort();
    v
}

fn wait_until(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        if f() {
            return;
        }
        std::thread::park_timeout(Duration::from_millis(20));
    }
    panic!("timed out waiting for {what}");
}

// ---- folding ----

#[test]
fn folding_unicode() {
    assert_eq!(fold("Report.PDF"), "report.pdf");
    // Composed, decomposed and plain Latin are one.
    assert_eq!(fold("Café"), "cafe");
    assert_eq!(fold("Cafe\u{301}"), "cafe");
    assert_eq!(fold("ÑANDÚ Şişli Ā"), "nandu sisli a");
    assert_eq!(fold("İstanbul"), "istanbul");
    assert_eq!(fold("STRASSE"), "strasse");
    // Arabic: vowel marks, shadda, tatweel dropped; hamza forms of alef are alef; ة and ى stay.
    assert_eq!(fold("كِتَابٌ"), "كتاب");
    assert_eq!(fold("مـــدرسة"), "مدرسة");
    assert_eq!(fold("أحمد إبراهيم آمال"), "احمد ابراهيم امال");
    assert_eq!(fold("ا\u{654}حمد"), "احمد"); // alef + hamza above (decomposed أ)
    assert_eq!(fold("مؤمن"), "مومن");
    assert_eq!(fold("مسؤول"), fold("مسو\u{654}ول"));
    assert_ne!(fold("مدرسة"), fold("مدرسه"));
    assert_ne!(fold("على"), fold("علي"));
    // Japanese: decomposed kana compose, the voiced kana stay distinct from the plain ones.
    assert_eq!(fold("か\u{3099}"), "が");
    assert_eq!(fold("ハ\u{309A}ン"), "パン");
    assert_eq!(fold("ウ\u{3099}"), "ヴ");
    assert_ne!(fold("が"), fold("か"));
    assert_eq!(fold("東京タワー"), "東京タワー");
    // Full width ASCII.
    assert_eq!(fold("ＡＢＣ１２３"), "abc123");
    // Greek and Cyrillic lower case.
    assert_eq!(fold("ΑΘΗΝΑ Москва"), "αθηνα москва");
    assert_eq!(ext_of("a.tar.gz"), "gz");
    assert_eq!(ext_of(".bashrc"), "");
    assert_eq!(ext_of("noext"), "");
}

#[test]
fn glob_semantics() {
    let g = |p: &str, n: &str| glob_match(fold(p).as_bytes(), fold(n).as_bytes());
    assert!(g("*.mp4", "Movie.MP4"));
    assert!(!g("*.mp4", "movie.mp4.part"));
    assert!(g("a?c", "abc"));
    assert!(!g("a?c", "abbc"));
    assert!(g("a*c", "abbbbc"));
    assert!(g("*", ""));
    assert!(g("*a*b*", "xxaxxbxx"));
    assert!(!g("*a*b", "xxaxxbxx"));
    assert!(g("?", "ك")); // one Arabic letter is one character
    assert!(g("??", "東京"));
    assert!(!g("?", "東京"));
    assert!(g("ep??.mkv", "EP01.mkv"));
    assert!(g("*مدرسة*", "صور المدرسة.jpg"));
}

// ---- queries ----

fn sample() -> Index {
    fixture(&[
        "videos/Report.mp4",
        "videos/report",
        "docs/report.pdf",
        "docs/Reports 2024.xlsx",
        "docs/annual_report.docx",
        "docs/misreported.txt",
        "music/Song of Report.flac",
        "photos/صور المدرسة.jpg",
        "photos/كِتَاب.png",
        "photos/東京タワー.heic",
        "photos/Café.jpg",
        "projects/",
        "projects/report/",
        "projects/report/notes.md",
        "archive/old.zip",
    ])
}

#[test]
fn words_all_must_match_and_unicode() {
    let ix = sample();
    let r = q(&ix, "report 2024");
    assert_eq!(names(&r), vec!["Reports 2024.xlsx"]);
    assert_eq!(names(&q(&ix, "REPORT xlsx")), vec!["Reports 2024.xlsx"]);
    assert_eq!(names(&q(&ix, "كتاب")), vec!["كِتَاب.png"]);
    assert_eq!(names(&q(&ix, "المدرسة")), vec!["صور المدرسة.jpg"]);
    assert_eq!(names(&q(&ix, "タワー")), vec!["東京タワー.heic"]);
    assert_eq!(names(&q(&ix, "cafe")), vec!["Café.jpg"]);
    assert_eq!(names(&q(&ix, "CAFÉ")), vec!["Café.jpg"]);
    assert_eq!(names(&q(&ix, "\"of report\"")), vec!["Song of Report.flac"]);
    assert!(q(&ix, "nothing-like-this").hits.is_empty());
    // Wildcards match the whole name.
    let mut v = names(&q(&ix, "*.jpg"));
    v.sort();
    assert_eq!(v, vec!["Café.jpg", "صور المدرسة.jpg"]);
    assert_eq!(names(&q(&ix, "rep?rt.pdf")), vec!["report.pdf"]);
    // An empty query lists everything (no roots).
    assert_eq!(q(&ix, "").total, 20);
}

#[test]
fn path_ext_kind_and_filters() {
    let ix = sample();
    let mut v = names(&q(&ix, "report path:docs"));
    v.sort();
    assert_eq!(v, vec!["Reports 2024.xlsx", "annual_report.docx", "misreported.txt", "report.pdf"]);
    // A word with a slash is a path term; it may span the folder and the name.
    assert_eq!(names(&q(&ix, "docs/report.p")), vec!["report.pdf"]);
    assert_eq!(names(&q(&ix, "projects/report/")), vec!["notes.md"]);
    assert_eq!(names(&q(&ix, "report ext:pdf,docx")).len(), 2);
    assert_eq!(names(&q(&ix, "ext:.FLAC")), vec!["Song of Report.flac"]);
    // «videos/report» is a file with no extension; «projects/report» is the folder.
    let k = q(&ix, "report kind:folder");
    assert_eq!(names(&k), vec!["report"]);
    assert!(k.hits[0].is_dir);
    assert_eq!(names(&q(&ix, "kind:archive")), vec!["old.zip"]);
    let pics = qq(&ix, Query { kinds: vec![Kind::Picture], ..Query::default() });
    assert_eq!(pics.total, 4);
    // Sizes: the fixture gives entry n the size 100·(n+1): report.pdf is 300, Reports 2024.xlsx 400.
    let r = qq(&ix, Query { text: "report".into(), size_min: Some(300), size_max: Some(400), ..Query::default() });
    let mut v = names(&r);
    v.sort();
    assert_eq!(v, vec!["Reports 2024.xlsx", "report.pdf"]);
    // A size filter leaves folders out.
    let r = qq(&ix, Query { text: "report".into(), size_min: Some(0), ..Query::default() });
    assert!(r.total == 7 && r.hits.iter().all(|h| !h.is_dir));
    let r = qq(&ix, Query { text: "report".into(), mtime_min: Some(1_002), mtime_max: Some(1_003), ..Query::default() });
    let mut v = names(&r);
    v.sort();
    assert_eq!(v, vec!["Reports 2024.xlsx", "report.pdf"]);
    let r = qq(&ix, Query { exts: vec!["JPG".into()], path_contains: vec!["PHOTOS".into()], ..Query::default() });
    assert_eq!(r.total, 2);
}

#[test]
fn relevance_order() {
    let ix = fixture(&[
        "a/misreported.txt",
        "a/annual_report.docx",
        "a/reports-old.txt",
        "a/report.pdf",
        "a/report",
        "a/reportage.txt",
        "a/my report.txt",
    ]);
    let r = q(&ix, "report");
    assert_eq!(names(&r), vec![
        "report",              // exact
        "report.pdf",          // the name without its extension
        "reportage.txt",       // a prefix, shorter first
        "reports-old.txt",
        "my report.txt",       // a word's start, shorter first
        "annual_report.docx",
        "misreported.txt",     // anywhere
    ]);
}

#[test]
fn cap_total_and_sorting() {
    let mut paths = Vec::new();
    let owned: Vec<String> = (0..500).map(|i| format!("d{}/file{:03}.txt", i % 7, i)).collect();
    for p in &owned {
        paths.push(p.as_str());
    }
    let ix = fixture(&paths);
    let r = qq(&ix, Query { text: "file".into(), limit: 10, ..Query::default() });
    assert_eq!(r.total, 500);
    assert_eq!(r.hits.len(), 10);
    assert_eq!(r.hits[0].name, "file000.txt");
    assert_eq!(r.hits[9].name, "file009.txt");
    // The kept-best scan gives what ranking everything gives.
    let all = qq(&ix, Query { text: "file00".into(), limit: 1000, ..Query::default() });
    let top = qq(&ix, Query { text: "file00".into(), limit: 4, ..Query::default() });
    assert_eq!(names(&top), names(&all)[..4].to_vec());
    let worst = qq(&ix, Query { text: "file00".into(), limit: 2, descending: true, ..Query::default() });
    let mut rev = names(&all);
    rev.reverse();
    assert_eq!(names(&worst), rev[..2].to_vec());
    let r = qq(&ix, Query { text: "file".into(), limit: 3, sort: SortKey::Size, descending: true, ..Query::default() });
    assert_eq!(names(&r), vec!["file499.txt", "file498.txt", "file497.txt"]);
    let r = qq(&ix, Query { text: "file".into(), limit: 2, sort: SortKey::Modified, ..Query::default() });
    assert_eq!(names(&r), vec!["file000.txt", "file001.txt"]);
    let r = qq(&ix, Query { text: "file".into(), limit: 3, sort: SortKey::Name, descending: true, ..Query::default() });
    assert_eq!(names(&r), vec!["file499.txt", "file498.txt", "file497.txt"]);
    // Path order: folder d0 first (files 0, 7, 14 …), by name inside it.
    let r = qq(&ix, Query { text: "file".into(), limit: 3, sort: SortKey::Path, ..Query::default() });
    assert_eq!(names(&r), vec!["file000.txt", "file007.txt", "file014.txt"]);
    let r = qq(&ix, Query { text: "file".into(), limit: 1, sort: SortKey::Path, descending: true, ..Query::default() });
    assert_eq!(names(&r), vec!["file496.txt"]); // d6's last
    let h = &r.hits[0];
    assert_eq!(rel(&ix, &h.path).unwrap(), "d6/file496.txt");
}

#[test]
fn superseded_query_is_cancelled() {
    let ix = sample();
    let s = Searcher::new();
    let first = s.begin();
    let second = s.begin();
    assert!(!first.is_current());
    assert_eq!(ix.search(&Query::text("report"), &first).unwrap_err(), Cancelled);
    assert!(ix.search(&Query::text("report"), &second).is_ok());
    s.cancel_all();
    assert_eq!(ix.search(&Query::text("report"), &second).unwrap_err(), Cancelled);
    // Mid-scan: another thread begins a newer query while a long one runs; the long one stops.
    let mut big = Index::new();
    big.add_root(RootSpec { path: root("big"), ..RootSpec::default() }).unwrap();
    let top = big.find(&root("big")).unwrap();
    for i in 0..400_000u32 {
        big.insert(top, OsStr::new(&format!("entry {i} abcdefghij")), file(1, 1)).unwrap();
    }
    let s = Searcher::new();
    let s2 = s.clone();
    let t = s.begin();
    let h = std::thread::spawn(move || {
        std::thread::park_timeout(Duration::from_millis(1));
        s2.begin()
    });
    // Glob work over 400k names lasts long enough for the other thread to begin, on any machine; when the machine is
    // so fast that the query ended first, it must at least have been current to the end.
    let r = big.search(&Query::text("*j*j*j*j*j*q"), &t);
    let _newer = h.join().unwrap();
    match r {
        Err(Cancelled) => {}
        Ok(res) => assert_eq!(res.total, 0),
    }
}

// ---- changes ----

#[test]
fn apply_each_change_kind() {
    let mut ix = fixture(&["a/one.txt", "a/sub/two.txt", "a/sub/deep/three.txt", "b/"]);
    let r = root("r");
    let p = |s: &str| {
        let mut x = r.clone();
        for c in s.split('/') {
            x.push(c);
        }
        x
    };
    // Created (file, then folder: a folder asks for its walk).
    assert_eq!(ix.apply(&Change::Created { path: p("a/new.txt"), meta: file(5, 9) }), Applied::Done);
    assert_eq!(ix.apply(&Change::Created { path: p("a/new.txt"), meta: file(5, 9) }), Applied::Ignored);
    assert_eq!(ix.apply(&Change::Created { path: p("a/newdir"), meta: dirm() }), Applied::Rescan(vec![p("a/newdir")]));
    // A change in a folder not indexed: walk the nearest one that is.
    assert_eq!(ix.apply(&Change::Created { path: p("a/nowhere/x.txt"), meta: file(1, 1) }), Applied::Rescan(vec![p("a")]));
    // Outside every root.
    assert_eq!(ix.apply(&Change::Created { path: root("elsewhere/x.txt"), meta: file(1, 1) }), Applied::Ignored);
    // Modified.
    assert_eq!(ix.apply(&Change::Modified { path: p("a/one.txt"), meta: file(77, 5_000) }), Applied::Done);
    let h = &q(&ix, "one.txt").hits[0];
    assert_eq!((h.size, h.mtime), (77, 5_000));
    // Removed (a folder takes its contents).
    assert_eq!(ix.apply(&Change::Removed { path: p("a/sub/deep") }), Applied::Done);
    assert!(q(&ix, "three").hits.is_empty());
    assert_eq!(ix.apply(&Change::Removed { path: p("a/sub/deep") }), Applied::Ignored);
    // Renamed file: new name, new kind.
    assert_eq!(ix.apply(&Change::Moved { from: p("a/one.txt"), to: p("a/one.mp4"), meta: None }), Applied::Done);
    let h = &q(&ix, "one").hits[0];
    assert_eq!((h.name.as_str(), h.kind, h.size), ("one.mp4", Kind::Video, 77));
    // Folder renamed: the subtree moves without a walk.
    ix.apply(&Change::Created { path: p("a/sub/deep2"), meta: dirm() });
    ix.apply(&Change::Created { path: p("a/sub/deep2/four.txt"), meta: file(4, 4) });
    let before = ix.stats().entries;
    assert_eq!(ix.apply(&Change::Moved { from: p("a/sub"), to: p("a/renamed"), meta: Some(dirm()) }), Applied::Done);
    assert_eq!(ix.stats().entries, before);
    let four = &q(&ix, "four").hits[0];
    assert_eq!(rel(&ix, &four.path).unwrap(), "a/renamed/deep2/four.txt");
    assert_eq!(rel(&ix, &q(&ix, "two.txt").hits[0].path).unwrap(), "a/renamed/two.txt");
    // Moved to another folder.
    assert_eq!(ix.apply(&Change::Moved { from: p("a/renamed"), to: p("b/renamed"), meta: None }), Applied::Done);
    assert_eq!(rel(&ix, &q(&ix, "four").hits[0].path).unwrap(), "b/renamed/deep2/four.txt");
    assert!(q(&ix, "path:a/renamed").hits.is_empty());
    // A rename onto an existing name replaces it.
    ix.apply(&Change::Created { path: p("b/x.txt"), meta: file(1, 1) });
    ix.apply(&Change::Created { path: p("b/y.txt"), meta: file(2, 2) });
    assert_eq!(ix.apply(&Change::Moved { from: p("b/x.txt"), to: p("b/y.txt"), meta: None }), Applied::Done);
    let ys = q(&ix, "y.txt");
    assert_eq!(ys.total, 1);
    assert_eq!(ys.hits[0].size, 1);
    assert!(q(&ix, "x.txt").hits.is_empty());
    // A file that became a folder.
    assert_eq!(ix.apply(&Change::Created { path: p("b/y.txt"), meta: dirm() }), Applied::Rescan(vec![p("b/y.txt")]));
    assert!(q(&ix, "y.txt").hits[0].is_dir);
    // Moved out of the index.
    assert_eq!(ix.apply(&Change::Moved { from: p("b/renamed"), to: root("elsewhere/renamed"), meta: None }), Applied::Done);
    assert!(q(&ix, "four").hits.is_empty());
    // Moved in from outside: a creation (stated), or a walk of its folder when unknown.
    assert_eq!(ix.apply(&Change::Moved { from: root("elsewhere/in.txt"), to: p("a/in.txt"), meta: Some(file(3, 3)) }), Applied::Done);
    assert_eq!(q(&ix, "in.txt").total, 1);
    assert_eq!(ix.apply(&Change::Moved { from: root("elsewhere/q"), to: p("a/q"), meta: None }), Applied::Rescan(vec![p("a")]));
    // Overflow.
    assert_eq!(ix.apply(&Change::Overflow { dir: p("a") }), Applied::Rescan(vec![p("a")]));
    // The root itself removed: its contents go, the root stays chosen.
    assert_eq!(ix.apply(&Change::Removed { path: r.clone() }), Applied::Done);
    assert_eq!(ix.stats().entries, 0);
    assert_eq!(ix.roots().len(), 1);
}

#[test]
fn moves_across_roots_and_exclusions() {
    let mut ix = Index::new();
    let (ra, rb) = (root("ra"), root("rb"));
    ix.add_root(RootSpec { path: ra.clone(), exclude: vec![ra.join("skip")], exclude_names: vec!["Node_Modules".into()] }).unwrap();
    ix.add_root(RootSpec { path: rb.clone(), ..RootSpec::default() }).unwrap();
    // A root inside another, or holding one, is refused.
    assert_eq!(ix.add_root(RootSpec { path: ra.join("inner"), ..RootSpec::default() }), Err(ra.clone()));
    assert_eq!(ix.add_root(RootSpec { path: root(""), ..RootSpec::default() }).is_err(), true);
    add_path(&mut ix, &ra, "work/clip.mkv", file(10, 10));
    add_path(&mut ix, &ra, "work/sub/inner.txt", file(1, 1));
    assert_eq!(ix.apply(&Change::Moved { from: ra.join("work"), to: rb.join("work"), meta: None }), Applied::Done);
    let h = &q(&ix, "inner").hits[0];
    assert_eq!(h.path, rb.join("work").join("sub").join("inner.txt"));
    // Into an excluded folder (by path, by name anywhere): it leaves the index.
    assert_eq!(ix.apply(&Change::Moved { from: rb.join("work"), to: ra.join("skip").join("work"), meta: None }), Applied::Done);
    assert!(q(&ix, "clip").hits.is_empty());
    assert_eq!(ix.apply(&Change::Created { path: ra.join("skip").join("a.txt"), meta: file(1, 1) }), Applied::Ignored);
    assert_eq!(ix.apply(&Change::Created { path: ra.join("x").join("node_modules"), meta: dirm() }), Applied::Ignored);
    assert!(ix.is_excluded(&ra.join("deep").join("NODE_MODULES").join("pkg")));
    assert!(!ix.is_excluded(&ra.join("deep").join("modules")));
    // Removing a root removes its entries.
    add_path(&mut ix, &rb, "keep.txt", file(1, 1));
    assert!(ix.remove_root(&ra));
    assert_eq!(ix.roots().len(), 1);
    assert_eq!(names(&q(&ix, "")), vec!["keep.txt"]);
}

#[test]
fn big_folder_lookups_stay_right() {
    let mut ix = fixture(&[]);
    let r = root("r");
    for i in 0..3000 {
        ix.apply(&Change::Created { path: r.join(format!("f{i}.bin")), meta: file(i, i as i64) });
    }
    assert_eq!(ix.stats().entries, 3000);
    // Renames, removals and re-creations in the big folder (it is in the by-name map now).
    for i in (0..3000).step_by(3) {
        assert_eq!(ix.apply(&Change::Moved { from: r.join(format!("f{i}.bin")), to: r.join(format!("g{i}.bin")), meta: None }), Applied::Done);
    }
    for i in (1..3000).step_by(3) {
        assert_eq!(ix.apply(&Change::Removed { path: r.join(format!("f{i}.bin")) }), Applied::Done);
    }
    for i in (1..3000).step_by(3) {
        assert_eq!(ix.apply(&Change::Removed { path: r.join(format!("f{i}.bin")) }), Applied::Ignored);
    }
    assert_eq!(ix.stats().entries, 2000);
    assert_eq!(q(&ix, "g").total, 1000);
    assert!(ix.lookup(&r.join("g2997.bin")).is_some());
    assert!(ix.lookup(&r.join("f2997.bin")).is_none());
    assert!(ix.lookup(&r.join("f2999.bin")).is_some());
    for i in (0..3000).step_by(3) {
        assert_eq!(ix.apply(&Change::Removed { path: r.join(format!("g{i}.bin")) }), Applied::Done);
    }
    assert_eq!(ix.stats().entries, 1000);
    // Made again after a removal: found through the map, once.
    assert_eq!(ix.apply(&Change::Created { path: r.join("f1.bin"), meta: file(1, 1) }), Applied::Done);
    assert_eq!(ix.apply(&Change::Created { path: r.join("f1.bin"), meta: file(1, 1) }), Applied::Ignored);
    assert_eq!(q(&ix, "f1.bin").total, 1);
    // Where the disk ignores case, another spelling is the same entry (the new spelling is kept).
    if cfg!(any(windows, target_os = "macos")) {
        assert_eq!(ix.apply(&Change::Modified { path: r.join("F2.BIN"), meta: file(9, 9) }), Applied::Done);
        assert_eq!(q(&ix, "f2.bin").hits[0].name, "F2.BIN");
        assert!(ix.lookup(&r.join("f2.bin")).is_some());
        ix.apply(&Change::Removed { path: r.join("F2.BIN") });
        ix.apply(&Change::Created { path: r.join("f2.bin"), meta: file(1, 1) });
    }
    // The arena was compacted along the way only when worth it; every name still reads right.
    assert_eq!(ix.stats().entries, 1001);
    for h in q(&ix, "").hits.iter().take(200) {
        assert!(h.name.starts_with('f') && h.name.ends_with(".bin"));
    }
}

#[test]
fn sync_dir_compares_a_listing() {
    let mut ix = fixture(&["d/keep.txt", "d/gone.txt", "d/sub/x.txt"]);
    let d = root("r").join("d");
    let listing = vec![
        (OsString::from("keep.txt"), file(999, 7)),
        (OsString::from("sub"), dirm()),
        (OsString::from("fresh.txt"), file(1, 1)),
        (OsString::from("newdir"), dirm()),
    ];
    let new = ix.sync_dir(&d, &listing);
    assert_eq!(new, vec![d.join("newdir")]);
    let mut v = names(&q(&ix, "path:/d/"));
    v.sort();
    assert_eq!(v, vec!["fresh.txt", "keep.txt", "newdir", "sub", "x.txt"]);
    assert_eq!(q(&ix, "keep").hits[0].size, 999);
    // The sub-folder's contents were kept (the listing is shallow).
    assert_eq!(q(&ix, "x.txt").total, 1);
    // Through apply, as the poller hands it.
    let a = ix.apply(&Change::Listed { dir: d.clone(), items: vec![(OsString::from("keep.txt"), file(999, 7))] });
    assert_eq!(a, Applied::Done);
    assert_eq!(names(&q(&ix, "path:/d/")), vec!["keep.txt"]);
}

// ---- the walk ----

#[test]
fn walk_real_tree() {
    let t = Tmp::new("walk");
    t.file("a.txt", 3);
    t.file("Music/song.flac", 10);
    t.file("Music/Album/track01.mp3", 20);
    t.file("Video/مقطع.mkv", 5);
    t.file("Video/動画.mp4", 6);
    t.file("node_modules/pkg/index.js", 1);
    t.file("skip/secret.txt", 1);
    t.file("keep/node_modules.txt", 1); // a file named like an excluded folder stays
    t.dir("empty");
    let target = t.dir("target");
    t.file("target/inside.txt", 1);
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&target, t.p("link-to-target")).unwrap();
        std::os::unix::fs::symlink(t.p("missing"), t.p("broken-link")).unwrap();
    }
    let spec = RootSpec { path: t.0.clone(), exclude: vec![t.p("skip")], exclude_names: vec!["node_modules".into()] };
    let mut ix = Index::new();
    ix.add_root(spec.clone()).unwrap();
    let ctrl = WalkCtrl::new();
    let w = DirWalker::new(StdFs).walk(&spec, &t.0, &ctrl);
    assert!(!w.cancelled);
    assert_eq!(w.unreadable, 0);
    let entries = w.entries;
    assert!(ix.install(w));
    let base = t.0.to_string_lossy().replace('\\', "/");
    let mut got: Vec<String> = all_paths(&ix).into_iter().map(|p| p[base.len() + 1..].to_string()).collect();
    got.sort();
    let mut want = vec![
        "Music", "Music/Album", "Music/Album/track01.mp3", "Music/song.flac", "Video", "Video/مقطع.mkv", "Video/動画.mp4",
        "a.txt", "empty", "keep", "keep/node_modules.txt", "target", "target/inside.txt",
    ];
    if cfg!(unix) {
        want.extend(["broken-link", "link-to-target"]);
    }
    want.sort();
    assert_eq!(got, want);
    assert_eq!(entries as usize, want.len());
    assert_eq!(ctrl.progress().entries, entries);
    assert_eq!(ctrl.progress().current_root, t.0);
    let song = &q(&ix, "track01").hits[0];
    assert_eq!((song.size, song.kind), (20, Kind::Audio));
    assert!(song.mtime > 1_600_000_000_000);
    if cfg!(unix) {
        let l = &q(&ix, "link-to-target").hits[0];
        assert!(l.is_link);
        // Recorded, not followed: «inside.txt» is there once, under target only.
        assert_eq!(q(&ix, "inside").total, 1);
    }
    let st = ix.roots();
    assert!(st[0].walked && st[0].entries == entries);
    // A folder walked again (rescan) replaces just its contents.
    t.file("Music/Album/track02.mp3", 1);
    std::fs::remove_file(t.p("Music/song.flac")).unwrap();
    let w = DirWalker::new(StdFs).walk(&spec, &t.p("Music"), &ctrl);
    assert!(ix.install(w));
    assert_eq!(q(&ix, "track0").total, 2);
    assert!(q(&ix, "song").hits.is_empty());
    assert_eq!(q(&ix, "a.txt").total, 1);
    // A rescan of a folder that vanished removes it.
    std::fs::remove_dir_all(t.p("Video")).unwrap();
    let w = DirWalker::new(StdFs).walk(&spec, &t.p("Video"), &ctrl);
    assert!(ix.install(w));
    assert!(q(&ix, "mkv").hits.is_empty());
}

/// A made-up disk: folders listed from a table, one of them unreadable.
struct FakeFs {
    tree: Mutex<Vec<(PathBuf, Meta)>>,
    unreadable: Vec<PathBuf>,
}
impl Fs for FakeFs {
    fn read_dir(&self, dir: &Path, item: &mut dyn FnMut(OsString, Meta)) -> io::Result<()> {
        if self.unreadable.iter().any(|u| u == dir) {
            return Err(io::Error::from(io::ErrorKind::PermissionDenied));
        }
        let t = self.tree.lock().unwrap();
        if !t.iter().any(|(p, m)| p == dir && m.is_dir) {
            return Err(io::Error::from(io::ErrorKind::NotFound));
        }
        for (p, m) in t.iter() {
            if p.parent() == Some(dir) {
                item(p.file_name().unwrap().to_os_string(), *m);
            }
        }
        Ok(())
    }
    fn lstat(&self, path: &Path) -> io::Result<Meta> {
        let t = self.tree.lock().unwrap();
        t.iter().find(|(p, _)| p == path).map(|(_, m)| *m).ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
    }
}

fn fake_fs(rel: &[&str], unreadable: &[&str]) -> FakeFs {
    let r = root("fake");
    let mut tree = vec![(r.clone(), Meta { is_dir: true, mtime: 1, ..Meta::default() })];
    for p in rel {
        let is_dir = p.ends_with('/');
        let mut x = r.clone();
        for c in p.trim_end_matches('/').split('/') {
            x.push(c);
        }
        tree.push((x, Meta { is_dir, size: if is_dir { 0 } else { 1 }, mtime: 1, is_link: false }));
    }
    FakeFs { tree: Mutex::new(tree), unreadable: unreadable.iter().map(|u| r.join(u)).collect() }
}

#[test]
fn unreadable_folders_are_counted_and_cancel_works() {
    let fs = fake_fs(&["ok/", "ok/a.txt", "locked/", "locked/hidden.txt", "b.txt"], &["locked"]);
    let spec = RootSpec { path: root("fake"), ..RootSpec::default() };
    let ctrl = WalkCtrl::new();
    let w = DirWalker::new(fs).walk(&spec, &spec.path, &ctrl);
    assert_eq!(w.unreadable, 1);
    assert_eq!(ctrl.progress().unreadable, 1);
    let mut ix = Index::new();
    ix.add_root(spec.clone()).unwrap();
    assert!(ix.install(w));
    let mut v = names(&q(&ix, ""));
    v.sort();
    assert_eq!(v, vec!["a.txt", "b.txt", "locked", "ok"]);
    assert_eq!(ix.roots()[0].unreadable, 1);
    // Cancelled before it starts: nothing is installed.
    let ctrl = WalkCtrl::new();
    ctrl.cancel.store(true, Ordering::SeqCst);
    let w = DirWalker::new(fake_fs(&["x.txt"], &[])).walk(&spec, &spec.path, &ctrl);
    assert!(w.cancelled);
    assert!(!ix.install(w));
    assert_eq!(q(&ix, "").total, 4);
    // Paused: the walk waits until resumed.
    let ctrl = Arc::new(WalkCtrl::new());
    ctrl.pause.store(true, Ordering::SeqCst);
    let c2 = ctrl.clone();
    let sp = spec.clone();
    let h = std::thread::spawn(move || DirWalker::new(fake_fs(&["x.txt"], &[])).walk(&sp, &sp.path, &c2));
    std::thread::park_timeout(Duration::from_millis(300));
    assert!(!h.is_finished());
    assert!(ctrl.progress().paused);
    ctrl.pause.store(false, Ordering::SeqCst);
    let w = h.join().unwrap();
    assert_eq!(w.entries, 1);
}

#[test]
fn lower_priority_on_a_thread() {
    let ok = std::thread::spawn(lower_thread_priority).join().unwrap();
    if cfg!(any(target_os = "linux", target_os = "macos", windows)) {
        assert!(ok);
    }
}

// ---- the file ----

#[test]
fn save_and_load_round_trip() {
    let t = Tmp::new("persist");
    let mut ix = sample();
    ix.add_root(RootSpec { path: root("other"), exclude: vec![root("other/x")], exclude_names: vec![".git".into()] }).unwrap();
    add_path(&mut ix, &root("other"), "deep/a/b/c/leaf.txt", file(5, 6));
    // Some churn first, so freed slots and renamed names are in the columns.
    ix.apply(&Change::Removed { path: root("r").join("music") });
    ix.apply(&Change::Moved { from: root("r").join("docs"), to: root("r").join("Documents"), meta: None });
    let f = t.p("index.ktfi");
    let n = ix.save(&f).unwrap();
    assert_eq!(std::fs::metadata(&f).unwrap().len(), n);
    assert!(!t.p("index.ktfi.tmp").exists());
    let (back, stale) = Index::load(&f).unwrap();
    assert_eq!(stale.len(), 2);
    assert_eq!(back.root_specs(), ix.root_specs());
    assert_eq!(all_paths(&back), all_paths(&ix));
    assert_eq!(back.stats().entries, ix.stats().entries);
    assert_eq!(back.stats().folders, ix.stats().folders);
    let a = q(&ix, "report");
    let b = q(&back, "report");
    assert_eq!(names(&a), names(&b));
    assert_eq!(a.hits.iter().map(|h| (h.size, h.mtime, h.kind)).collect::<Vec<_>>(), b.hits.iter().map(|h| (h.size, h.mtime, h.kind)).collect::<Vec<_>>());
    assert_eq!(names(&q(&back, "كتاب")), vec!["كِتَاب.png"]);
    assert!(back.is_excluded(&root("other").join("y").join(".GIT")));
    // A saved index is still a working index.
    let mut back = back;
    assert_eq!(back.apply(&Change::Removed { path: root("other").join("deep") }), Applied::Done);
    assert!(q(&back, "leaf").hits.is_empty());
}

#[test]
fn damaged_files_are_refused() {
    let t = Tmp::new("damaged");
    let ix = sample();
    let good = ix.to_bytes();
    assert!(Index::from_bytes(&good).is_ok());
    // Cut short anywhere.
    for cut in [0, 7, 8, 31, 32, 33, good.len() / 2, good.len() - 1] {
        assert!(Index::from_bytes(&good[..cut]).is_err(), "cut at {cut}");
    }
    // One byte changed anywhere in the payload: the checksum.
    for at in [32, 40, good.len() / 3, good.len() - 1] {
        let mut b = good.clone();
        b[at] ^= 0x20;
        assert_eq!(Index::from_bytes(&b).err(), Some(LoadError::Damaged("checksum")), "byte {at}");
    }
    // Another version, another magic.
    let mut b = good.clone();
    b[8] = 2;
    assert_eq!(Index::from_bytes(&b).err(), Some(LoadError::OtherVersion(2)));
    let mut b = good.clone();
    b[0] = b'X';
    assert!(matches!(Index::from_bytes(&b), Err(LoadError::Damaged(_))));
    // A length that does not match.
    let mut b = good.clone();
    b.push(0);
    assert_eq!(Index::from_bytes(&b).err(), Some(LoadError::Damaged("length")));
    // A well-sealed file with a lie inside (a parent after its child, a name with a slash): never trusted.
    let reseal = |payload: Vec<u8>| {
        let mut out = good[..16].to_vec();
        out.extend_from_slice(&(payload.len() as u64).to_le_bytes());
        out.extend_from_slice(&checksum(&payload).to_le_bytes());
        out.extend_from_slice(&payload);
        out
    };
    let mut payload = Vec::new();
    payload.extend_from_slice(&1u32.to_le_bytes()); // one root
    let rp = root("z");
    let rb = rp.as_os_str().as_encoded_bytes();
    payload.extend_from_slice(&(rb.len() as u32).to_le_bytes());
    payload.extend_from_slice(rb);
    payload.extend_from_slice(&0u64.to_le_bytes());
    payload.extend_from_slice(&0u64.to_le_bytes());
    payload.push(1);
    payload.extend_from_slice(&0u32.to_le_bytes());
    payload.extend_from_slice(&0u32.to_le_bytes());
    let entry = |parent: u32, flags: u8, name: &[u8]| {
        let mut e = Vec::new();
        e.extend_from_slice(&parent.to_le_bytes());
        e.push(flags);
        e.extend_from_slice(&0u64.to_le_bytes());
        e.extend_from_slice(&0u64.to_le_bytes());
        e.extend_from_slice(&(name.len() as u16).to_le_bytes());
        e.extend_from_slice(name);
        e
    };
    let build = |entries: Vec<Vec<u8>>| {
        let mut p = payload.clone();
        p.extend_from_slice(&(entries.len() as u32).to_le_bytes());
        for e in entries {
            p.extend_from_slice(&e);
        }
        reseal(p)
    };
    assert!(Index::from_bytes(&build(vec![entry(NONE, 1, b"z"), entry(0, 1, b"d"), entry(1, 0, b"f")])).is_ok());
    assert_eq!(Index::from_bytes(&build(vec![entry(NONE, 1, b"z"), entry(2, 1, b"d"), entry(1, 0, b"f")])).err(), Some(LoadError::Damaged("a parent")));
    assert_eq!(Index::from_bytes(&build(vec![entry(NONE, 1, b"z"), entry(1, 0, b"self")])).err(), Some(LoadError::Damaged("a parent")));
    assert_eq!(Index::from_bytes(&build(vec![entry(NONE, 1, b"z"), entry(0, 0, b"f"), entry(1, 0, b"under-a-file")])).err(), Some(LoadError::Damaged("a parent")));
    assert_eq!(Index::from_bytes(&build(vec![entry(NONE, 1, b"z"), entry(0, 0, b"a/b")])).err(), Some(LoadError::Damaged("a name")));
    assert_eq!(Index::from_bytes(&build(vec![entry(NONE, 1, b"z"), entry(0, 0, b"..")])).err(), Some(LoadError::Damaged("a name")));
    assert_eq!(Index::from_bytes(&build(vec![entry(NONE, 1, b"z"), entry(0, 0x80, b"f")])).err(), Some(LoadError::Damaged("flags")));
    assert_eq!(Index::from_bytes(&build(vec![entry(NONE, 1, b"z"), entry(NONE, 1, b"z2")])).err(), Some(LoadError::Damaged("a root entry")));
    assert_eq!(Index::from_bytes(&build(vec![])).err(), Some(LoadError::Damaged("trailing or missing data")));
    // load_or_new: a damaged file is deleted and a new index begins; a missing one is just new.
    let f = t.p("index.ktfi");
    std::fs::write(&f, &good[..good.len() - 3]).unwrap();
    let (ix2, stale, note) = Index::load_or_new(&f);
    assert!(matches!(note, Some(LoadError::Damaged(_))));
    assert!(stale.is_empty() && ix2.stats().entries == 0);
    assert!(!f.exists());
    let (_, _, note) = Index::load_or_new(&f);
    assert_eq!(note, Some(LoadError::Missing));
    assert_eq!(&good[..8], MAGIC);
}

// ---- the watchers ----

#[test]
fn windows_notify_records_parse() {
    fn rec(action: u32, name: &str, last: bool) -> Vec<u8> {
        let units: Vec<u16> = name.encode_utf16().collect();
        let mut v = Vec::new();
        let len = 12 + units.len() * 2;
        let padded = (len + 3) & !3;
        v.extend_from_slice(&(if last { 0 } else { padded as u32 }).to_le_bytes());
        v.extend_from_slice(&action.to_le_bytes());
        v.extend_from_slice(&((units.len() * 2) as u32).to_le_bytes());
        for u in units {
            v.extend_from_slice(&u.to_le_bytes());
        }
        v.resize(padded, 0);
        v
    }
    let r = root("w");
    let mut buf = Vec::new();
    buf.extend(rec(1, "new.txt", false));
    buf.extend(rec(3, "new.txt", false));
    buf.extend(rec(4, "old name", false));
    buf.extend(rec(5, "مجلد\\new name", false));
    buf.extend(rec(2, "gone.bin", false));
    buf.extend(rec(4, "moved-out", true));
    let mut out = Vec::new();
    parse_notify(&r, &buf, &mut out);
    let sep = |s: &str| if cfg!(windows) { s.to_string() } else { s.replace('\\', "\\") };
    assert_eq!(out, vec![
        RawEvent::Created(r.join("new.txt")),
        RawEvent::Modified(r.join("new.txt")),
        RawEvent::Moved(r.join("old name"), r.join(sep("مجلد\\new name"))),
        RawEvent::Removed(r.join("gone.bin")),
        RawEvent::Removed(r.join("moved-out")),
    ]);
    // A cut record is ignored, not read past the end.
    let mut out = Vec::new();
    parse_notify(&r, &buf[..buf.len() - 9], &mut out);
    assert!(out.len() >= 4);
}

#[test]
fn mtime_poller_finds_changed_folders() {
    let fs = Arc::new(fake_fs(&["a/", "a/x.txt", "b/"], &[]));
    struct Shared(Arc<FakeFs>);
    impl Fs for Shared {
        fn read_dir(&self, d: &Path, f: &mut dyn FnMut(OsString, Meta)) -> io::Result<()> {
            self.0.read_dir(d, f)
        }
        fn lstat(&self, p: &Path) -> io::Result<Meta> {
            self.0.lstat(p)
        }
    }
    let r = root("fake");
    let spec = RootSpec { path: r.clone(), ..RootSpec::default() };
    let mut ix = Index::new();
    ix.add_root(spec.clone()).unwrap();
    assert!(ix.install(DirWalker::new(Shared(fs.clone())).walk(&spec, &r, &WalkCtrl::new())));
    let mut poll = MtimePoller::new(Shared(fs.clone()), Duration::from_secs(3600));
    poll.watch(&spec).unwrap();
    let mut out = Vec::new();
    poll.check(&mut out);
    assert!(out.is_empty());
    // A new file and a new folder in «a» (its time changes); «b» untouched.
    {
        let mut t = fs.tree.lock().unwrap();
        for (p, m) in t.iter_mut() {
            if *p == r.join("a") {
                m.mtime = 2;
            }
        }
        t.push((r.join("a").join("y.txt"), file(1, 2)));
        t.push((r.join("a").join("n"), Meta { is_dir: true, mtime: 2, ..Meta::default() }));
        t.push((r.join("a").join("n").join("z.txt"), file(1, 2)));
    }
    poll.check(&mut out);
    assert_eq!(out, vec![RawEvent::DirChanged(r.join("a"))]);
    let changes = to_changes(out, &Shared(fs.clone()));
    let mut rescans = Vec::new();
    for c in &changes {
        if let Applied::Rescan(v) = ix.apply(c) {
            rescans.extend(v);
        }
    }
    assert_eq!(rescans, vec![r.join("a").join("n")]);
    for d in rescans {
        assert!(ix.install(DirWalker::new(Shared(fs.clone())).walk(&spec, &d, &WalkCtrl::new())));
    }
    let mut v = names(&q(&ix, ""));
    v.sort();
    assert_eq!(v, vec!["a", "b", "n", "x.txt", "y.txt", "z.txt"]);
    // The new folder is watched too now.
    {
        let mut t = fs.tree.lock().unwrap();
        for (p, m) in t.iter_mut() {
            if *p == r.join("a").join("n") {
                m.mtime = 3;
            }
        }
    }
    let mut out = Vec::new();
    poll.check(&mut out);
    assert_eq!(out, vec![RawEvent::DirChanged(r.join("a").join("n"))]);
}

/// The system's watcher on a made-up tree: each change reaches the index (applied as the service does, walking what
/// `apply` asks for). Linux runs it here; Windows runs it on GitHub's runner (ReadDirectoryChangesW).
#[cfg(any(target_os = "linux", windows))]
fn real_watcher_keeps_a_tree_current(tag: &str, make: fn() -> Box<dyn Watcher>) {
    let t = Tmp::new(tag);
    t.file("start.txt", 1);
    t.file("folder/inner.txt", 1);
    t.dir("excluded");
    let spec = RootSpec { path: t.0.clone(), exclude: vec![t.p("excluded")], ..RootSpec::default() };
    let mut ix = Index::new();
    ix.add_root(spec.clone()).unwrap();
    assert!(ix.install(DirWalker::new(StdFs).walk(&spec, &t.0, &WalkCtrl::new())));
    let mut w = make();
    w.watch(&spec).unwrap();
    let pump = |ix: &mut Index, w: &mut Box<dyn Watcher>, what: &str, done: &dyn Fn(&Index) -> bool| {
        let end = Instant::now() + Duration::from_secs(10);
        while Instant::now() < end {
            let mut raw = Vec::new();
            w.poll(Duration::from_millis(200), &mut raw).unwrap();
            for c in to_changes(raw, &StdFs) {
                if let Applied::Rescan(v) = ix.apply(&c) {
                    for d in v {
                        ix.install(DirWalker::new(StdFs).walk(&spec, &d, &WalkCtrl::new()));
                    }
                }
            }
            if done(ix) {
                return;
            }
        }
        panic!("the index did not catch up: {what}");
    };
    t.file("made.mp4", 42);
    pump(&mut ix, &mut w, "a new file", &|ix| q(ix, "made.mp4").hits.first().map_or(false, |h| h.size == 42));
    std::fs::create_dir(t.p("newdir")).unwrap();
    t.file("newdir/child.txt", 2);
    pump(&mut ix, &mut w, "a new folder", &|ix| q(ix, "child").total == 1);
    // A folder rename moves the subtree; a file made in it afterwards is seen at its new path.
    std::fs::rename(t.p("folder"), t.p("renamed")).unwrap();
    pump(&mut ix, &mut w, "a folder rename", &|ix| q(ix, "inner").hits.first().map_or(false, |h| h.path == t.p("renamed/inner.txt")));
    t.file("renamed/later.txt", 3);
    pump(&mut ix, &mut w, "a file in the renamed folder", &|ix| q(ix, "later").hits.first().map_or(false, |h| h.path == t.p("renamed/later.txt")));
    std::fs::write(t.p("start.txt"), b"longer now").unwrap();
    pump(&mut ix, &mut w, "a modification", &|ix| q(ix, "start").hits[0].size == 10);
    std::fs::remove_file(t.p("made.mp4")).unwrap();
    pump(&mut ix, &mut w, "a removal", &|ix| q(ix, "made").total == 0);
    // Into the excluded folder: it leaves the index; what happens there is not indexed.
    std::fs::rename(t.p("renamed"), t.p("excluded/renamed")).unwrap();
    pump(&mut ix, &mut w, "a move into the excluded folder", &|ix| q(ix, "inner").total == 0);
    t.file("excluded/quiet.txt", 1);
    std::fs::remove_dir_all(t.p("newdir")).unwrap();
    pump(&mut ix, &mut w, "a folder removed", &|ix| q(ix, "child").total == 0 && q(ix, "newdir").total == 0);
    assert_eq!(q(&ix, "quiet").total, 0);
    w.unwatch(&spec.path);
}

#[cfg(target_os = "linux")]
#[test]
fn inotify_keeps_a_real_tree_current() {
    real_watcher_keeps_a_tree_current("inotify", || Box::new(watch::linux::Inotify::new().unwrap()));
    // The root and «folder» are watched; never the excluded folder.
    let t = Tmp::new("inotify-count");
    t.dir("a/b");
    t.dir("skip/c");
    let mut w = watch::linux::Inotify::new().unwrap();
    w.watch(&RootSpec { path: t.0.clone(), exclude: vec![t.p("skip")], ..RootSpec::default() }).unwrap();
    assert_eq!(w.watches(), 3);
}

#[cfg(windows)]
#[test]
fn read_directory_changes_keeps_a_real_tree_current() {
    real_watcher_keeps_a_tree_current("rdcw", || Box::new(watch::windows::DirChanges::new()));
}

// ---- the service ----

#[test]
fn service_runs_walks_changes_and_the_file() {
    let t = Tmp::new("service");
    let data = Tmp::new("service-data");
    t.file("one/alpha.txt", 1);
    t.file("one/beta.mkv", 2);
    t.file("two/gamma.flac", 3);
    let file = data.p("fileindex.ktfi");
    let fake = FakeWatcher::default();
    let feed: Arc<Mutex<VecDeque<RawEvent>>> = fake.queue.clone();
    let spec = RootSpec { path: t.p("one"), ..RootSpec::default() };
    let opts = |watcher: Option<Box<dyn Watcher>>, roots: Vec<RootSpec>| ServiceOptions {
        file: Some(file.clone()),
        roots,
        source: Arc::new(DirWalker::new(StdFs)),
        fs: Arc::new(StdFs),
        watcher,
        poll_interval: Duration::from_secs(3600),
        save_every: Duration::from_millis(0),
        low_priority: true,
    };
    let mut s = Service::start(opts(Some(Box::new(fake)), vec![spec.clone()]));
    wait_until("the first walk", 10, || !s.status().busy && s.status().stats.entries == 2);
    assert_eq!(names(&s.search(&Query::text("alpha")).unwrap()), vec!["alpha.txt"]);
    // A watcher event (a new file) reaches the index.
    t.file("one/delta.txt", 4);
    feed.lock().unwrap().push_back(RawEvent::Created(t.p("one/delta.txt")));
    wait_until("the change", 10, || s.search(&Query::text("delta")).map_or(false, |r| r.total == 1));
    // A second root; then removed.
    s.add_root(RootSpec { path: t.p("two"), ..RootSpec::default() }).unwrap();
    wait_until("the second root", 10, || s.search(&Query::text("gamma")).map_or(false, |r| r.total == 1));
    assert!(s.remove_root(&t.p("two")));
    assert_eq!(s.search(&Query::text("gamma")).unwrap().total, 0);
    // Paused: a rebuild waits; resumed: it runs.
    s.set_paused(true);
    t.file("one/epsilon.txt", 5);
    s.rebuild();
    std::thread::park_timeout(Duration::from_millis(300));
    assert_eq!(s.search(&Query::text("epsilon")).unwrap().total, 0);
    assert!(s.status().progress.paused && s.status().busy);
    s.set_paused(false);
    wait_until("the rebuild", 10, || s.search(&Query::text("epsilon")).map_or(false, |r| r.total == 1));
    s.save_now();
    wait_until("the save", 10, || s.status().file_bytes > 0);
    let st = s.status();
    assert_eq!(st.roots.len(), 1);
    assert!(st.stats.memory_bytes > 0);
    s.stop();
    // Started again from the file: it answers before any walk, then walks again.
    let s2 = Service::start(opts(None, vec![spec.clone()]));
    assert_eq!(s2.search(&Query::text("epsilon")).unwrap().total, 1);
    wait_until("the walk after the load", 10, || !s2.status().busy);
    assert_eq!(s2.search(&Query::text("")).unwrap().total, 4);
    drop(s2);
    // A damaged file: noted, rebuilt from the roots in the settings.
    let len = std::fs::metadata(&file).unwrap().len();
    std::fs::OpenOptions::new().write(true).open(&file).unwrap().set_len(len - 5).unwrap();
    let s3 = Service::start(opts(None, vec![spec]));
    assert!(s3.status().note.unwrap().contains("damaged"));
    wait_until("the rebuild after damage", 10, || s3.search(&Query::text("")).map_or(false, |r| r.total == 4));
    // Removed by the user: never saved again, even when stopped.
    s3.discard();
    let _ = std::fs::remove_file(&file);
    drop(s3);
    assert!(!file.exists());
}

/// Two roots: the made-up one (`n` entries) and a small «other» one.
fn two_roots(n: usize) -> Index {
    let mut ix = synthetic(n);
    ix.add_root(RootSpec { path: root("other"), exclude_names: vec!["skip".into()], ..RootSpec::default() }).unwrap();
    let o = ix.find(&root("other")).unwrap();
    ix.insert(o, OsStr::new("keep me.txt"), file(5, 7)).unwrap();
    let sub = ix.insert(o, OsStr::new("Sub folder"), dirm()).unwrap();
    ix.insert(sub, OsStr::new("deeper budget.pdf"), file(9, 8)).unwrap();
    ix
}

fn fresh_walk(n: usize, at_ms: i64) -> Walked {
    Walked { path: root("synthetic"), tree: synthetic(n), entries: n as u64, unreadable: 2, skipped: 0, cancelled: false, finished_ms: at_ms }
}

#[test]
fn a_big_walk_is_installed_aside_as_it_would_be_in_place() {
    let n = 30_000;
    let a = two_roots(n);
    let mut b = two_roots(n);
    let w = fresh_walk(n, 99);
    assert!(a.worth_aside(&w));
    let gen = a.generation();
    let aside = a.installed_aside(w).ok().unwrap();
    assert!(b.install(fresh_walk(n, 99)));
    assert!(aside.generation() > gen);
    assert_eq!(aside.stats().entries, b.stats().entries);
    assert_eq!(aside.stats().folders, b.stats().folders);
    assert_eq!(aside.stats().files, b.stats().files);
    assert_eq!(aside.roots(), b.roots());
    assert_eq!(aside.root_specs(), b.root_specs());
    let r = aside.roots();
    assert_eq!((r[0].walked, r[0].last_walk_ms, r[0].unreadable), (true, 99, 2));
    for t in ["", "keep", "budget", "deeper budget", "path:sub", "*.mkv", "تقرير"] {
        let (x, y) = (q(&aside, t), q(&b, t));
        assert_eq!(x.total, y.total, "{t}");
        let mut px: Vec<_> = x.hits.iter().map(|h| h.path.clone()).collect();
        let mut py: Vec<_> = y.hits.iter().map(|h| h.path.clone()).collect();
        px.sort();
        py.sort();
        if x.total <= 200 {
            assert_eq!(px, py, "{t}");
        }
    }
    // No garbage and no spare room left behind: smaller than the index filled in place.
    assert!(aside.stats().memory_bytes <= b.stats().memory_bytes, "{} > {}", aside.stats().memory_bytes, b.stats().memory_bytes);
    // It goes on taking changes, under both roots, and keeps the other root's exclusions.
    let mut aside = aside;
    assert_eq!(aside.apply(&Change::Created { path: root("other/Sub folder/new one.txt"), meta: file(1, 1) }), Applied::Done);
    assert_eq!(aside.apply(&Change::Created { path: root("synthetic/Group 01/late arrival.txt"), meta: file(1, 1) }), Applied::Done);
    assert_eq!(names(&q(&aside, "new one")), vec!["new one.txt"]);
    assert_eq!(names(&q(&aside, "late arrival")), vec!["late arrival.txt"]);
    assert!(aside.is_excluded(&root("other/skip/x.txt")));
    assert!(aside.remove_root(&root("other")));
    assert_eq!(q(&aside, "keep").total, 0);
    // Saved and read back whole.
    let back = Index::from_bytes(&aside.to_bytes()).unwrap();
    assert_eq!(back.stats().entries, aside.stats().entries);
    // Small walks, folder rescans, cancelled walks and walks of folders not chosen stay in place.
    let c = two_roots(100);
    assert!(!c.worth_aside(&fresh_walk(100, 1)));
    let mut sub = Walked::start(&root("synthetic/Group 01"), dirm());
    assert!(!c.worth_aside(&sub));
    sub.cancelled = true;
    assert!(c.installed_aside(sub).is_err());
    let stray = Walked { path: root("elsewhere"), ..fresh_walk(10, 1) };
    assert!(c.installed_aside(stray).is_err());
}

/// A source that hands out a made-up tree of `n` entries for any root (the walk itself is not under any lock).
struct BigSource {
    n: usize,
    walks: AtomicU32,
}
impl Source for BigSource {
    fn walk(&self, spec: &RootSpec, dir: &Path, _ctrl: &WalkCtrl) -> Walked {
        let tree = synthetic_at(&spec.path, self.n);
        self.walks.fetch_add(1, Ordering::SeqCst);
        Walked { path: dir.to_path_buf(), tree, entries: self.n as u64, unreadable: 0, skipped: 0, cancelled: false, finished_ms: 1 }
    }
}

#[test]
fn a_search_is_not_held_up_while_a_big_walk_is_installed() {
    // In place, installing this walk held the write lock for the whole fill (about 0.4 s at a million entries,
    // built -O); aside, only a swap. The ceiling is generous: a debug build on a busy box searches 200 000 names
    // in well under it, and only a fill under the write lock would come near it.
    let n = 200_000;
    let src = Arc::new(BigSource { n, walks: AtomicU32::new(0) });
    let mut s = Service::start(ServiceOptions {
        file: None,
        roots: vec![RootSpec { path: root("synthetic"), ..RootSpec::default() }],
        source: src.clone(),
        fs: Arc::new(StdFs),
        watcher: Some(Box::new(FakeWatcher::default())),
        poll_interval: Duration::from_secs(3600),
        save_every: Duration::from_secs(3600),
        low_priority: false,
    });
    wait_until("the first walk", 60, || !s.status().busy && s.status().stats.entries as usize == n);
    // One quiet search for scale (the service's queries supersede each other: only one thread searches from here).
    let t = Instant::now();
    let _ = s.search(&Query::text("zzqx budget")).unwrap();
    let quiet = t.elapsed();
    let done = std::sync::atomic::AtomicBool::new(false);
    // (Set however the main thread leaves the scope, so the searching thread always ends.)
    struct Done<'a>(&'a std::sync::atomic::AtomicBool);
    impl Drop for Done<'_> {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let (worst, searches) = std::thread::scope(|sc| {
        let h = sc.spawn(|| {
            let (mut worst, mut searches) = (Duration::ZERO, 0u32);
            while !done.load(Ordering::SeqCst) {
                let t = Instant::now();
                if let Ok(r) = s.search(&Query::text("zzqx budget")) {
                    assert_eq!(r.total, 0);
                }
                worst = worst.max(t.elapsed());
                searches += 1;
            }
            (worst, searches)
        });
        let _done = Done(&done);
        // Two installs while the other thread searches.
        for k in 2..4 {
            s.rebuild();
            wait_until("the walk again", 60, || src.walks.load(Ordering::SeqCst) == k && !s.status().busy);
        }
        drop(_done);
        h.join().unwrap()
    });
    assert!(searches > 0);
    assert_eq!(s.status().stats.entries as usize, n);
    assert!(s.search(&Query::text("budget")).unwrap().total > 0);
    assert!(worst < quiet * 4 + Duration::from_millis(1500), "a search waited {worst:?} (a quiet one takes {quiet:?})");
    s.stop();
}

// ---- the shell's rules ----

#[test]
fn the_shells_rules_for_folders_battery_and_limits() {
    use shellrules::*;
    let chosen = vec![root("data/videos"), root("work")];
    let app = root("home/me/appdata/kurokawa-tools");
    assert_eq!(check_new_root(&chosen, &root("music"), true, Some(&app)), Ok(()));
    assert_eq!(check_new_root(&chosen, &root("data/videos/old"), true, Some(&app)), Err(Refusal::Inside(root("data/videos"))));
    assert_eq!(check_new_root(&chosen, &root("data"), true, Some(&app)), Err(Refusal::Holds(root("data/videos"))));
    assert_eq!(check_new_root(&chosen, &root("work"), true, Some(&app)), Err(Refusal::Same(root("work"))));
    // «/workshop» is not inside «/work».
    assert_eq!(check_new_root(&chosen, &root("workshop"), true, Some(&app)), Ok(()));
    assert_eq!(check_new_root(&chosen, &root("music"), false, Some(&app)), Err(Refusal::NotAFolder));
    assert_eq!(check_new_root(&chosen, Path::new("relative/x"), true, None), Err(Refusal::NotAFolder));
    assert_eq!(check_new_root(&chosen, &app, true, Some(&app)), Err(Refusal::AppData));
    assert_eq!(check_new_root(&chosen, &root("home/me/appdata/kurokawa-tools/cache"), true, Some(&app)), Err(Refusal::AppData));
    // A folder holding the app's data folder is fine: that one is left out of it.
    assert_eq!(check_new_root(&chosen, &root("home/me"), true, Some(&app)), Ok(()));
    let s = spec_for(&root("home/me"), &[root("home/me/tmp"), root("elsewhere/x"), root("home/me")], &["node_modules".into(), "a/b".into(), " .git ".into(), "..".into()], Some(&app));
    assert_eq!(s.exclude, vec![root("home/me/tmp"), app.clone()]);
    assert_eq!(s.exclude_names, vec!["node_modules".to_string(), ".git".to_string()]);
    assert_eq!(spec_for(&root("music"), &[], &[], Some(&app)).exclude, Vec::<PathBuf>::new());
    // Already left out by an exclusion above it: not added twice.
    assert_eq!(spec_for(&root("home/me"), &[root("home/me/appdata")], &[], Some(&app)).exclude, vec![root("home/me/appdata")]);
    assert_eq!(Refusal::Inside(root("w")).code(), ("inside", Some(root("w").as_path())));
    assert_eq!(clamp_limit(None), 200);
    assert_eq!(clamp_limit(Some(f64::NAN)), 200);
    assert_eq!(clamp_limit(Some(0.0)), 200);
    assert_eq!(clamp_limit(Some(750.0)), 750);
    assert_eq!(clamp_limit(Some(1e12)), MAX_HITS);
    let sup = |k: &str, on: Option<&str>, st: Option<&str>| Supply { kind: format!("{k}\n"), online: on.map(|x| format!("{x}\n")), status: st.map(|x| format!("{x}\n")) };
    assert_eq!(linux_on_battery(&[]), None);
    assert_eq!(linux_on_battery(&[sup("Mains", Some("1"), None), sup("Battery", None, Some("Charging"))]), Some(false));
    assert_eq!(linux_on_battery(&[sup("Mains", Some("0"), None), sup("Battery", None, Some("Discharging"))]), Some(true));
    assert_eq!(linux_on_battery(&[sup("Battery", None, Some("Discharging"))]), Some(true));
    assert_eq!(linux_on_battery(&[sup("Battery", None, Some("Full"))]), Some(false));
    assert_eq!(linux_on_battery(&[sup("Mains", Some("0"), None), sup("Battery", None, Some("Unknown"))]), Some(true));
    assert_eq!(linux_on_battery(&[sup("Mains", Some("1"), None)]), Some(false));
    assert_eq!(windows_on_battery(0, 1), Some(true));
    assert_eq!(windows_on_battery(1, 8), Some(false));
    assert_eq!(windows_on_battery(0, 128), Some(false));
    assert_eq!(windows_on_battery(255, 1), None);
    let _ = on_battery();
}

// ---- size and speed ----

/// A made-up tree of `n` entries: 1 000 folders in 50 groups, names from a small vocabulary with numbers, some
/// Arabic and Japanese (deterministic).
fn synthetic(n: usize) -> Index {
    synthetic_at(&root("synthetic"), n)
}

fn synthetic_at(at: &Path, n: usize) -> Index {
    let words = ["report", "holiday", "video", "song", "budget", "scan", "invoice", "draft", "final", "photo",
        "lecture", "episode", "backup", "notes", "summary", "تقرير", "صورة", "مدرسة", "東京", "写真", "project", "data"];
    let exts = ["txt", "pdf", "mp4", "jpg", "mkv", "flac", "docx", "zip", "png", "rs", "js", "json"];
    let mut ix = Index::new();
    ix.reserve(n + 2000, n * 26);
    ix.add_root(RootSpec { path: at.to_path_buf(), ..RootSpec::default() }).unwrap();
    let top = ix.find(at).unwrap();
    let mut x: u64 = 0x2545F4914F6CDD1D;
    let mut rnd = || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    let mut dirs = Vec::new();
    for g in 0..50 {
        let gd = ix.insert(top, OsStr::new(&format!("Group {g:02}")), dirm()).unwrap();
        for d in 0..20 {
            let id = ix.insert(gd, OsStr::new(&format!("{} {}", words[(g * 20 + d) % words.len()], d)), dirm()).unwrap();
            dirs.push(id);
        }
    }
    let made = ix.stats().entries as usize;
    for i in 0..n.saturating_sub(made) {
        let r = rnd();
        let w1 = words[(r % words.len() as u64) as usize];
        let w2 = words[((r >> 8) % words.len() as u64) as usize];
        let e = exts[((r >> 16) % exts.len() as u64) as usize];
        let name = format!("{}_{} {:05}.{}", if r & 1 == 0 { w1.to_uppercase() } else { w1.to_string() }, w2, (r >> 24) % 100_000, e);
        let parent = dirs[i % dirs.len()];
        ix.insert(parent, OsStr::new(&name), file((r >> 32) % 10_000_000, 1_600_000_000_000 + ((r >> 40) as i64))).unwrap();
    }
    ix
}

#[test]
fn speed_sanity_200k() {
    // Not a benchmark (debug builds are slow and the box is shared): a generous ceiling that only a broken scan
    // (quadratic work, a path built per entry) would pass.
    let ix = synthetic(200_000);
    let s = Searcher::new();
    let t0 = Instant::now();
    let r = ix.search(&Query::text("report 123"), &s.begin()).unwrap();
    assert!(r.total > 0);
    assert!(t0.elapsed() < Duration::from_secs(10), "{:?}", t0.elapsed());
}

#[test]
#[ignore]
fn speed_one_million() {
    let t0 = Instant::now();
    let ix = synthetic(1_000_000);
    let build = t0.elapsed();
    let st = ix.stats();
    println!("built {} entries in {:?}; memory {:.1} MB ({:.1} bytes an entry)", st.entries, build, st.memory_bytes as f64 / 1e6, st.memory_bytes as f64 / st.entries as f64);
    let s = Searcher::new();
    let cases: Vec<(&str, Query)> = vec![
        ("substring «budget»", Query::text("budget")),
        ("substring «port 12»", Query::text("port 12")),
        ("rare «zzqx»", Query::text("zzqx")),
        ("one letter «e»", Query::text("e")),
        ("Arabic «تقرير»", Query::text("تقرير")),
        ("Japanese «写真»", Query::text("写真")),
        ("wildcard «*.mkv»", Query::text("*.mkv")),
        ("word + ext + size", Query { text: "final".into(), exts: vec!["pdf".into()], size_min: Some(1_000_000), ..Query::default() }),
        ("«scan 07» + path:group", Query::text("scan 07 path:group")),
        ("«video» by size", Query { text: "video".into(), sort: SortKey::Size, descending: true, ..Query::default() }),
        ("«video» by path", Query { text: "video".into(), sort: SortKey::Path, ..Query::default() }),
    ];
    for (label, query) in &cases {
        // Best of 5 (the box is shared): the figure a quiet machine gives.
        let mut best = Duration::MAX;
        let mut total = 0;
        for _ in 0..5 {
            let t = Instant::now();
            let r = ix.search(query, &s.begin()).unwrap();
            best = best.min(t.elapsed());
            total = r.total;
        }
        println!("{label:28} {:>8.1} ms  ({total} matches)", best.as_secs_f64() * 1e3);
    }
    let t = Instant::now();
    let bytes = ix.to_bytes();
    let ser = t.elapsed();
    let t = Instant::now();
    let back = Index::from_bytes(&bytes).unwrap();
    println!("file {:.1} MB, written in {:?}, read and checked in {:?}", bytes.len() as f64 / 1e6, ser, t.elapsed());
    assert_eq!(back.stats().entries, st.entries);
    // Installing a fresh walk of the same root (the time the write lock is held: queries wait that long).
    let mut ix = ix;
    let fresh = synthetic(1_000_000);
    let t = Instant::now();
    assert!(ix.install(Walked { path: root("synthetic"), tree: fresh, entries: 0, unreadable: 0, skipped: 0, cancelled: false, finished_ms: 1 }));
    println!("in place: a 1,000,000-entry walk installed over the old one in {:?} (all under the write lock); memory now {:.1} MB", t.elapsed(), ix.stats().memory_bytes as f64 / 1e6);
    assert_eq!(ix.stats().entries, st.entries);
    // Aside (what the service does): built under the shared lock, then swapped in; the old one dropped after.
    let fresh = synthetic(1_000_000);
    let t = Instant::now();
    let built = ix.installed_aside(Walked { path: root("synthetic"), tree: fresh, entries: 0, unreadable: 0, skipped: 0, cancelled: false, finished_ms: 2 }).ok().unwrap();
    let build = t.elapsed();
    let t = Instant::now();
    let old = std::mem::replace(&mut ix, built);
    let lock = t.elapsed();
    let t = Instant::now();
    drop(old);
    println!("aside: built in {build:?} (shared lock), swapped in {lock:?} (the write lock), the old one dropped in {:?} (no lock); memory now {:.1} MB", t.elapsed(), ix.stats().memory_bytes as f64 / 1e6);
    assert_eq!(ix.stats().entries, st.entries);
    // A real walk of a made-up tree (20 000 files in 200 folders) on this disk.
    let tmp = Tmp::new("walkspeed");
    for d in 0..200 {
        let dir = tmp.dir(&format!("d{d}"));
        for f in 0..100 {
            std::fs::write(dir.join(format!("file {f} of {d}.txt")), b"").unwrap();
        }
    }
    let spec = RootSpec { path: tmp.0.clone(), ..RootSpec::default() };
    let t = Instant::now();
    let w = DirWalker::new(StdFs).walk(&spec, &tmp.0, &WalkCtrl::new());
    let el = t.elapsed();
    println!("walked {} entries on disk in {:?} ({:.0} entries a second, cached)", w.entries, el, w.entries as f64 / el.as_secs_f64());
    let mut best = Duration::MAX;
    for _ in 0..5 {
        let t = Instant::now();
        ix.search(&Query::text("budget"), &s.begin()).unwrap();
        best = best.min(t.elapsed());
    }
    assert!(best < Duration::from_millis(60), "substring over 1M took {best:?}");
}
