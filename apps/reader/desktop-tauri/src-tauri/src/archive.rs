// Archives (stage R5), desktop/archive.cjs in Rust — the same approach, the same answers: ZIP read by the app's own
// parser (and extracted in place the HatchZip way — last entry first, the archive cut after each committed batch, a
// journal beside it for resuming, «give up» making what is left a whole ZIP again); tar listed and extracted in place
// by its own reader; 7z, rar, encrypted zips and the rest through the 7-Zip program that ships with the app
// (7zip-bin's 7za, bundled as a resource: archives.rs finds it), run with std::process::Command — no shell, the
// arguments as a list; a zip made by streaming (stored for what gains nothing by squeezing, deflate otherwise).
// Std only, checked alone with `rustc --edition 2021 --test archive.rs`: the raw-deflate codec and the free-space
// call come from the caller (archives.rs: flate2, the OS), the tests use a codec of stored blocks.
//
// Differences from archive.cjs, on purpose: an entry is refused when any part of its path would leave the folder
// (also a Windows drive or stream name, `a:b`), checked on the path's parts, not on a resolved string; a link inside
// a 7-Zip-listed archive (tar) that points out of the folder refuses the archive (Electron lets 7-Zip make it); the
// in-place ZIP keeps only the archive's directory beside it (`.kurokawa-tail` from the directory's offset, noted in
// the journal as `tailBase`) where Electron writes a sparse file as long as the archive — which Windows fills with
// zeros; a journal Electron wrote (no `tailBase`) is read as before. 7-Zip is told to speak UTF-8 on Windows
// (`-sccUTF-8`), so names that are not ASCII come back right. A zip's times are UTC (no time zone without a crate).
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// Raw deflate, given by the caller (flate2 in the app; stored blocks in the tests).
pub trait Codec {
    /// The raw deflate stream in `src` decoded into `dst` → the bytes written.
    fn inflate(&self, src: &mut dyn Read, dst: &mut dyn Write) -> io::Result<u64>;
    /// `src` squeezed (raw deflate, level 6) into `dst` → the bytes read.
    fn deflate(&self, src: &mut dyn Read, dst: &mut dyn Write) -> io::Result<u64>;
}

/// The progress of a job, and whether it is to stop: `on(done, total, file)`.
pub struct Pr<'a> {
    pub on: &'a dyn Fn(u64, u64, &str),
    pub stop: &'a AtomicBool,
}
impl<'a> Pr<'a> {
    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }
    fn tell(&self, done: u64, total: u64, file: &str) {
        (self.on)(done, total, file)
    }
}

/// What a job may change: where to extract, how, and the caller's free-space reading (bytes; MAX_SAFE when unknown).
pub struct Ctx<'a> {
    pub codec: &'a dyn Codec,
    /// The 7-Zip program (None: not shipped and not on the PATH — the formats that need it then fail «7z missing»).
    pub seven: Option<PathBuf>,
    pub free: &'a dyn Fn(&Path) -> u64,
}

/// Number.MAX_SAFE_INTEGER: archive.cjs's «unknown» free space.
pub const MAX_SAFE: u64 = 9_007_199_254_740_991;
const STOPPED: &str = "stopped";

fn stopped_io() -> io::Error {
    io::Error::new(io::ErrorKind::Other, STOPPED)
}
fn es(e: io::Error) -> String {
    let s = e.to_string();
    if s == STOPPED {
        STOPPED.to_string()
    } else {
        s
    }
}

/* ---------- CRC-32 ---------- */

fn crc_table() -> &'static [u32; 256] {
    static T: OnceLock<[u32; 256]> = OnceLock::new();
    T.get_or_init(|| {
        let mut t = [0u32; 256];
        for n in 0..256u32 {
            let mut c = n;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            t[n as usize] = c;
        }
        t
    })
}
/// The running CRC (start with !0, finish with `^ !0`).
pub fn crc_update(mut c: u32, b: &[u8]) -> u32 {
    let t = crc_table();
    for &x in b {
        c = t[((c ^ x as u32) & 0xff) as usize] ^ (c >> 8);
    }
    c
}
pub fn crc32(b: &[u8]) -> u32 {
    crc_update(0xffff_ffff, b) ^ 0xffff_ffff
}

/* ---------- names ---------- */

/// archive.cjs's `unsafe`: absolute, a «..» part, a drive letter — and here also a «:» anywhere (a Windows drive or
/// stream), a NUL, or a backslash left in it.
pub fn unsafe_name(name: &str) -> bool {
    if name.starts_with('/') || name.contains('\0') || name.contains(':') || name.contains('\\') {
        return true;
    }
    name.split('/').any(|p| p == "..")
}

/// `dest` joined with an entry's name, refused unless every part of the name is a plain name (no root, drive, «..»).
pub fn safe_join(dest: &Path, name: &str) -> Result<PathBuf, String> {
    if unsafe_name(name) {
        return Err(format!("unsafePath {}", name));
    }
    let mut out = dest.to_path_buf();
    let mut any = false;
    for part in name.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        let p = Path::new(part);
        let mut comps = p.components();
        match (comps.next(), comps.next()) {
            (Some(Component::Normal(_)), None) => {}
            _ => return Err(format!("unsafePath {}", name)),
        }
        out.push(part);
        any = true;
    }
    if !any {
        return Err(format!("unsafePath {}", name));
    }
    Ok(out)
}

/// A link's target, from an entry at `entry`, stays inside the archive's folder (worked out on the text alone).
pub fn link_stays(entry: &str, target: &str) -> bool {
    let t = target.replace('\\', "/");
    if t.starts_with('/') || t.contains(':') {
        return false;
    }
    let mut depth: i64 = entry.split('/').filter(|p| !p.is_empty() && *p != ".").count() as i64 - 1;
    for part in t.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => depth += 1,
        }
    }
    true
}

/// Where an entry goes: refused if it would leave `dest`; its folder made; an existing file kept («skip» → None),
/// beside it under a new name («both»: `name (2).ext`…), or replaced.
pub fn target_for(dest: &Path, name: &str, replace: &str) -> Result<Option<PathBuf>, String> {
    let out = safe_join(dest, name)?;
    if let Some(dir) = out.parent() {
        fs::create_dir_all(dir).map_err(es)?;
    }
    if out.exists() {
        if replace == "skip" {
            return Ok(None);
        }
        if replace == "both" {
            return Ok(Some(free_name(&out)));
        }
    }
    Ok(Some(out))
}
/// `a.txt` → `a (2).txt`, `a (3).txt`… the first not there.
pub fn free_name(out: &Path) -> PathBuf {
    let file = out.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let (base, ext) = match file.rfind('.') {
        Some(i) if i > 0 => (file[..i].to_string(), file[i..].to_string()),
        _ => (file.clone(), String::new()),
    };
    let dir = out.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let mut i = 2u32;
    loop {
        let alt = dir.join(format!("{} ({}){}", base, i, ext));
        if !alt.exists() {
            return alt;
        }
        i += 1;
    }
}

/* ---------- the format ---------- */

fn lower_name(file: &Path) -> String {
    file.file_name().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default()
}
/// archive.cjs's formatOf: by the first bytes, then the name.
pub fn format_of(file: &Path) -> Result<&'static str, String> {
    let mut b = [0u8; 8];
    let mut f = File::open(file).map_err(es)?;
    let mut got = 0;
    while got < 8 {
        let n = f.read(&mut b[got..]).map_err(es)?;
        if n == 0 {
            break;
        }
        got += n;
    }
    let n = lower_name(file);
    let is = |s: &[u8]| b.starts_with(s);
    if is(&[0x50, 0x4b]) {
        return Ok("zip");
    }
    if is(&[0x37, 0x7a, 0xbc, 0xaf]) {
        return Ok("7z");
    }
    if is(&[0x52, 0x61, 0x72, 0x21]) {
        return Ok("rar");
    }
    if is(&[0x1f, 0x8b]) {
        return Ok(if n.ends_with(".tar.gz") || n.ends_with(".tgz") { "tar.gz" } else { "gz" });
    }
    if is(&[0xfd, 0x37, 0x7a, 0x58, 0x5a]) {
        return Ok(if n.ends_with(".tar.xz") || n.ends_with(".txz") { "tar.xz" } else { "xz" });
    }
    if is(&[0x42, 0x5a, 0x68]) {
        return Ok(if n.ends_with(".tar.bz2") || n.ends_with(".tbz2") { "tar.bz2" } else { "bz2" });
    }
    if n.ends_with(".tar") {
        return Ok("tar");
    }
    Err("notArchive".to_string())
}
pub fn is_tar(file: &Path) -> bool {
    lower_name(file).ends_with(".tar")
}
fn with_suffix(file: &Path, suffix: &str) -> PathBuf {
    let mut s = file.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}
pub fn journal_of(file: &Path) -> PathBuf {
    with_suffix(file, ".kurokawa-unzip")
}
pub fn tail_of(file: &Path) -> PathBuf {
    with_suffix(file, ".kurokawa-tail")
}
pub fn has_journal(file: &Path) -> bool {
    journal_of(file).exists()
}

/* ---------- the journal: {"version":1,"committed":N,"output":"…","length":N,"tailBase":N} ---------- */

pub fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}
/// A whole number kept under `"key":` in a journal (JSON.stringify's form).
pub fn json_num(text: &str, key: &str) -> Option<u64> {
    let k = format!("\"{}\":", key);
    let i = text.find(&k)? + k.len();
    let rest = text[i..].trim_start();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}
fn write_atomic(file: &Path, text: &str) -> Result<(), String> {
    let tmp = with_suffix(file, ".tmp");
    fs::write(&tmp, text).map_err(es)?;
    let _ = fs::remove_file(file);
    fs::rename(&tmp, file).map_err(es)
}
fn zip_journal(committed: u64, dest: &Path, length: u64, tail_base: u64) -> String {
    format!(
        "{{\"version\":1,\"committed\":{},\"output\":{},\"length\":{},\"tailBase\":{}}}",
        committed,
        json_str(&dest.to_string_lossy()),
        length,
        tail_base
    )
}
fn tar_journal(committed: u64, dest: &Path) -> String {
    format!("{{\"version\":1,\"format\":\"tar\",\"committed\":{},\"output\":{}}}", committed, json_str(&dest.to_string_lossy()))
}

/* ---------- reading at a place ---------- */

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

/// A file read as a part of a longer one: byte `base` of the whole is its first (a ZIP's directory kept apart).
pub struct Src {
    pub f: File,
    pub base: u64,
}
impl Src {
    pub fn open(p: &Path, base: u64) -> Result<Src, String> {
        Ok(Src { f: File::open(p).map_err(es)?, base })
    }
    fn length(&self) -> Result<u64, String> {
        Ok(self.base + self.f.metadata().map_err(es)?.len())
    }
    fn at(&mut self, pos: u64, buf: &mut [u8]) -> Result<(), String> {
        if pos < self.base {
            return Err("badZip".to_string());
        }
        self.f.seek(SeekFrom::Start(pos - self.base)).map_err(es)?;
        self.f.read_exact(buf).map_err(|e| if e.kind() == io::ErrorKind::UnexpectedEof { "badZip".to_string() } else { es(e) })
    }
}
fn read_at(f: &mut File, pos: u64, buf: &mut [u8]) -> Result<(), String> {
    f.seek(SeekFrom::Start(pos)).map_err(es)?;
    f.read_exact(buf).map_err(es)
}

/* ---------- ZIP: the central directory ---------- */

