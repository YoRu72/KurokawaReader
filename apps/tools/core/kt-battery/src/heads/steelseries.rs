// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): SteelSeries Arctis headsets and the Arctis GameBuds (VID 1038).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/steelseries.cpp (Arctis1, Arctis7, Arctis9, ArctisProWireless, NovaProWireless, NovaFamily, the headsets'
// rows of kModels) and src/drivers/steelseries_elite.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9
// and its contributors, GPL-3.0-or-later. Their references: Sapd/HeadsetControl; for the Elite HeyOkay/HaloBattery,
// elegos/Linux-Arctis-Manager, loteran/Arctis-Sound-Manager.
//   Arctis 1 / 1 Xbox / 7X (FF43:0202): 06 12 → [2] 01 off, [3] percent.   Arctis 7 / Pro 2019 (FF43:0202): 06 18 → [2].
//   Arctis 9 (interface 0): 00 20 → [3] 0x64–0x9A, [4] 01 charging.   Arctis Pro Wireless (interface 0): 00 41 AA →
//   [0] 02 off; 00 40 AA → [0] 0–4 (both also without the 0 report id, for a firmware that numbers its reports).
//   Arctis Nova Pro Wireless (interface 4): 06 B0 → [15] 01 off / 02 charging, [6] 0–8.
//   Nova family (FFC0:0001): 00 B0 → by model: 7+ [1] 01 off, [2] 0–4, [3] charging; Nova 3P / Nova 5 [1] 02 off, [3] %,
//   [4] charging; GameBuds [3] / [4] 03 = left / right bud out of the case, [5] / [6] their levels; Nova 7 family
//   [3] 00 off, 01 / 02 charging, [2] percent or 0–4 on the first models.
//   Arctis Nova Elite base station (2244, interface 3): 64-byte output 01 B0 to its FFC0 collection; the direct reply
//   01 B0 ([6] level, [14] power: 01 headset off, 02 on the cable, [15] 02 charging) or pushed 07 B7 <level> <spare>
//   <02 charging> / 07 B5 <?> <bt> <power>, on either collection of interface 3.
// Changed here: levels as the headset gives them — 0–4 and 0–8 as steps (the original: × 25 % / × 12.5 %); Arctis 9's
// 0x64–0x9A range rounded to whole per cent (it was mapped the same way); the GameBuds as earbuds with their two buds'
// levels on one card — the case is not reported by this headset — and «in the case» when neither bud is out (the
// original showed the lower one or nothing); matched by product and collection only (the original asked every 1038
// product it found in its list after the mice).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::mice::*;
use crate::model::{Charging, Kind, Level, Note, Part, PartName, Reading};
use crate::sched::Outcome;
use crate::transport::{HidTransport, TErr};
use std::time::{Duration, Instant};

const V: u16 = 0x1038;
const fn hs(driver: &'static str, pid: u16, name: &'static str, arg: u16) -> Model {
    Model::new(driver, V, pid, name, Kind::Headset, Via::Receiver).arg(arg)
}
const fn ff43(pid: u16, name: &'static str, arg: u16) -> Model {
    hs("hs-steelseries", pid, name, arg).page(0xFF43).usage(0x0202)
}
const fn nova(pid: u16, name: &'static str) -> Model {
    hs("hs-steelseries", pid, name, 6).page(0xFFC0).usage(0x0001)
}

pub const A1: u16 = 1;
pub const A7: u16 = 2;
pub const A9: u16 = 3;
pub const APRO: u16 = 4;
pub const NOVAPRO: u16 = 5;
pub const NOVA: u16 = 6;

