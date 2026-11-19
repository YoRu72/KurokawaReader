// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): mice' and keyboards' own readers (piece 5).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/logitech.cpp, razer.cpp, steelseries.cpp, corsair.cpp, glorious.cpp, pulsar.cpp, lamzu.cpp,
// finalmouse.cpp, endgame.cpp, endgame_we.cpp, vaxee.cpp, zowie.cpp, wlmouse.cpp, ninjutso.cpp, darmoshark.cpp,
// atk_bitmouse.cpp, atk_keyboard.cpp, kysona.cpp, fantech.cpp, dareu.cpp, rapoo.cpp (+ rapoo_protocol.h), keychron.cpp,
// royal_kludge.cpp, sonix.cpp, semico.cpp, areson.cpp, aula.cpp, cherry.cpp, coolermaster.cpp, machenike.cpp,
// mchose.cpp, mchose_g3.cpp, mchose_modern.cpp, msi.cpp, rog.cpp, nzxt.cpp, niceboy.cpp, sprime.cpp, arbiter.cpp,
// misc_mice.cpp (+ xenta_protocol.cpp/.h, ardor_fury_v2_protocol.h) at commit 285d64254216857e94ca3ea3e1deb536f863e282,
// by krisgfx9 and its contributors, GPL-3.0-or-later. One file per family here; this one holds what they share.
// Changed here (the original's faults, PLAN-battery §9):
// - Matched by vendor AND product (and the collection's page, usage, interface and report lengths where the family
//   has them) — never by vendor alone: the original asked every product of 1532, 1038, 1B1C, 046D, 258A, 3554, 373B,
//   3770, 33E4, 3710, 35BB, 373E, 37B0, 3434, 24AE, 249A, 248A, 3151, 0B05 and others it did not know. Products the
//   original only reached that way are not asked; where its sources named them they are listed by id.
// - Every byte sent is one allow.rs lists for that product (exact, a bounded template, or HID++ with the device's own
//   feature index): only status reads. What the original sent that changes a device is not sent: Finalmouse's
//   «wake/all» (96) and its lift-off / profile-roster reads that precede it, Endgame Gear 4K's 0F probe (it keeps the
//   mouse from sleeping), AJAZZ AJ-series' F7 «brings the link up», the Rongyuan receivers' undocumented F7 (sent by
//   the original to about eighty receiver ids of fifteen vendors — rongyuan.cpp is not ported: the same opcode is
//   documented for AJAZZ's receivers as the poll that brings the radio link up, a wake, and its receiver list is a third
//   party's), Wraith W1's per-button read sweep and keep-alive,
//   AULA HERO 68 Air's acknowledged message session. Those devices are read when something else made them speak, or say
//   «needs a query we do not send».
// - Passive readers (Rapoo, the Xenta receivers, AULA HERO 68 Air) are on by default; every reader that sends a
//   request is off until the user turns its family on (all «ported, untested»). A family switched off is given no
//   device at all.
// - Levels as the device gives them: a percentage only when it sends one (or a finer scale: Razer's 0–255, Corsair's
//   0–1000, both rounded to whole per cent); steps otherwise (SteelSeries Aerox 0–20, VAXEE 0–20, Redragon 0–10,
//   ARDOR 1–4, Logitech HID++ 1.0's 1–7), words for HID++'s level flags; a battery voltage alone (HID++'s BATTERY_VOLTAGE,
//   ZOWIE's DW receivers, Niceboy, Finalmouse without its percentage, Corsair Compx) becomes a coarse word, never a
//   made-up percentage. Malformed, short or out-of-range replies are no reading.
// - Every call under the caller's deadline; a reply taken only when it answers the request just sent (the queue
//   dropped first, the reply's command echoed, its checksum checked where the protocol has one); no value kept across
//   rounds in a global (the original's g_trend, lastName, lastGood, g_rapoo, g_xenta, s_deluxSeq…): ZOWIE's charging
//   guessed from the voltage's trend is gone (it said «charging» from a rise of 50 mV).
// - A receiver with several devices: one card each (Logitech's slots 1–6, Corsair's paired targets 09–0B; win/mice.rs
//   keeps the slots a receiver's reader found while it stays plugged in). A mouse on its cable with its receiver also plugged in: one card, by an explicit rule
//   only (Model::pair — the same product pair, one of each present — or the same HID++ unit id).
// Copyright (C) 2026 Kurokawa contributors. Std only.
pub mod allowed;
pub mod proto;

pub mod areson;
pub mod atk;
pub mod aula;
pub mod cherry;
pub mod coolermaster;
pub mod corsair;
pub mod dareu;
pub mod darmoshark;
pub mod endgame;
pub mod fantech;
pub mod finalmouse;
pub mod glorious;
pub mod keychron;
pub mod kysona;
pub mod lamzu;
pub mod logitech;
pub mod machenike;
pub mod mchose;
pub mod misc;
pub mod msi;
pub mod ninjutso;
pub mod niceboy;
pub mod nzxt;
pub mod pulsar;
pub mod rapoo;
pub mod razer;
pub mod rog;
pub mod royal_kludge;
pub mod semico;
pub mod sonix;
pub mod steelseries;
pub mod vaxee;
pub mod wlmouse;
pub mod zowie;

use crate::allow::{self, HidIdent, ReportKind};
use crate::model::{Charging, Coarse, Kind, Level, Note, Percent, Reading, Steps};
use crate::sched::Outcome;
use crate::transport::{HidTransport, TErr};
use std::time::{Duration, Instant};

/// A mouse or keyboard family: the brand as text (never a logo), the page's per-family switch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Family {
    Logitech,
    Razer,
    SteelSeries,
    Corsair,
    Glorious,
    Hitscan,
    GWolves,
    Wlmouse,
    Lamzu,
    Arbiter,
    Pulsar,
    Finalmouse,
    Endgame,
    Vaxee,
    Zowie,
    Ninjutso,
    Sprime,
    Darmoshark,
    Atk,
    Kysona,
    Fantech,
    Dareu,
    Redragon,
    Rapoo,
    Keychron,
    RoyalKludge,
    Sonix,
    Semico,
    Aula,
    Mchose,
    Cherry,
    CoolerMaster,
    Machenike,
    Msi,
    Rog,
    Nzxt,
    Niceboy,
    Motospeed,
    Xenta,
    Delux,
    Ajazz,
    Incott,
}

