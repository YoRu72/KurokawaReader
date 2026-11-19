// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery), piece P1: the Mac platform — what runner.rs asks of a computer.
// Written for Tools (the original has no Mac side). What it reads, std only, through the Mac's own programs at their
// fixed places with fixed arguments and a deadline (sysprog.rs): the IORegistry's BatteryPercent entries (`ioreg`:
// Apple's Magic devices, and any device whose driver publishes a level) and the Bluetooth report (`system_profiler
// SPBluetoothDataType -json`, macOS 12 and later: each paired device's level, AirPods' left, right and case). Both
// readings are the system's (Source::System): nothing is sent to a device.
// Not on a Mac yet, and said so on the page: the family readers that talk to a device's raw HID reports (controllers,
// mice', keyboards' and headsets' own protocols) — they need IOKit's HID manager, run loops and the Input Monitoring
// permission, which this std-only crate does not declare by hand yet; connecting Bluetooth devices (the page opens the
// system's Bluetooth settings instead).
// UNVERIFIED here: compiled only on macOS (by CI); the parsers are unit-tested everywhere (macparse.rs).
// Copyright (C) 2026 Kurokawa contributors.
use crate::identity::Candidate;
use crate::kind;
use crate::macparse::{self, IoDev, SpDev};
use crate::model::{Charging, Connection, Device, Kind, Level, Part, PartName, Percent, Reading, Source};
use crate::runner::Platform;
use crate::sched::Outcome;
use std::time::{Duration, Instant};

/// IORegistry entries as cards (keyed by address, else serial, else vendor/product/name).
pub fn io_candidates(list: &[IoDev], now: u64) -> Vec<Candidate> {
    list.iter()
        .map(|d| {
            let key = if !d.addr.is_empty() {
                crate::identity::bt_key(&d.addr)
            } else if !d.serial.is_empty() {
                format!("mac:{:04X}:{:04X}:s:{}", d.vid, d.pid, d.serial)
            } else {
                format!("mac:{:04X}:{:04X}:{}", d.vid, d.pid, crate::identity::digest(&d.product))
            };
            let mut dev = Device::new(key, Source::System);
            dev.vid = d.vid;
            dev.pid = d.pid;
            dev.serial = d.serial.clone();
            dev.container = d.addr.clone();
            dev.connection = if d.bluetooth || !d.addr.is_empty() { Connection::Bluetooth } else { Connection::Unknown };
            dev.kind = kind::from_collections(&[(d.usage_page, d.usage)]);
            if dev.kind == Kind::Other {
                dev.kind = kind::guess(&d.product);
            }
            dev.brand = kind::brand_of(d.vid, &d.product, dev.kind).to_string();
            dev.name = d.product.clone();
            let level = Percent::new(d.percent as i64).map_or(Level::Unknown, Level::Exact);
            Candidate { device: dev, reading: Some(Reading::new(level, Charging::Unknown, now)), offline: false }
        })
        .collect()
}

/// The Bluetooth report's devices as cards: a level for a connected device (its parts for earbuds), «not connected»
/// for one paired but away; a device with no level and not connected is left out (nothing to tell).
pub fn sp_candidates(list: &[SpDev], now: u64) -> Vec<Candidate> {
    let mut out = Vec::new();
    for s in list {
        if s.addr.is_empty() {
            continue;
        }
        let has_level = s.main.is_some() || s.left.is_some() || s.right.is_some();
        if !has_level && !s.connected {
            continue;
        }
        let mut d = Device::new(crate::identity::bt_key(&s.addr), Source::System);
        d.container = s.addr.clone();
        d.vid = s.vid;
        d.pid = s.pid;
        d.connection = Connection::Bluetooth;
        d.kind = s.kind.unwrap_or_else(|| kind::guess(&s.name));
        if d.kind == Kind::Headset && (s.left.is_some() || s.right.is_some()) {
            d.kind = Kind::Earbuds;
        }
        d.brand = kind::brand_of(s.vid, &s.name, d.kind).to_string();
        d.name = s.name.clone();
        let exact = |p: Option<u8>| p.and_then(|p| Percent::new(p as i64)).map_or(Level::Unknown, Level::Exact);
        let reading = if s.left.is_some() || s.right.is_some() {
            let part = |name, p: Option<u8>, in_use| p.map(|_| Part { name, level: exact(p), charging: Charging::Unknown, in_use });
            Reading::with_parts([part(PartName::Left, s.left, true), part(PartName::Right, s.right, true), part(PartName::Case, s.case, false)], now)
        } else {
            Reading::new(exact(s.main), Charging::Unknown, now)
        };
        out.push(Candidate { device: d, reading: s.connected.then_some(reading), offline: !s.connected });
    }
    out
}

