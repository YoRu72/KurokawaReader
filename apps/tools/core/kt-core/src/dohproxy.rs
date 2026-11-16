// The small HTTP proxy aria2 is pointed at while DNS over HTTPS is on (stage 0.21 P9) — aria2 has no hook for a
// resolver of ours, but it takes a proxy (all-proxy): its downloads (CONNECT for https, a plain GET for http) and its
// HTTP trackers' announces come here, and here each site's name is found by the shell's resolver (the DoH chain:
// dohchain.rs's rules), never by the network's DNS. On 127.0.0.1 only, with a password of its own from the system's
// randomness (handed to aria2 in its config file or over RPC — never on its command line, which other programs can
// read), checked whole and in constant time before a thread is given to the connection; at most MAX_CONNS at once; the
// proxy's own headers (Proxy-Authorization) never reach a site. FTP is not carried (aria2 is given it as http-proxy and
// https-proxy only). desktop/dohchain.cjs is Electron's twin. Std only: `rustc --edition 2021 --test dohproxy.rs`.
use std::io::{self, Read, Write};
use std::net::{IpAddr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// The resolver the proxy asks: a host → its addresses (or why not).
pub type Resolve = Arc<dyn Fn(&str) -> Result<Vec<IpAddr>, String> + Send + Sync>;

const HEAD_MAX: usize = 32 * 1024;
const IDLE: Duration = Duration::from_secs(300);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Connections served at once (aria2 opens at most 16 a download, a few downloads at a time).
pub const MAX_CONNS: u64 = 128;
/// How long a new connection has to send its request head (read before a thread is given to it).
const HEAD_TIMEOUT: Duration = Duration::from_secs(5);

/// 16 bytes from the system's randomness, as hex: /dev/urandom where there is one; elsewhere (Windows) std's
/// hasher keys, which std seeds from the system's generator (ProcessPrng / BCryptGenRandom), run as a keyed PRF.
pub fn os_secret() -> String {
    let mut b = [0u8; 16];
    let mut got = false;
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        got = f.read_exact(&mut b).is_ok();
    }
    if !got {
        use std::hash::{BuildHasher, Hasher};
        for (i, chunk) in b.chunks_mut(8).enumerate() {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_usize(i);
            h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
            chunk.copy_from_slice(&h.finish().to_le_bytes());
        }
    }
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

/// Equal, in time that depends on the lengths only.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub struct Proxy {
    port: u16,
    bound: SocketAddr,
    user: String,
    pass: String,
    stop: Arc<AtomicBool>,
    pub tunnels: Arc<AtomicU64>,
    pub refused: Arc<AtomicU64>,
    accept: Option<thread::JoinHandle<()>>,
}

impl Proxy {
    pub fn port(&self) -> u16 {
        self.port
    }
    /// The address the listening socket is bound to.
    pub fn bound(&self) -> SocketAddr {
        self.bound
    }
    /// The proxy with its user and password (for aria2's RPC, never its command line).
    pub fn url(&self) -> String {
        format!("http://{}:{}@127.0.0.1:{}", self.user, self.pass, self.port)
    }
    /// The proxy alone, and its user and password apart (aria2's http-proxy, http-proxy-user, http-proxy-passwd).
    pub fn address(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
    pub fn user(&self) -> &str {
        &self.user
    }
    pub fn password(&self) -> &str {
        &self.pass
    }
    /// The listener closed (connections under way end by themselves: their reads time out or their ends close).
    pub fn stop(mut self) {
        self.halt();
    }
    fn halt(&mut self) {
        if self.stop.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], self.port)), Duration::from_secs(1));
        if let Some(h) = self.accept.take() {
            let _ = h.join();
        }
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.halt();
    }
}

