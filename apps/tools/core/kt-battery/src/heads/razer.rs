// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Razer BlackShark headsets on their own vendor protocols (VID 1532).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/razer_headset.cpp (PollBlackSharkV2HyperSpeed, PollBlackSharkV2Pro2020, PollBlackSharkV3X, the V3 / V3 Pro
// loop of PollRazerHeadsets) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its references: OpenRazer pull requests 2794 and 2899, justik13/razer-blackshark-v2-hyperspeed-webhid,
// HeyOkay/HaloBattery, openrazer issue 1280.
//   V2 HyperSpeed (dongle 0565, vendor collection FF14, else FF00): 64-byte output 02: [02][00][seq 60–7F][00 00 00][04]
//     [00][00][80][cmd][00 …][62] = XOR of 0–61; GET 21 battery, 2A charging; reply echoes seq and cmd, [12] ≥ 1,
//     [62] = XOR of 1–61, value [13].
//   V2 Pro 2020 (receiver 0528, interface 3, FF00:0001, 64-byte feature FF): set FF 0A 00 FD 04 12 F1 02 05, then
//     feature FF read back (up to five times, 100 ms apart): FF 0F 05 FE 12 04 1F 08 05 … fresh — [11] 09 charging,
//     [12–13] mV, [14] percent (not while charging: the receiver jumps to 80 %); FF 01 00 FE 12 04 1F 08 05 on the last
//     read: the headset is off.
//   V3 X (057D dongle, 057C cable, interface 0, 64-byte feature 07): [07][00][txid][00 00 00][02][07][80|84][00 …]
//     [62] = XOR of 3–60; read back after 60 ms: [2] txid, [7] 07, [8] cmd, [6] ≥ 2, status [1] 02 / 01, value [10].
//   V3 / V3 Pro (0576 / 0577 V3 Pro, 0579 / 057A V3, interface 5): 64-byte output 02 [60] … GET class 21 → [13] percent,
//     [14] charging.
// D1 (the original's v1.1.0 razer_headset.cpp at commit 7cc44f2): GET class 2A after the battery — [13] = 1 while
// charging on the cable —, and 0576 / 0579 named as the cables (0577 / 057A the receivers): one card by the pair rule.
// Changed here: the V3 / V3 Pro «handshake» the original sent before each read (three packets of classes 02 and 2A with
// direction 00 — not documented as reads) is not sent: only GET 21; a headset that answers only after Synapse's
// handshake says «no answer». Their link drops when asked every few seconds: asked at most every five minutes
// (Model::gap — the last reading shown with its own time meanwhile; the original kept it in a global). Not ported: the
// BlackShark V2 Pro 2023 (0555) and the Barracuda X (0550, 0552) — every query there is wrapped in a «remote mode»
// switch of the receiver (and on 0552 an «app mode» switch, on 0555 a sacrificial frame to wake the link): mode
// changes, not reads.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::mice::*;
use crate::model::{Charging, Kind, Level};
use crate::sched::Outcome;
use crate::transport::TErr;
use std::time::Instant;

const V: u16 = 0x1532;
const fn hs(driver: &'static str, pid: u16, name: &'static str, via: Via) -> Model {
    Model::new(driver, V, pid, name, Kind::Headset, via)
}

