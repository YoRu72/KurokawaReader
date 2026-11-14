//! Torrent streaming and the local stream server: the pure rules (stage P4). desktop/torrentstream.cjs,
//! desktop/webstream.cjs and desktop/streamproxy.cjs answer the player's range requests, tell which of a download's
//! pieces are in (aria2's bitfield), and build ffmpeg's command lines; the parts of that which are plain data in, plain
//! data out are here, so the phone's torrent stage (M3) can take them too. std only; `rustc --edition 2021 --test
//! src/streamlogic.rs` runs the tests.
//!
//! - `span`: a `Range` header against a size → the whole file, a part, or «unsatisfiable» (Electron's reading of
//!   `bytes=(\d*)-(\d*)`, with its two holes closed: «500-100» and a size of 0).
//! - `stream_type` / `file_type`: Content-Type from the file name (webstream's table for torrents, streamproxy's for a
//!   file on this computer).
//! - `have` / `place_of` / `pieces_of`: aria2's bitfield and where a file lies among a torrent's bytes.
//! - `parse_head`, `split_target`, `query`, `decode_component`, `encode_component`: the request line, the path and the
//!   query as the server reads them (URLSearchParams' decoding: «+» is a space).
//! - `head_text`, `reason`: the answer's status line and headers.
//! - `new_token`, `same_token`: the per-run secret every address of the server carries.
//! - `remux_args`: streamproxy.cjs's HLS remux arguments, word for word. (The /audio and /video routes' arguments —
//!   streamproxy.cjs's audio(), transcode.cjs's — are kt-core's `videotools`, one copy for the stream server and the
//!   video tools.)
//! - `magnet_of`, `is_playlist`, `PROXY_UA`, `PASS_HEADERS`.
//! - `STREAM_OPTIONS`, `finished`, `stopped`, `buffered`: watching a download aria2 has (torrentstream.cjs).
//! - `Route`, `route`, `torrent_address`, `file_address`, `proxy_address`: the server's addresses, each under the run's
//!   token (and a torrent file's under its session's).

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};

/* ---------- ranges ---------- */

/// What a `Range` header asks of `size` bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Span {
    /// No range (or a size of 0): 200, all `len` bytes.
    Whole { len: u64 },
    /// 206 with `Content-Range: bytes from-to/size` (both ends included).
    Part { from: u64, to: u64, size: u64 },
    /// 416 with `Content-Range: bytes */size`.
    Unsatisfiable { size: u64 },
}

impl Span {
    /// The bytes to send: (first, count).
    pub fn bytes(&self) -> (u64, u64) {
        match *self {
            Span::Whole { len } => (0, len),
            Span::Part { from, to, .. } => (from, to - from + 1),
            Span::Unsatisfiable { .. } => (0, 0),
        }
    }
}

fn digits(s: &[u8]) -> (Option<u64>, usize) {
    let mut n: u64 = 0;
    let mut k = 0;
    while k < s.len() && s[k].is_ascii_digit() {
        n = n.saturating_mul(10).saturating_add((s[k] - b'0') as u64);
        k += 1;
    }
    (if k > 0 { Some(n) } else { None }, k)
}

/// The first `bytes=(\d*)-(\d*)` in the header, as JS's regex finds it: (start, end), each absent when empty.
pub fn range_parts(header: &str) -> Option<(Option<u64>, Option<u64>)> {
    let b = header.as_bytes();
    let mut i = 0;
    while let Some(p) = header[i..].find("bytes=") {
        let at = i + p + 6;
        let (a, la) = digits(&b[at..]);
        if b.get(at + la) == Some(&b'-') {
            let (z, _) = digits(&b[at + la + 1..]);
            return Some((a, z));
        }
        i = i + p + 1;
    }
    None
}

/// torrentstream.cjs / webstream.cjs / streamproxy.cjs's reading of a `Range` header: «a-b» (b clamped to the last
/// byte), «a-», «-n» (the last n bytes); a start at or past the end → 416. Unlike Electron: «500-100» is 416 (Electron
/// answered a negative length), and an empty file is always 200 with nothing.
pub fn span(header: Option<&str>, size: u64) -> Span {
    if size == 0 {
        return Span::Whole { len: 0 };
    }
    let (a, z) = match header.and_then(range_parts) {
        Some(p) => p,
        None => return Span::Whole { len: size },
    };
    let mut from = a.unwrap_or(0);
    let mut to = match z {
        Some(z) => z.min(size - 1),
        None => size - 1,
    };
    if a.is_none() {
        if let Some(n) = z {
            from = size.saturating_sub(n);
            to = size - 1;
            if n == 0 {
                return Span::Unsatisfiable { size };
            }
        }
    }
    if from >= size || from > to {
        return Span::Unsatisfiable { size };
    }
    Span::Part { from, to, size }
}

