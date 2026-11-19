// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the MAONO PD200W wireless microphone on its receiver (352F:040E).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/maono.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its references: iamsh4/maomao (protocol-pd200w.md), shahriyardx/maono (the PD100W's registers).
//   Interface 3, page 0C usage 01, 64-byte reports, no feature report. Register GET (04) of 0042, the battery:
//   C4 09 00 00 04 42 00 <checksum ED FE>; reply C4 <len> 00 00 04 (register, value) pairs, a 16-bit checksum.
//   Only GET is sent, never SET (03). No charging flag.
// Changed here: nothing but the shapes of this crate; in «Other» on the page (a microphone is not a headset).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::mice::*;
use crate::model::{Charging, Kind, Level};
use crate::sched::Outcome;
use std::time::Instant;

pub static MODELS: &[Model] = &[Model::new("ot-maono", 0x352F, 0x040E, "MAONO PD200W", Kind::Other, Via::Receiver).iface(3).page(0x000C).usage(0x0001).input(Len::Eq(64)).output(Len::Eq(64)).feature(Len::Eq(0))];

pub const Q: [u8; 9] = [0xC4, 0x09, 0x00, 0x00, 0x04, 0x42, 0x00, 0xED, 0xFE];

fn le16(b: &[u8], i: usize) -> u16 {
    u16::from(b[i]) | u16::from(b[i + 1]) << 8
}
fn check(b: &[u8], n: usize) -> u16 {
    let s: u32 = b[..n].iter().map(|&x| u32::from(x)).sum();
    (0x10000u32 - (s & 0xFFFF)) as u16
}

pub fn parse(r: &[u8]) -> Option<u8> {
    if r.len() < 11 || r[0] != 0xC4 {
        return None;
    }
    let len = usize::from(r[1]);
    if len < 11 || len > r.len() || r[2] != 0 || r[3] != 0 || r[4] != 0x04 {
        return None;
    }
    let end = len - 2;
    if (end - 5) % 4 != 0 || le16(r, end) != check(r, end) {
        return None;
    }
    let mut o = 5;
    while o < end {
        if le16(r, o) == 0x0042 {
            let v = le16(r, o + 2);
            return if v <= 100 { Some(v as u8) } else { None };
        }
        o += 4;
    }
    None
}

pub fn read(ch: &mut Chans, deadline: Instant, now: u64) -> Outcome {
    match out_ask(ch, &Q, ms(1000), deadline, &mut parse) {
        Ok(v) => got(pct(i64::from(v)).unwrap_or(Level::Unknown), Charging::Unknown, now),
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use crate::mice::testkit::*;
    use super::*;

    #[test]
    fn pd200w() {
        assert_eq!(check(&Q, 7), 0xFEED, "the request's own checksum");
        let m = model("ot-maono", 0x040E);
        let mut r = vec![0xC4, 11, 0, 0, 0x04, 0x42, 0x00, 63, 0x00];
        let c = check(&r, 9);
        r.extend_from_slice(&c.to_le_bytes());
        let mut f = fake(m);
        f.replies.push_back(vec![r.clone()]);
        assert_eq!(read1(&mut f, m), at(pctl(63), Charging::Unknown));
        assert_eq!(f.sent, vec![Q.to_vec()]);
        let mut bad = r.clone();
        bad[9] ^= 1;
        assert_eq!(parse(&bad), None, "a wrong checksum");
        assert_eq!(parse(&r[..9]), None, "short");
    }
}
