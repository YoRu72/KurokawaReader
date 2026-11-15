// Android stage M5: the network storages' rules that need no network — native/android/KtRemote.java's paths (one
// spelling for every server), SMB's share and path, WebDAV's URL encoding, its base URL (Nextcloud's files root), a
// PROPFIND answer's hrefs made paths and its «collection» test, when a failed call is tried again on a new
// connection, an upload's order (folders first made, then each file to its remote place), a download's local names, the
// cache's «already here» rule. Java keeps every socket, every library (commons-net, JSch, smbj), the Keystore and ALL
// secret handling — the «Authorization» header is built in Java and no password, key or token ever crosses into Rust.
// Std only, alone: `rustc --edition 2021 --test remoterules.rs`.

/// KtRemote.norm: «/» for nothing, «\» as «/», a leading «/», no trailing «/» (but the root).
pub fn norm(p: &str) -> String {
    if p.is_empty() {
        return "/".to_string();
    }
    let mut p = p.replace('\\', "/");
    if !p.starts_with('/') {
        p.insert(0, '/');
    }
    if p.len() > 1 && p.ends_with('/') {
        p.pop();
    }
    p
}

/// KtRemote.join.
pub fn join(dir: &str, name: &str) -> String {
    let d = norm(dir);
    if d == "/" {
        format!("/{}", name)
    } else {
        format!("{}/{}", d, name)
    }
}

/// Smb.split: the share, and the path inside it with «\».
pub fn smb_split(path: &str) -> (String, String) {
    let p = norm(path);
    let rest = &p[1..];
    match rest.find('/') {
        Some(i) => (rest[..i].to_string(), rest[i + 1..].replace('/', "\\")),
        None => (rest.to_string(), String::new()),
    }
}

/// java.net.URLEncoder.encode(s, "UTF-8"): letters, digits and «.-*_» kept, a space «+», the rest %XX of UTF-8.
pub fn url_encode(s: &str) -> String {
    let mut o = String::with_capacity(s.len() * 3);
    for &b in s.as_bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'.' | b'-' | b'*' | b'_' => o.push(b as char),
            b' ' => o.push('+'),
            _ => o.push_str(&format!("%{:02X}", b)),
        }
    }
    o
}

/// java.net.URLDecoder.decode(s, "UTF-8"): «+» a space, %XX bytes (an incomplete or bad escape is an error, as Java
/// throws); bytes that are no UTF-8 become U+FFFD, as Java's decoder replaces them.
pub fn url_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' => {
                if i + 2 >= b.len() {
                    return Err("URLDecoder: incomplete trailing escape (%) pattern".into());
                }
                // (Integer.parseInt(…, 16) as Java: a «+» sign taken, a «-» one makes it negative — refused)
                match std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|x| u8::from_str_radix(x, 16).ok()) {
                    Some(v) => out.push(v),
                    None => return Err("URLDecoder: Illegal hex characters in escape (%) pattern".into()),
                }
                i += 3;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// Dav.req's path in the URL: the path encoded, «/» kept, a space «%20».
pub fn dav_path(path: &str) -> String {
    url_encode(&norm(path)).replace("%2F", "/").replace('+', "%20")
}

/// KtRemote.enc: URLEncoder with «%20» for a space.
pub fn enc(s: &str) -> String {
    url_encode(s).replace('+', "%20")
}

/// Dav's base URL: https:// when no scheme, no trailing «/», and for Nextcloud its files root for the user (the user's
/// NAME only — never the password).
pub fn dav_base(host: &str, kind: &str, user: &str) -> String {
    let mut u = host.to_string();
    if !u.starts_with("http://") && !u.starts_with("https://") {
        u = format!("https://{}", u);
    }
    if u.ends_with('/') {
        u.pop();
    }
    if kind == "nextcloud" && !u.contains("/remote.php/") {
        u = format!("{}/remote.php/dav/files/{}", u, enc(user));
    }
    u
}

/// A PROPFIND href as a path: the scheme and host dropped, decoded, the base's path taken off, normalised.
pub fn href_path(href: &str, base_path: &str) -> Result<String, String> {
    let mut h = href;
    for sch in ["http://", "https://"] {
        if let Some(rest) = h.strip_prefix(sch) {
            if let Some(i) = rest.find('/') {
                if i > 0 {
                    h = &rest[i..];
                }
            } else if !rest.is_empty() {
                h = "";
            }
            break;
        }
    }
    let mut p = url_decode(h)?;
    if !base_path.is_empty() && p.starts_with(base_path) {
        p = p[base_path.len()..].to_string();
    }
    Ok(norm(&p))
}

