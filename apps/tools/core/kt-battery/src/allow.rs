// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the ONE table of what may ever be sent to a device.
// Written for Kurokawa Tools against Wireless Device Battery Monitor's fault (NOTICE.md; PLAN-battery §9.2): its readers
// called themselves read-only but sent dozens of commands, one undocumented command to about ninety receiver ids, some
// under other makers' vendor ids. Here a write is possible only as an `AllowedWrite`, and only `permit` makes one: for a
// device this table names exactly (vendor AND product, plus usage page / usage / interface where given), with exactly the
// bytes the table lists. The transport (transport.rs) sends nothing else and opens a device for writing only when the
// table has an entry for it. Piece 1's readers only read. Piece 4 (controllers) adds four families' status requests,
// each one that only asks (no mode, light, rumble, pairing, calibration or firmware path); pads/*.rs send them only
// once the user turned that family's reading on.
// Copyright (C) 2026 Kurokawa contributors. Std only.

/// What identifies one HID collection of a device.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct HidIdent {
    pub vid: u16,
    pub pid: u16,
    /// The collection's top-level usage page and usage.
    pub usage_page: u16,
    pub usage: u16,
    /// The USB interface number («MI_xx» in its path), -1 when not known.
    pub interface: i32,
}

/// A rule naming devices. The product id is not optional: a device is never matched by its vendor alone (the
/// original claimed whole vendor ids, other makers' among them).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeviceMatch {
    pub vid: u16,
    pub pid: u16,
    pub usage_page: Option<u16>,
    pub usage: Option<u16>,
    pub interface: Option<i32>,
}

