// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — the system on the taskbar (piece S1): CPU load and temperature, memory in use, the graphics card's
// load, temperature and memory, a drive's temperature — beside the devices on the strip, or as tray icons with the
// number drawn. Pure and std only: which values show and in what order, what each says (units, rounding), how warm a
// temperature is (normal, warm: rose, hot: red — never orange), what changed since the last picture, which of Windows'
// sources are needed at all, when sampling rests (display off, session locked), and the reading of the raw figures
// Windows hands over (processor times, thermal zones in kelvin, the graphics engines' counters, a drive's temperature
// descriptor). win/sysmon.rs asks Windows for them; ../taskbar.rs's canvas draws.
// Inspired by TraySense by DMTWEAKS (https://github.com/DMTWEAKS/traysense, AGPL-3.0): the idea and the choice of
// Windows' public interfaces only — no code, structure or text taken (apps/tools/NOTICE.md). No driver, no
// administrator rights: a value Windows does not give an ordinary program is simply absent.
// Copyright (C) 2026 Kurokawa contributors.
use crate::taskbar::{self, Canvas, Rgb, StripItem, StripLook};

// ---------------------------------------------------------------- what can be shown

/// One value on the taskbar.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Metric {
    CpuLoad,
    CpuTemp,
    Ram,
    GpuLoad,
    GpuTemp,
    Vram,
    DriveTemp,
}

impl Metric {
    pub const ALL: [Metric; 7] = [Metric::CpuLoad, Metric::CpuTemp, Metric::Ram, Metric::GpuLoad, Metric::GpuTemp, Metric::Vram, Metric::DriveTemp];

    /// The settings' and the page's name.
    pub fn id(self) -> &'static str {
        match self {
            Metric::CpuLoad => "cpu",
            Metric::CpuTemp => "cpuTemp",
            Metric::Ram => "ram",
            Metric::GpuLoad => "gpu",
            Metric::GpuTemp => "gpuTemp",
            Metric::Vram => "vram",
            Metric::DriveTemp => "drive",
        }
    }

    pub fn parse(s: &str) -> Option<Metric> {
        Metric::ALL.iter().copied().find(|m| m.id() == s)
    }

    fn index(self) -> usize {
        Metric::ALL.iter().position(|m| *m == self).unwrap_or(0)
    }

    pub fn group(self) -> Group {
        match self {
            Metric::CpuLoad | Metric::CpuTemp => Group::Cpu,
            Metric::Ram => Group::Ram,
            Metric::GpuLoad | Metric::GpuTemp => Group::Gpu,
            Metric::Vram => Group::Vram,
            Metric::DriveTemp => Group::Drive,
        }
    }

    pub fn is_temp(self) -> bool {
        matches!(self, Metric::CpuTemp | Metric::GpuTemp | Metric::DriveTemp)
    }
}

/// What a strip cell is labelled with: one short word of our own strokes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Group {
    Cpu,
    Ram,
    Gpu,
    Vram,
    Drive,
}

impl Group {
    pub fn label(self) -> &'static str {
        match self {
            Group::Cpu => "CPU",
            Group::Ram => "RAM",
            Group::Gpu => "GPU",
            Group::Vram => "VRAM",
            Group::Drive => "SSD",
        }
    }
}

/// The values chosen, in the user's order: known ids only, each once; anything else dropped. At most the seven.
pub fn chosen(ids: &[String]) -> Vec<Metric> {
    let mut out: Vec<Metric> = Vec::new();
    for m in ids.iter().filter_map(|s| Metric::parse(s)) {
        if !out.contains(&m) {
            out.push(m);
        }
    }
    out
}

/// The full order the page lists (the user's first, then the rest in their natural order).
pub fn full_order(ids: &[String]) -> Vec<Metric> {
    let mut out = chosen(ids);
    for m in Metric::ALL {
        if !out.contains(&m) {
            out.push(m);
        }
    }
    out
}

// ---------------------------------------------------------------- the choices

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unit {
    C,
    F,
}

impl Unit {
    pub fn parse(s: &str) -> Option<Unit> {
        match s {
            "c" => Some(Unit::C),
            "f" => Some(Unit::F),
            _ => None,
        }
    }
}

/// What a left click on a system value does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClickTo {
    TaskManager,
    Tools,
    Nothing,
}

impl ClickTo {
    pub fn parse(s: &str) -> Option<ClickTo> {
        match s {
            "taskmgr" => Some(ClickTo::TaskManager),
            "tools" => Some(ClickTo::Tools),
            "nothing" => Some(ClickTo::Nothing),
            _ => None,
        }
    }
}

/// The sampling interval's choices, in seconds; anything else is the default (2 s).
pub const EVERY: [u64; 3] = [1, 2, 5];

pub fn every_s(v: u64) -> u64 {
    if EVERY.contains(&v) {
        v
    } else {
        2
    }
}

/// A pair of marks in °C: from `warm` a temperature is rose, from `hot` red.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Marks {
    pub warm: u8,
    pub hot: u8,
}

impl Marks {
    /// Bounded to lo–hi, and warm always under hot (hot pushed up, or warm down at the top).
    pub fn checked(warm: u64, hot: u64, lo: u8, hi: u8) -> Marks {
        let warm = warm.clamp(u64::from(lo), u64::from(hi)) as u8;
        let mut hot = hot.clamp(u64::from(lo), u64::from(hi)) as u8;
        if hot <= warm {
            hot = warm.saturating_add(5).min(hi);
        }
        if hot <= warm {
            return Marks { warm: hi.saturating_sub(5).max(lo), hot: hi };
        }
        Marks { warm, hot }
    }
}

/// The three marks' bounds and defaults: CPU and graphics 80 and 90 °C, the drive 65 and 75 °C.
pub const CHIP_RANGE: (u8, u8) = (50, 110);
pub const DRIVE_RANGE: (u8, u8) = (35, 90);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub cpu: Marks,
    pub gpu: Marks,
    pub drive: Marks,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits { cpu: Marks { warm: 80, hot: 90 }, gpu: Marks { warm: 80, hot: 90 }, drive: Marks { warm: 65, hot: 75 } }
    }
}