pub static MODELS: &[Model] = &[
    hs("hs-razer-hs", 0x0565, "Razer BlackShark V2 HyperSpeed", Via::Receiver).page(0xFF14).usage(1).output(Len::Min(64)).input(Len::Min(64)),
    hs("hs-razer-hs", 0x0565, "Razer BlackShark V2 HyperSpeed", Via::Receiver).page(0xFF00).usage(1).output(Len::Min(64)).input(Len::Min(64)),
    hs("hs-razer-v2pro", 0x0528, "Razer BlackShark V2 Pro (2020)", Via::Receiver).iface(3).page(0xFF00).usage(1).feature(Len::Eq(64)),
    hs("hs-razer-v3x", 0x057D, "Razer BlackShark V3 X", Via::Receiver).iface(0).feature(Len::Min(64)).gap(300),
    hs("hs-razer-v3x", 0x057C, "Razer BlackShark V3 X", Via::Cable).iface(0).feature(Len::Min(64)).gap(300),
    hs("hs-razer-v3", 0x0576, "Razer BlackShark V3 Pro", Via::Cable).iface(5).output(Len::Min(64)).input(Len::Min(15)).gap(300).pair("rz:v3pro"),
    hs("hs-razer-v3", 0x0577, "Razer BlackShark V3 Pro", Via::Receiver).iface(5).output(Len::Min(64)).input(Len::Min(15)).gap(300).pair("rz:v3pro"),
    hs("hs-razer-v3", 0x0579, "Razer BlackShark V3", Via::Cable).iface(5).output(Len::Min(64)).input(Len::Min(15)).gap(300).pair("rz:v3"),
    hs("hs-razer-v3", 0x057A, "Razer BlackShark V3", Via::Receiver).iface(5).output(Len::Min(64)).input(Len::Min(15)).gap(300).pair("rz:v3"),
];

pub const HS_BATTERY: u8 = 0x21;
pub const HS_CHARGING: u8 = 0x2A;

/// V2 HyperSpeed's GET frame for `cmd` with `seq` (60–7F).
pub fn hs_frame(cmd: u8, seq: u8) -> [u8; 64] {
    let mut b = [0u8; 64];
    b[0] = 0x02;
    b[2] = seq;
    b[6] = 0x04;
    b[9] = 0x80;
    b[10] = cmd;
    b[62] = xor8(&b[..62]);
    b
}
/// allow.rs's check of a V2 HyperSpeed frame: its XOR byte.
pub fn hs_check(b: &[u8]) -> bool {
    b.len() == 64 && xor8(&b[..62]) == b[62]
}

/// V2 Pro 2020: the feature report that asks the receiver for the headset's status.
pub const V2PRO: [u8; 9] = [0xFF, 0x0A, 0x00, 0xFD, 0x04, 0x12, 0xF1, 0x02, 0x05];
const V2PRO_FRESH: [u8; 9] = [0xFF, 0x0F, 0x05, 0xFE, 0x12, 0x04, 0x1F, 0x08, 0x05];
const V2PRO_OFF: [u8; 9] = [0xFF, 0x01, 0x00, 0xFE, 0x12, 0x04, 0x1F, 0x08, 0x05];

/// V3 X's GET feature report for `cmd` (80 battery, 84 charging) with transaction id `txid` (01–FF).
pub fn v3x_frame(cmd: u8, txid: u8) -> [u8; 64] {
    let mut b = [0u8; 64];
    b[0] = 0x07;
    b[2] = txid;
    b[6] = 0x02;
    b[7] = 0x07;
    b[8] = cmd;
    b[62] = xor8(&b[3..=60]);
    b
}
pub fn v3x_check(b: &[u8]) -> bool {
    b.len() == 64 && xor8(&b[3..=60]) == b[62]
}

/// V3 / V3 Pro: GET class 21 (battery), direction 80 (to the headset).
pub const fn v3_get_of(class: u8) -> [u8; 64] {
    let mut b = [0u8; 64];
    b[0] = 0x02;
    b[2] = 0x60;
    b[6] = 0x04;
    b[9] = 0x80;
    b[10] = class;
    let mut x = 0u8;
    let mut i = 0;
    while i < 62 {
        x ^= b[i];
        i += 1;
    }
    b[62] = x;
    b
}
pub const fn v3_get() -> [u8; 64] {
    v3_get_of(0x21)
}
pub const V3_GET: [u8; 64] = v3_get();
/// D1: GET class 2A, the charging state (v1.1.0 reads it after the battery: its [13] = 1 charging on the cable).
pub const V3_CHARGING: [u8; 64] = v3_get_of(0x2A);

/// A sequence number from the clock (each request its own, so a reply is tied to it).
fn seq_of(now: u64, k: u8) -> u8 {
    0x60 | (((now / 1000) as u8).wrapping_add(k) & 0x1F)
}

