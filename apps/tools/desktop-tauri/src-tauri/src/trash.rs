// A file or folder put in the system's recycle bin — Electron's shell.trashItem, for kt:deletePath — with no crate:
//  - Windows: SHFileOperationW with FOF_ALLOWUNDO (shell32, as every program that sends to the Recycle Bin);
//  - macOS: NSFileManager's trashItemAtURL (the Objective-C runtime called directly; Foundation linked);
//  - Linux and the other Unixes: the freedesktop.org Trash specification 1.0 — the file renamed into the home's
//    trash ($XDG_DATA_HOME/Trash, else ~/.local/share/Trash) when it is on the same disk, else into its disk's own
//    ($topdir/.Trash/$uid when an administrator made one, else $topdir/.Trash-$uid), with its «.trashinfo» written
//    first (created exclusively, so two deletes never take the same name), its DeletionDate in local time as the
//    specification says, as file managers read them back.
// Std only (the system calls declared here), the Linux part checked alone: `rustc --edition 2021 --test trash.rs`.
// (The specification's helpers are used on Linux only: on Windows and macOS they stay for the tests — no warnings.)
#![allow(dead_code, unused_imports)]
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// `p` to the recycle bin; an error when the system would not take it there (the caller decides what then).
pub fn trash(p: &Path) -> Result<(), String> {
    if fs::symlink_metadata(p).is_err() {
        return Err(format!("not found: {}", p.display()));
    }
    imp::trash(p)
}

/* ---------- Windows ---------- */

#[cfg(windows)]
mod imp {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct SHFILEOPSTRUCTW {
        hwnd: *mut core::ffi::c_void,
        wFunc: u32,
        pFrom: *const u16,
        pTo: *const u16,
        fFlags: u16,
        fAnyOperationsAborted: i32,
        hNameMappings: *mut core::ffi::c_void,
        lpszProgressTitle: *const u16,
    }
    #[link(name = "shell32")]
    extern "system" {
        fn SHFileOperationW(op: *mut SHFILEOPSTRUCTW) -> i32;
    }
    const FO_DELETE: u32 = 3;
    const FOF_SILENT: u16 = 0x0004;
    const FOF_NOCONFIRMATION: u16 = 0x0010;
    const FOF_ALLOWUNDO: u16 = 0x0040;
    const FOF_NOERRORUI: u16 = 0x0400;

    pub fn trash(p: &Path) -> Result<(), String> {
        // (A full path, its «\\?\» taken off — the shell does not take it —, ended by two NULs.)
        let full = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        let s = full.to_string_lossy().into_owned();
        let s = s.strip_prefix(r"\\?\UNC\").map(|x| format!(r"\\{}", x)).unwrap_or_else(|| s.strip_prefix(r"\\?\").unwrap_or(&s).to_string());
        let mut from: Vec<u16> = std::ffi::OsStr::new(&s).encode_wide().collect();
        from.push(0);
        from.push(0);
        let mut op = SHFILEOPSTRUCTW {
            hwnd: std::ptr::null_mut(),
            wFunc: FO_DELETE,
            pFrom: from.as_ptr(),
            pTo: std::ptr::null(),
            fFlags: FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI,
            fAnyOperationsAborted: 0,
            hNameMappings: std::ptr::null_mut(),
            lpszProgressTitle: std::ptr::null(),
        };
        let r = unsafe { SHFileOperationW(&mut op) };
        if r != 0 {
            return Err(format!("the Recycle Bin refused it (0x{:x})", r));
        }
        if op.fAnyOperationsAborted != 0 {
            return Err("cancelled".to_string());
        }
        if std::fs::symlink_metadata(p).is_ok() {
            return Err("still there".to_string());
        }
        Ok(())
    }
}

/* ---------- macOS ---------- */

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::{c_void, CString};
    use std::path::Path;

    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const std::os::raw::c_char) -> *mut c_void;
        fn sel_registerName(name: *const std::os::raw::c_char) -> *mut c_void;
        fn objc_msgSend();
        fn objc_autoreleasePoolPush() -> *mut c_void;
        fn objc_autoreleasePoolPop(pool: *mut c_void);
    }
    #[link(name = "Foundation", kind = "framework")]
    extern "C" {}

    fn sel(name: &str) -> *mut c_void {
        let c = CString::new(name).unwrap_or_default();
        unsafe { sel_registerName(c.as_ptr()) }
    }
    fn class(name: &str) -> *mut c_void {
        let c = CString::new(name).unwrap_or_default();
        unsafe { objc_getClass(c.as_ptr()) }
    }

    pub fn trash(p: &Path) -> Result<(), String> {
        let full = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        let c = CString::new(full.to_string_lossy().into_owned()).map_err(|_| "a NUL in the path".to_string())?;
        unsafe {
            // (objc_msgSend called through a pointer of each message's own type, as the runtime requires on arm64.)
            let send_ptr: extern "C" fn(*mut c_void, *mut c_void, *const std::os::raw::c_char) -> *mut c_void =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let send_obj: extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> *mut c_void =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let send0: extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let send_trash: extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *mut c_void, *mut c_void) -> u8 =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let pool = objc_autoreleasePoolPush();
            let ns = class("NSString");
            let url_class = class("NSURL");
            let fm_class = class("NSFileManager");
            let mut ok = false;
            if !ns.is_null() && !url_class.is_null() && !fm_class.is_null() {
                let s = send_ptr(ns, sel("stringWithUTF8String:"), c.as_ptr());
                let url = if s.is_null() { std::ptr::null_mut() } else { send_obj(url_class, sel("fileURLWithPath:"), s) };
                let fm = send0(fm_class, sel("defaultManager"));
                if !url.is_null() && !fm.is_null() {
                    ok = send_trash(fm, sel("trashItemAtURL:resultingItemURL:error:"), url, std::ptr::null_mut(), std::ptr::null_mut()) != 0;
                }
            }
            objc_autoreleasePoolPop(pool);
            if ok {
                Ok(())
            } else {
                Err("the Trash refused it".to_string())
            }
        }
    }
}

