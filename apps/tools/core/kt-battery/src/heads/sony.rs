// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Sony INZONE H9 II, H5 and the INZONE Buds (VID 054C).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/sony_inzone.cpp (GetBattery, ParseEvent, LowestBudOut, PollSonyInzone) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later. Its references:
// Sapd/HeadsetControl (sony_inzone_protocol.hpp, sony_inzone_buds.hpp), kinako19 / takamachi66 inzone-buds-battery-tray.
//   Sony's command layer tunnelled through HID (report 02, 64 bytes, vendor page FF04):
//   command [02][0C][01][00 FC][08][96 C3][41][04 battery][01 GET][tid lo][tid hi][sum of 6–12];
//   event   [02][len][04][FF][..][00][96 C3][1x][04][10 RET | A0 notice][tid lo][tid hi][payload][sum of 5–len].
//   Headsets: payload [charging][percent], FF = the headset is off. Buds: [status][percent] for the left bud, the right
//   bud, the case; FF = that bud is in the case; with both in the case the dongle does not answer. No charging flag.
// Changed here: the buds as earbuds with their parts on one card (the original showed the lower bud out of the case);
// «both in the case» said when the dongle takes the request and nothing answers; the transaction id from the clock
// (a static counter in the original) — allow.rs's template takes ids 0002–00FF with their checksum, nothing else.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::mice::*;
use crate::model::{Charging, Kind, Level, Note, Part, PartName, Reading};
use crate::sched::Outcome;
use crate::transport::TErr;
use std::time::Instant;

const fn s(pid: u16, name: &'static str, kind: Kind, arg: u16) -> Model {
    Model::new("hs-sony", 0x054C, pid, name, kind, Via::Receiver).page(0xFF04).output(Len::Min(64)).arg(arg)
}
pub static MODELS: &[Model] = &[s(0x0FA8, "Sony INZONE H9 II", Kind::Headset, 0), s(0x0EBF, "Sony INZONE H5", Kind::Headset, 0), s(0x0EC2, "Sony INZONE Buds", Kind::Earbuds, 1)];

/// The GET battery command with transaction id `tid` (02–FF).
pub fn command(tid: u8) -> [u8; 64] {
    let mut r = [0u8; 64];
    r[..13].copy_from_slice(&[0x02, 12, 0x01, 0x00, 0xFC, 8, 0x96, 0xC3, 0x41, 0x04, 0x01, tid, 0x00]);
    r[13] = sum8(&r[6..=12]);
    r
}
pub fn command_check(b: &[u8]) -> bool {
    b.len() == 64 && sum8(&b[6..=12]) == b[13]
}

/// A battery event answering `tid`: its payload.
pub fn event(b: &[u8], tid: u8) -> Option<Vec<u8>> {
    if b.len() < 15 || b[0] != 0x02 {
        return None;
    }
    let len = usize::from(b[1]);
    if !(12..=62).contains(&len) || b.len() < len + 2 {
        return None;
    }
    if b[2] != 0x04 || b[3] != 0xFF || b[5] != 0x00 || b[6] != 0x96 || b[7] != 0xC3 || b[8] >> 4 != 0x1 {
        return None;
    }
    if sum8(&b[5..=len]) != b[len + 1] {
        return None;
    }
    if b[9] != 0x04 || !(b[10] == 0x10 || b[10] == 0xA0) || b[11] != tid || b[12] != 0x00 {
        return None;
    }
    Some(b[13..=len].to_vec())
}

fn tid_of(now: u64) -> u8 {
    2 + ((now / 1000) % 254) as u8
}

