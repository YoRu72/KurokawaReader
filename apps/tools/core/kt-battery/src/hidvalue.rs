// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the generic HID battery field.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/generic.cpp (IsBatteryUsage, PollGenericHid's value handling) and src/hid.cpp (Clamp100, MapTo100) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later.
// Changed here: a field whose logical range is empty or upside down is rejected (the original then took any value up to
// 100 as a percentage, so a min = max = 0 field read as a level); a value outside its range is clamped into it first;
// a signed field is sign-extended by its bit size; the result can only be 0..=100 (Percent); the feature report is
// tried before the input report, the order kept from the original; a field read from bytes (`extract_bits`) is
// length-checked, for readers that get the raw report (Linux's hidraw later, the definition files of piece 8).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::model::Percent;
use crate::transport::{checked_reply, HidTransport, TErr};
use std::time::Instant;

/// Generic Device Controls «Battery Strength» (0x06/0x20) and Battery System «Absolute State Of Charge» (0x85/0x65).
pub fn is_battery_usage(page: u16, usage: u16) -> bool {
    (page == 0x06 && usage == 0x20) || (page == 0x85 && usage == 0x65)
}

/// One value field of a collection, as Windows' HidP_GetValueCaps describes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ValueCap {
    pub feature: bool,
    pub report_id: u8,
    pub usage_page: u16,
    pub usage: u16,
    pub link_collection: u16,
    pub logical_min: i32,
    pub logical_max: i32,
    pub bit_size: u16,
    pub report_count: u16,
}

/// The battery fields among `caps`: feature reports first, then input reports, each in the order given.
pub fn battery_caps(caps: &[ValueCap]) -> Vec<ValueCap> {
    let mut out: Vec<ValueCap> = caps.iter().filter(|c| c.feature && is_battery_usage(c.usage_page, c.usage)).copied().collect();
    out.extend(caps.iter().filter(|c| !c.feature && is_battery_usage(c.usage_page, c.usage)).copied());
    out
}

/// Apple's Magic devices report a plain percentage while declaring 0–255 (Linux: HID_BATTERY_QUIRK_PERCENT).
pub fn percent_quirk(vid: u16) -> bool {
    vid == 0x05AC
}

/// The level from a field's raw value (the bits as read, unsigned): None when the field cannot mean a level.
pub fn level_from_raw(raw: u32, cap: &ValueCap, quirk_percent: bool) -> Option<Percent> {
    if cap.bit_size == 0 || cap.bit_size > 32 {
        return None;
    }
    if quirk_percent && raw <= 100 {
        return Percent::new(raw as i64);
    }
    let (min, max) = (cap.logical_min as i64, cap.logical_max as i64);
    if max <= min {
        return None;
    }
    // (A range the field's bits cannot hold is a broken descriptor.)
    let bits = cap.bit_size as u32;
    if min >= 0 && bits < 32 && max > ((1i64 << bits) - 1) {
        return None;
    }
    let mut v = raw as i64;
    if min < 0 && bits < 64 {
        // (Signed: the top bit of `bit_size` bits is the sign.)
        let mask = if bits >= 32 { u32::MAX as i64 } else { (1i64 << bits) - 1 };
        v &= mask;
        if v & (1i64 << (bits - 1)) != 0 {
            v -= 1i64 << bits;
        }
    }
    let v = v.clamp(min, max);
    let span = max - min;
    let pct = ((v - min) * 100 + span / 2) / span;
    Percent::new(pct)
}

/// The generic reader (generic.cpp PollGenericHid's loop): each battery field asked in turn — feature reports first —
/// through `t` by `deadline`, its reply checked against its report id and length, its value taken by `extract` (on
/// Windows HidP_GetUsageValue over the preparsed data; elsewhere `extract_bits`), the first that means a level wins.
/// `feature_len` / `input_len`: the collection's report sizes (0: none of that kind).
pub fn read_generic<T: HidTransport + ?Sized>(t: &mut T, caps: &[ValueCap], feature_len: usize, input_len: usize, quirk_percent: bool, deadline: Instant, extract: &dyn Fn(&ValueCap, &mut [u8]) -> Option<u32>) -> Result<Percent, TErr> {
    let mut last = TErr::Failed("no battery field".into());
    for cap in battery_caps(caps) {
        let len = if cap.feature { feature_len } else { input_len };
        if len == 0 {
            continue;
        }
        let got = if cap.feature { t.get_feature(cap.report_id, len, deadline) } else { t.get_input(cap.report_id, len, deadline) };
        let mut rep = match got {
            Ok(r) => r,
            Err(TErr::Timeout) => return Err(TErr::Timeout),
            Err(TErr::Gone) => return Err(TErr::Gone),
            Err(e) => {
                last = e;
                continue;
            }
        };
        if let Err(e) = checked_reply(&rep, cap.report_id, len) {
            last = e;
            continue;
        }
        if let Some(p) = extract(&cap, &mut rep).and_then(|raw| level_from_raw(raw, &cap, quirk_percent)) {
            return Ok(p);
        }
        last = TErr::BadReply;
    }
    Err(last)
}

