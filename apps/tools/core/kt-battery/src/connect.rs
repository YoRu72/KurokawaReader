// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery), piece 3: connecting Bluetooth devices from Tools.
// Written for Tools (nothing of Wireless Device Battery Monitor is in this file: the original has no connecting); the
// Windows calls it drives are in win/btconn.rs. Copyright (C) 2026 Kurokawa contributors. Std only.
// What it decides, tested here with fakes:
// - the list: the paired devices (classic, from the system's paired list; LE, from their device nodes), one per
//   address, with kind, picture, brand as text, connected or not, and the battery level the battery loop holds for it
//   (only while connected); a scan's new devices apart, never one already paired;
// - the order: connected first, then by name, unnamed last;
// - what a device offers: Connect / Disconnect where Windows lets a program do it (classic audio and HID), else the
//   system's own Bluetooth settings;
// - one action per device at a time, each with its own time limit, a way to cancel, and a late answer dropped;
// - a scan bounded in time, in short rounds (so «Stop» takes effect at once for the page and within a round for the
//   radio), one scanning thread at most;
// - every platform call on a thread of its own with a deadline (`with_deadline`): a stuck radio never holds the
//   caller past its limit.
use crate::bluetooth::{is_main_node, BtNode};
use crate::kind;
use crate::model::Kind;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// A Bluetooth address (48 bits) as a number.
pub type Addr = u64;

/// «AA:BB:CC:DD:EE:FF».
pub fn addr_text(a: Addr) -> String {
    let b = a.to_be_bytes();
    format!("{:02X}:{:02X}:{:02X}:{:02X}:{:02X}:{:02X}", b[2], b[3], b[4], b[5], b[6], b[7])
}

/// «AA:BB:CC:DD:EE:FF», «aa-bb-…» or twelve hex digits; nothing else (and never over 48 bits).
pub fn parse_addr(s: &str) -> Option<Addr> {
    let hex: String = s.trim().chars().filter(|c| *c != ':' && *c != '-').collect();
    if hex.len() != 12 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    u64::from_str_radix(&hex, 16).ok()
}

/// The address in a device node's instance id: «BTHENUM\DEV_AABBCCDDEEFF\…» (classic) or «BTHLE\DEV_AABBCCDDEEFF\…»
/// (LE); with whether it is LE. Service nodes and anything else: None.
pub fn addr_from_instance(id: &str) -> Option<(Addr, bool)> {
    if !is_main_node(id) {
        return None;
    }
    let u = id.to_ascii_uppercase();
    let le = u.starts_with("BTHLE\\");
    let rest = &u[u.find("\\DEV_")? + 5..];
    let hex: String = rest.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() < 12 {
        return None;
    }
    parse_addr(&hex[..12]).map(|a| (a, le))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Radio {
    On,
    /// A radio is there but turned off (or not taking connections).
    Off,
    /// No Bluetooth radio at all.
    Missing,
}

impl Radio {
    pub fn as_str(self) -> &'static str {
        match self {
            Radio::On => "on",
            Radio::Off => "off",
            Radio::Missing => "missing",
        }
    }
}

/// A service a classic device has installed, of those that matter here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Svc {
    /// A2DP sink (0x110B), Hands-Free (0x111E), Headset (0x1108): sound — connected through Windows' own audio
    /// reconnect.
    Audio,
    /// HID (0x1124): mice, keyboards, controllers — the device itself connects; the service is only (re)enabled.
    Hid,
}

/// The services this piece acts on, by their 16-bit UUID; any other (serial ports, file transfer, networking) never.
pub fn svc_of_uuid16(u: u16) -> Option<Svc> {
    match u {
        0x110B | 0x111E | 0x1108 => Some(Svc::Audio),
        0x1124 => Some(Svc::Hid),
        _ => None,
    }
}

/// A Bluetooth base UUID's 16-bit part, when the GUID is one («0000xxxx-0000-1000-8000-00805F9B34FB»).
pub fn uuid16_of(data1: u32, data2: u16, data3: u16, data4: [u8; 8]) -> Option<u16> {
    if data1 >> 16 == 0 && data2 == 0 && data3 == 0x1000 && data4 == [0x80, 0x00, 0x00, 0x80, 0x5F, 0x9B, 0x34, 0xFB] {
        Some(data1 as u16)
    } else {
        None
    }
}

/// A sound filter's device node, ranked for Windows' audio reconnect (A2DP first, then Hands-Free, then Headset); None
/// for anything that is not a Bluetooth sound node (win/btconn.rs opens only these, and only for the device's own
/// container).
pub fn audio_node_rank(instance_id: &str) -> Option<u8> {
    let u = instance_id.to_ascii_uppercase();
    if u.starts_with("BTHHFENUM\\") {
        return Some(1);
    }
    if !u.starts_with("BTHENUM\\") {
        return None;
    }
    if u.contains("{0000110B-") {
        Some(0)
    } else if u.contains("{0000111E-") {
        Some(1)
    } else if u.contains("{00001108-") {
        Some(2)
    } else {
        None
    }
}

/// An inquiry's length in the system's units (1.28 s), at least one, at most 48.
pub fn inquiry_units(ms: u64) -> u8 {
    ((ms + 1_279) / 1_280).clamp(1, 48) as u8
}

/// A classic device as the system's device search gave it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Classic {
    pub addr: Addr,
    pub name: String,
    pub cod: u32,
    pub connected: bool,
    pub remembered: bool,
    pub authenticated: bool,
    pub services: Vec<Svc>,
}

impl Classic {
    pub fn paired(&self) -> bool {
        self.authenticated || self.remembered
    }
}

/// What a device offers here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Can {
    /// Connect and disconnect from Tools.
    Both,
    /// Disconnect only (an HID device connects itself when used; Tools can only let go of it).
    DisconnectOnly,
    /// Only through Windows' Bluetooth settings (LE devices; devices with no sound or input service).
    Settings,
    /// Pair (a scan's new device).
    Pair,
}

impl Can {
    pub fn as_str(self) -> &'static str {
        match self {
            Can::Both => "both",
            Can::DisconnectOnly => "disconnectOnly",
            Can::Settings => "settings",
            Can::Pair => "pair",
        }
    }
}

