//! The floating translator's lettering rules that are plain arithmetic on text (stage M4): KtLettering.java's markers
//! put back (`restore`) and its glossary told to an AI model (`prompt`), and KtLetterFace.kinds' look rules — a block
//! is a thought, a sound effect, a caption box or dialogue by its brackets, its letters, its height against the
//! median and its background colour. Std only; `rustc --edition 2021 --test lettering.rs`.
//!
//! Not here, by nature: fitting the words into the box (Android's TextView auto-size with the chosen Typeface and
//! Paint — the font's own metrics, line breaking, RTL shaping — draws and measures it), and the glossary's matching
//! (java.util.regex with Unicode case folding and the Latin script class, which std has no tables for); the caller
//! passes the glossary's kind for a block when its terms matched.

include!("javachar.in");
include!("javachar_fns.in");

/// KtLettering.restore for one text: each «[[n]]» (spaces allowed inside) whose n is in `used` replaced by its
/// translation. Err where Java's Integer.parseInt throws (a marker number past 2³¹−1).
pub fn restore(s: &[u16], used: &[(i64, Vec<u16>)]) -> Result<Vec<u16>, String> {
    let ws = |u: u16| matches!(u, 0x20 | 0x09 | 0x0A | 0x0B | 0x0C | 0x0D);
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    let n = s.len();
    let mut last = 0;
    while i < n {
        // [ \s* [ \s* (\d+) \s* ] \s* ]
        let try_at = |mut p: usize| -> Option<(usize, usize, usize)> {
            if s.get(p) != Some(&0x5B) {
                return None;
            }
            p += 1;
            while p < n && ws(s[p]) {
                p += 1;
            }
            if s.get(p) != Some(&0x5B) {
                return None;
            }
            p += 1;
            while p < n && ws(s[p]) {
                p += 1;
            }
            let d0 = p;
            while p < n && (0x30..=0x39).contains(&s[p]) {
                p += 1;
            }
            if p == d0 {
                return None;
            }
            let d1 = p;
            while p < n && ws(s[p]) {
                p += 1;
            }
            if s.get(p) != Some(&0x5D) {
                return None;
            }
            p += 1;
            while p < n && ws(s[p]) {
                p += 1;
            }
            if s.get(p) != Some(&0x5D) {
                return None;
            }
            Some((d0, d1, p + 1))
        };
        if let Some((d0, d1, end)) = try_at(i) {
            let num = j_parse(&s[d0..d1], 10, i32::MIN as i64, i32::MAX as i64).ok_or("restore: a marker number Java cannot read")?;
            out.extend_from_slice(&s[last..i]);
            match used.iter().find(|(k, _)| *k == num) {
                Some((_, to)) => out.extend_from_slice(to),
                None => out.extend_from_slice(&s[i..end]),
            }
            i = end;
            last = end;
        } else {
            i += 1;
        }
    }
    out.extend_from_slice(&s[last..]);
    Ok(out)
}

/// KtLettering.prompt: (from, to) in the glossary's order (longest first, as Java sorted them).
pub fn prompt(g: &[(Vec<u16>, Vec<u16>)]) -> Vec<u16> {
    let mut b: Vec<u16> = Vec::new();
    let mut n = 0;
    for (from, to) in g {
        if to.is_empty() {
            continue;
        }
        n += 1;
        if n > 200 {
            continue;
        }
        b.push(0x0A);
        b.extend_from_slice(from);
        b.extend(" → ".encode_utf16());
        b.extend_from_slice(to);
    }
    if b.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<u16> = "\n\nGlossary — always translate these terms exactly this way:".encode_utf16().collect();
    out.extend(b);
    out
}

