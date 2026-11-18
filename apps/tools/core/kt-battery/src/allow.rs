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
];

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

/// The only way to a write: `bytes` exactly as the table lists them for this device and kind, else None.
pub fn permit(id: &HidIdent, kind: ReportKind, bytes: &[u8]) -> Option<AllowedWrite> {
    permit_from(ALLOWED, id, kind, bytes)
}

/// Whether the table allows any write to this device (else it is opened for queries only).
pub fn may_write(id: &HidIdent) -> bool {
    may_write_in(ALLOWED, id)
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
        assert_eq!(ALLOWED.len(), 15);
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
