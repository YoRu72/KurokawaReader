// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): game controllers' own readers.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/playstation.cpp, switch_pro.cpp, steam_controller.cpp, eightbitdo.cpp, gamesir.cpp, flydigi.cpp,
// beitong.cpp (and xinput.cpp for the Xbox family's place in this table) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later. One file per family
// here; this one holds what they share.
// Changed here (the original's faults, PLAN-battery §9):
// - A controller is matched by vendor AND product AND its collection's usage page (and usage where the family has
//   one) — never by vendor alone (the original's 8BitDo reader probed every 2DC8 product, its GameSir one every 3537
//   product it knew of by a loose page test).
// - Passive first: the readers listen to input reports the pad already sends; a handle opened to listen takes nothing
//   from a game reading the same pad (every handle gets its own copy of each report), and nothing is ever written to
//   listen. Only four families send anything, each one request that changes nothing on the controller, sealed in
//   allow.rs with its exact bytes, and only after the user turned that family's reading on (off by default:
//   «ported, untested»). What the original sent that changes a controller is not sent at all: the PlayStation pads'
//   feature report 05 over Bluetooth (it switches the pad to its full report mode), 8BitDo's feature report 06 (it
//   turns on another report format), GameSir Cyclone 2's 0F 03 (it starts a stream). Those pads are read when something
//   else (a game, Steam, the maker's app) has already switched them; otherwise they say «needs a query we do not send».
// - Levels as the pad gives them: a percentage only when the pad sends one (8BitDo, Steam, GameSir, BEITONG); steps
//   otherwise (PlayStation 0–10, Nintendo 0–4, Flydigi 0–5 — the original turned them into level × 10 + 5, 25 × level,
//   20 × level per cent). A malformed, short or out-of-range report is no reading — never a guess, never clamped into
//   a number the pad did not say.
// - Every call under the caller's deadline; a listening window per family inside it; a reply taken only when it
//   answers the request just sent (the queue dropped first, the reply's command echoed).
// - No value kept across rounds in a global (the original's g_lastUltimate2Pct showed a docked pad's old level).
// Copyright (C) 2026 Kurokawa contributors. Std only.
pub mod beitong;
pub mod eightbitdo;
pub mod flydigi;
pub mod gamesir;
pub mod nintendo;
pub mod playstation;
pub mod steam;

use crate::allow::{self, HidIdent, ReportKind};
use crate::model::{Charging, Level, Note, Reading};
use crate::sched::Outcome;
use crate::transport::{HidTransport, TErr};
use std::time::{Duration, Instant};

/// A controller family: the brand as text (never a logo) and what the page's per-family switch names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Family {
    PlayStation,
    Xbox,
    Nintendo,
    Steam,
    EightBitDo,
    GameSir,
    Flydigi,
    Beitong,
}

impl Family {
    pub const ALL: [Family; 8] = [Family::PlayStation, Family::Xbox, Family::Nintendo, Family::Steam, Family::EightBitDo, Family::GameSir, Family::Flydigi, Family::Beitong];
    pub fn as_str(self) -> &'static str {
        match self {
            Family::PlayStation => "playstation",
            Family::Xbox => "xbox",
            Family::Nintendo => "nintendo",
            Family::Steam => "steam",
            Family::EightBitDo => "eightbitdo",
            Family::GameSir => "gamesir",
            Family::Flydigi => "flydigi",
            Family::Beitong => "beitong",
        }
    }
    pub fn parse(s: &str) -> Option<Family> {
        Family::ALL.iter().copied().find(|f| f.as_str() == s)
    }
    /// The brand, as plain text.
    pub fn brand(self) -> &'static str {
        match self {
            Family::PlayStation => "PlayStation",
            Family::Xbox => "Xbox",
            Family::Nintendo => "Nintendo",
            Family::Steam => "Steam",
            Family::EightBitDo => "8BitDo",
            Family::GameSir => "GameSir",
            Family::Flydigi => "Flydigi",
            Family::Beitong => "BEITONG",
        }
    }
}

/// How far a reader is proven. No controller has been tried on real hardware here yet: every one is PortedUntested.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Proven {
    Tested,
    PortedUntested,
}