/// One device of the panel.
#[derive(Clone, Debug, PartialEq)]
pub struct ConnDev {
    pub addr: Addr,
    pub name: String,
    pub kind: Kind,
    /// Our own drawing for it (the page's): headset, earbuds, mouse, keyboard, pad, retro, split, speaker, phone, pen,
    /// other — by kind and, for controllers, by the family its name tells; never by a maker's art.
    pub picture: &'static str,
    pub brand: String,
    pub le: bool,
    pub paired: bool,
    pub connected: bool,
    /// The physical device's container id, where a node gave one (the battery loop's key is «bt:» + it).
    pub container: Option<String>,
    /// The battery loop's current level for it, only while connected.
    pub battery: Option<u8>,
    pub can: Can,
}

/// The picture for a device: its kind, a controller's family from its name, a pen from its name or class.
pub fn picture_of(kind: Kind, name: &str, cod: u32) -> &'static str {
    let n = name.to_lowercase();
    let has = |s: &str| n.contains(s);
    // (Peripheral major class, minor «digitizer tablet» 0x05 / «digital pen» 0x07 in the low nibble.)
    let major = (cod >> 8) & 0x1F;
    let minor = (cod >> 2) & 0x0F;
    if has("pen") && !has("open") || has("stylus") || major == 0x05 && (minor == 0x05 || minor == 0x07) {
        return "pen";
    }
    match kind {
        Kind::Controller => {
            if has("joy-con") || has("joycon") || has("split") {
                "split"
            } else if has("sn30") || has("nes30") || has("snes") || has("zero") || has("retro") || has("micro") || has("genesis") || has("mega drive") {
                "retro"
            } else {
                "pad"
            }
        }
        Kind::Headset => "headset",
        Kind::Earbuds => "earbuds",
        Kind::Mouse => "mouse",
        Kind::Keyboard => "keyboard",
        Kind::Speaker => "speaker",
        Kind::Phone => "phone",
        Kind::Other => "other",
    }
}

fn kind_of(cod: u32, category: Option<&str>, name: &str) -> Kind {
    let mut k = if cod != 0 { kind::from_class_of_device(cod) } else { Kind::Other };
    if k == Kind::Other {
        if let Some(c) = category {
            k = kind::from_category(c);
        }
    }
    let g = kind::guess(name);
    if k == Kind::Other || (k == Kind::Headset && g == Kind::Earbuds) {
        k = g;
    }
    k
}

/// What a classic device offers from its services.
pub fn can_of(c: &Classic) -> Can {
    if c.services.contains(&Svc::Audio) {
        Can::Both
    } else if c.services.contains(&Svc::Hid) {
        Can::DisconnectOnly
    } else {
        Can::Settings
    }
}

/// The paired devices: every paired classic one, then every LE main node not already listed; one per address.
/// `levels`: the battery loop's (container, percent) for connected devices.
pub fn merge(classic: &[Classic], nodes: &[BtNode], levels: &[(String, u8)]) -> Vec<ConnDev> {
    let mut by: BTreeMap<Addr, ConnDev> = BTreeMap::new();
    // (Each node's address, container and category: the classic devices' containers, the LE devices themselves.)
    let mut node_of: BTreeMap<Addr, (bool, &BtNode)> = BTreeMap::new();
    for n in nodes {
        if let Some((a, le)) = addr_from_instance(&n.instance_id) {
            node_of.entry(a).or_insert((le, n));
        }
    }
    for c in classic.iter().filter(|c| c.paired() && c.addr != 0 && c.addr >> 48 == 0) {
        let node = node_of.get(&c.addr).map(|x| x.1);
        let name = if c.name.trim().is_empty() { node.map(|n| n.name.clone()).unwrap_or_default() } else { c.name.trim().to_string() };
        let kind = kind_of(c.cod, node.and_then(|n| n.category.as_deref()), &name);
        by.entry(c.addr).or_insert(ConnDev {
            addr: c.addr,
            picture: picture_of(kind, &name, c.cod),
            brand: kind::brand_of(0, &name, kind).to_string(),
            name,
            kind,
            le: false,
            paired: true,
            connected: c.connected,
            container: node.and_then(|n| n.container.clone()),
            battery: None,
            can: can_of(c),
        });
    }
    for (a, (le, n)) in &node_of {
        if !*le || by.contains_key(a) || n.problem {
            continue;
        }
        let name = n.name.trim().to_string();
        let kind = kind_of(n.class_of_device.unwrap_or(0), n.category.as_deref(), &name);
        by.insert(
            *a,
            ConnDev {
                addr: *a,
                picture: picture_of(kind, &name, n.class_of_device.unwrap_or(0)),
                brand: kind::brand_of(0, &name, kind).to_string(),
                name,
                kind,
                le: true,
                paired: true,
                connected: n.connected.unwrap_or(false),
                container: n.container.clone(),
                battery: None,
                can: Can::Settings,
            },
        );
    }
    let mut out: Vec<ConnDev> = by.into_values().collect();
    for d in out.iter_mut() {
        if d.connected {
            d.battery = d.container.as_ref().and_then(|c| levels.iter().find(|(k, _)| k.eq_ignore_ascii_case(c)).map(|x| x.1)).filter(|p| *p <= 100);
        }
    }
    sort(&mut out);
    out
}

/// Connected first, then by name (case ignored), unnamed last, then by address: the same list in the same order.
pub fn sort(list: &mut [ConnDev]) {
    list.sort_by(|a, b| {
        b.connected
            .cmp(&a.connected)
            .then_with(|| a.name.trim().is_empty().cmp(&b.name.trim().is_empty()))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.addr.cmp(&b.addr))
    });
}

