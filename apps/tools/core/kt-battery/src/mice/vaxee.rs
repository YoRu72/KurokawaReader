// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): VAXEE 4K / 8K receivers and the ZYGEN NP-01S V2 cable (VID 3057).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/vaxee.cpp (Query, PollVaxee) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its
// contributors, GPL-3.0-or-later. Its reference: stuffz/mouse-battery-monitor, docs/VAXEE.md.
// Vendor collection FF05:0001, 64-byte feature report 0E: [0E][A5][cmd][01 = READ][01]; read back: [0E][A5][cmd][..]
// [1][value]. 0B battery 0–20, 10 charging.
// Changed here: the battery as its own 0–20 steps (the original: × 5 %); nothing kept across rounds (the original's
// lastGood map).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn v(pid: u16, name: &'static str, via: Via) -> Model {
    Model::new("mk-vaxee", 0x3057, pid, name, Kind::Mouse, via).page(0xFF05).usage(0x0001).feature(Len::Eq(64))
}

pub static MODELS: &[Model] = &[v(0x1002, "VAXEE wireless mouse", Via::Receiver), v(0x2002, "VAXEE 8K Wireless", Via::Receiver), v(0x1011, "ZYGEN NP-01S V2 Wireless", Via::Cable)];

pub const BATTERY: [u8; 5] = [0x0E, 0xA5, 0x0B, 0x01, 0x01];
pub const CHARGING: [u8; 5] = [0x0E, 0xA5, 0x10, 0x01, 0x01];

fn query(t: &mut dyn HidTransport, req: &[u8; 5], deadline: Instant) -> Result<u8, TErr> {
    feat_ask(t, req, 0x0E, 64, ms(100), 1, deadline, &mut |r| if r.len() >= 6 && r[0] == 0x0E && r[1] == 0xA5 && r[2] == req[2] && r[4] == 1 { Some(r[5]) } else { None })
}

pub fn read(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Outcome {
    let mut last = Err(TErr::BadReply);
    for _ in 0..2 {
        last = query(&mut *ch.main, &BATTERY, deadline);
        if matches!(last, Ok(b) if b <= 20) || matches!(last, Err(TErr::Gone)) {
            break;
        }
    }
    match last {
        Ok(b) if b <= 20 => {
            let c = query(&mut *ch.main, &CHARGING, deadline).map_or(Charging::Unknown, |c| charging(c != 0));
            got(steps(i64::from(b), 20).unwrap_or(Level::Unknown), c, now)
        }
        Ok(_) => no_level(Charging::Unknown, now),
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn vaxee() {
        let m = model("mk-vaxee", 0x2002);
        let mut f = fake(m);
        f.feature_replies.extend([report(0x0E, 64, &[(1, 0xA5), (2, 0x0B), (4, 1), (5, 17)]), report(0x0E, 64, &[(1, 0xA5), (2, 0x10), (4, 1), (5, 0)])]);
        assert_eq!(read1(&mut f, m), at(steps(17, 20).unwrap(), Charging::No));
        assert_eq!(f.sent, vec![BATTERY.to_vec(), CHARGING.to_vec()]);
        let mut f = fake(m);
        f.feature_replies.extend([report(0x0E, 64, &[(1, 0xA5), (2, 0x0B), (4, 1), (5, 21)]), report(0x0E, 64, &[(1, 0xA5), (2, 0x0B), (4, 1), (5, 21)])]);
        assert_eq!(read1(&mut f, m), no_level(Charging::Unknown, 7), "21 of 20: no reading");
    }
}
