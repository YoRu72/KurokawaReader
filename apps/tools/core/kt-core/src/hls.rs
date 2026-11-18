//! HLS playlists as the phone's downloader reads them (stage M4): KtHls.java's rules — the master playlist's variants
//! and the choice among them, the media playlist's pieces (each with its address, its AES-128 key's address and IV,
//! its sequence number, its byte range), the init section (EXT-X-MAP), «live», the duration — and the addresses
//! resolved exactly as Java's `new URL(base, line).toString()` does (java.net.URL's own reading, RFC 2396 with its
//! quirks: «./» and «../» taken out only where it takes them out, a query-only line, «url:» prefixes, a same-scheme
//! relative). Where Java's URL would do something this does not copy (another scheme, an IPv6 or odd authority, a
//! hexadecimal float) the answer is an error and the caller uses Java. Std only; `rustc --edition 2021 --test hls.rs`.
//!
//! Text is UTF-16 units, as Java's String (Java decodes the playlist; the indices and the trims are Java's).

include!("javachar.in");
include!("javachar_fns.in");

/// (Prefixes here are ASCII: a byte is a unit.)
fn starts(s: &[u16], p: &str) -> bool {
    s.len() >= p.len() && s.iter().zip(p.bytes()).all(|(&a, b)| a == b as u16)
}
fn index_of(s: &[u16], c: u16, from: usize) -> Option<usize> {
    s.iter().skip(from).position(|&u| u == c).map(|i| i + from)
}
fn last_index_of(s: &[u16], c: u16, upto: usize) -> Option<usize> {
    // (String.lastIndexOf(ch, fromIndex): the last at or before `upto`.)
    let end = (upto + 1).min(s.len());
    s[..end].iter().rposition(|&u| u == c)
}
fn find(s: &[u16], pat: &[u16], from: usize) -> Option<usize> {
    if from > s.len() || pat.len() > s.len() {
        return None;
    }
    (from..=s.len() - pat.len()).find(|&i| s[i..i + pat.len()] == pat[..])
}
fn cat(parts: &[&[u16]]) -> Vec<u16> {
    let mut o = Vec::new();
    for p in parts {
        o.extend_from_slice(p);
    }
    o
}

/* ---------- java.net.URL ---------- */

/// A URL as java.net.URL keeps it (what toString needs).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct JUrl {
    pub protocol: Vec<u16>,
    pub authority: Option<Vec<u16>>,
    pub path: Option<Vec<u16>>,
    pub query: Option<Vec<u16>>,
    pub fragment: Option<Vec<u16>>,
}
impl JUrl {
    /// URLStreamHandler.toExternalForm.
    pub fn to_units(&self) -> Vec<u16> {
        let mut o = self.protocol.clone();
        o.push(b':' as u16);
        if let Some(a) = &self.authority {
            if !a.is_empty() {
                o.extend("//".encode_utf16());
                o.extend_from_slice(a);
            }
        }
        if let Some(p) = &self.path {
            o.extend_from_slice(p);
        }
        if let Some(q) = &self.query {
            o.push(b'?' as u16);
            o.extend_from_slice(q);
        }
        if let Some(r) = &self.fragment {
            o.push(b'#' as u16);
            o.extend_from_slice(r);
        }
        o
    }
}
fn valid_protocol(s: &[u16]) -> bool {
    if s.is_empty() || !j_is_letter_unit(s[0]) {
        return false;
    }
    s[1..].iter().all(|&u| j_is_letter_or_digit_unit(u) || u == b'.' as u16 || u == b'+' as u16 || u == b'-' as u16)
}
fn ascii_lower(s: &[u16]) -> Option<Vec<u16>> {
    if s.iter().any(|&u| u > 0x7F) {
        return None;
    }
    Some(s.iter().map(|&u| if (0x41..=0x5A).contains(&u) { u + 32 } else { u }).collect())
}
fn is(s: &[u16], t: &str) -> bool {
    s.iter().copied().eq(t.encode_utf16())
}

