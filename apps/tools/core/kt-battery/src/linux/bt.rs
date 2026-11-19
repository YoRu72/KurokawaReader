// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery), piece P1: connecting Bluetooth devices on Linux, through BlueZ's own
// `bluetoothctl` (connect.rs's BtPlatform; connect.rs decides what is offered and bounds every call).
// Written for Tools. bluetoothctl is run only from its fixed places (bluez.rs BLUETOOTHCTL), with fixed arguments: an
// address goes in only as made from a parsed number (bluez.rs addr_arg); each run has the deadline of its call and is
// killed and reaped past it (sysprog.rs). Pairing is never done here — `pair` answers «settings», and the page opens
// the desktop's own Bluetooth settings, which ask for any code themselves (no PIN of ours, ever). A scan runs
// bluetoothctl's own bounded discovery (`--timeout`), which also ends the discovery when it stops.
// The device list has no Windows nodes: each paired device is given a node of its own (its address as its container),
// so the connect panel's levels (the battery loop's «bt:<address>» cards) find it.
// UNVERIFIED here: the parsers are unit-tested with made-up output; no radio was used.
// Copyright (C) 2026 Kurokawa contributors.
use crate::bluetooth::BtNode;
use crate::bluez;
use crate::connect::{self, Addr, BtPlatform, Classic, End, Radio};
use crate::model::{Kind, Percent};
use crate::sysprog::{self, RunErr};
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct LinuxBt {}

/// At most this many devices are asked for their details per list.
const MAX_DETAILS: usize = 16;

fn ctl(args: &[&str], deadline: Instant) -> Result<sysprog::Ran, RunErr> {
    let prog = sysprog::find(bluez::BLUETOOTHCTL).ok_or(RunErr::Missing)?;
    sysprog::run(&prog, args, deadline, 256 * 1024)
}

/// The node a paired device is given (connect.rs merge reads its address and container from it).
pub fn node_of(addr: Addr, name: &str, connected: bool) -> BtNode {
    BtNode { instance_id: format!("BTHENUM\\DEV_{:012X}\\LINUX", addr), container: Some(connect::addr_text(addr)), name: name.to_string(), connected: Some(connected), ..Default::default() }
}

impl LinuxBt {
    fn paired_list(&self, deadline: Instant) -> Vec<(Addr, String)> {
        let first = ctl(&["devices", "Paired"], deadline).map(|r| bluez::device_lines(&r.out)).unwrap_or_default();
        if !first.is_empty() {
            return first;
        }
        // (Older BlueZ: «paired-devices».)
        ctl(&["paired-devices"], deadline).map(|r| bluez::device_lines(&r.out)).unwrap_or_default()
    }

    fn details(&self, deadline: Instant) -> Vec<bluez::Info> {
        let mut out = Vec::new();
        for (addr, name) in self.paired_list(deadline).into_iter().take(MAX_DETAILS) {
            let Some(a) = bluez::addr_arg(addr) else { continue };
            if Instant::now() >= deadline {
                break;
            }
            let mut i = ctl(&["info", &a], deadline).ok().and_then(|r| bluez::info(addr, &r.out)).unwrap_or_else(|| bluez::Info { classic: Classic { addr, name: name.clone(), authenticated: true, ..Default::default() }, ..Default::default() });
            if i.classic.name.is_empty() {
                i.classic.name = name;
            }
            out.push(i);
        }
        out
    }

    /// The connected devices that tell their level (for the battery loop when UPower is not there): (address, name,
    /// kind, level).
    pub fn levels(&self, deadline: Instant) -> Vec<(Addr, String, Kind, Percent)> {
        self.details(deadline)
            .into_iter()
            .filter(|i| i.classic.connected)
            .filter_map(|i| {
                let p = Percent::new(i.battery? as i64)?;
                let kind = bluez::kind_of_icon(&i.icon).unwrap_or_else(|| crate::kind::guess(&i.classic.name));
                Some((i.classic.addr, i.classic.name, kind, p))
            })
            .collect()
    }