impl Family {
    pub const ALL: [Family; 42] = [
        Family::Logitech,
        Family::Razer,
        Family::SteelSeries,
        Family::Corsair,
        Family::Glorious,
        Family::Hitscan,
        Family::GWolves,
        Family::Wlmouse,
        Family::Lamzu,
        Family::Arbiter,
        Family::Pulsar,
        Family::Finalmouse,
        Family::Endgame,
        Family::Vaxee,
        Family::Zowie,
        Family::Ninjutso,
        Family::Sprime,
        Family::Darmoshark,
        Family::Atk,
        Family::Kysona,
        Family::Fantech,
        Family::Dareu,
        Family::Redragon,
        Family::Rapoo,
        Family::Keychron,
        Family::RoyalKludge,
        Family::Sonix,
        Family::Semico,
        Family::Aula,
        Family::Mchose,
        Family::Cherry,
        Family::CoolerMaster,
        Family::Machenike,
        Family::Msi,
        Family::Rog,
        Family::Nzxt,
        Family::Niceboy,
        Family::Motospeed,
        Family::Xenta,
        Family::Delux,
        Family::Ajazz,
        Family::Incott,
    ];
    /// The setting's id (prefixed: never one of the controllers' ids).
    pub fn as_str(self) -> &'static str {
        match self {
            Family::Logitech => "mk-logitech",
            Family::Razer => "mk-razer",
            Family::SteelSeries => "mk-steelseries",
            Family::Corsair => "mk-corsair",
            Family::Glorious => "mk-glorious",
            Family::Hitscan => "mk-hitscan",
            Family::GWolves => "mk-gwolves",
            Family::Wlmouse => "mk-wlmouse",
            Family::Lamzu => "mk-lamzu",
            Family::Arbiter => "mk-arbiter",
            Family::Pulsar => "mk-pulsar",
            Family::Finalmouse => "mk-finalmouse",
            Family::Endgame => "mk-endgame",
            Family::Vaxee => "mk-vaxee",
            Family::Zowie => "mk-zowie",
            Family::Ninjutso => "mk-ninjutso",
            Family::Sprime => "mk-sprime",
            Family::Darmoshark => "mk-darmoshark",
            Family::Atk => "mk-atk",
            Family::Kysona => "mk-kysona",
            Family::Fantech => "mk-fantech",
            Family::Dareu => "mk-dareu",
            Family::Redragon => "mk-redragon",
            Family::Rapoo => "mk-rapoo",
            Family::Keychron => "mk-keychron",
            Family::RoyalKludge => "mk-rk",
            Family::Sonix => "mk-sonix",
            Family::Semico => "mk-semico",
            Family::Aula => "mk-aula",
            Family::Mchose => "mk-mchose",
            Family::Cherry => "mk-cherry",
            Family::CoolerMaster => "mk-coolermaster",
            Family::Machenike => "mk-machenike",
            Family::Msi => "mk-msi",
            Family::Rog => "mk-rog",
            Family::Nzxt => "mk-nzxt",
            Family::Niceboy => "mk-niceboy",
            Family::Motospeed => "mk-motospeed",
            Family::Xenta => "mk-xenta",
            Family::Delux => "mk-delux",
            Family::Ajazz => "mk-ajazz",
            Family::Incott => "mk-incott",
        }
    }
    pub fn parse(s: &str) -> Option<Family> {
        Family::ALL.iter().copied().find(|f| f.as_str() == s)
    }
    /// The brand, as plain text.
    pub fn brand(self) -> &'static str {
        match self {
            Family::Logitech => "Logitech",
            Family::Razer => "Razer",
            Family::SteelSeries => "SteelSeries",
            Family::Corsair => "Corsair",
            Family::Glorious => "Glorious",
            Family::Hitscan => "Hitscan",
            Family::GWolves => "G-Wolves",
            Family::Wlmouse => "WLMouse",
            Family::Lamzu => "LAMZU",
            Family::Arbiter => "Arbiter Studio",
            Family::Pulsar => "Pulsar",
            Family::Finalmouse => "Finalmouse",
            Family::Endgame => "Endgame Gear",
            Family::Vaxee => "VAXEE",
            Family::Zowie => "ZOWIE",
            Family::Ninjutso => "Ninjutso",
            Family::Sprime => "Sprime",
            Family::Darmoshark => "Darmoshark",
            Family::Atk => "ATK / VXE",
            Family::Kysona => "Kysona",
            Family::Fantech => "Fantech",
            Family::Dareu => "DAREU",
            Family::Redragon => "Redragon",
            Family::Rapoo => "Rapoo",
            Family::Keychron => "Keychron",
            Family::RoyalKludge => "Royal Kludge",
            Family::Sonix => "SONiX",
            Family::Semico => "Semico",
            Family::Aula => "AULA",
            Family::Mchose => "MCHOSE",
            Family::Cherry => "CHERRY",
            Family::CoolerMaster => "Cooler Master",
            Family::Machenike => "Machenike",
            Family::Msi => "MSI",
            Family::Rog => "ASUS ROG",
            Family::Nzxt => "NZXT",
            Family::Niceboy => "Niceboy",
            Family::Motospeed => "Motospeed",
            Family::Xenta => "Xenta",
            Family::Delux => "Delux",
            Family::Ajazz => "AJAZZ",
            Family::Incott => "Incott / Wraith",
        }
    }
}

pub use crate::pads::{Proven, Way};

/// One reader: its id (Device::driver), family, proof, way, the original file it was ported from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Driver {
    pub id: &'static str,
    pub family: Family,
    pub proven: Proven,
    pub way: Way,
    pub from: &'static str,
}

impl Driver {
    /// On unless the user changes it: a passive reader is on; one that sends a request only when tested (none is).
    pub fn on_by_default(&self) -> bool {
        self.way == Way::Passive || self.proven == Proven::Tested
    }
}

const fn d(id: &'static str, family: Family, way: Way, from: &'static str) -> Driver {
    Driver { id, family, proven: Proven::PortedUntested, way, from }
}

