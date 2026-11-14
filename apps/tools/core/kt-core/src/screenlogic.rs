//! The screen translator's rules on a computer (desktop/screentr.cjs, ported for the Tauri shell's screentr.rs and
//! screencap.rs): its shortcuts, which monitor is under the mouse, the region drawn on the frozen screen turned into
//! the picture's pixels and the lines read turned back, where the caption window of «auto» goes and how tall it may
//! be, where the clipboard's window goes, «auto»'s loose comparison and its timers, what a shortcut does (the job's
//! mode), the OCR answers read (Windows OCR's and Vision's JSON, Tesseract's TSV) and the language names each wants,
//! which OCR there is, starting with the computer (Windows' Run key, a Mac's launch agent), pixels (GDI's BGRA, an X
//! server's image, a crop) and a PNG written, and the screenshot portal's answers (Wayland). Std only, checked alone
//! with `rustc --edition 2021 --test screenlogic.rs`; the tests mirror tests/screenpc.cjs's.

/* ---------- the shortcuts (screentr.cjs DEFAULT_KEYS) ---------- */

/// The actions in Electron's order, each with its default shortcut.
pub const DEFAULT_KEYS: [(&str, &str); 5] = [("region", "Alt+Shift+T"), ("full", "Alt+Shift+F"), ("repeat", "Alt+Shift+R"), ("auto", "Alt+Shift+A"), ("clipboard", "Alt+Shift+C")];

/// `{ ...DEFAULT_KEYS, ...pc.keys }` for the five actions: a key the page gave (even "", which means none) replaces the
/// default; `None` (not given, or not a string) keeps it. In Electron's order.
pub fn merged_keys(given: &dyn Fn(&str) -> Option<Option<String>>) -> Vec<(String, String)> {
    DEFAULT_KEYS
        .iter()
        .map(|(k, d)| {
            let acc = match given(k) {
                Some(Some(s)) => s,
                Some(None) => String::new(),
                None => d.to_string(),
            };
            (k.to_string(), acc)
        })
        .collect()
}

/* ---------- monitors and rectangles ---------- */

/// A monitor as the shell sees it: its place and size in physical pixels (the system's desktop coordinates), its scale.
#[derive(Clone, Debug, PartialEq)]
pub struct Mon {
    pub id: String,
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub scale: f64,
}

impl Mon {
    pub fn scale(&self) -> f64 {
        if self.scale.is_finite() && self.scale > 0.1 {
            self.scale
        } else {
            1.0
        }
    }
    /// Its size in the page's pixels (Electron's DIP).
    pub fn dip_w(&self) -> f64 {
        self.w as f64 / self.scale()
    }
    pub fn dip_h(&self) -> f64 {
        self.h as f64 / self.scale()
    }
}

/// A rectangle in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// A rectangle in the page's pixels (the region the page drew, the lines it is handed).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DipRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// A monitor's id, kept with the region (Electron kept display.id): its name and its place.
pub fn monitor_id(name: Option<&str>, x: i32, y: i32) -> String {
    format!("{}@{},{}", name.filter(|n| !n.is_empty()).unwrap_or("screen"), x, y)
}

/// Electron's getDisplayNearestPoint: the monitor holding the point, else the nearest one.
pub fn nearest(mons: &[Mon], px: f64, py: f64) -> Option<usize> {
    let mut best: Option<(usize, f64)> = None;
    for (i, m) in mons.iter().enumerate() {
        let (l, t, r, b) = (m.x as f64, m.y as f64, m.x as f64 + m.w as f64, m.y as f64 + m.h as f64);
        let dx = if px < l { l - px } else if px >= r { px - r + 1.0 } else { 0.0 };
        let dy = if py < t { t - py } else if py >= b { py - b + 1.0 } else { 0.0 };
        let d = dx * dx + dy * dy;
        if best.map(|(_, bd)| d < bd).unwrap_or(true) {
            best = Some((i, d));
        }
    }
    best.map(|(i, _)| i)
}

fn round(v: f64) -> i64 {
    // (JavaScript's Math.round: halves up.)
    (v + 0.5).floor() as i64
}

/// regionChosen's rectangle: the region drawn (page pixels, wider than 3) times the picture's scale, else all of the
/// picture — kept within the picture (nativeImage.crop's own clamp).
pub fn crop_rect(r: Option<DipRect>, s: f64, img_w: u32, img_h: u32) -> Rect {
    match r {
        Some(r) if r.w > 3.0 => {
            let x = round(r.x * s).clamp(0, img_w as i64);
            let y = round(r.y * s).clamp(0, img_h as i64);
            let w = round(r.w * s).clamp(0, img_w as i64 - x);
            let h = round(r.h * s).clamp(0, img_h as i64 - y);
            Rect { x: x as i32, y: y as i32, w: w as u32, h: h as u32 }
        }
        _ => Rect { x: 0, y: 0, w: img_w, h: img_h },
    }
}

/// A line read in the crop (its pixels) → the page's pixels on the whole frozen screen (regionChosen's map).
pub fn block_to_page(b: &Block, crop: &Rect, s: f64) -> Block {
    let s = if s > 0.0 { s } else { 1.0 };
    Block { text: b.text.clone(), x: (crop.x as f64 + b.x) / s, y: (crop.y as f64 + b.y) / s, w: b.w / s, h: b.h / s }
}

/// startAuto's caption window: under the region when 160 page pixels fit below it, else above it; as wide as the
/// region (at least 260), 120 tall — the page's pixels of the monitor, made physical on it.
pub fn caption_rect(m: &Mon, r: &DipRect) -> Rect {
    let s = m.scale();
    let below = r.y + r.h + 160.0 < m.dip_h();
    let x = r.x;
    let y = if below { r.y + r.h + 6.0 } else { (r.y - 126.0).max(0.0) };
    let w = r.w.max(260.0);
    Rect { x: m.x + round(x * s) as i32, y: m.y + round(y * s) as i32, w: round(w * s).max(1) as u32, h: round(120.0 * s) as u32 }
}