fn hs_get(ch: &mut Chans, cmd: u8, seq: u8, deadline: Instant) -> Result<u8, TErr> {
    let f = hs_frame(cmd, seq);
    out_ask(ch, &f, ms(650), deadline, &mut |r| {
        if r.len() < 64 || r[0] != 0x02 || r[2] != seq || r[10] != cmd || r[12] < 1 || xor8(&r[1..62]) != r[62] {
            None
        } else {
            Some(r[13])
        }
    })
}

fn read_hs(ch: &mut Chans, now: u64, deadline: Instant) -> Outcome {
    match hs_get(ch, HS_BATTERY, seq_of(now, 0), deadline) {
        Ok(v) if v <= 100 => {
            let c = match hs_get(ch, HS_CHARGING, seq_of(now, 1), deadline) {
                Ok(c) => charging(c > 0),
                Err(_) => Charging::Unknown,
            };
            got(pct(i64::from(v)).unwrap_or(Level::Unknown), c, now)
        }
        Ok(_) => no_level(Charging::Unknown, now),
        Err(e) => failed(&e),
    }
}

fn read_v2pro(ch: &mut Chans, now: u64, deadline: Instant) -> Outcome {
    if let Err(e) = send(&mut *ch.main, crate::allow::ReportKind::Feature, &V2PRO, deadline) {
        return failed(&e);
    }
    for i in 0..5 {
        pause(ms(100), deadline);
        let r = match ch.main.get_feature(0xFF, 64, deadline) {
            Ok(r) if r.len() == 64 => r,
            Ok(_) => continue,
            Err(TErr::Timeout) => return Outcome::NoAnswer,
            Err(e) => return failed(&e),
        };
        if r[..9] == V2PRO_FRESH {
            let mv = u32::from(r[12]) << 8 | u32::from(r[13]);
            if mv == 0 {
                return unlinked(now);
            }
            let c = r[11] == 0x09;
            // (While charging the receiver's figure is not the battery's: charging, no level — as the original.)
            if c {
                return no_level(Charging::Yes, now);
            }
            return got(pct(i64::from(r[14])).unwrap_or(Level::Unknown), Charging::No, now);
        }
        if i == 4 && r[..9] == V2PRO_OFF {
            return unlinked(now);
        }
    }
    Outcome::NoAnswer
}

/// V3 X's transaction id for try `k` of `cmd`, from the clock (01–FF).
fn txid_of(now: u64, cmd: u8, k: u8) -> u8 {
    ((now / 1000) as u8).wrapping_mul(8).wrapping_add(k).wrapping_add(if cmd == 0x84 { 4 } else { 0 }).max(1)
}

fn v3x_get(ch: &mut Chans, cmd: u8, now: u64, deadline: Instant) -> Result<u8, TErr> {
    let mut last = Err(TErr::BadReply);
    for k in 0..4u8 {
        let txid = txid_of(now, cmd, k);
        let f = v3x_frame(cmd, txid);
        if let Err(e) = send(&mut *ch.main, crate::allow::ReportKind::Feature, &f, deadline) {
            return Err(e);
        }
        pause(ms(60), deadline);
        let r = match ch.main.get_feature(0x07, 64, deadline) {
            Ok(r) => r,
            Err(TErr::Timeout) => return Err(TErr::Timeout),
            Err(e) => {
                last = Err(e);
                continue;
            }
        };
        if r.len() < 63 || r[2] != txid || r[7] != 0x07 || r[8] != cmd || r[6] < 2 {
            continue;
        }
        if r[1] != 0x02 && r[1] != 0x01 {
            return Err(TErr::BadReply);
        }
        return Ok(r[10]);
    }
    last
}

fn read_v3x(ch: &mut Chans, now: u64, deadline: Instant) -> Outcome {
    match v3x_get(ch, 0x80, now, deadline) {
        Ok(v) if v <= 100 => {
            let c = match v3x_get(ch, 0x84, now, deadline) {
                Ok(c) => charging(c == 1),
                Err(_) => Charging::Unknown,
            };
            got(pct(i64::from(v)).unwrap_or(Level::Unknown), c, now)
        }
        Ok(_) => no_level(Charging::Unknown, now),
        Err(TErr::BadReply) => unlinked(now),
        Err(e) => failed(&e),
    }
}