pub static DRIVERS: &[Driver] = &[
    d("mk-logitech", Family::Logitech, Way::Query, "src/drivers/logitech.cpp"),
    d("mk-razer", Family::Razer, Way::Query, "src/drivers/razer.cpp"),
    d("mk-steelseries", Family::SteelSeries, Way::Query, "src/drivers/steelseries.cpp (mice)"),
    d("mk-corsair-bragi", Family::Corsair, Way::Query, "src/drivers/corsair.cpp (Bragi)"),
    d("mk-corsair-compx", Family::Corsair, Way::Query, "src/drivers/corsair.cpp (Compx)"),
    d("mk-p83", Family::Glorious, Way::Query, "src/drivers/glorious.cpp"),
    d("mk-hitscan", Family::Hitscan, Way::Query, "src/drivers/glorious.cpp (Hitscan)"),
    d("mk-gwolves", Family::GWolves, Way::Query, "src/drivers/glorious.cpp (G-Wolves)"),
    d("mk-wlmouse", Family::Wlmouse, Way::Query, "src/drivers/wlmouse.cpp, glorious.cpp (YING)"),
    d("mk-lamzu", Family::Lamzu, Way::Query, "src/drivers/lamzu.cpp"),
    d("mk-arbiter", Family::Arbiter, Way::Query, "src/drivers/arbiter.cpp"),
    d("mk-pulsar", Family::Pulsar, Way::Query, "src/drivers/pulsar.cpp"),
    d("mk-finalmouse", Family::Finalmouse, Way::Query, "src/drivers/finalmouse.cpp"),
    d("mk-endgame-4k", Family::Endgame, Way::Query, "src/drivers/endgame.cpp"),
    d("mk-endgame-we", Family::Endgame, Way::Query, "src/drivers/endgame_we.cpp"),
    d("mk-vaxee", Family::Vaxee, Way::Query, "src/drivers/vaxee.cpp"),
    d("mk-zowie-cw", Family::Zowie, Way::Query, "src/drivers/zowie.cpp (EC-CW)"),
    d("mk-zowie-dw", Family::Zowie, Way::Query, "src/drivers/zowie.cpp (DW, U2)"),
    d("mk-ninjutso-sora", Family::Ninjutso, Way::Query, "src/drivers/ninjutso.cpp (Sora V2)"),
    d("mk-ninjutso-ten", Family::Ninjutso, Way::Query, "src/drivers/ninjutso.cpp (Ten)"),
    d("mk-sprime", Family::Sprime, Way::Query, "src/drivers/sprime.cpp"),
    d("mk-darmoshark", Family::Darmoshark, Way::Query, "src/drivers/darmoshark.cpp"),
    d("mk-atk-nk", Family::Atk, Way::Query, "src/drivers/atk_bitmouse.cpp"),
    d("mk-atk-kb", Family::Atk, Way::Query, "src/drivers/atk_keyboard.cpp"),
    d("mk-kysona", Family::Kysona, Way::Query, "src/drivers/kysona.cpp"),
    d("mk-gwolves-k", Family::GWolves, Way::Query, "src/drivers/kysona.cpp (G-Wolves on the Compx protocol)"),
    d("mk-redragon-k", Family::Redragon, Way::Query, "src/drivers/kysona.cpp (Redragon Compx ids)"),
    d("mk-atk-k", Family::Atk, Way::Query, "src/drivers/kysona.cpp (VXE Dragonfly R1)"),
    d("mk-hitscan-k", Family::Hitscan, Way::Query, "src/drivers/kysona.cpp (Hitscan Hyperlight)"),
    d("mk-pulsar-k", Family::Pulsar, Way::Query, "src/drivers/kysona.cpp (Pulsar XS-1 8K dongle)"),
    d("mk-fantech", Family::Fantech, Way::Query, "src/drivers/fantech.cpp"),
    d("mk-dareu", Family::Dareu, Way::Query, "src/drivers/dareu.cpp"),
    d("mk-areson", Family::Redragon, Way::Query, "src/drivers/areson.cpp"),
    d("mk-rapoo", Family::Rapoo, Way::Passive, "src/drivers/rapoo.cpp, rapoo_protocol.h"),
    d("mk-keychron", Family::Keychron, Way::Query, "src/drivers/keychron.cpp"),
    d("mk-rk", Family::RoyalKludge, Way::Query, "src/drivers/royal_kludge.cpp"),
    d("mk-sonix", Family::Sonix, Way::Query, "src/drivers/sonix.cpp"),
    d("mk-semico", Family::Semico, Way::Query, "src/drivers/semico.cpp"),
    d("mk-aula-by", Family::Aula, Way::Query, "src/drivers/aula.cpp (BY receivers)"),
    d("mk-aula-hero", Family::Aula, Way::Passive, "src/drivers/aula.cpp (HERO 68 Air)"),
    d("mk-mchose", Family::Mchose, Way::Query, "src/drivers/mchose.cpp, mchose_g3.cpp, mchose_modern.cpp"),
    d("mk-cherry", Family::Cherry, Way::Query, "src/drivers/cherry.cpp"),
    d("mk-coolermaster", Family::CoolerMaster, Way::Query, "src/drivers/coolermaster.cpp"),
    d("mk-machenike", Family::Machenike, Way::Query, "src/drivers/machenike.cpp"),
    d("mk-msi", Family::Msi, Way::Query, "src/drivers/msi.cpp"),
    d("mk-rog", Family::Rog, Way::Query, "src/drivers/rog.cpp (keyboards, mice)"),
    d("mk-nzxt", Family::Nzxt, Way::Query, "src/drivers/nzxt.cpp"),
    d("mk-niceboy", Family::Niceboy, Way::Query, "src/drivers/niceboy.cpp"),
    d("mk-motospeed", Family::Motospeed, Way::Query, "src/drivers/misc_mice.cpp (Motospeed X6)"),
    d("mk-xenta", Family::Xenta, Way::Passive, "src/drivers/misc_mice.cpp (Xenta), xenta_protocol.cpp, ardor_fury_v2_protocol.h"),
    d("mk-delux", Family::Delux, Way::Query, "src/drivers/misc_mice.cpp (Delux M800 Pro)"),
    d("mk-ajazz", Family::Ajazz, Way::Query, "src/drivers/misc_mice.cpp (AJ139 V2)"),
    d("mk-incott", Family::Incott, Way::Query, "src/drivers/misc_mice.cpp (Incott, Wraith W1)"),
];

pub fn driver(id: &str) -> Option<&'static Driver> {
    DRIVERS.iter().find(|d| d.id == id)
}

/// The families whose reading sends a request (their switch is off until turned on), each once, in table order.
pub fn query_families() -> Vec<Family> {
    let mut out: Vec<Family> = Vec::new();
    for d in DRIVERS.iter().filter(|d| d.way == Way::Query) {
        if !out.contains(&d.family) {
            out.push(d.family);
        }
    }
    out
}

/// The families with a reader that only listens (their switch is on until turned off).
pub fn listen_families() -> Vec<Family> {
    let mut out: Vec<Family> = Vec::new();
    for d in DRIVERS.iter().filter(|d| d.way == Way::Passive) {
        if !out.contains(&d.family) {
            out.push(d.family);
        }
    }
    out
}

/// Which collection page a model takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Is(u16),
    /// Any vendor-defined page (FF00–FFFF), as ROG's tables have it.
    Vendor,
    /// The family's sources do not name the page: the product and the report lengths identify the collection.
    Any,
}

/// A report length a model needs (Windows' count, the report id included).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Len {
    Any,
    Min(u16),
    Eq(u16),
}

impl Len {
    fn takes(self, n: usize) -> bool {
        match self {
            Len::Any => true,
            Len::Min(m) => n >= usize::from(m),
            Len::Eq(m) => n == usize::from(m),
        }
    }
}

/// What a collection is to its reader.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// The one the requests go to (and the replies come on, unless a Reply collection is listed).
    Main,
    /// Where the replies come (a sibling collection of the same interface).
    Reply,
    /// HID++'s long-report collection.
    Long,
}

