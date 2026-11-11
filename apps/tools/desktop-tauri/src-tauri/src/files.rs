// The file handlers of desktop/main.cjs (kt:listDir, kt:pathInfo, kt:siblings, kt:writeText, kt:writeTemp…), in
// plain std so they can be checked and tested alone: `rustc --edition 2021 --test files.rs`.
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    pub size: u64,
    pub mtime: f64,
}

pub struct PathInfo {
    pub dir: bool,
    pub size: u64,
    pub name: String,
    pub parent: String,
}

fn lossy(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn mtime_ms(md: &fs::Metadata) -> f64 {
    match md.modified() {
        Ok(t) => match t.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_secs_f64() * 1000.0,
            Err(_) => 0.0,
        },
        Err(_) => 0.0,
    }
}

/// kt:listDir: None when the folder cannot be read; entries that vanish meanwhile are left out. Links followed,
/// as Node's fs.stat does.
pub fn list_dir(p: &str) -> Option<Vec<DirEntry>> {
    let rd = fs::read_dir(p).ok()?;
    let mut out: Vec<DirEntry> = Vec::new();
    for item in rd {
        let item = match item {
            Ok(x) => x,
            Err(_) => continue,
        };
        let full = Path::new(p).join(item.file_name());
        let md = match fs::metadata(&full) {
            Ok(m) => m,
            Err(_) => continue,
        };
        out.push(DirEntry {
            name: item.file_name().to_string_lossy().into_owned(),
            path: lossy(&full),
            dir: md.is_dir(),
            size: if md.is_file() { md.len() } else { 0 },
            mtime: mtime_ms(&md),
        });
    }
    Some(out)
}

/// kt:pathInfo: None when nothing is there.
pub fn path_info(p: &str) -> Option<PathInfo> {
    let md = fs::metadata(p).ok()?;
    let path = Path::new(p);
    let name = match path.file_name() {
        Some(n) => n.to_string_lossy().into_owned(),
        None => String::new(),
    };
    let parent = match path.parent() {
        Some(x) if !x.as_os_str().is_empty() => lossy(x),
        Some(_) => ".".to_string(),
        None => p.to_string(),
    };
    Some(PathInfo {
        dir: md.is_dir(),
        size: md.len(),
        name,
        parent,
    })
}

/// kt:exists, one answer per path.
pub fn exists_all(ps: &[String]) -> Vec<bool> {
    ps.iter().map(|p| Path::new(p).exists()).collect()
}

/// A name without its last extension, lowercased (the `/\.[^.]+$/` of main.cjs: «.bashrc» → «», «a.» kept).
pub fn stem_lower(name: &str) -> String {
    let base = match name.rfind('.') {
        Some(i) if i + 1 < name.len() => &name[..i],
        _ => name,
    };
    base.to_lowercase()
}

/// Of the names in a folder, the ones that start with `file_name`'s stem (case aside), the file itself left out.
pub fn sibling_names(file_name: &str, names: &[String]) -> Vec<String> {
    let base = stem_lower(file_name);
    names
        .iter()
        .filter(|n| n.to_lowercase().starts_with(&base) && n.as_str() != file_name)
        .cloned()
        .collect()
}

