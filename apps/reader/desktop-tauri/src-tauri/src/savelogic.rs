// PDF → Word, «In a folder»: a converted file and its fonts written into the folders the reader chose (std only, so it
// is checked alone: `rustc --edition 2021 --test savelogic.rs`, the workflow's «Std-only unit tests»). The page names
// each file by a short path under the chosen folder («Report.docx», «Report fonts/Carlito-Regular.ttf»); nothing here
// writes outside that folder, over a file that is there, or leaves half a file behind:
//  - a path is a file name, or a folder name and a file name, each one a name every system takes (no «..», no
//    separators, no reserved or device names, no trailing dot or space);
//  - plan(): for each file, the name it will have — its own where nothing is there; «name (2).ext», «name (3).ext» where
//    another file is; and nothing to write where a file of that name already holds exactly these bytes (size and SHA-256);
//  - put(): a file written in parts to «name.krpart» and put in its place when whole (never over one that is there);
//  - undo(): what this save made taken away — the files, and a folder only if it was made by this save and is empty.
#![allow(dead_code)]
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// The suffix of a file that is being written.
pub const PART: &str = ".krpart";

/// One file asked for: its path under the chosen folder, its size and SHA-256 (lower-case hex; «» when not known).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub rel: String,
    pub size: u64,
    pub sha: String,
}

/// What is to be done for one file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    /// Write it, under this path.
    Write(String),
    /// A file under this path already holds these bytes: nothing to write.
    Same(String),
}

/// A name every file system takes (checked for a single path component).
pub fn name_ok(n: &str) -> bool {
    if n.is_empty() || n == "." || n == ".." || n.len() > 200 {
        return false;
    }
    if n.ends_with('.') || n.ends_with(' ') || n.starts_with(' ') {
        return false;
    }
    if n.chars().any(|c| c.is_control() || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')) {
        return false;
    }
    let stem = n.split('.').next().unwrap_or("").to_ascii_lowercase();
    let stem = stem.trim_end();
    let reserved = matches!(stem, "con" | "prn" | "aux" | "nul")
        || ((stem.starts_with("com") || stem.starts_with("lpt")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit() && stem.as_bytes()[3] != b'0');
    !reserved && !n.ends_with(PART)
}

/// A path under the chosen folder, taken apart: (the folder under it, if any; the file's name).
pub fn split_rel(rel: &str) -> Result<(Option<String>, String), String> {
    let parts: Vec<&str> = rel.split('/').collect();
    match parts.as_slice() {
        [f] if name_ok(f) => Ok((None, (*f).to_string())),
        [d, f] if name_ok(d) && name_ok(f) => Ok((Some((*d).to_string()), (*f).to_string())),
        _ => Err(format!("not a file name: {}", rel)),
    }
}

fn join(dir: &Path, sub: &Option<String>, name: &str) -> PathBuf {
    match sub {
        Some(s) => dir.join(s).join(name),
        None => dir.join(name),
    }
}

/// «name.ext» → «name (n).ext» (n ≥ 2).
pub fn numbered(name: &str, n: u32) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => format!("{} ({}){}", &name[..i], n, &name[i..]),
        _ => format!("{} ({})", name, n),
    }
}

/* ---------- SHA-256 ---------- */

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// SHA-256, fed in pieces.
pub struct Sha256 {
    h: [u32; 8],
    buf: Vec<u8>,
    len: u64,
}

