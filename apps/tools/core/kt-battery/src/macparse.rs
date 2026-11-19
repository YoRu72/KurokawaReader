// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery), piece P1: what a Mac reports of its devices' batteries, read from two
// of its own programs' output — `ioreg -r -l -k BatteryPercent` (every IORegistry entry with a BatteryPercent: Apple's
// Magic keyboards, mice and trackpads, and any device whose driver publishes one) and `system_profiler
// SPBluetoothDataType -json` (macOS 12 and later: Bluetooth devices' levels, AirPods' left, right and case among them).
// Written for Tools (the original has no Mac side). Parsed defensively: a bounded JSON reader of our own (depth, size,
// counts), an unknown line or key skipped, a level outside 0..=100 is no level; nothing is shown as charging unless
// the report says so plainly. Std only; the programs are run by macos/mod.rs (sysprog.rs).
// Copyright (C) 2026 Kurokawa contributors.
use crate::model::Kind;

/// The fixed places of the two programs.
pub const IOREG: &[&str] = &["/usr/sbin/ioreg"];
pub const SYSTEM_PROFILER: &[&str] = &["/usr/sbin/system_profiler"];

/// One IORegistry entry with a battery.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IoDev {
    pub product: String,
    pub vid: u16,
    pub pid: u16,
    pub percent: u8,
    /// «aa-bb-cc-dd-ee-ff» made «AA:BB:CC:DD:EE:FF», when it has one.
    pub addr: String,
    pub serial: String,
    pub usage_page: u16,
    pub usage: u16,
    pub bluetooth: bool,
}

fn unquote(v: &str) -> Option<String> {
    let v = v.trim();
    let s = v.strip_prefix('"')?.strip_suffix('"')?;
    Some(s.chars().filter(|c| !c.is_control()).take(128).collect())
}

fn number(v: &str) -> Option<i64> {
    let v = v.trim();
    if let Some(h) = v.strip_prefix("0x") {
        return i64::from_str_radix(h, 16).ok();
    }
    v.parse().ok()
}

/// `ioreg -r -l -k BatteryPercent`'s entries (at most 64).
pub fn ioreg(text: &str) -> Vec<IoDev> {
    let mut out: Vec<IoDev> = Vec::new();
    let mut cur: Option<(IoDev, Option<i64>)> = None;
    let push = |c: Option<(IoDev, Option<i64>)>, out: &mut Vec<IoDev>| {
        if let Some((mut d, Some(p))) = c {
            if (0..=100).contains(&p) && out.len() < 64 {
                d.percent = p as u8;
                out.push(d);
            }
        }
    };
    for line in text.lines().take(50_000) {
        let t = line.trim_start_matches(|c: char| c == ' ' || c == '|').trim_end();
        if t.starts_with("+-o ") {
            push(cur.take(), &mut out);
            cur = Some((IoDev::default(), None));
            continue;
        }
        let Some((d, pct)) = cur.as_mut() else { continue };
        let Some((k, v)) = t.split_once(" = ") else { continue };
        let Some(k) = unquote(k) else { continue };
        match k.as_str() {
            "BatteryPercent" => *pct = number(v),
            "Product" => d.product = unquote(v).unwrap_or_default(),
            "VendorID" => d.vid = number(v).filter(|n| (0..=0xFFFF).contains(n)).unwrap_or(0) as u16,
            "ProductID" => d.pid = number(v).filter(|n| (0..=0xFFFF).contains(n)).unwrap_or(0) as u16,
            "SerialNumber" => d.serial = unquote(v).unwrap_or_default(),
            "PrimaryUsagePage" => d.usage_page = number(v).filter(|n| (0..=0xFFFF).contains(n)).unwrap_or(0) as u16,
            "PrimaryUsage" => d.usage = number(v).filter(|n| (0..=0xFFFF).contains(n)).unwrap_or(0) as u16,
            "Transport" => d.bluetooth = unquote(v).map_or(false, |t| t.to_ascii_lowercase().starts_with("bluetooth")),
            "DeviceAddress" => d.addr = unquote(v).and_then(|a| crate::connect::parse_addr(&a)).map(crate::connect::addr_text).unwrap_or_default(),
            _ => {}
        }
    }
    push(cur.take(), &mut out);
    out
}

