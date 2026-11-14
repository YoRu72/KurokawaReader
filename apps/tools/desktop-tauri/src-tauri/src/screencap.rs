// The screen translator's capture (stage P9 part — the screen translator; Electron: desktopCapturer's thumbnail of the
// display under the mouse). No capture crate: each system's own facility, called directly —
//   Windows: GDI's BitBlt from the screen's DC into a bitmap, read with GetDIBits (user32 / gdi32, raw FFI; the
//            process is per-monitor DPI aware — tao makes it so —, so the desktop's coordinates are physical pixels).
//            No yellow border (that is Windows.Graphics.Capture's). What GDI cannot see comes out black: a game in
//            exclusive full screen, a protected (DRM) video — Electron's capturer has the same limits for the latter.
//   Linux, X11: libX11 (loaded at run time with dlopen — no build dependency) XGetImage of the root window on a
//            connection of our own (GTK ignores X errors on a display it did not open; the rectangle is kept inside
//            the root window anyway, so XGetImage has nothing to refuse).
//   Linux, Wayland: an X server's root window shows no Wayland window, so: `grim` where it is installed (wlroots
//            desktops — Sway, Hyprland …), else the desktop portal's Screenshot through `gdbus` (GNOME, KDE …: the
//            system may ask the user — once, or each time, as it decides); none of these → «not available».
//   macOS:   `/usr/sbin/screencapture -x -R …` (the system's own program; the Screen Recording permission is this
//            app's — CGPreflightScreenCaptureAccess / CGRequestScreenCaptureAccess, looked up at run time).
// The rules (rectangles, pixel formats, the PNG, the portal's answers) are kt-core's screenlogic.rs, std only.
use std::path::{Path, PathBuf};
use std::time::Duration;

use kt_core::screenlogic as logic;
use logic::{Mon, Rect};

/// A picture: RGBA, `w`×`h`; `png` when the system handed a PNG (then it is the picture as it came).
pub struct Pic {
    pub w: u32,
    pub h: u32,
    pub rgba: Vec<u8>,
    pub png: Option<Vec<u8>>,
}

