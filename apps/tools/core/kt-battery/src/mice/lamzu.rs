// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): LAMZU (373E, 37B0) and Arbiter Studio (373E) mice on the «83»
// protocol (proto.rs).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/lamzu.cpp (ModelName, IsCable, PollLamzu) and arbiter.cpp (kModels, Decode, PollArbiter) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later. Their references:
// LAMZU's Aurora web driver (lamzu.net, Config/env-models.json), Arbiter Web HUB (webapp.arbiterstudio.com).
// Changed here: the products by id (the original asked every 373E / 37B0 product with a 65-byte feature report);
// percent 0 from a receiver is «not linked»; an Akitsu on its cable with its 8K receiver also plugged in: one card by
// the pair rule (the original: the cable claimed the receiver).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn p83(driver: &'static str, vid: u16, pid: u16, name: &'static str, via: Via) -> Model {
    Model::new(driver, vid, pid, name, Kind::Mouse, via).feature(Len::Eq(65))
}

pub static MODELS: &[Model] = &[
    p83("mk-arbiter", 0x373E, 0x0009, "Arbiter Studio Akitsu", Via::Cable).page(0xFFFF).pair("ar:akitsu"),
    p83("mk-arbiter", 0x373E, 0x000A, "Arbiter Studio Akitsu", Via::Receiver).page(0xFFFF).pair("ar:akitsu"),
    p83("mk-arbiter", 0x373E, 0x0038, "Arbiter Studio Akitsu 3950", Via::Cable).page(0xFFFF).pair("ar:akitsu3950"),
    p83("mk-arbiter", 0x373E, 0x0039, "Arbiter Studio Akitsu 3950", Via::Receiver).page(0xFFFF).pair("ar:akitsu3950"),
    p83("mk-arbiter", 0x373E, 0x0066, "Arbiter Studio Akitsu Medium", Via::Cable).page(0xFFFF).pair("ar:akitsum"),
    p83("mk-arbiter", 0x373E, 0x0067, "Arbiter Studio Akitsu Medium", Via::Receiver).page(0xFFFF).pair("ar:akitsum"),
];

pub static LAMZU: [Model; 46] = [
    p83("mk-lamzu", 0x373E, 0x001C, "LAMZU Maya X", Via::Cable),
    p83("mk-lamzu", 0x373E, 0x001D, "LAMZU Maya X", Via::Receiver),
    p83("mk-lamzu", 0x373E, 0x001E, "LAMZU Maya X", Via::Receiver),
    p83("mk-lamzu", 0x373E, 0x0016, "LAMZU Maya X V2", Via::Receiver),
    p83("mk-lamzu", 0x37B0, 0x001F, "LAMZU Maya X V2", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x0005, "LAMZU Tachi", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x000B, "LAMZU Tachi", Via::Receiver),
    p83("mk-lamzu", 0x37B0, 0x000C, "LAMZU Tachi", Via::Receiver),
    p83("mk-lamzu", 0x37B0, 0x001C, "LAMZU Tachi Lite", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x001E, "LAMZU Tachi Lite", Via::Receiver),
    p83("mk-lamzu", 0x37B0, 0x0009, "LAMZU Inca", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x000F, "LAMZU Inca", Via::Receiver),
    p83("mk-lamzu", 0x37B0, 0x0010, "LAMZU Inca", Via::Receiver),
    p83("mk-lamzu", 0x37B0, 0x0011, "LAMZU Maya", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x0013, "LAMZU Maya", Via::Receiver),
    p83("mk-lamzu", 0x37B0, 0x0015, "LAMZU Maya", Via::Receiver),
    p83("mk-lamzu", 0x37B0, 0x0007, "LAMZU Paro", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x000D, "LAMZU Paro", Via::Receiver),
    p83("mk-lamzu", 0x37B0, 0x000E, "LAMZU Paro", Via::Receiver),
    p83("mk-lamzu", 0x37B0, 0x0017, "LAMZU Thorn", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x0019, "LAMZU Thorn", Via::Receiver),
    p83("mk-lamzu", 0x37B0, 0x001B, "LAMZU Thorn", Via::Receiver),
    p83("mk-lamzu", 0x37B0, 0x0021, "LAMZU Thorn V2", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x0003, "LAMZU Thorn V2", Via::Receiver),
    p83("mk-lamzu", 0x37B0, 0x0023, "LAMZU Thorn V2", Via::Receiver),
    p83("mk-lamzu", 0x37B0, 0x0030, "LAMZU Thorn V2", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x0032, "LAMZU Thorn V2", Via::Receiver),
    p83("mk-lamzu", 0x37B0, 0x0040, "LAMZU Thorn V2", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x0025, "LAMZU Atlantis OG Champion", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x0027, "LAMZU Atlantis OG Champion", Via::Receiver),
    p83("mk-lamzu", 0x37B0, 0x0028, "LAMZU Atlantis Mini", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x002B, "LAMZU Atlantis Mini", Via::Receiver),
    p83("mk-lamzu", 0x37B0, 0x002A, "LAMZU Atlantis Mini", Via::Receiver),
    p83("mk-lamzu", 0x37B0, 0x003E, "LAMZU Atlantis Mini", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x003F, "LAMZU Atlantis Mini", Via::Receiver),
    p83("mk-lamzu", 0x37B0, 0x002C, "LAMZU Maya M", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x0052, "LAMZU Maya M", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x003A, "LAMZU Maya X", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x003B, "LAMZU Maya X", Via::Receiver),
    p83("mk-lamzu", 0x37B0, 0x0044, "LAMZU Maya X", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x003C, "LAMZU Maya", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x0050, "LAMZU Maya", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x0042, "LAMZU Orcus", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x0056, "LAMZU Orcus", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x0046, "LAMZU Mini", Via::Cable),
    p83("mk-lamzu", 0x37B0, 0x0054, "LAMZU Mini", Via::Receiver),
];

#[cfg(test)]
mod tests {
    use super::super::proto::P83;
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn lamzu_and_arbiter() {
        let m = model("mk-lamzu", 0x0011);
        assert_eq!(m.vid, 0x37B0);
        let mut f = fake(m);
        f.feature_replies.push_back(report(0x00, 65, &[(1, 0xA1), (4, 0x02), (6, 0x83), (7, 1), (8, 47)]));
        assert_eq!(read1(&mut f, m), at(pctl(47), Charging::Yes));
        assert_eq!(f.sent, vec![P83.to_vec()]);
        let a = model("mk-arbiter", 0x000A);
        let mut f = fake(a);
        f.feature_replies.push_back(report(0x00, 65, &[(1, 0xA0), (4, 0x02), (6, 0x83)]));
        assert_eq!(read1(&mut f, a), dozing(7), "A0 from an Arbiter: asleep");
        assert_eq!(f.sent.len(), 1, "not asked again");
    }
}