/// `new URL(context, spec)`: Err where Java throws, or where Java would take a road this does not follow.
pub fn resolve(context: Option<&JUrl>, spec: &[u16]) -> Result<JUrl, String> {
    let mut limit = spec.len();
    let mut start = 0usize;
    while limit > 0 && spec[limit - 1] <= 0x20 {
        limit -= 1;
    }
    while start < limit && spec[start] <= 0x20 {
        start += 1;
    }
    if spec.len() >= start + 4 && ascii_lower(&spec[start..start + 4]).map(|l| is(&l, "url:")).unwrap_or(false) {
        start += 4;
    }
    let a_ref = start < spec.len() && spec[start] == b'#' as u16;
    let mut new_protocol: Option<Vec<u16>> = None;
    if !a_ref {
        let mut i = start;
        while i < limit && spec[i] != b'/' as u16 {
            if spec[i] == b':' as u16 {
                let s = &spec[start..i];
                if valid_protocol(s) {
                    // (Java lowers it with Locale.ROOT; a scheme beyond ASCII is not one this follows.)
                    new_protocol = Some(ascii_lower(s).ok_or("url: a scheme beyond ASCII")?);
                    start = i + 1;
                }
                break;
            }
            i += 1;
        }
    }
    let mut u = JUrl::default();
    let mut is_relative = false;
    let mut protocol = new_protocol.clone();
    if let Some(c) = context {
        let same = match &new_protocol {
            None => true,
            Some(p) => ascii_lower(&c.protocol).as_deref() == Some(&p[..]),
        };
        if same {
            if c.path.as_ref().map(|p| starts(p, "/")).unwrap_or(false) {
                new_protocol = None;
            }
            if new_protocol.is_none() {
                protocol = Some(c.protocol.clone());
                u.authority = c.authority.clone();
                u.path = c.path.clone();
                u.query = c.query.clone();
                is_relative = true;
            }
        }
    }
    let protocol = protocol.ok_or("url: no protocol")?;
    if !is(&protocol, "http") && !is(&protocol, "https") {
        return Err(format!("url: the {} scheme is Java's", String::from_utf16_lossy(&protocol)));
    }
    u.protocol = protocol;
    if !is_relative {
        u.query = None;
    }
    let mut spec: Vec<u16> = spec.to_vec();
    let mut fragment = None;
    if let Some(i) = index_of(&spec, b'#' as u16, start) {
        fragment = Some(spec[i + 1..limit].to_vec());
        limit = i;
    }
    let ctx_ref = if is_relative && start == limit { context.and_then(|c| c.fragment.clone()) } else { None };
    if !(is_relative && start == limit) && is_relative {
        // (A relative spec with words of its own: the query is the spec's, the context's is not inherited.)
        u.query = None;
    }
    u.fragment = fragment.or(ctx_ref);
    // URLStreamHandler.parseURL
    let mut query = u.query.clone();
    let mut path = u.path.clone();
    let mut authority = u.authority.clone();
    let mut query_only = false;
    if start < limit {
        let qs = index_of(&spec, b'?' as u16, 0);
        query_only = qs == Some(start);
        if let Some(q) = qs {
            if q < limit {
                query = Some(spec[q + 1..limit].to_vec());
                if limit > q {
                    limit = q;
                }
                spec.truncate(q);
            }
        }
    }
    let slash = b'/' as u16;
    let unc = start + 4 <= limit && spec[start..start + 4].iter().all(|&c| c == slash);
    if !unc && start + 2 <= limit && spec[start] == slash && spec[start + 1] == slash {
        start += 2;
        let i = match index_of(&spec, slash, start) {
            Some(i) if i <= limit => i,
            _ => match index_of(&spec, b'?' as u16, start) {
                Some(q) if q <= limit => q,
                _ => limit,
            },
        };
        let auth = spec[start..i].to_vec();
        let at = index_of(&auth, b'@' as u16, 0);
        let host: Option<Vec<u16>> = match at {
            Some(k) if Some(k) != last_index_of(&auth, b'@' as u16, auth.len()) => None,
            Some(k) => Some(auth[k + 1..].to_vec()),
            None => Some(auth.clone()),
        };
        if let Some(h) = host {
            if h.first() == Some(&(b'[' as u16)) {
                return Err("url: an IPv6 address is Java's".into());
            }
            if let Some(c) = index_of(&h, b':' as u16, 0) {
                if h.len() > c + 1 {
                    let port = j_parse(&h[c + 1..], 10, i32::MIN as i64, i32::MAX as i64).ok_or("url: a bad port")?;
                    if port < -1 {
                        return Err("url: a bad port".into());
                    }
                }
            }
        }
        start = i;
        if !auth.is_empty() {
            path = Some(Vec::new());
        }
        authority = Some(auth);
    }
    let mut is_rel_path = false;
    if start < limit {
        if spec[start] == slash {
            path = Some(spec[start..limit].to_vec());
        } else if path.as_ref().map(|p| !p.is_empty()).unwrap_or(false) {
            is_rel_path = true;
            let p = path.take().unwrap();
            let ind = p.iter().rposition(|&c| c == slash);
            let sep: &[u16] = if ind.is_none() && authority.is_some() { &[0x2F] } else { &[] };
            let keep = match ind {
                Some(i) => &p[..i + 1],
                None => &p[..0],
            };
            path = Some(cat(&[keep, sep, &spec[start..limit]]));
        } else {
            let p = spec[start..limit].to_vec();
            path = Some(if authority.is_some() { cat(&[&[0x2F], &p]) } else { p });
        }
    } else if query_only {
        if let Some(p) = &path {
            let ind = p.iter().rposition(|&c| c == slash).unwrap_or(0);
            path = Some(cat(&[&p[..ind], &[0x2F]]));
        }
    }
    let mut path = path.unwrap_or_default();
    if is_rel_path {
        let dot = u16s("/./");
        while let Some(i) = find(&path, &dot, 0) {
            path = cat(&[&path[..i], &path[i + 2..]]);
        }
        let dd = u16s("/../");
        let mut i = 0usize;
        while let Some(j) = find(&path, &dd, i) {
            i = j;
            let lim = if i > 0 { last_index_of(&path, slash, i - 1) } else { None };
            match lim {
                Some(l) if find(&path, &dd, l) != Some(0) => {
                    path = cat(&[&path[..l], &path[i + 3..]]);
                    i = 0;
                }
                _ => i += 3,
            }
        }
        let tail = u16s("/..");
        while path.ends_with(&tail) {
            let i = find(&path, &tail, 0).unwrap();
            match if i > 0 { last_index_of(&path, slash, i - 1) } else { None } {
                Some(l) => path.truncate(l + 1),
                None => break,
            }
        }
        if starts(&path, "./") && path.len() > 2 {
            path.drain(..2);
        }
        if path.ends_with(&u16s("/.")) {
            path.pop();
        }
    }
    u.authority = authority;
    u.path = Some(path);
    u.query = query;
    Ok(u)
}
/// `new URL(base, spec).toString()`.
pub fn resolve_str(base: &JUrl, spec: &[u16]) -> Result<Vec<u16>, String> {
    resolve(Some(base), spec).map(|u| u.to_units())
}

