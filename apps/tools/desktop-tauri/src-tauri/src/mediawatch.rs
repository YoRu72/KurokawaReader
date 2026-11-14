// The hybrid's media watch (../../PORTING.md «Closed by the hybrid»): the in-app browser's media found by what the
// server said it is, as Electron's webRequest.onCompleted did (desktop/main.cjs openBrowser's `seen`; the rule is
// gaplogic.rs `classify`, Electron's unchanged). Two ways, each where it can be:
//
//  (a) the web view's own answers, as they come (the original system's piece C — ../../PORTING.md «The original Rust
//      system — piece by piece») — Windows: WebView2's WebResourceResponseReceived (the `wv2` feature, on by default:
//      wry's own webview2-com and windows, resolved once each — build.rs kt_wv2_single). Linux: WebKitGTK's
//      resource-load-started → each resource's response MIME type (the `wkgtk` feature, off until the self-test proves
//      it; webkit2gtk, wry's own version; build.rs finds the calls: kt_webview_gtk, kt_wk_resources). A Mac: none
//      (WKWebView tells no page's responses; PORTING.md says what could).
//  (b) everywhere, and the only way on a Mac and on Windows today: the header probe. At «Grab» the page also lists what
//      its resource timing holds (CAND_JS); the addresses no rule could name — and only those the page itself fetched —
//      are asked their content type: ONE request each (HEAD for what a script fetched, else a GET of the first byte),
//      with the browser's own User-Agent, the page as Referer and the site's cookies — the headers the shell already
//      sends with a download from the browser —, a redirect followed only on the same host, never to another; at most
//      PER_GRAB per Grab, PER_PAGE per page, PER_SECOND started in any second, each address asked once (kept), an
//      address on this computer or the local network only when the page is there too. A site's check page (403, 503)
//      is simply no answer: nothing is retried, no header changed.
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
#[allow(unused_imports)]
use tauri::{AppHandle, Manager};

use crate::gaplogic as logic;

/// The page's resource timing, run beside GRAB_JS (which stays Electron's, unchanged): [[address, initiatorType]…].
pub const CAND_JS: &str = "(function(){try{return performance.getEntriesByType('resource').slice(-400).map(function(r){return [String(r.name),String(r.initiatorType||'')];});}catch(e){return [];}})()";

/// What the web view itself saw: (page, address, kind), newest last.
static SEEN: Mutex<Vec<(String, String, &'static str)>> = Mutex::new(Vec::new());
static PACE: Mutex<Option<logic::Pace>> = Mutex::new(None);
/// How this build watches the browser's answers (the self-test's report).
static HOW: Mutex<&'static str> = Mutex::new("the header probe only");

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn bare(u: &str) -> &str {
    u.split('#').next().unwrap_or(u)
}

/// A response the web view reported: kept when the rule names it (at most 400, as Electron's browserMedia).
#[allow(dead_code)]
pub fn record(page: &str, url: &str, content_type: &str, resource_type: &str) {
    if let Some(kind) = logic::classify(url, content_type, resource_type) {
        let mut g = match SEEN.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if g.iter().any(|(p, u, _)| p == bare(page) && u == url) {
            return;
        }
        g.push((bare(page).to_string(), url.to_string(), kind));
        let n = g.len();
        if n > 400 {
            g.drain(0..n - 400);
        }
    }
}

/// (Self-test) what the web view itself reported on `page` (way a, not the probe): [[address, kind]…].
pub fn seen_on(page: &str) -> Vec<(String, &'static str)> {
    let g = match SEEN.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    g.iter().filter(|(p, _, _)| p == bare(page)).map(|(_, u, k)| (u.clone(), *k)).collect()
}

/// Whether this build watches the web view's own answers (the original system's piece C compiled in).
pub fn watch_built() -> bool {
    cfg!(any(all(windows, feature = "wv2", kt_wv2_single), all(target_os = "linux", feature = "wkgtk", kt_webview_gtk, kt_wk_resources)))
}

/// How the browser's answers are watched here.
pub fn how() -> &'static str {
    HOW.lock().map(|g| *g).unwrap_or("the header probe only")
}

