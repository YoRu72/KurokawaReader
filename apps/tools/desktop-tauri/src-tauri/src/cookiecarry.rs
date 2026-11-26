// The hybrid's sign-ins carried (../../PORTING.md «Closed by the hybrid»): the in-app browser's cookies the last
// Electron build exported into the hand-over (tests/support/bridge-handover.cjs (frozen) exportCookies, behind RUST_SWITCH: those that
// outlive the session, in browser-cookies.json — this user's only — with a note naming the hand-over's id, their count
// and the file's SHA-256) put into this build's browser cookie store when the person takes the hand-over
// (kt_handover_mark «restored»), then the file overwritten and deleted. Deleted unread when the hand-over is declined
// or found damaged, and at a later start when its hand-over was taken or declined before, or is older than 14 days.
//
// The store: Tauri's Webview::set_cookie on the browser's keeper window (its own profile — Windows, Linux) or the main
// window (a Mac's browser shares the app's store), each cookie read from its Set-Cookie line (gaplogic.rs
// set_cookie_line; the cookie crate's FromStr) — where build.rs found both (kt_cookie_set, kt_cookie_fromstr); without
// them nothing is set, the file is still deleted, and the sites ask to sign in again as before. Cookie values are never
// logged or answered; only counts.
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::gaplogic as logic;

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Whether this build can put cookies into the browser's store.
pub fn can_set() -> bool {
    cfg!(all(kt_cookie_set, kt_cookie_fromstr))
}

/// The cookie file and its note of hand-over folder `dir` wiped (overwritten, flushed, deleted) → whether there was one.
pub fn drop_file(dir: &Path) -> bool {
    let f = dir.join(logic::COOKIE_FILE);
    let had = f.exists();
    let _ = logic::wipe(&f);
    let _ = logic::wipe(&dir.join(logic::COOKIE_NOTE));
    had
}

fn read_json(p: &Path) -> Option<Value> {
    std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok())
}

/// The handed cookies of `dir`, checked: the note names hand-over `id`, the file's size and SHA-256 are the note's.
fn read(dir: &Path, id: &str) -> Result<Vec<logic::HandedCookie>, String> {
    let note = read_json(&dir.join(logic::COOKIE_NOTE)).ok_or_else(|| "no note".to_string())?;
    if note.get("kind").and_then(|v| v.as_str()) != Some("browser-cookies") || note.get("id").and_then(|v| v.as_str()) != Some(id) {
        return Err("the note is not this hand-over's".to_string());
    }
    let f = dir.join(logic::COOKIE_FILE);
    let bytes = std::fs::read(&f).map_err(|e| e.to_string())?;
    if note.get("size").and_then(|v| v.as_u64()) != Some(bytes.len() as u64) {
        return Err("its size is not the note's".to_string());
    }
    let sha = {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(&bytes);
        kurokawa_shell::util::hex(h.finalize().as_slice())
    };
    if Some(sha.as_str()) != note.get("sha256").and_then(|v| v.as_str()) {
        return Err("its contents changed".to_string());
    }
    let list: Vec<Value> = serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| v.as_array().cloned()).ok_or_else(|| "not a list".to_string())?;
    let s = |c: &Value, k: &str| c.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let b = |c: &Value, k: &str| c.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
    Ok(list
        .iter()
        .take(10_000)
        .map(|c| logic::HandedCookie {
            name: s(c, "name"),
            value: s(c, "value"),
            domain: s(c, "domain"),
            host_only: b(c, "hostOnly"),
            path: s(c, "path"),
            secure: b(c, "secure"),
            http_only: b(c, "httpOnly"),
            session: b(c, "session"),
            expires: c.get("expirationDate").and_then(|v| v.as_f64()).unwrap_or(0.0),
            same_site: s(c, "sameSite"),
        })
        .collect())
}

/// Hand-over `dir` (id `id`) taken: its cookies put into the browser's store, then the file wiped — whatever happened.
/// Blocking (the web view's cookie calls must not run on the main thread) → { set, skipped, failed, api, why? }.
pub fn import(app: &AppHandle, dir: &Path, id: &str) -> Value {
    let r = import_here(app, dir, id);
    drop_file(dir);
    r
}

