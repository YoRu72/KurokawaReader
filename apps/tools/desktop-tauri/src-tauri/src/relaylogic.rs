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

/// `/r/<session>/v/<name>`, `/u/<n>`, `/s/<i>/<name>` → (session, what); None for any other path. The relay lives
/// outside the run's token (another program reads it): the session's own 128-bit id is its key.
pub fn parse(path: &str) -> Option<(String, Ask)> {
    let rest = path.strip_prefix("/r/")?;
    let mut it = rest.splitn(3, '/');
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
    Some((sess.to_string(), ask))
}

/// A playlist is read whole to be rewritten: at most this much (else 502); longer addresses are left out.
pub const MAX_LIST: usize = 16 << 20;
pub const MAX_URL: usize = 8192;

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
            let r = to(t, from, at, s);
            if !r.is_empty() {
                out.push(r);
            }
        }
    }
    out.join("\n")
}
fn to(u: &str, from: &str, at: &str, s: &mut Session) -> String {
    let a = join(from, u);
    if !is_http(&a) {
        return String::new();
    }
    match s.id_of(&a) {
        Some(n) => format!("{}/u/{}", at, n),
        None => String::new(),
    }
}

/// The origin of an address (scheme://host:port, the default port filled in), "" when it is none.
pub fn origin(u: &str) -> String {
    let i = match u.find("://") {
        Some(i) => i,
        None => return String::new(),
    };
    let scheme = u[..i].to_ascii_lowercase();
    let rest = &u[i + 3..];
    // A backslash ends the host as a slash does (the address parser the fetch uses reads it so).
    let host = rest.split(['/', '\\', '?', '#']).next().unwrap_or("").to_ascii_lowercase();
    let host = host.rsplit('@').next().unwrap_or("").to_string();
    if host.contains(':') && !host.ends_with(']') {
        return format!("{}://{}", scheme, host);
    }
    let port = if scheme == "https" { 443 } else { 80 };
    format!("{}://{}:{}", scheme, host, port)
}
pub fn is_http(u: &str) -> bool {
    let l = u.to_ascii_lowercase();
    (l.starts_with("http://") || l.starts_with("https://")) && !u.contains(['\r', '\n', '\t', '\\', ' ', '\0']) && u.len() <= MAX_URL
}

/// A string value of the top dictionary of a binary property list (Apple's bplist00), or None — only what a bundle's
/// Info.plist needs (desktop/extplayer.cjs's bplistString): the trailer, the offset table, a dictionary, ASCII and
/// UTF-16 strings; anything else, or anything out of bounds, None.
pub fn bplist_string(b: &[u8], key: &str) -> Option<String> {
    if b.len() < 40 || &b[..8] != b"bplist00" {
        return None;
    }
    let t = b.len() - 32;
    let (off_size, ref_size) = (b[t + 6] as usize, b[t + 7] as usize);
    let be = |at: usize| -> u64 { b[at..at + 8].iter().fold(0u64, |v, x| (v << 8) | *x as u64) };
    let (num, top, table) = (be(t + 8) as usize, be(t + 16) as usize, be(t + 24) as usize);
    if off_size == 0 || ref_size == 0 || off_size > 8 || ref_size > 8 || num > t || table.checked_add(num.checked_mul(off_size)?)? > t {
        return None;
    }
    let uint = |at: usize, n: usize| -> Option<usize> {
        if at.checked_add(n)? > t {
            return None;
        }
        Some(b[at..at + n].iter().fold(0usize, |v, x| v.wrapping_shl(8) | *x as usize))
    };
    let off = |i: usize| -> Option<usize> { if i < num { uint(table + i * off_size, off_size) } else { None } };
    let len = |at: usize| -> Option<(usize, usize)> {
        let lo = (b[at] & 0xf) as usize;
        if lo != 0xf {
            return Some((lo, at + 1));
        }
        let m = *b.get(at + 1)?;
        if m & 0xf0 != 0x10 || m & 0xf > 3 {
            return None;
        }
        let n = 1usize << (m & 0xf);
        Some((uint(at + 2, n)?, at + 2 + n))
    };
    let string = |i: usize| -> Option<String> {
        let at = off(i)?;
        if at < 8 || at >= t {
            return None;
        }
        let (n, s) = len(at)?;
        match b[at] >> 4 {
            5 if s.checked_add(n)? <= t => Some(b[s..s + n].iter().map(|c| *c as char).collect()),
            6 if s.checked_add(n.checked_mul(2)?)? <= t => {
                let u: Vec<u16> = b[s..s + 2 * n].chunks(2).map(|c| ((c[0] as u16) << 8) | c[1] as u16).collect();
                String::from_utf16(&u).ok()
            }
            _ => None,
        }
    };
    let at = off(top)?;
    if at < 8 || at >= t || b[at] >> 4 != 0xd {
        return None;
    }
    let (n, s) = len(at)?;
    for k in 0..n {
        if string(uint(s + k * ref_size, ref_size)?).as_deref() == Some(key) {
            return string(uint(s + (n + k) * ref_size, ref_size)?);
        }
    }
    None
}

