// Web requests without the page's cross-site limits (Tools' kt:http, the Reader's kr:http) and the update check
// (Tools' kt:checkUpdate), with reqwest instead of Electron's net.fetch. (From Kurokawa Tools'
// src-tauri/src/net.rs, branch work-tauri: the user agent made the app's to set, and the update check split into
// the fetch and a pure choice of the release, which takes a tag prefix and the pre-release rule.)
//
// Since the Reader's stage R3, as Electron's session does for its requests:
//  - cookies: what a site sets is sent back to it (cookiejar.rs; across redirects too), the ones with an expiry kept
//    between runs in a file the app names (`configure_cookies`);
//  - DNS over HTTPS: with a resolver chosen (`set_doh`), every request of this client asks it for the sites' addresses
//    (doh.rs, sent as RFC 8484's POST) instead of the system — strictly, as Chromium's «secure» mode that Electron
//    sets: no falling back to the system's DNS. The resolver itself is reached through a plain client (the system's
//    DNS: its own name has to be found somehow, as Chromium does). Requests the web view makes itself (pictures in a
//    page, the in-app browser) are the web view's, not this client's: they keep the system's DNS;
//  - the system's proxy: reqwest's — the proxy environment variables everywhere, Windows' settings, a Mac's system
//    settings (the macos-system-configuration feature). Behind a proxy the proxy finds the sites, so DoH has no say.
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

use crate::{cookiejar, doh, util};

/// The repository both apps update from (desktop/package.json's kurokawa.repo / build.publish).
pub const REPO: &str = "YoRu72/KurokawaReader";

/// The client used while no DoH resolver is chosen (the system's DNS), the one used while one is, and the one that
/// asks the resolver itself.
static PLAIN: OnceLock<reqwest::Client> = OnceLock::new();
static VIA_DOH: OnceLock<reqwest::Client> = OnceLock::new();
/// The same two, with redirects left to the caller (the outside players' relay: client_no_redirect).
static PLAIN_NR: OnceLock<reqwest::Client> = OnceLock::new();
static VIA_DOH_NR: OnceLock<reqwest::Client> = OnceLock::new();
static BOOT: OnceLock<reqwest::Client> = OnceLock::new();
static USER_AGENT: OnceLock<String> = OnceLock::new();
/// The DoH resolver's address in force (None: the system's DNS).
static DOH_SERVER: RwLock<Option<String>> = RwLock::new(None);
static DOH_CACHE: Mutex<doh::Cache> = Mutex::new(doh::Cache::new());
static JAR: OnceLock<Arc<SharedJar>> = OnceLock::new();

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The User-Agent of every request that does not set its own — set once, at start, before the first request
/// (later calls change nothing).
pub fn configure(user_agent: String) {
    let _ = USER_AGENT.set(user_agent);
}

/* ---------- cookies ---------- */

/// The jar both clients share, and the file its lasting cookies are kept in.
pub struct SharedJar {
    jar: Mutex<cookiejar::Jar>,
    file: Mutex<Option<PathBuf>>,
}

impl SharedJar {
    fn save(&self, jar: &cookiejar::Jar) {
        let path = match self.file.lock() {
            Ok(f) => f.clone(),
            Err(_) => None,
        };
        if let Some(p) = path {
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&p, jar.to_lines(now_secs()));
        }
    }
}

impl reqwest::cookie::CookieStore for SharedJar {
    fn set_cookies(
        &self,
        cookie_headers: &mut dyn Iterator<Item = &reqwest::header::HeaderValue>,
        url: &reqwest::Url,
    ) {
        let host: String = match url.host_str() {
            Some(h) => h.to_ascii_lowercase(),
            None => return,
        };
        let secure = url.scheme() == "https";
        let now = now_secs();
        if let Ok(mut j) = self.jar.lock() {
            let mut changed = false;
            for h in cookie_headers {
                let line = String::from_utf8_lossy(h.as_bytes()).into_owned();
                if j.set(&line, &host, url.path(), secure, now) {
                    changed = true;
                }
            }
            if changed {
                self.save(&j);
            }
        }
    }

