// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): JBL Quantum wireless headsets (VID 0ECB).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/jbl.cpp (GetBattery, PollQuantum350, PollJbl, kModels) at commit 285d64254216857e94ca3ea3e1deb536f863e282,
// by krisgfx9 and its contributors, GPL-3.0-or-later. Its references: JBL QuantumENGINE 2.9.4; the original's issue 259.
//   Quantum 520 / 650 / 850 / 950 (and X), «HIDV3» on vendor page FF12: feature 88 [00 DD][01 00][01][00][02 00][0D 00]
//   (get device info, feature 000D); the reply is input report 86 … [10] bit 7 error, [11–12] 0D 00, [13–14] size,
//   [15] bit 7 charging, bits 0–6 percent.
//   Quantum 350 (206B, interface 3, page 1 usage 0): feature reports 68 (01: linked) and 49 (percent) read — nothing sent.
// D1 (the original's v1.1.0 jbl.cpp at commit 7cc44f2; its references: JBL's QuantumUSBAudio.inf as listed by
// sidmax7/QuantumEngine, Tymon3310/jbl-quantum-linux QUANTUM610_PACKETS.md and QUANTUM_LINEUP.md): the Quantum 610
// (0ECB:205C, interface 5) and 360 (0ECB:2115, interface 5, 0001:0000) are read the 350's way. Their firmware answers an
// id it does not have with the last one it has, so a reply counts only when its first byte is the id asked for.
// Changed here: the Quantum 350 is a reader that only reads its feature reports (on by default); the HIDV3 reply read on
// the request collection's own input reports through a second, listening handle.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::mice::*;
use crate::model::{Charging, Kind, Level};
use crate::sched::Outcome;
use crate::transport::TErr;
use std::time::Instant;

const fn j(pid: u16, name: &'static str, via: Via) -> Model {
    Model::new("hs-jbl", 0x0ECB, pid, name, Kind::Headset, via).page(0xFF12).feature(Len::Min(11)).input(Len::Min(16))
}
pub static MODELS: &[Model] = &[
    j(0x2125, "JBL Quantum 650 Wireless", Via::Receiver),
    j(0x2126, "JBL Quantum 650 Wireless", Via::Cable),
    j(0x213B, "JBL Quantum 650X Wireless", Via::Receiver),
    j(0x213D, "JBL Quantum 650X Wireless", Via::Cable),
    j(0x2127, "JBL Quantum 950 Wireless", Via::Receiver),
    j(0x2128, "JBL Quantum 950 Wireless", Via::Cable),
    j(0x213E, "JBL Quantum 950X Wireless", Via::Receiver),
    j(0x2140, "JBL Quantum 950X Wireless", Via::Cable),
    j(0x218D, "JBL Quantum 520 Wireless", Via::Receiver),
    j(0x218E, "JBL Quantum 520 Wireless", Via::Cable),
    j(0x21A7, "JBL Quantum 520X Wireless", Via::Receiver),
    j(0x21A9, "JBL Quantum 520X Wireless", Via::Cable),
    j(0x219A, "JBL Quantum 850 Wireless", Via::Receiver),
    j(0x219B, "JBL Quantum 850 Wireless", Via::Cable),
    Model::new("hs-jbl-350", 0x0ECB, 0x206B, "JBL Quantum 350 Wireless", Kind::Headset, Via::Receiver).iface(3).page(0x0001).usage(0x0000).feature(Len::Min(2)),
    // (D1, v1.1.0: the same HIDV1 GET 68 / GET 49 on the Quantum 610 — interface 5, any collection with a feature
    //  report — and the Quantum 360 — interface 5, 0001:0000.)
    Model::new("hs-jbl-350", 0x0ECB, 0x205C, "JBL Quantum 610 Wireless", Kind::Headset, Via::Receiver).iface(5).feature(Len::Min(2)),
    Model::new("hs-jbl-350", 0x0ECB, 0x2115, "JBL Quantum 360 Wireless", Kind::Headset, Via::Receiver).iface(5).page(0x0001).usage(0x0000).feature(Len::Min(2)),
];

pub const Q: [u8; 11] = [0x88, 0x00, 0xDD, 0x01, 0x00, 0x01, 0x00, 0x02, 0x00, 0x0D, 0x00];

/// The «get device info» reply for the battery feature: Some(Ok(info)), Some(Err) for an error status, None for another.
pub fn reply(r: &[u8]) -> Option<Result<u8, TErr>> {
    if r.len() < 16 || r[0] != 0x86 || r[1] != 0x00 || r[2] != 0xDD || r[3] != 0x01 || r[4] != 0x00 || r[5] != 0x01 {
        return None;
    }
    if r[10] & 0x80 != 0 {
        return Some(Err(TErr::BadReply));
    }
    if r[11] != 0x0D || r[12] != 0x00 || (r[13] == 0 && r[14] == 0) {
        return None;
    }
    Some(Ok(r[15]))
}

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    if m.driver == "hs-jbl-350" {
        let len = ch.main.feature_len().max(2);
        let linked = match ch.main.get_feature(0x68, len, deadline) {
            Ok(r) if r.len() >= 2 && r[0] == 0x68 => r[1],
            Ok(_) => return Outcome::NoAnswer,
            Err(e) => return failed(&e),
        };
        if linked != 1 {
            return unlinked(now);
        }
        return match ch.main.get_feature(0x49, len, deadline) {
            Ok(r) if r.len() >= 2 && r[0] == 0x49 => match pct(i64::from(r[1])) {
                Some(l) => got(l, Charging::Unknown, now),
                None => no_level(Charging::Unknown, now),
            },
            Ok(_) => Outcome::NoAnswer,
            Err(e) => failed(&e),
        };
    }
    match feat_then_read(ch, &Q, ms(800), deadline, &mut reply) {
        Ok(Ok(info)) if info & 0x7F <= 100 => got(pct(i64::from(info & 0x7F)).unwrap_or(Level::Unknown), charging(info & 0x80 != 0), now),
        Ok(Ok(_)) | Ok(Err(_)) => no_level(Charging::Unknown, now),
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use crate::mice::testkit::*;
    use super::*;

    #[test]
    fn quantum() {
        let m = model("hs-jbl", 0x2125);
        let mut f = fake(m);
        let mut r = vec![0u8; 20];
        r[..6].copy_from_slice(&[0x86, 0x00, 0xDD, 0x01, 0x00, 0x01]);
        r[11] = 0x0D;
        r[13] = 1;
        r[15] = 0x80 | 58;
        f.replies.push_back(vec![r.clone()]);
        assert_eq!(read1(&mut f, m), at(pctl(58), Charging::Yes));
        assert_eq!(f.sent, vec![Q.to_vec()]);
        assert_eq!(f.kinds, vec![crate::allow::ReportKind::Feature]);
        r[10] = 0x80;
        assert_eq!(reply(&r), Some(Err(TErr::BadReply)));
        let q350 = model("hs-jbl-350", 0x206B);
        assert_eq!(q350.driver().way, Way::Passive);
        let mut f = fake(q350);
        f.features.insert(0x68, vec![0x68, 0x01]);
        f.features.insert(0x49, vec![0x49, 47]);
        assert_eq!(read1(&mut f, q350), at(pctl(47), Charging::Unknown));
        assert!(f.sent.is_empty(), "nothing sent");
        f.features.insert(0x68, vec![0x68, 0x00]);
        assert_eq!(read1(&mut f, q350), unlinked(7));
    }
}
