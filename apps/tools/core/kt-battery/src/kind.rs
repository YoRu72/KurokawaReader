// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): what kind of device, and whose.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/generic.cpp (KindFromClassOfDevice, KindFromCategory, KindFromBleIds), src/hid.cpp (GuessKind,
// KindFromCollections) and src/brands.cpp (BrandOf: its vendor-id and name rules) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later.
// Changed here: earbuds and speakers are told from headsets (our drawn icons differ); the brand is only a name shown as
// text — no colours, no logos —; the brand is never taken from a vendor id another maker shares (as the original).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::model::Kind;

/// From a classic Bluetooth device's Class of Device.
pub fn from_class_of_device(cod: u32) -> Kind {
    let major = (cod >> 8) & 0x1F;
    let minor = (cod >> 2) & 0x3F;
    match major {
        0x04 => match minor {
            // (Audio/Video minor classes: 0x01 wearable headset, 0x02 hands-free, 0x05 loudspeaker, 0x06 headphones.)
            0x05 => Kind::Speaker,
            _ => Kind::Headset,
        },
        0x05 => {
            if (minor & 0x0F) == 0x01 || (minor & 0x0F) == 0x02 {
                Kind::Controller
            } else if (minor >> 4) == 1 {
                Kind::Keyboard
            } else if (minor >> 4) == 2 {
                Kind::Mouse
            } else {
                Kind::Other
            }
        }
        0x02 => Kind::Phone,
        _ => Kind::Other,
    }
}

/// From the category Windows files a device container under (Bluetooth LE devices have no Class of Device).
pub fn from_category(c: &str) -> Kind {
    match c {
        "Input.Keyboard" => Kind::Keyboard,
        "Input.Mouse" => Kind::Mouse,
        "Input.Gaming" => Kind::Controller,
        "Audio.Headphones" => Kind::Headset,
        "Audio.Speaker" => Kind::Speaker,
        "Communication.Phone" => Kind::Phone,
        _ if c.starts_with("Communication.Headset") => Kind::Headset,
        _ => Kind::Other,
    }
}

/// Bluetooth LE keyboards that also expose a mouse collection, by their exact ids (the original's list).
pub fn from_ble_ids(vid: u16, pid: u16) -> Kind {
    // (3151:4013 Attack Shark K86 over Bluetooth, from the original's issue #168.)
    if vid == 0x3151 && pid == 0x4013 {
        Kind::Keyboard
    } else {
        Kind::Other
    }
}

/// From the top-level collections of one device (Generic Desktop page): mouse, then gamepad/joystick, then keyboard.
pub fn from_collections(usages: &[(u16, u16)]) -> Kind {
    let has = |u: u16| usages.iter().any(|&(p, x)| p == 0x01 && x == u);
    if has(0x02) {
        Kind::Mouse
    } else if has(0x04) || has(0x05) {
        Kind::Controller
    } else if has(0x06) {
        Kind::Keyboard
    } else {
        Kind::Other
    }
}

/// From the name, when nothing else told.
pub fn guess(name: &str) -> Kind {
    let n = name.to_lowercase();
    let has = |s: &str| n.contains(s);
    if has("mouse") || has("mice") || has("trackball") || has("trackpad") {
        Kind::Mouse
    } else if has("keyboard") || has("keys") {
        Kind::Keyboard
    } else if has("controller") || has("gamepad") || has("xbox") || has("dualsense") || has("dualshock") || has("joy-con") {
        Kind::Controller
    } else if has("buds") || has("pods") || n.starts_with("wf-") {
        Kind::Earbuds
    } else if has("speaker") {
        Kind::Speaker
    } else if has("head") || has("ear") || n.starts_with("wh-") || has("audio") || has("arctis") || has("cloud") || has("void") || has("virtuoso") {
        Kind::Headset
    } else {
        Kind::Other
    }
}

