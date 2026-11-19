//! Numbers for the scene engine: a 2D vector, a seeded random stream (PCG32), smooth value noise and a state hash.
//!
//! Determinism: everything the simulation computes goes through IEEE-754 basic operations only (+ − × ÷, floor,
//! comparisons) — no sin, cos, exp or pow, whose results differ between the native library and wasm's — so the same
//! scene file, seed and steps give the same bits natively (the tests) and in the page (wasm32). Standalone: no
//! siblings used; `rustc --edition 2021 --test src/math.rs`.

/// A 2D vector (CSS pixels, or pixels a second).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

impl Vec2 {
    pub const fn new(x: f32, y: f32) -> Vec2 {
        Vec2 { x, y }
    }
    pub fn plus(self, o: Vec2) -> Vec2 {
        Vec2::new(self.x + o.x, self.y + o.y)
    }
    pub fn minus(self, o: Vec2) -> Vec2 {
        Vec2::new(self.x - o.x, self.y - o.y)
    }
    pub fn scale(self, k: f32) -> Vec2 {
        Vec2::new(self.x * k, self.y * k)
    }
    pub fn len2(self) -> f32 {
        self.x * self.x + self.y * self.y
    }
}

/// PCG32 (XSH RR, 64-bit state): small, fast, and the same numbers everywhere.
#[derive(Clone, Debug)]
pub struct Pcg32 {
    state: u64,
    inc: u64,
}

impl Pcg32 {
    const MUL: u64 = 6364136223846793005;
    pub fn new(seed: u64, stream: u64) -> Pcg32 {
        let mut r = Pcg32 { state: 0, inc: (stream << 1) | 1 };
        r.next_u32();
        r.state = r.state.wrapping_add(seed);
        r.next_u32();
        r
    }
    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old.wrapping_mul(Self::MUL).wrapping_add(self.inc);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }
    /// In [0, 1): 24 bits, exact in f32.
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / 16_777_216.0)
    }
    /// In [a, b) (or [b, a)).
    pub fn range(&mut self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.next_f32()
    }
    /// An index in [0, n) (0 when n is 0).
    pub fn below(&mut self, n: u32) -> u32 {
        if n == 0 {
            return 0;
        }
        ((self.next_u32() as u64 * n as u64) >> 32) as u32
    }
    pub fn state_bits(&self) -> (u64, u64) {
        (self.state, self.inc)
    }
}

