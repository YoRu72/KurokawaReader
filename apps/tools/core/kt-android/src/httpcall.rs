//! Stage M2: the HTTP downloader's `http.*` methods (kt-core's httpdl — KrDownloader.java's rules — asked by Java's
//! KrDownloaderRs, which moves the bytes) and `bytes.megaCtr` (MEGA's AES-128-CTR at any offset, as Java's CtrFile
//! writes). A download under way is a session kept here by a number (`h`) from `http.begin` to `http.close`; every
//! call holds the table's lock only while its rule runs. No unsafe code.

use crate::dispatch::{boolean, field, int, num, string};
use kt_core::httpdl::{self, Dl, End, Head, Kind, Need, Next, OnError, Planner, Record};
use kt_core::mega;
use kt_core::vidjson::J;
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};

/// A download being planned (with what its run will need), or under way.
enum Session {
    Plan { p: Planner, scale: bool, retries: i64, refused: bool },
    Run(Dl),
}

struct Table {
    next: i64,
    s: HashMap<i64, Session>,
}

fn table() -> MutexGuard<'static, Table> {
    static T: OnceLock<Mutex<Table>> = OnceLock::new();
    // (A panic while the lock was held leaves it poisoned: the table itself is still sound — each rule changes its
    // session in one step — so it is taken as it is rather than failing every download after.)
    T.get_or_init(|| Mutex::new(Table { next: 1, s: HashMap::new() })).lock().unwrap_or_else(|e| e.into_inner())
}

fn obj(v: Vec<(&str, J)>) -> J {
    J::Obj(v.into_iter().map(|(k, x)| (k.to_string(), x)).collect())
}
fn opt_str(a: &J, k: &str) -> Result<Option<String>, String> {
    match a.get(k) {
        None | Some(J::Null) => Ok(None),
        Some(J::Str(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("args: «{}» not a string", k)),
    }
}
fn list<'a>(a: &'a J, k: &str) -> Result<&'a Vec<J>, String> {
    field(a, k)?.as_arr().ok_or_else(|| format!("args: «{}» not a list", k))
}
fn seg(a: &J) -> Result<usize, String> {
    let s = int(a, "seg")?;
    if s < 0 {
        return Err("args: «seg» negative".into());
    }
    Ok(s as usize)
}
fn text_or_null(t: Option<String>) -> J {
    t.map(J::Str).unwrap_or(J::Null)
}

fn need_json(n: Need, p: &Planner) -> J {
    match n {
        Need::Zero(at) => obj(vec![("k", J::s("zero")), ("at", J::Arr(at.into_iter().map(num).collect()))]),
        Need::Check { chunks, windows, threads } => obj(vec![
            ("k", J::s("check")),
            ("chunks", J::Arr(chunks.into_iter().map(num).collect())),
            ("windows", J::Arr(windows.into_iter().map(|w| J::Arr(w.into_iter().map(|(f, l)| J::Arr(vec![num(f), num(l)])).collect())).collect())),
            ("threads", num(threads)),
        ]),
        Need::Go => obj(vec![("k", J::s("go")), ("n", num(p.n))]),
    }
}

/// A planned session turned into its run: what Java needs to begin (the file's size set, the done stretches drawn,
/// the counter, the record written).
fn go(t: &mut Table, h: i64, now: i64) -> Result<J, String> {
    let (p, scale, retries, refused) = match t.s.remove(&h) {
        Some(Session::Plan { p, scale, retries, refused }) => (p, scale, retries, refused),
        Some(s) => {
            t.s.insert(h, s);
            return Err("not planning".into());
        }
        None => return Err("no such download".into()),
    };
    let rec = p.rec.clone().ok_or("no plan")?;
    let mut d = Dl::new(rec, p.n, scale, retries, refused, now);
    let (seq, record) = d.record();
    let runs = J::Arr(d.done_runs().into_iter().map(|(s, e)| J::Arr(vec![num(s), num(e)])).collect());
    let ans = obj(vec![
        ("k", J::s("go")),
        ("n", num(d.n)),
        ("first", num(d.first)),
        ("chunk", num(d.chunk)),
        ("chunks", num(d.chunks)),
        ("total", num(d.total)),
        ("have", num(d.have)),
        ("runs", runs),
        ("record", J::Str(record)),
        ("seq", num(seq)),
        ("fresh", J::Bool(p.fresh)),
        ("grow", J::Bool(p.grow)),
    ]);
    t.s.insert(h, Session::Run(d));
    Ok(ans)
}