/// How warm a value is (loads and memory are never coloured).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Heat {
    Normal,
    Warm,
    Hot,
}

pub fn heat(m: Metric, celsius: f32, l: &Limits) -> Heat {
    let marks = match m {
        Metric::CpuTemp => l.cpu,
        Metric::GpuTemp => l.gpu,
        Metric::DriveTemp => l.drive,
        _ => return Heat::Normal,
    };
    // (Judged on the number shown, so the colour never disagrees with it: 79.6 shows «80» and is warm.)
    let c = celsius.round();
    if c >= f32::from(marks.hot) {
        Heat::Hot
    } else if c >= f32::from(marks.warm) {
        Heat::Warm
    } else {
        Heat::Normal
    }
}

/// The whole configuration the sampler and the pictures follow.
#[derive(Clone, Debug, PartialEq)]
pub struct Cfg {
    pub shown: Vec<Metric>,
    pub unit: Unit,
    pub limits: Limits,
    pub every_s: u64,
}

impl Default for Cfg {
    fn default() -> Cfg {
        Cfg { shown: Vec::new(), unit: Unit::C, limits: Limits::default(), every_s: 2 }
    }
}

// ---------------------------------------------------------------- one sample, and what it says

/// One round of figures: loads and memory in per cent (0–100), temperatures in °C; None when not known now.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Sample {
    pub v: [Option<f32>; 7],
}

impl Sample {
    pub fn get(&self, m: Metric) -> Option<f32> {
        self.v.get(m.index()).copied().flatten()
    }
    pub fn set(&mut self, m: Metric, x: Option<f32>) {
        if let Some(s) = self.v.get_mut(m.index()) {
            *s = x.filter(|v| v.is_finite());
        }
    }
}

pub fn c_to_f(c: f32) -> f32 {
    c * 9.0 / 5.0 + 32.0
}

/// A value as the taskbar writes it: «12%», «54°» (in the unit chosen; the unit itself is the setting's, said in the
/// hover text). Rounded to whole numbers; per cent kept within 0–100.
pub fn text(m: Metric, v: f32, unit: Unit) -> String {
    if m.is_temp() {
        let x = if unit == Unit::F { c_to_f(v) } else { v };
        format!("{}°", x.round().clamp(-99.0, 999.0) as i32)
    } else {
        format!("{}%", v.round().clamp(0.0, 100.0) as i32)
    }
}

/// One value shown.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shown {
    pub metric: Metric,
    pub text: String,
    pub heat: Heat,
}

/// The values to show now, in the user's order; one Windows did not give is left out (shown as nothing).
pub fn shown(s: &Sample, cfg: &Cfg) -> Vec<Shown> {
    cfg.shown.iter().filter_map(|&m| s.get(m).map(|v| Shown { metric: m, text: text(m, v, cfg.unit), heat: heat(m, v, &cfg.limits) })).collect()
}

/// Remembers what was last drawn: a new picture only when a shown number (or its colour) changed.
#[derive(Clone, Debug, Default)]
pub struct Watch {
    last: Option<Vec<Shown>>,
}

impl Watch {
    /// True (and remembered) when `now` differs from what was last drawn.
    pub fn changed(&mut self, now: &[Shown]) -> bool {
        if self.last.as_deref() == Some(now) {
            return false;
        }
        self.last = Some(now.to_vec());
        true
    }
    pub fn forget(&mut self) {
        self.last = None;
    }
}

/// When sampling rests: the display off or the session locked (nobody sees the taskbar), or nothing to show.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Gate {
    pub display_on: bool,
    pub locked: bool,
}

impl Default for Gate {
    fn default() -> Gate {
        Gate { display_on: true, locked: false }
    }
}

impl Gate {
    pub fn sampling(&self, cfg: &Cfg) -> bool {
        self.display_on && !self.locked && !cfg.shown.is_empty()
    }
    /// GUID_CONSOLE_DISPLAY_STATE's data: 0 off, 1 on, 2 dimmed (still seen: sampled).
    pub fn display(&mut self, state: u32) {
        self.display_on = state != 0;
    }
}

/// Which of Windows' sources a set of values needs (each is opened only when needed, and none at all for none).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Needs {
    pub cpu_times: bool,
    pub thermal: bool,
    pub memory: bool,
    pub gpu_engines: bool,
    pub gpu_temp: bool,
    pub gpu_memory: bool,
    pub drive: bool,
}

impl Needs {
    pub fn of(ms: &[Metric]) -> Needs {
        let has = |m| ms.contains(&m);
        Needs {
            cpu_times: has(Metric::CpuLoad),
            thermal: has(Metric::CpuTemp),
            memory: has(Metric::Ram),
            gpu_engines: has(Metric::GpuLoad),
            gpu_temp: has(Metric::GpuTemp),
            gpu_memory: has(Metric::Vram),
            drive: has(Metric::DriveTemp),
        }
    }
    pub fn any(&self) -> bool {
        self.cpu_times || self.thermal || self.memory || self.gpu_engines || self.gpu_temp || self.gpu_memory || self.drive
    }
    /// The graphics card has to be found (its adapter and LUID).
    pub fn gpu(&self) -> bool {
        self.gpu_engines || self.gpu_temp || self.gpu_memory
    }
    /// The performance counters' query has to be opened.
    pub fn pdh(&self) -> bool {
        self.thermal || self.gpu_engines || self.gpu_memory
    }
}

// ---------------------------------------------------------------- Windows' raw figures read

/// GetSystemTimes' three counters (100 ns units; «kernel» includes idle).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CpuTimes {
    pub idle: u64,
    pub kernel: u64,
    pub user: u64,
}