/// kt:siblings: the files beside a video that share its name (subtitles, audio…), as full paths; [] on any error.
pub fn siblings(p: &str) -> Vec<String> {
    let path = Path::new(p);
    let dir: PathBuf = match path.parent() {
        Some(x) if !x.as_os_str().is_empty() => x.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let file_name = match path.file_name() {
        Some(n) => n.to_string_lossy().into_owned(),
        None => return Vec::new(),
    };
    let rd = match fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let mut names: Vec<String> = Vec::new();
    for item in rd {
        if let Ok(e) = item {
            names.push(e.file_name().to_string_lossy().into_owned());
        }
    }
    sibling_names(&file_name, &names)
        .into_iter()
        .map(|n| lossy(&dir.join(n)))
        .collect()
}

/// A name made safe for one folder: slashes and backslashes to «_».
pub fn sanitize_name(s: &str) -> String {
    s.replace('/', "_").replace('\\', "_")
}

/// kt:writeText: the folder made if missing, then the text written as UTF-8.
pub fn write_text(p: &str, text: &str) -> io::Result<()> {
    if let Some(parent) = Path::new(p).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    fs::write(p, text.as_bytes())
}

/// kt:removeFile: gone if it was there; an error is not one.
pub fn remove_file(p: &str) {
    let _ = fs::remove_file(p);
}

/// kt:writeTemp: <temp>/kurokawa-clip/<name> (its fonts/ folder made too, as main.cjs does).
pub fn write_temp(temp: &Path, name: &str, text: &str) -> io::Result<PathBuf> {
    let dir = temp.join("kurokawa-clip");
    fs::create_dir_all(dir.join("fonts"))?;
    let f = dir.join(sanitize_name(name));
    fs::write(&f, text.as_bytes())?;
    Ok(f)
}

/// kt:writeTempBytes: <temp>/kurokawa-clip[/<sub>]/<name>.
pub fn write_temp_bytes(temp: &Path, sub: &str, name: &str, bytes: &[u8]) -> io::Result<PathBuf> {
    let mut dir = temp.join("kurokawa-clip");
    if !sub.is_empty() {
        dir = dir.join(sanitize_name(sub));
    }
    fs::create_dir_all(&dir)?;
    let f = dir.join(sanitize_name(name));
    fs::write(&f, bytes)?;
    Ok(f)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kt-files-test-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn stems() {
        assert_eq!(stem_lower("Show EP01.mkv"), "show ep01");
        assert_eq!(stem_lower(".bashrc"), "");
        assert_eq!(stem_lower("a."), "a.");
        assert_eq!(stem_lower("noext"), "noext");
    }

    #[test]
    fn sibling_filter() {
        let names: Vec<String> = ["Ep01.mkv", "ep01.ar.ass", "EP01.en.srt", "Ep02.mkv", "ep01"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            sibling_names("Ep01.mkv", &names),
            vec!["ep01.ar.ass", "EP01.en.srt", "ep01"]
        );
    }

    #[test]
    fn on_disk() {
        let d = scratch("disk");
        let video = d.join("Ep01.mkv");
        fs::write(&video, b"x").unwrap();
        fs::write(d.join("Ep01.ar.ass"), b"yy").unwrap();
        fs::create_dir_all(d.join("sub")).unwrap();
        let mut found = siblings(video.to_str().unwrap());
        found.sort();
        assert_eq!(
            found,
            vec![d.join("Ep01.ar.ass").to_string_lossy().into_owned()]
        );
        let mut ls = list_dir(d.to_str().unwrap()).unwrap();
        ls.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(ls.len(), 3);
        assert_eq!(ls[1].name, "Ep01.mkv");
        assert_eq!(ls[1].size, 1);
        assert!(ls[2].dir && ls[2].size == 0);
        assert!(ls[1].mtime > 1.0e12);
        assert!(list_dir(d.join("nope").to_str().unwrap()).is_none());
        let info = path_info(video.to_str().unwrap()).unwrap();
        assert_eq!(info.name, "Ep01.mkv");
        assert_eq!(info.parent, d.to_string_lossy());
        assert!(!info.dir);
        assert!(path_info(d.join("nope").to_str().unwrap()).is_none());
        let deep = d.join("a").join("b").join("c.txt");
        write_text(deep.to_str().unwrap(), "مرحبا").unwrap();
        assert_eq!(fs::read_to_string(&deep).unwrap(), "مرحبا");
        let ex = exists_all(&[
            deep.to_string_lossy().into_owned(),
            d.join("nope").to_string_lossy().into_owned(),
        ]);
        assert_eq!(ex, vec![true, false]);
        remove_file(deep.to_str().unwrap());
        remove_file(deep.to_str().unwrap());
        assert!(!deep.exists());
        let t = write_temp(&d, "x/y.ass", "t").unwrap();
        assert_eq!(t, d.join("kurokawa-clip").join("x_y.ass"));
        assert!(d.join("kurokawa-clip").join("fonts").is_dir());
        let b = write_temp_bytes(&d, "f/s", "a.ttf", &[1, 2, 3]).unwrap();
        assert_eq!(b, d.join("kurokawa-clip").join("f_s").join("a.ttf"));
        assert_eq!(fs::read(&b).unwrap(), vec![1, 2, 3]);
        let _ = fs::remove_dir_all(&d);
    }
}
