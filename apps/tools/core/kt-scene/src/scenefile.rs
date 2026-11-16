//! Scene files, `ktscene/1`: the validator that turns a file (read by json.rs) into a `SceneDef` — every number
//! clamped to its range, NaN and infinities refused (json.rs), the caps held, fields it does not know ignored, kinds it
//! does not know kept by name and skipped. It never panics, whatever the bytes: a bad file gives one of the `ERR_*`
//! codes (negative, as the ABI returns them).
//! Standalone: `rustc --edition 2021 --test --cfg 'kt_alone="scenefile"' src/scenefile.rs`.
//!
//! A scene is a COMPOSITION: an ordered stack of layers drawn first to last (sky, disc, silhouettes, particles, fog,
//! overlays), with a palette of its own. The shape (every field optional unless marked):
//! ```text
//! { "format": "ktscene/1",                                  (required)
//!   "meta":  { "id": "night-snowfall", "name": "Night snowfall" },
//!   "view":  { "fps": 24, "resolution": 0.5 },              (hints for the page: 10–30 fps, canvas scale 0.25–1)
//!   "space": { "w": 1600, "h": 1000, "overscan": 0.06, "fit": "cover" | "contain" },
//!            (scene space: positions never depend on the window; the page maps it by the fit, the overscan margin
//!             is drawn too so parallax and zoom never show an edge)
//!   "palette": [ "primary",                                 (a theme role: the page gives its colour)
//!                "#e6edff",                                 (a literal colour, #rgb / #rrggbb / #rrggbbaa)
//!                { "id": "sky-top", "dark": "#040822", "light": "#dce8fa" } ],   (per mode; each a role or a colour)
//!            (1–32 entries; referred to by id — a bare role's id is its name, a bare colour's its index — or index.
//!             The legacy { "roles": [...] } is read as a list of roles.)
//!   "params": [ { "id": "amount", "type": "slider" | "toggle" | "choice" | "colour", "min": 0, "max": 1,
//!                 "default": 0.7, "choices": ["a", "b"] } ],          (0–16: the future user properties)
//!   "layers": [ { "id": "sky", "kind": "sky", "depth": 0, "parallax": 0, "opacity": 1,
//!                 "blend": "normal" | "add" | "screen" | "multiply" | "soft-light", "params": { … } } ],   (1–32)
//!            kinds and their params (positions are shares of the scene space):
//!              particles  (drawn from the emitters that name it)
//!              sky        stops: [[at, colour], …] (2–8); glow: { x, y, r, colour, alpha }
//!              silhouette form: ridge | hills | skyline | reeds; base, amp, count, h0, h1, colour,
//!                         haze (0–1) toward hazeColour, snow: colour (a snow cover and rim light), rough (ridge)
//!                         (no trees of any kind: an unknown form, «pines» included, is a ridge)
//!              disc       x, y, r (share of the height), halo (radius × r), colour, glow (0–1)
//!              fog        y, h, count (1–32), size, speed (scene px/s), alpha, colour   (drifting puffs)
//!              band       y0, y1, top, bottom (colours), a0, a1                         (a vertical gradient band)
//!              bokeh      count (1–256), y0, y1, rmin, rmax, alpha, colours: [...]       (static soft discs)
//!              grain      alpha;  halftone  alpha, cell                                  (screen overlays)
//!            any other kind (ribbon/aurora today) is kept by name, drawn as nothing, reported by the ABI.
//!   "emitters": [ {                                                      (0–16)
//!       "id": "snow-near", "layer": "snow-near" (required: a particles layer), "group": "snow",
//!       "max": 360 (1–2048; the scene's sum ≤ 4096), "rate": 26, "prewarm": 1, "wind": 1 (0–4),
//!       "densityParam": "amount", "sizeParam": "flake",               (file params multiplying density / size)
//!       "shape": { "kind": "rect", "x": 0, "y": 0, "w": 1, "h": 1 },     (a share of the scene space)
//!       "initializers": [ { "kind": "lifetime" | "size" | "alpha" | "rotation" | "spin" | "stretch", "min", "max" },
//!                         { "kind": "velocity", "min": [x, y], "max": [x, y] },
//!                         { "kind": "colour", "roles": ["primary", 2, …] },   (palette references)
//!                         { "kind": "sprite", "id": 0 } ],    (0 soft dot, 1 crisp flake, 2 streak, 3 ring, 4 puff)
//!       "operators":    [ { "kind": "drift", "scale", "speed", "strength" }, { "kind": "gravity", "x", "y" },
//!                         { "kind": "drag", "k" }, { "kind": "bounds", "mode": "wrap" | "kill", "margin" },
//!                         { "kind": "fade", "in", "out" }, { "kind": "pointer", "strength", "radius" },
//!                         { "kind": "click", "impulse", "radius" } ] } ] }
//! ```

#[cfg(kt_alone = "scenefile")]
#[path = "json.rs"]
mod json;

pub use crate::json::{parse, V, ERR_CAPS, ERR_FORMAT, ERR_REF, ERR_TYPE};

pub const MAX_LAYERS: usize = 32;
pub const MAX_EMITTERS: usize = 16;
pub const MAX_PER_EMITTER: u32 = 2048;
pub const MAX_TOTAL: u32 = 4096;
pub const MAX_PALETTE: usize = 32;
pub const MAX_PARAMS: usize = 16;
pub const MAX_GROUPS: usize = 8;
/// Initializers and operators of one emitter, each at most.
pub const MAX_STAGES: usize = 32;
pub const MAX_STOPS: usize = 8;
pub const MAX_BOKEH: usize = 256;
pub const MAX_FOG: usize = 32;

