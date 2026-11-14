//! The named methods Java calls through the one JNI function (no unsafe here). A method takes a JSON object of
//! arguments and answers `{"r": …}` (JSON text); a method whose name starts with `bytes.` takes the bytes beside the
//! arguments and answers bytes. To add one: a line in `METHODS`, an arm in `call_json` (or `call_raw`), a test below,
//! and the Java caller through `KtCore.call` / `KtCore.r` / `KtCore.callBytes` (ANDROID-PORT.md, «Adding a function»).

use kt_core::dlrules;
use kt_core::translatekey;
use kt_core::vidjson::{self, J};
use std::collections::HashSet;
use std::path::Path;

/// The call shape's version: Java refuses a library whose protocol it does not know (and falls back to Java).
pub const PROTOCOL: i64 = 1;

/// Every method, for `core.version` (Java's diagnostics show the count; tests check the table is whole).
pub const METHODS: &[&str] = &[
    "core.version",
    "core.echo",
    "core.sum",
    "core.panic",
    "bytes.echo",
    // M1: KtDlRules
    "dl.holdOf",
    "dl.holds",
    "dl.pickName",
    "dl.freeName",
    "dl.nextHostLimit",
    "dl.restartAfterStop",
    // M1: KtTranslate's cache key
    "tr.norm",
    "tr.glossaryKey",
    "tr.configId",
    "tr.cacheKey",
];

/// Bytes in, bytes out: what the JNI function hands over.
pub fn call_bytes(method: &[u8], args: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    let m = std::str::from_utf8(method).map_err(|_| "method: not UTF-8".to_string())?;
    if m.starts_with("bytes.") {
        return call_raw(m, args, data);
    }
    let text = std::str::from_utf8(args).map_err(|_| "args: not UTF-8".to_string())?;
    let a = if text.trim().is_empty() { J::Obj(Vec::new()) } else { vidjson::parse(text)? };
    if !matches!(a, J::Obj(_)) {
        return Err("args: not an object".to_string());
    }
    let r = call_json(m, &a)?;
    Ok(J::Obj(vec![("r".to_string(), r)]).to_json().into_bytes())
}

/// The bytes methods (the MEGA decrypt of M2 and the like come here).
fn call_raw(m: &str, _args: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    match m {
        "bytes.echo" => Ok(data.to_vec()),
        _ => Err(format!("no such method: {}", m)),
    }
}

/// The JSON methods: the answer's `r`.
pub fn call_json(m: &str, a: &J) -> Result<J, String> {
    match m {
        "core.version" => Ok(J::Obj(vec![
            ("version".to_string(), J::s(env!("CARGO_PKG_VERSION"))),
            ("protocol".to_string(), num(PROTOCOL)),
            ("target".to_string(), J::s(&format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS))),
            ("rev".to_string(), J::s(option_env!("KT_CORE_REV").unwrap_or(""))),
            ("methods".to_string(), J::Arr(METHODS.iter().map(|x| J::s(x)).collect())),
        ])),
        "core.echo" => Ok(a.clone()),
        "core.sum" => int(a, "a")?.checked_add(int(a, "b")?).map(num).ok_or_else(|| "overflow".to_string()),
        "core.panic" => panic!("asked to panic (core.panic)"),

        "dl.holdOf" => {
            let hs = opt_strs(a, "holds")?;
            Ok(opt_s(dlrules::hold_of(hs.as_deref(), boolean(a, "wifiOnlyAll")?, boolean(a, "taskWifiOnly")?, boolean(a, "anyway")?)))
        }
        "dl.holds" => Ok(J::Bool(dlrules::holds(&string(a, "reason")?, boolean(a, "wifiOnlyAll")?, boolean(a, "taskWifiOnly")?))),
        "dl.pickName" => {
            let dir = string(a, "dir")?;
            let reserved = opt_strs(a, "reserved")?.map(|v| v.into_iter().collect::<HashSet<String>>());
            Ok(opt_s(dlrules::pick_name(Path::new(&dir), &string(a, "safe")?, boolean(a, "begun")?, &string(a, "conflict")?, reserved.as_ref())))
        }
        "dl.freeName" => {
            let dir = string(a, "dir")?;
            let reserved = opt_strs(a, "reserved")?.map(|v| v.into_iter().collect::<HashSet<String>>());
            Ok(J::s(&dlrules::free_name(Path::new(&dir), &string(a, "name")?, reserved.as_ref())))
        }
        "dl.nextHostLimit" => Ok(match dlrules::next_host_limit(opt_int(a, "lim")?, int(a, "want")?, boolean(a, "refused")?, int(a, "connections")?) {
            Some(n) => num(n),
            None => J::Null,
        }),
        "dl.restartAfterStop" => Ok(J::Bool(dlrules::restart_after_stop(boolean(a, "resumedWhileStopping")?, boolean(a, "paused")?, &string(a, "state")?))),

        "tr.norm" => Ok(J::s(&translatekey::norm_spaces(&string(a, "text")?))),
        "tr.glossaryKey" => Ok(J::s(&translatekey::glossary_key(&pairs(a, "glossary")?))),
        "tr.configId" => Ok(J::s(&translatekey::config_id(&config(a)?))),
        "tr.cacheKey" => Ok(J::s(&translatekey::cache_key(&config(a)?, &string(a, "text")?))),

        _ => Err(format!("no such method: {}", m)),
    }
}