#[derive(Clone, Debug)]
pub struct ZipItem {
    pub name: String,
    pub method: u16,
    pub crc: u32,
    pub csize: u64,
    pub usize: u64,
    pub offset: u64,
    pub encrypted: bool,
    pub dir: bool,
    /// The record as it stands in the directory (written again by `restore`).
    pub raw: Vec<u8>,
}
pub struct ZipIndex {
    pub items: Vec<ZipItem>,
    pub cd_start: u64,
    pub length: u64,
}

fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| c as char).collect()
}

/// archive.cjs's readZip.
pub fn read_zip(src: &mut Src) -> Result<ZipIndex, String> {
    let length = src.length()?;
    let tail = (length - src.base).min(65557 + 22);
    if tail < 22 {
        return Err("notZip".to_string());
    }
    let mut buf = vec![0u8; tail as usize];
    src.at(length - tail, &mut buf)?;
    let mut eocd: Option<usize> = None;
    let mut i = tail as usize - 22;
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
    let e = eocd.ok_or_else(|| "notZip".to_string())?;
    let mut count = le16(&buf, e + 10);
    let mut cd_size = le32(&buf, e + 12);
    let mut cd_off = le32(&buf, e + 16);
    if (count == 0xffff || cd_off == 0xffff_ffff || cd_size == 0xffff_ffff) && e >= 20 && le32(&buf, e - 20) == 0x0706_4b50 {
        let z64 = le64(&buf, e - 12);
        let mut z = [0u8; 56];
        src.at(z64, &mut z)?;
        if le32(&z, 0) != 0x0606_4b50 {
            return Err("badZip64".to_string());
        }
        count = le64(&z, 32);
        cd_size = le64(&z, 40);
        cd_off = le64(&z, 48);
    }
    if cd_size > (1u64 << 30) || cd_off.checked_add(cd_size).map(|x| x > length).unwrap_or(true) {
        return Err("badCentralDirectory".to_string());
    }
    let mut cd = vec![0u8; cd_size as usize];
    src.at(cd_off, &mut cd)?;
    let mut items = Vec::new();
    let mut p = 0usize;
    let mut k = 0u64;
    while k < count && p + 46 <= cd.len() {
        if le32(&cd, p) != 0x0201_4b50 {
            return Err("badCentralDirectory".to_string());
        }
        let flags = le16(&cd, p + 8);
        let nl = le16(&cd, p + 28) as usize;
        let xl = le16(&cd, p + 30) as usize;
        let cl = le16(&cd, p + 32) as usize;
        let end = p + 46 + nl + xl + cl;
        if end > cd.len() {
            return Err("badCentralDirectory".to_string());
        }
        let nb = &cd[p + 46..p + 46 + nl];
        let name = if flags & 0x800 != 0 { String::from_utf8_lossy(nb).into_owned() } else { latin1(nb) }.replace('\\', "/");
        let mut it = ZipItem {
            name,
            method: le16(&cd, p + 10) as u16,
            crc: le32(&cd, p + 16) as u32,
            csize: le32(&cd, p + 20),
            usize: le32(&cd, p + 24),
            offset: le32(&cd, p + 42),
            encrypted: flags & 1 != 0,
            dir: false,
            raw: Vec::new(),
        };
        let mut xp = p + 46 + nl;
        let xe = xp + xl;
        while xp + 4 <= xe {
            let id = le16(&cd, xp);
            let sz = le16(&cd, xp + 2) as usize;
            if id == 1 {
                let mut q = xp + 4;
                let lim = (xp + 4 + sz).min(xe);
                if it.usize == 0xffff_ffff && q + 8 <= lim {
                    it.usize = le64(&cd, q);
                    q += 8;
                }
                if it.csize == 0xffff_ffff && q + 8 <= lim {
                    it.csize = le64(&cd, q);
                    q += 8;
                }
                if it.offset == 0xffff_ffff && q + 8 <= lim {
                    it.offset = le64(&cd, q);
                }
            }
            xp += 4 + sz;
        }
        it.raw = cd[p..end].to_vec();
        it.dir = it.name.ends_with('/');
        if !it.name.is_empty() {
            items.push(it);
        }
        p = end;
        k += 1;
    }
    Ok(ZipIndex { items, cd_start: cd_off, length })
}

fn data_start(f: &mut File, it: &ZipItem) -> Result<u64, String> {
    let mut h = [0u8; 30];
    read_at(f, it.offset, &mut h).map_err(|_| format!("badLocalHeader {}", it.name))?;
    if le32(&h, 0) != 0x0403_4b50 {
        return Err(format!("badLocalHeader {}", it.name));
    }
    Ok(it.offset + 30 + le16(&h, 26) + le16(&h, 28))
}

/// Bytes passed on with their CRC kept, each counted to the job's progress; refused once the job is stopped.
struct Tick<'a, 'b, W: Write> {
    inner: W,
    crc: u32,
    pr: &'a Pr<'b>,
    done: &'a mut u64,
    total: u64,
    cur: &'a str,
}
impl<'a, 'b, W: Write> Write for Tick<'a, 'b, W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.pr.stopped() {
            return Err(stopped_io());
        }
        self.inner.write_all(buf)?;
        self.crc = crc_update(self.crc, buf);
        *self.done += buf.len() as u64;
        self.pr.tell(*self.done, self.total, self.cur);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// One entry's bytes decoded into `sink`, checked against its CRC → error text on a failure.
fn decode_entry<W: Write>(f: &mut File, it: &ZipItem, sink: W, ctx: &Ctx, pr: &Pr, done: &mut u64, total: u64) -> Result<(), String> {
    let start = data_start(f, it)?;
    f.seek(SeekFrom::Start(start)).map_err(es)?;
    let mut src = (&mut *f).take(it.csize);
    let name = it.name.clone();
    let mut w = Tick { inner: sink, crc: 0xffff_ffff, pr, done, total, cur: &name };
    let r = match it.method {
        8 => ctx.codec.inflate(&mut src, &mut w),
        0 => io::copy(&mut src, &mut w),
        m => return Err(format!("unsupportedMethod {} {}", m, it.name)),
    };
    r.map_err(es)?;
    w.flush().map_err(es)?;
    if (w.crc ^ 0xffff_ffff) != it.crc {
        return Err(format!("crcMismatch {}", it.name));
    }
    Ok(())
}

/// archive.cjs's writeEntry: into `<out>.part`, checked, then put in place of `out`.
fn write_entry(f: &mut File, it: &ZipItem, out: &Path, ctx: &Ctx, pr: &Pr, done: &mut u64, total: u64) -> Result<(), String> {
    let part = with_suffix(out, ".part");
    let file = File::create(&part).map_err(es)?;
    let r = decode_entry(f, it, BufWriter::new(file), ctx, pr, done, total);
    if let Err(e) = r {
        let _ = fs::remove_file(&part);
        return Err(e);
    }
    let _ = fs::remove_file(out);
    fs::rename(&part, out).map_err(es)
}

fn extract_zip(file: &Path, dest: &Path, replace: &str, ctx: &Ctx, pr: &Pr) -> Result<u64, String> {
    let ix = read_zip(&mut Src::open(file, 0)?)?;
    let mut f = File::open(file).map_err(es)?;
    let total: u64 = ix.items.iter().map(|x| x.usize).sum();
    let mut done = 0u64;
    let mut n = 0u64;
    for it in ix.items.iter() {
        if pr.stopped() {
            return Err(STOPPED.to_string());
        }
        if it.dir {
            fs::create_dir_all(safe_join(dest, &it.name)?).map_err(es)?;
            continue;
        }
        let out = match target_for(dest, &it.name, replace)? {
            Some(o) => o,
            None => {
                done += it.usize;
                continue;
            }
        };
        pr.tell(done, total, &it.name);
        write_entry(&mut f, it, &out, ctx, pr, &mut done, total)?;
        n += 1;
    }
    pr.tell(total, total, "");
    Ok(n)
}

const BATCH_BYTES: u64 = 512 * 1024 * 1024;
const BATCH_COUNT: usize = 64;
const KEEP_FREE: u64 = 64 * 1024 * 1024;

fn sync_file(p: &Path) {
    if let Ok(h) = OpenOptions::new().read(true).write(true).open(p) {
        let _ = h.sync_all();
    }
}

fn zip_in_place(file: &Path, dest: &Path, o: &ExtractOpts, ctx: &Ctx, pr: &Pr) -> Result<u64, String> {
    let journal = journal_of(file);
    let tail = tail_of(file);
    let mut f = OpenOptions::new().read(true).write(true).open(file).map_err(es)?;
    let ix;
    let mut committed;
    let tail_base;
    if journal.exists() && tail.exists() {
        let j = fs::read_to_string(&journal).map_err(es)?;
        committed = json_num(&j, "committed").ok_or_else(|| "badJournal".to_string())?;
        tail_base = json_num(&j, "tailBase").unwrap_or(0);
        if f.metadata().map_err(es)?.len() > committed {
            f.set_len(committed).map_err(es)?;
        }
        let mut t = read_zip(&mut Src::open(&tail, tail_base)?)?;
        t.items.retain(|it| it.offset < committed);
        ix = t;
    } else {
        let t = read_zip(&mut Src::open(file, 0)?)?;
        committed = t.length;
        tail_base = t.cd_start;
        let mut cd = vec![0u8; (t.length - t.cd_start) as usize];
        read_at(&mut f, t.cd_start, &mut cd)?;
        fs::write(&tail, &cd).map_err(es)?;
        write_atomic(&journal, &zip_journal(committed, dest, t.length, tail_base))?;
        ix = t;
    }
    let mut items: Vec<ZipItem> = ix.items.clone();
    items.sort_by(|a, b| b.offset.cmp(&a.offset));
    let total: u64 = items.iter().map(|x| x.usize).sum();
    let mut done = 0u64;
    let mut n = 0u64;
    let keep = o.keep_free.unwrap_or(KEEP_FREE) as i128;
    let mut i = 0usize;
    while i < items.len() {
        if pr.stopped() {
            return Err(STOPPED.to_string());
        }
        let free = (ctx.free)(dest) as i128 - keep;
        let cap = free.min(BATCH_BYTES as i128);
        let mut used: i128 = 0;
        let mut end = i;
        while end < items.len() && end - i < BATCH_COUNT && (end == i || used + items[end].usize as i128 <= cap) {
            used += items[end].usize as i128;
            end += 1;
        }
        if items[i].usize as i128 > free {
            return Err("noSpace".to_string());
        }
        let mut written: Vec<PathBuf> = Vec::new();
        for it in items[i..end].iter() {
            if it.dir {
                fs::create_dir_all(safe_join(dest, &it.name)?).map_err(es)?;
                continue;
            }
            let out = match target_for(dest, &it.name, &o.replace)? {
                Some(x) => x,
                None => {
                    done += it.usize;
                    continue;
                }
            };
            pr.tell(done, total, &it.name);
            write_entry(&mut f, it, &out, ctx, pr, &mut done, total)?;
            written.push(out);
            n += 1;
        }
        for w in written.iter() {
            sync_file(w);
        }
        committed = items[end - 1].offset;
        write_atomic(&journal, &zip_journal(committed, dest, ix.length, tail_base))?;
        f.set_len(committed).map_err(es)?;
        let _ = f.sync_all();
        i = end;
    }
    pr.tell(total, total, "");
    drop(f);
    let _ = fs::remove_file(file);
    let _ = fs::remove_file(&tail);
    let _ = fs::remove_file(&journal);
    Ok(n)
}

