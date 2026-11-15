//! How far the screen scrolled between two frames, from the pictures alone (stage M4): KtScreenMotion.java's rules —
//! a frame boiled down to a «signature» (the brightness of 24 columns on every 4th row, pixels under the translator's
//! own boxes left out as -1) and the newer one slid over the older until they agree. Integer sums and one division
//! per shift, as Java: the same answer to the pixel. Std only; `rustc --edition 2021 --test screenmotion.rs`.
//!
//! The signature is made by Java on the phone (it reads 14 400 pixels of an Android `Image` in place; copying a
//! 10 MB frame across JNI to sample it would cost far more than the sampling): `signature` is here for the tests and
//! for a later stage that holds the frame itself.

pub const STEP: usize = 4;
pub const COLS: usize = 24;
/// «Not the same page» (Java's Integer.MIN_VALUE).
pub const NONE: i32 = i32::MIN;

/// KtScreenMotion.signature over RGBA bytes (R at the pixel's offset, then G, B — the screen capture's layout), rows ×
/// COLS values; `masks`: (left, top, right, bottom) left out.
pub fn signature(px: &[u8], width: usize, height: usize, row_stride: usize, pixel_stride: usize, masks: &[[i32; 4]]) -> Vec<i16> {
    let rows = height / STEP;
    let mut sig = vec![0i16; rows * COLS];
    for r in 0..rows {
        let y = (r * STEP) as i32;
        for c in 0..COLS {
            let x = ((c as f64 + 0.5) * width as f64 / COLS as f64) as i32;
            if masks.iter().any(|m| x >= m[0] && x < m[2] && y >= m[1] && y < m[3]) {
                sig[r * COLS + c] = -1;
                continue;
            }
            let o = y as usize * row_stride + x as usize * pixel_stride;
            let (rr, g, b) = (px[o] as i32, px[o + 1] as i32, px[o + 2] as i32);
            sig[r * COLS + c] = ((rr * 77 + g * 150 + b * 29) >> 8) as i16;
        }
    }
    sig
}

/// Mean difference of a's row r+s against b's row r over the pairs both have (f64::MAX when too few) — or None as
/// soon as it is certain not to come under `best` = sum_b / n_b (Java's `d < best` could not hold: the running sum
/// over every pair still possible already gives more, compared exactly in integers; rounding to doubles keeps order,
/// so what Java would answer is unchanged). `best`: None, nothing found yet.
fn diff(a: &[i16], b: &[i16], s: i32, rows: i32, every: i32, best: Option<(i64, i64)>) -> Option<(f64, i64, i64)> {
    let mut sum: i64 = 0;
    let mut n: i32 = 0;
    let start = (-s).max(0);
    let end = rows.min(rows - s);
    let visits = if end > start { ((end - start + every - 1) / every) as i64 } else { 0 };
    let n_max = visits * COLS as i64;
    let mut r = start;
    let mut seen: i64 = 0;
    while r < end {
        if r + s >= 0 {
            let x = &a[(r + s) as usize * COLS..(r + s) as usize * COLS + COLS];
            let y = &b[r as usize * COLS..r as usize * COLS + COLS];
            for c in 0..COLS {
                let (p, q) = (x[c], y[c]);
                if p < 0 || q < 0 {
                    continue;
                }
                sum += (p as i64 - q as i64).abs();
                n += 1;
            }
        }
        r += every;
        seen += 1;
        if seen & 15 == 0 {
            if let Some((sb, nb)) = best {
                if n_max > 0 && (sum as i128) * (nb as i128) > (sb as i128) * (n_max as i128) {
                    return None;
                }
            }
        }
    }
    if n < rows * COLS as i32 / 5 / every {
        Some((f64::MAX, 0, 0))
    } else {
        Some((sum as f64 / n as f64, sum, n as i64))
    }
}
fn flat(s: &[i16]) -> bool {
    let (mut lo, mut hi) = (255i32, 0i32);
    for &v in s {
        if v < 0 {
            continue;
        }
        lo = lo.min(v as i32);
        hi = hi.max(v as i32);
    }
    hi - lo < 12
}

/// KtScreenMotion.shift: how many pixels the content moved up from `a` to `b` (each rows × COLS), 0 standing still,
/// NONE when no shift matches.
pub fn shift(a: &[i16], b: &[i16], max_px: i32) -> i32 {
    if a.len() != b.len() || a.len() % COLS != 0 || a.len() / COLS < 8 {
        return NONE;
    }
    let rows = (a.len() / COLS) as i32;
    let max = (rows - rows / 4).min(max_px / STEP as i32);
    let still = diff(a, b, 0, rows, 1, None).map(|d| d.0).unwrap_or(f64::MAX);
    if still < 0.3 {
        return 0;
    }
    let mut best = f64::MAX;
    let mut exact: Option<(i64, i64)> = None;
    let mut best_s = NONE;
    let mut s = -max;
    while s <= max {
        if s != 0 {
            if let Some((d, sum, n)) = diff(a, b, s, rows, 3, exact) {
                if d < best {
                    best = d;
                    best_s = s;
                    exact = if d == f64::MAX { None } else { Some((sum, n)) };
                }
            }
        }
        s += 2;
    }
    if best_s == NONE {
        return if still < 6.0 { 0 } else { NONE };
    }
    let c0 = best_s;
    best = f64::MAX;
    exact = None;
    for s in c0 - 2..=c0 + 2 {
        if s == 0 || s.abs() > max {
            continue;
        }
        if let Some((d, sum, n)) = diff(a, b, s, rows, 1, exact) {
            if d < best {
                best = d;
                best_s = s;
                exact = if d == f64::MAX { None } else { Some((sum, n)) };
            }
        }
    }
    if best_s == NONE || best > 6.0 || best > still * 0.6 || flat(b) {
        return if still < 6.0 { 0 } else { NONE };
    }
    best_s * STEP as i32
}