/* ---------- playlists ---------- */

/// KtHls.attr: a value of an attribute list (quoted values may hold commas); the name compared as
/// String.equalsIgnoreCase does for these ASCII names.
pub fn attr(attrs: &[u16], name: &str) -> Option<Vec<u16>> {
    let name: Vec<u16> = name.encode_utf16().collect();
    let n = attrs.len();
    let mut i = 0usize;
    while i < n {
        let eq = index_of(attrs, b'=' as u16, i)?;
        let k = j_trim(&attrs[i..eq]);
        let j = eq + 1;
        let v: Vec<u16>;
        if j < n && attrs[j] == b'"' as u16 {
            let e = index_of(attrs, b'"' as u16, j + 1).unwrap_or(n);
            v = attrs[j + 1..e].to_vec();
            i = e + 1;
        } else {
            let e = index_of(attrs, b',' as u16, j).unwrap_or(n);
            v = j_trim(&attrs[j..e]).to_vec();
            i = e;
        }
        if i < n && attrs[i] == b',' as u16 {
            i += 1;
        }
        if eq_ignore_case(k, &name) {
            return Some(v);
        }
    }
    None
}
/// String.equalsIgnoreCase against an ASCII name: a unit matches when its upper case, or the lower case of that, is
/// the name's letter in either case (so «ı», «ſ», «K» and «İ» match as Java lets them).
fn eq_ignore_case(k: &[u16], name: &[u16]) -> bool {
    k.len() == name.len()
        && k.iter().zip(name).all(|(&a, &b)| {
            let up = |c: u16| if (0x61..=0x7A).contains(&c) { c - 32 } else { c };
            let b = up(b);
            up(a) == b || (a == 0x131 && b == b'I' as u16) || (a == 0x17F && b == b'S' as u16) || (a == 0x212A && b == b'K' as u16) || (a == 0x130 && b == b'I' as u16)
        })
}
/// Java's split on «\r?\n»: lines, each later trimmed (a «\r» before the break goes with the trim).
fn lines(text: &[u16]) -> impl Iterator<Item = &[u16]> {
    text.split(|&u| u == 0x0A)
}
/// KtHls.numOf: Long.parseLong of the trimmed text, 0 when Java cannot read it.
fn num_of(s: Option<&[u16]>) -> i64 {
    s.and_then(|s| j_parse(j_trim(s), 10, i64::MIN, i64::MAX)).unwrap_or(0)
}
/// KtHls.heightOf: the number after the first «x» or «X» of «1920x1080», 0 when none or unreadable.
fn height_of(res: Option<&[u16]>) -> Result<i32, String> {
    let res = match res {
        None => return Ok(0),
        Some(r) => r,
    };
    if res.contains(&0x130) {
        return Err("hls: «İ» in a RESOLUTION (Java's lower case changes its length)".into());
    }
    match res.iter().position(|&u| u == b'x' as u16 || u == b'X' as u16) {
        None => Ok(0),
        Some(x) => Ok(j_parse(j_trim(&res[x + 1..]), 10, i32::MIN as i64, i32::MAX as i64).unwrap_or(0) as i32),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Variant {
    pub url: Vec<u16>,
    pub height: i32,
    pub bandwidth: i32,
    pub codecs: Option<Vec<u16>>,
}
/// KtHls.variants.
pub fn variants(text: &[u16], base: &JUrl) -> Result<Vec<Variant>, String> {
    let mut vs = Vec::new();
    let mut pending: Option<Vec<u16>> = None;
    for raw in lines(text) {
        let l = j_trim(raw);
        if l.is_empty() {
            continue;
        }
        if starts(l, "#EXT-X-STREAM-INF:") {
            pending = Some(l[18..].to_vec());
            continue;
        }
        if starts(l, "#") {
            continue;
        }
        if let Some(p) = pending.take() {
            vs.push(Variant { url: resolve_str(base, l)?, height: height_of(attr(&p, "RESOLUTION").as_deref())?, bandwidth: num_of(attr(&p, "BANDWIDTH").as_deref()) as i32, codecs: attr(&p, "CODECS") });
        }
    }
    Ok(vs)
}
/// KtHls.choose: the tallest at or under `want` (then the higher bandwidth), else the smallest; None for no variants.
pub fn choose(vs: &[(i32, i32)], want: i32) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (k, &(h, b)) in vs.iter().enumerate() {
        if want > 0 && h > 0 && h > want {
            continue;
        }
        match best {
            None => best = Some(k),
            Some(j) => {
                if h > vs[j].0 || (h == vs[j].0 && b > vs[j].1) {
                    best = Some(k)
                }
            }
        }
    }
    if best.is_none() {
        for (k, &(h, b)) in vs.iter().enumerate() {
            match best {
                None => best = Some(k),
                Some(j) => {
                    if h < vs[j].0 || (h == vs[j].0 && b > vs[j].1) {
                        best = Some(k)
                    }
                }
            }
        }
    }
    best
}

#[derive(Clone, Debug, PartialEq)]
pub struct Piece {
    pub url: Vec<u16>,
    pub key_url: Option<Vec<u16>>,
    pub iv: Option<[u8; 16]>,
    pub seq: i64,
    /// (offset, length)
    pub range: Option<(i64, i64)>,
}
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Playlist {
    pub pieces: Vec<Piece>,
    pub map: Option<Vec<u16>>,
    pub map_range: Option<(i64, i64)>,
    pub live: bool,
    pub seconds: f64,
}
/// KtHls.hex: an IV written in hex (0x optional), right-aligned into 16 bytes; Err where Integer.parseInt throws.
pub fn hex(s: &[u16]) -> Result<[u8; 16], String> {
    let mut s: Vec<u16> = if starts(s, "0x") || starts(s, "0X") { s[2..].to_vec() } else { s.to_vec() };
    if s.len() % 2 == 1 {
        s.insert(0, b'0' as u16);
    }
    let raw: Vec<u8> = s.chunks(2).map(|c| j_parse(c, 16, i32::MIN as i64, i32::MAX as i64).map(|v| v as u8).ok_or_else(|| "hls: a bad IV".to_string())).collect::<Result<_, _>>()?;
    let mut b = [0u8; 16];
    let take = raw.len().min(16);
    b[16 - take..].copy_from_slice(&raw[raw.len() - take..]);
    Ok(b)
}
/// KtHls.ivOf: the sequence number as a big-endian IV.
pub fn iv_of(seq: i64) -> [u8; 16] {
    let mut iv = [0u8; 16];
    iv[8..].copy_from_slice(&seq.to_be_bytes());
    iv
}
/// String.split("@") (trailing empty parts dropped, as Java).
fn split_at_sign(s: &[u16]) -> Vec<&[u16]> {
    let mut p: Vec<&[u16]> = s.split(|&u| u == b'@' as u16).collect();
    if s.is_empty() {
        return p;
    }
    while p.len() > 1 && p.last().map(|x| x.is_empty()).unwrap_or(false) {
        p.pop();
    }
    if p.len() == 1 && p[0].is_empty() && !s.is_empty() {
        p.clear();
    }
    p
}
/// KtHls.rangeOf: «length[@offset]», the offset after the previous piece's when not given.
fn range_of(s: &[u16], prev: Option<(i64, i64)>) -> Result<(i64, i64), String> {
    let p = split_at_sign(s);
    let first = p.first().ok_or("hls: a bad byte range")?;
    let len = j_parse(j_trim(first), 10, i64::MIN, i64::MAX).ok_or("hls: a bad byte range")?;
    let off = if p.len() > 1 {
        j_parse(j_trim(p[1]), 10, i64::MIN, i64::MAX).ok_or("hls: a bad byte range")?
    } else {
        prev.map(|(o, l)| o.wrapping_add(l)).unwrap_or(0)
    };
    Ok((off, len))
}
/// Double.parseDouble for what an EXTINF holds; Err (the whole answer left to Java) for a hexadecimal float, None
/// where Java throws (and KtHls ignores the line).
fn parse_double(s: &[u16]) -> Result<Option<f64>, String> {
    let t = String::from_utf16_lossy(j_trim(s));
    let mut b = t.as_str();
    if b.is_empty() {
        return Ok(None);
    }
    let body = b.trim_start_matches(['+', '-']);
    if b.len() - body.len() > 1 {
        return Ok(None);
    }
    if body == "NaN" || body == "Infinity" {
        return Ok(Some(b.parse::<f64>().unwrap_or(f64::NAN)));
    }
    if body.starts_with("0x") || body.starts_with("0X") {
        return Err("hls: a hexadecimal duration is Java's".into());
    }
    if b.ends_with(['f', 'F', 'd', 'D']) {
        b = &b[..b.len() - 1];
    }
    let digits = b.trim_start_matches(['+', '-']);
    let mut seen_digit = false;
    let mut seen_dot = false;
    let mut seen_e = false;
    let mut exp_digit = false;
    let cs: Vec<char> = digits.chars().collect();
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        if c.is_ascii_digit() {
            if seen_e {
                exp_digit = true
            } else {
                seen_digit = true
            }
        } else if c == '.' && !seen_dot && !seen_e {
            seen_dot = true;
        } else if (c == 'e' || c == 'E') && !seen_e && seen_digit {
            seen_e = true;
            if i + 1 < cs.len() && (cs[i + 1] == '+' || cs[i + 1] == '-') {
                i += 1;
            }
        } else {
            return Ok(None);
        }
        i += 1;
    }
    if !seen_digit || (seen_e && !exp_digit) {
        return Ok(None);
    }
    Ok(b.parse::<f64>().ok())
}
/// KtHls.media.
pub fn media(text: &[u16], base: &JUrl) -> Result<Playlist, String> {
    let mut pl = Playlist::default();
    let mut key_url: Option<Vec<u16>> = None;
    let mut iv: Option<[u8; 16]> = None;
    let mut seq: i64 = 0;
    let mut range: Option<(i64, i64)> = None;
    let mut last_range: Option<(i64, i64)> = None;
    let mut ended = false;
    let mut dur = 0.0f64;
    for raw in lines(text) {
        let l = j_trim(raw);
        if l.is_empty() {
            continue;
        }
        if starts(l, "#EXT-X-MEDIA-SEQUENCE:") {
            seq = num_of(Some(&l[22..]));
            continue;
        }
        if starts(l, "#EXT-X-ENDLIST") {
            ended = true;
            continue;
        }
        if starts(l, "#EXT-X-KEY:") {
            let a = &l[11..];
            let m = attr(a, "METHOD");
            match m.as_deref() {
                None => {
                    key_url = None;
                    iv = None;
                }
                Some(x) if is(x, "NONE") => {
                    key_url = None;
                    iv = None;
                }
                Some(x) if is(x, "AES-128") => {
                    let uri = attr(a, "URI").ok_or("hls: a key without its URI")?;
                    key_url = Some(resolve_str(base, &uri)?);
                    iv = match attr(a, "IV") {
                        None => None,
                        Some(v) => Some(hex(&v)?),
                    };
                }
                Some(x) => return Err(format!("drm:{}", String::from_utf16_lossy(x))),
            }
            continue;
        }
        if starts(l, "#EXT-X-MAP:") {
            let a = &l[11..];
            let uri = attr(a, "URI").ok_or("hls: a map without its URI")?;
            pl.map = Some(resolve_str(base, &uri)?);
            pl.map_range = match attr(a, "BYTERANGE") {
                None => None,
                Some(br) => Some(range_of(&br, None)?),
            };
            continue;
        }
        if starts(l, "#EXT-X-BYTERANGE:") {
            range = Some(range_of(&l[17..], last_range)?);
            continue;
        }
        if starts(l, "#EXTINF:") {
            let rest = &l[8..];
            // (split(",")[0]: a line of commas only has no first part — Java's exception, ignored.)
            let first = rest.split(|&u| u == b',' as u16).next().unwrap_or(&[]);
            let only_commas = !rest.is_empty() && rest.iter().all(|&u| u == b',' as u16);
            if !only_commas {
                if let Some(d) = parse_double(first)? {
                    dur = d;
                }
            }
            continue;
        }
        if starts(l, "#") {
            continue;
        }
        pl.pieces.push(Piece { url: resolve_str(base, l)?, key_url: key_url.clone(), iv, seq, range });
        pl.seconds += dur;
        dur = 0.0;
        seq = seq.wrapping_add(1);
        if range.is_some() {
            last_range = range;
        }
        range = None;
    }
    pl.live = !ended && pl.pieces.len() < 3;
    Ok(pl)
}
/// KtHls.looksLike: the path (before the first «?», if not at the start) ends «.m3u8» or «.m3u», any case.
pub fn looks_like(url: &[u16]) -> bool {
    let p: Vec<u16> = url.iter().map(|&u| j_lower_unit(u)).collect();
    let p = match index_of(&p, b'?' as u16, 0) {
        Some(q) if q > 0 => &p[..q],
        _ => &p[..],
    };
    p.ends_with(&u16s(".m3u8")) || p.ends_with(&u16s(".m3u"))
}
/// KtHls.uncover's offset: where the MPEG-TS bytes begin when something was glued before them (0: none to take off).
pub fn ts_start(d: &[u8]) -> usize {
    if d.len() >= 376 && d[0] == 0x47 && d[188] == 0x47 {
        return 0;
    }
    let mut i = 0;
    while i + 376 < d.len() && i < 1 << 20 {
        if d[i] == 0x47 && d[i + 188] == 0x47 && (i + 376 >= d.len() || d[i + 376] == 0x47) {
            return i;
        }
        i += 1;
    }
    0
}

