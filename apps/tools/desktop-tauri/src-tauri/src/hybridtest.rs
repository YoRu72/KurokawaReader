// The hybrid's self-test side (selftest.js runHybrid; KT_SELFTEST runs only): a loopback server of its own — the
// shared test server is the released Reader's too, so nothing is added there — with a page whose script fetches a
// medium the server names only by its Content-Type, a redirect to another host (a second loopback server, «localhost»,
// that counts what reaches it), and the trusted lists of the programs' adoption; stand-in Electron folders with
// made-up programs (random bytes, never run); a made-up cookie handed over for the loopback host. Everything made up,
// everything on this computer.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::hybridlogic as logic;

/// The made-up cookie handed over (selftest.js looks for it in the browser's store).
pub const COOKIE_NAME: &str = "kt_hybrid";
pub const COOKIE_VALUE: &str = "made-up-1";

struct Servers {
    port: u16,
    other: u16,
}
static SERVERS: OnceLock<Option<Servers>> = OnceLock::new();
/// What the second server («localhost», another host) was asked.
static OTHER_HITS: AtomicUsize = AtomicUsize::new(0);
/// Answers set by the rows: path → (content type, body).
static DYN: Mutex<Option<HashMap<String, (String, Vec<u8>)>>> = Mutex::new(None);

fn put(path: &str, ct: &str, body: Vec<u8>) {
    if let Ok(mut g) = DYN.lock() {
        g.get_or_insert_with(HashMap::new).insert(path.to_string(), (ct.to_string(), body));
    }
}

fn read_head(s: &mut TcpStream) -> Option<(String, String)> {
    let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    let mut buf: Vec<u8> = Vec::new();
    let mut b = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = s.read(&mut b).ok()?;
        if n == 0 || buf.len() > 64 * 1024 {
            return None;
        }
        buf.extend_from_slice(&b[..n]);
    }
    let head = String::from_utf8_lossy(&buf).into_owned();
    let mut first = head.lines().next().unwrap_or("").split_whitespace();
    Some((first.next().unwrap_or("").to_string(), first.next().unwrap_or("/").to_string()))
}

fn answer(s: &mut TcpStream, status: &str, ct: &str, extra: &str, body: &[u8], head_only: bool) {
    let h = format!("HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n{}\r\n", status, ct, body.len(), extra);
    let _ = s.write_all(h.as_bytes());
    if !head_only {
        let _ = s.write_all(body);
    }
    let _ = s.flush();
}

fn serve(mut s: TcpStream, other: u16) {
    let (method, target) = match read_head(&mut s) {
        Some(x) => x,
        None => return,
    };
    let head = method == "HEAD";
    let path = target.split('?').next().unwrap_or("/").to_string();
    match path.as_str() {
        "/h/page" => {
            let html = "<!doctype html><html><head><meta charset=\"utf-8\"><title>KT hybrid</title></head><body><h1>KT hybrid</h1><p id=\"st\">…</p><script>fetch('/h/clip').then(function(r){return r.arrayBuffer();}).then(function(){return fetch('/h/note');}).then(function(){document.getElementById('st').textContent='loaded';});</script></body></html>";
            answer(&mut s, "200 OK", "text/html; charset=utf-8", "", html.as_bytes(), head);
        }
        // (A medium named only by what the server says it is: no extension, no media element.)
        "/h/clip" => answer(&mut s, "200 OK", "video/mp4", "Accept-Ranges: bytes\r\n", b"\x00\x00\x00\x18ftypmp42made-up!", head),
        "/h/note" => answer(&mut s, "200 OK", "text/plain; charset=utf-8", "", b"not a medium", head),
        // (A redirect to another host: the probe must not follow it.)
        "/h/away" => answer(&mut s, "302 Found", "text/plain", &format!("Location: http://localhost:{}/h/clip\r\n", other), b"", head),
        _ => {
            let d = DYN.lock().ok().and_then(|g| g.as_ref().and_then(|m| m.get(&path).cloned()));
            match d {
                Some((ct, body)) => answer(&mut s, "200 OK", &ct, "", &body, head),
                None => answer(&mut s, "404 Not Found", "text/plain", "", b"no", head),
            }
        }
    }
}

fn start() -> Option<&'static Servers> {
    SERVERS
        .get_or_init(|| {
            let a = TcpListener::bind("127.0.0.1:0").ok()?;
            let b = TcpListener::bind("127.0.0.1:0").ok()?;
            let port = a.local_addr().ok()?.port();
            let other = b.local_addr().ok()?.port();
            std::thread::spawn(move || {
                for s in a.incoming().flatten() {
                    std::thread::spawn(move || serve(s, other));
                }
            });
            std::thread::spawn(move || {
                for mut s in b.incoming().flatten() {
                    OTHER_HITS.fetch_add(1, Ordering::SeqCst);
                    std::thread::spawn(move || {
                        let head = read_head(&mut s).map(|(m, _)| m == "HEAD").unwrap_or(false);
                        answer(&mut s, "200 OK", "video/mp4", "", b"elsewhere", head);
                    });
                }
            });
            Some(Servers { port, other })
        })
        .as_ref()
}

