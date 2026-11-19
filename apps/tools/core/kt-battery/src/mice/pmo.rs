// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): keyboards on the shared «Wireless 2.4G Dongle» 36B0:3002 (PMO Hub
// firmware, or VIA firmware: URX Core75, EVO80), and PMO Hub keyboards on their cable (PMO / WOBKEY Wave 75 3009,
// Aurora 80 3004, PMO P75 302B, PMO 80 3012).
// Ported from Wireless Device Battery Monitor / BatteryHub (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/via_dongle.cpp at v1.1.0 (commit 7cc44f2), by krisgfx9 and its contributors, GPL-3.0-or-later. Its
// references: pmohub.cn's web driver (protocol 1: CMD_START_COMM 10, CMD_GET_BATTERY_STATUS 30, CMD_STOP_COMM 11, SUCCESS
// 55), a reverse engineering of it in the original's issue 343; HeyOkay/HaloBattery providers/urx.py (URX HUB's driver).
//   Interface 1, FF60:0061 (raw HID), report id 0: 33-byte reports on the dongle, 65 on a cable.
//   PMO Hub: [AA][cmd][offset 00 00][len] — START (len = payload − 8: 18 on the dongle, 38 on a cable), GET_BATTERY
//     (len 18), STOP; replies echo [AA][cmd][00 00] with 55 (ok) at [7], the level at [8]. A session around the read:
//     STOP is always sent once START was. The byte after the level is not a reliable charging flag: not used.
//   VIA: id_custom_get_value [08][channel 00][value 07] → [08 00 07][level]; FF «unhandled» on other firmware.
// Changed here: no memory across rounds of which firmware answered (the original's g_state and its back-off): on the
// dongle the single VIA read goes first (PMO firmware ignores it), then the PMO session; the scheduler's interval and
// the «asleep» rule pace the asking. The keyboard's own product id from the dongle's START reply is not used for the name.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn p(pid: u16, name: &'static str, via: Via, len: u16) -> Model {
    Model::new("mk-pmo", 0x36B0, pid, name, Kind::Keyboard, via).iface(1).page(0xFF60).usage(0x0061).input(Len::Eq(len)).output(Len::Eq(len))
}
pub static MODELS: &[Model] = &[
    p(0x3002, "Wireless keyboard", Via::Receiver, 33).product_name(),
    p(0x3009, "WAVE 75", Via::Cable, 65),
    p(0x3004, "Aurora 80", Via::Cable, 65),
    p(0x302B, "PMO P75", Via::Cable, 65),
    p(0x3012, "PMO 80", Via::Cable, 65),
];

pub const fn pmo(cmd: u8, len: u8) -> [u8; 6] {
    [0x00, 0xAA, cmd, 0x00, 0x00, len]
}
pub const START_DONGLE: [u8; 6] = pmo(0x10, 0x18);
pub const START_CABLE: [u8; 6] = pmo(0x10, 0x38);
pub const BATTERY: [u8; 6] = pmo(0x30, 0x18);
pub const STOP_DONGLE: [u8; 6] = pmo(0x11, 0x18);
pub const STOP_CABLE: [u8; 6] = pmo(0x11, 0x38);
pub const VIA_BATTERY: [u8; 4] = [0x00, 0x08, 0x00, 0x07];

fn echo(cmd: u8) -> impl FnMut(&[u8]) -> Option<Vec<u8>> {
    move |r: &[u8]| if r.len() > 8 && r[0] == 0xAA && r[1] == cmd && r[2] == 0 && r[3] == 0 { Some(r.to_vec()) } else { None }
}

