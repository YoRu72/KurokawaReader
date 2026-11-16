//! The layers that are not particles. Static ones (sky, silhouettes, disc, band, bokeh, grain, halftone) are made
//! ONCE at load, in scene space, as a small float "geometry" each — the page draws it into an offscreen canvas and only
//! blits it afterwards, so a static layer costs nothing per frame. Silhouettes are generated here from a seed (the
//! layer's id hashed with the scene's seed), so the same file and seed give the same ridge and the same trees.
//! Fog is the one moving kind: a few large flattened puffs drifting sideways, drawn as instances.
//! Standalone: `rustc --edition 2021 --test --cfg 'kt_alone="scenery"' src/scenery.rs`.
//!
//! GEOMETRY FORMATS (floats; x, y and sizes in scene units; colours are palette indices):
//! - sky (1):        n, (at, colour) × n, glow?, gx, gy, gr, gcolour, galpha
//! - silhouette (2): form, colour, hazeColour, haze, snow (−1: none), baseY, topY, n, then per form:
//!   ridge/hills (x, y) × n — the top edge, filled down to the bottom of the space (with `snow`: a snow cover and a
//!   soft rim of light along the edge); skyline (x, width, height) × n standing on baseY; reeds (x, height, lean,
//!   width) × n. (No trees: the owner asked for none — no pines, no forest.)
//! - disc (3):       x, y, r, halo (× r), colour, glow
//! - band (5):       y0, y1, top, bottom, a0, a1
//! - bokeh (6):      n, (x, y, r, colour, alpha) × n
//! - grain (7):      alpha;   halftone (8): alpha, cell
//! - mirror (10):    y, ripple, alpha, tint, strength            (drawn each frame by the page from what precedes it)
//! - accum (11):     yTop (now), yBottom, colour, alpha, rough, seed (yTop rises as the snow settles)
//! - shafts (12):    n, colour, (x, yTop, width, length, alpha) × n, angle (radians from straight down)
//! - arcs (13):      n, width, (cx, cy, r, a0, a1, colour, alpha, 0) × n
//!
//! Ribbons (9) are instances (soft curtains along a noise curve), made each step from the scene's time.

#[cfg(kt_alone = "scenery")]
#[path = "json.rs"]
mod json;
#[cfg(kt_alone = "scenery")]
#[path = "math.rs"]
mod math;
#[cfg(kt_alone = "scenery")]
#[path = "scenefile.rs"]
mod scenefile;

use crate::math::{clampf, noise3, Pcg32};
use crate::scenefile::{Form, LayerDef, LayerKind, Space};

/// The scene's bounds with the overscan margin: (x0, y0, x1, y1).
pub fn bounds(s: &Space) -> (f32, f32, f32, f32) {
    let (mx, my) = (s.w * s.overscan, s.h * s.overscan);
    (-mx, -my, s.w + mx, s.h + my)
}

/// A seed from a name (FNV-1a), mixed with the scene's seed: a layer's or an emitter's own stream, independent of
/// its place in the file.
pub fn seed_of(name: &str, seed: u32) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in name.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h ^ ((seed as u64) << 17) ^ seed as u64
}

/// One fog layer's puffs.
pub struct Fog {
    pub x: Vec<f32>,
    pub y: Vec<f32>,
    pub w: Vec<f32>,
    pub v: Vec<f32>,
    pub a: Vec<f32>,
    pub colour: u8,
}

impl Fog {
    pub fn step(&mut self, dt: f32, wind: f32, x0: f32, x1: f32) {
        for i in 0..self.x.len() {
            self.x[i] += (self.v[i] + wind) * dt;
            let half = self.w[i] * 0.5;
            let span = x1 - x0 + self.w[i];
            if self.x[i] > x1 + half {
                self.x[i] -= span;
            } else if self.x[i] < x0 - half {
                self.x[i] += span;
            }
            if !self.x[i].is_finite() {
                self.x[i] = x0;
            }
        }
    }
}

/// The non-particle layers of a scene.
pub struct Scenery {
    /// Per layer: its geometry (empty for particles, fog, ribbons and unknown kinds).
    pub geom: Vec<Vec<f32>>,
    /// Per layer: its fog, when it is one.
    pub fog: Vec<Option<Fog>>,
    /// Per layer: its ribbon (and the layer's noise seed), when it is one.
    pub ribbon: Vec<Option<(Ribbon, u32)>>,
    /// Per layer: an accumulation's growth (h0, h1, seconds), when it is one.
    pub accum: Vec<Option<(f32, f32, f32)>>,
}

