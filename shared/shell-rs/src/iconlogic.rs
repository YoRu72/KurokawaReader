// The user's own app icon — both apps' since Tools' stage P6 (moved here unchanged from the Reader's
// apps/reader/desktop-tauri/src-tauri/src/iconlogic.rs, stage R5; the desktop entry's marker is now the app's to give:
// desktop_override_with / is_ours_with — desktop_override / is_ours keep the Reader's MARK). The rules that need no
// crate — appicon.rs (this crate's) does the rest. A picture is taken
// only as a PNG of sensible size (its signature, its header's dimensions; the full decoding is Tauri's); an .ico is
// made of PNG entries (Windows Vista and later read PNG inside an .ico; the page renders the sizes with its canvas);
// a Linux desktop entry is copied with its icon pointed at the picture and marked as the app's own; the state of the
// Windows shortcuts is a stamp of their paths and times, so a shortcut an update made again is pointed again at the
// next start. Std only, checked alone with `rustc --edition 2021 --test iconlogic.rs`.

/// The largest picture taken (desktop/appicon.cjs: 4 MiB).
pub const MAX_BYTES: usize = 4 << 20;
/// The sizes the page renders for the .ico (each ≤ 256: an .ico's own limit).
pub const ICO_SIZES: [u32; 7] = [16, 24, 32, 48, 64, 128, 256];
/// The marker a desktop entry made by the Reader carries (one the user made is never touched); Tools' is
/// «X-KurokawaTools-CustomIcon=true» (its appicon Spec).
pub const MARK: &str = "X-KurokawaReader-CustomIcon=true";

/// A PNG's width and height from its header (signature, then IHDR first) — None when it is not a PNG.
pub fn png_size(b: &[u8]) -> Option<(u32, u32)> {
    const SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if b.len() < 33 || b[..8] != SIG || &b[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes([b[16], b[17], b[18], b[19]]);
    let h = u32::from_be_bytes([b[20], b[21], b[22], b[23]]);
    if w == 0 || h == 0 {
        return None;
    }
    Some((w, h))
}

/// A picture the app takes as its icon → its dimensions: a PNG, at most MAX_BYTES, 16–4096 pixels a side.
pub fn check_picture(b: &[u8]) -> Result<(u32, u32), String> {
    if b.len() > MAX_BYTES {
        return Err("too large".to_string());
    }
    let (w, h) = png_size(b).ok_or_else(|| "not a PNG".to_string())?;
    if w < 16 || h < 16 || w > 4096 || h > 4096 {
        return Err(format!("a picture of {}×{} cannot be an icon", w, h));
    }
    Ok((w, h))
}

/// `data:image/png;base64,…` → the base64 part (anything else: not a PNG).
pub fn data_url_b64(s: &str) -> Result<&str, String> {
    s.strip_prefix("data:image/png;base64,").filter(|x| !x.is_empty()).ok_or_else(|| "not a PNG".to_string())
}

/// An .ico of PNG entries, each (its size in pixels, its PNG): smallest first; 256 written as 0, as the format asks.
pub fn ico(entries: &[(u32, Vec<u8>)]) -> Vec<u8> {
    let mut list: Vec<&(u32, Vec<u8>)> = entries.iter().filter(|e| e.0 >= 1 && e.0 <= 256).collect();
    list.sort_by_key(|e| e.0);
    list.dedup_by_key(|e| e.0);
    let n = list.len();
    let mut out = Vec::new();
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&(n as u16).to_le_bytes());
    let mut offset = 6 + 16 * n as u32;
    for (size, png) in list.iter().map(|e| (e.0, &e.1)) {
        let s = if size >= 256 { 0u8 } else { size as u8 };
        out.push(s);
        out.push(s);
        out.push(0);
        out.push(0);
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&32u16.to_le_bytes());
        out.extend_from_slice(&(png.len() as u32).to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        offset += png.len() as u32;
    }
    for e in list.iter() {
        out.extend_from_slice(&e.1);
    }
    out
}

