// The pure half of the download engine (desktop/aria2.cjs): where aria2c is looked for, the arguments it is started
// with, the per-download options of kt:add, aria2's status objects mapped to the page's Task, and when to push the
// list again. Std only, so it can be checked alone: `rustc --edition 2021 --test engine_core.rs`. The other half
// (engine.rs) moves JSON in and out of these and talks to aria2c.
use std::path::{Path, PathBuf};

/// A number as JS's String(n) writes it: «8», «1.5», «NaN».
pub fn js_num(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_string();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if n.fract() == 0.0 && n.abs() < 1e21 {
        return format!("{}", n as i64);
    }
    format!("{}", n)
}

/// aria2's numbers come as strings: `Number(s ?? 0) || 0`, never negative here.
pub fn num(s: &str) -> u64 {
    let t = s.trim();
    if t.is_empty() {
        return 0;
    }
    match t.parse::<u64>() {
        Ok(v) => v,
        Err(_) => match t.parse::<f64>() {
            Ok(f) if f.is_finite() && f > 0.0 => f as u64,
            _ => 0,
        },
    }
}

/* ---------- the binary ---------- */

/// The folder name aria2.cjs uses for an OS (Node's process.platform): win, mac, linux.
pub fn plat_dir(node_platform: &str) -> &'static str {
    match node_platform {
        "win32" => "win",
        "darwin" => "mac",
        _ => "linux",
    }
}

pub fn exe_name(node_platform: &str) -> &'static str {
    if node_platform == "win32" {
        "aria2c.exe"
    } else {
        "aria2c"
    }
}

/// Where a shipped aria2c may be, in aria2.cjs's order — <res>/aria2/<plat>-<arch>/aria2c, then <res>/aria2/<plat>/
/// aria2c —, for each folder given (the app's resource folder, then the executable's own).
pub fn binary_candidates(
    res_dirs: &[PathBuf],
    node_platform: &str,
    node_arch: &str,
) -> Vec<PathBuf> {
    let plat = plat_dir(node_platform);
    let exe = exe_name(node_platform);
    let mut out: Vec<PathBuf> = Vec::new();
    for r in res_dirs {
        let a = r
            .join("aria2")
            .join(format!("{}-{}", plat, node_arch))
            .join(exe);
        let b = r.join("aria2").join(plat).join(exe);
        for p in [a, b] {
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}

/// Homebrew's places (a Mac app started from the Finder has no shell PATH): looked at after the PATH.
pub fn mac_extra_candidates() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/opt/homebrew/bin/aria2c"),
        PathBuf::from("/usr/local/bin/aria2c"),
    ]
}

/// The reason given when there is no aria2c (aria2.cjs's words).
pub fn missing_reason(node_platform: &str) -> &'static str {
    if node_platform == "darwin" {
        "aria2c is not bundled for macOS: install it with Homebrew (brew install aria2), or set up a remote aria2 in Settings."
    } else {
        "aria2c missing"
    }
}

/* ---------- the arguments ---------- */

/// Prism's connection settings (config.net).
#[derive(Clone, Debug, Default)]
pub struct NetConfig {
    pub ua: String,
    pub retries: Option<f64>,
    pub timeout: Option<f64>,
    pub proxy: String,
    pub conflict: String,
}

/// The engine's settings (aria2-config.json over { seed: false, listenPort: 0, maxConnections: 8 }).
#[derive(Clone, Debug)]
pub struct EngineConfig {
    pub seed: bool,
    pub listen_port: f64,
    pub max_connections: f64,
    pub seed_ratio: f64,
    pub seed_minutes: f64,
    /// `c.dht === false`
    pub dht_off: bool,
    /// `c.lsd === false`
    pub lsd_off: bool,
    pub enc_forced: bool,
    pub net: NetConfig,
}

impl Default for EngineConfig {
    fn default() -> Self {
        EngineConfig {
            seed: false,
            listen_port: 0.0,
            max_connections: 8.0,
            seed_ratio: 0.0,
            seed_minutes: 0.0,
            dht_off: false,
            lsd_off: false,
            enc_forced: false,
            net: NetConfig::default(),
        }
    }
}

