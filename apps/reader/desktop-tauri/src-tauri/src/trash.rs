// A linked book's original moved to the system's bin (the library's «Also delete the file from the computer»:
// src/devicefiles.ts → bridge.js trashFile → commands.rs kr_trash_file; Electron's is shell.trashItem). Never an
// erase: when the bin cannot take the file, an error is returned and the file is left where it is.
//  - Windows: SHFileOperationW with FOF_ALLOWUNDO (the Recycle Bin), no dialogs.
//  - macOS: the system's `trash` command where there is one (macOS 15), else the Finder asked through osascript
//    (the first time, macOS may ask the reader to let the app control the Finder).
//  - Linux and the other Unixes: `gio trash`, else the freedesktop.org Trash of the home folder written by hand (a
//    rename into ~/.local/share/Trash/files with its .trashinfo — the same disk only).
use std::path::Path;

#[cfg(windows)]
pub fn to_trash(p: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[repr(C)]
    #[allow(non_snake_case)]
    struct SHFILEOPSTRUCTW {
        hwnd: *mut std::ffi::c_void,
        wFunc: u32,
        pFrom: *const u16,
        pTo: *const u16,
        fFlags: u16,
        fAnyOperationsAborted: i32,
        hNameMappings: *mut std::ffi::c_void,
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
    let abs = std::fs::canonicalize(p).map_err(|e| e.to_string())?;
    // (canonicalize gives a \\?\ path, which the shell's file operations do not take.)
    let s = abs.to_string_lossy().to_string();
    let plain = s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();
    // (Two NULs at the end: pFrom is a list.)
    let from: Vec<u16> = std::ffi::OsStr::new(&plain).encode_wide().chain([0u16, 0u16]).collect();
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
    if r != 0 || op.fAnyOperationsAborted != 0 {
        return Err(format!("the Recycle Bin did not take it (code {r})"));
    }
    if Path::new(&plain).exists() {
        return Err("the file is still there".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn to_trash(p: &Path) -> Result<(), String> {
    use std::process::Command;
    let abs = std::fs::canonicalize(p).map_err(|e| e.to_string())?;
    if Path::new("/usr/bin/trash").exists() {
        let st = Command::new("/usr/bin/trash").arg(&abs).status().map_err(|e| e.to_string())?;
        if st.success() && !abs.exists() {
            return Ok(());
        }
    }
    let quoted = abs.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("tell application \"Finder\" to delete POSIX file \"{quoted}\"");
    let out = Command::new("osascript").arg("-e").arg(script).output().map_err(|e| e.to_string())?;
    if out.status.success() && !abs.exists() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn to_trash(p: &Path) -> Result<(), String> {
    use std::process::Command;
    let abs = std::fs::canonicalize(p).map_err(|e| e.to_string())?;
    if let Ok(st) = Command::new("gio").arg("trash").arg(&abs).status() {
        if st.success() && !abs.exists() {
            return Ok(());
        }
    }
    freedesktop(&abs)
}

/// The home folder's Trash, as the freedesktop.org specification has it: the file renamed into Trash/files, its
/// original path and the time in Trash/info/<name>.trashinfo.
#[cfg(all(unix, not(target_os = "macos")))]
fn freedesktop(abs: &Path) -> Result<(), String> {
    use std::io::Write;
    let data = std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()).map(std::path::PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| Path::new(&h).join(".local/share"))).ok_or("no home folder")?;
    let trash = data.join("Trash");
    let (files, info) = (trash.join("files"), trash.join("info"));
    std::fs::create_dir_all(&files).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&info).map_err(|e| e.to_string())?;
    let base = abs.file_name().ok_or("no file name")?.to_string_lossy().to_string();
    let mut name = base.clone();
    let mut n = 1;
    // (A name not taken: the .trashinfo made first, exclusively, so two at once never share one.)
    let mut info_file = loop {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(info.join(format!("{name}.trashinfo"))) {
            Ok(f) if !files.join(&name).exists() => break f,
            Ok(_) => { let _ = std::fs::remove_file(info.join(format!("{name}.trashinfo"))); }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.to_string()),
        }
        n += 1;
        name = format!("{base}.{n}");
        if n > 9999 { return Err("no free name in the Trash".into()); }
    };
    let enc: String = abs.to_string_lossy().bytes().map(|b| if b.is_ascii_alphanumeric() || b"/-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    let text = format!("[Trash Info]\nPath={enc}\nDeletionDate={}\n", local_now());
    let info_path = info.join(format!("{name}.trashinfo"));
    if let Err(e) = info_file.write_all(text.as_bytes()) {
        let _ = std::fs::remove_file(&info_path);
        return Err(e.to_string());
    }
    drop(info_file);
    if let Err(e) = std::fs::rename(abs, files.join(&name)) {
        let _ = std::fs::remove_file(&info_path);
        return Err(format!("not on the home folder's disk: {e}"));
    }
    Ok(())
}

/// The local time as YYYY-MM-DDThh:mm:ss (libc's localtime_r: no other crate).
#[cfg(all(unix, not(target_os = "macos")))]
fn local_now() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as libc::time_t).unwrap_or(0);
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&now, &mut tm) };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec)
}

#[cfg(not(any(unix, windows)))]
pub fn to_trash(_p: &Path) -> Result<(), String> {
    Err("no bin on this system".into())
}