/// An .ico's entries read back → (width, height, bytes) each (for the tests and the self-test).
pub fn ico_entries(b: &[u8]) -> Vec<(u32, u32, usize)> {
    if b.len() < 6 || b[0] != 0 || b[1] != 0 || b[2] != 1 {
        return Vec::new();
    }
    let n = u16::from_le_bytes([b[4], b[5]]) as usize;
    let mut out = Vec::new();
    for i in 0..n {
        let o = 6 + 16 * i;
        if o + 16 > b.len() {
            break;
        }
        let w = if b[o] == 0 { 256 } else { b[o] as u32 };
        let h = if b[o + 1] == 0 { 256 } else { b[o + 1] as u32 };
        let len = u32::from_le_bytes([b[o + 8], b[o + 9], b[o + 10], b[o + 11]]) as usize;
        out.push((w, h, len));
    }
    out
}

/// A desktop entry's text with its own icon pointed at `icon` (the [Desktop Entry] group only — an action keeps its
/// own), and the app's marker added: the user's copy that overrides the system's while the custom icon is chosen.
pub fn desktop_override(system: &str, icon: &str) -> String {
    desktop_override_with(system, icon, MARK)
}
/// desktop_override with the app's own marker.
pub fn desktop_override_with(system: &str, icon: &str, mark: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut in_main = false;
    let mut seen_icon = false;
    let mut header_at: Option<usize> = None;
    for line in system.lines() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') {
            if in_main && !seen_icon {
                out.push(format!("Icon={}", icon));
                seen_icon = true;
            }
            in_main = t == "[Desktop Entry]";
            out.push(line.to_string());
            if in_main {
                header_at = Some(out.len());
                out.push(mark.to_string());
            }
            continue;
        }
        if in_main && t == mark {
            continue;
        }
        if in_main && (t.starts_with("Icon=") || t.starts_with("Icon =")) {
            if !seen_icon {
                out.push(format!("Icon={}", icon));
                seen_icon = true;
            }
            continue;
        }
        out.push(line.to_string());
    }
    if header_at.is_none() {
        out.insert(0, mark.to_string());
        out.insert(0, "[Desktop Entry]".to_string());
        in_main = true;
    }
    if in_main && !seen_icon {
        out.push(format!("Icon={}", icon));
    }
    let mut s = out.join("\n");
    s.push('\n');
    s
}

/// Whether a desktop entry is one the app made (its marker in it).
pub fn is_ours(text: &str) -> bool {
    is_ours_with(text, MARK)
}
/// is_ours with the app's own marker.
pub fn is_ours_with(text: &str, mark: &str) -> bool {
    text.lines().any(|l| l.trim() == mark)
}

/// The Windows shortcuts' state: each existing one's path and modification time (seconds), one a line.
pub fn stamp(list: &[(String, u64)]) -> String {
    let mut v: Vec<String> = list.iter().map(|(p, t)| format!("{}\t{}", p, t)).collect();
    v.sort();
    v.join("\n")
}

