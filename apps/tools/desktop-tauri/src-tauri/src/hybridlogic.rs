// The «hybrid» closures of four losses against Electron (../../PORTING.md «Closed by the hybrid»): the rules, std only,
// checked alone with `rustc --edition 2021 --test hybridlogic.rs`. The native pieces that use them: notifier.rs (a
// notice's click), mediawatch.rs (media told by content type), cookiecarry.rs (the in-app browser's sign-ins carried
// at the hand-over), packadopt.rs (yt-dlp, gallery-dl and the ffmpeg pack taken over from the Electron build).
#![allow(dead_code)]
use std::collections::{HashMap, VecDeque};
use std::path::Path;

/* ---------- 1. a notice's click ---------- */

/// The address a Windows notice opens when clicked (its «protocol» activation): this program is the kurokawatools:
/// handler, so Windows starts it with the address and the single-instance plugin hands it to the running one.
pub const TASK_LINK: &str = "kurokawatools://task?id=";

/// A download's id as a notice may carry it: 1–128 of letters, digits and «._:-» (aria2's gids, the video jobs' ids).
pub fn id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b':' || b == b'-')
}

/// The address of a download's notice (None for an id that cannot be one).
pub fn task_link(id: &str) -> Option<String> {
    if id_ok(id) {
        Some(format!("{}{}", TASK_LINK, id.replace(':', "%3A")))
    } else {
        None
    }
}

/// A launch argument that is a notice's address → the download's id. Its case and a «%3A» for «:» as Windows may
/// hand it; anything after the id («&…», «#…», a trailing «/») left out.
pub fn task_link_id(arg: &str) -> Option<String> {
    let a = arg.trim();
    if a.len() < TASK_LINK.len() || !a.is_char_boundary(TASK_LINK.len()) || !a[..TASK_LINK.len()].eq_ignore_ascii_case(TASK_LINK) {
        return None;
    }
    let rest = &a[TASK_LINK.len()..];
    let end = rest.find(|c: char| c == '&' || c == '#' || c == '/').unwrap_or(rest.len());
    let id = rest[..end].replace("%3A", ":").replace("%3a", ":");
    if id_ok(&id) {
        Some(id)
    } else {
        None
    }
}

/// Text put into XML (a notice's title and words, an attribute).
pub fn xml_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            // (XML 1.0 has no other control characters.)
            c if (c as u32) < 0x20 && c != '\n' && c != '\t' => o.push(' '),
            c => o.push(c),
        }
    }
    o
}

/// A Windows notice that opens `launch` when clicked (protocol activation: no COM server needed, and it works after
/// the app was closed too).
pub fn toast_xml(title: &str, body: &str, launch: &str) -> String {
    let mut x = format!("<toast activationType=\"protocol\" launch=\"{}\"><visual><binding template=\"ToastGeneric\"><text>{}</text>", xml_escape(launch), xml_escape(title));
    if !body.is_empty() {
        x.push_str(&format!("<text>{}</text>", xml_escape(body)));
    }
    x.push_str("</binding></visual></toast>");
    x
}

/// Windows PowerShell 5.1 (it alone projects WinRT) showing the notice in KT_TOAST_XML under the AppUserModelID in
/// KT_TOAST_APP. Its exit code: 0 shown, 3 the system says this app's notices are off, 4 any error.
pub const TOAST_PS: &str = "$ErrorActionPreference='Stop';try{\
$null=[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];\
$null=[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime];\
$x=New-Object Windows.Data.Xml.Dom.XmlDocument;$x.LoadXml($env:KT_TOAST_XML);\
$n=[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:KT_TOAST_APP);\
$s='Enabled';try{$s=[string]$n.Setting}catch{};if($s -ne 'Enabled'){exit 3};\
$n.Show((New-Object Windows.UI.Notifications.ToastNotification $x));exit 0}catch{exit 4}";

/// `reg query <key> /ve` answered → whether its default value runs `exe` (the kurokawatools: handler is this program).
pub fn reg_runs(reg_output: &str, exe: &str) -> bool {
    let want = exe.trim().to_ascii_lowercase().replace('/', "\\");
    if want.is_empty() {
        return false;
    }
    reg_output.lines().any(|l| {
        let l = l.to_ascii_lowercase();
        (l.contains("reg_sz") || l.contains("reg_expand_sz")) && l.replace('/', "\\").contains(&want)
    })
}

