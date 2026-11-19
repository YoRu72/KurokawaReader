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
//! - dohchain: DNS over HTTPS — the resolvers offered (doh-providers.txt), their order and health, the cache, the
//!   chain and its fall-back rule, UDP trackers by address (0.21 P9; replaces P8's dohnames)
//! - dohproxy: the small HTTP proxy aria2 is pointed at while DoH is on (CONNECT and plain GET, names by the chain)
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
pub mod dohchain;
pub mod dohproxy;
// (Stage P4: torrent streaming and the local stream server.)
pub mod streamlogic;
// (Stage P5: the video tools.)
pub mod videotools;
pub mod vidjson;
// (The screen translator on a computer: shortcuts, monitors and regions, the caption's and the popup's places, the
// OCR answers read, pixels and a PNG, the screenshot portal — desktop/screentr.cjs's rules for the Tauri shell.)
pub mod screenlogic;
// (Stage P9: the hand-over from the Electron build — the Reader's handoverlogic.rs with Tools' names, and the engine's
// files carried before aria2c first starts.)
pub mod handoverlogic;
// (Stage P9, after the hand-over: which of the two programs runs the downloads they share — one owner file, a
// heartbeat, a stale rule; the same rule in desktop/ownerlock.cjs, one table for both.)
pub mod ownerlogic;
// (Android stages M0–M1: the download queue's decisions — KtDlRules.java's — and the screen translator's cache keys —
// KtTranslate.java's —, called from Java through apps/tools/core/kt-android; Java keeps its copies as the reference.)
pub mod dlrules;
pub mod translatekey;
// (Android stage M2: the HTTP downloader's decisions — KrDownloader.java's rules as a state machine; Java moves the
// bytes and asks this for every choice, through kt-android's `http.*` methods.)
pub mod httpdl;
// (Android stage M3: torrents — the streaming director that drives libtorrent4j's piece priorities and deadlines
// (tordirector), and the phone's engine choice, ownership, failure, stats and hand-over rules (tormobile), used by
// kt-android's `tor.*` methods and by the torrent library kt-android-torrent.)
pub mod tordirector;
pub mod tormobile;
// (Android stage M4: the screen translator's rules — KtScreenTrack's following and translating ahead, KtScreenMotion's
// scroll finder, KtInpaint's cleaning (and a patch cache), KtLettering / KtLetterFace's text rules — and KtHls's
// playlists with java.net.URL's way of resolving; javachar.in holds Java's Character tables they share.)
pub mod screentrack;
pub mod screenmotion;
pub mod inpaint;
pub mod lettering;
pub mod hls;
// (Android stage M5: the file jobs as a planner — KtFileJobs.java's rules as ordered steps Java executes —, their
// journal (resume, roll back, undo), and the network storages' rules that need no network — KtRemote.java's.)
pub mod fileplan;
pub mod filejournal;
pub mod remoterules;
// (Tools 0.21 P5: archive safety — the one name table, the peak-space replay, the pre-flight's decisions, the conflict
// plan and the extraction journal's text; the twin of desktop/archsafe.cjs and KtNameSafe.java.)
pub mod archsafe;
// (Tools 0.21 P11: the extraction engine on the Tauri shell — desktop/inplace.cjs's pre-flight, plan, journal v2, shelf,
// finish / restore / undo, run over archsafe and vidjson; tested through stdroots/extractjob.rs.)
pub mod extractjob;
// (Tools 0.21: fast file search on a computer — the index core: the walk, the folded names and the queries, the
// watchers (inotify, ReadDirectoryChangesW, an mtime poller), the saved file; a folder of modules, tested through
// stdroots/fileindex.rs.)
pub mod fileindex;
