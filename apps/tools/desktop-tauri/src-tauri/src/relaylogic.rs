// The relay for another program's player (desktop/relay.cjs's twin; served by relay.rs on the stream server): the
// plain part, std only, so `rustc --edition 2021 --test relaylogic.rs` checks it on its own. A session per playback,
// its random id in the path under the run's token (/<token>/r/<session>/v|u|s/…); an HLS playlist rewritten so each
// segment, key, map and sub-playlist is an address of the same session, by number — never a URL from the request.
use std::collections::HashMap;

pub const MAX_URLS: usize = 200_000;

#[derive(Clone, Debug, Default)]
pub struct Sub {
    pub url: String,
    pub path: String,
    pub name: String,
    pub headers: Vec<(String, String)>,
}

#[derive(Debug, Default)]
pub struct Session {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub subs: Vec<Sub>,
    pub urls: Vec<String>,
    ids: HashMap<String, usize>,
}

impl Session {
    pub fn new(url: String, headers: Vec<(String, String)>, subs: Vec<Sub>) -> Session {
        Session { url, headers, subs, urls: Vec::new(), ids: HashMap::new() }
    }
    /// The number of an address in this session (a new one added), none past the limit.
    pub fn id_of(&mut self, u: &str) -> Option<usize> {
        if let Some(n) = self.ids.get(u) {
            return Some(*n);
        }
        if self.urls.len() >= MAX_URLS {
            return None;
        }
        let n = self.urls.len();
        self.urls.push(u.to_string());
        self.ids.insert(u.to_string(), n);
        Some(n)
    }
}

/// What a relay address asks for.
#[derive(Debug, PartialEq)]
pub enum Ask {
    Video,
    Url(usize),
    Sub(usize),
}

/// `/<token>/r/<session>/v/<name>`, `/u/<n>`, `/s/<i>/<name>` → (session, what); None for any other path. The run's
/// token is checked by the caller (streamlogic's same_token).
pub fn parse(path: &str) -> Option<(String, String, Ask)> {
    let rest = path.strip_prefix('/')?;
    let mut it = rest.splitn(5, '/');
    let tok = it.next()?.to_string();
    if it.next()? != "r" {
        return None;
    }
    let sess = it.next()?;
    if sess.len() != 32 || !sess.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let kind = it.next()?;
    let tail = it.next().unwrap_or("");
    let first = tail.split('/').next().unwrap_or("");
    let ask = match kind {
        "v" => Ask::Video,
        "u" => Ask::Url(first.parse().ok()?),
        "s" => Ask::Sub(first.parse().ok()?),
        _ => return None,
    };
    Some((tok, sess.to_string(), ask))
}

pub fn is_playlist(content_type: &str, href: &str) -> bool {
    if content_type.to_ascii_lowercase().contains("mpegurl") {
        return true;
    }
    let h = href.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    h.ends_with(".m3u8")
}

/// `rel` against `base`, as a browser resolves an address (absolute, //host, /path, relative with ./ and ../).
pub fn join(base: &str, rel: &str) -> String {
    if rel.contains("://") {
        return rel.to_string();
    }
    let scheme_end = match base.find("://") {
        Some(i) => i,
        None => return rel.to_string(),
    };
    let scheme = &base[..scheme_end];
    if let Some(r) = rel.strip_prefix("//") {
        return format!("{}://{}", scheme, r);
    }
    let after = &base[scheme_end + 3..];
    let host_end = after.find('/').unwrap_or(after.len());
    let origin = &base[..scheme_end + 3 + host_end];
    let base_path = after[host_end..].split(['?', '#']).next().unwrap_or("");
    let (path_part, query) = match rel.find(['?', '#']) {
        Some(i) => (&rel[..i], &rel[i..]),
        None => (rel, ""),
    };
    let joined = if path_part.starts_with('/') {
        path_part.to_string()
    } else if path_part.is_empty() {
        base_path.to_string()
    } else {
        let dir = match base_path.rfind('/') {
            Some(i) => &base_path[..=i],
            None => "/",
        };
        format!("{}{}", dir, path_part)
    };
    let mut out: Vec<&str> = Vec::new();
    let segs: Vec<&str> = joined.split('/').collect();
    for (i, seg) in segs.iter().enumerate() {
        match *seg {
            "." => {
                if i == segs.len() - 1 {
                    out.push("");
                }
            }
            ".." => {
                if out.len() > 1 {
                    out.pop();
                }
                if i == segs.len() - 1 {
                    out.push("");
                }
            }
            s => out.push(s),
        }
    }
    let mut p = out.join("/");
    if !p.starts_with('/') {
        p.insert(0, '/');
    }
    format!("{}{}{}", origin, p, query)
}

