// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Niceboy MW400 on its receiver (248A:FA02).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/niceboy.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later (from the Niceboy MW400 app).
// Interface 0, the collection with report 05 (0001:0000, 33 bytes in and out): output 05 24 FA 48 → input 05 [..] FA 48
// [lo][hi][charging]: raw = lo | hi << 8, mV = raw × 990 / 240; all three 0: the mouse not linked.
// Changed here: the voltage as a coarse word (the original: the app's table in 10 % steps).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

pub static MODELS: &[Model] = &[Model::new("mk-niceboy", 0x248A, 0xFA02, "Niceboy MW400", Kind::Mouse, Via::Receiver).iface(0).page(0x0001).usage(0x0000).input(Len::Eq(33)).output(Len::Eq(33))];

pub const BATTERY: [u8; 4] = [0x05, 0x24, 0xFA, 0x48];

pub fn read(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Outcome {
    match out_ask(ch, &BATTERY, ms(500), deadline, &mut |r| if r.len() >= 7 && r[0] == 0x05 && r[2] == 0xFA && r[3] == 0x48 { Some((r[4], r[5], r[6])) } else { None }) {
        Ok((0, 0, 0)) => dozing(now),
        Ok((lo, hi, c)) => got(from_millivolts((u32::from(lo) | u32::from(hi) << 8) * 990 / 240), charging(c != 0), now),
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn mw400() {
        // (The app's example: 05 49 FA 48 EA 03 00 = raw 1002 = 4133 mV.)
        let m = model("mk-niceboy", 0xFA02);
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x05, 0x49, 0xFA, 0x48, 0xEA, 0x03, 0x00]]);
        assert_eq!(read1(&mut f, m), at(from_millivolts(4133), Charging::No));
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x05, 0x49, 0xFA, 0x48, 0, 0, 0]]);
        assert_eq!(read1(&mut f, m), dozing(7));
    }
}
