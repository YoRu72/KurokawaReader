// The Files page's storages on a computer (the Tauri shell's filesRoots, the phone plugin's shape): the home folder,
// Downloads, Desktop and Documents where they exist, then the disks — Linux's mounted ones (from /proc/self/mounts:
// the root, and what is mounted under /media, /run/media, /mnt; never the system's pseudo file systems, /boot or the
// snaps), a Mac's /Volumes, Windows' drive letters. Plain data in, plain data out: the shell reads the mount table,
// the volume names, the drive mask and the free space and hands them here. Std only, checked alone:
// `rustc --edition 2021 --test places.rs`.
use std::path::{Path, PathBuf};

/// One storage as the page takes it: kind (home | downloads | desktop | documents | drive), its path, a name (the
/// page names the first four in its own language, by kind; a drive's is its own).
#[derive(Clone, Debug, PartialEq)]
pub struct Place {
    pub kind: &'static str,
    pub path: PathBuf,
    pub name: String,
}

/// The mount table's escapes undone («\040» a space, «\011» a tab, «\134» a backslash …).
pub fn unescape_mount(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 3 < b.len() && b[i + 1..i + 4].iter().all(|c| (b'0'..=b'7').contains(c)) {
            let v = (b[i + 1] - b'0') as u32 * 64 + (b[i + 2] - b'0') as u32 * 8 + (b[i + 3] - b'0') as u32;
            if v < 256 {
                out.push(v as u8);
                i += 4;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// File systems that hold no one's files (the kernel's own, the containers' layers …).
const PSEUDO: &[&str] = &[
    "proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "securityfs", "cgroup", "cgroup2", "pstore", "bpf", "debugfs", "tracefs",
    "configfs", "fusectl", "mqueue", "hugetlbfs", "autofs", "binfmt_misc", "rpc_pipefs", "nsfs", "efivarfs", "squashfs",
    "overlay", "ramfs", "fuse.gvfsd-fuse", "fuse.portal", "fuse.snapfuse", "selinuxfs", "nfsd", "tracefs", "devfs",
];

/// The disks of Linux's mount table (/proc/self/mounts' text) worth showing: the root «/» and what is mounted under
/// /media, /run/media or /mnt — real file systems only, each once, in the table's order.
pub fn linux_mounts(table: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for line in table.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 3 {
            continue;
        }
        let (dev, at, fs) = (f[0], unescape_mount(f[1]), f[2]);
        if PSEUDO.contains(&fs) || fs.starts_with("cgroup") {
            continue;
        }
        let wanted = at == "/"
            || ["/media/", "/run/media/", "/mnt/"].iter().any(|p| at.starts_with(p) && at.len() > p.len());
        if !wanted {
            continue;
        }
        // (A disk, a network share or a FUSE mount the user made — not «none» or «systemd-1».)
        let real = dev.starts_with('/') || dev.contains(':') || dev.starts_with("//") || fs.starts_with("fuse") || fs == "zfs" || fs == "btrfs";
        if !real {
            continue;
        }
        let p = PathBuf::from(&at);
        if !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

/// The disks of a Mac's /Volumes (the names in it): each but the start-up disk's own link, which is «/».
pub fn mac_volumes(names: &[String], links_to_root: &[String]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = vec![PathBuf::from("/")];
    for n in names {
        if n.starts_with('.') || links_to_root.contains(n) {
            continue;
        }
        out.push(Path::new("/Volumes").join(n));
    }
    out
}

/// Windows' drive letters from GetLogicalDrives' mask: «C:\», «D:\» …
pub fn windows_drives(mask: u32) -> Vec<PathBuf> {
    (0..26u32).filter(|i| mask & (1 << i) != 0).map(|i| PathBuf::from(format!("{}:\\", (b'A' + i as u8) as char))).collect()
}

/// A disk's name: its last part, «/» for the root, «C:» for a drive.
pub fn disk_name(p: &Path) -> String {
    let s = p.to_string_lossy();
    if s == "/" {
        return "/".to_string();
    }
    let t = s.trim_end_matches(['\\', '/']);
    if t.len() == 2 && t.ends_with(':') {
        return t.to_string();
    }
    match t.rsplit(['/', '\\']).next() {
        Some(x) if !x.is_empty() => x.to_string(),
        _ => s.into_owned(),
    }
}

/// The storages in the page's order: home, Downloads, Desktop, Documents (those given — the caller passes only
/// folders that exist), then the disks; a path never twice (letter case aside on Windows), a disk that is the home
/// folder itself left out.
pub fn places(home: Option<PathBuf>, downloads: Option<PathBuf>, desktop: Option<PathBuf>, documents: Option<PathBuf>, disks: &[PathBuf], fold_case: bool) -> Vec<Place> {
    let key = |p: &Path| -> String {
        let s = p.to_string_lossy().replace('\\', "/");
        let s = if s.len() > 1 { s.trim_end_matches('/').to_string() } else { s };
        if fold_case { s.to_lowercase() } else { s }
    };
    let mut out: Vec<Place> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut add = |kind: &'static str, p: Option<PathBuf>, out: &mut Vec<Place>| {
        if let Some(p) = p {
            let k = key(&p);
            if k.is_empty() || seen.contains(&k) {
                return;
            }
            seen.push(k);
            let name = disk_name(&p);
            out.push(Place { kind, path: p, name });
        }
    };
    add("home", home, &mut out);
    add("downloads", downloads, &mut out);
    add("desktop", desktop, &mut out);
    add("documents", documents, &mut out);
    for d in disks {
        add("drive", Some(d.clone()), &mut out);
    }
    out
}

/// The shallow facts of one path (filesStat with no counting): (exists, dir, size, mtime ms, writable, hidden).
pub fn stat(p: &Path) -> (bool, bool, u64, u64, bool, bool) {
    let m = match std::fs::metadata(p) {
        Ok(m) => m,
        Err(_) => return (false, false, 0, 0, false, false),
    };
    let mtime = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
    let hidden = p.file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(false);
    let size = if m.is_dir() { 0 } else { m.len() };
    (true, m.is_dir(), size, mtime, writable(p, m.is_dir(), m.permissions().readonly()), hidden)
}

/// Whether new files can be made in a folder, or a file written — read from its rights, nothing written (the page asks
/// it of every folder it opens): on the Unixes the owner's, group's or others' write bit as this process is one of
/// them (root: always); on Windows the read-only mark of a file (a folder's is no answer there: taken as writable).
pub fn writable(p: &Path, dir: bool, readonly: bool) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        extern "C" {
            fn geteuid() -> u32;
            fn getegid() -> u32;
        }
        let _ = (dir, readonly);
        let m = match std::fs::metadata(p) {
            Ok(m) => m,
            Err(_) => return false,
        };
        let (uid, gid) = unsafe { (geteuid(), getegid()) };
        if uid == 0 {
            return true;
        }
        let mode = m.mode();
        if m.uid() == uid {
            mode & 0o200 != 0
        } else if m.gid() == gid {
            mode & 0o020 != 0
        } else {
            mode & 0o002 != 0
        }
    }
    #[cfg(not(unix))]
    {
        let _ = p;
        dir || !readonly
    }
}

/// A new folder's name checked: not empty, no separators, not «.» or «..», no NUL; on Windows none of «<>:"|?*».
pub fn good_name(name: &str, windows: bool) -> bool {
    !(name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\u{0}')
        || (windows && name.chars().any(|c| "<>:\"|?*".contains(c))))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    extern "C" {
        #[link_name = "geteuid"]
        fn geteuid_for_test() -> u32;
    }

    #[test]
    fn mounts() {
        let t = "sysfs /sys sysfs rw 0 0\nproc /proc proc rw 0 0\n/dev/nvme0n1p2 / ext4 rw 0 0\n/dev/nvme0n1p1 /boot/efi vfat rw 0 0\ntmpfs /run tmpfs rw 0 0\n/dev/sdb1 /media/u/My\\040Disk vfat rw 0 0\n/dev/sdc1 /run/media/u/USB exfat rw 0 0\nserver:/x /mnt/nas nfs4 rw 0 0\n/dev/loop3 /snap/core/1 squashfs ro 0 0\noverlay /var/lib/docker/x overlay rw 0 0\n/dev/nvme0n1p2 / ext4 rw 0 0\nsystemd-1 /mnt/auto autofs rw 0 0\ngvfsd-fuse /run/user/1000/gvfs fuse.gvfsd-fuse rw 0 0\n/dev/sdd1 /mnt ext4 rw 0 0\n";
        let m = linux_mounts(t);
        assert_eq!(m, vec![PathBuf::from("/"), PathBuf::from("/media/u/My Disk"), PathBuf::from("/run/media/u/USB"), PathBuf::from("/mnt/nas")]);
        assert_eq!(unescape_mount("a\\040b\\134c\\011"), "a b\\c\t");
        assert_eq!(unescape_mount("plain\\"), "plain\\");
        assert_eq!(unescape_mount("\\04"), "\\04");
    }

    #[test]
    fn macs_and_windows() {
        let v = mac_volumes(&["Macintosh HD".to_string(), "USB".to_string(), ".timemachine".to_string()], &["Macintosh HD".to_string()]);
        assert_eq!(v, vec![PathBuf::from("/"), PathBuf::from("/Volumes/USB")]);
        assert_eq!(windows_drives(0b1100), vec![PathBuf::from("C:\\"), PathBuf::from("D:\\")]);
        assert_eq!(windows_drives(1 << 25), vec![PathBuf::from("Z:\\")]);
        assert_eq!(disk_name(Path::new("C:\\")), "C:");
        assert_eq!(disk_name(Path::new("/")), "/");
        assert_eq!(disk_name(Path::new("/media/u/My Disk")), "My Disk");
    }

    #[test]
    fn the_order() {
        let p = places(Some("/home/u".into()), Some("/home/u/Downloads".into()), None, Some("/home/u/Documents".into()), &["/".into(), "/home/u/".into(), "/media/u/X".into()], false);
        let k: Vec<(&str, String)> = p.iter().map(|x| (x.kind, x.path.to_string_lossy().into_owned())).collect();
        assert_eq!(k, vec![("home", "/home/u".into()), ("downloads", "/home/u/Downloads".into()), ("documents", "/home/u/Documents".into()), ("drive", "/".into()), ("drive", "/media/u/X".into())]);
        assert_eq!(p[4].name, "X");
        let w = places(Some("C:\\Users\\u".into()), None, None, None, &["C:\\".into(), "c:\\users\\U".into(), "D:\\".into()], true);
        assert_eq!(w.len(), 3);
        assert_eq!(w[1].name, "C:");
    }

    #[test]
    fn names_and_stat() {
        assert!(good_name("New folder", true) && good_name("a.b", false) && good_name("a:b", false));
        assert!(!good_name("a:b", true) && !good_name("", false) && !good_name("..", false) && !good_name("a/b", false) && !good_name("a\\b", false));
        let d = std::env::temp_dir().join(format!("kt-places-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("f.txt"), b"hello").unwrap();
        let (ex, dir, size, mtime, w, hid) = stat(&d.join("f.txt"));
        assert!(ex && !dir && size == 5 && mtime > 0 && w && !hid);
        let (ex, dir, _, _, w, _) = stat(&d);
        assert!(ex && dir && w);
        assert!(std::fs::read_dir(&d).unwrap().count() == 1, "nothing written to find it out");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let ro = d.join("ro");
            std::fs::create_dir(&ro).unwrap();
            std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o555)).unwrap();
            let root = unsafe { geteuid_for_test() } == 0;
            assert_eq!(stat(&ro).4, root, "a folder without its write bit (root may write anyway)");
            std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert!(!stat(&d.join("none")).0);
        let _ = std::fs::remove_dir_all(&d);
    }
}
