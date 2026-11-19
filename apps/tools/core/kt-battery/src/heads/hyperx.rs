// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): HyperX wireless headsets and Pulsefire Haste 2 mice (HP 03F0, Kingston
// 0951).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/hyperx.cpp (Cloud3, Cloud2, Cloud2Kingston, CloudAlpha, CloudAlpha2, HasteWireless, CloudFlight, Cloud3S,
// StingerCore, kModels) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its references: Medprj/HyperXWM, LennardKittner/HyperHeadset, davidsantanaalves/HyperBatteryMonitor,
// PMarinov1994/ngenuity-linux-cli, Sapd/HeadsetControl.
//   Cloud III / Cloud II Core Wireless: 66 82 → [2] linked; 66 8A → [2] 01 charging; 66 89 → [2–3] mV, [4] percent.
//   Cloud III S: 0C 02 03 01 00 <cmd> → [5] cmd, [6] value (FF invalid): 02 linked (2), 06 percent, 48 charging (1, 2).
//   Cloud II (HP): 06 FF BB <cmd> → 02: [7] percent; 03: [4] 01 charging.  Cloud II (Kingston 1718): its fixed
//   17-byte frame … BB <cmd> 00, reply 0B ? BB <cmd>, the same fields.
//   Cloud Alpha: 21 BB <cmd> → [3]: 03 off (1), 0C charging (1), 0B percent.
//   Cloud Alpha 2, Pulsefire Haste 2 (Core) Wireless: [52 01] → [53 01][linked]; [50 02] → [51 02][percent][charging].
//   Cloud Flight: 21 FF 05 → [3–4] mV (over 0x100B: charging).
//   Cloud Stinger Core / Cloud Core Wireless (FF00:0001, feature FF): set the «connection» or «battery» command, 20 ms,
//   get feature FF: connection [11] 01 on; battery [9] 03 on battery / 05 charging / 06 full, [11–12] mV; the
//   PlayStation receivers (0A93, 1713, 173F) may hand back the previous report first: read again, up to ten times.
// D1 (the original's v1.1.0 hyperx.cpp at commit 7cc44f2): the Pulsefire Haste 2 Mini (03F0:0DA0) as the other Haste 2
// dongles; the Cloud Flight S (0951:16EA / 16EB, FF13:0001, 62-byte reports) with the Cloud II (Kingston) reads
// (LennardKittner/HyperHeadset); the Cloud Stinger Core Wireless DTS receiver (03F0:0A8E) as the PlayStation receivers
// (its reply re-read until it is the battery's, HyperBatteryMonitor PR 16).
// Changed here: matched by product and collection (as the original's table); voltages as coarse words, never a
// percentage from a fitted curve (Cloud Flight's polynomial, the Stinger's tables); «full» (06) as Full; the Haste 2's
// settle window after power-on (a global clock in the original) is not kept: a reading right after the mouse is
// switched on may read 40 % for a few seconds.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::mice::*;
use crate::model::{Charging, Coarse, Kind, Level};
use crate::sched::Outcome;
use crate::transport::TErr;
use std::time::Instant;

pub const C3: u16 = 1;
pub const C3S: u16 = 2;
pub const C2: u16 = 3;
pub const C2K: u16 = 4;
pub const ALPHA: u16 = 5;
pub const ALPHA2: u16 = 6;
pub const HASTE: u16 = 7;
pub const FLIGHT: u16 = 8;
pub const STINGER: u16 = 9;

const fn hx(vid: u16, pid: u16, name: &'static str, arg: u16) -> Model {
    Model::new("hs-hyperx", vid, pid, name, Kind::Headset, Via::Receiver).arg(arg)
}

