// The self-tests' own web server (only in a self-test run; see selftest.rs): 127.0.0.1 on a free port, so the
// apps' web requests (and Tools' download engine) are tested without the internet. Std only, checked alone with
// `rustc --edition 2021 --test testserver.rs`. (From Kurokawa Tools' src-tauri/src/testserver.rs, branch work-tauri;
// /latin, /meta and /releases added for the Reader.)
//   GET  /text          a fixed UTF-8 text, with x-kt-test and two x-kt-multi headers
//   GET  /redirect      302 → /text
//   GET  /gzip          GZ_TEXT, gzip-encoded (stored deflate blocks: no compressor needed)
//   GET  /bin           the bytes 0..=255
//   POST /echo          «<METHOD>:<body>»
//   GET  /big/<name>    BIG_SIZE deterministic bytes, Range answered (206), sent slowly so a download can be paused
//   GET  /latin         LATIN_TEXT in windows-1256, the charset named in Content-Type
//   GET  /meta          an HTML page in windows-1256 whose charset is named only by a <meta> in it
//   GET  /releases      RELEASES: a canned GitHub releases list (an update check parsed without GitHub)
// and for the Reader's network stage (R3):
//   GET  /cookie/set    sets kr_test=COOKIE_VALUE (path /) and kr_away=1 (path /elsewhere: never sent back here)
//   GET  /cookie/hop    sets kr_hop=1 and redirects (302) to /cookie/echo — a cookie set on a redirect's way
//   GET  /cookie/echo   the request's Cookie header as the body («-» when none)
//   GET  /chain/<n>     302 → /chain/<n-1> … /chain/0 → /text (n at most 30)
//   GET  /headers       the request's headers, «name: value» lines with lowercase names, as the body
//   GET  /large/<name>  LARGE_SIZE bytes made as /big's are, Range answered, sent slowly (a download in parts)
//   POST /dns-query     DNS over HTTPS (RFC 8484): DOH_HOST → 127.0.0.1 (A), no AAAA; any other name: «no such
//                       name»; /dns-count tells how many queries came
// and for the in-app browser (R4), a small site:
//   GET  /site/         its page (titled SITE_TITLE): sets kr_site=SITE_COOKIE (HttpOnly), kr_seen=1 and a
//                       clearance, cf_clearance=1 (HttpOnly); links to a download (#dl) and to a page in a new window
//                       (#pop)
//   GET  /site/private  signed in only: 200 «signed-in;clearance=<0|1>;ua=<User-Agent>» with kr_site's cookie, else
//                       401 «signed out»
//   GET  /site/file.epub   a file offered as a download (Content-Disposition: attachment; SITE_FILE bytes)
//   GET  /site/popup    a page (KR popup)
//   GET  /site/token    302 → /site/landing#access_token=SITE_TOKEN (a sign-in's end)
//   GET  /site/landing  a page (KR landing)
//   GET  /site/check    a page that stays a check («Just a moment...»)
use std::io::{Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::Duration;

pub const TEXT: &str = "kurokawa selftest ✓";
pub const GZ_TEXT: &str = "kurokawa gzip selftest — the same line again and again";
/// 2 MiB: twice aria2's --min-split-size, so it may fetch it over two connections.
pub const BIG_SIZE: usize = 2 * 1024 * 1024;
/// 3 MiB: over the 2 MiB from which the Reader's downloader fetches a file in parts.
pub const LARGE_SIZE: usize = 3 * 1024 * 1024;
/// The value /cookie/set gives (a fixed test string: the self-test may log that it came back).
pub const COOKIE_VALUE: &str = "jar-ok";
/// The in-app browser's test site (R4): its page's title, the session cookie it sets, a sign-in's token, the file it
/// offers. (Fixed test strings: the self-test may log them.)
pub const SITE_TITLE: &str = "KR test site";
pub const SITE_COOKIE: &str = "signed-in";
pub const SITE_TOKEN: &str = "kr-token-1";
pub const SITE_FILE: &[u8] = b"PK\x03\x04 kurokawa selftest download";
pub const SITE_FILE_NAME: &str = "kr-selftest-download.epub";
/// The made-up name /dns-query answers with 127.0.0.1 (.test is reserved: no real resolver knows it).
pub const DOH_HOST: &str = "kr-doh-selftest.test";
static DNS_QUERIES: AtomicUsize = AtomicUsize::new(0);
/// The slow sending: this many bytes, then a pause (≈ 320 KB/s per connection).
const SLOW_CHUNK: usize = 16 * 1024;
const SLOW_PAUSE_MS: u64 = 50;

/// Arabic text, and the same in windows-1256 (what an older Arabic site sends).
pub const LATIN_TEXT: &str = "\u{645}\u{631}\u{62d}\u{628}\u{627} \u{628}\u{627}\u{644}\u{639}\u{627}\u{644}\u{645}";
pub const LATIN_BYTES: [u8; 13] = [
    0xe3, 0xd1, 0xcd, 0xc8, 0xc7, 0x20, 0xc8, 0xc7, 0xe1, 0xda, 0xc7, 0xe1, 0xe3,
];

/// The /meta page: LATIN_BYTES inside an HTML page that names its charset only in a <meta>.
pub fn meta_page() -> Vec<u8> {
    let mut b: Vec<u8> =
        b"<!doctype html><html><head><meta charset=\"windows-1256\"><title>t</title></head><body>".to_vec();
    b.extend_from_slice(&LATIN_BYTES);
    b.extend_from_slice(b"</body></html>");
    b
}

/// A GitHub releases list as the API gives it, trimmed: another app's tag, a pre-release, a draft, and two releases
/// of the app (v0.62.0 the newest stable one), with an asset for each OS.
pub const RELEASES: &str = r#"[
 {"tag_name":"tools-v9.9.9","draft":false,"prerelease":true,"html_url":"https://example.invalid/tools-v9.9.9","body":"tools","assets":[]},
 {"tag_name":"v0.99.0","draft":true,"prerelease":false,"html_url":"https://example.invalid/v0.99.0","body":"draft","assets":[]},
 {"tag_name":"v0.63.0","draft":false,"prerelease":true,"html_url":"https://example.invalid/v0.63.0","body":"beta","assets":[
  {"name":"KurokawaReader-0.63.0-win-x64.exe","browser_download_url":"https://example.invalid/b/w.exe"}]},
 {"tag_name":"v0.62.0","draft":false,"prerelease":false,"html_url":"https://example.invalid/v0.62.0","body":"notes \u0645","assets":[
  {"name":"KurokawaReader-0.62.0-win-x64-portable.exe","browser_download_url":"https://example.invalid/s/p.exe"},
  {"name":"KurokawaReader-0.62.0-win-x64.exe","browser_download_url":"https://example.invalid/s/w.exe"},
  {"name":"KurokawaReader-0.62.0-mac-universal.dmg","browser_download_url":"https://example.invalid/s/m.dmg"},
  {"name":"KurokawaReader-0.62.0-linux-x86_64.AppImage","browser_download_url":"https://example.invalid/s/l.AppImage"}]},
 {"tag_name":"v0.61.0","draft":false,"prerelease":false,"html_url":"https://example.invalid/v0.61.0","body":"old","assets":[]}
]"#;

