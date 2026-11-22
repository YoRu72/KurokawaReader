//! A running scene: the file read once; pool, emitters, scenery and draw list allocated once; a fixed clock — steps
//! of 1/60 s, at most 4 per call (a long gap is dropped, not caught up) — so the same file, seed and calls give the
//! same state, natively and in wasm. Everything lives in SCENE SPACE (the file's `space`, with its overscan margin):
//! the window only changes the transform each layer command carries (fit × camera × parallax), so a resize, a zoom or
//! a parallax shift never rescales or collapses the particles. No allocation after `load`.
//! Standalone: `rustc --edition 2021 --test --cfg 'kt_alone="scene"' src/scene.rs`.

#[cfg(kt_alone = "scene")]
#[path = "drawlist.rs"]
mod drawlist;
#[cfg(kt_alone = "scene")]
#[path = "forces.rs"]
mod forces;
#[cfg(kt_alone = "scene")]
#[path = "graph.rs"]
mod graph;
#[cfg(kt_alone = "scene")]
#[path = "json.rs"]
mod json;
#[cfg(kt_alone = "scene")]
#[path = "math.rs"]
mod math;
#[cfg(kt_alone = "scene")]
#[path = "particles.rs"]
mod particles;
#[cfg(kt_alone = "scene")]
#[path = "scenefile.rs"]
mod scenefile;
#[cfg(kt_alone = "scene")]
#[path = "scenery.rs"]
mod scenery;

use crate::drawlist::{Cmd, DrawList, Inst};
use crate::forces::{accelerate, constrain, fade, grow, heading, integrate, swell, twinkle, Control};
use crate::graph::Graph;
use crate::math::{clampf, Fnv, Pcg32};
use crate::particles::{Emitter, Pool, View, DEATHS};
use crate::scenefile::{read, Colour, LayerKind, ParamDef, SceneDef, Space, MAX_LAYERS};
use crate::scenery::{bounds, seed_of, Scenery, RIBBON_POINTS};

/// One fixed step, milliseconds and seconds.
pub const STEP_MS: f32 = 1000.0 / 60.0;
pub const STEP_S: f32 = 1.0 / 60.0;
/// Fixed steps at most per `step` call.
pub const MAX_SUBSTEPS: u32 = 4;
/// The window before the page gives one (CSS pixels), and its limits.
pub const DEFAULT_VIEWPORT: (f32, f32) = (1280.0, 800.0);
pub const MAX_VIEWPORT: f32 = 16384.0;
/// Drawn only when at least this visible.
const MIN_ALPHA: f32 = 1.0 / 512.0;

/// Engine-wide parameters (`scene_param` ids); a file's own params follow from `PARAM_FILE`.
pub const PARAM_SPEED: u32 = 0;
pub const PARAM_DENSITY: u32 = 1;
pub const PARAM_WIND_X: u32 = 2;
pub const PARAM_WIND_Y: u32 = 3;
pub const PARAM_SIZE: u32 = 4;
/// How much the pointer and clicks move things: 0 off, 1 subtle, 2.2 lively (0–3).
pub const PARAM_REACT: u32 = 5;
pub const PARAM_FILE: u32 = 16;

/// The golden hash: Motes, seed 42, viewport 1312×832, 600 steps of 1000/60 ms. Native and wasm must both give it
/// (the tests here; scripts/build-scene-wasm.sh for the wasm). Kept in golden.txt beside Cargo.toml, which both read.
pub const GOLDEN: u32 = golden();
const fn golden() -> u32 {
    let b = include_bytes!("../golden.txt");
    let mut v: u32 = 0;
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c >= b'0' && c <= b'9' {
            v = v.wrapping_mul(10).wrapping_add((c - b'0') as u32);
        } else if v > 0 {
            break;
        }
        i += 1;
    }
    v
}

/// One layer's fixed facts, kept for the command list.
struct LayerInfo {
    kind: u32,
    blend: u32,
    is_static: bool,
    known: bool,
}

pub struct Scene {
    pub def_fps: f32,
    pub def_resolution: f32,
    space: Space,
    view: View,
    palette: Vec<u32>,
    params: Vec<ParamDef>,
    values: Vec<f32>,
    groups: Vec<(f32, f32)>,
    info: Vec<LayerInfo>,
    pool: Pool,
    emitters: Vec<Emitter>,
    graph: Graph,
    scenery: Scenery,
    draw: DrawList,
    seed: u32,
    viewport: (f32, f32),
    camera: (f32, f32, f32),
    /// The pointer in CSS pixels (None: outside), and a click waiting for the next step (CSS pixels).
    pointer: Option<(f32, f32)>,
    click: Option<(f32, f32)>,
    time: f64,
    ticks: u64,
    acc_ms: f32,
    speed: f32,
    density: f32,
    size: f32,
    wind: (f32, f32),
    react: f32,
    last_substeps: u32,
    /// A ribbon band's points this frame (allocated once).
    band: Vec<(f32, f32, f32, f32, u8)>,
}

/// A palette entry's colour before the page gives the theme's: a literal as written (dark), a role mid grey.
fn default_rgba(c: &Colour) -> u32 {
    match c {
        Colour::Rgba(v) => *v,
        Colour::Role(_) => 0x8080_80ff,
    }
}

impl Scene {
    /// A scene from its file's bytes (an `ERR_*` code when the file is refused).
    pub fn load(bytes: &[u8], seed: u32) -> Result<Scene, i32> {
        let def = read(bytes)?;
        Ok(Scene::from_def(&def, seed))
    }

