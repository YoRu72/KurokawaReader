// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the mice' and keyboards' requests, as allow.rs takes them (piece 5).
// Each entry: the reader's request collections (allow::Products::driver — exactly the table rows of that reader that
// its requests go to, each listed by vendor and product; or a list of product ids), the report kind, and every byte
// of every request, in full. Templates (Corsair's Bragi, Delux M800) bound each variable byte to listed values or a
// small closed range. Logitech's HID++ is not here: allow::permit_hidpp checks it, against the device's own answers.
// Every request here only asks — battery, charging, link state, device information or the paired device's id; the
// requests that set or wake anything are not in this file at all (mice/*.rs's headers say which, and why).
// Derived from Wireless Device Battery Monitor (GPL-3.0-or-later; NOTICE.md). Copyright (C) 2026 Kurokawa contributors.
use super::*;
use crate::allow::{Products, SetEntry, Template, B};

const F: ReportKind = ReportKind::Feature;
const O: ReportKind = ReportKind::Output;

const fn set(driver: &'static str, kind: ReportKind, bytes: &'static [&'static [u8]], why: &'static str) -> SetEntry {
    SetEntry { devices: Products::driver(driver), kind, bytes, why }
}

const FM_04: [[u8; 4]; 4] = [finalmouse::get(0x04, finalmouse::SOC), finalmouse::get(0x04, finalmouse::VOLTAGE), finalmouse::get(0x04, finalmouse::CHARGING), finalmouse::get(0x04, finalmouse::LINK)];
const FM_01: [[u8; 4]; 4] = [finalmouse::get(0x01, finalmouse::SOC), finalmouse::get(0x01, finalmouse::VOLTAGE), finalmouse::get(0x01, finalmouse::CHARGING), finalmouse::get(0x01, finalmouse::LINK)];

pub static SETS: &[SetEntry] = &[
    set(
        "mk-razer",
        F,
        &[&razer::F_1F_80, &razer::F_1F_84, &razer::F_3F_80, &razer::F_3F_84, &razer::F_FF_80, &razer::F_FF_84, &razer::F_08_80, &razer::F_08_84, &razer::F_9F_80, &razer::F_9F_84],
        "OpenRazer class 07: get battery level (80), get charging status (84), with its transaction ids",
    ),
    set("mk-steelseries", O, &[&steelseries::AEROX_CABLE, &steelseries::AEROX_RX, &steelseries::RIVAL], "rivalcfg: the battery reads (92 / D2, AA 01)"),
    set("mk-corsair-compx", O, &[&proto::COMPX_LINK, &proto::COMPX_BATTERY], "Compx 17: online (03), battery (04)"),
    set("mk-kysona", O, &[&proto::COMPX_LINK, &proto::COMPX_BATTERY], "Compx 17: online (03), battery (04)"),
    set("mk-gwolves-k", O, &[&proto::COMPX_LINK, &proto::COMPX_BATTERY], "Compx 17: online (03), battery (04)"),
    set("mk-redragon-k", O, &[&proto::COMPX_LINK, &proto::COMPX_BATTERY], "Compx 17: online (03), battery (04)"),
    set("mk-atk-k", O, &[&proto::COMPX_LINK, &proto::COMPX_BATTERY], "Compx 17: online (03), battery (04)"),
    set("mk-hitscan-k", O, &[&proto::COMPX_LINK, &proto::COMPX_BATTERY], "Compx 17: online (03), battery (04)"),
    set("mk-pulsar-k", O, &[&proto::COMPX_LINK, &proto::COMPX_BATTERY], "Compx 17: online (03), battery (04)"),
    set("mk-p83", F, &[&proto::P83], "the «83» status read"),
    set("mk-hitscan", F, &[&proto::P83], "the «83» status read"),
    set("mk-gwolves", F, &[&proto::P83], "the «83» status read"),
    set("mk-wlmouse", F, &[&proto::P83], "the «83» status read"),
    set("mk-lamzu", F, &[&proto::P83], "the «83» status read"),
    set("mk-arbiter", F, &[&proto::P83], "the «83» status read"),
    set("mk-pulsar", F, &[&pulsar::REQUEST], "Pulsar's battery read"),
    SetEntry { devices: Products::of(0x361D, &[0x0100]), kind: O, bytes: &[&FM_04[0], &FM_04[1], &FM_04[2], &FM_04[3]], why: "Finalmouse get: state of charge, voltage, charging, link" },
    SetEntry { devices: Products::of(0x361D, &[0x0300, 0x0301]), kind: O, bytes: &[&FM_01[0], &FM_01[1], &FM_01[2], &FM_01[3]], why: "Finalmouse get: state of charge, voltage, charging, link" },
    set("mk-endgame-4k", F, &[&endgame::BATTERY, &endgame::INFO], "Endgame Gear 4K: battery (B4), device info (0E)"),
    set("mk-endgame-we", F, &[&proto::COMPX_BATTERY, &proto::COMPX_LINK], "Compx 17 as a feature report: battery, online"),
    set("mk-dareu", F, &[&proto::COMPX_BATTERY], "Compx 17 as a feature report: battery"),
    set("mk-areson", F, &[&proto::COMPX_BATTERY], "Compx 17 as a feature report: battery"),
    set("mk-fantech", F, &[&proto::COMPX_BATTERY], "Compx 17 as a feature report: battery"),
    set("mk-vaxee", F, &[&vaxee::BATTERY, &vaxee::CHARGING], "VAXEE: battery (0B), charging (10)"),
    set("mk-zowie-cw", O, &[&zowie::CW], "ZOWIE EC-CW: status (A5 03)"),
    set("mk-zowie-dw", O, &[&zowie::DW], "ZOWIE DW / U2: battery (B4 15)"),
    set("mk-ninjutso-sora", F, &[&ninjutso::SORA], "Sora V2: read state (15)"),
    set("mk-sprime", F, &[&ninjutso::SORA], "Sprime PM1: read state (15)"),
    set("mk-ninjutso-ten", F, &[&ninjutso::TEN_ONLINE, &ninjutso::TEN_PERCENT, &ninjutso::TEN_CHARGING], "Ninjutso Ten: online, percent, charging"),
    set("mk-darmoshark", F, &[&darmoshark::BOND, &darmoshark::IDENTIFY], "Darmoshark: bond state (03), identify (06)"),
    set("mk-atk-nk", O, &[&atk::NK_LEVEL, &atk::NK_CHARGING], "ATK: battery level (07), charging (0F)"),
    set("mk-atk-kb", O, &[&atk::KB], "ATK keyboards: status (1A)"),
    set("mk-keychron", O, &[&keychron::Q01, &keychron::Q41, &keychron::Q40, &keychron::NAPE_SLOTS, &keychron::NAPE_BATTERY], "Keychron: device info, battery, receiver slots"),
    set("mk-keychron", F, &[&keychron::LEGACY], "Keychron (older receivers): status (51 06)"),
    set("mk-rk", O, &[&royal_kludge::BATTERY], "Royal Kludge: battery"),
    set("mk-sonix", O, &[&sonix::REQUEST], "SONiX: battery"),
    set("mk-semico", O, &[&semico::STATUS], "Semico: status (0E)"),
    set("mk-aula-by", O, &[&aula::BY_0, &aula::BY_1], "AULA BY receivers: battery (4A)"),
    set("mk-mchose", O, &[&mchose::G3, &mchose::MODERN], "MCHOSE: G3 V2 battery (30), device info (09)"),
    set("mk-mchose", F, &[&mchose::INVERTED], "MCHOSE: status (06, inverted)"),
    set("mk-cherry", O, &[&cherry::QUERY], "CHERRY: status (1A)"),
    set("mk-coolermaster", O, &[&coolermaster::STATUS], "Cooler Master: status (81)"),
    set("mk-machenike", F, &[&machenike::STATUS], "Machenike: status (51 06)"),
    set("mk-msi", O, &[&msi::STATUS], "MSI: status (0F 20)"),
    set("mk-rog", O, &[&rog::KB, &rog::MOUSE], "ROG: battery (12 01 keyboard, 12 07 mouse)"),
    set("mk-nzxt", O, &[&nzxt::TELEMETRY], "NZXT: telemetry (4E 02)"),
    set("mk-niceboy", O, &[&niceboy::BATTERY], "Niceboy: battery (24 FA 48)"),
    set("mk-motospeed", O, &[&misc::MOTOSPEED], "Motospeed X6: battery (B5 06)"),
    set("mk-ajazz", O, &[&misc::AJ139_A, &misc::AJ139_B], "AJAZZ AJ139 V2: battery (55 30), both checksums"),
    set("mk-incott", F, &[&misc::INCOTT_INFO, &misc::INCOTT_STATUS], "PixArt: device info (8F), status (89)"),
];

pub static TEMPLATES: &[Template] = &[
    // (Corsair Bragi GET: [02 | 00 02 | 00][target 08–0B][02 GET][property 0F battery, 10 charge state, 12 product id].)
    Template { devices: Products::driver("mk-corsair-bragi"), kind: O, pattern: &[B::Is(0x02), B::In(0x08, 0x0B), B::Is(0x02), B::OneOf(&corsair::PROPS)], why: "Bragi GET (numbered)" },
    Template { devices: Products::driver("mk-corsair-bragi"), kind: O, pattern: &[B::Is(0x00), B::Is(0x02), B::In(0x08, 0x0B), B::Is(0x02), B::OneOf(&corsair::PROPS)], why: "Bragi GET (report id 0)" },
    Template { devices: Products::driver("mk-corsair-bragi"), kind: O, pattern: &[B::Is(0x00), B::In(0x08, 0x0B), B::Is(0x02), B::OneOf(&corsair::PROPS)], why: "Bragi GET (plain framing)" },
    // (Delux M800 Pro status query: [0C][01][20][00][sequence 01–7F][00 × 28].)
    Template { devices: Products::driver("mk-delux"), kind: F, pattern: &misc::DELUX_PATTERN, why: "Delux M800 status query, its sequence number" },
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::allow::{permit, HidIdent};

    fn id(vid: u16, pid: u16, page: u16, usage: u16, iface: i32) -> HidIdent {
        HidIdent { vid, pid, usage_page: page, usage, interface: iface }
    }

    #[test]
    fn every_set_names_a_reader_that_sends() {
        for e in SETS.iter().map(|e| e.devices).chain(TEMPLATES.iter().map(|t| t.devices)) {
            if let Some(d) = e.driver {
                let dr = driver(d).unwrap_or_else(|| panic!("allow entry for unknown reader {}", d));
                assert_eq!(dr.way, Way::Query, "{}", d);
                assert!(all_models().any(|m| m.driver == d && m.role == Role::Main), "{} has request collections", d);
            } else {
                assert!(e.vid != 0 && !e.pids.is_empty(), "never a vendor alone");
            }
        }
        for e in SETS {
            assert!(!e.bytes.is_empty() && e.bytes.iter().all(|b| !b.is_empty()), "{}", e.why);
        }
    }

    #[test]
    fn exact_entries_take_only_their_bytes() {
        let rz = id(0x1532, 0x00B6, 0xFF00, 2, 0);
        assert!(permit(&rz, F, &razer::F_1F_80).is_some());
        let mut off = razer::F_1F_80;
        off[8] = 0x82; // (class 07 id 82: not a get it sends)
        assert!(permit(&rz, F, &off).is_none());
        assert!(permit(&rz, O, &razer::F_1F_80).is_none(), "the right bytes as another kind");
        assert!(permit(&rz, F, &razer::F_1F_80[..90]).is_none(), "one byte short");
        assert!(permit(&id(0x1532, 0x0001, 0xFF00, 2, 0), F, &razer::F_1F_80).is_none(), "another product of the vendor");
        // (A request of one reader to another reader's device.)
        let ss = id(0x1038, 0x1838, 0xFF00, 1, 3);
        assert!(permit(&ss, O, &steelseries::AEROX_RX).is_some());
        assert!(permit(&ss, O, &cherry::QUERY).is_none());
        assert!(permit(&id(0x1038, 0x1838, 0xFF00, 1, 2), O, &steelseries::AEROX_RX).is_none(), "another interface");
        // (Finalmouse: each receiver its own report id.)
        assert!(permit(&id(0x361D, 0x0100, 0xFF00, 1, -1), O, &FM_04[0]).is_some());
        assert!(permit(&id(0x361D, 0x0100, 0xFF00, 1, -1), O, &FM_01[0]).is_none());
        assert!(permit(&id(0x361D, 0x0300, 0xFF00, 1, -1), O, &FM_01[3]).is_some());
    }

    #[test]
    fn templates_reject_every_other_byte() {
        let cb = all_models().find(|m| m.driver == "mk-corsair-bragi" && m.role == Role::Main).unwrap();
        let cid = super::testkit::ident(cb);
        for t in 0x08..=0x0B {
            for &p in &corsair::PROPS {
                assert!(permit(&cid, O, &[0x02, t, 0x02, p]).is_some());
                assert!(permit(&cid, O, &[0x00, 0x02, t, 0x02, p]).is_some());
                assert!(permit(&cid, O, &[0x00, t, 0x02, p]).is_some());
            }
        }
        // (Every other value of each byte, one at a time, is refused; so are SET (01) and other lengths.)
        let good = [0x02u8, 0x09, 0x02, 0x0F];
        for i in 0..good.len() {
            for v in 0..=255u8 {
                let mut b = good;
                b[i] = v;
                let ok = match i {
                    0 => v == 0x02 || v == 0x00,
                    1 => (0x08..=0x0B).contains(&v),
                    2 => v == 0x02,
                    _ => corsair::PROPS.contains(&v),
                };
                assert_eq!(permit(&cid, O, &b).is_some(), ok, "byte {} = {:02X}", i, v);
            }
        }
        assert!(permit(&cid, O, &[0x02, 0x09, 0x01, 0x0F]).is_none(), "SET");
        assert!(permit(&cid, O, &[0x02, 0x09, 0x02, 0x0F, 0x00]).is_none(), "longer");
        assert!(permit(&cid, F, &good).is_none(), "as a feature report");
        assert!(permit(&id(0x1B1C, 0x0A3E, 0xFF42, 1, -1), O, &good).is_none(), "a headset's id");
        // (Delux: the sequence byte 01–7F only; every other byte fixed.)
        let dm = all_models().find(|m| m.driver == "mk-delux" && m.role == Role::Main).unwrap();
        let did = super::testkit::ident(dm);
        let q = misc::delux_query(5);
        assert!(permit(&did, F, &q).is_some());
        for i in 0..q.len() {
            for v in [0x00u8, 0x01, 0x21, 0x80, 0xFF] {
                let mut b = q;
                b[i] = v;
                let ok = if i == 4 { (0x01..=0x7F).contains(&v) } else { b == q };
                assert_eq!(permit(&did, F, &b).is_some(), ok, "delux byte {} = {:02X}", i, v);
            }
        }
        assert!(permit(&did, F, &q[..32]).is_none());
    }
}
