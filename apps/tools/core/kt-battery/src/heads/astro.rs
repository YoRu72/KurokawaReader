// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): ASTRO A50 and A20 wireless headsets (Logitech 046D, ASTRO 9886).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/astro.cpp (PollAstro, QueryLegacy, PollLegacyCollection, kLegacyModels) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later. Its references:
// Sapd/HeadsetControl (logitech_astro_a50.hpp, logitech_astro_a50_gen4.hpp), tdryer/eh-fifty, nichtlegacy/AstroBar.
//   A50 X (046D:0B0B), A50 Gen 5 (046D:0B1C), FF32:0074, 64-byte reports: [02][0C][03][00][06][0C] → [02][0C][len ≥ 6]
//     [00][06][00 | 0C][percent][…][charging]; volume and mix events in between are skipped.
//   A50 Gen 4 / Gen 3, A20 (9886, FF32 / FF31 / FF00, 64-byte reports): [02][cmd] → [02][status 02 ok, 01 error][len]
//     [value]: 54 headset status (bit 0 docked, bit 1 linked), 7C battery (bit 7 charging, bits 0–6 percent).
// Changed here: no last reading kept and shown while Astro Command Center holds the collection exclusively (the
// original showed its cached level then): «no answer», the last reading dimmed with its age; the base station's
// collection with page 0 (an exclusive lock seen through its path) is not taken for the headset.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::mice::*;
use crate::model::{Charging, Kind, Level};
use crate::sched::Outcome;
use crate::transport::TErr;
use std::time::Instant;

const fn x(pid: u16, name: &'static str) -> Model {
    Model::new("hs-astro-x", 0x046D, pid, name, Kind::Headset, Via::Receiver).page(0xFF32).usage(0x0074).input(Len::Eq(64)).output(Len::Eq(64))
}
pub static MODELS: &[Model] = &[x(0x0B0B, "ASTRO A50 X"), x(0x0B1C, "ASTRO A50 Gen 5")];

pub const GEN4: [u16; 3] = [0x002C, 0x002D, 0x002A];
pub const GEN3: [u16; 5] = [0x0015, 0x0014, 0x0018, 0x001D, 0x0026];
pub const A20: [u16; 6] = [0x0037, 0x0038, 0x0039, 0x0043, 0x0044, 0x0045];
const L: Model = Model::new("hs-astro", 0x9886, 0, "", Kind::Headset, Via::Receiver).input(Len::Min(64)).output(Len::Min(64));
pub static G4_32: [Model; 3] = many(L.named("ASTRO A50 Gen 4").page(0xFF32), GEN4);
pub static G4_31: [Model; 3] = many(L.named("ASTRO A50 Gen 4").page(0xFF31), GEN4);
pub static G4_00: [Model; 3] = many(L.named("ASTRO A50 Gen 4").page(0xFF00), GEN4);
pub static G3_32: [Model; 5] = many(L.named("ASTRO A50 Gen 3").page(0xFF32), GEN3);
pub static G3_31: [Model; 5] = many(L.named("ASTRO A50 Gen 3").page(0xFF31), GEN3);
pub static G3_00: [Model; 5] = many(L.named("ASTRO A50 Gen 3").page(0xFF00), GEN3);
pub static A20_32: [Model; 6] = many(L.named("ASTRO A20 Wireless").page(0xFF32), A20);
pub static A20_31: [Model; 6] = many(L.named("ASTRO A20 Wireless").page(0xFF31), A20);
pub static A20_00: [Model; 6] = many(L.named("ASTRO A20 Wireless").page(0xFF00), A20);

pub const Q_X: [u8; 6] = [0x02, 0x0C, 0x03, 0x00, 0x06, 0x0C];
pub const Q_STATUS: [u8; 2] = [0x02, 0x54];
pub const Q_BATTERY: [u8; 2] = [0x02, 0x7C];

/// A50 X / Gen 5's battery reply, or None for anything else (an event, a partial frame).
pub fn x_reply(r: &[u8]) -> Option<(u8, bool)> {
    if r.len() < 9 || r[0] != 0x02 || r[1] != 0x0C || r[2] < 6 || usize::from(r[2]) + 3 > r.len() || r[3] != 0 || r[4] != 0x06 || (r[5] != 0 && r[5] != 0x0C) || r[6] > 100 {
        return None;
    }
    Some((r[6], r[8] != 0))
}

