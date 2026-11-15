//! Stage M3: the torrent director's `tdir.*` methods (kt-core's tordirector — the streaming brain that drives
//! libtorrent4j's piece priorities and deadlines from Java's KtTorDirector) and the engine rules Java asks before a
//! torrent is added or after the Rust engine failed (`tor.choose`, `tor.onFail`; kt-core's tormobile). A watched file is
//! a director kept here by a number (`h`) from `tdir.open` to `tdir.close`. No unsafe code.

use crate::dispatch::{boolean, int, num, string};
use kt_core::tordirector::{Director, Geometry};
use kt_core::tormobile::{self, AddFacts, OnFail};
use kt_core::vidjson::J;
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};

struct Table {
    next: i64,
    d: HashMap<i64, Director>,
}

fn table() -> MutexGuard<'static, Table> {
    static T: OnceLock<Mutex<Table>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(Table { next: 1, d: HashMap::new() })).lock().unwrap_or_else(|e| e.into_inner())
}

fn obj(v: Vec<(&str, J)>) -> J {
    J::Obj(v.into_iter().map(|(k, x)| (k.to_string(), x)).collect())
}
fn uint(a: &J, k: &str) -> Result<u64, String> {
    let n = int(a, k)?;
    if n < 0 {
        return Err(format!("args: «{}» negative", k));
    }
    Ok(n as u64)
}
fn num_f(a: &J, k: &str) -> Result<f64, String> {
    match a.get(k) {
        Some(J::Num(n, _)) => Ok(*n),
        _ => Err(format!("args: «{}» not a number", k)),
    }
}
fn opt_string(a: &J, k: &str) -> Result<String, String> {
    match a.get(k) {
        None | Some(J::Null) => Ok(String::new()),
        Some(J::Str(s)) => Ok(s.clone()),
        Some(_) => Err(format!("args: «{}» not a string", k)),
    }
}

/// The pieces here, as a hex bitfield (high bit first) of the pieces from `from` on: a piece outside it is «not here».
pub(crate) fn have_fn(hex: &str, from: u64) -> Result<impl Fn(u64) -> bool, String> {
    let bytes: Vec<u8> = hex.bytes().collect();
    if !bytes.iter().all(|b| b.is_ascii_hexdigit()) {
        return Err("args: «have» not hex".into());
    }
    Ok(move |k: u64| {
        if k < from {
            return false;
        }
        let i = (k - from) as usize;
        match bytes.get(i / 4) {
            Some(c) => {
                let v = (*c as char).to_digit(16).unwrap_or(0);
                v & (8 >> (i % 4)) != 0
            }
            None => false,
        }
    })
}

pub fn call(m: &str, a: &J) -> Result<J, String> {
    match m {
        "tdir.open" => {
            let g = Geometry { piece_len: uint(a, "pieceLen")?, num_pieces: uint(a, "numPieces")?, file_off: uint(a, "fileOff")?, file_len: uint(a, "fileLen")? };
            if g.piece_len == 0 || g.num_pieces == 0 || g.file_len == 0 || g.piece_len.checked_mul(g.num_pieces).map_or(true, |t| g.file_off.saturating_add(g.file_len) > t) {
                return Err("bad geometry".into());
            }
            let mut t = table();
            // (A player that never closes cannot grow the table without end: the oldest go first past 64.)
            if t.d.len() >= 64 {
                if let Some(&k) = t.d.keys().min() {
                    t.d.remove(&k);
                }
            }
            let h = t.next;
            t.next += 1;
            t.d.insert(h, Director::new(g, uint(a, "now")?));
            Ok(obj(vec![("h", num(h)), ("first", num(g.first_piece() as i64)), ("last", num(g.last_piece() as i64))]))
        }
        "tdir.hint" => with(a, |d| {
            d.hint_byte_rate(num_f(a, "rate")?);
            Ok(J::Null)
        }),
        "tdir.rate" => with(a, |d| {
            d.observe_rate(uint(a, "bps")?);
            Ok(J::Null)
        }),
        "tdir.read" => with(a, |d| Ok(J::Bool(d.read(uint(a, "pos")?, uint(a, "now")?)))),
        "tdir.plan" => with(a, |d| {
            let have = have_fn(&string(a, "have")?, uint(a, "from")?)?;
            let p = d.plan(&have, uint(a, "now")?);
            Ok(obj(vec![
                ("clear", J::Bool(p.clear_deadlines)),
                ("deadlines", J::Arr(p.deadlines.iter().map(|&(k, ms)| J::Arr(vec![num(k as i64), num(ms as i64)])).collect())),
                ("high", J::Arr(p.high.iter().map(|&(x, y)| J::Arr(vec![num(x as i64), num(y as i64)])).collect())),
                ("window", num(p.window as i64)),
                ("horizon", num(p.horizon_s as i64)),
                ("mode", J::s(p.mode)),
            ]))
        }),
        "tdir.close" => {
            let h = int(a, "h")?;
            Ok(J::Bool(table().d.remove(&h).is_some()))
        }
        "tor.choose" => {
            let f = AddFacts {
                choice: string(a, "choice")?,
                core: true,
                torrent_lib: boolean(a, "torrentLib")?,
                dir: string(a, "dir")?,
                proxy: boolean(a, "proxy")?,
                bind_iface: opt_string(a, "bindIface")?,
                anonymous: boolean(a, "anonymous")?,
                enc: opt_string(a, "enc")?,
                rust_failed_before: boolean(a, "failedBefore")?,
            };
            let (e, why) = tormobile::choose(&f);
            Ok(obj(vec![("engine", J::s(e.name())), ("why", J::s(why))]))
        }
        "tor.onFail" => Ok(J::s(match tormobile::on_fail(boolean(a, "haveMetadata")?, uint(a, "bytes")?, boolean(a, "userStopped")?) {
            OnFail::RestartClassic => "restartClassic",
            OnFail::PauseForClassic => "pauseForClassic",
            OnFail::Ignore => "ignore",
        })),
        _ => Err(format!("no such method: {}", m)),
    }
}

