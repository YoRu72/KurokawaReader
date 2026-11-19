//! A strict JSON reader for scene files, std only: the whole text checked as UTF-8, JSON's grammar exactly, and hard
//! limits — size, nesting, number of values, string length, number text — so a hostile file costs little and never
//! panics: every failure is one of the `ERR_*` codes (negative, as the ABI returns them). Standalone:
//! `rustc --edition 2021 --test src/json.rs`.

/* ---------- limits and error codes ---------- */

/// A scene file's JSON text at most (bytes).
pub const MAX_JSON: usize = 256 * 1024;
/// Nesting at most.
pub const MAX_DEPTH: usize = 32;
/// Values in the whole file at most.
pub const MAX_NODES: usize = 20_000;
/// A string (bytes) at most.
pub const MAX_STR: usize = 4096;

/// The file is larger than MAX_JSON (or empty).
pub const ERR_SIZE: i32 = -1;
/// Not UTF-8.
pub const ERR_UTF8: i32 = -2;
/// Not JSON.
pub const ERR_SYNTAX: i32 = -3;
/// Nested deeper than MAX_DEPTH, more values than MAX_NODES, or a string longer than MAX_STR.
pub const ERR_DEPTH: i32 = -4;
/// Not a `ktscene/1` file.
pub const ERR_FORMAT: i32 = -5;
/// A known field of the wrong type.
pub const ERR_TYPE: i32 = -6;
/// A number that is not finite (1e999).
pub const ERR_NUMBER: i32 = -7;
/// More layers, emitters, roles, stages or particles than the caps.
pub const ERR_CAPS: i32 = -8;
/// A name that refers to nothing (an emitter's layer, a colour's role), or an id given twice.
pub const ERR_REF: i32 = -9;

/* ---------- JSON ---------- */

/// A JSON value. Objects keep their members in order; a repeated name: the last one counts (as JSON.parse).
#[derive(Clone, Debug, PartialEq)]
pub enum V {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<V>),
    Obj(Vec<(String, V)>),
}

impl V {
    pub fn get(&self, k: &str) -> Option<&V> {
        match self {
            V::Obj(m) => m.iter().rev().find(|(n, _)| n == k).map(|(_, v)| v),
            _ => None,
        }
    }
}

