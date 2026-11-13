// The cookies the app's own web requests keep (RFC 6265, the parts browsers follow): what a site sets with
// Set-Cookie is sent back to it on the next request — across redirects too —, as Electron's requests keep the
// session's cookies (main.cjs: net.fetch with useSessionCookies). Cookies with an expiry are kept between runs (a
// file of the app's), the others until the app ends, as a browser's session keeps them. net.rs plugs this jar into
// its web client through reqwest's cookie hook. Std only, checked alone with `rustc --edition 2021 --test
// cookiejar.rs`.

#[derive(Debug, Clone, PartialEq)]
pub struct Cookie {
    pub name: String,
    pub value: String,
    /// Lowercase, without a leading dot.
    pub domain: String,
    /// Set without a Domain attribute: sent to that host only.
    pub host_only: bool,
    pub path: String,
    pub secure: bool,
    /// Unix seconds; None: until the app ends.
    pub expires: Option<u64>,
    seq: u64,
}

pub struct Jar {
    list: Vec<Cookie>,
    seq: u64,
}

/// At most this many cookies; the oldest go first.
pub const MAX_COOKIES: usize = 3000;

fn is_ip(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    h.parse::<std::net::IpAddr>().is_ok()
}

/// RFC 6265's domain-match: the host is the domain, or ends with «.domain» (not for an address).
pub fn domain_match(host: &str, domain: &str) -> bool {
    host == domain || (!is_ip(host) && host.len() > domain.len() && host.ends_with(domain) && host.as_bytes()[host.len() - domain.len() - 1] == b'.')
}

/// RFC 6265's path-match.
pub fn path_match(req: &str, path: &str) -> bool {
    if req == path {
        return true;
    }
    req.starts_with(path) && (path.ends_with('/') || req.as_bytes().get(path.len()) == Some(&b'/'))
}

/// The default path of a cookie set by a request for `req_path`: up to its last «/», or «/».
pub fn default_path(req_path: &str) -> String {
    if !req_path.starts_with('/') {
        return "/".to_string();
    }
    match req_path.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(i) => req_path[..i].to_string(),
    }
}

/// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// An Expires date as RFC 6265 reads one (any order of a time, a day, a month's name, a year; «Sun, 06 Nov 1994
/// 08:49:37 GMT», «Sunday, 06-Nov-94 08:49:37 GMT», «Sun Nov  6 08:49:37 1994») → Unix seconds; None if it is none.
pub fn parse_date(s: &str) -> Option<u64> {
    let mut time: Option<(u32, u32, u32)> = None;
    let mut day: Option<u32> = None;
    let mut month: Option<u32> = None;
    let mut year: Option<i64> = None;
    const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    for tok in s.split(|c: char| !(c.is_ascii_alphanumeric() || c == ':')) {
        if tok.is_empty() {
            continue;
        }
        if time.is_none() && tok.contains(':') {
            let p: Vec<&str> = tok.split(':').collect();
            if p.len() == 3 {
                let n: Vec<Option<u32>> = p.iter().map(|x| x.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()).collect();
                if let (Some(h), Some(mi), Some(se)) = (n[0], n[1], n[2]) {
                    time = Some((h, mi, se));
                    continue;
                }
            }
        }
        let digits: String = tok.chars().take_while(|c| c.is_ascii_digit()).collect();
        if day.is_none() && !digits.is_empty() && digits.len() <= 2 && tok.len() == digits.len() {
            day = digits.parse().ok();
            continue;
        }
        if month.is_none() && tok.len() >= 3 {
            let l = tok[..3].to_ascii_lowercase();
            if let Some(i) = MONTHS.iter().position(|m| *m == l) {
                month = Some(i as u32 + 1);
                continue;
            }
        }
        if year.is_none() && (digits.len() == 2 || digits.len() == 4) && tok.len() == digits.len() {
            let mut y: i64 = digits.parse().ok()?;
            if (70..=99).contains(&y) {
                y += 1900;
            } else if (0..=69).contains(&y) && digits.len() == 2 {
                y += 2000;
            }
            year = Some(y);
            continue;
        }
    }
    let (h, mi, se) = time?;
    let (d, mo, y) = (day?, month?, year?);
    if !(1..=31).contains(&d) || y < 1601 || h > 23 || mi > 59 || se > 59 {
        return None;
    }
    let days = days_from_civil(y, mo, d);
    let secs = days * 86400 + (h as i64) * 3600 + (mi as i64) * 60 + se as i64;
    Some(if secs < 0 { 0 } else { secs as u64 })
}

impl Jar {
    pub const fn new() -> Jar {
        Jar { list: Vec::new(), seq: 0 }
    }

