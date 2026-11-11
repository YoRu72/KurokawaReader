// kt:http and kt:checkUpdate (desktop/main.cjs), with reqwest instead of Electron's net.fetch.
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::util;

/// The releases the app updates from (desktop/package.json's kurokawa.repo).
const REPO: &str = "YoRu72/KurokawaReader";

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> Result<&'static reqwest::Client, String> {
    if let Some(c) = CLIENT.get() {
        return Ok(c);
    }
    let ua = format!(
        "Mozilla/5.0 (compatible) KurokawaTools/{} (Tauri)",
        env!("CARGO_PKG_VERSION")
    );
    let built = reqwest::Client::builder()
        .user_agent(ua.as_str())
        .redirect(reqwest::redirect::Policy::limited(20))
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(CLIENT.get_or_init(|| built))
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

/// kt:checkUpdate: the newest tools-v* release that is not a draft, if newer than `current` →
/// { version, url, notes, asset? }; null otherwise.
pub async fn check_update(current: &str) -> Result<Value, String> {
    let url = format!("https://api.github.com/repos/{}/releases?per_page=30", REPO);
    let resp = client()?
        .get(url.as_str())
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
    let list: Vec<Value> = match all {
        Value::Array(a) => a,
        _ => Vec::new(),
    };
    let mut best: Option<&Value> = None;
    let mut best_v = String::new();
    for r in list.iter() {
        let draft = r.get("draft").and_then(|d| d.as_bool()).unwrap_or(false);
        let tag = r.get("tag_name").and_then(|t| t.as_str()).unwrap_or("");
        if draft || !tag.starts_with("tools-v") {
            continue;
        }
        let v = tag[7..].to_string();
        if best.is_none() || util::cmp_versions(&v, &best_v) > 0 {
            best = Some(r);
            best_v = v;
        }
    }
    let j = match best {
        Some(j) => j,
        None => return Ok(Value::Null),
    };
    if util::cmp_versions(&best_v, current) <= 0 {
        return Ok(Value::Null);
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
    if let Some(a) = util::pick_asset(&names, util::node_platform()) {
        out["asset"] = Value::String(a.to_string());
    }
    Ok(out)
}
