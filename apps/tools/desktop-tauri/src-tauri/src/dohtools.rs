// DNS over HTTPS for Tools' Tauri build (0.21 P9): kt-core's dohchain rules put to work — the resolvers asked in
// their order (each by its bootstrap addresses: the shared crate's net::doh_ask), the next one on a failure, the
// system's DNS only when the user allowed it; the health probe on demand and at most every half hour, only when a
// name is asked (no timer); which resolver answered each name (the details pages' status line); the small proxy
// aria2 is pointed at (kt-core dohproxy) so the downloads and the HTTP trackers use the chain too; a magnet's UDP
// trackers given by address. Electron's twin is desktop/dohchain.cjs, the phone's KrDoh.java.
// (External crates — compiled by CI only.)
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use kt_core::dohchain::{self as dc, Choice};
use kt_core::dohproxy;
use kurokawa_shell::{doh, net};
use serde_json::{json, Value};

struct State {
    choice: Choice,
    allow_system: bool,
    health: HashMap<String, dc::Health>,
    cache: dc::Cache,
    last_probe: Option<u64>,
    probing: bool,
    chain_failed: bool,
    /// host → (Via code, when): what answered each name.
    used: HashMap<String, (String, u64)>,
    proxy: Option<dohproxy::Proxy>,
    queries: u64,
    fails: u64,
    system: u64,
}

fn st() -> MutexGuard<'static, State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    let m = S.get_or_init(|| {
        Mutex::new(State { choice: Choice::Off, allow_system: false, health: HashMap::new(), cache: dc::Cache::new(), last_probe: None, probing: false, chain_failed: false, used: HashMap::new(), proxy: None, queries: 0, fails: 0, system: 0 })
    });
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// (address, bootstrap addresses) of a resolver of the chain.
fn server(id: &str, choice: &Choice) -> Option<(String, Vec<IpAddr>)> {
    if id == "custom" {
        return match choice {
            Choice::Custom(u) => Some((u.clone(), custom_boot(u))),
            _ => None,
        };
    }
    dc::find(id).map(|p| (p.url.clone(), p.ips.clone()))
}

/// The user's resolver's own addresses: its address when it is one, nothing for one on this device (asked as it
/// is), else its name asked of the public resolvers — never the network's DNS (kept for the run). Blocking.
fn custom_boot(url: &str) -> Vec<IpAddr> {
    static BOOT: OnceLock<Mutex<HashMap<String, Vec<IpAddr>>>> = OnceLock::new();
    let host = dc::host_of(url).unwrap_or_default();
    if host.is_empty() || host.parse::<IpAddr>().is_ok() || dc::is_on_device(url) {
        return Vec::new();
    }
    let m = BOOT.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(v) = m.lock().ok().and_then(|g| g.get(&host).cloned()) {
        return v;
    }
    let health = st().health.clone();
    for id in dc::order(&Choice::Auto, &health, now()) {
        if let Some(p) = dc::find(&id) {
            if let Ok((ips, _)) = ask_blocking(&p.url, &p.ips, &host) {
                if !ips.is_empty() {
                    if let Ok(mut g) = m.lock() {
                        g.insert(host.clone(), ips.clone());
                    }
                    return ips;
                }
            }
        }
    }
    // (Not found: a placeholder that cannot be reached, so the network's DNS is never asked for it.)
    vec![IpAddr::from([192, 0, 2, 1])]
}

/// One resolver asked for both families (A first; AAAA when A had none), blocking (called off the async threads).
fn ask_blocking(url: &str, ips: &[IpAddr], host: &str) -> Result<(Vec<IpAddr>, u64), dc::Fault> {
    let f = |qt: u16| tauri::async_runtime::block_on(net::doh_ask(url, ips, host, qt, dc::ASK_TIMEOUT_MS));
    let map = |r: doh::Refused| match r {
        doh::Refused::NoSuchName => dc::Fault::NoSuchName,
        doh::Refused::Bad(e) => dc::Fault::Failed(e),
    };
    let (four, ttl4) = f(doh::TYPE_A).map_err(map)?;
    if !four.is_empty() {
        return Ok((four, ttl4 as u64));
    }
    let (six, ttl6) = f(doh::TYPE_AAAA).map_err(map)?;
    Ok((six, ttl6 as u64))
}

fn system_lookup(host: &str) -> Result<Vec<IpAddr>, String> {
    use std::net::ToSocketAddrs;
    (host, 0u16).to_socket_addrs().map(|a| a.map(|s| s.ip()).collect()).map_err(|e| e.to_string())
}