impl Proven {
    pub fn as_str(self) -> &'static str {
        match self {
            Proven::Tested => "tested",
            Proven::PortedUntested => "untested",
        }
    }
}

/// Whether a reader sends anything.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Way {
    /// It only listens to the reports the pad sends anyway.
    Passive,
    /// It sends one status request (allow.rs) — only once the user turned its family on.
    Query,
}

/// One reader: its id (Device::driver), family, proof, way, and the original file it was ported from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Driver {
    pub id: &'static str,
    pub family: Family,
    pub proven: Proven,
    pub way: Way,
    pub from: &'static str,
}

impl Driver {
    /// On unless the user changes it: a passive reader that is untested is on; one that sends a request is on only
    /// when tested (none is yet) — the user turns it on per family.
    pub fn on_by_default(&self) -> bool {
        self.way == Way::Passive || self.proven == Proven::Tested
    }
}

pub static DRIVERS: &[Driver] = &[
    Driver { id: "playstation", family: Family::PlayStation, proven: Proven::PortedUntested, way: Way::Passive, from: "src/drivers/playstation.cpp" },
    Driver { id: "xbox", family: Family::Xbox, proven: Proven::PortedUntested, way: Way::Passive, from: "src/drivers/xinput.cpp" },
    Driver { id: "nintendo", family: Family::Nintendo, proven: Proven::PortedUntested, way: Way::Passive, from: "src/drivers/switch_pro.cpp" },
    Driver { id: "steam", family: Family::Steam, proven: Proven::PortedUntested, way: Way::Passive, from: "src/drivers/steam_controller.cpp" },
    Driver { id: "8bitdo", family: Family::EightBitDo, proven: Proven::PortedUntested, way: Way::Passive, from: "src/drivers/eightbitdo.cpp (PollDInputGamepad)" },
    Driver { id: "8bitdo-rx", family: Family::EightBitDo, proven: Proven::PortedUntested, way: Way::Query, from: "src/drivers/eightbitdo.cpp (PollVendorCollection)" },
    Driver { id: "gamesir-nova", family: Family::GameSir, proven: Proven::PortedUntested, way: Way::Query, from: "src/drivers/gamesir.cpp (PollGameSir)" },
    Driver { id: "gamesir-cyclone", family: Family::GameSir, proven: Proven::PortedUntested, way: Way::Passive, from: "src/drivers/gamesir.cpp (PollGameSirCyclone)" },
    Driver { id: "flydigi", family: Family::Flydigi, proven: Proven::PortedUntested, way: Way::Query, from: "src/drivers/flydigi.cpp" },
    Driver { id: "beitong", family: Family::Beitong, proven: Proven::PortedUntested, way: Way::Query, from: "src/drivers/beitong.cpp" },
];

pub fn driver(id: &str) -> Option<&'static Driver> {
    DRIVERS.iter().find(|d| d.id == id)
}

/// The families whose reading sends a request (the page's switches), each once, in table order.
pub fn query_families() -> Vec<Family> {
    let mut out: Vec<Family> = Vec::new();
    for d in DRIVERS.iter().filter(|d| d.way == Way::Query) {
        if !out.contains(&d.family) {
            out.push(d.family);
        }
    }
    out
}

/// How the pad reaches the computer through this collection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Link {
    /// The pad itself (by USB cable or Bluetooth — the path tells which).
    Pad,
    /// A receiver: it may be there with no pad linked.
    Receiver,
}

/// One product a reader knows: vendor, product, the collection's usage page and usages (empty: any usage on that
/// page), its name and drawing, and the least report lengths (Windows' counts, the report id included).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Model {
    pub driver: &'static str,
    pub vid: u16,
    pub pid: u16,
    pub page: u16,
    pub usages: &'static [u16],
    pub name: &'static str,
    pub picture: &'static str,
    pub link: Link,
    pub min_in: usize,
    pub min_out: usize,
    /// The level comes only in a report mode or stream something else has to turn on (we never do): reports without
    /// it, or none at all, mean «needs a query we do not send», not «no answer».
    pub mode_bound: bool,
    /// Each interface is another pad (a receiver with several slots): one entry per interface, not per unit.
    pub per_interface: bool,
    /// Products that are one physical model in different modes (cable / receiver): merged when their serials agree.
    pub group: &'static str,
}

