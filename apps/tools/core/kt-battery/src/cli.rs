// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the command line — «--battery-json» prints the devices once, «--battery-help»
// says how.
// Reference: the original v1.1.0's src/json_output.h (DevicesToJson), tests/json_output_test.cpp and the `--json` / `--help`
// handling of src/main.cpp and src/linux/main_linux.cpp (one polling pass, a JSON document, then exit).
// Changed here: the flags carry the feature's name (this program has other things to do: `--hidden`, files and links to
// open); one document with a «format» number instead of a bare array (a field may be added without breaking a reader;
// one removed or changed raises the number); the level is an object (exact, coarse, steps or unknown — never a made-up
// percentage); no key, serial number or address (the same privacy rules as the report: report.rs); the pass uses the
// default settings — a reader that sends a status request stays off, as it is until the user turns it on in the page.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::identity;
use crate::json::J;
use crate::model::Level;
use crate::report::{self, scrub};
use crate::runner::{needs_query, DeviceState, Platform, Prefs, Status};
use crate::sched::{Outcome, Timing};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const FLAG_JSON: &str = "--battery-json";
pub const FLAG_HELP: &str = "--battery-help";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Json,
    Help,
}

/// What the program was asked to do, from its arguments (the program's name left out): either flag alone, as written; the
/// help wins when both are there. Any other argument (a link, a file, `--hidden`) is not this feature's.
pub fn action(args: &[String]) -> Option<Action> {
    if args.iter().any(|a| a == FLAG_HELP) {
        Some(Action::Help)
    } else if args.iter().any(|a| a == FLAG_JSON) {
        Some(Action::Json)
    } else {
        None
    }
}

pub fn help_text() -> String {
    format!(
        "Kurokawa Tools - the batteries of your wireless devices, on the command line\n\
\n\
  {json}   Look at the devices once (a few seconds at most) and print one JSON document,\n\
                   then exit. No window opens, nothing is started in the background, and a\n\
                   running copy of the program is left alone.\n\
  {help}   Show this text, then exit.\n\
\n\
The document has \"format\": {fmt} and a \"devices\" list; each device has: name, kind, connection,\n\
vendorId, productId (hexadecimal text, null when unknown), level ({{\"kind\": \"exact\", \"value\": 0-100}}, or\n\
\"coarse\" with \"value\" one of empty/low/medium/high/full, or \"steps\" with \"value\" and \"max\", or \"unknown\"),\n\
charging (yes/no/unknown), state (ok/waiting/asleep/notConnected/noAnswer/notQueried), source, testLevel\n\
(tested/untested: nothing is proven on hardware yet), readerFamily, note. There is no serial number, no\n\
Bluetooth address and no computer or user name in it. An empty list means nothing was found.\n\
\n\
Only the readers that listen or read are used: a device that needs a status request to be read stays unread\n\
here until you turn its family on in the Device battery page (the page's settings are not used by this command).\n\
\n\
On Windows this program has no console of its own: run it from a console and redirect or pipe its output\n\
(Kurokawa Tools.exe {json} > devices.json), or run it with: start /wait.\n",
        json = FLAG_JSON,
        help = FLAG_HELP,
        fmt = report::FORMAT
    )
}