/// Vendor ids that only one brand uses (shared ones — 03F0 HP/HyperX, 0B05 ASUS/ROG, 045E Microsoft — left to the name).
const VIDS: &[(u16, &str)] = &[
    (0x1532, "Razer"),
    (0x068E, "Razer"),
    (0x046D, "Logitech"),
    (0x1038, "SteelSeries"),
    (0x1B1C, "Corsair"),
    (0x0951, "HyperX"),
    (0x04A5, "ZOWIE"),
    (0x054C, "PlayStation"),
    (0x04E8, "Samsung"),
    (0x05AC, "Apple"),
    (0x004C, "Apple"),
    (0x0B0E, "Jabra"),
    (0x0ECB, "JBL"),
    (0x2516, "Cooler Master"),
    (0x28DE, "Steam"),
    (0x2DC8, "8BitDo"),
    (0x3537, "GameSir"),
];

#[derive(Clone, Copy)]
enum How {
    Contains,
    Word,
    Prefix,
    Exact,
}

const NAMES: &[(&str, How, &str)] = &[
    ("razer", How::Contains, "Razer"),
    ("logitech", How::Contains, "Logitech"),
    ("logi ", How::Prefix, "Logitech"),
    ("mx ", How::Prefix, "Logitech"),
    ("lift", How::Prefix, "Logitech"),
    ("pop mouse", How::Prefix, "Logitech"),
    ("pop keys", How::Prefix, "Logitech"),
    ("pebble", How::Prefix, "Logitech"),
    ("ergo k", How::Prefix, "Logitech"),
    ("ergo m", How::Prefix, "Logitech"),
    ("steelseries", How::Contains, "SteelSeries"),
    ("arctis", How::Word, "SteelSeries"),
    ("aerox", How::Word, "SteelSeries"),
    ("rival ", How::Prefix, "SteelSeries"),
    ("corsair", How::Contains, "Corsair"),
    ("hyperx", How::Contains, "HyperX"),
    ("pulsefire", How::Word, "HyperX"),
    ("rog", How::Word, "ROG"),
    ("zowie", How::Contains, "ZOWIE"),
    ("dualsense", How::Contains, "PlayStation"),
    ("dualshock", How::Contains, "PlayStation"),
    ("playstation", How::Contains, "PlayStation"),
    ("inzone", How::Word, "PlayStation"),
    ("wireless controller", How::Exact, "PlayStation"),
    ("xbox", How::Word, "Xbox"),
    ("galaxy ", How::Prefix, "Samsung"),
    ("samsung", How::Word, "Samsung"),
    ("airpods", How::Contains, "Apple"),
    ("magic mouse", How::Prefix, "Apple"),
    ("magic keyboard", How::Prefix, "Apple"),
    ("magic trackpad", How::Prefix, "Apple"),
    ("apple", How::Word, "Apple"),
    ("iphone", How::Prefix, "Apple"),
    ("jabra", How::Word, "Jabra"),
    ("jbl", How::Word, "JBL"),
    ("cooler master", How::Contains, "Cooler Master"),
    ("coolermaster", How::Contains, "Cooler Master"),
    ("steam controller", How::Contains, "Steam"),
    ("8bitdo", How::Contains, "8BitDo"),
    ("gamesir", How::Contains, "GameSir"),
];

fn has_word(n: &str, w: &str) -> bool {
    let b = n.as_bytes();
    let mut from = 0;
    while let Some(i) = n[from..].find(w) {
        let at = from + i;
        let end = at + w.len();
        let start_ok = at == 0 || !(b[at - 1] as char).is_alphanumeric();
        let end_ok = end == n.len() || !(b[end] as char).is_alphanumeric();
        if start_ok && end_ok {
            return true;
        }
        from = at + 1;
        while from < n.len() && !n.is_char_boundary(from) {
            from += 1;
        }
        if from >= n.len() {
            break;
        }
    }
    false
}

/// Sony's headphones share PlayStation's vendor id but are not PlayStation gear.
fn sony_audio(n: &str) -> bool {
    n.starts_with("wh-") || n.starts_with("wf-") || has_word(n, "linkbuds")
}

/// Logitech names that are only a model number: «K380», «M720 Triathlon», «G915».
fn logitech_model(n: &str) -> bool {
    let c: Vec<char> = n.chars().collect();
    c.len() >= 4 && matches!(c[0], 'g' | 'k' | 'm') && c[1].is_ascii_digit() && c[2].is_ascii_digit() && c[3].is_ascii_digit() && (c.len() == 4 || !c[4].is_alphanumeric())
}