pub static MODELS: &[Model] = &[
    ff43(0x12B3, "SteelSeries Arctis 1 Wireless", A1),
    ff43(0x12B6, "SteelSeries Arctis 1 Wireless", A1),
    ff43(0x12D7, "SteelSeries Arctis 1 Wireless", A1),
    ff43(0x1260, "SteelSeries Arctis 7", A7),
    ff43(0x12AD, "SteelSeries Arctis 7", A7),
    ff43(0x1252, "SteelSeries Arctis Pro", A7),
    hs("hs-steelseries", 0x12C2, "SteelSeries Arctis 9", A9).iface(0).output(Len::Min(1)),
    hs("hs-steelseries", 0x1290, "SteelSeries Arctis Pro Wireless", APRO).iface(0).output(Len::Min(1)),
    hs("hs-steelseries", 0x12E0, "SteelSeries Arctis Nova Pro Wireless", NOVAPRO).iface(4).output(Len::Min(1)),
    hs("hs-steelseries", 0x225D, "SteelSeries Arctis Nova Pro Wireless", NOVAPRO).iface(4).output(Len::Min(1)),
    nova(0x220E, "SteelSeries Arctis 7+"),
    nova(0x2212, "SteelSeries Arctis 7+"),
    nova(0x2216, "SteelSeries Arctis 7+"),
    nova(0x2236, "SteelSeries Arctis 7+"),
    nova(0x2269, "SteelSeries Arctis Nova 3P Wireless"),
    nova(0x226D, "SteelSeries Arctis Nova 3P Wireless"),
    nova(0x2232, "SteelSeries Arctis Nova 5"),
    nova(0x2253, "SteelSeries Arctis Nova 5"),
    nova(0x230A, "SteelSeries Arctis GameBuds").kind_of(Kind::Earbuds),
    nova(0x2202, "SteelSeries Arctis Nova 7"),
    nova(0x22A1, "SteelSeries Arctis Nova 7"),
    nova(0x227E, "SteelSeries Arctis Nova 7"),
    nova(0x2206, "SteelSeries Arctis Nova 7"),
    nova(0x2258, "SteelSeries Arctis Nova 7"),
    nova(0x229E, "SteelSeries Arctis Nova 7"),
    nova(0x22AD, "SteelSeries Arctis Nova 7"),
    nova(0x223A, "SteelSeries Arctis Nova 7"),
    nova(0x22A9, "SteelSeries Arctis Nova 7"),
    nova(0x227A, "SteelSeries Arctis Nova 7"),
    nova(0x22A4, "SteelSeries Arctis Nova 7"),
    nova(0x22A5, "SteelSeries Arctis Nova 7"),
    nova(0x220A, "SteelSeries Arctis Nova 7"),
    nova(0x22A7, "SteelSeries Arctis Nova 7"),
    hs("hs-ss-elite", 0x2244, "SteelSeries Arctis Nova Elite", 0).iface(3).page(0xFFC0).output(Len::Min(2)),
    hs("hs-ss-elite", 0x2244, "SteelSeries Arctis Nova Elite", 0).iface(3).vendor_page().role(Role::Reply),
];

pub const Q_A1: [u8; 2] = [0x06, 0x12];
pub const Q_A7: [u8; 2] = [0x06, 0x18];
pub const Q_A9: [u8; 2] = [0x00, 0x20];
pub const Q_APRO_LINK: [u8; 3] = [0x00, 0x41, 0xAA];
pub const Q_APRO_LEVEL: [u8; 3] = [0x00, 0x40, 0xAA];
pub const Q_APRO_LINK_N: [u8; 2] = [0x41, 0xAA];
pub const Q_APRO_LEVEL_N: [u8; 2] = [0x40, 0xAA];
pub const Q_NOVAPRO: [u8; 2] = [0x06, 0xB0];
pub const Q_NOVA: [u8; 2] = [0x00, 0xB0];
pub const Q_ELITE: [u8; 2] = [0x01, 0xB0];

const NOVA_7PLUS: [u16; 4] = [0x220E, 0x2212, 0x2216, 0x2236];
const NOVA_3P5: [u16; 4] = [0x2269, 0x226D, 0x2232, 0x2253];
const NOVA_DISCRETE: [u16; 6] = [0x2202, 0x2206, 0x220A, 0x223A, 0x227A, 0x22A4];
const GAMEBUDS: u16 = 0x230A;

fn ask(ch: &mut Chans, q: &[u8], min: usize, deadline: Instant) -> Result<Vec<u8>, TErr> {
    out_ask(ch, q, ms(1000), deadline, &mut |r| if r.len() >= min { Some(r.to_vec()) } else { None })
}

fn lvl(o: Option<Level>) -> Level {
    o.unwrap_or(Level::Unknown)
}

