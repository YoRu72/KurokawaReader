// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): RAWM (and SADES) mice's «Hub Web 2.0» event stream — PARSE ONLY.
// Ported from Wireless Device Battery Monitor / BatteryHub (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/rawm_protocol.h (Packet, Stream, Link, JsonInt) at v1.1.0 (commit 7cc44f2), by krisgfx9 and its
// contributors, GPL-3.0-or-later. Its reference: the RAWM HUB web app (hub.miracletek.net library.min.js).
//   64-byte unnumbered reports on FF00:0001. Byte 0: type (top two bits) | size (low six); 80 event data, 40 flow
//   control, C0 | n «extended» — the next byte is a packet for radio channel n (the mouse behind a receiver: 0). Events
//   form a byte stream: FF FF FF FF, then [cmd | (len >> 4) & F0][len & FF][body], len counting the two header bytes.
//   QUERY_RESULT (02) carries a JSON object with "battery" (percent) and "chr" (1 charging); NOTIFY (0B) type 17
//   [battery][charging] when they change.
// NOT PORTED as a reader: the app's query (CMD_QUERY 01) carries the host's system type and its clock — what the mouse
// does with them (setting its own clock?) is not documented —, and the mouse answers only while it is pinged on: not
// sent until understood (PLAN-battery §10). The stream's parsing is kept, with its tests, for that later piece. The
// products (1915:2328 … 2352, receivers 232A … 234B) are in no table here: nothing is asked of them.
// Copyright (C) 2026 Kurokawa contributors. Std only.

/// What the stream told: the percent and charging state, when it told them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Status {
    pub have_info: bool,
    pub percent: Option<u8>,
    pub charging: bool,
}

/// The integer of "key": in a flat JSON object.
pub fn json_int(json: &str, key: &str) -> Option<i64> {
    let k = format!("\"{}\":", key);
    let at = json.find(&k)? + k.len();
    let s = &json[at..];
    let end = s.char_indices().find(|&(i, c)| !(c.is_ascii_digit() || (i == 0 && c == '-'))).map_or(s.len(), |x| x.0);
    s[..end].parse().ok()
}

/// One radio channel's event stream (bounded: at most 8 KiB kept).
#[derive(Default)]
pub struct Stream {
    buf: Vec<u8>,
    pub status: Status,
}

impl Stream {
    pub fn append(&mut self, d: &[u8]) {
        self.buf.extend_from_slice(d);
        if self.buf.len() > 8192 {
            let cut = self.buf.len() - 4096;
            self.buf.drain(..cut);
        }
        self.parse();
    }
    fn parse(&mut self) {
        let b = &self.buf;
        let mut o = 0;
        while o + 6 <= b.len() {
            if b[o..o + 4] != [0xFF; 4] {
                o += 1;
                continue;
            }
            let h = o + 4;
            let cmd = b[h] & 0x0F;
            let len = (usize::from(b[h]) << 4 & 0xF00) | usize::from(b[h + 1]);
            if len < 2 {
                o = h;
                continue;
            }
            if h + len > b.len() {
                break;
            }
            let body = &b[h + 2..h + len];
            if cmd == 0x02 {
                let text: String = String::from_utf8_lossy(body.split(|&x| x == 0).next().unwrap_or(&[])).into_owned();
                if text.starts_with('{') {
                    self.status.have_info = true;
                    if let Some(v) = json_int(&text, "battery").filter(|v| (0..=100).contains(v)) {
                        self.status.percent = Some(v as u8);
                    }
                    if let Some(v) = json_int(&text, "chr") {
                        self.status.charging = v == 1;
                    }
                }
            } else if cmd == 0x0B && body.len() >= 3 && body[0] == 0x17 && body[1] <= 100 {
                self.status.percent = Some(body[1]);
                self.status.charging = body[2] == 1;
            }
            o = h + len;
        }
        self.buf.drain(..o);
    }
}

/// The device itself and its channel 0 (the mouse behind a receiver).
#[derive(Default)]
pub struct Link {
    pub direct: Stream,
    pub channel0: Stream,
}

impl Link {
    /// One input report (report id dropped).
    pub fn feed(&mut self, r: &[u8]) {
        let mut r = r;
        if r.is_empty() {
            return;
        }
        let mut to_channel = false;
        if r[0] & 0xC0 == 0xC0 {
            if r[0] & 0x3F != 0 {
                return;
            }
            to_channel = true;
            r = &r[1..];
            if r.is_empty() {
                return;
            }
        }
        if r[0] & 0xC0 != 0x80 {
            return;
        }
        let n = usize::from(r[0] & 0x3F).min(r.len() - 1);
        let s = if to_channel { &mut self.channel0 } else { &mut self.direct };
        s.append(&r[1..1 + n]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(cmd: u8, body: &[u8]) -> Vec<u8> {
        let len = body.len() + 2;
        let mut e = vec![0xFF, 0xFF, 0xFF, 0xFF, cmd | ((len >> 4) as u8 & 0xF0), len as u8];
        e.extend_from_slice(body);
        e
    }
    fn packets(stream: &[u8], channel: bool) -> Vec<Vec<u8>> {
        stream
            .chunks(60)
            .map(|c| {
                let mut p = Vec::new();
                if channel {
                    p.push(0xC0);
                }
                p.push(0x80 | c.len() as u8);
                p.extend_from_slice(c);
                p.resize(64, 0);
                p
            })
            .collect()
    }

    #[test]
    fn query_result_across_packets() {
        let json = br#"{"dn":"Made-Up Mouse","pi":9001,"battery":57,"chr":1,"fw":"1.0.0","pad":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}"#;
        let ev = event(0x02, json);
        let mut l = Link::default();
        for p in packets(&ev, true) {
            l.feed(&p);
        }
        assert_eq!(l.channel0.status, Status { have_info: true, percent: Some(57), charging: true });
        assert_eq!(l.direct.status, Status::default(), "the receiver's own stream untouched");
        // (A battery notification on the direct stream; flow control and another channel ignored.)
        let mut l = Link::default();
        l.feed(&[0x40, 1, 2]);
        l.feed(&[0xC1, 0x85, 1, 2, 3, 4, 5]);
        for p in packets(&event(0x0B, &[0x17, 33, 0]), false) {
            l.feed(&p);
        }
        assert_eq!(l.direct.status, Status { have_info: false, percent: Some(33), charging: false });
        assert_eq!(json_int(r#"{"battery":101}"#, "battery"), Some(101));
        let mut l = Link::default();
        for p in packets(&event(0x02, br#"{"battery":101,"chr":0}"#), false) {
            l.feed(&p);
        }
        assert_eq!(l.direct.status.percent, None, "101 %");
    }
}
