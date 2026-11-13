// The app's own browser (stage R4; desktop/main.cjs's kr:open-webview, kr:browser-fetch, kr:browser-reset,
// kr:browser-forget): windows of the system's web view on a site, for the sites that answer only a browser — a
// check passed out of sight (the site's own scripts run, as in any browser) or by the reader in a window that says
// so, a site opened for the reader to sign in or look around (with a small bar of its own when asked: back,
// forward, reload, an address), and requests made by a page of the site itself (a hidden window on the site, kept a
// few minutes). Nothing here passes a check for the reader: a check that wants a person stays in its window until the
// reader passes it or closes it.
//
// Security. The site's page is given nothing of the app: the windows run no bridge (bridge.js is the main window's
// initialization script only), they have no capability (capabilities/default.json names the main window), and
// main.rs lets a window other than the main one call no command of the app but kr_browser_deliver — which takes an
// answer for its own window only (its label decides, and the window's random token must match). The page's answers
// come back by that command, or, where the system's web view does not carry it from a site's page, by asking to go
// to an address no site has (https://kr-lane.invalid/…), which the window's navigation handler reads and refuses —
// browserlogic.rs says how. A site's links that open a new window open in the same window.
//
// Where the data is: on Windows and Linux the browser has a profile of its own (<app local data>/browser), apart
// from the app's library; a Mac's web view cannot be given one here (WKWebView's data store is the app's default
// there), so on a Mac the browser shares the app's — sites' cookies are kept per site anyway — and nothing here ever
// clears that store whole (it holds the library).
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use kurokawa_shell::{net, selftest as frame, util};

use crate::browserlogic as logic;

/// The labels of the browser's windows begin so (main.rs lets them call kr_browser_deliver and nothing else).
pub const PREFIX: &str = "krb-";
/// The one command a browser window may call.
pub const DELIVER: &str = "kr_browser_deliver";

/* ---------- the windows ---------- */

#[derive(Clone)]
struct Answer {
    meta: Value,
    body: Vec<u8>,
}

#[derive(Default)]
struct Inbox {
    /// The answers asked for and not come yet: only these are taken (a page cannot fill the inbox with others).
    pending: HashSet<String>,
    parts: HashMap<String, logic::Assembly>,
    done: HashMap<String, Answer>,
    /// Answers already given (or given up on): a late copy is dropped.
    finished: VecDeque<String>,
    /// The address an `until` matched.
    hit: Option<String>,
}

struct Win {
    label: String,
    nonce: String,
    inbox: Mutex<Inbox>,
    cv: Condvar,
    closed: AtomicBool,
    /// The plain text an `until` pattern holds (tested on each address the window goes to).
    until_lit: Option<String>,
}

impl Win {
    fn key(&self) -> String {
        format!("__kr{}", self.nonce)
    }
}

struct Lane {
    win: Arc<Win>,
    /// None while it opens; then Ok (the site's page is there) or Err((why, title, message)).
    state: Mutex<Option<Result<(), (String, String, String)>>>,
    cv: Condvar,
    busy: AtomicUsize,
    used: Mutex<Instant>,
}

static SEQ: AtomicU64 = AtomicU64::new(1);
/// The main window is closing: no new window, every one of the browser's closed (they would keep the app running).
static SHUTDOWN: AtomicBool = AtomicBool::new(false);
/// How answers have come: 1 by the command, 2 by the address only (then the page's script tries that first).
static VIA: AtomicU8 = AtomicU8::new(0);
static SWEEPING: AtomicBool = AtomicBool::new(false);
/// Downloads a site started (for the self-test): { url, path, ok }.
static DOWNLOADS: Mutex<Vec<Value>> = Mutex::new(Vec::new());
/// Where each download was sent (address, path): a Mac's web view says it finished without its path.
static DL_DEST: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
/// The last answer that did not come whole, said (for the error and the self-test).
static LAST_WAIT: Mutex<String> = Mutex::new(String::new());
/// Cookies a «forget» deleted that the web view still listed after (for the self-test).
static FORGET_LEFT: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// Windows: a hidden window kept on the browser's profile while the app runs. WebView2 ends the profile's browser
/// process when its last window closes, and the session's cookies (a sign-in without an expiry) go with it — the
/// first CI run: a site signed in by a check window was signed out to the next lane. Electron's session lives as long
/// as the app.
static KEEPER: Mutex<Option<Arc<Win>>> = Mutex::new(None);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn wins() -> &'static Mutex<HashMap<String, Arc<Win>>> {
    static W: OnceLock<Mutex<HashMap<String, Arc<Win>>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lanes() -> &'static Mutex<HashMap<String, Arc<Lane>>> {
    static L: OnceLock<Mutex<HashMap<String, Arc<Lane>>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sleep_ms(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

fn next_rid() -> String {
    format!("r{}", SEQ.fetch_add(1, Ordering::SeqCst))
}

/// A JS string literal.
fn js_str(s: &str) -> String {
    Value::String(s.to_string()).to_string()
}

fn text(o: &Value, k: &str) -> String {
    match o.get(k) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn flag(o: &Value, k: &str) -> bool {
    o.get(k).map(|v| v.as_bool().unwrap_or(false) || v.as_f64().map(|n| n != 0.0).unwrap_or(false)).unwrap_or(false)
}

fn millis(o: &Value, k: &str) -> Option<u64> {
    o.get(k).and_then(|v| v.as_f64()).filter(|n| *n > 0.0).map(|n| n.min(1e12) as u64)
}

/// What a browser window may do (the self-test reports it; PORTING.md explains each).
pub fn abilities() -> Value {
    json!({
        "ownProfile": !cfg!(target_os = "macos"),
        "cookieRead": cfg!(kr_cookie_read),
        "cookieAll": cfg!(kr_cookie_all),
        "cookieDelete": cfg!(kr_cookie_delete),
        "clearAll": cfg!(kr_clear_all) && !cfg!(target_os = "macos"),
        "downloads": cfg!(kr_download_api),
    })
}

/// The browser's own profile (Windows, Linux): <app local data>/browser.
#[cfg(not(target_os = "macos"))]
fn profile_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join("browser"))
}

/* ---------- the page's scripts ---------- */

