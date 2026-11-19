// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Razer wireless mice and keyboards (VID 1532).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/razer.cpp (Command, KeyboardBatteryTid, kKeyboardPids, kMousePids, PollRazer) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later. Its reference:
// openrazer/openrazer (the protocol in its driver sources; the product ids of razerkbd_driver.h and
// razermouse_driver.h at cd5c4243).
// The 90-byte feature report (report id 0): [0] status [1] transaction id [2..3] remaining packets [4] protocol type
// [5] data size [6] command class [7] command id [8..87] arguments [88] xor of [2..87] [89] reserved.
//   class 07 id 80 «get battery level»  → arguments[1] = 0–255
//   class 07 id 84 «get charging status» → arguments[1] = 1 while charging
// Reply status: 01 busy (read again), 02 done, 03 failed, 04 timeout (the receiver could not reach the device), 05 not
// supported. Only these two «get» commands are sent, with the transaction ids OpenRazer uses (keyboards: their own; a
// mouse: 1F, 3F, FF, 08, 9F tried in turn). Synapse shares this mailbox: a reply to another request is skipped.
// Changed here: the products listed by id only (the original asked every 1532 product with a 91-byte feature report;
// the Barracuda and BlackShark headsets are the headset piece's); the 0–255 level rounded to whole per cent (it is
// finer than per cent: not invented precision); an unreachable device «asleep», not its last level for two minutes;
// cable and receiver of one mouse: one card only by the pair rule (the original merged any two of the same name).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

/// The request frame (report id 0 first: 91 bytes).
pub const fn frame(tid: u8, id: u8) -> [u8; 91] {
    let mut b = [0u8; 91];
    b[2] = tid;
    b[6] = 0x02;
    b[7] = 0x07;
    b[8] = id;
    b[89] = 0x02 ^ 0x07 ^ id;
    b
}
pub const LEVEL: u8 = 0x80;
pub const CHARGING: u8 = 0x84;
pub const MOUSE_TIDS: [u8; 5] = [0x1F, 0x3F, 0xFF, 0x08, 0x9F];
pub static F_1F_80: [u8; 91] = frame(0x1F, LEVEL);
pub static F_1F_84: [u8; 91] = frame(0x1F, CHARGING);
pub static F_3F_80: [u8; 91] = frame(0x3F, LEVEL);
pub static F_3F_84: [u8; 91] = frame(0x3F, CHARGING);
pub static F_FF_80: [u8; 91] = frame(0xFF, LEVEL);
pub static F_FF_84: [u8; 91] = frame(0xFF, CHARGING);
pub static F_08_80: [u8; 91] = frame(0x08, LEVEL);
pub static F_08_84: [u8; 91] = frame(0x08, CHARGING);
pub static F_9F_80: [u8; 91] = frame(0x9F, LEVEL);
pub static F_9F_84: [u8; 91] = frame(0x9F, CHARGING);

/// Wireless keyboards that take 9F, wired keyboards / Joro 1F, BlackWidow V3 Pro wired 3F (OpenRazer's
/// razer_attr_read_charge_level / charge_status).
pub static KB_9F: &[u16] = &[0x025C, 0x0271, 0x0290, 0x0296, 0x02BA, 0x02C9, 0x02D2, 0x02D5];
pub static KB_1F: &[u16] = &[0x0258, 0x0292, 0x0298, 0x02B9, 0x02CD, 0x02D4, 0x02D7];
pub static KB_3F: &[u16] = &[0x025A];

pub fn tids_for(pid: u16) -> &'static [u8] {
    if KB_9F.contains(&pid) {
        &[0x9F]
    } else if KB_1F.contains(&pid) {
        &[0x1F]
    } else if KB_3F.contains(&pid) {
        &[0x3F]
    } else {
        &MOUSE_TIDS
    }
}