/// aria2.cjs's netOptions: the name given to servers, tries, how long to wait, a proxy, what to do with a file
/// already there — in its order.
pub fn net_options(n: &NetConfig) -> Vec<(String, String)> {
    let mut o: Vec<(String, String)> = Vec::new();
    let ua = n.ua.trim();
    o.push((
        "user-agent".to_string(),
        if ua.is_empty() {
            "KurokawaTools/0.1 aria2".to_string()
        } else {
            ua.to_string()
        },
    ));
    let retries = n.retries.unwrap_or(5.0);
    o.push(("max-tries".to_string(), js_num(retries.min(30.0).max(0.0))));
    let t = n.timeout.unwrap_or(60.0).min(600.0).max(5.0);
    o.push(("timeout".to_string(), js_num(t)));
    o.push(("connect-timeout".to_string(), js_num(t.min(30.0))));
    o.push(("all-proxy".to_string(), n.proxy.trim().to_string()));
    let c = if n.conflict.is_empty() {
        "rename"
    } else {
        n.conflict.as_str()
    };
    o.push((
        "auto-file-renaming".to_string(),
        if c == "rename" { "true" } else { "false" }.to_string(),
    ));
    o.push((
        "allow-overwrite".to_string(),
        if c == "overwrite" { "true" } else { "false" }.to_string(),
    ));
    o
}

/// What aria2c is started with: aria2.cjs's list, in its order, then `--stop-with-process` (aria2 quits by itself
/// when the app is gone, however it went).
pub struct StartPaths<'a> {
    pub default_dir: &'a Path,
    pub session_file: &'a Path,
    pub data_dir: &'a Path,
}

pub fn start_args(
    c: &EngineConfig,
    port: u16,
    secret: &str,
    p: &StartPaths,
    parent_pid: u32,
) -> Vec<String> {
    let conns = js_num(c.max_connections.min(16.0));
    let mut a: Vec<String> = vec![
        "--enable-rpc".to_string(),
        format!("--rpc-listen-port={}", port),
        format!("--rpc-secret={}", secret),
        "--rpc-listen-all=false".to_string(),
        "--rpc-allow-origin-all=false".to_string(),
        "--continue=true".to_string(),
        format!("--max-connection-per-server={}", conns),
        format!("--split={}", conns),
        "--min-split-size=1M".to_string(),
        "--max-concurrent-downloads=5".to_string(),
        "--bt-save-metadata=true".to_string(),
        "--bt-load-saved-metadata=true".to_string(),
        "--seed-time=0".to_string(),
        "--seed-ratio=0".to_string(),
        format!("--dir={}", p.default_dir.display()),
        format!("--save-session={}", p.session_file.display()),
        format!("--input-file={}", p.session_file.display()),
        "--save-session-interval=30".to_string(),
        "--enable-dht=true".to_string(),
        "--enable-dht6=true".to_string(),
        "--bt-enable-lpd=true".to_string(),
        "--follow-torrent=true".to_string(),
        "--file-allocation=none".to_string(),
        "--check-certificate=false".to_string(),
        "--user-agent=KurokawaTools/0.1 aria2".to_string(),
        "--summary-interval=0".to_string(),
        "--console-log-level=warn".to_string(),
        "--quiet=true".to_string(),
        "--bt-detach-seed-only=true".to_string(),
        "--auto-file-renaming=true".to_string(),
        "--allow-overwrite=false".to_string(),
        "--max-tries=5".to_string(),
        "--retry-wait=3".to_string(),
        format!("--dht-file-path={}", p.data_dir.join("dht.dat").display()),
        format!("--dht-file-path6={}", p.data_dir.join("dht6.dat").display()),
    ];
    if c.listen_port > 0.0 {
        let lp = js_num(c.listen_port);
        a.push(format!("--listen-port={}", lp));
        a.push(format!("--dht-listen-port={}", lp));
    } else {
        a.push("--listen-port=6881-6999".to_string());
        a.push("--dht-listen-port=6881-6999".to_string());
    }
    if !c.seed {
        a.push("--seed-time=0".to_string());
    } else {
        a.push(format!(
            "--seed-ratio={}",
            if c.seed_ratio > 0.0 {
                js_num(c.seed_ratio)
            } else {
                "0.0".to_string()
            }
        ));
        if c.seed_minutes > 0.0 {
            a.push(format!("--seed-time={}", js_num(c.seed_minutes)));
        }
    }
    if c.dht_off {
        a.push("--enable-dht=false".to_string());
        a.push("--enable-dht6=false".to_string());
    }
    if c.lsd_off {
        a.push("--bt-enable-lpd=false".to_string());
    } else {
        a.push("--bt-enable-lpd=true".to_string());
    }
    if c.enc_forced {
        a.push("--bt-require-crypto=true".to_string());
        a.push("--bt-min-crypto-level=arc4".to_string());
    }
    for (k, v) in net_options(&c.net) {
        a.push(format!("--{}={}", k, v));
    }
    a.push(format!("--stop-with-process={}", parent_pid));
    a
}

