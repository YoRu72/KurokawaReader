//! Android stage M3: the torrent «director» — the brain of streaming a torrent while it downloads, in std-only Rust,
//! driving whichever socket engine the phone has through a narrow interface: piece priorities and deadlines. Today
//! that engine is libtorrent4j (KtEngine/KtStream: `piecePriority`, `setPieceDeadline`, `clearPieceDeadlines`), later
//! librqbit or an engine of our own. No I/O and no clock: the time (`now_ms`), the reader's position, the measured
//! download rate and which pieces are here are given; a `Plan` comes back.
//!
//! What it decides (where Java's KtStream rules are fixed numbers):
//! - the container's index first: the tail of the file (MKV cues, an MP4's moov at the end) asked at once beside the
//!   head, so the first frame does not wait for the whole head and then the tail one after the other;
//! - a read-ahead window sized from time, not bytes: the video's byte rate (told by the player, or measured from the
//!   reads) × a horizon that adapts — shorter when the swarm gives less than the video needs (all of it goes to what is
//!   watched next), longer when it gives more, short while the viewer is scrubbing (several seeks in a row);
//! - deadlines from when playback will reach each piece (its distance ÷ the byte rate), not a fixed step, so the
//!   engine's time-critical picking (and its end-game duplicate requests, which libtorrent does for pieces with a
//!   deadline) goes where the player will be;
//! - a seek seen at once (a jump out of the window, or backwards): the old deadlines dropped, the target asked first;
//! - after the window, a stretch at high priority with no deadline (kept busy without starving the window).
//! Peer choking, request pipelining and duplicate (end-game) requests stay the engine's: libtorrent4j gives Java no
//! per-peer choke or disconnect, so a peer policy here would have nothing to act through. Checked with
//! `rustc --edition 2021 --test tordirector.rs` — the tests include a deterministic simulated swarm that compares the
//! director with plain sequential and with Java's current rules (`--nocapture` prints the table).

use std::collections::VecDeque;

/// Where the watched file lies in the torrent.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Geometry {
    pub piece_len: u64,
    pub num_pieces: u64,
    /// The file's first byte in the torrent's byte space.
    pub file_off: u64,
    pub file_len: u64,
}

impl Geometry {
    /// The piece holding byte `pos` of the file (clamped to the file).
    pub fn piece_at(&self, pos: u64) -> u64 {
        let p = self.file_off + pos.min(self.file_len.saturating_sub(1));
        (p / self.piece_len.max(1)).min(self.num_pieces.saturating_sub(1))
    }
    pub fn first_piece(&self) -> u64 {
        self.piece_at(0)
    }
    pub fn last_piece(&self) -> u64 {
        self.piece_at(self.file_len.saturating_sub(1))
    }
    /// The file-relative byte where piece `k` starts (0 for a piece that begins before the file).
    pub fn piece_start(&self, k: u64) -> u64 {
        (k * self.piece_len).saturating_sub(self.file_off)
    }
}

/// What the engine is told to do now.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Plan {
    /// Drop every deadline laid before (a seek).
    pub clear_deadlines: bool,
    /// (piece, deadline in ms from now), most urgent first; the engine also gives these the top priority.
    pub deadlines: Vec<(u64, u64)>,
    /// Inclusive piece ranges at high priority, no deadline.
    pub high: Vec<(u64, u64)>,
    /// The read-ahead window this plan used, in bytes (diagnostics).
    pub window: u64,
    /// The horizon in seconds the window came from, and why (diagnostics: "start", "starved", "ample", "scrub", "even").
    pub horizon_s: u64,
    pub mode: &'static str,
}

pub const MIN_RATE: f64 = 256.0 * 1024.0;
/// A video's byte rate when nothing better is known: 8 Mbit/s.
pub const DEFAULT_RATE: f64 = 1024.0 * 1024.0;
const HEAD: u64 = 2 << 20;
const TAIL: u64 = 4 << 20;
const MIN_WINDOW: u64 = 8 << 20;
const MAX_WINDOW: u64 = 256 << 20;
const MAX_DEADLINES: usize = 600;

