//! The words taken off the picture behind them (stage M4): KtInpaint.java's rules — the background guessed from the
//! block's four edges (median-smoothed, blended by a Coons patch), every pixel far from the guess and two around it
//! replaced by the guess, then softened twice — on ARGB words, with the same doubles in the same order as Java (IEEE
//! 754 both sides, no fused multiply-add: the same pixels; the tolerance the Java side allows is KtScreenRs.PIXEL_TOL).
//!
//! Beside it, a new mechanism behind the Rust switch only: `PatchCache`, the cleaned patch kept by the patch's exact
//! bytes, so a balloon read again on a page that has not changed (auto mode reads the screen every few hundred
//! milliseconds) costs a comparison instead of the whole clean. The key is the patch's bytes themselves (a hash finds
//! the slot, the bytes are compared), so a hit is the same answer by construction. Std only; `rustc --edition 2021
//! --test inpaint.rs`.

/// KtInpaint.clean: `px` (w × h ARGB words; a longer buffer keeps its tail as it was) with its text taken off.
pub fn clean(px: &[u32], w: usize, h: usize) -> Vec<u32> {
    if w < 4 || h < 4 || px.len() < w * h {
        return px.to_vec();
    }
    let top = edge(px, w, h, 0);
    let bottom = edge(px, w, h, 1);
    let left = edge(px, w, h, 2);
    let right = edge(px, w, h, 3);
    let mut guess = vec![0u32; w * h];
    let us: Vec<f64> = (0..w).map(|x| x as f64 / (w - 1) as f64).collect();
    for y in 0..h {
        let v = y as f64 / (h - 1) as f64;
        let row = y * w;
        for x in 0..w {
            let u = us[x];
            // (The corner weights, the same products Java forms for each channel, formed once.)
            let (k00, k10, k01, k11) = ((1.0 - u) * (1.0 - v), u * (1.0 - v), (1.0 - u) * v, u * v);
            let mut out: u32 = 0xFF000000;
            for c in 0..3 {
                let (t, b, l, r) = (&top[c], &bottom[c], &left[c], &right[c]);
                let e = (1.0 - v) * t[x] as f64 + v * b[x] as f64 + (1.0 - u) * l[y] as f64 + u * r[y] as f64
                    - (k00 * t[0] as f64 + k10 * t[w - 1] as f64 + k01 * b[0] as f64 + k11 * b[w - 1] as f64);
                let k = round_up((0.0f64).max((255.0f64).min(e)));
                out |= k << (16 - 8 * c);
            }
            guess[row + x] = out;
        }
    }
    // (The letters: far from the guess; grown by two pixels each way — done as two passes of five, the same square.)
    let ink: Vec<bool> = (0..w * h).map(|i| ink(px[i], guess[i])).collect();
    let mut wide = vec![false; w * h];
    for y in 0..h {
        let row = &ink[y * w..y * w + w];
        for x in 0..w {
            let (a, b) = (x.saturating_sub(2), (x + 2).min(w - 1));
            wide[y * w + x] = row[a..=b].iter().any(|&q| q);
        }
    }
    let mut mask = vec![false; w * h];
    for y in 0..h {
        let (a, b) = (y.saturating_sub(2), (y + 2).min(h - 1));
        for x in 0..w {
            mask[y * w + x] = (a..=b).any(|yy| wide[yy * w + x]);
        }
    }
    let mut out = px.to_vec();
    for i in 0..w * h {
        if mask[i] {
            out[i] = guess[i];
        }
    }
    // (Softened twice: each masked pixel the mean of its 3 × 3, from the pass before — the same integer sums as Java's,
    // added as rows of three first.)
    let mut hs = [vec![0u32; w * h], vec![0u32; w * h], vec![0u32; w * h]];
    for _ in 0..2 {
        for (c, plane) in hs.iter_mut().enumerate() {
            let sh = 16 - 8 * c as u32;
            for y in 0..h {
                let row = &out[y * w..y * w + w];
                let dst = &mut plane[y * w..y * w + w];
                for x in 1..w - 1 {
                    dst[x] = ((row[x - 1] >> sh) & 255) + ((row[x] >> sh) & 255) + ((row[x + 1] >> sh) & 255);
                }
            }
        }
        let mut b = out.clone();
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                let i = y * w + x;
                if !mask[i] {
                    continue;
                }
                let r = hs[0][i - w] + hs[0][i] + hs[0][i + w];
                let g = hs[1][i - w] + hs[1][i] + hs[1][i + w];
                let bl = hs[2][i - w] + hs[2][i] + hs[2][i + w];
                b[i] = 0xFF000000 | ((r / 9) << 16) | ((g / 9) << 8) | (bl / 9);
            }
        }
        out = b;
    }
    out
}

