// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery), piece 3: the Windows side of connecting Bluetooth devices
// (connect.rs's BtPlatform). Written for Tools from the Windows SDK's documented calls (nothing of Wireless Device
// Battery Monitor: the original has no connecting). Copyright (C) 2026 Kurokawa contributors.
// - The radio: BluetoothFindFirstRadio; none found while a Bluetooth radio is in Device Manager — Bluetooth is off;
//   none at all — missing; found but not taking connections (BluetoothIsConnectable) — off.
// - The paired list: BluetoothFindFirstDevice without an inquiry (the system's own list) and each device's installed
//   services (BluetoothEnumerateInstalledServices) — read only.
// - A scan round: BluetoothFindFirstDevice with an inquiry of a few seconds, unknown devices only.
// - Connect (sound devices only): Windows' own audio reconnect, KSPROPERTY_ONESHOT_RECONNECT on the device's Bluetooth
//   sound filter (the sound settings' Connect) — no service is ever turned off or on, nothing is installed or removed.
// - Disconnect: KSPROPERTY_ONESHOT_DISCONNECT for sound devices, else IOCTL_BTH_DISCONNECT_DEVICE on the radio (drops
//   the link, keeps the pairing).
// - Pair: BluetoothAuthenticateDeviceEx with no callback of ours registered, so Windows shows its own window (its
//   numeric comparison, passkey or confirmation) and the user answers it there; no PIN is made up, stored or sent here.
// Each call is made on connect.rs's threads with a deadline; a call here that blocks past it is left to finish alone.
// UNVERIFIED here: compiled only on Windows (type-checked elsewhere, layouts tested in stdroots/winffi.rs); real radios
// and devices decide.
use super::ffi::*;
use crate::bluetooth::BtNode;
use crate::connect::{self, end_of_win32, Addr, BtPlatform, Classic, End, Radio, Svc};
use std::ffi::c_void;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::time::{Duration, Instant};

