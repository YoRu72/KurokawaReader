// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery), piece P1: the HID side of a platform, over any way of opening a
// collection (a `Port`) — the controllers', mice', keyboards' and headsets' readers and the generic one, exactly as
// win/mod.rs and win/mice.rs drive them on Windows, so a reader written once works unchanged on Linux's hidraw
// (linux/hidraw.rs) and is tested here with fakes.
// Derived from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/devices.cpp (PollAllDevices' order), src/drivers/drivers.h (PollContext: Find, Claim, Add) and
// src/drivers/generic.cpp (PollGenericHid) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its
// contributors, GPL-3.0-or-later.
// The rules are win/mod.rs's and win/mice.rs's (that file's header lists the changes from the original); here they are
// written over the `Port` trait instead of Windows' collections. (Windows keeps its own copy for now: a later piece may
// move it onto this one.) A port the user cannot open says so (Note::NoAccess) instead of «no answer».
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::allow::HidIdent;
use crate::identity::{self, Candidate};
use crate::kind;
use crate::mice::{self, Chans, Family as MkFamily, Model as MkModel, Role, Via};
use crate::model::{Charging, Connection, Device, Kind, Level, Note, Percent, Reading, Source};
use crate::pads::{self, Family, Way};
use crate::registry::{self, Claim, Collection};
use crate::sched::Outcome;
use crate::transport::{HidTransport, TErr};
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Instant;

/// One HID collection a platform found, and how to open it.
pub trait Port: Clone + Send + Sync + 'static {
    type T: HidTransport + 'static;
    fn ident(&self) -> &HidIdent;
    fn product(&self) -> &str;
    fn serial(&self) -> &str;
    fn container(&self) -> &str;
    /// A path standing for the interface in keys (Windows' «…&mi_02&col01…» form: identity.rs reads «&mi_»).
    fn key_path(&self) -> &str;
    fn input_len(&self) -> usize;
    fn output_len(&self) -> usize;
    fn feature_len(&self) -> usize;
    /// It declares a battery field (the generic reader's).
    fn has_battery(&self) -> bool;
    fn connection(&self) -> Connection;
    /// The user may open it (Linux: the node's permissions); false → the card says how to allow it.
    fn accessible(&self) -> bool {
        true
    }
    /// Opened to listen (and to send an output report allow.rs lists, when `may_send`).
    fn open_listen(&self, may_send: bool) -> Result<Self::T, TErr>;
    /// Opened for feature reports (a feature report allow.rs lists may be set when `may_send`); `feature_len`: the
    /// length a request is sent with when the reader's model names one (0: the collection's).
    fn open_feature(&self, may_send: bool, feature_len: usize) -> Result<Self::T, TErr>;
    /// The generic reader on this collection.
    fn read_battery(&self, deadline: Instant) -> Result<Percent, TErr>;
}

fn key_of<P: Port>(c: &P) -> String {
    identity::hid_key(c.ident().vid, c.ident().pid, c.serial(), c.container(), c.key_path())
}

/// Which outcome says more, when no reader of a device found its level.
pub fn rank(o: &Outcome) -> u8 {
    match o {
        Outcome::Read(r) if r.charging != Charging::Unknown => 4,
        Outcome::Read(r) if r.note != Note::QueryOff => 3,
        Outcome::Read(_) => 2,
        Outcome::Asleep => 2,
        Outcome::NoAnswer => 1,
        Outcome::Failed => 0,
    }
}

/// A reader switched off is given no device at all.
pub struct NoDevice(pub HidIdent);
impl HidTransport for NoDevice {
    fn ident(&self) -> &HidIdent {
        &self.0
    }
    fn mode(&self) -> crate::transport::OpenMode {
        crate::transport::OpenMode::QueryOnly
    }
    fn get_feature(&mut self, _: u8, _: usize, _: Instant) -> Result<Vec<u8>, TErr> {
        Err(TErr::Refused)
    }
    fn get_input(&mut self, _: u8, _: usize, _: Instant) -> Result<Vec<u8>, TErr> {
        Err(TErr::Refused)
    }
    fn send_allowed(&mut self, _: &crate::allow::AllowedWrite, _: Instant) -> Result<(), TErr> {
        Err(TErr::Refused)
    }
}

