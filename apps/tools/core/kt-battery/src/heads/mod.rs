// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): headsets' own readers, and the rest (piece 6).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/razer_headset.cpp, steelseries.cpp (Arctis), steelseries_elite.cpp, corsair.cpp (Void, Bragi headsets),
// logitech.cpp (G headsets), astro.cpp, audeze.cpp, hyperx.cpp, sony_inzone.cpp, jabra.cpp, jbl.cpp, plantronics.cpp,
// maono.cpp, moondrop.cpp, mchose_headset.cpp, alienware.cpp, fractal.cpp, rog.cpp (Pelta, Delta II) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later. One file per family; the
// tables, the request rules and the platform are mice/mod.rs's (the families are mice::Family, in the page's lists
// «Headsets and earbuds» and «Other»). AirPods, Galaxy Buds and Phone Link are not HID: airpods.rs, galaxybuds.rs,
// phonelink.rs.
// Changed here, as in piece 5 (PLAN-battery §9): matched by vendor AND product (and the collection where the family has
// one); every byte sent is one heads/allowed.rs lists for that product (exact, or a template whose variable bytes — a
// sequence or transaction id — are bounded, with its checksum checked); only status reads: what the original sent
// that switches a mode (Razer's «remote mode», the G435 dongle's REMOTE_SET_MODE and OTA session, Poly's attach and
// HELLO, BlackShark V3's handshake) is not sent; levels as the device gives them; malformed replies are no reading;
// no value kept in a global — a headset whose link drops when asked often is asked at most every Model::gap seconds,
// the last reading shown meanwhile with its own time. Every request-sending family is off until the user turns it on
// («ported, untested»); the JBL Quantum 350, which only has its feature reports read, is on by default.
// Copyright (C) 2026 Kurokawa contributors. Std only.
pub mod allowed;

pub mod airoha;
pub mod alienware;
pub mod astro;
pub mod audeze;
pub mod corsair;
pub mod darkrim;
pub mod fractal;
pub mod hyperx;
pub mod jabra;
pub mod jbl;
pub mod logitech;
pub mod maono;
pub mod mchose;
pub mod moondrop;
pub mod plantronics;
pub mod razer;
pub mod rog;
pub mod sony;
pub mod steelseries;
pub mod vgn;

use crate::mice::{Answer, Chans, Model};
use crate::sched::Outcome;
use std::time::Instant;

/// The headsets' and the rest's tables (mice::all_models chains them after the mice' and keyboards').
pub static TABLES: &[&[Model]] = &[
    razer::MODELS,
    steelseries::MODELS,
    &corsair::VOID_FFC5,
    &corsair::VOID_FF00,
    &corsair::BRAGI_64,
    &corsair::BRAGI_65,
    &logitech::SHORT,
    &logitech::LONG,
    &logitech::FF43,
    astro::MODELS,
    &astro::G4_32,
    &astro::G4_31,
    &astro::G4_00,
    &astro::G3_32,
    &astro::G3_31,
    &astro::G3_00,
    &astro::A20_32,
    &astro::A20_31,
    &astro::A20_00,
    audeze::MODELS,
    hyperx::MODELS,
    sony::MODELS,
    &jabra::MODELS,
    &jabra::CABLE,
    jbl::MODELS,
    plantronics::MODELS,
    maono::MODELS,
    moondrop::MODELS,
    mchose::MODELS,
    alienware::MODELS,
    fractal::MODELS,
    rog::MODELS,
    darkrim::MODELS,
    airoha::MODELS,
    vgn::MODELS,
];

/// What a product string says before anything is asked: an Audeze dongle naming itself «… Dongle» has no headset linked
/// (and keeps an old value) — «no device linked», nothing sent. None: ask.
pub fn product_says(m: &Model, product: &str, now: u64) -> Option<Outcome> {
    if m.driver == "hs-audeze" && m.via == crate::mice::Via::Receiver && product.trim_end().to_ascii_lowercase().ends_with("dongle") {
        return Some(crate::mice::unlinked(now));
    }
    None
}

