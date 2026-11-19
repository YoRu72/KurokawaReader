// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): EWEADN S7 / S9 mice (372E:103D «Gaming 2.4G» receiver, 372E:1027 the S9
// Ultra on its cable).
// Ported from Wireless Device Battery Monitor / BatteryHub (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/eweadn.cpp at v1.1.0 (commit 7cc44f2), by krisgfx9 and its contributors, GPL-3.0-or-later. Its reference:
// EWEADN's official web driver (new-hub.eweadn.cn: the «beiying» mouse SDK, hidReportId 3).
//   Feature report 03 on FF00:0001 (64 bytes): [03][sum of the 63 bytes after the id][50][len 00][00][cmd][sub][00 …],
//   read back as feature 03 about 100 ms later (up to three reads): [03][50][ack 0 ok][len][00 one packet][sub][data].
//   47 00 «checkWirelessOnline»: data[0] = 1 when the mouse is linked (asked on the receiver only);
//   4F 81 «getBasics»: data[0] bit 7 charging, bits 0–6 percent. Only these two reads are sent.
// Changed here: the receiver's other 372E products (AULA's, keyboards) are never asked — the product ids only.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn e(pid: u16, name: &'static str, via: Via) -> Model {
    Model::new("mk-eweadn", 0x372E, pid, name, Kind::Mouse, via).page(0xFF00).usage(0x0001).feature(Len::Eq(64))
}
pub static MODELS: &[Model] = &[e(0x103D, "EWEADN wireless mouse", Via::Receiver), e(0x1027, "EWEADN S9 Ultra", Via::Cable)];

pub const fn query(cmd: u8, sub: u8) -> [u8; 7] {
    [0x03, 0x50u8.wrapping_add(cmd).wrapping_add(sub), 0x50, 0x00, 0x00, cmd, sub]
}
pub const ONLINE: [u8; 7] = query(0x47, 0x00);
pub const BASICS: [u8; 7] = query(0x4F, 0x81);

/// The data of a reply, or None.
pub fn data(r: &[u8]) -> Option<Vec<u8>> {
    if r.len() < 8 || r[0] != 0x03 || r[2] != 0 || r[4] != 0 {
        return None;
    }
    let n = usize::from(r[3]);
    if n == 0 || 6 + n > r.len() {
        return None;
    }
    Some(r[6..6 + n].to_vec())
}

fn ask(ch: &mut Chans, q: &[u8; 7], deadline: Instant) -> Result<Vec<u8>, TErr> {
    feat_ask(&mut *ch.main, q, 0x03, 64, ms(100), 3, deadline, &mut data)
}

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    if m.via == Via::Receiver {
        match ask(ch, &ONLINE, deadline) {
            Ok(d) if d[0] != 1 => return unlinked(now),
            Ok(_) => {}
            Err(e) => return failed(&e),
        }
    }
    match ask(ch, &BASICS, deadline) {
        Ok(d) => match pct(i64::from(d[0] & 0x7F)) {
            Some(l) => got(l, charging(d[0] & 0x80 != 0), now),
            None => no_level(Charging::Unknown, now),
        },
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn eweadn() {
        let mut full = [0u8; 64];
        full[..7].copy_from_slice(&BASICS);
        assert_eq!(BASICS[1], sum8(&full[2..]), "the sum of the bytes after the id and the sum");
        let rx = model("mk-eweadn", 0x103D);
        let mut f = fake(rx);
        f.feature_replies.extend([report(0x03, 64, &[(3, 1), (6, 1)]), report(0x03, 64, &[(3, 1), (6, 0x80 | 57)])]);
        assert_eq!(read1(&mut f, rx), at(pctl(57), Charging::Yes));
        assert_eq!((f.sent.clone(), f.kinds.clone()), (vec![ONLINE.to_vec(), BASICS.to_vec()], vec![ReportKind::Feature; 2]));
        let mut f = fake(rx);
        f.feature_replies.push_back(report(0x03, 64, &[(3, 1), (6, 0)]));
        assert_eq!(read1(&mut f, rx), unlinked(7));
        let cable = model("mk-eweadn", 0x1027);
        let mut f = fake(cable);
        f.feature_replies.push_back(report(0x03, 64, &[(3, 1), (6, 100)]));
        assert_eq!(read1(&mut f, cable), at(pctl(100), Charging::No));
        assert_eq!(f.sent, vec![BASICS.to_vec()], "no link question on the cable");
        let mut f = fake(cable);
        f.feature_replies.push_back(report(0x03, 64, &[(2, 1), (3, 1), (6, 50)]));
        assert_eq!(read1(&mut f, cable), Outcome::NoAnswer, "a refused (ack 1) reply");
    }
}