impl DeviceMatch {
    pub const fn product(vid: u16, pid: u16) -> DeviceMatch {
        DeviceMatch { vid, pid, usage_page: None, usage: None, interface: None }
    }
    pub fn matches(&self, id: &HidIdent) -> bool {
        self.vid == id.vid
            && self.pid == id.pid
            && self.usage_page.map_or(true, |p| p == id.usage_page)
            && self.usage.map_or(true, |u| u == id.usage)
            && self.interface.map_or(true, |i| i == id.interface)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReportKind {
    Output,
    Feature,
}

/// One allowed request: to these devices, this kind of report, these bytes exactly (the report id first; the
/// transport pads with zeros to the report's length). `why` names the public document the bytes come from.
pub struct AllowEntry {
    pub device: DeviceMatch,
    pub kind: ReportKind,
    pub bytes: &'static [u8],
    pub why: &'static str,
}

const fn on(vid: u16, pid: u16, page: u16, usage: Option<u16>) -> DeviceMatch {
    DeviceMatch { vid, pid, usage_page: Some(page), usage, interface: None }
}

const E8: &str = "8BitDo Ultimate 2 vendor channel, a status request (MiguelSanzBr/8bitdo-ultimate2-linux docs/PROTOCOL.md): asks, sets nothing";
const GS: &str = "GameSir Nova «device info» request, as GameSir's own app sends it (GamesirBatteryTray): asks, sets nothing";
const FD: &str = "Flydigi Vader 5 Pro architecture / info request (SDL_hidapi_flydigi.c): asks, no takeover, no setting";
const BT: &str = "BEITONG KP20 «get base info» request, as iControl sends it for its home page: asks, no config mode";

/// The table. The generic readers (HID battery fields, Windows' Bluetooth property, Xbox through Windows) and the
/// passive controller readers never write. Only these requests exist (output reports, the report id first):
/// - 8BitDo Ultimate 2 (receiver 310B, idle receiver 6013, the pad on its cable 6012), page FF7A usage 1: «linked?»
///   81 04 20 01, «battery» 81 04 21 01 00 00 06, «info» 81 04 00 01.
/// - GameSir Nova (receivers 1098, 1040; cable 100F), page FF7A: «device info» 00 01 01.
/// - Flydigi Vader 5 Pro (2401), page FFA0 usage 1: «architecture» 00 5A A5 07 00 00, «info» 00 5A A5 01 02 00.
/// - BEITONG KP20 receiver (5128), page 00FF usage 3: «base info» 02 AD (02 15 in its cipher).
/// - D1 (the original's v1.1.0): Flydigi Apex 5 (2501), the Vader's two requests as output report 03; BEITONG KP40D
///   receiver (515C), KP20's request.
pub static ALLOWED: &[AllowEntry] = &[
    AllowEntry { device: on(0x2DC8, 0x310B, 0xFF7A, Some(1)), kind: ReportKind::Output, bytes: &[0x81, 0x04, 0x20, 0x01], why: E8 },
    AllowEntry { device: on(0x2DC8, 0x310B, 0xFF7A, Some(1)), kind: ReportKind::Output, bytes: &[0x81, 0x04, 0x21, 0x01, 0x00, 0x00, 0x06], why: E8 },
    AllowEntry { device: on(0x2DC8, 0x310B, 0xFF7A, Some(1)), kind: ReportKind::Output, bytes: &[0x81, 0x04, 0x00, 0x01], why: E8 },
    AllowEntry { device: on(0x2DC8, 0x6013, 0xFF7A, Some(1)), kind: ReportKind::Output, bytes: &[0x81, 0x04, 0x20, 0x01], why: E8 },
    AllowEntry { device: on(0x2DC8, 0x6013, 0xFF7A, Some(1)), kind: ReportKind::Output, bytes: &[0x81, 0x04, 0x21, 0x01, 0x00, 0x00, 0x06], why: E8 },
    AllowEntry { device: on(0x2DC8, 0x6013, 0xFF7A, Some(1)), kind: ReportKind::Output, bytes: &[0x81, 0x04, 0x00, 0x01], why: E8 },
    AllowEntry { device: on(0x2DC8, 0x6012, 0xFF7A, Some(1)), kind: ReportKind::Output, bytes: &[0x81, 0x04, 0x20, 0x01], why: E8 },
    AllowEntry { device: on(0x2DC8, 0x6012, 0xFF7A, Some(1)), kind: ReportKind::Output, bytes: &[0x81, 0x04, 0x21, 0x01, 0x00, 0x00, 0x06], why: E8 },
    AllowEntry { device: on(0x2DC8, 0x6012, 0xFF7A, Some(1)), kind: ReportKind::Output, bytes: &[0x81, 0x04, 0x00, 0x01], why: E8 },
    AllowEntry { device: on(0x3537, 0x1098, 0xFF7A, None), kind: ReportKind::Output, bytes: &[0x00, 0x01, 0x01], why: GS },
    AllowEntry { device: on(0x3537, 0x1040, 0xFF7A, None), kind: ReportKind::Output, bytes: &[0x00, 0x01, 0x01], why: GS },
    AllowEntry { device: on(0x3537, 0x100F, 0xFF7A, None), kind: ReportKind::Output, bytes: &[0x00, 0x01, 0x01], why: GS },
    AllowEntry { device: on(0x37D7, 0x2401, 0xFFA0, Some(1)), kind: ReportKind::Output, bytes: &[0x00, 0x5A, 0xA5, 0x07, 0x00, 0x00], why: FD },
    AllowEntry { device: on(0x37D7, 0x2401, 0xFFA0, Some(1)), kind: ReportKind::Output, bytes: &[0x00, 0x5A, 0xA5, 0x01, 0x02, 0x00], why: FD },
    AllowEntry { device: on(0x20BC, 0x5128, 0x00FF, Some(3)), kind: ReportKind::Output, bytes: &[0x02, 0xAD], why: BT },
    // (D1, the original's v1.1.0: the Flydigi Apex 5 — the same requests as output report 03 —, the BEITONG KP40D receiver.)
    AllowEntry { device: on(0x37D7, 0x2501, 0xFFA0, Some(1)), kind: ReportKind::Output, bytes: &[0x03, 0x5A, 0xA5, 0x07, 0x00, 0x00], why: FD },
    AllowEntry { device: on(0x37D7, 0x2501, 0xFFA0, Some(1)), kind: ReportKind::Output, bytes: &[0x03, 0x5A, 0xA5, 0x01, 0x02, 0x00], why: FD },
    AllowEntry { device: on(0x20BC, 0x515C, 0x00FF, Some(3)), kind: ReportKind::Output, bytes: &[0x02, 0xAD], why: BT },
];

// ---- Piece 5: mice and keyboards ----
// Three more forms, each as tight as the exact entries above:
// - SetEntry: exact bytes (each listed in full) for a list of products of one vendor (Razer's 250 mice and keyboards
//   take the same ten requests): never a vendor alone — every product id is listed.
// - Template: a request with one or more variable bytes, each restricted to a listed value or a small closed range
//   (Corsair's Bragi target and property, Delux M800's sequence number); every other byte fixed.
// - HID++ (Logitech): checked by `permit_hidpp` against a Session that has seen the device's own answer to the root
//   feature's getFeature — a battery or name function goes only to the feature index the device itself named for that
//   feature, never to an index guessed or carried over (the device index, the feature index and the software id are
//   the variable bytes; each is bounded; see `hidpp`).
// Every one of them only asks: battery, charging, link state, device information or a feature index. Nothing here sets
// DPI, polling rate, lighting, a profile, a sleep timer, pairing, firmware or bootloader mode, wakes a device or
// switches its mode, or stores anything (the requests the original sent that do are not here at all: mice/*.rs say
// which, and why).

/// Products of one vendor a SetEntry or Template is for (and, where given, the collection's page, usage, interface) —
/// or, with `driver`, exactly the collections mice/*.rs's tables give that reader as the one its requests go to
/// (Role::Main: vendor, product, page, usage and interface as each table row has them; never a vendor alone — the
/// tables list every product by id, mice/mod.rs's tests check it).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Products {
    pub vid: u16,
    pub pids: &'static [u16],
    pub usage_page: Option<u16>,
    pub usage: Option<u16>,
    pub interface: Option<i32>,
    pub driver: Option<&'static str>,
}

impl Products {
    pub const fn of(vid: u16, pids: &'static [u16]) -> Products {
        Products { vid, pids, usage_page: None, usage: None, interface: None, driver: None }
    }
    /// The request collections of one mice/keyboards reader (its table's Role::Main rows).
    pub const fn driver(d: &'static str) -> Products {
        Products { vid: 0, pids: &[], usage_page: None, usage: None, interface: None, driver: Some(d) }
    }
    pub const fn page(mut self, p: u16) -> Products {
        self.usage_page = Some(p);
        self
    }
    pub const fn usage(mut self, u: u16) -> Products {
        self.usage = Some(u);
        self
    }
    pub const fn iface(mut self, i: i32) -> Products {
        self.interface = Some(i);
        self
    }
    pub fn matches(&self, id: &HidIdent) -> bool {
        if let Some(d) = self.driver {
            return crate::mice::claims(d, id);
        }
        self.vid == id.vid
            && self.pids.contains(&id.pid)
            && self.usage_page.map_or(true, |p| p == id.usage_page)
            && self.usage.map_or(true, |u| u == id.usage)
            && self.interface.map_or(true, |i| i == id.interface)
    }
}

/// Exact requests for a list of products.
pub struct SetEntry {
    pub devices: Products,
    pub kind: ReportKind,
    pub bytes: &'static [&'static [u8]],
    pub why: &'static str,
}

