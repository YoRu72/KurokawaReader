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
    k("mk-redragon-k", 0x3554, 0xF55D, "Redragon wireless mouse", Via::Receiver).pair("rd:m916"),
    k("mk-redragon-k", 0x3554, 0xF5D5, "Redragon wireless mouse", Via::Receiver),
    k("mk-redragon-k", 0x3554, 0xF55E, "Redragon wireless mouse", Via::Cable).pair("rd:m916"),
    ff02("mk-atk-k", 0x3554, 0xF58A, "VXE Dragonfly R1", Via::Receiver),
    ff02("mk-atk-k", 0x3554, 0xF58E, "VXE Dragonfly R1", Via::Receiver),
    ff02("mk-atk-k", 0x3554, 0xF505, "VXE Dragonfly R1", Via::Receiver),
    ff02("mk-atk-k", 0x3554, 0xF58C, "VXE Dragonfly R1", Via::Cable),
    ff02("mk-atk-k", 0x3554, 0xF58F, "VXE Dragonfly R1", Via::Cable),
    ff02("mk-atk-k", 0x3554, 0xF506, "VXE Dragonfly R1", Via::Cable),
    k("mk-hitscan-k", 0x3770, 0x0200, "Hitscan Hyperlight", Via::Receiver),
    k("mk-pulsar-k", 0x3710, 0x5406, "Pulsar wireless mouse", Via::Receiver).product_name(),
    ff02("mk-corsair-compx", 0x1B1C, 0x2B2A, "Corsair Sabre V2 Pro Ultralight", Via::Receiver),
];

fn reply(cmd: u8) -> impl FnMut(&[u8]) -> Option<Vec<u8>> {
    move |r: &[u8]| if r.len() >= 17 && r[0] == 0x08 && r[1] == cmd && compx_sum_ok(r) { Some(r[..17].to_vec()) } else { None }
}

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    let _ = m;
    let mut linked = None;
    match out_ask(ch, &COMPX_LINK, ms(500), deadline, &mut reply(0x03)) {
        Ok(r) => linked = Some(r[6] != 0),
        Err(TErr::Gone) => return Outcome::Failed,
        Err(_) => {}
    }
    if linked == Some(false) {
        return unlinked(now);
    }
    match out_ask(ch, &COMPX_BATTERY, ms(500), deadline, &mut reply(0x04)) {
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
}