fn edge(px: &[u32], w: usize, h: usize, side: u8) -> [Vec<i32>; 3] {
    let n = if side < 2 { w } else { h };
    let mut ch = [vec![0i32; n], vec![0i32; n], vec![0i32; n]];
    for i in 0..n {
        let p = match side {
            0 => px[i],
            1 => px[(h - 1) * w + i],
            2 => px[i * w],
            _ => px[i * w + w - 1],
        };
        ch[0][i] = ((p >> 16) & 255) as i32;
        ch[1][i] = ((p >> 8) & 255) as i32;
        ch[2][i] = (p & 255) as i32;
    }
    let win = (n / 6).max(2) as i64;
    // (Java sorts each window; the median of the same values is found here from a 256-bin count slid along the edge:
    // the same answer, without the sort.)
    let m = 2 * win as usize + 1;
    let at = |src: &[i32], j: i64| src[j.clamp(0, n as i64 - 1) as usize] as usize;
    for c in ch.iter_mut() {
        let src = c.clone();
        let mut hist = [0u32; 256];
        for j in -win..=win {
            hist[at(&src, j)] += 1;
        }
        for i in 0..n as i64 {
            if i > 0 {
                hist[at(&src, i - 1 - win)] -= 1;
                hist[at(&src, i + win)] += 1;
            }
            // (The (m/2)-th smallest, counting from 0.)
            let want = (m / 2) as u32;
            let mut seen = 0u32;
            let mut v = 0usize;
            while seen + hist[v] <= want {
                seen += hist[v];
                v += 1;
            }
            c[i as usize] = v as i32;
        }
    }
    ch
}
/// Math.round for a value in [0, 255]: the nearest whole number, halves up (truncation and the exact remainder: no
/// libm call, and none of floor(x + 0.5)'s error just under a half).
fn round_up(e: f64) -> u32 {
    let k = e as u32;
    if e - k as f64 >= 0.5 { k + 1 } else { k }
}
/// KtInpaint.dist(a, b) > 46: (int) sqrt(q / 9.0) > 46 holds exactly when q / 9.0 ≥ 47² — for a whole q, q ≥ 19 881
/// (sqrt is correctly rounded and 47 is exact; 19 880 / 9 is far below 2 209).
fn ink(a: u32, b: u32) -> bool {
    let dr = ((a >> 16) & 255) as i32 - ((b >> 16) & 255) as i32;
    let dg = ((a >> 8) & 255) as i32 - ((b >> 8) & 255) as i32;
    let db = (a & 255) as i32 - (b & 255) as i32;
    dr * dr * 3 + dg * dg * 4 + db * db * 2 >= 19_881
}
#[cfg(test)]
fn dist(a: u32, b: u32) -> i32 {
    let dr = ((a >> 16) & 255) as i32 - ((b >> 16) & 255) as i32;
    let dg = ((a >> 8) & 255) as i32 - ((b >> 8) & 255) as i32;
    let db = (a & 255) as i32 - (b & 255) as i32;
    (((dr * dr * 3 + dg * dg * 4 + db * db * 2) as f64) / 9.0).sqrt() as i32
}

