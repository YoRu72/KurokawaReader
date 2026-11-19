// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): DARKRIM SHADOW headset on its receiver (3654:6901).
// Ported from Wireless Device Battery Monitor / BatteryHub (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/darkrim.cpp and docs/darkrim.md at v1.1.0 (commit 7cc44f2), by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its reference: DARKRIM's PC Hub 0.1.26, read statically (sendGetBasicInfo, the frame builder).
//   Interface 3, FF02:0002, unnumbered 64-byte reports (interface 4's FF02:0002 uses report id 2 and is not asked).
//   Frame: [FE][seq][cmd LE][type][index][count][len LE][payload][CRC-16/CCITT-FALSE, big-endian]. GET 0010 (type 01
//   request) of info type 01 (battery): FE 03 10 00 01 00 01 02 00 01 00 9B 15 — the documented request, byte for byte.
//   Reply: FE <seq> 10 00 02 00 <count 0–1> <len> then TLVs; TLV 01 (one byte): bit 7 charging, bits 0–6 percent. The
//   receiver sends start-up notifications first; one 800 ms deadline. Only this GET is sent.
// Changed here: one fixed sequence number (03, the documented frame) instead of a counter kept in a global; the level
// is the device's percentage (its documentation: it moves in steps of ten — shown as it comes, never refined).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::mice::*;
use crate::model::{Charging, Kind};
use crate::sched::Outcome;
use std::time::Instant;

pub static MODELS: &[Model] = &[Model::new("hs-darkrim", 0x3654, 0x6901, "DARKRIM SHADOW", Kind::Headset, Via::Receiver).iface(3).page(0xFF02).usage(0x0002).input(Len::Eq(65)).output(Len::Eq(65))];

pub const fn crc(b: &[u8], n: usize) -> u16 {
    let mut c: u16 = 0xFFFF;
    let mut i = 0;
    while i < n {
        c ^= (b[i] as u16) << 8;
        let mut k = 0;
        while k < 8 {
            c = if c & 0x8000 != 0 { (c << 1) ^ 0x1021 } else { c << 1 };
            k += 1;
        }
        i += 1;
    }
    c
}

pub const SEQ: u8 = 0x03;
/// Report id 0, then the documented frame.
pub const GET_BATTERY: [u8; 14] = [0x00, 0xFE, SEQ, 0x10, 0x00, 0x01, 0x00, 0x01, 0x02, 0x00, 0x01, 0x00, 0x9B, 0x15];

/// The battery TLV's byte of a reply to sequence `seq`, or None.
pub fn reply(r: &[u8], seq: u8) -> Option<u8> {
    if r.len() < 11 || r[0] != 0xFE || r[1] != seq || r[2] != 0x10 || r[3] != 0 || r[4] != 2 || r[5] != 0 || r[6] > 1 {
        return None;
    }
    let len = usize::from(r[7]) | usize::from(r[8]) << 8;
    if len > 53 || len + 11 > r.len() {
        return None;
    }
    let end = 9 + len;
    if crc(r, end) != (u16::from(r[end]) << 8 | u16::from(r[end + 1])) {
        return None;
    }
    let mut value = None;
    let mut i = 9;
    while i < end {
        if end - i < 2 {
            return None;
        }
        let (t, n) = (r[i], usize::from(r[i + 1]));
        i += 2;
        if n > end - i {
            return None;
        }
        if t == 1 {
            if n != 1 || value.is_some() || r[i] & 0x7F > 100 {
                return None;
            }
            value = Some(r[i]);
        }
        i += n;
    }
    value
}

pub fn read(ch: &mut Chans, deadline: Instant, now: u64) -> Outcome {
    match out_ask(ch, &GET_BATTERY, ms(800), deadline, &mut |r| reply(r, SEQ)) {
        Ok(v) => match pct(i64::from(v & 0x7F)) {
            Some(l) => got(l, charging(v & 0x80 != 0), now),
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
    fn shadow() {
        assert_eq!(crc(&GET_BATTERY[1..], 11), 0x9B15, "the documented request's CRC");
        let m = model("hs-darkrim", 0x6901);
        // (A made-up reply of the documented shape: TLV 01 01 <value>, its CRC computed.)
        let frame = |seq: u8, v: u8| {
            let mut r = vec![0xFE, seq, 0x10, 0x00, 0x02, 0x00, 0x00, 0x03, 0x00, 0x01, 0x01, v];
            let c = crc(&r, r.len());
            r.extend_from_slice(&[(c >> 8) as u8, c as u8]);
            r.resize(64, 0);
            r
        };
        let note = {
            let mut n = frame(0x00, 0x28);
            n[2] = 0x11;
            n
        };
        let mut f = fake(m);
        f.replies.push_back(vec![note, frame(SEQ, 0x80 | 70)]);
        assert_eq!(read1(&mut f, m), at(pctl(70), Charging::Yes), "a notification skipped");
        assert_eq!(f.sent, vec![GET_BATTERY.to_vec()]);
        let mut bad = frame(SEQ, 40);
        bad[12] ^= 1;
        assert_eq!(reply(&bad, SEQ), None, "a bad CRC");
        assert_eq!(reply(&frame(SEQ + 1, 40), SEQ), None, "another sequence");
        assert_eq!(reply(&frame(SEQ, 0x65), SEQ), None, "101 %");
        assert_eq!(reply(&frame(SEQ, 0x5A), SEQ), Some(0x5A));
    }
}
