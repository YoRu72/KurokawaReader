// DNS over HTTPS for Tools — the rules, in one place (stage 0.21 P9; it replaces P8's dohnames): the resolvers offered
// (doh-providers.txt, read here), the user's own address checked, the order the resolvers are asked in (the chosen
// one first, or in «auto» the fastest healthy one; the failing ones last), when the health probe may run again, which
// answered addresses are kept, the cache (time to live honoured, with floors, ceilings and a size cap; «no such name»
// kept briefly), the chain itself (the next resolver on a failure; the system's DNS only when the user allowed it,
// and then said so), and a UDP tracker's address with the resolver's answer in place of its name.
//
// No transport here: the shells ask the resolvers (Tauri: the shared crate's net.rs; the phone: KrDoh.java; Electron:
// desktop/dohchain.cjs) and hand the answers to these rules. The phone and Electron keep twins of the rules, checked
// against doh-cases.txt by tests/native/doh/CT.java and tests/dohchain.cjs; this file's tests read the same lines.
// Std only: `rustc --edition 2021 --test dohchain.rs`.
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::OnceLock;

/// The table (doh-providers.txt), as written.
pub const PROVIDERS_TXT: &str = include_str!("doh-providers.txt");

/// The health probe asks this name (IANA's, answered by every public resolver).
pub const PROBE_NAME: &str = "example.com";
/// The probe runs again at most this often while DoH is on (and only when something asks a name: no timer).
pub const PROBE_EVERY_S: u64 = 1800;
/// A failure older than this no longer pushes a resolver to the end: it is «not checked» again.
pub const FAIL_FORGET_S: u64 = 600;
/// The cache: an answer kept at least / at most this long whatever its TTL; «no such name» kept this long; entries.
pub const TTL_MIN_S: u64 = 30;
pub const TTL_MAX_S: u64 = 3600;
pub const NEG_TTL_S: u64 = 30;
pub const CACHE_MAX: usize = 512;
/// An answer bigger than this is refused (a DNS message is at most 65535 bytes; a resolver's answer for A/AAAA is
/// a few hundred).
pub const ANSWER_MAX: usize = 65535;
/// One resolver's question gives up after this long; the whole chain after this long.
pub const ASK_TIMEOUT_MS: u64 = 6000;
pub const CHAIN_DEADLINE_MS: u64 = 20000;

#[derive(Debug, Clone, PartialEq)]
pub struct Provider {
    pub id: String,
    pub label: String,
    pub url: String,
    pub ips: Vec<IpAddr>,
    pub json: bool,
    pub filters: String,
}

impl Provider {
    pub fn host(&self) -> String {
        host_of(&self.url).unwrap_or_default()
    }
}

/// doh-providers.txt read: one provider a line (comments and blank lines skipped).
pub fn parse_providers(text: &str) -> Vec<Provider> {
    let mut out = Vec::new();
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') {
            continue;
        }
        let f: Vec<&str> = l.split('|').collect();
        if f.len() != 6 {
            continue;
        }
        let ips = f[3].split(',').filter_map(|s| s.trim().parse::<IpAddr>().ok()).collect();
        out.push(Provider { id: f[0].to_string(), label: f[1].to_string(), url: f[2].to_string(), ips, json: f[4] == "json", filters: f[5].to_string() });
    }
    out
}

pub fn catalog() -> &'static [Provider] {
    static C: OnceLock<Vec<Provider>> = OnceLock::new();
    C.get_or_init(|| parse_providers(PROVIDERS_TXT))
}

pub fn find(id: &str) -> Option<&'static Provider> {
    catalog().iter().find(|p| p.id == id)
}

/// The host of an http(s) address (IPv6 without its brackets), lowercased.
pub fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let auth = rest.split(['/', '?', '#']).next().unwrap_or("");
    let auth = auth.rsplit('@').next().unwrap_or(auth);
    let host = if let Some(h) = auth.strip_prefix('[') { h.split(']').next().unwrap_or("") } else { auth.split(':').next().unwrap_or("") };
    if host.is_empty() { None } else { Some(host.to_ascii_lowercase()) }
}

/* ---------- the choice ---------- */

#[derive(Debug, Clone, PartialEq)]
pub enum Choice {
    Off,
    Auto,
    Pinned(String),
    Custom(String),
}

/// The setting as saved («off», «auto», a provider's id, or an address) → the choice. A name no longer offered
/// (Mullvad, discontinued; OpenDNS, removed) → Auto; anything else unknown, or an address that fails `validate_custom` → Off.
pub fn parse_choice(s: &str) -> Choice {
    let p = s.trim();
    if p == "auto" || p == "mullvad" || p == "opendns" {
        return Choice::Auto;
    }
    if find(p).is_some() {
        return Choice::Pinned(p.to_string());
    }
    if p.contains("://") {
        if let Ok(u) = validate_custom(p) {
            return Choice::Custom(u);
        }
    }
    Choice::Off
}

