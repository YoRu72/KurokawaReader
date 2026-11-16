//! The operators that move particles, one emitter's slice at a time: drift on smooth noise, gravity, drag (before the
//! velocity is applied), the pointer as a control point and a click's push, the wind (with the velocity), bounds —
//! wrap or kill — (after), and the alpha fade over life (read when drawing). Positions in scene units.
//! Only basic float operations (see math.rs): the same bits natively and in wasm.
//! Standalone: `rustc --edition 2021 --test --cfg 'kt_alone="forces"' src/forces.rs`.

#[cfg(kt_alone = "forces")]
#[path = "json.rs"]
mod json;
#[cfg(kt_alone = "forces")]
#[path = "math.rs"]
mod math;
#[cfg(kt_alone = "forces")]
#[path = "scenefile.rs"]
mod scenefile;
#[cfg(kt_alone = "forces")]
#[path = "particles.rs"]
mod particles;

use crate::math::{clampf, noise3};
use crate::particles::{Pool, View};
use crate::scenefile::Op;

/// A second seed for the noise's y component.
const NOISE_Y: u32 = 0x5BD1_E995;

/// What the page told the scene this step: the pointer (scene units, or none) and a click to answer (once).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Control {
    pub pointer: Option<(f32, f32)>,
    pub click: Option<(f32, f32)>,
}

/// Unit direction and distance from (x, y) to (px, py); None when farther than `radius` or on the point itself.
fn toward(x: f32, y: f32, px: f32, py: f32, radius: f32) -> Option<(f32, f32, f32)> {
    let (dx, dy) = (px - x, py - y);
    let d2 = dx * dx + dy * dy;
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    let far = !(d2 < radius * radius);
    if far || d2 < 1e-6 {
        return None;
    }
    let d = d2.sqrt();
    Some((dx / d, dy / d, d))
}

/// Forces for one step: velocities changed, positions not yet. `t` = the scene's time in seconds.
#[allow(clippy::too_many_arguments)]
pub fn accelerate(ops: &[Op], pool: &mut Pool, r: core::ops::Range<usize>, dt: f32, t: f64, seed: u32, ctl: &Control) {
    for op in ops {
        match *op {
            Op::Pointer { strength, radius } => {
                if let Some((px, py)) = ctl.pointer {
                    for i in r.clone() {
                        if let Some((ux, uy, d)) = toward(pool.px[i], pool.py[i], px, py, radius) {
                            let f = strength * (1.0 - d / radius) * dt;
                            pool.vx[i] += ux * f;
                            pool.vy[i] += uy * f;
                        }
                    }
                }
            }
            Op::Click { impulse, radius } => {
                if let Some((px, py)) = ctl.click {
                    for i in r.clone() {
                        if let Some((ux, uy, d)) = toward(pool.px[i], pool.py[i], px, py, radius) {
                            let f = impulse * (1.0 - d / radius);
                            pool.vx[i] -= ux * f;
                            pool.vy[i] -= uy * f;
                        }
                    }
                }
            }
            Op::Drift { scale, speed, strength } => {
                // (Time as the noise's third axis: the field itself slowly changes.)
                let z = (t * speed as f64) as f32;
                let k = strength * dt;
                for i in r.clone() {
                    let (x, y) = (pool.px[i] * scale, pool.py[i] * scale);
                    pool.vx[i] += noise3(seed, x, y, z) * k;
                    pool.vy[i] += noise3(seed ^ NOISE_Y, x, y, z) * k;
                }
            }
            Op::Gravity { x, y } => {
                let (gx, gy) = (x * dt, y * dt);
                for i in r.clone() {
                    pool.vx[i] += gx;
                    pool.vy[i] += gy;
                }
            }
            Op::Drag { k } => {
                let keep = clampf(1.0 - k * dt, 0.0, 1.0);
                for i in r.clone() {
                    pool.vx[i] *= keep;
                    pool.vy[i] *= keep;
                }
            }
            Op::Bounds { .. } | Op::Fade { .. } | Op::Unknown(_) => {}
        }
    }
}

