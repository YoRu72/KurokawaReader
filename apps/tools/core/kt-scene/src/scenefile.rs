//! Scene files, `ktscene/1` (the subset this version reads): a strict JSON reader with hard limits, and the validator
//! that turns a file into a `SceneDef` — every number clamped to its range, NaN and infinities refused, the caps of
//! the design record held, fields it does not know ignored, kinds it does not know kept by name and skipped. It never
//! panics, whatever the bytes: a bad file gives one of the `ERR_*` codes (negative, as the ABI returns them).
//! Standalone: `rustc --edition 2021 --test src/scenefile.rs`.
//!
//! The shape (every field optional unless marked):
//! ```text
//! { "format": "ktscene/1",                      (required)
//!   "meta":    { "id": "motes", "name": "Motes" },
//!   "view":    { "fps": 24, "resolution": 0.5 },  (hints for the page: frames a second 10–30, canvas scale 0.25–1)
//!   "palette": { "roles": ["primary-container", "tertiary-container", "primary"] },  (theme roles, 1–8; the page
//!                                                  gives their colours — a scene never names a colour of its own)
//!   "layers":  [ { "id": "far", "depth": 0.2, "opacity": 0.6 } ],   (1–32; depth 0 far … 1 near)
//!   "emitters": [ {                                                  (0–16)
//!       "layer": "far",                      (required: a layer's id)
//!       "max": 360,                          (1–2048 particles; the scene's sum at most 4096)
//!       "rate": 26,                          (particles a second, 0–4096)
//!       "prewarm": 1,                        (0–1: that share of max placed at the start, at random ages)
//!       "shape": { "kind": "rect", "x": 0, "y": 0, "w": 1, "h": 1 },   (a share of the viewport)
//!       "initializers": [ { "kind": "lifetime" | "size" | "alpha" | "rotation" | "spin", "min": a, "max": b },
//!                         { "kind": "velocity", "min": [x, y], "max": [x, y] },
//!                         { "kind": "colour", "roles": ["primary", …] },   (names from palette.roles)
//!                         { "kind": "sprite", "id": 0 } ],
//!       "operators":    [ { "kind": "drift", "scale": 0.004, "speed": 0.05, "strength": 8 },
//!                         { "kind": "gravity", "x": 0, "y": -1 }, { "kind": "drag", "k": 0.4 },
//!                         { "kind": "bounds", "mode": "wrap" | "kill", "margin": 16 },
//!                         { "kind": "fade", "in": 0.2, "out": 0.3 } ] } ] }
//! ```

/* ---------- limits and error codes ---------- */

/// A scene file's JSON text at most (bytes).
pub const MAX_JSON: usize = 256 * 1024;
/// Nesting at most.
pub const MAX_DEPTH: usize = 32;
/// Values in the whole file at most.
pub const MAX_NODES: usize = 20_000;
/// A string (bytes) at most.
pub const MAX_STR: usize = 4096;
pub const MAX_LAYERS: usize = 32;
pub const MAX_EMITTERS: usize = 16;
pub const MAX_PER_EMITTER: u32 = 2048;
pub const MAX_TOTAL: u32 = 4096;
pub const MAX_ROLES: usize = 8;
/// Initializers and operators of one emitter, each at most.
pub const MAX_STAGES: usize = 32;

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

/* ---------- the scene ---------- */

