// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Jabra headsets behind a Jabra Link 380 / 390 dongle (VID 0B0E).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/jabra.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its reference: Watchdog0x/jabridge (jabraApi.go).
//   Jabra's GNP protocol on the vendor collection FF00 (report 05, 64 bytes): query [05][dst 04 the headset][src 00]
//   [seq][46][class][op]; reply [05][00][04][seq][C0 | len][class][op][payload]; class FE = NAK (the headset is off).
//   Battery: class 12 op 02 → [flags: bit 0 charging][level]. Name: class 02 op 00 → [n][n bytes UTF-8].
// D1 (the original's v1.1.0 jabra.cpp at commit 7cc44f2; its references: Jabra Direct's FWU/DeviceInfo.xml,
// HeadsetControl's GNP driver): a GNP headset on its own USB cable answers at address 08 (a Link dongle's headset at 04);
// verified there on the Evolve3 75's cable (0B0E:2548, its usage-05 collection). That product is added here with that
// address. Not taken: v1.1.0 now asks every Jabra product with the vendor collection (a claim by vendor alone) and
// tries both addresses on each — here the products stay listed by id, each with its one address.
// Changed here: the sequence number from the clock (allow.rs's template takes any for exactly these two queries); the
// name asked with each reading that has a level (no global cache), shown from the next round.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::mice::*;
use crate::model::{Charging, Kind, Level};
use crate::sched::Outcome;
use crate::transport::TErr;
use std::time::Instant;

pub const PIDS: [u16; 9] = [0x24C7, 0x24C8, 0x24C9, 0x24CA, 0x24E9, 0x2E50, 0x2E51, 0x2E56, 0x2E57];
pub static MODELS: [Model; 9] = many(Model::new("hs-jabra", 0x0B0E, 0, "Jabra headset", Kind::Headset, Via::Receiver).page(0xFF00).output(Len::Min(64)).input(Len::Min(64)), PIDS);

/// D1: Evolve3 75 on its USB cable — the headset itself at GNP address 08.
pub static CABLE: [Model; 1] = [Model::new("hs-jabra", 0x0B0E, 0x2548, "Jabra headset", Kind::Headset, Via::Cable).page(0xFF00).usage(0x0005).output(Len::Min(64)).input(Len::Min(64)).arg(0x08)];

/// The headset's GNP address on this product: 08 on its own cable, 04 behind a Link dongle.
pub fn address(m: &Model) -> u8 {
    if m.arg == 0x08 {
        0x08
    } else {
        0x04
    }
}

pub fn query(seq: u8, class: u8, op: u8) -> [u8; 7] {
    query_at(0x04, seq, class, op)
}
pub fn query_at(dst: u8, seq: u8, class: u8, op: u8) -> [u8; 7] {
    [0x05, dst, 0x00, seq, 0x46, class, op]
}

#[derive(Debug, PartialEq)]
pub enum Rep {
    Ok(Vec<u8>),
    Nak,
}

pub fn reply(r: &[u8], seq: u8, class: u8, op: u8) -> Option<Rep> {
    reply_at(r, 0x04, seq, class, op)
}
pub fn reply_at(r: &[u8], dst: u8, seq: u8, class: u8, op: u8) -> Option<Rep> {
    if r.len() < 6 || r[0] != 0x05 || r[1] != 0x00 || r[2] != dst || r[3] != seq || r[4] & 0xC0 != 0xC0 {
        return None;
    }
    if r[5] == 0xFE {
        return Some(Rep::Nak);
    }
    let len = usize::from(r[4] & 0x3F);
    if r.len() < 7 || r[5] != class || r[6] != op || len < 6 || len + 1 > r.len() {
        return None;
    }
    Some(Rep::Ok(r[7..=len].to_vec()))
}

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Answer {
    let a = address(m);
    let seq = ((now / 1000) as u8).wrapping_mul(2);
    let out = match out_ask(ch, &query_at(a, seq, 0x12, 0x02), ms(700), deadline, &mut |r| reply_at(r, a, seq, 0x12, 0x02)) {
        // (On its own cable a NAK is no battery at that address; behind a dongle, the headset off.)
        Ok(Rep::Nak) if a == 0x08 => return no_level(Charging::Unknown, now).into(),
        Ok(Rep::Nak) => return unlinked(now).into(),
        Ok(Rep::Ok(p)) if p.len() >= 2 => got(pct(i64::from(p[1])).unwrap_or(Level::Unknown), charging(p[0] & 0x01 != 0), now),
        Ok(Rep::Ok(_)) => return Outcome::NoAnswer.into(),
        Err(e) => return failed(&e).into(),
    };
    let s2 = seq.wrapping_add(1);
    let name = match out_ask(ch, &query_at(a, s2, 0x02, 0x00), ms(400), deadline, &mut |r| reply_at(r, a, s2, 0x02, 0x00)) {
        Ok(Rep::Ok(p)) if !p.is_empty() && p[0] > 0 && usize::from(p[0]) < p.len() => String::from_utf8(p[1..=usize::from(p[0])].to_vec()).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && !s.chars().any(char::is_control)),
        Err(TErr::Gone) => return failed(&TErr::Gone).into(),
        _ => None,
    };
    Answer { out, slots: None, name, kind: None, unit: None }
}

