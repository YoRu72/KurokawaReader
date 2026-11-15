//! A stand-in backend with no crate (host tests only: `rustc --cfg kt_fake`, see test-host.sh): torrents that exist
//! only in memory, so the JNI shape, the dispatch's table, the polls, the pause paths, the failures and the hand-back
//! are tested on a machine without crates.io. A magnet's own parameters steer it: `dn` its name, `xl` its size,
//! `kt-fail=meta` (no metadata), `kt-fail=after` (fails once bytes came), `kt-nopause=1` (a build without librqbit's
//! pause), `kt-stuck=1` (stands still one 32 KiB piece short until it is dropped and added again — CI run 43684755996). Its file's byte at offset i is (i·31 + 7) mod 251. It is never in an APK.

use crate::contract::{Added, Live, Meta, Src};
use kt_core::tormobile::Stats;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

pub const NAME: &str = "fake";
pub const BUILD: &str = "stand-in";

struct T {
    size: u64,
    have: u64,
    paused: bool,
    fail_after: bool,
    nopause: bool,
    stuck: bool,
    name: String,
}

/// Names that were stuck once and dropped: added again they finish.
fn unstuck() -> std::sync::MutexGuard<'static, std::collections::HashSet<String>> {
    static U: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    U.get_or_init(|| Mutex::new(Default::default())).lock().unwrap_or_else(|e| e.into_inner())
}

fn m() -> std::sync::MutexGuard<'static, (bool, usize, HashMap<usize, T>)> {
    static M: OnceLock<Mutex<(bool, usize, HashMap<usize, T>)>> = OnceLock::new();
    M.get_or_init(|| Mutex::new((false, 1, HashMap::new()))).lock().unwrap_or_else(|e| e.into_inner())
}

fn param(m: &str, k: &str) -> Option<String> {
    m.split(['?', '&']).find_map(|kv| kv.strip_prefix(&format!("{}=", k)).map(|v| v.to_string()))
}

pub fn byte_at(i: u64) -> u8 {
    ((i * 31 + 7) % 251) as u8
}

pub fn start(_p: &kt_core::tormobile::SessionPlan) -> Result<(), String> {
    m().0 = true;
    Ok(())
}
pub fn shutdown() -> Result<(), String> {
    let mut g = m();
    g.0 = false;
    g.2.clear();
    Ok(())
}
pub fn meta(magnet: &str) -> Result<Meta, String> {
    if param(magnet, "kt-fail").as_deref() == Some("meta") {
        std::thread::sleep(std::time::Duration::from_millis(50));
        return Err("no metadata in 90 s".into());
    }
    let name = param(magnet, "dn").unwrap_or_else(|| "fake".into());
    let size = param(magnet, "xl").and_then(|v| v.parse().ok()).unwrap_or(1 << 20);
    Ok(Meta { name: name.clone(), multi: false, files: vec![(name, size)] })
}
pub fn add(src: &Src, _folder: &str, _only: Option<&[usize]>) -> Result<Added, String> {
    let mag = match src {
        Src::Magnet(s) => s.clone(),
        Src::Bytes(_) => "magnet:?dn=bytes&xl=65536".into(),
    };
    let me = meta(&mag)?;
    let mut g = m();
    if !g.0 {
        return Err("no session".into());
    }
    let rid = g.1;
    g.1 += 1;
    g.2.insert(rid, T { size: me.files[0].1, have: 0, paused: false, fail_after: param(&mag, "kt-fail").as_deref() == Some("after"), nopause: param(&mag, "kt-nopause").is_some(), stuck: param(&mag, "kt-stuck").is_some() && !unstuck().contains(&me.name), name: me.name.clone() });
    Ok(Added { rid, name: me.name, files: me.files })
}
pub fn stats(rid: usize) -> Result<Live, String> {
    let mut g = m();
    let t = g.2.get_mut(&rid).ok_or("gone")?;
    if t.fail_after && t.have > 0 {
        return Err("peer connection broke the disk".into());
    }
    if !t.paused {
        t.have = (t.have + t.size / 4).min(if t.stuck { t.size.saturating_sub(32768) } else { t.size });
    }
    let _ = &t.name;
    Ok(Live {
        stats: Stats { state: if t.paused { "paused".into() } else { "live".into() }, have_metadata: true, progress_bytes: t.have, total_bytes: t.size, down_bps: if t.paused { 0 } else { 1000 }, up_bps: 0, peers: 1, finished: t.have >= t.size, ..Default::default() },
        file_done: Some(vec![t.have]),
    })
}
pub fn pause(rid: usize) -> Result<bool, String> {
    let mut g = m();
    let t = g.2.get_mut(&rid).ok_or("gone")?;
    if t.nopause {
        return Ok(false);
    }
    t.paused = true;
    Ok(true)
}
pub fn unpause(rid: usize) -> Result<bool, String> {
    let mut g = m();
    let t = g.2.get_mut(&rid).ok_or("gone")?;
    t.paused = false;
    Ok(true)
}
pub fn remove(rid: usize, _delete: bool) -> Result<(), String> {
    let t = m().2.remove(&rid).ok_or_else(|| "gone".to_string())?;
    if t.stuck {
        unstuck().insert(t.name);
    }
    Ok(())
}
pub fn only_files(rid: usize, _only: &[usize]) -> Result<(), String> {
    m().2.get(&rid).map(|_| ()).ok_or_else(|| "gone".into())
}
pub fn read(rid: usize, file: usize, off: u64, len: usize, _timeout_ms: u64) -> Result<Vec<u8>, String> {
    let g = m();
    let t = g.2.get(&rid).ok_or("gone")?;
    if file != 0 || off >= t.size {
        return Err("past the end".into());
    }
    let n = (len as u64).min(t.size - off);
    Ok((off..off + n).map(byte_at).collect())
}
pub fn limits(_down: Option<u64>, _up: Option<u64>) -> Result<bool, String> {
    Ok(true)
}
