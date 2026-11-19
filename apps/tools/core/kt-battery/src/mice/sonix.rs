// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): SONiX keyboards on their 2.4 GHz dongles — AJAZZ AK820 MAX and AULA
// F108 Pro (05AC:024F: the dongle reuses Apple's vendor id) and AJAZZ AK980 V2 (0C45:FEFE).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/sonix.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its reference: donglover69/sonix-keyboard-studio («2.4G dongles»).
// Interface 3, FF60:0061, 33-byte reports (report id 0): [20][01][00 …][sum of the 31 bytes before]; reply the same
// head, [3] the level, the same checksum. 0: the keyboard off, away or in another mode.
// D1 (the original's v1.1.0 sonix.cpp at commit 7cc44f2; deddroid/ak820-rs, usharik/ak820-studio): the AJAZZ AK820 Pro's
// receiver 0C45:FDFD; a reply is known by its echoed head [20 01 00] (as the AK820 Pro tools do), its checksum no longer
// required.
// Changed here: matched by the product AND interface 3 AND FF60:0061 AND both 33-byte lengths (an Apple keyboard with
// the same product id has no such collection: allow.rs names the interface and page too).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn s(vid: u16, pid: u16) -> Model {
    Model::new("mk-sonix", vid, pid, "Wireless keyboard", Kind::Keyboard, Via::Receiver).iface(3).page(0xFF60).usage(0x0061).input(Len::Eq(33)).output(Len::Eq(33)).product_name()
}

pub static MODELS: &[Model] = &[s(0x05AC, 0x024F), s(0x0C45, 0xFEFE), s(0x0C45, 0xFDFD)];

pub const fn frame() -> [u8; 33] {
    let mut b = [0u8; 33];
    b[1] = 0x20;
    b[2] = 0x01;
    b[32] = 0x21;
    b
}
pub static REQUEST: [u8; 33] = frame();

pub fn read(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Outcome {
    let mut last = Err(TErr::Timeout);
    // (The first request may go unanswered while the link wakes: once more.)
    for _ in 0..2 {
        last = out_ask(ch, &REQUEST, ms(500), deadline, &mut |r| if r.len() >= 4 && r[0] == 0x20 && r[1] == 0x01 && r[2] == 0x00 { Some(r[3]) } else { None });
        if last.is_ok() || last == Err(TErr::Gone) {
            break;
        }
    }
    match last {
        Ok(l) if (1..=100).contains(&l) => got(pct(i64::from(l)).unwrap_or(Level::Unknown), Charging::Unknown, now),
        Ok(_) => unlinked(now),
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn sonix() {
        assert_eq!(REQUEST[32], sum8(&REQUEST[1..32]));
        let m = model("mk-sonix", 0x024F);
        let mut r = report(0x00, 33, &[(1, 0x20), (2, 0x01), (4, 64)]);
        r[32] = sum8(&r[1..32]);
        let mut f = fake(m);
        f.replies.push_back(vec![r.clone()]);
        assert_eq!(read1(&mut f, m), at(pctl(64), Charging::Unknown));
        r[32] ^= 1;
        let mut f = fake(m);
        f.replies.extend([vec![r.clone()], vec![r.clone()]]);
        assert_eq!(read1(&mut f, m), at(pctl(64), Charging::Unknown), "D1: the echo decides, the checksum is not checked (as the AK820 Pro tools)");
        r[3] = 0x01;
        let mut f = fake(m);
        f.replies.extend([vec![r.clone()], vec![r]]);
        assert_eq!(read1(&mut f, m), Outcome::NoAnswer, "another echo");
        assert_eq!(model("mk-sonix", 0xFDFD).vid, 0x0C45, "the AK820 Pro's receiver");
        // (An Apple keyboard 05AC:024F has no FF60:0061 collection on interface 3: not this reader's.)
        assert!(find(&HidIdent { vid: 0x05AC, pid: 0x024F, usage_page: 0x0001, usage: 6, interface: 0 }, 9, 2, 0).is_none());
        assert!(find(&HidIdent { vid: 0x05AC, pid: 0x024F, usage_page: 0xFF60, usage: 0x61, interface: 1 }, 33, 33, 0).is_none());
    }
}
