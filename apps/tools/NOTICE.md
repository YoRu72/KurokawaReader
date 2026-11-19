# Kurokawa Tools — licence and notices

## Licence

From version 0.21, **Kurokawa Tools is free software under the GNU General Public License, version 3 or (at your
option) any later version** (GPL-3.0-or-later). The full text is in [LICENSE](LICENSE). Kurokawa Tools is distributed
in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE. See the licence for details.

Versions before 0.21 were released under the MIT licence, and stay so.

What stays MIT:

- **Kurokawa Reader** (`apps/reader`) — its own licence, unchanged.
- **Shared code** under `shared/` (the shells' common Rust crate, the archive engine, the name tables and the rest),
  which both apps build from. It is our own work; MIT code may be used inside a GPL program.

The device battery code lives only under `apps/tools` (the crate `apps/tools/core/kt-battery` and the Tauri shell's
`battery.rs`), never under `shared/`; the Reader builds nothing from it (checked by `apps/tools/tests/desktop-files.cjs`).

## Device battery — derived from Wireless Device Battery Monitor

The «Device battery» feature (the batteries of wireless mice, keyboards, headsets, earbuds and controllers) is derived
from **Wireless Device Battery Monitor** by **krisgfx9** and its contributors, licensed GPL-3.0-or-later:

- Repository: <https://github.com/krisgfx9/Wireless-Device-Battery-Monitor>
- Ported from commit `285d64254216857e94ca3ea3e1deb536f863e282` (18 Nov 2026, version 1.0.8 and later)
- Brought up to its **v1.1.0** (commit `7cc44f2b2c63341e2b478463c7467759837a74a9`, 19 Nov 2026), with which the
  upstream renamed itself **BatteryHub** (formerly «Wireless Battery»), same author, same repository and licence.
  What of v1.1.0 was taken is in the section «D1» below; its auto-update is not ported (Tools updates only through its
  own releases).

Each ported file of `apps/tools/core/kt-battery` names the original files it comes from in its header.

### What was taken (piece 1 of the port)

| Original (C++) | Here (Rust) |
|---|---|
| `src/devices.h` | `model.rs` |
| `src/hid.h`, `src/hid.cpp` (HidDev, EnumHid, helpers) | `transport.rs`, `win/hid.rs`, `hidvalue.rs` |
| `src/drivers/generic.cpp` (HID battery usages, Bluetooth battery property, device kinds) | `hidvalue.rs`, `bluetooth.rs`, `win/bt.rs`, `kind.rs` |
| `src/drivers/xinput.cpp` (Windows.Gaming.Input, XInput) | `xbox.rs`, `win/xinput.rs`, `win/wgi.rs` |
| `src/devices.cpp`, `src/drivers/drivers.h` (the readers' order, claims) | `registry.rs`, `win/mod.rs` |
| `src/brands.cpp` (brand by vendor id and name — text only) | `kind.rs` |
| `lang/*.txt` (the phrase list) | a checklist for Tools' own strings (`src/i18n`); Arabic written anew |

The vendor drivers came in pieces 4 to 6 (below); the support request is not ported (the last table says why).

### What was taken (W1: the taskbar, as the original shows it — v1.0.8, then its v1.1.0)

| Original (C++) | Here |
|---|---|
| `src/main.cpp` (RenderIcon / IconFor: the level drawn in a tray icon; one icon per device; KindOrder, OrderedEntries, the order moved left / right; «Hide last known / asleep devices»; v1.1.0: «Show disconnected devices», «Check battery every» from 30 s, «fully charged») | `taskbar.rs`; the shell's tray (`desktop-tauri/src-tauri/src/desktop.rs`, `battery.rs`) |
| `src/widget.cpp`, `.h` (the strip beside the notification area, its «icons above percentages» and «background behind taskbar text», made again when Explorer restarts; v1.1.0: the green check of «fully charged», Windows 10's news button kept clear), `src/labels.cpp` (captions when two devices share a drawing) | `taskbar.rs` (drawing, layout, place), `win/strip.rs` (the window) |
| v1.1.0 `src/alert_rules.h` (per-device alert levels 5–40 %, off) | `notice.rs` (CHOICES) |
| v1.1.0 `src/device_aliases.h`, `src/rename_dialog.cpp` (a device's own name, 1–64 characters) | the page's rename (`src/views/battery.ts`) and `battery.rs`'s settings check |

Changed: every picture is our own drawing made in code (no icon font, no bundled art); a level in steps is never drawn
as a number; calm colours (red low, blue charging, green full, the taskbar's own otherwise; no brand colours); captions
are numbers; the strip is off by default, on the main taskbar only, checked every 2 s on its own thread, and gives way to
the tray icons whenever it cannot be shown; quiet hours, a sound switch, pictures, joins and the order are Tools' own.
Drivers that send undocumented commands are not ported until they are understood.

### What was taken (piece 2: the background)

| Original (C++) | Here |
|---|---|
| `src/main.cpp` (UpdateTrayIcon: the low-battery balloon and its re-arming) | `notice.rs` |
| `src/main.cpp` (the tray's tooltip and menu) | `summary.rs`; the shell's one tray icon (`desktop-tauri/src-tauri/src/desktop.rs`) |
| `src/main.cpp` (SetAutostart / AutostartEnabled), `src/linux/main_linux.cpp` (ApplyAutostart) | `autostart.rs`, `win/autostart.rs` |

Changed: the low mark is the user's, per device (5–40 % in steps of 5 since W1, or off; re-armed at mark + 5 % or by charging), coarse
devices are told at «Low», and nothing is told from an old reading, an asleep device or one not connected (the original
warned from the value it kept); an optional «fully charged» notice; the start with the system has its own Run value
and starts the app hidden in the tray; the autostart file's Exec line is quoted by the Desktop Entry rules.

### Piece 3: connecting Bluetooth devices — written for Tools

Wireless Device Battery Monitor has no connecting, so nothing of it was taken for this piece: `connect.rs` (the list,
the actions and the scan, with their limits and cancels) and `win/btconn.rs` (the Windows side) are new, written from
the Windows SDK's documented calls and headers (`bluetoothapis.h`, `bthioctl.h`, `ks.h`, `ksmedia.h`, `devguid.h`),
declared by hand in `win/ffi.rs`. The device pictures of the «Connect a device» panel (`src/views/btconnect.ts`) are our
own drawings, one per kind and three controller silhouettes; no maker's logo, photo or artwork is used, and brands are
shown as text only.

How it behaves: the paired list is read from Windows without an inquiry; sound devices are connected and disconnected
with Windows' own audio reconnect (`KSPROPERTY_ONESHOT_RECONNECT` / `_DISCONNECT`), other classic devices are only let
go of (`IOCTL_BTH_DISCONNECT_DEVICE`, the pairing kept) — no service is ever turned off, installed or removed;
pairing goes through Windows' own window (`BluetoothAuthenticateDeviceEx` with no callback of ours: Tools never makes
up, stores or enters a code); Bluetooth LE devices and anything else are sent to Windows' Bluetooth settings. Every
call runs on its own thread with a time limit; a scan is bounded (20 s by default) and runs in short rounds.

### Piece 4: game controllers

Every controller driver of the original is ported, each into its own file of `core/kt-battery/src/pads/`; every one
is marked «ported, untested» (no real hardware here). Listening readers are on by default; the four families whose
reading sends a request are off until the user turns them on («Controllers» on the page, or a pad's own menu).

| Original (C++) | Here | How it reads; what changed |
|---|---|---|
| `src/drivers/playstation.cpp` | `pads/playstation.rs` | DualShock 4, DualSense, DualSense Edge, the DS4 adaptor: listens to the input report it sends anyway. The level stays the pad's 0–10 steps (was level × 10 + 5 %); a fault state is no level. **Not ported:** the Bluetooth feature read 05 — it switches the pad's report mode; over Bluetooth the pad is read once a game or Steam has switched it, else «needs a query we do not send». |
| `src/drivers/switch_pro.cpp` | `pads/nintendo.rs` | Switch Pro Controller (and pads in Switch mode); **added** Joy-Con (L) and (R), and reports 21 / 31 beside 30 (same byte, from the public reverse-engineering notes). Listens only, as the original; 0–4 steps (was 25 × level %). |
| `src/drivers/steam_controller.cpp` | `pads/steam.rs` | Steam Controller 2015 (receiver) and 2026 (cable, Bluetooth, puck, internal receiver): listens; real percentages; an empty slot says «no controller linked»; the listening ends at the deadline (was up to 5 s). Steam Deck: not in the original. |
| `src/drivers/eightbitdo.cpp` (PollDInputGamepad) | `pads/eightbitdo.rs` | D-input / Bluetooth pads (Ultimate 2, Ultimate 3-mode, Ultimate 2C, Ultimate 2.4G, Ultimate Bluetooth, Pro 2, Pro 3, SN30 Pro, SF30 Pro): listens; real percentages. **Not ported:** the feature read 06 for Pro 2 / Pro 3 / SN30 Pro / SF30 Pro — it turns on another report format; their report 04 is read when something else turned it on. |
| `src/drivers/eightbitdo.cpp` (PollVendorCollection) | `pads/eightbitdo.rs` | Ultimate 2 Wireless receiver (310B, 6013) and cable (6012), vendor collection FF7A: three status requests, sealed in `allow.rs`. Sent to those three products only (the original asked every 8BitDo product with such a collection); no old level kept as current (the original kept the last one for a docked pad, in a global). |
| `src/drivers/gamesir.cpp` (PollGameSir) | `pads/gamesir.rs` | Nova / Nova 2 Lite / Nova Lite 2: the «device info» request 01 01, sealed in `allow.rs`; FF is «charging, no level» (was «keep the last value»). |
| `src/drivers/gamesir.cpp` (PollGameSirCyclone) | `pads/gamesir.rs` | Cyclone 2: listens for report 12. **Not ported:** the request 0F 03 — it starts the pad's state stream; without that stream: «needs a query we do not send». |
| `src/drivers/flydigi.cpp` | `pads/flydigi.rs` | Vader 5 Pro: the architecture and info requests, sealed in `allow.rs`; 0–5 steps (was 20 × level %); unknown connection or identity: no reading. |
| `src/drivers/beitong.cpp` | `pads/beitong.rs` | BEITONG KP20 receiver: the «base info» request in its nibble cipher, sealed in `allow.rs`. |
| `src/drivers/xinput.cpp` | `xbox.rs` (piece 1), `pads/mod.rs` (its row in the table) | Xbox pads through Windows.Gaming.Input and XInput — nothing in the original beyond piece 1's port. |

What every controller reader shares (`pads/mod.rs`): matched by vendor, product, usage page and usage — never vendor
alone; length and range checks on every report; a percentage only where the pad sends one, else steps; a malformed
report is no reading; a handle opened to listen is shared (never exclusive, a game keeps its reports); every call
under the deadline; a reply taken only when it answers the request just sent. New merge rules (`identity.rs`): a unit a
controller reader claims is not also read by the generic HID reader; one model seen under two product ids (8BitDo's
Ultimate 2) is one card when the serials agree; a pad's own reader outranks Windows' Bluetooth entry of the same
container. The controller pictures are our own drawings by family (`src/views/btconnect.ts`; piece 4 adds one Joy-Con
and a pad with trackpads); no logo, product photo or artwork, brands as text.

The only bytes Tools can send to any device (`allow.rs`, output reports, report id first):

| Device (vendor:product, usage page / usage) | Bytes | What it asks |
|---|---|---|
| 8BitDo 2DC8:310B, 2DC8:6013, 2DC8:6012 (FF7A / 1) | `81 04 20 01` · `81 04 21 01 00 00 06` · `81 04 00 01` | linked? · battery · which product answers |
| GameSir 3537:1098, 3537:1040, 3537:100F (FF7A) | `00 01 01` | device info |
| Flydigi 37D7:2401 (FFA0 / 1) | `00 5A A5 07 00 00` · `00 5A A5 01 02 00` | architecture · device info |
| BEITONG 20BC:5128 (00FF / 3) | `02 AD` | base info (02 15 before its cipher) |

### Piece 5: mice and keyboards

Every mouse and keyboard driver of the original is ported or named below with the reason it is not, each family in its
own file of `core/kt-battery/src/mice/`; every reader is «ported, untested» (no real hardware here). Readers that only
listen (Rapoo, the Xenta receivers, AULA HERO 68 Air) are on by default; every reader that sends a status request is
off until the user turns its family on («Mice and keyboards» on the page — every family, collapsed, with a field that
finds a brand — or a device's own menu). Products are matched by vendor and product id (and usage page, usage,
interface, report lengths, and the product string where an id is shared) — the original asked whole vendor ids.

| Original (C++) | Here | How it reads; what changed |
|---|---|---|
| `logitech.cpp` | `mice/logitech.rs` | HID++ 1.0 / 2.0 on Unifying, Bolt and Lightspeed receivers (slots 1–6, one card each), USB and Bluetooth LE: ping, root getFeature, then the battery feature's get function (UNIFIED_BATTERY, BATTERY_STATUS, BATTERY_VOLTAGE), DEVICE_NAME, DEVICE_INFORMATION's unit id (a mouse on its receiver and its cable: one card); HID++ 1.0's battery registers. Levels as the device gives them (percent, level words, 1–7 steps; a voltage as a coarse word). G headsets and `logitech_g435_0adf.cpp` are the headset piece's; ADC_MEASUREMENT (headsets only) not asked. |
| `razer.cpp` | `mice/razer.rs` | The 121 mice and 126 keyboards of OpenRazer's lists: class 07 «get battery level» (80) and «get charging status» (84); 0–255 rounded to whole per cent. Barracuda / BlackShark headsets: headset piece. |
| `steelseries.cpp` | `mice/steelseries.rs` | Aerox 3 / 5 / 9 Wireless, Prime Wireless, Rival 3 Wireless (Gen 2), Rival 650, Rival Pro; Aerox as 0–20 steps. The Arctis headsets: headset piece. |
| `steelseries_elite.cpp` | — | Arctis Nova Elite base station (a headset): headset piece. |
| `corsair.cpp` | `mice/corsair.rs`, `mice/kysona.rs` | Bragi GET on the Slipstream receivers 2B00 and 1BDC (targets 09–0B one card each, else the unit itself; battery 0–1000 rounded to per cent, charge state, the paired device's id); Sabre V2 Pro Ultralight on the Compx protocol. Void / HS / Virtuoso headsets (C9 64; Bragi ids 0Axx, 2A02, 2A08), and a headset behind a receiver: headset piece. |
| `glorious.cpp`, `lamzu.cpp`, `wlmouse.cpp`, `arbiter.cpp` | `mice/glorious.rs`, `mice/lamzu.rs`, `mice/wlmouse.rs`, `mice/proto.rs` | The «83» status feature read: Glorious, Hitscan, G-Wolves, WLMouse / YING, LAMZU, Arbiter Studio Akitsu — by id (the original asked every 258A / 373E / 37B0 product). |
| `pulsar.cpp` | `mice/pulsar.rs` | Pulsar's battery feature read; the XS-1 8K dongle on the Compx protocol (`kysona.rs`). |
| `finalmouse.cpp` | `mice/finalmouse.rs` | The four GETs (state of charge, voltage, charging, link). **Not sent:** the lift-off / profile-roster reads and «wake/all» (96) — it wakes the link. |
| `endgame.cpp`, `endgame_we.cpp` | `mice/endgame.rs`, `mice/proto.rs` | OP1w / XM2w 4k: battery (B4) and device info (0E); XM2we: Compx as a feature report. **Not sent:** the 4k's 0F probe after a failed command (it keeps the mouse awake). |
| `vaxee.cpp` | `mice/vaxee.rs` | Battery (0–20 steps) and charging reads. |
| `zowie.cpp` | `mice/zowie.rs` | EC-CW status (A5 03); DW / U2 battery (B4 15) on FF03, reply on FF04; a voltage alone as a coarse word; charging guessed from the voltage's trend is gone. Other EC-CW commands (reboot, unpair) are never sent. |
| `ninjutso.cpp`, `sprime.cpp` | `mice/ninjutso.rs` | Sora V2 and Sprime PM1: read state (15); Ten: online, percent, charging. The Sprime bootloader id is never listed. |
| `darmoshark.cpp` | `mice/darmoshark.rs` | M3 receiver: bond state (03), identify (06). |
| `atk_bitmouse.cpp`, `atk_keyboard.cpp` | `mice/atk.rs`, `mice/kysona.rs` | ATK / VXE mice: level (07), charging (0F); keyboards: status (1A); Dragonfly R1 on Compx. |
| `atk_serial.cpp` | — | ATK N9 headsets over a virtual COM port: headset piece (and only if a specific port can be opened read-only without toggling its control lines). |
| `kysona.cpp` | `mice/kysona.rs` | The Compx 17 protocol (online 03, battery 04, checksum): Kysona, HECATE, Redragon, Hitscan Hyperlight, G-Wolves, Pulsar's dongle, VXE, Corsair Compx — by id. |
| `fantech.cpp`, `dareu.cpp`, `areson.cpp` | `mice/fantech.rs`, `mice/dareu.rs`, `mice/areson.rs`, `mice/proto.rs` | Compx battery as a feature report, the reply on the sibling collection; Redragon (Areson) as 0–10 steps. |
| `rapoo.cpp`, `rapoo_protocol.h` | `mice/rapoo.rs` | Rapoo VT mice: listens to the status the mouse pushes; nothing sent. |
| `keychron.cpp` | `mice/keychron.rs` | Launcher device info / battery, the older receivers' status (51 06), NAPE receivers' slots and battery. |
| `royal_kludge.cpp`, `sonix.cpp`, `semico.cpp`, `cherry.cpp`, `coolermaster.cpp`, `machenike.cpp`, `nzxt.cpp`, `niceboy.cpp` | `mice/<the same name>.rs` | One status read each (table below); the cable and the receiver of one device: one card by the pair rule. |
| `aula.cpp` | `mice/aula.rs` | BY receivers (AULA, MCHOSE keyboards): battery (4A); HERO 68 Air: listens. **Not sent:** HERO 68 Air's acknowledged message session. |
| `mchose.cpp`, `mchose_g3.cpp`, `mchose_modern.cpp` | `mice/mchose.rs` | The inverted status feature report, G3 V2's battery, the new mice' device info. `mchose_headset.cpp`: headset piece. |
| `msi.cpp` | `mice/msi.rs` | Status (0F 20). **Not sent:** 41 80 («remote control», a software control mode). **Not ported:** CLUTCH GM41 — it only pushes a raw byte the original turned into a made-up percentage. |
| `rog.cpp` | `mice/rog.rs` | ROG keyboards and mice: battery (12 01 / 12 07), gauges as steps. **Not ported:** the ROG Omni Receiver (1ACE) and the Omni-channel entries — the original picks the channel by the collection's position in its path. Pelta / Delta II headsets: headset piece. |
| `misc_mice.cpp`, `xenta_protocol.cpp` / `.h`, `ardor_fury_v2_protocol.h` | `mice/misc.rs` | Motospeed X6 (B5 06); Xenta receivers (Delux M900 Pro, Attack Shark, ARDOR Fury V2 as 1–4 steps): listens, two agreeing frames in one window, nothing sent; Delux M800 Pro (status query, its sequence number from the clock); AJAZZ AJ139 V2 (both checksums); Incott G23 V2 / G24 (device info 8F, status 89). **Not ported:** AJAZZ AJ179 and the AJ-series on 3151 (no product ids in the sources — the original asked whole vendors — and the AJ-series' F7 brings the link up); Wraith W1's status trigger (a per-button mapping read swept and repeated as a keep-alive — not a status read: the W1 is listened to, else «needs a query we do not send»); Motospeed's cable (nothing to read). |
| `rongyuan.cpp` | — | **Not ported:** its F7 feature request, sent to about eighty receiver ids of fifteen vendors from a third party's list, is the opcode documented for AJAZZ's receivers as the poll that brings the radio link up (a wake), not a plain status read. |
| `alienware.cpp`, `fractal.cpp` | — | AW920H and Scape are headsets: headset piece. |

What every mouse and keyboard reader shares (`mice/mod.rs`): length and range checks on every reply, a reply taken
only when it answers the request just sent (the queue dropped first, the command echoed, the checksum checked where
the protocol has one); levels as the device gives them (a percentage only when it sends one; Razer's 0–255 and
Corsair's 0–1000 rounded to whole per cent; steps; a voltage alone as a coarse word, never a made-up percentage); no
value kept across rounds; a family switched off is given no device. New merge rules (`mice::merge_pairs`,
`win/mice.rs`): one mouse seen by its cable and its receiver is one card only when the table names them a pair and
exactly one of each is present, or when HID++ gives the same unit id; a receiver's paired devices are a card each.

The mice' and keyboards' requests (`mice/allowed.rs`, each for its reader's listed products only; output reports
unless marked feature):

| Family | Bytes | What it asks |
|---|---|---|
| Logitech (HID++, `allow.rs` `permit_hidpp`) | `10/11 <dev 01–06, FF> 00 0D <feature>` · `… 00 1D 00 00 5A` · `10 <dev> 81 0D/07 00` · `… <index> <fn><0D>` | root getFeature of 1004 / 1000 / 1001 / 0005 / 0003 · ping · HID++ 1.0 battery registers · the get functions of those features, only to the index the device itself named on this handle |
| Razer (feature, 91 bytes) | `00 00 <tid> 00 00 00 02 07 80/84 … <xor>` (tid 1F, 3F, FF, 08, 9F) | battery level · charging |
| SteelSeries | `00 92` · `00 D2` · `00 AA 01` | battery (cable, receiver, Rival) |
| Corsair Bragi (template) | `02 <08–0B> 02 <0F/10/12>` · `00 02 <08–0B> 02 <0F/10/12>` · `00 <08–0B> 02 <0F/10/12>` | GET battery · charge state · paired device's id |
| Compx 17 (Kysona, Corsair, G-Wolves, Redragon, VXE, Hitscan, Pulsar) | `08 03 00 … 4A` · `08 04 00 … 49` (17 bytes) | online · battery (also as a feature report: Endgame Gear XM2we, DAREU, Redragon (Areson), Fantech) |
| «83» (Glorious, Hitscan, G-Wolves, WLMouse, LAMZU, Arbiter) (feature) | `00 00 00 02 02 00 83` | status |
| Finalmouse | `04/01 02 85/A5/A6/A4 00` | voltage · charging · state of charge · link |
| Endgame Gear 4k (feature) | `A1 B4 00` · `A1 0E 00` | battery · device info |
| VAXEE (feature) | `0E A5 0B 01 01` · `0E A5 10 01 01` | battery · charging |
| ZOWIE | `00 A5 03` · `08 B4 15` | EC-CW status · DW / U2 battery |
| Ninjutso, Sprime (feature) | `05 15 00 00 01` · Ten: `06 13/12/11 00 00 01` | state · online / percent / charging |
| Darmoshark (feature) | `51 03` · `51 06` | bond state · identify |
| ATK / VXE | `08 7D 72 02 00 01 07 01` · `08 85 72 02 00 01 0F 01` · `04 01 00 1A` | battery · charging · keyboard status |
| Keychron | 65-byte `00 <01/41/40> 00 81 <01/00> … <check>` frames · `00 B2` · `00 A7 31` · feature `51 06` | device info · battery · receiver slots · older receivers' status |
| Royal Kludge · SONiX · Semico · CHERRY · Cooler Master · MSI · ROG · NZXT · Niceboy | `00 01 01 02 01` · `00 20 01 00 … 21` (33 bytes) · `00 AA 55 CC 33 0E` · `04 72 00 1A 03 00 00 55` · `00 46 81 00` · `00 0F 20` · `00 12 01` / `00 12 07` · `00 4E 02 81 00 B0` · `05 24 FA 48` | battery / status, one each |
| Machenike (feature) | `51 06` | status |
| AULA BY receivers | `13 4A 00 … 5D` · `13 4A 01 … 5E` (20 bytes) | battery |
| MCHOSE | `00 55 30 A5 0B 2E 01 01 01 00 00` · `4D 01 01 00 00 09 00 00 08` · feature `12 F9 FF …` | G3 V2 battery · device info · status (inverted) |
| Motospeed · AJAZZ AJ139 V2 | `B5 06` · `00 55 30 A5 2E 2E` / `00 55 30 A5 0B 2E 01 01` | battery |
| Delux M800 Pro (feature, template) | `0C 01 20 00 <01–7F> 00 × 28` | status, with its sequence number |
| Incott / Wraith (feature) | `09 8F` · `09 89` | device info · status |

### Piece 6: headsets, earbuds and the rest

Every headset, earbud and remaining driver of the original is ported or named below with the reason it is not. The
HID readers are one file per family in `core/kt-battery/src/heads/`, through the same tables, request rules and switches
as the mice (`mice/mod.rs`); AirPods, Galaxy Buds and Phone Link are not HID: `airpods.rs`, `galaxybuds.rs`,
`phonelink.rs` (their Windows sides `win/ble.rs`, `win/spp.rs`, `win/mod.rs`). Every reader is «ported, untested».
Readers that only listen or only read (AirPods' broadcasts, Phone Link's card, the JBL Quantum 350's feature reports)
are on by default; every reader that sends a status request — and Galaxy Buds, whose reading opens a connection — is off
until the user turns its family on («Headsets and earbuds» or «Other» on the page, or a device's own menu). Earbuds
show their parts (left, right, case) on one card; the card's level, the tray and the notices use the lowest part in
use, never the case (`model.rs` `lowest_in_use`).

| Original (C++) | Here | How it reads; what changed |
|---|---|---|
| `razer_headset.cpp` | `heads/razer.rs` | BlackShark V2 HyperSpeed (GET 21 / 2A, sequence and XOR checked), V2 Pro 2020 (the receiver's status feature), V3 X (class 07 GET 80 / 84), V3 / V3 Pro (GET 21 only). Their link drops when asked often: asked at most every five minutes (`Model::gap`), the last reading shown meanwhile with its own time (was a global cache). **Not sent:** V3 / V3 Pro's undocumented three-packet handshake. **Not ported:** BlackShark V2 Pro 2023 (0555) and Barracuda X (0550, 0552) — every query there is wrapped in a «remote mode» switch of the receiver (0552 also an «app mode» switch, 0555 a sacrificial wake frame). |
| `barracuda_pro.cpp` | — | **Not ported:** see the last table. |
| `steelseries.cpp` (Arctis), `steelseries_elite.cpp` | `heads/steelseries.rs` | Arctis 1 / 7 / 9 / Pro Wireless / Nova Pro Wireless, the Nova family, the Arctis GameBuds (as earbuds, its two buds' parts), the Nova Elite base station (its direct reply or its pushed frames, on either collection). 0–4 and 0–8 as steps (were × 25 % / × 12.5 %). |
| `corsair.cpp` (Void / HS, Bragi headsets, headsets behind receivers) | `heads/corsair.rs`, `mice/corsair.rs` | Void family: C9 64 (status 3: no level). Bragi headsets (2A08, 2A02, 0A97, 0A64, 0A62, 0A3E, 0A3D) through the Bragi GET; a headset behind a Slipstream receiver (paired id 0Axx) is a headset's card. |
| `logitech.cpp` (G headsets) | `heads/logitech.rs`, `mice/logitech.rs`, `allow.rs` | HID++ 2.0 with ADC_MEASUREMENT (1F20) getADCMeasurement added to the HID++ rule; the G headsets the original's voltage curves name (G533, G535, G633 / G635, G933 / G935, G733, PRO X Wireless), by id; the voltage as a coarse word (was a per-model curve to the per cent). |
| `logitech_g435_0adf.cpp`, `.h` | — | **Not ported:** the battery is read inside the dongle's OTA (firmware-update) session, after REMOTE_SET_MODE switches the dongle's routing — neither is a status read. |
| `astro.cpp` | `heads/astro.rs` | A50 X / Gen 5 (0C … 06 0C) and A50 Gen 3 / 4, A20 (54 status, 7C battery). No cached level while Astro Command Center holds the collection: «no answer». |
| `audeze.cpp` | `heads/audeze.rs` | Maxwell: attribute 0CD6, the input report 07 scanned; a dongle named «… Dongle» is «no device linked», nothing sent; 0 % (just switched on) is no level (was a 90 s global); dongle and cable one card. HeadsetControl's 14-packet start left out, as in the original. |
| `hyperx.cpp` | `heads/hyperx.rs` | Cloud III / II Core, III S, II (HP, Kingston), Alpha, Alpha 2, Flight, Stinger Core / Core Wireless, and the Pulsefire Haste 2 mice (their cards are mice). Voltages as coarse words (Cloud Flight's polynomial and the Stinger's tables dropped); the Haste 2's settle window (a global clock) not kept. |
| `sony_inzone.cpp` | `heads/sony.rs` | H9 II, H5 and the INZONE Buds (as earbuds with left, right and case; «both in the case» when the dongle takes the request and nothing answers); the transaction id from the clock, sealed with its checksum. |
| `jabra.cpp` | `heads/jabra.rs` | Link 380 / 390 dongles: battery (12 02) and the headset's name (02 00); NAK is «no device linked». |
| `jbl.cpp` | `heads/jbl.rs` | Quantum 520 / 650 / 850 / 950 (and X): HIDV3 «get device info» of the battery feature; Quantum 350: its feature reports 68 and 49 read, nothing sent (on by default). |
| `plantronics.cpp` | `heads/plantronics.rs` | BT600: only GET 0A 1A. **Not sent:** the adapter's attach report (06 01) and the HELLOs to the adapter and the headset (a session with the headset over the air, not a read): read once Poly's own software attached the adapter, else «no answer». The level as its steps. |
| `maono.cpp` | `heads/maono.rs` | PD200W microphone («Other»): GET register 0042. |
| `moondrop.cpp` | `heads/moondrop.rs` | GM01 Pro: READ 27 (battery), READ 31 (link). The headset on its cable (no control channel) is not made a card from its path's form. |
| `mchose_headset.cpp` | `heads/mchose.rs` | V9 Pro 2: read battery (0B), the XOR checked; «off» is asleep, no level kept. |
| `alienware.cpp` | `heads/alienware.rs` | AW920H on its dongle: C0 0A, the reply fetched as input report 07, its XOR checked; three tries within the deadline. |
| `fractal.cpp` | `heads/fractal.rs` | Scape: GET_DEVICE_STATE to the dongle and the headset; dongle and cable one card. |
| `rog.cpp` (Pelta, Delta II) | `heads/rog.rs` | CC 12 07 (battery), CC 12 08 (charging); «asleep» is the dongle's answer this round. |
| `airpods.cpp` | `airpods.rs`, `win/ble.rs` (the `wgi` feature) | Listening only: Apple's proximity broadcast, matched to a paired device's model, the strongest recent one; buds and case as parts in tenths (the broadcast's own step). Windows' only interface for advertisements is WinRT: behind the `wgi` feature (off by default until CI compiles it); without it a paired AirPods card says «needs a part of Windows this build does not include yet». |
| `galaxy_buds.cpp`, `galaxy_buds_protocol.h` | `galaxybuds.rs`, `win/spp.rs` | An RFCOMM connection to Samsung's status service, listened to — nothing is sent (the reference shows a status-only use). OFF by default; only buds Windows already reports connected; one connection per reading, under the deadline, closed; never pairing, never a device away or asleep. |
| `phonelink.cpp` | `phonelink.rs`, `win/mod.rs` | Exactly what the original reads: Phone Link's Start-menu card in the user's own `%LOCALAPPDATA%` (one file, read only, shared, at most 4 MB, two fields); no process, no other file, no private interface. A «phone» card; the reading's time is the file's (its true age). English phrases only (the card is written in Windows' language). |
| `atk_serial.cpp` | — | **Not ported:** see the last table. |
| `headsetcontrol.cpp` | — | **Not ported:** see the last table. |

The headsets' requests (`heads/allowed.rs`; each for its reader's listed products only; output reports unless marked
feature):

| Family | Bytes | What it asks |
|---|---|---|
| Razer BlackShark V2 HyperSpeed (template) | `02 00 <60–7F> 00 00 00 04 00 00 80 <21/2A> 00 … <XOR>` (64) | battery · charging |
| Razer BlackShark V2 Pro 2020 (feature) | `FF 0A 00 FD 04 12 F1 02 05` | the headset's status |
| Razer BlackShark V3 X (feature, template) | `07 00 <01–FF> 00 00 00 02 07 <80/84> 00 … <XOR of 3–60>` (64) | battery · charging |
| Razer BlackShark V3 / V3 Pro | `02 00 60 00 00 00 04 00 00 80 21 00 … <XOR>` (64) | battery |
| SteelSeries Arctis | `06 12` · `06 18` · `00 20` · `00 41 AA` / `41 AA` · `00 40 AA` / `40 AA` · `06 B0` · `00 B0` · `01 B0` | each model's own status read |
| Corsair | `C9 64` · the Bragi GET templates of piece 5 | battery · battery, charge state, paired id |
| ASTRO | `02 0C 03 00 06 0C` · `02 54` · `02 7C` | battery · headset status · battery |
| Audeze | `06 07 80 05 5A 03 00 D6 0C` | attribute 0CD6 (battery) |
| HyperX | `66 82/8A/89` · `0C 02 03 01 00 02/06/48` · `06 FF BB 02/03` · Kingston's 17-byte `… BB 02/03 00` · `21 BB 03/0C/0B` · `52 01` · `50 02` · `21 FF 05` · feature `FF 07 00 FD 04 …` (connection, battery) | link · charging · battery |
| Sony INZONE (template) | `02 0C 01 00 FC 08 96 C3 41 04 01 <tid 02–FF> 00 <sum>` (64) | battery info GET |
| Jabra (templates) | `05 04 00 <seq> 46 12 02` · `05 04 00 <seq> 46 02 00` | battery · name |
| JBL (feature) | `88 00 DD 01 00 01 00 02 00 0D 00` | device info, feature 000D (battery) |
| Poly BT600 | `07 01 01 10 06 20 00 00 02 0A 1A` | GET battery |
| MOONDROP · MCHOSE · Alienware · Fractal · ROG · MAONO | `4B 80 27 00` / `4B 80 31 00` · `55 AA 01 00 01 00 01 0B 00` · `06 C0 0A` · `02 11 21` / `02 F1 21` · `CC 12 07` / `CC 12 08` · `C4 09 00 00 04 42 00 ED FE` | battery, link, status — one or two each |
| Logitech G headsets (HID++, `permit_hidpp`) | piece 5's rule, with ADC_MEASUREMENT (1F20) function 0 | battery voltage |

### D1: the original's v1.1.0 (BatteryHub) — its new and changed device readers

Each file below names `… at v1.1.0 (commit 7cc44f2)` in its header. Every new reader that sends a request is off until
the user turns its family on, «ported, untested»; each request is listed byte for byte in `mice/allowed.rs`,
`heads/allowed.rs` or `allow.rs`.

| Original (C++, v1.1.0) | Here | How it reads; what changed |
|---|---|---|
| `ajazz_ak992.cpp` | `mice/atk.rs` | AJAZZ AK992 (320F:50C3): the Evision status request, one fixed sequence number. |
| `akg.cpp`, `endorfy.cpp` | `heads/airoha.rs` | AKG N9 Hybrid (0ECB:20D9), ENDORFY Viro Wireless (3738:0072): Airoha RACE «get battery», the Audeze request. |
| `akko.cpp` | `mice/cherry.rs` | Akko V9 Dash Pro (38EE:000C): the FF1C channel's status query. |
| `atk_bitmouse.cpp` (8K Nano), `atk_keyboard.cpp` (VGN / VXE), `redragon_evision.cpp` | `mice/atk.rs` | ATK 8K Nano dongle (GetConfigData as feature report 0); VGN / VXE keyboards and «Wireless Gaming Keyboard» receivers on 320F:5088 / 5055, told apart by their product strings (`mice::find_for`); Redragon on 320F:226F. |
| `aula_mouse.cpp`, `aula_mouse_protocol.h`, `aula.cpp` (SC580, 05AC:024F) | `mice/aula.rs` | AULA X9 / V9 (START, battery, END — END always sent); AULA SC580 (GetDeviceInfo 30, resent on busy, a charging mouse's fixed 100 not taken as a level); MCHOSE BY receivers on 05AC:024F by their own layout only. |
| `chimera.cpp`, `zenith.cpp`, `cherry.cpp` (XTRFY), `kysona.cpp` | `mice/kysona.rs` | Chimera V2, Zenith Pro, Cherry XTRFY 1K receiver, HECATE's receiver D3FB: the Compx 17 frames; VXE R1 cable and receiver one card. |
| `darkrim.cpp`, `docs/darkrim.md` | `heads/darkrim.rs` | DARKRIM SHADOW: the documented GET 0010 frame byte for byte (fixed sequence 03), CRC and TLV checked. |
| `darmoshark.cpp` | `mice/darmoshark.rs` | M3S (248A:FF31); M3S Pro on the Nordic receiver (1915:0723). |
| `dareu.cpp` | `mice/dareu.rs` | Sharkoon Skiller SGM50W (the EM901X request); DAREU A84 (04 F6); DAREU «Togran» (receiver 1131 with a card per paired mouse, A980 Pro cable 1148); a level whose maximum is not 100 stays steps. |
| `eweadn.cpp` | `mice/eweadn.rs` | EWEADN S7 / S9 (checkWirelessOnline 47 00, getBasics 4F 81). |
| `mchose_a5.cpp`, `mchose_keyboard.cpp`, `mchose_modern.cpp` | `mice/mchose.rs` | A5 Pro / Pro Max (route 02 page 00 command 83); GLW keyboards on 3837:3033 (func config read, at most every ten minutes); K7 V2 Ultra+ cable 4028. |
| `nuphy.cpp`, `docs/nuphy.md` | `mice/nuphy.rs`, `kind.rs` | NuPhy WH80 on its cable (GetFunc 05); its Bluetooth ids a keyboard. |
| `scyrox.cpp` | `mice/scyrox.rs` | Scyrox V12M (read profiles 08 01; the active profile's battery). |
| `via_dongle.cpp` | `mice/pmo.rs` | 36B0:3002 dongle (VIA custom value 7, then the PMO Hub session START / battery / STOP), PMO keyboards on their cables. Changed: no memory of which firmware answered. |
| `vgn.cpp` | `heads/vgn.rs` | VGN OMNISOUND (ZHOUTING) dongle: read battery (65 01). |
| `rog.cpp` (Cetra Open) | `heads/rog.rs` | ROG Cetra Open Wireless: left, right and case as one card's parts. |
| `keychron.cpp` (Ultra-Link 8K) | `mice/keychron.rs` | Ultra-Link 8K receiver (B5 03 slots, B3 06 base info). **Not ported:** Keychron keyboards' A4 — answered only by a community firmware patch; on stock firmware the id's meaning is not documented. |
| `astro.cpp` | `heads/astro.rs` | A50 Gen 3: the «current UI» read (72 01) after 7C is refused, on the Gen 3 ids only. Not taken: the second framing. |
| `steelseries.cpp` | `mice/steelseries.rs` | Aerox 3 CS2 Dragon Lore, Aerox 3 Gen 2 (percent layout); the request resent until echoed. |
| `hyperx.cpp`, `jbl.cpp`, `jabra.cpp`, `razer_headset.cpp`, `maono.cpp` | `heads/*.rs` | Haste 2 Mini, Cloud Flight S, Stinger Core DTS; JBL Quantum 610 / 360 (reply id checked); the Evolve3 75 on its cable (address 08 — v1.1.0's asking of every Jabra product is not taken); BlackShark V3 GET 2A and its cables named; MAONO as a microphone (a new kind, its own drawing). |
| `beitong.cpp`, `flydigi.cpp` | `pads/beitong.rs`, `pads/flydigi.rs` | BEITONG KP40D; Flydigi Apex 5 (report 03, its own identities). |
| `wlmouse.cpp`, `rapoo.cpp`, `sonix.cpp`, `misc_mice.cpp`, `phonelink.cpp`, `generic.cpp`, `brands.cpp` | their files | Beast G, Beast X Pro cable; Rapoo VT3 Pro Max and the 13-byte VT3 Max Gen 2; AK820 Pro receiver, the echo instead of the checksum; Inphic model codes; Phone Link's «, charging»; a container connected when its classic or LE node is; «Redragon» by name. |
| `fastpair.cpp`, `ble_adverts.cpp` | `fastpair.rs` | **Parse only:** Fast Pair battery broadcasts; our listening path does not yet hand over service data. |
| `nothing_ear.cpp`, `nothing_ear_protocol.h` | `nothingear.rs` | **Parse only:** the status frames and the query's bytes; the serial-port connection is not made. |
| `gamesir_ble.cpp`, `gamesir_ble_protocol.h` | `pads/gamesir.rs` | **Parse only:** the Cyclone Pro's base-info packet; it needs a GATT connection we do not make. |
| `rawm.cpp`, `rawm_protocol.h` | `mice/rawm.rs` | **Parse only, no reader:** the query carries the host's system and clock (its effect on the mouse undocumented) and needs a stream of pings. |
| `turtlebeach.cpp` | — | **Not ported:** its first request switches the chip's CoAP client on (a state change, not a read). |
| `xinput.cpp` (v1.1.0) | — | **Not ported:** the claim check uses an undocumented, unnamed XInput export (ordinal 108). |
| `sony_inzone.cpp` (v1.1.0) | — | Nothing to take: the buds' left, right and case were already one card's parts here. |
| `update_*.cpp` (auto-update) | — | **Not ported:** Tools updates only through its own releases. |

### What of the original is not ported, and why (the whole project)

| Original | Why not |
|---|---|
| `src/drivers/headsetcontrol.cpp` | It runs a third party's program (HeadsetControl, found next to the app or on PATH, PLAN §9.10) which sends its own HID requests: nothing it sends could be held to `allow.rs`'s table, and Tools does not run outside programs found on the PATH. |
| `src/drivers/atk_serial.cpp` (ATK N9 Pro, N9 Ultra) | A Windows COM port can only be opened exclusively (the maker's app is blocked while it is held — the very fault of §9.3), and the original rewrites the port's line settings with DTR and RTS raised on every open; that this cannot reset or disturb the dongle cannot be shown without the hardware. |
| `src/drivers/barracuda_pro.cpp` (Razer Barracuda Pro) | Its reading goes through the receiver's «remote mode», switched on and off around each query — a mode change, not a status read (as the Barracuda X and BlackShark V2 Pro 2023 in `razer_headset.cpp`). |
| `src/drivers/logitech_g435_0adf.cpp`, `.h` | An OTA (firmware-update) session and REMOTE_SET_MODE before the battery read. |
| `src/drivers/rongyuan.cpp` | Its F7 request, sent to about eighty receiver ids of fifteen vendors, is the poll that brings the radio link up (a wake) — piece 5. |
| `razer_headset.cpp`: BlackShark V2 Pro 2023 (0555), Barracuda X (0550, 0552) | «Remote mode» / «app mode» switches and a sacrificial wake frame around each query. |
| `rog.cpp`: ROG Omni Receiver (1ACE) and the Omni-channel entries | The channel is chosen by the collection's position in its path — piece 5. |
| `misc_mice.cpp`: AJAZZ AJ179 and the AJ-series on 3151; `msi.cpp`: CLUTCH GM41 | No product ids in the sources / a raw byte made into a percentage — piece 5. |
| Single requests not sent (the device is still read when something else made it speak, else «needs a query we do not send»): PlayStation's Bluetooth feature 05, 8BitDo's feature 06, GameSir Cyclone 2's 0F 03 (piece 4); Finalmouse's «wake/all» and its lift-off / profile reads, Endgame Gear 4K's 0F probe, Wraith W1's read sweep, AULA HERO 68 Air's message session (piece 5); BlackShark V3's handshake, Poly's attach and HELLOs (piece 6) | Each changes a mode, wakes a link or opens a session. |
| `src/widget.cpp`: the copies on other monitors' taskbars and the Windows 11 Widgets-button and clock checks | They need UI Automation, which the original runs on a thread of its own to keep Explorer from hanging; Tools' strip stays on the main taskbar. |
| `src/brands.cpp` brand colours | Makers' colours (several yellow or orange); Tools draws in calm colours of its own. |
| `src/report.cpp`, `.h` (support request) | It posts to the author's server (§9.12); Tools sends nothing — a local report is planned (piece 11). |
| `src/main.cpp` (beyond the tray, notices and autostart taken in piece 2), `src/i18n.cpp`, `.h`, `lang/*.txt` | Tools has its own window, settings and five languages; the phrase list was the checklist, Arabic written anew, Hebrew not carried. |
| `src/linux/*`, `linux/*` (udev rule, desktop file), `src/platform_compat.h`, `build-linux.sh`, `Makefile*` | The Linux build is a later piece (PLAN piece 10); its udev rule (all raw HID nodes, read/write: §9.11) will not be taken as it is. |
| `installer/*`, `res/*`, `build.bat`, `scripts/*` | The original's own installer, icons and release scripts: Tools has its own. |
| `tests/*`, `docs/*` | Their C++ tests and protocol notes were read as references; our tests are written anew with made-up reports. |

Everything else of `src/drivers/` and `src/` is ported (pieces 1–6, the tables above): `brands`, `devices`, `hid`,
`generic`, `xinput`, the controllers', the mice' and keyboards', the headsets' and earbuds' drivers.

### What was changed

- **Every device call has a deadline**, and each device is asked on its own thread: one stuck device never delays
  another, and is never asked twice at once (the original waited without limit on cancelled reads and asked every
  device in turn on one thread).
- **One table of allowed writes** (`allow.rs`): nothing can be sent to a device unless the table names the device
  exactly (vendor and product, with usage and interface where needed) and the exact bytes. Devices are opened for
  queries only, never read/write by default, never exclusively. The table holds only the controllers', the mice' and
  keyboards' and the headsets' status requests above, each sent only once the user turned its family on; where a byte varies (HID++'s
  device and feature index, Corsair's target and property, Delux's sequence number) it is bounded to listed values (piece 6: a sequence or transaction id with the checksum that covers it).
- **No device is matched by its vendor id alone.**
- **Coarse levels stay coarse**: XInput's four levels are shown as bars, never as made-up percentages (the original
  showed 5/25/60/100 %).
- **Strict HID ranges**: a battery field with an empty or upside-down range is rejected; values are clamped and never
  exceed 100 % (the original read a min = max field as a percentage).
- **Freshness**: each reading carries its time; its age is shown; a late answer is dropped; a device that does not
  answer shows «no answer» with its last reading dimmed and dated, never an old value as a current one. A Bluetooth
  device that is not connected shows no level (Windows keeps an old one).
- **Identity**: a key per physical unit (serial number, else Windows' container id, else its interface path); the
  same device seen by two readers is merged only by explicit rules (same container, same serial, the user's own
  join), never by name — two identical controllers stay two.
- **Asleep devices are left alone** until the user asks or the device arrives again; unanswered devices are asked
  later and later; enumeration runs once per interval and on device arrival (no per-second timers).
- **Our own interface**: Tools' page in Material 3 Expressive, our own drawn icon per kind of device (no makers'
  logos or product photos), the brand as plain text, Tools' five languages.

## Other notices

The themes' notices are shown in the app under Settings › About › Open-source licences.