/// A scan round's new devices added to those found so far: never one already paired; a name once known kept when a
/// later round has none.
pub fn add_found(found: &mut BTreeMap<Addr, ConnDev>, round: &[Classic], paired: &BTreeSet<Addr>) {
    for c in round {
        if c.addr == 0 || c.addr >> 48 != 0 || c.paired() || paired.contains(&c.addr) {
            continue;
        }
        let name = c.name.trim().to_string();
        let known = found.get(&c.addr).map(|d| d.name.clone()).unwrap_or_default();
        let name = if name.is_empty() { known } else { name };
        let kind = kind_of(c.cod, None, &name);
        found.insert(c.addr, ConnDev { addr: c.addr, picture: picture_of(kind, &name, c.cod), brand: kind::brand_of(0, &name, kind).to_string(), name, kind, le: false, paired: false, connected: false, container: None, battery: None, can: Can::Pair });
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Connect,
    Disconnect,
    Pair,
}

impl Op {
    pub fn as_str(self) -> &'static str {
        match self {
            Op::Connect => "connect",
            Op::Disconnect => "disconnect",
            Op::Pair => "pair",
        }
    }
    pub fn parse(s: &str) -> Option<Op> {
        match s {
            "connect" => Some(Op::Connect),
            "disconnect" => Some(Op::Disconnect),
            "pair" => Some(Op::Pair),
            _ => None,
        }
    }
}

/// How an action ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum End {
    Done,
    /// Windows (or the user, in Windows' own window) said no.
    Refused,
    TimedOut,
    /// The user stopped waiting here.
    Cancelled,
    /// The device did not answer: off, asleep or out of reach.
    Unreachable,
    /// Only Windows' Bluetooth settings can do this for this device.
    Settings,
    NoRadio,
    /// Another action on this device is running.
    Busy,
    /// Anything else, with Windows' error number.
    Failed(u32),
}

impl End {
    pub fn as_str(&self) -> &'static str {
        match self {
            End::Done => "ok",
            End::Refused => "refused",
            End::TimedOut => "timedOut",
            End::Cancelled => "cancelled",
            End::Unreachable => "unreachable",
            End::Settings => "settings",
            End::NoRadio => "noRadio",
            End::Busy => "busy",
            End::Failed(_) => "failed",
        }
    }
    pub fn code(&self) -> u32 {
        if let End::Failed(c) = self {
            *c
        } else {
            0
        }
    }
}

/// A Windows error number as an end (winerror.h).
pub fn end_of_win32(code: u32) -> End {
    match code {
        0 => End::Done,
        // ERROR_ACCESS_DENIED, ERROR_CANCELLED (the user closed Windows' window), ERROR_NOT_AUTHENTICATED.
        5 | 1223 | 1244 => End::Refused,
        // WAIT_TIMEOUT, ERROR_TIMEOUT, ERROR_SEM_TIMEOUT.
        258 | 1460 | 121 => End::TimedOut,
        // ERROR_DEVICE_NOT_CONNECTED, ERROR_NOT_FOUND, ERROR_GEN_FAILURE (the radio found nobody), ERROR_NOT_READY.
        1167 | 1168 | 31 | 21 => End::Unreachable,
        // ERROR_NOT_SUPPORTED, ERROR_INVALID_FUNCTION.
        50 | 1 => End::Settings,
        c => End::Failed(c),
    }
}

/// The time limits (ms). The defaults: connect 20 s, disconnect 10 s, pairing 120 s (the user answers Windows'
/// window), the paired list 4 s, a scan 20 s in rounds of about 5 s.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub connect_ms: u64,
    pub disconnect_ms: u64,
    pub pair_ms: u64,
    pub list_ms: u64,
    pub scan_ms: u64,
    pub round_ms: u64,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits { connect_ms: 20_000, disconnect_ms: 10_000, pair_ms: 120_000, list_ms: 4_000, scan_ms: 20_000, round_ms: 5_120 }
    }
}

impl Limits {
    pub fn of(&self, op: Op) -> u64 {
        match op {
            Op::Connect => self.connect_ms,
            Op::Disconnect => self.disconnect_ms,
            Op::Pair => self.pair_ms,
        }
    }
}

/// The longest scan the page may ask for, and the shortest.
pub const SCAN_MAX_MS: u64 = 60_000;
pub const SCAN_MIN_MS: u64 = 5_000;

/// One action running on a device.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Busy {
    pub op: Op,
    pub seq: u64,
    pub until: u64,
}

/// The actions running, one per device at most.
#[derive(Default, Debug)]
pub struct Ops {
    busy: BTreeMap<Addr, Busy>,
    seq: u64,
}

impl Ops {
    /// Started (its seq), or refused while another action runs on that device.
    pub fn start(&mut self, addr: Addr, op: Op, now: u64, limit_ms: u64) -> Result<u64, End> {
        if self.busy.contains_key(&addr) {
            return Err(End::Busy);
        }
        self.seq += 1;
        self.busy.insert(addr, Busy { op, seq: self.seq, until: now + limit_ms });
        Ok(self.seq)
    }
    /// Its end taken, if it is still the running one (a late or cancelled one: None).
    pub fn finish(&mut self, addr: Addr, seq: u64) -> bool {
        if self.busy.get(&addr).map_or(false, |b| b.seq == seq) {
            self.busy.remove(&addr);
            true
        } else {
            false
        }
    }
    /// The running action given up (its later answer dropped): its seq.
    pub fn cancel(&mut self, addr: Addr) -> Option<u64> {
        self.busy.remove(&addr).map(|b| b.seq)
    }
    /// Those past their limit, given up.
    pub fn expire(&mut self, now: u64) -> Vec<(Addr, u64)> {
        let late: Vec<(Addr, u64)> = self.busy.iter().filter(|(_, b)| now >= b.until).map(|(a, b)| (*a, b.seq)).collect();
        for (a, _) in &late {
            self.busy.remove(a);
        }
        late
    }
    pub fn running(&self) -> Vec<(Addr, Busy)> {
        self.busy.iter().map(|(a, b)| (*a, *b)).collect()
    }
}

/// The scan: bounded in time, its new devices.
#[derive(Default, Debug)]
pub struct Scan {
    running: Option<(u64, u64)>,
    seq: u64,
    pub found: BTreeMap<Addr, ConnDev>,
}

