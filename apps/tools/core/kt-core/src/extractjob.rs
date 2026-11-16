//! The extraction engine for ZIP and tar on the Tauri shell — desktop/inplace.cjs rule for rule, with the same journal
//! (version 2, archsafe's text: JSON, a newline, its CRC-32), the same saved tail («KTTAIL2», the plan as JSON, then the
//! archive's own tail bytes) and the same shelf (a «<id>.ref» per job in the registry): a job started by one shell can
//! be finished, restored or undone by the other. Every job is checked whole before anything changes (the pre-flight
//! over facts gathered here — `preflight`, the port of archsafe.cjs's), then run in units — in place the last unit
//! first, the archive cut back after each committed batch —, the journal written atomically before the first change and
//! after every commit. A stopped job can be FINISHED, or the archive RESTORED byte for byte from any committed point
//! (a deflated file only when it squeezes back to the very same bytes, else the archive is closed as a smaller whole
//! one); old items are moved aside, never deleted at once; a finished job can be undone until its offer is dismissed.
//!
//! On top of inplace.cjs (the same rules were added there, so both engines keep one behaviour): tar device, FIFO and
//! sparse entries are never made (a «layout» problem: refused in place, left out of a normal extraction and reported);
//! each written file is read back and its CRC compared before the archive is cut; a unit is written to a part file
//! made exclusively under a per-run name (`.kt<job>-<unit>.kt-part`, never a file the run did not create) and put in
//! place without replacing anything (a hard link that fails when the name is taken, then the part removed); no output
//! is written through a link that is already in the destination.
//!
//! Std only. What differs per shell comes from the caller: `Codec` (raw deflate — flate2 in the app, stored blocks in
//! the tests), `Io` (free space, a pid's liveness; the tests' fake volume with a quota and crash points). Tested through
//! stdroots/extractjob.rs (`rustc --edition 2021 --test stdroots/extractjob.rs`), with archsafe.rs and vidjson.rs.
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::archsafe as S;
use crate::vidjson::{self, J};

pub const JOURNAL_SUFFIX: &str = ".kurokawa-unzip";
pub const TAIL_SUFFIX: &str = ".kurokawa-tail";
pub const LOCK_SUFFIX: &str = ".kurokawa-lock";
/// The methods this engine decodes itself (stored, deflate).
pub const OWN_METHODS: [u16; 2] = [0, 8];
/// The methods the shipped 7-Zip decodes for a normal extraction (archive.cjs `external()`).
pub const SEVEN_METHODS: [u16; 6] = [9, 12, 14, 95, 98, 99];

/* ---------- what the caller gives ---------- */

/// Raw deflate, given by the caller.
pub trait Codec {
    /// The raw deflate stream in `src` decoded into `dst` → the bytes written.
    fn inflate(&self, src: &mut dyn Read, dst: &mut dyn Write) -> io::Result<u64>;
    /// `data` squeezed at zlib's `level` / `mem_level` (a restore tries to make a unit's bytes again); None when this
    /// codec cannot (the unit then stays extracted and the archive is closed before it).
    fn deflate(&self, data: &[u8], level: u32, mem_level: u32) -> Option<Vec<u8>>;
}

/// The volume: its free space, a quota and crash points in the tests.
pub trait Io {
    /// Bytes free for this user on the disk holding `dir`; -1 when unknown.
    fn free_space(&self, dir: &Path) -> i64;
    /// `n` bytes are about to be written: Err «noSpace» when they do not fit (the tests' quota).
    fn charge(&self, _n: u64) -> Result<(), Fail> {
        Ok(())
    }
    fn release(&self, _n: u64) {}
    /// A crash point (the tests stop here); Err with `crash` set.
    fn crash(&self, _point: &str) -> Result<(), Fail> {
        Ok(())
    }
    /// Flushes a written file (`dir` false: opened for writing — Windows flushes only through a handle that may write)
    /// or a folder (where the system can) to the disk. An error fails the commit: nothing is cut on an unproved write.
    fn sync(&self, p: &Path, dir: bool) -> io::Result<()> {
        sync_real(p, dir)
    }
    /// Whether a process with this id is running (a lock left by a dead one is taken over).
    fn pid_alive(&self, pid: u32) -> bool {
        if cfg!(target_os = "linux") {
            Path::new(&format!("/proc/{}", pid)).exists()
        } else {
            true
        }
    }
}

/// Progress `on(done, total, file)` and whether to stop.
pub struct Pr<'a> {
    pub on: &'a dyn Fn(u64, u64, &str),
    pub stopped: &'a dyn Fn() -> bool,
}

/// What a job runs with: the volume, the codec, the batch limits (a commit after `batch_count` units or
/// `batch_bytes` bytes).
pub struct Env<'a> {
    pub io: &'a dyn Io,
    pub codec: &'a dyn Codec,
    pub batch_count: usize,
    pub batch_bytes: u64,
}
impl<'a> Env<'a> {
    pub fn new(io: &'a dyn Io, codec: &'a dyn Codec) -> Env<'a> {
        Env { io, codec, batch_count: 64, batch_bytes: 512 * 1024 * 1024 }
    }
}

/// A job's failure: the message the page reads («refused names a.txt», «noSpace», «stopped», «journalCorrupt»…), and
/// what came with it.
#[derive(Debug, Clone, Default)]
pub struct Fail {
    pub msg: String,
    pub crash: bool,
    pub nothing_changed: bool,
    pub journal: Option<String>,
    pub kept: Option<u64>,
    pub names: Vec<String>,
    pub report: Option<J>,
    /// A journal that is never replayed: what it said (for the shelf).
    pub body: Option<J>,
}
impl Fail {
    pub fn new(m: impl Into<String>) -> Fail {
        Fail { msg: m.into(), ..Default::default() }
    }
    pub fn crash(point: &str) -> Fail {
        Fail { msg: format!("crash {}", point), crash: true, ..Default::default() }
    }
}
fn fail(m: impl Into<String>) -> Fail {
    Fail::new(m)
}
fn no_space(e: &io::Error) -> bool {
    matches!(e.raw_os_error(), Some(28)) && cfg!(unix) || matches!(e.raw_os_error(), Some(112) | Some(39)) && cfg!(windows) || e.to_string() == "noSpace"
}
fn ioe(e: io::Error) -> Fail {
    if no_space(&e) {
        fail("noSpace")
    } else {
        fail(e.to_string())
    }
}
type R<T> = Result<T, Fail>;

/* ---------- small helpers ---------- */

fn le16(b: &[u8], o: usize) -> u64 {
    u16::from_le_bytes([b[o], b[o + 1]]) as u64
}
fn le32(b: &[u8], o: usize) -> u64 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as u64
}
fn le64(b: &[u8], o: usize) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[o..o + 8]);
    u64::from_le_bytes(a)
}
fn exists(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}
fn with_suffix(p: &Path, s: &str) -> PathBuf {
    let mut o = p.as_os_str().to_os_string();
    o.push(s);
    PathBuf::from(o)
}
pub fn journal_of(file: &Path) -> PathBuf {
    with_suffix(file, JOURNAL_SUFFIX)
}
pub fn tail_of(file: &Path) -> PathBuf {
    with_suffix(file, TAIL_SUFFIX)
}
fn abs(p: &Path) -> PathBuf {
    std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf())
}
fn lossy(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}
fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}
fn new_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    static N: AtomicU64 = AtomicU64::new(0);
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    h.write_u64(N.fetch_add(1, Ordering::SeqCst));
    h.write_u32(std::process::id());
    format!("{:012x}", h.finish() & 0xffff_ffff_ffff)
}
fn read_all(f: &mut File, pos: u64, len: usize) -> R<Vec<u8>> {
    let mut b = vec![0u8; len];
    f.seek(SeekFrom::Start(pos)).map_err(ioe)?;
    f.read_exact(&mut b).map_err(|e| if e.kind() == io::ErrorKind::UnexpectedEof { fail("truncated") } else { ioe(e) })?;
    Ok(b)
}
/// The real flush: a file through a handle that may write (FlushFileBuffers needs one on Windows); a folder on Unix
/// (EINVAL: a file system that cannot sync folders — nothing to wait for there); Windows has no folder flush.
pub fn sync_real(p: &Path, dir: bool) -> io::Result<()> {
    if !dir {
        return OpenOptions::new().write(true).open(p)?.sync_all();
    }
    #[cfg(unix)]
    {
        match File::open(p).and_then(|h| h.sync_all()) {
            Err(e) if e.raw_os_error() == Some(22) => Ok(()),
            r => r,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = p;
        Ok(())
    }
}
/// Written whole or not at all: a new file, synced, renamed over the old, the folder synced.
fn write_atomic(file: &Path, bytes: &[u8]) -> R<()> {
    let tmp = with_suffix(file, ".tmp");
    let r = (|| -> io::Result<()> {
        let mut h = File::create(&tmp)?;
        h.write_all(bytes)?;
        h.sync_all()
    })();
    if let Err(e) = r {
        let _ = fs::remove_file(&tmp);
        return Err(ioe(e));
    }
    fs::rename(&tmp, file).map_err(ioe)?;
    if let Some(d) = file.parent() {
        sync_real(d, true).map_err(|e| fail(format!("syncFailed {}", e)))?;
    }
    Ok(())
}
fn nearest_dir(p: &Path) -> PathBuf {
    let mut d = abs(p);
    for _ in 0..60 {
        if fs::metadata(&d).map(|m| m.is_dir()).unwrap_or(false) {
            return d;
        }
        match d.parent() {
            Some(up) if up != d => d = up.to_path_buf(),
            _ => return d,
        }
    }
    d
}
/// CRC-32 continuing `prev` (archsafe's, table-driven: the same answers, eight times fewer steps).
pub fn crc32(data: &[u8], prev: u32) -> u32 {
    static T: OnceLock<[u32; 256]> = OnceLock::new();
    let t = T.get_or_init(|| {
        let mut t = [0u32; 256];
        for (i, e) in t.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *e = c;
        }
        t
    });
    let mut c = !prev;
    for &b in data {
        c = t[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    !c
}
fn file_crc(p: &Path) -> Option<u32> {
    let mut f = File::open(p).ok()?;
    let mut buf = vec![0u8; 1 << 20];
    let mut c = 0u32;
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            return Some(c);
        }
        c = crc32(&buf[..n], c);
    }
}
/// posix dirname / basename of an output path («a/b/c.txt» → «a/b», «c.txt»; «c.txt» → «.»).
fn split_out(out: &str) -> (&str, &str) {
    match out.rfind('/') {
        Some(i) => (&out[..i], &out[i + 1..]),
        None => (".", out),
    }
}
fn join_out(dir: &str, name: &str) -> String {
    if dir == "." {
        name.to_string()
    } else {
        format!("{}/{}", dir, name)
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
pub fn b64(b: &[u8]) -> String {
    let mut o = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        o.push(B64[(n >> 18) as usize & 63] as char);
        o.push(B64[(n >> 12) as usize & 63] as char);
        o.push(if c.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        o.push(if c.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    o
}
pub fn unb64(s: &str) -> Option<Vec<u8>> {
    let mut o = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        if c == b'=' {
            break;
        }
        let v = B64.iter().position(|&x| x == c)? as u32;
        acc = acc << 6 | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            o.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(o)
}

/* ---------- JSON helpers ---------- */

fn n(x: impl Into<f64>) -> J {
    J::num(x.into())
}
fn s(x: &str) -> J {
    J::s(x)
}
fn obj(v: Vec<(&str, J)>) -> J {
    J::Obj(v.into_iter().map(|(k, x)| (k.to_string(), x)).collect())
}
fn strs(v: &[String]) -> J {
    J::Arr(v.iter().map(|x| s(x)).collect())
}
fn gs(o: &J, k: &str) -> String {
    o.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn gn(o: &J, k: &str) -> Option<f64> {
    match o.get(k) {
        Some(J::Num(x, _)) => Some(*x),
        _ => None,
    }
}
fn gu(o: &J, k: &str) -> u64 {
    gn(o, k).filter(|x| *x >= 0.0).map(|x| x as u64).unwrap_or(0)
}
fn gb(o: &J, k: &str) -> bool {
    o.get(k).map(|x| x.truthy()).unwrap_or(false)
}
fn gstrs(o: &J, k: &str) -> Vec<String> {
    o.get(k).and_then(|x| x.as_arr()).map(|a| a.iter().filter_map(|x| x.as_str().map(|y| y.to_string())).collect()).unwrap_or_default()
}

/* ---------- reading the archive: units ---------- */

/// One unit of the archive: an entry with its own headers and what follows it up to the next.
#[derive(Clone, Debug, Default)]
pub struct Unit {
    pub name: String,
    pub name_raw: Vec<u8>,
    pub method: u16,
    pub time: u16,
    pub crc: Option<u32>,
    pub csize: u64,
    pub usize: u64,
    pub encrypted: bool,
    pub aes: Option<u8>,
    pub cd: Option<Vec<u8>>,
    pub dir: bool,
    pub link: Option<&'static str>,
    pub target: String,
    pub kind: char,
    pub start: u64,
    pub data_start: u64,
    pub data_end: u64,
    pub end: u64,
    pub dd: bool,
    pub bad: bool,
}
pub struct Scan {
    pub format: &'static str,
    pub units: Vec<Unit>,
    pub tail_start: u64,
    pub size: u64,
    pub zip64: bool,
    pub layout_bad: Vec<String>,
    pub id_crc: u32,
}

/// A ZIP's units in offset order (inplace.cjs zipUnits): each entry's local header, data and what follows it up to the
/// next; an entry whose local header disagrees with the directory, or whose data runs into the next one (overlapping
/// entries), is «layout bad».
pub fn zip_units(f: &mut File, size: u64) -> R<Scan> {
    let tail_len = size.min(65557 + 22);
    let buf = read_all(f, size - tail_len, tail_len as usize)?;
    let mut eocd = None;
    if buf.len() >= 22 {
        let mut i = buf.len() - 22;
        loop {
            if le32(&buf, i) == 0x0605_4b50 {
                eocd = Some(i);
                break;
            }
            if i == 0 {
                break;
            }
            i -= 1;
        }
    }
    let e = eocd.ok_or_else(|| fail("notZip"))?;
    let (mut count, mut cd_size, mut cd_off) = (le16(&buf, e + 10), le32(&buf, e + 12), le32(&buf, e + 16));
    let mut zip64 = false;
    if (count == 0xffff || cd_off == 0xffff_ffff || cd_size == 0xffff_ffff) && e >= 20 && le32(&buf, e - 20) == 0x0706_4b50 {
        let z = read_all(f, le64(&buf, e - 12), 56)?;
        if le32(&z, 0) != 0x0606_4b50 {
            return Err(fail("badZip64"));
        }
        count = le64(&z, 32);
        cd_size = le64(&z, 40);
        cd_off = le64(&z, 48);
        zip64 = true;
    }
    if cd_size > (1 << 31) || cd_off.checked_add(cd_size).map(|x| x > size).unwrap_or(true) {
        return Err(fail("badCentralDirectory"));
    }
    let cd = read_all(f, cd_off, cd_size as usize)?;
    let mut items: Vec<Unit> = Vec::new();
    let mut p = 0usize;
    for _ in 0..count {
        if p + 46 > cd.len() || le32(&cd, p) != 0x0201_4b50 {
            return Err(fail("badCentralDirectory"));
        }
        let flags = le16(&cd, p + 8);
        let (nl, xl, cl) = (le16(&cd, p + 28) as usize, le16(&cd, p + 30) as usize, le16(&cd, p + 32) as usize);
        let rec_end = p + 46 + nl + xl + cl;
        if rec_end > cd.len() {
            return Err(fail("badCentralDirectory"));
        }
        let name_raw = cd[p + 46..p + 46 + nl].to_vec();
        let name = if flags & 0x800 != 0 { String::from_utf8_lossy(&name_raw).into_owned() } else { name_raw.iter().map(|&c| c as char).collect() };
        let mut it = Unit {
            name: name.replace('\\', "/"),
            name_raw,
            method: le16(&cd, p + 10) as u16,
            time: le16(&cd, p + 12) as u16,
            crc: Some(le32(&cd, p + 16) as u32),
            csize: le32(&cd, p + 20),
            usize: le32(&cd, p + 24),
            start: le32(&cd, p + 42),
            encrypted: flags & 1 != 0,
            kind: '0',
            ..Default::default()
        };
        let (mut xp, xe) = (p + 46 + nl, p + 46 + nl + xl);
        while xp + 4 <= xe {
            let (id, sz) = (le16(&cd, xp), le16(&cd, xp + 2) as usize);
            let lim = (xp + 4 + sz).min(xe);
            if id == 1 {
                let mut q = xp + 4;
                if it.usize == 0xffff_ffff && q + 8 <= lim {
                    it.usize = le64(&cd, q);
                    q += 8;
                }
                if it.csize == 0xffff_ffff && q + 8 <= lim {
                    it.csize = le64(&cd, q);
                    q += 8;
                }
                if it.start == 0xffff_ffff && q + 8 <= lim {
                    it.start = le64(&cd, q);
                }
                zip64 = true;
            }
            if id == 0x9901 && sz >= 7 && xp + 11 <= lim {
                it.aes = Some(cd[xp + 8]);
            }
            xp += 4 + sz;
        }
        it.cd = Some(cd[p..rec_end].to_vec());
        it.dir = it.name.ends_with('/');
        p = rec_end;
        items.push(it);
    }
    items.sort_by_key(|u| u.start);
    let mut layout_bad = Vec::new();
    for i in 0..items.len() {
        let next = if i + 1 < items.len() { items[i + 1].start } else { cd_off };
        let it = &mut items[i];
        it.end = next;
        // (A unit whose header cannot be read keeps no data of its own: data_start = data_end = start.)
        it.data_start = it.start;
        it.data_end = it.start;
        if it.start.checked_add(30).map(|x| x > size).unwrap_or(true) || next < it.start {
            layout_bad.push(it.name.clone());
            it.bad = true;
            continue;
        }
        let h = read_all(f, it.start, 30)?;
        if le32(&h, 0) != 0x0403_4b50 {
            layout_bad.push(it.name.clone());
            it.bad = true;
            continue;
        }
        let (lnl, lxl) = (le16(&h, 26), le16(&h, 28));
        let ds = it.start + 30 + lnl + lxl;
        let de = match ds.checked_add(it.csize) {
            Some(x) => x,
            None => {
                layout_bad.push(it.name.clone());
                it.bad = true;
                continue;
            }
        };
        if de > it.end {
            // (Its data runs into the next entry, or past the directory: overlapping — refused in place, left out.)
            layout_bad.push(it.name.clone());
            it.bad = true;
            continue;
        }
        it.data_start = ds;
        it.data_end = de;
        it.dd = le16(&h, 6) & 8 != 0;
        let lname = read_all(f, it.start + 30, lnl as usize).unwrap_or_default();
        // The local header must say what the directory says (else two readers would see two archives: refused in place).
        let (lm, lcrc, lcs, lus) = (le16(&h, 8) as u16, le32(&h, 14) as u32, le32(&h, 18), le32(&h, 22));
        let sizes_ok = it.dd || zip64 || (Some(lcrc) == it.crc && lcs == it.csize && lus == it.usize) || lcs == 0xffff_ffff;
        if lname != it.name_raw || lm != it.method || !sizes_ok || it.data_end > it.end {
            layout_bad.push(it.name.clone());
            it.bad = true;
        }
    }
    // (Data before the first entry — a self-extractor's program —: a restore could not put it back; refused in place.)
    if let Some(first) = items.first() {
        if first.start > 0 && !layout_bad.contains(&first.name) {
            layout_bad.push(first.name.clone());
        }
    }
    let id_crc = crc32(&cd, 0);
    Ok(Scan { format: "zip", units: items, tail_start: cd_off, size, zip64, layout_bad, id_crc })
}

fn cstr(b: &[u8], o: usize, l: usize) -> String {
    let s = &b[o..o + l];
    let e = s.iter().position(|&x| x == 0).unwrap_or(l);
    String::from_utf8_lossy(&s[..e]).into_owned()
}
/// A header's number: octal text (None when it holds no digit), or base-256 when its first byte has the top bit.
fn octal(b: &[u8], o: usize, l: usize) -> Option<u64> {
    if b[o] & 0x80 != 0 {
        let mut v: u64 = 0;
        for &x in &b[o + 1..o + l] {
            v = v.wrapping_shl(8) | x as u64;
        }
        return Some(v);
    }
    let t = cstr(b, o, l);
    let d: String = t.trim().chars().take_while(|c| ('0'..='7').contains(c)).collect();
    if d.is_empty() {
        if t.trim().is_empty() {
            Some(0)
        } else {
            None
        }
    } else {
        u64::from_str_radix(&d, 8).ok()
    }
}
/// Whether 512 bytes are a tar header (archive.cjs isTarHead): the «ustar» magic, or the checksum of an old (v7)
/// header — the sum of the bytes with the checksum field as spaces.
pub fn is_tar_head(h: &[u8]) -> bool {
    if h.len() < 512 {
        return false;
    }
    if &h[257..262] == b"ustar" {
        return true;
    }
    let f: String = h[148..156].iter().map(|&c| c as char).collect();
    let f = f.trim_end_matches(['\0', ' ']).trim();
    if f.is_empty() || !f.chars().all(|c| ('0'..='7').contains(&c)) {
        return false;
    }
    let mut sum = 0u64;
    for (i, &v) in h[..512].iter().enumerate() {
        sum += if (148..156).contains(&i) { 32 } else { v as u64 };
    }
    u64::from_str_radix(f, 8).ok() == Some(sum) && h[..512].iter().any(|&v| v != 0)
}
/// Entry types never made on a computer: character and block devices, FIFOs, GNU sparse files.
pub fn special_tar_type(t: char) -> bool {
    matches!(t, '3' | '4' | '6' | 'S')
}
/// A tar's units (inplace.cjs tarUnits): each entry with its long-name / pax records; the end blocks are the tail.
pub fn tar_units(f: &mut File, size: u64) -> R<Scan> {
    let mut units: Vec<Unit> = Vec::new();
    let mut layout_bad = Vec::new();
    let (mut pos, mut long_name, mut group): (u64, Option<String>, Option<u64>) = (0, None, None);
    while pos + 512 <= size {
        let h = read_all(f, pos, 512)?;
        if h.iter().all(|&x| x == 0) {
            break;
        }
        if group.is_none() {
            group = Some(pos);
        }
        let mut sum = 0u64;
        for (i, &v) in h.iter().enumerate() {
            sum += if (148..156).contains(&i) { 32 } else { v as u64 };
        }
        let mut name = cstr(&h, 0, 100);
        let sz = octal(&h, 124, 12).unwrap_or(0);
        let t = if h[156] != 0 { h[156] as char } else { '0' };
        let link = cstr(&h, 157, 100);
        if cstr(&h, 257, 6).starts_with("ustar") {
            let pre = cstr(&h, 345, 155);
            if !pre.is_empty() {
                name = format!("{}/{}", pre, name);
            }
        }
        let data = pos + 512;
        let next = match sz.div_ceil(512).checked_mul(512).and_then(|x| x.checked_add(data)) {
            Some(x) => x,
            None => return Err(fail("badTar")),
        };
        let sum_ok = octal(&h, 148, 8) == Some(sum);
        if t == 'L' || t == 'x' {
            if sz > 1 << 20 {
                return Err(fail("badTar"));
            }
            let b = read_all(f, data, sz as usize)?;
            let text = String::from_utf8_lossy(&b).into_owned();
            if t == 'L' {
                long_name = Some(text.trim_end_matches('\0').to_string());
            } else {
                for rec in text.split('\n') {
                    if let Some(i) = rec.find(" path=") {
                        if i > 0 {
                            long_name = Some(rec[i + 6..].to_string());
                        }
                    }
                }
            }
            pos = next;
            continue;
        }
        if t == 'g' {
            pos = next;
            continue;
        }
        let full = long_name.take().unwrap_or(name);
        let nm = full.strip_prefix("./").map(|x| x.to_string()).unwrap_or(full);
        let mut u = Unit {
            name: nm.clone(),
            start: group.unwrap_or(pos),
            data_start: data,
            data_end: data + sz,
            end: next,
            usize: sz,
            csize: sz,
            method: 0,
            kind: t,
            dir: t == '5' || nm.ends_with('/'),
            link: if t == '2' { Some("sym") } else if t == '1' { Some("hard") } else { None },
            target: link,
            ..Default::default()
        };
        if !sum_ok || next > size || special_tar_type(t) {
            layout_bad.push(nm.clone());
            u.bad = true;
            u.data_end = u.data_start;
        }
        if !nm.is_empty() && nm != "." {
            units.push(u);
        }
        group = None;
        pos = next;
    }
    let tail_start = units.last().map(|u| u.end).unwrap_or(0);
    let id_crc = if units.is_empty() { 0 } else { crc32(&read_all(f, 0, size.min(512) as usize)?, 0) };
    Ok(Scan { format: "tar", units, tail_start, size, zip64: false, layout_bad, id_crc })
}
/// zip by its first bytes; tar by its header, or by its name with nothing but zeros at its start (an empty tar).
pub fn format_of(file: &Path) -> R<&'static str> {
    let mut f = File::open(file).map_err(ioe)?;
    let mut b = vec![0u8; 512];
    let mut got = 0;
    while got < 512 {
        let k = f.read(&mut b[got..]).map_err(ioe)?;
        if k == 0 {
            break;
        }
        got += k;
    }
    if got >= 2 && b[0] == 0x50 && b[1] == 0x4b {
        return Ok("zip");
    }
    let named = file.file_name().map(|x| x.to_string_lossy().to_lowercase().ends_with(".tar")).unwrap_or(false);
    if got >= 512 && (is_tar_head(&b) || named && b.iter().all(|&v| v == 0)) {
        return Ok("tar");
    }
    Err(fail("notArchive"))
}
pub fn units_of(file: &Path) -> R<Scan> {
    let fmt = format_of(file)?;
    let mut f = File::open(file).map_err(ioe)?;
    let size = f.metadata().map_err(ioe)?.len();
    if fmt == "zip" {
        zip_units(&mut f, size)
    } else {
        tar_units(&mut f, size)
    }
}

/* ---------- passwords: proved before anything is written ---------- */

struct ZipKeys([u32; 3]);
impl ZipKeys {
    fn new(pw: &str) -> ZipKeys {
        let mut k = ZipKeys([305_419_896, 591_751_049, 878_082_192]);
        for &c in pw.as_bytes() {
            k.up(c);
        }
        k
    }
    fn up(&mut self, c: u8) {
        let k = &mut self.0;
        k[0] = !crc32(&[c], !k[0]);
        k[1] = k[1].wrapping_add(k[0] & 0xff).wrapping_mul(134_775_813).wrapping_add(1);
        k[2] = !crc32(&[(k[1] >> 24) as u8], !k[2]);
    }
    fn byte(&self) -> u8 {
        let t = (self.0[2] | 2) & 0xffff;
        ((t * (t ^ 1)) >> 8) as u8
    }
}
/// A decrypting reader for traditional («ZipCrypto») encryption; the 12-byte header checked first.
struct ZcRead<'a> {
    inner: &'a mut dyn Read,
    k: ZipKeys,
    skip: u8,
    check: u8,
}
impl<'a> Read for ZcRead<'a> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            let got = self.inner.read(buf)?;
            if got == 0 {
                return Ok(0);
            }
            let mut w = 0;
            for i in 0..got {
                let p = buf[i] ^ self.k.byte();
                self.k.up(p);
                if self.skip > 0 {
                    self.skip -= 1;
                    if self.skip == 0 && p != self.check {
                        return Err(io::Error::other("wrongPassword"));
                    }
                    continue;
                }
                buf[w] = p;
                w += 1;
            }
            if w > 0 {
                return Ok(w);
            }
        }
    }
}
/// Bytes read with their CRC kept.
struct CrcRead<'a> {
    inner: &'a mut dyn Read,
    crc: u32,
}
impl<'a> Read for CrcRead<'a> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let k = self.inner.read(buf)?;
        self.crc = crc32(&buf[..k], self.crc);
        Ok(k)
    }
}
/// Where decoded bytes go: their CRC kept, each charged to the volume, counted to the progress, written if a file is given.
struct Sink<'a, 'b, 'c> {
    out: Option<&'a mut dyn Write>,
    crc: u32,
    io: &'b dyn Io,
    tick: &'c mut dyn FnMut(u64),
    /// A Cancel heard inside a large file too: asked every STOP_EVERY bytes.
    stop: &'b dyn Fn() -> bool,
    since: u64,
}
/// How often a unit being written asks whether the job was cancelled (bytes).
pub const STOP_EVERY: u64 = 8 * 1024 * 1024;
impl<'a, 'b, 'c> Write for Sink<'a, 'b, 'c> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.since += buf.len() as u64;
        if self.since >= STOP_EVERY {
            self.since = 0;
            if (self.stop)() {
                return Err(io::Error::other("stopped"));
            }
        }
        self.io.charge(buf.len() as u64).map_err(|_| io::Error::other("noSpace"))?;
        if let Some(o) = self.out.as_mut() {
            o.write_all(buf)?;
        }
        self.crc = crc32(buf, self.crc);
        (self.tick)(buf.len() as u64);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        match self.out.as_mut() {
            Some(o) => o.flush(),
            None => Ok(()),
        }
    }
}
/// The check byte the 12-byte ZipCrypto header ends with.
fn zc_check(u: &Unit) -> u8 {
    if u.dd {
        (u.time >> 8) as u8
    } else {
        (u.crc.unwrap_or(0) >> 24) as u8
    }
}
/// One unit's data decoded into `out` (None: only its CRC) → (CRC of the decoded bytes, CRC of the raw bytes).
fn decode(f: &mut File, u: &Unit, password: &str, codec: &dyn Codec, io: &dyn Io, out: Option<&mut dyn Write>, tick: &mut dyn FnMut(u64), stop: &dyn Fn() -> bool) -> io::Result<(u32, u32)> {
    f.seek(SeekFrom::Start(u.data_start))?;
    let mut range = (&mut *f).take(u.csize);
    let mut raw = CrcRead { inner: &mut range, crc: 0 };
    let mut sink = Sink { out, crc: 0, io, tick, stop, since: 0 };
    {
        let mut zc;
        let src: &mut dyn Read = if u.encrypted {
            zc = ZcRead { inner: &mut raw, k: ZipKeys::new(password), skip: 12, check: zc_check(u) };
            &mut zc
        } else {
            &mut raw
        };
        if u.method == 8 {
            codec.inflate(src, &mut sink)?;
        } else {
            io::copy(src, &mut sink)?;
        }
    }
    sink.flush()?;
    Ok((sink.crc, raw.crc))
}

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476, 0xC3D2_E1F0];
    let mut m = data.to_vec();
    let bits = (data.len() as u64).wrapping_mul(8);
    m.push(0x80);
    while m.len() % 64 != 56 {
        m.push(0);
    }
    m.extend_from_slice(&bits.to_be_bytes());
    for c in m.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([c[4 * i], c[4 * i + 1], c[4 * i + 2], c[4 * i + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut cc, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & cc) | (!b & d), 0x5A82_7999),
                20..=39 => (b ^ cc ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & cc) | (b & d) | (cc & d), 0x8F1B_BCDC),
                _ => (b ^ cc ^ d, 0xCA62_C1D6),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*wi);
            e = d;
            d = cc;
            cc = b.rotate_left(30);
            b = a;
            a = t;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(cc);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut o = [0u8; 20];
    for i in 0..5 {
        o[4 * i..4 * i + 4].copy_from_slice(&h[i].to_be_bytes());
    }
    o
}
fn hmac_sha1(key: &[u8], msg: &[u8]) -> [u8; 20] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..20].copy_from_slice(&sha1(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner: Vec<u8> = k.iter().map(|x| x ^ 0x36).collect();
    inner.extend_from_slice(msg);
    let mut outer: Vec<u8> = k.iter().map(|x| x ^ 0x5c).collect();
    outer.extend_from_slice(&sha1(&inner));
    sha1(&outer)
}
pub fn pbkdf2_sha1(pw: &[u8], salt: &[u8], iters: u32, len: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut block = 1u32;
    while out.len() < len {
        let mut m = salt.to_vec();
        m.extend_from_slice(&block.to_be_bytes());
        let mut u = hmac_sha1(pw, &m);
        let mut t = u;
        for _ in 1..iters {
            u = hmac_sha1(pw, &u);
            for i in 0..20 {
                t[i] ^= u[i];
            }
        }
        out.extend_from_slice(&t);
        block += 1;
    }
    out.truncate(len);
    out
}
/// The password proved on the smallest locked file → «none», «missing», «ok» or «wrong» (AES: the PBKDF2 verifier;
/// ZipCrypto: the header's check byte, then the whole file decoded and its CRC compared).
pub fn check_password(file: &Path, scan: &Scan, pw: Option<&str>, codec: &dyn Codec) -> R<&'static str> {
    let enc: Vec<&Unit> = scan.units.iter().filter(|u| u.encrypted && !u.dir).collect();
    if enc.is_empty() {
        return Ok("none");
    }
    let pw = match pw {
        Some(p) if !p.is_empty() => p,
        _ => return Ok("missing"),
    };
    let mut u = enc[0];
    for b in enc.iter() {
        if b.csize < u.csize {
            u = b;
        }
    }
    let mut f = File::open(file).map_err(ioe)?;
    if u.method == 99 || u.aes.is_some() {
        let n = match u.aes {
            Some(1) => 8,
            Some(2) => 12,
            _ => 16,
        };
        let key_len = match n {
            8 => 16,
            12 => 24,
            _ => 32,
        };
        let b = read_all(&mut f, u.data_start, n + 2)?;
        let dk = pbkdf2_sha1(pw.as_bytes(), &b[..n], 1000, 2 * key_len + 2);
        return Ok(if dk[2 * key_len..] == b[n..n + 2] { "ok" } else { "wrong" });
    }
    let r = decode(&mut f, u, pw, codec, &NoIo, None, &mut |_| {}, &|| false);
    Ok(match r {
        Ok((c, _)) if Some(c) == u.crc => "ok",
        _ => "wrong",
    })
}
struct NoIo;
impl Io for NoIo {
    fn free_space(&self, _d: &Path) -> i64 {
        -1
    }
}

