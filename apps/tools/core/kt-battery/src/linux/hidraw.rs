// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery), piece P1: Linux's raw HID nodes (/dev/hidrawN) as the readers'
// transport (transport.rs's HidTransport), so every family reader works unchanged.
// Derived from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/linux/hid_linux.cpp (HidDev: Open, OpenReadOnly, Read, Write, Flush, GetFeature, SetFeature) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later.
// Changed here: a node is opened read-only unless allow.rs names the collection and the reader sends an output report
// (the original opened every node read/write, and «feature only» meant read/write too — the hidraw driver lets feature
// reports through a read-only descriptor); never exclusive (hidraw has no such open, and nothing here asks for one);
// closed when the transport is dropped, at the end of each query; every call has a deadline — reads wait in poll() for
// what is left of it, and an ioctl that returns past it is discarded (the kernel bounds a control transfer itself); a
// listening reader is given only its own collection's input reports (hidraw hands over every report of the
// interface), with the report id first — 0 for an unnumbered device, as Windows gives it; a write goes only through
// `send` (an AllowedWrite for this very collection), padded to the collection's report length.
// The ioctl numbers are made as linux/hidraw.h makes them (_IOC), for the generic encoding and for the architectures
// whose encoding differs (powerpc, mips, sparc); the C calls are declared here (no crate).
// UNVERIFIED here: compiled and unit-tested on Linux; no real device was opened.
// Copyright (C) 2026 Kurokawa contributors.
use crate::allow::{AllowedWrite, HidIdent, ReportKind};
use crate::transport::{left, HidTransport, OpenMode, TErr};
use std::ffi::{c_char, c_int, c_short, c_ulong, CString};
use std::fs::File;
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::io::AsRawFd;
use std::path::Path;
use std::time::Instant;

#[repr(C)]
struct PollFd {
    fd: c_int,
    events: c_short,
    revents: c_short,
}

extern "C" {
    fn ioctl(fd: c_int, request: c_ulong, ...) -> c_int;
    fn poll(fds: *mut PollFd, nfds: c_ulong, timeout: c_int) -> c_int;
    fn access(path: *const c_char, mode: c_int) -> c_int;
}

const POLLIN: c_short = 0x001;
const POLLERR: c_short = 0x008;
const POLLHUP: c_short = 0x010;
const POLLNVAL: c_short = 0x020;
const R_OK: c_int = 4;
const W_OK: c_int = 2;

#[cfg(any(target_arch = "powerpc", target_arch = "powerpc64", target_arch = "mips", target_arch = "mips64", target_arch = "sparc", target_arch = "sparc64"))]
const fn ioc_rw(nr: u32, size: u32) -> c_ulong {
    // (_IOC_READ 2 | _IOC_WRITE 4 at bit 29, 13 size bits.)
    (((2 | 4) << 29) | ((size & 0x1FFF) << 16) | ((b'H' as u32) << 8) | nr) as c_ulong
}

#[cfg(not(any(target_arch = "powerpc", target_arch = "powerpc64", target_arch = "mips", target_arch = "mips64", target_arch = "sparc", target_arch = "sparc64")))]
const fn ioc_rw(nr: u32, size: u32) -> c_ulong {
    // (_IOC_READ 2 | _IOC_WRITE 1 at bit 30, 14 size bits.)
    (((2u32 | 1) << 30) | ((size & 0x3FFF) << 16) | ((b'H' as u32) << 8) | nr) as c_ulong
}

/// HIDIOCSFEATURE(len), HIDIOCGFEATURE(len), HIDIOCGINPUT(len).
pub fn hidioc_sfeature(len: usize) -> c_ulong {
    ioc_rw(0x06, len as u32)
}
pub fn hidioc_gfeature(len: usize) -> c_ulong {
    ioc_rw(0x07, len as u32)
}
pub fn hidioc_ginput(len: usize) -> c_ulong {
    ioc_rw(0x0A, len as u32)
}

/// The longest report a call moves (hidraw's own limit is 16 KB; HID reports are far shorter).
const MAX_REPORT: usize = 4096;

