// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the optional strip on Windows' taskbar — «[drawing] 64%» per device,
// beside the notification area — and the small facts the tray needs from Windows (the taskbar's light or dark colour,
// the screen's DPI for the icons' size, the local time for the quiet hours).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/widget.cpp (Create, Reposition, the layered child window of Shell_TrayWnd placed left of TrayNotifyWnd, made
// again when Explorer restarts — the TaskbarCreated message) and src/main.cpp (IsLightTaskbar: SystemUsesLightTheme)
// at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later.
// Changed here: the pictures come from ../taskbar.rs (our own drawings, no font); only the main taskbar (the
// original's copies on other monitors and its Windows 11 Widgets-button checks need UI Automation, which it had to run
// on a thread of its own to keep Explorer from hanging — not ported); its place is checked every 2 s on its own thread
// (the original: every second, on its UI thread); when it cannot be a child of the taskbar it falls back to a small
// always-on-top window over the same place; when no horizontal taskbar is found it hides itself and says so
// (`alive()` false), and the shell keeps the tray icons. OFF by default (the «Taskbar» card's switch); every Windows
// call's failure is a quiet «not shown», never a stop of the program (nothing here panics: no unwrap, no indexing).
// UNVERIFIED here: compiled only on Windows (type-checked elsewhere, stdroots/wincheck.rs); never run on a real taskbar.
// Piece S1: the system's values (../sysmon.rs's cells: «CPU 12% 54°» …) drawn beside the devices, before or after them;
// a click says which kind of cell it fell on (sysmon::hit over the spans of the last picture).
// Copyright (C) 2026 Kurokawa contributors.
#![allow(non_snake_case, non_camel_case_types, clippy::upper_case_acronyms)]
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

use crate::sysmon::{self, Hit, SysCell};
use crate::taskbar::{self, Rect, StripItem, StripLook};

type HWND = isize;
type HDC = isize;
type HGDIOBJ = isize;
type BOOL = i32;
type WNDPROC = unsafe extern "system" fn(HWND, u32, usize, isize) -> isize;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct POINT {
    x: i32,
    y: i32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct SIZE {
    cx: i32,
    cy: i32,
}

#[repr(C)]
#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct RECT {
    l: i32,
    t: i32,
    r: i32,
    b: i32,
}

#[repr(C)]
struct MSG {
    hwnd: HWND,
    message: u32,
    wParam: usize,
    lParam: isize,
    time: u32,
    pt: POINT,
    lPrivate: u32,
}

#[repr(C)]
struct WNDCLASSEXW {
    cbSize: u32,
    style: u32,
    lpfnWndProc: Option<WNDPROC>,
    cbClsExtra: i32,
    cbWndExtra: i32,
    hInstance: isize,
    hIcon: isize,
    hCursor: isize,
    hbrBackground: isize,
    lpszMenuName: *const u16,
    lpszClassName: *const u16,
    hIconSm: isize,
}

#[repr(C)]
struct BLENDFUNCTION {
    BlendOp: u8,
    BlendFlags: u8,
    SourceConstantAlpha: u8,
    AlphaFormat: u8,
}

#[repr(C)]
struct BITMAPINFOHEADER {
    biSize: u32,
    biWidth: i32,
    biHeight: i32,
    biPlanes: u16,
    biBitCount: u16,
    biCompression: u32,
    biSizeImage: u32,
    biXPelsPerMeter: i32,
    biYPelsPerMeter: i32,
    biClrUsed: u32,
    biClrImportant: u32,
}

#[repr(C)]
struct BITMAPINFO {
    bmiHeader: BITMAPINFOHEADER,
    bmiColors: [u32; 1],
}

#[repr(C)]
#[derive(Default)]
struct SYSTEMTIME {
    wYear: u16,
    wMonth: u16,
    wDayOfWeek: u16,
    wDay: u16,
    wHour: u16,
    wMinute: u16,
    wSecond: u16,
    wMilliseconds: u16,
}

