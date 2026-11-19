//! The index running for the shell: one worker thread walks (at background priority, pausable, cancellable) and
//! applies the watcher's changes; one watcher thread waits on the system's watcher (or the mtime poller) and hands the
//! changes over; queries run on the caller's thread under a shared lock, each new one stopping the one before it.
//! The index is saved to its file after changes (at most every `save_every`) and when the service stops.
//! Nothing is sent anywhere and no file's contents are read.
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::persist::LoadError;
use super::query::{Cancelled, Query, QueryResult, Searcher};
use super::store::{under, Applied, Change, Index, IndexStats, RootSpec, RootStatus};
use super::walk::{lower_thread_priority, Fs, Progress, Source, WalkCtrl};
use super::watch::{to_changes, MtimePoller, RawEvent, Watcher};

pub struct ServiceOptions {
    /// The index file in the app-data folder (None: kept in memory only).
    pub file: Option<PathBuf>,
    /// The roots from the shell's settings (the source of truth: the file's are reconciled with them).
    pub roots: Vec<RootSpec>,
    pub source: Arc<dyn Source>,
    pub fs: Arc<dyn Fs>,
    /// The system's watcher (`native_watcher()`), or None for the mtime poller.
    pub watcher: Option<Box<dyn Watcher>>,
    pub poll_interval: Duration,
    pub save_every: Duration,
    pub low_priority: bool,
}

#[derive(Clone, Debug)]
pub struct Status {
    pub progress: Progress,
    /// A walk is running or queued.
    pub busy: bool,
    pub queued: usize,
    pub stats: IndexStats,
    pub roots: Vec<RootStatus>,
    /// The index file's size on disk (0: not saved yet).
    pub file_bytes: u64,
    /// Why the saved index was not used at start (damaged, other version), or the watcher's trouble.
    pub note: Option<String>,
    /// The changes applied since the start.
    pub changes_applied: u64,
}

enum WatchCmd {
    Add(RootSpec),
    Remove(PathBuf),
}

struct State {
    jobs: VecDeque<PathBuf>,
    current: Option<PathBuf>,
    changes: Vec<Change>,
    note: Option<String>,
    watch_cmds: Vec<WatchCmd>,
    save_now: bool,
    applied: u64,
}

struct Shared {
    index: RwLock<Index>,
    /// Held by whoever writes the index from outside the worker (adding, removing a root) and by the worker while it
    /// builds a walk aside and swaps it in: nothing changes between the build and the swap.
    writers: Mutex<()>,
    ctrl: WalkCtrl,
    stop: AtomicBool,
    st: Mutex<State>,
    cv: Condvar,
    searcher: Searcher,
    file: Option<PathBuf>,
    /// Set by `discard`: nothing is saved any more (the user removed the index).
    discarded: AtomicBool,
}

pub struct Service {
    sh: Arc<Shared>,
    threads: Vec<JoinHandle<()>>,
}

struct ArcFs(Arc<dyn Fs>);
impl Fs for ArcFs {
    fn read_dir(&self, dir: &Path, item: &mut dyn FnMut(std::ffi::OsString, super::store::Meta)) -> std::io::Result<()> {
        self.0.read_dir(dir, item)
    }
    fn lstat(&self, path: &Path) -> std::io::Result<super::store::Meta> {
        self.0.lstat(path)
    }
}

fn note_of(e: &LoadError) -> Option<String> {
    match e {
        LoadError::Missing => None,
        LoadError::OtherVersion(v) => Some(format!("the saved index was of version {v}; it is built again")),
        LoadError::Damaged(w) => Some(format!("the saved index was damaged ({w}); it is built again")),
        LoadError::Io(m) => Some(format!("the saved index could not be read ({m}); it is built again")),
    }
}

impl Index {
    /// Makes the roots match `specs`: roots no longer chosen are removed, new ones added; returns those to walk (new
    /// ones and those whose exclusions changed).
    pub fn reconcile_roots(&mut self, specs: &[RootSpec]) -> Vec<RootSpec> {
        let old = self.root_specs();
        for o in &old {
            if !specs.iter().any(|s| s.path == o.path) {
                self.remove_root(&o.path);
            }
        }
        let mut walk = Vec::new();
        for s in specs {
            match old.iter().find(|o| o.path == s.path) {
                Some(o) if o == s => {}
                Some(_) => {
                    self.remove_root(&s.path);
                    if self.add_root(s.clone()).is_ok() {
                        walk.push(s.clone());
                    }
                }
                None => {
                    if self.add_root(s.clone()).is_ok() {
                        walk.push(s.clone());
                    }
                }
            }
        }
        walk
    }
}