#[derive(Default)]
pub struct MacPlatform {}

impl MacPlatform {
    pub fn new() -> MacPlatform {
        MacPlatform {}
    }
}

fn run(places: &[&str], args: &'static [&'static str], ms: u64) -> Option<String> {
    let p = crate::sysprog::find(places)?;
    crate::sysprog::run(&p, args, Instant::now() + Duration::from_millis(ms), 4 << 20).ok().map(|r| r.out)
}

impl Platform for MacPlatform {
    fn enumerate(&self, now: u64) -> Vec<Candidate> {
        // (The two programs side by side: system_profiler takes a second or more.)
        let sp = std::thread::Builder::new().name("kt-battery-sp".into()).spawn(|| run(macparse::SYSTEM_PROFILER, &["SPBluetoothDataType", "-json"], 4_000));
        let io = run(macparse::IOREG, &["-r", "-l", "-k", "BatteryPercent"], 2_500).map(|t| macparse::ioreg(&t)).unwrap_or_default();
        let sp = sp.ok().and_then(|h| h.join().ok()).flatten().map(|t| macparse::system_profiler(&t)).unwrap_or_default();
        let mut out = io_candidates(&io, now);
        out.extend(sp_candidates(&sp, now));
        out
    }

    fn query(&self, _device: &Device, _deadline: Instant, _now: u64) -> Outcome {
        // (Nothing here is asked: every reading comes with the enumeration.)
        Outcome::Failed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cards_from_both_reports_meet_by_address() {
        let io = IoDev { product: "Made Up Keyboard".into(), vid: 76, pid: 615, percent: 67, addr: "AA:BB:CC:DD:EE:0A".into(), serial: String::new(), usage_page: 1, usage: 6, bluetooth: true };
        let a = &io_candidates(&[io], 1)[0];
        assert_eq!((a.device.key.as_str(), a.device.kind, a.device.container.as_str()), ("bt:AA:BB:CC:DD:EE:0A", Kind::Keyboard, "AA:BB:CC:DD:EE:0A"));
        let sp = SpDev { name: "Made Up Keyboard".into(), addr: "AA:BB:CC:DD:EE:0A".into(), connected: true, main: Some(66), ..Default::default() };
        let b = sp_candidates(&[sp], 1);
        let merged = crate::identity::merge(vec![a.clone(), b[0].clone()], &[]);
        assert_eq!(merged.len(), 1, "one card per device");
    }

    #[test]
    fn earbuds_parts_and_away_devices() {
        let buds = SpDev { name: "Test Buds".into(), addr: "AA:BB:CC:DD:EE:01".into(), connected: true, kind: Some(Kind::Headset), left: Some(80), right: Some(75), case: Some(40), ..Default::default() };
        let away = SpDev { name: "Test Pad".into(), addr: "AA:BB:CC:DD:EE:03".into(), connected: false, kind: Some(Kind::Controller), ..Default::default() };
        let silent = SpDev { name: "No Level".into(), addr: "AA:BB:CC:DD:EE:04".into(), connected: false, ..Default::default() };
        let c = sp_candidates(&[buds, away, silent], 1);
        assert_eq!(c.len(), 1, "an away device with no level is not shown");
        assert_eq!(c[0].device.kind, Kind::Earbuds);
        assert_eq!(c[0].reading.unwrap().level, Level::Exact(Percent::new(75).unwrap()), "the lowest bud in use, never the case");
        let away2 = SpDev { name: "Test Mouse".into(), addr: "AA:BB:CC:DD:EE:05".into(), connected: false, main: Some(30), ..Default::default() };
        let c2 = sp_candidates(&[away2], 1);
        assert!(c2[0].offline && c2[0].reading.is_none(), "an old level is never shown as current");
    }
}
