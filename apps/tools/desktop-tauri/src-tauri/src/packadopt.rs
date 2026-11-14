// The hybrid's programs taken over (../../PORTING.md «Closed by the hybrid»): yt-dlp and gallery-dl (Electron's
// <userData>/bin) and the ffmpeg pack (<userData>/packs/ffmpeg) the Electron build already fetched, copied into this
// build's folders instead of fetched again — at the hand-over and at a first start beside an Electron data folder
// with none. ONLY a copy that is, byte for byte, what a trusted list names: yt-dlp's SHA2-256SUMS of its newest
// release (what this build's own fetch checks against), gallery-dl's release digest and size, this release's packs
// file (KurokawaTools-packs.json: the ffmpeg pack's `unpackedSha256` and `unpacked` size, which ffmpeg-pack.cjs adds
// from this release on). Nothing is ever run to ask what it is: a program whose digest is not on the list (an older
// yt-dlp, a list that cannot be read) is left where it is, and the normal fetch brings this build's own when it is
// first needed. The copy is made beside its place, its digest taken again, and only then renamed in (never a hard
// link: the Electron build may still rewrite its own file in place — ytdlp.cjs rollback). The same marks as the
// pack mechanism's are written (yt-dlp.stamp.json, the pack's .kurokawa-pack with the version the page expects).
// Rules: gaplogic.rs (adopt_ok, pack_version). What happened: <app data>/programs-adopted.json.
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::AppHandle;

use kt_core::videotools as vt;
use kurokawa_shell::util;

use crate::gaplogic as logic;

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Where each program goes in this build.
pub struct Targets {
    pub ytdlp: PathBuf,
    pub gallery: PathBuf,
    pub ffmpeg: PathBuf,
}

impl Targets {
    pub fn ours() -> Targets {
        Targets { ytdlp: crate::vtools::managed_path(), gallery: crate::vtools::gallery_path(), ffmpeg: crate::vtffmpeg::pack_ffmpeg() }
    }
}

/// Where the trusted lists are read.
pub struct Lists {
    pub yt_sums: String,
    pub gallery_api: String,
    pub packs: String,
}

impl Lists {
    pub fn real(app_version: &str) -> Lists {
        let u = crate::vtools::urls();
        Lists {
            yt_sums: format!("{}/SHA2-256SUMS", u.yt_dl),
            gallery_api: u.gdl_api,
            packs: format!("https://github.com/{}/releases/download/tools-v{}/KurokawaTools-packs.json", kurokawa_shell::net::REPO, app_version),
        }
    }
}

/// The Electron build's copies in its data folder `d` (yt-dlp, gallery-dl, the ffmpeg pack's program — the last only
/// with its marker, as packs.cjs installed()).
fn electron_files(d: &Path, os: &str) -> (PathBuf, PathBuf, Option<PathBuf>) {
    let ff_dir = d.join("packs").join("ffmpeg");
    let ff = ff_dir.join(vt::ffmpeg_file(os));
    let marked = ff_dir.join(vt::PACK_MARKER).is_file();
    (d.join("bin").join(vt::ytdlp_file(os)), d.join("bin").join(vt::gallery_file(os)), if marked { Some(ff) } else { None })
}

fn digest(p: &Path) -> Option<(u64, String)> {
    let size = std::fs::metadata(p).ok().filter(|m| m.is_file())?.len();
    let sha = crate::vtfetch::sha256_file(p).ok()?;
    Some((size, sha))
}

