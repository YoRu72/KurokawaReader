// Whether the Tauri this build resolved can give a window its colour before the page paints (stage R6b: no white
// flash at start — src/boot.rs): `background_color(mut self, color: Color) -> Self` on the web-view window builder
// (and the web view's), with that Color being tauri-utils' `Color(pub u8, pub u8, pub u8, pub u8)`, reached as
// `tauri::utils::config::Color` (`pub use tauri_utils as utils;`). Found in the crates' own source, as apidetect.rs
// finds the browser's functions; used by build.rs (cfg kr_bg_color); std only, checked alone with
// `rustc --edition 2021 --test bootdetect.rs`. Its input is apidetect.rs's squeezed source (no whitespace).
#![allow(dead_code)]

/// The cfg it sets.
pub const CFG: &str = "kr_bg_color";

/// `tauri`: the squeezed source of the tauri crate; `utils`: the squeezed source of the tauri-utils crate it locked.
pub fn bg_color(tauri: &str, utils: &str) -> bool {
    let sig = "pubfnbackground_color(mutself,color:Color)->Self{";
    tauri.matches(sig).count() >= 2
        && tauri.contains("pubusetauri_utilsasutils;")
        && utils.contains("pubstructColor(pubu8,pubu8,pubu8,pubu8);")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sq(s: &str) -> String {
        s.chars().filter(|c| !c.is_whitespace()).collect()
    }

    #[test]
    fn found() {
        let t = sq("pub use tauri_utils as utils;\n  #[must_use]\n  pub fn background_color(mut self, color: Color) -> Self {\n  }\n  pub fn background_color(mut self, color: Color) -> Self {}");
        let u = sq("#[derive(Debug)]\npub struct Color(pub u8, pub u8, pub u8, pub u8);");
        assert!(bg_color(&t, &u));
        assert!(!bg_color(&t, ""));
        assert!(!bg_color(&sq("pub use tauri_utils as utils; pub fn background_color(mut self, color: Color) -> Self {}"), &u));
        assert!(!bg_color(&sq("pub fn background_color(mut self, color: Color) -> Self {} pub fn background_color(mut self, color: Color) -> Self {}"), &u));
        assert!(!bg_color(&sq("pub use tauri_utils as utils; pub fn background_color(mut self, color: Option<Color>) -> Self {} pub fn background_color(mut self, color: Option<Color>) -> Self {}"), &u));
    }
}
