// Torrent streaming's engine (stage P4), behind one small trait so the stream server (streamserver.rs) does not care
// which engine fetches the pieces:
//
// - `Aria2Stream` — works today with what the shell already ships: the download aria2 has is asked to fetch its
//   pieces in order, its head and tail first (desktop/torrentstream.cjs's options), and each read waits until aria2's
//   bitfield says the pieces under it are in, then reads the growing file from the disk. aria2 cannot jump to the
//   place the player seeks to (it has no «these pieces next» call): a seek far ahead waits until the in-order fetch
//   gets there — why Electron added WebTorrent, and why librqbit is planned.
// - `stream_rqbit.rs` — librqbit, compiled only with `--features rqbit` (off by default; see Cargo.toml and that
//   file for which parts of it are guesses).
// - the self-test's own engine (streamtest.rs), whose pieces the test lets in one by one.
//
// What one engine does: take a download up for watching (`add` → its files), `select` the file watched, `prioritise`
// the bytes the player reads now (where it can), `read_at` an offset (waiting for the pieces there, until the reader
// is gone), `stats` (speed, peers, progress, what of the file is in) and `stop` (the player closed).
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use kt_core::streamlogic as sl;

use crate::engine;

/// The download to watch, as the page names it (aria2's gid), and what is known of its torrent — for an engine that
/// takes the torrent over itself (librqbit), the .torrent's bytes or a magnet and the folder its files are in.
// (Read in full only by the librqbit engine, which a default build leaves out.)
#[cfg_attr(not(feature = "rqbit"), allow(dead_code))]
#[derive(Clone, Debug, Default)]
pub struct Source {
    pub id: String,
    pub info_hash: Option<String>,
    pub torrent: Option<Vec<u8>>,
    pub magnet: Option<String>,
    pub dir: String,
    /// aria2's status when it was taken up (paused stays paused when given back).
    pub status: String,
}

/// One file of the torrent: its place in the list (0-based), its name (the path inside the torrent), where it is on
/// the disk, its size.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileEntry {
    pub index: usize,
    pub name: String,
    pub path: String,
    pub size: u64,
}

pub trait StreamEngine: Send + Sync {
    /// For the log and the stats («aria2», «rqbit», «selftest»).
    fn name(&self) -> &'static str;
    /// The download taken up for watching → its files.
    fn add(&self, src: &Source) -> Result<Vec<FileEntry>, String>;
    /// The file the player opens (wanted, fetched in order where the engine can).
    fn select(&self, id: &str, index: usize) -> Result<(), String>;
    /// The file as it is now (its size may be known only once the metadata is in).
    fn file(&self, id: &str, index: usize) -> Result<FileEntry, String>;
    /// The player reads bytes from..=to of the file now: their pieces first, where the engine can.
    fn prioritise(&self, id: &str, index: usize, from: u64, to: u64);
    /// Up to `buf.len()` bytes of the file at `pos`, once their pieces are in — waited for until `gone()` (the reader
    /// left, the session ended): then Err. Ok(0) only at the file's end.
    fn read_at(&self, id: &str, index: usize, pos: u64, buf: &mut [u8], gone: &dyn Fn() -> bool) -> Result<usize, String>;
    /// { down, up, peers, progress, buffered: [[from, to]…], engine } — or None when the engine has no such download.
    fn stats(&self, id: &str, index: usize) -> Option<Value>;
    /// The player closed: the engine lets the download go (aria2's goes on as it was).
    fn stop(&self, id: &str);
}

/* ---------- aria2 ---------- */

const FIELDS: [&str; 13] = [
    "status",
    "files",
    "pieceLength",
    "numPieces",
    "bitfield",
    "totalLength",
    "completedLength",
    "dir",
    "downloadSpeed",
    "uploadSpeed",
    "connections",
    "infoHash",
    "bittorrent",
];

pub struct Aria2Stream {
    /// gid → (when, tellStatus) — asked at most every 400 ms whatever the number of readers (torrentstream.cjs's cache).
    cache: Mutex<HashMap<String, (Instant, Value)>>,
}

fn num(v: Option<&Value>) -> u64 {
    match v {
        Some(Value::String(s)) => s.trim().parse::<u64>().unwrap_or(0),
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0),
        _ => 0,
    }
}