    fn cookies(&self, url: &reqwest::Url) -> Option<reqwest::header::HeaderValue> {
        let host: String = url.host_str()?.to_ascii_lowercase();
        let secure = url.scheme() == "https";
        let text: Option<String> = match self.jar.lock() {
            Ok(j) => j.header(&host, url.path(), secure, now_secs()),
            Err(_) => None,
        };
        match text {
            Some(t) => reqwest::header::HeaderValue::from_str(&t).ok(),
            None => None,
        }
    }
}

fn jar() -> Arc<SharedJar> {
    JAR.get_or_init(|| {
        Arc::new(SharedJar {
            jar: Mutex::new(cookiejar::Jar::new()),
            file: Mutex::new(None),
        })
    })
    .clone()
}

/// Where the cookies with an expiry are kept between runs (the app's data folder): read now, written on each change.
/// Call at start, before the first request.
pub fn configure_cookies(file: PathBuf) {
    let j = jar();
    if let Ok(text) = std::fs::read_to_string(&file) {
        if let Ok(mut inner) = j.jar.lock() {
            inner.load_lines(&text, now_secs());
        }
    }
    if let Ok(mut f) = j.file.lock() {
        *f = Some(file);
    };
}

/// The cookies of a site (`host`), or of every site with `all`, forgotten → how many (for the in-app browser's
/// «forget», stage R4).
pub fn forget_cookies(host: &str, all: bool) -> usize {
    let j = jar();
    let n = match j.jar.lock() {
        Ok(mut inner) => {
            let n = inner.forget(host, all);
            j.save(&inner);
            n
        }
        Err(_) => 0,
    };
    n
}

/// A cookie the in-app browser holds (stage R4), put in the app's own jar as if `host` had set it with this
/// Set-Cookie line over https (`secure`) or not, so the app's requests carry it as Electron's one session does →
/// whether it was taken.
pub fn put_cookie(line: &str, host: &str, secure: bool) -> bool {
    let name: String = line.split(';').next().unwrap_or("").split('=').next().unwrap_or("").trim().to_string();
    let j = jar();
    let taken = match j.jar.lock() {
        Ok(mut inner) => {
            if inner.set(line, &host.to_ascii_lowercase(), "/", secure, now_secs()) {
                j.save(&inner);
            }
            !name.is_empty() && inner.cookies().iter().any(|c| c.name == name)
        }
        Err(_) => false,
    };
    taken
}

/// Cookies of the app's jar taken away (the in-app browser's «forget», stage R4): of the site `host` (None: every
/// site) whose name `pick` accepts → each one's (domain, name).
pub fn forget_picked_cookies(host: Option<&str>, pick: &dyn Fn(&str) -> bool) -> Vec<(String, String)> {
    let j = jar();
    let gone = match j.jar.lock() {
        Ok(mut inner) => {
            let gone = inner.forget_picked(host, pick);
            if !gone.is_empty() {
                j.save(&inner);
            }
            gone
        }
        Err(_) => Vec::new(),
    };
    gone
}

/* ---------- DNS over HTTPS ---------- */

/// The resolver chosen: a provider's name, an https:// address (or an http:// one on this computer), or anything
/// else ('off') for the system's DNS — doh::server_for's rules. Answers kept from the last one are dropped.
pub fn set_doh(provider: &str) {
    let server = doh::server_for(provider);
    if let Ok(mut s) = DOH_SERVER.write() {
        *s = server;
    }
    clear_doh_cache();
}

/// The resolver's address in force (None: the system's DNS).
pub fn doh_server() -> Option<String> {
    match DOH_SERVER.read() {
        Ok(s) => s.clone(),
        Err(_) => None,
    }
}

pub fn clear_doh_cache() {
    if let Ok(mut c) = DOH_CACHE.lock() {
        c.clear();
    }
}

/// The client that asks the resolver: the system's DNS, no cookies.
fn boot_client() -> Result<&'static reqwest::Client, String> {
    if let Some(c) = BOOT.get() {
        return Ok(c);
    }
    let built = reqwest::Client::builder()
        .user_agent(user_agent().as_str())
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(BOOT.get_or_init(|| built))
}

