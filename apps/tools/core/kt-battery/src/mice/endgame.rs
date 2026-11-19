// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Endgame Gear 4K mice (OP1w 4k, XM2w 4k, v1 / v2) on the shared 4K
// dongle 3367:1970, and the XM2we on its own receiver 3367:1961 (proto.rs, «Compx 17» as a feature).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/endgame.cpp (MouseName, Command, PollEndgame) and endgame_we.cpp at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later. Their references:
// johanneszab/vole (re/PROTOCOL.md), Janlhin/Endgame_Gear_Web_Configurator, HeyOkay/HaloBattery, okms/xm2we-linux.
// 4K: config channel FF01:0002, feature report A1 (64 bytes): [A1][cmd][target][payload length][00 …]; read back as
// feature report A1: [1] status 01 ok, 03 busy (read again), 08 / 11 the mouse asleep or away. B4 battery → [16]
// percent; 0E mouse info → [16..17] 67 33, [18..19] the mouse's product id (its name).
// Changed here: the 0F probe the original sent after a failed command is not sent (it keeps the mouse from sleeping):
// a dongle that stays silent after a failure says «needs a query we do not send» until it answers again; the mouse's
// name is not kept across rounds in a global (the original's lastName): the card is named by the info read each time.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

pub static MODELS: &[Model] = &[
    Model::new("mk-endgame-4k", 0x3367, 0x1970, "Endgame Gear 4k wireless mouse", Kind::Mouse, Via::Receiver).page(0xFF01).usage(0x0002).feature(Len::Min(64)),
    Model::new("mk-endgame-we", 0x3367, 0x1961, "Endgame Gear XM2we", Kind::Mouse, Via::Receiver).page(0xFF02).usage(0x0002).feature(Len::Min(17)),
    Model::new("mk-endgame-we", 0x3367, 0x1961, "Endgame Gear XM2we", Kind::Mouse, Via::Receiver).page(0xFF01).usage(0x0000).input(Len::Min(17)).role(Role::Reply),
];

pub const BATTERY: [u8; 3] = [0xA1, 0xB4, 0x00];
pub const INFO: [u8; 3] = [0xA1, 0x0E, 0x00];

pub fn mouse_name(pid: u16) -> Option<&'static str> {
    match pid {
        0x1972 => Some("Endgame Gear OP1w 4k"),
        0x1984 => Some("Endgame Gear OP1w 4k v2"),
        0x1968 => Some("Endgame Gear XM2w 4k"),
        0x1982 => Some("Endgame Gear XM2w 4k v2"),
        _ => None,
    }
}

fn command(t: &mut dyn HidTransport, req: &[u8], deadline: Instant) -> Result<Vec<u8>, TErr> {
    let mut tries = 0;
    feat_ask(t, req, 0xA1, 64, ms(150), 3, deadline, &mut |r| {
        tries += 1;
        if r.len() < 20 || r[0] != 0xA1 {
            return None;
        }
        // (03 busy: read again, up to three times.)
        if r[1] == 0x03 && tries < 3 {
            return None;
        }
        Some(r.to_vec())
    })
}

pub fn read_4k(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Answer {
    let r = match command(&mut *ch.main, &BATTERY, deadline) {
        Ok(r) => r,
        Err(TErr::BadReply) => return needs_query(now).into(),
        Err(e) => return failed(&e).into(),
    };
    match r[1] {
        0x01 if r[16] <= 100 => {
            let mut a: Answer = got(pct(i64::from(r[16])).unwrap_or(Level::Unknown), Charging::Unknown, now).into();
            if let Ok(i) = command(&mut *ch.main, &INFO, deadline) {
                if i[1] == 0x01 && i[16] == 0x67 && i[17] == 0x33 {
                    a.name = mouse_name(u16::from(i[18]) | u16::from(i[19]) << 8).map(str::to_string);
                }
            }
            a
        }
        0x08 | 0x11 => dozing(now).into(),
        // (Another status: the dongle wants the probe we do not send.)
        _ => needs_query(now).into(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    #[test]
    fn four_k() {
        let m = model("mk-endgame-4k", 0x1970);
        let mut f = fake(m);
        f.feature_replies.extend([report(0xA1, 64, &[(1, 0x01), (16, 73)]), report(0xA1, 64, &[(1, 0x01), (16, 0x67), (17, 0x33), (18, 0x84), (19, 0x19)])]);
        let a = crate::mice::read(&mut Chans::one(&mut f), m, None, true, soon(), 7);
        assert_eq!(a.out, at(pctl(73), Charging::Unknown));
        assert_eq!(a.name.as_deref(), Some("Endgame Gear OP1w 4k v2"));
        assert_eq!(f.sent, vec![BATTERY.to_vec(), INFO.to_vec()], "never the 0F probe");
        let mut f = fake(m);
        f.feature_replies.push_back(report(0xA1, 64, &[(1, 0x11)]));
        assert_eq!(read1(&mut f, m), dozing(7));
        let mut f = fake(m);
        f.feature_replies.push_back(report(0xA1, 64, &[(1, 0x09)]));
        assert_eq!(read1(&mut f, m), needs_query(7));
        let mut f = fake(m);
        f.feature_replies.push_back(report(0xA1, 64, &[(1, 0x01), (16, 101)]));
        assert_eq!(read1(&mut f, m), needs_query(7), "101 %: no reading");
    }
}