fn text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

/// aria2's files as `place_of` takes them, and the entries.
fn files_of(st: &Value) -> (Vec<sl::PlaceIn>, Vec<FileEntry>) {
    let mut places = Vec::new();
    let mut entries = Vec::new();
    let dir = text(st.get("dir"));
    if let Some(Value::Array(fs)) = st.get("files") {
        for (i, f) in fs.iter().enumerate() {
            let index = text(f.get("index")).trim().parse::<i64>().ok();
            let length = num(f.get("length"));
            places.push(sl::PlaceIn { index, length });
            let path = text(f.get("path"));
            // (The name inside the torrent: the path under the download's folder, «/» between its parts.)
            let p = path.replace('\\', "/");
            let d = dir.replace('\\', "/");
            let name = match p.strip_prefix(d.trim_end_matches('/')) {
                Some(rest) if !d.is_empty() => rest.trim_start_matches('/').to_string(),
                _ => p.rsplit('/').next().unwrap_or("").to_string(),
            };
            entries.push(FileEntry { index: index.map(|k| (k - 1).max(0) as usize).unwrap_or(i), name, path, size: length });
        }
    }
    (places, entries)
}

impl Default for Aria2Stream {
    fn default() -> Self {
        Self::new()
    }
}

impl Aria2Stream {
    pub fn new() -> Aria2Stream {
        Aria2Stream { cache: Mutex::new(HashMap::new()) }
    }

    fn status(&self, gid: &str, fresh_ms: u64) -> Result<Value, String> {
        if let Ok(c) = self.cache.lock() {
            if let Some((at, st)) = c.get(gid) {
                if at.elapsed() < Duration::from_millis(fresh_ms) {
                    return Ok(st.clone());
                }
            }
        }
        let e = engine::get().ok_or_else(|| "engine".to_string())?;
        let st = e.call("tellStatus", vec![json!(gid), json!(FIELDS)])?;
        if let Ok(mut c) = self.cache.lock() {
            if c.len() > 20 {
                c.clear();
            }
            c.insert(gid.to_string(), (Instant::now(), st.clone()));
        }
        Ok(st)
    }
}

impl StreamEngine for Aria2Stream {
    fn name(&self) -> &'static str {
        "aria2"
    }

    fn add(&self, src: &Source) -> Result<Vec<FileEntry>, String> {
        let st = self.status(&src.id, 0)?;
        Ok(files_of(&st).1)
    }

    fn select(&self, id: &str, _index: usize) -> Result<(), String> {
        // (torrentstream.cjs's url(): not changeable now → as it was.)
        if let Some(e) = engine::get() {
            let mut o = serde_json::Map::new();
            for (k, v) in sl::STREAM_OPTIONS.iter() {
                o.insert(k.to_string(), json!(v));
            }
            let _ = e.call("changeOption", vec![json!(id), Value::Object(o)]);
        }
        Ok(())
    }

    fn file(&self, id: &str, index: usize) -> Result<FileEntry, String> {
        let st = self.status(id, 400)?;
        let (places, entries) = files_of(&st);
        match sl::place_of(&places, index) {
            Some((_, _, at)) => entries.get(at).cloned().ok_or_else(|| "no such file".to_string()),
            None => Err("no such file".to_string()),
        }
    }

    fn prioritise(&self, _id: &str, _index: usize, _from: u64, _to: u64) {
        // (aria2 has no call for it: its in-order fetch with the head and tail first is all it can do.)
    }

    fn read_at(&self, id: &str, index: usize, pos: u64, buf: &mut [u8], gone: &dyn Fn() -> bool) -> Result<usize, String> {
        loop {
            if gone() {
                return Err("gone".to_string());
            }
            let st = self.status(id, 400)?;
            let (places, entries) = files_of(&st);
            let (off, len, at) = sl::place_of(&places, index).ok_or_else(|| "no such file".to_string())?;
            if pos >= len {
                return Ok(0);
            }
            let n = (buf.len() as u64).min(len - pos);
            let status = text(st.get("status"));
            let done = sl::finished(&status, num(st.get("completedLength")), num(st.get("totalLength")));
            let (a, b) = sl::pieces_of(off, pos, n, num(st.get("pieceLength")));
            let bf = st.get("bitfield").and_then(|v| v.as_str());
            if done || sl::have(bf, a, b) {
                let path = entries.get(at).map(|e| e.path.clone()).unwrap_or_default();
                match read_file_at(Path::new(&path), pos, &mut buf[..n as usize]) {
                    Ok(got) if got > 0 => return Ok(got),
                    // (Not on the disk yet, or not as long yet: a moment later.)
                    _ => {}
                }
            } else if sl::stopped(&status) {
                return Err("download stopped".to_string());
            }
            thread::sleep(Duration::from_millis(200));
        }
    }

    fn stats(&self, id: &str, index: usize) -> Option<Value> {
        let st = self.status(id, 400).ok()?;
        let (places, _) = files_of(&st);
        let total = num(st.get("totalLength"));
        let done = num(st.get("completedLength"));
        let buffered: Vec<Value> = match sl::place_of(&places, index) {
            Some((off, len, _)) => sl::buffered(st.get("bitfield").and_then(|v| v.as_str()), off, len, num(st.get("pieceLength")), 64)
                .into_iter()
                .map(|(a, b)| json!([a, b]))
                .collect(),
            None => vec![],
        };
        Some(json!({
            "down": num(st.get("downloadSpeed")),
            "up": num(st.get("uploadSpeed")),
            "peers": num(st.get("connections")),
            "progress": if total > 0 { done as f64 / total as f64 } else { 0.0 },
            "buffered": buffered,
            "engine": "aria2",
        }))
    }

    fn stop(&self, id: &str) {
        if let Ok(mut c) = self.cache.lock() {
            c.remove(id);
        }
    }
}