pub static MODELS: &[Model] = &[
    hx(0x03F0, 0x05B7, "HyperX Cloud III Wireless", C3).input(Len::Eq(62)).output(Len::Eq(62)),
    hx(0x03F0, 0x0C9D, "HyperX Cloud III Wireless", C3).input(Len::Eq(62)).output(Len::Eq(62)),
    hx(0x03F0, 0x069F, "HyperX Cloud II Core Wireless", C3).vendor_page().input(Len::Min(62)).output(Len::Min(62)),
    hx(0x03F0, 0x0995, "HyperX Cloud II Core Wireless", C3).vendor_page().input(Len::Min(62)).output(Len::Min(62)),
    hx(0x03F0, 0x06BE, "HyperX Cloud III S Wireless", C3S).input(Len::Eq(64)).output(Len::Eq(64)),
    hx(0x03F0, 0x02CC, "HyperX Cloud III S Wireless", C3S).input(Len::Eq(64)).output(Len::Eq(64)),
    hx(0x03F0, 0x0696, "HyperX Cloud II Wireless", C2).page(0xFF90).usage(0x0303),
    hx(0x03F0, 0x018B, "HyperX Cloud II Wireless", C2).page(0xFF90).usage(0x0303),
    hx(0x03F0, 0x0D93, "HyperX Cloud II Wireless", C2).page(0xFF90).usage(0x0303),
    hx(0x0951, 0x1718, "HyperX Cloud II Wireless", C2K).output(Len::Eq(62)),
    hx(0x03F0, 0x098D, "HyperX Cloud Alpha Wireless", ALPHA).vendor_page().output(Len::Min(3)),
    hx(0x03F0, 0x08BE, "HyperX Cloud Alpha 2 Wireless", ALPHA2).page(0xFF13).usage(0xFF00),
    hx(0x03F0, 0x0AB5, "HyperX Pulsefire Haste 2 Core Wireless", HASTE).kind_of(Kind::Mouse).vendor_page().output(Len::Min(2)).input(Len::Min(8)),
    hx(0x03F0, 0x0D97, "HyperX Pulsefire Haste 2 Wireless", HASTE).kind_of(Kind::Mouse).vendor_page().output(Len::Min(2)).input(Len::Min(8)),
    hx(0x03F0, 0x0F98, "HyperX Pulsefire Haste 2 Wireless", HASTE).kind_of(Kind::Mouse).vendor_page().output(Len::Min(2)).input(Len::Min(8)),
    hx(0x03F0, 0x0DA0, "HyperX Pulsefire Haste 2 Mini", HASTE).kind_of(Kind::Mouse).vendor_page().output(Len::Min(2)).input(Len::Min(8)),
    hx(0x0951, 0x16EA, "HyperX Cloud Flight S", C2K).page(0xFF13).usage(0x0001).input(Len::Eq(62)).output(Len::Eq(62)),
    hx(0x0951, 0x16EB, "HyperX Cloud Flight S", C2K).page(0xFF13).usage(0x0001).input(Len::Eq(62)).output(Len::Eq(62)),
    hx(0x0951, 0x16C4, "HyperX Cloud Flight", FLIGHT).vendor_page().output(Len::Min(3)),
    hx(0x0951, 0x1723, "HyperX Cloud Flight", FLIGHT).vendor_page().output(Len::Min(3)),
    hx(0x0951, 0x1749, "HyperX Cloud Flight", FLIGHT).vendor_page().output(Len::Min(3)),
    hx(0x03F0, 0x0E90, "HyperX Cloud Flight", FLIGHT).vendor_page().output(Len::Min(3)),
    hx(0x03F0, 0x0A93, "HyperX Cloud Stinger Core Wireless", STINGER).page(0xFF00).usage(0x0001).feature(Len::Min(32)),
    hx(0x03F0, 0x0A8E, "HyperX Cloud Stinger Core Wireless DTS", STINGER).page(0xFF00).usage(0x0001).feature(Len::Min(32)),
    hx(0x0951, 0x170B, "HyperX Cloud Stinger Core Wireless", STINGER).page(0xFF00).usage(0x0001).feature(Len::Min(32)),
    hx(0x0951, 0x1713, "HyperX Cloud Stinger Core Wireless", STINGER).page(0xFF00).usage(0x0001).feature(Len::Min(32)),
    hx(0x0951, 0x173F, "HyperX Cloud Core Wireless", STINGER).page(0xFF00).usage(0x0001).feature(Len::Min(32)),
];