/* ---------- Linux and the other Unixes: the freedesktop.org specification ---------- */

#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    use std::path::Path;

    pub fn trash(p: &Path) -> Result<(), String> {
        let home_trash = super::home_trash().ok_or_else(|| "no home folder".to_string())?;
        // (The specification's DeletionDate is the local time, as file managers show it.)
        super::trash_into(p, &home_trash, super::local_secs(super::now_utc_secs()))
    }
}

#[cfg(not(any(unix, windows)))]
mod imp {
    pub fn trash(_p: &std::path::Path) -> Result<(), String> {
        Err("no recycle bin on this system".to_string())
    }
}

/// The home's trash: $XDG_DATA_HOME/Trash, else ~/.local/share/Trash.
#[allow(dead_code)]
pub fn home_trash() -> Option<PathBuf> {
    if let Some(x) = std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
        let p = PathBuf::from(x);
        if p.is_absolute() {
            return Some(p.join("Trash"));
        }
    }
    let home = std::env::var_os("HOME").filter(|v| !v.is_empty())?;
    Some(PathBuf::from(home).join(".local").join("share").join("Trash"))
}

#[allow(dead_code)]
pub fn now_utc_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The local clock's reading at `utc` (seconds since 1970), as seconds since 1970 again — what date_text() then writes
/// as the local date and time (the Trash specification's DeletionDate is in local time). The C library's localtime_r
/// gives the offset (its `tm_gmtoff`, which glibc, musl and the BSDs have, right after the nine ints); unknown → UTC.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn local_secs(utc: u64) -> u64 {
    #[repr(C)]
    struct Tm {
        ints: [std::os::raw::c_int; 9],
        gmtoff: std::os::raw::c_long,
        zone: *const std::os::raw::c_char,
    }
    extern "C" {
        fn tzset();
        fn localtime_r(t: *const i64, out: *mut Tm) -> *mut Tm;
    }
    // (time_t is 64 bits on the 64-bit systems this is built for; elsewhere UTC is kept rather than guessed.)
    if std::mem::size_of::<usize>() != 8 {
        return utc;
    }
    let t: i64 = utc as i64;
    let mut tm = Tm { ints: [0; 9], gmtoff: 0, zone: std::ptr::null() };
    let r = unsafe {
        tzset();
        localtime_r(&t, &mut tm)
    };
    if r.is_null() {
        return utc;
    }
    let off = tm.gmtoff as i64;
    if off.abs() > 18 * 3600 {
        return utc;
    }
    (t + off).max(0) as u64
}

/// A path as the specification writes it in «Path=»: each byte outside the URI's unreserved set and «/» as %XX.
pub fn escape_path(p: &str) -> String {
    let mut o = String::with_capacity(p.len());
    for &b in p.as_bytes() {
        let keep = b.is_ascii_alphanumeric() || b"-_.!~*'()/".contains(&b);
        if keep {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{:02X}", b));
        }
    }
    o
}