/// A JSON value (our own bounded reader: no crate).
#[derive(Clone, Debug, PartialEq)]
pub enum J {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

impl J {
    pub fn get(&self, k: &str) -> Option<&J> {
        match self {
            J::Obj(m) => m.iter().find(|(a, _)| a == k).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn str(&self) -> Option<&str> {
        match self {
            J::Str(s) => Some(s),
            _ => None,
        }
    }
}

struct Rd<'a> {
    b: &'a [u8],
    i: usize,
    items: usize,
}

const MAX_DEPTH: usize = 32;
const MAX_ITEMS: usize = 200_000;

impl Rd<'_> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\n' | b'\r' | b'\t') {
            self.i += 1;
        }
    }
    fn lit(&mut self, s: &str) -> Option<()> {
        if self.b.get(self.i..self.i + s.len())? == s.as_bytes() {
            self.i += s.len();
            Some(())
        } else {
            None
        }
    }
    fn string(&mut self) -> Option<String> {
        self.lit("\"")?;
        let mut out: Vec<u8> = Vec::new();
        loop {
            let c = *self.b.get(self.i)?;
            self.i += 1;
            match c {
                b'"' => break,
                b'\\' => {
                    let e = *self.b.get(self.i)?;
                    self.i += 1;
                    match e {
                        b'"' => out.push(b'"'),
                        b'\\' => out.push(b'\\'),
                        b'/' => out.push(b'/'),
                        b'b' | b'f' | b'n' | b'r' | b't' => out.push(b' '),
                        b'u' => {
                            let h = std::str::from_utf8(self.b.get(self.i..self.i + 4)?).ok()?;
                            let n = u32::from_str_radix(h, 16).ok()?;
                            self.i += 4;
                            let ch = char::from_u32(n).unwrap_or('\u{FFFD}');
                            let mut tmp = [0u8; 4];
                            out.extend_from_slice(ch.encode_utf8(&mut tmp).as_bytes());
                        }
                        _ => return None,
                    }
                }
                _ => out.push(c),
            }
            if out.len() > 64 * 1024 {
                return None;
            }
        }
        Some(String::from_utf8_lossy(&out).into_owned())
    }
    fn value(&mut self, depth: usize) -> Option<J> {
        self.items += 1;
        if depth > MAX_DEPTH || self.items > MAX_ITEMS {
            return None;
        }
        self.ws();
        match *self.b.get(self.i)? {
            b'{' => {
                self.i += 1;
                let mut m = Vec::new();
                self.ws();
                if self.lit("}").is_some() {
                    return Some(J::Obj(m));
                }
                loop {
                    self.ws();
                    let k = self.string()?;
                    self.ws();
                    self.lit(":")?;
                    let v = self.value(depth + 1)?;
                    m.push((k, v));
                    self.ws();
                    if self.lit(",").is_some() {
                        continue;
                    }
                    self.lit("}")?;
                    return Some(J::Obj(m));
                }
            }
            b'[' => {
                self.i += 1;
                let mut a = Vec::new();
                self.ws();
                if self.lit("]").is_some() {
                    return Some(J::Arr(a));
                }
                loop {
                    a.push(self.value(depth + 1)?);
                    self.ws();
                    if self.lit(",").is_some() {
                        continue;
                    }
                    self.lit("]")?;
                    return Some(J::Arr(a));
                }
            }
            b'"' => self.string().map(J::Str),
            b't' => self.lit("true").map(|_| J::Bool(true)),
            b'f' => self.lit("false").map(|_| J::Bool(false)),
            b'n' => self.lit("null").map(|_| J::Null),
            _ => {
                let s = self.i;
                while self.i < self.b.len() && matches!(self.b[self.i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
                    self.i += 1;
                }
                std::str::from_utf8(&self.b[s..self.i]).ok()?.parse::<f64>().ok().filter(|n| n.is_finite()).map(J::Num)
            }
        }
    }
}