/// One reading pass: the platform listed, every device that needs a query asked at once (each with its own deadline), and
/// the answers waited for until the deadline — a device that has not answered by then is «noAnswer». The list comes sorted
/// by key, as the loop's does. `now_ms` is the clock's time.
pub fn one_pass(p: Arc<dyn Platform>, prefs: &Prefs, now_ms: u64) -> Vec<DeviceState> {
    let deadline_ms = if prefs.deadline_ms == 0 { Timing::default().deadline_ms } else { prefs.deadline_ms.clamp(200, 30_000) };
    p.set_prefs(prefs);
    // (Listing reads every device's properties: it gets twice a query's time, at least 5 s, as the loop gives it.)
    let (tx, rx) = mpsc::channel();
    let p2 = p.clone();
    let spawned = std::thread::Builder::new().name("kt-battery-cli-enum".into()).spawn(move || {
        let _ = tx.send(p2.enumerate(now_ms));
    });
    if spawned.is_err() {
        return Vec::new();
    }
    let found = rx.recv_timeout(Duration::from_millis((deadline_ms * 2).max(5_000))).unwrap_or_default();
    let merged = identity::merge(found, &prefs.links);
    let mut states: Vec<DeviceState> = Vec::new();
    let mut asked: Vec<usize> = Vec::new();
    for c in merged {
        let key = c.device.key.clone();
        let mut st = DeviceState { device: c.device, reading: None, last_good: None, status: Status::Waiting, checked_at: now_ms };
        if prefs.no_query.contains(&key) {
            st.status = Status::NotQueried;
        } else if c.offline {
            st.status = Status::NotConnected;
        } else if needs_query(&st.device) {
            asked.push(states.len());
        } else if let Some(r) = c.reading {
            apply(&mut st, Outcome::Read(r));
        } else {
            st.status = Status::NoAnswer;
        }
        states.push(st);
    }
    let (qtx, qrx) = mpsc::channel::<(usize, Outcome)>();
    let deadline = Instant::now() + Duration::from_millis(deadline_ms);
    let mut running = 0usize;
    for &i in &asked {
        let (p3, dev, tx) = (p.clone(), states[i].device.clone(), qtx.clone());
        let ok = std::thread::Builder::new().name("kt-battery-cli-query".into()).spawn(move || {
            let out = p3.query(&dev, deadline, now_ms);
            let _ = tx.send((i, out));
        });
        if ok.is_ok() {
            running += 1;
        } else {
            apply(&mut states[i], Outcome::Failed);
        }
    }
    drop(qtx);
    let mut answered: Vec<usize> = Vec::new();
    let give_up = deadline + Duration::from_millis(500);
    while answered.len() < running {
        let left = give_up.saturating_duration_since(Instant::now());
        match qrx.recv_timeout(left) {
            Ok((i, out)) => {
                apply(&mut states[i], out);
                answered.push(i);
            }
            Err(_) => break,
        }
    }
    for &i in &asked {
        if !answered.contains(&i) && states[i].status == Status::Waiting {
            apply(&mut states[i], Outcome::NoAnswer);
        }
    }
    states.sort_by(|a, b| a.device.key.cmp(&b.device.key));
    states
}

fn apply(st: &mut DeviceState, out: Outcome) {
    match out {
        Outcome::Read(r) if r.asleep => st.status = Status::Asleep,
        Outcome::Read(r) => {
            st.status = Status::Ok;
            st.reading = Some(r);
            if r.level != Level::Unknown {
                st.last_good = Some(r);
            }
        }
        Outcome::Asleep => st.status = Status::Asleep,
        Outcome::NoAnswer | Outcome::Failed => st.status = Status::NoAnswer,
    }
}

fn level_obj(l: Level) -> J {
    match l {
        Level::Exact(p) => J::Obj(vec![("kind", J::str("exact")), ("value", J::Int(p.get() as i64))]),
        Level::Coarse(c) => J::Obj(vec![("kind", J::str("coarse")), ("value", J::str(c.as_str()))]),
        Level::Steps(s) => J::Obj(vec![("kind", J::str("steps")), ("value", J::Int(s.n() as i64)), ("max", J::Int(s.max() as i64))]),
        Level::Unknown => J::Obj(vec![("kind", J::str("unknown"))]),
    }
}

/// The texts that must not come out of any name: every serial number and address the devices carry, and the extra ones
/// the caller knows (the computer's and the user's name).
pub fn secrets_of(list: &[DeviceState], extra: &[String]) -> Vec<String> {
    let mut v: Vec<String> = extra.to_vec();
    for s in list {
        v.push(s.device.serial.clone());
        v.push(s.device.container.clone());
    }
    v.retain(|x| x.trim().chars().count() >= 3);
    v.sort();
    v.dedup();
    v
}

fn ids(vid: u16, pid: u16) -> (J, J) {
    if vid == 0 && pid == 0 {
        (J::Null, J::Null)
    } else {
        (J::Str(format!("{:04X}", vid)), J::Str(format!("{:04X}", pid)))
    }
}

/// The command line's document: `format`, the program's name and version, and the devices.
pub fn devices_json(list: &[DeviceState], version: &str, extra_secrets: &[String]) -> J {
    let secrets = secrets_of(list, extra_secrets);
    let devices: Vec<J> = list
        .iter()
        .map(|s| {
            let d = &s.device;
            let (vid, pid) = ids(d.vid, d.pid);
            let (level, charging, note) = match &s.reading {
                Some(r) => (level_obj(r.level), r.charging.as_str(), r.note.as_str()),
                None => (level_obj(Level::Unknown), "unknown", ""),
            };
            J::Obj(vec![
                ("name", J::Str(scrub(&d.name, &secrets))),
                ("kind", J::str(d.kind.as_str())),
                ("connection", J::str(d.connection.as_str())),
                ("vendorId", vid),
                ("productId", pid),
                ("level", level),
                ("charging", J::str(charging)),
                ("state", J::str(s.status.as_str())),
                ("source", J::str(d.source.as_str())),
                ("testLevel", J::str(report::test_level(d))),
                ("readerFamily", J::str(report::reader_of(d.driver).0)),
                ("note", J::str(note)),
            ])
        })
        .collect();
    J::Obj(vec![("format", J::Int(report::FORMAT as i64)), ("app", J::str("Kurokawa Tools")), ("version", J::Str(scrub(version, &[]))), ("devices", J::Arr(devices))])
}

