// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Finalmouse UltralightX and Starlight X on their dongles (VID 361D).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/finalmouse.cpp (kModels, Decode, Get, Query, PollFinalmouse) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later. Its references: xpanel
// (Finalmouse's configurator) as ported by OpenMouse-Project/mouse-protocol and xBambooz/FinalmousePollingRateSwitcher.
// Frames on the vendor collection FF00: [report id][2 + n][80 | command][n][payload]; an empty payload is a GET, the
// reply an input report with the plain command. ULX dongle 0100 (FF00:0001): output 04, input 05; SLX dongles 0300 /
// 0301: output 01, input 02. Commands: 5 battery voltage (mV, LE), 38 state of charge [percent][mV], 37 charging,
// 36 link state (0: no link to the mouse).
// Changed here: only those four GETs are sent, one by one; the original sent the lift-off (21) or profile-roster (57)
// read and then «wake/all» (96), which makes the dongle push its whole status — not sent here (it wakes the link).
// Whether the dongle answers these single GETs is not proven: if it does not, the mouse reads when xpanel has made it
// speak, else «needs a query we do not send». A voltage alone is a coarse word (the original: xpanel's curve to the per
// cent). The mouse on its own cable (0102, 0310, 0311): its report ids are not known, as in the original.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

/// arg: the output report id << 8 | the input report id.
pub static MODELS: &[Model] = &[
    Model::new("mk-finalmouse", 0x361D, 0x0100, "Finalmouse UltralightX", Kind::Mouse, Via::Receiver).page(0xFF00).usage(0x0001).input(Len::Min(4)).output(Len::Min(4)).arg(0x0405),
    Model::new("mk-finalmouse", 0x361D, 0x0300, "Finalmouse Starlight X", Kind::Mouse, Via::Receiver).page(0xFF00).input(Len::Min(4)).output(Len::Min(4)).arg(0x0102),
    Model::new("mk-finalmouse", 0x361D, 0x0301, "Finalmouse Starlight X", Kind::Mouse, Via::Receiver).page(0xFF00).input(Len::Min(4)).output(Len::Min(4)).arg(0x0102),
];

pub const VOLTAGE: u8 = 5;
pub const LINK: u8 = 36;
pub const CHARGING: u8 = 37;
pub const SOC: u8 = 38;

pub const fn get(out_id: u8, cmd: u8) -> [u8; 4] {
    [out_id, 2, 0x80 | cmd, 0]
}

#[derive(Default)]
struct St {
    soc: Option<u8>,
    mv: u32,
    charging: Option<u8>,
    link: Option<u8>,
}

fn decode(r: &[u8], in_id: u8, st: &mut St) -> bool {
    if r.len() < 4 || r[0] != in_id {
        return false;
    }
    let inner = usize::from(r[1]).min(r.len() - 2);
    if inner < 2 {
        return false;
    }
    let n = usize::from(r[3]).min(inner - 2);
    let p = &r[4..];
    let mv_ok = |v: u32| v > 0 && v < 5000;
    match r[2] {
        VOLTAGE if n >= 2 => {
            let v = u32::from(p[0]) | u32::from(p[1]) << 8;
            if mv_ok(v) {
                st.mv = v;
            }
        }
        SOC if n >= 3 && p[0] <= 100 => {
            st.soc = Some(p[0]);
            let v = u32::from(p[1]) | u32::from(p[2]) << 8;
            if mv_ok(v) {
                st.mv = v;
            }
        }
        CHARGING if n >= 1 => st.charging = Some(p[0]),
        LINK if n >= 1 => st.link = Some(p[0]),
        _ => return false,
    }
    true
}

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    let (out_id, in_id) = ((m.arg >> 8) as u8, m.arg as u8);
    let mut st = St::default();
    let mut answered = false;
    for cmd in [SOC, VOLTAGE, CHARGING, LINK] {
        if cmd == VOLTAGE && st.soc.is_some() {
            continue;
        }
        let r = out_ask(ch, &get(out_id, cmd), ms(300), deadline, &mut |r| {
            let mut one = St::default();
            if decode(r, in_id, &mut one) && r[2] == cmd {
                Some(r.to_vec())
            } else {
                None
            }
        });
        match r {
            Ok(r) => {
                answered = true;
                decode(&r, in_id, &mut st);
            }
            Err(TErr::Gone) => return Outcome::Failed,
            Err(_) => {}
        }
    }
    let c = match st.charging {
        Some(1) => Charging::Yes,
        Some(_) => Charging::No,
        None => Charging::Unknown,
    };
    if let Some(p) = st.soc {
        return got(pct(i64::from(p)).unwrap_or(Level::Unknown), c, now);
    }
    if st.mv > 0 {
        return got(from_millivolts(st.mv), c, now);
    }
    if st.link == Some(0) {
        return dozing(now);
    }
    if answered {
        no_level(c, now)
    } else {
        needs_query(now)
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn single_gets() {
        let m = model("mk-finalmouse", 0x0100);
        let mut f = fake(m);
        f.replies.extend([vec![vec![0x05, 5, SOC, 3, 72, 0x10, 0x0F]], vec![vec![0x05, 3, CHARGING, 1, 1]], vec![vec![0x05, 3, LINK, 1, 1]]]);
        assert_eq!(read1(&mut f, m), at(pctl(72), Charging::Yes));
        assert_eq!(f.sent, vec![get(0x04, SOC).to_vec(), get(0x04, CHARGING).to_vec(), get(0x04, LINK).to_vec()]);
        assert!(f.sent.iter().all(|b| b[2] != 0x80 | 96), "never wake/all");
        // (The voltage alone: a word; silence: needs a query we do not send.)
        let mut f = fake(m);
        f.replies.extend([vec![], vec![vec![0x05, 4, VOLTAGE, 2, 0xA0, 0x0F]], vec![], vec![]]);
        assert_eq!(read1(&mut f, m), at(from_millivolts(4000), Charging::Unknown));
        let mut f = fake(m);
        assert_eq!(read1(&mut f, m), needs_query(7));
        let s = model("mk-finalmouse", 0x0300);
        let mut f = fake(s);
        f.replies.extend([vec![vec![0x02, 5, SOC, 3, 150, 0, 0]], vec![], vec![], vec![vec![0x02, 3, LINK, 1, 0]]]);
        assert_eq!(read1(&mut f, s), dozing(7), "a percentage over 100 is none; no link: asleep");
        assert_eq!(f.sent[0], get(0x01, SOC).to_vec());
    }
}
