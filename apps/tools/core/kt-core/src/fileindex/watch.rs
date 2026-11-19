//! Keeping the index current: a `Watcher` reports what changed under the roots as `RawEvent`s (renames already
//! paired), `to_changes` states the new paths and makes the index's `Change`s.
//! - Windows: ReadDirectoryChangesW on each root (whole subtree), overlapped, one event handle per root;
//! - Linux: inotify, one watch per folder (new folders get theirs as they appear; a full table is an error the shell
//!   answers with the poller);
//! - macOS (and anywhere else): `MtimePoller` — the folders' own modification times compared every interval, a
//!   changed folder listed again (`Change::Listed`). A file rewritten in place does not change its folder's time: its
//!   size and date are corrected by the next walk.
//! `FakeWatcher` is fed by tests. The Windows code is declared by hand (std only) and is only type-checked where it is
//! compiled for Windows (GitHub's runner); the Linux one runs in the tests here.
use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::store::{under, Change, Meta, RootSpec};
use super::walk::Fs;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RawEvent {
    Created(PathBuf),
    Removed(PathBuf),
    Modified(PathBuf),
    Moved(PathBuf, PathBuf),
    /// Events were lost under this folder.
    Overflow(PathBuf),
    /// This folder's listing changed (the poller): list it again.
    DirChanged(PathBuf),
}

pub trait Watcher: Send {
    fn watch(&mut self, root: &RootSpec) -> io::Result<()>;
    fn unwatch(&mut self, root: &Path);
    /// Waits up to `timeout` for events and appends them (none is not an error).
    fn poll(&mut self, timeout: Duration, out: &mut Vec<RawEvent>) -> io::Result<()>;
}

/// Raw events → the index's changes: new paths are stated (lstat), repeated modifications in one batch are one.
pub fn to_changes(raw: Vec<RawEvent>, fs: &dyn Fs) -> Vec<Change> {
    let mut out = Vec::with_capacity(raw.len());
    let mut modified: HashSet<PathBuf> = HashSet::new();
    for e in raw {
        match e {
            RawEvent::Created(p) => {
                if let Ok(meta) = fs.lstat(&p) {
                    out.push(Change::Created { path: p, meta });
                }
            }
            RawEvent::Modified(p) => {
                if modified.insert(p.clone()) {
                    if let Ok(meta) = fs.lstat(&p) {
                        out.push(Change::Modified { path: p, meta });
                    }
                }
            }
            RawEvent::Removed(p) => {
                modified.remove(&p);
                out.push(Change::Removed { path: p });
            }
            RawEvent::Moved(a, b) => {
                let meta = fs.lstat(&b).ok();
                modified.remove(&a);
                out.push(Change::Moved { from: a, to: b, meta });
            }
            RawEvent::Overflow(d) => out.push(Change::Overflow { dir: d }),
            RawEvent::DirChanged(d) => {
                let mut items: Vec<(OsString, Meta)> = Vec::new();
                match fs.read_dir(&d, &mut |n, m| items.push((n, m))) {
                    Ok(()) => out.push(Change::Listed { dir: d, items }),
                    Err(_) => out.push(Change::Removed { path: d }),
                }
            }
        }
    }
    out
}

/// A watcher the tests feed by hand.
#[derive(Default)]
pub struct FakeWatcher {
    pub queue: std::sync::Arc<std::sync::Mutex<VecDeque<RawEvent>>>,
    pub watched: Vec<PathBuf>,
}
impl Watcher for FakeWatcher {
    fn watch(&mut self, root: &RootSpec) -> io::Result<()> {
        self.watched.push(root.path.clone());
        Ok(())
    }
    fn unwatch(&mut self, root: &Path) {
        self.watched.retain(|p| p != root);
    }
    fn poll(&mut self, timeout: Duration, out: &mut Vec<RawEvent>) -> io::Result<()> {
        let mut q = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        if q.is_empty() {
            drop(q);
            std::thread::park_timeout(timeout.min(Duration::from_millis(20)));
            q = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        }
        out.extend(q.drain(..));
        Ok(())
    }
}

