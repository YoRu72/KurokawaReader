// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): MOONDROP GM01 Pro on its WalkPlay 2.4 GHz dongle (35D8:0133).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/moondrop.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its reference: jeromeof/devicePEQ (walkplayHidHandler.js).
//   Interface 3, consumer page, report 4B: [4B][80 read][cmd][00]. 27 → [4B][80][27][06][..4][link][percent];
//   31 → [4B][80][31][01][link], answered by the dongle itself (00: the headset is off or on its cable).
//   Only READs (80) are sent, never WRITE (01).
// Changed here: the headset on its USB cable (one consumer collection, no control channel, nothing to read) is not
// made a «charging, level unknown» card from its path's form (the original told it by the missing «&col» in the path);
// the 35D8 vendor id is WalkPlay's, shared by other DACs: this product only.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::mice::*;
use crate::model::{Charging, Kind, Level};
use crate::sched::Outcome;
use std::time::Instant;

pub static MODELS: &[Model] = &[Model::new("hs-moondrop", 0x35D8, 0x0133, "MOONDROP GM01 Pro", Kind::Headset, Via::Receiver).iface(3).page(0x000C).output(Len::Min(4)).input(Len::Min(10))];

pub const Q_BATTERY: [u8; 4] = [0x4B, 0x80, 0x27, 0x00];
pub const Q_LINK: [u8; 4] = [0x4B, 0x80, 0x31, 0x00];

fn of(cmd: u8) -> impl FnMut(&[u8]) -> Option<Vec<u8>> {
    move |r: &[u8]| if r.len() >= 5 && r[0] == 0x4B && r[1] == 0x80 && r[2] == cmd { Some(r.to_vec()) } else { None }
}

pub fn read(ch: &mut Chans, deadline: Instant, now: u64) -> Outcome {
    let mut fb = of(0x27);
    match out_ask(ch, &Q_BATTERY, ms(400), deadline, &mut fb) {
        Ok(r) if r.len() >= 10 && r[3] >= 6 && r[8] != 0 && r[9] <= 100 => return got(pct(i64::from(r[9])).unwrap_or(Level::Unknown), Charging::Unknown, now),
        Err(crate::transport::TErr::Gone) => return Outcome::Failed,
        _ => {}
    }
    let mut fl = of(0x31);
    match out_ask(ch, &Q_LINK, ms(400), deadline, &mut fl) {
        Ok(r) if r[3] >= 1 && r[4] == 0 => unlinked(now),
        Ok(_) => no_level(Charging::Unknown, now),
        Err(e) => failed(&e),
    }
}

#[cfg(test)]
mod tests {
    use crate::mice::testkit::*;
    use super::*;

    #[test]
    fn gm01() {
        let m = model("hs-moondrop", 0x0133);
        let mut f = fake(m);
        f.replies.push_back(vec![vec![0x4B, 0x80, 0x27, 0x06, 0, 0, 0, 0, 0x01, 50]]);
        assert_eq!(read1(&mut f, m), at(pctl(50), Charging::Unknown));
        let mut f = fake(m);
        f.replies.extend([vec![], vec![vec![0x4B, 0x80, 0x31, 0x01, 0x00]]]);
        assert_eq!(read1(&mut f, m), unlinked(7));
        assert_eq!(f.sent, vec![Q_BATTERY.to_vec(), Q_LINK.to_vec()]);
    }
}