/// The processor's load between two readings, 0–100; None when no time passed or the counters went back.
pub fn cpu_load(a: CpuTimes, b: CpuTimes) -> Option<f32> {
    let idle = b.idle.checked_sub(a.idle)?;
    let total = b.kernel.checked_sub(a.kernel)?.checked_add(b.user.checked_sub(a.user)?)?;
    if total == 0 || idle > total {
        return None;
    }
    Some(((total - idle) as f64 * 100.0 / total as f64) as f32)
}

/// Memory in use from GlobalMemoryStatusEx's total and available bytes.
pub fn ram_pct(total: u64, avail: u64) -> Option<f32> {
    if total == 0 || avail > total {
        return None;
    }
    Some(((total - avail) as f64 * 100.0 / total as f64) as f32)
}

/// The «Thermal Zone Information» counter's values (kelvin): the warmest plausible zone, in °C. Values outside 200–400 K
/// (none, or a firmware's placeholder) are left out.
pub fn zones_c(kelvins: &[f64]) -> Option<f32> {
    kelvins.iter().copied().filter(|k| k.is_finite() && *k > 200.0 && *k < 400.0).fold(None, |m: Option<f64>, k| Some(m.map_or(k, |x| x.max(k)))).map(|k| (k - 273.15) as f32)
}

/// A graphics adapter's LUID as the counters' instance names carry it («luid_0x00000000_0x0000D1B4»).
pub fn luid_tag(high: i32, low: u32) -> String {
    format!("luid_0x{:08X}_0x{low:08X}", high as u32)
}

fn has_tag(name: &str, tag: &str) -> bool {
    !tag.is_empty() && name.to_ascii_lowercase().contains(&tag.to_ascii_lowercase())
}

/// The «GPU Engine(*)\Utilization Percentage» counter's rows (instance name, value) read for one adapter as Task
/// Manager does: each engine's use summed over the processes («pid_…_luid_…_phys_…_eng_…_engtype_…»), the busiest
/// engine's sum is the card's load (0–100). None when the adapter has no engine row.
pub fn gpu_load(rows: &[(String, f64)], tag: &str) -> Option<f32> {
    let mut engines: Vec<(String, f64)> = Vec::new();
    for (name, v) in rows {
        if !has_tag(name, tag) || !v.is_finite() || *v < 0.0 {
            continue;
        }
        let lower = name.to_ascii_lowercase();
        // (The engine is what follows the process id: from «luid_» on.)
        let Some(at) = lower.find("luid_") else { continue };
        let key = lower[at..].to_string();
        match engines.iter_mut().find(|(k, _)| *k == key) {
            Some((_, sum)) => *sum += v,
            None => engines.push((key, *v)),
        }
    }
    engines.iter().map(|(_, s)| *s).fold(None, |m: Option<f64>, s| Some(m.map_or(s, |x| x.max(s)))).map(|s| s.clamp(0.0, 100.0) as f32)
}

/// The «GPU Adapter Memory(*)\Dedicated Usage» rows (bytes) for one adapter, as a share of its dedicated memory.
pub fn vram_pct(rows: &[(String, f64)], tag: &str, total: u64) -> Option<f32> {
    if total == 0 {
        return None;
    }
    let mut used = 0.0f64;
    let mut any = false;
    for (name, v) in rows {
        if has_tag(name, tag) && v.is_finite() && *v >= 0.0 {
            used += v;
            any = true;
        }
    }
    any.then(|| (used * 100.0 / total as f64).clamp(0.0, 100.0) as f32)
}

/// What DXGI says of an adapter (the fields the choice needs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Adapter {
    pub vendor: u32,
    pub dedicated: u64,
    pub software: bool,
    pub luid_high: i32,
    pub luid_low: u32,
}

/// Microsoft's own (Basic Render Driver): never the card shown.
pub const VENDOR_MICROSOFT: u32 = 0x1414;
pub const VENDOR_NVIDIA: u32 = 0x10DE;

/// The card shown: a real one (not software, not Microsoft's basic one) with the most memory of its own — the
/// separate card on a laptop that has two; the first such when equal.
pub fn pick_adapter(list: &[Adapter]) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (i, a) in list.iter().enumerate() {
        if a.software || a.vendor == VENDOR_MICROSOFT {
            continue;
        }
        if best.and_then(|b| list.get(b)).map_or(true, |b| a.dedicated > b.dedicated) {
            best = Some(i);
        }
    }
    best
}

/// D3DKMT's adapter performance data: the temperature in tenths of a degree; 0 is «not reported».
pub fn kmt_c(deci: u32) -> Option<f32> {
    let c = deci as f32 / 10.0;
    (deci != 0 && c > 0.0 && c < 150.0).then_some(c)
}

/// A temperature from a vendor's own library, whole degrees: within reason, else none.
pub fn plain_c(c: u32) -> Option<f32> {
    (c > 0 && c < 150).then_some(c as f32)
}

/// STORAGE_TEMPERATURE_DATA_DESCRIPTOR as IOCTL_STORAGE_QUERY_PROPERTY hands it (little-endian): the warmest sensor's
/// temperature (°C). Length-checked at every step; sensors that say 0 or something past reason are left out.
pub fn drive_c(buf: &[u8]) -> Option<f32> {
    let u16_at = |i: usize| buf.get(i..i + 2).map(|b| u16::from_le_bytes([b[0], b[1]]));
    let i16_at = |i: usize| buf.get(i..i + 2).map(|b| i16::from_le_bytes([b[0], b[1]]));
    let size = buf.get(4..8).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)?;
    let count = usize::from(u16_at(12)?);
    let end = size.min(buf.len());
    let mut best: Option<i16> = None;
    for i in 0..count.min(64) {
        let at = 24 + i * 16;
        if at + 16 > end {
            break;
        }
        let t = i16_at(at + 2)?;
        if t > 0 && t < 150 {
            best = Some(best.map_or(t, |b| b.max(t)));
        }
    }
    best.map(f32::from)
}