/// One byte of a template: this value, or one of these values, or in this closed range.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum B {
    Is(u8),
    OneOf(&'static [u8]),
    In(u8, u8),
}

impl B {
    fn takes(self, v: u8) -> bool {
        match self {
            B::Is(x) => v == x,
            B::OneOf(xs) => xs.contains(&v),
            B::In(lo, hi) => (lo..=hi).contains(&v),
        }
    }
}

/// A request with bounded variable bytes: exactly `pattern.len()` bytes, each one taken by its B — and, where a byte is
/// a checksum of the variable ones (piece 6: a transaction id with its checksum), `check` must hold as well.
pub struct Template {
    pub devices: Products,
    pub kind: ReportKind,
    pub pattern: &'static [B],
    pub why: &'static str,
    pub check: Option<fn(&[u8]) -> bool>,
}

impl Template {
    pub fn takes(&self, bytes: &[u8]) -> bool {
        bytes.len() == self.pattern.len() && self.pattern.iter().zip(bytes).all(|(b, &v)| b.takes(v)) && self.check.map_or(true, |c| c(bytes))
    }
}

/// The mice' and keyboards' exact requests (frames.rs-style data below, built at compile time).
pub static ALLOWED_SETS: &[SetEntry] = crate::mice::allowed::SETS;
/// The mice' and keyboards' bounded templates.
pub static TEMPLATES: &[Template] = crate::mice::allowed::TEMPLATES;
/// Piece 6: the headsets' exact requests and bounded templates (heads/allowed.rs).
pub static HEAD_SETS: &[SetEntry] = crate::heads::allowed::SETS;
pub static HEAD_TEMPLATES: &[Template] = crate::heads::allowed::TEMPLATES;

