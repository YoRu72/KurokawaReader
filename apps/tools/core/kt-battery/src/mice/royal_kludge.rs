// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Royal Kludge MG6 Pro (VID 2E3C, «QiWang» protocol).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/royal_kludge.cpp (PollMg6) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its
// contributors, GPL-3.0-or-later. Its reference: RK's web driver (drive.rkgaming.com, getDeviceBattery).
// Output report 0, 64 bytes: [01 forwarded to the mouse][01 system control][02 get battery voltage][01 read]; reply
// with the same three bytes, [3] bit 4 = the mouse answered, [4..5] mV, [6..7] percent, [10] USB plugged in.
// Dongle 00A6 / 00E6 (FF00:0001), cable 00A5 / 00E5 (FFF2:0001).
// Changed here: the dongle's «the mouse did not answer» as asleep (as the original); the mV not shown.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn rk(pid: u16, via: Via) -> Model {
    let page = if matches!(via, Via::Cable) { 0xFFF2 } else { 0xFF00 };
    Model::new("mk-rk", 0x2E3C, pid, "RK MG6 Pro", Kind::Mouse, via).page(page).usage(0x0001).input(Len::Eq(65)).output(Len::Eq(65))
}

pub static MODELS: &[Model] = &[rk(0x00A6, Via::Receiver), rk(0x00E6, Via::Receiver), rk(0x00A5, Via::Cable), rk(0x00E5, Via::Cable)];

pub const BATTERY: [u8; 5] = [0x00, 0x01, 0x01, 0x02, 0x01];

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    let cable = m.via == Via::Cable;
    let mut answered = false;
    for attempt in 0..3 {
        if attempt > 0 {
            pause(Duration::from_millis(100), deadline);
        }
        match out_ask(ch, &BATTERY, ms(600), deadline, &mut |r| if r.len() >= 11 && r[0] & 0x1F == 0x01 && r[1] & 0x0F == 0x01 && r[2] == 0x02 { Some(r[..11].to_vec()) } else { None }) {
            Ok(r) => {
                answered = true;
                if (r[3] >> 4) & 1 == 0 {
                    continue;
                }
                let p = u16::from(r[6]) | u16::from(r[7]) << 8;
                return match pct(i64::from(p)) {
                    Some(l) => got(l, charging(r[10] != 0 || cable), now),
                    None => no_level(Charging::Unknown, now),
                };
            }
            Err(TErr::Gone) => return Outcome::Failed,
            Err(_) => {}
        }
    }
    if answered {
        dozing(now)
    } else {
        Outcome::NoAnswer
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn mg6() {
        let m = model("mk-rk", 0x00A6);
        let mut f = fake(m);
        f.replies.push_back(vec![report(0x00, 65, &[(1, 0x01), (2, 0x01), (3, 0x02), (4, 0x11), (7, 76), (11, 0)])]);
        assert_eq!(read1(&mut f, m), at(pctl(76), Charging::No));
        let mut f = fake(m);
        f.replies.extend((0..3).map(|_| vec![report(0x00, 65, &[(1, 0x01), (2, 0x01), (3, 0x02), (4, 0x01)])]));
        assert_eq!(read1(&mut f, m), dozing(7), "the mouse did not answer");
        assert_eq!(f.sent, vec![BATTERY.to_vec(); 3]);
    }
}
