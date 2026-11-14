// Stage P8: the rules of the app's two small servers and of the antivirus check, without a socket or a process
// (lanshare.rs does those) — desktop/wifishare.cjs (files shared over Wi-Fi: every interface, a random key in the
// address, the shared files by number only, ranges), desktop/localapi.cjs (127.0.0.1 only, a token on every request:
// add downloads, read the queue, pause / resume / remove) and desktop/antivirus.cjs (Defender, ClamAV or the user's own
// command). Std only, checked alone with `rustc --edition 2021 --test lanlogic.rs`; hostile inputs in the tests.
//
// Safety, by construction: a request names a shared file only by its number in the list the app made (never a path,
// so no traversal or link can reach anything else); the key and the token are compared in constant time; a request's
// head is at most HEAD_MAX bytes, a local API body at most BODY_MAX; nothing is listed but the shared files.

/// The most bytes of a request's head (request line + headers) either server reads.
pub const HEAD_MAX: usize = 16 * 1024;
/// The most bytes of a local API request's body (localapi.cjs: 1 MiB).
pub const BODY_MAX: usize = 1 << 20;
/// The most connections served at once by one server (the rest are closed at once).
pub const CONN_MAX: usize = 32;
/// A connection idle this long (seconds) is closed.
pub const IDLE_SECS: u64 = 30;
/// The local API's port when none is given (localapi.cjs).
pub const API_PORT: u16 = 8977;

/// Equal, in time that does not depend on where they differ (the lengths may show).
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut d: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        d |= x ^ y;
    }
    d == 0
}

/// A request's head.
#[derive(Debug, Clone, PartialEq)]
pub struct Head {
    pub method: String,
    /// The target as sent (path and query, still percent-encoded).
    pub target: String,
    /// Header names lowercase.
    pub headers: Vec<(String, String)>,
}

impl Head {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

/// Where a request's head ends in the bytes read so far (the index after the blank line), if it has.
pub fn head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4).or_else(|| buf.windows(2).position(|w| w == b"\n\n").map(|i| i + 2))
}

/// The head parsed (None: not an HTTP/1.x request, or broken).
pub fn parse_head(raw: &[u8]) -> Option<Head> {
    if raw.len() > HEAD_MAX {
        return None;
    }
    let text = std::str::from_utf8(raw).ok()?;
    let mut lines = text.split('\n').map(|l| l.trim_end_matches('\r'));
    let first = lines.next()?;
    let mut parts = first.split(' ');
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let version = parts.next()?;
    if parts.next().is_some() || !version.starts_with("HTTP/1.") || method.is_empty() || !method.bytes().all(|c| c.is_ascii_uppercase()) || !target.starts_with('/') {
        return None;
    }
    if target.bytes().any(|c| c <= 0x20 || c == 0x7f) {
        return None;
    }
    let mut headers = Vec::new();
    for l in lines {
        if l.is_empty() {
            break;
        }
        let i = l.find(':')?;
        let name = l[..i].trim().to_ascii_lowercase();
        if name.is_empty() || name.bytes().any(|c| c <= 0x20) {
            return None;
        }
        headers.push((name, l[i + 1..].trim().to_string()));
        if headers.len() > 100 {
            return None;
        }
    }
    Some(Head { method, target, headers })
}

/// Percent-decoding of a path (UTF-8; None when broken or when it would hold a NUL).
pub fn pct_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = (b.get(i + 1).copied().and_then(hexv), b.get(i + 2).copied().and_then(hexv));
            match h {
                (Some(x), Some(y)) => out.push(x * 16 + y),
                _ => return None,
            }
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    if out.contains(&0) {
        return None;
    }
    String::from_utf8(out).ok()
}

fn hexv(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// encodeURIComponent.
pub fn pct_encode(s: &str) -> String {
    let mut o = String::new();
    for c in s.bytes() {
        if c.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&c) {
            o.push(c as char);
        } else {
            o.push_str(&format!("%{:02X}", c));
        }
    }
    o
}

/// The HTML text of a name.
pub fn esc_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

/// wifishare.cjs's human().
pub fn human(b: u64) -> String {
    if b < 1024 {
        return format!("{} B", b);
    }
    let mut v = b as f64 / 1024.0;
    let u = ["KB", "MB", "GB", "TB"];
    let mut i = 0;
    while v >= 1024.0 && i < u.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if v >= 100.0 {
        format!("{:.0} {}", v, u[i])
    } else {
        format!("{:.1} {}", v, u[i])
    }
}

