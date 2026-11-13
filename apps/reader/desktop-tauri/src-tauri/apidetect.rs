// Which of Tauri's newer web-view functions the Tauri this build resolved has (stage R4: the in-app browser), found
// by reading that Tauri's own source — the version in Cargo.lock, its files in Cargo's registry — so the code that
// uses one is compiled only where it exists, with the signature written for it; anything not found (another
// signature, the source not where Cargo keeps it) leaves that part out and the browser does without it (PORTING.md
// says what each brings). Used by build.rs; std only, checked alone with `rustc --edition 2021 --test apidetect.rs`.
use std::path::{Path, PathBuf};

/// A function found, its cfg name (`kr_<name>`), and what it gives (for the build's log).
pub struct Found {
    pub cfg: &'static str,
    pub what: &'static str,
    pub on: bool,
}

/// The cfg names this can set (for `rustc-check-cfg`).
pub const CFGS: [&str; 5] = ["kr_cookie_read", "kr_cookie_all", "kr_cookie_delete", "kr_clear_all", "kr_download_api"];

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

/// What the squeezed source of the Tauri crate (all its files) offers. A method counts only when it is there twice —
/// on Webview and on WebviewWindow (browser.rs calls it on a WebviewWindow) —, a builder's hook on WebviewBuilder and
/// WebviewWindowBuilder alike.
pub fn detect(src: &str) -> Vec<Found> {
    let twice = |s: &str| src.matches(&squeeze(s)).count() >= 2;
    let has = |s: &str| src.contains(&squeeze(s));
    let cookie_read = twice("pub fn cookies_for_url(&self, url: Url) -> crate::Result<Vec<Cookie<'static>>>");
    let cookie_all = twice("pub fn cookies(&self) -> crate::Result<Vec<Cookie<'static>>>");
    // (Taken by value — an owned cookie from cookies_for_url fits each of these.)
    let cookie_delete = cookie_read
        && (twice("pub fn delete_cookie(&self, cookie: Cookie<'_>)")
            || twice("pub fn delete_cookie(&self, cookie: Cookie<'static>)")
            || twice("pub fn delete_cookie(&self, cookie: Cookie)"));
    let clear_all = twice("pub fn clear_all_browsing_data(&self) -> crate::Result<()>");
    let download = twice("pub fn on_download<F: Fn(Webview<R>, DownloadEvent<'_>) -> bool + Send + Sync + 'static>(")
        && has("pub enum DownloadEvent<'a> {")
        && has("Requested { url: Url, destination: &'a mut PathBuf")
        && has("Finished { url: Url, path: Option<PathBuf>, success: bool");
    vec![
        Found { cfg: "kr_cookie_read", what: "the browser's cookies of a site read (cookies_for_url)", on: cookie_read },
        Found { cfg: "kr_cookie_all", what: "all the browser's cookies read (cookies)", on: cookie_all },
        Found { cfg: "kr_cookie_delete", what: "a cookie of the browser deleted (delete_cookie)", on: cookie_delete },
        Found { cfg: "kr_clear_all", what: "the browser's data cleared (clear_all_browsing_data)", on: clear_all },
        Found { cfg: "kr_download_api", what: "downloads in the browser caught (on_download)", on: download },
    ]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock() {
        let l = "[[package]]\nname = \"tauri-build\"\nversion = \"2.0.1\"\n\n[[package]]\nname = \"tauri\"\nversion = \"2.9.3\"\nsource = \"x\"\n";
        assert_eq!(locked_version(l, "tauri").as_deref(), Some("2.9.3"));
        assert_eq!(locked_version(l, "tauri-build").as_deref(), Some("2.0.1"));
        assert_eq!(locked_version(l, "wry"), None);
    }

    #[test]
    fn signatures() {
        let one = r#"
  /// Returns all cookies in the runtime's cookie store for the given URL.
  pub fn cookies_for_url(
    &self,
    url: Url, // the address
  ) -> crate::Result<Vec<Cookie<'static>>> {
  pub fn cookies(&self) -> crate::Result<Vec<Cookie<'static>>> {
  pub fn delete_cookie(&self, cookie: Cookie<'_>) -> crate::Result<()> {
  pub fn clear_all_browsing_data(&self) -> crate::Result<()> {
  pub fn on_download<F: Fn(Webview<R>, DownloadEvent<'_>) -> bool + Send + Sync + 'static>(
"#;
        let src = format!("{}{}{}", one, one, r#"
pub enum DownloadEvent<'a> {
  Requested {
    /// The url being downloaded.
    url: Url,
    /// Where it goes.
    destination: &'a mut PathBuf,
  },
  Finished {
    url: Url,
    path: Option<PathBuf>,
    success: bool,
  },
}
"#);
        let s = squeeze(&src);
        let f = detect(&s);
        assert_eq!(f.iter().map(|x| (x.cfg, x.on)).collect::<Vec<_>>(), vec![("kr_cookie_read", true), ("kr_cookie_all", true), ("kr_cookie_delete", true), ("kr_clear_all", true), ("kr_download_api", true)]);
        // (Only on one of Webview / WebviewWindow: not used.)
        let once = squeeze(&format!("{}{}", one, "pub enum DownloadEvent<'a> { Requested { url: Url, destination: &'a mut PathBuf }, Finished { url: Url, path: Option<PathBuf>, success: bool } }"));
        assert!(detect(&once).iter().all(|x| !x.on));
        let older = "pub fn clear_all_browsing_data(&self) -> crate::Result<()> {\npub fn cookies(&self) -> crate::Result<Vec<Cookie<'static>>> {\n";
        let older = squeeze(&older.repeat(2));
        assert_eq!(detect(&older).iter().filter(|x| x.on).map(|x| x.cfg).collect::<Vec<_>>(), vec!["kr_cookie_all", "kr_clear_all"]);
        let by_ref = "pub fn cookies_for_url(&self, url: Url) -> crate::Result<Vec<Cookie<'static>>> {\npub fn delete_cookie(&self, cookie: &Cookie<'_>) -> crate::Result<()> {\n";
        let by_ref = squeeze(&by_ref.repeat(2));
        assert_eq!(detect(&by_ref).iter().filter(|x| x.on).map(|x| x.cfg).collect::<Vec<_>>(), vec!["kr_cookie_read"]);
        assert_eq!(CFGS.to_vec(), f.iter().map(|x| x.cfg).collect::<Vec<_>>());
    }

    #[test]
    fn tree() {
        let d = std::env::temp_dir().join(format!("kr-apidetect-{}", std::process::id()));
        let reg = d.join("registry").join("src").join("index.crates.io-abc").join("tauri-2.9.3").join("src").join("webview");
        std::fs::create_dir_all(&reg).unwrap();
        std::fs::write(reg.join("mod.rs"), "pub fn clear_all_browsing_data(&self)\n  -> crate::Result<()> {}").unwrap();
        std::fs::write(reg.join("webview_window.rs"), "  pub fn clear_all_browsing_data(\n    &self,\n  ) -> crate::Result<()> {}").unwrap();
        std::fs::write(reg.join("notes.txt"), "pub fn cookies_for_url(&self, url: Url) -> crate::Result<Vec<Cookie<'static>>>").unwrap();
        let src = crate_src(&d, "tauri", "2.9.3").unwrap();
        assert!(src.ends_with("src"));
        assert!(crate_src(&d, "tauri", "2.0.0").is_none());
        let on: Vec<&str> = detect(&squeeze_tree(&src)).iter().filter(|x| x.on).map(|x| x.cfg).collect();
        assert_eq!(on, vec!["kr_clear_all"]);
        let _ = std::fs::remove_dir_all(&d);
    }
}
