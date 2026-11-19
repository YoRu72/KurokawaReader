// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery), piece P1: a HID report descriptor read as Windows' HidP_GetCaps sees it.
// Derived from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/linux/hid_linux.cpp (ParseReportDescriptor, FinalizeCollection) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later.
// Linux's hidraw gives one node per interface, Windows one handle per top-level collection: the descriptor is cut into
// its application collections so the readers' tables (vendor, product, usage page, usage, report lengths) match as
// they do on Windows.
// Changed here: a report length counts the report id byte whether or not the device numbers its reports (Windows'
// InputReportByteLength does; the original added it only for numbered reports, so an unnumbered pad's lengths were one
// short of the tables'); a collection's own report ids are kept, so a listening reader is given only its collection's
// input reports (hidraw hands over every report of the interface); the battery fields (Battery Strength, Absolute State
// Of Charge) are found with their bit offsets, so the generic reader works without HidP_GetUsageValue; Push / Pop,
// extended (32-bit) usages, usage ranges, long items and the signedness of the logical range follow the HID spec and
// Linux's own parser (a logical maximum is read unsigned when the minimum is not negative); every count is bounded.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::hidvalue::{is_battery_usage, ValueCap};
use std::collections::BTreeMap;

/// The largest descriptor a device may have (Linux's HID_MAX_DESCRIPTOR_SIZE).
pub const MAX_DESCRIPTOR: usize = 4096;

/// A battery value field: its cap and where its bits start in the report as the transport gives it (the report id
/// byte first, counted whether or not the device numbers its reports).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Field {
    pub cap: ValueCap,
    pub bit_offset: usize,
}

/// One top-level (application) collection.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DescColl {
    pub usage_page: u16,
    pub usage: u16,
    /// Windows' lengths: the longest report of that kind in this collection plus the report id byte; 0 when none.
    pub input_len: usize,
    pub output_len: usize,
    pub feature_len: usize,
    /// The report ids of this collection's input reports (empty when the device does not number its reports).
    pub input_ids: Vec<u8>,
    /// The device numbers its reports (any report id seen anywhere in the descriptor).
    pub numbered: bool,
    pub battery: Vec<Field>,
}

#[derive(Clone, Copy, Default)]
struct Globals {
    usage_page: u16,
    logical_min: i64,
    /// The logical maximum read signed and unsigned (by its item's size).
    logical_max_signed: i64,
    logical_max_unsigned: i64,
    report_size: u32,
    report_count: u32,
    report_id: u8,
}

fn item_u32(d: &[u8]) -> u32 {
    let mut v = 0u32;
    for (i, b) in d.iter().enumerate().take(4) {
        v |= (*b as u32) << (8 * i);
    }
    v
}

fn item_i64(d: &[u8]) -> i64 {
    let v = item_u32(d);
    match d.len() {
        1 => v as u8 as i8 as i64,
        2 => v as u16 as i16 as i64,
        4 => v as i32 as i64,
        _ => 0,
    }
}

