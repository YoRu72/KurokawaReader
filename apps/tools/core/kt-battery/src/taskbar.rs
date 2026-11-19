// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the taskbar's presence — the tray icons with the level drawn in them
// (one per device, or one for the lowest), the optional strip on the taskbar beside the notification area, their
// order, captions, hover text and the quiet hours of the notices. Pure and std only: the shells hand the pixels to the
// system (desktop.rs's tray through Tauri, win/strip.rs's layered window).
// Derived from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/main.cpp (RenderIcon / IconFor: the number drawn in a tray icon with a level bar under it; KindOrder and
// OrderedEntries: the user's order, then by kind and name; «Hide last known / asleep devices»), src/widget.h and
// src/widget.cpp (the strip: «[icon] 30%» per device, red when low, a blue charging mark, dimmed when asleep, «Icons
// above percentages», «Background behind taskbar text», placed left of the notification area) and src/labels.cpp
// (a caption when two devices share a kind) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its
// contributors, GPL-3.0-or-later.
// Changed here: every picture is our own drawing made in code (strokes in a small grid, anti-aliased by distance; no
// font, no bundled art); a level in steps or words is never drawn as a number (a battery filled to its part instead);
// the bar can replace the number («Battery» drawing); colours are calm: red when low, blue when charging, the
// taskbar's own white or black otherwise, dimmed when asleep or away — no brand colours (makers' colours, several of
// them yellow or orange); captions are numbers only (1, 2 …) where the original took letters from the names; the strip
// sits on the main taskbar only (the original's copies on other monitors need UI Automation to find their clock).
// From the original's v1.1.0 (same files at its 1.1.0 release): «fully charged» — on power and full, a green check mark
// in place of the bolt; «Show disconnected devices» beside «Hide last known / asleep devices»; Windows 10's «news and
// interests» button left of the notification area kept clear (ShellFeedsTaskbarViewWindow / DynamicContent2).
// Copyright (C) 2026 Kurokawa contributors.
use crate::model::{Coarse, Level};

// ---------------------------------------------------------------- choices

/// How the tray shows the devices (the Background group's «Taskbar» card).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayStyle {
    /// The app's icon with the devices in its menu (0.21's first way).
    App,
    /// One icon: the lowest device's level drawn in it.
    Lowest,
    /// One icon per device, each with its level drawn (the original's tray mode).
    Each,
}

impl TrayStyle {
    pub fn parse(s: &str) -> Option<TrayStyle> {
        match s {
            "app" => Some(TrayStyle::App),
            "lowest" => Some(TrayStyle::Lowest),
            "each" => Some(TrayStyle::Each),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            TrayStyle::App => "app",
            TrayStyle::Lowest => "lowest",
            TrayStyle::Each => "each",
        }
    }
}

/// What a tray icon draws: the number with a thin bar under it (as the original), or a small battery filled to the level.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrawStyle {
    Number,
    Bar,
}

impl DrawStyle {
    pub fn parse(s: &str) -> Option<DrawStyle> {
        match s {
            "number" => Some(DrawStyle::Number),
            "bar" => Some(DrawStyle::Bar),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            DrawStyle::Number => "number",
            DrawStyle::Bar => "bar",
        }
    }
}

/// At most this many device icons in the tray (more would push the clock away; the rest stay in the menu).
pub const MAX_ICONS: usize = 8;

// ---------------------------------------------------------------- what is drawn

/// The level as a picture may show it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shown {
    /// A real percentage: drawn as a number (or a bar).
    Pct(u8),
    /// A level in steps or words: n of max — only ever a filled bar, never a number.
    Part(u8, u8),
    /// No level known: «?».
    Unknown,
    /// Nothing to show (no device): «–».
    Nothing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Normal,
    Low,
    Charging,
    /// On power and full (the original's v1.1.0): green, a check mark in place of the bolt.
    Full,
}

/// One picture's content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Face {
    pub shown: Shown,
    pub tone: Tone,
    /// Asleep, away or an old value: drawn faintly.
    pub dim: bool,
}

impl Face {
    pub const NOTHING: Face = Face { shown: Shown::Nothing, tone: Tone::Normal, dim: true };
}

fn coarse_part(c: Coarse) -> (u8, u8) {
    (c.bars(), 5)
}

/// A device's face: its level (None when it has none now), charging, whether it answered this round, and its low mark
/// (a percentage; 0 counts as the default mark the caller passes). Low as the page has it: at or under the mark, or a
/// coarse «empty» / «low», or steps at a quarter or less. Charging is never low.
pub fn face(level: Option<Level>, charging: bool, live: bool, mark: u8) -> Face {
    let full = match level {
        Some(Level::Exact(p)) => p.get() >= 100,
        Some(Level::Coarse(c)) => c == Coarse::Full,
        Some(Level::Steps(s)) => s.n() >= s.max(),
        _ => false,
    };
    let (shown, low) = match level {
        Some(Level::Exact(p)) => (Shown::Pct(p.get()), p.get() <= mark),
        Some(Level::Coarse(c)) => {
            let (n, m) = coarse_part(c);
            (Shown::Part(n, m), c <= Coarse::Low)
        }
        Some(Level::Steps(s)) => (Shown::Part(s.n(), s.max()), s.coarse() <= Coarse::Low),
        Some(Level::Unknown) | None => (Shown::Unknown, false),
    };
    let tone = if charging && live && full {
        Tone::Full
    } else if charging && live {
        Tone::Charging
    } else if low && live {
        Tone::Low
    } else {
        Tone::Normal
    };
    Face { shown, tone, dim: !live }
}

// ---------------------------------------------------------------- colours

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgb(pub u8, pub u8, pub u8);

/// The taskbar's text colour: near-black on a light taskbar, near-white on a dark one.
pub fn fg(light: bool) -> Rgb {
    if light {
        Rgb(28, 28, 30)
    } else {
        Rgb(246, 246, 248)
    }
}

/// Low: red, readable on either taskbar.
pub fn red(light: bool) -> Rgb {
    if light {
        Rgb(196, 32, 44)
    } else {
        Rgb(255, 104, 104)
    }
}

/// Charging: blue.
pub fn blue(light: bool) -> Rgb {
    if light {
        Rgb(22, 98, 196)
    } else {
        Rgb(110, 176, 255)
    }
}

/// Fully charged: green (Windows' own «success» shades, as the original's v1.1.0).
pub fn green(light: bool) -> Rgb {
    if light {
        Rgb(16, 124, 16)
    } else {
        Rgb(108, 203, 95)
    }
}

fn tone_rgb(t: Tone, light: bool) -> Rgb {
    match t {
        Tone::Normal => fg(light),
        Tone::Low => red(light),
        Tone::Charging => blue(light),
        Tone::Full => green(light),
    }
}

/// On power: charging or full (the text stays the taskbar's colour, the mark beside it tells which).
fn powered(t: Tone) -> bool {
    matches!(t, Tone::Charging | Tone::Full)
}

/// The check mark of «fully charged», `size` square at (x, y).
pub fn draw_check(cv: &mut Canvas, x: f32, y: f32, size: f32, c: Rgb, alpha: f32) {
    let k = size / 24.0;
    let p = [(4.0, 12.5), (9.5, 18.0), (20.0, 6.5)];
    cv.stroke(&[(x + p[0].0 * k, y + p[0].1 * k, x + p[1].0 * k, y + p[1].1 * k), (x + p[1].0 * k, y + p[1].1 * k, x + p[2].0 * k, y + p[2].1 * k)], (3.2 * k).max(1.3), c, alpha);
}

/// The mark of a powered device: the bolt (charging) or the check (full).
fn draw_power(cv: &mut Canvas, t: Tone, x: f32, y: f32, size: f32, light: bool) {
    if t == Tone::Full {
        draw_check(cv, x, y, size, green(light), 1.0);
    } else {
        draw_bolt(cv, x, y, size, blue(light), 1.0);
    }
}

/// How faint a dimmed picture is.
pub const DIM: f32 = 0.42;