/// The path and query of an address of this app's own stream server (`http://127.0.0.1:<port>/…`, or localhost), else
/// None: such a source (a torrent being watched, a file) is served by the relay session itself, in-process, so the
/// run's token in its address never reaches another program.
pub fn own_target(u: &str, port: u16) -> Option<String> {
    if !is_http(u) || port == 0 {
        return None;
    }
    let l = u.to_ascii_lowercase();
    for host in ["127.0.0.1", "localhost"] {
        let pre = format!("http://{}:{}/", host, port);
        if l.starts_with(&pre) {
            return Some(u[pre.len() - 1..].to_string());
        }
    }
    None
}

/// Request headers for a fetch: to the source's own origin all of the page's (lower-cased; Range and Host never);
/// to any other host only User-Agent and Referer — a cookie or an authorisation never leaves the source's origin.
/// A Chrome-like user agent unless one is given.
pub fn fetch_headers(page: &[(String, String)], range: Option<&str>, ua: &str, same_origin: bool) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    if !page.iter().any(|(k, _)| k.eq_ignore_ascii_case("user-agent")) {
        out.push(("user-agent".into(), ua.into()));
    }
    for (k, v) in page {
        let l = k.to_ascii_lowercase();
        if l == "range" || l == "host" || v.contains(['\r', '\n']) {
            continue;
        }
        if same_origin || l == "user-agent" || l == "referer" {
            out.push((l, v.clone()));
        }
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

/* ---------- a player on this computer (desktop/extcmd.cjs's twin) ---------- */

/// A known player: its id, name, where it usually is per OS ("windows" / "macos" / "linux"), whether it tells where
/// it is (mpv's IPC). The order is «Automatic»'s.
pub struct Known {
    pub id: &'static str,
    pub name: &'static str,
    pub ipc: bool,
    pub paths: &'static [(&'static str, &'static [&'static str])],
}
pub const KNOWN: &[Known] = &[
    Known { id: "mpv", name: "mpv", ipc: true, paths: &[("windows", &["mpv.exe", "%ProgramFiles%\\mpv\\mpv.exe", "%LOCALAPPDATA%\\Programs\\mpv\\mpv.exe", "%USERPROFILE%\\scoop\\apps\\mpv\\current\\mpv.exe"]), ("macos", &["/opt/homebrew/bin/mpv", "/usr/local/bin/mpv", "/Applications/mpv.app/Contents/MacOS/mpv"]), ("linux", &["mpv", "/usr/bin/mpv", "/usr/local/bin/mpv"])] },
    Known { id: "vlc", name: "VLC", ipc: false, paths: &[("windows", &["%ProgramFiles%\\VideoLAN\\VLC\\vlc.exe", "%ProgramFiles(x86)%\\VideoLAN\\VLC\\vlc.exe", "vlc.exe"]), ("macos", &["/Applications/VLC.app/Contents/MacOS/VLC"]), ("linux", &["vlc", "/usr/bin/vlc"])] },
    Known { id: "iina", name: "IINA", ipc: false, paths: &[("macos", &["/Applications/IINA.app/Contents/MacOS/iina-cli", "/opt/homebrew/bin/iina", "/usr/local/bin/iina"])] },
    Known { id: "mpc-hc", name: "MPC-HC", ipc: false, paths: &[("windows", &["%ProgramFiles%\\MPC-HC\\mpc-hc64.exe", "%ProgramFiles(x86)%\\MPC-HC\\mpc-hc.exe", "%ProgramFiles%\\K-Lite Codec Pack\\MPC-HC64\\mpc-hc64.exe"])] },
    Known { id: "mpc-be", name: "MPC-BE", ipc: false, paths: &[("windows", &["%ProgramFiles%\\MPC-BE x64\\mpc-be64.exe", "%ProgramFiles(x86)%\\MPC-BE\\mpc-be.exe"])] },
    Known { id: "potplayer", name: "PotPlayer", ipc: false, paths: &[("windows", &["%ProgramFiles%\\DAUM\\PotPlayer\\PotPlayerMini64.exe", "%ProgramFiles(x86)%\\DAUM\\PotPlayer\\PotPlayerMini.exe"])] },
];
pub fn known(id: &str) -> Option<&'static Known> {
    KNOWN.iter().find(|k| k.id == id)
}

