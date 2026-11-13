// The updater's decisions (stage R6b), std only, so they are checked alone: `rustc --edition 2021 --test
// updatelogic.rs` (the workflow's «Std-only unit tests»). What kind of copy this is (installed by the NSIS installer,
// the portable zip, an AppImage, a .deb, a Mac's .app, a bare program), which release and which of its files is the
// update for it, the release's names for those files (also desktop/rustswitch.cjs's and src/updateCore.ts's —
// tests/updatenames.cjs keeps the three equal), the checksum it must have (GitHub's digest or the release's
// SHA256SUMS file), resuming a download that broke off (Range / Content-Range), and how the installer is run. The
// network, the files and the processes are update.rs's.
#![allow(dead_code)]
use std::cmp::Ordering;

/// The product's name, the first word of every release file's name.
pub const APP: &str = "KurokawaReader";

/// What kind of copy is running, which decides how it is updated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Windows, installed by the NSIS installer (an uninstall.exe beside the program): the new installer run silently.
    Nsis,
    /// Windows, the portable zip (a `KurokawaReader.portable` file beside the program): replaced by hand.
    Portable,
    /// Linux, run as an AppImage ($APPIMAGE): the file replaced in place.
    AppImage,
    /// Linux, installed from the .deb (the program under /usr): the new package opened in the system's installer.
    Deb,
    /// macOS, inside a .app bundle: the new disk image opened.
    MacApp,
    /// A program run from where it was built (CI's self-test): never updated.
    Bare,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Nsis => "nsis",
            Kind::Portable => "portable",
            Kind::AppImage => "appimage",
            Kind::Deb => "deb",
            Kind::MacApp => "app",
            Kind::Bare => "bare",
        }
    }
    /// Whether this copy installs an update by itself (in the background too): the installer's, the AppImage.
    pub fn installs_itself(self) -> bool {
        matches!(self, Kind::Nsis | Kind::AppImage)
    }
}

/// The marker file the portable zip carries beside the program.
pub const PORTABLE_MARKER: &str = "KurokawaReader.portable";

/// The kind of copy, from what is known at start: the OS (Node's name), the program's path, $APPIMAGE, whether an
/// uninstall.exe is beside the program, whether the portable marker is.
pub fn kind_of(os: &str, exe: &str, appimage: Option<&str>, has_uninstaller: bool, portable_marker: bool) -> Kind {
    let exe_n = exe.replace('\\', "/");
    match os {
        "win32" => {
            if portable_marker {
                Kind::Portable
            } else if has_uninstaller {
                Kind::Nsis
            } else {
                Kind::Bare
            }
        }
        "darwin" => {
            if exe_n.contains(".app/Contents/MacOS/") {
                Kind::MacApp
            } else {
                Kind::Bare
            }
        }
        _ => {
            if appimage.map(|a| !a.trim().is_empty()).unwrap_or(false) {
                Kind::AppImage
            } else if exe_n.starts_with("/usr/") {
                Kind::Deb
            } else {
                Kind::Bare
            }
        }
    }
}

/// Two versions in SemVer's order (as src/updateCore.ts's cmpVersion): the numbers first, then a pre-release
/// («-beta.2») before the release itself, its parts compared as numbers where both are numbers, else as text; build
/// metadata («+…») and a leading «v» left out.
pub fn cmp_versions(a: &str, b: &str) -> Ordering {
    fn parse(v: &str) -> (Vec<u64>, Vec<String>) {
        let s = v.trim();
        let s = s.strip_prefix('v').or_else(|| s.strip_prefix('V')).unwrap_or(s);
        let s = s.split('+').next().unwrap_or("");
        let (core, pre) = match s.find('-') {
            Some(i) => (&s[..i], &s[i + 1..]),
            None => (s, ""),
        };
        let core: Vec<u64> = core.split('.').map(|x| x.parse::<u64>().unwrap_or(0)).collect();
        let pre: Vec<String> = pre.split('.').filter(|x| !x.is_empty()).map(|x| x.to_string()).collect();
        (core, pre)
    }
    let (xc, xp) = parse(a);
    let (yc, yp) = parse(b);
    let n = xc.len().max(yc.len()).max(3);
    for i in 0..n {
        let d = xc.get(i).copied().unwrap_or(0).cmp(&yc.get(i).copied().unwrap_or(0));
        if d != Ordering::Equal {
            return d;
        }
    }
    if xp.is_empty() || yp.is_empty() {
        return match (xp.is_empty(), yp.is_empty()) {
            (true, true) => Ordering::Equal,
            (false, true) => Ordering::Less,
            _ => Ordering::Greater,
        };
    }
    for i in 0..xp.len().max(yp.len()) {
        let (p, q) = match (xp.get(i), yp.get(i)) {
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(p), Some(q)) => (p, q),
        };
        let pn = !p.is_empty() && p.chars().all(|c| c.is_ascii_digit());
        let qn = !q.is_empty() && q.chars().all(|c| c.is_ascii_digit());
        let d = if pn && qn {
            p.parse::<u64>().unwrap_or(0).cmp(&q.parse::<u64>().unwrap_or(0))
        } else if pn != qn {
            if pn {
                Ordering::Less
            } else {
                Ordering::Greater
            }
        } else {
            p.cmp(q)
        };
        if d != Ordering::Equal {
            return d;
        }
    }
    Ordering::Equal
}

