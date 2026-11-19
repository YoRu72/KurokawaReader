// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Windows' HID collections.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor), src/hid.cpp
// (EnumHid, HidDev, HidProduct) and src/drivers/generic.cpp (PollGenericHid, ContainerOf) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later.
// Changed here: enumeration also reads each collection's container id and serial number (stable keys, identity.rs) and
// its battery fields once, so a device without one is never opened again; a collection is opened with no access
// (enough for feature and input reports) unless allow.rs names it — never read/write by default, never exclusive —,
// and closed at once; every call has a deadline: the HID calls themselves cannot be cancelled, so a call that returns
// after its deadline is discarded, and the runner gives up on it at the deadline (one thread per query, runner.rs).
// Piece 4 (controllers): a collection can be opened to listen to the reports the device sends (overlapped ReadFile
// with the deadline: at the deadline the read is cancelled — CancelIoEx — and the cancellation awaited), and an
// allow-listed output report goes out by WriteFile as the original's HidDev::Write did, under the same deadline. A
// listening handle shares the device (FILE_SHARE_READ | FILE_SHARE_WRITE, never exclusive): Windows gives every handle
// its own copy of each input report, so a game reading the pad loses nothing.
// UNVERIFIED here: compiled only on Windows (type-checked elsewhere); real devices decide.
// Copyright (C) 2026 Kurokawa contributors.
use super::ffi::*;
use crate::allow::{AllowedWrite, HidIdent, ReportKind};
use crate::hidvalue::{self, ValueCap};
use crate::model::Percent;
use crate::transport::{left, open_mode_for, HidTransport, OpenMode, TErr};
use std::ffi::c_void;
use std::time::Instant;

/// One HID collection as enumeration found it.
#[derive(Clone, Debug)]
pub struct HidColl {
    pub path: String,
    pub ident: HidIdent,
    pub product: String,
    pub serial: String,
    pub container: String,
    pub feature_len: usize,
    pub input_len: usize,
    pub output_len: usize,
    /// Its battery value fields (empty for most collections).
    pub battery: Vec<ValueCap>,
}

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        if self.0 != INVALID_HANDLE_VALUE && self.0 != 0 {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

struct Preparsed(isize);
impl Drop for Preparsed {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe {
                HidD_FreePreparsedData(self.0);
            }
        }
    }
}

struct DevInfo(HDEVINFO);
impl Drop for DevInfo {
    fn drop(&mut self) {
        if self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                SetupDiDestroyDeviceInfoList(self.0);
            }
        }
    }
}

fn open(path: &str, mode: OpenMode) -> Option<Handle> {
    open_flags(path, mode, 0)
}

fn open_flags(path: &str, mode: OpenMode, flags: u32) -> Option<Handle> {
    let access = match mode {
        OpenMode::QueryOnly | OpenMode::Feature => 0,
        OpenMode::Read => GENERIC_READ,
        OpenMode::ReadWrite => GENERIC_READ | GENERIC_WRITE,
    };
    let w = wide(path);
    let h = unsafe { CreateFileW(w.as_ptr(), access, FILE_SHARE_READ | FILE_SHARE_WRITE, std::ptr::null(), OPEN_EXISTING, flags, 0) };
    if h == INVALID_HANDLE_VALUE || h == 0 {
        None
    } else {
        Some(Handle(h))
    }
}

fn hid_string(h: HANDLE, serial: bool) -> String {
    let mut buf = [0u16; 128];
    let ok = unsafe {
        let p = buf.as_mut_ptr() as *mut c_void;
        let n = (buf.len() * 2 - 2) as u32;
        if serial {
            HidD_GetSerialNumberString(h, p, n)
        } else {
            HidD_GetProductString(h, p, n)
        }
    };
    if ok == 0 {
        return String::new();
    }
    from_wide(&buf).trim().to_string()
}

fn value_caps(pp: isize, kind: i32, count: u16) -> Vec<HIDP_VALUE_CAPS> {
    if count == 0 {
        return Vec::new();
    }
    let mut v = vec![HIDP_VALUE_CAPS::default(); count as usize];
    let mut n = count;
    let st = unsafe { HidP_GetValueCaps(kind, v.as_mut_ptr(), &mut n, pp) };
    if st != HIDP_STATUS_SUCCESS {
        return Vec::new();
    }
    v.truncate((n as usize).min(count as usize));
    v
}

fn to_cap(v: &HIDP_VALUE_CAPS, feature: bool) -> ValueCap {
    // (Range: UsageMin first in the union; NotRange: Usage first — the same place.)
    ValueCap { feature, report_id: v.ReportID, usage_page: v.UsagePage, usage: v.Union[0], link_collection: v.LinkCollection, logical_min: v.LogicalMin, logical_max: v.LogicalMax, bit_size: v.BitSize, report_count: v.ReportCount }
}