#[derive(Clone, Debug)]
pub struct Director {
    pub g: Geometry,
    hint: Option<f64>,
    consume: Option<f64>,
    down: Option<f64>,
    pos: u64,
    pos_ms: u64,
    opened_ms: u64,
    seeks: VecDeque<u64>,
    seek_pending: bool,
    window_end: u64,
    tail_done: bool,
}

impl Director {
    pub fn new(g: Geometry, now_ms: u64) -> Director {
        Director { g, hint: None, consume: None, down: None, pos: 0, pos_ms: now_ms, opened_ms: now_ms, seeks: VecDeque::new(), seek_pending: false, window_end: 0, tail_done: false }
    }

    /// The player's word: the file's size ÷ its length (bytes per second of video).
    pub fn hint_byte_rate(&mut self, bps: f64) {
        if bps.is_finite() && bps > 0.0 {
            self.hint = Some(bps.max(MIN_RATE));
        }
    }

    /// The torrent's measured download rate (bytes/s), smoothed.
    pub fn observe_rate(&mut self, bps: u64) {
        let b = bps as f64;
        self.down = Some(match self.down {
            Some(d) => d * 0.7 + b * 0.3,
            None => b,
        });
    }

    /// A read of the player at file byte `pos`. True when it is a seek (backwards by more than a piece, or ahead beyond
    /// the window laid last). Forward reads inside the window teach the consumption rate.
    pub fn read(&mut self, pos: u64, now_ms: u64) -> bool {
        let pos = pos.min(self.g.file_len);
        let back = pos + self.g.piece_len < self.pos;
        let ahead_limit = self.pos + self.window_end.saturating_sub(self.pos).max(MIN_WINDOW) + self.g.piece_len;
        let seek = back || pos > ahead_limit;
        if seek {
            self.seeks.push_back(now_ms);
            self.seek_pending = true;
        } else if pos > self.pos && now_ms > self.pos_ms + 400 {
            let r = (pos - self.pos) as f64 * 1000.0 / (now_ms - self.pos_ms) as f64;
            // (Bursts of a player filling its buffer read faster than the video plays; the smoothing and the cap keep
            // one burst from moving the estimate far.)
            let r = r.min(64.0 * 1024.0 * 1024.0);
            self.consume = Some(match self.consume {
                Some(c) => c * 0.8 + r * 0.2,
                None => r,
            });
        }
        if seek || pos >= self.pos || now_ms > self.pos_ms + 400 {
            self.pos = pos;
            self.pos_ms = now_ms;
        }
        while let Some(&t) = self.seeks.front() {
            if now_ms > t + 30_000 {
                self.seeks.pop_front();
            } else {
                break;
            }
        }
        seek
    }

    /// The byte rate the deadlines assume.
    pub fn rate(&self) -> f64 {
        self.hint.or(self.consume.map(|c| c.min(16.0 * 1024.0 * 1024.0))).unwrap_or(DEFAULT_RATE).max(MIN_RATE)
    }