/// A playlist's addresses — its lines and every URI="…" — made this session's (`at`: …/r/<session>).
pub fn rewrite(text: &str, from: &str, at: &str, s: &mut Session) -> String {
    let mut out: Vec<String> = Vec::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let t = line.trim();
        if t.is_empty() {
            out.push(line.to_string());
            continue;
        }
        if t.starts_with('#') {
            let mut r = String::new();
            let mut rest = line;
            while let Some(i) = rest.find("URI=\"") {
                r.push_str(&rest[..i + 5]);
                let after = &rest[i + 5..];
                match after.find('"') {
                    Some(j) => {
                        let u = &after[..j];
                        r.push_str(&to(u, from, at, s));
                        r.push('"');
                        rest = &after[j + 1..];
                    }
                    None => {
                        rest = after;
                        break;
                    }
                }
            }
            r.push_str(rest);
            out.push(r);
        } else {
            out.push(to(t, from, at, s));
        }
    }
    out.join("\n")
}
fn to(u: &str, from: &str, at: &str, s: &mut Session) -> String {
    let a = join(from, u);
    match s.id_of(&a) {
        Some(n) => format!("{}/u/{}", at, n),
        None => u.to_string(),
    }
}

/// Request headers for a fetch: the page's (lower-cased; Range and Host never), a Chrome-like user agent unless given.
pub fn fetch_headers(page: &[(String, String)], range: Option<&str>, ua: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    if !page.iter().any(|(k, _)| k.eq_ignore_ascii_case("user-agent")) {
        out.push(("user-agent".into(), ua.into()));
    }
    for (k, v) in page {
        let l = k.to_ascii_lowercase();
        if l == "range" || l == "host" {
            continue;
        }
        out.push((l, v.clone()));
    }
    if let Some(r) = range {
        out.push(("range".into(), r.into()));
    }
    out
}

