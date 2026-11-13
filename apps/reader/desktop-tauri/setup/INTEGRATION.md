# KurokawaReader Setup — what to apply to the shared files

The designed Windows setup program lives in `apps/reader/desktop-tauri/setup/` (new files only). Its test is
`apps/reader/tests/setupui.cjs`. Nothing shared was edited. These are the additions, in the order to apply them.

```
setup/
  ui/index.html, setup.css, setup.js, words.js     the page (contract at the top of setup.js; a FAKE of it inside)
  ui/icon.svg, ui/fonts/Inter.woff2, Sultan-Medium.woff2   copies of the app's own (public/icons, src/assets/fonts)
  src-tauri/Cargo.toml, build.rs, tauri.conf.json, capabilities/default.json
  src-tauri/src/main.rs      the window, the commands, the Windows calls
  src-tauri/src/logic.rs     std only, unit-tested with rustc alone (12 tests)
  setuptest.ps1              Windows, end to end (CI)
  INTEGRATION.md             this file
tests/setupui.cjs            Chromium: every state, en/ar, light/dark, 100 % and 125 %, keyboard, RTL (792 checks)
```

## 1. `src-tauri/installer/onepage.nsh` — the silent switches (required)

What R6b's installer already takes on its command line: `/S` (NSIS: silent), `/P` (Tauri: passive), `/D=<folder>`
(NSIS: must be last, unquoted), `/R` (Tauri: start the app after a silent or passive install — the updater uses it),
`/UPDATE` (Tauri: update mode), `/KROPTIONS` (R6b: the one screen with its options open).

What is missing: the **desktop shortcut** and **«Open books with KurokawaReader»** cannot be chosen in a silent
install. `KrAfterInstall` applies those choices only when `$KrGui = 1`, which is set only by the one screen. «Open when
done» needs nothing, because the setup program opens the app itself.

Put this **at the top of `Function KrAfterInstall`**, before its `${If} $KrGui = 1`:

```nsis
  ; (Stage R6c: the designed setup program — setup/ — runs this installer silently with the choices as switches:
  ; /KRDESK=0|1 /KRASSOC=0|1. Read here, so they are applied as the one screen's are: no desktop shortcut, the kinds
  ; of file taken back. «Open when done» is the setup program's own.)
  ${If} $KrGui != 1
    ClearErrors
    ${GetOptions} $CMDLINE "/KRDESK=" $0
    ${IfNot} ${Errors}
      StrCpy $KrGui 1
      StrCpy $KrRun 0
      StrCpy $KrDesk $0
      StrCpy $KrAssoc 1
      ClearErrors
      ${GetOptions} $CMDLINE "/KRASSOC=" $0
      ${IfNot} ${Errors}
        StrCpy $KrAssoc $0
      ${EndIf}
      ; (Asked for and not there — an update where Tauri's silent install made none: made here.)
      ${If} $KrDesk = 1
      ${AndIfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
        CreateShortCut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      ${EndIf}
    ${EndIf}
  ${EndIf}
```

The rest of `KrAfterInstall` then does what it already does for the one screen: it deletes the desktop shortcut when
`$KrDesk = 0`, and runs `KR_UNASSOC` for the twelve kinds of file when `$KrAssoc = 0`. `$KrRun` is 0, so it does not
`Exec` the app. Without either switch, nothing changes: the updater's `/P /R /UPDATE`, `/S /UPDATE`, CI's `/S` and the
one screen behave exactly as in R6b. `tests/installerpatch.cjs` is unaffected, because this is inside `onepage.nsh`,
not in the patching.

## 2. `.github/workflows/tauri-check-reader.yml`

**a. Std-only unit tests** (Linux): add to the `for f in …` list

```
apps/reader/desktop-tauri/setup/src-tauri/src/logic.rs
```

**b. Build the setup program.** Put this straight after the step **«One-page installer»**. It must come before
installtest.ps1, whose step 5 rebuilds the app as v2 in the same folder.

```yaml
      # (Stage R6c.) The designed setup program (desktop-tauri/setup): a small Tauri window over R6b's installer, which
      # is embedded in it (KR_SETUP_INNER) and run silently underneath with the choices made. Built in the app's own
      # target folder, so the Tauri crates compiled for the app are reused (same versions, features and profile).
      - name: Setup program
        if: runner.os == 'Windows'
        shell: pwsh
        working-directory: apps/reader/desktop-tauri/src-tauri
        run: |
          $inner = Get-ChildItem 'target/release/bundle/nsis/*-setup.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
          if (-not $inner) { throw 'no NSIS installer to embed' }
          $v = (node -p "require('../../package.json').version").Trim()
          $env:KR_SETUP_INNER = $inner.FullName
          $env:KR_SETUP_APP_BYTES = "$((Get-Item 'target/release/KurokawaReader.exe').Length)"
          $env:CARGO_TARGET_DIR = (Resolve-Path 'target').Path
          $t = Measure-Command { cargo build --release --manifest-path ../setup/src-tauri/Cargo.toml 2>&1 | Write-Host }
          if ($LASTEXITCODE) { throw "setup program: cargo build failed ($LASTEXITCODE)" }
          New-Item -ItemType Directory -Force -Path 'target/release/bundle/setup' | Out-Null
          $out = "target/release/bundle/setup/KurokawaReader-$v-windows-x64.exe"
          Copy-Item 'target/release/KurokawaReaderSetup.exe' $out -Force
          "Setup program: $out, $('{0:N2}' -f ((Get-Item $out).Length / 1MB)) MB (embedded installer $('{0:N2}' -f ($inner.Length / 1MB)) MB), built in $('{0:N0}' -f $t.TotalSeconds) s"
```

