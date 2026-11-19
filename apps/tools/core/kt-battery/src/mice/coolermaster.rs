// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Cooler Master MM712 (cable 0169) and MM731 (cable 0167) and their
// shared dongle (2516:01B7).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/coolermaster.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its references: syntactic-spice/coolermaster-usb-protocol, riVFerd/MM731-Controller.
// Interface 3, FF0A, no report id: 46 81 00 → [47][81][model: 50 MM712, 70 MM731]…[10] percent [11] charging
// [12] link (0 cable, 1 dongle).
// Changed here: the cable and the dongle: one card by the pair rule (the original merged any two of one name).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn c(pid: u16, name: &'static str, via: Via) -> Model {
    Model::new("mk-coolermaster", 0x2516, pid, name, Kind::Mouse, via).iface(3).page(0xFF0A).pair("cm:mm7")
}

pub static MODELS: &[Model] = &[c(0x01B7, "Cooler Master wireless mouse", Via::Receiver), c(0x0169, "Cooler Master MM712", Via::Cable), c(0x0167, "Cooler Master MM731", Via::Cable)];

pub const STATUS: [u8; 4] = [0x00, 0x46, 0x81, 0x00];

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Answer {
    match out_ask(ch, &STATUS, ms(500), deadline, &mut |r| if r.len() >= 13 && r[0] == 0x47 && r[1] == 0x81 { Some(r[..13].to_vec()) } else { None }) {
        Ok(r) => {
            let level = if (1..=100).contains(&r[10]) { pct(i64::from(r[10])).unwrap_or(Level::Unknown) } else { Level::Unknown };
            let mut a: Answer = got(level, charging(r[11] != 0), now).into();
            if m.via == Via::Receiver {
                a.name = match r[2] {
                    0x50 => Some("Cooler Master MM712".to_string()),
                    0x70 => Some("Cooler Master MM731".to_string()),
                    _ => None,
                };
            }
            a
        }
        Err(e) => failed(&e).into(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn mm712() {
        let m = model("mk-coolermaster", 0x01B7);
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x00, 0x47, 0x81, 0x50, 0, 0, 0, 0, 0, 0, 0, 61, 0, 1]]);
        let a = crate::mice::read(&mut Chans::one(&mut f), m, None, true, soon(), 7);
        assert_eq!((a.out, a.name.as_deref()), (at(pctl(61), Charging::No), Some("Cooler Master MM712")));
    }
}
