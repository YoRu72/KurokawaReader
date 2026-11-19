// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): which reader may look at a HID collection.
// Derived from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor), src/devices.cpp
// (PollAllDevices' order and its ignore list), src/drivers/drivers.h (PollContext's claims) and src/drivers/generic.cpp
// (the collections PollGenericHid leaves alone) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its
// contributors, GPL-3.0-or-later.
// Changed here: a vendor driver claims a device by a full DeviceMatch — vendor AND product, with usage page / usage /
// interface where its protocol needs them — never by vendor alone (the original's Products(vid) let a driver probe
// every product of a vendor id, other makers' among them); an unknown device reaches only the generic readers, and only
// when it declares a battery field; the user's «do not query this device» is by our stable key (the original's registry
// list was by vendor:product, so it silenced every identical unit).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::allow::{DeviceMatch, HidIdent};

/// A vendor driver's claim (mice, keyboards, headsets in later pieces; each with a DeviceMatch per product). The
/// controllers' readers claim through pads::find (vendor, product, usage page and usages — never vendor alone).
pub struct DriverEntry {
    pub device: DeviceMatch,
    pub driver: &'static str,
}

pub static DRIVERS: &[DriverEntry] = &[];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Claim {
    /// A vendor driver's (its name).
    Driver(&'static str),
    /// The generic HID battery reader's.
    Generic,
    /// Left alone, and why.
    Skip(Skip),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Skip {
    /// The device has a digitizer collection (a tablet or pen display): never read — querying one for a battery report
    /// flipped a tablet's axis (the original's issue #232).
    Digitizer,
    /// A UPS or power supply (pages 0x84 / 0x85 as the collection's own usage): a computer's power, not a device's.
    PowerSupply,
    /// The user said not to query it.
    UserSaid,
    /// No battery field and no driver: nothing to read.
    NoBattery,
}

/// One collection as enumeration found it.
#[derive(Clone, Debug, PartialEq)]
pub struct Collection {
    pub ident: HidIdent,
    /// It declares a battery value field (hidvalue.rs is_battery_usage) in a feature or input report.
    pub battery_field: bool,
    /// Our stable key for the physical unit it belongs to (identity.rs).
    pub key: String,
}

fn driver_for_in<'a>(table: &'a [DriverEntry], id: &HidIdent) -> Option<&'a DriverEntry> {
    table.iter().find(|d| d.device.matches(id))
}

/// Which reader `c` goes to. `all` is every collection found in this round (a device's other collections decide too).
pub fn classify(all: &[Collection], c: &Collection, no_query: &[String]) -> Claim {
    classify_in(DRIVERS, all, c, no_query)
}

