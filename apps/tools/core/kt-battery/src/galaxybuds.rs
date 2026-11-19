// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Samsung Galaxy Buds (piece 6).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/galaxy_buds.cpp (FindConnectedBuds, ReadStatus, PollGalaxyBuds) and galaxy_buds_protocol.h (Crc16,
// FindStatus) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later.
// Its reference: timschneeb/GalaxyBudsClient (SppMessage.cs, Crc16.cs, StatusUpdateDecoder.cs,
// ExtendedStatusUpdateDecoder.cs).
// Windows shows no level for them. The buds accept an RFCOMM connection on Samsung's serial-port service and push a
// status frame with the left, right and case levels as soon as it opens; nothing is sent to them (the reference shows
// it: the original only connects and listens). Frames: FD [size lo][size hi | flags] [id] [payload] [crc lo][crc hi] DD
// (Buds+ and later), FE [type] [size] [id] [payload] [crc] EE (the first Buds); crc = CRC-16/XMODEM of id + payload;
// 60 STATUS_UPDATED: payload [1] left, [2] right, [6] case; 61 EXTENDED_STATUS_UPDATED: [2], [3], [7]. 0 = that part
// is not connected (out of range, the case closed); the Buds+ give 101 for an unknown case.
// Services: Buds2 and later {2e73a4ad-332d-41fc-90e2-16bef06523f2}, Buds+ / Live / Pro the standard SPP
// {00001101-…-00805f9b34fb}, the first Buds {00001102-0000-1000-8000-00805f9b34fd} (legacy framing).
// It is an active connection, though a status-only use of it: OFF by default (its family's switch, «Galaxy Buds» under
// «Headsets and earbuds», says it connects); only buds Windows already reports connected, whose name says «Buds», are
// tried — never a device that is asleep or away, never pairing; the connection lives for one reading, under the
// deadline, and is closed (win/spp.rs). If the Galaxy Buds app holds the service, nothing is read.
// Changed here: the buds and the case as parts of one card (the original showed the lower bud).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::bluetooth::{is_main_node, BtNode};
use crate::model::{Charging, Level, Part, PartName, Percent, Reading};

/// Samsung's services, newest first: (data1, data2, data3, data4, legacy framing).
pub const SERVICES: [(u32, u16, u16, [u8; 8], bool); 3] = [
    (0x2e73a4ad, 0x332d, 0x41fc, [0x90, 0xe2, 0x16, 0xbe, 0xf0, 0x65, 0x23, 0xf2], false),
    (0x00001101, 0x0000, 0x1000, [0x80, 0x00, 0x00, 0x80, 0x5f, 0x9b, 0x34, 0xfb], false),
    (0x00001102, 0x0000, 0x1000, [0x80, 0x00, 0x00, 0x80, 0x5f, 0x9b, 0x34, 0xfd], true),
];

/// Levels of the last valid status frame, None where not reported or not connected.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Status {
    pub left: Option<u8>,
    pub right: Option<u8>,
    pub case: Option<u8>,
}

pub fn crc16(d: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for &b in d {
        crc ^= u16::from(b) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x1021 } else { crc << 1 };
        }
    }
    crc
}

fn lvl(v: u8) -> Option<u8> {
    if (1..=100).contains(&v) {
        Some(v)
    } else {
        None
    }
}

/// Scans a received byte stream for status frames; the last valid one counts.
pub fn find_status(data: &[u8], legacy: bool) -> Option<Status> {
    let (som, eom) = if legacy { (0xFE, 0xEE) } else { (0xFD, 0xDD) };
    let mut found = None;
    let mut i = 0usize;
    while i + 6 <= data.len() {
        if data[i] != som {
            i += 1;
            continue;
        }
        let len = if legacy {
            usize::from(data[i + 2])
        } else {
            let h = u16::from(data[i + 1]) | u16::from(data[i + 2]) << 8;
            if h & 0x2000 != 0 {
                i += 1;
                continue;
            }
            usize::from(h & 0x3FF)
        };
        if len < 3 || i + 3 + len >= data.len() || data[i + 3 + len] != eom {
            i += 1;
            continue;
        }
        let body = &data[i + 3..i + 3 + len];
        let crc = u16::from(body[len - 2]) | u16::from(body[len - 1]) << 8;
        if crc16(&body[..len - 2]) != crc {
            i += 1;
            continue;
        }
        let (id, p) = (body[0], &body[1..len - 2]);
        let s = match id {
            0x61 if p.len() >= 4 => Some(Status { left: lvl(p[2]), right: lvl(p[3]), case: if !legacy && p.len() >= 8 { lvl(p[7]) } else { None } }),
            0x60 if p.len() >= 3 => Some(Status { left: lvl(p[1]), right: lvl(p[2]), case: if !legacy && p.len() >= 7 { lvl(p[6]) } else { None } }),
            _ => None,
        };
        if s.is_some() {
            found = s;
            i += 3 + len + 1;
        } else {
            i += 1;
        }
    }
    found
}

