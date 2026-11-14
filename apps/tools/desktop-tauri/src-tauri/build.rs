// Tauri's own build step, and (stage P3, the Reader's way) which of Tauri's and its plugins' newer functions the
// resolved versions have (apidetect.rs): each found sets a cfg the code uses — kt_reveal (src/filecmds.rs: «show in
// folder» with the item chosen), kt_set_icon / kt_default_icon / kt_progress (the window's icon and taskbar progress,
// for the stages that use them) —; the build's log says what was found («KT build: …»). Nothing found leaves those
// parts out; the build never fails for it.
mod apidetect;
// (Start-up: whether the window can be given its colour before the page paints — the Reader's bootdetect.rs, read in
// place: one source for both apps, as the setup program reads it.)
#[path = "../../../reader/desktop-tauri/src-tauri/bootdetect.rs"]
mod bootdetect;

fn main() {
    for c in apidetect::CFGS.iter().chain(apidetect::CFGS_P6.iter()).chain(apidetect::CFGS_P7.iter()).chain(apidetect::CFGS_SCR.iter()) {
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
        // (Screen translator: screentr.rs — the mouse's place, the click-through caption, an event to one window.)
        ("tauri", apidetect::detect_tauri_scr as fn(&str) -> Vec<apidetect::Found>),
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
    // (Start-up timing: the window opens in the page's own colour where Tauri's background_color and tauri-utils' Color
    // are as written for — src/boot.rs.)
    println!("cargo:rustc-check-cfg=cfg({})", bootdetect::CFG);
    println!("cargo:rerun-if-changed=../../../reader/desktop-tauri/src-tauri/bootdetect.rs");
    let bg = apidetect::locked_version(&lock, "tauri")
        .zip(apidetect::locked_version(&lock, "tauri-utils"))
        .and_then(|(tv, uv)| {
            let h = home.as_ref()?;
            let t = apidetect::crate_src(h, "tauri", &tv)?;
            let u = apidetect::crate_src(h, "tauri-utils", &uv)?;
            Some(bootdetect::bg_color(&apidetect::squeeze_tree(&t), &apidetect::squeeze_tree(&u)))
        })
        .unwrap_or(false);
    if bg {
        println!("cargo:rustc-cfg={}", bootdetect::CFG);
    }
    println!("cargo:warning=KT build (start-up): {} the window's colour before the page paints (background_color)", if bg { "yes" } else { "no" });
    // (The hybrid closures — notifier.rs, mediawatch.rs, cookiecarry.rs: each native call where the resolved crate has
    // it. notify-rust and webkit2gtk are named by this shell too (Cargo.toml), so they count only when the lock holds ONE
    // version of each — the plugin's and wry's —; else their types would not be the ones Tauri hands over.)
    for c in apidetect::CFGS_HYB.iter() {
        println!("cargo:rustc-check-cfg=cfg({})", c);
    }
    let mut hyb: Vec<String> = Vec::new();
    let mut hyb_on: Vec<&'static str> = Vec::new();
    for (krate, single, detect) in [
        ("tauri", false, apidetect::detect_tauri_hyb as fn(&str) -> Vec<apidetect::Found>),
        ("notify-rust", true, apidetect::detect_notify as fn(&str) -> Vec<apidetect::Found>),
        ("webkit2gtk", true, apidetect::detect_webkit as fn(&str) -> Vec<apidetect::Found>),
        ("cookie", false, apidetect::detect_cookie as fn(&str) -> Vec<apidetect::Found>),
    ] {
        let all = apidetect::locked_versions(&lock, krate);
        if single && all.len() > 1 {
            hyb.push(format!("{}: {} versions resolved ({}) — left out", krate, all.len(), all.join(", ")));
            continue;
        }
        // (The newest resolved, for a crate several users name in different versions — cookie.)
        let v = all.iter().max_by(|a, b| apidetect::version_cmp(a, b)).cloned();
        match v.and_then(|v| home.as_ref().and_then(|h| apidetect::crate_src(h, krate, &v)).map(|s| (v, s))) {
            None => hyb.push(format!("{}: its source not found here", krate)),
            Some((v, s)) => {
                let squeezed = apidetect::squeeze_tree(&s);
                let found = detect(&squeezed);
                let mut parts: Vec<String> = Vec::new();
                for f in found.iter() {
                    if f.on {
                        println!("cargo:rustc-cfg={}", f.cfg);
                        hyb_on.push(f.cfg);
                    }
                    parts.push(format!("{} {}", if f.on { "yes" } else { "no" }, f.what));
                }
                // (The web view's own object not found: why, for the next run — the original system's piece C.)
                if krate == "tauri" && !found.iter().any(|f| f.cfg == "kt_webview_gtk" && f.on) {
                    parts.push(format!("[{}]", apidetect::webview_diag(&squeezed)));
                }
                hyb.push(format!("{} {} — {}", krate, v, parts.join("; ")));
            }
        }
    }
    println!("cargo:warning=KT build (hybrid): {}", hyb.join(" | "));
    // (The original system — ../PORTING.md «The original Rust system — piece by piece»: which native paths this build
    // has. Each is a Cargo feature (wv2 on by default since CI run 43599725459 checked it clean; native-toast, wkgtk,
    // mac-unc off until the self-test proves them — CI's «Original system — compile try» turns on what compiles on its
    // runner); WebView2's watch also needs webview2-com and windows resolved once each (kt_wv2_single), else wry's
    // objects are not this shell's types and the header probe stands in.)
    for c in apidetect::CFGS_ORIG.iter() {
        println!("cargo:rustc-check-cfg=cfg({})", c);
    }
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let feat = |f: &str| std::env::var_os(format!("CARGO_FEATURE_{}", f.to_ascii_uppercase().replace('-', "_"))).is_some();
    let wv2_single = apidetect::single_version(&lock, "webview2-com") && apidetect::single_version(&lock, "windows");
    if wv2_single {
        println!("cargo:rustc-cfg=kt_wv2_single");
    }
    let vers = |c: &str| apidetect::locked_versions(&lock, c).join("+");
    let wv2_why = if !feat("wv2") { "feature wv2 off".to_string() } else if !wv2_single { format!("webview2-com {} / windows {} not one each", vers("webview2-com"), vers("windows")) } else { String::new() };
    let gtk_on = hyb_on.contains(&"kt_webview_gtk") && hyb_on.contains(&"kt_wk_resources");
    let gtk_why = if !feat("wkgtk") { "feature wkgtk off" } else if !gtk_on { "WebKitGTK's calls not found (the hybrid line says why)" } else { "" };
    let mut items: Vec<(&str, bool, String)> = Vec::new();
    match os.as_str() {
        "windows" => {
            items.push(("a toast from Rust, its click in-process (WinRT; native-toast)", feat("native-toast"), if feat("native-toast") { String::new() } else { "feature native-toast off — PowerShell's toast".to_string() }));
            items.push((
                "WebView2's own responses (WebResourceResponseReceived; wv2)",
                feat("wv2") && wv2_single,
                format!("{}{}", wv2_why, if wv2_why.is_empty() { String::new() } else { format!(" — webview2-com {}, windows {}", vers("webview2-com"), vers("windows")) }),
            ));
        }
        "linux" => items.push(("WebKitGTK's own responses (resource-load-started; wkgtk)", feat("wkgtk") && gtk_on, gtk_why.to_string())),
        "macos" => items.push(("a notice through UNUserNotificationCenter, its click by its delegate (mac-unc)", feat("mac-unc"), if feat("mac-unc") { String::new() } else { "feature mac-unc off — its crates are not in this build".to_string() })),
        _ => {}
    }
    let shown: Vec<(&str, bool, &str)> = items.iter().map(|(a, b, c)| (*a, *b, c.as_str())).collect();
    println!("cargo:warning=KT build (original): {}", if shown.is_empty() { "nothing native for this system yet".to_string() } else { apidetect::original_line(&shown) });
    tauri_build::build()
}
