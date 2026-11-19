// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Fantech Helios Go XD5 (25A7: FA7B cable, FA7C dongle) and the Redragon
// Invader Pro (FA7E) on the same firmware — «Compx 17» as a feature report (proto.rs), the reply on any input
// collection of the interface or read back as feature report 08.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/fantech.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its references: jarjut/xd5-go-web, libratbag/libratbag issue 1893.
// Changed here: one reply collection listened to (the platform's Reply collection) besides the feature read-back; the
// Invader Pro's 0–10 as steps (the original: × 10 %).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn f(pid: u16, name: &'static str, via: Via) -> Model {
    Model::new("mk-fantech", 0x25A7, pid, name, Kind::Mouse, via).feature(Len::Min(17))
}
const fn r(pid: u16, name: &'static str, via: Via) -> Model {
    Model::new("mk-fantech", 0x25A7, pid, name, Kind::Mouse, via).feature(Len::Eq(0)).input(Len::Min(6)).role(Role::Reply)
}

pub static MODELS: &[Model] = &[
    f(0xFA7B, "Fantech Helios Go XD5", Via::Cable).pair("ft:xd5"),
    f(0xFA7C, "Fantech Helios Go XD5", Via::Receiver).pair("ft:xd5"),
    f(0xFA7E, "Redragon Invader Pro", Via::Receiver).arg(10),
    r(0xFA7B, "Fantech Helios Go XD5", Via::Cable),
    r(0xFA7C, "Fantech Helios Go XD5", Via::Receiver),
    r(0xFA7E, "Redragon Invader Pro", Via::Receiver),
];