fn all_sets() -> impl Iterator<Item = &'static SetEntry> {
    ALLOWED_SETS.iter().chain(HEAD_SETS.iter())
}
fn all_templates() -> impl Iterator<Item = &'static Template> {
    TEMPLATES.iter().chain(HEAD_TEMPLATES.iter())
}

/// Logitech HID++ (1.0 and 2.0), the protocol's public description (Logitech's HID++ 2.0 drafts; Solaar): a short
/// report (id 10, 7 bytes) or a long one (id 11, 20 bytes): [id][device index][feature index][function << 4 | sw id]
/// [parameters]. Allowed, with the software id 0D always:
/// - root (feature index 00) function 0 getFeature, parameters = one of FEATURES' ids, nothing after;
/// - root function 1 getProtocolVersion (the ping), parameters 00 00 5A;
/// - HID++ 1.0 GET_REGISTER (sub id 81) of register 0D (battery %) or 07 (battery level), parameters 00;
/// - a feature's own get function (FEATURES), to the index the device named for that feature on this handle's Session;
///   getDeviceName's one parameter is the character index, 0–63.
/// Device index: 1–6 (a receiver's slots) or FF (the device itself). Every other byte zero.
pub mod hidpp {
    /// The software id every request carries (replies to G HUB's or Options+' requests carry theirs).
    pub const SW: u8 = 0x0D;
    /// (feature id, the functions that only read it).
    pub const FEATURES: &[(u16, &[u8])] = &[
        (0x1004, &[0x01]),             // UNIFIED_BATTERY get_status
        (0x1000, &[0x00]),             // BATTERY_STATUS GetBatteryLevelStatus
        (0x1001, &[0x00]),             // BATTERY_VOLTAGE GetBatteryInfo
        (0x0005, &[0x00, 0x01, 0x02]), // DEVICE_NAME getCount, getDeviceName, getDeviceType
        (0x0003, &[0x00]),             // DEVICE_INFORMATION getDeviceInfo (the unit id)
        (0x1F20, &[0x00]),             // ADC_MEASUREMENT getADCMeasurement (piece 6: G headsets' battery voltage)
    ];
    pub const REGISTERS: &[u8] = &[0x0D, 0x07];
    pub fn device_index_ok(i: u8) -> bool {
        (1..=6).contains(&i) || i == 0xFF
    }
    /// A feature index a device may name (00 is the root; FF and 8F mark error replies).
    pub fn feature_index_ok(i: u8) -> bool {
        (0x01..=0x7F).contains(&i)
    }
}

/// What one HID++ handle has learned from its device: (device index, feature id) → the feature index the device named.
/// Only `learn` adds to it, and only from the reply to a root getFeature this module permitted.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HidppSession {
    learned: Vec<(u8, u16, u8)>,
}

impl HidppSession {
    pub fn new() -> HidppSession {
        HidppSession::default()
    }
    /// The reply `reply` (report id first) to `req`: when `req` was a root getFeature and the reply echoes it, the index
    /// it names (None when 00 — not supported — or out of bounds).
    pub fn learn(&mut self, req: &AllowedWrite, reply: &[u8]) -> Option<u8> {
        let q = req.bytes();
        if q.len() < 6 || q[2] != 0x00 || q[3] != hidpp::SW || reply.len() < 5 {
            return None;
        }
        if !(reply[0] == 0x10 || reply[0] == 0x11) || reply[1] != q[1] || reply[2] != 0x00 || reply[3] != hidpp::SW {
            return None;
        }
        let feature = u16::from(q[4]) << 8 | u16::from(q[5]);
        let idx = reply[4];
        if !hidpp::FEATURES.iter().any(|f| f.0 == feature) || !hidpp::feature_index_ok(idx) {
            return None;
        }
        self.learned.retain(|&(d, f, i)| !(d == q[1] && (f == feature || i == idx)));
        self.learned.push((q[1], feature, idx));
        Some(idx)
    }
    fn feature_at(&self, dev: u8, idx: u8) -> Option<u16> {
        self.learned.iter().find(|&&(d, _, i)| d == dev && i == idx).map(|&(_, f, _)| f)
    }
}

