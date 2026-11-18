//! The std-only test root for extractjob.rs (rustc --test with no Cargo): the engine asks archsafe.rs for the name
//! table and the journal's check, and vidjson.rs for JSON (`crate::archsafe`, `crate::vidjson`), so the three come in
//! here as the modules they are in kt-core's lib.rs; each rule stays in one place. Not part of the crate.
//! Run: rustc --edition 2021 --test stdroots/extractjob.rs -o /tmp/extractjob && /tmp/extractjob
#[path = "../src/archsafe.rs"]
pub mod archsafe;
#[path = "../src/vidjson.rs"]
pub mod vidjson;
#[path = "../src/extractjob.rs"]
pub mod extractjob;