    pub fn from_def(def: &SceneDef, seed: u32) -> Scene {
        let total: usize = def.emitters.iter().map(|e| e.max as usize).sum::<usize>()
            + def.layers.iter().map(|l| match l.kind {
                LayerKind::Fog { count, .. } => count as usize,
                LayerKind::Ribbon { bands, .. } => bands as usize * RIBBON_POINTS,
                _ => 0,
            }).sum::<usize>();
        let (x0, y0, x1, y1) = bounds(&def.space);
        let view = View { w: def.space.w, h: def.space.h, x0, y0, x1, y1 };
        let mut start = 0;
        let mut emitters = Vec::with_capacity(def.emitters.len());
        for e in &def.emitters {
            let s = seed_of(&e.id, seed);
            emitters.push(Emitter {
                rng: Pcg32::new(s, 0x6b74_7363),
                noise_seed: (s ^ (s >> 32)) as u32,
                group: e.group,
                wind: e.wind,
                align: e.align,
                on_death: e.on_death,
                on_click: e.on_click,
                deaths: Vec::with_capacity(DEATHS),
                density_param: e.density_param,
                size_param: e.size_param,
                start,
                max: e.max as usize,
                live: 0,
                layer: e.layer,
                rate: e.rate,
                carry: 0.0,
                prewarm: e.prewarm,
                shape: e.shape,
                inits: e.inits.clone(),
                ops: e.ops.clone(),
            });
            start += e.max as usize;
        }
        let layers: Vec<(f32, f32, f32)> = def.layers.iter().map(|l| (l.depth, l.parallax, l.opacity)).collect();
        let graph = Graph::new(&layers, &emitters.iter().map(|e| e.layer).collect::<Vec<_>>());
        let info = def.layers.iter().map(|l| LayerInfo { kind: l.kind.code(), blend: l.blend as u32, is_static: l.kind.is_static(), known: !matches!(l.kind, LayerKind::Unknown(_)) }).collect();
        let mut s = Scene {
            def_fps: def.fps,
            def_resolution: def.resolution,
            space: def.space,
            view,
            palette: def.palette.iter().map(|p| default_rgba(&p.dark)).collect(),
            params: def.params.clone(),
            values: def.params.iter().map(|p| p.default).collect(),
            groups: def.groups.iter().map(|_| (1.0, 1.0)).collect(),
            info,
            pool: Pool::new(start),
            emitters,
            graph,
            scenery: Scenery::new(&def.layers, &def.space, seed),
            draw: DrawList::new(total, def.layers.len().min(MAX_LAYERS)),
            seed,
            viewport: DEFAULT_VIEWPORT,
            camera: (0.0, 0.0, 1.0),
            pointer: None,
            click: None,
            time: 0.0,
            ticks: 0,
            acc_ms: 0.0,
            speed: 1.0,
            density: 1.0,
            size: 1.0,
            wind: (0.0, 0.0),
            react: 1.0,
            last_substeps: 0,
            band: Vec::with_capacity(RIBBON_POINTS),
        };
        let view = s.view;
        for k in 0..s.emitters.len() {
            let limit = s.limit_of(k);
            let e = &mut s.emitters[k];
            e.prewarm(&mut s.pool, view, limit);
        }
        s.fill();
        s
    }

    fn param_value(&self, p: Option<usize>) -> f32 {
        match p {
            Some(i) if i < self.values.len() => {
                // (The value as a share of its declared range.)
                let d = &self.params[i];
                if d.max > d.min {
                    (self.values[i] - d.min) / (d.max - d.min)
                } else {
                    1.0
                }
            }
            _ => 1.0,
        }
    }

    /// The live particles allowed in emitter `e`: its max × the density (the scene's, its group's, its param's).
    fn limit_of(&self, e: usize) -> usize {
        match self.emitters.get(e) {
            Some(x) => {
                let g = self.groups.get(x.group).map(|g| g.0).unwrap_or(1.0);
                ((x.max as f32) * clampf(self.density * g * self.param_value(x.density_param), 0.0, 1.0) + 0.5) as usize
            }
            None => 0,
        }
    }

    /// The fit's scale and offset (CSS pixels) of the scene space in the window.
    fn fit(&self) -> (f32, f32, f32) {
        let (w, h) = self.viewport;
        let (kx, ky) = (w / self.space.w, h / self.space.h);
        let s = if self.space.cover { kx.max(ky) } else { kx.min(ky) };
        (s, (w - self.space.w * s) * 0.5, (h - self.space.h * s) * 0.5)
    }

    /// A layer's transform (scale, tx, ty): the fit, the camera's zoom and shift times the layer's parallax. The shift
    /// is at most 80 % of the overscan margin, so no edge ever shows.
    pub fn transform(&self, parallax: f32) -> (f32, f32, f32) {
        let (s, _, _) = self.fit();
        let (w, h) = self.viewport;
        let (cx, cy, zoom) = self.camera;
        let k = s * (1.0 + (zoom - 1.0) * parallax);
        let (mx, my) = (self.space.w * self.space.overscan * s * 0.8, self.space.h * self.space.overscan * s * 0.8);
        (k, w * 0.5 - self.space.w * 0.5 * k - cx * parallax * mx, h * 0.5 - self.space.h * 0.5 * k - cy * parallax * my)
    }

    /// The window (CSS pixels). Particles never move: only the transform changes.
    pub fn viewport(&mut self, w: f32, h: f32) {
        self.viewport = (clampf(w, 1.0, MAX_VIEWPORT), clampf(h, 1.0, MAX_VIEWPORT));
        self.fill();
    }

    /// The camera: a shift (−1…1 each way, scaled by each layer's parallax) and a zoom (1–1.5).
    pub fn camera(&mut self, px: f32, py: f32, zoom: f32) {
        self.camera = (clampf(px, -1.0, 1.0), clampf(py, -1.0, 1.0), clampf(zoom, 1.0, 1.5));
        self.fill();
    }