/// The big file's byte at `i` (a fixed pseudo-random sequence).
pub fn big_byte(i: usize) -> u8 {
    let mut x = (i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0x5DEE_CE66;
    x ^= x >> 29;
    x = x.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x ^= x >> 32;
    (x & 0xff) as u8
}

pub fn big_bytes() -> Vec<u8> {
    (0..BIG_SIZE).map(big_byte).collect()
}

pub fn crc32(data: &[u8]) -> u32 {
    let mut c: u32 = 0xFFFF_FFFF;
    for &b in data {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                (c >> 1) ^ 0xEDB8_8320
            } else {
                c >> 1
            };
        }
    }
    !c
}

/// `data` as a gzip member made of stored (uncompressed) deflate blocks.
pub fn gzip_stored(data: &[u8]) -> Vec<u8> {
    let mut out: Vec<u8> = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff];
    let mut chunks: Vec<&[u8]> = data.chunks(65535).collect();
    if chunks.is_empty() {
        chunks.push(&[]);
    }
    let last = chunks.len() - 1;
    for (i, ch) in chunks.iter().enumerate() {
        out.push(if i == last { 1 } else { 0 });
        let len = ch.len() as u16;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(ch);
    }
    out.extend_from_slice(&crc32(data).to_le_bytes());
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out
}