fn interface_of(path: &str) -> i32 {
    let l = path.to_ascii_lowercase();
    match l.find("&mi_") {
        Some(i) => i32::from_str_radix(&l[i + 4..].chars().take(2).collect::<String>(), 16).unwrap_or(-1),
        None => -1,
    }
}

fn container_of(di: HDEVINFO, dd: &SP_DEVINFO_DATA) -> String {
    let mut g = GUID::default();
    let mut t = 0u32;
    let ok = unsafe { SetupDiGetDevicePropertyW(di, dd, &DEVPKEY_Device_ContainerId, &mut t, &mut g as *mut GUID as *mut u8, std::mem::size_of::<GUID>() as u32, std::ptr::null_mut(), 0) };
    if ok != 0 && t == DEVPROP_TYPE_GUID {
        g.braced()
    } else {
        String::new()
    }
}

/// Every HID collection present, with what the readers need. Each is opened with no access, read, closed.
pub fn enumerate() -> Vec<HidColl> {
    let mut out = Vec::new();
    let mut guid = GUID::default();
    unsafe { HidD_GetHidGuid(&mut guid) };
    let di = DevInfo(unsafe { SetupDiGetClassDevsW(&guid, std::ptr::null(), 0, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE) });
    if di.0 == INVALID_HANDLE_VALUE {
        return out;
    }
    for i in 0..4096u32 {
        let mut ifd = SP_DEVICE_INTERFACE_DATA { cbSize: std::mem::size_of::<SP_DEVICE_INTERFACE_DATA>() as u32, ..Default::default() };
        if unsafe { SetupDiEnumDeviceInterfaces(di.0, std::ptr::null(), &guid, i, &mut ifd) } == 0 {
            break;
        }
        let mut need = 0u32;
        unsafe { SetupDiGetDeviceInterfaceDetailW(di.0, &ifd, std::ptr::null_mut(), 0, &mut need, std::ptr::null_mut()) };
        if need < 8 || need > 64 * 1024 {
            continue;
        }
        // (A u32-aligned buffer: cbSize, then the path in UTF-16.)
        let mut buf = vec![0u32; (need as usize + 3) / 4 + 1];
        buf[0] = DETAIL_CB_SIZE;
        let mut dd = SP_DEVINFO_DATA { cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32, ..Default::default() };
        if unsafe { SetupDiGetDeviceInterfaceDetailW(di.0, &ifd, buf.as_mut_ptr() as *mut c_void, need, std::ptr::null_mut(), &mut dd) } == 0 {
            continue;
        }
        let words: &[u16] = unsafe { std::slice::from_raw_parts((buf.as_ptr() as *const u8).add(4) as *const u16, (need as usize - 4) / 2) };
        let path = from_wide(words);
        if path.is_empty() {
            continue;
        }
        let Some(h) = open(&path, OpenMode::QueryOnly) else { continue };
        let mut a = HIDD_ATTRIBUTES { Size: std::mem::size_of::<HIDD_ATTRIBUTES>() as u32, ..Default::default() };
        if unsafe { HidD_GetAttributes(h.0, &mut a) } == 0 {
            continue;
        }
        let mut pp_raw = 0isize;
        if unsafe { HidD_GetPreparsedData(h.0, &mut pp_raw) } == 0 {
            continue;
        }
        let pp = Preparsed(pp_raw);
        let mut caps = HIDP_CAPS::default();
        if unsafe { HidP_GetCaps(pp.0, &mut caps) } != HIDP_STATUS_SUCCESS {
            continue;
        }
        let mut battery: Vec<ValueCap> = value_caps(pp.0, HidP_Feature, caps.NumberFeatureValueCaps).iter().map(|v| to_cap(v, true)).collect();
        battery.extend(value_caps(pp.0, HidP_Input, caps.NumberInputValueCaps).iter().map(|v| to_cap(v, false)));
        battery.retain(|c| hidvalue::is_battery_usage(c.usage_page, c.usage));
        let product = hid_string(h.0, false);
        let serial = hid_string(h.0, true);
        drop(pp);
        drop(h);
        out.push(HidColl {
            ident: HidIdent { vid: a.VendorID, pid: a.ProductID, usage_page: caps.UsagePage, usage: caps.Usage, interface: interface_of(&path) },
            container: container_of(di.0, &dd),
            path,
            product,
            serial,
            feature_len: caps.FeatureReportByteLength as usize,
            input_len: caps.InputReportByteLength as usize,
            output_len: caps.OutputReportByteLength as usize,
            battery,
        });
    }
    out
}

