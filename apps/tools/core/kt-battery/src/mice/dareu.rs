// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): DAREU EM901X (260D:1074 receiver, 1090 cable) — «Compx 17» battery
// request as feature report 08 on FF02:0002 of interface 1, the reply input report 09 on the sibling FF01:0000
// (proto.rs).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/dareu.cpp at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors,
// GPL-3.0-or-later. Its references: the EM901X AIM-WL driver v1.0, wushuai0802/myfinder-device-battery.
// Reply: [09][04][00 status]…[6 percent][7 charging], exactly 17 bytes (no checksum rule is established).
// D1 (the original's v1.1.0 dareu.cpp at commit 7cc44f2):
//  - Sharkoon Skiller SGM50W (260D:1125): the same FF02:0002 feature / FF01:0000 input pair; Sharkoon's updater for it
//    is a Compx tool. The same request.
//  - DAREU A84 keyboard (260D:0022, interface 0, the keyboard collection's 65-byte feature report): the official
//    launcher's only command, feature [00][04 F6], then feature report 0 read back — three reads discarded, as the
//    launcher does, then up to three until byte 15 is not 0; byte 5 the level in percent. No charging flag.
//  - DAREU's «Togran» protocol (receiver 260D:1131, the A980 Pro on its cable 1148), DAREU's own driver: feature report
//    0A on the consumer collection (000C:0001, 65 bytes) [0A][slot << 4][len][class][cmd], the reply read back as
//    feature 0A echoing class and command with (byte 1 & 0F) = 2. Slot 0 class 00 / A0 lists the paired mice (count at
//    [7], then three bytes each: present, product id); slot n class 07 / 80 → [7] status (1 charging) [8] level
//    [9] its maximum. Each paired mouse its own card (Answer::slots).
// Changed here: the cable and the receiver of one mouse: one card by the pair rule (the original preferred the cable);
// a Togran level whose maximum is not 100 is shown as steps of that maximum, not converted.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;

const fn cmd(pid: u16, via: Via) -> Model {
    Model::new("mk-dareu", 0x260D, pid, "DAREU EM901X", Kind::Mouse, via).iface(1).page(0xFF02).usage(0x0002).feature(Len::Eq(17)).pair("dareu:em901x")
}
const fn rep(pid: u16, via: Via) -> Model {
    Model::new("mk-dareu", 0x260D, pid, "DAREU EM901X", Kind::Mouse, via).iface(1).page(0xFF01).usage(0x0000).input(Len::Eq(17)).role(Role::Reply)
}

pub static MODELS: &[Model] = &[cmd(0x1074, Via::Receiver), cmd(0x1090, Via::Cable), rep(0x1074, Via::Receiver), rep(0x1090, Via::Cable)];

const fn sk(pid: u16, role: Role) -> Model {
    let m = Model::new("mk-sharkoon", 0x260D, pid, "Sharkoon Skiller SGM50W", Kind::Mouse, Via::Receiver).iface(1).role(role);
    match role {
        Role::Reply => m.page(0xFF01).usage(0x0000).input(Len::Eq(17)),
        _ => m.page(0xFF02).usage(0x0002).feature(Len::Eq(17)),
    }
}
const fn tg(pid: u16, name: &'static str, via: Via) -> Model {
    Model::new("mk-dareu-togran", 0x260D, pid, name, Kind::Mouse, via).page(0x000C).usage(0x0001).feature(Len::Eq(65))
}

/// D1's rows.
pub static V110: &[Model] = &[
    sk(0x1125, Role::Main),
    sk(0x1125, Role::Reply),
    Model::new("mk-dareu-a84", 0x260D, 0x0022, "DAREU A84", Kind::Keyboard, Via::Direct).iface(0).page(0x0001).usage(0x0006).feature(Len::Eq(65)),
    tg(0x1131, "DAREU wireless mouse", Via::Receiver).slots(&TOGRAN_SLOTS),
    tg(0x1148, "DAREU A980 Pro", Via::Cable),
];