/* ---------- the scene ---------- */

#[derive(Clone, Debug, PartialEq)]
pub struct SceneDef {
    pub id: String,
    pub name: String,
    pub fps: f32,
    pub resolution: f32,
    pub space: Space,
    pub palette: Vec<PalEntry>,
    pub params: Vec<ParamDef>,
    /// Emitter groups by name (a mixer's density and size apply to a group).
    pub groups: Vec<String>,
    pub layers: Vec<LayerDef>,
    pub emitters: Vec<EmitterDef>,
}

/// The scene space: `w`×`h` units, drawn with a margin of `overscan` × w (and × h) round it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Space {
    pub w: f32,
    pub h: f32,
    pub overscan: f32,
    /// true: cover (the default; fills the window, cropping); false: contain.
    pub cover: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Colour {
    /// A theme role by name: the page gives its colour.
    Role(String),
    /// 0xRRGGBBAA.
    Rgba(u32),
}

#[derive(Clone, Debug, PartialEq)]
pub struct PalEntry {
    pub id: String,
    pub dark: Colour,
    pub light: Colour,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ParamKind {
    Slider,
    Toggle,
    Choice,
    Colour,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ParamDef {
    pub id: String,
    pub kind: ParamKind,
    pub min: f32,
    pub max: f32,
    pub default: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Blend {
    Normal = 0,
    Add = 1,
    Screen = 2,
    Multiply = 3,
    SoftLight = 4,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Form {
    Ridge = 0,
    Hills = 1,
    Skyline = 3,
    Reeds = 4,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LayerKind {
    Particles,
    Sky { stops: Vec<(f32, u8)>, glow: Option<(f32, f32, f32, u8, f32)> },
    Silhouette { form: Form, base: f32, amp: f32, count: u32, h0: f32, h1: f32, colour: u8, haze_colour: u8, haze: f32, snow: Option<u8>, rough: f32 },
    Disc { x: f32, y: f32, r: f32, halo: f32, colour: u8, glow: f32 },
    Fog { y: f32, h: f32, count: u32, size: f32, speed: f32, alpha: f32, colour: u8 },
    Band { y0: f32, y1: f32, top: u8, bottom: u8, a0: f32, a1: f32 },
    Bokeh { count: u32, y0: f32, y1: f32, rmin: f32, rmax: f32, alpha: f32, colours: Vec<u8> },
    Grain { alpha: f32 },
    Halftone { alpha: f32, cell: f32 },
    /// A kind this version does not draw (ribbon/aurora, or any other): kept by name.
    Unknown(String),
}

impl LayerKind {
    /// The kind's number in the ABI (drawlist.rs).
    pub fn code(&self) -> u32 {
        match self {
            LayerKind::Particles => 0,
            LayerKind::Sky { .. } => 1,
            LayerKind::Silhouette { .. } => 2,
            LayerKind::Disc { .. } => 3,
            LayerKind::Fog { .. } => 4,
            LayerKind::Band { .. } => 5,
            LayerKind::Bokeh { .. } => 6,
            LayerKind::Grain { .. } => 7,
            LayerKind::Halftone { .. } => 8,
            LayerKind::Unknown(_) => 255,
        }
    }
    /// Drawn once into an offscreen canvas by the page and blitted (nothing to compute per frame).
    pub fn is_static(&self) -> bool {
        !matches!(self, LayerKind::Particles | LayerKind::Fog { .. })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct LayerDef {
    pub id: String,
    pub kind: LayerKind,
    /// 0 far … 1 near.
    pub depth: f32,
    /// How much the layer follows the camera (0 fixed … 1.5); defaults to its depth.
    pub parallax: f32,
    pub opacity: f32,
    pub blend: Blend,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EmitterDef {
    pub id: String,
    pub layer: usize,
    pub group: usize,
    pub max: u32,
    pub rate: f32,
    pub prewarm: f32,
    pub wind: f32,
    pub density_param: Option<usize>,
    pub size_param: Option<usize>,
    pub shape: Shape,
    pub inits: Vec<Init>,
    pub ops: Vec<Op>,
}

/// Where particles are born: a rectangle as a share of the scene space.
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
    /// Width, scene units.
    Size { min: f32, max: f32 },
    /// Height ÷ width (1 round; streaks long).
    Stretch { min: f32, max: f32 },
    Alpha { min: f32, max: f32 },
    /// Radians (no trigonometry here: the page turns the sprite).
    Rotation { min: f32, max: f32 },
    /// Radians a second.
    Spin { min: f32, max: f32 },
    /// Scene units a second.
    Velocity { min: [f32; 2], max: [f32; 2] },
    /// Palette indices, one picked at random.
    Colour { roles: Vec<u8> },
    Sprite { id: u8 },
    /// A kind this version does not know: kept by name, skipped.
    Unknown(String),
}

/// What happens to a particle each step.
#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    /// Smooth noise pushing it around: `scale` per unit, `speed` per second (time), `strength` units/s².
    Drift { scale: f32, speed: f32, strength: f32 },
    Gravity { x: f32, y: f32 },
    /// Velocity lost a second (share).
    Drag { k: f32 },
    /// Off the scene space (with its overscan) by more than `margin`: back in on the other side (wrap) or gone.
    Bounds { wrap: bool, margin: f32 },
    /// Alpha rising over the first `fin` of life, falling over the last `fout` (shares).
    Fade { fin: f32, fout: f32 },
    /// The pointer as a control point: drawn toward it (strength > 0) or pushed away (< 0) within `radius`.
    Pointer { strength: f32, radius: f32 },
    /// A click: one outward push of `impulse` units/s within `radius`.
    Click { impulse: f32, radius: f32 },
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

fn clamp64(n: f64, lo: f32, hi: f32) -> f32 {
    // (f64 → f32 after clamping, so 1e300 is hi, never infinity.)
    if n < lo as f64 {
        lo
    } else if n > hi as f64 {
        hi
    } else {
        n as f32
    }
}

/// A number field, clamped to [lo, hi]; absent: `def`.
fn num(o: &V, k: &str, def: f32, lo: f32, hi: f32) -> Result<f32, i32> {
    match o.get(k) {
        None | Some(V::Null) => Ok(def),
        Some(V::Num(n)) => Ok(clamp64(*n, lo, hi)),
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
            V::Num(n) => Ok(clamp64(*n, lo, hi)),
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

fn index_name(n: usize) -> String {
    let mut s = String::new();
    let mut digits = [0u8; 20];
    let (mut k, mut n) = (0, n);
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
    s
}

fn hex1(c: u8) -> Option<u32> {
    match c {
        b'0'..=b'9' => Some((c - b'0') as u32),
        b'a'..=b'f' => Some((c - b'a' + 10) as u32),
        b'A'..=b'F' => Some((c - b'A' + 10) as u32),
        _ => None,
    }
}

/// "#rgb", "#rrggbb" or "#rrggbbaa" as 0xRRGGBBAA.
pub fn parse_hex(s: &str) -> Option<u32> {
    let b = s.as_bytes();
    if b.first() != Some(&b'#') {
        return None;
    }
    let d: Option<Vec<u32>> = b[1..].iter().map(|&c| hex1(c)).collect();
    let d = d?;
    match d.len() {
        3 => Some((d[0] * 17) << 24 | (d[1] * 17) << 16 | (d[2] * 17) << 8 | 0xff),
        6 => Some((d[0] << 4 | d[1]) << 24 | (d[2] << 4 | d[3]) << 16 | (d[4] << 4 | d[5]) << 8 | 0xff),
        8 => Some((d[0] << 4 | d[1]) << 24 | (d[2] << 4 | d[3]) << 16 | (d[4] << 4 | d[5]) << 8 | (d[6] << 4 | d[7])),
        _ => None,
    }
}

fn colour_of(v: &V) -> Result<Colour, i32> {
    match v {
        V::Str(s) if s.starts_with('#') => parse_hex(s).map(Colour::Rgba).ok_or(ERR_TYPE),
        V::Str(s) if name_ok(s) => Ok(Colour::Role(s.clone())),
        V::Str(_) => Err(ERR_REF),
        _ => Err(ERR_TYPE),
    }
}

fn read_palette(root: &V) -> Result<Vec<PalEntry>, i32> {
    let mut out: Vec<PalEntry> = Vec::new();
    let list: &[V] = match root.get("palette") {
        None | Some(V::Null) => &[],
        Some(V::Arr(a)) => a,
        // (The legacy form: { "roles": [...] }.)
        Some(o @ V::Obj(_)) => arr(o.get("roles"))?,
        Some(_) => return Err(ERR_TYPE),
    };
    if list.len() > MAX_PALETTE {
        return Err(ERR_CAPS);
    }
    for (i, e) in list.iter().enumerate() {
        let entry = match e {
            V::Str(_) => {
                let c = colour_of(e)?;
                let id = match &c {
                    Colour::Role(r) => r.clone(),
                    Colour::Rgba(_) => index_name(i),
                };
                PalEntry { id, dark: c.clone(), light: c }
            }
            V::Obj(_) => {
                let id = match text(e, "id")? {
                    Some(s) if name_ok(s) => s.to_string(),
                    Some(_) => return Err(ERR_REF),
                    None => index_name(i),
                };
                let one = e.get("colour").or_else(|| e.get("role"));
                let dark = match e.get("dark").or(one) {
                    Some(v) => colour_of(v)?,
                    None => return Err(ERR_TYPE),
                };
                let light = match e.get("light") {
                    Some(v) => colour_of(v)?,
                    None => dark.clone(),
                };
                PalEntry { id, dark, light }
            }
            _ => return Err(ERR_TYPE),
        };
        if out.iter().any(|x| x.id == entry.id) {
            return Err(ERR_REF);
        }
        out.push(entry);
    }
    if out.is_empty() {
        out.push(PalEntry { id: "primary".into(), dark: Colour::Role("primary".into()), light: Colour::Role("primary".into()) });
    }
    Ok(out)
}

/// A palette reference: an entry's id, or its index.
fn pal_ref(v: &V, pal: &[PalEntry]) -> Result<u8, i32> {
    match v {
        V::Str(s) => pal.iter().position(|x| x.id == *s).map(|i| i as u8).ok_or(ERR_REF),
        V::Num(n) if *n >= 0.0 && n.fract() == 0.0 && (*n as usize) < pal.len() => Ok(*n as u8),
        V::Num(_) => Err(ERR_REF),
        _ => Err(ERR_TYPE),
    }
}

fn pal_field(o: &V, k: &str, def: u8, pal: &[PalEntry]) -> Result<u8, i32> {
    match o.get(k) {
        None | Some(V::Null) => Ok(def.min(pal.len().saturating_sub(1) as u8)),
        Some(v) => pal_ref(v, pal),
    }
}

fn read_params(root: &V) -> Result<Vec<ParamDef>, i32> {
    let list = arr(root.get("params"))?;
    if list.len() > MAX_PARAMS {
        return Err(ERR_CAPS);
    }
    let mut out: Vec<ParamDef> = Vec::new();
    for p in list {
        if !matches!(p, V::Obj(_)) {
            return Err(ERR_TYPE);
        }
        let id = match text(p, "id")? {
            Some(s) if name_ok(s) => s.to_string(),
            _ => return Err(ERR_REF),
        };
        if out.iter().any(|x| x.id == id) {
            return Err(ERR_REF);
        }
        let kind = match text(p, "type")? {
            None | Some("slider") => ParamKind::Slider,
            Some("toggle") => ParamKind::Toggle,
            Some("choice") => ParamKind::Choice,
            Some("colour") | Some("color") => ParamKind::Colour,
            Some(_) => return Err(ERR_TYPE),
        };
        let (min, max, default) = match kind {
            ParamKind::Slider => {
                let (a, b) = span(p, (0.0, 1.0), -1.0e6, 1.0e6)?;
                (a, b, num(p, "default", a, a, b)?)
            }
            ParamKind::Toggle => (0.0, 1.0, if num(p, "default", 0.0, 0.0, 1.0)? >= 0.5 { 1.0 } else { 0.0 }),
            ParamKind::Choice => {
                let n = arr(p.get("choices"))?.len().clamp(1, 32) as f32;
                (0.0, n - 1.0, num(p, "default", 0.0, 0.0, n - 1.0)?.floor())
            }
            // (A colour's value: 0xRRGGBB, exact in an f32.)
            ParamKind::Colour => {
                let d = match p.get("default") {
                    Some(V::Str(s)) => (parse_hex(s).ok_or(ERR_TYPE)? >> 8) as f32,
                    None | Some(V::Null) => 0x80_80_80 as f32,
                    Some(_) => return Err(ERR_TYPE),
                };
                (0.0, 16_777_215.0, d)
            }
        };
        out.push(ParamDef { id, kind, min, max, default });
    }
    Ok(out)
}

fn read_layer(l: &V, i: usize, pal: &[PalEntry]) -> Result<LayerDef, i32> {
    if !matches!(l, V::Obj(_)) {
        return Err(ERR_TYPE);
    }
    let id = match text(l, "id")? {
        Some(s) if name_ok(s) => s.to_string(),
        Some(_) => return Err(ERR_REF),
        None => index_name(i),
    };
    let depth = num(l, "depth", 0.5, 0.0, 1.0)?;
    let parallax = num(l, "parallax", depth, 0.0, 1.5)?;
    let opacity = num(l, "opacity", 1.0, 0.0, 1.0)?;
    let blend = match text(l, "blend")? {
        None | Some("normal") => Blend::Normal,
        Some("add") | Some("lighter") => Blend::Add,
        Some("screen") => Blend::Screen,
        Some("multiply") => Blend::Multiply,
        Some("soft-light") => Blend::SoftLight,
        Some(_) => Blend::Normal,
    };
    let empty = V::Obj(Vec::new());
    let p = match obj(l.get("params"))? {
        Some(p) => p,
        None => &empty,
    };
    let kind = match text(l, "kind")? {
        None | Some("particles") => LayerKind::Particles,
        Some("sky") => {
            let list = arr(p.get("stops"))?;
            if list.len() > MAX_STOPS {
                return Err(ERR_CAPS);
            }
            let mut stops = Vec::new();
            for s in list {
                match s {
                    V::Arr(a) if a.len() == 2 => {
                        let at = match &a[0] {
                            V::Num(n) => clamp64(*n, 0.0, 1.0),
                            _ => return Err(ERR_TYPE),
                        };
                        stops.push((at, pal_ref(&a[1], pal)?));
                    }
                    _ => return Err(ERR_TYPE),
                }
            }
            if stops.is_empty() {
                stops.push((0.0, 0));
            }
            let glow = match obj(p.get("glow"))? {
                Some(g) => Some((num(g, "x", 0.5, -0.5, 1.5)?, num(g, "y", 0.75, -0.5, 1.5)?, num(g, "r", 0.6, 0.0, 3.0)?, pal_field(g, "colour", 0, pal)?, num(g, "alpha", 0.4, 0.0, 1.0)?)),
                None => None,
            };
            LayerKind::Sky { stops, glow }
        }
        Some("silhouette") => {
            let form = match text(p, "form")? {
                None | Some("ridge") => Form::Ridge,
                Some("hills") => Form::Hills,
                Some("skyline") => Form::Skyline,
                Some("reeds") => Form::Reeds,
                Some(_) => Form::Ridge,
            };
            let colour = pal_field(p, "colour", 0, pal)?;
            LayerKind::Silhouette {
                form,
                base: num(p, "base", 0.7, 0.0, 1.2)?,
                amp: num(p, "amp", 0.1, 0.0, 1.0)?,
                count: num(p, "count", 20.0, 1.0, 400.0)? as u32,
                h0: num(p, "h0", 0.12, 0.0, 1.0)?,
                h1: num(p, "h1", 0.3, 0.0, 1.0)?,
                colour,
                haze_colour: pal_field(p, "hazeColour", colour, pal)?,
                haze: num(p, "haze", 0.0, 0.0, 1.0)?,
                snow: match p.get("snow") {
                    None | Some(V::Null) => None,
                    Some(v) => Some(pal_ref(v, pal)?),
                },
                rough: num(p, "rough", 0.52, 0.2, 0.9)?,
            }
        }
        Some("disc") => LayerKind::Disc { x: num(p, "x", 0.7, -0.5, 1.5)?, y: num(p, "y", 0.2, -0.5, 1.5)?, r: num(p, "r", 0.04, 0.001, 0.5)?, halo: num(p, "halo", 4.0, 1.0, 12.0)?, colour: pal_field(p, "colour", 0, pal)?, glow: num(p, "glow", 0.35, 0.0, 1.0)? },
        Some("fog") => LayerKind::Fog { y: num(p, "y", 0.8, -0.2, 1.2)?, h: num(p, "h", 0.08, 0.0, 1.0)?, count: num(p, "count", 6.0, 1.0, MAX_FOG as f32)? as u32, size: num(p, "size", 600.0, 10.0, 4000.0)?, speed: num(p, "speed", 6.0, -200.0, 200.0)?, alpha: num(p, "alpha", 0.12, 0.0, 1.0)?, colour: pal_field(p, "colour", 0, pal)? },
        Some("band") => LayerKind::Band { y0: num(p, "y0", 0.9, -0.2, 1.2)?, y1: num(p, "y1", 1.0, -0.2, 1.2)?, top: pal_field(p, "top", 0, pal)?, bottom: pal_field(p, "bottom", 0, pal)?, a0: num(p, "a0", 1.0, 0.0, 1.0)?, a1: num(p, "a1", 1.0, 0.0, 1.0)? },
        Some("bokeh") => {
            let list = arr(p.get("colours"))?;
            if list.len() > MAX_PALETTE {
                return Err(ERR_CAPS);
            }
            let mut colours = Vec::new();
            for c in list {
                colours.push(pal_ref(c, pal)?);
            }
            if colours.is_empty() {
                colours.push(0);
            }
            let (rmin, rmax) = (num(p, "rmin", 10.0, 0.5, 400.0)?, num(p, "rmax", 60.0, 0.5, 400.0)?);
            LayerKind::Bokeh { count: num(p, "count", 40.0, 1.0, MAX_BOKEH as f32)? as u32, y0: num(p, "y0", 0.0, -0.2, 1.2)?, y1: num(p, "y1", 1.0, -0.2, 1.2)?, rmin: rmin.min(rmax), rmax: rmin.max(rmax), alpha: num(p, "alpha", 0.3, 0.0, 1.0)?, colours }
        }
        Some("grain") => LayerKind::Grain { alpha: num(p, "alpha", 0.05, 0.0, 0.5)? },
        Some("halftone") => LayerKind::Halftone { alpha: num(p, "alpha", 0.08, 0.0, 0.6)?, cell: num(p, "cell", 6.0, 2.0, 64.0)? },
        Some(other) => LayerKind::Unknown(other.chars().take(64).collect()),
    };
    Ok(LayerDef { id, kind, depth, parallax, opacity, blend })
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
    let mut space = Space { w: 1600.0, h: 1000.0, overscan: 0.06, cover: true };
    if let Some(s) = obj(root.get("space"))? {
        space = Space {
            w: num(s, "w", 1600.0, 100.0, 8192.0)?,
            h: num(s, "h", 1000.0, 100.0, 8192.0)?,
            overscan: num(s, "overscan", 0.06, 0.0, 0.25)?,
            cover: !matches!(text(s, "fit")?, Some("contain")),
        };
    }
    let palette = read_palette(&root)?;
    let params = read_params(&root)?;

    let mut layers: Vec<LayerDef> = Vec::new();
    let ls = arr(root.get("layers"))?;
    if ls.len() > MAX_LAYERS {
        return Err(ERR_CAPS);
    }
    for (i, l) in ls.iter().enumerate() {
        let d = read_layer(l, i, &palette)?;
        if layers.iter().any(|x| x.id == d.id) {
            return Err(ERR_REF);
        }
        layers.push(d);
    }
    if layers.is_empty() {
        layers.push(LayerDef { id: "0".into(), kind: LayerKind::Particles, depth: 0.5, parallax: 0.5, opacity: 1.0, blend: Blend::Normal });
    }

    let es = arr(root.get("emitters"))?;
    if es.len() > MAX_EMITTERS {
        return Err(ERR_CAPS);
    }
    let mut emitters: Vec<EmitterDef> = Vec::new();
    let mut groups: Vec<String> = Vec::new();
    let mut total: u32 = 0;
    let param_of = |e: &V, k: &str| -> Result<Option<usize>, i32> {
        match text(e, k)? {
            None => Ok(None),
            Some(s) => params.iter().position(|p| p.id == s).map(Some).ok_or(ERR_REF),
        }
    };
    for (i, e) in es.iter().enumerate() {
        if !matches!(e, V::Obj(_)) {
            return Err(ERR_TYPE);
        }
        let eid = match text(e, "id")? {
            Some(s) if name_ok(s) => s.to_string(),
            Some(_) => return Err(ERR_REF),
            None => {
                let mut s = String::from("e");
                s.push_str(&index_name(i));
                s
            }
        };
        if emitters.iter().any(|x| x.id == eid) {
            return Err(ERR_REF);
        }
        let particle_layers: Vec<usize> = layers.iter().enumerate().filter(|(_, l)| l.kind == LayerKind::Particles).map(|(k, _)| k).collect();
        let layer = match text(e, "layer")? {
            Some(s) => {
                let k = layers.iter().position(|l| l.id == s).ok_or(ERR_REF)?;
                if layers[k].kind != LayerKind::Particles {
                    return Err(ERR_REF);
                }
                k
            }
            None if particle_layers.len() == 1 => particle_layers[0],
            None => return Err(ERR_REF),
        };
        let gname = match text(e, "group")? {
            Some(s) if name_ok(s) => s.to_string(),
            Some(_) => return Err(ERR_REF),
            None => "main".to_string(),
        };
        let group = match groups.iter().position(|g| *g == gname) {
            Some(g) => g,
            None => {
                if groups.len() >= MAX_GROUPS {
                    return Err(ERR_CAPS);
                }
                groups.push(gname);
                groups.len() - 1
            }
        };
        let max = num(e, "max", 256.0, 1.0, MAX_PER_EMITTER as f32)? as u32;
        total += max;
        if total > MAX_TOTAL {
            return Err(ERR_CAPS);
        }
        let mut shape = Shape { x: 0.0, y: 0.0, w: 1.0, h: 1.0 };
        if let Some(s) = obj(e.get("shape"))? {
            if matches!(text(s, "kind")?, None | Some("rect")) {
                shape = Shape { x: num(s, "x", 0.0, -1.0, 2.0)?, y: num(s, "y", 0.0, -1.0, 2.0)?, w: num(s, "w", 1.0, 0.0, 3.0)?, h: num(s, "h", 1.0, 0.0, 3.0)? };
            }
        }
        let inits_v = arr(e.get("initializers"))?;
        let ops_v = arr(e.get("operators"))?;
        if inits_v.len() > MAX_STAGES || ops_v.len() > MAX_STAGES {
            return Err(ERR_CAPS);
        }
        let mut inits = Vec::with_capacity(inits_v.len());
        for v in inits_v {
            inits.push(read_init(v, &palette)?);
        }
        let mut ops = Vec::with_capacity(ops_v.len());
        for v in ops_v {
            ops.push(read_op(v)?);
        }
        emitters.push(EmitterDef {
            id: eid,
            layer,
            group,
            max,
            rate: num(e, "rate", 16.0, 0.0, 4096.0)?,
            prewarm: num(e, "prewarm", 1.0, 0.0, 1.0)?,
            wind: num(e, "wind", 1.0, 0.0, 4.0)?,
            density_param: param_of(e, "densityParam")?,
            size_param: param_of(e, "sizeParam")?,
            shape,
            inits,
            ops,
        });
    }
    if groups.is_empty() {
        groups.push("main".to_string());
    }
    Ok(SceneDef { id, name, fps, resolution, space, palette, params, groups, layers, emitters })
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

fn read_init(v: &V, pal: &[PalEntry]) -> Result<Init, i32> {
    let k = kind_of(v)?;
    Ok(match k {
        "lifetime" => {
            let (a, b) = span(v, (4.0, 8.0), 0.05, 600.0)?;
            Init::Lifetime { min: a, max: b }
        }
        "size" => {
            let (a, b) = span(v, (2.0, 4.0), 0.0, 512.0)?;
            Init::Size { min: a, max: b }
        }
        "stretch" => {
            let (a, b) = span(v, (1.0, 1.0), 0.05, 40.0)?;
            Init::Stretch { min: a, max: b }
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
            let list = arr(v.get("roles").or_else(|| v.get("colours")))?;
            if list.len() > MAX_PALETTE {
                return Err(ERR_CAPS);
            }
            let mut out = Vec::with_capacity(list.len());
            for r in list {
                out.push(pal_ref(r, pal)?);
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
        "bounds" => Op::Bounds { wrap: !matches!(text(v, "mode")?, Some("kill")), margin: num(v, "margin", 16.0, 0.0, 512.0)? },
        "fade" => Op::Fade { fin: num(v, "in", 0.2, 0.0, 1.0)?, fout: num(v, "out", 0.2, 0.0, 1.0)? },
        "pointer" => Op::Pointer { strength: num(v, "strength", -60.0, -4096.0, 4096.0)?, radius: num(v, "radius", 160.0, 1.0, 4096.0)? },
        "click" => Op::Click { impulse: num(v, "impulse", 120.0, -4096.0, 4096.0)?, radius: num(v, "radius", 220.0, 1.0, 4096.0)? },
        other => Op::Unknown(unknown(other)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MOTES: &str = include_str!("../../../src/theme/scenes/motes.json");
    const SNOW: &str = include_str!("../../../src/theme/scenes/night-snowfall.json");

    #[test]
    fn the_built_in_scenes_read() {
        for (src, id, n) in [(MOTES, "motes", 3), (SNOW, "night-snowfall", 3)] {
            let d = read(src.as_bytes()).expect(id);
            assert_eq!(d.id, id);
            assert!(d.emitters.len() >= n);
            assert!(d.emitters.iter().map(|e| e.max).sum::<u32>() <= MAX_TOTAL);
            assert!(d.emitters.iter().all(|e| e.inits.iter().all(|i| !matches!(i, Init::Unknown(_))) && e.ops.iter().all(|o| !matches!(o, Op::Unknown(_)))));
            assert!(d.layers.iter().all(|l| !matches!(l.kind, LayerKind::Unknown(_))));
        }
        let s = read(SNOW.as_bytes()).unwrap();
        assert!(matches!(s.layers[0].kind, LayerKind::Sky { .. }));
        assert!(s.layers.iter().any(|l| matches!(l.kind, LayerKind::Silhouette { form: Form::Hills, snow: Some(_), .. })));
        assert!(!SNOW.contains("pines"), "no trees");
        assert!(s.layers.iter().any(|l| matches!(l.kind, LayerKind::Disc { .. })));
        // (Its own palette: literal colours, a dark and a light variant.)
        assert!(s.palette.iter().any(|p| matches!(p.dark, Colour::Rgba(_)) && p.dark != p.light));
    }

    fn scene(emitters: &str) -> String {
        format!("{{\"format\":\"ktscene/1\",\"palette\":[\"primary\",\"tertiary\"],\"layers\":[{{\"id\":\"a\"}},{{\"id\":\"b\",\"depth\":9}},{{\"id\":\"s\",\"kind\":\"sky\"}}],\"emitters\":[{}]}}", emitters)
    }

    #[test]
    fn clamps_and_defaults() {
        let d = read(scene("{\"layer\":\"b\",\"max\":1e300,\"rate\":-5,\"prewarm\":7,\"future\":{\"x\":1},\"initializers\":[{\"kind\":\"size\",\"min\":900,\"max\":-3},{\"kind\":\"colour\",\"roles\":[\"tertiary\",0]},{\"kind\":\"sparkle\",\"n\":3}],\"operators\":[{\"kind\":\"drag\",\"k\":1e308},{\"kind\":\"bounds\",\"mode\":\"bounce\"},{\"kind\":\"vortex\"}]}").as_bytes()).unwrap();
        assert_eq!(d.layers[1].depth, 1.0);
        assert_eq!(d.layers[1].parallax, 1.0);
        let e = &d.emitters[0];
        assert_eq!((e.layer, e.max, e.rate, e.prewarm, e.group), (1, MAX_PER_EMITTER, 0.0, 1.0, 0));
        assert_eq!(e.id, "e0");
        assert_eq!(e.inits[0], Init::Size { min: 0.0, max: 512.0 });
        assert_eq!(e.inits[1], Init::Colour { roles: vec![1, 0] });
        assert_eq!(e.inits[2], Init::Unknown("sparkle".into()));
        assert_eq!(e.ops[0], Op::Drag { k: 60.0 });
        assert_eq!(e.ops[1], Op::Bounds { wrap: true, margin: 16.0 });
        assert_eq!(e.ops[2], Op::Unknown("vortex".into()));
        let min = read(b"{\"format\":\"ktscene/1\"}").unwrap();
        assert_eq!((min.layers.len(), min.emitters.len(), min.palette.len(), min.groups.len()), (1, 0, 1, 1));
        assert_eq!(min.space, Space { w: 1600.0, h: 1000.0, overscan: 0.06, cover: true });
    }

    #[test]
    fn palettes_layers_and_params() {
        let d = read(br##"{"format":"ktscene/1","space":{"w":800,"h":500,"overscan":9,"fit":"contain"},
          "palette":["#123","#a1b2c3",{"id":"sky","dark":"#000000","light":"surface"},"primary","#01020304"],
          "params":[{"id":"amount","default":5},{"id":"on","type":"toggle","default":0.7},{"id":"pick","type":"choice","choices":["a","b","c"],"default":9},{"id":"tint","type":"colour","default":"#ff0080"}],
          "layers":[{"id":"sky","kind":"sky","params":{"stops":[[0,"sky"],[1,1]],"glow":{"colour":"primary"}}},
                    {"id":"r","kind":"silhouette","blend":"screen","params":{"form":"pines","count":9999,"snow":0}},
                    {"id":"m","kind":"disc"},{"id":"f","kind":"fog"},{"id":"au","kind":"aurora"},{"id":"p"}],
          "emitters":[{"id":"x","layer":"p","group":"snow","densityParam":"amount","sizeParam":"pick"},{"layer":"p","group":"rain"},{"layer":"p","group":"snow"}]}"##).unwrap();
        assert_eq!(d.space, Space { w: 800.0, h: 500.0, overscan: 0.25, cover: false });
        assert_eq!(d.palette[0].dark, Colour::Rgba(0x112233ff));
        assert_eq!(d.palette[1].dark, Colour::Rgba(0xa1b2c3ff));
        assert_eq!(d.palette[2].light, Colour::Role("surface".into()));
        assert_eq!(d.palette[3].id, "primary");
        assert_eq!(d.palette[4].dark, Colour::Rgba(0x01020304));
        assert_eq!(d.params[0].default, 1.0);
        assert_eq!(d.params[1].default, 1.0);
        assert_eq!((d.params[2].max, d.params[2].default), (2.0, 2.0));
        assert_eq!(d.params[3].default, 0xff0080 as f32);
        assert!(matches!(&d.layers[0].kind, LayerKind::Sky { stops, glow: Some(g) } if stops == &vec![(0.0, 2), (1.0, 1)] && g.3 == 3));
        assert!(matches!(d.layers[1].kind, LayerKind::Silhouette { form: Form::Ridge, count: 400, snow: Some(0), .. }), "pines are no form: a ridge");
        assert_eq!(d.layers[1].blend, Blend::Screen);
        assert_eq!(d.layers[4].kind, LayerKind::Unknown("aurora".into()));
        assert!(!d.layers[3].kind.is_static() && d.layers[0].kind.is_static());
        assert_eq!(d.groups, vec!["snow".to_string(), "rain".to_string()]);
        assert_eq!((d.emitters[0].group, d.emitters[1].group, d.emitters[2].group), (0, 1, 0));
        assert_eq!((d.emitters[0].density_param, d.emitters[0].size_param), (Some(0), Some(2)));
    }

    #[test]
    fn refusals() {
        assert_eq!(read(b"[]"), Err(ERR_FORMAT));
        assert_eq!(read(b"{\"format\":\"ktscene/2\"}"), Err(ERR_FORMAT));
        assert_eq!(read(b"{\"format\":1}"), Err(ERR_FORMAT));
        assert_eq!(read(scene("{\"layer\":\"zz\"}").as_bytes()), Err(ERR_REF));
        assert_eq!(read(scene("{\"layer\":\"s\"}").as_bytes()), Err(ERR_REF), "an emitter in a sky layer");
        assert_eq!(read(scene("{\"layer\":\"a\",\"max\":\"lots\"}").as_bytes()), Err(ERR_TYPE));
        assert_eq!(read(scene("{\"layer\":\"a\",\"initializers\":{}}").as_bytes()), Err(ERR_TYPE));
        assert_eq!(read(scene("{\"layer\":\"a\",\"initializers\":[{\"min\":1}]}").as_bytes()), Err(ERR_TYPE));
        assert_eq!(read(scene("{\"layer\":\"a\",\"initializers\":[{\"kind\":\"colour\",\"roles\":[\"nope\"]}]}").as_bytes()), Err(ERR_REF));
        assert_eq!(read(scene("{\"layer\":\"a\",\"initializers\":[{\"kind\":\"colour\",\"roles\":[5]}]}").as_bytes()), Err(ERR_REF));
        assert_eq!(read(scene("{\"layer\":\"a\",\"initializers\":[{\"kind\":\"velocity\",\"min\":[1,2,3]}]}").as_bytes()), Err(ERR_TYPE));
        assert_eq!(read(scene("{\"layer\":\"a\",\"densityParam\":\"none\"}").as_bytes()), Err(ERR_REF));
        assert_eq!(read(scene("{\"id\":\"q\",\"layer\":\"a\"},{\"id\":\"q\",\"layer\":\"a\"}").as_bytes()), Err(ERR_REF));
        assert_eq!(read(scene("5").as_bytes()), Err(ERR_TYPE));
        let three = (0..3).map(|_| "{\"layer\":\"a\",\"max\":2000}").collect::<Vec<_>>().join(",");
        assert_eq!(read(scene(&three).as_bytes()), Err(ERR_CAPS));
        let many = (0..17).map(|_| "{\"layer\":\"a\",\"max\":1}").collect::<Vec<_>>().join(",");
        assert_eq!(read(scene(&many).as_bytes()), Err(ERR_CAPS));
        let groups = (0..9).map(|k| format!("{{\"layer\":\"a\",\"max\":1,\"group\":\"g{k}\"}}")).collect::<Vec<_>>().join(",");
        assert_eq!(read(scene(&groups).as_bytes()), Err(ERR_CAPS));
        assert_eq!(read(b"{\"format\":\"ktscene/1\",\"layers\":[{\"id\":\"a\"},{\"id\":\"a\"}]}"), Err(ERR_REF));
        assert_eq!(read(b"{\"format\":\"ktscene/1\",\"layers\":[{\"id\":\"Bad Id\"}]}"), Err(ERR_REF));
        let big = (0..33).map(|k| format!("\"#{:06x}\"", k)).collect::<Vec<_>>().join(",");
        assert_eq!(read(format!("{{\"format\":\"ktscene/1\",\"palette\":[{big}]}}").as_bytes()), Err(ERR_CAPS));
        assert_eq!(read(b"{\"format\":\"ktscene/1\",\"palette\":[\"#12\"]}"), Err(ERR_TYPE));
        assert_eq!(read(b"{\"format\":\"ktscene/1\",\"palette\":[\"Not A Role\"]}"), Err(ERR_REF));
        assert_eq!(read(b"{\"format\":\"ktscene/1\",\"palette\":[\"a\",\"a\"]}"), Err(ERR_REF));
        assert_eq!(read(b"{\"format\":\"ktscene/1\",\"params\":[{\"id\":\"x\",\"type\":\"dial\"}]}"), Err(ERR_TYPE));
        assert_eq!(read(b"{\"format\":\"ktscene/1\",\"layers\":[{\"kind\":\"sky\",\"params\":{\"stops\":[[0,\"nope\"]]}}]}"), Err(ERR_REF));
        assert_eq!(read(b"{\"format\":\"ktscene/1\",\"view\":[]}"), Err(ERR_TYPE));
        // (Two particle layers and no layer named: which one is meant is unknown.)
        assert_eq!(read(scene("{}").as_bytes()), Err(ERR_REF));
    }

    #[test]
    fn random_bytes_never_panic() {
        // (A cheap fuzz: seeded bytes, and both scene files cut and bit-flipped at every place.)
        let mut s: u64 = 0x1234_5678;
        let mut next = || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            s
        };
        for _ in 0..3000 {
            let n = (next() % 300) as usize;
            const ALPHA: &[u8] = b"{}[]\":,0123456789.eE-+truefalsnul\\u #\xff\xc3";
            let bytes: Vec<u8> = (0..n).map(|_| ALPHA[(next() % ALPHA.len() as u64) as usize]).collect();
            let _ = read(&bytes);
        }
        for m in [MOTES.as_bytes(), SNOW.as_bytes()] {
            for k in 0..m.len() {
                let _ = read(&m[..k]);
                let mut b = m.to_vec();
                b[k] ^= 1 << (next() % 8);
                let _ = read(&b);
            }
        }
    }
}
