// The safe-extraction engine on the Tauri shell (Tools 0.21 P11): main.cjs's kt:archivePreflight, kt:archiveShelf and
// kt:archiveJob, and the ZIP/tar part of kt:archiveExtract (archives.rs hands it here, as archive.cjs hands it to
// inplace.cjs) — thin wrappers over kt-core's extractjob.rs, where all the logic is (std only, tested with rustc on the
// vectors desktop/inplace.cjs runs too; the same journal v2, saved tail and shelf, so a job one shell started the other
// can finish, restore or undo). Here only what differs per shell: raw deflate (flate2), the disk's free space
// (filecmds), a pid's liveness (vtproc), the registry (<app data>/extract-jobs, main.cjs's <userData>/extract-jobs), and
// the job's progress (kt:archiveProgress) and Cancel (archives.rs's job flags).
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::archives;
use kt_core::extractjob::{self as ej, Env, FactOpts};
use kt_core::vidjson::{self, J};
use kurokawa_shell::archive;

/// Raw deflate by flate2 (miniz_oxide). A restore makes a deflated unit again only when the bytes come out the same;
/// flate2's encoder takes no memory level, so each level is tried once (at zlib's default 8).
struct Flate;
impl ej::Codec for Flate {
    fn inflate(&self, src: &mut dyn Read, dst: &mut dyn Write) -> io::Result<u64> {
        let mut d = flate2::read::DeflateDecoder::new(src);
        io::copy(&mut d, dst)
    }
    fn deflate(&self, data: &[u8], level: u32, mem_level: u32) -> Option<Vec<u8>> {
        if mem_level != 8 {
            return None;
        }
        let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::new(level));
        e.write_all(data).ok()?;
        e.finish().ok()
    }
}
/// The real disk.
struct Disk;
impl ej::Io for Disk {
    fn free_space(&self, dir: &Path) -> i64 {
        crate::filecmds::disk_space(dir).map(|(f, _)| f.min(i64::MAX as u64) as i64).unwrap_or(-1)
    }
    fn pid_alive(&self, pid: u32) -> bool {
        crate::vtproc::alive(pid)
    }
}
static DISK: Disk = Disk;
static FLATE: Flate = Flate;
fn env() -> Env<'static> {
    Env::new(&DISK, &FLATE)
}
/// Where the jobs' pointers are kept (main.cjs: <userData>/extract-jobs).
fn registry(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("extract-jobs"))
}
fn value(j: &J) -> Value {
    serde_json::from_str(&j.to_json()).unwrap_or(Value::Null)
}
fn json_j(v: &Value) -> Option<J> {
    vidjson::parse(&v.to_string()).ok()
}
fn flag(o: &Value, k: &str) -> bool {
    o.get(k).and_then(|v| v.as_bool()).unwrap_or(false)
}
fn keep_free(o: &Value) -> u64 {
    o.get("keepFree").and_then(|v| v.as_f64()).filter(|x| *x >= 0.0).map(|x| x as u64).unwrap_or(0)
}
/// «x.zip.001»: a split volume goes to 7-Zip, never to the engine (archive.cjs: `!/\.\d{3}$/`).
fn numbered(p: &str) -> bool {
    let b = p.as_bytes();
    b.len() > 4 && b[b.len() - 4] == b'.' && b[b.len() - 3..].iter().all(|c| c.is_ascii_digit())
}

