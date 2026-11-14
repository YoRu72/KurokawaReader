//! The video tools' JSON (stage P5): a small JSON reader and writer (std only, so these rules are tested alone with
//! `rustc --edition 2021 --test vidjson.rs`), and what desktop/ytdlp.cjs and desktop/gallerydl.cjs make of the programs'
//! JSON answers, rule for rule:
//! - `normalise` — yt-dlp's `-J` shaped for the Add sheet (ytdlp.cjs `normalise`): a playlist's entries (flat), or one
//!   choice per height (the best stream of it, with the best audio when it has none), the four best audio streams, the
//!   subtitle languages;
//! - `gallery_items` — gallery-dl's `-j` messages → { title, items: [{ url, name, ext, width, height, id, category,
//!   headers }] } (gallerydl.cjs `list`).
//! Fields JavaScript leaves `undefined` are left out (the page reads them as undefined either way).

/// A JSON value. Numbers keep the text they came as, so what passes through is written back unchanged.
#[derive(Clone, Debug, PartialEq)]
pub enum J {
    Null,
    Bool(bool),
    Num(f64, String),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

impl J {
    pub fn num(n: f64) -> J {
        J::Num(n, js_num(n))
    }
    pub fn s(x: &str) -> J {
        J::Str(x.to_string())
    }
    /// A member (the last of a repeated name, as JSON.parse keeps); None for «undefined».
    pub fn get(&self, k: &str) -> Option<&J> {
        match self {
            J::Obj(v) => v.iter().rev().find(|(n, _)| n == k).map(|(_, x)| x),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            J::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_arr(&self) -> Option<&Vec<J>> {
        match self {
            J::Arr(a) => Some(a),
            _ => None,
        }
    }
    /// JavaScript's truthiness.
    pub fn truthy(&self) -> bool {
        match self {
            J::Null => false,
            J::Bool(b) => *b,
            J::Num(n, _) => *n != 0.0 && !n.is_nan(),
            J::Str(s) => !s.is_empty(),
            J::Arr(_) | J::Obj(_) => true,
        }
    }
    /// Number(x) as JavaScript does for the values JSON has (NaN for what is no number).
    pub fn number(&self) -> f64 {
        match self {
            J::Null => 0.0,
            J::Bool(b) => {
                if *b {
                    1.0
                } else {
                    0.0
                }
            }
            J::Num(n, _) => *n,
            J::Str(s) => js_number(s),
            J::Arr(_) | J::Obj(_) => f64::NAN,
        }
    }
    /// `${x}` as JavaScript writes it.
    pub fn text(&self) -> String {
        match self {
            J::Null => "null".to_string(),
            J::Bool(b) => b.to_string(),
            J::Num(n, _) => js_num(*n),
            J::Str(s) => s.clone(),
            J::Arr(a) => a.iter().map(|x| if matches!(x, J::Null) { String::new() } else { x.text() }).collect::<Vec<_>>().join(","),
            J::Obj(_) => "[object Object]".to_string(),
        }
    }
    /// The JSON text.
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        write_json(self, &mut out);
        out
    }
}

/// A finite number as JavaScript prints it (integers without «.0»).
pub fn js_num(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_string();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity".to_string() } else { "-Infinity".to_string() };
    }
    if n == n.trunc() && n.abs() < 1e21 {
        return format!("{}", n as i128);
    }
    format!("{}", n)
}

/// Number(string) for the plain forms: decimal with an optional exponent, surrounding blanks ignored, '' → 0;
/// anything else NaN.
pub fn js_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    let ok = {
        let b = t.as_bytes();
        let mut i = 0;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let mut digits = 0;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
            digits += 1;
        }
        if i < b.len() && b[i] == b'.' {
            i += 1;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
                digits += 1;
            }
        }
        if digits > 0 && i < b.len() && (b[i] == b'e' || b[i] == b'E') {
            i += 1;
            if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
                i += 1;
            }
            let mut e = 0;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
                e += 1;
            }
            if e == 0 {
                digits = 0;
            }
        }
        digits > 0 && i == b.len()
    };
    if !ok {
        return match t {
            "Infinity" | "+Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            _ => f64::NAN,
        };
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// Math.round: halves toward +∞.
pub fn js_round(n: f64) -> f64 {
    (n + 0.5).floor()
}

fn write_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_json(v: &J, out: &mut String) {
    match v {
        J::Null => out.push_str("null"),
        J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        J::Num(n, raw) => {
            if !n.is_finite() {
                out.push_str("null");
            } else if raw.is_empty() {
                out.push_str(&js_num(*n));
            } else {
                out.push_str(raw);
            }
        }
        J::Str(s) => write_str(s, out),
        J::Arr(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(x, out);
            }
            out.push(']');
        }
        J::Obj(o) => {
            out.push('{');
            for (i, (k, x)) in o.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_str(k, out);
                out.push(':');
                write_json(x, out);
            }
            out.push('}');
        }
    }
}