/// kt:configure's seeding change as a global option (aria2.cjs's configure).
pub fn seed_options(c: &EngineConfig) -> Vec<(String, String)> {
    if c.seed {
        vec![
            (
                "seed-ratio".to_string(),
                if c.seed_ratio > 0.0 {
                    js_num(c.seed_ratio)
                } else {
                    "0.0".to_string()
                },
            ),
            (
                "seed-time".to_string(),
                if c.seed_minutes > 0.0 {
                    js_num(c.seed_minutes)
                } else {
                    "525600".to_string()
                },
            ),
        ]
    } else {
        vec![("seed-time".to_string(), "0".to_string())]
    }
}

/* ---------- kt:add's options ---------- */

#[derive(Clone, Debug, PartialEq)]
pub enum OptVal {
    S(String),
    L(Vec<String>),
}

#[derive(Clone, Debug, Default)]
pub struct AddIn {
    pub dir: String,
    pub name: String,
    pub has_url: bool,
    pub paused: bool,
    pub connections: f64,
    pub files: Vec<i64>,
    pub sequential: bool,
    /// None: no `source.headers`; Some: its entries, values as String(v).
    pub headers: Option<Vec<(String, String)>>,
    pub no_retry: bool,
}

pub fn header_lines(h: &[(String, String)]) -> Vec<String> {
    h.iter().map(|(k, v)| format!("{}: {}", k, v)).collect()
}

/// aria2.cjs's add(): the options of one download, in its order.
pub fn add_options(a: &AddIn) -> Vec<(String, OptVal)> {
    let mut o: Vec<(String, OptVal)> = Vec::new();
    if !a.dir.is_empty() {
        o.push(("dir".to_string(), OptVal::S(a.dir.clone())));
    }
    if !a.name.is_empty() && a.has_url {
        o.push(("out".to_string(), OptVal::S(a.name.clone())));
    }
    if a.paused {
        o.push(("pause".to_string(), OptVal::S("true".to_string())));
    }
    if a.connections != 0.0 && !a.connections.is_nan() {
        o.push(("split".to_string(), OptVal::S(js_num(a.connections))));
        o.push((
            "max-connection-per-server".to_string(),
            OptVal::S(js_num(a.connections.min(16.0))),
        ));
    }
    if !a.files.is_empty() {
        let s: Vec<String> = a.files.iter().map(|i| (i + 1).to_string()).collect();
        o.push(("select-file".to_string(), OptVal::S(s.join(","))));
    }
    if a.sequential {
        o.push((
            "bt-prioritize-piece".to_string(),
            OptVal::S("head=16M,tail=4M".to_string()),
        ));
        o.push((
            "stream-piece-selector".to_string(),
            OptVal::S("inorder".to_string()),
        ));
    }
    if let Some(h) = &a.headers {
        o.push(("header".to_string(), OptVal::L(header_lines(h))));
    }
    if a.no_retry {
        o.push(("max-tries".to_string(), OptVal::S("1".to_string())));
    }
    o
}

/// kt:setFiles: the page's priorities (0 skipped) as aria2's select-file list.
pub fn select_files(priorities: &[i64]) -> String {
    let v: Vec<String> = priorities
        .iter()
        .enumerate()
        .filter(|(_, p)| **p != 0)
        .map(|(i, _)| (i + 1).to_string())
        .collect();
    v.join(",")
}