fn sha_hex(b: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b);
    kurokawa_shell::util::hex(h.finalize().as_slice())
}

/// Made-up bytes (never a program: nothing here is run).
fn made_up(seed: u8, n: usize) -> Vec<u8> {
    (0..n).map(|i| (i as u32).wrapping_mul(2654435761).wrapping_add(seed as u32).to_le_bytes()[1] ^ seed).collect()
}

fn temp(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("kt-selftest-hybrid-{}-{}", std::process::id(), name))
}

/// The adoption rows: a stand-in Electron folder, the lists on loopback → (ours as taken, ours left).
async fn adopt(base: &str, app_version: &str) -> Value {
    let os = kurokawa_shell::util::node_platform();
    let arch = kurokawa_shell::util::node_arch();
    let el = temp("electron");
    let _ = std::fs::remove_dir_all(&el);
    let (yt, gd, ff) = (made_up(1, 70_000), made_up(2, 50_000), made_up(3, 90_000));
    let w = |rel: &Path, b: &[u8]| {
        if let Some(d) = rel.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(rel, b);
    };
    use kt_core::videotools as vt;
    w(&el.join("bin").join(vt::ytdlp_file(os)), &yt);
    w(&el.join("bin").join(vt::gallery_file(os)), &gd);
    w(&el.join("packs").join("ffmpeg").join(vt::ffmpeg_file(os)), &ff);
    w(&el.join("packs").join("ffmpeg").join(vt::PACK_MARKER), b"6.0-electron");
    let lists = |tag: &str| crate::packadopt::Lists { yt_sums: format!("{}/h/{}/SHA2-256SUMS", base, tag), gallery_api: format!("{}/h/{}/gdl", base, tag), packs: format!("{}/h/{}/packs", base, tag) };
    let gasset = vt::gallery_asset(os).unwrap_or("none");
    // (The right lists: each copy is what they name.)
    put("/h/ok/SHA2-256SUMS", "text/plain", format!("{}  {}\n{}  other\n", sha_hex(&yt), vt::ytdlp_asset(os, arch), "0".repeat(64)).into_bytes());
    put("/h/ok/gdl", "application/json", json!({ "assets": [{ "name": gasset, "size": gd.len(), "digest": format!("sha256:{}", sha_hex(&gd)) }] }).to_string().into_bytes());
    let entry = |v: Value| {
        let mut m = serde_json::Map::new();
        m.insert(logic::pack_key(os, arch), v);
        Value::Object(m)
    };
    put("/h/ok/packs", "application/json", json!({ "versions": { "ffmpeg": "7.1-test" }, "packs": { "ffmpeg": entry(json!({ "file": "x.gz", "size": 1, "sha256": "0".repeat(64), "unpacked": ff.len(), "unpackedSha256": sha_hex(&ff) })) } }).to_string().into_bytes());
    // (Lists naming other programs: nothing may be taken.)
    put("/h/no/SHA2-256SUMS", "text/plain", format!("{}  {}\n", "1".repeat(64), vt::ytdlp_asset(os, arch)).into_bytes());
    put("/h/no/gdl", "application/json", json!({ "assets": [{ "name": gasset, "size": gd.len() + 1, "digest": format!("sha256:{}", sha_hex(&gd)) }] }).to_string().into_bytes());
    put("/h/no/packs", "application/json", json!({ "packs": { "ffmpeg": entry(json!({ "file": "x.gz", "size": 1, "sha256": "0".repeat(64), "unpacked": ff.len() })) } }).to_string().into_bytes());
    let targets = |d: &Path| crate::packadopt::Targets { ytdlp: d.join("bin").join(vt::ytdlp_file(os)), gallery: d.join("bin").join(vt::gallery_file(os)), ffmpeg: d.join("packs").join("ffmpeg").join(vt::ffmpeg_file(os)) };
    let ours = temp("ours");
    let left = temp("left");
    let _ = std::fs::remove_dir_all(&ours);
    let _ = std::fs::remove_dir_all(&left);
    let taken = crate::packadopt::run(vec![el.clone()], targets(&ours), lists("ok"), app_version.to_string()).await;
    let refused = crate::packadopt::run(vec![el.clone()], targets(&left), lists("no"), app_version.to_string()).await;
    let t = targets(&ours);
    let same = |p: &Path, b: &[u8]| std::fs::read(p).map(|x| x == b).unwrap_or(false);
    let l = targets(&left);
    let r = json!({
        "taken": taken, "refused": refused, "gallery": vt::gallery_asset(os).is_some(),
        "ytSame": same(&t.ytdlp, &yt), "gdlSame": same(&t.gallery, &gd), "ffSame": same(&t.ffmpeg, &ff),
        "marker": std::fs::read_to_string(t.ffmpeg.with_file_name(vt::PACK_MARKER)).unwrap_or_default(),
        "stamp": t.ytdlp.with_file_name("yt-dlp.stamp.json").is_file(),
        "leftNone": !l.ytdlp.exists() && !l.gallery.exists() && !l.ffmpeg.exists(),
        "electronKept": same(&el.join("bin").join(vt::ytdlp_file(os)), &yt),
    });
    for d in [el, ours, left] {
        let _ = std::fs::remove_dir_all(d);
    }
    r
}

