// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Jabra headsets behind a Jabra Link 380 / 390 dongle (VID 0B0E).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/jabra.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its reference: Watchdog0x/jabridge (jabraApi.go).
//   Jabra's GNP protocol on the vendor collection FF00 (report 05, 64 bytes): query [05][dst 04 the headset][src 00]
//   [seq][46][class][op]; reply [05][00][04][seq][C0 | len][class][op][payload]; class FE = NAK (the headset is off).
//   Battery: class 12 op 02 → [flags: bit 0 charging][level]. Name: class 02 op 00 → [n][n bytes UTF-8].
// Changed here: the sequence number from the clock (allow.rs's template takes any for exactly these two queries); the
// name asked with each reading that has a level (no global cache), shown from the next round.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::mice::*;
use crate::model::{Kind, Level};
#[cfg(test)]
use crate::model::Charging;
use crate::sched::Outcome;
use crate::transport::TErr;
use std::time::Instant;

pub const PIDS: [u16; 9] = [0x24C7, 0x24C8, 0x24C9, 0x24CA, 0x24E9, 0x2E50, 0x2E51, 0x2E56, 0x2E57];
pub static MODELS: [Model; 9] = many(Model::new("hs-jabra", 0x0B0E, 0, "Jabra headset", Kind::Headset, Via::Receiver).page(0xFF00).output(Len::Min(64)).input(Len::Min(64)), PIDS);

pub fn query(seq: u8, class: u8, op: u8) -> [u8; 7] {
    [0x05, 0x04, 0x00, seq, 0x46, class, op]
}

#[derive(Debug, PartialEq)]
pub enum Rep {
    Ok(Vec<u8>),
    Nak,
}

pub fn reply(r: &[u8], seq: u8, class: u8, op: u8) -> Option<Rep> {
    if r.len() < 6 || r[0] != 0x05 || r[1] != 0x00 || r[2] != 0x04 || r[3] != seq || r[4] & 0xC0 != 0xC0 {
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

pub fn read(ch: &mut Chans, deadline: Instant, now: u64) -> Answer {
    let seq = ((now / 1000) as u8).wrapping_mul(2);
    let out = match out_ask(ch, &query(seq, 0x12, 0x02), ms(700), deadline, &mut |r| reply(r, seq, 0x12, 0x02)) {
        Ok(Rep::Nak) => return unlinked(now).into(),
        Ok(Rep::Ok(p)) if p.len() >= 2 => got(pct(i64::from(p[1])).unwrap_or(Level::Unknown), charging(p[0] & 0x01 != 0), now),
        Ok(Rep::Ok(_)) => return Outcome::NoAnswer.into(),
        Err(e) => return failed(&e).into(),
    };
    let s2 = seq.wrapping_add(1);
    let name = match out_ask(ch, &query(s2, 0x02, 0x00), ms(400), deadline, &mut |r| reply(r, s2, 0x02, 0x00)) {
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
    }
}
