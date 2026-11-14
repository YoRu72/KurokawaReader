// The family names of the fonts in a few folders — desktop/main.cjs's kt:fontDirs / kt:fontIndex, for the player's
// subtitles: each font file read by seeking (only its table of contents and its «name» table, a few KB, never the whole
// font), a collection (.ttc / .otc) for each font in it; names 1 (family), 4 (full name) and 16 (typographic family),
// in Unicode (platforms 0 and 3, UTF-16) or Mac Roman's ASCII part (platform 1, encoding 0, read as Latin-1 as Node's
// 'latin1' does). Kept between calls: a file is read again only when its size or time changed. Std only, checked
// alone: `rustc --edition 2021 --test fontnames.rs`.
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

fn be16(b: &[u8], i: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(i)?, *b.get(i + 1)?]))
}
fn be32(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from_be_bytes([*b.get(i)?, *b.get(i + 1)?, *b.get(i + 2)?, *b.get(i + 3)?]))
}

/// What can be read at an offset (fewer bytes at the end of the file).
pub trait At {
    fn at(&mut self, off: u64, len: usize) -> Vec<u8>;
}

impl At for fs::File {
    fn at(&mut self, off: u64, len: usize) -> Vec<u8> {
        let mut b = vec![0u8; len];
        if self.seek(SeekFrom::Start(off)).is_err() {
            return Vec::new();
        }
        let mut got = 0;
        while got < len {
            match self.read(&mut b[got..]) {
                Ok(0) | Err(_) => break,
                Ok(n) => got += n,
            }
        }
        b.truncate(got);
        b
    }
}

impl At for &[u8] {
    fn at(&mut self, off: u64, len: usize) -> Vec<u8> {
        let s = (off as usize).min(self.len());
        let e = s.saturating_add(len).min(self.len());
        self[s..e].to_vec()
    }
}

/// The names of the font whose table directory starts at `off`, added to `out` (each once, in the order found).
fn one(r: &mut dyn At, off: u64, out: &mut Vec<String>) {
    let hd = r.at(off, 12);
    if hd.len() < 12 {
        return;
    }
    let n = be16(&hd, 4).unwrap_or(0) as usize;
    let dir = r.at(off + 12, n * 16);
    let mut i = 0;
    while i + 16 <= dir.len() {
        if &dir[i..i + 4] != b"name" {
            i += 16;
            continue;
        }
        let to = be32(&dir, i + 8).unwrap_or(0) as u64;
        let tl = (be32(&dir, i + 12).unwrap_or(0) as usize).min(256 * 1024);
        let t = r.at(to, tl);
        if t.len() < 6 {
            return;
        }
        let count = be16(&t, 2).unwrap_or(0) as usize;
        let strs = be16(&t, 4).unwrap_or(0) as usize;
        for j in 0..count {
            let rr = 6 + j * 12;
            if rr + 12 > t.len() {
                break;
            }
            let pid = be16(&t, rr).unwrap_or(0);
            let eid = be16(&t, rr + 2).unwrap_or(0);
            let nid = be16(&t, rr + 6).unwrap_or(0);
            let len = be16(&t, rr + 8).unwrap_or(0) as usize;
            let so = strs + be16(&t, rr + 10).unwrap_or(0) as usize;
            if !(nid == 1 || nid == 4 || nid == 16) || so + len > t.len() {
                continue;
            }
            let mut s = String::new();
            if pid == 3 || pid == 0 {
                // (UTF-16 code units one by one, as JS's String.fromCharCode puts them together.)
                let units: Vec<u16> = (0..len / 2).map(|k| be16(&t, so + 2 * k).unwrap_or(0)).collect();
                s = String::from_utf16_lossy(&units);
            } else if pid == 1 && eid == 0 {
                s = t[so..so + len].iter().map(|&c| c as char).collect();
            }
            let s = s.replace('\u{0}', "");
            let s = s.trim();
            if !s.is_empty() && !out.iter().any(|x| x == s) {
                out.push(s.to_string());
            }
        }
        return;
    }
}

/// A font's (or a collection's fonts') family names; empty when this is not a font this reads.
pub fn families(r: &mut dyn At) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let h = r.at(0, 12);
    if h.len() >= 4 && &h[0..4] == b"ttcf" {
        let n = (be32(&h, 8).unwrap_or(0) as usize).min(64);
        let offs = r.at(12, n * 4);
        let mut i = 0;
        while i + 4 <= offs.len() {
            one(r, be32(&offs, i).unwrap_or(0) as u64, &mut out);
            i += 4;
        }
    } else {
        one(r, 0, &mut out);
    }
    out
}

