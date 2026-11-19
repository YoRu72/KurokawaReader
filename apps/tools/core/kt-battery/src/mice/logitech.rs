// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Logitech HID++ 1.0 / 2.0 (Unifying, Bolt, LIGHTSPEED and Nano
// receivers; the devices themselves on their cable or Bluetooth).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/logitech.cpp (Hidpp, ReadBattery20, ReadNameAndType20, ReadUnitId20, ReadBattery10,
// PollLogitechDevice, PollLogitech) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its
// contributors, GPL-3.0-or-later. Its references: Logitech's HID++ 2.0 drafts, Solaar (pwr-Solaar/Solaar).
// Message: [report][device index][feature index][function << 4 | sw id][parameters]; report 10 = short (7 bytes),
// 11 = long (20). Errors: [.., FF, feature, fn|sw, code] (2.0), [.., 8F, sub id, address, code] (1.0).
// Asked here, all reads (allow.rs `permit_hidpp`, with the device's own feature index on this handle's session):
//   ping (root fn 1, 00 00 5A) — the protocol version: 2.0 if ≥ 2, «invalid sub id» (01): a HID++ 1.0 device;
//   root getFeature for 1004 UNIFIED_BATTERY, 1000 BATTERY_STATUS, 1001 BATTERY_VOLTAGE, 0005 DEVICE_NAME,
//   0003 DEVICE_INFORMATION; 1004 get_status, 1000 GetBatteryLevelStatus, 1001 GetBatteryInfo, 0005 getCount /
//   getDeviceName / getDeviceType, 0003 getDeviceInfo (the unit id); HID++ 1.0: GET_REGISTER 0D (battery %) and 07
//   (battery level 1–7).
// Changed here: products by id (the original asked every 046D product with such a collection, headsets among them:
// G headsets are the headset piece's, as is the G435 on 0ADF); ADC_MEASUREMENT (1F20, headsets only) not asked; a
// receiver's slots probed once and then each device its own card (the original pinged all six every minute); the
// level as the device gives it — UNIFIED_BATTERY's percentage, else its level flags as words (the original: 100 / 60 /
// 20 / 5 %), BATTERY_VOLTAGE as a coarse word (the original: a Li-ion curve to the per cent), HID++ 1.0's register 07
// as 1–7 steps (the original: 0–100 % from a table); a receiver's sleeping device «asleep», never its last level for
// 30 minutes; the same unit id through the receiver and on the cable: one card (the original's key rule, kept).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use super::*;
use crate::allow::{hidpp, permit_hidpp, HidppSession};

/// Receivers (Unifying C52B / C532, Bolt C548, LIGHTSPEED C539 … C54D, Nano C51A … C537; Solaar's receiver list).
pub const RECEIVERS: [u16; 21] = [
    0xC52B, 0xC532, 0xC548, 0xC539, 0xC53A, 0xC53D, 0xC53F, 0xC541, 0xC545, 0xC547, 0xC54D, 0xC52F, 0xC526, 0xC52E, 0xC51A, 0xC51B, 0xC521, 0xC525, 0xC531, 0xC534, 0xC537,
];
/// The PRO X SUPERSTRIKE's dongle: HID++ 2.0 only, one device, on index 1 (Solaar's PASSTHROUGH_DONGLE_IDS).
pub const PASSTHROUGH: u16 = 0xC54F;
/// Wired G mice and keyboards on their own cable (HID++ on FF00:0001 / 0002).
pub const USB_DIRECT: [u16; 15] = [0xC08B, 0xC08D, 0xC088, 0xC094, 0xC086, 0xC091, 0xC087, 0xC090, 0xC081, 0xC082, 0xC083, 0xC08F, 0xC33E, 0xC343, 0xC33F];
/// Bluetooth LE devices (HID++ on FF43:0202): MX Master / Anywhere / Keys / Mechanical, Lift, K380.
pub const BLE_DIRECT: [u16; 14] = [0xB012, 0xB019, 0xB023, 0xB034, 0xB01A, 0xB025, 0xB037, 0xB35B, 0xB369, 0xB378, 0xB366, 0xB367, 0xB031, 0xB342];

/// Every Logitech product this reader (and allow.rs's HID++ rule) is for.
pub static PIDS: &[u16] = &[
    0xC52B, 0xC532, 0xC548, 0xC539, 0xC53A, 0xC53D, 0xC53F, 0xC541, 0xC545, 0xC547, 0xC54D, 0xC52F, 0xC526, 0xC52E, 0xC51A, 0xC51B, 0xC521, 0xC525, 0xC531, 0xC534, 0xC537, // receivers
    0xC54F, // passthrough dongle
    0xC08B, 0xC08D, 0xC088, 0xC094, 0xC086, 0xC091, 0xC087, 0xC090, 0xC081, 0xC082, 0xC083, 0xC08F, 0xC33E, 0xC343, 0xC33F, // cable
    0xB012, 0xB019, 0xB023, 0xB034, 0xB01A, 0xB025, 0xB037, 0xB35B, 0xB369, 0xB378, 0xB366, 0xB367, 0xB031, 0xB342, // Bluetooth
];

