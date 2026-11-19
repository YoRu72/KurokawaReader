// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): ATK / VXE — the NearLink mice on the «NK mouse NANO dongle»
// (373B:1216, ATK's BITMOUSE protocol) and the ATK V75X keyboard (320F:5088 receiver, 5055 cable). The Dragonfly R1
// family takes the «Compx 17» frames (kysona.rs); the ATK N9 headsets (atk_serial.cpp) are the headset piece's.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/atk_bitmouse.cpp and atk_keyboard.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9
// and its contributors, GPL-3.0-or-later. Their references: HeyOkay/HaloBattery (atk_bitmouse.py, atk_keyboard.py),
// qwr79/mouse-battery, ATK HUB 3.2.29's Evision keyboard driver.
//  - NK dongle, FF05:0001: output report 08, 64 bytes [08][sum of bytes 2–63][72][02][00][01 = the mouse][cmd][01];
//    reply [08][72][status: FF error][seq][00][cmd][01][value]. cmd 07 level, 0F charging. No reply: asleep.
//  - V75X, FF1C:0092: output report 04 [04][seq lo][seq hi][1A][00 …]; input report 04 [04][seq lo][seq hi][1A][..]
//    [00 00][..][percent][state: 0 on battery, 1 / 2 charging]. The ids are shared with other Evision keyboards, so the
//    product string is checked too (Model::product).
// Changed here: one fixed sequence number (01 00) — the reply is tied to the request by the queue dropped first and
// the echo; the original's «ask over the receiver at most every 10 minutes» is the round's interval; nothing kept
// across rounds (the original's lastPercent).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

pub static MODELS: &[Model] = &[
    Model::new("mk-atk-nk", 0x373B, 0x1216, "ATK / VXE NK mouse", Kind::Mouse, Via::Receiver).page(0xFF05).usage(0x0001).output(Len::Min(64)).input(Len::Min(8)),
    Model::new("mk-atk-kb", 0x320F, 0x5055, "ATK V75X", Kind::Keyboard, Via::Cable).page(0xFF1C).usage(0x0092).pair("atk:v75x").product_is("ATK V75X"),
    Model::new("mk-atk-kb", 0x320F, 0x5088, "ATK V75X", Kind::Keyboard, Via::Receiver).page(0xFF1C).usage(0x0092).pair("atk:v75x").product_is("ATK V75X 2.4G Dongle"),
];

pub const fn nk(cmd: u8) -> [u8; 8] {
    [0x08, 0x76u8.wrapping_add(cmd), 0x72, 0x02, 0x00, 0x01, cmd, 0x01]
}
pub const NK_LEVEL: [u8; 8] = nk(0x07);
pub const NK_CHARGING: [u8; 8] = nk(0x0F);
pub const KB: [u8; 4] = [0x04, 0x01, 0x00, 0x1A];

fn nk_query(ch: &mut Chans, req: &[u8; 8], deadline: Instant) -> Result<u8, TErr> {
    let cmd = req[6];
    out_ask(ch, req, ms(700), deadline, &mut |r| {
        if r.len() < 8 || r[0] != 0x08 || r[1] != 0x72 || r[5] != cmd {
            return None;
        }
        Some(r[2])
            .filter(|&s| s != 0xFF)
            .map(|_| r[7])
            .or(Some(0xFF))
    })
}

pub fn read_nk(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Outcome {
    match nk_query(ch, &NK_LEVEL, deadline) {
        Ok(l) if (1..=100).contains(&l) => {
            let c = match nk_query(ch, &NK_CHARGING, deadline) {
                Ok(1) => Charging::Yes,
                Ok(0) => Charging::No,
                _ => Charging::Unknown,
            };
            got(pct(i64::from(l)).unwrap_or(Level::Unknown), c, now)
        }
        Ok(_) => no_level(Charging::Unknown, now),
        Err(TErr::Gone) => Outcome::Failed,
        // (The dongle stops answering while the mouse sleeps.)
        Err(_) => dozing(now),
    }
}

pub fn read_kb(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Outcome {
    match out_ask(ch, &KB, ms(1000), deadline, &mut |r| if r.len() >= 10 && r[0] == 0x04 && r[1] == 0x01 && r[2] == 0x00 && r[3] == 0x1A && r[5] == 0 && r[6] == 0 { Some((r[8], r[9])) } else { None }) {
        Ok((p, s)) if p <= 100 && s <= 2 => got(pct(i64::from(p)).unwrap_or(Level::Unknown), charging(s == 1 || s == 2), now),
        Ok(_) => no_level(Charging::Unknown, now),
        Err(TErr::Gone) => Outcome::Failed,
        Err(_) => dozing(now),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn atk() {
        assert_eq!(NK_LEVEL[1], sum8(&{
            let mut b = [0u8; 64];
            b[..8].copy_from_slice(&NK_LEVEL);
            b
        }[2..]));
        let m = model("mk-atk-nk", 0x1216);
        let mut f = fake(m);
        f.replies.extend([vec![report(0x08, 8, &[(1, 0x72), (2, 0), (5, 0x07), (6, 1), (7, 88)])], vec![report(0x08, 8, &[(1, 0x72), (5, 0x0F), (6, 1), (7, 1)])]]);
        assert_eq!(read1(&mut f, m), at(pctl(88), Charging::Yes));
        assert_eq!(f.sent, vec![NK_LEVEL.to_vec(), NK_CHARGING.to_vec()]);
        let mut f = fake(m);
        assert_eq!(read1(&mut f, m), dozing(7), "no reply: asleep");
        let k = model("mk-atk-kb", 0x5088);
        assert!(k.product_ok("ATK V75X 2.4G Dongle  ") && k.product_ok("atk v75x 2.4g dongle") && !k.product_ok("Evision keyboard"));
        let mut f = fake(k);
        f.replies.push_back(vec![report(0x04, 32, &[(1, 0x01), (3, 0x1A), (8, 45), (9, 2)])]);
        assert_eq!(read1(&mut f, k), at(pctl(45), Charging::Yes));
        let mut f = fake(k);
        f.replies.push_back(vec![report(0x04, 32, &[(1, 0x02), (3, 0x1A), (8, 45)])]);
        assert_eq!(read1(&mut f, k), dozing(7), "another sequence: not our reply");
    }
}
