// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): what a device and a reading are.
// Derived from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor), src/devices.h
// at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later.
// Changed here: a coarse level is its own value, never a made-up percentage (the original stored 5/25/60/100 for
// XInput's four levels); a percentage cannot be over 100 (Percent's only constructor checks it); charging may be
// unknown; every reading carries the time it was taken, so its age is shown and an old value is never passed as new;
// a device has a stable key per physical unit, its brand as text and how it is connected.
// Copyright (C) 2026 Kurokawa contributors. Std only.

/// What a device is, for its drawn icon and its words. (The original's Other/Mouse/Headset/Keyboard/Gamepad/Phone,
/// with earbuds and speakers apart from headsets.)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Mouse,
    Keyboard,
    Headset,
    Earbuds,
    Controller,
    Speaker,
    Phone,
    Other,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Mouse => "mouse",
            Kind::Keyboard => "keyboard",
            Kind::Headset => "headset",
            Kind::Earbuds => "earbuds",
            Kind::Controller => "controller",
            Kind::Speaker => "speaker",
            Kind::Phone => "phone",
            Kind::Other => "other",
        }
    }
    pub fn parse(s: &str) -> Kind {
        match s {
            "mouse" => Kind::Mouse,
            "keyboard" => Kind::Keyboard,
            "headset" => Kind::Headset,
            "earbuds" => Kind::Earbuds,
            "controller" => Kind::Controller,
            "speaker" => Kind::Speaker,
            "phone" => Kind::Phone,
            _ => Kind::Other,
        }
    }
}

/// How the device reaches the computer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Connection {
    Usb,
    Dongle,
    Bluetooth,
    Unknown,
}

impl Connection {
    pub fn as_str(self) -> &'static str {
        match self {
            Connection::Usb => "usb",
            Connection::Dongle => "dongle",
            Connection::Bluetooth => "bluetooth",
            Connection::Unknown => "unknown",
        }
    }
}

/// Which reader found the device (the original's driver). Piece 1 has the generic ones only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Source {
    /// HID Battery Strength / Absolute State Of Charge (src/drivers/generic.cpp PollGenericHid).
    HidGeneric,
    /// Windows' Bluetooth battery property (generic.cpp PollBluetooth).
    Bluetooth,
    /// Windows.Gaming.Input's battery report: a real percentage (xinput.cpp PollWgi).
    XboxWgi,
    /// XInput: four coarse levels (xinput.cpp PollXInput).
    XInput,
    /// A controller's own reader (pads/*.rs: PlayStation, Nintendo, Steam, 8BitDo, GameSir, Flydigi, BEITONG).
    Pad,
    /// A mouse's or keyboard's own reader (mice/*.rs: Logitech HID++, Razer, SteelSeries, Corsair and the rest).
    Vendor,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::HidGeneric => "hid",
            Source::Bluetooth => "bluetooth",
            Source::XboxWgi => "xbox",
            Source::XInput => "xinput",
            Source::Pad => "pad",
            Source::Vendor => "vendor",
        }
    }
    /// Which reading wins when two readers see one physical device (identity.rs): a controller's own reader first (it
    /// reads the pad's own report), then Windows' own Bluetooth level over the HID field on the same link (the
    /// original: «its HID field can read 0»), a real percentage over a coarse one.
    pub fn rank(self) -> u8 {
        match self {
            Source::Pad | Source::Vendor => 5,
            Source::Bluetooth => 4,
            Source::XboxWgi => 3,
            Source::HidGeneric => 2,
            Source::XInput => 1,
        }
    }
}

/// A percentage, 0..=100 — no other value can be made.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Percent(u8);

impl Percent {
    pub fn new(v: i64) -> Option<Percent> {
        if (0..=100).contains(&v) {
            Some(Percent(v as u8))
        } else {
            None
        }
    }
    pub fn get(self) -> u8 {
        self.0
    }
}

/// A level a device gives only in steps (XInput's four, later a pad's five): shown as bars or words, never as a number.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Coarse {
    Empty,
    Low,
    Medium,
    High,
    Full,
}

impl Coarse {
    pub fn as_str(self) -> &'static str {
        match self {
            Coarse::Empty => "empty",
            Coarse::Low => "low",
            Coarse::Medium => "medium",
            Coarse::High => "high",
            Coarse::Full => "full",
        }
    }
    /// How many of five bars it fills (the page's drawing).
    pub fn bars(self) -> u8 {
        match self {
            Coarse::Empty => 0,
            Coarse::Low => 1,
            Coarse::Medium => 3,
            Coarse::High => 4,
            Coarse::Full => 5,
        }
    }
}

/// A level a device gives as `n` of `max` steps (a PlayStation pad's 0–10, a Nintendo pad's 0–4, a Flydigi pad's 0–5):
/// shown as «n of max» with as many bars, never as a made-up percentage (the original showed level × 10 + 5 %).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Steps {
    n: u8,
    max: u8,
}

