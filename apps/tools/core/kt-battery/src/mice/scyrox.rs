// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Scyrox V12M on its 2.4 GHz receiver (395A:0006).
// Ported from Wireless Device Battery Monitor / BatteryHub (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/scyrox.cpp at v1.1.0 (commit 7cc44f2), by krisgfx9 and its contributors, GPL-3.0-or-later. Its references:
// Scyrox's S-Center 2.0 web driver, late-autumn-gif/mousedock, MoFeng2223/BrimDeck.
//   FF00:0002, 64-byte reports: output 08 [08][01][00 …][09] reads the profiles (nothing is set); the receiver answers
//   with a stream of 08 01 frames (one per profile, axis frames 23 / 25 between them, an 08 01 frame with [3] = 0 last).
//   The active profile's frame: [3] ≠ 0, [4] = [5] = the profile 0–3, [7] DPI stages 1–5, [62] 0 (1 error), [20] the
//   battery percent. No charging field is confirmed: none is shown. The V6S / V8S (another status command) are not read.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

pub static MODELS: &[Model] = &[Model::new("mk-scyrox", 0x395A, 0x0006, "Scyrox V12M", Kind::Mouse, Via::Receiver).page(0xFF00).usage(0x0002).input(Len::Eq(64)).output(Len::Eq(64))];

pub const READ_PROFILES: [u8; 64] = {
    let mut b = [0u8; 64];
    b[0] = 0x08;
    b[1] = 0x01;
    b[63] = 0x09;
    b
};

/// Some(Some(level)) the active profile's frame; Some(None) the stream's end; None another frame.
pub fn frame(r: &[u8]) -> Option<Option<u8>> {
    if r.len() != 64 || r[0] != 0x08 || r[1] != 0x01 {
        return None;
    }
    if r[3] == 0 {
        return Some(None);
    }
    if r[62] == 1 || r[4] > 3 || r[4] != r[5] || !(1..=5).contains(&r[7]) {
        return None;
    }
    Some(Some(r[20]))
}

pub fn read(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Outcome {
    let out = match out_ask(ch, &READ_PROFILES, ms(1500), deadline, &mut frame) {
        Ok(Some(p)) => match pct(i64::from(p)) {
            Some(l) => got(l, Charging::Unknown, now),
            None => no_level(Charging::Unknown, now),
        },
        // (The stream ended with no active profile: the mouse asleep or off.)
        Ok(None) => dozing(now),
        Err(TErr::Gone) => Outcome::Failed,
        Err(_) => dozing(now),
    };
    // (The rest of the profile stream dropped.)
    ch.rx().flush();
    out
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn v12m() {
        let m = model("mk-scyrox", 0x0006);
        let mut f = fake(m);
        let other = report(0x08, 64, &[(1, 0x01), (3, 1), (4, 1), (5, 0), (7, 3), (20, 12)]);
        let axis = report(0x23, 64, &[]);
        let active = report(0x08, 64, &[(1, 0x01), (3, 1), (4, 2), (5, 2), (7, 4), (20, 83)]);
        f.replies.push_back(vec![other, axis, active]);
        assert_eq!(read1(&mut f, m), at(pctl(83), Charging::Unknown), "a profile not active, an axis frame skipped");
        assert_eq!(f.sent, vec![READ_PROFILES.to_vec()]);
        let mut f = fake(m);
        f.replies.push_back(vec![report(0x08, 64, &[(1, 0x01), (3, 0)])]);
        assert_eq!(read1(&mut f, m), dozing(7), "the stream's end first");
        let mut f = fake(m);
        f.replies.push_back(vec![report(0x08, 64, &[(1, 0x01), (3, 1), (4, 0), (5, 0), (7, 1), (20, 101)])]);
        assert_eq!(read1(&mut f, m), no_level(Charging::Unknown, 7));
    }
}
