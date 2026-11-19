// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the tray's short list — which devices, in what order, and the tooltip's
// clipping. Derived from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/main.cpp (the tray's one icon per device and its tooltip «name\nstatus») at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later.
// Changed here: one icon (the app's) with a menu of at most MAX_LINES devices, lowest first; the tooltip names the
// lowest. A coarse level sorts by the middle of its step, never shown as a number. Pure and std only.
// Copyright (C) 2026 Kurokawa contributors.
use crate::model::{Coarse, Level};

/// At most this many devices in the tray's menu.
pub const MAX_LINES: usize = 6;
/// Windows' tooltip holds 127 UTF-16 units (NOTIFYICONDATAW.szTip, 128 with its end).
pub const TIP_MAX_UTF16: usize = 127;

fn coarse_weight(c: Coarse) -> u16 {
    5 + match c {
        Coarse::Empty => 0,
        Coarse::Low => 100,
        Coarse::Medium => 500,
        Coarse::High => 750,
        Coarse::Full => 1000,
    }
}

/// Sort weight: lower is emptier. A device with no current level comes after every one with a level.
pub fn weight(level: Option<Level>) -> u16 {
    match level {
        Some(Level::Exact(p)) => u16::from(p.get()) * 10,
        Some(Level::Coarse(c)) => coarse_weight(c),
        // (Steps between their scale's points: 3 of 10 weighs as 30 %, a hair above it, like a coarse word.)
        Some(Level::Steps(s)) => 5 + u16::from(s.n()) * 1000 / u16::from(s.max()),
        Some(Level::Unknown) | None => 2000,
    }
}

/// The devices for the tray: lowest first (ties keep the given order), at most `max`.
pub fn lowest_first<T>(mut items: Vec<T>, level: impl Fn(&T) -> Option<Level>, max: usize) -> Vec<T> {
    items.sort_by_key(|x| weight(level(x)));
    items.truncate(max);
    items
}

/// A text cut to `max` UTF-16 units, an ellipsis at the end when cut (never half a character).
pub fn clip_utf16(s: &str, max: usize) -> String {
    if s.encode_utf16().count() <= max {
        return s.to_string();
    }
    let mut out = String::new();
    let mut n = 0;
    for c in s.chars() {
        if n + c.len_utf16() + 1 > max {
            break;
        }
        n += c.len_utf16();
        out.push(c);
    }
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Percent;

    fn ex(p: i64) -> Option<Level> {
        Some(Level::Exact(Percent::new(p).unwrap()))
    }

    #[test]
    fn lowest_first_with_coarse_and_unknown_after() {
        let items = vec![("a", ex(80)), ("b", None), ("c", Some(Level::Coarse(Coarse::Low))), ("d", ex(5)), ("e", Some(Level::Unknown)), ("f", ex(10)), ("g", ex(60)), ("h", ex(70))];
        let got: Vec<&str> = lowest_first(items.clone(), |x| x.1, 6).into_iter().map(|x| x.0).collect();
        assert_eq!(got, vec!["d", "f", "c", "g", "h", "a"], "coarse Low sorts between 10 % and 11 %; at most six");
        let all: Vec<&str> = lowest_first(items, |x| x.1, 20).into_iter().map(|x| x.0).collect();
        assert_eq!(&all[6..], &["b", "e"], "no level: last, in the order given");
        assert!(weight(Some(Level::Coarse(Coarse::Empty))) > weight(ex(0)));
        assert!(weight(Some(Level::Coarse(Coarse::Full))) > weight(ex(100)));
    }

    #[test]
    fn tooltip_clipped_in_utf16_units() {
        assert_eq!(clip_utf16("short", 127), "short");
        let long = "x".repeat(200);
        let c = clip_utf16(&long, 127);
        assert_eq!(c.encode_utf16().count(), 127);
        assert!(c.ends_with('…'));
        let emoji = "🙂".repeat(100);
        let e = clip_utf16(&emoji, 127);
        assert!(e.encode_utf16().count() <= 127 && e.ends_with('…'));
        let ar = "بطارية الفأرة منخفضة ".repeat(10);
        assert!(clip_utf16(&ar, TIP_MAX_UTF16).encode_utf16().count() <= TIP_MAX_UTF16);
    }
}
