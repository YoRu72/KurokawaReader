// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): headsets on Airoha 2.4 GHz dongles read with Airoha's RACE «get
// battery» — the AKG N9 Hybrid (0ECB:20D9) and the ENDORFY Viro Wireless (3738:0072). (The Audeze Maxwell, the same
// request, is audeze.rs.)
// Ported from Wireless Device Battery Monitor / BatteryHub (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/akg.cpp and endorfy.cpp at v1.1.0 (commit 7cc44f2), by krisgfx9 and its contributors, GPL-3.0-or-later.
// Their references: HeyOkay/HaloBattery (providers/skullcandy.py from the Headroom project, providers/audeze.py),
// HeadsetControl's audeze_maxwell.hpp.
//   FF13:0001 (interface 3), 62-byte reports. Request: output report 06 [06][07][80 the headset behind the dongle]
//   [05 5A][len 03 00][id D6 0C][agent 00]. Answer: input report 07, fetched with GetInputReport: [07][valid length]
//   [80] then RACE frames 05 <type> <len LE> <id LE> <payload>; the battery is the 5D indication of 0CD6 with payload
//   [status 0][agent][percent]. No charging flag.
//   - AKG (Model::arg 0): only the valid part ([1] bytes from byte 3) is read — an old battery frame can sit in the
//     report's tail after the headset was switched off.
//   - ENDORFY (arg 1): the frames walked one by one; report 07 as it was before the request is not taken as the answer.
// Changed here: nothing kept between rounds.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::mice::*;
use crate::model::{Charging, Kind};
use crate::sched::Outcome;
use crate::transport::TErr;
use std::time::Instant;

pub static MODELS: &[Model] = &[
    Model::new("hs-akg", 0x0ECB, 0x20D9, "AKG N9 Hybrid", Kind::Headset, Via::Receiver).iface(3).page(0xFF13).usage(0x0001).input(Len::Eq(62)).output(Len::Eq(62)),
    Model::new("hs-endorfy", 0x3738, 0x0072, "ENDORFY Viro Wireless", Kind::Headset, Via::Receiver).page(0xFF13).usage(0x0001).input(Len::Eq(62)).output(Len::Eq(62)).arg(1),
];

/// AKG: the newest battery frame inside the report's valid part.
pub fn level_valid_part(b: &[u8]) -> Option<u8> {
    if b.len() < 4 || b[0] != 0x07 {
        return None;
    }
    let end = b.len().min(3 + usize::from(b[1]));
    let mut level = None;
    let mut i = 3;
    while i + 8 < end {
        if b[i..i + 7] == [0x05, 0x5D, 0x05, 0x00, 0xD6, 0x0C, 0x00] && b[i + 8] <= 100 {
            level = Some(b[i + 8]);
        }
        i += 1;
    }
    level
}

/// ENDORFY: the RACE frames walked one by one.
pub fn level_frames(r: &[u8]) -> Option<u8> {
    if r.len() < 9 || r[0] != 0x07 {
        return None;
    }
    let mut i = 3;
    while i + 6 <= r.len() {
        if r[i] != 0x05 {
            i += 1;
            continue;
        }
        let len = usize::from(r[i + 2]) | usize::from(r[i + 3]) << 8;
        if len < 2 || i + 4 + len > r.len() {
            break;
        }
        let op = u16::from(r[i + 4]) | u16::from(r[i + 5]) << 8;
        if r[i + 1] == 0x5D && op == 0x0CD6 && len >= 5 && r[i + 6] == 0 && r[i + 8] <= 100 {
            return Some(r[i + 8]);
        }
        i += 4 + len;
    }
    None
}

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    let endorfy = m.arg == 1;
    let before = if endorfy { ch.main.get_input(0x07, 62, deadline).ok() } else { None };
    if let Err(e) = send(&mut *ch.main, crate::allow::ReportKind::Output, &super::audeze::Q, deadline) {
        return failed(&e);
    }
    let tries = if endorfy { 12 } else { 10 };
    for i in 0..tries {
        pause(ms(60), deadline);
        let r = match ch.main.get_input(0x07, 62, deadline) {
            Ok(r) => r,
            Err(TErr::Gone) => return Outcome::Failed,
            Err(TErr::Timeout) => break,
            Err(_) => continue,
        };
        // (ENDORFY: the report as it was before is not the answer — except at the last read, a steady level.)
        if endorfy && before.as_ref() == Some(&r) && i + 1 < tries {
            continue;
        }
        let level = if endorfy { level_frames(&r) } else { level_valid_part(&r) };
        if let Some(l) = level {
            return match pct(i64::from(l)) {
                Some(lv) => got(lv, Charging::Unknown, now),
                None => no_level(Charging::Unknown, now),
            };
        }
    }
    // (The headset off, or the dongle not answering this query.)
    Outcome::NoAnswer
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mice::testkit::*;

    #[test]
    fn race_battery() {
        let m = model("hs-akg", 0x20D9);
        // ([07][valid length][80] then an acknowledgement and the 5D indication: 50 %.)
        let mut r = vec![0x07, 18, 0x80, 0x05, 0x5B, 0x03, 0x00, 0xD6, 0x0C, 0x00, 0x05, 0x5D, 0x05, 0x00, 0xD6, 0x0C, 0x00, 0x00, 50];
        r.resize(62, 0);
        let mut f = fake(m);
        f.inputs.insert(0x07, r.clone());
        assert_eq!(read1(&mut f, m), at(pctl(50), Charging::Unknown));
        assert_eq!(f.sent, vec![super::super::audeze::Q.to_vec()]);
        // (An old frame in the tail, past the valid length: not read.)
        let mut stale = r.clone();
        stale[1] = 5;
        assert_eq!(level_valid_part(&stale), None);
        let e = model("hs-endorfy", 0x0072);
        assert_eq!(level_frames(&r), Some(50));
        let mut f = fake(e);
        f.inputs.insert(0x07, r.clone());
        assert_eq!(read1(&mut f, e), at(pctl(50), Charging::Unknown), "the same report as before: taken at the last read");
        let mut odd = r.clone();
        odd[16] = 1;
        assert_eq!(level_frames(&odd), None, "a status other than 0");
    }
}
