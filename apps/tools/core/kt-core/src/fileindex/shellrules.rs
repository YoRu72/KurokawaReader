//! What a shell decides around the index, kept here so it is tested with the rest (std only): whether a folder may be
//! chosen (never inside or around one already chosen, never the app's own data folder), the app-data folder left out
//! of every root, an excluded folder's place, the page's limits, and whether the computer runs on its battery (read
//! cheaply where the system says so: Windows' GetSystemPowerStatus, Linux's /sys/class/power_supply; elsewhere unknown).
use std::path::{Path, PathBuf};

use super::store::{under, RootSpec};

/// Why a folder is not taken as a new root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Not a whole path to a folder that exists.
    NotAFolder,
    /// Chosen already.
    Same(PathBuf),
    /// Inside a folder already chosen (it is searched already).
    Inside(PathBuf),
    /// Holds a folder already chosen (remove that one first, or keep it).
    Holds(PathBuf),
    /// The app's own data folder, or inside it (the index lives there).
    AppData,
}

impl Refusal {
    /// The page's code for it, and the other folder where there is one.
    pub fn code(&self) -> (&'static str, Option<&Path>) {
        match self {
            Refusal::NotAFolder => ("missing", None),
            Refusal::Same(p) => ("same", Some(p)),
            Refusal::Inside(p) => ("inside", Some(p)),
            Refusal::Holds(p) => ("holds", Some(p)),
            Refusal::AppData => ("appData", None),
        }
    }
}

/// Whether `new` may join the chosen folders.
pub fn check_new_root(chosen: &[PathBuf], new: &Path, is_dir: bool, app_data: Option<&Path>) -> Result<(), Refusal> {
    if !new.is_absolute() || !is_dir {
        return Err(Refusal::NotAFolder);
    }
    if let Some(a) = app_data {
        if under(new, a).is_some() {
            return Err(Refusal::AppData);
        }
    }
    for c in chosen {
        match (under(new, c), under(c, new)) {
            (Some(rest), _) if rest.is_empty() => return Err(Refusal::Same(c.clone())),
            (Some(_), _) => return Err(Refusal::Inside(c.clone())),
            (_, Some(_)) => return Err(Refusal::Holds(c.clone())),
            _ => {}
        }
    }
    Ok(())
}

/// The spec the index is given: the user's, with the app-data folder left out when it lies under the root.
pub fn spec_for(root: &Path, exclude: &[PathBuf], exclude_names: &[String], app_data: Option<&Path>) -> RootSpec {
    let mut ex: Vec<PathBuf> = exclude.iter().filter(|e| folder_under(root, e)).cloned().collect();
    if let Some(a) = app_data {
        if under(a, root).map_or(false, |r| !r.is_empty()) && !ex.iter().any(|e| under(a, e).is_some()) {
            ex.push(a.to_path_buf());
        }
    }
    let names = exclude_names.iter().map(|n| n.trim().to_string()).filter(|n| good_excluded_name(n)).collect();
    RootSpec { path: root.to_path_buf(), exclude: ex, exclude_names: names }
}

/// A folder strictly inside `root` (an exclusion's place).
pub fn folder_under(root: &Path, folder: &Path) -> bool {
    folder.is_absolute() && under(folder, root).map_or(false, |r| !r.is_empty())
}

/// A folder name left out wherever it is: one name, no separator, not «.» or «..», at most 255 bytes.
pub fn good_excluded_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 255 && n != "." && n != ".." && !n.contains('/') && !n.contains('\\') && !n.contains('\0')
}

/// The most hits one search hands the page (its list is virtualised; «showing N of total» beyond).
pub const MAX_HITS: usize = 10_000;
/// The most folders the user may choose, and exclusions per folder (a settings file is never trusted beyond these).
pub const MAX_ROOTS: usize = 64;
pub const MAX_EXCLUDES: usize = 256;

/// The page's limit made safe: 1..=MAX_HITS, 200 when not given.
pub fn clamp_limit(asked: Option<f64>) -> usize {
    match asked {
        Some(x) if x.is_finite() && x >= 1.0 => (x as usize).min(MAX_HITS),
        _ => 200,
    }
}

/// One entry of /sys/class/power_supply: its type («Mains», «Battery», «USB»…), `online` and `status` as read.
pub struct Supply {
    pub kind: String,
    pub online: Option<String>,
    pub status: Option<String>,
}

/// Linux: on battery when no mains supply is online and a battery says it is discharging; None when it cannot tell
/// (no battery at all: a desktop — not on battery).
pub fn linux_on_battery(list: &[Supply]) -> Option<bool> {
    let mains: Vec<&Supply> = list.iter().filter(|s| s.kind.trim() == "Mains" || s.kind.trim() == "USB").collect();
    if mains.iter().any(|s| s.online.as_deref().map(str::trim) == Some("1")) {
        return Some(false);
    }
    let bats: Vec<&Supply> = list.iter().filter(|s| s.kind.trim() == "Battery").collect();
    if bats.is_empty() {
        return if mains.is_empty() { None } else { Some(false) };
    }
    if bats.iter().any(|b| b.status.as_deref().map(str::trim) == Some("Discharging")) {
        return Some(true);
    }
    if !mains.is_empty() && mains.iter().all(|s| s.online.as_deref().map(str::trim) == Some("0")) {
        return Some(true);
    }
    Some(false)
}

/// Windows' SYSTEM_POWER_STATUS read as (ACLineStatus, BatteryFlag): on battery when the line is off (0) and a battery
/// is there (flag 128 = none); unknown (255) gives None.
pub fn windows_on_battery(ac_line: u8, battery_flag: u8) -> Option<bool> {
    if battery_flag == 128 {
        return Some(false);
    }
    match ac_line {
        0 => Some(true),
        1 => Some(false),
        _ => None,
    }
}

/// Whether the computer runs on its battery now (None: this system does not say cheaply).
pub fn on_battery() -> Option<bool> {
    #[cfg(windows)]
    {
        #[repr(C)]
        struct SystemPowerStatus {
            ac_line_status: u8,
            battery_flag: u8,
            battery_life_percent: u8,
            system_status_flag: u8,
            battery_life_time: u32,
            battery_full_life_time: u32,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetSystemPowerStatus(s: *mut SystemPowerStatus) -> i32;
        }
        let mut s = SystemPowerStatus { ac_line_status: 255, battery_flag: 255, battery_life_percent: 255, system_status_flag: 0, battery_life_time: 0, battery_full_life_time: 0 };
        // SAFETY: a plain struct of the documented layout, written by the call.
        if unsafe { GetSystemPowerStatus(&mut s) } == 0 {
            return None;
        }
        windows_on_battery(s.ac_line_status, s.battery_flag)
    }
    #[cfg(target_os = "linux")]
    {
        let rd = std::fs::read_dir("/sys/class/power_supply").ok()?;
        let mut list = Vec::new();
        for e in rd.flatten().take(32) {
            let p = e.path();
            let read = |f: &str| std::fs::read_to_string(p.join(f)).ok();
            list.push(Supply { kind: read("type").unwrap_or_default(), online: read("online"), status: read("status") });
        }
        linux_on_battery(&list)
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        None
    }
}
