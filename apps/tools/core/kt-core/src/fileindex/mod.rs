//! Fast file search for the computer build — the index core (Tools 0.21). The user chooses folders; a background walk
//! records every entry's name, parent, size, modification time and type in a compact index (one name arena, u32
//! links, no per-entry String or PathBuf: about 100 bytes an entry with its name, measured at a million); queries
//! search the folded names as the user types; the system's watchers keep it current; it is saved to one file in the
//! app-data folder.
//!
//! - fold: the folding of names (lower case, marks, Arabic hamza forms, kana, full width) and the kinds of files
//! - store: the index, its roots, `apply` for watcher changes, `install` for walks, `sync_dir`
//! - query: the query language, filters, ranking, the cap with the total, supersedable tickets
//! - walk: `Fs` (std's disk or a fake), `Source` — the walker; the extension point for the NTFS «whole drive» mode —,
//!   progress, pause and cancel, the background-priority hint
//! - persist: the file (versioned, length-checked, checksummed; never trusted), temp name then rename
//! - watch: the watcher trait, inotify (Linux), ReadDirectoryChangesW (Windows), the mtime poller (macOS), a fake
//! - service: the two threads that run it all for the shell
//!
//! Nothing here is sent anywhere, and no file's contents are ever read: names and metadata only. Std only; tested
//! through stdroots/fileindex.rs (`rustc --edition 2021 --test stdroots/fileindex.rs`) and with the crate.
pub mod fold;
pub mod persist;
pub mod query;
pub mod service;
pub mod store;
pub mod walk;
pub mod watch;

pub use fold::{fold, Kind};
pub use persist::LoadError;
pub use query::{Cancelled, Hit, Query, QueryResult, Searcher, SortKey, Ticket};
pub use service::{Service, ServiceOptions, Status};
pub use store::{Applied, Change, EntryId, Index, IndexStats, Meta, RootSpec, RootStatus, Walked};
pub use walk::{lower_thread_priority, DirWalker, Fs, Progress, Source, StdFs, WalkCtrl};
pub use watch::{native_watcher, to_changes, FakeWatcher, MtimePoller, RawEvent, Watcher};

#[cfg(test)]
mod tests;