The icons come from `src-tauri/icons/` (made by the «Icons» step). `setup/src-tauri/tauri.conf.json` points at them.

**c. Bundles artifact**: add to the `path:` list of `tauri-reader-${{ matrix.os }}…`

```
            apps/reader/desktop-tauri/src-tauri/target/**/release/bundle/setup/*.exe
```

(The «Sizes» step already lists every `.exe` under `release/bundle/`, so the setup program shows there too.)

**d. End to end.** Add this after **«Installer, end to end (Windows)»** and before its `upload-artifact`. That
artifact already uploads `kr-install/*.png` and `*.md`, so the real screenshots and the summary land in it:

```yaml
      # (Stage R6c.) The designed setup program end to end (desktop-tauri/setup/setuptest.ps1): REAL screenshots of its
      # window (welcome, options, installing, done, update), how soon it shows; installed through the window with the
      # desktop shortcut off, again over it with the kinds of file off (the /KRDESK and /KRASSOC switches of
      # onepage.nsh), straight through with /S, then uninstalled.
      - name: Setup program, end to end (Windows)
        if: ${{ !cancelled() && runner.os == 'Windows' }}
        shell: pwsh
        working-directory: apps/reader/desktop-tauri/src-tauri
        run: ../setup/setuptest.ps1
```

**e. The page's own test** (`node tests/setupui.cjs`) needs Playwright and Chromium, like `tests/firstrun.cjs`. Run it
locally. To add it to CI, run it in the «Web UI» step after `npx playwright install chromium`. It needs no build:
it serves `setup/ui` as it is.

## 3. Release patch: what is published for Windows

**Recommended (no change to the updater):**

| File | What it is | Who uses it |
|---|---|---|
| `KurokawaReader-<v>-windows-x64.exe` | **the setup program** (this) | people: the Windows download in the release notes, the Pages site and README |
| `KurokawaReader-<v>-windows-x64-setup.exe` | R6b's plain NSIS installer, unchanged | the app's updater (`updatelogic.rs`, `rustswitch.cjs`, `updateCore.ts` pick this name), unattended installs, «the classic installer» |
| `KurokawaReader-<v>-windows-x64-portable.zip` | unchanged | |

Release patch additions:

1. In the Windows Tauri job, after `node src-tauri/installer/onepage.cjs src-tauri --strict`, add the same commands
   as §2b. Copy `target/release/bundle/setup/KurokawaReader-<v>-windows-x64.exe` into the release files beside the
   NSIS `…-setup.exe`.
2. `KurokawaReader-<v>-SHA256SUMS.txt`: one line for each of the two `.exe` files.
3. The release notes' download table, Windows row: «`KurokawaReader-<v>-windows-x64.exe` — the installer (a few
   seconds, no administrator rights). The classic installer is `…-windows-x64-setup.exe`; the portable build is
   `…-portable.zip`.»
4. If `tests/updatenames.cjs` lists every release file name, add `KurokawaReader-<v>-windows-x64.exe` there. It
   is never chosen by the updater.

**Alternative:** publish the setup program under the `-setup.exe` name and the plain installer as
`…-windows-x64-classic-setup.exe`. Today's updater would then fetch the setup program, which works: `/P` and `/S` pass
straight through to the embedded installer, so the update behaves exactly the same and the download is ~3 MB larger.
Keeping the plain installer for the updater, though, then means changing its file name in `updatelogic.rs`
(`asset_name` for `Kind::Nsis`), `desktop/rustswitch.cjs`, `src/updateCore.ts` and `tests/updatenames.cjs` together.

## 4. `PORTING.md`: a section to add after «Updates, the installer, the first start (stage R6b)»