/// base64 (standard, padded) — for the Proxy-Authorization check.
pub fn b64(d: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for c in d.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        s.push(T[(n >> 18 & 63) as usize] as char);
        s.push(T[(n >> 12 & 63) as usize] as char);
        s.push(if c.len() > 1 { T[(n >> 6 & 63) as usize] as char } else { '=' });
        s.push(if c.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    s
}

/// The proxy started on 127.0.0.1 (a free port), its password from the system's randomness (`os_secret`).
pub fn start(resolve: Resolve) -> io::Result<Proxy> {
    let l = TcpListener::bind(("127.0.0.1", 0))?;
    let bound = l.local_addr()?;
    let port = bound.port();
    let user = "kt".to_string();
    let pass = os_secret();
    let want = b64(format!("{}:{}", user, pass).as_bytes());
    let stop = Arc::new(AtomicBool::new(false));
    let tunnels = Arc::new(AtomicU64::new(0));
    let refused = Arc::new(AtomicU64::new(0));
    let open = Arc::new(AtomicU64::new(0));
    let (s2, t2, r2) = (stop.clone(), tunnels.clone(), refused.clone());
    let accept = thread::Builder::new().name("kt-doh-proxy".into()).spawn(move || {
        for c in l.incoming() {
            if s2.load(Ordering::SeqCst) {
                break;
            }
            let Ok(mut c) = c else { continue };
            if open.load(Ordering::SeqCst) >= MAX_CONNS {
                r2.fetch_add(1, Ordering::Relaxed);
                reply(&mut c, "503 Service Unavailable", "busy");
                continue;
            }
            // (The head read and the password checked here, before a thread is given to the connection.)
            let _ = c.set_read_timeout(Some(HEAD_TIMEOUT));
            let Ok((head, rest)) = read_head(&mut c) else { continue };
            if !authorized(&head, &want) {
                r2.fetch_add(1, Ordering::Relaxed);
                reply(&mut c, "407 Proxy Authentication Required", "auth");
                continue;
            }
            let (res, t, o) = (resolve.clone(), t2.clone(), open.clone());
            o.fetch_add(1, Ordering::SeqCst);
            let spawned = thread::Builder::new().name("kt-doh-proxy-c".into()).spawn(move || {
                let _ = serve(c, head, rest, &res, &t);
                o.fetch_sub(1, Ordering::SeqCst);
            });
            if spawned.is_err() {
                open.fetch_sub(1, Ordering::SeqCst);
            }
        }
    })?;
    Ok(Proxy { port, bound, user, pass, stop, tunnels, refused, accept: Some(accept) })
}

/// The head carries «Proxy-Authorization: Basic <exactly the proxy's own>» (the scheme in any case, the
/// credential compared whole, in constant time).
fn authorized(head: &str, want_b64: &str) -> bool {
    let mut ok = false;
    for h in head.split("\r\n").skip(1) {
        if let Some((k, v)) = h.split_once(':') {
            if k.trim().eq_ignore_ascii_case("proxy-authorization") {
                let v = v.trim();
                if v.len() > 6 && v[..6].eq_ignore_ascii_case("basic ") {
                    ok |= ct_eq(v[6..].trim().as_bytes(), want_b64.as_bytes());
                }
            }
        }
    }
    ok
}

/// The request's head (up to the blank line) and whatever came after it.
fn read_head(c: &mut TcpStream) -> io::Result<(String, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buf.split_off(i + 4);
            return Ok((String::from_utf8_lossy(&buf).to_string(), rest));
        }
        if buf.len() > HEAD_MAX {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "head too long"));
        }
        let n = c.read(&mut chunk)?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "closed"));
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn reply(c: &mut TcpStream, status: &str, why: &str) {
    let extra = if status.starts_with("407") { "Proxy-Authenticate: Basic realm=\"kt\"\r\n" } else { "" };
    let body = why.replace(['\r', '\n'], " ");
    let _ = write!(c, "HTTP/1.1 {}\r\n{}X-Kt-Doh: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", status, extra, body, body.len(), body);
}

/// host:port split (an IPv6 address in brackets); `default` when no port is written.
pub fn split_host_port(s: &str, default: u16) -> Option<(String, u16)> {
    let (h, p) = if let Some(rest) = s.strip_prefix('[') {
        let (h, after) = rest.split_once(']')?;
        (h.to_string(), after.strip_prefix(':'))
    } else {
        match s.rsplit_once(':') {
            Some((h, p)) if !h.contains(':') => (h.to_string(), Some(p)),
            _ => (s.to_string(), None),
        }
    };
    let port = match p {
        Some(p) => p.parse().ok()?,
        None => default,
    };
    if h.is_empty() || port == 0 {
        return None;
    }
    Some((h, port))
}

fn dial(host: &str, port: u16, resolve: &Resolve) -> Result<TcpStream, String> {
    let ips = match host.parse::<IpAddr>() {
        Ok(ip) => vec![ip],
        Err(_) => resolve(host)?,
    };
    let mut last = String::from("no address");
    for ip in ips {
        match TcpStream::connect_timeout(&SocketAddr::new(ip, port), CONNECT_TIMEOUT) {
            Ok(s) => return Ok(s),
            Err(e) => last = e.to_string(),
        }
    }
    Err(last)
}

fn pump(mut from: TcpStream, mut to: TcpStream) {
    let mut b = [0u8; 16384];
    loop {
        match from.read(&mut b) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if to.write_all(&b[..n]).is_err() {
                    break;
                }
            }
        }
    }
    let _ = to.shutdown(Shutdown::Write);
}