/// The browser window `label` made: its answers watched where the web view tells them (way a).
pub fn attach(app: &AppHandle, label: &str) {
    #[cfg(all(target_os = "linux", feature = "wkgtk", kt_webview_gtk, kt_wk_resources))]
    {
        if let Some(w) = app.get_webview_window(label) {
            let ok = w
                .with_webview(|pw| {
                    use webkit2gtk::{URIResponseExt, WebResourceExt, WebViewExt};
                    let wv = pw.inner();
                    let _ = wv.connect_resource_load_started(|view, res, _req| {
                        let page = view.uri().map(|s| s.to_string()).unwrap_or_default();
                        let _ = res.connect_finished(move |r| {
                            if let Some(resp) = r.response() {
                                let ct = resp.mime_type().map(|s| s.to_string()).unwrap_or_default();
                                let url = resp.uri().map(|s| s.to_string()).or_else(|| r.uri().map(|s| s.to_string())).unwrap_or_default();
                                record(&page, &url, &ct, "");
                            }
                        });
                    });
                })
                .is_ok();
            if ok {
                if let Ok(mut g) = HOW.lock() {
                    *g = "WebKitGTK's responses, and the header probe";
                }
            }
        }
    }
    #[cfg(all(windows, feature = "wv2", kt_wv2_single))]
    {
        if let Some(w) = app.get_webview_window(label) {
            if w.with_webview(wv2_watch).is_ok() {
                if let Ok(mut g) = HOW.lock() {
                    *g = "WebView2's responses, and the header probe";
                }
            }
        }
    }
    let _ = (app, label);
}

/// (Windows, the `wv2` feature) WebView2's WebResourceResponseReceived → record.
#[cfg(all(windows, feature = "wv2", kt_wv2_single))]
fn wv2_watch(pw: tauri::webview::PlatformWebview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2;
    use windows::core::{Interface, PWSTR};
    unsafe {
        let core = match pw.controller().CoreWebView2() {
            Ok(c) => c,
            Err(_) => return,
        };
        let core2: ICoreWebView2_2 = match core.cast() {
            Ok(c) => c,
            Err(_) => return,
        };
        let handler = webview2_com::WebResourceResponseReceivedEventHandler::create(Box::new(move |sender, args| {
            let (sender, args) = match (sender, args) {
                (Some(s), Some(a)) => (s, a),
                _ => return Ok(()),
            };
            let mut src = PWSTR::null();
            let page = if sender.Source(&mut src).is_ok() { webview2_com::take_pwstr(src) } else { String::new() };
            let mut u = PWSTR::null();
            args.Request()?.Uri(&mut u)?;
            let url = webview2_com::take_pwstr(u);
            let mut v = PWSTR::null();
            let ct = match args.Response().and_then(|r| r.Headers()) {
                Ok(h) if h.GetHeader(windows::core::w!("Content-Type"), &mut v).is_ok() => webview2_com::take_pwstr(v),
                _ => String::new(),
            };
            record(&page, &url, &ct, "");
            Ok(())
        }));
        let mut token = Default::default();
        let _ = core2.add_WebResourceResponseReceived(&handler, &mut token);
    }
}

fn client() -> Option<&'static reqwest::Client> {
    static C: std::sync::OnceLock<Option<reqwest::Client>> = std::sync::OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::custom(|a| {
                let from = a.previous().first().map(|u| u.as_str().to_string()).unwrap_or_default();
                let hops = a.previous().len().saturating_sub(1);
                if logic::redirect_ok(&from, a.url().as_str(), hops) {
                    a.follow()
                } else {
                    a.stop()
                }
            }))
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(8))
            .build()
            .ok()
    })
    .as_ref()
}

/// One address asked its content type → (status, content type); Err for no answer.
pub fn probe_one(c: &logic::Candidate, page: &str, ua: &str, cookie: &str) -> Result<(u16, String), String> {
    let cl = client().ok_or_else(|| "no web client".to_string())?;
    let mut rb = match c.how {
        logic::ProbeHow::Head => cl.head(c.url.as_str()),
        logic::ProbeHow::FirstByte => cl.get(c.url.as_str()).header("range", "bytes=0-0"),
    };
    if !ua.is_empty() {
        rb = rb.header("user-agent", ua);
    }
    if !page.is_empty() {
        rb = rb.header("referer", page);
    }
    rb = rb.header("accept", "*/*");
    if !cookie.is_empty() {
        rb = rb.header("cookie", cookie);
    }
    let fut = async move {
        let r = rb.send().await.map_err(|e| e.to_string())?;
        let st = r.status().as_u16();
        let ct = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        // (The body is never read: one byte at most was asked for.)
        drop(r);
        Ok::<(u16, String), String>((st, ct))
    };
    tauri::async_runtime::block_on(fut)
}