/// The script that points the app's shortcuts at an icon (PowerShell and Windows' own WScript.Shell, which loads a
/// shortcut and saves it back with its target kept). Paths come in environment variables — KR_LNKS (separated by
/// «|», which no Windows path holds), KR_EXE (only shortcuts to this program are changed), KR_ICON (empty: the
/// program's own icon) — never in the script's text. It writes the shortcuts it changed, separated by «|».
pub const SHORTCUT_PS: &str = r#"$ErrorActionPreference = 'Stop'
$sh = New-Object -ComObject WScript.Shell
$exe = $env:KR_EXE
$icon = $env:KR_ICON
if (-not $icon) { $icon = $exe }
$done = @()
foreach ($p in ($env:KR_LNKS -split '\|')) {
  if (-not $p) { continue }
  if (-not (Test-Path -LiteralPath $p)) { continue }
  try {
    $s = $sh.CreateShortcut($p)
    if ($s.TargetPath -and ($s.TargetPath -ieq $exe)) {
      $s.IconLocation = $icon + ',0'
      $s.Save()
      $done += $p
    }
  } catch { }
}
[Console]::Out.Write(($done -join '|'))
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32, extra: usize) -> Vec<u8> {
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        b.resize(b.len() + extra, 7);
        b
    }

    #[test]
    fn pictures() {
        assert_eq!(png_size(&png(512, 512, 0)), Some((512, 512)));
        assert_eq!(check_picture(&png(512, 512, 10)), Ok((512, 512)));
        assert_eq!(check_picture(b"GIF89a.........................................").unwrap_err(), "not a PNG");
        assert!(check_picture(&png(8, 8, 0)).is_err());
        assert!(check_picture(&png(5000, 512, 0)).is_err());
        assert_eq!(check_picture(&png(512, 512, MAX_BYTES)).unwrap_err(), "too large");
        assert_eq!(png_size(&png(0, 5, 0)), None);
        assert_eq!(data_url_b64("data:image/png;base64,AAA"), Ok("AAA"));
        assert!(data_url_b64("data:image/jpeg;base64,AAA").is_err());
        assert!(data_url_b64("data:image/png;base64,").is_err());
    }

    #[test]
    fn ico_file() {
        let e: Vec<(u32, Vec<u8>)> = vec![(256, png(256, 256, 100)), (16, png(16, 16, 3)), (32, png(32, 32, 5)), (512, png(512, 512, 0)), (16, png(16, 16, 9))];
        let b = ico(&e);
        let list = ico_entries(&b);
        assert_eq!(list, vec![(16, 16, 36), (32, 32, 38), (256, 256, 133)]);
        // (Each entry's offset points at its PNG.)
        let off = |i: usize| u32::from_le_bytes([b[6 + 16 * i + 12], b[6 + 16 * i + 13], b[6 + 16 * i + 14], b[6 + 16 * i + 15]]) as usize;
        assert_eq!(off(0), 6 + 16 * 3);
        assert_eq!(png_size(&b[off(2)..]), Some((256, 256)));
        assert_eq!(b.len(), off(2) + 133);
        assert_eq!(&b[0..6], &[0, 0, 1, 0, 3, 0]);
        assert!(ico_entries(b"nope").is_empty());
    }

    #[test]
    fn desktop_entry() {
        let sys = "[Desktop Entry]\nCategories=Office;\nExec=KurokawaReader %F\nIcon=KurokawaReader\nName=KurokawaReader\nType=Application\n\n[Desktop Action New]\nIcon=other\nName=New\n";
        let o = desktop_override(sys, "/home/u/.config/app.kurokawa.reader/custom-icon.png");
        assert!(is_ours(&o) && !is_ours(sys));
        assert!(o.contains("Icon=/home/u/.config/app.kurokawa.reader/custom-icon.png\n"));
        assert!(o.contains("Exec=KurokawaReader %F\n"));
        assert!(o.contains("[Desktop Action New]\nIcon=other\n"), "{}", o);
        assert_eq!(o.lines().filter(|l| l.starts_with("Icon=")).count(), 2);
        assert!(o.starts_with("[Desktop Entry]\nX-KurokawaReader-CustomIcon=true\n"));
        // (Made again from its own copy: the same.)
        assert_eq!(desktop_override(&o, "/home/u/.config/app.kurokawa.reader/custom-icon.png"), o);
        // (No Icon line, no group: both put in.)
        let o2 = desktop_override("[Desktop Entry]\nName=X\n[Other]\nA=1", "/i.png");
        assert_eq!(o2, "[Desktop Entry]\nX-KurokawaReader-CustomIcon=true\nName=X\nIcon=/i.png\n[Other]\nA=1\n");
        let o3 = desktop_override("Name=X", "/i.png");
        assert!(o3.starts_with("[Desktop Entry]\nX-KurokawaReader-CustomIcon=true\nName=X\nIcon=/i.png"), "{}", o3);
    }

    #[test]
    fn shortcuts_state() {
        assert_eq!(stamp(&[("b".to_string(), 2), ("a".to_string(), 1)]), "a\t1\nb\t2");
        assert_ne!(stamp(&[("a".to_string(), 1)]), stamp(&[("a".to_string(), 3)]));
        assert!(SHORTCUT_PS.contains("$env:KR_LNKS") && !SHORTCUT_PS.contains("KR_PASSWORD"));
    }

    #[test]
    fn another_apps_marker() {
        let sys = "[Desktop Entry]\nName=Kurokawa Tools\nIcon=kurokawa-tools\n";
        let m = "X-KurokawaTools-CustomIcon=true";
        let o = desktop_override_with(sys, "/i.png", m);
        assert_eq!(o, "[Desktop Entry]\nX-KurokawaTools-CustomIcon=true\nName=Kurokawa Tools\nIcon=/i.png\n");
        assert!(is_ours_with(&o, m) && !is_ours(&o), "the Reader's marker is not Tools'");
        assert_eq!(desktop_override_with(&o, "/i.png", m), o);
        assert_eq!(desktop_override(sys, "/i.png"), desktop_override_with(sys, "/i.png", MARK));
    }
}