/// wifishare.cjs's MIME table.
pub fn mime_of(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "mp4" => "video/mp4",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "apk" => "application/vnd.android.package-archive",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "txt" => "text/plain",
        "srt" => "application/x-subrip",
        "epub" => "application/epub+zip",
        _ => "application/octet-stream",
    }
}

/// What a Wi-Fi share request asks for.
#[derive(Debug, PartialEq)]
pub enum ShareRoute {
    /// Not under the key (or broken): 404, not counted.
    NotFound,
    /// The list page.
    Index,
    /// The shared file of this number (whatever name follows it).
    File(usize),
    /// Under the key but nothing there: 404.
    Missing,
}

/// wifishare.cjs's routing: /<key>/ or /<key>/index.html → the list; /<key>/d/<n>/<name> → file n. The key compared
/// in constant time; the query ignored; «..» or a second slash anywhere refused.
pub fn share_route(target: &str, key: &str, count: usize) -> ShareRoute {
    let path = target.split(['?', '#']).next().unwrap_or("");
    let path = match pct_decode(path) {
        Some(p) => p,
        None => return ShareRoute::NotFound,
    };
    let rest = match path.strip_prefix('/') {
        Some(r) => r,
        None => return ShareRoute::NotFound,
    };
    let (k, after) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i + 1..]),
        None => return ShareRoute::NotFound,
    };
    if key.is_empty() || !ct_eq(k.as_bytes(), key.as_bytes()) {
        return ShareRoute::NotFound;
    }
    if after.is_empty() || after == "index.html" {
        return ShareRoute::Index;
    }
    if after.split('/').any(|s| s == ".." || s == ".") || after.contains("//") || after.contains('\\') {
        return ShareRoute::Missing;
    }
    let mut seg = after.split('/');
    if seg.next() != Some("d") {
        return ShareRoute::Missing;
    }
    let n = seg.next().unwrap_or("");
    if n.is_empty() || n.len() > 6 || !n.bytes().all(|c| c.is_ascii_digit()) || seg.next().is_none() {
        return ShareRoute::Missing;
    }
    match n.parse::<usize>() {
        Ok(i) if i < count => ShareRoute::File(i),
        _ => ShareRoute::Missing,
    }
}

/// What a Range header asks of a file of `size` bytes (wifishare.cjs's rule): None → the whole file (200);
/// Some(Ok((a, b))) → bytes a..=b (206); Some(Err(())) → 416.
pub fn range_of(h: Option<&str>, size: u64) -> Option<Result<(u64, u64), ()>> {
    let h = h?.trim();
    let spec = h.strip_prefix("bytes=")?;
    // (One range only, as Electron's regular expression takes the first.)
    let first = spec.split(',').next().unwrap_or("").trim();
    let (a, b) = first.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    if (!a.is_empty() && !a.bytes().all(|c| c.is_ascii_digit())) || (!b.is_empty() && !b.bytes().all(|c| c.is_ascii_digit())) || a.len() > 19 || b.len() > 19 {
        return Some(Err(()));
    }
    let last = size.checked_sub(1);
    let (mut x, mut y) = (0u64, last.unwrap_or(0));
    if !a.is_empty() {
        x = a.parse().map_err(|_| ()).ok()?;
    }
    if !b.is_empty() {
        let v: u64 = b.parse().map_err(|_| ()).ok()?;
        y = v.min(last.unwrap_or(0));
    }
    if a.is_empty() && !b.is_empty() {
        let n: u64 = b.parse().map_err(|_| ()).ok()?;
        x = size.saturating_sub(n);
        y = last.unwrap_or(0);
    }
    if a.is_empty() && b.is_empty() {
        return Some(Err(()));
    }
    if size == 0 || x > y || x >= size {
        return Some(Err(()));
    }
    Some(Ok((x, y)))
}

/// The list page (wifishare.cjs's, its HTML as it is): (name, size) of each shared file.
pub fn index_html(files: &[(String, u64)]) -> String {
    let mut rows = String::new();
    for (i, (name, size)) in files.iter().enumerate() {
        rows.push_str(&format!("<a href='d/{}/{}' download><span>{}</span><small>{}</small></a>", i, pct_encode(name), esc_html(name), human(*size)));
    }
    format!("<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Kurokawa Tools</title><style>body{{font-family:system-ui,sans-serif;margin:0;background:#141218;color:#e6e0e9}}h1{{font-size:18px;padding:18px 20px;margin:0;background:#211f26}}a{{display:flex;justify-content:space-between;gap:12px;padding:14px 20px;color:#d0bcff;text-decoration:none;border-bottom:1px solid #2b2930}}a:hover{{background:#1d1b20}}small{{color:#cac4d0}}p{{padding:10px 20px;color:#cac4d0;font-size:13px}}</style></head><body><h1>Kurokawa Tools</h1>{}<p>{} file(s)</p></body></html>", rows, files.len())
}