    /// The pointer (CSS pixels; outside the window or NaN: none). `buttons` is kept for later reactions.
    pub fn pointer(&mut self, x: f32, y: f32, _buttons: u32) {
        let (w, h) = self.viewport;
        self.pointer = if x >= 0.0 && y >= 0.0 && x <= w && y <= h { Some((x, y)) } else { None };
    }

    /// A click (CSS pixels): answered once, at the next fixed step.
    pub fn click(&mut self, x: f32, y: f32) {
        let (w, h) = self.viewport;
        if x >= 0.0 && y >= 0.0 && x <= w && y <= h {
            self.click = Some((x, y));
        }
    }

    /// A point of the window (CSS pixels) in a layer's scene space.
    fn to_scene(&self, p: (f32, f32), parallax: f32) -> (f32, f32) {
        let (k, tx, ty) = self.transform(parallax);
        ((p.0 - tx) / k, (p.1 - ty) / k)
    }

    /// A palette entry's colour (0xRRGGBBAA), as the page resolved it for the theme now.
    pub fn palette(&mut self, i: u32, rgba: u32) -> bool {
        match self.palette.get_mut(i as usize) {
            Some(p) => {
                *p = rgba;
                true
            }
            None => false,
        }
    }
    pub fn palette_get(&self, i: u32) -> Option<u32> {
        self.palette.get(i as usize).copied()
    }
    pub fn roles(&self) -> usize {
        self.palette.len()
    }

    /// An engine-wide parameter (speed 0–4, density 0–1, wind x/y −400…400 units/s, size 0.25–4) or a file's own
    /// (`PARAM_FILE + i`, clamped to its declared range).
    pub fn param(&mut self, id: u32, v: f32) -> bool {
        match id {
            PARAM_SPEED => self.speed = clampf(v, 0.0, 4.0),
            PARAM_DENSITY => self.density = clampf(v, 0.0, 1.0),
            PARAM_WIND_X => self.wind.0 = clampf(v, -400.0, 400.0),
            PARAM_WIND_Y => self.wind.1 = clampf(v, -400.0, 400.0),
            PARAM_SIZE => self.size = clampf(v, 0.25, 4.0),
            PARAM_REACT => self.react = clampf(v, 0.0, 3.0),
            _ if id >= PARAM_FILE && ((id - PARAM_FILE) as usize) < self.params.len() => {
                let i = (id - PARAM_FILE) as usize;
                let d = &self.params[i];
                self.values[i] = clampf(v, d.min, d.max);
            }
            _ => return false,
        }
        self.fill();
        true
    }
    pub fn param_get(&self, id: u32) -> Option<f32> {
        match id {
            PARAM_SPEED => Some(self.speed),
            PARAM_DENSITY => Some(self.density),
            PARAM_WIND_X => Some(self.wind.0),
            PARAM_WIND_Y => Some(self.wind.1),
            PARAM_SIZE => Some(self.size),
            PARAM_REACT => Some(self.react),
            _ if id >= PARAM_FILE => self.values.get((id - PARAM_FILE) as usize).copied(),
            _ => None,
        }
    }

    /// A group's density (0–1) and size (0.25–4): a mixer shares one budget between a base and its overlays.
    pub fn group(&mut self, g: u32, density: f32, size: f32) -> bool {
        match self.groups.get_mut(g as usize) {
            Some(x) => {
                *x = (clampf(density, 0.0, 1.0), clampf(size, 0.25, 4.0));
                self.fill();
                true
            }
            None => false,
        }
    }

    /// Time passes (`dt_ms`, the page's frame gap): fixed steps for it, then the draw list rebuilt. Returns the
    /// instances drawn.
    pub fn step(&mut self, dt_ms: f32) -> usize {
        let dt = clampf(dt_ms, 0.0, 1000.0) * self.speed;
        self.acc_ms += dt;
        let mut n = 0;
        while self.acc_ms >= STEP_MS && n < MAX_SUBSTEPS {
            self.acc_ms -= STEP_MS;
            self.substep();
            n += 1;
        }
        // (Behind by more than the steps allowed: the rest dropped.)
        if self.acc_ms >= STEP_MS {
            self.acc_ms = 0.0;
        }
        self.last_substeps = n;
        self.fill();
        self.draw.count()
    }

    /// One fixed step of 1/60 s.
    pub fn substep(&mut self) {
        let (dt, t, view) = (STEP_S, self.time, self.view);
        for k in 0..self.emitters.len() {
            let limit = self.limit_of(k);
            let parallax = self.graph.layers.get(self.emitters[k].layer).map(|l| l.parallax).unwrap_or(0.5);
            let ctl = Control { pointer: self.pointer.map(|p| self.to_scene(p, parallax)), click: self.click.map(|p| self.to_scene(p, parallax)), react: self.react };
            let e = &mut self.emitters[k];
            let wind = (self.wind.0 * e.wind, self.wind.1 * e.wind);
            accelerate(&e.ops, &mut self.pool, e.range(), dt, t, e.noise_seed, &ctl);
            integrate(&mut self.pool, e.range(), dt, wind);
            grow(&e.ops, &mut self.pool, e.range(), dt);
            constrain(&e.ops, &mut self.pool, e.range(), view, &mut e.deaths);
            e.reap(&mut self.pool);
            e.emit(&mut self.pool, view, dt, limit);
        }
        // (A click: births where it fell, for the emitters that ask for them — a stone dropped in a pond.)
        if let Some(c) = self.click {
            for k in 0..self.emitters.len() {
                let n = self.emitters[k].on_click;
                if n == 0 {
                    continue;
                }
                let parallax = self.graph.layers.get(self.emitters[k].layer).map(|l| l.parallax).unwrap_or(0.5);
                let (x, y) = self.to_scene(c, parallax);
                let limit = self.limit_of(k);
                for _ in 0..n {
                    self.emitters[k].spawn_at(&mut self.pool, view, limit, x, y);
                }
            }
        }
        // (Children where particles died at a floor: splash rings where rain meets the ground.)
        for k in 0..self.emitters.len() {
            if let Some((c, n)) = self.emitters[k].on_death {
                if self.emitters[k].deaths.is_empty() || c >= self.emitters.len() {
                    continue;
                }
                let deaths = core::mem::take(&mut self.emitters[k].deaths);
                let limit = self.limit_of(c);
                for &(x, y) in &deaths {
                    for _ in 0..n {
                        self.emitters[c].spawn_at(&mut self.pool, view, limit, x, y);
                    }
                }
                let mut d = deaths;
                d.clear();
                self.emitters[k].deaths = d;
            } else {
                self.emitters[k].deaths.clear();
            }
        }
        self.scenery.settle(self.time, &self.space);
        for (li, f) in self.scenery.fog.iter_mut().enumerate() {
            if let Some(f) = f {
                let p = self.graph.layers.get(li).map(|l| l.parallax).unwrap_or(0.5);
                f.step(dt, self.wind.0 * p, view.x0, view.x1);
            }
        }
        self.click = None;
        self.ticks += 1;
        self.time = self.ticks as f64 / 60.0;
    }