/// VOLUME_DISK_EXTENTS as IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS hands it: the disk the volume starts on (its first
/// extent's disk number). Length-checked.
pub fn first_disk(buf: &[u8]) -> Option<u32> {
    let n = buf.get(0..4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))?;
    if n == 0 {
        return None;
    }
    // (The extents start at offset 8: a 4-byte count, then 8-aligned DISK_EXTENTs of 24 bytes, the disk number first.)
    buf.get(8..12).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

/// Where NVIDIA's own library may be loaded from, and only there: the system folder (where today's drivers put it),
/// then the driver's fixed folder on the system drive — never the current folder or PATH. `sys_dir` is
/// GetSystemDirectoryW's answer («C:\Windows\system32»).
pub fn nvml_paths(sys_dir: &str) -> Vec<String> {
    let dir = sys_dir.trim_end_matches('\\');
    let b = dir.as_bytes();
    if dir.is_empty() || b.len() < 3 || b[1] != b':' || b[2] != b'\\' || !b[0].is_ascii_alphabetic() {
        return Vec::new();
    }
    vec![format!("{dir}\\nvml.dll"), format!("{}\\Program Files\\NVIDIA Corporation\\NVSMI\\nvml.dll", &dir[..2])]
}

/// Task Manager's path: in the system folder, never looked for elsewhere.
pub fn taskmgr_path(sys_dir: &str) -> Option<String> {
    let dir = sys_dir.trim_end_matches('\\');
    let b = dir.as_bytes();
    (b.len() >= 3 && b[1] == b':' && b[2] == b'\\' && b[0].is_ascii_alphabetic()).then(|| format!("{dir}\\Taskmgr.exe"))
}

// ---------------------------------------------------------------- the pictures

/// Warm: rose (never orange or amber), readable on either taskbar.
pub fn rose(light: bool) -> Rgb {
    if light {
        Rgb(178, 42, 110)
    } else {
        Rgb(255, 138, 196)
    }
}

pub fn heat_rgb(h: Heat, light: bool) -> Rgb {
    match h {
        Heat::Normal => taskbar::fg(light),
        Heat::Warm => rose(light),
        Heat::Hot => taskbar::red(light),
    }
}

/// One cell on the strip: a label and its values side by side («CPU 12% 54°»).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SysCell {
    pub group: Group,
    pub parts: Vec<(String, Heat)>,
}

/// The values grouped into cells: a load and its temperature next to each other share their label; anything else
/// starts a cell of its own (so the user's order holds).
pub fn cells(values: &[Shown]) -> Vec<SysCell> {
    let mut out: Vec<SysCell> = Vec::new();
    for v in values {
        let g = v.metric.group();
        match out.last_mut() {
            Some(c) if c.group == g && c.parts.len() < 3 => c.parts.push((v.text.clone(), v.heat)),
            _ => out.push(SysCell { group: g, parts: vec![(v.text.clone(), v.heat)] }),
        }
    }
    out
}

/// How strong a label is beside its values.
const LABEL_ALPHA: f32 = 0.72;

/// The sizes a system cell is drawn at, for a strip `height` high cut from a taskbar `bar_h` high.
fn cell_metrics(bar_h: u32, stacked: bool) -> (f32, f32, f32) {
    let hb = bar_h.clamp(16, 400) as f32;
    // (Text as high as the devices' levels; the label a little smaller; a gap of the devices' own.)
    if stacked {
        ((hb * 0.25).round(), (hb * 0.2).round().max(6.0), (hb * 0.08).round().max(2.0))
    } else {
        ((hb * 0.30).round(), (hb * 0.24).round().max(7.0), (hb * 0.08).round().max(2.0))
    }
}

fn words_width(s: &str, h: f32) -> f32 {
    let mut probe = Canvas::new(1, 1);
    taskbar::draw_text(&mut probe, s, 0.0, 0.0, h, f32::MAX, taskbar::fg(false), 1.0)
}

/// A system cell's width.
pub fn cell_width(c: &SysCell, bar_h: u32, stacked: bool) -> f32 {
    let (th, lh, gap) = cell_metrics(bar_h, stacked);
    let label = words_width(c.group.label(), lh);
    let mut values = 0.0;
    for (i, (t, _)) in c.parts.iter().enumerate() {
        if i > 0 {
            values += gap * 2.0;
        }
        values += words_width(t, th);
    }
    if stacked {
        label.max(values).ceil()
    } else {
        (label + gap * 2.0 + values).ceil()
    }
}

/// A system cell drawn, `w × height`.
pub fn render_cell(c: &SysCell, w: f32, height: u32, bar_h: u32, look: StripLook) -> Canvas {
    let (th, lh, gap) = cell_metrics(bar_h, look.stacked);
    let mut cv = Canvas::new(w.ceil().max(1.0) as u32, height.max(1));
    let hh = height as f32;
    let line = taskbar::fg(look.light);
    let label = c.group.label();
    let lw = words_width(label, lh);
    let vw: f32 = c.parts.iter().enumerate().map(|(i, (t, _))| words_width(t, th) + if i > 0 { gap * 2.0 } else { 0.0 }).sum();
    let (lx, ly, mut vx, vy) = if look.stacked {
        let total = lh + th * 0.25 + th;
        let top = ((hh - total) / 2.0).max(0.0);
        (((w - lw) / 2.0).max(0.0), top, ((w - vw) / 2.0).max(0.0), top + lh + th * 0.25)
    } else {
        // (The label's foot on the values' foot.)
        (0.0, (hh - th) / 2.0 + (th - lh), lw + gap * 2.0, (hh - th) / 2.0)
    };
    taskbar::draw_text(&mut cv, label, lx, ly, lh, w, line, LABEL_ALPHA);
    for (i, (t, h)) in c.parts.iter().enumerate() {
        if i > 0 {
            vx += gap * 2.0;
        }
        vx += taskbar::draw_text(&mut cv, t, vx, vy, th, w, heat_rgb(*h, look.light), 1.0);
    }
    cv
}

/// What a strip cell is, for a click on it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hit {
    Device,
    System,
}