/* ---------- the binary answers Java reads ---------- */

pub fn units_le(b: &[u8]) -> Result<Vec<u16>, String> {
    if b.len() % 2 != 0 {
        return Err("data: not UTF-16".into());
    }
    Ok(b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect())
}
fn put_i32(o: &mut Vec<u8>, v: i32) {
    o.extend_from_slice(&v.to_le_bytes());
}
fn put_i64(o: &mut Vec<u8>, v: i64) {
    o.extend_from_slice(&v.to_le_bytes());
}
fn put_str(o: &mut Vec<u8>, s: Option<&[u16]>) {
    match s {
        None => put_i32(o, -1),
        Some(s) => {
            put_i32(o, s.len() as i32);
            for u in s {
                o.extend_from_slice(&u.to_le_bytes());
            }
        }
    }
}
/// Variants: i32 count; each: url, codecs (-1: none), i32 height, i32 bandwidth.
pub fn write_variants(vs: &[Variant]) -> Vec<u8> {
    let mut o = Vec::new();
    put_i32(&mut o, vs.len() as i32);
    for v in vs {
        put_str(&mut o, Some(&v.url));
        put_str(&mut o, v.codecs.as_deref());
        put_i32(&mut o, v.height);
        put_i32(&mut o, v.bandwidth);
    }
    o
}
/// A playlist: i32 live, f64 seconds (bits), map (-1: none), i64 mapOff, i64 mapLen (-1/-1: none), i32 count; each
/// piece: url, keyUrl (-1: none), i32 hasIv + 16 bytes, i64 seq, i64 off, i64 len (-1/-1: none).
pub fn write_playlist(p: &Playlist) -> Vec<u8> {
    let mut o = Vec::with_capacity(64 + p.pieces.len() * 160);
    put_i32(&mut o, p.live as i32);
    put_i64(&mut o, p.seconds.to_bits() as i64);
    put_str(&mut o, p.map.as_deref());
    let (a, b) = p.map_range.unwrap_or((-1, -1));
    let has = p.map_range.is_some() as i32;
    put_i32(&mut o, has);
    put_i64(&mut o, a);
    put_i64(&mut o, b);
    put_i32(&mut o, p.pieces.len() as i32);
    for x in &p.pieces {
        put_str(&mut o, Some(&x.url));
        put_str(&mut o, x.key_url.as_deref());
        put_i32(&mut o, x.iv.is_some() as i32);
        o.extend_from_slice(&x.iv.unwrap_or([0; 16]));
        put_i64(&mut o, x.seq);
        put_i32(&mut o, x.range.is_some() as i32);
        let (a, b) = x.range.unwrap_or((0, 0));
        put_i64(&mut o, a);
        put_i64(&mut o, b);
    }
    o
}