/// The cookie row: a hand-over folder with a made-up cookie for the loopback host (one lasting, one session-only, one
/// expired) and its note; imported as at «Bring it now» → what was set, whether the file is gone, the browser's
/// cookies for the loopback page.
fn cookies(app: &AppHandle, base: &str) -> Value {
    let dir = temp("handover");
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::create_dir_all(&dir);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
    let list = json!([
        { "name": COOKIE_NAME, "value": COOKIE_VALUE, "domain": "127.0.0.1", "hostOnly": true, "path": "/h", "secure": false, "httpOnly": true, "expirationDate": now + 86400.0, "sameSite": "lax" },
        { "name": "kt_hybrid_session", "value": "made-up-2", "domain": "127.0.0.1", "hostOnly": true, "path": "/h", "session": true },
        { "name": "kt_hybrid_old", "value": "made-up-3", "domain": "127.0.0.1", "hostOnly": true, "path": "/h", "expirationDate": now - 10.0 }
    ]);
    let body = list.to_string().into_bytes();
    let _ = std::fs::write(dir.join(logic::COOKIE_FILE), &body);
    let _ = std::fs::write(dir.join(logic::COOKIE_NOTE), json!({ "app": "KurokawaTools", "kind": "browser-cookies", "id": "kt-hybrid-id", "count": 3, "size": body.len(), "sha256": sha_hex(&body) }).to_string());
    // (A note for another hand-over: refused, and wiped all the same.)
    let other = temp("handover-other");
    let _ = std::fs::create_dir_all(&other);
    let _ = std::fs::write(other.join(logic::COOKIE_FILE), &body);
    let _ = std::fs::write(other.join(logic::COOKIE_NOTE), json!({ "kind": "browser-cookies", "id": "another", "size": body.len(), "sha256": sha_hex(&body) }).to_string());
    let wrong = crate::cookiecarry::import(app, &other, "kt-hybrid-id");
    let r = crate::cookiecarry::import(app, &dir, "kt-hybrid-id");
    let header = crate::browser::cookie_header(app, &format!("{}/h/page", base));
    let has = |n: &str| header.split(';').any(|p| p.trim().starts_with(&format!("{}=", n)));
    let out = json!({
        "result": r, "wrong": wrong, "gone": !dir.join(logic::COOKIE_FILE).exists() && !dir.join(logic::COOKIE_NOTE).exists(),
        "wrongGone": !other.join(logic::COOKIE_FILE).exists(),
        "inStore": has(COOKIE_NAME) && header.contains(&format!("{}={}", COOKIE_NAME, COOKIE_VALUE)),
        "sessionLeft": !has("kt_hybrid_session"), "expiredLeft": !has("kt_hybrid_old"),
        "api": crate::cookiecarry::can_set(), "readApi": cfg!(kt_cookie_read),
    });
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&other);
    out
}

/// (Self-test only.) { act }: 'state' → how this build closes each loss; 'server' → { base, other }; 'probe' { page,
/// cand } → the header probe as Grab runs it; 'hits' → what reached the other host; 'cookies' → the sign-ins row;
/// 'adopt' → the programs' row.
#[tauri::command]
pub async fn kt_selftest_hybrid(app: AppHandle, o: Value) -> Result<Value, String> {
    if !kurokawa_shell::selftest::active() {
        return Err("not a self-test run".to_string());
    }
    let s = start().ok_or_else(|| "no loopback server".to_string())?;
    let base = format!("http://127.0.0.1:{}", s.port);
    match o.get("act").and_then(|v| v.as_str()).unwrap_or("") {
        "state" => Ok(json!({
            "notice": crate::notifier::last(), "media": crate::mediawatch::how(), "cookieSet": crate::cookiecarry::can_set(),
            "cookieRead": cfg!(kt_cookie_read), "notifyWait": cfg!(kt_notify_wait), "webviewGtk": cfg!(all(kt_webview_gtk, kt_wk_resources)), "wv2": cfg!(feature = "wv2"),
        })),
        "server" => Ok(json!({ "base": base, "other": format!("http://localhost:{}", s.other) })),
        "probe" => {
            let page = o.get("page").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let cand = o.get("cand").cloned().unwrap_or(Value::Null);
            tauri::async_runtime::spawn_blocking(move || crate::mediawatch::selftest_probe(&page, cand)).await.map_err(|e| e.to_string())
        }
        "hits" => Ok(json!(OTHER_HITS.load(Ordering::SeqCst))),
        "cookies" => {
            let a2 = app.clone();
            tauri::async_runtime::spawn_blocking(move || cookies(&a2, &base)).await.map_err(|e| e.to_string())
        }
        "adopt" => Ok(adopt(&base, &app.package_info().version.to_string()).await),
        _ => Err("unknown act".to_string()),
    }
}
