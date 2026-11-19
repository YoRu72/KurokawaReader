// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Darmoshark M3 over its Telink receiver (248A:FF30).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/darmoshark.cpp (Query, ReadBattery, PollDarmoshark) at commit 285d64254216857e94ca3ea3e1deb536f863e282,
// by krisgfx9 and its contributors, GPL-3.0-or-later. Its reference: Barba2k2/darmoshark-m3-configurator, PROTOCOL.md.
// Interface 1, page 8C usage 1 (33-byte input / output, 1001-byte feature reports). Feature report 51 [51][op]; read
// back as feature report 51: [51][op]…. 03 «bond» → the mouse's ids at [3..6] (248A, FF12), [7] bonded; then 06
// «identify» → [2] = 1, the ids at [4..7], [11] percent. (The bond read first replaces any older reply in the
// receiver's buffer.)
// Changed here: the error input report (54 E4 02) is not listened for (the handle has no read access; the reply's
// checks decide); one deadline for both reads and the one retry.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

pub static MODELS: &[Model] = &[Model::new("mk-darmoshark", 0x248A, 0xFF30, "Darmoshark M3", Kind::Mouse, Via::Receiver).iface(1).page(0x008C).usage(0x0001).input(Len::Eq(33)).output(Len::Eq(33)).feature(Len::Eq(1001))];

pub const BOND: [u8; 2] = [0x51, 0x03];
pub const IDENTIFY: [u8; 2] = [0x51, 0x06];

fn id(r: &[u8], at: usize) -> u16 {
    u16::from(r[at]) | u16::from(r[at + 1]) << 8
}

fn query(t: &mut dyn HidTransport, req: &[u8; 2], deadline: Instant) -> Result<Vec<u8>, TErr> {
    feat_ask(t, req, 0x51, 1001, ms(20), 10, deadline, &mut |r| if r.len() >= 12 && r[0] == 0x51 && r[1] == req[1] { Some(r[..12].to_vec()) } else { None })
}

fn battery(t: &mut dyn HidTransport, deadline: Instant) -> Result<Option<u8>, TErr> {
    let b = query(t, &BOND, deadline)?;
    if id(&b, 3) != 0x248A || id(&b, 5) != 0xFF12 || b[7] == 0 {
        return Ok(None);
    }
    let r = query(t, &IDENTIFY, deadline)?;
    if r[2] != 1 || id(&r, 4) != 0x248A || id(&r, 6) != 0xFF12 || r[11] > 100 {
        return Ok(None);
    }
    Ok(Some(r[11]))
}

pub fn read(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Outcome {
    let first = deadline.min(Instant::now() + ms(300));
    let r = match battery(&mut *ch.main, first) {
        Ok(Some(p)) => Ok(Some(p)),
        Err(TErr::Gone) => Err(TErr::Gone),
        _ => battery(&mut *ch.main, deadline),
    };
    match r {
        Ok(Some(p)) => got(pct(i64::from(p)).unwrap_or(Level::Unknown), Charging::Unknown, now),
        Ok(None) => unlinked(now),
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn darmoshark() {
        let m = model("mk-darmoshark", 0xFF30);
        let bond = report(0x51, 12, &[(1, 0x03), (3, 0x8A), (4, 0x24), (5, 0x12), (6, 0xFF), (7, 1)]);
        let ident = report(0x51, 12, &[(1, 0x06), (2, 1), (4, 0x8A), (5, 0x24), (6, 0x12), (7, 0xFF), (11, 58)]);
        let mut f = fake(m);
        f.feature_replies.extend([bond.clone(), ident.clone()]);
        assert_eq!(read1(&mut f, m), at(pctl(58), Charging::Unknown));
        assert_eq!(f.sent, vec![BOND.to_vec(), IDENTIFY.to_vec()]);
        let mut other = bond.clone();
        other[5] = 0x13;
        let mut f = fake(m);
        f.feature_replies.extend([other.clone(), other]);
        assert_eq!(read1(&mut f, m), unlinked(7), "another mouse's ids: not this one");
    }
}
