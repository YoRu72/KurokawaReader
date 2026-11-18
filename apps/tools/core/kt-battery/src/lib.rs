// SPDX-License-Identifier: GPL-3.0-or-later
//! kt-battery: Kurokawa Tools' device battery — the batteries of mice, keyboards, headsets, earbuds and controllers.
//! Derived from Wireless Device Battery Monitor by krisgfx9 and its contributors (GPL-3.0-or-later; ../../NOTICE.md
//! names the commit and what was changed). Copyright (C) 2026 Kurokawa contributors.
//!
//! Std only. The core modules hold the rules and are tested with made-up devices, together, through
//! stdroots/core.rs (`rustc --edition 2021 --test stdroots/core.rs`):
//! - model: Device, Reading, Level (exact, coarse or unknown), Charging
//! - allow: the one table of what may be sent to a device (empty in piece 1: the generic readers only read)
//! - transport: one HID collection with a deadline on every call; query-only opens; writes only through `allow`
//! - registry: which reader may look at a collection (full matches only, never a vendor id alone)
//! - hidvalue: the generic HID battery field (range checks, length-checked bit reads)
//! - kind: kind and brand (as text) of a device
//! - bluetooth: Windows' Bluetooth battery property, decided per physical device
//! - xbox: Windows.Gaming.Input's real percentage, XInput's coarse levels
//! - identity: stable keys per unit and the explicit merge rules
//! - sched: per-device timing, deadlines, back-off, asleep devices left alone
//! - runner: the background loop over a Platform
//!
//! `win` (Windows only) is the platform: SetupAPI, HID, CfgMgr32 and XInput declared in win/ffi.rs, type-checked on
//! any system through stdroots/wincheck.rs; Windows.Gaming.Input behind the `wgi` feature.
pub mod allow;
pub mod bluetooth;
pub mod hidvalue;
pub mod identity;
pub mod kind;
pub mod model;
pub mod registry;
pub mod runner;
pub mod sched;
pub mod transport;
pub mod xbox;
#[cfg(windows)]
pub mod win;
