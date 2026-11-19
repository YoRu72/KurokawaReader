// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the sweep (a test only). The shell is built with panic = "abort": a panic
// in a reading thread closes the app. Every reader driver (mice/*.rs, heads/*.rs, pads/*.rs) is fed a made-up device
// that answers every request with random, short, empty or over-long reports, and every byte or text parser is fed
// random, short and empty input — nothing may panic. A small fixed-seed generator: the same run every time.
// Copyright (C) 2026 Kurokawa contributors. Std only.
#![cfg(test)]

use crate::allow::{AllowedWrite, HidIdent};
use crate::transport::{HidTransport, OpenMode, TErr};
use std::time::{Duration, Instant};

/// xorshift64*: enough for a sweep.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    /// Bytes of a length chosen among the edges (0, 1, 2, a report's size, beyond) or at random.
    fn bytes(&mut self, max: usize) -> Vec<u8> {
        let n = match self.below(6) {
            0 => 0,
            1 => 1,
            2 => 2 + self.below(6),
            3 => max,
            4 => max + 1 + self.below(8),
            _ => self.below(max + 1),
        };
        (0..n).map(|_| self.next() as u8).collect()
    }
    fn text(&mut self, max: usize) -> String {
        const BITS: &[&str] = &["\n", "\t", " ", ":", "=", "\"", "{", "}", "[", "]", ",", "0x", "-1", "999999999999999999999", "%", "percentage", "Battery", "Device", "yes", "no", "end\t", "k\t", "kt-battery-history 1\n", "kt-battery-history 2\n", "p", "s3/", "c", "away", "é", "🎧", "\u{0}", "\\", "Connected:", "Icon:", "Name:", "POWER_SUPPLY_CAPACITY=", "HID_ID=", "<key>", "<integer>", "|", "+-o ", "\"BatteryPercent\" = ", "true", "null", "kurokawaDevice", "match", "level"];
        let n = self.below(max);
        let mut s = String::new();
        for _ in 0..n {
            if self.below(3) == 0 {
                s.push((b'0' + self.below(10) as u8) as char);
            } else {
                s.push_str(BITS[self.below(BITS.len())]);
            }
        }
        s
    }
}

/// A made-up device: every request answered with random bytes (or nothing, or «gone»), every write taken.
struct Wild {
    id: HidIdent,
    rng: Rng,
    max: usize,
}
impl Wild {
    fn report(&mut self, first: Option<u8>) -> Vec<u8> {
        let mut r = self.rng.bytes(self.max);
        // (Often the report id asked for, so the reader looks further than its first check.)
        if let (Some(id), Some(b)) = (first, r.first_mut()) {
            if self.rng.below(2) == 0 {
                *b = id;
            }
        }
        r
    }
    fn fail(&mut self) -> Option<TErr> {
        match self.rng.below(12) {
            0 => Some(TErr::Timeout),
            1 => Some(TErr::BadReply),
            2 => Some(TErr::Failed("made up".into())),
            _ => None,
        }
    }
}
impl HidTransport for Wild {
    fn ident(&self) -> &HidIdent {
        &self.id
    }
    fn mode(&self) -> OpenMode {
        OpenMode::ReadWrite
    }
    fn get_feature(&mut self, report_id: u8, _len: usize, _deadline: Instant) -> Result<Vec<u8>, TErr> {
        if let Some(e) = self.fail() {
            return Err(e);
        }
        Ok(self.report(Some(report_id)))
    }
    fn get_input(&mut self, report_id: u8, _len: usize, _deadline: Instant) -> Result<Vec<u8>, TErr> {
        if let Some(e) = self.fail() {
            return Err(e);
        }
        Ok(self.report(Some(report_id)))
    }
    fn read_input(&mut self, deadline: Instant) -> Result<Vec<u8>, TErr> {
        crate::transport::left(deadline)?;
        if let Some(e) = self.fail() {
            return Err(e);
        }
        let id = self.rng.next() as u8;
        Ok(self.report(Some(id)))
    }
    fn feature_len(&self) -> usize {
        self.max
    }
    fn send_allowed(&mut self, _w: &AllowedWrite, _deadline: Instant) -> Result<(), TErr> {
        Ok(())
    }
}

fn soon() -> Instant {
    Instant::now() + Duration::from_millis(12)
}

#[test]
fn every_reader_driver_takes_wild_answers_without_a_panic() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let (mut asked, mut read) = (0usize, 0usize);
    for (n, m) in crate::mice::all_models().enumerate() {
        for round in 0..3u64 {
            let id = crate::mice::testkit::ident(m);
            let mut main = Wild { id: id.clone(), rng: Rng(rng.next() | 1), max: [8, 20, 33, 64, 65][(n + round as usize) % 5] };
            let mut reply = Wild { id: id.clone(), rng: Rng(rng.next() | 1), max: main.max };
            let mut long = Wild { id, rng: Rng(rng.next() | 1), max: 64 };
            let slot = if round == 2 { Some((rng.next() % 8) as u8) } else { None };
            let mut ch = crate::mice::Chans { main: &mut main, reply: if round == 1 { Some(&mut reply) } else { None }, long: if round == 2 { Some(&mut long) } else { None } };
            let a = crate::mice::read(&mut ch, m, slot, true, soon(), 1_800_000_000_000);
            asked += 1;
            read += usize::from(matches!(a.out, crate::sched::Outcome::Read(_)));
        }
    }
    for (n, m) in crate::pads::all_models().enumerate() {
        for round in 0..3u64 {
            let id = HidIdent { vid: m.vid, pid: m.pid, usage_page: m.page, usage: m.usages.first().copied().unwrap_or(5), interface: -1 };
            let mut t = Wild { id, rng: Rng(rng.next() | 1), max: [10, 64, 78, 100][(n + round as usize) % 4] };
            let o = crate::pads::read(&mut t, m, round == 1, round != 2, soon(), 1_800_000_000_000);
            asked += 1;
            read += usize::from(matches!(o, crate::sched::Outcome::Read(_)));
        }
    }
    // (The sweep reached the readers' own checks: some wild answers even read as something.)
    assert!(asked > 300 && read > 0, "asked {asked}, read {read}");
}

