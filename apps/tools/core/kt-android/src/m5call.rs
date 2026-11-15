//! Stage M5: the file jobs' planner (`fj.plan` — kt-core's fileplan, KtFileJobs.java's rules as ordered steps that
//! Java's KtFileExec executes), their journal read back (`fj.journal`, `fj.repair`, `fj.rollback`, `fj.prune` —
//! kt-core's filejournal), the small rules of the bin, archives and the vault, and the network storages' rules
//! (`rm.*` — kt-core's remoterules; no secret is ever an argument here). No state is kept between calls. No unsafe.

use crate::dispatch::{boolean, field, int, num, string};
use kt_core::filejournal as fjn;
use kt_core::fileplan::{self as fp, Item, Kind, Node, Snapshot, Tgt};
use kt_core::remoterules as rr;
use kt_core::vidjson::{self, J};
use std::collections::HashSet;

fn list<'a>(a: &'a J, k: &str) -> Result<&'a Vec<J>, String> {
    field(a, k)?.as_arr().ok_or_else(|| format!("args: «{}» not a list", k))
}
fn strs(a: &J, k: &str) -> Result<Vec<String>, String> {
    list(a, k)?.iter().map(|x| x.as_str().map(|s| s.to_string()).ok_or_else(|| format!("args: «{}» holds a non-string", k))).collect()
}
fn opt_strs(a: &J, k: &str) -> Result<Option<Vec<String>>, String> {
    match a.get(k) {
        None | Some(J::Null) => Ok(None),
        Some(_) => strs(a, k).map(Some),
    }
}
fn uint(a: &J, k: &str) -> Result<u64, String> {
    let n = int(a, k)?;
    if n < 0 {
        return Err(format!("args: «{}» negative", k));
    }
    Ok(n as u64)
}
fn flag(a: &J, k: &str) -> Result<bool, String> {
    match a.get(k) {
        None | Some(J::Null) => Ok(false),
        Some(_) => boolean(a, k),
    }
}
fn obj(v: Vec<(&str, J)>) -> J {
    J::Obj(v.into_iter().map(|(k, x)| (k.to_string(), x)).collect())
}
fn s_arr(v: Vec<String>) -> J {
    J::Arr(v.into_iter().map(J::Str).collect())
}

/* ---------- the snapshot from Java's JSON ---------- */

fn tgt(a: Option<&J>) -> Result<Tgt, String> {
    let a = match a {
        None | Some(J::Null) => return Ok(Tgt::default()),
        Some(x) => x,
    };
    Ok(Tgt { exists: flag(a, "e")?, dir: flag(a, "d")?, file: flag(a, "f")?, same: flag(a, "same")?, names: opt_strs(a, "names")?.unwrap_or_default() })
}
fn node(a: &J, depth: usize) -> Result<Node, String> {
    if depth > 4096 {
        return Err("snapshot: too deep".into());
    }
    let kind = match string(a, "k")?.as_str() {
        "f" => Kind::File,
        "d" => Kind::Dir,
        "l" => Kind::LinkDir,
        k => return Err(format!("snapshot: kind «{}»", k)),
    };
    let kids = match a.get("c") {
        None | Some(J::Null) => None,
        Some(J::Arr(v)) => Some(v.iter().map(|x| node(x, depth + 1)).collect::<Result<Vec<_>, _>>()?),
        Some(_) => return Err("snapshot: «c» not a list".into()),
    };
    Ok(Node { name: string(a, "n")?, kind, size: uint(a, "s")?, is_file: flag(a, "isFile")?, kids, tgt: tgt(a.get("t"))? })
}
fn snapshot(a: &J) -> Result<Snapshot, String> {
    let items = list(a, "items")?
        .iter()
        .map(|it| Ok(Item { path: string(it, "path")?, exists: boolean(it, "exists")?, into_itself: flag(it, "intoItself")?, same_vol: flag(it, "sameVol")?, node: node(field(it, "node")?, 0)? }))
        .collect::<Result<Vec<_>, String>>()?;
    Ok(Snapshot { op: string(a, "op")?, conflict: string(a, "conflict")?, dest: string(a, "dest")?, dest_names: opt_strs(a, "destNames")?.unwrap_or_default(), items })
}

fn journal_state(a: &J) -> Result<fjn::State, String> {
    let (recs, torn) = fjn::read(&string(a, "text")?);
    Ok(fjn::state(&recs, torn))
}
fn acts(v: Vec<fjn::Act>) -> J {
    J::Arr(v.into_iter().map(|x| s_arr(x.fields())).collect())
}

