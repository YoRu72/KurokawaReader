//! A running scene: the file read once, the pool, emitters, layers and draw list allocated once, and a fixed clock —
//! steps of 1/60 s, at most 4 per call (a long gap is dropped, not caught up) — so the same file, seed and calls give
//! the same state, natively and in wasm. No allocation after `load`.
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
#[path = "math.rs"]
mod math;
#[cfg(kt_alone = "scene")]
#[path = "particles.rs"]
mod particles;
#[cfg(kt_alone = "scene")]
#[path = "scenefile.rs"]
mod scenefile;

use crate::drawlist::{DrawList, Inst};
use crate::forces::{accelerate, constrain, fade, integrate};
use crate::graph::Graph;
use crate::math::{clampf, Fnv, Pcg32};
use crate::particles::{Emitter, Pool, View};
use crate::scenefile::{read, SceneDef, MAX_ROLES};

/// One fixed step, milliseconds and seconds.
pub const STEP_MS: f32 = 1000.0 / 60.0;
pub const STEP_S: f32 = 1.0 / 60.0;
/// Fixed steps at most per `step` call.
pub const MAX_SUBSTEPS: u32 = 4;
/// The viewport before the page gives one (CSS pixels), and its limits.
pub const DEFAULT_VIEW: View = View { w: 1280.0, h: 800.0 };
pub const MAX_VIEW: f32 = 16384.0;
/// Drawn only when at least this visible.
const MIN_ALPHA: f32 = 1.0 / 512.0;

/// Parameters the page sets (`scene_param`).
pub const PARAM_SPEED: u32 = 0;
pub const PARAM_DENSITY: u32 = 1;

pub struct Scene {
    pub def_fps: f32,
    pub def_resolution: f32,
    roles: usize,
    palette: [u32; MAX_ROLES],
    pool: Pool,
    emitters: Vec<Emitter>,
    graph: Graph,
    draw: DrawList,
    rng: Pcg32,
    seed: u32,
    view: View,
    /// Scene time (seconds) and fixed steps taken.
    time: f64,
    ticks: u64,
    acc_ms: f32,
    speed: f32,
    density: f32,
    last_substeps: u32,
}

impl Scene {
    /// A scene from its file's bytes (an `ERR_*` code when the file is refused).
    pub fn load(bytes: &[u8], seed: u32) -> Result<Scene, i32> {
        let def = read(bytes)?;
        Ok(Scene::from_def(&def, seed))
    }

    pub fn from_def(def: &SceneDef, seed: u32) -> Scene {
        let total: usize = def.emitters.iter().map(|e| e.max as usize).sum();
        let mut start = 0;
        let mut emitters = Vec::with_capacity(def.emitters.len());
        for e in &def.emitters {
            emitters.push(Emitter { start, max: e.max as usize, live: 0, layer: e.layer, rate: e.rate, carry: 0.0, prewarm: e.prewarm, shape: e.shape, inits: e.inits.clone(), ops: e.ops.clone() });
            start += e.max as usize;
        }
        let layers: Vec<(f32, f32)> = def.layers.iter().map(|l| (l.depth, l.opacity)).collect();
        let graph = Graph::new(&layers, &emitters.iter().map(|e| e.layer).collect::<Vec<_>>());
        let mut s = Scene {
            def_fps: def.fps,
            def_resolution: def.resolution,
            roles: def.roles.len().min(MAX_ROLES),
            palette: [0; MAX_ROLES],
            pool: Pool::new(total),
            emitters,
            graph,
            draw: DrawList::new(total),
            rng: Pcg32::new(seed as u64, 0x6b74_7363),
            seed,
            view: DEFAULT_VIEW,
            time: 0.0,
            ticks: 0,
            acc_ms: 0.0,
            speed: 1.0,
            density: 1.0,
            last_substeps: 0,
        };
        // (Density is 1 at load: each emitter up to its own max.)
        for e in s.emitters.iter_mut() {
            e.prewarm(&mut s.pool, &mut s.rng, s.view, usize::MAX);
        }
        s.fill();
        s
    }

    /// The live particles allowed in emitter `e` at the present density.
    fn limit_of(&self, e: usize) -> usize {
        let max = self.emitters.get(e).map(|x| x.max).unwrap_or(0);
        ((max as f32) * self.density + 0.5) as usize
    }

