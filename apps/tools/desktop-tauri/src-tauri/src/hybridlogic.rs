// The hybrid torrent engine's rules (stage P4, «far seeks»): which engine serves a torrent the player opens, who may
// write a torrent's files at a given moment, when librqbit is given up on, where librqbit must write so that it uses
// aria2's own files. stream_hybrid.rs does the work; this file decides. Std only, checked alone with
// `rustc --edition 2021 --test hybridlogic.rs`.
//
// Two engines on one computer: aria2 (every download; the proven one) and librqbit (only while a torrent is watched,
// because it fetches the pieces under the player's position first — aria2 fetches in order). They share the download's
// folder, so a torrent fetched partly by one is continued by the other; they must never write it at once.
// (Some rules are used only by the build with librqbit, or by the self-test's report.)
#![allow(dead_code)]
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// The engine that serves a file being watched.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Back {
    Aria2,
    Rqbit,
}

impl Back {
    pub fn name(self) -> &'static str {
        match self {
            Back::Aria2 => "aria2",
            Back::Rqbit => "rqbit",
        }
    }
}

/// Why a download is asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    /// The player opens one of its files (kt:streamUrl).
    Stream,
    /// Any other download (kt:add and the rest): always aria2.
    Download,
}

/// What is known when a file is opened.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Facts {
    pub purpose: Purpose,
    /// librqbit compiled in (`--features rqbit`).
    pub built: bool,
    /// Its session started here (None from the engine otherwise).
    pub session_up: bool,
    /// A torrent (an info-hash is known) — a plain link is never librqbit's.
    pub is_torrent: bool,
    /// aria2 already has the whole file: served from the disk, nothing to fetch (main.cjs's watchUrl).
    pub file_complete: bool,
    /// librqbit already failed on this torrent in this run: not tried again (no second wait).
    pub failed_before: bool,
    /// librqbit already holds this torrent (another of its files is being watched).
    pub held: bool,
}

/// The choice: librqbit only for a torrent opened in the player, built in, its session up, the file not already whole,
/// librqbit not failed on it before. Everything else — and every failure later — is aria2's, exactly as before. A torrent
/// librqbit holds already (another of its files is watched) stays librqbit's for every file, a whole one too: aria2 is
/// paused then, and librqbit has checked the whole file at its add.
pub fn choose(f: &Facts) -> Back {
    if f.purpose != Purpose::Stream || !f.built || !f.session_up || !f.is_torrent {
        return Back::Aria2;
    }
    if f.held {
        return Back::Rqbit;
    }
    if f.file_complete || f.failed_before {
        return Back::Aria2;
    }
    Back::Rqbit
}

/// Who may write a torrent's files now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    /// aria2 (the default: nothing recorded).
    Aria2,
    /// librqbit asked for it; aria2 is being paused — nobody else may start.
    Pausing,
    /// librqbit writes; aria2 stays paused (a resume from the page is only remembered).
    Rqbit,
    /// librqbit is letting it go; aria2 may not run until it has.
    Releasing,
}

impl Owner {
    pub fn name(self) -> &'static str {
        match self {
            Owner::Aria2 => "aria2",
            Owner::Pausing => "pausing",
            Owner::Rqbit => "rqbit",
            Owner::Releasing => "releasing",
        }
    }
}

/// aria2 is not writing (and will not start by itself): any status but active / waiting.
pub fn quiet(status: &str) -> bool {
    !matches!(status, "active" | "waiting")
}

#[derive(Clone, Debug)]
struct Hold {
    owner: Owner,
    gid: String,
    /// The page's pause / resume while librqbit held it: true resume, false pause (the last one counts).
    wish: Option<bool>,
}

/// One owner per info-hash (lower case). Every change goes through these steps; any other is refused.
#[derive(Debug, Default)]
pub struct Owners {
    m: HashMap<String, Hold>,
}

impl Owners {
    pub fn new() -> Owners {
        Owners { m: HashMap::new() }
    }

    pub fn owner(&self, hash: &str) -> Owner {
        self.m.get(&hash.to_ascii_lowercase()).map(|h| h.owner).unwrap_or(Owner::Aria2)
    }