/// The version of a reader release tag («v0.71.0» → 0.71.0); None for another app's tag («tools-v1.0.0») or a tag
/// that is not a version.
pub fn version_of_tag(tag: &str) -> Option<String> {
    let v = tag.strip_prefix('v')?;
    let mut parts = v.splitn(3, '.');
    let ok = parts.next().map(|x| !x.is_empty() && x.chars().all(|c| c.is_ascii_digit())).unwrap_or(false)
        && parts.next().map(|x| x.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)).unwrap_or(false);
    if ok {
        Some(v.to_string())
    } else {
        None
    }
}

/// Node's arch name as the release files spell it (x64, arm64; anything else as given).
fn arch_word(arch: &str) -> &str {
    match arch {
        "x86_64" | "amd64" => "x64",
        "aarch64" => "arm64",
        a => a,
    }
}

/// The release file this kind of copy updates from, for a version (Node's OS and arch names). None where there is
/// none (a bare program).
pub fn asset_name(version: &str, os: &str, arch: &str, kind: Kind) -> Option<String> {
    let a = arch_word(arch);
    let tail = match (os, kind) {
        ("win32", Kind::Nsis) => format!("windows-{}-setup.exe", a),
        ("win32", Kind::Portable) => format!("windows-{}-portable.zip", a),
        ("darwin", Kind::MacApp) => "macos-universal.dmg".to_string(),
        ("linux", Kind::AppImage) => format!("linux-{}.AppImage", a),
        ("linux", Kind::Deb) => format!("linux-{}.deb", a),
        _ => return None,
    };
    Some(format!("{}-{}-{}", APP, version, tail))
}

/// Whether `name` is the file for this copy in a release of `version`: asset_name's, or on a Mac the disk image for
/// this processor alone (a release may carry those beside or instead of the universal one).
pub fn asset_fits(name: &str, version: &str, os: &str, arch: &str, kind: Kind) -> bool {
    if asset_name(version, os, arch, kind).as_deref() == Some(name) {
        return true;
    }
    os == "darwin" && kind == Kind::MacApp && name == format!("{}-{}-macos-{}.dmg", APP, version, arch_word(arch))
}

/// The release's checksum file (sha256sum's format: «<64 hex>  <name>» a line).
pub fn sums_name(version: &str) -> String {
    format!("{}-{}-SHA256SUMS.txt", APP, version)
}

/// The version in a release file's name («KurokawaReader-0.71.0-beta.1-windows-x64-setup.exe» → 0.71.0-beta.1), the
/// Electron build's names too («…-0.61.0-win-x64.exe»).
pub fn version_of_asset(name: &str) -> Option<String> {
    let rest = name.strip_prefix(APP)?.strip_prefix('-')?;
    let marks = ["-windows-", "-macos-", "-linux-", "-win-", "-mac-", "-SHA256SUMS", "-ios-", "-arm64-v8a", "-armeabi", "-x86_64", "-universal"];
    let cut = marks.iter().filter_map(|m| rest.find(m)).min()?;
    let v = &rest[..cut];
    if v.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
        Some(v.to_string())
    } else {
        None
    }
}