#[cfg(test)]
mod tests {
    use crate::mice::testkit::*;
    use super::*;
    use crate::allow::{permit, ReportKind};

    #[test]
    fn link_dongle() {
        let m = model("hs-jabra", 0x2E51);
        let mut f = fake(m);
        let seq = ((7u64 / 1000) as u8).wrapping_mul(2);
        let mut name = vec![0x05, 0x00, 0x04, seq + 1, 0xC0 | 15, 0x02, 0x00, 8];
        name.extend_from_slice(b"Evolve75");
        f.replies.extend([vec![vec![0x05, 0x00, 0x04, seq, 0xC0 | 8, 0x12, 0x02, 0x01, 66]], vec![name]]);
        let a = crate::mice::read(&mut Chans::one(&mut f), m, None, true, soon(), 7);
        assert_eq!(a.out, at(pctl(66), Charging::Yes));
        assert_eq!(a.name.as_deref(), Some("Evolve75"));
        assert_eq!(f.sent, vec![query(seq, 0x12, 0x02).to_vec(), query(seq + 1, 0x02, 0x00).to_vec()]);
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x05, 0x00, 0x04, seq, 0xC6, 0xFE, 0x00]]);
        assert_eq!(read1(&mut f, m), unlinked(7), "NAK: the headset is off");
        assert_eq!(reply(&[0x05, 0x00, 0x04, 9, 0xC8, 0x12, 0x02, 1], 9, 0x12, 0x02), None, "a length past the report");
        assert_eq!(reply(&[0x05, 0x00, 0x04, 8, 0xC8, 0x12, 0x02, 1, 2], 9, 0x12, 0x02), None, "another sequence");
        // (D1: the Evolve3 75 on its cable, address 08.)
        let c = model("hs-jabra", 0x2548);
        let mut f = fake(c);
        f.replies.extend([vec![vec![0x05, 0x00, 0x08, seq, 0xC0 | 8, 0x12, 0x02, 0x00, 54]], vec![]]);
        assert_eq!(read1(&mut f, c), at(pctl(54), Charging::No));
        assert_eq!(f.sent[0], query_at(0x08, seq, 0x12, 0x02).to_vec());
        let mut f = fake(c);
        f.replies.push_back(vec![vec![0x05, 0x00, 0x04, seq, 0xC0 | 8, 0x12, 0x02, 0x00, 54]]);
        assert_eq!(read1(&mut f, c), Outcome::NoAnswer, "a reply from another address");
        let mut f = fake(c);
        f.replies.push_back(vec![vec![0x05, 0x00, 0x08, seq, 0xC6, 0xFE, 0x10]]);
        assert_eq!(read1(&mut f, c), no_level(Charging::Unknown, 7), "NAK on the cable: no battery there");
        assert!(permit(&ident(c), ReportKind::Output, &query_at(0x08, 3, 0x12, 0x02)).is_some());
        assert!(permit(&ident(c), ReportKind::Output, &query(3, 0x12, 0x02)).is_none(), "the dongle's address on the cable");
        assert!(permit(&ident(m), ReportKind::Output, &query_at(0x08, 3, 0x12, 0x02)).is_none(), "the cable's address on a dongle");
    }
}