fn serve(mut c: TcpStream, head: String, rest: Vec<u8>, resolve: &Resolve, tunnels: &AtomicU64) -> io::Result<()> {
    c.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or("");
    let parts: Vec<&str> = first.split(' ').collect();
    if parts.len() != 3 {
        reply(&mut c, "400 Bad Request", "bad request");
        return Ok(());
    }
    let headers: Vec<&str> = lines.filter(|l| !l.is_empty()).collect();
    let (method, target) = (parts[0], parts[1]);
    if method.eq_ignore_ascii_case("CONNECT") {
        let Some((host, port)) = split_host_port(target, 443) else {
            reply(&mut c, "400 Bad Request", "bad target");
            return Ok(());
        };
        let site = match dial(&host, port, resolve) {
            Ok(s) => s,
            Err(e) => {
                reply(&mut c, "502 Bad Gateway", &e);
                return Ok(());
            }
        };
        tunnels.fetch_add(1, Ordering::Relaxed);
        c.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")?;
        let mut up = site.try_clone()?;
        if !rest.is_empty() {
            up.write_all(&rest)?;
        }
        for s in [&c, &site] {
            s.set_read_timeout(Some(IDLE))?;
        }
        let (c2, s2) = (c.try_clone()?, site.try_clone()?);
        let t = thread::spawn(move || pump(c2, s2));
        pump(site, c);
        let _ = t.join();
        return Ok(());
    }
    // A plain http request with the whole address: sent on in origin form, the proxy's own headers left out.
    let Some(after) = target.strip_prefix("http://") else {
        reply(&mut c, "400 Bad Request", "only http:// or CONNECT");
        return Ok(());
    };
    let (auth, path) = match after.find('/') {
        Some(i) => (&after[..i], &after[i..]),
        None => (after, "/"),
    };
    let Some((host, port)) = split_host_port(auth, 80) else {
        reply(&mut c, "400 Bad Request", "bad target");
        return Ok(());
    };
    let mut site = match dial(&host, port, resolve) {
        Ok(s) => s,
        Err(e) => {
            reply(&mut c, "502 Bad Gateway", &e);
            return Ok(());
        }
    };
    tunnels.fetch_add(1, Ordering::Relaxed);
    let mut out = format!("{} {} {}\r\n", method, path, parts[2]);
    for h in headers {
        let k = h.split(':').next().unwrap_or("").trim().to_ascii_lowercase();
        if k.starts_with("proxy-") || k == "connection" || k == "keep-alive" {
            continue;
        }
        out.push_str(h);
        out.push_str("\r\n");
    }
    out.push_str("Connection: close\r\n\r\n");
    site.write_all(out.as_bytes())?;
    if !rest.is_empty() {
        site.write_all(&rest)?;
    }
    for s in [&c, &site] {
        s.set_read_timeout(Some(IDLE))?;
    }
    let (c2, s2) = (c.try_clone()?, site.try_clone()?);
    let t = thread::spawn(move || pump(c2, s2));
    pump(site, c);
    let _ = t.join();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn resolver(asked: Arc<Mutex<Vec<String>>>) -> Resolve {
        Arc::new(move |h: &str| {
            asked.lock().unwrap().push(h.to_string());
            if h == "files.test" { Ok(vec!["127.0.0.1".parse().unwrap()]) } else { Err(format!("no DoH answer for {}", h)) }
        })
    }

    fn auth(p: &Proxy) -> String {
        format!("Proxy-Authorization: basic {}\r\n", b64(format!("{}:{}", p.user(), p.password()).as_bytes()))
    }

    #[test]
    fn secrets_and_compare() {
        let (a, b) = (os_secret(), os_secret());
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
        assert!(ct_eq(b"abc", b"abc") && !ct_eq(b"abc", b"abd") && !ct_eq(b"abc", b"abcd"));
        assert!(authorized("CONNECT x:1 HTTP/1.1\r\nProxy-Authorization: BASIC a3Q6eA==", "a3Q6eA=="));
        assert!(!authorized("CONNECT x:1 HTTP/1.1\r\nProxy-Authorization: Basic a3Q6eA==x", "a3Q6eA=="));
        assert!(!authorized("CONNECT x:1 HTTP/1.1\r\nProxy-Authorization: Bearer a3Q6eA==", "a3Q6eA=="));
    }

    fn read_all(s: &mut TcpStream) -> String {
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut v = Vec::new();
        let _ = s.read_to_end(&mut v);
        String::from_utf8_lossy(&v).to_string()
    }

    #[test]
    fn base64() {
        assert_eq!(b64(b"kt:abc"), "a3Q6YWJj");
        assert_eq!(b64(b"Ma"), "TWE=");
        assert_eq!(b64(b""), "");
    }

    #[test]
    fn host_port() {
        assert_eq!(split_host_port("files.test:8443", 443), Some(("files.test".into(), 8443)));
        assert_eq!(split_host_port("files.test", 80), Some(("files.test".into(), 80)));
        assert_eq!(split_host_port("[2001:db8::1]:443", 1), Some(("2001:db8::1".into(), 443)));
        assert_eq!(split_host_port("[2001:db8::1]", 80), Some(("2001:db8::1".into(), 80)));
        assert_eq!(split_host_port("files.test:x", 80), None);
        assert_eq!(split_host_port(":80", 80), None);
        assert_eq!(split_host_port("a:0", 80), None);
    }

    #[test]
    fn connect_get_auth_and_refusals() {
        // The «site»: echoes what it read on the tunnel; answers a plain GET with what it was sent.
        let site = TcpListener::bind("127.0.0.1:0").unwrap();
        let sport = site.local_addr().unwrap().port();
        thread::spawn(move || {
            for c in site.incoming().take(2) {
                let mut c = c.unwrap();
                c.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut b = [0u8; 4096];
                let n = c.read(&mut b).unwrap_or(0);
                let got = String::from_utf8_lossy(&b[..n]).to_string();
                if got.starts_with("HELLO") {
                    c.write_all(format!("ECHO {}", got).as_bytes()).unwrap();
                } else {
                    let body = got.replace("\r\n", "|");
                    c.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}", body.len(), body).as_bytes()).unwrap();
                }
            }
        });
        let asked = Arc::new(Mutex::new(Vec::new()));
        let p = start(resolver(asked.clone())).unwrap();
        assert_eq!(p.address(), format!("http://127.0.0.1:{}", p.port()));
        // (Bound to the loopback address itself: not reachable from another machine.)
        assert_eq!(p.bound().ip(), IpAddr::from([127, 0, 0, 1]));
        // CONNECT by name: resolved by the resolver, the tunnel carries bytes both ways.
        let mut c = TcpStream::connect(("127.0.0.1", p.port())).unwrap();
        write!(c, "CONNECT files.test:{} HTTP/1.1\r\nHost: files.test\r\n{}\r\nHELLO-TLS", sport, auth(&p)).unwrap();
        c.shutdown(Shutdown::Write).unwrap();
        let got = read_all(&mut c);
        assert!(got.starts_with("HTTP/1.1 200"), "{}", got);
        assert!(got.ends_with("ECHO HELLO-TLS"), "{}", got);
        // A plain GET: origin form, the proxy's headers gone, Connection: close.
        let mut g = TcpStream::connect(("127.0.0.1", p.port())).unwrap();
        write!(g, "GET http://files.test:{}/a/b?c=1 HTTP/1.1\r\nHost: files.test\r\nProxy-Connection: keep-alive\r\n{}PROXY-AUTHORIZATION: Basic eA==\r\nX-Q: 1\r\n\r\n", sport, auth(&p)).unwrap();
        let got = read_all(&mut g);
        assert!(got.contains("GET /a/b?c=1 HTTP/1.1|Host: files.test|X-Q: 1|Connection: close"), "{}", got);
        assert!(!got.to_ascii_lowercase().contains("proxy-"), "{}", got);
        assert_eq!(asked.lock().unwrap().clone(), vec!["files.test".to_string(), "files.test".to_string()]);
        assert_eq!(p.tunnels.load(Ordering::Relaxed), 2);
        // Without the password: refused, nothing resolved.
        let mut n = TcpStream::connect(("127.0.0.1", p.port())).unwrap();
        write!(n, "CONNECT files.test:{} HTTP/1.1\r\n\r\n", sport).unwrap();
        assert!(read_all(&mut n).starts_with("HTTP/1.1 407"));
        assert_eq!(p.refused.load(Ordering::Relaxed), 1);
        // A name the resolver cannot give: 502 with its reason — the network's DNS is never asked here.
        let mut u = TcpStream::connect(("127.0.0.1", p.port())).unwrap();
        write!(u, "CONNECT nowhere.test:443 HTTP/1.1\r\n{}\r\n", auth(&p)).unwrap();
        let got = read_all(&mut u);
        assert!(got.starts_with("HTTP/1.1 502") && got.contains("no DoH answer for nowhere.test"), "{}", got);
        // Stopped: the port no longer listens.
        let port = p.port();
        p.stop();
        thread::sleep(Duration::from_millis(100));
        assert!(TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(500)).is_err());
        let _ = asked;
    }
}