/// kt:archiveExtract's first part (archive.cjs extract): a journal beside the archive — this engine's: the job finished;
/// the first design's: None (archives.rs resumes it the old way) —, then ZIP and tar (by content) through the engine
/// when it decodes every entry itself, or in place → Some({ files, dest, job, appeared, damaged }); None: not the
/// engine's (7-Zip's formats, methods only 7-Zip decodes in a normal extraction).
pub fn extract(app: &AppHandle, path: &Path, dest: &Path, o: &Value, on: &dyn Fn(u64, u64, &str), stop: &AtomicBool) -> Result<Option<Value>, String> {
    let stopped = || stop.load(Ordering::SeqCst);
    let pr = ej::Pr { on, stopped: &stopped };
    let password = o.get("password").and_then(|v| v.as_str()).filter(|x| !x.is_empty()).map(|x| x.to_string());
    let journal = ej::journal_of(path);
    let mut old_job = false;
    if journal.exists() {
        match ej::journal_version(path) {
            2 => {
                // (Only an in-place job of this very archive, its journal validated: anything else there is never
                // replayed. This app's job — its registry points at the journal — is finished at once; another's only
                // once the page's sheet showed where its files go and the user chose Finish («finishBeside»), else
                // «askBeside <dest>». A finished job's journal beside a new archive of that name: left out — the archive
                // is extracted as usual, never in place while that job is on the shelf.)
                let reg = registry(app);
                match ej::finish_beside(path, reg.as_deref(), flag(o, "finishBeside"), &env(), &pr, password.as_deref(), keep_free(o)).map_err(|f| f.msg)? {
                    Some(r) => {
                        // (Finished: with its journal, so the page offers Undo — main.cjs hands back the job the same way.)
                        let mut v = value(&r);
                        if let Some(m) = v.as_object_mut() {
                            m.remove("undo");
                            m.insert("dest".into(), json!(dest.to_string_lossy()));
                        }
                        return Ok(Some(v));
                    }
                    None => old_job = true,
                }
            }
            1 => return Ok(None),
            _ => return Err("journalCorrupt".to_string()),
        }
    }
    if old_job && flag(o, "inPlace") && o.get("only").map(|v| v.is_null()).unwrap_or(true) {
        return Err("journalExists".to_string());
    }
    let fmt = archive::format_of(path)?;
    if (fmt != "zip" && fmt != "tar") || numbered(&path.to_string_lossy()) {
        return Ok(None);
    }
    let scan = ej::units_of(path).map_err(|f| f.msg)?;
    let only: Option<Vec<String>> = o.get("only").and_then(|v| v.as_array()).map(|a| a.iter().map(|x| x.as_str().map(|y| y.to_string()).unwrap_or_else(|| x.to_string())).collect());
    let in_place = flag(o, "inPlace") && only.is_none();
    if !ej::own_methods(&scan) && !in_place {
        return Ok(None);
    }
    // (main.cjs: `answers: o.answers || (o.replace ? { default: o.replace } : undefined)`.)
    let answers = match o.get("answers").filter(|v| v.is_object()) {
        Some(a) => json_j(a),
        None => o.get("replace").and_then(|v| v.as_str()).filter(|x| !x.is_empty()).map(|r| J::Obj(vec![("default".into(), J::s(r))])),
    };
    let skip = o.get("skip").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|y| y.to_string())).collect()).unwrap_or_default();
    let reg = registry(app).unwrap_or_else(|| path.parent().unwrap_or(Path::new(".")).join(".kurokawa-jobs"));
    let opts = ej::Opts { in_place, answers, password, verify_first: flag(o, "verifyFirst"), keep_free: keep_free(o), platform: None, skip, only, registry: Some(reg) };
    let r = ej::extract(path, dest, &opts, &env(), &pr).map_err(|f| f.msg)?;
    if flag(o, "deleteAfter") && !in_place && !stopped() {
        let _ = std::fs::remove_file(path);
    }
    let mut v = value(&r);
    if let Some(m) = v.as_object_mut() {
        m.remove("undo");
        // (The destination as the page gave it, as main.cjs answers; the journal keeps the absolute one.)
        m.insert("dest".into(), json!(dest.to_string_lossy()));
    }
    Ok(Some(v))
}

/// kt:archiveList for an archive with an unfinished engine job beside it (journal v2): what is still in it, from the
/// job's plan (archive.cjs list's v2 branch) — the page's ArchiveInfo.
/// None: the journal beside it is a finished job's and this is a new archive of that name — listed as itself.
pub fn list_v2(path: &Path) -> Result<Option<Value>, String> {
    let left = match ej::left_beside(path).map_err(|f| f.msg)? {
        Some(l) => l,
        None => return Ok(None),
    };
    let format = ej::open_job(&ej::journal_of(path)).map(|j| j.format).unwrap_or_else(|_| "zip".into());
    let total: u64 = left.iter().map(|e| e.1).sum();
    let largest = left.iter().filter(|e| !e.3).map(|e| e.1).max().unwrap_or(0);
    let entries: Vec<Value> = left.iter().map(|(p, s, c, d)| json!({ "path": p, "size": s, "compressed": c, "dir": d })).collect();
    let free = ej::Io::free_space(&DISK, path.parent().unwrap_or(Path::new(".")));
    Ok(Some(json!({ "format": format, "entries": entries, "total": total, "encrypted": false, "inPlaceOk": true, "resumable": true, "largest": largest, "free": free, "platform": ej::host_platform() })))
}
/// kt:archiveRestore for an archive with an engine journal (v2) beside it → archive.cjs restore's number: -2 when the
/// archive came back whole, else how many files stayed extracted.
pub fn restore_v2(path: &Path) -> Result<i64, String> {
    // (Only the in-place job of this very archive — restore_beside; a finished job's beside a new archive: «nothingToRestore».)
    let r = ej::restore_beside(path, &env()).map_err(|f| f.msg)?;
    Ok(if r.get("identical").map(|x| x.truthy()).unwrap_or(false) { -2 } else { r.get("keptOut").and_then(|x| x.as_arr()).map(|a| a.len() as i64).unwrap_or(0) })
}