/// Grab's answer `page` ({ url, links, cand, … }, browser.rs, off the main thread) completed: what the web view saw on
/// this page added to its links (as Electron added its browserMedia), then the other addresses its resource timing
/// lists asked their content type (way b); `cand` taken off. `ua`: the browser's User-Agent; `cookie_for(url)`: the
/// site's cookies as the browser holds them. Returns how many links were added.
pub fn complete(page: &mut Value, ua: &str, cookie_for: &dyn Fn(&str) -> String) -> usize {
    let cand: Vec<(String, String)> = page
        .as_object_mut()
        .and_then(|o| o.remove("cand"))
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|x| {
            let a = x.as_array()?;
            Some((a.first()?.as_str()?.to_string(), a.get(1).and_then(|v| v.as_str()).unwrap_or("").to_string()))
        })
        .take(400)
        .collect();
    let url = page.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut known: Vec<String> = page.get("links").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|l| l.get("href").and_then(|h| h.as_str()).map(String::from)).collect()).unwrap_or_default();
    let mut add: Vec<(String, &'static str)> = Vec::new();
    // (a) What the web view saw on this page.
    {
        let g = match SEEN.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        for (p, u, k) in g.iter() {
            if p == bare(&url) && !known.contains(u) {
                known.push(u.clone());
                add.push((u.clone(), *k));
            }
        }
    }
    // (b) The header probe: answers kept from before first, then the new ones, paced.
    let list: Vec<logic::Candidate> = {
        let mut g = match PACE.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let pace = g.get_or_insert_with(logic::Pace::default);
        for (u, _) in cand.iter() {
            if let Some(Some(k)) = pace.known(u) {
                if !known.contains(u) {
                    known.push(u.clone());
                    add.push((u.clone(), k));
                }
            }
        }
        let k2 = known.clone();
        let is_known = move |u: &str| k2.iter().any(|x| x == u);
        let asked = |u: &str| pace.known(u).is_some();
        logic::probe_candidates(&url, &cand, &is_known, &asked, logic::PER_GRAB)
    };
    let until = now_ms() + 9000;
    for c in list.iter() {
        if now_ms() > until {
            break;
        }
        let wait = {
            let mut g = match PACE.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            g.get_or_insert_with(logic::Pace::default).wait_ms(now_ms())
        };
        if wait > 0 {
            std::thread::sleep(Duration::from_millis(wait.min(1000)));
        }
        let started = {
            let mut g = match PACE.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            g.get_or_insert_with(logic::Pace::default).start(bare(&url), now_ms())
        };
        if !started {
            break;
        }
        let kind = match probe_one(c, &url, ua, &cookie_for(&c.url)) {
            Ok((st, ct)) => logic::probe_kind(st, &c.url, &ct),
            Err(_) => None,
        };
        if let Ok(mut g) = PACE.lock() {
            g.get_or_insert_with(logic::Pace::default).keep(&c.url, kind);
        }
        if let Some(k) = kind {
            add.push((c.url.clone(), k));
        }
    }
    let n = add.len();
    if n > 0 {
        if let Some(links) = page.get_mut("links").and_then(|v| v.as_array_mut()) {
            for (u, k) in add.into_iter() {
                links.push(json!({ "href": u, "text": "", "kind": k }));
            }
        }
    }
    n
}

/// (Self-test) the probe run on a list as Grab would → { added, links }.
pub fn selftest_probe(page_url: &str, cand: Value) -> Value {
    let mut page = json!({ "url": page_url, "links": [], "cand": cand });
    let added = complete(&mut page, "KurokawaTools-selftest", &|_| String::new());
    json!({ "added": added, "links": page.get("links").cloned().unwrap_or(Value::Null), "how": how() })
}