    /// The owner of aria2's download `gid` (aria2's when no torrent of it is recorded).
    pub fn owner_of_gid(&self, gid: &str) -> Owner {
        self.m.values().find(|h| h.gid == gid).map(|h| h.owner).unwrap_or(Owner::Aria2)
    }

    /// librqbit wants the torrent: only while aria2 owns it, and only one taker at once.
    pub fn begin_take(&mut self, hash: &str, gid: &str) -> Result<(), String> {
        let k = hash.to_ascii_lowercase();
        if k.is_empty() || gid.is_empty() {
            return Err("not a torrent".into());
        }
        if self.m.values().any(|h| h.gid == gid) {
            return Err(format!("held: {}", self.owner_of_gid(gid).name()));
        }
        match self.m.get(&k) {
            None => {
                self.m.insert(k, Hold { owner: Owner::Pausing, gid: gid.to_string(), wish: None });
                Ok(())
            }
            Some(h) => Err(format!("held: {}", h.owner.name())),
        }
    }

    /// aria2's status after the pause: librqbit owns the torrent only when aria2 is quiet; otherwise the take is
    /// abandoned (aria2 keeps it, librqbit never adds it) → Err.
    pub fn confirm_take(&mut self, hash: &str, aria2_status: &str) -> Result<(), String> {
        let k = hash.to_ascii_lowercase();
        match self.m.get_mut(&k) {
            Some(h) if h.owner == Owner::Pausing => {
                if quiet(aria2_status) {
                    h.owner = Owner::Rqbit;
                    Ok(())
                } else {
                    self.m.remove(&k);
                    Err(format!("aria2 still {}", aria2_status))
                }
            }
            Some(h) => Err(format!("not taking: {}", h.owner.name())),
            None => Err("not taking".into()),
        }
    }

    /// librqbit lets go (the player closed, or librqbit failed): from Pausing or Rqbit → Releasing.
    pub fn begin_release(&mut self, hash: &str) -> bool {
        match self.m.get_mut(&hash.to_ascii_lowercase()) {
            Some(h) if h.owner == Owner::Pausing || h.owner == Owner::Rqbit => {
                h.owner = Owner::Releasing;
                true
            }
            _ => false,
        }
    }

    /// librqbit has let go (its torrent deleted from its session, files kept): aria2's again → the page's last wish.
    pub fn released(&mut self, hash: &str) -> Option<Option<bool>> {
        let k = hash.to_ascii_lowercase();
        match self.m.get(&k) {
            Some(h) if h.owner == Owner::Releasing => self.m.remove(&k).map(|h| h.wish),
            _ => None,
        }
    }

    /// The page pauses (false) or resumes (true) download `gid`: while librqbit holds it nothing is sent to aria2,
    /// the wish is kept for the hand-back → whether it was held.
    pub fn wish(&mut self, gid: &str, run: bool) -> bool {
        match self.m.values_mut().find(|h| h.gid == gid) {
            Some(h) => {
                h.wish = Some(run);
                true
            }
            None => false,
        }
    }

    /// aria2 may run download `gid` (unpause, resume, its own scheduling).
    pub fn may_aria2_run(&self, gid: &str) -> bool {
        self.owner_of_gid(gid) == Owner::Aria2
    }

    /// librqbit may add / write the torrent.
    pub fn may_rqbit_write(&self, hash: &str) -> bool {
        self.owner(hash) == Owner::Rqbit
    }

    /// Every torrent librqbit holds or is taking or letting go (for the hand-back at quit).
    pub fn held(&self) -> Vec<(String, String)> {
        let mut v: Vec<(String, String)> = self.m.iter().map(|(k, h)| (k.clone(), h.gid.clone())).collect();
        v.sort();
        v
    }
}

/// aria2 goes on after the hand-back when: the player still needs bytes (librqbit failed mid-stream), else the page's
/// last pause / resume while librqbit held it, else as it was before (Electron's handBack: unless it was paused).
pub fn unpause_after(was_paused: bool, wish: Option<bool>, still_watching: bool) -> bool {
    if still_watching {
        return true;
    }
    match wish {
        Some(run) => run,
        None => !was_paused,
    }
}