/// One question to the resolver: `host`'s records of `qtype`.
async fn doh_query(server: &str, host: &str, qtype: u16) -> Result<doh::Answer, String> {
    let q = doh::encode_query(host, qtype)?;
    let resp = boot_client()?
        .post(server)
        .header("content-type", "application/dns-message")
        .header("accept", "application/dns-message")
        .body(q)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("DNS-over-HTTPS resolver not reached: {}", e))?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("DNS-over-HTTPS resolver answered HTTP {}", status));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    doh::decode_answer(&bytes, qtype)
}

/// The system's own lookup (getaddrinfo, as reqwest's default), off the async threads.
async fn system_lookup(host: String) -> Result<Vec<IpAddr>, String> {
    let joined = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<IpAddr>, String> {
        use std::net::ToSocketAddrs;
        let addrs = (host.as_str(), 0u16).to_socket_addrs().map_err(|e| e.to_string())?;
        Ok(addrs.map(|a| a.ip()).collect())
    })
    .await;
    match joined {
        Ok(r) => r,
        Err(e) => Err(e.to_string()),
    }
}

/* ---------- an app's own resolver chain (Tools 0.21 P9) ----------
 * An app that keeps its own chain of resolvers (Tools: kt-core's dohchain — the order, health, cache and the
 * system-DNS rule) installs it as a hook: every name this client connects to is then the hook's to find. The
 * hook asks each resolver with `doh_ask`, which reaches the resolver by the addresses it is given (its bootstrap),
 * never by the network's DNS. Without a hook, `set_doh`'s one resolver as before (the Reader). */

pub type DohHook = Arc<dyn Fn(String) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<IpAddr>, String>> + Send>> + Send + Sync>;
static DOH_HOOK: RwLock<Option<DohHook>> = RwLock::new(None);
/// The clients that ask one resolver each, pinned to its bootstrap addresses (by its address).
static PINNED: Mutex<Vec<(String, reqwest::Client)>> = Mutex::new(Vec::new());
static ASK_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// The hook in force (None: `set_doh`'s resolver, or the system's DNS).
pub fn set_doh_hook(hook: Option<DohHook>) {
    if let Ok(mut h) = DOH_HOOK.write() {
        *h = hook;
    }
    clear_doh_cache();
}

fn doh_hook() -> Option<DohHook> {
    DOH_HOOK.read().ok().and_then(|h| h.clone())
}

fn pinned_client(url: &str, ips: &[IpAddr]) -> Result<reqwest::Client, String> {
    let mut list = PINNED.lock().map_err(|e| e.to_string())?;
    if let Some((_, c)) = list.iter().find(|(u, _)| u == url) {
        return Ok(c.clone());
    }
    let parsed = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    let host = parsed.host_str().unwrap_or("").to_string();
    let port = parsed.port_or_known_default().unwrap_or(443);
    let mut b = reqwest::Client::builder()
        .user_agent(user_agent().as_str())
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none());
    if !ips.is_empty() && host.parse::<IpAddr>().is_err() {
        let addrs: Vec<SocketAddr> = ips.iter().map(|ip| SocketAddr::new(*ip, port)).collect();
        b = b.resolve_to_addrs(&host, &addrs);
    }
    let c = b.build().map_err(|e| e.to_string())?;
    if list.len() > 32 {
        list.remove(0);
    }
    list.push((url.to_string(), c.clone()));
    Ok(c)
}