pub const C3_LINK: [u8; 2] = [0x66, 0x82];
pub const C3_CHARGING: [u8; 2] = [0x66, 0x8A];
pub const C3_BATTERY: [u8; 2] = [0x66, 0x89];
pub const C3S_LINK: [u8; 6] = [0x0C, 0x02, 0x03, 0x01, 0x00, 0x02];
pub const C3S_BATTERY: [u8; 6] = [0x0C, 0x02, 0x03, 0x01, 0x00, 0x06];
pub const C3S_CHARGING: [u8; 6] = [0x0C, 0x02, 0x03, 0x01, 0x00, 0x48];
pub const C2_BATTERY: [u8; 4] = [0x06, 0xFF, 0xBB, 0x02];
pub const C2_CHARGING: [u8; 4] = [0x06, 0xFF, 0xBB, 0x03];
const fn c2k(cmd: u8) -> [u8; 17] {
    [0x06, 0x00, 0x02, 0x00, 0x9A, 0x00, 0x00, 0x68, 0x4A, 0x8E, 0x0A, 0x00, 0x00, 0x00, 0xBB, cmd, 0x00]
}
pub const C2K_BATTERY: [u8; 17] = c2k(0x02);
pub const C2K_CHARGING: [u8; 17] = c2k(0x03);
pub const ALPHA_LINK: [u8; 3] = [0x21, 0xBB, 0x03];
pub const ALPHA_CHARGING: [u8; 3] = [0x21, 0xBB, 0x0C];
pub const ALPHA_BATTERY: [u8; 3] = [0x21, 0xBB, 0x0B];
pub const A2_LINK: [u8; 2] = [0x52, 0x01];
pub const A2_BATTERY: [u8; 2] = [0x50, 0x02];
pub const FLIGHT_Q: [u8; 3] = [0x21, 0xFF, 0x05];
pub const ST_CONNECTION: [u8; 20] = [0xFF, 0x07, 0x00, 0xFD, 0x04, 0x00, 0x00, 0x02, 0x82, 0x03, 0x05, 0x29, 0x0F, 0x00, 0x00, 0x03, 0x68, 0x10, 0x00, 0x00];
pub const ST_BATTERY: [u8; 12] = [0xFF, 0x07, 0x00, 0xFD, 0x04, 0x0C, 0xF1, 0x02, 0x01, 0x04, 0xF0, 0x0C];

fn ask(ch: &mut Chans, q: &[u8], f: &mut dyn FnMut(&[u8]) -> Option<Vec<u8>>, deadline: Instant) -> Result<Vec<u8>, TErr> {
    out_ask(ch, q, ms(1000), deadline, f)
}
fn lv(o: Option<Level>) -> Level {
    o.unwrap_or(Level::Unknown)
}

fn c3(ch: &mut Chans, deadline: Instant, now: u64) -> Result<Outcome, TErr> {
    let m = |cmd: u8| move |r: &[u8]| if r.len() >= 5 && r[0] == 0x66 && r[1] == cmd { Some(r.to_vec()) } else { None };
    let r = ask(ch, &C3_LINK, &mut m(0x82), deadline)?;
    if r[2] == 0 {
        return Ok(unlinked(now));
    }
    let c = ask(ch, &C3_CHARGING, &mut m(0x8A), deadline).map(|r| charging(r[2] == 1)).unwrap_or(Charging::Unknown);
    let l = ask(ch, &C3_BATTERY, &mut m(0x89), deadline).ok().and_then(|r| pct(i64::from(r[4])));
    Ok(got(lv(l), c, now))
}