impl Model {
    pub const fn new(driver: &'static str, vid: u16, pid: u16, page: u16, usages: &'static [u16], name: &'static str, picture: &'static str, link: Link) -> Model {
        Model { driver, vid, pid, page, usages, name, picture, link, min_in: 2, min_out: 0, mode_bound: false, per_interface: false, group: "" }
    }
    pub fn matches(&self, id: &HidIdent) -> bool {
        self.vid == id.vid && self.pid == id.pid && self.page == id.usage_page && (self.usages.is_empty() || self.usages.contains(&id.usage))
    }
    pub fn driver(&self) -> &'static Driver {
        driver(self.driver).expect("every model names a driver of the table")
    }
}

fn all_models() -> impl Iterator<Item = &'static Model> {
    playstation::MODELS
        .iter()
        .chain(nintendo::MODELS.iter())
        .chain(steam::MODELS.iter())
        .chain(eightbitdo::MODELS.iter())
        .chain(eightbitdo::RX_MODELS.iter())
        .chain(gamesir::MODELS.iter())
        .chain(flydigi::MODELS.iter())
        .chain(beitong::MODELS.iter())
}

/// The products a family's request-sending readers are for (the page names them under its switch).
pub fn query_models(f: Family) -> Vec<&'static Model> {
    all_models().filter(|m| m.driver().family == f && m.driver().way == Way::Query).collect()
}

/// The reader for one collection, by its full identity.
pub fn find(id: &HidIdent) -> Option<&'static Model> {
    all_models().find(|m| m.matches(id))
}

/// The collection's report lengths are those the reader needs (else it is another firmware's: left alone).
pub fn fits(m: &Model, input_len: usize, output_len: usize) -> bool {
    input_len >= m.min_in && output_len >= m.min_out
}

/// The group of a product (Model::group), "" when none.
pub fn group_of(vid: u16, pid: u16) -> &'static str {
    all_models().find(|m| m.vid == vid && m.pid == pid && !m.group.is_empty()).map_or("", |m| m.group)
}

/// A report as the original and the public documents (SDL, Linux) number its bytes: Windows puts a 0 before a report
/// of a collection that does not number its reports; that byte is dropped (hidapi's rule, the original's HidDev::Read).
pub fn payload(r: &[u8]) -> &[u8] {
    match r.first() {
        Some(0) => &r[1..],
        _ => r,
    }
}

/// What a reader says of one report.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Parsed {
    /// Not a battery report (another report of the pad): listen on.
    Skip,
    /// The level (Unknown when the report says the pad cannot tell, e.g. a charging fault) and charging.
    Got(Level, Charging),
    /// A receiver telling that no pad is linked.
    NoPad,
    /// The battery report, but short, out of range or malformed: no reading from it.
    Bad,
}

/// What listening gave.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Heard {
    Got(Level, Charging),
    NoPad,
    /// Reports came, none of them with a usable level.
    OnlyOther,
    /// Nothing came in the window.
    Quiet,
    Gone,
}

/// Listens to the reports the pad sends, for `window` and never past `deadline`, until one tells the level.
pub fn listen(t: &mut dyn HidTransport, deadline: Instant, window: Duration, parse: &mut dyn FnMut(&[u8]) -> Parsed) -> Heard {
    let end = deadline.min(Instant::now() + window);
    let mut heard = false;
    loop {
        if Instant::now() >= end {
            break;
        }
        match t.read_input(end) {
            Ok(r) => {
                heard = true;
                match parse(payload(&r)) {
                    Parsed::Got(l, c) => return Heard::Got(l, c),
                    Parsed::NoPad => return Heard::NoPad,
                    Parsed::Skip | Parsed::Bad => continue,
                }
            }
            Err(TErr::Gone) => return Heard::Gone,
            Err(_) => break,
        }
    }
    if heard {
        Heard::OnlyOther
    } else {
        Heard::Quiet
    }
}

