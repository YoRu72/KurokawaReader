//! Particles, struct-of-arrays: one pool for the whole scene, allocated once at load (the sum of the emitters' `max`);
//! each emitter owns a fixed slice of it, its live particles packed at the slice's front (a death swaps the last live
//! one in). Births follow the emitter's initializers in order — a tagged list from the scene file, so a new scene is
//! data, not code. Nothing here allocates after `Pool::new` / `Emitter::new`.
//! Standalone: `rustc --edition 2021 --test --cfg 'kt_alone="particles"' src/particles.rs`.

#[cfg(kt_alone = "particles")]
#[path = "math.rs"]
mod math;
#[cfg(kt_alone = "particles")]
#[path = "scenefile.rs"]
mod scenefile;

use crate::math::{clampf, Pcg32};
use crate::scenefile::{Init, Op, Shape};

/// Every particle's values, one array per field.
pub struct Pool {
    pub px: Vec<f32>,
    pub py: Vec<f32>,
    pub vx: Vec<f32>,
    pub vy: Vec<f32>,
    /// Seconds lived, and the life it was born with.
    pub age: Vec<f32>,
    pub life: Vec<f32>,
    pub size: Vec<f32>,
    pub rot: Vec<f32>,
    pub spin: Vec<f32>,
    pub alpha: Vec<f32>,
    pub colour: Vec<u8>,
    pub sprite: Vec<u8>,
}

impl Pool {
    pub fn new(n: usize) -> Pool {
        let f = || vec![0.0f32; n];
        Pool { px: f(), py: f(), vx: f(), vy: f(), age: f(), life: f(), size: f(), rot: f(), spin: f(), alpha: f(), colour: vec![0; n], sprite: vec![0; n] }
    }
    pub fn len(&self) -> usize {
        self.px.len()
    }
    pub fn is_empty(&self) -> bool {
        self.px.is_empty()
    }
    /// Copies particle `from` over `to` (both in one emitter's slice).
    fn copy(&mut self, from: usize, to: usize) {
        macro_rules! mv {
            ($($f:ident),*) => { $( self.$f[to] = self.$f[from]; )* };
        }
        mv!(px, py, vx, vy, age, life, size, rot, spin, alpha, colour, sprite);
    }
}

/// An emitter: its slice of the pool, its birth rate, its initializers and operators.
pub struct Emitter {
    pub start: usize,
    pub max: usize,
    pub live: usize,
    pub layer: usize,
    /// Births a second, and the fraction of a birth carried to the next step.
    pub rate: f32,
    pub carry: f32,
    pub prewarm: f32,
    pub shape: Shape,
    pub inits: Vec<Init>,
    pub ops: Vec<Op>,
}

/// The viewport, CSS pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct View {
    pub w: f32,
    pub h: f32,
}

impl Emitter {
    /// The particles alive now: `start .. start + live`.
    pub fn range(&self) -> core::ops::Range<usize> {
        self.start..self.start + self.live
    }

    /// One particle born (when there is room under `limit`); its values from the initializers, in order.
    pub fn spawn(&mut self, pool: &mut Pool, rng: &mut Pcg32, view: View, limit: usize) -> bool {
        if self.live >= self.max.min(limit) {
            return false;
        }
        let i = self.start + self.live;
        if i >= pool.len() {
            return false;
        }
        self.live += 1;
        let s = self.shape;
        pool.px[i] = (s.x + s.w * rng.next_f32()) * view.w;
        pool.py[i] = (s.y + s.h * rng.next_f32()) * view.h;
        pool.vx[i] = 0.0;
        pool.vy[i] = 0.0;
        pool.age[i] = 0.0;
        pool.life[i] = 5.0;
        pool.size[i] = 3.0;
        pool.rot[i] = 0.0;
        pool.spin[i] = 0.0;
        pool.alpha[i] = 1.0;
        pool.colour[i] = 0;
        pool.sprite[i] = 0;
        for init in &self.inits {
            match init {
                Init::Lifetime { min, max } => pool.life[i] = rng.range(*min, *max).max(0.05),
                Init::Size { min, max } => pool.size[i] = rng.range(*min, *max),
                Init::Alpha { min, max } => pool.alpha[i] = clampf(rng.range(*min, *max), 0.0, 1.0),
                Init::Rotation { min, max } => pool.rot[i] = rng.range(*min, *max),
                Init::Spin { min, max } => pool.spin[i] = rng.range(*min, *max),
                Init::Velocity { min, max } => {
                    pool.vx[i] = rng.range(min[0], max[0]);
                    pool.vy[i] = rng.range(min[1], max[1]);
                }
                Init::Colour { roles } => {
                    if !roles.is_empty() {
                        pool.colour[i] = roles[rng.below(roles.len() as u32) as usize];
                    }
                }
                Init::Sprite { id } => pool.sprite[i] = *id,
                Init::Unknown(_) => {}
            }
        }
        true
    }