/// The address of another file of the same release: `url` with its last part (before any «?») made `name`.
pub fn sibling_url(url: &str, name: &str) -> Option<String> {
    let base = url.split(['?', '#']).next().unwrap_or("");
    let i = base.rfind('/')?;
    if i < base.find("://").map(|j| j + 3).unwrap_or(0) {
        return None;
    }
    Some(format!("{}{}", &base[..=i], name))
}

/// The last part of an address (the file's name), %-escapes left as they are.
pub fn file_of_url(url: &str) -> String {
    let base = url.split(['?', '#']).next().unwrap_or("");
    base.rsplit('/').next().unwrap_or("").to_string()
}

/// A SHA256SUMS file's lines → (hash in lower case, name); «<hex>  <name>», «<hex> *<name>» (binary mode), blank
/// lines and comments skipped.
pub fn parse_sums(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let l = line.trim_end_matches('\r').trim();
        if l.is_empty() || l.starts_with('#') {
            continue;
        }
        let (hash, rest) = match l.split_once(char::is_whitespace) {
            Some(x) => x,
            None => continue,
        };
        if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let name = rest.trim_start().trim_start_matches('*').trim();
        if !name.is_empty() {
            out.push((hash.to_ascii_lowercase(), name.to_string()));
        }
    }
    out
}

/// The hash a SHA256SUMS file gives `name` (a path in it reduced to its last part).
pub fn sum_for(text: &str, name: &str) -> Option<String> {
    parse_sums(text)
        .into_iter()
        .find(|(_, n)| n.rsplit(['/', '\\']).next().unwrap_or(n) == name)
        .map(|(h, _)| h)
}

/// GitHub's digest of an asset («sha256:<64 hex>») → the hash in lower case.
pub fn digest_sha256(d: &str) -> Option<String> {
    let h = d.trim().strip_prefix("sha256:")?;
    if h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(h.to_ascii_lowercase())
    } else {
        None
    }
}

/// Why a file was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Neither GitHub's digest nor the release's SHA256SUMS names it.
    NoChecksum,
    /// The two disagree (the release was changed under us).
    Conflict,
    /// Its size is not the release's.
    Size { want: u64, got: u64 },
    /// Its SHA-256 is not the release's.
    Sha,
}

impl Refusal {
    /// The code the page turns into a sentence (src/updates.ts): «kr-update:<code>».
    pub fn code(&self) -> String {
        match self {
            Refusal::NoChecksum => "kr-update:nochecksum".to_string(),
            Refusal::Conflict => "kr-update:checksum".to_string(),
            Refusal::Size { want, got } => format!("kr-update:size {} {}", want, got),
            Refusal::Sha => "kr-update:checksum".to_string(),
        }
    }
}

/// The SHA-256 a file must have: GitHub's digest and the SHA256SUMS line, whichever there are (both: they must agree).
pub fn expected_sha(digest: Option<&str>, sums_line: Option<&str>) -> Result<String, Refusal> {
    let a = digest.and_then(digest_sha256);
    let b = sums_line.map(|s| s.trim().to_ascii_lowercase()).filter(|s| s.len() == 64);
    match (a, b) {
        (Some(x), Some(y)) if x != y => Err(Refusal::Conflict),
        (Some(x), _) => Ok(x),
        (None, Some(y)) => Ok(y),
        (None, None) => Err(Refusal::NoChecksum),
    }
}

/// The file kept or refused: its size against the release's (when the release states one: 0 is «not stated»), its
/// hash against the one expected.
pub fn verify(want_size: u64, got_size: u64, want_sha: &str, got_sha: &str) -> Result<(), Refusal> {
    if want_size > 0 && want_size != got_size {
        return Err(Refusal::Size { want: want_size, got: got_size });
    }
    if !want_sha.eq_ignore_ascii_case(got_sha.trim()) {
        return Err(Refusal::Sha);
    }
    Ok(())
}

/// A release file, as GitHub's API lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct Asset {
    pub name: String,
    pub url: String,
    pub size: u64,
    pub digest: Option<String>,
}

/// A release, as GitHub's API lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct Release {
    pub tag: String,
    pub draft: bool,
    pub prerelease: bool,
    pub page: String,
    pub assets: Vec<Asset>,
}

/// The update chosen: its version, its file for this copy, the release's checksum file (if it has one), its page.
#[derive(Clone, Debug, PartialEq)]
pub struct Pick {
    pub version: String,
    pub asset: Asset,
    pub sums: Option<Asset>,
    pub page: String,
}