/// kt:move(id, how): aria2's changePosition arguments (−2 first, 2 last, ±1 one place).
pub fn move_args(how: i64) -> (i64, &'static str) {
    let pos = if how == -2 || how == 2 { 0 } else { how };
    let mode = if how == -2 {
        "POS_SET"
    } else if how == 2 {
        "POS_END"
    } else {
        "POS_CUR"
    };
    (pos, mode)
}

/// kt:rename's name: what a file system refuses made «_», trimmed; None for nothing, «.» or «..».
pub fn clean_name(s: &str) -> Option<String> {
    let mapped: String = s
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            other => other,
        })
        .collect();
    let t = mapped.trim().to_string();
    if t.is_empty() || t == "." || t == ".." {
        None
    } else {
        Some(t)
    }
}

/* ---------- aria2's status → the page's Task ---------- */

#[derive(Clone, Debug, Default)]
pub struct FileSt {
    pub index: String,
    pub path: String,
    pub length: String,
    pub completed_length: String,
    pub selected: String,
    pub first_uri: Option<String>,
    /// Every URI of the file (setUrl's old ones).
    pub uris: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Status {
    pub gid: String,
    pub status: String,
    pub total_length: String,
    pub completed_length: String,
    pub download_speed: String,
    pub upload_speed: String,
    pub info_hash: Option<String>,
    pub num_seeders: Option<String>,
    pub connections: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub dir: String,
    pub files: Vec<FileSt>,
    pub bittorrent: bool,
    pub bt_name: Option<String>,
    pub followed_by: Vec<String>,
    pub bitfield: Option<String>,
    pub num_pieces: String,
    pub piece_length: String,
}

/// What the app keeps of a download beside aria2 (tasks.json), the parts the mapping needs.
#[derive(Clone, Debug, Default)]
pub struct Extra {
    pub name: Option<String>,
    pub renamed: Option<String>,
    pub added_at: Option<i64>,
    pub done_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Segment {
    pub start: u64,
    pub end: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TaskFile {
    pub index: i64,
    pub path: String,
    pub size: u64,
    pub done: u64,
    pub priority: u8,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TaskCore {
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    /// The source when the app kept none: a torrent's magnet, a file's first address.
    pub magnet: Option<String>,
    pub url: Option<String>,
    pub dir: String,
    pub state: &'static str,
    pub done: u64,
    pub total: u64,
    pub down_speed: u64,
    pub up_speed: u64,
    pub eta: Option<u64>,
    pub peers: Option<u64>,
    pub seeds: Option<u64>,
    pub connections: Option<u64>,
    pub info_hash: Option<String>,
    pub files: Vec<TaskFile>,
    pub segments: Option<Vec<Segment>>,
    pub error: Option<String>,
    pub added_at: i64,
    pub done_at: Option<i64>,
}

fn non_empty(o: &Option<String>) -> Option<&str> {
    match o {
        Some(s) if !s.is_empty() => Some(s.as_str()),
        _ => None,
    }
}

/// The last part of a path, by either separator.
pub fn base_name(p: &str) -> &str {
    let t = p.trim_end_matches(['/', '\\']);
    match t.rfind(['/', '\\']) {
        Some(i) => &t[i + 1..],
        None => t,
    }
}

pub fn name_of(st: &Status) -> String {
    if let Some(n) = non_empty(&st.bt_name) {
        return n.to_string();
    }
    if let Some(f) = st.files.first() {
        if !f.path.is_empty() {
            let b = base_name(&f.path);
            if !b.is_empty() {
                return b.to_string();
            }
        }
        if let Some(u) = &f.first_uri {
            let last = u.split('/').last().unwrap_or("");
            if !last.is_empty() {
                return last.to_string();
            }
        }
    }
    st.gid.clone()
}

pub fn state_of(st: &Status) -> &'static str {
    let total = num(&st.total_length);
    let done = num(&st.completed_length);
    match st.status.as_str() {
        "active" => {
            if st.bittorrent && total == 0 {
                "metadata"
            } else if st.bittorrent && total > 0 && done >= total {
                "seeding"
            } else {
                "downloading"
            }
        }
        "waiting" => "queued",
        "paused" => "paused",
        "complete" => "done",
        _ => "failed",
    }
}

/// aria2's piece bitfield as runs of finished pieces (bytes), at most 400 — the details page's file map.
pub fn pieces_to_segments(st: &Status) -> Option<Vec<Segment>> {
    let bits = non_empty(&st.bitfield)?.as_bytes();
    let n = num(&st.num_pieces);
    let len = num(&st.piece_length);
    let total = num(&st.total_length);
    if n == 0 || len == 0 {
        return None;
    }
    let mut out: Vec<Segment> = Vec::new();
    let mut run: Option<u64> = None;
    let mut i: u64 = 0;
    while i <= n {
        let on = if i < n {
            let c = bits.get((i >> 2) as usize).copied().unwrap_or(b'0');
            let v = (c as char).to_digit(16).unwrap_or(0);
            (v >> (3 - (i & 3))) & 1 == 1
        } else {
            false
        };
        match (on, run) {
            (true, None) => run = Some(i),
            (false, Some(r)) => {
                let end = total.min(i * len);
                out.push(Segment {
                    start: r * len,
                    end,
                });
                run = None;
            }
            _ => {}
        }
        i += 1;
    }
    out.truncate(400);
    Some(out)
}

/// A file's path as the page shows it: under the task's folder, without it.
pub fn rel_path(fp: &str, dir: &str) -> String {
    if fp.starts_with(dir) {
        fp[dir.len()..].trim_start_matches(['/', '\\']).to_string()
    } else {
        fp.to_string()
    }
}

/// aria2.cjs's task(st) — every part but the kept source and meta, which engine.rs adds as they were kept.
pub fn task_core(st: &Status, ex: &Extra, now: i64) -> TaskCore {
    let total = num(&st.total_length);
    let done = num(&st.completed_length);
    let speed = num(&st.download_speed);
    let dir = st.dir.trim_end_matches(['/', '\\']).to_string();
    let name = match non_empty(&ex.name) {
        Some(n) => n.to_string(),
        None => name_of(st),
    };
    let (magnet, url) = if st.bittorrent {
        (
            non_empty(&st.info_hash).map(|h| format!("magnet:?xt=urn:btih:{}", h)),
            None,
        )
    } else {
        (None, st.files.first().and_then(|f| f.first_uri.clone()))
    };
    let eta = if speed > 0 && total > done {
        Some(((total - done) as f64 / speed as f64).round() as u64)
    } else {
        None
    };
    let files: Vec<TaskFile> = st
        .files
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let fp: String = match (i, non_empty(&ex.renamed)) {
                (0, Some(r)) => r.to_string(),
                _ => f.path.clone(),
            };
            TaskFile {
                index: f.index.trim().parse::<i64>().unwrap_or(0) - 1,
                path: rel_path(&fp, &dir),
                size: num(&f.length),
                done: num(&f.completed_length),
                priority: if f.selected == "true" { 1 } else { 0 },
            }
        })
        .collect();
    let error = if st.status == "error" {
        Some(format!(
            "{} ({})",
            st.error_message.clone().unwrap_or_default(),
            st.error_code
                .clone()
                .unwrap_or_else(|| "undefined".to_string())
        ))
    } else {
        None
    };
    let added_at = match ex.added_at {
        Some(t) if t != 0 => t,
        _ => now,
    };
    let done_at = if st.status == "complete" {
        match ex.done_at {
            Some(t) if t != 0 => Some(t),
            _ => Some(now),
        }
    } else {
        None
    };
    TaskCore {
        id: st.gid.clone(),
        kind: if st.bittorrent { "torrent" } else { "http" },
        name,
        magnet,
        url,
        dir,
        state: state_of(st),
        done,
        total,
        down_speed: speed,
        up_speed: num(&st.upload_speed),
        eta,
        peers: if st.bittorrent {
            Some(num(&st.connections))
        } else {
            None
        },
        seeds: st.num_seeders.as_ref().map(|s| num(s)),
        connections: if st.bittorrent {
            None
        } else {
            Some(num(&st.connections))
        },
        info_hash: st.info_hash.clone(),
        files,
        segments: if st.status == "active" && !st.bittorrent {
            pieces_to_segments(st)
        } else {
            None
        },
        error,
        added_at,
        done_at,
    }
}

/// aria2.cjs's list() filter: a magnet's metadata step that led to the real download is not shown.
pub fn visible(st: &Status) -> bool {
    let followed = !st.followed_by.is_empty();
    !(followed && num(&st.total_length) == 0) && !(st.status == "complete" && followed)
}

/// How long until the list is asked again: soon while something moves, else every few seconds (aria2.cjs's loop).
pub fn next_delay_ms(states: &[&str]) -> u64 {
    let moving = states
        .iter()
        .any(|s| matches!(*s, "downloading" | "metadata" | "seeding" | "queued"));
    if moving {
        700
    } else {
        4000
    }
}

/// Whether the list pushed last differs from the new one (both as their JSON text): kt:tasks only on a change.
pub fn changed(last: Option<&str>, next: &str) -> bool {
    match last {
        Some(l) => l != next,
        None => true,
    }
}

/* ---------- a secret ---------- */

/// A hex secret from the process's random hash keys, the time and a counter (no crate: for a loopback RPC).
pub fn random_hex(bytes: usize) -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut out = String::new();
    let mut i: u64 = 0;
    while out.len() < bytes * 2 {
        let mut h = RandomState::new().build_hasher();
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        h.write_u128(t);
        h.write_u32(std::process::id());
        h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        h.write_u64(i);
        out.push_str(&format!("{:016x}", h.finish()));
        i += 1;
    }
    out.truncate(bytes * 2);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(status: &str) -> Status {
        Status {
            gid: "g1".into(),
            status: status.into(),
            total_length: "1000".into(),
            completed_length: "250".into(),
            download_speed: "250".into(),
            upload_speed: "0".into(),
            connections: "3".into(),
            dir: "/dl/".into(),
            num_pieces: "0".into(),
            piece_length: "0".into(),
            files: vec![FileSt {
                index: "1".into(),
                path: "/dl/a.mkv".into(),
                length: "1000".into(),
                completed_length: "250".into(),
                selected: "true".into(),
                first_uri: Some("https://x.org/f/a.mkv".into()),
                uris: vec!["https://x.org/f/a.mkv".into()],
            }],
            ..Default::default()
        }
    }

