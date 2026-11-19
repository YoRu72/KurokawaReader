//! Filling the index: a `Source` gives the entries under a folder. `DirWalker` is the one built here — it lists
//! folders through an `Fs` (std's on a real disk, a fake in tests), records links without following them, never
//! enters an excluded folder, counts the folders it cannot read and goes on. It reads names and metadata only, never
//! a file's contents.
//!
//! EXTENSION POINT: the administrator «whole drive» mode (reading an NTFS volume's master file table) is a second
//! `Source` — it fills the same `Walked` tree from the MFT in one pass instead of listing folders. Nothing else here
//! needs to change for it; the shell picks the source per root.
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::fold::fold;
use super::store::{os_bytes, under, Meta, RootSpec, Walked, F_UNREAD};

/// Listing folders and stating paths, without following links.
pub trait Fs: Send + Sync {
    /// Calls `item` for each entry of `dir` (not «.» or «..»).
    fn read_dir(&self, dir: &Path, item: &mut dyn FnMut(OsString, Meta)) -> io::Result<()>;
    /// The path's own metadata (a link is described, not its target).
    fn lstat(&self, path: &Path) -> io::Result<Meta>;
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn time_ms(t: io::Result<SystemTime>) -> i64 {
    match t {
        Ok(t) => match t.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_millis() as i64,
            Err(e) => -(e.duration().as_millis() as i64),
        },
        Err(_) => 0,
    }
}

pub fn meta_of(m: &std::fs::Metadata) -> Meta {
    // std's is_symlink is true for symbolic links and, on Windows, for junctions and other name surrogates; cloud
    // placeholders (OneDrive) are reparse points too but not surrogates, so they are entered like folders.
    let link = m.file_type().is_symlink();
    Meta { size: if m.is_dir() { 0 } else { m.len() }, mtime: time_ms(m.modified()), is_dir: m.is_dir() || (link && is_dir_link(m)), is_link: link }
}

#[cfg(windows)]
fn is_dir_link(m: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    m.file_attributes() & 0x10 != 0 // FILE_ATTRIBUTE_DIRECTORY: a junction or a folder symlink
}
#[cfg(not(windows))]
fn is_dir_link(_m: &std::fs::Metadata) -> bool {
    false
}

/// The real disk, through std (DirEntry::metadata does not follow links on any system).
pub struct StdFs;
impl Fs for StdFs {
    fn read_dir(&self, dir: &Path, item: &mut dyn FnMut(OsString, Meta)) -> io::Result<()> {
        for e in std::fs::read_dir(dir)? {
            let Ok(e) = e else { continue };
            match e.metadata() {
                Ok(m) => item(e.file_name(), meta_of(&m)),
                // Gone between the listing and the stat, or not ours to stat: still a name in the folder.
                Err(_) => item(e.file_name(), Meta::default()),
            }
        }
        Ok(())
    }
    fn lstat(&self, path: &Path) -> io::Result<Meta> {
        std::fs::symlink_metadata(path).map(|m| meta_of(&m))
    }
}

/// Shared between the walking thread and the shell: stop, pause, progress.
#[derive(Default)]
pub struct WalkCtrl {
    pub cancel: AtomicBool,
    /// Set by the shell on battery (or when the user pauses): the walker waits between folders.
    pub pause: AtomicBool,
    pub entries: AtomicU64,
    pub folders_unreadable: AtomicU64,
    pub current_root: Mutex<PathBuf>,
}

