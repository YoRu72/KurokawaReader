//! Who may run the downloads two Kurokawa Tools programs share (stage P9, after the hand-over): the Electron build
//! handed its aria2 session and video jobs to the Rust build, but both sessions name the SAME partial files and aria2
//! control files in the person's download folders. An old Electron copy kept beside the new app (a portable .exe, a
//! Mac's, one kept side by side) and the new app must never continue one of those downloads at the same time.
//!
//! The rule: one owner file, `downloads-owner.json`, next to the session that was handed over (the Electron build's
//! data folder — the one place both programs know), naming the program that runs the handed-over downloads now:
//! `{ app, kind, format, owner: "tauri"|"electron", pid, startedAt, heartbeat, released, handover, ids }`, written
//! atomically (a temp file in the same folder, then a rename). The owner renews `heartbeat` every HEARTBEAT_MS while
//! its engine runs and marks `released` when it quits. The other program keeps those downloads (`ids`) paused while a
//! live owner holds them, and says so with «Take them back» (asked first). A record is stale — and may be taken
//! without asking — when its heartbeat is older than STALE_MS and its program is gone (or its heartbeat is older than
//! PID_REUSE_MS, when a pid that looks alive may be another program's by now). A heartbeat far in the future (the
//! clock moved back) proves nothing: only the pid then decides. Taking = writing one's own record, waiting SETTLE_MS,
//! reading it back: only a record that still names the taker counts (two takers at once: the last rename wins, the
//! other sees it and yields). Each heartbeat reads first: a program whose record was taken over yields.
//!
//! The same rule in JavaScript for the Electron build: desktop/ownerlock.cjs. Both are checked against one table,
//! `ownerlock-cases.txt` (beside this file): here by the tests below, there by tests/ownerlock.cjs.
//! Std only; checked alone with `rustc --edition 2021 --test ownerlogic.rs`.

/// The owner file's name, in the folder of the session that was handed over.
pub const FILE: &str = "downloads-owner.json";
/// The owner file's `app` and `kind`.
pub const APP: &str = "KurokawaTools";
pub const KIND: &str = "downloads-owner";
pub const FORMAT: u64 = 1;
/// How often the owner renews its heartbeat (and the other program looks again).
pub const HEARTBEAT_MS: i64 = 10_000;
/// A heartbeat older than this, of a program that is gone: stale.
pub const STALE_MS: i64 = 45_000;
/// A heartbeat older than this is stale even when its pid answers (the pid may be another program's by now).
pub const PID_REUSE_MS: i64 = 600_000;
/// A heartbeat further in the future than this: the clock moved back — the age proves nothing.
pub const SKEW_MS: i64 = 120_000;
/// How long a taker waits before it reads its record back.
pub const SETTLE_MS: i64 = 1_500;

/// A record read from the owner file.
#[derive(Clone, Debug, PartialEq)]
pub struct Rec {
    pub owner: String,
    pub pid: u32,
    pub started_at: i64,
    pub heartbeat: i64,
    pub released: bool,
}

/// The program asking.
#[derive(Clone, Debug, PartialEq)]
pub struct Me {
    pub owner: String,
    pub pid: u32,
    pub started_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Status {
    /// No record, or one released.
    Free,
    /// The record names this program (kind, pid and start time).
    Mine,
    /// Another program that looks alive holds them.
    Held,
    /// Another program held them and is gone.
    Stale,
}

impl Status {
    pub fn name(self) -> &'static str {
        match self {
            Status::Free => "free",
            Status::Mine => "mine",
            Status::Held => "held",
            Status::Stale => "stale",
        }
    }
}

/// What a program that believed it owned the downloads does at its heartbeat.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Tick {
    /// Still its own: the heartbeat written again.
    Renew,
    /// Another took them: pause them here, say so.
    Yield,
    /// The record is gone or stale: written again as its own.
    Take,
}

impl Tick {
    pub fn name(self) -> &'static str {
        match self {
            Tick::Renew => "renew",
            Tick::Yield => "yield",
            Tick::Take => "take",
        }
    }
}

