// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): WLMouse (VID 36A7) Beast X / Sword X families on the «83» protocol.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/wlmouse.cpp (kModels, Query, PollWlmouse) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by
// krisgfx9 and its contributors, GPL-3.0-or-later. Its references: djnawara/mouse-gauge, Waturus/HaloBattery.
// The vendor collection FFFF (65-byte feature report 0); status A1 / A2 answered, A0 the mouse asleep.
// Not here, as in the original: A887 / A888 (Beast X 4K, the first Beast X) — the sources disagree on their protocol.
// Changed here: a mouse on its cable with its receiver also plugged in: one card by the pair rule.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn w(pid: u16, name: &'static str, via: Via, pair: &'static str) -> Model {
    Model::new("mk-wlmouse", 0x36A7, pid, name, Kind::Mouse, via).page(0xFFFF).feature(Len::Min(65)).pair(pair)
}

pub static MODELS: &[Model] = &[
    w(0xA879, "WLMouse Sword X 8K", Via::Cable, "wl:swordx"),
    w(0xA884, "WLMouse Beast X 8K", Via::Cable, "wl:beastx8k"),
    w(0xA860, "WLMouse mouse", Via::Cable, ""),
    w(0xA866, "WLMouse mouse", Via::Cable, ""),
    w(0xA867, "WLMouse mouse", Via::Cable, ""),
    w(0xA856, "WLMouse Beast X V2", Via::Receiver, ""),
    w(0xA868, "WLMouse Beast X Mini Pro", Via::Receiver, ""),
    w(0xA870, "WLMouse Beast X Pro", Via::Receiver, ""),
    w(0xA878, "WLMouse Sword X 8K", Via::Receiver, "wl:swordx"),
    w(0xA880, "WLMouse Beast MAX", Via::Receiver, ""),
    w(0xA883, "WLMouse Beast X 8K", Via::Receiver, "wl:beastx8k"),
    w(0xA885, "WLMouse Beast X Mini", Via::Receiver, ""),
];

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn beast() {
        let m = model("mk-wlmouse", 0xA883);
        let mut f = fake(m);
        f.feature_replies.push_back(report(0x00, 65, &[(1, 0xA2), (4, 0x02), (6, 0x83), (7, 0), (8, 91)]));
        assert_eq!(read1(&mut f, m), at(pctl(91), Charging::No));
        let mut f = fake(m);
        f.feature_replies.push_back(report(0x00, 65, &[(1, 0xA0), (4, 0x02), (6, 0x83)]));
        assert_eq!(read1(&mut f, m), dozing(7));
    }
}