/// The update for this copy: of the reader's releases (tags v<version>, not drafts, pre-releases only on the beta
/// channel), the newest that has this copy's file, when it is newer than `current`.
pub fn pick_update(list: &[Release], current: &str, beta: bool, os: &str, arch: &str, kind: Kind) -> Option<Pick> {
    let mut best: Option<Pick> = None;
    for r in list {
        if r.draft || (r.prerelease && !beta) {
            continue;
        }
        let v = match version_of_tag(&r.tag) {
            Some(v) => v,
            None => continue,
        };
        if !beta && v.contains('-') {
            continue;
        }
        if cmp_versions(&v, current) != Ordering::Greater {
            continue;
        }
        if let Some(b) = &best {
            if cmp_versions(&v, &b.version) != Ordering::Greater {
                continue;
            }
        }
        let asset = match r.assets.iter().find(|a| asset_fits(&a.name, &v, os, arch, kind)) {
            Some(a) => a.clone(),
            None => continue,
        };
        let sums = r.assets.iter().find(|a| a.name == sums_name(&v)).cloned();
        best = Some(Pick { version: v, asset, sums, page: r.page.clone() });
    }
    best
}

/// A Content-Range header («bytes 100-199/1000», «bytes */1000») → (first byte, last byte, total), each None where
/// it says «*».
pub fn parse_content_range(s: &str) -> Option<(Option<u64>, Option<u64>, Option<u64>)> {
    let s = s.trim();
    let rest = s.strip_prefix("bytes")?.trim_start();
    let (span, total) = rest.split_once('/')?;
    let total = if total.trim() == "*" { None } else { Some(total.trim().parse::<u64>().ok()?) };
    if span.trim() == "*" {
        return Some((None, None, total));
    }
    let (a, b) = span.trim().split_once('-')?;
    Some((Some(a.trim().parse().ok()?), Some(b.trim().parse().ok()?), total))
}

/// The Range header that asks for the rest of a file of which `have` bytes are kept (None: from the start).
pub fn range_header(have: u64) -> Option<String> {
    if have > 0 {
        Some(format!("bytes={}-", have))
    } else {
        None
    }
}

/// What to do with an answer to a request that asked for the rest from `have`.
#[derive(Debug, PartialEq, Eq)]
pub enum Resume {
    /// The rest comes: written after what is kept.
    Append,
    /// The whole file comes (the server ignored the range, or answered a range that does not start where the kept
    /// part ends): what was kept is thrown away and the answer written from the start.
    Restart,
    /// Nothing more to fetch: what is kept is the whole file (416 with its total equal to it).
    Done,
    /// Refused for good (an HTTP error): «HTTP <status>».
    Fail(u16),
}

/// The decision for an answer's status and Content-Range, `have` bytes being kept.
pub fn on_response(status: u16, have: u64, content_range: Option<&str>) -> Resume {
    match status {
        206 => match content_range.and_then(parse_content_range) {
            Some((Some(first), _, _)) if first == have => Resume::Append,
            _ => Resume::Restart,
        },
        200 => Resume::Restart,
        416 => match content_range.and_then(parse_content_range) {
            Some((_, _, Some(total))) if total == have && have > 0 => Resume::Done,
            _ => Resume::Restart,
        },
        s => Resume::Fail(s),
    }
}

/// The whole size of the file an answer brings (the Content-Range's total, else what is kept plus its length).
pub fn total_of(have_after_decision: u64, content_range: Option<&str>, content_length: Option<u64>) -> Option<u64> {
    if let Some((_, _, Some(t))) = content_range.and_then(parse_content_range) {
        return Some(t);
    }
    content_length.map(|n| n + have_after_decision)
}

/// The progress the page is told (main.cjs's kr:update-progress): a whole percentage, 0 while the size is unknown.
pub fn pct(got: u64, total: u64) -> u64 {
    if total == 0 {
        0
    } else {
        ((got.min(total) as f64 / total as f64) * 100.0).round() as u64
    }
}

/// The NSIS installer's switches (Tauri's template): installed now, at the person's word — a progress window
/// (/P, passive), the app started again after (/R), as an update (/UPDATE: the data and shortcuts kept) —; or
/// silently when the app quits (/S), not started again.
pub fn installer_args(now: bool) -> Vec<&'static str> {
    if now {
        vec!["/P", "/R", "/UPDATE"]
    } else {
        vec!["/S", "/UPDATE"]
    }
}

