// The start's decisions (stage R6b), std only — checked alone with `rustc --edition 2021 --test bootlogic.rs`: the
// colour the window opens in (the page's own, kept from the last run in <config>/boot.json, so a dark interface
// never flashes white and a light one never flashes dark), and the start-up times the self-test prints.
#![allow(dead_code)]

/// The colour when nothing is kept yet: Electron's window background (main.cjs `backgroundColor`), the app's dark
/// interface.
pub const DEFAULT_BG: (u8, u8, u8) = (0x12, 0x13, 0x14);

/// «#rrggbb» (or «#rgb») → the colour; None for anything else.
pub fn parse_hex(s: &str) -> Option<(u8, u8, u8)> {
    let h = s.trim().strip_prefix('#')?;
    if !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let full: String = match h.len() {
        3 => h.chars().flat_map(|c| [c, c]).collect(),
        6 => h.to_string(),
        _ => return None,
    };
    let v = u32::from_str_radix(&full, 16).ok()?;
    Some(((v >> 16) as u8, (v >> 8) as u8, v as u8))
}

/// The colour as «#rrggbb».
pub fn hex_of(c: (u8, u8, u8)) -> String {
    format!("#{:02x}{:02x}{:02x}", c.0, c.1, c.2)
}

/// The kept file's text ({"bg":"#rrggbb"}) → the colour, else the default.
pub fn bg_of_file(text: &str) -> (u8, u8, u8) {
    let i = match text.find("\"bg\"") {
        Some(i) => i,
        None => return DEFAULT_BG,
    };
    let rest = &text[i + 4..];
    let q1 = match rest.find('"') {
        Some(q) => q,
        None => return DEFAULT_BG,
    };
    let rest = &rest[q1 + 1..];
    let q2 = rest.find('"').unwrap_or(0);
    parse_hex(&rest[..q2]).unwrap_or(DEFAULT_BG)
}

/// The file's text for a colour.
pub fn file_of_bg(c: (u8, u8, u8)) -> String {
    format!("{{\"bg\":\"{}\"}}\n", hex_of(c))
}

/// The start-up times, in milliseconds from the program's start: the first paint of the page and the app ready
/// (its first screen in place).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Times {
    pub paint: Option<u64>,
    pub ready: Option<u64>,
}

impl Times {
    /// Noted once each: a later mark of the same kind (a reload) leaves the first.
    pub fn mark(&mut self, what: &str, ms: u64) -> bool {
        let slot = match what {
            "paint" => &mut self.paint,
            "ready" => &mut self.ready,
            _ => return false,
        };
        if slot.is_none() {
            *slot = Some(ms);
            true
        } else {
            false
        }
    }
    /// One line for a log: «paint 212 ms · ready 486 ms».
    pub fn line(&self) -> String {
        let f = |x: Option<u64>| x.map(|v| format!("{} ms", v)).unwrap_or_else(|| "—".to_string());
        format!("paint {} · ready {}", f(self.paint), f(self.ready))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours() {
        assert_eq!(parse_hex("#121314"), Some((0x12, 0x13, 0x14)));
        assert_eq!(parse_hex(" #F7F8FA "), Some((0xf7, 0xf8, 0xfa)));
        assert_eq!(parse_hex("#fff"), Some((255, 255, 255)));
        assert_eq!(parse_hex("121314"), None);
        assert_eq!(parse_hex("#12131"), None);
        assert_eq!(parse_hex("#ggg"), None);
        assert_eq!(parse_hex("rgb(1,2,3)"), None);
        assert_eq!(hex_of((0, 10, 255)), "#000aff");
        assert_eq!(bg_of_file(&file_of_bg((0xf7, 0xf8, 0xfa))), (0xf7, 0xf8, 0xfa));
        assert_eq!(bg_of_file("{ \"bg\" : \"#000000\" }"), (0, 0, 0));
        assert_eq!(bg_of_file("{}"), DEFAULT_BG);
        assert_eq!(bg_of_file("{\"bg\":\"red\"}"), DEFAULT_BG);
        assert_eq!(bg_of_file(""), DEFAULT_BG);
    }

    #[test]
    fn times() {
        let mut t = Times::default();
        assert!(t.mark("paint", 200));
        assert!(!t.mark("paint", 900));
        assert!(!t.mark("other", 1));
        assert!(t.mark("ready", 480));
        assert_eq!(t, Times { paint: Some(200), ready: Some(480) });
        assert_eq!(t.line(), "paint 200 ms · ready 480 ms");
        assert_eq!(Times::default().line(), "paint — · ready —");
    }
}
