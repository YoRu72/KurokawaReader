// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): BenQ ZOWIE wireless mice (VID 04A5).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/zowie.cpp (PollCw, PollDw) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its
// contributors, GPL-3.0-or-later. Its references: yleshchuk/zowie-battery, IgnacioBarb/zowie-battery-tray.
//  - EC-CW (receiver 8006, cable 8005): unnumbered 64-byte output A5 03 on the vendor collection (00FF on the Enhanced
//    Receiver) → [mV lo][mV hi][percent]; mV 0: the mouse not linked. (Other EC-CW commands reboot the receiver and
//    unpair the mouse: never sent.)
//  - DW (receiver 800A) and U2 (receiver 8008): output report 08 [B4 15] on FF03 → input report 09 on FF04:
//    mV = ([1] × 256 + [2]) × 10, valid when [4] = C8 (E6 in [1]: no reading).
// Changed here: the voltage-only DW / U2 level as a coarse word (the original: a curve to the per cent); the charging
// guessed from the voltage's trend (a rise of 50 mV) is not shown — unknown; only the DW and U2 receivers by id (the
// original sent B4 15 to every other 04A5 product with such collections).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn cw(pid: u16, via: Via, vendor: bool) -> Model {
    let m = Model::new("mk-zowie-cw", 0x04A5, pid, "ZOWIE EC-CW", Kind::Mouse, via).output(Len::Eq(65)).pair("zw:eccw");
    if vendor {
        m.vendor_page()
    } else {
        m.page(0x00FF)
    }
}
const fn dw(pid: u16, name: &'static str, reply: bool) -> Model {
    let m = Model::new("mk-zowie-dw", 0x04A5, pid, name, Kind::Mouse, Via::Receiver);
    if reply {
        m.page(0xFF04).input(Len::Eq(16)).role(Role::Reply)
    } else {
        m.page(0xFF03).output(Len::Eq(16))
    }
}

pub static MODELS: &[Model] = &[
    cw(0x8006, Via::Receiver, true),
    cw(0x8006, Via::Receiver, false),
    cw(0x8005, Via::Cable, true),
    cw(0x8005, Via::Cable, false),
    dw(0x800A, "ZOWIE DW mouse", false),
    dw(0x800A, "ZOWIE DW mouse", true),
    dw(0x8008, "ZOWIE U2", false),
    dw(0x8008, "ZOWIE U2", true),
];

pub const CW: [u8; 3] = [0x00, 0xA5, 0x03];
pub const DW: [u8; 3] = [0x08, 0xB4, 0x15];

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    let cable = m.via == Via::Cable;
    if m.driver == "mk-zowie-cw" {
        return match out_ask(ch, &CW, ms(1000), deadline, &mut |r| {
            if r.len() < 3 {
                return None;
            }
            let mv = u32::from(r[0]) | u32::from(r[1]) << 8;
            if mv != 0 && !(3000..=4500).contains(&mv) {
                return None;
            }
            Some((mv, r[2]))
        }) {
            Ok((0, _)) => unlinked(now),
            Ok((mv, p)) => got(if (1..=100).contains(&p) { pct(i64::from(p)).unwrap_or(Level::Unknown) } else { from_millivolts(mv) }, if cable { Charging::Yes } else { Charging::Unknown }, now),
            Err(e) => failed(&e),
        };
    }
    if ch.reply.is_none() {
        // (Without the reply collection nothing is sent.)
        return Outcome::Failed;
    }
    match out_ask(ch, &DW, ms(1500), deadline, &mut |r| if r.len() >= 5 && r[0] == 0x09 { Some(r[..5].to_vec()) } else { None }) {
        Ok(r) if r[1] != 0xE6 && r[4] == 0xC8 => {
            let mv = (u32::from(r[1]) * 256 + u32::from(r[2])) * 10;
            if mv == 0 {
                unlinked(now)
            } else {
                got(from_millivolts(mv), Charging::Unknown, now)
            }
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
    fn zowie() {
        let m = model("mk-zowie-cw", 0x8006);
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x00, 0xA0, 0x0F, 77]]);
        assert_eq!(read1(&mut f, m), at(pctl(77), Charging::Unknown));
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x00, 0x00, 0x00, 0]]);
        assert_eq!(read1(&mut f, m), unlinked(7));
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x00, 0x10, 0x00, 50]]);
        assert_eq!(read1(&mut f, m), Outcome::NoAnswer, "16 mV: not a battery reply");
        // (DW: the request on FF03, the reply on FF04.)
        let m = model("mk-zowie-dw", 0x800A);
        let rm = all_models().find(|x| x.pid == 0x800A && x.role == Role::Reply).unwrap();
        let mut cmd = fake(m);
        let mut rep = fake(rm);
        rep.keep_on_flush = true;
        rep.stream.push_back(vec![0x09, 0x01, 0x88, 0, 0xC8]);
        let out = crate::mice::read(&mut Chans { main: &mut cmd, reply: Some(&mut rep), long: None }, m, None, true, soon(), 7).out;
        assert_eq!(out, at(from_millivolts(3920), Charging::Unknown), "(0x01 × 256 + 0x88) × 10 = 3920 mV");
        assert_eq!(cmd.sent, vec![DW.to_vec()]);
        assert_eq!(rep.flushes, 1);
        let mut cmd = fake(m);
        assert_eq!(read1(&mut cmd, m), Outcome::Failed, "no reply collection: nothing sent");
        assert!(cmd.sent.is_empty());
    }
}