/// Verify-first: every file's checksum read (nothing written) → the names that failed.
pub fn verify_all(file: &Path, scan: &Scan, pr: &Pr, password: &str, codec: &dyn Codec) -> R<Vec<String>> {
    let mut bad = Vec::new();
    let mut f = File::open(file).map_err(ioe)?;
    let total: u64 = scan.units.iter().map(|u| if u.dir { 0 } else { u.csize }).sum();
    let mut done = 0u64;
    for u in scan.units.iter() {
        if u.dir || u.link.is_some() {
            continue;
        }
        if (pr.stopped)() {
            return Err(fail("stopped"));
        }
        if u.bad {
            bad.push(u.name.clone());
            continue;
        }
        if scan.format == "tar" {
            done += u.csize;
            continue;
        }
        if !OWN_METHODS.contains(&u.method) {
            continue;
        }
        match decode(&mut f, u, password, codec, &NoIo, None, &mut |_| {}, &|| false) {
            Ok((c, _)) if Some(c) == u.crc => {}
            _ => bad.push(u.name.clone()),
        }
        done += u.csize;
        (pr.on)(done, total, &u.name);
    }
    Ok(bad)
}

/* ---------- the facts and the pre-flight ---------- */

/// One entry as the pre-flight sees it.
#[derive(Clone, Debug, Default)]
pub struct FEntry {
    pub path: String,
    pub dir: bool,
    pub link: Option<String>,
    pub target: String,
    pub method: Option<u16>,
    pub encrypted: bool,
    pub csize: i64,
    pub usize: i64,
    pub offset: Option<u64>,
    pub unit_bytes: Option<u64>,
}
/// Everything the pre-flight needs, gathered without writing (archsafe.cjs's `f`).
#[derive(Clone, Debug, Default)]
pub struct Facts {
    pub format: String,
    pub size: u64,
    pub platform: String,
    pub dest_len: usize,
    pub entries: Vec<FEntry>,
    pub supported: Vec<u16>,
    pub external: Vec<u16>,
    pub encrypted: bool,
    pub password: String,
    pub damaged: Vec<String>,
    pub layout_bad: Vec<String>,
    pub volumes: Option<(Vec<String>, Vec<String>)>,
    pub archive_writable: bool,
    pub dest_writable: bool,
    pub saf: bool,
    pub same_volume: bool,
    pub free: i64,
    pub existing: Vec<String>,
    pub busy: bool,
    pub in_place_format: bool,
    pub tail_bytes: u64,
    pub block_size: u64,
    /// Paths in the destination this job's own files take (the archive, its journal, tail, lock, unit log and their
    /// temporary copies — when the destination is the archive's folder): no entry may be written there.
    pub reserved: Vec<String>,
}
fn nums(o: &J, k: &str) -> Vec<u16> {
    o.get(k).and_then(|x| x.as_arr()).map(|a| a.iter().filter_map(|x| if let J::Num(v, _) = x { Some(*v as u16) } else { None }).collect()).unwrap_or_default()
}
impl Facts {
    /// From the page's or a test vector's JSON (archsafe.cjs's field names).
    pub fn from_j(o: &J) -> Facts {
        let entries = o
            .get("entries")
            .and_then(|x| x.as_arr())
            .map(|a| {
                a.iter()
                    .map(|e| FEntry {
                        path: gs(e, "path"),
                        dir: gb(e, "dir"),
                        link: e.get("link").and_then(|x| x.as_str()).map(|x| x.to_string()),
                        target: gs(e, "target"),
                        method: gn(e, "method").map(|x| x as u16),
                        encrypted: gb(e, "encrypted"),
                        csize: gn(e, "csize").unwrap_or(0.0) as i64,
                        usize: gn(e, "usize").unwrap_or(0.0) as i64,
                        offset: gn(e, "offset").map(|x| x as u64),
                        unit_bytes: gn(e, "unitBytes").map(|x| x as u64),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let volumes = o.get("volumes").filter(|v| matches!(v, J::Obj(_))).map(|v| (gstrs(v, "missing"), gstrs(v, "odd")));
        Facts {
            format: gs(o, "format"),
            size: gu(o, "size"),
            platform: gs(o, "platform"),
            dest_len: gu(o, "destLen") as usize,
            entries,
            supported: nums(o, "supported"),
            external: nums(o, "external"),
            encrypted: gb(o, "encrypted"),
            password: gs(o, "password"),
            damaged: gstrs(o, "damaged"),
            layout_bad: gstrs(o, "layoutBad"),
            volumes,
            archive_writable: gb(o, "archiveWritable"),
            dest_writable: gb(o, "destWritable"),
            saf: gb(o, "saf"),
            same_volume: gb(o, "sameVolume"),
            free: gn(o, "free").map(|x| x as i64).unwrap_or(-1),
            existing: gstrs(o, "existing"),
            busy: gb(o, "busy"),
            in_place_format: gb(o, "inPlaceFormat"),
            tail_bytes: gu(o, "tailBytes"),
            block_size: gu(o, "blockSize"),
            reserved: gstrs(o, "reserved"),
        }
    }
    /// The facts for the page (inplace.cjs hands them without the entries).
    pub fn to_j(&self) -> J {
        let nums = |v: &[u16]| J::Arr(v.iter().map(|x| n(*x)).collect());
        obj(vec![
            ("format", s(&self.format)),
            ("size", n(self.size as f64)),
            ("platform", s(&self.platform)),
            ("destLen", n(self.dest_len as f64)),
            ("supported", nums(&self.supported)),
            ("external", nums(&self.external)),
            ("encrypted", J::Bool(self.encrypted)),
            ("password", s(&self.password)),
            ("damaged", strs(&self.damaged)),
            ("layoutBad", strs(&self.layout_bad)),
            ("volumes", self.volumes.as_ref().map(|(m, o)| obj(vec![("missing", strs(m)), ("odd", strs(o))])).unwrap_or(J::Null)),
            ("archiveWritable", J::Bool(self.archive_writable)),
            ("destWritable", J::Bool(self.dest_writable)),
            ("saf", J::Bool(self.saf)),
            ("sameVolume", J::Bool(self.same_volume)),
            ("free", n(self.free as f64)),
            ("existing", strs(&self.existing)),
            ("busy", J::Bool(self.busy)),
            ("inPlaceFormat", J::Bool(self.in_place_format)),
            ("tailBytes", n(self.tail_bytes as f64)),
            ("blockSize", n(self.block_size as f64)),
            ("reserved", strs(&self.reserved)),
        ])
    }
}

const NAME_REFUSALS: [&str; 8] = ["empty", "nul", "dot", "dotdot", "absolute", "drive", "reservedSuffix", "pathLong"];
fn fix_of(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "method" => "fixMethod",
        "password" => "fixPassword",
        "names" => "fixNames",
        "clash" => "fixClash",
        "links" => "fixLinks",
        "space" => "fixSpace",
        "layout" => "fixLayout",
        "damaged" => "fixDamaged",
        "volumes" => "fixVolumes",
        "readonly" => "fixReadonly",
        "saf" => "fixSaf",
        "busy" => "fixBusy",
        "ratio" => "fixRatio",
        "existing" => "fixExisting",
        "rewrite" => "fixRewrite",
        "otherVolume" => "fixOtherVolume",
        "resume" => "fixResume",
        _ => return None,
    })
}
struct Prob {
    kind: &'static str,
    severity: &'static str,
    count: usize,
    names: Vec<String>,
    fix: Option<&'static str>,
    extra: Vec<(&'static str, J)>,
}
fn uniq<T: PartialEq + Clone>(v: &[T]) -> Vec<T> {
    let mut o: Vec<T> = Vec::new();
    for x in v {
        if !o.contains(x) {
            o.push(x.clone());
        }
    }
    o
}
/// Everything checked before anything is written (archsafe.cjs preflight): the report the sheet shows.
pub fn preflight(f: &Facts, margin: u64) -> J {
    let p = match S::platform(&f.platform) {
        Some(p) => p,
        None => S::platform("linux").unwrap(),
    };
    let mut probs: Vec<Prob> = Vec::new();
    fn add(probs: &mut Vec<Prob>, kind: &'static str, severity: &'static str, names: Vec<String>, extra: Vec<(&'static str, J)>) {
        if names.is_empty() {
            return;
        }
        probs.push(Prob { kind, severity, count: names.len(), names: names.into_iter().take(5).collect(), fix: fix_of(kind), extra });
    }
    let files: Vec<&FEntry> = f.entries.iter().filter(|e| !e.dir).collect();
    // Names, for the real destination.
    let items: Vec<(String, S::Verdict)> = f.entries.iter().map(|e| (e.path.clone(), S::path_rule(&e.path, p, f.dest_len))).collect();
    let es: Vec<S::Entry> = f.entries.iter().map(|e| S::Entry { path: e.path.clone(), dir: e.dir, link: e.link.as_deref().map(|l| if l == "hard" { "hard" } else { "sym" }), target: e.target.clone() }).collect();
    let set = S::check_set(&es, p, f.dest_len);
    let mut refused: Vec<String> = set.iter().filter(|x| NAME_REFUSALS.contains(&x.kind)).map(|x| x.path.clone()).collect();
    // The job's own names: an entry where the aside folder goes (any «.kurokawa-replaced…» first folder), or on the
    // archive, its journal, tail, lock, unit log or their temporary copies — refused as an unsafe name.
    let reserved: HashSet<String> = f.reserved.iter().map(|x| S::fold_key(x, p)).collect();
    let aside_key = S::fold_key(S::ASIDE_DIR, p);
    for (path, v) in items.iter() {
        if v.action == "refuse" || refused.contains(path) {
            continue;
        }
        let first = v.out.split('/').next().unwrap_or("");
        if S::fold_key(first, p).starts_with(&aside_key) || reserved.contains(&S::fold_key(&v.out, p)) {
            refused.push(path.clone());
        }
    }
    let clashes: Vec<&S::Problem> = set.iter().filter(|x| ["duplicate", "caseClash", "rewriteClash", "fileDir"].contains(&x.kind)).collect();
    let links: Vec<String> = set.iter().filter(|x| x.kind == "linkOutside" || x.kind == "throughLink").map(|x| x.path.clone()).collect();
    let rewrites: Vec<J> = items
        .iter()
        .filter(|(_, v)| v.action == "rewrite" && !v.reasons.is_empty())
        .map(|(path, v)| obj(vec![("from", s(path)), ("to", s(&v.out)), ("reasons", J::Arr(v.reasons.iter().map(|r| s(r)).collect()))]))
        .collect();
    let flagged: Vec<String> = items.iter().filter(|(_, v)| v.flags.contains(&"bidi") || v.flags.contains(&"control")).map(|(path, _)| path.clone()).collect();
    add(&mut probs, "names", "block", refused, vec![]);
    let kinds = uniq(&clashes.iter().map(|x| x.kind).collect::<Vec<_>>());
    add(&mut probs, "clash", "inPlace", clashes.iter().map(|x| x.path.clone()).collect(), vec![("kinds", J::Arr(kinds.iter().map(|k| s(k)).collect()))]);
    add(&mut probs, "links", "block", links, vec![]);
    let rw_from: Vec<String> = rewrites.iter().map(|r| gs(r, "from")).collect();
    add(&mut probs, "rewrite", "info", rw_from, vec![("rewrites", J::Arr(rewrites.iter().take(50).cloned().collect()))]);
    if !flagged.is_empty() {
        add(&mut probs, "bidi", "info", flagged, vec![]);
    }
    // Methods: what this device decodes (in place needs our own decoder; a helper may do a normal extraction).
    let own: Vec<&&FEntry> = files.iter().filter(|e| e.method.map(|m| !f.supported.contains(&m)).unwrap_or(false)).collect();
    let none = own.iter().any(|e| !f.external.contains(&e.method.unwrap()));
    if !own.is_empty() {
        let methods = uniq(&own.iter().map(|e| e.method.unwrap()).collect::<Vec<_>>());
        probs.push(Prob {
            kind: "method",
            severity: if none { "block" } else { "inPlace" },
            count: own.len(),
            names: own.iter().take(5).map(|e| e.path.clone()).collect(),
            fix: fix_of("method"),
            extra: vec![("methods", J::Arr(methods.iter().map(|m| n(*m)).collect()))],
        });
    }
    // Encryption: the password proved on the smallest locked file before anything is written.
    if f.encrypted && f.password != "ok" {
        add(&mut probs, "password", "block", vec![if f.password == "wrong" { "wrong" } else { "missing" }.to_string()], vec![]);
    }
    if f.encrypted {
        probs.push(Prob { kind: "encryptedInPlace", severity: "inPlace", count: 1, names: vec![], fix: fix_of("password"), extra: vec![] });
    }
    add(&mut probs, "damaged", "inPlace", f.damaged.clone(), vec![]);
    add(&mut probs, "layout", "inPlace", f.layout_bad.clone(), vec![]);
    if let Some((m, o)) = &f.volumes {
        add(&mut probs, "volumes", "block", m.iter().chain(o.iter()).cloned().collect(), vec![]);
    }
    if f.busy {
        add(&mut probs, "busy", "block", vec!["busy".into()], vec![]);
    }
    if f.saf {
        add(&mut probs, "saf", "inPlace", vec!["saf".into()], vec![]);
    }
    if !f.archive_writable {
        add(&mut probs, "readonly", "inPlace", vec!["archive".into()], vec![]);
    }
    if !f.dest_writable {
        add(&mut probs, "readonly", "block", vec!["destination".into()], vec![]);
    }
    if !f.in_place_format {
        probs.push(Prob { kind: "formatInPlace", severity: "inPlace", count: 1, names: vec![], fix: Some("fixFormat"), extra: vec![] });
    }
    // Already there: counted, each to be asked about (or the «for the rest» answer).
    let exist: HashSet<String> = f.existing.iter().map(|x| S::fold_key(x, p)).collect();
    let there: Vec<String> = items.iter().filter(|(_, v)| v.action != "refuse" && exist.contains(&S::fold_key(&v.out, p))).map(|(path, _)| path.clone()).collect();
    add(&mut probs, "existing", "ask", there, vec![]);
    // A calm word about extreme squeeze (a «zip bomb»): the numbers, nothing refused.
    let packed: i64 = files.iter().map(|e| e.csize).sum();
    let total: u64 = files.iter().map(|e| e.usize.max(0) as u64).sum();
    let ratio = if packed > 0 { total as f64 / packed as f64 } else { 0.0 };
    if ratio > 100.0 && total > 1024u64.pow(3) {
        probs.push(Prob {
            kind: "ratio",
            severity: "info",
            count: 1,
            names: vec![],
            fix: fix_of("ratio"),
            extra: vec![("ratio", n(vidjson::js_round(ratio))), ("total", n(total as f64)), ("packed", n(packed as f64))],
        });
    }
    // Space: normal = every output; in place = the replay's peak (last unit first), plus the saved tail and journal.
    let mut order: Vec<&FEntry> = files.clone();
    if f.in_place_format {
        order.sort_by(|a, b| b.offset.unwrap_or(0).cmp(&a.offset.unwrap_or(0)));
    }
    let overhead = 65536 + f.tail_bytes;
    let bs = if f.block_size == 0 { 4096 } else { f.block_size };
    let units: Vec<(u64, u64)> = order.iter().map(|e| (e.usize.max(0) as u64, e.unit_bytes.unwrap_or(e.csize.max(0) as u64))).collect();
    let (sp_normal, sp_in_place, _) = S::replay_space(&units, f.same_volume, bs, overhead);
    let fits_normal = f.free < 0 || (sp_normal + margin) as i64 <= f.free;
    let fits_in_place = f.free < 0 || (sp_in_place + margin) as i64 <= f.free;
    let space = obj(vec![
        ("free", n(f.free as f64)),
        ("normal", n(sp_normal as f64)),
        ("inPlace", n(sp_in_place as f64)),
        ("margin", n(margin as f64)),
        ("sameVolume", J::Bool(f.same_volume)),
        ("fitsNormal", J::Bool(fits_normal)),
        ("fitsInPlace", J::Bool(fits_in_place)),
    ]);
    let blockers: Vec<&'static str> = probs.iter().filter(|x| x.severity == "block").map(|x| x.kind).collect();
    let ip_blockers: Vec<&'static str> = probs.iter().filter(|x| x.severity == "inPlace" || x.severity == "block").map(|x| x.kind).collect();
    let normal_ok = blockers.is_empty() && fits_normal;
    let mut normal_why: Vec<&str> = blockers.clone();
    if !fits_normal {
        normal_why.push("space");
    }
    let ip_ok = ip_blockers.is_empty() && fits_in_place && f.same_volume;
    let mut ip_why: Vec<&str> = ip_blockers.clone();
    if !fits_in_place {
        ip_why.push("space");
    }
    if !f.same_volume {
        ip_why.push("otherVolume");
    }
    if !normal_ok && !ip_ok && !fits_normal {
        add(&mut probs, "space", "block", vec!["space".into()], vec![]);
    }
    if !f.same_volume && !fits_normal {
        add(&mut probs, "otherVolume", "info", vec!["otherVolume".into()], vec![]);
    }
    let recommend = if normal_ok && (!ip_ok || fits_normal) { "normal" } else if ip_ok { "inPlace" } else { "none" };
    let why = match recommend {
        "normal" => if ip_ok { "bothFit" } else { "normalOnly" },
        "inPlace" => "onlyInPlaceFits",
        _ => {
            if fits_normal || fits_in_place {
                "blocked"
            } else if normal_why.contains(&"space") && !f.same_volume {
                "otherVolume"
            } else {
                "nothingFits"
            }
        }
    };
    let problems: Vec<J> = probs
        .iter()
        .map(|x| {
            let mut v = vec![("kind", s(x.kind)), ("severity", s(x.severity)), ("count", n(x.count as f64)), ("names", strs(&x.names))];
            if let Some(fx) = x.fix {
                v.push(("fix", s(fx)));
            }
            for (k, e) in x.extra.iter() {
                v.push((k, e.clone()));
            }
            obj(v)
        })
        .collect();
    let sj = |v: &[&str]| J::Arr(v.iter().map(|x| s(x)).collect());
    obj(vec![
        ("ok", J::Bool(normal_ok || ip_ok)),
        ("files", n(files.len() as f64)),
        ("total", n(total as f64)),
        ("problems", J::Arr(problems)),
        ("rewrites", J::Arr(rewrites)),
        ("space", space),
        ("normal", obj(vec![("ok", J::Bool(normal_ok)), ("why", sj(&normal_why))])),
        ("inPlace", obj(vec![("ok", J::Bool(ip_ok)), ("why", sj(&ip_why))])),
        ("recommend", s(recommend)),
        ("why", s(why)),
    ])
}

/// The pre-flight of an archive 7-Zip extracts (archive.cjs preflight's second branch): its listed entries as (path,
/// dir, size, packed), a normal extraction only; 7-Zip decodes what it lists, so no method problem.
#[allow(clippy::too_many_arguments)]
pub fn preflight_listed(format: &str, platform: &str, entries: &[(String, bool, i64, i64)], encrypted: bool, password_given: bool, free: i64, existing: Vec<String>, keep_free: u64) -> J {
    let f = Facts {
        format: format.to_string(),
        platform: platform.to_string(),
        entries: entries.iter().map(|(p, d, u, c)| FEntry { path: p.clone(), dir: *d, usize: *u, csize: *c, ..Default::default() }).collect(),
        encrypted,
        password: if encrypted && !password_given { "missing" } else { "ok" }.to_string(),
        archive_writable: true,
        dest_writable: true,
        same_volume: true,
        free,
        existing,
        ..Default::default()
    };
    let mut r = preflight(&f, keep_free);
    if let J::Obj(v) = &mut r {
        let mut normal_ok = false;
        for (k, x) in v.iter_mut() {
            if k == "problems" {
                if let J::Arr(a) = x {
                    a.retain(|p| gs(p, "kind") != "method");
                }
            }
            if k == "normal" {
                let why: Vec<String> = gstrs(x, "why").into_iter().filter(|w| w != "method").collect();
                normal_ok = why.is_empty();
                *x = obj(vec![("ok", J::Bool(normal_ok)), ("why", strs(&why))]);
            }
        }
        let rec_none = v.iter().any(|(k, x)| k == "recommend" && x.as_str() == Some("none"));
        for (k, x) in v.iter_mut() {
            if k == "ok" {
                *x = J::Bool(normal_ok);
            }
            if rec_none && normal_ok && k == "recommend" {
                *x = s("normal");
            }
            if rec_none && normal_ok && k == "why" {
                *x = s("normalOnly");
            }
        }
    }
    r
}

/// Split volumes complete? (all of «x.zip.001…» present in a row, every one but the last the same size) → (missing, odd).
pub fn volumes_of(file: &Path) -> Option<(Vec<String>, Vec<String>)> {
    let full = lossy(file);
    let low = full.to_lowercase();
    if low.len() < 4 || !low.is_char_boundary(low.len() - 4) {
        return None;
    }
    let (stem, num) = full.split_at(full.len() - 4);
    if !num.starts_with('.') || !num[1..].bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let sl = stem.to_lowercase();
    if !(sl.ends_with(".zip") || sl.ends_with(".7z") || sl.ends_with(".tar")) {
        return None;
    }
    let mut parts: Vec<PathBuf> = Vec::new();
    for i in 1..1000 {
        let v = PathBuf::from(format!("{}.{:03}", stem, i));
        if !exists(&v) {
            break;
        }
        parts.push(v);
    }
    let stem_p = Path::new(stem);
    let base = stem_p.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default();
    let dir = stem_p.parent().map(|d| d.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
    let mut missing: Vec<String> = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let f = e.file_name().to_string_lossy().into_owned();
            if f.len() == base.len() + 4 && f.is_char_boundary(base.len()) && f[..base.len()].to_lowercase() == base.to_lowercase() && f.as_bytes()[base.len()] == b'.' && f[base.len() + 1..].bytes().all(|b| b.is_ascii_digit()) {
                let k: usize = f[base.len() + 1..].parse().unwrap_or(0);
                if k > parts.len() + 1 {
                    let m = format!("{}.{:03}", base, parts.len() + 1);
                    if !missing.contains(&m) {
                        missing.push(m);
                    }
                }
            }
        }
    }
    let sizes: Vec<u64> = parts.iter().map(|v| fs::metadata(v).map(|m| m.len()).unwrap_or(0)).collect();
    let name = |p: &PathBuf| p.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default();
    let mut odd = Vec::new();
    for i in 0..sizes.len().saturating_sub(1) {
        if sizes[i] != sizes[0] {
            odd.push(name(&parts[i]));
        }
    }
    if sizes.len() > 1 && sizes[sizes.len() - 1] > sizes[0] {
        odd.push(name(&parts[parts.len() - 1]));
    }
    Some((missing, odd))
}
fn writable(p: &Path) -> bool {
    match fs::metadata(p) {
        Ok(m) if m.is_dir() => {
            let probe = p.join(format!(".kt-probe-{}", new_id()));
            match OpenOptions::new().write(true).create_new(true).open(&probe) {
                Ok(_) => {
                    let _ = fs::remove_file(&probe);
                    true
                }
                Err(_) => false,
            }
        }
        Ok(m) => !m.permissions().readonly() && OpenOptions::new().write(true).open(p).is_ok(),
        Err(_) => false,
    }
}
#[cfg(unix)]
fn dev_of(p: &Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(nearest_dir(p)).ok().map(|m| m.dev())
}
#[cfg(not(unix))]
fn dev_of(p: &Path) -> Option<u64> {
    // (Windows: the drive or share the folder is on.)
    use std::hash::{Hash, Hasher};
    use std::path::Component;
    let d = nearest_dir(p);
    match d.components().next() {
        Some(Component::Prefix(px)) => {
            let mut h = std::collections::hash_map::DefaultHasher::new();
            px.as_os_str().to_string_lossy().to_uppercase().hash(&mut h);
            Some(h.finish())
        }
        _ => None,
    }
}
fn measure_dest(dest: &Path, p: &S::Platform) -> usize {
    let mut d = lossy(&abs(dest));
    d.push(std::path::MAIN_SEPARATOR);
    S::measure(&d, p.utf16)
}
/// This computer's line of the name table.
pub fn host_platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// What gathering the facts takes.
#[derive(Clone, Debug, Default)]
pub struct FactOpts {
    pub password: Option<String>,
    pub verify: bool,
    pub platform: Option<String>,
    pub external: Vec<u16>,
}
/// Everything the pre-flight needs, gathered without writing → (facts, units).
pub fn facts(file: &Path, dest: &Path, o: &FactOpts, env: &Env, pr: &Pr) -> R<(Facts, Scan)> {
    // (A saved tail with no journal: a job killed before its first change — the archive whole; the leftover removed.)
    if !exists(&journal_of(file)) && exists(&tail_of(file)) {
        let _ = fs::remove_file(tail_of(file));
    }
    let scan = units_of(file)?;
    let platform = o.platform.clone().unwrap_or_else(|| host_platform().to_string());
    let p = S::platform(&platform).ok_or_else(|| fail(format!("platform {}", platform)))?;
    let encrypted = scan.units.iter().any(|u| u.encrypted);
    let password = if encrypted { check_password(file, &scan, o.password.as_deref(), env.codec)? } else { "none" };
    let damaged = if o.verify { verify_all(file, &scan, pr, if password == "ok" { o.password.as_deref().unwrap_or("") } else { "" }, env.codec)? } else { vec![] };
    let dest_dir = nearest_dir(dest);
    let free = env.io.free_space(&dest_dir);
    let same_volume = dev_of(file.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."))) == dev_of(&dest_dir);
    let mut existing = Vec::new();
    for u in scan.units.iter() {
        let r = S::path_rule(&u.name, p, 0);
        if r.action != "refuse" && !u.dir && exists(&dest.join(&r.out)) {
            existing.push(r.out);
        }
    }
    let mut reserved = Vec::new();
    if abs(file).parent().map(|d| d.to_path_buf()) == Some(abs(dest)) {
        if let Some(nm) = file.file_name().map(|x| x.to_string_lossy().into_owned()) {
            for sfx in ["", JOURNAL_SUFFIX, TAIL_SUFFIX, LOCK_SUFFIX] {
                reserved.push(format!("{}{}", nm, sfx));
                reserved.push(format!("{}{}.tmp", nm, sfx));
            }
            reserved.push(format!("{}{}.log", nm, JOURNAL_SUFFIX));
        }
    }
    let vols = volumes_of(file);
    let lock = with_suffix(file, LOCK_SUFFIX);
    let busy = exists(&lock) && lock_alive(&lock, env.io);
    let journal = exists(&journal_of(file));
    let entries = scan
        .units
        .iter()
        .map(|u| FEntry {
            path: u.name.clone(),
            dir: u.dir,
            link: u.link.map(|x| x.to_string()),
            target: u.target.clone(),
            method: if u.dir { None } else { Some(u.method) },
            encrypted: u.encrypted,
            csize: u.csize as i64,
            usize: u.usize as i64,
            offset: Some(u.start),
            unit_bytes: Some(u.end - u.start),
        })
        .collect();
    let tail_bytes = scan.size.saturating_sub(scan.tail_start).saturating_add(scan.units.iter().map(|u| u.data_start.saturating_sub(u.start).saturating_add(u.end.saturating_sub(u.data_end))).fold(0u64, |a, b| a.saturating_add(b)));
    let f = Facts {
        format: scan.format.to_string(),
        size: scan.size,
        platform: platform.clone(),
        dest_len: measure_dest(dest, p),
        entries,
        supported: OWN_METHODS.to_vec(),
        external: o.external.clone(),
        encrypted,
        password: password.to_string(),
        damaged,
        layout_bad: scan.layout_bad.clone(),
        volumes: vols.clone(),
        archive_writable: writable(file),
        dest_writable: writable(&dest_dir),
        saf: lossy(file).starts_with("content:"),
        same_volume,
        free,
        existing,
        busy: busy || journal,
        in_place_format: vols.is_none(),
        tail_bytes,
        block_size: 4096,
        reserved,
    };
    Ok((f, scan))
}
/// The pre-flight for the sheet: { report, facts } (nothing written).
pub fn preflight_of(file: &Path, dest: &Path, o: &FactOpts, keep_free: u64, env: &Env, pr: &Pr) -> R<J> {
    let (f, _) = facts(file, dest, o, env, pr)?;
    Ok(obj(vec![("report", preflight(&f, keep_free)), ("facts", f.to_j())]))
}

/* ---------- the lock: one job per archive ---------- */

fn locks() -> &'static Mutex<HashSet<PathBuf>> {
    static L: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(HashSet::new()))
}
fn held(lock: &Path) -> bool {
    locks().lock().map(|g| g.contains(lock)).unwrap_or(true)
}
fn lock_alive(lock: &Path, io: &dyn Io) -> bool {
    let text = match fs::read_to_string(lock) {
        Ok(t) => t,
        Err(_) => return false,
    };
    let pid: u32 = text.split(' ').next().and_then(|x| x.trim().parse().ok()).unwrap_or(0);
    if pid == 0 {
        return true;
    }
    if pid == std::process::id() {
        return held(lock);
    }
    io.pid_alive(pid)
}
/// The archive's lock, held until dropped.
pub struct Lock {
    path: Option<PathBuf>,
    on_disk: bool,
}
impl Drop for Lock {
    fn drop(&mut self) {
        if let Some(p) = self.path.take() {
            if let Ok(mut g) = locks().lock() {
                g.remove(&p);
            }
            if self.on_disk {
                let _ = fs::remove_file(&p);
            }
        }
    }
}
fn take_lock(file: &Path, io: &dyn Io) -> R<Lock> {
    let lock = abs(&with_suffix(file, LOCK_SUFFIX));
    if held(&lock) {
        return Err(fail("busy"));
    }
    let stamp = format!("{} {}", std::process::id(), now_ms() as u64);
    let mut on_disk = true;
    match OpenOptions::new().write(true).create_new(true).open(&lock) {
        Ok(mut h) => {
            let _ = h.write_all(stamp.as_bytes());
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            if lock_alive(&lock, io) {
                return Err(fail("busy"));
            }
            fs::write(&lock, stamp.as_bytes()).map_err(ioe)?;
        }
        // (A folder we cannot write in: this process's lock only.)
        Err(_) => on_disk = false,
    }
    if let Ok(mut g) = locks().lock() {
        g.insert(lock.clone());
    }
    Ok(Lock { path: Some(lock), on_disk })
}

/* ---------- the plan: each unit's output, conflicts settled ---------- */

/// One unit as the plan keeps it (the tail file's JSON: inplace.cjs's field names).
#[derive(Clone, Debug, Default)]
pub struct PUnit {
    pub i: usize,
    pub name: String,
    pub start: u64,
    pub data_start: u64,
    pub data_end: u64,
    pub end: u64,
    pub method: u16,
    pub crc: Option<u32>,
    pub usize: u64,
    pub csize: u64,
    pub dir: bool,
    pub link: Option<String>,
    pub encrypted: bool,
    pub dd: bool,
    pub time: u16,
    pub kind: String,
    pub out: String,
    pub bad: bool,
    pub head: Vec<u8>,
    pub trail: Vec<u8>,
    pub cd: Option<Vec<u8>>,
}
impl PUnit {
    fn to_j(&self) -> J {
        let mut v = vec![("i", n(self.i as f64)), ("name", s(&self.name)), ("start", n(self.start as f64)), ("dataStart", n(self.data_start as f64)), ("dataEnd", n(self.data_end as f64)), ("end", n(self.end as f64)), ("method", n(self.method))];
        if let Some(c) = self.crc {
            v.push(("crc", n(c)));
        }
        v.extend([
            ("usize", n(self.usize as f64)),
            ("csize", n(self.csize as f64)),
            ("dir", J::Bool(self.dir)),
            ("link", self.link.as_ref().map(|l| s(l)).unwrap_or(J::Null)),
            ("encrypted", J::Bool(self.encrypted)),
            ("dd", J::Bool(self.dd)),
            ("time", n(self.time)),
            ("kind", s(&self.kind)),
            ("out", s(&self.out)),
        ]);
        if self.bad {
            v.push(("bad", J::Bool(true)));
        }
        v.push(("head", s(&b64(&self.head))));
        v.push(("trail", s(&b64(&self.trail))));
        if let Some(c) = &self.cd {
            v.push(("cd", s(&b64(c))));
        }
        obj(v)
    }
    fn from_j(o: &J) -> PUnit {
        PUnit {
            i: gu(o, "i") as usize,
            name: gs(o, "name"),
            start: gu(o, "start"),
            data_start: gu(o, "dataStart"),
            data_end: gu(o, "dataEnd"),
            end: gu(o, "end"),
            method: gu(o, "method") as u16,
            crc: gn(o, "crc").map(|x| x as u32),
            usize: gu(o, "usize"),
            csize: gu(o, "csize"),
            dir: gb(o, "dir"),
            link: o.get("link").and_then(|x| x.as_str()).map(|x| x.to_string()),
            encrypted: gb(o, "encrypted"),
            dd: gb(o, "dd"),
            time: gu(o, "time") as u16,
            kind: gs(o, "kind"),
            out: gs(o, "out"),
            bad: gb(o, "bad"),
            head: unb64(&gs(o, "head")).unwrap_or_default(),
            trail: unb64(&gs(o, "trail")).unwrap_or_default(),
            cd: o.get("cd").and_then(|x| x.as_str()).and_then(unb64),
        }
    }
    fn as_unit(&self) -> Unit {
        Unit { name: self.name.clone(), method: self.method, time: self.time, crc: self.crc, csize: self.csize, usize: self.usize, encrypted: self.encrypted, dd: self.dd, data_start: self.data_start, ..Default::default() }
    }
    fn writes(&self) -> bool {
        self.kind == "file" || self.kind == "aside"
    }
}
/// The answer for one item (archsafe.cjs conflictChoice): its own, its kind's, the rest's; None when unanswered.
pub fn conflict_choice(answers: Option<&J>, path: &str, is_dir: bool) -> Option<String> {
    let a = answers?;
    if let Some(per) = a.get("per") {
        if let Some(x) = per.get(path).filter(|x| x.truthy()).and_then(|x| x.as_str()) {
            return Some(x.to_string());
        }
    }
    let kind = a.get(if is_dir { "folders" } else { "files" }).filter(|x| x.truthy()).and_then(|x| x.as_str());
    kind.or_else(|| a.get("default").filter(|x| x.truthy()).and_then(|x| x.as_str())).map(|x| x.to_string())
}
/// «name (2).ext» from 2 on, the first `taken` does not hold.
pub fn keep_both_name(name: &str, taken: &dyn Fn(&str) -> bool) -> String {
    let (base, ext) = match name.rfind('.') {
        Some(d) if d > 0 => (&name[..d], &name[d..]),
        _ => (name, ""),
    };
    let mut i = 2;
    loop {
        let c = format!("{} ({}){}", base, i, ext);
        if !taken(&c) {
            return c;
        }
        i += 1;
    }
}
pub struct Plan {
    pub units: Vec<PUnit>,
    pub moves: Vec<(String, String)>,
    pub aside: String,
}
/// Each unit's output (inplace.cjs planOuts): refused names stop the job; a file already there gets the answer given
/// for it (replace: the old one moved aside; skip; keep both: «name (2)»), else the job stops «conflictsUnanswered».
pub fn plan_outs(scan: &Scan, dest: &Path, platform: &str, answers: Option<&J>, in_place: bool, job_id: &str, skip: &[String]) -> R<Plan> {
    let p = S::platform(platform).ok_or_else(|| fail(format!("platform {}", platform)))?;
    let mut taken: HashSet<String> = HashSet::new();
    let aside = format!("{}-{}", S::ASIDE_DIR, job_id);
    let mut moves = Vec::new();
    let mut unanswered = Vec::new();
    let mut units = Vec::new();
    for (i, u) in scan.units.iter().enumerate() {
        let r = S::path_rule(&u.name, p, 0);
        let mut base = PUnit {
            i,
            name: u.name.clone(),
            start: u.start,
            data_start: u.data_start,
            data_end: u.data_end,
            end: u.end,
            method: u.method,
            crc: u.crc,
            usize: u.usize,
            csize: u.csize,
            dir: u.dir,
            link: u.link.map(|x| x.to_string()),
            encrypted: u.encrypted,
            dd: u.dd,
            time: u.time,
            ..Default::default()
        };
        if r.action == "refuse" {
            return Err(fail(format!("unsafePath {}", u.name)));
        }
        let set = |b: &mut PUnit, kind: &str, out: String| {
            b.kind = kind.to_string();
            b.out = out;
        };
        if u.dir {
            set(&mut base, "dir", r.out);
        } else if u.link.is_some() {
            set(&mut base, "link", r.out);
        } else if u.bad && !in_place {
            // (A damaged header — or a device, a FIFO, a sparse file: left out of a normal extraction, reported.)
            set(&mut base, "skip", r.out);
            base.bad = true;
        } else if skip.contains(&u.name) {
            if in_place {
                set(&mut base, "aside", format!("{}/damaged/{}", aside, r.out));
            } else {
                set(&mut base, "skip", r.out);
            }
        } else {
            let mut out = r.out.clone();
            let there = exists(&dest.join(&out)) || taken.contains(&S::fold_key(&out, p));
            let mut done = false;
            if there {
                match conflict_choice(answers, &u.name, false).as_deref() {
                    None => {
                        unanswered.push(u.name.clone());
                        set(&mut base, "file", out.clone());
                        done = true;
                    }
                    Some("replace") => {
                        if exists(&dest.join(&out)) {
                            moves.push((out.clone(), format!("{}/replaced/{}", aside, out)));
                        }
                    }
                    Some("skip") => {
                        if in_place {
                            set(&mut base, "aside", format!("{}/skipped/{}", aside, out));
                        } else {
                            set(&mut base, "skip", out.clone());
                        }
                        done = true;
                    }
                    Some(_) => {
                        let (dir, nm) = split_out(&out);
                        let dir = dir.to_string();
                        let pick = keep_both_name(nm, &|c: &str| {
                            let q = join_out(&dir, c);
                            exists(&dest.join(&q)) || taken.contains(&S::fold_key(&q, p))
                        });
                        out = join_out(&dir, &pick);
                    }
                }
            }
            if !done {
                taken.insert(S::fold_key(&out, p));
                set(&mut base, "file", out);
            }
        }
        units.push(base);
    }
    if !unanswered.is_empty() {
        let mut f = fail("conflictsUnanswered");
        f.names = unanswered;
        return Err(f);
    }
    Ok(Plan { units, moves, aside })
}

/* ---------- the journal and the saved tail ---------- */

/// A job's journal (inplace.cjs's `j`).
#[derive(Clone, Debug, Default)]
pub struct Journal {
    pub registry: Option<String>,
    pub id: String,
    pub mode: String,
    pub format: String,
    pub archive: String,
    pub dest: String,
    pub tail: String,
    pub tail_len: u64,
    pub tail_crc: u32,
    pub committed: u64,
    pub prev_committed: u64,
    pub next: usize,
    pub outs: BTreeMap<usize, String>,
    pub raws: BTreeMap<usize, u32>,
    pub aside_dir: String,
    pub moves: Vec<(String, String)>,
    pub moved: usize,
    pub state: String,
    pub platform: String,
    pub created: f64,
    pub password: bool,
    pub why: Option<String>,
    pub finished: Option<f64>,
    pub damaged: Option<Vec<String>>,
    pub restore_from: Option<usize>,
    pub restored: Option<usize>,
    pub upto: Option<usize>,
    /// Where a restore rebuilds the archive (a finished job's: its path if free, else a free name beside it).
    pub restore_at: Option<String>,
    /// Bytes a restore is writing past `committed` (announced before the write).
    pub pending: Option<u64>,
}
impl Journal {
    pub fn to_j(&self) -> J {
        let mut v = vec![
            ("registry", self.registry.as_ref().map(|r| s(r)).unwrap_or(J::Null)),
            ("id", s(&self.id)),
            ("mode", s(&self.mode)),
            ("format", s(&self.format)),
            ("archive", s(&self.archive)),
            ("dest", s(&self.dest)),
            ("tail", s(&self.tail)),
            ("tailLen", n(self.tail_len as f64)),
            ("tailCrc", n(self.tail_crc)),
            ("committed", n(self.committed as f64)),
            ("prevCommitted", n(self.prev_committed as f64)),
            ("next", n(self.next as f64)),
            ("outs", J::Obj(self.outs.iter().map(|(k, x)| (k.to_string(), s(x))).collect())),
            ("raws", J::Obj(self.raws.iter().map(|(k, x)| (k.to_string(), n(*x))).collect())),
            ("aside", obj(vec![("dir", s(&self.aside_dir)), ("moves", J::Arr(self.moves.iter().map(|(f, t)| obj(vec![("from", s(f)), ("to", s(t))])).collect())), ("moved", n(self.moved as f64))])),
            ("state", s(&self.state)),
            ("platform", s(&self.platform)),
            ("created", n(self.created)),
            ("password", J::Bool(self.password)),
        ];
        if let Some(w) = &self.why {
            v.push(("why", s(w)));
        }
        if let Some(x) = self.finished {
            v.push(("finished", n(x)));
        }
        if let Some(d) = &self.damaged {
            v.push(("damaged", strs(d)));
        }
        if let Some(x) = self.restore_from {
            v.push(("restoreFrom", n(x as f64)));
        }
        if let Some(x) = self.restored {
            v.push(("restored", n(x as f64)));
        }
        if let Some(x) = self.upto {
            v.push(("upto", n(x as f64)));
        }
        if let Some(x) = &self.restore_at {
            v.push(("restoreAt", s(x)));
        }
        if let Some(x) = self.pending {
            v.push(("pending", n(x as f64)));
        }
        obj(v)
    }
    pub fn from_j(o: &J) -> Journal {
        let map_s = |k: &str| -> BTreeMap<usize, String> {
            match o.get(k) {
                Some(J::Obj(m)) => m.iter().filter_map(|(a, b)| Some((a.parse().ok()?, b.as_str()?.to_string()))).collect(),
                _ => BTreeMap::new(),
            }
        };
        let raws = match o.get("raws") {
            Some(J::Obj(m)) => m.iter().filter_map(|(a, b)| Some((a.parse().ok()?, if let J::Num(x, _) = b { *x as u32 } else { return None }))).collect(),
            _ => BTreeMap::new(),
        };
        let aside = o.get("aside").cloned().unwrap_or(J::Null);
        let moves = aside.get("moves").and_then(|x| x.as_arr()).map(|a| a.iter().map(|m| (gs(m, "from"), gs(m, "to"))).collect()).unwrap_or_default();
        let opt_u = |k: &str| gn(o, k).map(|x| x as usize);
        Journal {
            registry: o.get("registry").and_then(|x| x.as_str()).map(|x| x.to_string()),
            id: gs(o, "id"),
            mode: gs(o, "mode"),
            format: gs(o, "format"),
            archive: gs(o, "archive"),
            dest: gs(o, "dest"),
            tail: gs(o, "tail"),
            tail_len: gu(o, "tailLen"),
            tail_crc: gu(o, "tailCrc") as u32,
            committed: gu(o, "committed"),
            prev_committed: gu(o, "prevCommitted"),
            next: gu(o, "next") as usize,
            outs: map_s("outs"),
            raws,
            aside_dir: gs(&aside, "dir"),
            moves,
            moved: gu(&aside, "moved") as usize,
            state: gs(o, "state"),
            platform: gs(o, "platform"),
            created: gn(o, "created").unwrap_or(0.0),
            password: gb(o, "password"),
            why: o.get("why").and_then(|x| x.as_str()).map(|x| x.to_string()),
            finished: gn(o, "finished"),
            damaged: o.get("damaged").map(|_| gstrs(o, "damaged")),
            restore_from: opt_u("restoreFrom"),
            restored: opt_u("restored"),
            upto: opt_u("upto"),
            restore_at: o.get("restoreAt").and_then(|x| x.as_str()).map(|x| x.to_string()),
            pending: gn(o, "pending").map(|x| x as u64),
        }
    }
    /// The archive a restore writes: `restore_at` when set, else the archive's own path.
    pub fn target(&self) -> &str {
        self.restore_at.as_deref().unwrap_or(&self.archive)
    }
    fn dest_p(&self) -> PathBuf {
        PathBuf::from(&self.dest)
    }
    fn out_of(&self, u: &PUnit) -> PathBuf {
        self.dest_p().join(self.outs.get(&u.i).unwrap_or(&u.out))
    }
    fn part_of(&self, u: &PUnit) -> PathBuf {
        let t = self.dest_p().join(&u.out);
        t.parent().map(|d| d.to_path_buf()).unwrap_or_default().join(format!(".kt{}-{}{}", self.id, u.i, S::TEMP_SUFFIX))
    }
}
/// The journal as written (archsafe.cjs journalText): its JSON with kt and version, a newline, its CRC-32 in hex.
pub fn journal_text(body: &J) -> String {
    let mut v = match body {
        J::Obj(v) => v.clone(),
        _ => vec![],
    };
    v.retain(|(k, _)| k != "kt" && k != "version");
    v.push(("kt".into(), s("extract")));
    v.push(("version".into(), n(S::JOURNAL_VERSION as f64)));
    let j = J::Obj(v).to_json();
    format!("{}\n{:08x}\n", j, crc32(j.as_bytes(), 0))
}
/// A journal read back → Ok(body) or Err((why, body)): why is «corrupt», «future» or «v1».
pub fn journal_read(text: &str) -> Result<J, (&'static str, Option<J>)> {
    let line = text.split('\n').next().unwrap_or("");
    let body = vidjson::parse(line).ok().filter(|b| matches!(b, J::Obj(_)));
    match S::journal_read(text) {
        "ok" => body.ok_or(("corrupt", None)),
        "v1" if body.as_ref().map(|b| gn(b, "version") == Some(1.0)).unwrap_or(false) => Err(("v1", body)),
        "future" => Err(("future", body)),
        _ => Err(("corrupt", None)),
    }
}
fn save_journal(p: &Path, j: &Journal, io: &dyn Io) -> R<()> {
    write_atomic(p, journal_text(&j.to_j()).as_bytes())?;
    io.crash("journal")
}
/// The tail file: «KTTAIL2», the plan as JSON, then the archive's own tail bytes.
pub fn tail_buffer(plan: &J, raw: &[u8]) -> Vec<u8> {
    let j = plan.to_json();
    let mut o = format!("KTTAIL2\n{}\n", j.len()).into_bytes();
    o.extend_from_slice(j.as_bytes());
    o.extend_from_slice(raw);
    o
}
pub fn read_tail(buf: &[u8]) -> R<(J, Vec<u8>)> {
    let a = buf.iter().position(|&x| x == b'\n').ok_or_else(|| fail("tailCorrupt"))?;
    let b = a + 1 + buf[a + 1..].iter().position(|&x| x == b'\n').ok_or_else(|| fail("tailCorrupt"))?;
    if &buf[..a] != b"KTTAIL2" {
        return Err(fail("tailCorrupt"));
    }
    let len: usize = std::str::from_utf8(&buf[a + 1..b]).ok().and_then(|x| x.parse().ok()).ok_or_else(|| fail("tailCorrupt"))?;
    if b + 1 + len > buf.len() {
        return Err(fail("tailCorrupt"));
    }
    let plan = vidjson::parse(&String::from_utf8_lossy(&buf[b + 1..b + 1 + len])).map_err(|_| fail("tailCorrupt"))?;
    Ok((plan, buf[b + 1 + len..].to_vec()))
}
pub struct Job {
    pub j: Journal,
    pub format: String,
    pub units: Vec<PUnit>,
    pub raw: Vec<u8>,
}
/// A job's journal read and checked against its archive and tail → the job, or an error whose message says why it is
/// never replayed (journalMissing, journalCorrupt, journalFuture, journalV1, tailMissing, tailCorrupt, archiveGone,
/// archiveChanged).
pub fn open_job(journal: &Path) -> R<Job> {
    let bytes = fs::read(journal).map_err(|_| fail("journalMissing"))?;
    let text = String::from_utf8_lossy(&bytes);
    let body = journal_read(&text).map_err(|(why, body)| {
        let mut f = fail(match why {
            "future" => "journalFuture",
            "v1" => "journalV1",
            _ => "journalCorrupt",
        });
        f.body = body;
        f
    })?;
    let j = Journal::from_j(&body);
    let tail = fs::read(&j.tail).map_err(|_| fail("tailMissing"))?;
    if tail.len() as u64 != j.tail_len || crc32(&tail, 0) != j.tail_crc {
        return Err(fail("tailCorrupt"));
    }
    let (plan, raw) = read_tail(&tail)?;
    let units: Vec<PUnit> = plan.get("units").and_then(|x| x.as_arr()).map(|a| a.iter().map(PUnit::from_j).collect()).unwrap_or_default();
    if j.mode == "inplace" && j.state != "done" {
        // What is about to be cut or extended must be this job's: its size what the journal says (a restore: its last
        // commit, plus at most the write it announced), and the units' own header bytes where they should be.
        let target = j.target().to_string();
        let restoring = j.state == "restoring";
        let unmade = restoring && j.restore_at.is_some() && j.committed == 0 && j.restored.unwrap_or(0) == 0;
        let size = match fs::metadata(&target) {
            Ok(m) => Some(m.len()),
            Err(_) if unmade => None,
            Err(_) => return Err(fail("archiveGone")),
        };
        if let Some(size) = size {
            let fits = if restoring { size >= j.committed && size <= j.committed + j.pending.unwrap_or(0) } else { size == j.committed || size == j.prev_committed };
            if !fits {
                return Err(fail("archiveChanged"));
            }
            let mut f = File::open(&target).map_err(ioe)?;
            let mut check: Vec<usize> = Vec::new();
            if j.restore_at.is_none() {
                let left = units.len().saturating_sub(j.next);
                if left > 0 {
                    check.push(0);
                    check.push(left - 1);
                }
            }
            if restoring {
                let order = order_of(&j, units.len());
                let (from, restored) = (j.restore_from.unwrap_or(0).min(units.len()), j.restored.unwrap_or(0));
                if restored > 0 && restored <= from {
                    check.push(order[from - 1]);
                    check.push(order[from - restored]);
                }
            }
            check.dedup();
            for k in check {
                let u = &units[k];
                if u.start + u.head.len() as u64 > size.max(j.committed) {
                    return Err(fail("archiveChanged"));
                }
                if read_all(&mut f, u.start, u.head.len()).ok().as_deref() != Some(&u.head[..]) {
                    return Err(fail("archiveChanged"));
                }
            }
        }
    }
    let format = gs(&plan, "format");
    Ok(Job { j, format, units, raw })
}

/* ---------- writing one unit ---------- */

/// No output is written through a link: every folder from the destination down to the unit's own must be a real folder.
fn through_link(dest: &Path, out: &str) -> bool {
    let mut p = dest.to_path_buf();
    let parts: Vec<&str> = out.split('/').collect();
    for c in &parts[..parts.len().saturating_sub(1)] {
        p.push(c);
        if fs::symlink_metadata(&p).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            return true;
        }
    }
    false
}
struct Wctx<'a> {
    env: &'a Env<'a>,
    stop: &'a dyn Fn() -> bool,
    log: PathBuf,
    password: String,
    format: String,
    appeared: Vec<String>,
    tick: &'a mut dyn FnMut(u64, &str),
}
/// Puts the part file at `dest/out` without replacing anything there: a hard link (refused when the name is taken),
/// then the part removed; where links cannot be made, a rename after a check.
fn place(part: &Path, target: &Path) -> io::Result<()> {
    match fs::hard_link(part, target) {
        Ok(()) => fs::remove_file(part),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(e),
        Err(_) => {
            if exists(target) {
                return Err(io::Error::from(io::ErrorKind::AlreadyExists));
            }
            fs::rename(part, target)
        }
    }
}
fn write_unit(f: &mut File, u: &PUnit, j: &Journal, w: &mut Wctx) -> R<(String, u32, u32)> {
    let dest = j.dest_p();
    let target = dest.join(&u.out);
    if through_link(&dest, &u.out) {
        return Err(fail(format!("throughLink {}", u.name)));
    }
    if let Some(d) = target.parent() {
        fs::create_dir_all(d).map_err(ioe)?;
    }
    if !OWN_METHODS.contains(&u.method) {
        return Err(fail(format!("unsupportedMethod {} {}", u.method, u.name)));
    }
    let part = j.part_of(u);
    let mut h = OpenOptions::new().write(true).create_new(true).open(&part).map_err(ioe)?;
    let io = w.env.io;
    let name = u.name.clone();
    let r = {
        let tick = &mut w.tick;
        let mut t = |k: u64| tick(k, &name);
        let mut bw = io::BufWriter::new(&mut h);
        let r = decode(f, &u.as_unit(), &w.password, w.env.codec, io, Some(&mut bw), &mut t, w.stop);
        r.and_then(|x| bw.flush().map(|_| x))
    };
    let (crc, raw) = match r {
        Ok(x) => x,
        Err(e) => {
            drop(h);
            let sz = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
            let _ = fs::remove_file(&part);
            io.release(sz);
            return Err(ioe(e));
        }
    };
    // (The part flushed through the handle that wrote it before it is put in place; a failure fails the unit.)
    if let Err(e) = h.sync_all() {
        drop(h);
        let _ = fs::remove_file(&part);
        return Err(fail(format!("syncFailed {} {}", u.name, e)));
    }
    drop(h);
    if w.format == "zip" && Some(crc) != u.crc {
        let sz = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        let _ = fs::remove_file(&part);
        io.release(sz);
        return Err(fail(format!("crcMismatch {}", u.name)));
    }
    // A file that appeared since the pre-flight is never overwritten: ours takes the next free «name (n)».
    let mut out = u.out.clone();
    let mut first = true;
    loop {
        let at = dest.join(&out);
        if !exists(&at) {
            match place(&part, &at) {
                Ok(()) => break,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => {
                    let _ = fs::remove_file(&part);
                    return Err(ioe(e));
                }
            }
        }
        let (dir, nm) = split_out(&u.out);
        let dir = dir.to_string();
        let d2 = dest.clone();
        let pick = keep_both_name(nm, &|c: &str| exists(&d2.join(join_out(&dir, c))));
        out = join_out(&dir, &pick);
        if first {
            w.appeared.push(u.name.clone());
            first = false;
        }
    }
    // Recorded as this job's own (the unit, the name it got, its CRC) — the log a stopped job's leftovers are cleaned by,
    // so nothing the job did not write is ever removed —, then flushed where it is.
    let placed = dest.join(&out);
    let logged = (|| -> io::Result<()> {
        let mut l = OpenOptions::new().create(true).append(true).open(&w.log)?;
        l.write_all(format!("{}\t{}\t{}\n", u.i, out, crc).as_bytes())?;
        l.sync_all()
    })();
    if let Err(e) = logged.and_then(|_| io.sync(&placed, false)) {
        let _ = fs::remove_file(&placed);
        return Err(fail(format!("syncFailed {} {}", u.name, e)));
    }
    Ok((out, crc, raw))
}
/// The unit log beside a journal: «unit<TAB>name<TAB>crc» for every output placed since the last commit.
pub fn log_of(jpath: &Path) -> PathBuf {
    with_suffix(jpath, ".log")
}
fn read_log(jpath: &Path) -> Vec<(usize, String, u32)> {
    let t = fs::read(log_of(jpath)).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    t.lines()
        .filter_map(|l| {
            let mut f = l.split('\t');
            Some((f.next()?.parse().ok()?, f.next()?.to_string(), f.next()?.parse().ok()?))
        })
        .collect()
}