/// ARGB words from little-endian bytes (Java's IntBuffer over a little-endian ByteBuffer) and back.
pub fn words(b: &[u8]) -> Result<Vec<u32>, String> {
    if b.len() % 4 != 0 {
        return Err("data: not whole pixels".into());
    }
    Ok(b.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}
pub fn bytes(px: &[u32]) -> Vec<u8> {
    let mut o = Vec::with_capacity(px.len() * 4);
    for p in px {
        o.extend_from_slice(&p.to_le_bytes());
    }
    o
}

/* ---------- the patch cache (new, Rust switch only) ---------- */

/// Cleaned patches kept by their exact input: least recently used out first past `budget` bytes.
pub struct PatchCache {
    budget: usize,
    used: usize,
    tick: u64,
    slots: Vec<Slot>,
    pub hits: u64,
    pub misses: u64,
}
struct Slot {
    key: u64,
    w: usize,
    h: usize,
    input: Vec<u8>,
    output: Vec<u8>,
    last: u64,
}
/// FNV-1a over the bytes, sampled every 8th byte past the first KB for speed (the full bytes are compared on a hit).
fn key_of(b: &[u8], w: usize, h: usize) -> u64 {
    let mut k: u64 = 0xcbf29ce484222325 ^ ((w as u64) << 32 | h as u64);
    let mut i = 0;
    while i < b.len() {
        k = (k ^ b[i] as u64).wrapping_mul(0x100000001b3);
        i += if i < 1024 { 1 } else { 8 };
    }
    k ^ b.len() as u64
}
impl PatchCache {
    pub fn new(budget: usize) -> Self {
        PatchCache { budget, used: 0, tick: 0, slots: Vec::new(), hits: 0, misses: 0 }
    }
    pub fn bytes_held(&self) -> usize {
        self.used
    }
    pub fn len(&self) -> usize {
        self.slots.len()
    }
    /// The cleaned bytes of `input` (w × h ARGB, little-endian): from the cache when the very same bytes were
    /// cleaned before, else cleaned now and kept.
    pub fn clean_bytes(&mut self, input: &[u8], w: usize, h: usize) -> Result<Vec<u8>, String> {
        self.tick += 1;
        let k = key_of(input, w, h);
        if let Some(s) = self.slots.iter_mut().find(|s| s.key == k && s.w == w && s.h == h && s.input == input) {
            s.last = self.tick;
            self.hits += 1;
            return Ok(s.output.clone());
        }
        self.misses += 1;
        let out = bytes(&clean(&words(input)?, w, h));
        let size = input.len() + out.len();
        if size * 4 <= self.budget {
            while self.used + size > self.budget && !self.slots.is_empty() {
                let (j, _) = self.slots.iter().enumerate().min_by_key(|(_, s)| s.last).unwrap();
                let s = self.slots.swap_remove(j);
                self.used -= s.input.len() + s.output.len();
            }
            self.used += size;
            self.slots.push(Slot { key: k, w, h, input: input.to_vec(), output: out.clone(), last: self.tick });
        }
        Ok(out)
    }
    pub fn clear(&mut self) {
        self.slots.clear();
        self.used = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scene(w: usize, h: usize, bg: &dyn Fn(usize, usize) -> u32, ink: u32) -> Vec<u32> {
        let mut p = vec![0u32; w * h];
        for y in 0..h {
            for x in 0..w {
                p[y * w + x] = bg(x, y);
            }
        }
        for y in 8..h - 8 {
            for x in 8..w - 8 {
                if (x / 3) % 3 == 0 || (y % 9) < 2 {
                    p[y * w + x] = ink;
                }
            }
        }
        p
    }
    fn worst(a: &[u32], w: usize, h: usize, bg: &dyn Fn(usize, usize) -> u32) -> i32 {
        let mut m = 0;
        for y in 0..h {
            for x in 0..w {
                let (p, q) = (a[y * w + x], bg(x, y));
                for s in [0, 8, 16] {
                    m = m.max((((p >> s) & 255) as i32 - ((q >> s) & 255) as i32).abs());
                }
            }
        }
        m
    }
    fn sky(x: usize, y: usize) -> u32 {
        let (w, h) = (160, 60);
        let v = 40 + x * 150 / w;
        let g = 60 + y * 100 / h;
        0xFF000000 | (v as u32) << 16 | (g as u32) << 8 | 200
    }

    #[test]
    fn int_cases() {
        let (w, h) = (160, 60);
        let white = |_: usize, _: usize| 0xFFFFFFFFu32;
        let r1 = clean(&scene(w, h, &white, 0xFF000000), w, h);
        assert!(worst(&r1, w, h, &white) <= 6);
        let r2 = clean(&scene(w, h, &sky, 0xFFFFFFFF), w, h);
        assert!(worst(&r2, w, h, &sky) <= 14);
        let plain: Vec<u32> = (0..w * h).map(|i| sky(i % w, i / w)).collect();
        assert!(worst(&clean(&plain, w, h), w, h, &sky) <= 3);
    }

    #[test]
    fn shortcuts_equal_java_forms() {
        // Every value the colour distance can take, against Java's form; rounding against Math.round's definition.
        for q in 0..=(255 * 255 * 9) {
            assert_eq!((((q as f64) / 9.0).sqrt() as i32) > 46, q >= 19_881, "q = {}", q);
        }
        assert!(ink(0xFF000000, 0xFFFFFFFF) && !ink(0xFF101010, 0xFF121212));
        assert_eq!(dist(0xFF000000, 0xFF0A0000), (300.0f64 / 9.0).sqrt() as i32);
        for k in 0..=255u32 {
            for f in [0.0, 0.25, 0.49999999999999994, 0.5, 0.5000000000000001, 0.75, 0.9999999999999999] {
                let e = (k as f64 + f).min(255.0);
                assert_eq!(round_up(e), e.round() as u32, "{}", e);
            }
        }
        assert_eq!(round_up(0.49999999999999994), 0);
    }

    #[test]
    fn small_and_odd_buffers_as_java() {
        let p = vec![0xFF123456u32; 9];
        assert_eq!(clean(&p, 3, 3), p);
        assert_eq!(clean(&p, 4, 4), p); // (too short for 4 × 4: returned as it was)
        let mut long = vec![0xFFFFFFFFu32; 16 + 3];
        long[16] = 7;
        let c = clean(&long, 4, 4);
        assert_eq!(c.len(), 19);
        assert_eq!(c[16], 7);
        assert!(words(&[1, 2, 3]).is_err());
        assert_eq!(words(&bytes(&[0xAABBCCDD])).unwrap(), vec![0xAABBCCDD]);
    }

    #[test]
    fn the_cache_answers_the_same_and_costs_little() {
        let (w, h) = (200, 80);
        let patch = bytes(&scene(w, h, &sky, 0xFFFFFFFF));
        let mut c = PatchCache::new(8 << 20);
        let t0 = std::time::Instant::now();
        let first = c.clean_bytes(&patch, w, h).unwrap();
        let cold = t0.elapsed();
        let t1 = std::time::Instant::now();
        for _ in 0..20 {
            assert_eq!(c.clean_bytes(&patch, w, h).unwrap(), first);
        }
        let warm = t1.elapsed() / 20;
        assert_eq!(first, bytes(&clean(&words(&patch).unwrap(), w, h)));
        assert_eq!((c.hits, c.misses), (20, 1));
        eprintln!("patch cache: a clean {:?}, a hit {:?}", cold, warm);
        assert!(warm * 5 < cold, "a hit ({:?}) is not much cheaper than a clean ({:?})", warm, cold);
        // One pixel different: not the same patch.
        let mut other = patch.clone();
        other[4000] ^= 1;
        let o = c.clean_bytes(&other, w, h).unwrap();
        assert_eq!(o, bytes(&clean(&words(&other).unwrap(), w, h)));
        assert_eq!(c.misses, 2);
        // The same bytes as another shape: not the same patch either.
        let _ = c.clean_bytes(&patch, h, w).unwrap();
        assert_eq!(c.misses, 3);
        // The budget kept (one patch at most a quarter of it): the least recently used out first.
        let size = 2 * patch.len();
        let mut small = PatchCache::new(4 * size);
        let mut ps = Vec::new();
        for k in 0..5 {
            let mut q = patch.clone();
            q[100] = k as u8;
            ps.push(q);
        }
        for q in &ps {
            small.clean_bytes(q, w, h).unwrap();
        }
        assert_eq!(small.len(), 4);
        assert!(small.bytes_held() <= 4 * size);
        small.clean_bytes(&ps[4], w, h).unwrap();
        assert_eq!(small.hits, 1);
        small.clean_bytes(&ps[0], w, h).unwrap();
        assert_eq!(small.misses, 6);
        assert!(PatchCache::new(size).clean_bytes(&patch, w, h).is_ok()); // (too big to keep: cleaned, not kept)
    }
}
