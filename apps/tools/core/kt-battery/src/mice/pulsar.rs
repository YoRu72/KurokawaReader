// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Pulsar X2 V3 / X2 V3 eS and other Sonix-based Pulsar mice (VID 3710).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/pulsar.cpp (kProducts, ReadBattery, PollPulsar) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by
// krisgfx9 and its contributors, GPL-3.0-or-later. Its references: darthsoup/PulsarBattery, bluesceada/pulsar-mouse-linux.
// Feature report 0, 64-byte packet [00][08][81][01][00 …][sum lo][sum hi] (sum = the 16-bit sum of packet bytes 0–61),
// read back until it echoes 08 81 01: [status][08][81][01][..][..][percent] (FF: no reading). Status 01 answered, 02
// pending; 05 «not linked / asleep» (one source) or «pending» (the other): taken as asleep only if still the answer at
// the end. Higher interfaces first (interface 2 rejects the request). On the cable the mouse is charging.
// Changed here: percent 0 from a dongle is «not linked» (as the original), FF no reading; the dongles shared by several
// models name the mouse by its product string.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn p(pid: u16, name: &'static str, via: Via) -> Model {
    Model::new("mk-pulsar", 0x3710, pid, name, Kind::Mouse, via).feature(Len::Min(65))
}

pub static MODELS: &[Model] = &[
    p(0x3402, "Pulsar X2 V3", Via::Cable),
    p(0x3406, "Pulsar X2 V3 eS", Via::Cable),
    p(0x5402, "Pulsar wireless mouse", Via::Receiver).product_name(),
    p(0x5403, "Pulsar wireless mouse", Via::Receiver).product_name(),
];

pub const fn frame() -> [u8; 65] {
    let mut b = [0u8; 65];
    b[2] = 0x08;
    b[3] = 0x81;
    b[4] = 0x01;
    // (Packet bytes 0–61 = request bytes 1–62: 08 + 81 + 01 = 8A.)
    b[63] = 0x8A;
    b[64] = 0x00;
    b
}
pub static REQUEST: [u8; 65] = frame();

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    let cable = m.via == Via::Cable;
    let mut saw_off = false;
    for _ in 0..3 {
        let r = feat_ask(&mut *ch.main, &REQUEST, 0x00, 65, ms(50), 6, deadline, &mut |r| {
            if r.len() < 65 || r[2] != 0x08 || r[3] != 0x81 || r[4] != 0x01 {
                return None;
            }
            match r[1] {
                0x01 => Some(Some(r[7])),
                0x05 => {
                    saw_off = true;
                    None
                }
                _ => None,
            }
        });
        match r {
            Ok(Some(v)) if v <= 100 => {
                if v == 0 && !cable {
                    return unlinked(now);
                }
                return got(pct(i64::from(v)).unwrap_or(Level::Unknown), if cable { Charging::Yes } else { Charging::Unknown }, now);
            }
            Ok(_) => return no_level(if cable { Charging::Yes } else { Charging::Unknown }, now),
            Err(TErr::BadReply) => continue,
            Err(e) => return failed(&e),
        }
    }
    if saw_off {
        dozing(now)
    } else {
        Outcome::NoAnswer
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn pulsar() {
        let sum: u32 = REQUEST[1..63].iter().map(|&b| u32::from(b)).sum();
        assert_eq!((REQUEST[63], REQUEST[64]), ((sum & 0xFF) as u8, (sum >> 8) as u8));
        let m = model("mk-pulsar", 0x5402);
        let mut f = fake(m);
        f.feature_replies.push_back(report(0x00, 65, &[(1, 0x01), (2, 0x08), (3, 0x81), (4, 0x01), (7, 66)]));
        assert_eq!(read1(&mut f, m), at(pctl(66), Charging::Unknown));
        assert_eq!(f.sent, vec![REQUEST.to_vec()]);
        let mut f = fake(m);
        f.feature_replies.push_back(report(0x00, 65, &[(1, 0x01), (2, 0x08), (3, 0x81), (4, 0x01), (7, 0xFF)]));
        assert_eq!(read1(&mut f, m), no_level(Charging::Unknown, 7), "FF: no reading");
        let mut f = fake(m);
        f.features.insert(0, report(0x00, 65, &[(1, 0x05), (2, 0x08), (3, 0x81), (4, 0x01)]));
        assert_eq!(read1(&mut f, m), dozing(7), "05 to the end: asleep");
        let c = model("mk-pulsar", 0x3402);
        let mut f = fake(c);
        f.feature_replies.push_back(report(0x00, 65, &[(1, 0x01), (2, 0x08), (3, 0x81), (4, 0x01), (7, 0)]));
        assert_eq!(read1(&mut f, c), at(pctl(0), Charging::Yes), "0 % on the cable is 0 %");
    }
}