/* ---------- tar ---------- */

#[derive(Clone, Debug)]
pub struct TarItem {
    pub name: String,
    /// Where its headers begin (a long name's included): the archive is cut here once it is out.
    pub head: u64,
    pub data: u64,
    pub size: u64,
    pub kind: char,
}

fn cstr(b: &[u8], o: usize, l: usize) -> String {
    let s = &b[o..o + l];
    let e = s.iter().position(|&x| x == 0).unwrap_or(l);
    String::from_utf8_lossy(&s[..e]).into_owned()
}
fn octal(b: &[u8], o: usize, l: usize) -> u64 {
    if b[o] & 0x80 != 0 {
        let mut v: u64 = 0;
        for &x in &b[o + 1..o + l] {
            v = v.wrapping_shl(8) | x as u64;
        }
        return v;
    }
    let s = cstr(b, o, l);
    let s = s.trim();
    let d: String = s.chars().take_while(|c| ('0'..='7').contains(c)).collect();
    u64::from_str_radix(&d, 8).unwrap_or(0)
}

/// archive.cjs's scanTar.
pub fn scan_tar(f: &mut File) -> Result<Vec<TarItem>, String> {
    let len = f.metadata().map_err(es)?.len();
    let mut out = Vec::new();
    let mut h = [0u8; 512];
    let mut pos = 0u64;
    let mut long: Option<String> = None;
    let mut group: Option<u64> = None;
    while pos + 512 <= len {
        read_at(f, pos, &mut h)?;
        if h.iter().all(|&x| x == 0) {
            break;
        }
        if group.is_none() {
            group = Some(pos);
        }
        let mut name = cstr(&h, 0, 100);
        let size = octal(&h, 124, 12);
        let kind = if h[156] != 0 { h[156] as char } else { '0' };
        if cstr(&h, 257, 6).starts_with("ustar") {
            let pre = cstr(&h, 345, 155);
            if !pre.is_empty() {
                name = format!("{}/{}", pre, name);
            }
        }
        let data = pos + 512;
        let next = data + size.div_ceil(512) * 512;
        if kind == 'L' || kind == 'x' {
            if size > 1 << 20 {
                return Err("badTar".to_string());
            }
            let mut b = vec![0u8; size as usize];
            read_at(f, data, &mut b)?;
            let t = String::from_utf8_lossy(&b).into_owned();
            if kind == 'L' {
                long = Some(t.trim_end_matches('\0').to_string());
            } else {
                for rec in t.split('\n') {
                    if let Some(i) = rec.find(" path=") {
                        if i > 0 {
                            long = Some(rec[i + 6..].to_string());
                        }
                    }
                }
            }
            pos = next;
            continue;
        }
        if kind == 'g' {
            pos = next;
            continue;
        }
        let n = long.take().unwrap_or(name);
        let n = n.strip_prefix("./").map(|x| x.to_string()).unwrap_or(n);
        out.push(TarItem { name: n, head: group.unwrap_or(pos), data, size, kind });
        group = None;
        pos = next;
    }
    out.retain(|x| !x.name.is_empty() && x.name != ".");
    Ok(out)
}

fn tar_in_place(file: &Path, dest: &Path, o: &ExtractOpts, ctx: &Ctx, pr: &Pr) -> Result<u64, String> {
    let journal = journal_of(file);
    let mut f = OpenOptions::new().read(true).write(true).open(file).map_err(es)?;
    if journal.exists() {
        let j = fs::read_to_string(&journal).map_err(es)?;
        let c = json_num(&j, "committed").ok_or_else(|| "badJournal".to_string())?;
        if f.metadata().map_err(es)?.len() > c {
            f.set_len(c).map_err(es)?;
        }
    } else {
        let len = f.metadata().map_err(es)?.len();
        write_atomic(&journal, &tar_journal(len, dest))?;
    }
    let items = scan_tar(&mut f)?;
    let total: u64 = items.iter().map(|x| x.size).sum();
    let mut done = 0u64;
    let mut n = 0u64;
    for it in items.iter() {
        if unsafe_name(&it.name) {
            return Err(format!("unsafePath {}", it.name));
        }
    }
    let keep = o.keep_free.unwrap_or(KEEP_FREE) as i128;
    for it in items.iter().rev() {
        if pr.stopped() {
            return Err(STOPPED.to_string());
        }
        if it.kind == '5' {
            fs::create_dir_all(safe_join(dest, &it.name)?).map_err(es)?;
        } else if it.kind == '0' || it.kind == '7' {
            if it.size as i128 > (ctx.free)(dest) as i128 - keep {
                return Err("noSpace".to_string());
            }
            if let Some(out) = target_for(dest, &it.name, &o.replace)? {
                pr.tell(done, total, &it.name);
                let part = with_suffix(&out, ".part");
                let r = (|| -> Result<(), String> {
                    f.seek(SeekFrom::Start(it.data)).map_err(es)?;
                    let mut src = (&mut f).take(it.size);
                    let mut w = File::create(&part).map_err(es)?;
                    let mut buf = vec![0u8; 1 << 16];
                    loop {
                        if pr.stopped() {
                            return Err(STOPPED.to_string());
                        }
                        let k = src.read(&mut buf).map_err(es)?;
                        if k == 0 {
                            break;
                        }
                        w.write_all(&buf[..k]).map_err(es)?;
                    }
                    let _ = w.sync_all();
                    Ok(())
                })();
                if let Err(e) = r {
                    let _ = fs::remove_file(&part);
                    return Err(e);
                }
                let _ = fs::remove_file(&out);
                fs::rename(&part, &out).map_err(es)?;
                n += 1;
            }
        }
        done += it.size;
        write_atomic(&journal, &tar_journal(it.head, dest))?;
        f.set_len(it.head).map_err(es)?;
        let _ = f.sync_all();
    }
    pr.tell(total, total, "");
    drop(f);
    let _ = fs::remove_file(file);
    let _ = fs::remove_file(&journal);
    Ok(n)
}

/* ---------- 7-Zip ---------- */

/// 7-Zip's place in 7zip-bin's layout (`<plat>/<arch>/7za`), Node's names: win / mac / linux.
pub fn seven_rel(node_platform: &str, node_arch: &str) -> PathBuf {
    let plat = match node_platform {
        "win32" => "win",
        "darwin" => "mac",
        _ => "linux",
    };
    let exe = if node_platform == "win32" { "7za.exe" } else { "7za" };
    PathBuf::from(plat).join(node_arch).join(exe)
}

/// A line of 7-Zip's output: `-sccUTF-8` on Windows (the console's code page otherwise).
fn seven_base_args() -> Vec<String> {
    if cfg!(windows) {
        vec!["-sccUTF-8".to_string()]
    } else {
        Vec::new()
    }
}

/// The output 7-Zip writes, cut into lines at returns, new lines and backspaces (its progress rewrites itself).
pub fn split_lines(s: &str) -> Vec<String> {
    s.split(|c| c == '\r' || c == '\n' || c == '\u{8}').map(|x| x.to_string()).filter(|x| !x.trim().is_empty()).collect()
}

/// archive.cjs's progress line, `/^\s*(\d+)%(?:\s+\d+)?\s*(?:- (.*))?$/` → (percent, file).
pub fn parse_progress(line: &str) -> Option<(u64, String)> {
    let s = line.trim_start();
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let mut rest = s[digits.len()..].strip_prefix('%')?;
    // (?:\s+\d+)?
    let ws = rest.len() - rest.trim_start().len();
    if ws > 0 {
        let after = rest.trim_start();
        let d2: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !d2.is_empty() {
            rest = &after[d2.len()..];
        }
    }
    let rest = rest.trim_start();
    let file = if rest.is_empty() {
        String::new()
    } else if let Some(f) = rest.strip_prefix("- ") {
        f.to_string()
    } else {
        return None;
    };
    Some((digits.parse().ok()?, file))
}

#[derive(Default, Debug, Clone)]
pub struct SltEntry {
    pub path: String,
    pub size: u64,
    pub compressed: Option<u64>,
    pub dir: bool,
    pub link: Option<String>,
}
/// `7z l -slt -ba`'s records, as archive.cjs reads them (`Key = value` lines; any other ends the entry) → the entries
/// and whether one is encrypted. Links (`Symbolic Link`, `Hard Link`) noted.
pub fn parse_slt(out: &str) -> (Vec<SltEntry>, bool) {
    let mut entries = Vec::new();
    let mut cur: Option<SltEntry> = None;
    let mut encrypted = false;
    for line in out.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let kv = line.find(" = ").and_then(|i| {
            let k = &line[..i];
            let ok = k.chars().next().map(|c| c.is_alphanumeric() || c == '_').unwrap_or(false) && k.chars().all(|c| c.is_alphanumeric() || c == '_' || c == ' ');
            if ok {
                Some((k, &line[i + 3..]))
            } else {
                None
            }
        });
        let (k, v) = match kv {
            Some(x) => x,
            None => {
                if let Some(c) = cur.take() {
                    entries.push(c);
                }
                continue;
            }
        };
        if k == "Path" {
            if let Some(c) = cur.take() {
                entries.push(c);
            }
            cur = Some(SltEntry { path: v.replace('\\', "/"), ..Default::default() });
            continue;
        }
        let c = match cur.as_mut() {
            Some(c) => c,
            None => continue,
        };
        match k {
            "Size" => c.size = v.trim().parse().unwrap_or(0),
            "Packed Size" if !v.is_empty() => c.compressed = v.trim().parse().ok(),
            "Folder" | "Attributes" => {
                if v == "+" || v.starts_with('D') {
                    c.dir = true;
                }
            }
            "Encrypted" if v == "+" => encrypted = true,
            "Symbolic Link" | "Hard Link" | "Link" if !v.is_empty() => c.link = Some(v.to_string()),
            _ => {}
        }
    }
    if let Some(c) = cur {
        entries.push(c);
    }
    (entries, encrypted)
}

#[cfg(windows)]
fn no_window(c: &mut Command) {
    use std::os::windows::process::CommandExt;
    c.creation_flags(0x0800_0000);
}
#[cfg(not(windows))]
fn no_window(_c: &mut Command) {}

/// A shipped 7-Zip that lost its executable bit on the way (a copy, an unzip) given it back, where it can be.
#[cfg(unix)]
pub fn ensure_exec(p: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(md) = fs::metadata(p) {
        let mode = md.permissions().mode();
        if mode & 0o111 == 0 {
            let mut perm = md.permissions();
            perm.set_mode(mode | 0o755);
            let _ = fs::set_permissions(p, perm);
        }
    }
}
#[cfg(not(unix))]
pub fn ensure_exec(_p: &Path) {}

pub struct Ran {
    pub code: Option<i32>,
    pub out: String,
    pub err: String,
}