/// The HID++ collections of the Logitech products mice/logitech.rs lists (receivers, the devices on their cable or
/// Bluetooth): short FF00:0001, long FF00:0002, Bluetooth LE's long FF43:0202, the PRO X SUPERSTRIKE receiver's
/// FF43:0301 / 0302.
pub fn hidpp_device(id: &HidIdent) -> bool {
    id.vid == 0x046D
        && (crate::mice::logitech::PIDS.contains(&id.pid) || crate::heads::logitech::PIDS.contains(&id.pid))
        && matches!((id.usage_page, id.usage), (0xFF00, 0x0001) | (0xFF00, 0x0002) | (0xFF43, 0x0202) | (0xFF43, 0x0301) | (0xFF43, 0x0302))
}

fn hidpp_ok(s: &HidppSession, b: &[u8]) -> bool {
    let short = b.len() == 7 && b[0] == 0x10;
    let long = b.len() == 20 && b[0] == 0x11;
    if !(short || long) || !hidpp::device_index_ok(b[1]) {
        return false;
    }
    let zero_from = |i: usize| b[i..].iter().all(|&x| x == 0);
    match b[2] {
        0x00 if b[3] == hidpp::SW => {
            let f = u16::from(b[4]) << 8 | u16::from(b[5]);
            hidpp::FEATURES.iter().any(|x| x.0 == f) && zero_from(6)
        }
        0x00 if b[3] == 0x10 | hidpp::SW => b[4] == 0 && b[5] == 0 && b[6] == 0x5A && zero_from(7),
        0x81 => short && hidpp::REGISTERS.contains(&b[3]) && zero_from(4),
        idx if hidpp::feature_index_ok(idx) && b[3] & 0x0F == hidpp::SW => {
            let Some(f) = s.feature_at(b[1], idx) else { return false };
            let func = b[3] >> 4;
            let Some(&(_, fns)) = hidpp::FEATURES.iter().find(|x| x.0 == f) else { return false };
            if !fns.contains(&func) {
                return false;
            }
            if f == 0x0005 && func == 0x01 {
                b[4] <= 63 && zero_from(5)
            } else {
                zero_from(4)
            }
        }
        _ => false,
    }
}

/// The only way to a HID++ write: `bytes` (7 or 20, the report id first) as `hidpp` allows, to a Logitech HID++
/// collection, given what `s` learned on this handle. Output reports only.
pub fn permit_hidpp(s: &HidppSession, id: &HidIdent, bytes: &[u8]) -> Option<AllowedWrite> {
    if !hidpp_device(id) || !hidpp_ok(s, bytes) {
        return None;
    }
    Some(AllowedWrite { ident: id.clone(), kind: ReportKind::Output, bytes: bytes.to_vec(), _seal: Seal })
}

/// Private: only this module can make an AllowedWrite.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Seal;

/// A request the table allows, for one device. Made only by `permit`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AllowedWrite {
    ident: HidIdent,
    kind: ReportKind,
    bytes: Vec<u8>,
    _seal: Seal,
}