/// What a passive reader's listening means, as the runner's outcome.
pub fn heard_outcome(m: &Model, h: Heard, now: u64) -> Outcome {
    match h {
        Heard::Got(l, c) => Outcome::Read(Reading::new(l, c, now)),
        Heard::NoPad => Outcome::Read(Reading::unknown(Note::NoPad, Charging::Unknown, now)),
        Heard::OnlyOther if m.mode_bound => Outcome::Read(Reading::unknown(Note::NeedsQuery, Charging::Unknown, now)),
        Heard::OnlyOther => Outcome::Read(Reading::unknown(Note::None, Charging::Unknown, now)),
        Heard::Quiet if m.mode_bound => Outcome::Read(Reading::unknown(Note::NeedsQuery, Charging::Unknown, now)),
        Heard::Quiet if m.link == Link::Receiver => Outcome::Read(Reading::unknown(Note::NoPad, Charging::Unknown, now)),
        Heard::Quiet => Outcome::NoAnswer,
        Heard::Gone => Outcome::Failed,
    }
}

/// One request and its reply: the bytes must be allow.rs's for this very collection (else Refused, nothing sent); the
/// handle's queue is dropped first, so the reply is the device's answer to this request; `is_reply` tells it from the
/// other reports. Waits at most `step` and never past `deadline`.
pub fn ask(t: &mut dyn HidTransport, bytes: &[u8], deadline: Instant, step: Duration, is_reply: &dyn Fn(&[u8]) -> bool) -> Result<Vec<u8>, TErr> {
    let w = allow::permit(t.ident(), ReportKind::Output, bytes).ok_or(TErr::Refused)?;
    let end = deadline.min(Instant::now() + step);
    t.flush();
    t.send(&w, end)?;
    loop {
        let r = t.read_input(end)?;
        if is_reply(payload(&r)) {
            return Ok(payload(&r).to_vec());
        }
    }
}

/// Reads one pad through its collection. `queries_on`: the user turned its family's reading on (only for readers that
/// send a request; a passive reader ignores it). `bluetooth`: the collection is on a Bluetooth link.
pub fn read(t: &mut dyn HidTransport, m: &Model, bluetooth: bool, queries_on: bool, deadline: Instant, now: u64) -> Outcome {
    let d = m.driver();
    if d.way == Way::Query && !queries_on {
        return Outcome::Read(Reading::unknown(Note::QueryOff, Charging::Unknown, now));
    }
    match m.driver {
        "playstation" => {
            // (Only over Bluetooth does the level wait for the full report mode; by cable it is always there.)
            let mut mm = *m;
            mm.mode_bound = bluetooth;
            heard_outcome(&mm, listen(t, deadline, playstation::WINDOW, &mut |r| playstation::parse(m, bluetooth, r)), now)
        }
        "nintendo" => heard_outcome(m, listen(t, deadline, nintendo::WINDOW, &mut |r| nintendo::parse(r)), now),
        "steam" => heard_outcome(m, listen(t, deadline, steam::window(m), &mut |r| steam::parse(m, r)), now),
        "8bitdo" => heard_outcome(m, listen(t, deadline, eightbitdo::WINDOW, &mut |r| eightbitdo::parse_dinput(m, r)), now),
        "8bitdo-rx" => eightbitdo::query(t, deadline, now),
        "gamesir-nova" => gamesir::query_nova(t, deadline, now),
        "gamesir-cyclone" => heard_outcome(m, listen(t, deadline, gamesir::CYCLONE_WINDOW, &mut |r| gamesir::parse_cyclone(r)), now),
        "flydigi" => flydigi::query(t, deadline, now),
        "beitong" => beitong::query(t, deadline, now),
        _ => Outcome::Failed,
    }
}

#[cfg(test)]
pub(crate) mod testkit {
    use crate::allow::HidIdent;
    use crate::transport::fake::FakeHid;
    use crate::transport::OpenMode;
    use std::time::{Duration, Instant};

