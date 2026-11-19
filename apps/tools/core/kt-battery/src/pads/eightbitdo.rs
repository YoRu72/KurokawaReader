// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): 8BitDo controllers.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/eightbitdo.cpp (Poll8BitDo, PollDInputGamepad, PollVendorCollection, QueryVendor) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later.
// An 8BitDo pad shows up in one of three ways, by its mode switch:
//  - Switch mode: as a Switch Pro Controller (057E:2009) — nintendo.rs reads it.
//  - X-input mode: as a wired Xbox 360 pad (XInput has no battery for it); the Ultimate 2 Wireless's receiver
//    (2DC8:310B, 6013 idle) and its cable (6012) also have a vendor collection (page FF7A, usage 1, 64-byte reports)
//    that answers status requests (output report 81, input report 02; protocol reference there:
//    MiguelSanzBr/8bitdo-ultimate2-linux, docs/PROTOCOL.md):
//        81 04 20 01             → 02 04 04 00 20 01 …, byte 18 = 1 while a pad is linked
//        81 04 21 01 00 00 06    → 02 04 04 00 21 01 …, byte 18 = bits 0–6 the percentage (1–100), bit 7 charging
//        81 04 00 01             → 02 04 04 00 00 01 …, bytes 22–23 the internal product (6013 / 3109 the receiver
//                                  itself, else the pad on its cable)
//    These three only ask: nothing is set, switched or stored. Sent only once the user turned 8BitDo's reading on.
//  - D-input / Bluetooth: a gamepad collection (page 1, usage 4 or 5) whose report 01 or 04 has byte 14: bits 0–6 the
//    percentage, bit 7 charging (SDL's SDL_hidapi_8bitdo.c, HandleStatePacket). Read by listening.
// Changed here: the vendor requests go to the three products the protocol document is about, never to every 2DC8
// product as the original did (its Ultimate 2.4G 3109, other receivers, a page FFA0 collection: not documented, not
// asked); the feature report 06 the original read from the Pro 2 / Pro 3 / SN30 Pro / SF30 Pro is NOT read — it turns
// on SDL's report format (a mode change); for those the battery is taken from report 04 only once something else has
// turned it on, else «needs a query we do not send» (their report 01's byte 14 is not documented as the battery); a
// docked or unlinked Ultimate 2 says «no controller linked», never its last level as current (the original kept it in
// a global for 30 minutes); no level is made up for the pad on its cable (the original repeated the last one).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::{ask, Link, Model, Parsed};
use crate::model::{Charging, Level, Note, Percent, Reading};
use crate::sched::Outcome;
use crate::transport::{HidTransport, TErr};
use std::time::{Duration, Instant};

/// (pid, name, picture, needs SDL's report — feature 06 in the original)
const fn dinput(pid: u16, name: &'static str, picture: &'static str, sdl_report: bool) -> Model {
    let mut m = Model::new("8bitdo", 0x2DC8, pid, 0x01, &[0x04, 0x05], name, picture, Link::Pad);
    m.min_in = 15;
    m.mode_bound = sdl_report;
    m
}

pub static MODELS: &[Model] = &[
    {
        let mut m = dinput(0x6012, "8BitDo Ultimate 2", "pad", false);
        m.min_in = 34;
        m.group = "8bitdo:ultimate2";
        m
    },
    dinput(0x202F, "8BitDo Ultimate 3-mode", "pad", false),
    dinput(0x202E, "8BitDo Ultimate 3-mode", "pad", false),
    dinput(0x301B, "8BitDo Ultimate 2C Wireless", "pad", false),
    dinput(0x301A, "8BitDo Ultimate 2C Wireless", "pad", false),
    dinput(0x310A, "8BitDo Ultimate 2C Wireless", "pad", false),
    dinput(0x3012, "8BitDo Ultimate 2.4G", "pad", false),
    dinput(0x3013, "8BitDo Ultimate 2.4G", "pad", false),
    dinput(0x6007, "8BitDo Ultimate Bluetooth", "pad", false),
    dinput(0x6009, "8BitDo Pro 3", "pad", true),
    dinput(0x6003, "8BitDo Pro 2", "pad", true),
    dinput(0x6006, "8BitDo Pro 2", "pad", true),
    dinput(0x6001, "8BitDo SN30 Pro", "retro", true),
    dinput(0x6101, "8BitDo SN30 Pro", "retro", true),
    dinput(0x6000, "8BitDo SF30 Pro", "retro", true),
    dinput(0x6100, "8BitDo SF30 Pro", "retro", true),
];

const fn rx(pid: u16, name: &'static str, link: Link) -> Model {
    let mut m = Model::new("8bitdo-rx", 0x2DC8, pid, 0xFF7A, &[0x01], name, "pad", link);
    m.min_in = 64;
    m.min_out = 64;
    m.group = "8bitdo:ultimate2";
    m
}