/// Starts the server on 127.0.0.1:0 → its port. Each connection on its own thread; one request each.
pub fn start() -> std::io::Result<u16> {
    let l = TcpListener::bind("127.0.0.1:0")?;
    let port = l.local_addr()?.port();
    thread::spawn(move || {
        for s in l.incoming() {
            if let Ok(s) = s {
                thread::spawn(move || {
                    let _ = serve(s);
                });
            }
        }
    });
    Ok(port)
}

struct Req {
    method: String,
    path: String,
    range: Option<String>,
    /// Every header, its name lowercased, in the order sent.
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if hay.len() < needle.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

fn read_req(s: &mut TcpStream) -> std::io::Result<Option<Req>> {
    let mut raw: Vec<u8> = Vec::new();
    let mut buf = [0u8; 4096];
    let he = loop {
        if let Some(i) = find(&raw, b"\r\n\r\n") {
            break i;
        }
        let n = s.read(&mut buf)?;
        if n == 0 {
            return Ok(None);
        }
        raw.extend_from_slice(&buf[..n]);
        if raw.len() > 65536 {
            return Ok(None);
        }
    };
    let head = String::from_utf8_lossy(&raw[..he]).into_owned();
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or("");
    let mut parts = first.split(' ');
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("/").to_string();
    let mut cl: usize = 0;
    let mut range: Option<String> = None;
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in lines {
        let mut it = line.splitn(2, ':');
        let k = it.next().unwrap_or("").trim().to_ascii_lowercase();
        let v = it.next().unwrap_or("").trim().to_string();
        if !k.is_empty() {
            headers.push((k.clone(), v.clone()));
        }
        if k == "content-length" {
            cl = v.parse().unwrap_or(0);
        } else if k == "range" {
            range = Some(v);
        }
    }
    let mut body: Vec<u8> = raw[he + 4..].to_vec();
    while body.len() < cl {
        let n = s.read(&mut buf)?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&buf[..n]);
    }
    body.truncate(cl);
    Ok(Some(Req {
        method,
        path,
        range,
        headers,
        body,
    }))
}

/// «bytes=a-b» / «bytes=a-» / «bytes=-n» → [start, end] inclusive, within `size`.
pub fn parse_range(r: &str, size: usize) -> Option<(usize, usize)> {
    let spec = r.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let mut it = first.splitn(2, '-');
    let a = it.next()?.trim();
    let b = it.next()?.trim();
    if size == 0 {
        return None;
    }
    if a.is_empty() {
        let n: usize = b.parse().ok()?;
        if n == 0 {
            return None;
        }
        return Some((size.saturating_sub(n), size - 1));
    }
    let start: usize = a.parse().ok()?;
    let end: usize = if b.is_empty() {
        size - 1
    } else {
        b.parse::<usize>().ok()?.min(size - 1)
    };
    if start > end || start >= size {
        return None;
    }
    Some((start, end))
}