/// The computer's address to show: a private IPv4 (10/8, 172.16/12, 192.168/16) first, else another non-loopback
/// IPv4 (wifishare.cjs's lanIp prefers Wi-Fi / Ethernet by the interface's name, then a private one).
pub fn pick_lan_ip(cands: &[std::net::Ipv4Addr]) -> Option<std::net::Ipv4Addr> {
    let ok = |a: &&std::net::Ipv4Addr| !a.is_loopback() && !a.is_unspecified() && !a.is_link_local() && !a.is_multicast() && !a.is_broadcast();
    cands.iter().filter(ok).find(|a| a.is_private()).or_else(|| cands.iter().find(ok)).copied()
}

/// A local API request's token: «Authorization: Bearer <t>» (or the bare value), else ?token= (localapi.cjs).
pub fn api_token(auth: Option<&str>, target: &str) -> String {
    let a = auth.unwrap_or("").trim();
    let a = if a.len() >= 7 && a[..7].eq_ignore_ascii_case("bearer ") { a[7..].trim() } else { a };
    if !a.is_empty() {
        return a.to_string();
    }
    let q = match target.split_once('?') {
        Some((_, q)) => q.split('#').next().unwrap_or(""),
        None => return String::new(),
    };
    for kv in q.split('&') {
        if let Some(v) = kv.strip_prefix("token=") {
            return pct_decode(&v.replace('+', " ")).unwrap_or_default();
        }
    }
    String::new()
}

/// Whether the token given is the one in force (never when none is set).
pub fn api_token_ok(given: &str, token: &str) -> bool {
    !token.is_empty() && ct_eq(given.as_bytes(), token.as_bytes())
}

/// What a local API request asks for (localapi.cjs's routes).
#[derive(Debug, PartialEq)]
pub enum ApiRoute {
    Preflight,
    Tasks,
    Version,
    Add,
    Act(String, String),
    NotFound,
}

pub fn api_route(method: &str, target: &str) -> ApiRoute {
    let path = target.split(['?', '#']).next().unwrap_or("");
    match (method, path) {
        ("OPTIONS", _) => ApiRoute::Preflight,
        ("GET", "/tasks") => ApiRoute::Tasks,
        ("GET", "/version") => ApiRoute::Version,
        ("POST", "/add") => ApiRoute::Add,
        ("POST", p) => {
            let seg: Vec<&str> = p.split('/').collect();
            if seg.len() == 4 && seg[0].is_empty() && seg[1] == "tasks" && !seg[2].is_empty() && matches!(seg[3], "pause" | "resume" | "remove") {
                match pct_decode(seg[2]) {
                    Some(id) if !id.is_empty() && id.len() <= 128 => ApiRoute::Act(id, seg[3].to_string()),
                    _ => ApiRoute::NotFound,
                }
            } else {
                ApiRoute::NotFound
            }
        }
        _ => ApiRoute::NotFound,
    }
}

/// localapi.cjs's CORS headers (on every answer).
pub const CORS: [(&str, &str); 3] = [
    ("Access-Control-Allow-Origin", "*"),
    ("Access-Control-Allow-Headers", "Authorization, Content-Type"),
    ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
];

/// A response's head.
pub fn response_head(status: &str, headers: &[(&str, String)]) -> String {
    let mut h = format!("HTTP/1.1 {}\r\n", status);
    for (k, v) in headers.iter() {
        let v: String = v.chars().filter(|c| *c != '\r' && *c != '\n').collect();
        h.push_str(&format!("{}: {}\r\n", k, v));
    }
    h.push_str("Connection: close\r\n\r\n");
    h
}

/* ---------- the antivirus (antivirus.cjs) ---------- */

/// «a "b c" d» → [a, b c, d].
pub fn split_args(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let (mut q, mut has) = (false, false);
    for ch in s.chars() {
        if ch == '"' {
            q = !q;
            has = true;
        } else if ch.is_whitespace() && !q {
            if has {
                out.push(std::mem::take(&mut cur));
            }
            cur.clear();
            has = false;
        } else {
            cur.push(ch);
            has = true;
        }
    }
    if has {
        out.push(cur);
    }
    out
}