/// The Nova family's status block, by model (the 00 report id dropped, as the original indexes it).
pub fn nova_reading(pid: u16, r: &[u8], now: u64) -> Option<Outcome> {
    if r.len() < 7 {
        return None;
    }
    if NOVA_7PLUS.contains(&pid) {
        if r[1] == 0x01 {
            return Some(unlinked(now));
        }
        return Some(got(lvl(steps(i64::from(r[2]), 4)), charging(r[3] == 0x01), now));
    }
    if NOVA_3P5.contains(&pid) {
        if r[1] == 0x02 {
            return Some(unlinked(now));
        }
        return Some(got(lvl(pct(i64::from(r[3]))), charging(r[4] == 0x01), now));
    }
    if pid == GAMEBUDS {
        // (03: that bud is out of the case; its level then means something.)
        let bud = |name, out: bool, v: u8| if out { Some(Part { name, level: lvl(pct(i64::from(v))), charging: Charging::Unknown, in_use: true }) } else { None };
        let parts = [bud(PartName::Left, r[3] == 0x03, r[5]), bud(PartName::Right, r[4] == 0x03, r[6]), None];
        if parts.iter().all(Option::is_none) {
            return Some(Outcome::Read(Reading::unknown(Note::InCase, Charging::Unknown, now)));
        }
        return Some(Outcome::Read(Reading::with_parts(parts, now)));
    }
    if r[3] == 0x00 {
        return Some(unlinked(now));
    }
    let c = charging(r[3] == 0x01 || r[3] == 0x02);
    let l = if NOVA_DISCRETE.contains(&pid) { steps(i64::from(r[2]), 4) } else { pct(i64::from(r[2])) };
    Some(got(lvl(l), c, now))
}

fn read_arctis(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    let r = match m.arg {
        A1 => ask(ch, &Q_A1, 4, deadline).map(|r| if r[2] == 0x01 { unlinked(now) } else { got(lvl(pct(i64::from(r[3]))), Charging::Unknown, now) }),
        A7 => ask(ch, &Q_A7, 3, deadline).map(|r| if r[2] == 0 { unlinked(now) } else { got(lvl(pct(i64::from(r[2]))), Charging::Unknown, now) }),
        A9 => ask(ch, &Q_A9, 5, deadline).map(|r| {
            let l = if (0x64..=0x9A).contains(&r[3]) { lvl(scaled(i64::from(r[3] - 0x64), 0x9A - 0x64)) } else { Level::Unknown };
            got(l, charging(r[4] == 0x01), now)
        }),
        APRO => {
            let link = ask(ch, &Q_APRO_LINK, 1, deadline).or_else(|e| if e == TErr::Gone { Err(e) } else { ask(ch, &Q_APRO_LINK_N, 1, deadline) });
            link.map(|r| {
                if r[0] == 0x02 {
                    return unlinked(now);
                }
                let level = ask(ch, &Q_APRO_LEVEL, 1, deadline).or_else(|_| ask(ch, &Q_APRO_LEVEL_N, 1, deadline));
                match level {
                    Ok(l) => got(lvl(steps(i64::from(l[0]), 4)), Charging::Unknown, now),
                    Err(_) => no_level(Charging::Unknown, now),
                }
            })
        }
        NOVAPRO => ask(ch, &Q_NOVAPRO, 16, deadline).map(|r| {
            if r[15] == 0x01 {
                unlinked(now)
            } else {
                got(lvl(steps(i64::from(r[6]), 8)), charging(r[15] == 0x02), now)
            }
        }),
        _ => ask(ch, &Q_NOVA, 7, deadline).map(|r| nova_reading(m.pid, &r, now).unwrap_or(Outcome::NoAnswer)),
    };
    r.unwrap_or_else(|e| failed(&e))
}

/// The Elite's direct reply or pushed frames, whichever came: (level, charging, power).
#[derive(Default, Debug, PartialEq)]
pub struct EliteSeen {
    pub level: Option<u8>,
    pub charging: bool,
    pub power: Option<u8>,
}

