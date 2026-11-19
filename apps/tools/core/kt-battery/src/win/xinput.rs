// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): XInput's four slots.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/xinput.cpp (PollXInput's queries) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its
// contributors, GPL-3.0-or-later.
// Changed here: xinput1_4.dll is linked by name from the system folder (Windows 8 and later; the original also tried
// xinput9_1_0); the rules (empty slots, wired pads, mirrored headsets) are xbox.rs's, tested there.
// UNVERIFIED here: compiled only on Windows (type-checked elsewhere).
// Copyright (C) 2026 Kurokawa contributors.
use super::ffi::*;
use crate::xbox::XSlot;

fn battery(user: u32, kind: u8) -> Option<(u8, u8)> {
    let mut bi = XINPUT_BATTERY_INFORMATION::default();
    if unsafe { XInputGetBatteryInformation(user, kind, &mut bi) } == ERROR_SUCCESS {
        Some((bi.BatteryType, bi.BatteryLevel))
    } else {
        None
    }
}

pub fn slots() -> Vec<XSlot> {
    (0..4u32)
        .map(|user| {
            let mut st = XINPUT_STATE::default();
            let present = unsafe { XInputGetState(user, &mut st) } == ERROR_SUCCESS;
            if !present {
                return XSlot { user: user as u8, present, pad: None, headset: None };
            }
            XSlot { user: user as u8, present, pad: battery(user, BATTERY_DEVTYPE_GAMEPAD), headset: battery(user, BATTERY_DEVTYPE_HEADSET) }
        })
        .collect()
}