fn classify_in(table: &[DriverEntry], all: &[Collection], c: &Collection, no_query: &[String]) -> Claim {
    if no_query.iter().any(|k| k == &c.key) {
        return Claim::Skip(Skip::UserSaid);
    }
    let same_unit = |o: &&Collection| o.ident.vid == c.ident.vid && o.ident.pid == c.ident.pid && o.key == c.key;
    if all.iter().filter(same_unit).any(|o| o.ident.usage_page == 0x0D) || c.ident.usage_page == 0x0D {
        return Claim::Skip(Skip::Digitizer);
    }
    if c.ident.usage_page == 0x84 || c.ident.usage_page == 0x85 {
        return Claim::Skip(Skip::PowerSupply);
    }
    if let Some(d) = driver_for_in(table, &c.ident) {
        return Claim::Driver(d.driver);
    }
    if let Some(m) = crate::pads::find(&c.ident) {
        return Claim::Driver(m.driver);
    }
    if let Some(m) = crate::mice::find_any(&c.ident) {
        return Claim::Driver(m.driver);
    }
    if c.battery_field {
        Claim::Generic
    } else {
        Claim::Skip(Skip::NoBattery)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coll(vid: u16, pid: u16, page: u16, usage: u16, battery: bool, key: &str) -> Collection {
        Collection { ident: HidIdent { vid, pid, usage_page: page, usage, interface: -1 }, battery_field: battery, key: key.into() }
    }
    static TABLE: &[DriverEntry] = &[DriverEntry { device: DeviceMatch { vid: 0x1234, pid: 0x0001, usage_page: Some(0xFF00), usage: Some(1), interface: None }, driver: "test" }];

    #[test]
    fn controllers_are_claimed_by_their_readers_and_nothing_else_is() {
        let ds = coll(0x054C, 0x0CE6, 0x01, 0x05, false, "p");
        assert_eq!(classify(&[ds.clone()], &ds, &[]), Claim::Driver("playstation"));
        let ds_audio = coll(0x054C, 0x0CE6, 0x0C, 0x01, true, "p");
        assert_eq!(classify(&[ds.clone(), ds_audio.clone()], &ds_audio, &[]), Claim::Generic, "the pad's other collection: only the generic reader");
        let other_sony = coll(0x054C, 0x0268, 0x01, 0x05, false, "q");
        assert_eq!(classify(&[other_sony.clone()], &other_sony, &[]), Claim::Skip(Skip::NoBattery), "another Sony product: not claimed by vendor");
        let rx = coll(0x2DC8, 0x310B, 0xFF7A, 0x01, false, "r");
        assert_eq!(classify(&[rx.clone()], &rx, &[]), Claim::Driver("8bitdo-rx"));
        assert_eq!(classify(&[rx.clone()], &rx, &["r".into()]), Claim::Skip(Skip::UserSaid), "the user's word first");
        // (Piece 5: a mouse's vendor collection goes to its reader; another product of that vendor does not.)
        let lg = coll(0x046D, 0xC52B, 0xFF00, 0x0001, false, "l");
        assert_eq!(classify(&[lg.clone()], &lg, &[]), Claim::Driver("mk-logitech"));
        let lg_other = coll(0x046D, 0xC077, 0xFF00, 0x0001, true, "m");
        assert_eq!(classify(&[lg_other.clone()], &lg_other, &[]), Claim::Generic, "an unlisted Logitech product: never claimed by vendor");
    }

    #[test]
    fn no_vendor_driver_ships_in_piece_1() {
        assert!(DRIVERS.is_empty());
        // (C547 is a Lightspeed receiver mice/logitech.rs lists since piece 5: an id no table lists here.)
        let c = coll(0x046D, 0xC5FF, 0xFF00, 1, false, "k");
        assert_eq!(classify(&[c.clone()], &c, &[]), Claim::Skip(Skip::NoBattery), "an unknown receiver without a battery field is left alone");
        let g = coll(0x046D, 0xC5FF, 0x01, 0x02, true, "k");
        assert_eq!(classify(&[g.clone()], &g, &[]), Claim::Generic);
    }

    #[test]
    fn drivers_claim_by_full_match_never_vendor_alone() {
        let mine = coll(0x1234, 0x0001, 0xFF00, 1, false, "a");
        let other_product = coll(0x1234, 0x0002, 0xFF00, 1, false, "b");
        let other_usage = coll(0x1234, 0x0001, 0xFF00, 2, true, "a");
        let all = [mine.clone(), other_product.clone(), other_usage.clone()];
        assert_eq!(classify_in(TABLE, &all, &mine, &[]), Claim::Driver("test"));
        assert_eq!(classify_in(TABLE, &all, &other_product, &[]), Claim::Skip(Skip::NoBattery), "same vendor, another product: not the driver's");
        assert_eq!(classify_in(TABLE, &all, &other_usage, &[]), Claim::Generic, "the driver's product, another collection: only the generic reader");
    }

    #[test]
    fn digitizers_power_supplies_and_the_users_word() {
        let pen = coll(0x28BD, 0x0947, 0x0D, 0x02, false, "t");
        let tablet_batt = coll(0x28BD, 0x0947, 0x06, 0x20, true, "t");
        let all = [pen.clone(), tablet_batt.clone()];
        assert_eq!(classify(&all, &tablet_batt, &[]), Claim::Skip(Skip::Digitizer), "any collection of a tablet: never read");
        // (Two units of the same product: the one without a digitizer is read.)
        let twin = coll(0x28BD, 0x0947, 0x06, 0x20, true, "u");
        assert_eq!(classify(&[pen, twin.clone()], &twin, &[]), Claim::Generic);
        let ups = coll(0x051D, 0x0002, 0x84, 0x04, true, "p");
        assert_eq!(classify(&[ups.clone()], &ups, &[]), Claim::Skip(Skip::PowerSupply));
        let m = coll(0x1111, 0x2222, 0x01, 0x02, true, "m1");
        assert_eq!(classify(&[m.clone()], &m, &["m1".into()]), Claim::Skip(Skip::UserSaid));
        assert_eq!(classify(&[m.clone()], &m, &["m2".into()]), Claim::Generic, "another unit of the same product is still read");
    }
}
