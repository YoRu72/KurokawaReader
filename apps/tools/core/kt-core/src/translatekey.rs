//! The screen translator's cache keys (stage M1), as `apps/tools/native/android/KtTranslate.java` makes them: what
//! translates (engine, languages, the AI model, the glossary) and the text with its spacing evened out, so an OCR
//! reading with a space more is not asked again. Java keeps its copy as the reference; a debuggable build with the
//! Rust core present checks each key against this one (KtCore's shadow mode). Std only: checked alone with
//! `rustc --edition 2021 --test translatekey.rs`.
//!
//! Not here, and why: Unicode NFC (Java's `Normalizer`) needs Unicode tables std does not carry — the caller passes
//! the text already composed (Java does it, and a later stage may take a crate for it); `hasLetters` (Java's
//! `Character.isLetter` on UTF-16 units) has no exact std counterpart (`char::is_alphabetic` also takes letter
//! numbers and combining vowel signs), so it stays Java's until a stage needs it.

/// Java's `String.hashCode()`: 31·h + unit over the UTF-16 units, wrapping in 32 bits.
pub fn java_hash(s: &str) -> i32 {
    let mut h: i32 = 0;
    for u in s.encode_utf16() {
        h = h.wrapping_mul(31).wrapping_add(u as i32);
    }
    h
}

/// Java's `Integer.toString(n, 36)`: lower-case digits, a minus sign for a negative number.
pub fn java_radix36(n: i32) -> String {
    const D: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let neg = n < 0;
    let mut v: i64 = (n as i64).abs();
    if v == 0 {
        return "0".to_string();
    }
    let mut out: Vec<u8> = Vec::new();
    while v > 0 {
        out.push(D[(v % 36) as usize]);
        v /= 36;
    }
    if neg {
        out.push(b'-');
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// KtLettering.key: the glossary's entries (from, to) as one short key.
pub fn glossary_key(entries: &[(String, String)]) -> String {
    let mut b = String::new();
    for (from, to) in entries {
        b.push_str(from);
        b.push('\u{1}');
        b.push_str(to);
        b.push('\u{2}');
    }
    java_radix36(java_hash(&b))
}

/// What translates, as KtTranslate.Config holds it after `Config.from` (the AI address without its trailing slashes).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Config {
    pub engine: String,
    pub source: String,
    pub target: String,
    pub style: String,
    pub base: String,
    pub model: String,
    pub prompt: String,
    pub glossary: Vec<(String, String)>,
}

/// KtTranslate.Config.id().
pub fn config_id(c: &Config) -> String {
    let ai = if c.engine == "ai" { format!("{}{}{}{}", c.style, c.base, c.model, java_hash(&c.prompt)) } else { String::new() };
    format!("{}|{}|{}|{}|{}", c.engine, c.source, c.target, ai, glossary_key(&c.glossary))
}

/// KtTranslate.norm after its NFC step: runs of spaces, tabs, no-break and ideographic spaces one space; no space at
/// the ends of lines (line breaks kept); then Java's trim (every character up to U+0020 off both ends).
pub fn norm_spaces(composed: &str) -> String {
    // 1. [ \t 　]+ → " "
    let mut a = String::with_capacity(composed.len());
    let mut in_run = false;
    for c in composed.chars() {
        if c == ' ' || c == '\t' || c == '\u{A0}' || c == '\u{3000}' {
            if !in_run {
                a.push(' ');
            }
            in_run = true;
        } else {
            a.push(c);
            in_run = false;
        }
    }
    // 2. " ?\n ?" → "\n" (leftmost, non-overlapping; after step 1 a space never follows a space)
    let cs: Vec<char> = a.chars().collect();
    let mut b = String::with_capacity(a.len());
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        if c == ' ' && i + 1 < cs.len() && cs[i + 1] == '\n' {
            i += 2;
            if i < cs.len() && cs[i] == ' ' {
                i += 1;
            }
            b.push('\n');
        } else if c == '\n' {
            i += 1;
            if i < cs.len() && cs[i] == ' ' {
                i += 1;
            }
            b.push('\n');
        } else {
            b.push(c);
            i += 1;
        }
    }
    // 3. String.trim()
    b.trim_matches(|c: char| c <= ' ').to_string()
}

/// The cache's key: the config's id, a NUL, the text evened out (`composed`: the text already NFC).
pub fn cache_key(c: &Config, composed: &str) -> String {
    format!("{}\u{0}{}", config_id(c), norm_spaces(composed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(xs: &[(&str, &str)]) -> Vec<(String, String)> {
        xs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    // The values Java gives (java 21, `"…".hashCode()` and `Integer.toString(h, 36)`), written down once.
    #[test]
    fn java_hashes() {
        assert_eq!(java_hash(""), 0);
        assert_eq!(java_hash("a"), 97);
        assert_eq!(java_hash("hello"), 99162322);
        assert_eq!(java_hash("Translate this, please."), -1322780352);
        assert_eq!(java_hash("مرحبا"), 1531039712);
        assert_eq!(java_hash("😀"), 1772899);
        assert_eq!(java_radix36(0), "0");
        assert_eq!(java_radix36(35), "z");
        assert_eq!(java_radix36(-36), "-10");
        assert_eq!(java_radix36(i32::MIN), "-zik0zk");
        assert_eq!(java_radix36(i32::MAX), "zik0zj");
    }

    #[test]
    fn glossary_keys() {
        assert_eq!(glossary_key(&[]), "0");
        assert_eq!(glossary_key(&g(&[("Kurokawa", "كوروكاوا")])), "6baiw9");
        assert_eq!(glossary_key(&g(&[("Akane", "أكاني"), ("Kana", "كانا")])), "-tk12z5");
    }

    #[test]
    fn ids() {
        let mut c = Config { engine: "google".into(), source: "auto".into(), target: "ar".into(), style: "openai".into(), ..Default::default() };
        assert_eq!(config_id(&c), "google|auto|ar||0");
        c.engine = "ai".into();
        c.base = "http://127.0.0.1:9/oa".into();
        c.model = "m1".into();
        c.prompt = "Translate this, please.".into();
        assert_eq!(config_id(&c), "ai|auto|ar|openaihttp://127.0.0.1:9/oam1-1322780352|0");
        c.prompt.clear();
        c.glossary = g(&[("Kurokawa", "كوروكاوا")]);
        assert_eq!(config_id(&c), "ai|auto|ar|openaihttp://127.0.0.1:9/oam10|6baiw9");
    }

    #[test]
    fn spacing() {
        assert_eq!(norm_spaces("  Hello   world  "), "Hello world");
        assert_eq!(norm_spaces("a\t\u{A0}\u{3000}b"), "a b");
        assert_eq!(norm_spaces("line one \n line two"), "line one\nline two");
        assert_eq!(norm_spaces("a \n \n b"), "a\n\nb");
        assert_eq!(norm_spaces("a\n\nb"), "a\n\nb");
        assert_eq!(norm_spaces("\n\r x \r\n"), "x");
        assert_eq!(norm_spaces("a\r\nb"), "a\r\nb");
        assert_eq!(norm_spaces(""), "");
        assert_eq!(norm_spaces("こんにちは\u{3000}\u{3000}世界"), "こんにちは 世界");
        let c = Config { engine: "deepl".into(), source: "ja".into(), target: "en".into(), ..Default::default() };
        assert_eq!(cache_key(&c, " x  y "), "deepl|ja|en||0\u{0}x y");
    }
}