/// mpv's JSON IPC: a «property-change» or «end-file» line read without a JSON library (the fields mpv writes).
#[derive(Debug, PartialEq)]
pub enum MpvNote {
    Pos(f64),
    Dur(f64),
    Eof,
}
pub fn mpv_line(line: &str) -> Option<MpvNote> {
    let field = |k: &str| -> Option<String> {
        let key = format!("\"{}\":", k);
        let i = line.find(&key)? + key.len();
        let rest = line[i..].trim_start();
        if let Some(r) = rest.strip_prefix('"') {
            return Some(r[..r.find('"')?].to_string());
        }
        let end = rest.find([',', '}']).unwrap_or(rest.len());
        Some(rest[..end].trim().to_string())
    };
    match field("event")?.as_str() {
        "property-change" => {
            let name = field("name")?;
            let data = field("data")?;
            match name.as_str() {
                "time-pos" => data.parse().ok().map(MpvNote::Pos),
                "duration" => data.parse().ok().map(MpvNote::Dur),
                "eof-reached" if data == "true" => Some(MpvNote::Eof),
                _ => None,
            }
        }
        "end-file" if field("reason").as_deref() == Some("eof") => Some(MpvNote::Eof),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn joins() {
        assert_eq!(join("https://a.test/x/y/list.m3u8?k=1", "seg1.ts"), "https://a.test/x/y/seg1.ts");
        assert_eq!(join("https://a.test/x/y/list.m3u8", "../k/key.bin?t=2"), "https://a.test/x/k/key.bin?t=2");
        assert_eq!(join("https://a.test/x/y/list.m3u8", "/abs/s.ts"), "https://a.test/abs/s.ts");
        assert_eq!(join("https://a.test/x/list.m3u8", "//cdn.test/s.ts"), "https://cdn.test/s.ts");
        assert_eq!(join("https://a.test/x/list.m3u8", "http://b.test/s.ts"), "http://b.test/s.ts");
        assert_eq!(join("http://a.test", "s.ts"), "http://a.test/s.ts");
    }
    #[test]
    fn rewrites() {
        let mut s = Session::new("https://a.test/v/m.m3u8".into(), vec![], vec![]);
        let text = "#EXTM3U\r\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x1\r\n#EXT-X-MAP:URI=\"../init.mp4\"\r\n#EXTINF:4,\r\nseg0.ts\r\n#EXTINF:4,\r\nhttps://cdn.test/seg1.ts\r\n\r\nseg0.ts";
        let out = rewrite(text, "https://a.test/v/m.m3u8", "http://127.0.0.1:9/T/r/S", &mut s);
        assert!(out.contains("URI=\"http://127.0.0.1:9/T/r/S/u/0\",IV=0x1"));
        assert!(out.contains("URI=\"http://127.0.0.1:9/T/r/S/u/1\""));
        assert!(out.lines().any(|l| l == "http://127.0.0.1:9/T/r/S/u/2"));
        assert!(out.lines().any(|l| l == "http://127.0.0.1:9/T/r/S/u/3"));
        assert_eq!(out.lines().last(), Some("http://127.0.0.1:9/T/r/S/u/2"));
        assert_eq!(s.urls, vec!["https://a.test/v/key.bin", "https://a.test/init.mp4", "https://a.test/v/seg0.ts", "https://cdn.test/seg1.ts"]);
    }
    #[test]
    fn parses() {
        let s = "0123456789abcdef0123456789abcdef";
        assert_eq!(parse(&format!("/TOK/r/{}/v/Show%2001", s)), Some(("TOK".into(), s.into(), Ask::Video)));
        assert_eq!(parse(&format!("/TOK/r/{}/u/12", s)), Some(("TOK".into(), s.into(), Ask::Url(12))));
        assert_eq!(parse(&format!("/TOK/r/{}/s/1/a.ass", s)), Some(("TOK".into(), s.into(), Ask::Sub(1))));
        assert_eq!(parse("/TOK/r/short/v/x"), None);
        assert_eq!(parse(&format!("/TOK/r/{}/u/x", s)), None);
        assert_eq!(parse("/TOK/p"), None);
        assert!(is_playlist("application/vnd.apple.mpegurl", "x"));
        assert!(is_playlist("", "https://a/b.M3U8?x=1"));
        assert!(!is_playlist("video/mp4", "https://a/b.mp4"));
    }
    #[test]
    fn headers_and_mpv() {
        let h = fetch_headers(&[("Referer".into(), "https://a.test/".into()), ("Range".into(), "bytes=0-".into())], Some("bytes=5-"), "UA");
        assert_eq!(h, vec![("user-agent".to_string(), "UA".to_string()), ("referer".into(), "https://a.test/".into()), ("range".into(), "bytes=5-".into())]);
        assert_eq!(mpv_line(r#"{"event":"property-change","id":1,"name":"time-pos","data":12.5}"#), Some(MpvNote::Pos(12.5)));
        assert_eq!(mpv_line(r#"{"event":"property-change","id":2,"name":"duration","data":1440.0}"#), Some(MpvNote::Dur(1440.0)));
        assert_eq!(mpv_line(r#"{"event":"property-change","id":3,"name":"eof-reached","data":true}"#), Some(MpvNote::Eof));
        assert_eq!(mpv_line(r#"{"event":"end-file","reason":"eof","playlist_entry_id":1}"#), Some(MpvNote::Eof));
        assert_eq!(mpv_line(r#"{"event":"end-file","reason":"quit"}"#), None);
        assert_eq!(mpv_line(r#"{"event":"property-change","id":1,"name":"time-pos","data":null}"#), None);
    }
}