/// The page's side of the channel, put in once per page (by the window's initialization script, or by the first
/// script Rust runs there): send(rid, meta, body, kind) — by kr_browser_deliver, else (or once that has failed) by
/// asking to go to https://kr-lane.invalid/… one message at a time, each acknowledged (ack) before the next; a
/// message of a kind ('s' state, 't' title) replaces one of its kind still waiting. While the site itself is leaving
/// the page (its own beforeunload, within 8 s) nothing is sent that way, nor sent again — it would cancel the site's
/// navigation —, and the site's beforeunload handlers do not run for the channel's own.
const SENDER_JS: &str = r#"(function(K,N,CH,P){var w=window;if(w[K])return w[K];var mode=P||'',q=[],cur=null,tm=0,siteAt=0,ours=false;
try{w.addEventListener('beforeunload',function(e){if(ours)e.stopImmediatePropagation();else siteAt=Date.now();},true);}catch(e){}
function bin(u8){var s='';for(var j=0;j<u8.length;j+=8192)s+=String.fromCharCode.apply(null,u8.subarray(j,j+8192));return s;}
function b64(u8){return btoa(bin(u8));}
function b64u(u8){return b64(u8).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function next(){if(cur||!q.length)return;cur=q.shift();fire();}
function fire(){clearTimeout(tm);var c=cur;if(!c)return;if(Date.now()-siteAt<8000){tm=setTimeout(fire,500);return;}ours=true;try{w.location.href=c.u;}catch(e){}ours=false;tm=setTimeout(function(){if(cur!==c)return;if(++c.t<8)fire();else{cur=null;next();}},2000);}
function nav(rid,meta,body,kind){if(kind)q=q.filter(function(x){return x.k!==kind;});var n=body?Math.ceil(body.length/CH):0,total=1+n,base='https://kr-lane.invalid/'+N+'/'+rid+'/';
q.push({u:base+'0/'+total+'?'+b64u(new TextEncoder().encode(JSON.stringify(meta))),t:0,id:rid+'/0',k:kind||''});
for(var i=0;i<n;i++)q.push({u:base+(i+1)+'/'+total+'?'+b64u(body.subarray(i*CH,(i+1)*CH)),t:0,id:rid+'/'+(i+1),k:''});next();}
function ipc(rid,meta,body){var i=w.__TAURI_INTERNALS__;if(!i||typeof i.invoke!=='function')return Promise.reject(new Error('no ipc'));
return new Promise(function(ok,no){var t=setTimeout(function(){no(new Error('no answer'));},4000);
try{Promise.resolve(i.invoke('kr_browser_deliver',{d:{n:N,r:rid,m:meta,b:body?b64(body):null}})).then(function(v){clearTimeout(t);if(v===true)ok();else no(new Error('refused'));},function(e){clearTimeout(t);no(e);});}catch(e){clearTimeout(t);no(e);}});}
var api={send:function(rid,meta,body,kind){if(mode==='nav'){nav(rid,meta,body,kind);return;}ipc(rid,meta,body).then(function(){mode='ipc';},function(){mode='nav';nav(rid,meta,body,kind);});},
ack:function(id){if(cur&&cur.id===id){clearTimeout(tm);cur=null;next();}},
mode:function(){return mode;}};
try{Object.defineProperty(w,K,{value:api});}catch(e){w[K]=api;}return api;})"#;

/// A request made by the site's own page (main.cjs's LANE_FETCH): its answer — status, headers, address — and its
/// body's bytes. The headers a browser sets itself are left to it.
const FETCH_JS: &str = r#"(function(){var S=__S__;var rid=__RID__;var o=__O__;
try{var h={},h0=o.headers||{};Object.keys(h0).forEach(function(k){if(!/^(user-agent|referer|cookie|cookie2|accept-encoding|host|origin|connection|content-length|keep-alive|te|trailer|transfer-encoding|upgrade|via|sec-.*|proxy-.*)$/i.test(k))h[k]=h0[k];});
var init={method:o.method||'GET',headers:h,credentials:'include',cache:'no-store',redirect:'follow'};
if(o.body!=null)init.body=o.bodyBase64?Uint8Array.from(atob(o.body),function(c){return c.charCodeAt(0);}):o.body;
var ctl=typeof AbortController==='function'?new AbortController():null;var tm=setTimeout(function(){if(ctl)ctl.abort();},o.timeout||90000);if(ctl)init.signal=ctl.signal;
fetch(o.url,init).then(function(r){var hs={};r.headers.forEach(function(v,n){hs[n.toLowerCase()]=v;});return r.arrayBuffer().then(function(b){clearTimeout(tm);S.send(rid,{status:r.status,headers:hs,url:r.url||o.url},new Uint8Array(b));});}).catch(function(e){clearTimeout(tm);S.send(rid,{error:String(e&&e.message||e)},null);});
}catch(e){S.send(rid,{error:String(e&&e.message||e)},null);}})();"#;

/// What the page says of itself (main.cjs's STATE_JS): loaded or not, its origin, a check on it, a refusal, its
/// title, its address — and that address again when it matches the `until` given.
const STATE_JS: &str = r#"(function(){var S=__S__;var rid=__RID__;var u=__UNTIL__;var st;
try{var t=document.title||'',b=document.body?(document.body.innerText||'').slice(0,700):'';
var bl=/used Cloudflare to restrict access|Sorry, you have been blocked|You are unable to access|has banned you|banned your IP|Error 10(06|07|08|09|10|12|20)\b/i.test(t+' '+b);
var ch=!bl&&(/Just a moment|Attention Required|Verifying you are human|Verify you are human|Checking your browser|Checking if the site connection is secure|Please wait|DDoS-Guard|One moment|لحظة|Один момент/i.test(t)||!!document.querySelector('#challenge-form,#challenge-running,#challenge-stage,#cf-challenge-running,.cf-browser-verification,#cf-please-wait,#turnstile-wrapper,[name="cf-turnstile-response"],#ddg-captcha,.ddg-captcha,#sucuri_cloudproxy_js'));
var hit='';if(u){try{if(new RegExp(u).test(location.href))hit=String(location.href);}catch(e){}}
st={ready:document.readyState,origin:location.origin,check:ch,blocked:bl,title:t.slice(0,140),href:String(location.href).slice(0,2000),hit:hit.slice(0,8000)};}catch(e){st={error:String(e&&e.message||e)};}
S.send(rid,st,null,'s');})();"#;

/// Every page of a browser window, before the site's own scripts: the channel, and the site's new windows kept in
/// this one (window.open, links and forms aimed at another window) — as main.cjs's browser does.
const INIT_JS: &str = r#"(function(){if(window.top!==window)return;var S=__S__;
try{window.open=function(u){try{if(u)location.assign(new URL(String(u),location.href).href);}catch(e){}return null;};}catch(e){}
function away(t){t=String(t||'').toLowerCase();return !!t&&t!=='_self'&&t!=='_top'&&t!=='_parent';}
document.addEventListener('click',function(ev){var a=ev.target&&ev.target.closest?ev.target.closest('a[target]'):null;if(!a||!away(a.getAttribute('target'))||a.hasAttribute('download'))return;var to=a.href;if(!/^https?:/i.test(to))return;ev.preventDefault();location.assign(to);},true);
document.addEventListener('submit',function(ev){var f=ev.target;if(f&&away(f.getAttribute&&f.getAttribute('target')))f.setAttribute('target','_self');},true);
__BROWSE__})();"#;