/// JSON.parse (strict: one value, blanks around it; nesting at most 512 deep).
pub fn parse(text: &str) -> Result<J, String> {
    let mut p = P { b: text.as_bytes(), i: 0, depth: 0 };
    p.ws();
    let v = p.value()?;
    p.ws();
    if p.i != p.b.len() {
        return Err(format!("JSON: unexpected text at {}", p.i));
    }
    Ok(v)
}

struct P<'a> {
    b: &'a [u8],
    i: usize,
    depth: usize,
}

impl<'a> P<'a> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }
    fn err<T>(&self, what: &str) -> Result<T, String> {
        Err(format!("JSON: {} at {}", what, self.i))
    }
    fn lit(&mut self, w: &str, v: J) -> Result<J, String> {
        if self.b[self.i..].starts_with(w.as_bytes()) {
            self.i += w.len();
            Ok(v)
        } else {
            self.err("bad literal")
        }
    }
    fn value(&mut self) -> Result<J, String> {
        if self.i >= self.b.len() {
            return self.err("unexpected end");
        }
        match self.b[self.i] {
            b'n' => self.lit("null", J::Null),
            b't' => self.lit("true", J::Bool(true)),
            b'f' => self.lit("false", J::Bool(false)),
            b'"' => self.string().map(J::Str),
            b'[' => {
                self.depth += 1;
                if self.depth > 512 {
                    return self.err("too deep");
                }
                self.i += 1;
                let mut a = Vec::new();
                self.ws();
                if self.i < self.b.len() && self.b[self.i] == b']' {
                    self.i += 1;
                    self.depth -= 1;
                    return Ok(J::Arr(a));
                }
                loop {
                    self.ws();
                    a.push(self.value()?);
                    self.ws();
                    if self.i >= self.b.len() {
                        return self.err("unexpected end");
                    }
                    match self.b[self.i] {
                        b',' => self.i += 1,
                        b']' => {
                            self.i += 1;
                            break;
                        }
                        _ => return self.err("expected , or ]"),
                    }
                }
                self.depth -= 1;
                Ok(J::Arr(a))
            }
            b'{' => {
                self.depth += 1;
                if self.depth > 512 {
                    return self.err("too deep");
                }
                self.i += 1;
                let mut o = Vec::new();
                self.ws();
                if self.i < self.b.len() && self.b[self.i] == b'}' {
                    self.i += 1;
                    self.depth -= 1;
                    return Ok(J::Obj(o));
                }
                loop {
                    self.ws();
                    if self.i >= self.b.len() || self.b[self.i] != b'"' {
                        return self.err("expected a name");
                    }
                    let k = self.string()?;
                    self.ws();
                    if self.i >= self.b.len() || self.b[self.i] != b':' {
                        return self.err("expected :");
                    }
                    self.i += 1;
                    self.ws();
                    let v = self.value()?;
                    o.push((k, v));
                    self.ws();
                    if self.i >= self.b.len() {
                        return self.err("unexpected end");
                    }
                    match self.b[self.i] {
                        b',' => self.i += 1,
                        b'}' => {
                            self.i += 1;
                            break;
                        }
                        _ => return self.err("expected , or }"),
                    }
                }
                self.depth -= 1;
                Ok(J::Obj(o))
            }
            b'-' | b'0'..=b'9' => {
                let st = self.i;
                if self.b[self.i] == b'-' {
                    self.i += 1;
                }
                let d0 = self.i;
                while self.i < self.b.len() && self.b[self.i].is_ascii_digit() {
                    self.i += 1;
                }
                if self.i == d0 {
                    return self.err("bad number");
                }
                if self.i < self.b.len() && self.b[self.i] == b'.' {
                    self.i += 1;
                    let f0 = self.i;
                    while self.i < self.b.len() && self.b[self.i].is_ascii_digit() {
                        self.i += 1;
                    }
                    if self.i == f0 {
                        return self.err("bad number");
                    }
                }
                if self.i < self.b.len() && (self.b[self.i] == b'e' || self.b[self.i] == b'E') {
                    self.i += 1;
                    if self.i < self.b.len() && (self.b[self.i] == b'+' || self.b[self.i] == b'-') {
                        self.i += 1;
                    }
                    let e0 = self.i;
                    while self.i < self.b.len() && self.b[self.i].is_ascii_digit() {
                        self.i += 1;
                    }
                    if self.i == e0 {
                        return self.err("bad number");
                    }
                }
                let raw = std::str::from_utf8(&self.b[st..self.i]).unwrap_or("0").to_string();
                let n = raw.parse::<f64>().unwrap_or(f64::NAN);
                Ok(J::Num(n, raw))
            }
            _ => self.err("unexpected character"),
        }
    }
    fn hex4(&mut self) -> Result<u32, String> {
        if self.i + 4 > self.b.len() {
            return self.err("bad escape");
        }
        let s = std::str::from_utf8(&self.b[self.i..self.i + 4]).map_err(|_| "JSON: bad escape".to_string())?;
        let v = u32::from_str_radix(s, 16).map_err(|_| "JSON: bad escape".to_string())?;
        self.i += 4;
        Ok(v)
    }
    fn string(&mut self) -> Result<String, String> {
        self.i += 1;
        let mut out: Vec<u8> = Vec::new();
        loop {
            if self.i >= self.b.len() {
                return self.err("unterminated string");
            }
            let c = self.b[self.i];
            match c {
                b'"' => {
                    self.i += 1;
                    break;
                }
                b'\\' => {
                    self.i += 1;
                    if self.i >= self.b.len() {
                        return self.err("bad escape");
                    }
                    let e = self.b[self.i];
                    self.i += 1;
                    let ch: Option<char> = match e {
                        b'"' => Some('"'),
                        b'\\' => Some('\\'),
                        b'/' => Some('/'),
                        b'b' => Some('\u{8}'),
                        b'f' => Some('\u{c}'),
                        b'n' => Some('\n'),
                        b'r' => Some('\r'),
                        b't' => Some('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            if (0xD800..0xDC00).contains(&hi) && self.b[self.i..].starts_with(b"\\u") {
                                let save = self.i;
                                self.i += 2;
                                let lo = self.hex4()?;
                                if (0xDC00..0xE000).contains(&lo) {
                                    char::from_u32(0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00))
                                } else {
                                    self.i = save;
                                    Some('\u{FFFD}')
                                }
                            } else {
                                Some(char::from_u32(hi).unwrap_or('\u{FFFD}'))
                            }
                        }
                        _ => return self.err("bad escape"),
                    };
                    let mut buf = [0u8; 4];
                    out.extend_from_slice(ch.unwrap_or('\u{FFFD}').encode_utf8(&mut buf).as_bytes());
                }
                c if c < 0x20 => return self.err("control character in a string"),
                _ => {
                    out.push(c);
                    self.i += 1;
                }
            }
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    }
}