    /// The share `prewarm` of `max` (under `limit`) placed at once, each at a random age of its life: the scene starts
    /// as it looks after running a while, not empty.
    pub fn prewarm(&mut self, pool: &mut Pool, rng: &mut Pcg32, view: View, limit: usize) {
        let n = ((self.max as f32) * clampf(self.prewarm, 0.0, 1.0)) as usize;
        for _ in 0..n {
            if !self.spawn(pool, rng, view, limit) {
                break;
            }
            let i = self.start + self.live - 1;
            pool.age[i] = pool.life[i] * rng.next_f32();
        }
    }

    /// New births for `dt` seconds at the emitter's rate (up to `limit` alive).
    pub fn emit(&mut self, pool: &mut Pool, rng: &mut Pcg32, view: View, dt: f32, limit: usize) {
        self.carry += self.rate * dt;
        // (Never a backlog: a long pause does not burst particles out after it.)
        if self.carry > 4.0 {
            self.carry = 4.0;
        }
        while self.carry >= 1.0 {
            self.carry -= 1.0;
            if !self.spawn(pool, rng, view, limit) {
                self.carry = 0.0;
                break;
            }
        }
    }

    /// Particles older than their life removed (the last live one moved into each gap).
    pub fn reap(&mut self, pool: &mut Pool) {
        let mut k = self.live;
        while k > 0 {
            k -= 1;
            let i = self.start + k;
            if pool.age[i] >= pool.life[i] {
                let last = self.start + self.live - 1;
                if i != last {
                    pool.copy(last, i);
                }
                self.live -= 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn em(start: usize, max: usize, inits: Vec<Init>) -> Emitter {
        Emitter { start, max, live: 0, layer: 0, rate: 10.0, carry: 0.0, prewarm: 1.0, shape: Shape { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }, inits, ops: vec![] }
    }

    #[test]
    fn births_follow_initializers_within_the_slice() {
        let mut pool = Pool::new(30);
        let mut rng = Pcg32::new(1, 2);
        let view = View { w: 200.0, h: 100.0 };
        let mut e = em(10, 20, vec![Init::Size { min: 2.0, max: 3.0 }, Init::Colour { roles: vec![2, 3] }, Init::Velocity { min: [-1.0, 5.0], max: [1.0, 6.0] }, Init::Unknown("x".into())]);
        for _ in 0..25 {
            e.spawn(&mut pool, &mut rng, view, usize::MAX);
        }
        assert_eq!(e.live, 20);
        for i in e.range() {
            assert!((2.0..3.0).contains(&pool.size[i]));
            assert!(pool.colour[i] == 2 || pool.colour[i] == 3);
            assert!((5.0..6.0).contains(&pool.vy[i]));
            assert!((0.0..200.0).contains(&pool.px[i]) && (0.0..100.0).contains(&pool.py[i]));
        }
        // (Nothing written outside its slice.)
        assert!(pool.size[..10].iter().all(|&s| s == 0.0));
    }

    #[test]
    fn reaping_keeps_live_ones_packed() {
        let mut pool = Pool::new(8);
        let mut rng = Pcg32::new(3, 4);
        let view = View { w: 10.0, h: 10.0 };
        let mut e = em(0, 8, vec![Init::Lifetime { min: 1.0, max: 1.0 }]);
        for _ in 0..8 {
            e.spawn(&mut pool, &mut rng, view, usize::MAX);
        }
        for (k, i) in e.range().enumerate() {
            pool.age[i] = if k % 2 == 0 { 2.0 } else { 0.5 };
            pool.size[i] = k as f32;
        }
        e.reap(&mut pool);
        assert_eq!(e.live, 4);
        let mut kept: Vec<f32> = e.range().map(|i| pool.size[i]).collect();
        kept.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(kept, vec![1.0, 3.0, 5.0, 7.0]);
    }

    #[test]
    fn emission_is_rate_bound_and_limited() {
        let mut pool = Pool::new(100);
        let mut rng = Pcg32::new(5, 6);
        let view = View { w: 10.0, h: 10.0 };
        let mut e = em(0, 100, vec![]);
        e.rate = 30.0;
        for _ in 0..60 {
            e.emit(&mut pool, &mut rng, view, 1.0 / 60.0, 40);
        }
        assert_eq!(e.live, 30);
        for _ in 0..600 {
            e.emit(&mut pool, &mut rng, view, 1.0 / 60.0, 40);
        }
        assert_eq!(e.live, 40);
        let mut p = em(0, 100, vec![Init::Lifetime { min: 4.0, max: 8.0 }]);
        p.prewarm = 0.5;
        let mut pool2 = Pool::new(100);
        p.prewarm(&mut pool2, &mut rng, view, usize::MAX);
        assert_eq!(p.live, 50);
        assert!(p.range().all(|i| pool2.age[i] < pool2.life[i]));
    }
}