/// A finite number kept within [lo, hi]; NaN gives lo.
pub fn clampf(v: f32, lo: f32, hi: f32) -> f32 {
    if v.is_nan() || v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

/// An integer hash of a lattice point (a few multiply-xorshift rounds).
fn hash3(seed: u32, x: i32, y: i32, z: i32) -> u32 {
    let mut h = seed ^ 0x9E37_79B9;
    h = (h ^ (x as u32)).wrapping_mul(0x85EB_CA6B);
    h ^= h >> 13;
    h = (h ^ (y as u32)).wrapping_mul(0xC2B2_AE35);
    h ^= h >> 16;
    h = (h ^ (z as u32)).wrapping_mul(0x27D4_EB2F);
    h ^= h >> 15;
    h = h.wrapping_mul(0x1656_67B1);
    h ^ (h >> 16)
}

/// The lattice value in [-1, 1].
fn lattice(seed: u32, x: i32, y: i32, z: i32) -> f32 {
    (hash3(seed, x, y, z) >> 8) as f32 * (2.0 / 16_777_215.0) - 1.0
}

/// Quintic fade (C2-smooth: no visible creases in the motion).
fn fade(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

/// A lattice coordinate: its cell and the place inside it (inputs far beyond ±2^24 are clamped first).
fn cell(v: f32) -> (i32, f32) {
    let v = clampf(v, -16_000_000.0, 16_000_000.0);
    let f = v.floor();
    (f as i32, v - f)
}

/// Smooth 3D value noise in [-1, 1] (x, y in space, z in time).
pub fn noise3(seed: u32, x: f32, y: f32, z: f32) -> f32 {
    let (ix, fx) = cell(x);
    let (iy, fy) = cell(y);
    let (iz, fz) = cell(z);
    let (u, v, w) = (fade(fx), fade(fy), fade(fz));
    let l = |dx: i32, dy: i32, dz: i32| lattice(seed, ix.wrapping_add(dx), iy.wrapping_add(dy), iz.wrapping_add(dz));
    let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
    let x00 = lerp(l(0, 0, 0), l(1, 0, 0), u);
    let x10 = lerp(l(0, 1, 0), l(1, 1, 0), u);
    let x01 = lerp(l(0, 0, 1), l(1, 0, 1), u);
    let x11 = lerp(l(0, 1, 1), l(1, 1, 1), u);
    lerp(lerp(x00, x10, v), lerp(x01, x11, v), w)
}

/// FNV-1a (64-bit) over words: the state hash the tests compare.
#[derive(Clone, Debug)]
pub struct Fnv(pub u64);

impl Fnv {
    pub fn new() -> Fnv {
        Fnv(0xcbf2_9ce4_8422_2325)
    }
    pub fn u32(&mut self, v: u32) {
        for b in v.to_le_bytes() {
            self.0 ^= b as u64;
            self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
        }
    }
    pub fn u64(&mut self, v: u64) {
        self.u32(v as u32);
        self.u32((v >> 32) as u32);
    }
    pub fn f32(&mut self, v: f32) {
        self.u32(v.to_bits());
    }
    /// Folded to 32 bits (JavaScript reads an i32/u32 from wasm without BigInt).
    pub fn fold(&self) -> u32 {
        (self.0 ^ (self.0 >> 32)) as u32
    }
}

impl Default for Fnv {
    fn default() -> Self {
        Fnv::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcg_is_deterministic_and_streams_differ() {
        let mut a = Pcg32::new(42, 54);
        let mut b = Pcg32::new(42, 54);
        let mut c = Pcg32::new(42, 55);
        let va: Vec<u32> = (0..64).map(|_| a.next_u32()).collect();
        let vb: Vec<u32> = (0..64).map(|_| b.next_u32()).collect();
        let vc: Vec<u32> = (0..64).map(|_| c.next_u32()).collect();
        assert_eq!(va, vb);
        assert_ne!(va, vc);
        // (PCG32's published first outputs for seed 42, stream 54.)
        assert_eq!(&va[..3], &[0xa15c02b7, 0x7b47f409, 0xba1d3330]);
    }

    #[test]
    fn floats_stay_in_range() {
        let mut r = Pcg32::new(7, 1);
        for _ in 0..100_000 {
            let f = r.next_f32();
            assert!((0.0..1.0).contains(&f));
            let g = r.range(-3.0, 5.0);
            assert!((-3.0..5.0).contains(&g));
            assert!(r.below(7) < 7);
        }
        assert_eq!(r.below(0), 0);
    }

    #[test]
    fn noise_is_bounded_smooth_and_seeded() {
        let mut max_step = 0.0f32;
        let mut prev = noise3(1, 0.0, 0.3, 0.7);
        for i in 1..20_000 {
            let x = i as f32 * 0.001;
            let n = noise3(1, x, 0.3, 0.7);
            assert!((-1.0..=1.0).contains(&n), "{n}");
            max_step = max_step.max((n - prev).abs());
            prev = n;
        }
        // (A step of 0.001 never jumps: smooth.)
        assert!(max_step < 0.01, "{max_step}");
        assert_ne!(noise3(1, 0.5, 0.5, 0.5), noise3(2, 0.5, 0.5, 0.5));
        assert_eq!(noise3(3, 1.25, -7.5, 9.0), noise3(3, 1.25, -7.5, 9.0));
        // (Huge and odd inputs: finite.)
        for v in [f32::MAX, f32::MIN, f32::NAN, f32::INFINITY, -1e30, 1e30] {
            assert!(noise3(9, v, v, v).is_finite());
        }
    }

    #[test]
    fn clamp_takes_nan_to_the_floor() {
        assert_eq!(clampf(f32::NAN, 1.0, 2.0), 1.0);
        assert_eq!(clampf(9.0, 1.0, 2.0), 2.0);
        assert_eq!(clampf(-9.0, 1.0, 2.0), 1.0);
        assert_eq!(clampf(1.5, 1.0, 2.0), 1.5);
    }

    #[test]
    fn vectors_and_hash() {
        let v = Vec2::new(3.0, 4.0).plus(Vec2::new(1.0, 1.0)).minus(Vec2::new(1.0, 1.0)).scale(2.0);
        assert_eq!(v, Vec2::new(6.0, 8.0));
        assert_eq!(v.len2(), 100.0);
        let mut h = Fnv::new();
        h.f32(1.5);
        h.u64(7);
        let mut g = Fnv::new();
        g.f32(1.5);
        g.u64(7);
        assert_eq!(h.fold(), g.fold());
        g.u32(0);
        assert_ne!(h.fold(), g.fold());
    }
}