/// The vendor collection of the Ultimate 2 Wireless (receiver in X-input mode, receiver idle, the pad on its cable).
pub static RX_MODELS: &[Model] = &[rx(0x310B, "8BitDo Ultimate 2 Wireless", Link::Receiver), rx(0x6013, "8BitDo Ultimate 2 Wireless", Link::Receiver), rx(0x6012, "8BitDo Ultimate 2", Link::Pad)];

/// The three requests (allow.rs lists each, for each of RX_MODELS' products, with this page and usage).
pub const LINK: [u8; 4] = [0x81, 0x04, 0x20, 0x01];
pub const BATTERY: [u8; 7] = [0x81, 0x04, 0x21, 0x01, 0x00, 0x00, 0x06];
pub const INFO: [u8; 4] = [0x81, 0x04, 0x00, 0x01];

pub const WINDOW: Duration = Duration::from_millis(800);
const STEP: Duration = Duration::from_millis(300);

/// D-input report (payload, byte 0 the report id).
pub fn parse_dinput(m: &Model, r: &[u8]) -> Parsed {
    let ok_id = match r.first() {
        Some(0x04) => true,
        Some(0x01) => !m.mode_bound,
        _ => false,
    };
    if !ok_id {
        return Parsed::Skip;
    }
    // (The Ultimate 2's firmware 1.02 sends 12-byte reports without the battery: short is no reading.)
    if r.len() < m.min_in.max(15) {
        return Parsed::Bad;
    }
    percent_byte(r[14])
}

fn percent_byte(b: u8) -> Parsed {
    let Some(p) = Percent::new(i64::from(b & 0x7F)) else { return Parsed::Bad };
    let ch = if b & 0x80 != 0 && p.get() < 100 { Charging::Yes } else { Charging::No };
    Parsed::Got(Level::Exact(p), ch)
}

fn reply_to(cmd: [u8; 2], min: usize) -> impl Fn(&[u8]) -> bool {
    move |r: &[u8]| r.len() >= min && r[0] == 0x02 && r[1] == 0x04 && r[4] == cmd[0] && r[5] == cmd[1]
}