#[cfg_attr(windows, link(name = "user32", kind = "raw-dylib"))]
extern "system" {
    fn RegisterClassExW(c: *const WNDCLASSEXW) -> u16;
    fn CreateWindowExW(ex: u32, class: *const u16, name: *const u16, style: u32, x: i32, y: i32, w: i32, h: i32, parent: HWND, menu: isize, inst: isize, param: *const c_void) -> HWND;
    fn DestroyWindow(h: HWND) -> BOOL;
    fn DefWindowProcW(h: HWND, m: u32, w: usize, l: isize) -> isize;
    fn GetMessageW(msg: *mut MSG, h: HWND, min: u32, max: u32) -> BOOL;
    fn PeekMessageW(msg: *mut MSG, h: HWND, min: u32, max: u32, remove: u32) -> BOOL;
    fn TranslateMessage(msg: *const MSG) -> BOOL;
    fn DispatchMessageW(msg: *const MSG) -> isize;
    fn PostThreadMessageW(thread: u32, m: u32, w: usize, l: isize) -> BOOL;
    fn FindWindowW(class: *const u16, name: *const u16) -> HWND;
    fn FindWindowExW(parent: HWND, after: HWND, class: *const u16, name: *const u16) -> HWND;
    fn GetWindowRect(h: HWND, r: *mut RECT) -> BOOL;
    fn SetWindowPos(h: HWND, after: HWND, x: i32, y: i32, w: i32, h2: i32, flags: u32) -> BOOL;
    fn ShowWindow(h: HWND, cmd: i32) -> BOOL;
    fn IsWindow(h: HWND) -> BOOL;
    fn IsWindowVisible(h: HWND) -> BOOL;
    fn UpdateLayeredWindow(h: HWND, dst: HDC, ppt: *const POINT, psize: *const SIZE, src: HDC, pptsrc: *const POINT, key: u32, blend: *const BLENDFUNCTION, flags: u32) -> BOOL;
    fn SetTimer(h: HWND, id: usize, ms: u32, f: *const c_void) -> usize;
    fn KillTimer(h: HWND, id: usize) -> BOOL;
    fn GetDC(h: HWND) -> HDC;
    fn ReleaseDC(h: HWND, dc: HDC) -> i32;
    fn RegisterWindowMessageW(s: *const u16) -> u32;
    fn GetDpiForSystem() -> u32;
}

#[cfg_attr(windows, link(name = "gdi32", kind = "raw-dylib"))]
extern "system" {
    fn CreateCompatibleDC(dc: HDC) -> HDC;
    fn CreateDIBSection(dc: HDC, bmi: *const BITMAPINFO, usage: u32, bits: *mut *mut c_void, section: isize, offset: u32) -> HGDIOBJ;
    fn SelectObject(dc: HDC, o: HGDIOBJ) -> HGDIOBJ;
    fn DeleteObject(o: HGDIOBJ) -> BOOL;
    fn DeleteDC(dc: HDC) -> BOOL;
}

#[cfg_attr(windows, link(name = "kernel32", kind = "raw-dylib"))]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> isize;
    fn GetLocalTime(t: *mut SYSTEMTIME);
    fn GetCurrentThreadId() -> u32;
}

#[cfg_attr(windows, link(name = "advapi32", kind = "raw-dylib"))]
extern "system" {
    fn RegGetValueW(key: isize, sub: *const u16, value: *const u16, flags: u32, ty: *mut u32, data: *mut c_void, len: *mut u32) -> i32;
}

const WS_CHILD: u32 = 0x4000_0000;
const WS_POPUP: u32 = 0x8000_0000;
const WS_CLIPSIBLINGS: u32 = 0x0400_0000;
const WS_EX_LAYERED: u32 = 0x0008_0000;
const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
const WS_EX_TOPMOST: u32 = 0x0000_0008;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_SHOWWINDOW: u32 = 0x0040;
const HWND_TOP: HWND = 0;
const HWND_TOPMOST: HWND = -1;
const SW_HIDE: i32 = 0;
const WM_DESTROY: u32 = 0x0002;
const WM_MOUSEACTIVATE: u32 = 0x0021;
const WM_TIMER: u32 = 0x0113;
const WM_LBUTTONUP: u32 = 0x0202;
const WM_RBUTTONUP: u32 = 0x0205;
const WM_SETTINGCHANGE: u32 = 0x001A;
const WM_APP_CMD: u32 = 0x8000 + 41;
const MA_NOACTIVATE: isize = 3;
const PM_NOREMOVE: u32 = 0;
const ULW_ALPHA: u32 = 2;
const AC_SRC_OVER: u8 = 0;
const AC_SRC_ALPHA: u8 = 1;
const DIB_RGB_COLORS: u32 = 0;
const HKEY_CURRENT_USER: isize = 0x8000_0001u32 as i32 as isize;
const RRF_RT_REG_DWORD: u32 = 0x0000_0010;
const TIMER_ID: usize = 1;
/// How often the strip's place is checked (the taskbar may move, grow or restart).
pub const CHECK_MS: u32 = 2_000;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Whether Windows' taskbar is light (SystemUsesLightTheme = 1); dark when it cannot be read (Windows' default).
pub fn light_taskbar() -> bool {
    let key = wide(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
    let name = wide("SystemUsesLightTheme");
    let mut v: u32 = 0;
    let mut len: u32 = 4;
    // SAFETY: NUL-ended strings that outlive the call; `v` holds the 4 bytes asked for.
    let rc = unsafe { RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), RRF_RT_REG_DWORD, std::ptr::null_mut(), (&mut v as *mut u32).cast(), &mut len) };
    rc == 0 && v == 1
}