/// The fall-back watcher: folders' modification times, compared every `interval`.
pub struct MtimePoller<F: Fs> {
    fs: F,
    interval: Duration,
    next: Instant,
    roots: Vec<RootSpec>,
    dirs: HashMap<PathBuf, i64>,
}

impl<F: Fs> MtimePoller<F> {
    pub fn new(fs: F, interval: Duration) -> Self {
        MtimePoller { fs, interval, next: Instant::now() + interval, roots: Vec::new(), dirs: HashMap::new() }
    }
    fn excluded(&self, p: &Path) -> bool {
        self.roots.iter().any(|r| under(p, &r.path).is_some() && (r.exclude.iter().any(|e| under(p, e).is_some())
            || p.file_name().map_or(false, |n| r.exclude_names.iter().any(|x| super::fold::fold(x) == super::fold::fold(&n.to_string_lossy())))))
    }
    fn record_tree(&mut self, top: &Path) {
        let mut stack = vec![top.to_path_buf()];
        while let Some(d) = stack.pop() {
            let Ok(m) = self.fs.lstat(&d) else { continue };
            self.dirs.insert(d.clone(), m.mtime);
            let mut subs = Vec::new();
            let _ = self.fs.read_dir(&d, &mut |n, m| {
                if m.is_dir && !m.is_link {
                    subs.push(d.join(n));
                }
            });
            for s in subs {
                if !self.excluded(&s) {
                    stack.push(s);
                }
            }
        }
    }
    /// Compares now (the tests; `poll` calls it when the interval is up).
    pub fn check(&mut self, out: &mut Vec<RawEvent>) {
        let dirs: Vec<(PathBuf, i64)> = self.dirs.iter().map(|(p, t)| (p.clone(), *t)).collect();
        let mut changed = Vec::new();
        for (d, t) in dirs {
            match self.fs.lstat(&d) {
                Ok(m) if m.is_dir => {
                    if m.mtime != t {
                        changed.push(d);
                    }
                }
                _ => {
                    self.dirs.remove(&d);
                }
            }
        }
        changed.sort();
        for d in changed {
            if let Ok(m) = self.fs.lstat(&d) {
                self.dirs.insert(d.clone(), m.mtime);
            }
            // New sub-folders join the watch.
            let mut subs = Vec::new();
            let _ = self.fs.read_dir(&d, &mut |n, m| {
                if m.is_dir && !m.is_link {
                    subs.push(d.join(n));
                }
            });
            for s in subs {
                if !self.dirs.contains_key(&s) && !self.excluded(&s) {
                    self.record_tree(&s);
                }
            }
            out.push(RawEvent::DirChanged(d));
        }
    }
}

impl<F: Fs> Watcher for MtimePoller<F> {
    fn watch(&mut self, root: &RootSpec) -> io::Result<()> {
        self.roots.push(root.clone());
        self.record_tree(&root.path);
        Ok(())
    }
    fn unwatch(&mut self, root: &Path) {
        self.roots.retain(|r| r.path != root);
        self.dirs.retain(|p, _| under(p, root).is_none());
    }
    fn poll(&mut self, timeout: Duration, out: &mut Vec<RawEvent>) -> io::Result<()> {
        let now = Instant::now();
        if now < self.next {
            std::thread::park_timeout((self.next - now).min(timeout));
            if Instant::now() < self.next {
                return Ok(());
            }
        }
        self.check(out);
        self.next = Instant::now() + self.interval;
        Ok(())
    }
}

#[cfg(windows)]
fn name_from_wide(u: &[u16]) -> OsString {
    use std::os::windows::ffi::OsStringExt;
    OsString::from_wide(u)
}
#[cfg(not(windows))]
fn name_from_wide(u: &[u16]) -> OsString {
    OsString::from(String::from_utf16_lossy(u))
}