/// The older bases' answer to `[02][cmd]`: Ok(value), Err(Refused) for an error status, None for another report.
fn legacy_reply(r: &[u8]) -> Option<Result<u8, TErr>> {
    if r.len() < 4 || r[0] != 0x02 {
        return None;
    }
    match r[1] {
        0x01 => Some(Err(TErr::Refused)),
        0x02 => Some(Ok(r[3])),
        _ => None,
    }
}

fn legacy(ch: &mut Chans, q: &[u8], deadline: Instant) -> Result<u8, TErr> {
    let mut last = Err(TErr::Timeout);
    for _ in 0..2 {
        match out_ask(ch, q, ms(500), deadline, &mut legacy_reply) {
            Ok(Ok(v)) => return Ok(v),
            Ok(Err(e)) => return Err(e),
            Err(TErr::Gone) => return Err(TErr::Gone),
            Err(e) => last = Err(e),
        }
    }
    last
}

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    if m.driver == "hs-astro-x" {
        return match out_ask(ch, &Q_X, ms(1000), deadline, &mut x_reply) {
            Ok((p, c)) => got(pct(i64::from(p)).unwrap_or(Level::Unknown), charging(c), now),
            Err(e) => failed(&e),
        };
    }
    let st = match legacy(ch, &Q_STATUS, deadline) {
        Ok(v) => v,
        Err(TErr::Refused) => return no_level(Charging::Unknown, now),
        Err(e) => return failed(&e),
    };
    let (docked, linked) = (st & 0x01 != 0, st & 0x02 != 0);
    if !docked && !linked {
        return unlinked(now);
    }
    match legacy(ch, &Q_BATTERY, deadline) {
        Ok(b) if b & 0x7F <= 100 => {
            let p = b & 0x7F;
            got(pct(i64::from(p)).unwrap_or(Level::Unknown), charging(b & 0x80 != 0 || (docked && p < 100)), now)
        }
        Ok(_) | Err(TErr::Refused) => no_level(if docked { Charging::Yes } else { Charging::Unknown }, now),
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use crate::mice::testkit::*;
    use super::*;

    #[test]
    fn a50_x() {
        let m = model("hs-astro-x", 0x0B0B);
        let mut f = fake(m);
        let ev = vec![0x02, 0x0C, 0x02, 0x00, 0x07, 0x00, 0x00, 0x00, 0x00];
        f.replies.push_back(vec![ev, vec![0x02, 0x0C, 0x06, 0x00, 0x06, 0x0C, 73, 0x00, 0x01]]);
        assert_eq!(read1(&mut f, m), at(pctl(73), Charging::Yes), "the volume event skipped");
        assert_eq!(f.sent, vec![Q_X.to_vec()]);
        assert_eq!(x_reply(&[0x02, 0x0C, 0x06, 0x00, 0x06, 0x0C, 101, 0, 0]), None, "over 100");
        assert_eq!(x_reply(&[0x02, 0x0C, 0x09, 0x00, 0x06, 0x0C, 50, 0, 0]), None, "a length past the report");
    }

    #[test]
    fn older_bases() {
        let m = model("hs-astro", 0x002C);
        let mut f = fake(m);
        f.replies.extend([vec![vec![0x02, 0x02, 0x01, 0x02]], vec![vec![0x02, 0x02, 0x01, 0x80 | 64]]]);
        assert_eq!(read1(&mut f, m), at(pctl(64), Charging::Yes));
        assert_eq!(f.sent, vec![Q_STATUS.to_vec(), Q_BATTERY.to_vec()]);
        let mut f = fake(m);
        f.replies.extend([vec![vec![0x02, 0x02, 0x01, 0x01]], vec![vec![0x02, 0x02, 0x01, 90]]]);
        assert_eq!(read1(&mut f, m), at(pctl(90), Charging::Yes), "docked under 100: charging");
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x02, 0x02, 0x01, 0x00]]);
        assert_eq!(read1(&mut f, m), unlinked(7));
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x02, 0x01, 0x00, 0x00]]);
        assert_eq!(read1(&mut f, m), no_level(Charging::Unknown, 7), "an error status");
    }
}
