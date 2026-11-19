// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Corsair's wireless headsets (VID 1B1C).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/corsair.cpp (kVoidPids, PollVoid; kBragiPids and the Bragi GET for them) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later. Its references:
// Sapd/HeadsetControl (Void), OpenRGB's Bragi notes.
//   Void / Void Pro / Void Elite / HS70 / HS80 (vendor page FFC5 or FF00): output C9 64 → [2] percent (bit 7: the
//     microphone is up), [4] status: 0 off, 1–2 on battery, 4–5 charging.
//   Bragi headsets (Virtuoso, Void V2, HS80 MAX: 2A08, 2A02, 0A97, 0A64, 0A62, 0A3E, 0A3D): the Bragi GET of
//     mice/corsair.rs — targets 09–0B behind a receiver, else 08 the headset itself; battery 0–1000, charge state.
// Changed here: only these products (the original sent C9 64 to its Void list and Bragi GETs to every 1B1C product with a
// 64/65-byte vendor collection); the Bragi headsets' interface-4 collections without a vendor page are not asked; a
// Void at status 3 (not documented) shows no level.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::mice::*;
use crate::model::{Charging, Kind, Level};
use crate::sched::Outcome;
use std::time::Instant;

const V: u16 = 0x1B1C;
const VOID: Model = Model::new("hs-corsair-void", V, 0, "Corsair wireless headset", Kind::Headset, Via::Receiver).output(Len::Min(1)).product_name();
pub const VOID_PIDS: [u16; 18] = [0x1B1C, 0x1B27, 0x0A14, 0x0A16, 0x0A17, 0x0A1D, 0x0A1A, 0x1B2A, 0x1B23, 0x1B29, 0x0A55, 0x0A51, 0x0A52, 0x0A38, 0x0A4F, 0x0A2B, 0x0A75, 0x0A56];
pub static VOID_FFC5: [Model; 18] = many(VOID.page(0xFFC5), VOID_PIDS);
pub static VOID_FF00: [Model; 18] = many(VOID.page(0xFF00), VOID_PIDS);

pub const BRAGI_PIDS: [u16; 7] = [0x2A08, 0x2A02, 0x0A97, 0x0A64, 0x0A62, 0x0A3E, 0x0A3D];
const BRAGI: Model = Model::new("hs-corsair-bragi", V, 0, "Corsair wireless headset", Kind::Headset, Via::Receiver).vendor_page().input(Len::Min(64)).slots(&crate::mice::corsair::PAIRED).product_name();
pub static BRAGI_64: [Model; 7] = many(BRAGI.output(Len::Eq(64)).arg(1), BRAGI_PIDS);
pub static BRAGI_65: [Model; 7] = many(BRAGI.output(Len::Eq(65)), BRAGI_PIDS);

pub const Q_VOID: [u8; 2] = [0xC9, 0x64];

pub fn read_void(ch: &mut Chans, deadline: Instant, now: u64) -> Outcome {
    match out_ask(ch, &Q_VOID, ms(1000), deadline, &mut |r| if r.len() >= 5 { Some((r[2], r[4])) } else { None }) {
        Ok((_, 0)) => unlinked(now),
        Ok((p, st)) => {
            let c = st == 4 || st == 5;
            let l = if st == 1 || st == 2 || c { pct(i64::from(p & 0x7F)).unwrap_or(Level::Unknown) } else { Level::Unknown };
            got(l, if c { Charging::Yes } else if st <= 2 { Charging::No } else { Charging::Unknown }, now)
        }
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use crate::mice::testkit::*;
    use super::*;

    #[test]
    fn void_family() {
        let m = model("hs-corsair-void", 0x0A14);
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x64, 0x00, 0x80 | 55, 0x00, 0x01]]);
        assert_eq!(read1(&mut f, m), at(pctl(55), Charging::No), "the microphone bit is not the level");
        assert_eq!(f.sent, vec![Q_VOID.to_vec()]);
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x64, 0x00, 40, 0x00, 0x05]]);
        assert_eq!(read1(&mut f, m), at(pctl(40), Charging::Yes));
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x64, 0x00, 40, 0x00, 0x00]]);
        assert_eq!(read1(&mut f, m), unlinked(7));
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x64, 0x00, 40, 0x00, 0x03]]);
        assert_eq!(read1(&mut f, m), no_level(Charging::Unknown, 7), "status 3: no level");
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x64, 0x00, 40]]);
        assert_eq!(read1(&mut f, m), Outcome::NoAnswer, "short");
    }

    #[test]
    fn bragi_headsets_read_through_the_bragi_get() {
        let m = all_models().find(|m| m.driver == "hs-corsair-bragi" && m.pid == 0x2A08 && m.arg == 1).unwrap();
        let mut f = fake(m);
        let rep = |source: u8, v: u32| {
            let mut r = vec![0u8; 64];
            r[0] = 0x02;
            r[1] = source;
            r[2] = 0x02;
            r[4..8].copy_from_slice(&v.to_le_bytes());
            r
        };
        // (No paired target answers; the headset itself: 900 ‰, charge state 1.)
        f.replies.extend([vec![], vec![], vec![], vec![rep(0, 900)], vec![rep(0, 1)]]);
        let a = crate::mice::read(&mut Chans::one(&mut f), m, None, true, soon(), 7);
        assert_eq!(a.out, at(pctl(90), Charging::Yes));
        assert!(f.sent.iter().all(|b| b.len() == 4 && b[0] == 0x02 && b[2] == 0x02), "GET only");
    }
}
