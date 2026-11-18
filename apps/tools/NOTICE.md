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

The other vendor drivers (Logitech, Razer, …), the taskbar widget and the support request are not ported yet (the
controllers came in piece 4, below).
Drivers that send undocumented commands are not ported until they are understood.

### What was taken (piece 2: the background)

| Original (C++) | Here |
|---|---|
| `src/main.cpp` (UpdateTrayIcon: the low-battery balloon and its re-arming) | `notice.rs` |
| `src/main.cpp` (the tray's tooltip and menu) | `summary.rs`; the shell's one tray icon (`desktop-tauri/src-tauri/src/desktop.rs`) |
| `src/main.cpp` (SetAutostart / AutostartEnabled), `src/linux/main_linux.cpp` (ApplyAutostart) | `autostart.rs`, `win/autostart.rs` |

Changed: the low mark is the user's, per device (10/15/20/30 % or off; re-armed at mark + 5 % or by charging), coarse
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

### What was changed

- **Every device call has a deadline**, and each device is asked on its own thread: one stuck device never delays
  another, and is never asked twice at once (the original waited without limit on cancelled reads and asked every
  device in turn on one thread).
- **One table of allowed writes** (`allow.rs`): nothing can be sent to a device unless the table names the device
  exactly (vendor and product, with usage and interface where needed) and the exact bytes. Devices are opened for
  queries only, never read/write by default, never exclusively. The table holds only the controllers' status requests
  above, each sent only once the user turned its family on.
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
