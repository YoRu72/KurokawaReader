// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): VGN OMNISOUND (ZHOUTING) headset on its 2.4 GHz dongle (372E:10BB).
// Ported from Wireless Device Battery Monitor / BatteryHub (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/vgn.cpp at v1.1.0 (commit 7cc44f2), by krisgfx9 and its contributors, GPL-3.0-or-later. Its reference:
// VGN's V HUB 4.0.8 (HdServe.getBattery, the «ZHOU» protocol).
//   000C:0001 (32-byte input, 64-byte output): output report 55 [55][65][01] reads the battery; the reply an input report
//   [55][65][percent] (or unnumbered [65][percent]), possibly behind other notifications. No charging bit is known. The
//   wired variant and the Siren V2 (the same frames in V HUB, untested) are not read.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::mice::*;
use crate::model::{Charging, Kind};
use crate::sched::Outcome;
use std::time::Instant;

pub static MODELS: &[Model] = &[Model::new("hs-vgn", 0x372E, 0x10BB, "VGN OMNISOUND (ZHOUTING)", Kind::Headset, Via::Receiver).page(0x000C).usage(0x0001).output(Len::Min(63)).input(Len::Min(3)).product_name()];

pub const READ_BATTERY: [u8; 3] = [0x55, 0x65, 0x01];

pub fn reply(r: &[u8]) -> Option<u8> {
    if r.len() >= 3 && r[0] == 0x55 && r[1] == 0x65 {
        Some(r[2])
    } else if r.len() >= 2 && r[0] == 0x65 {
        Some(r[1])
    } else {
        None
    }
}

pub fn read(ch: &mut Chans, deadline: Instant, now: u64) -> Outcome {
    match out_ask(ch, &READ_BATTERY, ms(800), deadline, &mut reply) {
        Ok(p) => match pct(i64::from(p)) {
            Some(l) => got(l, Charging::Unknown, now),
            None => no_level(Charging::Unknown, now),
        },
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mice::testkit::*;

    #[test]
    fn zhou() {
        let m = model("hs-vgn", 0x10BB);
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x55, 0x10, 0x02], vec![0x55, 0x65, 73]]);
        assert_eq!(read1(&mut f, m), at(pctl(73), Charging::Unknown), "a notification first");
        assert_eq!(f.sent, vec![READ_BATTERY.to_vec()]);
        assert_eq!(reply(&[0x65, 40]), Some(40), "unnumbered");
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x55, 0x65, 0xC8]]);
        assert_eq!(read1(&mut f, m), no_level(Charging::Unknown, 7));
    }
}