fn c3s(ch: &mut Chans, deadline: Instant, now: u64) -> Result<Outcome, TErr> {
    let m = |cmd: u8| move |r: &[u8]| if r.len() >= 7 && r[0] == 0x0C && r[5] == cmd && r[6] != 0xFF { Some(r.to_vec()) } else { None };
    let r = ask(ch, &C3S_LINK, &mut m(0x02), deadline)?;
    if r[6] != 2 {
        return Ok(unlinked(now));
    }
    let l = ask(ch, &C3S_BATTERY, &mut m(0x06), deadline).ok().and_then(|r| pct(i64::from(r[6])));
    let c = ask(ch, &C3S_CHARGING, &mut m(0x48), deadline).map(|r| charging(r[6] == 1 || r[6] == 2)).unwrap_or(Charging::Unknown);
    Ok(got(lv(l), c, now))
}

fn c2(ch: &mut Chans, kingston: bool, deadline: Instant, now: u64) -> Result<Outcome, TErr> {
    let m = move |cmd: u8| move |r: &[u8]| {
        let ok = r.len() >= 8 && if kingston { r[0] == 0x0B && r[2] == 0xBB && r[3] == cmd } else { r[0] == 0x06 && r[1] == 0xFF && r[2] == 0xBB && r[3] == cmd };
        if ok {
            Some(r.to_vec())
        } else {
            None
        }
    };
    let (qb, qc): (&[u8], &[u8]) = if kingston { (&C2K_BATTERY, &C2K_CHARGING) } else { (&C2_BATTERY, &C2_CHARGING) };
    let r = ask(ch, qb, &mut m(0x02), deadline)?;
    let Some(l) = pct(i64::from(r[7])) else { return Ok(no_level(Charging::Unknown, now)) };
    let c = ask(ch, qc, &mut m(0x03), deadline).map(|r| charging(r[4] == 1)).unwrap_or(Charging::Unknown);
    Ok(got(l, c, now))
}

fn alpha(ch: &mut Chans, deadline: Instant, now: u64) -> Result<Outcome, TErr> {
    let m = |cmd: u8| move |r: &[u8]| if r.len() >= 4 && r[0] == 0x21 && r[2] == cmd { Some(r.to_vec()) } else { None };
    let r = ask(ch, &ALPHA_LINK, &mut m(0x03), deadline)?;
    if r[3] == 0x01 {
        return Ok(unlinked(now));
    }
    let c = ask(ch, &ALPHA_CHARGING, &mut m(0x0C), deadline).map(|r| charging(r[3] == 0x01)).unwrap_or(Charging::Unknown);
    let l = ask(ch, &ALPHA_BATTERY, &mut m(0x0B), deadline).ok().and_then(|r| pct(i64::from(r[3])));
    Ok(got(lv(l), c, now))
}

fn alpha2(ch: &mut Chans, haste: bool, deadline: Instant, now: u64) -> Result<Outcome, TErr> {
    let m = |cmd: u8, sub: u8| move |r: &[u8]| if r.len() >= 8 && r[0] == cmd.wrapping_add(1) && r[1] == sub { Some(r.to_vec()) } else { None };
    // (The Haste 2's dongle floods its channel after a reconnect: a missing link reply is no error there; the battery
    //  reply decides.)
    let link = ask(ch, &A2_LINK, &mut m(0x52, 0x01), deadline);
    let linked = match &link {
        Ok(r) => r[2] != 0,
        Err(TErr::Gone) => return Err(TErr::Gone),
        Err(e) if !haste => return Err(e.clone()),
        Err(_) => true,
    };
    if !linked {
        return Ok(unlinked(now));
    }
    match ask(ch, &A2_BATTERY, &mut m(0x50, 0x02), deadline) {
        Ok(r) if r[2] <= 100 => Ok(got(lv(pct(i64::from(r[2]))), charging(r[3] == 0x01 || (haste && r[3] == 0x02)), now)),
        Ok(_) => Ok(no_level(Charging::Unknown, now)),
        Err(e) if link.is_err() => Err(e),
        Err(_) => Ok(no_level(Charging::Unknown, now)),
    }
}