/// ReadDirectoryChangesW's FILE_NOTIFY_INFORMATION records → raw events (the old and the new name of a rename come one
/// after the other; an old name with no new one moved out of the watched folder). Pure, so it is tested everywhere.
pub fn parse_notify(root: &Path, bytes: &[u8], out: &mut Vec<RawEvent>) {
    let mut at = 0usize;
    let mut old: Option<PathBuf> = None;
    loop {
        if at + 12 > bytes.len() {
            break;
        }
        let next = u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
        let action = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap());
        let len = u32::from_le_bytes(bytes[at + 8..at + 12].try_into().unwrap()) as usize;
        let end = (at + 12 + len).min(bytes.len());
        let units: Vec<u16> = bytes[at + 12..end].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let path = root.join(name_from_wide(&units));
        match action {
            1 => out.push(RawEvent::Created(path)),
            2 => out.push(RawEvent::Removed(path)),
            3 => out.push(RawEvent::Modified(path)),
            4 => {
                if let Some(o) = old.take() {
                    out.push(RawEvent::Removed(o));
                }
                old = Some(path);
            }
            5 => match old.take() {
                Some(o) => out.push(RawEvent::Moved(o, path)),
                None => out.push(RawEvent::Created(path)),
            },
            _ => {}
        }
        if next == 0 {
            break;
        }
        at += next;
    }
    if let Some(o) = old {
        out.push(RawEvent::Removed(o));
    }
}


/// The system's own watcher where there is one (None: use `MtimePoller`).
pub fn native_watcher() -> Option<Box<dyn Watcher>> {
    #[cfg(target_os = "linux")]
    {
        return linux::Inotify::new().ok().map(|w| Box::new(w) as Box<dyn Watcher>);
    }
    #[cfg(windows)]
    {
        return Some(Box::new(windows::DirChanges::new()));
    }
    #[allow(unreachable_code)]
    None
}

#[cfg(target_os = "linux")]
pub mod linux {
    use super::*;
    use std::ffi::{c_char, c_int, c_ulong, c_void, CString};
    use std::os::unix::ffi::OsStrExt;

    #[repr(C)]
    struct PollFd {
        fd: c_int,
        events: i16,
        revents: i16,
    }
    extern "C" {
        fn inotify_init1(flags: c_int) -> c_int;
        fn inotify_add_watch(fd: c_int, path: *const c_char, mask: u32) -> c_int;
        fn inotify_rm_watch(fd: c_int, wd: c_int) -> c_int;
        fn read(fd: c_int, buf: *mut c_void, n: usize) -> isize;
        fn close(fd: c_int) -> c_int;
        fn poll(fds: *mut PollFd, n: c_ulong, timeout: c_int) -> c_int;
    }
    const IN_NONBLOCK: c_int = 0o4000;
    const IN_CLOEXEC: c_int = 0o2000000;
    const IN_MODIFY: u32 = 0x2;
    const IN_ATTRIB: u32 = 0x4;
    const IN_CLOSE_WRITE: u32 = 0x8;
    const IN_MOVED_FROM: u32 = 0x40;
    const IN_MOVED_TO: u32 = 0x80;
    const IN_CREATE: u32 = 0x100;
    const IN_DELETE: u32 = 0x200;
    const IN_DELETE_SELF: u32 = 0x400;
    const IN_MOVE_SELF: u32 = 0x800;
    const IN_Q_OVERFLOW: u32 = 0x4000;
    const IN_IGNORED: u32 = 0x8000;
    const IN_ONLYDIR: u32 = 0x0100_0000;
    const IN_DONT_FOLLOW: u32 = 0x0200_0000;
    const IN_EXCL_UNLINK: u32 = 0x0400_0000;
    const IN_ISDIR: u32 = 0x4000_0000;
    const MASK: u32 = IN_MODIFY | IN_ATTRIB | IN_CLOSE_WRITE | IN_MOVED_FROM | IN_MOVED_TO | IN_CREATE | IN_DELETE
        | IN_DELETE_SELF | IN_MOVE_SELF | IN_ONLYDIR | IN_DONT_FOLLOW | IN_EXCL_UNLINK;
    const ENOSPC: i32 = 28;

