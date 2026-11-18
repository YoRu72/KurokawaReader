//! The index itself: every entry of the chosen folders in parallel columns (no String or PathBuf per entry). Names
//! live in one byte arena (the platform's own encoding of the name, so a path is rebuilt exactly, odd names
//! included) beside their folded form (stored only when it differs from the name); an entry knows its parent, its
//! first child and its siblings by u32 ids, so a path is rebuilt on demand and a folder moves by changing one link.
//! Ids are stable while the program runs (a freed slot is reused); persistence renumbers.
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use super::fold::{ext_of, fold, kind_of_ext, Kind};

pub type EntryId = u32;
pub const NONE: EntryId = u32::MAX;

pub(crate) const F_DIR: u8 = 1;
pub(crate) const F_LINK: u8 = 2;
pub(crate) const F_ROOT: u8 = 4;
pub(crate) const F_DEAD: u8 = 8;
/// A folder that could not be listed (permission, gone while walking): recorded, its contents unknown.
pub(crate) const F_UNREAD: u8 = 16;
/// A folder whose children are also kept in the by-name map (it grew past BIG_DIR on a lookup).
const F_BIG: u8 = 32;
/// Two children of a big folder share a map key: a miss in its map is then checked by a scan.
const F_COLLIDED: u8 = 64;
const BIG_DIR: usize = 128;

/// What the walker and the watchers know of one entry. Times are milliseconds since 1970 (0: unknown).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Meta {
    pub size: u64,
    pub mtime: i64,
    pub is_dir: bool,
    /// A symbolic link, a junction or another name surrogate: recorded, never followed.
    pub is_link: bool,
}

/// A folder the user chose, with what is left out under it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RootSpec {
    pub path: PathBuf,
    /// Folders (full paths) never entered.
    pub exclude: Vec<PathBuf>,
    /// Folder names never entered wherever they are (e.g. «node_modules», «.git»), compared folded.
    pub exclude_names: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct Root {
    pub spec: RootSpec,
    pub id: EntryId,
    pub last_walk_ms: i64,
    pub unreadable: u64,
    pub walked: bool,
    pub excl_names_folded: Vec<String>,
}

/// One root as the page shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RootStatus {
    pub path: PathBuf,
    pub entries: u64,
    pub walked: bool,
    pub last_walk_ms: i64,
    /// Folders that could not be read during the last walk.
    pub unreadable: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IndexStats {
    pub entries: u64,
    pub folders: u64,
    pub files: u64,
    /// Memory held by the index (columns, arena, maps), in bytes.
    pub memory_bytes: u64,
    pub roots: u32,
}

/// What `apply` did with a change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Applied {
    Done,
    /// Not under any root, inside an excluded folder, or already as described.
    Ignored,
    /// The shell should walk these folders again (`Source::walk` + `install`): a new folder (what was made in it
    /// before its watch started is unknown), a lost watcher queue, or a change whose folder is not indexed yet.
    Rescan(Vec<PathBuf>),
}

/// A change reported by a watcher (already stated: `meta` comes from an lstat of the new path).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    Created { path: PathBuf, meta: Meta },
    Removed { path: PathBuf },
    Modified { path: PathBuf, meta: Meta },
    /// A rename or a move (same thing to the index, also across roots); `meta` of the new path when known.
    Moved { from: PathBuf, to: PathBuf, meta: Option<Meta> },
    /// The watcher lost events under this folder.
    Overflow { dir: PathBuf },
    /// A folder's whole listing as it is now (the mtime poller): compared with the index (`sync_dir`).
    Listed { dir: PathBuf, items: Vec<(OsString, Meta)> },
}

pub struct Index {
    pub(crate) arena: Vec<u8>,
    pub(crate) garbage: usize,
    pub(crate) name_off: Vec<u32>,
    pub(crate) name_len: Vec<u16>,
    pub(crate) fold_off: Vec<u32>,
    pub(crate) fold_len: Vec<u16>,
    /// Which byte pairs the folded name holds, as a 64-bit sketch (`grams`): a query skips a name missing any of its
    /// word's pairs without looking at the name.
    pub(crate) grams: Vec<u64>,
    pub(crate) parent: Vec<u32>,
    pub(crate) first_child: Vec<u32>,
    pub(crate) next_sib: Vec<u32>,
    pub(crate) prev_sib: Vec<u32>,
    pub(crate) size: Vec<u64>,
    pub(crate) mtime: Vec<i64>,
    pub(crate) flags: Vec<u8>,
    pub(crate) kind: Vec<u8>,
    free: Vec<u32>,
    live: usize,
    dirs: usize,
    big: HashMap<(u32, u64), u32>,
    pub(crate) roots: Vec<Root>,
    /// Bumped by every change (the query's path order cache and the shell's «needs saving» use it).
    pub(crate) gen: u64,
    pub(crate) path_rank: Mutex<Option<(u64, std::sync::Arc<Vec<u32>>)>>,
}

impl Default for Index {
    fn default() -> Self {
        Index::new()
    }
}