#[derive(Clone, Debug, PartialEq)]
pub struct SceneDef {
    pub id: String,
    pub name: String,
    /// Frames a second the page should draw (a hint, 10–30).
    pub fps: f32,
    /// The canvas's scale against the window's CSS pixels (a hint, 0.25–1).
    pub resolution: f32,
    /// Theme roles, by name: the colour indices of the instances.
    pub roles: Vec<String>,
    pub layers: Vec<LayerDef>,
    pub emitters: Vec<EmitterDef>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LayerDef {
    pub id: String,
    /// 0 far … 1 near (drawn far first; later: parallax).
    pub depth: f32,
    pub opacity: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EmitterDef {
    pub layer: usize,
    pub max: u32,
    pub rate: f32,
    pub prewarm: f32,
    pub shape: Shape,
    pub inits: Vec<Init>,
    pub ops: Vec<Op>,
}

/// Where particles are born: a rectangle as a share of the viewport.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shape {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// What a particle is born with (applied in order; later ones win).
#[derive(Clone, Debug, PartialEq)]
pub enum Init {
    /// Seconds.
    Lifetime { min: f32, max: f32 },
    /// Diameter, CSS pixels.
    Size { min: f32, max: f32 },
    Alpha { min: f32, max: f32 },
    /// Radians (no trigonometry here: the page turns the sprite).
    Rotation { min: f32, max: f32 },
    /// Radians a second.
    Spin { min: f32, max: f32 },
    /// Pixels a second.
    Velocity { min: [f32; 2], max: [f32; 2] },
    /// Indices into the palette's roles, one picked at random.
    Colour { roles: Vec<u8> },
    Sprite { id: u8 },
    /// A kind this version does not know: kept by name, skipped.
    Unknown(String),
}

/// What happens to a particle each step.
#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    /// Smooth noise pushing it around: `scale` per pixel, `speed` per second (time), `strength` pixels/s².
    Drift { scale: f32, speed: f32, strength: f32 },
    Gravity { x: f32, y: f32 },
    /// Velocity lost a second (share).
    Drag { k: f32 },
    /// Off the viewport by more than `margin`: back in on the other side (wrap) or gone (kill).
    Bounds { wrap: bool, margin: f32 },
    /// Alpha rising over the first `fin` of life, falling over the last `fout` (shares).
    Fade { fin: f32, fout: f32 },
    Unknown(String),
}

/* ---------- reading fields ---------- */

fn obj(v: Option<&V>) -> Result<Option<&V>, i32> {
    match v {
        None | Some(V::Null) => Ok(None),
        Some(o @ V::Obj(_)) => Ok(Some(o)),
        Some(_) => Err(ERR_TYPE),
    }
}

fn arr(v: Option<&V>) -> Result<&[V], i32> {
    match v {
        None | Some(V::Null) => Ok(&[]),
        Some(V::Arr(a)) => Ok(a),
        Some(_) => Err(ERR_TYPE),
    }
}

/// A number field, clamped to [lo, hi]; absent: `def`.
fn num(o: &V, k: &str, def: f32, lo: f32, hi: f32) -> Result<f32, i32> {
    match o.get(k) {
        None | Some(V::Null) => Ok(def),
        Some(V::Num(n)) => {
            let n = *n;
            // (f64 → f32 after clamping, so 1e300 is hi, never infinity.)
            let c = if n < lo as f64 { lo } else if n > hi as f64 { hi } else { n as f32 };
            Ok(c)
        }
        Some(_) => Err(ERR_TYPE),
    }
}

fn text<'a>(o: &'a V, k: &str) -> Result<Option<&'a str>, i32> {
    match o.get(k) {
        None | Some(V::Null) => Ok(None),
        Some(V::Str(s)) => Ok(Some(s)),
        Some(_) => Err(ERR_TYPE),
    }
}

/// A pair [x, y] clamped, or a single number used for both.
fn pair(o: &V, k: &str, def: [f32; 2], lo: f32, hi: f32) -> Result<[f32; 2], i32> {
    let one = |v: &V| -> Result<f32, i32> {
        match v {
            V::Num(n) => Ok(if *n < lo as f64 { lo } else if *n > hi as f64 { hi } else { *n as f32 }),
            _ => Err(ERR_TYPE),
        }
    };
    match o.get(k) {
        None | Some(V::Null) => Ok(def),
        Some(V::Arr(a)) if a.len() == 2 => Ok([one(&a[0])?, one(&a[1])?]),
        Some(n @ V::Num(_)) => {
            let x = one(n)?;
            Ok([x, x])
        }
        Some(_) => Err(ERR_TYPE),
    }
}

