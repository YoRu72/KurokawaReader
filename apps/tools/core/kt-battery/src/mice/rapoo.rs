// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Rapoo VT gaming mice (VID 24AE) — passive: the mouse pushes its status.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/rapoo.cpp (kModels, IsLegacyVT3Pro, PollRapoo) and rapoo_protocol.h (DecodeBattery) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later. Their references: the
// Rapoo Hub's VT_nrf54L decoder and manifests, PyFlat/Device-Battery-Info (RapooProtocol.cs), an owner's captures.
// FF00:0002, nothing sent:
//  - Nordic 54L (16- or 19-byte reports): 07 [mode: low nibble 0 receiver, 1 Bluetooth, 2 cable][DPI…] [7] state
//    [8] percent [13..14] the mouse's product id;
//  - VT3 Pro, VT1 Pro Max (7-byte reports): BB B0 [mode][DPI lo][DPI hi][state][percent]; 7F while charging = unknown.
//  State 1 on battery, 2 charging; 0 is a transition (no reading).
// Changed here: products by id (the original listened to every 24AE product with such a collection); one listening
// window per round under the deadline (the original kept handles open between rounds in a global, g_rapoo, to catch
// reports it then drained) — a mouse that pushes less often than the window says nothing this round; the cable and the
// receiver of one mouse: one card by the pair rule.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn r(pid: u16, name: &'static str, via: Via, pair: &'static str, legacy: bool) -> Model {
    let m = Model::new("mk-rapoo", 0x24AE, pid, name, Kind::Mouse, via).page(0xFF00).usage(0x0002).pair(pair);
    if legacy {
        m.input(Len::Eq(7)).arg(1)
    } else {
        m.input(Len::Min(16))
    }
}

macro_rules! pair {
    ($cable:expr, $rx:expr, $name:expr, $p:expr) => {
        [r($cable, $name, Via::Cable, $p, false), r($rx, $name, Via::Receiver, $p, false)]
    };
}

pub static MODELS: &[Model] = &{
    let t: [[Model; 2]; 17] = [
        pair!(0x4610, 0x1410, "Rapoo VT0", "rp:vt0"),
        pair!(0x4620, 0x1420, "Rapoo VT0 Max", "rp:vt0max"),
        pair!(0x4615, 0x1415, "Rapoo VT1", "rp:vt1"),
        pair!(0x4644, 0x1444, "Rapoo VT1 Max", "rp:vt1max"),
        pair!(0x4622, 0x1422, "Rapoo VT2", "rp:vt2"),
        pair!(0x4623, 0x1423, "Rapoo VT2 Max", "rp:vt2max"),
        pair!(0x4612, 0x1412, "Rapoo VT3", "rp:vt3"),
        pair!(0x4617, 0x1417, "Rapoo VT3 Max (Gen 2)", "rp:vt3max"),
        pair!(0x4B06, 0x1B06, "Rapoo VT3 Max V2", "rp:vt3maxv2"),
        pair!(0x4611, 0x1411, "Rapoo VT3S", "rp:vt3s"),
        pair!(0x4621, 0x1421, "Rapoo VT3S Max", "rp:vt3smax"),
        pair!(0x4613, 0x1413, "Rapoo VT7", "rp:vt7"),
        pair!(0x4616, 0x1416, "Rapoo VT7 Max", "rp:vt7max"),
        pair!(0x4614, 0x1414, "Rapoo VT9 (Gen 2)", "rp:vt9"),
        pair!(0x4618, 0x1418, "Rapoo VT9 Max", "rp:vt9max"),
        [r(0x4415, "Rapoo VT3 Pro", Via::Cable, "rp:vt3pro", true), r(0x1215, "Rapoo VT3 Pro", Via::Receiver, "rp:vt3pro", true)],
        [r(0x4433, "Rapoo VT1 Pro Max", Via::Cable, "rp:vt1promax", true), r(0x1233, "Rapoo VT1 Pro Max", Via::Receiver, "rp:vt1promax", true)],
    ];
    let mut out = [t[0][0]; 34];
    let mut i = 0;
    while i < 17 {
        out[2 * i] = t[i][0];
        out[2 * i + 1] = t[i][1];
        i += 1;
    }
    out
};

/// One pushed status report (the 0 report id already dropped): (level, charging), None when it is not one.
pub fn decode(r: &[u8], legacy: bool) -> Option<(Level, Charging)> {
    let (state, percent) = if !legacy && r.first() == Some(&0x07) {
        if r.len() < 9 || r[1] & 0x0F > 2 {
            return None;
        }
        (r[7], r[8])
    } else if legacy && r.first() == Some(&0xBB) {
        if r.len() < 7 || r[1] != 0xB0 {
            return None;
        }
        (r[5], r[6])
    } else {
        return None;
    };
    if state != 1 && state != 2 {
        return None;
    }
    let ch = charging(state == 2);
    if percent <= 100 {
        return Some((pct(i64::from(percent))?, ch));
    }
    if legacy && state == 2 && percent == 0x7F {
        return Some((Level::Unknown, ch));
    }
    None
}

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    let legacy = m.arg == 1;
    // (A report every 3–10 s: the whole deadline is the window.)
    match listen(&mut *ch.main, Duration::from_secs(5), deadline, &mut |r| decode(r, legacy)) {
        Ok(Some((l, c))) => got(l, c, now),
        Ok(None) => Outcome::NoAnswer,
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn pushed_reports() {
        // (The owner's captures: BB B0 71 84 03 01 64 = 100 % on battery; BB B0 71 84 03 02 5F = 95 % charging.)
        assert_eq!(decode(&[0xBB, 0xB0, 0x71, 0x84, 0x03, 0x01, 0x64], true), Some((pctl(100), Charging::No)));
        assert_eq!(decode(&[0xBB, 0xB0, 0x71, 0x84, 0x03, 0x02, 0x5F], true), Some((pctl(95), Charging::Yes)));
        assert_eq!(decode(&[0xBB, 0xB0, 0x71, 0x84, 0x03, 0x02, 0x7F], true), Some((Level::Unknown, Charging::Yes)));
        assert_eq!(decode(&[0xBB, 0xB0, 0x71, 0x84, 0x03, 0x00, 0x40], true), None, "state 0: a transition");
        assert_eq!(decode(&[0xBB, 0xB0, 0x71], true), None, "short");
        assert_eq!(decode(&[0xBB, 0xB0, 0x71, 0x84, 0x03, 0x01, 0x64], false), None, "BB only for the legacy ids");
        let mut n = [0u8; 16];
        n[0] = 0x07;
        n[1] = 0x01;
        n[7] = 1;
        n[8] = 42;
        assert_eq!(decode(&n, false), Some((pctl(42), Charging::No)));
        n[1] = 0x03;
        assert_eq!(decode(&n, false), None, "mode 3 is not one");
        let m = model("mk-rapoo", 0x1233);
        let mut f = fake(m);
        f.stream.extend([vec![0x00, 0x01, 0x02], vec![0x00, 0xBB, 0xB0, 0x71, 0x84, 0x03, 0x01, 0x30]]);
        assert_eq!(read1(&mut f, m), at(pctl(48), Charging::No));
        assert!(f.sent.is_empty(), "nothing sent");
        let mut f = fake(m);
        assert_eq!(read1(&mut f, m), failed(&TErr::Timeout));
    }
}