/* ---------- types ---------- */

fn ext_of(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    match base.rfind('.') {
        Some(i) if i > 0 || base.len() > 1 => base[i..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// webstream.cjs's TYPES (a torrent's file; Matroska named WebM, which Chromium then plays).
pub fn stream_type(name: &str) -> &'static str {
    match ext_of(name).as_str() {
        ".mp4" | ".m4v" => "video/mp4",
        ".mkv" | ".webm" => "video/webm",
        ".mov" => "video/quicktime",
        ".avi" => "video/x-msvideo",
        ".ts" => "video/mp2t",
        ".mp3" => "audio/mpeg",
        ".m4a" => "audio/mp4",
        ".flac" => "audio/flac",
        ".ogg" | ".opus" => "audio/ogg",
        ".wav" => "audio/wav",
        // (Not in Electron's table, which sent these as octet-stream; the player reads them as bytes either way.)
        ".srt" | ".ass" | ".ssa" => "text/plain; charset=utf-8",
        ".vtt" => "text/vtt",
        _ => "application/octet-stream",
    }
}

/// streamproxy.cjs's TYPES for a file on this computer (kt:fileUrl).
pub fn file_type(name: &str) -> &'static str {
    match ext_of(name).as_str() {
        ".mp4" | ".m4v" => "video/mp4",
        ".mkv" => "video/x-matroska",
        ".webm" => "video/webm",
        ".mov" => "video/quicktime",
        ".avi" => "video/x-msvideo",
        ".ts" => "video/mp2t",
        ".mp3" => "audio/mpeg",
        ".m4a" => "audio/mp4",
        ".flac" => "audio/flac",
        ".ogg" | ".opus" => "audio/ogg",
        ".wav" => "audio/wav",
        ".srt" | ".ass" => "text/plain; charset=utf-8",
        ".vtt" => "text/vtt",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".png" => "image/png",
        ".webp" => "image/webp",
        ".gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

/* ---------- aria2's pieces ---------- */

/// torrentstream.cjs's have(): pieces a..=b all in? aria2's bitfield is hex, the first piece in the highest bit.
pub fn have(bitfield: Option<&str>, a: u64, b: u64) -> bool {
    let bf = match bitfield {
        Some(s) if !s.is_empty() => s.as_bytes(),
        _ => return false,
    };
    if b < a {
        return true;
    }
    for i in a..=b {
        let nib = match bf.get((i >> 2) as usize) {
            Some(c) => (*c as char).to_digit(16).unwrap_or(0),
            None => 0,
        };
        if nib & (8 >> (i & 3)) == 0 {
            return false;
        }
    }
    true
}

/// How many pieces of the bitfield are in.
pub fn count_have(bitfield: Option<&str>, num_pieces: u64) -> u64 {
    let mut n = 0;
    for i in 0..num_pieces {
        if have(bitfield, i, i) {
            n += 1;
        }
    }
    n
}

/// The pieces (first, last) that hold bytes `pos .. pos+n` of a file lying at `file_off` in the download.
pub fn pieces_of(file_off: u64, pos: u64, n: u64, piece_len: u64) -> (u64, u64) {
    let pl = if piece_len == 0 { 1 << 20 } else { piece_len };
    let first = (file_off + pos) / pl;
    let last = (file_off + pos + n.max(1) - 1) / pl;
    (first, last)
}

/// One file of aria2's status: its 1-based `index` (when aria2 gave one) and its length.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaceIn {
    pub index: Option<i64>,
    pub length: u64,
}

/// torrentstream.cjs's placeOf(): where file `index` (0-based) starts among the download's bytes and its length —
/// a torrent's files one after another, the unselected ones too. → (offset, length, position in the list).
pub fn place_of(files: &[PlaceIn], index: usize) -> Option<(u64, u64, usize)> {
    let mut off = 0u64;
    for (i, f) in files.iter().enumerate() {
        let hit = match f.index {
            Some(k) => k - 1 == index as i64,
            None => i == index,
        };
        if hit {
            return Some((off, f.length, i));
        }
        off += f.length;
    }
    None
}

/* ---------- requests ---------- */

/// A request's first line and headers (names lowercased).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Head {
    pub method: String,
    pub target: String,
    pub headers: Vec<(String, String)>,
}

impl Head {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

/// Where the head ends in what was read (after «\r\n\r\n»), if it is all there.
pub fn head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
}

/// The request line and headers; None when it is not HTTP/1.x.
pub fn parse_head(raw: &[u8]) -> Option<Head> {
    let text = String::from_utf8_lossy(raw);
    let mut lines = text.split("\r\n");
    let first = lines.next()?;
    let mut parts = first.split(' ');
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let version = parts.next()?;
    if method.is_empty() || !version.starts_with("HTTP/1.") || !target.starts_with('/') {
        return None;
    }
    let mut headers = Vec::new();
    for l in lines {
        if l.is_empty() {
            break;
        }
        if let Some(c) = l.find(':') {
            headers.push((l[..c].trim().to_ascii_lowercase(), l[c + 1..].trim().to_string()));
        }
    }
    Some(Head { method, target, headers })
}

/// The target's path and query (without «?»).
pub fn split_target(target: &str) -> (&str, &str) {
    let t = match target.find('#') {
        Some(i) => &target[..i],
        None => target,
    };
    match t.find('?') {
        Some(i) => (&t[..i], &t[i + 1..]),
        None => (t, ""),
    }
}

fn hexval(c: u8) -> Option<u8> {
    (c as char).to_digit(16).map(|d| d as u8)
}

/// decodeURIComponent, lenient: a «%» not followed by two hex digits stays as it is; bytes that are no UTF-8 are
/// replaced. `plus` makes «+» a space (URLSearchParams).
pub fn decode_component(s: &str, plus: bool) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hexval(b[i + 1]), hexval(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        if plus && b[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(b[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// encodeURIComponent.
pub fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for &c in s.as_bytes() {
        let keep = c.is_ascii_alphanumeric()
            || matches!(c, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')');
        if keep {
            out.push(c as char);
        } else {
            out.push_str(&format!("%{:02X}", c));
        }
    }
    out
}

/// A query's pairs, decoded as URLSearchParams does.
pub fn query(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| match p.find('=') {
            Some(i) => (decode_component(&p[..i], true), decode_component(&p[i + 1..], true)),
            None => (decode_component(p, true), String::new()),
        })
        .collect()
}

/// URLSearchParams.get: the first value of `key`.
pub fn query_get(q: &str, key: &str) -> Option<String> {
    query(q).into_iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/* ---------- answers ---------- */

pub fn reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        204 => "No Content",
        206 => "Partial Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        416 => "Range Not Satisfiable",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

/// «HTTP/1.1 code reason» and the headers, ending with the empty line. Header values lose any CR/LF.
pub fn head_text(code: u16, headers: &[(String, String)]) -> String {
    let mut s = format!("HTTP/1.1 {} {}\r\n", code, reason(code));
    for (k, v) in headers {
        let v: String = v.chars().filter(|c| *c != '\r' && *c != '\n').collect();
        s.push_str(k);
        s.push_str(": ");
        s.push_str(&v);
        s.push_str("\r\n");
    }
    s.push_str("\r\n");
    s
}

/// The headers of a ranged answer (torrentstream.cjs's set, without the CORS ones the server adds to every answer).
pub fn range_headers(span: &Span, content_type: &str) -> (u16, Vec<(String, String)>) {
    match *span {
        Span::Unsatisfiable { size } => (416, vec![("Content-Range".into(), format!("bytes */{}", size)), ("Content-Length".into(), "0".into())]),
        Span::Whole { len } => (
            200,
            vec![
                ("Content-Type".into(), content_type.to_string()),
                ("Accept-Ranges".into(), "bytes".into()),
                ("Content-Length".into(), len.to_string()),
                ("Cache-Control".into(), "no-store".into()),
            ],
        ),
        Span::Part { from, to, size } => (
            206,
            vec![
                ("Content-Type".into(), content_type.to_string()),
                ("Accept-Ranges".into(), "bytes".into()),
                ("Content-Length".into(), (to - from + 1).to_string()),
                ("Content-Range".into(), format!("bytes {}-{}/{}", from, to, size)),
                ("Cache-Control".into(), "no-store".into()),
            ],
        ),
    }
}

/* ---------- the token ---------- */

/// 32 hex digits, from the OS's randomness (std's RandomState keys come from it) mixed with the time and the process.
/// A loopback server's run token, not a key for anything stored.
pub fn new_token() -> String {
    let mut out = String::new();
    for k in 0..2u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(k);
        h.write_u32(std::process::id());
        if let Ok(d) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
            h.write_u128(d.as_nanos());
        }
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

/// Equal tokens, compared in a time that does not depend on where they differ.
pub fn same_token(a: &str, b: &str) -> bool {
    let (x, y) = (a.as_bytes(), b.as_bytes());
    if x.len() != y.len() {
        return false;
    }
    let mut d = 0u8;
    for i in 0..x.len() {
        d |= x[i] ^ y[i];
    }
    d == 0
}

/* ---------- ffmpeg ---------- */

/// JS's String(n) for the seconds and track numbers of ffmpeg's arguments.
pub fn js_num(n: f64) -> String {
    if !n.is_finite() {
        return "0".to_string();
    }
    if n == n.trunc() && n.abs() < 1e15 {
        return format!("{}", n as i64);
    }
    format!("{}", n)
}

/// JS's `Number(x) || 0` on a query value.
pub fn num_or_zero(s: Option<&str>) -> f64 {
    match s {
        None => 0.0,
        Some(t) => {
            let t = t.trim();
            if t.is_empty() {
                return 0.0;
            }
            match t.parse::<f64>() {
                Ok(v) if v.is_finite() => v,
                _ => 0.0,
            }
        }
    }
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

/// streamproxy.cjs's remux(): an HLS stream copied into fragmented MP4, its headers handed to every request ffmpeg
/// makes (the user agent on its own, the rest as «k: v\r\n» lines; range left out).
pub fn remux_args(url: &str, headers: &[(String, String)]) -> Vec<String> {
    let ua = headers.iter().find(|(k, _)| k == "user-agent").map(|(_, v)| v.clone()).unwrap_or_else(|| PROXY_UA.to_string());
    let rest: String = headers
        .iter()
        .filter(|(k, _)| k != "user-agent" && k != "range")
        .map(|(k, v)| format!("{}: {}\r\n", k, v))
        .collect();
    let mut v = strs(&["-hide_banner", "-loglevel", "error", "-nostdin", "-user_agent"]);
    v.push(ua);
    if !rest.is_empty() {
        v.push("-headers".into());
        v.push(rest);
    }
    v.push("-i".into());
    v.push(url.to_string());
    v.extend(strs(&[
        "-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy", "-bsf:a", "aac_adtstoasc", "-f", "mp4", "-movflags",
        "frag_keyframe+empty_moov+default_base_moof", "pipe:1",
    ]));
    v
}

/* ---------- the proxy ---------- */

/// streamproxy.cjs's UA: what a source that wants a browser sees (Electron's, unchanged).
pub const PROXY_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

/// The answer's headers passed through to the player.
pub const PASS_HEADERS: [&str; 4] = ["content-type", "content-length", "content-range", "accept-ranges"];

/// An HLS playlist, by its type or its address.
pub fn is_playlist(content_type: &str, href: &str) -> bool {
    if content_type.to_ascii_lowercase().contains("mpegurl") {
        return true;
    }
    // (/\.m3u8(\?|$)/i)
    let h = href.to_ascii_lowercase();
    h.match_indices(".m3u8").any(|(i, _)| {
        let after = &h[i + 5..];
        after.is_empty() || after.starts_with('?')
    })
}

/// The headers the page asked for, names lowercased, the Chrome-like user agent first unless the page gave one.
pub fn proxy_headers(page: &[(String, String)]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = vec![("user-agent".into(), PROXY_UA.into())];
    for (k, v) in page {
        let k = k.to_ascii_lowercase();
        if let Some(e) = out.iter_mut().find(|(x, _)| *x == k) {
            e.1 = v.clone();
        } else {
            out.push((k, v.clone()));
        }
    }
    out
}

/// main.cjs's magnet for a torrent aria2 has no file of: its hash and up to 20 of its trackers.
pub fn magnet_of(info_hash: &str, trackers: &[String]) -> String {
    let mut m = format!("magnet:?xt=urn:btih:{}", info_hash);
    for t in trackers.iter().take(20) {
        m.push_str("&tr=");
        m.push_str(&encode_component(t));
    }
    m
}

/* ---------- watching a download aria2 has ---------- */

/// torrentstream.cjs's url(): the options a download being watched is changed to (fetched in order, its head and
/// tail first). aria2 may refuse them on a download that cannot change now: then it goes on as it was.
pub const STREAM_OPTIONS: [(&str, &str); 2] = [("stream-piece-selector", "inorder"), ("bt-prioritize-piece", "head=16M,tail=4M")];

/// torrentstream.cjs's «done»: aria2 says complete, or every byte is in.
pub fn finished(status: &str, completed: u64, total: u64) -> bool {
    status == "complete" || (total > 0 && completed >= total)
}

/// A download that will bring nothing more (the reader stops waiting).
pub fn stopped(status: &str) -> bool {
    status == "error" || status == "removed"
}

/// The parts of a file lying at `file_off` (`file_len` bytes) whose pieces are in, as (first byte, last byte) of the
/// file, joined where they touch; at most `max` of them (the rest left out). For the player's «buffered» line.
pub fn buffered(bitfield: Option<&str>, file_off: u64, file_len: u64, piece_len: u64, max: usize) -> Vec<(u64, u64)> {
    let mut out: Vec<(u64, u64)> = Vec::new();
    if file_len == 0 {
        return out;
    }
    let pl = if piece_len == 0 { 1 << 20 } else { piece_len };
    let (first, last) = pieces_of(file_off, 0, file_len, pl);
    let mut run: Option<u64> = None;
    for p in first..=last + 1 {
        let inp = p <= last && have(bitfield, p, p);
        match (inp, run) {
            (true, None) => run = Some(p),
            (false, Some(a)) => {
                let from = (a * pl).max(file_off) - file_off;
                let to = (((p * pl).min(file_off + file_len)) - file_off).saturating_sub(1);
                out.push((from, to));
                run = None;
                if out.len() >= max {
                    return out;
                }
            }
            _ => {}
        }
    }
    out
}

/* ---------- the server's addresses ---------- */

/// What an address of the stream server asks for. Every address starts with the run's token («/<token>/…»); a torrent
/// file's also carries its own session token («/<token>/t/<session>/<name>»), which kt:streamDone withdraws.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Route {
    /// A file of a torrent being watched (kt:streamUrl).
    Torrent { session: String },
    /// A file on this computer (kt:fileUrl): `p` its path.
    File { path: String },
    /// One audio track as AAC (kt:audioUrl).
    Audio,
    /// The picture converted as it plays (kt:videoUrl).
    Video,
    /// An online source with its headers (kt:proxyUrl).
    Proxy,
    /// No such address (404).
    NotFound,
    /// Not this run's token (403).
    Forbidden,
}

/// The route of a request's path and query under the run's `token`.
pub fn route(path: &str, query: &str, token: &str) -> Route {
    let rest = match path.strip_prefix('/') {
        Some(r) => r,
        None => return Route::NotFound,
    };
    let mut parts = rest.splitn(2, '/');
    let tok = parts.next().unwrap_or("");
    let tail = parts.next().unwrap_or("");
    if !same_token(&decode_component(tok, false), token) {
        return Route::Forbidden;
    }
    match tail {
        "f" => match query_get(query, "p") {
            Some(p) if !p.is_empty() => Route::File { path: p },
            _ => Route::NotFound,
        },
        "audio" => Route::Audio,
        "video" => Route::Video,
        "p" => Route::Proxy,
        _ => {
            if let Some(t) = tail.strip_prefix("t/") {
                let session = t.split('/').next().unwrap_or("");
                if !session.is_empty() {
                    return Route::Torrent { session: decode_component(session, false) };
                }
            }
            Route::NotFound
        }
    }
}

/// The address of a torrent file: «http://127.0.0.1:port/<token>/t/<session>/<its name>» (the name for players that go
/// by the extension).
pub fn torrent_address(port: u16, token: &str, session: &str, name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    format!("http://127.0.0.1:{}/{}/t/{}/{}", port, token, session, encode_component(if base.is_empty() { "file" } else { base }))
}

/// kt:fileUrl's address.
pub fn file_address(port: u16, token: &str, path: &str) -> String {
    format!("http://127.0.0.1:{}/{}/f?p={}", port, token, encode_component(path))
}

/// kt:proxyUrl's address: the source and its headers (JSON), as streamproxy.cjs's url() writes them.
pub fn proxy_address(port: u16, token: &str, url: &str, headers_json: &str) -> String {
    format!("http://127.0.0.1:{}/{}/p?u={}&h={}", port, token, encode_component(url), encode_component(headers_json))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watching() {
        assert!(finished("complete", 0, 0));
        assert!(finished("active", 10, 10));
        assert!(!finished("active", 0, 0));
        assert!(!finished("paused", 9, 10));
        assert!(stopped("error") && stopped("removed") && !stopped("paused"));
        // (Pieces of 10 bytes; the file at 15, 40 bytes long → pieces 1..=5; «5c» = 0101 1100: pieces 1, 3, 4, 5 in.)
        assert_eq!(buffered(Some("5c"), 15, 40, 10, 9), vec![(0, 4), (15, 39)]);
        assert_eq!(buffered(Some("5c"), 15, 40, 10, 1), vec![(0, 4)]);
        assert_eq!(buffered(Some("00"), 0, 40, 10, 9), vec![]);
        assert_eq!(buffered(Some("ff"), 0, 35, 10, 9), vec![(0, 34)]);
        assert_eq!(buffered(None, 0, 0, 10, 9), vec![]);
        assert_eq!(STREAM_OPTIONS[1].1, "head=16M,tail=4M");
    }

    #[test]
    fn routes() {
        let tok = "0123456789abcdef0123456789abcdef";
        assert_eq!(route(&format!("/{}/f", tok), "p=%2Fa%2Fb.mkv", tok), Route::File { path: "/a/b.mkv".into() });
        assert_eq!(route(&format!("/{}/f", tok), "", tok), Route::NotFound);
        assert_eq!(route(&format!("/{}/audio", tok), "src=x", tok), Route::Audio);
        assert_eq!(route(&format!("/{}/video", tok), "", tok), Route::Video);
        assert_eq!(route(&format!("/{}/p", tok), "u=x", tok), Route::Proxy);
        assert_eq!(route(&format!("/{}/t/s1/a%20b.mkv", tok), "", tok), Route::Torrent { session: "s1".into() });
        assert_eq!(route(&format!("/{}/t/s1", tok), "", tok), Route::Torrent { session: "s1".into() });
        assert_eq!(route(&format!("/{}/t/", tok), "", tok), Route::NotFound);
        assert_eq!(route(&format!("/{}/zzz", tok), "", tok), Route::NotFound);
        assert_eq!(route("/wrong/f", "p=x", tok), Route::Forbidden);
        assert_eq!(route("/", "", tok), Route::Forbidden);
        assert_eq!(route("f", "", tok), Route::NotFound);
        let a = torrent_address(5, tok, "s1", "dir/Ep 1.mkv");
        assert_eq!(a, format!("http://127.0.0.1:5/{}/t/s1/Ep%201.mkv", tok));
        let f = file_address(5, tok, "C:\\v\\ü.mkv");
        let (p, q) = split_target(&f["http://127.0.0.1:5".len()..]);
        assert_eq!(route(p, q, tok), Route::File { path: "C:\\v\\ü.mkv".into() });
        let x = proxy_address(5, tok, "https://h/a.m3u8?x=1&y=2", "{\"Referer\":\"https://h/\"}");
        let (p, q) = split_target(&x["http://127.0.0.1:5".len()..]);
        assert_eq!(route(p, q, tok), Route::Proxy);
        assert_eq!(query_get(q, "u").as_deref(), Some("https://h/a.m3u8?x=1&y=2"));
        assert_eq!(query_get(q, "h").as_deref(), Some("{\"Referer\":\"https://h/\"}"));
    }

    #[test]
    fn spans_as_electron() {
        assert_eq!(span(None, 1000), Span::Whole { len: 1000 });
        assert_eq!(span(Some("bytes=0-99"), 1000), Span::Part { from: 0, to: 99, size: 1000 });
        assert_eq!(span(Some("bytes=500-"), 1000), Span::Part { from: 500, to: 999, size: 1000 });
        assert_eq!(span(Some("bytes=-100"), 1000), Span::Part { from: 900, to: 999, size: 1000 });
        assert_eq!(span(Some("bytes=-5000"), 1000), Span::Part { from: 0, to: 999, size: 1000 });
        assert_eq!(span(Some("bytes=0-99999"), 1000), Span::Part { from: 0, to: 999, size: 1000 });
        assert_eq!(span(Some("bytes=1000-"), 1000), Span::Unsatisfiable { size: 1000 });
        assert_eq!(span(Some("bytes=999-999"), 1000), Span::Part { from: 999, to: 999, size: 1000 });
        // (Electron's holes, closed.)
        assert_eq!(span(Some("bytes=500-100"), 1000), Span::Unsatisfiable { size: 1000 });
        assert_eq!(span(Some("bytes=0-10"), 0), Span::Whole { len: 0 });
        assert_eq!(span(Some("bytes=-0"), 1000), Span::Unsatisfiable { size: 1000 });
        // (The first range of several; «bytes=-» is all of it, as the regex reads it; no match → whole.)
        assert_eq!(span(Some("bytes=10-19,30-39"), 1000), Span::Part { from: 10, to: 19, size: 1000 });
        assert_eq!(span(Some("bytes=-"), 1000), Span::Part { from: 0, to: 999, size: 1000 });
        assert_eq!(span(Some("items=0-1"), 1000), Span::Whole { len: 1000 });
        assert_eq!(span(Some("bytes=x, bytes=5-6"), 1000), Span::Part { from: 5, to: 6, size: 1000 });
        assert_eq!(span(Some("bytes=99999999999999999999999-"), 10), Span::Unsatisfiable { size: 10 });
        assert_eq!(Span::Part { from: 10, to: 19, size: 100 }.bytes(), (10, 10));
    }

    #[test]
    fn range_answers() {
        let (c, h) = range_headers(&Span::Part { from: 5, to: 9, size: 20 }, "video/mp4");
        assert_eq!(c, 206);
        assert!(h.contains(&("Content-Range".into(), "bytes 5-9/20".into())));
        assert!(h.contains(&("Content-Length".into(), "5".into())));
        let (c, h) = range_headers(&Span::Unsatisfiable { size: 20 }, "x");
        assert_eq!(c, 416);
        assert!(h.contains(&("Content-Range".into(), "bytes */20".into())));
        let (c, _) = range_headers(&Span::Whole { len: 3 }, "x");
        assert_eq!(c, 200);
        let t = head_text(206, &[("A".into(), "b\r\nInjected: 1".into())]);
        assert_eq!(t, "HTTP/1.1 206 Partial Content\r\nA: bInjected: 1\r\n\r\n");
    }

    #[test]
    fn types() {
        assert_eq!(stream_type("a/B.MKV"), "video/webm");
        assert_eq!(stream_type("x.mp4"), "video/mp4");
        assert_eq!(stream_type("x.wav"), "audio/wav");
        assert_eq!(stream_type("x"), "application/octet-stream");
        assert_eq!(stream_type(".mp4"), "video/mp4");
        assert_eq!(file_type("C:\\v\\a.mkv"), "video/x-matroska");
        assert_eq!(file_type("a.ass"), "text/plain; charset=utf-8");
        assert_eq!(file_type("a.JPEG"), "image/jpeg");
        assert_eq!(file_type("a.tar.gz"), "application/octet-stream");
    }

    #[test]
    fn bitfield() {
        // «f0» = pieces 0–3 in, 4–7 not; «8» = piece 8 in.
        assert!(have(Some("f08"), 0, 3));
        assert!(!have(Some("f08"), 3, 4));
        assert!(have(Some("f08"), 8, 8));
        assert!(!have(Some("f08"), 9, 9));
        assert!(!have(None, 0, 0));
        assert!(!have(Some(""), 0, 0));
        assert!(have(Some("FF"), 0, 7));
        assert_eq!(count_have(Some("f08"), 12), 5);
        assert_eq!(pieces_of(0, 0, 100, 64), (0, 1));
        assert_eq!(pieces_of(1000, 24, 1, 1024), (1, 1));
        assert_eq!(pieces_of(0, 0, 0, 0), (0, 0));
        let fs = [PlaceIn { index: Some(1), length: 10 }, PlaceIn { index: Some(2), length: 20 }, PlaceIn { index: Some(3), length: 5 }];
        assert_eq!(place_of(&fs, 0), Some((0, 10, 0)));
        assert_eq!(place_of(&fs, 2), Some((30, 5, 2)));
        assert_eq!(place_of(&fs, 3), None);
        let bare = [PlaceIn { index: None, length: 7 }, PlaceIn { index: None, length: 8 }];
        assert_eq!(place_of(&bare, 1), Some((7, 8, 1)));
    }

    #[test]
    fn requests() {
        let raw = b"GET /tok/f?p=%2Ftmp%2Fa%20b.mkv&x=1+2 HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=0-\r\n\r\n";
        assert_eq!(head_end(raw), Some(raw.len()));
        let h = parse_head(raw).unwrap();
        assert_eq!(h.method, "GET");
        assert_eq!(h.header("range"), Some("bytes=0-"));
        let (p, q) = split_target(&h.target);
        assert_eq!(p, "/tok/f");
        assert_eq!(query_get(q, "p").as_deref(), Some("/tmp/a b.mkv"));
        assert_eq!(query_get(q, "x").as_deref(), Some("1 2"));
        assert_eq!(query_get(q, "none"), None);
        assert!(parse_head(b"garbage\r\n\r\n").is_none());
        assert!(parse_head(b"GET http://x/ HTTP/1.1\r\n\r\n").is_none());
        assert_eq!(head_end(b"GET / HTTP/1.1\r\n"), None);
        assert_eq!(decode_component("%E2%9C%93%zz%", false), "✓%zz%");
        assert_eq!(encode_component("a b/✓?&=+"), "a%20b%2F%E2%9C%93%3F%26%3D%2B");
        assert_eq!(decode_component(&encode_component("C:\\x y\\ü.mkv"), true), "C:\\x y\\ü.mkv");
    }

    #[test]
    fn tokens() {
        let a = new_token();
        let b = new_token();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
        assert!(same_token(&a, &a.clone()));
        assert!(!same_token(&a, &b));
        assert!(!same_token(&a, &a[..31]));
    }

    #[test]
    fn ffmpeg_words() {
        assert_eq!(js_num(12.5), "12.5");
        assert_eq!(js_num(3.0), "3");
        assert_eq!(js_num(f64::NAN), "0");
        assert_eq!(num_or_zero(Some("7.25")), 7.25);
        assert_eq!(num_or_zero(Some("x")), 0.0);
        assert_eq!(num_or_zero(None), 0.0);
        let r = remux_args("https://h/x.m3u8", &proxy_headers(&[("Referer".into(), "https://h/".into()), ("Range".into(), "bytes=0-".into())]));
        assert_eq!(r[4], "-user_agent");
        assert_eq!(r[5], PROXY_UA);
        assert_eq!(r[6], "-headers");
        assert_eq!(r[7], "referer: https://h/\r\n");
        assert_eq!(r[r.len() - 1], "pipe:1");
    }

    #[test]
    fn proxy_rules() {
        assert!(is_playlist("application/vnd.apple.mpegURL", "https://h/x"));
        assert!(is_playlist("", "https://h/a/b.m3u8"));
        assert!(is_playlist("", "https://h/a/b.M3U8?t=1"));
        assert!(!is_playlist("video/mp4", "https://h/a/b.m3u8x"));
        assert!(!is_playlist("", "https://h/a.mp4"));
        let h = proxy_headers(&[("User-Agent".into(), "mine".into()), ("Cookie".into(), "a=b".into())]);
        assert_eq!(h, vec![("user-agent".into(), "mine".into()), ("cookie".into(), "a=b".into())]);
        assert_eq!(
            magnet_of("abc", &["udp://t:1/a".to_string()]),
            "magnet:?xt=urn:btih:abc&tr=udp%3A%2F%2Ft%3A1%2Fa"
        );
        let many: Vec<String> = (0..30).map(|i| format!("t{}", i)).collect();
        assert_eq!(magnet_of("h", &many).matches("&tr=").count(), 20);
    }
}
