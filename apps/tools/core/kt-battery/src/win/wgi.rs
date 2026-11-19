// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Xbox controllers through Windows.Gaming.Input (the `wgi` feature).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/xinput.cpp (Statics, PollWgi) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its
// contributors, GPL-3.0-or-later.
// Changed here: the `windows` crate's projection instead of raw COM; the controller's key is its NonRoamableId; the
// decisions are xbox.rs's. Without the feature this returns nothing and XInput's coarse levels stand in.
// UNVERIFIED here: needs the `windows` crate, compiled only by CI («Device battery — WGI compile try»); off by default.
// Copyright (C) 2026 Kurokawa contributors.
use crate::xbox::{WgiPad, WgiStatus};

#[cfg(feature = "wgi")]
pub fn pads() -> Vec<WgiPad> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows::Gaming::Input::RawGameController;
    use windows::System::Power::BatteryStatus;
    static FIRST: AtomicBool = AtomicBool::new(true);
    let Ok(list) = RawGameController::RawGameControllers() else { return Vec::new() };
    // (The list fills in a moment after first use: asked once more then — the original's 300 ms.)
    let list = if FIRST.swap(false, Ordering::SeqCst) && list.Size().unwrap_or(0) == 0 {
        std::thread::sleep(std::time::Duration::from_millis(300));
        match RawGameController::RawGameControllers() {
            Ok(l) => l,
            Err(_) => return Vec::new(),
        }
    } else {
        list
    };
    let n = list.Size().unwrap_or(0).min(16);
    let mut out = Vec::new();
    for i in 0..n {
        let Ok(rc) = list.GetAt(i) else { continue };
        let vid = rc.HardwareVendorId().unwrap_or(0);
        let pid = rc.HardwareProductId().unwrap_or(0);
        let name = rc.DisplayName().map(|s| s.to_string()).unwrap_or_default();
        let id = rc.NonRoamableId().map(|s| s.to_string()).unwrap_or_default();
        let Ok(rep) = rc.TryGetBatteryReport() else { continue };
        let remaining_mwh = rep.RemainingCapacityInMilliwattHours().ok().and_then(|r| r.Value().ok());
        let full_mwh = rep.FullChargeCapacityInMilliwattHours().ok().and_then(|r| r.Value().ok());
        let status = match rep.Status() {
            Ok(s) if s == BatteryStatus::Charging => WgiStatus::Charging,
            Ok(s) if s == BatteryStatus::Discharging => WgiStatus::Discharging,
            Ok(s) if s == BatteryStatus::Idle => WgiStatus::Idle,
            _ => WgiStatus::NotPresent,
        };
        out.push(WgiPad { vid, pid, id, name, remaining_mwh, full_mwh, status });
    }
    out
}

#[cfg(not(feature = "wgi"))]
pub fn pads() -> Vec<WgiPad> {
    let _ = WgiStatus::NotPresent;
    Vec::new()
}