/// Bytes of a file at `pos` (as many as are there, up to `buf.len()`), the file opened for this read only.
pub fn read_file_at(path: &Path, pos: u64, buf: &mut [u8]) -> std::io::Result<usize> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    f.seek(SeekFrom::Start(pos))?;
    let mut got = 0;
    while got < buf.len() {
        let k = f.read(&mut buf[got..])?;
        if k == 0 {
            break;
        }
        got += k;
    }
    Ok(got)
}

/// The Source of an aria2 download (desktop/main.cjs's watchUrl): its .torrent as the page added it, else the one aria2
/// saved beside the files (`<dir>/<hash>.torrent`, --bt-save-metadata), else a magnet of its hash and trackers.
pub fn source_of(id: &str) -> Result<Source, String> {
    let e = engine::get().ok_or_else(|| "engine".to_string())?;
    let st = e.call("tellStatus", vec![json!(id), json!(["gid", "status", "bittorrent", "infoHash", "files", "dir"])])?;
    let hash = text(st.get("infoHash")).to_ascii_lowercase();
    let dir = text(st.get("dir"));
    let mut src = Source { id: id.to_string(), info_hash: None, torrent: None, magnet: None, dir: dir.clone(), status: text(st.get("status")) };
    if st.get("bittorrent").is_none() || hash.is_empty() {
        return Ok(src);
    }
    src.info_hash = Some(hash.clone());
    let kept = e.kept(id);
    let kept_src = kept.as_ref().and_then(|k| k.get("source"));
    if let Some(t) = kept_src.and_then(|s| s.get("torrent")).and_then(|t| t.as_str()).filter(|t| !t.is_empty()) {
        src.torrent = Some(kurokawa_shell::util::b64_decode(t));
    } else {
        let saved = Path::new(&dir).join(format!("{}.torrent", hash));
        if let Ok(b) = std::fs::read(&saved) {
            src.torrent = Some(b);
        }
    }
    if src.torrent.is_none() {
        src.magnet = match kept_src.and_then(|s| s.get("magnet")).and_then(|m| m.as_str()).filter(|m| !m.is_empty()) {
            Some(m) => Some(m.to_string()),
            None => {
                let mut trackers: Vec<String> = Vec::new();
                if let Some(Value::Array(tiers)) = st.get("bittorrent").and_then(|b| b.get("announceList")) {
                    for tier in tiers {
                        if let Value::Array(us) = tier {
                            for u in us {
                                if let Some(s) = u.as_str() {
                                    trackers.push(s.to_string());
                                }
                            }
                        }
                    }
                }
                Some(sl::magnet_of(&hash, &trackers))
            }
        };
    }
    Ok(src)
}
