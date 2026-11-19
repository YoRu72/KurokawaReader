// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): «Report a device» — a text the user can copy or save so that support for
// a device can be added, and the one document the command line prints.
// Reference: the original v1.1.0's src/report.cpp (what its support request holds: name, kind, vendor and product id,
// HID usage pages and report sizes, the system's build; its privacy line) and the phrases of lang/_template.txt.
// Changed here, and stricter: nothing is sent by the program — this module only builds the text, the user reads it
// whole, then copies it or saves it; no serial number (a unit is «device N», by its place in this text), no Bluetooth
// address (any address in a name is masked), no computer or user name (the caller lists them in `secrets`; a name that
// starts with a possessive — «Sam's mouse» — loses that word), no folder, no raw report contents (lengths only).
// Pure: the platform's part (what HID collections there are, the system's name) is given in.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::allow::HidIdent;
use crate::model::{Connection, Device, Level, Reading, Source};
use crate::registry::{self, Claim, Collection, Skip};
use crate::runner::DeviceState;
use crate::{mice, pads};

/// The report's and the command line's format number (written in both; raised when a field is removed or changes meaning).
pub const FORMAT: u32 = 1;

/// One HID collection a platform found (also those no reader wants), without anything that names its owner.
#[derive(Clone, Debug, PartialEq)]
pub struct HidSeen {
    /// Which physical unit it belongs to (identity.rs's key): used to group collections and to find the device's card;
    /// never written into the text.
    pub unit: String,
    pub vid: u16,
    pub pid: u16,
    /// The product name as the system gives it.
    pub product: String,
    pub connection: Connection,
    pub usage_page: u16,
    pub usage: u16,
    /// The USB interface number, -1 when not known.
    pub interface: i32,
    pub input_len: usize,
    pub output_len: usize,
    pub feature_len: usize,
    /// It declares a battery value field.
    pub battery_field: bool,
}

pub struct Input<'a> {
    pub app: &'a str,
    pub os_name: &'a str,
    pub os_version: &'a str,
    pub hid: &'a [HidSeen],
    pub devices: &'a [DeviceState],
    /// Texts that must never come out (serial numbers, addresses, the computer's and the user's name): masked in every
    /// name, case-insensitively.
    pub secrets: &'a [String],
    /// The units the user said not to query (their keys): said as «the user said not to read it».
    pub no_query: &'a [String],
}

/// A device's own reader: (family id, how far proven, how it reads) — «» for the generic readers and the system's.
pub fn reader_of(driver: &str) -> (&'static str, &'static str, &'static str) {
    let way = |w: pads::Way| match w {
        pads::Way::Passive => "listens",
        pads::Way::Query => "sends a status request",
    };
    if let Some(x) = pads::driver(driver) {
        return (x.family.as_str(), x.proven.as_str(), way(x.way));
    }
    if let Some(x) = mice::driver(driver) {
        return (x.family.as_str(), x.proven.as_str(), way(x.way));
    }
    ("", "", "")
}

/// «tested» or «untested»: only a family reader can be tested, and none is proven on hardware yet — every other reader
/// (the generic HID field, Windows' and the system's levels) is untested here too.
pub fn test_level(d: &Device) -> &'static str {
    match reader_of(d.driver).1 {
        "tested" => "tested",
        _ => "untested",
    }
}

fn eq_ci(a: char, b: char) -> bool {
    a == b || a.to_lowercase().eq(b.to_lowercase())
}

