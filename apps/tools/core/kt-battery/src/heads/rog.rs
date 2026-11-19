// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the ROG Pelta and ROG Delta II headsets (VID 0B05).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/rog.cpp (PeltaQuery, PollPelta, kHeadsets) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by
// krisgfx9 and its contributors, GPL-3.0-or-later. Its references: SteveWang92/peripheral-battery-tray, 1gcat/BatteryTool.
//   Interface 3, FF00:0001, report CC: CC 12 07 → CC 12 07 00 00 [5] sleep minutes [6] battery % (FE: not known yet)
//   [7] low alert; CC 12 08 → [5] 1 charging. A sleeping or switched-off headset answers FF AA in [5–6] or [1–2].
// Changed here: «asleep» is the dongle's answer this round (the original kept the last level for the card).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::mice::*;
use crate::model::{Charging, Kind, Level};
use crate::sched::Outcome;
use std::time::Instant;

const fn r(pid: u16, name: &'static str) -> Model {
    Model::new("hs-rog", 0x0B05, pid, name, Kind::Headset, Via::Receiver).iface(3).page(0xFF00).usage(0x0001).input(Len::Min(8)).output(Len::Min(8))
}
pub static MODELS: &[Model] = &[r(0x1B84, "ROG Pelta"), r(0x1AFA, "ROG Delta II")];

pub const Q_BATTERY: [u8; 3] = [0xCC, 0x12, 0x07];
pub const Q_CHARGING: [u8; 3] = [0xCC, 0x12, 0x08];

#[derive(Debug, PartialEq)]
pub enum Rep {
    Asleep,
    Ok(Vec<u8>),
}

pub fn reply(r: &[u8], cmd: u8) -> Option<Rep> {
    if r.len() < 8 || r[0] != 0xCC {
        return None;
    }
    if r[1] == 0xFF && r[2] == 0xAA {
        return Some(Rep::Asleep);
    }
    if r[1] == 0x12 {
        if r[5] == 0xFF && r[6] == 0xAA {
            return Some(Rep::Asleep);
        }
        if r[2] == cmd {
            return Some(Rep::Ok(r.to_vec()));
        }
    }
    None
}

pub fn read(ch: &mut Chans, deadline: Instant, now: u64) -> Outcome {
    match out_ask(ch, &Q_BATTERY, ms(1200), deadline, &mut |x| reply(x, 0x07)) {
        Ok(Rep::Asleep) => dozing(now),
        Ok(Rep::Ok(b)) if b[6] <= 100 => {
            let c = match out_ask(ch, &Q_CHARGING, ms(1200), deadline, &mut |x| reply(x, 0x08)) {
                Ok(Rep::Ok(x)) => charging(x[5] == 1),
                _ => Charging::Unknown,
            };
            got(pct(i64::from(b[6])).unwrap_or(Level::Unknown), c, now)
        }
        Ok(Rep::Ok(_)) => dozing(now),
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use crate::mice::testkit::*;
    use super::*;

    #[test]
    fn pelta() {
        let m = model("hs-rog", 0x1B84);
        let mut f = fake(m);
        f.replies.extend([vec![vec![0xCC, 0x12, 0x07, 0, 0, 10, 76, 20]], vec![vec![0xCC, 0x12, 0x08, 0, 0, 1, 0, 0]]]);
        assert_eq!(read1(&mut f, m), at(pctl(76), Charging::Yes));
        assert_eq!(f.sent, vec![Q_BATTERY.to_vec(), Q_CHARGING.to_vec()]);
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0xCC, 0xFF, 0xAA, 0, 0, 0, 0, 0]]);
        assert_eq!(read1(&mut f, m), dozing(7));
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0xCC, 0x12, 0x07, 0, 0, 10, 0xFE, 20]]);
        assert_eq!(read1(&mut f, m), dozing(7), "FE: not known yet");
    }
}
