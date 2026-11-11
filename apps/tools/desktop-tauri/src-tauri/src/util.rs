// Small pure helpers of the Tauri shell (std only, no tauri): the names Node gives the OS and the CPU, base64,
// hex, the version order of desktop/main.cjs, a file:// address to a path, which release asset is this OS's.
// Kept free of crates so it can be checked alone: `rustc --edition 2021 --test util.rs`.

/// The OS as Electron's `process.platform` names it.
pub fn node_platform() -> &'static str {
    platform_name(std::env::consts::OS)
}

/// The CPU as Electron's `process.arch` names it.
pub fn node_arch() -> &'static str {
    arch_name(std::env::consts::ARCH)
}

pub fn platform_name(os: &str) -> &'static str {
    match os {
        "windows" => "win32",
        "macos" => "darwin",
        "linux" => "linux",
        "freebsd" => "freebsd",
        "openbsd" => "openbsd",
        _ => "linux",
    }
}

pub fn arch_name(arch: &str) -> &'static str {
    match arch {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        "arm" => "arm",
        _ => "x64",
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding (what Node's `buf.toString('base64')` writes).
pub fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= data.len() {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8) | (data[i + 2] as u32);
        out.push(B64[((n >> 18) & 63) as usize] as char);
        out.push(B64[((n >> 12) & 63) as usize] as char);
        out.push(B64[((n >> 6) & 63) as usize] as char);
        out.push(B64[(n & 63) as usize] as char);
        i += 3;
    }
    let rest = data.len() - i;
    if rest == 1 {
        let n = (data[i] as u32) << 16;
        out.push(B64[((n >> 18) & 63) as usize] as char);
        out.push(B64[((n >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rest == 2 {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8);
        out.push(B64[((n >> 18) & 63) as usize] as char);
        out.push(B64[((n >> 12) & 63) as usize] as char);
        out.push(B64[((n >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}

fn b64_value(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a') as u32 + 26),
        b'0'..=b'9' => Some((c - b'0') as u32 + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

/// Lenient base64 decoding, as Node's `Buffer.from(s, 'base64')`: url-safe letters accepted, whitespace, padding
/// and any other stray character skipped, a dangling last character dropped.
pub fn b64_decode(text: &str) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(text.len() / 4 * 3 + 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for c in text.bytes() {
        if c == b'=' {
            break;
        }
        let v = match b64_value(c) {
            Some(v) => v,
            None => continue,
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    out
}

/// Lowercase hex of bytes.
pub fn hex(data: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(data.len() * 2);
    for b in data {
        s.push(H[(b >> 4) as usize] as char);
        s.push(H[(b & 15) as usize] as char);
    }
    s
}

/// desktop/main.cjs's `cmp`: the first three dot-separated numbers compared (a part that is not a number counts 0).
pub fn cmp_versions(a: &str, b: &str) -> i64 {
    let pa: Vec<i64> = a.split('.').map(part_number).collect();
    let pb: Vec<i64> = b.split('.').map(part_number).collect();
    for i in 0..3 {
        let x = if i < pa.len() { pa[i] } else { 0 };
        let y = if i < pb.len() { pb[i] } else { 0 };
        if x != y {
            return x - y;
        }
    }
    0
}

fn part_number(s: &str) -> i64 {
    let t = s.trim();
    if t.is_empty() {
        return 0;
    }
    t.parse::<i64>().unwrap_or(0)
}

/// `decodeURIComponent`: None where it would throw (a bad escape, or bytes that are not UTF-8).
pub fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            if i + 2 >= b.len() {
                return None;
            }
            let hi = hex_digit(b[i + 1])?;
            let lo = hex_digit(b[i + 2])?;
            out.push(hi * 16 + lo);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_digit(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// kt:openExternal's file:// case: «file://» (and a third slash) taken off — on Windows all of it, elsewhere
/// leaving one «/» —, then percent-decoded unless that fails. None when it is no file:// address.
pub fn file_url_to_path(s: &str, windows: bool) -> Option<String> {
    let lower = s.to_ascii_lowercase();
    if !lower.starts_with("file://") {
        return None;
    }
    let mut rest = &s[7..];
    if rest.starts_with('/') {
        rest = &rest[1..];
    }
    let raw = if windows {
        rest.to_string()
    } else {
        format!("/{}", rest)
    };
    match percent_decode(&raw) {
        Some(p) => Some(p),
        None => Some(raw),
    }
}

/// kt:checkUpdate's choice of a release asset for this OS (the installer, not the portable build).
pub fn pick_asset<'a>(names: &'a [(String, String)], os: &str) -> Option<&'a str> {
    for (name, url) in names {
        let fits = match os {
            "win32" => name.ends_with("win-x64.exe"),
            "darwin" => name.ends_with(".dmg"),
            _ => name.ends_with(".AppImage"),
        };
        if fits && !name.contains("portable") {
            return Some(url.as_str());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(platform_name("windows"), "win32");
        assert_eq!(platform_name("macos"), "darwin");
        assert_eq!(platform_name("linux"), "linux");
        assert_eq!(arch_name("x86_64"), "x64");
        assert_eq!(arch_name("aarch64"), "arm64");
    }

    #[test]
    fn base64_round_trip() {
        assert_eq!(b64_encode(b""), "");
        assert_eq!(b64_encode(b"f"), "Zg==");
        assert_eq!(b64_encode(b"fo"), "Zm8=");
        assert_eq!(b64_encode(b"foo"), "Zm9v");
        assert_eq!(b64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(b64_decode("Zg=="), b"f".to_vec());
        assert_eq!(b64_decode("Zm8="), b"fo".to_vec());
        assert_eq!(b64_decode("Zm9vYmFy"), b"foobar".to_vec());
        assert_eq!(b64_decode("Zm9v\nYmFy"), b"foobar".to_vec());
        let all: Vec<u8> = (0..=255u8).collect();
        assert_eq!(b64_decode(&b64_encode(&all)), all);
        assert_eq!(b64_decode("-_-_"), b64_decode("+/+/"));
    }

    #[test]
    fn hex_lower() {
        assert_eq!(hex(&[0, 15, 16, 255]), "000f10ff");
    }

    #[test]
    fn versions() {
        assert!(cmp_versions("0.16.28", "0.16.27") > 0);
        assert!(cmp_versions("0.16.27", "0.16.27") == 0);
        assert!(cmp_versions("0.9.0", "0.16.0") < 0);
        assert!(cmp_versions("1.0", "1.0.0") == 0);
        assert!(cmp_versions("1.x.1", "1.0.0") > 0);
    }

    #[test]
    fn decode() {
        assert_eq!(percent_decode("a%20b").as_deref(), Some("a b"));
        assert_eq!(percent_decode("%D8%A3").as_deref(), Some("أ"));
        assert_eq!(percent_decode("100%"), None);
        assert_eq!(percent_decode("%zz"), None);
        assert_eq!(percent_decode("%FF"), None);
    }

    #[test]
    fn file_urls() {
        assert_eq!(
            file_url_to_path("file:///home/a%20b.mkv", false).as_deref(),
            Some("/home/a b.mkv")
        );
        assert_eq!(
            file_url_to_path("file://C:\\x\\y.mkv", true).as_deref(),
            Some("C:\\x\\y.mkv")
        );
        assert_eq!(
            file_url_to_path("FILE:///C:/x/100%.mkv", true).as_deref(),
            Some("C:/x/100%.mkv")
        );
        assert_eq!(file_url_to_path("https://example.org", false), None);
    }

    #[test]
    fn assets() {
        let a = vec![
            (
                "KurokawaTools-1-win-x64-portable.exe".to_string(),
                "p".to_string(),
            ),
            ("KurokawaTools-1-win-x64.exe".to_string(), "w".to_string()),
            (
                "KurokawaTools-1-mac-universal.dmg".to_string(),
                "m".to_string(),
            ),
            (
                "KurokawaTools-1-linux-x86_64.AppImage".to_string(),
                "l".to_string(),
            ),
        ];
        assert_eq!(pick_asset(&a, "win32"), Some("w"));
        assert_eq!(pick_asset(&a, "darwin"), Some("m"));
        assert_eq!(pick_asset(&a, "linux"), Some("l"));
        assert_eq!(pick_asset(&a[..1], "win32"), None);
    }
}