impl AllowedWrite {
    pub fn ident(&self) -> &HidIdent {
        &self.ident
    }
    pub fn kind(&self) -> ReportKind {
        self.kind
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

fn permit_from(table: &[AllowEntry], id: &HidIdent, kind: ReportKind, bytes: &[u8]) -> Option<AllowedWrite> {
    if bytes.is_empty() {
        return None;
    }
    table
        .iter()
        .find(|e| e.kind == kind && e.device.matches(id) && e.bytes == bytes)
        .map(|_| AllowedWrite { ident: id.clone(), kind, bytes: bytes.to_vec(), _seal: Seal })
}

fn permit_sets(id: &HidIdent, kind: ReportKind, bytes: &[u8]) -> Option<AllowedWrite> {
    if bytes.is_empty() {
        return None;
    }
    let listed = all_sets().any(|e| e.kind == kind && e.devices.matches(id) && e.bytes.iter().any(|b| *b == bytes));
    let shaped = all_templates().any(|t| t.kind == kind && t.devices.matches(id) && t.takes(bytes));
    if listed || shaped {
        Some(AllowedWrite { ident: id.clone(), kind, bytes: bytes.to_vec(), _seal: Seal })
    } else {
        None
    }
}

/// The only way to a write (HID++ apart: `permit_hidpp`): `bytes` exactly as the tables list them for this device and
/// kind — or as a template bounds them —, else None.
pub fn permit(id: &HidIdent, kind: ReportKind, bytes: &[u8]) -> Option<AllowedWrite> {
    permit_from(ALLOWED, id, kind, bytes).or_else(|| permit_sets(id, kind, bytes))
}

/// Whether the tables allow any write to this device (else it is opened for queries only).
pub fn may_write(id: &HidIdent) -> bool {
    may_write_in(ALLOWED, id) || all_sets().any(|e| e.devices.matches(id)) || all_templates().any(|t| t.devices.matches(id)) || hidpp_device(id)
}

fn may_write_in(table: &[AllowEntry], id: &HidIdent) -> bool {
    table.iter().any(|e| e.device.matches(id))
}

/// (Tests elsewhere in the crate: a permit from a test table, the same rule as `permit`.)
#[cfg(test)]
pub(crate) fn permit_test(table: &[AllowEntry], id: &HidIdent, kind: ReportKind, bytes: &[u8]) -> Option<AllowedWrite> {
    permit_from(table, id, kind, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(vid: u16, pid: u16) -> HidIdent {
        HidIdent { vid, pid, usage_page: 0xFF00, usage: 1, interface: 2 }
    }
    static TABLE: &[AllowEntry] = &[AllowEntry {
        device: DeviceMatch { vid: 0x1234, pid: 0x5678, usage_page: Some(0xFF00), usage: None, interface: Some(2) },
        kind: ReportKind::Output,
        bytes: &[0x11, 0x01, 0x02],
        why: "test",
    }];

    #[test]
    fn the_shipped_table_names_only_the_controllers_status_requests() {
        assert_eq!(ALLOWED.len(), 18, "D1: the Apex 5's two, the KP40D's one");
        for bytes in [&[0x10u8, 0xFF, 0x83, 0xB5][..], &[0xF7][..], &[0x00][..], &[0x11, 0x01, 0x02][..]] {
            assert!(permit(&id(0x1234, 0x5678), ReportKind::Output, bytes).is_none());
            assert!(permit(&id(0x046D, 0xC547), ReportKind::Feature, bytes).is_none());
        }
        assert!(!may_write(&id(0x1234, 0x5678)));
        for e in ALLOWED {
            // (Each entry: one product with its page; output reports only — no feature report is ever set.)
            assert!(e.device.pid != 0 && e.device.usage_page.is_some(), "{:04X}:{:04X}", e.device.vid, e.device.pid);
            assert_eq!(e.kind, ReportKind::Output);
            assert!(!e.why.is_empty());
            let at = HidIdent { vid: e.device.vid, pid: e.device.pid, usage_page: e.device.usage_page.unwrap(), usage: e.device.usage.unwrap_or(1), interface: 0 };
            assert!(permit(&at, e.kind, e.bytes).is_some());
            assert!(permit(&at, ReportKind::Feature, e.bytes).is_none(), "the same bytes as a feature report: refused");
            // (Any one byte changed, one byte more or less: refused.)
            for i in 0..e.bytes.len() {
                for delta in [1u8, 0x80, 0xFF] {
                    let mut b = e.bytes.to_vec();
                    b[i] = b[i].wrapping_add(delta);
                    let listed = ALLOWED.iter().any(|o| o.device.matches(&at) && o.bytes == &b[..]);
                    assert_eq!(permit(&at, e.kind, &b).is_some(), listed, "{:02X?}", b);
                }
            }
            let mut longer = e.bytes.to_vec();
            longer.push(0);
            assert!(permit(&at, e.kind, &longer).is_none());
            assert!(permit(&at, e.kind, &e.bytes[..e.bytes.len() - 1]).is_none());
            // (Another product of the vendor, the right product on another page: refused.)
            let mut other = at.clone();
            other.pid = other.pid.wrapping_add(0x0100);
            assert!(permit(&other, e.kind, e.bytes).is_none());
            let mut page = at.clone();
            page.usage_page = 0x0001;
            assert!(permit(&page, e.kind, e.bytes).is_none());
        }
        // (The requests the original sent that change a pad are not in the table: Cyclone 2's stream start, the
        //  PlayStation / 8BitDo feature reads are reads — but nothing for those products at all.)
        let cyclone = HidIdent { vid: 0x3537, pid: 0x100B, usage_page: 0xFFF0, usage: 0x40, interface: -1 };
        assert!(permit(&cyclone, ReportKind::Output, &[0x0F, 0x03]).is_none() && !may_write(&cyclone));
        for pid in [0x05C4u16, 0x09CC, 0x0CE6, 0x0DF2] {
            assert!(!may_write(&HidIdent { vid: 0x054C, pid, usage_page: 1, usage: 5, interface: -1 }));
        }
        assert!(!may_write(&HidIdent { vid: 0x057E, pid: 0x2009, usage_page: 1, usage: 5, interface: -1 }), "no Switch sub-command");
        assert!(!may_write(&HidIdent { vid: 0x2DC8, pid: 0x6003, usage_page: 1, usage: 5, interface: -1 }));
        assert!(!may_write(&HidIdent { vid: 0x2DC8, pid: 0x3109, usage_page: 0xFF7A, usage: 1, interface: -1 }), "an undocumented receiver");
    }

    #[test]
    fn only_the_exact_bytes_for_the_exact_device() {
        let ok = permit_from(TABLE, &id(0x1234, 0x5678), ReportKind::Output, &[0x11, 0x01, 0x02]).expect("listed");
        assert_eq!(ok.bytes(), &[0x11, 0x01, 0x02]);
        assert_eq!(ok.kind(), ReportKind::Output);
        // (Not a byte more or less, not another kind, not another product of the same vendor, not another interface.)
        assert!(permit_from(TABLE, &id(0x1234, 0x5678), ReportKind::Output, &[0x11, 0x01, 0x02, 0x00]).is_none());
        assert!(permit_from(TABLE, &id(0x1234, 0x5678), ReportKind::Output, &[0x11, 0x01]).is_none());
        assert!(permit_from(TABLE, &id(0x1234, 0x5678), ReportKind::Feature, &[0x11, 0x01, 0x02]).is_none());
        assert!(permit_from(TABLE, &id(0x1234, 0x5679), ReportKind::Output, &[0x11, 0x01, 0x02]).is_none());
        let mut other_if = id(0x1234, 0x5678);
        other_if.interface = 0;
        assert!(permit_from(TABLE, &other_if, ReportKind::Output, &[0x11, 0x01, 0x02]).is_none());
        assert!(permit_from(TABLE, &id(0x1234, 0x5678), ReportKind::Output, &[]).is_none());
        assert!(may_write_in(TABLE, &id(0x1234, 0x5678)));
        assert!(!may_write_in(TABLE, &id(0x1234, 0x0001)), "a vendor id alone is never enough");
    }

    #[test]
    fn random_bytes_never_pass() {
        // (A small fuzz: every 1–3 byte sequence of a few values against the test table — only the listed one passes.)
        let vals = [0x00u8, 0x01, 0x02, 0x10, 0x11, 0xF7, 0xFF];
        let mut passed = 0;
        for a in vals {
            for b in vals {
                for c in vals {
                    for bytes in [vec![a], vec![a, b], vec![a, b, c]] {
                        if permit_from(TABLE, &id(0x1234, 0x5678), ReportKind::Output, &bytes).is_some() {
                            passed += 1;
                            assert_eq!(bytes, vec![0x11, 0x01, 0x02]);
                        }
                    }
                }
            }
        }
        assert_eq!(passed, 1);
    }
}