    /// The viewport (CSS pixels). Particles keep their place as a share of it.
    pub fn viewport(&mut self, w: f32, h: f32) {
        let w = clampf(w, 1.0, MAX_VIEW);
        let h = clampf(h, 1.0, MAX_VIEW);
        let (kx, ky) = (w / self.view.w, h / self.view.h);
        if kx != 1.0 || ky != 1.0 {
            for e in &self.emitters {
                for i in e.range() {
                    self.pool.px[i] *= kx;
                    self.pool.py[i] *= ky;
                }
            }
        }
        self.view = View { w, h };
        self.fill();
    }

    /// A theme colour for role `i` (0xRRGGBBAA); false when there is no such role.
    pub fn palette(&mut self, i: u32, rgba: u32) -> bool {
        if (i as usize) < self.roles {
            self.palette[i as usize] = rgba;
            true
        } else {
            false
        }
    }
    pub fn roles(&self) -> usize {
        self.roles
    }

    /// Speed (0–4: 1 normal, 0.5 Reduced, 0 stopped) or density (0–1 of each emitter's max).
    pub fn param(&mut self, id: u32, v: f32) -> bool {
        match id {
            PARAM_SPEED => self.speed = clampf(v, 0.0, 4.0),
            PARAM_DENSITY => self.density = clampf(v, 0.0, 1.0),
            _ => return false,
        }
        true
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
        let (dt, t, seed, view) = (STEP_S, self.time, self.seed, self.view);
        for k in 0..self.emitters.len() {
            let limit = self.limit_of(k);
            let e = &mut self.emitters[k];
            accelerate(&e.ops, &mut self.pool, e.range(), dt, t, seed.wrapping_add(k as u32 * 0x9E37));
            integrate(&mut self.pool, e.range(), dt);
            constrain(&e.ops, &mut self.pool, e.range(), view);
            e.reap(&mut self.pool);
            e.emit(&mut self.pool, &mut self.rng, view, dt, limit);
        }
        self.ticks += 1;
        self.time = self.ticks as f64 / 60.0;
    }

    /// The draw list: far layers first, each particle's alpha with its fade and its layer's opacity.
    fn fill(&mut self) {
        self.draw.clear();
        for &li in &self.graph.order {
            let layer = &self.graph.layers[li];
            for &ei in &layer.emitters {
                let e = &self.emitters[ei];
                for i in e.range() {
                    let p = &self.pool;
                    let a = p.alpha[i] * fade(&e.ops, p.age[i], p.life[i]) * layer.opacity;
                    #[allow(clippy::neg_cmp_op_on_partial_ord)]
                    if !(a >= MIN_ALPHA) || !(p.size[i] > 0.0) {
                        continue;
                    }
                    self.draw.push(Inst { x: p.px[i], y: p.py[i], size: p.size[i], rot: p.rot[i], alpha: a, sprite: p.sprite[i], colour: p.colour[i], depth: layer.depth });
                }
            }
        }
    }