/// The record's state for `me` at `now` (ms since 1970). `pid_alive`: whether the record's pid runs (the shell asks
/// the system; a pid equal to this program's own counts as not alive — it is this program, started again).
pub fn status(now: i64, rec: Option<&Rec>, me: &Me, pid_alive: bool) -> Status {
    let r = match rec {
        None => return Status::Free,
        Some(r) => r,
    };
    if r.released {
        return Status::Free;
    }
    if r.owner == me.owner && r.pid == me.pid && r.started_at == me.started_at {
        return Status::Mine;
    }
    let alive = pid_alive && r.pid != me.pid && r.pid != 0;
    let age = now - r.heartbeat;
    if age < -SKEW_MS {
        // (The clock moved back, or the record came from a clock far ahead: only the pid tells.)
        return if alive { Status::Held } else { Status::Stale };
    }
    if age <= STALE_MS {
        return Status::Held;
    }
    if alive && age <= PID_REUSE_MS {
        return Status::Held;
    }
    Status::Stale
}

/// Whether `me` may write its own record now: free, its own or stale without asking; held only when the person
/// asked («Take them back», confirmed).
pub fn may_take(st: Status, asked: bool) -> bool {
    match st {
        Status::Free | Status::Mine | Status::Stale => true,
        Status::Held => asked,
    }
}

/// The owner's heartbeat: renew its own record, yield to another's, take a gone or stale one again.
pub fn tick(st: Status) -> Tick {
    match st {
        Status::Mine => Tick::Renew,
        Status::Held => Tick::Yield,
        Status::Free | Status::Stale => Tick::Take,
    }
}

/// Whether a download may be resumed here: not one of the handed-over `ids` while another live owner holds them.
pub fn resume_allowed(st: Status, ids: &[String], id: &str) -> bool {
    st != Status::Held || !ids.iter().any(|x| x == id)
}

/// The ids aria2's session names (its `gid=` options), and those of them not paused (no ` pause=true` line).
pub fn session_running(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur: Option<String> = None;
    let mut paused = false;
    let flush = |cur: &mut Option<String>, paused: bool, out: &mut Vec<String>| {
        if let Some(g) = cur.take() {
            if !paused {
                out.push(g);
            }
        }
    };
    for line in text.lines() {
        if !line.starts_with(' ') && !line.starts_with('\t') {
            if !line.trim().is_empty() {
                flush(&mut cur, paused, &mut out);
                paused = false;
            }
            continue;
        }
        let l = line.trim();
        if let Some(g) = l.strip_prefix("gid=") {
            cur = Some(g.to_string());
        } else if l == "pause=true" {
            paused = true;
        }
    }
    flush(&mut cur, paused, &mut out);
    out
}

/// aria2's session with ` pause=true` added to the entries of `ids` that lack it (the downloads another live owner
/// holds, kept paused before this program's aria2 reads its session) → (the new text, the gids paused by it).
pub fn session_pause(text: &str, ids: &[String]) -> (String, Vec<String>) {
    // Entries: a line not starting with a space opens one (its URIs); its options follow, indented.
    let mut entries: Vec<Vec<String>> = Vec::new();
    for line in text.lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            if let Some(e) = entries.last_mut() {
                e.push(line.to_string());
                continue;
            }
        }
        entries.push(vec![line.to_string()]);
    }
    let mut paused: Vec<String> = Vec::new();
    let mut out = String::with_capacity(text.len() + 32);
    for e in entries.iter_mut() {
        let gid = e.iter().skip(1).find_map(|l| l.trim().strip_prefix("gid=").map(String::from));
        let has_pause = e.iter().skip(1).any(|l| l.trim() == "pause=true");
        if let Some(g) = gid {
            if !has_pause && ids.iter().any(|x| *x == g) {
                e.push(" pause=true".to_string());
                paused.push(g);
            }
        }
        for l in e.iter() {
            out.push_str(l);
            out.push('\n');
        }
    }
    if !text.ends_with('\n') && out.ends_with('\n') && !text.is_empty() {
        out.pop();
    }
    (out, paused)
}

/* ---------- the shared table (also read by tests/ownerlock.cjs) ---------- */

