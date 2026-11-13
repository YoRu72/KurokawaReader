// The in-app browser's rules that need no web view (stage R4; browser.rs does the windows): what a site's origin is,
// when a page counts as passed, the channel that brings a page's answers back to Rust, the address a sign-in ends at,
// the names of a site's clearance cookies, a downloaded file's place. Std only, checked alone with
// `rustc --edition 2021 --test browserlogic.rs`.
//
// The channel. The site's page is never given a way into the app (no IPC: see browser.rs). Rust puts a script into
// the page (`eval`), and the script answers by asking to go to an address no site has —
// https://kr-lane.invalid/<nonce>/<rid>/<part>/<total>?<data> — which the window's navigation handler reads and
// refuses, so the page stays where it is. <data> is base64url: part 0 a JSON text (the answer's status, headers, …),
// parts 1… the body's bytes in pieces of at most CHUNK bytes. Each message is acknowledged by Rust before the page
// sends the next (one navigation at a time: a second one would cancel the first).
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};

/// The host the page's answers are addressed to (.invalid: reserved, never a real site).
pub const CHANNEL_HOST: &str = "kr-lane.invalid";
/// The bytes of a body sent in one message (base64url makes them a third longer in the address).
pub const CHUNK: usize = 96 * 1024;
/// The most messages one answer may have.
pub const MAX_PARTS: usize = 20_000;

/// A random token for a window's channel (std's hasher keys are random per process; mixed with the time and a
/// counter).
pub fn nonce() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let mut out = String::new();
    for _ in 0..2 {
        let mut h = RandomState::new().build_hasher();
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        h.write_u128(t);
        h.write_u64(N.fetch_add(1, Ordering::SeqCst));
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

/// «scheme://host[:port]» of an http(s) address, as a browser's `location.origin` (host lowercased, the scheme's own
/// port left out); None for anything else.
pub fn origin_of(url: &str) -> Option<String> {
    let url = url.trim();
    let (scheme, rest) = match url.find("://") {
        Some(i) => (url[..i].to_ascii_lowercase(), &url[i + 3..]),
        None => return None,
    };
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let end = rest.find(|c| c == '/' || c == '?' || c == '#').unwrap_or(rest.len());
    let mut auth = &rest[..end];
    if let Some(i) = auth.rfind('@') {
        auth = &auth[i + 1..];
    }
    if auth.is_empty() {
        return None;
    }
    let (host, port) = if auth.starts_with('[') {
        let close = auth.find(']')?;
        let h = &auth[..close + 1];
        let p = auth[close + 1..].strip_prefix(':').unwrap_or("");
        (h.to_ascii_lowercase(), p)
    } else {
        match auth.rfind(':') {
            Some(i) => (auth[..i].to_ascii_lowercase(), &auth[i + 1..]),
            None => (auth.to_ascii_lowercase(), ""),
        }
    };
    if host.is_empty() || host.contains(|c: char| c.is_whitespace()) {
        return None;
    }
    if !port.is_empty() && !port.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let default: u32 = if scheme == "https" { 443 } else { 80 };
    let port: Option<u32> = if port.is_empty() { None } else { port.parse().ok() };
    match port {
        Some(p) if p != default => Some(format!("{}://{}:{}", scheme, host, p)),
        _ => Some(format!("{}://{}", scheme, host)),
    }
}

/// The host of an http(s) address (no port), lowercase.
pub fn host_of(url: &str) -> Option<String> {
    let o = origin_of(url)?;
    let rest = &o[o.find("://")? + 3..];
    if rest.starts_with('[') {
        return Some(rest[..rest.find(']')? + 1].to_string());
    }
    Some(rest.split(':').next().unwrap_or("").to_string())
}

/// For a check, the site rather than the exact origin: example.com sending to www.example.com, or http to https.
pub fn site_of(origin: &str) -> String {
    match host_of(origin) {
        Some(h) => h.strip_prefix("www.").map(|x| x.to_string()).unwrap_or(h),
        None => origin.to_string(),
    }
}

/// What a page says of itself (the state script's answer; main.cjs's pageState).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PageState {
    pub ready: String,
    pub origin: String,
    pub check: bool,
    pub blocked: bool,
    pub title: String,
    pub href: String,
    /// The address, when it matched the `until` given (a sign-in's end).
    pub hit: String,
}

fn http_origin(o: &str) -> bool {
    o.starts_with("http://") || o.starts_with("https://")
}

/// main.cjs's isClear: the page of that very origin, loaded, no check on it and no refusal.
pub fn is_clear(st: &PageState, origin: &str) -> bool {
    st.origin == origin && st.ready != "loading" && !st.check && !st.blocked
}