/// Seconds since 1970 (UTC) as «YYYY-MM-DDThh:mm:ss».
pub fn date_text(secs: u64) -> String {
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    // (Howard Hinnant's civil-from-days.)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}", y, m, d, rem / 3600, (rem / 60) % 60, rem % 60)
}

/// The «.trashinfo» of a file deleted from `path` at `secs`.
pub fn info_text(path: &str, secs: u64) -> String {
    format!("[Trash Info]\nPath={}\nDeletionDate={}\n", escape_path(path), date_text(secs))
}

/// The n-th name tried for `name` in a trash: itself, then «stem (2).ext», «stem (3).ext» …
pub fn nth_name(name: &str, n: u32) -> String {
    if n <= 1 {
        return name.to_string();
    }
    match name.rfind('.') {
        Some(i) if i > 0 => format!("{} ({}){}", &name[..i], n, &name[i..]),
        _ => format!("{} ({})", name, n),
    }
}

#[cfg(unix)]
fn dev_of(p: &Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    fs::symlink_metadata(p).ok().map(|m| m.dev())
}

#[cfg(unix)]
fn uid_of(p: &Path) -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(p).ok().map(|m| m.uid())
}

/// The highest folder above `p` on the same disk (its mount point).
#[cfg(unix)]
fn top_dir(p: &Path) -> PathBuf {
    let dev = dev_of(p);
    let mut top = p.parent().unwrap_or(p).to_path_buf();
    while let Some(up) = top.parent() {
        if dev_of(up) != dev {
            break;
        }
        top = up.to_path_buf();
    }
    top
}

/// The trash folder a file on another disk than the home goes to: $topdir/.Trash/$uid when an administrator made
/// .Trash (a real folder, sticky), else $topdir/.Trash-$uid (made here, for this user only).
#[cfg(unix)]
fn disk_trash(p: &Path, uid: u32) -> Option<PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let top = top_dir(p);
    let shared = top.join(".Trash");
    if let Ok(m) = fs::symlink_metadata(&shared) {
        if m.is_dir() && !m.file_type().is_symlink() && m.permissions().mode() & 0o1000 != 0 {
            let mine = shared.join(uid.to_string());
            if fs::DirBuilder::new().recursive(true).mode(0o700).create(&mine).is_ok() {
                return Some(mine);
            }
        }
    }
    let own = top.join(format!(".Trash-{}", uid));
    if fs::DirBuilder::new().recursive(true).mode(0o700).create(&own).is_ok() {
        return Some(own);
    }
    None
}