    pub fn len(&self) -> usize {
        self.list.len()
    }

    pub fn cookies(&self) -> &[Cookie] {
        &self.list
    }

    /// One Set-Cookie line from a response of `host` (lowercase), its path, over https or not → whether the cookies
    /// kept between runs changed (the caller then saves them).
    pub fn set(&mut self, line: &str, host: &str, req_path: &str, secure_req: bool, now: u64) -> bool {
        let host = host.to_ascii_lowercase();
        let mut parts = line.split(';');
        let pair = parts.next().unwrap_or("").trim();
        let (name, value) = match pair.find('=') {
            Some(i) => (pair[..i].trim().to_string(), pair[i + 1..].trim().to_string()),
            None => (String::new(), pair.to_string()),
        };
        if name.is_empty() && value.is_empty() {
            return false;
        }
        if name.len() + value.len() > 4096 || name.contains(|c: char| c.is_control()) || value.contains(|c: char| c.is_control()) {
            return false;
        }
        let mut domain: Option<String> = None;
        let mut path: Option<String> = None;
        let mut secure = false;
        let mut max_age: Option<i64> = None;
        let mut expires: Option<u64> = None;
        for attr in parts {
            let attr = attr.trim();
            let (k, v) = match attr.find('=') {
                Some(i) => (attr[..i].trim().to_ascii_lowercase(), attr[i + 1..].trim()),
                None => (attr.to_ascii_lowercase(), ""),
            };
            match k.as_str() {
                "domain" => {
                    let d = v.trim_start_matches('.').to_ascii_lowercase();
                    if !d.is_empty() {
                        domain = Some(d);
                    }
                }
                "path" => {
                    if v.starts_with('/') {
                        path = Some(v.to_string());
                    }
                }
                "secure" => secure = true,
                "max-age" => {
                    let ok = !v.is_empty() && v.chars().enumerate().all(|(i, c)| c.is_ascii_digit() || (i == 0 && c == '-'));
                    if ok {
                        max_age = Some(v.parse::<i64>().unwrap_or(if v.starts_with('-') { -1 } else { i64::MAX }));
                    }
                }
                "expires" => {
                    if let Some(t) = parse_date(v) {
                        expires = Some(t);
                    }
                }
                _ => {}
            }
        }
        // (A secure cookie only from a secure page.)
        if secure && !secure_req {
            return false;
        }
        let (dom, host_only) = match domain {
            Some(d) => {
                if !domain_match(&host, &d) {
                    return false;
                }
                // (A bare top-level name — «com» — is never a cookie's domain; an address only as itself.)
                if !d.contains('.') && d != host {
                    return false;
                }
                (d, false)
            }
            None => (host.clone(), true),
        };
        let exp: Option<u64> = match max_age {
            Some(n) if n <= 0 => Some(0),
            Some(n) => Some(now.saturating_add(n as u64)),
            None => expires,
        };
        let path = path.unwrap_or_else(|| default_path(req_path));
        let before_persistent = self.list.iter().any(|c| c.name == name && c.domain == dom && c.path == path && c.expires.is_some());
        self.list.retain(|c| !(c.name == name && c.domain == dom && c.path == path));
        let expired = matches!(exp, Some(t) if t <= now);
        if expired {
            return before_persistent;
        }
        self.seq += 1;
        self.list.push(Cookie { name, value, domain: dom, host_only, path, secure, expires: exp, seq: self.seq });
        if self.list.len() > MAX_COOKIES {
            self.list.remove(0);
        }
        before_persistent || exp.is_some()
    }

    /// The Cookie header for a request to `host`, `path`, over https or not; None when no cookie goes with it.
    /// (Longer paths first, then the older first, as browsers send them.)
    pub fn header(&self, host: &str, path: &str, secure_req: bool, now: u64) -> Option<String> {
        let host = host.to_ascii_lowercase();
        let path = if path.is_empty() { "/" } else { path };
        let mut hit: Vec<&Cookie> = self
            .list
            .iter()
            .filter(|c| {
                let dom_ok = if c.host_only { c.domain == host } else { domain_match(&host, &c.domain) };
                dom_ok && path_match(path, &c.path) && (!c.secure || secure_req) && c.expires.map(|t| t > now).unwrap_or(true)
            })
            .collect();
        if hit.is_empty() {
            return None;
        }
        hit.sort_by(|a, b| b.path.len().cmp(&a.path.len()).then(a.seq.cmp(&b.seq)));
        let parts: Vec<String> = hit
            .iter()
            .map(|c| if c.name.is_empty() { c.value.clone() } else { format!("{}={}", c.name, c.value) })
            .collect();
        Some(parts.join("; "))
    }