impl Scan {
    /// Started for `ms` (bounded), the earlier results cleared; asked again while running: the same scan, longer.
    pub fn start(&mut self, now: u64, ms: u64) -> u64 {
        let until = now + ms.clamp(SCAN_MIN_MS, SCAN_MAX_MS);
        if let Some((seq, u)) = self.running {
            self.running = Some((seq, u.max(until)));
            return seq;
        }
        self.seq += 1;
        self.found.clear();
        self.running = Some((self.seq, until));
        self.seq
    }
    pub fn stop(&mut self) -> bool {
        self.running.take().is_some()
    }
    /// The scan in progress and when it ends, ended first if its time is up.
    pub fn current(&mut self, now: u64) -> Option<(u64, u64)> {
        if let Some((_, until)) = self.running {
            if now >= until {
                self.running = None;
            }
        }
        self.running
    }
    pub fn until(&self) -> Option<u64> {
        self.running.map(|r| r.1)
    }
    /// A round's devices, taken only for the scan that asked (a stopped one's late round: dropped).
    pub fn round(&mut self, seq: u64, devices: &[Classic], paired: &BTreeSet<Addr>) -> bool {
        if self.running.map(|r| r.0) != Some(seq) {
            return false;
        }
        add_found(&mut self.found, devices, paired);
        true
    }
}

/// Why a call on its own thread gave no answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Late {
    TimedOut,
    /// No thread could be made.
    NoThread,
}

/// `f` on a thread of its own, waited for until `limit`: a stuck call is left to finish on its own (its answer
/// dropped), the caller goes on.
pub fn with_deadline<T: Send + 'static>(name: &str, limit: Duration, f: impl FnOnce() -> T + Send + 'static) -> Result<T, Late> {
    let (tx, rx) = mpsc::channel();
    let spawned = thread::Builder::new().name(name.into()).spawn(move || {
        let _ = tx.send(f());
    });
    if spawned.is_err() {
        return Err(Late::NoThread);
    }
    rx.recv_timeout(limit).map_err(|_| Late::TimedOut)
}

/// What the computer's Bluetooth can be asked. Each call may block (the radio); the caller (Conn) puts each on a
/// thread of its own with a deadline.
pub trait BtPlatform: Send + Sync + 'static {
    fn radio(&self) -> Radio;
    /// The paired classic devices (no inquiry: the system's own list), with their services.
    fn paired(&self) -> Vec<Classic>;
    /// The present Bluetooth device nodes (LE devices, containers, categories).
    fn nodes(&self) -> Vec<BtNode>;
    /// One inquiry round of about `ms`: the devices in range that answered.
    fn inquire(&self, ms: u64) -> Vec<Classic>;
    fn connect(&self, addr: Addr, deadline: Instant) -> End;
    fn disconnect(&self, addr: Addr, deadline: Instant) -> End;
    /// Pairing through Windows' own window (never a PIN of ours, never accepted for the user).
    fn pair(&self, addr: Addr, deadline: Instant) -> End;
}

/// What the page is shown: the radio, the paired devices, the scan's, the actions running (ms: the clock's).
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub radio: Radio,
    pub devices: Vec<ConnDev>,
    pub found: Vec<ConnDev>,
    pub scan_until: Option<u64>,
    pub busy: Vec<(Addr, Busy)>,
    /// The radio did not answer in time: the list is the last one.
    pub stale: bool,
    pub now: u64,
}

struct State {
    radio: Radio,
    classic: Vec<Classic>,
    nodes: Vec<BtNode>,
    levels: Vec<(String, u8)>,
    stale: bool,
    ops: Ops,
    scan: Scan,
    scanner: bool,
    waiters: BTreeMap<Addr, (u64, Sender<End>)>,
}

/// The connecting part: the list, the actions, the scan. Cheap to clone (shared state).
pub struct Conn<P: BtPlatform> {
    p: Arc<P>,
    st: Arc<Mutex<State>>,
    limits: Limits,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    publish: Arc<dyn Fn(Snapshot) + Send + Sync>,
}

impl<P: BtPlatform> Clone for Conn<P> {
    fn clone(&self) -> Conn<P> {
        Conn { p: self.p.clone(), st: self.st.clone(), limits: self.limits, clock: self.clock.clone(), publish: self.publish.clone() }
    }
}

