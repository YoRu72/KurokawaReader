// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the Windows side of piece 5, the mice' and keyboards' own readers
// (mice/*.rs). Derived from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/drivers.h (PollContext: Find, Claim, Add) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9
// and its contributors, GPL-3.0-or-later.
// A collection a mice reader's table lists (vendor, product, page, usage, interface, report lengths, the product string
// where an id is shared) becomes that unit's entry; its other collections (a reply channel, HID++'s long reports) go
// with it. A receiver with paired devices: one card per device once its reader has found them (the slots kept for as
// long as the receiver stays plugged in — never a level); its cable and receiver of one mouse: one card, by
// mice::merge_pairs' rule or the same HID++ unit id. A family switched off is given no device; if such a unit has a
// battery field of its own, it is left to the generic reader rather than shown as «off».
// Handles: the request collection read/write only when allow.rs names it and the reader sends output reports; feature
// requests on a handle with no read or write access; listening on a shared read handle; never an exclusive open.
// UNVERIFIED here: compiled only on Windows (type-checked elsewhere); real devices decide.
// Copyright (C) 2026 Kurokawa contributors.
use super::{hid, hid_connection, rank, NoDevice};
use crate::identity::{self, Candidate};
use crate::mice::{self, Chans, Family, Model, Role, Via, Way};
use crate::model::{Connection, Device, Kind, Level, Source};
use crate::sched::Outcome;
use crate::transport::HidTransport;
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Instant;

#[derive(Clone)]
pub struct Unit {
    /// The unit's collections with their reader rows (a merged pair: the cable's first).
    pub colls: Vec<(hid::HidColl, &'static Model)>,
    /// The paired device this card is (a receiver's slot), None for the unit itself or a receiver not probed yet.
    pub slot: Option<u8>,
    /// The receiver's own key (the slots are kept under it).
    pub base: String,
}

/// What a reader learned of a card's device (its own name, kind, HID++ unit id): shown from the next enumeration.
#[derive(Clone, Debug, Default)]
pub struct Learned {
    pub name: Option<String>,
    pub kind: Option<Kind>,
    pub unit: Option<String>,
}

#[derive(Default)]
pub struct MiceState {
    units: Mutex<BTreeMap<String, Unit>>,
    slots: Mutex<BTreeMap<String, Vec<u8>>>,
    learned: Mutex<BTreeMap<String, Learned>>,
    ask: Mutex<Vec<Family>>,
    mute: Mutex<Vec<Family>>,
}

fn lock<T: Clone>(m: &Mutex<T>) -> T {
    m.lock().map(|g| g.clone()).unwrap_or_else(|e| e.into_inner().clone())
}

impl MiceState {
    pub fn set_prefs(&self, ask: &[String], mute: &[String]) {
        if let Ok(mut g) = self.ask.lock() {
            *g = ask.iter().filter_map(|s| Family::parse(s)).collect();
        }
        if let Ok(mut g) = self.mute.lock() {
            *g = mute.iter().filter_map(|s| Family::parse(s)).collect();
        }
    }

