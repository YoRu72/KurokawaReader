// Stage P5's part of the runtime self-test (CI only; refused in a normal run): kt_selftest_vt sets up what the page's
// checks (selftest.js runP5) need and cannot make themselves —
//   setup        the loopback release server (vtfake.rs Server) started and the release addresses pointed at it: yt-dlp
//                (SHA2-256SUMS, the program — its first download broken off half-way, so it resumes —, the newest tag),
//                gallery-dl (the release's JSON with the digest, the program), the ffmpeg pack (gzipped; a slow copy to
//                cancel, a copy broken off once) — every program the app's own executable with a trailer naming its
//                version (vtfake.rs) → { base, packSha256, packSize, gallery, os, dir }
//   serve        yt-dlp's release changed: { version, mode: ok|broken, badSum } (a newer one, a broken newer one, a
//                checksum that does not match)
//   probeBeside  a stand-in ffprobe put beside the pack's ffmpeg (the pack carries ffmpeg alone)
//   pids         the two pids a stand-in wrote (itself and the grandchild it started) → [a, b]
//   alive        { pids } → whether each still runs
//   seen         the requests the server saw («METHOD path range»)
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value};

use kt_core::videotools as vt;
use kurokawa_shell::{testserver, util};

use crate::vtfake::{self, Route, Server};
use crate::{vtffmpeg, vtfetch, vtools, vtproc};

struct Lab {
    server: Server,
    base: String,
    exe: Arc<Vec<u8>>,
    pack_sha: String,
    pack_size: usize,
}
static LAB: OnceLock<Mutex<Option<Lab>>> = OnceLock::new();

fn sha_hex(b: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    util::hex(Sha256::digest(b).as_slice())
}

fn bin(b: Vec<u8>, slow: bool, cut: Option<usize>) -> Route {
    Route { body: Arc::new(b), ctype: "application/octet-stream", slow, cut }
}
fn text(t: String, ctype: &'static str) -> Route {
    Route { body: Arc::new(t.into_bytes()), ctype, slow: false, cut: None }
}

/// yt-dlp's release on the server: the program with its trailer, its checksum line (or a wrong one), its tag.
fn serve_ytdlp(lab: &Lab, version: &str, mode: &str, bad_sum: bool, cut: bool) {
    let asset = vt::ytdlp_asset(util::node_platform(), util::node_arch());
    let mut prog = lab.exe.as_ref().clone();
    prog.extend(vtfake::trailer(version, mode));
    let sha = if bad_sum { "0".repeat(64) } else { sha_hex(&prog) };
    let half = prog.len() / 2;
    lab.server.set(&format!("/yt/download/{}", asset), bin(prog, false, if cut { Some(half) } else { None }));
    lab.server.set("/yt/download/SHA2-256SUMS", text(format!("{}  yt-dlp.tar.gz\n{}  {}\n", "1".repeat(64), sha, asset), "text/plain"));
    lab.server.set("/yt/latest", text(json!({ "tag_name": version, "assets": [] }).to_string(), "application/json"));
}