/// A checked request (extcmd.cjs's check()).
#[derive(Debug, Default, Clone)]
pub struct Req {
    pub target: String,
    pub title: String,
    pub start: f64,
    pub subs: Vec<(String, bool)>,
    pub ua: Option<String>,
    pub referer: Option<String>,
    pub others: Vec<(String, String)>,
    pub slang: Vec<String>,
    pub alang: Vec<String>,
}
fn no_break(s: &str) -> bool {
    !s.contains(['\r', '\n', '\0']) && s.len() < 4096
}
/// Subtitles: http(s), or a subtitle file directly inside one of `temp_dirs` (where the app saves them).
pub fn check_sub(at: &str, temp_dirs: &[std::path::PathBuf]) -> bool {
    if is_http(at) {
        return true;
    }
    let p = std::path::Path::new(at);
    let ext = p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    p.is_absolute() && !at.contains("..") && ["srt", "ass", "ssa", "vtt", "sub"].contains(&ext.as_str()) && p.parent().map(|d| temp_dirs.iter().any(|t| t == d)).unwrap_or(false)
}
pub fn langs(v: &[String]) -> Vec<String> {
    v.iter().filter(|x| (2..=3).contains(&x.len()) && x.bytes().all(|b| b.is_ascii_lowercase())).take(10).cloned().collect()
}
/// The request's parts checked; Err(reason) when refused.
pub fn check(mut r: Req, temp_dirs: &[std::path::PathBuf]) -> Result<Req, &'static str> {
    if !is_http(&r.target) || r.target.len() > 8192 {
        return Err("target");
    }
    if r.subs.len() > 20 || !r.subs.iter().all(|(a, _)| check_sub(a, temp_dirs)) {
        return Err("subtitle");
    }
    if r.ua.as_deref().map(|v| !no_break(v)).unwrap_or(false) || r.referer.as_deref().map(|v| !no_break(v) || !is_http(v)).unwrap_or(false) {
        return Err("header");
    }
    // (Only User-Agent and Referer ever reach a command line; the page sends any other header through the relay.)
    if !r.others.is_empty() {
        return Err("header");
    }
    r.title = r.title.chars().map(|c| if c.is_control() { ' ' } else { c }).take(300).collect();
    if !r.start.is_finite() || r.start < 0.0 {
        r.start = 0.0;
    }
    r.slang = langs(&r.slang);
    r.alang = langs(&r.alang);
    Ok(r)
}
fn secs(s: f64) -> String {
    let x = (s * 10.0).round() / 10.0;
    if x.fract() == 0.0 { format!("{}", x as i64) } else { format!("{}", x) }
}
fn hms(s: f64) -> String {
    let t = s.floor() as i64;
    format!("{:02}:{:02}:{:02}", t / 3600, (t / 60) % 60, t % 60)
}
/// The arguments for a known player, or for the chosen program with its arguments line ("custom"); and whether it
/// tells where it is (mpv: «${ipc}» to fill with its socket).
pub fn build(id: &str, q: &Req, template: &str) -> (Vec<String>, bool) {
    let mut a: Vec<String> = Vec::new();
    let def = q.subs.iter().find(|s| s.1).or(q.subs.first()).map(|s| s.0.clone());
    match id {
        "mpv" | "iina" => {
            let o = |x: String| if id == "iina" { format!("--mpv-{}", x.trim_start_matches("--")) } else { x };
            if id == "iina" {
                a.push("--keep-running".into());
            }
            if !q.title.is_empty() {
                a.push(o(format!("--force-media-title={}", q.title)));
            }
            if q.start > 0.0 {
                a.push(o(format!("--start={}", secs(q.start))));
            }
            for (s, _) in &q.subs {
                a.push(o(format!("--sub-file={}", s)));
            }
            if !q.slang.is_empty() {
                a.push(o(format!("--slang={}", q.slang.join(","))));
            }
            if !q.alang.is_empty() {
                a.push(o(format!("--alang={}", q.alang.join(","))));
            }
            if let Some(ua) = &q.ua {
                a.push(o(format!("--user-agent={}", ua)));
            }
            if let Some(r) = &q.referer {
                a.push(o(format!("--referrer={}", r)));
            }
            if id == "mpv" {
                for x in ["--hwdec=auto-safe", "--input-ipc-server=${ipc}", "--idle=no", "--keep-open=no", "--"] {
                    a.push(x.into());
                }
            }
            a.push(q.target.clone());
            (a, id == "mpv")
        }
        "vlc" => {
            if !q.title.is_empty() {
                a.push(format!("--meta-title={}", q.title));
            }
            if q.start > 0.0 {
                a.push(format!("--start-time={}", secs(q.start)));
            }
            if let Some(d) = &def {
                a.push(format!("--sub-file={}", d));
            }
            if !q.slang.is_empty() {
                a.push(format!("--sub-language={}", q.slang.join(",")));
            }
            if !q.alang.is_empty() {
                a.push(format!("--audio-language={}", q.alang.join(",")));
            }
            if let Some(ua) = &q.ua {
                a.push(format!("--http-user-agent={}", ua));
            }
            if let Some(r) = &q.referer {
                a.push(format!("--http-referrer={}", r));
            }
            a.push("--play-and-exit".into());
            a.push("--no-one-instance".into());
            a.push(q.target.clone());
            (a, false)
        }
        "mpc-hc" | "mpc-be" => {
            a.push(q.target.clone());
            a.push("/play".into());
            a.push("/close".into());
            if q.start > 0.0 {
                a.push("/start".into());
                a.push(format!("{}", (q.start * 1000.0).round() as i64));
            }
            for (s, _) in &q.subs {
                a.push("/sub".into());
                a.push(s.clone());
            }
            (a, false)
        }
        "potplayer" => {
            a.push(q.target.clone());
            if q.start > 0.0 {
                a.push(format!("/seek={}", hms(q.start)));
            }
            if let Some(d) = &def {
                a.push(format!("/sub={}", d));
            }
            (a, false)
        }
        _ => (custom(template, q), false),
    }
}
/// The chosen program's arguments line (extcmd.cjs's custom()).
pub fn custom(line: &str, q: &Req) -> Vec<String> {
    let def = q.subs.iter().find(|s| s.1).or(q.subs.first()).map(|s| s.0.clone()).unwrap_or_default();
    let start = if q.start > 0.0 { secs(q.start) } else { String::new() };
    let startms = if q.start > 0.0 { format!("{}", (q.start * 1000.0).round() as i64) } else { String::new() };
    let vals: Vec<(&str, String)> = vec![("url", q.target.clone()), ("title", q.title.clone()), ("startms", startms), ("start", start), ("sub", def), ("ua", q.ua.clone().unwrap_or_default()), ("referrer", q.referer.clone().unwrap_or_default())];
    let mut had_url = false;
    let mut out = Vec::new();
    for w in split_args(line) {
        let mut f = String::new();
        let mut any = false;
        let mut empty = false;
        let mut rest = w.as_str();
        while let Some(i) = rest.find('{') {
            f.push_str(&rest[..i]);
            let after = &rest[i + 1..];
            let hit = vals.iter().find(|(k, _)| after.starts_with(k) && after[k.len()..].starts_with('}'));
            match hit {
                Some((k, v)) => {
                    any = true;
                    if *k == "url" {
                        had_url = true;
                    }
                    if v.is_empty() {
                        empty = true;
                    }
                    f.push_str(v);
                    rest = &after[k.len() + 1..];
                }
                None => {
                    f.push('{');
                    rest = after;
                }
            }
        }
        f.push_str(rest);
        if any && empty {
            continue;
        }
        // (Only a placeholder, and its value starts with «-»: it would be read as an option — left out.)
        let only = vals.iter().any(|(k, _)| w == format!("{{{}}}", k));
        if any && only && f.starts_with('-') {
            continue;
        }
        out.push(f);
    }
    if !had_url {
        out.push(q.target.clone());
    }
    out
}
pub fn split_args(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut q: Option<char> = None;
    let mut has = false;
    let cs: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        if let Some(qc) = q {
            if c == qc {
                q = None;
            } else if c == '\\' && qc == '"' && i + 1 < cs.len() && (cs[i + 1] == '"' || cs[i + 1] == '\\') {
                i += 1;
                cur.push(cs[i]);
            } else {
                cur.push(c);
            }
        } else if c == '"' || c == '\'' {
            q = Some(c);
            has = true;
        } else if c.is_whitespace() {
            if !cur.is_empty() || has {
                out.push(std::mem::take(&mut cur));
            }
            has = false;
        } else {
            cur.push(c);
            has = true;
        }
        i += 1;
    }
    if !cur.is_empty() || has {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn players() {
        let tmp = vec![std::path::PathBuf::from("/tmp")];
        let q = Req { target: "https://cdn.test/v/a.m3u8".into(), title: "Show - 03".into(), start: 90.4, subs: vec![("/tmp/en.vtt".into(), true)], ua: Some("UA-1".into()), referer: Some("https://site.test/".into()), others: vec![], slang: vec!["ar".into(), "EN".into()], alang: vec!["ja".into()] };
        assert_eq!(check(Req { others: vec![("Cookie".into(), "k=v".into())], ..q.clone() }, &tmp).unwrap_err(), "header");
        let q = check(q, &tmp).unwrap();
        assert_eq!(q.slang, vec!["ar"]);
        let (m, ipc) = build("mpv", &q, "");
        assert!(ipc && m.contains(&"--start=90.4".to_string()) && !m.iter().any(|a| a.contains("Cookie")) && m.contains(&"--user-agent=UA-1".to_string()) && m[m.len() - 2] == "--" && m[m.len() - 1] == q.target);
        let (ii, _) = build("iina", &q, "");
        assert_eq!(ii[0], "--keep-running");
        assert!(ii.contains(&"--mpv-referrer=https://site.test/".to_string()) && !ii.contains(&"-w".to_string()));
        let (mpc, _) = build("mpc-hc", &q, "");
        assert_eq!(mpc.join(" "), "https://cdn.test/v/a.m3u8 /play /close /start 90400 /sub /tmp/en.vtt");
        let (pot, _) = build("potplayer", &q, "");
        assert_eq!(pot, vec!["https://cdn.test/v/a.m3u8", "/seek=00:01:30", "/sub=/tmp/en.vtt"]);
        let (c, _) = build("custom", &Req { subs: vec![], ..q.clone() }, "\"--title={title}\" --sub={sub} --from={start} --hdr '{referrer}'");
        assert_eq!(c, vec!["--title=Show - 03", "--from=90.4", "--hdr", "https://site.test/", "https://cdn.test/v/a.m3u8"]);
        assert_eq!(custom("p {url}; rm -rf $(x)", &Req { subs: vec![], ..q.clone() }), vec!["p", "https://cdn.test/v/a.m3u8;", "rm", "-rf", "$(x)"]);
        assert_eq!(custom("{title} --x={title} {url}", &Req { title: "--script=evil".into(), ..q.clone() }), vec!["--x=--script=evil", "https://cdn.test/v/a.m3u8"]);
        assert!(check(Req { target: "file:///etc/passwd".into(), ..Req::default() }, &tmp).is_err());
        assert!(check(Req { target: "https://a/b".into(), subs: vec![("/home/u/.ssh/id.srt".into(), false)], ..Req::default() }, &tmp).is_err());
        assert!(check(Req { target: "https://a/b".into(), ua: Some("a\r\nX: y".into()), ..Req::default() }, &tmp).is_err());
        assert_eq!(split_args("a \"b c\" 'd \"e\"' \"f\\\"g\" \"\""), vec!["a", "b c", "d \"e\"", "f\"g", ""]);
    }
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
        let mut s2 = Session::new("https://a.test/v/m.m3u8".into(), vec![], vec![]);
        let o2 = rewrite("#EXTM3U\n#EXT-X-KEY:URI=\"file:///etc/x\"\nfile:///etc/passwd\nok.ts", "https://a.test/v/m.m3u8", "http://h/T/r/S", &mut s2);
        assert_eq!(s2.urls, vec!["https://a.test/v/ok.ts"]);
        assert!(!o2.contains("file:") && o2.contains("URI=\"\""));
        assert_eq!(s.urls, vec!["https://a.test/v/key.bin", "https://a.test/init.mp4", "https://a.test/v/seg0.ts", "https://cdn.test/seg1.ts"]);
    }
    /// A tiny bplist00: one dictionary of string pairs (ASCII or UTF-16), offsets of two bytes, references of one.
    pub(crate) fn bplist(pairs: &[(&str, &str)]) -> Vec<u8> {
        let enc = |s: &str| -> Vec<u8> {
            let ascii = s.is_ascii();
            let body: Vec<u8> = if ascii { s.as_bytes().to_vec() } else { s.encode_utf16().flat_map(|u| [(u >> 8) as u8, u as u8]).collect() };
            let n = if ascii { s.len() } else { body.len() / 2 };
            let mut v = if n < 15 { vec![(if ascii { 0x50 } else { 0x60 }) | n as u8] } else { vec![if ascii { 0x5f } else { 0x6f }, 0x10, n as u8] };
            v.extend(body);
            v
        };
        let n = pairs.len();
        let mut objs: Vec<Vec<u8>> = vec![];
        let mut dict = vec![0xd0 | n as u8];
        dict.extend((0..n).map(|i| (1 + i) as u8));
        dict.extend((0..n).map(|i| (1 + n + i) as u8));
        objs.push(dict);
        for p in pairs { objs.push(enc(p.0)); }
        for p in pairs { objs.push(enc(p.1)); }
        let mut out = b"bplist00".to_vec();
        let mut offs = vec![];
        for o in &objs { offs.push(out.len()); out.extend(o); }
        let table = out.len();
        for o in &offs { out.extend([(o >> 8) as u8, *o as u8]); }
        out.extend([0, 0, 0, 0, 0, 0, 2, 1]);
        for v in [objs.len() as u64, 0, table as u64] { out.extend(v.to_be_bytes()); }
        out
    }

    #[test]
    fn bplists() {
        let b = bplist(&[("CFBundleName", "Fake"), ("CFBundleExecutable", "fakeplay"), ("Note", "مشغّل — a longer value")]);
        assert_eq!(bplist_string(&b, "CFBundleExecutable").as_deref(), Some("fakeplay"));
        assert_eq!(bplist_string(&b, "Note").as_deref(), Some("مشغّل — a longer value"));
        assert_eq!(bplist_string(&b, "Missing"), None);
        assert_eq!(bplist_string(b"<plist></plist>", "CFBundleExecutable"), None);
        // cut short, or its trailer pointing outside: nothing, and no panic
        for cut in [40, b.len() - 1, b.len() - 33] { let _ = bplist_string(&b[..cut], "CFBundleExecutable"); }
        let mut bad = b.clone(); let l = bad.len(); bad[l - 1] = 0xff; assert_eq!(bplist_string(&bad, "CFBundleExecutable"), None);
        let mut bad2 = b.clone(); let l = bad2.len(); bad2[l - 9] = 0x7f; assert_eq!(bplist_string(&bad2, "CFBundleExecutable"), None);
    }

    #[test]
    fn own_targets() {
        assert_eq!(own_target("http://127.0.0.1:4000/TOK/t/S/a.mkv", 4000).as_deref(), Some("/TOK/t/S/a.mkv"));
        assert_eq!(own_target("http://LOCALHOST:4000/TOK/f?p=x", 4000).as_deref(), Some("/TOK/f?p=x"));
        assert_eq!(own_target("http://127.0.0.1:4001/TOK/t/S/a.mkv", 4000), None);
        assert_eq!(own_target("http://127.0.0.1:40000/TOK/t/S/a.mkv", 4000), None);
        assert_eq!(own_target("https://a.test/v.mkv", 4000), None);
        assert_eq!(own_target("http://127.0.0.1:4000/x", 0), None);
    }

    #[test]
    fn parses() {
        let s = "0123456789abcdef0123456789abcdef";
        assert_eq!(parse(&format!("/r/{}/v/Show%2001", s)), Some((s.into(), Ask::Video)));
        assert_eq!(parse(&format!("/r/{}/u/12", s)), Some((s.into(), Ask::Url(12))));
        assert_eq!(parse(&format!("/r/{}/s/1/a.ass", s)), Some((s.into(), Ask::Sub(1))));
        assert_eq!(parse("/r/short/v/x"), None);
        assert_eq!(parse(&format!("/r/{}/u/x", s)), None);
        assert_eq!(parse(&format!("/TOK/r/{}/v/x", s)), None);
        assert_eq!(parse("/TOK/p"), None);
        assert!(!is_http(&format!("https://a/{}", "x".repeat(9000))));
        assert!(is_playlist("application/vnd.apple.mpegurl", "x"));
        assert!(is_playlist("", "https://a/b.M3U8?x=1"));
        assert!(!is_playlist("video/mp4", "https://a/b.mp4"));
    }
    #[test]
    fn headers_and_mpv() {
        let page = vec![("Referer".to_string(), "https://a.test/".to_string()), ("Range".into(), "bytes=0-".into()), ("Cookie".into(), "k=v".into()), ("X-Key".into(), "s".into())];
        let h = fetch_headers(&page, Some("bytes=5-"), "UA", true);
        assert_eq!(h, vec![("user-agent".to_string(), "UA".to_string()), ("referer".into(), "https://a.test/".into()), ("cookie".into(), "k=v".into()), ("x-key".into(), "s".into()), ("range".into(), "bytes=5-".into())]);
        let other = fetch_headers(&page, None, "UA", false);
        assert_eq!(other, vec![("user-agent".to_string(), "UA".to_string()), ("referer".into(), "https://a.test/".into())]);
        assert_eq!(origin("https://A.test/x?y"), "https://a.test:443");
        assert_eq!(origin("http://a.test:8080/x"), "http://a.test:8080");
        assert_ne!(origin("https://a.test/x"), origin("https://cdn.test/x"));
        assert_eq!(origin("https://evil.test\\@a.test/seg.ts"), "https://evil.test:443");
        assert!(!is_http("https://evil.test\\@a.test/seg.ts"));
        assert!(is_http("https://a/b") && !is_http("file:///etc/passwd") && !is_http("data:x"));
        assert_eq!(mpv_line(r#"{"event":"property-change","id":1,"name":"time-pos","data":12.5}"#), Some(MpvNote::Pos(12.5)));
        assert_eq!(mpv_line(r#"{"event":"property-change","id":2,"name":"duration","data":1440.0}"#), Some(MpvNote::Dur(1440.0)));
        assert_eq!(mpv_line(r#"{"event":"property-change","id":3,"name":"eof-reached","data":true}"#), Some(MpvNote::Eof));
        assert_eq!(mpv_line(r#"{"event":"end-file","reason":"eof","playlist_entry_id":1}"#), Some(MpvNote::Eof));
        assert_eq!(mpv_line(r#"{"event":"end-file","reason":"quit"}"#), None);
        assert_eq!(mpv_line(r#"{"event":"property-change","id":1,"name":"time-pos","data":null}"#), None);
    }
}