/// Whether a file is one of the kinds chosen (none chosen: every file).
pub fn av_wanted(exts: &[String], file: &str) -> bool {
    let want: Vec<String> = exts.iter().map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase()).filter(|e| !e.is_empty()).collect();
    if want.is_empty() {
        return true;
    }
    let base = file.rsplit(['/', '\\']).next().unwrap_or(file);
    let ext = match base.rfind('.') {
        Some(i) if i > 0 => base[i + 1..].to_ascii_lowercase(),
        _ => String::new(),
    };
    want.contains(&ext)
}

/// The scanner chosen: kind ('auto' → Defender on Windows, ClamAV elsewhere), and its arguments with {file}.
pub fn av_kind(kind: &str, windows: bool) -> String {
    if kind.is_empty() || kind == "auto" {
        if windows { "defender" } else { "clamav" }.to_string()
    } else {
        kind.to_string()
    }
}

pub fn av_args(kind: &str, custom_args: &str) -> Vec<String> {
    match kind {
        "defender" => ["-Scan", "-ScanType", "3", "-File", "{file}", "-DisableRemediation"].iter().map(|s| s.to_string()).collect(),
        "clamav" => vec!["--no-summary".to_string(), "{file}".to_string()],
        _ => split_args(if custom_args.trim().is_empty() { "{file}" } else { custom_args }),
    }
}

/// Each argument with its first {file} replaced (antivirus.cjs's replace).
pub fn av_fill(args: &[String], file: &str) -> Vec<String> {
    args.iter().map(|a| a.replacen("{file}", file, 1)).collect()
}

/// The verdict of an exit code (None: killed / no code): 'clean' | 'infected' | 'error'.
pub fn av_verdict(kind: &str, code: Option<i32>) -> &'static str {
    match code {
        Some(0) => "clean",
        Some(c) => {
            let threat = match kind {
                "defender" => c == 2,
                "clamav" => c == 1,
                _ => true,
            };
            if threat {
                "infected"
            } else {
                "error"
            }
        }
        None => "error",
    }
}

/// The first six non-empty lines of a scanner's output.
pub fn av_detail(out: &str) -> String {
    out.lines().filter(|l| !l.trim().is_empty()).take(6).collect::<Vec<_>>().join("\n")
}

