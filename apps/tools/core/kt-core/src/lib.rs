//! kt-core: Kurokawa Tools' engine rules, the pure logic both the PC shell (apps/tools/desktop-tauri) and — from stage
//! M0 on — the Android library use (docs/RUST-PORT.md §6). No platform code: it never touches a window, a dialog or
//! an Android API; plain data in, plain data out. Every module is std only and stands alone (no `crate::` between
//! them), so each is checked by itself with `rustc --edition 2021 --test src/<module>.rs` — the workspace has no
//! crates.io, CI is the only full compiler.
//!
//! - engine_core: aria2's arguments and options, its status mapped to the page's Task, path rules (P2, moved here)
//! - filejobs: copy / move / delete with the Files page's rules — the same as the Android KtFileJobs (P3)
//! - fontnames: a font file's family names from its «name» table (kt:fontIndex, P3)
//! - mega: AES-128-CTR for a MEGA file fetched whole (kt:megaDecrypt, P3; the Android downloader's at M2)
pub mod engine_core;
pub mod filejobs;
pub mod fontnames;
pub mod mega;
