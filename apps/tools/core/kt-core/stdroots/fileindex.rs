//! The std-only test root for the file index (src/fileindex/, a folder of modules): rustc --test with no Cargo, the
//! modules as they are in kt-core's lib.rs. Not part of the crate.
//! Run: rustc --edition 2021 --test -O stdroots/fileindex.rs -o /tmp/fileindex && /tmp/fileindex
//! (the 1,000,000-entry timing: add `-- --ignored --nocapture`)
#[path = "../src/fileindex/mod.rs"]
pub mod fileindex;