/// `from` copied to `to` when it is what `want` names: beside it first, its digest taken again, made executable,
/// renamed in → "taken", or why not.
fn take(from: &Path, to: &Path, want: &logic::Want) -> Result<&'static str, String> {
    if to.exists() {
        return Ok("this build has its own");
    }
    let (size, sha) = digest(from).ok_or_else(|| "not there".to_string())?;
    if !logic::adopt_ok(size, &sha, want) {
        return Err("not the listed program (left for the normal download)".to_string());
    }
    if let Some(d) = to.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let part = PathBuf::from(format!("{}.adopt.part", to.to_string_lossy()));
    let _ = std::fs::remove_file(&part);
    std::fs::copy(from, &part).map_err(|e| e.to_string())?;
    match digest(&part) {
        Some((s2, h2)) if logic::adopt_ok(s2, &h2, want) => {}
        _ => {
            let _ = std::fs::remove_file(&part);
            return Err("changed while it was copied".to_string());
        }
    }
    let _ = crate::vtproc::make_executable(&part);
    if to.exists() {
        let _ = std::fs::remove_file(&part);
        return Ok("this build has its own");
    }
    std::fs::rename(&part, to).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        e.to_string()
    })?;
    Ok("taken")
}

fn said(r: Result<&'static str, String>) -> Value {
    match r {
        Ok(s) => json!(s),
        Err(e) => json!(e),
    }
}

/// What to fetch the lists for: (yt-dlp, gallery-dl, ffmpeg) found in Electron's folders and missing here.
fn wanted(dirs: &[PathBuf], t: &Targets, os: &str) -> (Option<PathBuf>, Option<PathBuf>, Option<PathBuf>) {
    let mut yt = None;
    let mut gdl = None;
    let mut ff = None;
    for d in dirs.iter() {
        let (y, g, f) = electron_files(d, os);
        if yt.is_none() && !t.ytdlp.exists() && y.is_file() {
            yt = Some(y);
        }
        if gdl.is_none() && !t.gallery.exists() && vt::gallery_asset(os).is_some() && g.is_file() {
            gdl = Some(g);
        }
        if ff.is_none() && !t.ffmpeg.exists() {
            ff = f.filter(|p| p.is_file());
        }
    }
    (yt, gdl, ff)
}