/// kt:screenCaption({ height }): the caption's height, 40 to 400 page pixels.
pub fn caption_height(h: f64) -> Option<f64> {
    if !h.is_finite() || h <= 0.0 {
        return None;
    }
    Some((round(h) as f64).clamp(40.0, 400.0))
}

/// showPopup's window: 420×220 page pixels by the mouse (12 past it), kept on the monitor.
pub fn popup_rect(m: &Mon, cursor: (f64, f64)) -> Rect {
    let s = m.scale();
    let (w, h) = (round(420.0 * s), round(220.0 * s));
    let (l, t) = (m.x as i64, m.y as i64);
    let (r, b) = (l + m.w as i64, t + m.h as i64);
    let x = (r - w).min(l.max(round(cursor.0) + round(12.0 * s)));
    let y = (b - h).min(t.max(round(cursor.1) + round(12.0 * s)));
    Rect { x: x as i32, y: y as i32, w: w.max(1) as u32, h: h.max(1) as u32 }
}

/// A rectangle on a monitor (relative, physical) in the desktop's points (a Mac's screencapture -R, grim -g): the
/// monitor's place as its shell gives it (points × its scale) back in points.
pub fn points_rect(m: &Mon, r: &Rect) -> (i64, i64, i64, i64) {
    let s = m.scale();
    (round((m.x + r.x) as f64 / s), round((m.y + r.y) as f64 / s), round(r.w as f64 / s).max(1), round(r.h as f64 / s).max(1))
}

/// A region within a picture of `w`×`h`, kept inside it; None when nothing is left.
pub fn clamp_rect(r: &Rect, w: u32, h: u32) -> Option<Rect> {
    let x0 = (r.x as i64).clamp(0, w as i64);
    let y0 = (r.y as i64).clamp(0, h as i64);
    let x1 = (r.x as i64 + r.w as i64).clamp(0, w as i64);
    let y1 = (r.y as i64 + r.h as i64).clamp(0, h as i64);
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    Some(Rect { x: x0 as i32, y: y0 as i32, w: (x1 - x0) as u32, h: (y1 - y0) as u32 })
}

/* ---------- what a shortcut does ---------- */

/// act(what) after the capture: the job's mode and whether the overlay reads the kept region at once («?go=1»).
/// «repeat» on the monitor the region was drawn on → 'result' at once; any other (repeat elsewhere too) → 'region',
/// but 'full' for «full».
pub fn job_mode(what: &str, region_display: Option<&str>, shot_display: &str) -> (&'static str, bool) {
    if what == "repeat" && region_display == Some(shot_display) {
        return ("result", true);
    }
    (if what == "full" { "full" } else { "region" }, false)
}

/// startAuto's beat: `Math.max(1, Number(cfg.interval) || 2)` seconds.
pub fn interval_ms(v: Option<f64>) -> u64 {
    let n = match v {
        Some(x) if x.is_finite() && x != 0.0 => x,
        _ => 2.0,
    };
    (n.max(1.0) * 1000.0) as u64
}

/// startAuto's end: `cfg.autoStop` minutes when above 0.
pub fn auto_stop_ms(v: Option<f64>) -> Option<u64> {
    match v {
        Some(x) if x.is_finite() && x > 0.0 => Some((x * 60000.0) as u64),
        _ => None,
    }
}

/// autoTick's loose comparison: case, spaces and punctuation aside (letters and digits only).
pub fn loose(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(|c| c.to_lowercase()).collect()
}

/// «auto»'s last text: what is new enough to send to the caption.
#[derive(Default, Debug)]
pub struct AutoText {
    pub last: String,
}

impl AutoText {
    /// The lines read, joined and trimmed; Some(text) when it is not empty and not the last one loosely.
    pub fn next(&mut self, lines: &[String]) -> Option<String> {
        let text = lines.join("\n").trim().to_string();
        if text.is_empty() || loose(&text) == loose(&self.last) {
            return None;
        }
        self.last = text.clone();
        Some(text)
    }
}

/* ---------- OCR ---------- */

/// A line of text with its box (pixels of the picture it was read in, or of the page after block_to_page).
#[derive(Clone, Debug, PartialEq)]
pub struct Block {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// ocrKind: the AI model when chosen; else Windows OCR, macOS Vision, Tesseract where it is found, or none.
pub fn ocr_kind(os: &str, ai: bool, has_tesseract: bool) -> &'static str {
    if ai {
        "ai"
    } else if os == "windows" {
        "windows"
    } else if os == "macos" {
        "vision"
    } else if has_tesseract {
        "tesseract"
    } else {
        "none"
    }
}

/// tessLang.
pub fn tess_lang(l: &str) -> &'static str {
    match l {
        "ja" => "jpn",
        "zh-CN" | "zh" => "chi_sim",
        "zh-TW" => "chi_tra",
        "ko" => "kor",
        "ar" => "ara",
        "fr" => "fra",
        "de" => "deu",
        "es" => "spa",
        "ru" => "rus",
        "pt" => "por",
        "it" => "ita",
        "tr" => "tur",
        _ => "eng",
    }
}

/// winLang.
pub fn win_lang(l: &str) -> String {
    match l {
        "" | "auto" => String::new(),
        "zh-CN" | "zh" => "zh-Hans".into(),
        "zh-TW" => "zh-Hant".into(),
        x => x.into(),
    }
}

/// macLang.
pub fn mac_lang(l: &str) -> String {
    match l {
        "" | "auto" => String::new(),
        "zh-CN" | "zh" => "zh-Hans".into(),
        "zh-TW" => "zh-Hant".into(),
        "ja" => "ja-JP".into(),
        "ko" => "ko-KR".into(),
        x => x.into(),
    }
}