pub const TOGRAN_SLOTS: [u8; 5] = [1, 2, 3, 4, 5];
pub const A84: [u8; 3] = [0x00, 0x04, 0xF6];
/// Slot 0's list of paired mice.
pub const TOGRAN_LIST: [u8; 5] = [0x0A, 0x00, 0x06, 0x00, 0xA0];
/// A slot's battery (slot 0: the mouse on its cable).
pub const fn togran_battery(slot: u8) -> [u8; 5] {
    [0x0A, slot << 4, 0x04, 0x07, 0x80]
}

pub fn read_a84(ch: &mut Chans, _m: &Model, deadline: Instant, now: u64) -> Outcome {
    if let Err(e) = send(&mut *ch.main, ReportKind::Feature, &A84, deadline) {
        return failed(&e);
    }
    for i in 0..6 {
        pause(ms(10), deadline);
        let r = match ch.main.get_feature(0x00, 65, deadline) {
            Ok(r) => r,
            Err(TErr::Gone) => return Outcome::Failed,
            Err(_) => continue,
        };
        // (The launcher's first three reads are not the answer.)
        if i < 3 || r.len() < 16 || r[15] == 0 {
            continue;
        }
        return match pct(i64::from(r[5])) {
            Some(l) => got(l, Charging::Unknown, now),
            None => no_level(Charging::Unknown, now),
        };
    }
    Outcome::NoAnswer
}

fn togran(ch: &mut Chans, req: &[u8; 5], deadline: Instant) -> Result<Vec<u8>, TErr> {
    let (cls, cmd) = (req[3], req[4]);
    feat_ask(&mut *ch.main, req, 0x0A, 65, ms(30), 15, deadline, &mut |r| if r.len() >= 11 && r[0] == 0x0A && r[1] & 0x0F == 2 && r[3] == cls && r[4] == cmd { Some(r.to_vec()) } else { None })
}

fn togran_level(b: &[u8], now: u64) -> Outcome {
    let max = if b[9] == 0 { 100 } else { b[9] };
    let level = if max == 100 { pct(i64::from(b[8])) } else { steps(i64::from(b[8]), i64::from(max)) };
    match level {
        Some(l) => got(l, charging(b[7] == 1), now),
        None => no_level(Charging::Unknown, now),
    }
}

/// The paired mice of the receiver's list: (slot, mouse product id).
pub fn togran_paired(r: &[u8]) -> Vec<(u8, u16)> {
    let n = usize::from(r[7]).min(5);
    (1..=n).filter_map(|s| r.get(8 + (s - 1) * 3..8 + (s - 1) * 3 + 3).filter(|e| e[0] != 0).map(|e| (s as u8, u16::from(e[1]) << 8 | u16::from(e[2])))).collect()
}