/// The browser as a browser (Settings → Open the browser): main.cjs's bar — back, forward, reload, the address (an
/// address, or words searched for) —, here a small bar in a corner of the page (in a closed shadow root: the site's
/// styles do not reach it, nor its scripts into it); Alt+← / Alt+→; the window titled with the page.
const BROWSE_JS: &str = r#"var C=__C__;
function addr(v){v=String(v||'').trim();if(!v)return null;if(/^https?:\/\//i.test(v))return v;if(/^[^\s/]+\.[^\s/]{2,}(\/.*)?$/.test(v)||/^localhost(:\d+)?(\/|$)/.test(v))return 'https://'+v;return 'https://duckduckgo.com/?q='+encodeURIComponent(v);}
var CSS='form{display:flex;align-items:center;gap:2px;height:44px;padding:0 6px;box-sizing:border-box;border-radius:22px;background:#f3f1f6;color:#1c1b1f;box-shadow:0 2px 10px rgba(0,0,0,.28);font:14px system-ui,"Segoe UI",sans-serif;user-select:none}'
+'button{all:unset;width:34px;height:34px;border-radius:17px;display:grid;place-items:center;cursor:pointer;font-size:18px;line-height:1}'
+'button:hover{background:rgba(0,0,0,.08)}button:disabled{opacity:.35;cursor:default;background:none}'
+'input{width:200px;height:32px;border-radius:16px;border:1px solid #c9c5d0;background:#fff;color:inherit;padding:0 12px;font:inherit;outline:none;direction:ltr;text-align:left;transition:width .15s}'
+'input:focus{width:340px;border-color:#6750a4;box-shadow:0 0 0 1px #6750a4}'
+'@media (prefers-color-scheme:dark){form{background:#1d1b20;color:#e6e1e5}button:hover{background:rgba(255,255,255,.1)}input{background:#2b2930;border-color:#49454f}}'
+'@media (max-width:560px){input{width:110px}input:focus{width:200px}}';
function bar(){var root=document.documentElement;if(!root||document.getElementById('kr-browser-bar'))return;
var host=document.createElement('kr-browser-bar');host.id='kr-browser-bar';host.style.cssText='all:initial;position:fixed;z-index:2147483647;bottom:12px;'+(C.rtl?'right':'left')+':12px;';
var r=host.attachShadow({mode:'closed'});var st=document.createElement('style');st.textContent=CSS;r.appendChild(st);
var f=document.createElement('form');f.dir=C.rtl?'rtl':'ltr';r.appendChild(f);
function btn(t,x,fn){var b=document.createElement('button');b.type='button';b.title=t||'';b.setAttribute('aria-label',t||'');b.textContent=x;b.onclick=fn;f.appendChild(b);return b;}
var bk=btn(C.back,C.rtl?'→':'←',function(){history.back();});var fw=btn(C.forward,C.rtl?'←':'→',function(){history.forward();});btn(C.reload,'↻',function(){location.reload();});
var a=document.createElement('input');a.spellcheck=false;a.autocomplete='off';a.placeholder=C.placeholder||'';a.value=location.href;f.appendChild(a);
a.onfocus=function(){setTimeout(function(){a.select();},0);};f.onsubmit=function(e){e.preventDefault();var to=addr(a.value);if(to)location.assign(to);a.blur();};
var nv=window.navigation;function upd(){if(document.activeElement!==host)a.value=location.href;if(nv&&'canGoBack' in nv){bk.disabled=!nv.canGoBack;fw.disabled=!nv.canGoForward;}}
root.appendChild(host);upd();setInterval(function(){if(!host.isConnected&&document.documentElement)document.documentElement.appendChild(host);upd();},1000);}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bar);else bar();
document.addEventListener('keydown',function(e){if(!e.altKey||e.ctrlKey||e.metaKey)return;if(e.key==='ArrowLeft'){e.preventDefault();history.back();}else if(e.key==='ArrowRight'){e.preventDefault();history.forward();}},true);
var lastT='';function title(){var t=document.title||location.href;if(t===lastT)return;lastT=t;S.send('t'+Date.now().toString(36)+Math.floor(Math.random()*1e6).toString(36),{title:t.slice(0,200)},null,'t');}
setInterval(title,1000);if(document.readyState!=='loading')title();else document.addEventListener('DOMContentLoaded',title);"#;

/// The call that puts the channel in a page (or finds it there).
fn sender_call(win: &Win) -> String {
    let pref = if VIA.load(Ordering::SeqCst) == 2 { "nav" } else { "" };
    let chunk = if cfg!(target_os = "macos") { logic::CHUNK_SMALL } else { logic::CHUNK };
    format!(
        "{}({},{},{},{})",
        SENDER_JS,
        js_str(&win.key()),
        js_str(&win.nonce),
        chunk,
        js_str(pref)
    )
}

fn init_script(win: &Win, browse: Option<&Value>) -> String {
    let browse_js = match browse {
        Some(c) => BROWSE_JS.replace("__C__", &c.to_string()),
        None => String::new(),
    };
    // (Ours first, the page's words last: nothing is replaced after them.)
    INIT_JS.replace("__S__", &sender_call(win)).replace("__BROWSE__", &browse_js)
}

/* ---------- the channel's Rust side ---------- */

fn eval_in(app: &AppHandle, label: &str, js: &str) -> bool {
    match app.get_webview_window(label) {
        Some(w) => w.eval(js).is_ok(),
        None => false,
    }
}

/// An answer that came whole (by the command or by addresses).
fn deliver(app: &AppHandle, win: &Arc<Win>, rid: String, meta: Value, body: Vec<u8>, via: u8) {
    if via == 1 {
        VIA.store(1, Ordering::SeqCst);
    } else if VIA.load(Ordering::SeqCst) == 0 {
        VIA.store(2, Ordering::SeqCst);
    }
    // (A title of a page in a browser window opened as a browser: the window's title, as main.cjs's.)
    if rid.starts_with('t') {
        if let Some(t) = meta.get("title").and_then(|v| v.as_str()) {
            let t: String = t.chars().take(200).collect();
            let app = app.clone();
            let label = win.label.clone();
            std::thread::spawn(move || {
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.set_title(&t);
                }
            });
        }
        return;
    }
    {
        let mut g = lock(&win.inbox);
        if !g.pending.remove(&rid) {
            return;
        }
        g.finished.push_back(rid.clone());
        while g.finished.len() > 512 {
            g.finished.pop_front();
        }
        g.done.insert(rid, Answer { meta, body });
    }
    win.cv.notify_all();
}

/// Each address a browser window is about to go to: the channel's (read, refused), else allowed — and an `until`'s
/// text looked for in it.
fn on_nav(app: &AppHandle, win: &Arc<Win>, url: &str) -> bool {
    if let Some(l) = &win.until_lit {
        if url.contains(l.as_str()) && logic::parse_reply(url, &win.nonce) == logic::Reply::Other {
            lock(&win.inbox).hit = Some(url.to_string());
            win.cv.notify_all();
        }
    }
    match logic::parse_reply(url, &win.nonce) {
        logic::Reply::Other => true,
        logic::Reply::Refused => false,
        logic::Reply::Message(m) => {
            let id = format!("{}/{}", m.rid, m.part);
            let rid = m.rid.clone();
            let whole: Option<(Vec<u8>, Vec<u8>)> = {
                let mut g = lock(&win.inbox);
                // (Only an answer asked for — or a page's title, in one message.)
                let wanted = if rid.starts_with('t') { m.total == 1 } else { g.pending.contains(&rid) };
                if !wanted {
                    None
                } else {
                    let a = g.parts.entry(rid.clone()).or_default();
                    a.add(m);
                    if a.complete() {
                        g.parts.remove(&rid).map(|a| a.take())
                    } else {
                        None
                    }
                }
            };
            if let Some((head, body)) = whole {
                let meta: Value = serde_json::from_slice(&head).unwrap_or(Value::Null);
                deliver(app, win, rid, meta, body, 2);
            }
            // (Acknowledged from another thread: the page then sends its next message.)
            let app = app.clone();
            let label = win.label.clone();
            let js = format!("(function(){{var a=window[{}];if(a)a.ack({});}})();", js_str(&win.key()), js_str(&id));
            std::thread::spawn(move || {
                eval_in(&app, &label, &js);
            });
            false
        }
    }
}

/// kr_browser_deliver: an answer from a browser window's page, for that window only (its label) and only with its
/// token → whether it was taken. (The one command main.rs lets a browser window call.)
#[tauri::command]
pub async fn kr_browser_deliver(window: tauri::Window, d: Value) -> Result<bool, String> {
    let label = window.label().to_string();
    if !label.starts_with(PREFIX) {
        return Ok(false);
    }
    let win = match lock(wins()).get(&label).cloned() {
        Some(w) => w,
        None => return Ok(false),
    };
    if d.get("n").and_then(|v| v.as_str()) != Some(win.nonce.as_str()) {
        return Ok(false);
    }
    let rid = text(&d, "r");
    if rid.is_empty() || rid.len() > 24 || !rid.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Ok(false);
    }
    let meta = d.get("m").cloned().unwrap_or(Value::Null);
    let body = match d.get("b") {
        Some(Value::String(s)) => util::b64_decode(s),
        _ => Vec::new(),
    };
    deliver(window.app_handle(), &win, rid, meta, body, 1);
    Ok(true)
}

