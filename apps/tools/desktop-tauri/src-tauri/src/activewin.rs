// The pets' «follow the active window» (src/pets/desktop.ts through petwin.rs): the rectangle of the window in front,
// and the work area of the screen (without the taskbar or panels). std only — each system's own library reached
// directly, no crate:
//  - Windows: user32's GetForegroundWindow, dwmapi's extended frame bounds (the visible frame, without the invisible
//    resize borders GetWindowRect counts), cloaked windows (another virtual desktop, a suspended app) left out;
//    SystemParametersInfoW(SPI_GETWORKAREA). Physical pixels.
//  - macOS: CoreGraphics' on-screen window list, front to back: the first ordinary window (layer 0) of another
//    process, or of this one. Points (the page's logical pixels). The work area is not read (the caller uses the
//    monitor).
//  - Linux, X11: libX11 loaded at run time (dlopen, so the build never links it): the root's _NET_ACTIVE_WINDOW, its
//    place on the root and its frame (_NET_FRAME_EXTENTS); the root's _NET_WORKAREA. Physical pixels. Its own display
//    connection; its error handler set only around each query and GDK's put back right after.
//  - Wayland: no client may see other windows: «unsupported», the pet keeps to the screen's bottom edge.
// Every path answers None or Unsupported rather than fail; this file compiles on Linux here (its tests), the other
// systems' paths only in CI.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Active {
    /// The window in front.
    Window(Rect),
    /// None now (the desktop itself, a minimised window, the taskbar).
    Nothing,
    /// Not possible here (why).
    Unsupported(&'static str),
}

/// Whether the pixels are physical (Windows, X11) or points (macOS).
pub const PHYSICAL: bool = !cfg!(target_os = "macos");

/// A window too small to stand on (a tooltip, a splash) is not counted.
pub fn usable(r: &Rect) -> bool {
    r.w >= 120 && r.h >= 60
}

/// The top of a window's frame from its client area's top and its frame's top extent (X11's _NET_FRAME_EXTENTS).
pub fn frame_rect(client_x: i32, client_y: i32, w: u32, h: u32, ext: [i64; 4]) -> Rect {
    let [l, r, t, b] = ext.map(|v| v.clamp(0, 400) as i32);
    Rect { x: client_x - l, y: client_y - t, w: w as i32 + l + r, h: h as i32 + t + b }
}

/// Window classes on Windows that are the desktop or the shell, not a window to walk on.
pub fn shell_class(name: &str) -> bool {
    matches!(name, "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "NotifyIconOverflowWindow" | "Windows.UI.Core.CoreWindow")
}

/// A Wayland session (the X11 path then sees only XWayland's windows: not the window in front).
pub fn wayland_session(xdg_session: Option<&str>, wayland_display: Option<&str>, gdk_backend: Option<&str>) -> bool {
    if gdk_backend.map(|b| b.starts_with("x11")).unwrap_or(false) && xdg_session != Some("wayland") {
        return false;
    }
    xdg_session == Some("wayland") || wayland_display.map(|d| !d.is_empty()).unwrap_or(false)
}

pub fn active() -> Active {
    os::active()
}
/// The primary screen's work area, where the system says (else None).
pub fn work_area() -> Option<Rect> {
    os::work_area()
}

#[cfg(windows)]
mod os {
    use super::{shell_class, usable, Active, Rect};
    use std::ffi::c_void;
    #[repr(C)]
    #[derive(Default)]
    struct Win32Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> *mut c_void;
        fn GetShellWindow() -> *mut c_void;
        fn GetDesktopWindow() -> *mut c_void;
        fn IsIconic(h: *mut c_void) -> i32;
        fn IsWindowVisible(h: *mut c_void) -> i32;
        fn GetWindowRect(h: *mut c_void, r: *mut Win32Rect) -> i32;
        fn GetClassNameW(h: *mut c_void, buf: *mut u16, n: i32) -> i32;
        fn SystemParametersInfoW(action: u32, param: u32, pv: *mut c_void, ini: u32) -> i32;
    }
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmGetWindowAttribute(h: *mut c_void, attr: u32, pv: *mut c_void, cb: u32) -> i32;
    }
    const DWMWA_EXTENDED_FRAME_BOUNDS: u32 = 9;
    const DWMWA_CLOAKED: u32 = 14;
    const SPI_GETWORKAREA: u32 = 0x0030;

    pub fn active() -> Active {
        unsafe {
            let h = GetForegroundWindow();
            if h.is_null() || h == GetShellWindow() || h == GetDesktopWindow() || IsIconic(h) != 0 || IsWindowVisible(h) == 0 {
                return Active::Nothing;
            }
            let mut cloaked: u32 = 0;
            if DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut c_void, 4) == 0 && cloaked != 0 {
                return Active::Nothing;
            }
            let mut buf = [0u16; 64];
            let n = GetClassNameW(h, buf.as_mut_ptr(), buf.len() as i32);
            if n > 0 && shell_class(&String::from_utf16_lossy(&buf[..n as usize])) {
                return Active::Nothing;
            }
            let mut r = Win32Rect::default();
            let size = std::mem::size_of::<Win32Rect>() as u32;
            if DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut Win32Rect as *mut c_void, size) != 0 && GetWindowRect(h, &mut r) == 0 {
                return Active::Nothing;
            }
            let rect = Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
            if usable(&rect) {
                Active::Window(rect)
            } else {
                Active::Nothing
            }
        }
    }
    pub fn work_area() -> Option<Rect> {
        let mut r = Win32Rect::default();
        let ok = unsafe { SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut r as *mut Win32Rect as *mut c_void, 0) };
        if ok == 0 || r.right <= r.left || r.bottom <= r.top {
            return None;
        }
        Some(Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top })
    }
}