impl Sha256 {
    pub fn new() -> Sha256 {
        Sha256 { h: [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], buf: Vec::new(), len: 0 }
    }
    fn block(&mut self, b: &[u8]) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([b[i * 4], b[i * 4 + 1], b[i * 4 + 2], b[i * 4 + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b2, mut c, mut d, mut e, mut f, mut g, mut h] = self.h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = h.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b2) ^ (a & c) ^ (b2 & c);
            let t2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b2;
            b2 = a;
            a = t1.wrapping_add(t2);
        }
        for (x, y) in self.h.iter_mut().zip([a, b2, c, d, e, f, g, h]) {
            *x = x.wrapping_add(y);
        }
    }
    pub fn update(&mut self, data: &[u8]) {
        self.len += data.len() as u64;
        self.buf.extend_from_slice(data);
        let whole = self.buf.len() / 64 * 64;
        if whole > 0 {
            let chunk: Vec<u8> = self.buf.drain(..whole).collect();
            for b in chunk.chunks(64) {
                self.block(b);
            }
        }
    }
    pub fn hex(mut self) -> String {
        let bits = self.len * 8;
        let mut tail = vec![0x80u8];
        while (self.buf.len() + tail.len()) % 64 != 56 {
            tail.push(0);
        }
        tail.extend_from_slice(&bits.to_be_bytes());
        let keep = self.len;
        self.update(&tail);
        self.len = keep;
        self.h.iter().map(|x| format!("{:08x}", x)).collect()
    }
}

/// The SHA-256 of a file, as lower-case hex.
pub fn sha_file(p: &Path) -> std::io::Result<String> {
    let mut f = fs::File::open(p)?;
    let mut s = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        s.update(&buf[..n]);
    }
    Ok(s.hex())
}

/* ---------- the plan, the writing, the undoing ---------- */

fn want_dir(dir: &Path) -> Result<(), String> {
    match fs::metadata(dir) {
        Ok(m) if m.is_dir() => Ok(()),
        _ => Err(format!("not a folder: {}", dir.display())),
    }
}

/// Is `p` a real folder (not a link to somewhere else)?
fn plain_dir(p: &Path) -> bool {
    match fs::symlink_metadata(p) {
        Ok(m) => m.is_dir() && !m.file_type().is_symlink(),
        Err(_) => false,
    }
}

/// What to do for each file: its final path and whether it is written. Returns also the folders (under `dir`) that do
/// not exist yet and that the writing will make.
pub fn plan(dir: &Path, items: &[Item]) -> Result<(Vec<Action>, Vec<String>), String> {
    want_dir(dir)?;
    let mut out: Vec<Action> = Vec::new();
    let mut taken: Vec<String> = Vec::new(); // (lower-case) paths given in this plan
    let mut new_dirs: Vec<String> = Vec::new();
    for it in items {
        let (sub, name) = split_rel(&it.rel)?;
        if let Some(s) = &sub {
            let p = dir.join(s);
            if p.exists() && !plain_dir(&p) {
                return Err(format!("not a folder: {}", s));
            }
            if !p.exists() && !new_dirs.contains(s) {
                new_dirs.push(s.clone());
            }
        }
        let mut n = 1u32;
        loop {
            let cand = if n == 1 { name.clone() } else { numbered(&name, n) };
            let rel = match &sub {
                Some(s) => format!("{}/{}", s, cand),
                None => cand.clone(),
            };
            n += 1;
            if taken.contains(&rel.to_lowercase()) {
                continue;
            }
            let path = join(dir, &sub, &cand);
            match fs::symlink_metadata(&path) {
                Err(_) => {
                    taken.push(rel.to_lowercase());
                    out.push(Action::Write(rel));
                    break;
                }
                Ok(m) => {
                    if m.is_file() && !m.file_type().is_symlink() && m.len() == it.size && !it.sha.is_empty() && sha_file(&path).map(|h| h.eq_ignore_ascii_case(&it.sha)).unwrap_or(false) {
                        taken.push(rel.to_lowercase());
                        out.push(Action::Same(rel));
                        break;
                    }
                }
            }
            if n > 1000 {
                return Err(format!("no free name for {}", it.rel));
            }
        }
    }
    Ok((out, new_dirs))
}

