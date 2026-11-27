// Stage P7: the in-app browser (kt:browse; desktop/main.cjs's openBrowser) — a window of its own, adapted from the
// Reader's browser.rs with its lessons (apps/reader/desktop-tauri/PORTING.md, «The in-app browser»): its own profile
// on Windows and Linux (`<app local data>/browser`) kept alive by a hidden keeper window while the app runs; a site's
// new windows kept in this one; the channel that brings the page's answers back (kurokawa_shell::browserlogic — the
// Reader's, moved into the shared crate: https://kr-lane.invalid/<nonce>/… addresses refused by the navigation
// handler, one message at a time, each acknowledged; on a Mac in 24 KiB pieces); a Mac's cookies matched by RFC 6265's
// domain rule; on Linux only the keeper catches downloads (WebKitGTK's first handler decides).
//
// What it does, as Electron's: a magnet the page goes to or opens, and a file it downloads, go to the app (kt:browser
// {kind:'download', url, name, referer, ua, cookie}: the Add sheet), the web view's own download cancelled; «Grab»
// (the bar's button, Ctrl+G) runs main.cjs's GRAB_JS unchanged and hands {kind:'links', url, title, links, ua} to the
// app; «Copy address» (Ctrl+L) and «Open in the system's browser»; back / forward / reload (Alt+← / Alt+→ / F5); the
// window titled «<page> — Kurokawa Tools». The browser's cookies of a site are put in the app's own jar when a download
// or a grab is handed over (Electron's one session).
//
// What differs, said plainly: Electron's bar is the window's menu; here a small bar floats in a corner of the page (a
// closed shadow root), in the interface's words (the page's desktopPrefs labels). Electron also listed what the page
// loaded by the answers' content types (webRequest.onCompleted); here «Grab» has what GRAB_JS finds (elements, links,
// the page's resource timing — the media it loaded by address) and, the hybrid's (mediawatch.rs), what WebKitGTK saw
// on Linux and the header probe's answers for the page's other addresses everywhere.
// A site's own scripts can see the channel's token (it lives in their page), so they can send what the page sends —
// a title — and nothing else: the bar's commands carry a second token that lives only inside the bar's closure, and a
// grab's answer is taken only when asked for.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use kurokawa_shell::browserlogic as logic;
use kurokawa_shell::net;

const PREFIX: &str = "ktb-";

/// main.cjs's GRAB_JS, unchanged (an expression: the page's links and media).
const GRAB_JS: &str = include_str!("grab.js");

static SEQ: AtomicU64 = AtomicU64::new(1);

struct Win {
    label: String,
    nonce: String,
    /// The bar's own token (never on the page's window object).
    cmd: String,
    parts: Mutex<HashMap<String, logic::Assembly>>,
    /// The grab answers asked for.
    pending: Mutex<Vec<String>>,
}

impl Win {
    fn key(&self) -> String {
        format!("__kt{}", self.nonce)
    }
}

static BROWSER: Mutex<Option<Arc<Win>>> = Mutex::new(None);
static KEEPER: Mutex<Option<String>> = Mutex::new(None);
static UA: Mutex<String> = Mutex::new(String::new());
/// (Self-test) what was handed to the app, last first.
static HANDED: Mutex<Vec<Value>> = Mutex::new(Vec::new());

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

fn js_str(s: &str) -> String {
    Value::String(s.to_string()).to_string()
}

/// (Windows, Linux) the browser's own profile, apart from the app's page.
#[allow(dead_code)]
fn profile_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join("browser"))
}

/// The keeper: on Windows WebView2 ends a profile's browser process (and its session cookies) with its last window;
/// on Linux it is the one window whose download handler WebKitGTK asks (see the Reader's PORTING.md, R4b).
const KEEPS_PROFILE: bool = cfg!(any(target_os = "windows", target_os = "linux"));

/* ---------- the page's scripts ---------- */