#[cfg(target_os = "macos")]
mod os {
    use super::{usable, Active, Rect};
    use std::ffi::c_void;
    type CFTypeRef = *const c_void;
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFTypeRef;
        fn CGRectMakeWithDictionaryRepresentation(dict: CFTypeRef, rect: *mut CGRect) -> bool;
        static kCGWindowBounds: CFTypeRef;
        static kCGWindowLayer: CFTypeRef;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFArrayGetCount(a: CFTypeRef) -> isize;
        fn CFArrayGetValueAtIndex(a: CFTypeRef, i: isize) -> CFTypeRef;
        fn CFDictionaryGetValue(d: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
        fn CFNumberGetValue(n: CFTypeRef, kind: isize, out: *mut c_void) -> bool;
        fn CFRelease(x: CFTypeRef);
    }
    const ON_SCREEN_ONLY: u32 = 1;
    const EXCLUDE_DESKTOP: u32 = 16;
    const SINT32: isize = 3;

    pub fn active() -> Active {
        unsafe {
            let list = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0);
            if list.is_null() {
                return Active::Nothing;
            }
            let mut out = Active::Nothing;
            let n = CFArrayGetCount(list).min(400);
            for i in 0..n {
                let d = CFArrayGetValueAtIndex(list, i);
                if d.is_null() {
                    continue;
                }
                let lv = CFDictionaryGetValue(d, kCGWindowLayer);
                let mut layer: i32 = -1;
                if lv.is_null() || !CFNumberGetValue(lv, SINT32, &mut layer as *mut i32 as *mut c_void) || layer != 0 {
                    continue;
                }
                let b = CFDictionaryGetValue(d, kCGWindowBounds);
                let mut r = CGRect::default();
                if b.is_null() || !CGRectMakeWithDictionaryRepresentation(b, &mut r) {
                    continue;
                }
                let rect = Rect { x: r.origin.x.round() as i32, y: r.origin.y.round() as i32, w: r.size.width.round() as i32, h: r.size.height.round() as i32 };
                if usable(&rect) {
                    out = Active::Window(rect);
                    break;
                }
            }
            CFRelease(list);
            out
        }
    }
    pub fn work_area() -> Option<Rect> {
        None
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod os {
    use super::{frame_rect, usable, wayland_session, Active, Rect};
    use std::ffi::{c_char, c_int, c_long, c_uint, c_ulong, c_void, CString};
    use std::sync::Mutex;

    #[link(name = "dl")]
    extern "C" {
        fn dlopen(name: *const c_char, flag: c_int) -> *mut c_void;
        fn dlsym(h: *mut c_void, name: *const c_char) -> *mut c_void;
    }
    const RTLD_NOW: c_int = 2;
    type Display = c_void;
    type Window = c_ulong;
    type Atom = c_ulong;
    struct X {
        dpy: *mut Display,
        root: Window,
        intern: unsafe extern "C" fn(*mut Display, *const c_char, c_int) -> Atom,
        get_prop: unsafe extern "C" fn(*mut Display, Window, Atom, c_long, c_long, c_int, Atom, *mut Atom, *mut c_int, *mut c_ulong, *mut c_ulong, *mut *mut u8) -> c_int,
        free: unsafe extern "C" fn(*mut c_void) -> c_int,
        geom: unsafe extern "C" fn(*mut Display, Window, *mut Window, *mut c_int, *mut c_int, *mut c_uint, *mut c_uint, *mut c_uint, *mut c_uint) -> c_int,
        translate: unsafe extern "C" fn(*mut Display, Window, Window, c_int, c_int, *mut c_int, *mut c_int, *mut Window) -> c_int,
        set_handler: unsafe extern "C" fn(Option<Handler>) -> Option<Handler>,
        sync: unsafe extern "C" fn(*mut Display, c_int) -> c_int,
    }
    type Handler = unsafe extern "C" fn(*mut Display, *mut c_void) -> c_int;
    unsafe impl Send for X {}
    /// One connection, opened at the first ask (None: there is no X here); used under a lock.
    static CONN: Mutex<Option<Option<X>>> = Mutex::new(None);
    /// An X error (a window gone between two calls) is not fatal: Xlib's default handler would end the program.
    unsafe extern "C" fn quiet(_: *mut Display, _: *mut c_void) -> c_int {
        0
    }
    unsafe fn sym<T>(lib: *mut c_void, name: &str) -> Option<T> {
        let c = CString::new(name).ok()?;
        let p = dlsym(lib, c.as_ptr());
        if p.is_null() {
            None
        } else {
            Some(std::mem::transmute_copy::<*mut c_void, T>(&p))
        }
    }
    fn open() -> Option<X> {
        std::env::var_os("DISPLAY").filter(|d| !d.is_empty())?;
        unsafe {
            let mut lib = std::ptr::null_mut();
            for n in ["libX11.so.6", "libX11.so"] {
                let c = CString::new(n).ok()?;
                lib = dlopen(c.as_ptr(), RTLD_NOW);
                if !lib.is_null() {
                    break;
                }
            }
            if lib.is_null() {
                return None;
            }
            let open_display: unsafe extern "C" fn(*const c_char) -> *mut Display = sym(lib, "XOpenDisplay")?;
            let root_of: unsafe extern "C" fn(*mut Display) -> Window = sym(lib, "XDefaultRootWindow")?;
            let x = X {
                dpy: std::ptr::null_mut(),
                root: 0,
                intern: sym(lib, "XInternAtom")?,
                get_prop: sym(lib, "XGetWindowProperty")?,
                free: sym(lib, "XFree")?,
                geom: sym(lib, "XGetGeometry")?,
                translate: sym(lib, "XTranslateCoordinates")?,
                set_handler: sym(lib, "XSetErrorHandler")?,
                sync: sym(lib, "XSync")?,
            };
            let dpy = open_display(std::ptr::null());
            if dpy.is_null() {
                return None;
            }
            Some(X { dpy, root: root_of(dpy), ..x })
        }
    }
    /// Up to `max` 32-bit items of a window's property (X hands them as longs).
    unsafe fn longs(x: &X, w: Window, name: &str, max: c_long) -> Vec<i64> {
        let Ok(c) = CString::new(name) else { return vec![] };
        let atom = (x.intern)(x.dpy, c.as_ptr(), 1);
        if atom == 0 {
            return vec![];
        }
        let (mut ty, mut fmt, mut n, mut after, mut data): (Atom, c_int, c_ulong, c_ulong, *mut u8) = (0, 0, 0, 0, std::ptr::null_mut());
        // (AnyPropertyType = 0.)
        if (x.get_prop)(x.dpy, w, atom, 0, max, 0, 0, &mut ty, &mut fmt, &mut n, &mut after, &mut data) != 0 || data.is_null() {
            return vec![];
        }
        let out = if fmt == 32 { std::slice::from_raw_parts(data as *const c_long, n.min(max as c_ulong) as usize).iter().map(|v| *v as i64).collect() } else { vec![] };
        (x.free)(data as *mut c_void);
        out
    }
    /// A query on this module's own connection (not GDK's), under the lock. Xlib's error handler is one for the whole
    /// process: ours (which keeps a window gone between two calls from ending the program) is set only for the query —
    /// its errors flushed with XSync — and the one before it (GDK's) put back at once.
    fn with<T>(f: impl FnOnce(&X) -> T) -> Option<T> {
        let mut g = CONN.lock().ok()?;
        if g.is_none() {
            *g = Some(open());
        }
        let x = g.as_ref().and_then(|o| o.as_ref())?;
        unsafe {
            let prev = (x.set_handler)(Some(quiet));
            let out = f(x);
            (x.sync)(x.dpy, 0);
            (x.set_handler)(prev);
            Some(out)
        }
    }
    fn env(k: &str) -> Option<String> {
        std::env::var(k).ok()
    }
    pub fn active() -> Active {
        if wayland_session(env("XDG_SESSION_TYPE").as_deref(), env("WAYLAND_DISPLAY").as_deref(), env("GDK_BACKEND").as_deref()) {
            return Active::Unsupported("wayland");
        }
        with(|x| unsafe {
            let a = longs(x, x.root, "_NET_ACTIVE_WINDOW", 1);
            let w = match a.first() {
                Some(&w) if w > 0 => w as Window,
                _ => return Active::Nothing,
            };
            let (mut root, mut gx, mut gy, mut gw, mut gh, mut bw, mut depth): (Window, c_int, c_int, c_uint, c_uint, c_uint, c_uint) = (0, 0, 0, 0, 0, 0, 0);
            if (x.geom)(x.dpy, w, &mut root, &mut gx, &mut gy, &mut gw, &mut gh, &mut bw, &mut depth) == 0 {
                return Active::Nothing;
            }
            let (mut rx, mut ry, mut child): (c_int, c_int, Window) = (0, 0, 0);
            if (x.translate)(x.dpy, w, x.root, 0, 0, &mut rx, &mut ry, &mut child) == 0 {
                return Active::Nothing;
            }
            let e = longs(x, w, "_NET_FRAME_EXTENTS", 4);
            let ext = if e.len() == 4 { [e[0], e[1], e[2], e[3]] } else { [0; 4] };
            let r = frame_rect(rx, ry, gw, gh, ext);
            if usable(&r) {
                Active::Window(r)
            } else {
                Active::Nothing
            }
        })
        .unwrap_or(Active::Unsupported("noX11"))
    }
    pub fn work_area() -> Option<Rect> {
        if wayland_session(env("XDG_SESSION_TYPE").as_deref(), env("WAYLAND_DISPLAY").as_deref(), env("GDK_BACKEND").as_deref()) {
            return None;
        }
        with(|x| unsafe {
            let v = longs(x, x.root, "_NET_WORKAREA", 4);
            if v.len() == 4 && v[2] > 0 && v[3] > 0 {
                Some(Rect { x: v[0] as i32, y: v[1] as i32, w: v[2] as i32, h: v[3] as i32 })
            } else {
                None
            }
        })
        .flatten()
    }
}

#[cfg(not(any(windows, unix)))]
mod os {
    use super::{Active, Rect};
    pub fn active() -> Active {
        Active::Unsupported("system")
    }
    pub fn work_area() -> Option<Rect> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_from_extents() {
        assert_eq!(frame_rect(100, 80, 800, 600, [2, 2, 30, 2]), Rect { x: 98, y: 50, w: 804, h: 632 });
        // (A hostile or broken extent is held to sane bounds.)
        assert_eq!(frame_rect(0, 0, 10, 10, [-5, 99999, 0, 0]), Rect { x: 0, y: 0, w: 410, h: 10 });
    }
    #[test]
    fn small_windows_not_counted() {
        assert!(!usable(&Rect { x: 0, y: 0, w: 80, h: 400 }));
        assert!(usable(&Rect { x: 0, y: 0, w: 400, h: 300 }));
    }
    #[test]
    fn shell_windows() {
        assert!(shell_class("Progman") && shell_class("Shell_TrayWnd") && !shell_class("Notepad"));
    }
    #[test]
    fn wayland_told_apart() {
        assert!(wayland_session(Some("wayland"), Some("wayland-0"), None));
        assert!(wayland_session(None, Some("wayland-0"), None));
        assert!(!wayland_session(Some("x11"), None, None));
        assert!(!wayland_session(None, Some("wayland-0"), Some("x11")));
        assert!(wayland_session(Some("wayland"), Some("wayland-0"), Some("x11")));
    }
    #[test]
    fn no_display_no_crash() {
        // (Here: no X server for the test — the answer is «unsupported» or nothing, never a fault.)
        let a = active();
        assert!(matches!(a, Active::Unsupported(_) | Active::Nothing | Active::Window(_)));
        let _ = work_area();
    }
}
