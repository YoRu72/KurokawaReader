// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): a phone's level as Microsoft Phone Link keeps it (piece 6).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/phonelink.cpp (JsonString, BatteryPercent, PollPhoneLink) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later.
// Phone Link keeps the Windows 11 Start menu's companion card in its package folder of the user's own profile:
// %LOCALAPPDATA%\Packages\Microsoft.YourPhone_8wekyb3d8bbwe\LocalState\StartMenu\StartMenuCompanion.json — an Adaptive
// Card whose «speak» field reads «<phone> - Connected to your PC» and whose battery element says «Battery <n>%
// remaining». Exactly what the original reads: that one file, opened for reading (sharing it with Phone Link), at most
// 4 MB, two fields; nothing else of Phone Link is touched (no process, no other file, no private interface, no
// network, no device). The file is an undocumented detail of Phone Link: the parse is strict — anything unexpected, no
// phone. Its English phrases are Phone Link's in an English Windows; in another language the card says them otherwise
// and nothing is shown.
// D1 (the original's v1.1.0 phonelink.cpp at commit 7cc44f2): «, charging» right after «% remaining» while the phone
// charges — read as the charging state (else: not charging).
// Changed here: the reading's time is the file's own (when Phone Link wrote it), so the page shows its true age and an
// old card is never shown as fresh (the original marked a card older than 3 h as asleep).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::model::{Charging, Level, Percent, Reading};

/// The card's file under %LOCALAPPDATA%.
pub const REL_PATH: &str = "Packages\\Microsoft.YourPhone_8wekyb3d8bbwe\\LocalState\\StartMenu\\StartMenuCompanion.json";
/// The largest card read (as the original).
pub const MAX_BYTES: u64 = 4 * 1024 * 1024;

/// The first `"key":"…"` string value (simple escapes; \u decoded).
fn json_string(json: &str, key: &str) -> Option<String> {
    let pat = format!("\"{}\":\"", key);
    let start = json.find(&pat)? + pat.len();
    let mut out = String::new();
    let mut it = json[start..].chars();
    while let Some(c) = it.next() {
        match c {
            '"' => return Some(out),
            '\\' => match it.next()? {
                'u' => {
                    let h: String = (0..4).filter_map(|_| it.next()).collect();
                    out.push(u32::from_str_radix(&h, 16).ok().and_then(char::from_u32).unwrap_or('?'));
                }
                'n' | 't' | 'r' => out.push(' '),
                e => out.push(e),
            },
            c => out.push(c),
        }
    }
    None
}

/// The first «Battery <n>% remaining», 0–100.
fn battery(json: &str) -> Option<u8> {
    let pat = "Battery ";
    let mut from = 0;
    while let Some(i) = json[from..].find(pat) {
        let j = from + i + pat.len();
        let digits: String = json[j..].chars().take_while(|c| c.is_ascii_digit()).take(3).collect();
        if !digits.is_empty() && json[j + digits.len()..].starts_with("% remaining") {
            if let Ok(v) = digits.parse::<u8>() {
                if v <= 100 {
                    return Some(v);
                }
            }
        }
        from = j;
    }
    None
}

/// D1: whether the first «Battery <n>% remaining» goes on «, charging».
pub fn charging_of(json: &str) -> bool {
    let pat = "Battery ";
    let mut from = 0;
    while let Some(i) = json[from..].find(pat) {
        let j = from + i + pat.len();
        let digits: String = json[j..].chars().take_while(|c| c.is_ascii_digit()).take(3).collect();
        if !digits.is_empty() && json[j + digits.len()..].starts_with("% remaining") {
            return json[j + digits.len() + "% remaining".len()..].starts_with(", charging");
        }
        from = j;
    }
    false
}

/// The phone's name and level from the card, or None (not connected, another card, anything unexpected).
pub fn parse(json: &str) -> Option<(String, u8)> {
    const SUFFIX: &str = " - Connected to your PC";
    let speak = json_string(json, "speak")?;
    let name = speak.strip_suffix(SUFFIX)?.trim();
    if name.is_empty() || name.chars().any(char::is_control) {
        return None;
    }
    Some((name.chars().take(64).collect(), battery(json)?))
}

/// The reading, at the time the file was written (never later than now).
pub fn reading(level: u8, written_ms: u64, now: u64) -> Option<Reading> {
    Percent::new(i64::from(level)).map(|p| Reading::new(Level::Exact(p), Charging::Unknown, written_ms.min(now)))
}

/// D1: the reading with the card's charging state.
pub fn reading_with(level: u8, charging: bool, written_ms: u64, now: u64) -> Option<Reading> {
    Percent::new(i64::from(level)).map(|p| Reading::new(Level::Exact(p), if charging { Charging::Yes } else { Charging::No }, written_ms.min(now)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_companion_card() {
        let card = r#"{"type":"AdaptiveCard","speak":"Sam's Pixel - Connected to your PC","body":[{"type":"Image","altText":"Battery","tooltip":"Battery 64% remaining"}]}"#;
        assert_eq!(parse(card), Some(("Sam's Pixel".to_string(), 64)));
        assert_eq!(parse(&card.replace(" - Connected to your PC", " - Not connected")), None, "not connected: no phone");
        assert_eq!(parse(&card.replace("64%", "640%")), None, "not a level");
        assert_eq!(parse(&card.replace("Battery 64% remaining", "Battery low")), None);
        assert_eq!(parse(r#"{"speak":"Phone - Connected to your PC"#), None, "an unended string");
        assert_eq!(parse("not json at all"), None);
        assert_eq!(parse(&card.replace("Sam's Pixel", "")), None, "no name");
        assert_eq!(parse(&card.replace("Sam's", "Sam\\u0041")).map(|x| x.0), Some("SamA Pixel".to_string()), "an escaped letter");
        let r = reading(64, 1_000, 5_000).unwrap();
        assert_eq!((r.taken_at, r.level), (1_000, Level::Exact(Percent::new(64).unwrap())), "the file's own time");
        assert_eq!(reading(64, 9_000, 5_000).unwrap().taken_at, 5_000, "a time ahead of the clock: now");
        // (D1: «, charging».)
        let c = card.replace("64% remaining", "64% remaining, charging");
        assert_eq!((parse(&c).map(|x| x.1), charging_of(&c), charging_of(card)), (Some(64), true, false));
        assert_eq!(reading_with(64, true, 1_000, 5_000).unwrap().charging, Charging::Yes);
    }
}
