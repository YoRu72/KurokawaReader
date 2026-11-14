// Tauri's own build step, and (stage P3, the Reader's way) which of Tauri's and its plugins' newer functions the
// resolved versions have (apidetect.rs): each found sets a cfg the code uses — kt_reveal (src/filecmds.rs: «show in
// folder» with the item chosen), kt_set_icon / kt_default_icon / kt_progress (the window's icon and taskbar progress,
// for the stages that use them) —; the build's log says what was found («KT build: …»). Nothing found leaves those
// parts out; the build never fails for it.
mod apidetect;

fn main() {
    for c in apidetect::CFGS.iter().chain(apidetect::CFGS_P6.iter()).chain(apidetect::CFGS_P7.iter()) {
        println!("cargo:rustc-check-cfg=cfg({})", c);
    }
    println!("cargo:rerun-if-changed=Cargo.lock");
    println!("cargo:rerun-if-changed=apidetect.rs");
    let dir = std::env::var_os("CARGO_MANIFEST_DIR").map(std::path::PathBuf::from).unwrap_or_default();
    let lock = std::fs::read_to_string(dir.join("Cargo.lock")).unwrap_or_default();
    let home = apidetect::cargo_home();
    let mut said: Vec<String> = Vec::new();
    for (krate, detect) in [
        ("tauri", apidetect::detect_tauri as fn(&str) -> Vec<apidetect::Found>),
        ("tauri-plugin-opener", apidetect::detect_opener as fn(&str) -> Vec<apidetect::Found>),
        // (Stage P6: desktop.rs — the tray's left click, the dock's count, the global shortcuts.)
        ("tauri", apidetect::detect_tauri_p6 as fn(&str) -> Vec<apidetect::Found>),
        ("tauri-plugin-global-shortcut", apidetect::detect_shortcut as fn(&str) -> Vec<apidetect::Found>),
        // (Stage P7: browser.rs — the browser's cookies, its downloads.)
        ("tauri", apidetect::detect_tauri_p7 as fn(&str) -> Vec<apidetect::Found>),
    ] {
        let src = apidetect::locked_version(&lock, krate)
            .and_then(|v| home.as_ref().and_then(|h| apidetect::crate_src(h, krate, &v)).map(|s| (v, s)));
        match src {
            None => said.push(format!("{}: its source not found (nothing of it detected)", krate)),
            Some((v, s)) => {
                let found = detect(&apidetect::squeeze_tree(&s));
                let mut parts: Vec<String> = Vec::new();
                for f in found.iter() {
                    if f.on {
                        println!("cargo:rustc-cfg={}", f.cfg);
                    }
                    parts.push(format!("{} {}", if f.on { "yes" } else { "no" }, f.what));
                }
                said.push(format!("{} {} — {}", krate, v, parts.join("; ")));
            }
        }
    }
    println!("cargo:warning=KT build: {}", said.join(" | "));
    tauri_build::build()
}