/// `host` resolved by the chain (blocking). Every outcome is recorded for the status line.
pub fn lookup_blocking(host: &str) -> Result<Vec<IpAddr>, String> {
    let (choice, order, allow) = {
        let mut g = st();
        g.queries += 1;
        let o = dc::order(&g.choice, &g.health, now());
        (g.choice.clone(), o, g.allow_system)
    };
    if order.is_empty() {
        return Err("DNS over HTTPS is off".to_string());
    }
    let started = Instant::now();
    let mut asked: Vec<(String, bool, u64, String)> = Vec::new();
    // (This name's entry is taken out while the resolvers are asked — no lock held across the network.)
    let mut cache = st().cache.only(host);
    let r = dc::resolve(
        host,
        &order,
        &mut cache,
        now(),
        allow,
        &mut |id| {
            let t0 = Instant::now();
            let Some((url, ips)) = server(id, &choice) else { return Err(dc::Fault::Failed("unknown".into())) };
            let r = ask_blocking(&url, &ips, host);
            let ms = t0.elapsed().as_millis() as u64;
            match &r {
                Ok(_) | Err(dc::Fault::NoSuchName) => asked.push((id.to_string(), true, ms, String::new())),
                Err(dc::Fault::Failed(e)) => asked.push((id.to_string(), false, ms, e.clone())),
            }
            r
        },
        &mut || started.elapsed().as_millis() as u64,
        &mut || system_lookup(host),
    );
    let mut g = st();
    let t = now();
    g.cache.merge(cache, t);
    for (id, ok, ms, why) in asked {
        dc::note(&mut g.health, &id, ok, ms, &why, t);
    }
    if let Ok(res) = &r {
        for (id, why) in &res.failed {
            if why == "blocked" {
                dc::note(&mut g.health, id, false, 0, "blocked", t);
            }
        }
    }
    let out = match r {
        Ok(res) => {
            if res.via == dc::Via::System {
                g.system += 1;
            }
            g.used.insert(host.to_ascii_lowercase(), (res.via.code(), t));
            Ok(res.ips)
        }
        Err(dc::ChainError::NoSuchName { by }) => {
            g.used.insert(host.to_ascii_lowercase(), (format!("none:{}", by), t));
            Err(format!("no such host: {} (answered by {})", host, by))
        }
        Err(dc::ChainError::AllFailed { failed, system_allowed }) => {
            g.fails += 1;
            g.chain_failed = true;
            g.used.insert(host.to_ascii_lowercase(), ("failed".to_string(), t));
            let why: Vec<String> = failed.iter().take(3).map(|(id, e)| format!("{}: {}", id, e)).collect();
            Err(format!("DNS over HTTPS: no resolver answered for {} ({}){}", host, why.join("; "), if system_allowed { "" } else { " — the system's DNS is not allowed in Settings" }))
        }
    };
    if g.used.len() > 400 {
        let oldest: Vec<String> = { let mut v: Vec<(&String, &(String, u64))> = g.used.iter().collect(); v.sort_by_key(|(_, (_, at))| *at); v.iter().take(100).map(|(k, _)| (*k).clone()).collect() };
        for k in oldest {
            g.used.remove(&k);
        }
    }
    let due = !g.probing && dc::probe_due(g.choice != Choice::Off, g.last_probe, g.chain_failed, t);
    drop(g);
    if due {
        tauri::async_runtime::spawn(async { let _ = probe().await; });
    }
    out
}

/// The probe: PROBE_NAME asked of every resolver at once (5 s each); each one's health noted; the order follows.
pub async fn probe() -> Value {
    let choice = {
        let mut g = st();
        if g.probing {
            return json!({ "ok": false, "why": "busy" });
        }
        g.probing = true;
        g.choice.clone()
    };
    let mut ids: Vec<String> = dc::catalog().iter().map(|p| p.id.clone()).collect();
    if let Choice::Custom(_) = choice {
        ids.insert(0, "custom".to_string());
    }
    // (The addresses found off the async threads: the user's resolver's own name may have to be asked first.)
    let servers: Vec<(String, (String, Vec<IpAddr>))> = tauri::async_runtime::spawn_blocking(move || ids.into_iter().filter_map(|id| server(&id, &choice).map(|s| (id, s))).collect()).await.unwrap_or_default();
    let mut tasks = Vec::new();
    for (id, (url, ips)) in servers {
        tasks.push(tauri::async_runtime::spawn(async move {
            let t0 = Instant::now();
            let r = net::doh_ask(&url, &ips, dc::PROBE_NAME, doh::TYPE_A, 5000).await;
            let ms = t0.elapsed().as_millis() as u64;
            match r {
                Ok((a, _)) if a.iter().any(|ip| dc::address_ok(ip, id == "custom")) => (id, true, ms, String::new()),
                Ok(_) => (id, false, ms, "no usable address".to_string()),
                Err(doh::Refused::NoSuchName) => (id, false, ms, "no such name".to_string()),
                Err(doh::Refused::Bad(e)) => (id, false, ms, e),
            }
        }));
    }
    let mut results = Vec::new();
    for t in tasks {
        if let Ok(r) = t.await {
            results.push(r);
        }
    }
    let mut g = st();
    let t = now();
    for (id, ok, ms, why) in &results {
        dc::note(&mut g.health, id, *ok, *ms, why, t);
    }
    g.last_probe = Some(t);
    g.chain_failed = false;
    g.probing = false;
    let best = results.iter().filter(|r| r.1).min_by_key(|r| r.2).cloned();
    drop(g);
    let mut o = status();
    o["ok"] = json!(best.is_some());
    if let Some((id, _, ms, _)) = best {
        o["resolver"] = json!(id);
        o["ms"] = json!(ms);
    } else {
        o["why"] = json!("no resolver answered");
    }
    o
}

