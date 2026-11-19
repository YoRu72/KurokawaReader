// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): NuPhy WH80 on its USB cable (19F5:A011).
// Ported from Wireless Device Battery Monitor / BatteryHub (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/nuphy.cpp and docs/nuphy.md at v1.1.0 (commit 7cc44f2), by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its reference: NuPhyIO's web driver (getBatteryState: GetFunc 05, offset 0020, one byte).
//   Interface 1, 0001:0000, unnumbered 64-byte reports: 55 05 00 21 01 20 00 00 → AA 05 00 <sum of bytes 4–63> 01 20 00
//   00 <value: bit 7 charging, 0–6 percent (the WH80 reports tens)>. Only this GET is sent. Over Bluetooth (19F5:324A)
//   Windows' own level is used (kind.rs names that id a keyboard).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

pub static MODELS: &[Model] = &[Model::new("mk-nuphy", 0x19F5, 0xA011, "NuPhy WH80", Kind::Keyboard, Via::Cable).iface(1).page(0x0001).usage(0x0000).input(Len::Eq(65)).output(Len::Eq(65))];

pub const GET_BATTERY: [u8; 7] = [0x00, 0x55, 0x05, 0x00, 0x21, 0x01, 0x20];

/// The reply's value byte, or None.
pub fn reply(r: &[u8]) -> Option<u8> {
    if r.len() != 64 || r[0] != 0xAA || r[1] != 0x05 || r[2] != 0 || r[4] != 1 || r[5] != 0x20 || r[6] != 0 || r[7] != 0 || r[3] != sum8(&r[4..]) {
        return None;
    }
    Some(r[8])
}

pub fn read(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Outcome {
    match out_ask(ch, &GET_BATTERY, ms(400), deadline, &mut reply) {
        Ok(v) => match pct(i64::from(v & 0x7F)) {
            Some(l) => got(l, charging(v & 0x80 != 0), now),
            None => no_level(Charging::Unknown, now),
        },
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    fn rep(v: u8) -> Vec<u8> {
        let mut r = report(0xAA, 64, &[(1, 0x05), (4, 1), (5, 0x20), (8, v)]);
        r[3] = sum8(&r[4..]);
        r
    }

    #[test]
    fn wh80() {
        assert_eq!(GET_BATTERY[4], sum8(&GET_BATTERY[5..]), "the request's own sum");
        let m = model("mk-nuphy", 0xA011);
        let mut f = fake(m);
        f.replies.push_back(vec![rep(0xE4)]);
        assert_eq!(read1(&mut f, m), at(pctl(100), Charging::Yes), "the documented reply: 100 %, charging");
        assert_eq!(f.sent, vec![GET_BATTERY.to_vec()]);
        let mut bad = rep(70);
        bad[3] ^= 1;
        let mut f = fake(m);
        f.replies.push_back(vec![bad, rep(0x7F)]);
        assert_eq!(read1(&mut f, m), no_level(Charging::Unknown, 7), "a bad sum skipped; 127 is no level");
        assert_eq!(crate::kind::from_ble_ids(0x19F5, 0x324A), Kind::Keyboard);
    }
}