    /// Cookies of `host` (or of every site, with `all`) taken away → how many.
    pub fn forget(&mut self, host: &str, all: bool) -> usize {
        let host = host.to_ascii_lowercase();
        let before = self.list.len();
        if all {
            self.list.clear();
        } else {
            self.list.retain(|c| !(domain_match(&host, &c.domain) || domain_match(&c.domain, &host)));
        }
        before - self.list.len()
    }

    /// Cookies taken away (the in-app browser's «forget», stage R4): those of `host` — its own and its parent
    /// domains', as forget's — or of every site (None), whose name `pick` accepts → each one's (domain, name).
    pub fn forget_picked(&mut self, host: Option<&str>, pick: &dyn Fn(&str) -> bool) -> Vec<(String, String)> {
        let host = host.map(|h| h.to_ascii_lowercase());
        let mut gone: Vec<(String, String)> = Vec::new();
        self.list.retain(|c| {
            let site = match &host {
                Some(h) => domain_match(h, &c.domain) || domain_match(&c.domain, h),
                None => true,
            };
            if site && pick(&c.name) {
                gone.push((c.domain.clone(), c.name.clone()));
                false
            } else {
                true
            }
        });
        gone
    }

    /// The cookies kept between runs (those with an expiry still to come), one per line: domain, host-only (1/0),
    /// path, secure (1/0), expiry, name, value — tab-separated.
    pub fn to_lines(&self, now: u64) -> String {
        let mut out = String::new();
        for c in self.list.iter() {
            let exp = match c.expires {
                Some(t) if t > now => t,
                _ => continue,
            };
            if c.name.contains('\t') || c.value.contains('\t') || c.path.contains('\t') {
                continue;
            }
            out.push_str(&format!(
                "{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
                c.domain,
                if c.host_only { 1 } else { 0 },
                c.path,
                if c.secure { 1 } else { 0 },
                exp,
                c.name,
                c.value
            ));
        }
        out
    }