    #[test]
    fn numbers() {
        assert_eq!(js_num(8.0), "8");
        assert_eq!(js_num(1.5), "1.5");
        assert_eq!(js_num(f64::NAN), "NaN");
        assert_eq!(num("12"), 12);
        assert_eq!(num(""), 0);
        assert_eq!(num("x"), 0);
    }

    #[test]
    fn candidates() {
        let c = binary_candidates(&[PathBuf::from("/r"), PathBuf::from("/e")], "linux", "x64");
        assert_eq!(c[0], PathBuf::from("/r/aria2/linux-x64/aria2c"));
        assert_eq!(c[1], PathBuf::from("/r/aria2/linux/aria2c"));
        assert_eq!(c[2], PathBuf::from("/e/aria2/linux-x64/aria2c"));
        assert_eq!(c.len(), 4);
        let w = binary_candidates(&[PathBuf::from("/r"), PathBuf::from("/r")], "win32", "x64");
        assert_eq!(w.len(), 2);
        assert!(w[0].ends_with("aria2/win-x64/aria2c.exe"));
        assert!(missing_reason("darwin").contains("Homebrew"));
        assert_eq!(missing_reason("linux"), "aria2c missing");
    }

    #[test]
    fn args() {
        let c = EngineConfig::default();
        let p = StartPaths {
            default_dir: Path::new("/dl"),
            session_file: Path::new("/data/aria2.session"),
            data_dir: Path::new("/data"),
        };
        let a = start_args(&c, 6800, "s3", &p, 42);
        assert_eq!(a[0], "--enable-rpc");
        assert!(a.contains(&"--rpc-listen-port=6800".to_string()));
        assert!(a.contains(&"--rpc-secret=s3".to_string()));
        assert!(a.contains(&"--split=8".to_string()));
        assert!(a.contains(&"--dir=/dl".to_string()));
        assert!(a.contains(&"--input-file=/data/aria2.session".to_string()));
        assert!(a.contains(&"--dht-file-path=/data/dht.dat".to_string()));
        assert!(a.contains(&"--listen-port=6881-6999".to_string()));
        assert!(a.contains(&"--user-agent=KurokawaTools/0.1 aria2".to_string()));
        assert!(a.contains(&"--max-tries=5".to_string()));
        assert!(a.contains(&"--timeout=60".to_string()));
        assert!(a.contains(&"--connect-timeout=30".to_string()));
        assert!(a.contains(&"--all-proxy=".to_string()));
        assert_eq!(a.last().unwrap(), "--stop-with-process=42");
        // 35 fixed + 2 ports + seed-time + lpd + 7 net + stop-with-process
        assert_eq!(a.len(), 35 + 2 + 1 + 1 + 7 + 1);
        let c2 = EngineConfig {
            seed: true,
            seed_ratio: 1.5,
            seed_minutes: 30.0,
            listen_port: 51413.0,
            max_connections: 32.0,
            dht_off: true,
            lsd_off: true,
            enc_forced: true,
            net: NetConfig {
                ua: " UA ".into(),
                retries: Some(99.0),
                timeout: Some(1.0),
                proxy: "http://p:1".into(),
                conflict: "overwrite".into(),
            },
        };
        let b = start_args(&c2, 1, "s", &p, 1);
        assert!(b.contains(&"--split=16".to_string()));
        assert!(b.contains(&"--listen-port=51413".to_string()));
        assert!(b.contains(&"--seed-ratio=1.5".to_string()));
        assert!(b.contains(&"--seed-time=30".to_string()));
        assert!(b.contains(&"--enable-dht=false".to_string()));
        assert!(b.contains(&"--bt-enable-lpd=false".to_string()));
        assert!(b.contains(&"--bt-min-crypto-level=arc4".to_string()));
        assert!(b.contains(&"--user-agent=UA".to_string()));
        assert!(b.contains(&"--max-tries=30".to_string()));
        assert!(b.contains(&"--timeout=5".to_string()));
        assert!(b.contains(&"--allow-overwrite=true".to_string()));
        assert!(b.contains(&"--auto-file-renaming=false".to_string()));
        assert_eq!(
            seed_options(&c2),
            vec![
                ("seed-ratio".to_string(), "1.5".to_string()),
                ("seed-time".to_string(), "30".to_string())
            ]
        );
        assert_eq!(
            seed_options(&c),
            vec![("seed-time".to_string(), "0".to_string())]
        );
    }