/// One collection, open (WinHid's calls block in the HID driver: a call that returns past its deadline is discarded).
pub struct WinHid {
    ident: HidIdent,
    mode: OpenMode,
    h: Handle,
    output_len: usize,
    feature_len: usize,
    input_len: usize,
    /// Opened for overlapped reads and writes (to listen): feature and control-pipe calls are not used on it.
    overlapped: bool,
}

impl WinHid {
    pub fn open(c: &HidColl) -> Result<WinHid, TErr> {
        let mode = open_mode_for(&c.ident, false);
        let h = open(&c.path, mode).ok_or(TErr::Gone)?;
        Ok(WinHid { ident: c.ident.clone(), mode, h, output_len: c.output_len, feature_len: c.feature_len, input_len: c.input_len, overlapped: false })
    }
    /// Piece 5: a mouse's or keyboard's collection asked through feature reports only — no read or write access
    /// (Windows holds a mouse's and a keyboard's own collections; the control pipe stays open to everyone), and a
    /// feature report allow.rs lists may be set on it when `may_send`.
    pub fn open_feature(c: &HidColl, may_send: bool) -> Result<WinHid, TErr> {
        let mode = if may_send && crate::allow::may_write(&c.ident) { OpenMode::Feature } else { OpenMode::QueryOnly };
        let h = open(&c.path, OpenMode::QueryOnly).ok_or(TErr::Gone)?;
        Ok(WinHid { ident: c.ident.clone(), mode, h, output_len: c.output_len, feature_len: c.feature_len, input_len: c.input_len, overlapped: false })
    }
    /// The length a feature report is sent with, when a device wants its own report's length rather than the
    /// collection's longest (Machenike's 21-byte report 51 on a collection whose longest feature report is 1001).
    pub fn set_feature_len(&mut self, n: usize) {
        if n > 0 {
            self.feature_len = n;
        }
    }
    /// Opened to listen (read access; read/write only when allow.rs names the collection and `may_send`).
    pub fn open_listen(c: &HidColl, may_send: bool) -> Result<WinHid, TErr> {
        let mode = match open_mode_for(&c.ident, true) {
            OpenMode::ReadWrite if !may_send => OpenMode::Read,
            m => m,
        };
        let h = open_flags(&c.path, mode, FILE_FLAG_OVERLAPPED).ok_or(TErr::Gone)?;
        Ok(WinHid { ident: c.ident.clone(), mode, h, output_len: c.output_len, feature_len: c.feature_len, input_len: c.input_len, overlapped: true })
    }
}

struct Event(HANDLE);
impl Drop for Event {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// One overlapped transfer on `h` with `buf`, waited for until `deadline`; past it, cancelled and the cancel awaited
/// (the buffer must outlive the transfer). Returns the bytes moved.
fn overlapped_io(h: HANDLE, buf: &mut [u8], write: bool, deadline: Instant) -> Result<usize, TErr> {
    let ms = left(deadline)?.as_millis().min(u32::MAX as u128 - 1) as u32;
    let ev = Event(unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) });
    if ev.0 == 0 {
        return Err(TErr::Failed("CreateEventW".into()));
    }
    let mut ov = OVERLAPPED { hEvent: ev.0, ..Default::default() };
    let started = unsafe {
        if write {
            WriteFile(h, buf.as_ptr() as *const c_void, buf.len() as u32, std::ptr::null_mut(), &mut ov)
        } else {
            ReadFile(h, buf.as_mut_ptr() as *mut c_void, buf.len() as u32, std::ptr::null_mut(), &mut ov)
        }
    };
    if started == 0 {
        let e = unsafe { GetLastError() };
        if e != ERROR_IO_PENDING {
            return Err(if e == ERROR_DEVICE_NOT_CONNECTED { TErr::Gone } else { TErr::Failed(format!("I/O {}", e)) });
        }
    }
    let waited = unsafe { WaitForSingleObject(ev.0, ms) };
    let mut n = 0u32;
    if waited == WAIT_OBJECT_0 {
        let ok = unsafe { GetOverlappedResult(h, &ov, &mut n, 0) };
        if ok == 0 {
            let e = unsafe { GetLastError() };
            return Err(if e == ERROR_DEVICE_NOT_CONNECTED { TErr::Gone } else { TErr::Failed(format!("I/O {}", e)) });
        }
        return Ok(n as usize);
    }
    // (Past the deadline: cancelled; GetOverlappedResult with wait returns once the HID driver has let go of the
    // buffer — at once for a cancelled read. A transfer that completed meanwhile is still too late: dropped.)
    unsafe {
        CancelIoEx(h, &ov);
        GetOverlappedResult(h, &ov, &mut n, 1);
    }
    Err(TErr::Timeout)
}