/// 7-Zip run with `args` (no shell, stdin closed); each output line to `on_line`; ended when the job is stopped or
/// after `limit` (then «stopped» / «7z timed out»).
pub fn run7z(seven: &Path, args: &[String], stop: Option<&AtomicBool>, limit: Option<Duration>, on_line: &mut dyn FnMut(&str)) -> Result<Ran, String> {
    let mut all = seven_base_args();
    all.extend(args.iter().cloned());
    let mut cmd = Command::new(seven);
    cmd.args(&all).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("7z could not start: {}", e))?;
    let mut so = child.stdout.take().ok_or_else(|| "7z: no output".to_string())?;
    let mut se = child.stderr.take().ok_or_else(|| "7z: no output".to_string())?;
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let t_out = std::thread::spawn(move || {
        let mut buf = vec![0u8; 8192];
        loop {
            match so.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let t_err = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = se.read_to_end(&mut v);
        v
    });
    let started = Instant::now();
    let mut out: Vec<u8> = Vec::new();
    let mut pending = String::new();
    let mut ended: Option<&str> = None;
    let feed = |chunk: &[u8], pending: &mut String, on_line: &mut dyn FnMut(&str)| {
        pending.push_str(&String::from_utf8_lossy(chunk));
        // (Whole lines only; the rest waits for its end.)
        let cut = pending.rfind(|c| c == '\r' || c == '\n' || c == '\u{8}');
        if let Some(i) = cut {
            let done: String = pending[..=i].to_string();
            *pending = pending[i + 1..].to_string();
            for l in split_lines(&done) {
                on_line(&l);
            }
        }
    };
    let status = loop {
        while let Ok(chunk) = rx.try_recv() {
            out.extend_from_slice(&chunk);
            feed(&chunk, &mut pending, on_line);
        }
        if let Some(s) = stop {
            if s.load(Ordering::SeqCst) {
                let _ = child.kill();
                ended = Some(STOPPED);
            }
        }
        if let Some(l) = limit {
            if ended.is_none() && started.elapsed() > l {
                let _ = child.kill();
                ended = Some("7z timed out");
            }
        }
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(chunk) => {
                        out.extend_from_slice(&chunk);
                        feed(&chunk, &mut pending, on_line);
                    }
                    Err(_) => {}
                }
            }
            Err(_) => break None,
        }
    };
    let _ = t_out.join();
    while let Ok(chunk) = rx.try_recv() {
        out.extend_from_slice(&chunk);
        feed(&chunk, &mut pending, on_line);
    }
    if !pending.trim().is_empty() {
        on_line(pending.trim());
    }
    let err = t_err.join().unwrap_or_default();
    if let Some(e) = ended {
        return Err(e.to_string());
    }
    Ok(Ran {
        code: status.and_then(|s| s.code()),
        out: String::from_utf8_lossy(&out).into_owned(),
        err: String::from_utf8_lossy(&err).into_owned(),
    })
}

/// archive.cjs's rejection: the last line of what 7-Zip said (its errors), else `7z exit N`.
fn seven_error(r: &Ran) -> String {
    let src = if r.err.trim().is_empty() { &r.out } else { &r.err };
    src.trim().split('\n').last().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| format!("7z exit {}", r.code.unwrap_or(-1)))
}
fn seven_of(ctx: &Ctx) -> Result<PathBuf, String> {
    ctx.seven.clone().ok_or_else(|| "7z missing".to_string())
}
/// The password switch: `-p<password>`, or `-p` alone (an empty one — 7-Zip never stops to ask).
fn pw_arg(password: Option<&str>) -> String {
    match password {
        Some(p) if !p.is_empty() => format!("-p{}", p),
        _ => "-p".to_string(),
    }
}
fn path_arg(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn extract_7z(file: &Path, dest: &Path, o: &ExtractOpts, ctx: &Ctx, pr: &Pr, scale: (u64, u64)) -> Result<u64, String> {
    let seven = seven_of(ctx)?;
    let replace = match o.replace.as_str() {
        "skip" => "-aos",
        "both" => "-aou",
        _ => "-aoa",
    };
    let args = vec![
        "x".to_string(),
        "-y".to_string(),
        "-bsp1".to_string(),
        "-bb1".to_string(),
        format!("-o{}", dest.to_string_lossy()),
        replace.to_string(),
        pw_arg(o.password.as_deref()),
        path_arg(file),
    ];
    let mut n = 0u64;
    let (from, span) = scale;
    let mut on_line = |l: &str| {
        if let Some((pct, f)) = parse_progress(l) {
            pr.tell(from + pct * span / 100, 100, &f);
        }
        if l.starts_with("- ") {
            n += 1;
        }
    };
    let r = run7z(&seven, &args, Some(pr.stop), None, &mut on_line)?;
    if r.code != Some(0) {
        let all = format!("{}\n{}", r.err, r.out).to_lowercase();
        if all.contains("wrong password") {
            return Err("wrongPassword".to_string());
        }
        return Err(seven_error(&r));
    }
    pr.tell(from + span, 100, "");
    Ok(n)
}

/* ---------- listing ---------- */

#[derive(Debug, Clone)]
pub struct Entry {
    pub path: String,
    pub size: i64,
    pub compressed: Option<u64>,
    pub dir: bool,
}
#[derive(Debug, Clone)]
pub struct ListInfo {
    pub format: String,
    pub entries: Vec<Entry>,
    pub total: u64,
    pub encrypted: bool,
    pub in_place_ok: bool,
    pub resumable: bool,
    pub largest: u64,
    pub free: u64,
    pub unsafe_path: Option<String>,
    pub duplicate: Option<String>,
    pub sfv: Option<String>,
}

fn parent_dir(file: &Path) -> PathBuf {
    file.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."))
}

/// archive.cjs's list.
pub fn list(file: &Path, password: Option<&str>, ctx: &Ctx) -> Result<ListInfo, String> {
    let mut entries: Vec<Entry> = Vec::new();
    let mut total = 0u64;
    let mut encrypted = false;
    let mut bad_link: Option<String> = None;
    let format: String;
    if has_journal(file) && is_tar(file) {
        format = "tar".to_string();
        let mut f = File::open(file).map_err(es)?;
        for it in scan_tar(&mut f)? {
            total += it.size;
            entries.push(Entry { path: it.name, size: it.size as i64, compressed: None, dir: it.kind == '5' });
        }
    } else if has_journal(file) {
        format = "zip".to_string();
        let j = fs::read_to_string(journal_of(file)).map_err(es)?;
        let committed = json_num(&j, "committed").ok_or_else(|| "badJournal".to_string())?;
        let base = json_num(&j, "tailBase").unwrap_or(0);
        let ix = read_zip(&mut Src::open(&tail_of(file), base)?)?;
        for it in ix.items.into_iter().filter(|x| x.offset < committed) {
            total += it.usize;
            entries.push(Entry { path: it.name, size: it.usize as i64, compressed: Some(it.csize), dir: it.dir });
        }
    } else {
        let fmt = format_of(file)?;
        format = fmt.to_string();
        if fmt == "zip" {
            let ix = read_zip(&mut Src::open(file, 0)?)?;
            for it in ix.items.into_iter() {
                total += it.usize;
                encrypted |= it.encrypted;
                entries.push(Entry { path: it.name, size: it.usize as i64, compressed: Some(it.csize), dir: it.dir });
            }
        } else if fmt == "tar" {
            let mut f = File::open(file).map_err(es)?;
            for it in scan_tar(&mut f)? {
                total += it.size;
                if (it.kind == '2' || it.kind == '1') && bad_link.is_none() {
                    // (A link's target is in the header's linkname; read for the check below.)
                    let mut h = [0u8; 512];
                    let _ = read_at(&mut f, it.data - 512, &mut h);
                    let target = cstr(&h, 157, 100);
                    if !link_stays(&it.name, &target) {
                        bad_link = Some(it.name.clone());
                    }
                }
                entries.push(Entry { path: it.name, size: it.size as i64, compressed: None, dir: it.kind == '5' });
            }
        } else if fmt == "gz" || fmt == "xz" || fmt == "bz2" {
            let n = file.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let l = n.to_lowercase();
            let cut = [".gz", ".xz", ".bz2"].iter().find(|e| l.ends_with(*e)).map(|e| n.len() - e.len()).unwrap_or(n.len());
            entries.push(Entry { path: n[..cut].to_string(), size: -1, compressed: None, dir: false });
        } else {
            let seven = seven_of(ctx)?;
            let args = vec!["l".to_string(), "-slt".to_string(), "-ba".to_string(), pw_arg(password), path_arg(file)];
            let r = run7z(&seven, &args, None, Some(Duration::from_secs(600)), &mut |_l: &str| {})?;
            if r.code != Some(0) {
                // (An archive whose names are locked: «passwordNeeded» when none was given, «wrongPassword» when one
                // was — both say «password», which the page asks for again; archive.cjs gave 7-Zip's last line.)
                if format!("{}\n{}", r.err, r.out).to_lowercase().contains("password") {
                    return Err(if password.map(|p| !p.is_empty()).unwrap_or(false) { "wrongPassword" } else { "passwordNeeded" }.to_string());
                }
                return Err(seven_error(&r));
            }
            let (list, enc) = parse_slt(&r.out);
            encrypted = enc;
            for e in list {
                total += e.size;
                if let Some(t) = &e.link {
                    if bad_link.is_none() && !link_stays(&e.path, t) {
                        bad_link = Some(e.path.clone());
                    }
                }
                entries.push(Entry { path: e.path, size: e.size as i64, compressed: e.compressed, dir: e.dir });
            }
        }
    }
    let mut largest = 0u64;
    let mut seen = std::collections::HashSet::new();
    let mut duplicate = None;
    let mut bad = None;
    for e in entries.iter() {
        if !e.dir && e.size > 0 {
            largest = largest.max(e.size as u64);
        }
        if bad.is_none() && unsafe_name(&e.path) {
            bad = Some(e.path.clone());
        }
        if !e.dir {
            let k = e.path.to_lowercase();
            if !seen.insert(k) && duplicate.is_none() {
                duplicate = Some(e.path.clone());
            }
        }
    }
    if bad.is_none() {
        bad = bad_link;
    }
    let sfv = sfv_of(file).and_then(|p| p.file_name().map(|s| s.to_string_lossy().into_owned()));
    let resumable = has_journal(file);
    Ok(ListInfo {
        in_place_ok: (format == "zip" && !encrypted) || format == "tar",
        format,
        entries,
        total,
        encrypted,
        resumable,
        largest,
        free: (ctx.free)(&parent_dir(file)),
        unsafe_path: bad,
        duplicate,
        sfv,
    })
}

/* ---------- extracting ---------- */

#[derive(Debug, Clone, Default)]
pub struct ExtractOpts {
    pub in_place: bool,
    pub delete_after: bool,
    pub replace: String,
    pub password: Option<String>,
    pub verify_first: bool,
    pub keep_free: Option<u64>,
}

/// archive.cjs's extract → the files written.
pub fn extract(file: &Path, dest: &Path, o: &ExtractOpts, ctx: &Ctx, pr: &Pr) -> Result<u64, String> {
    fs::create_dir_all(dest).map_err(es)?;
    if has_journal(file) {
        return if is_tar(file) { tar_in_place(file, dest, o, ctx, pr) } else { zip_in_place(file, dest, o, ctx, pr) };
    }
    let fmt = format_of(file)?;
    // HatchZip's rules before anything is touched: a hostile archive refused, an .sfv beside it checked, and with
    // «verify first» every checksum read before the archive is cut.
    let info = list(file, o.password.as_deref(), ctx)?;
    if let Some(u) = info.unsafe_path {
        return Err(format!("unsafePath {}", u));
    }
    if o.in_place {
        if let Some(d) = info.duplicate {
            return Err(format!("duplicateEntry {}", d));
        }
    }
    if let Some(sfv) = sfv_of(file) {
        let c = check_sfv(&sfv, pr)?;
        if !c.1.is_empty() {
            return Err(format!("sfvMismatch {}", c.1.join(", ")));
        }
    }
    if o.verify_first && o.in_place && fmt == "zip" {
        let t = test(file, o.password.as_deref(), ctx, pr)?;
        if !t.bad.is_empty() {
            return Err(format!("damaged {}", t.bad.join(", ")));
        }
    }
    if o.in_place && fmt == "tar" {
        return tar_in_place(file, dest, o, ctx, pr);
    }
    let n;
    if fmt == "zip" {
        let enc = info.encrypted;
        n = if enc {
            extract_7z(file, dest, o, ctx, pr, (0, 100))?
        } else if o.in_place {
            zip_in_place(file, dest, o, ctx, pr)?
        } else {
            extract_zip(file, dest, &o.replace, ctx, pr)?
        };
    } else if fmt == "tar.gz" || fmt == "tar.xz" || fmt == "tar.bz2" {
        // Two layers: 7-Zip gives the inner tar first (into a folder of its own beside the files), then its files.
        let stem = file.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let tmp = dest.join(format!(".{}.kr-inner", stem));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).map_err(es)?;
        let r = (|| -> Result<u64, String> {
            let outer = ExtractOpts { replace: "replace".to_string(), ..o.clone() };
            extract_7z(file, &tmp, &outer, ctx, pr, (0, 50))?;
            let inner = fs::read_dir(&tmp)
                .map_err(es)?
                .flatten()
                .map(|e| e.path())
                .find(|p| p.is_file() && lower_name(p).ends_with(".tar"))
                .ok_or_else(|| "notArchive".to_string())?;
            // (The inner tar's names checked too: 7-Zip listed only the outer layer.)
            let mut f = File::open(&inner).map_err(es)?;
            for it in scan_tar(&mut f)? {
                if unsafe_name(&it.name) {
                    return Err(format!("unsafePath {}", it.name));
                }
            }
            drop(f);
            let info2 = list(&inner, None, ctx)?;
            if let Some(u) = info2.unsafe_path {
                return Err(format!("unsafePath {}", u));
            }
            extract_7z(&inner, dest, o, ctx, pr, (50, 50))
        })();
        let _ = fs::remove_dir_all(&tmp);
        n = r?;
    } else {
        n = extract_7z(file, dest, o, ctx, pr, (0, 100))?;
    }
    if o.delete_after && !o.in_place && !pr.stopped() {
        let _ = fs::remove_file(file);
    }
    Ok(n)
}