    pub fn ident(m: &super::Model) -> HidIdent {
        HidIdent { vid: m.vid, pid: m.pid, usage_page: m.page, usage: m.usages.first().copied().unwrap_or(1), interface: -1 }
    }
    /// A fake of this product's collection, opened as the platform would (read for listening; read/write for one the
    /// allow table names).
    pub fn fake(m: &super::Model) -> FakeHid {
        let mut f = FakeHid::new(ident(m));
        if f.mode == OpenMode::QueryOnly {
            f.mode = OpenMode::Read;
        }
        f
    }
    pub fn soon() -> Instant {
        Instant::now() + Duration::from_millis(500)
    }
    /// A report of `len` bytes: `id` first, then zeros, with `at` set.
    pub fn report(id: u8, len: usize, at: &[(usize, u8)]) -> Vec<u8> {
        let mut r = vec![0u8; len];
        r[0] = id;
        for &(i, v) in at {
            r[i] = v;
        }
        r
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::*;
    use super::*;
    use crate::model::{Percent, Steps};

    #[test]
    fn every_model_names_a_product_and_a_known_driver() {
        let mut seen = std::collections::HashSet::new();
        for m in all_models() {
            assert!(m.vid != 0 && m.pid != 0, "{}: a product id, never a vendor alone", m.name);
            assert!(m.page != 0, "{}: a usage page", m.name);
            assert!(driver(m.driver).is_some(), "{}: driver {}", m.name, m.driver);
            assert!(!m.name.is_empty() && !m.picture.is_empty());
            for u in m.usages.iter().copied().chain(if m.usages.is_empty() { Some(0xFFFF) } else { None }) {
                assert!(seen.insert((m.vid, m.pid, m.page, u)), "{} listed twice for one collection", m.name);
            }
        }
        // (No vendor alone: another product of a listed vendor matches nothing.)
        assert!(find(&HidIdent { vid: 0x054C, pid: 0x0001, usage_page: 1, usage: 5, interface: -1 }).is_none());
        assert!(find(&HidIdent { vid: 0x2DC8, pid: 0x9999, usage_page: 0xFF7A, usage: 1, interface: -1 }).is_none());
        // (The right product on another page or usage: not the reader's collection.)
        assert!(find(&HidIdent { vid: 0x054C, pid: 0x0CE6, usage_page: 0x0C, usage: 1, interface: -1 }).is_none());
        assert!(find(&HidIdent { vid: 0x054C, pid: 0x0CE6, usage_page: 1, usage: 2, interface: -1 }).is_none());
        assert_eq!(find(&HidIdent { vid: 0x054C, pid: 0x0CE6, usage_page: 1, usage: 5, interface: 3 }).map(|m| m.driver), Some("playstation"));
    }

    #[test]
    fn defaults_passive_on_queries_off() {
        for d in DRIVERS {
            assert_eq!(d.proven, Proven::PortedUntested, "{}: nothing is tested on hardware here", d.id);
            assert_eq!(d.on_by_default(), d.way == Way::Passive, "{}", d.id);
        }
        assert_eq!(query_families(), vec![Family::EightBitDo, Family::GameSir, Family::Flydigi, Family::Beitong]);
        for f in Family::ALL {
            assert_eq!(Family::parse(f.as_str()), Some(f));
        }
        assert_eq!(Family::parse("acme"), None);
        // (Every reader that sends has allow-listed bytes, and every allow entry belongs to such a reader's product.)
        for e in allow::ALLOWED {
            let m = all_models().find(|m| m.vid == e.device.vid && m.pid == e.device.pid && Some(m.page) == e.device.usage_page).expect("an allow entry for a listed product");
            assert_eq!(m.driver().way, Way::Query, "{}: a passive reader has no allow entry", m.name);
        }
    }

    #[test]
    fn a_query_reader_switched_off_touches_nothing() {
        for m in all_models().filter(|m| m.driver().way == Way::Query) {
            let mut f = fake(m);
            f.stream.push_back(vec![0; 64]);
            let out = read(&mut f, m, false, false, soon(), 9);
            assert_eq!(out, Outcome::Read(Reading::unknown(Note::QueryOff, Charging::Unknown, 9)), "{}", m.name);
            assert!(f.sent.is_empty() && f.reads == 0 && f.flushes == 0, "{}: nothing sent or read while off", m.name);
        }
    }

    #[test]
    fn listening_rules() {
        let m = &playstation::MODELS[0];
        // (Quiet pad, a receiver, a mode-bound pad.)
        let mut f = fake(m);
        assert_eq!(listen(&mut f, soon(), Duration::from_millis(50), &mut |_| Parsed::Skip), Heard::Quiet);
        f.stream.push_back(vec![7, 1, 2]);
        assert_eq!(listen(&mut f, soon(), Duration::from_millis(50), &mut |_| Parsed::Bad), Heard::OnlyOther);
        assert_eq!(heard_outcome(m, Heard::OnlyOther, 1), Outcome::Read(Reading::unknown(Note::NeedsQuery, Charging::Unknown, 1)), "PlayStation is mode-bound (Bluetooth)");
        let rx = &playstation::MODELS[2];
        assert_eq!(rx.link, Link::Receiver);
        assert_eq!(heard_outcome(&steam::MODELS[0], Heard::Quiet, 1), Outcome::Read(Reading::unknown(Note::NoPad, Charging::Unknown, 1)));
        assert_eq!(heard_outcome(&steam::MODELS[1], Heard::Quiet, 1), Outcome::NoAnswer, "a pad itself that says nothing: no answer");
        // (A past deadline: nothing read.)
        let mut f = fake(m);
        f.stream.push_back(vec![1]);
        let past = Instant::now() - Duration::from_millis(1);
        assert_eq!(listen(&mut f, past, Duration::from_secs(1), &mut |_| Parsed::Got(Level::Unknown, Charging::No)), Heard::Quiet);
        assert_eq!(f.reads, 0);
        // (The first report that tells wins; the zero report id is dropped before parsing.)
        let mut f = fake(m);
        f.stream.extend([vec![0, 9, 9], vec![0, 5, 50]]);
        let got = listen(&mut f, soon(), Duration::from_millis(100), &mut |r| if r[0] == 5 { Parsed::Got(Level::Exact(Percent::new(r[1] as i64).unwrap()), Charging::No) } else { Parsed::Skip });
        assert_eq!(got, Heard::Got(Level::Exact(Percent::new(50).unwrap()), Charging::No));
        let _ = Steps::new(1, 2);
    }

    #[test]
    fn ask_sends_only_allowed_bytes_and_takes_only_its_reply() {
        let m = &beitong::MODELS[0];
        let mut f = fake(m);
        f.stream.push_back(vec![2, 0x99]);
        f.replies.push_back(vec![vec![2, 0x33], vec![2, beitong::enc(0x15), beitong::enc(40)]]);
        let r = ask(&mut f, &[0x02, 0xAD], soon(), Duration::from_millis(100), &|r| r.len() >= 2 && r[1] == beitong::enc(0x15));
        assert_eq!(r.map(|r| r[2]), Ok(beitong::enc(40)));
        assert_eq!(f.flushes, 1, "the old report dropped before the request");
        assert_eq!(f.sent, vec![vec![0x02, 0xAD]]);
        // (One byte off: refused, nothing sent.)
        let mut f = fake(m);
        assert_eq!(ask(&mut f, &[0x02, 0xAE], soon(), Duration::from_millis(50), &|_| true), Err(TErr::Refused));
        assert_eq!(ask(&mut f, &[0x02, 0xAD, 0x00], soon(), Duration::from_millis(50), &|_| true), Err(TErr::Refused));
        assert!(f.sent.is_empty());
        // (The right bytes to another product: refused.)
        let mut other = crate::transport::fake::FakeHid::new(HidIdent { vid: 0x20BC, pid: 0x5129, usage_page: 0x00FF, usage: 3, interface: -1 });
        other.mode = crate::transport::OpenMode::ReadWrite;
        assert_eq!(ask(&mut other, &[0x02, 0xAD], soon(), Duration::from_millis(50), &|_| true), Err(TErr::Refused));
        assert!(other.sent.is_empty());
        // (No reply in time: a timeout, not a reading.)
        let mut f = fake(m);
        assert_eq!(ask(&mut f, &[0x02, 0xAD], soon(), Duration::from_millis(50), &|_| true), Err(TErr::Timeout));
    }

    #[test]
    fn payload_drops_only_a_zero_report_id() {
        assert_eq!(payload(&[0, 1, 2]), &[1, 2]);
        assert_eq!(payload(&[0x30, 1, 2]), &[0x30, 1, 2]);
        assert_eq!(payload(&[]), &[] as &[u8]);
    }
}