/// How this system captures, and why not when it cannot: ("gdi" | "x11" | "screencapture" | "grim" | "portal" |
/// "none", why).
pub fn how() -> (&'static str, String) {
    #[cfg(windows)]
    {
        ("gdi", String::new())
    }
    #[cfg(target_os = "macos")]
    {
        if Path::new("/usr/sbin/screencapture").exists() {
            ("screencapture", String::new())
        } else {
            ("none", "/usr/sbin/screencapture is missing".to_string())
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let st = std::env::var("XDG_SESSION_TYPE").ok();
        let wd = std::env::var("WAYLAND_DISPLAY").ok();
        if logic::is_wayland(st.as_deref(), wd.as_deref()) {
            if crate::vtproc::find_on_path("grim").is_some() {
                return ("grim", String::new());
            }
            if crate::vtproc::find_on_path("gdbus").is_some() {
                return ("portal", String::new());
            }
            return ("none", "a Wayland session without grim or gdbus (the desktop portal's screenshot)".to_string());
        }
        if std::env::var_os("DISPLAY").map(|v| v.is_empty()).unwrap_or(true) {
            return ("none", "no X display (DISPLAY is not set)".to_string());
        }
        match x11::lib() {
            Some(_) => ("x11", String::new()),
            None => ("none", "libX11.so.6 could not be loaded".to_string()),
        }
    }
    #[cfg(not(any(windows, unix)))]
    {
        ("none", "this system has no capture here".to_string())
    }
}

/// The rectangle `r` (physical pixels, relative to the monitor `m`) as a picture.
pub fn grab(m: &Mon, r: &Rect) -> Result<Pic, String> {
    let r = logic::clamp_rect(r, m.w, m.h).ok_or_else(|| "an empty region".to_string())?;
    let (kind, why) = how();
    match kind {
        #[cfg(windows)]
        "gdi" => {
            let mut px = win::grab(m.x + r.x, m.y + r.y, r.w as i32, r.h as i32)?;
            logic::bgra_to_rgba(&mut px);
            Ok(Pic { w: r.w, h: r.h, rgba: px, png: None })
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        "x11" => {
            let (px, w, h) = x11::grab(m.x + r.x, m.y + r.y, r.w, r.h)?;
            Ok(Pic { w, h, rgba: px, png: None })
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        "grim" => {
            let f = temp_png("grim");
            let args = logic::grim_args(logic::points_rect(m, &r), &f.to_string_lossy());
            let res = run_tool(Path::new("grim"), &args, Duration::from_secs(20));
            let pic = res.and_then(|_| read_png(&f));
            let _ = std::fs::remove_file(&f);
            pic
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        "portal" => {
            let whole = portal_shot()?;
            // (The portal gives the whole desktop: the monitor's part of it when it is that large, else all of it.)
            let rr = Rect { x: m.x + r.x, y: m.y + r.y, w: r.w, h: r.h };
            match logic::clamp_rect(&rr, whole.w, whole.h) {
                Some(c) if c.w == r.w && c.h == r.h => {
                    let (px, w, h) = logic::crop_rgba(&whole.rgba, whole.w, whole.h, &c);
                    Ok(Pic { w, h, rgba: px, png: None })
                }
                _ => Ok(whole),
            }
        }
        #[cfg(target_os = "macos")]
        "screencapture" => {
            if mac::preflight() == Some(false) {
                return Err("screen-permission".to_string());
            }
            let f = temp_png("sc");
            let args = logic::screencapture_args(logic::points_rect(m, &r), &f.to_string_lossy());
            let res = run_tool(Path::new("/usr/sbin/screencapture"), &args, Duration::from_secs(20));
            let pic = res.and_then(|_| read_png(&f));
            let _ = std::fs::remove_file(&f);
            pic
        }
        _ => Err(format!("not available on this system: {}", if why.is_empty() { kind.to_string() } else { why })),
    }
}

#[allow(dead_code)]
fn temp_png(tag: &str) -> PathBuf {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    std::env::temp_dir().join(format!("kt-cap-{}-{}-{}.png", tag, std::process::id(), n))
}

#[allow(dead_code)]
fn run_tool(bin: &Path, args: &[String], limit: Duration) -> Result<(), String> {
    let r = crate::vtproc::run(bin, args, limit, 1 << 16)?;
    if r.timed_out {
        return Err(format!("{} took too long", bin.display()));
    }
    if r.code != Some(0) {
        return Err(format!("{}: {}", bin.display(), r.err.trim().chars().take(300).collect::<String>()));
    }
    Ok(())
}

/// A PNG file read and decoded (Tauri's own PNG reader — its image-png feature, already in the build).
#[allow(dead_code)]
fn read_png(f: &Path) -> Result<Pic, String> {
    let bytes = std::fs::read(f).map_err(|e| format!("the picture was not written: {}", e))?;
    let (w, h, rgba) = decode_png(&bytes)?;
    Ok(Pic { w, h, rgba, png: Some(bytes) })
}

/// A PNG's pixels (RGBA).
pub fn decode_png(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let img = tauri::image::Image::from_bytes(bytes).map_err(|e| e.to_string())?;
    Ok((img.width(), img.height(), img.rgba().to_vec()))
}

/// The picture as a PNG: as it came, else written (flate2, fast — a screen is large and mostly flat colour).
pub fn png_of(p: &Pic) -> Vec<u8> {
    if let Some(b) = p.png.as_ref() {
        return b.clone();
    }
    encode_png(p.w, p.h, &p.rgba)
}

pub fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    logic::png_encode(w, h, rgba, &|raw: &[u8]| {
        use std::io::Write;
        let mut z = flate2::write::ZlibEncoder::new(Vec::with_capacity(raw.len() / 4), flate2::Compression::fast());
        if z.write_all(raw).is_err() {
            return logic::zlib_stored(raw);
        }
        z.finish().unwrap_or_else(|_| logic::zlib_stored(raw))
    })
}

/// The mouse's place in physical desktop pixels, from the system itself (when Tauri's own call is not in the build).
pub fn cursor() -> Option<(f64, f64)> {
    #[cfg(windows)]
    {
        return win::cursor();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let st = std::env::var("XDG_SESSION_TYPE").ok();
        let wd = std::env::var("WAYLAND_DISPLAY").ok();
        if logic::is_wayland(st.as_deref(), wd.as_deref()) {
            return None;
        }
        return x11::cursor();
    }
    #[allow(unreachable_code)]
    None
}

/// A Mac's Screen Recording permission: Some(granted) where the system can say (10.15+), None elsewhere.
pub fn permission() -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        return mac::preflight();
    }
    #[allow(unreachable_code)]
    None
}

/// A Mac: the system asked to show its Screen Recording request (once — it remembers); true when already granted.
pub fn ask_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        return mac::request();
    }
    #[allow(unreachable_code)]
    true
}