/// Reads one unit of a piece-6 reader (mice::read sends hs-* and ot-* here once the family's switch allows it).
pub fn read(ch: &mut Chans, m: &Model, slot: Option<u8>, deadline: Instant, now: u64) -> Answer {
    match m.driver {
        "hs-razer-hs" | "hs-razer-v2pro" | "hs-razer-v3x" | "hs-razer-v3" => razer::read(ch, m, deadline, now).into(),
        "hs-steelseries" | "hs-ss-elite" => steelseries::read(ch, m, deadline, now).into(),
        "hs-corsair-void" => corsair::read_void(ch, deadline, now).into(),
        "hs-corsair-bragi" => crate::mice::corsair::read_bragi(ch, m, slot, deadline, now),
        "hs-logitech" => crate::mice::logitech::read(ch, m, slot, deadline, now),
        "hs-astro-x" | "hs-astro" => astro::read(ch, m, deadline, now).into(),
        "hs-audeze" => audeze::read(ch, m, deadline, now).into(),
        "hs-hyperx" => hyperx::read(ch, m, deadline, now).into(),
        "hs-sony" => sony::read(ch, m, deadline, now).into(),
        "hs-jabra" => jabra::read(ch, m, deadline, now),
        "hs-jbl" | "hs-jbl-350" => jbl::read(ch, m, deadline, now).into(),
        "hs-poly" => plantronics::read(ch, deadline, now).into(),
        "ot-maono" => maono::read(ch, deadline, now).into(),
        "hs-moondrop" => moondrop::read(ch, deadline, now).into(),
        "hs-mchose" => mchose::read(ch, deadline, now).into(),
        "hs-alienware" => alienware::read(ch, deadline, now).into(),
        "hs-fractal" => fractal::read(ch, m, deadline, now).into(),
        "hs-rog" => rog::read(ch, deadline, now).into(),
        "hs-rog-cetra" => rog::read_cetra(ch, deadline, now).into(),
        "hs-darkrim" => darkrim::read(ch, deadline, now).into(),
        "hs-akg" | "hs-endorfy" => airoha::read(ch, m, deadline, now).into(),
        "hs-vgn" => vgn::read(ch, deadline, now).into(),
        _ => Outcome::Failed.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::allow::{may_write, permit, HidIdent, ReportKind};
    use crate::mice::testkit::*;
    use crate::mice::{all_models, driver, Group, Role, Way};
    use crate::model::{Charging, Note, Reading};

    #[test]
    fn every_headset_model_is_a_listed_product_of_a_piece_six_reader() {
        let mut n = 0;
        for t in TABLES {
            for m in t.iter() {
                n += 1;
                let d = driver(m.driver).unwrap_or_else(|| panic!("{}: {}", m.name, m.driver));
                assert_ne!(d.family.group(), Group::Mice, "{}", m.name);
                assert!(m.vid != 0 && m.pid != 0, "{}: never a vendor alone", m.name);
                if d.way == Way::Query && m.role == Role::Main {
                    assert!(may_write(&ident(m)), "{} {:04X}:{:04X}: sends, so allowed.rs names it", m.name, m.vid, m.pid);
                }
                if d.way == Way::Passive {
                    assert!(!may_write(&ident(m)), "{}: reads only", m.name);
                }
            }
        }
        assert!(n > 150);
        // (Another product of a listed vendor, or the right product on another page, matches nothing here.)
        for (vid, pid, page) in [(0x1532u16, 0x0550u16, 0xFF00u16), (0x1532, 0x0555, 0xFF00), (0x046D, 0x0ADF, 0xFF00), (0x1038, 0x1234, 0xFFC0), (0x054C, 0x0FA9, 0xFF04), (0x0B0E, 0x2E52, 0xFF00), (0x373B, 0x11CB, 0xFF00)] {
            let id = HidIdent { vid, pid, usage_page: page, usage: 1, interface: 3 };
            assert!(crate::mice::find(&id, 64, 64, 64).is_none(), "{:04X}:{:04X}", vid, pid);
            assert!(!may_write(&id));
        }
    }

    #[test]
    fn the_allow_table_rejects_anything_else() {
        // (For every request collection: the bytes of another family, one byte changed past a template's bounds, the
        //  right bytes as the other report kind — refused.)
        for m in all_models().filter(|m| m.driver.starts_with("hs-") || m.driver.starts_with("ot-")).filter(|m| m.role == Role::Main) {
            let id = ident(m);
            for (bytes, kind) in [(&[0xF7u8][..], ReportKind::Output), (&[0x00, 0x03, 0x00][..], ReportKind::Output), (&crate::mice::steelseries::AEROX_RX[..], ReportKind::Output), (&[0x10, 0xFF, 0x83, 0xB5, 0, 0, 0][..], ReportKind::Output)] {
                assert!(permit(&id, kind, bytes).is_none(), "{}: {:02X?}", m.name, bytes);
            }
        }
        let ss = model("hs-steelseries", 0x12B3);
        assert!(permit(&ident(ss), ReportKind::Output, &steelseries::Q_A1).is_some());
        assert!(permit(&ident(ss), ReportKind::Feature, &steelseries::Q_A1).is_none());
        assert!(permit(&ident(ss), ReportKind::Output, &steelseries::Q_NOVA).is_none(), "another model's request");
        let hx = model("hs-hyperx", 0x0C9D);
        assert!(permit(&ident(hx), ReportKind::Output, &hyperx::C3_BATTERY).is_some());
        assert!(permit(&ident(hx), ReportKind::Output, &[0x66, 0x83]).is_none());
        let jb = model("hs-jabra", 0x2E51);
        assert!(permit(&ident(jb), ReportKind::Output, &jabra::query(0x33, 0x12, 0x02)).is_some());
        assert!(permit(&ident(jb), ReportKind::Output, &jabra::query(0x33, 0x12, 0x03)).is_none(), "another op");
        assert!(permit(&ident(jb), ReportKind::Output, &jabra::query(0x33, 0x13, 0x02)).is_none(), "another class");
    }

    #[test]
    fn a_switched_off_family_touches_nothing() {
        for m in TABLES.iter().flat_map(|t| t.iter()) {
            let mut f = fake(m);
            f.stream.push_back(vec![0; 64]);
            f.features.insert(0xFF, vec![0xFF; 64]);
            f.inputs.insert(0x07, vec![0x07; 62]);
            let a = crate::mice::read(&mut Chans::one(&mut f), m, None, false, soon(), 9);
            assert_eq!(a.out, Outcome::Read(Reading::unknown(Note::QueryOff, Charging::Unknown, 9)), "{}", m.name);
            assert!(f.sent.is_empty() && f.reads == 0 && f.flushes == 0, "{}", m.name);
        }
    }

    #[test]
    fn a_dongle_alone_is_told_by_its_name() {
        let d = model("hs-audeze", 0x4B19);
        assert_eq!(product_says(d, "Audeze Maxwell Dongle ", 5), Some(crate::mice::unlinked(5)));
        assert_eq!(product_says(d, "Audeze Maxwell", 5), None);
        assert_eq!(product_says(model("hs-audeze", 0x4B1A), "Something Dongle", 5), None, "the cable is the headset");
    }
}
