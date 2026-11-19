// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery), piece P1: the Linux platform — what runner.rs asks of a computer.
// Derived from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/linux/devices_linux.cpp (PollAllDevices) and src/linux/hid_linux.cpp (EnumHid) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later.
// What it reads, in order:
// 1. the kernel's own batteries of peripherals (/sys/class/power_supply, scope Device: hid-*, playstation, sony,
//    nintendo, hidpp, xpadneo, wacom…) — a file read, nothing sent; the HID device such a battery belongs to (and a
//    receiver above it) is then left alone by Tools' own readers, so Tools never talks over the kernel's driver;
// 2. the raw HID nodes (sysfs.rs, hiddesc.rs) through the readers of every family, unchanged (hidplat.rs) — each node
//    opened only by the reader that needs it, read-only unless allow.rs names it (linux/hidraw.rs); a node this user
//    may not open is shown with the steps that allow it (a udev rule for the readers' devices only, udev.rs);
// 3. Bluetooth devices' levels BlueZ keeps (UPower's list; without UPower, bluetoothctl's details of the connected
//    devices), each program at a fixed path, with fixed arguments and a deadline (sysprog.rs).
// Changed from the original: its PollAllDevices opened every node read/write and ran the vendor drivers on all of
// them; its rule granted every node (sysfs.rs, udev.rs and hidraw.rs say what changed).
// Device arrival: no watcher (udev's netlink socket would need more than std): enumeration runs every interval, and on
// the page's «Check now».
// UNVERIFIED here: compiled and unit-tested on Linux; no real device was read.
// Copyright (C) 2026 Kurokawa contributors.
pub mod bt;
pub mod hidraw;

use crate::allow::HidIdent;
use crate::hiddesc::{self, Field};
use crate::hidplat::{HidState, Port};
use crate::identity::Candidate;
use crate::kind;
use crate::model::{Charging, Connection, Device, Kind, Level, Percent, Reading, Source};
use crate::runner::{Platform, Prefs};
use crate::sched::Outcome;
use crate::sysfs::{self, HidrawNode, PowerSupply};
use crate::transport::{open_mode_for, OpenMode, TErr};
use hidraw::{LinHid, NodeColl};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// One collection of a hidraw node, as the readers see it.
#[derive(Clone, Debug)]
pub struct LinPort {
    pub coll: NodeColl,
    pub product: String,
    pub serial: String,
    pub container: String,
    pub key_path: String,
    pub battery: Vec<Field>,
    pub bus: u16,
    pub ok: bool,
}

/// The collections of the nodes, those of devices the kernel already reads left out. `dev`: where the nodes are
/// (normally «/dev»); `ok`: whether this user may open a node.
pub fn ports(nodes: &[HidrawNode], supplies: &[PowerSupply], dev: &Path, ok: &dyn Fn(&Path) -> bool) -> Vec<LinPort> {
    let mut out = Vec::new();
    for n in nodes {
        if sysfs::kept_by_kernel(&n.hid_path, supplies) {
            continue;
        }
        let node = dev.join(&n.node);
        let can = ok(&node);
        let container = n.container();
        let key_path = if n.interface >= 0 { format!("{}&mi_{:02x}", container, n.interface) } else { container.clone() };
        // (Bluetooth: the address is the unit's serial, as Windows reads it.)
        let serial = if n.bus == sysfs::BUS_BLUETOOTH { container.clone() } else { n.uniq.clone() };
        for c in hiddesc::parse(&n.descriptor) {
            out.push(LinPort {
                coll: NodeColl { node: node.clone(), ident: HidIdent { vid: n.vid, pid: n.pid, usage_page: c.usage_page, usage: c.usage, interface: n.interface }, input_len: c.input_len, output_len: c.output_len, feature_len: c.feature_len, numbered: c.numbered, input_ids: c.input_ids.clone() },
                product: n.name.clone(),
                serial: serial.clone(),
                container: container.clone(),
                key_path: key_path.clone(),
                battery: c.battery.clone(),
                bus: n.bus,
                ok: can,
            });
        }
    }
    out
}