    /// The command list and the instances: every layer in file order, each particle's alpha with its fade and its
    /// layer's opacity, its colour from the palette.
    fn fill(&mut self) {
        self.draw.clear();
        for li in 0..self.graph.layers.len() {
            let layer = &self.graph.layers[li];
            let info = match self.info.get(li) {
                Some(i) => i,
                None => continue,
            };
            let first = self.draw.count();
            let li8 = li.min(255) as u8;
            let ptr = self.pointer.map(|q| self.to_scene(q, layer.parallax));
            for &ei in &layer.emitters {
                let e = &self.emitters[ei];
                let gsize = self.groups.get(e.group).map(|g| g.1).unwrap_or(1.0) * self.size * size_mult(&self.params, &self.values, e.size_param);
                for i in e.range() {
                    let p = &self.pool;
                    let a = p.alpha[i] * fade(&e.ops, p.age[i], p.life[i]) * twinkle(&e.ops, self.time as f32, p.life[i]) * layer.opacity;
                    let (x, y) = (p.px[i] + p.dx[i], p.py[i] + p.dy[i]);
                    let sx = p.size[i] * gsize * swell(&e.ops, x, y, ptr, self.react);
                    #[allow(clippy::neg_cmp_op_on_partial_ord)]
                    if !(a >= MIN_ALPHA) || !(sx > 0.0) {
                        continue;
                    }
                    let c = p.colour[i];
                    let rgba = self.palette.get(c as usize).copied().unwrap_or(0x8080_80ff);
                    let rot = if e.align { heading(p.vx[i], p.vy[i]) } else { p.rot[i] };
                    self.draw.push(Inst { x, y, sx, sy: sx * p.stretch[i], rot, alpha: a.min(1.0), rgba, sprite: p.sprite[i], layer: li8, depth: layer.depth, colour: c });
                }
            }
            if let Some(Some(f)) = self.scenery.fog.get(li) {
                let rgba = self.palette.get(f.colour as usize).copied().unwrap_or(0x8080_80ff);
                for i in 0..f.x.len() {
                    let a = f.a[i] * layer.opacity;
                    if a >= MIN_ALPHA {
                        self.draw.push(Inst { x: f.x[i], y: f.y[i], sx: f.w[i], sy: f.w[i] * 0.32, rot: 0.0, alpha: a.min(1.0), rgba, sprite: 4, layer: li8, depth: layer.depth, colour: f.colour });
                    }
                }
            }
            if let Some(Some((rb, seed))) = self.scenery.ribbon.get(li) {
                let step = (bounds(&self.space).2 - bounds(&self.space).0) / (RIBBON_POINTS - 1) as f32;
                for b in 0..rb.bands {
                    rb.band(b, self.time, *seed, &self.space, &mut self.band);
                    for &(x, y, hgt, a, c) in &self.band {
                        let a = a * layer.opacity;
                        if a >= MIN_ALPHA {
                            let rgba = self.palette.get(c as usize).copied().unwrap_or(0x8080_80ff);
                            self.draw.push(Inst { x, y, sx: step * 2.4, sy: hgt, rot: 0.0, alpha: a.min(1.0), rgba, sprite: 11, layer: li8, depth: layer.depth, colour: c });
                        }
                    }
                }
            }
            let (scale, tx, ty) = self.transform(layer.parallax);
            let geom_len = self.scenery.geom.get(li).map(|g| g.len()).unwrap_or(0) as u32;
            self.draw.push_cmd(Cmd {
                kind: info.kind,
                blend: info.blend,
                opacity: layer.opacity,
                depth: layer.depth,
                parallax: layer.parallax,
                start: first as u32,
                count: (self.draw.count() - first) as u32,
                layer: li as u32,
                scale,
                tx,
                ty,
                is_static: info.is_static,
                geom_len,
                geom_ver: 1,
                known: info.known,
            });
        }
    }

    pub fn instances(&self) -> &DrawList {
        &self.draw
    }
    /// A layer's geometry (scenery.rs formats); empty for particles, fog and unknown kinds.
    pub fn geom(&self, layer: usize) -> &[f32] {
        self.scenery.geom.get(layer).map(|g| g.as_slice()).unwrap_or(&[])
    }
    pub fn last_substeps(&self) -> u32 {
        self.last_substeps
    }
    pub fn live(&self) -> usize {
        self.emitters.iter().map(|e| e.live).sum()
    }
    pub fn capacity(&self) -> usize {
        self.pool.len()
    }
    pub fn ticks(&self) -> u64 {
        self.ticks
    }
    pub fn seed(&self) -> u32 {
        self.seed
    }
    /// The scene space: (w, h, overscan).
    pub fn transform_space(&self) -> (f32, f32, f32) {
        (self.space.w, self.space.h, self.space.overscan)
    }