/// The screen's DPI (96 when it cannot be had): the tray icons are drawn at taskbar::icon_px of it.
pub fn system_dpi() -> u32 {
    // SAFETY: no arguments; Windows 10 1607 or later (as Tools needs).
    let d = unsafe { GetDpiForSystem() };
    if d == 0 {
        96
    } else {
        d
    }
}

/// The local time's minute of the day (0–1439), for the quiet hours.
pub fn local_minute() -> u16 {
    let mut t = SYSTEMTIME::default();
    // SAFETY: `t` is a SYSTEMTIME the call fills.
    unsafe { GetLocalTime(&mut t) };
    (t.wHour.min(23) * 60 + t.wMinute.min(59)) as u16
}

// ---------------------------------------------------------------- the strip's window, on its own thread

enum Cmd {
    Show(Vec<StripItem>, Vec<SysCell>, bool, StripLook),
    Stop,
}

/// What a click on the strip says: true for the left button, false for the right; and whether it fell on a system
/// value (piece S1) rather than a device.
pub type OnClick = Box<dyn Fn(bool, bool) + Send + Sync>;
/// Told (on a thread of its own) when the strip comes onto the taskbar or leaves it: the shell then shows or hides the
/// tray's device icons.
pub type OnChange = Box<dyn Fn() + Send + Sync>;

static CLICK: Mutex<Option<Arc<OnClick>>> = Mutex::new(None);
/// The last picture's cells (left, right, what), in the strip's own pixels: what a click fell on.
static SPANS: Mutex<Vec<(i32, i32, Hit)>> = Mutex::new(Vec::new());

/// The running strip. Dropping it (or `stop`) takes it away.
pub struct Strip {
    tx: Sender<Cmd>,
    thread_id: Arc<AtomicU32>,
    alive: Arc<AtomicBool>,
}

impl Strip {
    /// Starts the strip's thread. None when the thread cannot be made.
    pub fn start(on_click: OnClick, on_change: OnChange) -> Option<Strip> {
        if let Ok(mut g) = CLICK.lock() {
            *g = Some(Arc::new(on_click));
        }
        let (tx, rx) = channel::<Cmd>();
        let thread_id = Arc::new(AtomicU32::new(0));
        let alive = Arc::new(AtomicBool::new(false));
        let (t2, a2) = (thread_id.clone(), alive.clone());
        let ch = Arc::new(on_change);
        std::thread::Builder::new().name("kt-battery-strip".into()).spawn(move || run(rx, t2, a2, ch)).ok()?;
        Some(Strip { tx, thread_id, alive })
    }

    /// The devices to show and how (drawn on the strip's thread).
    pub fn show(&self, items: Vec<StripItem>, look: StripLook) {
        self.show_all(items, Vec::new(), false, look);
    }

    /// The devices and the system's values (before the devices when `system_first`), and how.
    pub fn show_all(&self, items: Vec<StripItem>, system: Vec<SysCell>, system_first: bool, look: StripLook) {
        let _ = self.tx.send(Cmd::Show(items, system, system_first, look));
        self.wake();
    }

    /// Whether the strip is on the taskbar now (false: no horizontal taskbar found, or a window could not be made — the
    /// shell then keeps the tray icons).
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub fn stop(&self) {
        let _ = self.tx.send(Cmd::Stop);
        self.wake();
    }

    fn wake(&self) {
        let id = self.thread_id.load(Ordering::SeqCst);
        if id != 0 {
            // SAFETY: a thread id; a message to a thread that has gone is simply refused.
            unsafe { PostThreadMessageW(id, WM_APP_CMD, 0, 0) };
        }
    }
}