/// The brand as text («» when not known): by vendor id, then by name.
pub fn brand_of(vid: u16, name: &str, kind: Kind) -> &'static str {
    let n = name.to_lowercase();
    if vid != 0 {
        if let Some(&(_, b)) = VIDS.iter().find(|&&(v, _)| v == vid) {
            if !(b == "PlayStation" && sony_audio(&n)) {
                return b;
            }
        }
        if vid == 0x045E && kind == Kind::Controller {
            return "Xbox";
        }
    }
    if sony_audio(&n) {
        return "Sony";
    }
    for &(text, how, b) in NAMES {
        let hit = match how {
            How::Contains => n.contains(text),
            How::Word => has_word(&n, text),
            How::Prefix => n.starts_with(text),
            How::Exact => n == text,
        };
        if hit {
            return b;
        }
    }
    if logitech_model(&n) {
        "Logitech"
    } else {
        ""
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn class_of_device() {
        assert_eq!(from_class_of_device(0x240404), Kind::Headset);
        assert_eq!(from_class_of_device(0x240414), Kind::Speaker);
        assert_eq!(from_class_of_device(0x002508), Kind::Controller);
        assert_eq!(from_class_of_device(0x002540), Kind::Keyboard);
        assert_eq!(from_class_of_device(0x002580), Kind::Mouse);
        assert_eq!(from_class_of_device(0x5A020C), Kind::Phone);
        assert_eq!(from_class_of_device(0), Kind::Other);
    }

    #[test]
    fn categories_collections_and_names() {
        assert_eq!(from_category("Input.Mouse"), Kind::Mouse);
        assert_eq!(from_category("Communication.Headset.Bluetooth"), Kind::Headset);
        assert_eq!(from_category("Other"), Kind::Other);
        assert_eq!(from_collections(&[(0x01, 0x06), (0x01, 0x02)]), Kind::Mouse);
        assert_eq!(from_collections(&[(0x01, 0x06), (0x0C, 0x01)]), Kind::Keyboard);
        assert_eq!(from_collections(&[(0x01, 0x05)]), Kind::Controller);
        assert_eq!(from_collections(&[(0xFF00, 0x01)]), Kind::Other);
        assert_eq!(from_ble_ids(0x3151, 0x4013), Kind::Keyboard);
        assert_eq!(guess("Pebble Mouse 2"), Kind::Mouse);
        assert_eq!(guess("Galaxy Buds2 Pro"), Kind::Earbuds);
        assert_eq!(guess("WH-1000XM5"), Kind::Headset);
        assert_eq!(guess("Party Speaker"), Kind::Speaker);
        assert_eq!(guess("Xbox Wireless Controller"), Kind::Controller);
        assert_eq!(guess("Thing"), Kind::Other);
    }

    #[test]
    fn brands() {
        assert_eq!(brand_of(0x046D, "Anything", Kind::Mouse), "Logitech");
        assert_eq!(brand_of(0x054C, "DualSense Wireless Controller", Kind::Controller), "PlayStation");
        assert_eq!(brand_of(0x054C, "WH-1000XM4", Kind::Headset), "Sony", "Sony audio is not PlayStation");
        assert_eq!(brand_of(0x045E, "Xbox Wireless Controller", Kind::Controller), "Xbox");
        assert_eq!(brand_of(0x045E, "Surface Mouse", Kind::Mouse), "", "Microsoft's id is shared");
        assert_eq!(brand_of(0, "MX Master 3S", Kind::Mouse), "Logitech");
        assert_eq!(brand_of(0, "Progress Bar", Kind::Other), "", "«rog» only as a word");
        assert_eq!(brand_of(0, "ASUS ROG Delta", Kind::Headset), "ROG");
        assert_eq!(brand_of(0, "K380", Kind::Keyboard), "Logitech");
        assert_eq!(brand_of(0, "Wireless Controller", Kind::Controller), "PlayStation");
        assert_eq!(brand_of(0, "Shape One", Kind::Other), "");
        assert_eq!(brand_of(0, "ماوس", Kind::Mouse), "", "non-ASCII names do not panic");
        assert!(has_word("a xbox pad", "xbox") && !has_word("xboxer", "xbox") && !has_word("é", "xbox"));
    }
}