    pub fn instances(&self) -> &DrawList {
        &self.draw
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

    /// A hash of everything the simulation holds (positions, velocities, ages…, the random stream, the clock): two
    /// runs agree exactly or not at all.
    pub fn state_hash(&self) -> u32 {
        let mut h = Fnv::new();
        h.u64(self.ticks);
        h.f32(self.acc_ms);
        let (a, b) = self.rng.state_bits();
        h.u64(a);
        h.u64(b);
        for e in &self.emitters {
            h.u32(e.live as u32);
            h.f32(e.carry);
            let p = &self.pool;
            for i in e.range() {
                for v in [p.px[i], p.py[i], p.vx[i], p.vy[i], p.age[i], p.life[i], p.size[i], p.rot[i], p.spin[i], p.alpha[i]] {
                    h.f32(v);
                }
                h.u32(p.colour[i] as u32 | (p.sprite[i] as u32) << 8);
            }
        }
        h.fold()
    }

    /// Every live particle's values finite (the tests' check after long runs).
    pub fn all_finite(&self) -> bool {
        let p = &self.pool;
        self.emitters.iter().all(|e| e.range().all(|i| [p.px[i], p.py[i], p.vx[i], p.vy[i], p.age[i], p.life[i], p.size[i], p.rot[i], p.alpha[i]].iter().all(|v| v.is_finite())))
            && self.draw.floats().iter().all(|v| v.is_finite())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MOTES: &str = include_str!("../../../src/theme/scenes/motes.json");

    #[test]
    fn same_seed_same_state() {
        let mut a = Scene::load(MOTES.as_bytes(), 7).unwrap();
        let mut b = Scene::load(MOTES.as_bytes(), 7).unwrap();
        let mut c = Scene::load(MOTES.as_bytes(), 8).unwrap();
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
        // (The same time in other frame gaps: the same fixed steps → the same state.)
        let mut d = Scene::load(MOTES.as_bytes(), 7).unwrap();
        let mut e = Scene::load(MOTES.as_bytes(), 7).unwrap();
        for _ in 0..120 {
            d.step(STEP_MS * 2.0);
        }
        for _ in 0..240 {
            e.step(STEP_MS);
        }
        assert_eq!(d.ticks(), e.ticks());
        assert_eq!(d.state_hash(), e.state_hash());
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
            assert!(s.all_finite());
        }
    }

    #[test]
    fn caps_hold_and_long_runs_stay_finite() {
        let mut s = Scene::load(MOTES.as_bytes(), 3).unwrap();
        let cap = s.capacity();
        assert!(cap <= crate::scenefile::MAX_TOTAL as usize);
        s.viewport(1920.0, 1080.0);
        for k in 0..36_000 {
            // (10 minutes of scene time, with resizes and speed changes on the way.)
            s.step(STEP_MS);
            if k % 5000 == 0 {
                s.viewport(400.0 + k as f32 / 10.0, 300.0 + k as f32 / 20.0);
            }
            assert!(s.live() <= cap);
            assert!(s.instances().count() <= cap);
        }
        assert!(s.all_finite());
        assert!(s.live() > cap / 2, "the scene keeps itself populated: {} of {}", s.live(), cap);
        // (Every instance inside the viewport and its margin, alpha 0–1, its colour a role.)
        let f = s.instances().floats();
        for k in 0..s.instances().count() {
            let v = &f[k * 8..k * 8 + 8];
            assert!(v[0] >= -41.0 && v[0] <= s.view.w + 41.0 && v[1] >= -41.0 && v[1] <= s.view.h + 41.0, "{v:?}");
            assert!(v[4] > 0.0 && v[4] <= 1.0);
            assert!((v[6] as usize) < s.roles());
        }
    }

    #[test]
    fn density_and_speed() {
        let mut s = Scene::load(MOTES.as_bytes(), 4).unwrap();
        let full = s.live();
        assert!(s.param(PARAM_DENSITY, 0.25));
        for _ in 0..60 * 30 {
            s.step(STEP_MS);
        }
        assert!(s.live() <= full / 4 + 3, "{} of {}", s.live(), full);
        assert!(s.param(PARAM_SPEED, 0.0));
        let h = s.state_hash();
        s.step(100.0);
        assert_eq!(s.state_hash(), h);
        assert!(!s.param(99, 1.0));
        assert!(s.param(PARAM_SPEED, f32::NAN));
        assert!(s.palette(0, 0x11223344) && !s.palette(8, 0));
    }

    #[test]
    fn a_full_scene_of_4096() {
        let em = (0..2).map(|_| "{\"max\":2048,\"rate\":200,\"initializers\":[{\"kind\":\"lifetime\",\"min\":5,\"max\":9},{\"kind\":\"velocity\",\"min\":[-9,-9],\"max\":[9,9]}],\"operators\":[{\"kind\":\"drift\"},{\"kind\":\"gravity\",\"y\":3},{\"kind\":\"drag\",\"k\":0.3},{\"kind\":\"bounds\",\"mode\":\"kill\"},{\"kind\":\"fade\"}]}").collect::<Vec<_>>().join(",");
        let text = format!("{{\"format\":\"ktscene/1\",\"emitters\":[{}]}}", em);
        let mut s = Scene::load(text.as_bytes(), 9).unwrap();
        assert_eq!(s.capacity(), 4096);
        for _ in 0..600 {
            s.step(STEP_MS);
            assert!(s.live() <= 4096);
        }
        assert!(s.all_finite());
    }
}