impl Port for LinPort {
    type T = LinHid;
    fn ident(&self) -> &HidIdent {
        &self.coll.ident
    }
    fn product(&self) -> &str {
        &self.product
    }
    fn serial(&self) -> &str {
        &self.serial
    }
    fn container(&self) -> &str {
        &self.container
    }
    fn key_path(&self) -> &str {
        &self.key_path
    }
    fn input_len(&self) -> usize {
        self.coll.input_len
    }
    fn output_len(&self) -> usize {
        self.coll.output_len
    }
    fn feature_len(&self) -> usize {
        self.coll.feature_len
    }
    fn has_battery(&self) -> bool {
        !self.battery.is_empty()
    }
    fn connection(&self) -> Connection {
        if self.bus == sysfs::BUS_BLUETOOTH {
            Connection::Bluetooth
        } else {
            Connection::Usb
        }
    }
    fn accessible(&self) -> bool {
        self.ok
    }
    fn open_listen(&self, may_send: bool) -> Result<LinHid, TErr> {
        let mode = match open_mode_for(&self.coll.ident, true) {
            OpenMode::ReadWrite if !may_send => OpenMode::Read,
            m => m,
        };
        LinHid::open(&self.coll, mode)
    }
    fn open_feature(&self, may_send: bool, feature_len: usize) -> Result<LinHid, TErr> {
        let mode = if may_send && crate::allow::may_write(&self.coll.ident) { OpenMode::Feature } else { OpenMode::QueryOnly };
        let mut t = LinHid::open(&self.coll, mode)?;
        t.set_feature_len(feature_len);
        Ok(t)
    }
    fn read_battery(&self, deadline: Instant) -> Result<Percent, TErr> {
        let mut t = LinHid::open(&self.coll, generic_mode())?;
        let caps: Vec<crate::hidvalue::ValueCap> = self.battery.iter().map(|f| f.cap).collect();
        let fields = self.battery.clone();
        let extract = move |cap: &crate::hidvalue::ValueCap, rep: &mut [u8]| hiddesc::field_value(&fields, cap, rep);
        crate::hidvalue::read_generic(&mut t, &caps, self.coll.feature_len, self.coll.input_len, crate::hidvalue::percent_quirk(self.coll.ident.vid), deadline, &extract)
    }
}

/// How the generic reader opens a node: query only (the file read-only), whatever allow.rs lists for the device — the
/// generic reader asks the battery field the descriptor declares and never sends, so it never needs the node writable
/// (a node opened writable for a device allow.rs names is the family readers' alone).
fn generic_mode() -> OpenMode {
    OpenMode::QueryOnly
}

