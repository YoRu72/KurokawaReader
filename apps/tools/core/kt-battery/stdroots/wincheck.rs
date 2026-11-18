// SPDX-License-Identifier: GPL-3.0-or-later
//! Type-checks kt-battery's Windows platform on any system (its link attributes apply on Windows only):
//! `rustc --edition 2021 --crate-type lib --emit=metadata stdroots/wincheck.rs`, and runs the Windows declarations'
//! layout test: `rustc --edition 2021 --test stdroots/winffi.rs`. Without the `wgi` feature, as the default build.
//! Not part of the crate.
#[path = "../src/allow.rs"]
pub mod allow;
#[path = "../src/autostart.rs"]
pub mod autostart;
#[path = "../src/bluetooth.rs"]
pub mod bluetooth;
#[path = "../src/connect.rs"]
pub mod connect;
#[path = "../src/hidvalue.rs"]
pub mod hidvalue;
#[path = "../src/identity.rs"]
pub mod identity;
#[path = "../src/kind.rs"]
pub mod kind;
#[path = "../src/model.rs"]
pub mod model;
#[path = "../src/notice.rs"]
pub mod notice;
#[path = "../src/registry.rs"]
pub mod registry;
#[path = "../src/runner.rs"]
pub mod runner;
#[path = "../src/sched.rs"]
pub mod sched;
#[path = "../src/summary.rs"]
pub mod summary;
#[path = "../src/transport.rs"]
pub mod transport;
#[path = "../src/xbox.rs"]
pub mod xbox;
#[path = "../src/win/mod.rs"]
pub mod win;