/// Velocities (and the wind, units/s) applied: positions, rotations and ages advanced.
pub fn integrate(pool: &mut Pool, r: core::ops::Range<usize>, dt: f32, wind: (f32, f32)) {
    for i in r {
        pool.px[i] += (pool.vx[i] + wind.0) * dt;
        pool.py[i] += (pool.vy[i] + wind.1) * dt;
        pool.rot[i] += pool.spin[i] * dt;
        pool.age[i] += dt;
    }
}

/// Bounds after moving: wrapped to the other side, or marked dead (its age set to its life; reaped by the emitter).
pub fn constrain(ops: &[Op], pool: &mut Pool, r: core::ops::Range<usize>, view: View) {
    for op in ops {
        if let Op::Bounds { wrap, margin } = *op {
            let (x0, y0, x1, y1) = (view.x0 - margin, view.y0 - margin, view.x1 + margin, view.y1 + margin);
            let (sw, sh) = (x1 - x0, y1 - y0);
            for i in r.clone() {
                let (x, y) = (pool.px[i], pool.py[i]);
                #[allow(clippy::nonminimal_bool)]
                let out = !(x >= x0 && x <= x1 && y >= y0 && y <= y1);
                if !out {
                    continue;
                }
                if !wrap || !x.is_finite() || !y.is_finite() {
                    pool.age[i] = pool.life[i];
                    continue;
                }
                // (Far out — a resize, a huge velocity —: put back inside in one go, not a span per step.)
                pool.px[i] = wrap1(x, x0, sw);
                pool.py[i] = wrap1(y, y0, sh);
            }
        }
    }
}

fn wrap1(v: f32, lo: f32, span: f32) -> f32 {
    if span <= 0.0 {
        return lo;
    }
    let mut u = (v - lo) / span;
    u -= u.floor();
    let w = lo + u * span;
    clampf(w, lo, lo + span)
}

/// The fade's factor (0–1) at a share `u` of life: a smooth rise over `fin`, a smooth fall over the last `fout`.
pub fn fade(ops: &[Op], age: f32, life: f32) -> f32 {
    let mut k = 1.0;
    for op in ops {
        if let Op::Fade { fin, fout } = *op {
            let u = if life > 0.0 { clampf(age / life, 0.0, 1.0) } else { 1.0 };
            let a = if fin > 0.0 { smooth(u / fin) } else { 1.0 };
            let b = if fout > 0.0 { smooth((1.0 - u) / fout) } else { 1.0 };
            k *= a * b;
        }
    }
    k
}