/// One question to one resolver of a chain: `host`'s records of `qtype`, POSTed (RFC 8484) with an id of its own and
/// read by `doh::decode_strict` — to the resolver's `ips` when given (its name kept for TLS and its certificate), so
/// the network's DNS is never asked for it. → (addresses, TTL) or why not.
pub async fn doh_ask(url: &str, ips: &[IpAddr], host: &str, qtype: u16, timeout_ms: u64) -> Result<(Vec<IpAddr>, u32), doh::Refused> {
    let bad = |e: String| doh::Refused::Bad(e);
    let seed = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let id = (seed ^ ASK_SEQ.fetch_add(0x9E37, std::sync::atomic::Ordering::Relaxed).rotate_left(7)) as u16;
    let q = doh::encode_query_id(host, qtype, id).map_err(bad)?;
    let c = pinned_client(url, ips).map_err(bad)?;
    let resp = c
        .post(url)
        .header("content-type", "application/dns-message")
        .header("accept", "application/dns-message")
        .body(q)
        .timeout(Duration::from_millis(timeout_ms))
        .send()
        .await
        .map_err(|e| bad(if e.is_timeout() { "timeout".to_string() } else { format!("not reached: {}", e) }))?;
    let status = resp.status().as_u16();
    if status != 200 {
        return Err(bad(format!("HTTP {}", status)));
    }
    let bytes = resp.bytes().await.map_err(|e| bad(e.to_string()))?;
    let a = doh::decode_strict(&bytes, host, qtype, id)?;
    Ok((a.ips, a.ttl))
}

/// `host`'s addresses from the resolver in force: IPv4 first, then IPv6 (both asked at once), kept for their time to
/// live. An address or localhost is answered here; with no resolver chosen (it was turned off while a request was
/// under way), the system's. With an app's hook installed, the hook's answer.
pub async fn doh_lookup(host: &str) -> Result<Vec<IpAddr>, String> {
    if let Some(ips) = doh::local_answer(host) {
        return Ok(ips);
    }
    if let Some(hook) = doh_hook() {
        return hook(host.to_string()).await;
    }
    let server = match doh_server() {
        Some(s) => s,
        None => return system_lookup(host.to_string()).await,
    };
    let now = now_secs();
    let cached: Option<Vec<IpAddr>> = match DOH_CACHE.lock() {
        Ok(c) => c.get(&server, host, now),
        Err(_) => None,
    };
    if let Some(ips) = cached {
        return Ok(ips);
    }
    let (s6, h6) = (server.clone(), host.to_string());
    let six = tauri::async_runtime::spawn(async move { doh_query(&s6, &h6, doh::TYPE_AAAA).await });
    let four = doh_query(&server, host, doh::TYPE_A).await;
    let six: Result<doh::Answer, String> = match six.await {
        Ok(r) => r,
        Err(e) => Err(e.to_string()),
    };
    let mut ips: Vec<IpAddr> = Vec::new();
    let mut ttl: u32 = u32::MAX;
    let mut first_err: Option<String> = None;
    for r in [four, six] {
        match r {
            Ok(a) => {
                if !a.ips.is_empty() {
                    ttl = ttl.min(a.ttl);
                }
                ips.extend(a.ips);
            }
            Err(e) => {
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
        }
    }
    if ips.is_empty() {
        return Err(first_err.unwrap_or_else(|| format!("no address for {} (DNS over HTTPS)", host)));
    }
    if let Ok(mut c) = DOH_CACHE.lock() {
        c.put(&server, host, ips.clone(), ttl, now);
    }
    Ok(ips)
}

/// reqwest's resolver hook: each name the DoH client connects to, found by doh_lookup. (The port of the addresses
/// given is replaced by the request's.)
struct DohResolver;

impl reqwest::dns::Resolve for DohResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host: String = name.as_str().to_string();
        let fut = async move {
            let r: Result<reqwest::dns::Addrs, Box<dyn std::error::Error + Send + Sync>> =
                match doh_lookup(&host).await {
                    Ok(ips) => {
                        let addrs: Vec<SocketAddr> =
                            ips.into_iter().map(|ip| SocketAddr::new(ip, 0)).collect();
                        let it: reqwest::dns::Addrs = Box::new(addrs.into_iter());
                        Ok(it)
                    }
                    Err(e) => Err(Box::<dyn std::error::Error + Send + Sync>::from(e)),
                };
            r
        };
        Box::pin(fut)
    }
}

/* ---------- the clients ---------- */

