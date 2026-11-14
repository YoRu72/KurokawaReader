//! The video tools' rules (stage P5), std only, rule for rule from the Electron shell (desktop/ytdlp.cjs,
//! gallerydl.cjs, ffmpeg.cjs, packs.cjs, transcode.cjs, streamproxy.cjs) so both shells decide the same; checked alone
//! with `rustc --edition 2021 --test videotools.rs`:
//! - which program file each system fetches (yt-dlp, gallery-dl) and the names they are kept under, the ffmpeg pack's;
//! - versions: yt-dlp's oldest allowed release, «older than» as ytdlp.cjs compares, whether an update is due (a pin
//!   after a rollback), the kept older copies (yt-dlp.<v>.old: the newest three) and the checksum line of SHA2-256SUMS;
//! - the argument list: the page's own list vetted (vetArgs: only the flags videoArgs.ts writes, no value that is a
//!   flag, no file name pattern leaving the download folder), or a task's older way built from its settings; `-J`;
//! - yt-dlp's output read into the task (the progress template's KT| lines, the phases, one bar over the streams,
//!   fragments) — ytdlp.cjs lineReader; its error line;
//! - ffmpeg's `-progress pipe:1` key=value stream; the transcode stream's and the sound track's ffmpeg arguments and
//!   the hardware encoders tried per system (transcode.cjs, streamproxy.cjs); the stream's query read as
//!   URLSearchParams and Number() read it;
//! - a site yt-dlp is always asked about (VIDEO_HOSTS);
//! - two .srt files merged into a bilingual one (ytdlp.cjs bilingual).

/// Releases older than this are not run: a forced update instead (sites change; an old yt-dlp fails everywhere).
pub const MIN_VERSION: &str = "2025.01.01";
/// yt-dlp knows --js-runtimes since this release.
pub const JS_SINCE: &str = "2025.11.12";

/// The file yt-dlp's release offers for this system (Node's platform and arch words).
pub fn ytdlp_asset(os: &str, arch: &str) -> &'static str {
    match os {
        "win32" => "yt-dlp.exe",
        "darwin" => "yt-dlp_macos",
        // (ytdlp.cjs takes yt-dlp_linux everywhere; an ARM Linux gets the release's own build.)
        _ => {
            if arch == "arm64" {
                "yt-dlp_linux_aarch64"
            } else {
                "yt-dlp_linux"
            }
        }
    }
}
/// The name yt-dlp is kept under in the app's bin folder.
pub fn ytdlp_file(os: &str) -> &'static str {
    if os == "win32" {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    }
}
/// gallery-dl's release file for this system (its standalone builds are Windows' .exe and Linux's .bin; a Mac has
/// none — gallerydl.cjs fetched the Linux one there, which cannot run).
pub fn gallery_asset(os: &str) -> Option<&'static str> {
    match os {
        "win32" => Some("gallery-dl.exe"),
        "darwin" => None,
        _ => Some("gallery-dl.bin"),
    }
}
pub fn gallery_file(os: &str) -> &'static str {
    if os == "win32" {
        "gallery-dl.exe"
    } else {
        "gallery-dl"
    }
}
/// The ffmpeg pack's program, and ffprobe beside it.
pub fn ffmpeg_file(os: &str) -> &'static str {
    if os == "win32" {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}
pub fn ffprobe_file(os: &str) -> &'static str {
    if os == "win32" {
        "ffprobe.exe"
    } else {
        "ffprobe"
    }
}

/// ytdlp.cjs olderThan: the versions' digits and dots compared as text.
pub fn older_than(a: &str, b: &str) -> bool {
    let k = |s: &str| s.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect::<String>();
    k(a) < k(b)
}

/// Whether yt-dlp is given --js-runtimes (a release that knows it, or one whose version is unknown).
pub fn js_ok(version: Option<&str>) -> bool {
    match version {
        None => true,
        Some(v) => !older_than(v, JS_SINCE),
    }
}

/// update(force): fetch the newest release when its tag differs from what runs, unless the one here was pinned by a
/// rollback (then only when forced or below the oldest allowed).
pub fn update_due(have: Option<&str>, tag: &str, pinned: Option<&str>, force: bool) -> bool {
    let have_s = have.unwrap_or("");
    !tag.is_empty() && Some(tag) != have && (pinned.map(|p| p.is_empty()).unwrap_or(true) || older_than(have_s, MIN_VERSION) || force)
}

/// The version an older copy's name carries («yt-dlp.2025.10.22.old», «yt-dlp.exe.2025.10.22.old»); None for
/// another file.
pub fn old_version(name: &str) -> Option<String> {
    let rest = name.strip_suffix(".old")?;
    let v = rest.strip_prefix("yt-dlp.exe.").or_else(|| rest.strip_prefix("yt-dlp.")).unwrap_or(rest);
    Some(v.to_string())
}
/// The name an older copy is kept under.
pub fn old_name(managed_file: &str, version: &str) -> String {
    format!("{}.{}.old", managed_file, version)
}
/// The older copies newest first (by their time, then their version); those past the third are removed.
pub fn sort_olds(olds: &mut Vec<(String, String, u128)>) {
    olds.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| b.1.cmp(&a.1)));
}
pub const KEEP_OLDS: usize = 3;

/// The SHA-256 SHA2-256SUMS gives `asset` («<hex>  <name>» lines), lowercase.
pub fn sum_for(sums: &str, asset: &str) -> Option<String> {
    for l in sums.split('\n') {
        let p: Vec<&str> = l.trim().split_whitespace().collect();
        if p.len() >= 2 && p[1] == asset {
            return Some(p[0].to_ascii_lowercase());
        }
    }
    None
}
/// GitHub's asset digest («sha256:<hex>») → the hex.
pub fn digest_hex(d: &str) -> Option<String> {
    d.strip_prefix("sha256:").map(|x| x.to_ascii_lowercase())
}

/* ---------- the argument lists ---------- */

const ALLOWED: &[&str] = &[
    "-f", "-S", "--merge-output-format", "--remux-video", "-x", "--audio-format", "--audio-quality", "--embed-thumbnail", "--convert-thumbnails", "--embed-metadata",
    "--parse-metadata", "--embed-chapters", "--split-chapters", "--write-subs", "--write-auto-subs", "--sub-langs", "--embed-subs", "--convert-subs", "--sub-format", "-k",
    "--write-thumbnail", "--write-info-json", "--no-clean-info-json", "--write-comments", "--sponsorblock-remove", "--sponsorblock-mark", "--download-sections", "--add-header",
    "--no-playlist", "--yes-playlist", "--playlist-items", "-o", "-N", "--http-chunk-size", "--retries", "--fragment-retries", "--throttled-rate", "--buffer-size",
];
const ALONE: &[&str] = &[
    "-x", "-k", "--embed-thumbnail", "--embed-metadata", "--embed-chapters", "--split-chapters", "--write-subs", "--write-auto-subs", "--embed-subs", "--write-thumbnail",
    "--write-info-json", "--no-clean-info-json", "--write-comments", "--no-playlist", "--yes-playlist",
];
const OUT_KINDS: &[&str] = &["chapter", "thumbnail", "subtitle", "infojson", "description", "pl_thumbnail", "pl_infojson", "pl_description", "default"];