/* ---------- making a zip ---------- */

const STORED_EXT: [&str; 21] = [
    "png", "jpg", "jpeg", "gif", "webp", "avif", "mp4", "mkv", "webm", "mp3", "m4a", "ogg", "opus", "flac", "zip", "7z", "rar", "gz", "xz", "bz2", "apk",
];
/// archive.cjs's STORED: kinds that gain nothing by squeezing (and woff / woff2).
pub fn stored(name: &str) -> bool {
    let l = name.to_lowercase();
    let ext = match l.rfind('.') {
        Some(i) => &l[i + 1..],
        None => return false,
    };
    STORED_EXT.contains(&ext) || ext == "woff" || ext == "woff2"
}

/// UNIX seconds → (year, month, day, hour, minute, second), UTC.
pub fn civil(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d, (sod / 3600) as u32, ((sod % 3600) / 60) as u32, (sod % 60) as u32)
}
/// A DOS time and date (archive.cjs's `dos`), from UNIX seconds.
pub fn dos_time(secs: i64) -> (u16, u16) {
    let (y, m, d, h, mi, s) = civil(secs);
    let y = y.clamp(1980, 2107) as u32;
    let t = ((h << 11) | (mi << 5) | (s >> 1)) & 0xffff;
    let dt = (((y - 1980) << 9) | (m << 5) | d) & 0xffff;
    (t as u16, dt as u16)
}

fn walk(dir: &Path, prefix: &str, out: &mut Vec<(PathBuf, String)>) -> Result<(), String> {
    let mut list: Vec<fs::DirEntry> = fs::read_dir(dir).map_err(es)?.flatten().collect();
    list.sort_by_key(|e| e.file_name());
    for e in list {
        let name = e.file_name().to_string_lossy().into_owned();
        let ft = match e.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            walk(&e.path(), &format!("{}{}/", prefix, name), out)?;
        } else if ft.is_file() {
            out.push((e.path(), format!("{}{}", prefix, name)));
        }
    }
    Ok(())
}

struct Out {
    w: BufWriter<File>,
    pos: u64,
}
impl Write for Out {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.w.write(buf)?;
        self.pos += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.w.flush()
    }
}
/// What is read counted (CRC, size, the job's progress), refused once the job is stopped.
struct Counted<'a, 'b, R: Read> {
    inner: R,
    crc: u32,
    n: u64,
    pr: &'a Pr<'b>,
    done: &'a mut u64,
    total: u64,
    cur: &'a str,
}
impl<'a, 'b, R: Read> Read for Counted<'a, 'b, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pr.stopped() {
            return Err(stopped_io());
        }
        let k = self.inner.read(buf)?;
        self.crc = crc_update(self.crc, &buf[..k]);
        self.n += k as u64;
        *self.done += k as u64;
        self.pr.tell(*self.done, self.total, self.cur);
        Ok(k)
    }
}
struct Sizer<'a, W: Write> {
    inner: &'a mut W,
    n: u64,
}
impl<'a, W: Write> Write for Sizer<'a, W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let k = self.inner.write(buf)?;
        self.n += k as u64;
        Ok(k)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

struct Central {
    name: Vec<u8>,
    crc: u32,
    csize: u64,
    usize: u64,
    offset: u64,
    tm: u16,
    dt: u16,
    store: bool,
}

/// archive.cjs's createZip: `inputs` (files, and folders taken whole under their own name) → `out` (made as
/// `<out>.part`, then put in place) → the files in it.
pub fn create_zip(out: &Path, inputs: &[PathBuf], ctx: &Ctx, pr: &Pr) -> Result<u64, String> {
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    for i in inputs {
        let md = fs::metadata(i).map_err(es)?;
        let base = i.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        if md.is_dir() {
            walk(i, &format!("{}/", base), &mut files)?;
        } else {
            files.push((i.clone(), base));
        }
    }
    let mut total = 0u64;
    for (f, _) in files.iter() {
        total += fs::metadata(f).map_err(es)?.len();
    }
    let part = with_suffix(out, ".part");
    let r = (|| -> Result<(), String> {
        let mut w = Out { w: BufWriter::new(File::create(&part).map_err(es)?), pos: 0 };
        let mut central: Vec<Central> = Vec::new();
        let mut done = 0u64;
        for (f, name) in files.iter() {
            if pr.stopped() {
                return Err(STOPPED.to_string());
            }
            let md = fs::metadata(f).map_err(es)?;
            let secs = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(315_532_800);
            let (tm, dt) = dos_time(secs);
            let store = stored(name);
            let nb = name.as_bytes().to_vec();
            let mut h = [0u8; 30];
            h[0..4].copy_from_slice(&0x0403_4b50u32.to_le_bytes());
            h[4..6].copy_from_slice(&45u16.to_le_bytes());
            h[6..8].copy_from_slice(&0x808u16.to_le_bytes());
            h[8..10].copy_from_slice(&(if store { 0u16 } else { 8 }).to_le_bytes());
            h[10..12].copy_from_slice(&tm.to_le_bytes());
            h[12..14].copy_from_slice(&dt.to_le_bytes());
            h[26..28].copy_from_slice(&(nb.len() as u16).to_le_bytes());
            let offset = w.pos;
            w.write_all(&h).map_err(es)?;
            w.write_all(&nb).map_err(es)?;
            pr.tell(done, total, name);
            let src = File::open(f).map_err(es)?;
            let mut rd = Counted { inner: io::BufReader::with_capacity(1 << 16, src), crc: 0xffff_ffff, n: 0, pr, done: &mut done, total, cur: name };
            let mut sz = Sizer { inner: &mut w, n: 0 };
            if store {
                io::copy(&mut rd, &mut sz).map_err(es)?;
            } else {
                ctx.codec.deflate(&mut rd, &mut sz).map_err(es)?;
            }
            let csize = sz.n;
            let crc = rd.crc ^ 0xffff_ffff;
            let usize = rd.n;
            let mut dd = [0u8; 24];
            dd[0..4].copy_from_slice(&0x0807_4b50u32.to_le_bytes());
            dd[4..8].copy_from_slice(&crc.to_le_bytes());
            dd[8..16].copy_from_slice(&csize.to_le_bytes());
            dd[16..24].copy_from_slice(&usize.to_le_bytes());
            w.write_all(&dd).map_err(es)?;
            central.push(Central { name: nb, crc, csize, usize, offset, tm, dt, store });
        }
        let cd_start = w.pos;
        let mut cd: Vec<u8> = Vec::new();
        for c in central.iter() {
            let big = c.csize >= 0xffff_ffff || c.usize >= 0xffff_ffff || c.offset >= 0xffff_ffff;
            let mut extra: Vec<u8> = Vec::new();
            if big {
                extra.extend_from_slice(&1u16.to_le_bytes());
                extra.extend_from_slice(&24u16.to_le_bytes());
                extra.extend_from_slice(&c.usize.to_le_bytes());
                extra.extend_from_slice(&c.csize.to_le_bytes());
                extra.extend_from_slice(&c.offset.to_le_bytes());
            }
            let mut h = [0u8; 46];
            h[0..4].copy_from_slice(&0x0201_4b50u32.to_le_bytes());
            h[4..6].copy_from_slice(&45u16.to_le_bytes());
            h[6..8].copy_from_slice(&45u16.to_le_bytes());
            h[8..10].copy_from_slice(&0x808u16.to_le_bytes());
            h[10..12].copy_from_slice(&(if c.store { 0u16 } else { 8 }).to_le_bytes());
            h[12..14].copy_from_slice(&c.tm.to_le_bytes());
            h[14..16].copy_from_slice(&c.dt.to_le_bytes());
            h[16..20].copy_from_slice(&c.crc.to_le_bytes());
            h[20..24].copy_from_slice(&(if big { 0xffff_ffffu32 } else { c.csize as u32 }).to_le_bytes());
            h[24..28].copy_from_slice(&(if big { 0xffff_ffffu32 } else { c.usize as u32 }).to_le_bytes());
            h[28..30].copy_from_slice(&(c.name.len() as u16).to_le_bytes());
            h[30..32].copy_from_slice(&(extra.len() as u16).to_le_bytes());
            h[42..46].copy_from_slice(&(if big { 0xffff_ffffu32 } else { c.offset as u32 }).to_le_bytes());
            cd.extend_from_slice(&h);
            cd.extend_from_slice(&c.name);
            cd.extend_from_slice(&extra);
        }
        w.write_all(&cd).map_err(es)?;
        let cd_end = w.pos;
        let n = central.len() as u64;
        w.write_all(&end_records(n, cd.len() as u64, cd_start, cd_end, true)).map_err(es)?;
        w.flush().map_err(es)?;
        Ok(())
    })();
    if let Err(e) = r {
        let _ = fs::remove_file(&part);
        return Err(e);
    }
    let _ = fs::remove_file(out);
    fs::rename(&part, out).map_err(es)?;
    pr.tell(total, total, "");
    Ok(files.len() as u64)
}

