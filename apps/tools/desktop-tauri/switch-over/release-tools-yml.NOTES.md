# release-tools.yml — the switch-over patch (Tools' stage P9), NOT applied

`git apply --check release-tools-yml.patch` passes against `.github/workflows/release-tools.yml` on branch work-tt-p9
(checked when it was made). Apply it only at the switch-over, together with the flips below.

## What the patch does

1. **Paths**: `'!shared/shell-rs/**'` removed — the Tools Tauri shell builds on the shared crate since P3, so a change
   to it must release Tools too (as release.yml does for the Reader).
2. **`rust-desktop` job** (Windows and Linux required; macOS universal optional, `continue-on-error`): web UI built;
   aria2c (`desktop/fetch-aria2.mjs`, none for macOS) and 7-Zip (7zip-bin) copied into the bundle; icons; `tauri build`;
   Windows: the one-page installer (`installer/onepage.cjs`, not strict: Tauri's own installer kept with a warning if
   the script is unlike the one written for), the designed setup program (`desktop-tauri/setup`, the plain installer
   embedded, `KR_SETUP_APP_EXE` read from the rendered script's MAINBINARYNAME), the portable zip (program renamed
   «Kurokawa Tools.exe», aria2 and 7zip beside it, `KurokawaTools.portable` marker). Collected under the release names
   already fixed in PORTING.md / updatelogic.rs / rustswitch.cjs (tests/updatenames.cjs):
   - `KurokawaTools-<v>-windows-x64.exe` — the setup program (the download people take)
   - `KurokawaTools-<v>-windows-x64-setup.exe` — the plain NSIS installer (the updater and the Electron switch take it)
   - `KurokawaTools-<v>-windows-x64-portable.zip`
   - `KurokawaTools-<v>-macos-universal.DMG`
   - `KurokawaTools-<v>-linux-x64.appimage`, `KurokawaTools-<v>-linux-x64.deb`
3. **`release` job**: needs `rust-desktop`; a **Checksums** step writes `KurokawaTools-<v>-SHA256SUMS.txt` over every
   artifact (published with the release); the Rust files are uploaded after the others (`gh release upload … --clobber`);
   the notes say when a Rust build did not come (the Electron file then stays that system's download — macOS optional).
4. **Electron builds kept as «previous build»**: the `windows`, `macos`, `linux` jobs are unchanged and keep
   publishing `…-win-x64.exe`, `…-win-x64-portable.exe`, `…-mac-universal.dmg`, `…-linux-x86_64.AppImage` — what every
   installed Electron copy's updater takes. With `RUST_SWITCH = true` those builds are the **bridge build**.
5. **Release notes table**: Windows → the setup program first, the classic installer and the portable zip; «Windows
   (previous build, kept for two versions)»; «macOS (previous build)»; Linux → `.appimage` / `.deb`, the previous
   AppImage; a line on `*-SHA256SUMS.txt`.
6. **The web job** also runs `tests/installerpatch.cjs`, `updatenames.cjs`, `handover.cjs`, `firstrun.cjs`,
   `setupui.cjs`.

## Edits to make by hand (listed, not applied)

- `apps/tools/README.md` (and `README.ar.md`, `.ja.md`, `.ko.md`, `.zh.md`): the desktop line under «Build»
  (`cd desktop && npm run dist:win`) → add the Tauri build (`cd desktop-tauri && npx @tauri-apps/cli@^2 build`, its
  icons first) and say the Electron folder is the «previous build» for two versions.
- `apps/tools/docs/native-desktop.md`: a first paragraph saying the computer app is now the Tauri shell
  (`desktop-tauri/`, PORTING.md) and `desktop/` the previous build kept for two versions; the updater line → the Tauri
  updater (`update.rs`, checks SHA256SUMS / GitHub's digest; Windows installs in place, AppImage replaced, .deb opened in
  the software installer, a Mac's DMG opened).
- The repository's `README.md` table row for Kurokawa Tools: «Releases `tools-v*` (pre-releases)» → add «computer:
  `*-windows-x64.exe`, `*-macos-universal.DMG`, `*-linux-x64.appimage` / `.deb`».
- The releases page / Pages site: nothing names Tools' desktop files today (the release body is generated); no edit.
- There is no `apps/tools/docs/INSTALL.md`; the release body's table above is the install guide.

## Exactly what to flip at the switch-over

1. `apps/tools/desktop/main.cjs`: `const RUST_SWITCH = false;` → `true` (the bridge build).
2. `git apply` this patch.
3. Version: a minor bump in `apps/tools/package.json` and `apps/tools/desktop/package.json` (the bridge build and the
   Tauri build carry the same version; the Tauri build reads `apps/tools/package.json`).
4. `apps/tools/docs/notes/NEXT-rust.md` → `apps/tools/docs/notes/v<that version>.md` (the release job reads that name),
   its sizes replaced by the ones the `rust-desktop` job prints.
5. Two versions later: remove the `windows`, `macos`, `linux` (Electron) jobs and their rows from the notes table;
   keep `apps/tools/desktop/` in the repository.

## What must be true before flipping

- The screen translator's 8 channels ported (P7) — else an Electron user of it loses it on the move.
- A green `tauri-check.yml` run of this stage on all systems: its first compile (handover.rs, main.rs's P9 block, the
  setup crate under Tools' paths, `tauri.conf.json`'s new `bundle.windows`), the installer / setup / hand-over steps on
  Windows (required), the hand-over on Linux (reported).
- The owner's go-ahead after trying the preview builds (docs/RUST-PORT.md, P9 row: irreversible for users).
