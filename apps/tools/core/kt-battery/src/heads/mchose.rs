// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the MCHOSE V9 Pro 2 headset on its dongle (3837:6011).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/mchose_headset.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its reference: MCHOSE's M HUB driver (buildMCFrame, createReadBatteryCommand, parseBatteryResponse).
//   Vendor collection FF07:0222, report 55: [AA][01 version][flags: 1 XOR checksum][length][00 01 request | 00 04
//   notice][sub-command][body][checksum]. Read battery: 55 AA 01 00 01 00 01 0B 00; the reply (0B) and the headset's
//   own notice (22): body[0] 0 = the headset is off or asleep, else body[1] = charging (bit 7) | percent.
// Changed here: the R9 (6013) is left out, as in the original (untested there); «asleep» is the receiver's answer, not a
// kept old level.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::mice::*;
use crate::model::{Kind, Level};
use crate::sched::Outcome;
use std::time::Instant;

pub static MODELS: &[Model] = &[Model::new("hs-mchose", 0x3837, 0x6011, "MCHOSE V9 Pro 2", Kind::Headset, Via::Receiver).page(0xFF07).usage(0x0222).output(Len::Min(64)).input(Len::Min(64)).product_name()];

pub const Q: [u8; 9] = [0x55, 0xAA, 0x01, 0x00, 0x01, 0x00, 0x01, 0x0B, 0x00];

#[derive(Debug, PartialEq)]
pub enum Rep {
    Off,
    Level(u8, bool),
}

pub fn parse(r: &[u8]) -> Option<Rep> {
    if r.len() < 9 || r[0] != 0x55 {
        return None;
    }
    let f = &r[1..];
    if f[0] != 0xAA || f[1] != 0x01 || f[4] != 0x00 {
        return None;
    }
    let reply = f[5] == 0x01 && f[6] == 0x0B;
    let notice = f[5] == 0x04 && f[6] == 0x22;
    if !reply && !notice {
        return None;
    }
    let len = usize::from(f[3]);
    if len < 3 || 6 + len >= f.len() {
        return None;
    }
    let mut check = 0u8;
    if f[2] == 1 {
        check = f[2] ^ f[3] ^ f[4] ^ f[5] ^ xor8(&f[6..6 + len]);
    }
    if f[6 + len] != check {
        return None;
    }
    let body = &f[7..];
    if body[0] == 0 {
        return Some(Rep::Off);
    }
    let p = body[1] & 0x7F;
    if p > 100 {
        return None;
    }
    Some(Rep::Level(p, body[1] & 0x80 != 0))
}

pub fn read(ch: &mut Chans, deadline: Instant, now: u64) -> Outcome {
    match out_ask(ch, &Q, ms(1000), deadline, &mut parse) {
        Ok(Rep::Off) => dozing(now),
        Ok(Rep::Level(p, c)) => got(pct(i64::from(p)).unwrap_or(Level::Unknown), charging(c), now),
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use crate::mice::testkit::*;
    use super::*;
    use crate::model::Charging;

    #[test]
    fn v9_pro_2() {
        let m = model("hs-mchose", 0x6011);
        // (A notice with flags 1 and its XOR: 82 % charging.)
        let mut fr = vec![0x55, 0xAA, 0x01, 0x01, 0x03, 0x00, 0x04, 0x22, 0x01, 0x80 | 82];
        let x = 0x01 ^ 0x03 ^ 0x00 ^ 0x04 ^ 0x22 ^ 0x01 ^ (0x80 | 82);
        fr.push(x);
        fr.push(0);
        let mut f = fake(m);
        f.replies.push_back(vec![fr.clone()]);
        assert_eq!(read1(&mut f, m), at(pctl(82), Charging::Yes));
        assert_eq!(f.sent, vec![Q.to_vec()]);
        let mut bad = fr.clone();
        bad[10] ^= 1;
        assert_eq!(parse(&bad), None, "a wrong checksum");
        let off = vec![0x55, 0xAA, 0x01, 0x00, 0x03, 0x00, 0x01, 0x0B, 0x00, 0x00, 0x00, 0x00];
        assert_eq!(parse(&off), Some(Rep::Off));
    }
}