    /// The plan for now. `have(k)`: piece k is here and checked.
    pub fn plan(&mut self, have: &dyn Fn(u64) -> bool, now_ms: u64) -> Plan {
        let g = self.g;
        let rate = self.rate();
        let scrub = self.seeks.len() >= 2;
        let starting = now_ms < self.opened_ms + 5_000 && self.pos < HEAD;
        let (horizon_s, mode) = if scrub {
            (8, "scrub")
        } else if starting {
            (20, "start")
        } else {
            match self.down {
                Some(d) if d < rate * 1.1 => (20, "starved"),
                Some(d) if d > rate * 3.0 => (60, "ample"),
                _ => (30, "even"),
            }
        };
        let window = ((rate * horizon_s as f64) as u64).clamp(MIN_WINDOW, MAX_WINDOW);
        let mut plan = Plan { clear_deadlines: self.seek_pending, window, horizon_s, mode, ..Default::default() };
        self.seek_pending = false;
        let cur = g.piece_at(self.pos);
        let end_byte = (self.pos + window).min(g.file_len.saturating_sub(1));
        let wend = g.piece_at(end_byte);
        self.window_end = end_byte;
        let mut dl: Vec<(u64, u64)> = Vec::new();
        for k in cur..=wend {
            if have(k) {
                continue;
            }
            let dist = g.piece_start(k).saturating_sub(self.pos) as f64;
            // (When playback reaches it, half of it — the safety share the simulated swarm below was tuned with —; never under 80 ms.)
            let ms = ((dist / rate) * 1000.0 * 0.5) as u64;
            dl.push((k, ms.max(80)));
            if dl.len() >= MAX_DEADLINES {
                break;
            }
        }
        // (The index at the end of the file: asked with the head while it is missing — a player opening the file reads
        // it right after the first bytes; after a seek too, if it is still not here.)
        if !self.tail_done {
            let t0 = g.piece_at(g.file_len.saturating_sub(TAIL.min(g.file_len)));
            let mut missing = false;
            for k in t0..=g.last_piece() {
                if k >= cur && k <= wend {
                    continue;
                }
                if !have(k) {
                    missing = true;
                    // (The last piece first: an MP4's moov or an MKV's cues end there.)
                    let ms = 150 + (g.last_piece() - k) * 40;
                    dl.push((k, ms));
                }
            }
            self.tail_done = !missing;
        }
        dl.sort_by_key(|&(k, ms)| (ms, k));
        plan.deadlines = dl;
        // (After the window: as much again at high priority, no deadline.)
        if wend < g.last_piece() {
            let hend = g.piece_at((end_byte + window).min(g.file_len.saturating_sub(1)));
            if hend > wend {
                plan.high.push((wend + 1, hend));
            }
        }
        plan
    }
}

/// Java's current streaming rules (KtEngine.prepareStream + KtStream.waitForPiece), in the same terms, kept here so the
/// simulated swarm can compare the director with what the phone does today. Not used by the app.
#[derive(Clone, Debug)]
pub struct JavaRules {
    pub g: Geometry,
    window_at: Option<u64>,
    pub byte_rate: Option<f64>,
}