/// A piece of a file written. `first`: the part file is made new (its folder too, one level); `last`: the part is put in
/// its place — and never over a file that is there (then the part is taken away and an error returned).
pub fn put(dir: &Path, rel: &str, bytes: &[u8], first: bool, last: bool) -> Result<(), String> {
    want_dir(dir)?;
    let (sub, name) = split_rel(rel)?;
    let target = join(dir, &sub, &name);
    let part = join(dir, &sub, &format!("{}{}", name, PART));
    if first {
        if let Some(s) = &sub {
            let p = dir.join(s);
            if !p.exists() {
                fs::create_dir(&p).map_err(|e| e.to_string())?;
            } else if !plain_dir(&p) {
                return Err(format!("not a folder: {}", s));
            }
        }
        if fs::symlink_metadata(&target).is_ok() {
            return Err(format!("exists: {}", rel));
        }
        let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).open(&part).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
    } else {
        let mut f = fs::OpenOptions::new().append(true).open(&part).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
    }
    if last {
        if fs::symlink_metadata(&target).is_ok() {
            let _ = fs::remove_file(&part);
            return Err(format!("exists: {}", rel));
        }
        fs::rename(&part, &target).map_err(|e| {
            let _ = fs::remove_file(&part);
            e.to_string()
        })?;
    }
    Ok(())
}