/// JavaScript's Number(s) for a TSV cell: blank → 0, not a number → NaN.
fn js_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// tsvLines: Tesseract's words (level 5) joined into their lines, each with the box around its words; words read
/// with a confidence under 30 left out.
pub fn tsv_lines(out: &str) -> Vec<Block> {
    let mut keys: Vec<String> = Vec::new();
    let mut lines: Vec<Block> = Vec::new();
    for row in out.split('\n').skip(1) {
        let c: Vec<&str> = row.split('\t').collect();
        if c.len() < 12 || c[0] != "5" || c[11].trim().is_empty() || js_number(c[10]) < 30.0 {
            continue;
        }
        let k = format!("{}-{}-{}", c[2], c[3], c[4]);
        let (x, y, w, h) = (js_number(c[6]), js_number(c[7]), js_number(c[8]), js_number(c[9]));
        match keys.iter().position(|q| *q == k) {
            None => {
                keys.push(k);
                lines.push(Block { text: c[11].to_string(), x, y, w, h });
            }
            Some(i) => {
                let l = &mut lines[i];
                let r = (l.x + l.w).max(x + w);
                let b = (l.y + l.h).max(y + h);
                l.x = l.x.min(x);
                l.y = l.y.min(y);
                l.w = r - l.x;
                l.h = b - l.y;
                l.text.push(' ');
                l.text.push_str(c[11]);
            }
        }
    }
    lines
}

/// parseLines: the JSON after any noise (from the first «[» or «{»), one line or many; lines without text dropped.
pub fn parse_lines(out: &str) -> Vec<Block> {
    let i = match out.find(|c| c == '[' || c == '{') {
        Some(i) => i,
        None => return Vec::new(),
    };
    let v = match json_parse(&out[i..]) {
        Some(v) => v,
        None => return Vec::new(),
    };
    let items: Vec<J> = match v {
        J::Arr(a) => a,
        other => vec![other],
    };
    let num = |o: &J, k: &str| match o.get(k) {
        Some(J::Num(n)) => *n,
        Some(J::Str(s)) => js_number(s),
        _ => 0.0,
    };
    let mut res = Vec::new();
    for o in items.iter() {
        let text = match o.get("text") {
            Some(J::Str(s)) => s.clone(),
            Some(J::Num(n)) if *n != 0.0 => fmt_num(*n),
            Some(J::Bool(true)) => "true".into(),
            _ => continue,
        };
        if text.trim().is_empty() {
            continue;
        }
        res.push(Block { text, x: num(o, "x"), y: num(o, "y"), w: num(o, "width"), h: num(o, "height") });
    }
    res
}

fn fmt_num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

/// Vision's boxes are fractions of the picture from its bottom-left corner: made the picture's pixels from its top.
pub fn vision_to_pixels(b: &Block, w: u32, h: u32) -> Block {
    let (w, h) = (w as f64, h as f64);
    Block { text: b.text.clone(), x: b.x * w, y: (1.0 - b.y - b.h) * h, w: b.w * w, h: b.h * h }
}

/// `tesseract --list-langs`: the lines after the first.
pub fn tess_langs(out: &str) -> Vec<String> {
    out.split('\n').skip(1).map(|s| s.trim_end_matches('\r').to_string()).filter(|s| !s.is_empty()).collect()
}

/* ---------- a small JSON reader (the OCR helpers' answers) ---------- */

