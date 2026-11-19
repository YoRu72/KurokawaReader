// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): NZXT Lift Elite Wireless on its dongle (1E71:2101) or cable (2129).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/nzxt.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its reference: HeyOkay/HaloBattery (nzxt.py, from captures of NZXT CAM 4.76.5).
// FFCA:0001, 64-byte reports: request 4E 02 81 00 B0 (02 the mouse, 81 read a property, B0 telemetry); the dongle
// first acknowledges with 4E E5 (skipped); reply 4E 02 97 …: [17..18] percent LE, [22] bit 0 on the charging cable.
// While NZXT CAM is open the dongle stops answering: no answer, not an old level.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn n(pid: u16, via: Via) -> Model {
    Model::new("mk-nzxt", 0x1E71, pid, "NZXT Lift Elite", Kind::Mouse, via).page(0xFFCA).usage(0x0001).pair("nzxt:lift")
}

pub static MODELS: &[Model] = &[n(0x2129, Via::Cable), n(0x2101, Via::Receiver)];

pub const TELEMETRY: [u8; 6] = [0x00, 0x4E, 0x02, 0x81, 0x00, 0xB0];

pub fn read(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Outcome {
    match out_ask(ch, &TELEMETRY, ms(1500), deadline, &mut |r| if r.len() >= 27 && r[0] == 0x4E && r[1] == 0x02 && r[2] == 0x97 { Some((u16::from(r[17]) | u16::from(r[18]) << 8, r[22])) } else { None }) {
        Ok((p, f)) => match pct(i64::from(p)) {
            Some(l) => got(l, charging(f & 1 != 0), now),
            None => no_level(Charging::Unknown, now),
        },
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn lift() {
        let m = model("mk-nzxt", 0x2101);
        let mut f = fake(m);
        f.replies.push_back(vec![report(0x00, 65, &[(1, 0x4E), (2, 0xE5)]), report(0x00, 65, &[(1, 0x4E), (2, 0x02), (3, 0x97), (18, 0x58), (23, 1)])]);
        assert_eq!(read1(&mut f, m), at(pctl(88), Charging::Yes), "the acknowledgement skipped");
        let mut f = fake(m);
        f.replies.push_back(vec![report(0x00, 65, &[(1, 0x4E), (2, 0x02), (3, 0x97), (18, 0x2C), (19, 0x01)])]);
        assert_eq!(read1(&mut f, m), no_level(Charging::Unknown, 7), "300: refused");
    }
}
