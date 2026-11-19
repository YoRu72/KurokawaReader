// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Machenike L7 Arctic / L7 Mix (248A: receiver FF4C, cable FF4E).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/machenike.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later (from the official L7 Mix app's DeviceDriver.exe; docs/machenike.md there).
// Page 8C usage 1 (interface 1 on the receiver, 2 on the cable), its product string «L7 Mix»; feature report 51,
// command 06, sent and read as 21 bytes (not the collection's longest, 1001): [4..7] 8A 24 4E FF, [10] link
// (low 3 bits 0 cable / 1 receiver, bit 3 the wireless link), [11] percent (0 is 0 %), [12] charging.
// Changed here: the cable and the receiver: one card by the pair rule.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn m(pid: u16, via: Via, iface: i32) -> Model {
    Model::new("mk-machenike", 0x248A, pid, "Machenike L7 Arctic / L7 Mix", Kind::Mouse, via).iface(iface).page(0x008C).usage(0x0001).input(Len::Eq(33)).output(Len::Eq(33)).feature(Len::Eq(1001)).product_is("L7 Mix").feat_len(21).pair("mn:l7")
}

pub static MODELS: &[Model] = &[m(0xFF4E, Via::Cable, 2), m(0xFF4C, Via::Receiver, 1)];

pub const STATUS: [u8; 2] = [0x51, 0x06];

pub fn read(ch: &mut Chans, model: &Model, deadline: Instant, now: u64) -> Outcome {
    let cable = model.via == Via::Cable;
    let r = feat_ask(&mut *ch.main, &STATUS, 0x51, 21, ms(10), 20, deadline, &mut |r| {
        if r.len() != 21 || r[0] != 0x51 || r[1] != 0x06 || r[4..8] != [0x8A, 0x24, 0x4E, 0xFF] || r[10] & 7 != if cable { 0 } else { 1 } {
            return None;
        }
        Some(r.to_vec())
    });
    match r {
        Ok(r) => {
            let linked = cable || r[10] & 8 != 0;
            if !linked {
                return unlinked(now);
            }
            if r[11] > 100 || r[12] > 1 {
                return no_level(Charging::Unknown, now);
            }
            got(pct(i64::from(r[11])).unwrap_or(Level::Unknown), charging(r[12] == 1), now)
        }
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn l7() {
        let rx = model("mk-machenike", 0xFF4C);
        assert!(rx.product_ok("L7 Mix") && !rx.product_ok("Delux receiver"));
        let mut f = fake(rx);
        f.feature_replies.push_back(report(0x51, 21, &[(1, 0x06), (4, 0x8A), (5, 0x24), (6, 0x4E), (7, 0xFF), (10, 0x09), (11, 0), (12, 0)]));
        assert_eq!(read1(&mut f, rx), at(pctl(0), Charging::No), "0 % is a level here");
        let mut f = fake(rx);
        f.feature_replies.push_back(report(0x51, 21, &[(1, 0x06), (4, 0x8A), (5, 0x24), (6, 0x4E), (7, 0xFF), (10, 0x01), (11, 50)]));
        assert_eq!(read1(&mut f, rx), unlinked(7));
        let mut f = fake(rx);
        f.feature_replies.push_back(report(0x51, 21, &[(1, 0x06), (4, 0x8A), (5, 0x24), (6, 0x4E), (7, 0xFF), (10, 0x00), (11, 50)]));
        assert_eq!(read1(&mut f, rx), Outcome::NoAnswer, "a cable's status on the receiver: not this one");
    }
}