impl Drop for Strip {
    fn drop(&mut self) {
        self.stop();
        if let Ok(mut g) = CLICK.lock() {
            *g = None;
        }
    }
}

unsafe extern "system" fn wndproc(h: HWND, m: u32, w: usize, l: isize) -> isize {
    match m {
        WM_MOUSEACTIVATE => MA_NOACTIVATE,
        WM_LBUTTONUP | WM_RBUTTONUP => {
            let f = CLICK.lock().ok().and_then(|g| g.clone());
            if let Some(f) = f {
                // (The client x in lParam's low word, signed; the cell under it.)
                let x = i32::from((l & 0xFFFF) as u16 as i16);
                let system = SPANS.lock().ok().and_then(|g| sysmon::hit(&g, x)) == Some(Hit::System);
                // (On its own thread: the shell's work never holds this window — or Explorer, its parent — waiting.)
                let left = m == WM_LBUTTONUP;
                let _ = std::thread::Builder::new().name("kt-battery-strip-click".into()).spawn(move || f(left, system));
            }
            0
        }
        _ => DefWindowProcW(h, m, w, l),
    }
}

struct State {
    hwnd: HWND,
    tray: HWND,
    child: bool,
    items: Vec<StripItem>,
    system: Vec<SysCell>,
    system_first: bool,
    look: StripLook,
    last: Option<(RECT, RECT, bool, usize)>,
    class: Vec<u16>,
    inst: isize,
}

fn rect_of(h: HWND) -> Option<RECT> {
    let mut r = RECT::default();
    // SAFETY: `r` is a RECT the call fills; a gone window answers 0.
    (unsafe { GetWindowRect(h, &mut r) } != 0).then_some(r)
}

impl State {
    fn destroy(&mut self) {
        if self.hwnd != 0 {
            // SAFETY: our own window, on the thread that made it.
            unsafe { DestroyWindow(self.hwnd) };
        }
        self.hwnd = 0;
        self.last = None;
    }

    /// The window made (again) when missing or when the taskbar is a new one (Explorer restarted).
    fn ensure(&mut self) -> bool {
        let cls = wide("Shell_TrayWnd");
        // SAFETY: a NUL-ended class name.
        let tray = unsafe { FindWindowW(cls.as_ptr(), std::ptr::null()) };
        if tray == 0 {
            self.destroy();
            self.tray = 0;
            return false;
        }
        // SAFETY: a window handle, checked.
        if self.hwnd != 0 && tray == self.tray && unsafe { IsWindow(self.hwnd) } != 0 {
            return true;
        }
        self.destroy();
        self.tray = tray;
        let name = wide("Kurokawa Tools battery");
        // SAFETY: the class registered by run(); a child of the taskbar first, as the original.
        let mut h = unsafe { CreateWindowExW(WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, self.class.as_ptr(), name.as_ptr(), WS_CHILD | WS_CLIPSIBLINGS, 0, 0, 1, 1, tray, 0, self.inst, std::ptr::null()) };
        self.child = h != 0;
        if h == 0 {
            // (A layered child needs Windows 8's manifest entry; without it: a small window of our own over the same place.)
            // SAFETY: as above, without a parent.
            h = unsafe { CreateWindowExW(WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST, self.class.as_ptr(), name.as_ptr(), WS_POPUP, 0, 0, 1, 1, 0, 0, self.inst, std::ptr::null()) };
        }
        if h == 0 {
            return false;
        }
        self.hwnd = h;
        true
    }

    fn hide(&mut self) {
        if self.hwnd != 0 {
            // SAFETY: our own window.
            unsafe { ShowWindow(self.hwnd, SW_HIDE) };
        }
    }