/// The channel's sender, by addresses only (the Reader's SENDER_JS «nav» way: a site's page gets no IPC here).
const SENDER_JS: &str = r#"(function(K,N,CH){var w=window;if(w[K])return w[K];var q=[],cur=null,tm=0,siteAt=0,ours=false;
try{w.addEventListener('beforeunload',function(e){if(ours)e.stopImmediatePropagation();else siteAt=Date.now();},true);}catch(e){}
function b64u(u8){var s='';for(var j=0;j<u8.length;j+=8192)s+=String.fromCharCode.apply(null,u8.subarray(j,j+8192));return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function next(){if(cur||!q.length)return;cur=q.shift();fire();}
function fire(){clearTimeout(tm);var c=cur;if(!c)return;if(Date.now()-siteAt<8000){tm=setTimeout(fire,500);return;}ours=true;try{w.location.href=c.u;}catch(e){}ours=false;tm=setTimeout(function(){if(cur!==c)return;if(++c.t<8)fire();else{cur=null;next();}},2000);}
var api={send:function(rid,meta,body,kind){if(kind)q=q.filter(function(x){return x.k!==kind;});var n=body?Math.ceil(body.length/CH):0,total=1+n,base='https://kr-lane.invalid/'+N+'/'+rid+'/';
q.push({u:base+'0/'+total+'?'+b64u(new TextEncoder().encode(JSON.stringify(meta))),t:0,id:rid+'/0',k:kind||''});
for(var i=0;i<n;i++)q.push({u:base+(i+1)+'/'+total+'?'+b64u(body.subarray(i*CH,(i+1)*CH)),t:0,id:rid+'/'+(i+1),k:''});next();},
ack:function(id){if(cur&&cur.id===id){clearTimeout(tm);cur=null;next();}}};
try{Object.defineProperty(w,K,{value:api});}catch(e){w[K]=api;}return api;})"#;