/// Dav.list's test of a response for a folder.
pub fn is_collection(r: &str) -> bool {
    if r.contains("<d:collection") || r.contains("<D:collection") {
        return true;
    }
    let b = r.as_bytes();
    let mut i = 0;
    while let Some(k) = r[i..].find('<') {
        let mut j = i + k + 1;
        let start = j;
        while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
            j += 1;
        }
        let mut at = start;
        if j < b.len() && b[j] == b':' && j > start {
            at = j + 1;
        }
        if r[at..].starts_with("collection") {
            let mut e = at + "collection".len();
            while e < b.len() && matches!(b[e], b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r') {
                e += 1;
            }
            if e < b.len() && b[e] == b'/' {
                e += 1;
            }
            if e < b.len() && b[e] == b'>' {
                return true;
            }
        }
        i = i + k + 1;
    }
    false
}

/// KtRemote.with: a failed call is tried once more on a new connection, unless the server's key or certificate is to
/// be trusted first, or the login was refused.
pub fn try_again(message: &str) -> bool {
    !(message.starts_with("hostkey:") || message.starts_with("cert:") || message.starts_with("login"))
}

/// The fields a saved connection keeps secret (left out of the page's list): their names only.
pub const SECRET_FIELDS: [&str; 5] = ["pass", "key", "access", "refresh", "clientSecret"];

/// A local tree for an upload: a file (size) or a folder (its entries; None: unreadable).
pub struct Local {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub kids: Option<Vec<Local>>,
    pub dir: bool,
}

/// One step of an upload: make the folders of `Mkdirs` (each part of it, «there already» ignored), or put a file.
#[derive(Clone, Debug, PartialEq)]
pub enum Up {
    Mkdirs(String),
    Put { local: String, remote: String, size: u64 },
}

fn collect_local(f: &Local, rdir: &str, out: &mut Vec<(String, String, u64)>) {
    if f.dir {
        if let Some(k) = &f.kids {
            for x in k {
                collect_local(x, &join(rdir, &f.name), out);
            }
        }
        return;
    }
    out.push((f.path.clone(), join(rdir, &f.name), f.size));
}

/// KtRemote.transfer «up»: the files in order, each folder made once before its first file; and the totals.
pub fn upload_plan(paths: &[Local], dest: &str) -> (Vec<Up>, u64, u64) {
    let mut files = Vec::new();
    for p in paths {
        collect_local(p, &norm(dest), &mut files);
    }
    let mut made: Vec<String> = Vec::new();
    let mut out = Vec::new();
    let (mut bytes, mut n) = (0, 0);
    for (local, rp, size) in files {
        let rp = rp.replace('\\', "/");
        let rdir = &rp[..rp.rfind('/').unwrap_or(0)];
        if !rdir.is_empty() && !made.iter().any(|m| m == rdir) {
            made.push(rdir.to_string());
            out.push(Up::Mkdirs(rdir.to_string()));
        }
        bytes += size;
        n += 1;
        out.push(Up::Put { local, remote: rp, size });
    }
    (out, bytes, n)
}

/// collectRemote's local name of a remote path («root» for the root).
pub fn down_name(path: &str) -> String {
    let p = norm(path);
    let n = &p[p.rfind('/').map(|i| i + 1).unwrap_or(0)..];
    if n.is_empty() {
        "root".to_string()
    } else {
        n.to_string()
    }
}

/// collectRemote's test of a folder: listed (Some) with entries, or listed empty and no size answered; not a folder
/// when its one entry is itself (a file answering its own listing on some servers).
pub fn remote_is_dir(listed: Option<&[(String, bool)]>, size_answered: bool, name: &str) -> bool {
    match listed {
        None => false,
        Some([]) => !size_answered,
        Some([(n, d)]) if n == name && !d => false,
        Some(_) => true,
    }
}