/// The vendor collection's three requests, as the original's order: linked? → battery → which product answers.
pub fn query(t: &mut dyn HidTransport, deadline: Instant, now: u64) -> Outcome {
    let mut gone = false;
    let mut step = |t: &mut dyn HidTransport, bytes: &[u8], cmd: [u8; 2], min: usize| -> Option<Vec<u8>> {
        match ask(t, bytes, deadline, STEP, &reply_to(cmd, min)) {
            Ok(r) => Some(r),
            Err(TErr::Gone) => {
                gone = true;
                None
            }
            Err(_) => None,
        }
    };
    let linked = step(t, &LINK, [0x20, 0x01], 19).map(|r| r[18] != 0);
    if linked != Some(false) {
        if let Some(r) = step(t, &BATTERY, [0x21, 0x01], 19) {
            // (0 is no reading: the original took 1–100 only.)
            if let Parsed::Got(l, c) = percent_byte(r[18]) {
                if matches!(l, Level::Exact(p) if p.get() > 0) {
                    return Outcome::Read(Reading::new(l, c, now));
                }
            }
        }
    }
    if let Some(r) = step(t, &INFO, [0x00, 0x01], 24) {
        let internal = u16::from(r[22]) | u16::from(r[23]) << 8;
        if internal != 0x6013 && internal != 0x3109 {
            // (The pad on its cable: charging; its level is not in this answer.)
            return Outcome::Read(Reading::unknown(Note::None, Charging::Yes, now));
        }
        return Outcome::Read(Reading::unknown(Note::NoPad, Charging::Unknown, now));
    }
    if gone {
        Outcome::Failed
    } else if linked == Some(false) {
        Outcome::Read(Reading::unknown(Note::NoPad, Charging::Unknown, now))
    } else {
        Outcome::NoAnswer
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::super::{payload, read};
    use super::*;
    use crate::model::Note;

    fn m(pid: u16) -> &'static Model {
        MODELS.iter().find(|m| m.pid == pid).unwrap()
    }
    fn pct(n: i64) -> Level {
        Level::Exact(Percent::new(n).unwrap())
    }
    /// A vendor reply: 02 04 04 00 <cmd lo> <cmd hi> …, `at` set (64 bytes).
    fn vreply(cmd: [u8; 2], at: &[(usize, u8)]) -> Vec<u8> {
        let mut r = report(0x02, 64, at);
        r[1] = 0x04;
        r[2] = 0x04;
        r[4] = cmd[0];
        r[5] = cmd[1];
        r
    }

    #[test]
    fn dinput_reports() {
        // (Report 01, 34 bytes for the Ultimate 2 6012; byte 14: 0x3C → 60 %, 0xB2 → 50 % charging, 0xE4 → 100 %
        //  with the bit still on: charged.)
        let u2 = m(0x6012);
        assert_eq!(parse_dinput(u2, &report(0x01, 34, &[(14, 0x3C)])), Parsed::Got(pct(60), Charging::No));
        assert_eq!(parse_dinput(u2, &report(0x04, 34, &[(14, 0xB2)])), Parsed::Got(pct(50), Charging::Yes));
        assert_eq!(parse_dinput(u2, &report(0x01, 34, &[(14, 0xE4)])), Parsed::Got(pct(100), Charging::No));
        assert_eq!(parse_dinput(u2, &report(0x01, 34, &[(14, 0x7F)])), Parsed::Bad, "127 %");
        assert_eq!(parse_dinput(u2, &report(0x01, 12, &[])), Parsed::Bad, "firmware 1.02's 12-byte report");
        assert_eq!(parse_dinput(u2, &report(0x01, 20, &[(14, 50)])), Parsed::Bad, "the 6012 sends 34 bytes");
        assert_eq!(parse_dinput(u2, &report(0x03, 34, &[(14, 50)])), Parsed::Skip);
        let u3 = m(0x202F);
        assert_eq!(parse_dinput(u3, &report(0x01, 15, &[(14, 33)])), Parsed::Got(pct(33), Charging::No));
        // (Pro 2: report 04 only — its 01 is not documented to carry the battery.)
        let pro2 = m(0x6003);
        assert_eq!(parse_dinput(pro2, &report(0x01, 20, &[(14, 33)])), Parsed::Skip);
        assert_eq!(parse_dinput(pro2, &report(0x04, 20, &[(14, 0x96)])), Parsed::Got(pct(22), Charging::Yes));
    }

    #[test]
    fn a_pro2_without_sdls_report_needs_a_query_we_do_not_send() {
        let pro2 = m(0x6003);
        let mut f = fake(pro2);
        f.stream.extend([report(0x01, 20, &[(14, 33)]), report(0x01, 20, &[(14, 33)])]);
        assert_eq!(read(&mut f, pro2, false, true, soon(), 2), Outcome::Read(Reading::unknown(Note::NeedsQuery, Charging::Unknown, 2)));
        assert!(f.sent.is_empty(), "feature 06 is never asked for");
        assert!(f.features.is_empty());
    }

    #[test]
    fn the_receivers_requests() {
        let r310b = &RX_MODELS[0];
        // (Linked, 72 %, charging.)
        let mut f = fake(r310b);
        f.replies.extend([vec![vreply([0x20, 0x01], &[(18, 1)])], vec![vreply([0x21, 0x01], &[(18, 0x80 | 72)])]]);
        assert_eq!(read(&mut f, r310b, false, true, soon(), 4), Outcome::Read(Reading::new(pct(72), Charging::Yes, 4)));
        assert_eq!(f.sent, vec![LINK.to_vec(), BATTERY.to_vec()], "exactly the two requests, nothing else");
        assert_eq!(f.flushes, 2);
        // (Not linked: no battery request; the info says it is the receiver itself → no controller linked.)
        let mut f = fake(r310b);
        f.replies.extend([vec![vreply([0x20, 0x01], &[(18, 0)])], vec![vreply([0x00, 0x01], &[(22, 0x13), (23, 0x60)])]]);
        assert_eq!(read(&mut f, r310b, false, true, soon(), 4), Outcome::Read(Reading::unknown(Note::NoPad, Charging::Unknown, 4)));
        assert_eq!(f.sent, vec![LINK.to_vec(), INFO.to_vec()]);
        // (On its cable: the info names the pad → charging, no made-up level.)
        let mut f = fake(&RX_MODELS[2]);
        f.replies.extend([vec![vreply([0x20, 0x01], &[(18, 1)])], vec![vreply([0x21, 0x01], &[(18, 0)])], vec![vreply([0x00, 0x01], &[(22, 0x12), (23, 0x60)])]]);
        assert_eq!(read(&mut f, &RX_MODELS[2], false, true, soon(), 4), Outcome::Read(Reading::unknown(Note::None, Charging::Yes, 4)));
        // (A reply to another command, or a short one, is not taken: no answer.)
        let mut f = fake(r310b);
        f.replies.extend([vec![vreply([0x21, 0x01], &[(18, 1)])], vec![report(0x02, 10, &[])], vec![]]);
        assert_eq!(read(&mut f, r310b, false, true, soon(), 4), Outcome::NoAnswer);
        // (Percentage over 100 is no reading.)
        let mut f = fake(r310b);
        f.replies.extend([vec![vreply([0x20, 0x01], &[(18, 1)])], vec![vreply([0x21, 0x01], &[(18, 120)])], vec![]]);
        assert_eq!(read(&mut f, r310b, false, true, soon(), 4), Outcome::NoAnswer);
        let _ = payload(&[]);
    }
}
