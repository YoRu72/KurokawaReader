// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the one registry value «start with Windows, hidden» uses —
// HKCU\Software\Microsoft\Windows\CurrentVersion\Run\«Kurokawa Tools Device battery» (../autostart.rs RUN_VALUE) —
// read, written and removed through advapi32 declared here (raw-dylib), no reg.exe and no crate. Nothing else in the
// registry is ever touched: the key and the value's name are constants of this file and ../autostart.rs.
// Derived from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor), src/main.cpp
// (SetAutostart / AutostartEnabled) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its
// contributors, GPL-3.0-or-later. Changed here: the value has its own name and the --hidden flag; it is written only
// when it differs from what is there.
// UNVERIFIED here: compiled only on Windows (type-checked elsewhere, stdroots/wincheck.rs).
// Copyright (C) 2026 Kurokawa contributors.
#![allow(non_snake_case, clippy::upper_case_acronyms)]
use crate::autostart::{run_command, run_is_ours, RUN_VALUE};

type HKEY = isize;
type LSTATUS = i32;

/// HKEY_CURRENT_USER: ((HKEY)(ULONG_PTR)((LONG)0x80000001)), sign-extended.
const HKEY_CURRENT_USER: HKEY = 0x8000_0001u32 as i32 as isize;
const KEY_QUERY_VALUE: u32 = 0x0001;
const KEY_SET_VALUE: u32 = 0x0002;
const REG_SZ: u32 = 1;
const REG_EXPAND_SZ: u32 = 2;
const ERROR_SUCCESS: LSTATUS = 0;
const ERROR_FILE_NOT_FOUND: LSTATUS = 2;
const ERROR_MORE_DATA: LSTATUS = 234;
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg_attr(windows, link(name = "advapi32", kind = "raw-dylib"))]
extern "system" {
    fn RegOpenKeyExW(hKey: HKEY, lpSubKey: *const u16, ulOptions: u32, samDesired: u32, phkResult: *mut HKEY) -> LSTATUS;
    fn RegCreateKeyExW(hKey: HKEY, lpSubKey: *const u16, Reserved: u32, lpClass: *const u16, dwOptions: u32, samDesired: u32, lpSecurityAttributes: *const core::ffi::c_void, phkResult: *mut HKEY, lpdwDisposition: *mut u32) -> LSTATUS;
    fn RegQueryValueExW(hKey: HKEY, lpValueName: *const u16, lpReserved: *mut u32, lpType: *mut u32, lpData: *mut u8, lpcbData: *mut u32) -> LSTATUS;
    fn RegSetValueExW(hKey: HKEY, lpValueName: *const u16, Reserved: u32, dwType: u32, lpData: *const u8, cbData: u32) -> LSTATUS;
    fn RegDeleteValueW(hKey: HKEY, lpValueName: *const u16) -> LSTATUS;
    fn RegCloseKey(hKey: HKEY) -> LSTATUS;
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The Run key opened (created when missing, as a fresh profile may lack it), closed when dropped.
struct Key(HKEY);

impl Key {
    fn open(write: bool) -> Result<Option<Key>, String> {
        let path = wide(RUN_KEY);
        let mut k: HKEY = 0;
        // SAFETY: the path is a NUL-ended UTF-16 string that outlives the call; `k` receives the handle.
        let rc = unsafe {
            if write {
                RegCreateKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, std::ptr::null(), 0, KEY_QUERY_VALUE | KEY_SET_VALUE, std::ptr::null(), &mut k, std::ptr::null_mut())
            } else {
                RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, KEY_QUERY_VALUE, &mut k)
            }
        };
        match rc {
            ERROR_SUCCESS => Ok(Some(Key(k))),
            ERROR_FILE_NOT_FOUND if !write => Ok(None),
            e => Err(format!("the Run key could not be opened (error {e})")),
        }
    }
}

impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: a handle this struct opened, closed once.
        unsafe {
            RegCloseKey(self.0);
        }
    }
}

/// The value's data, None when there is none.
pub fn read() -> Result<Option<String>, String> {
    let Some(k) = Key::open(false)? else { return Ok(None) };
    let name = wide(RUN_VALUE);
    let mut buf: Vec<u16> = vec![0; 1024];
    for _ in 0..2 {
        let mut ty: u32 = 0;
        let mut cb: u32 = (buf.len() * 2) as u32;
        // SAFETY: `buf` holds `cb` bytes; the name is NUL-ended.
        let rc = unsafe { RegQueryValueExW(k.0, name.as_ptr(), std::ptr::null_mut(), &mut ty, buf.as_mut_ptr() as *mut u8, &mut cb) };
        match rc {
            ERROR_SUCCESS => {
                if ty != REG_SZ && ty != REG_EXPAND_SZ {
                    return Ok(Some(String::new()));
                }
                let n = (cb as usize / 2).min(buf.len());
                let s = &buf[..n];
                let end = s.iter().position(|c| *c == 0).unwrap_or(s.len());
                return Ok(Some(String::from_utf16_lossy(&s[..end])));
            }
            ERROR_FILE_NOT_FOUND => return Ok(None),
            ERROR_MORE_DATA if cb as usize <= 64 * 1024 => buf = vec![0; cb as usize / 2 + 1],
            e => return Err(format!("the Run value could not be read (error {e})")),
        }
    }
    Err("the Run value is too long".to_string())
}

/// Set «"<exe>" --hidden» (only when it differs), or removed (the value's name is this feature's own, so an entry left
/// by an earlier place of the program goes too).
pub fn apply(on: bool, exe: &str) -> Result<(), String> {
    let cur = read()?;
    if on {
        let data = run_command(exe).ok_or("this program's path cannot be written to the Run key")?;
        if cur.as_deref().map_or(false, |c| run_is_ours(c, exe)) {
            return Ok(());
        }
        let k = Key::open(true)?.ok_or("the Run key could not be opened")?;
        let name = wide(RUN_VALUE);
        let w = wide(&data);
        // SAFETY: `w` is NUL-ended UTF-16 and its byte length (with the NUL) is passed, as REG_SZ wants.
        let rc = unsafe { RegSetValueExW(k.0, name.as_ptr(), 0, REG_SZ, w.as_ptr() as *const u8, (w.len() * 2) as u32) };
        if rc != ERROR_SUCCESS {
            return Err(format!("the Run value could not be written (error {rc})"));
        }
        Ok(())
    } else {
        match cur {
            None => Ok(()),
            Some(_) => {
                let k = Key::open(true)?.ok_or("the Run key could not be opened")?;
                let name = wide(RUN_VALUE);
                // SAFETY: the name is NUL-ended.
                let rc = unsafe { RegDeleteValueW(k.0, name.as_ptr()) };
                if rc != ERROR_SUCCESS && rc != ERROR_FILE_NOT_FOUND {
                    return Err(format!("the Run value could not be removed (error {rc})"));
                }
                Ok(())
            }
        }
    }
}

/// Whether the value is there and names this program.
pub fn is_on(exe: &str) -> bool {
    read().ok().flatten().map_or(false, |c| run_is_ours(&c, exe))
}