/// fetch's cache folder for a remote path (below the app's cache) and whether the copy there is already whole.
pub fn fetch_dir(cache: &str, conn: &str, path: &str) -> String {
    let p = norm(path);
    format!("{}/remote/{}{}", cache, conn, &p[..p.rfind('/').map(|i| i + 1).unwrap_or(0)])
}
pub fn cached_whole(is_file: bool, len: u64, size: i64) -> bool {
    is_file && size >= 0 && len as i64 == size
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(norm(""), "/");
        assert_eq!(norm("a\\b\\"), "/a/b");
        assert_eq!(norm("/"), "/");
        assert_eq!(norm("//"), "/");
        assert_eq!(join("/", "x"), "/x");
        assert_eq!(join("a/", "x"), "/a/x");
        assert_eq!(smb_split("/share/a/b.txt"), ("share".into(), "a\\b.txt".into()));
        assert_eq!(smb_split("/"), ("".into(), "".into()));
        assert_eq!(smb_split("share"), ("share".into(), "".into()));
    }

    #[test]
    fn dav() {
        assert_eq!(dav_path("/my files/a+b.txt"), "/my%20files/a%2Bb.txt");
        assert_eq!(dav_path("مجلد/😀"), "/%D9%85%D8%AC%D9%84%D8%AF/%F0%9F%98%80");
        assert_eq!(dav_path("/a~b(c)"), "/a%7Eb%28c%29");
        assert_eq!(dav_base("cloud.example/", "nextcloud", "a b"), "https://cloud.example/remote.php/dav/files/a%20b");
        assert_eq!(dav_base("http://h/dav", "webdav", "u"), "http://h/dav");
        assert_eq!(dav_base("https://h/remote.php/dav/files/u/", "nextcloud", "u"), "https://h/remote.php/dav/files/u");
        assert_eq!(href_path("/remote.php/dav/files/u/a%20b/", "/remote.php/dav/files/u").unwrap(), "/a b");
        assert_eq!(href_path("https://h/dav/x+y", "/dav").unwrap(), "/x y");
        assert_eq!(href_path("/dav/", "/dav").unwrap(), "/");
        assert!(href_path("/a%2", "").is_err());
        assert!(href_path("/a%zz", "").is_err());
        assert!(is_collection("<d:resourcetype><d:collection/></d:resourcetype>"));
        assert!(is_collection("<lp1:resourcetype><lp1:collection /></lp1:resourcetype>"));
        assert!(is_collection("<collection>"));
        assert!(!is_collection("<d:resourcetype/><d:getcontentlength>3</d:getcontentlength>"));
        assert!(!is_collection("<x:collections/>"));
    }

    #[test]
    fn retries_and_plans() {
        assert!(try_again("read timed out") && !try_again("hostkey:AB") && !try_again("cert:00") && !try_again("login"));
        let t = vec![
            Local { path: "/l/D".into(), name: "D".into(), size: 0, dir: true, kids: Some(vec![Local { path: "/l/D/a".into(), name: "a".into(), size: 2, dir: false, kids: None }, Local { path: "/l/D/s".into(), name: "s".into(), size: 0, dir: true, kids: Some(vec![Local { path: "/l/D/s/b".into(), name: "b".into(), size: 3, dir: false, kids: None }]) }]) },
            Local { path: "/l/c".into(), name: "c".into(), size: 1, dir: false, kids: None },
        ];
        let (p, bytes, n) = upload_plan(&t, "/up/");
        assert_eq!((bytes, n), (6, 3));
        assert_eq!(
            p,
            vec![
                Up::Mkdirs("/up/D".into()),
                Up::Put { local: "/l/D/a".into(), remote: "/up/D/a".into(), size: 2 },
                Up::Mkdirs("/up/D/s".into()),
                Up::Put { local: "/l/D/s/b".into(), remote: "/up/D/s/b".into(), size: 3 },
                Up::Mkdirs("/up".into()),
                Up::Put { local: "/l/c".into(), remote: "/up/c".into(), size: 1 },
            ]
        );
        // (into the root: no folder to make)
        let (p, _, _) = upload_plan(&t[1..], "/");
        assert_eq!(p, vec![Up::Put { local: "/l/c".into(), remote: "/c".into(), size: 1 }]);
        assert_eq!(down_name("/"), "root");
        assert_eq!(down_name("/a/b.mkv"), "b.mkv");
        assert!(!remote_is_dir(None, false, "x"));
        assert!(remote_is_dir(Some(&[]), false, "x"));
        assert!(!remote_is_dir(Some(&[]), true, "x"));
        assert!(!remote_is_dir(Some(&[("x".into(), false)]), true, "x"));
        assert!(remote_is_dir(Some(&[("x".into(), true)]), true, "x"));
        assert_eq!(fetch_dir("/c", "r1", "/a/b.mkv"), "/c/remote/r1/a/");
        assert!(cached_whole(true, 5, 5) && !cached_whole(true, 5, -1) && !cached_whole(false, 5, 5));
    }
}
