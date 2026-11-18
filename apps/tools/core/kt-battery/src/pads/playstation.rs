// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Sony DualShock 4, DualSense, DualSense Edge (USB, Bluetooth, the DS4
// USB wireless adaptor).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/playstation.cpp (PollPlayStation) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and
// its contributors, GPL-3.0-or-later. Layout reference there: Linux drivers/hid/hid-playstation.c.
// The battery is part of the input report the pad sends anyway (byte 0 is the report id):
//   DualShock 4: USB report 01, byte 30; Bluetooth report 11, byte 32 — bits 0–3 the level, bit 4 the cable.
//                On battery 0–10 (10 and over: full); on the cable 0–10 charging, 11 charged, 12–15 a fault.
//   DualSense:   USB report 01, byte 53; Bluetooth report 31, byte 54 — bits 0–3 the level 0–10, bits 4–7 the state
//                (0 on battery, 1 charging, 2 charged; A, B, F faults).
//   The adaptor (054C:0BA0) sends 0 there while no pad is linked to it.
// Changed here: the level stays the pad's 0–10 steps (the original showed level × 10 + 5 %); a fault state is no
// level (the original showed one); the Bluetooth feature report 05 the original read is NOT sent — reading it switches
// the pad from its reduced report (01, no battery) to the full one, a mode change. Over Bluetooth the pad is read when
// a game or Steam has already switched it; else «needs a query we do not send». Never written to.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::{Link, Model, Parsed};
use crate::model::{Charging, Level, Steps};
use std::time::Duration;

const fn pad(pid: u16, name: &'static str, link: Link) -> Model {
    let mut m = Model::new("playstation", 0x054C, pid, 0x01, &[0x05], name, "pad", link);
    m.min_in = 10;
    m.mode_bound = true;
    m
}

pub static MODELS: &[Model] = &[
    pad(0x05C4, "DualShock 4", Link::Pad),
    pad(0x09CC, "DualShock 4", Link::Pad),
    pad(0x0BA0, "DualShock 4 USB Wireless Adaptor", Link::Receiver),
    pad(0x0CE6, "DualSense", Link::Pad),
    pad(0x0DF2, "DualSense Edge", Link::Pad),
];

/// How long to listen (the pads send a report every few milliseconds while on).
pub const WINDOW: Duration = Duration::from_millis(600);

fn is_ds4(pid: u16) -> bool {
    matches!(pid, 0x05C4 | 0x09CC | 0x0BA0)
}

fn steps(n: u8) -> Level {
    Steps::new(i64::from(n), 10).map_or(Level::Unknown, Level::Steps)
}