/* ---------- running a job ---------- */

/// What an extraction takes (archive.cjs's options).
#[derive(Clone, Debug, Default)]
pub struct Opts {
    pub in_place: bool,
    pub answers: Option<J>,
    pub password: Option<String>,
    pub verify_first: bool,
    pub keep_free: u64,
    pub platform: Option<String>,
    pub skip: Vec<String>,
    pub only: Option<Vec<String>>,
    pub registry: Option<PathBuf>,
}
fn order_of(j: &Journal, n_units: usize) -> Vec<usize> {
    if j.mode == "inplace" {
        (0..n_units).rev().collect()
    } else {
        (0..n_units).collect()
    }
}
/// Extract `file` into `dest`. Refused before any change when the pre-flight says so → { files, dest, job, appeared,
/// damaged, undo }.
pub fn extract(file: &Path, dest: &Path, o: &Opts, env: &Env, pr: &Pr) -> R<J> {
    let _lock = take_lock(file, env.io)?;
    if exists(&journal_of(file)) {
        return Err(fail("journalExists"));
    }
    let platform = o.platform.clone().unwrap_or_else(|| host_platform().to_string());
    let fo = FactOpts { password: o.password.clone(), verify: o.in_place && o.verify_first, platform: Some(platform.clone()), external: vec![] };
    let (mut f, scan) = facts(file, dest, &fo, env, pr)?;
    f.busy = false; // (this job holds the lock)
    if !o.skip.is_empty() {
        f.damaged.retain(|x| !o.skip.contains(x));
    }
    let rep = preflight(&f, o.keep_free);
    let mode = rep.get(if o.in_place { "inPlace" } else { "normal" }).cloned().unwrap_or(J::Null);
    if !gb(&mode, "ok") {
        let why = gstrs(&mode, "why");
        let probs = rep.get("problems").and_then(|x| x.as_arr()).cloned().unwrap_or_default();
        let first = probs.iter().find(|x| why.contains(&gs(x, "kind")));
        let (kind, name) = match first {
            Some(x) => (gs(x, "kind"), gstrs(x, "names").first().cloned()),
            None => (why.first().cloned().unwrap_or_default(), None),
        };
        let mut e = fail(format!("refused {}{}", kind, name.map(|x| format!(" {}", x)).unwrap_or_default()));
        e.report = Some(rep);
        e.nothing_changed = true;
        return Err(e);
    }
    let id = new_id();
    let mut plan = plan_outs(&scan, dest, &platform, o.answers.as_ref(), o.in_place, &id, &o.skip)?;
    if let Some(only) = &o.only {
        for u in plan.units.iter_mut() {
            if !only.iter().any(|w| u.name == *w || (w.ends_with('/') && u.name.starts_with(w.as_str()))) {
                u.kind = "skip".into();
            }
        }
    }
    fs::create_dir_all(dest).map_err(ioe)?;
    // The plan and the archive's own tail saved (CRC'd) before the first change; then the journal; then the aside moves.
    let raw;
    {
        let mut fd = File::open(file).map_err(ioe)?;
        raw = read_all(&mut fd, scan.tail_start, (scan.size - scan.tail_start) as usize)?;
        for (k, u) in plan.units.iter_mut().enumerate() {
            u.cd = scan.units[k].cd.clone();
            // (A unit left out for its bad layout is never put back by this job: no bytes of it kept.)
            if scan.units[k].bad {
                continue;
            }
            let (hl, tl) = match (u.data_start.checked_sub(u.start), u.end.checked_sub(u.data_end)) {
                (Some(a), Some(b)) => (a, b),
                _ => return Err(fail(format!("badLayout {}", u.name))),
            };
            u.head = read_all(&mut fd, u.start, hl as usize)?;
            u.trail = read_all(&mut fd, u.data_end, tl as usize)?;
        }
    }
    let dest_abs = abs(dest);
    let plan_j = obj(vec![
        ("format", s(scan.format)),
        ("size", n(scan.size as f64)),
        ("tailStart", n(scan.tail_start as f64)),
        ("idCrc", n(scan.id_crc)),
        ("dest", s(&lossy(&dest_abs))),
        ("units", J::Arr(plan.units.iter().map(|u| u.to_j()).collect())),
    ]);
    let registry = o.registry.clone();
    let (jpath, tpath) = if o.in_place {
        (journal_of(file), tail_of(file))
    } else {
        let r = registry.clone().ok_or_else(|| fail("noRegistry"))?;
        fs::create_dir_all(&r).map_err(ioe)?;
        (r.join(format!("{}{}", id, JOURNAL_SUFFIX)), r.join(format!("{}{}", id, TAIL_SUFFIX)))
    };
    let tb = tail_buffer(&plan_j, if o.in_place { &raw } else { &[] });
    let wrote = env.io.charge(tb.len() as u64).and_then(|_| write_atomic(&tpath, &tb));
    if let Err(e) = wrote {
        let _ = fs::remove_file(&tpath);
        let _ = fs::remove_file(with_suffix(&tpath, ".tmp"));
        let mut e = if e.msg == "noSpace" { fail("noSpace") } else { e };
        e.nothing_changed = true;
        return Err(e);
    }
    env.io.crash("tail")?;
    if let Some(r) = &registry {
        register(r, &jpath, &id)?;
    }
    let mut j = Journal {
        registry: registry.as_ref().map(|r| lossy(r)),
        id: id.clone(),
        mode: if o.in_place { "inplace" } else { "normal" }.into(),
        format: scan.format.into(),
        archive: lossy(&abs(file)),
        dest: lossy(&dest_abs),
        tail: lossy(&tpath),
        tail_len: tb.len() as u64,
        tail_crc: crc32(&tb, 0),
        committed: scan.size,
        prev_committed: scan.size,
        next: 0,
        aside_dir: plan.aside.clone(),
        moves: plan.moves.clone(),
        moved: 0,
        state: "running".into(),
        platform,
        created: now_ms(),
        password: o.password.is_some(),
        ..Default::default()
    };
    save_journal(&jpath, &j, env.io)?;
    let job = Job { j: j.clone(), format: scan.format.to_string(), units: plan.units, raw };
    j = job.j.clone();
    run(&jpath, &mut j, &job, env, pr, o.password.as_deref().unwrap_or(""), o.keep_free)
}
/// Moves the old items aside (journalled count; a move already done is seen as done).
fn settle_aside(jpath: &Path, j: &mut Journal, io: &dyn Io) -> R<()> {
    for k in j.moved..j.moves.len() {
        let (from, to) = (j.dest_p().join(&j.moves[k].0), j.dest_p().join(&j.moves[k].1));
        if exists(&from) && !exists(&to) {
            if let Some(d) = to.parent() {
                fs::create_dir_all(d).map_err(ioe)?;
            }
            fs::rename(&from, &to).map_err(ioe)?;
        }
        j.moved = k + 1;
        save_journal(jpath, j, io)?;
    }
    Ok(())
}
/// Outputs of units not committed yet (a crash or a stop mid-batch): removed so the run goes on exactly — only what
/// this job wrote: its part files (named for this job alone) and the outputs its unit log records (the name each got,
/// «name (2)» too), each only while it is still as written (same size and CRC). Nothing else at those names is touched.
fn clear_uncommitted(jpath: &Path, j: &Journal, job: &Job, io: &dyn Io) {
    let order = order_of(j, job.units.len());
    let open: HashSet<usize> = order[j.next.min(order.len())..].iter().copied().collect();
    for &i in open.iter() {
        let u = &job.units[i];
        if !u.writes() {
            continue;
        }
        let part = j.part_of(u);
        if let Ok(m) = fs::symlink_metadata(&part) {
            let _ = fs::remove_file(&part);
            io.release(m.len());
        }
    }
    for (i, out, crc) in read_log(jpath) {
        if !open.contains(&i) || i >= job.units.len() {
            continue;
        }
        let t = j.dest_p().join(&out);
        if let Ok(m) = fs::symlink_metadata(&t) {
            if m.is_file() && m.len() == job.units[i].usize && file_crc(&t) == Some(crc) {
                let _ = fs::remove_file(&t);
                io.release(m.len());
            }
        }
    }
    let _ = fs::remove_file(log_of(jpath));
}
/// The CRC a unit's file must have: the archive's (ZIP), or the one taken while it was written (tar keeps none).
fn crc_of(j: &Journal, u: &PUnit) -> Option<u32> {
    u.crc.or_else(|| j.raws.get(&u.i).copied())
}
fn run(jpath: &Path, j: &mut Journal, job: &Job, env: &Env, pr: &Pr, password: &str, keep_free: u64) -> R<J> {
    let io = env.io;
    let order = order_of(j, job.units.len());
    let mut damaged: Vec<String> = Vec::new();
    let mut files = 0u64;
    settle_aside(jpath, j, io)?;
    io.crash("aside")?;
    let in_place = j.mode == "inplace";
    let mut fd = OpenOptions::new().read(true).write(in_place).open(&j.archive).map_err(ioe)?;
    let size_now = fd.metadata().map_err(ioe)?.len();
    if in_place && size_now > j.committed {
        fd.set_len(j.committed).map_err(ioe)?;
        let _ = fd.sync_all();
        io.release(size_now - j.committed);
    }
    let total: u64 = job.units.iter().filter(|u| u.writes()).map(|u| u.usize).sum();
    let done = std::cell::Cell::new(order[..j.next.min(order.len())].iter().map(|&x| &job.units[x]).filter(|u| u.writes()).map(|u| u.usize).sum::<u64>());
    let mut tick = |k: u64, cur: &str| -> () {
        done.set(done.get() + k);
        (pr.on)(done.get(), total, cur);
    };
    let mut w = Wctx { env, stop: pr.stopped, log: log_of(jpath), password: password.to_string(), format: job.format.clone(), appeared: vec![], tick: &mut tick };
    let mut k = j.next;
    while k < order.len() {
        if (pr.stopped)() {
            j.state = "paused".into();
            save_journal(jpath, j, io)?;
            let mut e = fail("stopped");
            e.journal = Some(lossy(jpath));
            return Err(e);
        }
        let free = io.free_space(&j.dest_p()) - keep_free as i64;
        let cap = if free < 0 { u64::MAX } else { free as u64 }.min(env.batch_bytes);
        let (mut used, mut end) = (0u64, k);
        while end < order.len() && end - k < env.batch_count && (end == k || used + job.units[order[end]].usize <= cap) {
            used += job.units[order[end]].usize;
            end += 1;
        }
        if free >= 0 && job.units[order[k]].usize > free as u64 {
            j.state = "paused".into();
            j.why = Some("noSpace".into());
            save_journal(jpath, j, io)?;
            let mut e = fail("noSpace");
            e.journal = Some(lossy(jpath));
            e.kept = Some(files);
            return Err(e);
        }
        let mut written: Vec<(String, u32)> = Vec::new();
        let batch = (|| -> R<()> {
            for &x in &order[k..end] {
                let u = &job.units[x];
                if u.kind == "dir" {
                    if through_link(&j.dest_p(), &format!("{}/x", u.out)) {
                        return Err(fail(format!("throughLink {}", u.name)));
                    }
                    fs::create_dir_all(j.dest_p().join(&u.out)).map_err(ioe)?;
                    continue;
                }
                if u.kind == "link" || u.kind == "skip" {
                    continue;
                }
                let r = match write_unit(&mut fd, u, j, &mut w) {
                    Ok(r) => r,
                    // (A normal job leaves a damaged file out and goes on; in place stops at the last commit.)
                    Err(e) if !e.crash && j.mode == "normal" && e.msg.starts_with("crcMismatch ") => {
                        damaged.push(u.name.clone());
                        continue;
                    }
                    Err(e) => return Err(e),
                };
                written.push((r.0.clone(), r.1));
                if r.0 != u.out {
                    j.outs.insert(u.i, r.0.clone());
                } else {
                    j.outs.remove(&u.i);
                }
                j.raws.insert(u.i, r.2);
                if u.kind == "file" {
                    files += 1;
                }
                io.crash("unit")?;
            }
            // Commit: each file was flushed as it was placed; now their folders (where the system can) — any failure
            // fails the commit — and, before an archive is cut, each file read back and its CRC compared.
            let mut dirs: Vec<PathBuf> = written.iter().filter_map(|(o, _)| j.dest_p().join(o).parent().map(|d| d.to_path_buf())).collect();
            dirs.sort();
            dirs.dedup();
            for d in dirs {
                io.sync(&d, true).map_err(|e| fail(format!("syncFailed {} {}", d.display(), e)))?;
            }
            if in_place {
                for (o, c) in written.iter() {
                    if file_crc(&j.dest_p().join(o)) != Some(*c) {
                        return Err(fail(format!("readBack {}", o)));
                    }
                }
            }
            Ok(())
        })();
        if let Err(e) = batch {
            if e.crash {
                return Err(e);
            }
            // (This batch's own outputs are not committed: removed — a file that failed its read-back is bad, and a
            // Finish then writes it again under its own name, never «name (2)» beside a bad one.)
            for (o, _) in written.iter() {
                let p = j.dest_p().join(o);
                if let Ok(m) = fs::symlink_metadata(&p) {
                    let _ = fs::remove_file(&p);
                    io.release(m.len());
                }
            }
            for &x in &order[k..end] {
                j.outs.remove(&job.units[x].i);
            }
            j.state = "paused".into();
            j.why = Some(e.msg.split(' ').next().unwrap_or("").to_string());
            clear_uncommitted(jpath, j, job, io);
            save_journal(jpath, j, io)?;
            let mut f = fail(e.msg);
            f.journal = Some(lossy(jpath));
            f.kept = Some(files);
            return Err(f);
        }
        io.crash("synced")?;
        j.next = end;
        j.prev_committed = j.committed;
        if in_place {
            j.committed = job.units[order[end - 1]].start;
        }
        save_journal(jpath, j, io)?;
        let _ = fs::remove_file(log_of(jpath));
        if in_place {
            let before = fd.metadata().map_err(ioe)?.len();
            fd.set_len(j.committed).map_err(ioe)?;
            let _ = fd.sync_all();
            io.release(before.saturating_sub(j.committed));
            io.crash("cut")?;
        }
        k = end;
    }
    (pr.on)(total, total, "");
    let appeared = std::mem::take(&mut w.appeared);
    drop(w);
    drop(fd);
    // Done: an archive extracted in place is gone (its tail kept for Undo until the offer ends); the job stays on the shelf as «done».
    if in_place {
        let _ = fs::remove_file(&j.archive);
    }
    for u in job.units.iter() {
        if u.bad && !damaged.contains(&u.name) {
            damaged.push(u.name.clone());
        }
    }
    j.state = "done".into();
    j.finished = Some(now_ms());
    j.damaged = Some(damaged.clone());
    save_journal(jpath, j, io)?;
    Ok(obj(vec![("files", n(files as f64)), ("dest", s(&j.dest)), ("job", s(&lossy(jpath))), ("appeared", strs(&appeared)), ("damaged", strs(&damaged)), ("undo", J::Bool(true))]))
}