/// The adoption: the lists read (only those needed), each copy checked and taken → { yt-dlp, gallery-dl, ffmpeg: what
/// happened, listsRead }. Blocking file work runs on blocking threads.
pub async fn run(dirs: Vec<PathBuf>, t: Targets, lists: Lists, app_version: String) -> Value {
    let os = util::node_platform();
    let arch = util::node_arch();
    let (yt, gdl, ff) = wanted(&dirs, &t, os);
    let mut out = json!({ "yt-dlp": "nothing to take", "gallery-dl": "nothing to take", "ffmpeg": "nothing to take", "listsRead": true });
    if let Some(from) = yt {
        let r = match crate::vtfetch::text(&lists.yt_sums, None).await {
            Ok(sums) => match vt::sum_for(&sums, vt::ytdlp_asset(os, arch)) {
                Some(sha) => {
                    let to = t.ytdlp.clone();
                    let res = crate::vtools::blocking(move || take(&from, &to, &logic::Want { sha256: sha, size: None })).await.unwrap_or_else(Err);
                    if res == Ok("taken") {
                        // (yt-dlp.stamp.json as a fetch writes it, so its weekly update check counts from now.)
                        let stamp = t.ytdlp.with_file_name("yt-dlp.stamp.json");
                        let _ = std::fs::write(&stamp, json!({ "at": now_ms(), "url": format!("{}/{}", lists.yt_sums.trim_end_matches("/SHA2-256SUMS"), vt::ytdlp_asset(os, arch)), "adopted": "electron" }).to_string());
                    }
                    said(res)
                }
                None => json!("its list names no program for this system"),
            },
            Err(e) => {
                out["listsRead"] = json!(false);
                json!(format!("its list could not be read: {}", e))
            }
        };
        out["yt-dlp"] = r;
    }
    if let Some(from) = gdl {
        let r = match crate::vtfetch::text(&lists.gallery_api, Some("application/vnd.github+json")).await.and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| e.to_string())) {
            Ok(rel) => {
                let asset = vt::gallery_asset(os).unwrap_or("");
                let a = rel.get("assets").and_then(|x| x.as_array()).and_then(|xs| xs.iter().find(|x| x.get("name").and_then(|n| n.as_str()) == Some(asset)).cloned());
                match a.as_ref().and_then(|a| a.get("digest").and_then(|d| d.as_str()).and_then(vt::digest_hex)) {
                    Some(sha) => {
                        let size = a.as_ref().and_then(|a| a.get("size").and_then(|s| s.as_u64()));
                        let to = t.gallery.clone();
                        let res = crate::vtools::blocking(move || take(&from, &to, &logic::Want { sha256: sha, size })).await.unwrap_or_else(Err);
                        said(res)
                    }
                    None => json!("its release publishes no digest for this system"),
                }
            }
            Err(e) => {
                out["listsRead"] = json!(false);
                json!(format!("its list could not be read: {}", e))
            }
        };
        out["gallery-dl"] = r;
    }
    if let Some(from) = ff {
        let r = match crate::vtfetch::text(&lists.packs, None).await.and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| e.to_string())) {
            Ok(m) => {
                let e = m.get("packs").and_then(|p| p.get("ffmpeg")).and_then(|p| p.get(logic::pack_key(os, arch)));
                match e.and_then(|e| e.get("unpackedSha256").and_then(|v| v.as_str())) {
                    Some(sha) => {
                        let want = logic::Want { sha256: sha.to_string(), size: e.and_then(|e| e.get("unpacked").and_then(|v| v.as_u64())) };
                        let version = logic::pack_version(
                            m.get("versions").and_then(|v| v.get("ffmpeg")).and_then(|v| v.as_str()),
                            m.get("ydl").and_then(|v| v.as_str()),
                            m.get("version").and_then(|v| v.as_str()),
                            &app_version,
                        );
                        let to = t.ffmpeg.clone();
                        let res = crate::vtools::blocking(move || {
                            let r = take(&from, &to, &want);
                            if r == Ok("taken") {
                                if let Some(d) = to.parent() {
                                    // (The pack's marker, as packs.cjs and vtffmpeg.rs write it: its version.)
                                    let _ = std::fs::write(d.join(vt::PACK_MARKER), version);
                                }
                            }
                            r
                        })
                        .await
                        .unwrap_or_else(Err);
                        said(res)
                    }
                    None => json!("this release's packs file has no digest of the program (made before it carried one)"),
                }
            }
            Err(e) => {
                out["listsRead"] = json!(false);
                json!(format!("its list could not be read: {}", e))
            }
        };
        out["ffmpeg"] = r;
    }
    out
}

/// At this build's start (main.rs, after the video tools' folders are set): the adoption, in the background, until it
/// has run with its lists read — at most ADOPT_TRIES starts. Never in a self-test run (its rows call `run` with their
/// own stand-ins).
pub fn at_start(app: &AppHandle) {
    if crate::vtools::selftest_run() {
        return;
    }
    let state = crate::vtools::dirs().data.join(logic::ADOPT_STATE);
    let prev: Value = std::fs::read_to_string(&state).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let tries = prev.get("tries").and_then(|v| v.as_u64()).unwrap_or(0);
    if prev.get("done").and_then(|v| v.as_bool()) == Some(true) || tries >= logic::ADOPT_TRIES {
        return;
    }
    let dirs = crate::handover::electron_dirs(app);
    let t = Targets::ours();
    let (yt, gdl, ff) = wanted(&dirs, &t, util::node_platform());
    if yt.is_none() && gdl.is_none() && ff.is_none() {
        return;
    }
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn(async move {
        let r = run(dirs, t, Lists::real(&version), version.clone()).await;
        let done = r.get("listsRead").and_then(|v| v.as_bool()).unwrap_or(false);
        let note = json!({ "done": done, "tries": tries + 1, "at": now_ms(), "result": r });
        let _ = std::fs::write(&state, note.to_string());
    });
}