/// kt:archivePreflight({ path, dest, password?, verify?, keepFree? }) → { report, facts } — nothing written. ZIP and tar:
/// the engine's facts and pre-flight; the rest: 7-Zip's list, a normal extraction only (archive.cjs preflight).
#[tauri::command]
pub async fn kt_archive_preflight(o: Value) -> Result<Value, String> {
    let path = archives::s(&o, "path");
    let dest = archives::s(&o, "dest");
    let password = archives::opt_s(&o, "password");
    let verify = flag(&o, "verify");
    let kf = keep_free(&o);
    archives::blocking(move || {
        let p = Path::new(&path);
        let fmt = archive::format_of(p)?;
        if (fmt == "zip" || fmt == "tar") && !numbered(&path) {
            let external = if archives::seven().is_some() { ej::SEVEN_METHODS.to_vec() } else { vec![] };
            let fo = FactOpts { password, verify, platform: None, external };
            let pr = ej::Pr { on: &|_, _, _| {}, stopped: &|| false };
            return ej::preflight_of(p, Path::new(&dest), &fo, kf, &env(), &pr).map(|j| value(&j)).map_err(|f| f.msg);
        }
        let info = if old_job_beside(p) { archive::list_fresh(p, password.as_deref(), &archives::ctx())? } else { archive::list(p, password.as_deref(), &archives::ctx())? };
        let entries: Vec<(String, bool, i64, i64)> = info.entries.iter().map(|e| (e.path.clone(), e.dir, e.size, e.compressed.map(|c| c as i64).unwrap_or(0))).collect();
        let names: Vec<String> = info.entries.iter().filter(|e| !e.dir).map(|e| e.path.clone()).collect();
        let existing = archive::existing(Path::new(&dest), &names);
        let free = ej::Io::free_space(&DISK, Path::new(&dest));
        let host = ej::host_platform();
        let r = ej::preflight_listed(fmt, host, &entries, info.encrypted, password.is_some(), free, existing, kf);
        Ok(json!({ "report": value(&r), "facts": { "format": fmt, "platform": host } }))
    })
    .await
}

/// kt:archiveShelf({ atStart? }) → the jobs the registry knows: [{ journal, id, archive, dest, mode, state, why?, done,
/// total, can }] (finished ones whose Undo offer ended are cleaned first; every finished one at start).
#[tauri::command]
pub async fn kt_archive_shelf(app: AppHandle, o: Option<Value>) -> Result<Value, String> {
    let at_start = o.as_ref().map(|v| flag(v, "atStart")).unwrap_or(false);
    let reg = registry(&app);
    archives::blocking(move || Ok(Value::Array(reg.map(|r| ej::shelf(&r, at_start, ej::UNDO_MS).iter().map(value).collect()).unwrap_or_default()))).await
}

/// kt:archiveJob({ id?, journal, act }) — act: finish | restore | undo | dismiss | restoreV1 | leave — → what the
/// engine answers (finish: { files, dest, job, appeared, damaged }; restore / undo: { identical, back, keptOut };
/// restoreV1: { left }); progress as kt:archiveProgress; Cancel through kt:archiveCancel(id).
#[tauri::command]
pub async fn kt_archive_job(app: AppHandle, o: Value) -> Result<Value, String> {
    let id = archives::id_of(&o);
    let journal = archives::s(&o, "journal");
    let act = archives::s(&o, "act");
    // (A stopped job of a locked archive: the password the page asked for, to finish it; never kept.)
    let password = archives::opt_s(&o, "password");
    let stop = archives::job(&id);
    let on = archives::emitter(app, id.clone());
    let r = archives::blocking(move || {
        let stopped = || stop.load(Ordering::SeqCst);
        let pr = ej::Pr { on: &on, stopped: &stopped };
        let jp = Path::new(&journal);
        match act.as_str() {
            "finish" => ej::finish(jp, &env(), &pr, password.as_deref(), 0).map(|j| value(&j)).map_err(|f| f.msg),
            "restore" | "undo" => ej::restore(jp, &env()).map(|j| value(&j)).map_err(|f| f.msg),
            "dismiss" => ej::dismiss(jp).map(|j| value(&j)).map_err(|f| f.msg),
            "restoreV1" => {
                let file = journal.strip_suffix(ej::JOURNAL_SUFFIX).unwrap_or(&journal).to_string();
                archive::restore(Path::new(&file)).map(|left| json!({ "left": left }))
            }
            _ => Ok(json!({})),
        }
    })
    .await;
    archives::end_job(&id);
    r
}

/// Whether the journal beside `path` is a finished job's and a new archive of that name is there (kt-core Beside::Old):
/// then the shared reader lists and extracts the archive itself (list_fresh, extract_fresh), never the old job's tail.
pub fn old_job_beside(path: &Path) -> bool {
    ej::journal_version(path) == 2 && matches!(ej::beside(path, None), Ok(ej::Beside::Old))
}