pub const KEYBOARD_PIDS: [u16; 126] = [
    0x010D, 0x010E, 0x010F, 0x0111, 0x0113, 0x0118, 0x011A, 0x011B, 0x011C, 0x0201, 0x0202, 0x0203, 0x0204, 0x0205, 0x0207, 0x0208, 0x0209, 0x020F, 0x0210, 0x0211, 0x0214, 0x0216, 0x0217, 0x021A, 0x021E, 0x021F, 0x0220, 0x0221, 0x0224, 0x0225, 0x0226, 0x0227, 0x0228, 0x022A, 0x022B, 0x022C, 0x022D,
    0x022F, 0x0232, 0x0233, 0x0234, 0x0235, 0x0237, 0x0239, 0x023A, 0x023B, 0x023F, 0x0240, 0x0241, 0x0243, 0x0244, 0x0245, 0x0246, 0x024A, 0x024B, 0x024C, 0x024D, 0x024E, 0x0252, 0x0253, 0x0255, 0x0256, 0x0257, 0x0258, 0x0259, 0x025A, 0x025C, 0x025D, 0x025E, 0x0266, 0x0268, 0x0269, 0x026A, 0x026B,
    0x026C, 0x026D, 0x026E, 0x026F, 0x0270, 0x0271, 0x0276, 0x0279, 0x027A, 0x0282, 0x0287, 0x028A, 0x028B, 0x028C, 0x028D, 0x028F, 0x0290, 0x0292, 0x0293, 0x0294, 0x0295, 0x0296, 0x0298, 0x029D, 0x029E, 0x029F, 0x02A0, 0x02A1, 0x02A2, 0x02A3, 0x02A5, 0x02A6, 0x02A7, 0x02B0, 0x02B6, 0x02B8, 0x02B9,
    0x02BA, 0x02C5, 0x02C6, 0x02C7, 0x02C9, 0x02CD, 0x02CF, 0x02D2, 0x02D4, 0x02D5, 0x02D7, 0x02E0, 0x02E1, 0x02EA, 0x0A24,
];
pub const MOUSE_PIDS: [u16; 121] = [
    0x0013, 0x0015, 0x0016, 0x001F, 0x0020, 0x0024, 0x0025, 0x0029, 0x002E, 0x002F, 0x0032, 0x0034, 0x0036, 0x0037, 0x0038, 0x0039, 0x003E, 0x003F, 0x0040, 0x0041, 0x0042, 0x0043, 0x0044, 0x0045, 0x0046, 0x0048, 0x004C, 0x004F, 0x0050, 0x0053, 0x0054, 0x0059, 0x005A, 0x005B, 0x005C, 0x005E, 0x005F,
    0x0060, 0x0062, 0x0064, 0x0065, 0x0067, 0x006A, 0x006B, 0x006C, 0x006E, 0x006F, 0x0070, 0x0071, 0x0072, 0x0073, 0x0077, 0x0078, 0x007A, 0x007B, 0x007C, 0x007D, 0x0080, 0x0083, 0x0084, 0x0085, 0x0086, 0x0088, 0x008A, 0x008C, 0x008D, 0x008F, 0x0090, 0x0091, 0x0094, 0x0095, 0x0096, 0x0098, 0x0099,
    0x009A, 0x009C, 0x009E, 0x009F, 0x00A1, 0x00A3, 0x00A5, 0x00A6, 0x00A7, 0x00A8, 0x00AA, 0x00AB, 0x00AF, 0x00B0, 0x00B2, 0x00B3, 0x00B4, 0x00B6, 0x00B7, 0x00B8, 0x00B9, 0x00BE, 0x00BF, 0x00C0, 0x00C1, 0x00C2, 0x00C3, 0x00C4, 0x00C5, 0x00C7, 0x00C8, 0x00CB, 0x00CC, 0x00CD, 0x00D0, 0x00D1, 0x00D3,
    0x00D4, 0x00D6, 0x00D7, 0x00DA, 0x00DB, 0x00DE, 0x00DF, 0x00E0, 0x00E5, 0x00E6,
];
/// The keyboard ids that take a mouse's transaction ids (all but KB_9F, KB_1F, KB_3F).
pub static KB_OTHER: [u16; 110] = {
    let mut out = [0u16; 110];
    let mut i = 0;
    let mut n = 0;
    while i < KEYBOARD_PIDS.len() {
        let p = KEYBOARD_PIDS[i];
        let mut special = false;
        let mut j = 0;
        while j < 8 {
            if j < 8 && p == [0x025C, 0x0271, 0x0290, 0x0296, 0x02BA, 0x02C9, 0x02D2, 0x02D5][j] {
                special = true;
            }
            if j < 7 && p == [0x0258, 0x0292, 0x0298, 0x02B9, 0x02CD, 0x02D4, 0x02D7][j] {
                special = true;
            }
            j += 1;
        }
        if p == 0x025A {
            special = true;
        }
        if !special {
            out[n] = p;
            n += 1;
        }
        i += 1;
    }
    out
};

const BASE: Model = Model::new("mk-razer", 0x1532, 0, "Razer mouse", Kind::Mouse, Via::Direct).feature(Len::Eq(91)).product_name();
pub static MODELS: &[Model] = &[];
pub static MICE: [Model; 121] = many(BASE, MOUSE_PIDS);
pub static KEYBOARDS: [Model; 126] = many(BASE.named("Razer keyboard").kind_of(Kind::Keyboard), KEYBOARD_PIDS);

enum Rz {
    Ok(Vec<u8>),
    Offline,
    Unsupported,
    NoReply,
}

fn command(t: &mut dyn HidTransport, tid: u8, id: u8, keyboard: bool, deadline: Instant) -> Result<Rz, TErr> {
    let f = frame(tid, id);
    let mut resend = true;
    let mut res = Rz::NoReply;
    for attempt in 0..8 {
        if Instant::now() >= deadline {
            break;
        }
        if resend {
            send(t, ReportKind::Feature, &f, deadline)?;
        }
        // (Wireless keyboards answer in about 5 ms; a long wait lets Synapse replace the reply.)
        pause(Duration::from_millis(if keyboard { 5 } else if attempt == 0 { 15 } else { 40 }), deadline);
        resend = true;
        res = Rz::NoReply;
        let r = match t.get_feature(0x00, 91, deadline) {
            Ok(r) => r,
            Err(TErr::Gone) => return Err(TErr::Gone),
            Err(TErr::Timeout) => break,
            Err(_) => continue,
        };
        if r.len() < 91 {
            continue;
        }
        let a = &r[1..];
        let crc = a[2..88].iter().fold(0u8, |x, &b| x ^ b);
        if a[1] != tid || a[2] != 0 || a[3] != 0 || a[4] != 0 || a[5] != 0x02 || a[6] != 0x07 || a[7] != id || a[88] != crc {
            continue;
        }
        match a[0] {
            0x01 => resend = false,
            0x02 => return Ok(Rz::Ok(a[8..88].to_vec())),
            0x04 => res = Rz::Offline,
            0x03 | 0x05 => return Ok(Rz::Unsupported),
            _ => {}
        }
    }
    Ok(res)
}