/// A script run in the window's page, and its answer (None: no answer in time, or the window gone).
fn ask(app: &AppHandle, win: &Arc<Win>, rid: &str, js: &str, wait: Duration) -> Option<Answer> {
    if win.closed.load(Ordering::SeqCst) {
        return None;
    }
    lock(&win.inbox).pending.insert(rid.to_string());
    if !eval_in(app, &win.label, js) {
        lock(&win.inbox).pending.remove(rid);
        return None;
    }
    let until = Instant::now() + wait;
    let mut g = lock(&win.inbox);
    loop {
        if let Some(a) = g.done.remove(rid) {
            return Some(a);
        }
        let now = Instant::now();
        if win.closed.load(Ordering::SeqCst) || now >= until {
            let said = match g.parts.get(rid).map(|a| a.progress()) {
                Some((got, all)) => format!("{} of {} messages came by address", got, all),
                None if win.closed.load(Ordering::SeqCst) => "the window closed".to_string(),
                None => format!("nothing came (answers so far: {})", via_name()),
            };
            *lock(&LAST_WAIT) = said;
            g.parts.remove(rid);
            g.pending.remove(rid);
            g.finished.push_back(rid.to_string());
            return None;
        }
        let (g2, _) = win.cv.wait_timeout(g, until - now).unwrap_or_else(|e| e.into_inner());
        g = g2;
    }
}

fn page_state(app: &AppHandle, win: &Arc<Win>, until: Option<&str>) -> Option<logic::PageState> {
    let rid = next_rid();
    let js = STATE_JS
        .replace("__S__", &sender_call(win))
        .replace("__RID__", &js_str(&rid))
        .replace("__UNTIL__", &js_str(until.unwrap_or("")));
    let a = ask(app, win, &rid, &js, Duration::from_secs(3))?;
    let m = &a.meta;
    if m.get("error").is_some() || !m.is_object() {
        return None;
    }
    Some(logic::PageState {
        ready: text(m, "ready"),
        origin: text(m, "origin"),
        check: flag(m, "check"),
        blocked: flag(m, "blocked"),
        title: text(m, "title"),
        href: text(m, "href"),
        hit: text(m, "hit"),
    })
}

/// Waits up to `ms` for the window to close or an `until` to be met.
fn rest(win: &Arc<Win>, ms: u64) {
    let until = Instant::now() + Duration::from_millis(ms);
    let mut g = lock(&win.inbox);
    loop {
        let now = Instant::now();
        if g.hit.is_some() || win.closed.load(Ordering::SeqCst) || now >= until {
            return;
        }
        let (g2, _) = win.cv.wait_timeout(g, until - now).unwrap_or_else(|e| e.into_inner());
        g = g2;
    }
}

/* ---------- opening and closing ---------- */

struct Spec<'a> {
    kind: &'a str,
    url: &'a str,
    title: &'a str,
    visible: bool,
    width: f64,
    height: f64,
    until: Option<&'a str>,
    browse: Option<Value>,
}

fn via_name() -> &'static str {
    match VIA.load(Ordering::SeqCst) {
        1 => "command",
        2 => "address",
        _ => "none yet",
    }
}

/// (Windows) the hidden window that keeps the browser's profile — its session cookies — alive (KEEPER).
fn keep_profile(app: &AppHandle) {
    static OPENING: AtomicBool = AtomicBool::new(false);
    // (Never held while a window is made: the main thread, which makes it, takes this lock when a window goes.)
    if lock(&KEEPER).as_ref().map(|w| !w.closed.load(Ordering::SeqCst)).unwrap_or(false) || OPENING.swap(true, Ordering::SeqCst) {
        return;
    }
    let spec = Spec { kind: "keep", url: "about:blank", title: "KurokawaReader", visible: false, width: 200.0, height: 200.0, until: None, browse: None };
    let made = open_window(app, &spec).ok();
    if made.is_some() {
        *lock(&KEEPER) = made;
    }
    OPENING.store(false, Ordering::SeqCst);
}

fn open_window(app: &AppHandle, s: &Spec) -> Result<Arc<Win>, String> {
    if SHUTDOWN.load(Ordering::SeqCst) {
        return Err("the app is closing".to_string());
    }
    if cfg!(target_os = "windows") && s.kind != "keep" {
        keep_profile(app);
    }
    let label = format!("{}{}-{}", PREFIX, s.kind, SEQ.fetch_add(1, Ordering::SeqCst));
    let win = Arc::new(Win {
        label: label.clone(),
        nonce: logic::nonce(),
        inbox: Mutex::new(Inbox::default()),
        cv: Condvar::new(),
        closed: AtomicBool::new(false),
        until_lit: s.until.and_then(logic::literal_of),
    });
    let external = match s.url.parse() {
        Ok(u) => tauri::WebviewUrl::External(u),
        Err(_) => return Err("Bad address".to_string()),
    };
    lock(wins()).insert(label.clone(), win.clone());
    let init = init_script(&win, s.browse.as_ref());
    let nav_app = app.clone();
    let nav_win = win.clone();
    #[allow(unused_mut)]
    let mut b = tauri::WebviewWindowBuilder::new(app, label.clone(), external)
        .title(s.title)
        .inner_size(s.width, s.height)
        .visible(s.visible)
        .initialization_script(init.as_str())
        .on_navigation(move |u| on_nav(&nav_app, &nav_win, u.as_str()));
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(d) = profile_dir(app) {
            b = b.data_directory(d);
        }
    }
    #[cfg(kr_download_api)]
    {
        let dl_app = app.clone();
        b = b.on_download(move |_webview, event| on_download(&dl_app, event));
    }
    if let Err(e) = b.build() {
        lock(wins()).remove(&label);
        return Err(e.to_string());
    }
    if SHUTDOWN.load(Ordering::SeqCst) {
        close(app, &win);
        return Err("the app is closing".to_string());
    }
    Ok(win)
}

/// The window closed (by the app).
fn close(app: &AppHandle, win: &Arc<Win>) {
    win.closed.store(true, Ordering::SeqCst);
    win.cv.notify_all();
    if let Some(w) = app.get_webview_window(&win.label) {
        let _ = w.close();
    }
}

/// A browser window gone (closed by the app or by the reader).
fn gone(label: &str) {
    {
        let mut k = lock(&KEEPER);
        if k.as_ref().map(|w| w.label == label).unwrap_or(false) {
            *k = None;
        }
    }
    let w = lock(wins()).remove(label);
    if let Some(w) = w {
        w.closed.store(true, Ordering::SeqCst);
        w.cv.notify_all();
    }
    lock(lanes()).retain(|_, l| l.win.label != label);
}

/// Every browser window closed (the main window closing: they would keep the app running unseen).
fn close_all(app: &AppHandle) -> usize {
    let all: Vec<Arc<Win>> = lock(wins()).values().cloned().collect();
    lock(lanes()).clear();
    for w in all.iter() {
        close(app, w);
    }
    all.len()
}

