// kr:scan-device (desktop/main.cjs): the whole-computer scan for books — the home folder, and on Windows every other
// drive (D: to Z:) —, breadth first, seven folders deep at most, hidden folders and the system's own skipped, at most
// 8000 files and 20000 folders. The same walk, limits and answer as main.cjs: { root, files: [{ path, name, size }],
// truncated }. Std only, checked alone with `rustc --edition 2021 --test scan.rs`.
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};

/// Folders never entered (main.cjs's `skip`).
pub const SKIP: [&str; 9] = [
    "node_modules",
    "AppData",
    "Library",
    ".git",
    "Windows",
    "Program Files",
    "Program Files (x86)",
    "$RECYCLE.BIN",
    "System Volume Information",
];
pub const MAX_FILES: usize = 8000;
pub const MAX_FOLDERS: usize = 20000;
pub const MAX_DEPTH: usize = 7;

pub struct Found {
    pub path: String,
    pub name: String,
    pub size: u64,
}

pub struct Scan {
    pub root: String,
    pub files: Vec<Found>,
    pub truncated: bool,
}

/// Node's `path.extname(name).slice(1).toLowerCase()`: «a.EPUB» → «epub», «.bashrc» → «», «a.» → «».
pub fn ext_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => name[i + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// Where the scan starts: the home folder, and on Windows each drive from D: to Z: that is there.
pub fn roots(home: &Path, windows: bool) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = vec![home.to_path_buf()];
    if windows {
        for letter in b'D'..=b'Z' {
            let d = PathBuf::from(format!("{}:\\", letter as char));
            if d.exists() {
                out.push(d);
            }
        }
    }
    out
}

/// The walk: files whose extension is one of `exts` (any file when `exts` is empty).
pub fn scan(roots: &[PathBuf], exts: &[String]) -> Scan {
    let wanted: Vec<String> = exts.iter().map(|x| x.to_lowercase()).collect();
    let mut files: Vec<Found> = Vec::new();
    let mut visited: usize = 0;
    let mut truncated = false;
    let mut queue: VecDeque<(PathBuf, usize)> = roots.iter().map(|r| (r.clone(), 0)).collect();
    while !queue.is_empty() && files.len() < MAX_FILES {
        let (dir, depth) = match queue.pop_front() {
            Some(x) => x,
            None => break,
        };
        visited += 1;
        if visited > MAX_FOLDERS {
            truncated = true;
            break;
        }
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for item in rd {
            let e = match item {
                Ok(e) => e,
                Err(_) => continue,
            };
            let name = e.file_name().to_string_lossy().into_owned();
            let full = dir.join(&name);
            // (The entry's own type, links not followed — as Node's Dirent: a link is neither a folder nor a file.)
            let ft = match e.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_dir() {
                if depth < MAX_DEPTH && !name.starts_with('.') && !SKIP.contains(&name.as_str()) {
                    queue.push_back((full, depth + 1));
                }
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            if !wanted.is_empty() && !wanted.contains(&ext_of(&name)) {
                continue;
            }
            if let Ok(md) = fs::metadata(&full) {
                files.push(Found {
                    path: full.to_string_lossy().into_owned(),
                    name,
                    size: md.len(),
                });
            }
        }
    }
    if !queue.is_empty() {
        truncated = true;
    }
    let root: Vec<String> = roots
        .iter()
        .map(|r| r.to_string_lossy().into_owned())
        .collect();
    Scan {
        root: root.join(" · "),
        files,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kr-scan-test-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn extensions() {
        assert_eq!(ext_of("Book.EPUB"), "epub");
        assert_eq!(ext_of("a.b.pdf"), "pdf");
        assert_eq!(ext_of(".bashrc"), "");
        assert_eq!(ext_of("a."), "");
        assert_eq!(ext_of("noext"), "");
    }

    #[test]
    fn walk() {
        let d = scratch("walk");
        fs::write(d.join("a.epub"), b"12345").unwrap();
        fs::write(d.join("b.PDF"), b"1").unwrap();
        fs::write(d.join("c.txt"), b"1").unwrap();
        fs::create_dir_all(d.join("sub").join("deeper")).unwrap();
        fs::write(d.join("sub").join("deeper").join("d.epub"), b"1").unwrap();
        fs::create_dir_all(d.join(".hidden")).unwrap();
        fs::write(d.join(".hidden").join("e.epub"), b"1").unwrap();
        fs::create_dir_all(d.join("node_modules")).unwrap();
        fs::write(d.join("node_modules").join("f.epub"), b"1").unwrap();
        // Eight levels: the file at the bottom is past the depth limit.
        let mut deep = d.clone();
        for i in 0..8 {
            deep = deep.join(format!("l{}", i));
        }
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("g.epub"), b"1").unwrap();
        fs::write(d.join("l0").join("h.epub"), b"1").unwrap();
        let s = scan(&[d.clone()], &["EPUB".to_string(), "pdf".to_string()]);
        let mut names: Vec<String> = s.files.iter().map(|f| f.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["a.epub", "b.PDF", "d.epub", "h.epub"]);
        let a = s.files.iter().find(|f| f.name == "a.epub").unwrap();
        assert_eq!(a.size, 5);
        assert_eq!(a.path, d.join("a.epub").to_string_lossy());
        assert!(!s.truncated);
        assert_eq!(s.root, d.to_string_lossy());
        // Breadth first: the files of the top folder come before those below it.
        assert!(s.files[0].name == "a.epub" || s.files[0].name == "b.PDF");
        let all = scan(&[d.clone()], &[]);
        assert!(all.files.iter().any(|f| f.name == "c.txt"));
        let none = scan(&[d.join("missing")], &["epub".to_string()]);
        assert!(none.files.is_empty() && !none.truncated);
        let two = scan(&[d.join("sub"), d.join("l0")], &["epub".to_string()]);
        assert_eq!(two.root, format!("{} · {}", d.join("sub").to_string_lossy(), d.join("l0").to_string_lossy()));
        assert_eq!(roots(&d, false), vec![d.clone()]);
        let _ = fs::remove_dir_all(&d);
    }
}
