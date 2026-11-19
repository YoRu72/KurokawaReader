// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): Bluetooth LE advertisements heard, for AirPods' broadcast (piece 6).
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/airpods.cpp (EnsureWatcher, OnReceived, the received map) at commit
// 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later.
// Windows' only interface for listening to advertisements is BluetoothLEAdvertisementWatcher, a WinRT class: behind the
// `wgi` feature (the `windows` crate's projection — the original declared its vtables by hand, which our std-only rule
// would allow, but a WinRT event handler would then be a hand-made COM object: not worth the risk here). Without the
// feature `available()` is false and a paired AirPods card says «not available in this build». Passive scanning (the
// watcher's default): nothing is sent, no scan request, no connection. Started the first time a paired Apple audio
// device is seen, on its own thread that owns it (restarted only when asked, after the radio stopped it — no timer);
// messages kept by address for ten minutes at most, Apple's (004C) proximity messages only.
// UNVERIFIED here: needs the `windows` crate, compiled only by CI («Device battery — WGI compile try»); off by default.
// Copyright (C) 2026 Kurokawa contributors.
use crate::airpods::Advert;

/// Whether this build can listen to advertisements at all.
pub fn available() -> bool {
    cfg!(feature = "wgi")
}

#[cfg(feature = "wgi")]
mod imp {
    use crate::airpods::{parse, Advert};
    use std::collections::BTreeMap;
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Mutex, OnceLock};

    fn heard() -> &'static Mutex<BTreeMap<u64, Advert>> {
        static H: OnceLock<Mutex<BTreeMap<u64, Advert>>> = OnceLock::new();
        H.get_or_init(|| Mutex::new(BTreeMap::new()))
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
    }

    fn on_received(args: &windows::Devices::Bluetooth::Advertisement::BluetoothLEAdvertisementReceivedEventArgs) -> windows::core::Result<()> {
        use windows::Storage::Streams::DataReader;
        let rssi = args.RawSignalStrengthInDBm()?;
        let addr = args.BluetoothAddress()?;
        let view = args.Advertisement()?.GetManufacturerDataByCompanyId(0x004C)?;
        for i in 0..view.Size()?.min(8) {
            let data = view.GetAt(i)?.Data()?;
            let len = data.Length()? as usize;
            if len == 0 || len > 64 {
                continue;
            }
            let mut buf = vec![0u8; len];
            DataReader::FromBuffer(&data)?.ReadBytes(&mut buf)?;
            if let Some(a) = parse(&buf, rssi, now_ms()) {
                if let Ok(mut g) = heard().lock() {
                    g.insert(addr, a);
                    let t = a.at;
                    g.retain(|_, x| t.saturating_sub(x.at) <= 10 * 60_000);
                    while g.len() > 256 {
                        let Some(k) = g.iter().min_by_key(|(_, x)| x.at).map(|(k, _)| *k) else { break };
                        g.remove(&k);
                    }
                }
            }
        }
        Ok(())
    }

    fn watcher_thread() -> Option<Sender<()>> {
        let (tx, rx) = channel::<()>();
        std::thread::Builder::new()
            .name("kt-battery-ble".into())
            .spawn(move || {
                use windows::Devices::Bluetooth::Advertisement::{BluetoothLEAdvertisementWatcher, BluetoothLEAdvertisementWatcherStatus};
                use windows::Foundation::TypedEventHandler;
                let Ok(w) = BluetoothLEAdvertisementWatcher::new() else { return };
                let handler = TypedEventHandler::new(move |_, args| {
                    if let Some(a) = (*args).as_ref() {
                        let _ = on_received(a);
                    }
                    Ok(())
                });
                if w.Received(&handler).is_err() || w.Start().is_err() {
                    return;
                }
                // (Asked again: started once more if the radio stopped it.)
                while rx.recv().is_ok() {
                    if let Ok(st) = w.Status() {
                        if st == BluetoothLEAdvertisementWatcherStatus::Stopped || st == BluetoothLEAdvertisementWatcherStatus::Aborted {
                            let _ = w.Start();
                        }
                    }
                }
            })
            .ok()?;
        Some(tx)
    }

    pub fn ensure() {
        static W: OnceLock<Mutex<Option<Sender<()>>>> = OnceLock::new();
        let m = W.get_or_init(|| Mutex::new(None));
        if let Ok(mut g) = m.lock() {
            if g.as_ref().map_or(true, |t| t.send(()).is_err()) {
                *g = watcher_thread();
            }
        }
    }

    pub fn adverts() -> Vec<Advert> {
        heard().lock().map(|g| g.values().copied().collect()).unwrap_or_default()
    }
}

/// Starts listening (once), or asks the listener to start again if Windows stopped it.
pub fn ensure() {
    #[cfg(feature = "wgi")]
    imp::ensure();
}

/// The messages heard in the last ten minutes.
pub fn adverts() -> Vec<Advert> {
    #[cfg(feature = "wgi")]
    return imp::adverts();
    #[cfg(not(feature = "wgi"))]
    Vec::new()
}
