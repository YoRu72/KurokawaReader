// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): DAREU EM901X (260D:1074 receiver, 1090 cable) — «Compx 17» battery
// request as feature report 08 on FF02:0002 of interface 1, the reply input report 09 on the sibling FF01:0000
// (proto.rs).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/dareu.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its references: the EM901X AIM-WL driver v1.0, wushuai0802/myfinder-device-battery.
// Reply: [09][04][00 status]…[6 percent][7 charging], exactly 17 bytes (no checksum rule is established).
// Changed here: the cable and the receiver of one mouse: one card by the pair rule (the original preferred the cable).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn cmd(pid: u16, via: Via) -> Model {
    Model::new("mk-dareu", 0x260D, pid, "DAREU EM901X", Kind::Mouse, via).iface(1).page(0xFF02).usage(0x0002).feature(Len::Eq(17)).pair("dareu:em901x")
}
const fn rep(pid: u16, via: Via) -> Model {
    Model::new("mk-dareu", 0x260D, pid, "DAREU EM901X", Kind::Mouse, via).iface(1).page(0xFF01).usage(0x0000).input(Len::Eq(17)).role(Role::Reply)
}

pub static MODELS: &[Model] = &[cmd(0x1074, Via::Receiver), cmd(0x1090, Via::Cable), rep(0x1074, Via::Receiver), rep(0x1090, Via::Cable)];
