// SPDX-License-Identifier: GPL-3.0-or-later
//! kt-battery: Kurokawa Tools' device battery — the batteries of mice, keyboards, headsets, earbuds and controllers.
//! Derived from Wireless Device Battery Monitor by krisgfx9 and its contributors (GPL-3.0-or-later; ../../NOTICE.md
//! names the commit and what was changed). Copyright (C) 2026 Kurokawa contributors.
//!
//! Std only. The core modules hold the rules and are tested with made-up devices, together, through
//! stdroots/core.rs (`rustc --edition 2021 --test stdroots/core.rs`):
//! - model: Device, Reading, Level (exact, coarse or unknown), Charging
//! - allow: the one table of what may be sent to a device (the generic readers only read; four controller families' status requests)
//! - transport: one HID collection with a deadline on every call; query-only opens; writes only through `allow`
//! - registry: which reader may look at a collection (full matches only, never a vendor id alone)
//! - hidvalue: the generic HID battery field (range checks, length-checked bit reads)
//! - kind: kind and brand (as text) of a device
//! - bluetooth: Windows' Bluetooth battery property, decided per physical device
//! - connect: piece 3 — the Bluetooth connect panel's list, actions (one per device, each with a limit and a cancel) and
//!   bounded scan, over a BtPlatform (win/btconn.rs on Windows)
//! - xbox: Windows.Gaming.Input's real percentage, XInput's coarse levels
//! - pads: piece 4 — game controllers' own readers (PlayStation, Nintendo, Steam, 8BitDo, GameSir, Flydigi, BEITONG):
//!   passive listening first; four families' status requests, sealed in allow, only when the user turns them on
//! - mice: piece 5 — mice' and keyboards' own readers (Logitech HID++, Razer, SteelSeries, Corsair and some forty
//!   more families): passive listening on by default; status requests, sealed in allow (exact bytes, bounded templates,
//!   HID++ with the device's own feature index), only when the user turns that family on
//! - heads: piece 6 — headsets' own readers (Razer BlackShark, SteelSeries Arctis, Corsair, Logitech G, ASTRO, Audeze,
//!   HyperX, Sony INZONE, Jabra, JBL, Poly, MOONDROP, MCHOSE, Alienware, Fractal, ROG) and a microphone (MAONO), through
//!   mice/mod.rs's tables and switches; status requests sealed in allow (heads/allowed.rs)
//! - airpods, galaxybuds, phonelink: piece 6's readers that are not HID — AirPods' Bluetooth LE broadcasts (listened
//!   to; behind the `wgi` feature on Windows), Galaxy Buds' pushed status on their serial-port service (off until
//!   turned on), a phone's level from Phone Link's card in the user's own profile (read only)
//! - identity: stable keys per unit and the explicit merge rules
//! - sched: per-device timing, deadlines, back-off, asleep devices left alone
//! - runner: the background loop over a Platform
//! - notice: when a low-battery or fully-charged notice is due (per device, with re-arming)
//! - summary: the tray's short list, lowest first, and its tooltip's clipping
//! - taskbar: the tray icons with the level drawn in them, the strip on the taskbar, their order and captions, quiet
//!   hours (pure; win/strip.rs puts the strip on Windows' taskbar)
//! - autostart: «start with the system, hidden» — the Run value's data and the XDG autostart file
//!
//! `win` (Windows only) is the platform: SetupAPI, HID, CfgMgr32, XInput and the Run key (advapi32) declared in win/ffi.rs, type-checked on
//! any system through stdroots/wincheck.rs; Windows.Gaming.Input behind the `wgi` feature.
pub mod airpods;
pub mod allow;
pub mod autostart;
pub mod bluetooth;
pub mod bluez;
pub mod connect;
pub mod galaxybuds;
pub mod heads;
pub mod hiddesc;
pub mod hidplat;
pub mod hidvalue;
pub mod identity;
pub mod kind;
pub mod macos;
pub mod macparse;
pub mod mice;
pub mod model;
pub mod notice;
pub mod pads;
pub mod phonelink;
pub mod registry;
pub mod runner;
pub mod sched;
pub mod summary;
pub mod sysfs;
pub mod sysprog;
pub mod taskbar;
pub mod transport;
pub mod udev;
pub mod upower;
pub mod xbox;
#[cfg(windows)]
pub mod win;
#[cfg(target_os = "linux")]
pub mod linux;