fn smooth(x: f32) -> f32 {
    let x = clampf(x, 0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool1(x: f32, y: f32, vx: f32, vy: f32) -> Pool {
        let mut p = Pool::new(1);
        p.px[0] = x;
        p.py[0] = y;
        p.vx[0] = vx;
        p.vy[0] = vy;
        p.life[0] = 10.0;
        p
    }

    #[test]
    fn gravity_drag_and_integration() {
        let mut p = pool1(0.0, 0.0, 10.0, 0.0);
        let ops = [Op::Gravity { x: 0.0, y: 60.0 }, Op::Drag { k: 6.0 }];
        accelerate(&ops, &mut p, 0..1, 1.0 / 60.0, 0.0, 1, &Control::default());
        assert!((p.vy[0] - 0.9).abs() < 1e-6);
        assert!((p.vx[0] - 9.0).abs() < 1e-5);
        integrate(&mut p, 0..1, 0.5, (0.0, 0.0));
        assert!((p.px[0] - 4.5).abs() < 1e-5);
        assert_eq!(p.age[0], 0.5);
        // (Drag never turns a velocity round.)
        let mut q = pool1(0.0, 0.0, 10.0, 0.0);
        accelerate(&[Op::Drag { k: 60.0 }], &mut q, 0..1, 1.0, 0.0, 1, &Control::default());
        assert_eq!(q.vx[0], 0.0);
    }

    #[test]
    fn drift_moves_smoothly_and_is_seeded() {
        let mut a = pool1(100.0, 50.0, 0.0, 0.0);
        let mut b = pool1(100.0, 50.0, 0.0, 0.0);
        let ops = [Op::Drift { scale: 0.01, speed: 0.1, strength: 20.0 }];
        accelerate(&ops, &mut a, 0..1, 1.0 / 60.0, 3.0, 7, &Control::default());
        accelerate(&ops, &mut b, 0..1, 1.0 / 60.0, 3.0, 8, &Control::default());
        assert!(a.vx[0].abs() <= 20.0 / 60.0 + 1e-6);
        assert_ne!(a.vx[0], b.vx[0]);
    }

    #[test]
    fn bounds_wrap_and_kill() {
        let view = View::plain(100.0, 50.0);
        let mut p = pool1(115.0, -20.0, 0.0, 0.0);
        constrain(&[Op::Bounds { wrap: true, margin: 10.0 }], &mut p, 0..1, view);
        assert!((p.px[0] - (-5.0)).abs() < 1e-4, "{}", p.px[0]);
        assert!((p.py[0] - 50.0).abs() < 1e-4, "{}", p.py[0]);
        let mut far = pool1(1e9, -1e9, 0.0, 0.0);
        constrain(&[Op::Bounds { wrap: true, margin: 10.0 }], &mut far, 0..1, view);
        assert!(far.px[0] >= -10.0 && far.px[0] <= 110.0 && far.py[0] >= -10.0 && far.py[0] <= 60.0);
        let mut k = pool1(-30.0, 10.0, 0.0, 0.0);
        constrain(&[Op::Bounds { wrap: false, margin: 10.0 }], &mut k, 0..1, view);
        assert_eq!(k.age[0], k.life[0]);
        let mut nan = pool1(f32::NAN, 10.0, 0.0, 0.0);
        constrain(&[Op::Bounds { wrap: true, margin: 10.0 }], &mut nan, 0..1, view);
        assert_eq!(nan.age[0], nan.life[0]);
    }

    #[test]
    fn pointer_click_and_wind() {
        let ops = [Op::Pointer { strength: -60.0, radius: 100.0 }, Op::Click { impulse: 100.0, radius: 100.0 }];
        let mut p = pool1(50.0, 0.0, 0.0, 0.0);
        accelerate(&ops, &mut p, 0..1, 1.0, 0.0, 1, &Control { pointer: Some((0.0, 0.0)), click: None });
        assert!((p.vx[0] - 30.0).abs() < 1e-4, "pushed away: {}", p.vx[0]);
        let mut q = pool1(50.0, 0.0, 0.0, 0.0);
        accelerate(&ops, &mut q, 0..1, 1.0, 0.0, 1, &Control { pointer: None, click: Some((0.0, 0.0)) });
        assert!((q.vx[0] - 50.0).abs() < 1e-4, "{}", q.vx[0]);
        let mut far = pool1(500.0, 0.0, 0.0, 0.0);
        accelerate(&ops, &mut far, 0..1, 1.0, 0.0, 1, &Control { pointer: Some((0.0, 0.0)), click: Some((0.0, 0.0)) });
        assert_eq!(far.vx[0], 0.0);
        let mut on = pool1(0.0, 0.0, 0.0, 0.0);
        accelerate(&ops, &mut on, 0..1, 1.0, 0.0, 1, &Control { pointer: Some((0.0, 0.0)), click: Some((0.0, 0.0)) });
        assert!(on.vx[0] == 0.0 && on.vy[0] == 0.0);
        let mut w = pool1(0.0, 0.0, 1.0, 0.0);
        integrate(&mut w, 0..1, 1.0, (10.0, -2.0));
        assert_eq!((w.px[0], w.py[0]), (11.0, -2.0));
    }

    #[test]
    fn fade_rises_and_falls() {
        let ops = [Op::Fade { fin: 0.2, fout: 0.2 }];
        assert_eq!(fade(&ops, 0.0, 10.0), 0.0);
        assert_eq!(fade(&ops, 5.0, 10.0), 1.0);
        assert_eq!(fade(&ops, 10.0, 10.0), 0.0);
        assert!(fade(&ops, 1.0, 10.0) > 0.0 && fade(&ops, 1.0, 10.0) < 1.0);
        assert_eq!(fade(&[], 3.0, 10.0), 1.0);
        assert_eq!(fade(&[Op::Fade { fin: 0.0, fout: 0.0 }], 3.0, 10.0), 1.0);
    }
}