/// The PMO session: Ok(Some(level)), Ok(None) the keyboard answered without one, Err no session.
fn pmo_read(ch: &mut Chans, cable: bool, deadline: Instant) -> Result<Option<u8>, TErr> {
    let (start, stop) = if cable { (START_CABLE, STOP_CABLE) } else { (START_DONGLE, STOP_DONGLE) };
    let mut s = out_ask(ch, &start, ms(600), deadline, &mut echo(0x10));
    if s == Err(TErr::Timeout) {
        // (The link waking up.)
        s = out_ask(ch, &start, ms(600), deadline, &mut echo(0x10));
    }
    // (START refused before anything went out: no session to close.)
    if s == Err(TErr::Refused) {
        return Err(TErr::Refused);
    }
    let gone = s == Err(TErr::Gone);
    let ok = matches!(&s, Ok(r) if r.get(7) == Some(&0x55));
    let level = if ok { out_ask(ch, &BATTERY, ms(600), deadline, &mut echo(0x30)).ok().filter(|r| r.get(7) == Some(&0x55)).and_then(|r| r.get(8).copied()) } else { None };
    // (Always closed, in case START was taken — with its own time (mod.rs's close_deadline): a read whose time ran out
    // still closes the session.)
    let _ = out_ask(ch, &stop, CLOSE_STEP, close_deadline(), &mut echo(0x11));
    if gone {
        return Err(TErr::Gone);
    }
    if !ok {
        return Err(TErr::Timeout);
    }
    Ok(level)
}

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    let cable = m.via == Via::Cable;
    if !cable {
        match out_ask(ch, &VIA_BATTERY, ms(600), deadline, &mut |r| if r.len() >= 4 && r[0] == 0x08 && r[1] == 0x00 && r[2] == 0x07 { Some(r[3]) } else { None }) {
            Ok(l) if (1..=100).contains(&l) => return got(pct(i64::from(l)).unwrap_or(Level::Unknown), Charging::Unknown, now),
            Err(TErr::Gone) => return Outcome::Failed,
            _ => {}
        }
    }
    match pmo_read(ch, cable, deadline) {
        Ok(Some(l)) if l <= 100 => got(pct(i64::from(l)).unwrap_or(Level::Unknown), Charging::Unknown, now),
        Ok(_) => no_level(Charging::Unknown, now),
        Err(TErr::Gone) => Outcome::Failed,
        // (Nothing answered: the keyboard asleep, off or on its cable.)
        Err(_) => dozing(now),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    fn rep(cmd: u8, at: &[(usize, u8)]) -> Vec<u8> {
        let mut v = vec![(1, cmd)];
        v.extend_from_slice(at);
        report(0xAA, 32, &v)
    }

    #[test]
    fn dongle_and_cables() {
        // (VIA firmware: one read.)
        let d = model("mk-pmo", 0x3002);
        let mut f = fake(d);
        f.replies.push_back(vec![report(0x08, 32, &[(2, 0x07), (3, 61)])]);
        assert_eq!(read1(&mut f, d), at(pctl(61), Charging::Unknown));
        assert_eq!(f.sent, vec![VIA_BATTERY.to_vec()]);
        // (PMO firmware on the dongle: VIA ignored, then START, battery, STOP.)
        let mut f = fake(d);
        f.replies.extend([vec![], vec![rep(0x10, &[(7, 0x55), (9, 0xB0), (10, 0x36)])], vec![rep(0x30, &[(7, 0x55), (8, 78)])], vec![rep(0x11, &[(7, 0x55)])]]);
        assert_eq!(read1(&mut f, d), at(pctl(78), Charging::Unknown));
        assert_eq!(f.sent, vec![VIA_BATTERY.to_vec(), START_DONGLE.to_vec(), BATTERY.to_vec(), STOP_DONGLE.to_vec()]);
        // (A VIA «unhandled» FF: on to the PMO session; START refused (0F): STOP still sent, nothing read.)
        let mut f = fake(d);
        f.replies.extend([vec![report(0x08, 32, &[(2, 0x07), (3, 0xFF)])], vec![rep(0x10, &[(7, 0x0F)])], vec![rep(0x11, &[(7, 0x55)])]]);
        assert_eq!(read1(&mut f, d), dozing(7));
        assert_eq!(f.sent, vec![VIA_BATTERY.to_vec(), START_DONGLE.to_vec(), STOP_DONGLE.to_vec()]);
        // (A cable: PMO only, its own length byte.)
        let c = model("mk-pmo", 0x3009);
        let mut f = fake(c);
        f.replies.extend([vec![rep(0x10, &[(7, 0x55)])], vec![rep(0x30, &[(7, 0x55), (8, 101)])], vec![]]);
        assert_eq!(read1(&mut f, c), no_level(Charging::Unknown, 7));
        assert_eq!(f.sent, vec![START_CABLE.to_vec(), BATTERY.to_vec(), STOP_CABLE.to_vec()]);
    }

    #[test]
    fn stop_is_sent_after_the_time_ran_out() {
        let c = model("mk-pmo", 0x3009);
        // (START answered, the battery step silent until the read's deadline: STOP still sent, with its own time.)
        let mut f = fake(c);
        f.wait_when_quiet = true;
        f.replies.extend([vec![rep(0x10, &[(7, 0x55)])], vec![], vec![]]);
        let soon = Instant::now() + ms(120);
        assert_eq!(crate::mice::read(&mut Chans::one(&mut f), c, None, true, soon, 7).out, no_level(Charging::Unknown, 7));
        assert!(Instant::now() >= soon);
        assert_eq!(f.sent, vec![START_CABLE.to_vec(), BATTERY.to_vec(), STOP_CABLE.to_vec()], "STOP after a timed-out middle step");
        // (START's replies lost — the resend found no time left: STOP still sent.)
        let mut f = fake(c);
        f.wait_when_quiet = true;
        let soon = Instant::now() + ms(120);
        assert_eq!(crate::mice::read(&mut Chans::one(&mut f), c, None, true, soon, 7).out, dozing(7));
        assert_eq!(f.sent.first(), Some(&START_CABLE.to_vec()));
        assert_eq!(f.sent.last(), Some(&STOP_CABLE.to_vec()), "STOP after lost START replies: {:?}", f.sent);
        // (A short START echo: no session, never an index past its end.)
        let mut f = fake(c);
        f.replies.extend([vec![report(0xAA, 9, &[(1, 0x10)])], vec![]]);
        assert_eq!(read1(&mut f, c), dozing(7));
    }
}