fn flight(ch: &mut Chans, deadline: Instant, now: u64) -> Result<Outcome, TErr> {
    let r = ask(ch, &FLIGHT_Q, &mut |r: &[u8]| if r.len() >= 5 { Some(r.to_vec()) } else { None }, deadline)?;
    let mv = u32::from(r[3]) << 8 | u32::from(r[4]);
    if mv > 0x100B {
        return Ok(no_level(Charging::Yes, now));
    }
    Ok(got(from_millivolts(mv), Charging::No, now))
}

fn stinger(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Result<Outcome, TErr> {
    let ps = matches!(m.pid, 0x0A93 | 0x1713 | 0x173F | 0x0A8E);
    let len = ch.main.feature_len().max(32);
    let mut exchange = |q: &[u8], good: &dyn Fn(&[u8]) -> bool| -> Result<(bool, Vec<u8>), TErr> {
        send(&mut *ch.main, crate::allow::ReportKind::Feature, q, deadline)?;
        let mut last = Vec::new();
        for _ in 0..(if ps { 10 } else { 1 }) {
            pause(ms(20), deadline);
            let r = ch.main.get_feature(0xFF, len, deadline)?;
            if r.len() < 13 {
                return Err(TErr::BadReply);
            }
            if !ps || good(&r) {
                return Ok((true, r));
            }
            last = r;
        }
        Ok((false, last))
    };
    let fresh = |r: &[u8]| !(r[1] == 0x01 && r[2] == 0x00);
    // (The connection reply's header is not documented: after ten stale-looking reads the last one is used.)
    let (_, r) = exchange(&ST_CONNECTION, &fresh)?;
    if r[11] != 0x01 {
        return Ok(unlinked(now));
    }
    let battery = |r: &[u8]| r[0] == 0xFF && r[1] == 0x12 && r[2] == 0x05;
    let (ok, r) = exchange(&ST_BATTERY, &battery)?;
    if !ok {
        return Ok(no_level(Charging::Unknown, now));
    }
    let mv = u32::from(r[11]) | u32::from(r[12]) << 8;
    Ok(match r[9] {
        0x06 => got(Level::Coarse(Coarse::Full), Charging::No, now),
        0x05 => got(from_millivolts(mv), Charging::Yes, now),
        0x03 => got(from_millivolts(mv), Charging::No, now),
        _ => no_level(Charging::Unknown, now),
    })
}

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    let r = match m.arg {
        C3 => c3(ch, deadline, now),
        C3S => c3s(ch, deadline, now),
        C2 => c2(ch, false, deadline, now),
        C2K => c2(ch, true, deadline, now),
        ALPHA => alpha(ch, deadline, now),
        ALPHA2 => alpha2(ch, false, deadline, now),
        HASTE => alpha2(ch, true, deadline, now),
        FLIGHT => flight(ch, deadline, now),
        _ => stinger(ch, m, deadline, now),
    };
    r.unwrap_or_else(|e| failed(&e))
}

#[cfg(test)]
mod tests {
    use crate::mice::testkit::*;
    use super::*;