/// A min/max pair, put in order.
fn span(o: &V, def: (f32, f32), lo: f32, hi: f32) -> Result<(f32, f32), i32> {
    let a = num(o, "min", def.0, lo, hi)?;
    let b = num(o, "max", def.1, lo, hi)?;
    Ok(if a <= b { (a, b) } else { (b, a) })
}

/// An id or a role name: 1–64 bytes of [a-z0-9_-].
fn name_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_')
}

/* ---------- the validator ---------- */

/// A scene file read and checked.
pub fn read(bytes: &[u8]) -> Result<SceneDef, i32> {
    let root = parse(bytes)?;
    if !matches!(root, V::Obj(_)) {
        return Err(ERR_FORMAT);
    }
    match root.get("format") {
        Some(V::Str(s)) if s == "ktscene/1" => {}
        _ => return Err(ERR_FORMAT),
    }
    let (mut id, mut name) = (String::new(), String::new());
    if let Some(m) = obj(root.get("meta"))? {
        if let Some(s) = text(m, "id")? {
            if name_ok(s) {
                id = s.to_string();
            }
        }
        if let Some(s) = text(m, "name")? {
            name = s.chars().take(80).collect();
        }
    }
    let (mut fps, mut resolution) = (24.0, 0.5);
    if let Some(v) = obj(root.get("view"))? {
        fps = num(v, "fps", 24.0, 10.0, 30.0)?;
        resolution = num(v, "resolution", 0.5, 0.25, 1.0)?;
    }
    let mut roles: Vec<String> = Vec::new();
    if let Some(p) = obj(root.get("palette"))? {
        let list = arr(p.get("roles"))?;
        if list.len() > MAX_ROLES {
            return Err(ERR_CAPS);
        }
        for r in list {
            match r {
                V::Str(s) if name_ok(s) => {
                    if roles.iter().any(|x| x == s) {
                        return Err(ERR_REF);
                    }
                    roles.push(s.clone());
                }
                V::Str(_) => return Err(ERR_REF),
                _ => return Err(ERR_TYPE),
            }
        }
    }
    if roles.is_empty() {
        roles.push("primary".to_string());
    }

    let mut layers: Vec<LayerDef> = Vec::new();
    let ls = arr(root.get("layers"))?;
    if ls.len() > MAX_LAYERS {
        return Err(ERR_CAPS);
    }
    for l in ls {
        if !matches!(l, V::Obj(_)) {
            return Err(ERR_TYPE);
        }
        let lid = match text(l, "id")? {
            Some(s) if name_ok(s) => s.to_string(),
            Some(_) => return Err(ERR_REF),
            None => {
                // (An unnamed layer is called by its place: "0", "1"…)
                let mut s = String::new();
                push_index(&mut s, layers.len());
                s
            }
        };
        if layers.iter().any(|x| x.id == lid) {
            return Err(ERR_REF);
        }
        layers.push(LayerDef { id: lid, depth: num(l, "depth", 0.5, 0.0, 1.0)?, opacity: num(l, "opacity", 1.0, 0.0, 1.0)? });
    }
    if layers.is_empty() {
        layers.push(LayerDef { id: "0".to_string(), depth: 0.5, opacity: 1.0 });
    }

    let es = arr(root.get("emitters"))?;
    if es.len() > MAX_EMITTERS {
        return Err(ERR_CAPS);
    }
    let mut emitters = Vec::new();
    let mut total: u32 = 0;
    for e in es {
        if !matches!(e, V::Obj(_)) {
            return Err(ERR_TYPE);
        }
        let layer = match text(e, "layer")? {
            Some(s) => layers.iter().position(|l| l.id == s).ok_or(ERR_REF)?,
            None if layers.len() == 1 => 0,
            None => return Err(ERR_REF),
        };
        let max = num(e, "max", 256.0, 1.0, MAX_PER_EMITTER as f32)? as u32;
        total += max;
        if total > MAX_TOTAL {
            return Err(ERR_CAPS);
        }
        let rate = num(e, "rate", 16.0, 0.0, 4096.0)?;
        let prewarm = num(e, "prewarm", 1.0, 0.0, 1.0)?;
        let mut shape = Shape { x: 0.0, y: 0.0, w: 1.0, h: 1.0 };
        if let Some(s) = obj(e.get("shape"))? {
            match text(s, "kind")? {
                None | Some("rect") => {
                    shape = Shape { x: num(s, "x", 0.0, -1.0, 2.0)?, y: num(s, "y", 0.0, -1.0, 2.0)?, w: num(s, "w", 1.0, 0.0, 3.0)?, h: num(s, "h", 1.0, 0.0, 3.0)? };
                }
                // (A shape this version does not know: the whole viewport.)
                Some(_) => {}
            }
        }
        let inits_v = arr(e.get("initializers"))?;
        let ops_v = arr(e.get("operators"))?;
        if inits_v.len() > MAX_STAGES || ops_v.len() > MAX_STAGES {
            return Err(ERR_CAPS);
        }
        let mut inits = Vec::with_capacity(inits_v.len());
        for i in inits_v {
            inits.push(read_init(i, &roles)?);
        }
        let mut ops = Vec::with_capacity(ops_v.len());
        for o in ops_v {
            ops.push(read_op(o)?);
        }
        emitters.push(EmitterDef { layer, max, rate, prewarm, shape, inits, ops });
    }
    Ok(SceneDef { id, name, fps, resolution, roles, layers, emitters })
}