pub fn elite_take(s: &mut EliteSeen, r: &[u8]) {
    if r.len() < 5 {
        return;
    }
    if r[0] == 0x01 && r[1] == 0xB0 && r.len() > 15 {
        if r[6] <= 100 {
            s.level = Some(r[6]);
        }
        s.charging = r[15] == 0x02;
        s.power = Some(r[14]);
    } else if r[0] == 0x07 && r[1] == 0xB7 && r[2] <= 100 {
        s.level = Some(r[2]);
        s.charging = r[4] == 0x02;
    } else if r[0] == 0x07 && r[1] == 0xB5 {
        s.power = Some(r[4]);
    }
}

fn read_elite(ch: &mut Chans, deadline: Instant, now: u64) -> Outcome {
    ch.main.flush();
    if let Some(r) = ch.reply.as_deref_mut() {
        r.flush();
    }
    let w = match crate::allow::permit(ch.main.ident(), crate::allow::ReportKind::Output, &Q_ELITE) {
        Some(w) => w,
        None => return Outcome::Failed,
    };
    let end = deadline.min(Instant::now() + ms(1000));
    if let Err(e) = ch.main.send(&w, end) {
        return failed(&e);
    }
    let mut s = EliteSeen::default();
    let mut heard = false;
    while Instant::now() < end && (s.level.is_none() || s.power.is_none()) && s.power != Some(0x01) {
        let mut quiet = 0;
        for which in [false, true] {
            let t: Option<&mut dyn HidTransport> = if which { ch.reply.as_deref_mut() } else { Some(&mut *ch.main) };
            let Some(t) = t else {
                quiet += 1;
                continue;
            };
            let slice = end.min(Instant::now() + Duration::from_millis(30));
            match t.read_input(slice) {
                Ok(r) => {
                    heard = true;
                    elite_take(&mut s, payload_keep(&r));
                }
                Err(TErr::Gone) => return Outcome::Failed,
                Err(_) => quiet += 1,
            }
        }
        if quiet == 2 && cfg!(test) {
            break;
        }
    }
    if s.power == Some(0x01) {
        return unlinked(now);
    }
    match s.level {
        Some(l) => got(lvl(pct(i64::from(l))), charging(s.charging || s.power == Some(0x02)), now),
        None if heard => no_level(Charging::Unknown, now),
        None => Outcome::NoAnswer,
    }
}

/// The Elite numbers its reports (01, 07): the report id kept.
fn payload_keep(r: &[u8]) -> &[u8] {
    r
}

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    if m.driver == "hs-ss-elite" {
        read_elite(ch, deadline, now)
    } else {
        read_arctis(ch, m, deadline, now)
    }
}

#[cfg(test)]
mod tests {
    use crate::mice::testkit::*;
    use super::*;
    use crate::model::Steps;
    use crate::transport::fake::FakeHid;