struct Owned(HANDLE);
impl Drop for Owned {
    fn drop(&mut self) {
        if self.0 != INVALID_HANDLE_VALUE && self.0 != 0 {
            unsafe {
                CloseHandle(self.0);
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

/// The first radio, open (closed on drop).
fn radio() -> Option<Owned> {
    let p = BLUETOOTH_FIND_RADIO_PARAMS { dwSize: std::mem::size_of::<BLUETOOTH_FIND_RADIO_PARAMS>() as u32 };
    let mut h: HANDLE = 0;
    let f = unsafe { BluetoothFindFirstRadio(&p, &mut h) };
    if f == 0 {
        return None;
    }
    unsafe { BluetoothFindRadioClose(f) };
    if h == 0 || h == INVALID_HANDLE_VALUE {
        None
    } else {
        Some(Owned(h))
    }
}

/// Whether Device Manager has a Bluetooth radio (its setup class), whatever its state.
fn radio_installed() -> bool {
    let di = DevInfo(unsafe { SetupDiGetClassDevsW(&GUID_DEVCLASS_BLUETOOTH, std::ptr::null(), 0, DIGCF_PRESENT) });
    if di.0 == INVALID_HANDLE_VALUE {
        return false;
    }
    for i in 0..256u32 {
        let mut dd = SP_DEVINFO_DATA { cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32, ..Default::default() };
        if unsafe { SetupDiEnumDeviceInfo(di.0, i, &mut dd) } == 0 {
            break;
        }
        let mut inst = [0u16; 512];
        if unsafe { SetupDiGetDeviceInstanceIdW(di.0, &dd, inst.as_mut_ptr(), inst.len() as u32, std::ptr::null_mut()) } == 0 {
            continue;
        }
        // (The class also holds the paired devices' own nodes: the radio is the one on a bus — USB, PCI, ….)
        let id = from_wide(&inst).to_ascii_uppercase();
        if !id.starts_with("BTH") {
            return true;
        }
    }
    false
}

fn services(h: HANDLE, info: &BLUETOOTH_DEVICE_INFO) -> Vec<Svc> {
    let mut guids = [GUID::default(); 32];
    let mut n = guids.len() as u32;
    let r = unsafe { BluetoothEnumerateInstalledServices(h, info, &mut n, guids.as_mut_ptr()) };
    if r != ERROR_SUCCESS {
        return Vec::new();
    }
    let mut out: Vec<Svc> = guids[..(n as usize).min(guids.len())].iter().filter_map(|g| connect::uuid16_of(g.data1, g.data2, g.data3, g.data4)).filter_map(connect::svc_of_uuid16).collect();
    out.sort();
    out.dedup();
    out
}

fn classic_of(info: &BLUETOOTH_DEVICE_INFO, svcs: Vec<Svc>) -> Classic {
    Classic {
        addr: info.Address & 0xFFFF_FFFF_FFFF,
        name: from_wide(&info.szName).trim().to_string(),
        cod: info.ulClassofDevice,
        connected: info.fConnected != 0,
        remembered: info.fRemembered != 0,
        authenticated: info.fAuthenticated != 0,
        services: svcs,
    }
}

/// The devices a search returns (with their services when `with_services`).
fn search(h: HANDLE, p: &BLUETOOTH_DEVICE_SEARCH_PARAMS, with_services: bool) -> Vec<Classic> {
    let mut out = Vec::new();
    let mut info = BLUETOOTH_DEVICE_INFO::new(0);
    let f = unsafe { BluetoothFindFirstDevice(p, &mut info) };
    if f == 0 {
        return out;
    }
    for _ in 0..256 {
        let svcs = if with_services { services(h, &info) } else { Vec::new() };
        out.push(classic_of(&info, svcs));
        info = BLUETOOTH_DEVICE_INFO::new(0);
        if unsafe { BluetoothFindNextDevice(f, &mut info) } == 0 {
            break;
        }
    }
    unsafe { BluetoothFindDeviceClose(f) };
    out
}

fn info_of(h: HANDLE, addr: Addr) -> Option<BLUETOOTH_DEVICE_INFO> {
    let mut info = BLUETOOTH_DEVICE_INFO::new(addr);
    if unsafe { BluetoothGetDeviceInfo(h, &mut info) } == ERROR_SUCCESS {
        Some(info)
    } else {
        None
    }
}

/// The device's container id, from its own node (BTHENUM\DEV_<address>).
fn container_of(addr: Addr) -> Option<String> {
    super::bt::nodes().into_iter().find(|n| connect::addr_from_instance(&n.instance_id).map(|x| x.0) == Some(addr)).and_then(|n| n.container)
}

/// The device's Bluetooth sound filters (their interface paths), best first.
fn audio_filters(container: &str) -> Vec<String> {
    let mut found: Vec<(u8, String)> = Vec::new();
    let di = DevInfo(unsafe { SetupDiGetClassDevsW(&KSCATEGORY_AUDIO, std::ptr::null(), 0, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE) });
    if di.0 == INVALID_HANDLE_VALUE {
        return Vec::new();
    }
    for i in 0..1024u32 {
        let mut ifd = SP_DEVICE_INTERFACE_DATA { cbSize: std::mem::size_of::<SP_DEVICE_INTERFACE_DATA>() as u32, ..Default::default() };
        if unsafe { SetupDiEnumDeviceInterfaces(di.0, std::ptr::null(), &KSCATEGORY_AUDIO, i, &mut ifd) } == 0 {
            break;
        }
        let mut need = 0u32;
        unsafe { SetupDiGetDeviceInterfaceDetailW(di.0, &ifd, std::ptr::null_mut(), 0, &mut need, std::ptr::null_mut()) };
        if need < 8 || need > 64 * 1024 {
            continue;
        }
        let mut buf = vec![0u32; (need as usize + 3) / 4 + 1];
        buf[0] = DETAIL_CB_SIZE;
        let mut dd = SP_DEVINFO_DATA { cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32, ..Default::default() };
        if unsafe { SetupDiGetDeviceInterfaceDetailW(di.0, &ifd, buf.as_mut_ptr() as *mut c_void, need, std::ptr::null_mut(), &mut dd) } == 0 {
            continue;
        }
        let mut inst = [0u16; 512];
        if unsafe { SetupDiGetDeviceInstanceIdW(di.0, &dd, inst.as_mut_ptr(), inst.len() as u32, std::ptr::null_mut()) } == 0 {
            continue;
        }
        let Some(rank) = connect::audio_node_rank(&from_wide(&inst)) else { continue };
        let mut g = GUID::default();
        let mut t = 0u32;
        let ok = unsafe { SetupDiGetDevicePropertyW(di.0, &dd, &DEVPKEY_Device_ContainerId, &mut t, &mut g as *mut GUID as *mut u8, std::mem::size_of::<GUID>() as u32, std::ptr::null_mut(), 0) };
        if ok == 0 || t != DEVPROP_TYPE_GUID || !g.braced().eq_ignore_ascii_case(container) {
            continue;
        }
        let words: &[u16] = unsafe { std::slice::from_raw_parts((buf.as_ptr() as *const u8).add(4) as *const u16, (need as usize - 4) / 2) };
        let path = from_wide(words);
        if !path.is_empty() {
            found.push((rank, path));
        }
    }
    found.sort();
    found.into_iter().map(|x| x.1).collect()
}

/// KSPROPERTY_ONESHOT_RECONNECT / _DISCONNECT on one sound filter: Windows' error number (0: done).
fn oneshot(path: &str, id: u32) -> u32 {
    let w = wide(path);
    let h = Owned(unsafe { CreateFileW(w.as_ptr(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, std::ptr::null(), OPEN_EXISTING, 0, 0) });
    if h.0 == INVALID_HANDLE_VALUE || h.0 == 0 {
        return unsafe { GetLastError() };
    }
    let p = KSPROPERTY { Set: KSPROPSETID_BtAudio, Id: id, Flags: KSPROPERTY_TYPE_GET };
    let mut ret = 0u32;
    let ok = unsafe { DeviceIoControl(h.0, IOCTL_KS_PROPERTY, &p as *const KSPROPERTY as *const c_void, std::mem::size_of::<KSPROPERTY>() as u32, std::ptr::null_mut(), 0, &mut ret, std::ptr::null_mut()) };
    if ok != 0 {
        0
    } else {
        unsafe { GetLastError() }
    }
}

/// Waits (polling every 400 ms, never past `deadline` less a margin) for the device's connected flag to be `want`.
fn wait_connected(h: HANDLE, addr: Addr, want: bool, deadline: Instant) -> bool {
    let stop = deadline.checked_sub(Duration::from_millis(300)).unwrap_or(deadline);
    loop {
        if info_of(h, addr).map_or(false, |i| (i.fConnected != 0) == want) {
            return true;
        }
        if Instant::now() + Duration::from_millis(400) >= stop {
            return false;
        }
        std::thread::sleep(Duration::from_millis(400));
    }
}

/// Windows' Bluetooth, for connect.rs.
#[derive(Default)]
pub struct WinBt {
    /// The window Windows' pairing window belongs to (0: its own, top level).
    parent: AtomicIsize,
}

impl WinBt {
    pub fn new() -> WinBt {
        WinBt::default()
    }
    pub fn set_parent(&self, hwnd: isize) {
        self.parent.store(hwnd, Ordering::SeqCst);
    }
}

impl BtPlatform for WinBt {
    fn radio(&self) -> Radio {
        match radio() {
            Some(h) => {
                if unsafe { BluetoothIsConnectable(h.0) } != 0 {
                    Radio::On
                } else {
                    Radio::Off
                }
            }
            None if radio_installed() => Radio::Off,
            None => Radio::Missing,
        }
    }

    fn paired(&self) -> Vec<Classic> {
        let Some(h) = radio() else { return Vec::new() };
        let p = BLUETOOTH_DEVICE_SEARCH_PARAMS {
            dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_SEARCH_PARAMS>() as u32,
            fReturnAuthenticated: 1,
            fReturnRemembered: 1,
            fReturnUnknown: 0,
            fReturnConnected: 1,
            fIssueInquiry: 0,
            cTimeoutMultiplier: 0,
            hRadio: h.0,
        };
        search(h.0, &p, true)
    }

    fn nodes(&self) -> Vec<BtNode> {
        super::bt::nodes()
    }

    fn inquire(&self, ms: u64) -> Vec<Classic> {
        let Some(h) = radio() else { return Vec::new() };
        let p = BLUETOOTH_DEVICE_SEARCH_PARAMS {
            dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_SEARCH_PARAMS>() as u32,
            fReturnAuthenticated: 0,
            fReturnRemembered: 0,
            fReturnUnknown: 1,
            fReturnConnected: 0,
            fIssueInquiry: 1,
            cTimeoutMultiplier: connect::inquiry_units(ms),
            hRadio: h.0,
        };
        search(h.0, &p, false)
    }

    fn connect(&self, addr: Addr, deadline: Instant) -> End {
        let Some(h) = radio() else { return End::NoRadio };
        if info_of(h.0, addr).map_or(false, |i| i.fConnected != 0) {
            return End::Done;
        }
        let Some(c) = container_of(addr) else { return End::Settings };
        let filters = audio_filters(&c);
        if filters.is_empty() {
            return End::Settings;
        }
        let mut last = 0u32;
        for f in &filters {
            last = oneshot(f, KSPROPERTY_ONESHOT_RECONNECT);
            if last == 0 {
                break;
            }
        }
        if last != 0 {
            return end_of_win32(last);
        }
        if wait_connected(h.0, addr, true, deadline) {
            End::Done
        } else {
            End::Unreachable
        }
    }

    fn disconnect(&self, addr: Addr, deadline: Instant) -> End {
        let Some(h) = radio() else { return End::NoRadio };
        if info_of(h.0, addr).map_or(false, |i| i.fConnected == 0) {
            return End::Done;
        }
        // (Sound devices through Windows' own audio disconnect; every other one by dropping the link.)
        let filters = container_of(addr).map(|c| audio_filters(&c)).unwrap_or_default();
        let mut done = false;
        for f in &filters {
            if oneshot(f, KSPROPERTY_ONESHOT_DISCONNECT) == 0 {
                done = true;
            }
        }
        if !done {
            let a: u64 = addr;
            let mut ret = 0u32;
            let ok = unsafe { DeviceIoControl(h.0, IOCTL_BTH_DISCONNECT_DEVICE, &a as *const u64 as *const c_void, 8, std::ptr::null_mut(), 0, &mut ret, std::ptr::null_mut()) };
            if ok == 0 {
                return end_of_win32(unsafe { GetLastError() });
            }
        }
        if wait_connected(h.0, addr, false, deadline) {
            End::Done
        } else {
            End::TimedOut
        }
    }

    fn pair(&self, addr: Addr, _deadline: Instant) -> End {
        let Some(h) = radio() else { return End::NoRadio };
        let Some(mut info) = info_of(h.0, addr) else { return End::Unreachable };
        if info.fAuthenticated != 0 {
            return End::Done;
        }
        // (Blocks while Windows' window is open: the user's answer, or our deadline in connect.rs.)
        let r = unsafe { BluetoothAuthenticateDeviceEx(self.parent.load(Ordering::SeqCst), h.0, &mut info, std::ptr::null(), MITMProtectionNotRequiredGeneralBonding) };
        match r {
            // (ERROR_NO_MORE_ITEMS: already paired.)
            ERROR_SUCCESS | ERROR_NO_MORE_ITEMS => End::Done,
            c => end_of_win32(c),
        }
    }
}