/// The by-name map's key: the name's hash, without case where the file system ignores case.
pub(crate) fn name_key(b: &[u8]) -> u64 {
    if cfg!(any(windows, target_os = "macos")) {
        if b.is_ascii() {
            let mut h: u64 = 0xcbf29ce484222325;
            for &x in b {
                h ^= x.to_ascii_lowercase() as u64;
                h = h.wrapping_mul(0x100000001b3);
            }
            return h;
        }
        return name_hash(String::from_utf8_lossy(b).to_lowercase().as_bytes());
    }
    name_hash(b)
}

pub(crate) fn name_hash(b: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &x in b {
        h ^= x as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// The sketch of the byte pairs in `b`: one of 64 bits per pair.
#[inline]
pub(crate) fn grams(b: &[u8]) -> u64 {
    let mut m = 0u64;
    for w in b.windows(2) {
        let h = ((w[0] as u32) << 8 | w[1] as u32).wrapping_mul(0x9E37_79B1);
        m |= 1u64 << (h >> 26);
    }
    m
}

pub(crate) fn os_bytes(s: &OsStr) -> &[u8] {
    s.as_encoded_bytes()
}

/// Bytes this index stored from `as_encoded_bytes` (or checked by `valid_os_bytes` when loaded).
pub(crate) fn bytes_os(b: &[u8]) -> &OsStr {
    // SAFETY: every name in the arena came from OsStr::as_encoded_bytes in this process, from a &str, or was checked
    // by persist.rs with `valid_os_bytes` (UTF-8 / WTF-8) before it entered the arena.
    unsafe { OsStr::from_encoded_bytes_unchecked(b) }
}

/// Two names the file system treats as one (Windows and macOS compare without case; Linux byte for byte).
pub(crate) fn same_name(a: &[u8], b: &[u8]) -> bool {
    if a == b {
        return true;
    }
    if cfg!(any(windows, target_os = "macos")) {
        let (x, y) = (String::from_utf8_lossy(a), String::from_utf8_lossy(b));
        return x.to_lowercase() == y.to_lowercase();
    }
    false
}

/// `p` relative to `base` comparing components the platform's way; None when `p` is not under (or equal to) `base`.
pub(crate) fn under<'a>(p: &'a Path, base: &Path) -> Option<Vec<&'a OsStr>> {
    let mut pc = p.components();
    for b in base.components() {
        match (b, pc.next()) {
            (Component::Normal(x), Some(Component::Normal(y))) => {
                if !same_name(os_bytes(x), os_bytes(y)) {
                    return None;
                }
            }
            (Component::CurDir, _) => {}
            (x, Some(y)) => {
                if x != y {
                    // A Windows prefix («C:» / «c:») without case.
                    let (xs, ys) = (x.as_os_str(), y.as_os_str());
                    if !same_name(os_bytes(xs), os_bytes(ys)) {
                        return None;
                    }
                }
            }
            (_, None) => return None,
        }
    }
    Some(pc.filter_map(|c| if let Component::Normal(s) = c { Some(s) } else { None }).collect())
}

impl Index {
    pub fn new() -> Index {
        Index {
            arena: Vec::new(),
            garbage: 0,
            name_off: Vec::new(),
            name_len: Vec::new(),
            fold_off: Vec::new(),
            fold_len: Vec::new(),
            grams: Vec::new(),
            parent: Vec::new(),
            first_child: Vec::new(),
            next_sib: Vec::new(),
            prev_sib: Vec::new(),
            size: Vec::new(),
            mtime: Vec::new(),
            flags: Vec::new(),
            kind: Vec::new(),
            free: Vec::new(),
            live: 0,
            dirs: 0,
            big: HashMap::new(),
            roots: Vec::new(),
            gen: 0,
            path_rank: Mutex::new(None),
        }
    }

    /// Room for `n` more entries and `bytes` more name bytes (the walker and the benchmark).
    pub fn reserve(&mut self, n: usize, bytes: usize) {
        self.arena.reserve(bytes);
        for v in [&mut self.name_off, &mut self.fold_off, &mut self.parent, &mut self.first_child, &mut self.next_sib, &mut self.prev_sib] {
            v.reserve(n);
        }
        self.name_len.reserve(n);
        self.fold_len.reserve(n);
        self.grams.reserve(n);
        self.size.reserve(n);
        self.mtime.reserve(n);
        self.flags.reserve(n);
        self.kind.reserve(n);
    }