/// Given up on librqbit while a read waits: no peer and no new byte for `limit_ms` (the 90 s it already waits for a
/// magnet's metadata). Fed the time (ms), its verified bytes and its live peers at each look.
#[derive(Clone, Debug)]
pub struct Stall {
    since: u64,
    last: u64,
    limit: u64,
}

pub const STALL_MS: u64 = 90_000;

impl Stall {
    pub fn new(now_ms: u64, have: u64, limit_ms: u64) -> Stall {
        Stall { since: now_ms, last: have, limit: limit_ms }
    }

    /// true: give up (fall back to aria2).
    pub fn observe(&mut self, now_ms: u64, have: u64, peers: u64) -> bool {
        if have > self.last || peers > 0 {
            self.since = now_ms;
            self.last = self.last.max(have);
            return false;
        }
        now_ms.saturating_sub(self.since) >= self.limit
    }
}

/// The folder librqbit is pointed at so its files ARE aria2's: aria2 puts a multi-file torrent's files under
/// «<dir>/<torrent name>/…» and a single file at «<dir>/<name>»; librqbit writes a file's in-torrent path (without the
/// torrent's name) under the folder it is given.
pub fn rqbit_folder(dir: &str, multi: bool, name: &str) -> String {
    let clean = name.trim();
    if multi && !clean.is_empty() && clean != "." && clean != ".." && !clean.contains('/') && !clean.contains('\\') {
        Path::new(dir).join(clean).to_string_lossy().into_owned()
    } else {
        dir.to_string()
    }
}

/// Whether piece `i` is set in aria2's hex bitfield (high bit first).
pub fn has_piece(bitfield: &str, i: u64) -> bool {
    let c = match bitfield.as_bytes().get((i / 4) as usize) {
        Some(c) => *c as char,
        None => return false,
    };
    match c.to_digit(16) {
        Some(n) => n & (8 >> (i % 4)) != 0,
        None => false,
    }
}

/// For the self-test's far seek: bytes [from, to] of a file (at `file_off` in the torrent, `file_len` long) near its end
/// whose `want` pieces aria2 did NOT have when librqbit took over — so they can only come from librqbit's fetch. Looked
/// for in the last quarter, from the end backwards. None when there is no such run.
pub fn far_missing(bitfield: &str, piece_len: u64, file_off: u64, file_len: u64, want: u64) -> Option<(u64, u64)> {
    if piece_len == 0 || file_len == 0 || want == 0 {
        return None;
    }
    let first = file_off / piece_len;
    let last = (file_off + file_len - 1) / piece_len;
    let floor = ((file_off + file_len - file_len / 4) / piece_len).max(first);
    if last + 1 < want || last + 1 - want < floor {
        return None;
    }
    // (From the end backwards: the first run of `want` pieces aria2 had none of; the bytes asked are this file's part
    // of them.)
    let mut s = last + 1 - want;
    loop {
        if (s..s + want).all(|i| !has_piece(bitfield, i)) {
            let from = (s * piece_len).max(file_off) - file_off;
            let to = ((s + want) * piece_len).min(file_off + file_len) - 1 - file_off;
            return Some((from, to));
        }
        if s == floor {
            return None;
        }
        s -= 1;
    }
}

