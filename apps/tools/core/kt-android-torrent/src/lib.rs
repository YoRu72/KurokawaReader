//! kt-android-torrent: the phone's Rust torrent engine (stage M3, ../kt-android/ANDROID-PORT.md): librqbit as the whole
//! engine of the torrents the user gives it («Torrent engine: Rust» under Settings → Advanced), libtorrent4j staying the
//! default and the fallback. A library of its own (libkt_torrent.so) so libkt_android.so stays dependency-free.
//!
//! - src/jni.rs — the one hand-written JNI function (kt-android's, for `KtTorrentCore.nCall`), the only unsafe code;
//! - src/dispatch.rs — the `tor.*` methods, std only: a table of torrents by the app's task id, the add made on a
//!   thread of its own, one `tor.poll` answering every changed task, pause/resume (with or without librqbit's own
//!   pause), the hand-back at shutdown; every rule from kt-core's tormobile;
//! - src/rqbit.rs — the backend: librqbit and tokio, linear, each call the PC never compiled behind its own feature;
//! - src/fake.rs — a stand-in backend (no crate) for the host tests on a machine without crates.io (`--cfg kt_fake`).

mod jni;
pub mod dispatch;

#[cfg(not(kt_fake))]
#[path = "rqbit.rs"]
pub mod backend;
#[cfg(kt_fake)]
#[path = "fake.rs"]
pub mod backend;

/// The answer as Java reads it: one status byte (0 ok, 1 error), then the payload.
pub fn frame(r: Result<Vec<u8>, String>) -> Vec<u8> {
    match r {
        Ok(mut b) => {
            b.insert(0, 0u8);
            b
        }
        Err(e) => {
            let mut b = Vec::with_capacity(e.len() + 1);
            b.push(1u8);
            b.extend_from_slice(e.as_bytes());
            b
        }
    }
}

/// What a caught panic said, for the error answer.
pub fn panic_text(p: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = p.downcast_ref::<&str>() {
        format!("panic: {}", s)
    } else if let Some(s) = p.downcast_ref::<String>() {
        format!("panic: {}", s)
    } else {
        "panic".to_string()
    }
}

/// What every backend gives the dispatch (src/rqbit.rs and src/fake.rs both).
pub mod contract {
    /// A torrent's source.
    #[derive(Clone, Debug)]
    pub enum Src {
        Magnet(String),
        Bytes(Vec<u8>),
    }
    /// A torrent the backend holds now.
    #[derive(Clone, Debug)]
    pub struct Added {
        pub rid: usize,
        pub name: String,
        /// (in-torrent path, size) in the torrent's order, when the backend knows them.
        pub files: Vec<(String, u64)>,
    }
    /// One look at a torrent.
    #[derive(Clone, Debug, Default)]
    pub struct Live {
        pub stats: kt_core::tormobile::Stats,
        /// Bytes here per file, when this build can say.
        pub file_done: Option<Vec<u64>>,
    }
    /// A magnet's metadata read without adding it (name, more than one file, files).
    #[derive(Clone, Debug)]
    pub struct Meta {
        pub name: String,
        pub multi: bool,
        pub files: Vec<(String, u64)>,
    }
}
