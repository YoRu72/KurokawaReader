// The downloader's rules that need no crate (download.rs does the fetching): a file name made safe for the
// downloads folder, whether a path is inside that folder, the total size from a Content-Range, how a file is cut into
// parts, and the speed shown — each as desktop/main.cjs's kr:download / kr:delete-download (downloadSegmented) does
// it. Std only, checked alone with `rustc --edition 2021 --test dlplan.rs`.
use std::path::{Component, Path, PathBuf};

pub const MIB: u64 = 1024 * 1024;

/// main.cjs: `String(name).replace(/[\\/:*?"<>|]/g, '_')`; here also control characters, and a name that would
/// leave the folder or name none («», «.», «..») → «download», and one too long for a file system cut (its
/// extension kept).
pub fn safe_name(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '_' } else { c })
        .collect();
    if s.trim().is_empty() || s == "." || s == ".." {
        s = "download".to_string();
    }
    if s.len() > 200 {
        let ext: String = match s.rfind('.') {
            Some(i) if s.len() - i <= 16 => s[i..].to_string(),
            _ => String::new(),
        };
        let mut cut = 200 - ext.len();
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s = format!("{}{}", &s[..cut], ext);
    }
    s
}

/// A path with «.» and «..» worked out by its text alone (as Node's path.resolve does for an absolute path).
pub fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// main.cjs's kr:delete-download test: the file is inside the downloads folder (not the folder itself, not outside
/// it by «..»).
pub fn inside(dir: &Path, p: &str) -> bool {
    let d = normalize(dir);
    let f = normalize(Path::new(p));
    f != d && f.starts_with(&d) && f.is_absolute()
}

/// «bytes 0-0/12345» → 12345.
pub fn range_total(content_range: &str) -> Option<u64> {
    let total = content_range.rsplit('/').next()?.trim();
    match total.parse::<u64>() {
        Ok(n) if n > 0 => Some(n),
        _ => None,
    }
}

/// Whether a file of `total` bytes, whose server answers ranges, is fetched in parts (main.cjs: over 2 MiB).
pub fn in_parts(total: u64) -> bool {
    total > 2 * MIB
}

/// main.cjs's cut: (connections, part size) — up to eight connections, parts of 1–8 MiB, about four per connection.
pub fn plan(total: u64) -> (u64, u64) {
    let n = (total / 524_288).clamp(1, 8);
    let chunk = (total / (n * 4)).clamp(MIB, 8 * MIB);
    (n, chunk)
}

/// The speed shown: the last one smoothed with what came since (main.cjs's report).
pub fn smooth(prev: f64, inst: f64) -> f64 {
    if prev > 0.0 {
        prev * 0.6 + inst * 0.4
    } else {
        inst
    }
}

/// The percentage shown: of the total when it is known, 0 otherwise.
pub fn pct(got: u64, total: u64) -> u64 {
    if total == 0 {
        0
    } else {
        ((got as f64 / total as f64) * 100.0).round() as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(safe_name("a/b\\c:d*e?f\"g<h>i|j.epub"), "a_b_c_d_e_f_g_h_i_j.epub");
        assert_eq!(safe_name("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(safe_name(".."), "download");
        assert_eq!(safe_name(""), "download");
        assert_eq!(safe_name("a\u{0}b\nc"), "a_b_c");
        assert_eq!(safe_name("كتاب ✓.pdf"), "كتاب ✓.pdf");
        let long = format!("{}.epub", "ن".repeat(300));
        let s = safe_name(&long);
        assert!(s.len() <= 200 && s.ends_with(".epub"), "{}", s.len());
    }

    #[test]
    fn inside_dir() {
        let d = if cfg!(windows) { PathBuf::from("C:\\data\\downloads") } else { PathBuf::from("/data/downloads") };
        let j = |x: &str| d.join(x).to_string_lossy().into_owned();
        assert!(inside(&d, &j("a.epub")));
        assert!(inside(&d, &j("sub/../a.epub")));
        assert!(!inside(&d, &j("../a.epub")));
        assert!(!inside(&d, &j("..")));
        assert!(!inside(&d, &d.to_string_lossy()));
        assert!(!inside(&d, "relative/a.epub"));
        let other = if cfg!(windows) { "C:\\data\\downloads-other\\a" } else { "/data/downloads-other/a" };
        assert!(!inside(&d, other));
    }

    #[test]
    fn ranges_and_plan() {
        assert_eq!(range_total("bytes 0-0/3145728"), Some(3_145_728));
        assert_eq!(range_total("bytes 0-0/*"), None);
        assert_eq!(range_total("bytes 0-0/0"), None);
        assert!(!in_parts(2 * MIB) && in_parts(2 * MIB + 1));
        assert_eq!(plan(3 * MIB), (6, MIB));
        assert_eq!(plan(100 * MIB), (8, 3_276_800));
        assert_eq!(plan(1000 * MIB), (8, 8 * MIB));
        assert_eq!(plan(1), (1, MIB));
    }

    #[test]
    fn speed_and_pct() {
        assert_eq!(smooth(0.0, 10.0), 10.0);
        assert_eq!(smooth(10.0, 20.0), 14.0);
        assert_eq!(pct(1, 3), 33);
        assert_eq!(pct(5, 0), 0);
        assert_eq!(pct(3, 3), 100);
    }
}
