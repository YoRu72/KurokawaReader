// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): CHERRY MX 3.0S Wireless on its dongle (046A:00EA) or cable (00E3).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/cherry.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its reference: B1Chat/BatteryWatch.
// FF1C:0092, 64-byte reports: [04][checksum LE = the sum of bytes 3–63][type][payload]; status query type 1A, payload
// 03 00 00 55; reply [04]…[1A]…[8] percent [9] non-zero while USB powered. Over Bluetooth Windows' own level is used.
// D1 (the original's v1.1.0 akko.cpp at commit 7cc44f2): the Akko V9 Dash Pro on its Telink receiver (38EE:000C, «Akko
// 2.4G Wireless Mouse») speaks the same channel; the same query, the same reply, two tries. (The Cherry XTRFY 1K mouse
// receiver, also in cherry.cpp now, takes the Compx frames: kysona.rs.)
// Changed here: the dongle and the cable: one card by the pair rule.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn c(pid: u16, via: Via) -> Model {
    Model::new("mk-cherry", 0x046A, pid, "CHERRY MX 3.0S Wireless", Kind::Keyboard, via).page(0xFF1C).usage(0x0092).input(Len::Eq(64)).output(Len::Eq(64)).pair("cherry:mx30s")
}

pub static MODELS: &[Model] = &[
    c(0x00E3, Via::Cable),
    c(0x00EA, Via::Receiver),
    Model::new("mk-akko", 0x38EE, 0x000C, "Akko V9 Dash Pro", Kind::Mouse, Via::Receiver).page(0xFF1C).usage(0x0092).input(Len::Eq(64)).output(Len::Eq(64)),
];

pub const QUERY: [u8; 8] = [0x04, 0x72, 0x00, 0x1A, 0x03, 0x00, 0x00, 0x55];

pub fn read(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Outcome {
    let mut last = Err(TErr::Timeout);
    for _ in 0..2 {
        last = out_ask(ch, &QUERY, ms(400), deadline, &mut |r| if r.len() >= 10 && r[0] == 0x04 && r[3] == 0x1A { Some((r[8], r[9])) } else { None });
        if last.is_ok() || last == Err(TErr::Gone) {
            break;
        }
    }
    match last {
        Ok((p, u)) if p <= 100 => got(pct(i64::from(p)).unwrap_or(Level::Unknown), charging(u != 0), now),
        Ok(_) => dozing(now),
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn cherry() {
        assert_eq!(u16::from(QUERY[1]) | u16::from(QUERY[2]) << 8, QUERY[3..].iter().map(|&b| u16::from(b)).sum::<u16>());
        let m = model("mk-cherry", 0x00EA);
        let mut f = fake(m);
        f.replies.push_back(vec![report(0x04, 64, &[(3, 0x1A), (8, 93), (9, 0)])]);
        assert_eq!(read1(&mut f, m), at(pctl(93), Charging::No));
        let mut f = fake(m);
        f.replies.push_back(vec![report(0x04, 64, &[(3, 0x1A), (8, 0xFF)])]);
        assert_eq!(read1(&mut f, m), dozing(7));
        // (Akko: the same query.)
        let a = model("mk-akko", 0x000C);
        let mut f = fake(a);
        f.replies.extend([vec![], vec![report(0x04, 64, &[(3, 0x1A), (8, 41), (9, 1)])]]);
        assert_eq!(read1(&mut f, a), at(pctl(41), Charging::Yes), "answered on the second try");
        assert_eq!(f.sent, vec![QUERY.to_vec(), QUERY.to_vec()]);
    }
}
