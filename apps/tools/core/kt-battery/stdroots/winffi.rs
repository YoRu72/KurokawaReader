// SPDX-License-Identifier: GPL-3.0-or-later
//! The Windows declarations' layout test on any system (`rustc --edition 2021 --test stdroots/winffi.rs`): the structs
//! the readers hand to Windows have the SDK's sizes. Not part of the crate.
#[path = "../src/win/ffi.rs"]
pub mod ffi;