    fn act(&self, verb: &str, addr: Addr, deadline: Instant) -> End {
        let Some(a) = bluez::addr_arg(addr) else { return End::Unreachable };
        match ctl(&[verb, &a], deadline) {
            Ok(r) => bluez::end_of(&r.out, verb == "connect"),
            Err(RunErr::TimedOut) => End::TimedOut,
            Err(RunErr::Missing) => End::Settings,
            Err(_) => End::Failed(0),
        }
    }
}

impl BtPlatform for LinuxBt {
    fn radio(&self) -> Radio {
        match ctl(&["show"], Instant::now() + Duration::from_millis(1_500)) {
            Ok(r) => bluez::radio(&r.out),
            Err(_) => Radio::Missing,
        }
    }
    fn paired(&self) -> Vec<Classic> {
        self.details(Instant::now() + Duration::from_millis(3_500)).into_iter().map(|i| i.classic).filter(|c| c.paired()).collect()
    }
    fn nodes(&self) -> Vec<BtNode> {
        // (Made from the same list: one per paired device, its address its container.)
        self.paired_list(Instant::now() + Duration::from_millis(1_000)).into_iter().map(|(a, n)| node_of(a, &n, false)).collect()
    }
    fn inquire(&self, ms: u64) -> Vec<Classic> {
        let secs = ((ms + 999) / 1000).clamp(1, 60).to_string();
        let deadline = Instant::now() + Duration::from_millis(ms.min(60_000) + 2_000);
        ctl(&["--timeout", &secs, "scan", "on"], deadline)
            .map(|r| bluez::device_lines(&r.out).into_iter().map(|(addr, name)| Classic { addr, name, ..Default::default() }).collect())
            .unwrap_or_default()
    }
    fn connect(&self, addr: Addr, deadline: Instant) -> End {
        self.act("connect", addr, deadline)
    }
    fn disconnect(&self, addr: Addr, deadline: Instant) -> End {
        self.act("disconnect", addr, deadline)
    }
    fn pair(&self, _addr: Addr, _deadline: Instant) -> End {
        // (The desktop's own Bluetooth settings pair; Tools never does, and never sees a code.)
        End::Settings
    }
}

/// The desktops' own Bluetooth settings, in the order tried (each at its fixed place, with fixed arguments): GNOME,
/// KDE Plasma 6 and 5, COSMIC, Blueman, Blueberry.
pub const SETTINGS_PROGRAMS: &[(&str, &[&str])] = &[
    ("/usr/bin/gnome-control-center", &["bluetooth"]),
    ("/usr/bin/systemsettings", &["kcm_bluetooth"]),
    ("/usr/bin/systemsettings5", &["kcm_bluetooth"]),
    ("/usr/bin/cosmic-settings", &["bluetooth"]),
    ("/usr/bin/blueman-manager", &[]),
    ("/usr/bin/blueberry", &[]),
];

/// Opens the first of the desktop's Bluetooth settings found; false when none is there.
pub fn open_settings() -> bool {
    SETTINGS_PROGRAMS.iter().any(|(p, args)| sysprog::find(&[p]).map_or(false, |prog| sysprog::spawn_detached(&prog, args)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nodes_carry_the_address_as_container() {
        let n = node_of(0xAABBCCDDEE01, "Test Headset", true);
        assert_eq!(connect::addr_from_instance(&n.instance_id), Some((0xAABBCCDDEE01, false)));
        assert_eq!(n.container.as_deref(), Some("AA:BB:CC:DD:EE:01"));
        let c = Classic { addr: 0xAABBCCDDEE01, name: "Test Headset".into(), connected: true, authenticated: true, services: vec![connect::Svc::Audio], ..Default::default() };
        let list = connect::merge(&[c], &[n], &[("AA:BB:CC:DD:EE:01".into(), 64)]);
        assert_eq!(list[0].battery, Some(64), "the battery loop's level reaches the panel");
        assert_eq!(list[0].can, connect::Can::Both);
    }

    #[test]
    fn pairing_is_the_systems() {
        assert_eq!(LinuxBt::default().pair(1, Instant::now() + Duration::from_secs(1)), End::Settings);
    }
}