#[derive(Clone, Debug, PartialEq)]
pub enum J {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

impl J {
    pub fn get(&self, k: &str) -> Option<&J> {
        match self {
            J::Obj(v) => v.iter().rev().find(|(n, _)| n == k).map(|(_, x)| x),
            _ => None,
        }
    }
}

/// JSON.parse: the whole text one value (white space around it allowed), else None.
pub fn json_parse(s: &str) -> Option<J> {
    let b = s.as_bytes();
    let mut i = 0usize;
    let v = jvalue(b, &mut i, 0)?;
    jws(b, &mut i);
    if i != b.len() {
        return None;
    }
    Some(v)
}

fn jws(b: &[u8], i: &mut usize) {
    while *i < b.len() && matches!(b[*i], b' ' | b'\t' | b'\n' | b'\r') {
        *i += 1;
    }
}

fn jvalue(b: &[u8], i: &mut usize, depth: usize) -> Option<J> {
    if depth > 64 {
        return None;
    }
    jws(b, i);
    match *b.get(*i)? {
        b'{' => {
            *i += 1;
            let mut v = Vec::new();
            jws(b, i);
            if b.get(*i) == Some(&b'}') {
                *i += 1;
                return Some(J::Obj(v));
            }
            loop {
                jws(b, i);
                let k = jstring(b, i)?;
                jws(b, i);
                if b.get(*i) != Some(&b':') {
                    return None;
                }
                *i += 1;
                let x = jvalue(b, i, depth + 1)?;
                v.push((k, x));
                jws(b, i);
                match b.get(*i) {
                    Some(b',') => *i += 1,
                    Some(b'}') => {
                        *i += 1;
                        return Some(J::Obj(v));
                    }
                    _ => return None,
                }
            }
        }
        b'[' => {
            *i += 1;
            let mut v = Vec::new();
            jws(b, i);
            if b.get(*i) == Some(&b']') {
                *i += 1;
                return Some(J::Arr(v));
            }
            loop {
                v.push(jvalue(b, i, depth + 1)?);
                jws(b, i);
                match b.get(*i) {
                    Some(b',') => *i += 1,
                    Some(b']') => {
                        *i += 1;
                        return Some(J::Arr(v));
                    }
                    _ => return None,
                }
            }
        }
        b'"' => jstring(b, i).map(J::Str),
        b't' if b[*i..].starts_with(b"true") => {
            *i += 4;
            Some(J::Bool(true))
        }
        b'f' if b[*i..].starts_with(b"false") => {
            *i += 5;
            Some(J::Bool(false))
        }
        b'n' if b[*i..].starts_with(b"null") => {
            *i += 4;
            Some(J::Null)
        }
        _ => {
            let st = *i;
            while *i < b.len() && matches!(b[*i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
                *i += 1;
            }
            if st == *i {
                return None;
            }
            std::str::from_utf8(&b[st..*i]).ok()?.parse::<f64>().ok().map(J::Num)
        }
    }
}

fn hex4(b: &[u8], i: usize) -> Option<u32> {
    let s = std::str::from_utf8(b.get(i..i + 4)?).ok()?;
    u32::from_str_radix(s, 16).ok()
}

fn jstring(b: &[u8], i: &mut usize) -> Option<String> {
    if b.get(*i) != Some(&b'"') {
        return None;
    }
    *i += 1;
    let mut out: Vec<u8> = Vec::new();
    loop {
        let c = *b.get(*i)?;
        *i += 1;
        match c {
            b'"' => return String::from_utf8(out).ok(),
            b'\\' => {
                let e = *b.get(*i)?;
                *i += 1;
                let ch: char = match e {
                    b'"' => '"',
                    b'\\' => '\\',
                    b'/' => '/',
                    b'b' => '\u{8}',
                    b'f' => '\u{c}',
                    b'n' => '\n',
                    b'r' => '\r',
                    b't' => '\t',
                    b'u' => {
                        let hi = hex4(b, *i)?;
                        *i += 4;
                        if (0xD800..0xDC00).contains(&hi) && b.get(*i) == Some(&b'\\') && b.get(*i + 1) == Some(&b'u') {
                            let lo = hex4(b, *i + 2)?;
                            if (0xDC00..0xE000).contains(&lo) {
                                *i += 6;
                                char::from_u32(0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)).unwrap_or('\u{FFFD}')
                            } else {
                                '\u{FFFD}'
                            }
                        } else {
                            char::from_u32(hi).unwrap_or('\u{FFFD}')
                        }
                    }
                    _ => return None,
                };
                let mut buf = [0u8; 4];
                out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
            }
            _ => out.push(c),
        }
    }
}

/* ---------- starting with the computer (Electron's setLoginItemSettings, args --hidden) ---------- */

pub const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

/// reg.exe's arguments: the Run value set to «"<exe>" --hidden», or deleted.
pub fn run_key_args(name: &str, exe: &str, on: bool) -> Vec<String> {
    if on {
        vec!["add".into(), RUN_KEY.into(), "/v".into(), name.into(), "/t".into(), "REG_SZ".into(), "/d".into(), format!("\"{}\" --hidden", exe), "/f".into()]
    } else {
        vec!["delete".into(), RUN_KEY.into(), "/v".into(), name.into(), "/f".into()]
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// A Mac's launch agent (~/Library/LaunchAgents/<label>.plist): this program with --hidden at log-in.
pub fn launch_agent_plist(label: &str, exe: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key><string>{}</string>\n  <key>ProgramArguments</key>\n  <array><string>{}</string><string>--hidden</string></array>\n  <key>RunAtLoad</key><true/>\n</dict>\n</plist>\n",
        xml_escape(label),
        xml_escape(exe)
    )
}

/* ---------- pixels ---------- */

/// GDI's top-down BGRA (alpha unset) → RGBA, opaque.
pub fn bgra_to_rgba(px: &mut [u8]) {
    for p in px.chunks_exact_mut(4) {
        p.swap(0, 2);
        p[3] = 255;
    }
}

fn mask_shift(m: u64) -> (u32, u64) {
    if m == 0 {
        return (0, 0);
    }
    let sh = m.trailing_zeros();
    (sh, m >> sh)
}

fn scale_to_8(v: u64, max: u64) -> u8 {
    if max == 0 {
        0
    } else if max == 255 {
        v as u8
    } else {
        ((v * 255 + max / 2) / max) as u8
    }
}

/// An X server's ZPixmap image (XGetImage on the root window) → RGBA, opaque: 32, 24 or 16 bits a pixel, either byte
/// order, the channels where its masks say.
pub fn ximage_to_rgba(data: &[u8], w: u32, h: u32, bytes_per_line: usize, bits_per_pixel: u32, msb_first: bool, masks: (u64, u64, u64)) -> Result<Vec<u8>, String> {
    let bpp = match bits_per_pixel {
        32 => 4usize,
        24 => 3,
        16 => 2,
        x => return Err(format!("{} bits a pixel is not supported", x)),
    };
    if bytes_per_line < w as usize * bpp || data.len() < bytes_per_line * h as usize {
        return Err("the image is smaller than it says".into());
    }
    let (rs, rm) = mask_shift(masks.0);
    let (gs, gm) = mask_shift(masks.1);
    let (bs, bm) = mask_shift(masks.2);
    let mut out = vec![0u8; w as usize * h as usize * 4];
    for y in 0..h as usize {
        let row = &data[y * bytes_per_line..];
        for x in 0..w as usize {
            let p = &row[x * bpp..x * bpp + bpp];
            let mut v: u64 = 0;
            if msb_first {
                for b in p.iter() {
                    v = (v << 8) | *b as u64;
                }
            } else {
                for b in p.iter().rev() {
                    v = (v << 8) | *b as u64;
                }
            }
            let o = (y * w as usize + x) * 4;
            out[o] = scale_to_8((v >> rs) & rm, rm);
            out[o + 1] = scale_to_8((v >> gs) & gm, gm);
            out[o + 2] = scale_to_8((v >> bs) & bm, bm);
            out[o + 3] = 255;
        }
    }
    Ok(out)
}

/// A part of an RGBA picture (kept within it).
pub fn crop_rgba(px: &[u8], w: u32, h: u32, r: &Rect) -> (Vec<u8>, u32, u32) {
    let r = match clamp_rect(r, w, h) {
        Some(r) => r,
        None => return (Vec::new(), 0, 0),
    };
    let mut out = Vec::with_capacity(r.w as usize * r.h as usize * 4);
    for y in r.y as usize..r.y as usize + r.h as usize {
        let a = (y * w as usize + r.x as usize) * 4;
        out.extend_from_slice(&px[a..a + r.w as usize * 4]);
    }
    (out, r.w, r.h)
}

/// One pixel of an RGBA picture.
pub fn pixel(px: &[u8], w: u32, x: u32, y: u32) -> [u8; 4] {
    let o = (y as usize * w as usize + x as usize) * 4;
    match px.get(o..o + 4) {
        Some(p) => [p[0], p[1], p[2], p[3]],
        None => [0, 0, 0, 0],
    }
}

/// Whether two colours are alike, each channel within `tol`.
pub fn alike(a: [u8; 4], b: [u8; 3], tol: u8) -> bool {
    (0..3).all(|i| (a[i] as i16 - b[i] as i16).unsigned_abs() <= tol as u16)
}

/* ---------- PNG ---------- */

fn crc_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    for (n, e) in t.iter_mut().enumerate() {
        let mut c = n as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *e = c;
    }
    t
}

pub fn crc32(parts: &[&[u8]]) -> u32 {
    let t = crc_table();
    let mut c = 0xFFFF_FFFFu32;
    for p in parts {
        for b in p.iter() {
            c = t[((c ^ *b as u32) & 0xFF) as usize] ^ (c >> 8);
        }
    }
    c ^ 0xFFFF_FFFF
}

pub fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for chunk in data.chunks(5552) {
        for x in chunk {
            a += *x as u32;
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    (b << 16) | a
}

/// A zlib stream of stored (uncompressed) blocks — the fallback and the tests' own.
pub fn zlib_stored(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x01];
    let mut chunks = data.chunks(65535).peekable();
    if data.is_empty() {
        out.extend_from_slice(&[1, 0, 0, 0xFF, 0xFF]);
    }
    while let Some(c) = chunks.next() {
        out.push(if chunks.peek().is_none() { 1 } else { 0 });
        let n = c.len() as u16;
        out.extend_from_slice(&n.to_le_bytes());
        out.extend_from_slice(&(!n).to_le_bytes());
        out.extend_from_slice(c);
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

/// The rows of an RGBA picture as PNG wants them before compression: each row's «Sub» filter (the difference from the
/// pixel to its left — a screen's flat colours become runs of nothing).
pub fn png_rows(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let stride = w as usize * 4;
    let mut raw = Vec::with_capacity((stride + 1) * h as usize);
    for y in 0..h as usize {
        let row = &rgba[y * stride..(y + 1) * stride];
        raw.push(1);
        for i in 0..stride {
            let left = if i >= 4 { row[i - 4] } else { 0 };
            raw.push(row[i].wrapping_sub(left));
        }
    }
    raw
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&crc32(&[kind, data]).to_be_bytes());
}

/// A PNG (8-bit RGBA) of the picture; `zlib` compresses the filtered rows into a zlib stream (the shell's flate2, or
/// zlib_stored).
pub fn png_encode(w: u32, h: u32, rgba: &[u8], zlib: &dyn Fn(&[u8]) -> Vec<u8>) -> Vec<u8> {
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &zlib(&png_rows(w, h, rgba)));
    chunk(&mut out, b"IEND", &[]);
    out
}

/* ---------- Wayland: the screenshot portal through gdbus, grim ---------- */

/// `gdbus call … Screenshot.Screenshot` printed «(objectpath '/org/freedesktop/portal/desktop/request/1_42/kt1',)».
pub fn portal_request_path(out: &str) -> Option<String> {
    let i = out.find("'/org/freedesktop/portal/desktop/request/")?;
    let rest = &out[i + 1..];
    let j = rest.find('\'')?;
    Some(rest[..j].to_string())
}

/// A line of `gdbus monitor`: for the request `path`, its Response → Ok(the picture's uri) when granted (0), Err(code)
/// when refused or cancelled; None for any other line.
pub fn portal_response(line: &str, path: &str) -> Option<Result<String, u32>> {
    if !line.starts_with(path) || !line.contains("org.freedesktop.portal.Request.Response") {
        return None;
    }
    let after = &line[line.find("Response")?..];
    let code: u32 = after.find("uint32 ").and_then(|k| after[k + 7..].split(|c: char| !c.is_ascii_digit()).next()).and_then(|n| n.parse().ok()).unwrap_or(2);
    if code != 0 {
        return Some(Err(code));
    }
    let k = after.find("'uri': <'")?;
    let rest = &after[k + 9..];
    let e = rest.find('\'')?;
    Some(Ok(rest[..e].to_string()))
}

/// A file:// address → its path (percent-decoded); None for anything else.
pub fn file_uri_path(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    let rest = match rest.find('/') {
        Some(0) => rest,
        Some(i) => &rest[i..],
        None => return None,
    };
    let b = rest.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).ok()
}

