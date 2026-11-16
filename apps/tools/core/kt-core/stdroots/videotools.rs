//! The std-only test root for videotools.rs (tauri-check's «Std-only unit tests (stage P5, video tools)»: rustc --test
//! with no Cargo). videotools.rs asks dlrules.rs whether a link names a plain file (`crate::dlrules::is_direct_file_url`),
//! so both come in here as the modules they are in kt-core's lib.rs; the rule stays in one place. Not part of the crate.
#[path = "../src/dlrules.rs"]
pub mod dlrules;
#[path = "../src/videotools.rs"]
pub mod videotools;