/// How the device reaches the computer through this product.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Via {
    Receiver,
    Cable,
    /// The device itself (by cable or Bluetooth: the path tells).
    Direct,
}

/// One collection of one product a reader knows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Model {
    pub driver: &'static str,
    pub vid: u16,
    pub pid: u16,
    pub page: Page,
    pub usage: Option<u16>,
    pub iface: Option<i32>,
    pub input: Len,
    pub output: Len,
    pub feature: Len,
    pub role: Role,
    pub name: &'static str,
    pub kind: Kind,
    pub via: Via,
    /// A receiver whose paired devices are each their own card: the slots its reader probes.
    pub slots: &'static [u8],
    /// A cable product and its receiver: the same mouse. One card when one of each is present (the explicit rule).
    pub pair: &'static str,
    /// A family's own parameter (ROG's report id and level offset, Finalmouse's report ids…).
    pub arg: u16,
    /// The name is generic («Razer mouse»): the device's own product string names the card when it gives one.
    pub product_name: bool,
    /// The product string the collection must give (trailing spaces aside, any case), "" for any: where a product id
    /// is shared with other devices (ATK V75X's Evision ids, Machenike's «L7 Mix»).
    pub product: &'static str,
    /// The length a feature report is sent with when the device wants its own report's length, not the collection's
    /// longest (Machenike: 21 of 1001); 0 = the collection's.
    pub feat_len: u16,
}

impl Model {
    pub const fn new(driver: &'static str, vid: u16, pid: u16, name: &'static str, kind: Kind, via: Via) -> Model {
        Model { driver, vid, pid, page: Page::Any, usage: None, iface: None, input: Len::Any, output: Len::Any, feature: Len::Any, role: Role::Main, name, kind, via, slots: &[], pair: "", arg: 0, product_name: false, product: "", feat_len: 0 }
    }
    pub const fn page(mut self, p: u16) -> Model {
        self.page = Page::Is(p);
        self
    }
    pub const fn vendor_page(mut self) -> Model {
        self.page = Page::Vendor;
        self
    }
    pub const fn usage(mut self, u: u16) -> Model {
        self.usage = Some(u);
        self
    }
    pub const fn iface(mut self, i: i32) -> Model {
        self.iface = Some(i);
        self
    }
    pub const fn input(mut self, l: Len) -> Model {
        self.input = l;
        self
    }
    pub const fn output(mut self, l: Len) -> Model {
        self.output = l;
        self
    }
    pub const fn feature(mut self, l: Len) -> Model {
        self.feature = l;
        self
    }
    pub const fn role(mut self, r: Role) -> Model {
        self.role = r;
        self
    }
    pub const fn slots(mut self, s: &'static [u8]) -> Model {
        self.slots = s;
        self
    }
    pub const fn pair(mut self, p: &'static str) -> Model {
        self.pair = p;
        self
    }
    pub const fn arg(mut self, a: u16) -> Model {
        self.arg = a;
        self
    }
    pub const fn product_is(mut self, p: &'static str) -> Model {
        self.product = p;
        self
    }
    pub const fn feat_len(mut self, n: u16) -> Model {
        self.feat_len = n;
        self
    }
    /// The collection's product string is the one the model needs.
    pub fn product_ok(&self, product: &str) -> bool {
        self.product.is_empty() || product.trim_end().eq_ignore_ascii_case(self.product)
    }
    pub const fn product_name(mut self) -> Model {
        self.product_name = true;
        self
    }
    pub const fn kind_of(mut self, k: Kind) -> Model {
        self.kind = k;
        self
    }
    pub const fn via_of(mut self, v: Via) -> Model {
        self.via = v;
        self
    }
    pub const fn named(mut self, n: &'static str) -> Model {
        self.name = n;
        self
    }
    pub const fn with_pid(mut self, pid: u16) -> Model {
        self.pid = pid;
        self
    }
    pub fn matches(&self, id: &HidIdent, input: usize, output: usize, feature: usize) -> bool {
        let page = match self.page {
            Page::Is(p) => p == id.usage_page,
            Page::Vendor => id.usage_page >= 0xFF00,
            Page::Any => true,
        };
        self.vid == id.vid
            && self.pid == id.pid
            && page
            && self.usage.map_or(true, |u| u == id.usage)
            && self.iface.map_or(true, |i| i == id.interface)
            && self.input.takes(input)
            && self.output.takes(output)
            && self.feature.takes(feature)
    }
    pub fn driver(&self) -> &'static Driver {
        driver(self.driver).expect("every model names a driver of the table")
    }
}

/// The same model for several products (a family's long id list), at compile time.
pub const fn many<const N: usize>(base: Model, pids: [u16; N]) -> [Model; N] {
    let mut out = [base; N];
    let mut i = 0;
    while i < N {
        out[i] = base.with_pid(pids[i]);
        i += 1;
    }
    out
}

/// Every family's table (statics: no copy, no allocation).
pub static TABLES: &[&[Model]] = &[
    &logitech::RX_SHORT,
    &logitech::RX_LONG,
    &logitech::PASS,
    &logitech::USB_SHORT,
    &logitech::USB_LONG,
    &logitech::BLE,
    razer::MODELS,
    &razer::MICE,
    &razer::KEYBOARDS,
    steelseries::MODELS,
    corsair::MODELS,
    glorious::MODELS,
    &glorious::GWOLVES,
    wlmouse::MODELS,
    lamzu::MODELS,
    &lamzu::LAMZU,
    pulsar::MODELS,
    finalmouse::MODELS,
    endgame::MODELS,
    vaxee::MODELS,
    zowie::MODELS,
    ninjutso::MODELS,
    darmoshark::MODELS,
    atk::MODELS,
    kysona::MODELS,
    &kysona::GWOLVES_K,
    fantech::MODELS,
    dareu::MODELS,
    areson::MODELS,
    rapoo::MODELS,
    keychron::MODELS,
    royal_kludge::MODELS,
    sonix::MODELS,
    semico::MODELS,
    aula::MODELS,
    mchose::MODELS,
    cherry::MODELS,
    coolermaster::MODELS,
    machenike::MODELS,
    msi::MODELS,
    rog::MODELS,
    nzxt::MODELS,
    niceboy::MODELS,
    misc::MODELS,
];

pub fn all_models() -> impl Iterator<Item = &'static Model> {
    TABLES.iter().flat_map(|t| t.iter())
}

/// The reader for one collection, by its identity and report lengths.
pub fn find(id: &HidIdent, input: usize, output: usize, feature: usize) -> Option<&'static Model> {
    all_models().find(|m| m.matches(id, input, output, feature))
}