pub fn call(m: &str, a: &J) -> Result<J, String> {
    match m {
        "fj.plan" => {
            let s = snapshot(field(a, "snapshot")?)?;
            let answers = strs(a, "answers")?;
            let rf: HashSet<String> = strs(a, "renameFailed")?.into_iter().collect();
            let p = fp::plan(&s, &answers, &rf);
            let steps = format!("[{}]", p.steps.iter().map(|x| x.to_json()).collect::<Vec<_>>().join(","));
            Ok(obj(vec![
                ("steps", vidjson::parse(&steps)?),
                ("totalBytes", num(p.total_bytes as i64)),
                ("totalFiles", num(p.total_files as i64)),
                ("asks", J::Bool(p.asks)),
                ("copyBytes", num(p.copy_bytes as i64)),
            ]))
        }
        "fj.keepBoth" => {
            let taken: HashSet<String> = strs(a, "taken")?.into_iter().collect();
            Ok(J::s(&fp::keep_both_name(&string(a, "name")?, boolean(a, "dir")?, &|c| taken.contains(c))))
        }
        "fj.ext" => Ok(J::s(&fp::ext_of(&string(a, "name")?))),
        "fj.renameBad" => Ok(fp::rename_bad(&string(a, "name")?).map(J::s).unwrap_or(J::Null)),
        "fj.trashSlot" => Ok(J::s(&fp::trash_slot(int(a, "now")?, &string(a, "path")?))),
        "fj.trashExpired" => Ok(J::Bool(fp::trash_expired(int(a, "now")?, int(a, "at")?, int(a, "olderThan")?))),
        "fj.trashRoot" => {
            let roots = list(a, "roots")?
                .iter()
                .map(|p| match p.as_arr().map(|x| x.as_slice()) {
                    Some([J::Str(r), J::Str(k)]) => Ok((r.clone(), k.clone())),
                    _ => Err("args: «roots» holds a bad pair".to_string()),
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(fp::trash_root(&string(a, "path")?, &roots).map(J::Str).unwrap_or(J::Null))
        }
        "fj.journal" => {
            let s = journal_state(a)?;
            let count = |f: &dyn Fn(&fjn::St) -> bool| s.st.iter().filter(|x| f(x)).count() as i64;
            Ok(obj(vec![
                ("op", J::s(&s.op)),
                ("dest", J::s(&s.dest)),
                ("steps", num(s.steps.len() as i64)),
                ("done", num(count(&|x| matches!(x, fjn::St::Done(..))))),
                ("failed", num(count(&|x| matches!(x, fjn::St::Failed(_))))),
                ("next", num(fjn::next_index(&s) as i64)),
                ("ready", J::Bool(s.ready)),
                ("ended", s.ended.clone().map(J::Str).unwrap_or(J::Null)),
                ("resumable", J::Bool(fjn::resumable(&s))),
                ("undoable", J::Bool(fjn::undoable(&s))),
                ("rolledBack", J::Bool(s.rolled_back)),
                ("resumes", num(s.resumes as i64)),
                ("disputed", J::Arr(s.disputed.iter().map(|x| num(*x as i64)).collect())),
                ("torn", J::Bool(s.torn)),
            ]))
        }
        "fj.repair" => Ok(acts(fjn::repair_for_resume(&journal_state(a)?))),
        "fj.rollback" => {
            let (x, lost) = fjn::rollback(&journal_state(a)?);
            Ok(obj(vec![("acts", acts(x)), ("lost", s_arr(lost))]))
        }
        "fj.prune" => {
            let l = list(a, "list")?
                .iter()
                .map(|p| match p.as_arr().map(|x| x.as_slice()) {
                    Some([J::Str(n), J::Num(t, _), J::Bool(f)]) => Ok((n.clone(), *t as i64, *f)),
                    _ => Err("args: «list» holds a bad row".to_string()),
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(s_arr(fjn::prune(&l, int(a, "now")?, uint(a, "keep")? as usize, int(a, "maxAge")?)))
        }
        "fj.line" => Ok(J::s(&fjn::line(&string(a, "kind")?, &strs(a, "fields")?))),

        "ar.unsafe" => Ok(J::Bool(fp::archive_unsafe(&string(a, "name")?))),
        "ar.wanted" => Ok(J::Bool(fp::archive_wanted(opt_strs(a, "only")?.as_deref(), &string(a, "name")?))),
        "ar.bothName" => {
            let taken: HashSet<String> = strs(a, "taken")?.into_iter().collect();
            Ok(J::s(&fp::archive_both_name(&string(a, "name")?, &|c| taken.contains(c))))
        }
        "vt.takes" => Ok(J::Bool(fp::vault_takes(boolean(a, "lock")?, &string(a, "name")?, boolean(a, "isFile")?))),
        "vt.nameOk" => Ok(J::Bool(fp::vault_name_ok(uint(a, "len")? as usize, &string(a, "name")?))),

        "rm.norm" => Ok(J::s(&rr::norm(&string(a, "path")?))),
        "rm.join" => Ok(J::s(&rr::join(&string(a, "dir")?, &string(a, "name")?))),
        "rm.smbSplit" => {
            let (s, p) = rr::smb_split(&string(a, "path")?);
            Ok(s_arr(vec![s, p]))
        }
        "rm.davPath" => Ok(J::s(&rr::dav_path(&string(a, "path")?))),
        "rm.davBase" => Ok(J::s(&rr::dav_base(&string(a, "host")?, &string(a, "kind")?, &string(a, "user")?))),
        "rm.hrefs" => {
            let base = string(a, "basePath")?;
            Ok(J::Arr(strs(a, "hrefs")?.iter().map(|h| rr::href_path(h, &base).map(J::Str).unwrap_or(J::Null)).collect()))
        }
        "rm.isCollection" => Ok(J::Bool(rr::is_collection(&string(a, "r")?))),
        "rm.tryAgain" => Ok(J::Bool(rr::try_again(&string(a, "message")?))),
        "rm.downName" => Ok(J::s(&rr::down_name(&string(a, "path")?))),
        "rm.fetchDir" => Ok(J::s(&rr::fetch_dir(&string(a, "cache")?, &string(a, "conn")?, &string(a, "path")?))),
        "rm.upload" => {
            fn local(a: &J, depth: usize) -> Result<rr::Local, String> {
                if depth > 4096 {
                    return Err("upload: too deep".into());
                }
                let kids = match a.get("c") {
                    None | Some(J::Null) => None,
                    Some(J::Arr(v)) => Some(v.iter().map(|x| local(x, depth + 1)).collect::<Result<Vec<_>, _>>()?),
                    Some(_) => return Err("upload: «c» not a list".into()),
                };
                Ok(rr::Local { path: string(a, "path")?, name: string(a, "n")?, size: uint(a, "s")?, dir: boolean(a, "d")?, kids })
            }
            let paths = list(a, "paths")?.iter().map(|x| local(x, 0)).collect::<Result<Vec<_>, _>>()?;
            let (steps, bytes, files) = rr::upload_plan(&paths, &string(a, "dest")?);
            let steps = steps
                .into_iter()
                .map(|u| match u {
                    rr::Up::Mkdirs(p) => J::Arr(vec![J::s("mkdirs"), J::Str(p)]),
                    rr::Up::Put { local, remote, size } => J::Arr(vec![J::s("put"), J::Str(local), J::Str(remote), num(size as i64)]),
                })
                .collect();
            Ok(obj(vec![("steps", J::Arr(steps)), ("bytes", num(bytes as i64)), ("files", num(files as i64))]))
        }
        _ => Err(format!("no such method: {}", m)),
    }
}

#[cfg(test)]
mod tests {
    use crate::dispatch::call_bytes;

    fn call(m: &str, args: &str) -> Result<String, String> {
        call_bytes(m.as_bytes(), args.as_bytes(), &[]).map(|b| String::from_utf8(b).unwrap())
    }

    #[test]
    fn a_plan_through_the_table() {
        let snap = r#"{"op":"move","conflict":"ask","dest":"/d","destNames":["a.txt"],"items":[{"path":"/s/a.txt","exists":true,"node":{"n":"a.txt","k":"f","s":3,"isFile":true,"t":{"e":true,"f":true}}}]}"#;
        let r = call("fj.plan", &format!(r#"{{"snapshot":{},"answers":[],"renameFailed":[]}}"#, snap)).unwrap();
        assert_eq!(r, r#"{"r":{"steps":[["ask",0,"/s/a.txt","/d/a.txt"]],"totalBytes":3,"totalFiles":1,"asks":true,"copyBytes":0}}"#);
        let r = call("fj.plan", &format!(r#"{{"snapshot":{},"answers":["keep"],"renameFailed":[]}}"#, snap)).unwrap();
        assert!(r.contains(r#"["copy",0,1,"/s/a.txt","/d/a (2).txt",3,false,true]"#), "{}", r);
        // (Arabic and emoji cross as \u escapes and come back the same)
        let r = call("fj.plan", r#"{"snapshot":{"op":"copy","conflict":"skip","dest":"/d","items":[{"path":"/s/ص😀","exists":true,"node":{"n":"ص😀","k":"f","s":1,"isFile":true}}]},"answers":[],"renameFailed":[]}"#).unwrap();
        assert!(r.contains("/d/ص😀"), "{}", r);
        assert!(call("fj.plan", r#"{"snapshot":{"op":"copy","conflict":"skip","dest":"/d","items":[{"path":"/x","exists":true,"node":{"n":"x","k":"q","s":1}}]},"answers":[],"renameFailed":[]}"#).is_err());
        assert!(call("fj.plan", r#"{"snapshot":{},"answers":[],"renameFailed":[]}"#).is_err());
    }

    #[test]
    fn journal_through_the_table() {
        let mut t = String::new();
        for (k, f) in [("P", vec!["1", "copy", "/d", "0", "2"]), ("S", vec!["0", "copy", "0", "1", "/s/a", "/d/a", "5", "false", "false"]), ("S", vec!["1", "end", "0", "true"]), ("R", vec![]), ("B", vec!["0"])] {
            let line = call("fj.line", &format!(r#"{{"kind":"{}","fields":[{}]}}"#, k, f.iter().map(|x| format!("\"{}\"", x)).collect::<Vec<_>>().join(","))).unwrap();
            let v = kt_core::vidjson::parse(&line).unwrap();
            t.push_str(v.get("r").unwrap().as_str().unwrap());
        }
        let text = kt_core::vidjson::J::s(&t).to_json();
        let j = call("fj.journal", &format!(r#"{{"text":{}}}"#, text)).unwrap();
        assert!(j.contains(r#""resumable":true"#) && j.contains(r#""next":0"#), "{}", j);
        assert_eq!(call("fj.repair", &format!(r#"{{"text":{}}}"#, text)).unwrap(), r#"{"r":[["settleCopy","0","/s/a","/d/a","5","false","false",""]]}"#);
        assert_eq!(call("fj.rollback", &format!(r#"{{"text":{}}}"#, text)).unwrap(), r#"{"r":{"acts":[["unsettleCopy","/s/a","/d/a","5","false","false",""],["markUndone","0"]],"lost":[]}}"#);
        assert_eq!(call("fj.prune", r#"{"list":[["a",1,true],["b",2,true]],"now":3,"keep":1,"maxAge":100}"#).unwrap(), r#"{"r":["a"]}"#);
    }

    #[test]
    fn small_rules_through_the_table() {
        assert_eq!(call("fj.keepBoth", r#"{"name":"a.txt","dir":false,"taken":["a (2).txt"]}"#).unwrap(), r#"{"r":"a (3).txt"}"#);
        assert_eq!(call("fj.renameBad", r#"{"name":".."}"#).unwrap(), r#"{"r":"bad name"}"#);
        assert_eq!(call("fj.trashSlot", r#"{"now":5,"path":"a"}"#).unwrap(), r#"{"r":"5-61"}"#);
        assert_eq!(call("fj.trashRoot", r#"{"path":"/sd/x","roots":[["/sd","sd"]]}"#).unwrap(), r#"{"r":"/sd"}"#);
        assert_eq!(call("ar.unsafe", r#"{"name":"../x"}"#).unwrap(), r#"{"r":true}"#);
        assert_eq!(call("ar.wanted", r#"{"only":null,"name":"x"}"#).unwrap(), r#"{"r":true}"#);
        assert_eq!(call("vt.takes", r#"{"lock":true,"name":"a.kurokawa","isFile":true}"#).unwrap(), r#"{"r":false}"#);
        assert_eq!(call("rm.davPath", r#"{"path":"a b"}"#).unwrap(), r#"{"r":"/a%20b"}"#);
        assert_eq!(call("rm.hrefs", r#"{"hrefs":["/dav/a%20b","/dav/%zz"],"basePath":"/dav"}"#).unwrap(), r#"{"r":["/a b",null]}"#);
        assert_eq!(call("rm.smbSplit", r#"{"path":"/s/a/b"}"#).unwrap(), r#"{"r":["s","a\\b"]}"#);
        let up = call("rm.upload", r#"{"paths":[{"path":"/l/c","n":"c","s":1,"d":false}],"dest":"/up"}"#).unwrap();
        assert_eq!(up, r#"{"r":{"steps":[["mkdirs","/up"],["put","/l/c","/up/c",1]],"bytes":1,"files":1}}"#);
    }
}