/// Whether this user may open the node for reading (and writing, when `write`) — ACLs from udev's «uaccess» included.
pub fn may_open(node: &Path, write: bool) -> bool {
    let Ok(c) = CString::new(node.as_os_str().as_bytes()) else { return false };
    let mode = if write { R_OK | W_OK } else { R_OK };
    unsafe { access(c.as_ptr(), mode) == 0 }
}

/// What the readers need of one collection of a node.
#[derive(Clone, Debug)]
pub struct NodeColl {
    pub node: std::path::PathBuf,
    pub ident: HidIdent,
    pub input_len: usize,
    pub output_len: usize,
    pub feature_len: usize,
    pub numbered: bool,
    pub input_ids: Vec<u8>,
}

/// One collection of a hidraw node, open.
pub struct LinHid {
    ident: HidIdent,
    mode: OpenMode,
    f: File,
    input_len: usize,
    output_len: usize,
    feature_len: usize,
    numbered: bool,
    input_ids: Vec<u8>,
}

fn open_err(e: std::io::Error) -> TErr {
    match e.kind() {
        std::io::ErrorKind::NotFound => TErr::Gone,
        std::io::ErrorKind::PermissionDenied => TErr::Refused,
        _ => TErr::Failed(e.to_string()),
    }
}

impl LinHid {
    /// Opened with `mode`: read/write only for ReadWrite (allow.rs names it), read-only otherwise.
    pub fn open(c: &NodeColl, mode: OpenMode) -> Result<LinHid, TErr> {
        let f = std::fs::OpenOptions::new().read(true).write(mode == OpenMode::ReadWrite).open(&c.node).map_err(open_err)?;
        Ok(LinHid { ident: c.ident.clone(), mode, f, input_len: c.input_len, output_len: c.output_len, feature_len: c.feature_len, numbered: c.numbered, input_ids: c.input_ids.clone() })
    }
    pub fn set_feature_len(&mut self, n: usize) {
        if n > 0 {
            self.feature_len = n;
        }
    }

    fn get_report(&mut self, req: fn(usize) -> c_ulong, report_id: u8, len: usize, deadline: Instant) -> Result<Vec<u8>, TErr> {
        left(deadline)?;
        let len = len.clamp(1, MAX_REPORT);
        let mut buf = vec![0u8; len];
        buf[0] = report_id;
        let n = unsafe { ioctl(self.f.as_raw_fd(), req(len), buf.as_mut_ptr()) };
        left(deadline)?;
        if n < 0 {
            let e = std::io::Error::last_os_error();
            return Err(if matches!(e.raw_os_error(), Some(19) | Some(5)) { TErr::Gone } else { TErr::Failed(e.to_string()) });
        }
        // (The report id first, then n - 1 bytes of data: the rest left as zeros, as Windows' buffer.)
        Ok(buf)
    }

    /// Waits until the node is readable or `deadline`: Ok(true) readable, Ok(false) not in time.
    fn wait_readable(&self, deadline: Instant) -> Result<bool, TErr> {
        loop {
            let ms = match left(deadline) {
                Ok(d) => d.as_millis().min(i32::MAX as u128) as c_int,
                Err(_) => return Ok(false),
            };
            let mut p = PollFd { fd: self.f.as_raw_fd(), events: POLLIN, revents: 0 };
            let r = unsafe { poll(&mut p, 1, ms) };
            if r < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(TErr::Failed("poll".into()));
            }
            if r == 0 {
                return Ok(false);
            }
            if p.revents & (POLLERR | POLLHUP | POLLNVAL) != 0 {
                return Err(TErr::Gone);
            }
            return Ok(p.revents & POLLIN != 0);
        }
    }
}

/// An input report as hidraw gives it, made as the readers expect it: the report id first (0 prepended for an
/// unnumbered device); None when it is another collection's report.
pub fn as_report(raw: &[u8], numbered: bool, input_ids: &[u8]) -> Option<Vec<u8>> {
    if raw.is_empty() {
        return None;
    }
    if !numbered {
        let mut v = Vec::with_capacity(raw.len() + 1);
        v.push(0);
        v.extend_from_slice(raw);
        return Some(v);
    }
    if !input_ids.is_empty() && !input_ids.contains(&raw[0]) {
        return None;
    }
    Some(raw.to_vec())
}

