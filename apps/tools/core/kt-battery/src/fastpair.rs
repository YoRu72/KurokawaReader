// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Google Fast Pair battery broadcasts — the left, right and case levels
// earbuds put in clear in their non-discoverable Fast Pair advertisement (service data of 16-bit UUID FE2C).
// Ported from Wireless Device Battery Monitor / BatteryHub (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/fastpair.cpp (Parse, Component) and generic.cpp (ApplyFastPair) at v1.1.0 (commit 7cc44f2), by krisgfx9 and
// its contributors, GPL-3.0-or-later. The layout is Google's Fast Pair specification (battery notification extension):
//   [0] version / flags 00, then fields with a header byte LLLLTTTT; type 3 / 4 battery (shown / hidden UI), one byte
//   per part in the order left, right, case: bit 7 charging, bits 0–6 the level 0–100, 7F unknown. A discoverable
//   advertisement (the 3-byte model id, no version byte) carries no battery.
// PARSE ONLY in this piece: our Bluetooth LE listening (win/ble.rs) delivers Apple's manufacturer data only, not a
// device's service data; widening it is a later piece. Nothing here sends anything — the broadcast is heard, never
// asked for; no pairing, no connection.
// Changed here: the parts as parts of one card (Reading::with_parts: the lower bud in use; a charging bud is in its
// case), never folded into one number.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::model::{Charging, Level, Part, PartName, Percent, Reading};

/// One part's byte: (level, charging), None when unknown (7F) or out of range.
fn component(b: u8) -> Option<(u8, bool)> {
    let l = b & 0x7F;
    if l <= 100 {
        Some((l, b & 0x80 != 0))
    } else {
        None
    }
}

/// The battery field of a Fast Pair service data block (the bytes after the UUID): left, right, case.
pub fn parse(d: &[u8]) -> Option<[Option<(u8, bool)>; 3]> {
    if d.len() < 2 || d[0] != 0x00 {
        return None;
    }
    let mut i = 1;
    while i < d.len() {
        let (len, t) = (usize::from(d[i] >> 4), d[i] & 0x0F);
        if i + 1 + len > d.len() {
            return None;
        }
        if (t == 3 || t == 4) && len >= 1 {
            let mut out = [None; 3];
            for (k, slot) in out.iter_mut().enumerate().take(len.min(3)) {
                *slot = component(d[i + 1 + k]);
            }
            return if out.iter().any(Option::is_some) { Some(out) } else { None };
        }
        i += 1 + len;
    }
    None
}

/// The parts as one card's reading (a bud that charges is in its case: not in use).
pub fn reading(parts: [Option<(u8, bool)>; 3], at: u64) -> Reading {
    let names = [PartName::Left, PartName::Right, PartName::Case];
    let mut p = [None; 3];
    for k in 0..3 {
        p[k] = parts[k].and_then(|(l, c)| Percent::new(i64::from(l)).map(|v| Part { name: names[k], level: Level::Exact(v), charging: if c { Charging::Yes } else { Charging::No }, in_use: k < 2 && !c }));
    }
    Reading::with_parts(p, at)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn battery_field() {
        // (Made-up broadcast: an account-key filter field (type 0, 4 bytes), a salt (type 1, 1 byte), then the battery
        //  (type 3, three parts): left 80, right 72 charging, case unknown.)
        let d = [0x00, 0x40, 1, 2, 3, 4, 0x11, 0x55, 0x33, 80, 0x80 | 72, 0x7F];
        assert_eq!(parse(&d), Some([Some((80, false)), Some((72, true)), None]));
        let r = reading(parse(&d).unwrap(), 9);
        assert_eq!(r.level, Level::Exact(Percent::new(80).unwrap()), "the charging bud is in its case");
        assert_eq!(parse(&[0x12, 0x34, 0x56]), None, "a discoverable model id");
        assert_eq!(parse(&[0x00, 0x33, 80, 72]), None, "a field longer than the data");
        assert_eq!(parse(&[0x00, 0x14, 0x7F]), None, "only unknown parts");
        assert_eq!(parse(&[0x00, 0x14, 0xE5]), None, "101 %");
        assert_eq!(parse(&[0x00, 0x14, 0x80 | 30]), Some([Some((30, true)), None, None]), "hidden-UI type 4, one part");
    }
}
