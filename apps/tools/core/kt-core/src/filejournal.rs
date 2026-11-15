// Android stage M5, new: the file jobs' JOURNAL — what the Rust engine (Settings → Advanced → File jobs engine: Rust)
// adds that the classic engine never had. Before a planned job runs, its plan is written to a small private file as
// ordered steps; each step is then marked as it begins, at its risky moments (an old file set aside, a new one put in
// its place) and as it ends. A job cut short by a crash, a kill or a card pulled out can therefore be RESUMED exactly
// where it stood, or ROLLED BACK; and a finished job can be UNDONE where every step it took can be reversed (copies,
// moves, renames, new folders — not a replace or a delete, which the bin is for).
//
// The rules only — the file is written by Java (KtFileExec.Journal: one append and, before a risky step, an fsync)
// and read back here. No file contents ever go in it: paths, sizes, times.
//
// The format: UTF-8 lines «crc32(hex, 8)\tKIND\tfield\t…\n», the CRC (java.util.zip.CRC32's, IEEE) over the bytes after
// the first tab; a field's «\», tab, LF and CR written «\\», «\t», «\n», «\r». A line torn by a crash (no newline, a
// wrong CRC, a field it should have) ends the reading there: what came before stands, nothing after it is believed.
//   P v op dest from n   a plan (or a new plan from step `from` on: what came before is kept), n steps follow
//   S i kind fields…     one step, the fields of its JSON array (fileplan::Step::to_json) in order
//   R                    the plan whole (a plan with no R was never begun: nothing to resume)
//   X item               an item the two planners disagreed on: never run
//   B i / A i old / L i / D i size mtime / F i why / K i    begun / old set aside / new in place / done / failed / skipped
//   E status             the job's end (done | cancelled | failed)
//   W                    a resume began        Z i   a step undone        Y   rolled back (all of it)
// Std only, alone: `rustc --edition 2021 --test filejournal.rs`.

/* ---------- the CRC and the lines ---------- */

pub fn crc32(b: &[u8]) -> u32 {
    let mut c: u32 = 0xffff_ffff;
    for &x in b {
        c ^= x as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { (c >> 1) ^ 0xedb8_8320 } else { c >> 1 };
        }
    }
    !c
}

pub fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => o.push_str("\\\\"),
            '\t' => o.push_str("\\t"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            c => o.push(c),
        }
    }
    o
}
fn unesc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c != '\\' {
            o.push(c);
            continue;
        }
        match it.next() {
            Some('t') => o.push('\t'),
            Some('n') => o.push('\n'),
            Some('r') => o.push('\r'),
            Some(x) => o.push(x),
            None => {}
        }
    }
    o
}

/// One record as its line (the newline included).
pub fn line(kind: &str, fields: &[String]) -> String {
    let mut body = esc(kind);
    for f in fields {
        body.push('\t');
        body.push_str(&esc(f));
    }
    format!("{:08x}\t{}\n", crc32(body.as_bytes()), body)
}

/// The records of a journal's text, and whether it ended torn (a bad or unfinished last part, not believed).
pub fn read(text: &str) -> (Vec<Vec<String>>, bool) {
    let mut out = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let nl = match rest.find('\n') {
            Some(i) => i,
            None => return (out, true),
        };
        let l = &rest[..nl];
        rest = &rest[nl + 1..];
        let tab = match l.find('\t') {
            Some(i) if i == 8 => i,
            _ => return (out, true),
        };
        let crc = match u32::from_str_radix(&l[..tab], 16) {
            Ok(c) => c,
            Err(_) => return (out, true),
        };
        let body = &l[tab + 1..];
        if crc32(body.as_bytes()) != crc {
            return (out, true);
        }
        out.push(body.split('\t').map(unesc).collect());
    }
    (out, false)
}

/* ---------- a journal read back ---------- */

#[derive(Clone, Debug, PartialEq)]
pub enum St {
    Pending,
    Begun,
    Aside(String),
    /// The new copy in place (the old one, when set aside, still there).
    Placed(Option<String>),
    Done(u64, i64),
    Failed(String),
    Skipped,
}

