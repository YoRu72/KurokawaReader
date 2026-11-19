// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): when each device is asked.
// Written for Kurokawa Tools against Wireless Device Battery Monitor's faults (NOTICE.md; PLAN-battery §9.1, §9.4, §9.7):
// one thread asked every device in turn, a stuck one held up the rest, a late reply was shown as fresh, every minute
// it asked devices that were asleep (waking their radios). Here each device has its own slot: its own next time, its
// own deadline, at most one query running (a stuck call is never stacked on), a reply taken only when it answers the
// query in flight (a late one is dropped), and a device last seen asleep is not asked again until the user asks or
// it arrives anew. A slot that does not answer is asked again later and later (doubling, up to a cap). Plain state
// over a clock the caller passes in (ms), so it is tested with a made-up clock; runner.rs drives it.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timing {
    /// Between two queries of a device that answered.
    pub interval_ms: u64,
    /// How long one query may take.
    pub deadline_ms: u64,
    /// The longest wait after queries that went unanswered.
    pub max_backoff_ms: u64,
}

impl Default for Timing {
    fn default() -> Timing {
        Timing { interval_ms: 60_000, deadline_ms: 4_000, max_backoff_ms: 30 * 60_000 }
    }
}

/// What one query gave.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Outcome {
    Read(crate::model::Reading),
    Asleep,
    NoAnswer,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ticket {
    pub key: String,
    pub seq: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Done {
    Accepted,
    /// Not the query in flight (it timed out, or the device is gone): dropped.
    Stale,
}

#[derive(Clone, Debug, Default)]
struct Slot {
    next_due: u64,
    in_flight: Option<(u64, u64)>,
    /// The seq of a call still running on its thread (maybe past its deadline): no other query starts meanwhile.
    running: Option<u64>,
    asleep: bool,
    misses: u32,
    no_query: bool,
}

pub struct Scheduler {
    timing: Timing,
    slots: BTreeMap<String, Slot>,
    seq: u64,
}

impl Scheduler {
    pub fn new(timing: Timing) -> Scheduler {
        Scheduler { timing, slots: BTreeMap::new(), seq: 0 }
    }
    pub fn timing(&self) -> Timing {
        self.timing
    }
    pub fn set_timing(&mut self, t: Timing) {
        self.timing = t;
    }
    pub fn keys(&self) -> Vec<String> {
        self.slots.keys().cloned().collect()
    }
    /// The devices that need queries, as this round's enumeration found them: new ones due now, gone ones dropped
    /// (a reply still coming for one is then stale).
    pub fn present(&mut self, keys: &[String], now: u64) {
        self.slots.retain(|k, _| keys.contains(k));
        for k in keys {
            self.slots.entry(k.clone()).or_insert_with(|| Slot { next_due: now, ..Default::default() });
        }
    }
    /// A device (re)arrived: asked now, even if it was asleep.
    pub fn arrived(&mut self, key: &str, now: u64) {
        if let Some(s) = self.slots.get_mut(key) {
            s.asleep = false;
            s.misses = 0;
            s.next_due = now;
        }
    }
    pub fn set_no_query(&mut self, keys: &[String]) {
        for (k, s) in self.slots.iter_mut() {
            s.no_query = keys.contains(k);
        }
    }
    pub fn is_asleep(&self, key: &str) -> bool {
        self.slots.get(key).map_or(false, |s| s.asleep)
    }
    fn eligible(s: &Slot) -> bool {
        !s.no_query && !s.asleep && s.in_flight.is_none() && s.running.is_none()
    }
    /// The devices to ask now.
    pub fn due(&self, now: u64) -> Vec<String> {
        self.slots.iter().filter(|(_, s)| Self::eligible(s) && s.next_due <= now).map(|(k, _)| k.clone()).collect()
    }
    /// A query of `key` starts: its ticket (None when it may not be asked now).
    pub fn start(&mut self, key: &str, now: u64) -> Option<Ticket> {
        let deadline = now + self.timing.deadline_ms;
        let s = self.slots.get_mut(key)?;
        if !Self::eligible(s) {
            return None;
        }
        self.seq += 1;
        s.in_flight = Some((self.seq, deadline));
        s.running = Some(self.seq);
        Some(Ticket { key: key.to_string(), seq: self.seq })
    }
    fn backoff(&self, misses: u32) -> u64 {
        let mul = 1u64 << misses.saturating_sub(1).min(16);
        self.timing.interval_ms.saturating_mul(mul).min(self.timing.max_backoff_ms.max(self.timing.interval_ms))
    }
    /// A query's answer: taken only when it is the query in flight.
    pub fn finish(&mut self, t: &Ticket, out: &Outcome, now: u64) -> Done {
        let interval = self.timing.interval_ms;
        let misses = match self.slots.get(&t.key) {
            Some(s) if s.in_flight.map(|f| f.0) == Some(t.seq) => s.misses,
            _ => return Done::Stale,
        };
        let next_miss = self.backoff(misses.saturating_add(1));
        let Some(s) = self.slots.get_mut(&t.key) else { return Done::Stale };
        s.in_flight = None;
        match out {
            Outcome::Read(_) => {
                s.asleep = false;
                s.misses = 0;
                s.next_due = now.saturating_add(interval);
            }
            Outcome::Asleep => {
                s.asleep = true;
                s.misses = 0;
                s.next_due = u64::MAX;
            }
            Outcome::NoAnswer | Outcome::Failed => {
                s.misses = misses.saturating_add(1);
                s.next_due = now.saturating_add(next_miss);
            }
        }
        Done::Accepted
    }
    /// The thread of query `seq` returned (in time or not): the device may be asked again.
    pub fn worker_returned(&mut self, key: &str, seq: u64) {
        if let Some(s) = self.slots.get_mut(key) {
            if s.running == Some(seq) {
                s.running = None;
            }
        }
    }
    /// Queries past their deadline: given up (their late answer will be stale), the device asked again later.
    pub fn expire(&mut self, now: u64) -> Vec<String> {
        let mut gone = Vec::new();
        let keys: Vec<String> = self.slots.iter().filter(|(_, s)| s.in_flight.map_or(false, |f| f.1 <= now)).map(|(k, _)| k.clone()).collect();
        for k in keys {
            let Some(misses) = self.slots.get(&k).map(|s| s.misses.saturating_add(1)) else { continue };
            let wait = self.backoff(misses);
            let Some(s) = self.slots.get_mut(&k) else { continue };
            s.in_flight = None;
            s.misses = misses;
            s.next_due = now.saturating_add(wait);
            gone.push(k);
        }
        gone
    }
    /// The user asked: one device, or all (None) — asleep ones too; never one he said not to query.
    pub fn user_refresh(&mut self, key: Option<&str>, now: u64) {
        for (k, s) in self.slots.iter_mut() {
            if key.map_or(true, |x| x == k) && !s.no_query {
                s.asleep = false;
                s.misses = 0;
                s.next_due = now;
            }
        }
    }
    /// When something is next to do: the earliest due time of an askable device or deadline of a running query.
    pub fn next_event(&self) -> Option<u64> {
        let due = self.slots.values().filter(|s| Self::eligible(s) && s.next_due != u64::MAX).map(|s| s.next_due);
        let dl = self.slots.values().filter_map(|s| s.in_flight.map(|f| f.1));
        due.chain(dl).min()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Charging, Level, Reading};

    fn t() -> Timing {
        Timing { interval_ms: 60_000, deadline_ms: 3_000, max_backoff_ms: 600_000 }
    }
    fn keys(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }
    fn read(at: u64) -> Outcome {
        Outcome::Read(Reading::new(Level::Unknown, Charging::Unknown, at))
    }

    #[test]
    fn each_device_has_its_own_time_and_a_stuck_one_delays_no_other() {
        let mut s = Scheduler::new(t());
        s.present(&keys(&["a", "b", "c"]), 0);
        assert_eq!(s.due(0), keys(&["a", "b", "c"]));
        let ta = s.start("a", 0).unwrap();
        let tb = s.start("b", 0).unwrap();
        let tc = s.start("c", 0).unwrap();
        // (b and c answer at once; a hangs.)
        assert_eq!(s.finish(&tb, &read(10), 10), Done::Accepted);
        s.worker_returned("b", tb.seq);
        assert_eq!(s.finish(&tc, &read(20), 20), Done::Accepted);
        s.worker_returned("c", tc.seq);
        assert_eq!(s.next_event(), Some(3_000), "a's deadline");
        assert_eq!(s.expire(2_999), Vec::<String>::new());
        assert_eq!(s.expire(3_000), keys(&["a"]));
        // (b and c come round on their own time; a is not asked while its call still runs.)
        assert_eq!(s.due(60_010), keys(&["b"]));
        assert_eq!(s.due(70_000), keys(&["b", "c"]), "a's thread has not returned: not asked again");
        // (a's late answer is stale; once its thread returns it is asked after its back-off.)
        assert_eq!(s.finish(&ta, &read(80_000), 80_000), Done::Stale);
        s.worker_returned("a", ta.seq);
        assert_eq!(s.due(80_000), keys(&["a", "b", "c"]), "a's back-off (one interval after the miss at 3 s) is over");
    }

    #[test]
    fn asleep_devices_are_left_alone_until_the_user_asks_or_they_arrive() {
        let mut s = Scheduler::new(t());
        s.present(&keys(&["m"]), 0);
        let tk = s.start("m", 0).unwrap();
        s.finish(&tk, &Outcome::Asleep, 100);
        s.worker_returned("m", tk.seq);
        assert!(s.is_asleep("m"));
        assert!(s.due(10_000_000).is_empty(), "never asked again on its own");
        assert_eq!(s.next_event(), None, "nothing to wake up for");
        s.user_refresh(Some("m"), 200);
        assert_eq!(s.due(200), keys(&["m"]));
        let tk = s.start("m", 200).unwrap();
        s.finish(&tk, &Outcome::Asleep, 300);
        s.worker_returned("m", tk.seq);
        s.arrived("m", 400);
        assert_eq!(s.due(400), keys(&["m"]));
    }

    #[test]
    fn misses_back_off_doubling_to_the_cap_and_an_answer_resets() {
        let mut s = Scheduler::new(t());
        s.present(&keys(&["x"]), 0);
        let mut now = 0;
        let mut waits = Vec::new();
        for _ in 0..6 {
            let tk = s.start("x", now).unwrap();
            s.finish(&tk, &Outcome::NoAnswer, now);
            s.worker_returned("x", tk.seq);
            let next = s.next_event().unwrap();
            waits.push(next - now);
            now = next;
        }
        assert_eq!(waits, vec![60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
        let tk = s.start("x", now).unwrap();
        s.finish(&tk, &read(now), now);
        s.worker_returned("x", tk.seq);
        assert_eq!(s.next_event(), Some(now + 60_000));
    }

    #[test]
    fn the_users_word_and_gone_devices() {
        let mut s = Scheduler::new(t());
        s.present(&keys(&["a", "b"]), 0);
        s.set_no_query(&keys(&["a"]));
        assert_eq!(s.due(0), keys(&["b"]));
        assert!(s.start("a", 0).is_none());
        s.user_refresh(None, 5);
        assert_eq!(s.due(5), keys(&["b"]), "refresh all never asks a device the user said not to");
        let tb = s.start("b", 5).unwrap();
        s.present(&keys(&["a"]), 6);
        assert_eq!(s.finish(&tb, &read(7), 7), Done::Stale, "the device went away: its answer is dropped");
        assert_eq!(s.keys(), keys(&["a"]));
    }

    #[test]
    fn a_reply_to_an_older_query_is_dropped() {
        let mut s = Scheduler::new(t());
        s.present(&keys(&["a"]), 0);
        let first = s.start("a", 0).unwrap();
        s.expire(3_000);
        s.worker_returned("a", first.seq);
        s.user_refresh(Some("a"), 3_001);
        let second = s.start("a", 3_001).unwrap();
        assert_eq!(s.finish(&first, &read(3_002), 3_002), Done::Stale);
        assert_eq!(s.finish(&second, &read(3_003), 3_003), Done::Accepted);
        s.worker_returned("a", first.seq);
        assert!(s.start("a", 3_004).is_none(), "the second call's thread still counts as running");
    }
}