/* ---------- Windows: GDI ---------- */

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    type H = *mut c_void;

    #[repr(C)]
    struct BitmapInfoHeader {
        size: u32,
        width: i32,
        height: i32,
        planes: u16,
        bit_count: u16,
        compression: u32,
        size_image: u32,
        x_ppm: i32,
        y_ppm: i32,
        clr_used: u32,
        clr_important: u32,
    }
    #[repr(C)]
    struct BitmapInfo {
        header: BitmapInfoHeader,
        colors: [u32; 1],
    }
    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetDC(hwnd: H) -> H;
        fn ReleaseDC(hwnd: H, hdc: H) -> i32;
        fn GetCursorPos(p: *mut Point) -> i32;
    }
    #[link(name = "gdi32")]
    extern "system" {
        fn CreateCompatibleDC(hdc: H) -> H;
        fn CreateCompatibleBitmap(hdc: H, w: i32, h: i32) -> H;
        fn SelectObject(hdc: H, o: H) -> H;
        fn BitBlt(dst: H, x: i32, y: i32, w: i32, h: i32, src: H, sx: i32, sy: i32, rop: u32) -> i32;
        fn GetDIBits(hdc: H, bm: H, start: u32, lines: u32, bits: *mut c_void, bmi: *mut BitmapInfo, usage: u32) -> i32;
        fn DeleteObject(o: H) -> i32;
        fn DeleteDC(hdc: H) -> i32;
    }

    const SRCCOPY: u32 = 0x00CC_0020;
    const CAPTUREBLT: u32 = 0x4000_0000;

    /// The desktop's rectangle (physical pixels) as top-down BGRA.
    pub fn grab(x: i32, y: i32, w: i32, h: i32) -> Result<Vec<u8>, String> {
        if w <= 0 || h <= 0 || (w as i64) * (h as i64) > 100_000_000 {
            return Err(format!("a region of {}×{} cannot be taken", w, h));
        }
        unsafe {
            let screen = GetDC(std::ptr::null_mut());
            if screen.is_null() {
                return Err("GetDC failed".into());
            }
            let mem = CreateCompatibleDC(screen);
            let bmp = if mem.is_null() { std::ptr::null_mut() } else { CreateCompatibleBitmap(screen, w, h) };
            if bmp.is_null() {
                if !mem.is_null() {
                    DeleteDC(mem);
                }
                ReleaseDC(std::ptr::null_mut(), screen);
                return Err("CreateCompatibleBitmap failed".into());
            }
            let old = SelectObject(mem, bmp);
            let blt = BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY | CAPTUREBLT);
            // (The bitmap let go of before GetDIBits reads it, as its documentation asks.)
            SelectObject(mem, old);
            let mut bi = BitmapInfo {
                header: BitmapInfoHeader { size: std::mem::size_of::<BitmapInfoHeader>() as u32, width: w, height: -h, planes: 1, bit_count: 32, compression: 0, size_image: 0, x_ppm: 0, y_ppm: 0, clr_used: 0, clr_important: 0 },
                colors: [0],
            };
            let mut buf = vec![0u8; w as usize * h as usize * 4];
            let lines = if blt != 0 { GetDIBits(mem, bmp, 0, h as u32, buf.as_mut_ptr() as *mut c_void, &mut bi, 0) } else { 0 };
            DeleteObject(bmp);
            DeleteDC(mem);
            ReleaseDC(std::ptr::null_mut(), screen);
            if blt == 0 {
                return Err("BitBlt failed (a secure desktop — the lock screen, an elevation prompt — cannot be taken)".into());
            }
            if lines != h {
                return Err(format!("GetDIBits read {} of {} lines", lines, h));
            }
            Ok(buf)
        }
    }

    pub fn cursor() -> Option<(f64, f64)> {
        let mut p = Point { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut p) } != 0 {
            Some((p.x as f64, p.y as f64))
        } else {
            None
        }
    }
}