fn import_here(app: &AppHandle, dir: &Path, id: &str) -> Value {
    if !dir.join(logic::COOKIE_FILE).exists() {
        return json!({ "set": 0, "skipped": 0, "failed": 0, "api": can_set(), "why": "none handed over" });
    }
    let list = match read(dir, id) {
        Ok(l) => l,
        Err(e) => return json!({ "set": 0, "skipped": 0, "failed": 0, "api": can_set(), "why": e }),
    };
    let now = now_secs();
    let lines: Vec<String> = list.iter().filter_map(|c| logic::set_cookie_line(c, now)).collect();
    let skipped = list.len() - lines.len();
    let (set, failed) = put(app, &lines);
    json!({ "set": set, "skipped": skipped, "failed": failed, "api": can_set() })
}

/// (Self-test: the original system's measurement of a domain cookie) Set-Cookie lines put as the hand-over puts them.
pub fn put_lines(app: &AppHandle, lines: &[String]) -> (usize, usize) {
    put(app, lines)
}

/// (Self-test) the cookies the browser's store lists for `url` → (name, value, domain as stored): the store window's
/// own (a Mac's main window; the keeper elsewhere) — on a Mac every cookie, unfiltered (WKWebView's own match is exact).
pub fn store_list(app: &AppHandle, url: &str) -> Option<Vec<(String, String, String)>> {
    #[cfg(kt_cookie_read)]
    {
        use tauri::Manager;
        let w = crate::browser::store_window(app).and_then(|l| app.get_webview_window(&l))?;
        #[cfg(all(target_os = "macos", kt_cookie_all))]
        let listed = {
            let _ = url;
            w.cookies().ok()?
        };
        #[cfg(not(all(target_os = "macos", kt_cookie_all)))]
        let listed = w.cookies_for_url(url.parse().ok()?).ok()?;
        return Some(listed.iter().map(|c| (c.name().to_string(), c.value().to_string(), c.domain().unwrap_or("").to_string())).collect());
    }
    #[allow(unreachable_code)]
    {
        let _ = (app, url);
        None
    }
}

/// Set-Cookie lines into the browser's store → (set, failed).
#[cfg(all(kt_cookie_set, kt_cookie_fromstr))]
fn put(app: &AppHandle, lines: &[String]) -> (usize, usize) {
    use tauri::Manager;
    let w = match crate::browser::store_window(app).and_then(|l| app.get_webview_window(&l)) {
        Some(w) => w,
        None => return (0, lines.len()),
    };
    let (mut set, mut failed) = (0usize, 0usize);
    for l in lines.iter() {
        let parsed = l.parse();
        let ok = match parsed {
            Ok(c) => w.set_cookie(c).is_ok(),
            Err(_) => false,
        };
        if ok {
            set += 1;
        } else {
            failed += 1;
        }
    }
    (set, failed)
}

#[cfg(not(all(kt_cookie_set, kt_cookie_fromstr)))]
fn put(_app: &AppHandle, lines: &[String]) -> (usize, usize) {
    (0, lines.len())
}

/// At a start: cookie files left in hand-overs this build took or declined before, or older than 14 days, wiped.
/// `dirs`: the hand-over folders where the Electron build leaves them; `taken`: the id this build's state names.
pub fn tidy(dirs: &[PathBuf], taken: Option<&str>) {
    let now_ms = now_secs() * 1000;
    for d in dirs.iter() {
        if !d.join(logic::COOKIE_FILE).exists() && !d.join(logic::COOKIE_NOTE).exists() {
            continue;
        }
        let m = read_json(&d.join("marker.json"));
        let id = m.as_ref().and_then(|m| m.get("id")).and_then(|v| v.as_str()).unwrap_or("");
        let at = m.as_ref().and_then(|m| m.get("createdAt")).and_then(|v| v.as_u64()).unwrap_or(0);
        if m.is_none() || taken == Some(id) || now_ms.saturating_sub(at) > 14 * 86_400_000 {
            drop_file(d);
        }
    }
}