    /// A hash of everything the simulation holds (positions, velocities, ages…, the random streams, the clock, the fog):
    /// two runs agree exactly or not at all.
    pub fn state_hash(&self) -> u32 {
        let mut h = Fnv::new();
        h.u64(self.ticks);
        h.f32(self.acc_ms);
        for e in &self.emitters {
            let (a, b) = e.rng.state_bits();
            h.u64(a);
            h.u64(b);
            h.u32(e.live as u32);
            h.f32(e.carry);
            let p = &self.pool;
            for i in e.range() {
                for v in [p.px[i], p.py[i], p.vx[i], p.vy[i], p.age[i], p.life[i], p.size[i], p.stretch[i], p.rot[i], p.spin[i], p.alpha[i]] {
                    h.f32(v);
                }
                h.u32(p.colour[i] as u32 | (p.sprite[i] as u32) << 8);
                // (The pointer's offset, only while there is one: an untouched scene hashes as it always did.)
                if p.dx[i] != 0.0 || p.dy[i] != 0.0 {
                    h.f32(p.dx[i]);
                    h.f32(p.dy[i]);
                }
            }
        }
        for f in self.scenery.fog.iter().flatten() {
            for &x in &f.x {
                h.f32(x);
            }
        }
        h.fold()
    }

    /// Every live particle's values finite (the tests' check after long runs).
    pub fn all_finite(&self) -> bool {
        let p = &self.pool;
        self.emitters.iter().all(|e| e.range().all(|i| [p.px[i], p.py[i], p.vx[i], p.vy[i], p.age[i], p.life[i], p.size[i], p.rot[i], p.alpha[i]].iter().all(|v| v.is_finite())))
            && self.draw.all_finite()
            && self.draw.cmd_floats().iter().all(|v| v.is_finite())
    }
}

