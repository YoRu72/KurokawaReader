//! Folding a name for matching, done once when a name enters the index and once per query term: Unicode lower case
//! (std's full mapping), then the marks that sit on a letter are dropped so a name matches whether it is stored
//! composed or decomposed (macOS hands names back decomposed) and whether it is vowelled or not:
//! - combining marks (U+0300–036F and the other combining blocks) are dropped; a Latin letter that carries one in a
//!   single code point (é, ñ, ş, ā …, Latin-1 and Latin Extended-A) becomes its base letter, so «Café» = «cafe» = «café»;
//! - Arabic: the harakat, tanwin, shadda, sukun, the dagger alef, the Quranic marks and the tatweel are dropped; the
//!   alef with hamza or madda (أ إ آ ٱ) is a bare alef, ؤ is و and ئ is ي — the same as their decomposed forms with the
//!   hamza mark dropped — so «كِتَاب» = «كتاب» and «أحمد» = «احمد»; ة, ه, ى and ي stay distinct;
//! - Japanese: a kana followed by the combining (semi-)voiced mark is composed (か + ゙ = が), so a decomposed name
//!   matches what is typed; the marks are not dropped (が and か stay distinct);
//! - full-width ASCII (ＡＢＣ１２３) is plain ASCII.
//! Pure, std only. Not a normaliser: what is not listed here is compared as it is (documented in the module).

/// The folded form of `s`. Plain lower-case ASCII comes back unchanged (callers keep one copy then).
pub fn fold(s: &str) -> String {
    if s.bytes().all(|b| b < 0x80) {
        return s.to_ascii_lowercase();
    }
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii() {
            out.push(c.to_ascii_lowercase());
            continue;
        }
        for l in c.to_lowercase() {
            push_folded(&mut out, l);
        }
    }
    out
}

fn push_folded(out: &mut String, c: char) {
    let u = c as u32;
    if is_dropped_mark(u) {
        return;
    }
    // Kana + combining voiced / semi-voiced mark → the precomposed kana.
    if u == 0x3099 || u == 0x309A {
        if let Some(prev) = out.chars().next_back() {
            if let Some(v) = compose_kana(prev as u32, u == 0x309A) {
                out.pop();
                out.push(char::from_u32(v).unwrap_or(prev));
                return;
            }
        }
        out.push(c);
        return;
    }
    // Full-width ASCII → ASCII (lower case already applied to Ａ–Ｚ by to_lowercase: ａ–ｚ).
    if (0xFF01..=0xFF5E).contains(&u) {
        let a = (u - 0xFF01 + 0x21) as u8;
        out.push((a as char).to_ascii_lowercase());
        return;
    }
    if let Some(b) = latin_base(u) {
        out.push(b);
        return;
    }
    let mapped = match u {
        0x0622 | 0x0623 | 0x0625 | 0x0671 => 0x0627, // آ أ إ ٱ → ا
        0x0624 => 0x0648,                            // ؤ → و
        0x0626 => 0x064A,                            // ئ → ي
        _ => u,
    };
    out.push(char::from_u32(mapped).unwrap_or(c));
}

/// The marks dropped: combining diacritics (generic blocks) and the Arabic vowel signs, Quranic marks and tatweel.
fn is_dropped_mark(u: u32) -> bool {
    matches!(u,
        0x0300..=0x036F | 0x0483..=0x0489 | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F
        | 0x0610..=0x061A | 0x0640 | 0x064B..=0x065F | 0x0670 | 0x06D6..=0x06DC | 0x06DF..=0x06E4 | 0x06E7 | 0x06E8
        | 0x06EA..=0x06ED | 0x08D3..=0x08E1 | 0x08E3..=0x08FF)
}

/// か + ゙ → が; は + ゚ → ぱ (hiragana and katakana); う/ウ + ゙ → ゔ/ヴ.
fn compose_kana(prev: u32, semi: bool) -> Option<u32> {
    let base = |p: u32| -> Option<u32> {
        // hiragana offsets from U+3040; katakana is +0x60.
        let (h, kata) = if (0x3041..=0x3096).contains(&p) { (p, false) } else if (0x30A1..=0x30F6).contains(&p) { (p - 0x60, true) } else { return None };
        let r = if semi {
            if matches!(h, 0x306F | 0x3072 | 0x3075 | 0x3078 | 0x307B) { Some(h + 2) } else { None }
        } else if matches!(h, 0x304B | 0x304D | 0x304F | 0x3051 | 0x3053 | 0x3055 | 0x3057 | 0x3059 | 0x305B | 0x305D
            | 0x305F | 0x3061 | 0x3064 | 0x3066 | 0x3068 | 0x306F | 0x3072 | 0x3075 | 0x3078 | 0x307B) {
            Some(h + 1)
        } else if h == 0x3046 {
            Some(0x3094)
        } else {
            None
        };
        r.map(|v| if kata { v + 0x60 } else { v })
    };
    base(prev)
}