/// At most this many Linux notices wait for their click at once (each keeps a thread and a D-Bus connection); more
/// are shown the plugin's way.
pub const MAX_WAITING: usize = 16;

/// What a Linux notice's answer means: its default action (a click on it) → open the download; anything else (closed,
/// another action) → nothing.
pub fn clicked(action: &str) -> bool {
    action == "default"
}

/* ---------- 2. media told by content type (desktop/main.cjs openBrowser's `seen`) ---------- */

fn ends_ext(u: &str, exts: &[&str]) -> bool {
    // (JavaScript's /\.(a|b)(\?|$)/i on the whole address.)
    for e in exts.iter() {
        let pat = format!(".{}", e);
        let mut from = 0;
        while let Some(i) = u[from..].find(&pat) {
            let at = from + i + pat.len();
            if at == u.len() || u.as_bytes()[at] == b'?' {
                return true;
            }
            from = from + i + 1;
        }
    }
    false
}

/// /[/_-](seg|segment|chunk|frag|fragment|init)[-_]?\d*\.(m4s|mp4|m4v|m4a|ts)(\?|$)/i
fn piece_name(u: &str) -> bool {
    let b = u.as_bytes();
    for (i, &c) in b.iter().enumerate() {
        if c != b'/' && c != b'_' && c != b'-' {
            continue;
        }
        let rest = &u[i + 1..];
        for w in ["seg", "segment", "chunk", "frag", "fragment", "init"] {
            let r = match rest.strip_prefix(w) {
                Some(r) => r,
                None => continue,
            };
            let r = r.strip_prefix('-').or_else(|| r.strip_prefix('_')).unwrap_or(r);
            let r = r.trim_start_matches(|c: char| c.is_ascii_digit());
            for e in ["m4s", "mp4", "m4v", "m4a", "ts"] {
                if let Some(t) = r.strip_prefix('.').and_then(|t| t.strip_prefix(e)) {
                    if t.is_empty() || t.starts_with('?') {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn manifest_path(u: &str) -> bool {
    if u.contains(".m3u8") || u.contains(".mpd") || u.contains("videoplayback?") {
        return true;
    }
    let mut from = 0;
    while let Some(i) = u[from..].find("/manifest") {
        let at = from + i + "/manifest".len();
        if at == u.len() || matches!(u.as_bytes()[at], b'.' | b'/' | b'?') {
            return true;
        }
        from = from + i + 1;
    }
    false
}

/// A response the in-app browser's page loaded → what Grab lists it as ("video", "music", "media"), or None — Electron's
/// `seen` rule as it is: by its address, by what the server said it is (`content_type`, any case) — video/…, audio/…,
/// a playlist or a manifest — or because a <video>/<audio> element asked for it (`resource_type` "media"). A stream's
/// pieces are left out.
pub fn classify(url: &str, content_type: &str, resource_type: &str) -> Option<&'static str> {
    let u = url.to_ascii_lowercase();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return None;
    }
    let ct = content_type.trim().to_ascii_lowercase();
    let manifest = manifest_path(&u) || ct.contains("mpegurl") || ct.contains("dash+xml");
    if !manifest && (ends_ext(&u, &["ts", "m4s", "aac", "vtt", "key"]) || piece_name(&u) || ct.contains("mp2t")) {
        return None;
    }
    if manifest || ct.starts_with("video/") || (resource_type == "media" && !ct.starts_with("audio/")) || ends_ext(&u, &["mp4", "mkv", "webm", "m4v", "mov"]) {
        return Some("video");
    }
    if ct.starts_with("audio/") || ends_ext(&u, &["mp3", "m4a", "flac", "ogg", "opus", "wav"]) {
        return Some("music");
    }
    let app_kind = ["application/zip", "application/x-7z", "application/x-rar", "application/pdf", "application/epub", "application/vnd.android"].iter().any(|p| ct.starts_with(p));
    if ends_ext(&u, &["zip", "7z", "rar", "apk", "pdf", "epub"]) || app_kind {
        return Some("media");
    }
    None
}

/// The host of an http(s) address (lowercase, no port, no brackets).
pub fn host_of(url: &str) -> Option<String> {
    let l = url.trim();
    let rest = if l.len() > 8 && l[..8].eq_ignore_ascii_case("https://") {
        &l[8..]
    } else if l.len() > 7 && l[..7].eq_ignore_ascii_case("http://") {
        &l[7..]
    } else {
        return None;
    };
    let auth = rest.split(['/', '?', '#']).next().unwrap_or("");
    let auth = auth.rsplit('@').next().unwrap_or("");
    let host = if let Some(r) = auth.strip_prefix('[') {
        r.split(']').next().unwrap_or("")
    } else {
        auth.split(':').next().unwrap_or("")
    };
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

/// A host on this computer or the local network (loopback, private IPv4 ranges, link-local, «localhost», «.local»).
pub fn host_private(h: &str) -> bool {
    if h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local") || h == "::1" || h.starts_with("fe80:") || ((h.starts_with("fc") || h.starts_with("fd")) && h.contains(':')) {
        return true;
    }
    let p: Vec<u8> = match h.split('.').map(|x| x.parse::<u8>()).collect::<Result<Vec<u8>, _>>() {
        Ok(p) if p.len() == 4 => p,
        _ => return false,
    };
    p[0] == 127 || p[0] == 10 || (p[0] == 172 && (16..=31).contains(&p[1])) || (p[0] == 192 && p[1] == 168) || (p[0] == 169 && p[1] == 254) || p[0] == 0
}

/// How an address is asked about: a HEAD (what the page fetched by script — never a body asked for again), or a GET of
/// its first byte (what an element loaded: some servers answer HEAD badly).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ProbeHow {
    Head,
    FirstByte,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub url: String,
    pub how: ProbeHow,
}

/// Addresses that cannot be media whatever their server says (scripts, styles, pictures, fonts, data).
const NOT_MEDIA: &[&str] = &["js", "mjs", "css", "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp", "woff", "woff2", "ttf", "otf", "eot", "json", "map", "wasm", "html", "htm", "xml", "txt"];

/// The most addresses one Grab asks about, and the most a page's addresses are asked about in all.
pub const PER_GRAB: usize = 12;
pub const PER_PAGE: u32 = 24;
/// The most requests started in any second.
pub const PER_SECOND: usize = 4;

/// What the page's resource timing listed (address, initiatorType) → the addresses worth asking their content type,
/// in the page's order, at most `max`: http(s) only; not one Grab already has (`known`), nor one already asked
/// (`asked`); none a name already tells (a .mp4, a manifest, a stream's piece — the rule above decides it without
/// asking), nor a script, style, picture or font; a beacon never; an address on this computer or the local network
/// only when the page itself is there. Each address once.
pub fn probe_candidates(page: &str, list: &[(String, String)], known: &dyn Fn(&str) -> bool, asked: &dyn Fn(&str) -> bool, max: usize) -> Vec<Candidate> {
    let page_private = host_of(page).map(|h| host_private(&h)).unwrap_or(false);
    let mut out: Vec<Candidate> = Vec::new();
    for (u, init) in list.iter() {
        if out.len() >= max {
            break;
        }
        let host = match host_of(u) {
            Some(h) => h,
            None => continue,
        };
        if u.len() > 2000 || init == "beacon" || known(u) || asked(u) || out.iter().any(|c| &c.url == u) {
            continue;
        }
        if host_private(&host) && !page_private {
            continue;
        }
        let l = u.to_ascii_lowercase();
        let path = l.split(['?', '#']).next().unwrap_or("");
        if NOT_MEDIA.iter().any(|e| path.ends_with(&format!(".{}", e))) {
            continue;
        }
        // (Named already: the rule decides it — a medium Grab found, or a stream's piece it leaves out.)
        if classify(u, "", "").is_some() || ends_ext(&l, &["ts", "m4s", "aac", "vtt", "key"]) || piece_name(&l) {
            continue;
        }
        let how = if init == "xmlhttprequest" || init == "fetch" { ProbeHow::Head } else { ProbeHow::FirstByte };
        out.push(Candidate { url: u.clone(), how });
    }
    out
}

/// A probe's answer → what Grab lists it as: only a 200 or 206 counts; the rule above with the server's Content-Type.
pub fn probe_kind(status: u16, url: &str, content_type: &str) -> Option<&'static str> {
    if status != 200 && status != 206 {
        return None;
    }
    classify(url, content_type, "")
}

/// A redirect is followed only to the same host, and only a few times (never to another site).
pub fn redirect_ok(from: &str, to: &str, hops: usize) -> bool {
    hops < 3 && host_of(from).is_some() && host_of(from) == host_of(to)
}

/// The probe's pace: at most PER_SECOND started in any second, at most PER_PAGE for one page; what was asked kept
/// (address → kind or none), up to 2000 addresses.
#[derive(Default)]
pub struct Pace {
    started: VecDeque<u64>,
    per_page: HashMap<String, u32>,
    answers: HashMap<String, Option<&'static str>>,
}

impl Pace {
    /// How long to wait (ms) before the next start at `now`.
    pub fn wait_ms(&mut self, now: u64) -> u64 {
        while let Some(&t) = self.started.front() {
            if now >= t + 1000 {
                self.started.pop_front();
            } else {
                break;
            }
        }
        if self.started.len() < PER_SECOND {
            0
        } else {
            self.started.front().map(|&t| t + 1000 - now.min(t + 1000)).unwrap_or(0)
        }
    }
    /// A start at `now` for `page`, if its page has room left.
    pub fn start(&mut self, page: &str, now: u64) -> bool {
        if self.per_page.len() > 200 {
            self.per_page.clear();
        }
        let n = self.per_page.entry(page.to_string()).or_insert(0);
        if *n >= PER_PAGE {
            return false;
        }
        *n += 1;
        self.started.push_back(now);
        true
    }
    pub fn known(&self, url: &str) -> Option<Option<&'static str>> {
        self.answers.get(url).copied()
    }
    pub fn keep(&mut self, url: &str, kind: Option<&'static str>) {
        if self.answers.len() >= 2000 {
            self.answers.clear();
        }
        self.answers.insert(url.to_string(), kind);
    }
}

/* ---------- 3. the in-app browser's sign-ins, carried at the hand-over ---------- */

/// One cookie as the Electron build exported it (Electron's session.cookies.get).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HandedCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub host_only: bool,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub session: bool,
    /// Seconds since 1970 (Electron's expirationDate); 0 when none.
    pub expires: f64,
    /// Electron's sameSite: unspecified, no_restriction, lax, strict.
    pub same_site: String,
}