    pub(crate) fn slots(&self) -> usize {
        self.flags.len()
    }
    pub fn generation(&self) -> u64 {
        self.gen
    }
    pub(crate) fn alive(&self, id: EntryId) -> bool {
        (id as usize) < self.flags.len() && self.flags[id as usize] & F_DEAD == 0
    }
    pub(crate) fn name_bytes(&self, id: EntryId) -> &[u8] {
        let i = id as usize;
        &self.arena[self.name_off[i] as usize..self.name_off[i] as usize + self.name_len[i] as usize]
    }
    pub(crate) fn folded(&self, id: EntryId) -> &str {
        let i = id as usize;
        let b = &self.arena[self.fold_off[i] as usize..self.fold_off[i] as usize + self.fold_len[i] as usize];
        // SAFETY: folded forms are written from a String (insert / persist recompute them), so they are UTF-8.
        unsafe { std::str::from_utf8_unchecked(b) }
    }
    /// The entry's name as the page shows it.
    pub fn name(&self, id: EntryId) -> String {
        if self.flags[id as usize] & F_ROOT != 0 {
            if let Some(r) = self.roots.iter().find(|r| r.id == id) {
                return r.spec.path.to_string_lossy().into_owned();
            }
        }
        bytes_os(self.name_bytes(id)).to_string_lossy().into_owned()
    }
    pub fn meta(&self, id: EntryId) -> Meta {
        let i = id as usize;
        Meta { size: self.size[i], mtime: self.mtime[i], is_dir: self.flags[i] & F_DIR != 0, is_link: self.flags[i] & F_LINK != 0 }
    }
    pub fn kind(&self, id: EntryId) -> Kind {
        Kind::from_u8(self.kind[id as usize])
    }
    pub fn parent_of(&self, id: EntryId) -> EntryId {
        self.parent[id as usize]
    }

    /// The full path of an entry, rebuilt from its parents.
    pub fn path_of(&self, id: EntryId) -> PathBuf {
        let mut chain = Vec::new();
        let mut cur = id;
        while cur != NONE && self.flags[cur as usize] & F_ROOT == 0 {
            chain.push(cur);
            cur = self.parent[cur as usize];
        }
        let mut p = match self.roots.iter().find(|r| r.id == cur) {
            Some(r) => r.spec.path.clone(),
            None => PathBuf::new(),
        };
        for &c in chain.iter().rev() {
            p.push(bytes_os(self.name_bytes(c)));
        }
        p
    }

    fn put_bytes(&mut self, b: &[u8]) -> u32 {
        let off = self.arena.len();
        self.arena.extend_from_slice(b);
        off as u32
    }

    fn alloc(&mut self) -> usize {
        if let Some(id) = self.free.pop() {
            return id as usize;
        }
        self.name_off.push(0);
        self.name_len.push(0);
        self.fold_off.push(0);
        self.fold_len.push(0);
        self.grams.push(0);
        self.parent.push(NONE);
        self.first_child.push(NONE);
        self.next_sib.push(NONE);
        self.prev_sib.push(NONE);
        self.size.push(0);
        self.mtime.push(0);
        self.flags.push(0);
        self.kind.push(0);
        self.flags.len() - 1
    }

    /// Writes a name (and its folded form when it differs) into slot `i`.
    fn set_name(&mut self, i: usize, name: &[u8], folded: Option<&str>) {
        let computed;
        let f: &str = match folded {
            Some(f) => f,
            None => {
                computed = fold(&String::from_utf8_lossy(name));
                &computed
            }
        };
        self.grams[i] = grams(f.as_bytes());
        let off = self.put_bytes(name);
        self.name_off[i] = off;
        self.name_len[i] = name.len() as u16;
        if f.as_bytes() == name {
            self.fold_off[i] = off;
            self.fold_len[i] = name.len() as u16;
        } else {
            let fo = self.put_bytes(f.as_bytes());
            self.fold_off[i] = fo;
            self.fold_len[i] = f.len().min(u16::MAX as usize) as u16;
        }
    }

    fn name_garbage(&self, i: usize) -> usize {
        let n = self.name_len[i] as usize;
        if self.fold_off[i] == self.name_off[i] { n } else { n + self.fold_len[i] as usize }
    }

    /// Adds one entry under `parent` (NONE: a root node). Names longer than 65 535 bytes are refused (None).
    pub(crate) fn insert_raw(&mut self, parent: EntryId, name: &[u8], folded: Option<&str>, meta: Meta, extra: u8) -> Option<EntryId> {
        if name.len() > u16::MAX as usize || folded.map_or(false, |f| f.len() > u16::MAX as usize) {
            return None;
        }
        let i = self.alloc();
        self.set_name(i, name, folded);
        let mut fl = extra & (F_ROOT | F_UNREAD);
        if meta.is_dir {
            fl |= F_DIR;
        }
        if meta.is_link {
            fl |= F_LINK;
        }
        self.flags[i] = fl;
        self.size[i] = meta.size;
        self.mtime[i] = meta.mtime;
        self.kind[i] = if meta.is_dir { Kind::Folder as u8 } else { kind_of_ext(ext_of(self.folded(i as u32))) as u8 };
        self.parent[i] = parent;
        self.first_child[i] = NONE;
        self.prev_sib[i] = NONE;
        self.next_sib[i] = NONE;
        if parent != NONE {
            self.link(parent, i as u32);
        }
        self.live += 1;
        if meta.is_dir {
            self.dirs += 1;
        }
        self.gen += 1;
        Some(i as u32)
    }

    /// Adds `name` under `parent` (the walker's and the fixtures' entry point).
    pub fn insert(&mut self, parent: EntryId, name: &OsStr, meta: Meta) -> Option<EntryId> {
        self.insert_raw(parent, os_bytes(name), None, meta, 0)
    }

