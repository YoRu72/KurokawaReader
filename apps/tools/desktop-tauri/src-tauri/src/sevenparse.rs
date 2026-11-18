// The pure parts of making a 7z with the 7-Zip the app ships (archives.rs's create_7z), std only so that they are tested alone:
//   rustc --edition 2021 --test sevenparse.rs -o /tmp/sevenparse && /tmp/sevenparse
// The same rules as desktop/archive.cjs's create7z (tests/archive7z.cjs holds that side's checks).
use std::path::{Path, PathBuf};

/// One line of 7-Zip's progress («  5% 3 + name», or just «  5%») → (percent, name of the file being added or "").
pub fn progress(line: &str) -> Option<(u64, String)> {
    let l = line.trim_start();
    let digits: String = l.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() || !l[digits.len()..].starts_with('%') {
        return None;
    }
    let mut rest = l[digits.len() + 1..].trim_start();
    let skip = rest.chars().take_while(|c| c.is_ascii_digit()).count();
    if skip > 0 {
        rest = rest[skip..].trim_start();
    }
    let name = rest.strip_prefix("+ ").unwrap_or("").to_string();
    Some((digits.parse().unwrap_or(0), name))
}

/// Output cut into lines as it arrives: 7-Zip ends its progress with a carriage return, or erases it with backspaces; a line
/// split between two reads is carried to the next; nothing but the unfinished line is kept.
#[derive(Default)]
pub struct Lines {
    pending: String,
}
impl Lines {
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.push_str(&String::from_utf8_lossy(chunk));
        let mut out = Vec::new();
        while let Some(i) = self.pending.find(|c| c == '\r' || c == '\n' || c == '\u{8}') {
            let line: String = self.pending[..i].to_string();
            let skip = self.pending[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
            self.pending.drain(..i + skip);
            if !line.trim().is_empty() {
                out.push(line);
            }
        }
        // (A very long line without an end is not a progress line: kept short.)
        if self.pending.len() > 4096 {
            let cut = self.pending.len() - 1024;
            let mut c = cut;
            while !self.pending.is_char_boundary(c) {
                c += 1;
            }
            self.pending.drain(..c);
        }
        out
    }
    pub fn finish(&mut self) -> Option<String> {
        let l = std::mem::take(&mut self.pending);
        if l.trim().is_empty() { None } else { Some(l) }
    }
}

/// A message with the password taken out of it (7-Zip or the system may print the command line).
pub fn scrub(msg: &str, password: Option<&str>) -> String {
    match password {
        Some(p) if !p.is_empty() => msg.replace(p, "***").replace(&format!("-p{}", p), "-p***"),
        _ => msg.to_string(),
    }
}

/// The inputs grouped by the folder they are in (the order kept): each group is run by 7-Zip in its folder, given the names,
/// so the archive holds «name/…» and never an absolute path. Two inputs of one name (from different folders) would meet in
/// the archive: refused.
pub fn groups(inputs: &[PathBuf]) -> Result<Vec<(PathBuf, Vec<String>)>, String> {
    let mut out: Vec<(PathBuf, Vec<String>)> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for p in inputs {
        let parent = p.parent().filter(|x| !x.as_os_str().is_empty()).ok_or_else(|| "sevenZipNoFolder".to_string())?.to_path_buf();
        let n = p.file_name().map(|x| x.to_string_lossy().to_string()).ok_or_else(|| "sevenZipNoFolder".to_string())?;
        if seen.contains(&n) {
            return Err("sevenZipSameName".into());
        }
        seen.push(n.clone());
        match out.iter_mut().find(|g| g.0 == parent) {
            Some(g) => g.1.push(n),
            None => out.push((parent, vec![n])),
        }
    }
    if out.is_empty() {
        return Err("sevenZipNoFolder".into());
    }
    Ok(out)
}

/// True when `out` is one of the inputs or lies inside one (the archive being written must never be packed into itself).
pub fn out_inside(out: &Path, inputs: &[PathBuf]) -> bool {
    inputs.iter().any(|i| out == i.as_path() || out.starts_with(i))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_lines() {
        assert_eq!(progress("  5% 3 + docs/a.txt"), Some((5, "docs/a.txt".to_string())));
        assert_eq!(progress(" 12%"), Some((12, String::new())));
        assert_eq!(progress("100% 12 + x y.txt"), Some((100, "x y.txt".to_string())));
        assert_eq!(progress("+ docs/a.txt"), None);
        assert_eq!(progress("Everything is Ok"), None);
    }
    #[test]
    fn lines_carry_a_split_line_and_know_all_three_ends() {
        let mut l = Lines::default();
        assert_eq!(l.feed(b"  5% 1 + a"), Vec::<String>::new());
        assert_eq!(l.feed(b".txt\r 10% 2 + b.txt\r"), vec!["  5% 1 + a.txt".to_string(), " 10% 2 + b.txt".to_string()]);
        assert_eq!(l.feed(b" 20%\x08\x08\x08\x08 30% 3 + c\n"), vec![" 20%".to_string(), " 30% 3 + c".to_string()]);
        assert_eq!(l.feed(b"tail"), Vec::<String>::new());
        assert_eq!(l.finish(), Some("tail".to_string()));
    }
    #[test]
    fn lines_keep_only_the_unfinished_part() {
        let mut l = Lines::default();
        let big = vec![b'x'; 100_000];
        l.feed(&big);
        assert!(l.pending.len() <= 4096);
        let mut k = Lines::default();
        for _ in 0..1000 {
            k.feed(b"  1% 1 + f\r");
        }
        assert_eq!(k.pending.len(), 0);
    }
    #[test]
    fn scrub_takes_the_password_out() {
        assert_eq!(scrub("7z a -psesame -mhe=on x", Some("sesame")), "7z a -p*** -mhe=on x");
        assert_eq!(scrub("no secret here", Some("sesame")), "no secret here");
        assert_eq!(scrub("anything", None), "anything");
        assert_eq!(scrub("anything", Some("")), "anything");
    }
    #[test]
    fn groups_by_folder_and_refuses_one_name_twice() {
        let g = groups(&[PathBuf::from("/a/x.txt"), PathBuf::from("/b/y.txt"), PathBuf::from("/a/z")]).unwrap();
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].0, PathBuf::from("/a"));
        assert_eq!(g[0].1, vec!["x.txt".to_string(), "z".to_string()]);
        assert_eq!(g[1].1, vec!["y.txt".to_string()]);
        assert_eq!(groups(&[PathBuf::from("/a/x"), PathBuf::from("/b/x")]).unwrap_err(), "sevenZipSameName");
        assert_eq!(groups(&[]).unwrap_err(), "sevenZipNoFolder");
        assert_eq!(groups(&[PathBuf::from("x")]).unwrap_err(), "sevenZipNoFolder");
    }
    #[test]
    fn output_inside_an_input_is_found() {
        let ins = [PathBuf::from("/a/docs"), PathBuf::from("/a/x.txt")];
        assert!(out_inside(Path::new("/a/docs/all.7z"), &ins));
        assert!(out_inside(Path::new("/a/x.txt"), &ins));
        assert!(!out_inside(Path::new("/a/all.7z"), &ins));
        assert!(!out_inside(Path::new("/a/docs2/all.7z"), &ins));
    }
}