/// A name for a font whose own names cannot be read: its file's, without the extension and the style, «-» and «_» as
/// spaces.
pub fn name_from_file(file_name: &str) -> String {
    let stem = match file_name.rfind('.') {
        Some(i) if i > 0 => &file_name[..i],
        _ => file_name,
    };
    let lower = stem.to_ascii_lowercase();
    let mut s = stem.to_string();
    for st in ["regular", "bold", "italic", "medium", "light", "semibold", "black", "thin"] {
        for sep in ['-', '_'] {
            let suf = format!("{}{}", sep, st);
            if lower.ends_with(&suf) {
                s = stem[..stem.len() - suf.len()].to_string();
            }
        }
    }
    let mut out = String::new();
    let mut last_sep = false;
    for c in s.chars() {
        if c == '-' || c == '_' {
            if !last_sep {
                out.push(' ');
            }
            last_sep = true;
        } else {
            out.push(c);
            last_sep = false;
        }
    }
    out
}

/// The font folders of the system and the user that exist (main.cjs's kt:fontDirs, by OS in Node's words).
pub fn font_dirs(os: &str, home: &Path, windir: Option<&str>, local_app_data: Option<&str>) -> Vec<PathBuf> {
    let c: Vec<PathBuf> = match os {
        "win32" => vec![
            PathBuf::from(windir.unwrap_or("C:\\Windows")).join("Fonts"),
            local_app_data.map(PathBuf::from).unwrap_or_else(|| home.join("AppData").join("Local")).join("Microsoft").join("Windows").join("Fonts"),
        ],
        "darwin" => vec![PathBuf::from("/System/Library/Fonts"), PathBuf::from("/Library/Fonts"), home.join("Library").join("Fonts")],
        _ => vec![PathBuf::from("/usr/share/fonts"), PathBuf::from("/usr/local/share/fonts"), home.join(".local").join("share").join("fonts"), home.join(".fonts")],
    };
    c.into_iter().filter(|d| d.is_dir()).collect()
}

/// A font file of the index: its path, size, time (ms) and family names.
#[derive(Clone, Debug, PartialEq)]
pub struct FontFile {
    pub path: String,
    pub size: u64,
    pub mtime: f64,
    pub families: Vec<String>,
}

fn is_font(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    l.ends_with(".ttf") || l.ends_with(".otf") || l.ends_with(".ttc") || l.ends_with(".otc")
}

fn walk(d: &Path, depth: u32, files: &mut Vec<PathBuf>) {
    let rd = match fs::read_dir(d) {
        Ok(r) => r,
        Err(_) => return,
    };
    let mut ents: Vec<fs::DirEntry> = rd.flatten().collect();
    ents.sort_by_key(|e| e.file_name());
    for e in ents {
        let p = e.path();
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir && depth < 3 {
            walk(&p, depth + 1, files);
        } else if is_font(&e.file_name().to_string_lossy()) {
            files.push(p);
        }
    }
}

fn cache() -> &'static Mutex<HashMap<String, FontFile>> {
    static C: OnceLock<Mutex<HashMap<String, FontFile>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The fonts in `dirs` (and their folders three deep), 6000 at most, each with its family names.
