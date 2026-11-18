// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the Windows calls the readers use, declared by hand from the Windows
// SDK's headers (setupapi.h, hidsdi.h, hidpi.h, cfgmgr32.h, xinput.h, devpkey.h; piece 3: bluetoothapis.h, bthioctl.h,
// ks.h, ksmedia.h), linked by DLL name (raw-dylib: no import library needed). Kept to what the pieces need.
// Copyright (C) 2026 Kurokawa contributors.
// The link attributes apply on Windows only, so the module is type-checked on any system (stdroots/wincheck.rs).
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals, clippy::upper_case_acronyms, dead_code)]
use std::ffi::c_void;

pub type BOOL = i32;
pub type BOOLEAN = u8;
pub type HANDLE = isize;
pub type HDEVINFO = isize;
pub type NTSTATUS = i32;
pub type CONFIGRET = u32;

pub const INVALID_HANDLE_VALUE: isize = -1;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GUID {
    pub data1: u32,
    pub data2: u16,
    pub data3: u16,
    pub data4: [u8; 8],
}

impl GUID {
    pub const fn new(data1: u32, data2: u16, data3: u16, data4: [u8; 8]) -> GUID {
        GUID { data1, data2, data3, data4 }
    }
    /// «{8C7ED206-3F8A-4827-B3AB-AE9E1FAEFC6C}», as StringFromGUID2 writes it.
    pub fn braced(&self) -> String {
        let d = self.data4;
        format!(
            "{{{:08X}-{:04X}-{:04X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}}}",
            self.data1, self.data2, self.data3, d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7]
        )
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct SP_DEVINFO_DATA {
    pub cbSize: u32,
    pub ClassGuid: GUID,
    pub DevInst: u32,
    pub Reserved: usize,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct SP_DEVICE_INTERFACE_DATA {
    pub cbSize: u32,
    pub InterfaceClassGuid: GUID,
    pub Flags: u32,
    pub Reserved: usize,
}

/// SP_DEVICE_INTERFACE_DETAIL_DATA_W's cbSize: the struct's size, 8 on 64-bit Windows and 6 on 32-bit (the path then
/// follows at offset 4).
pub const DETAIL_CB_SIZE: u32 = if cfg!(target_pointer_width = "64") { 8 } else { 6 };

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct DEVPROPKEY {
    pub fmtid: GUID,
    pub pid: u32,
}

pub const DIGCF_PRESENT: u32 = 0x02;
pub const DIGCF_ALLCLASSES: u32 = 0x04;
pub const DIGCF_DEVICEINTERFACE: u32 = 0x10;

pub const DEVPROP_TYPE_BYTE: u32 = 0x03;
pub const DEVPROP_TYPE_UINT32: u32 = 0x07;
pub const DEVPROP_TYPE_GUID: u32 = 0x0D;
pub const DEVPROP_TYPE_BOOLEAN: u32 = 0x11;
pub const DEVPROP_TYPE_STRING: u32 = 0x12;
pub const DEVPROP_TYPE_STRING_LIST: u32 = 0x2012;
pub const DEVPROP_FALSE: u8 = 0x00;

// devpkey.h
pub const DEVPKEY_Device_DeviceDesc: DEVPROPKEY = DEVPROPKEY { fmtid: GUID::new(0xA45C254E, 0xDF1C, 0x4EFD, [0x80, 0x20, 0x67, 0xD1, 0x46, 0xA8, 0x50, 0xE0]), pid: 2 };
pub const DEVPKEY_Device_FriendlyName: DEVPROPKEY = DEVPROPKEY { fmtid: GUID::new(0xA45C254E, 0xDF1C, 0x4EFD, [0x80, 0x20, 0x67, 0xD1, 0x46, 0xA8, 0x50, 0xE0]), pid: 14 };
pub const DEVPKEY_Device_ContainerId: DEVPROPKEY = DEVPROPKEY { fmtid: GUID::new(0x8C7ED206, 0x3F8A, 0x4827, [0xB3, 0xAB, 0xAE, 0x9E, 0x1F, 0xAE, 0xFC, 0x6C]), pid: 2 };
pub const DEVPKEY_DeviceContainer_Category: DEVPROPKEY = DEVPROPKEY { fmtid: GUID::new(0x78C34FC8, 0x104A, 0x4ACA, [0x9E, 0xA4, 0x52, 0x4D, 0x52, 0x99, 0x6E, 0x57]), pid: 90 };
// (The original's keys, generic.cpp: the Bluetooth battery level, the «connected» flag, the Class of Device.)
pub const DEVPKEY_Bluetooth_Battery: DEVPROPKEY = DEVPROPKEY { fmtid: GUID::new(0x104EA319, 0x6EE2, 0x4701, [0xBD, 0x47, 0x8D, 0xDB, 0xF4, 0x25, 0xBB, 0xE5]), pid: 2 };
pub const DEVPKEY_Device_IsConnected: DEVPROPKEY = DEVPROPKEY { fmtid: GUID::new(0x83DA6326, 0x97A6, 0x4088, [0x94, 0x53, 0xA1, 0x92, 0x3F, 0x57, 0x3B, 0x29]), pid: 15 };
pub const DEVPKEY_Bluetooth_ClassOfDevice: DEVPROPKEY = DEVPROPKEY { fmtid: GUID::new(0x2BD67D8B, 0x8BEB, 0x48D5, [0x87, 0xE0, 0x6C, 0xDA, 0x34, 0x28, 0x04, 0x0A]), pid: 10 };

#[cfg_attr(windows, link(name = "setupapi", kind = "raw-dylib"))]
extern "system" {
    pub fn SetupDiGetClassDevsW(ClassGuid: *const GUID, Enumerator: *const u16, hwndParent: isize, Flags: u32) -> HDEVINFO;
    pub fn SetupDiCreateDeviceInfoList(ClassGuid: *const GUID, hwndParent: isize) -> HDEVINFO;
    pub fn SetupDiDestroyDeviceInfoList(DeviceInfoSet: HDEVINFO) -> BOOL;
    pub fn SetupDiEnumDeviceInterfaces(DeviceInfoSet: HDEVINFO, DeviceInfoData: *const SP_DEVINFO_DATA, InterfaceClassGuid: *const GUID, MemberIndex: u32, DeviceInterfaceData: *mut SP_DEVICE_INTERFACE_DATA) -> BOOL;
    pub fn SetupDiGetDeviceInterfaceDetailW(DeviceInfoSet: HDEVINFO, DeviceInterfaceData: *const SP_DEVICE_INTERFACE_DATA, DeviceInterfaceDetailData: *mut c_void, DeviceInterfaceDetailDataSize: u32, RequiredSize: *mut u32, DeviceInfoData: *mut SP_DEVINFO_DATA) -> BOOL;
    pub fn SetupDiEnumDeviceInfo(DeviceInfoSet: HDEVINFO, MemberIndex: u32, DeviceInfoData: *mut SP_DEVINFO_DATA) -> BOOL;
    pub fn SetupDiGetDeviceInstanceIdW(DeviceInfoSet: HDEVINFO, DeviceInfoData: *const SP_DEVINFO_DATA, DeviceInstanceId: *mut u16, DeviceInstanceIdSize: u32, RequiredSize: *mut u32) -> BOOL;
    pub fn SetupDiGetDevicePropertyW(DeviceInfoSet: HDEVINFO, DeviceInfoData: *const SP_DEVINFO_DATA, PropertyKey: *const DEVPROPKEY, PropertyType: *mut u32, PropertyBuffer: *mut u8, PropertyBufferSize: u32, RequiredSize: *mut u32, Flags: u32) -> BOOL;
}

pub const CR_SUCCESS: CONFIGRET = 0;
pub const DN_HAS_PROBLEM: u32 = 0x0000_0400;

// cfgmgr32.h: device interface arrival / removal, with a callback (no window needed).
pub type HCMNOTIFICATION = isize;
pub const CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE: i32 = 0;
pub const CM_NOTIFY_FILTER_FLAG_ALL_INTERFACE_CLASSES: u32 = 0x1;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct CM_NOTIFY_FILTER {
    pub cbSize: u32,
    pub Flags: u32,
    pub FilterType: i32,
    pub Reserved: u32,
    /// The union's largest member (DeviceInstance's InstanceId[200]); for DEVICEINTERFACE its first 16 bytes are the
    /// interface class GUID.
    pub u: [u16; 200],
}

pub type PCM_NOTIFY_CALLBACK = unsafe extern "system" fn(hNotify: HCMNOTIFICATION, Context: *const c_void, Action: i32, EventData: *const c_void, EventDataSize: u32) -> u32;

#[cfg_attr(windows, link(name = "cfgmgr32", kind = "raw-dylib"))]
extern "system" {
    pub fn CM_Get_DevNode_Status(pulStatus: *mut u32, pulProblemNumber: *mut u32, dnDevInst: u32, ulFlags: u32) -> CONFIGRET;
    pub fn CM_Register_Notification(pFilter: *const CM_NOTIFY_FILTER, pContext: *const c_void, pCallback: PCM_NOTIFY_CALLBACK, pNotifyContext: *mut HCMNOTIFICATION) -> CONFIGRET;
    pub fn CM_Unregister_Notification(NotifyContext: HCMNOTIFICATION) -> CONFIGRET;
}

pub const FILE_SHARE_READ: u32 = 0x1;
pub const FILE_SHARE_WRITE: u32 = 0x2;
pub const OPEN_EXISTING: u32 = 3;
pub const GENERIC_READ: u32 = 0x8000_0000;
pub const GENERIC_WRITE: u32 = 0x4000_0000;

#[cfg_attr(windows, link(name = "kernel32", kind = "raw-dylib"))]
extern "system" {
    pub fn CreateFileW(lpFileName: *const u16, dwDesiredAccess: u32, dwShareMode: u32, lpSecurityAttributes: *const c_void, dwCreationDisposition: u32, dwFlagsAndAttributes: u32, hTemplateFile: HANDLE) -> HANDLE;
    pub fn CloseHandle(hObject: HANDLE) -> BOOL;
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct HIDD_ATTRIBUTES {
    pub Size: u32,
    pub VendorID: u16,
    pub ProductID: u16,
    pub VersionNumber: u16,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct HIDP_CAPS {
    pub Usage: u16,
    pub UsagePage: u16,
    pub InputReportByteLength: u16,
    pub OutputReportByteLength: u16,
    pub FeatureReportByteLength: u16,
    pub Reserved: [u16; 17],
    pub NumberLinkCollectionNodes: u16,
    pub NumberInputButtonCaps: u16,
    pub NumberInputValueCaps: u16,
    pub NumberInputDataIndices: u16,
    pub NumberOutputButtonCaps: u16,
    pub NumberOutputValueCaps: u16,
    pub NumberOutputDataIndices: u16,
    pub NumberFeatureButtonCaps: u16,
    pub NumberFeatureValueCaps: u16,
    pub NumberFeatureDataIndices: u16,
}

/// HIDP_VALUE_CAPS (72 bytes). The last 16 bytes are the Range / NotRange union: UsageMin or Usage first.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct HIDP_VALUE_CAPS {
    pub UsagePage: u16,
    pub ReportID: u8,
    pub IsAlias: BOOLEAN,
    pub BitField: u16,
    pub LinkCollection: u16,
    pub LinkUsage: u16,
    pub LinkUsagePage: u16,
    pub IsRange: BOOLEAN,
    pub IsStringRange: BOOLEAN,
    pub IsDesignatorRange: BOOLEAN,
    pub IsAbsolute: BOOLEAN,
    pub HasNull: BOOLEAN,
    pub Reserved: u8,
    pub BitSize: u16,
    pub ReportCount: u16,
    pub Reserved2: [u16; 5],
    pub UnitsExp: u32,
    pub Units: u32,
    pub LogicalMin: i32,
    pub LogicalMax: i32,
    pub PhysicalMin: i32,
    pub PhysicalMax: i32,
    pub Union: [u16; 8],
}

pub const HidP_Input: i32 = 0;
pub const HidP_Output: i32 = 1;
pub const HidP_Feature: i32 = 2;
pub const HIDP_STATUS_SUCCESS: NTSTATUS = 0x0011_0000;

#[cfg_attr(windows, link(name = "hid", kind = "raw-dylib"))]
extern "system" {
    pub fn HidD_GetHidGuid(HidGuid: *mut GUID);
    pub fn HidD_GetAttributes(HidDeviceObject: HANDLE, Attributes: *mut HIDD_ATTRIBUTES) -> BOOLEAN;
    pub fn HidD_GetPreparsedData(HidDeviceObject: HANDLE, PreparsedData: *mut isize) -> BOOLEAN;
    pub fn HidD_FreePreparsedData(PreparsedData: isize) -> BOOLEAN;
    pub fn HidD_GetFeature(HidDeviceObject: HANDLE, ReportBuffer: *mut c_void, ReportBufferLength: u32) -> BOOLEAN;
    pub fn HidD_GetInputReport(HidDeviceObject: HANDLE, ReportBuffer: *mut c_void, ReportBufferLength: u32) -> BOOLEAN;
    pub fn HidD_SetFeature(HidDeviceObject: HANDLE, ReportBuffer: *mut c_void, ReportBufferLength: u32) -> BOOLEAN;
    pub fn HidD_SetOutputReport(HidDeviceObject: HANDLE, ReportBuffer: *mut c_void, ReportBufferLength: u32) -> BOOLEAN;
    pub fn HidD_GetProductString(HidDeviceObject: HANDLE, Buffer: *mut c_void, BufferLength: u32) -> BOOLEAN;
    pub fn HidD_GetSerialNumberString(HidDeviceObject: HANDLE, Buffer: *mut c_void, BufferLength: u32) -> BOOLEAN;
    pub fn HidP_GetCaps(PreparsedData: isize, Capabilities: *mut HIDP_CAPS) -> NTSTATUS;
    pub fn HidP_GetValueCaps(ReportType: i32, ValueCaps: *mut HIDP_VALUE_CAPS, ValueCapsLength: *mut u16, PreparsedData: isize) -> NTSTATUS;
    pub fn HidP_GetUsageValue(ReportType: i32, UsagePage: u16, LinkCollection: u16, Usage: u16, UsageValue: *mut u32, PreparsedData: isize, Report: *mut u8, ReportLength: u32) -> NTSTATUS;
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct XINPUT_GAMEPAD {
    pub wButtons: u16,
    pub bLeftTrigger: u8,
    pub bRightTrigger: u8,
    pub sThumbLX: i16,
    pub sThumbLY: i16,
    pub sThumbRX: i16,
    pub sThumbRY: i16,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct XINPUT_STATE {
    pub dwPacketNumber: u32,
    pub Gamepad: XINPUT_GAMEPAD,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct XINPUT_BATTERY_INFORMATION {
    pub BatteryType: u8,
    pub BatteryLevel: u8,
}

pub const ERROR_SUCCESS: u32 = 0;
pub const BATTERY_DEVTYPE_GAMEPAD: u8 = 0x00;
pub const BATTERY_DEVTYPE_HEADSET: u8 = 0x01;

#[cfg_attr(windows, link(name = "xinput1_4", kind = "raw-dylib"))]
extern "system" {
    pub fn XInputGetState(dwUserIndex: u32, pState: *mut XINPUT_STATE) -> u32;
    pub fn XInputGetBatteryInformation(dwUserIndex: u32, devType: u8, pBatteryInformation: *mut XINPUT_BATTERY_INFORMATION) -> u32;
}

// ---- piece 3: Bluetooth connecting (bluetoothapis.h, bthsdpdef.h — bthprops.cpl; bthioctl.h; ksmedia.h, ks.h) ----

pub const BLUETOOTH_MAX_NAME_SIZE: usize = 248;
pub const ERROR_NO_MORE_ITEMS: u32 = 259;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct SYSTEMTIME {
    pub wYear: u16,
    pub wMonth: u16,
    pub wDayOfWeek: u16,
    pub wDay: u16,
    pub wHour: u16,
    pub wMinute: u16,
    pub wSecond: u16,
    pub wMilliseconds: u16,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct BLUETOOTH_FIND_RADIO_PARAMS {
    pub dwSize: u32,
}

/// BLUETOOTH_DEVICE_INFO (560 bytes): the address is BLUETOOTH_ADDRESS, a union of a ULONGLONG and six bytes (8 bytes,
/// 8-aligned: it starts at offset 8).
#[repr(C)]
#[derive(Clone, Copy)]
pub struct BLUETOOTH_DEVICE_INFO {
    pub dwSize: u32,
    pub Address: u64,
    pub ulClassofDevice: u32,
    pub fConnected: BOOL,
    pub fRemembered: BOOL,
    pub fAuthenticated: BOOL,
    pub stLastSeen: SYSTEMTIME,
    pub stLastUsed: SYSTEMTIME,
    pub szName: [u16; BLUETOOTH_MAX_NAME_SIZE],
}

impl BLUETOOTH_DEVICE_INFO {
    /// Empty, its size set, for `addr` (0 for a search).
    pub fn new(addr: u64) -> BLUETOOTH_DEVICE_INFO {
        BLUETOOTH_DEVICE_INFO {
            dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_INFO>() as u32,
            Address: addr,
            ulClassofDevice: 0,
            fConnected: 0,
            fRemembered: 0,
            fAuthenticated: 0,
            stLastSeen: SYSTEMTIME::default(),
            stLastUsed: SYSTEMTIME::default(),
            szName: [0; BLUETOOTH_MAX_NAME_SIZE],
        }
    }
}

/// BLUETOOTH_DEVICE_SEARCH_PARAMS (40 bytes on 64-bit Windows, 32 on 32-bit: the radio handle is pointer-aligned).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BLUETOOTH_DEVICE_SEARCH_PARAMS {
    pub dwSize: u32,
    pub fReturnAuthenticated: BOOL,
    pub fReturnRemembered: BOOL,
    pub fReturnUnknown: BOOL,
    pub fReturnConnected: BOOL,
    pub fIssueInquiry: BOOL,
    /// In units of 1.28 s, at most 48.
    pub cTimeoutMultiplier: u8,
    pub hRadio: HANDLE,
}

// AUTHENTICATION_REQUIREMENTS: MITM protection not required, general bonding — Windows still shows its own numeric
// comparison or passkey when both sides can (the association model follows the devices' input and output), and a
// device without them (headphones) can still pair, as from Windows' own settings.
pub const MITMProtectionNotRequiredGeneralBonding: i32 = 0x04;

#[cfg_attr(windows, link(name = "bthprops.cpl", kind = "raw-dylib", modifiers = "+verbatim"))]
extern "system" {
    pub fn BluetoothFindFirstRadio(pbtfrp: *const BLUETOOTH_FIND_RADIO_PARAMS, phRadio: *mut HANDLE) -> isize;
    pub fn BluetoothFindRadioClose(hFind: isize) -> BOOL;
    pub fn BluetoothIsConnectable(hRadio: HANDLE) -> BOOL;
    pub fn BluetoothFindFirstDevice(pbtsp: *const BLUETOOTH_DEVICE_SEARCH_PARAMS, pbtdi: *mut BLUETOOTH_DEVICE_INFO) -> isize;
    pub fn BluetoothFindNextDevice(hFind: isize, pbtdi: *mut BLUETOOTH_DEVICE_INFO) -> BOOL;
    pub fn BluetoothFindDeviceClose(hFind: isize) -> BOOL;
    pub fn BluetoothGetDeviceInfo(hRadio: HANDLE, pbtdi: *mut BLUETOOTH_DEVICE_INFO) -> u32;
    pub fn BluetoothEnumerateInstalledServices(hRadio: HANDLE, pbtdi: *const BLUETOOTH_DEVICE_INFO, pcServiceInout: *mut u32, pGuidServices: *mut GUID) -> u32;
    /// Pairing through Windows' own window (no callback registered here: the system asks the user; no PIN of ours).
    pub fn BluetoothAuthenticateDeviceEx(hwndParentIn: isize, hRadioIn: HANDLE, pbtdiInout: *mut BLUETOOTH_DEVICE_INFO, pbtOobData: *const c_void, authenticationRequirement: i32) -> u32;
}

/// bthioctl.h: BTH_CTL(BTH_IOCTL_BASE + 0x03) = CTL_CODE(FILE_DEVICE_BLUETOOTH 0x41, 0x03, METHOD_BUFFERED, FILE_ANY_ACCESS);
/// the input is the device's BTH_ADDR. Drops the link, keeps the pairing.
pub const IOCTL_BTH_DISCONNECT_DEVICE: u32 = (0x41 << 16) | (0x03 << 2);
/// ks.h: CTL_CODE(FILE_DEVICE_KS 0x2F, 0x000, METHOD_NEITHER 3, FILE_ANY_ACCESS).
pub const IOCTL_KS_PROPERTY: u32 = (0x2F << 16) | 3;

/// ks.h KSPROPERTY (KSIDENTIFIER): 24 bytes.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct KSPROPERTY {
    pub Set: GUID,
    pub Id: u32,
    pub Flags: u32,
}

pub const KSPROPERTY_TYPE_GET: u32 = 0x0000_0001;
/// ksmedia.h: KSPROPSETID_BtAudio and KSPROPERTY_ONESHOT_RECONNECT / _DISCONNECT — Windows' own way of connecting a
/// paired Bluetooth audio device (the sound settings' Connect).
pub const KSPROPSETID_BtAudio: GUID = GUID::new(0x7FA06C40, 0xB8F6, 0x4C7E, [0x85, 0x56, 0xE8, 0xC3, 0x3A, 0x12, 0xE5, 0x4D]);
pub const KSPROPERTY_ONESHOT_RECONNECT: u32 = 0;
pub const KSPROPERTY_ONESHOT_DISCONNECT: u32 = 1;
/// ks.h KSCATEGORY_AUDIO: the sound filters' interface class.
pub const KSCATEGORY_AUDIO: GUID = GUID::new(0x6994AD04, 0x93EF, 0x11D0, [0xA3, 0xCC, 0x00, 0xA0, 0xC9, 0x22, 0x31, 0x96]);
/// devguid.h GUID_DEVCLASS_BLUETOOTH: the radios' setup class (a radio there but none found: Bluetooth is off).
pub const GUID_DEVCLASS_BLUETOOTH: GUID = GUID::new(0xE0CBF06C, 0xCD8B, 0x4647, [0xBB, 0x8A, 0x26, 0x3B, 0x43, 0xF0, 0xF9, 0x74]);

#[cfg_attr(windows, link(name = "kernel32", kind = "raw-dylib"))]
extern "system" {
    pub fn DeviceIoControl(hDevice: HANDLE, dwIoControlCode: u32, lpInBuffer: *const c_void, nInBufferSize: u32, lpOutBuffer: *mut c_void, nOutBufferSize: u32, lpBytesReturned: *mut u32, lpOverlapped: *mut c_void) -> BOOL;
    pub fn GetLastError() -> u32;
}

/// A Rust string as a NUL-ended UTF-16 one.
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A UTF-16 buffer up to its first NUL, as a string (lossy).
pub fn from_wide(b: &[u16]) -> String {
    let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    String::from_utf16_lossy(&b[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layouts_match_the_sdk_on_64_bit() {
        if cfg!(target_pointer_width = "64") {
            assert_eq!(std::mem::size_of::<SP_DEVINFO_DATA>(), 32);
            assert_eq!(std::mem::size_of::<SP_DEVICE_INTERFACE_DATA>(), 32);
        }
        assert_eq!(std::mem::size_of::<GUID>(), 16);
        assert_eq!(std::mem::size_of::<DEVPROPKEY>(), 20);
        assert_eq!(std::mem::size_of::<HIDD_ATTRIBUTES>(), 12);
        assert_eq!(std::mem::size_of::<HIDP_CAPS>(), 64);
        assert_eq!(std::mem::size_of::<HIDP_VALUE_CAPS>(), 72);
        assert_eq!(std::mem::size_of::<XINPUT_STATE>(), 16);
        assert_eq!(std::mem::size_of::<XINPUT_BATTERY_INFORMATION>(), 2);
        assert_eq!(std::mem::size_of::<CM_NOTIFY_FILTER>(), 416);
        // (Piece 3: bluetoothapis.h and ks.h.)
        assert_eq!(std::mem::size_of::<SYSTEMTIME>(), 16);
        assert_eq!(std::mem::size_of::<BLUETOOTH_FIND_RADIO_PARAMS>(), 4);
        assert_eq!(std::mem::size_of::<BLUETOOTH_DEVICE_INFO>(), 560);
        assert_eq!(std::mem::offset_of!(BLUETOOTH_DEVICE_INFO, Address), 8);
        assert_eq!(std::mem::offset_of!(BLUETOOTH_DEVICE_INFO, ulClassofDevice), 16);
        assert_eq!(std::mem::offset_of!(BLUETOOTH_DEVICE_INFO, stLastSeen), 32);
        assert_eq!(std::mem::offset_of!(BLUETOOTH_DEVICE_INFO, szName), 64);
        assert_eq!(BLUETOOTH_DEVICE_INFO::new(7).dwSize, 560);
        if cfg!(target_pointer_width = "64") {
            assert_eq!(std::mem::size_of::<BLUETOOTH_DEVICE_SEARCH_PARAMS>(), 40);
            assert_eq!(std::mem::offset_of!(BLUETOOTH_DEVICE_SEARCH_PARAMS, hRadio), 32);
        }
        assert_eq!(std::mem::offset_of!(BLUETOOTH_DEVICE_SEARCH_PARAMS, cTimeoutMultiplier), 24);
        assert_eq!(std::mem::size_of::<KSPROPERTY>(), 24);
        assert_eq!(IOCTL_BTH_DISCONNECT_DEVICE, 0x0041_000C);
        assert_eq!(IOCTL_KS_PROPERTY, 0x002F_0003);
        assert_eq!(KSPROPSETID_BtAudio.braced(), "{7FA06C40-B8F6-4C7E-8556-E8C33A12E54D}");
        assert_eq!(KSCATEGORY_AUDIO.braced(), "{6994AD04-93EF-11D0-A3CC-00A0C9223196}");
        assert_eq!(DEVPKEY_Device_ContainerId.fmtid.braced(), "{8C7ED206-3F8A-4827-B3AB-AE9E1FAEFC6C}");
        assert_eq!(from_wide(&wide("Mäus")), "Mäus");
        assert_eq!(from_wide(&[0x41, 0, 0x42]), "A");
    }
}