/// ytdlp.cjs vetArgs: the page's list as it is when every flag is one videoArgs.ts writes, no value is a flag and no
/// file name pattern leaves the download folder; None otherwise (the task fails «invalid options», nothing runs).
pub fn vet_args(args: &[String]) -> Option<Vec<String>> {
    if args.len() > 200 || !args.iter().all(|a| a.encode_utf16().count() <= 4000 && !a.contains('\0')) {
        return None;
    }
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if !a.starts_with('-') || !ALLOWED.contains(&a.as_str()) {
            return None;
        }
        out.push(a.clone());
        if ALONE.contains(&a.as_str()) {
            i += 1;
            continue;
        }
        i += 1;
        let v = args.get(i)?;
        if v.starts_with('-') {
            return None;
        }
        if a == "-o" {
            let mut t: &str = v;
            for k in OUT_KINDS.iter() {
                if let Some(rest) = v.strip_prefix(&format!("{}:", k)) {
                    t = rest;
                    break;
                }
            }
            let b = t.as_bytes();
            let drive = b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':';
            if t.starts_with('\\') || t.starts_with('/') || t.starts_with('~') || drive || t.contains("..") || t.contains('$') || t.contains('\0') {
                return None;
            }
        }
        out.push(v.clone());
        i += 1;
    }
    Some(out)
}

/// The JavaScript runtime yt-dlp is told of (Electron gave its own Node; this shell names one found on the PATH):
/// `--js-runtimes <name>:<path>`, only for a release that knows the option.
pub fn js_args(version: Option<&str>, runtime: Option<(&str, &str)>) -> Vec<String> {
    match runtime {
        Some((name, path)) if js_ok(version) => vec!["--js-runtimes".to_string(), format!("{}:{}", name, path)],
        _ => Vec::new(),
    }
}

/// `-J` for what a page offers (ytdlp.cjs info): read once; a playlist only flat; one video never walks its list; a
/// page that does not answer let go of after 20 s a try.
pub fn info_args(url: &str, playlist: bool, cookies_from_browser: Option<&str>, js: &[String]) -> Vec<String> {
    let mut a: Vec<String> = vec!["-J".into(), "--no-warnings".into(), "--skip-download".into(), "--socket-timeout".into(), "20".into()];
    a.extend(js.iter().cloned());
    if playlist {
        a.push("--flat-playlist".into());
    } else {
        a.push("--no-playlist".into());
    }
    if let Some(c) = cookies_from_browser.filter(|c| !c.is_empty()) {
        a.push("--cookies-from-browser".into());
        a.push(c.to_string());
    }
    a.push(url.to_string());
    a
}

/// The progress template every job runs with (the KT| lines lineReader reads).
pub const PROGRESS_TEMPLATE: &str = "download:KT|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s|%(info.filename)s";

/// A task's settings (the task's meta, as ytdlp.cjs reads it).
#[derive(Clone, Debug, Default)]
pub struct JobMeta {
    pub args: Option<Vec<String>>,
    pub audio_only: bool,
    pub format: Option<String>,
    pub container: Option<String>,
    pub subs: Option<String>,
    pub bilingual: bool,
    pub embed_thumb: bool,
    pub info_json: bool,
    pub comments: bool,
    pub live_chat: bool,
    pub cover: bool,
    /// embedMeta !== false
    pub embed_meta: bool,
    pub sponsor_mode: Option<String>,
    pub sponsorblock: bool,
    pub sponsor_cats: Option<String>,
    pub cookies_from_browser: Option<String>,
    pub chapters: bool,
    pub section: Option<String>,
    pub chapter_match: Option<String>,
    pub split_chapters: bool,
    pub headers: Vec<(String, String)>,
    pub out_name: Option<String>,
    pub template: Option<String>,
    pub playlist_index: Option<String>,
}

/// ytdlp.cjs safe(): a name given by the page made a file name (the characters a file name may not hold blanks, at
/// most 180 UTF-16 units, trimmed).
pub fn safe_name(x: &str) -> String {
    let mut out = String::new();
    let mut run = false;
    for c in x.chars() {
        if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 0x20 {
            if !run {
                out.push(' ');
                run = true;
            }
        } else {
            out.push(c);
            run = false;
        }
    }
    let t = out.trim();
    let mut n = 0;
    let mut cut = String::new();
    for c in t.chars() {
        if n + c.len_utf16() > 180 {
            break;
        }
        n += c.len_utf16();
        cut.push(c);
    }
    cut
}

fn join(dir: &str, name: &str, sep: char) -> String {
    if dir.is_empty() {
        return name.to_string();
    }
    let d = dir.trim_end_matches(|c| c == '/' || c == sep);
    format!("{}{}{}", if d.is_empty() { &dir[..1] } else { d }, sep, name)
}
fn pad2(s: &str) -> String {
    if s.chars().count() >= 2 {
        s.to_string()
    } else {
        format!("{:0>2}", s)
    }
}