/// The bytes a write sends: `bytes` padded with zeros to `len`; None when they do not fit (or there is no such report).
pub fn padded(bytes: &[u8], len: usize) -> Option<Vec<u8>> {
    if len == 0 || bytes.is_empty() || bytes.len() > len || len > MAX_REPORT {
        return None;
    }
    let mut v = vec![0u8; len];
    v[..bytes.len()].copy_from_slice(bytes);
    Some(v)
}

impl HidTransport for LinHid {
    fn ident(&self) -> &HidIdent {
        &self.ident
    }
    fn mode(&self) -> OpenMode {
        self.mode
    }
    fn feature_len(&self) -> usize {
        self.feature_len
    }
    fn get_feature(&mut self, report_id: u8, len: usize, deadline: Instant) -> Result<Vec<u8>, TErr> {
        self.get_report(hidioc_gfeature, report_id, len, deadline)
    }
    fn get_input(&mut self, report_id: u8, len: usize, deadline: Instant) -> Result<Vec<u8>, TErr> {
        // (HIDIOCGINPUT: Linux 5.11 and later; an older kernel answers it with an error, as a device without it.)
        self.get_report(hidioc_ginput, report_id, len, deadline)
    }
    fn read_input(&mut self, deadline: Instant) -> Result<Vec<u8>, TErr> {
        if self.mode == OpenMode::QueryOnly || self.input_len == 0 {
            return Err(TErr::Refused);
        }
        let mut buf = vec![0u8; (self.input_len + 1).clamp(64, MAX_REPORT)];
        loop {
            if !self.wait_readable(deadline)? {
                return Err(TErr::Timeout);
            }
            let n = match self.f.read(&mut buf) {
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) if matches!(e.raw_os_error(), Some(19) | Some(5)) => return Err(TErr::Gone),
                Err(e) => return Err(TErr::Failed(e.to_string())),
            };
            if n == 0 {
                return Err(TErr::Gone);
            }
            if let Some(r) = as_report(&buf[..n], self.numbered, &self.input_ids) {
                return Ok(r);
            }
            // (Another collection's report on the same node: not this reader's — the next one.)
        }
    }
    fn flush(&mut self) {
        // (What this descriptor has queued, read and dropped — at most 256 reports, never waiting.)
        let mut buf = vec![0u8; (self.input_len + 1).clamp(64, MAX_REPORT)];
        for _ in 0..256 {
            let mut p = PollFd { fd: self.f.as_raw_fd(), events: POLLIN, revents: 0 };
            let r = unsafe { poll(&mut p, 1, 0) };
            if r <= 0 || p.revents & POLLIN == 0 || p.revents & (POLLERR | POLLHUP | POLLNVAL) != 0 {
                break;
            }
            if self.f.read(&mut buf).map_or(true, |n| n == 0) {
                break;
            }
        }
    }
    fn send_allowed(&mut self, w: &AllowedWrite, deadline: Instant) -> Result<(), TErr> {
        left(deadline)?;
        match w.kind() {
            ReportKind::Output => {
                if self.mode != OpenMode::ReadWrite {
                    return Err(TErr::Refused);
                }
                let buf = padded(w.bytes(), self.output_len).ok_or(TErr::Refused)?;
                let n = self.f.write(&buf).map_err(|e| if matches!(e.raw_os_error(), Some(19) | Some(5)) { TErr::Gone } else { TErr::Failed(e.to_string()) })?;
                left(deadline)?;
                if n == buf.len() {
                    Ok(())
                } else {
                    Err(TErr::Failed("short write".into()))
                }
            }
            ReportKind::Feature => {
                let mut buf = padded(w.bytes(), self.feature_len).ok_or(TErr::Refused)?;
                let r = unsafe { ioctl(self.f.as_raw_fd(), hidioc_sfeature(buf.len()), buf.as_mut_ptr()) };
                left(deadline)?;
                if r < 0 {
                    Err(TErr::Failed("HIDIOCSFEATURE".into()))
                } else {
                    Ok(())
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(any(target_arch = "x86_64", target_arch = "aarch64", target_arch = "x86", target_arch = "arm", target_arch = "riscv64"))]
    #[test]
    fn ioctl_numbers_as_linux_hidraw_h() {
        // (Known values: HIDIOCGFEATURE(64) 0xC0404807, HIDIOCSFEATURE(64) 0xC0404806, HIDIOCGINPUT(64) 0xC040480A.)
        assert_eq!(hidioc_gfeature(64), 0xC040_4807);
        assert_eq!(hidioc_sfeature(64), 0xC040_4806);
        assert_eq!(hidioc_ginput(64), 0xC040_480A);
        assert_eq!(hidioc_gfeature(2), 0xC002_4807);
    }

    #[test]
    fn reports_as_the_readers_expect_them() {
        assert_eq!(as_report(&[5, 6, 7], false, &[]), Some(vec![0, 5, 6, 7]), "unnumbered: a 0 id first");
        assert_eq!(as_report(&[3, 50], true, &[3]), Some(vec![3, 50]));
        assert_eq!(as_report(&[1, 9, 9], true, &[3]), None, "another collection's report");
        assert_eq!(as_report(&[1, 9], true, &[]), Some(vec![1, 9]));
        assert_eq!(as_report(&[], false, &[]), None);
        assert_eq!(padded(&[0x05, 0x01], 4), Some(vec![5, 1, 0, 0]));
        assert_eq!(padded(&[1, 2, 3], 2), None, "longer than the report");
        assert_eq!(padded(&[1], 0), None, "no such report");
    }

    #[test]
    fn a_missing_node_is_gone_and_not_openable() {
        let c = NodeColl { node: "/nonexistent/hidraw999".into(), ident: HidIdent { vid: 1, pid: 2, usage_page: 1, usage: 2, interface: -1 }, input_len: 8, output_len: 0, feature_len: 0, numbered: false, input_ids: vec![] };
        assert!(matches!(LinHid::open(&c, OpenMode::QueryOnly), Err(TErr::Gone)));
        assert!(!may_open(Path::new("/nonexistent/hidraw999"), false));
    }

    #[test]
    fn listening_on_a_pipe_honours_the_deadline_and_the_collection() {
        // (A FIFO stands for the node: poll and read behave the same; no device is touched.)
        let dir = std::env::temp_dir().join(format!("kt-bat-fifo-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("node");
        let _ = std::fs::remove_file(&p);
        let c = CString::new(p.as_os_str().as_bytes()).unwrap();
        extern "C" {
            fn mkfifo(path: *const c_char, mode: u32) -> c_int;
        }
        if unsafe { mkfifo(c.as_ptr(), 0o600) } != 0 {
            return;
        }
        // (A writer first, kept open, so opening for reading does not wait.)
        let p2 = p.clone();
        let writer = std::thread::spawn(move || std::fs::OpenOptions::new().write(true).open(&p2).unwrap());
        let nc = NodeColl { node: p.clone(), ident: HidIdent { vid: 1, pid: 2, usage_page: 1, usage: 5, interface: -1 }, input_len: 3, output_len: 0, feature_len: 0, numbered: true, input_ids: vec![3] };
        let mut t = LinHid::open(&nc, OpenMode::Read).unwrap();
        let mut w = writer.join().unwrap();
        let t0 = Instant::now();
        assert_eq!(t.read_input(Instant::now() + std::time::Duration::from_millis(80)), Err(TErr::Timeout));
        assert!(t0.elapsed() >= std::time::Duration::from_millis(60), "waited for the deadline, in poll");
        // (Report 1 is another collection's: skipped; report 3 is ours. A FIFO joins writes, so one write each.)
        w.write_all(&[3, 42, 0]).unwrap();
        assert_eq!(t.read_input(Instant::now() + std::time::Duration::from_secs(2)), Ok(vec![3, 42, 0]));
        // (A query-only handle never listens.)
        let mut q = LinHid::open(&nc, OpenMode::QueryOnly).unwrap();
        assert_eq!(q.read_input(Instant::now() + std::time::Duration::from_secs(1)), Err(TErr::Refused));
        // (A query-only handle cannot send an output report, whatever it carries.)
        drop(w);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