/// The logical maximum as Linux reads it: signed when the minimum is negative, else unsigned.
fn logical_max(g: &Globals) -> i64 {
    if g.logical_min < 0 {
        g.logical_max_signed
    } else {
        g.logical_max_unsigned
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum K {
    Input,
    Output,
    Feature,
}

/// The collections of a report descriptor (at most 64; fields and usages bounded too). Bytes past a broken item are
/// left alone; what was read before them stands.
pub fn parse(desc: &[u8]) -> Vec<DescColl> {
    let desc = &desc[..desc.len().min(MAX_DESCRIPTOR)];
    let mut out: Vec<DescColl> = Vec::new();
    // (Per collection: (kind, report id) → bits; the offsets are per (kind, report id) over the whole descriptor.)
    let mut bits: Vec<BTreeMap<(K, u8), u32>> = Vec::new();
    let mut offsets: BTreeMap<(K, u8), u32> = BTreeMap::new();
    let mut g = Globals::default();
    let mut stack: Vec<Globals> = Vec::new();
    let mut usages: Vec<u32> = Vec::new();
    let mut umin: Option<u32> = None;
    let mut depth: u32 = 0;
    let mut cur: Option<usize> = None;
    let mut numbered = false;
    let mut i = 0usize;
    while i < desc.len() {
        let prefix = desc[i];
        i += 1;
        if prefix == 0xFE {
            // (A long item: its size and tag, then its data — skipped.)
            if i + 2 > desc.len() {
                break;
            }
            let n = desc[i] as usize;
            i += 2 + n;
            continue;
        }
        let size = match prefix & 3 {
            3 => 4,
            n => n as usize,
        };
        if i + size > desc.len() {
            break;
        }
        let data = &desc[i..i + size];
        i += size;
        let typ = (prefix >> 2) & 3;
        let tag = prefix >> 4;
        let full = |u: u32, sz: usize, page: u16| if sz == 4 { u } else { ((page as u32) << 16) | (u & 0xFFFF) };
        match typ {
            1 => match tag {
                0 => g.usage_page = item_u32(data) as u16,
                1 => g.logical_min = item_i64(data),
                2 => {
                    g.logical_max_signed = item_i64(data);
                    g.logical_max_unsigned = item_u32(data) as i64;
                }
                7 => g.report_size = item_u32(data).min(256),
                8 => {
                    g.report_id = item_u32(data) as u8;
                    if g.report_id != 0 {
                        numbered = true;
                    }
                }
                9 => g.report_count = item_u32(data).min(4096),
                10 => {
                    if stack.len() < 16 {
                        stack.push(g);
                    }
                }
                11 => {
                    if let Some(p) = stack.pop() {
                        g = p;
                    }
                }
                _ => {}
            },
            2 => match tag {
                0 => {
                    if usages.len() < 1024 {
                        usages.push(full(item_u32(data), size, g.usage_page));
                    }
                }
                1 => umin = Some(full(item_u32(data), size, g.usage_page)),
                2 => {
                    if let Some(lo) = umin.take() {
                        let hi = full(item_u32(data), size, g.usage_page);
                        if hi >= lo {
                            for u in lo..=hi.min(lo.saturating_add(1023)) {
                                if usages.len() >= 1024 {
                                    break;
                                }
                                usages.push(u);
                            }
                        }
                    }
                }
                _ => {}
            },
            0 => match tag {
                0x0A => {
                    if depth == 0 && out.len() < 64 {
                        let u = usages.first().copied().unwrap_or((g.usage_page as u32) << 16);
                        out.push(DescColl { usage_page: (u >> 16) as u16, usage: u as u16, ..Default::default() });
                        bits.push(BTreeMap::new());
                        cur = Some(out.len() - 1);
                    }
                    depth = depth.saturating_add(1).min(64);
                    usages.clear();
                    umin = None;
                }
                0x0C => {
                    depth = depth.saturating_sub(1);
                    usages.clear();
                    umin = None;
                }
                0x08 | 0x09 | 0x0B => {
                    let k = match tag {
                        0x08 => K::Input,
                        0x09 => K::Output,
                        _ => K::Feature,
                    };
                    // (A main item outside every collection belongs to one of its own.)
                    let c = match cur {
                        Some(c) => c,
                        None => {
                            out.push(DescColl::default());
                            bits.push(BTreeMap::new());
                            cur = Some(out.len() - 1);
                            out.len() - 1
                        }
                    };
                    let flags = item_u32(data);
                    let (constant, variable) = (flags & 1 == 1, flags & 2 == 2);
                    let at = *offsets.get(&(k, g.report_id)).unwrap_or(&0);
                    let n = g.report_size.saturating_mul(g.report_count);
                    if k != K::Output && !constant && variable && g.report_size > 0 && g.report_size <= 32 {
                        for f in 0..g.report_count.min(256) {
                            let Some(u) = usages.get(f as usize).or(usages.last()).copied() else { break };
                            let (page, usage) = ((u >> 16) as u16, u as u16);
                            if !is_battery_usage(page, usage) || out[c].battery.len() >= 16 {
                                continue;
                            }
                            let cap = ValueCap {
                                feature: k == K::Feature,
                                report_id: g.report_id,
                                usage_page: page,
                                usage,
                                link_collection: 0,
                                logical_min: g.logical_min.clamp(i32::MIN as i64, i32::MAX as i64) as i32,
                                logical_max: logical_max(&g).clamp(i32::MIN as i64, i32::MAX as i64) as i32,
                                bit_size: g.report_size as u16,
                                report_count: 1,
                            };
                            // (A field whose place overflows is no field.)
                            let Some(bit_offset) = field_offset(at, f, g.report_size) else { break };
                            out[c].battery.push(Field { cap, bit_offset });
                        }
                    }
                    let next = at.saturating_add(n);
                    offsets.insert((k, g.report_id), next);
                    let e = bits[c].entry((k, g.report_id)).or_insert(0);
                    *e = (*e).max(next);
                    usages.clear();
                    umin = None;
                }
                _ => {}
            },
            _ => {}
        }
    }
    for (c, b) in out.iter_mut().zip(bits.iter()) {
        c.numbered = numbered;
        let len = |k: K| b.iter().filter(|((kk, _), _)| *kk == k).map(|(_, v)| (*v as usize).saturating_add(7) / 8 + 1).max().unwrap_or(0);
        c.input_len = len(K::Input);
        c.output_len = len(K::Output);
        c.feature_len = len(K::Feature);
        if numbered {
            c.input_ids = b.keys().filter(|(k, _)| *k == K::Input).map(|(_, id)| *id).collect();
        }
    }
    out
}

/// Where field `index` (of `size` bits) of a main item starting at bit `at` of its report sits in the report as the
/// transport gives it (the report id byte first): None when that overflows — a hostile descriptor's field is no field.
fn field_offset(at: u32, index: u32, size: u32) -> Option<usize> {
    let bits = index.checked_mul(size)?.checked_add(at)?;
    usize::try_from(bits).ok()?.checked_add(8)
}

/// A battery field's raw value from a report the transport gave (the report id byte first).
pub fn field_value(fields: &[Field], cap: &ValueCap, report: &[u8]) -> Option<u32> {
    let f = fields.iter().find(|f| &f.cap == cap)?;
    crate::hidvalue::extract_bits(report, f.bit_offset, cap.bit_size as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    // (Made-up descriptors, written as the HID spec's items.)
    /// A mouse (page 1, usage 2) with report 1 (3 buttons + 5 pad bits + X/Y bytes), and a battery collection (page
    /// 0x0C usage 1) with feature report 3: one byte Battery Strength 0..100, and input report 3 the same.
    fn mouse_with_battery() -> Vec<u8> {
        vec![
            0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, // Usage Page GD, Usage Mouse, Collection Application
            0x85, 0x01, // Report ID 1
            0x09, 0x01, 0xA1, 0x00, // Usage Pointer, Collection Physical
            0x05, 0x09, 0x19, 0x01, 0x29, 0x03, 0x15, 0x00, 0x25, 0x01, 0x95, 0x03, 0x75, 0x01, 0x81, 0x02, // 3 buttons
            0x95, 0x01, 0x75, 0x05, 0x81, 0x03, // padding
            0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x15, 0x81, 0x25, 0x7F, 0x75, 0x08, 0x95, 0x02, 0x81, 0x06, // X, Y
            0xC0, 0xC0, // End, End
            0x05, 0x0C, 0x09, 0x01, 0xA1, 0x01, // Consumer, Usage 1, Collection Application
            0x85, 0x03, // Report ID 3
            0x05, 0x06, 0x09, 0x20, 0x15, 0x00, 0x26, 0x64, 0x00, 0x75, 0x08, 0x95, 0x01, 0xB1, 0x02, // Feature: Battery Strength
            0x05, 0x06, 0x09, 0x20, 0x81, 0x02, // Input: the same
            0x85, 0x04, 0x06, 0x00, 0xFF, 0x09, 0x01, 0x75, 0x08, 0x95, 0x13, 0x91, 0x02, // Output report 4: 19 bytes
            0xC0,
        ]
    }

    #[test]
    fn collections_lengths_ids_and_battery_fields() {
        let cs = parse(&mouse_with_battery());
        assert_eq!(cs.len(), 2);
        let (m, b) = (&cs[0], &cs[1]);
        assert_eq!((m.usage_page, m.usage), (0x01, 0x02));
        assert_eq!(m.input_len, 4, "1 + (3 + 5 + 16 bits = 3 bytes)");
        assert_eq!((m.output_len, m.feature_len), (0, 0));
        assert_eq!(m.input_ids, vec![1]);
        assert!(m.numbered && m.battery.is_empty());
        assert_eq!((b.usage_page, b.usage), (0x0C, 0x01));
        assert_eq!((b.input_len, b.feature_len, b.output_len), (2, 2, 20));
        assert_eq!(b.input_ids, vec![3]);
        assert_eq!(b.battery.len(), 2);
        let f = b.battery[0];
        assert!(f.cap.feature && f.cap.report_id == 3 && f.cap.logical_min == 0 && f.cap.logical_max == 100 && f.cap.bit_size == 8);
        assert_eq!(f.bit_offset, 8);
        assert!(!b.battery[1].cap.feature);
        assert_eq!(field_value(&b.battery, &f.cap, &[3, 57]), Some(57));
        assert_eq!(field_value(&b.battery, &f.cap, &[3]), None, "short report");
        // (The generic reader's rule over it: 57 of 0..100.)
        assert_eq!(crate::hidvalue::level_from_raw(57, &f.cap, false).map(|p| p.get()), Some(57));
    }

    #[test]
    fn unnumbered_lengths_count_the_id_byte_as_windows_does() {
        // (A pad: page 1 usage 5, 8 input bytes, 4 output bytes, no report ids.)
        let d = [0x05, 0x01, 0x09, 0x05, 0xA1, 0x01, 0x15, 0x00, 0x26, 0xFF, 0x00, 0x75, 0x08, 0x95, 0x08, 0x09, 0x30, 0x81, 0x02, 0x95, 0x04, 0x09, 0x31, 0x91, 0x02, 0xC0];
        let cs = parse(&d);
        assert_eq!(cs.len(), 1);
        assert_eq!((cs[0].input_len, cs[0].output_len), (9, 5));
        assert!(!cs[0].numbered && cs[0].input_ids.is_empty());
    }

    #[test]
    fn offsets_follow_earlier_fields_of_the_same_report_and_push_pop() {
        // (Report 2: a 4-bit field, then Push, a 12-bit Battery Strength 0..4095, Pop; then a 1-byte field.)
        let d = [
            0x05, 0x01, 0x09, 0x06, 0xA1, 0x01, 0x85, 0x02, 0x75, 0x04, 0x95, 0x01, 0x09, 0x30, 0x81, 0x02, // 4 bits
            0xA4, 0x05, 0x06, 0x09, 0x20, 0x15, 0x00, 0x26, 0xFF, 0x0F, 0x75, 0x0C, 0x81, 0x02, 0xB4, // 12 bits, popped
            0x09, 0x31, 0x81, 0x02, // 4 bits again (size 4 restored by Pop), page 1 again
            0xC0,
        ];
        let cs = parse(&d);
        assert_eq!(cs[0].battery.len(), 1);
        let f = cs[0].battery[0];
        assert_eq!((f.bit_offset, f.cap.bit_size, f.cap.logical_max), (8 + 4, 12, 4095));
        assert_eq!(cs[0].input_len, 1 + 3, "4 + 12 + 4 bits = 20 bits = 3 bytes");
        // (Report 2, bits 4..16 = 0x0ABC → 2748.)
        assert_eq!(field_value(&cs[0].battery, &f.cap, &[2, 0xC0, 0xAB, 0x00]), Some(0xABC));
    }

    #[test]
    fn extended_usages_signed_ranges_and_long_items() {
        // (A Battery System page usage written as a 4-byte extended usage: page 0x85, usage 0x65; logical -1..100.)
        let d = [0xFE, 0x02, 0x10, 0xAA, 0xBB, 0x06, 0x00, 0xFF, 0x09, 0x01, 0xA1, 0x01, 0x0B, 0x65, 0x00, 0x85, 0x00, 0x15, 0xFF, 0x25, 0x64, 0x75, 0x08, 0x95, 0x01, 0xB1, 0x02, 0xC0];
        let cs = parse(&d);
        assert_eq!(cs.len(), 1);
        assert_eq!((cs[0].usage_page, cs[0].usage), (0xFF00, 0x01));
        let f = cs[0].battery[0];
        assert_eq!((f.cap.usage_page, f.cap.usage, f.cap.logical_min, f.cap.logical_max), (0x85, 0x65, -1, 100));
        // (min 0, a one-byte 0xFF maximum: 255, as Linux reads it — not -1.)
        let d2 = [0x05, 0x06, 0x09, 0x20, 0xA1, 0x01, 0x09, 0x20, 0x15, 0x00, 0x25, 0xFF, 0x75, 0x08, 0x95, 0x01, 0xB1, 0x02, 0xC0];
        assert_eq!(parse(&d2)[0].battery[0].cap.logical_max, 255);
    }

    #[test]
    fn broken_and_hostile_descriptors_end_calmly() {
        assert!(parse(&[]).is_empty());
        assert!(parse(&[0x05]).is_empty(), "an item cut short");
        let _ = parse(&[0xFE, 0xFF]);
        // (Thousands of collections and fields: bounded.)
        let mut d = Vec::new();
        for _ in 0..2000 {
            d.extend_from_slice(&[0x05, 0x06, 0xA1, 0x01, 0x09, 0x20, 0x75, 0x08, 0x95, 0xFF, 0x81, 0x02, 0xC0]);
        }
        let cs = parse(&d);
        assert!(cs.len() <= 64 && cs.iter().all(|c| c.battery.len() <= 16));
        // (Unbalanced ends never underflow; a huge report size is bounded.)
        let _ = parse(&[0xC0, 0xC0, 0x77, 0xFF, 0xFF, 0xFF, 0xFF, 0x97, 0xFF, 0xFF, 0xFF, 0xFF, 0x81, 0x02]);
        // (A field's place that overflows: no field, never a panic.)
        assert_eq!(field_offset(u32::MAX, 1, 32), None);
        assert_eq!(field_offset(u32::MAX - 10, 0, 32), Some(u32::MAX as usize - 10 + 8));
        assert_eq!(field_offset(0, u32::MAX, 2), None);
        assert_eq!(field_offset(16, 2, 8), Some(8 + 32));
        // (Fields pushed as far as a descriptor of the largest size can: huge padding, then Battery Strength fields.)
        let mut h = vec![0x05, 0x06, 0xA1, 0x01, 0x76, 0x00, 0x01, 0x96, 0x00, 0x10];
        while h.len() < MAX_DESCRIPTOR - 16 {
            h.extend_from_slice(&[0x81, 0x01]);
        }
        h.extend_from_slice(&[0x09, 0x20, 0x75, 0x20, 0x95, 0xFF, 0x81, 0x02, 0xC0]);
        let cs = parse(&h);
        assert!(cs.iter().all(|c| c.battery.iter().all(|f| f.bit_offset >= 8)));
        let r = vec![0u8; 64];
        for c in &cs {
            for f in &c.battery {
                assert_eq!(field_value(&c.battery, &f.cap, &r), None, "far past any report: no value");
            }
        }
        let m = mouse_with_battery();
        for n in 0..m.len() {
            let _ = parse(&m[..n]);
        }
    }
}