/* ---------- Linux: X11 through libX11, loaded at run time ---------- */

#[cfg(all(unix, not(target_os = "macos")))]
mod x11 {
    use std::ffi::{c_char, c_int, c_uint, c_ulong, c_void, CString};
    use std::sync::OnceLock;

    use kt_core::screenlogic as logic;

    #[repr(C)]
    struct Funcs {
        create_image: *mut c_void,
        destroy_image: Option<unsafe extern "C" fn(*mut XImage) -> c_int>,
        get_pixel: *mut c_void,
        put_pixel: *mut c_void,
        sub_image: *mut c_void,
        add_pixel: *mut c_void,
    }
    /// Xlib.h's XImage, as far as its functions.
    #[repr(C)]
    struct XImage {
        width: c_int,
        height: c_int,
        xoffset: c_int,
        format: c_int,
        data: *mut c_char,
        byte_order: c_int,
        bitmap_unit: c_int,
        bitmap_bit_order: c_int,
        bitmap_pad: c_int,
        depth: c_int,
        bytes_per_line: c_int,
        bits_per_pixel: c_int,
        red_mask: c_ulong,
        green_mask: c_ulong,
        blue_mask: c_ulong,
        obdata: *mut c_char,
        f: Funcs,
    }

    type Dpy = *mut c_void;
    pub struct Lib {
        open: unsafe extern "C" fn(*const c_char) -> Dpy,
        close: unsafe extern "C" fn(Dpy) -> c_int,
        root: unsafe extern "C" fn(Dpy) -> c_ulong,
        get_image: unsafe extern "C" fn(Dpy, c_ulong, c_int, c_int, c_uint, c_uint, c_ulong, c_int) -> *mut XImage,
        geometry: unsafe extern "C" fn(Dpy, c_ulong, *mut c_ulong, *mut c_int, *mut c_int, *mut c_uint, *mut c_uint, *mut c_uint, *mut c_uint) -> c_int,
        pointer: unsafe extern "C" fn(Dpy, c_ulong, *mut c_ulong, *mut c_ulong, *mut c_int, *mut c_int, *mut c_int, *mut c_int, *mut c_uint) -> c_int,
        free: unsafe extern "C" fn(*mut c_void) -> c_int,
    }

    static LIB: OnceLock<Option<Lib>> = OnceLock::new();

