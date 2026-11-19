//! The index in one file in the app-data folder, so a start answers at once while the roots are walked again in the
//! background. Layout (little-endian): «KTFIDX\r\n», version u32, 0 u32, payload length u64, checksum u64, payload.
//! The payload: the roots (path, exclusions, last walk, unreadable count), then every entry in walk order (a root,
//! then its folders depth first) as parent u32 (u32::MAX for a root), flags u8, size u64, mtime i64, name (u16 length
//! and bytes). Nothing in it is trusted: the length, the checksum and every field are checked (a parent comes before
//! its child, so no cycle can be loaded; a name is a valid name of this system), and a file that fails any check, or
//! has another version, is refused (the caller deletes it and walks again). Written to «<name>.tmp», synced, renamed.
//! The folded names are not stored: they are made again on load, so a change to the folding never meets old forms.
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use super::fold::fold;
use super::store::{bytes_os, os_bytes, Index, Meta, Root, RootSpec, F_DIR, F_LINK, F_ROOT, F_UNREAD, NONE};

pub const MAGIC: &[u8; 8] = b"KTFIDX\r\n";
pub const VERSION: u32 = 1;
const HEADER: usize = 8 + 4 + 4 + 8 + 8;

#[derive(Debug, PartialEq, Eq)]
pub enum LoadError {
    Missing,
    /// Written by another version of the format (discarded, not read).
    OtherVersion(u32),
    /// Cut short, altered or not an index file (what failed).
    Damaged(&'static str),
    Io(String),
}

pub fn checksum(b: &[u8]) -> u64 {
    let mut h: u64 = 0x6b74_6669_6478_0001 ^ (b.len() as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let mut chunks = b.chunks_exact(8);
    for c in &mut chunks {
        let w = u64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]);
        h = (h ^ w).wrapping_mul(0x9E37_79B9_7F4A_7C15).rotate_left(29);
    }
    for &x in chunks.remainder() {
        h = (h ^ x as u64).wrapping_mul(0x100_0000_01b3);
    }
    h ^ (h >> 31)
}

fn put_u32(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_le_bytes());
}
fn put_u64(v: &mut Vec<u8>, x: u64) {
    v.extend_from_slice(&x.to_le_bytes());
}
fn put_bytes32(v: &mut Vec<u8>, b: &[u8]) {
    put_u32(v, b.len() as u32);
    v.extend_from_slice(b);
}

struct Rd<'a> {
    b: &'a [u8],
    at: usize,
}
impl<'a> Rd<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], LoadError> {
        if self.b.len() - self.at < n {
            return Err(LoadError::Damaged("cut short"));
        }
        let s = &self.b[self.at..self.at + n];
        self.at += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, LoadError> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, LoadError> {
        let s = self.take(2)?;
        Ok(u16::from_le_bytes([s[0], s[1]]))
    }
    fn u32(&mut self) -> Result<u32, LoadError> {
        let s = self.take(4)?;
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn u64(&mut self) -> Result<u64, LoadError> {
        let s = self.take(8)?;
        Ok(u64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]))
    }
    fn bytes32(&mut self, max: usize) -> Result<&'a [u8], LoadError> {
        let n = self.u32()? as usize;
        if n > max {
            return Err(LoadError::Damaged("a length out of range"));
        }
        self.take(n)
    }
}

/// UTF-8 everywhere; on Windows also WTF-8 (lone surrogates encoded as three bytes, never a lead before a trail),
/// the only form `as_encoded_bytes` produces there.
pub fn valid_os_bytes(b: &[u8]) -> bool {
    if std::str::from_utf8(b).is_ok() {
        return true;
    }
    if !cfg!(windows) {
        return cfg!(unix); // any bytes are a Unix name
    }
    let mut i = 0;
    let mut prev_lead = false;
    while i < b.len() {
        let x = b[i];
        let n = if x < 0x80 { 1 } else if (0xC2..=0xDF).contains(&x) { 2 } else if (0xE0..=0xEF).contains(&x) { 3 } else if (0xF0..=0xF4).contains(&x) { 4 } else { return false };
        if i + n > b.len() || b[i + 1..i + n].iter().any(|c| c & 0xC0 != 0x80) {
            return false;
        }
        let cp: u32 = match n {
            1 => x as u32,
            2 => ((x as u32 & 0x1F) << 6) | (b[i + 1] as u32 & 0x3F),
            3 => ((x as u32 & 0x0F) << 12) | ((b[i + 1] as u32 & 0x3F) << 6) | (b[i + 2] as u32 & 0x3F),
            _ => ((x as u32 & 0x07) << 18) | ((b[i + 1] as u32 & 0x3F) << 12) | ((b[i + 2] as u32 & 0x3F) << 6) | (b[i + 3] as u32 & 0x3F),
        };
        let min = [0, 0, 0x80, 0x800, 0x10000][n];
        if cp < min || cp > 0x10FFFF {
            return false;
        }
        let lead = (0xD800..=0xDBFF).contains(&cp);
        let trail = (0xDC00..=0xDFFF).contains(&cp);
        if trail && prev_lead {
            return false; // a pair must be written as one four-byte character
        }
        prev_lead = lead;
        i += n;
    }
    true
}

