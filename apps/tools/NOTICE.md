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

The vendor drivers (Logitech, Razer, PlayStation, …), the taskbar widget and the support request are not ported yet.
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

### What was changed

- **Every device call has a deadline**, and each device is asked on its own thread: one stuck device never delays
  another, and is never asked twice at once (the original waited without limit on cancelled reads and asked every
  device in turn on one thread).
- **One table of allowed writes** (`allow.rs`): nothing can be sent to a device unless the table names the device
  exactly (vendor and product, with usage and interface where needed) and the exact bytes. Devices are opened for
  queries only, never read/write by default, never exclusively. In this piece the table is empty: the readers only read.
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
