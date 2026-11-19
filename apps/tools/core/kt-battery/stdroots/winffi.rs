// SPDX-License-Identifier: GPL-3.0-or-later
//! The Windows declarations' layout test on any system (`rustc --edition 2021 --test stdroots/winffi.rs`): the structs
//! the readers hand to Windows have the SDK's sizes. Not part of the crate.
#[path = "../src/win/ffi.rs"]
pub mod ffi;
// (Piece W4: the command line's console and version calls, src/win/console.rs.)
#[path = "../src/win/console.rs"]
pub mod console;
// (The taskbar strip's own declarations, src/win/strip.rs, with what it takes from the core.)
#[path = "../src/model.rs"]
pub mod model;
#[path = "../src/summary.rs"]
pub mod summary;
#[path = "../src/taskbar.rs"]
pub mod taskbar;
#[path = "../src/win/strip.rs"]
pub mod strip;
// (Piece S1: the system on the taskbar's sampler, src/win/sysmon.rs, with its pure half.)
#[path = "../src/sysmon.rs"]
pub mod sysmon;
#[path = "../src/win/sysmon.rs"]
pub mod winsysmon;
