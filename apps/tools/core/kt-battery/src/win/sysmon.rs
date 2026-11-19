// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — the system on the taskbar (piece S1), Windows' side: the figures sampled on one background thread
// at the user's interval, only those shown, and handed on only when a shown number changed (../sysmon.rs decides).
// Where each value comes from — Windows' public interfaces only, as an ordinary user (no driver, no administrator):
// - CPU load: GetSystemTimes, two readings apart;
// - CPU temperature: the «Thermal Zone Information(*)\Temperature» performance counter (pdh.dll), the warmest zone —
//   many computers give none or a fixed firmware value without a driver: then nothing is shown;
// - memory in use: GlobalMemoryStatusEx;
// - the graphics card (DXGI: the real adapter with the most memory of its own): its load from «GPU Engine(*)\Utilization
//   Percentage» (the busiest engine, as Task Manager), its memory from «GPU Adapter Memory(*)\Dedicated Usage» over
//   DXGI's dedicated size, its temperature from D3DKMTQueryAdapterInfo's adapter performance data (gdi32, what Task
//   Manager shows) — or, for an NVIDIA card whose driver does not report it there, NVIDIA's own nvml.dll, loaded only
//   from the system folder or the driver's fixed folder;
// - the system drive's temperature: IOCTL_STORAGE_QUERY_PROPERTY's StorageDeviceTemperatureProperty on its physical
//   disk, opened with no access rights asked (as Windows allows an ordinary user); absent when the drive says nothing.
// pdh.dll, dxgi.dll, wtsapi32.dll and nvml.dll are loaded by full search rule LOAD_LIBRARY_SEARCH_SYSTEM32 (or the
// fixed path), never from the current folder or PATH. Sampling rests while the display is off
// (GUID_CONSOLE_DISPLAY_STATE) or the session locked (WTS session notifications), and does not run at all with no
// value chosen. Every failure is a quiet «absent»; nothing here panics.
// Inspired by TraySense by DMTWEAKS (https://github.com/DMTWEAKS/traysense, AGPL-3.0): which public interfaces give
// each value — no code, structure or text taken (apps/tools/NOTICE.md).
// UNVERIFIED here: compiled only on Windows (type-checked elsewhere, stdroots/wincheck.rs; the structs' sizes checked
// by stdroots/winffi.rs); never run on a real computer.
// Copyright (C) 2026 Kurokawa contributors.
#![allow(non_snake_case, non_camel_case_types, clippy::upper_case_acronyms)]
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;

use crate::sysmon::{self, Adapter, Cfg, CpuTimes, Gate, Metric, Needs, Sample, Shown, Watch};

type HWND = isize;
type HANDLE = isize;
type HMODULE = isize;
type BOOL = i32;
type WNDPROC = unsafe extern "system" fn(HWND, u32, usize, isize) -> isize;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct FILETIME {
    lo: u32,
    hi: u32,
}