/// An object built in order, «undefined» members left out.
pub struct Obj(Vec<(String, J)>);
impl Obj {
    pub fn new() -> Obj {
        Obj(Vec::new())
    }
    pub fn put(mut self, k: &str, v: Option<J>) -> Obj {
        if let Some(v) = v {
            self.0.retain(|(n, _)| n != k);
            self.0.push((k.to_string(), v));
        }
        self
    }
    pub fn done(self) -> J {
        J::Obj(self.0)
    }
}

fn get<'a>(o: &'a J, k: &str) -> Option<&'a J> {
    o.get(k)
}
fn cl(o: &J, k: &str) -> Option<J> {
    o.get(k).cloned()
}
/// a || b (JavaScript): the first truthy, else the last one given (undefined when that is missing).
fn or(vals: &[Option<&J>]) -> Option<J> {
    for v in vals.iter() {
        if let Some(x) = v {
            if x.truthy() {
                return Some((*x).clone());
            }
        }
    }
    vals.last().and_then(|v| v.map(|x| x.clone()))
}
fn num_or0(o: &J, k: &str) -> f64 {
    match o.get(k) {
        Some(v) if v.truthy() => v.number(),
        _ => 0.0,
    }
}
fn has_codec(f: &J, k: &str) -> bool {
    match f.get(k) {
        Some(v) => v.truthy() && v.as_str() != Some("none"),
        None => false,
    }
}
fn hdr(f: &J) -> bool {
    match f.get("dynamic_range") {
        Some(v) if v.truthy() => {
            let t = v.text().to_ascii_uppercase();
            t.contains("HDR") || t.contains("HLG")
        }
        _ => false,
    }
}