    /// The mice' and keyboards' cards among the collections, and the unit keys they claim (the generic reader leaves
    /// those alone).
    pub fn candidates(&self, all: &[hid::HidColl]) -> (Vec<Candidate>, Vec<String>) {
        let (ask, mute) = (lock(&self.ask), lock(&self.mute));
        let key_of = |c: &hid::HidColl| identity::hid_key(c.ident.vid, c.ident.pid, &c.serial, &c.container, &c.path);
        let mut by: BTreeMap<String, Vec<(hid::HidColl, &'static Model)>> = BTreeMap::new();
        for c in all {
            let Some(m) = mice::find(&c.ident, c.input_len, c.output_len, c.feature_len) else { continue };
            if !m.product_ok(&c.product) {
                continue;
            }
            by.entry(key_of(c)).or_default().push((c.clone(), m));
        }
        // (Units with a request collection; a family switched off whose unit has its own battery field: the generic
        //  reader's.)
        let mut units: Vec<(String, Vec<(hid::HidColl, &'static Model)>, &'static Model)> = Vec::new();
        for (k, cs) in by {
            let Some(primary) = cs.iter().map(|x| x.1).find(|m| m.role == Role::Main) else { continue };
            let on = cs.iter().any(|(_, m)| m.role == Role::Main && mice::is_on(m, &ask, &mute));
            if !on && all.iter().any(|c| key_of(c) == k && !c.battery.is_empty()) {
                continue;
            }
            units.push((k, cs, primary));
        }
        let primaries: Vec<&Model> = units.iter().map(|u| u.2).collect();
        let groups = mice::merge_pairs(&primaries);
        let mut claimed: Vec<String> = units.iter().map(|u| u.0.clone()).collect();
        claimed.sort();
        let slots = lock(&self.slots);
        let learned = lock(&self.learned);
        let mut cards: BTreeMap<String, Unit> = BTreeMap::new();
        for g in groups {
            let base = units[g[0]].0.clone();
            let mut colls = Vec::new();
            for &i in &g {
                colls.extend(units[i].1.iter().cloned());
            }
            let primary = units[g[0]].2;
            let known = slots.get(&base).filter(|s| !s.is_empty() && !primary.slots.is_empty());
            match known {
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
        // (One HID++ device through its receiver and on its own cable or Bluetooth: the same unit id — one card, the
        //  direct one.)
        let direct_units: Vec<String> = cards.iter().filter(|(_, u)| u.slot.is_none()).filter_map(|(k, _)| learned.get(k).and_then(|l| l.unit.clone())).collect();
        cards.retain(|k, u| u.slot.is_none() || !learned.get(k).and_then(|l| l.unit.as_ref()).map_or(false, |id| direct_units.contains(id)));
        let mut out = Vec::new();
        for (key, u) in &cards {
            let Some((c0, m)) = u.colls.iter().find(|(_, m)| m.role == Role::Main).cloned() else { continue };
            let l = learned.get(key).cloned().unwrap_or_default();
            let mut d = Device::new(key.clone(), Source::Vendor);
            d.vid = c0.ident.vid;
            d.pid = c0.ident.pid;
            d.container = c0.container.clone();
            d.serial = c0.serial.clone();
            d.kind = l.kind.unwrap_or(m.kind);
            d.name = l.name.unwrap_or_else(|| if m.product_name && !c0.product.trim().is_empty() { c0.product.trim().to_string() } else { m.name.to_string() });
            d.brand = m.driver().family.brand().to_string();
            d.connection = if m.via == Via::Receiver { Connection::Dongle } else { hid_connection(&c0.path) };
            d.driver = m.driver;
            out.push(Candidate { device: d, reading: None, offline: false });
        }
        // (Slots of receivers no longer here forgotten; so is what was learned of cards that are gone.)
        if let Ok(mut s) = self.slots.lock() {
            s.retain(|b, _| cards.values().any(|u| &u.base == b));
        }
        if let Ok(mut l) = self.learned.lock() {
            l.retain(|k, _| cards.contains_key(k) || cards.values().any(|u| &u.base == k));
        }
        if let Ok(mut g) = self.units.lock() {
            *g = cards;
        }
        (out, claimed)
    }

    pub fn query(&self, device: &Device, deadline: Instant, now: u64) -> Outcome {
        let Some(u) = self.units.lock().ok().and_then(|g| g.get(&device.key).cloned()) else { return Outcome::Failed };
        let (ask, mute) = (lock(&self.ask), lock(&self.mute));
        let mut mains: Vec<&(hid::HidColl, &'static Model)> = u.colls.iter().filter(|(_, m)| m.role == Role::Main).collect();
        // (PixArt's cable: its first vendor collection refuses feature reports — tried last to first, as the original.)
        if mains.first().map_or(false, |(_, m)| m.driver == "mk-incott") {
            mains.reverse();
        }
        let reply = u.colls.iter().find(|(_, m)| m.role == Role::Reply).map(|x| x.0.clone());
        let long = u.colls.iter().find(|(_, m)| m.role == Role::Long).map(|x| x.0.clone());
        let mut best = Outcome::Failed;
        for (c, m) in mains {
            let on = mice::is_on(m, &ask, &mute);
            let a = if !on {
                mice::read(&mut Chans::one(&mut NoDevice(c.ident.clone())), m, u.slot, false, deadline, now)
            } else {
                let opened = if m.driver().way == Way::Passive {
                    hid::WinHid::open_listen(c, false)
                } else if mice::sends_output(m.driver) {
                    hid::WinHid::open_listen(c, true)
                } else {
                    hid::WinHid::open_feature(c, true).map(|mut t| {
                        t.set_feature_len(usize::from(m.feat_len));
                        t
                    })
                };
                let Ok(mut main) = opened else {
                    if Instant::now() >= deadline {
                        break;
                    }
                    continue;
                };
                // (The W1's pushed status comes on its own collection's input reports: a second, listening handle.)
                let rx_coll = if m.driver == "mk-incott" { Some(c.clone()) } else { reply.clone() };
                let mut rx = rx_coll.and_then(|r| hid::WinHid::open_listen(&r, false).ok());
                let mut lg = long.as_ref().and_then(|l| hid::WinHid::open_listen(l, true).ok());
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
                    return out;
                }
            }
            if rank(&out) > rank(&best) {
                best = out;
            }
            if Instant::now() >= deadline {
                break;
            }
        }
        best
    }
}
