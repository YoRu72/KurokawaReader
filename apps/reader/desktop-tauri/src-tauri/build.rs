// Tauri's own build step, and (stage R4) which of Tauri's newer web-view functions the resolved Tauri has
// (apidetect.rs): each found sets a cfg (kr_cookie_read, kr_cookie_delete, kr_clear_all, kr_download_api) that
// src/browser.rs uses; the build's log says what was found ("KR build: …").
mod apidetect;

fn main() {
    for c in apidetect::CFGS.iter() {
        println!("cargo:rustc-check-cfg=cfg({})", c);
    }
    println!("cargo:rerun-if-changed=Cargo.lock");
    println!("cargo:rerun-if-changed=apidetect.rs");
    let dir = std::env::var_os("CARGO_MANIFEST_DIR").map(std::path::PathBuf::from).unwrap_or_default();
    let lock = std::fs::read_to_string(dir.join("Cargo.lock")).unwrap_or_default();
    match apidetect::locked_version(&lock, "tauri") {
        None => println!("cargo:warning=KR build: no tauri in Cargo.lock; the in-app browser goes without cookies read/deleted, clearing and caught downloads"),
        Some(v) => {
            let src = apidetect::cargo_home().and_then(|h| apidetect::crate_src(&h, "tauri", &v));
            match src {
                None => println!("cargo:warning=KR build: tauri {} — its source not found in Cargo's registry; the in-app browser goes without cookies read/deleted, clearing and caught downloads", v),
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
    tauri_build::build()
}
