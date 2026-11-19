// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Poly / Plantronics headsets behind the BT600 adapter (VID 047F).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/plantronics.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its references: HeyOkay/HaloBattery (providers/plantronics.py), Sapd/HeadsetControl
// (plantronics_bt600.hpp).
//   Report 07 on the vendor collection FFA2:0003, 64 bytes: 07 01 01 10 <len> <addr> 00 00 <op> <group> <item> …;
//   addr 20 the headset (replies carry 02). GET group 0A item 1A → <level> <level count> <charging> <minutes>.
// Changed here: only the GET is sent. The original first sent the adapter's «attach» output report (06 01) and a HELLO
// to the adapter and to the headset — not status reads (they open a session with the headset over the air); without
// them a headset answers once Poly's own software has attached the adapter, else «no answer». The level as its steps
// (level of count − 1), not a percentage made from them.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::mice::*;
use crate::model::{Charging, Kind, Level};
use crate::sched::Outcome;
use std::time::Instant;

const fn p(pid: u16) -> Model {
    Model::new("hs-poly", 0x047F, pid, "Poly / Plantronics headset", Kind::Headset, Via::Receiver).page(0xFFA2).usage(0x0003)
}
pub static MODELS: &[Model] = &[p(0x02EE), p(0x02F7)];

pub const GET: [u8; 11] = [0x07, 0x01, 0x01, 0x10, 0x06, 0x20, 0x00, 0x00, 0x02, 0x0A, 0x1A];

pub fn reply(r: &[u8]) -> Option<(u8, u8, u8)> {
    if r.len() < 14 || r[0] != 0x07 || r[1] != 0x01 || r[2] != 0x01 || r[3] != 0x10 || r[5] != 0x02 || r[8] != 0x03 || r[9] != 0x0A || r[10] != 0x1A {
        return None;
    }
    Some((r[11], r[12], r[13]))
}

/// level of count − 1 steps (a scale past 20 as per cent, rounded).
pub fn level_of(level: u8, count: u8) -> Level {
    if count < 2 || level >= count {
        return Level::Unknown;
    }
    let max = i64::from(count) - 1;
    steps(i64::from(level), max).or_else(|| scaled(i64::from(level), max)).unwrap_or(Level::Unknown)
}

pub fn read(ch: &mut Chans, deadline: Instant, now: u64) -> Outcome {
    match out_ask(ch, &GET, ms(1000), deadline, &mut reply) {
        Ok((l, n, c)) => match level_of(l, n) {
            Level::Unknown => no_level(Charging::Unknown, now),
            lv => got(lv, charging(c != 0), now),
        },
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use crate::mice::testkit::*;
    use super::*;
    use crate::model::Steps;

    #[test]
    fn bt600() {
        let m = model("hs-poly", 0x02EE);
        let mut f = fake(m);
        let mut r = vec![0u8; 64];
        r[..11].copy_from_slice(&[0x07, 0x01, 0x01, 0x10, 0x09, 0x02, 0, 0, 0x03, 0x0A, 0x1A]);
        r[11] = 3;
        r[12] = 5;
        r[13] = 1;
        f.replies.push_back(vec![r]);
        assert_eq!(read1(&mut f, m), at(Level::Steps(Steps::new(3, 4).unwrap()), Charging::Yes));
        assert_eq!(f.sent, vec![GET.to_vec()], "only the GET: no attach, no HELLO");
        assert_eq!(level_of(5, 5), Level::Unknown, "not its scale");
        assert_eq!(level_of(1, 1), Level::Unknown);
        assert_eq!(level_of(50, 101), pct(50).unwrap());
    }
}
