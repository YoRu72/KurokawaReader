// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Glorious, Hitscan and G-Wolves wireless mice on the «83» protocol
// (proto.rs), and WLMouse YING's 8K receiver.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/glorious.cpp (GWolvesModelName, GWolvesIsCable, GloriousName, GloriousCable, HitscanName, kVendors,
// PollGlorious) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its references: ikajdan/glorious-indicator, louis4craft/glorious-ctl, Hitscan's configurator,
// G-Wolves' own model list (mouse.xyz, Config/env-models.json), WLMouse's (gm.wlmouse.gg).
// Changed here: the products by id — the original asked every product of 258A (Sinowealth's vendor id, shared by many
// brands: Redragon keyboards among them), 3770 and 33E4 with a 65-byte feature report; those its tables do not name are
// not asked (Hitscan's receivers: their ids are not in the sources). A cable is charging (as the original), its
// receiver's mouse one card with it by the pair rule.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn p83(driver: &'static str, vid: u16, pid: u16, name: &'static str, via: Via) -> Model {
    Model::new(driver, vid, pid, name, Kind::Mouse, via).feature(Len::Eq(65))
}

pub static MODELS: &[Model] = &[
    p83("mk-p83", 0x258A, 0x2022, "Glorious Model O Wireless", Via::Receiver).pair("gl:o"),
    p83("mk-p83", 0x258A, 0x2011, "Glorious Model O Wireless", Via::Cable).pair("gl:o"),
    p83("mk-p83", 0x258A, 0x2023, "Glorious Model D Wireless", Via::Receiver).pair("gl:d"),
    p83("mk-p83", 0x258A, 0x2012, "Glorious Model D Wireless", Via::Cable).pair("gl:d"),
    p83("mk-p83", 0x258A, 0x2024, "Glorious Model O- Wireless", Via::Receiver).pair("gl:o-"),
    p83("mk-p83", 0x258A, 0x2013, "Glorious Model O- Wireless", Via::Cable).pair("gl:o-"),
    p83("mk-p83", 0x258A, 0x2025, "Glorious Model D- Wireless", Via::Receiver).pair("gl:d-"),
    p83("mk-p83", 0x258A, 0x2014, "Glorious Model D- Wireless", Via::Cable).pair("gl:d-"),
    p83("mk-p83", 0x258A, 0x2033, "Glorious Model O 2 Wireless", Via::Receiver),
    p83("mk-p83", 0x258A, 0x2034, "Glorious Model D 2 PRO", Via::Receiver),
    p83("mk-p83", 0x258A, 0x2036, "Glorious Model D 2 PRO", Via::Receiver),
    p83("mk-p83", 0x258A, 0x201A, "Glorious Model D 2 PRO", Via::Cable),
    p83("mk-hitscan", 0x3770, 0x0136, "Hitscan Hyperlight X", Via::Cable),
    p83("mk-hitscan", 0x3770, 0x0194, "Hitscan Hyperlight N", Via::Cable),
    // (WLMouse YING's 8K receiver: its battery collection only — the 1K dongle is shared with other models.)
    p83("mk-wlmouse", 0x36A7, 0xA874, "WLMouse YING", Via::Receiver).page(0xFFFF).usage(0x0000),
];

/// G-Wolves' product ids (their own list; 3854 is a dongle many models share).
pub const GWOLVES_PIDS: [u16; 59] = [0x3808, 0x3817, 0x6808, 0x6817, 0x5608, 0x5617, 0x5618, 0x5619, 0x3608, 0x3617, 0x3619, 0x3908, 0x3917, 0x7904, 0x7913, 0x3708, 0x3717, 0x5308, 0x5317, 0x7704, 0x7713, 0x3508, 0x3517, 0x7908, 0x7917, 0x5808, 0x5817, 0x2708, 0x2717, 0x2719, 0x5408, 0x5417, 0x5418, 0x5419, 0x5708, 0x5717, 0x5908, 0x5917, 0x7204, 0x7203, 0x7708, 0x7717, 0x5804, 0x5803, 0x5404, 0x5403, 0x5704, 0x5703, 0x5904, 0x5903, 0x4718, 0x4719, 0x4219, 0x5219, 0x3519, 0x2619, 0x1619, 0x2119, 0x3854];

