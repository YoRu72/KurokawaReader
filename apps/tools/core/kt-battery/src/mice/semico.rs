// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Semico (VID 1A2C) tri-mode keyboards on the AA 55 CC 33 protocol —
// Attack Shark X98 (dongle 8FFF, cable A034) and AJAZZ AK820 Max Plus (dongle 8FFF, cable A036).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/semico.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its references: shrey715/openajazz, AkashPanja/Kraber, captures on an X98.
// Interface 0, FF02:0002, 65-byte reports: request [00 AA 55 CC 33 0E] (status); reply [AA 55 CC 33 0E][percent]
// [state 0 offline, 1–3 online]. Charging is not told by state 1 (it reads 1 on battery too): unknown.
// Changed here: the dongle and a cable: one card by the pair rule.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn s(pid: u16, name: &'static str, via: Via) -> Model {
    Model::new("mk-semico", 0x1A2C, pid, name, Kind::Keyboard, via).iface(0).page(0xFF02).usage(0x0002).input(Len::Eq(65)).output(Len::Eq(65)).pair("semico:kb")
}

pub static MODELS: &[Model] = &[s(0x8FFF, "Wireless keyboard", Via::Receiver).product_name(), s(0xA034, "Attack Shark X98", Via::Cable), s(0xA036, "AJAZZ AK820 Max Plus", Via::Cable)];

pub const STATUS: [u8; 6] = [0x00, 0xAA, 0x55, 0xCC, 0x33, 0x0E];

pub fn read(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Outcome {
    match out_ask(ch, &STATUS, ms(600), deadline, &mut |r| if r.len() >= 7 && r[..5] == [0xAA, 0x55, 0xCC, 0x33, 0x0E] { Some((r[5], r[6])) } else { None }) {
        Ok((_, 0)) => unlinked(now),
        Ok((p, s)) if s <= 3 && p <= 100 => got(pct(i64::from(p)).unwrap_or(Level::Unknown), Charging::Unknown, now),
        Ok(_) => no_level(Charging::Unknown, now),
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn semico() {
        let m = model("mk-semico", 0x8FFF);
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x00, 0xAA, 0x55, 0xCC, 0x33, 0x0E, 96, 1]]);
        assert_eq!(read1(&mut f, m), at(pctl(96), Charging::Unknown));
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x00, 0xAA, 0x55, 0xCC, 0x33, 0x0E, 0, 0]]);
        assert_eq!(read1(&mut f, m), unlinked(7));
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x00, 0xAA, 0x55, 0xCC, 0x33, 0x0E, 50, 4]]);
        assert_eq!(read1(&mut f, m), no_level(Charging::Unknown, 7));
    }
}
