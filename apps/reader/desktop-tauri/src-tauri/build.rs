// Tauri's own build step, and (stages R4, R5) which of Tauri's newer web-view and window functions the resolved Tauri
// has (apidetect.rs): each found sets a cfg (kr_cookie_read, kr_cookie_all, kr_cookie_delete, kr_clear_all,
// kr_download_api — src/browser.rs —; kr_set_icon, kr_default_icon — src/appicon.rs —; kr_zoom, kr_progress —
// src/winbits.rs) that the code uses; the build's log says what was found ("KR build: …").
mod apidetect;
// (Stage R6b: whether the window can be given its colour before the page paints — bootdetect.rs.)
mod bootdetect;

fn main() {
    for c in apidetect::CFGS.iter() {
        println!("cargo:rustc-check-cfg=cfg({})", c);
    }
    println!("cargo:rerun-if-changed=Cargo.lock");
    println!("cargo:rerun-if-changed=apidetect.rs");
    let dir = std::env::var_os("CARGO_MANIFEST_DIR").map(std::path::PathBuf::from).unwrap_or_default();
    let lock = std::fs::read_to_string(dir.join("Cargo.lock")).unwrap_or_default();
    match apidetect::locked_version(&lock, "tauri") {
        None => println!("cargo:warning=KR build: no tauri in Cargo.lock; the in-app browser goes without cookies read/deleted, clearing and caught downloads; the window without its icon set, zoom and taskbar progress"),
        Some(v) => {
            let src = apidetect::cargo_home().and_then(|h| apidetect::crate_src(&h, "tauri", &v));
            match src {
                None => println!("cargo:warning=KR build: tauri {} — its source not found in Cargo's registry; the in-app browser goes without cookies read/deleted, clearing and caught downloads; the window without its icon set, zoom and taskbar progress", v),
                Some(s) => {
                    let found = apidetect::detect(&apidetect::squeeze_tree(&s));
                    let mut said: Vec<String> = Vec::new();
                    for f in found.iter() {
                        if f.on {
                            println!("cargo:rustc-cfg={}", f.cfg);
                        }
                        said.push(format!("{} {}", if f.on { "yes" } else { "no" }, f.what));
                    }
                    println!("cargo:warning=KR build: tauri {} — {}", v, said.join("; "));
                }
            }
        }
    }
    // (Stage R6b: the window's colour before the page paints — bootdetect.rs, src/boot.rs —, where Tauri's
    // background_color and tauri-utils' Color are as written for.)
    println!("cargo:rustc-check-cfg=cfg({})", bootdetect::CFG);
    println!("cargo:rerun-if-changed=bootdetect.rs");
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
    println!("cargo:warning=KR build (R6b): {} the window's colour before the page paints (background_color)", if bg { "yes" } else { "no" });
    tauri_build::build()
}