#[test]
fn every_byte_parser_takes_wild_input_without_a_panic() {
    let mut rng = Rng(0xD1B5_4A32_D192_ED03);
    for _ in 0..3_000 {
        let b = rng.bytes(80);
        let _ = crate::airpods::parse(&b, (rng.next() as i16).wrapping_neg(), rng.next());
        let _ = crate::fastpair::parse(&b);
        let _ = crate::galaxybuds::find_status(&b, rng.below(2) == 0);
        let _ = crate::nothingear::find_status(&b);
        let off = rng.below(1_000);
        let _ = crate::hidvalue::extract_bits(&b, if rng.below(4) == 0 { usize::MAX - rng.below(64) } else { off }, rng.below(40));
        let cap = crate::hidvalue::ValueCap {
            feature: rng.below(2) == 0,
            report_id: rng.next() as u8,
            usage_page: rng.next() as u16,
            usage: rng.next() as u16,
            link_collection: 0,
            logical_min: rng.next() as i32,
            logical_max: rng.next() as i32,
            bit_size: rng.next() as u16,
            report_count: rng.next() as u16,
        };
        let _ = crate::hidvalue::level_from_raw(rng.next() as u32, &cap, rng.below(2) == 0);
        let d = rng.bytes(300);
        for c in crate::hiddesc::parse(&d) {
            for f in &c.battery {
                let _ = crate::hiddesc::field_value(&c.battery, &f.cap, &b);
            }
        }
        // (A history row's bytes, as the file would carry them.)
        let _ = crate::history::History::parse(&String::from_utf8_lossy(&b), 1_795_000_000, 30 * 86_400);
    }
}

#[test]
fn every_text_parser_takes_wild_input_without_a_panic() {
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    for _ in 0..2_000 {
        let t = rng.text(60);
        let _ = crate::macparse::ioreg(&t);
        let _ = crate::macparse::json(&t);
        let _ = crate::macparse::system_profiler(&t);
        let _ = crate::macparse::kind_of_minor(&t);
        let _ = crate::upower::parse(&t);
        let _ = crate::upower::bluez_addr(&t);
        let _ = crate::bluez::clean(&t);
        let _ = crate::bluez::radio(&t);
        for (a, _) in crate::bluez::device_lines(&t) {
            let _ = crate::bluez::info(a, &t);
        }
        let _ = crate::bluez::info(rng.next(), &t);
        let _ = crate::bluez::end_of(&t, rng.below(2) == 0);
        let _ = crate::sysfs::uevent(&t);
        let _ = crate::sysfs::hid_id(&t);
        let _ = crate::sysfs::hid_dir_ids(&t);
        let _ = crate::sysfs::parse_power_supply(&t);
        let _ = crate::phonelink::parse(&t);
        let _ = crate::phonelink::charging_of(&t);
        let _ = crate::phonelink::reading(rng.next() as u8, rng.next(), rng.next());
        let _ = crate::history::History::parse(&t, rng.next() % 4_200_000_000, rng.next() % (100 * 86_400));
        let _ = crate::defs::parse(&t);
    }
    // (Short and empty input of each.)
    for t in ["", " ", "\n", "{", "[", "\"", "0x", "end\t", "kt-battery-history 2\nk\t\nend\t1\t0\n", "kt-battery-history 1\n\tx\nend\t\t\n"] {
        let _ = crate::macparse::ioreg(t);
        let _ = crate::macparse::json(t);
        let _ = crate::macparse::system_profiler(t);
        let _ = crate::upower::parse(t);
        let _ = crate::bluez::device_lines(t);
        let _ = crate::sysfs::parse_power_supply(t);
        let _ = crate::phonelink::parse(t);
        let _ = crate::history::History::parse(t, 1_795_000_000, 30 * 86_400);
        let _ = crate::defs::parse(t);
    }
}

#[test]
fn teach_proposals_take_wild_marks_without_a_panic() {
    use crate::teach::{Capture, MarkKind};
    let mut rng = Rng(0x1234_5678_9ABC_DEF1);
    let kinds = [MarkKind::Full, MarkKind::Half, MarkKind::Low, MarkKind::Charging, MarkKind::NotCharging];
    for _ in 0..200 {
        let mut c = Capture::default();
        let mut t = 1_000u64;
        for _ in 0..rng.below(60) {
            t += rng.below(3_000) as u64;
            let mut f = rng.bytes(40);
            if let Some(b) = f.first_mut() {
                *b %= 4;
            }
            c.push(t, &f);
            if rng.below(5) == 0 {
                let _ = c.mark(kinds[rng.below(kinds.len())], t);
            }
        }
        let p = c.propose();
        for l in &p.level {
            let _ = crate::teach::preview(l, &c);
        }
    }
}