fn answer(
    s: &mut TcpStream,
    status: &str,
    headers: &[(&str, String)],
    body: &[u8],
) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {}\r\nContent-Length: {}\r\n", status, body.len());
    for (k, v) in headers {
        head.push_str(&format!("{}: {}\r\n", k, v));
    }
    head.push_str("Connection: close\r\n\r\n");
    s.write_all(head.as_bytes())?;
    s.write_all(body)?;
    s.flush()
}

fn serve(mut s: TcpStream) -> std::io::Result<()> {
    let _ = s.set_read_timeout(Some(Duration::from_secs(20)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(20)));
    let req = match read_req(&mut s)? {
        Some(r) => r,
        None => return Ok(()),
    };
    let path = req.path.split('?').next().unwrap_or("").to_string();
    let head_only = req.method == "HEAD";
    if path == "/text" {
        let h = [
            ("Content-Type", "text/plain; charset=utf-8".to_string()),
            ("X-KT-Test", "1".to_string()),
            ("X-KT-Multi", "a".to_string()),
            ("X-KT-Multi", "b".to_string()),
        ];
        answer(&mut s, "200 OK", &h, TEXT.as_bytes())
    } else if path == "/redirect" {
        answer(
            &mut s,
            "302 Found",
            &[("Location", "/text".to_string())],
            b"",
        )
    } else if path == "/gzip" {
        let h = [
            ("Content-Type", "text/plain; charset=utf-8".to_string()),
            ("Content-Encoding", "gzip".to_string()),
        ];
        answer(&mut s, "200 OK", &h, &gzip_stored(GZ_TEXT.as_bytes()))
    } else if path == "/bin" {
        let b: Vec<u8> = (0..=255u8).collect();
        let h = [("Content-Type", "application/octet-stream".to_string())];
        answer(&mut s, "200 OK", &h, &b)
    } else if path == "/echo" {
        let mut b = format!("{}:", req.method).into_bytes();
        b.extend_from_slice(&req.body);
        let h = [("Content-Type", "text/plain; charset=utf-8".to_string())];
        answer(&mut s, "200 OK", &h, &b)
    } else if path.starts_with("/big/") {
        big(&mut s, req.range.as_deref(), head_only, BIG_SIZE)
    } else if path.starts_with("/large/") {
        big(&mut s, req.range.as_deref(), head_only, LARGE_SIZE)
    } else if path == "/cookie/set" {
        let h = [
            ("Content-Type", "text/plain".to_string()),
            ("Set-Cookie", format!("kr_test={}; Path=/; HttpOnly", COOKIE_VALUE)),
            ("Set-Cookie", "kr_away=1; Path=/elsewhere".to_string()),
        ];
        answer(&mut s, "200 OK", &h, b"set")
    } else if path == "/cookie/hop" {
        let h = [
            ("Set-Cookie", "kr_hop=1; Path=/".to_string()),
            ("Location", "/cookie/echo".to_string()),
        ];
        answer(&mut s, "302 Found", &h, b"")
    } else if path == "/cookie/echo" {
        let c = header_of(&req, "cookie").unwrap_or_else(|| "-".to_string());
        let h = [("Content-Type", "text/plain".to_string())];
        answer(&mut s, "200 OK", &h, c.as_bytes())
    } else if let Some(n) = path.strip_prefix("/chain/") {
        let n: usize = n.parse().unwrap_or(0).min(30);
        let to = if n == 0 { "/text".to_string() } else { format!("/chain/{}", n - 1) };
        answer(&mut s, "302 Found", &[("Location", to)], b"")
    } else if path == "/headers" {
        let mut b = String::new();
        for (k, v) in req.headers.iter() {
            b.push_str(&format!("{}: {}\n", k, v));
        }
        let h = [("Content-Type", "text/plain; charset=utf-8".to_string())];
        answer(&mut s, "200 OK", &h, b.as_bytes())
    } else if path == "/dns-query" && req.method == "POST" {
        DNS_QUERIES.fetch_add(1, Ordering::SeqCst);
        match dns_answer(&req.body) {
            Some(b) => answer(&mut s, "200 OK", &[("Content-Type", "application/dns-message".to_string())], &b),
            None => answer(&mut s, "400 Bad Request", &[], b"not a DNS query"),
        }
    } else if path == "/dns-count" {
        let n = DNS_QUERIES.load(Ordering::SeqCst).to_string();
        answer(&mut s, "200 OK", &[("Content-Type", "text/plain".to_string())], n.as_bytes())
    } else if path == "/site/" || path == "/site" {
        let h = [
            ("Content-Type", "text/html; charset=utf-8".to_string()),
            ("Set-Cookie", format!("kr_site={}; Path=/; HttpOnly", SITE_COOKIE)),
            ("Set-Cookie", "kr_seen=1; Path=/".to_string()),
            ("Set-Cookie", "cf_clearance=1; Path=/; HttpOnly".to_string()),
        ];
        let page = format!(
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title></head><body><h1>{}</h1><p><a id=\"dl\" href=\"/site/file.epub\">{}</a></p><p><a id=\"pop\" href=\"/site/popup\" target=\"_blank\">popup</a></p></body></html>",
            SITE_TITLE, SITE_TITLE, SITE_FILE_NAME
        );
        answer(&mut s, "200 OK", &h, page.as_bytes())
    } else if path == "/site/private" {
        let c = header_of(&req, "cookie").unwrap_or_default();
        let has = |kv: &str| c.split(';').any(|x| x.trim() == kv);
        let h = [("Content-Type", "text/plain; charset=utf-8".to_string())];
        if has(&format!("kr_site={}", SITE_COOKIE)) {
            let ua = header_of(&req, "user-agent").unwrap_or_default();
            let b = format!("signed-in;clearance={};ua={}", if has("cf_clearance=1") { 1 } else { 0 }, ua);
            answer(&mut s, "200 OK", &h, b.as_bytes())
        } else {
            answer(&mut s, "401 Unauthorized", &h, b"signed out")
        }
    } else if path == "/site/file.epub" {
        let h = [
            ("Content-Type", "application/epub+zip".to_string()),
            ("Content-Disposition", format!("attachment; filename=\"{}\"", SITE_FILE_NAME)),
        ];
        answer(&mut s, "200 OK", &h, SITE_FILE)
    } else if path == "/site/popup" || path == "/site/landing" || path == "/site/check" {
        let title = match path.as_str() {
            "/site/popup" => "KR popup",
            "/site/landing" => "KR landing",
            _ => "Just a moment...",
        };
        let h = [("Content-Type", "text/html; charset=utf-8".to_string())];
        let page = format!("<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title></head><body><p>{}</p></body></html>", title, title);
        answer(&mut s, "200 OK", &h, page.as_bytes())
    } else if path == "/site/token" {
        let h = [("Location", format!("/site/landing#access_token={}", SITE_TOKEN))];
        answer(&mut s, "302 Found", &h, b"")
    } else if path == "/latin" {
        let h = [("Content-Type", "text/plain; charset=windows-1256".to_string())];
        answer(&mut s, "200 OK", &h, &LATIN_BYTES)
    } else if path == "/meta" {
        let h = [("Content-Type", "text/html".to_string())];
        answer(&mut s, "200 OK", &h, &meta_page())
    } else if path == "/releases" {
        let h = [("Content-Type", "application/json; charset=utf-8".to_string())];
        answer(&mut s, "200 OK", &h, RELEASES.as_bytes())
    } else {
        answer(&mut s, "404 Not Found", &[], b"not found")
    }
}