/// Parses a whole file (bytes): the size, UTF-8, the syntax, the depth and node limits.
pub fn parse(bytes: &[u8]) -> Result<V, i32> {
    if bytes.is_empty() || bytes.len() > MAX_JSON {
        return Err(ERR_SIZE);
    }
    let text = match core::str::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => return Err(ERR_UTF8),
    };
    let mut p = Parser { b: text.as_bytes(), i: 0, depth: 0, nodes: 0 };
    // (A byte-order mark is allowed in front.)
    if p.b.starts_with(&[0xEF, 0xBB, 0xBF]) {
        p.i = 3;
    }
    p.ws();
    let v = p.value()?;
    p.ws();
    if p.i != p.b.len() {
        return Err(ERR_SYNTAX);
    }
    Ok(v)
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
    depth: usize,
    nodes: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }
    fn ws(&mut self) {
        while let Some(c) = self.peek() {
            if matches!(c, b' ' | b'\t' | b'\n' | b'\r') {
                self.i += 1;
            } else {
                break;
            }
        }
    }
    fn lit(&mut self, w: &[u8], v: V) -> Result<V, i32> {
        if self.b.len() >= self.i + w.len() && &self.b[self.i..self.i + w.len()] == w {
            self.i += w.len();
            Ok(v)
        } else {
            Err(ERR_SYNTAX)
        }
    }
    fn value(&mut self) -> Result<V, i32> {
        self.nodes += 1;
        if self.nodes > MAX_NODES {
            return Err(ERR_DEPTH);
        }
        match self.peek() {
            None => Err(ERR_SYNTAX),
            Some(b'n') => self.lit(b"null", V::Null),
            Some(b't') => self.lit(b"true", V::Bool(true)),
            Some(b'f') => self.lit(b"false", V::Bool(false)),
            Some(b'"') => self.string().map(V::Str),
            Some(b'[') => {
                self.enter()?;
                let mut a = Vec::new();
                self.ws();
                if self.peek() == Some(b']') {
                    self.i += 1;
                } else {
                    loop {
                        self.ws();
                        a.push(self.value()?);
                        self.ws();
                        match self.peek() {
                            Some(b',') => self.i += 1,
                            Some(b']') => {
                                self.i += 1;
                                break;
                            }
                            _ => return Err(ERR_SYNTAX),
                        }
                    }
                }
                self.depth -= 1;
                Ok(V::Arr(a))
            }
            Some(b'{') => {
                self.enter()?;
                let mut o = Vec::new();
                self.ws();
                if self.peek() == Some(b'}') {
                    self.i += 1;
                } else {
                    loop {
                        self.ws();
                        if self.peek() != Some(b'"') {
                            return Err(ERR_SYNTAX);
                        }
                        let k = self.string()?;
                        self.ws();
                        if self.peek() != Some(b':') {
                            return Err(ERR_SYNTAX);
                        }
                        self.i += 1;
                        self.ws();
                        let v = self.value()?;
                        o.push((k, v));
                        self.ws();
                        match self.peek() {
                            Some(b',') => self.i += 1,
                            Some(b'}') => {
                                self.i += 1;
                                break;
                            }
                            _ => return Err(ERR_SYNTAX),
                        }
                    }
                }
                self.depth -= 1;
                Ok(V::Obj(o))
            }
            Some(c) if c == b'-' || c.is_ascii_digit() => self.number(),
            _ => Err(ERR_SYNTAX),
        }
    }
    fn enter(&mut self) -> Result<(), i32> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(ERR_DEPTH);
        }
        self.i += 1;
        Ok(())
    }
    /// JSON's number grammar exactly; then the text read as f64 (an overflow to infinity is refused).
    fn number(&mut self) -> Result<V, i32> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        match self.peek() {
            Some(b'0') => self.i += 1,
            Some(c) if c.is_ascii_digit() => {
                while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                    self.i += 1;
                }
            }
            _ => return Err(ERR_SYNTAX),
        }
        if self.peek() == Some(b'.') {
            self.i += 1;
            let d = self.i;
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.i += 1;
            }
            if self.i == d {
                return Err(ERR_SYNTAX);
            }
        }
        if matches!(self.peek(), Some(b'e') | Some(b'E')) {
            self.i += 1;
            if matches!(self.peek(), Some(b'+') | Some(b'-')) {
                self.i += 1;
            }
            let d = self.i;
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.i += 1;
            }
            if self.i == d {
                return Err(ERR_SYNTAX);
            }
        }
        if self.i - start > 64 {
            return Err(ERR_NUMBER);
        }
        // (The slice is ASCII digits and signs only: valid UTF-8.)
        let s = core::str::from_utf8(&self.b[start..self.i]).map_err(|_| ERR_SYNTAX)?;
        match s.parse::<f64>() {
            Ok(n) if n.is_finite() => Ok(V::Num(n)),
            Ok(_) => Err(ERR_NUMBER),
            Err(_) => Err(ERR_SYNTAX),
        }
    }
    fn hex4(&mut self) -> Result<u32, i32> {
        if self.i + 4 > self.b.len() {
            return Err(ERR_SYNTAX);
        }
        let mut v = 0u32;
        for k in 0..4 {
            let c = self.b[self.i + k];
            let d = match c {
                b'0'..=b'9' => c - b'0',
                b'a'..=b'f' => c - b'a' + 10,
                b'A'..=b'F' => c - b'A' + 10,
                _ => return Err(ERR_SYNTAX),
            };
            v = v * 16 + d as u32;
        }
        self.i += 4;
        Ok(v)
    }
    fn string(&mut self) -> Result<String, i32> {
        self.i += 1; // the opening quote
        let mut out = String::new();
        loop {
            if out.len() > MAX_STR {
                return Err(ERR_DEPTH);
            }
            let c = match self.peek() {
                None => return Err(ERR_SYNTAX),
                Some(c) => c,
            };
            match c {
                b'"' => {
                    self.i += 1;
                    return Ok(out);
                }
                b'\\' => {
                    self.i += 1;
                    let e = self.peek().ok_or(ERR_SYNTAX)?;
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let cp = if (0xD800..0xDC00).contains(&hi) {
                                // (A high surrogate must be followed by a low one.)
                                if self.peek() != Some(b'\\') || self.b.get(self.i + 1) != Some(&b'u') {
                                    return Err(ERR_SYNTAX);
                                }
                                self.i += 2;
                                let lo = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&lo) {
                                    return Err(ERR_SYNTAX);
                                }
                                0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                            } else if (0xDC00..0xE000).contains(&hi) {
                                return Err(ERR_SYNTAX);
                            } else {
                                hi
                            };
                            out.push(char::from_u32(cp).ok_or(ERR_SYNTAX)?);
                        }
                        _ => return Err(ERR_SYNTAX),
                    }
                }
                c if c < 0x20 => return Err(ERR_SYNTAX),
                _ => {
                    // (One whole UTF-8 character: the text was checked, so its length comes from the lead byte.)
                    let n = if c < 0x80 { 1 } else if c >= 0xF0 { 4 } else if c >= 0xE0 { 3 } else { 2 };
                    let end = (self.i + n).min(self.b.len());
                    match core::str::from_utf8(&self.b[self.i..end]) {
                        Ok(s) => out.push_str(s),
                        Err(_) => return Err(ERR_UTF8),
                    }
                    self.i = end;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_basics() {
        assert_eq!(parse(b" {\"a\": [1, -2.5e1, true, null, \"x\\u00e9\\ud83d\\ude00\"]} "), Ok(V::Obj(vec![("a".into(), V::Arr(vec![V::Num(1.0), V::Num(-25.0), V::Bool(true), V::Null, V::Str("xé😀".into())]))])));
        assert_eq!(parse(b"\xEF\xBB\xBF[]"), Ok(V::Arr(vec![])));
        for bad in [&b"[1,]"[..], b"{\"a\" 1}", b"01", b"1.", b"-", b"[1 2]", b"\"\\x\"", b"\"\x01\"", b"tru", b"{}x", b"\"\\ud800\"", b"\"\\udc00\""] {
            assert!(parse(bad).is_err(), "{:?}", core::str::from_utf8(bad));
        }
        assert_eq!(parse(b""), Err(ERR_SIZE));
        assert_eq!(parse(b"[1e999]"), Err(ERR_NUMBER));
        assert_eq!(parse(b"\"\xff\""), Err(ERR_UTF8));
    }

    #[test]
    fn hostile_nesting_and_sizes() {
        let deep = "[".repeat(10_000) + &"]".repeat(10_000);
        assert_eq!(parse(deep.as_bytes()), Err(ERR_DEPTH));
        let deep_obj = "{\"a\":".repeat(5000) + "1" + &"}".repeat(5000);
        assert_eq!(parse(deep_obj.as_bytes()), Err(ERR_DEPTH));
        let wide = "[".to_string() + &"0,".repeat(30_000) + "0]";
        assert_eq!(parse(wide.as_bytes()), Err(ERR_DEPTH));
        let big = vec![b' '; MAX_JSON + 1];
        assert_eq!(parse(&big), Err(ERR_SIZE));
        let long = "\"".to_string() + &"a".repeat(MAX_STR + 10) + "\"";
        assert_eq!(parse(long.as_bytes()), Err(ERR_DEPTH));
        let longnum = "1".repeat(80);
        assert_eq!(parse(longnum.as_bytes()), Err(ERR_NUMBER));
    }
}
