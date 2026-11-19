// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the Windows platform — what runner.rs asks of a computer.
// Derived from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/devices.cpp (PollAllDevices: the readers' order — Bluetooth before the generic HID check, XInput last) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later.
// Changed here: the HID collections are enumerated once per round (the original enumerated them several times a
// minute), sorted by registry.rs, and only those with a battery field are queried — later, each on its own thread with
// a deadline (runner.rs); the readers' results are merged by identity.rs's explicit rules; device arrival comes from
// CM_Register_Notification (no window, no polling). Piece 4: a collection a controller reader claims (pads/*.rs, by
// vendor, product, usage page and usage) becomes that controller's entry — one per unit, or per slot of a receiver —
// and the generic reader leaves that unit alone; its query listens on its own handle (shared, never exclusive), and
// sends a status request only for a family the user turned on. Piece 5: the mice' and keyboards' own readers
// (mice/*.rs) the same way — win/mice.rs. Piece 6: the headsets go through win/mice.rs too (heads/*.rs); AirPods' Bluetooth
// LE broadcasts (win/ble.rs, behind `wgi`), Phone Link's card file and Galaxy Buds' status service (win/spp.rs) are
// added here, each under its family's switch.
// UNVERIFIED here: compiled only on Windows (type-checked elsewhere); real devices decide.
// Copyright (C) 2026 Kurokawa contributors.
pub mod autostart;
pub mod ble;
pub mod bt;
pub mod btconn;
pub mod console;
pub mod ffi;
pub mod hid;
pub mod mice;
pub mod spp;
pub mod strip;
pub mod sysmon;
pub mod wgi;
pub mod xinput;

use crate::bluetooth;
use crate::identity::{self, Candidate};
use crate::kind;
use crate::model::{Charging, Connection, Device, Kind, Level, Reading, Source};
use crate::pads::{self, Family, Way};
use crate::registry::{self, Claim, Collection};
use crate::runner::{Platform, Prefs};
use crate::sched::Outcome;
use crate::transport::TErr;
use crate::xbox;
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Instant;