fn user_agent() -> String {
    match USER_AGENT.get() {
        Some(u) => u.clone(),
        None => "Mozilla/5.0 (compatible) Kurokawa (Tauri)".to_string(),
    }
}

fn builder(follow_redirects: bool) -> reqwest::ClientBuilder {
    let policy = if follow_redirects { reqwest::redirect::Policy::limited(20) } else { reqwest::redirect::Policy::none() };
    reqwest::Client::builder()
        .user_agent(user_agent().as_str())
        .redirect(policy)
        .connect_timeout(Duration::from_secs(30))
        .cookie_provider(jar())
}

/// The client of a slot (doh::client_slot), built once: with the DoH resolver for the two DoH slots, else the
/// system's DNS — the same cookie jar for all four.
fn slot_client(slot: doh::ClientSlot) -> Result<&'static reqwest::Client, String> {
    let (cell, follow) = match slot {
        doh::ClientSlot::Plain => (&PLAIN, true),
        doh::ClientSlot::ViaDoh => (&VIA_DOH, true),
        doh::ClientSlot::PlainNoRedirect => (&PLAIN_NR, false),
        doh::ClientSlot::ViaDohNoRedirect => (&VIA_DOH_NR, false),
    };
    if let Some(c) = cell.get() {
        return Ok(c);
    }
    let b = builder(follow);
    let b = if doh::slot_uses_doh(slot) { b.dns_resolver(Arc::new(DohResolver)) } else { b };
    let built = b.build().map_err(|e| e.to_string())?;
    Ok(cell.get_or_init(|| built))
}

/// The client every request of the app goes through: with the DoH resolver while one is chosen, else the system's
/// DNS — the same cookies either way.
pub fn client() -> Result<&'static reqwest::Client, String> {
    slot_client(doh::client_slot(doh_active(), true))
}

/// Whether requests go through DNS over HTTPS: a chain installed as a hook (Tools), or `set_doh`'s one resolver.
fn doh_active() -> bool {
    doh_server().is_some() || doh_hook().is_some()
}

/// client()'s twin that does not follow redirects (the outside players' relay follows them hop by hop, to send the
/// source's headers to its own origin only): the same DoH choice (hook or resolver), the same cookie jar.
pub fn client_no_redirect() -> Result<&'static reqwest::Client, String> {
    slot_client(doh::client_slot(doh_active(), false))
}