/// The provider set in force: the hook installed (or removed), the proxy for aria2 started (or stopped).
pub fn apply(provider: &str, allow_system: bool) -> Value {
    let choice = dc::parse_choice(provider);
    let on = choice != Choice::Off;
    {
        let mut g = st();
        if g.choice != choice {
            g.cache.clear();
            g.last_probe = None;
        }
        g.choice = choice.clone();
        g.allow_system = allow_system;
        if !on {
            g.proxy = None;
        } else if g.proxy.is_none() {
            let secret = format!("{:x}{:x}", now(), std::process::id() as u64 * 2654435761);
            let resolve: dohproxy::Resolve = Arc::new(|h: &str| lookup_blocking(h));
            g.proxy = dohproxy::start(resolve, &format!("kt{}{}", secret, secret)).ok();
        }
    }
    if on {
        let hook: net::DohHook = Arc::new(|host: String| {
            let f: std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<IpAddr>, String>> + Send>> = Box::pin(async move {
                match tauri::async_runtime::spawn_blocking(move || lookup_blocking(&host)).await {
                    Ok(r) => r,
                    Err(e) => Err(e.to_string()),
                }
            });
            f
        });
        net::set_doh_hook(Some(hook));
    } else {
        net::set_doh_hook(None);
        net::set_doh("off");
    }
    crate::engine::set_doh_proxy(proxy_url());
    json!({ "provider": provider, "allowSystem": allow_system, "on": on })
}

/// What aria2's all-proxy gets while DoH is on (empty when off).
pub fn proxy_url() -> String {
    st().proxy.as_ref().map(|p| p.url()).unwrap_or_default()
}

/// A magnet's UDP trackers by address (blocking; the magnet as it was while DoH is off).
pub fn rewrite_magnet(m: &str) -> String {
    if st().choice == Choice::Off {
        return m.to_string();
    }
    dc::magnet_rewrite(m, &mut |h| lookup_blocking(h).ok().and_then(|ips| ips.into_iter().next()))
}

/// Everything the settings page shows.
pub fn status() -> Value {
    let g = st();
    let t = now();
    let order = dc::order(&g.choice, &g.health, t);
    let provs: Vec<Value> = dc::catalog()
        .iter()
        .map(|p| {
            let h = g.health.get(&p.id);
            json!({ "id": p.id, "label": p.label, "url": p.url, "filters": p.filters, "ok": h.map(|h| h.ok), "ms": h.map(|h| h.ms), "at": h.map(|h| h.at * 1000), "reason": h.map(|h| h.reason.clone()).unwrap_or_default() })
        })
        .collect();
    let custom = g.health.get("custom").map(|h| json!({ "ok": h.ok, "ms": h.ms, "at": h.at * 1000, "reason": h.reason }));
    json!({
        "on": g.choice != Choice::Off, "allowSystem": g.allow_system, "order": order, "providers": provs, "custom": custom,
        "lastProbe": g.last_probe.map(|x| x * 1000), "queries": g.queries, "fails": g.fails, "system": g.system,
        "cached": g.cache.len(), "proxy": { "running": g.proxy.is_some(), "port": g.proxy.as_ref().map(|p| p.port()).unwrap_or(0), "tunnels": g.proxy.as_ref().map(|p| p.tunnels.load(std::sync::atomic::Ordering::Relaxed)).unwrap_or(0) },
        "covers": { "http": true, "downloads": true, "trackersHttp": true, "trackersUdp": "magnet", "webview": false, "system": "allowed-only" }
    })
}

/// For each host asked: { via, at } — what answered it last (none when it was not asked through the chain).
pub fn used(hosts: &[String]) -> Value {
    let g = st();
    let mut o = serde_json::Map::new();
    for h in hosts {
        if let Some((via, at)) = g.used.get(&h.to_ascii_lowercase()) {
            o.insert(h.clone(), json!({ "via": via, "at": at * 1000 }));
        }
    }
    json!({ "on": g.choice != Choice::Off, "hosts": Value::Object(o) })
}
