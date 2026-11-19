// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery), piece P1: what Linux's /sys tells of HID devices and peripherals'
// batteries — read as files, never by opening a device.
// Derived from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/linux/hid_linux.cpp (EnumHid, ReadUevent, InterfaceOf) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by
// krisgfx9 and its contributors, GPL-3.0-or-later.
// Changed here: enumeration reads each node's report descriptor from /sys (readable by everyone) instead of opening
// every hidraw node read/write as the original did — a node is opened only later, by the reader that needs it, read-only
// unless allow.rs names it; the interface number is the USB interface's, and -1 for a device with one interface or on
// Bluetooth (as Windows' path gives it, so the readers' tables match); a peripheral battery the kernel already keeps
// (/sys/class/power_supply, scope «Device») is read from there — Tools then sends nothing to that device at all.
// The roots are parameters: the tests build their own trees in a temp folder.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::model::{Charging, Coarse};
use std::path::{Path, PathBuf};

/// «KEY=value» lines.
pub fn uevent(text: &str) -> Vec<(String, String)> {
    text.lines().take(256).filter_map(|l| l.split_once('=')).map(|(k, v)| (k.trim().to_string(), v.trim().to_string())).collect()
}

fn get<'a>(kv: &'a [(String, String)], k: &str) -> Option<&'a str> {
    kv.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str())
}

/// «0003:0000046D:0000C52B» → (bus, vendor, product); None for anything else.
pub fn hid_id(s: &str) -> Option<(u16, u16, u16)> {
    let mut it = s.trim().split(':');
    let (b, v, p) = (it.next()?, it.next()?, it.next()?);
    if it.next().is_some() {
        return None;
    }
    let n = |x: &str| if !x.is_empty() && x.len() <= 8 { u32::from_str_radix(x, 16).ok().filter(|v| *v <= 0xFFFF).map(|v| v as u16) } else { None };
    Some((n(b)?, n(v)?, n(p)?))
}

/// A HID device's directory name «0005:054C:0CE6.0007» → (bus, vendor, product).
pub fn hid_dir_ids(name: &str) -> Option<(u16, u16, u16)> {
    let (ids, inst) = name.rsplit_once('.')?;
    if inst.is_empty() || !inst.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let mut it = ids.split(':');
    let (b, v, p) = (it.next()?, it.next()?, it.next()?);
    if it.next().is_some() || [b, v, p].iter().any(|x| x.len() != 4) {
        return None;
    }
    Some((u16::from_str_radix(b, 16).ok()?, u16::from_str_radix(v, 16).ok()?, u16::from_str_radix(p, 16).ok()?))
}

pub const BUS_USB: u16 = 0x03;
pub const BUS_BLUETOOTH: u16 = 0x05;

/// One hidraw node as /sys describes it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HidrawNode {
    /// «hidraw3» (the device file is /dev/hidraw3).
    pub node: String,
    /// The HID device's directory name, «0003:046D:C52B.0003».
    pub hid_dir: String,
    /// Its real place in /sys (a paired device's sits under its receiver's).
    pub hid_path: PathBuf,
    pub bus: u16,
    pub vid: u16,
    pub pid: u16,
    pub name: String,
    pub phys: String,
    /// HID_UNIQ: a Bluetooth device's address, a USB device's serial number, often empty.
    pub uniq: String,
    /// The USB interface number on a device of several interfaces, else -1.
    pub interface: i32,
    pub descriptor: Vec<u8>,
}

impl HidrawNode {
    /// The physical device it belongs to, for keys and merging: a Bluetooth device's address (upper case); else the
    /// USB port path its HID_PHYS names, without the «/inputN» of the interface.
    pub fn container(&self) -> String {
        if self.bus == BUS_BLUETOOTH {
            if let Some(a) = crate::connect::parse_addr(&self.uniq) {
                return crate::connect::addr_text(a);
            }
        }
        match self.phys.rsplit_once("/input") {
            Some((p, n)) if n.chars().all(|c| c.is_ascii_digit()) => p.to_string(),
            _ => self.phys.clone(),
        }
    }
}

fn read_small(p: &Path, max: u64) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut v = Vec::new();
    std::fs::File::open(p).ok()?.take(max).read_to_end(&mut v).ok()?;
    Some(v)
}

fn read_text(p: &Path) -> Option<String> {
    read_small(p, 64 * 1024).map(|v| String::from_utf8_lossy(&v).into_owned())
}