fn setup() -> Result<Value, String> {
    let cell = LAB.get_or_init(|| Mutex::new(None));
    let mut g = cell.lock().map_err(|_| "lock".to_string())?;
    if g.is_none() {
        let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe = Arc::new(std::fs::read(&exe_path).map_err(|e| e.to_string())?);
        let server = Server::new();
        let port = server.start().map_err(|e| e.to_string())?;
        let base = format!("http://127.0.0.1:{}", port);
        let gz = testserver::gzip_stored(&exe);
        let pack_sha = sha_hex(&gz);
        let pack_size = gz.len();
        let gz = Arc::new(gz);
        server.set("/pack/ffmpeg.gz", Route { body: gz.clone(), ctype: "application/gzip", slow: false, cut: None });
        server.set("/pack/slow.gz", Route { body: gz.clone(), ctype: "application/gzip", slow: true, cut: None });
        server.set("/pack/cut.gz", Route { body: gz.clone(), ctype: "application/gzip", slow: false, cut: Some(pack_size / 3) });
        if let Some(asset) = vt::gallery_asset(util::node_platform()) {
            let mut prog = exe.as_ref().clone();
            prog.extend(vtfake::trailer("1.30.2", "ok"));
            let rel = json!({ "tag_name": "v1.30.2", "assets": [
                { "name": "gallery-dl.tar.gz", "browser_download_url": format!("{}/gdl/none", base), "digest": format!("sha256:{}", "2".repeat(64)) },
                { "name": asset, "browser_download_url": format!("{}/gdl/{}", base, asset), "digest": format!("sha256:{}", sha_hex(&prog)), "size": prog.len() }
            ] });
            server.set(&format!("/gdl/{}", asset), bin(prog, false, None));
            server.set("/gdl/latest", text(rel.to_string(), "application/json"));
        }
        let lab = Lab { server, base: base.clone(), exe, pack_sha, pack_size };
        serve_ytdlp(&lab, vtfake::DEFAULT_VERSION, "ok", false, true);
        vtools::set_urls(vtools::Urls { yt_dl: format!("{}/yt/download", base), yt_api: format!("{}/yt/latest", base), gdl_api: format!("{}/gdl/latest", base) });
        *g = Some(lab);
    }
    let lab = g.as_ref().ok_or_else(|| "no lab".to_string())?;
    Ok(json!({
        "base": lab.base, "packSha256": lab.pack_sha, "packSize": lab.pack_size,
        "gallery": vt::gallery_asset(util::node_platform()).is_some(), "os": util::node_platform(),
        "dir": vtools::dirs().data.to_string_lossy(), "version": vtfake::DEFAULT_VERSION,
    }))
}

fn with_lab<T>(f: impl FnOnce(&Lab) -> T) -> Result<T, String> {
    let cell = LAB.get().ok_or_else(|| "setup first".to_string())?;
    let g = cell.lock().map_err(|_| "lock".to_string())?;
    let lab = g.as_ref().ok_or_else(|| "setup first".to_string())?;
    Ok(f(lab))
}

fn s(o: &Value, k: &str) -> String {
    o.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

#[tauri::command]
pub async fn kt_selftest_vt(o: Value) -> Result<Value, String> {
    if !vtools::selftest_run() {
        return Err("not a self-test run".to_string());
    }
    let op = s(&o, "op");
    vtools::blocking(move || -> Result<Value, String> {
        match op.as_str() {
            "setup" => setup(),
            "serve" => with_lab(|lab| {
                let v = s(&o, "version");
                let m = s(&o, "mode");
                serve_ytdlp(lab, if v.is_empty() { vtfake::DEFAULT_VERSION } else { &v }, if m.is_empty() { "ok" } else { &m }, o.get("badSum").and_then(|b| b.as_bool()).unwrap_or(false), false);
                json!(true)
            }),
            "probeBeside" => {
                let exe = std::env::current_exe().map_err(|e| e.to_string())?;
                let to = vtffmpeg::pack_dir().join(vt::ffprobe_file(util::node_platform()));
                std::fs::create_dir_all(vtffmpeg::pack_dir()).map_err(|e| e.to_string())?;
                std::fs::copy(&exe, &to).map_err(|e| e.to_string())?;
                let _ = vtproc::make_executable(&to);
                Ok(json!(to.to_string_lossy()))
            }
            "pids" => {
                let t = std::fs::read_to_string(s(&o, "file")).map_err(|e| e.to_string())?;
                let v: Vec<u32> = t.split_whitespace().filter_map(|x| x.parse().ok()).collect();
                Ok(json!(v))
            }
            "alive" => {
                let v: Vec<bool> = o.get("pids").and_then(|p| p.as_array()).map(|xs| xs.iter().map(|x| x.as_u64().map(|p| p > 0 && vtproc::alive(p as u32)).unwrap_or(false)).collect()).unwrap_or_default();
                Ok(json!(v))
            }
            "seen" => with_lab(|lab| json!(lab.server.seen.lock().map(|g| g.clone()).unwrap_or_default())),
            "sha" => {
                let p = s(&o, "path");
                Ok(json!(vtfetch::sha256_file(Path::new(&p))?))
            }
            other => Err(format!("unknown op {}", other)),
        }
    })
    .await?
}