    /// Cookies read back from to_lines' text (expired or broken lines left out) → how many.
    pub fn load_lines(&mut self, text: &str, now: u64) -> usize {
        let mut n = 0;
        for line in text.lines() {
            let f: Vec<&str> = line.split('\t').collect();
            if f.len() != 7 {
                continue;
            }
            let exp: u64 = match f[4].parse() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if exp <= now || f[0].is_empty() || !f[2].starts_with('/') {
                continue;
            }
            let (name, domain, path) = (f[5].to_string(), f[0].to_ascii_lowercase(), f[2].to_string());
            self.list.retain(|c| !(c.name == name && c.domain == domain && c.path == path));
            self.seq += 1;
            self.list.push(Cookie { name, value: f[6].to_string(), domain, host_only: f[1] == "1", path, secure: f[3] == "1", expires: Some(exp), seq: self.seq });
            n += 1;
        }
        while self.list.len() > MAX_COOKIES {
            self.list.remove(0);
        }
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_700_000_000;

    #[test]
    fn dates() {
        assert_eq!(parse_date("Sun, 06 Nov 1994 08:49:37 GMT"), Some(784111777));
        assert_eq!(parse_date("Sunday, 06-Nov-94 08:49:37 GMT"), Some(784111777));
        assert_eq!(parse_date("Sun Nov  6 08:49:37 1994"), Some(784111777));
        assert_eq!(parse_date("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0));
        assert_eq!(parse_date("Wed, 21 Oct 2037 07:28:00 GMT"), Some(2139722880));
        assert_eq!(parse_date("tomorrow"), None);
        assert_eq!(parse_date(""), None);
    }

    #[test]
    fn matching() {
        assert!(domain_match("a.example.com", "example.com"));
        assert!(domain_match("example.com", "example.com"));
        assert!(!domain_match("badexample.com", "example.com"));
        assert!(!domain_match("1.2.3.4", "3.4"));
        assert!(path_match("/a/b", "/a"));
        assert!(path_match("/a/b", "/a/"));
        assert!(path_match("/a", "/a"));
        assert!(!path_match("/ab", "/a"));
        assert!(path_match("/x", "/"));
        assert_eq!(default_path("/a/b/c"), "/a/b");
        assert_eq!(default_path("/a"), "/");
        assert_eq!(default_path(""), "/");
    }

    #[test]
    fn set_and_send() {
        let mut j = Jar::new();
        assert!(!j.set("sid=abc; Path=/; HttpOnly", "Site.example", "/login", false, NOW));
        assert!(!j.set("pref=1", "site.example", "/a/b", false, NOW));
        assert!(j.set("keep=yes; Max-Age=3600; Domain=.site.example", "site.example", "/", false, NOW));
        assert_eq!(j.header("site.example", "/", false, NOW).as_deref(), Some("sid=abc; keep=yes"));
        assert_eq!(j.header("site.example", "/a/b/c", false, NOW).as_deref(), Some("pref=1; sid=abc; keep=yes"));
        // (Host-only: not to a sub-domain; the Domain one is.)
        assert_eq!(j.header("www.site.example", "/", false, NOW).as_deref(), Some("keep=yes"));
        assert_eq!(j.header("other.example", "/", false, NOW), None);
        // (Expired by time.)
        assert_eq!(j.header("site.example", "/", false, NOW + 3601).as_deref(), Some("sid=abc"));
        // (Replaced, then deleted by Max-Age=0.)
        j.set("sid=new; Path=/", "site.example", "/", false, NOW);
        assert_eq!(j.header("site.example", "/", false, NOW).as_deref(), Some("keep=yes; sid=new"));
        j.set("sid=; Path=/; Max-Age=0", "site.example", "/", false, NOW);
        assert_eq!(j.header("site.example", "/", false, NOW).as_deref(), Some("keep=yes"));
        assert!(j.set("keep=; Domain=site.example; Expires=Thu, 01 Jan 1970 00:00:00 GMT", "site.example", "/", false, NOW));
        assert_eq!(j.header("site.example", "/", false, NOW), None);
    }

    #[test]
    fn refused() {
        let mut j = Jar::new();
        j.set("a=1; Domain=other.example", "site.example", "/", true, NOW);
        j.set("b=1; Domain=com", "site.com", "/", true, NOW);
        j.set("c=1; Secure", "site.example", "/", false, NOW);
        j.set("", "site.example", "/", false, NOW);
        assert_eq!(j.len(), 0);
        j.set("d=1; Secure", "site.example", "/", true, NOW);
        assert_eq!(j.header("site.example", "/", false, NOW), None);
        assert_eq!(j.header("site.example", "/", true, NOW).as_deref(), Some("d=1"));
        j.set("e=1; Domain=127.0.0.1", "127.0.0.1", "/", false, NOW);
        assert_eq!(j.header("127.0.0.1", "/", false, NOW).as_deref(), Some("e=1"));
    }

    #[test]
    fn kept_between_runs() {
        let mut j = Jar::new();
        j.set("s=session", "a.example", "/", true, NOW);
        j.set("p=kept; Max-Age=100; Secure; Domain=a.example; Path=/x", "a.example", "/", true, NOW);
        j.set("gone=1; Max-Age=1", "a.example", "/", true, NOW);
        let text = j.to_lines(NOW + 5);
        assert_eq!(text, format!("a.example\t0\t/x\t1\t{}\tp\tkept\n", NOW + 100));
        let mut k = Jar::new();
        assert_eq!(k.load_lines(&text, NOW + 5), 1);
        assert_eq!(k.header("b.a.example", "/x/y", true, NOW + 5).as_deref(), Some("p=kept"));
        assert_eq!(k.load_lines(&text, NOW + 200), 0);
        assert_eq!(k.load_lines("broken\nline\twith\ttabs", NOW), 0);
        assert_eq!(k.len(), 1);
        assert_eq!(k.forget("a.example", false), 1);
        assert_eq!(k.len(), 0);
    }

    #[test]
    fn forget_picked_and_a_browsers_line() {
        let mut j = Jar::new();
        // (A cookie as the in-app browser's store writes it — cookie's Display: «name=value; HttpOnly; …» —, put in.)
        assert!(!j.set("cf_clearance=x; HttpOnly; SameSite=None; Secure; Path=/; Domain=.site.example", "site.example", "/", true, NOW));
        j.set("sid=1; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT", "www.site.example", "/", true, NOW);
        j.set("o=1", "other.example", "/", true, NOW);
        assert_eq!(j.header("www.site.example", "/", true, NOW).as_deref(), Some("cf_clearance=x; sid=1"));
        let gone = j.forget_picked(Some("www.site.example"), &|n| n == "cf_clearance");
        assert_eq!(gone, vec![("site.example".to_string(), "cf_clearance".to_string())]);
        assert_eq!(j.header("www.site.example", "/", true, NOW).as_deref(), Some("sid=1"));
        let all = j.forget_picked(None, &|_| true);
        assert_eq!(all.len(), 2);
        assert_eq!(j.len(), 0);
    }

    #[test]
    fn capped() {
        let mut j = Jar::new();
        for i in 0..(MAX_COOKIES + 10) {
            j.set(&format!("c{}=1", i), "a.example", "/", false, NOW);
        }
        assert_eq!(j.len(), MAX_COOKIES);
        assert!(j.header("a.example", "/", false, NOW).unwrap().starts_with("c10=1"));
    }
}
