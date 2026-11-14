// Which of Tauri's and its plugins' newer functions this build resolved has, found by reading their own source — the
// versions in Cargo.lock, their files in Cargo's registry — so the code that uses one is compiled only where it exists,
// with the signature written for it; anything not found leaves that part out (the build's log says which: «KT build:
// …»). The Reader's way (apps/reader/desktop-tauri/src-tauri/apidetect.rs, whose helpers these are, unchanged), with
// Tools' own cfg names. Used by build.rs; std only, checked alone with `rustc --edition 2021 --test apidetect.rs`.
use std::path::{Path, PathBuf};

/// A function found, its cfg name (`kt_<name>`), and what it gives (for the build's log).
pub struct Found {
    pub cfg: &'static str,
    pub what: &'static str,
    pub on: bool,
}

/// The cfg names this can set (for `rustc-check-cfg`).
pub const CFGS: [&str; 4] = ["kt_reveal", "kt_set_icon", "kt_default_icon", "kt_progress"];

/// The version of `name` in a Cargo.lock's text.
pub fn locked_version(lock: &str, name: &str) -> Option<String> {
    let want = format!("name = \"{}\"", name);
    let mut lines = lock.lines();
    while let Some(l) = lines.next() {
        if l.trim() == want {
            let v = lines.next()?.trim();
            let v = v.strip_prefix("version = \"")?.strip_suffix('"')?;
            return Some(v.to_string());
        }
    }
    None
}

/// Rust source without its comments' text (from «//» to the line's end), without any whitespace and without the
/// comma that may end a list: what is left can be searched for a signature however it was laid out.
pub fn squeeze(src: &str) -> String {
    let mut out = String::with_capacity(src.len() / 2);
    for line in src.lines() {
        let code = match line.find("//") {
            Some(i) => &line[..i],
            None => line,
        };
        out.extend(code.chars().filter(|c| !c.is_whitespace()));
    }
    // (A list laid out one item a line ends with a comma: «Url,)» is «Url)».)
    out.replace(",)", ")").replace(",}", "}").replace(",>", ">")
}

/// Every .rs file under `dir`, squeezed and joined.
pub fn squeeze_tree(dir: &Path) -> String {
    let mut out = String::new();
    let mut stack: Vec<PathBuf> = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let rd = match std::fs::read_dir(&d) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().map(|x| x == "rs").unwrap_or(false) {
                if let Ok(t) = std::fs::read_to_string(&p) {
                    out.push_str(&squeeze(&t));
                    out.push('\n');
                }
            }
        }
    }
    out
}

/// Where Cargo keeps a crate's source: <cargo home>/registry/src/<index>/<name>-<version>/src.
pub fn crate_src(cargo_home: &Path, name: &str, version: &str) -> Option<PathBuf> {
    let reg = cargo_home.join("registry").join("src");
    for e in std::fs::read_dir(&reg).ok()?.flatten() {
        let p = e.path().join(format!("{}-{}", name, version)).join("src");
        if p.is_dir() {
            return Some(p);
        }
    }
    None
}

/// Cargo's home: $CARGO_HOME, else ~/.cargo.
pub fn cargo_home() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("CARGO_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(h));
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".cargo"))
}

/// What the squeezed source of tauri-plugin-opener offers: «show in folder» with the item chosen (kt:open −1).
pub fn detect_opener(src: &str) -> Vec<Found> {
    let reveal = src.contains(&squeeze("pub fn reveal_item_in_dir<P: AsRef<Path>>(&self, p: P)"))
        || src.contains(&squeeze("pub fn reveal_item_in_dir<P: AsRef<Path>>(&self, path: P)"));
    vec![Found { cfg: "kt_reveal", what: "an item shown in its folder (Opener::reveal_item_in_dir)", on: reveal }]
}