/// Whether `id` is a collection the tables give reader `driver` as the one its requests go to (allow.rs's
/// `Products::driver`): vendor, product, and the row's page, usage and interface — the report lengths are the
/// platform's check before it opens anything.
pub fn claims(driver: &str, id: &HidIdent) -> bool {
    all_models().any(|m| {
        m.driver == driver
            && m.role == Role::Main
            && m.vid == id.vid
            && m.pid == id.pid
            && match m.page {
                Page::Is(p) => p == id.usage_page,
                Page::Vendor => id.usage_page >= 0xFF00,
                Page::Any => true,
            }
            && m.usage.map_or(true, |u| u == id.usage)
            && m.iface.map_or(true, |i| i == id.interface)
    })
}

/// The reader whose table lists this collection (any role), by vendor, product, page, usage and interface — the
/// registry's word that the generic reader leaves it alone.
pub fn find_any(id: &HidIdent) -> Option<&'static Model> {
    all_models().find(|m| {
        m.vid == id.vid
            && m.pid == id.pid
            && match m.page {
                Page::Is(p) => p == id.usage_page,
                Page::Vendor => id.usage_page >= 0xFF00,
                Page::Any => true,
            }
            && m.usage.map_or(true, |u| u == id.usage)
            && m.iface.map_or(true, |i| i == id.interface)
    })
}

/// Whether a reader's requests include output reports (its request collection is then opened read/write); a reader
/// that sends only feature reports gets a handle with no read or write access (Windows keeps a mouse's and a
/// keyboard's own collections; feature reports go through the control pipe).
pub fn sends_output(driver: &str) -> bool {
    driver == "mk-logitech"
        || allowed::SETS.iter().any(|e| e.kind == ReportKind::Output && e.devices.driver == Some(driver))
        || allowed::TEMPLATES.iter().any(|t| t.kind == ReportKind::Output && t.devices.driver == Some(driver))
        // (Finalmouse's entries list its receivers by id: each its own report id.)
        || driver == "mk-finalmouse"
}

/// Whether the user's switches let this reader work: a reader that sends, when its family was turned on (`ask`); a
/// reader that only listens, unless its family was turned off (`mute`).
pub fn is_on(m: &Model, ask: &[Family], mute: &[Family]) -> bool {
    let d = m.driver();
    match d.way {
        Way::Query => ask.contains(&d.family),
        Way::Passive => !mute.contains(&d.family),
    }
}

/// The explicit rule for «one mouse, two ways in»: units (each by its first model) whose models name the same pair, one
/// by cable and one by receiver — exactly one of each present — are one card (the cable first: it is the device itself).
/// Every other unit is its own. Returns groups of indices into `units`.
pub fn merge_pairs(units: &[&Model]) -> Vec<Vec<usize>> {
    let mut out: Vec<Vec<usize>> = Vec::new();
    let mut used = vec![false; units.len()];
    for i in 0..units.len() {
        if used[i] {
            continue;
        }
        used[i] = true;
        let p = units[i].pair;
        if p.is_empty() {
            out.push(vec![i]);
            continue;
        }
        let same: Vec<usize> = (0..units.len()).filter(|&j| units[j].pair == p).collect();
        let cables: Vec<usize> = same.iter().copied().filter(|&j| units[j].via == Via::Cable).collect();
        let rx: Vec<usize> = same.iter().copied().filter(|&j| units[j].via == Via::Receiver).collect();
        if same.len() == 2 && cables.len() == 1 && rx.len() == 1 {
            for &j in &same {
                used[j] = true;
            }
            out.push(vec![cables[0], rx[0]]);
        } else {
            out.push(vec![i]);
        }
    }
    out
}

/// A paired device's own card key: the receiver's key and its slot.
pub fn slot_key(base: &str, slot: u8) -> String {
    format!("{}:slot:{}", base, slot)
}

/// The products a family's request-sending readers are for (the page names them under its switch).
pub fn query_models(f: Family) -> Vec<&'static Model> {
    all_models().filter(|m| m.driver().family == f && m.driver().way == Way::Query && m.role == Role::Main).collect()
}

/// The pair name of a product ("" when none).
pub fn pair_of(vid: u16, pid: u16) -> &'static str {
    all_models().find(|m| m.vid == vid && m.pid == pid && !m.pair.is_empty()).map_or("", |m| m.pair)
}

/// The collections a reader is given for one unit: where its requests go, and where replies come when elsewhere.
pub struct Chans<'a> {
    pub main: &'a mut dyn HidTransport,
    pub reply: Option<&'a mut dyn HidTransport>,
    pub long: Option<&'a mut dyn HidTransport>,
}