/// A job's whole argument list (ytdlp.cjs VideoJobs.start), or Err("invalid options") when the page's own list does
/// not pass vet_args. `common`: --no-warnings, --no-playlist-reverse, the JavaScript runtime, --ffmpeg-location;
/// `sep` the system's path separator.
pub fn job_args(m: &JobMeta, dir: &str, url: &str, common: &[String], sep: char) -> Result<Vec<String>, String> {
    let vetted = match &m.args {
        Some(a) => Some(vet_args(a).ok_or_else(|| "invalid options".to_string())?),
        None => None,
    };
    let tpl: String = match &m.template {
        Some(t) if !t.is_empty() && !(t.contains('/') || t.contains('\\') || t.contains("..")) => t.clone(),
        _ => "%(title)s [%(id)s]".to_string(),
    };
    let lead = m.playlist_index.as_ref().filter(|p| !p.is_empty()).map(|p| format!("{} - ", pad2(p))).unwrap_or_default();
    let out_tpl = match (&m.out_name, &m.template) {
        (Some(n), _) if !n.is_empty() => join(dir, &format!("{}.%(ext)s", safe_name(n)), sep),
        (_, Some(t)) if !t.is_empty() => join(dir, &format!("{}{}.%(ext)s", lead, tpl), sep),
        _ => join(dir, &format!("{}%(title)s [%(id)s].%(ext)s", lead), sep),
    };
    let mut a: Vec<String> = common.to_vec();
    a.push("--newline".into());
    if vetted.is_none() {
        a.push("--no-playlist".into());
    }
    a.push("--continue".into());
    a.push("--no-mtime".into());
    a.push("--progress-template".into());
    a.push(PROGRESS_TEMPLATE.into());
    match &vetted {
        Some(v) => {
            a.push("-P".into());
            a.push(dir.to_string());
            a.extend(v.iter().cloned());
        }
        None => {
            a.push("-o".into());
            a.push(out_tpl.clone());
        }
    }
    let named = m.out_name.as_ref().filter(|n| !n.is_empty()).map(|n| safe_name(n)).unwrap_or_else(|| tpl.clone());
    if vetted.is_none() {
        if m.audio_only {
            a.push("-f".into());
            a.push(m.format.clone().filter(|f| !f.is_empty()).unwrap_or_else(|| "bestaudio/best".into()));
            a.push("-x".into());
            if let Some(c) = m.container.as_ref().filter(|c| !c.is_empty()) {
                a.push("--audio-format".into());
                a.push(c.clone());
            }
        } else {
            a.push("-f".into());
            a.push(match m.format.as_ref().filter(|f| !f.is_empty()) {
                Some(f) => format!("{}/best", f),
                None => "bestvideo+bestaudio/best".into(),
            });
            a.push("--merge-output-format".into());
            a.push(m.container.clone().filter(|c| !c.is_empty()).unwrap_or_else(|| "mp4".into()));
        }
        if let Some(s) = m.subs.as_ref().filter(|s| !s.is_empty()) {
            a.extend(["--write-subs".to_string(), "--sub-langs".to_string(), s.clone(), "--embed-subs".to_string()]);
            if m.bilingual {
                a.extend(["--sub-format", "srt/best", "--convert-subs", "srt", "-k"].iter().map(|x| x.to_string()));
            }
        }
        if m.embed_thumb {
            a.push("--embed-thumbnail".into());
        }
        if m.info_json {
            a.push("--write-info-json".into());
            a.push("--no-clean-info-json".into());
        }
        if m.comments {
            a.push("--write-comments".into());
        }
        if m.live_chat {
            a.push("--write-subs".into());
            a.push("--sub-langs".into());
            a.push(format!("{}live_chat", m.subs.as_ref().filter(|s| !s.is_empty()).map(|s| format!("{},", s)).unwrap_or_default()));
        }
        if m.cover {
            a.extend(["--write-thumbnail", "--convert-thumbnails", "jpg", "-o"].iter().map(|x| x.to_string()));
            a.push(format!("thumbnail:{}", join(dir, &format!("{}.%(ext)s", named), sep)));
        }
        if m.embed_meta {
            a.push("--embed-metadata".into());
        }
        let mode = m.sponsor_mode.clone().filter(|x| !x.is_empty()).unwrap_or_else(|| if m.sponsorblock { "remove".into() } else { "off".into() });
        let cats = m.sponsor_cats.clone().filter(|x| !x.is_empty()).unwrap_or_else(|| "sponsor".into());
        if mode == "remove" {
            a.push("--sponsorblock-remove".into());
            a.push(cats);
        } else if mode == "mark" {
            a.push("--sponsorblock-mark".into());
            a.push(cats);
            a.push("--embed-chapters".into());
        }
    }
    if let Some(c) = m.cookies_from_browser.as_ref().filter(|c| !c.is_empty()) {
        a.push("--cookies-from-browser".into());
        a.push(c.clone());
    }
    if vetted.is_none() {
        if m.chapters {
            a.push("--embed-chapters".into());
        }
        if let Some(sec) = m.section.as_ref().filter(|s| !s.is_empty()) {
            for s in sec.split(|c| c == ',' || c == ';').map(|s| s.trim()) {
                if section_ok(s) {
                    a.push("--download-sections".into());
                    a.push(format!("*{}", s));
                }
            }
        }
        if let Some(c) = m.chapter_match.as_ref().filter(|s| !s.is_empty()) {
            a.push("--download-sections".into());
            a.push(c.clone());
        }
        if m.split_chapters {
            a.push("--split-chapters".into());
            a.push("-o".into());
            a.push(format!("chapter:{}", join(dir, &format!("{} - %(section_number)02d %(section_title)s.%(ext)s", named), sep)));
        }
        for (k, v) in m.headers.iter() {
            if !k.is_empty() && !v.is_empty() {
                a.push("--add-header".into());
                a.push(format!("{}:{}", k, v));
            }
        }
    }
    a.push(url.to_string());
    Ok(a)
}
/// /^[\d:.]+-[\d:.]+$/
fn section_ok(s: &str) -> bool {
    let ok = |x: &str| !x.is_empty() && x.chars().all(|c| c.is_ascii_digit() || c == ':' || c == '.');
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 2 && ok(parts[0]) && ok(parts[1])
}

/* ---------- yt-dlp's output read into the task ---------- */

/// What the lines said so far (ytdlp.cjs keeps it on the task: done, total, downSpeed, eta, files, name, detail,
/// meta.phase / meta.frag / meta.frags).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Progress {
    pub done: u64,
    pub total: u64,
    pub speed: f64,
    pub eta: Option<f64>,
    pub frag: Option<(u64, u64)>,
    pub phase: Option<String>,
    /// The file's name (no folder) and whether it is whole (merged).
    pub file: Option<String>,
    pub file_whole: bool,
    pub name: Option<String>,
    pub detail: Option<String>,
}

pub struct LineReader {
    dests: u32,
    offset: u64,
    stream_total: u64,
    audio_only: bool,
    fmt: String,
    expect: u64,
    pub p: Progress,
}

fn num0(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    match t.parse::<f64>() {
        Ok(n) if n.is_finite() && !t.chars().any(|c| c.is_ascii_alphabetic() && c != 'e' && c != 'E') => n,
        _ => 0.0,
    }
}
fn base_name(p: &str) -> &str {
    p.rsplit(|c| c == '/' || c == '\\').next().unwrap_or(p)
}
/// «T.f137.mp4» → «T.mp4», «T.mp4.part» → «T.mp4».
fn stream_base(file: &str) -> String {
    let mut b = base_name(file).to_string();
    // (/\.f\d+\.(\w+)$/ → '.$1')
    if let Some(dot) = b.rfind('.') {
        let ext = &b[dot + 1..];
        if !ext.is_empty() && ext.chars().all(|c| c.is_alphanumeric() || c == '_') {
            let head = &b[..dot];
            if let Some(d2) = head.rfind('.') {
                let f = &head[d2 + 1..];
                if f.len() > 1 && f.starts_with('f') && f[1..].chars().all(|c| c.is_ascii_digit()) {
                    b = format!("{}.{}", &head[..d2], ext);
                }
            }
        }
    }
    if let Some(s) = b.strip_suffix(".part") {
        b = s.to_string();
    }
    b
}
fn stem_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) => name[..i].to_string(),
        None => name.to_string(),
    }
}
fn bracket_tag(l: &str) -> Option<&str> {
    let rest = l.strip_prefix('[')?;
    let end = rest.find(']')?;
    let tag = &rest[..end];
    if !tag.is_empty() && tag.chars().all(|c| c.is_alphanumeric() || c == '_') {
        Some(tag)
    } else {
        None
    }
}