/// A ribbon layer's shape (scenefile.rs LayerKind::Ribbon).
#[derive(Clone, Debug, PartialEq)]
pub struct Ribbon {
    pub y: f32,
    pub amp: f32,
    pub thickness: f32,
    pub bands: u32,
    pub speed: f32,
    pub freq: f32,
    pub alpha: f32,
    pub colours: Vec<u8>,
}

/// Points along each ribbon band.
pub const RIBBON_POINTS: usize = 44;

impl Ribbon {
    /// The instances of one band at time `t`: (x, y, height, alpha, colour) for each point, into `out` (cleared).
    pub fn band(&self, b: u32, t: f64, seed: u32, s: &Space, out: &mut Vec<(f32, f32, f32, f32, u8)>) {
        out.clear();
        let (x0, _, x1, _) = bounds(s);
        let z = (t * self.speed as f64) as f32 + b as f32 * 7.3;
        let nc = self.colours.len().max(1);
        for i in 0..RIBBON_POINTS {
            let u = i as f32 / (RIBBON_POINTS - 1) as f32;
            let x = x0 + (x1 - x0) * u;
            let n1 = noise3(seed, u * self.freq * 3.0, b as f32 * 3.1, z);
            let n2 = noise3(seed ^ 0x51ed, u * self.freq * 5.0, b as f32 * 1.7, z * 1.3);
            let y = s.h * (self.y + self.amp * n1 + b as f32 * self.thickness * 0.35);
            let hgt = s.h * self.thickness * (0.55 + 0.45 * (n2 * 0.5 + 0.5));
            let a = self.alpha * (0.3 + 0.7 * clampf(n2 * 0.7 + 0.55, 0.0, 1.0));
            let c = self.colours.get(((u * nc as f32) as usize).min(nc - 1)).copied().unwrap_or(0);
            out.push((x, y, hgt, a, c));
        }
    }
}

impl Scenery {
    pub fn new(layers: &[LayerDef], space: &Space, seed: u32) -> Scenery {
        let mut geom = Vec::with_capacity(layers.len());
        let mut fog = Vec::with_capacity(layers.len());
        let mut ribbon = Vec::with_capacity(layers.len());
        let mut accum = Vec::with_capacity(layers.len());
        for l in layers {
            let mut r = Pcg32::new(seed_of(&l.id, seed), 0x5c3e);
            fog.push(match &l.kind {
                LayerKind::Fog { y, h, count, size, speed, alpha, colour } => Some(make_fog(space, *y, *h, *count, *size, *speed, *alpha, *colour, &mut r)),
                _ => None,
            });
            ribbon.push(match &l.kind {
                LayerKind::Ribbon { y, amp, thickness, bands, speed, freq, alpha, colours } => Some((Ribbon { y: *y, amp: *amp, thickness: *thickness, bands: *bands, speed: *speed, freq: *freq, alpha: *alpha, colours: colours.clone() }, seed_of(&l.id, seed) as u32)),
                _ => None,
            });
            accum.push(match &l.kind {
                LayerKind::Accum { h0, h1, grow, .. } => Some((*h0, *h1, *grow)),
                _ => None,
            });
            geom.push(make_geom(&l.kind, space, seed_of(&l.id, seed) as u32, &mut r));
        }
        Scenery { geom, fog, ribbon, accum }
    }