// ---------------------------------------------------------------- the canvas

/// Straight (not premultiplied) RGBA, row by row from the top: what Tauri's Image takes.
#[derive(Clone, Debug)]
pub struct Canvas {
    pub w: u32,
    pub h: u32,
    pub px: Vec<u8>,
}

impl Canvas {
    pub fn new(w: u32, h: u32) -> Canvas {
        let w = w.clamp(1, 4096);
        let h = h.clamp(1, 512);
        Canvas { w, h, px: vec![0; (w * h * 4) as usize] }
    }

    /// Source-over of one colour with a coverage 0–1 at (x, y); outside: nothing.
    fn blend(&mut self, x: i64, y: i64, c: Rgb, a: f32) {
        if x < 0 || y < 0 || x >= i64::from(self.w) || y >= i64::from(self.h) || !(a > 0.0) {
            return;
        }
        let a = a.min(1.0);
        let i = ((y as u32 * self.w + x as u32) * 4) as usize;
        let Some(p) = self.px.get_mut(i..i + 4) else { return };
        let da = f32::from(p[3]) / 255.0;
        let oa = a + da * (1.0 - a);
        if oa <= 0.0 {
            return;
        }
        let mix = |s: u8, d: u8| -> u8 { ((f32::from(s) * a + f32::from(d) * da * (1.0 - a)) / oa).round().clamp(0.0, 255.0) as u8 };
        p[0] = mix(c.0, p[0]);
        p[1] = mix(c.1, p[1]);
        p[2] = mix(c.2, p[2]);
        p[3] = (oa * 255.0).round().clamp(0.0, 255.0) as u8;
    }

    /// Strokes: every segment of the set at once (no doubled joints), round ends, `width` wide, anti-aliased by the
    /// distance from each pixel's centre.
    pub fn stroke(&mut self, segs: &[(f32, f32, f32, f32)], width: f32, c: Rgb, alpha: f32) {
        if segs.is_empty() {
            return;
        }
        let r = width / 2.0;
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for &(ax, ay, bx, by) in segs {
            x0 = x0.min(ax.min(bx));
            y0 = y0.min(ay.min(by));
            x1 = x1.max(ax.max(bx));
            y1 = y1.max(ay.max(by));
        }
        let (xa, ya) = ((x0 - r - 1.0).floor().max(0.0) as i64, (y0 - r - 1.0).floor().max(0.0) as i64);
        let (xb, yb) = ((x1 + r + 1.0).ceil().min(self.w as f32) as i64, (y1 + r + 1.0).ceil().min(self.h as f32) as i64);
        for y in ya..yb {
            for x in xa..xb {
                let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
                let mut d = f32::MAX;
                for &(ax, ay, bx, by) in segs {
                    d = d.min(seg_dist(px, py, ax, ay, bx, by));
                }
                let cov = (r + 0.5 - d).clamp(0.0, 1.0);
                if cov > 0.0 {
                    self.blend(x, y, c, cov * alpha);
                }
            }
        }
    }

    /// A rectangle with soft edges (each pixel covered by its share of the area).
    pub fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, c: Rgb, alpha: f32) {
        if !(w > 0.0 && h > 0.0) {
            return;
        }
        let (xa, ya) = (x.floor().max(0.0) as i64, y.floor().max(0.0) as i64);
        let (xb, yb) = ((x + w).ceil().min(self.w as f32) as i64, (y + h).ceil().min(self.h as f32) as i64);
        for py in ya..yb {
            let cy = ((py as f32 + 1.0).min(y + h) - (py as f32).max(y)).clamp(0.0, 1.0);
            for px in xa..xb {
                let cx = ((px as f32 + 1.0).min(x + w) - (px as f32).max(x)).clamp(0.0, 1.0);
                self.blend(px, py, c, cx * cy * alpha);
            }
        }
    }

    /// A rounded rectangle filled (anti-aliased by its distance field).
    pub fn round_rect(&mut self, x: f32, y: f32, w: f32, h: f32, r: f32, c: Rgb, alpha: f32) {
        if !(w > 0.0 && h > 0.0) {
            return;
        }
        let r = r.min(w / 2.0).min(h / 2.0).max(0.0);
        let (cx, cy, hx, hy) = (x + w / 2.0, y + h / 2.0, w / 2.0 - r, h / 2.0 - r);
        let (xa, ya) = (x.floor().max(0.0) as i64, y.floor().max(0.0) as i64);
        let (xb, yb) = ((x + w).ceil().min(self.w as f32) as i64, (y + h).ceil().min(self.h as f32) as i64);
        for py in ya..yb {
            for px in xa..xb {
                let qx = ((px as f32 + 0.5 - cx).abs() - hx).max(0.0);
                let qy = ((py as f32 + 0.5 - cy).abs() - hy).max(0.0);
                let d = (qx * qx + qy * qy).sqrt() - r;
                let cov = (0.5 - d).clamp(0.0, 1.0);
                self.blend(px, py, c, cov * alpha);
            }
        }
    }

    /// A closed polygon filled, 4×4 samples a pixel (even-odd).
    pub fn fill_poly(&mut self, pts: &[(f32, f32)], c: Rgb, alpha: f32) {
        if pts.len() < 3 {
            return;
        }
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for &(x, y) in pts {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
        for py in (y0.floor().max(0.0) as i64)..(y1.ceil().min(self.h as f32) as i64) {
            for px in (x0.floor().max(0.0) as i64)..(x1.ceil().min(self.w as f32) as i64) {
                let mut n = 0;
                for sy in 0..4 {
                    for sx in 0..4 {
                        if inside(pts, px as f32 + (sx as f32 + 0.5) / 4.0, py as f32 + (sy as f32 + 0.5) / 4.0) {
                            n += 1;
                        }
                    }
                }
                if n > 0 {
                    self.blend(px, py, c, n as f32 / 16.0 * alpha);
                }
            }
        }
    }

    /// Every pixel's alpha multiplied (a dimmed picture).
    pub fn fade(&mut self, k: f32) {
        for p in self.px.chunks_exact_mut(4) {
            p[3] = (f32::from(p[3]) * k).round().clamp(0.0, 255.0) as u8;
        }
    }

    /// Fully clear pixels given the faintest alpha, so a layered window takes clicks over its whole box.
    pub fn catch_clicks(&mut self) {
        for p in self.px.chunks_exact_mut(4) {
            if p[3] == 0 {
                p[3] = 1;
            }
        }
    }

    /// The alpha at (x, y) (tests and the strip's hit box).
    pub fn alpha(&self, x: u32, y: u32) -> u8 {
        if x >= self.w || y >= self.h {
            return 0;
        }
        self.px.get(((y * self.w + x) * 4 + 3) as usize).copied().unwrap_or(0)
    }

    /// The colour at (x, y).
    pub fn rgb(&self, x: u32, y: u32) -> Rgb {
        let i = ((y.min(self.h - 1) * self.w + x.min(self.w - 1)) * 4) as usize;
        match self.px.get(i..i + 3) {
            Some(p) => Rgb(p[0], p[1], p[2]),
            None => Rgb(0, 0, 0),
        }
    }
}

fn seg_dist(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    let (dx, dy) = (bx - ax, by - ay);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((px - ax) * dx + (py - ay) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    let (qx, qy) = (ax + t * dx - px, ay + t * dy - py);
    (qx * qx + qy * qy).sqrt()
}

fn inside(pts: &[(f32, f32)], x: f32, y: f32) -> bool {
    let mut c = false;
    let n = pts.len();
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = pts[i];
        let (xj, yj) = pts[j];
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            c = !c;
        }
        j = i;
    }
    c
}

// ---------------------------------------------------------------- our own glyphs (strokes in a 4 × 7 box)

type Path = &'static [(f32, f32)];