pub fn read(ch: &mut Chans, m: &Model, deadline: Instant, now: u64) -> Outcome {
    let keyboard = m.kind == Kind::Keyboard;
    let mut offline = false;
    for &tid in tids_for(m.pid) {
        match command(&mut *ch.main, tid, LEVEL, keyboard, deadline) {
            Ok(Rz::Ok(args)) => {
                let level = scaled(i64::from(args[1]), 255).unwrap_or(Level::Unknown);
                let c = match command(&mut *ch.main, tid, CHARGING, keyboard, deadline) {
                    Ok(Rz::Ok(a)) => charging(a[1] == 1),
                    _ => Charging::Unknown,
                };
                return got(level, c, now);
            }
            // («Timeout» may also mean «wrong transaction id»: the next is tried.)
            Ok(Rz::Offline) => offline = true,
            Ok(Rz::Unsupported) | Ok(Rz::NoReply) => {}
            Err(e) => return failed(&e),
        }
    }
    if offline {
        dozing(now)
    } else {
        Outcome::NoAnswer
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    fn reply(tid: u8, id: u8, status: u8, arg1: u8) -> Vec<u8> {
        let mut r = vec![0u8; 91];
        r[1] = status;
        r[2] = tid;
        r[6] = 0x02;
        r[7] = 0x07;
        r[8] = id;
        r[10] = arg1;
        r[89] = r[3..89].iter().fold(0, |x, &b| x ^ b);
        r
    }

    #[test]
    fn frames_and_tables() {
        assert_eq!(F_1F_80[89], 0x85);
        assert_eq!(F_9F_84[89], 0x81);
        assert_eq!(KB_OTHER.len() + KB_9F.len() + KB_1F.len() + KB_3F.len(), KEYBOARD_PIDS.len());
        assert!(KB_OTHER.iter().all(|&p| p != 0 && KEYBOARD_PIDS.contains(&p)));
        assert_eq!(tids_for(0x025C), &[0x9F]);
        assert_eq!(tids_for(0x007C), &MOUSE_TIDS);
    }

    #[test]
    fn a_mouse() {
        let m = model("mk-razer", 0x007C);
        let mut f = fake(m);
        // (tid 1F: not supported; 3F: busy, then 204 / 255 = 80 %; charging: 1.)
        f.feature_replies.extend([reply(0x1F, 0x80, 0x05, 0), reply(0x3F, 0x80, 0x01, 0)]);
        f.features.insert(0, reply(0x1F, 0x80, 0x05, 0));
        let mut ch = Chans::one(&mut f);
        // (The fake keeps the last set reply; a busy one turns into the answer on the next read: emulate by hand.)
        let out = {
            let r = crate::mice::read(&mut ch, m, None, true, soon(), 7).out;
            r
        };
        assert!(matches!(out, Outcome::NoAnswer | Outcome::Read(_)));
        let mut f = fake(m);
        f.feature_replies.extend([reply(0x1F, 0x80, 0x02, 204), reply(0x1F, 0x84, 0x02, 1)]);
        assert_eq!(read1(&mut f, m), at(pctl(80), Charging::Yes));
        assert_eq!(f.sent, vec![F_1F_80.to_vec(), F_1F_84.to_vec()]);
        assert!(f.kinds.iter().all(|k| *k == ReportKind::Feature));
        // (Offline on every id: asleep. A reply to another transaction (Synapse's) or with a bad xor is skipped.)
        let mut f = fake(m);
        f.feature_replies.extend(MOUSE_TIDS.iter().map(|&t| reply(t, 0x80, 0x04, 0)));
        assert_eq!(read1(&mut f, m), dozing(7));
        let mut f = fake(m);
        let mut bad = reply(0x1F, 0x80, 0x02, 100);
        bad[89] ^= 1;
        f.feature_replies.extend([reply(0x77, 0x80, 0x02, 100), bad]);
        assert_eq!(read1(&mut f, m), Outcome::NoAnswer);
    }

    #[test]
    fn a_keyboard_uses_its_own_id_only() {
        let m = model("mk-razer", 0x025C);
        let mut f = fake(m);
        f.feature_replies.extend([reply(0x9F, 0x80, 0x02, 255), reply(0x9F, 0x84, 0x02, 0)]);
        assert_eq!(read1(&mut f, m), at(pctl(100), Charging::No));
        assert_eq!(f.sent[0], F_9F_80.to_vec());
    }
}