/// The Windows readers. Holds the last enumeration's HID collections per device key, for `query`.
#[derive(Default)]
pub struct WinPlatform {
    colls: Mutex<BTreeMap<String, Vec<hid::HidColl>>>,
    /// Each controller's collections with their reader (a pad may have two: 8BitDo's vendor channel and its gamepad).
    pads: Mutex<BTreeMap<String, Vec<(hid::HidColl, &'static pads::Model)>>>,
    /// The families the user turned on whose reading sends a request.
    pad_on: Mutex<Vec<Family>>,
    /// Piece 5: the mice' and keyboards' units, slots and switches.
    mice: mice::MiceState,
    /// Piece 6: Galaxy Buds' cards and their Bluetooth addresses.
    buds: Mutex<BTreeMap<String, u64>>,
}

impl WinPlatform {
    pub fn new() -> WinPlatform {
        WinPlatform::default()
    }
}

pub(crate) fn hid_connection(path: &str) -> Connection {
    let l = path.to_ascii_lowercase();
    // (HID over Bluetooth: classic HID's service 1124, LE's HID over GATT 1812.)
    if l.contains("{00001124-0000-1000-8000-00805f9b34fb}") || l.contains("{00001812-0000-1000-8000-00805f9b34fb}") || l.contains("_vid&0002") {
        Connection::Bluetooth
    } else {
        Connection::Usb
    }
}

type PadMap = BTreeMap<String, Vec<(hid::HidColl, &'static pads::Model)>>;

/// The controllers among the collections: one entry per pad key, with the reader's name, picture and brand.
fn pad_candidates(all: &[hid::HidColl]) -> (Vec<Candidate>, PadMap) {
    let mut by: PadMap = BTreeMap::new();
    for c in all {
        let Some(m) = pads::find(&c.ident) else { continue };
        if !pads::fits(m, c.input_len, c.output_len) {
            continue;
        }
        let key = identity::pad_key(c.ident.vid, c.ident.pid, &c.serial, &c.container, &c.path, m.per_interface);
        by.entry(key).or_default().push((c.clone(), m));
    }
    let mut out = Vec::new();
    for (key, cs) in &by {
        let (c0, m) = (&cs[0].0, cs[0].1);
        let mut d = Device::new(key.clone(), Source::Pad);
        d.vid = c0.ident.vid;
        d.pid = c0.ident.pid;
        d.container = c0.container.clone();
        d.serial = c0.serial.clone();
        d.kind = Kind::Controller;
        d.connection = if m.link == pads::Link::Receiver { Connection::Dongle } else { hid_connection(&c0.path) };
        // (A Switch-mode pad names itself — an 8BitDo says «Pro Controller»; the others by the reader's model.)
        d.name = if m.driver == "nintendo" && !c0.product.is_empty() { c0.product.clone() } else { m.name.to_string() };
        d.brand = m.driver().family.brand().to_string();
        d.driver = m.driver;
        d.picture = m.picture;
        out.push(Candidate { device: d, reading: None, offline: false });
    }
    (out, by)
}

fn hid_candidates(all: &[hid::HidColl]) -> (Vec<Candidate>, BTreeMap<String, Vec<hid::HidColl>>) {
    let keyed: Vec<(String, &hid::HidColl)> = all.iter().map(|c| (identity::hid_key(c.ident.vid, c.ident.pid, &c.serial, &c.container, &c.path), c)).collect();
    let regs: Vec<Collection> = keyed.iter().map(|(k, c)| Collection { ident: c.ident.clone(), battery_field: !c.battery.is_empty(), key: k.clone() }).collect();
    let mut by: BTreeMap<String, Vec<hid::HidColl>> = BTreeMap::new();
    for (i, (k, c)) in keyed.iter().enumerate() {
        if registry::classify(&regs, &regs[i], &[]) == Claim::Generic {
            by.entry(k.clone()).or_default().push((*c).clone());
        }
    }
    let mut out = Vec::new();
    for (key, cs) in &by {
        let c0 = &cs[0];
        let usages: Vec<(u16, u16)> = keyed.iter().filter(|(k, _)| k == key).map(|(_, c)| (c.ident.usage_page, c.ident.usage)).collect();
        let name = keyed.iter().filter(|(k, _)| k == key).map(|(_, c)| c.product.clone()).find(|p| !p.is_empty()).unwrap_or_default();
        let mut d = Device::new(key.clone(), Source::HidGeneric);
        d.vid = c0.ident.vid;
        d.pid = c0.ident.pid;
        d.container = c0.container.clone();
        d.serial = c0.serial.clone();
        d.connection = hid_connection(&c0.path);
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

fn bt_candidates(nodes: &[bluetooth::BtNode], hid: &[hid::HidColl], now: u64) -> Vec<Candidate> {
    bluetooth::gather(nodes)
        .into_iter()
        .map(|f| {
            let mut d = Device::new(identity::bt_key(&f.container), Source::Bluetooth);
            d.container = f.container.clone();
            d.connection = Connection::Bluetooth;
            d.kind = f.kind;
            // (Bluetooth LE devices have no Class of Device: their HID collections on the same link tell.)
            let on_link: Vec<&hid::HidColl> = hid.iter().filter(|c| c.container.eq_ignore_ascii_case(&f.container)).collect();
            if let Some(c) = on_link.first() {
                d.vid = c.ident.vid;
                d.pid = c.ident.pid;
                if d.kind == Kind::Other {
                    d.kind = kind::from_ble_ids(d.vid, d.pid);
                }
                if d.kind == Kind::Other {
                    let usages: Vec<(u16, u16)> = on_link.iter().map(|c| (c.ident.usage_page, c.ident.usage)).collect();
                    d.kind = kind::from_collections(&usages);
                }
            }
            d.brand = kind::brand_of(d.vid, &f.name, d.kind).to_string();
            d.name = f.name;
            let reading = f.level.map(|p| Reading::new(Level::Exact(p), Charging::Unknown, now));
            Candidate { device: d, reading, offline: !f.connected }
        })
        .collect()
}

/// Piece 6: the readers that are not HID — AirPods' broadcasts, Phone Link's card, Galaxy Buds — each under its switch.
fn other_candidates(m: &mice::MiceState, nodes: &[bluetooth::BtNode], now: u64) -> (Vec<Candidate>, BTreeMap<String, u64>) {
    use crate::mice::Family as F;
    use crate::model::Note;
    let mut out = Vec::new();
    let paired = crate::airpods::paired(nodes);
    if !paired.is_empty() {
        let on = m.family_on(F::AirPods);
        let heard = if on && ble::available() {
            ble::ensure();
            ble::adverts()
        } else {
            Vec::new()
        };
        for p in &paired {
            let mut d = Device::new(format!("advert:{}", p.container.to_ascii_uppercase()), Source::Advert);
            d.container = p.container.clone();
            d.name = p.name.clone();
            d.kind = if crate::airpods::is_single(p.pid) { Kind::Headset } else { Kind::Earbuds };
            d.brand = "Apple".into();
            d.connection = Connection::Bluetooth;
            d.pid = p.pid;
            d.vid = 0x004C;
            d.driver = "hs-airpods";
            let reading = if !on {
                Reading::unknown(Note::QueryOff, Charging::Unknown, now)
            } else if !ble::available() {
                Reading::unknown(Note::NotInBuild, Charging::Unknown, now)
            } else {
                match crate::airpods::pick(p, &heard, now) {
                    Some(a) => crate::airpods::reading(&a, a.at),
                    None => Reading::unknown(Note::None, Charging::Unknown, now),
                }
            };
            out.push(Candidate { device: d, reading: Some(reading), offline: false });
        }
    }
    if m.family_on(F::PhoneLink) {
        if let Some((name, level, chg, written)) = phone_link() {
            let mut d = Device::new("phonelink".into(), Source::PhoneLink);
            d.name = name;
            d.kind = Kind::Phone;
            d.driver = "ot-phonelink";
            if let Some(r) = crate::phonelink::reading_with(level, chg, written, now) {
                out.push(Candidate { device: d, reading: Some(r), offline: false });
            }
        }
    }
    let mut addrs = BTreeMap::new();
    for b in crate::galaxybuds::connected_buds(nodes) {
        let key = format!("spp:{:012X}", b.addr);
        let mut d = Device::new(key.clone(), Source::Spp);
        d.container = b.container.clone();
        d.name = b.name.clone();
        d.kind = Kind::Earbuds;
        d.brand = "Samsung".into();
        d.connection = Connection::Bluetooth;
        d.driver = "hs-galaxybuds";
        addrs.insert(key, b.addr);
        out.push(Candidate { device: d, reading: None, offline: false });
    }
    (out, addrs)
}

/// Phone Link's companion card in the user's own %LOCALAPPDATA%: (phone, level, when the file was written, ms) — read
/// only, at most 4 MB, sharing the file with Phone Link (std's open shares reading and writing).
fn phone_link() -> Option<(String, u8, bool, u64)> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    let path = std::path::Path::new(&base).join(crate::phonelink::REL_PATH);
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > crate::phonelink::MAX_BYTES {
        return None;
    }
    let written = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
    let mut bytes = Vec::new();
    use std::io::Read;
    std::fs::File::open(&path).ok()?.take(crate::phonelink::MAX_BYTES).read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    let text = text.trim_start_matches('\u{FEFF}');
    let (name, level) = crate::phonelink::parse(text)?;
    Some((name, level, crate::phonelink::charging_of(text), written))
}

impl WinPlatform {
    fn query_buds(&self, device: &Device, deadline: Instant, now: u64) -> Outcome {
        if !self.mice.family_on(crate::mice::Family::GalaxyBuds) {
            // (Off: no connection is made — said on the card.)
            return Outcome::Read(Reading::unknown(crate::model::Note::QueryOff, Charging::Unknown, now));
        }
        let Some(addr) = self.buds.lock().ok().and_then(|g| g.get(&device.key).copied()) else { return Outcome::Failed };
        match spp::read(addr, deadline) {
            Ok(st) => Outcome::Read(crate::galaxybuds::reading(&st, now)),
            Err(TErr::Timeout) => Outcome::NoAnswer,
            Err(_) => Outcome::Failed,
        }
    }

    fn query_pad(&self, device: &Device, deadline: Instant, now: u64) -> Outcome {
        let list = match self.pads.lock() {
            Ok(m) => m.get(&device.key).cloned().unwrap_or_default(),
            Err(_) => return Outcome::Failed,
        };
        let on = self.pad_on.lock().map(|g| g.clone()).unwrap_or_default();
        let is_on = |m: &pads::Model| on.contains(&m.driver().family);
        // (A family turned on: its request first; else the listening reader first.)
        let mut order: Vec<&(hid::HidColl, &'static pads::Model)> = list.iter().collect();
        order.sort_by_key(|(_, m)| match (m.driver().way, is_on(m)) {
            (Way::Query, true) => 0,
            (Way::Passive, _) => 1,
            (Way::Query, false) => 2,
        });
        let mut best = Outcome::Failed;
        for (c, m) in order {
            let send = m.driver().way == Way::Query && is_on(m);
            let out = if m.driver().way == Way::Query && !send {
                pads::read(&mut NoDevice(c.ident.clone()), m, false, false, deadline, now)
            } else {
                match hid::WinHid::open_listen(c, send) {
                    Ok(mut t) => pads::read(&mut t, m, hid_connection(&c.path) == Connection::Bluetooth, send, deadline, now),
                    Err(_) => Outcome::Failed,
                }
            };
            if let Outcome::Read(r) = out {
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

/// Which outcome says more, when no reader of a pad found its level.
pub(crate) fn rank(o: &Outcome) -> u8 {
    match o {
        Outcome::Read(r) if r.charging != Charging::Unknown => 4,
        Outcome::Read(r) if r.note != crate::model::Note::QueryOff => 3,
        Outcome::Read(_) => 2,
        Outcome::Asleep => 2,
        Outcome::NoAnswer => 1,
        Outcome::Failed => 0,
    }
}

/// A reader switched off is given no device at all: pads::read answers «off» without a call.
pub(crate) struct NoDevice(pub(crate) crate::allow::HidIdent);
impl crate::transport::HidTransport for NoDevice {
    fn ident(&self) -> &crate::allow::HidIdent {
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

impl Platform for WinPlatform {
    fn set_prefs(&self, p: &Prefs) {
        if let Ok(mut g) = self.pad_on.lock() {
            *g = p.pad_queries.iter().filter_map(|s| Family::parse(s)).collect();
        }
        self.mice.set_prefs(&p.mk_ask, &p.mk_mute);
    }

    /// Piece W4: every HID collection Windows lists (the ones `hid::enumerate` can open), for «Report a device».
    fn inventory(&self) -> Vec<crate::report::HidSeen> {
        hid::enumerate()
            .iter()
            .map(|c| crate::report::HidSeen {
                unit: identity::hid_key(c.ident.vid, c.ident.pid, &c.serial, &c.container, &c.path),
                vid: c.ident.vid,
                pid: c.ident.pid,
                product: c.product.clone(),
                connection: hid_connection(&c.path),
                usage_page: c.ident.usage_page,
                usage: c.ident.usage,
                interface: c.ident.interface,
                input_len: c.input_len,
                output_len: c.output_len,
                feature_len: c.feature_len,
                battery_field: !c.battery.is_empty(),
            })
            .collect()
    }

    fn enumerate(&self, now: u64) -> Vec<Candidate> {
        let colls = hid::enumerate();
        let (pad_list, pad_map) = pad_candidates(&colls);
        let pad_keys: Vec<String> = pad_map.keys().cloned().collect();
        let (mice_list, mice_keys) = self.mice.candidates(&colls);
        let (generic, mut by) = hid_candidates(&colls);
        by.retain(|k, _| !pad_keys.iter().any(|p| p == k || p.starts_with(&format!("{}:i:", k))) && !mice_keys.contains(k));
        let mut out = identity::drop_claimed(identity::drop_claimed(generic, &pad_keys), &mice_keys);
        out.extend(pad_list);
        out.extend(mice_list);
        if let Ok(mut m) = self.colls.lock() {
            *m = by;
        }
        if let Ok(mut m) = self.pads.lock() {
            *m = pad_map;
        }
        let nodes = bt::nodes();
        let bt = bt_candidates(&nodes, &colls, now);
        let (others, buds) = other_candidates(&self.mice, &nodes, now);
        out.extend(others);
        if let Ok(mut g) = self.buds.lock() {
            *g = buds;
        }
        let bt_xbox = bt.iter().any(|c| c.device.vid == 0x045E && c.device.kind == Kind::Controller);
        out.extend(bt);
        let pads = if bt_xbox { Vec::new() } else { wgi::pads() };
        let mut precise = 0;
        let mut third = 0;
        for p in &pads {
            let Some((pct, ch)) = xbox::wgi_reading(p) else { continue };
            precise += 1;
            if p.vid != 0x045E {
                third += 1;
            }
            let mut d = Device::new(identity::wgi_key(&p.id, p.vid, p.pid), Source::XboxWgi);
            d.vid = p.vid;
            d.pid = p.pid;
            d.kind = Kind::Controller;
            d.name = xbox::wgi_name(p);
            d.brand = kind::brand_of(p.vid, &d.name, d.kind).to_string();
            out.push(Candidate { device: d, reading: Some(Reading::new(Level::Exact(pct), ch, now)), offline: false });
        }
        for f in xbox::xinput_found(&xinput::slots(), precise, third, bt_xbox) {
            let mut d = Device::new(identity::xinput_key(f.user, f.headset), Source::XInput);
            d.kind = if f.headset { Kind::Headset } else { Kind::Controller };
            // (Named by the page in the interface's language — batXboxPad / batXboxHeadset, the slot from the key.)
            d.name = String::new();
            d.brand = "Xbox".into();
            d.connection = Connection::Dongle;
            let level = f.level.map_or(Level::Unknown, Level::Coarse);
            out.push(Candidate { device: d, reading: Some(Reading::new(level, Charging::Unknown, now)), offline: false });
        }
        out
    }

    fn query(&self, device: &Device, deadline: Instant, now: u64) -> Outcome {
        if device.source == Source::Pad {
            return self.query_pad(device, deadline, now);
        }
        if device.source == Source::Vendor {
            return self.mice.query(device, deadline, now);
        }
        if device.source == Source::Spp {
            return self.query_buds(device, deadline, now);
        }
        let colls = match self.colls.lock() {
            Ok(m) => m.get(&device.key).cloned().unwrap_or_default(),
            Err(_) => return Outcome::Failed,
        };
        let mut timed_out = false;
        for c in &colls {
            match hid::read_battery(c, deadline) {
                Ok(p) => return Outcome::Read(Reading::new(Level::Exact(p), Charging::Unknown, now)),
                Err(TErr::Timeout) => {
                    timed_out = true;
                    break;
                }
                Err(_) => continue,
            }
        }
        if timed_out {
            Outcome::NoAnswer
        } else {
            Outcome::Failed
        }
    }
}

/// While alive, `on_change` is called (on a system thread) when any HID interface arrives or leaves.
pub struct ArrivalWatch {
    handle: ffi::HCMNOTIFICATION,
    ctx: *mut Box<dyn Fn() + Send + Sync>,
}

// (The handle and the boxed callback are only touched by Drop, after unregistering; the system calls the callback
// from its own threads, which Send + Sync allows.)
unsafe impl Send for ArrivalWatch {}

unsafe extern "system" fn on_notify(_h: ffi::HCMNOTIFICATION, ctx: *const std::ffi::c_void, action: i32, _data: *const std::ffi::c_void, _size: u32) -> u32 {
    // (CM_NOTIFY_ACTION_DEVICEINTERFACEARRIVAL 0, …REMOVAL 1.)
    if (action == 0 || action == 1) && !ctx.is_null() {
        let f = &*(ctx as *const Box<dyn Fn() + Send + Sync>);
        f();
    }
    0
}

pub fn watch_arrivals(on_change: Box<dyn Fn() + Send + Sync>) -> Option<ArrivalWatch> {
    let mut guid = ffi::GUID::default();
    unsafe { ffi::HidD_GetHidGuid(&mut guid) };
    let mut filter = ffi::CM_NOTIFY_FILTER { cbSize: std::mem::size_of::<ffi::CM_NOTIFY_FILTER>() as u32, Flags: 0, FilterType: ffi::CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE, Reserved: 0, u: [0; 200] };
    // (The union's DeviceInterface.ClassGuid: the GUID's 16 bytes at its start.)
    let gb: [u16; 8] = [
        guid.data1 as u16,
        (guid.data1 >> 16) as u16,
        guid.data2,
        guid.data3,
        u16::from_le_bytes([guid.data4[0], guid.data4[1]]),
        u16::from_le_bytes([guid.data4[2], guid.data4[3]]),
        u16::from_le_bytes([guid.data4[4], guid.data4[5]]),
        u16::from_le_bytes([guid.data4[6], guid.data4[7]]),
    ];
    filter.u[..8].copy_from_slice(&gb);
    let ctx: *mut Box<dyn Fn() + Send + Sync> = Box::into_raw(Box::new(on_change));
    let mut h: ffi::HCMNOTIFICATION = 0;
    let r = unsafe { ffi::CM_Register_Notification(&filter, ctx as *const std::ffi::c_void, on_notify, &mut h) };
    if r != ffi::CR_SUCCESS || h == 0 {
        unsafe { drop(Box::from_raw(ctx)) };
        return None;
    }
    Some(ArrivalWatch { handle: h, ctx })
}

impl Drop for ArrivalWatch {
    fn drop(&mut self) {
        // (Unregistering waits for callbacks in progress, so the box can go after.)
        unsafe {
            ffi::CM_Unregister_Notification(self.handle);
            drop(Box::from_raw(self.ctx));
        }
    }
}