    /// Drawn and placed; false when it is not on the taskbar (hidden).
    fn paint(&mut self, force: bool) -> bool {
        if (self.items.is_empty() && self.system.is_empty()) || !self.ensure() {
            self.hide();
            return false;
        }
        let ncls = wide("TrayNotifyWnd");
        // SAFETY: the taskbar found by ensure(); a NUL-ended class name.
        let notify = unsafe { FindWindowExW(self.tray, 0, ncls.as_ptr(), std::ptr::null()) };
        let (Some(bar), Some(nr)) = (rect_of(self.tray), if notify != 0 { rect_of(notify) } else { None }) else {
            self.hide();
            return false;
        };
        // (Windows 10's «news and interests» button sits right beside the notification area: kept clear — the original's
        // v1.1.0.)
        let to = |r: RECT| Rect { l: r.l, t: r.t, r: r.r, b: r.b };
        let mut beside: Vec<Rect> = Vec::new();
        for cls in ["ShellFeedsTaskbarViewWindow", "DynamicContent2"] {
            let c = wide(cls);
            // SAFETY: the taskbar found by ensure(); a NUL-ended class name; a found window's rectangle read.
            let w = unsafe { FindWindowExW(self.tray, 0, c.as_ptr(), std::ptr::null()) };
            // SAFETY: a window handle (0 is refused by the check before it).
            if w != 0 && unsafe { IsWindowVisible(w) } != 0 {
                if let Some(r) = rect_of(w) {
                    beside.push(to(r));
                }
            }
        }
        let nr = { let a = taskbar::anchor(to(bar), to(nr), &beside); RECT { l: a.l, t: a.t, r: a.r, b: a.b } };
        let light = light_taskbar();
        let key = (bar, nr, light, self.items.len() + self.system.len());
        if !force && self.last == Some(key) {
            return true;
        }
        let bar_h = u32::try_from((bar.b - bar.t).max(0)).unwrap_or(0);
        let drawn = sysmon::render_bar(&self.items, &self.system, self.system_first, bar_h, StripLook { light, ..self.look });
        let mut cv = drawn.canvas;
        cv.catch_clicks();
        if let Ok(mut g) = SPANS.lock() {
            *g = drawn.spans;
        }
        let Some((x, y)) = taskbar::place_strip(to(bar), to(nr), cv.w, cv.h) else {
            self.hide();
            self.last = Some(key);
            return false;
        };
        let (sx, sy) = if self.child { (x, y) } else { (x + bar.l, y + bar.t) };
        let (w, h) = (cv.w as i32, cv.h as i32);
        // SAFETY: our own window; the DIB is ours, freed below; the pixels copied within its w × h × 4 bytes.
        let ok = unsafe {
            SetWindowPos(self.hwnd, if self.child { HWND_TOP } else { HWND_TOPMOST }, sx, sy, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
            let screen = GetDC(0);
            let mem = CreateCompatibleDC(screen);
            let bmi = BITMAPINFO { bmiHeader: BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 }, bmiColors: [0] };
            let mut bits: *mut c_void = std::ptr::null_mut();
            let dib = if mem != 0 { CreateDIBSection(mem, &bmi, DIB_RGB_COLORS, &mut bits, 0, 0) } else { 0 };
            let mut done = false;
            if dib != 0 && !bits.is_null() {
                // (Premultiplied BGRA, as UpdateLayeredWindow wants.)
                let out = std::slice::from_raw_parts_mut(bits.cast::<u8>(), (w * h * 4) as usize);
                for (o, p) in out.chunks_exact_mut(4).zip(cv.px.chunks_exact(4)) {
                    let a = u32::from(p[3]);
                    o[0] = ((u32::from(p[2]) * a + 127) / 255) as u8;
                    o[1] = ((u32::from(p[1]) * a + 127) / 255) as u8;
                    o[2] = ((u32::from(p[0]) * a + 127) / 255) as u8;
                    o[3] = p[3];
                }
                let old = SelectObject(mem, dib);
                let size = SIZE { cx: w, cy: h };
                let src = POINT { x: 0, y: 0 };
                let blend = BLENDFUNCTION { BlendOp: AC_SRC_OVER, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: AC_SRC_ALPHA };
                done = UpdateLayeredWindow(self.hwnd, screen, std::ptr::null(), &size, mem, &src, 0, &blend, ULW_ALPHA) != 0;
                SelectObject(mem, old);
                DeleteObject(dib);
            }
            if mem != 0 {
                DeleteDC(mem);
            }
            ReleaseDC(0, screen);
            done
        };
        if !ok {
            self.hide();
            return false;
        }
        self.last = Some(key);
        true
    }
}