const SLOTS: &[u8] = &[1, 2, 3, 4, 5, 6];
const RX: Model = Model::new("mk-logitech", 0x046D, 0, "Logitech receiver", Kind::Mouse, Via::Receiver).slots(SLOTS);
pub static RX_SHORT: [Model; 21] = many(RX.page(0xFF00).usage(0x0001).output(Len::Eq(7)), RECEIVERS);
pub static RX_LONG: [Model; 21] = many(RX.page(0xFF00).usage(0x0002).output(Len::Eq(20)).role(Role::Long), RECEIVERS);
pub static PASS: [Model; 4] = [
    Model::new("mk-logitech", 0x046D, PASSTHROUGH, "Logitech PRO X SUPERSTRIKE", Kind::Mouse, Via::Receiver).slots(&[1]).page(0xFF43).usage(0x0301).output(Len::Eq(7)),
    Model::new("mk-logitech", 0x046D, PASSTHROUGH, "Logitech PRO X SUPERSTRIKE", Kind::Mouse, Via::Receiver).slots(&[1]).page(0xFF43).usage(0x0302).output(Len::Eq(20)).role(Role::Long),
    Model::new("mk-logitech", 0x046D, PASSTHROUGH, "Logitech PRO X SUPERSTRIKE", Kind::Mouse, Via::Receiver).slots(&[1]).page(0xFF00).usage(0x0001).output(Len::Eq(7)),
    Model::new("mk-logitech", 0x046D, PASSTHROUGH, "Logitech PRO X SUPERSTRIKE", Kind::Mouse, Via::Receiver).slots(&[1]).page(0xFF00).usage(0x0002).output(Len::Eq(20)).role(Role::Long),
];
const USB: Model = Model::new("mk-logitech", 0x046D, 0, "Logitech device", Kind::Mouse, Via::Direct).page(0xFF00);
pub static USB_SHORT: [Model; 15] = many(USB.usage(0x0001).output(Len::Eq(7)), USB_DIRECT);
pub static USB_LONG: [Model; 15] = many(USB.usage(0x0002).output(Len::Eq(20)).role(Role::Long), USB_DIRECT);
pub static BLE: [Model; 14] = many(Model::new("mk-logitech", 0x046D, 0, "Logitech device", Kind::Mouse, Via::Direct).page(0xFF43).usage(0x0202).output(Len::Eq(20)), BLE_DIRECT);

/// The device itself (not behind a receiver).
pub const SELF: u8 = 0xFF;

const F_UNIFIED: u16 = 0x1004;
const F_STATUS: u16 = 0x1000;
const F_VOLTAGE: u16 = 0x1001;
const F_NAME: u16 = 0x0005;
const F_INFO: u16 = 0x0003;
/// Piece 6: ADC_MEASUREMENT, G headsets' battery voltage (heads/logitech.rs).
const F_ADC: u16 = 0x1F20;

fn is_short(id: &HidIdent) -> bool {
    matches!((id.usage_page, id.usage), (0xFF00, 0x0001) | (0xFF43, 0x0301))
}

/// A reply: the parameters (after the four header bytes), or the error code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rep {
    Ok(Vec<u8>),
    Err(u8),
}

/// One HID++ device's handles (its short and long collections) and what this round learned of its feature indices.
pub struct Pp<'a> {
    short: Option<&'a mut dyn HidTransport>,
    long: Option<&'a mut dyn HidTransport>,
    session: HidppSession,
}