/// The digits, «?», «-», «%»: each a few polylines in a box 4 wide and 7 high (y down). Our own drawing.
fn glyph(c: char) -> &'static [Path] {
    const Z: &[Path] = &[&[(1.0, 0.0), (3.0, 0.0), (4.0, 1.2), (4.0, 5.8), (3.0, 7.0), (1.0, 7.0), (0.0, 5.8), (0.0, 1.2), (1.0, 0.0)]];
    match c {
        '0' => Z,
        '1' => &[&[(0.8, 1.6), (2.6, 0.0), (2.6, 7.0)]],
        '2' => &[&[(0.0, 1.4), (1.0, 0.0), (3.0, 0.0), (4.0, 1.2), (4.0, 2.6), (0.0, 7.0), (4.0, 7.0)]],
        '3' => &[&[(0.2, 0.0), (4.0, 0.0), (1.8, 2.9), (3.0, 2.9), (4.0, 4.0), (4.0, 5.9), (3.0, 7.0), (1.0, 7.0), (0.0, 6.0)]],
        '4' => &[&[(3.0, 7.0), (3.0, 0.0), (0.0, 4.9), (4.0, 4.9)]],
        '5' => &[&[(3.9, 0.0), (0.4, 0.0), (0.1, 3.0), (3.0, 3.0), (4.0, 4.0), (4.0, 5.9), (3.0, 7.0), (1.0, 7.0), (0.0, 6.1)]],
        '6' => &[&[(3.4, 0.0), (2.0, 0.0), (0.0, 2.6), (0.0, 5.9), (1.0, 7.0), (3.0, 7.0), (4.0, 5.9), (4.0, 4.3), (3.0, 3.3), (1.0, 3.3), (0.0, 4.3)]],
        '7' => &[&[(0.0, 0.0), (4.0, 0.0), (1.4, 7.0)]],
        '8' => &[
            &[(1.0, 0.0), (3.0, 0.0), (3.9, 0.9), (3.9, 2.4), (3.0, 3.3), (1.0, 3.3), (0.1, 2.4), (0.1, 0.9), (1.0, 0.0)],
            &[(1.0, 3.3), (0.0, 4.3), (0.0, 6.0), (1.0, 7.0), (3.0, 7.0), (4.0, 6.0), (4.0, 4.3), (3.0, 3.3)],
        ],
        '9' => &[&[(0.6, 7.0), (2.0, 7.0), (4.0, 4.4), (4.0, 1.1), (3.0, 0.0), (1.0, 0.0), (0.0, 1.1), (0.0, 2.7), (1.0, 3.7), (3.0, 3.7), (4.0, 2.7)]],
        '?' => &[&[(0.0, 1.4), (1.0, 0.0), (3.0, 0.0), (4.0, 1.1), (4.0, 2.4), (2.0, 3.9), (2.0, 4.9)], &[(2.0, 6.9), (2.0, 6.9)]],
        '-' => &[&[(0.6, 3.6), (3.4, 3.6)]],
        '%' => &[
            &[(0.1, 7.0), (3.9, 0.0)],
            &[(0.8, 0.2), (1.5, 0.9), (0.8, 1.6), (0.1, 0.9), (0.8, 0.2)],
            &[(3.2, 5.4), (3.9, 6.1), (3.2, 6.8), (2.5, 6.1), (3.2, 5.4)],
        ],
        // (Piece S1, the system on the taskbar: the labels' letters and the degree sign — our own strokes too.)
        'C' => &[&[(4.0, 1.2), (3.0, 0.0), (1.0, 0.0), (0.0, 1.2), (0.0, 5.8), (1.0, 7.0), (3.0, 7.0), (4.0, 5.8)]],
        'P' => &[&[(0.0, 7.0), (0.0, 0.0), (3.0, 0.0), (4.0, 1.0), (4.0, 2.7), (3.0, 3.7), (0.0, 3.7)]],
        'U' => &[&[(0.0, 0.0), (0.0, 5.8), (1.0, 7.0), (3.0, 7.0), (4.0, 5.8), (4.0, 0.0)]],
        'R' => &[&[(0.0, 7.0), (0.0, 0.0), (3.0, 0.0), (4.0, 1.0), (4.0, 2.7), (3.0, 3.7), (0.0, 3.7)], &[(2.0, 3.7), (4.0, 7.0)]],
        'A' => &[&[(0.0, 7.0), (0.0, 1.6), (1.3, 0.0), (2.7, 0.0), (4.0, 1.6), (4.0, 7.0)], &[(0.0, 4.3), (4.0, 4.3)]],
        'M' => &[&[(0.0, 7.0), (0.0, 0.0), (2.0, 3.8), (4.0, 0.0), (4.0, 7.0)]],
        'G' => &[&[(4.0, 1.2), (3.0, 0.0), (1.0, 0.0), (0.0, 1.2), (0.0, 5.8), (1.0, 7.0), (3.0, 7.0), (4.0, 5.8), (4.0, 4.0), (2.3, 4.0)]],
        'V' => &[&[(0.0, 0.0), (2.0, 7.0), (4.0, 0.0)]],
        'S' => &[&[(4.0, 1.0), (3.0, 0.0), (1.0, 0.0), (0.0, 1.0), (0.0, 2.6), (1.0, 3.5), (3.0, 3.5), (4.0, 4.4), (4.0, 6.0), (3.0, 7.0), (1.0, 7.0), (0.0, 6.0)]],
        'D' => &[&[(0.0, 0.0), (0.0, 7.0), (2.4, 7.0), (4.0, 5.4), (4.0, 1.6), (2.4, 0.0), (0.0, 0.0)]],
        '°' => &[&[(1.0, 0.1), (2.2, 0.1), (2.9, 0.9), (2.9, 1.5), (2.2, 2.3), (1.0, 2.3), (0.3, 1.5), (0.3, 0.9), (1.0, 0.1)]],
        _ => &[],
    }
}

/// The text's width once drawn at glyph height `gh` (the box's 7) with stroke `sw` and squeeze `sx` (1 = natural).
fn text_width(n: usize, gh: f32, sw: f32, sx: f32) -> f32 {
    if n == 0 {
        return 0.0;
    }
    let s = gh / 7.0;
    let gap = (sw * 0.85).max(1.0) * sx.max(0.5);
    n as f32 * 4.0 * s * sx + (n as f32 - 1.0) * gap + sw
}

/// Text drawn in our strokes: its top-left at (x, y), `h` high in all (stroke included), squeezed to `max_w`.
/// Returns the width used.
pub fn draw_text(cv: &mut Canvas, text: &str, x: f32, y: f32, h: f32, max_w: f32, c: Rgb, alpha: f32) -> f32 {
    let chars: Vec<char> = text.chars().filter(|c| !glyph(*c).is_empty()).collect();
    let n = chars.len();
    if n == 0 || !(h > 0.0) {
        return 0.0;
    }
    let mut sw = (h * 0.15).max(1.35);
    let gh = (h - sw).max(1.0);
    let mut sx = 1.0f32;
    let natural = text_width(n, gh, sw, 1.0);
    if natural > max_w {
        // (Squeezed sideways; the strokes thin a little with it, so a narrow «100» keeps its holes.)
        sx = ((max_w - sw) / (natural - sw)).clamp(0.35, 1.0);
        sw = (sw * (0.75 + 0.25 * sx)).max(1.2);
    }
    let s = gh / 7.0;
    let gap = (sw * 0.85).max(1.0) * sx.max(0.5);
    let adv = 4.0 * s * sx + gap;
    let mut segs: Vec<(f32, f32, f32, f32)> = Vec::new();
    for (i, ch) in chars.iter().enumerate() {
        let ox = x + sw / 2.0 + i as f32 * adv;
        let oy = y + sw / 2.0;
        for path in glyph(*ch) {
            for w in path.windows(2) {
                segs.push((ox + w[0].0 * s * sx, oy + w[0].1 * s, ox + w[1].0 * s * sx, oy + w[1].1 * s));
            }
        }
    }
    cv.stroke(&segs, sw, c, alpha);
    text_width(n, gh, sw, sx)
}

// ---------------------------------------------------------------- the device kinds' small drawings (24 × 24 grid)