fn read_v3(ch: &mut Chans, now: u64, deadline: Instant) -> Outcome {
    match out_ask(ch, &V3_GET, ms(600), deadline, &mut |r| if r.len() >= 15 && r[0] == 0x02 && r[2] == 0x60 && r[10] == 0x21 { Some((r[13], r[14])) } else { None }) {
        Ok((p, c)) if p <= 100 => {
            let cable = c == 0 && out_ask(ch, &V3_CHARGING, ms(600), deadline, &mut |r| if r.len() >= 15 && r[0] == 0x02 && r[2] == 0x60 && r[10] == 0x2A { Some(r[13]) } else { None }) == Ok(1);
            got(pct(i64::from(p)).unwrap_or(Level::Unknown), charging(c != 0 || cable), now)
        }
        Ok(_) => no_level(Charging::Unknown, now),
        Err(e) => failed(&e),
    }
}

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    match m.driver {
        "hs-razer-hs" => read_hs(ch, now, deadline),
        "hs-razer-v2pro" => read_v2pro(ch, now, deadline),
        "hs-razer-v3x" => read_v3x(ch, now, deadline),
        _ => read_v3(ch, now, deadline),
    }
}

#[cfg(test)]
mod tests {
    use crate::mice::testkit::*;
    use super::*;
    use crate::allow::{permit, ReportKind};

    fn hs_reply(cmd: u8, seq: u8, v: u8) -> Vec<u8> {
        let mut r = vec![0u8; 64];
        r[0] = 0x02;
        r[2] = seq;
        r[10] = cmd;
        r[12] = 1;
        r[13] = v;
        r[62] = xor8(&r[1..62]);
        r
    }

    #[test]
    fn v2_hyperspeed() {
        let m = model("hs-razer-hs", 0x0565);
        let mut f = fake(m);
        let (s0, s1) = (seq_of(7, 0), seq_of(7, 1));
        f.replies.extend([vec![hs_reply(0x21, s0, 64)], vec![hs_reply(0x2A, s1, 1)]]);
        assert_eq!(read1(&mut f, m), at(pctl(64), Charging::Yes));
        assert_eq!(f.sent, vec![hs_frame(0x21, s0).to_vec(), hs_frame(0x2A, s1).to_vec()]);
        // (A reply to another sequence number, a broken XOR, a short one: not taken.)
        let mut f = fake(m);
        let mut bad = hs_reply(0x21, s0, 64);
        bad[62] ^= 1;
        f.replies.extend([vec![hs_reply(0x21, 0x7F, 50), bad, vec![0x02, 0x00]]]);
        assert_eq!(read1(&mut f, m), Outcome::NoAnswer);
        // (The template: every sequence number 60–7F with its XOR; another byte, a wrong XOR, a SET: refused.)
        let id = ident(m);
        for s in 0x60..=0x7F {
            assert!(permit(&id, ReportKind::Output, &hs_frame(0x21, s)).is_some());
        }
        assert!(permit(&id, ReportKind::Output, &hs_frame(0x21, 0x5F)).is_none());
        assert!(permit(&id, ReportKind::Output, &hs_frame(0x22, 0x60)).is_none());
        let mut w = hs_frame(0x2A, 0x61);
        w[62] ^= 0x10;
        assert!(permit(&id, ReportKind::Output, &w).is_none());
        let mut set = hs_frame(0x21, 0x60);
        set[9] = 0x00;
        set[62] = xor8(&set[..62]);
        assert!(permit(&id, ReportKind::Output, &set).is_none(), "direction 00: not a GET to the headset");
    }