/// A block as KtLetterFace.kinds reads it: its text, its height, its background (ARGB, 0: none), and the glossary's
/// kind when one of its terms matched.
pub struct Block {
    pub text: Vec<u16>,
    pub height: i32,
    pub bg: i32,
    pub glossary_kind: Option<String>,
}
fn bracket_open(u: u16) -> bool {
    matches!(u, 0x28 | 0xFF08 | 0x3014 | 0xFF3B | 0x5B)
}
fn bracket_close(u: u16) -> bool {
    matches!(u, 0x29 | 0xFF09 | 0x3015 | 0xFF3D | 0x5D)
}
/// KtLetterFace.kinds: each block's kind.
pub fn kinds(blocks: &[Block]) -> Vec<String> {
    let mut hs: Vec<i32> = blocks.iter().filter(|b| b.height > 0).map(|b| b.height).collect();
    hs.sort_unstable();
    let median = if hs.is_empty() { 0 } else { hs[hs.len() / 2] };
    blocks
        .iter()
        .map(|k| {
            if let Some(g) = &k.glossary_kind {
                return g.clone();
            }
            let s = j_trim(&k.text);
            let letters = char::decode_utf16(s.iter().copied()).filter(|c| matches!(c, Ok(ch) if j_is_letter(*ch as u32))).count();
            let has_bg = k.bg != 0;
            let (r, gr, bl) = ((k.bg >> 16) & 255, (k.bg >> 8) & 255, k.bg & 255);
            let lum = (0.2126 * r as f64 + 0.7152 * gr as f64 + 0.0722 * bl as f64) / 255.0;
            let (mx, mn) = (r.max(gr.max(bl)), r.min(gr.min(bl)));
            let sat = if mx == 0 { 0.0 } else { (mx - mn) as f64 / mx as f64 };
            let light = !has_bg || (lum > 0.82 && sat < 0.18);
            let kind = if s.len() >= 2 && bracket_open(s[0]) && bracket_close(s[s.len() - 1]) {
                "thought"
            } else if letters > 0 && letters <= 6 && median > 0 && k.height as f64 > median as f64 * 1.7 && !light {
                "sfx"
            } else if has_bg && (lum < 0.55 || sat > 0.25) {
                "box"
            } else {
                "dialogue"
            };
            kind.to_string()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn s(x: &str) -> Vec<u16> {
        u16s(x)
    }

    #[test]
    fn markers_put_back() {
        let used = vec![(0i64, s("كوروكاوا")), (12, s("Item"))];
        assert_eq!(restore(&s("Hello [[0]] and [ [ 12 ] ]!"), &used).unwrap(), s("Hello كوروكاوا and Item!"));
        assert_eq!(restore(&s("[[3]] stays, [[[0]] too"), &used).unwrap(), s("[[3]] stays, [كوروكاوا too"));
        assert_eq!(restore(&s("no marker [[x]] [["), &used).unwrap(), s("no marker [[x]] [["));
        assert_eq!(restore(&s("[[٣]]"), &used).unwrap(), s("[[٣]]")); // (\d is ASCII only in Java's default regex)
        assert!(restore(&s("[[99999999999]]"), &used).is_err());
        assert_eq!(restore(&s("[[\t0\n]]"), &used).unwrap(), s("كوروكاوا"));
    }

    #[test]
    fn the_prompt() {
        assert!(prompt(&[(s("a"), s(""))]).is_empty());
        assert_eq!(String::from_utf16(&prompt(&[(s("Kurokawa"), s("كوروكاوا")), (s("x"), s(""))])).unwrap(), "\n\nGlossary — always translate these terms exactly this way:\nKurokawa → كوروكاوا");
        let many: Vec<(Vec<u16>, Vec<u16>)> = (0..250).map(|i| (s(&format!("t{}", i)), s("y"))).collect();
        assert_eq!(String::from_utf16(&prompt(&many)).unwrap().matches('\n').count(), 2 + 200);
    }

    #[test]
    fn kinds_by_look() {
        let b = |t: &str, h: i32, bg: i32| Block { text: s(t), height: h, bg, glossary_kind: None };
        let k = kinds(&[
            b("（心の声）", 40, 0),
            b("BOOM", 120, 0xFF202020u32 as i32),
            b("BOOM", 120, 0xFFFFFFFFu32 as i32),
            b("Meanwhile, in town", 40, 0xFF102040u32 as i32),
            b("Hello there", 40, 0xFFF8F8F8u32 as i32),
            b("Hi", 40, 0),
            b("(", 40, 0),
            b("𠀋𠀋", 120, 0xFF000000u32 as i32),
        ]);
        assert_eq!(k, vec!["thought", "sfx", "dialogue", "box", "dialogue", "dialogue", "dialogue", "sfx"]);
        let g = kinds(&[Block { text: s("x"), height: 0, bg: 0, glossary_kind: Some("sign".into()) }]);
        assert_eq!(g, vec!["sign"]);
    }
}