fn with(a: &J, f: impl FnOnce(&mut Director) -> Result<J, String>) -> Result<J, String> {
    let h = int(a, "h")?;
    let mut t = table();
    let d = t.d.get_mut(&h).ok_or("no such director")?;
    f(d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use kt_core::vidjson;

    fn c(m: &str, args: &str) -> Result<J, String> {
        call(m, &vidjson::parse(args).unwrap())
    }

    #[test]
    fn a_director_through_the_table() {
        let o = c("tdir.open", r#"{"pieceLen":262144,"numPieces":1604,"fileOff":1048576,"fileLen":419430400,"now":0}"#).unwrap();
        let h = o.get("h").unwrap().number() as i64;
        assert_eq!(o.get("first").unwrap().number(), 4.0);
        c("tdir.hint", &format!(r#"{{"h":{},"rate":1000000}}"#, h)).unwrap();
        let p = c("tdir.plan", &format!(r#"{{"h":{},"now":0,"have":"","from":4}}"#, h)).unwrap();
        let dl = p.get("deadlines").unwrap().as_arr().unwrap();
        assert!(!dl.is_empty());
        assert_eq!(p.get("mode").unwrap().as_str(), Some("start"));
        // (The first four pieces here: not asked.)
        let p = c("tdir.plan", &format!(r#"{{"h":{},"now":100,"have":"f","from":4}}"#, h)).unwrap();
        assert!(p.get("deadlines").unwrap().as_arr().unwrap().iter().all(|x| x.as_arr().unwrap()[0].number() >= 8.0));
        assert_eq!(c("tdir.read", &format!(r#"{{"h":{},"pos":300000000,"now":5000}}"#, h)).unwrap(), J::Bool(true));
        assert_eq!(c("tdir.close", &format!(r#"{{"h":{}}}"#, h)).unwrap(), J::Bool(true));
        assert!(c("tdir.plan", &format!(r#"{{"h":{},"now":0,"have":"","from":0}}"#, h)).is_err());
        assert!(c("tdir.open", r#"{"pieceLen":0,"numPieces":1,"fileOff":0,"fileLen":1,"now":0}"#).is_err());
        assert!(c("tdir.plan", r#"{"h":1,"now":0,"have":"zz","from":0}"#).is_err());
    }

    #[test]
    fn bitfield() {
        let f = have_fn("a0", 10).unwrap();
        assert!(f(10) && !f(11) && f(12) && !f(13) && !f(9) && !f(18));
    }

    #[test]
    fn engine_rules() {
        let r = c("tor.choose", r#"{"choice":"rust","torrentLib":false,"dir":"/sdcard/x","proxy":false,"anonymous":false,"failedBefore":false}"#).unwrap();
        assert_eq!(r.get("engine").unwrap().as_str(), Some("classic"));
        let r = c("tor.choose", r#"{"choice":"rust","torrentLib":true,"dir":"content://x","proxy":false,"anonymous":false,"failedBefore":false,"enc":"enabled"}"#).unwrap();
        assert_eq!((r.get("engine").unwrap().as_str(), r.get("why").unwrap().as_str()), (Some("director"), Some("safFolder")));
        assert_eq!(c("tor.onFail", r#"{"haveMetadata":true,"bytes":10,"userStopped":false}"#).unwrap(), J::s("pauseForClassic"));
        assert!(c("tor.onFail", r#"{"haveMetadata":true}"#).is_err());
    }
}