fn token_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 256 && s.bytes().all(|b| b > 0x20 && b < 0x7f && !b"()<>@,;:\\\"/[]?={}".contains(&b))
}
fn value_ok(s: &str) -> bool {
    // (Printable ASCII without «;» — nothing that could add an attribute to the line.)
    s.len() <= 4096 && s.bytes().all(|b| (0x21..0x7f).contains(&b) && b != b';')
}
fn domain_ok(d: &str) -> bool {
    let d = d.trim_start_matches('.');
    !d.is_empty() && d.len() <= 253 && d.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_') && !d.starts_with('.') && !d.ends_with('.')
}

/// Days and months for an HTTP date.
const WDAY: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
const MON: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// Seconds since 1970 → «Wed, 21 Oct 2015 07:28:00 GMT».
pub fn http_date(secs: u64) -> String {
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    // (Howard Hinnant's days → civil date.)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{}, {:02} {} {:04} {:02}:{:02}:{:02} GMT", WDAY[(days.rem_euclid(7)) as usize], d, MON[(m - 1) as usize], y, rem / 3600, rem % 3600 / 60, rem % 60)
}

/// A handed cookie → a Set-Cookie line for the browser's cookie store, or None: a session cookie (it ended with the
/// old program), an expired one, one ending within the minute, and anything malformed are left out. A host-only
/// cookie names its host without a leading dot, a domain cookie with one.
pub fn set_cookie_line(c: &HandedCookie, now_secs: u64) -> Option<String> {
    if c.session || !c.expires.is_finite() || c.expires <= (now_secs + 60) as f64 {
        return None;
    }
    if !token_ok(&c.name) || !value_ok(&c.value) || !domain_ok(&c.domain) {
        return None;
    }
    let path = if c.path.starts_with('/') && c.path.len() <= 1024 && !c.path.contains(';') && !c.path.bytes().any(|b| b < 0x20) { c.path.as_str() } else { "/" };
    let host = c.domain.trim_start_matches('.');
    let domain = if c.host_only { host.to_string() } else { format!(".{}", host) };
    let exp = c.expires.min(253_402_300_799.0) as u64;
    let mut line = format!("{}={}; Domain={}; Path={}; Expires={}", c.name, c.value, domain, path, http_date(exp));
    let same = match c.same_site.as_str() {
        "strict" => Some("Strict"),
        "lax" => Some("Lax"),
        "no_restriction" => Some("None"),
        _ => None,
    };
    // (SameSite=None is only kept with Secure.)
    if c.secure || same == Some("None") {
        line.push_str("; Secure");
    }
    if c.http_only {
        line.push_str("; HttpOnly");
    }
    if let Some(s) = same {
        line.push_str("; SameSite=");
        line.push_str(s);
    }
    Some(line)
}

