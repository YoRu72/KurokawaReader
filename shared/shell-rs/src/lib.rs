//! kurokawa-shell: the Rust both Kurokawa apps' Tauri shells use (Kurokawa Tools: apps/tools/desktop-tauri; the
//! Reader: apps/reader/desktop-tauri). Taken from Tools' shell on branch work-tauri — where it compiled and passed its
//! self-test on Windows, Linux and macOS — with as little change as possible; what is only Tools' (the aria2 download
//! engine: engine.rs, engine_core.rs, rpc.rs) stays in Tools.
//!
//! No `#[tauri::command]` lives here: each app wraps these functions in its own commands, under its own names
//! (Tools: kt_*, the Reader: kr_*), and registers them, its plugins and its window itself.
//!
//! - std only, testable alone with `rustc --edition 2021 --test <file>`: util, files, testserver, cookiejar, doh
//! - serde_json / crates: hash, net (reqwest: web requests, the cookie jar's and DoH resolver's hooks), selftest
//! - tauri: shell (folders, dialogs, clipboard, opener, file bytes), winstate
pub mod cookiejar;
pub mod doh;
pub mod files;
pub mod hash;
pub mod net;
pub mod selftest;
pub mod shell;
pub mod testserver;
pub mod util;
pub mod winstate;

/// (The web client's crate, for the apps' own fetching on net::client() — the Reader's downloader —, so they name no
/// second copy of it with features of their own.)
pub use reqwest;
