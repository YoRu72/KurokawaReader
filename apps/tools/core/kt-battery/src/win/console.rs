// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Windows' side of the command line (../cli.rs) — where the text goes, and
// the system's version number. kernel32 and ntdll declared here by hand (raw-dylib), no crate.
// The program is a GUI-subsystem program: Windows gives it no console. Where its output goes:
//  1. its standard output handle is a file or a pipe (the user redirected it): used as it is, UTF-8;
//  2. it is a console's handle: used, but written as ASCII (the console reads raw bytes in its own code page);
//  3. there is none: the parent's console is attached (AttachConsole with ATTACH_PARENT_PROCESS) and «CONOUT$» opened,
//     written as ASCII;
//  4. no parent console either (started from the Start menu or Explorer): nothing is written, and nothing fails.
// A prompt does not wait for a GUI-subsystem program, so its own prompt may come back before the text (the help says
// to redirect, pipe or `start /wait`).
// UNVERIFIED here: compiled only on Windows (type-checked elsewhere, stdroots/wincheck.rs); no Windows machine was used.
// Copyright (C) 2026 Kurokawa contributors.
#![allow(non_snake_case, clippy::upper_case_acronyms)]
use std::io::Write;

/// STD_OUTPUT_HANDLE (-11) and ATTACH_PARENT_PROCESS (-1) as the unsigned words Windows takes.
const STD_OUTPUT_HANDLE: u32 = 0xFFFF_FFF5;
const ATTACH_PARENT_PROCESS: u32 = 0xFFFF_FFFF;

#[repr(C)]
struct OSVERSIONINFOW {
    dwOSVersionInfoSize: u32,
    dwMajorVersion: u32,
    dwMinorVersion: u32,
    dwBuildNumber: u32,
    dwPlatformId: u32,
    szCSDVersion: [u16; 128],
}

#[cfg_attr(windows, link(name = "kernel32", kind = "raw-dylib"))]
extern "system" {
    fn AttachConsole(dwProcessId: u32) -> i32;
    fn GetStdHandle(nStdHandle: u32) -> isize;
    fn GetConsoleMode(hConsoleHandle: isize, lpMode: *mut u32) -> i32;
}

#[cfg_attr(windows, link(name = "ntdll", kind = "raw-dylib"))]
extern "system" {
    fn RtlGetVersion(lpVersionInformation: *mut OSVERSIONINFOW) -> i32;
}

/// Where the text goes, and whether it must be written as ASCII only (a console).
pub struct Output {
    pub to: Box<dyn Write>,
    pub ascii: bool,
}

pub fn open_output() -> Output {
    // (A GUI-subsystem program's standard handle is 0 when it was given none, -1 when it is invalid.)
    let h = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    if h != 0 && h != -1 {
        let mut mode = 0u32;
        let console = unsafe { GetConsoleMode(h, &mut mode) } != 0;
        return Output { to: Box::new(std::io::stdout()), ascii: console };
    }
    if unsafe { AttachConsole(ATTACH_PARENT_PROCESS) } != 0 {
        if let Ok(f) = std::fs::OpenOptions::new().write(true).open("CONOUT$") {
            return Output { to: Box::new(f), ascii: true };
        }
    }
    Output { to: Box::new(std::io::sink()), ascii: false }
}

/// Windows' own version number (major, minor, build) — RtlGetVersion, which tells the truth where GetVersionEx lies to
/// programs without a manifest.
pub fn os_version() -> Option<(u32, u32, u32)> {
    let mut v = OSVERSIONINFOW { dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32, dwMajorVersion: 0, dwMinorVersion: 0, dwBuildNumber: 0, dwPlatformId: 0, szCSDVersion: [0; 128] };
    if unsafe { RtlGetVersion(&mut v) } == 0 {
        Some((v.dwMajorVersion, v.dwMinorVersion, v.dwBuildNumber))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_version_struct_has_the_sdks_size() {
        // (winnt.h's OSVERSIONINFOW: five words and 128 wide characters.)
        assert_eq!(std::mem::size_of::<OSVERSIONINFOW>(), 5 * 4 + 128 * 2);
        assert_eq!(STD_OUTPUT_HANDLE as i32, -11);
        assert_eq!(ATTACH_PARENT_PROCESS as i32, -1);
    }
}
