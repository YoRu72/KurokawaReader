// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Ninjutso Sora V2 (1915:AE1C receiver, AE11 cable), Ten / Ten Air
// (093A:EB01 receiver, E020 cable), and the Sprime PM1 (1915: AC11–AC13 cable, AC1C / AD8C receivers), which takes the
// Sora V2's request.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/ninjutso.cpp (QueryTen, PollTen, PollNinjutso) and sprime.cpp at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later. Their references:
// NinjaForce's bundle (createSorav2.readState), DrStopor/ninjutso-battery-tray, Sprime's web driver (sprime.pro).
//  - Sora V2 / Sprime: FFA0:0001, feature report 05 [05][15][00][00][01] (32 bytes); read back: [9] percent (Sora V2:
//    0 means 100), [10] charging, [11] fully charged (Sprime), [12] online. On the cable [12] reads 0: linked.
//  - Ten: FF01:0001, feature report 06 (16 bytes) [06][cmd][00][00][01]; 13 online, 12 percent, 11 charging, the value
//    at byte 8.
// Changed here: the Sprime bootloader (AC0B) never in the table (as the original); nothing else.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn sora(driver: &'static str, pid: u16, name: &'static str, via: Via, pair: &'static str) -> Model {
    Model::new(driver, 0x1915, pid, name, Kind::Mouse, via).page(0xFFA0).usage(0x0001).feature(Len::Min(32)).pair(pair)
}
const fn ten(pid: u16, via: Via) -> Model {
    Model::new("mk-ninjutso-ten", 0x093A, pid, "Ninjutso Ten / Ten Air", Kind::Mouse, via).page(0xFF01).usage(0x0001).feature(Len::Eq(16)).product_name().pair("nj:ten")
}

pub static MODELS: &[Model] = &[
    sora("mk-ninjutso-sora", 0xAE1C, "Ninjutso Sora V2", Via::Receiver, "nj:sora"),
    sora("mk-ninjutso-sora", 0xAE11, "Ninjutso Sora V2", Via::Cable, "nj:sora"),
    ten(0xEB01, Via::Receiver),
    ten(0xE020, Via::Cable),
    sora("mk-sprime", 0xAC11, "Sprime PM1", Via::Cable, ""),
    sora("mk-sprime", 0xAC12, "Sprime PM1", Via::Cable, ""),
    sora("mk-sprime", 0xAC13, "Sprime PM1", Via::Cable, ""),
    sora("mk-sprime", 0xAC1C, "Sprime PM1", Via::Receiver, ""),
    sora("mk-sprime", 0xAD8C, "Sprime PM1", Via::Receiver, ""),
];

pub const SORA: [u8; 5] = [0x05, 0x15, 0x00, 0x00, 0x01];
pub const fn ten_cmd(cmd: u8) -> [u8; 5] {
    [0x06, cmd, 0x00, 0x00, 0x01]
}
pub const TEN_ONLINE: [u8; 5] = ten_cmd(0x13);
pub const TEN_PERCENT: [u8; 5] = ten_cmd(0x12);
pub const TEN_CHARGING: [u8; 5] = ten_cmd(0x11);

pub fn read_sora(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    let cable = m.via == Via::Cable;
    let sprime = m.driver == "mk-sprime";
    let mut answered = None;
    for attempt in 0..4 {
        if attempt > 0 {
            pause(Duration::from_millis(90), deadline);
        }
        match feat_ask(&mut *ch.main, &SORA, 0x05, 32, ms(15), 1, deadline, &mut |r| if r.len() >= 13 && r[0] == 0x05 && r[1] == 0x15 && r[9] <= 100 { Some(r[..13].to_vec()) } else { None }) {
            Ok(r) => {
                let linked = cable || r[12] != 0;
                answered = Some(r.clone());
                if linked {
                    break;
                }
            }
            Err(TErr::Gone) => return Outcome::Failed,
            Err(TErr::Timeout) => break,
            Err(_) => {}
        }
    }
    let Some(r) = answered else { return Outcome::NoAnswer };
    if !(cable || r[12] != 0) {
        return unlinked(now);
    }
    if sprime {
        let full = r[11] != 0;
        let level = if full { pct(100) } else { pct(i64::from(r[9])) };
        return got(level.unwrap_or(Level::Unknown), charging(r[10] != 0 && !full), now);
    }
    let level = if r[9] == 0 { pct(100) } else { pct(i64::from(r[9])) };
    got(level.unwrap_or(Level::Unknown), charging(r[10] != 0), now)
}

fn ten_query(t: &mut dyn HidTransport, req: &[u8; 5], deadline: Instant) -> Result<u8, TErr> {
    feat_ask(t, req, 0x06, 16, ms(30), 3, deadline, &mut |r| if r.len() == 16 && r[0] == 0x06 && r[1] == req[1] { Some(r[8]) } else { None })
}

pub fn read_ten(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Outcome {
    match ten_query(&mut *ch.main, &TEN_ONLINE, deadline) {
        Ok(1) => {}
        Ok(_) => return unlinked(now),
        Err(e) => return failed(&e),
    }
    let p = match ten_query(&mut *ch.main, &TEN_PERCENT, deadline) {
        Ok(p) if p <= 100 => p,
        Ok(_) => return no_level(Charging::Unknown, now),
        Err(e) => return failed(&e),
    };
    let c = ten_query(&mut *ch.main, &TEN_CHARGING, deadline).map_or(Charging::Unknown, |c| charging(c != 0));
    got(pct(i64::from(p)).unwrap_or(Level::Unknown), c, now)
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn sora_sprime_ten() {
        let m = model("mk-ninjutso-sora", 0xAE1C);
        let mut f = fake(m);
        f.feature_replies.push_back(report(0x05, 32, &[(1, 0x15), (9, 0), (10, 0), (12, 1)]));
        assert_eq!(read1(&mut f, m), at(pctl(100), Charging::No), "0 means 100 %");
        let mut f = fake(m);
        f.features.insert(0x05, report(0x05, 32, &[(1, 0x15), (9, 40), (12, 0)]));
        assert_eq!(read1(&mut f, m), unlinked(7));
        assert_eq!(f.sent.len(), 4, "asked again while not linked, four times at most");
        let s = model("mk-sprime", 0xAC1C);
        let mut f = fake(s);
        f.feature_replies.push_back(report(0x05, 32, &[(1, 0x15), (9, 97), (10, 1), (11, 1), (12, 1)]));
        assert_eq!(read1(&mut f, s), at(pctl(100), Charging::No), "fully charged");
        let t = model("mk-ninjutso-ten", 0xEB01);
        let mut f = fake(t);
        f.feature_replies.extend([report(0x06, 16, &[(1, 0x13), (8, 1)]), report(0x06, 16, &[(1, 0x12), (8, 63)]), report(0x06, 16, &[(1, 0x11), (8, 1)])]);
        assert_eq!(read1(&mut f, t), at(pctl(63), Charging::Yes));
        assert_eq!(f.sent, vec![TEN_ONLINE.to_vec(), TEN_PERCENT.to_vec(), TEN_CHARGING.to_vec()]);
        let mut f = fake(t);
        f.feature_replies.push_back(report(0x06, 16, &[(1, 0x13), (8, 0)]));
        assert_eq!(read1(&mut f, t), unlinked(7));
    }
}