impl LineReader {
    /// `phase`: the task's phase from an earlier run (a resumed task keeps it).
    pub fn new(audio_only: bool, audio_fmt: &str, expect: u64, phase: Option<String>) -> LineReader {
        LineReader { dests: 0, offset: 0, stream_total: 0, audio_only, fmt: audio_fmt.to_uppercase(), expect, p: Progress { phase, ..Progress::default() } }
    }
    fn phase_to(&mut self, p: &str) -> bool {
        if self.p.phase.as_deref() == Some(p) {
            return false;
        }
        self.p.phase = Some(p.to_string());
        true
    }
    fn stream_phase(&self) -> &'static str {
        if self.audio_only || self.dests > 1 {
            "audio"
        } else {
            "video"
        }
    }
    /// One line → whether the page should be told at once (the phase changed).
    pub fn line(&mut self, l: &str) -> bool {
        let mut force = false;
        if let Some(rest) = l.strip_prefix("KT|") {
            let parts: Vec<&str> = rest.split('|').collect();
            let g = |i: usize| parts.get(i).copied().unwrap_or("");
            let file = if parts.len() > 7 { parts[7..].join("|") } else { String::new() };
            let cur = num0(g(0));
            let tot = {
                let t = num0(g(1));
                if t != 0.0 {
                    t
                } else {
                    num0(g(2))
                }
            };
            if tot != 0.0 {
                self.stream_total = tot as u64;
            }
            self.p.done = self.offset + cur as u64;
            self.p.total = self.expect.max(self.offset + tot as u64);
            self.p.speed = num0(g(3));
            let eta = num0(g(4));
            self.p.eta = if eta != 0.0 { Some(eta) } else { None };
            let fc = g(6);
            if !fc.is_empty() && fc != "NA" && num0(fc) > 1.0 {
                self.p.frag = Some((num0(g(5)) as u64, num0(fc) as u64));
            } else {
                self.p.frag = None;
            }
            if self.p.phase.is_none() || self.p.phase.as_deref() == Some("info") {
                let sp = self.stream_phase();
                force = self.phase_to(sp);
            }
            if !file.is_empty() && file != "NA" {
                let base = stream_base(&file);
                let stem = stem_of(&base);
                self.p.file = Some(base);
                self.p.file_whole = false;
                if !stem.is_empty() {
                    self.p.name = Some(stem);
                }
            }
        } else if l.starts_with("[download] Destination:") {
            self.dests += 1;
            if self.dests > 1 {
                self.offset += self.stream_total;
                self.stream_total = 0;
            }
            let sp = self.stream_phase();
            force = self.phase_to(sp);
        } else if let Some(tag) = bracket_tag(l) {
            let quiet = |r: &mut LineReader| {
                r.p.speed = 0.0;
                r.p.eta = None;
            };
            if tag == "Merger" {
                force = self.phase_to("merge");
                quiet(self);
                self.p.frag = None;
            } else if tag == "ExtractAudio" {
                let p = format!("convert {}", self.fmt).trim().to_string();
                force = self.phase_to(&p);
                quiet(self);
            } else if ["EmbedThumbnail", "Metadata", "EmbedSubtitle", "ThumbnailsConvertor", "SubtitlesConvertor"].contains(&tag) {
                force = self.phase_to("embed");
                quiet(self);
            } else if ["SponsorBlock", "ModifyChapters", "SplitChapters", "VideoRemuxer", "VideoConvertor"].contains(&tag) || (tag.starts_with("Fixup")) {
                force = self.phase_to("finish");
                quiet(self);
            } else if ["info", "youtube", "generic"].contains(&tag) && self.p.phase.is_none() {
                force = self.phase_to("info");
            }
        }
        // (/\[(Merger|ExtractAudio|EmbedSubtitle|Metadata|ffmpeg)\]/ anywhere in the line: what it says, shown.)
        if ["[Merger]", "[ExtractAudio]", "[EmbedSubtitle]", "[Metadata]", "[ffmpeg]"].iter().any(|t| l.contains(t)) {
            let mut d = l;
            if let Some(tag) = bracket_tag(l) {
                d = l[tag.len() + 2..].trim_start();
            }
            self.p.detail = Some(d.chars().take(120).collect());
            if let Some(i) = l.find("Merging formats into \"") {
                let rest = &l[i + "Merging formats into \"".len()..];
                if let Some(j) = rest.rfind('"') {
                    let f = &rest[..j];
                    if !f.is_empty() {
                        let b = base_name(f).to_string();
                        self.p.name = Some(stem_of(&b));
                        self.p.file = Some(b);
                        self.p.file_whole = true;
                    }
                }
            }
        }
        force
    }
}

/// A failed job's error (ytdlp.cjs close): the last line with ERROR, else the last line, else «yt-dlp <code>»;
/// «ERROR: » taken off; at most 300 characters.
pub fn job_error(stderr: &str, code: Option<i32>) -> String {
    let t = stderr.trim();
    let lines: Vec<&str> = t.split('\n').collect();
    let pick = lines.iter().rev().find(|l| l.contains("ERROR")).copied().or_else(|| lines.last().copied().filter(|l| !l.is_empty()));
    let s = match pick {
        Some(l) => l.to_string(),
        None => format!("yt-dlp {}", code.map(|c| c.to_string()).unwrap_or_else(|| "null".to_string())),
    };
    let s = match s.strip_prefix("ERROR:") {
        Some(r) => r.trim_start().to_string(),
        None => s,
    };
    s.chars().take(300).collect()
}
/// What `-J` failed with: stderr's last line (trimmed), else the process error.
pub fn last_line(stderr: &str, fallback: &str) -> String {
    let t = stderr.trim();
    let src = if t.is_empty() { fallback.trim() } else { t };
    src.split('\n').last().unwrap_or("").trim_end_matches('\r').to_string()
}
/// gallery-dl's failure: the last non-empty line, else «gallery-dl failed».
pub fn gallery_error(stderr: &str, fallback: &str) -> String {
    let src = if stderr.is_empty() { fallback } else { stderr };
    src.split('\n').filter(|l| !l.is_empty()).last().map(|l| l.trim_end_matches('\r').to_string()).unwrap_or_else(|| "gallery-dl failed".to_string())
}

/* ---------- ffmpeg ---------- */

/// ffmpeg's `-progress pipe:1` stream (ffmpeg.cjs run): key=value lines, a block ended by «progress=…».
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FfProgress {
    pub time: Option<f64>,
    pub size: Option<f64>,
    pub speed: Option<f64>,
}
#[derive(Default)]
pub struct FfReader {
    pub cur: FfProgress,
}
impl FfReader {
    /// One line → Some((what is known, done)) at the end of a block.
    pub fn line(&mut self, l: &str) -> Option<(FfProgress, bool)> {
        let i = l.find('=')?;
        let (k, v) = (&l[..i], l[i + 1..].trim());
        match k {
            "out_time_us" | "out_time_ms" => self.cur.time = v.parse::<f64>().ok().map(|n| n / 1e6),
            "total_size" => self.cur.size = v.parse::<f64>().ok(),
            // (parseFloat: «1.5x» → 1.5; «N/A» → 0.)
            "speed" => {
                let lead: String = v.chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-' || *c == '+' || *c == 'e').collect();
                self.cur.speed = Some(lead.parse::<f64>().ok().filter(|n| n.is_finite()).unwrap_or(0.0));
            }
            "progress" => return Some((self.cur.clone(), v == "end")),
            _ => {}
        }
        None
    }
}