fn no_access(now: u64) -> Outcome {
    Outcome::Read(Reading::unknown(Note::NoAccess, Charging::Unknown, now))
}

type PadMap<P> = BTreeMap<String, Vec<(P, &'static pads::Model)>>;

/// The HID readers' state of one platform: the last enumeration's collections per card, and the switches.
pub struct HidState<P: Port> {
    generic: Mutex<BTreeMap<String, Vec<P>>>,
    pads: Mutex<PadMap<P>>,
    pad_on: Mutex<Vec<Family>>,
    units: Mutex<BTreeMap<String, Unit<P>>>,
    kept: Mutex<BTreeMap<String, (u64, Outcome)>>,
    slots: Mutex<BTreeMap<String, Vec<u8>>>,
    learned: Mutex<BTreeMap<String, Learned>>,
    ask: Mutex<Vec<MkFamily>>,
    mute: Mutex<Vec<MkFamily>>,
}

impl<P: Port> Default for HidState<P> {
    fn default() -> Self {
        HidState { generic: Mutex::default(), pads: Mutex::default(), pad_on: Mutex::default(), units: Mutex::default(), kept: Mutex::default(), slots: Mutex::default(), learned: Mutex::default(), ask: Mutex::default(), mute: Mutex::default() }
    }
}

#[derive(Clone)]
struct Unit<P: Port> {
    colls: Vec<(P, &'static MkModel)>,
    slot: Option<u8>,
    base: String,
}

#[derive(Clone, Debug, Default)]
struct Learned {
    name: Option<String>,
    kind: Option<Kind>,
    unit: Option<String>,
}

fn lock<T: Clone>(m: &Mutex<T>) -> T {
    m.lock().map(|g| g.clone()).unwrap_or_else(|e| e.into_inner().clone())
}

impl<P: Port> HidState<P> {
    pub fn set_prefs(&self, pad_queries: &[String], mk_ask: &[String], mk_mute: &[String]) {
        if let Ok(mut g) = self.pad_on.lock() {
            *g = pad_queries.iter().filter_map(|s| Family::parse(s)).collect();
        }
        if let Ok(mut g) = self.ask.lock() {
            *g = mk_ask.iter().filter_map(|s| MkFamily::parse(s)).collect();
        }
        if let Ok(mut g) = self.mute.lock() {
            *g = mk_mute.iter().filter_map(|s| MkFamily::parse(s)).collect();
        }
    }

    /// Every card the HID readers make of `all`: controllers, mice / keyboards / headsets, then the generic reader's.
    pub fn candidates(&self, all: &[P]) -> Vec<Candidate> {
        let (pad_list, pad_map) = pad_candidates(all);
        let pad_keys: Vec<String> = pad_map.keys().cloned().collect();
        let (mice_list, mice_keys) = self.mice_candidates(all);
        let (generic, mut by) = hid_candidates(all);
        by.retain(|k, _| !pad_keys.iter().any(|p| p == k || p.starts_with(&format!("{}:i:", k))) && !mice_keys.contains(k));
        let mut out = identity::drop_claimed(identity::drop_claimed(generic, &pad_keys), &mice_keys);
        out.extend(pad_list);
        out.extend(mice_list);
        if let Ok(mut m) = self.generic.lock() {
            *m = by;
        }
        if let Ok(mut m) = self.pads.lock() {
            *m = pad_map;
        }
        out
    }

    pub fn query(&self, device: &Device, deadline: Instant, now: u64) -> Outcome {
        match device.source {
            Source::Pad => self.query_pad(device, deadline, now),
            Source::Vendor => self.query_mice(device, deadline, now),
            _ => self.query_generic(device, deadline, now),
        }
    }

    fn query_generic(&self, device: &Device, deadline: Instant, now: u64) -> Outcome {
        let colls = self.generic.lock().map(|m| m.get(&device.key).cloned().unwrap_or_default()).unwrap_or_default();
        if !colls.is_empty() && colls.iter().all(|c| !c.accessible()) {
            return no_access(now);
        }
        for c in colls.iter().filter(|c| c.accessible()) {
            match c.read_battery(deadline) {
                Ok(p) => return Outcome::Read(Reading::new(Level::Exact(p), Charging::Unknown, now)),
                Err(TErr::Timeout) => return Outcome::NoAnswer,
                Err(_) => continue,
            }
        }
        Outcome::Failed
    }

    fn query_pad(&self, device: &Device, deadline: Instant, now: u64) -> Outcome {
        let list = self.pads.lock().map(|m| m.get(&device.key).cloned().unwrap_or_default()).unwrap_or_default();
        let on = lock(&self.pad_on);
        let is_on = |m: &pads::Model| on.contains(&m.driver().family);
        let mut order: Vec<&(P, &'static pads::Model)> = list.iter().collect();
        order.sort_by_key(|(_, m)| match (m.driver().way, is_on(m)) {
            (Way::Query, true) => 0,
            (Way::Passive, _) => 1,
            (Way::Query, false) => 2,
        });
        let mut best = Outcome::Failed;
        for (c, m) in order {
            let send = m.driver().way == Way::Query && is_on(m);
            let out = if m.driver().way == Way::Query && !send {
                pads::read(&mut NoDevice(c.ident().clone()), m, false, false, deadline, now)
            } else if !c.accessible() {
                no_access(now)
            } else {
                match c.open_listen(send) {
                    Ok(mut t) => pads::read(&mut t, m, c.connection() == Connection::Bluetooth, send, deadline, now),
                    Err(_) => Outcome::Failed,
                }
            };
            if let Outcome::Read(r) = out {
                if r.level != Level::Unknown {
                    return out;
                }
            }
            if rank(&out) > rank(&best) || matches!(&out, Outcome::Read(r) if r.note == Note::NoAccess) {
                best = out;
            }
            if Instant::now() >= deadline {
                break;
            }
        }
        best
    }

    fn mice_candidates(&self, all: &[P]) -> (Vec<Candidate>, Vec<String>) {
        let (ask, mute) = (lock(&self.ask), lock(&self.mute));
        let mut by: BTreeMap<String, Vec<(P, &'static MkModel)>> = BTreeMap::new();
        for c in all {
            let Some(m) = mice::find(c.ident(), c.input_len(), c.output_len(), c.feature_len()) else { continue };
            if !m.product_ok(c.product()) {
                continue;
            }
            by.entry(key_of(c)).or_default().push((c.clone(), m));
        }
        let mut units: Vec<(String, Vec<(P, &'static MkModel)>, &'static MkModel)> = Vec::new();
        for (k, cs) in by {
            let Some(primary) = cs.iter().map(|x| x.1).find(|m| m.role == Role::Main) else { continue };
            let on = cs.iter().any(|(_, m)| m.role == Role::Main && mice::is_on(m, &ask, &mute));
            if !on && all.iter().any(|c| key_of(c) == k && c.has_battery()) {
                continue;
            }
            units.push((k, cs, primary));
        }
        let primaries: Vec<&MkModel> = units.iter().map(|u| u.2).collect();
        let groups = mice::merge_pairs(&primaries);
        let mut claimed: Vec<String> = units.iter().map(|u| u.0.clone()).collect();
        claimed.sort();
        let slots = lock(&self.slots);
        let learned = lock(&self.learned);
        let mut cards: BTreeMap<String, Unit<P>> = BTreeMap::new();
        for g in groups {
            let base = units[g[0]].0.clone();
            let mut colls = Vec::new();
            for &i in &g {
                colls.extend(units[i].1.iter().cloned());
            }
            let primary = units[g[0]].2;
            match slots.get(&base).filter(|s| !s.is_empty() && !primary.slots.is_empty()) {
                Some(list) => {
                    for &s in list {
                        cards.insert(mice::slot_key(&base, s), Unit { colls: colls.clone(), slot: Some(s), base: base.clone() });
                    }
                }
                None => {
                    cards.insert(base.clone(), Unit { colls, slot: None, base: base.clone() });
                }
            }
        }
        let direct_units: Vec<String> = cards.iter().filter(|(_, u)| u.slot.is_none()).filter_map(|(k, _)| learned.get(k).and_then(|l| l.unit.clone())).collect();
        cards.retain(|k, u| u.slot.is_none() || !learned.get(k).and_then(|l| l.unit.as_ref()).map_or(false, |id| direct_units.contains(id)));
        let mut out = Vec::new();
        for (key, u) in &cards {
            let Some((c0, m)) = u.colls.iter().find(|(_, m)| m.role == Role::Main).cloned() else { continue };
            let l = learned.get(key).cloned().unwrap_or_default();
            let mut d = Device::new(key.clone(), Source::Vendor);
            d.vid = c0.ident().vid;
            d.pid = c0.ident().pid;
            d.container = c0.container().to_string();
            d.serial = c0.serial().to_string();
            d.kind = l.kind.unwrap_or(m.kind);
            d.name = l.name.unwrap_or_else(|| if m.product_name && !c0.product().trim().is_empty() { c0.product().trim().to_string() } else { m.name.to_string() });
            d.brand = m.driver().family.brand().to_string();
            d.connection = if m.via == Via::Receiver { Connection::Dongle } else { c0.connection() };
            d.driver = m.driver;
            out.push(Candidate { device: d, reading: None, offline: false });
        }
        if let Ok(mut s) = self.slots.lock() {
            s.retain(|b, _| cards.values().any(|u| &u.base == b));
        }
        if let Ok(mut l) = self.learned.lock() {
            l.retain(|k, _| cards.contains_key(k) || cards.values().any(|u| &u.base == k));
        }
        if let Ok(mut k) = self.kept.lock() {
            k.retain(|key, _| cards.contains_key(key));
        }
        if let Ok(mut g) = self.units.lock() {
            *g = cards;
        }
        (out, claimed)
    }

    fn query_mice(&self, device: &Device, deadline: Instant, now: u64) -> Outcome {
        let Some(u) = self.units.lock().ok().and_then(|g| g.get(&device.key).cloned()) else { return Outcome::Failed };
        let (ask, mute) = (lock(&self.ask), lock(&self.mute));
        let mut mains: Vec<&(P, &'static MkModel)> = u.colls.iter().filter(|(_, m)| m.role == Role::Main).collect();
        if mains.first().map_or(false, |(_, m)| m.driver == "mk-incott") {
            mains.reverse();
        }
        let reply = u.colls.iter().find(|(_, m)| m.role == Role::Reply).map(|x| x.0.clone());
        let long = u.colls.iter().find(|(_, m)| m.role == Role::Long).map(|x| x.0.clone());
        if let Some((_, m)) = mains.first() {
            let kept = self.kept.lock().ok().and_then(|g| g.get(&device.key).copied());
            if mice::is_on(m, &ask, &mute) {
                if let Some(o) = mice::within_gap(m, kept, now) {
                    return o;
                }
            }
        }
        let mut best = Outcome::Failed;
        for (c, m) in mains {
            let on = mice::is_on(m, &ask, &mute);
            if on {
                if let Some(o) = crate::heads::product_says(m, c.product(), now) {
                    return o;
                }
            }
            let a = if !on {
                mice::read(&mut Chans::one(&mut NoDevice(c.ident().clone())), m, u.slot, false, deadline, now)
            } else if !c.accessible() {
                no_access(now).into()
            } else {
                let opened = if m.driver().way == Way::Passive {
                    c.open_listen(false)
                } else if mice::sends_output(m.driver) {
                    c.open_listen(true)
                } else {
                    c.open_feature(true, usize::from(m.feat_len))
                };
                let Ok(mut main) = opened else {
                    if Instant::now() >= deadline {
                        break;
                    }
                    continue;
                };
                let rx_coll = if m.driver == "mk-incott" || m.driver == "hs-jbl" { Some(c.clone()) } else { reply.clone() };
                let mut rx = rx_coll.and_then(|r| r.open_listen(false).ok());
                let mut lg = long.as_ref().and_then(|l| l.open_listen(true).ok());
                let mut ch = Chans { main: &mut main, reply: rx.as_mut().map(|t| t as &mut dyn HidTransport), long: lg.as_mut().map(|t| t as &mut dyn HidTransport) };
                mice::read(&mut ch, m, u.slot, true, deadline, now)
            };
            if u.slot.is_none() && !m.slots.is_empty() {
                if let Some(list) = &a.slots {
                    if let Ok(mut s) = self.slots.lock() {
                        s.insert(u.base.clone(), list.clone());
                    }
                }
            }
            if a.name.is_some() || a.kind.is_some() || a.unit.is_some() {
                if let Ok(mut l) = self.learned.lock() {
                    let e = l.entry(device.key.clone()).or_default();
                    if a.name.is_some() {
                        e.name = a.name.clone();
                    }
                    if a.kind.is_some() {
                        e.kind = a.kind;
                    }
                    if a.unit.is_some() {
                        e.unit = a.unit.clone();
                    }
                }
            }
            let out = a.out;
            if let Outcome::Read(r) = &out {
                if r.level != Level::Unknown {
                    if m.gap_s > 0 {
                        if let Ok(mut g) = self.kept.lock() {
                            g.insert(device.key.clone(), (now, out));
                        }
                    }
                    return out;
                }
            }
            if rank(&out) > rank(&best) || matches!(&out, Outcome::Read(r) if r.note == Note::NoAccess) {
                best = out;
            }
            if Instant::now() >= deadline {
                break;
            }
        }
        best
    }
}

/// The controllers among the collections: one entry per pad key.
fn pad_candidates<P: Port>(all: &[P]) -> (Vec<Candidate>, PadMap<P>) {
    let mut by: PadMap<P> = BTreeMap::new();
    for c in all {
        let Some(m) = pads::find(c.ident()) else { continue };
        if !pads::fits(m, c.input_len(), c.output_len()) {
            continue;
        }
        let key = identity::pad_key(c.ident().vid, c.ident().pid, c.serial(), c.container(), c.key_path(), m.per_interface);
        by.entry(key).or_default().push((c.clone(), m));
    }
    let mut out = Vec::new();
    for (key, cs) in &by {
        let (c0, m) = (&cs[0].0, cs[0].1);
        let mut d = Device::new(key.clone(), Source::Pad);
        d.vid = c0.ident().vid;
        d.pid = c0.ident().pid;
        d.container = c0.container().to_string();
        d.serial = c0.serial().to_string();
        d.kind = Kind::Controller;
        d.connection = if m.link == pads::Link::Receiver { Connection::Dongle } else { c0.connection() };
        d.name = if m.driver == "nintendo" && !c0.product().is_empty() { c0.product().to_string() } else { m.name.to_string() };
        d.brand = m.driver().family.brand().to_string();
        d.driver = m.driver;
        d.picture = m.picture;
        out.push(Candidate { device: d, reading: None, offline: false });
    }
    (out, by)
}

fn hid_candidates<P: Port>(all: &[P]) -> (Vec<Candidate>, BTreeMap<String, Vec<P>>) {
    let keyed: Vec<(String, &P)> = all.iter().map(|c| (key_of(c), c)).collect();
    let regs: Vec<Collection> = keyed.iter().map(|(k, c)| Collection { ident: c.ident().clone(), battery_field: c.has_battery(), key: k.clone() }).collect();
    let mut by: BTreeMap<String, Vec<P>> = BTreeMap::new();
    for (i, (k, c)) in keyed.iter().enumerate() {
        if registry::classify(&regs, &regs[i], &[]) == Claim::Generic {
            by.entry(k.clone()).or_default().push((*c).clone());
        }
    }
    let mut out = Vec::new();
    for (key, cs) in &by {
        let c0 = &cs[0];
        let usages: Vec<(u16, u16)> = keyed.iter().filter(|(k, _)| k == key).map(|(_, c)| (c.ident().usage_page, c.ident().usage)).collect();
        let name = keyed.iter().filter(|(k, _)| k == key).map(|(_, c)| c.product().to_string()).find(|p| !p.is_empty()).unwrap_or_default();
        let mut d = Device::new(key.clone(), Source::HidGeneric);
        d.vid = c0.ident().vid;
        d.pid = c0.ident().pid;
        d.container = c0.container().to_string();
        d.serial = c0.serial().to_string();
        d.connection = c0.connection();
        d.kind = kind::from_collections(&usages);
        if d.kind == Kind::Other {
            d.kind = kind::from_ble_ids(d.vid, d.pid);
        }
        if d.kind == Kind::Other {
            d.kind = kind::guess(&name);
        }
        d.brand = kind::brand_of(d.vid, &name, d.kind).to_string();
        d.name = name;
        out.push(Candidate { device: d, reading: None, offline: false });
    }
    (out, by)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::fake::FakeHid;
    use std::time::Duration;

    #[derive(Clone)]
    struct FakePort {
        id: HidIdent,
        product: String,
        container: String,
        lens: (usize, usize, usize),
        battery: bool,
        ok: bool,
        level: Option<u8>,
        stream: Vec<Vec<u8>>,
    }
    impl Port for FakePort {
        type T = FakeHid;
        fn ident(&self) -> &HidIdent {
            &self.id
        }
        fn product(&self) -> &str {
            &self.product
        }
        fn serial(&self) -> &str {
            ""
        }
        fn container(&self) -> &str {
            &self.container
        }
        fn key_path(&self) -> &str {
            &self.container
        }
        fn input_len(&self) -> usize {
            self.lens.0
        }
        fn output_len(&self) -> usize {
            self.lens.1
        }
        fn feature_len(&self) -> usize {
            self.lens.2
        }
        fn has_battery(&self) -> bool {
            self.battery
        }
        fn connection(&self) -> Connection {
            Connection::Usb
        }
        fn accessible(&self) -> bool {
            self.ok
        }
        fn open_listen(&self, _may_send: bool) -> Result<FakeHid, TErr> {
            let mut f = FakeHid::new(self.id.clone());
            f.mode = crate::transport::OpenMode::Read;
            f.stream = self.stream.iter().cloned().collect();
            Ok(f)
        }
        fn open_feature(&self, _may_send: bool, _n: usize) -> Result<FakeHid, TErr> {
            Ok(FakeHid::new(self.id.clone()))
        }
        fn read_battery(&self, deadline: Instant) -> Result<Percent, TErr> {
            crate::transport::left(deadline)?;
            self.level.and_then(|l| Percent::new(l as i64)).ok_or(TErr::Failed("none".into()))
        }
    }
    fn port(vid: u16, pid: u16, page: u16, usage: u16, battery: bool, container: &str) -> FakePort {
        FakePort { id: HidIdent { vid, pid, usage_page: page, usage, interface: -1 }, product: "Made Up".into(), container: container.into(), lens: (64, 64, 0), battery, ok: true, level: Some(42), stream: Vec::new() }
    }

    #[test]
    fn cards_by_reader_and_the_generic_one() {
        let st: HidState<FakePort> = HidState::default();
        let ds = port(0x054C, 0x0CE6, 0x01, 0x05, false, "usb-1");
        let gen = port(0x1111, 0x2222, 0x0C, 0x01, true, "usb-2");
        let none = port(0x1111, 0x3333, 0x01, 0x02, false, "usb-3");
        let cands = st.candidates(&[ds, gen, none]);
        assert_eq!(cands.len(), 2, "{:?}", cands.iter().map(|c| &c.device.key).collect::<Vec<_>>());
        let pad = cands.iter().find(|c| c.device.source == Source::Pad).unwrap();
        assert_eq!((pad.device.driver, pad.device.kind), ("playstation", Kind::Controller));
        let g = cands.iter().find(|c| c.device.source == Source::HidGeneric).unwrap();
        let far = Instant::now() + Duration::from_secs(2);
        assert_eq!(st.query(&g.device, far, 7), Outcome::Read(Reading::new(Level::Exact(Percent::new(42).unwrap()), Charging::Unknown, 7)));
    }

    #[test]
    fn a_node_the_user_cannot_open_says_so() {
        let st: HidState<FakePort> = HidState::default();
        let mut gen = port(0x1111, 0x2222, 0x0C, 0x01, true, "usb-2");
        gen.ok = false;
        let mut ds = port(0x054C, 0x0CE6, 0x01, 0x05, false, "usb-1");
        ds.ok = false;
        let cands = st.candidates(&[gen, ds]);
        let far = Instant::now() + Duration::from_secs(2);
        for c in &cands {
            match st.query(&c.device, far, 9) {
                Outcome::Read(r) => assert_eq!(r.note, Note::NoAccess, "{}", c.device.key),
                o => panic!("{:?}", o),
            }
        }
        assert_eq!(cands.len(), 2);
    }

    #[test]
    fn a_deadline_passed_is_no_answer() {
        let st: HidState<FakePort> = HidState::default();
        let cands = st.candidates(&[port(0x1111, 0x2222, 0x0C, 0x01, true, "usb-2")]);
        assert_eq!(st.query(&cands[0].device, Instant::now() - Duration::from_millis(1), 1), Outcome::NoAnswer);
        assert_eq!(rank(&Outcome::NoAnswer), 1);
    }
}