fn mask_secret(chars: Vec<char>, secret: &str, with: &str) -> Vec<char> {
    let s: Vec<char> = secret.chars().collect();
    if s.len() < 3 {
        return chars;
    }
    let mut out = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        if i + s.len() <= chars.len() && s.iter().enumerate().all(|(k, c)| eq_ci(chars[i + k], *c)) {
            out.extend(with.chars());
            i += s.len();
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// A Bluetooth address written as six pairs («AA:BB:CC:DD:EE:FF», «aa-bb-…») or as twelve digits on their own, masked.
fn mask_addresses(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let hex = |i: usize| c.get(i).map_or(false, |x| x.is_ascii_hexdigit());
    let word = |i: usize| c.get(i).map_or(false, |x| x.is_alphanumeric());
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        // (Six pairs with one separator.)
        if hex(i) && hex(i + 1) && (i == 0 || !word(i - 1)) {
            let sep = c.get(i + 2).copied();
            if matches!(sep, Some(':') | Some('-')) {
                let ok = (0..6).all(|k| hex(i + k * 3) && hex(i + k * 3 + 1) && (k == 5 || c.get(i + k * 3 + 2).copied() == sep)) && !word(i + 17);
                if ok {
                    out.push_str("[address]");
                    i += 17;
                    continue;
                }
            }
            // (Twelve hexadecimal digits standing alone.)
            if (0..12).all(|k| hex(i + k)) && !word(i + 12) {
                out.push_str("[address]");
                i += 12;
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

/// A name as it may be written in the report: control characters out, addresses and the secrets masked, a leading
/// possessive («Sam's …») reduced to «[name]'s», at most 80 characters.
pub fn scrub(s: &str, secrets: &[String]) -> String {
    let flat: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let mut chars: Vec<char> = mask_addresses(&flat).chars().collect();
    for sec in secrets {
        chars = mask_secret(chars, sec.trim(), "[private]");
    }
    let text: String = chars.into_iter().collect();
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    // (A first word ending in 's — «Sam's» — names a person as often as not.)
    let mut words = text.splitn(2, ' ');
    let first = words.next().unwrap_or("");
    let rest = words.next();
    let first_c: Vec<char> = first.chars().collect();
    let n = first_c.len();
    let possessive = n > 3 && (first_c[n - 2] == '\'' || first_c[n - 2] == '\u{2019}') && first_c[n - 1].eq_ignore_ascii_case(&'s') && rest.is_some();
    let text = if possessive { format!("[name]'s {}", rest.unwrap_or("")) } else { text };
    text.chars().take(80).collect::<String>().trim().to_string()
}

fn level_text(l: Level) -> String {
    match l {
        Level::Exact(p) => format!("exact {}%", p.get()),
        Level::Coarse(c) => format!("coarse {}", c.as_str()),
        Level::Steps(s) => format!("steps {} of {}", s.n(), s.max()),
        Level::Unknown => "unknown".to_string(),
    }
}

fn hex4(v: u16) -> String {
    format!("{:04X}", v)
}

fn ids_text(vid: u16, pid: u16) -> String {
    if vid == 0 && pid == 0 {
        "vendor id: unknown, product id: unknown".to_string()
    } else {
        format!("vendor id: {}, product id: {}", hex4(vid), hex4(pid))
    }
}

fn unit_of(st: &DeviceState, unit: &str) -> bool {
    let hit = |k: &str| k == unit || k.starts_with(&format!("{}:i:", unit));
    hit(&st.device.key) || st.device.merged.iter().any(|k| hit(k))
}

fn claim_text(all: &[Collection], c: &Collection, no_query: &[String]) -> String {
    match registry::classify(all, c, no_query) {
        Claim::Driver(d) => {
            let (fam, proven, way) = reader_of(d);
            if fam.is_empty() {
                format!("{} ({})", d, "untested")
            } else {
                format!("{} ({}, {}, {})", fam, d, proven, way)
            }
        }
        Claim::Defined => "one of the user's own device definitions".to_string(),
        Claim::Generic => "generic HID battery field (untested)".to_string(),
        Claim::Skip(Skip::Digitizer) => "none, left alone: a tablet or pen display".to_string(),
        Claim::Skip(Skip::PowerSupply) => "none, left alone: a power supply".to_string(),
        Claim::Skip(Skip::UserSaid) => "none, the user said not to read it".to_string(),
        Claim::Skip(Skip::NoBattery) => "none: no battery field and no built-in reader for this product".to_string(),
    }
}

/// The serial number or container text a unit key carries («hid:VID:PID:s:<serial>», «…:c:<container>»): masked in names too.
fn unit_secrets(unit: &str) -> Vec<String> {
    let mut v = Vec::new();
    for tag in [":s:", ":c:"] {
        if let Some(i) = unit.find(tag) {
            let rest = &unit[i + 3..];
            let end = rest.find(":i:").unwrap_or(rest.len());
            v.push(rest[..end].to_string());
        }
    }
    v
}

/// The report, in English (it is for the people who add support). Written so that the user can read all of it.
pub fn build(i: &Input) -> String {
    let mut secrets: Vec<String> = i.secrets.to_vec();
    for h in i.hid {
        secrets.extend(unit_secrets(&h.unit));
    }
    for st in i.devices {
        secrets.push(st.device.serial.clone());
        secrets.push(st.device.container.clone());
    }
    let secrets = &secrets[..];
    let mut o = String::new();
    o.push_str("Kurokawa Tools device report\n");
    o.push_str(&format!("Format: {}\n", FORMAT));
    o.push_str(&format!("App: {}\n", scrub(i.app, &[])));
    o.push_str(&format!("System: {}\n", format!("{} {}", scrub(i.os_name, &[]), scrub(i.os_version, &[])).trim()));
    o.push_str("Left out on purpose: serial numbers, Bluetooth addresses, the computer's and the user's name, folders, and what the devices send (only the sizes of their reports are given).\n");
    o.push_str("A device is called \"device N\" by its place in this text.\n\n");

    o.push_str(&format!("Devices the app sees ({})\n", i.devices.len()));
    if i.devices.is_empty() {
        o.push_str("none\n");
    }
    for (n, st) in i.devices.iter().enumerate() {
        let d = &st.device;
        let name = scrub(&d.name, secrets);
        o.push_str(&format!("\ndevice {}: {}\n", n + 1, if name.is_empty() { "(no name)" } else { &name }));
        o.push_str(&format!("  kind (a guess): {}, connection: {}\n", d.kind.as_str(), d.connection.as_str()));
        o.push_str(&format!("  {}\n", ids_text(d.vid, d.pid)));
        let (fam, _, way) = reader_of(d.driver);
        let reader = if !fam.is_empty() {
            format!("{} ({}, {})", fam, d.driver, way)
        } else {
            match d.source {
                Source::HidGeneric => "generic HID battery field".to_string(),
                s => format!("{} (the system's own or a built-in generic reader)", s.as_str()),
            }
        };
        o.push_str(&format!("  built-in reader: {}\n", reader));
        o.push_str(&format!("  test level: {}\n", test_level(d)));
        let (r, older): (Option<&Reading>, bool) = match (&st.reading, &st.last_good) {
            (Some(r), _) => (Some(r), false),
            (None, Some(r)) => (Some(r), true),
            _ => (None, false),
        };
        o.push_str(&format!("  status: {}\n", st.status.as_str()));
        match r {
            Some(r) => {
                let note = r.note.as_str();
                o.push_str(&format!("  last reading{}: {}, charging: {}, asleep: {}\n", if older { " (an older one)" } else { "" }, level_text(r.level), r.charging.as_str(), if r.asleep { "yes" } else { "no" }));
                o.push_str(&format!("  note: {}\n", if note.is_empty() { "none" } else { note }));
            }
            None => o.push_str("  last reading: none\n  note: none\n"),
        }
    }

    o.push_str(&format!("\nHID collections seen ({})\n", i.hid.len()));
    if i.hid.is_empty() {
        o.push_str("none (this system gives no list, or there is no HID device)\n");
    }
    let all: Vec<Collection> = i.hid.iter().map(|h| Collection { ident: HidIdent { vid: h.vid, pid: h.pid, usage_page: h.usage_page, usage: h.usage, interface: h.interface }, battery_field: h.battery_field, key: h.unit.clone() }).collect();
    let mut extra: Vec<String> = Vec::new();
    for (h, c) in i.hid.iter().zip(all.iter()) {
        let n = match i.devices.iter().position(|st| unit_of(st, &h.unit)) {
            Some(p) => p + 1,
            None => {
                let p = match extra.iter().position(|u| u == &h.unit) {
                    Some(p) => p,
                    None => {
                        extra.push(h.unit.clone());
                        extra.len() - 1
                    }
                };
                i.devices.len() + p + 1
            }
        };
        let name = scrub(&h.product, secrets);
        o.push_str(&format!("\ndevice {}: {}\n", n, if name.is_empty() { "(no name)" } else { &name }));
        o.push_str(&format!("  {}, connection: {}\n", ids_text(h.vid, h.pid), h.connection.as_str()));
        let iface = if h.interface >= 0 { h.interface.to_string() } else { "unknown".to_string() };
        o.push_str(&format!("  usage page: 0x{:04X}, usage: 0x{:04X}, interface: {}\n", h.usage_page, h.usage, iface));
        o.push_str(&format!("  report lengths: input {}, output {}, feature {}\n", h.input_len, h.output_len, h.feature_len));
        o.push_str(&format!("  battery field declared: {}\n", if h.battery_field { "yes" } else { "no" }));
        o.push_str(&format!("  built-in reader: {}\n", claim_text(&all, c, i.no_query)));
    }
    o
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Charging, Kind, Percent};
    use crate::runner::Status;

    const SERIAL: &str = "SN-9F3A7C21B";
    const ADDR: &str = "AA:BB:CC:11:22:33";
    const USER: &str = "Tester Person";

    fn state(key: &str, name: &str, kind: Kind, conn: Connection, src: Source, vid: u16, pid: u16, driver: &'static str, pct: Option<u8>) -> DeviceState {
        let mut d = Device::new(key.into(), src);
        d.name = name.into();
        d.kind = kind;
        d.connection = conn;
        d.vid = vid;
        d.pid = pid;
        d.serial = SERIAL.into();
        d.container = ADDR.into();
        d.driver = driver;
        let r = pct.map(|p| Reading::new(Level::Exact(Percent::new(p as i64).unwrap()), Charging::No, 1_000));
        DeviceState { device: d, reading: r, last_good: r, status: if pct.is_some() { Status::Ok } else { Status::NotConnected }, checked_at: 1_000 }
    }

    fn hid(unit: &str, vid: u16, pid: u16, page: u16, usage: u16, battery: bool) -> HidSeen {
        HidSeen { unit: unit.into(), vid, pid, product: format!("Made-up product {:04X}", pid), connection: Connection::Usb, usage_page: page, usage, interface: 2, input_len: 21, output_len: 8, feature_len: 3, battery_field: battery }
    }

    fn sample() -> (Vec<HidSeen>, Vec<DeviceState>) {
        let key = format!("hid:1234:0001:s:{}", SERIAL);
        let devices = vec![
            state(&key, "Test Mouse X", Kind::Mouse, Connection::Usb, Source::HidGeneric, 0x1234, 0x0001, "", Some(80)),
            state(&format!("bt:{}", ADDR), &format!("Tester Person's Buds {}", ADDR), Kind::Earbuds, Connection::Bluetooth, Source::Bluetooth, 0, 0, "", None),
        ];
        let mut h1 = hid(&key, 0x1234, 0x0001, 0x01, 0x02, true);
        h1.product = format!("Test Mouse X {}", SERIAL);
        let hids = vec![h1, hid("hid:5678:00aa:p:0f0f", 0x5678, 0x00AA, 0xFF00, 0x01, false)];
        (hids, devices)
    }

    fn secrets() -> Vec<String> {
        vec![SERIAL.to_string(), ADDR.to_string(), USER.to_string(), "TESTPC-LAPTOP".to_string()]
    }

    #[test]
    fn the_report_holds_what_support_needs() {
        let (hids, devices) = sample();
        let text = build(&Input { app: "Kurokawa Tools 0.21.0", os_name: "Windows 11", os_version: "10.0.22631", hid: &hids, devices: &devices, secrets: &secrets(), no_query: &[] });
        for want in [
            "Format: 1", "App: Kurokawa Tools 0.21.0", "System: Windows 11 10.0.22631", "Devices the app sees (2)", "device 1: Test Mouse X", "kind (a guess): mouse, connection: usb",
            "vendor id: 1234, product id: 0001", "test level: untested", "last reading: exact 80%, charging: no, asleep: no", "status: notConnected", "HID collections seen (2)",
            "usage page: 0x0001, usage: 0x0002, interface: 2", "report lengths: input 21, output 8, feature 3", "battery field declared: yes", "generic HID battery field",
            "device 3: Made-up product 00AA", "usage page: 0xFF00", "none: no battery field and no built-in reader",
        ] {
            assert!(text.contains(want), "missing «{}» in:\n{}", want, text);
        }
    }

    #[test]
    fn nothing_forbidden_comes_out() {
        let (hids, devices) = sample();
        let text = build(&Input { app: "Kurokawa Tools 0.21.0", os_name: "Windows 11", os_version: "10.0.22631", hid: &hids, devices: &devices, secrets: &secrets(), no_query: &[] });
        let low = text.to_lowercase();
        for bad in [SERIAL, "9f3a7c21b", ADDR, "aa:bb:cc", "aabbcc112233", "aa-bb-cc", USER, "tester", "testpc", "c:\\", "/home/", "/users/", "\\\\?\\", "hid#vid"] {
            assert!(!low.contains(&bad.to_lowercase()), "«{}» must not appear:\n{}", bad, text);
        }
        // (The unit keys carry the serial and the address: never written.)
        assert!(!text.contains("hid:1234"), "no key in the text");
        assert!(!text.contains("bt:"), "no key in the text");
        assert!(text.contains("device 2: [name]'s Buds [address]") || text.contains("device 2: [private]"), "the buds' name is masked:\n{}", text);
    }

    #[test]
    fn a_hid_collection_joins_its_devices_card_and_others_get_the_next_numbers() {
        let (hids, devices) = sample();
        let text = build(&Input { app: "a", os_name: "Linux", os_version: "6", hid: &hids, devices: &devices, secrets: &[], no_query: &[] });
        let first = text.find("HID collections seen").unwrap();
        let part = &text[first..];
        assert!(part.contains("device 1: Test Mouse X [private]") || part.contains("device 1: Test Mouse X"), "the first collection is device 1");
        assert!(part.contains("device 3:"), "an unread product is the next number");
        assert!(!part.contains("device 2:"));
    }

    #[test]
    fn a_family_readers_name_and_test_level_are_written() {
        let driver = pads::DRIVERS.first().expect("a pad reader exists").id;
        let (fam, proven, _) = reader_of(driver);
        assert!(!fam.is_empty());
        let mut st = state("hid:054c:0ce6:p:1", "Made-up Pad", Kind::Controller, Connection::Usb, Source::Pad, 0x054C, 0x0CE6, driver, Some(50));
        st.device.serial.clear();
        let hids = vec![hid("hid:054c:0ce6:p:1", 0x054C, 0x0CE6, 0x01, 0x05, false)];
        let text = build(&Input { app: "a", os_name: "Linux", os_version: "6", hid: &hids, devices: &[st.clone()], secrets: &[], no_query: &[] });
        assert!(text.contains(&format!("built-in reader: {} ({}", fam, driver)), "{}", text);
        assert!(text.contains(&format!("test level: {}", if proven == "tested" { "tested" } else { "untested" })));
        assert!(text.contains("controller"));
        // (The same collection with the user's word: left alone.)
        let said = build(&Input { app: "a", os_name: "Linux", os_version: "6", hid: &hids, devices: &[st], secrets: &[], no_query: &["hid:054c:0ce6:p:1".to_string()] });
        assert!(said.contains("the user said not to read it"));
    }

    #[test]
    fn scrub_masks_addresses_secrets_and_possessives() {
        assert_eq!(scrub("Mouse AA:BB:CC:DD:EE:FF", &[]), "Mouse [address]");
        assert_eq!(scrub("aa-bb-cc-dd-ee-ff", &[]), "[address]");
        assert_eq!(scrub("AABBCCDDEEFF headset", &[]), "[address] headset");
        assert_eq!(scrub("Model A1B2C3D4E5F6A7", &[]), "Model A1B2C3D4E5F6A7", "a longer token is no address");
        assert_eq!(scrub("Sam's Mouse", &[]), "[name]'s Mouse");
        assert_eq!(scrub("Sam\u{2019}s Mouse", &[]), "[name]'s Mouse");
        assert_eq!(scrub("Xbox Wireless Controller", &[]), "Xbox Wireless Controller");
        assert_eq!(scrub("Desk\u{0}Mouse\n2", &[]), "Desk Mouse 2");
        assert_eq!(scrub("pad of LAPTOP-7 owner", &["laptop-7".to_string()]), "pad of [private] owner");
        // (A short secret is left: it would mask half the text.)
        assert_eq!(scrub("ab mouse", &["ab".to_string()]), "ab mouse");
        // (Non-ASCII names stay readable; a secret in Arabic is masked.)
        assert_eq!(scrub("ماوس وسام", &["وسام".to_string()]), "ماوس [private]");
        assert_eq!(scrub(&"x".repeat(200), &[]).chars().count(), 80);
    }

    #[test]
    fn a_serial_in_a_product_name_of_an_unknown_unit_is_masked_from_its_key() {
        let mut h = hid("hid:5678:00aa:s:ZX81-SERIAL-77", 0x5678, 0x00AA, 0xFF00, 1, false);
        h.product = "Odd dongle ZX81-SERIAL-77".into();
        let text = build(&Input { app: "a", os_name: "Linux", os_version: "", hid: &[h], devices: &[], secrets: &[], no_query: &[] });
        assert!(!text.to_lowercase().contains("zx81") && text.contains("Odd dongle [private]"), "{}", text);
    }

    #[test]
    fn an_empty_system_gives_a_short_honest_report() {
        let text = build(&Input { app: "a", os_name: "Linux", os_version: "", hid: &[], devices: &[], secrets: &[], no_query: &[] });
        assert!(text.contains("Devices the app sees (0)\nnone"));
        assert!(text.contains("HID collections seen (0)\nnone"));
        assert!(text.contains("System: Linux\n"));
    }
}