/// `bit_size` bits from `report` starting `bit_offset` bits in (little-endian, as HID packs fields), or None when the
/// report is too short or the size is not 1..=32.
pub fn extract_bits(report: &[u8], bit_offset: usize, bit_size: usize) -> Option<u32> {
    if bit_size == 0 || bit_size > 32 {
        return None;
    }
    let end = bit_offset.checked_add(bit_size)?;
    if end > report.len().checked_mul(8)? {
        return None;
    }
    let mut v: u64 = 0;
    for i in 0..bit_size {
        let b = bit_offset + i;
        if report[b / 8] >> (b % 8) & 1 == 1 {
            v |= 1u64 << i;
        }
    }
    Some(v as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(min: i32, max: i32, bits: u16) -> ValueCap {
        ValueCap { feature: true, report_id: 3, usage_page: 0x06, usage: 0x20, link_collection: 0, logical_min: min, logical_max: max, bit_size: bits, report_count: 1 }
    }

    #[test]
    fn usages() {
        assert!(is_battery_usage(0x06, 0x20));
        assert!(is_battery_usage(0x85, 0x65));
        assert!(!is_battery_usage(0x06, 0x21));
        assert!(!is_battery_usage(0x84, 0x65));
        let input = ValueCap { feature: false, ..cap(0, 100, 8) };
        let other = ValueCap { usage: 0x30, ..cap(0, 100, 8) };
        let list = battery_caps(&[input, other, cap(0, 255, 8)]);
        assert_eq!(list.len(), 2);
        assert!(list[0].feature && !list[1].feature, "feature first, as the original");
    }

    #[test]
    fn ranges() {
        assert_eq!(level_from_raw(50, &cap(0, 100, 8), false).map(Percent::get), Some(50));
        assert_eq!(level_from_raw(255, &cap(0, 255, 8), false).map(Percent::get), Some(100));
        assert_eq!(level_from_raw(128, &cap(0, 255, 8), false).map(Percent::get), Some(50));
        assert_eq!(level_from_raw(0, &cap(0, 255, 8), false).map(Percent::get), Some(0));
        // (Out of range: clamped, never over 100.)
        assert_eq!(level_from_raw(200, &cap(0, 100, 8), false).map(Percent::get), Some(100));
        assert_eq!(level_from_raw(5, &cap(10, 20, 8), false).map(Percent::get), Some(0));
    }

    #[test]
    fn nonsense_fields_are_rejected() {
        assert_eq!(level_from_raw(0, &cap(0, 0, 8), false), None, "min = max = 0 (the original read it as 0 %)");
        assert_eq!(level_from_raw(42, &cap(0, 0, 8), false), None, "min = max: the original took 42 %");
        assert_eq!(level_from_raw(42, &cap(100, 0, 8), false), None, "upside down");
        assert_eq!(level_from_raw(42, &cap(0, 1000, 8), false), None, "more than 8 bits can hold");
        assert_eq!(level_from_raw(42, &cap(0, 100, 0), false), None);
        assert_eq!(level_from_raw(42, &cap(0, 100, 33), false), None);
    }

    #[test]
    fn signed_fields_and_the_apple_quirk() {
        // (-128..127 in 8 bits: raw 0x80 is -128 → 0 %, 0x7F is 127 → 100 %, 0 → 50 %.)
        assert_eq!(level_from_raw(0x80, &cap(-128, 127, 8), false).map(Percent::get), Some(0));
        assert_eq!(level_from_raw(0x7F, &cap(-128, 127, 8), false).map(Percent::get), Some(100));
        assert_eq!(level_from_raw(0, &cap(-128, 127, 8), false).map(Percent::get), Some(50));
        assert_eq!(level_from_raw(73, &cap(0, 255, 8), true).map(Percent::get), Some(73));
        assert_eq!(level_from_raw(200, &cap(0, 255, 8), true).map(Percent::get), Some(78), "over 100: the declared range");
        assert!(percent_quirk(0x05AC) && !percent_quirk(0x046D));
    }

    #[test]
    fn bits_are_length_checked() {
        let r = [0x03u8, 0x64, 0xA5];
        assert_eq!(extract_bits(&r, 8, 8), Some(0x64));
        assert_eq!(extract_bits(&r, 16, 4), Some(0x5));
        assert_eq!(extract_bits(&r, 20, 4), Some(0xA));
        assert_eq!(extract_bits(&r, 0, 24), Some(0xA56403));
        assert_eq!(extract_bits(&r, 17, 8), None, "past the end");
        assert_eq!(extract_bits(&r, usize::MAX, 8), None, "no overflow");
        assert_eq!(extract_bits(&[], 0, 1), None);
        assert_eq!(extract_bits(&r, 0, 0), None);
        assert_eq!(extract_bits(&r, 0, 33), None);
    }

    #[test]
    fn the_generic_reader_over_a_fake_device() {
        use crate::allow::HidIdent;
        use crate::transport::fake::FakeHid;
        use std::time::Duration;
        let id = HidIdent { vid: 0x1111, pid: 0x2222, usage_page: 0x06, usage: 0x20, interface: -1 };
        // (Report 3, 3 bytes: the level in byte 1.)
        let ext = |_c: &ValueCap, r: &mut [u8]| extract_bits(r, 8, 8);
        let far = Instant::now() + Duration::from_secs(5);
        let mut d = FakeHid::new(id.clone());
        d.features.insert(3, vec![3, 77, 0]);
        assert_eq!(read_generic(&mut d, &[cap(0, 100, 8)], 3, 0, false, far, &ext).map(Percent::get), Ok(77));
        // (A reply for another report, or a short one: not taken; the input report then tried.)
        let mut d = FakeHid::new(id.clone());
        d.features.insert(3, vec![4, 77, 0]);
        d.inputs.insert(3, vec![3, 20, 0]);
        let input = ValueCap { feature: false, ..cap(0, 100, 8) };
        assert_eq!(read_generic(&mut d, &[cap(0, 100, 8), input], 3, 3, false, far, &ext).map(Percent::get), Ok(20));
        let mut d = FakeHid::new(id.clone());
        d.features.insert(3, vec![3]);
        assert_eq!(read_generic(&mut d, &[cap(0, 100, 8)], 3, 0, false, far, &ext), Err(TErr::BadReply));
        // (A nonsense range: no level, not a made-up one.)
        let mut d = FakeHid::new(id.clone());
        d.features.insert(3, vec![3, 77, 0]);
        assert!(read_generic(&mut d, &[cap(0, 0, 8)], 3, 0, false, far, &ext).is_err());
        // (Past the deadline: Timeout at once.)
        let mut d = FakeHid::new(id);
        d.features.insert(3, vec![3, 77, 0]);
        assert_eq!(read_generic(&mut d, &[cap(0, 100, 8)], 3, 0, false, Instant::now() - Duration::from_millis(1), &ext), Err(TErr::Timeout));
        assert!(d.sent.is_empty(), "the generic reader never sends anything");
    }

    #[test]
    fn fuzz_short_long_and_garbage() {
        // (Every report length 0..40 and offsets/sizes around the edges: never a panic, None past the end.)
        let mut seed: u32 = 0x1234_5678;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        for len in 0..40usize {
            let rep: Vec<u8> = (0..len).map(|_| next() as u8).collect();
            for off in [0usize, 1, 7, 8, 9, len * 8 - len.min(1), len * 8, len * 8 + 1] {
                for size in [0usize, 1, 7, 8, 16, 31, 32, 33] {
                    let got = extract_bits(&rep, off, size);
                    if size == 0 || size > 32 || off + size > len * 8 {
                        assert_eq!(got, None);
                    } else {
                        assert!(got.is_some());
                    }
                }
            }
        }
        for _ in 0..5000 {
            let c = ValueCap { feature: next() & 1 == 0, report_id: next() as u8, usage_page: 6, usage: 0x20, link_collection: 0, logical_min: next() as i32 % 300, logical_max: next() as i32 % 300, bit_size: (next() % 40) as u16, report_count: 1 };
            if let Some(p) = level_from_raw(next(), &c, next() & 1 == 0) {
                assert!(p.get() <= 100);
            }
        }
    }
}