/// One row of `ownerlock-cases.txt`: `name | now | rec | me | pid_alive | status | may_take(asked=false) |
/// may_take(asked=true) | tick`; rec `-` or `owner,pid,startedAt,heartbeat[,released]`, me `owner,pid,startedAt`.
pub fn parse_case(line: &str) -> Option<(String, i64, Option<Rec>, Me, bool, String, bool, bool, String)> {
    let f: Vec<&str> = line.split('|').map(|x| x.trim()).collect();
    if f.len() != 9 {
        return None;
    }
    let num = |s: &str| s.parse::<i64>().ok();
    let rec = if f[2] == "-" {
        None
    } else {
        let p: Vec<&str> = f[2].split(',').collect();
        if p.len() < 4 {
            return None;
        }
        Some(Rec { owner: p[0].to_string(), pid: p[1].parse().ok()?, started_at: num(p[2])?, heartbeat: num(p[3])?, released: p.get(4) == Some(&"released") })
    };
    let m: Vec<&str> = f[3].split(',').collect();
    if m.len() != 3 {
        return None;
    }
    let me = Me { owner: m[0].to_string(), pid: m[1].parse().ok()?, started_at: num(m[2])? };
    Some((f[0].to_string(), num(f[1])?, rec, me, f[4] == "yes", f[5].to_string(), f[6] == "yes", f[7] == "yes", f[8].to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CASES: &str = include_str!("ownerlock-cases.txt");

    #[test]
    fn the_shared_table() {
        let mut n = 0;
        for line in CASES.lines() {
            let l = line.trim();
            if l.is_empty() || l.starts_with('#') {
                continue;
            }
            let (name, now, rec, me, alive, want, take, take_asked, want_tick) = parse_case(l).unwrap_or_else(|| panic!("bad row: {}", l));
            let st = status(now, rec.as_ref(), &me, alive);
            assert_eq!(st.name(), want, "{}", name);
            assert_eq!(may_take(st, false), take, "{} (not asked)", name);
            assert_eq!(may_take(st, true), take_asked, "{} (asked)", name);
            assert_eq!(tick(st).name(), want_tick, "{} (tick)", name);
            n += 1;
        }
        assert!(n >= 15, "only {} rows", n);
    }

    fn rec(owner: &str, pid: u32, started: i64, hb: i64) -> Rec {
        Rec { owner: owner.into(), pid, started_at: started, heartbeat: hb, released: false }
    }

    /// Two takers at once (the new app at its start, the old one's «Take them back»): each writes, the last rename
    /// wins; after SETTLE_MS each reads back — only the one named keeps them, the other yields at once.
    #[test]
    fn two_takers() {
        let a = Me { owner: "tauri".into(), pid: 10, started_at: 1_000 };
        let b = Me { owner: "electron".into(), pid: 20, started_at: 2_000 };
        let t = 1_000_000;
        // Both find it free.
        assert!(may_take(status(t, None, &a, false), false));
        assert!(may_take(status(t, None, &b, false), false));
        // A writes, then B writes: the file holds B's.
        let file = rec("electron", 20, 2_000, t + 5);
        // A reads back after settling: held by B (alive) → A did not get them; its heartbeat yields.
        let sa = status(t + SETTLE_MS, Some(&file), &a, true);
        assert_eq!(sa, Status::Held);
        assert_eq!(tick(sa), Tick::Yield);
        // B reads back: its own.
        assert_eq!(status(t + SETTLE_MS, Some(&file), &b, true), Status::Mine);
        // A's later, unasked attempt is refused while B lives.
        assert!(!may_take(status(t + 30_000, Some(&file), &a, true), false));
    }

    /// The owner crashed: its heartbeat ages; while young it holds (it may only be slow), then it is stale once its
    /// pid is gone — and taken without asking.
    #[test]
    fn stale_owner() {
        let me = Me { owner: "electron".into(), pid: 20, started_at: 2_000 };
        let r = rec("tauri", 10, 1_000, 100_000);
        assert_eq!(status(100_000 + STALE_MS, Some(&r), &me, false), Status::Held);
        assert_eq!(status(100_000 + STALE_MS + 1, Some(&r), &me, false), Status::Stale);
        assert!(may_take(Status::Stale, false));
        // Its pid taken by some other program: stale after PID_REUSE_MS anyway.
        assert_eq!(status(100_000 + PID_REUSE_MS, Some(&r), &me, true), Status::Held);
        assert_eq!(status(100_000 + PID_REUSE_MS + 1, Some(&r), &me, true), Status::Stale);
        // Released at its quit: free at once.
        let mut q = r.clone();
        q.released = true;
        assert_eq!(status(100_001, Some(&q), &me, true), Status::Free);
    }

    /// The clock jumps: back (the heartbeat lies in the future) → the pid decides; forward (it looks old) → a live
    /// pid still holds until PID_REUSE_MS, and the owner's next heartbeat (on the new clock) makes it young again.
    #[test]
    fn clock_jumps() {
        let me = Me { owner: "electron".into(), pid: 20, started_at: 2_000 };
        let r = rec("tauri", 10, 1_000, 10_000_000);
        // Back by an hour.
        let now = 10_000_000 - 3_600_000;
        assert_eq!(status(now, Some(&r), &me, true), Status::Held);
        assert_eq!(status(now, Some(&r), &me, false), Status::Stale);
        // Back by less than the skew: still a fresh heartbeat.
        assert_eq!(status(10_000_000 - SKEW_MS, Some(&r), &me, false), Status::Held);
        // Forward by five minutes: the owner lives → held; its next heartbeat renews on the new clock.
        let now = 10_000_000 + 300_000;
        assert_eq!(status(now, Some(&r), &me, true), Status::Held);
        let renewed = rec("tauri", 10, 1_000, now + HEARTBEAT_MS);
        assert_eq!(status(now + HEARTBEAT_MS, Some(&renewed), &me, false), Status::Held);
    }

    /// The same program started again with the same pid (reused) but another start time: its old record is not its
    /// own, and its own pid does not make the old record alive.
    #[test]
    fn pid_reused_by_me() {
        let me = Me { owner: "tauri".into(), pid: 10, started_at: 9_000 };
        let r = rec("tauri", 10, 1_000, 1_000);
        assert_eq!(status(1_000 + STALE_MS + 1, Some(&r), &me, true), Status::Stale);
        assert_eq!(status(2_000, Some(&r), &me, true), Status::Held);
    }

    #[test]
    fn resume_guard() {
        let ids = vec!["a1".to_string(), "v3".to_string()];
        assert!(!resume_allowed(Status::Held, &ids, "a1"));
        assert!(!resume_allowed(Status::Held, &ids, "v3"));
        assert!(resume_allowed(Status::Held, &ids, "zz"));
        assert!(resume_allowed(Status::Mine, &ids, "a1"));
        assert!(resume_allowed(Status::Stale, &ids, "a1"));
        assert!(resume_allowed(Status::Free, &ids, "a1"));
    }

    #[test]
    fn session_pause_and_running() {
        let s = "http://a/x\n gid=aaaa\n dir=/d\nmagnet:?xt=b\n gid=bbbb\n pause=true\nhttp://c/y\n gid=cccc\n";
        assert_eq!(session_running(s), vec!["aaaa".to_string(), "cccc".to_string()]);
        let (t, p) = session_pause(s, &["aaaa".to_string(), "bbbb".to_string(), "zzzz".to_string()]);
        assert_eq!(p, vec!["aaaa".to_string()]);
        assert_eq!(t, "http://a/x\n gid=aaaa\n dir=/d\n pause=true\nmagnet:?xt=b\n gid=bbbb\n pause=true\nhttp://c/y\n gid=cccc\n");
        assert_eq!(session_running(&t), vec!["cccc".to_string()]);
        // Nothing to pause: the text unchanged, also without a last newline.
        let (u, q) = session_pause("http://a\n gid=aaaa", &["x".to_string()]);
        assert_eq!(u, "http://a\n gid=aaaa");
        assert!(q.is_empty());
        assert_eq!(session_pause("", &[]).0, "");
    }
}