    pub fn lib() -> Option<&'static Lib> {
        LIB.get_or_init(|| unsafe {
            let mut h = std::ptr::null_mut();
            for name in ["libX11.so.6", "libX11.so"] {
                let c = CString::new(name).ok()?;
                h = libc::dlopen(c.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL);
                if !h.is_null() {
                    break;
                }
            }
            if h.is_null() {
                return None;
            }
            let sym = |n: &str| -> Option<*mut c_void> {
                let c = CString::new(n).ok()?;
                let p = libc::dlsym(h, c.as_ptr());
                if p.is_null() {
                    None
                } else {
                    Some(p)
                }
            };
            Some(Lib {
                open: std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*const c_char) -> Dpy>(sym("XOpenDisplay")?),
                close: std::mem::transmute::<*mut c_void, unsafe extern "C" fn(Dpy) -> c_int>(sym("XCloseDisplay")?),
                root: std::mem::transmute::<*mut c_void, unsafe extern "C" fn(Dpy) -> c_ulong>(sym("XDefaultRootWindow")?),
                get_image: std::mem::transmute::<*mut c_void, unsafe extern "C" fn(Dpy, c_ulong, c_int, c_int, c_uint, c_uint, c_ulong, c_int) -> *mut XImage>(sym("XGetImage")?),
                geometry: std::mem::transmute::<*mut c_void, unsafe extern "C" fn(Dpy, c_ulong, *mut c_ulong, *mut c_int, *mut c_int, *mut c_uint, *mut c_uint, *mut c_uint, *mut c_uint) -> c_int>(sym("XGetGeometry")?),
                pointer: std::mem::transmute::<*mut c_void, unsafe extern "C" fn(Dpy, c_ulong, *mut c_ulong, *mut c_ulong, *mut c_int, *mut c_int, *mut c_int, *mut c_int, *mut c_uint) -> c_int>(sym("XQueryPointer")?),
                free: std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut c_void) -> c_int>(sym("XFree")?),
            })
        })
        .as_ref()
    }

    /// One connection, closed when dropped.
    struct Conn(&'static Lib, Dpy);
    impl Drop for Conn {
        fn drop(&mut self) {
            unsafe {
                (self.0.close)(self.1);
            }
        }
    }
    fn connect() -> Result<Conn, String> {
        let l = lib().ok_or("libX11.so.6 could not be loaded")?;
        let d = unsafe { (l.open)(std::ptr::null()) };
        if d.is_null() {
            return Err("the X display could not be opened".into());
        }
        Ok(Conn(l, d))
    }

    /// The root window's rectangle (desktop pixels) as RGBA, kept within the root window.
    pub fn grab(x: i32, y: i32, w: u32, h: u32) -> Result<(Vec<u8>, u32, u32), String> {
        let c = connect()?;
        let l = c.0;
        unsafe {
            let root = (l.root)(c.1);
            let (mut r, mut gx, mut gy, mut gw, mut gh, mut bw, mut dp) = (0 as c_ulong, 0 as c_int, 0 as c_int, 0 as c_uint, 0 as c_uint, 0 as c_uint, 0 as c_uint);
            if (l.geometry)(c.1, root, &mut r, &mut gx, &mut gy, &mut gw, &mut gh, &mut bw, &mut dp) == 0 {
                return Err("XGetGeometry failed".into());
            }
            let rect = logic::clamp_rect(&logic::Rect { x, y, w, h }, gw, gh).ok_or("the region is off the screen")?;
            const ALL_PLANES: c_ulong = !0;
            const ZPIXMAP: c_int = 2;
            let img = (l.get_image)(c.1, root, rect.x, rect.y, rect.w, rect.h, ALL_PLANES, ZPIXMAP);
            if img.is_null() {
                return Err("XGetImage gave nothing".into());
            }
            let im = &*img;
            let res = if im.data.is_null() {
                Err("XGetImage gave no pixels".to_string())
            } else {
                let len = im.bytes_per_line as usize * im.height as usize;
                let data = std::slice::from_raw_parts(im.data as *const u8, len);
                logic::ximage_to_rgba(data, im.width as u32, im.height as u32, im.bytes_per_line as usize, im.bits_per_pixel as u32, im.byte_order == 1, (im.red_mask as u64, im.green_mask as u64, im.blue_mask as u64))
                    .map(|px| (px, im.width as u32, im.height as u32))
            };
            // (XDestroyImage is a macro over the image's own destroy function.)
            match im.f.destroy_image {
                Some(d) => {
                    d(img);
                }
                None => {
                    if !im.data.is_null() {
                        (l.free)(im.data as *mut c_void);
                    }
                    (l.free)(img as *mut c_void);
                }
            }
            res
        }
    }

    pub fn cursor() -> Option<(f64, f64)> {
        let c = connect().ok()?;
        let l = c.0;
        unsafe {
            let root = (l.root)(c.1);
            let (mut rr, mut ch, mut rx, mut ry, mut wx, mut wy, mut m) = (0 as c_ulong, 0 as c_ulong, 0 as c_int, 0 as c_int, 0 as c_int, 0 as c_int, 0 as c_uint);
            if (l.pointer)(c.1, root, &mut rr, &mut ch, &mut rx, &mut ry, &mut wx, &mut wy, &mut m) != 0 {
                Some((rx as f64, ry as f64))
            } else {
                None
            }
        }
    }
}

/* ---------- Linux, Wayland: the desktop portal's Screenshot through gdbus ---------- */