/* ---------- reading the arguments (a missing or mistyped one is an error, never a guess) ---------- */

fn num(n: i64) -> J {
    J::num(n as f64)
}
fn opt_s(s: Option<String>) -> J {
    s.map(|x| J::Str(x)).unwrap_or(J::Null)
}
fn field<'a>(a: &'a J, k: &str) -> Result<&'a J, String> {
    a.get(k).ok_or_else(|| format!("args: «{}» missing", k))
}
fn string(a: &J, k: &str) -> Result<String, String> {
    match field(a, k)? {
        J::Str(s) => Ok(s.clone()),
        _ => Err(format!("args: «{}» not a string", k)),
    }
}
fn boolean(a: &J, k: &str) -> Result<bool, String> {
    match field(a, k)? {
        J::Bool(b) => Ok(*b),
        _ => Err(format!("args: «{}» not a boolean", k)),
    }
}
fn int(a: &J, k: &str) -> Result<i64, String> {
    match field(a, k)? {
        J::Num(n, _) if n.fract() == 0.0 && n.abs() < 9.0e15 => Ok(*n as i64),
        _ => Err(format!("args: «{}» not a whole number", k)),
    }
}
fn opt_int(a: &J, k: &str) -> Result<Option<i64>, String> {
    match a.get(k) {
        None | Some(J::Null) => Ok(None),
        Some(_) => int(a, k).map(Some),
    }
}
fn opt_strs(a: &J, k: &str) -> Result<Option<Vec<String>>, String> {
    match a.get(k) {
        None | Some(J::Null) => Ok(None),
        Some(J::Arr(v)) => v.iter().map(|x| x.as_str().map(|s| s.to_string()).ok_or_else(|| format!("args: «{}» holds a non-string", k))).collect::<Result<Vec<_>, _>>().map(Some),
        Some(_) => Err(format!("args: «{}» not a list", k)),
    }
}
/// [[from, to], …]
fn pairs(a: &J, k: &str) -> Result<Vec<(String, String)>, String> {
    match a.get(k) {
        None | Some(J::Null) => Ok(Vec::new()),
        Some(J::Arr(v)) => v
            .iter()
            .map(|p| match p.as_arr().map(|x| x.as_slice()) {
                Some([J::Str(f), J::Str(t)]) => Ok((f.clone(), t.clone())),
                _ => Err(format!("args: «{}» holds a bad pair", k)),
            })
            .collect(),
        Some(_) => Err(format!("args: «{}» not a list", k)),
    }
}
fn config(a: &J) -> Result<translatekey::Config, String> {
    Ok(translatekey::Config {
        engine: string(a, "engine")?,
        source: string(a, "source")?,
        target: string(a, "target")?,
        style: string(a, "style")?,
        base: string(a, "base")?,
        model: string(a, "model")?,
        prompt: string(a, "prompt")?,
        glossary: pairs(a, "glossary")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(m: &str, args: &str) -> Result<String, String> {
        call_bytes(m.as_bytes(), args.as_bytes(), &[]).map(|b| String::from_utf8(b).unwrap())
    }

    #[test]
    fn core_methods() {
        let v = call("core.version", "").unwrap();
        assert!(v.starts_with("{\"r\":{\"version\":\"0.1.0\",\"protocol\":1,"), "{}", v);
        assert_eq!(call("core.sum", r#"{"a":2,"b":40}"#).unwrap(), r#"{"r":42}"#);
        assert_eq!(call("core.sum", r#"{"a":-7,"b":3}"#).unwrap(), r#"{"r":-4}"#);
        assert!(call("core.sum", r#"{"a":1}"#).unwrap_err().contains("«b» missing"));
        assert!(call("core.sum", r#"{"a":1.5,"b":1}"#).is_err());
        assert_eq!(call("core.echo", r#"{"s":"مرحبا \u0000 😀","n":null}"#).unwrap(), "{\"r\":{\"s\":\"مرحبا \\u0000 😀\",\"n\":null}}");
        assert!(call("nope", "{}").unwrap_err().contains("no such method"));
        assert!(call("core.sum", "[1]").is_err());
        assert!(call("core.sum", "{bad").is_err());
        assert_eq!(call_bytes(b"bytes.echo", b"", &[0, 1, 255]).unwrap(), vec![0, 1, 255]);
        assert!(call_bytes(&[0xff], b"", &[]).is_err());
    }

    #[test]
    fn panics_are_caught_as_jni_does() {
        let r = std::panic::catch_unwind(|| call_bytes(b"core.panic", b"{}", &[]));
        let p = r.unwrap_err();
        assert_eq!(crate::panic_text(&p), "panic: asked to panic (core.panic)");
        assert_eq!(crate::frame(Err("x".into())), vec![1, b'x']);
        assert_eq!(crate::frame(Ok(vec![7])), vec![0, 7]);
    }

    #[test]
    fn every_method_answers_or_says_why() {
        for m in METHODS {
            if *m == "core.panic" {
                continue;
            }
            let r = call_bytes(m.as_bytes(), b"{}", &[]);
            if let Err(e) = r {
                assert!(!e.contains("no such method"), "{} is in METHODS but not dispatched", m);
            }
        }
    }

    #[test]
    fn dl_rules() {
        assert_eq!(call("dl.holdOf", r#"{"holds":["battery","metered"],"wifiOnlyAll":false,"taskWifiOnly":false,"anyway":false}"#).unwrap(), r#"{"r":"battery"}"#);
        assert_eq!(call("dl.holdOf", r#"{"holds":null,"wifiOnlyAll":true,"taskWifiOnly":true,"anyway":false}"#).unwrap(), r#"{"r":null}"#);
        assert_eq!(call("dl.holds", r#"{"reason":"metered","wifiOnlyAll":false,"taskWifiOnly":true}"#).unwrap(), r#"{"r":true}"#);
        assert_eq!(call("dl.nextHostLimit", r#"{"lim":null,"want":8,"refused":true,"connections":3}"#).unwrap(), r#"{"r":3}"#);
        assert_eq!(call("dl.nextHostLimit", r#"{"want":8,"refused":false,"connections":8}"#).unwrap(), r#"{"r":null}"#);
        assert_eq!(call("dl.restartAfterStop", r#"{"resumedWhileStopping":true,"paused":false,"state":"queued"}"#).unwrap(), r#"{"r":true}"#);
        let dir = std::env::temp_dir().join(format!("kt-android-dispatch-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let d = vidjson::J::s(&dir.to_string_lossy()).to_json();
        assert_eq!(call("dl.pickName", &format!(r#"{{"dir":{},"safe":"ep.mkv","begun":false,"conflict":"rename","reserved":["ep.mkv"]}}"#, d)).unwrap(), r#"{"r":"ep (2).mkv"}"#);
        assert_eq!(call("dl.freeName", &format!(r#"{{"dir":{},"name":"ep.mkv","reserved":null}}"#, d)).unwrap(), r#"{"r":"ep (2).mkv"}"#);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tr_keys() {
        assert_eq!(call("tr.norm", r#"{"text":"  a \n b  "}"#).unwrap(), "{\"r\":\"a\\nb\"}");
        assert_eq!(call("tr.glossaryKey", r#"{"glossary":[["Kurokawa","كوروكاوا"]]}"#).unwrap(), r#"{"r":"6baiw9"}"#);
        let cfg = r#""engine":"google","source":"auto","target":"ar","style":"openai","base":"","model":"","prompt":"","glossary":[]"#;
        assert_eq!(call("tr.configId", &format!("{{{}}}", cfg)).unwrap(), r#"{"r":"google|auto|ar||0"}"#);
        assert_eq!(call("tr.cacheKey", &format!(r#"{{{},"text":" x  y "}}"#, cfg)).unwrap(), "{\"r\":\"google|auto|ar||0\\u0000x y\"}");
        assert!(call("tr.glossaryKey", r#"{"glossary":[["only one"]]}"#).is_err());
    }
}