/// The buds' payload as parts: a bud in the case (FF) is there but not in use, its level unknown.
pub fn buds(p: &[u8], now: u64) -> Option<Reading> {
    if p.len() < 6 {
        return None;
    }
    let part = |name, v: u8, bud: bool| -> Option<Part> {
        match v {
            0xFF if bud => Some(Part { name, level: Level::Unknown, charging: Charging::Unknown, in_use: false }),
            0..=100 => Some(Part { name, level: pct(i64::from(v)).unwrap_or(Level::Unknown), charging: Charging::Unknown, in_use: bud }),
            _ => None,
        }
    };
    Some(Reading::with_parts([part(PartName::Left, p[1], true), part(PartName::Right, p[3], true), part(PartName::Case, p[5], false)], now))
}

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    let tid = tid_of(now);
    let min = if m.arg == 1 { 6 } else { 2 };
    match out_ask(ch, &command(tid), ms(1500), deadline, &mut |r| event(r, tid).filter(|p| p.len() >= min)) {
        Ok(p) if m.arg == 1 => buds(&p, now).map(Outcome::Read).unwrap_or(Outcome::NoAnswer),
        Ok(p) if p[1] == 0xFF => unlinked(now),
        Ok(p) => got(pct(i64::from(p[1])).unwrap_or(Level::Unknown), charging(p[0] != 0), now),
        // (The buds' dongle took the request and nothing answered: both buds are in the case.)
        Err(TErr::Timeout) if m.arg == 1 => Outcome::Read(Reading::unknown(Note::InCase, Charging::Unknown, now)),
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use crate::mice::testkit::*;
    use super::*;
    use crate::allow::{permit, ReportKind};

    fn ev(tid: u8, payload: &[u8]) -> Vec<u8> {
        let len = 12 + payload.len();
        let mut b = vec![0u8; 64];
        b[0] = 0x02;
        b[1] = len as u8;
        b[2] = 0x04;
        b[3] = 0xFF;
        b[6] = 0x96;
        b[7] = 0xC3;
        b[8] = 0x14;
        b[9] = 0x04;
        b[10] = 0x10;
        b[11] = tid;
        b[13..13 + payload.len()].copy_from_slice(payload);
        b[len + 1] = sum8(&b[5..=len]);
        b
    }

    #[test]
    fn headset_and_buds() {
        let h = model("hs-sony", 0x0FA8);
        let t = tid_of(7);
        let mut f = fake(h);
        f.replies.push_back(vec![ev(t + 1, &[0, 50]), ev(t, &[1, 62])]);
        assert_eq!(read1(&mut f, h), at(pctl(62), Charging::Yes), "another transaction's event skipped");
        assert_eq!(f.sent, vec![command(t).to_vec()]);
        let mut f = fake(h);
        f.replies.push_back(vec![ev(t, &[0, 0xFF])]);
        assert_eq!(read1(&mut f, h), unlinked(7));
        let mut f = fake(h);
        let mut bad = ev(t, &[0, 40]);
        bad[15] ^= 1;
        f.replies.push_back(vec![bad]);
        assert_eq!(read1(&mut f, h), Outcome::NoAnswer, "a broken sum");
        let b = model("hs-sony", 0x0EC2);
        let mut f = fake(b);
        f.replies.push_back(vec![ev(t, &[0, 70, 0, 0xFF, 0, 35])]);
        let Outcome::Read(r) = read1(&mut f, b) else { panic!() };
        assert_eq!(r.level, pctl(70), "the right bud is in the case: the left stands; the case at 35 never");
        assert_eq!(r.parts[1].map(|p| (p.in_use, p.level)), Some((false, Level::Unknown)));
        assert_eq!(r.parts[2].map(|p| (p.name, p.level)), Some((PartName::Case, pctl(35))));
        let mut f = fake(b);
        assert_eq!(read1(&mut f, b), Outcome::Read(Reading::unknown(Note::InCase, Charging::Unknown, 7)));
        // (The template: ids 02–FF with their sum; another command byte or a wrong sum refused.)
        let id = ident(h);
        assert!(permit(&id, ReportKind::Output, &command(2)).is_some() && permit(&id, ReportKind::Output, &command(0xFF)).is_some());
        assert!(permit(&id, ReportKind::Output, &command(1)).is_none(), "tid 1 is the dongle's own");
        let mut w = command(9);
        w[10] = 0x02;
        w[13] = sum8(&w[6..=12]);
        assert!(permit(&id, ReportKind::Output, &w).is_none(), "SET");
        let mut w = command(9);
        w[13] ^= 1;
        assert!(permit(&id, ReportKind::Output, &w).is_none());
    }
}