/// A JSON text read (None when it is not one, or deeper or longer than allowed).
pub fn json(text: &str) -> Option<J> {
    let mut r = Rd { b: text.as_bytes(), i: 0, items: 0 };
    let v = r.value(0)?;
    r.ws();
    if r.i == r.b.len() {
        Some(v)
    } else {
        None
    }
}

/// One Bluetooth device as system_profiler reports it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SpDev {
    pub name: String,
    pub addr: String,
    pub connected: bool,
    pub kind: Option<Kind>,
    pub vid: u16,
    pub pid: u16,
    pub main: Option<u8>,
    pub left: Option<u8>,
    pub right: Option<u8>,
    pub case: Option<u8>,
}

fn pct(v: Option<&J>) -> Option<u8> {
    let s = v?.str()?.trim().trim_end_matches('%').trim();
    s.parse::<u8>().ok().filter(|p| *p <= 100)
}

fn hex16(v: Option<&J>) -> u16 {
    v.and_then(J::str).and_then(|s| u16::from_str_radix(s.trim().trim_start_matches("0x"), 16).ok()).unwrap_or(0)
}

/// «device_minorType» → our kind.
pub fn kind_of_minor(m: &str) -> Option<Kind> {
    let l = m.to_ascii_lowercase();
    Some(if l.contains("mouse") || l.contains("trackpad") {
        Kind::Mouse
    } else if l.contains("keyboard") {
        Kind::Keyboard
    } else if l.contains("headphone") || l.contains("headset") {
        Kind::Headset
    } else if l.contains("gamepad") || l.contains("joystick") || l.contains("game controller") {
        Kind::Controller
    } else if l.contains("speaker") {
        Kind::Speaker
    } else if l.contains("phone") {
        Kind::Phone
    } else {
        return None;
    })
}