impl JavaRules {
    pub fn new(g: Geometry) -> JavaRules {
        JavaRules { g, window_at: None, byte_rate: None }
    }
    /// prepareStream: head 8 MB top priority with deadlines (k−first)·300 ms; the next 24 MB and the last 4 MB high.
    pub fn open(&self, have: &dyn Fn(u64) -> bool) -> Plan {
        let g = self.g;
        let first = g.first_piece();
        let now = g.piece_at(8 << 20);
        let soon = g.piece_at(32 << 20);
        let tail = g.piece_at(g.file_len.saturating_sub(4 << 20));
        let mut p = Plan { mode: "java", ..Default::default() };
        for k in first..=g.last_piece() {
            if have(k) {
                continue;
            }
            if k <= now {
                p.deadlines.push((k, (k - first) * 300));
            } else if k <= soon || k >= tail {
                p.high.push((k, k));
            }
        }
        p
    }
    /// waitForPiece: on a new piece under the reader, the window ahead (rate·30 s or 48 MB, 16–256 MB, ≥ 12 pieces),
    /// deadlines 100 + 180·(k − piece); a jump drops the old deadlines. None when the piece is the one laid last.
    pub fn read(&mut self, pos: u64, have: &dyn Fn(u64) -> bool) -> Option<Plan> {
        let g = self.g;
        let piece = g.piece_at(pos);
        if self.window_at == Some(piece) {
            return None;
        }
        let want = self.byte_rate.map(|r| (r * 30.0) as u64).unwrap_or(48 << 20).clamp(16 << 20, 256 << 20);
        let ahead = (want / g.piece_len.max(1)).max(12);
        let mut p = Plan { mode: "java", window: want, ..Default::default() };
        if let Some(at) = self.window_at {
            if piece < at || piece > at + ahead {
                p.clear_deadlines = true;
            }
        }
        self.window_at = Some(piece);
        for k in piece..=(piece + ahead).min(g.last_piece()) {
            if !have(k) {
                p.deadlines.push((k, 100 + (k - piece) * 180));
            }
        }
        Some(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geo() -> Geometry {
        // (A 400 MB file after a 1 MB one, 256 KiB pieces.)
        let pl = 256 * 1024;
        let off = 1 << 20;
        let len = 400u64 << 20;
        Geometry { piece_len: pl, num_pieces: (off + len + pl - 1) / pl, file_off: off, file_len: len }
    }

    #[test]
    fn geometry() {
        let g = geo();
        assert_eq!(g.first_piece(), 4);
        assert_eq!(g.last_piece(), g.num_pieces - 1);
        assert_eq!(g.piece_start(4), 0);
        assert_eq!(g.piece_start(5), 256 * 1024);
        assert_eq!(g.piece_at(u64::MAX), g.last_piece());
    }

    #[test]
    fn first_plan_asks_head_and_tail_together() {
        let g = geo();
        let mut d = Director::new(g, 0);
        let p = d.plan(&|_| false, 0);
        assert!(!p.clear_deadlines);
        assert_eq!(p.mode, "start");
        // (The head's first piece and the file's last piece are both among the most urgent ten.)
        let top: Vec<u64> = p.deadlines.iter().take(10).map(|x| x.0).collect();
        assert!(top.contains(&g.first_piece()), "{:?}", top);
        assert!(top.contains(&g.last_piece()), "{:?}", top);
        // (Deadlines grow along the window; the window is 20 s at the default rate.)
        assert_eq!(p.window, 20 << 20);
        assert_eq!(p.high.first().map(|h| h.0), Some(g.piece_at(20 << 20) + 1));
        // (The tail, once here, is not asked again.)
        let tail0 = g.piece_at(g.file_len - (4 << 20));
        let p2 = d.plan(&|k| k >= tail0, 100);
        assert!(p2.deadlines.iter().all(|x| x.0 < tail0));
        let p3 = d.plan(&|_| false, 200);
        assert!(p3.deadlines.iter().all(|x| x.0 < tail0), "tail_done stays");
    }

    #[test]
    fn seeks_and_scrubbing() {
        let g = geo();
        let mut d = Director::new(g, 0);
        d.hint_byte_rate(1_000_000.0);
        assert!(!d.read(1 << 20, 1000));
        let _ = d.plan(&|_| false, 1000);
        assert!(d.read(300 << 20, 10_000), "a jump ahead is a seek");
        let p = d.plan(&|_| false, 10_000);
        assert!(p.clear_deadlines);
        assert_eq!(p.deadlines[0].0, g.piece_at(300 << 20));
        assert!(!d.plan(&|_| false, 10_100).clear_deadlines, "cleared once");
        assert!(d.read(100 << 20, 12_000), "backwards is a seek");
        assert_eq!(d.plan(&|_| false, 12_000).mode, "scrub");
        // (Thirty seconds on, the seeks are forgotten.)
        assert!(!d.read(101 << 20, 50_000));
        assert_ne!(d.plan(&|_| false, 50_000).mode, "scrub");
    }

    #[test]
    fn horizon_follows_the_swarm() {
        let g = geo();
        let mut d = Director::new(g, 0);
        d.hint_byte_rate(1_000_000.0);
        let _ = d.read(50 << 20, 6_000);
        d.observe_rate(500_000);
        assert_eq!(d.plan(&|_| false, 7_000).mode, "starved");
        for _ in 0..20 {
            d.observe_rate(8_000_000);
        }
        let p = d.plan(&|_| false, 8_000);
        assert_eq!(p.mode, "ample");
        assert_eq!(p.window, 60_000_000);
        // (Deadlines: when playback reaches the piece, ×0.5.)
        let (k, ms) = p.deadlines[p.deadlines.len() / 2];
        let dist = g.piece_start(k).saturating_sub(50 << 20) as f64;
        assert!((ms as f64 - (dist / 1_000_000.0 * 500.0)).abs() < 2.0 || ms == 80);
    }

    #[test]
    fn consumption_rate_learned_from_reads() {
        let g = geo();
        let mut d = Director::new(g, 0);
        let mut t = 0;
        for i in 0..40u64 {
            t += 1000;
            assert!(!d.read(i * 2_000_000, t));
        }
        assert!((d.rate() - 2_000_000.0).abs() < 200_000.0, "{}", d.rate());
    }

    #[test]
    fn java_rules_as_today() {
        let g = geo();
        let mut j = JavaRules::new(g);
        let o = j.open(&|_| false);
        assert_eq!(o.deadlines[0], (g.first_piece(), 0));
        assert!(o.high.iter().any(|h| h.0 == g.last_piece()));
        let p = j.read(0, &|_| false).unwrap();
        assert_eq!(p.deadlines[1].1, 280);
        assert!(j.read(1000, &|_| false).is_none());
        assert!(j.read(300 << 20, &|_| false).unwrap().clear_deadlines);
    }

    /* ---------- a simulated swarm (deterministic, seeded) ---------- */

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            // (xorshift64*)
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545F4914F6CDD1D)
        }
        fn f(&mut self) -> f64 {
            (self.next() >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    #[derive(Clone, Copy, PartialEq, Debug)]
    enum Who {
        Sequential,
        Java,
        Director,
    }

    struct Peer {
        rate: f64,
        has: Vec<bool>,
        busy: Option<(u64, f64)>,
    }

    /// The engine's picker, libtorrent-like: pieces with a deadline (earliest first), then high priority (lowest index),
    /// then in order (sequential mode, on for every strategy — Java turns it on for a stream). A peer takes one piece at
    /// a time; nobody takes a piece another peer is on (no end-game), except a deadline piece in the last second.
    struct Sim {
        g: Geometry,
        have: Vec<bool>,
        taken: Vec<u32>,
        deadline: Vec<Option<u64>>,
        high: Vec<bool>,
        peers: Vec<Peer>,
        now: u64,
        got_bytes: u64,
    }

    impl Sim {
        fn new(g: Geometry, seed: u64, total_rate: f64) -> Sim {
            let mut r = Rng(seed.wrapping_mul(0x9E3779B97F4A7C15).wrapping_add(1));
            let n = 12;
            let mut peers = Vec::new();
            let mut weights: Vec<f64> = (0..n).map(|_| 0.2 + r.f()).collect();
            let sum: f64 = weights.iter().sum();
            for w in weights.iter_mut() {
                *w /= sum;
            }
            for (i, w) in weights.into_iter().enumerate() {
                // (Peer 0 a seed; the others hold 40–95 % of the pieces.)
                let p = if i == 0 { 1.0 } else { 0.4 + 0.55 * r.f() };
                let has = (0..g.num_pieces).map(|_| r.f() < p).collect();
                peers.push(Peer { rate: total_rate * w, has, busy: None });
            }
            let np = g.num_pieces as usize;
            Sim { g, have: vec![false; np], taken: vec![0; np], deadline: vec![None; np], high: vec![false; np], peers, now: 0, got_bytes: 0 }
        }
        fn apply(&mut self, p: &Plan) {
            if p.clear_deadlines {
                for d in self.deadline.iter_mut() {
                    *d = None;
                }
            }
            for &(k, ms) in &p.deadlines {
                self.deadline[k as usize] = Some(self.now + ms);
            }
            for &(a, b) in &p.high {
                for k in a..=b {
                    self.high[k as usize] = true;
                }
            }
        }
        fn pick(&self, i: usize) -> Option<u64> {
            let peer = &self.peers[i];
            let free = |k: usize| !self.have[k] && peer.has[k] && self.taken[k] == 0;
            let mut best: Option<(u64, usize)> = None;
            for (k, d) in self.deadline.iter().enumerate() {
                if let Some(t) = d {
                    let late = *t <= self.now + 1000 && !self.have[k] && peer.has[k] && self.taken[k] < 2;
                    if (free(k) || late) && best.map_or(true, |b| *t < b.0) {
                        best = Some((*t, k));
                    }
                }
            }
            if let Some((_, k)) = best {
                return Some(k as u64);
            }
            let (a, b) = (self.g.first_piece() as usize, self.g.last_piece() as usize);
            if let Some(k) = (a..=b).find(|&k| self.high[k] && free(k)) {
                return Some(k as u64);
            }
            (a..=b).find(|&k| free(k)).map(|k| k as u64)
        }
        fn step(&mut self, dt_ms: u64) {
            self.now += dt_ms;
            for i in 0..self.peers.len() {
                if self.peers[i].busy.is_none() {
                    if let Some(k) = self.pick(i) {
                        self.taken[k as usize] += 1;
                        self.peers[i].busy = Some((k, 0.0));
                    }
                }
                let rate = self.peers[i].rate;
                if let Some((k, got)) = self.peers[i].busy {
                    let got = got + rate * dt_ms as f64 / 1000.0;
                    if self.have[k as usize] {
                        // (Another peer finished it first: this one moves on.)
                        self.taken[k as usize] -= 1;
                        self.peers[i].busy = None;
                    } else if got >= self.g.piece_len as f64 {
                        self.have[k as usize] = true;
                        self.taken[k as usize] -= 1;
                        self.deadline[k as usize] = None;
                        self.got_bytes += self.g.piece_len;
                        self.peers[i].busy = None;
                    } else {
                        self.peers[i].busy = Some((k, got));
                    }
                }
            }
        }
        fn has_range(&self, a: u64, b: u64) -> bool {
            (self.g.piece_at(a)..=self.g.piece_at(b)).all(|k| self.have[k as usize])
        }
    }

    #[derive(Debug, Clone, Copy)]
    struct Run {
        ttff_ms: u64,
        seek_ms: u64,
        stall_ms: u64,
    }

    /// Open the file (first frame: its first 2 MB and its last 1 MB here — an MP4 with its index at the end); play;
    /// at 30 s seek to 65 %; the seek target is reached when 2 MB from there are here; then 90 s of playback, stalls
    /// counted.
    fn run(who: Who, seed: u64, total_rate: f64, byte_rate: f64) -> Run {
        let g = geo();
        let mut s = Sim::new(g, seed, total_rate);
        let mut dir = Director::new(g, 0);
        dir.hint_byte_rate(byte_rate);
        let mut java = JavaRules::new(g);
        java.byte_rate = Some(byte_rate);
        let have_of = |s: &Sim| s.have.clone();
        match who {
            Who::Sequential => {}
            Who::Java => {
                let h = have_of(&s);
                let p = java.open(&|k| h[k as usize]);
                s.apply(&p);
            }
            Who::Director => {
                let h = have_of(&s);
                let p = dir.plan(&|k| h[k as usize], 0);
                s.apply(&p);
            }
        }
        let dt = 50;
        let mut pos: u64 = 0;
        let mut ttff = None;
        let mut seek_at = None;
        let mut seek_done = None;
        let mut stall = 0;
        let target = g.file_len * 65 / 100;
        let end_ms = 400_000;
        let mut last_plan = 0;
        while s.now < end_ms {
            s.step(dt);
            let now = s.now;
            if ttff.is_none() {
                if s.has_range(0, (2 << 20) - 1) && s.has_range(g.file_len - (1 << 20), g.file_len - 1) {
                    ttff = Some(now);
                }
            }
            if seek_at.is_none() && now >= 30_000 {
                seek_at = Some(now);
                pos = target;
            } else if seek_at.is_some() && seek_done.is_none() {
                if s.has_range(target, target + (2 << 20) - 1) {
                    seek_done = Some(now);
                }
            } else if let Some(sd) = seek_done {
                if now > sd + 90_000 {
                    break;
                }
            }
            // (Playback: on when the bytes under the position are here.)
            let playing = ttff.is_some() && (seek_at.is_none() || seek_done.is_some());
            if playing {
                let next = (pos + (byte_rate * dt as f64 / 1000.0) as u64).min(g.file_len - 1);
                if s.has_range(pos, next) {
                    pos = next;
                } else if seek_done.is_some() {
                    stall += dt;
                }
            }
            // (What each strategy is told: the reads as the player makes them, a plan every 500 ms for the director.)
            match who {
                Who::Sequential => {}
                Who::Java => {
                    let h = have_of(&s);
                    if let Some(p) = java.read(pos, &|k| h[k as usize]) {
                        s.apply(&p);
                    }
                }
                Who::Director => {
                    let sk = dir.read(pos, now);
                    if now % 1000 == 0 {
                        dir.observe_rate((s.got_bytes as f64 * 1000.0 / now as f64) as u64);
                    }
                    if sk || now >= last_plan + 500 {
                        last_plan = now;
                        let h = have_of(&s);
                        let p = dir.plan(&|k| h[k as usize], now);
                        s.apply(&p);
                    }
                }
            }
        }
        let t = ttff.unwrap_or(end_ms);
        let sk = match (seek_at, seek_done) {
            (Some(a), Some(b)) => b - a,
            _ => end_ms,
        };
        Run { ttff_ms: t, seek_ms: sk, stall_ms: stall }
    }

    #[test]
    fn simulated_swarm_director_vs_sequential_vs_java() {
        let mut rows = Vec::new();
        // (Fast: the swarm gives 4 MB/s for a 1 MB/s video; tight: 1.4 MB/s.)
        for (label, total) in [("fast 4 MB/s", 4.0e6), ("tight 1.4 MB/s", 1.4e6)] {
            let mut sums = [[0u64; 3]; 3];
            for seed in 1..=5u64 {
                for (i, who) in [Who::Sequential, Who::Java, Who::Director].into_iter().enumerate() {
                    let r = run(who, seed, total, 1.0e6);
                    sums[i][0] += r.ttff_ms;
                    sums[i][1] += r.seek_ms;
                    sums[i][2] += r.stall_ms;
                }
            }
            for (i, name) in ["plain sequential", "Java today", "director"].iter().enumerate() {
                rows.push(format!("| {} | {} | {:.1} s | {:.1} s | {:.1} s |", label, name, sums[i][0] as f64 / 5000.0, sums[i][1] as f64 / 5000.0, sums[i][2] as f64 / 5000.0));
            }
            // (The director beats plain sequential on both, in each swarm, and is never worse than Java's rules by
            // more than a tenth on the first frame.)
            assert!(sums[2][0] < sums[0][0], "{}: first frame {:?}", label, sums);
            assert!(sums[2][1] < sums[0][1], "{}: seek {:?}", label, sums);
            assert!(sums[2][0] * 10 <= sums[1][0] * 11, "{}: first frame vs Java {:?}", label, sums);
            assert!(sums[2][1] * 10 <= sums[1][1] * 11, "{}: seek vs Java {:?}", label, sums);
        }
        println!("| swarm | strategy | time to first frame | time to seek target (65 %) | stalls in 90 s after |");
        println!("|---|---|---:|---:|---:|");
        for r in rows {
            println!("{}", r);
        }
    }

    #[test]
    fn simulation_is_deterministic() {
        let a = run(Who::Director, 3, 2.0e6, 1.0e6);
        let b = run(Who::Director, 3, 2.0e6, 1.0e6);
        assert_eq!((a.ttff_ms, a.seek_ms, a.stall_ms), (b.ttff_ms, b.seek_ms, b.stall_ms));
    }
}