/// Every page, before the site's own scripts: new windows kept here (a magnet one goes to the app through the
/// navigation handler), the bar, the title (with the browser's user agent) sent when it changes.
const INIT_JS: &str = r#"(function(){if(window.top!==window)return;var S=__S__;var CMD=__CMD__;var C=__C__;
try{window.open=function(u){var ua=navigator.userActivation;if(ua&&!ua.isActive)return null;try{if(u)location.assign(new URL(String(u),location.href).href);}catch(e){}return null;};}catch(e){}
function away(t){t=String(t||'').toLowerCase();return !!t&&t!=='_self'&&t!=='_top'&&t!=='_parent';}
document.addEventListener('click',function(ev){var a=ev.target&&ev.target.closest?ev.target.closest('a[target]'):null;if(!a||!away(a.getAttribute('target'))||a.hasAttribute('download'))return;var to=a.href;if(!/^(https?|magnet):/i.test(to))return;ev.preventDefault();location.assign(to);},true);
document.addEventListener('submit',function(ev){var f=ev.target;if(f&&away(f.getAttribute&&f.getAttribute('target')))f.setAttribute('target','_self');},true);
function cmd(a){S.send('c'+Date.now().toString(36)+Math.floor(Math.random()*1e6).toString(36),{act:a,k:CMD},null,'c');}
function addr(v){v=String(v||'').trim();if(!v)return null;if(/^(https?|magnet):/i.test(v))return v;if(!/\s/.test(v)){var h=v.split(/[\/?#]/)[0];if(/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])(:\d{1,5})?$/i.test(h))return 'http://'+v;var m=/^(?:[\p{L}\p{N}-]+\.)+([\p{L}\p{N}-]{2,})(?::\d{1,5})?$/u.exec(h);if(m&&/\p{L}/u.test(m[1]))return 'https://'+v;}return 'https://duckduckgo.com/?q='+encodeURIComponent(v);}
var FX=/\.(m3u8|mpd|mp4|mkv|webm|m4v|mov|mp3|m4a|flac|ogg|opus|aac|wav|zip|7z|rar|apk|pdf|epub|torrent)(\?|#|$)/i;
function found(){var s={},n=0;function a(u){if(!u||/^(blob|data):/.test(u)||s[u])return;s[u]=1;n++;}
document.querySelectorAll('video,audio').forEach(function(v){if(v.getAttribute('src'))a(v.src);v.querySelectorAll('source[src]').forEach(function(x){a(x.src);});});
document.querySelectorAll('a[href]').forEach(function(x){if(FX.test(x.href))a(x.href);});
try{performance.getEntriesByType('resource').forEach(function(r){if(/\.(m3u8|mpd)(\?|$)/i.test(r.name)||r.initiatorType==='video'||r.initiatorType==='audio')a(r.name.split('#')[0]);});}catch(e){}return n;}
var CSS='form{display:flex;align-items:center;gap:2px;height:48px;padding:0 4px;box-sizing:border-box;border-radius:22px;background:#f3f1f6;color:#1c1b1f;box-shadow:0 2px 10px rgba(0,0,0,.28);font:14px system-ui,"Segoe UI",sans-serif;user-select:none}'
+'button{all:unset;min-width:40px;height:40px;padding:0 8px;box-sizing:border-box;border-radius:20px;display:grid;place-items:center;cursor:pointer;font-size:16px;line-height:1;white-space:nowrap}'
+'button:hover{background:rgba(0,0,0,.08)}button:disabled{opacity:.35;cursor:default;background:none}'
+'input{width:180px;height:36px;border-radius:18px;border:1px solid #c9c5d0;background:#fff;color:inherit;padding:0 12px;font:inherit;outline:none;direction:ltr;text-align:left;transition:width .15s}'
+'input:focus{width:320px;border-color:#6750a4;box-shadow:0 0 0 1px #6750a4}'
+'@media (prefers-color-scheme:dark){form{background:#1d1b20;color:#e6e1e5}button:hover{background:rgba(255,255,255,.1)}input{background:#2b2930;border-color:#49454f}}'
+'@media (max-width:620px){input{width:100px}input:focus{width:180px}}';
function bar(){var root=document.documentElement;if(!root||document.getElementById('kt-browser-bar'))return;
var host=document.createElement('kt-browser-bar');host.id='kt-browser-bar';host.style.cssText='all:initial;position:fixed;z-index:2147483647;bottom:12px;'+(C.rtl?'right':'left')+':12px;';
var r=host.attachShadow({mode:'closed'});var st=document.createElement('style');st.textContent=CSS;r.appendChild(st);
var f=document.createElement('form');f.dir=C.rtl?'rtl':'ltr';r.appendChild(f);
function btn(t,x,fn){var b=document.createElement('button');b.type='button';b.title=t||'';b.setAttribute('aria-label',t||'');b.textContent=x;b.onclick=fn;f.appendChild(b);return b;}
var bk=btn(C.back,C.rtl?'→':'←',function(){history.back();});var fw=btn(C.forward,C.rtl?'←':'→',function(){history.forward();});btn(C.reload,'↻',function(){location.reload();});
var a=document.createElement('input');a.spellcheck=false;a.autocomplete='off';a.placeholder=C.address||'';a.value=location.href;f.appendChild(a);
var gb=btn(C.grab,'⤓',function(){cmd('grab');});var gn=-1;btn(C.copy,'⧉',function(){cmd('copy');});btn(C.external,'↗',function(){cmd('external');});
a.onfocus=function(){setTimeout(function(){a.select();},0);};f.onsubmit=function(e){e.preventDefault();var to=addr(a.value);if(to)location.assign(to);a.blur();};
var nv=window.navigation;function upd(){if(document.activeElement!==host)a.value=location.href;if(nv&&'canGoBack' in nv){bk.disabled=!nv.canGoBack;fw.disabled=!nv.canGoForward;}
var n=0;try{n=found();}catch(e){}if(n!==gn){gn=n;gb.textContent=n?'⤓ '+n:'⤓';gb.title=n?C.grab+' · '+n:C.grab;gb.setAttribute('aria-label',gb.title);}}
root.appendChild(host);upd();setInterval(function(){if(!host.isConnected&&document.documentElement)document.documentElement.appendChild(host);upd();},1000);}
(function early(){if(document.documentElement)bar();else setTimeout(early,100);})();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bar);
document.addEventListener('keydown',function(e){var k=String(e.key||'').toLowerCase();
if(e.altKey&&!e.ctrlKey&&!e.metaKey){if(e.key==='ArrowLeft'){e.preventDefault();history.back();}else if(e.key==='ArrowRight'){e.preventDefault();history.forward();}return;}
if((e.ctrlKey||e.metaKey)&&!e.altKey&&!e.shiftKey){if(k==='g'){e.preventDefault();cmd('grab');}else if(k==='l'){e.preventDefault();cmd('copy');}}
else if(e.key==='F5'&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();location.reload();}},true);
var lastT='';function title(){var t=document.title||location.href;if(t===lastT)return;lastT=t;S.send('t'+Date.now().toString(36)+Math.floor(Math.random()*1e6).toString(36),{title:t.slice(0,200),ua:navigator.userAgent},null,'t');}
setInterval(title,1000);if(document.readyState!=='loading')title();else document.addEventListener('DOMContentLoaded',title);})();"#;

fn sender_call(win: &Win) -> String {
    let chunk = if cfg!(target_os = "macos") { logic::CHUNK_SMALL } else { logic::CHUNK };
    format!("{}({},{},{})", SENDER_JS, js_str(&win.key()), js_str(&win.nonce), chunk)
}

/// The bar's words: the page's (desktopPrefs labels), English when it sent none.
fn bar_words() -> Value {
    let w = |k: &str, en: &str| crate::desktop::label(k, en);
    json!({
        "back": w("browserBack", "Back"), "forward": w("browserForward", "Forward"), "reload": w("browserReload", "Reload"),
        "address": w("browserAddress", "Address or search"), "grab": w("browserGrab", "Grab links"),
        "copy": w("browserCopy", "Copy address"), "external": w("browserExternal", "Open in the system's browser"),
        "rtl": crate::desktop::label("rtl", "") == "1",
    })
}

fn init_script(win: &Win) -> String {
    INIT_JS.replace("__S__", &sender_call(win)).replace("__CMD__", &js_str(&win.cmd)).replace("__C__", &bar_words().to_string())
}

/* ---------- to the app ---------- */

/// main.cjs's toApp: the page told (kt:browser), the main window brought back.
fn to_app(app: &AppHandle, o: Value) {
    {
        let mut h = lock(&HANDED);
        h.insert(0, o.clone());
        h.truncate(20);
    }
    let _ = app.emit("kt:browser", o);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// The browser's cookies of the site of `url` as a Cookie header, also put in the app's own jar (Electron's one
/// session). Called off the main thread (WebView2 deadlocks a cookie call made on it). "" where Tauri lists none.
fn site_cookies(app: &AppHandle, url: &str) -> String {
    #[cfg(kt_cookie_read)]
    {
        let host = match logic::host_of(url) {
            Some(h) => h,
            None => return String::new(),
        };
        let secure = url.starts_with("https:");
        let label = lock(&BROWSER).as_ref().map(|w| w.label.clone()).or_else(|| lock(&KEEPER).clone());
        let w = match label.and_then(|l| app.get_webview_window(&l)) {
            Some(w) => w,
            None => return String::new(),
        };
        // (A Mac: every cookie, matched here — WKWebView's own match is exact, see the Reader's R4b.)
        #[cfg(all(target_os = "macos", kt_cookie_all))]
        let listed = w.cookies().ok().map(|l| l.into_iter().filter(|c| logic::cookie_for_host(&host, c.domain().unwrap_or(""))).collect::<Vec<_>>());
        #[cfg(not(all(target_os = "macos", kt_cookie_all)))]
        let listed = match url.parse() {
            Ok(u) => w.cookies_for_url(u).ok(),
            Err(_) => None,
        };
        let mut pairs: Vec<String> = Vec::new();
        for c in listed.unwrap_or_default().iter() {
            pairs.push(format!("{}={}", c.name(), c.value()));
            let _ = net::put_cookie(&c.to_string(), &host, secure);
        }
        return pairs.join("; ");
    }
    #[cfg(not(kt_cookie_read))]
    {
        let _ = (app, url);
        String::new()
    }
}

/// The browser's cookies of the site of `url`, each with what yt-dlp's cookie file keeps (vtools.rs writes them for a
/// sign-in kept per site). Off the main thread. None where this build cannot read the store (kt_cookie_read unset) —
/// the sign-in then is not kept and yt-dlp runs as before. The expiry is not read (0: yt-dlp keeps such a cookie).
pub fn cookie_list(app: &AppHandle, url: &str) -> Vec<kt_core::videotools::NsCookie> {
    #[cfg(kt_cookie_read)]
    {
        let host = match logic::host_of(url) {
            Some(h) => h,
            None => return Vec::new(),
        };
        let label = lock(&BROWSER).as_ref().map(|w| w.label.clone()).or_else(|| lock(&KEEPER).clone());
        let w = match label.and_then(|l| app.get_webview_window(&l)) {
            Some(w) => w,
            None => return Vec::new(),
        };
        #[cfg(all(target_os = "macos", kt_cookie_all))]
        let listed = w.cookies().ok().map(|l| l.into_iter().filter(|c| logic::cookie_for_host(&host, c.domain().unwrap_or(""))).collect::<Vec<_>>());
        #[cfg(not(all(target_os = "macos", kt_cookie_all)))]
        let listed = match url.parse() {
            Ok(u) => w.cookies_for_url(u).ok(),
            Err(_) => None,
        };
        return listed
            .unwrap_or_default()
            .iter()
            .map(|c| kt_core::videotools::NsCookie {
                domain: c.domain().map(|d| d.to_string()).unwrap_or_else(|| host.clone()),
                path: c.path().unwrap_or("/").to_string(),
                secure: c.secure().unwrap_or(false),
                http_only: c.http_only().unwrap_or(false),
                expires: 0,
                name: c.name().to_string(),
                value: c.value().to_string(),
            })
            .collect();
    }
    #[cfg(not(kt_cookie_read))]
    {
        let _ = (app, url);
        Vec::new()
    }
}

fn current_url(app: &AppHandle) -> String {
    let label = lock(&BROWSER).as_ref().map(|w| w.label.clone());
    label.and_then(|l| app.get_webview_window(&l)).and_then(|w| w.url().ok()).map(|u| u.to_string()).unwrap_or_default()
}

/// A download or a magnet handed to the app (off the main thread: the cookies are asked of the web view).
fn hand_download(app: &AppHandle, url: String, name: String) {
    let app = app.clone();
    std::thread::spawn(move || {
        let referer = current_url(&app);
        let mut o = json!({ "kind": "download", "url": url });
        if !url.to_ascii_lowercase().starts_with("magnet:") {
            if !name.is_empty() {
                o["name"] = json!(name);
            }
            if !referer.is_empty() {
                o["referer"] = json!(referer);
            }
            let ua = lock(&UA).clone();
            if !ua.is_empty() {
                o["ua"] = json!(ua);
            }
            let c = site_cookies(&app, &url);
            if !c.is_empty() {
                o["cookie"] = json!(c);
            }
        }
        to_app(&app, o);
    });
}

/* ---------- the channel's Rust side ---------- */

fn eval_in(app: &AppHandle, label: &str, js: &str) -> bool {
    match app.get_webview_window(label) {
        Some(w) => w.eval(js).is_ok(),
        None => false,
    }
}

/// A whole message from the page.
fn handle(app: &AppHandle, win: &Arc<Win>, rid: &str, meta: Value, body: Vec<u8>) {
    match rid.chars().next() {
        Some('t') => {
            if let Some(ua) = meta.get("ua").and_then(|v| v.as_str()) {
                *lock(&UA) = ua.chars().take(400).collect();
            }
            if let Some(t) = meta.get("title").and_then(|v| v.as_str()) {
                let t: String = t.chars().take(200).collect();
                let (app, label) = (app.clone(), win.label.clone());
                std::thread::spawn(move || {
                    if let Some(w) = app.get_webview_window(&label) {
                        let _ = w.set_title(&format!("{} — Kurokawa Tools", t));
                    }
                });
            }
        }
        Some('c') => {
            if meta.get("k").and_then(|v| v.as_str()) != Some(win.cmd.as_str()) {
                return;
            }
            let act = meta.get("act").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let (app, win) = (app.clone(), win.clone());
            std::thread::spawn(move || command(&app, &win, &act));
        }
        Some('g') => {
            {
                let mut p = lock(&win.pending);
                if !p.iter().any(|x| x == rid) {
                    return;
                }
                p.retain(|x| x != rid);
            }
            let page: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            if !page.is_object() {
                return;
            }
            if let Some(ua) = page.get("ua").and_then(|v| v.as_str()) {
                *lock(&UA) = ua.chars().take(400).collect();
            }
            let app = app.clone();
            std::thread::spawn(move || {
                let url = page.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let _ = site_cookies(&app, &url);
                let mut o = page;
                // (The hybrid: media the server named only by its content type — what the web view saw, then the header
                // probe of the page's other addresses; mediawatch.rs. Its list `cand` is taken off here.)
                let ua = lock(&UA).clone();
                crate::mediawatch::complete(&mut o, &ua, &|u: &str| site_cookies(&app, u));
                o["kind"] = json!("links");
                to_app(&app, o);
            });
        }
        _ => {}
    }
}

/// The bar's commands: grab, copy the address, open it in the system's browser.
fn command(app: &AppHandle, win: &Arc<Win>, act: &str) {
    match act {
        "grab" => {
            let rid = format!("g{}", SEQ.fetch_add(1, Ordering::SeqCst));
            {
                let mut p = lock(&win.pending);
                p.push(rid.clone());
                let n = p.len();
                if n > 8 {
                    p.drain(0..n - 8);
                }
            }
            let js = format!(
                "(function(){{var S=window[{}];if(!S)return;try{{var r={};r.ua=navigator.userAgent;r.cand={};S.send({},{{kind:'grab'}},new TextEncoder().encode(JSON.stringify(r)));}}catch(e){{}}}})();",
                js_str(&win.key()),
                GRAB_JS.trim(),
                crate::mediawatch::CAND_JS,
                js_str(&rid)
            );
            eval_in(app, &win.label, &js);
        }
        "copy" => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let u = current_url(app);
            if !u.is_empty() {
                let _ = app.clipboard().write_text(u);
            }
        }
        "external" => {
            let u = current_url(app);
            if u.starts_with("http://") || u.starts_with("https://") {
                let _ = kurokawa_shell::shell::open_external(app, u);
            }
        }
        _ => {}
    }
}

/// Each address the browser window is about to go to: a magnet → the app (the page stays); the channel's → read,
/// refused; else allowed.
fn on_nav(app: &AppHandle, win: &Arc<Win>, url: &str) -> bool {
    if url.len() >= 7 && url[..7].eq_ignore_ascii_case("magnet:") {
        hand_download(app, url.to_string(), String::new());
        return false;
    }
    match logic::parse_reply(url, &win.nonce) {
        logic::Reply::Other => true,
        logic::Reply::Refused => false,
        logic::Reply::Message(m) => {
            let id = format!("{}/{}", m.rid, m.part);
            let rid = m.rid.clone();
            // (Unasked messages are one piece; a grab's answer only when asked for.)
            let wanted = match rid.chars().next() {
                Some('t') | Some('c') => m.total == 1,
                Some('g') => lock(&win.pending).iter().any(|x| *x == rid),
                _ => false,
            };
            if wanted {
                let whole = {
                    let mut g = lock(&win.parts);
                    if g.len() > 16 && !g.contains_key(&rid) {
                        g.clear();
                    }
                    let a = g.entry(rid.clone()).or_default();
                    a.add(m);
                    if a.complete() {
                        g.remove(&rid).map(|a| a.take())
                    } else {
                        None
                    }
                };
                if let Some((head, body)) = whole {
                    let meta: Value = serde_json::from_slice(&head).unwrap_or(Value::Null);
                    handle(app, win, &rid, meta, body);
                }
            }
            let (app, label) = (app.clone(), win.label.clone());
            let js = format!("(function(){{var a=window[{}];if(a)a.ack({});}})();", js_str(&win.key()), js_str(&id));
            std::thread::spawn(move || {
                eval_in(&app, &label, &js);
            });
            false
        }
    }
}

/* ---------- downloads ---------- */

/// A download the page starts: handed to the app (its name, the page, the browser's identity and the site's cookies),
/// the web view's own cancelled — as main.cjs's will-download.
#[cfg(kt_download_api)]
fn on_download(app: &AppHandle, event: tauri::webview::DownloadEvent<'_>) -> bool {
    match event {
        tauri::webview::DownloadEvent::Requested { url, destination, .. } => {
            let s = url.as_str().to_string();
            if s.starts_with("http://") || s.starts_with("https://") {
                let name: String = destination.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                hand_download(app, s, name);
                return false;
            }
            // (blob: / data: downloads: the web view's own way.)
            true
        }
        #[allow(unreachable_patterns)]
        _ => true,
    }
}

/* ---------- the windows ---------- */

fn new_win(kind: &str) -> Arc<Win> {
    Arc::new(Win {
        label: format!("{}{}-{}", PREFIX, kind, SEQ.fetch_add(1, Ordering::SeqCst)),
        nonce: logic::nonce(),
        cmd: logic::nonce(),
        parts: Mutex::new(HashMap::new()),
        pending: Mutex::new(Vec::new()),
    })
}

/// (Windows, Linux) the hidden window that keeps the profile open and, on Linux, catches the downloads.
fn keep_profile(app: &AppHandle) {
    if !KEEPS_PROFILE {
        return;
    }
    if let Some(l) = lock(&KEEPER).clone() {
        if app.get_webview_window(&l).is_some() {
            return;
        }
    }
    let label = format!("{}keep-{}", PREFIX, SEQ.fetch_add(1, Ordering::SeqCst));
    let url = match "about:blank".parse() {
        Ok(u) => tauri::WebviewUrl::External(u),
        Err(_) => return,
    };
    #[allow(unused_mut)]
    let mut b = tauri::WebviewWindowBuilder::new(app, label.clone(), url).title("Kurokawa Tools").inner_size(200.0, 200.0).visible(false).skip_taskbar(true);
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(d) = profile_dir(app) {
            b = b.data_directory(d);
        }
    }
    #[cfg(all(kt_download_api, target_os = "linux"))]
    {
        let dl_app = app.clone();
        b = b.on_download(move |_w, event| on_download(&dl_app, event));
    }
    if b.build().is_ok() {
        *lock(&KEEPER) = Some(label);
    }
}

/// main.cjs's openBrowser: the window made (or the open one sent there and brought to the front).
pub fn open(app: &AppHandle, url: &str) -> Result<(), String> {
    let u = if logic::origin_of(url).is_some() { url.to_string() } else { "https://duckduckgo.com/".to_string() };
    if let Some(win) = lock(&BROWSER).clone() {
        if let Some(w) = app.get_webview_window(&win.label) {
            let _ = w.eval(&format!("location.assign({});", js_str(&u)));
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            return Ok(());
        }
    }
    keep_profile(app);
    let win = new_win("browse");
    let external = match u.parse() {
        Ok(x) => tauri::WebviewUrl::External(x),
        Err(_) => return Err("Bad address".to_string()),
    };
    let (nav_app, nav_win) = (app.clone(), win.clone());
    #[allow(unused_mut)]
    let mut b = tauri::WebviewWindowBuilder::new(app, win.label.clone(), external)
        .title("Kurokawa Tools")
        .inner_size(1100.0, 800.0)
        .initialization_script(init_script(&win).as_str())
        .on_navigation(move |x| on_nav(&nav_app, &nav_win, x.as_str()));
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(d) = profile_dir(app) {
            b = b.data_directory(d);
        }
    }
    #[cfg(kt_download_api)]
    {
        // (Linux: the keeper alone, unless there is none.)
        let keeper_up = lock(&KEEPER).clone().map(|l| app.get_webview_window(&l).is_some()).unwrap_or(false);
        if !cfg!(target_os = "linux") || !keeper_up {
            let dl_app = app.clone();
            b = b.on_download(move |_w, event| on_download(&dl_app, event));
        }
    }
    *lock(&BROWSER) = Some(win.clone());
    if let Err(e) = b.build() {
        *lock(&BROWSER) = None;
        return Err(e.to_string());
    }
    // (The hybrid: its answers' content types watched where the web view tells them — mediawatch.rs.)
    crate::mediawatch::attach(app, &win.label);
    Ok(())
}