/// The devices of `system_profiler SPBluetoothDataType -json` (macOS 12 and later; an older Mac's shape gives none).
pub fn system_profiler(text: &str) -> Vec<SpDev> {
    let Some(root) = json(text) else { return Vec::new() };
    let mut out = Vec::new();
    let Some(J::Arr(items)) = root.get("SPBluetoothDataType") else { return out };
    for it in items.iter().take(4) {
        for (list, connected) in [("device_connected", true), ("device_not_connected", false)] {
            let Some(J::Arr(devs)) = it.get(list) else { continue };
            for d in devs.iter().take(64) {
                let J::Obj(m) = d else { continue };
                for (name, p) in m.iter().take(1) {
                    let addr = p.get("device_address").and_then(J::str).and_then(crate::connect::parse_addr).map(crate::connect::addr_text).unwrap_or_default();
                    out.push(SpDev {
                        name: name.chars().filter(|c| !c.is_control()).take(128).collect(),
                        addr,
                        connected,
                        kind: p.get("device_minorType").and_then(J::str).and_then(kind_of_minor),
                        vid: hex16(p.get("device_vendorID")),
                        pid: hex16(p.get("device_productID")),
                        main: pct(p.get("device_batteryLevelMain")).or_else(|| pct(p.get("device_batteryLevel"))),
                        left: pct(p.get("device_batteryLevelLeft")),
                        right: pct(p.get("device_batteryLevelRight")),
                        case: pct(p.get("device_batteryLevelCase")),
                    });
                }
            }
        }
    }
    out.truncate(64);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const IOREG: &str = r#"+-o AppleDeviceManagementHIDEventService  <class AppleDeviceManagementHIDEventService, id 0x100000a01, registered, matched, active, busy 0 (0 ms), retain 7>
    {
      "LowBatteryNotificationPercentage" = 2
      "PrimaryUsagePage" = 1
      "BatteryPercent" = 67
      "Product" = "Made Up Keyboard"
      "VendorID" = 76
      "ProductID" = 615
      "PrimaryUsage" = 6
      "Transport" = "Bluetooth"
      "DeviceAddress" = "aa-bb-cc-dd-ee-0a"
      "BatteryStatusFlags" = 3
    }

+-o AppleDeviceManagementHIDEventService  <class AppleDeviceManagementHIDEventService, id 0x100000a02>
  | {
  |   "BatteryPercent" = 140
  |   "Product" = "Broken"
  | }
+-o Something  <class X>
    {
      "Product" = "No Battery Here"
    }
"#;

    #[test]
    fn ioreg_entries_with_a_level() {
        let l = ioreg(IOREG);
        assert_eq!(l.len(), 1, "{l:?}");
        let d = &l[0];
        assert_eq!((d.product.as_str(), d.vid, d.pid, d.percent, d.addr.as_str(), d.bluetooth), ("Made Up Keyboard", 76, 615, 67, "AA:BB:CC:DD:EE:0A", true));
        assert_eq!((d.usage_page, d.usage), (1, 6));
        assert!(ioreg("").is_empty());
        assert!(ioreg("\"BatteryPercent\" = 50\n").is_empty(), "a value outside an entry");
    }

    const SP: &str = r#"{
  "SPBluetoothDataType" : [
    {
      "controller_properties" : { "controller_state" : "attrib_on" },
      "device_connected" : [
        { "Test Buds" : { "device_address" : "AA:BB:CC:DD:EE:01", "device_batteryLevelLeft" : "80%", "device_batteryLevelRight" : "75%", "device_batteryLevelCase" : "40%", "device_minorType" : "Headphones", "device_vendorID" : "0x004C", "device_productID" : "0x2014" } },
        { "Test Mouse" : { "device_address" : "AA:BB:CC:DD:EE:02", "device_batteryLevelMain" : "55%", "device_minorType" : "Mouse" } },
        { "Odd \u00e9" : { "device_batteryLevelMain" : "300%" } }
      ],
      "device_not_connected" : [
        { "Test Pad" : { "device_address" : "AA:BB:CC:DD:EE:03", "device_minorType" : "Gamepad" } }
      ]
    }
  ]
}"#;

    #[test]
    fn system_profiler_devices() {
        let l = system_profiler(SP);
        assert_eq!(l.len(), 4);
        assert_eq!((l[0].name.as_str(), l[0].left, l[0].right, l[0].case, l[0].main, l[0].kind, l[0].vid, l[0].pid), ("Test Buds", Some(80), Some(75), Some(40), None, Some(Kind::Headset), 0x004C, 0x2014));
        assert_eq!((l[1].main, l[1].kind, l[1].connected), (Some(55), Some(Kind::Mouse), true));
        assert_eq!((l[2].name.as_str(), l[2].main, l[2].addr.as_str()), ("Odd é", None, ""), "300% is no level");
        assert_eq!((l[3].connected, l[3].kind, l[3].main), (false, Some(Kind::Controller), None));
        assert!(system_profiler("{}").is_empty());
        assert!(system_profiler("not json").is_empty());
    }

    #[test]
    fn json_reader_is_bounded() {
        assert_eq!(json("[1, 2.5, \"a\", true, null, {}]"), Some(J::Arr(vec![J::Num(1.0), J::Num(2.5), J::Str("a".into()), J::Bool(true), J::Null, J::Obj(vec![])])));
        assert!(json("[1,]").is_none());
        assert!(json("{\"a\" 1}").is_none());
        assert!(json("[1] x").is_none());
        let deep = "[".repeat(100) + &"]".repeat(100);
        assert!(json(&deep).is_none(), "deeper than allowed");
        assert!(json("\"\\uZZZZ\"").is_none());
        assert!(json("1e999").is_none(), "not finite");
    }
}