/// main.cjs's isClearFor: the same, for the site (any of its origins).
pub fn is_clear_for(st: &PageState, origin: &str) -> bool {
    http_origin(&st.origin) && site_of(&st.origin) == site_of(origin) && st.ready != "loading" && !st.check && !st.blocked
}

/// main.cjs's movedAway: a page of its own, but on another origin (the site sends its pages elsewhere).
pub fn moved_away(st: &PageState, origin: &str) -> bool {
    http_origin(&st.origin) && st.origin != origin && st.ready != "loading" && !st.check && !st.blocked
}

/// A message of the channel.
#[derive(Debug, Clone, PartialEq)]
pub struct Msg {
    pub rid: String,
    pub part: usize,
    pub total: usize,
    pub data: Vec<u8>,
}

/// What an address the page asks to go to is, for the channel.
#[derive(Debug, Clone, PartialEq)]
pub enum Reply {
    /// Not the channel's: a navigation like any other.
    Other,
    /// The channel's host, but not a message of this window (another nonce, or broken): refused, dropped.
    Refused,
    Message(Msg),
}

fn rid_ok(r: &str) -> bool {
    !r.is_empty() && r.len() <= 24 && r.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Reads an address the page asked for: https://kr-lane.invalid/<nonce>/<rid>/<part>/<total>?<base64url>.
pub fn parse_reply(url: &str, nonce: &str) -> Reply {
    let rest = match url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")) {
        Some(r) => r,
        None => return Reply::Other,
    };
    let host_end = rest.find(|c| c == '/' || c == '?' || c == '#').unwrap_or(rest.len());
    if !rest[..host_end].eq_ignore_ascii_case(CHANNEL_HOST) {
        return Reply::Other;
    }
    let rest = &rest[host_end..];
    let (path, query) = match rest.find('?') {
        Some(i) => (&rest[..i], &rest[i + 1..]),
        None => (rest, ""),
    };
    let query = query.split('#').next().unwrap_or("");
    let seg: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    if seg.len() != 4 || seg[0] != nonce || nonce.is_empty() || !rid_ok(seg[1]) {
        return Reply::Refused;
    }
    let part: usize = match seg[2].parse() {
        Ok(n) => n,
        Err(_) => return Reply::Refused,
    };
    let total: usize = match seg[3].parse() {
        Ok(n) => n,
        Err(_) => return Reply::Refused,
    };
    // (At most MAX_PARTS: about 1.9 GB of body.)
    if total == 0 || part >= total || total > MAX_PARTS {
        return Reply::Refused;
    }
    Reply::Message(Msg { rid: seg[1].to_string(), part, total, data: b64url_decode(query) })
}

/// Base64 (url-safe or not, padding optional) → bytes; anything else skipped.
pub fn b64url_decode(text: &str) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(text.len() / 4 * 3 + 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for c in text.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    out
}

/// The messages of one answer, gathered as they come (any order, each once).
#[derive(Debug, Default)]
pub struct Assembly {
    parts: Vec<Option<Vec<u8>>>,
    got: usize,
}

impl Assembly {
    /// A message added → whether it was new.
    pub fn add(&mut self, m: Msg) -> bool {
        if self.parts.is_empty() {
            self.parts = vec![None; m.total];
        }
        if m.total != self.parts.len() || m.part >= self.parts.len() || self.parts[m.part].is_some() {
            return false;
        }
        self.parts[m.part] = Some(m.data);
        self.got += 1;
        true
    }
    pub fn complete(&self) -> bool {
        !self.parts.is_empty() && self.got == self.parts.len()
    }
    /// Part 0 (the JSON text) and the body (the other parts joined).
    pub fn take(self) -> (Vec<u8>, Vec<u8>) {
        let mut it = self.parts.into_iter();
        let head = it.next().flatten().unwrap_or_default();
        let mut body = Vec::new();
        for p in it {
            body.extend_from_slice(&p.unwrap_or_default());
        }
        (head, body)
    }
}

/// The text an `until` pattern (a regular expression, in the page's words) is sure to contain, when it is a plain
/// one — letters, digits and escaped signs only —, for a quick test of each address the window goes to; None when it
/// is a real pattern (the page's own RegExp then tests the address, in the state script).
pub fn literal_of(pattern: &str) -> Option<String> {
    let mut out = String::new();
    let mut esc = false;
    for c in pattern.chars() {
        if esc {
            if c.is_ascii_alphanumeric() {
                return None;
            }
            out.push(c);
            esc = false;
            continue;
        }
        match c {
            '\\' => esc = true,
            '.' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '^' | '$' => return None,
            _ => out.push(c),
        }
    }
    if esc || out.is_empty() {
        return None;
    }
    Some(out)
}