/// The windows' events (main.rs): a browser window gone; the main window closing → every browser window closed.
pub fn on_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let label = window.label().to_string();
    match event {
        tauri::WindowEvent::Destroyed => {
            if label.starts_with(PREFIX) {
                gone(&label);
            } else if label == "main" {
                SHUTDOWN.store(true, Ordering::SeqCst);
                close_all(window.app_handle());
            }
        }
        tauri::WindowEvent::CloseRequested { .. } => {
            if label == "main" {
                SHUTDOWN.store(true, Ordering::SeqCst);
                close_all(window.app_handle());
            }
        }
        _ => {}
    }
}

/* ---------- cookies: the browser's shared with the app's own requests, and forgotten ---------- */

/// A window of the browser's profile to read or change its cookies in: `prefer` if it is open, else any browser
/// window, else a hidden one made for it (closed after).
#[cfg(any(kr_cookie_read, kr_cookie_all, kr_clear_all))]
fn with_profile<T>(app: &AppHandle, prefer: Option<&str>, f: impl FnOnce(&tauri::WebviewWindow) -> T) -> Option<T> {
    let mut labels: Vec<String> = Vec::new();
    if let Some(p) = prefer {
        labels.push(p.to_string());
    }
    labels.extend(lock(wins()).iter().filter(|(_, w)| !w.closed.load(Ordering::SeqCst)).map(|(k, _)| k.clone()));
    for l in labels.iter() {
        if let Some(w) = app.get_webview_window(l) {
            return Some(f(&w));
        }
    }
    let spec = Spec { kind: "util", url: "about:blank", title: "KurokawaReader", visible: false, width: 400.0, height: 300.0, until: None, browse: None };
    let win = open_window(app, &spec).ok()?;
    let out = app.get_webview_window(&win.label).map(|w| f(&w));
    close(app, &win);
    out
}

/// The browser's cookies put in the app's own jar (net.rs), so the app's requests carry what was done in the browser
/// — a sign-in, a check's clearance — as Electron's one session does: every cookie where the web view can list them
/// all, else those of `url`. → how many.
fn share_cookies(app: &AppHandle, prefer: Option<&str>, url: &str) -> usize {
    #[cfg(kr_cookie_all)]
    {
        let _ = url;
        let n = with_profile(app, prefer, |w| {
            let mut n = 0;
            if let Ok(list) = w.cookies() {
                for c in list.iter() {
                    let host = c.domain().unwrap_or("").trim_start_matches('.').to_string();
                    if !host.is_empty() && net::put_cookie(&c.to_string(), &host, true) {
                        n += 1;
                    }
                }
            }
            n
        });
        return n.unwrap_or(0);
    }
    #[cfg(all(kr_cookie_read, not(kr_cookie_all)))]
    {
        let host = match logic::host_of(url) {
            Some(h) => h,
            None => return 0,
        };
        let secure = url.starts_with("https:");
        let n = with_profile(app, prefer, |w| {
            let mut n = 0;
            let listed = match url.parse() {
                Ok(u) => w.cookies_for_url(u).ok(),
                Err(_) => None,
            };
            if let Some(list) = listed {
                for c in list.iter() {
                    if net::put_cookie(&c.to_string(), &host, secure) {
                        n += 1;
                    }
                }
            }
            n
        });
        return n.unwrap_or(0);
    }
    #[cfg(not(any(kr_cookie_read, kr_cookie_all)))]
    {
        let _ = (app, prefer, url);
        0
    }
}

/// The site's cookies deleted in the browser (its clearance only, or all of them) → their names.
fn forget_in_browser(app: &AppHandle, url: &str, all: bool) -> Vec<String> {
    #[cfg(all(kr_cookie_read, kr_cookie_delete))]
    {
        let out = with_profile(app, None, |w| {
            let mut names: Vec<String> = Vec::new();
            let listed = match url.parse() {
                Ok(u) => w.cookies_for_url(u).ok(),
                Err(_) => None,
            };
            if let Some(list) = listed {
                for c in list.iter() {
                    let name = c.name().to_string();
                    if (all || logic::is_clearance(&name)) && w.delete_cookie(c.clone()).is_ok() {
                        names.push(name);
                    }
                }
            }
            // (Looked at again, up to 3 s — a store may delete later than it answers: only those gone count; any
            // left is said to the self-test.)
            let mut left: Vec<String> = names.clone();
            let until = Instant::now() + Duration::from_secs(3);
            while !left.is_empty() && Instant::now() < until {
                sleep_ms(250);
                let now: Vec<String> = match url.parse() {
                    Ok(u) => w.cookies_for_url(u).map(|l| l.iter().map(|c| c.name().to_string()).collect()).unwrap_or_default(),
                    Err(_) => Vec::new(),
                };
                left.retain(|n| now.contains(n));
            }
            *lock(&FORGET_LEFT) = left.clone();
            names.retain(|n| !left.contains(n));
            names
        });
        return out.unwrap_or_default();
    }
    #[cfg(not(all(kr_cookie_read, kr_cookie_delete)))]
    {
        let _ = (app, url, all);
        Vec::new()
    }
}

/// Every site forgotten in the browser → the sites it held cookies of (as far as it can tell them). Each cookie
/// deleted where the web view can list and delete them (on a Mac the only way: its store is the app's too), else its
/// own profile cleared whole (Windows, Linux).
fn forget_all_in_browser(app: &AppHandle) -> Vec<String> {
    #[cfg(all(kr_cookie_all, kr_cookie_delete))]
    {
        let out = with_profile(app, None, |w| {
            let mut sites: Vec<String> = Vec::new();
            if let Ok(list) = w.cookies() {
                for c in list.iter() {
                    let site = c.domain().unwrap_or("").trim_start_matches('.').trim_start_matches("www.").to_string();
                    // (On a Mac the store is the app's too: its own origin's are left alone.)
                    if cfg!(target_os = "macos") && (site == "localhost" || site.ends_with("tauri.localhost")) {
                        continue;
                    }
                    if w.delete_cookie(c.clone()).is_ok() && !site.is_empty() {
                        sites.push(site);
                    }
                }
            }
            sites
        });
        let sites = out.unwrap_or_default();
        #[cfg(all(kr_clear_all, not(target_os = "macos")))]
        {
            let _ = with_profile(app, None, |w| w.clear_all_browsing_data().is_ok());
        }
        return sites;
    }
    #[cfg(not(all(kr_cookie_all, kr_cookie_delete)))]
    {
        #[cfg(all(kr_clear_all, not(target_os = "macos")))]
        {
            let _ = with_profile(app, None, |w| w.clear_all_browsing_data().is_ok());
        }
        let _ = app;
        Vec::new()
    }
}

/// kr:browser-forget: the site's window set aside; its clearance — or with `all`, everything the browser keeps, every
/// site's — forgotten, in the browser and in the app's own jar → how many sites (`all`) or cookies were forgotten.
/// (Electron's `all` clears every cookie of the one site given; Settings' «Forget all sites' sign-ins», its only
/// caller, means every site, which is what this does.)
fn forget(app: &AppHandle, url: &str, all: bool) -> usize {
    let origin = match logic::origin_of(url) {
        Some(o) => o,
        None => return 0,
    };
    retire(app, &origin);
    if all {
        let _ = close_all_lanes(app);
        let mut sites: HashSet<String> = HashSet::new();
        for (d, _) in net::forget_picked_cookies(None, &|_| true) {
            sites.insert(d.trim_start_matches("www.").to_string());
        }
        for s in forget_all_in_browser(app) {
            sites.insert(s);
        }
        return sites.len();
    }
    let host = logic::host_of(url).unwrap_or_default();
    let mut names: HashSet<String> = HashSet::new();
    for (_, n) in net::forget_picked_cookies(Some(&host), &|n| logic::is_clearance(n)) {
        names.insert(n);
    }
    for n in forget_in_browser(app, url, false) {
        names.insert(n);
    }
    names.len()
}