impl Service {
    pub fn start(o: ServiceOptions) -> Service {
        let (mut ix, note) = match &o.file {
            Some(f) => {
                let (ix, _stale, err) = Index::load_or_new(f);
                (ix, err.as_ref().and_then(note_of))
            }
            None => (Index::new(), None),
        };
        ix.reconcile_roots(&o.roots);
        // Every root is walked again: what changed while the program was closed is unknown. The loaded entries answer
        // queries meanwhile.
        let jobs: VecDeque<PathBuf> = ix.root_specs().into_iter().map(|s| s.path).collect();
        let watch_cmds = ix.root_specs().into_iter().map(WatchCmd::Add).collect();
        let sh = Arc::new(Shared {
            index: RwLock::new(ix),
            writers: Mutex::new(()),
            ctrl: WalkCtrl::new(),
            stop: AtomicBool::new(false),
            st: Mutex::new(State { jobs, current: None, changes: Vec::new(), note, watch_cmds, save_now: false, applied: 0 }),
            cv: Condvar::new(),
            searcher: Searcher::new(),
            file: o.file.clone(),
            discarded: AtomicBool::new(false),
        });
        let mut threads = Vec::new();
        {
            let sh = sh.clone();
            let source = o.source.clone();
            let (save_every, low) = (o.save_every, o.low_priority);
            threads.push(std::thread::Builder::new().name("kt-fileindex-walk".into()).spawn(move || worker(sh, source, save_every, low)).expect("thread"));
        }
        {
            let sh = sh.clone();
            let fs = o.fs.clone();
            let watcher = o.watcher;
            let interval = o.poll_interval;
            threads.push(std::thread::Builder::new().name("kt-fileindex-watch".into()).spawn(move || watch_loop(sh, fs, watcher, interval)).expect("thread"));
        }
        Service { sh, threads }
    }

    /// Runs a query; Err(Cancelled) when a newer one began meanwhile.
    pub fn search(&self, q: &Query) -> Result<QueryResult, Cancelled> {
        let t = self.sh.searcher.begin();
        let ix = self.sh.index.read().unwrap_or_else(|e| e.into_inner());
        ix.search(q, &t)
    }

    /// Stops every running query (the page closed).
    pub fn cancel_queries(&self) {
        self.sh.searcher.cancel_all();
    }

    pub fn add_root(&self, spec: RootSpec) -> Result<(), PathBuf> {
        {
            let _w = self.sh.writers.lock().unwrap_or_else(|e| e.into_inner());
            self.sh.index.write().unwrap_or_else(|e| e.into_inner()).add_root(spec.clone())?;
        }
        let mut st = self.sh.st.lock().unwrap_or_else(|e| e.into_inner());
        st.jobs.push_back(spec.path.clone());
        st.watch_cmds.push(WatchCmd::Add(spec));
        self.sh.cv.notify_all();
        Ok(())
    }

    /// Forgets a root: its walk stops, its entries go, its watch ends.
    pub fn remove_root(&self, path: &Path) -> bool {
        {
            let mut st = self.sh.st.lock().unwrap_or_else(|e| e.into_inner());
            st.jobs.retain(|j| under(j, path).is_none());
            if st.current.as_ref().map_or(false, |c| under(c, path).is_some()) {
                self.sh.ctrl.cancel.store(true, Ordering::SeqCst);
            }
            st.watch_cmds.push(WatchCmd::Remove(path.to_path_buf()));
            st.changes.retain(|c| !change_under(c, path));
        }
        let ok = {
            let _w = self.sh.writers.lock().unwrap_or_else(|e| e.into_inner());
            self.sh.index.write().unwrap_or_else(|e| e.into_inner()).remove_root(path)
        };
        self.sh.st.lock().unwrap_or_else(|e| e.into_inner()).save_now = true;
        self.sh.cv.notify_all();
        ok
    }

    /// Walks every root again (the entries already there answer until each walk is installed).
    pub fn rebuild(&self) {
        let roots = self.sh.index.read().unwrap_or_else(|e| e.into_inner()).root_specs();
        let mut st = self.sh.st.lock().unwrap_or_else(|e| e.into_inner());
        if st.current.is_some() {
            self.sh.ctrl.cancel.store(true, Ordering::SeqCst);
        }
        st.jobs = roots.into_iter().map(|r| r.path).collect();
        self.sh.cv.notify_all();
    }

    /// Pauses or resumes the walking (the shell sets it on battery). Watching goes on.
    pub fn set_paused(&self, paused: bool) {
        self.sh.ctrl.pause.store(paused, Ordering::SeqCst);
        self.sh.cv.notify_all();
    }

    /// The index is being removed: it is never saved again, and the walk stops (the shell then stops the service
    /// and deletes the file).
    pub fn discard(&self) {
        self.sh.discarded.store(true, Ordering::SeqCst);
        self.sh.ctrl.cancel.store(true, Ordering::SeqCst);
        self.sh.searcher.cancel_all();
        self.sh.cv.notify_all();
    }