/// The cookies a site's shield leaves (main.cjs's forgetSite without `all`): Cloudflare's, DDoS-Guard's.
pub fn is_clearance(name: &str) -> bool {
    name == "cf_clearance" || name.starts_with("__cf") || name.starts_with("cf_chl") || name.starts_with("__ddg")
}

fn esc_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;")
}

/// main.cjs's refusal: what a request answers when the site would not let the app's browser through — the page a
/// check would show (the page then asks the reader), or a refusal.
pub fn refusal_html(title: &str, blocked: bool) -> String {
    let t = if title.is_empty() {
        if blocked {
            "Access denied"
        } else {
            "Just a moment..."
        }
    } else {
        title
    };
    format!("<html><head><title>{}</title></head><body></body></html>", esc_html(t))
}

/// A downloaded file's name made safe (main.cjs's rule, and control characters): never empty, «.» or «..».
pub fn safe_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '_' } else { c })
        .collect();
    let s = s.trim().to_string();
    if s.is_empty() || s == "." || s == ".." {
        "download".to_string()
    } else {
        s
    }
}

/// The name a download is given: the one the site suggests (the web view's), else the address's last part.
pub fn download_name(suggested: &str, url: &str) -> String {
    if !suggested.trim().is_empty() {
        return safe_name(suggested);
    }
    let path = url.split(|c| c == '?' || c == '#').next().unwrap_or("");
    let last = path.rsplit('/').next().unwrap_or("");
    safe_name(last)
}

