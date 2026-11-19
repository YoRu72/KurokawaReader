// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Audeze Maxwell on its dongle or its USB-C cable (VID 3329).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/audeze.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its references: HeyOkay/HaloBattery (providers/audeze.py), Sapd/HeadsetControl (audeze_maxwell.hpp).
//   Vendor collection FF13:0001: the 62-byte output report 06 07 80 05 5A 03 00 D6 0C (attribute 0CD6, the battery);
//   the answer is input report 07, fetched with GetInputReport: a rolling buffer scanned for D6 0C 00 00 <percent>, the
//   newest copy counting. No charging flag: on its cable a Maxwell always charges.
// The original also leaves out HeadsetControl's 14-packet start (one of its packets is not known to be a read): so do we.
// Changed here: a dongle that names itself «… Dongle» has no headset linked (its stored value is old): «no device
// linked», nothing sent — the platform tells this before asking (heads::product_says); 0 % is no level (a Maxwell says
// 0 for a moment after it is switched on: the original waited 90 s in a global); the dongle and the cable one card by
// the pair rule.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::mice::*;
use crate::model::{Charging, Kind, Level};
use crate::sched::Outcome;
use crate::transport::TErr;
use std::time::Instant;

const fn a(pid: u16, via: Via) -> Model {
    Model::new("hs-audeze", 0x3329, pid, "Audeze Maxwell", Kind::Headset, via).page(0xFF13).usage(0x0001).input(Len::Min(1)).pair("audeze:maxwell")
}
pub static MODELS: &[Model] = &[a(0x4B1A, Via::Cable), a(0x4B1E, Via::Cable), a(0x4B19, Via::Receiver), a(0x4B18, Via::Receiver), a(0x4B29, Via::Receiver), a(0x4B28, Via::Receiver)];

pub const Q: [u8; 9] = [0x06, 0x07, 0x80, 0x05, 0x5A, 0x03, 0x00, 0xD6, 0x0C];

/// The level in the rolling buffer (the last copy), or None.
pub fn find_level(b: &[u8]) -> Option<u8> {
    let mut found = None;
    for i in 0..b.len().saturating_sub(4) {
        if b[i] == 0xD6 && b[i + 1] == 0x0C && b[i + 2] == 0 && b[i + 3] == 0 && b[i + 4] <= 100 {
            found = Some(b[i + 4]);
        }
    }
    found
}

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    if let Err(e) = send(&mut *ch.main, crate::allow::ReportKind::Output, &Q, deadline) {
        return failed(&e);
    }
    let mut level = None;
    for _ in 0..3 {
        pause(ms(60), deadline);
        match ch.main.get_input(0x07, 62, deadline) {
            Ok(r) => {
                if let Some(l) = find_level(&r) {
                    level = Some(l);
                }
            }
            Err(TErr::Timeout) => break,
            Err(_) => continue,
        }
    }
    let c = if m.via == Via::Cable { Charging::Yes } else { Charging::Unknown };
    match level {
        Some(0) => no_level(c, now),
        Some(l) => got(pct(i64::from(l)).unwrap_or(Level::Unknown), c, now),
        None => Outcome::NoAnswer,
    }
}

#[cfg(test)]
mod tests {
    use crate::mice::testkit::*;
    use super::*;

    #[test]
    fn maxwell() {
        let m = model("hs-audeze", 0x4B19);
        let mut f = fake(m);
        f.inputs.insert(0x07, vec![0x07, 0x00, 0xD6, 0x0C, 0x00, 0x00, 41, 0x11, 0xD6, 0x0C, 0x00, 0x00, 40]);
        assert_eq!(read1(&mut f, m), at(pctl(40), Charging::Unknown), "the newest copy");
        assert_eq!(f.sent, vec![Q.to_vec()]);
        let cable = model("hs-audeze", 0x4B1A);
        let mut f = fake(cable);
        f.inputs.insert(0x07, vec![0x07, 0xD6, 0x0C, 0x00, 0x00, 77]);
        assert_eq!(read1(&mut f, cable), at(pctl(77), Charging::Yes));
        let mut f = fake(cable);
        f.inputs.insert(0x07, vec![0x07, 0xD6, 0x0C, 0x00, 0x00, 0]);
        assert_eq!(read1(&mut f, cable), no_level(Charging::Yes, 7), "0 % after power-on: no level");
        let mut f = fake(m);
        f.inputs.insert(0x07, vec![0x07, 0xD6, 0x0C, 0x00, 0x00, 101]);
        assert_eq!(read1(&mut f, m), Outcome::NoAnswer, "over 100");
        assert_eq!(merge_pairs(&[m, cable]), vec![vec![1, 0]]);
    }
}