pub fn read_togran(ch: &mut Chans, m: &Model, slot: Option<u8>, deadline: Instant, now: u64) -> Answer {
    if m.via == Via::Cable {
        return match togran(ch, &togran_battery(0), deadline) {
            Ok(b) => togran_level(&b, now).into(),
            Err(e) => failed(&e).into(),
        };
    }
    if let Some(s) = slot {
        if !m.slots.contains(&s) {
            return Outcome::Failed.into();
        }
        return match togran(ch, &togran_battery(s), deadline) {
            Ok(b) => togran_level(&b, now).into(),
            Err(TErr::Gone) => Outcome::Failed.into(),
            Err(_) => dozing(now).into(),
        };
    }
    let list = match togran(ch, &TOGRAN_LIST, deadline) {
        Ok(r) => togran_paired(&r),
        Err(e) => return failed(&e).into(),
    };
    let Some(&(first, mpid)) = list.first() else {
        return Answer { out: unlinked(now), slots: Some(Vec::new()), name: None, kind: None, unit: None };
    };
    let mut a: Answer = match togran(ch, &togran_battery(first), deadline) {
        Ok(b) => togran_level(&b, now).into(),
        Err(TErr::Gone) => return Outcome::Failed.into(),
        Err(_) => dozing(now).into(),
    };
    if mpid == 0x1148 {
        a.name = Some("DAREU A980 Pro".into());
    }
    a.slots = Some(list.iter().map(|x| x.0).collect());
    a
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;

    fn tg_reply(cls: u8, cmd: u8, at: &[(usize, u8)]) -> Vec<u8> {
        let mut v = vec![(1, 0x02), (3, cls), (4, cmd)];
        v.extend_from_slice(at);
        report(0x0A, 65, &v)
    }

    #[test]
    fn v110() {
        // (Sharkoon: the EM901X's request and reply.)
        let s = model("mk-sharkoon", 0x1125);
        let mut f = fake(s);
        f.replies.push_back(vec![report(0x09, 17, &[(1, 0x04), (6, 58), (7, 1)])]);
        assert_eq!(read1(&mut f, s), at(pctl(58), Charging::Yes));
        assert_eq!(f.sent, vec![super::super::proto::COMPX_BATTERY.to_vec()]);
        // (A84: three reads discarded, then byte 15 set.)
        let k = model("mk-dareu-a84", 0x0022);
        let mut f = fake(k);
        f.features.insert(0x00, report(0x00, 65, &[(5, 72), (15, 1)]));
        assert_eq!(read1(&mut f, k), at(pctl(72), Charging::Unknown));
        assert_eq!((f.sent.clone(), f.kinds.clone()), (vec![A84.to_vec()], vec![ReportKind::Feature]));
        let mut f = fake(k);
        f.features.insert(0x00, report(0x00, 65, &[(5, 72)]));
        assert_eq!(read1(&mut f, k), Outcome::NoAnswer, "byte 15 never set");
        // (Togran cable: slot 0; a level of a maximum other than 100 stays steps.)
        let c = model("mk-dareu-togran", 0x1148);
        let mut f = fake(c);
        f.feature_replies.push_back(tg_reply(0x07, 0x80, &[(7, 1), (8, 64), (9, 100)]));
        assert_eq!(read1(&mut f, c), at(pctl(64), Charging::Yes));
        assert_eq!(f.sent, vec![togran_battery(0).to_vec()]);
        let mut f = fake(c);
        f.feature_replies.push_back(tg_reply(0x07, 0x80, &[(8, 3), (9, 4)]));
        assert_eq!(read1(&mut f, c), at(steps(3, 4).unwrap(), Charging::No));
        // (The receiver: its list, then each paired mouse its own card.)
        let r = model("mk-dareu-togran", 0x1131);
        let mut f = fake(r);
        f.feature_replies.extend([tg_reply(0x00, 0xA0, &[(7, 2), (8, 0), (11, 1), (12, 0x11), (13, 0x48)]), tg_reply(0x07, 0x80, &[(8, 40)])]);
        let a = read(&mut Chans::one(&mut f), r, None, true, soon(), 7);
        assert_eq!((a.out, a.slots, a.name.as_deref()), (at(pctl(40), Charging::No), Some(vec![2]), Some("DAREU A980 Pro")));
        assert_eq!(f.sent, vec![TOGRAN_LIST.to_vec(), togran_battery(2).to_vec()]);
        let mut f = fake(r);
        f.feature_replies.push_back(tg_reply(0x07, 0x80, &[(8, 90)]));
        assert_eq!(read(&mut Chans::one(&mut f), r, Some(2), true, soon(), 7).out, at(pctl(90), Charging::No));
        let mut f = fake(r);
        assert_eq!(read(&mut Chans::one(&mut f), r, Some(6), true, soon(), 7).out, Outcome::Failed, "a slot it has not: nothing sent");
        assert!(f.sent.is_empty());
        let mut f = fake(r);
        f.feature_replies.push_back(tg_reply(0x00, 0xA0, &[(7, 0)]));
        assert_eq!(read(&mut Chans::one(&mut f), r, None, true, soon(), 7).out, unlinked(7));
    }
}