fn planner_step(a: &J, f: impl FnOnce(&mut Planner) -> Result<Need, String>) -> Result<J, String> {
    let h = int(a, "h")?;
    let now = int(a, "now")?;
    let mut t = table();
    let need = match t.s.get_mut(&h) {
        Some(Session::Plan { p, .. }) => f(p)?,
        Some(_) => return Err("not planning".into()),
        None => return Err("no such download".into()),
    };
    if need == Need::Go {
        return go(&mut t, h, now);
    }
    match t.s.get(&h) {
        Some(Session::Plan { p, .. }) => Ok(need_json(need, p)),
        _ => Err("not planning".into()),
    }
}

fn with_run<T>(a: &J, f: impl FnOnce(&mut Dl) -> Result<T, String>) -> Result<T, String> {
    let h = int(a, "h")?;
    let mut t = table();
    match t.s.get_mut(&h) {
        Some(Session::Run(d)) => f(d),
        Some(_) => Err("not running".into()),
        None => Err("no such download".into()),
    }
}

pub fn call(m: &str, a: &J) -> Result<J, String> {
    match m {
        "http.probe" => {
            let h = Head {
                code: int(a, "code")?,
                content_type: opt_str(a, "contentType")?,
                cf_mitigated: opt_str(a, "cfMitigated")?,
                content_range: opt_str(a, "contentRange")?,
                content_length: opt_str(a, "contentLength")?,
                etag: opt_str(a, "etag")?,
                last_modified: opt_str(a, "lastModified")?,
            };
            let p = httpdl::probe(&h, opt_str(a, "expectName")?.as_deref(), boolean(a, "named")?, int(a, "total")?);
            let (kind, code) = match p.kind {
                Kind::Whole => ("whole", h.code),
                Kind::Single => ("single", h.code),
                Kind::Fail(c) => ("fail", c),
                Kind::Ranged => ("ranged", h.code),
            };
            Ok(obj(vec![
                ("page", J::Bool(p.page)),
                ("askName", J::Bool(p.ask_name)),
                ("kind", J::s(kind)),
                ("code", num(code)),
                ("total", num(p.total)),
                ("ranged", J::Bool(p.ranged)),
                ("validator", J::Str(p.validator)),
            ]))
        }
        "http.single" => match httpdl::single(int(a, "code")?, opt_str(a, "contentLength")?.as_deref(), int(a, "total")?) {
            Ok(t) => Ok(obj(vec![("fail", J::Null), ("total", num(t))])),
            Err(c) => Ok(obj(vec![("fail", num(c)), ("total", num(int(a, "total")?))])),
        },
        "http.begin" => {
            let prev = opt_str(a, "prev")?.and_then(|t| Record::parse(&t));
            let (p, need) = Planner::new(int(a, "total")?, &string(a, "validator")?, int(a, "maxConnections")?, prev, int(a, "outLength")?, boolean(a, "outExists")?);
            let (scale, retries, refused, now) = (boolean(a, "scale")?, int(a, "retries")?, boolean(a, "refused")?, int(a, "now")?);
            let mut t = table();
            let h = t.next;
            t.next += 1;
            t.s.insert(h, Session::Plan { p, scale, retries, refused });
            let need = if need == Need::Go {
                go(&mut t, h, now)?
            } else {
                match t.s.get(&h) {
                    Some(Session::Plan { p, .. }) => need_json(need, p),
                    _ => return Err("lost".into()),
                }
            };
            Ok(obj(vec![("h", num(h)), ("need", need)]))
        }
        "http.zero" => {
            let z = list(a, "zero")?.iter().map(|x| match x {
                J::Bool(b) => Ok(*b),
                _ => Err("args: «zero» holds a non-boolean".to_string()),
            });
            let z = z.collect::<Result<Vec<bool>, String>>()?;
            planner_step(a, |p| Ok(p.zero(&z)))
        }
        "http.checked" => {
            let ok = list(a, "ok")?.iter().map(|x| match x {
                J::Num(n, _) if n.fract() == 0.0 => Ok(*n as i64),
                _ => Err("args: «ok» holds a non-number".to_string()),
            });
            let ok = ok.collect::<Result<Vec<i64>, String>>()?;
            let broken = boolean(a, "broken")?;
            planner_step(a, |p| Ok(p.checked(&ok, broken)))
        }
        "http.next" => {
            let (w, now) = (int(a, "w")?, int(a, "now")?);
            with_run(a, |d| {
                Ok(match d.next(w, now) {
                    Next::Exit => obj(vec![("k", J::s("exit"))]),
                    Next::Range { seg, idx, from, to, split } => obj(vec![
                        ("k", J::s("range")),
                        ("seg", num(seg as i64)),
                        ("idx", num(idx)),
                        ("from", num(from)),
                        ("to", num(to)),
                        ("split", split.map(|(s, at)| obj(vec![("seg", num(s as i64)), ("stopAt", num(at))])).unwrap_or(J::Null)),
                    ]),
                })
            })
        }
        "http.take" => {
            let (s, n) = (seg(a)?, int(a, "n")?);
            with_run(a, |d| d.take(s, n).map(num))
        }
        "http.wrote" => {
            let (s, now) = (seg(a)?, int(a, "now")?);
            with_run(a, |d| {
                let save = d.wrote(s, now)?;
                let sg = &d.segs[s];
                Ok(obj(vec![("pos", num(sg.pos)), ("stopAt", num(sg.stop_at)), ("speed", J::num(sg.speed)), ("save", text_or_null(save)), ("seq", num(d.save_seq))]))
            })
        }
        "http.error" => {
            let (s, status, cut, ra, now) = (seg(a)?, int(a, "status")?, boolean(a, "cut")?, opt_str(a, "retryAfter")?, int(a, "now")?);
            with_run(a, |d| {
                let e = d.error(s, status, cut, ra.as_deref(), now)?;
                let c = num(d.connections);
                Ok(match e {
                    OnError::Retry { wait_ms, first } => obj(vec![("do", J::s("retry")), ("wait", num(wait_ms)), ("first", J::Bool(first)), ("connections", c)]),
                    OnError::Leave => obj(vec![("do", J::s("leave")), ("connections", c)]),
                    OnError::Fail => obj(vec![("do", J::s("fail")), ("connections", c)]),
                })
            })
        }
        "http.segEnd" => {
            let (s, now) = (seg(a)?, int(a, "now")?);
            with_run(a, |d| {
                let (pos, save) = d.seg_end(s, now)?;
                Ok(obj(vec![("pos", num(pos)), ("save", text_or_null(save)), ("seq", num(d.save_seq))]))
            })
        }
        "http.workerEnd" => {
            let (w, failed) = (int(a, "w")?, boolean(a, "failed")?);
            with_run(a, |d| {
                d.worker_end(w, failed);
                Ok(J::Null)
            })
        }
        "http.scaleBegin" => {
            let now = int(a, "now")?;
            with_run(a, |d| {
                d.scale_begin(now);
                Ok(J::Null)
            })
        }
        "http.scaling" => {
            let (c, f) = (boolean(a, "cancelled")?, boolean(a, "failed")?);
            with_run(a, |d| Ok(J::Bool(d.scaling(c, f))))
        }
        "http.scale" => {
            let (now, any) = (int(a, "now")?, boolean(a, "anyAlive")?);
            with_run(a, |d| {
                let r = d.scale(now, any);
                Ok(obj(vec![("stop", J::Bool(r.is_none())), ("add", num(r.unwrap_or(0))), ("connections", num(d.connections))]))
            })
        }
        "http.finish" => {
            let (c, f) = (boolean(a, "cancelled")?, boolean(a, "failed")?);
            with_run(a, |d| {
                let e = d.finish(c, f);
                let (seq, record) = d.record();
                let (what, conns) = match e {
                    End::Throw => ("throw", d.connections),
                    End::Again { connections } => ("again", connections),
                    End::Incomplete => ("incomplete", d.connections),
                    End::Done => ("done", d.connections),
                    End::Cancelled => ("cancelled", d.connections),
                };
                Ok(obj(vec![("do", J::s(what)), ("connections", num(conns)), ("refused", J::Bool(d.refused)), ("got", num(d.got)), ("record", J::Str(record)), ("seq", num(seq))]))
            })
        }
        "http.close" => {
            let h = int(a, "h")?;
            Ok(J::Bool(table().s.remove(&h).is_some()))
        }
        "http.record" => Ok(text_or_null(Record::parse(&string(a, "text")?).map(|r| r.write()))),
        _ => Err(format!("no such method: {}", m)),
    }
}