fn header_of(req: &Req, name: &str) -> Option<String> {
    req.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
}

/// A DNS query (RFC 1035 wire format, one question, its name in plain labels) answered as a test resolver: DOH_HOST's
/// A record → 127.0.0.1; its AAAA → no record; any other name → «no such name». None if it is no query.
pub fn dns_answer(q: &[u8]) -> Option<Vec<u8>> {
    if q.len() < 12 || q[2] & 0x80 != 0 || u16::from_be_bytes([q[4], q[5]]) != 1 {
        return None;
    }
    let mut i = 12;
    let mut labels: Vec<String> = Vec::new();
    loop {
        let len = *q.get(i)? as usize;
        if len == 0 {
            i += 1;
            break;
        }
        if len > 63 {
            return None;
        }
        labels.push(String::from_utf8_lossy(q.get(i + 1..i + 1 + len)?).to_ascii_lowercase());
        i += 1 + len;
    }
    let qtype = u16::from_be_bytes([*q.get(i)?, *q.get(i + 1)?]);
    let end = i + 4;
    if end > q.len() {
        return None;
    }
    let name = labels.join(".");
    let known = name == DOH_HOST;
    let mut m: Vec<u8> = q[..end].to_vec();
    m[2] = 0x81 | (q[2] & 0x01);
    m[3] = 0x80 | if known { 0 } else { 3 };
    m[6] = 0;
    m[7] = if known && qtype == 1 { 1 } else { 0 };
    m[8..12].copy_from_slice(&[0, 0, 0, 0]);
    if known && qtype == 1 {
        m.extend_from_slice(&[0xC0, 0x0C, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1]);
    }
    Some(m)
}