/// The hardware encoders tried per system before x264 (transcode.cjs CANDIDATES).
pub fn encoder_candidates(os: &str) -> &'static [&'static str] {
    match os {
        "win32" => &["h264_nvenc", "h264_qsv", "h264_amf"],
        "darwin" => &["h264_videotoolbox"],
        "linux" => &["h264_nvenc"],
        _ => &[],
    }
}
fn v(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|x| x.to_string()).collect()
}
/// transcode.cjs encArgs.
pub fn enc_args(enc: &str) -> Vec<String> {
    let even = "scale='min(1920,iw)':-2";
    let vf = |f: &str| format!("{},format={}", even, f);
    let mut a = match enc {
        "h264_nvenc" => vec!["-vf".to_string(), vf("yuv420p")],
        "h264_qsv" => vec!["-vf".to_string(), vf("nv12")],
        _ => vec!["-vf".to_string(), vf("yuv420p")],
    };
    a.extend(v(match enc {
        "h264_nvenc" => &["-c:v", "h264_nvenc", "-preset", "fast", "-rc", "vbr", "-cq", "21", "-b:v", "0", "-g", "48", "-bf", "0"],
        "h264_qsv" => &["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "22", "-g", "48", "-bf", "0"],
        "h264_amf" => &["-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", "20", "-qp_p", "22", "-g", "48", "-bf", "0"],
        "h264_videotoolbox" => &["-c:v", "h264_videotoolbox", "-realtime", "1", "-b:v", "8M", "-g", "48"],
        "libvpx-vp9" => &["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-b:v", "2M", "-g", "48"],
        _ => &["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-crf", "21", "-g", "48", "-bf", "0"],
    }));
    a
}
/// An encoder tried on a second of test picture (transcode.cjs works).
pub fn encoder_test_args(enc: &str) -> Vec<String> {
    let mut a = v(&["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=24:d=1"]);
    a.extend(enc_args(enc));
    a.extend(v(&["-f", "null", "-"]));
    a
}
/// transcode.cjs args: the picture as H.264 (or VP9) + AAC (Opus) from `ss`, sound track `a`, fragmented MP4 (WebM)
/// on stdout.
pub fn transcode_args(src: &str, ss: f64, a: i64, enc: &str) -> Vec<String> {
    let vp9 = enc == "libvpx-vp9";
    let mut out = v(&["-nostdin", "-hide_banner", "-loglevel", "error"]);
    if ss > 0.0 {
        out.push("-ss".into());
        out.push(js_num(ss));
    }
    out.push("-i".into());
    out.push(src.to_string());
    out.extend(v(&["-map", "0:v:0", "-map"]));
    out.push(format!("0:a:{}?", a));
    out.extend(v(&["-sn", "-dn"]));
    out.extend(enc_args(enc));
    if vp9 {
        out.extend(v(&["-c:a", "libopus", "-b:a", "160k", "-ac", "2", "-f", "webm", "-cluster_time_limit", "1000"]));
    } else {
        out.extend(v(&["-c:a", "aac", "-b:a", "192k", "-ac", "2", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "1000000"]));
    }
    out.push("pipe:1".into());
    out
}
/// streamproxy.cjs audio: one sound track from `ss` as AAC (ADTS) on stdout.
pub fn audio_args(src: &str, ss: &str, a: &str) -> Vec<String> {
    let mut out = v(&["-nostdin", "-hide_banner", "-loglevel", "error", "-ss"]);
    out.push(ss.to_string());
    out.push("-i".into());
    out.push(src.to_string());
    out.push("-map".into());
    out.push(format!("0:a:{}", a));
    out.extend(v(&["-vn", "-sn", "-dn", "-ac", "2", "-c:a", "aac", "-b:a", "192k", "-f", "adts", "pipe:1"]));
    out
}

/// A number as JavaScript prints it.
pub fn js_num(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if n == n.trunc() && n.abs() < 1e21 {
        return format!("{}", n as i128);
    }
    format!("{}", n)
}
/// Number(x) for a query value (null → 0, '' → 0, not a number → NaN).
pub fn js_number(s: Option<&str>) -> f64 {
    let t = match s {
        None => return 0.0,
        Some(t) => t.trim(),
    };
    if t.is_empty() {
        return 0.0;
    }
    let plain = t.trim_start_matches(|c| c == '+' || c == '-');
    if plain.is_empty() || !plain.chars().next().map(|c| c.is_ascii_digit() || c == '.').unwrap_or(false) || plain.chars().any(|c| c.is_ascii_alphabetic() && c != 'e' && c != 'E') {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}
/// URLSearchParams' reading of one value: «+» a blank, %XX decoded (bad sequences kept), UTF-8 (lossy).
pub fn query_get(query: &str, key: &str) -> Option<String> {
    for part in query.split('&') {
        let (k, v) = match part.find('=') {
            Some(i) => (&part[..i], &part[i + 1..]),
            None => (part, ""),
        };
        if form_decode(k) == key {
            return Some(form_decode(v));
        }
    }
    None
}
pub fn form_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < b.len() => {
                let h = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|x| u8::from_str_radix(x, 16).ok());
                match h {
                    Some(x) => {
                        out.push(x);
                        i += 3;
                    }
                    None => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The transcode stream's request (/video?src=&ss=&a=&c=) as transcode.cjs reads it: → (src, ss, track, vp9).
pub fn video_query(query: &str) -> (String, f64, i64, bool) {
    let src = query_get(query, "src").unwrap_or_default();
    let ss = js_number(query_get(query, "ss").as_deref());
    let ss = if ss.is_nan() || ss < 0.0 { 0.0 } else { ss };
    let a = js_number(query_get(query, "a").as_deref());
    let a = if a.is_nan() { 0.0 } else { a.floor().max(0.0) };
    let vp9 = query_get(query, "c").as_deref() == Some("vp9");
    (src, if ss.is_finite() { ss } else { 0.0 }, a as i64, vp9)
}
/// The sound track's request (/audio?src=&ss=&a=) as streamproxy.cjs reads it: → (src, ss, a) as the texts given to
/// ffmpeg (String(Number(x) || 0)).
pub fn audio_query(query: &str) -> (String, String, String) {
    let src = query_get(query, "src").unwrap_or_default();
    let n = |k: &str| {
        let x = js_number(query_get(query, k).as_deref());
        js_num(if x.is_nan() || x == 0.0 { 0.0 } else { x })
    };
    (src, n("ss"), n("a"))
}

/* ---------- sites ---------- */

const VIDEO_HOSTS: &[&str] = &[
    "youtube.com", "youtu.be", "vimeo.com", "dailymotion.com", "twitch.tv", "tiktok.com", "instagram.com", "facebook.com", "fb.watch", "x.com", "twitter.com", "reddit.com",
    "bilibili.com", "nicovideo.jp", "soundcloud.com", "bandcamp.com", "ok.ru", "vk.com", "rumble.com", "odysee.com", "streamable.com", "imgur.com", "pinterest.com",
    "threads.net", "9gag.com", "crunchyroll.com", "iwara.tv", "nhk.or.jp", "abema.tv",
];
/// The host of an absolute address (new URL(u).hostname), lowercased; None when it is not one.
pub fn host_of(u: &str) -> Option<String> {
    let t = u.trim();
    let i = t.find("://")?;
    let scheme = &t[..i];
    if scheme.is_empty() || !scheme.chars().next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false) || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) {
        return None;
    }
    let rest = &t[i + 3..];
    let end = rest.find(|c| c == '/' || c == '?' || c == '#' || c == '\\').unwrap_or(rest.len());
    let mut auth = &rest[..end];
    if let Some(at) = auth.rfind('@') {
        auth = &auth[at + 1..];
    }
    let host = if auth.starts_with('[') {
        auth.find(']').map(|j| &auth[..=j]).unwrap_or(auth)
    } else {
        auth.split(':').next().unwrap_or("")
    };
    if host.is_empty() {
        return None;
    }
    Some(host.trim_end_matches('.').to_ascii_lowercase())
}
/// kt:isVideoHost: a page of a site yt-dlp is always asked about.
pub fn is_video_host(u: &str) -> bool {
    match host_of(u) {
        Some(h) => VIDEO_HOSTS.iter().any(|d| h == *d || h.ends_with(&format!(".{}", d))),
        None => false,
    }
}

/* ---------- a bilingual subtitle ---------- */

/// One timestamp at `s` (\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}) → its length in bytes.
fn stamp_at(s: &[u8], first_digits: usize) -> Option<usize> {
    let mut i = 0;
    let d = |i: usize| i < s.len() && s[i].is_ascii_digit();
    for _ in 0..first_digits {
        if !d(i) {
            return None;
        }
        i += 1;
    }
    if i >= s.len() || s[i] != b':' {
        return None;
    }
    i += 1;
    if !(d(i) && d(i + 1)) {
        return None;
    }
    i += 2;
    if i >= s.len() || s[i] != b':' {
        return None;
    }
    i += 1;
    if !(d(i) && d(i + 1)) {
        return None;
    }
    i += 2;
    if i >= s.len() || (s[i] != b',' && s[i] != b'.') {
        return None;
    }
    i += 1;
    let st = i;
    while i < s.len() && i - st < 3 && s[i].is_ascii_digit() {
        i += 1;
    }
    if i == st {
        return None;
    }
    Some(i)
}
/// TIMES.exec(line): the first «a --> b» → (a, b).
pub fn times_of(line: &str) -> Option<(String, String)> {
    let b = line.as_bytes();
    for p in 0..b.len() {
        for fd in [2usize, 1] {
            let s = &b[p..];
            // (The fraction's digits are taken greedily: a shorter one would leave a digit before «-->».)
            let lens: Vec<usize> = stamp_at(s, fd).into_iter().collect();
            for e in lens {
                let mut j = e;
                while j < s.len() && (s[j] as char).is_whitespace() {
                    j += 1;
                }
                if !s[j..].starts_with(b"-->") {
                    continue;
                }
                j += 3;
                while j < s.len() && (s[j] as char).is_whitespace() {
                    j += 1;
                }
                let t = &s[j..];
                let second = stamp_at(t, 2).or_else(|| stamp_at(t, 1));
                if let Some(k) = second {
                    let a = String::from_utf8_lossy(&s[..e]).into_owned();
                    let bb = String::from_utf8_lossy(&t[..k]).into_owned();
                    return Some((a, bb));
                }
            }
        }
    }
    None
}
/// ms(t): «h:mm:ss,fff» → milliseconds.
pub fn srt_ms(t: &str) -> i64 {
    let t2 = t.replacen('.', ",", 1);
    let p: Vec<&str> = t2.split(|c| c == ':' || c == ',').collect();
    let n = |i: usize| p.get(i).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
    let frac = {
        let f = p.get(3).copied().unwrap_or("0");
        let mut s = f.to_string();
        while s.len() < 3 {
            s.push('0');
        }
        s[..3].parse::<i64>().unwrap_or(0)
    };
    ((n(0) * 60 + n(1)) * 60 + n(2)) * 1000 + frac
}
fn strip_tags(l: &str) -> String {
    let mut out = String::new();
    let mut rest = l;
    while let Some(i) = rest.find('<') {
        match rest[i + 1..].find('>') {
            Some(j) if j > 0 => {
                out.push_str(&rest[..i]);
                rest = &rest[i + 1 + j + 1..];
            }
            _ => {
                out.push_str(&rest[..=i]);
                rest = &rest[i + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}
/// The cues of an .srt: (start, end, text).
pub fn srt_cues(text: &str) -> Vec<(String, String, String)> {
    let t = text.replace('\r', "");
    let mut out = Vec::new();
    for block in split_blocks(&t) {
        let lines: Vec<&str> = block.trim().split('\n').collect();
        for i in 0..lines.len() {
            if let Some((a, b)) = times_of(lines[i]) {
                let body = lines[i + 1..].iter().map(|l| strip_tags(l)).collect::<Vec<_>>().join("\n");
                if !body.is_empty() {
                    out.push((a, b, body));
                }
                break;
            }
        }
    }
    out
}
fn split_blocks(t: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut nl = 0;
    for c in t.chars() {
        if c == '\n' {
            nl += 1;
            continue;
        }
        if nl >= 2 {
            out.push(std::mem::take(&mut cur));
        } else if nl == 1 {
            cur.push('\n');
        }
        nl = 0;
        cur.push(c);
    }
    if nl == 1 {
        cur.push('\n');
    }
    out.push(cur);
    out
}
/// Two languages' cues made one file: each cue of the first with the overlapping text of the second (overlapping at
/// least half the shorter of the two) under it.
pub fn merge_srt(a: &str, b: &str) -> Option<String> {
    let ca = srt_cues(a);
    let cb = srt_cues(b);
    if ca.is_empty() || cb.is_empty() {
        return None;
    }
    let mut n = 1;
    let mut text = String::new();
    for (s, e, t) in ca.iter() {
        let (s1, e1) = (srt_ms(s), srt_ms(e));
        let other: Vec<String> = cb
            .iter()
            .filter(|(s2, e2, _)| {
                let (s2, e2) = (srt_ms(s2), srt_ms(e2));
                let ov = e1.min(e2) - s1.max(s2);
                ov > 0 && ov * 2 >= (e1 - s1).min(e2 - s2)
            })
            .map(|(_, _, t2)| t2.replace('\n', " "))
            .collect();
        let other = other.join(" ");
        text.push_str(&format!("{}\n{} --> {}\n{}{}\n\n", n, s, e, t, if other.is_empty() { String::new() } else { format!("\n{}", other) }));
        n += 1;
    }
    Some(text)
}
/// Whether `name` is the .srt of `lang` beside a video named `stem` («stem.en.srt», «stem.en-US.srt»).
pub fn srt_of_lang(name: &str, stem: &str, lang: &str) -> bool {
    if !name.starts_with(&format!("{}.", stem)) || !name.ends_with(".srt") {
        return false;
    }
    if name == format!("{}.{}.srt", stem, lang) {
        return true;
    }
    let mid = &name[stem.len() + 1..name.len() - 4];
    match mid.strip_prefix(&format!("{}-", lang)) {
        Some(r) => !r.is_empty() && r.chars().all(|c| c.is_ascii_alphabetic()),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn s(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn names_and_versions() {
        assert_eq!(ytdlp_asset("win32", "x64"), "yt-dlp.exe");
        assert_eq!(ytdlp_asset("darwin", "arm64"), "yt-dlp_macos");
        assert_eq!(ytdlp_asset("linux", "x64"), "yt-dlp_linux");
        assert_eq!(ytdlp_asset("linux", "arm64"), "yt-dlp_linux_aarch64");
        assert_eq!(gallery_asset("linux"), Some("gallery-dl.bin"));
        assert_eq!(gallery_asset("darwin"), None);
        assert!(older_than("2024.12.31", MIN_VERSION) && !older_than("2025.01.01", MIN_VERSION) && !older_than("2026.03.01", MIN_VERSION));
        // (Compared as text, as ytdlp.cjs does: «2025.9.1» is after «2025.10.22».)
        assert!(!older_than("2025.9.1", "2025.10.22"));
        assert!(js_ok(None) && js_ok(Some("2026.01.01")) && !js_ok(Some("2025.06.30")));
        assert!(update_due(Some("2025.10.22"), "2026.01.01", None, false));
        assert!(!update_due(Some("2026.01.01"), "2026.01.01", None, true));
        assert!(!update_due(Some("2025.10.22"), "2026.01.01", Some("2025.10.22"), false));
        assert!(update_due(Some("2025.10.22"), "2026.01.01", Some("2025.10.22"), true));
        assert!(update_due(Some("2024.01.01"), "2026.01.01", Some("2024.01.01"), false));
        assert!(!update_due(Some("x"), "", None, true));
        assert_eq!(old_version("yt-dlp.2025.10.22.old"), Some("2025.10.22".into()));
        assert_eq!(old_version("yt-dlp.exe.2025.10.22.old"), Some("2025.10.22".into()));
        assert_eq!(old_version("yt-dlp.stamp.json"), None);
        assert_eq!(old_name("yt-dlp.exe", "2026.01.01"), "yt-dlp.exe.2026.01.01.old");
        let mut o = vec![("a".into(), "2026.01.01".into(), 5u128), ("b".into(), "2026.02.02".into(), 5), ("c".into(), "2025.01.01".into(), 9)];
        sort_olds(&mut o);
        assert_eq!(o.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), vec!["c", "b", "a"]);
        let sums = "aa11  yt-dlp\r\nBB22  yt-dlp_linux\nCC33  yt-dlp.exe\n";
        assert_eq!(sum_for(sums, "yt-dlp_linux"), Some("bb22".into()));
        assert_eq!(sum_for(sums, "yt-dlp_macos"), None);
        assert_eq!(digest_hex("sha256:ABCD"), Some("abcd".into()));
        assert_eq!(digest_hex("md5:x"), None);
    }

    #[test]
    fn vetting() {
        // (tests/videojob.cjs and tests/videoargs.cjs: the page's lists pass, a smuggled option or path does not.)
        let ok = s(&["-f", "bv*+ba/b", "-x", "--audio-format", "mp3", "--no-playlist", "-o", "%(title)s [%(id)s].%(ext)s", "-N", "4"]);
        assert_eq!(vet_args(&ok), Some(ok.clone()));
        assert_eq!(vet_args(&s(&["-f", "b", "--exec", "rm -rf /"])), None);
        assert_eq!(vet_args(&s(&["-f", "--exec"])), None);
        assert_eq!(vet_args(&s(&["-f"])), None);
        assert_eq!(vet_args(&s(&["bare"])), None);
        for bad in ["/etc/x", "\\x", "~/x", "C:x", "a/../b", "$HOME", "chapter:/abs/%(title)s"] {
            assert_eq!(vet_args(&s(&["-o", bad])), None, "{}", bad);
        }
        assert!(vet_args(&s(&["-o", "chapter:%(title)s - %(section_number)02d.%(ext)s"])).is_some());
        assert!(vet_args(&s(&["-o", "sub/%(title)s.%(ext)s"])).is_some());
        assert_eq!(vet_args(&vec!["-x".to_string(); 201]), None);
        assert_eq!(vet_args(&s(&["-f", "a\0b"])), None);
        assert_eq!(vet_args(&vec!["-f".to_string(), "x".repeat(4001)]), None);
    }

    #[test]
    fn lists() {
        let common = s(&["--no-warnings", "--no-playlist-reverse"]);
        let m = JobMeta { args: Some(s(&["-f", "bv*+ba/b", "--no-playlist", "-o", "%(title)s.%(ext)s"])), embed_meta: true, cookies_from_browser: Some("firefox".into()), ..Default::default() };
        let a = job_args(&m, "/d/Kurokawa", "https://u", &common, '/').unwrap();
        let p = a.iter().position(|x| x == "-P").unwrap();
        assert_eq!(a[p + 1], "/d/Kurokawa");
        assert!(p < a.iter().position(|x| x == "-f").unwrap());
        assert_eq!(a.iter().filter(|x| *x == "--no-playlist").count(), 1);
        assert!(!a.contains(&"--embed-metadata".to_string()));
        assert_eq!(&a[a.len() - 3..], &s(&["--cookies-from-browser", "firefox", "https://u"])[..]);
        assert_eq!(a[a.iter().position(|x| x == "--progress-template").unwrap() + 1], PROGRESS_TEMPLATE);
        let bad = JobMeta { args: Some(s(&["--exec", "x"])), ..Default::default() };
        assert_eq!(job_args(&bad, "/d", "u", &common, '/'), Err("invalid options".to_string()));
        // (The older way: -o with the folder, -f with /best, mp4, SponsorBlock, sections, headers.)
        let old = JobMeta {
            format: Some("137+140".into()),
            embed_meta: true,
            sponsorblock: true,
            section: Some("1:00-2:00, bad; 3-4".into()),
            headers: vec![("Referer".into(), "https://r/".into()), ("X".into(), "".into())],
            playlist_index: Some("3".into()),
            ..Default::default()
        };
        let a = job_args(&old, "C:\\dl", "https://u", &common, '\\').unwrap();
        assert_eq!(a[a.iter().position(|x| x == "-o").unwrap() + 1], "C:\\dl\\03 - %(title)s [%(id)s].%(ext)s");
        assert!(a.contains(&"--no-playlist".to_string()) && !a.contains(&"-P".to_string()));
        let f = a.iter().position(|x| x == "-f").unwrap();
        assert_eq!(&a[f..f + 4], &s(&["-f", "137+140/best", "--merge-output-format", "mp4"])[..]);
        assert!(a.windows(2).any(|w| w == s(&["--sponsorblock-remove", "sponsor"]).as_slice()));
        assert_eq!(a.iter().filter(|x| *x == "--download-sections").count(), 2);
        assert!(a.contains(&"*1:00-2:00".to_string()) && a.contains(&"*3-4".to_string()));
        assert!(a.windows(2).any(|w| w == s(&["--add-header", "Referer:https://r/"]).as_slice()));
        assert!(!a.iter().any(|x| x.starts_with("X:")));
        let au = JobMeta { audio_only: true, container: Some("mp3".into()), out_name: Some("A: b/c".into()), cover: true, ..Default::default() };
        let a = job_args(&au, "/d", "u", &[], '/').unwrap();
        assert_eq!(a[a.iter().position(|x| x == "-o").unwrap() + 1], "/d/A  b c.%(ext)s");
        assert!(a.windows(4).any(|w| w == s(&["-f", "bestaudio/best", "-x", "--audio-format"]).as_slice()));
        assert!(a.contains(&"thumbnail:/d/A  b c.%(ext)s".to_string()));
        assert_eq!(safe_name("  a:b  "), "a b");
        let i = info_args("https://u", true, Some("chrome"), &js_args(Some("2026.01.01"), Some(("deno", "/bin/deno"))));
        assert_eq!(i, s(&["-J", "--no-warnings", "--skip-download", "--socket-timeout", "20", "--js-runtimes", "deno:/bin/deno", "--flat-playlist", "--cookies-from-browser", "chrome", "https://u"]));
        assert!(js_args(Some("2025.06.30"), Some(("node", "/n"))).is_empty());
    }

    #[test]
    fn reading_lines() {
        // (tests/videojob.cjs's lines, with its expectations.)
        let mut r = LineReader::new(false, "MP3", 300_000_000, None);
        assert!(r.line("[download] Destination: /x/T.f137.mp4"));
        assert_eq!(r.p.phase.as_deref(), Some("video"));
        r.line("KT|50000000|100000000|NA|2000000|25|7|40|/x/T.f137.mp4");
        assert_eq!(r.p.frag, Some((7, 40)));
        assert_eq!((r.p.speed, r.p.eta, r.p.done), (2e6, Some(25.0), 50_000_000));
        assert_eq!(r.p.file.as_deref(), Some("T.mp4"));
        assert_eq!(r.p.name.as_deref(), Some("T"));
        r.line("KT|100000000|100000000|NA|2000000|0|40|40|/x/T.f137.mp4");
        assert_eq!(r.p.eta, None);
        assert!(r.line("[download] Destination: /x/T.f140.m4a"));
        assert_eq!(r.p.phase.as_deref(), Some("audio"));
        r.line("KT|10000000|20000000|NA|1000000|10|NA|NA|/x/T.f140.m4a");
        assert_eq!((r.p.done, r.p.total), (110_000_000, 300_000_000));
        assert_eq!(r.p.frag, None);
        assert!(r.line("[Merger] Merging formats into \"/x/T.mkv\""));
        assert_eq!((r.p.phase.as_deref(), r.p.speed), (Some("merge"), 0.0));
        assert_eq!((r.p.file.as_deref(), r.p.file_whole), (Some("T.mkv"), true));
        assert_eq!(r.p.detail.as_deref(), Some("Merging formats into \"/x/T.mkv\""));
        assert!(r.line("[ExtractAudio] Destination: /x/T.mp3"));
        assert_eq!(r.p.phase.as_deref(), Some("convert MP3"));
        assert!(r.line("[EmbedThumbnail] ffmpeg: Adding thumbnail"));
        assert_eq!(r.p.phase.as_deref(), Some("embed"));
        assert!(!r.line("[EmbedThumbnail] again"));
        assert!(r.line("[FixupM3u8] Fixing"));
        assert_eq!(r.p.phase.as_deref(), Some("finish"));
        // (info first; a total only estimated; a name with «|» in it; .part taken off.)
        let mut q = LineReader::new(true, "", 0, None);
        assert!(q.line("[youtube] abc: Downloading webpage"));
        assert_eq!(q.p.phase.as_deref(), Some("info"));
        assert!(q.line("KT|5|NA|1000|NA|NA|NA|NA|/x/a|b.webm.part"));
        assert_eq!((q.p.phase.as_deref(), q.p.total, q.p.file.as_deref()), (Some("audio"), 1000, Some("a|b.webm")));
        assert!(!q.line("[generic] later"));
        let mut c = LineReader::new(true, "", 0, None);
        c.line("[ExtractAudio] Destination: x.opus");
        assert_eq!(c.p.phase.as_deref(), Some("convert"));
        assert_eq!(job_error("[x] a\nERROR: [youtube] abc: Video unavailable\nWARNING: z\n", Some(1)), "[youtube] abc: Video unavailable");
        assert_eq!(job_error("only\nlast\n", Some(1)), "last");
        assert_eq!(job_error("  ", Some(2)), "yt-dlp 2");
        assert_eq!(job_error("", None), "yt-dlp null");
        assert_eq!(last_line("a\nERROR: b\n", "x"), "ERROR: b");
        assert_eq!(last_line("", "spawn failed"), "spawn failed");
        assert_eq!(gallery_error("a\nb\n\n", "x"), "b");
        assert_eq!(gallery_error("", ""), "gallery-dl failed");
    }

    #[test]
    fn ffmpeg_progress() {
        let mut r = FfReader::default();
        assert_eq!(r.line("frame=10"), None);
        r.line("out_time_us=1500000");
        r.line("total_size=2048");
        r.line("speed=1.25x");
        assert_eq!(r.line("progress=continue"), Some((FfProgress { time: Some(1.5), size: Some(2048.0), speed: Some(1.25) }, false)));
        r.line("speed=N/A");
        r.line("out_time_ms=3000000");
        assert_eq!(r.line("progress=end"), Some((FfProgress { time: Some(3.0), size: Some(2048.0), speed: Some(0.0) }, true)));
        assert_eq!(r.line("no equals"), None);
    }

    #[test]
    fn transcode() {
        let a = transcode_args("/m/a b.mkv", 3.0, 1, "libx264");
        assert_eq!(&a[..6], &s(&["-nostdin", "-hide_banner", "-loglevel", "error", "-ss", "3"])[..]);
        assert!(a.windows(2).any(|w| w == s(&["-map", "0:a:1?"]).as_slice()));
        assert!(a.windows(2).any(|w| w == s(&["-c:v", "libx264"]).as_slice()));
        assert_eq!(a.last().unwrap(), "pipe:1");
        assert!(a.contains(&"frag_keyframe+empty_moov+default_base_moof".to_string()));
        let b = transcode_args("x", 0.0, 0, "libvpx-vp9");
        assert!(!b.contains(&"-ss".to_string()) && b.contains(&"webm".to_string()) && b.contains(&"libopus".to_string()));
        assert!(enc_args("h264_qsv").contains(&"scale='min(1920,iw)':-2,format=nv12".to_string()));
        assert_eq!(encoder_test_args("h264_nvenc").last().unwrap(), "-");
        assert_eq!(encoder_candidates("win32").len(), 3);
        assert_eq!(video_query("src=%2Fm%2Fa+b.mkv&ss=30.500&a=1.7&c=vp9"), ("/m/a b.mkv".to_string(), 30.5, 1, true));
        assert_eq!(video_query("src=x&ss=-4&a=NaN"), ("x".to_string(), 0.0, 0, false));
        assert_eq!(video_query(""), (String::new(), 0.0, 0, false));
        assert_eq!(audio_query("src=%E2%9C%93&ss=12.50&a=2"), ("✓".to_string(), "12.5".to_string(), "2".to_string()));
        assert_eq!(audio_query("src=y&ss=abc"), ("y".to_string(), "0".to_string(), "0".to_string()));
        assert_eq!(audio_args("y", "0", "1")[4..6], s(&["-ss", "0"])[..]);
        assert_eq!(form_decode("a%zz%2"), "a%zz%2");
        assert_eq!(js_number(Some("0x10")).is_nan(), true);
    }

    #[test]
    fn hosts() {
        assert!(is_video_host("https://www.youtube.com/watch?v=x"));
        assert!(is_video_host("https://m.YouTube.com./x"));
        assert!(is_video_host("http://user@vimeo.com:8080/1"));
        assert!(!is_video_host("https://notyoutube.com/x"));
        assert!(!is_video_host("https://example.org/a.mp4"));
        assert!(!is_video_host("youtube.com/watch"));
        assert!(!is_video_host("not a url"));
    }

    #[test]
    fn bilingual() {
        assert_eq!(times_of("00:00:01,000 --> 00:00:02,500"), Some(("00:00:01,000".into(), "00:00:02,500".into())));
        assert_eq!(times_of("x 1:02:03.5-->1:02:04.25 y"), Some(("1:02:03.5".into(), "1:02:04.25".into())));
        assert_eq!(times_of("123:45:67,890 --> 00:00:01,000"), Some(("23:45:67,890".into(), "00:00:01,000".into())));
        assert_eq!(times_of("no times"), None);
        assert_eq!(srt_ms("01:02:03,4"), 3_723_400);
        assert_eq!(srt_ms("0:00:01.25"), 1250);
        let en = "1\r\n00:00:01,000 --> 00:00:03,000\r\n<i>Hello</i>\r\nthere\r\n\r\n2\r\n00:00:05,000 --> 00:00:06,000\r\nBye\r\n\r\n\r\n3\r\n00:00:09,000 --> 00:00:10,000\r\n\r\n";
        let ar = "1\n00:00:01,500 --> 00:00:03,500\nمرحبا\nهناك\n\n2\n00:00:05,900 --> 00:00:07,000\nوداعا\n";
        let m = merge_srt(en, ar).unwrap();
        assert_eq!(m, "1\n00:00:01,000 --> 00:00:03,000\nHello\nthere\nمرحبا هناك\n\n2\n00:00:05,000 --> 00:00:06,000\nBye\n\n");
        assert_eq!(merge_srt(en, ""), None);
        assert!(srt_of_lang("V [x].en.srt", "V [x]", "en"));
        assert!(srt_of_lang("V [x].en-US.srt", "V [x]", "en"));
        assert!(!srt_of_lang("V [x].en-1.srt", "V [x]", "en"));
        assert!(!srt_of_lang("V [x].eng.srt", "V [x]", "en"));
        assert!(!srt_of_lang("W.en.srt", "V [x]", "en"));
    }
}