/// The drawing on the strip for a device: by its picture (the user's choice or its reader's), else its kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Glyph {
    Headset,
    Earbuds,
    Mouse,
    Keyboard,
    Pad,
    Phone,
    Speaker,
    Other,
}

impl Glyph {
    /// A picture's name (the page's drawn set: btconnect.ts) or else the kind's name.
    pub fn of(picture: &str, kind: &str) -> Glyph {
        let by = |s: &str| match s {
            "headset" => Some(Glyph::Headset),
            "earbuds" => Some(Glyph::Earbuds),
            "mouse" => Some(Glyph::Mouse),
            "keyboard" => Some(Glyph::Keyboard),
            "pad" | "retro" | "split" | "half" | "trackpads" | "controller" => Some(Glyph::Pad),
            "phone" => Some(Glyph::Phone),
            "speaker" => Some(Glyph::Speaker),
            "pen" | "other" => Some(Glyph::Other),
            _ => None,
        };
        by(picture).or_else(|| by(kind)).unwrap_or(Glyph::Other)
    }
}

/// The pictures a user may choose for a device (the page's set; btconnect.ts PIC).
pub const PICTURES: [&str; 13] = ["mouse", "keyboard", "headset", "earbuds", "pad", "retro", "split", "half", "trackpads", "speaker", "phone", "pen", "other"];

fn rrect(x: f32, y: f32, w: f32, h: f32, r: f32) -> Vec<(f32, f32)> {
    let mut v = Vec::new();
    let corners = [(x + w - r, y + r, -90.0f32), (x + w - r, y + h - r, 0.0), (x + r, y + h - r, 90.0), (x + r, y + r, 180.0)];
    for (cx, cy, a0) in corners {
        for k in 0..=4 {
            let a = (a0 + k as f32 * 22.5).to_radians();
            v.push((cx + r * a.cos(), cy + r * a.sin()));
        }
    }
    if let Some(f) = v.first().copied() {
        v.push(f);
    }
    v
}

fn circle(cx: f32, cy: f32, r: f32) -> Vec<(f32, f32)> {
    (0..=12).map(|k| { let a = (k as f32 * 30.0).to_radians(); (cx + r * a.cos(), cy + r * a.sin()) }).collect()
}

fn dot(x: f32, y: f32) -> Vec<(f32, f32)> {
    vec![(x, y), (x, y)]
}

fn glyph_paths(g: Glyph) -> Vec<Vec<(f32, f32)>> {
    match g {
        Glyph::Mouse => vec![rrect(6.5, 3.0, 11.0, 18.0, 5.5), vec![(12.0, 3.0), (12.0, 9.0)], vec![(6.5, 9.0), (17.5, 9.0)]],
        Glyph::Keyboard => vec![rrect(2.5, 6.0, 19.0, 12.0, 2.5), dot(6.0, 10.0), dot(9.5, 10.0), dot(13.0, 10.0), dot(16.5, 10.0), dot(6.0, 13.8), dot(18.0, 13.8), vec![(9.0, 14.2), (15.0, 14.2)]],
        Glyph::Headset => {
            let mut arc = vec![(4.0, 15.0)];
            for k in 0..=8 {
                let a = (180.0 + k as f32 * 22.5f32).to_radians();
                arc.push((12.0 + 8.0 * a.cos(), 12.0 + 8.0 * a.sin()));
            }
            arc.push((20.0, 15.0));
            vec![arc, rrect(3.0, 14.0, 4.5, 6.5, 1.8), rrect(16.5, 14.0, 4.5, 6.5, 1.8)]
        }
        Glyph::Earbuds => vec![rrect(4.0, 4.5, 6.0, 7.5, 3.0), rrect(14.0, 4.5, 6.0, 7.5, 3.0), vec![(8.0, 12.0), (8.0, 19.5)], vec![(16.0, 12.0), (16.0, 19.5)]],
        Glyph::Pad => vec![
            vec![(7.0, 7.0), (17.0, 7.0), (20.5, 8.5), (22.0, 12.0), (21.2, 16.8), (19.6, 18.3), (17.6, 17.6), (15.0, 15.8), (9.0, 15.8), (6.4, 17.6), (4.4, 18.3), (2.8, 16.8), (2.0, 12.0), (3.5, 8.5), (7.0, 7.0)],
            vec![(7.5, 9.8), (7.5, 13.2)],
            vec![(5.8, 11.5), (9.2, 11.5)],
            dot(16.0, 10.3),
            dot(17.8, 12.6),
        ],
        Glyph::Phone => vec![rrect(7.0, 2.5, 10.0, 19.0, 2.5), vec![(11.0, 18.5), (13.0, 18.5)]],
        Glyph::Speaker => vec![rrect(5.0, 2.5, 14.0, 19.0, 3.0), circle(12.0, 14.5, 3.5), dot(12.0, 7.0)],
        Glyph::Other => vec![rrect(4.0, 5.0, 16.0, 14.0, 3.0), vec![(9.0, 12.0), (15.0, 12.0)]],
    }
}

/// A kind's drawing, `size` square at (x, y).
pub fn draw_glyph(cv: &mut Canvas, g: Glyph, x: f32, y: f32, size: f32, c: Rgb, alpha: f32) {
    let k = size / 24.0;
    let mut segs = Vec::new();
    for p in glyph_paths(g) {
        for w in p.windows(2) {
            segs.push((x + w[0].0 * k, y + w[0].1 * k, x + w[1].0 * k, y + w[1].1 * k));
        }
    }
    cv.stroke(&segs, (1.9 * k).max(1.2), c, alpha);
}

/// The charging bolt, `size` square at (x, y), filled.
pub fn draw_bolt(cv: &mut Canvas, x: f32, y: f32, size: f32, c: Rgb, alpha: f32) {
    let k = size / 24.0;
    let pts: Vec<(f32, f32)> = [(13.5, 1.5), (4.5, 13.5), (11.5, 13.5), (10.5, 22.5), (19.5, 10.5), (12.5, 10.5), (13.5, 1.5)].iter().map(|(a, b)| (x + a * k, y + b * k)).collect();
    cv.fill_poly(&pts, c, alpha);
}

// ---------------------------------------------------------------- a tray icon

/// A tray icon's side in pixels for a screen's DPI (16 at 96 DPI, Windows' small icon), within 16–64.
pub fn icon_px(dpi: u32) -> u32 {
    let d = if dpi == 0 { 96 } else { dpi };
    ((16 * d + 48) / 96).clamp(16, 64)
}

fn frac(s: Shown) -> Option<f32> {
    match s {
        Shown::Pct(p) => Some(f32::from(p.min(100)) / 100.0),
        Shown::Part(n, m) if m > 0 => Some((f32::from(n) / f32::from(m)).clamp(0.0, 1.0)),
        _ => None,
    }
}

/// The small battery: an outline with its cap, filled to the level; «?» inside when unknown. Lines on whole pixels
/// where they can be, so a 16-pixel icon stays crisp.
fn draw_battery(cv: &mut Canvas, f: &Face, x: f32, y: f32, w: f32, h: f32, light: bool) {
    let colour = tone_rgb(f.tone, light);
    let line = if f.tone == Tone::Low { colour } else { fg(light) };
    let sw = (h * 0.13).round().max(1.0);
    let cap = (w * 0.1).round().max(1.0);
    let bw = (w - cap).round();
    let (x, y, h) = (x.round(), y.round(), h.round());
    cv.rect(x, y, bw, sw, line, 1.0);
    cv.rect(x, y + h - sw, bw, sw, line, 1.0);
    cv.rect(x, y + sw, sw, h - 2.0 * sw, line, 1.0);
    cv.rect(x + bw - sw, y + sw, sw, h - 2.0 * sw, line, 1.0);
    cv.rect(x + bw, y + (h * 0.3).round(), cap, h - 2.0 * (h * 0.3).round(), line, 1.0);
    let inset = sw + (h * 0.08).round().max(1.0);
    let (ix, iy, iw, ih) = (x + inset, y + inset, bw - 2.0 * inset, h - 2.0 * inset);
    match frac(f.shown) {
        Some(k) => {
            // (Something left is always visible: a sliver, never an empty box for 1 %.)
            let fw = if k > 0.0 { (iw * k).round().max(1.0) } else { 0.0 };
            cv.rect(ix, iy, fw, ih, colour, 1.0);
        }
        None => {
            let ch = if f.shown == Shown::Nothing { "-" } else { "?" };
            let th = (ih + 1.0).max(4.0);
            let tw = th * 0.7;
            draw_text(cv, ch, x + (bw - tw) / 2.0, y + (h - th) / 2.0, th, tw, fg(light), 1.0);
        }
    }
}