/// yt-dlp's `-J` → the Add sheet's info (desktop/ytdlp.cjs normalise).
pub fn normalise(j: &J) -> J {
    let entries_all: Vec<J> = get(j, "entries").filter(|e| e.truthy()).and_then(|e| e.as_arr().cloned()).unwrap_or_default();
    if get(j, "_type").and_then(|t| t.as_str()) == Some("playlist") {
        let entries: Vec<J> = entries_all
            .iter()
            .filter(|e| e.truthy())
            .map(|e| {
                Obj::new()
                    .put("url", or(&[get(e, "url"), get(e, "webpage_url"), get(e, "original_url")]))
                    .put("title", cl(e, "title"))
                    .put("duration", cl(e, "duration"))
                    .put("id", cl(e, "id"))
                    .done()
            })
            .collect();
        return Obj::new()
            .put("kind", Some(J::s("playlist")))
            .put("title", cl(j, "title"))
            .put("entries", Some(J::Arr(entries)))
            .put("count", Some(J::num(entries_all.len() as f64)))
            .put("url", cl(j, "webpage_url"))
            .done();
    }
    let formats: Vec<J> = get(j, "formats").filter(|e| e.truthy()).and_then(|e| e.as_arr().cloned()).unwrap_or_default();
    let fmts: Vec<&J> = formats.iter().filter(|f| get(f, "url").map(|x| x.truthy()).unwrap_or(false) || get(f, "manifest_url").map(|x| x.truthy()).unwrap_or(false)).collect();
    let video: Vec<&J> = fmts.iter().cloned().filter(|f| has_codec(f, "vcodec")).collect();
    let audio_only: Vec<&J> = fmts.iter().cloned().filter(|f| !has_codec(f, "vcodec") && has_codec(f, "acodec")).collect();
    // (A Map: a key keeps its first place when a better stream replaces it.)
    let mut by_height: Vec<(String, &J, f64)> = Vec::new();
    for f in video.iter() {
        let h = num_or0(f, "height");
        let key = format!("{}{}", js_num(h), if hdr(f) { " HDR" } else { "" });
        let score = num_or0(f, "fps") * 1000.0 + num_or0(f, "tbr") + if has_codec(f, "acodec") { 1.0 } else { 0.0 };
        match by_height.iter_mut().find(|(k, _, _)| *k == key) {
            Some(slot) => {
                if score > slot.2 {
                    slot.1 = f;
                    slot.2 = score;
                }
            }
            None => by_height.push((key, f, score)),
        }
    }
    let abr = |f: &J| -> f64 {
        let a = num_or0(f, "abr");
        if a != 0.0 {
            a
        } else {
            num_or0(f, "tbr")
        }
    };
    let mut audios: Vec<&J> = audio_only.clone();
    // (Array.prototype.sort is stable: equal ones keep their order.)
    audios.sort_by(|a, b| abr(b).partial_cmp(&abr(a)).unwrap_or(std::cmp::Ordering::Equal));
    let best = audios.first().cloned();
    let size_of = |f: &J| -> f64 {
        let s = num_or0(f, "filesize");
        if s != 0.0 {
            s
        } else {
            num_or0(f, "filesize_approx")
        }
    };
    let mut chosen: Vec<&J> = by_height.iter().map(|(_, f, _)| *f).collect();
    chosen.sort_by(|a, b| num_or0(b, "height").partial_cmp(&num_or0(a, "height")).unwrap_or(std::cmp::Ordering::Equal));
    let choices: Vec<J> = chosen
        .iter()
        .map(|f| {
            let muxed = has_codec(f, "acodec");
            let size = size_of(f) + if muxed || best.is_none() { 0.0 } else { size_of(best.unwrap()) };
            let fid = get(f, "format_id").map(|x| x.text()).unwrap_or_else(|| "undefined".to_string());
            let id = if muxed {
                cl(f, "format_id")
            } else {
                Some(J::Str(format!("{}+{}", fid, best.map(|b| get(b, "format_id").map(|x| x.text()).unwrap_or_else(|| "undefined".to_string())).unwrap_or_else(|| "bestaudio".to_string()))))
            };
            let height = num_or0(f, "height");
            let fps = num_or0(f, "fps");
            let first = if height != 0.0 {
                format!("{}p{}", js_num(height), if fps != 0.0 && fps > 30.0 { js_num(js_round(fps)) } else { String::new() })
            } else {
                or(&[get(f, "format_note"), get(f, "format_id")]).map(|x| x.text()).unwrap_or_else(|| "undefined".to_string())
            };
            let label = format!("{}{}", first, if hdr(f) { " HDR" } else { "" });
            Obj::new()
                .put("id", id)
                .put("kind", Some(J::s("video")))
                .put("label", Some(J::Str(label)))
                .put("ext", cl(f, "ext"))
                .put("height", cl(f, "height"))
                .put("fps", cl(f, "fps"))
                .put("size", if size != 0.0 && !size.is_nan() { Some(J::num(size)) } else { None })
                .put("vcodec", cl(f, "vcodec"))
                .put("acodec", if muxed { cl(f, "acodec") } else { best.and_then(|b| cl(b, "acodec")) })
                .put("note", cl(f, "format_note"))
                .done()
        })
        .collect();
    let audio: Vec<J> = audios
        .iter()
        .take(4)
        .map(|f| {
            let ac = match get(f, "acodec") {
                Some(v) if v.truthy() => v.text(),
                _ => String::new(),
            };
            let label = format!("{} kbps {}", js_num(js_round(abr(f))), ac).trim().to_string();
            let size = size_of(f);
            Obj::new()
                .put("id", cl(f, "format_id"))
                .put("kind", Some(J::s("audio")))
                .put("label", Some(J::Str(label)))
                .put("ext", cl(f, "ext"))
                .put("size", if size != 0.0 { Some(J::num(size)) } else { None })
                .put("acodec", cl(f, "acodec"))
                .done()
        })
        .collect();
    let subtitles: Vec<J> = match get(j, "subtitles") {
        Some(J::Obj(o)) => {
            let mut keys: Vec<String> = Vec::new();
            for (k, _) in o.iter() {
                if !keys.contains(k) {
                    keys.push(k.clone());
                }
            }
            keys.into_iter().map(J::Str).collect()
        }
        _ => Vec::new(),
    };
    let chapters = get(j, "chapters").filter(|c| c.truthy()).and_then(|c| c.as_arr().map(|a| a.len())).unwrap_or(0);
    Obj::new()
        .put("kind", Some(J::s("video")))
        .put("id", cl(j, "id"))
        .put("title", cl(j, "title"))
        .put("thumbnail", cl(j, "thumbnail"))
        .put("duration", cl(j, "duration"))
        .put("site", cl(j, "extractor_key"))
        .put("url", or(&[get(j, "webpage_url"), get(j, "original_url")]))
        .put("uploader", or(&[get(j, "uploader"), get(j, "channel")]))
        .put("choices", Some(J::Arr(choices)))
        .put("audio", Some(J::Arr(audio)))
        .put("subtitles", Some(J::Arr(subtitles)))
        .put("live", Some(J::Bool(get(j, "is_live").map(|x| x.truthy()).unwrap_or(false))))
        .put("chapters", Some(J::num(chapters as f64)))
        .done()
}

