// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Nothing / CMF Ear earbuds' status frames (their «NT Link» Bluetooth serial
// service).
// Ported from Wireless Device Battery Monitor / BatteryHub (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/nothing_ear_protocol.h at v1.1.0 (commit 7cc44f2), by krisgfx9 and its contributors, GPL-3.0-or-later.
// Its references: radiance-project/ear-web, Vadim-Karpenko/ear-tray, pedrordgs/nothing-ear.
//   Frame: 55 60 01 [cmd LE] [payload length] 00 [seq] [payload] [CRC-16/MODBUS LE over everything before it].
//   Battery query: cmd C007, no payload (read only). Reply C007 (or the push E001): [count] then (id, status) pairs —
//   id 02 left, 03 right, 04 case; status bit 7 charging, bits 0–6 percent.
// PARSE ONLY in this piece: the frames, the query's bytes and the parts are here with their tests; the connection to the
// earbuds' serial service (win/spp.rs, the model galaxybuds.rs) is not made for them — it would send the query, and
// that needs its own switch and allow entry, a later piece. Nothing is sent from here.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::model::{Charging, Level, Part, PartName, Percent, Reading};

pub const CMD_BATTERY: u16 = 0xC007;
pub const CMD_BATTERY_PUSH: u16 = 0xE001;

pub fn crc16_modbus(d: &[u8]) -> u16 {
    let mut c: u16 = 0xFFFF;
    for &b in d {
        c ^= u16::from(b);
        for _ in 0..8 {
            c = if c & 1 != 0 { (c >> 1) ^ 0xA001 } else { c >> 1 };
        }
    }
    c
}

/// The battery query with sequence `seq`.
pub fn battery_query(seq: u8) -> [u8; 10] {
    let mut f = [0x55, 0x60, 0x01, 0x07, 0xC0, 0x00, 0x00, seq, 0x00, 0x00];
    let c = crc16_modbus(&f[..8]);
    f[8] = c as u8;
    f[9] = (c >> 8) as u8;
    f
}

/// The last battery status in a byte stream: [left, right, case] as (level, charging).
pub fn find_status(d: &[u8]) -> Option<[Option<(u8, bool)>; 3]> {
    let mut found = None;
    let mut i = 0;
    while i + 10 <= d.len() {
        if d[i] != 0x55 || d[i + 1] != 0x60 || d[i + 2] != 0x01 {
            i += 1;
            continue;
        }
        let plen = usize::from(d[i + 5]);
        let total = 8 + plen + 2;
        if i + total > d.len() {
            i += 1;
            continue;
        }
        let crc = u16::from(d[i + 8 + plen]) | u16::from(d[i + 9 + plen]) << 8;
        if crc16_modbus(&d[i..i + 8 + plen]) != crc {
            i += 1;
            continue;
        }
        let cmd = u16::from(d[i + 3]) | u16::from(d[i + 4]) << 8;
        let p = &d[i + 8..i + 8 + plen];
        if (cmd == CMD_BATTERY || cmd == CMD_BATTERY_PUSH) && !p.is_empty() && 1 + usize::from(p[0]) * 2 <= p.len() {
            let mut s = [None; 3];
            for k in 0..usize::from(p[0]) {
                let (id, st) = (p[1 + k * 2], p[2 + k * 2]);
                let v = (st & 0x7F, st & 0x80 != 0);
                if v.0 > 100 {
                    continue;
                }
                match id {
                    0x02 => s[0] = Some(v),
                    0x03 => s[1] = Some(v),
                    0x04 => s[2] = Some(v),
                    _ => {}
                }
            }
            if s.iter().any(Option::is_some) {
                found = Some(s);
            }
        }
        i += total;
    }
    found
}

/// The parts as one card's reading (a charging bud is in its case).
pub fn reading(s: [Option<(u8, bool)>; 3], at: u64) -> Reading {
    let names = [PartName::Left, PartName::Right, PartName::Case];
    let mut p = [None; 3];
    for k in 0..3 {
        p[k] = s[k].and_then(|(l, c)| Percent::new(i64::from(l)).map(|v| Part { name: names[k], level: Level::Exact(v), charging: if c { Charging::Yes } else { Charging::No }, in_use: k < 2 && !c }));
    }
    Reading::with_parts(p, at)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(cmd: u16, payload: &[u8]) -> Vec<u8> {
        let mut f = vec![0x55, 0x60, 0x01, cmd as u8, (cmd >> 8) as u8, payload.len() as u8, 0x00, 0x05];
        f.extend_from_slice(payload);
        let c = crc16_modbus(&f);
        f.extend_from_slice(&[c as u8, (c >> 8) as u8]);
        f
    }

    #[test]
    fn status_frames() {
        let q = battery_query(1);
        assert_eq!(&q[..8], &[0x55, 0x60, 0x01, 0x07, 0xC0, 0x00, 0x00, 0x01]);
        assert_eq!(u16::from(q[8]) | u16::from(q[9]) << 8, crc16_modbus(&q[..8]));
        assert_eq!(crc16_modbus(b"123456789"), 0x4B37, "CRC-16/MODBUS's check value");
        let mut stream = vec![0x00, 0x13];
        stream.extend(frame(0x4001, &[1, 2, 3]));
        stream.extend(frame(CMD_BATTERY, &[3, 0x02, 64, 0x03, 0x80 | 58, 0x04, 90]));
        let s = find_status(&stream).unwrap();
        assert_eq!(s, [Some((64, false)), Some((58, true)), Some((90, false))]);
        assert_eq!(reading(s, 3).level, Level::Exact(Percent::new(64).unwrap()));
        let mut bad = frame(CMD_BATTERY_PUSH, &[1, 0x02, 50]);
        bad[9] ^= 1;
        assert_eq!(find_status(&bad), None, "a bad CRC");
        assert_eq!(find_status(&frame(CMD_BATTERY, &[2, 0x02, 50])), None, "a count past the payload");
        assert_eq!(find_status(&frame(CMD_BATTERY_PUSH, &[1, 0x03, 0xE5])), None, "101 %");
    }
}
