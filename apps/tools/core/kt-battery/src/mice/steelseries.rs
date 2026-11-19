// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): SteelSeries wireless mice (VID 1038).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/steelseries.cpp (Aerox, Rival, RivalPro, the mice' rows of kModels) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later. Its reference for the
// mice: flozz/rivalcfg (and its pull request 294 for the Rival Pro).
//   Aerox 3 / 5 / 9 Wireless, Prime Wireless (interface 3): output 00 92 (on the cable) or 00 D2 (receiver) →
//     [1] = (level / 5 + 1) | charging << 7; 0 = the mouse is off or away; only 1–21 are levels.
//   Rival 3 Wireless (Gen 2), Rival 650 (interface 3 / 0): output 00 AA 01 → [0] percent, [2] charging.
//   Rival Pro (interface 2, UWB base): output 00 92 → 92 00 <mouse %> <flag> <spare battery %>.
// The headsets of steelseries.cpp (Arctis 1 / 7 / 9 / Pro / Nova …) and steelseries_elite.cpp (Arctis Nova Elite base
// station 2244) are the headset piece's.
// Changed here: the Aerox level as its own 0–20 steps (the original: × 5 %); the Rival 650 on cable and receiver one
// card by the pair rule.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn m(pid: u16, name: &'static str, via: Via, iface: i32, pair: &'static str) -> Model {
    Model::new("mk-steelseries", 0x1038, pid, name, Kind::Mouse, via).iface(iface).output(Len::Min(2)).pair(pair)
}

pub static MODELS: &[Model] = &[
    m(0x1838, "SteelSeries Aerox 3 Wireless", Via::Receiver, 3, "ss:aerox3"),
    m(0x183A, "SteelSeries Aerox 3 Wireless", Via::Cable, 3, "ss:aerox3"),
    m(0x1852, "SteelSeries Aerox 5 Wireless", Via::Receiver, 3, "ss:aerox5"),
    m(0x1854, "SteelSeries Aerox 5 Wireless", Via::Cable, 3, "ss:aerox5"),
    m(0x1858, "SteelSeries Aerox 9 Wireless", Via::Receiver, 3, "ss:aerox9"),
    m(0x185A, "SteelSeries Aerox 9 Wireless", Via::Cable, 3, "ss:aerox9"),
    m(0x1840, "SteelSeries Prime Wireless", Via::Receiver, 3, "ss:prime"),
    m(0x1842, "SteelSeries Prime Wireless", Via::Cable, 3, "ss:prime"),
    m(0x1830, "SteelSeries Rival 3 Wireless", Via::Receiver, 3, "").arg(1),
    m(0x1872, "SteelSeries Rival 3 Wireless Gen 2", Via::Receiver, 3, "").arg(1),
    m(0x172B, "SteelSeries Rival 650 Wireless", Via::Cable, 0, "ss:rival650").arg(1),
    m(0x1726, "SteelSeries Rival 650 Wireless", Via::Receiver, 0, "ss:rival650").arg(1),
    m(0x1880, "SteelSeries Rival Pro", Via::Receiver, 2, "").arg(2),
];

pub const AEROX_CABLE: [u8; 2] = [0x00, 0x92];
pub const AEROX_RX: [u8; 2] = [0x00, 0xD2];
pub const RIVAL: [u8; 3] = [0x00, 0xAA, 0x01];
pub const RIVAL_PRO: [u8; 2] = [0x00, 0x92];

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    match m.arg {
        // (Aerox, Prime.)
        0 => {
            let req = if m.via == Via::Cable { AEROX_CABLE } else { AEROX_RX };
            match out_ask(ch, &req, ms(300), deadline, &mut |r| if r.len() >= 2 { Some(r[1]) } else { None }) {
                Ok(b) => {
                    let raw = b & 0x7F;
                    if raw == 0 {
                        unlinked(now)
                    } else if raw <= 21 {
                        got(steps(i64::from(raw - 1), 20).unwrap_or(Level::Unknown), charging(b & 0x80 != 0), now)
                    } else {
                        no_level(Charging::Unknown, now)
                    }
                }
                Err(e) => failed(&e),
            }
        }
        1 => match out_ask(ch, &RIVAL, ms(300), deadline, &mut |r| if r.len() >= 3 { Some((r[0], r[2])) } else { None }) {
            Ok((p, c)) => got(pct(i64::from(p)).unwrap_or(Level::Unknown), charging(c != 0), now),
            Err(e) => failed(&e),
        },
        _ => match out_ask(ch, &RIVAL_PRO, ms(500), deadline, &mut |r| if r.len() >= 3 && r[0] == 0x92 && r[1] == 0x00 { Some(r[2]) } else { None }) {
            Ok(p) => match pct(i64::from(p)) {
                Some(l) => got(l, Charging::Unknown, now),
                None => no_level(Charging::Unknown, now),
            },
            Err(e) => failed(&e),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn mice() {
        let rx = model("mk-steelseries", 0x1838);
        let mut f = fake(rx);
        f.replies.push_back(vec![vec![0x00, 0xD2, 0x80 | 15]]);
        assert_eq!(read1(&mut f, rx), at(steps(14, 20).unwrap(), Charging::Yes));
        assert_eq!(f.sent, vec![AEROX_RX.to_vec()]);
        let mut f = fake(rx);
        f.replies.push_back(vec![vec![0x00, 0xD2, 0x00]]);
        assert_eq!(read1(&mut f, rx), unlinked(7), "0: the mouse off or away");
        let mut f = fake(rx);
        f.replies.push_back(vec![vec![0x00, 0xD2, 22]]);
        assert_eq!(read1(&mut f, rx), no_level(Charging::Unknown, 7));
        let cable = model("mk-steelseries", 0x183A);
        let mut f = fake(cable);
        f.replies.push_back(vec![vec![0x00, 0x92, 21]]);
        assert_eq!(read1(&mut f, cable), at(steps(20, 20).unwrap(), Charging::No));
        assert_eq!(f.sent, vec![AEROX_CABLE.to_vec()]);
        let r3 = model("mk-steelseries", 0x1830);
        let mut f = fake(r3);
        f.replies.push_back(vec![vec![0x00, 64, 0, 1]]);
        assert_eq!(read1(&mut f, r3), at(pctl(64), Charging::Yes), "the 0 report id dropped: [0] percent");
        let pro = model("mk-steelseries", 0x1880);
        let mut f = fake(pro);
        f.replies.push_back(vec![vec![0x00, 0x11, 0x22, 0x33], vec![0x00, 0x92, 0x00, 58, 0, 90]]);
        assert_eq!(read1(&mut f, pro), at(pctl(58), Charging::Unknown));
        let mut f = fake(pro);
        f.replies.push_back(vec![vec![0x00, 0x92]]);
        assert_eq!(read1(&mut f, pro), Outcome::NoAnswer, "short");
    }
}