    pub struct Inotify {
        fd: c_int,
        wds: HashMap<c_int, PathBuf>,
        roots: Vec<RootSpec>,
        buf: Vec<u64>,
    }
    // The descriptor is ours alone; nothing in it is tied to a thread.
    unsafe impl Send for Inotify {}

    impl Inotify {
        pub fn new() -> io::Result<Inotify> {
            let fd = unsafe { inotify_init1(IN_NONBLOCK | IN_CLOEXEC) };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Inotify { fd, wds: HashMap::new(), roots: Vec::new(), buf: vec![0u64; 8192] })
        }
        pub fn watches(&self) -> usize {
            self.wds.len()
        }
        fn excluded(&self, p: &Path) -> bool {
            self.roots.iter().any(|r| under(p, &r.path).is_some() && (r.exclude.iter().any(|e| under(p, e).is_some())
                || p.file_name().map_or(false, |n| r.exclude_names.iter().any(|x| super::super::fold::fold(x) == super::super::fold::fold(&n.to_string_lossy())))))
        }
        fn add_one(&mut self, dir: &Path) -> io::Result<()> {
            let c = CString::new(dir.as_os_str().as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
            let wd = unsafe { inotify_add_watch(self.fd, c.as_ptr(), MASK) };
            if wd < 0 {
                return Err(io::Error::last_os_error());
            }
            self.wds.insert(wd, dir.to_path_buf());
            Ok(())
        }
        /// Watches `top` and every folder under it (links not followed, exclusions skipped).
        fn add_tree(&mut self, top: &Path) -> io::Result<()> {
            let mut stack = vec![top.to_path_buf()];
            while let Some(d) = stack.pop() {
                match self.add_one(&d) {
                    Ok(()) => {}
                    Err(e) if e.raw_os_error() == Some(ENOSPC) => {
                        return Err(io::Error::new(io::ErrorKind::Other, "inotify: the system's watch limit is reached"));
                    }
                    Err(_) => continue, // unreadable or gone: not watched, the walk counts it
                }
                let Ok(rd) = std::fs::read_dir(&d) else { continue };
                for e in rd.flatten() {
                    if let Ok(t) = e.file_type() {
                        if t.is_dir() && !t.is_symlink() {
                            let p = e.path();
                            if !self.excluded(&p) {
                                stack.push(p);
                            }
                        }
                    }
                }
            }
            Ok(())
        }
        fn rename_watches(&mut self, from: &Path, to: &Path) {
            for p in self.wds.values_mut() {
                if let Some(rest) = under(p, from) {
                    let mut n = to.to_path_buf();
                    for r in rest {
                        n.push(r);
                    }
                    *p = n;
                }
            }
        }
    }

    impl Drop for Inotify {
        fn drop(&mut self) {
            unsafe {
                close(self.fd);
            }
        }
    }