/// An emitter's size param as a multiplier: its share of the declared range × 2 (the middle is 1), 0.1–2.
fn size_mult(params: &[ParamDef], values: &[f32], p: Option<usize>) -> f32 {
    match p {
        Some(i) if i < params.len() => {
            let d = &params[i];
            let share = if d.max > d.min { (values[i] - d.min) / (d.max - d.min) } else { 0.5 };
            clampf(share * 2.0, 0.1, 2.0)
        }
        _ => 1.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drawlist::{CMD_STRIDE, C_COUNT, C_KIND, C_SCALE, C_START, C_STATIC, C_TX, I_X, I_Y};

    const MOTES: &str = include_str!("../../../src/theme/scenes/motes.json");
    const SNOW: &str = include_str!("../../../src/theme/scenes/night-snowfall.json");
    const AURORA: &str = include_str!("../../../src/theme/scenes/aurora-lake.json");
    #[test]
    fn golden_hash() {
        let mut s = Scene::load(MOTES.as_bytes(), 42).unwrap();
        s.viewport(1312.0, 832.0);
        for _ in 0..600 {
            s.step(1000.0 / 60.0);
        }
        assert_eq!(s.state_hash(), super::GOLDEN, "the golden hash changed: put the new number in golden.txt only if the change was meant");
    }

    #[test]
    fn same_seed_same_state() {
        for src in [MOTES, SNOW, AURORA] {
            let mut a = Scene::load(src.as_bytes(), 7).unwrap();
            let mut b = Scene::load(src.as_bytes(), 7).unwrap();
            let mut c = Scene::load(src.as_bytes(), 8).unwrap();
            assert_eq!(a.state_hash(), b.state_hash());
            assert_ne!(a.state_hash(), c.state_hash());
            for k in 0..600 {
                let dt = 10.0 + (k % 7) as f32 * 3.0;
                a.step(dt);
                b.step(dt);
                c.step(dt);
            }
            assert_eq!(a.state_hash(), b.state_hash());
            assert_ne!(a.state_hash(), c.state_hash());
        }
        let mut d = Scene::load(MOTES.as_bytes(), 7).unwrap();
        let mut e = Scene::load(MOTES.as_bytes(), 7).unwrap();
        for _ in 0..120 {
            d.step(STEP_MS * 2.0);
        }
        for _ in 0..240 {
            e.step(STEP_MS);
        }
        assert_eq!(d.state_hash(), e.state_hash());
    }

    #[test]
    fn resize_zoom_and_parallax_never_move_particles() {
        let mut s = Scene::load(SNOW.as_bytes(), 3).unwrap();
        let h0 = s.state_hash();
        s.viewport(400.0, 900.0);
        s.camera(1.0, -1.0, 1.4);
        s.viewport(3000.0, 600.0);
        assert_eq!(s.state_hash(), h0);
        // (The same steps after: the same state as a scene never resized.)
        let mut t = Scene::load(SNOW.as_bytes(), 3).unwrap();
        for _ in 0..300 {
            s.step(STEP_MS);
            t.step(STEP_MS);
        }
        assert_eq!(s.state_hash(), t.state_hash());
    }

    #[test]
    fn the_command_list() {
        let mut s = Scene::load(SNOW.as_bytes(), 1).unwrap();
        s.viewport(1280.0, 800.0);
        s.step(STEP_MS);
        let d = s.instances();
        assert_eq!(d.cmd_count(), 9);
        let c = d.cmd_floats();
        let at = |k: usize, f: usize| c[k * CMD_STRIDE + f];
        // (Sky first, static, no instances; the particle and fog layers cover every instance, in order, once.)
        assert_eq!((at(0, C_KIND), at(0, C_STATIC), at(0, C_COUNT)), (1.0, 1.0, 0.0));
        let mut next = 0.0;
        for k in 0..9 {
            assert_eq!(at(k, C_START), next);
            next += at(k, C_COUNT);
        }
        assert_eq!(next as usize, d.count());
        // (Cover: 1280×800 from 1600×1000 is a scale of 0.8, centred.)
        assert!((at(0, C_SCALE) - 0.8).abs() < 1e-6 && at(0, C_TX).abs() < 1e-3);
        // (Every instance of a layer inside the scene's bounds with its margin.)
        let (x0, y0, x1, y1) = bounds(&s.space);
        for k in 0..d.count() {
            let (x, y) = (d.get(k, I_X), d.get(k, I_Y));
            assert!(x >= x0 - 400.0 && x <= x1 + 400.0 && y >= y0 - 60.0 && y <= y1 + 60.0, "{x} {y}");
        }
        // (A camera shift moves near layers more than far ones, and never further than the overscan.)
        s.camera(1.0, 0.0, 1.0);
        let c = s.instances().cmd_floats();
        let (far, near) = (c[CMD_STRIDE + C_TX], c[7 * CMD_STRIDE + C_TX]);
        assert!(near < far && far < 0.0 && near > -(1600.0 * 0.06 * 0.8));
        assert!(!s.geom(0).is_empty() && s.geom(3).is_empty());
    }

    #[test]
    fn substeps_are_capped_and_zero_dt_draws_without_moving() {
        let mut s = Scene::load(MOTES.as_bytes(), 1).unwrap();
        let h0 = s.state_hash();
        let n = s.step(0.0);
        assert!(n > 0);
        assert_eq!(s.last_substeps(), 0);
        assert_eq!(s.state_hash(), h0);
        s.step(5000.0);
        assert_eq!(s.last_substeps(), MAX_SUBSTEPS);
        assert_eq!(s.ticks(), MAX_SUBSTEPS as u64);
        for bad in [f32::NAN, f32::INFINITY, -5.0, f32::NEG_INFINITY] {
            s.step(bad);
            s.viewport(bad, bad);
            s.camera(bad, bad, bad);
            s.pointer(bad, bad, 0);
            s.click(bad, bad);
            assert!(s.all_finite());
        }
    }

    #[test]
    fn caps_hold_and_long_runs_stay_finite() {
        for src in [MOTES, SNOW, AURORA] {
            let mut s = Scene::load(src.as_bytes(), 3).unwrap();
            let cap = s.capacity();
            assert!(cap <= crate::scenefile::MAX_TOTAL as usize);
            s.viewport(1920.0, 1080.0);
            for k in 0..36_000 {
                // (10 minutes of scene time, with resizes, the pointer, clicks and wind on the way.)
                s.step(STEP_MS);
                if k % 5000 == 0 {
                    s.viewport(400.0 + k as f32 / 10.0, 300.0 + k as f32 / 20.0);
                    s.param(PARAM_WIND_X, (k % 3) as f32 * 40.0 - 40.0);
                }
                if k % 97 == 0 {
                    s.pointer((k % 800) as f32, (k % 500) as f32, 0);
                    s.click((k % 700) as f32, 200.0);
                }
                assert!(s.live() <= cap);
            }
            assert!(s.all_finite());
            assert!(s.live() > cap / 2, "the scene keeps itself populated: {} of {}", s.live(), cap);
            let d = s.instances();
            for k in 0..d.count() {
                let a = d.get(k, crate::drawlist::I_ALPHA);
                assert!(a > 0.0 && a <= 1.0);
                assert!((d.get(k, crate::drawlist::I_COLOUR) as usize) < s.roles());
            }
        }
    }

    #[test]
    fn pointer_and_click_reach_particles() {
        let mut a = Scene::load(MOTES.as_bytes(), 5).unwrap();
        let mut b = Scene::load(MOTES.as_bytes(), 5).unwrap();
        a.viewport(1280.0, 800.0);
        b.viewport(1280.0, 800.0);
        a.pointer(640.0, 400.0, 0);
        a.click(640.0, 400.0);
        for _ in 0..30 {
            a.step(STEP_MS);
            b.step(STEP_MS);
        }
        assert_ne!(a.state_hash(), b.state_hash(), "the pointer and the click changed the motion");
        let mut c = Scene::load(MOTES.as_bytes(), 5).unwrap();
        c.viewport(1280.0, 800.0);
        c.pointer(-5.0, 400.0, 0);
        c.click(99999.0, 1.0);
        for _ in 0..30 {
            c.step(STEP_MS);
        }
        assert_eq!(c.state_hash(), b.state_hash(), "outside the window: nothing");
    }

    #[test]
    fn params_groups_and_density() {
        let mut s = Scene::load(SNOW.as_bytes(), 4).unwrap();
        let full = s.live();
        assert!(s.param(PARAM_FILE, 0.25));
        assert_eq!(s.param_get(PARAM_FILE), Some(0.25));
        assert!(s.param(PARAM_FILE, 9.0));
        assert_eq!(s.param_get(PARAM_FILE), Some(1.0));
        assert!(!s.param(PARAM_FILE + 1, 1.0));
        assert!(s.group(0, 0.25, 2.0));
        assert!(!s.group(9, 1.0, 1.0));
        for _ in 0..60 * 80 {
            s.step(STEP_MS);
        }
        assert!(s.live() <= full / 4 + 4, "{} of {}", s.live(), full);
        // (The group's size doubles every flake.)
        let d = s.instances();
        assert!((0..d.count()).filter(|&k| d.get(k, crate::drawlist::I_SPRITE) != 4.0).all(|k| d.get(k, crate::drawlist::I_SX) >= 6.0));
        assert!(s.param(PARAM_SPEED, 0.0));
        let h = s.state_hash();
        s.step(100.0);
        assert_eq!(s.state_hash(), h);
        assert!(!s.param(99, 1.0) && !s.param(6, 1.0));
        assert!(s.param(PARAM_REACT, 9.0) && s.param_get(PARAM_REACT) == Some(3.0));
        assert!(s.param(PARAM_SPEED, f32::NAN));
        assert!(s.palette(0, 0x11223344) && !s.palette(99, 0));
        assert_eq!(s.palette_get(0), Some(0x11223344));
    }

    #[test]
    fn rain_splashes_ribbons_and_accumulation() {
        let text = br##"{"format":"ktscene/1","palette":["#ffffff","#88ccff"],
          "layers":[{"id":"sky","kind":"sky"},{"id":"au","kind":"ribbon","params":{"bands":2,"colours":[0,1]}},{"id":"snowbed","kind":"accum","params":{"h0":0,"h1":0.05,"grow":10}},{"id":"rain"},{"id":"rings"},{"id":"lake","kind":"mirror"}],
          "emitters":[{"id":"rain","layer":"rain","max":300,"rate":200,"align":true,"onDeath":{"emitter":"splash","count":1},
             "initializers":[{"kind":"lifetime","min":30,"max":30},{"kind":"velocity","min":[-60,600],"max":[-40,700]},{"kind":"sprite","id":2},{"kind":"stretch","min":8,"max":8}],
             "operators":[{"kind":"floor","y":0.9},{"kind":"bounds"}]},
            {"id":"splash","layer":"rings","max":200,"rate":0,"prewarm":0,"initializers":[{"kind":"lifetime","min":0.6,"max":0.6},{"kind":"size","min":4,"max":4},{"kind":"sprite","id":3}],
             "operators":[{"kind":"grow","rate":3},{"kind":"fade","in":0,"out":0.8}]}]}"##;
        let mut s = Scene::load(text, 2).unwrap();
        let splash_live = |s: &Scene| s.emitters[1].live;
        for _ in 0..120 {
            s.step(STEP_MS);
        }
        assert!(splash_live(&s) > 0, "rain meeting the floor made rings");
        // (The rings sit on the floor line and grow.)
        let d = s.instances();
        let rings: Vec<usize> = (0..d.count()).filter(|&k| d.get(k, crate::drawlist::I_SPRITE) == 3.0).collect();
        assert!(!rings.is_empty() && rings.iter().all(|&k| (d.get(k, I_Y) - 900.0).abs() < 1e-3 && d.get(k, crate::drawlist::I_SX) >= 4.0));
        // (Streaks turned along their fall: leaning with the wind, a little.)
        let rain: Vec<usize> = (0..d.count()).filter(|&k| d.get(k, crate::drawlist::I_SPRITE) == 2.0).collect();
        assert!(!rain.is_empty() && rain.iter().all(|&k| { let r = d.get(k, crate::drawlist::I_ROT); r > 0.0 && r < 0.2 }));
        // (Ribbons: two bands of points, moving.)
        let rb: Vec<usize> = (0..d.count()).filter(|&k| d.get(k, crate::drawlist::I_SPRITE) == 11.0).collect();
        assert!(rb.len() > RIBBON_POINTS);
        // (Settled snow grew; the mirror's command is there, not static.)
        assert!(s.geom(2)[0] < 1000.0);
        let c = s.instances().cmd_floats();
        assert_eq!((c[5 * CMD_STRIDE + C_KIND], c[5 * CMD_STRIDE + C_STATIC]), (10.0, 0.0));
        assert!(s.all_finite());
        for _ in 0..2000 {
            s.step(STEP_MS);
        }
        assert!(s.all_finite() && s.live() <= s.capacity());
    }

    #[test]
    fn a_full_scene_of_4096() {
        let em = (0..2).map(|k| format!("{{\"id\":\"e{k}\",\"max\":2048,\"rate\":200,\"initializers\":[{{\"kind\":\"lifetime\",\"min\":5,\"max\":9}},{{\"kind\":\"velocity\",\"min\":[-9,-9],\"max\":[9,9]}}],\"operators\":[{{\"kind\":\"drift\"}},{{\"kind\":\"gravity\",\"y\":3}},{{\"kind\":\"drag\",\"k\":0.3}},{{\"kind\":\"bounds\",\"mode\":\"kill\"}},{{\"kind\":\"fade\"}}]}}")).collect::<Vec<_>>().join(",");
        let text = format!("{{\"format\":\"ktscene/1\",\"emitters\":[{}]}}", em);
        let mut s = Scene::load(text.as_bytes(), 9).unwrap();
        assert_eq!(s.capacity(), 4096);
        for _ in 0..600 {
            s.step(STEP_MS);
            assert!(s.live() <= 4096);
        }
        assert!(s.all_finite());
    }

    #[test]
    fn the_pointer_pushes_and_the_path_springs_back() {
        // (Pushed by the pointer, then left alone: once the offsets have sprung back, the scene is EXACTLY the one that
        //  was never touched — the push moved where particles are drawn, never their paths.)
        let mut a = Scene::load(SNOW.as_bytes(), 5).unwrap();
        let mut b = Scene::load(SNOW.as_bytes(), 5).unwrap();
        a.viewport(1280.0, 800.0);
        b.viewport(1280.0, 800.0);
        for k in 0..240 {
            if k < 60 {
                a.pointer(640.0 + k as f32 * 3.0, 400.0, 0);
            } else if k == 60 {
                a.pointer(f32::NAN, f32::NAN, 0);
            }
            if k == 20 {
                a.click(600.0, 380.0);
            }
            a.step(1000.0 / 60.0);
            b.step(1000.0 / 60.0);
            if k == 59 {
                assert!(a.pool.dx.iter().any(|&d| d.abs() > 5.0), "pushed");
                assert_ne!(a.state_hash(), b.state_hash());
            }
        }
        assert!(a.pool.dx.iter().chain(a.pool.dy.iter()).all(|&d| d == 0.0), "all back on their paths");
        assert_eq!(a.state_hash(), b.state_hash());
    }

    #[test]
    fn round_four_operators_and_kinds() {
        let src = br##"{"format":"ktscene/1","palette":["#ffffff","#00ffff"],
          "layers":[{"id":"sh","kind":"shafts","params":{"count":4,"colour":1}},{"id":"ar","kind":"arcs","params":{"count":3,"colours":[1]}},{"id":"p"}],
          "emitters":[{"id":"f","layer":"p","max":50,"rate":0,"prewarm":1,"initializers":[{"kind":"lifetime","min":5,"max":9}],
            "operators":[{"kind":"twinkle","speed":1,"depth":0.9},{"kind":"swell","radius":300,"scale":1},{"kind":"gust","strength":80,"period":3}]},
            {"id":"stone","layer":"p","max":20,"rate":0,"prewarm":0,"onClick":{"count":3},"operators":[{"kind":"grow","rate":1}]}]}"##;
        let mut s = Scene::load(src, 2).unwrap();
        s.viewport(1600.0, 1000.0);
        assert_eq!((s.geom(0)[0], s.geom(0).len()), (4.0, 2 + 4 * 5 + 1));
        assert_eq!((s.geom(1)[0], s.geom(1).len()), (3.0, 2 + 3 * 8));
        let x0: f32 = s.pool.px[..50].iter().sum();
        s.click(800.0, 500.0);
        for _ in 0..60 {
            s.step(1000.0 / 60.0);
        }
        // (Gusts push sideways; the click gave birth to three stones; blinking dims some.)
        let x1: f32 = s.pool.px[..50].iter().sum();
        assert!(x1 > x0 + 50.0);
        assert_eq!(s.emitters[1].live, 3);
        let d = s.instances();
        let alphas: Vec<f32> = (0..d.count()).map(|k| d.get(k, crate::drawlist::I_ALPHA)).collect();
        assert!(alphas.iter().any(|&a| a < 0.5) && alphas.iter().all(|a| a.is_finite()));
        // (Swelling: near the pointer, larger.)
        let before: f32 = (0..d.count()).map(|k| d.get(k, crate::drawlist::I_SX)).sum();
        s.pointer(800.0, 500.0, 0);
        s.step(0.0);
        let d = s.instances();
        let after: f32 = (0..d.count()).map(|k| d.get(k, crate::drawlist::I_SX)).sum();
        assert!(after > before);
    }

    #[test]
    fn every_bundled_scene_reads_and_runs() {
        // (Every file in src/theme/scenes: read with nothing unknown, run 6 s with a pointer and a click, finite,
        //  within the caps. Under cargo only — the standalone rustc runs have no manifest directory.)
        let Some(dir) = option_env!("CARGO_MANIFEST_DIR") else { return };
        let mut n = 0;
        for f in std::fs::read_dir(format!("{dir}/../../src/theme/scenes")).unwrap() {
            let path = f.unwrap().path();
            if path.extension().map(|e| e != "json").unwrap_or(true) {
                continue;
            }
            let bytes = std::fs::read(&path).unwrap();
            let name = path.display().to_string();
            let d = crate::scenefile::read(&bytes).expect(&name);
            assert!(d.layers.iter().all(|l| !matches!(l.kind, crate::scenefile::LayerKind::Unknown(_))), "{name}");
            assert!(d.emitters.iter().all(|e| e.ops.iter().all(|o| !matches!(o, crate::scenefile::Op::Unknown(_))) && e.inits.iter().all(|i| !matches!(i, crate::scenefile::Init::Unknown(_)))), "{name}");
            let text = String::from_utf8_lossy(&bytes).to_lowercase();
            assert!(!text.contains("\"pine") && !text.contains("\"tree") && !text.contains("forest"), "no trees: {name}");
            let mut s = Scene::load(&bytes, 9).expect(&name);
            s.viewport(1280.0, 800.0);
            for k in 0..360 {
                if k == 100 {
                    s.pointer(500.0, 400.0, 0);
                }
                if k == 150 {
                    s.click(640.0, 500.0);
                }
                s.step(1000.0 / 60.0);
            }
            assert!(s.all_finite() && s.live() <= 4096 && s.instances().count() > 0, "{name}");
            n += 1;
        }
        assert!(n >= 15, "{n} scenes");
    }

    #[test]
    fn hydro_rings_from_a_click() {
        // (Hydro, data only: a click drops three rings (2 + 1 inner) that grow and fade; untouched, it stays alive.)
        const HYDRO: &str = include_str!("../../../src/theme/scenes/hydro.json");
        let mut a = Scene::load(HYDRO.as_bytes(), 5).unwrap();
        let mut b = Scene::load(HYDRO.as_bytes(), 5).unwrap();
        for s in [&mut a, &mut b] {
            s.viewport(1280.0, 800.0);
            for _ in 0..120 {
                s.step(1000.0 / 60.0);
            }
        }
        let base = a.live();
        assert!(base > 100, "{base}");
        b.click(640.0, 560.0);
        a.step(1000.0 / 60.0);
        b.step(1000.0 / 60.0);
        assert_eq!(b.live(), a.live() + 3, "a click drops three rings");
        assert_ne!(a.state_hash(), b.state_hash());
        for _ in 0..(60 * 5) {
            a.step(1000.0 / 60.0);
            b.step(1000.0 / 60.0);
        }
        // (Five seconds on: the rings have grown, faded and gone; nothing is left behind.)
        assert!(b.all_finite() && b.live() <= a.live() + 1, "{} {}", b.live(), a.live());
    }
}