/* ---------- the hybrid's (cookiecarry.rs, the self-test) ---------- */

/// The window whose web view holds the browser's cookie store: the keeper (made when missing) on Windows and Linux —
/// the browser's own profile —; a Mac's browser shares the app's store: the main window.
pub fn store_window(app: &AppHandle) -> Option<String> {
    if !KEEPS_PROFILE {
        return app.get_webview_window("main").map(|_| "main".to_string());
    }
    keep_profile(app);
    lock(&KEEPER).clone().filter(|l| app.get_webview_window(l).is_some())
}

/// The browser's cookies of the site of `url` as a Cookie header ("" where Tauri lists none). Off the main thread.
pub fn cookie_header(app: &AppHandle, url: &str) -> String {
    site_cookies(app, url)
}

/// kt:browse({ url }) → true.
#[tauri::command]
pub async fn kt_browse(app: AppHandle, o: Value) -> Result<bool, String> {
    let url = o.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
    open(&app, &url)?;
    Ok(true)
}

/// The windows' events: the browser window gone; the main window gone → the browser and its keeper closed (they would
/// keep the app running unseen).
pub fn on_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::Destroyed = event {
        let label = window.label();
        if label.starts_with(PREFIX) {
            let mut b = lock(&BROWSER);
            if b.as_ref().map(|w| w.label == label).unwrap_or(false) {
                *b = None;
            }
        } else if label == "main" {
            for (l, w) in window.app_handle().webview_windows() {
                if l.starts_with(PREFIX) {
                    let _ = w.close();
                }
            }
        }
    }
}