fn push_index(s: &mut String, mut n: usize) {
    let mut digits = [0u8; 20];
    let mut k = 0;
    loop {
        digits[k] = b'0' + (n % 10) as u8;
        k += 1;
        n /= 10;
        if n == 0 || k == digits.len() {
            break;
        }
    }
    while k > 0 {
        k -= 1;
        s.push(digits[k] as char);
    }
}

fn kind_of(v: &V) -> Result<&str, i32> {
    if !matches!(v, V::Obj(_)) {
        return Err(ERR_TYPE);
    }
    match text(v, "kind")? {
        Some(k) => Ok(k),
        None => Err(ERR_TYPE),
    }
}

fn unknown(k: &str) -> String {
    k.chars().take(64).collect()
}

fn read_init(v: &V, roles: &[String]) -> Result<Init, i32> {
    let k = kind_of(v)?;
    Ok(match k {
        "lifetime" => {
            let (a, b) = span(v, (4.0, 8.0), 0.05, 600.0)?;
            Init::Lifetime { min: a, max: b }
        }
        "size" => {
            let (a, b) = span(v, (2.0, 4.0), 0.0, 256.0)?;
            Init::Size { min: a, max: b }
        }
        "alpha" => {
            let (a, b) = span(v, (1.0, 1.0), 0.0, 1.0)?;
            Init::Alpha { min: a, max: b }
        }
        "rotation" => {
            let (a, b) = span(v, (0.0, 0.0), -64.0, 64.0)?;
            Init::Rotation { min: a, max: b }
        }
        "spin" => {
            let (a, b) = span(v, (0.0, 0.0), -64.0, 64.0)?;
            Init::Spin { min: a, max: b }
        }
        "velocity" => {
            let a = pair(v, "min", [0.0, 0.0], -4096.0, 4096.0)?;
            let b = pair(v, "max", [0.0, 0.0], -4096.0, 4096.0)?;
            Init::Velocity { min: [a[0].min(b[0]), a[1].min(b[1])], max: [a[0].max(b[0]), a[1].max(b[1])] }
        }
        "colour" | "color" => {
            let list = arr(v.get("roles"))?;
            if list.len() > MAX_ROLES {
                return Err(ERR_CAPS);
            }
            let mut out = Vec::with_capacity(list.len());
            for r in list {
                match r {
                    V::Str(s) => out.push(roles.iter().position(|x| x == s).ok_or(ERR_REF)? as u8),
                    V::Num(n) if *n >= 0.0 && (*n as usize) < roles.len() && n.fract() == 0.0 => out.push(*n as u8),
                    V::Num(_) => return Err(ERR_REF),
                    _ => return Err(ERR_TYPE),
                }
            }
            if out.is_empty() {
                out.push(0);
            }
            Init::Colour { roles: out }
        }
        "sprite" => Init::Sprite { id: num(v, "id", 0.0, 0.0, 15.0)? as u8 },
        other => Init::Unknown(unknown(other)),
    })
}