impl HidTransport for WinHid {
    fn ident(&self) -> &HidIdent {
        &self.ident
    }
    fn feature_len(&self) -> usize {
        self.feature_len
    }
    fn mode(&self) -> OpenMode {
        self.mode
    }
    fn get_feature(&mut self, report_id: u8, len: usize, deadline: Instant) -> Result<Vec<u8>, TErr> {
        left(deadline)?;
        let mut buf = vec![0u8; len.max(1)];
        buf[0] = report_id;
        let ok = unsafe { HidD_GetFeature(self.h.0, buf.as_mut_ptr() as *mut c_void, buf.len() as u32) };
        left(deadline)?;
        if ok == 0 {
            return Err(TErr::Failed("HidD_GetFeature".into()));
        }
        Ok(buf)
    }
    fn get_input(&mut self, report_id: u8, len: usize, deadline: Instant) -> Result<Vec<u8>, TErr> {
        left(deadline)?;
        let mut buf = vec![0u8; len.max(1)];
        buf[0] = report_id;
        let ok = unsafe { HidD_GetInputReport(self.h.0, buf.as_mut_ptr() as *mut c_void, buf.len() as u32) };
        left(deadline)?;
        if ok == 0 {
            return Err(TErr::Failed("HidD_GetInputReport".into()));
        }
        Ok(buf)
    }
    fn read_input(&mut self, deadline: Instant) -> Result<Vec<u8>, TErr> {
        if !self.overlapped || self.input_len == 0 || self.mode == OpenMode::QueryOnly {
            return Err(TErr::Refused);
        }
        let mut buf = vec![0u8; self.input_len];
        let n = overlapped_io(self.h.0, &mut buf, false, deadline)?;
        if n == 0 {
            return Err(TErr::BadReply);
        }
        buf.truncate(n);
        Ok(buf)
    }
    fn flush(&mut self) {
        unsafe {
            HidD_FlushQueue(self.h.0);
        }
    }
    fn send_allowed(&mut self, w: &AllowedWrite, deadline: Instant) -> Result<(), TErr> {
        left(deadline)?;
        if self.overlapped && w.kind() == ReportKind::Output {
            // (As the original's HidDev::Write: the interrupt pipe, padded to the output report's length.)
            if self.output_len == 0 || w.bytes().len() > self.output_len {
                return Err(TErr::Refused);
            }
            let mut buf = vec![0u8; self.output_len];
            buf[..w.bytes().len()].copy_from_slice(w.bytes());
            let n = overlapped_io(self.h.0, &mut buf, true, deadline)?;
            return if n == buf.len() { Ok(()) } else { Err(TErr::Failed("short write".into())) };
        }
        let size = match w.kind() {
            ReportKind::Output => self.output_len,
            ReportKind::Feature => self.feature_len,
        };
        if size == 0 || w.bytes().len() > size {
            return Err(TErr::Refused);
        }
        let mut buf = vec![0u8; size];
        buf[..w.bytes().len()].copy_from_slice(w.bytes());
        let ok = unsafe {
            match w.kind() {
                ReportKind::Output => HidD_SetOutputReport(self.h.0, buf.as_mut_ptr() as *mut c_void, size as u32),
                ReportKind::Feature => HidD_SetFeature(self.h.0, buf.as_mut_ptr() as *mut c_void, size as u32),
            }
        };
        if ok == 0 {
            Err(TErr::Failed("send".into()))
        } else {
            Ok(())
        }
    }
}

/// The generic reader on one collection: its battery fields read through WinHid, the value by HidP_GetUsageValue.
pub fn read_battery(c: &HidColl, deadline: Instant) -> Result<Percent, TErr> {
    let mut t = WinHid::open(c)?;
    let mut pp_raw = 0isize;
    if unsafe { HidD_GetPreparsedData(t.h.0, &mut pp_raw) } == 0 {
        return Err(TErr::Gone);
    }
    let pp = Preparsed(pp_raw);
    let extract = |cap: &ValueCap, rep: &mut [u8]| -> Option<u32> {
        let mut v = 0u32;
        let kind = if cap.feature { HidP_Feature } else { HidP_Input };
        let st = unsafe { HidP_GetUsageValue(kind, cap.usage_page, cap.link_collection, cap.usage, &mut v, pp.0, rep.as_mut_ptr(), rep.len() as u32) };
        if st == HIDP_STATUS_SUCCESS {
            Some(v)
        } else {
            None
        }
    };
    hidvalue::read_generic(&mut t, &c.battery, c.feature_len, c.input_len, hidvalue::percent_quirk(c.ident.vid), deadline, &extract)
}
