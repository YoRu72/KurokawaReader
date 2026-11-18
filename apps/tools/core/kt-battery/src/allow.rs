// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the ONE table of what may ever be sent to a device.
// Written for Kurokawa Tools against Wireless Device Battery Monitor's fault (NOTICE.md; PLAN-battery §9.2): its readers
// called themselves read-only but sent dozens of commands, one undocumented command to about ninety receiver ids, some
// under other makers' vendor ids. Here a write is possible only as an `AllowedWrite`, and only `permit` makes one: for a
// device this table names exactly (vendor AND product, plus usage page / usage / interface where given), with exactly the
// bytes the table lists. The transport (transport.rs) sends nothing else and opens a device for writing only when the
// table has an entry for it. Piece 1's readers only read: the table is empty.
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

/// The table. Piece 1 (generic readers: HID battery fields, Windows' Bluetooth property, Xbox through Windows) never
/// writes. Vendor drivers add their documented requests here, each with its source.
pub static ALLOWED: &[AllowEntry] = &[];

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
    fn the_shipped_table_allows_nothing_in_piece_1() {
        assert!(ALLOWED.is_empty());
        for bytes in [&[0x10u8, 0xFF, 0x83, 0xB5][..], &[0xF7][..], &[0x00][..], &[0x11, 0x01, 0x02][..]] {
            assert!(permit(&id(0x1234, 0x5678), ReportKind::Output, bytes).is_none());
            assert!(permit(&id(0x046D, 0xC547), ReportKind::Feature, bytes).is_none());
        }
        assert!(!may_write(&id(0x1234, 0x5678)));
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