impl<'a> Chans<'a> {
    pub fn one(main: &'a mut dyn HidTransport) -> Chans<'a> {
        Chans { main, reply: None, long: None }
    }
    /// Where the replies come.
    pub fn rx(&mut self) -> &mut dyn HidTransport {
        match self.reply.as_deref_mut() {
            Some(r) => r,
            None => &mut *self.main,
        }
    }
}

/// What a reader found: the outcome, and what it learned of the device (its name, kind, unit id, a receiver's slots).
#[derive(Clone, Debug, PartialEq)]
pub struct Answer {
    pub out: Outcome,
    /// A receiver's paired devices (each to be its own card), when the reader probed them.
    pub slots: Option<Vec<u8>>,
    pub name: Option<String>,
    pub kind: Option<Kind>,
    /// An id of the physical device (HID++'s unit id): the same id through the receiver and the cable is one card.
    pub unit: Option<String>,
}

impl From<Outcome> for Answer {
    fn from(out: Outcome) -> Answer {
        Answer { out, slots: None, name: None, kind: None, unit: None }
    }
}

// ---- outcomes ----

pub fn got(level: Level, charging: Charging, now: u64) -> Outcome {
    Outcome::Read(Reading::new(level, charging, now))
}
/// The receiver answered, the device behind it sleeps or is off (asked again next round, unlike Outcome::Asleep).
pub fn dozing(now: u64) -> Outcome {
    Outcome::Read(Reading::asleep(now))
}
pub fn unlinked(now: u64) -> Outcome {
    Outcome::Read(Reading::unknown(Note::Unlinked, Charging::Unknown, now))
}
pub fn needs_query(now: u64) -> Outcome {
    Outcome::Read(Reading::unknown(Note::NeedsQuery, Charging::Unknown, now))
}
pub fn no_level(charging: Charging, now: u64) -> Outcome {
    Outcome::Read(Reading::unknown(Note::None, charging, now))
}
pub fn failed(e: &TErr) -> Outcome {
    if *e == TErr::Gone {
        Outcome::Failed
    } else {
        Outcome::NoAnswer
    }
}

/// A percentage the device sent, 0–100; anything else is no level.
pub fn pct(v: i64) -> Option<Level> {
    Percent::new(v).map(Level::Exact)
}
/// A level on a finer scale than per cent (Razer 0–255, Corsair 0–1000): rounded to whole per cent.
pub fn scaled(v: i64, max: i64) -> Option<Level> {
    if max <= 0 || !(0..=max).contains(&v) {
        return None;
    }
    pct((v * 100 + max / 2) / max)
}
/// n of max steps.
pub fn steps(n: i64, max: i64) -> Option<Level> {
    Steps::new(n, max).map(Level::Steps)
}
pub fn charging(b: bool) -> Charging {
    if b {
        Charging::Yes
    } else {
        Charging::No
    }
}
/// A one-cell lithium battery's voltage as a coarse word (never a percentage: the curve is the cell's, not the
/// device's). Outside 3.0–4.5 V: no level.
pub fn from_millivolts(mv: u32) -> Level {
    match mv {
        3000..=3599 => Level::Coarse(Coarse::Empty),
        3600..=3699 => Level::Coarse(Coarse::Low),
        3700..=3849 => Level::Coarse(Coarse::Medium),
        3850..=4049 => Level::Coarse(Coarse::High),
        4050..=4500 => Level::Coarse(Coarse::Full),
        _ => Level::Unknown,
    }
}

// ---- talking to a device ----

/// A wait or step of `n` ms (a tenth of it in tests, where the fakes answer at once or never).
pub const fn ms(n: u64) -> Duration {
    if cfg!(test) {
        Duration::from_millis(n / 10 + 1)
    } else {
        Duration::from_millis(n)
    }
}

/// A pause between a request and reading its reply (the device's own time), never past `deadline`. In tests: none.
pub fn pause(d: Duration, deadline: Instant) {
    if cfg!(test) {
        return;
    }
    let now = Instant::now();
    if now < deadline {
        std::thread::sleep(d.min(deadline - now));
    }
}

/// A report as the original numbers it: a 0 report id (a collection that does not number its reports) dropped.
pub fn payload(r: &[u8]) -> &[u8] {
    crate::pads::payload(r)
}

/// Sends `bytes` (allow.rs's, for this very collection, else Refused and nothing sent).
pub fn send(t: &mut dyn HidTransport, kind: ReportKind, bytes: &[u8], deadline: Instant) -> Result<(), TErr> {
    let w = allow::permit(t.ident(), kind, bytes).ok_or(TErr::Refused)?;
    t.send(&w, deadline)
}

/// Reads input reports on `t` (the 0 report id dropped) until `f` takes one, for `step` and never past `deadline`.
pub fn read_until<R>(t: &mut dyn HidTransport, step: Duration, deadline: Instant, f: &mut dyn FnMut(&[u8]) -> Option<R>) -> Result<R, TErr> {
    let end = deadline.min(Instant::now() + step);
    loop {
        let r = t.read_input(end)?;
        if let Some(v) = f(payload(&r)) {
            return Ok(v);
        }
    }
}

/// An output request on the main collection and its reply on the reply collection (or the same one): the reply
/// collection's queue dropped first, so what is read answers this request.
pub fn out_ask<R>(ch: &mut Chans, bytes: &[u8], step: Duration, deadline: Instant, f: &mut dyn FnMut(&[u8]) -> Option<R>) -> Result<R, TErr> {
    let w = allow::permit(ch.main.ident(), ReportKind::Output, bytes).ok_or(TErr::Refused)?;
    let end = deadline.min(Instant::now() + step);
    ch.rx().flush();
    ch.main.send(&w, end)?;
    read_until(ch.rx(), step, end, f)
}

/// A feature request on the main collection, its reply on the reply collection's input reports.
pub fn feat_then_read<R>(ch: &mut Chans, bytes: &[u8], step: Duration, deadline: Instant, f: &mut dyn FnMut(&[u8]) -> Option<R>) -> Result<R, TErr> {
    let w = allow::permit(ch.main.ident(), ReportKind::Feature, bytes).ok_or(TErr::Refused)?;
    let end = deadline.min(Instant::now() + step);
    ch.rx().flush();
    ch.main.send(&w, end)?;
    read_until(ch.rx(), step, end, f)
}

/// A feature request, then its reply read back as feature report `reply_id` (`len` bytes) after `wait`, up to `tries`
/// times while it is not the reply yet (`f` None). The raw buffer is given to `f`, its report id first.
#[allow(clippy::too_many_arguments)]
pub fn feat_ask<R>(t: &mut dyn HidTransport, bytes: &[u8], reply_id: u8, len: usize, wait: Duration, tries: u32, deadline: Instant, f: &mut dyn FnMut(&[u8]) -> Option<R>) -> Result<R, TErr> {
    let w = allow::permit(t.ident(), ReportKind::Feature, bytes).ok_or(TErr::Refused)?;
    t.send(&w, deadline)?;
    for _ in 0..tries.max(1) {
        pause(wait, deadline);
        let r = t.get_feature(reply_id, len, deadline)?;
        if let Some(v) = f(&r) {
            return Ok(v);
        }
    }
    Err(TErr::BadReply)
}

/// Listens for `window` (never past `deadline`) until `f` takes a report. Ok(None): reports came, none taken;
/// Err(Timeout): nothing came.
pub fn listen<R>(t: &mut dyn HidTransport, window: Duration, deadline: Instant, f: &mut dyn FnMut(&[u8]) -> Option<R>) -> Result<Option<R>, TErr> {
    let end = deadline.min(Instant::now() + window);
    let mut heard = false;
    loop {
        if Instant::now() >= end {
            break;
        }
        match t.read_input(end) {
            Ok(r) => {
                heard = true;
                if let Some(v) = f(payload(&r)) {
                    return Ok(Some(v));
                }
            }
            Err(TErr::Gone) => return Err(TErr::Gone),
            Err(_) => break,
        }
    }
    if heard {
        Ok(None)
    } else {
        Err(TErr::Timeout)
    }
}

/// The 8-bit sum of `b`.
pub fn sum8(b: &[u8]) -> u8 {
    b.iter().fold(0u8, |a, &x| a.wrapping_add(x))
}

/// Reads one unit. `slot`: a receiver's slot (the device behind it), or None for the unit itself — for a receiver with
/// slots, None probes them (Answer::slots). `on`: the user's switch for this family (on by default for a passive
/// reader, off for one that sends).
pub fn read(ch: &mut Chans, m: &Model, slot: Option<u8>, on: bool, deadline: Instant, now: u64) -> Answer {
    if !on {
        return Outcome::Read(Reading::unknown(Note::QueryOff, Charging::Unknown, now)).into();
    }
    match m.driver().id {
        "mk-logitech" => logitech::read(ch, m, slot, deadline, now),
        "mk-razer" => razer::read(ch, m, deadline, now).into(),
        "mk-steelseries" => steelseries::read(ch, m, deadline, now).into(),
        "mk-corsair-bragi" => corsair::read_bragi(ch, m, slot, deadline, now),
        "mk-corsair-compx" | "mk-kysona" | "mk-gwolves-k" | "mk-redragon-k" | "mk-atk-k" | "mk-hitscan-k" | "mk-pulsar-k" => kysona::read(ch, m, deadline, now).into(),
        "mk-p83" | "mk-hitscan" | "mk-gwolves" | "mk-wlmouse" | "mk-lamzu" | "mk-arbiter" => proto::read_p83(ch, m, deadline, now).into(),
        "mk-pulsar" => pulsar::read(ch, m, deadline, now).into(),
        "mk-finalmouse" => finalmouse::read(ch, m, deadline, now).into(),
        "mk-endgame-4k" => endgame::read_4k(ch, m, deadline, now),
        "mk-endgame-we" | "mk-dareu" | "mk-areson" | "mk-fantech" => proto::read_compx_feature(ch, m, deadline, now).into(),
        "mk-vaxee" => vaxee::read(ch, m, deadline, now).into(),
        "mk-zowie-cw" | "mk-zowie-dw" => zowie::read(ch, m, deadline, now).into(),
        "mk-ninjutso-sora" | "mk-sprime" => ninjutso::read_sora(ch, m, deadline, now).into(),
        "mk-ninjutso-ten" => ninjutso::read_ten(ch, m, deadline, now).into(),
        "mk-darmoshark" => darmoshark::read(ch, m, deadline, now).into(),
        "mk-atk-nk" => atk::read_nk(ch, m, deadline, now).into(),
        "mk-atk-kb" => atk::read_kb(ch, m, deadline, now).into(),
        "mk-rapoo" => rapoo::read(ch, m, deadline, now).into(),
        "mk-keychron" => keychron::read(ch, m, deadline, now),
        "mk-rk" => royal_kludge::read(ch, m, deadline, now).into(),
        "mk-sonix" => sonix::read(ch, m, deadline, now).into(),
        "mk-semico" => semico::read(ch, m, deadline, now).into(),
        "mk-aula-by" => aula::read_by(ch, m, deadline, now),
        "mk-aula-hero" => aula::read_hero(ch, m, deadline, now).into(),
        "mk-mchose" => mchose::read(ch, m, deadline, now).into(),
        "mk-cherry" => cherry::read(ch, m, deadline, now).into(),
        "mk-coolermaster" => coolermaster::read(ch, m, deadline, now),
        "mk-machenike" => machenike::read(ch, m, deadline, now).into(),
        "mk-msi" => msi::read(ch, m, deadline, now).into(),
        "mk-rog" => rog::read(ch, m, slot, deadline, now),
        "mk-nzxt" => nzxt::read(ch, m, deadline, now).into(),
        "mk-niceboy" => niceboy::read(ch, m, deadline, now).into(),
        "mk-motospeed" | "mk-delux" | "mk-ajazz" | "mk-incott" | "mk-xenta" => misc::read(ch, m, deadline, now),
        _ => Outcome::Failed.into(),
    }
}

#[cfg(test)]
pub(crate) mod testkit {
    use super::*;
    use crate::transport::fake::FakeHid;
    use crate::transport::OpenMode;