    fn link(&mut self, parent: EntryId, id: EntryId) {
        let (p, i) = (parent as usize, id as usize);
        self.parent[i] = parent;
        let first = self.first_child[p];
        self.next_sib[i] = first;
        self.prev_sib[i] = NONE;
        if first != NONE {
            self.prev_sib[first as usize] = id;
        }
        self.first_child[p] = id;
        if self.flags[p] & F_BIG != 0 {
            self.map_insert(parent, id);
        }
    }

    fn unlink(&mut self, id: EntryId) {
        let i = id as usize;
        let p = self.parent[i];
        if p == NONE {
            return;
        }
        let (prev, next) = (self.prev_sib[i], self.next_sib[i]);
        if prev != NONE {
            self.next_sib[prev as usize] = next;
        } else {
            self.first_child[p as usize] = next;
        }
        if next != NONE {
            self.prev_sib[next as usize] = prev;
        }
        if self.flags[p as usize] & F_BIG != 0 {
            self.map_remove(p, id);
        }
        self.prev_sib[i] = NONE;
        self.next_sib[i] = NONE;
        self.parent[i] = NONE;
    }

    pub(crate) fn children(&self, id: EntryId) -> ChildIter<'_> {
        ChildIter { ix: self, cur: self.first_child[id as usize] }
    }

    /// The child of `parent` called `name` (exactly, or the platform's way without case).
    pub fn find_child(&mut self, parent: EntryId, name: &[u8]) -> Option<EntryId> {
        if let Some(found) = self.find_in_map(parent, name) {
            return found;
        }
        let p = parent as usize;
        let mut n = 0usize;
        let mut cur = self.first_child[p];
        let mut loose = None;
        while cur != NONE {
            let nb = self.name_bytes(cur);
            if nb == name {
                loose = Some(cur);
                break;
            }
            if loose.is_none() && same_name(nb, name) {
                loose = Some(cur);
            }
            n += 1;
            cur = self.next_sib[cur as usize];
        }
        if n >= BIG_DIR && self.flags[p] & F_BIG == 0 {
            self.make_big(parent);
        }
        loose
    }

    /// The by-name map's answer for a big folder: Some(the answer) when the map settles it, None when a scan must.
    /// Every child is in the map under its key unless two children's keys collided (the folder is then marked and a
    /// miss is scanned), so a miss in an unmarked folder means «no such child».
    fn find_in_map(&self, parent: EntryId, name: &[u8]) -> Option<Option<EntryId>> {
        let fl = self.flags[parent as usize];
        if fl & F_BIG == 0 {
            return None;
        }
        match self.big.get(&(parent, name_key(name))) {
            Some(&id) => {
                let nb = self.name_bytes(id);
                if nb == name || same_name(nb, name) {
                    // An exact twin can exist beside a case twin only on a case-sensitive disk, where keys are exact.
                    return Some(Some(id));
                }
                None
            }
            None if fl & F_COLLIDED == 0 => Some(None),
            None => None,
        }
    }

    /// The read-only form of `find_child` (no promotion to the by-name map).
    pub(crate) fn find_child_ro(&self, parent: EntryId, name: &[u8]) -> Option<EntryId> {
        if let Some(found) = self.find_in_map(parent, name) {
            return found;
        }
        let mut loose = None;
        for c in self.children(parent) {
            let nb = self.name_bytes(c);
            if nb == name {
                return Some(c);
            }
            if loose.is_none() && same_name(nb, name) {
                loose = Some(c);
            }
        }
        loose
    }

    fn map_insert(&mut self, parent: EntryId, id: EntryId) {
        let k = (parent, name_key(self.name_bytes(id)));
        match self.big.get(&k) {
            None => {
                self.big.insert(k, id);
            }
            Some(&other) if other != id => self.flags[parent as usize] |= F_COLLIDED,
            Some(_) => {}
        }
    }

    fn map_remove(&mut self, parent: EntryId, id: EntryId) {
        let k = (parent, name_key(self.name_bytes(id)));
        if self.big.get(&k) == Some(&id) {
            self.big.remove(&k);
        }
    }

    fn make_big(&mut self, parent: EntryId) {
        self.flags[parent as usize] |= F_BIG;
        let kids: Vec<u32> = self.children(parent).collect();
        for c in kids {
            self.map_insert(parent, c);
        }
    }

    fn drop_big(&mut self, parent: EntryId) {
        if self.flags[parent as usize] & F_BIG != 0 {
            self.flags[parent as usize] &= !(F_BIG | F_COLLIDED);
            self.big.retain(|k, _| k.0 != parent);
        }
    }

    /// Removes an entry and everything under it.
    pub(crate) fn remove_subtree(&mut self, id: EntryId) {
        if !self.alive(id) {
            return;
        }
        self.unlink(id);
        let mut stack = vec![id];
        while let Some(x) = stack.pop() {
            let mut c = self.first_child[x as usize];
            while c != NONE {
                stack.push(c);
                c = self.next_sib[c as usize];
            }
            let i = x as usize;
            self.drop_big(x);
            self.garbage += self.name_garbage(i);
            if self.flags[i] & F_DIR != 0 {
                self.dirs -= 1;
            }
            self.flags[i] = F_DEAD;
            self.first_child[i] = NONE;
            self.next_sib[i] = NONE;
            self.prev_sib[i] = NONE;
            self.parent[i] = NONE;
            self.live -= 1;
            self.free.push(x);
        }
        self.gen += 1;
        self.maybe_compact();
    }

    /// Removes the children of a folder, keeping the folder.
    fn clear_children(&mut self, id: EntryId) {
        let kids: Vec<u32> = self.children(id).collect();
        for c in kids {
            self.remove_subtree(c);
        }
        self.drop_big(id);
    }

    /// Rewrites the arena without the names of removed or renamed entries once they are most of it (ids stay).
    fn maybe_compact(&mut self) {
        if self.garbage < (1 << 20) || self.garbage * 2 < self.arena.len() {
            return;
        }
        let mut fresh = Vec::with_capacity(self.arena.len() - self.garbage + 1024);
        for i in 0..self.slots() {
            if self.flags[i] & F_DEAD != 0 {
                continue;
            }
            let (no, nl) = (self.name_off[i] as usize, self.name_len[i] as usize);
            let shared = self.fold_off[i] == self.name_off[i];
            let off = fresh.len() as u32;
            fresh.extend_from_slice(&self.arena[no..no + nl]);
            if shared {
                self.fold_off[i] = off;
            } else {
                let (fo, fl) = (self.fold_off[i] as usize, self.fold_len[i] as usize);
                self.fold_off[i] = fresh.len() as u32;
                fresh.extend_from_slice(&self.arena[fo..fo + fl]);
            }
            self.name_off[i] = off;
        }
        self.arena = fresh;
        self.garbage = 0;
    }

    // ---- roots ----

    /// Registers a folder to index (not walked yet: `walk_subtree` + `install`). A folder inside a root already chosen,
    /// or one that holds one, is refused (Err with the root it collides with): the page offers to widen or narrow.
    pub fn add_root(&mut self, spec: RootSpec) -> Result<(), PathBuf> {
        for r in &self.roots {
            if under(&spec.path, &r.spec.path).is_some() || under(&r.spec.path, &spec.path).is_some() {
                return Err(r.spec.path.clone());
            }
        }
        let name = match spec.path.file_name() {
            Some(n) => os_bytes(n).to_vec(),
            None => os_bytes(spec.path.as_os_str()).to_vec(),
        };
        let meta = Meta { is_dir: true, ..Meta::default() };
        let id = match self.insert_raw(NONE, &name, None, meta, F_ROOT) {
            Some(id) => id,
            None => return Err(spec.path.clone()),
        };
        let excl_names_folded = spec.exclude_names.iter().map(|n| fold(n)).collect();
        self.roots.push(Root { spec, id, last_walk_ms: 0, unreadable: 0, walked: false, excl_names_folded });
        self.gen += 1;
        Ok(())
    }

    /// Forgets a root and everything indexed under it («remove»).
    pub fn remove_root(&mut self, path: &Path) -> bool {
        let Some(pos) = self.roots.iter().position(|r| under(path, &r.spec.path).map_or(false, |v| v.is_empty())) else {
            return false;
        };
        let r = self.roots.remove(pos);
        self.remove_subtree(r.id);
        self.gen += 1;
        true
    }

    /// The roots' specs, for «rebuild» (walk each again) and for the watchers.
    pub fn root_specs(&self) -> Vec<RootSpec> {
        self.roots.iter().map(|r| r.spec.clone()).collect()
    }

    pub fn roots(&self) -> Vec<RootStatus> {
        self.roots
            .iter()
            .map(|r| RootStatus {
                path: r.spec.path.clone(),
                entries: self.count_under(r.id),
                walked: r.walked,
                last_walk_ms: r.last_walk_ms,
                unreadable: r.unreadable,
            })
            .collect()
    }

    fn count_under(&self, id: EntryId) -> u64 {
        let mut n = 0u64;
        let mut stack = vec![id];
        while let Some(x) = stack.pop() {
            for c in self.children(x) {
                n += 1;
                stack.push(c);
            }
        }
        n
    }

    pub(crate) fn root_index_of<'a>(&self, path: &'a Path) -> Option<(usize, Vec<&'a OsStr>)> {
        let mut best: Option<(usize, Vec<&OsStr>)> = None;
        for (i, r) in self.roots.iter().enumerate() {
            if let Some(rest) = under(path, &r.spec.path) {
                if best.as_ref().map_or(true, |b| rest.len() < b.1.len()) {
                    best = Some((i, rest));
                }
            }
        }
        best
    }

    /// Whether a path is left out by its root's exclusions (or is not under any root).
    pub fn is_excluded(&self, path: &Path) -> bool {
        match self.root_index_of(path) {
            None => true,
            Some((ri, rest)) => excluded_in(&self.roots[ri], path, &rest),
        }
    }

    /// The entry at `path`, if indexed.
    pub fn find(&mut self, path: &Path) -> Option<EntryId> {
        let (ri, rest) = self.root_index_of(path)?;
        let rest: Vec<Vec<u8>> = rest.iter().map(|s| os_bytes(s).to_vec()).collect();
        let mut cur = self.roots[ri].id;
        for c in &rest {
            cur = self.find_child(cur, c)?;
        }
        Some(cur)
    }

    /// The entry at `path` without touching the lookup maps (for readers holding a shared lock).
    pub fn lookup(&self, path: &Path) -> Option<EntryId> {
        let (ri, rest) = self.root_index_of(path)?;
        let mut cur = self.roots[ri].id;
        for c in rest {
            cur = self.find_child_ro(cur, os_bytes(c))?;
        }
        Some(cur)
    }

    pub fn stats(&self) -> IndexStats {
        let u32s = [&self.name_off, &self.fold_off, &self.parent, &self.first_child, &self.next_sib, &self.prev_sib];
        let cols: usize = u32s.iter().map(|v| v.capacity() * 4).sum::<usize>()
            + (self.name_len.capacity() + self.fold_len.capacity()) * 2
            + self.size.capacity() * 8
            + self.grams.capacity() * 8
            + self.mtime.capacity() * 8
            + self.flags.capacity()
            + self.kind.capacity()
            + self.free.capacity() * 4;
        // A hash map slot: the key (12 bytes, padded to 16), the value, a control byte.
        let big = self.big.capacity() * (16 + 4 + 1);
        let rank = self.path_rank.lock().map(|g| g.as_ref().map_or(0, |r| r.1.capacity() * 4)).unwrap_or(0);
        let roots = self.roots.len();
        IndexStats {
            entries: (self.live - roots) as u64,
            folders: (self.dirs - roots) as u64,
            files: (self.live - self.dirs) as u64,
            memory_bytes: (cols + self.arena.capacity() + big + rank) as u64,
            roots: roots as u32,
        }
    }

    // ---- installing a walk ----

    /// Puts a walked tree in place: a whole root (its old entries go), or one folder under a root (`rescan`: the
    /// folder's old contents go, the walked ones come in). False when the walked folder no longer belongs to the
    /// index (its root was removed, or its parent folder is not indexed: walk higher).
    pub fn install(&mut self, w: Walked) -> bool {
        if w.cancelled {
            return false;
        }
        let Some((ri, rest)) = self.root_index_of(&w.path) else { return false };
        let rest: Vec<Vec<u8>> = rest.iter().map(|s| os_bytes(s).to_vec()).collect();
        let target = if rest.is_empty() {
            let r = &mut self.roots[ri];
            r.walked = true;
            r.last_walk_ms = w.finished_ms;
            r.unreadable = w.unreadable;
            let id = r.id;
            self.clear_children(id);
            id
        } else {
            let mut cur = self.roots[ri].id;
            for c in &rest[..rest.len() - 1] {
                match self.find_child(cur, c) {
                    Some(x) => cur = x,
                    None => return false,
                }
            }
            let last = &rest[rest.len() - 1];
            if let Some(old) = self.find_child(cur, last) {
                self.remove_subtree(old);
            }
            if w.tree.slots() == 0 {
                return true; // the folder is gone
            }
            let root_meta = w.tree.meta(0);
            match self.insert_raw(cur, last, None, root_meta, w.tree.flags[0] & F_UNREAD) {
                Some(x) => x,
                None => return false,
            }
        };
        if w.tree.slots() == 0 {
            return true;
        }
        let src = &w.tree;
        self.reserve(src.live, src.arena.len());
        let mut stack: Vec<(u32, u32)> = src.children(0).map(|c| (c, target)).collect();
        while let Some((s, dparent)) = stack.pop() {
            let si = s as usize;
            let meta = src.meta(s);
            let Some(d) = self.insert_raw(dparent, src.name_bytes(s), Some(src.folded(s)), meta, src.flags[si] & F_UNREAD) else {
                continue;
            };
            for c in src.children(s) {
                stack.push((c, d));
            }
        }
        self.gen += 1;
        true
    }

    // ---- changes ----

    /// Applies one change from a watcher. Idempotent: a change already in the index is Ignored, so the events that
    /// came in while a walk ran can be applied after `install`.
    pub fn apply(&mut self, ch: &Change) -> Applied {
        match ch {
            Change::Overflow { dir } => Applied::Rescan(vec![dir.clone()]),
            Change::Listed { dir, items } => {
                if self.lookup(dir).is_none() {
                    return Applied::Ignored;
                }
                let new = self.sync_dir(dir, items);
                if new.is_empty() { Applied::Done } else { Applied::Rescan(new) }
            }
            Change::Removed { path } => match self.find(path) {
                Some(id) if self.flags[id as usize] & F_ROOT != 0 => {
                    self.clear_children(id);
                    self.gen += 1;
                    Applied::Done
                }
                Some(id) => {
                    self.remove_subtree(id);
                    Applied::Done
                }
                None => Applied::Ignored,
            },
            Change::Created { path, meta } | Change::Modified { path, meta } => self.upsert(path, *meta),
            Change::Moved { from, to, meta } => self.moved(from, to, *meta),
        }
    }

    fn upsert(&mut self, path: &Path, meta: Meta) -> Applied {
        let Some((ri, rest)) = self.root_index_of(path) else { return Applied::Ignored };
        if rest.is_empty() {
            return Applied::Ignored; // the root itself (its mtime is not shown)
        }
        if excluded_in(&self.roots[ri], path, &rest) {
            return Applied::Ignored;
        }
        let parent_path = path.parent().unwrap_or(path);
        let Some(parent) = self.find(parent_path) else {
            return Applied::Rescan(vec![self.nearest_indexed(parent_path)]);
        };
        let name = os_bytes(path.file_name().unwrap_or_default()).to_vec();
        if let Some(id) = self.find_child(parent, &name) {
            let old = self.meta(id);
            if old.is_dir == meta.is_dir && old.is_link == meta.is_link {
                if self.name_bytes(id) != name.as_slice() {
                    // The same entry with another case (Windows): take the new spelling.
                    self.rename_slot(id, &name);
                } else if old == meta {
                    return Applied::Ignored;
                }
                let i = id as usize;
                self.size[i] = meta.size;
                self.mtime[i] = meta.mtime;
                self.gen += 1;
                return Applied::Done;
            }
            self.remove_subtree(id); // a file became a folder or the reverse
        }
        if self.insert_raw(parent, &name, None, meta, 0).is_none() {
            return Applied::Ignored;
        }
        if meta.is_dir && !meta.is_link {
            return Applied::Rescan(vec![path.to_path_buf()]);
        }
        Applied::Done
    }

    fn nearest_indexed(&mut self, p: &Path) -> PathBuf {
        let mut cur = p.to_path_buf();
        loop {
            if self.find(&cur).is_some() {
                return cur;
            }
            match cur.parent() {
                Some(q) if !q.as_os_str().is_empty() => cur = q.to_path_buf(),
                _ => return p.to_path_buf(),
            }
        }
    }

    fn rename_slot(&mut self, id: EntryId, name: &[u8]) {
        let i = id as usize;
        let p = self.parent[i];
        let big = p != NONE && self.flags[p as usize] & F_BIG != 0;
        if big {
            self.map_remove(p, id);
        }
        self.garbage += self.name_garbage(i);
        self.set_name(i, name, None);
        if self.flags[i] & F_DIR == 0 {
            self.kind[i] = kind_of_ext(ext_of(self.folded(id))) as u8;
        }
        if big {
            self.map_insert(p, id);
        }
        self.gen += 1;
        self.maybe_compact();
    }

    fn moved(&mut self, from: &Path, to: &Path, meta: Option<Meta>) -> Applied {
        let src = self.find(from);
        let src = match src {
            Some(id) if self.flags[id as usize] & F_ROOT != 0 => {
                // The chosen folder itself was renamed or moved away: its contents are unknown now.
                self.clear_children(id);
                return Applied::Rescan(vec![from.to_path_buf()]);
            }
            s => s,
        };
        let dest_ok = match self.root_index_of(to) {
            Some((ri, rest)) => !rest.is_empty() && !excluded_in(&self.roots[ri], to, &rest),
            None => false,
        };
        let Some(id) = src else {
            // Moved in from outside the index: a creation.
            return match (dest_ok, meta) {
                (false, _) => Applied::Ignored,
                (true, Some(m)) => self.upsert(to, m),
                (true, None) => Applied::Rescan(vec![to.parent().unwrap_or(to).to_path_buf()]),
            };
        };
        if !dest_ok {
            self.remove_subtree(id); // moved out of the index, or into an excluded folder
            return Applied::Done;
        }
        let parent_path = to.parent().unwrap_or(to);
        let Some(new_parent) = self.find(parent_path) else {
            self.remove_subtree(id);
            return Applied::Rescan(vec![self.nearest_indexed(parent_path)]);
        };
        // A folder moved into itself is impossible on a real disk; refuse it rather than make a cycle.
        let mut a = new_parent;
        while a != NONE {
            if a == id {
                return Applied::Rescan(vec![parent_path.to_path_buf()]);
            }
            a = self.parent[a as usize];
        }
        let name = os_bytes(to.file_name().unwrap_or_default()).to_vec();
        if let Some(existing) = self.find_child(new_parent, &name) {
            if existing != id {
                self.remove_subtree(existing); // the rename replaced a file
            }
        }
        self.unlink(id);
        if self.name_bytes(id) != name.as_slice() {
            // Unlinked, so rename_slot does not touch a by-name map.
            self.rename_slot(id, &name);
        }
        self.link(new_parent, id);
        if let Some(m) = meta {
            if m.is_dir == self.meta(id).is_dir {
                self.size[id as usize] = m.size;
                self.mtime[id as usize] = m.mtime;
            }
        }
        self.gen += 1;
        Applied::Done
    }

    /// A folder's listing compared with the index (macOS's fall-back and the quick refresh): entries gone are
    /// removed, changed ones updated, new ones added. Returns the new folders, to be walked (`walk_subtree`).
    pub fn sync_dir(&mut self, dir: &Path, listing: &[(OsString, Meta)]) -> Vec<PathBuf> {
        let Some(id) = self.find(dir) else { return Vec::new() };
        let ri = match self.root_index_of(dir) {
            Some((ri, _)) => ri,
            None => return Vec::new(),
        };
        let mut seen: HashMap<Vec<u8>, ()> = HashMap::with_capacity(listing.len());
        let mut new_dirs = Vec::new();
        for (name, meta) in listing {
            let nb = os_bytes(name).to_vec();
            let child_path = dir.join(name);
            if meta.is_dir && !meta.is_link {
                let rest = under(&child_path, &self.roots[ri].spec.path).unwrap_or_default();
                if excluded_in(&self.roots[ri], &child_path, &rest) {
                    continue;
                }
            }
            seen.insert(nb.clone(), ());
            match self.find_child(id, &nb) {
                Some(c) if self.meta(c).is_dir == meta.is_dir && self.meta(c).is_link == meta.is_link => {
                    let i = c as usize;
                    if self.size[i] != meta.size || self.mtime[i] != meta.mtime {
                        self.size[i] = meta.size;
                        self.mtime[i] = meta.mtime;
                        self.gen += 1;
                    }
                }
                other => {
                    if let Some(c) = other {
                        self.remove_subtree(c);
                    }
                    self.insert_raw(id, &nb, None, *meta, 0);
                    if meta.is_dir && !meta.is_link {
                        new_dirs.push(child_path);
                    }
                }
            }
        }
        let gone: Vec<u32> = self.children(id).filter(|&c| !seen.contains_key(self.name_bytes(c))).collect();
        for c in gone {
            self.remove_subtree(c);
        }
        new_dirs
    }

    /// The indexed folders under a root (for a watcher that needs one watch per folder, and the mtime poller).
    pub fn folders_under(&self, root: &Path) -> Vec<(PathBuf, i64)> {
        let Some(id) = self.lookup(root) else { return Vec::new() };
        let mut out = vec![(self.path_of(id), self.mtime[id as usize])];
        let mut stack = vec![id];
        while let Some(x) = stack.pop() {
            for c in self.children(x) {
                if self.flags[c as usize] & (F_DIR | F_LINK) == F_DIR {
                    out.push((self.path_of(c), self.mtime[c as usize]));
                    stack.push(c);
                }
            }
        }
        out
    }

    /// Records a folder's own mtime (the mtime poller compares against it).
    pub fn set_mtime(&mut self, path: &Path, mtime: i64) {
        if let Some(id) = self.find(path) {
            self.mtime[id as usize] = mtime;
        }
    }

    pub(crate) fn root_spec_for(&self, path: &Path) -> Option<RootSpec> {
        self.root_index_of(path).map(|(ri, _)| self.roots[ri].spec.clone())
    }
}