/// The reading: the buds and the case as parts (a connected bud is taken as in use; the case never).
pub fn reading(s: &Status, now: u64) -> Reading {
    let part = |name, v: Option<u8>, in_use| v.and_then(|v| Percent::new(i64::from(v))).map(|p| Part { name, level: Level::Exact(p), charging: Charging::Unknown, in_use });
    Reading::with_parts([part(PartName::Left, s.left, true), part(PartName::Right, s.right, true), part(PartName::Case, s.case, false)], now)
}

/// Connected Galaxy Buds among Windows' Bluetooth nodes: (container, name, address).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Buds {
    pub container: String,
    pub name: String,
    pub addr: u64,
}

pub fn connected_buds(nodes: &[BtNode]) -> Vec<Buds> {
    let mut out = Vec::new();
    for n in nodes {
        let u = n.instance_id.to_ascii_uppercase();
        if !is_main_node(&n.instance_id) || !u.starts_with("BTHENUM\\DEV_") || n.connected != Some(true) || !n.name.to_ascii_lowercase().contains("buds") {
            continue;
        }
        let hex = u.get(12..24).unwrap_or("");
        let Ok(addr) = u64::from_str_radix(hex, 16) else { continue };
        if addr == 0 || hex.len() != 12 {
            continue;
        }
        out.push(Buds { container: n.container.clone().unwrap_or_default(), name: n.name.clone(), addr });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(legacy: bool, id: u8, payload: &[u8]) -> Vec<u8> {
        let mut body = vec![id];
        body.extend_from_slice(payload);
        let crc = crc16(&body);
        body.push(crc as u8);
        body.push((crc >> 8) as u8);
        let mut f = if legacy { vec![0xFE, 0x00, body.len() as u8] } else { vec![0xFD, body.len() as u8, 0x00] };
        f.extend(body);
        f.push(if legacy { 0xEE } else { 0xDD });
        f
    }

    #[test]
    fn status_frames() {
        assert_eq!(crc16(b"123456789"), 0x31C3, "CRC-16/XMODEM's check value");
        let f = frame(false, 0x61, &[0, 0, 82, 77, 0, 0, 0, 40]);
        let mut stream = vec![0x01, 0xFD, 0x99];
        stream.extend(&f);
        stream.push(0x00);
        let s = find_status(&stream, false).unwrap();
        assert_eq!(s, Status { left: Some(82), right: Some(77), case: Some(40) });
        let r = reading(&s, 5);
        assert_eq!(r.level, Level::Exact(Percent::new(77).unwrap()), "the lower bud; the case never");
        assert_eq!(r.parts[2].map(|p| p.in_use), Some(false));
        // (0: a bud not connected; 101: an unknown case.)
        let s = find_status(&frame(false, 0x60, &[0, 0, 55, 0, 0, 0, 101]), false).unwrap();
        assert_eq!(s, Status { left: None, right: Some(55), case: None });
        // (The first Buds' framing; a broken crc; a fragment; a frame with no end.)
        assert_eq!(find_status(&frame(true, 0x60, &[0, 30, 31]), true), Some(Status { left: Some(30), right: Some(31), case: None }));
        let mut bad = frame(false, 0x61, &[0, 0, 82, 77]);
        bad[6] ^= 1;
        assert_eq!(find_status(&bad, false), None);
        let mut frag = frame(false, 0x61, &[0, 0, 82, 77]);
        frag[2] |= 0x20;
        assert_eq!(find_status(&frag, false), None);
        let f = frame(false, 0x61, &[0, 0, 82, 77]);
        assert_eq!(find_status(&f[..f.len() - 1], false), None);
        assert_eq!(find_status(&frame(false, 0x62, &[0, 0, 82, 77]), false), None, "another message");
    }

    #[test]
    fn only_connected_buds() {
        let node = |id: &str, name: &str, c: Option<bool>| BtNode { instance_id: id.into(), container: Some("{B}".into()), name: name.into(), connected: c, ..Default::default() };
        let nodes = vec![
            node("BTHENUM\\DEV_A1B2C3D4E5F6\\7&1", "Galaxy Buds2 Pro", Some(true)),
            node("BTHENUM\\DEV_A1B2C3D4E5F7\\7&1", "Galaxy Buds FE", Some(false)),
            node("BTHENUM\\DEV_A1B2C3D4E5F8\\7&1", "Speaker", Some(true)),
            node("BTHENUM\\{0000110B}_LOCALMFG\\x", "Galaxy Buds2 Pro Stereo", Some(true)),
        ];
        assert_eq!(connected_buds(&nodes), vec![Buds { container: "{B}".into(), name: "Galaxy Buds2 Pro".into(), addr: 0xA1B2C3D4E5F6 }]);
    }
}