/// The extension a picture's address ends with (gallerydl.cjs's /\.([a-z0-9]{2,5})(?:\?|$)/i, first match).
pub fn ext_of_url(u: &str) -> Option<String> {
    let cs: Vec<char> = u.chars().collect();
    for i in 0..cs.len() {
        if cs[i] != '.' {
            continue;
        }
        let mut n = 0;
        while i + 1 + n < cs.len() && cs[i + 1 + n].is_ascii_alphanumeric() {
            n += 1;
        }
        let end = i + 1 + n;
        if (2..=5).contains(&n) && (end == cs.len() || cs[end] == '?') {
            return Some(cs[i + 1..end].iter().collect());
        }
    }
    None
}

/// A name with the characters a file name may not hold made blanks (/[\\/:*?"<>|\u0000-\u001f]+/g → ' '), at most
/// `max` UTF-16 units.
pub fn blank_bad(s: &str, max: usize) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in s.chars() {
        if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 0x20 {
            if !in_run {
                out.push(' ');
                in_run = true;
            }
        } else {
            out.push(c);
            in_run = false;
        }
    }
    utf16_slice(&out, max)
}

/// s.slice(0, max) in UTF-16 units (a pair never cut in two here: the cut falls before it).
pub fn utf16_slice(s: &str, max: usize) -> String {
    let mut n = 0;
    let mut out = String::new();
    for c in s.chars() {
        let w = c.len_utf16();
        if n + w > max {
            break;
        }
        n += w;
        out.push(c);
    }
    out
}