#[cfg(all(unix, not(target_os = "macos")))]
fn portal_shot() -> Result<Pic, String> {
    use std::sync::mpsc;
    let token = format!("kt{}x{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    // (The monitor started first, so the answer cannot come before it listens; its first line says it is listening.)
    let (tx, rx) = mpsc::channel::<String>();
    let mon = crate::vtproc::spawn_lines(
        Path::new("gdbus"),
        &["monitor".to_string(), "--session".to_string(), "--dest".to_string(), "org.freedesktop.portal.Desktop".to_string()],
        4096,
        move |l| {
            let _ = tx.send(l.to_string());
        },
    )?;
    let pid = mon.pid;
    let out = (|| -> Result<Pic, String> {
        let _ = rx.recv_timeout(Duration::from_secs(5));
        let args: Vec<String> = vec![
            "call".into(),
            "--session".into(),
            "--dest".into(),
            "org.freedesktop.portal.Desktop".into(),
            "--object-path".into(),
            "/org/freedesktop/portal/desktop".into(),
            "--method".into(),
            "org.freedesktop.portal.Screenshot.Screenshot".into(),
            "".into(),
            logic::portal_options(&token),
        ];
        let r = crate::vtproc::run(Path::new("gdbus"), &args, Duration::from_secs(20), 1 << 16)?;
        let text = String::from_utf8_lossy(&r.out).into_owned();
        let path = logic::portal_request_path(&text).ok_or_else(|| format!("the screenshot portal did not answer: {}", r.err.trim().chars().take(200).collect::<String>()))?;
        // (Up to a minute: the system may ask the user first.)
        let until = std::time::Instant::now() + Duration::from_secs(60);
        loop {
            let left = until.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                return Err("the screenshot portal gave no picture within a minute".into());
            }
            match rx.recv_timeout(left) {
                Ok(line) => match logic::portal_response(&line, &path) {
                    Some(Ok(uri)) => {
                        let f = logic::file_uri_path(&uri).ok_or("the portal's picture is not a file")?;
                        let pic = read_png(Path::new(&f));
                        // (The picture the portal saved for us — in the Pictures folder, often — removed again.)
                        let _ = std::fs::remove_file(&f);
                        return pic;
                    }
                    Some(Err(code)) => return Err(format!("the screenshot was refused or cancelled (portal answer {})", code)),
                    None => {}
                },
                Err(_) => return Err("the screenshot portal gave no picture within a minute".into()),
            }
        }
    })();
    crate::vtproc::kill_tree(pid);
    let _ = mon.wait();
    out
}

/* ---------- macOS: the Screen Recording permission (CoreGraphics, looked up at run time) ---------- */

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::{c_void, CString};
    use std::sync::OnceLock;

    struct Fns {
        preflight: Option<unsafe extern "C" fn() -> bool>,
        request: Option<unsafe extern "C" fn() -> bool>,
    }
    static FNS: OnceLock<Fns> = OnceLock::new();

    fn fns() -> &'static Fns {
        FNS.get_or_init(|| unsafe {
            let path = CString::new("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics").unwrap_or_default();
            let h = libc::dlopen(path.as_ptr(), libc::RTLD_LAZY);
            let sym = |n: &str| -> *mut c_void {
                if h.is_null() {
                    return std::ptr::null_mut();
                }
                match CString::new(n) {
                    Ok(c) => libc::dlsym(h, c.as_ptr()),
                    Err(_) => std::ptr::null_mut(),
                }
            };
            let p = sym("CGPreflightScreenCaptureAccess");
            let r = sym("CGRequestScreenCaptureAccess");
            Fns {
                preflight: if p.is_null() { None } else { Some(std::mem::transmute::<*mut c_void, unsafe extern "C" fn() -> bool>(p)) },
                request: if r.is_null() { None } else { Some(std::mem::transmute::<*mut c_void, unsafe extern "C" fn() -> bool>(r)) },
            }
        })
    }

    /// Some(granted) on macOS 10.15+, None before (no permission there).
    pub fn preflight() -> Option<bool> {
        fns().preflight.map(|f| unsafe { f() })
    }

    pub fn request() -> bool {
        match fns().request {
            Some(f) => unsafe { f() },
            None => true,
        }
    }
}