/// Indices of files librqbit is asked to fetch: those already asked plus the new one, sorted.
pub fn wanted(prev: &HashSet<usize>, index: usize) -> Vec<usize> {
    let mut v: Vec<usize> = prev.iter().copied().collect();
    if !v.contains(&index) {
        v.push(index);
    }
    v.sort_unstable();
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> Facts {
        Facts { purpose: Purpose::Stream, built: true, session_up: true, is_torrent: true, file_complete: false, failed_before: false, held: false }
    }

    #[test]
    fn stream_uses_rqbit_only_when_everything_allows() {
        assert_eq!(choose(&facts()), Back::Rqbit);
        assert_eq!(choose(&Facts { purpose: Purpose::Download, ..facts() }), Back::Aria2);
        assert_eq!(choose(&Facts { built: false, ..facts() }), Back::Aria2);
        assert_eq!(choose(&Facts { session_up: false, ..facts() }), Back::Aria2);
        assert_eq!(choose(&Facts { is_torrent: false, ..facts() }), Back::Aria2);
        assert_eq!(choose(&Facts { file_complete: true, ..facts() }), Back::Aria2);
        assert_eq!(choose(&Facts { failed_before: true, ..facts() }), Back::Aria2);
        // (Held already: its other files go on with it — even after an earlier failure of another attempt.)
        assert_eq!(choose(&Facts { held: true, failed_before: true, ..facts() }), Back::Rqbit);
        // (A file already whole, while librqbit holds the torrent: librqbit's too — aria2 is paused, never asked to read.)
        assert_eq!(choose(&Facts { held: true, file_complete: true, ..facts() }), Back::Rqbit);
        // (A plain build: never librqbit, whatever else is true.)
        assert_eq!(choose(&Facts { built: false, held: true, ..facts() }), Back::Aria2);
    }

    #[test]
    fn one_owner_per_hash() {
        let mut o = Owners::new();
        assert_eq!(o.owner("ABC"), Owner::Aria2);
        assert!(o.may_aria2_run("g1"));
        o.begin_take("ABC", "g1").unwrap();
        // (Taking: neither may write — aria2 may not be resumed, librqbit may not add yet.)
        assert_eq!(o.owner("abc"), Owner::Pausing);
        assert!(!o.may_aria2_run("g1"));
        assert!(!o.may_rqbit_write("abc"));
        // (A second taker, by hash or by gid, is refused.)
        assert!(o.begin_take("abc", "g1").is_err());
        assert!(o.begin_take("abc", "g2").is_err());
        assert!(o.begin_take("def", "g1").is_err());
        o.confirm_take("abc", "paused").unwrap();
        assert!(o.may_rqbit_write("ABC"));
        assert!(!o.may_aria2_run("g1"));
        assert!(o.may_aria2_run("g2"));
        // (Never both: at every step at most one of the two may write.)
        assert!(!(o.may_rqbit_write("abc") && o.may_aria2_run("g1")));
        assert!(o.begin_release("abc"));
        assert!(!o.may_rqbit_write("abc"));
        assert!(!o.may_aria2_run("g1"));
        assert!(!o.begin_release("abc"));
        assert_eq!(o.released("abc"), Some(None));
        assert!(o.may_aria2_run("g1"));
        assert_eq!(o.owner("abc"), Owner::Aria2);
        assert_eq!(o.released("abc"), None);
        assert!(o.held().is_empty());
    }

    #[test]
    fn a_take_is_abandoned_when_aria2_does_not_stop() {
        let mut o = Owners::new();
        o.begin_take("h", "g").unwrap();
        assert!(o.confirm_take("h", "active").is_err());
        assert_eq!(o.owner("h"), Owner::Aria2);
        assert!(o.may_aria2_run("g"));
        o.begin_take("h", "g").unwrap();
        assert!(o.confirm_take("h", "waiting").is_err());
        o.begin_take("h", "g").unwrap();
        o.confirm_take("h", "complete").unwrap();
        assert_eq!(o.owner("h"), Owner::Rqbit);
        // (Confirming twice, or what was never taken, is refused.)
        assert!(o.confirm_take("h", "paused").is_err());
        assert!(o.confirm_take("x", "paused").is_err());
        // (A take that failed after the pause is let go from Pausing too.)
        let mut p = Owners::new();
        p.begin_take("q", "g9").unwrap();
        assert!(p.begin_release("q"));
        assert_eq!(p.released("q"), Some(None));
        assert!(p.begin_take("", "g").is_err());
        assert!(p.begin_take("q", "").is_err());
    }

    #[test]
    fn the_pages_wish_is_kept_for_the_hand_back() {
        let mut o = Owners::new();
        assert!(!o.wish("g", true));
        o.begin_take("h", "g").unwrap();
        o.confirm_take("h", "paused").unwrap();
        assert!(o.wish("g", false));
        assert!(o.wish("g", true));
        assert!(!o.may_aria2_run("g"));
        o.begin_release("h");
        assert_eq!(o.held(), vec![("h".to_string(), "g".to_string())]);
        assert_eq!(o.released("h"), Some(Some(true)));
        assert!(unpause_after(true, Some(true), false));
        assert!(!unpause_after(false, Some(false), false));
        assert!(unpause_after(false, None, false));
        assert!(!unpause_after(true, None, false));
        assert!(unpause_after(true, Some(false), true));
    }

    #[test]
    fn stall_gives_up_only_without_peers_or_bytes() {
        let mut s = Stall::new(0, 100, 90_000);
        assert!(!s.observe(10_000, 100, 0));
        assert!(!s.observe(89_999, 100, 0));
        assert!(s.observe(90_000, 100, 0));
        // (A byte or a peer starts the wait again.)
        let mut t = Stall::new(0, 0, 90_000);
        assert!(!t.observe(80_000, 1, 0));
        assert!(!t.observe(169_999, 1, 0));
        assert!(!t.observe(170_000, 1, 2));
        assert!(!t.observe(259_999, 1, 0));
        assert!(t.observe(260_000, 1, 0));
        // (Fewer bytes than before — a recheck — is not progress.)
        let mut u = Stall::new(0, 50, 1000);
        assert!(u.observe(1000, 40, 0));
    }

    #[test]
    fn rqbit_writes_into_aria2s_folder() {
        let multi = rqbit_folder("/d/x", true, "Show S01");
        assert_eq!(multi, Path::new("/d/x").join("Show S01").to_string_lossy());
        assert_eq!(rqbit_folder("/d/x", false, "a.mkv"), "/d/x");
        assert_eq!(rqbit_folder("/d/x", true, ""), "/d/x");
        assert_eq!(rqbit_folder("/d/x", true, ".."), "/d/x");
        assert_eq!(rqbit_folder("/d/x", true, "a/b"), "/d/x");
    }

    #[test]
    fn bitfield_and_far_missing() {
        // (8 pieces: «f0» = pieces 0..3 in, 4..7 missing.)
        assert!(has_piece("f0", 0) && has_piece("f0", 3));
        assert!(!has_piece("f0", 4) && !has_piece("f0", 7) && !has_piece("f0", 8));
        assert!(!has_piece("zz", 0));
        // (One file of 8 pieces of 10 bytes: the last two.)
        assert_eq!(far_missing("f0", 10, 0, 80, 2), Some((60, 79)));
        // (All in: none.)
        assert_eq!(far_missing("ff", 10, 0, 80, 2), None);
        // (The end present: looks further back, within the last quarter only.)
        assert_eq!(far_missing("fd", 10, 0, 80, 1), Some((60, 69)));
        assert_eq!(far_missing("fe", 10, 0, 80, 1), Some((70, 79)));
        assert_eq!(far_missing("fc", 10, 0, 80, 3), None);
        assert_eq!(far_missing("7f", 10, 0, 80, 1), None);
        // (A file starting inside a piece: offsets are the file's own.)
        assert_eq!(far_missing("ff00", 10, 75, 85, 2), Some((65, 84)));
        assert_eq!(far_missing("", 0, 0, 10, 1), None);
        assert_eq!(far_missing("", 10, 0, 0, 1), None);
        assert_eq!(far_missing("", 10, 0, 10, 2), None);
        // (A long file: the run is in the last quarter, never earlier.)
        let bf = "0".repeat(64);
        assert_eq!(far_missing(&bf, 32, 0, 256 * 32, 2), Some((254 * 32, 256 * 32 - 1)));
        // (Everything but the last eighth in: found right below it; the last quarter has none missing → None.)
        let mut most = "f".repeat(56);
        most.push_str(&"0".repeat(8));
        assert_eq!(far_missing(&most, 32, 0, 256 * 32, 2), Some((254 * 32, 256 * 32 - 1)));
        let full = "f".repeat(64);
        assert_eq!(far_missing(&full, 32, 0, 256 * 32, 2), None);
    }

    #[test]
    fn wanted_files_are_a_union() {
        let mut s = HashSet::new();
        assert_eq!(wanted(&s, 3), vec![3]);
        s.insert(3);
        s.insert(0);
        assert_eq!(wanted(&s, 1), vec![0, 1, 3]);
        assert_eq!(wanted(&s, 3), vec![0, 3]);
    }
}
