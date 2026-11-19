// SPDX-License-Identifier: GPL-3.0-or-later
//! The Windows declarations' layout test on any system (`rustc --edition 2021 --test stdroots/winffi.rs`): the structs
//! the readers hand to Windows have the SDK's sizes. Not part of the crate.
#[path = "../src/win/ffi.rs"]
pub mod ffi;
// (The taskbar strip's own declarations, src/win/strip.rs, with what it takes from the core.)
#[path = "../src/model.rs"]
pub mod model;
#[path = "../src/summary.rs"]
pub mod summary;
#[path = "../src/taskbar.rs"]
pub mod taskbar;
#[path = "../src/win/strip.rs"]
pub mod strip;