    pub fn save_now(&self) {
        self.sh.st.lock().unwrap_or_else(|e| e.into_inner()).save_now = true;
        self.sh.cv.notify_all();
    }

    pub fn status(&self) -> Status {
        let (stats, roots) = {
            let ix = self.sh.index.read().unwrap_or_else(|e| e.into_inner());
            (ix.stats(), ix.roots())
        };
        let st = self.sh.st.lock().unwrap_or_else(|e| e.into_inner());
        let file_bytes = self.sh.file.as_ref().and_then(|f| std::fs::metadata(f).ok()).map_or(0, |m| m.len());
        Status {
            progress: self.sh.ctrl.progress(),
            busy: st.current.is_some() || !st.jobs.is_empty(),
            queued: st.jobs.len(),
            stats,
            roots,
            file_bytes,
            note: st.note.clone(),
            changes_applied: st.applied,
        }
    }

    /// Hands changes in as a watcher would (the shell's own file jobs can report what they did at once).
    pub fn push_changes(&self, ch: Vec<Change>) {
        let mut st = self.sh.st.lock().unwrap_or_else(|e| e.into_inner());
        st.changes.extend(ch);
        self.sh.cv.notify_all();
    }

    /// Stops the threads (the walk is cancelled) and saves.
    pub fn stop(&mut self) {
        self.sh.stop.store(true, Ordering::SeqCst);
        self.sh.ctrl.cancel.store(true, Ordering::SeqCst);
        self.sh.cv.notify_all();
        for t in self.threads.drain(..) {
            t.thread().unpark();
            let _ = t.join();
        }
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        self.stop();
    }
}

fn change_under(c: &Change, root: &Path) -> bool {
    let p = match c {
        Change::Created { path, .. } | Change::Removed { path } | Change::Modified { path, .. } => path,
        Change::Moved { to, .. } => to,
        Change::Overflow { dir } | Change::Listed { dir, .. } => dir,
    };
    under(p, root).is_some()
}

fn save(sh: &Shared) {
    let Some(f) = &sh.file else { return };
    if sh.discarded.load(Ordering::SeqCst) {
        return;
    }
    let bytes = sh.index.read().unwrap_or_else(|e| e.into_inner()).to_bytes();
    if let Some(dir) = f.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut tmp = f.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let ok = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut fh = std::fs::File::create(&tmp)?;
        fh.write_all(&bytes)?;
        fh.sync_all()?;
        drop(fh);
        std::fs::rename(&tmp, f)
    })();
    if ok.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Installs a walk: a big whole-root walk is built aside under the shared lock (queries go on) and swapped in under
/// a short write lock, the old index dropped after the lock is released; anything else is installed in place.
fn install(sh: &Shared, w: super::store::Walked) -> bool {
    let _w = sh.writers.lock().unwrap_or_else(|e| e.into_inner());
    let path = w.path.clone();
    let built = {
        let ix = sh.index.read().unwrap_or_else(|e| e.into_inner());
        if ix.worth_aside(&w) { ix.installed_aside(w).map(|n| (ix.generation(), n)) } else { Err(w) }
    };
    match built {
        Ok((gen, fresh)) => {
            let old = {
                let mut ix = sh.index.write().unwrap_or_else(|e| e.into_inner());
                // The writers' lock keeps the index as it was read; should it differ all the same, the newer one stays
                // and the root is walked again.
                if ix.generation() == gen {
                    Some(std::mem::replace(&mut *ix, fresh))
                } else {
                    None
                }
            };
            match old {
                Some(old) => {
                    drop(old);
                    true
                }
                None => {
                    sh.st.lock().unwrap_or_else(|e| e.into_inner()).jobs.push_back(path);
                    true
                }
            }
        }
        Err(w) => sh.index.write().unwrap_or_else(|e| e.into_inner()).install(w),
    }
}