pub fn index(dirs: &[PathBuf]) -> Vec<FontFile> {
    let mut files: Vec<PathBuf> = Vec::new();
    for d in dirs {
        walk(d, 0, &mut files);
    }
    let mut out: Vec<FontFile> = Vec::new();
    for f in files.into_iter().take(6000) {
        let md = match fs::metadata(&f) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size = md.len();
        let mtime = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64).unwrap_or(0.0);
        let key = f.to_string_lossy().into_owned();
        if let Ok(c) = cache().lock() {
            if let Some(had) = c.get(&key) {
                if had.size == size && had.mtime == mtime {
                    out.push(had.clone());
                    continue;
                }
            }
        }
        let mut fam = match fs::File::open(&f) {
            Ok(mut fh) => families(&mut fh),
            Err(_) => Vec::new(),
        };
        if fam.is_empty() {
            fam = vec![name_from_file(&f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())];
        }
        let x = FontFile { path: key.clone(), size, mtime, families: fam };
        if let Ok(mut c) = cache().lock() {
            c.insert(key, x.clone());
        }
        out.push(x);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A font of one table, «name», holding the given records (platform, encoding, name id, bytes).
    fn font(records: &[(u16, u16, u16, Vec<u8>)]) -> Vec<u8> {
        let mut strs: Vec<u8> = Vec::new();
        let mut recs: Vec<u8> = Vec::new();
        for (pid, eid, nid, b) in records {
            for v in [*pid, *eid, 0x409u16, *nid, b.len() as u16, strs.len() as u16] {
                recs.extend_from_slice(&v.to_be_bytes());
            }
            strs.extend_from_slice(b);
        }
        let mut name: Vec<u8> = Vec::new();
        name.extend_from_slice(&0u16.to_be_bytes());
        name.extend_from_slice(&(records.len() as u16).to_be_bytes());
        name.extend_from_slice(&((6 + recs.len()) as u16).to_be_bytes());
        name.extend_from_slice(&recs);
        name.extend_from_slice(&strs);
        let mut f: Vec<u8> = vec![0, 1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0];
        let head_off = 12 + 32;
        let name_off = head_off + 4;
        for (tag, off, len) in [(b"head", head_off, 4usize), (b"name", name_off, name.len())] {
            f.extend_from_slice(tag);
            f.extend_from_slice(&0u32.to_be_bytes());
            f.extend_from_slice(&(off as u32).to_be_bytes());
            f.extend_from_slice(&(len as u32).to_be_bytes());
        }
        f.extend_from_slice(&[0, 0, 0, 0]);
        f.extend_from_slice(&name);
        f
    }
    fn utf16(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|u| u.to_be_bytes()).collect()
    }

    #[test]
    fn names() {
        let f = font(&[(3, 1, 1, utf16("Noto Naskh Arabic")), (3, 1, 4, utf16("Noto Naskh Arabic Bold")), (1, 0, 1, b"Noto Naskh Arabic".to_vec()), (3, 1, 2, utf16("Bold")), (3, 1, 16, utf16("\u{0}Noto\u{0} "))]);
        let mut r: &[u8] = &f;
        assert_eq!(families(&mut r), vec!["Noto Naskh Arabic", "Noto Naskh Arabic Bold", "Noto"]);
        // (A collection of two fonts: both read.)
        let a = font(&[(3, 1, 1, utf16("A Sans"))]);
        let b = font(&[(0, 3, 1, utf16("\u{6587}\u{5b57}"))]);
        let mut ttc: Vec<u8> = b"ttcf".to_vec();
        ttc.extend_from_slice(&[0, 1, 0, 0, 0, 0, 0, 2]);
        let first = 12 + 8;
        ttc.extend_from_slice(&(first as u32).to_be_bytes());
        ttc.extend_from_slice(&((first + a.len()) as u32).to_be_bytes());
        // (Each font's offsets are from the file's start: shift the table offsets by where the font begins.)
        let shift = |mut x: Vec<u8>, by: usize| { for t in 0..2 { let o = 12 + t * 16 + 8; let v = u32::from_be_bytes([x[o], x[o + 1], x[o + 2], x[o + 3]]) + by as u32; x[o..o + 4].copy_from_slice(&v.to_be_bytes()); } x };
        ttc.extend_from_slice(&shift(a.clone(), first));
        ttc.extend_from_slice(&shift(b.clone(), first + a.len()));
        let mut r: &[u8] = &ttc;
        assert_eq!(families(&mut r), vec!["A Sans", "\u{6587}\u{5b57}"]);
        let mut junk: &[u8] = b"not a font at all";
        assert!(families(&mut junk).is_empty());
        let mut short: &[u8] = &f[..30];
        assert!(families(&mut short).is_empty());
    }

    #[test]
    fn file_names_and_dirs() {
        assert_eq!(name_from_file("Amiri-Regular.ttf"), "Amiri");
        assert_eq!(name_from_file("noto_sans_jp_Bold.otf"), "noto sans jp");
        assert_eq!(name_from_file("Plain.ttc"), "Plain");
        let home = std::env::temp_dir().join(format!("kt-fonts-{}", std::process::id()));
        let user = home.join(".local").join("share").join("fonts");
        fs::create_dir_all(user.join("a").join("b")).unwrap();
        fs::write(user.join("a").join("b").join("X-Bold.ttf"), font(&[(3, 1, 1, utf16("Ex"))])).unwrap();
        fs::write(user.join("broken.otf"), b"nope").unwrap();
        fs::write(user.join("readme.txt"), b"x").unwrap();
        let dirs = font_dirs("linux", &home, None, None);
        assert!(dirs.contains(&user));
        assert!(font_dirs("darwin", &home, None, None).iter().all(|d| d.is_dir()));
        let ix = index(&[user.clone()]);
        assert_eq!(ix.len(), 2);
        let ex = ix.iter().find(|x| x.path.ends_with("X-Bold.ttf")).unwrap();
        assert_eq!(ex.families, vec!["Ex"]);
        assert_eq!(ix.iter().find(|x| x.path.ends_with("broken.otf")).unwrap().families, vec!["broken"]);
        // (Asked again: from what was kept.)
        assert_eq!(index(&[user.clone()]), ix);
        let _ = fs::remove_dir_all(&home);
    }
}