/// gallery-dl's `-j` messages → { title, items } (gallerydl.cjs list). Err when the answer is no list.
pub fn gallery_items(text: &str) -> Result<J, String> {
    let msgs = parse(text).map_err(|_| "gallery-dl: unreadable answer".to_string())?;
    let msgs = match msgs {
        J::Arr(a) => a,
        _ => return Err("gallery-dl: unreadable answer".to_string()),
    };
    let mut items: Vec<J> = Vec::new();
    let mut title = J::s("");
    for m in msgs.iter() {
        let a = match m.as_arr() {
            Some(a) => a,
            None => continue,
        };
        let kind = a.first().map(|x| x.number()).unwrap_or(f64::NAN);
        let kind_is = |n: f64| matches!(a.first(), Some(J::Num(v, _)) if *v == n);
        let _ = kind;
        if kind_is(2.0) {
            if let Some(d) = a.get(1) {
                if matches!(d, J::Obj(_)) {
                    let album = get(d, "album").and_then(|x| get(x, "title"));
                    let user = get(d, "user").and_then(|x| get(x, "name"));
                    let t = or(&[get(d, "title"), get(d, "name"), album, user, Some(&title)]);
                    if let Some(t) = t {
                        title = t;
                    }
                }
            }
        }
        if kind_is(3.0) {
            if let Some(J::Str(url)) = a.get(1) {
                let empty = J::Obj(Vec::new());
                let d = match a.get(2) {
                    Some(x) if x.truthy() => x,
                    _ => &empty,
                };
                let ext = match get(d, "extension") {
                    Some(x) if x.truthy() => x.text(),
                    _ => ext_of_url(url).unwrap_or_else(|| "jpg".to_string()),
                };
                let num = match get(d, "num") {
                    Some(x) if x.truthy() => x.text(),
                    _ => String::new(),
                };
                let base = match or(&[get(d, "filename"), get(d, "id")]) {
                    Some(x) if x.truthy() => x.text(),
                    _ => {
                        if !num.is_empty() {
                            num
                        } else {
                            (items.len() + 1).to_string()
                        }
                    }
                };
                let name = format!("{}.{}", blank_bad(&base, 120), ext);
                let headers = match get(d, "_http_headers") {
                    Some(x) if x.truthy() => Some(x.clone()),
                    _ => None,
                };
                items.push(
                    Obj::new()
                        .put("url", Some(J::Str(url.clone())))
                        .put("name", Some(J::Str(name)))
                        .put("ext", Some(J::Str(ext)))
                        .put("width", cl(d, "width"))
                        .put("height", cl(d, "height"))
                        .put("id", cl(d, "id"))
                        .put("category", cl(d, "category"))
                        .put("headers", headers)
                        .done(),
                );
            }
        }
    }
    Ok(Obj::new().put("title", Some(title)).put("items", Some(J::Arr(items))).done())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_round_trip() {
        let t = r#"{"a":[1,2.50,-3e2,true,false,null],"b":"x\"\\\né😀","c":{}}"#;
        let v = parse(t).unwrap();
        assert_eq!(v.get("b").unwrap().as_str().unwrap(), "x\"\\\né😀");
        assert_eq!(v.to_json(), r#"{"a":[1,2.50,-3e2,true,false,null],"b":"x\"\\\né😀","c":{}}"#);
        assert!(parse("[1,]").is_err());
        assert!(parse("{\"a\" 1}").is_err());
        assert!(parse("01x").is_err());
        assert!(parse("\"a").is_err());
        assert!(parse(&"[".repeat(600)).is_err());
        // (The last of a repeated name, as JSON.parse.)
        assert_eq!(parse(r#"{"a":1,"a":2}"#).unwrap().get("a").unwrap().number(), 2.0);
    }

    #[test]
    fn js_numbers() {
        assert_eq!(js_num(3.0), "3");
        assert_eq!(js_num(30.5), "30.5");
        assert_eq!(js_num(-0.25), "-0.25");
        assert_eq!(js_number(" 3.000 "), 3.0);
        assert_eq!(js_number(""), 0.0);
        assert!(js_number("NA").is_nan());
        assert!(js_number("3abc").is_nan());
        assert_eq!(js_number("1e3"), 1000.0);
        assert_eq!(js_round(59.94), 60.0);
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
    }

    const DASH: &str = r#"{"id":"abc","title":"A video","thumbnail":"https://i/t.jpg","duration":212,"extractor_key":"Youtube","webpage_url":"https://www.youtube.com/watch?v=abc","channel":"Chan","subtitles":{"en":[],"ar":[]},"chapters":[{},{}],"is_live":false,"formats":[
      {"format_id":"sb0","url":"https://x/sb","vcodec":"none","acodec":"none","ext":"mhtml"},
      {"format_id":"139","url":"https://x/a1","vcodec":"none","acodec":"mp4a.40.5","abr":48.8,"ext":"m4a","filesize":1000},
      {"format_id":"140","url":"https://x/a2","vcodec":"none","acodec":"mp4a.40.2","abr":129.5,"ext":"m4a","filesize":3000},
      {"format_id":"251","url":"https://x/a3","vcodec":"none","acodec":"opus","abr":129.5,"ext":"webm","filesize_approx":2900},
      {"format_id":"18","url":"https://x/v18","vcodec":"avc1","acodec":"mp4a.40.2","height":360,"fps":30,"tbr":500,"ext":"mp4","filesize":20000},
      {"format_id":"134","url":"https://x/v134","vcodec":"avc1","acodec":"none","height":360,"fps":30,"tbr":400,"ext":"mp4","filesize":15000},
      {"format_id":"299","url":"https://x/v299","vcodec":"avc1","acodec":"none","height":1080,"fps":59.94,"tbr":4000,"ext":"mp4","filesize":900000},
      {"format_id":"137","url":"https://x/v137","vcodec":"avc1","acodec":"none","height":1080,"fps":30,"tbr":3000,"ext":"mp4"},
      {"format_id":"701","manifest_url":"https://x/m","vcodec":"av01","acodec":"none","height":2160,"fps":60,"tbr":9000,"ext":"mp4","dynamic_range":"HDR10"},
      {"format_id":"nourl","vcodec":"avc1","acodec":"none","height":4320}
    ]}"#;

    #[test]
    fn normalise_video() {
        let n = normalise(&parse(DASH).unwrap());
        let ch = n.get("choices").unwrap().as_arr().unwrap();
        let labels: Vec<String> = ch.iter().map(|c| c.get("label").unwrap().text()).collect();
        assert_eq!(labels, vec!["2160p60 HDR", "1080p60", "360p"]);
        let ids: Vec<String> = ch.iter().map(|c| c.get("id").unwrap().text()).collect();
        // (The 360p muxed stream beats the one without sound by its higher tbr; the best audio is 140 — the first of
        // the two at 129.5, as a stable sort keeps them.)
        assert_eq!(ids, vec!["701+140", "299+140", "18"]);
        assert_eq!(ch[1].get("size").unwrap().number(), 903000.0);
        // (No size of its own: the best audio's alone, as ytdlp.cjs adds them.)
        assert_eq!(ch[0].get("size").unwrap().number(), 3000.0);
        assert_eq!(ch[1].get("acodec").unwrap().text(), "mp4a.40.2");
        let au = n.get("audio").unwrap().as_arr().unwrap();
        let al: Vec<String> = au.iter().map(|c| c.get("label").unwrap().text()).collect();
        assert_eq!(al, vec!["130 kbps mp4a.40.2", "130 kbps opus", "49 kbps mp4a.40.5"]);
        assert_eq!(au[1].get("size").unwrap().number(), 2900.0);
        assert_eq!(n.get("site").unwrap().text(), "Youtube");
        assert_eq!(n.get("uploader").unwrap().text(), "Chan");
        assert_eq!(n.get("subtitles").unwrap().to_json(), r#"["en","ar"]"#);
        assert_eq!(n.get("chapters").unwrap().number(), 2.0);
        assert_eq!(n.get("live").unwrap(), &J::Bool(false));
        assert_eq!(n.get("kind").unwrap().text(), "video");
        assert_eq!(n.get("duration").unwrap().to_json(), "212");
    }

    #[test]
    fn normalise_playlist_and_bare() {
        let p = normalise(&parse(r#"{"_type":"playlist","title":"L","webpage_url":"https://p","entries":[{"url":"https://a","title":"A","duration":3,"id":"a"},null,{"webpage_url":"https://b"}]}"#).unwrap());
        assert_eq!(p.to_json(), r#"{"kind":"playlist","title":"L","entries":[{"url":"https://a","title":"A","duration":3,"id":"a"},{"url":"https://b"}],"count":3,"url":"https://p"}"#);
        // (No formats at all: no choices; a format without a height labelled by its note or id.)
        let b = normalise(&parse(r#"{"id":"x","title":"T","formats":[{"format_id":"hls-1","url":"u","vcodec":"avc1","acodec":"mp4a"}]}"#).unwrap());
        assert_eq!(b.get("choices").unwrap().to_json(), r#"[{"id":"hls-1","kind":"video","label":"hls-1","vcodec":"avc1","acodec":"mp4a"}]"#);
        assert_eq!(b.get("subtitles").unwrap().to_json(), "[]");
        let e = normalise(&parse("{}").unwrap());
        assert_eq!(e.to_json(), r#"{"kind":"video","choices":[],"audio":[],"subtitles":[],"live":false,"chapters":0}"#);
    }

    #[test]
    fn gallery() {
        let t = r#"[[1,{}],[2,{"album":{"title":"Album ✓"},"category":"x"}],[3,"https://h/a/one.JPEG?w=1",{"filename":"one/two","width":10,"height":20,"id":7,"category":"x","_http_headers":{"Referer":"https://h/"}}],[3,"https://h/b/pic.png?x=1",{"num":2}],[3,"https://h/c/noext",{}],[3,"https://h/d.jpg/x.webp",null],"junk",[3,5]]"#;
        let g = gallery_items(t).unwrap();
        assert_eq!(g.get("title").unwrap().text(), "Album ✓");
        let items = g.get("items").unwrap().as_arr().unwrap();
        let names: Vec<String> = items.iter().map(|i| i.get("name").unwrap().text()).collect();
        assert_eq!(names, vec!["one two.JPEG", "2.png", "3.jpg", "4.webp"]);
        assert_eq!(items[0].get("headers").unwrap().to_json(), r#"{"Referer":"https://h/"}"#);
        assert!(items[1].get("headers").is_none());
        assert_eq!(items[0].get("id").unwrap().to_json(), "7");
        assert!(gallery_items("{}").is_err());
        assert!(gallery_items("nope").is_err());
        assert_eq!(gallery_items("[]").unwrap().to_json(), r#"{"title":"","items":[]}"#);
        assert_eq!(ext_of_url("https://h/x.tar.gz"), Some("tar".to_string()).filter(|_| false).or(Some("gz".to_string())));
        assert_eq!(ext_of_url("https://h/x.jpg?a.b"), Some("jpg".to_string()));
        assert_eq!(ext_of_url("https://h/x.toolong"), None);
        assert_eq!(blank_bad("a<b>|c\u{1}d", 120), "a b c d");
        assert_eq!(blank_bad(&"x".repeat(200), 120).len(), 120);
    }
}