    pub fn ident(m: &Model) -> HidIdent {
        let page = match m.page {
            Page::Is(p) => p,
            Page::Vendor => 0xFF00,
            Page::Any => 0xFF00,
        };
        HidIdent { vid: m.vid, pid: m.pid, usage_page: page, usage: m.usage.unwrap_or(1), interface: m.iface.unwrap_or(-1) }
    }
    /// A fake of this model's collection, opened as the platform would: read/write for one allow.rs names.
    pub fn fake(m: &Model) -> FakeHid {
        let mut f = FakeHid::new(ident(m));
        if f.mode == OpenMode::QueryOnly {
            f.mode = OpenMode::Read;
        }
        f
    }
    pub fn soon() -> Instant {
        Instant::now() + Duration::from_millis(500)
    }
    pub fn report(id: u8, len: usize, at: &[(usize, u8)]) -> Vec<u8> {
        crate::pads::testkit::report(id, len, at)
    }
    pub fn model(driver: &str, pid: u16) -> &'static Model {
        all_models().find(|m| m.driver == driver && m.pid == pid && m.role == Role::Main).unwrap_or_else(|| panic!("{} {:04X}", driver, pid))
    }
    /// Reads `m` through one fake, the family switched on.
    pub fn read1(f: &mut FakeHid, m: &Model) -> Outcome {
        read(&mut Chans::one(f), m, None, true, soon(), 7).out
    }
    pub fn pctl(n: i64) -> Level {
        pct(n).unwrap()
    }
    pub fn at(l: Level, c: Charging) -> Outcome {
        got(l, c, 7)
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::*;
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_model_names_a_product_and_a_known_driver() {
        let mut seen = HashSet::new();
        for m in all_models() {
            assert!(m.vid != 0 && m.pid != 0, "{}: a product id, never a vendor alone", m.name);
            assert!(driver(m.driver).is_some(), "{}: driver {}", m.name, m.driver);
            assert!(!m.name.is_empty());
            assert!(matches!(m.kind, Kind::Mouse | Kind::Keyboard), "{}: mice and keyboards only here", m.name);
            // (One model per collection: the same product, page, usage, interface and lengths never twice.)
            let k = (m.vid, m.pid, format!("{:?}{:?}{:?}{:?}{:?}{:?}", m.page, m.usage, m.iface, m.input, m.output, m.feature));
            assert!(seen.insert(k), "{} {:04X}:{:04X} listed twice for one collection", m.name, m.vid, m.pid);
        }
        assert!(all_models().count() > 500);
        // (Another product of a listed vendor matches nothing.)
        for (vid, pid) in [(0x1532u16, 0xFFF0u16), (0x046D, 0x0001), (0x1038, 0x0001), (0x258A, 0x0001), (0x3554, 0x0001), (0x1B1C, 0x0001)] {
            for page in [0x0001u16, 0x000C, 0xFF00, 0xFF02, 0xFFFF] {
                assert!(find(&HidIdent { vid, pid, usage_page: page, usage: 1, interface: 0 }, 65, 65, 91).is_none(), "{:04X}:{:04X}", vid, pid);
            }
        }
    }

    #[test]
    fn defaults_and_families() {
        for d in DRIVERS {
            assert_eq!(d.proven, Proven::PortedUntested, "{}: nothing is tested on hardware here", d.id);
            assert_eq!(d.on_by_default(), d.way == Way::Passive, "{}", d.id);
            assert!(d.id.starts_with("mk-") && crate::pads::driver(d.id).is_none(), "{}: never a controller reader's id", d.id);
        }
        for f in Family::ALL {
            assert_eq!(Family::parse(f.as_str()), Some(f));
            assert!(crate::pads::Family::parse(f.as_str()).is_none());
            assert!(DRIVERS.iter().any(|d| d.family == f), "{:?} has a reader", f);
            assert!(all_models().any(|m| m.driver().family == f), "{:?} has a product", f);
        }
        assert_eq!(listen_families(), vec![Family::Rapoo, Family::Aula, Family::Xenta]);
        assert!(query_families().contains(&Family::Logitech) && !query_families().contains(&Family::Rapoo) && !query_families().contains(&Family::Xenta));
        // (Every model of a reader that sends has an allow entry for its product, and every allow entry is for a
        //  product of a reader that sends.)
        for m in all_models().filter(|m| m.driver().way == Way::Query && m.role == Role::Main) {
            let id = ident(m);
            assert!(allow::may_write(&id), "{} {:04X}:{:04X}: sends, so allow.rs names it", m.name, m.vid, m.pid);
        }
        for e in allowed::SETS.iter().map(|e| e.devices).chain(allowed::TEMPLATES.iter().map(|t| t.devices)) {
            for &pid in e.pids {
                let m = all_models().find(|m| m.vid == e.vid && m.pid == pid).unwrap_or_else(|| panic!("an allow entry for an unlisted product {:04X}:{:04X}", e.vid, pid));
                assert_eq!(m.driver().way, Way::Query, "{}: a passive reader has no allow entry", m.name);
            }
        }
        for m in all_models().filter(|m| m.driver().way == Way::Passive) {
            assert!(!allow::may_write(&ident(m)), "{}: listens only, nothing may be written to it", m.name);
        }
    }

    #[test]
    fn a_family_switched_off_touches_nothing() {
        for m in all_models() {
            let mut f = fake(m);
            f.stream.push_back(vec![0; 64]);
            f.features.insert(0, vec![0; 65]);
            let a = read(&mut Chans::one(&mut f), m, None, false, soon(), 9);
            assert_eq!(a.out, Outcome::Read(Reading::unknown(Note::QueryOff, Charging::Unknown, 9)), "{}", m.name);
            assert!(f.sent.is_empty() && f.reads == 0 && f.flushes == 0, "{}: nothing sent or read while off", m.name);
        }
    }

    #[test]
    fn pairs_merge_only_by_the_explicit_rule() {
        let cable = model("mk-steelseries", 0x183A);
        let rx = model("mk-steelseries", 0x1838);
        let other = model("mk-steelseries", 0x1852);
        assert_eq!(merge_pairs(&[rx, other, cable]), vec![vec![2, 0], vec![1]]);
        // (Two receivers of one model and one cable: which receiver is that mouse's cannot be told — three cards.)
        assert_eq!(merge_pairs(&[rx, rx, cable]).len(), 3);
        // (No pair named: never merged, even the same product twice.)
        let k = model("mk-cherry", 0x00EA);
        assert_eq!(merge_pairs(&[k, k]), vec![vec![0], vec![1]]);
        assert_eq!(slot_key("hid:046D:C52B:c:{X}", 2), "hid:046D:C52B:c:{X}:slot:2");
    }

    #[test]
    fn switches_and_open_modes() {
        let lg = model("mk-logitech", 0xC52B);
        assert!(!is_on(lg, &[], &[]), "a reader that sends: off until turned on");
        assert!(is_on(lg, &[Family::Logitech], &[]));
        let rp = model("mk-rapoo", 0x1410);
        assert!(is_on(rp, &[], &[]), "a reader that listens: on until turned off");
        assert!(!is_on(rp, &[], &[Family::Rapoo]));
        assert!(sends_output("mk-logitech") && sends_output("mk-steelseries") && sends_output("mk-corsair-bragi"));
        assert!(!sends_output("mk-razer") && !sends_output("mk-p83") && !sends_output("mk-rapoo"), "feature reports only, or nothing");
        // (The registry's claim: any role of a listed collection, never another product.)
        assert!(find_any(&HidIdent { vid: 0x04A5, pid: 0x800A, usage_page: 0xFF04, usage: 1, interface: -1 }).is_some());
        assert!(find_any(&HidIdent { vid: 0x04A5, pid: 0x800B, usage_page: 0xFF04, usage: 1, interface: -1 }).is_none());
    }

    #[test]
    fn levels_as_the_device_gives_them() {
        assert_eq!(pct(100), Some(Level::Exact(Percent::new(100).unwrap())));
        assert_eq!(pct(101), None);
        assert_eq!(pct(-1), None);
        assert_eq!(scaled(255, 255), pct(100));
        assert_eq!(scaled(128, 255), pct(50));
        assert_eq!(scaled(0, 255), pct(0));
        assert_eq!(scaled(256, 255), None);
        assert_eq!(scaled(995, 1000), pct(100));
        assert_eq!(steps(7, 7).map(|l| l.as_coarse()), Some(Some(Coarse::Full)));
        assert_eq!(steps(8, 7), None);
        assert_eq!(from_millivolts(4100), Level::Coarse(Coarse::Full));
        assert_eq!(from_millivolts(3800), Level::Coarse(Coarse::Medium));
        assert_eq!(from_millivolts(3650), Level::Coarse(Coarse::Low));
        assert_eq!(from_millivolts(2999), Level::Unknown);
        assert_eq!(from_millivolts(4501), Level::Unknown);
        assert_eq!(from_millivolts(0), Level::Unknown);
    }

    #[test]
    fn helpers_send_only_allowed_bytes_and_take_only_their_reply() {
        let m = model("mk-motospeed", 0xFFE0);
        let mut f = fake(m);
        f.stream.push_back(vec![0xB4, 1]);
        f.replies.push_back(vec![vec![0x11, 2], report(0xB4, 21, &[(20, 0x40)])]);
        let r = out_ask(&mut Chans::one(&mut f), &[0xB5, 0x06], Duration::from_millis(50), soon(), &mut |r| if r[0] == 0xB4 && r.len() > 20 { Some(r[20]) } else { None });
        assert_eq!(r, Ok(0x40));
        assert_eq!(f.flushes, 1, "the old report dropped first");
        let mut f = fake(m);
        assert_eq!(out_ask(&mut Chans::one(&mut f), &[0xB5, 0x07], Duration::from_millis(50), soon(), &mut |_| Some(())), Err(TErr::Refused));
        assert_eq!(send(&mut f, ReportKind::Feature, &[0xB5, 0x06], soon()), Err(TErr::Refused), "the right bytes as another kind");
        assert!(f.sent.is_empty());
        // (A past deadline: nothing sent.)
        let past = Instant::now() - Duration::from_millis(1);
        assert_eq!(out_ask(&mut Chans::one(&mut f), &[0xB5, 0x06], Duration::from_millis(50), past, &mut |_| Some(())), Err(TErr::Timeout));
        assert!(f.sent.is_empty());
        assert_eq!(sum8(&[0xFF, 0x02]), 0x01);
    }
}