fn big(s: &mut TcpStream, range: Option<&str>, head_only: bool, size: usize) -> std::io::Result<()> {
    let (status, start, end) = match range.and_then(|r| parse_range(r, size)) {
        Some((a, b)) => ("206 Partial Content", a, b),
        None => ("200 OK", 0, size - 1),
    };
    let len = end + 1 - start;
    let mut head = format!(
        "HTTP/1.1 {}\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\nContent-Length: {}\r\n",
        status, len
    );
    if status.starts_with("206") {
        head.push_str(&format!(
            "Content-Range: bytes {}-{}/{}\r\n",
            start, end, size
        ));
    }
    head.push_str("Connection: close\r\n\r\n");
    s.write_all(head.as_bytes())?;
    if head_only {
        return s.flush();
    }
    let mut pos = start;
    while pos <= end {
        let stop = (pos + SLOW_CHUNK).min(end + 1);
        let chunk: Vec<u8> = (pos..stop).map(big_byte).collect();
        s.write_all(&chunk)?;
        pos = stop;
        if pos <= end {
            thread::sleep(Duration::from_millis(SLOW_PAUSE_MS));
        }
    }
    s.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(port: u16, req: &str) -> Vec<u8> {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(req.as_bytes()).unwrap();
        let mut out = Vec::new();
        s.read_to_end(&mut out).unwrap();
        out
    }

    #[test]
    fn crc_and_gzip() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        let g = gzip_stored(b"abc");
        assert_eq!(&g[..3], &[0x1f, 0x8b, 8]);
        assert_eq!(g.len(), 10 + 5 + 3 + 8);
        assert_eq!(gzip_stored(b"").len(), 10 + 5 + 8);
    }

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=990-2000", 1000), Some((990, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("items=0-1", 1000), None);
    }

    #[test]
    fn routes() {
        let port = start().unwrap();
        let t = get(port, "GET /text HTTP/1.1\r\nHost: x\r\n\r\n");
        let ts = String::from_utf8_lossy(&t).into_owned();
        assert!(ts.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(ts.contains("X-KT-Multi: a\r\nX-KT-Multi: b\r\n"));
        assert!(ts.ends_with(TEXT));
        let r = String::from_utf8_lossy(&get(port, "GET /redirect HTTP/1.1\r\n\r\n")).into_owned();
        assert!(r.starts_with("HTTP/1.1 302") && r.contains("Location: /text\r\n"));
        let e = get(
            port,
            "POST /echo HTTP/1.1\r\nContent-Length: 6\r\n\r\n\u{646}\u{635}\u{627}",
        );
        assert!(String::from_utf8_lossy(&e).ends_with("POST:\u{646}\u{635}\u{627}"));
        let b = get(
            port,
            "GET /big/x.bin HTTP/1.1\r\nRange: bytes=100-199\r\n\r\n",
        );
        let i = find(&b, b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&b[..i]).into_owned();
        assert!(head.starts_with("HTTP/1.1 206"));
        assert!(head.contains(&format!("Content-Range: bytes 100-199/{}", BIG_SIZE)));
        let want: Vec<u8> = (100..200).map(big_byte).collect();
        assert_eq!(&b[i + 4..], &want[..]);
        let l = get(port, "GET /latin HTTP/1.1\r\n\r\n");
        let i = find(&l, b"\r\n\r\n").unwrap();
        assert!(String::from_utf8_lossy(&l[..i]).contains("charset=windows-1256"));
        assert_eq!(&l[i + 4..], &LATIN_BYTES[..]);
        let m = get(port, "GET /meta HTTP/1.1\r\n\r\n");
        assert!(find(&m, b"<meta charset=\"windows-1256\">").is_some());
        let r = String::from_utf8_lossy(&get(port, "GET /releases HTTP/1.1\r\n\r\n")).into_owned();
        assert!(r.contains("application/json") && r.contains("\"v0.62.0\""));
        let n = get(port, "GET /nope HTTP/1.1\r\n\r\n");
        assert!(String::from_utf8_lossy(&n).starts_with("HTTP/1.1 404"));
    }

    fn body_of(r: &[u8]) -> String {
        let i = find(r, b"\r\n\r\n").unwrap();
        String::from_utf8_lossy(&r[i + 4..]).into_owned()
    }

    #[test]
    fn network_routes() {
        let port = start().unwrap();
        let c = String::from_utf8_lossy(&get(port, "GET /cookie/set HTTP/1.1\r\n\r\n")).into_owned();
        assert!(c.contains("Set-Cookie: kr_test=jar-ok; Path=/; HttpOnly\r\n") && c.contains("Set-Cookie: kr_away=1; Path=/elsewhere\r\n"));
        let h = String::from_utf8_lossy(&get(port, "GET /cookie/hop HTTP/1.1\r\n\r\n")).into_owned();
        assert!(h.starts_with("HTTP/1.1 302") && h.contains("Set-Cookie: kr_hop=1") && h.contains("Location: /cookie/echo"));
        assert_eq!(body_of(&get(port, "GET /cookie/echo HTTP/1.1\r\nCookie: a=1; b=2\r\n\r\n")), "a=1; b=2");
        assert_eq!(body_of(&get(port, "GET /cookie/echo HTTP/1.1\r\n\r\n")), "-");
        assert!(String::from_utf8_lossy(&get(port, "GET /chain/3 HTTP/1.1\r\n\r\n")).contains("Location: /chain/2\r\n"));
        assert!(String::from_utf8_lossy(&get(port, "GET /chain/0 HTTP/1.1\r\n\r\n")).contains("Location: /text\r\n"));
        let e = body_of(&get(port, "GET /headers HTTP/1.1\r\nReferer: https://r.example/\r\nUser-Agent: UA ✓\r\n\r\n"));
        assert!(e.contains("referer: https://r.example/\n") && e.contains("user-agent: UA ✓\n"), "{}", e);
        let l = get(port, "GET /large/x HTTP/1.1\r\nRange: bytes=0-0\r\n\r\n");
        assert!(String::from_utf8_lossy(&l).contains(&format!("Content-Range: bytes 0-0/{}", LARGE_SIZE)));
    }

    #[test]
    fn site_routes() {
        let port = start().unwrap();
        let p = String::from_utf8_lossy(&get(port, "GET /site/ HTTP/1.1\r\n\r\n")).into_owned();
        assert!(p.contains("Set-Cookie: kr_site=signed-in; Path=/; HttpOnly\r\n") && p.contains("Set-Cookie: cf_clearance=1; Path=/; HttpOnly\r\n"));
        assert!(p.contains(&format!("<title>{}</title>", SITE_TITLE)) && p.contains("id=\"dl\"") && p.contains("target=\"_blank\""));
        let out = String::from_utf8_lossy(&get(port, "GET /site/private HTTP/1.1\r\nCookie: kr_seen=1\r\n\r\n")).into_owned();
        assert!(out.starts_with("HTTP/1.1 401") && out.ends_with("signed out"));
        let inn = body_of(&get(port, "GET /site/private HTTP/1.1\r\nUser-Agent: UA 1\r\nCookie: kr_seen=1; kr_site=signed-in\r\n\r\n"));
        assert_eq!(inn, "signed-in;clearance=0;ua=UA 1");
        let both = body_of(&get(port, "GET /site/private HTTP/1.1\r\nCookie: cf_clearance=1; kr_site=signed-in\r\n\r\n"));
        assert!(both.starts_with("signed-in;clearance=1;"));
        let f = get(port, "GET /site/file.epub HTTP/1.1\r\n\r\n");
        assert!(String::from_utf8_lossy(&f).contains(&format!("Content-Disposition: attachment; filename=\"{}\"", SITE_FILE_NAME)));
        assert!(f.ends_with(SITE_FILE));
        let t = String::from_utf8_lossy(&get(port, "GET /site/token HTTP/1.1\r\n\r\n")).into_owned();
        assert!(t.starts_with("HTTP/1.1 302") && t.contains("Location: /site/landing#access_token=kr-token-1\r\n"));
        assert!(body_of(&get(port, "GET /site/check HTTP/1.1\r\n\r\n")).contains("<title>Just a moment...</title>"));
        assert!(body_of(&get(port, "GET /site/popup HTTP/1.1\r\n\r\n")).contains("KR popup"));
    }

    #[test]
    fn dns() {
        // (A query for DOH_HOST's A record, as doh.rs writes one: id 0, recursion desired.)
        let mut q: Vec<u8> = vec![0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
        for l in DOH_HOST.split('.') {
            q.push(l.len() as u8);
            q.extend_from_slice(l.as_bytes());
        }
        q.push(0);
        let mut qa = q.clone();
        qa.extend_from_slice(&[0, 1, 0, 1]);
        let a = dns_answer(&qa).unwrap();
        assert_eq!(&a[2..4], &[0x81, 0x80]);
        assert_eq!(&a[6..8], &[0, 1]);
        assert_eq!(&a[a.len() - 4..], &[127, 0, 0, 1]);
        let mut q6 = q.clone();
        q6.extend_from_slice(&[0, 28, 0, 1]);
        let b = dns_answer(&q6).unwrap();
        assert_eq!((b[3], b[7], b.len()), (0x80, 0, q6.len()));
        let mut other: Vec<u8> = vec![0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, b'x', 0, 0, 1, 0, 1];
        let nx = dns_answer(&other).unwrap();
        assert_eq!(nx[3] & 0x0F, 3);
        other[2] = 0x80;
        assert!(dns_answer(&other).is_none());
        assert!(dns_answer(&[1, 2, 3]).is_none());
        let port = start().unwrap();
        let mut req = format!("POST /dns-query HTTP/1.1\r\nContent-Type: application/dns-message\r\nContent-Length: {}\r\n\r\n", qa.len()).into_bytes();
        req.extend_from_slice(&qa);
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(&req).unwrap();
        let mut out = Vec::new();
        s.read_to_end(&mut out).unwrap();
        let i = find(&out, b"\r\n\r\n").unwrap();
        assert!(String::from_utf8_lossy(&out[..i]).contains("application/dns-message"));
        assert_eq!(&out[i + 4..], &a[..]);
        let n: usize = body_of(&get(port, "GET /dns-count HTTP/1.1\r\n\r\n")).parse().unwrap();
        assert!(n >= 1);
    }
}