/// Defender's newest MpCmdRun.exe among the Platform folder's versions (their names), else None.
pub fn defender_pick(versions: &[String]) -> Option<String> {
    let mut v: Vec<&String> = versions.iter().collect();
    v.sort();
    v.last().map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heads() {
        let h = parse_head(b"GET /k/d/0/a.mkv?x=1 HTTP/1.1\r\nHost: x\r\nRange: bytes=0-9\r\n\r\n").unwrap();
        assert_eq!(h.method, "GET");
        assert_eq!(h.target, "/k/d/0/a.mkv?x=1");
        assert_eq!(h.header("range"), Some("bytes=0-9"));
        assert_eq!(head_end(b"GET / HTTP/1.1\r\n\r\nrest"), Some(18));
        assert_eq!(head_end(b"GET / HTTP/1.1\r\n"), None);
        // (Hostile: not HTTP, an absolute target, a space in it, a lowercase method, a header without a colon, too long.)
        assert!(parse_head(b"\x16\x03\x01garbage").is_none());
        assert!(parse_head(b"GET http://evil/ HTTP/1.1\r\n\r\n").is_none());
        assert!(parse_head(b"GET /a b HTTP/1.1\r\n\r\n").is_none());
        assert!(parse_head(b"get / HTTP/1.1\r\n\r\n").is_none());
        assert!(parse_head(b"GET / HTTP/1.1\r\nBroken\r\n\r\n").is_none());
        assert!(parse_head(b"GET / HTTP/2\r\n\r\n").is_none());
        assert!(parse_head(&vec![b'a'; HEAD_MAX + 1]).is_none());
        let many: String = (0..150).map(|i| format!("X{}: y\r\n", i)).collect();
        assert!(parse_head(format!("GET / HTTP/1.1\r\n{}\r\n", many).as_bytes()).is_none());
    }

    #[test]
    fn constant_time() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
        assert!(api_token_ok("t0k", "t0k"));
        assert!(!api_token_ok("", ""));
        assert!(!api_token_ok("x", ""));
    }

    #[test]
    fn share_routes() {
        let k = "a1b2c3d4e5f6";
        assert_eq!(share_route("/a1b2c3d4e5f6/", k, 2), ShareRoute::Index);
        assert_eq!(share_route("/a1b2c3d4e5f6/index.html", k, 2), ShareRoute::Index);
        assert_eq!(share_route("/a1b2c3d4e5f6/d/1/x%20y.mkv?z", k, 2), ShareRoute::File(1));
        assert_eq!(share_route("/a1b2c3d4e5f6/d/2/x", k, 2), ShareRoute::Missing);
        // (Hostile: a wrong or empty key, traversal plain and encoded, backslashes, a number too long, no name, NUL.)
        assert_eq!(share_route("/a1b2c3d4e5f7/", k, 2), ShareRoute::NotFound);
        assert_eq!(share_route("/a1b2c3d4e5f6", k, 2), ShareRoute::NotFound);
        assert_eq!(share_route("//", "", 2), ShareRoute::NotFound);
        assert_eq!(share_route("/a1b2c3d4e5f6/../../etc/passwd", k, 2), ShareRoute::Missing);
        assert_eq!(share_route("/a1b2c3d4e5f6/d/0/..%2F..%2Fsecret", k, 2), ShareRoute::Missing);
        assert_eq!(share_route("/a1b2c3d4e5f6/d/%2e%2e/x", k, 2), ShareRoute::Missing);
        assert_eq!(share_route("/a1b2c3d4e5f6/d/0\\..\\x", k, 2), ShareRoute::Missing);
        assert_eq!(share_route("/a1b2c3d4e5f6/d/99999999999999999999/x", k, 2), ShareRoute::Missing);
        assert_eq!(share_route("/a1b2c3d4e5f6/d/0", k, 2), ShareRoute::Missing);
        assert_eq!(share_route("/a1b2c3d4e5f6/d/0/a%00b", k, 2), ShareRoute::NotFound);
        assert_eq!(share_route("/a1b2c3d4e5f6/d/0/%zz", k, 2), ShareRoute::NotFound);
        assert_eq!(share_route("/a1b2c3d4e5f6/d/-1/x", k, 2), ShareRoute::Missing);
        assert_eq!(share_route("/a1b2c3d4e5f6/d/+1/x", k, 2), ShareRoute::Missing);
    }

    #[test]
    fn ranges() {
        assert_eq!(range_of(None, 100), None);
        assert_eq!(range_of(Some("bytes=0-9"), 100), Some(Ok((0, 9))));
        assert_eq!(range_of(Some("bytes=90-"), 100), Some(Ok((90, 99))));
        assert_eq!(range_of(Some("bytes=-10"), 100), Some(Ok((90, 99))));
        assert_eq!(range_of(Some("bytes=50-500"), 100), Some(Ok((50, 99))));
        assert_eq!(range_of(Some("bytes=-500"), 100), Some(Ok((0, 99))));
        assert_eq!(range_of(Some("bytes=0-1,5-6"), 100), Some(Ok((0, 1))));
        assert_eq!(range_of(Some("bytes=100-"), 100), Some(Err(())));
        assert_eq!(range_of(Some("bytes=9-3"), 100), Some(Err(())));
        assert_eq!(range_of(Some("bytes=-"), 100), Some(Err(())));
        assert_eq!(range_of(Some("bytes=0-9"), 0), Some(Err(())));
        assert_eq!(range_of(Some("bytes=x-1"), 100), Some(Err(())));
        assert_eq!(range_of(Some("bytes=99999999999999999999999-"), 100), Some(Err(())));
        // (Not «bytes=»: ignored, the whole file — as Electron's regular expression finds nothing.)
        assert_eq!(range_of(Some("items=0-1"), 100), None);
    }

    #[test]
    fn page_and_names() {
        let h = index_html(&[("a<b>&\"c'.mkv".to_string(), 1536), ("ü x.mp4".to_string(), 5)]);
        assert!(h.contains("<span>a&lt;b&gt;&amp;&quot;c&#39;.mkv</span><small>1.5 KB</small>"));
        assert!(h.contains("href='d/1/%C3%BC%20x.mp4'"));
        assert!(h.contains("<p>2 file(s)</p>"));
        assert!(!h.contains("<b>"));
        assert_eq!(human(1000), "1000 B");
        assert_eq!(human(150 * 1024 * 1024), "150 MB");
        assert_eq!(mime_of("A.MKV"), "video/x-matroska");
        assert_eq!(mime_of("noext"), "application/octet-stream");
        assert_eq!(pct_decode("a%2Fb%C3%BC").as_deref(), Some("a/bü"));
        assert_eq!(pct_decode("%"), None);
        assert_eq!(pct_decode("%4"), None);
        assert_eq!(pct_decode("%ff"), None);
        let rh = response_head("200 OK", &[("X-A", "1\r\nSet-Cookie: evil".to_string())]);
        assert!(rh.contains("X-A: 1Set-Cookie: evil\r\n") && rh.ends_with("Connection: close\r\n\r\n"));
    }

    #[test]
    fn lan_ip() {
        use std::net::Ipv4Addr;
        let c = [Ipv4Addr::new(127, 0, 0, 1), Ipv4Addr::new(169, 254, 1, 2), Ipv4Addr::new(8, 8, 8, 8), Ipv4Addr::new(192, 168, 1, 5)];
        assert_eq!(pick_lan_ip(&c), Some(Ipv4Addr::new(192, 168, 1, 5)));
        assert_eq!(pick_lan_ip(&c[..3]), Some(Ipv4Addr::new(8, 8, 8, 8)));
        assert_eq!(pick_lan_ip(&c[..2]), None);
    }

    #[test]
    fn api() {
        assert_eq!(api_token(Some("Bearer abc"), "/tasks"), "abc");
        assert_eq!(api_token(Some("bearer  abc "), "/tasks"), "abc");
        assert_eq!(api_token(None, "/tasks?x=1&token=a%2Bb"), "a+b");
        assert_eq!(api_token(Some(""), "/tasks"), "");
        assert_eq!(api_route("GET", "/tasks?token=1"), ApiRoute::Tasks);
        assert_eq!(api_route("GET", "/version"), ApiRoute::Version);
        assert_eq!(api_route("POST", "/add"), ApiRoute::Add);
        assert_eq!(api_route("OPTIONS", "/anything"), ApiRoute::Preflight);
        assert_eq!(api_route("POST", "/tasks/abc%2F1/pause"), ApiRoute::Act("abc/1".into(), "pause".into()));
        assert_eq!(api_route("POST", "/tasks/a/delete"), ApiRoute::NotFound);
        assert_eq!(api_route("GET", "/tasks/a/pause"), ApiRoute::NotFound);
        assert_eq!(api_route("POST", "/tasks//pause"), ApiRoute::NotFound);
        assert_eq!(api_route("POST", "/tasks/a/b/pause"), ApiRoute::NotFound);
        assert_eq!(api_route("DELETE", "/tasks"), ApiRoute::NotFound);
    }

    #[test]
    fn antivirus() {
        assert_eq!(split_args(r#"-a "b c" {file}  d"#), vec!["-a", "b c", "{file}", "d"]);
        assert_eq!(split_args(r#""""#), vec![""]);
        assert!(split_args("   ").is_empty());
        assert!(av_wanted(&[], "/x/a.exe"));
        assert!(av_wanted(&[".EXE".into(), " zip".into()], "C:\\d\\A.Exe"));
        assert!(!av_wanted(&["exe".into()], "/x/a.exe.mkv"));
        assert!(!av_wanted(&["exe".into()], "/x/.exe"));
        assert_eq!(av_kind("auto", true), "defender");
        assert_eq!(av_kind("", false), "clamav");
        assert_eq!(av_kind("custom", false), "custom");
        assert_eq!(av_fill(&av_args("clamav", ""), "/f"), vec!["--no-summary", "/f"]);
        assert_eq!(av_fill(&av_args("custom", "--scan {file} {file}{file}"), "/f"), vec!["--scan", "/f", "/f{file}"]);
        assert_eq!(av_args("custom", ""), vec!["{file}"]);
        assert_eq!(av_verdict("defender", Some(2)), "infected");
        assert_eq!(av_verdict("defender", Some(1)), "error");
        assert_eq!(av_verdict("clamav", Some(1)), "infected");
        assert_eq!(av_verdict("clamav", Some(2)), "error");
        assert_eq!(av_verdict("custom", Some(3)), "infected");
        assert_eq!(av_verdict("custom", None), "error");
        assert_eq!(av_verdict("clamav", Some(0)), "clean");
        assert_eq!(av_detail("\n a\n\nb\nc\nd\ne\nf\ng\n"), " a\nb\nc\nd\ne\nf");
        assert_eq!(defender_pick(&["4.18.2001.10".into(), "4.18.2302.7".into()]).as_deref(), Some("4.18.2302.7"));
    }
}