    impl Watcher for Inotify {
        fn watch(&mut self, root: &RootSpec) -> io::Result<()> {
            self.roots.push(root.clone());
            self.add_tree(&root.path)
        }
        fn unwatch(&mut self, root: &Path) {
            let gone: Vec<c_int> = self.wds.iter().filter(|(_, p)| under(p, root).is_some()).map(|(w, _)| *w).collect();
            for w in gone {
                unsafe {
                    inotify_rm_watch(self.fd, w);
                }
                self.wds.remove(&w);
            }
            self.roots.retain(|r| r.path != root);
        }
        fn poll(&mut self, timeout: Duration, out: &mut Vec<RawEvent>) -> io::Result<()> {
            let mut pfd = PollFd { fd: self.fd, events: 1, revents: 0 };
            let ms = timeout.as_millis().min(i32::MAX as u128) as c_int;
            let r = unsafe { poll(&mut pfd, 1, ms) };
            if r < 0 {
                let e = io::Error::last_os_error();
                return if e.kind() == io::ErrorKind::Interrupted { Ok(()) } else { Err(e) };
            }
            if r == 0 {
                return Ok(());
            }
            // Read everything waiting, then pair the renames (a move's two halves share a cookie).
            let mut evs: Vec<(c_int, u32, u32, Vec<u8>)> = Vec::new();
            loop {
                let cap = self.buf.len() * 8;
                let n = unsafe { read(self.fd, self.buf.as_mut_ptr() as *mut c_void, cap) };
                if n <= 0 {
                    break;
                }
                let bytes = unsafe { std::slice::from_raw_parts(self.buf.as_ptr() as *const u8, n as usize) };
                let mut at = 0usize;
                while at + 16 <= bytes.len() {
                    let wd = i32::from_ne_bytes(bytes[at..at + 4].try_into().unwrap());
                    let mask = u32::from_ne_bytes(bytes[at + 4..at + 8].try_into().unwrap());
                    let cookie = u32::from_ne_bytes(bytes[at + 8..at + 12].try_into().unwrap());
                    let len = u32::from_ne_bytes(bytes[at + 12..at + 16].try_into().unwrap()) as usize;
                    let end = (at + 16 + len).min(bytes.len());
                    let raw = &bytes[at + 16..end];
                    let name = raw.split(|&b| b == 0).next().unwrap_or(&[]).to_vec();
                    evs.push((wd, mask, cookie, name));
                    at = end;
                }
            }
            let mut from: HashMap<u32, (PathBuf, bool)> = HashMap::new();
            let mut order: Vec<u32> = Vec::new();
            for (wd, mask, cookie, name) in evs {
                if mask & IN_Q_OVERFLOW != 0 {
                    for r in &self.roots {
                        out.push(RawEvent::Overflow(r.path.clone()));
                    }
                    continue;
                }
                if mask & IN_IGNORED != 0 {
                    self.wds.remove(&wd);
                    continue;
                }
                let Some(dir) = self.wds.get(&wd).cloned() else { continue };
                let is_dir = mask & IN_ISDIR != 0;
                if name.is_empty() {
                    // About the watched folder itself: its parent's watch reports the same change by name.
                    if mask & (IN_DELETE_SELF | IN_MOVE_SELF) != 0 && self.roots.iter().any(|r| r.path == dir) {
                        out.push(RawEvent::Overflow(dir));
                    }
                    continue;
                }
                let path = dir.join(std::ffi::OsStr::from_bytes(&name));
                if mask & IN_CREATE != 0 {
                    if is_dir && !self.excluded(&path) {
                        let _ = self.add_tree(&path);
                    }
                    out.push(RawEvent::Created(path));
                } else if mask & IN_DELETE != 0 {
                    out.push(RawEvent::Removed(path));
                } else if mask & IN_MOVED_FROM != 0 {
                    from.insert(cookie, (path, is_dir));
                    order.push(cookie);
                } else if mask & IN_MOVED_TO != 0 {
                    match from.remove(&cookie) {
                        Some((old, d)) => {
                            if d {
                                self.rename_watches(&old, &path);
                            }
                            out.push(RawEvent::Moved(old, path));
                        }
                        None => {
                            if is_dir && !self.excluded(&path) {
                                let _ = self.add_tree(&path);
                            }
                            out.push(RawEvent::Created(path));
                        }
                    }
                } else if mask & (IN_MODIFY | IN_CLOSE_WRITE | IN_ATTRIB) != 0 {
                    out.push(RawEvent::Modified(path));
                }
            }
            // A half without its pair moved out of the watched folders.
            for c in order {
                if let Some((old, d)) = from.remove(&c) {
                    if d {
                        let gone: Vec<c_int> = self.wds.iter().filter(|(_, p)| under(p, &old).is_some()).map(|(w, _)| *w).collect();
                        for w in gone {
                            unsafe {
                                inotify_rm_watch(self.fd, w);
                            }
                            self.wds.remove(&w);
                        }
                    }
                    out.push(RawEvent::Removed(old));
                }
            }
            Ok(())
        }
    }
}