/// A lower-case Latin letter with a mark in one code point → its base letter (Latin-1 Supplement, Latin Extended-A).
fn latin_base(u: u32) -> Option<char> {
    let c = match u {
        0xE0..=0xE5 => 'a',
        0xE7 => 'c',
        0xE8..=0xEB => 'e',
        0xEC..=0xEF => 'i',
        0xF1 => 'n',
        0xF2..=0xF6 => 'o',
        0xF9..=0xFC => 'u',
        0xFD | 0xFF => 'y',
        0x100..=0x105 => 'a',
        0x106..=0x10D => 'c',
        0x10E | 0x10F => 'd',
        0x112..=0x11B => 'e',
        0x11C..=0x123 => 'g',
        0x124 | 0x125 => 'h',
        0x128..=0x12F => 'i',
        0x134 | 0x135 => 'j',
        0x136 | 0x137 => 'k',
        0x139..=0x13E => 'l',
        0x143..=0x148 => 'n',
        0x14C..=0x151 => 'o',
        0x154..=0x159 => 'r',
        0x15A..=0x161 => 's',
        0x162..=0x165 => 't',
        0x168..=0x173 => 'u',
        0x174 | 0x175 => 'w',
        0x176 | 0x177 => 'y',
        0x179..=0x17E => 'z',
        _ => return None,
    };
    Some(c)
}

/// What a file is, from its extension (folded, without the dot). Folders are `Kind::Folder` from their type.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Kind {
    Other = 0,
    Folder = 1,
    Video = 2,
    Audio = 3,
    Picture = 4,
    Document = 5,
    Archive = 6,
}

impl Kind {
    pub fn from_u8(v: u8) -> Kind {
        match v {
            1 => Kind::Folder,
            2 => Kind::Video,
            3 => Kind::Audio,
            4 => Kind::Picture,
            5 => Kind::Document,
            6 => Kind::Archive,
            _ => Kind::Other,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Kind::Other => "other",
            Kind::Folder => "folder",
            Kind::Video => "video",
            Kind::Audio => "audio",
            Kind::Picture => "picture",
            Kind::Document => "document",
            Kind::Archive => "archive",
        }
    }
    pub fn parse(s: &str) -> Option<Kind> {
        Some(match s {
            "other" => Kind::Other,
            "folder" => Kind::Folder,
            "video" => Kind::Video,
            "audio" => Kind::Audio,
            "picture" => Kind::Picture,
            "document" => Kind::Document,
            "archive" => Kind::Archive,
            _ => return None,
        })
    }
}

/// The extension of a folded name (after the last dot; none for «.bashrc» or a name ending in a dot).
pub fn ext_of(folded: &str) -> &str {
    match folded.rfind('.') {
        Some(0) | None => "",
        Some(i) => &folded[i + 1..],
    }
}

pub fn kind_of_ext(ext: &str) -> Kind {
    match ext {
        "mp4" | "mkv" | "webm" | "avi" | "mov" | "wmv" | "flv" | "m4v" | "mpg" | "mpeg" | "ts" | "mts" | "m2ts" | "3gp"
        | "ogv" | "vob" | "rmvb" | "f4v" => Kind::Video,
        "mp3" | "flac" | "wav" | "ogg" | "opus" | "m4a" | "aac" | "wma" | "alac" | "aiff" | "aif" | "ape" | "mka"
        | "mid" | "midi" => Kind::Audio,
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "heic" | "heif" | "avif" | "svg" | "ico"
        | "jxl" | "raw" | "cr2" | "nef" | "arw" | "dng" | "psd" => Kind::Picture,
        "pdf" | "doc" | "docx" | "odt" | "rtf" | "txt" | "md" | "epub" | "mobi" | "azw3" | "fb2" | "djvu" | "xls"
        | "xlsx" | "ods" | "csv" | "ppt" | "pptx" | "odp" | "cbz" | "cbr" | "ass" | "srt" | "vtt" | "html" | "htm" => {
            Kind::Document
        }
        "zip" | "rar" | "7z" | "tar" | "gz" | "tgz" | "bz2" | "xz" | "zst" | "lz" | "lzma" | "cab" | "iso" | "z" => {
            Kind::Archive
        }
        _ => Kind::Other,
    }
}