/// A tray icon, `px` square: the number with a bar under it (Number) or the small battery (Bar). A level in steps or
/// words is always the battery. Straight RGBA.
pub fn render_icon(f: &Face, draw: DrawStyle, light: bool, px: u32) -> Canvas {
    let s = px.clamp(8, 256);
    let mut cv = Canvas::new(s, s);
    let sf = s as f32;
    let number = match f.shown {
        Shown::Pct(p) => Some(p.min(100).to_string()),
        Shown::Unknown => Some("?".to_string()),
        Shown::Nothing => Some("-".to_string()),
        Shown::Part(..) => None,
    };
    match (draw, number) {
        (DrawStyle::Number, Some(text)) => {
            let bar_h = (sf * 0.14).round().max(2.0);
            let gap = (sf / 16.0).round().max(1.0);
            let th = sf - bar_h - gap;
            let colour = if powered(f.tone) { fg(light) } else { tone_rgb(f.tone, light) };
            // (Centred: drawn once to know its width, then where it belongs.)
            let mut probe = Canvas::new(s, s);
            let tw = draw_text(&mut probe, &text, 0.0, 0.0, th, sf, colour, 1.0);
            draw_text(&mut cv, &text, ((sf - tw) / 2.0).max(0.0), 0.0, th, sf, colour, 1.0);
            let track = fg(light);
            let y = sf - bar_h;
            cv.rect(0.0, y, sf, bar_h, track, 0.28);
            if let Some(k) = frac(f.shown) {
                let w = if k > 0.0 { (sf * k).max(1.0) } else { 0.0 };
                cv.rect(0.0, y, w, bar_h, tone_rgb(f.tone, light), 1.0);
            }
        }
        _ => {
            let h = (sf * 0.62).round();
            if powered(f.tone) && frac(f.shown).is_some() {
                // (On power: a narrower battery and the bolt — or the check — beside it, so neither hides the other.)
                let b = (sf * 0.4).round();
                let bh = (h * 0.8).round();
                draw_battery(&mut cv, f, 0.0, ((sf - bh) / 2.0).round(), sf - b + 1.0, bh, light);
                draw_power(&mut cv, f.tone, sf - b, ((sf - b) / 2.0).round() - 1.0, b + 1.0, light);
            } else {
                draw_battery(&mut cv, f, 0.0, ((sf - h) / 2.0).round(), sf, h, light);
            }
        }
    }
    if f.dim {
        cv.fade(DIM);
    }
    cv
}

// ---------------------------------------------------------------- the strip on the taskbar

/// One device on the strip.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StripItem {
    pub glyph: Glyph,
    pub face: Face,
    /// A small number on the drawing when two devices share it (captions()).
    pub caption: Option<u8>,
}

/// The strip's options (the «Taskbar» card).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StripLook {
    pub light: bool,
    /// The drawing above the level (narrower), as the original's «Icons above percentages».
    pub stacked: bool,
    /// A soft plate behind (for transparent taskbars), as the original's «Background behind taskbar text».
    pub plate: bool,
}

/// Each cell's left edge and width, and the whole strip's width, for a taskbar `bar_h` pixels high.
#[derive(Clone, Debug, PartialEq)]
pub struct StripLayout {
    pub cells: Vec<(f32, f32)>,
    pub width: u32,
    pub height: u32,
    pub glyph: f32,
    pub text_h: f32,
}

fn strip_text(f: &Face) -> Option<String> {
    match f.shown {
        Shown::Pct(p) => Some(format!("{}%", p.min(100))),
        Shown::Unknown => Some("?".into()),
        Shown::Nothing => Some("-".into()),
        Shown::Part(..) => None,
    }
}

/// The strip's measures: cells side by side (or the drawing above the level when stacked), a real gap between cells,
/// within the taskbar's height.
pub fn strip_layout(items: &[StripItem], bar_h: u32, look: StripLook) -> StripLayout {
    let hb = bar_h.clamp(16, 400) as f32;
    let height = (hb * 0.84).round();
    let (g, th) = if look.stacked { ((hb * 0.34).round(), (hb * 0.25).round()) } else { ((hb * 0.42).round(), (hb * 0.30).round()) };
    let pad = (hb * 0.12).round().max(3.0);
    let gap_in = (hb * 0.08).round().max(2.0);
    let between = (hb * 0.2).round().max(6.0);
    let mut x = pad;
    let mut cells = Vec::new();
    for (i, it) in items.iter().enumerate() {
        let text_w = match strip_text(&it.face) {
            Some(t) => text_width(t.chars().count(), (th - (th * 0.15).max(1.35)).max(1.0), (th * 0.15).max(1.35), 1.0),
            None => th * 1.7,
        };
        let bolt = if powered(it.face.tone) { th * 0.8 } else { 0.0 };
        let w = if look.stacked { g.max(text_w + bolt) } else { g + gap_in + text_w + bolt };
        if i > 0 {
            x += between;
        }
        cells.push((x, w.ceil()));
        x += w.ceil();
    }
    let width = if items.is_empty() { 0 } else { (x + pad).ceil() as u32 };
    StripLayout { cells, width, height: height as u32, glyph: g, text_h: th }
}

/// The strip drawn: straight RGBA, `width × height` of strip_layout. (Piece S1: sysmon::render_bar draws the same
/// devices with the system's cells beside them; with none, the very same picture.)
pub fn render_strip(items: &[StripItem], bar_h: u32, look: StripLook) -> Canvas {
    let lay = strip_layout(items, bar_h, look);
    let mut cv = Canvas::new(lay.width.max(1), lay.height.max(1));
    let hh = lay.height as f32;
    if look.plate && lay.width > 0 {
        let back = if look.light { Rgb(248, 248, 250) } else { Rgb(32, 32, 36) };
        cv.round_rect(0.0, 0.0, lay.width as f32, hh, hh * 0.3, back, 0.86);
    }
    for (it, &(x, w)) in items.iter().zip(lay.cells.iter()) {
        let cell = render_device_cell(it, w, lay.height, &lay, bar_h, look);
        blit(&mut cv, &cell, x.round() as i64, 0);
    }
    cv
}

