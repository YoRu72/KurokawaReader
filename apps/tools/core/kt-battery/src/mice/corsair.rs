// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Corsair's Slipstream mice and keyboards over the «Bragi» protocol
// (VID 1B1C). The Compx mice (Sabre V2 Pro Ultralight) are kysona.rs's.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/corsair.cpp (Bragi, kPairedModels, PollCorsair) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by
// krisgfx9 and its contributors, GPL-3.0-or-later. Its reference: OpenRGB's Corsair Bragi notes.
// GET: [02][target][02][property] (a 64-byte numbered collection), [00][02][target][02][property] (65, report id 0) or
// the «plain» framing [00][target][02][property] (newer Slipstream receivers); reply [source][02][status][value LE ×4]
// (after a 02 in the first two framings), source 00 for target 08 (the unit itself), 01 for a paired device; status 0
// is «ok». Properties read: 0F battery 0–1000, 10 charge state (1 charging, 3 full), 12 the paired device's product id.
// Targets 09–0B are the devices paired to a receiver (one card each), 08 the unit itself (cable or Bluetooth).
// Only GET is sent (allow.rs's templates bound target and property); nothing switches the device to software mode.
// Changed here: only the products the original names as Slipstream receivers of mice and keyboards (2B00, and 1BDC from
// its tested pairing) — it sent these GETs to every 1B1C product with a 64/65-byte vendor collection; the Void, HS and
// Virtuoso headsets (C9 64, and the Bragi ids 0Axx, 2A02, 2A08) are the headset piece's, and a headset found behind a
// receiver (paired id 0Axx) is left to it; the 0–1000 level rounded to whole per cent (finer than per cent: not invented
// precision; the original added 5 then divided by 10 and clamped); a level of 0 or over 1000 after its two retries is
// no level (the original skipped the target).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

pub const BATTERY: u8 = 0x0F;
pub const CHARGE: u8 = 0x10;
pub const PRODUCT: u8 = 0x12;
pub const PROPS: [u8; 3] = [BATTERY, CHARGE, PRODUCT];
pub const SELF: u8 = 0x08;
pub const PAIRED: [u8; 3] = [0x09, 0x0A, 0x0B];

const fn b(pid: u16, out: u16, name: &'static str) -> Model {
    Model::new("mk-corsair-bragi", 0x1B1C, pid, name, Kind::Mouse, Via::Receiver).vendor_page().output(Len::Eq(out)).input(Len::Min(64)).slots(&PAIRED).product_name().arg(if out == 64 { 1 } else { 0 })
}

pub static MODELS: &[Model] = &[
    b(0x2B00, 64, "Corsair Slipstream receiver"),
    b(0x2B00, 65, "Corsair Slipstream receiver"),
    b(0x1BDC, 64, "Corsair Slipstream receiver"),
    b(0x1BDC, 65, "Corsair Slipstream receiver"),
];