fn close_all_lanes(app: &AppHandle) -> usize {
    let all: Vec<Arc<Lane>> = lock(lanes()).drain().map(|(_, l)| l).collect();
    for l in all.iter() {
        close(app, &l.win);
    }
    all.len()
}

/* ---------- the browser's windows on a site, for requests (main.cjs's lanes) ---------- */

const LANE_IDLE: Duration = Duration::from_secs(4 * 60);

/// Lanes not used for four minutes closed (checked each minute).
fn sweep(app: &AppHandle) {
    if SWEEPING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        sleep_ms(60_000);
        let idle: Vec<Arc<Lane>> = {
            let mut g = lock(lanes());
            let keys: Vec<String> = g
                .iter()
                .filter(|(_, l)| {
                    let settled = lock(&l.state).is_some();
                    settled && l.busy.load(Ordering::SeqCst) == 0 && lock(&l.used).elapsed() > LANE_IDLE
                })
                .map(|(k, _)| k.clone())
                .collect();
            keys.iter().filter_map(|k| g.remove(k)).collect()
        };
        for l in idle.iter() {
            close(&app, &l.win);
        }
    });
}

/// A lane set aside: new requests open the site afresh (with the cookies as they are now); the requests under way in
/// it finish first, then it is closed (after a minute at the most).
fn retire(app: &AppHandle, origin: &str) {
    let l = lock(lanes()).remove(origin);
    if let Some(l) = l {
        let app = app.clone();
        std::thread::spawn(move || {
            let until = Instant::now() + Duration::from_secs(60);
            while l.busy.load(Ordering::SeqCst) > 0 && Instant::now() < until && !l.win.closed.load(Ordering::SeqCst) {
                sleep_ms(500);
            }
            close(&app, &l.win);
        });
    }
}

type LaneError = (String, String, String);

fn settle(lane: &Arc<Lane>, r: Result<(), LaneError>) {
    *lock(&lane.state) = Some(r);
    *lock(&lane.used) = Instant::now();
    lane.cv.notify_all();
}

