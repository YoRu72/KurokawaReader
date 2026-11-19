// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the headsets' requests, as allow.rs takes them (piece 6).
// Each entry: the reader's request collections (allow::Products::driver — its table rows, each by vendor and product)
// or a list of product ids, the report kind, and every byte. Templates bound each variable byte (a sequence or
// transaction id) to a range and check the checksum that covers it. Every request here only asks — battery, charging,
// link state, a name; what the original sent that switches a mode or opens a session (heads/*.rs's headers say which)
// is not in this file at all. HID++ for the G headsets: allow.rs's `permit_hidpp` (ADC_MEASUREMENT's getter added).
// Derived from Wireless Device Battery Monitor (GPL-3.0-or-later; NOTICE.md). Copyright (C) 2026 Kurokawa contributors.
use super::*;
use crate::allow::{Products, ReportKind, SetEntry, Template, B};

const F: ReportKind = ReportKind::Feature;
const O: ReportKind = ReportKind::Output;

const fn set(driver: &'static str, kind: ReportKind, bytes: &'static [&'static [u8]], why: &'static str) -> SetEntry {
    SetEntry { devices: Products::driver(driver), kind, bytes, why }
}
const fn of(vid: u16, pids: &'static [u16], kind: ReportKind, bytes: &'static [&'static [u8]], why: &'static str) -> SetEntry {
    SetEntry { devices: Products::of(vid, pids), kind, bytes, why }
}

/// A 64-byte pattern: zeros, with the listed bytes.
const fn pat64(at: &[(usize, B)]) -> [B; 64] {
    let mut p = [B::Is(0); 64];
    let mut i = 0;
    while i < at.len() {
        p[at[i].0] = at[i].1;
        i += 1;
    }
    p
}

const RZ_HS: [B; 64] = pat64(&[(0, B::Is(0x02)), (2, B::In(0x60, 0x7F)), (6, B::Is(0x04)), (9, B::Is(0x80)), (10, B::OneOf(&[razer::HS_BATTERY, razer::HS_CHARGING])), (62, B::In(0x00, 0xFF))]);
const RZ_V3X: [B; 64] = pat64(&[(0, B::Is(0x07)), (2, B::In(0x01, 0xFF)), (6, B::Is(0x02)), (7, B::Is(0x07)), (8, B::OneOf(&[0x80, 0x84])), (62, B::In(0x00, 0xFF))]);
const SONY: [B; 64] = pat64(&[
    (0, B::Is(0x02)),
    (1, B::Is(12)),
    (2, B::Is(0x01)),
    (4, B::Is(0xFC)),
    (5, B::Is(8)),
    (6, B::Is(0x96)),
    (7, B::Is(0xC3)),
    (8, B::Is(0x41)),
    (9, B::Is(0x04)),
    (10, B::Is(0x01)),
    (11, B::In(0x02, 0xFF)),
    (13, B::In(0x00, 0xFF)),
]);
const JABRA_BATTERY: [B; 7] = [B::Is(0x05), B::Is(0x04), B::Is(0x00), B::In(0x00, 0xFF), B::Is(0x46), B::Is(0x12), B::Is(0x02)];
const JABRA_NAME: [B; 7] = [B::Is(0x05), B::Is(0x04), B::Is(0x00), B::In(0x00, 0xFF), B::Is(0x46), B::Is(0x02), B::Is(0x00)];
const JABRA_BATTERY_08: [B; 7] = [B::Is(0x05), B::Is(0x08), B::Is(0x00), B::In(0x00, 0xFF), B::Is(0x46), B::Is(0x12), B::Is(0x02)];
const JABRA_NAME_08: [B; 7] = [B::Is(0x05), B::Is(0x08), B::Is(0x00), B::In(0x00, 0xFF), B::Is(0x46), B::Is(0x02), B::Is(0x00)];
const JABRA_DONGLES: Products = Products::of(0x0B0E, &jabra::PIDS).page(0xFF00);
const JABRA_CABLE: Products = Products::of(0x0B0E, &[0x2548]).page(0xFF00).usage(0x0005);
const BRAGI_PROPS: B = B::OneOf(&crate::mice::corsair::PROPS);

const SS_A1: [u16; 3] = [0x12B3, 0x12B6, 0x12D7];
const SS_A7: [u16; 3] = [0x1260, 0x12AD, 0x1252];
const SS_NOVAPRO: [u16; 2] = [0x12E0, 0x225D];
const SS_NOVA: [u16; 23] = [0x220E, 0x2212, 0x2216, 0x2236, 0x2269, 0x226D, 0x2232, 0x2253, 0x230A, 0x2202, 0x22A1, 0x227E, 0x2206, 0x2258, 0x229E, 0x22AD, 0x223A, 0x22A9, 0x227A, 0x22A4, 0x22A5, 0x220A, 0x22A7];

pub static SETS: &[SetEntry] = &[
    set("hs-razer-v2pro", F, &[&razer::V2PRO], "BlackShark V2 Pro 2020: the receiver's status read (HaloBattery, openrazer #1280)"),
    set("hs-razer-v3", O, &[&razer::V3_GET, &razer::V3_CHARGING], "BlackShark V3 / V3 Pro: GET class 21 battery, 2A charging (OpenRazer PR 2794)"),
    SetEntry { devices: Products::of(0x1038, &SS_A1).page(0xFF43), kind: O, bytes: &[&steelseries::Q_A1], why: "Arctis 1: battery (06 12)" },
    SetEntry { devices: Products::of(0x1038, &SS_A7).page(0xFF43), kind: O, bytes: &[&steelseries::Q_A7], why: "Arctis 7 / Pro: battery (06 18)" },
    SetEntry { devices: Products::of(0x1038, &[0x12C2]).iface(0), kind: O, bytes: &[&steelseries::Q_A9], why: "Arctis 9: status (00 20)" },
    SetEntry {
        devices: Products::of(0x1038, &[0x1290]).iface(0),
        kind: O,
        bytes: &[&steelseries::Q_APRO_LINK, &steelseries::Q_APRO_LEVEL, &steelseries::Q_APRO_LINK_N, &steelseries::Q_APRO_LEVEL_N],
        why: "Arctis Pro Wireless: link (41 AA), level (40 AA)",
    },
    SetEntry { devices: Products::of(0x1038, &SS_NOVAPRO).iface(4), kind: O, bytes: &[&steelseries::Q_NOVAPRO], why: "Arctis Nova Pro Wireless: status (06 B0)" },
    SetEntry { devices: Products::of(0x1038, &SS_NOVA).page(0xFFC0), kind: O, bytes: &[&steelseries::Q_NOVA], why: "Nova family: status (00 B0)" },
    SetEntry { devices: Products::of(0x1038, &[0x2244]).page(0xFFC0).iface(3), kind: O, bytes: &[&steelseries::Q_ELITE], why: "Arctis Nova Elite: status (01 B0)" },
    set("hs-corsair-void", O, &[&corsair::Q_VOID], "Corsair Void / HS: battery (C9 64, HeadsetControl)"),
    set("hs-astro-x", O, &[&astro::Q_X], "ASTRO A50 X / Gen 5: battery (0C … 06 0C)"),
    set("hs-astro", O, &[&astro::Q_STATUS, &astro::Q_BATTERY], "ASTRO A50 Gen 3 / 4, A20: headset status (54), battery (7C)"),
    of(0x9886, &astro::GEN3, O, &[&astro::Q_GEN3_UI], "ASTRO A50 Gen 3: current UI read (72 01), OpenAstroCC"),
    set("hs-audeze", O, &[&audeze::Q], "Audeze Maxwell: attribute 0CD6, the battery"),
    of(0x03F0, &[0x05B7, 0x0C9D, 0x069F, 0x0995], O, &[&hyperx::C3_LINK, &hyperx::C3_CHARGING, &hyperx::C3_BATTERY], "HyperX Cloud III / II Core: link, charging, battery (66 82 / 8A / 89)"),
    of(0x03F0, &[0x06BE, 0x02CC], O, &[&hyperx::C3S_LINK, &hyperx::C3S_BATTERY, &hyperx::C3S_CHARGING], "HyperX Cloud III S: link, battery, charging"),
    SetEntry { devices: Products::of(0x03F0, &[0x0696, 0x018B, 0x0D93]).page(0xFF90), kind: O, bytes: &[&hyperx::C2_BATTERY, &hyperx::C2_CHARGING], why: "HyperX Cloud II: battery, charging" },
    of(0x0951, &[0x1718], O, &[&hyperx::C2K_BATTERY, &hyperx::C2K_CHARGING], "HyperX Cloud II (Kingston): battery, charging"),
    SetEntry { devices: Products::of(0x0951, &[0x16EA, 0x16EB]).page(0xFF13).usage(0x0001), kind: O, bytes: &[&hyperx::C2K_BATTERY, &hyperx::C2K_CHARGING], why: "HyperX Cloud Flight S: the Cloud II (Kingston) reads (LennardKittner/HyperHeadset)" },
    of(0x03F0, &[0x098D], O, &[&hyperx::ALPHA_LINK, &hyperx::ALPHA_CHARGING, &hyperx::ALPHA_BATTERY], "HyperX Cloud Alpha: link, charging, battery"),
    of(0x03F0, &[0x08BE, 0x0AB5, 0x0D97, 0x0F98, 0x0DA0], O, &[&hyperx::A2_LINK, &hyperx::A2_BATTERY], "HyperX Cloud Alpha 2, Pulsefire Haste 2: link (52 01), battery (50 02)"),
    of(0x0951, &[0x16C4, 0x1723, 0x1749], O, &[&hyperx::FLIGHT_Q], "HyperX Cloud Flight: battery voltage (21 FF 05)"),
    of(0x03F0, &[0x0E90], O, &[&hyperx::FLIGHT_Q], "HyperX Cloud Flight (HP): battery voltage (21 FF 05)"),
    SetEntry { devices: Products::of(0x03F0, &[0x0A93, 0x0A8E]).page(0xFF00).usage(0x0001), kind: F, bytes: &[&hyperx::ST_CONNECTION, &hyperx::ST_BATTERY], why: "HyperX Cloud Stinger Core: connection, battery (HyperBatteryMonitor)" },
    SetEntry { devices: Products::of(0x0951, &[0x170B, 0x1713, 0x173F]).page(0xFF00).usage(0x0001), kind: F, bytes: &[&hyperx::ST_CONNECTION, &hyperx::ST_BATTERY], why: "HyperX Cloud Stinger Core / Core Wireless: connection, battery" },
    set("hs-jbl", F, &[&jbl::Q], "JBL HIDV3: get device info, feature 000D (battery)"),
    set("hs-poly", O, &[&plantronics::GET], "Poly BT600: GET group 0A item 1A (battery)"),
    set("hs-moondrop", O, &[&moondrop::Q_BATTERY, &moondrop::Q_LINK], "MOONDROP GM01 Pro: READ 27 (battery), 31 (link)"),
    set("hs-mchose", O, &[&mchose::Q], "MCHOSE V9 Pro 2: read battery (0B)"),
    set("hs-alienware", O, &[&alienware::Q], "Alienware AW920H: RF battery status (C0 0A)"),
    set("hs-fractal", O, &[&fractal::Q_DONGLE, &fractal::Q_HEADSET], "Fractal Scape: GET_DEVICE_STATE (21) to the dongle and the headset"),
    set("hs-rog", O, &[&rog::Q_BATTERY, &rog::Q_CHARGING], "ROG Pelta / Delta II: battery (12 07), charging (12 08)"),
    set("hs-rog-cetra", O, &[&rog::Q_CETRA], "ROG Cetra Open Wireless: battery (12 12)"),
    set("hs-darkrim", O, &[&darkrim::GET_BATTERY], "DARKRIM SHADOW: GET 0010, battery TLV (docs/darkrim.md)"),
    set("hs-akg", O, &[&audeze::Q], "Airoha RACE: get battery (0CD6)"),
    set("hs-endorfy", O, &[&audeze::Q], "Airoha RACE: get battery (0CD6)"),
    set("hs-vgn", O, &[&vgn::READ_BATTERY], "VGN V HUB «ZHOU»: read battery (65 01)"),
    set("ot-maono", O, &[&maono::Q], "MAONO PD200W: GET register 0042 (battery)"),
];

pub static TEMPLATES: &[Template] = &[
    Template { devices: Products::driver("hs-razer-hs"), kind: O, pattern: &RZ_HS, why: "BlackShark V2 HyperSpeed: GET 21 / 2A, sequence 60–7F, its XOR", check: Some(razer::hs_check) },
    Template { devices: Products::driver("hs-razer-v3x"), kind: F, pattern: &RZ_V3X, why: "BlackShark V3 X: class 07 GET 80 / 84, transaction id, its XOR", check: Some(razer::v3x_check) },
    Template { devices: Products::driver("hs-sony"), kind: O, pattern: &SONY, why: "INZONE: GET battery info (04 01), transaction id 0002–00FF, its sum", check: Some(sony::command_check) },
    Template { devices: JABRA_DONGLES, kind: O, pattern: &JABRA_BATTERY, why: "Jabra GNP: battery (12 02) to the dongle's headset (04), any sequence", check: None },
    Template { devices: JABRA_DONGLES, kind: O, pattern: &JABRA_NAME, why: "Jabra GNP: name (02 00) of the dongle's headset (04), any sequence", check: None },
    Template { devices: JABRA_CABLE, kind: O, pattern: &JABRA_BATTERY_08, why: "Jabra GNP: battery (12 02) of a headset on its cable (08), any sequence", check: None },
    Template { devices: JABRA_CABLE, kind: O, pattern: &JABRA_NAME_08, why: "Jabra GNP: name (02 00) of a headset on its cable (08), any sequence", check: None },
    Template { devices: Products::driver("hs-corsair-bragi"), kind: O, pattern: &[B::Is(0x02), B::In(0x08, 0x0B), B::Is(0x02), BRAGI_PROPS], why: "Bragi GET (numbered)", check: None },
    Template { devices: Products::driver("hs-corsair-bragi"), kind: O, pattern: &[B::Is(0x00), B::Is(0x02), B::In(0x08, 0x0B), B::Is(0x02), BRAGI_PROPS], why: "Bragi GET (report id 0)", check: None },
    Template { devices: Products::driver("hs-corsair-bragi"), kind: O, pattern: &[B::Is(0x00), B::In(0x08, 0x0B), B::Is(0x02), BRAGI_PROPS], why: "Bragi GET (plain framing)", check: None },
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mice::{all_models, driver, Role, Way};

    #[test]
    fn every_entry_is_for_a_piece_six_reader_that_sends() {
        for e in SETS.iter().map(|e| e.devices).chain(TEMPLATES.iter().map(|t| t.devices)) {
            match e.driver {
                Some(d) => {
                    assert_eq!(driver(d).map(|x| x.way), Some(Way::Query), "{}", d);
                    assert!(all_models().any(|m| m.driver == d && m.role == Role::Main));
                }
                None => {
                    for &pid in e.pids {
                        let m = all_models().find(|m| m.vid == e.vid && m.pid == pid).unwrap_or_else(|| panic!("{:04X}:{:04X}", e.vid, pid));
                        assert!(m.driver.starts_with("hs-") && m.driver().way == Way::Query, "{}", m.name);
                    }
                }
            }
        }
        for e in SETS {
            assert!(!e.bytes.is_empty() && e.bytes.iter().all(|b| !b.is_empty() && b.len() <= 64), "{}", e.why);
        }
    }
}