/// The USB interface number from the interface directory's name «1-1.2:1.3» → 3, when its device has more than one
/// interface (bNumInterfaces in the directory above).
fn usb_interface(hid_path: &Path) -> i32 {
    let Some(iface_dir) = hid_path.parent() else { return -1 };
    let Some(name) = iface_dir.file_name().and_then(|n| n.to_str()) else { return -1 };
    let Some((_, cfg_if)) = name.rsplit_once(':') else { return -1 };
    let Some((_, n)) = cfg_if.split_once('.') else { return -1 };
    let Ok(n) = n.parse::<i32>() else { return -1 };
    let count = iface_dir.parent().and_then(|d| read_text(&d.join("bNumInterfaces"))).and_then(|t| t.trim().parse::<u32>().ok()).unwrap_or(0);
    if count > 1 {
        n
    } else {
        -1
    }
}

fn valid_node_name(n: &str) -> bool {
    n.strip_prefix("hidraw").map_or(false, |d| !d.is_empty() && d.len() <= 6 && d.chars().all(|c| c.is_ascii_digit()))
}

/// Every hidraw node under `sys` (normally «/sys»), sorted by name; at most 256.
pub fn hidraw_nodes(sys: &Path) -> Vec<HidrawNode> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(sys.join("class/hidraw")) else { return out };
    let mut names: Vec<String> = rd.filter_map(|e| e.ok()).filter_map(|e| e.file_name().to_str().map(str::to_string)).filter(|n| valid_node_name(n)).collect();
    names.sort_by_key(|n| n[6..].parse::<u32>().unwrap_or(u32::MAX));
    for node in names.into_iter().take(256) {
        let link = sys.join("class/hidraw").join(&node).join("device");
        let Ok(hid_path) = std::fs::canonicalize(&link) else { continue };
        let Some(hid_dir) = hid_path.file_name().and_then(|n| n.to_str()).map(str::to_string) else { continue };
        let Some(ev) = read_text(&hid_path.join("uevent")) else { continue };
        let kv = uevent(&ev);
        let Some((bus, vid, pid)) = get(&kv, "HID_ID").and_then(hid_id) else { continue };
        let descriptor = read_small(&hid_path.join("report_descriptor"), crate::hiddesc::MAX_DESCRIPTOR as u64).unwrap_or_default();
        let interface = if bus == BUS_USB { usb_interface(&hid_path) } else { -1 };
        let clean = |s: Option<&str>| s.unwrap_or("").chars().filter(|c| !c.is_control()).take(128).collect::<String>().trim().to_string();
        out.push(HidrawNode { node, hid_dir, bus, vid, pid, name: clean(get(&kv, "HID_NAME")), phys: clean(get(&kv, "HID_PHYS")), uniq: clean(get(&kv, "HID_UNIQ")), interface, descriptor, hid_path });
    }
    out
}

/// A peripheral's battery as the kernel keeps it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PowerSupply {
    pub name: String,
    pub capacity: Option<u8>,
    pub level: Option<Coarse>,
    pub charging: Charging,
    pub model: String,
    pub manufacturer: String,
    pub serial: String,
    /// POWER_SUPPLY_PRESENT=0: the device is away.
    pub present: bool,
    /// The HID device it belongs to (its directory's real place), when it is one.
    pub hid_path: Option<PathBuf>,
}

/// The kernel's batteries of peripherals by their names, for the entries that do not say their scope (older kernels).
fn peripheral_name(n: &str) -> bool {
    let l = n.to_ascii_lowercase();
    ["hid-", "hidpp_battery", "sony_controller_battery", "ps-controller-battery", "nintendo_switch_controller_battery", "xpadneo", "wacom_battery", "steam-controller", "wiimote_battery", "apple_battery"].iter().any(|p| l.starts_with(p))
}

/// One /sys/class/power_supply entry's uevent read: Some only for a peripheral's battery (type Battery, scope Device —
/// or, with no scope, a name of the kernel's peripheral drivers); a laptop's own battery and mains never.
pub fn parse_power_supply(text: &str) -> Option<PowerSupply> {
    let kv = uevent(text);
    let g = |k: &str| get(&kv, &format!("POWER_SUPPLY_{}", k)).map(|v| v.chars().filter(|c| !c.is_control()).take(128).collect::<String>());
    let name = g("NAME").unwrap_or_default();
    if name.is_empty() || g("TYPE").as_deref() != Some("Battery") {
        return None;
    }
    match g("SCOPE").as_deref() {
        Some("Device") => {}
        Some(_) => return None,
        None if peripheral_name(&name) => {}
        None => return None,
    }
    let capacity = g("CAPACITY").and_then(|c| c.trim().parse::<i64>().ok()).filter(|c| (0..=100).contains(c)).map(|c| c as u8);
    let level = match g("CAPACITY_LEVEL").as_deref() {
        Some("Critical") => Some(Coarse::Empty),
        Some("Low") => Some(Coarse::Low),
        Some("Normal") => Some(Coarse::Medium),
        Some("High") => Some(Coarse::High),
        Some("Full") => Some(Coarse::Full),
        _ => None,
    };
    let charging = match g("STATUS").as_deref() {
        Some("Charging") => Charging::Yes,
        Some("Discharging") | Some("Not charging") | Some("Full") => Charging::No,
        _ => Charging::Unknown,
    };
    Some(PowerSupply {
        name,
        capacity,
        level,
        charging,
        model: g("MODEL_NAME").unwrap_or_default().trim().to_string(),
        manufacturer: g("MANUFACTURER").unwrap_or_default().trim().to_string(),
        serial: g("SERIAL_NUMBER").unwrap_or_default().trim().to_string(),
        present: g("PRESENT").map_or(true, |p| p.trim() != "0"),
        hid_path: None,
    })
}