#[cfg(windows)]
pub mod windows {
    //! ReadDirectoryChangesW, overlapped, one handle and one manual-reset event per root. Type-checked only on a
    //! Windows build (GitHub); declared here by hand to stay std only.
    use super::*;
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    type Handle = *mut c_void;
    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
    const FILE_LIST_DIRECTORY: u32 = 0x0001;
    const FILE_SHARE_ALL: u32 = 0x1 | 0x2 | 0x4;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    const FILTER: u32 = 0x1 | 0x2 | 0x8 | 0x10 | 0x40; // file name, dir name, size, last write, creation
    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_TIMEOUT: u32 = 0x102;
    const ERROR_IO_INCOMPLETE: i32 = 996;
    const ERROR_NOTIFY_ENUM_DIR: i32 = 1022;
    const ERROR_OPERATION_ABORTED: i32 = 995;
    const BUF_WORDS: usize = 16 * 1024; // 64 KiB: the most a network share accepts

    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        event: Handle,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(name: *const u16, access: u32, share: u32, sa: *mut c_void, disp: u32, flags: u32, template: Handle) -> Handle;
        fn ReadDirectoryChangesW(dir: Handle, buf: *mut c_void, len: u32, subtree: i32, filter: u32, returned: *mut u32, ov: *mut Overlapped, routine: *mut c_void) -> i32;
        fn GetOverlappedResult(h: Handle, ov: *mut Overlapped, n: *mut u32, wait: i32) -> i32;
        fn CreateEventW(sa: *mut c_void, manual: i32, initial: i32, name: *const u16) -> Handle;
        fn ResetEvent(h: Handle) -> i32;
        fn WaitForMultipleObjects(n: u32, hs: *const Handle, all: i32, ms: u32) -> u32;
        fn CancelIoEx(h: Handle, ov: *mut Overlapped) -> i32;
        fn CloseHandle(h: Handle) -> i32;
    }

    struct Root {
        path: PathBuf,
        dir: Handle,
        ov: Box<Overlapped>,
        buf: Box<[u32]>,
        armed: bool,
    }

    impl Root {
        fn arm(&mut self) -> bool {
            unsafe {
                ResetEvent(self.ov.event);
                let ok = ReadDirectoryChangesW(
                    self.dir,
                    self.buf.as_mut_ptr() as *mut c_void,
                    (self.buf.len() * 4) as u32,
                    1,
                    FILTER,
                    std::ptr::null_mut(),
                    &mut *self.ov,
                    std::ptr::null_mut(),
                );
                self.armed = ok != 0;
            }
            self.armed
        }
    }

    impl Drop for Root {
        fn drop(&mut self) {
            unsafe {
                if self.armed {
                    // The kernel writes into buf until the request is gone: cancel, then wait for it to end.
                    CancelIoEx(self.dir, &mut *self.ov);
                    let mut n = 0u32;
                    GetOverlappedResult(self.dir, &mut *self.ov, &mut n, 1);
                }
                CloseHandle(self.dir);
                CloseHandle(self.ov.event);
            }
        }
    }

    /// A path CreateFileW takes whatever its length (\\?\ form for long paths).
    fn wide(p: &Path) -> Vec<u16> {
        let s: Vec<u16> = p.as_os_str().encode_wide().collect();
        let mut out: Vec<u16> = Vec::with_capacity(s.len() + 8);
        let starts = |pre: &str| s.starts_with(&pre.encode_utf16().collect::<Vec<u16>>());
        if s.len() >= 248 && !starts("\\\\?\\") {
            if starts("\\\\") {
                out.extend("\\\\?\\UNC\\".encode_utf16());
                out.extend_from_slice(&s[2..]);
            } else {
                out.extend("\\\\?\\".encode_utf16());
                out.extend_from_slice(&s);
            }
        } else {
            out.extend_from_slice(&s);
        }
        out.push(0);
        out
    }

    pub struct DirChanges {
        roots: Vec<Root>,
    }
    // The handles belong to this value alone and Windows handles are not tied to a thread.
    unsafe impl Send for DirChanges {}

    impl DirChanges {
        pub fn new() -> DirChanges {
            DirChanges { roots: Vec::new() }
        }

        fn read(&mut self, i: usize, out: &mut Vec<RawEvent>) {
            let r = &mut self.roots[i];
            let mut n = 0u32;
            let ok = unsafe { GetOverlappedResult(r.dir, &mut *r.ov, &mut n, 0) };
            if ok == 0 {
                let e = io::Error::last_os_error().raw_os_error().unwrap_or(0);
                if e == ERROR_IO_INCOMPLETE {
                    return;
                }
                r.armed = false;
                out.push(RawEvent::Overflow(r.path.clone()));
                if e == ERROR_NOTIFY_ENUM_DIR || e == ERROR_OPERATION_ABORTED {
                    r.arm();
                }
                return;
            }
            r.armed = false;
            if n == 0 {
                out.push(RawEvent::Overflow(r.path.clone())); // the buffer was too small for what happened
            } else {
                let bytes = unsafe { std::slice::from_raw_parts(r.buf.as_ptr() as *const u8, (n as usize).min(r.buf.len() * 4)) };
                super::parse_notify(&r.path, bytes, out);
            }
            r.arm();
        }
    }

    impl Watcher for DirChanges {
        fn watch(&mut self, root: &RootSpec) -> io::Result<()> {
            if self.roots.len() >= 64 {
                return Err(io::Error::new(io::ErrorKind::Other, "at most 64 watched roots"));
            }
            let name = wide(&root.path);
            let dir = unsafe {
                CreateFileW(name.as_ptr(), FILE_LIST_DIRECTORY, FILE_SHARE_ALL, std::ptr::null_mut(), OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED, std::ptr::null_mut())
            };
            if dir == INVALID_HANDLE_VALUE || dir.is_null() {
                return Err(io::Error::last_os_error());
            }
            let event = unsafe { CreateEventW(std::ptr::null_mut(), 1, 0, std::ptr::null()) };
            if event.is_null() {
                let e = io::Error::last_os_error();
                unsafe {
                    CloseHandle(dir);
                }
                return Err(e);
            }
            let ov = Box::new(Overlapped { internal: 0, internal_high: 0, offset: 0, offset_high: 0, event });
            let mut r = Root { path: root.path.clone(), dir, ov, buf: vec![0u32; BUF_WORDS].into_boxed_slice(), armed: false };
            if !r.arm() {
                return Err(io::Error::last_os_error()); // r's Drop closes both handles
            }
            self.roots.push(r);
            Ok(())
        }
        fn unwatch(&mut self, root: &Path) {
            self.roots.retain(|r| r.path != root);
        }
        fn poll(&mut self, timeout: Duration, out: &mut Vec<RawEvent>) -> io::Result<()> {
            if self.roots.is_empty() {
                std::thread::park_timeout(timeout);
                return Ok(());
            }
            let mut ms = timeout.as_millis().min(u32::MAX as u128 - 1) as u32;
            // Bounded: each round takes one signalled root; a root that keeps signalling cannot hold the caller.
            for _ in 0..self.roots.len() * 4 + 1 {
                let hs: Vec<Handle> = self.roots.iter().map(|r| r.ov.event).collect();
                let w = unsafe { WaitForMultipleObjects(hs.len() as u32, hs.as_ptr(), 0, ms) };
                if w == WAIT_TIMEOUT {
                    return Ok(());
                }
                let i = w.wrapping_sub(WAIT_OBJECT_0) as usize;
                if i >= hs.len() {
                    return Err(io::Error::last_os_error());
                }
                self.read(i, out);
                // Rearming failed (the folder is gone): drop it, the Overflow above makes the shell look again.
                if !self.roots[i].armed {
                    self.roots.remove(i);
                }
                ms = 0; // take whatever else is ready, then return
                if self.roots.is_empty() {
                    return Ok(());
                }
            }
            Ok(())
        }
    }
}
