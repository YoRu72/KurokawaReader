// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the «Compx 17» output protocol — Kysona, ATK / VXE Dragonfly R1,
// Redragon (Compx ids), the original Hitscan Hyperlight, Pulsar's XS-1 8K dongle, G-Wolves' models on it, HECATE, and
// Corsair's Compx mice (Sabre V2 Pro Ultralight).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/kysona.cpp (Query, Checksum, PollKysona) and corsair.cpp (CorsairCompxQuery, PollCorsairCompx) at
// commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later. Its references:
// Linux drivers/hid/hid-kysona.c (Lode Willems), S1berla/vxe-r1-pro-max-battery, HeyOkay/HaloBattery.
// 17-byte output / input report 08: [08][cmd][00 × 14][55 − sum of bytes 0–15].
//   cmd 03 «online» → [6] = 1 when the mouse is linked to its receiver
//   cmd 04 «battery» → [6] percent, [7] charging, [8..9] millivolts
// D1 (the original's v1.1.0: kysona.cpp, chimera.cpp, zenith.cpp, cherry.cpp's XTRFY receiver, at commit
// 7cc44f2): the same frames for the Chimera V2 (3554:F512 — its replies keep the status at [5], 02 = linked, the level
// at [6]: Model::arg 1), the Zenith Pro (260D:1114 receiver, 1143 cable — the battery frame only, as the original sends:
// arg 2), the Cherry XTRFY 1K mouse receiver (046A:0330) and HECATE's own receiver D3FB (HECATE Connect's Config.ini).
// A VXE R1 cable and its receiver are one card by the pair rule (F58A / F58C, F58E / F58F, F505 / F506, the original's
// KeyPid). The Chimera's frames were found by its contributor probing the device: they are the documented Compx reads.
// Changed here: the products by id (the original sent these frames to every product of 3554, 373B, 3770, 33E4, 3710
// and 35BB with a 17-byte collection); the ATK N9 headsets are never in it (serial protocol: the headset piece).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::proto::{compx_sum_ok, COMPX_BATTERY, COMPX_LINK};
use super::*;

const fn k(driver: &'static str, vid: u16, pid: u16, name: &'static str, via: Via) -> Model {
    Model::new(driver, vid, pid, name, Kind::Mouse, via).input(Len::Eq(17)).output(Len::Eq(17))
}
const fn ff02(driver: &'static str, vid: u16, pid: u16, name: &'static str, via: Via) -> Model {
    Model::new(driver, vid, pid, name, Kind::Mouse, via).page(0xFF02).usage(0x0002).input(Len::Min(17)).output(Len::Min(17))
}

/// G-Wolves models (glorious.rs's list): their 17-byte collection, where a model speaks this protocol.
pub static GWOLVES_K: [Model; super::glorious::GWOLVES_PIDS.len()] = many(k("mk-gwolves-k", 0x33E4, 0, "G-Wolves wireless mouse", Via::Receiver), super::glorious::GWOLVES_PIDS);