/// A step as written: its kind and its fields (positions as in fileplan::Step::to_json, the kind dropped).
#[derive(Clone, Debug, PartialEq)]
pub struct JStep {
    pub kind: String,
    pub f: Vec<String>,
}
impl JStep {
    fn s(&self, i: usize) -> &str {
        self.f.get(i).map(|x| x.as_str()).unwrap_or("")
    }
    fn n(&self, i: usize) -> u64 {
        self.s(i).parse().unwrap_or(0)
    }
    fn b(&self, i: usize) -> bool {
        self.s(i) == "true"
    }
    pub fn item(&self) -> usize {
        self.n(0) as usize
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct State {
    pub op: String,
    pub dest: String,
    pub steps: Vec<JStep>,
    pub st: Vec<St>,
    pub disputed: Vec<usize>,
    /// The plan written whole (R).
    pub ready: bool,
    pub ended: Option<String>,
    pub undone: Vec<usize>,
    pub rolled_back: bool,
    pub resumes: u32,
    pub torn: bool,
}

/// The journal's state from its records.
pub fn state(recs: &[Vec<String>], torn: bool) -> State {
    let mut s = State { torn, ..State::default() };
    let mut pending: Vec<JStep> = Vec::new();
    let mut from = 0usize;
    let mut want = 0usize;
    for r in recs {
        let k = r[0].as_str();
        let idx = |j: usize| r.get(j).and_then(|x| x.parse::<usize>().ok());
        match k {
            "P" => {
                s.op = r.get(2).cloned().unwrap_or_default();
                s.dest = r.get(3).cloned().unwrap_or_default();
                from = idx(4).unwrap_or(0);
                want = idx(5).unwrap_or(0);
                pending.clear();
            }
            "S" => pending.push(JStep { kind: r.get(2).cloned().unwrap_or_default(), f: r.iter().skip(3).cloned().collect() }),
            "R" => {
                if pending.len() == want && from <= s.steps.len() {
                    s.steps.truncate(from);
                    s.st.truncate(from);
                    for p in pending.drain(..) {
                        s.steps.push(p);
                        s.st.push(St::Pending);
                    }
                    s.ready = true;
                }
            }
            "X" => {
                if let Some(i) = idx(1) {
                    if !s.disputed.contains(&i) {
                        s.disputed.push(i);
                    }
                }
            }
            "B" | "A" | "L" | "D" | "F" | "K" => {
                let i = match idx(1) {
                    Some(i) if i < s.st.len() => i,
                    _ => continue,
                };
                let old = match &s.st[i] {
                    St::Aside(o) => Some(o.clone()),
                    _ => None,
                };
                s.st[i] = match k {
                    "B" => St::Begun,
                    "A" => St::Aside(r.get(2).cloned().unwrap_or_default()),
                    "L" => St::Placed(old),
                    "D" => St::Done(r.get(2).and_then(|x| x.parse().ok()).unwrap_or(0), r.get(3).and_then(|x| x.parse().ok()).unwrap_or(-1)),
                    "F" => St::Failed(r.get(2).cloned().unwrap_or_default()),
                    _ => St::Skipped,
                };
            }
            "E" => s.ended = r.get(1).cloned(),
            "W" => {
                s.resumes += 1;
                s.ended = None;
            }
            "Z" => {
                if let Some(i) = idx(1) {
                    s.undone.push(i);
                }
            }
            "Y" => s.rolled_back = true,
            _ => {}
        }
    }
    s
}

/// A job cut short that can be resumed or rolled back: its plan whole, no end, not rolled back.
pub fn resumable(s: &State) -> bool {
    s.ready && s.ended.is_none() && !s.rolled_back
}

/// The first step not yet finished (a resume goes on from there, once the repairs are done).
pub fn next_index(s: &State) -> usize {
    s.st.iter().position(|x| matches!(x, St::Pending | St::Begun | St::Aside(_) | St::Placed(_))).unwrap_or(s.st.len())
}

/* ---------- what to do: the actions Java carries out, each checked against what is really there ---------- */

#[derive(Clone, Debug, PartialEq)]
pub enum Act {
    /// Delete our own `….ktpart` if it is there (a file).
    UnlinkPart(String),
    /// Delete a copy this job made: only a file of that size (and, when ≥ 0, that time).
    Unlink(String, u64, i64),
    /// The old file set aside put back: only when its place is empty.
    RestoreAside(String, String),
    /// The old file set aside dropped: only when the new one stands in its place (`to`).
    DropAside(String, String),
    /// `from` moved back to `to`: only when `to` is free and `from` is there.
    MoveBack(String, String),
    /// A move's source deleted once its copy stands whole at `to` (that size).
    FinishMove(String, String, u64),
    /// A folder built under `into` put in place of `to`: only when `to` is free.
    SwapIn(String, String),
    RmdirEmpty(String),
    Mkdir(String),
    /// A copy cut short, brought to a clean point by what is really there (Java: KtFileExec.act): its part dropped; with
    /// an old file set aside — put back when the new one is not in place, dropped when it is; with none — a file of
    /// the right size at `to` (which the step checked was free before it began) taken for the copy. Taken: the move's
    /// source dropped and the step marked done; else the step runs again.
    SettleCopy { i: usize, from: String, to: String, size: u64, mv: bool, replace: bool, old: Option<String> },
    /// The same copy undone: its part dropped, the new file removed (or moved back to the source a move deleted), the
    /// old one put back.
    UnsettleCopy { from: String, to: String, size: u64, mv: bool, replace: bool, old: Option<String> },
    /// A folder swapped in for a file, cut short: finished when the folder stands at `to` (the old file dropped, the
    /// emptied source removed for a move), else put back to run again.
    SettleSwap { i: usize, from: String, to: String, into: String, old: Option<String>, rmdir: bool },
    /// The same swap undone: the folder back under `into`, the old file back at `to`.
    UnsettleSwap { to: String, into: String, old: Option<String> },
    /// Mark step i done (resume) / undone (rollback).
    MarkDone(usize),
    MarkUndone(usize),
}

impl Act {
    pub fn fields(&self) -> Vec<String> {
        let s = |x: &str| x.to_string();
        match self {
            Act::UnlinkPart(p) => vec![s("unlinkPart"), p.clone()],
            Act::Unlink(p, n, m) => vec![s("unlink"), p.clone(), n.to_string(), m.to_string()],
            Act::RestoreAside(o, t) => vec![s("restoreAside"), o.clone(), t.clone()],
            Act::DropAside(o, t) => vec![s("dropAside"), o.clone(), t.clone()],
            Act::MoveBack(f, t) => vec![s("moveBack"), f.clone(), t.clone()],
            Act::FinishMove(f, t, n) => vec![s("finishMove"), f.clone(), t.clone(), n.to_string()],
            Act::SwapIn(i, t) => vec![s("swapIn"), i.clone(), t.clone()],
            Act::RmdirEmpty(p) => vec![s("rmdirEmpty"), p.clone()],
            Act::Mkdir(p) => vec![s("mkdir"), p.clone()],
            Act::SettleCopy { i, from, to, size, mv, replace, old } => vec![s("settleCopy"), i.to_string(), from.clone(), to.clone(), size.to_string(), mv.to_string(), replace.to_string(), old.clone().unwrap_or_default()],
            Act::UnsettleCopy { from, to, size, mv, replace, old } => vec![s("unsettleCopy"), from.clone(), to.clone(), size.to_string(), mv.to_string(), replace.to_string(), old.clone().unwrap_or_default()],
            Act::SettleSwap { i, from, to, into, old, rmdir } => vec![s("settleSwap"), i.to_string(), from.clone(), to.clone(), into.clone(), old.clone().unwrap_or_default(), rmdir.to_string()],
            Act::UnsettleSwap { to, into, old } => vec![s("unsettleSwap"), to.clone(), into.clone(), old.clone().unwrap_or_default()],
            Act::MarkDone(i) => vec![s("markDone"), i.to_string()],
            Act::MarkUndone(i) => vec![s("markUndone"), i.to_string()],
        }
    }
}

/// The repairs before a RESUME: each step cut in the middle brought to a clean point — undone where it had not put
/// anything in place yet (to be run again), finished where it had.
pub fn repair_for_resume(s: &State) -> Vec<Act> {
    let mut out = Vec::new();
    for (i, (st, step)) in s.st.iter().zip(&s.steps).enumerate() {
        if s.disputed.contains(&step.item()) {
            continue;
        }
        match (step.kind.as_str(), st) {
            ("copy", St::Begun) | ("copy", St::Aside(_)) => {
                let old = if let St::Aside(o) = st { Some(o.clone()) } else { None };
                out.push(Act::SettleCopy { i, from: step.s(2).to_string(), to: step.s(3).to_string(), size: step.n(4), mv: step.b(6), replace: step.b(5), old });
            }
            ("copy", St::Placed(old)) => {
                let (from, to) = (step.s(2), step.s(3));
                if let Some(o) = old {
                    out.push(Act::DropAside(o.clone(), to.to_string()));
                }
                if step.b(6) {
                    out.push(Act::FinishMove(from.to_string(), to.to_string(), step.n(4)));
                }
                out.push(Act::MarkDone(i));
            }
            ("endDir", St::Begun) | ("endDir", St::Aside(_)) if step.b(6) => {
                let old = if let St::Aside(o) = st { Some(o.clone()) } else { None };
                out.push(Act::SettleSwap { i, from: step.s(3).to_string(), to: step.s(4).to_string(), into: step.s(5).to_string(), old, rmdir: step.b(7) });
            }
            ("endDir", St::Placed(old)) => {
                if let Some(o) = old {
                    out.push(Act::DropAside(o.clone(), step.s(4).to_string()));
                }
                if step.b(7) {
                    out.push(Act::RmdirEmpty(step.s(3).to_string()));
                }
                out.push(Act::MarkDone(i));
            }
            // (rename, dir, del, endDir before its swap: run again — each is safe to run twice, the executor checks)
            _ => {}
        }
    }
    out
}

/// A ROLLBACK (of a job cut short) or an UNDO (of a finished one): every step taken, undone in reverse order where it
/// can be; and the steps that cannot be undone («name: why»). Steps already undone (Z) are not undone twice.
pub fn rollback(s: &State) -> (Vec<Act>, Vec<String>) {
    let mut acts = Vec::new();
    let mut lost = Vec::new();
    for i in (0..s.steps.len()).rev() {
        if s.undone.contains(&i) {
            continue;
        }
        let step = &s.steps[i];
        let st = &s.st[i];
        if matches!(st, St::Pending | St::Failed(_) | St::Skipped) {
            continue;
        }
        let name = |p: &str| p.rsplit('/').next().unwrap_or(p).to_string();
        match step.kind.as_str() {
            "copy" => {
                let (from, to, size, replace, mv) = (step.s(2), step.s(3), step.n(4), step.b(5), step.b(6));
                match st {
                    St::Begun | St::Aside(_) => {
                        let old = if let St::Aside(o) = st { Some(o.clone()) } else { None };
                        acts.push(Act::UnsettleCopy { from: from.to_string(), to: to.to_string(), size, mv, replace, old });
                    }
                    St::Placed(old) => {
                        // (the new copy in place, the source perhaps not yet deleted: the copy goes, or comes back)
                        if mv {
                            acts.push(Act::MoveBack(to.to_string(), from.to_string()));
                        }
                        acts.push(Act::Unlink(to.to_string(), size, -1));
                        if let Some(o) = old {
                            acts.push(Act::RestoreAside(o.clone(), to.to_string()));
                        }
                        if replace {
                            // (the old file is dropped right after the new one is in place: it may be gone already)
                            lost.push(format!("{}: replaced", name(to)));
                        }
                    }
                    St::Done(sz, mt) => {
                        if mv {
                            acts.push(Act::MoveBack(to.to_string(), from.to_string()));
                        } else if !replace {
                            acts.push(Act::Unlink(to.to_string(), *sz, *mt));
                        }
                        if replace {
                            lost.push(format!("{}: replaced", name(to)));
                        }
                    }
                    _ => {}
                }
            }
            "rename" => acts.push(Act::MoveBack(step.s(3).to_string(), step.s(2).to_string())),
            "dir" => {
                if step.b(5) {
                    acts.push(Act::RmdirEmpty(step.s(4).to_string()));
                }
            }
            "endDir" => {
                let (from, to, into, swap, rmdir) = (step.s(3), step.s(4), step.s(5), step.b(6), step.b(7));
                match st {
                    St::Begun | St::Aside(_) if swap => {
                        let old = if let St::Aside(o) = st { Some(o.clone()) } else { None };
                        acts.push(Act::UnsettleSwap { to: to.to_string(), into: into.to_string(), old });
                    }
                    St::Placed(old) if swap => {
                        if rmdir {
                            acts.push(Act::Mkdir(from.to_string()));
                        }
                        acts.push(Act::UnsettleSwap { to: to.to_string(), into: into.to_string(), old: old.clone() });
                    }
                    St::Done(..) | St::Placed(_) | St::Begun => {
                        if rmdir {
                            acts.push(Act::Mkdir(from.to_string()));
                        }
                        if swap && matches!(st, St::Done(..)) {
                            lost.push(format!("{}: replaced by a folder", name(to)));
                        }
                    }
                    _ => {}
                }
            }
            "del" => {
                if matches!(st, St::Done(..) | St::Begun) {
                    lost.push(format!("{}: deleted", name(step.s(1))));
                }
            }
            _ => {}
        }
        acts.push(Act::MarkUndone(i));
    }
    (acts, lost)
}

/// Whether a finished job can be undone whole.
pub fn undoable(s: &State) -> bool {
    s.ready && !s.rolled_back && s.st.iter().any(|x| matches!(x, St::Done(..))) && rollback(s).1.is_empty()
}

/// The journals to delete: (name, modified ms, finished); the finished ones beyond the newest `keep` or older than
/// `max_age_ms`, any older than `max_age_ms * 2` (a job cut short and never resumed).
pub fn prune(list: &[(String, i64, bool)], now_ms: i64, keep: usize, max_age_ms: i64) -> Vec<String> {
    let mut fin: Vec<&(String, i64, bool)> = list.iter().filter(|x| x.2).collect();
    fin.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let mut out = Vec::new();
    for (k, x) in fin.iter().enumerate() {
        if k >= keep || now_ms - x.1 > max_age_ms {
            out.push(x.0.clone());
        }
    }
    for x in list.iter().filter(|x| !x.2) {
        if now_ms - x.1 > max_age_ms * 2 {
            out.push(x.0.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: &[&str]) -> Vec<String> {
        x.iter().map(|s| s.to_string()).collect()
    }
    fn journal(lines: &[(&str, &[&str])]) -> String {
        lines.iter().map(|(k, f)| line(k, &v(f))).collect()
    }

    #[test]
    fn crc_is_javas() {
        // (java.util.zip.CRC32 of «123456789» is 0xCBF43926)
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn lines_round_trip_and_torn_ends() {
        let odd = "a\tb\nc\\d\r😀 مرحبا";
        let t = line("S", &v(&["0", odd]));
        let (r, torn) = read(&t);
        assert!(!torn);
        assert_eq!(r, vec![v(&["S", "0", odd])]);
        let two = format!("{}{}", line("B", &v(&["0"])), line("D", &v(&["0", "3", "9"])));
        assert_eq!(read(&two).0.len(), 2);
        // a torn last line (no newline): the rest stands
        let cut = &two[..two.len() - 3];
        let (r, torn) = read(cut);
        assert!(torn && r.len() == 1);
        // a flipped byte: not believed, nor anything after
        let mut bad = two.clone().into_bytes();
        bad[12] ^= 1;
        let (r, torn) = read(&String::from_utf8_lossy(&bad));
        assert!(torn && r.is_empty());
        assert_eq!(read("").0.len(), 0);
    }

    fn copy_job() -> String {
        journal(&[
            ("P", &["1", "move", "/d", "0", "3"]),
            ("S", &["0", "copy", "0", "1", "/s/a", "/d/a", "5", "false", "true"]),
            ("S", &["1", "copy", "1", "2", "/s/b", "/d/b", "7", "true", "true"]),
            ("S", &["2", "end", "1", "true"]),
            ("R", &[]),
        ])
    }

    #[test]
    fn state_and_resume() {
        let mut t = copy_job();
        let s = state(&read(&t).0, false);
        assert!(resumable(&s) && s.steps.len() == 3 && next_index(&s) == 0);
        t.push_str(&journal(&[("B", &["0"]), ("L", &["0"]), ("B", &["1"]), ("A", &["1", "/d/b.ktold (2)"])]));
        let s = state(&read(&t).0, false);
        assert_eq!(s.st[0], St::Placed(None));
        assert_eq!(s.st[1], St::Aside("/d/b.ktold (2)".into()));
        assert_eq!(next_index(&s), 0);
        assert_eq!(
            repair_for_resume(&s),
            vec![
                Act::FinishMove("/s/a".into(), "/d/a".into(), 5),
                Act::MarkDone(0),
                Act::SettleCopy { i: 1, from: "/s/b".into(), to: "/d/b".into(), size: 7, mv: true, replace: true, old: Some("/d/b.ktold (2)".into()) }
            ]
        );
        // a plan without its R: never begun
        let half = journal(&[("P", &["1", "copy", "/d", "0", "2"]), ("S", &["0", "end", "0", "true"])]);
        assert!(!resumable(&state(&read(&half).0, true)));
        // the end written: nothing to resume
        t.push_str(&journal(&[("E", &["done"])]));
        assert!(!resumable(&state(&read(&t).0, false)));
    }

    #[test]
    fn a_new_plan_keeps_the_steps_before_it() {
        let t = format!("{}{}", copy_job(), journal(&[("D", &["0", "5", "1"]), ("P", &["1", "move", "/d", "1", "1"]), ("S", &["1", "skip", "1", "2", "/s/b", "7", "1", "false"]), ("R", &[])]));
        let s = state(&read(&t).0, false);
        assert_eq!(s.steps.len(), 2);
        assert_eq!(s.steps[1].kind, "skip");
        assert_eq!(s.st[0], St::Done(5, 1));
    }

    #[test]
    fn rollback_and_undo() {
        let t = format!(
            "{}{}",
            journal(&[
                ("P", &["1", "move", "/d", "0", "5"]),
                ("S", &["0", "dir", "0", "2", "1", "/s/D", "/d/D", "true", "2"]),
                ("S", &["1", "copy", "0", "2", "/s/D/x", "/d/D/x", "5", "false", "true"]),
                ("S", &["2", "rename", "0", "2", "/s/D/y", "/d/D/y", "1", "3"]),
                ("S", &["3", "endDir", "0", "2", "1", "/s/D", "/d/D", "/d/D", "false", "true"]),
                ("S", &["4", "end", "0", "true"]),
                ("R", &[]),
            ]),
            journal(&[("D", &["0", "0", "0"]), ("D", &["1", "5", "7"]), ("D", &["2", "1", "8"]), ("D", &["3", "0", "0"]), ("D", &["4", "0", "0"]), ("E", &["done"])])
        );
        let s = state(&read(&t).0, false);
        assert!(!resumable(&s) && undoable(&s));
        let (acts, lost) = rollback(&s);
        assert!(lost.is_empty());
        assert_eq!(
            acts,
            vec![
                Act::MarkUndone(4),
                Act::Mkdir("/s/D".into()),
                Act::MarkUndone(3),
                Act::MoveBack("/d/D/y".into(), "/s/D/y".into()),
                Act::MarkUndone(2),
                Act::MoveBack("/d/D/x".into(), "/s/D/x".into()),
                Act::MarkUndone(1),
                Act::RmdirEmpty("/d/D".into()),
                Act::MarkUndone(0)
            ]
        );
        // a replace and a delete cannot be undone
        let t = journal(&[("P", &["1", "copy", "/d", "0", "2"]), ("S", &["0", "copy", "0", "1", "/s/a", "/d/a", "5", "true", "false"]), ("S", &["1", "del", "1", "/s/q", "3"]), ("R", &[]), ("D", &["0", "5", "1"]), ("D", &["1", "0", "0"])]);
        let s = state(&read(&t).0, false);
        assert!(!undoable(&s));
        assert_eq!(rollback(&s).1, v(&["q: deleted", "a: replaced"]));
        // what was undone is not undone again
        let t2 = format!("{}{}", t, journal(&[("Z", &["1"]), ("Z", &["0"])]));
        assert!(rollback(&state(&read(&t2).0, false)).0.is_empty());
    }

    #[test]
    fn disputed_items_are_not_repaired() {
        let t = format!("{}{}", copy_job(), journal(&[("X", &["0"]), ("B", &["0"]), ("L", &["0"])]));
        assert!(repair_for_resume(&state(&read(&t).0, false)).is_empty());
    }

    #[test]
    fn pruning() {
        let l = vec![("a".to_string(), 100, true), ("b".to_string(), 200, true), ("c".to_string(), 300, true), ("cut".to_string(), 0, false), ("cut2".to_string(), 900, false)];
        assert_eq!(prune(&l, 1000, 2, 10_000), v(&["a"]));
        assert_eq!(prune(&l, 25_000, 5, 10_000), v(&["c", "b", "a", "cut", "cut2"]));
    }
}
