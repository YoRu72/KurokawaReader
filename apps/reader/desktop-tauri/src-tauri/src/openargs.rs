// What the system hands the app to open — on its command line (double-click, «Open with», a second launch), or as
// addresses (a Mac's Apple Events) — sorted as desktop/main.cjs sorts it: kurokawareader:// links for the page's
// onOpenUrl; files with one of main.cjs's DOC_EXT extensions that are there, for its onOpenFile; anything else (the
// program itself, switches, a missing file, another kind of file) left alone. Relative paths are taken from the
// folder the launch was made in. Std only, checked alone with `rustc --edition 2021 --test openargs.rs`.
use std::path::Path;

/// desktop/main.cjs's DOC_EXT: the kinds of file the app opens when the system hands them to it.
pub const DOC_EXT: [&str; 25] = [
    "epub", "pdf", "docx", "xlsx", "pptx", "txt", "md", "markdown", "html", "htm", "fb2", "odt", "cbz", "csv", "tsv",
    "jpg", "jpeg", "png", "gif", "webp", "ttf", "otf", "woff", "woff2", "zip",
];

/// The app's own links (cloud-sync sign-ins, «open» links), any case.
pub fn is_link(a: &str) -> bool {
    a.len() >= 15 && a[..15].eq_ignore_ascii_case("kurokawareader:")
}

/// Whether a file's name has one of DOC_EXT's extensions (any case).
pub fn wanted(name: &str) -> bool {
    match name.rfind('.') {
        Some(i) if i + 1 < name.len() => {
            let ext = name[i + 1..].to_ascii_lowercase();
            DOC_EXT.contains(&ext.as_str())
        }
        _ => false,
    }
}

fn hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// A file:// address (a Mac hands opened files over as these) → the path; None when it is none.
pub fn file_url_path(s: &str, windows: bool) -> Option<String> {
    if s.len() < 7 || !s[..7].eq_ignore_ascii_case("file://") {
        return None;
    }
    let mut rest = &s[7..];
    // (file://localhost/… is the same as file:///…)
    if rest.len() >= 9 && rest[..9].eq_ignore_ascii_case("localhost") {
        rest = &rest[9..];
    }
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let b = rest.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
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
        // («/C:/a/b.pdf» → «C:/a/b.pdf»; a share «//server/x» kept.)
        let t = p.strip_prefix('/').unwrap_or(&p);
        if t.len() >= 2 && t.as_bytes()[1] == b':' {
            return Some(t.replace('/', "\\"));
        }
        return Some(p.replace('/', "\\"));
    }
    Some(p)
}

/// The arguments of a launch (the program's own name left out) → (files to open, links), in their order, each once.
pub fn sort(args: &[String], cwd: &Path, windows: bool) -> (Vec<String>, Vec<String>) {
    let mut files: Vec<String> = Vec::new();
    let mut links: Vec<String> = Vec::new();
    for a in args.iter() {
        let a = a.trim();
        if a.is_empty() {
            continue;
        }
        if is_link(a) {
            if !links.iter().any(|x| x == a) {
                links.push(a.to_string());
            }
            continue;
        }
        let raw = match file_url_path(a, windows) {
            Some(p) => p,
            None => {
                if a.starts_with('-') {
                    continue;
                }
                a.to_string()
            }
        };
        let p = Path::new(&raw);
        let full = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
        let name = match full.file_name() {
            Some(n) => n.to_string_lossy().into_owned(),
            None => continue,
        };
        if !wanted(&name) || !full.is_file() {
            continue;
        }
        let s = full.to_string_lossy().into_owned();
        if !files.iter().any(|x| x == &s) {
            files.push(s);
        }
    }
    (files, links)
}

/// A path's last part (the name the page is given with the file's bytes).
pub fn name_of(p: &str) -> String {
    let t = p.trim_end_matches(['/', '\\']);
    match t.rfind(['/', '\\']) {
        Some(i) => t[i + 1..].to_string(),
        None => t.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kr-openargs-test-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn kinds() {
        assert!(wanted("a.EPUB") && wanted("b.pdf") && wanted("c.woff2") && wanted("x.y.Md"));
        assert!(!wanted("a.exe") && !wanted("noext") && !wanted("a.") && !wanted("a.mobi"));
        assert!(is_link("kurokawareader://open?to=/") && is_link("KurokawaReader:x") && !is_link("https://x") && !is_link("kuro"));
        assert_eq!(name_of("/a/b/c d.epub"), "c d.epub");
        assert_eq!(name_of("C:\\x\\y.pdf"), "y.pdf");
        assert_eq!(name_of("z.txt"), "z.txt");
    }

    #[test]
    fn file_urls() {
        assert_eq!(file_url_path("file:///home/a%20b.epub", false).as_deref(), Some("/home/a b.epub"));
        assert_eq!(file_url_path("file:///Users/x/%D9%86%D8%B5.pdf", false).as_deref(), Some("/Users/x/نص.pdf"));
        assert_eq!(file_url_path("file://localhost/tmp/a.txt", false).as_deref(), Some("/tmp/a.txt"));
        assert_eq!(file_url_path("file:///C:/a/b%25.pdf", true).as_deref(), Some("C:\\a\\b%.pdf"));
        assert_eq!(file_url_path("file:///tmp/a.txt?x=1#y", false).as_deref(), Some("/tmp/a.txt"));
        assert_eq!(file_url_path("/tmp/a.txt", false), None);
        assert_eq!(file_url_path("file:///a%2", false).as_deref(), Some("/a%2"));
    }

    #[test]
    fn sorting() {
        let d = scratch("sort");
        fs::write(d.join("book.epub"), b"1").unwrap();
        fs::write(d.join("Doc Two.PDF"), b"1").unwrap();
        fs::write(d.join("tool.exe"), b"1").unwrap();
        fs::create_dir_all(d.join("dir.epub")).unwrap();
        let abs = d.join("Doc Two.PDF").to_string_lossy().into_owned();
        let args: Vec<String> = vec![
            "--flag".into(),
            "book.epub".into(),
            abs.clone(),
            "kurokawareader://open?to=%2F".into(),
            "tool.exe".into(),
            "missing.pdf".into(),
            "dir.epub".into(),
            "book.epub".into(),
            "  ".into(),
            "kurokawareader://open?to=%2F".into(),
        ];
        let (files, links) = sort(&args, &d, false);
        assert_eq!(files, vec![d.join("book.epub").to_string_lossy().into_owned(), abs.clone()]);
        assert_eq!(links, vec!["kurokawareader://open?to=%2F".to_string()]);
        if !cfg!(windows) {
            let url = format!("file://{}", abs.replace(' ', "%20"));
            let (f2, _) = sort(&[url], Path::new("/"), false);
            assert_eq!(f2, vec![abs]);
        }
        let _ = fs::remove_dir_all(&d);
    }
}
