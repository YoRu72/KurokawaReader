// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): two request formats several mouse families share.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/glorious.cpp, lamzu.cpp, wlmouse.cpp, arbiter.cpp (the «83» status read) and endgame_we.cpp,
// dareu.cpp, areson.cpp, fantech.cpp (the 17-byte report 08 sent as a feature report, its reply as input report 09)
// at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later.
//  - «83» (a supplier's protocol shared by Glorious, Hitscan, G-Wolves, WLMouse, LAMZU, Arbiter Studio): feature report
//    0, 65 bytes, 00 00 00 02 02 00 83 then zeros; read back as feature report 0: [0][status][..][..][02][..][83]
//    [charging][percent] (some firmware without the leading report id byte: everything one byte earlier). Status A1 /
//    A2 answered, A0 waking up (or asleep), A4 asleep; any other: not this protocol.
//  - «Compx 17» as a feature: [08][cmd][00 × 14][checksum], the 17 bytes summing to 55; the reply an input report 09 on
//    the sibling collection FF01:0000 (Endgame Gear XM2we, DAREU EM901X, Redragon on Areson receivers) or anywhere on
//    the interface (Fantech: also read back as feature report 08). cmd 04 = battery, 03 = link (XM2we).
// Changed here: one wait between request and reply bounded by the deadline (the original slept up to 600 ms more);
// percent 0 from a receiver is «not linked», never 0 %; Redragon's 0–10 shown as steps (the original × 10 %).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

/// The «83» request (allow.rs: every product of the six families that take it).
pub const P83: [u8; 7] = [0x00, 0x00, 0x00, 0x02, 0x02, 0x00, 0x83];

/// (status, charging byte, level byte) of an «83» reply, with or without the report id byte; None when it is not one.
pub fn decode83(r: &[u8]) -> Option<(u8, u8, u8)> {
    if r.len() >= 9 && r[4] == 0x02 && r[6] == 0x83 && r[1] & 0xF0 == 0xA0 {
        Some((r[1], r[7], r[8]))
    } else if r.len() >= 8 && r[3] == 0x02 && r[5] == 0x83 && r[0] & 0xF0 == 0xA0 {
        Some((r[0], r[6], r[7]))
    } else {
        None
    }
}

pub fn read_p83(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    let wait = Duration::from_millis(if m.driver == "mk-hitscan" { 200 } else { 100 });
    // (Glorious-protocol firmware wakes on A0 and answers a second request; WLMouse and Arbiter mean «asleep» by it.)
    let retry_waking = matches!(m.driver, "mk-p83" | "mk-hitscan" | "mk-gwolves" | "mk-lamzu");
    let mut last = None;
    for attempt in 0..2 {
        let r = feat_ask(&mut *ch.main, &P83, 0x00, 65, wait, 4, deadline, &mut |r| decode83(r));
        match r {
            Ok((0xA0, _, _)) if retry_waking && attempt == 0 => {
                pause(Duration::from_millis(400), deadline);
                last = Some(0xA0);
                continue;
            }
            Ok((0xA1, chg, lvl)) | Ok((0xA2, chg, lvl)) => {
                let cable = m.via == Via::Cable;
                if lvl > 100 {
                    return no_level(Charging::Unknown, now);
                }
                if lvl == 0 && !cable {
                    return unlinked(now);
                }
                return got(pct(i64::from(lvl)).unwrap_or(Level::Unknown), charging(chg == 1 || cable), now);
            }
            Ok((0xA0, _, _)) | Ok((0xA4, _, _)) => return dozing(now),
            Ok(_) => return no_level(Charging::Unknown, now),
            Err(e) => {
                if last.is_some() {
                    return dozing(now);
                }
                return failed(&e);
            }
        }
    }
    dozing(now)
}

/// A «Compx 17» frame: [08][cmd][00 × 14][55 − the sum of the first 16].
pub const fn compx(cmd: u8) -> [u8; 17] {
    let mut f = [0u8; 17];
    f[0] = 0x08;
    f[1] = cmd;
    f[16] = 0x55u8.wrapping_sub(0x08u8.wrapping_add(cmd));
    f
}
pub const COMPX_LINK: [u8; 17] = compx(0x03);
pub const COMPX_BATTERY: [u8; 17] = compx(0x04);

/// The 17 bytes sum to 55.
pub fn compx_sum_ok(r: &[u8]) -> bool {
    r.len() >= 17 && sum8(&r[..17]) == 0x55
}

const STEP: Duration = Duration::from_millis(1000);

