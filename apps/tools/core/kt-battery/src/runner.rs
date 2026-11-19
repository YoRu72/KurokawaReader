// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the background loop.
// Derived from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor), src/main.cpp's
// poll thread and src/devices.cpp PollAllDevices at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its
// contributors, GPL-3.0-or-later.
// Changed here: one thread waits (no timer ticking every second): it sleeps until the next thing to do — a device's
// time, a deadline, the next enumeration — or a message (refresh, a device arrived, the computer woke, new settings,
// stop). Enumeration runs once per interval and soon after a device arrives (arrivals in a burst make one), on its own
// thread with its own deadline. Each device needing a query is asked on a thread of its own with a deadline
// (sched.rs): one stuck device never delays another, and is never asked twice at once. Every published state carries
// each reading's time, the last good reading apart from the current one, and why there is no current one.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::identity::{self, Candidate};
use crate::model::{Device, Reading, Source};
use crate::sched::{Done, Outcome, Scheduler, Ticket, Timing};
use std::collections::BTreeMap;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

/// What a platform gives: the devices found (with the readings their readers bring along), and a query of one.
pub trait Platform: Send + Sync + 'static {
    /// Every device with a battery this round. Bluetooth, Xbox and XInput entries come with their reading (or
    /// offline); HID ones without, to be asked through `query`.
    fn enumerate(&self, now_ms: u64) -> Vec<Candidate>;
    /// One device asked, by `deadline`.
    fn query(&self, device: &Device, deadline: Instant, now_ms: u64) -> Outcome;
    /// The user's settings, before the first round and after each change (the controller families whose status
    /// request may be sent, Prefs::pad_queries).
    fn set_prefs(&self, _prefs: &Prefs) {}
    /// W3, «Teach me this device»: every HID collection with its verdict (teach.rs — what may be listened to).
    /// Platforms without a HID transport give none.
    fn teach_targets(&self) -> Vec<crate::teach::Target> {
        Vec::new()
    }
    /// W3: one collection `teach_targets` allowed, opened to listen only (never for writing). Anything else: Refused.
    fn teach_open(&self, _id: &str) -> Result<Box<dyn crate::transport::HidTransport + Send>, crate::transport::TErr> {
        Err(crate::transport::TErr::Refused)
    }
    /// Piece W4 («Report a device» and the command line): every HID collection this system lists, those no reader wants
    /// too — nothing opened, nothing sent. Platforms with no such list give none.
    fn inventory(&self) -> Vec<crate::report::HidSeen> {
        Vec::new()
    }
}