    #[test]
    fn clouds() {
        let m = model("hs-hyperx", 0x0C9D);
        let mut f = fake(m);
        f.replies.extend([vec![vec![0x66, 0x82, 0x01, 0, 0]], vec![vec![0x66, 0x8A, 0x01, 0, 0]], vec![vec![0x66, 0x89, 0x0F, 0x50, 83]]]);
        assert_eq!(read1(&mut f, m), at(pctl(83), Charging::Yes));
        assert_eq!(f.sent, vec![C3_LINK.to_vec(), C3_CHARGING.to_vec(), C3_BATTERY.to_vec()]);
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x66, 0x82, 0x00, 0, 0]]);
        assert_eq!(read1(&mut f, m), unlinked(7));
        let s = model("hs-hyperx", 0x06BE);
        let mut f = fake(s);
        f.replies.extend([vec![vec![0x0C, 0, 0, 0, 0, 0x02, 0x02]], vec![vec![0x0C, 0, 0, 0, 0, 0x06, 61]], vec![vec![0x0C, 0, 0, 0, 0, 0x48, 0xFF], vec![0x0C, 0, 0, 0, 0, 0x48, 0x00]]]);
        assert_eq!(read1(&mut f, s), at(pctl(61), Charging::No), "FF is no value: the next frame");
        let c2m = model("hs-hyperx", 0x0696);
        let mut f = fake(c2m);
        f.replies.extend([vec![vec![0x06, 0xFF, 0xBB, 0x02, 0, 0x0F, 0, 47]], vec![vec![0x06, 0xFF, 0xBB, 0x03, 0x01, 0, 0, 0]]]);
        assert_eq!(read1(&mut f, c2m), at(pctl(47), Charging::Yes));
        let k = model("hs-hyperx", 0x1718);
        let mut f = fake(k);
        f.replies.extend([vec![vec![0x0B, 0x00, 0xBB, 0x02, 0, 0, 0, 101]]]);
        assert_eq!(read1(&mut f, k), no_level(Charging::Unknown, 7), "over 100");
        assert_eq!(f.sent, vec![C2K_BATTERY.to_vec()]);
        let a = model("hs-hyperx", 0x098D);
        let mut f = fake(a);
        f.replies.extend([vec![vec![0x21, 0xBB, 0x03, 0x02]], vec![vec![0x21, 0xBB, 0x0C, 0x00]], vec![vec![0x21, 0xBB, 0x0B, 35]]]);
        assert_eq!(read1(&mut f, a), at(pctl(35), Charging::No));
        let a2 = model("hs-hyperx", 0x08BE);
        let mut f = fake(a2);
        f.replies.extend([vec![vec![0x53, 0x01, 0x01, 0, 0, 0, 0, 0]], vec![vec![0x51, 0x02, 90, 0x01, 0, 0, 0, 0]]]);
        assert_eq!(read1(&mut f, a2), at(pctl(90), Charging::Yes));
        let fl = model("hs-hyperx", 0x16C4);
        let mut f = fake(fl);
        f.replies.push_back(vec![vec![0x21, 0xFF, 0x05, 0x0E, 0xD8]]);
        assert_eq!(read1(&mut f, fl), at(from_millivolts(3800), Charging::No), "a voltage: a coarse word");
        let mut f = fake(fl);
        f.replies.push_back(vec![vec![0x21, 0xFF, 0x05, 0x10, 0x10]]);
        assert_eq!(read1(&mut f, fl), no_level(Charging::Yes, 7));
    }

    #[test]
    fn haste_and_stinger() {
        let h = model("hs-hyperx", 0x0AB5);
        assert_eq!(h.kind, Kind::Mouse);
        let mut f = fake(h);
        // (No link reply in time, the battery answers: read.)
        f.replies.extend([vec![], vec![vec![0x51, 0x02, 70, 0x02, 0, 0, 0, 0]]]);
        assert_eq!(read1(&mut f, h), at(pctl(70), Charging::Yes));
        let st = model("hs-hyperx", 0x170B);
        let mut f = fake(st);
        let mut conn = vec![0u8; 32];
        conn[0] = 0xFF;
        conn[1] = 0x09;
        conn[11] = 0x01;
        let mut bat = vec![0u8; 32];
        bat[0] = 0xFF;
        bat[1] = 0x12;
        bat[2] = 0x05;
        bat[9] = 0x03;
        bat[11] = 0x10;
        bat[12] = 0x0F;
        f.feature_replies.extend([conn.clone(), bat.clone()]);
        assert_eq!(read1(&mut f, st), at(from_millivolts(0x0F10), Charging::No));
        assert_eq!(f.sent, vec![ST_CONNECTION.to_vec(), ST_BATTERY.to_vec()]);
        let mut f = fake(st);
        bat[9] = 0x06;
        f.feature_replies.extend([conn.clone(), bat.clone()]);
        assert_eq!(read1(&mut f, st), at(Level::Coarse(Coarse::Full), Charging::No));
        let mut f = fake(st);
        conn[11] = 0x03;
        f.feature_replies.push_back(conn);
        assert_eq!(read1(&mut f, st), unlinked(7));
    }
}