/// The AUDIO group of each variant, in the order `variants` lists them (one per #EXT-X-STREAM-INF followed by its
/// address) — KtHls.audioGroups: the variant chosen is matched by its place, never by comparing addresses.
pub fn audio_groups(text: &[u16]) -> Vec<Option<Vec<u16>>> {
    let mut out = Vec::new();
    let mut pending: Option<Option<Vec<u16>>> = None;
    for raw in lines(text) {
        let l = j_trim(raw);
        if l.is_empty() {
            continue;
        }
        if starts(l, "#EXT-X-STREAM-INF:") {
            pending = Some(attr(&l[18..], "AUDIO"));
            continue;
        }
        if starts(l, "#") {
            continue;
        }
        if let Some(g) = pending.take() {
            out.push(g);
        }
    }
    out
}
/// KtHls.separateAudio: the variant's sound only in a rendition of its own — its AUDIO group has entries, and every
/// one of them names a playlist (URI). An entry without a URI means the sound is muxed in the variant itself.
pub fn separate_audio(text: &[u16], group: &[u16]) -> bool {
    let mut any = false;
    for raw in lines(text) {
        let l = j_trim(raw);
        if !starts(l, "#EXT-X-MEDIA:") {
            continue;
        }
        let a = &l[13..];
        let is_audio = attr(a, "TYPE").map(|t| t == "AUDIO".encode_utf16().collect::<Vec<u16>>()).unwrap_or(false);
        if !is_audio || attr(a, "GROUP-ID").as_deref() != Some(group) {
            continue;
        }
        if attr(a, "URI").is_none() {
            return false;
        }
        any = true;
    }
    any
}
/// KtHls.mapsIn: how many different init sections (EXT-X-MAP: URI with its BYTERANGE) a media playlist names.
pub fn maps_in(text: &[u16]) -> usize {
    let mut seen: Vec<(Option<Vec<u16>>, Option<Vec<u16>>)> = Vec::new();
    for raw in lines(text) {
        let l = j_trim(raw);
        if !starts(l, "#EXT-X-MAP:") {
            continue;
        }
        let k = (attr(&l[11..], "URI"), attr(&l[11..], "BYTERANGE"));
        if !seen.contains(&k) {
            seen.push(k);
        }
    }
    seen.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn s(x: &str) -> Vec<u16> {
        u16s(x)
    }
    fn url(x: &str) -> JUrl {
        resolve(None, &s(x)).unwrap()
    }
    fn r(base: &str, spec: &str) -> String {
        String::from_utf16(&resolve_str(&url(base), &s(spec)).unwrap()).unwrap()
    }

    #[test]
    fn audio_renditions() {
        let m = s("#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"ja\",URI=\"audio/ja.m3u8\"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"mux\",NAME=\"main\",DEFAULT=YES\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"mux\",NAME=\"dub\",URI=\"dub.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO=\"aud\"\nv720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nv1080.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3,AUDIO=\"mux\"\nv480.m3u8\n");
        let g = audio_groups(&m);
        assert_eq!(g.len(), 3);
        assert!(separate_audio(&m, g[0].as_ref().unwrap()));
        assert!(g[1].is_none());
        assert!(!separate_audio(&m, g[2].as_ref().unwrap()));
        assert_eq!(maps_in(&s("#EXT-X-MAP:URI=\"a.mp4\",BYTERANGE=\"720@0\"\np1\n#EXT-X-MAP:URI=\"a.mp4\",BYTERANGE=\"800@720\"\np2\n")), 2);
        assert_eq!(maps_in(&s("#EXT-X-MAP:URI=\"a.mp4\"\np1\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI=\"a.mp4\"\np2\n")), 1);
    }
    #[test]
    fn urls_as_java() {
        // (Each answer is java.net.URL's own — RustBridgeT asks Java the same and compares on the JVM.)
        let b = "http://h:8080/a/b/c.m3u8?tok=1#f";
        assert_eq!(r(b, "p.ts"), "http://h:8080/a/b/p.ts");
        assert_eq!(r(b, "../p.ts"), "http://h:8080/a/p.ts");
        assert_eq!(r(b, "../../../p.ts"), "http://h:8080/../p.ts");
        assert_eq!(r(b, "./x/./y/../p.ts?q"), "http://h:8080/a/b/x/p.ts?q");
        assert_eq!(r(b, "/root.ts"), "http://h:8080/root.ts");
        assert_eq!(r(b, "//cdn.example/x.ts"), "http://cdn.example/x.ts");
        assert_eq!(r(b, "https://o/x.ts"), "https://o/x.ts");
        assert_eq!(r(b, "HTTP:rel.ts"), "http://h:8080/a/b/rel.ts");
        assert_eq!(r(b, "?only"), "http://h:8080/a/b/?only");
        assert_eq!(r(b, ""), "http://h:8080/a/b/c.m3u8?tok=1#f");
        assert_eq!(r(b, "#g"), "http://h:8080/a/b/c.m3u8?tok=1#g");
        assert_eq!(r(b, "  url:p.ts  "), "http://h:8080/a/b/p.ts");
        assert_eq!(r(b, "x/.."), "http://h:8080/a/b/");
        assert_eq!(r(b, "."), "http://h:8080/a/b/");
        assert_eq!(r(b, "p q.ts"), "http://h:8080/a/b/p q.ts");
        assert_eq!(r("http://h", "p.ts"), "http://h/p.ts");
        assert_eq!(r("http://u@h/a", "p"), "http://u@h/p");
        assert!(resolve(Some(&url(b)), &s("ftp://x/y")).is_err());
        assert!(resolve(Some(&url(b)), &s("//h:bad/x")).is_err());
        assert!(resolve(None, &s("p.ts")).is_err());
        assert!(resolve(Some(&url(b)), &s("//[::1]/x")).is_err());
    }

    #[test]
    fn hlst_vectors() {
        let base = url("http://x/");
        let vs = variants(&s("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\na\n#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=640x360\nb\n#EXT-X-STREAM-INF:BANDWIDTH=3,RESOLUTION=1920x1080\nc\n"), &base).unwrap();
        let hb: Vec<(i32, i32)> = vs.iter().map(|v| (v.height, v.bandwidth)).collect();
        assert_eq!(vs[choose(&hb, 480).unwrap()].height, 360);
        assert_eq!(vs[choose(&hb, 0).unwrap()].height, 1080);
        assert_eq!(vs[choose(&hb, 240).unwrap()].height, 360);
        assert_eq!(choose(&[], 0), None);
        assert_eq!(attr(&s("BANDWIDTH=3,CODECS=\"avc1.64001f,mp4a.40.2\",RESOLUTION=1x2"), "CODECS"), Some(s("avc1.64001f,mp4a.40.2")));
        assert_eq!(attr(&s("BANDWIDTH=3,CODECS=\"a,b\",RESOLUTION=1x2"), "RESOLUTION"), Some(s("1x2")));
        assert_eq!(attr(&s("urı=\"k\""), "URI"), Some(s("k")));
        assert_eq!(attr(&s("NOEQUALS"), "URI"), None);
        assert!(media(&s("#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"k\"\n#EXTINF:4,\np\n"), &base).unwrap_err().starts_with("drm:"));
        assert!(media(&s("#EXTM3U\n#EXTINF:4,\np\n"), &base).unwrap().live);
        assert!(!media(&s("#EXTM3U\n#EXTINF:4,\np\n#EXT-X-ENDLIST\n"), &base).unwrap().live);
        // HlsT's media playlist.
        let text = "#EXTM3U\r\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-KEY:METHOD=AES-128,URI=\"../k.key\",IV=0x00000000000000000000000000000009\n#EXTINF:4.0,\np0.ts\n#EXT-X-KEY:METHOD=AES-128,URI=\"../k.key\"\n#EXTINF:4.0,\np1.ts\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4.0,\np2.jpg\n#EXTINF:4.0,\np3.ts\n#EXT-X-BYTERANGE:3948@0\n#EXTINF:4.0,\nbig.ts\n#EXT-X-BYTERANGE:4136\n#EXTINF:4.0,\nbig.ts\n#EXT-X-ENDLIST\n";
        let p = media(&s(text), &url("http://127.0.0.1:9/high/index.m3u8")).unwrap();
        assert_eq!(p.pieces.len(), 6);
        assert_eq!(String::from_utf16(p.pieces[0].key_url.as_ref().unwrap()).unwrap(), "http://127.0.0.1:9/k.key");
        let mut nine = [0u8; 16];
        nine[15] = 9;
        assert_eq!(p.pieces[0].iv, Some(nine));
        assert_eq!(p.pieces[1].iv, None);
        assert_eq!(p.pieces[1].seq, 6);
        assert_eq!(p.pieces[2].key_url, None);
        assert_eq!(p.pieces[4].range, Some((0, 3948)));
        assert_eq!(p.pieces[5].range, Some((3948, 4136)));
        assert_eq!(p.seconds, 24.0);
        assert!(!p.live);
        assert_eq!(String::from_utf16(&p.pieces[3].url).unwrap(), "http://127.0.0.1:9/high/p3.ts");
    }

    #[test]
    fn odd_lines_as_java() {
        let base = url("http://x/a/");
        assert_eq!(hex(&s("9")).unwrap()[15], 9);
        assert_eq!(hex(&s("0X0102")).unwrap()[14..], [1, 2]);
        assert_eq!(hex(&s("+f")).unwrap()[15], 15);
        assert_eq!(hex(&s("-1")).unwrap()[15], 0xFF);
        assert!(hex(&s("zz")).is_err());
        let long = hex(&s("00112233445566778899aabbccddeeff0102")).unwrap();
        assert_eq!(long[0], 0x22);
        assert_eq!(iv_of(0x0102), {
            let mut v = [0u8; 16];
            v[14] = 1;
            v[15] = 2;
            v
        });
        // A duration Java reads with a suffix, one it cannot read (kept from before), commas only.
        let p = media(&s("#EXTINF:2.5f,\np\n#EXTINF:abc\nq\n#EXTINF:1e1\nr\n#EXTINF:,,\nt\n#EXT-X-ENDLIST"), &base).unwrap();
        assert_eq!(p.seconds, 2.5 + 0.0 + 10.0 + 0.0);
        assert!(media(&s("#EXTINF:0x1p3,\np\n"), &base).is_err());
        assert_eq!(media(&s("#EXT-X-MEDIA-SEQUENCE: +7 \np\n"), &base).unwrap().pieces[0].seq, 7);
        assert_eq!(media(&s("#EXT-X-MEDIA-SEQUENCE:x\np\n"), &base).unwrap().pieces[0].seq, 0);
        assert!(media(&s("#EXT-X-BYTERANGE:@5\np\n"), &base).is_err());
        assert_eq!(media(&s("#EXT-X-BYTERANGE:10@20@30\np\n"), &base).unwrap().pieces[0].range, Some((20, 10)));
        assert_eq!(media(&s("#EXT-X-BYTERANGE:10@@\np\n"), &base).unwrap().pieces[0].range, Some((0, 10)));
        let m = media(&s("#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"720@0\"\np.m4s"), &base).unwrap();
        assert_eq!((String::from_utf16(m.map.as_ref().unwrap()).unwrap(), m.map_range), ("http://x/a/init.mp4".to_string(), Some((0, 720))));
        assert_eq!(variants(&s("#EXT-X-STREAM-INF:RESOLUTION=1x٧٢٠,BANDWIDTH=99999999999\nv"), &base).unwrap()[0].height, 720);
        assert_eq!(variants(&s("#EXT-X-STREAM-INF:BANDWIDTH=4294967297\nv"), &base).unwrap()[0].bandwidth, 1);
        assert!(variants(&s("#EXT-X-STREAM-INF:RESOLUTION=İx1\nv"), &base).is_err());
        assert!(looks_like(&s("http://h/A.M3U8?x=1")) && looks_like(&s("http://h/a.m3u")) && !looks_like(&s("http://h/a.mp4?u=.m3u8")));
        let mut d = vec![0u8; 300 + 188 * 4];
        for k in 0..4 {
            d[300 + 188 * k] = 0x47;
        }
        assert_eq!(ts_start(&d), 300);
        assert_eq!(ts_start(&d[300..]), 0);
        assert_eq!(ts_start(&[1, 2, 3]), 0);
    }

    #[test]
    fn binary_shapes() {
        let p = media(&s("#EXT-X-KEY:METHOD=AES-128,URI=\"k\",IV=0x1\n#EXT-X-BYTERANGE:4@2\np\n#EXT-X-ENDLIST"), &url("http://x/")).unwrap();
        let b = write_playlist(&p);
        assert_eq!(b.len(), 4 + 8 + 4 + 4 + 8 + 8 + 4 + (4 + 2 * 10) + (4 + 2 * 10) + 4 + 16 + 8 + 4 + 8 + 8);
        let v = write_variants(&[Variant { url: s("u"), height: 1, bandwidth: 2, codecs: None }]);
        assert_eq!(v.len(), 4 + 6 + 4 + 8);
        assert!(units_le(&[1]).is_err());
    }
}