/// The whole strip: the devices and the system's cells (the system's before the devices, or after), a real gap between
/// every two; its cells' spans (left, right, what) for the clicks.
#[derive(Clone, Debug)]
pub struct Bar {
    pub canvas: Canvas,
    pub spans: Vec<(i32, i32, Hit)>,
}

pub fn render_bar(devices: &[StripItem], system: &[SysCell], system_first: bool, bar_h: u32, look: StripLook) -> Bar {
    let lay = taskbar::strip_layout(devices, bar_h, look);
    let hb = bar_h.clamp(16, 400) as f32;
    let pad = (hb * 0.12).round().max(3.0);
    let between = (hb * 0.2).round().max(6.0);
    let height = lay.height.max(1);
    // (Every cell's width, in the order drawn.)
    let mut order: Vec<(Hit, usize, f32)> = Vec::new();
    let dev: Vec<(Hit, usize, f32)> = lay.cells.iter().enumerate().map(|(i, c)| (Hit::Device, i, c.1)).collect();
    let sys: Vec<(Hit, usize, f32)> = system.iter().enumerate().map(|(i, c)| (Hit::System, i, cell_width(c, bar_h, look.stacked))).collect();
    if system_first {
        order.extend(sys);
        order.extend(dev);
    } else {
        order.extend(dev);
        order.extend(sys);
    }
    if order.is_empty() {
        return Bar { canvas: Canvas::new(1, 1), spans: Vec::new() };
    }
    let mut x = pad;
    let mut placed: Vec<(f32, f32, Hit, usize)> = Vec::new();
    for (k, (hit, i, w)) in order.iter().enumerate() {
        if k > 0 {
            x += between;
        }
        placed.push((x, *w, *hit, *i));
        x += w.ceil();
    }
    let width = (x + pad).ceil().max(1.0) as u32;
    let mut cv = Canvas::new(width, height);
    if look.plate {
        let back = if look.light { Rgb(248, 248, 250) } else { Rgb(32, 32, 36) };
        cv.round_rect(0.0, 0.0, width as f32, height as f32, height as f32 * 0.3, back, 0.86);
    }
    let mut spans = Vec::new();
    for (x, w, hit, i) in placed {
        let cell = match hit {
            Hit::Device => match devices.get(i) {
                Some(it) => taskbar::render_device_cell(it, w, height, &lay, bar_h, look),
                None => continue,
            },
            Hit::System => match system.get(i) {
                Some(c) => render_cell(c, w, height, bar_h, look),
                None => continue,
            },
        };
        taskbar::blit(&mut cv, &cell, x.round() as i64, 0);
        // (A click halfway into a gap counts for the nearer cell.)
        spans.push(((x - between / 2.0).floor() as i32, (x + w + between / 2.0).ceil() as i32, hit));
    }
    Bar { canvas: cv, spans }
}

/// The cell under a click at `x` (the strip's own pixels); None outside every cell.
pub fn hit(spans: &[(i32, i32, Hit)], x: i32) -> Option<Hit> {
    spans.iter().find(|(a, b, _)| x >= *a && x < *b).map(|s| s.2)
}

/// A tray icon for one value, `px` square: the number above (a temperature with its «°»), the label under it.
pub fn render_icon(v: &Shown, light: bool, px: u32) -> Canvas {
    let s = px.clamp(8, 256);
    let sf = s as f32;
    let mut cv = Canvas::new(s, s);
    let label = v.metric.group().label();
    // (The label takes a third of the height; at 16 px it would be unreadable small letters: there the number alone
    // fills the icon — without its «°», which would crowd two digits — and the hover text names it.)
    let small = s < 20;
    let number = if small { v.text.trim_end_matches(['%', '°']) } else { v.text.trim_end_matches('%') };
    let lh = if small { 0.0 } else { (sf * 0.32).round() };
    let gap = if small { 0.0 } else { (sf / 16.0).round().max(1.0) };
    let th = sf - lh - gap;
    let colour = heat_rgb(v.heat, light);
    let tw = words_width(number, th).min(sf);
    taskbar::draw_text(&mut cv, number, ((sf - tw) / 2.0).max(0.0), 0.0, th, sf, colour, 1.0);
    if !small {
        let lw = words_width(label, lh).min(sf);
        taskbar::draw_text(&mut cv, label, ((sf - lw) / 2.0).max(0.0), sf - lh, lh, sf, taskbar::fg(light), LABEL_ALPHA + 0.1);
    }
    cv
}