fn good_entry_name(b: &[u8]) -> bool {
    if b.is_empty() || b == b"." || b == b".." || b.contains(&0) || b.contains(&b'/') {
        return false;
    }
    if cfg!(windows) && b.contains(&b'\\') {
        return false;
    }
    valid_os_bytes(b)
}

impl Index {
    /// The file's bytes (compacted: removed entries are not written).
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut p = Vec::with_capacity(self.arena.len() + self.slots() * 24 + 1024);
        put_u32(&mut p, self.roots.len() as u32);
        for r in &self.roots {
            put_bytes32(&mut p, os_bytes(r.spec.path.as_os_str()));
            put_u64(&mut p, r.last_walk_ms as u64);
            put_u64(&mut p, r.unreadable);
            p.push(r.walked as u8);
            put_u32(&mut p, r.spec.exclude.len() as u32);
            for e in &r.spec.exclude {
                put_bytes32(&mut p, os_bytes(e.as_os_str()));
            }
            put_u32(&mut p, r.spec.exclude_names.len() as u32);
            for n in &r.spec.exclude_names {
                put_bytes32(&mut p, n.as_bytes());
            }
        }
        let count_at = p.len();
        put_u32(&mut p, 0);
        let mut count: u32 = 0;
        let mut newid = vec![NONE; self.slots()];
        for r in &self.roots {
            let mut stack = vec![r.id];
            while let Some(x) = stack.pop() {
                let i = x as usize;
                newid[i] = count;
                let par = self.parent[i];
                put_u32(&mut p, if par == NONE || self.flags[i] & F_ROOT != 0 { NONE } else { newid[par as usize] });
                p.push(self.flags[i] & (F_DIR | F_LINK | F_UNREAD));
                put_u64(&mut p, self.size[i]);
                put_u64(&mut p, self.mtime[i] as u64);
                let nb = self.name_bytes(x);
                p.extend_from_slice(&(nb.len() as u16).to_le_bytes());
                p.extend_from_slice(nb);
                count += 1;
                stack.extend(self.children(x));
            }
        }
        p[count_at..count_at + 4].copy_from_slice(&count.to_le_bytes());
        let mut out = Vec::with_capacity(HEADER + p.len());
        out.extend_from_slice(MAGIC);
        put_u32(&mut out, VERSION);
        put_u32(&mut out, 0);
        put_u64(&mut out, p.len() as u64);
        put_u64(&mut out, checksum(&p));
        out.extend_from_slice(&p);
        out
    }

    /// Saves to `file` (temp name, sync, rename). Returns the bytes written.
    pub fn save(&self, file: &Path) -> io::Result<u64> {
        let bytes = self.to_bytes();
        let mut tmp = file.as_os_str().to_os_string();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        {
            let mut f = File::create(&tmp)?;
            f.write_all(&bytes)?;
            f.sync_all()?;
        }
        if let Err(e) = fs::rename(&tmp, file) {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        Ok(bytes.len() as u64)
    }

    pub fn from_bytes(b: &[u8]) -> Result<Index, LoadError> {
        if b.len() < HEADER || &b[..8] != MAGIC {
            return Err(LoadError::Damaged("not an index file"));
        }
        let ver = u32::from_le_bytes([b[8], b[9], b[10], b[11]]);
        if ver != VERSION {
            return Err(LoadError::OtherVersion(ver));
        }
        let len = u64::from_le_bytes(b[16..24].try_into().unwrap());
        let sum = u64::from_le_bytes(b[24..32].try_into().unwrap());
        if len != (b.len() - HEADER) as u64 {
            return Err(LoadError::Damaged("length"));
        }
        let payload = &b[HEADER..];
        if checksum(payload) != sum {
            return Err(LoadError::Damaged("checksum"));
        }
        let mut r = Rd { b: payload, at: 0 };
        let nroots = r.u32()? as usize;
        if nroots > 4096 {
            return Err(LoadError::Damaged("roots"));
        }
        let mut specs = Vec::with_capacity(nroots);
        for _ in 0..nroots {
            let path = r.bytes32(1 << 17)?;
            if path.is_empty() || !valid_os_bytes(path) {
                return Err(LoadError::Damaged("a root's path"));
            }
            let last = r.u64()? as i64;
            let unread = r.u64()?;
            let walked = r.u8()? != 0;
            let ne = r.u32()? as usize;
            if ne > 65536 {
                return Err(LoadError::Damaged("exclusions"));
            }
            let mut exclude = Vec::with_capacity(ne);
            for _ in 0..ne {
                let e = r.bytes32(1 << 17)?;
                if !valid_os_bytes(e) {
                    return Err(LoadError::Damaged("an exclusion"));
                }
                exclude.push(PathBuf::from(bytes_os(e)));
            }
            let nn = r.u32()? as usize;
            if nn > 65536 {
                return Err(LoadError::Damaged("exclusions"));
            }
            let mut exclude_names = Vec::with_capacity(nn);
            for _ in 0..nn {
                let e = r.bytes32(4096)?;
                exclude_names.push(String::from_utf8(e.to_vec()).map_err(|_| LoadError::Damaged("an excluded name"))?);
            }
            let spec = RootSpec { path: PathBuf::from(bytes_os(path)), exclude, exclude_names };
            specs.push((spec, last, unread, walked));
        }
        let count = r.u32()? as usize;
        // The smallest entry takes 23 bytes: a count beyond what is left is a lie.
        if count > (payload.len() - r.at) / 23 + 1 {
            return Err(LoadError::Damaged("entry count"));
        }
        let mut ix = Index::new();
        ix.reserve(count, payload.len());
        let mut next_root = 0usize;
        for k in 0..count {
            let parent = r.u32()?;
            let flags = r.u8()?;
            let size = r.u64()?;
            let mtime = r.u64()? as i64;
            let nl = r.u16()? as usize;
            let name = r.take(nl)?;
            if flags & !(F_DIR | F_LINK | F_UNREAD) != 0 {
                return Err(LoadError::Damaged("flags"));
            }
            let meta = Meta { size, mtime, is_dir: flags & F_DIR != 0, is_link: flags & F_LINK != 0 };
            if parent == NONE {
                if next_root >= specs.len() || !meta.is_dir || name.is_empty() || !valid_os_bytes(name) {
                    return Err(LoadError::Damaged("a root entry"));
                }
                let id = ix.insert_raw(NONE, name, None, meta, F_ROOT | (flags & F_UNREAD)).ok_or(LoadError::Damaged("a name"))?;
                let (spec, last, unread, walked) = specs[next_root].clone();
                let excl_names_folded = spec.exclude_names.iter().map(|n| fold(n)).collect();
                ix.roots.push(Root { spec, id, last_walk_ms: last, unreadable: unread, walked, excl_names_folded });
                next_root += 1;
            } else {
                if parent as usize >= k || !ix.meta(parent).is_dir || ix.meta(parent).is_link {
                    return Err(LoadError::Damaged("a parent"));
                }
                if !good_entry_name(name) {
                    return Err(LoadError::Damaged("a name"));
                }
                ix.insert_raw(parent, name, None, meta, flags & F_UNREAD).ok_or(LoadError::Damaged("a name"))?;
            }
        }
        if next_root != specs.len() || r.at != payload.len() {
            return Err(LoadError::Damaged("trailing or missing data"));
        }
        Ok(ix)
    }

    /// Loads the saved index. Ok gives the index and the roots to walk again in the background (all of them: what
    /// changed while the program was closed is unknown; the loaded entries answer queries until each walk installs).
    pub fn load(file: &Path) -> Result<(Index, Vec<RootSpec>), LoadError> {
        let mut f = match File::open(file) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(LoadError::Missing),
            Err(e) => return Err(LoadError::Io(e.to_string())),
        };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        if len > (1u64 << 33) {
            return Err(LoadError::Damaged("too large"));
        }
        let mut b = Vec::with_capacity(len as usize);
        f.read_to_end(&mut b).map_err(|e| LoadError::Io(e.to_string()))?;
        let ix = Index::from_bytes(&b)?;
        let stale = ix.root_specs();
        Ok((ix, stale))
    }

    /// `load`, or a new index when the file is missing or refused (a refused file is deleted). The note says why.
    pub fn load_or_new(file: &Path) -> (Index, Vec<RootSpec>, Option<LoadError>) {
        match Index::load(file) {
            Ok((ix, stale)) => (ix, stale, None),
            Err(e) => {
                if e != LoadError::Missing {
                    let _ = fs::remove_file(file);
                }
                (Index::new(), Vec::new(), Some(e))
            }
        }
    }
}