    #[test]
    fn arctis() {
        let m = model("hs-steelseries", 0x12B3);
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x06, 0x12, 0x03, 77]]);
        assert_eq!(read1(&mut f, m), at(pctl(77), Charging::Unknown));
        assert_eq!(f.sent, vec![Q_A1.to_vec()]);
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x06, 0x12, 0x01, 77]]);
        assert_eq!(read1(&mut f, m), unlinked(7));
        let m9 = model("hs-steelseries", 0x12C2);
        let mut f = fake(m9);
        f.replies.push_back(vec![vec![0x00, 0x00, 0x20, 0x00, 0x9A, 0x01]]);
        assert_eq!(read1(&mut f, m9), at(pctl(100), Charging::Yes), "0x9A is the top of its scale");
        let pro = model("hs-steelseries", 0x1290);
        let mut f = fake(pro);
        f.replies.extend([vec![vec![0x00, 0x04]], vec![vec![0x00, 0x03]]]);
        assert_eq!(read1(&mut f, pro), at(Level::Steps(Steps::new(3, 4).unwrap()), Charging::Unknown));
        let np = model("hs-steelseries", 0x12E0);
        let mut f = fake(np);
        let mut r = vec![0u8; 16];
        r[0] = 0x06;
        r[6] = 6;
        r[15] = 0x02;
        f.replies.push_back(vec![r]);
        assert_eq!(read1(&mut f, np), at(Level::Steps(Steps::new(6, 8).unwrap()), Charging::Yes));
        let mut f = fake(np);
        f.replies.push_back(vec![vec![0x06, 0xB0, 0, 0]]);
        assert_eq!(read1(&mut f, np), Outcome::NoAnswer, "short");
    }

    #[test]
    fn nova_family_and_gamebuds() {
        assert_eq!(nova_reading(0x220E, &[0, 0, 3, 1, 0, 0, 0], 7), Some(at(Level::Steps(Steps::new(3, 4).unwrap()), Charging::Yes)));
        assert_eq!(nova_reading(0x2232, &[0, 0, 0, 64, 0, 0, 0], 7), Some(at(pctl(64), Charging::No)));
        assert_eq!(nova_reading(0x2232, &[0, 2, 0, 64, 0, 0, 0], 7), Some(unlinked(7)));
        assert_eq!(nova_reading(0x2202, &[0, 0, 2, 1, 0, 0, 0], 7), Some(at(Level::Steps(Steps::new(2, 4).unwrap()), Charging::Yes)));
        assert_eq!(nova_reading(0x22A1, &[0, 0, 58, 3, 0, 0, 0], 7), Some(at(pctl(58), Charging::No)));
        assert_eq!(nova_reading(0x22A1, &[0, 0, 58, 0, 0, 0, 0], 7), Some(unlinked(7)));
        assert_eq!(nova_reading(0x22A1, &[0, 0, 58], 7), None, "short");
        // (GameBuds: left out at 70, right in the case: one part, in use.)
        let Some(Outcome::Read(r)) = nova_reading(GAMEBUDS, &[0, 0, 0, 0x03, 0x01, 70, 20], 7) else { panic!() };
        assert_eq!(r.level, pctl(70));
        assert_eq!(r.parts[0].map(|p| (p.name, p.in_use)), Some((PartName::Left, true)));
        assert!(r.parts[1].is_none() && r.parts[2].is_none());
        let Some(Outcome::Read(r)) = nova_reading(GAMEBUDS, &[0, 0, 0, 0x03, 0x03, 70, 20], 7) else { panic!() };
        assert_eq!(r.level, pctl(20), "the lower bud in use");
        let Some(Outcome::Read(r)) = nova_reading(GAMEBUDS, &[0, 0, 0, 0x01, 0x01, 70, 20], 7) else { panic!() };
        assert_eq!((r.level, r.note), (Level::Unknown, Note::InCase));
        let gb = model("hs-steelseries", GAMEBUDS);
        assert_eq!(gb.kind, Kind::Earbuds);
    }

    #[test]
    fn elite() {
        let m = model("hs-ss-elite", 0x2244);
        let mut f = fake(m);
        let mut r = vec![0u8; 20];
        r[0] = 0x01;
        r[1] = 0xB0;
        r[6] = 66;
        r[14] = 0x00;
        r[15] = 0x02;
        f.replies.push_back(vec![r]);
        assert_eq!(read1(&mut f, m), at(pctl(66), Charging::Yes));
        assert_eq!(f.sent, vec![Q_ELITE.to_vec()]);
        // (The level pushed on the other collection, the power on the first.)
        let rx_m = all_models().find(|x| x.driver == "hs-ss-elite" && x.role == Role::Reply).unwrap();
        let mut main = fake(m);
        main.replies.push_back(vec![vec![0x07, 0xB5, 0, 0, 0x02]]);
        let mut rx = FakeHid::new(ident(rx_m));
        rx.keep_on_flush = true;
        rx.stream.push_back(vec![0x07, 0xB7, 40, 0, 0]);
        let a = crate::mice::read(&mut Chans { main: &mut main, reply: Some(&mut rx), long: None }, m, None, true, soon(), 7);
        assert_eq!(a.out, at(pctl(40), Charging::Yes), "on the cable: charging");
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x07, 0xB5, 0, 0, 0x01]]);
        assert_eq!(read1(&mut f, m), unlinked(7), "headset off");
        let mut s = EliteSeen::default();
        elite_take(&mut s, &[0x07, 0xB7, 101, 0, 2]);
        assert_eq!(s, EliteSeen::default(), "over 100: nothing");
    }
}
