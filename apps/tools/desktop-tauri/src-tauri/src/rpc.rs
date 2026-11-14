// A tiny HTTP/1.1 POST over a loopback TCP socket, for aria2's JSON-RPC endpoint (http://127.0.0.1:<port>/jsonrpc):
// std only — no WebSocket, no async — so the engine can run on plain threads and this can be tested alone:
// `rustc --edition 2021 --test rpc.rs`. The answer is read up to its Content-Length (or a chunked body's end, or the
// connection's close), so a server that keeps the connection open does not stall it.
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// POSTs `body` (JSON) to 127.0.0.1:`port``path` → (status, body text).
pub fn post(port: u16, path: &str, body: &str, timeout: Duration) -> Result<(u16, String), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s =
        TcpStream::connect_timeout(&addr, Duration::from_secs(3)).map_err(|e| e.to_string())?;
    let _ = s.set_read_timeout(Some(timeout));
    let _ = s.set_write_timeout(Some(timeout));
    let _ = s.set_nodelay(true);
    let head = format!(
        "POST {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nAccept: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        path,
        port,
        body.len()
    );
    s.write_all(head.as_bytes()).map_err(|e| e.to_string())?;
    s.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    let _ = s.flush();
    let raw = read_response(&mut s)?;
    parse_response(&raw)
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

/// The head's Content-Length, and whether the body is chunked.
fn framing(head: &str) -> (Option<usize>, bool) {
    let mut cl: Option<usize> = None;
    let mut chunked = false;
    for line in head.split("\r\n").skip(1) {
        let mut it = line.splitn(2, ':');
        let k = it.next().unwrap_or("").trim().to_ascii_lowercase();
        let v = it.next().unwrap_or("").trim();
        if k == "content-length" {
            cl = v.parse::<usize>().ok();
        } else if k == "transfer-encoding" && v.to_ascii_lowercase().contains("chunked") {
            chunked = true;
        }
    }
    (cl, chunked)
}

/// Whether `raw` holds a whole response already.
pub fn complete(raw: &[u8]) -> bool {
    let he = match find(raw, b"\r\n\r\n") {
        Some(i) => i,
        None => return false,
    };
    let head = String::from_utf8_lossy(&raw[..he]);
    let body = &raw[he + 4..];
    let (cl, chunked) = framing(&head);
    if chunked {
        return dechunk(body).is_some();
    }
    match cl {
        Some(n) => body.len() >= n,
        None => false,
    }
}

fn read_response(s: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut raw: Vec<u8> = Vec::new();
    let mut buf = [0u8; 16384];
    loop {
        match s.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                if complete(&raw) {
                    break;
                }
            }
            Err(e) => {
                if raw.is_empty() || !complete(&raw) {
                    return Err(e.to_string());
                }
                break;
            }
        }
    }
    if raw.is_empty() {
        return Err("empty answer".to_string());
    }
    Ok(raw)
}

/// A chunked body joined; None while its last chunk has not come.
pub fn dechunk(mut b: &[u8]) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new();
    loop {
        let le = find(b, b"\r\n")?;
        let size_text = String::from_utf8_lossy(&b[..le]);
        let size_hex = size_text.split(';').next().unwrap_or("").trim().to_string();
        let size = usize::from_str_radix(&size_hex, 16).ok()?;
        b = &b[le + 2..];
        if size == 0 {
            return Some(out);
        }
        if b.len() < size + 2 {
            return None;
        }
        out.extend_from_slice(&b[..size]);
        b = &b[size + 2..];
    }
}

/// (status, body text) of a whole response.
pub fn parse_response(raw: &[u8]) -> Result<(u16, String), String> {
    let he = find(raw, b"\r\n\r\n").ok_or_else(|| "bad answer".to_string())?;
    let head = String::from_utf8_lossy(&raw[..he]).into_owned();
    let status: u16 = head
        .split(' ')
        .nth(1)
        .and_then(|x| x.parse::<u16>().ok())
        .ok_or_else(|| "bad status line".to_string())?;
    let body = &raw[he + 4..];
    let (cl, chunked) = framing(&head);
    let bytes: Vec<u8> = if chunked {
        dechunk(body).ok_or_else(|| "cut chunked answer".to_string())?
    } else {
        match cl {
            Some(n) if body.len() >= n => body[..n].to_vec(),
            Some(_) => return Err("cut answer".to_string()),
            None => body.to_vec(),
        }
    };
    Ok((status, String::from_utf8_lossy(&bytes).into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn framing_and_chunks() {
        let r = b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello";
        assert!(complete(r));
        assert_eq!(parse_response(r).unwrap(), (200, "hello".to_string()));
        assert!(!complete(
            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhel"
        ));
        let c = b"HTTP/1.1 400 Bad\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2;x=y\r\nde\r\n0\r\n\r\n";
        assert!(complete(c));
        assert_eq!(parse_response(c).unwrap(), (400, "abcde".to_string()));
        assert!(!complete(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n"
        ));
    }

    #[test]
    fn posts_and_keeps_alive() {
        // A server that answers and keeps the connection open: the client must stop at Content-Length.
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut got: Vec<u8> = Vec::new();
            let mut buf = [0u8; 1024];
            loop {
                let n = s.read(&mut buf).unwrap();
                got.extend_from_slice(&buf[..n]);
                if let Some(i) = find(&got, b"\r\n\r\n") {
                    if got.len() >= i + 4 + 7 {
                        break;
                    }
                }
            }
            let text = String::from_utf8_lossy(&got).into_owned();
            assert!(text.starts_with("POST /jsonrpc HTTP/1.1\r\n"));
            assert!(text.contains("Content-Length: 7\r\n"));
            let body = format!("echo:{}", &text[text.len() - 7..]);
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            s.write_all(resp.as_bytes()).unwrap();
            thread::sleep(Duration::from_secs(3));
        });
        let t0 = std::time::Instant::now();
        let r = post(port, "/jsonrpc", "{\"a\":1}", Duration::from_secs(10)).unwrap();
        assert_eq!(r, (200, "echo:{\"a\":1}".to_string()));
        assert!(t0.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn refused() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        assert!(post(port, "/jsonrpc", "{}", Duration::from_secs(1)).is_err());
    }
}