/// A value's hover text from the page's words for it (its «{value}» filled; the unit said after a temperature).
pub fn tip(words: &str, v: &Shown, unit: Unit) -> String {
    let mut value = v.text.clone();
    if v.metric.is_temp() {
        value.push(if unit == Unit::F { 'F' } else { 'C' });
    }
    crate::summary::clip_utf16(&words.replace("{value}", &value), crate::summary::TIP_MAX_UTF16)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::taskbar::{face, Glyph, StripItem};

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn ids_choice_and_order() {
        for m in Metric::ALL {
            assert_eq!(Metric::parse(m.id()), Some(m));
        }
        assert_eq!(chosen(&s(&["ram", "x", "cpu", "ram"])), vec![Metric::Ram, Metric::CpuLoad], "unknown dropped, each once, order kept");
        assert_eq!(chosen(&[]), vec![], "nothing by default");
        let f = full_order(&s(&["drive", "cpu"]));
        assert_eq!(f.len(), 7);
        assert_eq!(&f[..3], &[Metric::DriveTemp, Metric::CpuLoad, Metric::CpuTemp]);
        assert_eq!(Unit::parse("f"), Some(Unit::F));
        assert_eq!(ClickTo::parse("taskmgr"), Some(ClickTo::TaskManager));
        assert_eq!(ClickTo::parse("cmd"), None);
        assert_eq!((every_s(1), every_s(5), every_s(3), every_s(0)), (1, 5, 2, 2));
    }

    #[test]
    fn marks_bounded_and_ordered() {
        assert_eq!(Marks::checked(80, 90, 50, 110), Marks { warm: 80, hot: 90 });
        assert_eq!(Marks::checked(95, 90, 50, 110), Marks { warm: 95, hot: 100 }, "hot pushed above warm");
        assert_eq!(Marks::checked(200, 300, 50, 110), Marks { warm: 105, hot: 110 }, "both at the top: warm stays under");
        assert_eq!(Marks::checked(0, 0, 35, 90), Marks { warm: 35, hot: 40 });
    }

    #[test]
    fn heat_by_marks_temperatures_only() {
        let l = Limits::default();
        assert_eq!(heat(Metric::CpuTemp, 54.0, &l), Heat::Normal);
        assert_eq!(heat(Metric::CpuTemp, 79.6, &l), Heat::Warm, "judged on the number shown (80)");
        assert_eq!(heat(Metric::GpuTemp, 90.0, &l), Heat::Hot);
        assert_eq!(heat(Metric::DriveTemp, 66.0, &l), Heat::Warm);
        assert_eq!(heat(Metric::DriveTemp, 75.0, &l), Heat::Hot);
        assert_eq!(heat(Metric::CpuLoad, 100.0, &l), Heat::Normal, "a load is never coloured");
        let own = Limits { cpu: Marks { warm: 60, hot: 70 }, ..l };
        assert_eq!(heat(Metric::CpuTemp, 65.0, &own), Heat::Warm);
    }

    #[test]
    fn texts_and_units() {
        assert_eq!(text(Metric::CpuLoad, 12.4, Unit::C), "12%");
        assert_eq!(text(Metric::Ram, 100.7, Unit::F), "100%", "per cent kept within 100; no unit");
        assert_eq!(text(Metric::CpuTemp, 54.4, Unit::C), "54°");
        assert_eq!(text(Metric::CpuTemp, 54.4, Unit::F), "130°");
        assert_eq!(c_to_f(100.0), 212.0);
        assert_eq!(text(Metric::DriveTemp, -0.4, Unit::C), "0°");
    }

    fn sample(pairs: &[(Metric, f32)]) -> Sample {
        let mut s = Sample::default();
        for (m, v) in pairs {
            s.set(*m, Some(*v));
        }
        s
    }

    #[test]
    fn shown_in_order_absent_left_out() {
        let cfg = Cfg { shown: vec![Metric::Ram, Metric::CpuLoad, Metric::CpuTemp, Metric::GpuTemp], ..Cfg::default() };
        let smp = sample(&[(Metric::CpuLoad, 12.0), (Metric::Ram, 61.2), (Metric::GpuTemp, 91.0), (Metric::Vram, 6.0)]);
        let v = shown(&smp, &cfg);
        assert_eq!(v.iter().map(|x| x.text.as_str()).collect::<Vec<_>>(), vec!["61%", "12%", "91°"], "no CPU temperature from Windows: nothing for it; VRAM not chosen");
        assert_eq!(v[2].heat, Heat::Hot);
        let mut nan = Sample::default();
        nan.set(Metric::Ram, Some(f32::NAN));
        assert_eq!(nan.get(Metric::Ram), None);
    }

    #[test]
    fn redrawn_only_when_a_number_changes() {
        let cfg = Cfg { shown: vec![Metric::CpuLoad, Metric::CpuTemp], ..Cfg::default() };
        let mut w = Watch::default();
        assert!(w.changed(&shown(&sample(&[(Metric::CpuLoad, 12.2), (Metric::CpuTemp, 54.0)]), &cfg)));
        assert!(!w.changed(&shown(&sample(&[(Metric::CpuLoad, 11.8), (Metric::CpuTemp, 54.3)]), &cfg)), "the same numbers once rounded");
        assert!(w.changed(&shown(&sample(&[(Metric::CpuLoad, 13.0), (Metric::CpuTemp, 54.3)]), &cfg)));
        assert!(w.changed(&shown(&sample(&[(Metric::CpuLoad, 13.0)]), &cfg)), "a value gone is a change");
        w.forget();
        assert!(w.changed(&shown(&sample(&[(Metric::CpuLoad, 13.0)]), &cfg)), "forgotten: drawn again");
    }

    #[test]
    fn gate_and_needs() {
        let none = Cfg::default();
        let some = Cfg { shown: vec![Metric::Ram], ..Cfg::default() };
        let mut g = Gate::default();
        assert!(!g.sampling(&none), "nothing shown: no sampling at all");
        assert!(g.sampling(&some));
        g.display(0);
        assert!(!g.sampling(&some), "display off");
        g.display(2);
        assert!(g.sampling(&some), "dimmed is still seen");
        g.locked = true;
        assert!(!g.sampling(&some), "locked");
        assert!(!Needs::of(&[]).any());
        let n = Needs::of(&[Metric::Ram, Metric::GpuTemp]);
        assert!(n.memory && n.gpu_temp && n.gpu() && !n.pdh() && !n.cpu_times && !n.drive);
        assert!(Needs::of(&[Metric::CpuTemp]).pdh() && !Needs::of(&[Metric::CpuTemp]).gpu());
    }

    #[test]
    fn processor_times() {
        let a = CpuTimes { idle: 1_000, kernel: 3_000, user: 1_000 };
        let b = CpuTimes { idle: 1_750, kernel: 4_000, user: 1_000 };
        assert_eq!(cpu_load(a, b), Some(25.0), "1000 passed, 750 of it idle");
        assert_eq!(cpu_load(a, a), None, "no time passed");
        assert_eq!(cpu_load(b, a), None, "counters went back");
        assert_eq!(cpu_load(a, CpuTimes { idle: 9_000, kernel: 3_500, user: 1_000 }), None, "idle beyond the total is nonsense");
        assert_eq!(ram_pct(16, 4), Some(75.0));
        assert_eq!(ram_pct(0, 0), None);
        assert_eq!(ram_pct(4, 8), None);
    }

    #[test]
    fn thermal_zones_in_kelvin() {
        let c = zones_c(&[300.15, 327.15, 0.0, 9999.0, f64::NAN]).unwrap();
        assert!((c - 54.0).abs() < 0.01, "{c}");
        assert_eq!(zones_c(&[]), None);
        assert_eq!(zones_c(&[0.0]), None, "no plausible zone: absent");
    }

    #[test]
    fn graphics_counters() {
        let tag = luid_tag(0, 0xD1B4);
        assert_eq!(tag, "luid_0x00000000_0x0000D1B4");
        assert_eq!(luid_tag(-1, 1), "luid_0xFFFFFFFF_0x00000001");
        let rows = vec![
            (format!("pid_100_{tag}_phys_0_eng_0_engtype_3D"), 20.0),
            (format!("pid_200_{tag}_phys_0_eng_0_engtype_3D"), 15.0),
            (format!("pid_100_{tag}_phys_0_eng_3_engtype_VideoDecode"), 30.0),
            ("pid_300_luid_0x00000000_0x0000AAAA_phys_0_eng_0_engtype_3D".to_string(), 90.0),
            (format!("pid_400_{}_phys_0_eng_0_engtype_3D", tag.to_lowercase()), 1.0),
        ];
        assert_eq!(gpu_load(&rows, &tag), Some(36.0), "3D summed over processes (any letter case), the busiest engine; another card left out");
        assert_eq!(gpu_load(&rows, "luid_0x00000000_0x0000BBBB"), None);
        assert_eq!(gpu_load(&[(format!("pid_1_{tag}_eng_0"), 180.0)], &tag), Some(100.0), "never past 100");
        let mem = vec![(format!("{tag}_phys_0"), 512.0 * 1024.0 * 1024.0), ("luid_0x00000000_0x0000AAAA_phys_0".to_string(), 4e9)];
        assert_eq!(vram_pct(&mem, &tag, 8 * 1024 * 1024 * 1024), Some(6.25));
        assert_eq!(vram_pct(&mem, &tag, 0), None);
        assert_eq!(vram_pct(&[], &tag, 100), None);
    }

    #[test]
    fn the_card_chosen() {
        let a = |vendor, dedicated, software| Adapter { vendor, dedicated, software, luid_high: 0, luid_low: 1 };
        assert_eq!(pick_adapter(&[a(0x8086, 128 << 20, false), a(VENDOR_NVIDIA, 8 << 30, false), a(VENDOR_MICROSOFT, 0, true)]), Some(1), "the separate card");
        assert_eq!(pick_adapter(&[a(VENDOR_MICROSOFT, 1 << 30, false), a(0x1002, 0, true)]), None, "no real card");
        assert_eq!(pick_adapter(&[a(0x8086, 0, false)]), Some(0), "a built-in one with no memory of its own still counts");
        assert_eq!(pick_adapter(&[]), None);
        assert_eq!(kmt_c(445), Some(44.5));
        assert_eq!(kmt_c(0), None, "0: not reported");
        assert_eq!(kmt_c(5000), None);
        assert_eq!(plain_c(44), Some(44.0));
        assert_eq!(plain_c(0), None);
    }

    fn descriptor(temps: &[i16], size_cut: Option<u32>) -> Vec<u8> {
        let mut b = vec![0u8; 24 + temps.len() * 16];
        let size = size_cut.unwrap_or(b.len() as u32);
        let n = b.len() as u32;
        b[0..4].copy_from_slice(&n.to_le_bytes());
        b[4..8].copy_from_slice(&size.to_le_bytes());
        b[8..10].copy_from_slice(&85i16.to_le_bytes());
        b[12..14].copy_from_slice(&(temps.len() as u16).to_le_bytes());
        for (i, t) in temps.iter().enumerate() {
            let at = 24 + i * 16;
            b[at..at + 2].copy_from_slice(&(i as u16).to_le_bytes());
            b[at + 2..at + 4].copy_from_slice(&t.to_le_bytes());
        }
        b
    }

    #[test]
    fn a_drive_descriptor_read_with_care() {
        assert_eq!(drive_c(&descriptor(&[38, 41], None)), Some(41.0));
        assert_eq!(drive_c(&descriptor(&[0, 300], None)), None, "0 and the impossible left out");
        assert_eq!(drive_c(&descriptor(&[38, 41], Some(24 + 16))), Some(38.0), "only what the size says");
        let mut short = descriptor(&[38, 41], None);
        short.truncate(30);
        assert_eq!(drive_c(&short), None, "cut short: nothing read past the end");
        assert_eq!(drive_c(&[]), None);
        let mut lie = descriptor(&[40], None);
        lie[12..14].copy_from_slice(&5000u16.to_le_bytes());
        assert_eq!(drive_c(&lie), Some(40.0), "a count past the buffer stops at its end");
    }

    #[test]
    fn disks_and_fixed_paths() {
        let mut b = vec![0u8; 32];
        b[0..4].copy_from_slice(&1u32.to_le_bytes());
        b[8..12].copy_from_slice(&2u32.to_le_bytes());
        assert_eq!(first_disk(&b), Some(2));
        assert_eq!(first_disk(&b[..10]), None, "cut short");
        assert_eq!(first_disk(&[0u8; 32]), None, "no extent");
        assert_eq!(nvml_paths("C:\\Windows\\system32"), vec!["C:\\Windows\\system32\\nvml.dll".to_string(), "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvml.dll".to_string()]);
        assert!(nvml_paths("").is_empty() && nvml_paths("system32").is_empty() && nvml_paths("\\\\server\\x").is_empty(), "only a full path on a drive");
        assert_eq!(taskmgr_path("D:\\Win\\System32\\").as_deref(), Some("D:\\Win\\System32\\Taskmgr.exe"));
        assert_eq!(taskmgr_path("Taskmgr"), None);
    }

    fn sh(m: Metric, t: &str, h: Heat) -> Shown {
        Shown { metric: m, text: t.into(), heat: h }
    }

    #[test]
    fn cells_group_a_load_with_its_temperature() {
        let v = vec![sh(Metric::CpuLoad, "12%", Heat::Normal), sh(Metric::CpuTemp, "54°", Heat::Normal), sh(Metric::Ram, "61%", Heat::Normal), sh(Metric::GpuLoad, "4%", Heat::Normal), sh(Metric::GpuTemp, "44°", Heat::Normal), sh(Metric::Vram, "6%", Heat::Normal), sh(Metric::DriveTemp, "38°", Heat::Normal)];
        let c = cells(&v);
        assert_eq!(c.iter().map(|x| x.group.label()).collect::<Vec<_>>(), vec!["CPU", "RAM", "GPU", "VRAM", "SSD"]);
        assert_eq!(c[0].parts.len(), 2);
        let apart = cells(&[sh(Metric::CpuLoad, "1%", Heat::Normal), sh(Metric::Ram, "2%", Heat::Normal), sh(Metric::CpuTemp, "3°", Heat::Normal)]);
        assert_eq!(apart.len(), 3, "the user's order holds: CPU, RAM, CPU");
    }

    fn ink(cv: &Canvas) -> usize {
        cv.px.chunks_exact(4).filter(|p| p[3] > 128).count()
    }

    fn look(stacked: bool) -> StripLook {
        StripLook { light: false, stacked, plate: false }
    }

    #[test]
    fn the_strip_with_system_cells() {
        let dev = vec![StripItem { glyph: Glyph::Mouse, face: face(None, false, true, 20), caption: None }];
        let sys = cells(&[sh(Metric::CpuLoad, "12%", Heat::Normal), sh(Metric::CpuTemp, "84°", Heat::Warm), sh(Metric::DriveTemp, "76°", Heat::Hot)]);
        for stacked in [false, true] {
            for first in [true, false] {
                let bar = render_bar(&dev, &sys, first, 48, look(stacked));
                assert_eq!(bar.spans.len(), 3);
                assert_eq!(bar.spans[0].2, if first { Hit::System } else { Hit::Device });
                assert!(bar.canvas.h <= 48 && ink(&bar.canvas) > 100);
                for w in bar.spans.windows(2) {
                    assert!(w[1].0 >= w[0].0 && w[0].1 <= w[1].1, "spans in order: {:?}", bar.spans);
                }
            }
        }
        let alone = render_bar(&[], &sys, true, 40, look(false));
        assert_eq!(alone.spans.len(), 2, "system cells alone make a strip");
        let nothing = render_bar(&[], &[], true, 40, look(false));
        assert!(nothing.spans.is_empty() && nothing.canvas.w == 1);
        let same = render_bar(&dev, &[], true, 48, look(false));
        let old = taskbar::render_strip(&dev, 48, look(false));
        assert_eq!((same.canvas.w, same.canvas.h, &same.canvas.px), (old.w, old.h, &old.px), "devices alone: exactly W1's strip");
    }

    #[test]
    fn colours_rose_and_red_never_orange() {
        for light in [false, true] {
            let sys = cells(&[sh(Metric::CpuTemp, "84°", Heat::Warm), sh(Metric::GpuTemp, "95°", Heat::Hot)]);
            let bar = render_bar(&[], &sys, true, 40, StripLook { light, stacked: false, plate: true });
            let px: Vec<Rgb> = bar.canvas.px.chunks_exact(4).filter(|p| p[3] > 220).map(|p| Rgb(p[0], p[1], p[2])).collect();
            assert!(px.contains(&rose(light)), "rose for warm");
            assert!(px.contains(&taskbar::red(light)), "red for hot");
            for p in bar.canvas.px.chunks_exact(4).filter(|p| p[3] > 40) {
                let (r, g, b) = (i32::from(p[0]), i32::from(p[1]), i32::from(p[2]));
                assert!(!(r > 180 && g > 100 && b < 90 && r - b > 120), "no yellow, amber or orange: {p:?}");
            }
            assert_ne!(rose(light), taskbar::red(light));
        }
    }

    #[test]
    fn clicks_find_their_cell() {
        let spans = vec![(0, 40, Hit::System), (40, 90, Hit::Device)];
        assert_eq!(hit(&spans, 10), Some(Hit::System));
        assert_eq!(hit(&spans, 40), Some(Hit::Device));
        assert_eq!(hit(&spans, 95), None);
        assert_eq!(hit(&[], 0), None);
    }

    #[test]
    fn tray_icons_at_every_size() {
        for px in [16, 20, 24, 32, 48] {
            for v in [sh(Metric::CpuLoad, "100%", Heat::Normal), sh(Metric::GpuTemp, "95°", Heat::Hot), sh(Metric::DriveTemp, "38°", Heat::Normal), sh(Metric::CpuTemp, "212°", Heat::Warm)] {
                let cv = render_icon(&v, false, px);
                assert_eq!((cv.w, cv.h), (px, px));
                assert!(ink(&cv) > 10, "{px} {v:?}");
            }
        }
        let hot = render_icon(&sh(Metric::GpuTemp, "95°", Heat::Hot), true, 32);
        assert!(hot.px.chunks_exact(4).any(|p| p[3] > 220 && Rgb(p[0], p[1], p[2]) == taskbar::red(true)));
        let t = tip("GPU temperature: {value}", &sh(Metric::GpuTemp, "95°", Heat::Hot), Unit::F);
        assert_eq!(t, "GPU temperature: 95°F");
        assert_eq!(tip("RAM: {value}", &sh(Metric::Ram, "61%", Heat::Normal), Unit::C), "RAM: 61%");
        assert!(tip(&"x".repeat(400), &sh(Metric::Ram, "1%", Heat::Normal), Unit::C).encode_utf16().count() <= 127);
    }

    #[test]
    fn the_letters_are_drawn() {
        for word in ["CPU", "RAM", "GPU", "VRAM", "SSD", "54°"] {
            let mut cv = Canvas::new(80, 20);
            let w = taskbar::draw_text(&mut cv, word, 0.0, 0.0, 14.0, 80.0, taskbar::fg(false), 1.0);
            assert!(w > 0.0 && ink(&cv) > 20, "{word}");
        }
    }
}
