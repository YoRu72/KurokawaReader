// The self-test's own web server (only when KT_SELFTEST is set; see selftest.rs): 127.0.0.1 on a free port, so
// kt:http and the download engine are tested without the internet. Std only, checked alone with
// `rustc --edition 2021 --test testserver.rs`.
//   GET  /text          a fixed UTF-8 text, with x-kt-test and two x-kt-multi headers
//   GET  /redirect      302 → /text
//   GET  /gzip          GZ_TEXT, gzip-encoded (stored deflate blocks: no compressor needed)
//   GET  /bin           the bytes 0..=255
//   POST /echo          «<METHOD>:<body>»
//   GET  /big/<name>    BIG_SIZE deterministic bytes, Range answered (206), sent slowly so a download can be paused
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::Duration;

pub const TEXT: &str = "kurokawa selftest ✓";
pub const GZ_TEXT: &str = "kurokawa gzip selftest — the same line again and again";
/// 2 MiB: twice aria2's --min-split-size, so it may fetch it over two connections.
pub const BIG_SIZE: usize = 2 * 1024 * 1024;
/// The slow sending: this many bytes, then a pause (≈ 320 KB/s per connection).
const SLOW_CHUNK: usize = 16 * 1024;
const SLOW_PAUSE_MS: u64 = 50;

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
    for line in lines {
        let mut it = line.splitn(2, ':');
        let k = it.next().unwrap_or("").trim().to_ascii_lowercase();
        let v = it.next().unwrap_or("").trim().to_string();
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
        big(&mut s, req.range.as_deref(), head_only)
    } else {
        answer(&mut s, "404 Not Found", &[], b"not found")
    }
}

fn big(s: &mut TcpStream, range: Option<&str>, head_only: bool) -> std::io::Result<()> {
    let (status, start, end) = match range.and_then(|r| parse_range(r, BIG_SIZE)) {
        Some((a, b)) => ("206 Partial Content", a, b),
        None => ("200 OK", 0, BIG_SIZE - 1),
    };
    let len = end + 1 - start;
    let mut head = format!(
        "HTTP/1.1 {}\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\nContent-Length: {}\r\n",
        status, len
    );
    if status.starts_with("206") {
        head.push_str(&format!(
            "Content-Range: bytes {}-{}/{}\r\n",
            start, end, BIG_SIZE
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
        let n = get(port, "GET /nope HTTP/1.1\r\n\r\n");
        assert!(String::from_utf8_lossy(&n).starts_with("HTTP/1.1 404"));
    }
}
