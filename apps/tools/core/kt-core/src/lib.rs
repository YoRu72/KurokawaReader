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
//! - places: a computer's storages for the Files page (home, Downloads, Desktop, Documents, disks), shallow stat, names
//! - updatelogic: the PC updater's decisions — the Reader's updatelogic.rs with Tools' names (P8)
//! - dohnames: the DNS-over-HTTPS resolvers Tools' settings name (desktop/main.cjs's DOH table) (P8)
//! - streamlogic: torrent streaming's and the local stream server's rules — ranges, types, aria2's pieces, ffmpeg's
//!   arguments (P4)
//! - videotools: yt-dlp / gallery-dl / ffmpeg rules — release files, versions, a replaced program checked and rolled
//!   back, the argument lists, progress lines, the transcode stream's arguments, the bilingual subtitle (P5)
//! - vidjson: a small JSON reader/writer and yt-dlp's `-J` / gallery-dl's `-j` answers shaped for the page (P5)
pub mod engine_core;
pub mod filejobs;
pub mod fontnames;
pub mod mega;
pub mod places;
pub mod updatelogic;
pub mod dohnames;
// (Stage P4: torrent streaming and the local stream server.)
pub mod streamlogic;
// (Stage P5: the video tools.)
pub mod videotools;
pub mod vidjson;
// (The screen translator on a computer: shortcuts, monitors and regions, the caption's and the popup's places, the
// OCR answers read, pixels and a PNG, the screenshot portal — desktop/screentr.cjs's rules for the Tauri shell.)
pub mod screenlogic;