    #[test]
    fn v2_pro_2020() {
        let m = model("hs-razer-v2pro", 0x0528);
        let mut f = fake(m);
        let mut r = vec![0u8; 64];
        r[..9].copy_from_slice(&V2PRO_FRESH);
        r[12] = 0x0F;
        r[13] = 0x80;
        r[14] = 72;
        f.feature_replies.push_back(r.clone());
        assert_eq!(read1(&mut f, m), at(pctl(72), Charging::No));
        assert_eq!(f.sent, vec![V2PRO.to_vec()]);
        let mut f = fake(m);
        r[11] = 0x09;
        f.feature_replies.push_back(r.clone());
        assert_eq!(read1(&mut f, m), no_level(Charging::Yes, 7), "charging: no level");
        let mut f = fake(m);
        let mut off = vec![0u8; 64];
        off[..9].copy_from_slice(&V2PRO_OFF);
        f.feature_replies.push_back(off);
        assert_eq!(read1(&mut f, m), unlinked(7));
        let mut f = fake(m);
        f.feature_replies.push_back(vec![0xFF, 0x0F]);
        assert_eq!(read1(&mut f, m), Outcome::NoAnswer, "short");
    }

    #[test]
    fn v3x_and_v3() {
        let m = model("hs-razer-v3x", 0x057D);
        assert_eq!(m.gap_s, 300);
        let mut f = fake(m);
        let t0 = txid_of(7, 0x80, 0);
        let mut r = vec![0u8; 64];
        r[0] = 0x07;
        r[1] = 0x02;
        r[2] = t0;
        r[6] = 2;
        r[7] = 0x07;
        r[8] = 0x80;
        r[10] = 55;
        f.feature_replies.push_back(r.clone());
        let mut rc = r.clone();
        rc[2] = txid_of(7, 0x84, 0);
        rc[8] = 0x84;
        rc[10] = 1;
        f.feature_replies.push_back(rc);
        assert_eq!(read1(&mut f, m), at(pctl(55), Charging::Yes));
        assert!(f.sent.iter().all(|b| v3x_check(b)));
        let id = ident(m);
        assert!(permit(&id, ReportKind::Feature, &v3x_frame(0x80, 9)).is_some());
        assert!(permit(&id, ReportKind::Feature, &v3x_frame(0x80, 0)).is_none(), "txid 0 is not ours");
        assert!(permit(&id, ReportKind::Feature, &v3x_frame(0x81, 9)).is_none());
        assert!(permit(&id, ReportKind::Output, &v3x_frame(0x80, 9)).is_none());
        // (A headset off: status other than 01 / 02.)
        let mut f = fake(m);
        r[1] = 0x03;
        f.feature_replies.push_back(r);
        assert_eq!(read1(&mut f, m), unlinked(7));

        let m = model("hs-razer-v3", 0x0576);
        let mut f = fake(m);
        let mut r = vec![0u8; 64];
        r[0] = 0x02;
        r[2] = 0x60;
        r[10] = 0x21;
        r[13] = 81;
        f.replies.push_back(vec![r]);
        assert_eq!(read1(&mut f, m), at(pctl(81), Charging::No));
        assert_eq!(f.sent, vec![V3_GET.to_vec(), V3_CHARGING.to_vec()], "the GETs only — no handshake");
        let mut f = fake(m);
        let mut r = vec![0u8; 64];
        r[0] = 0x02;
        r[2] = 0x60;
        r[10] = 0x21;
        r[13] = 81;
        let mut c = r.clone();
        c[10] = 0x2A;
        c[13] = 1;
        f.replies.extend([vec![r], vec![c]]);
        assert_eq!(read1(&mut f, m), at(pctl(81), Charging::Yes), "D1: charging on the cable (GET 2A)");
        assert!(permit(&ident(m), ReportKind::Output, &V3_GET).is_some());
        // (The gap: a reading kept within five minutes, asked again after.)
        let kept = Some((1_000, at(pctl(81), Charging::No)));
        assert_eq!(within_gap(m, kept, 200_000), kept.map(|k| k.1));
        assert_eq!(within_gap(m, kept, 301_000), None);
        assert_eq!(within_gap(m, Some((1_000, Outcome::NoAnswer)), 2_000), None, "no answer is never kept");
        assert_eq!(within_gap(model("hs-razer-hs", 0x0565), kept, 2_000), None, "no gap: always asked");
    }
}
