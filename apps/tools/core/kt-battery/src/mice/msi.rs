// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): MSI wireless mice — VERSA 300 ELITE WIRELESS (0DB0:9E22) and CLUTCH
// GM31 Lightweight Wireless (receiver 0D3C, cable 0D3B).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/msi.cpp (kModels, QueryStatus) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its
// contributors, GPL-3.0-or-later (from MSI Center's Gaming Gear module).
// Interface 1 (FF0D:00B0 or FF00:0001), 65-byte reports: output 00 0F 20 → [0F][20]…[14] bit 7 charging, bits 0–6
// percent. 0 while not charging: asleep. MSI Center's 41 80 («remote control»: a software control mode) is never sent.
// Not ported: the CLUTCH GM41 (0D4C / 0D4B), which only pushes a raw byte that falls as the battery drains; the
// original made a percentage of it from a three-point line — it would be a made-up level.
// Changed here: the cable and the receiver of the GM31: one card by the pair rule.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn m(pid: u16, page: u16, usage: u16, name: &'static str, via: Via, pair: &'static str) -> Model {
    Model::new("mk-msi", 0x0DB0, pid, name, Kind::Mouse, via).iface(1).page(page).usage(usage).input(Len::Min(65)).output(Len::Min(65)).pair(pair)
}

pub static MODELS: &[Model] = &[
    m(0x9E22, 0xFF0D, 0x00B0, "MSI VERSA 300 ELITE WIRELESS", Via::Receiver, ""),
    m(0x0D3C, 0xFF00, 0x0001, "MSI Clutch GM31 Lightweight Wireless", Via::Receiver, "msi:gm31"),
    m(0x0D3B, 0xFF00, 0x0001, "MSI Clutch GM31 Lightweight Wireless", Via::Cable, "msi:gm31"),
];

pub const STATUS: [u8; 3] = [0x00, 0x0F, 0x20];

pub fn read(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Outcome {
    match out_ask(ch, &STATUS, ms(1000), deadline, &mut |r| if r.len() >= 15 && r[0] == 0x0F && r[1] == 0x20 { Some(r[14]) } else { None }) {
        Ok(b) => {
            let (p, c) = (b & 0x7F, b & 0x80 != 0);
            if p == 0 && !c {
                dozing(now)
            } else {
                match pct(i64::from(p)) {
                    Some(l) => got(l, charging(c), now),
                    None => no_level(charging(c), now),
                }
            }
        }
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn gm31() {
        // (MSI Center's own reading: 0F 20 00 00 23 05 7A 91 00 00 00 00 05 80 56 = 86 %.)
        let m = model("mk-msi", 0x0D3C);
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x00, 0x0F, 0x20, 0x00, 0x00, 0x23, 0x05, 0x7A, 0x91, 0, 0, 0, 0, 0x05, 0x80, 0x56]]);
        assert_eq!(read1(&mut f, m), at(pctl(86), Charging::No));
        assert_eq!(f.sent, vec![STATUS.to_vec()]);
        let mut f = fake(m);
        f.replies.push_back(vec![report(0x00, 16, &[(1, 0x0F), (2, 0x20), (15, 0)])]);
        assert_eq!(read1(&mut f, m), dozing(7));
        assert!(find(&HidIdent { vid: 0x0DB0, pid: 0x0D4C, usage_page: 0xFF10, usage: 6, interface: 1 }, 7, 0, 0).is_none(), "GM41: not ported");
    }
}