/// `dir/name`, or `dir/name (2).ext`, … — the first that is not there yet.
pub fn unique_path(dir: &Path, name: &str, exists: &dyn Fn(&Path) -> bool) -> PathBuf {
    let first = dir.join(name);
    if !exists(&first) {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 2..10_000 {
        let p = dir.join(format!("{} ({}){}", stem, n, ext));
        if !exists(&p) {
            return p;
        }
    }
    dir.join(format!("{} ({}){}", stem, std::process::id(), ext))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins() {
        assert_eq!(origin_of("https://Example.com/a?b#c").as_deref(), Some("https://example.com"));
        assert_eq!(origin_of("https://example.com:443/").as_deref(), Some("https://example.com"));
        assert_eq!(origin_of("http://127.0.0.1:8080/x").as_deref(), Some("http://127.0.0.1:8080"));
        assert_eq!(origin_of("http://u:p@host.test:80").as_deref(), Some("http://host.test"));
        assert_eq!(origin_of("http://[::1]:9/x").as_deref(), Some("http://[::1]:9"));
        assert_eq!(origin_of("ftp://x/"), None);
        assert_eq!(origin_of("about:blank"), None);
        assert_eq!(origin_of("https:///x"), None);
        assert_eq!(origin_of("https://a b/"), None);
        assert_eq!(origin_of("http://h:x/"), None);
        assert_eq!(host_of("https://www.Example.com:8443/p").as_deref(), Some("www.example.com"));
        assert_eq!(host_of("http://[::1]:9/").as_deref(), Some("[::1]"));
        assert_eq!(site_of("https://www.example.com"), "example.com");
        assert_eq!(site_of("http://example.com:81"), "example.com");
    }

    fn st(origin: &str, ready: &str, check: bool, blocked: bool) -> PageState {
        PageState { ready: ready.into(), origin: origin.into(), check, blocked, ..Default::default() }
    }

    #[test]
    fn states() {
        let o = "https://example.com";
        assert!(is_clear(&st(o, "complete", false, false), o));
        assert!(is_clear(&st(o, "interactive", false, false), o));
        assert!(!is_clear(&st(o, "loading", false, false), o));
        assert!(!is_clear(&st(o, "complete", true, false), o));
        assert!(!is_clear(&st(o, "complete", false, true), o));
        assert!(!is_clear(&st("https://www.example.com", "complete", false, false), o));
        assert!(is_clear_for(&st("https://www.example.com", "complete", false, false), o));
        assert!(is_clear_for(&st("http://example.com", "complete", false, false), o));
        assert!(!is_clear_for(&st("https://other.com", "complete", false, false), o));
        assert!(!is_clear_for(&st("null", "complete", false, false), o));
        assert!(moved_away(&st("https://www.example.com", "complete", false, false), o));
        assert!(!moved_away(&st(o, "complete", false, false), o));
        assert!(!moved_away(&st("about:blank", "complete", false, false), o));
    }

    #[test]
    fn channel() {
        let n = nonce();
        assert_eq!(n.len(), 32);
        assert_ne!(n, nonce());
        assert_eq!(parse_reply("https://example.com/x", &n), Reply::Other);
        assert_eq!(parse_reply("about:blank", &n), Reply::Other);
        assert_eq!(parse_reply("https://kr-lane.invalid.example.com/x", &n), Reply::Other);
        assert_eq!(parse_reply("https://kr-lane.invalid/other/r1/0/1?e30", &n), Reply::Refused);
        assert_eq!(parse_reply(&format!("https://kr-lane.invalid/{}/r1/1/1?e30", n), &n), Reply::Refused);
        assert_eq!(parse_reply(&format!("https://kr-lane.invalid/{}/r-1/0/1?e30", n), &n), Reply::Refused);
        assert_eq!(parse_reply("https://kr-lane.invalid/x/r1/0/1", ""), Reply::Refused);
        assert_eq!(parse_reply(&format!("https://kr-lane.invalid/{}/r1/0/{}?e30", n, MAX_PARTS + 1), &n), Reply::Refused);
        let m = parse_reply(&format!("https://KR-LANE.invalid/{}/r7/0/2?eyJhIjoxfQ", n), &n);
        assert_eq!(m, Reply::Message(Msg { rid: "r7".into(), part: 0, total: 2, data: b"{\"a\":1}".to_vec() }));
        assert_eq!(b64url_decode("-_8"), vec![0xfb, 0xff]);
        assert_eq!(b64url_decode("+/8="), vec![0xfb, 0xff]);
        assert_eq!(b64url_decode("AAEC/w"), vec![0, 1, 2, 255]);
        let mut a = Assembly::default();
        assert!(!a.complete());
        assert!(a.add(Msg { rid: "r".into(), part: 2, total: 3, data: vec![3, 4] }));
        assert!(!a.add(Msg { rid: "r".into(), part: 2, total: 3, data: vec![9] }));
        assert!(!a.add(Msg { rid: "r".into(), part: 1, total: 4, data: vec![9] }));
        assert!(a.add(Msg { rid: "r".into(), part: 0, total: 3, data: b"{}".to_vec() }));
        assert!(!a.complete());
        assert!(a.add(Msg { rid: "r".into(), part: 1, total: 3, data: vec![1, 2] }));
        assert!(a.complete());
        assert_eq!(a.take(), (b"{}".to_vec(), vec![1, 2, 3, 4]));
    }

    #[test]
    fn until_and_names() {
        assert_eq!(literal_of("access_token=").as_deref(), Some("access_token="));
        assert_eq!(literal_of("/settings/client/").as_deref(), Some("/settings/client/"));
        assert_eq!(literal_of(r"\/settings\/client\/").as_deref(), Some("/settings/client/"));
        assert_eq!(literal_of(r"example\.com/done").as_deref(), Some("example.com/done"));
        assert_eq!(literal_of("token=\\d+"), None);
        assert_eq!(literal_of("a.b"), None);
        assert_eq!(literal_of("^https"), None);
        assert_eq!(literal_of(""), None);
        assert_eq!(literal_of("x\\"), None);
        for n in ["cf_clearance", "__cf_bm", "__cflb", "cf_chl_2", "__ddg1_", "__ddgid_"] {
            assert!(is_clearance(n), "{}", n);
        }
        for n in ["session", "kr_site", "cfx", "ddg"] {
            assert!(!is_clearance(n), "{}", n);
        }
        assert_eq!(refusal_html("", false), "<html><head><title>Just a moment...</title></head><body></body></html>");
        assert_eq!(refusal_html("", true), "<html><head><title>Access denied</title></head><body></body></html>");
        assert_eq!(refusal_html("a<b&c", true), "<html><head><title>a&lt;b&amp;c</title></head><body></body></html>");
    }

    #[test]
    fn downloads() {
        assert_eq!(safe_name("a/b:c?.epub"), "a_b_c_.epub");
        assert_eq!(safe_name(" .. "), "download");
        assert_eq!(safe_name("x\u{1}y"), "x_y");
        assert_eq!(download_name("", "https://e.x/books/One%20Book.epub?x=1#f"), "One%20Book.epub");
        assert_eq!(download_name("", "https://e.x/"), "download");
        assert_eq!(download_name("Book ✓.epub", "https://e.x/a"), "Book ✓.epub");
        let dir = Path::new("/d");
        let taken = |p: &Path| p == Path::new("/d/a.epub") || p == Path::new("/d/a (2).epub");
        assert_eq!(unique_path(dir, "a.epub", &taken), PathBuf::from("/d/a (3).epub"));
        assert_eq!(unique_path(dir, "b.epub", &taken), PathBuf::from("/d/b.epub"));
        let one = |p: &Path| p == Path::new("/d/.hidden");
        assert_eq!(unique_path(dir, ".hidden", &one), PathBuf::from("/d/.hidden (2)"));
    }
}