pub static MODELS: &[Model] = &[
    k("mk-kysona", 0x3554, 0xF57C, "Kysona M600", Via::Receiver),
    k("mk-kysona", 0x3554, 0xF57D, "Kysona M600", Via::Cable),
    k("mk-kysona", 0x35BB, 0xD3FA, "HECATE mouse", Via::Cable),
    k("mk-kysona", 0x35BB, 0xD3FC, "HECATE mouse", Via::Cable),
    k("mk-kysona", 0x35BB, 0xD3FD, "HECATE mouse", Via::Cable),
    k("mk-kysona", 0x35BB, 0xD3FB, "HECATE mouse", Via::Receiver),
    k("mk-redragon-k", 0x3554, 0xF55D, "Redragon wireless mouse", Via::Receiver).pair("rd:m916"),
    k("mk-redragon-k", 0x3554, 0xF5D5, "Redragon wireless mouse", Via::Receiver),
    k("mk-redragon-k", 0x3554, 0xF55E, "Redragon wireless mouse", Via::Cable).pair("rd:m916"),
    ff02("mk-atk-k", 0x3554, 0xF58A, "VXE Dragonfly R1", Via::Receiver).pair("vxe:r1a"),
    ff02("mk-atk-k", 0x3554, 0xF58E, "VXE Dragonfly R1", Via::Receiver).pair("vxe:r1b"),
    ff02("mk-atk-k", 0x3554, 0xF505, "VXE Dragonfly R1", Via::Receiver).pair("vxe:r1c"),
    ff02("mk-atk-k", 0x3554, 0xF58C, "VXE Dragonfly R1", Via::Cable).pair("vxe:r1a"),
    ff02("mk-atk-k", 0x3554, 0xF58F, "VXE Dragonfly R1", Via::Cable).pair("vxe:r1b"),
    ff02("mk-atk-k", 0x3554, 0xF506, "VXE Dragonfly R1", Via::Cable).pair("vxe:r1c"),
    k("mk-hitscan-k", 0x3770, 0x0200, "Hitscan Hyperlight", Via::Receiver),
    k("mk-pulsar-k", 0x3710, 0x5406, "Pulsar wireless mouse", Via::Receiver).product_name(),
    ff02("mk-corsair-compx", 0x1B1C, 0x2B2A, "Corsair Sabre V2 Pro Ultralight", Via::Receiver),
    ff02("mk-chimera", 0x3554, 0xF512, "Chimera V2", Via::Receiver).arg(1),
    ff02("mk-zenith", 0x260D, 0x1114, "Zenith Pro", Via::Receiver).iface(1).input(Len::Eq(17)).output(Len::Eq(17)).arg(2).pair("zenith:pro"),
    ff02("mk-zenith", 0x260D, 0x1143, "Zenith Pro", Via::Cable).iface(1).input(Len::Eq(17)).output(Len::Eq(17)).arg(2).pair("zenith:pro"),
    ff02("mk-cherry-x", 0x046A, 0x0330, "Cherry XTRFY wireless mouse", Via::Receiver).input(Len::Eq(17)).output(Len::Eq(17)),
];

