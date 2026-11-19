// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the Alienware AW920H headset on its 2.4 GHz dongle (413C:A515).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/alienware.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its reference: Alienware Command Center's AW920H plugin (GetRFBatteryStatus, IsChecksumOk).
//   Interface 5, FF13:0001, 62-byte reports: output 06 C0 0A; the reply is input report 07 fetched with GetInputReport
//   every ~15 ms: [07][C0][0A][09][00][linked][percent][charging][critical][..][..][critical percent][mode][XOR of 3–12];
//   [6] 0 is no reply; [8] 1 (critical): the level is [11]. 07 00 80: no answer yet (or the headset is off).
//   About one query in a hundred is dropped: asked again, three times at most.
// Changed here: within the deadline; a headset that does not answer is «no answer», its last reading dimmed with its
// age. In Bluetooth mode (A514) Windows keeps its level: the Bluetooth reader's.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::mice::*;
use crate::model::{Kind, Level};
#[cfg(test)]
use crate::model::Charging;
use crate::sched::Outcome;
use crate::transport::TErr;
use std::time::Instant;

pub static MODELS: &[Model] = &[Model::new("hs-alienware", 0x413C, 0xA515, "Alienware AW920H", Kind::Headset, Via::Receiver).iface(5).page(0xFF13).usage(0x0001).input(Len::Eq(62)).output(Len::Eq(62))];

pub const Q: [u8; 3] = [0x06, 0xC0, 0x0A];

pub fn decode(r: &[u8]) -> Option<(u8, bool)> {
    if r.len() < 14 || r[0] != 0x07 || r[1] != 0xC0 || r[2] != 0x0A || r[3] != 0x09 {
        return None;
    }
    if xor8(&r[3..=12]) != r[13] || r[6] == 0 {
        return None;
    }
    let p = if r[8] == 1 { r[11] } else { r[6] };
    if p > 100 {
        return None;
    }
    Some((p, r[7] == 1))
}

pub fn read(ch: &mut Chans, deadline: Instant, now: u64) -> Outcome {
    let end = deadline.min(Instant::now() + ms(600));
    for _ in 0..3 {
        if let Err(e) = send(&mut *ch.main, crate::allow::ReportKind::Output, &Q, end) {
            return failed(&e);
        }
        let try_end = end.min(Instant::now() + ms(180));
        loop {
            pause(ms(15), try_end);
            match ch.main.get_input(0x07, 62, deadline) {
                Ok(r) => {
                    if let Some((p, c)) = decode(&r) {
                        return got(pct(i64::from(p)).unwrap_or(Level::Unknown), charging(c), now);
                    }
                }
                Err(TErr::Gone) => return Outcome::Failed,
                Err(_) => {}
            }
            if Instant::now() >= try_end || cfg!(test) {
                break;
            }
        }
        if Instant::now() >= end {
            break;
        }
    }
    Outcome::NoAnswer
}

#[cfg(test)]
mod tests {
    use crate::mice::testkit::*;
    use super::*;

    #[test]
    fn aw920h() {
        let m = model("hs-alienware", 0xA515);
        let r = vec![0x07, 0xC0, 0x0A, 0x09, 0x00, 0x01, 0x5F, 0x00, 0x00, 0x1C, 0x10, 0x5F, 0x02, 0x06];
        assert_eq!(decode(&r), Some((95, false)), "the original's example: 95 %, not charging");
        let mut f = fake(m);
        f.inputs.insert(0x07, r.clone());
        assert_eq!(read1(&mut f, m), at(pctl(95), Charging::No));
        assert_eq!(f.sent, vec![Q.to_vec()]);
        let mut f = fake(m);
        f.inputs.insert(0x07, vec![0x07, 0x00, 0x80]);
        assert_eq!(read1(&mut f, m), Outcome::NoAnswer, "07 00 80: no answer");
        assert_eq!(f.sent.len(), 3, "asked again, three times at most");
        let mut bad = r;
        bad[13] ^= 1;
        assert_eq!(decode(&bad), None);
    }
}