```markdown
## The setup program (stage R6c)

**What it is** (`setup/`: its own small crate, `setup/src-tauri`, and its page, `setup/ui`): the Windows download,
`KurokawaReader-<v>-windows-x64.exe` — a 720 × 480 frameless Tauri window (the app's Tauri/wry stack), Material 3
Expressive like the app (its tokens, wavy progress, title-bar buttons; the icon's blue), in five languages (Windows'
display language by default, a picker in the title bar; Arabic right to left), light or dark as Windows is. R6b's
tested NSIS installer is embedded (build.rs: `KR_SETUP_INNER`) and run **silently underneath** with the choices made
— `/S /KRDESK=0|1 /KRASSOC=0|1 /D=<folder>` (`logic.rs`; the two switches are read by `onepage.nsh`'s
`KrAfterInstall`) — so files, registry, uninstaller, kinds of file, shortcuts and the Electron replacement are R6b's.
**One screen**: the icon and name, «Install» («Update» over an earlier copy — this build's, updated where it is, or
the Electron build's, replaced — with «Your library is kept»), a summary of what will happen, «Options» opening in
place (folder through Windows' folder dialog, desktop shortcut, opening books with it, opening it when done); then the
progress — preparing → copying files → shortcuts and file types → done, from what is really seen (the installer
written out; KurokawaReader.exe's size growing against the build's size; uninstall.exe and the Start-menu shortcut
written; the installer's exit) and never going back —; then «Open KurokawaReader» / «Close», or, on a failure, what
failed in words (the installer's exit code: 1 cancelled, 2 stopped — the app running, a folder locked —, others by
number; the folder not writable; the installer not written out) with «Try again» and «Use the classic installer».
Enter installs; Esc closes (while installing it asks; closed, the install still finishes and the program ends after).
**Without a window**: `/S`, `/P`, `--silent` pass straight through to the installer (its exit code returned); no
WebView2 (its Evergreen runtime's registry keys, a rare Windows 10) or `--classic` → the installer's own one screen,
which fetches WebView2 — never a blank window. **Start**: WebView2 and the app mode read (four reg.exe queries at
once, tens of ms), the window shown in its colour before the page paints where Tauri has `background_color` (R6b's
`bootdetect.rs`, read by `setup/src-tauri/build.rs`), else when the page says it has painted; the installer is
written out and the installed copy found (`reg export`, UTF-16: paths in any script) while the person reads.
**The page ⇄ Rust contract** is at the top of `setup/ui/setup.js` (`setup_detect`, `setup_browse`, `setup_install`,
`setup_progress` polled, `setup_open_app`, `setup_classic`, `setup_close`, `setup_window`), with a fake of it in the
page. **Tests**: `setup/src-tauri/src/logic.rs` (std only, CI); `tests/setupui.cjs` (Chromium: every state in English
and Arabic, light and dark, at 100 % and 125 %; options → install(); update wording; failure and retry; keyboard;
right to left; `--shots <dir>` for pictures); `setup/setuptest.ps1` (CI, Windows: real screenshots, installed through
the window with the shortcut off, over it with the kinds of file off, /S straight through, uninstalled).
```

## 5. Size and time, expected (to be confirmed by the workflow's «Setup program» line and setuptest.ps1)

- **Size**: the embedded installer is R6b's plain NSIS (≈ 9.4–10 MB; already LZMA-solid, so it is stored as it is),
  plus the setup program itself (Tauri + wry + the dialog plugin, `opt-level = "s"`, LTO, stripped: ≈ 2.5–3.5 MB,
  its page and two fonts ≈ 0.15 MB). Total ≈ **12.5–13.5 MB**, about 3 MB more than the plain installer and about
  a sixth of Electron's 81.6 MB.
- **Time**: the window is shown at once, in its colour (WebView2 starting: ≈ 0.2–0.4 s to the painted page). The
  installer is written out (≈ 10 MB, tens of ms) while the person reads. «Install» to «done» is the plain installer's
  silent time (installtest.ps1's «silent install» row, a few seconds) plus ≤ 0.1 s of polling. Nothing is clicked
  through: one press.

## 6. Verified here, and not until CI or a real PC

Verified here: the page (792 checks in Chromium, every state, both directions, both themes, 100 % and 125 %); the
std-only logic (12 Rust tests, `rustc --test`); the build script (its own parts compiled and run, Tauri's step left
out); `main.rs` and `build.rs` parse (rustfmt).

**Unverified until CI compiles it** (no crates here):

- `main.rs` against the resolved Tauri 2 and tauri-plugin-dialog 2. The APIs are the ones the app's own code already
  compiles with: `WebviewWindowBuilder` (`title`, `inner_size`, `decorations`, `initialization_script`, `visible`,
  `background_color` under `kr_bg_color`), `Window::{minimize, start_dragging, show, hide, set_focus}`,
  `dialog().file().blocking_pick_folder()` and `into_path()`, `AppHandle::exit`, `RunEvent::Exit`.
- Calls the app does **not** use, any of which could need a one-line fix: `.resizable(false)`, `.maximizable(false)`,
  `.center()`, `.is_visible()`, `FileDialogBuilder::set_directory` (used by shell-rs), `State::inner()`.
- The `tauri/custom-protocol` feature as the crate's default, so that a plain `cargo build --release` embeds the page.
- That app commands need no capability entry. This is the app's own assumption, and its `default.json` says so.

**Unverified until a real PC:**

- Win11's rounded corners and shadow on the frameless window (Tauri's default undecorated shadow).
- How soon the window shows.
- The progress steps' timing on a fast SSD (they may pass in a blink, but they are never ahead of what happened).
- Windows SmartScreen's prompt for an unsigned download (as for the plain installer).
- `GetUserDefaultUILanguage` picking Arabic on an Arabic Windows.