/// The ZIP64 end record and its locator (when `z64`), then the end record.
fn end_records(count: u64, cd_len: u64, cd_start: u64, cd_end: u64, z64: bool) -> Vec<u8> {
    let mut v = Vec::new();
    if z64 {
        v.extend_from_slice(&0x0606_4b50u32.to_le_bytes());
        v.extend_from_slice(&44u64.to_le_bytes());
        v.extend_from_slice(&45u16.to_le_bytes());
        v.extend_from_slice(&45u16.to_le_bytes());
        v.extend_from_slice(&0u32.to_le_bytes());
        v.extend_from_slice(&0u32.to_le_bytes());
        v.extend_from_slice(&count.to_le_bytes());
        v.extend_from_slice(&count.to_le_bytes());
        v.extend_from_slice(&cd_len.to_le_bytes());
        v.extend_from_slice(&cd_start.to_le_bytes());
        v.extend_from_slice(&0x0706_4b50u32.to_le_bytes());
        v.extend_from_slice(&0u32.to_le_bytes());
        v.extend_from_slice(&cd_end.to_le_bytes());
        v.extend_from_slice(&1u32.to_le_bytes());
    }
    v.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    v.extend_from_slice(&0u16.to_le_bytes());
    v.extend_from_slice(&0u16.to_le_bytes());
    v.extend_from_slice(&(count.min(0xffff) as u16).to_le_bytes());
    v.extend_from_slice(&(count.min(0xffff) as u16).to_le_bytes());
    v.extend_from_slice(&(cd_len.min(0xffff_ffff) as u32).to_le_bytes());
    v.extend_from_slice(&(cd_start.min(0xffff_ffff) as u32).to_le_bytes());
    v.extend_from_slice(&0u16.to_le_bytes());
    v
}

/* ---------- HatchZip: test, restore, .sfv ---------- */

pub struct TestResult {
    pub ok: bool,
    pub files: u64,
    pub bad: Vec<String>,
}

/// archive.cjs's test: every file read and its checksum compared; nothing written.
pub fn test(file: &Path, password: Option<&str>, ctx: &Ctx, pr: &Pr) -> Result<TestResult, String> {
    let fmt = format_of(file)?;
    let mut bad: Vec<String> = Vec::new();
    let mut files = 0u64;
    if fmt == "zip" {
        let ix = read_zip(&mut Src::open(file, 0)?)?;
        if !ix.items.iter().any(|x| x.encrypted) {
            let mut f = File::open(file).map_err(es)?;
            let total: u64 = ix.items.iter().map(|x| x.usize).sum();
            let mut done = 0u64;
            for it in ix.items.iter() {
                if it.dir {
                    continue;
                }
                if pr.stopped() {
                    return Err(STOPPED.to_string());
                }
                pr.tell(done, total, &it.name);
                files += 1;
                match decode_entry(&mut f, it, io::sink(), ctx, pr, &mut done, total) {
                    Ok(()) => {}
                    Err(e) if e == STOPPED => return Err(e),
                    Err(_) => bad.push(it.name.clone()),
                }
            }
            pr.tell(total, total, "");
            return Ok(TestResult { ok: bad.is_empty(), files, bad });
        }
    }
    // 7-Zip tests the rest (and encrypted zips): every file decoded, its checksum compared.
    let seven = seven_of(ctx)?;
    let args = vec!["t".to_string(), "-bb1".to_string(), pw_arg(password), path_arg(file)];
    match run7z(&seven, &args, Some(pr.stop), None, &mut |_l: &str| {}) {
        Ok(r) if r.code == Some(0) => files = r.out.split('\n').filter(|l| l.starts_with("T ")).count() as u64,
        Ok(r) => bad.push(seven_error(&r)),
        Err(e) if e == STOPPED => return Err(e),
        Err(e) => bad.push(e),
    }
    Ok(TestResult { ok: bad.is_empty(), files, bad })
}

/// archive.cjs's restore: an extraction in place given up — what is left becomes a normal ZIP again (the remaining
/// entries' directory records written after them, then the end records); a cut tar is a valid tar already (-1).
pub fn restore(file: &Path) -> Result<i64, String> {
    let journal = journal_of(file);
    let tail = tail_of(file);
    if !journal.exists() {
        return Err("nothingToRestore".to_string());
    }
    if is_tar(file) {
        let _ = fs::remove_file(&journal);
        return Ok(-1);
    }
    let j = fs::read_to_string(&journal).map_err(es)?;
    let committed = json_num(&j, "committed").ok_or_else(|| "badJournal".to_string())?;
    let base = json_num(&j, "tailBase").unwrap_or(0);
    let mut left: Vec<ZipItem> = read_zip(&mut Src::open(&tail, base)?)?.items.into_iter().filter(|x| x.offset < committed).collect();
    left.sort_by_key(|x| x.offset);
    let mut f = OpenOptions::new().read(true).write(true).open(file).map_err(es)?;
    if f.metadata().map_err(es)?.len() > committed {
        f.set_len(committed).map_err(es)?;
    }
    let mut cd: Vec<u8> = Vec::new();
    for x in left.iter() {
        cd.extend_from_slice(&x.raw);
    }
    let cd_start = committed;
    let cd_end = cd_start + cd.len() as u64;
    let z64 = left.len() >= 0xffff || cd_start >= 0xffff_ffff || cd.len() as u64 >= 0xffff_ffff;
    let mut all = cd.clone();
    all.extend_from_slice(&end_records(left.len() as u64, cd.len() as u64, cd_start, cd_end, z64));
    f.seek(SeekFrom::Start(committed)).map_err(es)?;
    f.write_all(&all).map_err(es)?;
    let _ = f.sync_all();
    drop(f);
    let _ = fs::remove_file(&journal);
    let _ = fs::remove_file(&tail);
    Ok(left.len() as i64)
}