/// The address a cookie belongs to (its scheme by Secure), to read it back.
pub fn cookie_url(c: &HandedCookie) -> String {
    format!("{}://{}{}", if c.secure { "https" } else { "http" }, c.domain.trim_start_matches('.'), if c.path.starts_with('/') { c.path.as_str() } else { "/" })
}

/// The handed-over cookies' file and its note, in the hand-over folder (outside the marker's list: it is deleted
/// once read, and the rest must still check out).
pub const COOKIE_FILE: &str = "browser-cookies.json";
pub const COOKIE_NOTE: &str = "browser-cookies.note.json";

/// A file overwritten with zeros, flushed, then deleted (what held cookie values never left lying on the disk in the
/// clear). A file that is not there is fine.
pub fn wipe(p: &Path) -> std::io::Result<()> {
    use std::io::Write;
    let len = match std::fs::metadata(p) {
        Ok(m) => m.len(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if let Ok(mut f) = std::fs::OpenOptions::new().write(true).open(p) {
        let zeros = vec![0u8; 64 * 1024];
        let mut left = len;
        while left > 0 {
            let n = left.min(zeros.len() as u64) as usize;
            if f.write_all(&zeros[..n]).is_err() {
                break;
            }
            left -= n as u64;
        }
        let _ = f.sync_all();
    }
    std::fs::remove_file(p)
}

/* ---------- 4. the Electron build's programs taken over ---------- */

/// What a program must be to be taken: its SHA-256 from a trusted list (yt-dlp's SHA2-256SUMS, gallery-dl's release
/// digest, this release's packs file) and, where the list says it, its size.
#[derive(Debug, Clone, PartialEq)]
pub struct Want {
    pub sha256: String,
    pub size: Option<u64>,
}

/// Whether a file of `size` bytes and digest `sha256` is the program the list names. Nothing else is ever looked at:
/// no program is run to ask its version before this holds.
pub fn adopt_ok(size: u64, sha256: &str, want: &Want) -> bool {
    let w = want.sha256.trim().to_ascii_lowercase();
    w.len() == 64 && w.bytes().all(|b| b.is_ascii_hexdigit()) && sha256.trim().to_ascii_lowercase() == w && want.size.map(|s| s == size).unwrap_or(true) && size > 0
}

/// The ffmpeg pack's key in the packs file (its platform and CPU in Node's words).
pub fn pack_key(platform: &str, arch: &str) -> String {
    format!("{}-{}", platform, arch)
}

/// The pack's version as the page passes it (src/packs.ts versionOf): versions[name], else ydl, else version, else
/// this app's.
pub fn pack_version(versions_name: Option<&str>, ydl: Option<&str>, version: Option<&str>, app: &str) -> String {
    versions_name.or(ydl).or(version).filter(|v| !v.is_empty()).unwrap_or(app).to_string()
}

/// The state kept in this build's data folder: whether to look again at a later start (the lists could not be read:
/// offline) — at most this many starts.
pub const ADOPT_TRIES: u64 = 3;
pub const ADOPT_STATE: &str = "programs-adopted.json";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_links() {
        assert_eq!(task_link("2089b05ecca3d829").as_deref(), Some("kurokawatools://task?id=2089b05ecca3d829"));
        assert_eq!(task_link("v:abc").as_deref(), Some("kurokawatools://task?id=v%3Aabc"));
        assert_eq!(task_link("a b"), None);
        assert_eq!(task_link(""), None);
        assert_eq!(task_link_id("kurokawatools://task?id=2089b05ecca3d829").as_deref(), Some("2089b05ecca3d829"));
        assert_eq!(task_link_id("KUROKAWATOOLS://TASK?ID=v%3Aabc/").as_deref(), Some("v:abc"));
        assert_eq!(task_link_id("kurokawatools://task?id=x&y=1#z").as_deref(), Some("x"));
        assert_eq!(task_link_id("kurokawatools://task?id=<script>"), None);
        assert_eq!(task_link_id("kurokawatools://open?u=magnet"), None);
        assert_eq!(task_link_id("kurokawatools://task?id="), None);
        assert!(!id_ok(&"a".repeat(129)));
    }

    #[test]
    fn toast() {
        let x = toast_xml("a <b> & \"c\"", "1.2 GB", "kurokawatools://task?id=1&x");
        assert!(x.starts_with("<toast activationType=\"protocol\" launch=\"kurokawatools://task?id=1&amp;x\">"));
        assert!(x.contains("<text>a &lt;b&gt; &amp; &quot;c&quot;</text><text>1.2 GB</text>"));
        assert!(!toast_xml("t", "", "l").contains("<text></text>"));
        assert_eq!(xml_escape("a\u{1}b"), "a b");
        assert!(TOAST_PS.contains("$env:KT_TOAST_XML") && TOAST_PS.contains("$env:KT_TOAST_APP"));
    }

    #[test]
    fn reg() {
        let out = "\r\nHKEY_CURRENT_USER\\Software\\Classes\\kurokawatools\\shell\\open\\command\r\n    (Default)    REG_SZ    \"C:\\Users\\a\\AppData\\Local\\Kurokawa Tools\\kurokawa-tools.exe\" \"%1\"\r\n";
        assert!(reg_runs(out, "C:\\Users\\A\\AppData\\Local\\Kurokawa Tools\\kurokawa-tools.exe"));
        assert!(!reg_runs(out, "D:\\portable\\kurokawa-tools.exe"));
        assert!(!reg_runs("ERROR: The system was unable to find the specified registry key", "C:\\x.exe"));
        assert!(!reg_runs(out, ""));
        assert!(clicked("default") && !clicked("__closed") && !clicked(""));
    }

    #[test]
    fn electron_rule() {
        // (Electron's own cases: what the server says decides where the address says nothing.)
        assert_eq!(classify("https://cdn.example/v/abc", "video/mp4", ""), Some("video"));
        assert_eq!(classify("https://cdn.example/v/abc", "Audio/MPEG", ""), Some("music"));
        assert_eq!(classify("https://cdn.example/play?id=1", "application/vnd.apple.mpegurl", ""), Some("video"));
        assert_eq!(classify("https://cdn.example/d/1", "application/dash+xml", ""), Some("video"));
        assert_eq!(classify("https://cdn.example/x/master.m3u8?t=1", "", ""), Some("video"));
        assert_eq!(classify("https://cdn.example/x/Manifest", "", ""), Some("video"));
        assert_eq!(classify("https://cdn.example/x/manifestly", "", ""), None);
        assert_eq!(classify("https://r1.example/videoplayback?id=1", "", ""), Some("video"));
        assert_eq!(classify("https://cdn.example/a.MP4", "", ""), Some("video"));
        assert_eq!(classify("https://cdn.example/a.mp4/b", "", ""), None);
        assert_eq!(classify("https://cdn.example/a", "", "media"), Some("video"));
        assert_eq!(classify("https://cdn.example/a", "audio/ogg", "media"), Some("music"));
        assert_eq!(classify("https://cdn.example/a.flac?x", "", ""), Some("music"));
        assert_eq!(classify("https://cdn.example/f", "application/zip", ""), Some("media"));
        assert_eq!(classify("https://cdn.example/f.epub", "", ""), Some("media"));
        // (A stream's pieces left out — unless it is a playlist.)
        assert_eq!(classify("https://cdn.example/s/seg-12.ts", "video/mp2t", ""), None);
        assert_eq!(classify("https://cdn.example/s/x", "video/MP2T", ""), None);
        assert_eq!(classify("https://cdn.example/s/segment3.m4s", "video/iso.segment", ""), None);
        assert_eq!(classify("https://cdn.example/s/chunk_7.mp4", "video/mp4", ""), None);
        assert_eq!(classify("https://cdn.example/s/init.mp4?x=1", "video/mp4", ""), None);
        assert_eq!(classify("https://cdn.example/s/sub.vtt", "text/vtt", ""), None);
        assert_eq!(classify("https://cdn.example/s/list.m3u8", "application/x-mpegurl", ""), Some("video"));
        assert_eq!(classify("https://cdn.example/p", "text/html", ""), None);
        assert_eq!(classify("blob:https://x/1", "video/mp4", ""), None);
        assert_eq!(classify("https://cdn.example/image", "image/png", ""), None);
    }

    #[test]
    fn hosts() {
        assert_eq!(host_of("https://User@Example.COM:8443/a?b").as_deref(), Some("example.com"));
        assert_eq!(host_of("http://[::1]:9/x").as_deref(), Some("::1"));
        assert_eq!(host_of("ftp://x/"), None);
        assert!(host_private("127.0.0.1") && host_private("10.1.2.3") && host_private("192.168.0.4") && host_private("172.20.1.1"));
        assert!(host_private("localhost") && host_private("nas.local") && host_private("::1"));
        assert!(!host_private("172.32.0.1") && !host_private("8.8.8.8") && !host_private("example.com") && !host_private("fdroid.org") && !host_private("fcb.example"));
        assert!(host_private("fd12::1"));
        assert!(redirect_ok("https://a.example/x", "https://a.example/y", 0));
        assert!(!redirect_ok("https://a.example/x", "https://b.example/x", 0));
        assert!(!redirect_ok("http://127.0.0.1:5/x", "http://localhost:5/x", 0));
        assert!(!redirect_ok("https://a.example/x", "https://a.example/y", 3));
    }

    #[test]
    fn candidates() {
        let l = |v: &[(&str, &str)]| v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>();
        let list = l(&[
            ("https://site.example/app.js", "script"),
            ("https://cdn.example/stream?id=9", "xmlhttprequest"),
            ("https://cdn.example/stream?id=9", "fetch"),
            ("https://cdn.example/clip", "other"),
            ("https://cdn.example/v.mp4", "video"),
            ("https://cdn.example/s/seg-1.ts", "xmlhttprequest"),
            ("https://stats.example/hit", "beacon"),
            ("https://site.example/logo.PNG?x=1", "img"),
            ("http://192.168.1.2/cam", "other"),
            ("https://cdn.example/known", "fetch"),
            ("https://cdn.example/asked", "fetch"),
            ("data:text/plain,x", "other"),
        ]);
        let known = |u: &str| u.ends_with("/known");
        let asked = |u: &str| u.ends_with("/asked");
        let c = probe_candidates("https://site.example/watch", &list, &known, &asked, 12);
        assert_eq!(c, vec![Candidate { url: "https://cdn.example/stream?id=9".into(), how: ProbeHow::Head }, Candidate { url: "https://cdn.example/clip".into(), how: ProbeHow::FirstByte }]);
        assert_eq!(probe_candidates("https://site.example/watch", &list, &known, &asked, 1).len(), 1);
        // (A page on this computer may have its own addresses asked about.)
        let c2 = probe_candidates("http://127.0.0.1:8080/p", &l(&[("http://127.0.0.1:8080/clip", "fetch")]), &known, &asked, 12);
        assert_eq!(c2.len(), 1);
        assert_eq!(probe_kind(206, "https://cdn.example/clip", "video/mp4"), Some("video"));
        assert_eq!(probe_kind(200, "https://cdn.example/clip", "text/html; charset=utf-8"), None);
        assert_eq!(probe_kind(403, "https://cdn.example/clip", "video/mp4"), None);
    }

    #[test]
    fn pace() {
        let mut p = Pace::default();
        for i in 0..PER_SECOND as u64 {
            assert_eq!(p.wait_ms(1000 + i), 0);
            assert!(p.start("pg", 1000 + i));
        }
        assert_eq!(p.wait_ms(1500), 500);
        assert_eq!(p.wait_ms(2000), 0);
        let mut q = Pace::default();
        for i in 0..PER_PAGE as u64 {
            assert!(q.start("a", i * 10_000));
        }
        assert!(!q.start("a", 1_000_000));
        assert!(q.start("b", 1_000_000));
        q.keep("u", Some("video"));
        q.keep("w", None);
        assert_eq!(q.known("u"), Some(Some("video")));
        assert_eq!(q.known("w"), Some(None));
        assert_eq!(q.known("z"), None);
    }

    #[test]
    fn dates() {
        assert_eq!(http_date(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(http_date(1445412480), "Wed, 21 Oct 2015 07:28:00 GMT");
        assert_eq!(http_date(951782400), "Tue, 29 Feb 2000 00:00:00 GMT");
        assert_eq!(http_date(4102444799), "Thu, 31 Dec 2099 23:59:59 GMT");
    }

    #[test]
    fn cookies() {
        let now = 1_700_000_000u64;
        let base = HandedCookie { name: "sid".into(), value: "abc123".into(), domain: ".example.org".into(), host_only: false, path: "/".into(), secure: true, http_only: true, session: false, expires: (now + 86400) as f64, same_site: "lax".into() };
        let l = set_cookie_line(&base, now).unwrap();
        assert!(l.starts_with("sid=abc123; Domain=.example.org; Path=/; Expires="), "{}", l);
        assert!(l.ends_with("; Secure; HttpOnly; SameSite=Lax"), "{}", l);
        let host = HandedCookie { domain: "127.0.0.1".into(), host_only: true, secure: false, http_only: false, same_site: "unspecified".into(), path: "/site".into(), ..base.clone() };
        let h = set_cookie_line(&host, now).unwrap();
        assert!(h.starts_with("sid=abc123; Domain=127.0.0.1; Path=/site; Expires=") && !h.contains("Secure") && !h.contains("SameSite"), "{}", h);
        assert_eq!(cookie_url(&host), "http://127.0.0.1/site");
        // (Left out: session-only, expired, ending within the minute, malformed.)
        assert_eq!(set_cookie_line(&HandedCookie { session: true, ..base.clone() }, now), None);
        assert_eq!(set_cookie_line(&HandedCookie { expires: (now - 1) as f64, ..base.clone() }, now), None);
        assert_eq!(set_cookie_line(&HandedCookie { expires: (now + 30) as f64, ..base.clone() }, now), None);
        assert_eq!(set_cookie_line(&HandedCookie { expires: f64::NAN, ..base.clone() }, now), None);
        assert_eq!(set_cookie_line(&HandedCookie { name: "a;b".into(), ..base.clone() }, now), None);
        assert_eq!(set_cookie_line(&HandedCookie { value: "x; Domain=evil".into(), ..base.clone() }, now), None);
        assert_eq!(set_cookie_line(&HandedCookie { domain: "a b".into(), ..base.clone() }, now), None);
        assert_eq!(set_cookie_line(&HandedCookie { domain: ".".into(), ..base.clone() }, now), None);
        let none = set_cookie_line(&HandedCookie { secure: false, same_site: "no_restriction".into(), ..base.clone() }, now).unwrap();
        assert!(none.contains("; Secure") && none.ends_with("SameSite=None"));
        let odd_path = set_cookie_line(&HandedCookie { path: "x;y".into(), ..base.clone() }, now).unwrap();
        assert!(odd_path.contains("Path=/;"));
        let far = set_cookie_line(&HandedCookie { expires: 1e15, ..base.clone() }, now).unwrap();
        assert!(far.contains("Expires=Fri, 31 Dec 9999 23:59:59 GMT"), "{}", far);
    }

    #[test]
    fn wiped() {
        let d = std::env::temp_dir().join(format!("kt-hybrid-wipe-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join(COOKIE_FILE);
        std::fs::write(&f, b"[{\"name\":\"made-up\",\"value\":\"not-a-secret\"}]").unwrap();
        wipe(&f).unwrap();
        assert!(!f.exists());
        wipe(&f).unwrap();
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn adopt() {
        let h = "a".repeat(64);
        assert!(adopt_ok(10, &h.to_uppercase(), &Want { sha256: h.clone(), size: Some(10) }));
        assert!(adopt_ok(10, &h, &Want { sha256: h.clone(), size: None }));
        assert!(!adopt_ok(11, &h, &Want { sha256: h.clone(), size: Some(10) }));
        assert!(!adopt_ok(10, &"b".repeat(64), &Want { sha256: h.clone(), size: None }));
        assert!(!adopt_ok(10, "", &Want { sha256: String::new(), size: None }));
        assert!(!adopt_ok(0, &h, &Want { sha256: h.clone(), size: None }));
        assert!(!adopt_ok(10, "zz", &Want { sha256: "zz".into(), size: None }));
        assert_eq!(pack_key("win32", "x64"), "win32-x64");
        assert_eq!(pack_version(Some("7.1"), Some("y"), None, "1.0"), "7.1");
        assert_eq!(pack_version(None, None, Some("2.0"), "1.0"), "2.0");
        assert_eq!(pack_version(None, None, Some(""), "1.0"), "1.0");
    }
}