/// `p` moved into a trash folder (`home_trash` when on its disk, else its disk's own), its info written first.
#[cfg(unix)]
pub fn trash_into(p: &Path, home_trash: &Path, secs: u64) -> Result<(), String> {
    let full = if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().map_err(|e| e.to_string())?.join(p) };
    let name = full.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or_else(|| "not a file or folder".to_string())?;
    let _ = fs::create_dir_all(home_trash.join("files"));
    let _ = fs::create_dir_all(home_trash.join("info"));
    let trash = if dev_of(&full).is_some() && dev_of(&full) == dev_of(home_trash) {
        home_trash.to_path_buf()
    } else {
        let uid = uid_of(home_trash.parent().unwrap_or(home_trash)).or_else(|| uid_of(&full)).unwrap_or(0);
        disk_trash(&full, uid).ok_or_else(|| "no trash on that disk".to_string())?
    };
    fs::create_dir_all(trash.join("files")).map_err(|e| e.to_string())?;
    fs::create_dir_all(trash.join("info")).map_err(|e| e.to_string())?;
    for n in 1..10000u32 {
        let pick = nth_name(&name, n);
        let info = trash.join("info").join(format!("{}.trashinfo", pick));
        let dest = trash.join("files").join(&pick);
        if fs::symlink_metadata(&dest).is_ok() {
            continue;
        }
        let made = fs::OpenOptions::new().write(true).create_new(true).open(&info);
        let mut fh = match made {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        };
        let text = info_text(&full.to_string_lossy(), secs);
        if let Err(e) = fh.write_all(text.as_bytes()).and_then(|_| fh.flush()) {
            let _ = fs::remove_file(&info);
            return Err(e.to_string());
        }
        drop(fh);
        return match fs::rename(&full, &dest) {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = fs::remove_file(&info);
                Err(e.to_string())
            }
        };
    }
    Err("no free name in the trash".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn texts() {
        assert_eq!(escape_path("/home/u/a b/\u{645}.txt"), "/home/u/a%20b/%D9%85.txt");
        assert_eq!(escape_path("/x/(1)!~*'.-_"), "/x/(1)!~*'.-_");
        assert_eq!(date_text(0), "1970-01-01T00:00:00");
        assert_eq!(date_text(1_700_000_000), "2023-11-14T22:13:20");
        assert_eq!(date_text(951_782_400), "2000-02-29T00:00:00");
        assert_eq!(info_text("/a b", 0), "[Trash Info]\nPath=/a%20b\nDeletionDate=1970-01-01T00:00:00\n");
        assert_eq!(nth_name("a.txt", 1), "a.txt");
        assert_eq!(nth_name("a.txt", 2), "a (2).txt");
        assert_eq!(nth_name(".hidden", 3), ".hidden (3)");
        assert_eq!(nth_name("Folder", 2), "Folder (2)");
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn local_time() {
        // (The offset localtime_r gives: within a day of UTC, a whole number of minutes; with TZ=UTC none.)
        let t = 1_700_000_000u64;
        let l = local_secs(t) as i64 - t as i64;
        assert!(l.abs() <= 18 * 3600 && l % 60 == 0, "offset {}", l);
        let was = std::env::var_os("TZ");
        std::env::set_var("TZ", "UTC");
        assert_eq!(local_secs(t), t);
        std::env::set_var("TZ", "UTC-3");
        assert_eq!(local_secs(t), t + 3 * 3600, "TZ=UTC-3 is three hours ahead");
        assert_eq!(date_text(local_secs(t)), "2023-11-15T01:13:20");
        match was {
            Some(v) => std::env::set_var("TZ", v),
            None => std::env::remove_var("TZ"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn freedesktop() {
        let root = std::env::temp_dir().join(format!("kt-trash-{}", std::process::id()));
        let home_trash = root.join("data").join("Trash");
        fs::create_dir_all(&root).unwrap();
        let a = root.join("a b.txt");
        fs::write(&a, b"A").unwrap();
        trash_into(&a, &home_trash, 1_700_000_000).unwrap();
        assert!(!a.exists());
        assert_eq!(fs::read(home_trash.join("files").join("a b.txt")).unwrap(), b"A");
        let info = fs::read_to_string(home_trash.join("info").join("a b.txt.trashinfo")).unwrap();
        assert_eq!(info, format!("[Trash Info]\nPath={}\nDeletionDate=2023-11-14T22:13:20\n", escape_path(&a.to_string_lossy())));
        // (A second of that name: the next free one, both kept.)
        fs::write(&a, b"A2").unwrap();
        trash_into(&a, &home_trash, 1_700_000_001).unwrap();
        assert_eq!(fs::read(home_trash.join("files").join("a b (2).txt")).unwrap(), b"A2");
        assert!(home_trash.join("info").join("a b (2).txt.trashinfo").exists());
        // (A folder, whole.)
        let d = root.join("D");
        fs::create_dir_all(d.join("sub")).unwrap();
        fs::write(d.join("sub").join("x"), b"X").unwrap();
        trash_into(&d, &home_trash, 0).unwrap();
        assert_eq!(fs::read(home_trash.join("files").join("D").join("sub").join("x")).unwrap(), b"X");
        assert!(trash_into(&root.join("none"), &home_trash, 0).is_err());
        // (On another disk — /dev/shm here —: its own .Trash-<uid> at the top of that disk.)
        let shm = Path::new("/dev/shm");
        if shm.is_dir() && dev_of(shm) != dev_of(&root) {
            let f = shm.join(format!("kt-trash-{}.bin", std::process::id()));
            fs::write(&f, b"S").unwrap();
            trash_into(&f, &home_trash, 0).unwrap();
            assert!(!f.exists());
            let uid = uid_of(&root.join("data")).unwrap();
            let t = top_dir(&shm.join("x"));
            let got = t.join(format!(".Trash-{}", uid)).join("files").join(f.file_name().unwrap());
            assert_eq!(fs::read(&got).unwrap(), b"S");
            let _ = fs::remove_file(&got);
            let _ = fs::remove_file(t.join(format!(".Trash-{}", uid)).join("info").join(format!("{}.trashinfo", f.file_name().unwrap().to_string_lossy())));
            // (The test's trash folders taken away again when nothing else is in them.)
            for sub in ["files", "info", ""] {
                let _ = fs::remove_dir(t.join(format!(".Trash-{}", uid)).join(sub));
            }
        }
        let _ = fs::remove_dir_all(&root);
    }
}