impl<P: BtPlatform> Conn<P> {
    pub fn new(p: Arc<P>, limits: Limits, clock: Arc<dyn Fn() -> u64 + Send + Sync>, publish: Arc<dyn Fn(Snapshot) + Send + Sync>) -> Conn<P> {
        let st = State { radio: Radio::On, classic: Vec::new(), nodes: Vec::new(), levels: Vec::new(), stale: false, ops: Ops::default(), scan: Scan::default(), scanner: false, waiters: BTreeMap::new() };
        Conn { p, st: Arc::new(Mutex::new(st)), limits, clock, publish }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn snap_of(&self, s: &mut State) -> Snapshot {
        let now = (self.clock)();
        for (a, seq) in s.ops.expire(now) {
            if let Some((ws, tx)) = s.waiters.remove(&a) {
                if ws == seq {
                    let _ = tx.send(End::TimedOut);
                }
            }
        }
        let devices = merge(&s.classic, &s.nodes, &s.levels);
        let paired: BTreeSet<Addr> = devices.iter().map(|d| d.addr).collect();
        let mut found: Vec<ConnDev> = s.scan.found.values().filter(|d| !paired.contains(&d.addr)).cloned().collect();
        sort(&mut found);
        Snapshot { radio: s.radio, devices, found, scan_until: s.scan.current(now).map(|r| r.1), busy: s.ops.running(), stale: s.stale, now }
    }

    pub fn snapshot(&self) -> Snapshot {
        let mut s = self.lock();
        self.snap_of(&mut s)
    }

    fn push(&self) {
        let snap = self.snapshot();
        (self.publish)(snap);
    }

    /// The battery loop's levels by container (for connected devices).
    pub fn set_levels(&self, levels: Vec<(String, u8)>) {
        self.lock().levels = levels;
    }

    /// The radio and the paired list read again (on their own thread, within the list's limit; a radio that does not
    /// answer leaves the last list, marked stale).
    pub fn refresh(&self) -> Snapshot {
        let p = self.p.clone();
        let got = with_deadline("kt-bt-list", Duration::from_millis(self.limits.list_ms), move || {
            let r = p.radio();
            if r == Radio::On {
                (r, p.paired(), p.nodes())
            } else {
                (r, Vec::new(), p.nodes())
            }
        });
        {
            let mut s = self.lock();
            match got {
                Ok((r, c, n)) => {
                    s.radio = r;
                    s.classic = c;
                    s.nodes = n;
                    s.stale = false;
                    if r != Radio::On {
                        s.scan.stop();
                    }
                }
                Err(_) => s.stale = true,
            }
        }
        self.push();
        self.snapshot()
    }

    /// One action on one device, waited for: its end (the result of the device, a time-out, or the user's cancel).
    /// Blocks the calling thread (the shell's worker), never longer than the action's limit.
    pub fn act(&self, addr: Addr, op: Op) -> End {
        let limit = self.limits.of(op);
        let (tx, rx) = mpsc::channel::<End>();
        let seq = {
            let mut s = self.lock();
            if s.radio != Radio::On {
                return End::NoRadio;
            }
            // (What the device offers decides: a request it does not offer is the settings' to do.)
            let devices = merge(&s.classic, &s.nodes, &s.levels);
            let can = devices.iter().find(|d| d.addr == addr).map(|d| d.can).or_else(|| s.scan.found.get(&addr).map(|d| d.can));
            let allowed = match (op, can) {
                (Op::Pair, Some(Can::Pair)) => true,
                (Op::Connect, Some(Can::Both)) => true,
                (Op::Disconnect, Some(Can::Both | Can::DisconnectOnly)) => true,
                (_, None) => return End::Unreachable,
                _ => false,
            };
            if !allowed {
                return End::Settings;
            }
            let now = (self.clock)();
            // (No inquiry while Windows pairs: the scan ends when a pairing starts.)
            if op == Op::Pair {
                s.scan.stop();
            }
            match s.ops.start(addr, op, now, limit) {
                Ok(seq) => {
                    s.waiters.insert(addr, (seq, tx.clone()));
                    seq
                }
                Err(e) => return e,
            }
        };
        self.push();
        let p = self.p.clone();
        let deadline = Instant::now() + Duration::from_millis(limit);
        let spawned = thread::Builder::new().name("kt-bt-act".into()).spawn(move || {
            let end = match op {
                Op::Connect => p.connect(addr, deadline),
                Op::Disconnect => p.disconnect(addr, deadline),
                Op::Pair => p.pair(addr, deadline),
            };
            let _ = tx.send(end);
        });
        let end = if spawned.is_err() { End::Failed(0) } else { rx.recv_timeout(Duration::from_millis(limit)).unwrap_or(End::TimedOut) };
        let taken = {
            let mut s = self.lock();
            if s.waiters.get(&addr).map_or(false, |w| w.0 == seq) {
                s.waiters.remove(&addr);
            }
            s.ops.finish(addr, seq)
        };
        // (Cancelled meanwhile: the cancel's end, whatever came after.)
        let end = if !taken && end != End::TimedOut { End::Cancelled } else { end };
        if end == End::Done {
            // (The list after a change: connected, disconnected or newly paired.)
            let _ = self.refresh();
            if op == Op::Pair {
                self.lock().scan.found.remove(&addr);
                self.push();
            }
        } else {
            self.push();
        }
        end
    }

    /// The running action on `addr` given up: its caller told «cancelled» at once; the radio's call ends on its own.
    pub fn cancel(&self, addr: Addr) -> bool {
        let done = {
            let mut s = self.lock();
            let seq = s.ops.cancel(addr);
            if let (Some(seq), Some((ws, tx))) = (seq, s.waiters.remove(&addr)) {
                if ws == seq {
                    let _ = tx.send(End::Cancelled);
                }
            }
            seq.is_some()
        };
        if done {
            self.push();
        }
        done
    }

    /// A scan for `ms` (bounded): new devices published as each round brings them; one scanning thread at most.
    pub fn scan_start(&self, ms: u64) -> Snapshot {
        let spawn = {
            let mut s = self.lock();
            if s.radio != Radio::On {
                return self.snap_of(&mut s);
            }
            let now = (self.clock)();
            s.scan.start(now, ms);
            let spawn = !s.scanner;
            s.scanner = true;
            spawn
        };
        if spawn {
            let me = self.clone();
            let ok = thread::Builder::new().name("kt-bt-scan".into()).spawn(move || me.scan_loop()).is_ok();
            if !ok {
                let mut s = self.lock();
                s.scanner = false;
                s.scan.stop();
            }
        }
        self.push();
        self.snapshot()
    }

    fn scan_loop(&self) {
        loop {
            let seq = {
                let mut s = self.lock();
                let now = (self.clock)();
                match s.scan.current(now) {
                    Some((seq, _)) => seq,
                    None => {
                        s.scanner = false;
                        break;
                    }
                }
            };
            let p = self.p.clone();
            let round = self.limits.round_ms;
            let got = with_deadline("kt-bt-inquiry", Duration::from_millis(round + 3_000), move || p.inquire(round));
            let taken = {
                let mut s = self.lock();
                let paired: BTreeSet<Addr> = s.classic.iter().filter(|c| c.paired()).map(|c| c.addr).collect();
                match got {
                    Ok(list) => s.scan.round(seq, &list, &paired),
                    // (A round that did not come back in time: the radio is stuck — the scan ends.)
                    Err(_) => {
                        s.scan.stop();
                        true
                    }
                }
            };
            if taken {
                self.push();
            }
        }
        self.push();
    }

    pub fn scan_stop(&self) -> Snapshot {
        self.lock().scan.stop();
        self.push();
        self.snapshot()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    const A1: Addr = 0x0011_2233_4455;
    const A2: Addr = 0xAABB_CCDD_EEFF;
    const A3: Addr = 0x0010_2030_4050;

    fn classic(addr: Addr, name: &str, cod: u32, connected: bool, paired: bool, services: &[Svc]) -> Classic {
        Classic { addr, name: name.into(), cod, connected, remembered: paired, authenticated: paired, services: services.to_vec() }
    }

    #[test]
    fn addresses() {
        assert_eq!(addr_text(A1), "00:11:22:33:44:55");
        assert_eq!(parse_addr("00:11:22:33:44:55"), Some(A1));
        assert_eq!(parse_addr("aa-bb-cc-dd-ee-ff"), Some(0xAABB_CCDD_EEFF));
        assert_eq!(parse_addr("001122334455"), Some(A1));
        for bad in ["", "00:11:22:33:44", "00:11:22:33:44:55:66", "zz:11:22:33:44:55", "0x1122334455"] {
            assert_eq!(parse_addr(bad), None, "{bad}");
        }
        assert_eq!(addr_from_instance("BTHENUM\\DEV_001122334455\\7&2A&0&BLUETOOTHDEVICE_001122334455"), Some((A1, false)));
        assert_eq!(addr_from_instance("BTHLE\\Dev_aabbccddeeff\\8&1"), Some((A2, true)));
        assert_eq!(addr_from_instance("BTHENUM\\{0000110B-0000-1000-8000-00805F9B34FB}_X\\1"), None, "a service node");
        assert_eq!(addr_from_instance("BTHLE\\DEV_12\\1"), None);
        assert_eq!(addr_from_instance("USB\\VID_1"), None);
    }

    #[test]
    fn services_and_uuids() {
        let base = [0x80, 0x00, 0x00, 0x80, 0x5F, 0x9B, 0x34, 0xFB];
        assert_eq!(uuid16_of(0x110B, 0, 0x1000, base), Some(0x110B));
        assert_eq!(uuid16_of(0x1_110B, 0, 0x1000, base), None);
        assert_eq!(uuid16_of(0x110B, 0, 0x1000, [0; 8]), None);
        assert_eq!(svc_of_uuid16(0x110B), Some(Svc::Audio));
        assert_eq!(svc_of_uuid16(0x111E), Some(Svc::Audio));
        assert_eq!(svc_of_uuid16(0x1124), Some(Svc::Hid));
        for other in [0x1101u16, 0x1105, 0x1115, 0x110E] {
            assert_eq!(svc_of_uuid16(other), None, "serial, file transfer, networking, remote control: never touched");
        }
    }

    #[test]
    fn sound_nodes_and_inquiry_units() {
        assert_eq!(audio_node_rank("BTHENUM\\{0000110b-0000-1000-8000-00805f9b34fb}_VID&0002_PID&1\\7&1&0&001122334455_C00000000"), Some(0));
        assert_eq!(audio_node_rank("BTHENUM\\{0000111E-0000-1000-8000-00805F9B34FB}_LOCALMFG&0\\7&1"), Some(1));
        assert_eq!(audio_node_rank("BTHHFENUM\\BthHFPAudio\\8&1"), Some(1));
        assert_eq!(audio_node_rank("BTHENUM\\{00001124-0000-1000-8000-00805F9B34FB}_X\\1"), None, "HID is no sound node");
        assert_eq!(audio_node_rank("USB\\VID_1&PID_2\\{0000110B-"), None);
        assert_eq!(inquiry_units(0), 1);
        assert_eq!(inquiry_units(5_120), 4);
        assert_eq!(inquiry_units(5_121), 5);
        assert_eq!(inquiry_units(999_999), 48);
    }

    #[test]
    fn pictures_by_kind_and_family() {
        assert_eq!(picture_of(Kind::Controller, "Wireless Controller", 0x2508), "pad");
        assert_eq!(picture_of(Kind::Controller, "Joy-Con (L)", 0x2508), "split");
        assert_eq!(picture_of(Kind::Controller, "8BitDo SN30 Pro", 0x2508), "retro");
        assert_eq!(picture_of(Kind::Controller, "Xbox Elite Wireless Controller", 0x2508), "pad", "«elite» is no retro pad");
        assert_eq!(picture_of(Kind::Other, "Surface Pen", 0), "pen");
        assert_eq!(picture_of(Kind::Other, "Desk Stylus", 0), "pen");
        assert_eq!(picture_of(Kind::Speaker, "Open Air Speaker", 0x240414), "speaker", "«open» is no pen");
        assert_eq!(picture_of(Kind::Other, "", 0x0514), "pen", "peripheral, digitizer");
        assert_eq!(picture_of(Kind::Earbuds, "Pocket Buds", 0), "earbuds");
        assert_eq!(picture_of(Kind::Other, "Thing", 0), "other");
    }

    #[test]
    fn merged_list_one_per_address_with_kinds_levels_and_order() {
        let cl = [
            classic(A1, "Studio Phones", 0x240404, true, true, &[Svc::Audio]),
            classic(A3, "Travel Keys", 0x002540, false, true, &[Svc::Hid]),
            classic(0x00FF_FFFF_FFFF, "Stranger", 0x240404, false, false, &[]),
            classic(0x0100_0000_0000_0000, "Too wide", 0, true, true, &[]),
        ];
        let nodes = [
            BtNode { instance_id: "BTHENUM\\DEV_001122334455\\7&1".into(), container: Some("{C1}".into()), name: "Studio Phones".into(), connected: Some(true), ..Default::default() },
            BtNode { instance_id: "BTHLE\\DEV_AABBCCDDEEFF\\8&1".into(), container: Some("{C2}".into()), name: "Shape Mouse".into(), category: Some("Input.Mouse".into()), connected: Some(true), ..Default::default() },
            BtNode { instance_id: "BTHLE\\DEV_102030405060\\8&1".into(), container: Some("{C3}".into()), name: "".into(), connected: Some(false), ..Default::default() },
            BtNode { instance_id: "BTHLE\\DEV_0A0B0C0D0E0F\\8&1".into(), name: "Broken".into(), problem: true, ..Default::default() },
        ];
        let levels = vec![("{c1}".to_string(), 64), ("{C2}".to_string(), 150), ("{C3}".to_string(), 30)];
        let got = merge(&cl, &nodes, &levels);
        let names: Vec<&str> = got.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, vec!["Shape Mouse", "Studio Phones", "Travel Keys", ""], "connected first, by name, unnamed last");
        let phones = got.iter().find(|d| d.addr == A1).unwrap();
        assert_eq!((phones.kind, phones.picture, phones.can, phones.le, phones.battery), (Kind::Headset, "headset", Can::Both, false, Some(64)));
        assert_eq!(phones.container.as_deref(), Some("{C1}"));
        let mouse = got.iter().find(|d| d.addr == A2).unwrap();
        assert_eq!((mouse.kind, mouse.le, mouse.can, mouse.battery), (Kind::Mouse, true, Can::Settings, None), "LE: Windows' settings; a level over 100 dropped");
        let keys = got.iter().find(|d| d.addr == A3).unwrap();
        assert_eq!((keys.kind, keys.can, keys.connected, keys.battery), (Kind::Keyboard, Can::DisconnectOnly, false, None), "classic wins over the LE node of one address; no level while not connected");
        assert!(got.iter().all(|d| d.paired));
        assert_eq!(got.len(), 4, "the stranger, the too-wide address and the broken node are not listed");
    }

    #[test]
    fn found_devices_never_paired_ones_and_names_kept() {
        let mut found = BTreeMap::new();
        let paired: BTreeSet<Addr> = [A1].into_iter().collect();
        add_found(&mut found, &[classic(A1, "Mine", 0, false, false, &[]), classic(A2, "Field Pad", 0x002508, false, false, &[]), classic(A3, "Paired", 0, false, true, &[])], &paired);
        assert_eq!(found.keys().copied().collect::<Vec<_>>(), vec![A2]);
        add_found(&mut found, &[classic(A2, "", 0x002508, false, false, &[])], &paired);
        assert_eq!(found[&A2].name, "Field Pad", "a later round without a name keeps it");
        assert_eq!((found[&A2].picture, found[&A2].can), ("pad", Can::Pair));
    }

    #[test]
    fn ops_one_per_device_cancel_late_and_expiry() {
        let mut o = Ops::default();
        let s1 = o.start(A1, Op::Connect, 0, 1_000).unwrap();
        assert_eq!(o.start(A1, Op::Disconnect, 10, 1_000), Err(End::Busy));
        let s2 = o.start(A2, Op::Pair, 10, 5_000).unwrap();
        assert_eq!(o.cancel(A1), Some(s1));
        assert!(!o.finish(A1, s1), "a cancelled action's late answer is dropped");
        let s3 = o.start(A1, Op::Connect, 20, 1_000).unwrap();
        assert!(!o.finish(A1, s1), "an older seq never ends the newer action");
        assert_eq!(o.expire(1_019), vec![]);
        assert_eq!(o.expire(1_020), vec![(A1, s3)]);
        assert_eq!(o.running(), vec![(A2, Busy { op: Op::Pair, seq: s2, until: 5_010 })]);
        assert!(o.finish(A2, s2));
        assert!(o.running().is_empty());
    }

    #[test]
    fn scan_is_bounded_and_a_stopped_scans_round_is_dropped() {
        let mut s = Scan::default();
        let q = s.start(0, 999_999);
        assert_eq!(s.until(), Some(SCAN_MAX_MS));
        assert_eq!(s.start(100, 1), q, "asked again while running: the same scan");
        assert!(s.round(q, &[classic(A2, "Pad", 0, false, false, &[])], &BTreeSet::new()));
        assert!(s.stop());
        assert!(!s.round(q, &[classic(A3, "Late", 0, false, false, &[])], &BTreeSet::new()));
        assert_eq!(s.found.len(), 1);
        let q2 = s.start(1_000, 20_000);
        assert_ne!(q, q2);
        assert!(s.found.is_empty(), "a new scan starts empty");
        assert_eq!(s.current(20_999), Some((q2, 21_000)));
        assert_eq!(s.current(21_000), None, "over at its time");
        assert_eq!(s.start(0, 0), q2 + 1);
        assert_eq!(s.until(), Some(SCAN_MIN_MS));
    }

    #[test]
    fn windows_errors_in_plain_ends() {
        assert_eq!(end_of_win32(0), End::Done);
        assert_eq!(end_of_win32(1223), End::Refused);
        assert_eq!(end_of_win32(5), End::Refused);
        assert_eq!(end_of_win32(1460), End::TimedOut);
        assert_eq!(end_of_win32(1167), End::Unreachable);
        assert_eq!(end_of_win32(50), End::Settings);
        assert_eq!(end_of_win32(87), End::Failed(87));
        assert_eq!(End::Failed(87).code(), 87);
        assert_eq!(Op::parse("pair"), Some(Op::Pair));
        assert_eq!(Op::parse("unpair"), None);
    }

    #[test]
    fn with_deadline_gives_up_on_a_stuck_call() {
        let t = Instant::now();
        assert_eq!(with_deadline("t", Duration::from_millis(80), || { thread::sleep(Duration::from_millis(600)); 1 }), Err(Late::TimedOut));
        assert!(t.elapsed() < Duration::from_millis(400));
        assert_eq!(with_deadline("t", Duration::from_millis(500), || 7), Ok(7));
    }

    // ---- Conn over a fake platform ----

    #[derive(Default)]
    struct Fake {
        radio: Mutex<Option<Radio>>,
        paired: Mutex<Vec<Classic>>,
        nearby: Mutex<Vec<Classic>>,
        /// connect: how long it takes, then its end.
        connect: Mutex<(u64, Option<End>)>,
        pair_end: Mutex<Option<End>>,
        list_delay: AtomicU64,
        rounds: AtomicUsize,
        connects: AtomicUsize,
    }

    impl BtPlatform for Fake {
        fn radio(&self) -> Radio {
            thread::sleep(Duration::from_millis(self.list_delay.load(Ordering::SeqCst)));
            self.radio.lock().unwrap().unwrap_or(Radio::On)
        }
        fn paired(&self) -> Vec<Classic> {
            self.paired.lock().unwrap().clone()
        }
        fn nodes(&self) -> Vec<BtNode> {
            Vec::new()
        }
        fn inquire(&self, ms: u64) -> Vec<Classic> {
            self.rounds.fetch_add(1, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(ms));
            self.nearby.lock().unwrap().clone()
        }
        fn connect(&self, addr: Addr, _deadline: Instant) -> End {
            self.connects.fetch_add(1, Ordering::SeqCst);
            let (ms, end) = self.connect.lock().unwrap().clone();
            thread::sleep(Duration::from_millis(ms));
            let end = end.unwrap_or(End::Done);
            if end == End::Done {
                for c in self.paired.lock().unwrap().iter_mut().filter(|c| c.addr == addr) {
                    c.connected = true;
                }
            }
            end
        }
        fn disconnect(&self, _addr: Addr, _deadline: Instant) -> End {
            End::Done
        }
        fn pair(&self, addr: Addr, _deadline: Instant) -> End {
            let end = self.pair_end.lock().unwrap().clone().unwrap_or(End::Done);
            if end == End::Done {
                let mut c = self.nearby.lock().unwrap().iter().find(|c| c.addr == addr).cloned().unwrap();
                c.authenticated = true;
                self.paired.lock().unwrap().push(c);
            }
            end
        }
    }

    fn rig(f: Fake, limits: Limits) -> (Arc<Fake>, Conn<Fake>, Arc<Mutex<Vec<Snapshot>>>) {
        let f = Arc::new(f);
        let seen: Arc<Mutex<Vec<Snapshot>>> = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        let t0 = Instant::now();
        let c = Conn::new(f.clone(), limits, Arc::new(move || t0.elapsed().as_millis() as u64), Arc::new(move |s| s2.lock().unwrap().push(s)));
        (f, c, seen)
    }

    fn quick() -> Limits {
        Limits { connect_ms: 300, disconnect_ms: 300, pair_ms: 300, list_ms: 200, scan_ms: 400, round_ms: 60 }
    }

    #[test]
    fn connect_ok_refused_timed_out_and_cancelled() {
        let f = Fake::default();
        *f.paired.lock().unwrap() = vec![classic(A1, "Studio Phones", 0x240404, false, true, &[Svc::Audio]), classic(A3, "Travel Keys", 0x002540, false, true, &[Svc::Hid])];
        let (f, c, seen) = rig(f, quick());
        let snap = c.refresh();
        assert_eq!(snap.radio, Radio::On);
        assert_eq!(snap.devices.len(), 2);
        assert_eq!(c.act(A1, Op::Connect), End::Done);
        assert!(c.snapshot().devices.iter().find(|d| d.addr == A1).unwrap().connected, "the list read again after it");
        assert!(seen.lock().unwrap().iter().any(|s| s.busy.iter().any(|(a, b)| *a == A1 && b.op == Op::Connect)), "the busy row was published");
        assert_eq!(c.act(A3, Op::Connect), End::Settings, "an HID device connects itself: not offered");
        assert_eq!(f.connects.load(Ordering::SeqCst), 1, "and the radio never asked");
        assert_eq!(c.act(0x0000_0000_0001, Op::Connect), End::Unreachable, "a device not listed");
        *f.connect.lock().unwrap() = (0, Some(End::Refused));
        assert_eq!(c.act(A1, Op::Disconnect), End::Done);
        assert_eq!(c.act(A1, Op::Connect), End::Refused);
        // Timed out: the radio sits on it past the limit; the caller is free at the limit.
        *f.connect.lock().unwrap() = (2_000, None);
        let t = Instant::now();
        assert_eq!(c.act(A1, Op::Connect), End::TimedOut);
        assert!(t.elapsed() < Duration::from_millis(900), "{:?}", t.elapsed());
        assert!(c.snapshot().busy.is_empty(), "no busy row left behind");
        // Cancelled: from another thread while it runs.
        let c2 = c.clone();
        let h = thread::spawn(move || c2.act(A1, Op::Connect));
        thread::sleep(Duration::from_millis(60));
        assert_eq!(c.act(A1, Op::Connect), End::Busy, "one action per device");
        assert!(c.cancel(A1));
        let t = Instant::now();
        assert_eq!(h.join().unwrap(), End::Cancelled);
        assert!(t.elapsed() < Duration::from_millis(300), "the cancel answers at once");
        assert!(!c.cancel(A1), "nothing left to cancel");
    }

    #[test]
    fn radio_off_and_stuck_radio() {
        let f = Fake::default();
        *f.radio.lock().unwrap() = Some(Radio::Off);
        let (f, c, _) = rig(f, quick());
        let s = c.refresh();
        assert_eq!((s.radio, s.devices.len(), s.stale), (Radio::Off, 0, false));
        assert_eq!(c.act(A1, Op::Connect), End::NoRadio);
        assert_eq!(c.scan_start(20_000).scan_until, None, "no scan without a radio");
        *f.radio.lock().unwrap() = Some(Radio::On);
        f.list_delay.store(1_500, Ordering::SeqCst);
        let t = Instant::now();
        let s = c.refresh();
        assert!(t.elapsed() < Duration::from_millis(700), "a stuck radio never holds the list past its limit");
        assert!(s.stale && s.radio == Radio::Off, "the last list kept, marked stale");
    }

    #[test]
    fn scan_finds_stops_and_pairs_through_the_system() {
        let f = Fake::default();
        *f.paired.lock().unwrap() = vec![classic(A1, "Studio Phones", 0x240404, true, true, &[Svc::Audio])];
        *f.nearby.lock().unwrap() = vec![classic(A2, "Field Pad", 0x002508, false, false, &[]), classic(A1, "Studio Phones", 0x240404, true, false, &[])];
        let (f, c, seen) = rig(f, quick());
        c.refresh();
        let s = c.scan_start(400);
        assert!(s.scan_until.is_some());
        // (Asked twice: one scanning thread.)
        c.scan_start(400);
        thread::sleep(Duration::from_millis(200));
        let s = c.snapshot();
        assert_eq!(s.found.iter().map(|d| d.addr).collect::<Vec<_>>(), vec![A2], "the paired one is not «new»");
        assert!(c.scan_stop().scan_until.is_none());
        let rounds = f.rounds.load(Ordering::SeqCst);
        thread::sleep(Duration::from_millis(200));
        assert!(f.rounds.load(Ordering::SeqCst) <= rounds + 1, "stopped: at most the round in progress finishes");
        assert!(rounds >= 1 && rounds <= 6, "{rounds}");
        // Pairing: through the platform's pair (Windows' own window), the new device then paired and off the found list.
        *f.pair_end.lock().unwrap() = Some(End::Refused);
        assert_eq!(c.act(A2, Op::Pair), End::Refused, "declined in Windows' window");
        assert_eq!(c.act(A1, Op::Pair), End::Settings, "a paired device is not paired again");
        *f.pair_end.lock().unwrap() = None;
        c.scan_start(5_000);
        thread::sleep(Duration::from_millis(150));
        assert_eq!(c.act(A2, Op::Pair), End::Done);
        assert!(c.snapshot().scan_until.is_none(), "a pairing ends the scan (no inquiry while Windows pairs)");
        let s = c.snapshot();
        assert!(s.found.is_empty() && s.devices.iter().any(|d| d.addr == A2 && d.paired));
        assert!(seen.lock().unwrap().len() >= 4);
        // A scan ends by itself at its time.
        let s = c.scan_start(5_000);
        assert!(s.scan_until.unwrap() >= s.now + SCAN_MIN_MS - 5);
        c.scan_stop();
    }
}