/// The kernel's batteries of peripherals as cards (Source::System: nothing to ask; read again each round).
pub fn supply_candidates(list: &[PowerSupply], now: u64) -> Vec<Candidate> {
    let mut out = Vec::new();
    for s in list {
        let ids = s.hid_path.as_deref().and_then(|p| p.file_name()).and_then(|n| n.to_str()).and_then(sysfs::hid_dir_ids);
        let (bus, vid, pid) = ids.unwrap_or((0, 0, 0));
        // (A Bluetooth device's address, when the name or serial carries one: the unit's container, so it is one card
        //  with BlueZ's entry for it.)
        let addr = crate::connect::parse_addr(&s.serial).or_else(|| s.name.rsplit(['-', '_']).find_map(crate::connect::parse_addr)).map(crate::connect::addr_text);
        let key = if !s.serial.is_empty() { format!("ps:s:{}", s.serial) } else { format!("ps:n:{}", s.name) };
        let mut d = Device::new(key, Source::System);
        d.vid = vid;
        d.pid = pid;
        d.serial = s.serial.clone();
        d.container = addr.clone().unwrap_or_default();
        // (A paired device under a receiver's HID device: through the receiver.)
        let under_receiver = s.hid_path.as_deref().and_then(Path::parent).and_then(|p| p.file_name()).and_then(|n| n.to_str()).and_then(sysfs::hid_dir_ids).is_some();
        d.connection = if under_receiver { Connection::Dongle } else if bus == sysfs::BUS_BLUETOOTH || addr.is_some() { Connection::Bluetooth } else if bus == sysfs::BUS_USB { Connection::Usb } else { Connection::Unknown };
        let l = s.name.to_ascii_lowercase();
        d.kind = if ["sony_controller", "ps-controller", "nintendo_switch_controller", "xpadneo", "steam-controller", "wiimote"].iter().any(|p| l.starts_with(p)) { Kind::Controller } else { Kind::Other };
        if d.kind == Kind::Other {
            d.kind = kind::guess(&s.model);
        }
        if d.kind == Kind::Other && vid != 0 {
            d.kind = kind::from_ble_ids(vid, pid);
        }
        d.name = if s.model.is_empty() { String::new() } else { s.model.clone() };
        d.brand = if !s.manufacturer.is_empty() && s.manufacturer.len() <= 40 { s.manufacturer.clone() } else { kind::brand_of(vid, &d.name, d.kind).to_string() };
        let level = match (s.capacity, s.level) {
            (Some(p), _) => Percent::new(p as i64).map_or(Level::Unknown, Level::Exact),
            (None, Some(c)) => Level::Coarse(c),
            _ => Level::Unknown,
        };
        out.push(Candidate { device: d, reading: Some(Reading::new(level, s.charging, now)), offline: !s.present });
    }
    out
}

/// BlueZ's levels (UPower's list) as cards, keyed «bt:<address>» as the connect panel finds them.
pub fn upower_candidates(list: &[crate::upower::UpDev], now: u64) -> Vec<Candidate> {
    list.iter()
        .map(|u| {
            let mut d = Device::new(crate::identity::bt_key(&u.addr), Source::System);
            d.container = u.addr.clone();
            d.connection = Connection::Bluetooth;
            d.kind = crate::upower::kind_of(&u.kind_word, &u.model);
            d.name = u.model.clone();
            d.brand = kind::brand_of(0, &u.model, d.kind).to_string();
            // (A coarse level said by the device is coarse: UPower's percentage is then its own guess.)
            let level = match (u.coarse, u.percent) {
                (Some(c), _) => Level::Coarse(c),
                (None, Some(p)) => Percent::new(p as i64).map_or(Level::Unknown, Level::Exact),
                _ => Level::Unknown,
            };
            Candidate { device: d, reading: Some(Reading::new(level, u.charging, now)), offline: false }
        })
        .collect()
}

/// The Linux readers. `sys` and `dev` are «/sys» and «/dev» (tests give their own).
pub struct LinuxPlatform {
    hid: HidState<LinPort>,
    sys: PathBuf,
    dev: PathBuf,
    /// Bluetooth levels when UPower is not there: bluetoothctl (bt.rs).
    bt: Arc<bt::LinuxBt>,
}

impl Default for LinuxPlatform {
    fn default() -> Self {
        LinuxPlatform::new()
    }
}

impl LinuxPlatform {
    pub fn new() -> LinuxPlatform {
        LinuxPlatform { hid: HidState::default(), sys: PathBuf::from("/sys"), dev: PathBuf::from("/dev"), bt: Arc::new(bt::LinuxBt::default()) }
    }