/// One report (payload: byte 0 the report id). `bluetooth`: report 01 is then the reduced one, without the battery.
pub fn parse(m: &Model, bluetooth: bool, r: &[u8]) -> Parsed {
    let Some(&id) = r.first() else { return Parsed::Skip };
    if is_ds4(m.pid) {
        let at = match id {
            0x01 if !bluetooth => 30,
            0x11 => 32,
            _ => return Parsed::Skip,
        };
        let Some(&b) = r.get(at) else { return Parsed::Bad };
        if m.pid == 0x0BA0 && b == 0 {
            return Parsed::NoPad;
        }
        let level = b & 0x0F;
        let cable = b & 0x10 != 0;
        if cable {
            match level {
                0..=10 => Parsed::Got(steps(level), Charging::Yes),
                11 => Parsed::Got(steps(10), Charging::No),
                _ => Parsed::Got(Level::Unknown, Charging::Unknown),
            }
        } else {
            match level {
                0..=10 => Parsed::Got(steps(level), Charging::No),
                _ => Parsed::Bad,
            }
        }
    } else {
        let at = match id {
            0x01 if !bluetooth => 53,
            0x31 => 54,
            _ => return Parsed::Skip,
        };
        let Some(&b) = r.get(at) else { return Parsed::Bad };
        let level = (b & 0x0F).min(10);
        match b >> 4 {
            0x0 => Parsed::Got(steps(level), Charging::No),
            0x1 => Parsed::Got(steps(level), Charging::Yes),
            0x2 => Parsed::Got(steps(10), Charging::No),
            // (Voltage, temperature or charging fault: the pad cannot tell its level.)
            _ => Parsed::Got(Level::Unknown, Charging::Unknown),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::super::{read, Model};
    use super::*;
    use crate::model::{Note, Reading};
    use crate::sched::Outcome;

    fn m(pid: u16) -> &'static Model {
        MODELS.iter().find(|m| m.pid == pid).unwrap()
    }
    fn st(n: i64) -> Level {
        Level::Steps(Steps::new(n, 10).unwrap())
    }

    #[test]
    fn dualshock4_usb_and_bluetooth() {
        // (USB report 01, 64 bytes: byte 30 = 0x07 → 7 of 10 on battery; 0x15 → cable, 5, charging; 0x1B → charged.)
        let ds4 = m(0x05C4);
        assert_eq!(parse(ds4, false, &report(0x01, 64, &[(30, 0x07)])), Parsed::Got(st(7), Charging::No));
        assert_eq!(parse(ds4, false, &report(0x01, 64, &[(30, 0x15)])), Parsed::Got(st(5), Charging::Yes));
        assert_eq!(parse(ds4, false, &report(0x01, 64, &[(30, 0x1B)])), Parsed::Got(st(10), Charging::No));
        assert_eq!(parse(ds4, false, &report(0x01, 64, &[(30, 0x1E)])), Parsed::Got(Level::Unknown, Charging::Unknown), "a charging fault");
        assert_eq!(parse(ds4, false, &report(0x01, 64, &[(30, 0x0C)])), Parsed::Bad, "12 on battery: not a level");
        // (Bluetooth report 11, 78 bytes: byte 32.)
        assert_eq!(parse(ds4, true, &report(0x11, 78, &[(32, 0x03)])), Parsed::Got(st(3), Charging::No));
        assert_eq!(parse(ds4, true, &report(0x01, 10, &[])), Parsed::Skip, "the reduced Bluetooth report has no battery");
        assert_eq!(parse(ds4, false, &report(0x01, 30, &[])), Parsed::Bad, "short");
        assert_eq!(parse(ds4, false, &[]), Parsed::Skip);
        // (The adaptor with no pad sends 0.)
        assert_eq!(parse(m(0x0BA0), false, &report(0x01, 64, &[])), Parsed::NoPad);
        assert_eq!(parse(m(0x0BA0), false, &report(0x01, 64, &[(30, 0x08)])), Parsed::Got(st(8), Charging::No));
    }

    #[test]
    fn dualsense_usb_and_bluetooth() {
        // (USB report 01: byte 53 = 0x06 → 6 of 10; 0x14 → charging 4; 0x2A → charged; Bluetooth report 31, byte 54.)
        let ds = m(0x0CE6);
        assert_eq!(parse(ds, false, &report(0x01, 64, &[(53, 0x06)])), Parsed::Got(st(6), Charging::No));
        assert_eq!(parse(ds, false, &report(0x01, 64, &[(53, 0x14)])), Parsed::Got(st(4), Charging::Yes));
        assert_eq!(parse(ds, false, &report(0x01, 64, &[(53, 0x2A)])), Parsed::Got(st(10), Charging::No));
        assert_eq!(parse(ds, false, &report(0x01, 64, &[(53, 0x0F)])), Parsed::Got(st(10), Charging::No), "over 10: the top of the scale");
        assert_eq!(parse(ds, false, &report(0x01, 64, &[(53, 0xA5)])), Parsed::Got(Level::Unknown, Charging::Unknown), "a voltage fault");
        assert_eq!(parse(ds, true, &report(0x31, 78, &[(54, 0x02)])), Parsed::Got(st(2), Charging::No));
        assert_eq!(parse(ds, true, &report(0x01, 10, &[])), Parsed::Skip);
        assert_eq!(parse(ds, true, &report(0x31, 54, &[])), Parsed::Bad, "short");
        assert_eq!(parse(m(0x0DF2), false, &report(0x01, 64, &[(53, 0x19)])), Parsed::Got(st(9), Charging::Yes), "Edge: the same report");
    }

    #[test]
    fn through_the_listener() {
        // (A Bluetooth pad still in its reduced mode: «needs a query we do not send», and nothing was sent.)
        let ds = m(0x0CE6);
        let mut f = fake(ds);
        f.stream.extend([report(0x01, 10, &[]), report(0x01, 10, &[])]);
        assert_eq!(read(&mut f, ds, true, true, soon(), 5), Outcome::Read(Reading::unknown(Note::NeedsQuery, Charging::Unknown, 5)));
        assert!(f.sent.is_empty());
        // (Switched by a game: read.)
        let mut f = fake(ds);
        f.stream.extend([report(0x01, 10, &[]), report(0x31, 78, &[(54, 0x17)])]);
        assert_eq!(read(&mut f, ds, true, false, soon(), 5), Outcome::Read(Reading::new(st(7), Charging::Yes, 5)));
        // (A malformed report then a good one: the good one.)
        let ds4 = m(0x09CC);
        let mut f = fake(ds4);
        f.stream.extend([report(0x01, 12, &[]), report(0x01, 64, &[(30, 0x04)])]);
        assert_eq!(read(&mut f, ds4, false, false, soon(), 5), Outcome::Read(Reading::new(st(4), Charging::No, 5)));
        assert!(f.sent.is_empty() && f.flushes == 0);
    }
}
