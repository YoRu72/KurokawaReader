// KurokawaReader Setup's build step:
//   1. the NSIS installer embedded: the file named by KR_SETUP_INNER (R6b's installer, built and given its one screen
//      first — setup/INTEGRATION.md) copied to OUT_DIR/inner.bin, which main.rs includes; not given: an empty file
//      (a build for trying the window: `--inner <path>` or kr-inner-setup.exe beside the program then);
//   2. the version shown (apps/reader/package.json) and the size of the program installed (KR_SETUP_APP_BYTES — the
//      bare KurokawaReader.exe's, for «Copying files» by bytes; "0" when not given);
//   3. whether this Tauri can colour the window before its page paints (cfg kr_bg_color) — the app's own detection,
//      ../../src-tauri/apidetect.rs and bootdetect.rs, read in place (not copied, so both stay one);
//   4. Tauri's own build step.
#[path = "../../src-tauri/apidetect.rs"]
#[allow(dead_code)]
mod apidetect;
#[path = "../../src-tauri/bootdetect.rs"]
mod bootdetect;

use std::path::PathBuf;

fn main() {
    let out = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let dir = std::env::var_os("CARGO_MANIFEST_DIR").map(PathBuf::from).unwrap_or_default();

    println!("cargo:rerun-if-env-changed=KR_SETUP_INNER");
    let target = out.join("inner.bin");
    match std::env::var_os("KR_SETUP_INNER").map(PathBuf::from) {
        Some(p) if p.is_file() => {
            println!("cargo:rerun-if-changed={}", p.display());
            std::fs::copy(&p, &target).expect("copy KR_SETUP_INNER");
            let mb = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0) as f64 / 1048576.0;
            println!("cargo:warning=KR setup: embedded {} ({:.2} MB)", p.display(), mb);
        }
        Some(p) => panic!("KR_SETUP_INNER is not a file: {}", p.display()),
        None => {
            std::fs::write(&target, b"").expect("write inner.bin");
            println!("cargo:warning=KR setup: no KR_SETUP_INNER — no installer embedded (try it with --inner <setup.exe>)");
        }
    }

    let pkg = dir.join("../../../package.json");
    println!("cargo:rerun-if-changed={}", pkg.display());
    let version = std::fs::read_to_string(&pkg).ok().and_then(|t| version_of(&t)).unwrap_or_else(|| "0.0.0".into());
    println!("cargo:rustc-env=KR_SETUP_VERSION={}", version);
    println!("cargo:rerun-if-env-changed=KR_SETUP_APP_BYTES");
    let bytes = std::env::var("KR_SETUP_APP_BYTES").ok().filter(|s| s.chars().all(|c| c.is_ascii_digit()) && !s.is_empty()).unwrap_or_else(|| "0".into());
    println!("cargo:rustc-env=KR_SETUP_APP_BYTES={}", bytes);

    println!("cargo:rustc-check-cfg=cfg({})", bootdetect::CFG);
    println!("cargo:rerun-if-changed=Cargo.lock");
    let lock = std::fs::read_to_string(dir.join("Cargo.lock")).unwrap_or_default();
    let bg = apidetect::locked_version(&lock, "tauri")
        .zip(apidetect::locked_version(&lock, "tauri-utils"))
        .and_then(|(tv, uv)| {
            let home = apidetect::cargo_home()?;
            let t = apidetect::crate_src(&home, "tauri", &tv)?;
            let u = apidetect::crate_src(&home, "tauri-utils", &uv)?;
            Some(bootdetect::bg_color(&apidetect::squeeze_tree(&t), &apidetect::squeeze_tree(&u)))
        })
        .unwrap_or(false);
    if bg {
        println!("cargo:rustc-cfg={}", bootdetect::CFG);
    }
    println!("cargo:warning=KR setup: version {}, app {} bytes; {} the window's colour before the page paints", version, bytes, if bg { "yes" } else { "no (shown when painted)" });
    tauri_build::build()
}

/// package.json's "version" (as logic::package_version; kept here so the build step needs nothing of src/).
fn version_of(json: &str) -> Option<String> {
    let at = json.find("\"version\"")?;
    let rest = &json[at + 9..];
    let rest = rest[rest.find(':')? + 1..].trim_start().strip_prefix('"')?;
    Some(rest[..rest.find('"')?].to_string())
}