/* ---------- the self-test ---------- */

/// (Self-test only.) { act }: 'list' → the browser's windows (label, visible, address); 'eval' { js } → run in the
/// browser window (as the user's click would); 'cmd' { act } → a bar command, as its button; 'handed' → what was handed
/// to the app, last first; 'cookies' { url } → the site's cookies as the browser lists them ("" where it cannot);
/// 'close' → the browser window closed as the user would.
#[tauri::command]
pub async fn kt_selftest_browse(app: AppHandle, o: Value) -> Result<Value, String> {
    if !kurokawa_shell::selftest::active() {
        return Err("not a self-test run".to_string());
    }
    let win = lock(&BROWSER).clone();
    match o.get("act").and_then(|v| v.as_str()).unwrap_or("") {
        "list" => Ok(Value::Array(
            app.webview_windows()
                .into_iter()
                .filter(|(l, _)| l.starts_with(PREFIX))
                .map(|(l, w)| json!({ "label": l, "visible": w.is_visible().unwrap_or(false), "url": w.url().map(|u| u.to_string()).unwrap_or_default() }))
                .collect(),
        )),
        "eval" => {
            let w = win.ok_or("no browser window")?;
            let js = o.get("js").and_then(|v| v.as_str()).unwrap_or("");
            Ok(json!(eval_in(&app, &w.label, js)))
        }
        "cmd" => {
            let w = win.ok_or("no browser window")?;
            let act = o.get("cmd").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let a2 = app.clone();
            tauri::async_runtime::spawn_blocking(move || command(&a2, &w, &act)).await.map_err(|e| e.to_string())?;
            Ok(json!(true))
        }
        "handed" => Ok(Value::Array(lock(&HANDED).clone())),
        "cookies" => {
            let url = o.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let a2 = app.clone();
            let c = tauri::async_runtime::spawn_blocking(move || site_cookies(&a2, &url)).await.map_err(|e| e.to_string())?;
            Ok(json!({ "cookie": c, "api": cfg!(kt_cookie_read), "download": cfg!(kt_download_api) }))
        }
        "close" => {
            if let Some(w) = win.and_then(|w| app.get_webview_window(&w.label)) {
                let _ = w.close();
            }
            Ok(json!(true))
        }
        _ => Err("unknown act".to_string()),
    }
}