/// The user's own resolver checked: https only (or http on this device — a resolver of one's own, and the tests'),
/// a host, a port that is one, no user name or password, a path of its own (not «/»), no fragment, no spaces.
pub fn validate_custom(url: &str) -> Result<String, &'static str> {
    let u = url.trim();
    if u.len() > 512 {
        return Err("tooLong");
    }
    if u.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("space");
    }
    let lower = u.to_ascii_lowercase();
    let rest = if let Some(r) = lower.strip_prefix("https://") {
        r
    } else if let Some(r) = lower.strip_prefix("http://") {
        // (Plain http only to this device: a resolver of one's own, and the tests'.)
        let h = host_of(u).unwrap_or_default();
        if !(h == "127.0.0.1" || h == "localhost" || h == "::1") {
            return Err("notHttps");
        }
        r
    } else {
        return Err("notHttps");
    };
    let auth_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let auth = &rest[..auth_end];
    let path = &rest[auth_end..];
    if auth.contains('@') {
        return Err("userinfo");
    }
    let (host, port) = if let Some(h) = auth.strip_prefix('[') {
        match h.split_once(']') {
            Some((a, p)) => (a, p.strip_prefix(':')),
            None => return Err("noHost"),
        }
    } else {
        match auth.split_once(':') {
            Some((a, p)) => (a, Some(p)),
            None => (auth, None),
        }
    };
    if host.is_empty() {
        return Err("noHost");
    }
    if let Some(p) = port {
        match p.parse::<u32>() {
            Ok(n) if (1..=65535).contains(&n) => {}
            _ => return Err("badPort"),
        }
    }
    if path.contains('#') || !path.starts_with('/') || path == "/" || path.starts_with("/?") {
        return Err("badPath");
    }
    Ok(u.to_string())
}

/// A resolver on this device (plain http to 127.0.0.1, localhost or ::1): asked alone — the user runs their own.
pub fn is_on_device(url: &str) -> bool {
    url.trim().to_ascii_lowercase().starts_with("http://") && matches!(host_of(url).as_deref(), Some("127.0.0.1") | Some("localhost") | Some("::1"))
}

/* ---------- health and the order ---------- */

#[derive(Debug, Clone, PartialEq)]
pub struct Health {
    pub ok: bool,
    pub ms: u64,
    /// When (seconds) it was last asked.
    pub at: u64,
    pub reason: String,
}

pub fn note(health: &mut HashMap<String, Health>, id: &str, ok: bool, ms: u64, reason: &str, now: u64) {
    health.insert(id.to_string(), Health { ok, ms, at: now, reason: reason.to_string() });
}

/// The resolvers asked, in order: the chosen one first («custom» for the user's address; alone when it is on this
/// device), then the rest — the
/// healthy ones quickest first, the ones not checked (or whose failure is old) in the table's order, the ones that
/// failed lately last.
pub fn order(choice: &Choice, health: &HashMap<String, Health>, now: u64) -> Vec<String> {
    let first: Option<String> = match choice {
        Choice::Off => return Vec::new(),
        Choice::Auto => None,
        Choice::Pinned(id) => Some(id.clone()),
        Choice::Custom(u) if is_on_device(u) => return vec!["custom".to_string()],
        Choice::Custom(_) => Some("custom".to_string()),
    };
    let rank = |id: &str| -> (u8, u64) {
        match health.get(id) {
            Some(h) if h.ok => (0, h.ms),
            Some(h) if now.saturating_sub(h.at) < FAIL_FORGET_S => (2, 0),
            _ => (1, 0),
        }
    };
    let mut rest: Vec<(usize, &Provider)> = catalog().iter().enumerate().filter(|(_, p)| Some(&p.id) != first.as_ref()).collect();
    rest.sort_by(|(i, a), (j, b)| rank(&a.id).cmp(&rank(&b.id)).then(i.cmp(j)));
    let mut out: Vec<String> = first.into_iter().collect();
    out.extend(rest.into_iter().map(|(_, p)| p.id.clone()));
    out
}

/// Whether the probe may run again: never while off; at once when nothing is known; else after PROBE_EVERY_S, or
/// after a failure of the chain if the last probe is more than a minute old (a re-pick).
pub fn probe_due(on: bool, last_probe: Option<u64>, chain_failed_since: bool, now: u64) -> bool {
    if !on {
        return false;
    }
    match last_probe {
        None => true,
        Some(at) => now.saturating_sub(at) >= PROBE_EVERY_S || (chain_failed_since && now.saturating_sub(at) >= 60),
    }
}

/* ---------- the answers kept ---------- */

/// Names of this device or its network: never put to a public resolver (the system's own lookup answers them; this
/// is not a fall-back — they have no public answer).
pub fn is_local_name(name: &str) -> bool {
    let n = name.trim_end_matches('.').to_ascii_lowercase();
    // (A single label — «router», «nas» — is a name of the network the device is on: it has no public answer.)
    (!n.is_empty() && !n.contains('.')) || n == "localhost" || [".localhost", ".local", ".home.arpa", ".lan", ".internal"].iter().any(|s| n.ends_with(s))
}