fn read_op(v: &V) -> Result<Op, i32> {
    let k = kind_of(v)?;
    Ok(match k {
        "drift" => Op::Drift { scale: num(v, "scale", 0.004, 0.0, 1.0)?, speed: num(v, "speed", 0.05, 0.0, 10.0)?, strength: num(v, "strength", 8.0, 0.0, 2048.0)? },
        "gravity" => Op::Gravity { x: num(v, "x", 0.0, -4096.0, 4096.0)?, y: num(v, "y", 0.0, -4096.0, 4096.0)? },
        "drag" => Op::Drag { k: num(v, "k", 0.5, 0.0, 60.0)? },
        "bounds" => {
            let wrap = match text(v, "mode")? {
                None | Some("wrap") => true,
                Some("kill") => false,
                Some(_) => true,
            };
            Op::Bounds { wrap, margin: num(v, "margin", 16.0, 0.0, 512.0)? }
        }
        "fade" => Op::Fade { fin: num(v, "in", 0.2, 0.0, 1.0)?, fout: num(v, "out", 0.2, 0.0, 1.0)? },
        other => Op::Unknown(unknown(other)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MOTES: &str = include_str!("../../../src/theme/scenes/motes.json");

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

    #[test]
    fn motes_reads() {
        let d = read(MOTES.as_bytes()).expect("motes.json");
        assert_eq!(d.id, "motes");
        assert_eq!(d.layers.len(), 3);
        assert!(d.emitters.len() >= 3);
        assert!(d.emitters.iter().map(|e| e.max).sum::<u32>() <= MAX_TOTAL);
        assert!(d.emitters.iter().all(|e| e.inits.iter().all(|i| !matches!(i, Init::Unknown(_))) && e.ops.iter().all(|o| !matches!(o, Op::Unknown(_)))));
        // (No fixed colours: the palette names theme roles.)
        assert!(!MOTES.contains('#') && !MOTES.contains("rgb"));
        assert!(d.roles.iter().all(|r| !r.contains("yellow") && !r.contains("amber") && !r.contains("gold")));
    }

    fn scene(emitters: &str) -> String {
        format!("{{\"format\":\"ktscene/1\",\"palette\":{{\"roles\":[\"primary\",\"tertiary\"]}},\"layers\":[{{\"id\":\"a\"}},{{\"id\":\"b\",\"depth\":9}}],\"emitters\":[{}]}}", emitters)
    }

    #[test]
    fn clamps_and_defaults() {
        let d = read(scene("{\"layer\":\"b\",\"max\":1e300,\"rate\":-5,\"prewarm\":7,\"future\":{\"x\":1},\"initializers\":[{\"kind\":\"size\",\"min\":900,\"max\":-3},{\"kind\":\"colour\",\"roles\":[\"tertiary\",0]},{\"kind\":\"sparkle\",\"n\":3}],\"operators\":[{\"kind\":\"drag\",\"k\":1e308},{\"kind\":\"bounds\",\"mode\":\"bounce\"},{\"kind\":\"vortex\"}]}").as_bytes()).unwrap();
        assert_eq!(d.layers[1].depth, 1.0);
        let e = &d.emitters[0];
        assert_eq!((e.layer, e.max, e.rate, e.prewarm), (1, MAX_PER_EMITTER, 0.0, 1.0));
        assert_eq!(e.inits[0], Init::Size { min: 0.0, max: 256.0 });
        assert_eq!(e.inits[1], Init::Colour { roles: vec![1, 0] });
        assert_eq!(e.inits[2], Init::Unknown("sparkle".into()));
        assert_eq!(e.ops[0], Op::Drag { k: 60.0 });
        assert_eq!(e.ops[1], Op::Bounds { wrap: true, margin: 16.0 });
        assert_eq!(e.ops[2], Op::Unknown("vortex".into()));
        let min = read(b"{\"format\":\"ktscene/1\"}").unwrap();
        assert_eq!((min.layers.len(), min.emitters.len(), min.roles.len()), (1, 0, 1));
    }

    #[test]
    fn refusals() {
        assert_eq!(read(b"[]"), Err(ERR_FORMAT));
        assert_eq!(read(b"{\"format\":\"ktscene/2\"}"), Err(ERR_FORMAT));
        assert_eq!(read(b"{\"format\":1}"), Err(ERR_FORMAT));
        assert_eq!(read(scene("{\"layer\":\"zz\"}").as_bytes()), Err(ERR_REF));
        assert_eq!(read(scene("{\"layer\":\"a\",\"max\":\"lots\"}").as_bytes()), Err(ERR_TYPE));
        assert_eq!(read(scene("{\"layer\":\"a\",\"initializers\":{}}").as_bytes()), Err(ERR_TYPE));
        assert_eq!(read(scene("{\"layer\":\"a\",\"initializers\":[{\"min\":1}]}").as_bytes()), Err(ERR_TYPE));
        assert_eq!(read(scene("{\"layer\":\"a\",\"initializers\":[{\"kind\":\"colour\",\"roles\":[\"nope\"]}]}").as_bytes()), Err(ERR_REF));
        assert_eq!(read(scene("{\"layer\":\"a\",\"initializers\":[{\"kind\":\"colour\",\"roles\":[5]}]}").as_bytes()), Err(ERR_REF));
        assert_eq!(read(scene("{\"layer\":\"a\",\"initializers\":[{\"kind\":\"velocity\",\"min\":[1,2,3]}]}").as_bytes()), Err(ERR_TYPE));
        assert_eq!(read(scene("5").as_bytes()), Err(ERR_TYPE));
        let three = (0..3).map(|_| "{\"layer\":\"a\",\"max\":2000}").collect::<Vec<_>>().join(",");
        assert_eq!(read(scene(&three).as_bytes()), Err(ERR_CAPS));
        let many = (0..17).map(|_| "{\"layer\":\"a\",\"max\":1}").collect::<Vec<_>>().join(",");
        assert_eq!(read(scene(&many).as_bytes()), Err(ERR_CAPS));
        assert_eq!(read(b"{\"format\":\"ktscene/1\",\"layers\":[{\"id\":\"a\"},{\"id\":\"a\"}]}"), Err(ERR_REF));
        assert_eq!(read(b"{\"format\":\"ktscene/1\",\"layers\":[{\"id\":\"Bad Id\"}]}"), Err(ERR_REF));
        assert_eq!(read(b"{\"format\":\"ktscene/1\",\"palette\":{\"roles\":[\"a\",\"b\",\"c\",\"d\",\"e\",\"f\",\"g\",\"h\",\"i\"]}}"), Err(ERR_CAPS));
        assert_eq!(read(b"{\"format\":\"ktscene/1\",\"view\":[]}"), Err(ERR_TYPE));
        // (Two layers and no layer named: which one is meant is unknown.)
        assert_eq!(read(scene("{}").as_bytes()), Err(ERR_REF));
    }

    #[test]
    fn random_bytes_never_panic() {
        // (A cheap fuzz: seeded bytes, and the Motes file cut and bit-flipped at many places.)
        let mut s: u64 = 0x1234_5678;
        let mut next = || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            s
        };
        for _ in 0..3000 {
            let n = (next() % 300) as usize;
            const ALPHA: &[u8] = b"{}[]\":,0123456789.eE-+truefalsnul\\u \xff\xc3";
            let bytes: Vec<u8> = (0..n).map(|_| ALPHA[(next() % ALPHA.len() as u64) as usize]).collect();
            let _ = read(&bytes);
        }
        let m = MOTES.as_bytes();
        for k in 0..m.len() {
            let _ = read(&m[..k]);
            let mut b = m.to_vec();
            b[k] ^= 1 << (next() % 8);
            let _ = read(&b);
        }
    }
}