/// One device's cell on the strip, `w × height`, with the sizes of `lay` (strip_layout's).
pub fn render_device_cell(it: &StripItem, w: f32, height: u32, lay: &StripLayout, bar_h: u32, look: StripLook) -> Canvas {
    let hh = height as f32;
    let mut cell = Canvas::new(w.ceil().max(1.0) as u32, height.max(1));
    let line = fg(look.light);
    let (g, th) = (lay.glyph, lay.text_h);
    let text = strip_text(&it.face);
    let colour = if powered(it.face.tone) { line } else { tone_rgb(it.face.tone, look.light) };
    let (gx, gy, tx, ty) = if look.stacked {
        let total = g + th * 0.2 + th;
        let top = (hh - total) / 2.0;
        ((w - g) / 2.0, top, 0.0, top + g + th * 0.2)
    } else {
        (0.0, (hh - g) / 2.0, g + (bar_h as f32 * 0.08).round().max(2.0), (hh - th) / 2.0)
    };
    draw_glyph(&mut cell, it.glyph, gx, gy, g, line, 1.0);
    if let Some(n) = it.caption {
        let ch = (g * 0.46).round().max(6.0);
        let s = (n % 10).to_string();
        let cw = ch * 0.75;
        cell.round_rect(gx + g - cw * 0.9, gy - ch * 0.15, cw + 2.0, ch + 1.0, 2.0, if look.light { Rgb(248, 248, 250) } else { Rgb(32, 32, 36) }, 0.9);
        draw_text(&mut cell, &s, gx + g - cw * 0.9 + 1.0, gy - ch * 0.15 + 0.5, ch, cw, line, 1.0);
    }
    match text {
        Some(t) => {
            let tx = if look.stacked {
                let mut probe = Canvas::new(cell.w, cell.h);
                let tw = draw_text(&mut probe, &t, 0.0, 0.0, th, w, colour, 1.0) + if powered(it.face.tone) { th * 0.8 } else { 0.0 };
                ((w - tw) / 2.0).max(0.0)
            } else {
                tx
            };
            let used = draw_text(&mut cell, &t, tx, ty, th, w - tx, colour, 1.0);
            if powered(it.face.tone) {
                draw_power(&mut cell, it.face.tone, tx + used, ty, th * 0.8, look.light);
            }
        }
        None => {
            let bx = if look.stacked { (w - th * 1.7) / 2.0 } else { tx };
            draw_battery(&mut cell, &it.face, bx, ty + th * 0.12, th * 1.7, th * 0.76, look.light);
            if powered(it.face.tone) {
                draw_power(&mut cell, it.face.tone, bx + th * 1.7, ty, th * 0.8, look.light);
            }
        }
    }
    if it.face.dim {
        cell.fade(DIM);
    }
    cell
}

/// `src` laid over `dst` with its top-left at (ox, oy).
pub fn blit(dst: &mut Canvas, src: &Canvas, ox: i64, oy: i64) {
    for y in 0..src.h {
        for x in 0..src.w {
            let i = ((y * src.w + x) * 4) as usize;
            if let Some(p) = src.px.get(i..i + 4) {
                if p[3] > 0 {
                    dst.blend(ox + i64::from(x), oy + i64::from(y), Rgb(p[0], p[1], p[2]), f32::from(p[3]) / 255.0);
                }
            }
        }
    }
}

/// A screen rectangle (left, top, right, bottom), as Windows gives it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub l: i32,
    pub t: i32,
    pub r: i32,
    pub b: i32,
}

impl Rect {
    pub fn w(&self) -> i32 {
        self.r - self.l
    }
    pub fn h(&self) -> i32 {
        self.b - self.t
    }
}

/// What the strip sits beside: the notification area, widened by buttons Windows puts right next to it on the strip's side
/// (Windows 10's «news and interests», the original's v1.1.0) — those within a bar's height of it, hidden ones not given.
pub fn anchor(bar: Rect, notify: Rect, beside: &[Rect]) -> Rect {
    let mirrored = (notify.l + notify.r) / 2 < (bar.l + bar.r) / 2;
    let reach = bar.h().max(1);
    let mut a = notify;
    for _ in 0..beside.len() {
        for r in beside {
            if r.w() <= 0 || r.b <= bar.t || r.t >= bar.b {
                continue;
            }
            if !mirrored && r.r <= a.l + 2 && r.r >= a.l - reach && r.l < a.l {
                a.l = r.l;
            } else if mirrored && r.l >= a.r - 2 && r.l <= a.r + reach && r.r > a.r {
                a.r = r.r;
            }
        }
    }
    a
}

/// Where the strip goes, in the taskbar's own coordinates (x, y): beside the notification area on the side of the task
/// buttons — left of it on a left-to-right taskbar, right of it on a mirrored (right-to-left) one — and centred in the
/// height. None when the taskbar stands on a side (left or right) or the strip would not fit.
pub fn place_strip(bar: Rect, notify: Rect, w: u32, h: u32) -> Option<(i32, i32)> {
    if bar.w() <= bar.h() || w == 0 || h == 0 {
        return None;
    }
    let (w, h) = (i32::try_from(w).ok()?, i32::try_from(h).ok()?);
    if h > bar.h() {
        return None;
    }
    let margin = (bar.h() / 8).max(4);
    let mirrored = (notify.l + notify.r) / 2 < (bar.l + bar.r) / 2;
    let x = if mirrored { notify.r + margin } else { notify.l - margin - w };
    if x < bar.l || x + w > bar.r {
        return None;
    }
    Some((x - bar.l, (bar.h() - h) / 2))
}

// ---------------------------------------------------------------- order, captions, hover text, choice

/// The original's default order by kind: headset (and earbuds) first, then mouse, keyboard, controller, phone, the rest.
pub fn kind_rank(kind: &str) -> u8 {
    match kind {
        "headset" => 0,
        "earbuds" => 1,
        "mouse" => 2,
        "keyboard" => 3,
        "controller" => 4,
        "phone" => 5,
        "speaker" => 6,
        _ => 7,
    }
}

/// The devices in the user's order (his list of keys first, in it), then by kind and name (and key, for a fixed order).
pub fn ordered<T>(mut items: Vec<T>, key: impl Fn(&T) -> String, kind: impl Fn(&T) -> String, name: impl Fn(&T) -> String, user: &[String]) -> Vec<T> {
    items.sort_by(|a, b| {
        let ra = user.iter().position(|k| *k == key(a)).unwrap_or(usize::MAX);
        let rb = user.iter().position(|k| *k == key(b)).unwrap_or(usize::MAX);
        ra.cmp(&rb).then(kind_rank(&kind(a)).cmp(&kind_rank(&kind(b)))).then(name(a).to_lowercase().cmp(&name(b).to_lowercase())).then(key(a).cmp(&key(b)))
    });
    items
}

/// The user's order after moving `key` one place up (-1) or down (+1) among `shown` (the keys as now ordered); keys of
/// devices not shown keep their places after them (as the original). At most 200 kept.
pub fn moved(shown: &[String], user: &[String], key: &str, dir: i32) -> Vec<String> {
    let mut order: Vec<String> = shown.to_vec();
    if let Some(i) = order.iter().position(|k| k == key) {
        let j = i as i64 + i64::from(dir.signum());
        if j >= 0 && (j as usize) < order.len() {
            order.swap(i, j as usize);
        }
    }
    for k in user {
        if !order.contains(k) {
            order.push(k.clone());
        }
    }
    order.truncate(200);
    order
}

/// A caption per device: when two or more share a drawing, each is numbered 1, 2 … in the order given; alone, none.
pub fn captions(glyphs: &[Glyph]) -> Vec<Option<u8>> {
    let mut seen: Vec<(Glyph, u8)> = Vec::new();
    glyphs
        .iter()
        .map(|g| {
            if glyphs.iter().filter(|x| *x == g).count() < 2 {
                return None;
            }
            match seen.iter_mut().find(|(x, _)| x == g) {
                Some((_, n)) => {
                    *n = n.saturating_add(1);
                    Some(*n)
                }
                None => {
                    seen.push((*g, 1));
                    Some(1)
                }
            }
        })
        .collect()
}

/// A device icon's hover text: its name, then what it says, within Windows' 127 units.
pub fn device_tip(name: &str, what: &str) -> String {
    crate::summary::clip_utf16(&format!("{name}\n{what}"), crate::summary::TIP_MAX_UTF16)
}

/// A device's presence for the taskbar: answering, asleep or known only by its last level, or not connected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Presence {
    Live,
    Asleep,
    Gone,
}

/// Which devices get a picture: those in the given order that are wanted (not hidden, not left alone), answering — or
/// asleep with a last level while «show asleep devices» is on (the original's «Hide last known / asleep devices» off),
/// or not connected while «show disconnected devices» is on (its v1.1.0, off by default); at most MAX_ICONS.
pub fn icon_picks(items: &[(Presence, bool)], show_asleep: bool, show_gone: bool) -> Vec<usize> {
    items
        .iter()
        .enumerate()
        .filter(|(_, (p, wanted))| *wanted && match p { Presence::Live => true, Presence::Asleep => show_asleep, Presence::Gone => show_gone })
        .map(|(i, _)| i)
        .take(MAX_ICONS)
        .collect()
}