fn run(rx: Receiver<Cmd>, thread_id: Arc<AtomicU32>, alive: Arc<AtomicBool>, on_change: Arc<OnChange>) {
    // (The state kept; a change told on a thread of its own, so the shell's work never holds this one.)
    let set = |v: bool| {
        if alive.swap(v, Ordering::SeqCst) != v {
            let f = on_change.clone();
            let _ = std::thread::Builder::new().name("kt-battery-strip-state".into()).spawn(move || f());
        }
    };
    let class = wide("KurokawaToolsBatteryStrip");
    // SAFETY: this module's handle; the class names our window procedure.
    let inst = unsafe { GetModuleHandleW(std::ptr::null()) };
    let wc = WNDCLASSEXW { cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32, style: 0, lpfnWndProc: Some(wndproc), cbClsExtra: 0, cbWndExtra: 0, hInstance: inst, hIcon: 0, hCursor: 0, hbrBackground: 0, lpszMenuName: std::ptr::null(), lpszClassName: class.as_ptr(), hIconSm: 0 };
    // SAFETY: a filled class; registered once per process (a second registration fails harmlessly).
    unsafe { RegisterClassExW(&wc) };
    let tc = wide("TaskbarCreated");
    // SAFETY: a NUL-ended name.
    let taskbar_created = unsafe { RegisterWindowMessageW(tc.as_ptr()) };
    let mut msg = MSG { hwnd: 0, message: 0, wParam: 0, lParam: 0, time: 0, pt: POINT::default(), lPrivate: 0 };
    // SAFETY: makes this thread's message queue, so PostThreadMessageW reaches it from now on.
    unsafe { PeekMessageW(&mut msg, 0, 0, 0, PM_NOREMOVE) };
    // SAFETY: no arguments.
    thread_id.store(unsafe { GetCurrentThreadId() }, Ordering::SeqCst);
    let mut st = State { hwnd: 0, tray: 0, child: true, items: Vec::new(), system: Vec::new(), system_first: false, look: StripLook { light: false, stacked: false, plate: false }, last: None, class, inst };
    // (Commands sent before the queue existed.)
    let mut stop = false;
    let drain = |st: &mut State, stop: &mut bool| {
        let mut changed = false;
        while let Ok(c) = rx.try_recv() {
            match c {
                Cmd::Show(items, system, first, look) => {
                    st.items = items;
                    st.system = system;
                    st.system_first = first;
                    st.look = look;
                    changed = true;
                }
                Cmd::Stop => *stop = true,
            }
        }
        changed
    };
    if drain(&mut st, &mut stop) {
        set(st.paint(true));
    }
    // (A timer of the thread, not of the window: it goes on when Explorer restarts and takes our child window with it.)
    // SAFETY: no window; the WM_TIMER messages come to this thread's queue.
    let timer = unsafe { SetTimer(0, TIMER_ID, CHECK_MS, std::ptr::null()) };
    while !stop {
        // SAFETY: `msg` is ours; 0 or -1 ends the loop.
        let r = unsafe { GetMessageW(&mut msg, 0, 0, 0) };
        if r == 0 || r == -1 {
            break;
        }
        if msg.hwnd == 0 && msg.message == WM_APP_CMD {
            if drain(&mut st, &mut stop) && !stop {
                set(st.paint(true));
            }
            continue;
        }
        if msg.message == WM_TIMER && msg.hwnd == 0 {
            set(st.paint(false));
        } else if (taskbar_created != 0 && msg.message == taskbar_created) || msg.message == WM_SETTINGCHANGE {
            // (Explorer restarted, or the light / dark choice changed: made and drawn again.)
            set(st.paint(true));
        }
        // SAFETY: a message this thread received.
        unsafe {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if msg.message == WM_DESTROY && msg.hwnd == st.hwnd {
            st.hwnd = 0;
        }
    }
    if timer != 0 {
        // SAFETY: the thread's own timer.
        unsafe { KillTimer(0, timer) };
    }
    st.destroy();
    set(false);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_pointer_width = "64")]
    fn the_sdk_sizes() {
        assert_eq!(std::mem::size_of::<MSG>(), 48);
        assert_eq!(std::mem::size_of::<WNDCLASSEXW>(), 80);
        assert_eq!(std::mem::size_of::<BITMAPINFOHEADER>(), 40);
        assert_eq!(std::mem::size_of::<BITMAPINFO>(), 44);
        assert_eq!(std::mem::size_of::<SYSTEMTIME>(), 16);
        assert_eq!(std::mem::size_of::<BLENDFUNCTION>(), 4);
        assert_eq!(std::mem::size_of::<RECT>(), 16);
    }
}