/// An answered address worth connecting to: never the unspecified, this device, a link-local, a multicast, a
/// broadcast or a reserved (240/4) address; from a public resolver not this device's (loopback) nor a private network's either (10/8, 172.16/12,
/// 192.168/16, 100.64/10, the benchmarking 198.18/15, fc00::/7) — a filter's «blocked» answer, or a rebinding. An IPv6
/// form that carries an IPv4 address (mapped ::ffff:0:0/96, IPv4-compatible ::/96, NAT64 64:ff9b::/96, 6to4
/// 2002::/16) is judged by the address it carries. The user's own resolver may know private names.
pub fn address_ok(ip: &IpAddr, from_custom: bool) -> bool {
    match ip {
        IpAddr::V4(a) => {
            let o = a.octets();
            if a.is_unspecified() || a.is_link_local() || a.is_multicast() || o[0] >= 240 || o[0] == 0 {
                return false;
            }
            if a.is_loopback() {
                return from_custom;
            }
            let private = o[0] == 10 || (o[0] == 172 && (16..=31).contains(&o[1])) || (o[0] == 192 && o[1] == 168) || (o[0] == 100 && (64..=127).contains(&o[1])) || (o[0] == 198 && (o[1] == 18 || o[1] == 19));
            from_custom || !private
        }
        IpAddr::V6(a) => {
            let s = a.segments();
            let carried = |hi: u16, lo: u16| IpAddr::V4(std::net::Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8));
            if let Some(v4) = a.to_ipv4_mapped() {
                return address_ok(&IpAddr::V4(v4), from_custom);
            }
            if a.is_unspecified() || a.is_multicast() || (s[0] & 0xffc0) == 0xfe80 {
                return false;
            }
            if a.is_loopback() {
                return from_custom;
            }
            if s[..6].iter().all(|x| *x == 0) || (s[0] == 0x64 && s[1] == 0xff9b && s[2..6].iter().all(|x| *x == 0)) {
                return address_ok(&carried(s[6], s[7]), from_custom);
            }
            if s[0] == 0x2002 {
                return address_ok(&carried(s[1], s[2]), from_custom);
            }
            from_custom || (s[0] & 0xfe00) != 0xfc00
        }
    }
}

/// Whether `id`'s resolver blocks names by itself (its «blocked» answer is an answer, not a failure): the table's
/// filters, and the user's own resolver (a filter of one's own, as often as not).
pub fn filters(id: &str) -> bool {
    id == "custom" || find(id).map(|p| p.filters != "none").unwrap_or(false)
}

/// The resolvers the health probe asks: «Check now» (`all`) every one (the user's own first); the automatic probe
/// only those the chain asks first — all of them in «auto», the chosen one alone when one is pinned or one's own. A
/// resolver on this device is asked alone either way (the chain never sends its names elsewhere).
pub fn probe_ids(choice: &Choice, all: bool) -> Vec<String> {
    let table: Vec<String> = catalog().iter().map(|p| p.id.clone()).collect();
    match choice {
        Choice::Off => Vec::new(),
        Choice::Custom(u) if all && !is_on_device(u) => std::iter::once("custom".to_string()).chain(table).collect(),
        Choice::Custom(_) => vec!["custom".to_string()],
        Choice::Pinned(id) if !all => vec![id.clone()],
        _ => table,
    }
}

#[derive(Debug, Clone, PartialEq)]
struct Entry {
    ips: Vec<IpAddr>,
    by: String,
    until: u64,
    stored: u64,
}

/// Answers by name: kept for their TTL within [TTL_MIN_S, TTL_MAX_S]; an empty list is «no such name» (NEG_TTL_S);
/// at most CACHE_MAX names — the expired ones go first, then the ones that would expire soonest.
pub struct Cache {
    map: HashMap<String, Entry>,
}

impl Default for Cache {
    fn default() -> Self {
        Self::new()
    }
}

