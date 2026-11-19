// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the Fractal Design Scape headset (VID 36BC).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/fractal.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its reference: Fractal's own WebHID configurator, Adjust Pro.
//   Dongle 0001 or the headset on its USB-C cable 2001, FF00:0001: output [02][type][21 GET_DEVICE_STATE] to type 11
//   (the dongle: [4] 1 = a headset linked) or F1 (the headset: [15] percent, [23] 1 on its cable — charging).
// Changed here: matched by these two products only (the original listed every 36BC product first); the dongle and the
// cable one card by the pair rule.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::mice::*;
use crate::model::{Charging, Kind, Level};
use crate::sched::Outcome;
use std::time::Instant;

const fn f(pid: u16, via: Via) -> Model {
    Model::new("hs-fractal", 0x36BC, pid, "Fractal Design Scape", Kind::Headset, via).page(0xFF00).usage(0x0001).output(Len::Min(4)).input(Len::Min(24)).pair("fractal:scape")
}
pub static MODELS: &[Model] = &[f(0x0001, Via::Receiver), f(0x2001, Via::Cable)];

pub const Q_DONGLE: [u8; 3] = [0x02, 0x11, 0x21];
pub const Q_HEADSET: [u8; 3] = [0x02, 0xF1, 0x21];

fn of(t: u8) -> impl FnMut(&[u8]) -> Option<Vec<u8>> {
    move |r: &[u8]| if r.len() >= 24 && r[0] == 0x02 && r[1] == t && r[2] == 0x21 { Some(r.to_vec()) } else { None }
}

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    if m.via == Via::Receiver {
        let mut fd = of(0x11);
        match out_ask(ch, &Q_DONGLE, ms(1000), deadline, &mut fd) {
            Ok(r) if r[4] != 1 => return unlinked(now),
            Ok(_) => {}
            Err(e) => return failed(&e),
        }
    }
    let mut fh = of(0xF1);
    match out_ask(ch, &Q_HEADSET, ms(1000), deadline, &mut fh) {
        Ok(r) if r[15] <= 100 => got(pct(i64::from(r[15])).unwrap_or(Level::Unknown), charging(r[23] == 1), now),
        Ok(_) => no_level(Charging::Unknown, now),
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use crate::mice::testkit::*;
    use super::*;

    #[test]
    fn scape() {
        let m = model("hs-fractal", 0x0001);
        let mut d = vec![0u8; 24];
        d[..3].copy_from_slice(&[0x02, 0x11, 0x21]);
        d[4] = 1;
        let mut h = vec![0u8; 24];
        h[..3].copy_from_slice(&[0x02, 0xF1, 0x21]);
        h[15] = 88;
        let mut f = fake(m);
        f.replies.extend([vec![d.clone()], vec![h.clone()]]);
        assert_eq!(read1(&mut f, m), at(pctl(88), Charging::No));
        assert_eq!(f.sent, vec![Q_DONGLE.to_vec(), Q_HEADSET.to_vec()]);
        d[4] = 0;
        let mut f = fake(m);
        f.replies.push_back(vec![d]);
        assert_eq!(read1(&mut f, m), unlinked(7));
        let c = model("hs-fractal", 0x2001);
        h[23] = 1;
        let mut f = fake(c);
        f.replies.push_back(vec![h]);
        assert_eq!(read1(&mut f, c), at(pctl(88), Charging::Yes));
        assert_eq!(f.sent, vec![Q_HEADSET.to_vec()], "on the cable: the headset itself");
    }
}