/// A stopped or crashed job taken up again from its journal.
pub fn finish(jpath: &Path, env: &Env, pr: &Pr, password: Option<&str>, keep_free: u64) -> R<J> {
    let job = open_job(jpath)?;
    let mut j = job.j.clone();
    if j.state == "done" {
        return Ok(obj(vec![("files", n(0)), ("dest", s(&j.dest)), ("job", s(&lossy(jpath))), ("appeared", J::Arr(vec![])), ("damaged", strs(&j.damaged.clone().unwrap_or_default())), ("undo", J::Bool(true))]));
    }
    if j.state == "restoring" || j.state == "undoing" {
        return Err(fail("restoreUnfinished"));
    }
    let _lock = take_lock(Path::new(&j.archive), env.io)?;
    clear_uncommitted(jpath, &j, &job, env.io);
    j.state = "running".into();
    j.why = None;
    save_journal(jpath, &j, env.io)?;
    run(jpath, &mut j, &job, env, pr, password.unwrap_or(""), keep_free)
}

/// A unit's data made again from its extracted file: stored as is; deflated only when it squeezes back to the same bytes.
fn rebuild_data(u: &PUnit, buf: &[u8], raw_crc: Option<u32>, codec: &dyn Codec) -> Option<Vec<u8>> {
    if u.method == 0 && !u.encrypted {
        return if buf.len() as u64 == u.csize && Some(crc32(buf, 0)) == u.crc.or(raw_crc) { Some(buf.to_vec()) } else { None };
    }
    if u.method != 8 || u.encrypted {
        return None;
    }
    for level in [6, 9, 1, 5, 4, 3, 2, 7, 8] {
        for mem in [8, 9] {
            if let Some(d) = codec.deflate(buf, level, mem) {
                if d.len() as u64 == u.csize && Some(crc32(&d, 0)) == raw_crc {
                    return Some(d);
                }
            }
        }
    }
    None
}
/// Give up and put the archive back (inplace.cjs restore): every extracted unit appended again in order, then the saved
/// tail — the original archive byte for byte; a unit that cannot be made again exactly stops the appending (the archive
/// is closed there as a smaller whole one; the files from there on stay extracted). Old items moved aside are put back.
/// → { identical, back, keptOut }. A normal job is undone instead (its files removed).
pub fn restore(jpath: &Path, env: &Env) -> R<J> {
    let job = open_job(jpath)?;
    let mut j = job.j.clone();
    let io = env.io;
    let _lock = if j.mode == "inplace" { Some(take_lock(Path::new(&j.archive), io)?) } else { None };
    if j.mode == "normal" {
        return undo_normal(jpath, &mut j, &job, io);
    }
    let units = &job.units;
    if j.state != "restoring" {
        if j.state != "done" {
            clear_uncommitted(jpath, &j, &job, io);
        }
        j.restore_from = Some(if j.state == "done" { units.len() } else { j.next });
        if j.state == "done" {
            // The archive was removed when the job finished: whatever is at its path now is not this job's and is never
            // touched — the archive is made again beside it under a free name, said in the answer (`restoredTo`).
            let a = PathBuf::from(&j.archive);
            let at = if exists(&a) {
                let dir = a.parent().map(|d| d.to_path_buf()).unwrap_or_default();
                let nm = a.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default();
                dir.join(keep_both_name(&nm, &|c: &str| exists(&dir.join(c))))
            } else {
                a
            };
            j.restore_at = Some(lossy(&at));
            j.committed = 0;
        }
        j.state = "restoring".into();
        j.restored = Some(0);
        j.pending = None;
        save_journal(jpath, &j, io)?;
    }
    let target = PathBuf::from(j.target());
    // (Made by this restore alone: exclusively, so a file that took the name meanwhile is never written into.)
    if j.restore_at.is_some() && j.committed == 0 && j.restored == Some(0) && !exists(&target) {
        OpenOptions::new().write(true).create_new(true).open(&target).map_err(|_| fail("archiveChanged"))?;
    }
    let order = order_of(&j, units.len());
    let (from, restored) = (j.restore_from.unwrap_or(0), j.restored.unwrap_or(0));
    // (A restore taken up again: a unit already appended whose file a crash left behind is removed now.)
    for k in from.saturating_sub(restored)..from {
        let u = &units[order[k]];
        if !u.writes() {
            continue;
        }
        let p = j.out_of(u);
        if exists(&p) && file_crc(&p) == crc_of(&j, u) {
            let _ = fs::remove_file(&p);
        }
    }
    let mut back = 0usize;
    let mut stop_at: Option<usize> = None;
    {
        let mut fd = OpenOptions::new().read(true).write(true).open(&target).map_err(ioe)?;
        // (open_job proved what lies past the last commit is this restore's own unfinished write: cut off again.)
        let size = fd.metadata().map_err(ioe)?.len();
        if size > j.committed {
            fd.set_len(j.committed).map_err(ioe)?;
        }
        // Units go back lowest offset first: the reverse of the order they came out.
        let mut k = from as i64 - 1 - j.restored.unwrap_or(0) as i64;
        while k >= 0 {
            let ku = k as usize;
            let u = &units[order[ku]];
            if u.start != j.committed {
                stop_at = Some(ku);
                break;
            }
            let mut data = Vec::new();
            if u.writes() {
                let p = j.out_of(u);
                let buf = match fs::read(&p) {
                    Ok(b) => b,
                    Err(_) => {
                        stop_at = Some(ku);
                        break;
                    }
                };
                data = match rebuild_data(u, &buf, j.raws.get(&u.i).copied(), env.codec) {
                    Some(d) => d,
                    None => {
                        stop_at = Some(ku);
                        break;
                    }
                };
            } else if u.kind == "skip" {
                stop_at = Some(ku);
                break;
            }
            let mut bytes = u.head.clone();
            bytes.extend_from_slice(&data);
            bytes.extend_from_slice(&u.trail);
            io.charge(bytes.len() as u64)?;
            // (The write announced first: a restore killed in it finds exactly so many bytes of its own past the commit.)
            j.pending = Some(bytes.len() as u64);
            save_journal(jpath, &j, io)?;
            fd.seek(SeekFrom::Start(j.committed)).map_err(ioe)?;
            fd.write_all(&bytes).map_err(ioe)?;
            fd.sync_all().map_err(|e| fail(format!("syncFailed {}", e)))?;
            j.committed += bytes.len() as u64;
            j.restored = Some(j.restored.unwrap_or(0) + 1);
            j.pending = None;
            save_journal(jpath, &j, io)?;
            back += 1;
            if u.writes() {
                let p = j.out_of(u);
                let sz = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                let _ = fs::remove_file(&p);
                io.release(sz);
            }
            k -= 1;
        }
        // The end: the saved tail (all units back: identical), else a new directory over what is there (ZIP) or two zero blocks (tar).
        let end: Vec<u8> = if from == 0 {
            vec![]
        } else if stop_at.is_none() {
            job.raw.clone()
        } else if job.format == "tar" {
            vec![0u8; 1024]
        } else {
            let kept: Vec<&PUnit> = units.iter().filter(|u| u.end <= j.committed).collect();
            let mut cd: Vec<u8> = Vec::new();
            for u in kept.iter() {
                cd.extend_from_slice(u.cd.as_deref().unwrap_or(&[]));
            }
            let cd_len = cd.len() as u64;
            cd.extend_from_slice(&zip_end(kept.len() as u64, cd_len, j.committed));
            cd
        };
        if !end.is_empty() {
            j.pending = Some(end.len() as u64);
            save_journal(jpath, &j, io)?;
            fd.seek(SeekFrom::Start(j.committed)).map_err(ioe)?;
            fd.write_all(&end).map_err(ioe)?;
        }
        fd.set_len(j.committed + end.len() as u64).map_err(ioe)?;
        fd.sync_all().map_err(|e| fail(format!("syncFailed {}", e)))?;
        io.charge(end.len() as u64)?;
    }
    io.crash("restored")?;
    let originals = put_back(&j);
    let kept_out: Vec<String> = match stop_at {
        None => vec![],
        Some(sa) => order[..=sa].iter().map(|&i| &units[i]).filter(|u| u.kind == "file").map(|u| u.name.clone()).collect(),
    };
    remove_dirs(&j, units);
    let aside_kept = forget(jpath, &j, false);
    let mut v = vec![("identical", J::Bool(stop_at.is_none())), ("back", n(back as f64)), ("keptOut", strs(&kept_out)), ("originals", strs(&originals))];
    if j.target() != j.archive {
        v.push(("restoredTo", s(j.target())));
    }
    if let Some(a) = aside_kept {
        v.push(("asideKept", s(&a)));
    }
    Ok(obj(v))
}
/// A ZIP's end records for `count` entries whose directory (`cd_len` bytes) starts at `cd_start`: the ZIP64 record and
/// its locator first when a count or an offset does not fit the plain record (65,535 entries, 4 GB).
pub fn zip_end(count: u64, cd_len: u64, cd_start: u64) -> Vec<u8> {
    let z64 = count >= 0xffff || cd_len >= 0xffff_ffff || cd_start >= 0xffff_ffff;
    let mut o = Vec::new();
    if z64 {
        let rec_at = cd_start + cd_len;
        o.extend_from_slice(&0x0606_4b50u32.to_le_bytes());
        o.extend_from_slice(&44u64.to_le_bytes());
        o.extend_from_slice(&45u16.to_le_bytes());
        o.extend_from_slice(&45u16.to_le_bytes());
        o.extend_from_slice(&[0u8; 8]);
        o.extend_from_slice(&count.to_le_bytes());
        o.extend_from_slice(&count.to_le_bytes());
        o.extend_from_slice(&cd_len.to_le_bytes());
        o.extend_from_slice(&cd_start.to_le_bytes());
        o.extend_from_slice(&0x0706_4b50u32.to_le_bytes());
        o.extend_from_slice(&0u32.to_le_bytes());
        o.extend_from_slice(&rec_at.to_le_bytes());
        o.extend_from_slice(&1u32.to_le_bytes());
    }
    o.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    o.extend_from_slice(&[0u8; 4]);
    let c = count.min(0xffff) as u16;
    o.extend_from_slice(&c.to_le_bytes());
    o.extend_from_slice(&c.to_le_bytes());
    o.extend_from_slice(&(cd_len.min(0xffff_ffff) as u32).to_le_bytes());
    o.extend_from_slice(&(cd_start.min(0xffff_ffff) as u32).to_le_bytes());
    o.extend_from_slice(&[0u8; 2]);
    o
}
/// «name (original).ext» — then «name (original 2).ext»… — the first not taken.
fn original_name(name: &str, taken: &dyn Fn(&str) -> bool) -> String {
    let (base, ext) = match name.rfind('.') {
        Some(d) if d > 0 => (&name[..d], &name[d..]),
        _ => (name, ""),
    };
    let mut i = 1;
    loop {
        let c = if i == 1 { format!("{} (original){}", base, ext) } else { format!("{} (original {}){}", base, i, ext) };
        if !taken(&c) {
            return c;
        }
        i += 1;
    }
}
/// The old items moved aside put back where they were; where the name is taken now (the extracted file edited and kept,
/// a unit that stayed out), under «name (original)» beside it — never left behind, never over anything. → the names
/// put back under another name.
fn put_back(j: &Journal) -> Vec<String> {
    let mut other = Vec::new();
    for k in (0..j.moved.min(j.moves.len())).rev() {
        let (from, to) = (j.dest_p().join(&j.moves[k].1), j.dest_p().join(&j.moves[k].0));
        if !exists(&from) {
            continue;
        }
        if let Some(d) = to.parent() {
            let _ = fs::create_dir_all(d);
        }
        let mut at = to.clone();
        if exists(&at) {
            let (dir, nm) = split_out(&j.moves[k].0);
            let dir = dir.to_string();
            let dp = j.dest_p();
            let pick = original_name(nm, &|c: &str| exists(&dp.join(join_out(&dir, c))));
            at = j.dest_p().join(join_out(&dir, &pick));
            other.push(join_out(&dir, &pick));
        }
        // (No-clobber: a hard link where the name must still be free, then the aside copy removed.)
        let _ = place(&from, &at);
    }
    other
}
/// Folders the job made, removed when empty (deepest first).
fn remove_dirs(j: &Journal, units: &[PUnit]) {
    let mut dirs: Vec<String> = Vec::new();
    for u in units {
        let parts: Vec<&str> = u.out.split('/').collect();
        let upto = if u.kind == "dir" { parts.len() } else { parts.len().saturating_sub(1) };
        for i in 1..=upto {
            let d = parts[..i].join("/");
            if !dirs.contains(&d) {
                dirs.push(d);
            }
        }
    }
    dirs.sort_by_key(|d| std::cmp::Reverse(d.len()));
    for d in dirs {
        let _ = fs::remove_dir(j.dest_p().join(d));
    }
}
/// Whether a folder holds anything but empty folders.
fn holds_files(d: &Path) -> bool {
    match fs::read_dir(d) {
        Ok(rd) => rd.flatten().any(|e| match e.file_type() {
            Ok(t) if t.is_dir() => holds_files(&e.path()),
            _ => true,
        }),
        Err(_) => false,
    }
}
/// The job's own records removed (journal, tail, unit log, registry pointer). The aside folder only when nothing is
/// left in it: anything still there (an original that could not go back, an entry set aside in place) is kept and
/// its folder named in the answer → Some(that folder).
///
/// `ended`: the job's Undo offer ended (dismissed, or a finished job tidied at start) — the replaced originals'
/// folder goes then (the user chose «replace»: that is the replace completing); what an in-place job set aside
/// (entries skipped or damaged: the archive is gone, they exist nowhere else) is kept.
fn forget(jpath: &Path, j: &Journal, ended: bool) -> Option<String> {
    let aside = j.dest_p().join(&j.aside_dir);
    if ended && !j.aside_dir.is_empty() {
        let _ = fs::remove_dir_all(aside.join("replaced"));
    }
    let kept = if j.aside_dir.is_empty() || !exists(&aside) {
        None
    } else if holds_files(&aside) {
        Some(lossy(&aside))
    } else {
        let _ = fs::remove_dir_all(&aside);
        None
    };
    let _ = fs::remove_file(&j.tail);
    let _ = fs::remove_file(log_of(jpath));
    let _ = fs::remove_file(jpath);
    if let Some(r) = &j.registry {
        let _ = fs::remove_file(Path::new(r).join(format!("{}.ref", j.id)));
    }
    kept
}
/// A normal job undone: what it wrote removed (only a file still as it wrote it), what it moved aside put back.
fn undo_normal(jpath: &Path, j: &mut Journal, job: &Job, io: &dyn Io) -> R<J> {
    let upto = if j.state == "done" { job.units.len() } else { j.next };
    if j.state != "done" && j.state != "undoing" {
        clear_uncommitted(jpath, j, job, io);
    }
    j.state = "undoing".into();
    if j.upto.is_none() {
        j.upto = Some(upto);
    }
    save_journal(jpath, j, io)?;
    let order = order_of(j, job.units.len());
    let (mut removed, mut changed) = (0u64, Vec::new());
    for &x in &order[..j.upto.unwrap_or(upto).min(order.len())] {
        let u = &job.units[x];
        if u.kind != "file" {
            continue;
        }
        let p = j.out_of(u);
        if !exists(&p) {
            continue;
        }
        if file_crc(&p) == crc_of(j, u) {
            let sz = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            let _ = fs::remove_file(&p);
            io.release(sz);
            removed += 1;
        } else {
            changed.push(u.name.clone());
        }
    }
    let originals = put_back(j);
    remove_dirs(j, &job.units);
    let aside_kept = forget(jpath, j, false);
    let mut v = vec![("identical", J::Bool(true)), ("back", n(0)), ("removed", n(removed as f64)), ("keptOut", strs(&changed)), ("originals", strs(&originals))];
    if let Some(a) = aside_kept {
        v.push(("asideKept", s(&a)));
    }
    Ok(obj(v))
}
/// Undo a finished job (in place: the archive made again whole; normal: its files removed).
pub fn undo(jpath: &Path, env: &Env) -> R<J> {
    restore(jpath, env)
}
/// The Undo offer ended: the saved tail and the journal removed; the aside folder too when nothing is left in it →
/// { asideKept? } (the folder kept because something is still in it).
pub fn dismiss(jpath: &Path) -> R<J> {
    let j = match open_job(jpath) {
        Ok(job) => job.j,
        Err(e) => {
            let t = fs::read(jpath).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
            match journal_read(&t) {
                Ok(b) => Journal::from_j(&b),
                Err(_) => return Err(e),
            }
        }
    };
    if j.state != "done" {
        return Err(fail("notDone"));
    }
    Ok(match forget(jpath, &j, true) {
        Some(a) => obj(vec![("asideKept", s(&a))]),
        None => obj(vec![]),
    })
}
/// A job registered so the shelf finds it.
pub fn register(registry: &Path, jpath: &Path, id: &str) -> R<()> {
    fs::create_dir_all(registry).map_err(ioe)?;
    write_atomic(&registry.join(format!("{}.ref", id)), lossy(jpath).as_bytes())
}
/// The shelf: every job the registry knows. Finished ones whose Undo offer ended (older than `undo_ms`, or every
/// finished one at start) are cleaned; the rest come back with what can be done.
pub fn shelf(registry: &Path, at_start: bool, undo_ms: f64) -> Vec<J> {
    let mut out = Vec::new();
    let mut names: Vec<String> = match fs::read_dir(registry) {
        Ok(rd) => rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|x| x.ends_with(".ref")).collect(),
        Err(_) => return out,
    };
    names.sort();
    for nm in names {
        let rf = registry.join(&nm);
        let jp = fs::read_to_string(&rf).map(|x| x.trim().to_string()).unwrap_or_default();
        if jp.is_empty() || !exists(Path::new(&jp)) {
            let _ = fs::remove_file(&rf);
            continue;
        }
        let jpath = PathBuf::from(&jp);
        match open_job(&jpath) {
            Ok(job) => {
                let j = &job.j;
                let total = job.units.len();
                if j.state == "done" {
                    if at_start || now_ms() - j.finished.unwrap_or(0.0) > undo_ms {
                        let mut j2 = j.clone();
                        j2.registry = Some(lossy(registry));
                        let _ = forget(&jpath, &j2, true);
                        continue;
                    }
                    out.push(obj(vec![("journal", s(&jp)), ("id", s(&j.id)), ("archive", s(&j.archive)), ("dest", s(&j.dest)), ("mode", s(&j.mode)), ("state", s("done")), ("done", n(total as f64)), ("total", n(total as f64)), ("can", J::Arr(vec![s("undo"), s("dismiss")]))]));
                    continue;
                }
                let can: Vec<J> = if j.state == "restoring" || j.state == "undoing" { vec![s("restore"), s("leave")] } else { vec![s("finish"), s("restore"), s("leave")] };
                let mut v = vec![("journal", s(&jp)), ("id", s(&j.id)), ("archive", s(&j.archive)), ("dest", s(&j.dest)), ("mode", s(&j.mode)), ("state", s(&j.state))];
                if let Some(w) = &j.why {
                    v.push(("why", s(w)));
                }
                v.extend([("done", n(j.next as f64)), ("total", n(total as f64)), ("can", J::Arr(can))]);
                out.push(obj(v));
            }
            Err(e) => {
                let body = e.body.clone().unwrap_or(J::Null);
                let or = |a: String, b: String| if a.is_empty() { b } else { a };
                let archive = or(gs(&body, "archive"), jp.strip_suffix(JOURNAL_SUFFIX).unwrap_or(&jp).to_string());
                let dest = or(gs(&body, "dest"), gs(&body, "output"));
                let mode = or(gs(&body, "mode"), "inplace".into());
                let can = if e.msg == "journalV1" { vec![s("restoreV1"), s("leave")] } else { vec![s("leave")] };
                out.push(obj(vec![("journal", s(&jp)), ("id", s(nm.trim_end_matches(".ref"))), ("archive", s(&archive)), ("dest", s(&dest)), ("mode", s(&mode)), ("state", s("blocked")), ("why", s(&e.msg)), ("done", n(0)), ("total", n(0)), ("can", J::Arr(can))]));
            }
        }
    }
    out
}
/// The registry's default undo window (an hour, as inplace.cjs).
pub const UNDO_MS: f64 = 3_600_000.0;
/// Whether a journal beside the archive is this engine's (2), the first design's (1), or neither (0).
pub fn journal_version(file: &Path) -> u8 {
    let t = match fs::read(journal_of(file)) {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(_) => return 0,
    };
    match journal_read(&t) {
        Ok(_) => 2,
        Err(("v1", _)) => 1,
        Err(_) => 0,
    }
}
/// What is still in an archive whose in-place job (journal v2 beside it) is unfinished: the units not taken out yet, as
/// (name, size, packed, folder) — the list a v1 reader cannot give (it would read the saved tail as a directory).
pub fn left_entries(file: &Path) -> R<Vec<(String, u64, u64, bool)>> {
    let job = open_job(&journal_of(file))?;
    let n = job.units.len();
    let left = if job.j.mode == "inplace" && job.j.state != "restoring" { n.saturating_sub(job.j.next) } else { n };
    Ok(job.units[..left].iter().map(|u| (u.name.clone(), u.usize, u.csize, u.dir)).collect())
}
/// Whether every file entry is one this engine decodes itself (archive.cjs: then it, not 7-Zip, extracts).
pub fn own_methods(scan: &Scan) -> bool {
    scan.units.iter().all(|u| u.dir || OWN_METHODS.contains(&u.method))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeMap;

    /// Raw deflate of stored blocks only — valid deflate any reader takes; the same bytes at every level (so a restore
    /// makes a unit again exactly, as zlib does for an archive it made).
    struct Stored;
    fn stored(data: &[u8]) -> Vec<u8> {
        let mut o = Vec::new();
        let mut chunks: Vec<&[u8]> = data.chunks(65535).collect();
        if chunks.is_empty() {
            chunks.push(&[]);
        }
        let last = chunks.len() - 1;
        for (i, c) in chunks.iter().enumerate() {
            let len = c.len() as u16;
            o.push(if i == last { 1 } else { 0 });
            o.extend_from_slice(&len.to_le_bytes());
            o.extend_from_slice(&(!len).to_le_bytes());
            o.extend_from_slice(c);
        }
        o
    }
    impl Codec for Stored {
        fn inflate(&self, src: &mut dyn Read, dst: &mut dyn Write) -> io::Result<u64> {
            let mut n = 0u64;
            loop {
                let mut h = [0u8; 5];
                src.read_exact(&mut h)?;
                if h[0] & 0b110 != 0 {
                    return Err(io::Error::other("not stored"));
                }
                let len = u16::from_le_bytes([h[1], h[2]]) as usize;
                if u16::from_le_bytes([h[3], h[4]]) != !(len as u16) {
                    return Err(io::Error::other("bad block"));
                }
                let mut b = vec![0u8; len];
                src.read_exact(&mut b)?;
                dst.write_all(&b)?;
                n += len as u64;
                if h[0] & 1 == 1 {
                    return Ok(n);
                }
            }
        }
        fn deflate(&self, data: &[u8], _level: u32, _mem: u32) -> Option<Vec<u8>> {
            Some(stored(data))
        }
    }

    /// A fake volume: `fill_at` bytes written before «noSpace» (another program filling the disk), a crash at the n-th
    /// crash point, a hook per point.
    #[derive(Default)]
    struct Fake {
        free: Option<i64>,
        fill_at: Option<u64>,
        crash_at: Option<usize>,
        used: Cell<u64>,
        hits: Cell<usize>,
        points: RefCell<Vec<String>>,
        hook: Option<Box<dyn Fn(&str)>>,
        /// A sync of a path ending so fails; one of a path ending so has its bytes spoiled first (a disk that lies).
        fail_sync: Option<String>,
        spoil_on_sync: Option<String>,
    }
    impl Io for Fake {
        fn free_space(&self, _d: &Path) -> i64 {
            self.free.unwrap_or(1_000_000_000_000)
        }
        fn charge(&self, n: u64) -> Result<(), Fail> {
            if let Some(f) = self.fill_at {
                if self.used.get() + n > f {
                    return Err(fail("noSpace"));
                }
            }
            self.used.set(self.used.get() + n);
            Ok(())
        }
        fn crash(&self, p: &str) -> Result<(), Fail> {
            self.hits.set(self.hits.get() + 1);
            self.points.borrow_mut().push(p.to_string());
            if let Some(h) = &self.hook {
                h(p);
            }
            if self.crash_at == Some(self.hits.get()) {
                return Err(Fail::crash(p));
            }
            Ok(())
        }
        fn sync(&self, p: &Path, dir: bool) -> io::Result<()> {
            let s = p.to_string_lossy().replace('\\', "/");
            self.points.borrow_mut().push(format!("sync{}", if dir { "Dir" } else { "" }));
            if self.fail_sync.as_ref().map(|x| s.ends_with(x.as_str())).unwrap_or(false) {
                return Err(io::Error::other("the disk refused the flush"));
            }
            if !dir && self.spoil_on_sync.as_ref().map(|x| s.ends_with(x.as_str())).unwrap_or(false) {
                let mut b = fs::read(p)?;
                if let Some(x) = b.first_mut() {
                    *x ^= 0xff;
                }
                fs::write(p, b)?;
            }
            sync_real(p, dir)
        }
    }
    fn env<'a>(io: &'a dyn Io, count: usize) -> Env<'a> {
        let mut e = Env::new(io, &Stored);
        e.batch_count = count;
        e
    }
    fn quiet() -> Pr<'static> {
        Pr { on: &|_, _, _| {}, stopped: &|| false }
    }

    #[derive(Clone, Default)]
    struct E {
        name: String,
        data: Option<Vec<u8>>,
        rep: usize,
        method: u16,
        dir: bool,
        bad_crc: bool,
        pw: Option<&'static str>,
        bad_sum: bool,
        link: Option<&'static str>,
        typ: Option<char>,
    }
    fn e(name: &str) -> E {
        E { name: name.into(), rep: 3, method: 8, ..Default::default() }
    }
    fn data_of(x: &E) -> Vec<u8> {
        x.data.clone().unwrap_or_else(|| format!("body of {}\n", x.name).repeat(x.rep).into_bytes())
    }
    fn zc_encrypt(pw: &str, body: &[u8], crc: u32) -> Vec<u8> {
        let mut k = ZipKeys::new(pw);
        let mut all = vec![7u8; 12];
        all[11] = (crc >> 24) as u8;
        all.extend_from_slice(body);
        all.iter()
            .map(|&p| {
                let c = p ^ k.byte();
                k.up(p);
                c
            })
            .collect()
    }
    fn mk_zip(es: &[E]) -> Vec<u8> {
        let (mut parts, mut cds, mut pos) = (Vec::new(), Vec::new(), 0u32);
        for x in es {
            let name = x.name.as_bytes();
            let data = if x.dir { vec![] } else { data_of(x) };
            let method = if x.dir { 0 } else { x.method };
            let crc = crc32(&data, 0);
            let mut body = if method == 8 { stored(&data) } else { data.clone() };
            if let Some(p) = x.pw {
                body = zc_encrypt(p, &body, crc);
            }
            let sc = if x.bad_crc { crc ^ 1 } else { crc };
            let flags: u16 = 0x800 | if x.pw.is_some() { 1 } else { 0 };
            let mut h = vec![0u8; 30];
            h[0..4].copy_from_slice(&0x0403_4b50u32.to_le_bytes());
            h[4..6].copy_from_slice(&20u16.to_le_bytes());
            h[6..8].copy_from_slice(&flags.to_le_bytes());
            h[8..10].copy_from_slice(&method.to_le_bytes());
            h[10..12].copy_from_slice(&0x6000u16.to_le_bytes());
            h[12..14].copy_from_slice(&0x5a21u16.to_le_bytes());
            h[14..18].copy_from_slice(&sc.to_le_bytes());
            h[18..22].copy_from_slice(&(body.len() as u32).to_le_bytes());
            h[22..26].copy_from_slice(&(data.len() as u32).to_le_bytes());
            h[26..28].copy_from_slice(&(name.len() as u16).to_le_bytes());
            let mut c = vec![0u8; 46];
            c[0..4].copy_from_slice(&0x0201_4b50u32.to_le_bytes());
            c[4..6].copy_from_slice(&20u16.to_le_bytes());
            c[6..8].copy_from_slice(&20u16.to_le_bytes());
            c[8..10].copy_from_slice(&flags.to_le_bytes());
            c[10..12].copy_from_slice(&method.to_le_bytes());
            c[12..14].copy_from_slice(&0x6000u16.to_le_bytes());
            c[14..16].copy_from_slice(&0x5a21u16.to_le_bytes());
            c[16..20].copy_from_slice(&sc.to_le_bytes());
            c[20..24].copy_from_slice(&(body.len() as u32).to_le_bytes());
            c[24..28].copy_from_slice(&(data.len() as u32).to_le_bytes());
            c[28..30].copy_from_slice(&(name.len() as u16).to_le_bytes());
            c[42..46].copy_from_slice(&pos.to_le_bytes());
            pos += (30 + name.len() + body.len()) as u32;
            parts.extend(h);
            parts.extend_from_slice(name);
            parts.extend(body);
            cds.extend(c);
            cds.extend_from_slice(name);
        }
        let mut eo = vec![0u8; 22];
        eo[0..4].copy_from_slice(&0x0605_4b50u32.to_le_bytes());
        eo[8..10].copy_from_slice(&(es.len() as u16).to_le_bytes());
        eo[10..12].copy_from_slice(&(es.len() as u16).to_le_bytes());
        eo[12..16].copy_from_slice(&(cds.len() as u32).to_le_bytes());
        eo[16..20].copy_from_slice(&pos.to_le_bytes());
        parts.extend(cds);
        parts.extend(eo);
        parts
    }
    fn tar_header(name: &[u8], size: usize, t: char, link: &str) -> Vec<u8> {
        let mut h = vec![0u8; 512];
        h[..name.len().min(100)].copy_from_slice(&name[..name.len().min(100)]);
        let put = |h: &mut Vec<u8>, at: usize, s: &[u8]| h[at..at + s.len()].copy_from_slice(s);
        put(&mut h, 100, b"0000644\0");
        put(&mut h, 108, b"0001750\0");
        put(&mut h, 116, b"0001750\0");
        put(&mut h, 124, format!("{:011o}\0", size).as_bytes());
        put(&mut h, 136, b"14700000000\0");
        h[156] = t as u8;
        put(&mut h, 157, link.as_bytes());
        put(&mut h, 257, b"ustar\0");
        put(&mut h, 263, b"00");
        for b in &mut h[148..156] {
            *b = 32;
        }
        let sum: u32 = h.iter().map(|&b| b as u32).sum();
        put(&mut h, 148, format!("{:06o}\0 ", sum).as_bytes());
        h
    }
    fn pad(b: &mut Vec<u8>) {
        while b.len() % 512 != 0 {
            b.push(0);
        }
    }
    fn mk_tar(es: &[E]) -> Vec<u8> {
        let mut out = Vec::new();
        for x in es {
            let data = if x.dir || x.link.is_some() || x.typ.is_some() { vec![] } else { data_of(x) };
            let nb = x.name.as_bytes();
            if nb.len() > 100 {
                out.extend(tar_header(b"././@LongLink", nb.len() + 1, 'L', ""));
                let mut l = nb.to_vec();
                l.push(0);
                pad(&mut l);
                out.extend(l);
            }
            let t = x.typ.unwrap_or(if x.dir { '5' } else if x.link.is_some() { '2' } else { '0' });
            let mut h = tar_header(nb, data.len(), t, x.link.unwrap_or(""));
            if x.bad_sum {
                h[148] ^= 0x37;
            }
            out.extend(h);
            let mut d = data;
            pad(&mut d);
            out.extend(d);
        }
        out.extend(vec![0u8; 1024]);
        out
    }
    fn build(fmt: &str, es: &[E]) -> Vec<u8> {
        if fmt == "zip" {
            mk_zip(es)
        } else {
            mk_tar(es)
        }
    }
    fn entries() -> Vec<E> {
        let mut r = 12345u32;
        let rnd: Vec<u8> = (0..3000)
            .map(|_| {
                r = r.wrapping_mul(1_103_515_245).wrapping_add(12345);
                (r >> 16) as u8
            })
            .collect();
        vec![
            E { rep: 40, ..e("readme.txt") },
            E { dir: true, ..e("docs/") },
            E { method: 0, rep: 30, ..e("docs/guide.md") },
            E { rep: 200, ..e("docs/deep/note.txt") },
            E { data: Some(rnd), method: 0, ..e("pics/a.bin") },
            E { data: Some(vec![3u8; 5000]), ..e("pics/b.bin") },
            E { data: Some(vec![]), ..e("empty.txt") },
            E { rep: 9, ..e("last.txt") },
        ]
    }
    struct Case {
        d: PathBuf,
        file: PathBuf,
        dest: PathBuf,
        registry: PathBuf,
    }
    fn setup(buf: &[u8], ext: &str) -> Case {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!("kt-extractjob-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("src")).unwrap();
        let file = d.join("src").join(format!("a.{}", ext));
        fs::write(&file, buf).unwrap();
        Case { dest: d.join("src").join("out"), registry: d.join("reg"), file, d }
    }
    impl Drop for Case {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.d);
        }
    }
    fn tree(dir: &Path) -> BTreeMap<String, String> {
        fn walk(base: &Path, d: &Path, out: &mut BTreeMap<String, String>) {
            let rd = match fs::read_dir(d) {
                Ok(r) => r,
                Err(_) => return,
            };
            for x in rd.flatten() {
                let nm = x.file_name().to_string_lossy().into_owned();
                if nm.starts_with(S::ASIDE_DIR) {
                    continue;
                }
                let p = x.path();
                let rel = p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
                if x.file_type().unwrap().is_dir() {
                    out.insert(format!("{}/", rel), "dir".into());
                    walk(base, &p, out);
                } else {
                    out.insert(rel, format!("{:08x}", crc32(&fs::read(&p).unwrap(), 0)));
                }
            }
        }
        let mut o = BTreeMap::new();
        walk(dir, dir, &mut o);
        o
    }
    fn expected(es: &[E]) -> BTreeMap<String, String> {
        let mut o = BTreeMap::new();
        for x in es {
            if x.link.is_some() {
                continue;
            }
            let n = x.name.trim_end_matches('/').to_string();
            if x.dir {
                o.insert(format!("{}/", n), "dir".into());
            } else {
                o.insert(n.clone(), format!("{:08x}", crc32(&data_of(x), 0)));
                let parts: Vec<&str> = n.split('/').collect();
                for i in 1..parts.len() {
                    o.insert(format!("{}/", parts[..i].join("/")), "dir".into());
                }
            }
        }
        o
    }
    fn files_of(t: &BTreeMap<String, String>) -> Vec<String> {
        t.keys().filter(|k| !k.ends_with('/')).cloned().collect()
    }
    fn no_traces(c: &Case) -> bool {
        !exists(&journal_of(&c.file)) && !exists(&tail_of(&c.file)) && !exists(&with_suffix(&c.file, LOCK_SUFFIX))
    }
    fn opts(c: &Case, in_place: bool) -> Opts {
        Opts { in_place, registry: Some(c.registry.clone()), ..Default::default() }
    }
    fn answers(t: &str) -> Option<J> {
        Some(vidjson::parse(t).unwrap())
    }

    /* ---- the shared vectors: the same answers as desktop/inplace.cjs over archsafe.cjs ---- */
    #[test]
    fn shared_vectors() {
        let text = include_str!("../../../tests/data/extractjob-vectors.tsv");
        let (mut n, mut bad) = (0, 0);
        let tmp = std::env::temp_dir().join(format!("kt-ejvec-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        for line in text.lines() {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let f: Vec<&str> = line.split('\t').collect();
            n += 1;
            let (got, want): (String, String) = match f[0] {
                "preflight" => {
                    let facts = Facts::from_j(&vidjson::parse(f[1]).unwrap());
                    let r = preflight(&facts, f[2].parse().unwrap());
                    let mut kinds: Vec<String> = r.get("problems").unwrap().as_arr().unwrap().iter().map(|p| format!("{}:{}", gs(p, "kind"), gs(p, "severity"))).collect();
                    kinds.sort();
                    let g = [
                        if gb(r.get("normal").unwrap(), "ok") { "1" } else { "0" }.to_string(),
                        if gb(r.get("inPlace").unwrap(), "ok") { "1" } else { "0" }.to_string(),
                        gs(&r, "recommend"),
                        gs(&r, "why"),
                        if kinds.is_empty() { "-".into() } else { kinds.join(",") },
                        gu(r.get("space").unwrap(), "normal").to_string(),
                        gu(r.get("space").unwrap(), "inPlace").to_string(),
                    ];
                    (g.join("\t"), f[3..10].join("\t"))
                }
                "units" => {
                    let bytes: Vec<u8> = (0..f[2].len()).step_by(2).map(|i| u8::from_str_radix(&f[2][i..i + 2], 16).unwrap()).collect();
                    let p = tmp.join(f[3]);
                    fs::write(&p, &bytes).unwrap();
                    let s = units_of(&p).unwrap();
                    let us: Vec<String> = s.units.iter().map(|u| format!("{}:{}:{}:{}:{}:{}", u.name, u.start, u.data_start, u.data_end, u.end, if u.bad { 1 } else { 0 })).collect();
                    (format!("{}\t{}", us.join("|"), if s.layout_bad.is_empty() { "-".into() } else { s.layout_bad.join(",") }), format!("{}\t{}", f[4], f[5]))
                }
                "plan" => {
                    let dest = tmp.join(format!("plan{}", n));
                    fs::create_dir_all(&dest).unwrap();
                    if f[2] != "-" {
                        for x in f[2].split('|') {
                            let p = dest.join(x);
                            fs::create_dir_all(p.parent().unwrap()).unwrap();
                            fs::write(p, "old").unwrap();
                        }
                    }
                    let units = f[1].split('|').map(|nm| Unit { name: nm.into(), dir: nm.ends_with('/'), ..Default::default() }).collect();
                    let scan = Scan { format: "zip", units, tail_start: 0, size: 0, zip64: false, layout_bad: vec![], id_crc: 0 };
                    let ans = if f[3] == "-" { None } else { answers(f[3]) };
                    let g = match plan_outs(&scan, &dest, f[5], ans.as_ref(), f[4] == "1", "ID", &[]) {
                        Ok(p) => format!("{}\t{}", p.units.iter().map(|u| format!("{}:{}", u.kind, u.out)).collect::<Vec<_>>().join("|"), if p.moves.is_empty() { "-".into() } else { p.moves.iter().map(|(a, b)| format!("{}>{}", a, b)).collect::<Vec<_>>().join("|") }),
                        Err(e) => format!("{}{}\t-", e.msg, if e.names.is_empty() { String::new() } else { format!(" {}", e.names.join(",")) }),
                    };
                    (g, format!("{}\t{}", f[6], f[7]))
                }
                "journal" => (journal_text(&vidjson::parse(f[1]).unwrap()).replace('\n', "\\n"), f[2].to_string()),
                "tail" => {
                    let raw: Vec<u8> = if f[2] == "-" { vec![] } else { (0..f[2].len()).step_by(2).map(|i| u8::from_str_radix(&f[2][i..i + 2], 16).unwrap()).collect() };
                    let tb = tail_buffer(&vidjson::parse(f[1]).unwrap(), &raw);
                    let back = read_tail(&tb).unwrap();
                    assert_eq!(back.1, raw);
                    (format!("{:08x}", crc32(&tb, 0)), f[3].to_string())
                }
                "zipend" => {
                    let e = zip_end(f[1].parse().unwrap(), f[2].parse().unwrap(), f[3].parse().unwrap());
                    (e.iter().map(|b| format!("{:02x}", b)).collect::<String>(), f[4].to_string())
                }
                k => panic!("kind {}", k),
            };
            if got != want {
                bad += 1;
                eprintln!("MISMATCH {} {}\n  want {}\n  got  {}", f[0], &f[1][..f[1].len().min(80)], want, got);
            }
        }
        let _ = fs::remove_dir_all(&tmp);
        assert!(n >= 60, "vectors read: {}", n);
        assert_eq!(bad, 0, "{} of {} vectors differ", bad, n);
    }

    #[test]
    fn crc_b64_sha1() {
        assert_eq!(crc32(b"123456789", 0), 0xcbf4_3926);
        assert_eq!(crc32(b"6789", crc32(b"12345", 0)), S::crc32(b"123456789", 0));
        for v in [&b""[..], b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar"] {
            assert_eq!(unb64(&b64(v)).unwrap(), v);
        }
        assert_eq!(b64(b"foobar"), "Zm9vYmFy");
        let h: String = sha1(b"abc").iter().map(|b| format!("{:02x}", b)).collect();
        assert_eq!(h, "a9993e364706816aba3e25717850c26c9cd0d89d");
        // RFC 6070's first PBKDF2-HMAC-SHA1 vector.
        let d: String = pbkdf2_sha1(b"password", b"salt", 1, 20).iter().map(|b| format!("{:02x}", b)).collect();
        assert_eq!(d, "0c60c80f961f0e71f3a9b524af6012062fe037a6");
    }

    /* ---- pre-flight: an unsupported method, first / middle / last, refused before any change ---- */
    #[test]
    fn unsupported_method_refused() {
        for at in [0, 3, 7] {
            for in_place in [true, false] {
                let es: Vec<E> = entries().into_iter().enumerate().map(|(i, x)| if i == at { E { dir: false, name: if x.dir { "x.zst".into() } else { x.name.clone() }, method: 93, ..x } } else { x }).collect();
                let c = setup(&mk_zip(&es), "zip");
                let orig = fs::read(&c.file).unwrap();
                let io = Fake::default();
                let o = Opts { verify_first: true, answers: answers(r#"{"default":"both"}"#), ..opts(&c, in_place) };
                let r = extract(&c.file, &c.dest, &o, &env(&io, 64), &quiet());
                let e = r.err().expect("refused");
                assert!(e.msg.starts_with("refused method") && e.nothing_changed, "{}", e.msg);
                assert_eq!(fs::read(&c.file).unwrap(), orig);
                assert!(!exists(&c.dest) && no_traces(&c));
            }
        }
    }

    /* ---- passwords ---- */
    #[test]
    fn passwords() {
        let es = vec![E { rep: 50, pw: Some("sesame"), ..e("secret/a.txt") }, E { rep: 5, pw: Some("sesame"), method: 0, ..e("secret/b.txt") }];
        let c = setup(&mk_zip(&es), "zip");
        let orig = fs::read(&c.file).unwrap();
        let io = Fake::default();
        for pw in [None, Some("wrong"), Some("Sesame")] {
            let o = Opts { password: pw.map(|x| x.to_string()), ..opts(&c, false) };
            let e = extract(&c.file, &c.dest, &o, &env(&io, 64), &quiet()).err().unwrap();
            assert!(e.msg.starts_with("refused password"), "{}", e.msg);
            assert!(!exists(&c.dest) && fs::read(&c.file).unwrap() == orig);
        }
        let e = extract(&c.file, &c.dest, &Opts { password: Some("sesame".into()), ..opts(&c, true) }, &env(&io, 64), &quiet()).err().unwrap();
        assert!(e.msg.starts_with("refused encryptedInPlace") || e.msg.starts_with("refused method"), "{}", e.msg);
        let r = extract(&c.file, &c.dest, &Opts { password: Some("sesame".into()), ..opts(&c, false) }, &env(&io, 64), &quiet()).unwrap();
        assert_eq!(gu(&r, "files"), 2);
        assert_eq!(tree(&c.dest), expected(&es));
        // AES: the PBKDF2 verifier checked without 7-Zip.
        let salt = [9u8; 16];
        let dk = pbkdf2_sha1(b"open", &salt, 1000, 66);
        let af = c.d.join("aes.bin");
        let mut b = salt.to_vec();
        b.extend_from_slice(&dk[64..]);
        b.extend_from_slice(&[0u8; 12]);
        fs::write(&af, &b).unwrap();
        let scan = Scan { format: "zip", units: vec![Unit { encrypted: true, csize: 30, method: 99, aes: Some(3), data_start: 0, ..Default::default() }], tail_start: 0, size: 0, zip64: false, layout_bad: vec![], id_crc: 0 };
        assert_eq!(check_password(&af, &scan, Some("open"), &Stored).unwrap(), "ok");
        assert_eq!(check_password(&af, &scan, Some("shut"), &Stored).unwrap(), "wrong");
    }

    /* ---- a damaged entry (CRC) first / middle / last ---- */
    #[test]
    fn damaged_entries() {
        for at in [0, 3, 7] {
            let es: Vec<E> = entries().into_iter().enumerate().map(|(i, x)| if i == at { E { bad_crc: true, ..x } } else { x }).collect();
            let bad = es[at].name.clone();
            let io = Fake::default();
            {
                let c = setup(&mk_zip(&es), "zip");
                let orig = fs::read(&c.file).unwrap();
                let e = extract(&c.file, &c.dest, &Opts { verify_first: true, ..opts(&c, true) }, &env(&io, 64), &quiet()).err().unwrap();
                assert!(e.msg.starts_with("refused damaged"), "{}", e.msg);
                assert!(fs::read(&c.file).unwrap() == orig && no_traces(&c));
                let r = extract(&c.file, &c.dest, &opts(&c, false), &env(&io, 64), &quiet()).unwrap();
                assert!(gstrs(&r, "damaged").contains(&bad) || es[at].dir, "{:?}", r);
                let want: Vec<E> = es.iter().filter(|x| x.name != bad).cloned().collect();
                assert_eq!(files_of(&tree(&c.dest)), files_of(&expected(&want)));
            }
            if es[at].dir {
                continue;
            }
            let c = setup(&mk_zip(&es), "zip");
            let orig = fs::read(&c.file).unwrap();
            let e = extract(&c.file, &c.dest, &opts(&c, true), &env(&io, 2), &quiet()).err().unwrap();
            assert!(e.msg.starts_with("crcMismatch") && exists(&journal_of(&c.file)), "{}", e.msg);
            let rr = restore(&journal_of(&c.file), &env(&io, 2)).unwrap();
            assert!(gb(&rr, "identical"), "{:?}", rr);
            assert_eq!(fs::read(&c.file).unwrap(), orig);
            assert!(no_traces(&c) && units_of(&c.file).is_ok() && files_of(&tree(&c.dest)).is_empty());
        }
        for at in [0, 3, 7] {
            let es: Vec<E> = entries().into_iter().enumerate().map(|(i, x)| if i == at { E { bad_sum: true, ..x } } else { x }).collect();
            let c = setup(&mk_tar(&es), "tar");
            let orig = fs::read(&c.file).unwrap();
            let e = extract(&c.file, &c.dest, &Opts { verify_first: true, ..opts(&c, true) }, &env(&Fake::default(), 64), &quiet()).err().unwrap();
            assert!(e.msg.starts_with("refused layout") || e.msg.starts_with("refused damaged"), "{}", e.msg);
            assert!(fs::read(&c.file).unwrap() == orig && no_traces(&c));
        }
    }

    /* ---- tar devices, FIFOs and sparse files are never made ---- */
    #[test]
    fn special_tar_entries() {
        let es = vec![e("a.txt"), E { typ: Some('6'), ..e("pipe") }, E { typ: Some('3'), ..e("dev") }, E { typ: Some('S'), ..e("sparse") }, e("z.txt")];
        let c = setup(&mk_tar(&es), "tar");
        let orig = fs::read(&c.file).unwrap();
        let io = Fake::default();
        let e1 = extract(&c.file, &c.dest, &opts(&c, true), &env(&io, 64), &quiet()).err().unwrap();
        assert!(e1.msg.starts_with("refused layout"), "{}", e1.msg);
        assert!(fs::read(&c.file).unwrap() == orig && no_traces(&c));
        let r = extract(&c.file, &c.dest, &opts(&c, false), &env(&io, 64), &quiet()).unwrap();
        assert_eq!(files_of(&tree(&c.dest)), vec!["a.txt".to_string(), "z.txt".to_string()]);
        let d = gstrs(&r, "damaged");
        assert!(d.contains(&"pipe".into()) && d.contains(&"dev".into()) && d.contains(&"sparse".into()), "{:?}", d);
    }

    /* ---- the disk fills at 10 / 50 / 90 %, then Finish — and, separately, Restore ---- */
    #[test]
    fn disk_full_then_finish_or_restore() {
        for fmt in ["zip", "tar"] {
            for in_place in [true, false] {
                for pct in [10u64, 50, 90] {
                    for after in ["finish", "restore"] {
                        let es = entries();
                        let c = setup(&build(fmt, &es), fmt);
                        let orig = fs::read(&c.file).unwrap();
                        let out_bytes: u64 = es.iter().filter(|x| !x.dir).map(|x| data_of(x).len() as u64).sum();
                        let io = Fake { fill_at: Some(400 + out_bytes * pct / 100 + 8000), ..Default::default() };
                        let label = format!("{} {} {}% {}", fmt, in_place, pct, after);
                        let r = extract(&c.file, &c.dest, &Opts { answers: answers(r#"{"default":"both"}"#), ..opts(&c, in_place) }, &env(&io, 2), &quiet());
                        let e = match r {
                            Ok(_) => continue,
                            Err(e) => e,
                        };
                        let sh = shelf(&c.registry, false, UNDO_MS);
                        if sh.is_empty() {
                            assert!(e.msg.starts_with("noSpace") && e.nothing_changed && fs::read(&c.file).unwrap() == orig && no_traces(&c), "{}: {}", label, e.msg);
                            continue;
                        }
                        assert!(e.msg.starts_with("noSpace"), "{}: {}", label, e.msg);
                        assert_eq!(gstrs(&sh[0], "can").join(","), "finish,restore,leave", "{}", label);
                        assert_eq!(gs(&sh[0], "why"), "noSpace");
                        let jp = PathBuf::from(gs(&sh[0], "journal"));
                        let free = Fake::default();
                        if after == "finish" {
                            finish(&jp, &env(&free, 2), &quiet(), None, 0).unwrap();
                            assert_eq!(tree(&c.dest), expected(&es), "{}", label);
                            assert!(if in_place { !exists(&c.file) } else { fs::read(&c.file).unwrap() == orig }, "{}", label);
                        } else {
                            let rr = restore(&jp, &env(&free, 2)).unwrap();
                            assert!(gb(&rr, "identical") && fs::read(&c.file).unwrap() == orig && files_of(&tree(&c.dest)).is_empty() && no_traces(&c), "{}: {:?}", label, rr);
                        }
                    }
                }
            }
        }
    }

    /* ---- unsafe names: rewritten per target, or refused before any change ---- */
    #[test]
    fn names() {
        let cases = [("meeting 10:30.txt", "linux", "meeting 10:30.txt"), ("meeting 10:30.txt", "windows", "meeting 10_30.txt"), ("dir/a:b", "android-fat", "dir/a_b"), ("CON.txt", "windows", "_CON.txt"), ("name.", "windows", "name_"), ("a\u{7}b", "windows", "a_b"), (".hidden", "linux", ".hidden"), ("-rf", "linux", "-rf")];
        for (name, plat, want) in cases {
            for fmt in ["zip", "tar"] {
                let c = setup(&build(fmt, &[e(name), e("ok.txt")]), fmt);
                let r = extract(&c.file, &c.dest, &Opts { platform: Some(plat.into()), ..opts(&c, true) }, &env(&Fake::default(), 64), &quiet()).unwrap();
                assert!(gu(&r, "files") == 2 && exists(&c.dest.join(want)) && !exists(&c.file), "{} {} {:?}", fmt, name, tree(&c.dest));
            }
        }
        for (name, plat) in [("C:/x.txt", "linux"), ("c:x", "macos"), ("../up.txt", "linux"), ("a/../../b", "android"), ("/etc/x", "linux"), ("x.kt-part", "linux")] {
            for fmt in ["zip", "tar"] {
                for in_place in [true, false] {
                    let c = setup(&build(fmt, &[e("ok.txt"), e(name)]), fmt);
                    let orig = fs::read(&c.file).unwrap();
                    let er = extract(&c.file, &c.dest, &Opts { platform: Some(plat.into()), ..opts(&c, in_place) }, &env(&Fake::default(), 64), &quiet()).err().unwrap();
                    assert!(er.msg.starts_with("refused names") && fs::read(&c.file).unwrap() == orig && !exists(&c.dest) && no_traces(&c), "{} {} {}", fmt, name, er.msg);
                }
            }
        }
    }

    /* ---- duplicate and case-clashing entries ---- */
    #[test]
    fn clashes() {
        for fmt in ["zip", "tar"] {
            for (names, plat, ok) in [(["a.txt", "a.txt"], "linux", false), (["A.txt", "a.txt"], "windows", false), (["A.txt", "a.txt"], "linux", true)] {
                let es: Vec<E> = names.iter().enumerate().map(|(i, n)| E { data: Some(format!("v{}", i).into_bytes()), ..e(n) }).collect();
                let c = setup(&build(fmt, &es), fmt);
                let orig = fs::read(&c.file).unwrap();
                let r = extract(&c.file, &c.dest, &Opts { platform: Some(plat.into()), ..opts(&c, true) }, &env(&Fake::default(), 64), &quiet());
                if ok {
                    assert_eq!(gu(&r.unwrap(), "files"), 2);
                    continue;
                }
                let er = r.err().unwrap();
                assert!(er.msg.starts_with("refused clash") && fs::read(&c.file).unwrap() == orig && no_traces(&c), "{}", er.msg);
                let r2 = extract(&c.file, &c.dest, &Opts { platform: Some(plat.into()), answers: answers(r#"{"default":"both"}"#), ..opts(&c, false) }, &env(&Fake::default(), 64), &quiet()).unwrap();
                assert!(gu(&r2, "files") == 2 && tree(&c.dest).keys().any(|k| k.contains(" (2)")), "{:?}", tree(&c.dest));
            }
        }
    }

    /* ---- a file appearing between the pre-flight and the write is never overwritten; a link there is never followed ---- */
    #[test]
    fn appeared_and_links() {
        for fmt in ["zip", "tar"] {
            for in_place in [true, false] {
                let es = entries();
                let c = setup(&build(fmt, &es), fmt);
                let dest = c.dest.clone();
                let io = Fake {
                    hook: Some(Box::new(move |p: &str| {
                        if p == "aside" {
                            fs::create_dir_all(&dest).unwrap();
                            fs::write(dest.join("last.txt"), "theirs").unwrap();
                        }
                    })),
                    ..Default::default()
                };
                let r = extract(&c.file, &c.dest, &opts(&c, in_place), &env(&io, 64), &quiet()).unwrap();
                assert_eq!(fs::read_to_string(c.dest.join("last.txt")).unwrap(), "theirs");
                assert_eq!(fs::read(c.dest.join("last (2).txt")).unwrap(), data_of(&es[7]));
                assert!(gstrs(&r, "appeared").contains(&"last.txt".into()));
            }
        }
        #[cfg(unix)]
        {
            // A part file name planted as a link is never written through; a folder in the destination that is a link
            // is never written into.
            let c = setup(&mk_zip(&[e("a.txt"), e("sub/b.txt")]), "zip");
            fs::create_dir_all(&c.dest).unwrap();
            let elsewhere = c.d.join("elsewhere");
            fs::create_dir_all(&elsewhere).unwrap();
            std::os::unix::fs::symlink(&elsewhere, c.dest.join("sub")).unwrap();
            let er = extract(&c.file, &c.dest, &opts(&c, false), &env(&Fake::default(), 64), &quiet()).err().unwrap();
            assert!(er.msg.starts_with("throughLink"), "{}", er.msg);
            assert!(fs::read_dir(&elsewhere).unwrap().next().is_none());
        }
    }

    /* ---- killed after every single step, then Finish — and, from the same point, Restore ---- */
    #[test]
    fn killed_at_every_step() {
        for fmt in ["zip", "tar"] {
            for in_place in [true, false] {
                let es = entries();
                let (mut steps, mut k) = (0, 1);
                while k < 200 {
                    let mut crashed = false;
                    for after in ["finish", "restore"] {
                        let c = setup(&build(fmt, &es), fmt);
                        let orig = fs::read(&c.file).unwrap();
                        let io = Fake { crash_at: Some(k), ..Default::default() };
                        let r = extract(&c.file, &c.dest, &opts(&c, in_place), &env(&io, 3), &quiet());
                        let er = match r {
                            Ok(_) => {
                                assert_eq!(tree(&c.dest), expected(&es));
                                continue;
                            }
                            Err(er) => er,
                        };
                        crashed = true;
                        assert!(er.crash, "only the crash stops it: {}", er.msg);
                        let sh = shelf(&c.registry, false, UNDO_MS);
                        let jp = sh.first().map(|x| PathBuf::from(gs(x, "journal")));
                        let free = Fake::default();
                        let label = format!("{} {} crash {} ({:?}) then {}", fmt, if in_place { "in place" } else { "normal" }, k, er.msg, after);
                        if after == "finish" {
                            match &jp {
                                None => {
                                    extract(&c.file, &c.dest, &opts(&c, in_place), &env(&free, 3), &quiet()).unwrap();
                                }
                                Some(jp) => {
                                    finish(jp, &env(&free, 3), &quiet(), None, 0).unwrap_or_else(|x| panic!("{}: {}", label, x.msg));
                                }
                            }
                            assert_eq!(tree(&c.dest), expected(&es), "{}", label);
                            assert!(if in_place { !exists(&c.file) } else { fs::read(&c.file).unwrap() == orig }, "{}", label);
                        } else {
                            match &jp {
                                Some(jp) => {
                                    restore(jp, &env(&free, 3)).unwrap_or_else(|x| panic!("{}: {}", label, x.msg));
                                }
                                None => {
                                    preflight_of(&c.file, &c.dest, &FactOpts::default(), 0, &env(&free, 3), &quiet()).unwrap();
                                }
                            }
                            assert!(fs::read(&c.file).unwrap() == orig, "{}: archive not as it was", label);
                            assert!(units_of(&c.file).is_ok() && files_of(&tree(&c.dest)).is_empty() && no_traces(&c), "{}: {:?}", label, tree(&c.dest));
                        }
                    }
                    if !crashed {
                        break;
                    }
                    steps += 1;
                    k += 1;
                }
                assert!(steps > 5, "{} {}: {} steps", fmt, in_place, steps);
            }
        }
    }

    /* ---- a restore itself killed at every step, then taken up again ---- */
    #[test]
    fn restore_killed_at_every_step() {
        for fmt in ["zip", "tar"] {
            let es = entries();
            let mut k = 1;
            loop {
                let c = setup(&build(fmt, &es), fmt);
                let orig = fs::read(&c.file).unwrap();
                let io = Fake::default();
                let e1 = extract(&c.file, &c.dest, &opts(&c, true), &env(&io, 2), &Pr { on: &|_, _, _| {}, stopped: &{
                    let n = Cell::new(0);
                    move || { n.set(n.get() + 1); n.get() > 2 }
                } });
                assert_eq!(e1.err().unwrap().msg, "stopped");
                let jp = journal_of(&c.file);
                let crash = Fake { crash_at: Some(k), ..Default::default() };
                let r = restore(&jp, &env(&crash, 2));
                if r.is_ok() {
                    break;
                }
                assert!(r.err().unwrap().crash);
                restore(&jp, &env(&Fake::default(), 2)).unwrap();
                assert!(fs::read(&c.file).unwrap() == orig && no_traces(&c) && files_of(&tree(&c.dest)).is_empty(), "{} restore crash {}", fmt, k);
                k += 1;
            }
            assert!(k > 3, "{}: {} steps", fmt, k);
        }
    }

    /* ---- the journal corrupted, cut, of a later version; the archive changed after the crash; a v1 journal ---- */
    #[test]
    fn journals_never_replayed() {
        for fmt in ["zip", "tar"] {
            let crashed = || {
                let c = setup(&build(fmt, &entries()), fmt);
                let io = Fake { crash_at: Some(9), ..Default::default() };
                let _ = extract(&c.file, &c.dest, &opts(&c, true), &env(&io, 2), &quiet());
                let j = journal_of(&c.file);
                assert!(exists(&j));
                (c, j)
            };
            let spoil: [(&str, Box<dyn Fn(&str) -> String>, &str); 3] = [
                ("corrupted", Box::new(|t: &str| t.replacen("\"next\":", "\"next\" :", 1)), "journalCorrupt"),
                ("cut short", Box::new(|t: &str| t[..t.len() / 2].to_string()), "journalCorrupt"),
                ("later version", Box::new(|t: &str| {
                    let line = t.split('\n').next().unwrap().replace("\"version\":2", "\"version\":9");
                    format!("{}\n{:08x}\n", line, crc32(line.as_bytes(), 0))
                }), "journalFuture"),
            ];
            for (what, f, why) in spoil.iter() {
                let (c, j) = crashed();
                let before = fs::read(&c.file).unwrap();
                fs::write(&j, f(&fs::read_to_string(&j).unwrap())).unwrap();
                let er = finish(&j, &env(&Fake::default(), 2), &quiet(), None, 0).err().unwrap();
                let sh = shelf(&c.registry, false, UNDO_MS);
                assert!(er.msg == *why && fs::read(&c.file).unwrap() == before, "{} {}: {}", fmt, what, er.msg);
                assert!(gs(&sh[0], "state") == "blocked" && gs(&sh[0], "why") == *why && gstrs(&sh[0], "can").join(",") == "leave", "{:?}", sh);
            }
            {
                let (c, j) = crashed();
                fs::OpenOptions::new().append(true).open(&c.file).unwrap().write_all(b"x").unwrap();
                let before = fs::read(&c.file).unwrap();
                assert_eq!(finish(&j, &env(&Fake::default(), 2), &quiet(), None, 0).err().unwrap().msg, "archiveChanged");
                assert_eq!(restore(&j, &env(&Fake::default(), 2)).err().unwrap().msg, "archiveChanged");
                assert_eq!(fs::read(&c.file).unwrap(), before);
            }
            {
                let (c, j) = crashed();
                let mut h = fs::OpenOptions::new().write(true).open(&c.file).unwrap();
                h.write_all(b"ZZ").unwrap();
                drop(h);
                assert_eq!(finish(&j, &env(&Fake::default(), 2), &quiet(), None, 0).err().unwrap().msg, "archiveChanged");
            }
        }
        let c = setup(&mk_zip(&entries()), "zip");
        fs::write(journal_of(&c.file), format!("{{\"version\":1,\"committed\":100,\"output\":\"{}\",\"length\":999}}", c.dest.display())).unwrap();
        register(&c.registry, &journal_of(&c.file), "old1").unwrap();
        let sh = shelf(&c.registry, false, UNDO_MS);
        assert!(gs(&sh[0], "why") == "journalV1" && gstrs(&sh[0], "can").join(",") == "restoreV1,leave", "{:?}", sh);
    }

    /* ---- two jobs on the same archive; cancel mid-run ---- */
    #[test]
    fn busy_and_cancel() {
        let c = setup(&mk_zip(&entries()), "zip");
        let (file, other, reg) = (c.file.clone(), c.d.join("other"), c.registry.clone());
        let second: std::rc::Rc<RefCell<Option<String>>> = std::rc::Rc::new(RefCell::new(None));
        let sref = second.clone();
        let io = Fake {
            hook: Some(Box::new(move |p: &str| {
                if p == "unit" && sref.borrow().is_none() {
                    let r = extract(&file, &other, &Opts { registry: Some(reg.clone()), ..Default::default() }, &env(&Fake::default(), 64), &quiet());
                    *sref.borrow_mut() = Some(r.err().map(|e| e.msg).unwrap_or_default());
                }
            })),
            ..Default::default()
        };
        let r = extract(&c.file, &c.dest, &opts(&c, true), &env(&io, 64), &quiet()).unwrap();
        assert_eq!(second.borrow().as_deref(), Some("busy"));
        assert_eq!(gu(&r, "files"), 7);
        for fmt in ["zip", "tar"] {
            let es = entries();
            let c = setup(&build(fmt, &es), fmt);
            let n = Cell::new(0);
            let stop = || {
                n.set(n.get() + 1);
                n.get() > 2
            };
            let er = extract(&c.file, &c.dest, &opts(&c, true), &env(&Fake::default(), 2), &Pr { on: &|_, _, _| {}, stopped: &stop }).err().unwrap();
            let sh = shelf(&c.registry, false, UNDO_MS);
            assert!(er.msg == "stopped" && gs(&sh[0], "state") == "paused" && gu(&sh[0], "done") > 0, "{} {:?}", er.msg, sh);
            finish(Path::new(&gs(&sh[0], "journal")), &env(&Fake::default(), 2), &quiet(), None, 0).unwrap();
            assert!(tree(&c.dest) == expected(&es) && !exists(&c.file));
        }
    }

    /* ---- Undo of a job with replacements (and skip, keep both); dismiss; cleaned at the next start ---- */
    #[test]
    fn undo_and_dismiss() {
        for fmt in ["zip", "tar"] {
            for in_place in [true, false] {
                let es = entries();
                let c = setup(&build(fmt, &es), fmt);
                let orig = fs::read(&c.file).unwrap();
                fs::create_dir_all(c.dest.join("docs")).unwrap();
                fs::write(c.dest.join("readme.txt"), "old readme").unwrap();
                fs::write(c.dest.join("docs/guide.md"), "old guide").unwrap();
                fs::write(c.dest.join("last.txt"), "old last").unwrap();
                let io = Fake::default();
                let un = extract(&c.file, &c.dest, &opts(&c, in_place), &env(&io, 64), &quiet()).err().unwrap();
                assert!(un.msg == "conflictsUnanswered" && un.names.len() == 3 && fs::read(&c.file).unwrap() == orig);
                let r = extract(&c.file, &c.dest, &Opts { answers: answers(r#"{"default":"replace","per":{"last.txt":"skip"}}"#), ..opts(&c, in_place) }, &env(&io, 64), &quiet()).unwrap();
                assert_eq!(fs::read(c.dest.join("readme.txt")).unwrap(), data_of(&es[0]));
                assert_eq!(fs::read_to_string(c.dest.join("last.txt")).unwrap(), "old last");
                undo(Path::new(&gs(&r, "job")), &env(&io, 64)).unwrap();
                assert_eq!(fs::read_to_string(c.dest.join("readme.txt")).unwrap(), "old readme");
                assert_eq!(fs::read_to_string(c.dest.join("docs/guide.md")).unwrap(), "old guide");
                assert_eq!(fs::read_to_string(c.dest.join("last.txt")).unwrap(), "old last");
                assert_eq!(files_of(&tree(&c.dest)).len(), 3, "{:?}", tree(&c.dest));
                assert!(!fs::read_dir(&c.dest).unwrap().flatten().any(|x| x.file_name().to_string_lossy().starts_with(S::ASIDE_DIR)));
                assert_eq!(fs::read(&c.file).unwrap(), orig);
                let c2 = setup(&build(fmt, &es), fmt);
                fs::create_dir_all(&c2.dest).unwrap();
                fs::write(c2.dest.join("readme.txt"), "old").unwrap();
                let r2 = extract(&c2.file, &c2.dest, &Opts { answers: answers(r#"{"files":"both"}"#), ..opts(&c2, in_place) }, &env(&io, 64), &quiet()).unwrap();
                assert_eq!(fs::read(c2.dest.join("readme (2).txt")).unwrap(), data_of(&es[0]));
                dismiss(Path::new(&gs(&r2, "job"))).unwrap();
                assert!(!exists(Path::new(&gs(&r2, "job"))) && shelf(&c2.registry, false, UNDO_MS).is_empty());
            }
        }
        let c = setup(&mk_zip(&entries()), "zip");
        fs::create_dir_all(&c.dest).unwrap();
        fs::write(c.dest.join("readme.txt"), "old").unwrap();
        extract(&c.file, &c.dest, &Opts { answers: answers(r#"{"default":"replace"}"#), ..opts(&c, true) }, &env(&Fake::default(), 64), &quiet()).unwrap();
        assert!(shelf(&c.registry, true, UNDO_MS).is_empty());
        assert!(!fs::read_dir(&c.dest).unwrap().flatten().any(|x| x.file_name().to_string_lossy().starts_with(S::ASIDE_DIR)));
    }

    /* ---- names from every script; zero-byte files, folders only, nested empty folders, an empty archive; many entries ---- */
    #[test]
    fn sets_and_many() {
        let sets: Vec<Vec<E>> = vec![
            vec![e("كتب/إعجاز القرآن.txt"), e("日本語/進撃の巨人.txt"), e("\u{1f600}/\u{1f389}.txt"), e("Cafe\u{301}.txt"), e(&format!("{}/long name.txt", "a".repeat(120)))],
            vec![E { data: Some(vec![]), ..e("z1") }, E { data: Some(vec![]), ..e("z/z2") }],
            vec![E { dir: true, ..e("only/") }, E { dir: true, ..e("only/nested/") }, E { dir: true, ..e("only/nested/deeper/") }],
            vec![],
        ];
        for fmt in ["zip", "tar"] {
            for in_place in [true, false] {
                for es in sets.iter() {
                    let c = setup(&build(fmt, es), fmt);
                    let r = extract(&c.file, &c.dest, &opts(&c, in_place), &env(&Fake::default(), 64), &quiet()).unwrap();
                    assert_eq!(gu(&r, "files") as usize, es.iter().filter(|x| !x.dir).count());
                    assert_eq!(tree(&c.dest), expected(es));
                    assert!(!in_place || !exists(&c.file));
                }
            }
        }
        for fmt in ["zip", "tar"] {
            let es: Vec<E> = (0..3000).map(|i| E { data: Some(format!("#{}", i).into_bytes()), method: if i % 2 == 1 { 8 } else { 0 }, ..e(&format!("d{}/f{}.txt", i % 50, i)) }).collect();
            let c = setup(&build(fmt, &es), fmt);
            let io = Fake::default();
            let t = std::time::Instant::now();
            let r = extract(&c.file, &c.dest, &opts(&c, true), &env(&io, 64), &quiet()).unwrap();
            let journals = io.points.borrow().iter().filter(|p| *p == "journal").count();
            assert_eq!(gu(&r, "files"), 3000);
            assert!(journals <= 3000 / 64 + 4, "{} journal writes", journals);
            assert_eq!(tree(&c.dest).len(), 3050);
            eprintln!("{} 3,000 entries in place: {} ms, {} journal writes", fmt, t.elapsed().as_millis(), journals);
        }
    }

    /* ---- a journal and tail written by the JavaScript engine's format are read here ---- */
    #[test]
    fn journal_round_trip() {
        let j = Journal { id: "x1".into(), mode: "normal".into(), outs: [(2usize, "b (2).txt".to_string())].into_iter().collect(), raws: [(0usize, 7u32)].into_iter().collect(), moves: vec![("a".into(), "b".into())], moved: 1, why: Some("noSpace".into()), ..Default::default() };
        let t = journal_text(&j.to_j());
        let back = Journal::from_j(&journal_read(&t).unwrap());
        assert_eq!(journal_text(&back.to_j()), t);
        assert_eq!(S::journal_read(&t), "ok");
        assert!(matches!(journal_read(&t.replace("x1", "x2")), Err(("corrupt", _))));
    }

    /* ---- P11 review: Undo of a finished job never touches a file that took the archive's name ---- */
    #[test]
    fn undo_never_touches_a_new_file_at_the_archive_path() {
        for fmt in ["zip", "tar"] {
            let es = entries();
            let c = setup(&build(fmt, &es), fmt);
            let orig = fs::read(&c.file).unwrap();
            let r = extract(&c.file, &c.dest, &opts(&c, true), &env(&Fake::default(), 3), &quiet()).unwrap();
            assert!(!exists(&c.file));
            fs::write(&c.file, b"MY OTHER IMPORTANT FILE").unwrap();
            let u = undo(Path::new(&gs(&r, "job")), &env(&Fake::default(), 3)).unwrap();
            assert_eq!(fs::read(&c.file).unwrap(), b"MY OTHER IMPORTANT FILE", "{}", fmt);
            let to = PathBuf::from(gs(&u, "restoredTo"));
            assert_eq!(to.file_name().unwrap().to_string_lossy(), format!("a (2).{}", fmt));
            assert!(gb(&u, "identical") && fs::read(&to).unwrap() == orig, "{:?}", u);
            assert!(files_of(&tree(&c.dest)).is_empty());
        }
        // A restore of a finished job killed at every step, the file it was making then replaced by another: never cut or extended.
        let es = entries();
        let mut k = 1;
        loop {
            let c = setup(&mk_zip(&es), "zip");
            let r = extract(&c.file, &c.dest, &opts(&c, true), &env(&Fake::default(), 3), &quiet()).unwrap();
            let jp = PathBuf::from(gs(&r, "job"));
            let er = restore(&jp, &env(&Fake { crash_at: Some(k), ..Default::default() }, 3));
            if er.is_ok() {
                break;
            }
            let body = journal_read(&fs::read_to_string(&jp).unwrap()).unwrap();
            let at = gs(&body, "restoreAt");
            if !at.is_empty() && exists(Path::new(&at)) {
                fs::write(&at, vec![7u8; 100_000]).unwrap();
                let e2 = restore(&jp, &env(&Fake::default(), 3)).err().map(|e| e.msg).unwrap_or_default();
                assert_eq!(e2, "archiveChanged", "crash {}", k);
                assert_eq!(fs::read(&at).unwrap(), vec![7u8; 100_000], "crash {}: the other file touched", k);
            }
            k += 1;
        }
        assert!(k > 5, "{} steps", k);
    }

    /* ---- P11 review: every output flushed before the journal moves and the archive is cut; a failed flush fails the commit ---- */
    #[test]
    fn flushed_before_the_cut_and_a_failed_flush_cuts_nothing() {
        let es = entries();
        let c = setup(&mk_zip(&es), "zip");
        let io = Fake::default();
        extract(&c.file, &c.dest, &opts(&c, true), &env(&io, 3), &quiet()).unwrap();
        let pts = io.points.borrow().clone();
        let mut since_cut: Vec<&str> = Vec::new();
        let mut cuts = 0;
        for p in pts.iter() {
            if p == "cut" {
                cuts += 1;
                // (this batch: its files flushed, then «synced», then the journal moved, then the cut — nothing flushed after «synced»)
                let s = since_cut.iter().position(|x| *x == "synced").expect("synced before the cut");
                assert!(since_cut[..s].iter().any(|x| *x == "sync"), "no file flushed in a batch: {:?}", since_cut);
                assert!(!since_cut[s..].iter().any(|x| x.starts_with("sync") && *x != "synced"), "flushed after the commit: {:?}", since_cut);
                assert!(since_cut[s..].contains(&"journal"));
                since_cut.clear();
                continue;
            }
            since_cut.push(p);
        }
        assert!(cuts >= 2, "{:?}", pts);
        // a flush that fails: the commit fails, the archive is not cut, the batch's own files are gone; Finish then ends right
        for (what, fake) in [("file", Fake { fail_sync: Some("last.txt".into()), ..Default::default() }), ("folder", Fake { fail_sync: Some("docs/deep".into()), ..Default::default() })] {
            let c = setup(&mk_zip(&es), "zip");
            let orig = fs::read(&c.file).unwrap();
            let e = extract(&c.file, &c.dest, &opts(&c, true), &env(&fake, 64), &quiet()).err().unwrap();
            assert!(e.msg.starts_with("syncFailed"), "{}: {}", what, e.msg);
            assert_eq!(fs::read(&c.file).unwrap(), orig, "{}: cut after a failed flush", what);
            assert!(files_of(&tree(&c.dest)).is_empty(), "{}: {:?}", what, tree(&c.dest));
            finish(&journal_of(&c.file), &env(&Fake::default(), 64), &quiet(), None, 0).unwrap();
            assert_eq!(tree(&c.dest), expected(&es));
        }
        // a disk that hands back other bytes: the read-back fails, the bad file is removed, Finish writes it again under its own name
        let c = setup(&mk_zip(&es), "zip");
        let e = extract(&c.file, &c.dest, &opts(&c, true), &env(&Fake { spoil_on_sync: Some("readme.txt".into()), ..Default::default() }, 64), &quiet()).err().unwrap();
        assert!(e.msg.starts_with("readBack"), "{}", e.msg);
        assert!(!exists(&c.dest.join("readme.txt")));
        finish(&journal_of(&c.file), &env(&Fake::default(), 64), &quiet(), None, 0).unwrap();
        assert_eq!(tree(&c.dest), expected(&es), "no «name (2)» beside a bad file");
    }

    /* ---- P11 review: Undo never loses an original a «replace» moved aside ---- */
    #[test]
    fn undo_puts_every_original_back() {
        for fmt in ["zip", "tar"] {
            for in_place in [true, false] {
                let es = entries();
                let c = setup(&build(fmt, &es), fmt);
                fs::create_dir_all(&c.dest).unwrap();
                fs::write(c.dest.join("readme.txt"), b"ORIGINAL").unwrap();
                let r = extract(&c.file, &c.dest, &Opts { answers: answers(r#"{"default":"replace"}"#), ..opts(&c, in_place) }, &env(&Fake::default(), 64), &quiet()).unwrap();
                fs::write(c.dest.join("readme.txt"), b"edited after").unwrap();
                let u = undo(Path::new(&gs(&r, "job")), &env(&Fake::default(), 64)).unwrap();
                assert_eq!(fs::read(c.dest.join("readme (original).txt")).unwrap(), b"ORIGINAL", "{} {}: {:?}", fmt, in_place, u);
                assert_eq!(fs::read(c.dest.join("readme.txt")).unwrap(), b"edited after");
                assert_eq!(gstrs(&u, "originals"), vec!["readme (original).txt".to_string()]);
            }
        }
    }

    /* ---- P11 review: an entry named like the job's own files is refused before anything changes ---- */
    #[test]
    fn entries_named_like_the_jobs_own_files() {
        for name in ["a.zip.kurokawa-unzip.tmp", "a.zip.kurokawa-tail", "a.zip.kurokawa-lock", "a.zip", ".kurokawa-replaced-x/a.txt"] {
            for in_place in [true, false] {
                let c = setup(&mk_zip(&[E { data: Some(b"precious data".to_vec()), ..e(name) }, e("y.txt")]), "zip");
                let orig = fs::read(&c.file).unwrap();
                let dest = c.file.parent().unwrap().to_path_buf();
                let er = extract(&c.file, &dest, &opts(&c, in_place), &env(&Fake::default(), 64), &quiet()).err().map(|x| x.msg).unwrap_or_default();
                assert!(er.starts_with("refused names"), "{} {}: {}", name, in_place, er);
                assert_eq!(fs::read(&c.file).unwrap(), orig);
            }
        }
    }

    /* ---- P11 review: one bad local header — no panic: left out and reported; in place refused before any change ---- */
    #[test]
    fn a_bad_local_header() {
        let mut b = mk_zip(&[e("x.txt"), e("y.txt")]);
        let second = 30 + 5 + stored(&data_of(&e("x.txt"))).len();
        b[second] = 0;
        let c = setup(&b, "zip");
        let orig = fs::read(&c.file).unwrap();
        let er = extract(&c.file, &c.dest, &opts(&c, true), &env(&Fake::default(), 64), &quiet()).err().unwrap();
        assert!(er.msg.starts_with("refused layout") && fs::read(&c.file).unwrap() == orig && no_traces(&c), "{}", er.msg);
        let r = extract(&c.file, &c.dest, &opts(&c, false), &env(&Fake::default(), 64), &quiet()).unwrap();
        assert_eq!(gstrs(&r, "damaged"), vec!["y.txt".to_string()]);
        assert_eq!(files_of(&tree(&c.dest)), vec!["x.txt".to_string()]);
        undo(Path::new(&gs(&r, "job")), &env(&Fake::default(), 64)).unwrap();
        assert!(files_of(&tree(&c.dest)).is_empty());
    }

    /* ---- P11 review: a stopped job's leftovers: only what it wrote is removed (a tar keeps no CRC: a user's file of the same size stays) ---- */
    #[test]
    fn only_its_own_leftovers_are_removed() {
        for fmt in ["tar", "zip"] {
            let es = entries();
            let mut k = 1;
            loop {
                let c = setup(&build(fmt, &es), fmt);
                fs::create_dir_all(&c.dest).unwrap();
                let theirs = vec![b'T'; data_of(&es[7]).len()];
                fs::write(c.dest.join("last.txt"), &theirs).unwrap();
                let r = extract(&c.file, &c.dest, &Opts { answers: answers(r#"{"default":"both"}"#), ..opts(&c, false) }, &env(&Fake { crash_at: Some(k), ..Default::default() }, 3), &quiet());
                if r.is_ok() {
                    break;
                }
                if let Some(j) = shelf(&c.registry, false, UNDO_MS).first() {
                    finish(Path::new(&gs(j, "journal")), &env(&Fake::default(), 3), &quiet(), None, 0).unwrap();
                    assert_eq!(fs::read(c.dest.join("last.txt")).unwrap(), theirs, "{} crash {}: their file removed", fmt, k);
                    assert_eq!(fs::read(c.dest.join("last (2).txt")).unwrap(), data_of(&es[7]));
                    assert!(!exists(&c.dest.join("last (3).txt")), "{} crash {}: a second copy", fmt, k);
                }
                k += 1;
            }
            assert!(k > 5);
        }
    }

    /* ---- P11 review: the ZIP64 end records when the fallback closes a big archive ---- */
    #[test]
    fn zip64_end_when_needed() {
        assert_eq!(zip_end(3, 10, 100).len(), 22);
        let z = zip_end(70_000, 10, 100);
        assert_eq!(z.len(), 56 + 20 + 22);
        assert_eq!(le64(&z, 32), 70_000);
        assert_eq!(le16(&z, 76 + 10), 0xffff);
        assert_eq!(le64(&zip_end(1, 10, 5_000_000_000), 48), 5_000_000_000);
    }


    /* ---- P11 review: a stopped in-place job's archive listed from its plan (journal v2), restored by its path ---- */
    #[test]
    fn left_entries_of_a_stopped_job() {
        let es = entries();
        let c = setup(&mk_zip(&es), "zip");
        let n = Cell::new(0);
        let stop = || { n.set(n.get() + 1); n.get() > 2 };
        let _ = extract(&c.file, &c.dest, &opts(&c, true), &env(&Fake::default(), 2), &Pr { on: &|_, _, _| {}, stopped: &stop });
        assert_eq!(journal_version(&c.file), 2);
        let left = left_entries(&c.file).unwrap();
        let next = Journal::from_j(&journal_read(&fs::read_to_string(journal_of(&c.file)).unwrap()).unwrap()).next;
        assert!(next > 0 && left.len() == es.len() - next, "{} left, next {}", left.len(), next);
        assert_eq!(left[0].0, "readme.txt");
    }


    /* ---- P11 review: a Cancel is heard inside a large file; then Finish ends right ---- */
    #[test]
    fn cancel_inside_a_large_file() {
        let big = E { data: Some(vec![9u8; (STOP_EVERY * 3) as usize]), method: 0, ..e("big.bin") };
        let es = vec![e("a.txt"), big];
        for in_place in [true, false] {
            let c = setup(&mk_zip(&es), "zip");
            let n = Cell::new(0);
            let stop = || { n.set(n.get() + 1); n.get() > 2 };
            let er = extract(&c.file, &c.dest, &opts(&c, in_place), &env(&Fake::default(), 64), &Pr { on: &|_, _, _| {}, stopped: &stop }).err().unwrap();
            assert_eq!(er.msg, "stopped");
            assert!(!exists(&c.dest.join("big.bin")) && !fs::read_dir(&c.dest).map(|r| r.flatten().any(|x| x.file_name().to_string_lossy().ends_with(".kt-part"))).unwrap_or(false));
            let jp = PathBuf::from(gs(&shelf(&c.registry, false, UNDO_MS)[0], "journal"));
            finish(&jp, &env(&Fake::default(), 64), &quiet(), None, 0).unwrap();
            assert_eq!(tree(&c.dest), expected(&es));
        }
    }

}