impl Cache {
    pub fn new() -> Cache {
        Cache { map: HashMap::new() }
    }
    /// (addresses, the resolver that gave them) while fresh; an empty list is a fresh «no such name».
    pub fn get(&self, name: &str, now: u64) -> Option<(Vec<IpAddr>, String)> {
        let e = self.map.get(&name.to_ascii_lowercase())?;
        if e.until > now { Some((e.ips.clone(), e.by.clone())) } else { None }
    }
    /// An old answer, however stale (up to a day), for when every resolver failed — still the resolvers' answer.
    pub fn stale(&self, name: &str, now: u64) -> Option<(Vec<IpAddr>, String)> {
        let e = self.map.get(&name.to_ascii_lowercase())?;
        if !e.ips.is_empty() && now.saturating_sub(e.stored) < 86400 { Some((e.ips.clone(), e.by.clone())) } else { None }
    }
    pub fn put(&mut self, name: &str, ips: Vec<IpAddr>, ttl: u64, by: &str, now: u64) {
        let keep = if ips.is_empty() { NEG_TTL_S } else { ttl.clamp(TTL_MIN_S, TTL_MAX_S) };
        self.insert(name.to_ascii_lowercase(), Entry { ips, by: by.to_string(), until: now + keep, stored: now }, now);
    }
    fn insert(&mut self, key: String, e: Entry, now: u64) {
        if !self.map.contains_key(&key) && self.map.len() >= CACHE_MAX {
            self.map.retain(|_, e| e.until > now);
            while self.map.len() >= CACHE_MAX {
                let k = self.map.iter().min_by_key(|(_, e)| e.until).map(|(k, _)| k.clone());
                match k {
                    Some(k) => {
                        self.map.remove(&k);
                    }
                    None => break,
                }
            }
        }
        self.map.insert(key, e);
    }
    /// A cache of `name`'s entry alone — for asking the resolvers without holding the shared cache's lock.
    pub fn only(&self, name: &str) -> Cache {
        let k = name.to_ascii_lowercase();
        let mut c = Cache::new();
        if let Some(e) = self.map.get(&k) {
            c.map.insert(k, e.clone());
        }
        c
    }
    /// `other`'s entries put in (the caps kept).
    pub fn merge(&mut self, other: Cache, now: u64) {
        for (k, e) in other.map {
            self.insert(k, e, now);
        }
    }
    pub fn clear(&mut self) {
        self.map.clear();
    }
    pub fn len(&self) -> usize {
        self.map.len()
    }
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

/* ---------- the chain ---------- */

/// How one resolver's question ended (the shell's transport and the wire decoder say which).
#[derive(Debug, Clone, PartialEq)]
pub enum Fault {
    /// A failure of the resolver or the way to it: the next one is asked.
    Failed(String),
    /// The resolver answered: the name does not exist (or has no address). Not asked of another.
    NoSuchName,
}

/// Who gave the addresses used — what the details pages show.
#[derive(Debug, Clone, PartialEq)]
pub enum Via {
    Doh { id: String, ms: u64 },
    Cache { id: String },
    /// Every resolver failed; an earlier answer of theirs, older than its TTL, was used.
    Stale { id: String },
    /// Every resolver failed and the user allowed the system's DNS.
    System,
    /// A name of this device or its network (`is_local_name`): the system's own lookup, by rule.
    Local,
}

impl Via {
    /// One short code for the pages: doh:<id>:<ms>, cache:<id>, stale:<id>, system, local.
    pub fn code(&self) -> String {
        match self {
            Via::Doh { id, ms } => format!("doh:{}:{}", id, ms),
            Via::Cache { id } => format!("cache:{}", id),
            Via::Stale { id } => format!("stale:{}", id),
            Via::System => "system".to_string(),
            Via::Local => "local".to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub ips: Vec<IpAddr>,
    pub via: Via,
    /// The resolvers that failed on the way (id, why) — their health is noted by the caller.
    pub failed: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChainError {
    /// A resolver said so.
    NoSuchName { by: String },
    /// A resolver that filters (`filters`) answered with the unspecified address: blocked by it, on purpose — not
    /// asked of another (that would undo the filter the user chose).
    Blocked { by: String },
    /// Every resolver failed, and the system's DNS was not allowed (or failed too).
    AllFailed { failed: Vec<(String, String)>, system_allowed: bool },
}

/// `name` resolved by the chain: the cache, then each resolver of `order` in turn — `ask(id)` gives (addresses, TTL)
/// or a fault, and `elapsed()` the milliseconds since the start (the chain stops past CHAIN_DEADLINE_MS) —; addresses
/// `address_ok` refuses are dropped, and an answer left with none counts as that resolver's failure. Every resolver
/// failed: a stale answer of theirs if one is kept; else the system's DNS (`system()`) only when `allow_system`.
/// Nothing falls back without the result saying so (Via).
pub fn resolve(
    name: &str,
    order: &[String],
    cache: &mut Cache,
    now: u64,
    allow_system: bool,
    ask: &mut dyn FnMut(&str) -> Result<(Vec<IpAddr>, u64), Fault>,
    elapsed: &mut dyn FnMut() -> u64,
    system: &mut dyn FnMut() -> Result<Vec<IpAddr>, String>,
) -> Result<Resolved, ChainError> {
    if is_local_name(name) {
        return match system() {
            Ok(ips) => Ok(Resolved { ips, via: Via::Local, failed: Vec::new() }),
            Err(e) => Err(ChainError::AllFailed { failed: vec![("local".to_string(), e)], system_allowed: true }),
        };
    }
    if let Some((ips, by)) = cache.get(name, now) {
        if ips.is_empty() {
            return Err(match by.strip_prefix("blocked:") {
                Some(b) => ChainError::Blocked { by: b.to_string() },
                None => ChainError::NoSuchName { by },
            });
        }
        return Ok(Resolved { ips, via: Via::Cache { id: by }, failed: Vec::new() });
    }
    let mut failed: Vec<(String, String)> = Vec::new();
    for id in order {
        if elapsed() > CHAIN_DEADLINE_MS {
            failed.push((id.clone(), "deadline".to_string()));
            break;
        }
        let t0 = elapsed();
        match ask(id) {
            Ok((ips, ttl)) => {
                let custom = id == "custom";
                if !ips.is_empty() && filters(id) && ips.iter().all(|ip| ip.is_unspecified()) {
                    cache.put(name, Vec::new(), 0, &format!("blocked:{}", id), now);
                    return Err(ChainError::Blocked { by: id.clone() });
                }
                let kept: Vec<IpAddr> = ips.iter().copied().filter(|ip| address_ok(ip, custom)).collect();
                if kept.is_empty() && !ips.is_empty() {
                    failed.push((id.clone(), "private".to_string()));
                    continue;
                }
                if kept.is_empty() {
                    cache.put(name, Vec::new(), 0, id, now);
                    return Err(ChainError::NoSuchName { by: id.clone() });
                }
                cache.put(name, kept.clone(), ttl, id, now);
                return Ok(Resolved { ips: kept, via: Via::Doh { id: id.clone(), ms: elapsed().saturating_sub(t0) }, failed });
            }
            Err(Fault::NoSuchName) => {
                cache.put(name, Vec::new(), 0, id, now);
                return Err(ChainError::NoSuchName { by: id.clone() });
            }
            Err(Fault::Failed(why)) => failed.push((id.clone(), why)),
        }
    }
    if let Some((ips, by)) = cache.stale(name, now) {
        return Ok(Resolved { ips, via: Via::Stale { id: by }, failed });
    }
    if allow_system {
        if let Ok(ips) = system() {
            if !ips.is_empty() {
                return Ok(Resolved { ips, via: Via::System, failed });
            }
        }
    }
    Err(ChainError::AllFailed { failed, system_allowed: allow_system })
}

/* ---------- torrents ---------- */

/// A UDP tracker's address with `ip` (the chain's answer for its host) in place of the name — the UDP tracker
/// protocol carries no name, so nothing is lost. None: left as it is (an HTTP(S) tracker — its name is needed for
/// the Host header and the certificate —, a tracker already given by address, or a local name).
pub fn tracker_rewrite(url: &str, ip: &IpAddr) -> Option<String> {
    let rest = match url.get(..6) {
        Some(p) if p.eq_ignore_ascii_case("udp://") => &url[6..],
        _ => return None,
    };
    let auth_end = rest.find(['/', '?']).unwrap_or(rest.len());
    let (auth, tail) = rest.split_at(auth_end);
    if auth.starts_with('[') {
        return None;
    }
    let (host, port) = match auth.rsplit_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (auth, None),
    };
    if host.is_empty() || host.parse::<IpAddr>().is_ok() || is_local_name(host) {
        return None;
    }
    let addr = match ip {
        IpAddr::V4(a) => a.to_string(),
        IpAddr::V6(a) => format!("[{}]", a),
    };
    Some(format!("udp://{}{}{}", addr, port.map(|p| format!(":{}", p)).unwrap_or_default(), tail))
}

/// The host of a UDP tracker that `tracker_rewrite` would replace (None for the others).
pub fn tracker_host(url: &str) -> Option<String> {
    let probe: IpAddr = "192.0.2.1".parse().ok()?;
    tracker_rewrite(url, &probe)?;
    host_of(&format!("x://{}", url.get(6..)?))
}


fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn pct_encode(s: &str) -> String {
    let mut out = String::new();
    for c in s.bytes() {
        if c.is_ascii_alphanumeric() || b"-._~".contains(&c) {
            out.push(c as char);
        } else {
            out.push_str(&format!("%{:02X}", c));
        }
    }
    out
}

/// A magnet's UDP trackers (tr=) given by address: each host asked of `resolve` (the chain); when it answers, the
/// tracker rewritten (`tracker_rewrite`); when it cannot, the tracker left out — never a name for the engine to look
/// up by the network's DNS. Everything else of the magnet left exactly as it was.
pub fn magnet_rewrite(magnet: &str, resolve: &mut dyn FnMut(&str) -> Option<IpAddr>) -> String {
    let Some((head, query)) = magnet.split_once('?') else { return magnet.to_string() };
    let parts: Vec<String> = query
        .split('&')
        .filter_map(|p| {
            let Some((k, v)) = p.split_once('=') else { return Some(p.to_string()) };
            if !k.eq_ignore_ascii_case("tr") {
                return Some(p.to_string());
            }
            let url = pct_decode(v);
            let Some(host) = tracker_host(&url) else { return Some(p.to_string()) };
            resolve(&host).and_then(|ip| tracker_rewrite(&url, &ip)).map(|n| format!("{}={}", k, pct_encode(&n)))
        })
        .collect();
    format!("{}?{}", head, parts.join("&"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CASES: &str = include_str!("doh-cases.txt");

    fn ids_has(c: &[Provider], id: &str) -> bool {
        c.iter().any(|p| p.id == id)
    }

    /// The Tauri self-test's case («DNS over HTTPS: a made-up name found through the chosen resolver»): a resolver on
    /// this device (http://127.0.0.1:<port>/dns-query) is asked alone, and its loopback answer for a made-up name is
    /// used — not refused as a public resolver's would be; the probe asks it alone too.
    #[test]
    fn on_device_resolver_like_the_self_test() {
        let choice = parse_choice("http://127.0.0.1:41234/dns-query");
        let ord = order(&choice, &HashMap::new(), 1000);
        assert_eq!(ord, vec!["custom".to_string()]);
        assert_eq!(probe_ids(&choice, true), vec!["custom".to_string()]);
        let mut cache = Cache::new();
        let lo: IpAddr = "127.0.0.1".parse().unwrap();
        let r = resolve("kr-doh-selftest.test", &ord, &mut cache, 1000, false, &mut |id| { assert_eq!(id, "custom"); Ok((vec![lo], 60)) }, &mut || 0, &mut || panic!("system")).unwrap();
        assert_eq!(r.ips, vec![lo]);
        assert!(matches!(r.via, Via::Doh { ref id, .. } if id == "custom"));
        // (A public resolver's loopback answer for a public name is still refused.)
        let mut c2 = Cache::new();
        assert!(resolve("x.test", &ord_of(&["google"]), &mut c2, 1000, false, &mut |_| Ok((vec![lo], 60)), &mut || 0, &mut || panic!("system")).is_err());
    }

    fn ord_of(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn probe_cases() {
        let cs = cases("probe");
        assert!(cs.len() >= 5);
        for c in cs {
            assert_eq!(probe_ids(&parse_choice(&c[0]), c[1] == "all").join(","), c[2], "probe {} {}", c[0], c[1]);
        }
    }

    #[test]
    fn filtered_block_is_an_answer() {
        let mut cache = Cache::new();
        let mut asked = Vec::new();
        // (Quad9 blocks malware: its 0.0.0.0 stands — the next resolver is not asked, Quad9 not marked failing.)
        let e = resolve("bad.test", &ord(&["quad9", "google"]), &mut cache, 1000, true, &mut |id| { asked.push(id.to_string()); Ok((vec!["0.0.0.0".parse().unwrap()], 60)) }, &mut || 0, &mut || panic!("system")).unwrap_err();
        assert_eq!(e, ChainError::Blocked { by: "quad9".into() });
        assert_eq!(asked, vec!["quad9".to_string()]);
        assert!(matches!(resolve("bad.test", &ord(&["google"]), &mut cache, 1005, true, &mut |_| panic!("asked"), &mut || 0, &mut || panic!("system")), Err(ChainError::Blocked { .. })));
        // (An unfiltered one's private answer for a public name: the next one asked, the reason «private».)
        let ip: IpAddr = "203.0.113.5".parse().unwrap();
        let mut c2 = Cache::new();
        let r = resolve("lan.test", &ord(&["google", "cloudflare"]), &mut c2, 1000, false, &mut |id| if id == "google" { Ok((vec!["192.168.1.4".parse().unwrap()], 60)) } else { Ok((vec![ip], 60)) }, &mut || 0, &mut || panic!("system")).unwrap();
        assert_eq!(r.failed, vec![("google".to_string(), "private".to_string())]);
    }

    fn cases(kind: &str) -> Vec<Vec<String>> {
        CASES.lines().filter(|l| l.starts_with(&format!("{}|", kind))).map(|l| l.split('|').skip(1).map(|s| s.to_string()).collect()).collect()
    }

    #[test]
    fn table() {
        let c = catalog();
        assert_eq!(c.len(), 9);
        assert!(!ids_has(c, "opendns"));
        // (IPv6 bootstrap for every provider that documents it.)
        assert!(c.iter().filter(|p| p.id != "dnssb").all(|p| p.ips.iter().any(|ip| ip.is_ipv6())));
        let ids: Vec<&str> = c.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids[0], "cloudflare");
        assert!(!ids.contains(&"mullvad"));
        for p in c {
            assert!(p.url.starts_with("https://") && !p.ips.is_empty(), "{:?}", p);
            assert!(validate_custom(&p.url).is_ok(), "{}", p.url);
            for ip in &p.ips {
                assert!(address_ok(ip, false), "{} {}", p.id, ip);
            }
        }
        assert_eq!(find("controld").unwrap().host(), "freedns.controld.com");
        assert!(find("google").unwrap().json && !find("quad9").unwrap().json);
    }

    #[test]
    fn choices() {
        assert_eq!(parse_choice("off"), Choice::Off);
        assert_eq!(parse_choice(""), Choice::Off);
        assert_eq!(parse_choice("auto"), Choice::Auto);
        assert_eq!(parse_choice("mullvad"), Choice::Auto);
        assert_eq!(parse_choice(" quad9 "), Choice::Pinned("quad9".into()));
        assert_eq!(parse_choice("https://doh.example/q"), Choice::Custom("https://doh.example/q".into()));
        assert_eq!(parse_choice("http://doh.example/q"), Choice::Off);
        assert_eq!(parse_choice("nonesuch"), Choice::Off);
    }

    fn health_of(spec: &str, now: u64) -> HashMap<String, Health> {
        let mut h = HashMap::new();
        for part in spec.split(',').filter(|s| !s.is_empty()) {
            let (id, st) = part.split_once('=').unwrap();
            match st {
                "fail" => note(&mut h, id, false, 0, "x", now),
                "fail-old" => note(&mut h, id, false, 0, "x", now - FAIL_FORGET_S - 60),
                s => note(&mut h, id, true, s.trim_start_matches("ok:").parse().unwrap(), "", now),
            }
        }
        h
    }

    #[test]
    fn order_cases() {
        let now = 1_000_000;
        let cs = cases("order");
        assert!(cs.len() >= 9);
        for c in cs {
            let got = order(&parse_choice(&c[0]), &health_of(&c[1], now), now).join(",");
            assert_eq!(got, c[2], "order {} {}", c[0], c[1]);
        }
    }

    #[test]
    fn custom_cases() {
        let cs = cases("custom");
        assert!(cs.len() >= 15);
        for c in cs {
            let got = match validate_custom(&c[0]) {
                Ok(_) => "ok".to_string(),
                Err(e) => e.to_string(),
            };
            assert_eq!(got, c[1], "custom {}", c[0]);
        }
        assert_eq!(validate_custom(&format!("https://doh.example/{}", "a".repeat(600))), Err("tooLong"));
    }

    #[test]
    fn tracker_cases() {
        for c in cases("tracker") {
            let ip: IpAddr = c[1].parse().unwrap();
            let got = tracker_rewrite(&c[0], &ip).unwrap_or_else(|| "-".to_string());
            assert_eq!(got, c[2], "tracker {}", c[0]);
        }
        assert_eq!(tracker_host("udp://Tracker.Test:6969/announce").as_deref(), Some("tracker.test"));
        assert_eq!(tracker_host("http://tracker.test/announce"), None);
    }

    #[test]
    fn magnet_cases() {
        let cs = cases("magnet");
        assert!(cs.len() >= 3);
        for c in cs {
            let map: Vec<(String, IpAddr)> = c[1].split(',').filter(|s| !s.is_empty()).map(|kv| { let (k, v) = kv.split_once('=').unwrap(); (k.to_string(), v.parse().unwrap()) }).collect();
            let mut asked: Vec<String> = Vec::new();
            let got = magnet_rewrite(&c[0], &mut |h| { asked.push(h.to_string()); map.iter().find(|(k, _)| k == h).map(|(_, v)| *v) });
            assert_eq!(got, c[2], "magnet {}", c[0]);
            assert!(asked.iter().all(|h| !h.contains('/')));
        }
    }

    #[test]
    fn addr_and_local_cases() {
        for c in cases("addr") {
            let ip: IpAddr = c[0].parse().unwrap();
            assert_eq!(if address_ok(&ip, c[1] == "custom") { "kept" } else { "dropped" }, c[2], "addr {} {}", c[0], c[1]);
        }
        for c in cases("local") {
            assert_eq!(if is_local_name(&c[0]) { "yes" } else { "no" }, c[1], "local {}", c[0]);
        }
    }

    #[test]
    fn probe_timing() {
        assert!(!probe_due(false, None, true, 100));
        assert!(probe_due(true, None, false, 100));
        assert!(!probe_due(true, Some(100), false, 100 + PROBE_EVERY_S - 1));
        assert!(probe_due(true, Some(100), false, 100 + PROBE_EVERY_S));
        assert!(!probe_due(true, Some(100), true, 130));
        assert!(probe_due(true, Some(100), true, 161));
    }

    #[test]
    fn cache_ttl_and_caps() {
        let ip: IpAddr = "203.0.113.5".parse().unwrap();
        let mut c = Cache::new();
        c.put("A.test", vec![ip], 5, "google", 1000);
        assert_eq!(c.get("a.test", 1000 + TTL_MIN_S - 1), Some((vec![ip], "google".into())));
        assert_eq!(c.get("a.test", 1000 + TTL_MIN_S), None);
        assert!(c.stale("a.test", 1000 + 5000).is_some() && c.stale("a.test", 1000 + 90000).is_none());
        c.put("b.test", vec![ip], 999_999, "google", 1000);
        assert!(c.get("b.test", 1000 + TTL_MAX_S - 1).is_some() && c.get("b.test", 1000 + TTL_MAX_S).is_none());
        c.put("c.test", vec![], 999, "quad9", 1000);
        assert_eq!(c.get("c.test", 1000 + NEG_TTL_S - 1), Some((vec![], "quad9".into())));
        assert_eq!(c.get("c.test", 1000 + NEG_TTL_S), None);
        assert!(c.stale("c.test", 1001).is_none());
        for i in 0..(CACHE_MAX + 50) {
            c.put(&format!("n{}.test", i), vec![ip], 60 + i as u64, "google", 1000);
        }
        assert_eq!(c.len(), CACHE_MAX);
        // (The newest stays; the soonest to expire went first.)
        assert!(c.get(&format!("n{}.test", CACHE_MAX + 49), 1001).is_some());
        assert!(c.get("n0.test", 1001).is_none());
        // (One entry taken out, asked about, put back.)
        let mut one = c.only("b.test");
        assert_eq!(one.len(), 1);
        one.put("d.test", vec![ip], 60, "quad9", 1001);
        c.merge(one, 1001);
        assert!(c.get("d.test", 1002).is_some() && c.len() == CACHE_MAX);
    }

    fn ord(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn chain_failover_and_no_silent_fallback() {
        let ip: IpAddr = "203.0.113.5".parse().unwrap();
        let mut cache = Cache::new();
        let mut asked: Vec<String> = Vec::new();
        let mut clock = 0u64;
        let mut system_called = false;
        let r = resolve(
            "site.test",
            &ord(&["cloudflare", "google", "quad9"]),
            &mut cache,
            1000,
            false,
            &mut |id| {
                asked.push(id.to_string());
                match id {
                    "cloudflare" => Err(Fault::Failed("timeout".into())),
                    "google" => Ok((vec!["0.0.0.0".parse().unwrap()], 60)),
                    _ => Ok((vec![ip], 120)),
                }
            },
            &mut || {
                clock += 10;
                clock
            },
            &mut || {
                system_called = true;
                Ok(vec![ip])
            },
        )
        .unwrap();
        assert_eq!(asked, ord(&["cloudflare", "google", "quad9"]));
        assert_eq!(r.ips, vec![ip]);
        assert!(matches!(r.via, Via::Doh { ref id, .. } if id == "quad9"));
        assert_eq!(r.failed, vec![("cloudflare".to_string(), "timeout".to_string()), ("google".to_string(), "private".to_string())]);
        assert!(!system_called);
        // (Answered from the cache next, by the one that gave it.)
        let again = resolve("SITE.test", &ord(&["cloudflare"]), &mut cache, 1050, false, &mut |_| panic!("asked"), &mut || 0, &mut || panic!("system")).unwrap();
        assert_eq!(again.via, Via::Cache { id: "quad9".into() });
        assert_eq!(again.via.code(), "cache:quad9");

        // Every resolver fails, system not allowed: an error that says so — never the system's answer.
        let mut c2 = Cache::new();
        let mut sys = 0;
        let e = resolve("down.test", &ord(&["cloudflare", "google"]), &mut c2, 1000, false, &mut |_| Err(Fault::Failed("refused".into())), &mut || 0, &mut || {
            sys += 1;
            Ok(vec![ip])
        })
        .unwrap_err();
        assert_eq!(sys, 0);
        assert_eq!(e, ChainError::AllFailed { failed: vec![("cloudflare".into(), "refused".into()), ("google".into(), "refused".into())], system_allowed: false });
        // …allowed: the system's answer, marked as such.
        let r2 = resolve("down.test", &ord(&["cloudflare"]), &mut c2, 1000, true, &mut |_| Err(Fault::Failed("refused".into())), &mut || 0, &mut || Ok(vec![ip])).unwrap();
        assert_eq!(r2.via, Via::System);
        assert_eq!(r2.via.code(), "system");
        // (A stale answer of the resolvers' comes before the system's.)
        let mut c3 = Cache::new();
        c3.put("old.test", vec![ip], 30, "google", 1000);
        let r3 = resolve("old.test", &ord(&["google"]), &mut c3, 5000, true, &mut |_| Err(Fault::Failed("x".into())), &mut || 0, &mut || panic!("system")).unwrap();
        assert_eq!(r3.via, Via::Stale { id: "google".into() });
    }

    #[test]
    fn chain_names_that_do_not_exist_and_deadline() {
        let mut cache = Cache::new();
        let mut asked = 0;
        let e = resolve("none.test", &ord(&["cloudflare", "google"]), &mut cache, 1000, true, &mut |_| {
            asked += 1;
            Err(Fault::NoSuchName)
        }, &mut || 0, &mut || panic!("system"))
        .unwrap_err();
        assert_eq!(e, ChainError::NoSuchName { by: "cloudflare".into() });
        assert_eq!(asked, 1);
        // (Kept briefly: the next question is not asked.)
        assert!(matches!(resolve("none.test", &ord(&["google"]), &mut cache, 1010, true, &mut |_| panic!("asked"), &mut || 0, &mut || panic!("system")), Err(ChainError::NoSuchName { .. })));
        // (An empty answer is «no address» too.)
        let mut c2 = Cache::new();
        assert!(matches!(resolve("empty.test", &ord(&["google"]), &mut c2, 1000, false, &mut |_| Ok((vec![], 300)), &mut || 0, &mut || panic!("system")), Err(ChainError::NoSuchName { .. })));
        // The deadline: no further resolver asked.
        let mut c3 = Cache::new();
        let mut t = 0u64;
        let mut n = 0;
        let e = resolve("slow.test", &ord(&["cloudflare", "google", "quad9"]), &mut c3, 1000, false, &mut |_| {
            n += 1;
            Err(Fault::Failed("timeout".into()))
        }, &mut || {
            t += CHAIN_DEADLINE_MS / 2 + 1;
            t
        }, &mut || panic!("system"))
        .unwrap_err();
        assert!(n < 3, "{}", n);
        assert!(matches!(e, ChainError::AllFailed { .. }));
        // Local names: the system's own lookup, by rule, never a resolver.
        let lo: IpAddr = "192.168.1.2".parse().unwrap();
        let r = resolve("nas.local", &ord(&["google"]), &mut c3, 1000, false, &mut |_| panic!("asked"), &mut || 0, &mut || Ok(vec![lo])).unwrap();
        assert_eq!(r.via, Via::Local);
        // A custom resolver may give private addresses; a public one may not.
        let mut c4 = Cache::new();
        let r = resolve("intra.test", &ord(&["custom"]), &mut c4, 1000, false, &mut |_| Ok((vec!["10.0.0.7".parse().unwrap()], 60)), &mut || 0, &mut || panic!("system")).unwrap();
        assert_eq!(r.ips, vec!["10.0.0.7".parse::<IpAddr>().unwrap()]);
    }
}