/// main.cjs's kr:set-doh test: the site `host` reached (HEAD https://host/, 12 s at most) with the resolver in force,
/// its answers forgotten first → { ok: true, status, ms } or { ok: false, error }.
pub async fn doh_try(host: &str) -> Value {
    clear_doh_cache();
    let started = std::time::Instant::now();
    let url = format!("https://{}/", host);
    let sent = match client() {
        Ok(c) => c.head(url.as_str()).timeout(Duration::from_secs(12)).send().await.map_err(|e| e.to_string()),
        Err(e) => Err(e),
    };
    match sent {
        Ok(r) => json!({ "ok": true, "status": r.status().as_u16(), "ms": started.elapsed().as_millis() as u64 }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// A JSON value as JS's String() would write it (a string as it is).
fn as_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|x| x != 0.0).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// kt:http: { url, method?, headers?, body?, bodyBase64?, binary? } → { status, url, headers, body } — redirects
/// followed, header names lowercased (several of one name joined with «, », as fetch's Headers does), the body as
/// text, or base64 when `binary`.
pub async fn http(o: &Value) -> Result<Value, String> {
    let url = o.get("url").map(as_text).unwrap_or_default();
    let method_text = match o.get("method") {
        Some(m) if truthy(Some(m)) => as_text(m).to_uppercase(),
        _ => "GET".to_string(),
    };
    let method = reqwest::Method::from_bytes(method_text.as_bytes()).map_err(|e| e.to_string())?;
    let mut rb = client()?.request(method, url.as_str());
    // (A budget when the page gives one — the post readers' few seconds —; the client's own limits otherwise.)
    if let Some(ms) = o.get("timeoutMs").and_then(|v| v.as_f64()).filter(|m| *m > 0.0) {
        rb = rb.timeout(Duration::from_millis(ms.min(600_000.0) as u64));
    }
    if let Some(Value::Object(h)) = o.get("headers") {
        for (k, v) in h.iter() {
            let val = as_text(v);
            rb = rb.header(k.as_str(), val.as_str());
        }
    }
    if let Some(b) = o.get("body") {
        if truthy(Some(b)) {
            let text = as_text(b);
            if truthy(o.get("bodyBase64")) {
                rb = rb.body(util::b64_decode(&text));
            } else {
                rb = rb.body(text);
            }
        }
    }
    let resp = rb.send().await.map_err(|e| e.to_string())?;
    let status: u16 = resp.status().as_u16();
    let final_url: String = resp.url().to_string();
    let mut headers: Map<String, Value> = Map::new();
    for (k, v) in resp.headers().iter() {
        let key = k.as_str().to_ascii_lowercase();
        let val = String::from_utf8_lossy(v.as_bytes()).into_owned();
        let joined = match headers.get(&key) {
            Some(Value::String(prev)) => format!("{}, {}", prev, val),
            _ => val,
        };
        headers.insert(key, Value::String(joined));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let body = if truthy(o.get("binary")) {
        util::b64_encode(&bytes)
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    Ok(
        json!({ "status": status, "url": final_url, "headers": Value::Object(headers), "body": body }),
    )
}

/// Tools' kt:checkUpdate: the newest tools-v* release that is not a draft (Tools' releases are all pre-releases),
/// if newer than `current` → { version, url, notes, asset? }; null otherwise.
pub async fn check_update(current: &str) -> Result<Value, String> {
    let url = format!("https://api.github.com/repos/{}/releases?per_page=30", REPO);
    check_update_at(&url, "tools-v", current, true).await
}

/// The releases list at `url` (GitHub's API, or a test server's copy) fetched, and the update chosen from it by
/// pick_release for this OS.
pub async fn check_update_at(
    url: &str,
    prefix: &str,
    current: &str,
    prereleases: bool,
) -> Result<Value, String> {
    let resp = client()?
        .get(url)
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let all: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(pick_release(&all, prefix, current, prereleases, util::node_platform()))
}

/// Of a GitHub releases list, the newest release tagged `prefix`<version> that is not a draft (nor a pre-release,
/// unless `prereleases`), if newer than `current` → { version, url, notes, asset? } with the asset for `os` (Node's
/// name); null otherwise.
pub fn pick_release(all: &Value, prefix: &str, current: &str, prereleases: bool, os: &str) -> Value {
    let list: &[Value] = match all.as_array() {
        Some(a) => a.as_slice(),
        None => &[],
    };
    let mut best: Option<&Value> = None;
    let mut best_v = String::new();
    for r in list.iter() {
        let draft = r.get("draft").and_then(|d| d.as_bool()).unwrap_or(false);
        let pre = r.get("prerelease").and_then(|d| d.as_bool()).unwrap_or(false);
        let tag = r.get("tag_name").and_then(|t| t.as_str()).unwrap_or("");
        if draft || (pre && !prereleases) || !tag.starts_with(prefix) {
            continue;
        }
        let v = tag[prefix.len()..].to_string();
        if best.is_none() || util::cmp_versions(&v, &best_v) > 0 {
            best = Some(r);
            best_v = v;
        }
    }
    let j = match best {
        Some(j) => j,
        None => return Value::Null,
    };
    if util::cmp_versions(&best_v, current) <= 0 {
        return Value::Null;
    }
    let mut names: Vec<(String, String)> = Vec::new();
    if let Some(Value::Array(assets)) = j.get("assets") {
        for a in assets.iter() {
            let name = a
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let dl = a
                .get("browser_download_url")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            names.push((name, dl));
        }
    }
    let html_url = j
        .get("html_url")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let notes = j
        .get("body")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let mut out = json!({ "version": best_v, "url": html_url, "notes": notes });
    if let Some(a) = util::pick_asset(&names, os) {
        out["asset"] = Value::String(a.to_string());
    }
    out
}