pub(crate) fn excluded_in(r: &Root, path: &Path, rest: &[&OsStr]) -> bool {
    for e in &r.spec.exclude {
        if under(path, e).is_some() {
            return true;
        }
    }
    if !r.excl_names_folded.is_empty() {
        for c in rest {
            let f = fold(&c.to_string_lossy());
            if r.excl_names_folded.iter().any(|n| *n == f) {
                return true;
            }
        }
    }
    false
}

pub(crate) struct ChildIter<'a> {
    ix: &'a Index,
    cur: u32,
}
impl Iterator for ChildIter<'_> {
    type Item = u32;
    fn next(&mut self) -> Option<u32> {
        if self.cur == NONE {
            return None;
        }
        let c = self.cur;
        self.cur = self.ix.next_sib[c as usize];
        Some(c)
    }
}

/// A walked folder: a small index of its own (entry 0 is the folder), installed with `Index::install`.
pub struct Walked {
    pub path: PathBuf,
    pub tree: Index,
    pub entries: u64,
    pub unreadable: u64,
    /// Names refused (longer than the index keeps).
    pub skipped: u64,
    pub cancelled: bool,
    pub finished_ms: i64,
}

impl Walked {
    /// An empty tree for `path` whose top entry has `meta` (the walker fills it).
    pub fn start(path: &Path, meta: Meta) -> Walked {
        let mut tree = Index::new();
        let name = match path.file_name() {
            Some(n) => os_bytes(n).to_vec(),
            None => os_bytes(path.as_os_str()).to_vec(),
        };
        tree.insert_raw(NONE, &name, None, Meta { is_dir: true, ..meta }, F_ROOT);
        Walked { path: path.to_path_buf(), tree, entries: 0, unreadable: 0, skipped: 0, cancelled: false, finished_ms: 0 }
    }
    /// The walked folder vanished: installing it removes the entry.
    pub fn gone(path: &Path) -> Walked {
        Walked { path: path.to_path_buf(), tree: Index::new(), entries: 0, unreadable: 0, skipped: 0, cancelled: false, finished_ms: 0 }
    }
}