/// What a save made, taken away: the files (and any part of one) at `rels`, then each of `dirs` if it is empty. Names
/// that are not file names are skipped; nothing outside `dir` is touched.
pub fn undo(dir: &Path, rels: &[String], dirs: &[String]) -> usize {
    let mut gone = 0;
    for rel in rels {
        if let Ok((sub, name)) = split_rel(rel) {
            for n in [format!("{}{}", name, PART), name.clone()] {
                let p = join(dir, &sub, &n);
                if fs::symlink_metadata(&p).map(|m| m.is_file()).unwrap_or(false) && fs::remove_file(&p).is_ok() {
                    gone += 1;
                }
            }
        }
    }
    for d in dirs {
        if name_ok(d) {
            let p = dir.join(d);
            if plain_dir(&p) {
                let _ = fs::remove_dir(&p); // (only when empty)
            }
        }
    }
    gone
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kr-save-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn item(rel: &str, bytes: &[u8]) -> Item {
        let mut s = Sha256::new();
        s.update(bytes);
        Item { rel: rel.to_string(), size: bytes.len() as u64, sha: s.hex() }
    }
    fn write_all(dir: &Path, it: &Item, bytes: &[u8]) {
        let mid = bytes.len() / 2;
        put(dir, &it.rel, &bytes[..mid], true, false).unwrap();
        put(dir, &it.rel, &bytes[mid..], false, true).unwrap();
    }

    #[test]
    fn sha256_known_values() {
        let h = |b: &[u8]| {
            let mut s = Sha256::new();
            s.update(b);
            s.hex()
        };
        assert_eq!(h(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(h(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let long = vec![b'a'; 1_000_000];
        assert_eq!(h(&long), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
        // fed in odd pieces it is the same
        let mut s = Sha256::new();
        for c in long.chunks(777) {
            s.update(c);
        }
        assert_eq!(s.hex(), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
    }

    #[test]
    fn names_and_paths() {
        assert!(name_ok("Report.docx") && name_ok("تقرير.docx") && name_ok("Times New Roman (PDF)-Regular.ttf"));
        for bad in ["", ".", "..", "a/b", "a\\b", "CON", "con.txt", "nul", "COM1.ttf", "LPT9", "a:b", "a*", "x.", "x ", "a\u{0}b", "a\nb", "f.krpart"] {
            assert!(!name_ok(bad), "{:?}", bad);
        }
        assert!(name_ok("com0") && name_ok("console") && name_ok("COM10"));
        assert_eq!(split_rel("a.docx").unwrap(), (None, "a.docx".to_string()));
        assert_eq!(split_rel("a fonts/b.ttf").unwrap(), (Some("a fonts".to_string()), "b.ttf".to_string()));
        for bad in ["../a", "a/../b", "/a", "a/b/c", "a//b", "..", "a/..", "C:/a", "a\\..\\b", ""] {
            assert!(split_rel(bad).is_err(), "{:?}", bad);
        }
        assert_eq!(numbered("a.docx", 2), "a (2).docx");
        assert_eq!(numbered("a", 3), "a (3)");
        assert_eq!(numbered(".hidden", 2), ".hidden (2)");
    }

    #[test]
    fn writes_inside_the_folder_only() {
        let d = temp("inside");
        let a = b"first file";
        let it = item("Doc.docx", a);
        let (acts, nd) = plan(&d, &[it.clone()]).unwrap();
        assert_eq!(acts, vec![Action::Write("Doc.docx".into())]);
        assert!(nd.is_empty());
        write_all(&d, &it, a);
        assert_eq!(fs::read(d.join("Doc.docx")).unwrap(), a);
        assert!(!d.join(format!("Doc.docx{}", PART)).exists());
        // paths that leave the folder are refused, by plan and by put
        for bad in ["../x.docx", "sub/../../x", "/etc/x", "a/b/c.ttf"] {
            assert!(plan(&d, &[item(bad, a)]).is_err());
            assert!(put(&d, bad, a, true, true).is_err());
        }
        assert!(!d.parent().unwrap().join("x.docx").exists());
        // not a folder
        assert!(plan(&d.join("Doc.docx"), &[it.clone()]).is_err());
        assert!(plan(&d.join("nowhere"), &[it]).is_err());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn never_over_a_file_that_is_there() {
        let d = temp("noover");
        let a = b"mine";
        fs::write(d.join("Doc.docx"), b"the user's own").unwrap();
        let it = item("Doc.docx", a);
        let (acts, _) = plan(&d, &[it.clone()]).unwrap();
        assert_eq!(acts, vec![Action::Write("Doc (2).docx".into())]);
        // put refuses the taken name outright (and leaves no part behind)
        assert!(put(&d, "Doc.docx", a, true, true).is_err());
        assert_eq!(fs::read(d.join("Doc.docx")).unwrap(), b"the user's own");
        assert!(!d.join(format!("Doc.docx{}", PART)).exists());
        // a file made between plan and the last piece is not written over either
        put(&d, "Doc (2).docx", &a[..2], true, false).unwrap();
        fs::write(d.join("Doc (2).docx"), b"appeared").unwrap();
        assert!(put(&d, "Doc (2).docx", &a[2..], false, true).is_err());
        assert_eq!(fs::read(d.join("Doc (2).docx")).unwrap(), b"appeared");
        assert!(!d.join(format!("Doc (2).docx{}", PART)).exists());
        // the same name asked twice in one plan gets two names
        let (acts, _) = plan(&d, &[item("n.ttf", b"1"), item("n.ttf", b"2")]).unwrap();
        assert_eq!(acts, vec![Action::Write("n.ttf".into()), Action::Write("n (2).ttf".into())]);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn the_same_file_is_written_once() {
        let d = temp("same");
        let font = b"\x00\x01\x00\x00 font bytes";
        let doc = b"docx bytes";
        let items = vec![item("Doc.docx", doc), item("Doc fonts/Foo-Regular.ttf", font)];
        let (acts, nd) = plan(&d, &items).unwrap();
        assert_eq!(acts, vec![Action::Write("Doc.docx".into()), Action::Write("Doc fonts/Foo-Regular.ttf".into())]);
        assert_eq!(nd, vec!["Doc fonts".to_string()]);
        for (it, bytes) in items.iter().zip([&doc[..], &font[..]]) {
            write_all(&d, it, bytes);
        }
        assert_eq!(fs::read(d.join("Doc fonts").join("Foo-Regular.ttf")).unwrap(), font);
        // the same save again: nothing to write, nothing new in the folders
        let before: Vec<String> = list(&d);
        let (acts, nd) = plan(&d, &items).unwrap();
        assert_eq!(acts, vec![Action::Same("Doc.docx".into()), Action::Same("Doc fonts/Foo-Regular.ttf".into())]);
        assert!(nd.is_empty());
        assert_eq!(list(&d), before);
        // the same name with other bytes is kept apart: « (2)», the user's file untouched
        let other = item("Doc fonts/Foo-Regular.ttf", b"another font under the same name");
        let (acts, _) = plan(&d, &[other.clone()]).unwrap();
        assert_eq!(acts, vec![Action::Write("Doc fonts/Foo-Regular (2).ttf".into())]);
        write_all(&d, &Item { rel: "Doc fonts/Foo-Regular (2).ttf".into(), ..other }, b"another font under the same name");
        assert_eq!(fs::read(d.join("Doc fonts").join("Foo-Regular.ttf")).unwrap(), font);
        // an unknown hash is never taken for the same
        let mut unknown = item("Doc.docx", doc);
        unknown.sha = String::new();
        assert_eq!(plan(&d, &[unknown]).unwrap().0, vec![Action::Write("Doc (2).docx".into())]);
        // and the same size with other bytes is not the same
        let mut liar = item("Doc.docx", b"DOCX BYTES");
        liar.size = doc.len() as u64;
        assert_eq!(plan(&d, &[liar]).unwrap().0, vec![Action::Write("Doc (2).docx".into())]);
        let _ = fs::remove_dir_all(&d);
    }

    fn list(d: &Path) -> Vec<String> {
        let mut v = Vec::new();
        for e in fs::read_dir(d).unwrap() {
            let e = e.unwrap();
            let n = e.file_name().to_string_lossy().into_owned();
            if e.path().is_dir() {
                for f in fs::read_dir(e.path()).unwrap() {
                    v.push(format!("{}/{}", n, f.unwrap().file_name().to_string_lossy()));
                }
            } else {
                v.push(n);
            }
        }
        v.sort();
        v
    }

    #[test]
    fn undo_leaves_nothing_behind() {
        let d = temp("undo");
        fs::write(d.join("keep.txt"), b"theirs").unwrap();
        put(&d, "Doc.docx", b"abc", true, true).unwrap();
        put(&d, "Doc fonts/A-Regular.ttf", b"abc", true, true).unwrap();
        put(&d, "Doc fonts/B-Regular.ttf", b"ab", true, false).unwrap(); // broken off: a part only
        assert!(d.join("Doc fonts").join(format!("B-Regular.ttf{}", PART)).exists());
        let gone = undo(&d, &["Doc.docx".into(), "Doc fonts/A-Regular.ttf".into(), "Doc fonts/B-Regular.ttf".into(), "../keep.txt".into()], &["Doc fonts".into(), "..".into()]);
        assert_eq!(gone, 3);
        assert_eq!(list(&d), vec!["keep.txt".to_string()]);
        // a folder that is not empty (it has something of the user's) is left
        put(&d, "Mine/x.ttf", b"x", true, true).unwrap();
        fs::write(d.join("Mine").join("theirs.txt"), b"t").unwrap();
        undo(&d, &["Mine/x.ttf".into()], &["Mine".into()]);
        assert_eq!(list(&d), vec!["Mine/theirs.txt".to_string(), "keep.txt".to_string()]);
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_is_not_followed() {
        let d = temp("link");
        let out = temp("linkout");
        std::os::unix::fs::symlink(&out, d.join("Doc fonts")).unwrap();
        assert!(plan(&d, &[item("Doc fonts/a.ttf", b"a")]).is_err());
        assert!(put(&d, "Doc fonts/a.ttf", b"a", true, true).is_err());
        assert!(!out.join("a.ttf").exists());
        let _ = fs::remove_dir_all(&d);
        let _ = fs::remove_dir_all(&out);
    }
}