/// Whether a minute of the day (0–1439, local) falls in the quiet hours from `from` to `to` (hours 0–23; to ≤ from
/// spans midnight; equal: no quiet hours).
pub fn quiet_now(minute: u16, from: u8, to: u8) -> bool {
    let (m, f, t) = (u32::from(minute % 1440), u32::from(from % 24) * 60, u32::from(to % 24) * 60);
    if f == t {
        false
    } else if f < t {
        m >= f && m < t
    } else {
        m >= f || m < t
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Percent, Steps};

    fn ex(p: i64) -> Option<Level> {
        Some(Level::Exact(Percent::new(p).unwrap()))
    }

    #[test]
    fn faces_follow_the_page_rules() {
        assert_eq!(face(ex(64), false, true, 20), Face { shown: Shown::Pct(64), tone: Tone::Normal, dim: false });
        assert_eq!(face(ex(20), false, true, 20).tone, Tone::Low, "at the mark is low");
        assert_eq!(face(ex(9), true, true, 20).tone, Tone::Charging, "charging is never low");
        assert_eq!(face(ex(9), false, false, 20), Face { shown: Shown::Pct(9), tone: Tone::Normal, dim: true }, "asleep: dimmed, not red");
        let st = face(Some(Level::Steps(Steps::new(1, 4).unwrap())), false, true, 20);
        assert_eq!((st.shown, st.tone), (Shown::Part(1, 4), Tone::Low), "steps never become a number");
        assert_eq!(face(Some(Level::Coarse(Coarse::Medium)), false, true, 20).shown, Shown::Part(3, 5));
        assert_eq!(face(None, false, true, 20).shown, Shown::Unknown);
    }

    fn count_ink(cv: &Canvas) -> usize {
        cv.px.chunks_exact(4).filter(|p| p[3] > 128).count()
    }

    #[test]
    fn icons_are_drawn_at_every_size_within_their_box() {
        for px in [16, 20, 24, 32, 48] {
            for f in [face(ex(100), false, true, 20), face(ex(7), false, true, 20), face(ex(55), true, true, 20), face(None, false, true, 20), Face::NOTHING] {
                for d in [DrawStyle::Number, DrawStyle::Bar] {
                    let cv = render_icon(&f, d, false, px);
                    assert_eq!((cv.w, cv.h, cv.px.len()), (px, px, (px * px * 4) as usize));
                    assert!(count_ink(&cv) > 0 || f.dim, "something drawn at {px} px: {f:?} {d:?}");
                }
            }
        }
        // «100» at 16 px still fits: nothing beyond the box (the canvas clips, so look at the edge columns' share).
        let cv = render_icon(&face(ex(100), false, true, 20), DrawStyle::Number, false, 16);
        assert!(count_ink(&cv) > 30);
    }

    #[test]
    fn colours_low_red_charging_blue_asleep_faint_no_yellow() {
        let px = 32;
        let low = render_icon(&face(ex(8), false, true, 20), DrawStyle::Number, false, px);
        let bar_y = px - 2;
        assert_eq!(low.rgb(1, bar_y), red(false), "the bar is red when low");
        let ch = render_icon(&face(ex(60), true, true, 20), DrawStyle::Number, false, px);
        assert_eq!(ch.rgb(1, bar_y), blue(false), "blue when charging");
        let ok = render_icon(&face(ex(60), false, true, 20), DrawStyle::Number, true, px);
        assert_eq!(ok.rgb(1, bar_y), fg(true), "the taskbar's own colour otherwise");
        let dim = render_icon(&face(ex(60), false, false, 20), DrawStyle::Number, false, px);
        let max_a = dim.px.chunks_exact(4).map(|p| p[3]).max().unwrap();
        assert!(max_a <= (255.0 * DIM).round() as u8 + 1, "dimmed: {max_a}");
        for cv in [&low, &ch, &ok, &dim] {
            for p in cv.px.chunks_exact(4).filter(|p| p[3] > 40) {
                let (r, g, b) = (i32::from(p[0]), i32::from(p[1]), i32::from(p[2]));
                assert!(!(r > 180 && g > 100 && b < 90 && r - b > 120), "no yellow, amber or orange: {p:?}");
            }
        }
    }

    #[test]
    fn levels_in_steps_are_a_filled_battery_never_a_number() {
        let half = render_icon(&face(Some(Level::Steps(Steps::new(5, 10).unwrap())), false, true, 20), DrawStyle::Number, false, 32);
        let full = render_icon(&face(Some(Level::Steps(Steps::new(10, 10).unwrap())), false, true, 20), DrawStyle::Number, false, 32);
        assert!(count_ink(&full) > count_ink(&half), "more filled when fuller");
        let bar = render_icon(&face(Some(Level::Steps(Steps::new(5, 10).unwrap())), false, true, 20), DrawStyle::Bar, false, 32);
        assert_eq!(half.px, bar.px, "the same drawing whichever style");
        let pct = render_icon(&face(ex(50), false, true, 20), DrawStyle::Number, false, 32);
        assert_ne!(pct.px, bar.px, "a real percentage is a number");
    }

    #[test]
    fn text_squeezes_to_its_width() {
        let mut cv = Canvas::new(64, 20);
        let w1 = draw_text(&mut cv, "100", 0.0, 0.0, 13.0, 64.0, fg(false), 1.0);
        let mut cv2 = Canvas::new(64, 20);
        let w2 = draw_text(&mut cv2, "100", 0.0, 0.0, 13.0, 16.0, fg(false), 1.0);
        assert!(w1 > 16.0 && w2 <= 16.5, "{w1} {w2}");
        assert_eq!(draw_text(&mut cv, "", 0.0, 0.0, 13.0, 16.0, fg(false), 1.0), 0.0);
        assert_eq!(draw_text(&mut cv, "ab", 0.0, 0.0, 13.0, 16.0, fg(false), 1.0), 0.0, "only our glyphs");
    }

    #[test]
    fn icon_sizes_by_dpi() {
        assert_eq!((icon_px(96), icon_px(120), icon_px(144), icon_px(192), icon_px(0), icon_px(10_000)), (16, 20, 24, 32, 16, 64));
    }

    fn item(g: Glyph, f: Face) -> StripItem {
        StripItem { glyph: g, face: f, caption: None }
    }

    #[test]
    fn strip_cells_keep_gaps_and_fit_the_bar() {
        let items = vec![item(Glyph::Headset, face(ex(30), false, true, 20)), item(Glyph::Mouse, face(ex(100), true, true, 20)), item(Glyph::Pad, face(Some(Level::Coarse(Coarse::Low)), false, true, 20))];
        for stacked in [false, true] {
            let look = StripLook { light: false, stacked, plate: true };
            let lay = strip_layout(&items, 48, look);
            assert_eq!(lay.cells.len(), 3);
            for w in lay.cells.windows(2) {
                assert!(w[1].0 >= w[0].0 + w[0].1 + 6.0, "a real gap between cells: {:?}", lay.cells);
            }
            assert!(lay.height <= 48 && lay.width as f32 >= lay.cells[2].0 + lay.cells[2].1);
            let cv = render_strip(&items, 48, look);
            assert_eq!((cv.w, cv.h), (lay.width, lay.height));
            assert!(count_ink(&cv) > 100);
        }
        let narrow = strip_layout(&items, 48, StripLook { light: false, stacked: true, plate: false });
        let wide = strip_layout(&items, 48, StripLook { light: false, stacked: false, plate: false });
        assert!(narrow.width < wide.width, "stacked is narrower");
        assert_eq!(strip_layout(&[], 48, StripLook { light: true, stacked: false, plate: false }).width, 0);
    }

    #[test]
    fn strip_click_box_and_plate() {
        let items = vec![item(Glyph::Mouse, face(ex(50), false, true, 20))];
        let mut cv = render_strip(&items, 40, StripLook { light: true, stacked: false, plate: false });
        assert_eq!(cv.alpha(0, 0), 0);
        cv.catch_clicks();
        assert!(cv.px.chunks_exact(4).all(|p| p[3] >= 1), "every pixel takes a click");
        let plated = render_strip(&items, 40, StripLook { light: true, stacked: false, plate: true });
        assert!(plated.alpha(plated.w / 2, 2) > 150, "a plate behind");
    }

    #[test]
    fn strip_placed_beside_the_notification_area() {
        let bar = Rect { l: 0, t: 1032, r: 1920, b: 1080 };
        let notify = Rect { l: 1700, t: 1032, r: 1920, b: 1080 };
        assert_eq!(place_strip(bar, notify, 120, 40), Some((1700 - 6 - 120, 4)));
        let mirrored = Rect { l: 0, t: 1032, r: 220, b: 1080 };
        assert_eq!(place_strip(bar, mirrored, 120, 40), Some((226, 4)), "right of it on a right-to-left taskbar");
        let side = Rect { l: 0, t: 0, r: 60, b: 1080 };
        assert_eq!(place_strip(side, Rect { l: 0, t: 900, r: 60, b: 1080 }, 50, 40), None, "a vertical taskbar: no strip");
        assert_eq!(place_strip(bar, notify, 2000, 40), None, "does not fit");
        assert_eq!(place_strip(bar, notify, 100, 60), None, "taller than the bar");
        let second = Rect { l: 1920, t: 1032, r: 3840, b: 1080 };
        assert_eq!(place_strip(second, Rect { l: 3700, t: 1032, r: 3840, b: 1080 }, 100, 40), Some((3700 - 6 - 100 - 1920, 4)), "in the bar's own coordinates");
    }

    #[test]
    fn order_user_first_then_kind_then_name() {
        let d = vec![("k1", "mouse", "Zed"), ("k2", "headset", "Alpha"), ("k3", "mouse", "beta"), ("k4", "other", "Aa"), ("k5", "controller", "Pad")];
        let o = ordered(d.clone(), |x| x.0.to_string(), |x| x.1.to_string(), |x| x.2.to_string(), &[]);
        assert_eq!(o.iter().map(|x| x.0).collect::<Vec<_>>(), vec!["k2", "k3", "k1", "k5", "k4"]);
        let user = vec!["k4".to_string(), "gone".to_string(), "k1".to_string()];
        let o = ordered(d, |x| x.0.to_string(), |x| x.1.to_string(), |x| x.2.to_string(), &user);
        assert_eq!(o.iter().map(|x| x.0).collect::<Vec<_>>(), vec!["k4", "k1", "k2", "k3", "k5"]);
    }

    #[test]
    fn moving_up_and_down() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(moved(&s(&["a", "b", "c"]), &[], "b", -1), s(&["b", "a", "c"]));
        assert_eq!(moved(&s(&["a", "b", "c"]), &[], "c", 1), s(&["a", "b", "c"]), "the last stays last");
        assert_eq!(moved(&s(&["a", "b", "c"]), &[], "a", -1), s(&["a", "b", "c"]));
        assert_eq!(moved(&s(&["a", "b"]), &s(&["x", "b", "a"]), "a", -1), s(&["a", "b", "x"]), "an absent device keeps a place");
        assert_eq!(moved(&s(&["a"]), &[], "zz", 1), s(&["a"]));
    }

    #[test]
    fn captions_only_for_shared_drawings() {
        assert_eq!(captions(&[Glyph::Mouse, Glyph::Headset, Glyph::Mouse, Glyph::Pad, Glyph::Mouse]), vec![Some(1), None, Some(2), None, Some(3)]);
        assert_eq!(captions(&[]), vec![]);
        assert_eq!(Glyph::of("retro", "controller"), Glyph::Pad);
        assert_eq!(Glyph::of("", "earbuds"), Glyph::Earbuds);
        assert_eq!(Glyph::of("phone", "mouse"), Glyph::Phone, "the user's picture wins");
        assert_eq!(Glyph::of("nonsense", "nonsense"), Glyph::Other);
        assert!(PICTURES.iter().all(|p| *p == "other" || *p == "pen" || Glyph::of(p, "") != Glyph::Other));
    }

    #[test]
    fn picks_and_tips() {
        use Presence::*;
        let items = [(Live, true), (Asleep, true), (Live, false), (Gone, true), (Live, true)];
        assert_eq!(icon_picks(&items, true, false), vec![0, 1, 4], "not connected: off by default, as the original");
        assert_eq!(icon_picks(&items, false, false), vec![0, 4], "asleep left out when asked");
        assert_eq!(icon_picks(&items, true, true), vec![0, 1, 3, 4]);
        assert_eq!(icon_picks(&items, false, true), vec![0, 3, 4]);
        assert_eq!(icon_picks(&[(Live, true); 20], true, false).len(), MAX_ICONS);
        let t = device_tip(&"x".repeat(300), "64%");
        assert!(t.encode_utf16().count() <= 127);
        assert_eq!(device_tip("Desk mouse", "64% · Charging"), "Desk mouse\n64% · Charging");
        assert_eq!(TrayStyle::parse("each"), Some(TrayStyle::Each));
        assert_eq!(TrayStyle::parse("x"), None);
        assert_eq!(DrawStyle::parse(DrawStyle::Bar.as_str()), Some(DrawStyle::Bar));
    }

    #[test]
    fn full_on_power_is_green_with_a_check() {
        let f = face(ex(100), true, true, 20);
        assert_eq!(f.tone, Tone::Full);
        assert_eq!(face(ex(99), true, true, 20).tone, Tone::Charging);
        assert_eq!(face(ex(100), false, true, 20).tone, Tone::Normal, "full but not on power: plain");
        assert_eq!(face(Some(Level::Steps(Steps::new(4, 4).unwrap())), true, true, 20).tone, Tone::Full);
        let cv = render_icon(&f, DrawStyle::Number, false, 32);
        assert_eq!(cv.rgb(1, 30), green(false), "the bar green");
        let strip = render_strip(&[item(Glyph::Mouse, f)], 48, StripLook { light: false, stacked: false, plate: false });
        assert!(strip.px.chunks_exact(4).any(|p| p[3] > 200 && Rgb(p[0], p[1], p[2]) == green(false)), "a green check on the strip");
        assert!(!strip.px.chunks_exact(4).any(|p| p[3] > 200 && Rgb(p[0], p[1], p[2]) == blue(false)), "no bolt");
    }

    #[test]
    fn the_strip_keeps_clear_of_buttons_beside_the_notification_area() {
        let bar = Rect { l: 0, t: 1032, r: 1920, b: 1080 };
        let notify = Rect { l: 1700, t: 1032, r: 1920, b: 1080 };
        let feeds = Rect { l: 1580, t: 1032, r: 1700, b: 1080 };
        assert_eq!(anchor(bar, notify, &[feeds]), Rect { l: 1580, ..notify });
        let far = Rect { l: 100, t: 1032, r: 300, b: 1080 };
        assert_eq!(anchor(bar, notify, &[far]), notify, "a button elsewhere changes nothing");
        assert_eq!(anchor(bar, notify, &[Rect { l: 1600, t: 0, r: 1700, b: 40 }]), notify, "not on this bar");
        let m_notify = Rect { l: 0, t: 1032, r: 220, b: 1080 };
        assert_eq!(anchor(bar, m_notify, &[Rect { l: 220, t: 1032, r: 330, b: 1080 }]).r, 330, "mirrored: to the right");
        assert_eq!(place_strip(bar, anchor(bar, notify, &[feeds]), 100, 40), Some((1580 - 6 - 100, 4)));
    }

    #[test]
    fn quiet_hours() {
        assert!(quiet_now(23 * 60, 22, 7) && quiet_now(0, 22, 7) && quiet_now(6 * 60 + 59, 22, 7));
        assert!(!quiet_now(7 * 60, 22, 7) && !quiet_now(12 * 60, 22, 7));
        assert!(quiet_now(13 * 60, 12, 14) && !quiet_now(14 * 60, 12, 14));
        assert!(!quiet_now(100, 5, 5), "equal: none");
        assert!(quiet_now(1440 + 23 * 60, 22, 7), "minutes past a day wrap");
    }
}