    /// The accumulations' tops at time `t` (seconds), written into their geometry.
    pub fn settle(&mut self, t: f64, s: &Space) {
        for (g, a) in self.geom.iter_mut().zip(&self.accum) {
            if let Some((h0, h1, grow)) = *a {
                let k = clampf((t / grow as f64) as f32, 0.0, 1.0);
                if let Some(v) = g.get_mut(0) {
                    *v = s.h * (1.0 - (h0 + (h1 - h0) * k));
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn make_fog(s: &Space, y: f32, h: f32, n: u32, size: f32, speed: f32, alpha: f32, colour: u8, r: &mut Pcg32) -> Fog {
    let (x0, _, x1, _) = bounds(s);
    let n = n as usize;
    let mut f = Fog { x: Vec::with_capacity(n), y: Vec::with_capacity(n), w: Vec::with_capacity(n), v: Vec::with_capacity(n), a: Vec::with_capacity(n), colour };
    for _ in 0..n {
        f.x.push(r.range(x0, x1));
        f.y.push(s.h * y + (r.next_f32() - 0.5) * s.h * h.max(0.01));
        f.w.push(size * r.range(0.7, 1.3));
        f.v.push(speed * r.range(0.6, 1.4));
        f.a.push(alpha * r.range(0.7, 1.3));
    }
    f
}

/// 1D midpoint displacement over n + 1 points (n a power of two), normalised to [-1, 1].
fn midpoint(n: usize, rough: f32, r: &mut Pcg32) -> Vec<f32> {
    let mut a = vec![0.0f32; n + 1];
    a[0] = r.next_f32() - 0.5;
    a[n] = r.next_f32() - 0.5;
    let (mut step, mut sc) = (n, 1.0f32);
    while step > 1 {
        let half = step / 2;
        let mut i = half;
        while i < n {
            a[i] = (a[i - half] + a[i + half]) * 0.5 + (r.next_f32() - 0.5) * sc;
            i += step;
        }
        sc *= rough;
        step = half;
    }
    let (mut lo, mut hi) = (f32::MAX, f32::MIN);
    for &v in &a {
        lo = lo.min(v);
        hi = hi.max(v);
    }
    let k = if hi > lo { 2.0 / (hi - lo) } else { 0.0 };
    for v in a.iter_mut() {
        *v = (*v - lo) * k - 1.0;
    }
    a
}

fn make_geom(kind: &LayerKind, s: &Space, seed: u32, r: &mut Pcg32) -> Vec<f32> {
    let (x0, _y0, x1, y1) = bounds(s);
    let (w, h) = (s.w, s.h);
    match kind {
        LayerKind::Sky { stops, glow } => {
            let mut g = vec![stops.len() as f32];
            for &(at, c) in stops {
                g.push(at);
                g.push(c as f32);
            }
            match glow {
                Some((gx, gy, gr, gc, ga)) => g.extend_from_slice(&[1.0, gx * w, gy * h, gr * w, *gc as f32, *ga]),
                None => g.extend_from_slice(&[0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
            }
            g
        }
        LayerKind::Silhouette { form, base, amp, count, h0, h1, colour, haze_colour, haze, snow, rough } => {
            let base_y = h * base;
            let (lo, hi) = (h0.min(*h1), h0.max(*h1));
            let top = match form {
                Form::Ridge | Form::Hills => base_y - h * amp,
                _ => base_y - h * hi,
            };
            let mut g = vec![*form as u32 as f32, *colour as f32, *haze_colour as f32, *haze, snow.map(|c| c as f32).unwrap_or(-1.0), base_y, top];
            match form {
                Form::Ridge => {
                    let n = 256;
                    let a = midpoint(n, *rough, r);
                    g.push((n + 1) as f32);
                    for (i, v) in a.iter().enumerate() {
                        g.push(x0 + (x1 - x0) * i as f32 / n as f32);
                        g.push(base_y - v * h * amp);
                    }
                }
                Form::Hills => {
                    let n = 160;
                    g.push((n + 1) as f32);
                    for i in 0..=n {
                        let x = x0 + (x1 - x0) * i as f32 / n as f32;
                        let v = 0.6 * noise3(seed, x * 0.0018, 0.5, 0.0) + 0.4 * noise3(seed ^ 0x77, x * 0.0045, 1.5, 0.0);
                        g.push(x);
                        g.push(base_y - clampf(v * 1.4, -1.0, 1.0) * h * amp);
                    }
                }
                Form::Skyline => {
                    let mut items: Vec<[f32; 3]> = Vec::new();
                    let mut x = x0;
                    while x < x1 && items.len() < 400 {
                        let bw = r.range(0.016, 0.05) * w;
                        items.push([x, bw, h * (lo + r.next_f32() * (hi - lo))]);
                        x += bw + r.next_f32() * w * 0.004;
                    }
                    g.push(items.len() as f32);
                    for it in items {
                        g.extend_from_slice(&it);
                    }
                }
                Form::Reeds => {
                    let n = *count as usize;
                    g.push(n as f32);
                    for _ in 0..n {
                        let th = h * (lo + r.next_f32() * (hi - lo));
                        g.push(r.range(x0, x1));
                        g.push(th);
                        g.push((r.next_f32() - 0.5) * th * 0.35);
                        g.push(r.range(1.0, 3.3));
                    }
                }
            }
            g
        }
        LayerKind::Disc { x, y, r: rr, halo, colour, glow } => vec![x * w, y * h, rr * h, *halo, *colour as f32, *glow],
        LayerKind::Band { y0, y1, top, bottom, a0, a1 } => vec![y0 * h, y1.max(*y0) * h, *top as f32, *bottom as f32, *a0, *a1],
        LayerKind::Bokeh { count, y0, y1: yb, rmin, rmax, alpha, colours } => {
            let n = *count as usize;
            let mut g = Vec::with_capacity(1 + n * 5);
            g.push(n as f32);
            for _ in 0..n {
                g.push(r.range(x0, x1));
                g.push(clampf(r.range(y0 * h, yb * h), -h, y1));
                g.push(r.range(*rmin, *rmax));
                g.push(colours[r.below(colours.len() as u32) as usize] as f32);
                g.push(alpha * r.range(0.4, 1.1));
            }
            g
        }
        LayerKind::Grain { alpha } => vec![*alpha],
        LayerKind::Halftone { alpha, cell } => vec![*alpha, *cell],
        LayerKind::Mirror { y, ripple, alpha, tint, strength } => vec![y * h, *ripple, *alpha, *tint as f32, *strength],
        LayerKind::Accum { h0, colour, alpha, rough, .. } => vec![h * (1.0 - h0), y1, *colour as f32, *alpha, *rough, (seed & 0xffff) as f32],
        LayerKind::Shafts { count, x0: a, x1: b, y0, len, angle, width, alpha, colour } => {
            let n = *count as usize;
            let mut g = Vec::with_capacity(2 + n * 5);
            g.push(n as f32);
            g.push(*colour as f32);
            for k in 0..n {
                // (Spread evenly with a jitter, each its own width, length and strength.)
                let u = if n > 1 { k as f32 / (n - 1) as f32 } else { 0.5 };
                g.push(w * (a + (b - a) * clampf(u + (r.next_f32() - 0.5) * 0.6 / n as f32, 0.0, 1.0)));
                g.push(h * y0);
                g.push(w * width * r.range(0.5, 1.5));
                g.push(h * len * r.range(0.7, 1.1));
                g.push(alpha * r.range(0.5, 1.0));
            }
            g.push(*angle);
            g
        }
        LayerKind::Arcs { count, y0, y1: yb, rmin, rmax, width, alpha, colours } => {
            let n = *count as usize;
            let mut g = Vec::with_capacity(2 + n * 8);
            g.push(n as f32);
            g.push(*width);
            for _ in 0..n {
                g.push(r.range(x0, x1));
                g.push(h * r.range(*y0, *yb));
                g.push(r.range(*rmin, *rmax));
                let a0 = r.range(0.0, core::f32::consts::TAU);
                g.push(a0);
                g.push(a0 + r.range(0.5, 2.2));
                g.push(colours[r.below(colours.len() as u32) as usize] as f32);
                g.push(alpha * r.range(0.45, 1.0));
                g.push(0.0);
            }
            g
        }
        LayerKind::Particles | LayerKind::Fog { .. } | LayerKind::Ribbon { .. } | LayerKind::Unknown(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenefile::read;

    const SNOW: &str = include_str!("../../../src/theme/scenes/night-snowfall.json");

    #[test]
    fn seeded_and_independent_of_place() {
        let d = read(SNOW.as_bytes()).unwrap();
        let a = Scenery::new(&d.layers, &d.space, 1);
        let b = Scenery::new(&d.layers, &d.space, 1);
        let c = Scenery::new(&d.layers, &d.space, 2);
        assert_eq!(a.geom, b.geom);
        let hills = d.layers.iter().position(|l| l.id == "hills-mid").unwrap();
        assert_ne!(a.geom[hills], c.geom[hills]);
        // (The same layer moved elsewhere in the file: the same trees.)
        let mut moved = d.layers.clone();
        moved.swap(0, hills);
        let m = Scenery::new(&moved, &d.space, 1);
        assert_eq!(m.geom[0], a.geom[hills]);
        assert_eq!(seed_of("a", 1), seed_of("a", 1));
        assert_ne!(seed_of("a", 1), seed_of("b", 1));
    }

    #[test]
    fn geometry_formats() {
        let d = read(SNOW.as_bytes()).unwrap();
        let sc = Scenery::new(&d.layers, &d.space, 7);
        let (x0, y0, x1, y1) = bounds(&d.space);
        for (l, g) in d.layers.iter().zip(&sc.geom) {
            assert!(g.iter().all(|v| v.is_finite()), "{}", l.id);
            match &l.kind {
                LayerKind::Sky { stops, .. } => assert_eq!(g.len(), 1 + stops.len() * 2 + 6),
                LayerKind::Silhouette { form, .. } => {
                    let n = g[7] as usize;
                    if let Form::Ridge = form {
                        assert_eq!(g.len(), 8 + n * 2);
                        assert_eq!((g[8], g[8 + (n - 1) * 2]), (x0, x1));
                        assert!((0..n).all(|i| g[9 + i * 2] >= y0 && g[9 + i * 2] <= y1));
                    }
                }
                LayerKind::Disc { .. } => assert_eq!(g.len(), 6),
                LayerKind::Band { .. } => assert_eq!(g.len(), 6),
                LayerKind::Particles | LayerKind::Fog { .. } => assert!(g.is_empty()),
                _ => {}
            }
        }
        let fog = sc.fog.iter().flatten().next().unwrap();
        assert_eq!(fog.x.len(), 5);
    }

    #[test]
    fn ribbons_mirror_and_accum() {
        let d = read(br##"{"format":"ktscene/1","palette":["primary","#ffffff"],"layers":[
          {"id":"a","kind":"ribbon","params":{"bands":3,"colours":[0,1]}},{"id":"m","kind":"mirror","params":{"y":0.6}},{"id":"s","kind":"accum","params":{"h0":0,"h1":0.1,"grow":100}}]}"##).unwrap();
        let mut sc = Scenery::new(&d.layers, &d.space, 3);
        let (rb, seed) = sc.ribbon[0].clone().unwrap();
        let (mut a, mut b) = (Vec::with_capacity(RIBBON_POINTS), Vec::with_capacity(RIBBON_POINTS));
        rb.band(0, 1.0, seed, &d.space, &mut a);
        rb.band(0, 30.0, seed, &d.space, &mut b);
        assert_eq!(a.len(), RIBBON_POINTS);
        assert_ne!(a, b, "it moves with time");
        assert!(a.iter().all(|p| p.0.is_finite() && p.1.is_finite() && p.2 > 0.0 && p.3 >= 0.0 && p.3 <= 1.0));
        assert_eq!(sc.geom[1], vec![600.0, 3.0, 0.55, 0.0, 0.35]);
        assert_eq!(sc.geom[2][0], 1000.0);
        sc.settle(50.0, &d.space);
        assert_eq!(sc.geom[2][0], 950.0);
        sc.settle(1e9, &d.space);
        assert_eq!(sc.geom[2][0], 900.0);
    }

    #[test]
    fn every_form_and_fog_wrap() {
        let d = read(br##"{"format":"ktscene/1","palette":["primary","#ffffff"],"layers":[
          {"id":"h","kind":"silhouette","params":{"form":"hills"}},{"id":"s","kind":"silhouette","params":{"form":"skyline"}},
          {"id":"r","kind":"silhouette","params":{"form":"reeds","count":50}},{"id":"b","kind":"bokeh","params":{"count":20,"colours":[0,1]}},
          {"id":"g","kind":"grain"},{"id":"t","kind":"halftone"},{"id":"f","kind":"fog","params":{"speed":100}}]}"##).unwrap();
        let mut sc = Scenery::new(&d.layers, &d.space, 3);
        assert_eq!(sc.geom[0].len(), 8 + 161 * 2);
        assert!(sc.geom[1][7] > 10.0);
        assert_eq!(sc.geom[2].len(), 8 + 50 * 4);
        assert_eq!(sc.geom[3].len(), 1 + 20 * 5);
        assert_eq!((sc.geom[4].len(), sc.geom[5].len()), (1, 2));
        let (x0, _, x1, _) = bounds(&d.space);
        let f = sc.fog[6].as_mut().unwrap();
        for _ in 0..10_000 {
            f.step(1.0 / 60.0, 300.0, x0, x1);
        }
        assert!(f.x.iter().zip(&f.w).all(|(x, w)| *x >= x0 - w && *x <= x1 + w));
    }
}