/// Whether an address is on this computer (http://127.0.0.1, http://localhost, http://[::1], any port): the only
/// place a test may point the update check at (KR_UPDATE_FEED).
pub fn is_loopback(url: &str) -> bool {
    let rest = match url.strip_prefix("http://") {
        Some(r) => r,
        None => return false,
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = if let Some(h) = host.strip_prefix('[') {
        h.split(']').next().unwrap_or("")
    } else {
        host.split(':').next().unwrap_or("")
    };
    host == "127.0.0.1" || host == "localhost" || host == "::1"
}

/// Where the releases are read from: GitHub's API for `repo`, or a test's feed on this computer (KR_UPDATE_FEED —
/// anything else in it is ignored).
pub fn feed_url(env: Option<&str>, repo: &str) -> String {
    match env {
        Some(u) if is_loopback(u) => u.to_string(),
        _ => format!("https://api.github.com/repos/{}/releases?per_page=60", repo),
    }
}

/// A name a downloaded file may be kept under in the update folder: the release file's own when it is plain
/// (letters, digits, «.», «-», «_», «+»), else «update.bin».
pub fn safe_name(name: &str) -> String {
    let ok = !name.is_empty()
        && name.len() <= 160
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'));
    if ok {
        name.to_string()
    } else {
        "update.bin".to_string()
    }
}

/// Whether progress may be told again (at most every 400 ms, and always at the end), as main.cjs's.
pub fn tell(last_ms: u128, now_ms: u128, done: bool) -> bool {
    done || now_ms.saturating_sub(last_ms) >= 400
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(tag: &str, pre: bool, names: &[&str]) -> Release {
        Release {
            tag: tag.to_string(),
            draft: false,
            prerelease: pre,
            page: format!("https://github.com/x/y/releases/tag/{}", tag),
            assets: names
                .iter()
                .map(|n| Asset { name: n.to_string(), url: format!("https://github.com/x/y/releases/download/{}/{}", tag, n), size: 10, digest: None })
                .collect(),
        }
    }

    #[test]
    fn versions() {
        assert_eq!(cmp_versions("0.62.0", "0.61.9"), Ordering::Greater);
        assert_eq!(cmp_versions("v1.2", "1.2.0"), Ordering::Equal);
        assert_eq!(cmp_versions("1.0.0-beta.2", "1.0.0"), Ordering::Less);
        assert_eq!(cmp_versions("1.0.0-beta.10", "1.0.0-beta.2"), Ordering::Greater);
        assert_eq!(cmp_versions("1.0.0-alpha", "1.0.0-alpha.1"), Ordering::Less);
        assert_eq!(cmp_versions("1.0.0-1", "1.0.0-alpha"), Ordering::Less);
        assert_eq!(cmp_versions("1.0.0+build", "1.0.0"), Ordering::Equal);
        assert_eq!(cmp_versions("0.10.0", "0.9.9"), Ordering::Greater);
        assert_eq!(version_of_tag("v0.71.0").as_deref(), Some("0.71.0"));
        assert_eq!(version_of_tag("v1.0.0-beta.1").as_deref(), Some("1.0.0-beta.1"));
        assert_eq!(version_of_tag("tools-v1.0.0"), None);
        assert_eq!(version_of_tag("vnext"), None);
        assert_eq!(version_of_tag("v1"), None);
    }

    #[test]
    fn kinds() {
        assert_eq!(kind_of("win32", "C:\\Users\\a\\AppData\\Local\\KurokawaReader\\KurokawaReader.exe", None, true, false), Kind::Nsis);
        assert_eq!(kind_of("win32", "D:\\Apps\\KR\\KurokawaReader.exe", None, false, true), Kind::Portable);
        assert_eq!(kind_of("win32", "D:\\Apps\\KR\\KurokawaReader.exe", None, true, true), Kind::Portable);
        assert_eq!(kind_of("win32", "D:\\a\\target\\release\\KurokawaReader.exe", None, false, false), Kind::Bare);
        assert_eq!(kind_of("darwin", "/Applications/KurokawaReader.app/Contents/MacOS/KurokawaReader", None, false, false), Kind::MacApp);
        assert_eq!(kind_of("darwin", "/Users/r/target/release/KurokawaReader", None, false, false), Kind::Bare);
        assert_eq!(kind_of("linux", "/tmp/.mount_Kuro/usr/bin/KurokawaReader", Some("/home/a/KurokawaReader.AppImage"), false, false), Kind::AppImage);
        assert_eq!(kind_of("linux", "/usr/bin/KurokawaReader", Some(""), false, false), Kind::Deb);
        assert_eq!(kind_of("linux", "/home/r/target/release/KurokawaReader", None, false, false), Kind::Bare);
        assert!(Kind::Nsis.installs_itself() && Kind::AppImage.installs_itself());
        assert!(!Kind::Deb.installs_itself() && !Kind::MacApp.installs_itself() && !Kind::Portable.installs_itself() && !Kind::Bare.installs_itself());
        assert_eq!(Kind::MacApp.name(), "app");
    }

    #[test]
    fn names() {
        assert_eq!(asset_name("0.71.0", "win32", "x64", Kind::Nsis).as_deref(), Some("KurokawaReader-0.71.0-windows-x64-setup.exe"));
        assert_eq!(asset_name("0.71.0", "win32", "arm64", Kind::Portable).as_deref(), Some("KurokawaReader-0.71.0-windows-arm64-portable.zip"));
        assert_eq!(asset_name("0.71.0", "darwin", "arm64", Kind::MacApp).as_deref(), Some("KurokawaReader-0.71.0-macos-universal.dmg"));
        assert_eq!(asset_name("0.71.0", "linux", "x64", Kind::AppImage).as_deref(), Some("KurokawaReader-0.71.0-linux-x64.AppImage"));
        assert_eq!(asset_name("0.71.0", "linux", "x86_64", Kind::Deb).as_deref(), Some("KurokawaReader-0.71.0-linux-x64.deb"));
        assert_eq!(asset_name("0.71.0", "linux", "x64", Kind::Bare), None);
        assert_eq!(asset_name("0.71.0", "win32", "x64", Kind::Bare), None);
        assert!(asset_fits("KurokawaReader-0.71.0-macos-arm64.dmg", "0.71.0", "darwin", "arm64", Kind::MacApp));
        assert!(!asset_fits("KurokawaReader-0.71.0-macos-x64.dmg", "0.71.0", "darwin", "arm64", Kind::MacApp));
        // (The Electron build's names never fit the Rust build, nor its own the Electron one's.)
        assert!(!asset_fits("KurokawaReader-0.71.0-win-x64.exe", "0.71.0", "win32", "x64", Kind::Nsis));
        assert!(!asset_fits("KurokawaReader-0.71.0-mac-universal.dmg", "0.71.0", "darwin", "x64", Kind::MacApp));
        assert_eq!(sums_name("0.71.0"), "KurokawaReader-0.71.0-SHA256SUMS.txt");
        assert_eq!(version_of_asset("KurokawaReader-0.71.0-beta.1-windows-x64-setup.exe").as_deref(), Some("0.71.0-beta.1"));
        assert_eq!(version_of_asset("KurokawaReader-0.61.0-win-x64.exe").as_deref(), Some("0.61.0"));
        assert_eq!(version_of_asset("KurokawaReader-0.61.0-win-x64-portable.exe").as_deref(), Some("0.61.0"));
        assert_eq!(version_of_asset("KurokawaReader-0.71.0-SHA256SUMS.txt").as_deref(), Some("0.71.0"));
        assert_eq!(version_of_asset("KurokawaReader-web.zip"), None);
        assert_eq!(version_of_asset("Other-1.0.0-windows-x64-setup.exe"), None);
        assert_eq!(
            sibling_url("https://github.com/x/y/releases/download/v0.71.0/KurokawaReader-0.71.0-windows-x64-setup.exe?a=1", "S.txt").as_deref(),
            Some("https://github.com/x/y/releases/download/v0.71.0/S.txt")
        );
        assert_eq!(sibling_url("http://127.0.0.1:8080/f.exe", "S.txt").as_deref(), Some("http://127.0.0.1:8080/S.txt"));
        assert_eq!(sibling_url("https://host", "S.txt"), None);
        assert_eq!(file_of_url("https://h/a/b/KurokawaReader-1.0.0-linux-x64.deb#x"), "KurokawaReader-1.0.0-linux-x64.deb");
        assert_eq!(safe_name("KurokawaReader-1.0.0-windows-x64-setup.exe"), "KurokawaReader-1.0.0-windows-x64-setup.exe");
        assert_eq!(safe_name("../evil.exe"), "update.bin");
        assert_eq!(safe_name("a b.exe"), "update.bin");
        assert_eq!(safe_name(""), "update.bin");
    }

    #[test]
    fn sums() {
        let h1 = "a".repeat(64);
        let h2 = "B".repeat(64);
        let text = format!("# made by the release\n{}  KurokawaReader-1.0.0-windows-x64-setup.exe\r\n{} *dist/KurokawaReader-1.0.0-linux-x64.deb\nnot a line\n{} short\n", h1, h2, "c".repeat(10));
        assert_eq!(parse_sums(&text).len(), 2);
        assert_eq!(sum_for(&text, "KurokawaReader-1.0.0-windows-x64-setup.exe").as_deref(), Some(h1.as_str()));
        assert_eq!(sum_for(&text, "KurokawaReader-1.0.0-linux-x64.deb"), Some("b".repeat(64)));
        assert_eq!(sum_for(&text, "KurokawaReader-1.0.0-linux-x64.AppImage"), None);
        assert_eq!(digest_sha256(&format!("sha256:{}", h2)), Some("b".repeat(64)));
        assert_eq!(digest_sha256("sha512:abc"), None);
        assert_eq!(digest_sha256("sha256:abc"), None);
        assert_eq!(expected_sha(Some(&format!("sha256:{}", h1)), None), Ok(h1.clone()));
        assert_eq!(expected_sha(None, Some(&h1)), Ok(h1.clone()));
        assert_eq!(expected_sha(Some(&format!("sha256:{}", h1)), Some(&h1.to_uppercase())), Ok(h1.clone()));
        assert_eq!(expected_sha(Some(&format!("sha256:{}", h1)), Some(&h2)), Err(Refusal::Conflict));
        assert_eq!(expected_sha(None, None), Err(Refusal::NoChecksum));
        assert_eq!(expected_sha(Some("sha256:zz"), None), Err(Refusal::NoChecksum));
        assert_eq!(verify(10, 10, &h1, &h1.to_uppercase()), Ok(()));
        assert_eq!(verify(0, 99, &h1, &h1), Ok(()));
        assert_eq!(verify(10, 9, &h1, &h1), Err(Refusal::Size { want: 10, got: 9 }));
        assert_eq!(verify(10, 10, &h1, &h2), Err(Refusal::Sha));
        assert_eq!(Refusal::Size { want: 10, got: 9 }.code(), "kr-update:size 10 9");
        assert_eq!(Refusal::Sha.code(), "kr-update:checksum");
        assert_eq!(Refusal::NoChecksum.code(), "kr-update:nochecksum");
    }

    #[test]
    fn picking() {
        let list = vec![
            rel("v0.70.0", false, &["KurokawaReader-0.70.0-win-x64.exe", "latest.yml"]),
            rel("v0.71.0", false, &["KurokawaReader-0.71.0-win-x64.exe", "KurokawaReader-0.71.0-windows-x64-setup.exe", "KurokawaReader-0.71.0-SHA256SUMS.txt", "KurokawaReader-0.71.0-linux-x64.AppImage"]),
            rel("v0.72.0-beta.1", true, &["KurokawaReader-0.72.0-beta.1-windows-x64-setup.exe"]),
            rel("tools-v9.0.0", true, &["KurokawaTools-9.0.0-windows-x64-setup.exe"]),
            Release { draft: true, ..rel("v0.99.0", false, &["KurokawaReader-0.99.0-windows-x64-setup.exe"]) },
        ];
        let p = pick_update(&list, "0.70.0", false, "win32", "x64", Kind::Nsis).unwrap();
        assert_eq!(p.version, "0.71.0");
        assert_eq!(p.asset.name, "KurokawaReader-0.71.0-windows-x64-setup.exe");
        assert_eq!(p.sums.as_ref().map(|a| a.name.as_str()), Some("KurokawaReader-0.71.0-SHA256SUMS.txt"));
        assert!(p.page.ends_with("/v0.71.0"));
        let b = pick_update(&list, "0.70.0", true, "win32", "x64", Kind::Nsis).unwrap();
        assert_eq!(b.version, "0.72.0-beta.1");
        assert!(b.sums.is_none());
        assert_eq!(pick_update(&list, "0.71.0", false, "win32", "x64", Kind::Nsis), None);
        assert_eq!(pick_update(&list, "0.70.0", false, "win32", "x64", Kind::Portable), None);
        assert_eq!(pick_update(&list, "0.70.0", false, "win32", "x64", Kind::Bare), None);
        assert_eq!(pick_update(&list, "0.70.0", false, "linux", "x64", Kind::AppImage).unwrap().version, "0.71.0");
        assert_eq!(pick_update(&list, "0.70.0", false, "linux", "x64", Kind::Deb), None);
        // (A newer release without this copy's file is passed over for an older one that has it.)
        let mut l2 = list.clone();
        l2.push(rel("v0.73.0", false, &["KurokawaReader-0.73.0-linux-x64.deb"]));
        assert_eq!(pick_update(&l2, "0.70.0", false, "win32", "x64", Kind::Nsis).unwrap().version, "0.71.0");
        // (A stable channel never takes a version with a «-» even when a release forgot its pre-release mark.)
        let l3 = vec![rel("v0.80.0-rc.1", false, &["KurokawaReader-0.80.0-rc.1-windows-x64-setup.exe"])];
        assert_eq!(pick_update(&l3, "0.70.0", false, "win32", "x64", Kind::Nsis), None);
        assert!(pick_update(&l3, "0.70.0", true, "win32", "x64", Kind::Nsis).is_some());
    }

    #[test]
    fn resuming() {
        assert_eq!(parse_content_range("bytes 100-199/1000"), Some((Some(100), Some(199), Some(1000))));
        assert_eq!(parse_content_range("bytes */1000"), Some((None, None, Some(1000))));
        assert_eq!(parse_content_range("bytes 0-9/*"), Some((Some(0), Some(9), None)));
        assert_eq!(parse_content_range("items 1-2/3"), None);
        assert_eq!(parse_content_range("bytes x-y/3"), None);
        assert_eq!(range_header(0), None);
        assert_eq!(range_header(1048576).as_deref(), Some("bytes=1048576-"));
        assert_eq!(on_response(206, 100, Some("bytes 100-999/1000")), Resume::Append);
        assert_eq!(on_response(206, 100, Some("bytes 0-999/1000")), Resume::Restart);
        assert_eq!(on_response(206, 100, None), Resume::Restart);
        assert_eq!(on_response(200, 100, None), Resume::Restart);
        assert_eq!(on_response(200, 0, None), Resume::Restart);
        assert_eq!(on_response(416, 1000, Some("bytes */1000")), Resume::Done);
        assert_eq!(on_response(416, 900, Some("bytes */1000")), Resume::Restart);
        assert_eq!(on_response(404, 0, None), Resume::Fail(404));
        assert_eq!(on_response(503, 10, None), Resume::Fail(503));
        assert_eq!(total_of(100, Some("bytes 100-999/1000"), Some(900)), Some(1000));
        assert_eq!(total_of(0, None, Some(900)), Some(900));
        assert_eq!(total_of(0, None, None), None);
        assert_eq!(pct(0, 0), 0);
        assert_eq!(pct(50, 200), 25);
        assert_eq!(pct(300, 200), 100);
        assert!(tell(0, 400, false) && !tell(100, 400, false) && tell(100, 101, true));
    }

    #[test]
    fn running_and_feed() {
        assert_eq!(installer_args(true), vec!["/P", "/R", "/UPDATE"]);
        assert_eq!(installer_args(false), vec!["/S", "/UPDATE"]);
        assert!(is_loopback("http://127.0.0.1:4567/releases"));
        assert!(is_loopback("http://localhost/releases"));
        assert!(is_loopback("http://[::1]:80/x"));
        assert!(!is_loopback("https://127.0.0.1/x"));
        assert!(!is_loopback("http://127.0.0.1.evil.example/x"));
        assert!(!is_loopback("http://example.org/?h=127.0.0.1"));
        assert_eq!(feed_url(Some("http://127.0.0.1:9/r"), "a/b"), "http://127.0.0.1:9/r");
        assert_eq!(feed_url(Some("https://evil.example/r"), "a/b"), "https://api.github.com/repos/a/b/releases?per_page=60");
        assert_eq!(feed_url(None, "YoRu72/KurokawaReader"), "https://api.github.com/repos/YoRu72/KurokawaReader/releases?per_page=60");
    }
}