/// The XM2we's reply: [09][op][00 00 00][size 1–10][payload], summing to 55.
fn we_payload(r: &[u8], op: u8) -> Option<Vec<u8>> {
    if !compx_sum_ok(r) || r[0] != 0x09 || r[1] != op || r[2] != 0 || r[3] != 0 || r[4] != 0 {
        return None;
    }
    let size = usize::from(r[5]);
    if !(1..=10).contains(&size) {
        return None;
    }
    Some(r[6..6 + size].to_vec())
}

pub fn read_compx_feature(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    match m.driver {
        "mk-endgame-we" => {
            // (Battery first: the link can drop as the charger goes in.)
            let bat = feat_then_read(ch, &COMPX_BATTERY, Duration::from_millis(400), deadline, &mut |r| we_payload(r, 0x04));
            let bat = match bat {
                Ok(b) => b,
                Err(e) => return failed(&e),
            };
            let link = feat_then_read(ch, &COMPX_LINK, Duration::from_millis(400), deadline, &mut |r| we_payload(r, 0x03)).ok();
            let Some(level) = pct(i64::from(bat[0])) else { return no_level(Charging::Unknown, now) };
            let chg = bat.get(1) == Some(&1);
            if chg || link.as_ref().and_then(|l| l.first()) == Some(&1) {
                got(level, charging(chg), now)
            } else {
                dozing(now)
            }
        }
        "mk-dareu" => match feat_then_read(ch, &COMPX_BATTERY, STEP, deadline, &mut |r| if r.len() == 17 && r[0] == 0x09 && r[1] == 0x04 && r[2] == 0 && r[6] <= 100 { Some((r[6], r[7])) } else { None }) {
            Ok((p, c)) => got(pct(i64::from(p)).unwrap_or(Level::Unknown), charging(c != 0), now),
            Err(e) => failed(&e),
        },
        "mk-areson" => match feat_then_read(ch, &COMPX_BATTERY, Duration::from_millis(1800), deadline, &mut |r| if compx_sum_ok(r) && r[0] == 0x09 && r[1] == 0x04 && r[2] == 0 && r[6] <= 10 { Some((r[6], r[7])) } else { None }) {
            Ok((n, c)) => got(steps(i64::from(n), 10).unwrap_or(Level::Unknown), charging(c != 0), now),
            Err(e) => failed(&e),
        },
        // Fantech: the reply as input report 08 or 09 ([1] = 04, [6] percent 1–100, [7] charging 0/1) on any input
        // collection of the interface, or read back as feature report 08.
        _ => {
            let tenths = m.arg == 10;
            let parse = |r: &[u8]| -> Option<(u8, u8)> {
                if r.len() >= 8 && (r[0] == 0x08 || r[0] == 0x09) && r[1] == 0x04 && (1..=100).contains(&r[6]) && r[7] <= 1 {
                    Some((r[6], r[7]))
                } else {
                    None
                }
            };
            let heard = feat_then_read(ch, &COMPX_BATTERY, Duration::from_millis(500), deadline, &mut |r| parse(r));
            let heard = match heard {
                Ok(v) => Some(v),
                Err(TErr::Gone) => return Outcome::Failed,
                Err(_) => ch.main.get_feature(0x08, 17, deadline).ok().and_then(|r| parse(&r)),
            };
            match heard {
                Some((p, c)) if tenths => got(steps(i64::from(p), 10).unwrap_or(Level::Unknown), charging(c != 0), now),
                Some((p, c)) => got(pct(i64::from(p)).unwrap_or(Level::Unknown), charging(c != 0), now),
                None => Outcome::NoAnswer,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;
    use crate::model::Charging;

    fn p83_reply(status: u8, chg: u8, lvl: u8, with_id: bool) -> Vec<u8> {
        let mut r = vec![0u8; 65];
        let o = if with_id { 1 } else { 0 };
        r[o] = status;
        r[o + 3] = 0x02;
        r[o + 5] = 0x83;
        r[o + 6] = chg;
        r[o + 7] = lvl;
        r
    }

    #[test]
    fn frames() {
        assert_eq!(COMPX_BATTERY[16], 0x49, "the DAREU frame's own trailer");
        assert_eq!(COMPX_LINK[16], 0x4A);
        assert!(compx_sum_ok(&COMPX_BATTERY));
        assert!(decode83(&P83).is_none(), "our own request echoed is no reply");
        assert_eq!(decode83(&p83_reply(0xA1, 1, 77, true)), Some((0xA1, 1, 77)));
        assert_eq!(decode83(&p83_reply(0xA1, 0, 77, false)), Some((0xA1, 0, 77)));
        assert_eq!(decode83(&[0xA1, 0, 0]), None, "short");
    }

    #[test]
    fn p83_family() {
        let m = model("mk-p83", 0x2022);
        let mut f = fake(m);
        f.feature_replies.push_back(p83_reply(0xA1, 0, 64, true));
        assert_eq!(read1(&mut f, m), at(pctl(64), Charging::No));
        assert_eq!(f.sent, vec![P83.to_vec()]);
        assert_eq!(f.kinds, vec![ReportKind::Feature]);
        // (Asleep, out of range, not linked, another protocol.)
        let mut f = fake(m);
        f.feature_replies.push_back(p83_reply(0xA4, 0, 0, true));
        assert_eq!(read1(&mut f, m), dozing(7));
        let mut f = fake(m);
        f.feature_replies.push_back(p83_reply(0xA1, 0, 140, true));
        assert_eq!(read1(&mut f, m), no_level(Charging::Unknown, 7));
        let mut f = fake(m);
        f.feature_replies.push_back(p83_reply(0xA1, 0, 0, true));
        assert_eq!(read1(&mut f, m), unlinked(7));
        let mut f = fake(m);
        f.feature_replies.push_back(vec![0x00, 0x55, 0, 0, 0x02, 0, 0x83, 0, 50]);
        assert_eq!(read1(&mut f, m), Outcome::NoAnswer, "status 55: another protocol");
        // (Waking: asked once more; the cable is charging.)
        let cable = model("mk-p83", 0x2011);
        let mut f = fake(cable);
        f.feature_replies.extend([p83_reply(0xA0, 0, 0, true), p83_reply(0xA1, 0, 90, true)]);
        assert_eq!(read1(&mut f, cable), at(pctl(90), Charging::Yes));
        assert_eq!(f.sent.len(), 2);
    }

    #[test]
    fn compx_feature_families() {
        let m = model("mk-dareu", 0x1074);
        let mut f = fake(m);
        f.replies.push_back(vec![report(0x09, 17, &[(1, 0x04), (6, 55), (7, 1)])]);
        assert_eq!(read1(&mut f, m), at(pctl(55), Charging::Yes));
        assert_eq!((f.sent.clone(), f.kinds.clone()), (vec![COMPX_BATTERY.to_vec()], vec![ReportKind::Feature]));
        let mut f = fake(m);
        f.replies.push_back(vec![report(0x09, 17, &[(1, 0x04), (6, 155)])]);
        assert_eq!(read1(&mut f, m), Outcome::NoAnswer);
        // (Redragon: 0–10 steps, the frame's sum checked.)
        let m = model("mk-areson", 0xFA07);
        let mut ok = report(0x09, 17, &[(1, 0x04), (6, 8)]);
        ok[16] = 0x55u8.wrapping_sub(sum8(&ok[..16]));
        let mut f = fake(m);
        f.replies.push_back(vec![ok.clone()]);
        assert_eq!(read1(&mut f, m), at(steps(8, 10).unwrap(), Charging::No));
        let mut bad = ok.clone();
        bad[16] ^= 1;
        let mut f = fake(m);
        f.replies.push_back(vec![bad]);
        assert_eq!(read1(&mut f, m), Outcome::NoAnswer, "a bad checksum is no reply");
        // (XM2we: battery, then link; not linked and not charging → asleep.)
        let m = model("mk-endgame-we", 0x1961);
        let frame = |op: u8, pl: &[u8]| {
            let mut r = report(0x09, 17, &[(1, op), (5, pl.len() as u8)]);
            r[6..6 + pl.len()].copy_from_slice(pl);
            r[16] = 0x55u8.wrapping_sub(sum8(&r[..16]));
            r
        };
        let mut f = fake(m);
        f.replies.extend([vec![frame(0x04, &[42, 0])], vec![frame(0x03, &[1])]]);
        assert_eq!(read1(&mut f, m), at(pctl(42), Charging::No));
        let mut f = fake(m);
        f.replies.extend([vec![frame(0x04, &[42, 0])], vec![frame(0x03, &[0])]]);
        assert_eq!(read1(&mut f, m), dozing(7));
        // (Fantech, read back as a feature report when no input came.)
        let m = model("mk-fantech", 0xFA7C);
        let mut f = fake(m);
        f.features.insert(0x08, report(0x08, 17, &[(1, 0x04), (6, 33), (7, 0)]));
        assert_eq!(read1(&mut f, m), at(pctl(33), Charging::No));
    }
}