impl WalkCtrl {
    pub fn new() -> WalkCtrl {
        WalkCtrl::default()
    }
    pub fn progress(&self) -> Progress {
        Progress {
            entries: self.entries.load(Ordering::Relaxed),
            unreadable: self.folders_unreadable.load(Ordering::Relaxed),
            current_root: self.current_root.lock().map(|g| g.clone()).unwrap_or_default(),
            paused: self.pause.load(Ordering::Relaxed),
        }
    }
    fn wait_while_paused(&self) {
        while self.pause.load(Ordering::Relaxed) && !self.cancel.load(Ordering::Relaxed) {
            std::thread::park_timeout(Duration::from_millis(200));
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Progress {
    pub entries: u64,
    pub unreadable: u64,
    pub current_root: PathBuf,
    pub paused: bool,
}

/// Something that fills a `Walked` tree for a folder under a root (see the extension point above).
pub trait Source: Send + Sync {
    fn walk(&self, root: &RootSpec, dir: &Path, ctrl: &WalkCtrl) -> Walked;
}

/// The folder-by-folder walker.
pub struct DirWalker<F: Fs> {
    pub fs: F,
}

impl<F: Fs> DirWalker<F> {
    pub fn new(fs: F) -> Self {
        DirWalker { fs }
    }
}

fn excluded(root: &RootSpec, excl_names: &[String], path: &Path) -> bool {
    if root.exclude.iter().any(|e| under(path, e).is_some()) {
        return true;
    }
    if excl_names.is_empty() {
        return false;
    }
    match path.file_name() {
        Some(n) => {
            let f = fold(&n.to_string_lossy());
            excl_names.iter().any(|x| *x == f)
        }
        None => false,
    }
}

impl<F: Fs> Source for DirWalker<F> {
    fn walk(&self, root: &RootSpec, dir: &Path, ctrl: &WalkCtrl) -> Walked {
        if let Ok(mut g) = ctrl.current_root.lock() {
            *g = root.path.clone();
        }
        let excl_names: Vec<String> = root.exclude_names.iter().map(|n| fold(n)).collect();
        let top = match self.fs.lstat(dir) {
            Ok(m) if m.is_dir && !m.is_link => m,
            Ok(_) | Err(_) => {
                let mut w = Walked::gone(dir);
                w.finished_ms = now_ms();
                return w;
            }
        };
        let mut w = Walked::start(dir, top);
        // Each folder: its id in the tree and its path (pushed and popped as the walk goes).
        let mut stack: Vec<(u32, PathBuf)> = vec![(0, dir.to_path_buf())];
        let mut since = 0u32;
        let mut items: Vec<(OsString, Meta)> = Vec::new();
        while let Some((id, path)) = stack.pop() {
            if ctrl.cancel.load(Ordering::Relaxed) {
                w.cancelled = true;
                return w;
            }
            ctrl.wait_while_paused();
            items.clear();
            if self.fs.read_dir(&path, &mut |n, m| items.push((n, m))).is_err() {
                w.unreadable += 1;
                ctrl.folders_unreadable.fetch_add(1, Ordering::Relaxed);
                w.tree.flags[id as usize] |= F_UNREAD;
                continue;
            }
            for (name, meta) in items.drain(..) {
                let child_path = path.join(&name);
                let enter = meta.is_dir && !meta.is_link;
                if enter && excluded(root, &excl_names, &child_path) {
                    continue;
                }
                match w.tree.insert_raw(id, os_bytes(&name), None, meta, 0) {
                    Some(c) => {
                        w.entries += 1;
                        if enter {
                            stack.push((c, child_path));
                        }
                    }
                    None => w.skipped += 1,
                }
                since += 1;
                if since >= 1024 {
                    ctrl.entries.fetch_add(since as u64, Ordering::Relaxed);
                    since = 0;
                }
            }
        }
        ctrl.entries.fetch_add(since as u64, Ordering::Relaxed);
        w.finished_ms = now_ms();
        w
    }
}

/// Asks the system to run the calling thread at background priority (CPU, and disk where the system has a thread
/// setting for it). Best effort: false when the system refused or has no such setting.
pub fn lower_thread_priority() -> bool {
    imp::lower()
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentThread() -> *mut c_void;
        fn SetThreadPriority(h: *mut c_void, prio: i32) -> i32;
    }
    /// THREAD_MODE_BACKGROUND_BEGIN: lower CPU, disk and memory priority for this thread.
    const THREAD_MODE_BACKGROUND_BEGIN: i32 = 0x0001_0000;
    pub fn lower() -> bool {
        unsafe { SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN) != 0 }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::ffi::{c_int, c_long, c_uint};
    extern "C" {
        fn setpriority(which: c_int, who: c_uint, prio: c_int) -> c_int;
        fn syscall(n: c_long, ...) -> c_long;
    }
    #[cfg(target_arch = "x86_64")]
    const SYS_GETTID: c_long = 186;
    #[cfg(target_arch = "aarch64")]
    const SYS_GETTID: c_long = 178;
    #[cfg(target_arch = "x86_64")]
    const SYS_IOPRIO_SET: c_long = 251;
    #[cfg(target_arch = "aarch64")]
    const SYS_IOPRIO_SET: c_long = 30;
    pub fn lower() -> bool {
        #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
        unsafe {
            // On Linux a thread id given to setpriority names that thread alone (PRIO_PROCESS = 0, nice 19).
            let tid = syscall(SYS_GETTID) as c_uint;
            let ok = setpriority(0, tid, 19) == 0;
            // ioprio_set(IOPRIO_WHO_PROCESS = 1, tid, IOPRIO_CLASS_IDLE << 13): disk reads only when the disk is idle.
            let _ = syscall(SYS_IOPRIO_SET, 1 as c_int, tid as c_int, (3 << 13) as c_int);
            ok
        }
        #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
        false
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::c_int;
    extern "C" {
        fn setpriority(which: c_int, who: c_int, prio: c_int) -> c_int;
    }
    pub fn lower() -> bool {
        // PRIO_DARWIN_THREAD (3), the calling thread (0), PRIO_DARWIN_BG (0x1000): background CPU and disk.
        unsafe { setpriority(3, 0, 0x1000) == 0 }
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
mod imp {
    pub fn lower() -> bool {
        false
    }
}