pub static GWOLVES: [Model; 59] = [
    p83("mk-gwolves", 0x33E4, 0x3808, "G-Wolves HTM Plus", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x3817, "G-Wolves HTM Plus", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x6808, "G-Wolves HSK Pro 2.0", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x6817, "G-Wolves HSK Pro 2.0", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x5608, "G-Wolves HTXU", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x5617, "G-Wolves HTXU", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x5618, "G-Wolves HTXU", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x5619, "G-Wolves HTXU", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x3608, "G-Wolves Fenrir Pro", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x3617, "G-Wolves Fenrir Pro", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x3619, "G-Wolves Fenrir Pro", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x3908, "G-Wolves VUK", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x3917, "G-Wolves VUK", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x7904, "G-Wolves HT-S2", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x7913, "G-Wolves HT-S2", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x3708, "G-Wolves Fenrir Max", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x3717, "G-Wolves Fenrir Max", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x5308, "G-Wolves HTS Ultra", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x5317, "G-Wolves HTS Ultra", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x7704, "G-Wolves HTR", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x7713, "G-Wolves HTR", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x3508, "G-Wolves Fenrir", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x3517, "G-Wolves Fenrir", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x7908, "G-Wolves HT-S2 Pro", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x7917, "G-Wolves HT-S2 Pro", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x5808, "G-Wolves HSK Pro", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x5817, "G-Wolves HSK Pro", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x2708, "G-Wolves HTX Mini", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x2717, "G-Wolves HTX Mini", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x2719, "G-Wolves HTX Mini", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x5408, "G-Wolves HTS Plus", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x5417, "G-Wolves HTS Plus", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x5418, "G-Wolves HTS Plus", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x5419, "G-Wolves HTS Plus", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x5708, "G-Wolves HTX", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x5717, "G-Wolves HTX", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x5908, "G-Wolves HSK Plus", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x5917, "G-Wolves HSK Plus", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x7204, "G-Wolves HSK Lite", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x7203, "G-Wolves HSK Lite", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x7708, "G-Wolves HTR Pro", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x7717, "G-Wolves HTR Pro", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x5804, "G-Wolves HSK Pro ACE", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x5803, "G-Wolves HSK Pro ACE", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x5404, "G-Wolves HTS Plus ACE", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x5403, "G-Wolves HTS Plus ACE", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x5704, "G-Wolves HTX ACE", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x5703, "G-Wolves HTX ACE", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x5904, "G-Wolves HSK Plus ACE", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x5903, "G-Wolves HSK Plus ACE", Via::Receiver),
    p83("mk-gwolves", 0x33E4, 0x4718, "G-Wolves Lycan", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x4719, "G-Wolves Lycan", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x4219, "G-Wolves WARG", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x5219, "G-Wolves HTS Plus Pro", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x3519, "G-Wolves Fenrir Asym", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x2619, "G-Wolves HTX Mini Asym", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x1619, "G-Wolves Fenrir Max Asym", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x2119, "G-Wolves VUK Mini", Via::Cable),
    p83("mk-gwolves", 0x33E4, 0x3854, "G-Wolves wireless mouse", Via::Receiver),
];

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn tables() {
        assert_eq!(GWOLVES.len(), GWOLVES_PIDS.len());
        for (m, p) in GWOLVES.iter().zip(GWOLVES_PIDS) {
            assert_eq!(m.pid, p);
        }
        // (A Sinowealth product the tables do not name: not this reader's.)
        assert!(find(&HidIdent { vid: 0x258A, pid: 0x0049, usage_page: 0xFF00, usage: 1, interface: 1 }, 0, 0, 65).is_none());
        let m = model("mk-p83", 0x2022);
        assert_eq!(find(&ident(m), 0, 0, 65), Some(m));
        assert!(find(&ident(m), 0, 0, 64).is_none(), "another report length: another collection");
    }
}