/// Windows' name and number from RtlGetVersion's three numbers (build 22000 and up is Windows 11, whose number says 10).
pub fn windows_name(major: u32, minor: u32, build: u32) -> (String, String) {
    let name = if major == 10 && build >= 22_000 { "Windows 11" } else if major == 10 { "Windows 10" } else { "Windows" };
    (name.to_string(), format!("{}.{}.{}", major, minor, build))
}

/// This system's name and version for the report: Linux's distribution and kernel (from /etc/os-release and the kernel's
/// own file — no host name), Windows' number, a Mac's product version. Empty parts when it cannot be read.
pub fn os_info() -> (String, String) {
    // (Not in the test builds: the std-only test root, stdroots/core.rs, has no `win` module on Windows.)
    #[cfg(all(windows, not(test)))]
    {
        return match crate::win::console::os_version() {
            Some((a, b, c)) => windows_name(a, b, c),
            None => ("Windows".to_string(), String::new()),
        };
    }
    #[cfg(target_os = "linux")]
    {
        let text = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
        let pretty = text.lines().find_map(|l| l.strip_prefix("PRETTY_NAME=")).map(|v| v.trim().trim_matches('"').to_string()).unwrap_or_default();
        let kernel = std::fs::read_to_string("/proc/sys/kernel/osrelease").map(|s| s.trim().to_string()).unwrap_or_default();
        let version = match (pretty.is_empty(), kernel.is_empty()) {
            (false, false) => format!("{}, kernel {}", pretty, kernel),
            (false, true) => pretty,
            (true, false) => format!("kernel {}", kernel),
            _ => String::new(),
        };
        return ("Linux".to_string(), version);
    }
    #[cfg(target_os = "macos")]
    {
        let v = std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output().ok().and_then(|o| String::from_utf8(o.stdout).ok()).unwrap_or_default();
        return ("macOS".to_string(), v.trim().to_string());
    }
    #[allow(unreachable_code)]
    (std::env::consts::OS.to_string(), String::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::Candidate;
    use crate::model::{Charging, Device, Kind, Percent, Reading, Source, Steps};
    use std::sync::Mutex;

    #[test]
    fn the_flags_are_this_features_own() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(action(&a(&["--battery-json"])), Some(Action::Json));
        assert_eq!(action(&a(&["--battery-help"])), Some(Action::Help));
        assert_eq!(action(&a(&["--battery-json", "--battery-help"])), Some(Action::Help));
        assert_eq!(action(&a(&["--hidden"])), None, "the start with the system is not ours");
        assert_eq!(action(&a(&["magnet:?xt=urn:btih:x", "movie.torrent"])), None);
        assert_eq!(action(&a(&["--battery-jsonx", "--json", "--help", "-h"])), None, "only the exact flags");
        assert_eq!(action(&[]), None);
        assert!(help_text().contains(FLAG_JSON) && help_text().contains(FLAG_HELP) && help_text().is_ascii());
    }

    fn dev(key: &str, name: &str, src: Source, kind: Kind) -> Device {
        let mut d = Device::new(key.into(), src);
        d.name = name.into();
        d.kind = kind;
        d.serial = format!("SER-123456-{}", key.len());
        d
    }

    struct Fake {
        release: Mutex<Option<mpsc::Receiver<()>>>,
        asked: Mutex<Vec<String>>,
    }
    impl Platform for Fake {
        fn enumerate(&self, now: u64) -> Vec<Candidate> {
            let mut bt = dev("bt:11:22:33:44:55:66", "Made-up \"Buds\" ماوس 11:22:33:44:55:66", Source::Bluetooth, Kind::Earbuds);
            bt.container = "11:22:33:44:55:66".into();
            bt.vid = 0x1234;
            bt.pid = 0xAB;
            let r = Reading::new(Level::Steps(Steps::new(3, 5).unwrap()), Charging::Yes, now);
            let away = dev("bt:away", "Away speaker", Source::Bluetooth, Kind::Speaker);
            vec![
                Candidate { device: dev("hid:fast", "Fast mouse", Source::HidGeneric, Kind::Mouse), reading: None, offline: false },
                Candidate { device: dev("hid:stuck", "Stuck mouse", Source::HidGeneric, Kind::Mouse), reading: None, offline: false },
                Candidate { device: bt, reading: Some(r), offline: false },
                Candidate { device: away, reading: None, offline: true },
            ]
        }
        fn query(&self, d: &Device, _deadline: Instant, now: u64) -> Outcome {
            self.asked.lock().unwrap().push(d.key.clone());
            if d.key == "hid:stuck" {
                if let Some(rx) = self.release.lock().unwrap().take() {
                    let _ = rx.recv();
                }
                return Outcome::NoAnswer;
            }
            Outcome::Read(Reading::new(Level::Exact(Percent::new(64).unwrap()), Charging::No, now))
        }
    }

    #[test]
    fn one_pass_reads_everyone_and_gives_up_on_a_stuck_device_at_the_deadline() {
        let (rel_tx, rel_rx) = mpsc::channel();
        let fake = Arc::new(Fake { release: Mutex::new(Some(rel_rx)), asked: Mutex::new(Vec::new()) });
        let prefs = Prefs { deadline_ms: 200, ..Default::default() };
        let started = Instant::now();
        let list = one_pass(fake.clone(), &prefs, 5_000);
        assert!(started.elapsed() < Duration::from_secs(5), "bounded by the deadline");
        let get = |k: &str| list.iter().find(|s| s.device.key == k).unwrap();
        assert_eq!(get("hid:fast").status, Status::Ok);
        assert_eq!(get("hid:fast").reading.unwrap().level, Level::Exact(Percent::new(64).unwrap()));
        assert_eq!(get("hid:stuck").status, Status::NoAnswer);
        assert_eq!(get("bt:11:22:33:44:55:66").status, Status::Ok);
        assert_eq!(get("bt:away").status, Status::NotConnected);
        let keys: Vec<&str> = list.iter().map(|s| s.device.key.as_str()).collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted, "sorted by key");
        let _ = rel_tx.send(());
    }

    #[test]
    fn a_no_query_choice_and_an_empty_system() {
        struct None_;
        impl Platform for None_ {
            fn enumerate(&self, _n: u64) -> Vec<Candidate> {
                Vec::new()
            }
            fn query(&self, _d: &Device, _l: Instant, _n: u64) -> Outcome {
                Outcome::Failed
            }
        }
        let list = one_pass(Arc::new(None_), &Prefs::default(), 1);
        assert!(list.is_empty());
        let doc = devices_json(&list, "0.21.0", &[]).render(false);
        assert!(doc.contains("\"format\": 1"));
        assert!(doc.contains("\"devices\": []"), "{}", doc);
    }

    #[test]
    fn the_document_has_stable_fields_and_nothing_private() {
        let fake = Arc::new(Fake { release: Mutex::new(None), asked: Mutex::new(Vec::new()) });
        let list = one_pass(fake, &Prefs { deadline_ms: 200, ..Default::default() }, 9);
        let doc = devices_json(&list, "0.21.0", &["MY-LAPTOP".to_string()]);
        let text = doc.render(false);
        let low = text.to_lowercase();
        for bad in ["ser-123456", "11:22:33", "my-laptop", "hid:fast", "bt:", "\"key\""] {
            assert!(!low.contains(bad), "«{}» in\n{}", bad, text);
        }
        assert!(text.starts_with("{\n  \"format\": 1,\n  \"app\": \"Kurokawa Tools\",\n  \"version\": \"0.21.0\",\n  \"devices\": [\n"));
        // (One device's fields in their order.)
        let at = text.find("\"name\": \"Fast mouse\"").expect("fast mouse");
        let part = &text[at..];
        let order = ["\"name\"", "\"kind\"", "\"connection\"", "\"vendorId\"", "\"productId\"", "\"level\"", "\"charging\"", "\"state\"", "\"source\"", "\"testLevel\"", "\"readerFamily\"", "\"note\""];
        let mut last = 0;
        for k in order {
            let p = part.find(k).unwrap_or_else(|| panic!("{} missing", k));
            assert!(p >= last, "{} out of order", k);
            last = p;
        }
        assert!(text.contains("\"vendorId\": null"));
        assert!(text.contains("{\n        \"kind\": \"exact\",\n        \"value\": 64\n      }"), "{}", text);
        assert!(text.contains("\"kind\": \"steps\""));
        assert!(text.contains("\"value\": 3") && text.contains("\"max\": 5"));
        assert!(text.contains("\"state\": \"notConnected\"") && text.contains("\"state\": \"noAnswer\""));
        assert!(text.contains("\"testLevel\": \"untested\""));
        // (The name's quote is escaped, the Arabic stays, the address is gone.)
        assert!(text.contains("Made-up \\\"Buds\\\" ماوس [address]"), "{}", text);
        assert!(devices_json(&list, "0.21.0", &[]).render(true).is_ascii(), "the console's form is ASCII");
    }

    #[test]
    fn windows_is_named_by_its_build() {
        assert_eq!(windows_name(10, 0, 22631), ("Windows 11".to_string(), "10.0.22631".to_string()));
        assert_eq!(windows_name(10, 0, 19045).0, "Windows 10");
        assert_eq!(windows_name(6, 3, 9600).0, "Windows");
    }
}
