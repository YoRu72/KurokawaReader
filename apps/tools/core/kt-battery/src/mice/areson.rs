// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Redragon mice on Areson / Compx receivers (25A7: FA07, FA08 — M913
// Impact Elite, M915RGB-WL) — «Compx 17» «GetPower» as feature report 08 on FF02:0002 of interface 1, the reply input
// report 09 on FF01:0000 (proto.rs): [09][04][00][..][..][..][level 0–10][charging]…, the frame summing to 55.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/areson.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its references: Qehbr/m913-ctl, Doomguy-BFG9000/redragon-m913-battery-tray, a capture of
// Redragon's software.
// Changed here: the level as its own 0–10 steps (the original: × 10 %).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn cmd(pid: u16) -> Model {
    Model::new("mk-areson", 0x25A7, pid, "Redragon wireless mouse", Kind::Mouse, Via::Receiver).iface(1).page(0xFF02).usage(0x0002).feature(Len::Min(17))
}
const fn rep(pid: u16) -> Model {
    Model::new("mk-areson", 0x25A7, pid, "Redragon wireless mouse", Kind::Mouse, Via::Receiver).iface(1).page(0xFF01).usage(0x0000).input(Len::Min(17)).role(Role::Reply)
}

pub static MODELS: &[Model] = &[cmd(0xFA07), cmd(0xFA08), rep(0xFA07), rep(0xFA08)];