/// Two signatures as Java sends them: i16 little-endian, `a` then `b`, each rows × COLS.
pub fn split_pair(data: &[u8], rows: usize) -> Result<(Vec<i16>, Vec<i16>), String> {
    let n = rows * COLS;
    if data.len() != 4 * n {
        return Err(format!("data: {} bytes for two signatures of {} rows", data.len(), rows));
    }
    let v: Vec<i16> = data.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
    let b = v[n..].to_vec();
    let mut a = v;
    a.truncate(n);
    Ok((a, b))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// MoT's made-up comic page (java.util.Random, the same seed: the same page as Java's).
    struct JRandom(u64);
    impl JRandom {
        fn new(seed: u64) -> Self {
            JRandom((seed ^ 0x5DEECE66D) & ((1 << 48) - 1))
        }
        fn next(&mut self, bits: u32) -> i32 {
            self.0 = (self.0.wrapping_mul(0x5DEECE66D).wrapping_add(0xB)) & ((1 << 48) - 1);
            (self.0 >> (48 - bits)) as i64 as i32
        }
        fn next_int(&mut self, bound: i32) -> i32 {
            if bound & (-bound) == bound {
                return ((bound as i64 * self.next(31) as i64) >> 31) as i32;
            }
            loop {
                let bits = self.next(31);
                let val = bits % bound;
                if bits - val + (bound - 1) >= 0 {
                    return val;
                }
            }
        }
    }
    fn page(w: usize, h: usize, seed: u64) -> Vec<u32> {
        let mut p = vec![0xFFFFFFFFu32; w * h];
        let mut r = JRandom::new(seed);
        for _ in 0..40 {
            let x = r.next_int(w as i32 - 200) as usize;
            let y = r.next_int(h as i32 - 200) as usize;
            let bw = 80 + r.next_int(300) as usize;
            let bh = 60 + r.next_int(300) as usize;
            let c = 0xFF000000 | r.next_int(0xFFFFFF) as u32;
            for yy in y..h.min(y + bh) {
                for xx in x..w.min(x + bw) {
                    p[yy * w + xx] = c;
                }
            }
        }
        for _ in 0..400 {
            let x = r.next_int(w as i32 - 20) as usize;
            let y = r.next_int(h as i32 - 4) as usize;
            for xx in x..x + 18 {
                p[y * w + xx] = 0xFF111111;
            }
        }
        p
    }
    fn view(pg: &[u32], w: usize, h: usize, top: usize, vh: usize, masks: &[[i32; 4]]) -> Vec<i16> {
        let mut rgba = vec![0u8; w * vh * 4];
        for y in 0..vh {
            for x in 0..w {
                let p = if y + top < h { pg[(y + top) * w + x] } else { 0xFFFFFFFF };
                let o = (y * w + x) * 4;
                rgba[o] = (p >> 16) as u8;
                rgba[o + 1] = (p >> 8) as u8;
                rgba[o + 2] = p as u8;
                rgba[o + 3] = 255;
            }
        }
        signature(&rgba, w, vh, w * 4, 4, masks)
    }

    #[test]
    fn mot_cases() {
        let (w, h, vh) = (1080, 8000, 2400);
        let pg = page(w, h, 7);
        let s0 = view(&pg, w, h, 2000, vh, &[]);
        assert_eq!(shift(&s0, &view(&pg, w, h, 2000, vh, &[]), vh as i32), 0);
        for d in [8i32, 40, 200, 600, 1500, -12, -300, -1200] {
            let got = shift(&s0, &view(&pg, w, h, (2000 + d) as usize, vh, &[]), vh as i32);
            assert!((got - d).abs() <= STEP as i32, "scrolled {} found {}", d, got);
        }
        assert_eq!(shift(&s0, &view(&page(w, h, 99), w, h, 1000, vh, &[]), vh as i32), NONE);
        let boxes = [[100, 300, 700, 500], [300, 1200, 1000, 1500], [0, 2000, 1080, 2300]];
        let got = shift(&view(&pg, w, h, 1000, vh, &boxes), &view(&pg, w, h, 1300, vh, &boxes), vh as i32);
        assert!((got - 300).abs() <= STEP as i32);
        let blank = vec![0xFFFFFFFFu32; w * h];
        assert_eq!(shift(&view(&blank, w, h, 0, vh, &[]), &view(&blank, w, h, 400, vh, &[]), vh as i32), 0);
    }

    #[test]
    fn edges() {
        assert_eq!(shift(&[0; 24 * 7], &[0; 24 * 7], 100), NONE);
        assert_eq!(shift(&[0; 24 * 8], &[0; 24 * 9], 100), NONE);
        // All masked: «too few pairs» everywhere → not still, no shift.
        let m = vec![-1i16; 24 * 40];
        assert_eq!(shift(&m, &m, 160), NONE);
        assert!(split_pair(&[1, 0, 2, 0], 0).is_err());
        assert_eq!(split_pair(&[], 0).unwrap(), (vec![], vec![]));
        assert!(split_pair(&[0; 10], 1).is_err());
        let mut d = vec![0u8; 4 * 24];
        d[0] = 5;
        d[48] = 0xff;
        d[49] = 0xff;
        let (a, b) = split_pair(&d, 1).unwrap();
        assert_eq!((a[0], b[0]), (5, -1));
    }
}