/// What the squeezed source of the tauri crate offers (the window's icon — appicon —, its taskbar progress). A
/// method counts only when it is there twice: on Window and on WebviewWindow.
pub fn detect_tauri(src: &str) -> Vec<Found> {
    let twice = |s: &str| src.matches(&squeeze(s)).count() >= 2;
    let has = |s: &str| src.contains(&squeeze(s));
    let set_icon = twice("pub fn set_icon(&self, icon: Image<'_>) -> crate::Result<()>");
    let default_icon = has("pub fn default_window_icon(&self) -> Option<&Image<'_>>") && has("pub fn to_owned(self) -> Image<'static>");
    let progress = twice("pub fn set_progress_bar(&self, progress_state:")
        && src
            .find(&squeeze("pub struct ProgressBarState {"))
            .map(|i| {
                let mut a = i.saturating_sub(160);
                while !src.is_char_boundary(a) {
                    a -= 1;
                }
                src[a..i].contains("Deserialize")
            })
            .unwrap_or(false);
    vec![
        Found { cfg: "kt_set_icon", what: "the window's icon set (set_icon)", on: set_icon },
        Found { cfg: "kt_default_icon", what: "the default icon given back (default_window_icon)", on: default_icon },
        Found { cfg: "kt_progress", what: "taskbar progress (set_progress_bar)", on: progress },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock() {
        let l = "[[package]]\nname = \"tauri-plugin-opener\"\nversion = \"2.4.0\"\n\n[[package]]\nname = \"tauri\"\nversion = \"2.9.3\"\nsource = \"x\"\n";
        assert_eq!(locked_version(l, "tauri").as_deref(), Some("2.9.3"));
        assert_eq!(locked_version(l, "tauri-plugin-opener").as_deref(), Some("2.4.0"));
        assert_eq!(locked_version(l, "wry"), None);
    }

    #[test]
    fn opener() {
        let src = squeeze("impl<R: Runtime> Opener<R> {\n    /// Reveal a path the system's file explorer.\n    pub fn reveal_item_in_dir<P: AsRef<Path>>(\n        &self,\n        p: P,\n    ) -> Result<()> {\n");
        assert!(detect_opener(&src)[0].on);
        let free_only = squeeze("pub fn reveal_item_in_dir<P: AsRef<Path>>(path: P) -> crate::Result<()> {");
        assert!(!detect_opener(&free_only)[0].on);
        assert!(!detect_opener("").iter().any(|f| f.on));
    }

    #[test]
    fn tauri_window() {
        let one = "pub fn set_icon(&self, icon: Image<'_>) -> crate::Result<()> {\n  pub fn set_progress_bar(\n    &self,\n    progress_state: crate::window::ProgressBarState,\n  ) -> crate::Result<()> {\n";
        let src = squeeze(&format!("{}{}pub fn default_window_icon(&self) -> Option<&Image<'_>> {{\npub fn to_owned(self) -> Image<'static> {{\n#[derive(Debug, Deserialize)]\npub struct ProgressBarState {{\n", one, one));
        let f = detect_tauri(&src);
        assert!(f.iter().all(|x| x.on));
        assert!(detect_tauri(&squeeze(one)).iter().all(|x| !x.on));
        let mut all: Vec<&str> = detect_opener("").iter().map(|x| x.cfg).collect();
        all.extend(f.iter().map(|x| x.cfg));
        assert_eq!(all, CFGS.to_vec());
    }

    #[test]
    fn tree() {
        let d = std::env::temp_dir().join(format!("kt-apidetect-{}", std::process::id()));
        let reg = d.join("registry").join("src").join("index.crates.io-abc").join("tauri-plugin-opener-2.4.0").join("src");
        std::fs::create_dir_all(&reg).unwrap();
        std::fs::write(reg.join("lib.rs"), "pub fn reveal_item_in_dir<P: AsRef<Path>>(&self, p: P) -> Result<()> {}").unwrap();
        let src = crate_src(&d, "tauri-plugin-opener", "2.4.0").unwrap();
        assert!(crate_src(&d, "tauri-plugin-opener", "2.0.0").is_none());
        assert!(detect_opener(&squeeze_tree(&src))[0].on);
        let _ = std::fs::remove_dir_all(&d);
    }
}
