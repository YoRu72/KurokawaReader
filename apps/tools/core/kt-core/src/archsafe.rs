//! Archive safety, the pure part — the twin of desktop/archsafe.cjs (the page and Electron) and KtNameSafe.java
//! (Android), all three run on tests/data/namesafe-vectors.tsv: the one name table (desktop/namesafe.json) per target,
//! the checks a whole archive's names must pass together, CRC-32, the peak-space replay and the journal's text.
//! Std only: `rustc --edition 2021 --test src/archsafe.rs`. (Unicode form folding for macOS covers the Latin letters
//! with marks — U+00C0…U+024F, U+1E00…U+1EFF — that a std-only build can decompose; JS and Java fold every script.)

use std::collections::{HashMap, HashSet};

pub const REPLACEMENT: char = '_';
pub const TEMP_SUFFIX: &str = ".kt-part";
pub const ASIDE_DIR: &str = ".kurokawa-replaced";
pub const EXT_KEEP: usize = 9;
pub const PORTABLE_ILLEGAL: &str = "\\/:*?\"<>|";
pub const RESERVED_NAMES: [&str; 32] = ["CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "COM¹", "COM²", "COM³", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "LPT¹", "LPT²", "LPT³", "CONIN$", "CONOUT$"];
pub const BIDI: [u32; 12] = [1564, 8206, 8207, 8234, 8235, 8236, 8237, 8238, 8294, 8295, 8296, 8297];

/// One target's rules (namesafe.json «platforms»).
pub struct Platform { pub name: &'static str, pub illegal: &'static str, pub control_rewrite: bool, pub trailing_rewrite: bool, pub reserved: bool, pub max_name: usize, pub utf16: bool, pub max_path: usize, pub long_path: usize, pub fold_case: bool, pub fold_form: bool }
pub const PLATFORMS: [Platform; 5] = [
    Platform { name: "linux", illegal: "", control_rewrite: false, trailing_rewrite: false, reserved: false, max_name: 255, utf16: false, max_path: 4095, long_path: 0, fold_case: false, fold_form: false },
    Platform { name: "android", illegal: "", control_rewrite: false, trailing_rewrite: false, reserved: false, max_name: 255, utf16: false, max_path: 4095, long_path: 0, fold_case: false, fold_form: false },
    Platform { name: "android-fat", illegal: "\\:*?\"<>|", control_rewrite: true, trailing_rewrite: true, reserved: false, max_name: 255, utf16: true, max_path: 4095, long_path: 0, fold_case: true, fold_form: false },
    Platform { name: "macos", illegal: "", control_rewrite: false, trailing_rewrite: false, reserved: false, max_name: 255, utf16: false, max_path: 1023, long_path: 0, fold_case: true, fold_form: true },
    Platform { name: "windows", illegal: "\\:*?\"<>|", control_rewrite: true, trailing_rewrite: true, reserved: true, max_name: 255, utf16: true, max_path: 32000, long_path: 259, fold_case: true, fold_form: false },
];
pub fn platform(name: &str) -> Option<&'static Platform> { PLATFORMS.iter().find(|p| p.name == name) }

#[derive(Debug, Clone, PartialEq)]
pub struct Verdict { pub action: &'static str, pub out: String, pub reasons: Vec<&'static str>, pub flags: Vec<&'static str> }
fn refuse(r: &'static str) -> Verdict { Verdict { action: "refuse", out: String::new(), reasons: vec![r], flags: vec![] } }
fn push(v: &mut Vec<&'static str>, x: &'static str) { if !v.contains(&x) { v.push(x); } }

/// Length in the target's unit (UTF-8 bytes or UTF-16 code units).
pub fn measure(s: &str, utf16: bool) -> usize { if utf16 { s.encode_utf16().count() } else { s.len() } }

/// `name` cut between characters to `max` units, its extension (a last dot within EXT_KEEP of the end) kept.
pub fn cut_name(name: &str, max: usize, utf16: bool) -> String {
    if measure(name, utf16) <= max { return name.to_string(); }
    let u: Vec<char> = name.chars().collect();
    let utf16_len = name.encode_utf16().count();
    let (stem, ext): (String, String) = match name.rfind('.') {
        Some(d) if d > 0 && utf16_len - name[..d].encode_utf16().count() <= EXT_KEEP => (name[..d].to_string(), name[d..].to_string()),
        _ => (u.iter().collect(), String::new()),
    };
    let room = max.saturating_sub(measure(&ext, utf16)).max(1);
    let mut out = String::new(); let mut n = 0;
    for ch in stem.chars() { let w = if utf16 { ch.len_utf16() } else { ch.len_utf8() }; if n + w > room { break; } out.push(ch); n += w; }
    out + &ext
}
fn is_control(c: u32) -> bool { (1..=0x1f).contains(&c) || c == 0x7f }

/// One path component for one target (desktop/archsafe.cjs nameRule).
pub fn name_rule(comp: &str, p: &Platform) -> Verdict {
    if comp.is_empty() { return refuse("empty"); }
    if comp.contains('\u{0}') { return refuse("nul"); }
    if comp == "." { return refuse("dot"); }
    if comp == ".." { return refuse("dotdot"); }
    if comp.to_lowercase().ends_with(TEMP_SUFFIX) { return refuse("reservedSuffix"); }
    let mut reasons = vec![]; let mut flags = vec![]; let mut out = String::new();
    for ch in comp.chars() {
        let c = ch as u32;
        if p.illegal.contains(ch) { out.push(REPLACEMENT); push(&mut reasons, if ch == ':' { "colon" } else { "illegal" }); continue; }
        if is_control(c) { if p.control_rewrite { out.push(REPLACEMENT); push(&mut reasons, "control"); continue; } push(&mut flags, "control"); }
        if BIDI.contains(&c) { push(&mut flags, "bidi"); }
        out.push(ch);
    }
    let trail = |out: &mut String, reasons: &mut Vec<&'static str>| {
        if !p.trailing_rewrite { return; }
        let keep = out.trim_end_matches(|c| c == '.' || c == ' ').len();
        if keep < out.len() { let k = out[keep..].chars().count(); out.truncate(keep); for _ in 0..k { out.push(REPLACEMENT); } push(reasons, "trailing"); }
    };
    trail(&mut out, &mut reasons);
    if p.reserved {
        let st = out.split('.').next().unwrap_or("").trim_end_matches(' ').to_uppercase();
        if RESERVED_NAMES.contains(&st.as_str()) { out.insert(0, REPLACEMENT); reasons.push("reserved"); }
    }
    let limit = p.max_name - TEMP_SUFFIX.len();
    if measure(&out, p.utf16) > limit { out = cut_name(&out, limit, p.utf16); reasons.push("long"); trail(&mut out, &mut reasons); }
    if out.starts_with(' ') || out.ends_with(' ') { flags.push("spaces"); }
    if out.starts_with('.') { flags.push("hidden"); }
    Verdict { action: if out == comp { "allow" } else { "rewrite" }, out, reasons, flags }
}

fn drive(path: &str) -> bool { let b = path.as_bytes(); b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' }

/// A whole relative path for one target (desktop/archsafe.cjs pathRule).
pub fn path_rule(path: &str, p: &Platform, dest_len: usize) -> Verdict {
    if path.is_empty() { return refuse("empty"); }
    if path.contains('\u{0}') { return refuse("nul"); }
    if path.starts_with('/') || path.starts_with('\\') { return refuse("absolute"); }
    if drive(path) { return refuse("drive"); }
    let comps: Vec<&str> = path.split('/').filter(|c| !c.is_empty() && *c != ".").collect();
    if comps.is_empty() { return refuse("empty"); }
    let mut outs = vec![]; let mut reasons = vec![]; let mut flags = vec![];
    for c in &comps {
        let r = name_rule(c, p);
        if r.action == "refuse" { return refuse(r.reasons[0]); }
        outs.push(r.out); for x in r.reasons { push(&mut reasons, x); } for x in r.flags { push(&mut flags, x); }
    }
    let out = outs.join("/"); let len = dest_len + measure(&out, p.utf16);
    if len > p.max_path { return refuse("pathLong"); }
    if p.long_path > 0 && len > p.long_path { flags.push("longPath"); }
    let action = if out == comps.join("/") && reasons.is_empty() { "allow" } else { "rewrite" };
    Verdict { action, out, reasons, flags }
}

const NFD: &[(u32, &str)] = &[(0xc0, "\u{41}\u{300}"), (0xc1, "\u{41}\u{301}"), (0xc2, "\u{41}\u{302}"), (0xc3, "\u{41}\u{303}"), (0xc4, "\u{41}\u{308}"), (0xc5, "\u{41}\u{30a}"), (0xc7, "\u{43}\u{327}"), (0xc8, "\u{45}\u{300}"), (0xc9, "\u{45}\u{301}"), (0xca, "\u{45}\u{302}"), (0xcb, "\u{45}\u{308}"), (0xcc, "\u{49}\u{300}"), (0xcd, "\u{49}\u{301}"), (0xce, "\u{49}\u{302}"), (0xcf, "\u{49}\u{308}"), (0xd1, "\u{4e}\u{303}"), (0xd2, "\u{4f}\u{300}"), (0xd3, "\u{4f}\u{301}"), (0xd4, "\u{4f}\u{302}"), (0xd5, "\u{4f}\u{303}"), (0xd6, "\u{4f}\u{308}"), (0xd9, "\u{55}\u{300}"), (0xda, "\u{55}\u{301}"), (0xdb, "\u{55}\u{302}"), (0xdc, "\u{55}\u{308}"), (0xdd, "\u{59}\u{301}"), (0xe0, "\u{61}\u{300}"), (0xe1, "\u{61}\u{301}"), (0xe2, "\u{61}\u{302}"), (0xe3, "\u{61}\u{303}"), (0xe4, "\u{61}\u{308}"), (0xe5, "\u{61}\u{30a}"), (0xe7, "\u{63}\u{327}"), (0xe8, "\u{65}\u{300}"), (0xe9, "\u{65}\u{301}"), (0xea, "\u{65}\u{302}"), (0xeb, "\u{65}\u{308}"), (0xec, "\u{69}\u{300}"), (0xed, "\u{69}\u{301}"), (0xee, "\u{69}\u{302}"), (0xef, "\u{69}\u{308}"), (0xf1, "\u{6e}\u{303}"), (0xf2, "\u{6f}\u{300}"), (0xf3, "\u{6f}\u{301}"), (0xf4, "\u{6f}\u{302}"), (0xf5, "\u{6f}\u{303}"), (0xf6, "\u{6f}\u{308}"), (0xf9, "\u{75}\u{300}"), (0xfa, "\u{75}\u{301}"), (0xfb, "\u{75}\u{302}"), (0xfc, "\u{75}\u{308}"), (0xfd, "\u{79}\u{301}"), (0xff, "\u{79}\u{308}"), (0x100, "\u{41}\u{304}"), (0x101, "\u{61}\u{304}"), (0x102, "\u{41}\u{306}"), (0x103, "\u{61}\u{306}"), (0x104, "\u{41}\u{328}"), (0x105, "\u{61}\u{328}"), (0x106, "\u{43}\u{301}"), (0x107, "\u{63}\u{301}"), (0x108, "\u{43}\u{302}"), (0x109, "\u{63}\u{302}"), (0x10a, "\u{43}\u{307}"), (0x10b, "\u{63}\u{307}"), (0x10c, "\u{43}\u{30c}"), (0x10d, "\u{63}\u{30c}"), (0x10e, "\u{44}\u{30c}"), (0x10f, "\u{64}\u{30c}"), (0x112, "\u{45}\u{304}"), (0x113, "\u{65}\u{304}"), (0x114, "\u{45}\u{306}"), (0x115, "\u{65}\u{306}"), (0x116, "\u{45}\u{307}"), (0x117, "\u{65}\u{307}"), (0x118, "\u{45}\u{328}"), (0x119, "\u{65}\u{328}"), (0x11a, "\u{45}\u{30c}"), (0x11b, "\u{65}\u{30c}"), (0x11c, "\u{47}\u{302}"), (0x11d, "\u{67}\u{302}"), (0x11e, "\u{47}\u{306}"), (0x11f, "\u{67}\u{306}"), (0x120, "\u{47}\u{307}"), (0x121, "\u{67}\u{307}"), (0x122, "\u{47}\u{327}"), (0x123, "\u{67}\u{327}"), (0x124, "\u{48}\u{302}"), (0x125, "\u{68}\u{302}"), (0x128, "\u{49}\u{303}"), (0x129, "\u{69}\u{303}"), (0x12a, "\u{49}\u{304}"), (0x12b, "\u{69}\u{304}"), (0x12c, "\u{49}\u{306}"), (0x12d, "\u{69}\u{306}"), (0x12e, "\u{49}\u{328}"), (0x12f, "\u{69}\u{328}"), (0x130, "\u{49}\u{307}"), (0x134, "\u{4a}\u{302}"), (0x135, "\u{6a}\u{302}"), (0x136, "\u{4b}\u{327}"), (0x137, "\u{6b}\u{327}"), (0x139, "\u{4c}\u{301}"), (0x13a, "\u{6c}\u{301}"), (0x13b, "\u{4c}\u{327}"), (0x13c, "\u{6c}\u{327}"), (0x13d, "\u{4c}\u{30c}"), (0x13e, "\u{6c}\u{30c}"), (0x143, "\u{4e}\u{301}"), (0x144, "\u{6e}\u{301}"), (0x145, "\u{4e}\u{327}"), (0x146, "\u{6e}\u{327}"), (0x147, "\u{4e}\u{30c}"), (0x148, "\u{6e}\u{30c}"), (0x14c, "\u{4f}\u{304}"), (0x14d, "\u{6f}\u{304}"), (0x14e, "\u{4f}\u{306}"), (0x14f, "\u{6f}\u{306}"), (0x150, "\u{4f}\u{30b}"), (0x151, "\u{6f}\u{30b}"), (0x154, "\u{52}\u{301}"), (0x155, "\u{72}\u{301}"), (0x156, "\u{52}\u{327}"), (0x157, "\u{72}\u{327}"), (0x158, "\u{52}\u{30c}"), (0x159, "\u{72}\u{30c}"), (0x15a, "\u{53}\u{301}"), (0x15b, "\u{73}\u{301}"), (0x15c, "\u{53}\u{302}"), (0x15d, "\u{73}\u{302}"), (0x15e, "\u{53}\u{327}"), (0x15f, "\u{73}\u{327}"), (0x160, "\u{53}\u{30c}"), (0x161, "\u{73}\u{30c}"), (0x162, "\u{54}\u{327}"), (0x163, "\u{74}\u{327}"), (0x164, "\u{54}\u{30c}"), (0x165, "\u{74}\u{30c}"), (0x168, "\u{55}\u{303}"), (0x169, "\u{75}\u{303}"), (0x16a, "\u{55}\u{304}"), (0x16b, "\u{75}\u{304}"), (0x16c, "\u{55}\u{306}"), (0x16d, "\u{75}\u{306}"), (0x16e, "\u{55}\u{30a}"), (0x16f, "\u{75}\u{30a}"), (0x170, "\u{55}\u{30b}"), (0x171, "\u{75}\u{30b}"), (0x172, "\u{55}\u{328}"), (0x173, "\u{75}\u{328}"), (0x174, "\u{57}\u{302}"), (0x175, "\u{77}\u{302}"), (0x176, "\u{59}\u{302}"), (0x177, "\u{79}\u{302}"), (0x178, "\u{59}\u{308}"), (0x179, "\u{5a}\u{301}"), (0x17a, "\u{7a}\u{301}"), (0x17b, "\u{5a}\u{307}"), (0x17c, "\u{7a}\u{307}"), (0x17d, "\u{5a}\u{30c}"), (0x17e, "\u{7a}\u{30c}"), (0x1a0, "\u{4f}\u{31b}"), (0x1a1, "\u{6f}\u{31b}"), (0x1af, "\u{55}\u{31b}"), (0x1b0, "\u{75}\u{31b}"), (0x1cd, "\u{41}\u{30c}"), (0x1ce, "\u{61}\u{30c}"), (0x1cf, "\u{49}\u{30c}"), (0x1d0, "\u{69}\u{30c}"), (0x1d1, "\u{4f}\u{30c}"), (0x1d2, "\u{6f}\u{30c}"), (0x1d3, "\u{55}\u{30c}"), (0x1d4, "\u{75}\u{30c}"), (0x1d5, "\u{55}\u{308}\u{304}"), (0x1d6, "\u{75}\u{308}\u{304}"), (0x1d7, "\u{55}\u{308}\u{301}"), (0x1d8, "\u{75}\u{308}\u{301}"), (0x1d9, "\u{55}\u{308}\u{30c}"), (0x1da, "\u{75}\u{308}\u{30c}"), (0x1db, "\u{55}\u{308}\u{300}"), (0x1dc, "\u{75}\u{308}\u{300}"), (0x1de, "\u{41}\u{308}\u{304}"), (0x1df, "\u{61}\u{308}\u{304}"), (0x1e0, "\u{41}\u{307}\u{304}"), (0x1e1, "\u{61}\u{307}\u{304}"), (0x1e2, "\u{c6}\u{304}"), (0x1e3, "\u{e6}\u{304}"), (0x1e6, "\u{47}\u{30c}"), (0x1e7, "\u{67}\u{30c}"), (0x1e8, "\u{4b}\u{30c}"), (0x1e9, "\u{6b}\u{30c}"), (0x1ea, "\u{4f}\u{328}"), (0x1eb, "\u{6f}\u{328}"), (0x1ec, "\u{4f}\u{328}\u{304}"), (0x1ed, "\u{6f}\u{328}\u{304}"), (0x1ee, "\u{1b7}\u{30c}"), (0x1ef, "\u{292}\u{30c}"), (0x1f0, "\u{6a}\u{30c}"), (0x1f4, "\u{47}\u{301}"), (0x1f5, "\u{67}\u{301}"), (0x1f8, "\u{4e}\u{300}"), (0x1f9, "\u{6e}\u{300}"), (0x1fa, "\u{41}\u{30a}\u{301}"), (0x1fb, "\u{61}\u{30a}\u{301}"), (0x1fc, "\u{c6}\u{301}"), (0x1fd, "\u{e6}\u{301}"), (0x1fe, "\u{d8}\u{301}"), (0x1ff, "\u{f8}\u{301}"), (0x200, "\u{41}\u{30f}"), (0x201, "\u{61}\u{30f}"), (0x202, "\u{41}\u{311}"), (0x203, "\u{61}\u{311}"), (0x204, "\u{45}\u{30f}"), (0x205, "\u{65}\u{30f}"), (0x206, "\u{45}\u{311}"), (0x207, "\u{65}\u{311}"), (0x208, "\u{49}\u{30f}"), (0x209, "\u{69}\u{30f}"), (0x20a, "\u{49}\u{311}"), (0x20b, "\u{69}\u{311}"), (0x20c, "\u{4f}\u{30f}"), (0x20d, "\u{6f}\u{30f}"), (0x20e, "\u{4f}\u{311}"), (0x20f, "\u{6f}\u{311}"), (0x210, "\u{52}\u{30f}"), (0x211, "\u{72}\u{30f}"), (0x212, "\u{52}\u{311}"), (0x213, "\u{72}\u{311}"), (0x214, "\u{55}\u{30f}"), (0x215, "\u{75}\u{30f}"), (0x216, "\u{55}\u{311}"), (0x217, "\u{75}\u{311}"), (0x218, "\u{53}\u{326}"), (0x219, "\u{73}\u{326}"), (0x21a, "\u{54}\u{326}"), (0x21b, "\u{74}\u{326}"), (0x21e, "\u{48}\u{30c}"), (0x21f, "\u{68}\u{30c}"), (0x226, "\u{41}\u{307}"), (0x227, "\u{61}\u{307}"), (0x228, "\u{45}\u{327}"), (0x229, "\u{65}\u{327}"), (0x22a, "\u{4f}\u{308}\u{304}"), (0x22b, "\u{6f}\u{308}\u{304}"), (0x22c, "\u{4f}\u{303}\u{304}"), (0x22d, "\u{6f}\u{303}\u{304}"), (0x22e, "\u{4f}\u{307}"), (0x22f, "\u{6f}\u{307}"), (0x230, "\u{4f}\u{307}\u{304}"), (0x231, "\u{6f}\u{307}\u{304}"), (0x232, "\u{59}\u{304}"), (0x233, "\u{79}\u{304}"), (0x1e00, "\u{41}\u{325}"), (0x1e01, "\u{61}\u{325}"), (0x1e02, "\u{42}\u{307}"), (0x1e03, "\u{62}\u{307}"), (0x1e04, "\u{42}\u{323}"), (0x1e05, "\u{62}\u{323}"), (0x1e06, "\u{42}\u{331}"), (0x1e07, "\u{62}\u{331}"), (0x1e08, "\u{43}\u{327}\u{301}"), (0x1e09, "\u{63}\u{327}\u{301}"), (0x1e0a, "\u{44}\u{307}"), (0x1e0b, "\u{64}\u{307}"), (0x1e0c, "\u{44}\u{323}"), (0x1e0d, "\u{64}\u{323}"), (0x1e0e, "\u{44}\u{331}"), (0x1e0f, "\u{64}\u{331}"), (0x1e10, "\u{44}\u{327}"), (0x1e11, "\u{64}\u{327}"), (0x1e12, "\u{44}\u{32d}"), (0x1e13, "\u{64}\u{32d}"), (0x1e14, "\u{45}\u{304}\u{300}"), (0x1e15, "\u{65}\u{304}\u{300}"), (0x1e16, "\u{45}\u{304}\u{301}"), (0x1e17, "\u{65}\u{304}\u{301}"), (0x1e18, "\u{45}\u{32d}"), (0x1e19, "\u{65}\u{32d}"), (0x1e1a, "\u{45}\u{330}"), (0x1e1b, "\u{65}\u{330}"), (0x1e1c, "\u{45}\u{327}\u{306}"), (0x1e1d, "\u{65}\u{327}\u{306}"), (0x1e1e, "\u{46}\u{307}"), (0x1e1f, "\u{66}\u{307}"), (0x1e20, "\u{47}\u{304}"), (0x1e21, "\u{67}\u{304}"), (0x1e22, "\u{48}\u{307}"), (0x1e23, "\u{68}\u{307}"), (0x1e24, "\u{48}\u{323}"), (0x1e25, "\u{68}\u{323}"), (0x1e26, "\u{48}\u{308}"), (0x1e27, "\u{68}\u{308}"), (0x1e28, "\u{48}\u{327}"), (0x1e29, "\u{68}\u{327}"), (0x1e2a, "\u{48}\u{32e}"), (0x1e2b, "\u{68}\u{32e}"), (0x1e2c, "\u{49}\u{330}"), (0x1e2d, "\u{69}\u{330}"), (0x1e2e, "\u{49}\u{308}\u{301}"), (0x1e2f, "\u{69}\u{308}\u{301}"), (0x1e30, "\u{4b}\u{301}"), (0x1e31, "\u{6b}\u{301}"), (0x1e32, "\u{4b}\u{323}"), (0x1e33, "\u{6b}\u{323}"), (0x1e34, "\u{4b}\u{331}"), (0x1e35, "\u{6b}\u{331}"), (0x1e36, "\u{4c}\u{323}"), (0x1e37, "\u{6c}\u{323}"), (0x1e38, "\u{4c}\u{323}\u{304}"), (0x1e39, "\u{6c}\u{323}\u{304}"), (0x1e3a, "\u{4c}\u{331}"), (0x1e3b, "\u{6c}\u{331}"), (0x1e3c, "\u{4c}\u{32d}"), (0x1e3d, "\u{6c}\u{32d}"), (0x1e3e, "\u{4d}\u{301}"), (0x1e3f, "\u{6d}\u{301}"), (0x1e40, "\u{4d}\u{307}"), (0x1e41, "\u{6d}\u{307}"), (0x1e42, "\u{4d}\u{323}"), (0x1e43, "\u{6d}\u{323}"), (0x1e44, "\u{4e}\u{307}"), (0x1e45, "\u{6e}\u{307}"), (0x1e46, "\u{4e}\u{323}"), (0x1e47, "\u{6e}\u{323}"), (0x1e48, "\u{4e}\u{331}"), (0x1e49, "\u{6e}\u{331}"), (0x1e4a, "\u{4e}\u{32d}"), (0x1e4b, "\u{6e}\u{32d}"), (0x1e4c, "\u{4f}\u{303}\u{301}"), (0x1e4d, "\u{6f}\u{303}\u{301}"), (0x1e4e, "\u{4f}\u{303}\u{308}"), (0x1e4f, "\u{6f}\u{303}\u{308}"), (0x1e50, "\u{4f}\u{304}\u{300}"), (0x1e51, "\u{6f}\u{304}\u{300}"), (0x1e52, "\u{4f}\u{304}\u{301}"), (0x1e53, "\u{6f}\u{304}\u{301}"), (0x1e54, "\u{50}\u{301}"), (0x1e55, "\u{70}\u{301}"), (0x1e56, "\u{50}\u{307}"), (0x1e57, "\u{70}\u{307}"), (0x1e58, "\u{52}\u{307}"), (0x1e59, "\u{72}\u{307}"), (0x1e5a, "\u{52}\u{323}"), (0x1e5b, "\u{72}\u{323}"), (0x1e5c, "\u{52}\u{323}\u{304}"), (0x1e5d, "\u{72}\u{323}\u{304}"), (0x1e5e, "\u{52}\u{331}"), (0x1e5f, "\u{72}\u{331}"), (0x1e60, "\u{53}\u{307}"), (0x1e61, "\u{73}\u{307}"), (0x1e62, "\u{53}\u{323}"), (0x1e63, "\u{73}\u{323}"), (0x1e64, "\u{53}\u{301}\u{307}"), (0x1e65, "\u{73}\u{301}\u{307}"), (0x1e66, "\u{53}\u{30c}\u{307}"), (0x1e67, "\u{73}\u{30c}\u{307}"), (0x1e68, "\u{53}\u{323}\u{307}"), (0x1e69, "\u{73}\u{323}\u{307}"), (0x1e6a, "\u{54}\u{307}"), (0x1e6b, "\u{74}\u{307}"), (0x1e6c, "\u{54}\u{323}"), (0x1e6d, "\u{74}\u{323}"), (0x1e6e, "\u{54}\u{331}"), (0x1e6f, "\u{74}\u{331}"), (0x1e70, "\u{54}\u{32d}"), (0x1e71, "\u{74}\u{32d}"), (0x1e72, "\u{55}\u{324}"), (0x1e73, "\u{75}\u{324}"), (0x1e74, "\u{55}\u{330}"), (0x1e75, "\u{75}\u{330}"), (0x1e76, "\u{55}\u{32d}"), (0x1e77, "\u{75}\u{32d}"), (0x1e78, "\u{55}\u{303}\u{301}"), (0x1e79, "\u{75}\u{303}\u{301}"), (0x1e7a, "\u{55}\u{304}\u{308}"), (0x1e7b, "\u{75}\u{304}\u{308}"), (0x1e7c, "\u{56}\u{303}"), (0x1e7d, "\u{76}\u{303}"), (0x1e7e, "\u{56}\u{323}"), (0x1e7f, "\u{76}\u{323}"), (0x1e80, "\u{57}\u{300}"), (0x1e81, "\u{77}\u{300}"), (0x1e82, "\u{57}\u{301}"), (0x1e83, "\u{77}\u{301}"), (0x1e84, "\u{57}\u{308}"), (0x1e85, "\u{77}\u{308}"), (0x1e86, "\u{57}\u{307}"), (0x1e87, "\u{77}\u{307}"), (0x1e88, "\u{57}\u{323}"), (0x1e89, "\u{77}\u{323}"), (0x1e8a, "\u{58}\u{307}"), (0x1e8b, "\u{78}\u{307}"), (0x1e8c, "\u{58}\u{308}"), (0x1e8d, "\u{78}\u{308}"), (0x1e8e, "\u{59}\u{307}"), (0x1e8f, "\u{79}\u{307}"), (0x1e90, "\u{5a}\u{302}"), (0x1e91, "\u{7a}\u{302}"), (0x1e92, "\u{5a}\u{323}"), (0x1e93, "\u{7a}\u{323}"), (0x1e94, "\u{5a}\u{331}"), (0x1e95, "\u{7a}\u{331}"), (0x1e96, "\u{68}\u{331}"), (0x1e97, "\u{74}\u{308}"), (0x1e98, "\u{77}\u{30a}"), (0x1e99, "\u{79}\u{30a}"), (0x1e9b, "\u{17f}\u{307}"), (0x1ea0, "\u{41}\u{323}"), (0x1ea1, "\u{61}\u{323}"), (0x1ea2, "\u{41}\u{309}"), (0x1ea3, "\u{61}\u{309}"), (0x1ea4, "\u{41}\u{302}\u{301}"), (0x1ea5, "\u{61}\u{302}\u{301}"), (0x1ea6, "\u{41}\u{302}\u{300}"), (0x1ea7, "\u{61}\u{302}\u{300}"), (0x1ea8, "\u{41}\u{302}\u{309}"), (0x1ea9, "\u{61}\u{302}\u{309}"), (0x1eaa, "\u{41}\u{302}\u{303}"), (0x1eab, "\u{61}\u{302}\u{303}"), (0x1eac, "\u{41}\u{323}\u{302}"), (0x1ead, "\u{61}\u{323}\u{302}"), (0x1eae, "\u{41}\u{306}\u{301}"), (0x1eaf, "\u{61}\u{306}\u{301}"), (0x1eb0, "\u{41}\u{306}\u{300}"), (0x1eb1, "\u{61}\u{306}\u{300}"), (0x1eb2, "\u{41}\u{306}\u{309}"), (0x1eb3, "\u{61}\u{306}\u{309}"), (0x1eb4, "\u{41}\u{306}\u{303}"), (0x1eb5, "\u{61}\u{306}\u{303}"), (0x1eb6, "\u{41}\u{323}\u{306}"), (0x1eb7, "\u{61}\u{323}\u{306}"), (0x1eb8, "\u{45}\u{323}"), (0x1eb9, "\u{65}\u{323}"), (0x1eba, "\u{45}\u{309}"), (0x1ebb, "\u{65}\u{309}"), (0x1ebc, "\u{45}\u{303}"), (0x1ebd, "\u{65}\u{303}"), (0x1ebe, "\u{45}\u{302}\u{301}"), (0x1ebf, "\u{65}\u{302}\u{301}"), (0x1ec0, "\u{45}\u{302}\u{300}"), (0x1ec1, "\u{65}\u{302}\u{300}"), (0x1ec2, "\u{45}\u{302}\u{309}"), (0x1ec3, "\u{65}\u{302}\u{309}"), (0x1ec4, "\u{45}\u{302}\u{303}"), (0x1ec5, "\u{65}\u{302}\u{303}"), (0x1ec6, "\u{45}\u{323}\u{302}"), (0x1ec7, "\u{65}\u{323}\u{302}"), (0x1ec8, "\u{49}\u{309}"), (0x1ec9, "\u{69}\u{309}"), (0x1eca, "\u{49}\u{323}"), (0x1ecb, "\u{69}\u{323}"), (0x1ecc, "\u{4f}\u{323}"), (0x1ecd, "\u{6f}\u{323}"), (0x1ece, "\u{4f}\u{309}"), (0x1ecf, "\u{6f}\u{309}"), (0x1ed0, "\u{4f}\u{302}\u{301}"), (0x1ed1, "\u{6f}\u{302}\u{301}"), (0x1ed2, "\u{4f}\u{302}\u{300}"), (0x1ed3, "\u{6f}\u{302}\u{300}"), (0x1ed4, "\u{4f}\u{302}\u{309}"), (0x1ed5, "\u{6f}\u{302}\u{309}"), (0x1ed6, "\u{4f}\u{302}\u{303}"), (0x1ed7, "\u{6f}\u{302}\u{303}"), (0x1ed8, "\u{4f}\u{323}\u{302}"), (0x1ed9, "\u{6f}\u{323}\u{302}"), (0x1eda, "\u{4f}\u{31b}\u{301}"), (0x1edb, "\u{6f}\u{31b}\u{301}"), (0x1edc, "\u{4f}\u{31b}\u{300}"), (0x1edd, "\u{6f}\u{31b}\u{300}"), (0x1ede, "\u{4f}\u{31b}\u{309}"), (0x1edf, "\u{6f}\u{31b}\u{309}"), (0x1ee0, "\u{4f}\u{31b}\u{303}"), (0x1ee1, "\u{6f}\u{31b}\u{303}"), (0x1ee2, "\u{4f}\u{31b}\u{323}"), (0x1ee3, "\u{6f}\u{31b}\u{323}"), (0x1ee4, "\u{55}\u{323}"), (0x1ee5, "\u{75}\u{323}"), (0x1ee6, "\u{55}\u{309}"), (0x1ee7, "\u{75}\u{309}"), (0x1ee8, "\u{55}\u{31b}\u{301}"), (0x1ee9, "\u{75}\u{31b}\u{301}"), (0x1eea, "\u{55}\u{31b}\u{300}"), (0x1eeb, "\u{75}\u{31b}\u{300}"), (0x1eec, "\u{55}\u{31b}\u{309}"), (0x1eed, "\u{75}\u{31b}\u{309}"), (0x1eee, "\u{55}\u{31b}\u{303}"), (0x1eef, "\u{75}\u{31b}\u{303}"), (0x1ef0, "\u{55}\u{31b}\u{323}"), (0x1ef1, "\u{75}\u{31b}\u{323}"), (0x1ef2, "\u{59}\u{300}"), (0x1ef3, "\u{79}\u{300}"), (0x1ef4, "\u{59}\u{323}"), (0x1ef5, "\u{79}\u{323}"), (0x1ef6, "\u{59}\u{309}"), (0x1ef7, "\u{79}\u{309}"), (0x1ef8, "\u{59}\u{303}"), (0x1ef9, "\u{79}\u{303}")];
fn nfd(s: &str) -> String {
    let mut o = String::new();
    for ch in s.chars() { match NFD.binary_search_by_key(&(ch as u32), |x| x.0) { Ok(i) => o.push_str(NFD[i].1), Err(_) => o.push(ch) } }
    o
}
/// The key two names share when the target cannot keep them apart.
pub fn fold_key(path: &str, p: &Platform) -> String {
    let mut k = path.to_string();
    if p.fold_form { k = nfd(&k); }
    if p.fold_case { k = k.to_lowercase(); }
    k
}

/// One archive entry as the set check sees it: `link` «sym» or «hard» with its target.
pub struct Entry { pub path: String, pub dir: bool, pub link: Option<&'static str>, pub target: String }
#[derive(Debug, Clone, PartialEq)]
pub struct Problem { pub kind: &'static str, pub path: String }

/// The names of a whole archive checked together (desktop/archsafe.cjs checkSet), problems in the order found.
pub fn check_set(entries: &[Entry], p: &Platform, dest_len: usize) -> Vec<Problem> {
    let mut problems = vec![]; let mut by_out: HashMap<String, String> = HashMap::new(); let mut by_key: HashMap<String, String> = HashMap::new();
    let mut dir_keys: HashSet<String> = HashSet::new(); let mut files: Vec<(String, String)> = vec![]; let mut links: HashSet<String> = HashSet::new(); let mut outs: Vec<(String, String)> = vec![];
    for e in entries {
        let r = path_rule(&e.path, p, dest_len);
        if r.action == "refuse" { problems.push(Problem { kind: r.reasons[0], path: e.path.clone() }); continue; }
        outs.push((e.path.clone(), r.out.clone()));
        let parts: Vec<&str> = r.out.split('/').collect();
        for i in 1..parts.len() { dir_keys.insert(fold_key(&parts[..i].join("/"), p)); }
        if e.dir { dir_keys.insert(fold_key(&r.out, p)); continue; }
        if e.link == Some("sym") {
            links.insert(r.out.clone());
            let t = e.target.as_str();
            let mut bad = t.is_empty() || t.starts_with('/') || t.starts_with('\\') || drive(t);
            if !bad { let mut st: Vec<&str> = parts[..parts.len() - 1].to_vec(); for c in t.split(|c| c == '/' || c == '\\') { if c.is_empty() || c == "." { continue; } if c == ".." { if st.pop().is_none() { bad = true; break; } } else { st.push(c); } } }
            if bad { problems.push(Problem { kind: "linkOutside", path: e.path.clone() }); continue; }
        }
        if e.link == Some("hard") && !entries.iter().any(|x| !std::ptr::eq(x, e) && !x.dir && x.path == e.target) { problems.push(Problem { kind: "linkOutside", path: e.path.clone() }); continue; }
        if let Some(prev) = by_out.get(&r.out) { problems.push(Problem { kind: if *prev == e.path { "duplicate" } else { "rewriteClash" }, path: e.path.clone() }); continue; }
        let k = fold_key(&r.out, p);
        if by_key.contains_key(&k) { problems.push(Problem { kind: "caseClash", path: e.path.clone() }); continue; }
        by_out.insert(r.out.clone(), e.path.clone()); by_key.insert(k.clone(), e.path.clone()); if e.link.is_none() { files.push((k, e.path.clone())); }
    }
    for (k, path) in &files { if dir_keys.contains(k) { problems.push(Problem { kind: "fileDir", path: path.clone() }); } }
    for (path, out) in &outs { let parts: Vec<&str> = out.split('/').collect(); for i in 1..parts.len() { if links.contains(&parts[..i].join("/")) { problems.push(Problem { kind: "throughLink", path: path.clone() }); break; } } }
    problems
}

/// CRC-32 (the ZIP one), continuing `prev`.
pub fn crc32(data: &[u8], prev: u32) -> u32 {
    let mut c = !prev;
    for &b in data { c ^= b as u32; for _ in 0..8 { c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 }; } }
    !c
}

#[cfg(test)]
mod tests {
    use super::*;
    fn un(s: &str) -> String {
        let mut o = String::new(); let c: Vec<char> = s.chars().collect(); let mut i = 0;
        while i < c.len() {
            if c[i] == '\\' && i + 1 < c.len() && c[i + 1] == '\\' { o.push('\\'); i += 2; continue; }
            if c[i] == '\\' && i + 2 < c.len() && c[i + 1] == 'u' && c[i + 2] == '{' { let e = (i..c.len()).find(|&j| c[j] == '}').unwrap(); let h: String = c[i + 3..e].iter().collect(); o.push(char::from_u32(u32::from_str_radix(&h, 16).unwrap()).unwrap()); i = e + 1; continue; }
            o.push(c[i]); i += 1;
        }
        o
    }
    #[test]
    fn the_shared_vectors() {
        let text = include_str!("../../../tests/data/namesafe-vectors.tsv");
        let (mut n, mut bad) = (0, 0);
        for line in text.lines() {
            if line.is_empty() || line.starts_with('#') { continue; }
            let f: Vec<&str> = line.split('\t').collect(); let p = platform(f[1]).expect("platform"); n += 1;
            let got: Vec<String> = if f[0] == "set" {
                let es: Vec<Entry> = un(f[2]).split(" | ").filter(|x| !x.is_empty()).map(|x| { let (t, r) = (&x[..1], x[2..].to_string()); match t { "d" => Entry { path: r, dir: true, link: None, target: String::new() }, "s" | "h" => { let mut it = r.splitn(2, '>'); let pa = it.next().unwrap().to_string(); let tg = it.next().unwrap_or("").to_string(); Entry { path: pa, dir: false, link: Some(if t == "s" { "sym" } else { "hard" }), target: tg } } _ => Entry { path: r, dir: false, link: None, target: String::new() } } }).collect();
                let mut ps: Vec<String> = check_set(&es, p, 0).iter().map(|x| format!("{}:{}", x.kind, x.path)).collect(); ps.sort();
                vec![if ps.is_empty() { "-".into() } else { ps.join(",") }, "-".into(), "-".into(), "-".into()]
            } else {
                let r = if f[0] == "name" { name_rule(&un(f[2]), p) } else { path_rule(&un(f[2]), p, 0) };
                vec![r.action.to_string(), if r.action == "refuse" { "-".into() } else { r.out.clone() }, if r.reasons.is_empty() { "-".into() } else { r.reasons.join(",") }, if r.flags.is_empty() { "-".into() } else { r.flags.join(",") }]
            };
            let want = vec![if f[0] == "set" { un(f[3]) } else { f[3].to_string() }, un(f[4]), f[5].to_string(), f[6].to_string()];
            if got != want { bad += 1; eprintln!("MISMATCH {} {} {:?}\n  want {:?}\n  got  {:?}", f[0], f[1], f[2], want, got); }
        }
        assert!(n > 100, "vectors read: {}", n);
        assert_eq!(bad, 0, "{} of {} vectors differ", bad, n);
    }
    #[test]
    fn crc() { assert_eq!(crc32(b"123456789", 0), 0xcbf4_3926); assert_eq!(crc32(b"6789", crc32(b"12345", 0)), 0xcbf4_3926); }
}