impl<'a> Pp<'a> {
    pub fn new(short: Option<&'a mut dyn HidTransport>, long: Option<&'a mut dyn HidTransport>) -> Pp<'a> {
        Pp { short, long, session: HidppSession::new() }
    }

    /// Sends one request and waits for its reply on either collection, for `step`, never past `deadline`.
    #[allow(clippy::too_many_arguments)]
    pub fn request(&mut self, idx: u8, b2: u8, b3: u8, params: &[u8], force_short: bool, step: Duration, deadline: Instant) -> Result<Rep, TErr> {
        let use_long = self.long.is_some() && !(force_short && self.short.is_some());
        let mut f = vec![0u8; if use_long { 20 } else { 7 }];
        f[0] = if use_long { 0x11 } else { 0x10 };
        f[1] = idx;
        f[2] = b2;
        f[3] = b3;
        for (i, &v) in params.iter().enumerate() {
            if 4 + i < f.len() {
                f[4 + i] = v;
            }
        }
        let end = deadline.min(Instant::now() + step);
        let w = {
            let t: &mut dyn HidTransport = if use_long { self.long.as_deref_mut().ok_or(TErr::Refused)? } else { self.short.as_deref_mut().ok_or(TErr::Refused)? };
            let w = permit_hidpp(&self.session, t.ident(), &f).ok_or(TErr::Refused)?;
            w
        };
        if let Some(t) = self.short.as_deref_mut() {
            t.flush();
        }
        if let Some(t) = self.long.as_deref_mut() {
            t.flush();
        }
        {
            let t: &mut dyn HidTransport = if use_long { self.long.as_deref_mut().ok_or(TErr::Refused)? } else { self.short.as_deref_mut().ok_or(TErr::Refused)? };
            t.send(&w, end)?;
        }
        let both = self.short.is_some() && self.long.is_some();
        loop {
            if Instant::now() >= end {
                return Err(TErr::Timeout);
            }
            let mut quiet = 0;
            for which in [true, false] {
                let t: Option<&mut dyn HidTransport> = if which { self.long.as_deref_mut() } else { self.short.as_deref_mut() };
                let Some(t) = t else { continue };
                // (Two collections: short turns on each, so neither keeps the other waiting.)
                let slice = if both { end.min(Instant::now() + Duration::from_millis(15)) } else { end };
                let r = match t.read_input(slice) {
                    Ok(r) => r,
                    Err(TErr::Gone) => return Err(TErr::Gone),
                    Err(_) => {
                        quiet += 1;
                        continue;
                    }
                };
                if r.len() < 7 || !(r[0] == 0x10 || r[0] == 0x11) || r[1] != idx {
                    continue;
                }
                if r[2] == b2 && r[3] == b3 {
                    if b2 == 0x00 && b3 == hidpp::SW {
                        self.session.learn(&w, &r);
                    }
                    return Ok(Rep::Ok(r[4..].to_vec()));
                }
                if (r[2] == 0xFF || r[2] == 0x8F) && r[3] == b2 && r[4] == b3 {
                    return Ok(Rep::Err(r[5]));
                }
            }
            if cfg!(test) && quiet > 0 && quiet == usize::from(self.short.is_some()) + usize::from(self.long.is_some()) {
                // (The fakes answer at once or never: nothing queued is nothing to come.)
                return Err(TErr::Timeout);
            }
        }
    }

    /// A HID++ 2.0 call: Some(parameters) on a reply, None on an error reply or no answer in time.
    fn call(&mut self, idx: u8, feature_index: u8, func: u8, params: &[u8], deadline: Instant) -> Result<Option<Vec<u8>>, TErr> {
        match self.request(idx, feature_index, (func << 4) | hidpp::SW, params, false, ms(500), deadline) {
            Ok(Rep::Ok(p)) => Ok(Some(p)),
            Ok(Rep::Err(_)) => Ok(None),
            Err(TErr::Timeout) | Err(TErr::BadReply) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// The index the device gives a feature (0: it has none).
    fn feature_index(&mut self, idx: u8, feature: u16, deadline: Instant) -> Result<u8, TErr> {
        Ok(self.call(idx, 0x00, 0, &[(feature >> 8) as u8, feature as u8], deadline)?.and_then(|p| p.first().copied()).filter(|&i| hidpp::feature_index_ok(i)).unwrap_or(0))
    }

    /// The ping: Ok(Some(version)) for HID++ 2.0+, Ok(None) for an error reply with its code.
    fn ping(&mut self, idx: u8, step: Duration, deadline: Instant) -> Result<Rep, TErr> {
        self.request(idx, 0x00, 0x10 | hidpp::SW, &[0x00, 0x00, 0x5A], false, step, deadline)
    }
}

/// What one device behind an index says.
#[derive(Clone, Debug, PartialEq)]
pub struct Dev {
    pub out: Outcome,
    pub name: Option<String>,
    pub kind: Option<Kind>,
    pub unit: Option<String>,
}

fn kind_of(t: u8) -> Option<Kind> {
    match t {
        0x00 | 0x02 => Some(Kind::Keyboard),
        0x03..=0x05 => Some(Kind::Mouse),
        0x08 => Some(Kind::Headset),
        _ => None,
    }
}

/// UNIFIED_BATTERY get_status: [state of charge %][level flags: 8 full, 4 good, 2 low, 1 critical][status].
pub fn unified(p: &[u8]) -> Option<(Level, Charging)> {
    if p.len() < 3 {
        return None;
    }
    let level = if (1..=100).contains(&p[0]) {
        pct(i64::from(p[0]))?
    } else if p[1] & 8 != 0 {
        Level::Coarse(Coarse::Full)
    } else if p[1] & 4 != 0 {
        Level::Coarse(Coarse::High)
    } else if p[1] & 2 != 0 {
        Level::Coarse(Coarse::Low)
    } else if p[1] & 1 != 0 {
        Level::Coarse(Coarse::Empty)
    } else {
        Level::Unknown
    };
    // (0 discharging, 1 charging, 2 charging slowly, 3 full, 4 error.)
    let ch = match p[2] {
        1 | 2 => Charging::Yes,
        0 | 3 => Charging::No,
        _ => Charging::Unknown,
    };
    Some((level, ch))
}

/// BATTERY_STATUS GetBatteryLevelStatus: [percent][next level][status: 0 discharging, 1 recharging, 2 almost full,
/// 3 full, 4 slow recharge, 5 invalid battery, 6 thermal error].
pub fn status(p: &[u8]) -> Option<(Level, Charging)> {
    if p.len() < 3 {
        return None;
    }
    let ch = match p[2] {
        1 | 2 | 4 => Charging::Yes,
        0 | 3 => Charging::No,
        _ => Charging::Unknown,
    };
    let level = if p[0] == 0 && p[2] == 3 { pct(100)? } else { pct(i64::from(p[0])).unwrap_or(Level::Unknown) };
    Some((level, ch))
}

/// BATTERY_VOLTAGE GetBatteryInfo: [mV hi][mV lo][flags: bit 7 charging].
pub fn voltage(p: &[u8]) -> Option<(Level, Charging)> {
    if p.len() < 3 {
        return None;
    }
    let mv = u32::from(p[0]) << 8 | u32::from(p[1]);
    Some((from_millivolts(mv), charging(p[2] & 0x80 != 0)))
}

/// ADC_MEASUREMENT getADCMeasurement (piece 6, G headsets): [mV hi][mV lo][flags: 3 charging]. The voltage as a coarse
/// word (the original turned it into a per cent with HeadsetControl's per-model curves); 0 mV: no level.
pub fn adc(p: &[u8]) -> Option<(Level, Charging)> {
    if p.len() < 3 {
        return None;
    }
    let mv = u32::from(p[0]) << 8 | u32::from(p[1]);
    let ch = match p[2] {
        0x03 => Charging::Yes,
        0x01 => Charging::No,
        _ => Charging::Unknown,
    };
    Some((if mv == 0 { Level::Unknown } else { from_millivolts(mv) }, ch))
}

fn reg_charging(b: u8) -> Charging {
    charging((0x21..=0x26).contains(&b))
}

/// Reads the device on `idx`.
pub fn read_index(pp: &mut Pp, idx: u8, receiver: bool, deadline: Instant, now: u64) -> Dev {
    let dev = |out| Dev { out, name: None, kind: None, unit: None };
    let ping = match pp.ping(idx, ms(400), deadline) {
        Ok(r) => r,
        Err(e) => return dev(failed(&e)),
    };
    match ping {
        Rep::Ok(p) if p.first().map_or(false, |&v| v >= 2) => read20(pp, idx, deadline, now),
        // («Invalid sub id»: a HID++ 1.0 device; its registers.)
        Rep::Err(0x01) => dev(read10(pp, idx, deadline, now)),
        Rep::Ok(_) => dev(no_level(Charging::Unknown, now)),
        // (A receiver's slot whose device is off, asleep or out of range: «unknown device», «resource error»…)
        Rep::Err(_) if receiver => dev(dozing(now)),
        Rep::Err(_) => dev(Outcome::NoAnswer),
    }
}

fn read20(pp: &mut Pp, idx: u8, deadline: Instant, now: u64) -> Dev {
    let mut d = Dev { out: no_level(Charging::Unknown, now), name: None, kind: None, unit: None };
    let r: Result<(), TErr> = (|| {
        let f = pp.feature_index(idx, F_NAME, deadline)?;
        if f != 0 {
            if let Some(p) = pp.call(idx, f, 0, &[], deadline)? {
                let len = usize::from(p.first().copied().unwrap_or(0)).min(64);
                let mut name = String::new();
                while name.len() < len && Instant::now() < deadline {
                    let Some(p) = pp.call(idx, f, 1, &[name.len() as u8], deadline)? else { break };
                    let before = name.len();
                    for &c in &p {
                        if name.len() >= len || c == 0 {
                            break;
                        }
                        if (0x20..0x7F).contains(&c) {
                            name.push(c as char);
                        } else {
                            name.push('?');
                        }
                    }
                    if name.len() == before {
                        break;
                    }
                }
                let name = name.trim().to_string();
                if !name.is_empty() {
                    d.name = Some(if name.starts_with("Logitech") || name.starts_with("G ") || name.starts_with("MX") || name.starts_with("PRO") { name } else { format!("Logitech {}", name) });
                }
            }
            if let Some(p) = pp.call(idx, f, 2, &[], deadline)? {
                d.kind = p.first().and_then(|&t| kind_of(t));
            }
        }
        let mut found: Option<(Level, Charging)> = None;
        for (feat, func, parse) in [(F_UNIFIED, 1u8, unified as fn(&[u8]) -> Option<(Level, Charging)>), (F_STATUS, 0, status), (F_VOLTAGE, 0, voltage), (F_ADC, 0, adc)] {
            let f = pp.feature_index(idx, feat, deadline)?;
            if f == 0 {
                continue;
            }
            if let Some(p) = pp.call(idx, f, func, &[], deadline)? {
                found = parse(&p);
                if found.is_some() {
                    break;
                }
            }
        }
        if let Some((l, c)) = found {
            d.out = got(l, c, now);
            let f = pp.feature_index(idx, F_INFO, deadline)?;
            if f != 0 {
                if let Some(p) = pp.call(idx, f, 0, &[], deadline)? {
                    if p.len() >= 5 && p[1..5].iter().any(|&b| b != 0) {
                        d.unit = Some(format!("unit:{:02X}{:02X}{:02X}{:02X}", p[1], p[2], p[3], p[4]));
                    }
                }
            }
        }
        Ok(())
    })();
    if let Err(e) = r {
        if matches!(d.out, Outcome::Read(r) if r.level == Level::Unknown) {
            d.out = failed(&e);
        }
    }
    d
}

fn read10(pp: &mut Pp, idx: u8, deadline: Instant, now: u64) -> Outcome {
    if let Ok(Rep::Ok(p)) = pp.request(idx, 0x81, 0x0D, &[], true, ms(500), deadline) {
        if p.len() >= 3 && (1..=100).contains(&p[0]) {
            return got(pct(i64::from(p[0])).unwrap_or(Level::Unknown), reg_charging(p[2]), now);
        }
    }
    match pp.request(idx, 0x81, 0x07, &[], true, ms(500), deadline) {
        Ok(Rep::Ok(p)) if p.len() >= 2 && (1..=7).contains(&p[0]) => got(steps(i64::from(p[0]), 7).unwrap_or(Level::Unknown), reg_charging(p[1]), now),
        Ok(_) => no_level(Charging::Unknown, now),
        Err(e) => failed(&e),
    }
}

/// Reads one unit: a device on its cable or Bluetooth (index FF), one slot of a receiver, or — `slot` None on a
/// receiver — its slots probed (Answer::slots: the ones with a device) and the first one read.
pub fn read(ch: &mut Chans, m: &Model, slot: Option<u8>, deadline: Instant, now: u64) -> Answer {
    let main_short = is_short(ch.main.ident());
    let (short, long): (Option<&mut dyn HidTransport>, Option<&mut dyn HidTransport>) = if main_short { (Some(&mut *ch.main), ch.long.as_mut().map(|t| &mut **t as &mut dyn HidTransport)) } else { (None, Some(&mut *ch.main)) };
    let mut pp = Pp::new(short, long);
    let receiver = !m.slots.is_empty();
    let to_answer = |d: Dev, slots: Option<Vec<u8>>| Answer { out: d.out, slots, name: d.name, kind: d.kind, unit: d.unit };
    if !receiver {
        return to_answer(read_index(&mut pp, SELF, false, deadline, now), None);
    }
    if let Some(s) = slot {
        if !m.slots.contains(&s) {
            return Outcome::Failed.into();
        }
        return to_answer(read_index(&mut pp, s, true, deadline, now), None);
    }
    if m.slots.len() == 1 {
        return to_answer(read_index(&mut pp, m.slots[0], true, deadline, now), Some(m.slots.to_vec()));
    }
    // (Each slot pinged once: a device answers (2.0) or says it speaks 1.0; an empty slot errs.)
    let mut present = Vec::new();
    let mut answered = false;
    for &s in m.slots {
        match pp.ping(s, ms(300), deadline) {
            Ok(Rep::Ok(_)) | Ok(Rep::Err(0x01)) => {
                answered = true;
                present.push(s);
            }
            Ok(Rep::Err(_)) => answered = true,
            Err(TErr::Gone) => return Outcome::Failed.into(),
            Err(_) => {}
        }
        if Instant::now() >= deadline {
            break;
        }
    }
    match present.first() {
        Some(&s) => to_answer(read_index(&mut pp, s, true, deadline, now), Some(present)),
        None if answered => Answer { out: unlinked(now), slots: Some(Vec::new()), name: None, kind: None, unit: None },
        None => Outcome::NoAnswer.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;
    use crate::transport::fake::FakeHid;

    fn short_of(pid: u16) -> FakeHid {
        let m = all_models().find(|m| m.pid == pid && m.role == Role::Main && m.driver == "mk-logitech").unwrap();
        fake(m)
    }
    /// A HID++ reply frame (short when `long` is false).
    fn rep(long: bool, idx: u8, b2: u8, b3: u8, params: &[u8]) -> Vec<u8> {
        let mut r = vec![0u8; if long { 20 } else { 7 }];
        r[0] = if long { 0x11 } else { 0x10 };
        r[1] = idx;
        r[2] = b2;
        r[3] = b3;
        for (i, &p) in params.iter().enumerate() {
            r[4 + i] = p;
        }
        r
    }
    fn err10(idx: u8, b2: u8, b3: u8, code: u8) -> Vec<u8> {
        vec![0x10, idx, 0x8F, b2, b3, code, 0]
    }
    const PING: u8 = 0x1D;

    #[test]
    fn the_allow_rule_for_hidpp() {
        let id = HidIdent { vid: 0x046D, pid: 0xC52B, usage_page: 0xFF00, usage: 1, interface: 2 };
        let s = HidppSession::new();
        let ok = |s: &HidppSession, b: &[u8]| permit_hidpp(s, &id, b).is_some();
        assert!(ok(&s, &[0x10, 0x01, 0x00, 0x1D, 0x00, 0x00, 0x5A]), "ping");
        assert!(ok(&s, &[0x10, 0xFF, 0x00, 0x0D, 0x10, 0x04, 0x00]), "getFeature 1004");
        assert!(ok(&s, &[0x10, 0x02, 0x81, 0x0D, 0x00, 0x00, 0x00]), "GET_REGISTER 0D");
        // (Not: another feature id, a set function, a register write, another register, a device index 0 or 7, a
        //  stray byte, a wrong length, the right bytes to another vendor's product or page.)
        assert!(!ok(&s, &[0x10, 0x01, 0x00, 0x0D, 0x22, 0x01, 0x00]), "getFeature of ADJUSTABLE_DPI (2201)");
        assert!(!ok(&s, &[0x10, 0x01, 0x00, 0x2D, 0x10, 0x04, 0x00]), "root fn 2");
        assert!(!ok(&s, &[0x10, 0x01, 0x80, 0x0D, 0x00, 0x00, 0x00]), "SET_REGISTER");
        assert!(!ok(&s, &[0x10, 0x01, 0x81, 0x02, 0x00, 0x00, 0x00]), "register 02 (notifications)");
        assert!(!ok(&s, &[0x10, 0x01, 0x83, 0xB5, 0x20, 0x00, 0x00]), "the pairing register: not asked");
        assert!(!ok(&s, &[0x10, 0x00, 0x00, 0x1D, 0x00, 0x00, 0x5A]));
        assert!(!ok(&s, &[0x10, 0x07, 0x00, 0x1D, 0x00, 0x00, 0x5A]));
        assert!(!ok(&s, &[0x10, 0x01, 0x00, 0x1D, 0x00, 0x00, 0x5A, 0x00]), "8 bytes");
        assert!(!ok(&s, &[0x10, 0x01, 0x00, 0x1D, 0x00, 0x01, 0x5A]));
        assert!(!ok(&s, &[0x11, 0x01, 0x81, 0x0D, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), "registers: short only");
        assert!(!ok(&s, &[0x10, 0x01, 0x00, 0x1E, 0x00, 0x00, 0x5A]), "another software id");
        assert!(permit_hidpp(&s, &HidIdent { vid: 0x046D, pid: 0xC077, usage_page: 0xFF00, usage: 1, interface: 2 }, &[0x10, 0x01, 0x00, 0x1D, 0x00, 0x00, 0x5A]).is_none(), "an unlisted product");
        assert!(permit_hidpp(&s, &HidIdent { vid: 0x046D, pid: 0xC52B, usage_page: 0x0001, usage: 2, interface: 0 }, &[0x10, 0x01, 0x00, 0x1D, 0x00, 0x00, 0x5A]).is_none(), "the mouse collection");
        // (A feature index works only once the device named it for that feature on this session, and only for that
        //  feature's own read functions.)
        assert!(!ok(&s, &[0x10, 0x01, 0x05, 0x1D, 0x00, 0x00, 0x00]), "index 05 not learned");
        let mut s = HidppSession::new();
        let req = permit_hidpp(&s, &id, &[0x10, 0x01, 0x00, 0x0D, 0x10, 0x04, 0x00]).unwrap();
        assert_eq!(s.learn(&req, &rep(false, 1, 0x00, 0x0D, &[0x05])), Some(5));
        assert!(ok(&s, &[0x10, 0x01, 0x05, 0x1D, 0x00, 0x00, 0x00]), "1004 get_status at the named index");
        assert!(!ok(&s, &[0x10, 0x01, 0x05, 0x0D, 0x00, 0x00, 0x00]), "1004 fn 0 is not in the list");
        assert!(!ok(&s, &[0x10, 0x01, 0x05, 0x2D, 0x00, 0x00, 0x00]), "1004 fn 2 (show_battery_status) is not a read");
        assert!(!ok(&s, &[0x10, 0x01, 0x05, 0x1D, 0x01, 0x00, 0x00]), "a parameter");
        assert!(!ok(&s, &[0x10, 0x02, 0x05, 0x1D, 0x00, 0x00, 0x00]), "learned for device 1, not 2");
        assert!(!ok(&s, &[0x10, 0x01, 0x06, 0x1D, 0x00, 0x00, 0x00]));
        // (A reply that does not echo the request teaches nothing; nor does index 0 or one out of bounds.)
        let mut s2 = HidppSession::new();
        assert_eq!(s2.learn(&req, &rep(false, 2, 0x00, 0x0D, &[0x05])), None);
        assert_eq!(s2.learn(&req, &rep(false, 1, 0x00, 0x0D, &[0x00])), None);
        assert_eq!(s2.learn(&req, &rep(false, 1, 0x00, 0x0D, &[0x8F])), None);
        let ping = permit_hidpp(&s2, &id, &[0x10, 0x01, 0x00, 0x1D, 0x00, 0x00, 0x5A]).unwrap();
        assert_eq!(s2.learn(&ping, &rep(false, 1, 0x00, 0x1D, &[0x05])), None, "only a getFeature teaches");
        // (getDeviceName: the character index 0–63 only.)
        let mut s3 = HidppSession::new();
        let nreq = permit_hidpp(&s3, &id, &[0x10, 0x01, 0x00, 0x0D, 0x00, 0x05, 0x00]).unwrap();
        s3.learn(&nreq, &rep(false, 1, 0x00, 0x0D, &[0x03]));
        assert!(ok(&s3, &[0x10, 0x01, 0x03, 0x1D, 0x3F, 0x00, 0x00]));
        assert!(!ok(&s3, &[0x10, 0x01, 0x03, 0x1D, 0x40, 0x00, 0x00]));
        assert!(ok(&s3, &[0x10, 0x01, 0x03, 0x2D, 0x00, 0x00, 0x00]), "getDeviceType");
        assert!(!ok(&s3, &[0x10, 0x01, 0x03, 0x3D, 0x00, 0x00, 0x00]), "DEVICE_NAME fn 3 (setDeviceName)");
        // (A small fuzz: random frames with the learned session — only the shapes above pass.)
        let mut seed = 0x2545_F491u32;
        let mut passed = 0;
        for _ in 0..20000 {
            let mut b = [0x10u8, 0x01, 0, 0, 0, 0, 0];
            for x in b.iter_mut().skip(2) {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                *x = [0x00u8, 0x01, 0x03, 0x05, 0x0D, 0x1D, 0x2D, 0x3F, 0x40, 0x5A, 0x81, 0xFF][(seed % 12) as usize];
            }
            if ok(&s3, &b) {
                passed += 1;
                assert!(b[2] == 0x00 || b[2] == 0x81 || b[2] == 0x03, "{:02X?}", b);
            }
        }
        assert!(passed < 20000);
    }

    #[test]
    fn a_device_on_its_cable_hidpp20() {
        let mut f = short_of(0xC08B);
        let sw = hidpp::SW;
        // ping → 4.2; DEVICE_NAME index 0 (none); UNIFIED_BATTERY at 6 → 77 %, discharging; DEVICE_INFORMATION at 2.
        f.replies.extend([
            vec![rep(false, 0xFF, 0x00, PING, &[0x04, 0x02, 0x5A])],
            vec![rep(false, 0xFF, 0x00, sw, &[0x00])],
            vec![rep(false, 0xFF, 0x00, sw, &[0x06])],
            vec![rep(false, 0xFF, 0x06, 0x10 | sw, &[77, 0x04, 0x00])],
            vec![rep(false, 0xFF, 0x00, sw, &[0x02])],
            vec![rep(true, 0xFF, 0x02, sw, &[0x01, 0xAB, 0xCD, 0x12, 0x34])],
        ]);
        let m = model("mk-logitech", 0xC08B);
        let a = crate::mice::read(&mut Chans::one(&mut f), m, None, true, soon(), 7);
        assert_eq!(a.out, at(pctl(77), Charging::No));
        assert_eq!(a.unit.as_deref(), Some("unit:ABCD1234"));
        assert_eq!(f.sent[0], vec![0x10, 0xFF, 0x00, 0x1D, 0x00, 0x00, 0x5A]);
        assert_eq!(f.sent[3], vec![0x10, 0xFF, 0x06, 0x1D, 0x00, 0x00, 0x00], "get_status at the index the device named");
        assert!(f.sent.iter().all(|b| b.len() == 7));
    }

    #[test]
    fn level_shapes() {
        assert_eq!(unified(&[0, 8, 3]), Some((Level::Coarse(Coarse::Full), Charging::No)));
        assert_eq!(unified(&[0, 2, 1]), Some((Level::Coarse(Coarse::Low), Charging::Yes)));
        assert_eq!(unified(&[101, 4, 0]), Some((Level::Coarse(Coarse::High), Charging::No)), "out of range: the flags");
        assert_eq!(unified(&[50, 4]), None, "short");
        assert_eq!(status(&[0, 0, 3]), Some((pctl(100), Charging::No)));
        assert_eq!(status(&[150, 0, 1]), Some((Level::Unknown, Charging::Yes)));
        assert_eq!(voltage(&[0x0F, 0xA0, 0x80]), Some((from_millivolts(4000), Charging::Yes)));
        assert_eq!(voltage(&[0x00, 0x00, 0x00]), Some((Level::Unknown, Charging::No)));
    }

    #[test]
    fn a_receiver_probes_its_slots_and_reads_each_alone() {
        let m = model("mk-logitech", 0xC52B);
        let mut f = short_of(0xC52B);
        let sw = hidpp::SW;
        // (Slot 1: a HID++ 1.0 device; 2: empty; 3: 2.0; 4–6: empty. Then slot 1 read: register 0D → 60 %.)
        f.replies.extend([
            vec![err10(1, 0x00, PING, 0x01)],
            vec![err10(2, 0x00, PING, 0x09)],
            vec![rep(false, 3, 0x00, PING, &[0x04, 0x05, 0x5A])],
            vec![err10(4, 0x00, PING, 0x09)],
            vec![err10(5, 0x00, PING, 0x09)],
            vec![err10(6, 0x00, PING, 0x09)],
            vec![err10(1, 0x00, PING, 0x01)],
            vec![rep(false, 1, 0x81, 0x0D, &[60, 0, 0x22])],
        ]);
        let a = crate::mice::read(&mut Chans::one(&mut f), m, None, true, soon(), 7);
        assert_eq!(a.slots, Some(vec![1, 3]));
        assert_eq!(a.out, at(pctl(60), Charging::Yes));
        // (Slot 3 alone: register-free 2.0 path; BATTERY_STATUS only.)
        let mut f = short_of(0xC52B);
        f.replies.extend([
            vec![rep(false, 3, 0x00, PING, &[0x04, 0x05, 0x5A])],
            vec![rep(false, 3, 0x00, sw, &[0x00])],
            vec![rep(false, 3, 0x00, sw, &[0x00])],
            vec![rep(false, 3, 0x00, sw, &[0x04])],
            vec![rep(false, 3, 0x04, sw, &[40, 0, 0])],
            vec![rep(false, 3, 0x00, sw, &[0x00])],
        ]);
        let a = crate::mice::read(&mut Chans::one(&mut f), m, Some(3), true, soon(), 7);
        assert_eq!(a.out, at(pctl(40), Charging::No));
        assert!(f.sent.iter().all(|b| b[1] == 3), "only slot 3 asked");
        // (A slot whose device sleeps; a slot the model has not; HID++ 1.0's level register as 1–7 steps.)
        let mut f = short_of(0xC52B);
        f.replies.push_back(vec![err10(2, 0x00, PING, 0x09)]);
        assert_eq!(crate::mice::read(&mut Chans::one(&mut f), m, Some(2), true, soon(), 7).out, dozing(7));
        assert_eq!(crate::mice::read(&mut Chans::one(&mut short_of(0xC52B)), m, Some(7), true, soon(), 7).out, Outcome::Failed);
        let mut f = short_of(0xC52B);
        f.replies.extend([vec![err10(1, 0x00, PING, 0x01)], vec![err10(1, 0x81, 0x0D, 0x02)], vec![rep(false, 1, 0x81, 0x07, &[5, 0x00])]]);
        assert_eq!(crate::mice::read(&mut Chans::one(&mut f), m, Some(1), true, soon(), 7).out, at(steps(5, 7).unwrap(), Charging::No));
        // (Nothing paired: every slot errs → no device linked.)
        let mut f = short_of(0xC52B);
        f.replies.extend((1..=6).map(|i| vec![err10(i, 0x00, PING, 0x09)]));
        let a = crate::mice::read(&mut Chans::one(&mut f), m, None, true, soon(), 7);
        assert_eq!((a.out, a.slots), (unlinked(7), Some(vec![])));
        // (Replies to another software id or another index are not taken.)
        let mut f = short_of(0xC52B);
        f.replies.push_back(vec![rep(false, 1, 0x00, 0x1E, &[4, 2, 0x5A]), rep(false, 2, 0x00, PING, &[4, 2, 0x5A])]);
        assert_eq!(crate::mice::read(&mut Chans::one(&mut f), m, Some(1), true, soon(), 7).out, Outcome::NoAnswer);
    }
}