    /// BlueZ's levels: UPower's list, else bluetoothctl's connected devices' details. Within `deadline`.
    fn bluez(&self, now: u64, deadline: Instant) -> Vec<Candidate> {
        if let Some(up) = crate::sysprog::find(crate::upower::UPOWER) {
            return match crate::sysprog::run(&up, &["-d"], deadline, 1 << 20) {
                Ok(r) => upower_candidates(&crate::upower::parse(&r.out), now),
                Err(_) => Vec::new(),
            };
        }
        self.bt.levels(deadline).into_iter().map(|(addr, name, kind, pct)| {
            let a = crate::connect::addr_text(addr);
            let mut d = Device::new(crate::identity::bt_key(&a), Source::System);
            d.container = a;
            d.connection = Connection::Bluetooth;
            d.kind = kind;
            d.brand = kind::brand_of(0, &name, kind).to_string();
            d.name = name;
            Candidate { device: d, reading: Some(Reading::new(Level::Exact(pct), Charging::Unknown, now)), offline: false }
        }).collect()
    }
}

impl Platform for LinuxPlatform {
    fn set_prefs(&self, p: &Prefs) {
        self.hid.set_prefs(&p.pad_queries, &p.mk_ask, &p.mk_mute);
        self.hid.set_defs(&p.defs);
    }

    /// W3, «Teach me»: the raw HID nodes' collections with their verdicts (hidplat.rs, teach.rs).
    fn teach_targets(&self) -> Vec<crate::teach::Target> {
        let supplies = sysfs::power_supplies(&self.sys);
        let nodes = sysfs::hidraw_nodes(&self.sys);
        let ports = ports(&nodes, &supplies, &self.dev, &|p| hidraw::may_open(p, false));
        self.hid.teach_targets(&ports)
    }

    /// W3: an allowed collection opened to listen only (read-only open of its node).
    fn teach_open(&self, id: &str) -> Result<Box<dyn crate::transport::HidTransport + Send>, TErr> {
        self.hid.teach_open(id)
    }

    fn enumerate(&self, now: u64) -> Vec<Candidate> {
        let supplies = sysfs::power_supplies(&self.sys);
        let nodes = sysfs::hidraw_nodes(&self.sys);
        let ports = ports(&nodes, &supplies, &self.dev, &|p| hidraw::may_open(p, false));
        let mut out = self.hid.candidates(&ports);
        out.extend(supply_candidates(&supplies, now));
        out.extend(self.bluez(now, Instant::now() + Duration::from_millis(2_500)));
        out
    }

    fn query(&self, device: &Device, deadline: Instant, now: u64) -> Outcome {
        self.hid.query(device, deadline, now)
    }

    /// Piece W4: every hidraw node's collections — the kernel's own devices too, which `enumerate` leaves out.
    fn inventory(&self) -> Vec<crate::report::HidSeen> {
        inventory_of(&sysfs::hidraw_nodes(&self.sys))
    }
}

/// The report's list from the nodes: one entry per collection, nothing opened.
pub fn inventory_of(nodes: &[HidrawNode]) -> Vec<crate::report::HidSeen> {
    ports(nodes, &[], Path::new("/dev"), &|_| true)
        .iter()
        .map(|p| {
            let id = &p.coll.ident;
            crate::report::HidSeen {
                unit: crate::identity::hid_key(id.vid, id.pid, &p.serial, &p.container, &p.key_path),
                vid: id.vid,
                pid: id.pid,
                product: p.product.clone(),
                connection: p.connection(),
                usage_page: id.usage_page,
                usage: id.usage,
                interface: id.interface,
                input_len: p.coll.input_len,
                output_len: p.coll.output_len,
                feature_len: p.coll.feature_len,
                battery_field: !p.battery.is_empty(),
            }
        })
        .collect()
}

/// Whether a node is one the udev rule is for: a reader's device. (A device that only declares a battery field is not
/// added: the rule would have to name it by its ids alone — its keyboard or pointer with it. The generic reader still
/// reads such a node when the system already lets this user open it.)
fn wanted(n: &HidrawNode) -> bool {
    udev_listed(n.vid, n.pid)
}

/// The vendor and product ids the udev rule names: the readers' devices, nothing else (never «every node», never a
/// device for its battery field alone). `sys` is no longer looked at; kept so the shell's call stands.
pub fn rule_ids(_sys: &Path) -> Vec<(u16, u16)> {
    crate::udev::listed_ids()
}