    #[test]
    fn add_opts() {
        let a = AddIn {
            dir: "/d".into(),
            name: "n.bin".into(),
            has_url: true,
            paused: true,
            connections: 32.0,
            files: vec![0, 2],
            sequential: true,
            headers: Some(vec![("Referer".into(), "https://x/".into())]),
            no_retry: true,
        };
        let o = add_options(&a);
        let keys: Vec<&str> = o.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            keys,
            vec![
                "dir",
                "out",
                "pause",
                "split",
                "max-connection-per-server",
                "select-file",
                "bt-prioritize-piece",
                "stream-piece-selector",
                "header",
                "max-tries"
            ]
        );
        assert_eq!(o[3].1, OptVal::S("32".into()));
        assert_eq!(o[4].1, OptVal::S("16".into()));
        assert_eq!(o[5].1, OptVal::S("1,3".into()));
        assert_eq!(o[8].1, OptVal::L(vec!["Referer: https://x/".into()]));
        assert!(add_options(&AddIn::default()).is_empty());
        let no_url = AddIn {
            name: "x".into(),
            ..Default::default()
        };
        assert!(add_options(&no_url).is_empty());
        assert_eq!(select_files(&[1, 0, 2, 1]), "1,3,4");
        assert_eq!(move_args(-2), (0, "POS_SET"));
        assert_eq!(move_args(2), (0, "POS_END"));
        assert_eq!(move_args(-1), (-1, "POS_CUR"));
        assert_eq!(clean_name(" a/b:c? "), Some("a_b_c_".to_string()));
        assert_eq!(clean_name(".."), None);
        assert_eq!(clean_name("  "), None);
    }

    #[test]
    fn mapping() {
        let s = st("active");
        let t = task_core(&s, &Extra::default(), 77);
        assert_eq!(t.kind, "http");
        assert_eq!(t.name, "a.mkv");
        assert_eq!(t.url.as_deref(), Some("https://x.org/f/a.mkv"));
        assert_eq!(t.dir, "/dl");
        assert_eq!(t.state, "downloading");
        assert_eq!(t.eta, Some(3));
        assert_eq!(t.connections, Some(3));
        assert_eq!(t.peers, None);
        assert_eq!(t.files[0].index, 0);
        assert_eq!(t.files[0].path, "a.mkv");
        assert_eq!(t.files[0].priority, 1);
        assert_eq!(t.added_at, 77);
        assert_eq!(t.done_at, None);
        assert_eq!(t.segments, None);
        let ex = Extra {
            name: Some("Kept".into()),
            renamed: Some("/dl/b.mp4".into()),
            added_at: Some(5),
            done_at: Some(9),
        };
        let mut c = st("complete");
        c.completed_length = "1000".into();
        let t2 = task_core(&c, &ex, 77);
        assert_eq!(t2.name, "Kept");
        assert_eq!(t2.files[0].path, "b.mp4");
        assert_eq!(t2.state, "done");
        assert_eq!(t2.eta, None);
        assert_eq!(t2.added_at, 5);
        assert_eq!(t2.done_at, Some(9));
        let mut e = st("error");
        e.error_message = Some("Not found".into());
        e.error_code = Some("3".into());
        assert_eq!(
            task_core(&e, &Extra::default(), 1).error.as_deref(),
            Some("Not found (3)")
        );
        e.error_code = None;
        assert_eq!(
            task_core(&e, &Extra::default(), 1).error.as_deref(),
            Some("Not found (undefined)")
        );
        let mut b = st("active");
        b.bittorrent = true;
        b.bt_name = Some("Show".into());
        b.info_hash = Some("abc".into());
        b.num_seeders = Some("4".into());
        let tb = task_core(&b, &Extra::default(), 1);
        assert_eq!(tb.kind, "torrent");
        assert_eq!(tb.name, "Show");
        assert_eq!(tb.magnet.as_deref(), Some("magnet:?xt=urn:btih:abc"));
        assert_eq!(tb.peers, Some(3));
        assert_eq!(tb.seeds, Some(4));
        assert_eq!(tb.connections, None);
        b.total_length = "0".into();
        assert_eq!(state_of(&b), "metadata");
        b.total_length = "10".into();
        b.completed_length = "10".into();
        assert_eq!(state_of(&b), "seeding");
        assert_eq!(state_of(&st("waiting")), "queued");
        assert_eq!(state_of(&st("paused")), "paused");
        assert_eq!(state_of(&st("removed")), "failed");
        let mut nf = st("active");
        nf.files[0].path = String::new();
        assert_eq!(name_of(&nf), "a.mkv");
        nf.files[0].first_uri = None;
        assert_eq!(name_of(&nf), "g1");
        assert_eq!(base_name("C:\\dl\\x.bin"), "x.bin");
    }

    #[test]
    fn segments_and_filters() {
        let mut s = st("active");
        // pieces: 1111 0000 1100 → runs [0,4) and [8,10)
        s.bitfield = Some("f0c".into());
        s.num_pieces = "12".into();
        s.piece_length = "100".into();
        let seg = pieces_to_segments(&s).unwrap();
        assert_eq!(
            seg,
            vec![
                Segment { start: 0, end: 400 },
                Segment {
                    start: 800,
                    end: 1000
                }
            ]
        );
        s.bitfield = Some(String::new());
        assert_eq!(pieces_to_segments(&s), None);
        let mut f = st("complete");
        f.followed_by = vec!["g2".into()];
        assert!(!visible(&f));
        let mut m = st("active");
        m.followed_by = vec!["g2".into()];
        m.total_length = "0".into();
        assert!(!visible(&m));
        assert!(visible(&st("active")));
        assert_eq!(next_delay_ms(&["done", "queued"]), 700);
        assert_eq!(next_delay_ms(&["done", "paused"]), 4000);
        assert!(changed(None, "[]"));
        assert!(!changed(Some("[]"), "[]"));
        let r = random_hex(12);
        assert_eq!(r.len(), 24);
        assert_ne!(r, random_hex(12));
    }
}