/// The portal's options: no dialog asked for (the system may still ask once), and our token.
pub fn portal_options(token: &str) -> String {
    format!("{{'handle_token': <'{}'>, 'interactive': <false>}}", token)
}

/// grim's arguments for a rectangle in the desktop's points, written to `file`.
pub fn grim_args(p: (i64, i64, i64, i64), file: &str) -> Vec<String> {
    vec!["-g".into(), format!("{},{} {}x{}", p.0, p.1, p.2, p.3), "-t".into(), "png".into(), file.into()]
}

/// A Mac's screencapture for a rectangle in points, silent, as a PNG at the screen's own resolution.
pub fn screencapture_args(p: (i64, i64, i64, i64), file: &str) -> Vec<String> {
    vec!["-x".into(), "-t".into(), "png".into(), "-R".into(), format!("{},{},{},{}", p.0, p.1, p.2, p.3), file.into()]
}

/// Whether this Linux session is Wayland's (an X server's root window then shows no Wayland window).
pub fn is_wayland(session_type: Option<&str>, wayland_display: Option<&str>) -> bool {
    session_type.map(|s| s.eq_ignore_ascii_case("wayland")).unwrap_or(false) || wayland_display.map(|s| !s.is_empty()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(x: i32, y: i32, w: u32, h: u32, s: f64) -> Mon {
        Mon { id: monitor_id(Some("M"), x, y), x, y, w, h, scale: s }
    }

    #[test]
    fn keys() {
        let k = merged_keys(&|_| None);
        assert_eq!(k[0], ("region".to_string(), "Alt+Shift+T".to_string()));
        assert_eq!(k[4], ("clipboard".to_string(), "Alt+Shift+C".to_string()));
        let k = merged_keys(&|a| match a {
            "region" => Some(Some("Control+Alt+K".into())),
            "full" => Some(Some(String::new())),
            "auto" => Some(None),
            _ => None,
        });
        assert_eq!(k[0].1, "Control+Alt+K");
        assert_eq!(k[1].1, "");
        assert_eq!(k[2].1, "Alt+Shift+R");
        assert_eq!(k[3].1, "");
    }

    #[test]
    fn monitors() {
        let ms = vec![mon(0, 0, 2560, 1440, 2.0), mon(2560, 0, 1920, 1080, 1.0), mon(-1280, 200, 1280, 1024, 1.25)];
        assert_eq!(nearest(&ms, 10.0, 10.0), Some(0));
        assert_eq!(nearest(&ms, 2600.0, 500.0), Some(1));
        assert_eq!(nearest(&ms, -10.0, 500.0), Some(2));
        // (Below the second monitor, past every one: the nearest.)
        assert_eq!(nearest(&ms, 3000.0, 1300.0), Some(1));
        assert_eq!(nearest(&[], 0.0, 0.0), None);
        assert_eq!(ms[0].dip_w(), 1280.0);
        assert_eq!(monitor_id(None, -5, 3), "screen@-5,3");
    }

    #[test]
    fn regions() {
        // (Electron: the region drawn × the picture's scale; under 4 wide → all of the picture.)
        assert_eq!(crop_rect(Some(DipRect { x: 90.0, y: 90.0, w: 330.0, h: 90.0 }), 1.0, 800, 500), Rect { x: 90, y: 90, w: 330, h: 90 });
        assert_eq!(crop_rect(Some(DipRect { x: 10.5, y: 20.25, w: 100.0, h: 50.0 }), 2.0, 2560, 1440), Rect { x: 21, y: 41, w: 200, h: 100 });
        assert_eq!(crop_rect(Some(DipRect { x: 1.0, y: 1.0, w: 3.0, h: 9.0 }), 2.0, 300, 200), Rect { x: 0, y: 0, w: 300, h: 200 });
        assert_eq!(crop_rect(None, 1.5, 300, 200), Rect { x: 0, y: 0, w: 300, h: 200 });
        // (Past the picture's edge: kept within it.)
        assert_eq!(crop_rect(Some(DipRect { x: 700.0, y: 450.0, w: 300.0, h: 300.0 }), 1.0, 800, 500), Rect { x: 700, y: 450, w: 100, h: 50 });
        let b = block_to_page(&Block { text: "a".into(), x: 10.0, y: 4.0, w: 40.0, h: 12.0 }, &Rect { x: 200, y: 100, w: 0, h: 0 }, 2.0);
        assert_eq!((b.x, b.y, b.w, b.h), (105.0, 52.0, 20.0, 6.0));
        assert_eq!(clamp_rect(&Rect { x: -5, y: 3, w: 10, h: 10 }, 4, 4), Some(Rect { x: 0, y: 3, w: 4, h: 1 }));
        assert_eq!(clamp_rect(&Rect { x: 9, y: 0, w: 10, h: 10 }, 4, 4), None);
    }

    #[test]
    fn caption_and_popup() {
        let m = mon(1920, 0, 2560, 1440, 2.0); // 1280×720 page pixels
        // (Room below: 6 under it, as wide as the region, 120 tall.)
        let c = caption_rect(&m, &DipRect { x: 100.0, y: 100.0, w: 400.0, h: 50.0 });
        assert_eq!(c, Rect { x: 1920 + 200, y: 312, w: 800, h: 240 });
        // (No room below: above it; narrow → 260.)
        let c = caption_rect(&m, &DipRect { x: 10.0, y: 600.0, w: 100.0, h: 50.0 });
        assert_eq!(c, Rect { x: 1940, y: 948, w: 520, h: 240 });
        // (Near the top and the bottom both: at 0.)
        let c = caption_rect(&mon(0, 0, 800, 300, 1.0), &DipRect { x: 0.0, y: 50.0, w: 300.0, h: 200.0 });
        assert_eq!(c.y, 0);
        assert_eq!(caption_height(12.0), Some(40.0));
        assert_eq!(caption_height(87.4), Some(87.0));
        assert_eq!(caption_height(9000.0), Some(400.0));
        assert_eq!(caption_height(f64::NAN), None);
        let m = mon(0, 0, 1920, 1080, 1.0);
        assert_eq!(popup_rect(&m, (100.0, 100.0)), Rect { x: 112, y: 112, w: 420, h: 220 });
        assert_eq!(popup_rect(&m, (1900.0, 1070.0)), Rect { x: 1500, y: 860, w: 420, h: 220 });
        assert_eq!(popup_rect(&mon(-1280, 0, 1280, 1024, 1.0), (-1300.0, -40.0)), Rect { x: -1280, y: 0, w: 420, h: 220 });
        assert_eq!(points_rect(&mon(2880, 0, 2880, 1800, 2.0), &Rect { x: 20, y: 40, w: 200, h: 100 }), (1450, 20, 100, 50));
    }

    #[test]
    fn job_and_auto() {
        assert_eq!(job_mode("region", None, "a"), ("region", false));
        assert_eq!(job_mode("full", Some("a"), "a"), ("full", false));
        assert_eq!(job_mode("repeat", Some("a"), "a"), ("result", true));
        assert_eq!(job_mode("repeat", Some("b"), "a"), ("region", false));
        assert_eq!(job_mode("repeat", None, "a"), ("region", false));
        assert_eq!(interval_ms(None), 2000);
        assert_eq!(interval_ms(Some(0.0)), 2000);
        assert_eq!(interval_ms(Some(0.5)), 1000);
        assert_eq!(interval_ms(Some(3.0)), 3000);
        assert_eq!(auto_stop_ms(Some(30.0)), Some(1_800_000));
        assert_eq!(auto_stop_ms(Some(0.0)), None);
        assert_eq!(loose("Where are you, GOING?!"), "whereareyougoing");
        assert_eq!(loose("مرحبًا، يا صديقي!"), loose("مرحبًا يا صديقي"));
        let mut a = AutoText::default();
        assert_eq!(a.next(&["Hello".into(), "there".into()]), Some("Hello\nthere".into()));
        assert_eq!(a.next(&["hello".into(), "there.".into()]), None);
        assert_eq!(a.next(&["  ".into()]), None);
        assert_eq!(a.next(&["Bye".into()]), Some("Bye".into()));
    }

    #[test]
    fn tesseract() {
        // (tests/screenpc.cjs's sample.)
        let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t20\t40\t12\t91\tHello\n5\t1\t1\t1\t1\t2\t55\t21\t50\t12\t88\tworld\n5\t1\t1\t1\t2\t1\t10\t40\t30\t12\t20\tnoise\n5\t1\t2\t1\t1\t1\t100\t200\t60\t14\t95\tExit\n";
        let l = tsv_lines(tsv);
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].text, "Hello world");
        assert_eq!((l[0].x, l[0].w, l[0].h), (10.0, 95.0, 13.0));
        assert_eq!(l[1].text, "Exit");
        assert_eq!(tess_langs("List of available languages in \"/usr/share\" (2):\neng\nosd\n"), vec!["eng", "osd"]);
        assert_eq!(tess_lang("zh-TW"), "chi_tra");
        assert_eq!(tess_lang("auto"), "eng");
    }

    #[test]
    fn json_lines() {
        // (tests/screenpc.cjs's samples: one line after noise, many, none.)
        assert_eq!(parse_lines("warning\n{\"text\":\"A\",\"x\":1,\"y\":2,\"width\":3,\"height\":4}").len(), 1);
        let b = &parse_lines("warning\n{\"text\":\"A\",\"x\":1,\"y\":2,\"width\":3,\"height\":4}")[0];
        assert_eq!((b.x, b.y, b.w, b.h), (1.0, 2.0, 3.0, 4.0));
        assert_eq!(parse_lines("[{\"text\":\"A\"},{\"text\":\" \"},{\"text\":\"B\"}]").len(), 2);
        assert_eq!(parse_lines("nothing").len(), 0);
        assert_eq!(parse_lines("[{\"text\":\"A\"} trailing").len(), 0);
        let u = parse_lines("[{\"text\":\"\\u0645\\u0631\\u062d\\u0628\\u0627 \\ud83d\\ude00\",\"x\":1.5}]");
        assert_eq!(u[0].text, "مرحبا 😀");
        assert_eq!(u[0].x, 1.5);
        // (Windows OCR's language list: tags as text.)
        let l: Vec<String> = parse_lines("[{\"text\":\"en-US\"},{\"text\":\"ar-SA\"}]").into_iter().map(|b| b.text).collect();
        assert_eq!(l, vec!["en-US", "ar-SA"]);
        let v = vision_to_pixels(&Block { text: "x".into(), x: 0.125, y: 0.25, w: 0.5, h: 0.25 }, 200, 100);
        assert_eq!((v.x, v.y, v.w, v.h), (25.0, 50.0, 100.0, 25.0));
        assert_eq!(win_lang("zh-CN"), "zh-Hans");
        assert_eq!(win_lang("auto"), "");
        assert_eq!(mac_lang("ja"), "ja-JP");
        assert_eq!(ocr_kind("linux", false, false), "none");
        assert_eq!(ocr_kind("linux", false, true), "tesseract");
        assert_eq!(ocr_kind("windows", true, false), "ai");
        assert_eq!(ocr_kind("macos", false, false), "vision");
        assert!(json_parse("{\"a\":[1,true,null,\"x\"]}").is_some());
        assert!(json_parse("{\"a\":}").is_none());
    }

    #[test]
    fn startup() {
        let a = run_key_args("Kurokawa Tools", r"C:\Apps\kt.exe", true);
        assert_eq!(a[0], "add");
        assert_eq!(a[7], "\"C:\\Apps\\kt.exe\" --hidden");
        assert_eq!(run_key_args("Kurokawa Tools", "x", false), vec!["delete", RUN_KEY, "/v", "Kurokawa Tools", "/f"]);
        let p = launch_agent_plist("app.kurokawa.tools", "/Applications/K & T.app/Contents/MacOS/kt");
        assert!(p.contains("<string>/Applications/K &amp; T.app/Contents/MacOS/kt</string><string>--hidden</string>"));
        assert!(p.contains("<key>RunAtLoad</key><true/>"));
    }

    #[test]
    fn pixels() {
        let mut p = vec![1, 2, 3, 0, 10, 20, 30, 0];
        bgra_to_rgba(&mut p);
        assert_eq!(p, vec![3, 2, 1, 255, 30, 20, 10, 255]);
        // (An X server's 24-bit colour in 32 bits, least significant byte first: B G R x in memory.)
        let data = vec![0x30, 0x20, 0x10, 0x00, 0xFF, 0x00, 0x80, 0x00, /* padding */ 0, 0, 0, 0];
        let o = ximage_to_rgba(&data, 2, 1, 12, 32, false, (0xFF0000, 0xFF00, 0xFF)).unwrap();
        assert_eq!(o, vec![0x10, 0x20, 0x30, 255, 0x80, 0x00, 0xFF, 255]);
        // (Most significant first.)
        let o = ximage_to_rgba(&[0x00, 0x10, 0x20, 0x30], 1, 1, 4, 32, true, (0xFF0000, 0xFF00, 0xFF)).unwrap();
        assert_eq!(o, vec![0x10, 0x20, 0x30, 255]);
        // (16 bits, 5-6-5.)
        let v: u16 = (31 << 11) | (0 << 5) | 31;
        let o = ximage_to_rgba(&v.to_le_bytes(), 1, 1, 2, 16, false, (0xF800, 0x07E0, 0x001F)).unwrap();
        assert_eq!(o, vec![255, 0, 255, 255]);
        assert!(ximage_to_rgba(&[0; 4], 1, 1, 4, 8, false, (0, 0, 0)).is_err());
        assert!(ximage_to_rgba(&[0; 3], 1, 1, 4, 32, false, (0, 0, 0)).is_err());
        // (A crop.)
        let px: Vec<u8> = (0..4 * 3 * 4).map(|i| i as u8).collect();
        let (c, w, h) = crop_rgba(&px, 4, 3, &Rect { x: 1, y: 1, w: 2, h: 2 });
        assert_eq!((w, h), (2, 2));
        assert_eq!(&c[..4], &px[20..24]);
        assert_eq!(pixel(&c, 2, 1, 1), [px[40], px[41], px[42], px[43]]);
        assert!(alike([250, 3, 0, 255], [255, 0, 0], 8));
        assert!(!alike([200, 3, 0, 255], [255, 0, 0], 8));
    }

    /// The tests' own PNG reader: stored blocks only, every row's filter undone.
    fn png_decode_stored(png: &[u8]) -> (u32, u32, Vec<u8>) {
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        let mut i = 8;
        let (mut w, mut h) = (0, 0);
        let mut z: Vec<u8> = Vec::new();
        while i < png.len() {
            let n = u32::from_be_bytes([png[i], png[i + 1], png[i + 2], png[i + 3]]) as usize;
            let kind = &png[i + 4..i + 8];
            let data = &png[i + 8..i + 8 + n];
            let crc = u32::from_be_bytes([png[i + 8 + n], png[i + 9 + n], png[i + 10 + n], png[i + 11 + n]]);
            assert_eq!(crc, crc32(&[kind, data]));
            if kind == b"IHDR" {
                w = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
                h = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
            }
            if kind == b"IDAT" {
                z.extend_from_slice(data);
            }
            i += 12 + n;
        }
        let mut raw = Vec::new();
        let mut k = 2;
        loop {
            let last = z[k] & 1;
            let n = u16::from_le_bytes([z[k + 1], z[k + 2]]) as usize;
            raw.extend_from_slice(&z[k + 5..k + 5 + n]);
            k += 5 + n;
            if last == 1 {
                break;
            }
        }
        assert_eq!(u32::from_be_bytes([z[k], z[k + 1], z[k + 2], z[k + 3]]), adler32(&raw));
        let stride = w as usize * 4;
        let mut out = Vec::new();
        for y in 0..h as usize {
            let row = &raw[y * (stride + 1)..(y + 1) * (stride + 1)];
            assert_eq!(row[0], 1);
            let mut cur = vec![0u8; stride];
            for x in 0..stride {
                let left = if x >= 4 { cur[x - 4] } else { 0 };
                cur[x] = row[x + 1].wrapping_add(left);
            }
            out.extend_from_slice(&cur);
        }
        (w, h, out)
    }

    #[test]
    fn png() {
        assert_eq!(crc32(&[b"IEND"]), 0xAE42_6082);
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
        let (w, h) = (300u32, 230u32);
        let px: Vec<u8> = (0..w * h * 4).map(|i| (i * 7 % 251) as u8).collect();
        let png = png_encode(w, h, &px, &zlib_stored);
        let (w2, h2, back) = png_decode_stored(&png);
        assert_eq!((w2, h2), (w, h));
        assert_eq!(back, px);
        assert_eq!(&png[png.len() - 12..], &[0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xAE, 0x42, 0x60, 0x82]);
        assert_eq!(zlib_stored(&[]), vec![0x78, 0x01, 1, 0, 0, 0xFF, 0xFF, 0, 0, 0, 1]);
    }

    #[test]
    fn portal() {
        let call = "(objectpath '/org/freedesktop/portal/desktop/request/1_42/kt7',)\n";
        let p = portal_request_path(call).unwrap();
        assert_eq!(p, "/org/freedesktop/portal/desktop/request/1_42/kt7");
        let ok = "/org/freedesktop/portal/desktop/request/1_42/kt7: org.freedesktop.portal.Request.Response (uint32 0, {'uri': <'file:///home/u/Pictures/Screenshot%20from%202026.png'>})";
        assert_eq!(portal_response(ok, &p), Some(Ok("file:///home/u/Pictures/Screenshot%20from%202026.png".into())));
        let no = "/org/freedesktop/portal/desktop/request/1_42/kt7: org.freedesktop.portal.Request.Response (uint32 1, @a{sv} {})";
        assert_eq!(portal_response(no, &p), Some(Err(1)));
        assert_eq!(portal_response("/org/freedesktop/portal/desktop/request/1_42/other: org.freedesktop.portal.Request.Response (uint32 0, {})", &p), None);
        assert_eq!(portal_response("/org/freedesktop/portal/desktop: org.freedesktop.DBus.Properties.PropertiesChanged", &p), None);
        assert_eq!(file_uri_path("file:///home/u/Pictures/Screenshot%20from%202026.png").unwrap(), "/home/u/Pictures/Screenshot from 2026.png");
        assert_eq!(file_uri_path("file://localhost/tmp/a%2"), Some("/tmp/a%2".into()));
        assert_eq!(file_uri_path("https://x/y"), None);
        assert_eq!(portal_options("kt1"), "{'handle_token': <'kt1'>, 'interactive': <false>}");
        assert_eq!(grim_args((10, 20, 300, 40), "/t/a.png"), vec!["-g", "10,20 300x40", "-t", "png", "/t/a.png"]);
        assert_eq!(screencapture_args((-1280, 0, 1280, 800), "/t/a.png")[4], "-1280,0,1280,800");
        assert!(is_wayland(Some("wayland"), None));
        assert!(is_wayland(Some("x11"), Some("wayland-0")));
        assert!(!is_wayland(Some("x11"), Some("")));
    }
}