/// How many downloads are open (tests: every one closed).
#[cfg(test)]
fn open_count() -> usize {
    table().s.len()
}

/// MEGA's AES-128-CTR at `pos` of the file (Java's CtrFile.decrypt): the key the node key's two halves XORed, the
/// counter its third quarter then the block number, the stream entered `pos % 16` bytes into its block.
/// args: {"key": 64 hex digits, "pos": n}; data: the server's bytes; answer: the file's.
pub fn mega_ctr(args: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    let text = std::str::from_utf8(args).map_err(|_| "args: not UTF-8".to_string())?;
    let a = kt_core::vidjson::parse(text)?;
    let hex = string(&a, "key")?;
    let pos = int(&a, "pos")?;
    if pos < 0 {
        return Err("args: «pos» negative".into());
    }
    let k = unhex(&hex).filter(|k| k.len() == 32).ok_or("args: «key» not 32 bytes of hex")?;
    let mut key = [0u8; 16];
    let mut iv = [0u8; 16];
    for i in 0..16 {
        key[i] = k[i] ^ k[i + 16];
    }
    iv[..8].copy_from_slice(&k[16..24]);
    iv[8..].copy_from_slice(&((pos as u64) >> 4).to_be_bytes());
    let mut c = mega::Ctr::new(&key, &iv);
    let skip = (pos & 15) as usize;
    if skip > 0 {
        c.apply(&mut vec![0u8; skip]);
    }
    let mut out = data.to_vec();
    c.apply(&mut out);
    Ok(out)
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::call_bytes;

    fn call(m: &str, args: &str) -> String {
        String::from_utf8(call_bytes(m.as_bytes(), args.as_bytes(), &[]).unwrap()).unwrap()
    }
    fn r(m: &str, args: &str) -> J {
        kt_core::vidjson::parse(&call(m, args)).unwrap().get("r").unwrap().clone()
    }
    fn n(j: &J, k: &str) -> i64 {
        j.get(k).unwrap().number() as i64
    }

    #[test]
    fn probe_and_single() {
        let p = r("http.probe", r#"{"code":206,"contentRange":"bytes 0-0/100","etag":"\"e\"","named":false,"total":-1}"#);
        assert_eq!(p.get("kind").unwrap().as_str(), Some("ranged"));
        assert_eq!(n(&p, "total"), 100);
        assert_eq!(p.get("validator").unwrap().as_str(), Some("\"e\""));
        let p = r("http.probe", r#"{"code":404,"named":true,"total":-1,"expectName":null}"#);
        assert_eq!((p.get("kind").unwrap().as_str(), n(&p, "code")), (Some("fail"), 404));
        let p = r("http.probe", r#"{"code":200,"contentType":"text/html","expectName":"a.mkv","named":true,"total":-1}"#);
        assert_eq!(p.get("page"), Some(&J::Bool(true)));
        assert_eq!(n(&r("http.single", r#"{"code":200,"contentLength":"7","total":-1}"#), "total"), 7);
        assert_eq!(n(&r("http.single", r#"{"code":500,"total":-1}"#), "fail"), 500);
        assert!(call_bytes(b"http.probe", br#"{"code":"x"}"#, &[]).is_err());
    }

    #[test]
    fn a_whole_run_through_the_table() {
        let b = r("http.begin", r#"{"total":2097152,"validator":"\"v\"","maxConnections":2,"scale":true,"retries":5,"prev":null,"outLength":0,"outExists":false,"refused":false,"now":0}"#);
        let h = n(&b, "h");
        let g = b.get("need").unwrap();
        assert_eq!(g.get("k").unwrap().as_str(), Some("go"));
        assert_eq!((n(g, "n"), n(g, "first"), n(g, "chunk"), n(g, "chunks")), (2, 2, 1 << 20, 2));
        assert_eq!(g.get("fresh"), Some(&J::Bool(true)));
        assert!(g.get("record").unwrap().as_str().unwrap().starts_with("kt1\n2097152\n\"v\"\n1048576\n"));
        for w in 0..2 {
            let x = r("http.next", &format!(r#"{{"h":{},"w":{},"now":0}}"#, h, w));
            assert_eq!(x.get("k").unwrap().as_str(), Some("range"));
            let s = n(&x, "seg");
            // (More read than is its own: only its part may be written.)
            assert_eq!(r("http.take", &format!(r#"{{"h":{},"seg":{},"n":2000000}}"#, h, s)).number() as i64, 1 << 20);
            let wr = r("http.wrote", &format!(r#"{{"h":{},"seg":{},"now":10}}"#, h, s));
            assert_eq!(n(&wr, "pos"), (w + 1) << 20);
            assert_eq!(n(&r("http.segEnd", &format!(r#"{{"h":{},"seg":{},"now":10}}"#, h, s)), "pos"), (w + 1) << 20);
        }
        assert_eq!(r("http.next", &format!(r#"{{"h":{},"w":0,"now":20}}"#, h)).get("k").unwrap().as_str(), Some("exit"));
        for w in 0..2 {
            r("http.workerEnd", &format!(r#"{{"h":{},"w":{},"failed":false}}"#, h, w));
        }
        let f = r("http.finish", &format!(r#"{{"h":{},"cancelled":false,"failed":false}}"#, h));
        assert_eq!(f.get("do").unwrap().as_str(), Some("done"));
        assert_eq!(n(&f, "got"), 2 << 20);
        assert!(f.get("record").unwrap().as_str().unwrap().contains("\n0,1,\n"));
        assert_eq!(r("http.close", &format!(r#"{{"h":{}}}"#, h)), J::Bool(true));
        assert_eq!(r("http.close", &format!(r#"{{"h":{}}}"#, h)), J::Bool(false));
        assert!(call_bytes(b"http.next", format!(r#"{{"h":{},"w":0,"now":0}}"#, h).as_bytes(), &[]).unwrap_err().contains("no such download"));
    }

    #[test]
    fn planning_steps_through_the_table() {
        // A record of the same size and file, its validator changed: the tails asked, then a chunk compared.
        let prev = "kt1\n2097152\n\"old\"\n1048576\n0,\n";
        let args = format!(r#"{{"total":2097152,"validator":"\"new\"","maxConnections":2,"scale":false,"retries":5,"prev":{},"outLength":2097152,"outExists":true,"refused":false,"now":0}}"#, J::s(prev).to_json());
        let b = r("http.begin", &args);
        let h = n(&b, "h");
        assert_eq!(b.get("need").unwrap().get("k").unwrap().as_str(), Some("zero"));
        let c = r("http.zero", &format!(r#"{{"h":{},"zero":[false],"now":0}}"#, h));
        assert_eq!(c.get("k").unwrap().as_str(), Some("check"));
        assert_eq!(c.get("windows").unwrap().to_json(), "[[[0,16384],[1032192,16384]]]");
        let g = r("http.checked", &format!(r#"{{"h":{},"ok":[0],"broken":false,"now":0}}"#, h));
        assert_eq!(g.get("k").unwrap().as_str(), Some("go"));
        assert_eq!((n(&g, "have"), g.get("fresh").cloned()), (1 << 20, Some(J::Bool(false))));
        assert_eq!(g.get("runs").unwrap().to_json(), "[[0,1048576]]");
        assert!(call_bytes(b"http.zero", format!(r#"{{"h":{},"zero":[],"now":0}}"#, h).as_bytes(), &[]).unwrap_err().contains("not planning"));
        r("http.close", &format!(r#"{{"h":{}}}"#, h));
        assert_eq!(r("http.record", r#"{"text":"kt1\n5\n\n1\n0,\n"}"#), J::s("kt1\n5\n\n1\n0,\n"));
        assert_eq!(r("http.record", r#"{"text":"nope"}"#), J::Null);
    }

    #[test]
    fn mega_at_any_offset() {
        let mut k = [0u8; 32];
        for (i, b) in k.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(37).wrapping_add(11);
        }
        let hex: String = k.iter().map(|b| format!("{:02x}", b)).collect();
        // The whole stream from 0, as the server holds the file: then any slice decrypted at its own place.
        let plain: Vec<u8> = (0..1000u32).map(|i| (i * 7 + 3) as u8).collect();
        let mut key = [0u8; 16];
        let mut iv = [0u8; 16];
        for i in 0..16 {
            key[i] = k[i] ^ k[i + 16];
        }
        iv[..8].copy_from_slice(&k[16..24]);
        let mut enc = plain.clone();
        mega::Ctr::new(&key, &iv).apply(&mut enc);
        for (from, to) in [(0usize, 1000usize), (5, 37), (16, 32), (17, 999), (999, 1000)] {
            let got = call_bytes(b"bytes.megaCtr", format!(r#"{{"key":"{}","pos":{}}}"#, hex, from).as_bytes(), &enc[from..to]).unwrap();
            assert_eq!(got, &plain[from..to], "{}..{}", from, to);
        }
        assert!(call_bytes(b"bytes.megaCtr", br#"{"key":"00","pos":0}"#, &[1]).is_err());
        assert!(call_bytes(b"bytes.megaCtr", format!(r#"{{"key":"{}","pos":-1}}"#, hex).as_bytes(), &[1]).is_err());
        assert!(open_count() < 1000);
    }
}