fn strip_ci<'a>(s: &'a str, suffixes: &[&str]) -> Option<&'a str> {
    let l = s.to_lowercase();
    suffixes.iter().find(|x| l.ends_with(&x.to_lowercase())).map(|x| &s[..s.len() - x.len()])
}
/// `.001`-style: a dot and three digits at the end.
fn strip_num(s: &str) -> Option<&str> {
    let b = s.as_bytes();
    if b.len() >= 4 && b[b.len() - 4] == b'.' && b[b.len() - 3..].iter().all(|c| c.is_ascii_digit()) {
        Some(&s[..s.len() - 4])
    } else {
        None
    }
}
/// The names an .sfv beside the archive may have (archive.cjs's sfvOf).
pub fn sfv_names(n: &str) -> Vec<String> {
    let mut out = vec![format!("{}.sfv", n)];
    // n.replace(/\.(zip|7z|rar|tar)(\.\d{3})?$/i, '')
    let a = {
        let s = strip_num(n).unwrap_or(n);
        match strip_ci(s, &[".zip", ".7z", ".rar", ".tar"]) {
            Some(x) => x.to_string(),
            None => n.to_string(),
        }
    };
    out.push(format!("{}.sfv", a));
    // n.replace(/\.part\d+\.rar$|\.\d{3}$/i, '')
    let b = {
        let l = n.to_lowercase();
        let mut r = n.to_string();
        if l.ends_with(".rar") {
            let s = &n[..n.len() - 4];
            if let Some(i) = s.to_lowercase().rfind(".part") {
                let digits = &s[i + 5..];
                if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
                    r = s[..i].to_string();
                }
            }
        }
        if r == n {
            if let Some(x) = strip_num(n) {
                r = x.to_string();
            }
        }
        r
    };
    out.push(format!("{}.sfv", b));
    out
}
pub fn sfv_of(file: &Path) -> Option<PathBuf> {
    let dir = parent_dir(file);
    let n = file.file_name()?.to_string_lossy().into_owned();
    for c in sfv_names(&n) {
        let p = dir.join(&c);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}
/// An .sfv's lines → (name, CRC) (comments and lines without one passed by).
pub fn parse_sfv(text: &str) -> Vec<(String, u32)> {
    let mut out = Vec::new();
    for line in text.split('\n') {
        let line = line.trim();
        if line.is_empty() || line.starts_with(';') {
            continue;
        }
        let sp = match line.rfind(' ') {
            Some(i) => i,
            None => continue,
        };
        let name = line[..sp].trim().to_string();
        let hex: String = line[sp + 1..].chars().take_while(|c| c.is_ascii_hexdigit()).collect();
        if hex.is_empty() {
            continue;
        }
        let v = u64::from_str_radix(&hex[hex.len().saturating_sub(16)..], 16).unwrap_or(0) as u32;
        out.push((name, v));
    }
    out
}
/// Each file the .sfv names checked → (files, the bad ones).
pub fn check_sfv(sfv: &Path, pr: &Pr) -> Result<(u64, Vec<String>), String> {
    let text = latin1(&fs::read(sfv).map_err(es)?);
    let dir = parent_dir(sfv);
    let mut bad = Vec::new();
    let mut files = 0u64;
    for (name, want) in parse_sfv(&text) {
        files += 1;
        let p = dir.join(&name);
        let mut f = match File::open(&p) {
            Ok(f) if p.is_file() => f,
            _ => {
                bad.push(name);
                continue;
            }
        };
        let total = f.metadata().map(|m| m.len()).unwrap_or(0);
        let mut c = 0xffff_ffffu32;
        let mut done = 0u64;
        let mut buf = vec![0u8; 1 << 20];
        loop {
            if pr.stopped() {
                return Err(STOPPED.to_string());
            }
            let k = f.read(&mut buf).map_err(es)?;
            if k == 0 {
                break;
            }
            c = crc_update(c, &buf[..k]);
            done += k as u64;
            pr.tell(done, total, &name);
        }
        if (c ^ 0xffff_ffff) != want {
            bad.push(name);
        }
    }
    Ok((files, bad))
}

/// archive.cjs's existing: which of `names` are files in `dest` already (a name that would leave it: not counted).
pub fn existing(dest: &Path, names: &[String]) -> Vec<String> {
    names.iter().filter(|n| safe_join(dest, n).map(|p| p.is_file()).unwrap_or(false)).cloned().collect()
}
/// The folder itself or its nearest existing parent (kr:archive-free's walk up).
pub fn existing_parent(dir: &Path) -> PathBuf {
    let mut d = dir.to_path_buf();
    while !d.exists() {
        match d.parent() {
            Some(p) if p != d => d = p.to_path_buf(),
            _ => break,
        }
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Raw deflate made of stored blocks only — valid deflate any reader takes; decoded back here.
    struct Stored;
    impl Codec for Stored {
        fn inflate(&self, src: &mut dyn Read, dst: &mut dyn Write) -> io::Result<u64> {
            let mut n = 0u64;
            loop {
                let mut h = [0u8; 5];
                src.read_exact(&mut h)?;
                if h[0] & 0b110 != 0 {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "not stored"));
                }
                let len = u16::from_le_bytes([h[1], h[2]]) as usize;
                if u16::from_le_bytes([h[3], h[4]]) != !(len as u16) {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "bad block"));
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
        fn deflate(&self, src: &mut dyn Read, dst: &mut dyn Write) -> io::Result<u64> {
            let mut all = Vec::new();
            src.read_to_end(&mut all)?;
            let mut chunks: Vec<&[u8]> = all.chunks(65535).collect();
            if chunks.is_empty() {
                chunks.push(&[]);
            }
            let last = chunks.len() - 1;
            for (i, c) in chunks.iter().enumerate() {
                let len = c.len() as u16;
                dst.write_all(&[if i == last { 1 } else { 0 }])?;
                dst.write_all(&len.to_le_bytes())?;
                dst.write_all(&(!len).to_le_bytes())?;
                dst.write_all(c)?;
            }
            Ok(all.len() as u64)
        }
    }
    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kr-archive-{}-{}-{}", tag, std::process::id(), Instant::now().elapsed().as_nanos()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn plenty(_p: &Path) -> u64 {
        MAX_SAFE
    }
    fn ctx() -> Ctx<'static> {
        Ctx { codec: &Stored, seven: None, free: &plenty }
    }
    fn quiet(_d: u64, _t: u64, _f: &str) {}
    fn bytes(n: usize, k: u8) -> Vec<u8> {
        (0..n).map(|i| ((i * 31 + k as usize) % 251) as u8).collect()
    }
    /// A stored zip of `entries` (names as given: for the hostile ones).
    fn zip_store(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut cd = Vec::new();
        for (name, data) in entries {
            let off = out.len() as u32;
            let crc = crc32(data);
            let mut h = vec![0x50, 0x4b, 3, 4, 20, 0, 0, 8, 0, 0, 0, 0, 0, 0];
            h.extend_from_slice(&crc.to_le_bytes());
            h.extend_from_slice(&(data.len() as u32).to_le_bytes());
            h.extend_from_slice(&(data.len() as u32).to_le_bytes());
            h.extend_from_slice(&(name.len() as u16).to_le_bytes());
            h.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&h);
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(data);
            let mut c = vec![0x50, 0x4b, 1, 2, 20, 0, 20, 0, 0, 8, 0, 0, 0, 0, 0, 0];
            c.extend_from_slice(&crc.to_le_bytes());
            c.extend_from_slice(&(data.len() as u32).to_le_bytes());
            c.extend_from_slice(&(data.len() as u32).to_le_bytes());
            c.extend_from_slice(&(name.len() as u16).to_le_bytes());
            c.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            c.extend_from_slice(&off.to_le_bytes());
            c.extend_from_slice(name.as_bytes());
            cd.extend_from_slice(&c);
        }
        let start = out.len() as u64;
        out.extend_from_slice(&cd);
        out.extend_from_slice(&end_records(entries.len() as u64, cd.len() as u64, start, 0, false));
        out
    }

    #[test]
    fn crc() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn names() {
        for bad in ["/etc/passwd", "../x", "a/../../x", "a/..", "C:/x", "c:x", "a:stream", "a\\..\\b", "x\0y"] {
            assert!(unsafe_name(bad), "{}", bad);
            assert!(safe_join(Path::new("/d"), bad).is_err(), "{}", bad);
        }
        for good in ["a", "a/b.txt", "./a", "a/./b", "a..b", "..a", "ن/✓.txt"] {
            assert!(!unsafe_name(good), "{}", good);
            assert!(safe_join(Path::new("/d"), good).unwrap().starts_with("/d"));
        }
        assert!(safe_join(Path::new("/d"), "./").is_err());
        assert!(link_stays("a/b", "c"));
        assert!(link_stays("a/b", "../c"));
        assert!(!link_stays("a/b", "../../c"));
        assert!(!link_stays("b", "/etc"));
        assert!(!link_stays("b", "../x"));
        assert!(link_stays("a/b/c", "../../x"));
    }

    #[test]
    fn progress_lines() {
        assert_eq!(parse_progress(" 45% 3 - folder/a b.txt"), Some((45, "folder/a b.txt".to_string())));
        assert_eq!(parse_progress("100%"), Some((100, String::new())));
        assert_eq!(parse_progress("  7% - x"), Some((7, "x".to_string())));
        assert_eq!(parse_progress("12%  9"), Some((12, String::new())));
        assert_eq!(parse_progress("- a.txt"), None);
        assert_eq!(parse_progress("Everything is Ok"), None);
        assert_eq!(parse_progress("5% x"), None);
        assert_eq!(split_lines("a\r\n 1%\u{8}\u{8}\u{8}\u{8}  2% - b\n"), vec!["a", " 1%", "  2% - b"]);
    }

    #[test]
    fn slt() {
        // (As `7z l -slt -ba` writes it — a 7z with a folder, a file and a tar-style link.)
        let out = "Path = docs\r\nSize = 0\r\nPacked Size = 0\r\nModified = 2024-05-01 10:00:00\r\nAttributes = D_ drwxr-xr-x\r\nCRC = \r\nEncrypted = -\r\nMethod = \r\nBlock = \r\n\r\nPath = docs\\book ✓.epub\r\nSize = 12345\r\nPacked Size = 6789\r\nModified = 2024-05-01 10:00:00\r\nAttributes = A_ -rw-r--r--\r\nCRC = 1A2B3C4D\r\nEncrypted = +\r\nMethod = LZMA2:24 7zAES\r\nBlock = 0\r\n\r\nPath = docs/link\r\nFolder = -\r\nSize = 0\r\nSymbolic Link = ../../etc\r\n\r\n";
        let (e, enc) = parse_slt(out);
        assert!(enc);
        assert_eq!(e.len(), 3);
        assert_eq!((e[0].path.as_str(), e[0].dir), ("docs", true));
        assert_eq!((e[1].path.as_str(), e[1].size, e[1].compressed, e[1].dir), ("docs/book ✓.epub", 12345, Some(6789), false));
        assert_eq!(e[2].link.as_deref(), Some("../../etc"));
        assert!(!link_stays(&e[2].path, e[2].link.as_ref().unwrap()));
        // (A folder by «Folder = +»; «Packed Size» empty; lines before any Path passed by.)
        let (e, enc) = parse_slt("Type = 7z\nPath = a\nFolder = +\nPacked Size = \n\nPath = b\nSize = 3\n");
        assert!(!enc);
        assert_eq!(e.len(), 2);
        assert!(e[0].dir && e[0].compressed.is_none());
        assert_eq!(e[1].size, 3);
    }

    #[test]
    fn sfv_rules() {
        assert_eq!(sfv_names("a.zip"), vec!["a.zip.sfv", "a.sfv", "a.zip.sfv"]);
        assert_eq!(sfv_names("a.7z.001"), vec!["a.7z.001.sfv", "a.sfv", "a.7z.sfv"]);
        assert_eq!(sfv_names("Set.part01.rar"), vec!["Set.part01.rar.sfv", "Set.part01.sfv", "Set.sfv"]);
        assert_eq!(parse_sfv("; made by x\r\nbook one.epub 1a2B3c4D\r\n\r\nno-crc\nbad zz\n"), vec![("book one.epub".to_string(), 0x1a2b3c4d)]);
    }

    #[test]
    fn journal_text() {
        let j = zip_journal(1234, Path::new("C:\\a \"b\""), 99999, 77);
        assert_eq!(json_num(&j, "committed"), Some(1234));
        assert_eq!(json_num(&j, "length"), Some(99999));
        assert_eq!(json_num(&j, "tailBase"), Some(77));
        assert!(j.contains("\"output\":\"C:\\\\a \\\"b\\\"\""));
        // (Electron's own journal: no tailBase.)
        assert_eq!(json_num("{\"version\":1,\"committed\":5,\"output\":\"/x\",\"length\":9}", "tailBase"), None);
    }

    #[test]
    fn dates() {
        assert_eq!(civil(0), (1970, 1, 1, 0, 0, 0));
        assert_eq!(civil(951_782_400), (2000, 2, 29, 0, 0, 0));
        assert_eq!(civil(1_700_000_000), (2023, 11, 14, 22, 13, 20));
        let (t, d) = dos_time(1_700_000_000);
        assert_eq!(d, ((2023 - 1980) << 9 | 11 << 5 | 14) as u16);
        assert_eq!(t, (22 << 11 | 13 << 5 | 10) as u16);
        assert_eq!(dos_time(0).1, (1 << 5 | 1) as u16);
    }

    #[test]
    fn formats() {
        let d = tmp("fmt");
        let w = |n: &str, b: &[u8]| {
            let p = d.join(n);
            fs::write(&p, b).unwrap();
            format_of(&p)
        };
        assert_eq!(w("a.bin", b"PK\x03\x04").unwrap(), "zip");
        assert_eq!(w("a.7z", &[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]).unwrap(), "7z");
        assert_eq!(w("a.tgz", &[0x1f, 0x8b, 8]).unwrap(), "tar.gz");
        assert_eq!(w("a.gz", &[0x1f, 0x8b, 8]).unwrap(), "gz");
        assert_eq!(w("a.TAR", b"x").unwrap(), "tar");
        assert_eq!(w("a.txt", b"hello").unwrap_err(), "notArchive");
        assert_eq!(w("e", b"").unwrap_err(), "notArchive");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn make_list_test_extract() {
        let d = tmp("round");
        let src = d.join("Book Folder");
        fs::create_dir_all(src.join("sub")).unwrap();
        let a = bytes(200_000, 1);
        let b = bytes(10, 2);
        fs::write(src.join("a.txt"), &a).unwrap();
        fs::write(src.join("sub").join("pic ✓.png"), &b).unwrap();
        let lone = d.join("lone.epub");
        fs::write(&lone, b"epub bytes").unwrap();
        let out = d.join("made.zip");
        let stop = AtomicBool::new(false);
        let seen = std::cell::Cell::new(0u64);
        let on = |dn: u64, _t: u64, _f: &str| seen.set(dn);
        let pr = Pr { on: &on, stop: &stop };
        assert_eq!(create_zip(&out, &[src.clone(), lone.clone()], &ctx(), &pr).unwrap(), 3);
        assert_eq!(seen.get(), (a.len() + b.len() + 10) as u64);
        assert!(!with_suffix(&out, ".part").exists());
        let pr = Pr { on: &quiet, stop: &stop };
        let info = list(&out, None, &ctx()).unwrap();
        assert_eq!(info.format, "zip");
        let names: Vec<&str> = info.entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(names, vec!["Book Folder/a.txt", "Book Folder/sub/pic ✓.png", "lone.epub"]);
        assert_eq!(info.total, (a.len() + b.len() + 10) as u64);
        assert_eq!(info.largest, a.len() as u64);
        assert!(info.in_place_ok && !info.encrypted && info.unsafe_path.is_none() && info.duplicate.is_none());
        let ix = read_zip(&mut Src::open(&out, 0).unwrap()).unwrap();
        assert_eq!(ix.items.iter().map(|x| x.method).collect::<Vec<_>>(), vec![8, 0, 8]);
        let t = test(&out, None, &ctx(), &pr).unwrap();
        assert!(t.ok && t.files == 3, "{:?}", t.bad);
        let dest = d.join("out");
        let o = ExtractOpts { replace: "both".to_string(), ..Default::default() };
        assert_eq!(extract(&out, &dest, &o, &ctx(), &pr).unwrap(), 3);
        assert_eq!(fs::read(dest.join("Book Folder").join("a.txt")).unwrap(), a);
        assert_eq!(fs::read(dest.join("Book Folder").join("sub").join("pic ✓.png")).unwrap(), b);
        // (Again: «both» keeps the first and puts the new one beside it; «skip» writes nothing.)
        assert_eq!(extract(&out, &dest, &o, &ctx(), &pr).unwrap(), 3);
        assert!(dest.join("lone (2).epub").is_file());
        let skip = ExtractOpts { replace: "skip".to_string(), ..Default::default() };
        assert_eq!(extract(&out, &dest, &skip, &ctx(), &pr).unwrap(), 0);
        assert_eq!(existing(&dest, &["lone.epub".to_string(), "nope".to_string(), "../made.zip".to_string()]), vec!["lone.epub".to_string()]);
        // (A damaged byte: test names it, extracting refuses it and leaves no part behind.)
        let mut z = fs::read(&out).unwrap();
        let at = ix.items[1].offset as usize + 30 + ix.items[1].name.len() + 3;
        z[at] ^= 0xff;
        let bad = d.join("bad.zip");
        fs::write(&bad, &z).unwrap();
        let t = test(&bad, None, &ctx(), &pr).unwrap();
        assert_eq!(t.bad, vec!["Book Folder/sub/pic ✓.png".to_string()]);
        let e = extract(&bad, &d.join("out2"), &o, &ctx(), &pr).unwrap_err();
        assert!(e.starts_with("crcMismatch "), "{}", e);
        assert!(!d.join("out2").join("Book Folder").join("sub").join("pic ✓.png.part").exists());
        // (Stopped: «stopped», the part file gone.)
        let stop2 = AtomicBool::new(true);
        let pr2 = Pr { on: &quiet, stop: &stop2 };
        assert_eq!(create_zip(&d.join("never.zip"), &[src.clone()], &ctx(), &pr2).unwrap_err(), "stopped");
        assert!(!d.join("never.zip.part").exists() && !d.join("never.zip").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn zip_slip_refused() {
        let d = tmp("slip");
        let stop = AtomicBool::new(false);
        let pr = Pr { on: &quiet, stop: &stop };
        for bad in ["../evil.txt", "/abs.txt", "ok/../../evil.txt", "C:/evil.txt"] {
            let z = d.join("hostile.zip");
            fs::write(&z, zip_store(&[("fine.txt", b"x"), (bad, b"pwned")])).unwrap();
            let info = list(&z, None, &ctx()).unwrap();
            assert_eq!(info.unsafe_path.as_deref(), Some(bad));
            let dest = d.join("dest");
            let e = extract(&z, &dest, &ExtractOpts { replace: "replace".to_string(), ..Default::default() }, &ctx(), &pr).unwrap_err();
            assert_eq!(e, format!("unsafePath {}", bad));
            assert!(!dest.join("fine.txt").exists(), "nothing written before the refusal");
            assert!(!d.join("evil.txt").exists());
        }
        // (Duplicates refuse an extraction in place only.)
        let z = d.join("dup.zip");
        fs::write(&z, zip_store(&[("A.txt", b"1"), ("a.txt", b"2")])).unwrap();
        assert_eq!(list(&z, None, &ctx()).unwrap().duplicate.as_deref(), Some("a.txt"));
        let e = extract(&z, &d.join("dd"), &ExtractOpts { in_place: true, replace: "replace".to_string(), ..Default::default() }, &ctx(), &pr).unwrap_err();
        assert_eq!(e, "duplicateEntry a.txt");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn in_place_stop_resume_restore() {
        let d = tmp("inplace");
        let names: Vec<String> = (0..5).map(|i| format!("f{}.bin", i)).collect();
        let datas: Vec<Vec<u8>> = (0..5).map(|i| bytes(3000 + i * 100, i as u8)).collect();
        let entries: Vec<(&str, &[u8])> = names.iter().zip(datas.iter()).map(|(n, b)| (n.as_str(), b.as_slice())).collect();
        let z = d.join("big.zip");
        fs::write(&z, zip_store(&entries)).unwrap();
        // (A disk that takes two files a batch: the archive is cut after each batch.)
        let tight = |_p: &Path| -> u64 { 64 * 1024 * 1024 + 6500 };
        let c = Ctx { codec: &Stored, seven: None, free: &tight };
        let stop = AtomicBool::new(false);
        let pr = Pr { on: &quiet, stop: &stop };
        let dest = d.join("out");
        // Stopped part-way through: the journal and the tail stay, the archive is shorter, the listing says resumable.
        let o = ExtractOpts { in_place: true, replace: "replace".to_string(), ..Default::default() };
        let flag = AtomicBool::new(false);
        let k = std::cell::Cell::new(0u32);
        let on2 = |_d: u64, _t: u64, f: &str| {
            if f == "f2.bin" {
                k.set(k.get() + 1);
            }
            if k.get() > 0 {
                flag.store(true, Ordering::SeqCst);
            }
        };
        let pr2 = Pr { on: &on2, stop: &flag };
        assert_eq!(extract(&z, &dest, &o, &c, &pr2).unwrap_err(), "stopped");
        assert!(journal_of(&z).exists() && tail_of(&z).exists());
        let cut = fs::metadata(&z).unwrap().len();
        assert!(cut < fs::metadata(tail_of(&z)).unwrap().len() + 20000);
        let info = list(&z, None, &c).unwrap();
        assert!(info.resumable);
        // (f4 alone in the first batch — f4 and f3 together would not fit —, then f3 and f2: stopped in f2, so that
        // batch is not committed and f3, though out, is still in the archive.)
        assert_eq!(info.entries.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), vec!["f0.bin", "f1.bin", "f2.bin", "f3.bin"]);
        assert!(dest.join("f4.bin").is_file() && dest.join("f3.bin").is_file() && !dest.join("f2.bin").exists());
        // «Give up»: what is left is a whole zip again, with the three not yet out.
        let backup = fs::read(&z).unwrap();
        let tail_copy = fs::read(tail_of(&z)).unwrap();
        let journal_copy = fs::read(journal_of(&z)).unwrap();
        assert_eq!(restore(&z).unwrap(), 4);
        let t = test(&z, None, &c, &pr).unwrap();
        assert!(t.ok && t.files == 4, "{:?}", t.bad);
        assert!(!journal_of(&z).exists());
        // Or resumed (the state as it was): the rest comes out, the archive and its journal go.
        fs::write(&z, &backup).unwrap();
        fs::write(tail_of(&z), &tail_copy).unwrap();
        fs::write(journal_of(&z), &journal_copy).unwrap();
        assert_eq!(extract(&z, &dest, &o, &c, &pr).unwrap(), 4);
        for (n, b) in names.iter().zip(datas.iter()) {
            assert_eq!(&fs::read(dest.join(n)).unwrap(), b, "{}", n);
        }
        assert!(!z.exists() && !journal_of(&z).exists() && !tail_of(&z).exists());
        // (Too little space even for one file: noSpace before anything changes.)
        let z2 = d.join("small.zip");
        fs::write(&z2, zip_store(&entries)).unwrap();
        let none = |_p: &Path| -> u64 { 64 * 1024 * 1024 };
        let c2 = Ctx { codec: &Stored, seven: None, free: &none };
        assert_eq!(extract(&z2, &d.join("o2"), &o, &c2, &pr).unwrap_err(), "noSpace");
        let _ = fs::remove_dir_all(&d);
    }

    fn tar_header(name: &str, size: usize, kind: u8, link: &str) -> Vec<u8> {
        let mut h = vec![0u8; 512];
        h[..name.len()].copy_from_slice(name.as_bytes());
        let sz = format!("{:011o}\0", size);
        h[124..136].copy_from_slice(sz.as_bytes());
        h[156] = kind;
        h[157..157 + link.len()].copy_from_slice(link.as_bytes());
        h[257..263].copy_from_slice(b"ustar\0");
        h
    }
    fn tar_of(items: &[(&str, &[u8], u8, &str)]) -> Vec<u8> {
        let mut out = Vec::new();
        for (n, b, k, l) in items {
            out.extend_from_slice(&tar_header(n, b.len(), *k, l));
            out.extend_from_slice(b);
            out.resize(out.len().div_ceil(512) * 512, 0);
        }
        out.extend_from_slice(&[0u8; 1024]);
        out
    }

    #[test]
    fn tar_in_place_and_links() {
        let d = tmp("tar");
        let a = bytes(700, 1);
        let b = bytes(1500, 2);
        let t = d.join("books.tar");
        fs::write(&t, tar_of(&[("dir/", b"", b'5', ""), ("dir/a.txt", &a, b'0', ""), ("b.txt", &b, b'0', "")])).unwrap();
        let mut f = File::open(&t).unwrap();
        let items = scan_tar(&mut f).unwrap();
        assert_eq!(items.iter().map(|x| (x.name.as_str(), x.size, x.kind)).collect::<Vec<_>>(), vec![("dir/", 0, '5'), ("dir/a.txt", 700, '0'), ("b.txt", 1500, '0')]);
        drop(f);
        let info = list(&t, None, &ctx()).unwrap();
        assert_eq!(info.format, "tar");
        assert!(info.in_place_ok);
        let stop = AtomicBool::new(false);
        let pr = Pr { on: &quiet, stop: &stop };
        let dest = d.join("out");
        assert_eq!(extract(&t, &dest, &ExtractOpts { in_place: true, replace: "replace".to_string(), ..Default::default() }, &ctx(), &pr).unwrap(), 2);
        assert_eq!(fs::read(dest.join("dir").join("a.txt")).unwrap(), a);
        assert_eq!(fs::read(dest.join("b.txt")).unwrap(), b);
        assert!(!t.exists() && !journal_of(&t).exists());
        // (A link out of the folder refuses the archive; a long name by GNU's «L».)
        let l = d.join("link.tar");
        fs::write(&l, tar_of(&[("x", b"", b'2', "../../etc/passwd")])).unwrap();
        assert_eq!(list(&l, None, &ctx()).unwrap().unsafe_path.as_deref(), Some("x"));
        let long = "n/".repeat(70) + "end.txt";
        let mut lb = long.clone().into_bytes();
        lb.push(0);
        let g = d.join("long.tar");
        fs::write(&g, tar_of(&[("././@LongLink", &lb, b'L', ""), ("short", b"zz", b'0', "")])).unwrap();
        let mut f = File::open(&g).unwrap();
        let items = scan_tar(&mut f).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, long);
        assert_eq!(items[0].head, 0);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn sfv_checked_before_extracting() {
        let d = tmp("sfv");
        let z = d.join("set.zip");
        fs::write(&z, zip_store(&[("a.txt", b"abc")])).unwrap();
        let crc = crc32(&fs::read(&z).unwrap());
        fs::write(d.join("set.sfv"), format!("; sfv\nset.zip {:08X}\n", crc)).unwrap();
        let stop = AtomicBool::new(false);
        let pr = Pr { on: &quiet, stop: &stop };
        assert_eq!(list(&z, None, &ctx()).unwrap().sfv.as_deref(), Some("set.sfv"));
        assert_eq!(extract(&z, &d.join("o"), &ExtractOpts { replace: "replace".to_string(), ..Default::default() }, &ctx(), &pr).unwrap(), 1);
        fs::write(d.join("set.sfv"), "set.zip 00000000\n").unwrap();
        assert_eq!(extract(&z, &d.join("o2"), &ExtractOpts { replace: "replace".to_string(), ..Default::default() }, &ctx(), &pr).unwrap_err(), "sfvMismatch set.zip");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn seven_needed() {
        let d = tmp("seven");
        let p = d.join("a.7z");
        fs::write(&p, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]).unwrap();
        assert_eq!(list(&p, None, &ctx()).unwrap_err(), "7z missing");
        assert_eq!(seven_rel("win32", "x64"), PathBuf::from("win").join("x64").join("7za.exe"));
        assert_eq!(seven_rel("darwin", "arm64"), PathBuf::from("mac").join("arm64").join("7za"));
        assert_eq!(seven_rel("linux", "x64"), PathBuf::from("linux").join("x64").join("7za"));
        assert_eq!(pw_arg(None), "-p");
        assert_eq!(pw_arg(Some("")), "-p");
        let _ = fs::remove_dir_all(&d);
    }
}