impl Steps {
    /// The longest scale a device may give (more would be a percentage in disguise).
    pub const MAX: u8 = 20;
    pub fn new(n: i64, max: i64) -> Option<Steps> {
        if (1..=Steps::MAX as i64).contains(&max) && (0..=max).contains(&n) {
            Some(Steps { n: n as u8, max: max as u8 })
        } else {
            None
        }
    }
    pub fn n(self) -> u8 {
        self.n
    }
    pub fn max(self) -> u8 {
        self.max
    }
    /// The coarse word it is nearest to (for the low mark, the notices and the tray's order): none left Empty, up to
    /// a quarter Low, up to 60 % Medium, under full High, full Full.
    pub fn coarse(self) -> Coarse {
        let (n, m) = (u16::from(self.n), u16::from(self.max));
        if n == 0 {
            Coarse::Empty
        } else if n * 4 <= m {
            Coarse::Low
        } else if n * 5 <= m * 3 {
            Coarse::Medium
        } else if n < m {
            Coarse::High
        } else {
            Coarse::Full
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Exact(Percent),
    Coarse(Coarse),
    Steps(Steps),
    Unknown,
}

impl Level {
    /// Low enough to be marked (red on the page): an exact level at or under `threshold`, a coarse Empty or Low, steps
    /// whose nearest word is Empty or Low.
    pub fn is_low(self, threshold: u8) -> bool {
        match self {
            Level::Exact(p) => p.get() <= threshold,
            Level::Coarse(c) => c <= Coarse::Low,
            Level::Steps(s) => s.coarse() <= Coarse::Low,
            Level::Unknown => false,
        }
    }
    /// The coarse word for a level that is not exact (None for Exact and Unknown).
    pub fn as_coarse(self) -> Option<Coarse> {
        match self {
            Level::Coarse(c) => Some(c),
            Level::Steps(s) => Some(s.coarse()),
            _ => None,
        }
    }
}

/// Why a reading has no level, when the reader knows (the page says it in words).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Note {
    None,
    /// The device tells its level only in a mode or after a request Tools does not send (it would change the device:
    /// a report mode switch, a stream turned on) — readable only once something else (a game, the maker's app) did it.
    NeedsQuery,
    /// Its family needs a status request, and the user has not turned that family's reading on.
    QueryOff,
    /// A receiver with no controller linked to it.
    NoPad,
    /// A mouse's or keyboard's receiver with no device linked to it (or the device switched off).
    Unlinked,
}

impl Note {
    pub fn as_str(self) -> &'static str {
        match self {
            Note::None => "",
            Note::NeedsQuery => "needsQuery",
            Note::QueryOff => "queryOff",
            Note::NoPad => "noPad",
            Note::Unlinked => "unlinked",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Charging {
    Yes,
    No,
    Unknown,
}

impl Charging {
    pub fn as_str(self) -> &'static str {
        match self {
            Charging::Yes => "yes",
            Charging::No => "no",
            Charging::Unknown => "unknown",
        }
    }
}

/// One physical device. `key` is stable for this unit (identity.rs); `name` is what the system or the device calls it
/// (the user's own name is a setting, applied by the page); `brand` is plain text, never a logo.
#[derive(Clone, Debug, PartialEq)]
pub struct Device {
    pub key: String,
    pub name: String,
    pub kind: Kind,
    pub brand: String,
    pub connection: Connection,
    pub source: Source,
    /// USB / Bluetooth HID vendor and product ids, 0 when not known.
    pub vid: u16,
    pub pid: u16,
    /// Windows' container id of the physical device ("{…}"), "" when not known: one per device across its interfaces.
    pub container: String,
    /// The device's serial number when it gives one, "" otherwise.
    pub serial: String,
    /// The keys of other entries found to be this same device (identity.rs), in no particular order.
    pub merged: Vec<String>,
    /// A controller's reader (pads/mod.rs Driver id), "" for the generic readers.
    pub driver: &'static str,
    /// Our own drawing for it ("pad", "retro", "split", "half", "trackpads", …), "" to draw it by its kind.
    pub picture: &'static str,
}

impl Device {
    pub fn new(key: String, source: Source) -> Device {
        Device {
            key,
            name: String::new(),
            kind: Kind::Other,
            brand: String::new(),
            connection: Connection::Unknown,
            source,
            vid: 0,
            pid: 0,
            container: String::new(),
            serial: String::new(),
            merged: Vec::new(),
            driver: "",
            picture: "",
        }
    }
}

/// One answer of a device, with the time it was taken (ms since the Unix epoch, the caller's clock).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Reading {
    pub level: Level,
    pub charging: Charging,
    /// The device answered that it is asleep (a receiver present, the device off or sleeping): `level` is then Unknown.
    pub asleep: bool,
    pub taken_at: u64,
    /// Why `level` is Unknown, when the reader knows.
    pub note: Note,
}

impl Reading {
    pub fn new(level: Level, charging: Charging, taken_at: u64) -> Reading {
        Reading { level, charging, asleep: false, taken_at, note: Note::None }
    }
    pub fn asleep(taken_at: u64) -> Reading {
        Reading { level: Level::Unknown, charging: Charging::Unknown, asleep: true, taken_at, note: Note::None }
    }
    /// No level, and why.
    pub fn unknown(note: Note, charging: Charging, taken_at: u64) -> Reading {
        Reading { level: Level::Unknown, charging, asleep: false, taken_at, note }
    }
    /// How old it is at `now` (0 when the clock went back).
    pub fn age_ms(&self, now: u64) -> u64 {
        now.saturating_sub(self.taken_at)
    }
    /// Fresh: taken within `max_age_ms` of `now`.
    pub fn is_fresh(&self, now: u64, max_age_ms: u64) -> bool {
        self.age_ms(now) <= max_age_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_is_never_over_100_or_negative() {
        assert_eq!(Percent::new(0).map(Percent::get), Some(0));
        assert_eq!(Percent::new(100).map(Percent::get), Some(100));
        assert!(Percent::new(101).is_none());
        assert!(Percent::new(-1).is_none());
        assert!(Percent::new(i64::MAX).is_none());
        assert!(Percent::new(i64::MIN).is_none());
    }

    #[test]
    fn coarse_levels_stay_coarse() {
        let l = Level::Coarse(Coarse::Medium);
        assert!(!matches!(l, Level::Exact(_)));
        assert_eq!(Coarse::Full.bars(), 5);
        assert_eq!(Coarse::Empty.bars(), 0);
        assert!(Level::Coarse(Coarse::Low).is_low(15));
        assert!(!Level::Coarse(Coarse::Medium).is_low(15));
        assert!(Level::Exact(Percent::new(15).unwrap()).is_low(15));
        assert!(!Level::Exact(Percent::new(16).unwrap()).is_low(15));
        assert!(!Level::Unknown.is_low(100));
    }

    #[test]
    fn steps_stay_steps() {
        assert!(Steps::new(0, 10).is_some() && Steps::new(10, 10).is_some());
        assert!(Steps::new(11, 10).is_none(), "more than the scale");
        assert!(Steps::new(-1, 10).is_none());
        assert!(Steps::new(0, 0).is_none(), "an empty scale");
        assert!(Steps::new(3, 21).is_none(), "a scale past 20 is no step scale");
        let c = |n, m| Steps::new(n, m).unwrap().coarse();
        assert_eq!((c(0, 4), c(1, 4), c(2, 4), c(3, 4), c(4, 4)), (Coarse::Empty, Coarse::Low, Coarse::Medium, Coarse::High, Coarse::Full));
        assert_eq!((c(2, 10), c(3, 10), c(6, 10), c(9, 10), c(10, 10)), (Coarse::Low, Coarse::Medium, Coarse::Medium, Coarse::High, Coarse::Full));
        assert_eq!((c(1, 5), c(3, 5), c(4, 5)), (Coarse::Low, Coarse::Medium, Coarse::High));
        assert!(Level::Steps(Steps::new(1, 4).unwrap()).is_low(5), "a quarter is low whatever the mark");
        assert!(!Level::Steps(Steps::new(3, 10).unwrap()).is_low(50));
        assert_eq!(Level::Exact(Percent::new(5).unwrap()).as_coarse(), None);
        let r = Reading::unknown(Note::NeedsQuery, Charging::Unknown, 7);
        assert_eq!((r.level, r.note, r.asleep), (Level::Unknown, Note::NeedsQuery, false));
        assert_eq!(Reading::new(Level::Unknown, Charging::No, 0).note, Note::None);
    }

    #[test]
    fn age_and_freshness() {
        let r = Reading::new(Level::Unknown, Charging::Unknown, 1_000);
        assert_eq!(r.age_ms(61_000), 60_000);
        assert_eq!(r.age_ms(500), 0, "a clock that went back gives age 0, not a wrap");
        assert!(r.is_fresh(61_000, 60_000));
        assert!(!r.is_fresh(61_001, 60_000));
        let a = Reading::asleep(5);
        assert!(a.asleep && a.level == Level::Unknown);
    }

    #[test]
    fn kind_names_round_trip() {
        for k in [Kind::Mouse, Kind::Keyboard, Kind::Headset, Kind::Earbuds, Kind::Controller, Kind::Speaker, Kind::Phone, Kind::Other] {
            assert_eq!(Kind::parse(k.as_str()), k);
        }
        assert_eq!(Kind::parse("toaster"), Kind::Other);
    }
}