#[repr(C)]
#[derive(Default)]
struct MEMORYSTATUSEX {
    dwLength: u32,
    dwMemoryLoad: u32,
    ullTotalPhys: u64,
    ullAvailPhys: u64,
    ullTotalPageFile: u64,
    ullAvailPageFile: u64,
    ullTotalVirtual: u64,
    ullAvailVirtual: u64,
    ullAvailExtendedVirtual: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct GUID {
    a: u32,
    b: u16,
    c: u16,
    d: [u8; 8],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct LUID {
    LowPart: u32,
    HighPart: i32,
}

#[repr(C)]
struct DXGI_ADAPTER_DESC1 {
    Description: [u16; 128],
    VendorId: u32,
    DeviceId: u32,
    SubSysId: u32,
    Revision: u32,
    DedicatedVideoMemory: usize,
    DedicatedSystemMemory: usize,
    SharedSystemMemory: usize,
    AdapterLuid: LUID,
    Flags: u32,
}

#[repr(C)]
struct D3DKMT_OPENADAPTERFROMLUID {
    AdapterLuid: LUID,
    hAdapter: u32,
}

#[repr(C)]
struct D3DKMT_CLOSEADAPTER {
    hAdapter: u32,
}

#[repr(C)]
struct D3DKMT_QUERYADAPTERINFO {
    hAdapter: u32,
    Type: u32,
    pPrivateDriverData: *mut c_void,
    PrivateDriverDataSize: u32,
}

#[repr(C)]
#[derive(Default)]
struct D3DKMT_ADAPTER_PERFDATA {
    PhysicalAdapterIndex: u32,
    MemoryFrequency: u64,
    MaxMemoryFrequency: u64,
    MaxMemoryFrequencyOC: u64,
    MemoryBandwidth: u64,
    PCIEBandwidth: u64,
    FanRPM: u32,
    Power: u32,
    Temperature: u32,
    PowerStateOverride: u8,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct PDH_FMT_COUNTERVALUE {
    CStatus: u32,
    // (The union's widest member, a double; 8-aligned.)
    value: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct PDH_FMT_COUNTERVALUE_ITEM_W {
    szName: *const u16,
    FmtValue: PDH_FMT_COUNTERVALUE,
}

#[repr(C)]
struct STORAGE_PROPERTY_QUERY {
    PropertyId: u32,
    QueryType: u32,
    AdditionalParameters: [u8; 1],
}

#[repr(C)]
struct POINT {
    x: i32,
    y: i32,
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

#[cfg_attr(windows, link(name = "kernel32", kind = "raw-dylib"))]
extern "system" {
    fn GetSystemTimes(idle: *mut FILETIME, kernel: *mut FILETIME, user: *mut FILETIME) -> BOOL;
    fn GlobalMemoryStatusEx(m: *mut MEMORYSTATUSEX) -> BOOL;
    fn LoadLibraryExW(name: *const u16, file: HANDLE, flags: u32) -> HMODULE;
    fn GetProcAddress(m: HMODULE, name: *const u8) -> *const c_void;
    fn FreeLibrary(m: HMODULE) -> BOOL;
    fn GetSystemDirectoryW(buf: *mut u16, len: u32) -> u32;
    fn CreateFileW(name: *const u16, access: u32, share: u32, sa: *const c_void, disp: u32, flags: u32, template: HANDLE) -> HANDLE;
    fn DeviceIoControl(h: HANDLE, code: u32, inb: *const c_void, inlen: u32, outb: *mut c_void, outlen: u32, ret: *mut u32, ov: *mut c_void) -> BOOL;
    fn CloseHandle(h: HANDLE) -> BOOL;
    fn GetModuleHandleW(name: *const u16) -> isize;
    fn GetCurrentThreadId() -> u32;
}

#[cfg_attr(windows, link(name = "gdi32", kind = "raw-dylib"))]
extern "system" {
    fn D3DKMTOpenAdapterFromLuid(p: *mut D3DKMT_OPENADAPTERFROMLUID) -> i32;
    fn D3DKMTQueryAdapterInfo(p: *const D3DKMT_QUERYADAPTERINFO) -> i32;
    fn D3DKMTCloseAdapter(p: *const D3DKMT_CLOSEADAPTER) -> i32;
}

#[cfg_attr(windows, link(name = "user32", kind = "raw-dylib"))]
extern "system" {
    fn RegisterClassExW(c: *const WNDCLASSEXW) -> u16;
    fn CreateWindowExW(ex: u32, class: *const u16, name: *const u16, style: u32, x: i32, y: i32, w: i32, h: i32, parent: HWND, menu: isize, inst: isize, param: *const c_void) -> HWND;
    fn DestroyWindow(h: HWND) -> BOOL;
    fn DefWindowProcW(h: HWND, m: u32, w: usize, l: isize) -> isize;
    fn GetMessageW(msg: *mut MSG, h: HWND, min: u32, max: u32) -> BOOL;
    fn PeekMessageW(msg: *mut MSG, h: HWND, min: u32, max: u32, remove: u32) -> BOOL;
    fn DispatchMessageW(msg: *const MSG) -> isize;
    fn PostThreadMessageW(thread: u32, m: u32, w: usize, l: isize) -> BOOL;
    fn SetTimer(h: HWND, id: usize, ms: u32, f: *const c_void) -> usize;
    fn KillTimer(h: HWND, id: usize) -> BOOL;
    fn RegisterPowerSettingNotification(h: HANDLE, guid: *const GUID, flags: u32) -> isize;
    fn UnregisterPowerSettingNotification(h: isize) -> BOOL;
}

#[cfg_attr(windows, link(name = "shell32", kind = "raw-dylib"))]
extern "system" {
    fn ShellExecuteW(h: HWND, op: *const u16, file: *const u16, params: *const u16, dir: *const u16, show: i32) -> isize;
}

// (Loaded by name from the system folder only: their functions' types.)
type PdhOpenQueryW = unsafe extern "system" fn(src: *const u16, user: usize, q: *mut isize) -> u32;
type PdhAddEnglishCounterW = unsafe extern "system" fn(q: isize, path: *const u16, user: usize, c: *mut isize) -> u32;
type PdhCollectQueryData = unsafe extern "system" fn(q: isize) -> u32;
type PdhGetFormattedCounterArrayW = unsafe extern "system" fn(c: isize, fmt: u32, size: *mut u32, count: *mut u32, items: *mut PDH_FMT_COUNTERVALUE_ITEM_W) -> u32;
type PdhCloseQuery = unsafe extern "system" fn(q: isize) -> u32;
type CreateDXGIFactory1 = unsafe extern "system" fn(riid: *const GUID, out: *mut *mut c_void) -> i32;
type EnumAdapters1 = unsafe extern "system" fn(this: *mut c_void, i: u32, out: *mut *mut c_void) -> i32;
type GetDesc1 = unsafe extern "system" fn(this: *mut c_void, d: *mut DXGI_ADAPTER_DESC1) -> i32;
type Release = unsafe extern "system" fn(this: *mut c_void) -> u32;
type WTSRegisterSessionNotification = unsafe extern "system" fn(h: HWND, flags: u32) -> BOOL;
type WTSUnRegisterSessionNotification = unsafe extern "system" fn(h: HWND) -> BOOL;
type NvmlInit = unsafe extern "C" fn() -> i32;
type NvmlHandle = unsafe extern "C" fn(i: u32, dev: *mut *mut c_void) -> i32;
type NvmlTemp = unsafe extern "C" fn(dev: *mut c_void, sensor: u32, t: *mut u32) -> i32;
type NvmlShutdown = unsafe extern "C" fn() -> i32;

const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x0000_0100;
const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x0000_0800;
const PDH_FMT_DOUBLE: u32 = 0x0000_0200;
const PDH_FMT_NOCAP100: u32 = 0x0000_8000;
const PDH_MORE_DATA: u32 = 0x8000_07D2;
const PDH_CSTATUS_VALID_DATA: u32 = 0;
const PDH_CSTATUS_NEW_DATA: u32 = 1;
const DXGI_ERROR_NOT_FOUND: i32 = 0x887A_0002u32 as i32;
const DXGI_ADAPTER_FLAG_SOFTWARE: u32 = 2;
const KMTQAITYPE_ADAPTERPERFDATA: u32 = 62;
const IOCTL_STORAGE_QUERY_PROPERTY: u32 = 0x002D_1400;
const IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS: u32 = 0x0056_0000;
const STORAGE_DEVICE_TEMPERATURE_PROPERTY: u32 = 52;
const FILE_SHARE_READ: u32 = 1;
const FILE_SHARE_WRITE: u32 = 2;
const OPEN_EXISTING: u32 = 3;
const INVALID_HANDLE_VALUE: HANDLE = -1;
const WS_POPUP: u32 = 0x8000_0000;
const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
const WM_TIMER: u32 = 0x0113;
const WM_POWERBROADCAST: u32 = 0x0218;
const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
const WM_APP_CMD: u32 = 0x8000 + 42;
const PBT_POWERSETTINGCHANGE: usize = 0x8013;
const WTS_SESSION_LOCK: usize = 7;
const WTS_SESSION_UNLOCK: usize = 8;
const NOTIFY_FOR_THIS_SESSION: u32 = 0;
const DEVICE_NOTIFY_WINDOW_HANDLE: u32 = 0;
const PM_NOREMOVE: u32 = 0;
const SW_SHOWNORMAL: i32 = 1;
const TIMER_ID: usize = 1;
/// {770aae78-f26f-4dba-a829-253c83d1b387}
const IID_IDXGIFACTORY1: GUID = GUID { a: 0x770a_ae78, b: 0xf26f, c: 0x4dba, d: [0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87] };
/// GUID_CONSOLE_DISPLAY_STATE {6fe69556-704a-47a0-8f24-c28d936fda47}
const GUID_CONSOLE_DISPLAY_STATE: GUID = GUID { a: 0x6fe6_9556, b: 0x704a, c: 0x47a0, d: [0x8f, 0x24, 0xc2, 0x8d, 0x93, 0x6f, 0xda, 0x47] };

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// GetSystemDirectoryW's answer («C:\Windows\system32»), or empty.
fn system_dir() -> String {
    let mut buf = [0u16; 300];
    // SAFETY: the buffer and its length in characters.
    let n = unsafe { GetSystemDirectoryW(buf.as_mut_ptr(), buf.len() as u32) } as usize;
    if n == 0 || n >= buf.len() {
        return String::new();
    }
    String::from_utf16_lossy(buf.get(..n).unwrap_or(&[]))
}

/// A library of Windows' own (pdh, dxgi, wtsapi32) from the system folder, or one at a fixed full path; freed on drop.
struct Lib(HMODULE);

impl Lib {
    fn system(name: &str) -> Option<Lib> {
        let w = wide(name);
        // SAFETY: a NUL-ended name; the search limited to the system folder.
        let h = unsafe { LoadLibraryExW(w.as_ptr(), 0, LOAD_LIBRARY_SEARCH_SYSTEM32) };
        (h != 0).then_some(Lib(h))
    }
    fn at(full: &str) -> Option<Lib> {
        let w = wide(full);
        // SAFETY: a NUL-ended full path; its own folder and the system folder only, for what it needs.
        let h = unsafe { LoadLibraryExW(w.as_ptr(), 0, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32) };
        (h != 0).then_some(Lib(h))
    }
    /// A function's address (`name` NUL-ended), or None.
    fn get(&self, name: &[u8]) -> Option<*const c_void> {
        if name.last() != Some(&0) {
            return None;
        }
        // SAFETY: our module handle; a NUL-ended ASCII name.
        let p = unsafe { GetProcAddress(self.0, name.as_ptr()) };
        (!p.is_null()).then_some(p)
    }
}

impl Drop for Lib {
    fn drop(&mut self) {
        // SAFETY: a module this value loaded.
        unsafe { FreeLibrary(self.0) };
    }
}

/// A function pointer of type `F` from an address GetProcAddress gave.
macro_rules! fn_of {
    ($lib:expr, $name:literal, $ty:ty) => {
        // SAFETY: the address is the named export, whose signature is $ty (Windows' and the vendor's documented ones).
        $lib.get(concat!($name, "\0").as_bytes()).map(|p| unsafe { std::mem::transmute::<*const c_void, $ty>(p) })
    };
}

// ---------------------------------------------------------------- the sources

fn ft(f: FILETIME) -> u64 {
    (u64::from(f.hi) << 32) | u64::from(f.lo)
}

fn cpu_times() -> Option<CpuTimes> {
    let (mut i, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    // SAFETY: three FILETIMEs the call fills.
    (unsafe { GetSystemTimes(&mut i, &mut k, &mut u) } != 0).then(|| CpuTimes { idle: ft(i), kernel: ft(k), user: ft(u) })
}

fn ram() -> Option<f32> {
    let mut m = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    // SAFETY: a MEMORYSTATUSEX with its length set.
    if unsafe { GlobalMemoryStatusEx(&mut m) } == 0 {
        return None;
    }
    sysmon::ram_pct(m.ullTotalPhys, m.ullAvailPhys)
}

/// The performance counters' query, with the counters the values need.
struct Pdh {
    lib: Lib,
    query: isize,
    thermal: isize,
    engines: isize,
    memory: isize,
    collect: PdhCollectQueryData,
    array: PdhGetFormattedCounterArrayW,
    close: PdhCloseQuery,
}

impl Pdh {
    fn open(n: &Needs) -> Option<Pdh> {
        let lib = Lib::system("pdh.dll")?;
        let open = fn_of!(lib, "PdhOpenQueryW", PdhOpenQueryW)?;
        let add = fn_of!(lib, "PdhAddEnglishCounterW", PdhAddEnglishCounterW)?;
        let collect = fn_of!(lib, "PdhCollectQueryData", PdhCollectQueryData)?;
        let array = fn_of!(lib, "PdhGetFormattedCounterArrayW", PdhGetFormattedCounterArrayW)?;
        let close = fn_of!(lib, "PdhCloseQuery", PdhCloseQuery)?;
        let mut query: isize = 0;
        // SAFETY: a live query handle is written to `query`.
        if unsafe { open(std::ptr::null(), 0, &mut query) } != 0 || query == 0 {
            return None;
        }
        let counter = |want: bool, path: &str| -> isize {
            if !want {
                return 0;
            }
            let w = wide(path);
            let mut c: isize = 0;
            // SAFETY: our query; a NUL-ended English counter path; the counter written to `c`.
            if unsafe { add(query, w.as_ptr(), 0, &mut c) } == 0 {
                c
            } else {
                0
            }
        };
        let thermal = counter(n.thermal, r"\Thermal Zone Information(*)\Temperature");
        let engines = counter(n.gpu_engines, r"\GPU Engine(*)\Utilization Percentage");
        let memory = counter(n.gpu_memory, r"\GPU Adapter Memory(*)\Dedicated Usage");
        let p = Pdh { lib, query, thermal, engines, memory, collect, array, close };
        // (The first collection: rate counters — the engines' use — need two before they say anything.)
        // SAFETY: our query.
        unsafe { (p.collect)(p.query) };
        Some(p)
    }

    fn collect(&self) -> bool {
        // SAFETY: our query.
        unsafe { (self.collect)(self.query) == 0 }
    }

    /// A wildcard counter's rows (instance name, value), valid ones only; empty when it gave none.
    fn rows(&self, counter: isize) -> Vec<(String, f64)> {
        if counter == 0 {
            return Vec::new();
        }
        let mut size: u32 = 0;
        let mut count: u32 = 0;
        // SAFETY: asked for the size alone (no buffer).
        let rc = unsafe { (self.array)(counter, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, &mut size, &mut count, std::ptr::null_mut()) };
        if rc != PDH_MORE_DATA || size == 0 || size > 16 * 1024 * 1024 {
            return Vec::new();
        }
        // (A buffer of whole items, 8-aligned, at least `size` bytes: the items first, their names after them.)
        let item = std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>();
        let mut buf: Vec<PDH_FMT_COUNTERVALUE_ITEM_W> = Vec::with_capacity((size as usize).div_ceil(item));
        // SAFETY: the buffer holds `size` bytes; the call writes within it and says how many items it filled.
        let rc = unsafe { (self.array)(counter, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, &mut size, &mut count, buf.as_mut_ptr()) };
        if rc != 0 {
            return Vec::new();
        }
        let n = (count as usize).min(buf.capacity());
        // SAFETY: the call filled `count` items (bounded by the capacity).
        unsafe { buf.set_len(n) };
        let base = buf.as_ptr() as usize;
        let end = base + buf.capacity() * item;
        let mut out = Vec::with_capacity(n);
        for it in &buf {
            let st = it.FmtValue.CStatus;
            if st != PDH_CSTATUS_VALID_DATA && st != PDH_CSTATUS_NEW_DATA {
                continue;
            }
            let name = read_name(it.szName, base, end);
            out.push((name, it.FmtValue.value));
        }
        out
    }
}

/// A NUL-ended UTF-16 name that PDH put inside our buffer (between `base` and `end`); empty when it points elsewhere.
fn read_name(p: *const u16, base: usize, end: usize) -> String {
    let a = p as usize;
    if p.is_null() || a < base || a >= end || a % 2 != 0 {
        return String::new();
    }
    let max = (end - a) / 2;
    // SAFETY: within our own buffer, `max` characters at most.
    let s = unsafe { std::slice::from_raw_parts(p, max) };
    let n = s.iter().position(|c| *c == 0).unwrap_or(s.len()).min(512);
    String::from_utf16_lossy(s.get(..n).unwrap_or(&[]))
}

impl Drop for Pdh {
    fn drop(&mut self) {
        // SAFETY: our query (its counters go with it); the library stays loaded until after this.
        unsafe { (self.close)(self.query) };
        let _ = &self.lib;
    }
}

/// The graphics card shown: its LUID tag (for the counters), its own memory, and its temperature's sources.
struct Gpu {
    tag: String,
    total: u64,
    name: String,
    kmt: u32,
    nvml: Option<Nvml>,
}

struct Nvml {
    _lib: Lib,
    dev: *mut c_void,
    temp: NvmlTemp,
    shutdown: NvmlShutdown,
}

impl Drop for Nvml {
    fn drop(&mut self) {
        // SAFETY: NVML was started by Nvml::open.
        unsafe { (self.shutdown)() };
    }
}

impl Nvml {
    fn open() -> Option<Nvml> {
        for path in sysmon::nvml_paths(&system_dir()) {
            let Some(lib) = Lib::at(&path) else { continue };
            let (Some(init), Some(handle), Some(temp), Some(shutdown)) = (fn_of!(lib, "nvmlInit_v2", NvmlInit), fn_of!(lib, "nvmlDeviceGetHandleByIndex_v2", NvmlHandle), fn_of!(lib, "nvmlDeviceGetTemperature", NvmlTemp), fn_of!(lib, "nvmlShutdown", NvmlShutdown)) else { continue };
            // SAFETY: NVML's documented start; then the first card's handle written to `dev`.
            if unsafe { init() } != 0 {
                continue;
            }
            let mut dev: *mut c_void = std::ptr::null_mut();
            // SAFETY: as above.
            if unsafe { handle(0, &mut dev) } != 0 || dev.is_null() {
                // SAFETY: started just above.
                unsafe { shutdown() };
                continue;
            }
            return Some(Nvml { _lib: lib, dev, temp, shutdown });
        }
        None
    }
    fn temp(&self) -> Option<f32> {
        let mut t: u32 = 0;
        // SAFETY: a live device handle; NVML_TEMPERATURE_GPU (0); `t` written.
        (unsafe { (self.temp)(self.dev, 0, &mut t) } == 0).then_some(()).and_then(|_| sysmon::plain_c(t))
    }
}

/// The real adapters DXGI lists (description, what the choice needs).
fn adapters() -> Vec<(String, Adapter)> {
    let mut out = Vec::new();
    let Some(lib) = Lib::system("dxgi.dll") else { return out };
    let Some(create) = fn_of!(lib, "CreateDXGIFactory1", CreateDXGIFactory1) else { return out };
    let mut f: *mut c_void = std::ptr::null_mut();
    // SAFETY: IDXGIFactory1's IID; the factory written to `f`.
    if unsafe { create(&IID_IDXGIFACTORY1, &mut f) } < 0 || f.is_null() {
        return out;
    }
    // SAFETY: `f` is an IDXGIFactory1: its vtable's slot 12 is EnumAdapters1, slot 2 Release.
    unsafe {
        let vt = *(f as *const *const usize);
        let enum1: EnumAdapters1 = std::mem::transmute::<usize, EnumAdapters1>(*vt.add(12));
        let release_f: Release = std::mem::transmute::<usize, Release>(*vt.add(2));
        for i in 0..16u32 {
            let mut a: *mut c_void = std::ptr::null_mut();
            let rc = enum1(f, i, &mut a);
            if rc == DXGI_ERROR_NOT_FOUND || rc < 0 || a.is_null() {
                break;
            }
            // (An IDXGIAdapter1: slot 10 GetDesc1, slot 2 Release.)
            let avt = *(a as *const *const usize);
            let desc1: GetDesc1 = std::mem::transmute::<usize, GetDesc1>(*avt.add(10));
            let release_a: Release = std::mem::transmute::<usize, Release>(*avt.add(2));
            let mut d: DXGI_ADAPTER_DESC1 = std::mem::zeroed();
            if desc1(a, &mut d) >= 0 {
                let n = d.Description.iter().position(|c| *c == 0).unwrap_or(d.Description.len());
                let name = String::from_utf16_lossy(d.Description.get(..n).unwrap_or(&[]));
                out.push((name, Adapter { vendor: d.VendorId, dedicated: d.DedicatedVideoMemory as u64, software: d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE != 0, luid_high: d.AdapterLuid.HighPart, luid_low: d.AdapterLuid.LowPart }));
            }
            release_a(a);
        }
        release_f(f);
    }
    drop(lib);
    out
}

impl Gpu {
    fn find(temp: bool) -> Option<Gpu> {
        let list = adapters();
        let only: Vec<Adapter> = list.iter().map(|x| x.1).collect();
        let i = sysmon::pick_adapter(&only)?;
        let (name, a) = list.get(i)?.clone();
        let mut g = Gpu { tag: sysmon::luid_tag(a.luid_high, a.luid_low), total: a.dedicated, name, kmt: 0, nvml: None };
        if temp {
            let mut o = D3DKMT_OPENADAPTERFROMLUID { AdapterLuid: LUID { LowPart: a.luid_low, HighPart: a.luid_high }, hAdapter: 0 };
            // SAFETY: the adapter's LUID; the handle written to `o`.
            if unsafe { D3DKMTOpenAdapterFromLuid(&mut o) } >= 0 {
                g.kmt = o.hAdapter;
            }
            // (Only when Windows' own report has no temperature: NVIDIA's library, for an NVIDIA card.)
            if g.kmt_temp().is_none() && a.vendor == sysmon::VENDOR_NVIDIA {
                g.nvml = Nvml::open();
            }
        }
        Some(g)
    }

    fn kmt_temp(&self) -> Option<f32> {
        if self.kmt == 0 {
            return None;
        }
        let mut p = D3DKMT_ADAPTER_PERFDATA::default();
        let q = D3DKMT_QUERYADAPTERINFO { hAdapter: self.kmt, Type: KMTQAITYPE_ADAPTERPERFDATA, pPrivateDriverData: (&mut p as *mut D3DKMT_ADAPTER_PERFDATA).cast(), PrivateDriverDataSize: std::mem::size_of::<D3DKMT_ADAPTER_PERFDATA>() as u32 };
        // SAFETY: our adapter handle; `p` is the struct the query type fills, its size given.
        (unsafe { D3DKMTQueryAdapterInfo(&q) } >= 0).then_some(()).and_then(|_| sysmon::kmt_c(p.Temperature))
    }

    fn temp(&self) -> Option<f32> {
        self.kmt_temp().or_else(|| self.nvml.as_ref().and_then(Nvml::temp))
    }
}

impl Drop for Gpu {
    fn drop(&mut self) {
        if self.kmt != 0 {
            let c = D3DKMT_CLOSEADAPTER { hAdapter: self.kmt };
            // SAFETY: a handle D3DKMTOpenAdapterFromLuid gave.
            unsafe { D3DKMTCloseAdapter(&c) };
        }
    }
}

/// A device opened with no access rights asked (enough for these two queries, as an ordinary user).
struct Handle(HANDLE);

impl Handle {
    fn query_only(path: &str) -> Option<Handle> {
        let w = wide(path);
        // SAFETY: a NUL-ended path; 0 access: no reading or writing of the device, queries only.
        let h = unsafe { CreateFileW(w.as_ptr(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE, std::ptr::null(), OPEN_EXISTING, 0, 0) };
        (h != 0 && h != INVALID_HANDLE_VALUE).then_some(Handle(h))
    }
    fn ioctl(&self, code: u32, inb: &[u8], out: &mut [u8]) -> Option<usize> {
        let mut ret: u32 = 0;
        // SAFETY: our handle; both buffers ours with their lengths.
        let ok = unsafe { DeviceIoControl(self.0, code, inb.as_ptr().cast(), inb.len() as u32, out.as_mut_ptr().cast(), out.len() as u32, &mut ret, std::ptr::null_mut()) };
        (ok != 0).then_some((ret as usize).min(out.len()))
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: a handle this value opened.
        unsafe { CloseHandle(self.0) };
    }
}

/// The system drive's physical disk, for its temperature.
fn system_disk() -> Option<Handle> {
    let dir = system_dir();
    let letter = dir.get(..2).filter(|d| d.ends_with(':'))?;
    let vol = Handle::query_only(&format!(r"\\.\{letter}"))?;
    let mut buf = [0u8; 256];
    let n = vol.ioctl(IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS, &[], &mut buf)?;
    let disk = sysmon::first_disk(buf.get(..n)?)?;
    Handle::query_only(&format!(r"\\.\PhysicalDrive{disk}"))
}

fn drive_temp(h: &Handle) -> Option<f32> {
    let q = STORAGE_PROPERTY_QUERY { PropertyId: STORAGE_DEVICE_TEMPERATURE_PROPERTY, QueryType: 0, AdditionalParameters: [0] };
    // SAFETY: the query struct read as its bytes (plain integers).
    let qb = unsafe { std::slice::from_raw_parts((&q as *const STORAGE_PROPERTY_QUERY).cast::<u8>(), std::mem::size_of::<STORAGE_PROPERTY_QUERY>()) };
    let mut out = [0u8; 1024];
    let n = h.ioctl(IOCTL_STORAGE_QUERY_PROPERTY, qb, &mut out)?;
    sysmon::drive_c(out.get(..n)?)
}

/// Everything the chosen values need, opened once and kept while they stay chosen.
struct Sources {
    needs: Needs,
    prev_cpu: Option<CpuTimes>,
    pdh: Option<Pdh>,
    gpu: Option<Gpu>,
    disk: Option<Handle>,
}

impl Sources {
    fn open(needs: Needs) -> Sources {
        let pdh = if needs.pdh() { Pdh::open(&needs) } else { None };
        let gpu = if needs.gpu() { Gpu::find(needs.gpu_temp) } else { None };
        let disk = if needs.drive { system_disk() } else { None };
        let prev_cpu = if needs.cpu_times { cpu_times() } else { None };
        Sources { needs, prev_cpu, pdh, gpu, disk }
    }

    fn sample(&mut self) -> Sample {
        let mut s = Sample::default();
        let n = self.needs;
        if n.cpu_times {
            let now = cpu_times();
            s.set(Metric::CpuLoad, match (self.prev_cpu, now) {
                (Some(a), Some(b)) => sysmon::cpu_load(a, b),
                _ => None,
            });
            self.prev_cpu = now;
        }
        if n.memory {
            s.set(Metric::Ram, ram());
        }
        if let Some(p) = &self.pdh {
            if p.collect() {
                if n.thermal {
                    let k: Vec<f64> = p.rows(p.thermal).into_iter().map(|r| r.1).collect();
                    s.set(Metric::CpuTemp, sysmon::zones_c(&k));
                }
                if let Some(g) = &self.gpu {
                    if n.gpu_engines {
                        s.set(Metric::GpuLoad, sysmon::gpu_load(&p.rows(p.engines), &g.tag));
                    }
                    if n.gpu_memory {
                        s.set(Metric::Vram, sysmon::vram_pct(&p.rows(p.memory), &g.tag, g.total));
                    }
                }
            }
        }
        if n.gpu_temp {
            s.set(Metric::GpuTemp, self.gpu.as_ref().and_then(Gpu::temp));
        }
        if n.drive {
            s.set(Metric::DriveTemp, self.disk.as_ref().and_then(drive_temp));
        }
        s
    }
}

/// One look at every value (the page's «what this computer gives»): two rounds 600 ms apart, so the loads have a
/// reading; and the graphics card's name. Run on the caller's thread (the page asks on a blocking task).
pub fn probe() -> (Sample, String) {
    let mut src = Sources::open(Needs::of(&Metric::ALL));
    let _ = src.sample();
    std::thread::sleep(std::time::Duration::from_millis(600));
    let s = src.sample();
    (s, src.gpu.as_ref().map(|g| g.name.clone()).unwrap_or_default())
}

/// Task Manager opened (from the system folder, through the shell so Windows may raise it as it does from the
/// taskbar's own menu). False when it could not be.
pub fn open_task_manager() -> bool {
    let Some(path) = sysmon::taskmgr_path(&system_dir()) else { return false };
    let (op, file) = (wide("open"), wide(&path));
    // SAFETY: NUL-ended strings that outlive the call; no window, parameters or folder.
    unsafe { ShellExecuteW(0, op.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) > 32 }
}

// ---------------------------------------------------------------- the sampling thread

enum Cmd {
    Set(Cfg),
    Stop,
}

/// Told the values to show each time one of them changed (on the sampling thread: keep it short).
pub type OnValues = Box<dyn Fn(Vec<Shown>) + Send + Sync>;

/// The running sampler. Dropping it (or `stop`) ends its thread.
pub struct Monitor {
    tx: Sender<Cmd>,
    thread_id: Arc<AtomicU32>,
    cfg: std::sync::Mutex<Cfg>,
}

// (The display's and the session's state, set by the window procedure of the sampling thread's hidden window.)
static DISPLAY_OFF: AtomicBool = AtomicBool::new(false);
static LOCKED: AtomicBool = AtomicBool::new(false);

impl Monitor {
    /// Starts the sampling thread with a first configuration. None when the thread cannot be made.
    pub fn start(cfg: Cfg, on_values: OnValues) -> Option<Monitor> {
        let (tx, rx) = channel::<Cmd>();
        let thread_id = Arc::new(AtomicU32::new(0));
        let t2 = thread_id.clone();
        let _ = tx.send(Cmd::Set(cfg.clone()));
        std::thread::Builder::new().name("kt-sysmon".into()).spawn(move || run(rx, t2, on_values)).ok()?;
        Some(Monitor { tx, thread_id, cfg: std::sync::Mutex::new(cfg) })
    }

    /// A new configuration (nothing happens when it is the same).
    pub fn set(&self, cfg: Cfg) {
        {
            let mut g = self.cfg.lock().unwrap_or_else(|e| e.into_inner());
            if *g == cfg {
                return;
            }
            *g = cfg.clone();
        }
        let _ = self.tx.send(Cmd::Set(cfg));
        self.wake();
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

impl Drop for Monitor {
    fn drop(&mut self) {
        self.stop();
    }
}

unsafe extern "system" fn wndproc(h: HWND, m: u32, w: usize, l: isize) -> isize {
    match m {
        WM_POWERBROADCAST if w == PBT_POWERSETTINGCHANGE && l != 0 => {
            // (POWERBROADCAST_SETTING: the setting's GUID, the data's length, then the data — a DWORD here.)
            let p = l as *const u8;
            let mut g = GUID::default();
            std::ptr::copy_nonoverlapping(p, (&mut g as *mut GUID).cast::<u8>(), 16);
            let len = std::ptr::read_unaligned(p.add(16).cast::<u32>());
            if g == GUID_CONSOLE_DISPLAY_STATE && len >= 4 {
                let state = std::ptr::read_unaligned(p.add(20).cast::<u32>());
                let mut gate = Gate::default();
                gate.display(state);
                DISPLAY_OFF.store(!gate.display_on, Ordering::SeqCst);
            }
            1
        }
        WM_WTSSESSION_CHANGE => {
            if w == WTS_SESSION_LOCK {
                LOCKED.store(true, Ordering::SeqCst);
            } else if w == WTS_SESSION_UNLOCK {
                LOCKED.store(false, Ordering::SeqCst);
            }
            0
        }
        _ => DefWindowProcW(h, m, w, l),
    }
}

fn run(rx: Receiver<Cmd>, thread_id: Arc<AtomicU32>, on_values: OnValues) {
    let mut msg = MSG { hwnd: 0, message: 0, wParam: 0, lParam: 0, time: 0, pt: POINT { x: 0, y: 0 }, lPrivate: 0 };
    // SAFETY: makes this thread's message queue, so PostThreadMessageW reaches it from now on.
    unsafe { PeekMessageW(&mut msg, 0, 0, 0, PM_NOREMOVE) };
    // SAFETY: no arguments.
    thread_id.store(unsafe { GetCurrentThreadId() }, Ordering::SeqCst);
    // (A hidden window of our own: the display's and the session's notices come to it.)
    let class = wide("KurokawaToolsSysmon");
    // SAFETY: this module's handle; the class names our window procedure; registered once (a second time fails harmlessly).
    let inst = unsafe { GetModuleHandleW(std::ptr::null()) };
    let wc = WNDCLASSEXW { cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32, style: 0, lpfnWndProc: Some(wndproc), cbClsExtra: 0, cbWndExtra: 0, hInstance: inst, hIcon: 0, hCursor: 0, hbrBackground: 0, lpszMenuName: std::ptr::null(), lpszClassName: class.as_ptr(), hIconSm: 0 };
    // SAFETY: as above.
    unsafe { RegisterClassExW(&wc) };
    let name = wide("Kurokawa Tools system");
    // SAFETY: our class; never shown.
    let hwnd = unsafe { CreateWindowExW(WS_EX_TOOLWINDOW, class.as_ptr(), name.as_ptr(), WS_POPUP, 0, 0, 0, 0, 0, 0, inst, std::ptr::null()) };
    DISPLAY_OFF.store(false, Ordering::SeqCst);
    LOCKED.store(false, Ordering::SeqCst);
    let mut power: isize = 0;
    let wts = Lib::system("wtsapi32.dll");
    let unreg = wts.as_ref().and_then(|l| fn_of!(l, "WTSUnRegisterSessionNotification", WTSUnRegisterSessionNotification));
    let mut wts_on = false;
    if hwnd != 0 {
        // SAFETY: our window; the display state's GUID.
        power = unsafe { RegisterPowerSettingNotification(hwnd, &GUID_CONSOLE_DISPLAY_STATE, DEVICE_NOTIFY_WINDOW_HANDLE) };
        if let Some(reg) = wts.as_ref().and_then(|l| fn_of!(l, "WTSRegisterSessionNotification", WTSRegisterSessionNotification)) {
            // SAFETY: our window, this session only.
            wts_on = unsafe { reg(hwnd, NOTIFY_FOR_THIS_SESSION) } != 0;
        }
    }
    let mut cfg = Cfg::default();
    let mut src: Option<Sources> = None;
    let mut watch = Watch::default();
    let mut timer: usize = 0;
    let mut every: u64 = 0;
    let mut stop = false;
    loop {
        // (Commands first: a new configuration reopens only the sources whose need changed, and resets the timer.)
        let mut changed = false;
        while let Ok(c) = rx.try_recv() {
            match c {
                Cmd::Set(c) => {
                    cfg = c;
                    changed = true;
                }
                Cmd::Stop => stop = true,
            }
        }
        if stop {
            break;
        }
        if changed {
            let needs = Needs::of(&cfg.shown);
            if src.as_ref().map(|s| s.needs) != Some(needs) {
                src = needs.any().then(|| Sources::open(needs));
            }
            let e = sysmon::every_s(cfg.every_s);
            if e != every || timer == 0 {
                if timer != 0 {
                    // SAFETY: the thread's own timer.
                    unsafe { KillTimer(0, timer) };
                }
                every = e;
                // SAFETY: no window: WM_TIMER comes to this thread's queue.
                timer = unsafe { SetTimer(0, TIMER_ID, (every * 1000) as u32, std::ptr::null()) };
            }
            // (Said again in the new units and marks at once, from the next sample.)
            watch.forget();
        }
        // SAFETY: `msg` is ours; 0 or -1 ends the loop.
        let r = unsafe { GetMessageW(&mut msg, 0, 0, 0) };
        if r == 0 || r == -1 {
            break;
        }
        if msg.hwnd == 0 && msg.message == WM_APP_CMD {
            continue;
        }
        if msg.hwnd == 0 && msg.message == WM_TIMER {
            let gate = Gate { display_on: !DISPLAY_OFF.load(Ordering::SeqCst), locked: LOCKED.load(Ordering::SeqCst) };
            if gate.sampling(&cfg) {
                if let Some(s) = src.as_mut() {
                    let values = sysmon::shown(&s.sample(), &cfg);
                    if watch.changed(&values) {
                        on_values(values);
                    }
                }
            }
            continue;
        }
        // SAFETY: a message this thread received (our window's notices go to wndproc).
        unsafe { DispatchMessageW(&msg) };
    }
    if timer != 0 {
        // SAFETY: the thread's own timer.
        unsafe { KillTimer(0, timer) };
    }
    drop(src);
    if hwnd != 0 {
        if wts_on {
            if let Some(u) = unreg {
                // SAFETY: registered above for this window.
                unsafe { u(hwnd) };
            }
        }
        if power != 0 {
            // SAFETY: the registration made above.
            unsafe { UnregisterPowerSettingNotification(power) };
        }
        // SAFETY: our own window, on the thread that made it.
        unsafe { DestroyWindow(hwnd) };
    }
    drop(wts);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_pointer_width = "64")]
    fn the_sdk_sizes() {
        assert_eq!(std::mem::size_of::<MEMORYSTATUSEX>(), 64);
        assert_eq!(std::mem::size_of::<FILETIME>(), 8);
        assert_eq!(std::mem::size_of::<GUID>(), 16);
        assert_eq!(std::mem::size_of::<LUID>(), 8);
        assert_eq!(std::mem::size_of::<DXGI_ADAPTER_DESC1>(), 312);
        assert_eq!(std::mem::size_of::<D3DKMT_OPENADAPTERFROMLUID>(), 12);
        assert_eq!(std::mem::size_of::<D3DKMT_QUERYADAPTERINFO>(), 24);
        assert_eq!(std::mem::size_of::<D3DKMT_ADAPTER_PERFDATA>(), 64);
        assert_eq!(std::mem::size_of::<PDH_FMT_COUNTERVALUE>(), 16);
        assert_eq!(std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>(), 24);
        assert_eq!(std::mem::size_of::<STORAGE_PROPERTY_QUERY>(), 12);
        assert_eq!(std::mem::size_of::<MSG>(), 48);
        assert_eq!(std::mem::size_of::<WNDCLASSEXW>(), 80);
    }

    #[test]
    #[cfg(target_pointer_width = "64")]
    fn the_sdk_offsets() {
        let d: DXGI_ADAPTER_DESC1 = unsafe { std::mem::zeroed() };
        let base = &d as *const _ as usize;
        assert_eq!(&d.VendorId as *const _ as usize - base, 256);
        assert_eq!(&d.DedicatedVideoMemory as *const _ as usize - base, 272);
        assert_eq!(&d.AdapterLuid as *const _ as usize - base, 296);
        assert_eq!(&d.Flags as *const _ as usize - base, 304);
        let p = D3DKMT_ADAPTER_PERFDATA::default();
        let pb = &p as *const _ as usize;
        assert_eq!(&p.MemoryFrequency as *const _ as usize - pb, 8);
        assert_eq!(&p.FanRPM as *const _ as usize - pb, 48);
        assert_eq!(&p.Temperature as *const _ as usize - pb, 56);
        assert_eq!(&p.PowerStateOverride as *const _ as usize - pb, 60);
    }

    #[test]
    fn names_only_read_within_the_buffer() {
        let buf: Vec<u16> = "pid_1_luid\0".encode_utf16().collect();
        let base = buf.as_ptr() as usize;
        let end = base + buf.len() * 2;
        assert_eq!(read_name(buf.as_ptr(), base, end), "pid_1_luid");
        assert_eq!(read_name(std::ptr::null(), base, end), "");
        assert_eq!(read_name(buf.as_ptr(), base + 2, end), "", "before the buffer");
        let unended: Vec<u16> = "abc".encode_utf16().collect();
        let b2 = unended.as_ptr() as usize;
        assert_eq!(read_name(unended.as_ptr(), b2, b2 + 6), "abc", "no NUL: stops at the buffer's end");
    }
}