/// The site's lane, its page opened and shown to be the site's own (no check on it): opened now, or the one there.
fn open_lane(app: &AppHandle, origin: &str, page: &str, timeout: Duration) -> Result<Arc<Lane>, LaneError> {
    // (One opening at a time for an origin: the requests that come meanwhile wait for it and use it.)
    let gate: Arc<Mutex<()>> = {
        static GATES: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
        let mut g = lock(GATES.get_or_init(|| Mutex::new(HashMap::new())));
        g.entry(origin.to_string()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
    };
    let _opening = lock(&gate);
    let had = lock(lanes()).get(origin).cloned();
    if let Some(l) = had {
        if !l.win.closed.load(Ordering::SeqCst) {
            *lock(&l.used) = Instant::now();
            let until = Instant::now() + timeout + Duration::from_secs(3);
            let mut g = lock(&l.state);
            loop {
                if let Some(r) = g.as_ref() {
                    return match r {
                        Ok(()) => Ok(l.clone()),
                        Err(e) => Err(e.clone()),
                    };
                }
                let now = Instant::now();
                if now >= until {
                    return Err(("challenge".into(), String::new(), "challenge".into()));
                }
                let (g2, _) = l.cv.wait_timeout(g, until - now).unwrap_or_else(|e| e.into_inner());
                g = g2;
            }
        }
        lock(lanes()).remove(origin);
    }
    let spec = Spec { kind: "lane", url: page, title: "KurokawaReader", visible: false, width: 1280.0, height: 900.0, until: None, browse: None };
    let win = match open_window(app, &spec) {
        Ok(w) => w,
        Err(e) => return Err(("error".into(), String::new(), e)),
    };
    let lane = Arc::new(Lane {
        win: win.clone(),
        state: Mutex::new(None),
        cv: Condvar::new(),
        busy: AtomicUsize::new(0),
        used: Mutex::new(Instant::now()),
    });
    lock(lanes()).insert(origin.to_string(), lane.clone());
    sweep(app);
    let started = Instant::now();
    let mut title = String::new();
    sleep_ms(700);
    let outcome: Result<(), LaneError> = loop {
        if win.closed.load(Ordering::SeqCst) {
            break Err(("error".into(), title.clone(), "the page stopped".into()));
        }
        if let Some(st) = page_state(app, &win, None) {
            title = st.title.clone();
            if logic::is_clear(&st, origin) {
                break Ok(());
            }
            if st.blocked {
                break Err(("blocked".into(), title.clone(), "blocked".into()));
            }
            if logic::moved_away(&st, origin) {
                break Err(("error".into(), title.clone(), format!("the site sends its pages to {}", st.origin)));
            }
        }
        if started.elapsed() > timeout {
            break Err(("challenge".into(), title.clone(), "challenge".into()));
        }
        sleep_ms(500);
    };
    settle(&lane, outcome.clone());
    match outcome {
        Ok(()) => {
            share_cookies(app, Some(&win.label), page);
            Ok(lane)
        }
        Err(e) => {
            {
                let mut g = lock(lanes());
                if g.get(origin).map(|l| Arc::ptr_eq(l, &lane)).unwrap_or(false) {
                    g.remove(origin);
                }
            }
            close(app, &win);
            Err(e)
        }
    }
}

/// main.cjs's refusal: the site would not let the browser through — a check for the reader to pass, or a refusal.
fn refusal(url: &str, blocked: bool, title: &str) -> Value {
    let html = logic::refusal_html(title, blocked);
    let headers = if blocked {
        json!({ "content-type": "text/html; charset=utf-8", "x-kr-lane": "blocked" })
    } else {
        json!({ "content-type": "text/html; charset=utf-8", "cf-mitigated": "challenge", "x-kr-lane": "challenge" })
    };
    json!({ "status": 403, "headers": headers, "body": util::b64_encode(html.as_bytes()), "url": url, "via": "browser" })
}

/// kr:browser-fetch: { url, method?, headers?, body?, bodyBase64?, timeout?, page?, openTimeout? } → { status,
/// headers, body (base64: bridge.js makes it text as it does http's), url, via: 'browser' }.
fn browser_fetch(app: &AppHandle, o: &Value) -> Result<Value, String> {
    let url = text(o, "url");
    let origin = logic::origin_of(&url).ok_or_else(|| "Bad address".to_string())?;
    let page = match text(o, "page") {
        p if !p.is_empty() => p,
        _ => format!("{}/", origin),
    };
    let open_timeout = Duration::from_millis(millis(o, "openTimeout").unwrap_or(25_000));
    let lane = match open_lane(app, &origin, &page, open_timeout) {
        Ok(l) => l,
        Err((why, title, msg)) => {
            if why == "blocked" || why == "challenge" {
                return Ok(refusal(&url, why == "blocked", &title));
            }
            return Err(format!("Browser could not open the site: {}", msg));
        }
    };
    lane.busy.fetch_add(1, Ordering::SeqCst);
    *lock(&lane.used) = Instant::now();
    let timeout = millis(o, "timeout").unwrap_or(90_000);
    let method = match text(o, "method") {
        m if m.is_empty() => "GET".to_string(),
        m => m,
    };
    let req = json!({
        "url": url.as_str(),
        "method": method,
        "headers": o.get("headers").cloned().unwrap_or_else(|| json!({})),
        "body": o.get("body").cloned().unwrap_or(Value::Null),
        "bodyBase64": flag(o, "bodyBase64"),
        "timeout": timeout,
    });
    let rid = next_rid();
    let js = FETCH_JS
        .replace("__S__", &sender_call(&lane.win))
        .replace("__RID__", &js_str(&rid))
        .replace("__O__", &req.to_string());
    let answer = ask(app, &lane.win, &rid, &js, Duration::from_millis(timeout + 15_000));
    lane.busy.fetch_sub(1, Ordering::SeqCst);
    *lock(&lane.used) = Instant::now();
    let a = answer.ok_or_else(|| format!("Browser request timed out ({})", lock(&LAST_WAIT).clone()))?;
    if let Some(e) = a.meta.get("error") {
        return Err(e.as_str().map(|s| s.to_string()).unwrap_or_else(|| e.to_string()));
    }
    let final_url = match text(&a.meta, "url") {
        u if u.is_empty() => url.clone(),
        u => u,
    };
    Ok(json!({
        "status": a.meta.get("status").cloned().unwrap_or(json!(0)),
        "headers": a.meta.get("headers").cloned().unwrap_or_else(|| json!({})),
        "body": util::b64_encode(&a.body),
        "url": final_url,
        "via": "browser",
    }))
}

/* ---------- a check passed, a site opened for the reader ---------- */

fn not_passed() -> Value {
    json!({ "passed": false, "blocked": false, "title": "" })
}

/// The browser as a browser (main.cjs's openBrowse): resolves when the reader closes it.
fn browse(app: &AppHandle, o: &Value, url: &str) -> Value {
    let cfg = json!({
        "back": text(o, "back"),
        "forward": text(o, "forward"),
        "reload": text(o, "reload"),
        "placeholder": text(o, "placeholder"),
        "rtl": flag(o, "rtl"),
    });
    let message = text(o, "message");
    let title = if message.is_empty() { url.to_string() } else { message };
    let spec = Spec { kind: "browse", url, title: &title, visible: true, width: 1100.0, height: 860.0, until: None, browse: Some(cfg) };
    let win = match open_window(app, &spec) {
        Ok(w) => w,
        Err(_) => return not_passed(),
    };
    let mut shared_at = Instant::now();
    while !win.closed.load(Ordering::SeqCst) {
        rest(&win, 1000);
        // (What the reader does there reaches the app's requests as it goes — the window cannot be read once closed.)
        if shared_at.elapsed() > Duration::from_secs(5) && !win.closed.load(Ordering::SeqCst) {
            share_cookies(app, Some(&win.label), url);
            shared_at = Instant::now();
        }
    }
    share_cookies(app, None, url);
    json!({ "passed": true, "blocked": false, "title": "" })
}

/// kr:open-webview (main.cjs): { url, hidden?, timeout?, fresh?, message?, stay?, until?, browse?, … } → { passed,
/// blocked, title, url? } — passed once the site shows a page of its own (no check on it), blocked when it refuses
/// outright; `hidden` out of sight (15 s), else in a window titled with `message` that the reader acts in (5 min);
/// `fresh` clears the site's old clearance first; `stay` keeps the window until the reader closes it; `until` closes
/// it once its address matches (the address given back); `browse` opens the browser as a browser.
fn open_webview(app: &AppHandle, o: &Value) -> Value {
    let url = text(o, "url");
    let origin = logic::origin_of(&url);
    let hidden = flag(o, "hidden");
    if flag(o, "browse") && !hidden && origin.is_some() {
        return browse(app, o, &url);
    }
    let origin = match origin {
        Some(x) => x,
        None => return not_passed(),
    };
    let stay = flag(o, "stay") && !hidden;
    let timeout = Duration::from_millis(millis(o, "timeout").unwrap_or(if hidden { 15_000 } else { 300_000 }));
    if flag(o, "fresh") {
        forget(app, &url, false);
    }
    let message = text(o, "message");
    let title = if message.is_empty() { url.clone() } else { message };
    let until: Option<String> = o.get("until").and_then(|v| v.as_str()).map(|s| s.to_string()).filter(|s| !s.is_empty());
    let spec = Spec {
        kind: "check",
        url: &url,
        title: &title,
        visible: !hidden,
        width: 980.0,
        height: 820.0,
        until: until.as_deref(),
        browse: None,
    };
    let win = match open_window(app, &spec) {
        Ok(w) => w,
        Err(_) => return not_passed(),
    };
    let started = Instant::now();
    let (mut passed, mut blocked, mut page_title) = (false, false, String::new());
    let mut hit: Option<String> = None;
    rest(&win, 800);
    loop {
        if let Some(h) = lock(&win.inbox).hit.clone() {
            hit = Some(h);
            break;
        }
        if win.closed.load(Ordering::SeqCst) {
            break;
        }
        let st = page_state(app, &win, until.as_deref());
        let mut clear = false;
        if let Some(st) = st.as_ref() {
            page_title = st.title.clone();
            blocked = st.blocked;
            if until.is_some() && !st.hit.is_empty() {
                hit = Some(st.hit.clone());
                break;
            }
            clear = logic::is_clear_for(st, &origin);
            if clear {
                passed = true;
                blocked = false;
            }
            if st.blocked && hidden {
                break;
            }
        }
        // (A window that stays — the site opened for the reader to use — closes only when they close it, or its
        // `until` is met.)
        if clear && !stay && until.is_none() {
            if !hidden {
                rest(&win, 900);
            }
            break;
        }
        if !stay && started.elapsed() > timeout {
            break;
        }
        rest(&win, if clear { 1500 } else { 600 });
    }
    if hit.is_some() {
        passed = true;
        blocked = false;
    }
    share_cookies(app, Some(&win.label), &url);
    if !win.closed.load(Ordering::SeqCst) {
        close(app, &win);
    }
    let mut r = json!({ "passed": passed, "blocked": blocked, "title": page_title });
    if let Some(h) = hit {
        r["url"] = Value::String(h);
    }
    r
}

/* ---------- downloads a site starts in a browser window ---------- */

/// A download the site offers: into the system's Downloads folder under the name it suggests (never over a file
/// there), a notification with its name and place when it is done. (Electron's browser windows ask where, with the
/// system's save dialog.)
#[cfg(kr_download_api)]
fn on_download(app: &AppHandle, event: tauri::webview::DownloadEvent<'_>) -> bool {
    match event {
        tauri::webview::DownloadEvent::Requested { url, destination, .. } => {
            let suggested: String = destination.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let name = logic::download_name(&suggested, url.as_str());
            let dir = match app.path().download_dir() {
                Ok(d) => d,
                Err(_) => destination.parent().map(|p| p.to_path_buf()).unwrap_or_else(std::env::temp_dir),
            };
            let _ = std::fs::create_dir_all(&dir);
            *destination = logic::unique_path(&dir, &name, &|p: &std::path::Path| p.exists());
            let to = destination.to_string_lossy().into_owned();
            lock(&DOWNLOADS).push(json!({ "url": url.as_str(), "requested": to.as_str() }));
            let mut d = lock(&DL_DEST);
            d.push((url.as_str().to_string(), to));
            if d.len() > 50 {
                d.remove(0);
            }
            true
        }
        tauri::webview::DownloadEvent::Finished { url, path, success, .. } => {
            let mut p: String = path.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
            // (A Mac's web view gives no path: the one it was sent to.)
            if p.is_empty() && success {
                if let Some((_, to)) = lock(&DL_DEST).iter().rev().find(|(u, _)| u == url.as_str()) {
                    p = to.clone();
                }
            }
            lock(&DOWNLOADS).push(json!({ "url": url.as_str(), "path": p.as_str(), "ok": success }));
            if success && !p.is_empty() && !frame::active() {
                use tauri_plugin_notification::NotificationExt;
                let name = std::path::Path::new(&p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let _ = app.notification().builder().title(name).body(p.clone()).show();
            }
            true
        }
        #[allow(unreachable_patterns)]
        _ => true,
    }
}

/* ---------- the commands (bridge.js: openWebView, browserFetch, browserReset, browserForget) ---------- */

fn run_blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> impl std::future::Future<Output = Result<T, String>> {
    let h = tauri::async_runtime::spawn_blocking(f);
    async move { h.await.map_err(|e| e.to_string()) }
}

/// kr:open-webview(o) (see open_webview).
#[tauri::command]
pub async fn kr_open_webview(app: AppHandle, o: Value) -> Result<Value, String> {
    run_blocking(move || open_webview(&app, &o)).await
}

/// kr:browser-fetch(o) (see browser_fetch).
#[tauri::command]
pub async fn kr_browser_fetch(app: AppHandle, o: Value) -> Result<Value, String> {
    run_blocking(move || browser_fetch(&app, &o)).await?
}

/// kr:browser-reset(url): the site's lane set aside (the next request opens it afresh) → true.
#[tauri::command]
pub async fn kr_browser_reset(app: AppHandle, url: String) -> Result<bool, String> {
    if let Some(origin) = logic::origin_of(&url) {
        retire(&app, &origin);
    }
    Ok(true)
}

/// kr:browser-forget(url, all) → { cleared } (see forget).
#[tauri::command]
pub async fn kr_browser_forget(app: AppHandle, url: String, all: bool) -> Result<Value, String> {
    let n = run_blocking(move || forget(&app, &url, all)).await?;
    Ok(json!({ "cleared": n }))
}

/* ---------- the self-test's hands (only in a self-test run) ---------- */

/// A script the self-test runs in a hidden browser window on `url` (opened for it, closed after): "probe" — the
/// site's page tries the app's commands —, "click" — `sel` clicked —; and "windows" (the browser windows open),
/// "close" (all closed), "downloads" (what sites downloaded), "via" (how answers come).
#[tauri::command]
pub async fn kr_selftest_browser(app: AppHandle, o: Value) -> Result<Value, String> {
    if !frame::active() {
        return Err("not a self-test run".to_string());
    }
    run_blocking(move || selftest_act(&app, &o)).await?
}

/// The names of the browser's cookies for `url` (None: this build cannot read them).
fn cookie_names(app: &AppHandle, url: &str) -> Option<Vec<String>> {
    #[cfg(kr_cookie_read)]
    {
        return with_profile(app, None, |w| match url.parse() {
            Ok(u) => w.cookies_for_url(u).map(|l| l.iter().map(|c| c.name().to_string()).collect()).unwrap_or_default(),
            Err(_) => Vec::new(),
        });
    }
    #[cfg(not(kr_cookie_read))]
    {
        let _ = (app, url);
        None
    }
}

const PROBE_JS: &str = r#"(function(){var S=__S__;var rid=__RID__;var p=__P__;
function call(cmd,args){return new Promise(function(res){var i=window.__TAURI_INTERNALS__;if(!i||typeof i.invoke!=='function'){res('no ipc');return;}var done=false;
var t=setTimeout(function(){if(!done){done=true;res('no answer');}},5000);
try{Promise.resolve(i.invoke(cmd,args)).then(function(v){if(!done){done=true;clearTimeout(t);var s;try{s=JSON.stringify(v);}catch(e){s=String(v);}res('ALLOWED: '+String(s).slice(0,80));}},function(e){if(!done){done=true;clearTimeout(t);res('refused: '+String(e&&e.message||e).slice(0,160));}});}catch(e){done=true;clearTimeout(t);res('refused: '+String(e&&e.message||e).slice(0,160));}});}
var out={tauri:typeof window.__TAURI__,internals:typeof window.__TAURI_INTERNALS__,bridge:typeof window.kurokawaDesktop,mode:S.mode()};
Promise.all([call('kr_folder_read',{p:p}),call('kr_file_size',{p:p}),call('kr_open_webview',{o:{url:location.href,hidden:true}}),call('plugin:app|version',{}),call('plugin:event|emit',{event:'kr:titleBarState',payload:{probe:1}})]).then(function(r){
out.appCommand=r[0];out.appCommand2=r[1];out.browserCommand=r[2];out.plugin=r[3];out.event=r[4];S.send(rid,out,null);});})();"#;