/// Whether a device is asked through `query` (else its reader brought its reading with the enumeration).
pub fn needs_query(d: &Device) -> bool {
    d.source == Source::HidGeneric || d.source == Source::Pad || d.source == Source::Vendor || d.source == Source::Spp || d.source == Source::Defined
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// The reading is current.
    Ok,
    /// Found, first answer awaited.
    Waiting,
    /// The device said it is asleep (not asked again until the user asks).
    Asleep,
    /// Paired but not connected.
    NotConnected,
    /// It did not answer (in time).
    NoAnswer,
    /// The user said not to query it.
    NotQueried,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Ok => "ok",
            Status::Waiting => "waiting",
            Status::Asleep => "asleep",
            Status::NotConnected => "notConnected",
            Status::NoAnswer => "noAnswer",
            Status::NotQueried => "notQueried",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DeviceState {
    pub device: Device,
    /// The current reading (None unless status is Ok).
    pub reading: Option<Reading>,
    /// The last reading that had a level, whenever it was taken (the page shows it dimmed with its age).
    pub last_good: Option<Reading>,
    pub status: Status,
    /// When the device was last asked or seen (ms).
    pub checked_at: u64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Prefs {
    pub interval_ms: u64,
    pub deadline_ms: u64,
    pub no_query: Vec<String>,
    pub links: Vec<(String, String)>,
    /// The controller families (pads::Family::as_str) the user turned on whose reading sends a status request.
    pub pad_queries: Vec<String>,
    /// Piece 5: the mice' and keyboards' families (mice::Family::as_str) the user turned on whose reading sends a status
    /// request (off by default), and those read by listening that the user turned off (on by default).
    pub mk_ask: Vec<String>,
    pub mk_mute: Vec<String>,
    /// W3: the user's device definitions that are on (defs.rs), each listened to only.
    pub defs: Vec<crate::defs::Active>,
}

pub enum Msg {
    RefreshAll,
    Refresh(String),
    /// A device arrived (or left): enumerate soon.
    Arrival,
    /// The computer woke from sleep: enumerate soon and ask everything due.
    Wake,
    Prefs(Prefs),
    Stop,
    Enumerated(u64, Vec<Candidate>),
    Answered(Ticket, Outcome),
    Returned(String, u64),
}

/// The loop's handle: messages in.
#[derive(Clone)]
pub struct Handle {
    tx: Sender<Msg>,
}

impl Handle {
    pub fn send(&self, m: Msg) -> bool {
        self.tx.send(m).is_ok()
    }
}

/// How long after an arrival the enumeration runs (a device brings several interfaces, one after another).
pub const ARRIVAL_SETTLE_MS: u64 = 1_500;

struct Loop<P: Platform> {
    platform: Arc<P>,
    sched: Scheduler,
    states: BTreeMap<String, DeviceState>,
    prefs: Prefs,
    tx: Sender<Msg>,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    /// The enumeration running: its seq and the clock time it is given up at.
    enum_running: Option<(u64, u64)>,
    enum_seq: u64,
    next_enum: u64,
}

fn timing(p: &Prefs) -> Timing {
    let d = Timing::default();
    Timing {
        interval_ms: if p.interval_ms == 0 { d.interval_ms } else { p.interval_ms.clamp(10_000, 3_600_000) },
        deadline_ms: if p.deadline_ms == 0 { d.deadline_ms } else { p.deadline_ms.clamp(200, 30_000) },
        max_backoff_ms: d.max_backoff_ms,
    }
}

impl<P: Platform> Loop<P> {
    fn now(&self) -> u64 {
        (self.clock)()
    }

    fn start_enumeration(&mut self, now: u64) {
        if self.enum_running.is_some() {
            return;
        }
        self.enum_seq += 1;
        let seq = self.enum_seq;
        // (Enumeration reads every device's properties: it gets twice a query's time, at least 5 s.)
        let give_up = now + (self.sched.timing().deadline_ms * 2).max(5_000);
        self.enum_running = Some((seq, give_up));
        self.next_enum = now.saturating_add(self.sched.timing().interval_ms);
        let (p, tx) = (self.platform.clone(), self.tx.clone());
        let spawned = thread::Builder::new().name("kt-battery-enum".into()).spawn(move || {
            let found = p.enumerate(now);
            let _ = tx.send(Msg::Enumerated(seq, found));
        });
        if spawned.is_err() {
            self.enum_running = None;
        }
    }

    fn apply_enumeration(&mut self, found: Vec<Candidate>, now: u64) {
        let merged = identity::merge(found, &self.prefs.links);
        let mut query_keys = Vec::new();
        let mut seen = Vec::new();
        for c in merged {
            let key = c.device.key.clone();
            seen.push(key.clone());
            let prev = self.states.remove(&key);
            let last_good = prev.as_ref().and_then(|p| p.last_good);
            let mut st = DeviceState { device: c.device, reading: None, last_good, status: Status::Waiting, checked_at: prev.as_ref().map_or(now, |p| p.checked_at) };
            if self.prefs.no_query.contains(&key) {
                st.status = Status::NotQueried;
            } else if c.offline {
                st.status = Status::NotConnected;
                st.checked_at = now;
            } else if needs_query(&st.device) {
                query_keys.push(key.clone());
                // (Kept until the next answer: a query does not blank what was read a minute ago.)
                if let Some(p) = prev {
                    st.reading = p.reading;
                    st.status = p.status;
                }
                if self.sched.is_asleep(&key) {
                    st.status = Status::Asleep;
                }
            } else if let Some(r) = c.reading {
                set_reading(&mut st, r, now);
            } else {
                st.status = Status::NoAnswer;
                st.checked_at = now;
            }
            self.states.insert(key, st);
        }
        self.states.retain(|k, _| seen.contains(k));
        self.sched.present(&query_keys, now);
        self.sched.set_no_query(&self.prefs.no_query);
    }

    fn launch_due(&mut self, now: u64) {
        for key in self.sched.due(now) {
            let Some(st) = self.states.get(&key) else { continue };
            let device = st.device.clone();
            let Some(ticket) = self.sched.start(&key, now) else { continue };
            let deadline = Instant::now() + Duration::from_millis(self.sched.timing().deadline_ms);
            let (p, tx, clock) = (self.platform.clone(), self.tx.clone(), self.clock.clone());
            let t2 = ticket.clone();
            let spawned = thread::Builder::new().name("kt-battery-query".into()).spawn(move || {
                let out = p.query(&device, deadline, clock());
                let _ = tx.send(Msg::Answered(t2.clone(), out));
                let _ = tx.send(Msg::Returned(t2.key, t2.seq));
            });
            if spawned.is_err() {
                self.sched.finish(&ticket, &Outcome::Failed, now);
                self.sched.worker_returned(&ticket.key, ticket.seq);
            }
        }
    }

    fn publish_list(&self) -> Vec<DeviceState> {
        self.states.values().cloned().collect()
    }
}

fn set_reading(st: &mut DeviceState, r: Reading, now: u64) {
    st.checked_at = now;
    if r.asleep {
        st.status = Status::Asleep;
        st.reading = None;
    } else {
        st.status = Status::Ok;
        st.reading = Some(r);
        if r.level != crate::model::Level::Unknown {
            st.last_good = Some(r);
        }
    }
}

/// Starts the loop on its own thread. `publish` gets the whole list after every change; `clock` is ms since the
/// epoch. Returns its handle and the thread (it ends on Msg::Stop or when every handle is dropped).
pub fn spawn<P: Platform>(platform: Arc<P>, prefs: Prefs, clock: Arc<dyn Fn() -> u64 + Send + Sync>, publish: Box<dyn Fn(Vec<DeviceState>) + Send>) -> std::io::Result<(Handle, thread::JoinHandle<()>)> {
    let (tx, rx) = mpsc::channel();
    let handle = Handle { tx: tx.clone() };
    platform.set_prefs(&prefs);
    let lp = Loop { platform, sched: Scheduler::new(timing(&prefs)), states: BTreeMap::new(), prefs, tx, clock, enum_running: None, enum_seq: 0, next_enum: 0 };
    let j = thread::Builder::new().name("kt-battery".into()).spawn(move || run(lp, rx, publish))?;
    Ok((handle, j))
}

fn run<P: Platform>(mut lp: Loop<P>, rx: Receiver<Msg>, publish: Box<dyn Fn(Vec<DeviceState>) + Send>) {
    loop {
        let now = lp.now();
        let mut changed = false;
        if lp.enum_running.is_none() && now >= lp.next_enum {
            lp.start_enumeration(now);
        }
        if let Some((_, give_up)) = lp.enum_running {
            if now >= give_up {
                // (A stuck enumeration: given up; its late result is dropped by its seq, the next one tried later.)
                lp.enum_running = None;
            }
        }
        for key in lp.sched.expire(now) {
            if let Some(st) = lp.states.get_mut(&key) {
                st.status = Status::NoAnswer;
                st.reading = None;
                st.checked_at = now;
                changed = true;
            }
        }
        lp.launch_due(now);
        if changed {
            publish(lp.publish_list());
        }
        let mut wake = lp.next_enum;
        if let Some((_, g)) = lp.enum_running {
            wake = wake.min(g);
        }
        if let Some(e) = lp.sched.next_event() {
            wake = wake.min(e);
        }
        let wait = Duration::from_millis(wake.saturating_sub(lp.now()).max(1));
        let msg = match rx.recv_timeout(wait) {
            Ok(m) => m,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        let now = lp.now();
        match msg {
            Msg::Stop => return,
            Msg::RefreshAll => {
                lp.sched.user_refresh(None, now);
                lp.next_enum = now;
            }
            Msg::Refresh(k) => {
                lp.sched.user_refresh(Some(&k), now);
                if lp.states.get(&k).map_or(true, |s| !needs_query(&s.device)) {
                    lp.next_enum = now;
                }
            }
            // (A device that comes back is new to the scheduler — its slot went with it —, so it is asked even if it
            // was asleep; one still present and asleep is left alone.)
            Msg::Arrival | Msg::Wake => lp.next_enum = lp.next_enum.min(now + ARRIVAL_SETTLE_MS),
            Msg::Prefs(p) => {
                lp.platform.set_prefs(&p);
                lp.sched.set_timing(timing(&p));
                lp.prefs = p;
                lp.sched.set_no_query(&lp.prefs.no_query);
                lp.next_enum = now;
            }
            Msg::Enumerated(seq, found) => {
                if lp.enum_running.map(|e| e.0) == Some(seq) {
                    lp.enum_running = None;
                    lp.apply_enumeration(found, now);
                    publish(lp.publish_list());
                }
            }
            Msg::Answered(t, out) => {
                if lp.sched.finish(&t, &out, now) == Done::Accepted {
                    if let Some(st) = lp.states.get_mut(&t.key) {
                        match out {
                            Outcome::Read(r) => set_reading(st, r, now),
                            Outcome::Asleep => {
                                st.status = Status::Asleep;
                                st.reading = None;
                                st.checked_at = now;
                            }
                            Outcome::NoAnswer | Outcome::Failed => {
                                st.status = Status::NoAnswer;
                                st.reading = None;
                                st.checked_at = now;
                            }
                        }
                    }
                    publish(lp.publish_list());
                }
            }
            Msg::Returned(k, seq) => lp.sched.worker_returned(&k, seq),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Charging, Kind, Level, Percent};
    use std::sync::Mutex;

    /// Three HID mice: «stuck» never answers (until the test ends), «slow» answers after 50 ms, «fast» at once; one
    /// Bluetooth headset comes with the enumeration.
    struct Fake {
        release: Mutex<Option<Receiver<()>>>,
        queries: Mutex<Vec<(String, u64)>>,
    }
    fn hid(key: &str) -> Candidate {
        let mut d = Device::new(key.into(), Source::HidGeneric);
        d.kind = Kind::Mouse;
        Candidate { device: d, reading: None, offline: false }
    }
    fn ms() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
    }
    impl Platform for Fake {
        fn enumerate(&self, now: u64) -> Vec<Candidate> {
            let mut bt = Device::new("bt:{H}".into(), Source::Bluetooth);
            bt.kind = Kind::Headset;
            let r = Reading::new(Level::Exact(Percent::new(70).unwrap()), Charging::Unknown, now);
            vec![hid("stuck"), hid("slow"), hid("fast"), Candidate { device: bt, reading: Some(r), offline: false }]
        }
        fn query(&self, d: &Device, _deadline: Instant, now: u64) -> Outcome {
            self.queries.lock().unwrap().push((d.key.clone(), ms()));
            match d.key.as_str() {
                "stuck" => {
                    let rx = self.release.lock().unwrap().take();
                    if let Some(rx) = rx {
                        let _ = rx.recv();
                    }
                    Outcome::Read(Reading::new(Level::Exact(Percent::new(1).unwrap()), Charging::No, now))
                }
                "slow" => {
                    thread::sleep(Duration::from_millis(50));
                    Outcome::Read(Reading::new(Level::Exact(Percent::new(40).unwrap()), Charging::Yes, now))
                }
                _ => Outcome::Read(Reading::new(Level::Exact(Percent::new(90).unwrap()), Charging::No, now)),
            }
        }
    }

    #[test]
    fn a_stuck_device_does_not_delay_the_others_and_its_late_answer_is_dropped() {
        let (rel_tx, rel_rx) = mpsc::channel();
        let fake = Arc::new(Fake { release: Mutex::new(Some(rel_rx)), queries: Mutex::new(Vec::new()) });
        let (pub_tx, pub_rx) = mpsc::channel::<(u64, Vec<DeviceState>)>();
        let publish = Box::new(move |l: Vec<DeviceState>| {
            let _ = pub_tx.send((ms(), l));
        });
        let start = ms();
        let prefs = Prefs { interval_ms: 60_000, deadline_ms: 400, ..Default::default() };
        let (h, j) = spawn(fake.clone(), prefs, Arc::new(ms), publish).unwrap();
        // (Wait for: fast and slow read, the Bluetooth level, and stuck given up — all within its deadline + slack.)
        let mut last: Vec<DeviceState> = Vec::new();
        let mut when_others_done = None;
        let mut when_stuck_given_up = None;
        while ms() - start < 3_000 {
            let Ok((at, l)) = pub_rx.recv_timeout(Duration::from_millis(100)) else { continue };
            let get = |k: &str| l.iter().find(|s| s.device.key == k).cloned();
            if when_others_done.is_none() && get("fast").map_or(false, |s| s.status == Status::Ok) && get("slow").map_or(false, |s| s.status == Status::Ok) {
                when_others_done = Some(at - start);
            }
            if get("stuck").map_or(false, |s| s.status == Status::NoAnswer) {
                when_stuck_given_up = Some(at - start);
            }
            last = l;
            if when_others_done.is_some() && when_stuck_given_up.is_some() {
                break;
            }
        }
        let others = when_others_done.expect("fast and slow answered");
        let stuck = when_stuck_given_up.expect("stuck was given up");
        assert!(others < 350, "the others did not wait for the stuck one ({} ms)", others);
        assert!(stuck >= 380 && stuck < 1_500, "given up at its deadline ({} ms)", stuck);
        let get = |k: &str| last.iter().find(|s| s.device.key == k).cloned().unwrap();
        assert_eq!(get("bt:{H}").reading.map(|r| r.level), Some(Level::Exact(Percent::new(70).unwrap())));
        assert_eq!(get("slow").reading.map(|r| r.charging), Some(Charging::Yes));
        // (The stuck call now returns: its answer is stale and dropped; the device keeps «no answer».)
        rel_tx.send(()).unwrap();
        thread::sleep(Duration::from_millis(100));
        let mut after = last.clone();
        while let Ok((_, l)) = pub_rx.try_recv() {
            after = l;
        }
        let s = after.iter().find(|s| s.device.key == "stuck").unwrap();
        assert_eq!(s.status, Status::NoAnswer, "a late answer is never shown as fresh");
        assert!(s.reading.is_none());
        // (Each device asked once: nothing asked again before its time, the stuck one never twice at once.)
        let q = fake.queries.lock().unwrap().clone();
        assert_eq!(q.iter().filter(|(k, _)| k == "stuck").count(), 1);
        assert_eq!(q.iter().filter(|(k, _)| k == "fast").count(), 1);
        // (A refresh of one device asks it alone.)
        h.send(Msg::Refresh("fast".into()));
        thread::sleep(Duration::from_millis(150));
        let q = fake.queries.lock().unwrap().clone();
        assert_eq!(q.iter().filter(|(k, _)| k == "fast").count(), 2);
        assert_eq!(q.iter().filter(|(k, _)| k == "slow").count(), 1);
        h.send(Msg::Stop);
        j.join().unwrap();
    }

    #[test]
    fn the_users_no_query_and_offline_devices() {
        static ASKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        struct P;
        impl Platform for P {
            fn enumerate(&self, _now: u64) -> Vec<Candidate> {
                let mut off = Device::new("bt:{O}".into(), Source::Bluetooth);
                off.kind = Kind::Keyboard;
                vec![hid("quiet"), Candidate { device: off, reading: None, offline: true }]
            }
            fn query(&self, _d: &Device, _dl: Instant, _now: u64) -> Outcome {
                ASKED.store(true, std::sync::atomic::Ordering::SeqCst);
                Outcome::NoAnswer
            }
        }
        let (pub_tx, pub_rx) = mpsc::channel::<Vec<DeviceState>>();
        let prefs = Prefs { no_query: vec!["quiet".into()], ..Default::default() };
        let (h, j) = spawn(Arc::new(P), prefs, Arc::new(ms), Box::new(move |l| {
            let _ = pub_tx.send(l);
        }))
        .unwrap();
        let l = pub_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        h.send(Msg::RefreshAll);
        thread::sleep(Duration::from_millis(100));
        assert_eq!(l.iter().find(|s| s.device.key == "quiet").unwrap().status, Status::NotQueried);
        let off = l.iter().find(|s| s.device.key == "bt:{O}").unwrap();
        assert_eq!(off.status, Status::NotConnected);
        assert!(off.reading.is_none());
        assert!(!ASKED.load(std::sync::atomic::Ordering::SeqCst), "a device the user said not to query was asked");
        h.send(Msg::Stop);
        j.join().unwrap();
    }
}
