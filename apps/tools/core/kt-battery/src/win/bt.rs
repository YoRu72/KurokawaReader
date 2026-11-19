// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Windows' Bluetooth device nodes and their battery property.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/generic.cpp (PollBluetooth's SetupAPI walk, StrProp, FirstStringProp) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later.
// Changed here: this file only reads the nodes; the decisions (one device per container, connected or not, kinds) are
// bluetooth.rs's, tested there. Read-only: nothing is sent to any device — Windows already holds the level.
// UNVERIFIED here: compiled only on Windows (type-checked elsewhere).
// Copyright (C) 2026 Kurokawa contributors.
use super::ffi::*;
use crate::bluetooth::{is_bt_instance, is_main_node, BtNode};

fn prop(di: HDEVINFO, dd: &SP_DEVINFO_DATA, key: &DEVPROPKEY, buf: &mut [u8]) -> Option<(u32, usize)> {
    let mut t = 0u32;
    let mut need = 0u32;
    let ok = unsafe { SetupDiGetDevicePropertyW(di, dd, key, &mut t, buf.as_mut_ptr(), buf.len() as u32, &mut need, 0) };
    if ok == 0 {
        None
    } else {
        Some((t, (need as usize).min(buf.len())))
    }
}

fn string_prop(di: HDEVINFO, dd: &SP_DEVINFO_DATA, key: &DEVPROPKEY) -> String {
    let mut buf = [0u8; 512];
    match prop(di, dd, key, &mut buf) {
        // (A string list's first entry is enough: a container's category.)
        Some((t, n)) if t == DEVPROP_TYPE_STRING || t == DEVPROP_TYPE_STRING_LIST => {
            let words: Vec<u16> = buf[..n - n % 2].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            from_wide(&words).trim().to_string()
        }
        _ => String::new(),
    }
}

/// Every present Bluetooth device node with what bluetooth.rs needs.
pub fn nodes() -> Vec<BtNode> {
    let mut out = Vec::new();
    let di = unsafe { SetupDiGetClassDevsW(std::ptr::null(), std::ptr::null(), 0, DIGCF_ALLCLASSES | DIGCF_PRESENT) };
    if di == INVALID_HANDLE_VALUE {
        return out;
    }
    for i in 0..65_536u32 {
        let mut dd = SP_DEVINFO_DATA { cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32, ..Default::default() };
        if unsafe { SetupDiEnumDeviceInfo(di, i, &mut dd) } == 0 {
            break;
        }
        let mut inst = [0u16; 512];
        if unsafe { SetupDiGetDeviceInstanceIdW(di, &dd, inst.as_mut_ptr(), inst.len() as u32, std::ptr::null_mut()) } == 0 {
            continue;
        }
        let instance_id = from_wide(&inst);
        if !is_bt_instance(&instance_id) {
            continue;
        }
        let mut n = BtNode { instance_id, ..Default::default() };
        let mut g = [0u8; 16];
        if let Some((t, 16)) = prop(di, &dd, &DEVPKEY_Device_ContainerId, &mut g) {
            if t == DEVPROP_TYPE_GUID {
                let guid = GUID::new(u32::from_le_bytes([g[0], g[1], g[2], g[3]]), u16::from_le_bytes([g[4], g[5]]), u16::from_le_bytes([g[6], g[7]]), [g[8], g[9], g[10], g[11], g[12], g[13], g[14], g[15]]);
                n.container = Some(guid.braced());
            }
        }
        n.name = string_prop(di, &dd, &DEVPKEY_Device_FriendlyName);
        if n.name.is_empty() {
            n.name = string_prop(di, &dd, &DEVPKEY_Device_DeviceDesc);
        }
        let mut b4 = [0u8; 4];
        if is_main_node(&n.instance_id) {
            if let Some((DEVPROP_TYPE_UINT32, 4)) = prop(di, &dd, &DEVPKEY_Bluetooth_ClassOfDevice, &mut b4) {
                n.class_of_device = Some(u32::from_le_bytes(b4));
            }
            let c = string_prop(di, &dd, &DEVPKEY_DeviceContainer_Category);
            if !c.is_empty() {
                n.category = Some(c);
            }
        }
        let mut b1 = [0u8; 1];
        if let Some((DEVPROP_TYPE_BOOLEAN, 1)) = prop(di, &dd, &DEVPKEY_Device_IsConnected, &mut b1) {
            n.connected = Some(b1[0] != DEVPROP_FALSE);
        }
        let mut lv = [0u8; 1];
        if let Some((DEVPROP_TYPE_BYTE, 1)) = prop(di, &dd, &DEVPKEY_Bluetooth_Battery, &mut lv) {
            n.battery = Some(lv[0]);
        }
        let (mut st, mut problem) = (0u32, 0u32);
        if unsafe { CM_Get_DevNode_Status(&mut st, &mut problem, dd.DevInst, 0) } == CR_SUCCESS {
            n.problem = st & DN_HAS_PROBLEM != 0;
        }
        out.push(n);
    }
    unsafe { SetupDiDestroyDeviceInfoList(di) };
    out
}