const CLICK_JS: &str = r#"(function(){var S=__S__;var rid=__RID__;var sel=__P__;var e=null;try{e=document.querySelector(sel);}catch(x){}
S.send(rid,{found:!!e},null);if(e)setTimeout(function(){e.click();},400);})();"#;

fn selftest_act(app: &AppHandle, o: &Value) -> Result<Value, String> {
    let act = text(o, "act");
    match act.as_str() {
        "windows" => {
            let list: Vec<String> = lock(wins()).keys().cloned().collect();
            Ok(json!({ "windows": list, "lanes": lock(lanes()).keys().cloned().collect::<Vec<String>>() }))
        }
        "close" => Ok(json!({ "closed": close_all(app) })),
        "downloads" => Ok(json!({ "downloads": lock(&DOWNLOADS).clone() })),
        "forgetLeft" => Ok(json!({ "left": lock(&FORGET_LEFT).clone() })),
        "cookies" => Ok(json!({ "names": cookie_names(app, &text(o, "url")) })),
        "via" => Ok(json!({ "via": via_name() })),
        "probe" | "click" => {
            let url = text(o, "url");
            let origin = logic::origin_of(&url).ok_or_else(|| "Bad address".to_string())?;
            let spec = Spec { kind: "test", url: &url, title: "KurokawaReader", visible: false, width: 1000.0, height: 800.0, until: None, browse: None };
            let win = open_window(app, &spec)?;
            let started = Instant::now();
            let mut ready = false;
            sleep_ms(500);
            while started.elapsed() < Duration::from_secs(15) && !win.closed.load(Ordering::SeqCst) {
                if let Some(st) = page_state(app, &win, None) {
                    if logic::is_clear(&st, &origin) {
                        ready = true;
                        break;
                    }
                }
                sleep_ms(300);
            }
            if !ready {
                close(app, &win);
                return Err("the test page did not load".to_string());
            }
            let rid = next_rid();
            let tpl = if act == "probe" { PROBE_JS } else { CLICK_JS };
            let js = tpl
                .replace("__S__", &sender_call(&win))
                .replace("__RID__", &js_str(&rid))
                .replace("__P__", &js_str(&text(o, "p")));
            let wait = if act == "probe" { 30 } else { 10 };
            let a = ask(app, &win, &rid, &js, Duration::from_secs(wait));
            let mut out = match a {
                Some(a) => a.meta,
                None => json!({ "error": "no answer from the page" }),
            };
            if act == "click" {
                // (Where the page went after the click, and what it is.)
                sleep_ms(2500);
                if let Some(st) = page_state(app, &win, None) {
                    out["href"] = Value::String(st.href);
                    out["title"] = Value::String(st.title);
                }
                sleep_ms(1500);
            }
            out["windowsBefore"] = json!(lock(wins()).len());
            close(app, &win);
            Ok(out)
        }
        other => Err(format!("unknown act: {}", other)),
    }
}
