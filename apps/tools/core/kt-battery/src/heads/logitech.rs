// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Logitech G headsets over HID++ 2.0 (VID 046D).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/logitech.cpp (ReadBattery20's ADC_MEASUREMENT branch, HeadsetPercent's product list) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later. Its references:
// Logitech's HID++ 2.0 drafts, Solaar, Sapd/HeadsetControl.
// The headset is the device itself (index FF): ping, root getFeature, DEVICE_NAME, then the battery features of
// mice/logitech.rs — and for G headsets ADC_MEASUREMENT (1F20) getADCMeasurement: [mV hi][mV lo][flags, 03 charging]
// (allow.rs's HID++ rule: function 0 of 1F20 only, to the index the headset named).
// Changed here: the products by id — those the original's voltage curves name (G533, G535, G633 / G635, G933 / G935,
// G733, PRO X Wireless); it reached them by asking every 046D product; the headset's own product string names the card;
// the voltage as a coarse word (the original: HeadsetControl's per-model curves to the per cent).
// Not ported: logitech_g435_0adf.cpp (G435 on its 0ADF dongle) — its battery read runs inside the dongle's OTA (firmware
// update) session and switches the dongle's routing with REMOTE_SET_MODE before asking: neither is a status read.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::mice::*;
use crate::model::Kind;

pub static PIDS: &[u16] = &[0x0A66, 0x0AC4, 0x0A5C, 0x0A89, 0x0A5B, 0x0A87, 0x0AB5, 0x0AFE, 0x0AA7, 0x0AAA, 0x0ABA, 0x0AFB];
const G: Model = Model::new("hs-logitech", 0x046D, 0, "Logitech G headset", Kind::Headset, Via::Direct).product_name();
pub static SHORT: [Model; 12] = many(G.page(0xFF00).usage(0x0001).output(Len::Eq(7)), [0x0A66, 0x0AC4, 0x0A5C, 0x0A89, 0x0A5B, 0x0A87, 0x0AB5, 0x0AFE, 0x0AA7, 0x0AAA, 0x0ABA, 0x0AFB]);
pub static LONG: [Model; 12] = many(G.page(0xFF00).usage(0x0002).output(Len::Eq(20)).role(Role::Long), [0x0A66, 0x0AC4, 0x0A5C, 0x0A89, 0x0A5B, 0x0A87, 0x0AB5, 0x0AFE, 0x0AA7, 0x0AAA, 0x0ABA, 0x0AFB]);
pub static FF43: [Model; 12] = many(G.page(0xFF43).usage(0x0202).output(Len::Eq(20)), [0x0A66, 0x0AC4, 0x0A5C, 0x0A89, 0x0A5B, 0x0A87, 0x0AB5, 0x0AFE, 0x0AA7, 0x0AAA, 0x0ABA, 0x0AFB]);

#[cfg(test)]
mod tests {
    use crate::mice::testkit::*;
    use crate::mice::logitech::adc;
    use super::*;
    use crate::allow::{hidpp, permit_hidpp, HidIdent, HidppSession};
    use crate::model::{Charging, Level};

    #[test]
    fn adc_measurement_and_the_hidpp_rule() {
        assert_eq!(adc(&[0x0F, 0xD2, 0x03]), Some((from_millivolts(4050), Charging::Yes)));
        assert_eq!(adc(&[0x0E, 0x74, 0x01]), Some((from_millivolts(3700), Charging::No)));
        assert_eq!(adc(&[0x00, 0x00, 0x01]).map(|x| x.0), Some(Level::Unknown));
        assert_eq!(adc(&[0x0F, 0xD2]), None, "short");
        assert!(hidpp::FEATURES.iter().any(|f| f.0 == 0x1F20 && f.1 == [0x00]));
        // (getFeature 1F20 to a G headset's long collection: allowed; to another 046D product: refused.)
        let s = HidppSession::new();
        let id = HidIdent { vid: 0x046D, pid: 0x0A66, usage_page: 0xFF43, usage: 0x0202, interface: 3 };
        let mut req = [0u8; 20];
        req[0] = 0x11;
        req[1] = 0xFF;
        req[3] = 0x0D;
        req[4] = 0x1F;
        req[5] = 0x20;
        assert!(permit_hidpp(&s, &id, &req).is_some());
        assert!(permit_hidpp(&s, &HidIdent { pid: 0x0A01, ..id.clone() }, &req).is_none(), "an unlisted product");
        let m = model("hs-logitech", 0x0A66);
        assert_eq!(m.kind, Kind::Headset);
        assert!(sends_output("hs-logitech"));
    }
}