fn worker(sh: Arc<Shared>, source: Arc<dyn Source>, save_every: Duration, low: bool) {
    if low {
        lower_thread_priority();
    }
    let mut saved_gen = sh.index.read().unwrap_or_else(|e| e.into_inner()).generation();
    let mut last_save = Instant::now();
    loop {
        // Changes first (cheap), then one walk, then a save when due.
        let (changes, job, save_req) = {
            let mut st = sh.st.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if sh.stop.load(Ordering::SeqCst) {
                    break;
                }
                let paused = sh.ctrl.pause.load(Ordering::SeqCst);
                if !st.changes.is_empty() || (!st.jobs.is_empty() && !paused) || st.save_now {
                    break;
                }
                let (g, _) = sh.cv.wait_timeout(st, Duration::from_millis(500)).unwrap_or_else(|e| e.into_inner());
                st = g;
                let gen = sh.index.read().unwrap_or_else(|e| e.into_inner()).generation();
                if gen != saved_gen && last_save.elapsed() >= save_every {
                    break;
                }
            }
            let changes = std::mem::take(&mut st.changes);
            let job = if sh.ctrl.pause.load(Ordering::SeqCst) { None } else { st.jobs.pop_front() };
            if let Some(j) = &job {
                st.current = Some(j.clone());
            }
            let save_req = std::mem::take(&mut st.save_now);
            (changes, job, save_req)
        };
        if sh.stop.load(Ordering::SeqCst) {
            break;
        }
        if !changes.is_empty() {
            let mut rescans = Vec::new();
            let n = changes.len() as u64;
            {
                let mut ix = sh.index.write().unwrap_or_else(|e| e.into_inner());
                for c in &changes {
                    if let Applied::Rescan(v) = ix.apply(c) {
                        rescans.extend(v);
                    }
                }
            }
            let mut st = sh.st.lock().unwrap_or_else(|e| e.into_inner());
            st.applied += n;
            for r in rescans {
                // Skip a folder already queued or under one that is.
                if !st.jobs.iter().any(|j| under(&r, j).is_some()) {
                    st.jobs.retain(|j| under(j, &r).is_none());
                    st.jobs.push_back(r);
                }
            }
        }
        if let Some(dir) = job {
            let spec = sh.index.read().unwrap_or_else(|e| e.into_inner()).root_spec_for(&dir);
            if let Some(spec) = spec {
                sh.ctrl.cancel.store(false, Ordering::SeqCst);
                let w = source.walk(&spec, &dir, &sh.ctrl);
                let cancelled = w.cancelled || sh.ctrl.cancel.load(Ordering::SeqCst);
                if !cancelled {
                    let installed = install(&sh, w);
                    if !installed && dir != spec.path {
                        // Its folder is not indexed (yet): walk the parent instead.
                        if let Some(p) = dir.parent() {
                            sh.st.lock().unwrap_or_else(|e| e.into_inner()).jobs.push_back(p.to_path_buf());
                        }
                    }
                }
                sh.ctrl.cancel.store(false, Ordering::SeqCst);
            }
            sh.st.lock().unwrap_or_else(|e| e.into_inner()).current = None;
        }
        let gen = sh.index.read().unwrap_or_else(|e| e.into_inner()).generation();
        if save_req || (gen != saved_gen && last_save.elapsed() >= save_every) {
            save(&sh);
            saved_gen = gen;
            last_save = Instant::now();
        }
    }
    let gen = sh.index.read().unwrap_or_else(|e| e.into_inner()).generation();
    if gen != saved_gen {
        save(&sh);
    }
}

fn watch_loop(sh: Arc<Shared>, fs: Arc<dyn Fs>, watcher: Option<Box<dyn Watcher>>, interval: Duration) {
    let poller = |fs: &Arc<dyn Fs>| -> Box<dyn Watcher> { Box::new(MtimePoller::new(ArcFs(fs.clone()), interval)) };
    let mut w: Box<dyn Watcher> = watcher.unwrap_or_else(|| poller(&fs));
    let mut fell_back = false;
    let mut watched: Vec<RootSpec> = Vec::new();
    let mut raw: Vec<RawEvent> = Vec::new();
    while !sh.stop.load(Ordering::SeqCst) {
        let cmds = std::mem::take(&mut sh.st.lock().unwrap_or_else(|e| e.into_inner()).watch_cmds);
        for c in cmds {
            match c {
                WatchCmd::Add(spec) => {
                    if let Err(e) = w.watch(&spec) {
                        if !fell_back {
                            // The system's watcher refused (inotify's limit, a share): every root goes to the poller.
                            fell_back = true;
                            w = poller(&fs);
                            for s in &watched {
                                let _ = w.watch(s);
                            }
                            let _ = w.watch(&spec);
                            sh.st.lock().unwrap_or_else(|e| e.into_inner()).note = Some(format!("changes are found by looking every few seconds ({e})"));
                        }
                    }
                    watched.push(spec);
                }
                WatchCmd::Remove(p) => {
                    w.unwatch(&p);
                    watched.retain(|s| s.path != p);
                }
            }
        }
        raw.clear();
        if w.poll(Duration::from_millis(250), &mut raw).is_err() {
            std::thread::park_timeout(Duration::from_millis(250));
            continue;
        }
        if raw.is_empty() {
            continue;
        }
        let ch = to_changes(std::mem::take(&mut raw), &*fs);
        if !ch.is_empty() {
            let mut st = sh.st.lock().unwrap_or_else(|e| e.into_inner());
            st.changes.extend(ch);
            sh.cv.notify_all();
        }
    }
}