fn reply(cmd: u8) -> impl FnMut(&[u8]) -> Option<Vec<u8>> {
    move |r: &[u8]| if r.len() >= 17 && r[0] == 0x08 && r[1] == cmd && compx_sum_ok(r) { Some(r[..17].to_vec()) } else { None }
}

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    if m.arg == 2 {
        // (Zenith Pro: the battery frame only; the dongle stops answering while the mouse sleeps.)
        return match out_ask(ch, &COMPX_BATTERY, ms(1000), deadline, &mut reply(0x04)) {
            Ok(r) => match pct(i64::from(r[6])) {
                Some(l) => got(l, charging(r[7] != 0), now),
                None => no_level(charging(r[7] != 0), now),
            },
            Err(TErr::Gone) => Outcome::Failed,
            Err(_) => dozing(now),
        };
    }
    // (Chimera V2: the status at [5].)
    let at = if m.arg == 1 { 5 } else { 6 };
    let mut linked = None;
    match out_ask(ch, &COMPX_LINK, ms(500), deadline, &mut reply(0x03)) {
        Ok(r) => linked = Some(r[at] != 0),
        Err(TErr::Gone) => return Outcome::Failed,
        Err(_) => {}
    }
    if linked == Some(false) {
        return unlinked(now);
    }
    match out_ask(ch, &COMPX_BATTERY, ms(500), deadline, &mut reply(0x04)) {
        Ok(r) if m.arg == 1 && r[5] != 0x02 => unlinked(now),
        Ok(r) => match pct(i64::from(r[6])) {
            Some(l) => got(l, charging(r[7] != 0), now),
            None => no_level(charging(r[7] != 0), now),
        },
        // (The receiver says online, the mouse did not answer: asleep.)
        Err(_) if linked == Some(true) => dozing(now),
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    fn frame(cmd: u8, at6: u8, at7: u8) -> Vec<u8> {
        let mut r = report(0x08, 17, &[(1, cmd), (6, at6), (7, at7)]);
        r[16] = 0x55u8.wrapping_sub(sum8(&r[..16]));
        r
    }

    #[test]
    fn compx_output() {
        let m = model("mk-kysona", 0xF57C);
        let mut f = fake(m);
        f.replies.extend([vec![frame(0x03, 1, 0)], vec![frame(0x04, 81, 1)]]);
        assert_eq!(read1(&mut f, m), at(pctl(81), Charging::Yes));
        assert_eq!(f.sent, vec![COMPX_LINK.to_vec(), COMPX_BATTERY.to_vec()]);
        let mut f = fake(m);
        f.replies.push_back(vec![frame(0x03, 0, 0)]);
        assert_eq!(read1(&mut f, m), unlinked(7));
        assert_eq!(f.sent.len(), 1, "not linked: no battery request");
        let mut f = fake(m);
        f.replies.push_back(vec![frame(0x03, 1, 0)]);
        assert_eq!(read1(&mut f, m), dozing(7));
        let mut f = fake(m);
        let mut bad = frame(0x04, 50, 0);
        bad[16] ^= 0xFF;
        f.replies.extend([vec![], vec![bad, frame(0x05, 50, 0)]]);
        assert_eq!(read1(&mut f, m), Outcome::NoAnswer, "a bad checksum, another command: no reply");
        let c = model("mk-corsair-compx", 0x2B2A);
        let mut f = fake(c);
        f.replies.extend([vec![frame(0x03, 1, 0)], vec![frame(0x04, 101, 0)]]);
        assert_eq!(read1(&mut f, c), no_level(Charging::No, 7));
    }

    fn frame_at(cmd: u8, at: &[(usize, u8)]) -> Vec<u8> {
        let mut v = vec![(1, cmd)];
        v.extend_from_slice(at);
        let mut r = report(0x08, 17, &v);
        r[16] = 0x55u8.wrapping_sub(sum8(&r[..16]));
        r
    }

    #[test]
    fn v110_models() {
        // (Chimera V2: status at [5] — 02 linked —, level [6], charging [7].)
        let m = model("mk-chimera", 0xF512);
        let mut f = fake(m);
        f.replies.extend([vec![frame_at(0x03, &[(5, 1)])], vec![frame_at(0x04, &[(5, 2), (6, 64), (7, 0), (8, 0x0F), (9, 0x10)])]]);
        assert_eq!(read1(&mut f, m), at(pctl(64), Charging::No));
        assert_eq!(f.sent, vec![COMPX_LINK.to_vec(), COMPX_BATTERY.to_vec()]);
        let mut f = fake(m);
        f.replies.push_back(vec![frame_at(0x03, &[(5, 0), (6, 1)])]);
        assert_eq!(read1(&mut f, m), unlinked(7), "status 0: not linked, whatever [6] holds");
        let mut f = fake(m);
        f.replies.extend([vec![frame_at(0x03, &[(5, 1)])], vec![frame_at(0x04, &[(5, 1), (6, 64)])]]);
        assert_eq!(read1(&mut f, m), unlinked(7), "a battery reply without status 02");
        // (Zenith Pro: the battery frame only; silence is a dozing mouse.)
        let z = model("mk-zenith", 0x1114);
        let mut f = fake(z);
        f.replies.push_back(vec![frame_at(0x04, &[(6, 77), (7, 1)])]);
        assert_eq!(read1(&mut f, z), at(pctl(77), Charging::Yes));
        assert_eq!(f.sent, vec![COMPX_BATTERY.to_vec()]);
        let mut f = fake(z);
        assert_eq!(read1(&mut f, z), dozing(7));
        assert_eq!(merge_pairs(&[z, model("mk-zenith", 0x1143)]), vec![vec![1, 0]]);
        // (Cherry XTRFY: the Kysona way, the frame of its capture: 95 %, 4084 mV.)
        let x = model("mk-cherry-x", 0x0330);
        let mut f = fake(x);
        f.replies.extend([vec![frame_at(0x03, &[(6, 1)])], vec![frame_at(0x04, &[(5, 2), (6, 0x5F), (8, 0x0F), (9, 0xF4)])]]);
        assert_eq!(read1(&mut f, x), at(pctl(95), Charging::No));
        // (A VXE R1 cable and its receiver: one card.)
        assert_eq!(merge_pairs(&[model("mk-atk-k", 0xF58A), model("mk-atk-k", 0xF58C)]), vec![vec![1, 0]]);
    }
}