/// Whether a reader's device is there but closed to this user (the page then offers the udev rule).
pub fn needs_rule(sys: &Path, dev: &Path) -> bool {
    let supplies = sysfs::power_supplies(sys);
    sysfs::hidraw_nodes(sys).iter().filter(|n| !sysfs::kept_by_kernel(&n.hid_path, &supplies)).any(|n| wanted(n) && !hidraw::may_open(&dev.join(&n.node), false))
}

fn udev_listed(vid: u16, pid: u16) -> bool {
    crate::pads::all_models().any(|m| m.vid == vid && m.pid == pid) || crate::mice::all_models().any(|m| m.vid == vid && m.pid == pid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Coarse;

    fn node(name: &str, vid: u16, pid: u16, bus: u16, desc: Vec<u8>, path: &str) -> HidrawNode {
        HidrawNode { node: name.into(), hid_dir: String::new(), hid_path: PathBuf::from(path), bus, vid, pid, name: "Made Up".into(), phys: "usb-0000:00:14.0-3/input0".into(), uniq: if bus == 5 { "aa:bb:cc:dd:ee:07".into() } else { String::new() }, interface: -1, descriptor: desc }
    }
    fn pad_desc() -> Vec<u8> {
        // (Page 1 usage 5, report 1 of 63 bytes in, report 5 of 47 bytes out.)
        vec![0x05, 0x01, 0x09, 0x05, 0xA1, 0x01, 0x85, 0x01, 0x75, 0x08, 0x95, 0x3F, 0x09, 0x30, 0x81, 0x02, 0x85, 0x05, 0x95, 0x2F, 0x09, 0x31, 0x91, 0x02, 0xC0]
    }

    #[test]
    fn ports_split_collections_and_leave_the_kernels_devices_alone() {
        let ds = node("hidraw4", 0x054C, 0x0CE6, 5, pad_desc(), "/sys/devices/x/0005:054C:0CE6.0001");
        let other = node("hidraw5", 0x1234, 0x0001, 3, pad_desc(), "/sys/devices/y/0003:1234:0001.0002");
        let p = ports(&[ds.clone(), other.clone()], &[], Path::new("/dev"), &|_| true);
        assert_eq!(p.len(), 2);
        assert_eq!((p[0].coll.input_len, p[0].coll.output_len, p[0].coll.node.to_str().unwrap()), (64, 48, "/dev/hidraw4"));
        assert_eq!((p[0].serial.as_str(), p[0].container.as_str()), ("AA:BB:CC:DD:EE:07", "AA:BB:CC:DD:EE:07"));
        assert_eq!(p[1].container, "usb-0000:00:14.0-3");
        let kernel = PowerSupply { name: "ps-controller-battery-aa:bb:cc:dd:ee:07".into(), capacity: Some(60), level: None, charging: Charging::Yes, model: "Made Up Pad".into(), manufacturer: String::new(), serial: String::new(), present: true, hid_path: Some(PathBuf::from("/sys/devices/x/0005:054C:0CE6.0001")) };
        let p2 = ports(&[ds, other], &[kernel.clone()], Path::new("/dev"), &|_| false);
        assert_eq!(p2.len(), 1, "the kernel reads the pad: its node is left alone");
        assert!(!p2[0].ok);
        // (The kernel's card: a controller on Bluetooth, its address the container, its level exact.)
        let c = &supply_candidates(&[kernel], 5)[0];
        assert_eq!((c.device.kind, c.device.connection, c.device.vid, c.device.container.as_str()), (Kind::Controller, Connection::Bluetooth, 0x054C, "AA:BB:CC:DD:EE:07"));
        assert_eq!(c.reading.unwrap().level, Level::Exact(Percent::new(60).unwrap()));
        assert_eq!(c.reading.unwrap().charging, Charging::Yes);
        assert!(!c.offline);
    }

    #[test]
    fn the_inventory_lists_every_collection_even_the_kernels_and_keeps_serials_in_the_unit_key_only() {
        let ds = node("hidraw4", 0x054C, 0x0CE6, 5, pad_desc(), "/sys/devices/x/0005:054C:0CE6.0001");
        let list = inventory_of(&[ds]);
        assert_eq!(list.len(), 1);
        let h = &list[0];
        assert_eq!((h.vid, h.pid, h.usage_page, h.usage, h.input_len, h.output_len, h.connection), (0x054C, 0x0CE6, 1, 5, 64, 48, Connection::Bluetooth));
        assert_eq!(h.product, "Made Up");
        assert!(h.unit.starts_with("hid:054C:0CE6:"));
        // (The report keeps the key out of its text and the address out of the name: report.rs tests that.)
        let text = crate::report::build(&crate::report::Input { app: "a", os_name: "Linux", os_version: "", hid: &list, devices: &[], secrets: &[], no_query: &[] });
        assert!(!text.to_lowercase().contains("aa:bb:cc:dd:ee:07") && !text.contains("hid:054C"));
        assert!(text.contains("usage page: 0x0001, usage: 0x0005") && text.contains("input 64, output 48, feature 0"));
        assert!(text.contains("playstation"), "the built-in reader that matches is named:\n{}", text);
    }

    #[test]
    fn the_hid_readers_claim_linux_ports_as_on_windows() {
        let st: HidState<LinPort> = HidState::default();
        let ds = node("hidraw4", 0x054C, 0x0CE6, 5, pad_desc(), "/sys/devices/x/0005:054C:0CE6.0001");
        let p = ports(&[ds], &[], Path::new("/nonexistent-dev"), &|_| false);
        let cands = st.candidates(&p);
        assert_eq!(cands.len(), 1);
        assert_eq!((cands[0].device.driver, cands[0].device.connection), ("playstation", Connection::Bluetooth));
        // (No access: the card says so, no node opened.)
        match st.query(&cands[0].device, Instant::now() + Duration::from_secs(1), 3) {
            Outcome::Read(r) => assert_eq!(r.note, crate::model::Note::NoAccess),
            o => panic!("{:?}", o),
        }
    }

    #[test]
    fn the_generic_reader_never_opens_a_node_writable() {
        // (A device allow.rs names — open_mode_for would give it ReadWrite: the generic reader still opens query only.)
        let listed = crate::mice::all_models().map(|m| crate::mice::testkit::ident(m)).find(|id| crate::allow::may_write(id)).expect("a listed device");
        assert_eq!(open_mode_for(&listed, false), OpenMode::ReadWrite);
        assert_eq!(generic_mode(), OpenMode::QueryOnly);
    }

    #[test]
    fn upower_and_coarse_supplies() {
        let u = crate::upower::UpDev { addr: "AA:BB:CC:DD:EE:01".into(), model: "Test Headset".into(), kind_word: "headset".into(), percent: Some(70), coarse: None, charging: Charging::Unknown };
        let c = &upower_candidates(&[u], 1)[0];
        assert_eq!((c.device.key.as_str(), c.device.kind), ("bt:AA:BB:CC:DD:EE:01", Kind::Headset));
        let s = PowerSupply { name: "hidpp_battery_0".into(), capacity: None, level: Some(Coarse::Low), charging: Charging::No, model: "Made Up Mouse".into(), manufacturer: "Made Up".into(), serial: "4082-AB-CD".into(), present: false, hid_path: Some(PathBuf::from("/sys/devices/u/0003:046D:C52B.0003/0003:046D:4082.0004")) };
        let c = &supply_candidates(&[s], 1)[0];
        assert_eq!((c.device.key.as_str(), c.device.connection, c.device.kind, c.offline), ("ps:s:4082-AB-CD", Connection::Dongle, Kind::Mouse, true));
        assert_eq!(c.reading.unwrap().level, Level::Coarse(Coarse::Low));
    }
}