/// Devices seen behind a receiver, by the product id they report (property 12).
pub fn paired_name(pid: u32) -> Option<(&'static str, Kind)> {
    match pid {
        0x1B7E => Some(("Corsair Dark Core RGB Pro SE", Kind::Mouse)),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Framing {
    Numbered,
    Zero,
    Plain,
}

fn frame(f: Framing, target: u8, prop: u8) -> Vec<u8> {
    match f {
        Framing::Numbered => vec![0x02, target, 0x02, prop],
        Framing::Zero => vec![0x00, 0x02, target, 0x02, prop],
        Framing::Plain => vec![0x00, target, 0x02, prop],
    }
}

/// A reply's value (Some(Err(status)) for a status other than 0), when `r` (report id 0 dropped) answers `target`.
pub fn reply(r: &[u8], plain: bool, target: u8) -> Option<Result<u32, u8>> {
    let o = if plain { 0 } else { 1 };
    if r.len() < o + 7 {
        return None;
    }
    let source = if target == SELF { 0x00 } else { 0x01 };
    if r[o] != source || r[o + 1] != 0x02 {
        return None;
    }
    if r[o + 2] != 0 {
        return Some(Err(r[o + 2]));
    }
    Some(Ok(u32::from(r[o + 3]) | u32::from(r[o + 4]) << 8 | u32::from(r[o + 5]) << 16 | u32::from(r[o + 6]) << 24))
}

struct Bragi {
    numbered: bool,
    framing: Option<Framing>,
}

impl Bragi {
    fn get(&mut self, ch: &mut Chans, target: u8, prop: u8, deadline: Instant) -> Result<Option<u32>, TErr> {
        let tries: &[Framing] = match (self.framing, self.numbered) {
            (Some(Framing::Numbered), _) | (None, true) => &[Framing::Numbered],
            (Some(Framing::Zero), _) => &[Framing::Zero],
            (Some(Framing::Plain), _) => &[Framing::Plain],
            (None, false) => &[Framing::Zero, Framing::Plain],
        };
        let mut last = Err(TErr::Timeout);
        for &f in tries {
            let plain = f == Framing::Plain;
            match out_ask(ch, &frame(f, target, prop), ms(300), deadline, &mut |r| reply(r, plain, target)) {
                Ok(v) => {
                    self.framing = Some(f);
                    return Ok(v.ok());
                }
                Err(TErr::Gone) => return Err(TErr::Gone),
                Err(e) => last = Err(e),
            }
        }
        last
    }
}

fn read_target(bg: &mut Bragi, ch: &mut Chans, target: u8, deadline: Instant, now: u64) -> Result<Answer, TErr> {
    let mut level = bg.get(ch, target, BATTERY, deadline)?;
    for _ in 0..2 {
        match level {
            Some(v) if (1..=1000).contains(&v) => break,
            Some(_) => level = bg.get(ch, target, BATTERY, deadline)?,
            None => break,
        }
    }
    let mut a: Answer = match level {
        Some(v) if v <= 1000 => {
            let c = match bg.get(ch, target, CHARGE, deadline) {
                Ok(Some(1)) | Ok(Some(3)) => Charging::Yes,
                Ok(Some(_)) => Charging::No,
                _ => Charging::Unknown,
            };
            got(if v == 0 { Level::Unknown } else { scaled(i64::from(v), 1000).unwrap_or(Level::Unknown) }, c, now).into()
        }
        _ => return Err(TErr::BadReply),
    };
    if target != SELF {
        if let Ok(Some(p)) = bg.get(ch, target, PRODUCT, deadline) {
            if p >> 8 == 0x0A {
                // (A headset behind the receiver: the headset piece's.)
                return Err(TErr::Refused);
            }
            if let Some((n, k)) = paired_name(p) {
                a.name = Some(n.to_string());
                a.kind = Some(k);
            }
        }
    }
    Ok(a)
}

/// One unit: `slot` a paired device (09–0B); None probes the paired targets (Answer::slots), and with none the unit
/// itself (08: on its cable or Bluetooth).
pub fn read_bragi(ch: &mut Chans, m: &Model, slot: Option<u8>, deadline: Instant, now: u64) -> Answer {
    let mut bg = Bragi { numbered: m.arg == 1, framing: None };
    if let Some(s) = slot {
        if !m.slots.contains(&s) {
            return Outcome::Failed.into();
        }
        return match read_target(&mut bg, ch, s, deadline, now) {
            Ok(a) => a,
            Err(TErr::Gone) => Outcome::Failed.into(),
            Err(_) => dozing(now).into(),
        };
    }
    let mut present = Vec::new();
    let mut first: Option<Answer> = None;
    for &t in m.slots {
        match read_target(&mut bg, ch, t, deadline, now) {
            Ok(a) => {
                present.push(t);
                first.get_or_insert(a);
            }
            Err(TErr::Gone) => return Outcome::Failed.into(),
            Err(_) => {}
        }
        if Instant::now() >= deadline {
            break;
        }
    }
    if let Some(mut a) = first {
        a.slots = Some(present);
        return a;
    }
    match read_target(&mut bg, ch, SELF, deadline, now) {
        Ok(a) => a,
        Err(TErr::Gone) => Outcome::Failed.into(),
        Err(_) if bg.framing.is_some() => Answer { out: unlinked(now), slots: Some(Vec::new()), name: None, kind: None, unit: None },
        Err(_) => Outcome::NoAnswer.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    fn rep(source: u8, status: u8, v: u32) -> Vec<u8> {
        let mut r = vec![0u8; 64];
        r[0] = 0x02;
        r[1] = source;
        r[2] = 0x02;
        r[3] = status;
        r[4..8].copy_from_slice(&v.to_le_bytes());
        r
    }

    #[test]
    fn a_receiver_with_a_paired_mouse() {
        let m = all_models().find(|m| m.driver == "mk-corsair-bragi" && m.arg == 1).unwrap();
        let mut f = fake(m);
        // (Target 09: level 873, charging 1, product 1B7E; 0A and 0B: no answer.)
        f.replies.extend([vec![rep(1, 0, 873)], vec![rep(1, 0, 1)], vec![rep(1, 0, 0x1B7E)]]);
        let a = crate::mice::read(&mut Chans::one(&mut f), m, None, true, soon(), 7);
        assert_eq!(a.out, at(pctl(87), Charging::Yes));
        assert_eq!(a.slots, Some(vec![0x09]));
        assert_eq!(a.name.as_deref(), Some("Corsair Dark Core RGB Pro SE"));
        assert_eq!(&f.sent[..3], &[vec![0x02, 0x09, 0x02, 0x0F], vec![0x02, 0x09, 0x02, 0x10], vec![0x02, 0x09, 0x02, 0x12]]);
        assert!(f.sent.iter().all(|b| b.len() == 4 && b[2] == 0x02), "GET only");
    }

    #[test]
    fn replies_are_checked() {
        assert_eq!(reply(&rep(1, 0, 500)[..], false, 0x09), Some(Ok(500)));
        assert_eq!(reply(&rep(0, 0, 500)[..], false, 0x09), None, "another source: another reply");
        assert_eq!(reply(&rep(1, 5, 0)[..], false, 0x09), Some(Err(5)));
        assert_eq!(reply(&rep(1, 0, 500)[..6], false, 0x09), None, "short");
        assert_eq!(reply(&[0x00, 0x02, 0x00, 0xE8, 0x03, 0, 0], true, SELF), Some(Ok(1000)));
    }

    #[test]
    fn out_of_range_headset_and_slot_reads() {
        let m = all_models().find(|m| m.driver == "mk-corsair-bragi" && m.arg == 1).unwrap();
        // (A level over 1000, three times: no reading for that target; the unit itself then answers status 5.)
        let mut f = fake(m);
        f.replies.extend([vec![rep(1, 0, 1500)], vec![rep(1, 0, 1500)], vec![rep(1, 0, 1500)]]);
        let a = crate::mice::read(&mut Chans::one(&mut f), m, Some(0x09), true, soon(), 7);
        assert_eq!(a.out, dozing(7));
        // (A headset behind the receiver: left to the headset piece.)
        let mut f = fake(m);
        f.replies.extend([vec![rep(1, 0, 600)], vec![rep(1, 0, 0)], vec![rep(1, 0, 0x0A3E)]]);
        let a = crate::mice::read(&mut Chans::one(&mut f), m, Some(0x09), true, soon(), 7);
        assert_eq!(a.out, dozing(7));
        // (A slot the receiver does not have: nothing sent.)
        let mut f = fake(m);
        assert_eq!(crate::mice::read(&mut Chans::one(&mut f), m, Some(0x08), true, soon(), 7).out, Outcome::Failed);
        assert!(f.sent.is_empty());
        // (The unit itself on its cable.)
        let mut f = fake(m);
        f.replies.extend([vec![], vec![], vec![], vec![rep(0, 0, 1000)], vec![rep(0, 0, 3)]]);
        let a = crate::mice::read(&mut Chans::one(&mut f), m, None, true, soon(), 7);
        assert_eq!(a.out, at(pctl(100), Charging::Yes));
    }
}