/// The peripherals' batteries under `sys` (normally «/sys»): at most 64.
pub fn power_supplies(sys: &Path) -> Vec<PowerSupply> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(sys.join("class/power_supply")) else { return out };
    let mut dirs: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    dirs.sort();
    for d in dirs.into_iter().take(256) {
        let Some(t) = read_text(&d.join("uevent")) else { continue };
        let Some(mut ps) = parse_power_supply(&t) else { continue };
        // (Its device: a HID device's directory, when the kernel's HID drivers made it.)
        ps.hid_path = std::fs::canonicalize(d.join("device")).ok().filter(|p| p.file_name().and_then(|n| n.to_str()).and_then(hid_dir_ids).is_some());
        out.push(ps);
        if out.len() >= 64 {
            break;
        }
    }
    out
}

/// Whether the kernel keeps the battery of the HID device at `hid_path` or of one below it (a receiver's paired
/// devices): Tools' own readers then leave that node alone.
pub fn kept_by_kernel(hid_path: &Path, supplies: &[PowerSupply]) -> bool {
    supplies.iter().filter_map(|s| s.hid_path.as_deref()).any(|p| p.starts_with(hid_path))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn tmp(tag: &str) -> Tmp {
        let p = std::env::temp_dir().join(format!("kt-bat-sysfs-{}-{}-{:?}", tag, std::process::id(), std::thread::current().id()).replace(['(', ')'], ""));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }
    fn w(p: &Path, s: &[u8]) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, s).unwrap();
    }

    #[test]
    fn ids() {
        assert_eq!(hid_id("0003:0000046D:0000C52B"), Some((3, 0x046D, 0xC52B)));
        assert_eq!(hid_id("0005:0000054C:00000CE6"), Some((5, 0x054C, 0x0CE6)));
        assert_eq!(hid_id("0003:0001046D:0000C52B"), None, "over 16 bits");
        assert_eq!(hid_id("0003:046D"), None);
        assert_eq!(hid_id("0003:046D:C52B:1"), None);
        assert_eq!(hid_dir_ids("0005:054C:0CE6.0007"), Some((5, 0x054C, 0x0CE6)));
        assert_eq!(hid_dir_ids("1-1:1.0"), None);
        assert_eq!(hid_dir_ids("0005:054C:0CE6"), None);
    }

    #[test]
    fn hidraw_nodes_from_a_made_up_tree() {
        let t = tmp("hidraw");
        let sys = t.0.join("sys");
        // (A USB receiver of three interfaces, its interface 2; and a Bluetooth pad.)
        let usb = sys.join("devices/pci0000:00/0000:00:14.0/usb1/1-1");
        w(&usb.join("bNumInterfaces"), b" 3\n");
        let rx = usb.join("1-1:1.2/0003:1234:5678.0003");
        w(&rx.join("uevent"), b"DRIVER=hid-generic\nHID_ID=0003:00001234:00005678\nHID_NAME=Made Up Receiver\nHID_PHYS=usb-0000:00:14.0-1/input2\nHID_UNIQ=\n");
        w(&rx.join("report_descriptor"), &[0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0xC0]);
        let bt = sys.join("devices/virtual/misc/uhid/0005:ABCD:0001.0007");
        w(&bt.join("uevent"), b"HID_ID=0005:0000ABCD:00000001\nHID_NAME=Test Pad\nHID_PHYS=00:11:22:33:44:55\nHID_UNIQ=aa:bb:cc:dd:ee:01\n");
        std::fs::create_dir_all(sys.join("class/hidraw/hidraw10")).unwrap();
        std::fs::create_dir_all(sys.join("class/hidraw/hidraw2")).unwrap();
        std::fs::create_dir_all(sys.join("class/hidraw/notanode")).unwrap();
        symlink(&rx, sys.join("class/hidraw/hidraw2/device")).unwrap();
        symlink(&bt, sys.join("class/hidraw/hidraw10/device")).unwrap();
        let n = hidraw_nodes(&sys);
        assert_eq!(n.len(), 2);
        assert_eq!((n[0].node.as_str(), n[0].vid, n[0].pid, n[0].bus, n[0].interface), ("hidraw2", 0x1234, 0x5678, 3, 2));
        assert_eq!(n[0].name, "Made Up Receiver");
        assert_eq!(n[0].hid_dir, "0003:1234:5678.0003");
        assert_eq!(n[0].descriptor.len(), 7);
        assert_eq!(n[0].container(), "usb-0000:00:14.0-1");
        assert_eq!((n[1].node.as_str(), n[1].bus, n[1].interface), ("hidraw10", 5, -1));
        assert_eq!(n[1].container(), "AA:BB:CC:DD:EE:01", "a Bluetooth device: its address");
        assert!(n[1].descriptor.is_empty(), "no descriptor file: empty, still listed");
        // (A single-interface USB device: -1, as Windows' path without «&mi_».)
        w(&usb.join("bNumInterfaces"), b" 1\n");
        assert_eq!(hidraw_nodes(&sys)[0].interface, -1);
        assert!(hidraw_nodes(&t.0.join("nothing")).is_empty());
    }

    #[test]
    fn power_supply_entries_of_peripherals_only() {
        let pad = "POWER_SUPPLY_NAME=ps-controller-battery-aa:bb:cc:dd:ee:01\nPOWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_SCOPE=Device\nPOWER_SUPPLY_STATUS=Discharging\nPOWER_SUPPLY_CAPACITY=65\nPOWER_SUPPLY_PRESENT=1\n";
        let p = parse_power_supply(pad).unwrap();
        assert_eq!((p.capacity, p.charging, p.present), (Some(65), Charging::No, true));
        let laptop = "POWER_SUPPLY_NAME=BAT0\nPOWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_SCOPE=System\nPOWER_SUPPLY_CAPACITY=80\n";
        assert!(parse_power_supply(laptop).is_none(), "the computer's own battery");
        assert!(parse_power_supply("POWER_SUPPLY_NAME=BAT1\nPOWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_CAPACITY=80\n").is_none(), "no scope, not a peripheral's name");
        assert!(parse_power_supply("POWER_SUPPLY_NAME=AC\nPOWER_SUPPLY_TYPE=Mains\nPOWER_SUPPLY_SCOPE=Device\n").is_none());
        let old = parse_power_supply("POWER_SUPPLY_NAME=hidpp_battery_0\nPOWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_CAPACITY_LEVEL=Low\nPOWER_SUPPLY_STATUS=Charging\nPOWER_SUPPLY_MODEL_NAME=Made Up Mouse\n").unwrap();
        assert_eq!((old.capacity, old.level, old.charging, old.model.as_str()), (None, Some(Coarse::Low), Charging::Yes, "Made Up Mouse"));
        let odd = parse_power_supply("POWER_SUPPLY_NAME=hid-x-battery\nPOWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_SCOPE=Device\nPOWER_SUPPLY_CAPACITY=140\nPOWER_SUPPLY_PRESENT=0\n").unwrap();
        assert_eq!((odd.capacity, odd.present), (None, false), "a value over 100 is no level");
        assert!(parse_power_supply("").is_none());
    }

    #[test]
    fn power_supplies_tie_to_their_hid_device() {
        let t = tmp("ps");
        let sys = t.0.join("sys");
        let rx = sys.join("devices/usb1/1-2/1-2:1.2/0003:1234:5678.0004");
        let mouse = rx.join("0003:1234:4082.0009");
        std::fs::create_dir_all(&mouse).unwrap();
        let ps = sys.join("class/power_supply/hidpp_battery_3");
        w(&ps.join("uevent"), b"POWER_SUPPLY_NAME=hidpp_battery_3\nPOWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_SCOPE=Device\nPOWER_SUPPLY_CAPACITY=40\n");
        symlink(&mouse, ps.join("device")).unwrap();
        let bat0 = sys.join("class/power_supply/BAT0");
        w(&bat0.join("uevent"), b"POWER_SUPPLY_NAME=BAT0\nPOWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_SCOPE=System\n");
        let list = power_supplies(&sys);
        assert_eq!(list.len(), 1);
        let hp = list[0].hid_path.clone().unwrap();
        assert!(hp.ends_with("0003:1234:4082.0009"));
        // (The receiver's node: its paired mouse's battery is the kernel's — the receiver is left alone.)
        let rx_real = std::fs::canonicalize(&rx).unwrap();
        assert!(kept_by_kernel(&rx_real, &list));
        assert!(!kept_by_kernel(&std::fs::canonicalize(sys.join("devices/usb1/1-2")).unwrap().join("other"), &list));
    }
}
