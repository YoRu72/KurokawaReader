# Porting the Reader's desktop shell to Tauri v2

The Electron shell (`../desktop/`) keeps shipping; this Tauri shell grows beside it, stage by stage
(`docs/RUST-PORT-READER.md`), until it has every function below, then replaces it. **Stage R0**: the shared crate, the
Tauri project, the interface opening in it, and the bridge's round trips proven by a self-test in CI. **Stage R1**: the
engine test — the web app's key cases run in each system's own web view in CI (see «Engine test» below).

## How it works

- `src-tauri/src/main.rs` opens the window — made in Rust (`app.windows` is empty in `tauri.conf.json`) so it can carry
  the initialization script — on the same built web app (`../dist`, from `node scripts/build.mjs`). The window is
  `desktop/main.cjs`'s: titled KurokawaReader, 1180×820 or as it was left, at least 420×600; Tauri's own drag-and-drop
  handling is off so the page gets the HTML drop events it imports books with. The window-state file always holds a
  size: a window that is maximized before any size was saved (macOS calls a window maximized when its default size
  fills a small screen) saves the size it has, as Electron always saves its normal bounds.
- `bridge.js` runs before the page's own scripts on every load, after a line that sets `window.__KR_BOOT__ = { os,
  arch }`, and defines the same `window.kurokawaDesktop` the Electron preload does: **all 48 names** (47 functions and
  `platform`) — except the 23 **left out** until their stage (below). Each Electron channel `kr:a-b` is the Tauri
  command `kr_a_b` (`src-tauri/src/commands.rs`); arguments
  are sent under one-word keys (`p`, `o`, `text`, `b64`, `append`, `exts`), so Tauri's camelCase mapping never matters.
- The commands are thin wrappers over **kurokawa-shell** (`shared/shell-rs`), the Rust both apps' shells share (see
  below). Only `scan.rs` (the whole-computer scan, std only) is the Reader's own.
- What is not ported yet is a **stub** in `bridge.js` (its `STUBS` table): it never reaches Rust, and answers as
  Electron itself answers when it cannot do the thing (`false`, `null`, `'unsupported'`, `{ cleared: 0 }`…), or —
  where Electron has no such answer — rejects with `Error('<name> is not in this preview build yet (Tauri stage
  Rn)')`. The table below says how the page copes with each. `window.__KR_BRIDGE_STUBS__` lists them with their stage.
- R0 found that a stub being **present** makes the page skip a fallback that works. So a name the page tests for before
  it uses it is **left out** of `window.kurokawaDesktop` until its stage (`bridge.js`'s `LEFT_OUT`,
  `window.__KR_BRIDGE_LEFT_OUT__`): the page then takes its own way, and shows no control that cannot work. A name the
  page calls without a test (`onOpenFile`), or whose stub answers better than its absence (`installUpdate`: «not in
  this preview build yet» rather than «desktop»), stays a stub.
- `kr:http` (web requests without the page's cross-site limits) is the shared `net.rs` (reqwest, rustls, gzip /
  brotli / deflate); the bridge always asks for the body as base64 and makes it text itself, in the page's charset —
  the Content-Type's, else a `<meta>` in the first 2048 bytes, else UTF-8 — with `TextDecoder`, exactly as
  `main.cjs`'s `decodeText` does (an older Arabic site in windows-1256 reads right). `accept-encoding` is dropped
  from the page's headers, as `main.cjs` drops it. The user agent of requests that do not set their own is a plain
  Chrome's (as Electron's, with its tokens taken out); the sources send the page's own.
- Version: `tauri.conf.json` has `"version": "../../package.json"`, so the app's version is `apps/reader/package.json`'s.
  Product name `KurokawaReader`, identifier `app.kurokawa.reader` — the Electron build's own (as Tools' Tauri shell
  reuses its Electron ids).
- Icons: not committed; CI runs `npx @tauri-apps/cli icon ../desktop/icon.png` first (it writes `src-tauri/icons/`).
  Do the same once before a local `tauri build` / `tauri dev`.
- `samples/alice-in-wonderland.epub` is taken out of `dist/` before the build in CI, as the Electron build leaves it out
  (the app fetches it from the web app when asked).

What differs from Electron in this stage, on purpose: the window's title bar is drawn whole by the page — its buttons
too — instead of Electron's strip under the system's buttons (see «The window's title bar» below), no application menu (R5; the page's own keyboard shortcuts
work), no cookies shared between `http` and an in-app browser (R3/R4), and the page's origin is Tauri's
(`tauri://localhost`, `http://tauri.localhost` on Windows), not `app://kurokawa` — so the library starts empty; carrying
it over from the Electron profile is R6.

## The shared crate: `shared/shell-rs` (kurokawa-shell)

Taken from Kurokawa Tools' Tauri shell on branch `work-tauri` (where it compiled and passed its 26-check self-test on
Windows, Linux and macOS) with as little change as possible. Tools-only parts — the aria2 engine (`engine.rs`,
`engine_core.rs`) and its RPC (`rpc.rs`) — stay in Tools. **No `#[tauri::command]` lives in the crate**: each app keeps
its own commands (Tools `kt_*`, the Reader `kr_*`) as wrappers, so no command macro crosses a crate boundary.

| Module | What | Changed from Tools' |
|---|---|---|
| `util.rs` | Node's OS/CPU names, base64, hex, version order, file:// → path, the release asset for an OS (std only) | no |
| `files.rs` | list, path info, exists, siblings, write text, remove, temp files (std only) | added `write_bytes` (append), `file_size` (-1), `read_text` (null) for the Reader |
| `hash.rs` | md5 / sha1 / sha256 of a file | no |
| `net.rs` | `http`, the update check | user agent set by the app (`configure`); the update check split into `check_update_at(url, prefix, current, prereleases)` and a pure `pick_release`; Tools' `check_update(current)` kept, same behaviour |
| `winstate.rs` | window size/place kept between runs | default and smallest sizes given by the app (`Defaults`; were Tools' 1100×780 / 420×560); `save`, `file`, `parse` public |
| `shell.rs` | system folders, file dialogs, clipboard, opening a path / an address, a file's bytes for the IPC | new file, bodies moved unchanged from Tools' `commands.rs`; added `set_clipboard_text` |
| `selftest.rs` | the self-tests' frame: `<PREFIX>_SELFTEST`, watchdog, verdict, results file | the app-neutral half of Tools' `selftest.rs`; prefix and exit hook given by the app |
| `testserver.rs` | loopback test server (std only) | added `/latin`, `/meta`, `/releases` |

Both apps' `Cargo.toml` list `tauri` and the three plugins (dialog, clipboard-manager, opener) at the same versions as
the crate (`"2"`), so one version of each is resolved; the app registers the plugins (Tauri's build reads their
permissions from the app's direct dependencies).

**For Tools to switch to it later** (on `work-tauri`, not here):
1. `Cargo.toml`: add `kurokawa-shell = { path = "../../../../shared/shell-rs" }`; `reqwest`, `sha1`, `sha2`, `md-5` can
   go if nothing else of Tools' uses them (the engine's `rpc.rs` is std only; check `engine*.rs`).
2. `main.rs`: replace `mod files; mod hash; mod net; mod testserver; mod util; mod winstate;` with
   `use kurokawa_shell::{files, hash, net, testserver, util, winstate};` — `crate::util::…` paths in `engine*.rs`,
   `commands.rs` and `selftest.rs` then still resolve — and delete those six files.
3. `main.rs`: `net::configure(format!("Mozilla/5.0 (compatible) KurokawaTools/{} (Tauri)", env!("CARGO_PKG_VERSION")))`
   before the builder (today's user agent); `winstate::load(&handle, &winstate::Defaults { width: 1100.0, height:
   780.0, min_width: 420.0, min_height: 560.0 })`.
4. Optionally: `commands.rs`'s dialog / clipboard / opener / list-dir bodies → `kurokawa_shell::shell::*`, and
   `selftest.rs`'s frame → `kurokawa_shell::selftest` (`begin("KT")`, `on_exit(|| engine stop)`, `progress`, `done`).
5. `tauri-check.yml`: add `'shared/shell-rs/**'` to its paths.

Note for main: `release.yml` and `release-tools.yml` run on pushes to main touching `shared/**`, so a change to the
crate alone would start both Electron releases. Before this branch is merged, add `'!shared/shell-rs/**'` to their
`paths` (or move the crate out of `shared/`).

## Self-test

With `KR_SELFTEST=<file>` set, `src-tauri/src/selftest.rs` starts the shared loopback test server and adds
`selftest.js` to the initialization script. The page waits for the library to render, then checks through
`window.kurokawaDesktop` (and a few `kr_selftest_*` commands that exist only in a self-test run): every preload name is
there and `platform` is right; write text → read → size → read bytes → append bytes → overwrite → remove (size -1, read
null, readFile rejects); the whole-computer scan finds a file put in the home folder; `http` — text and headers (two of
one name joined), redirect, gzip, binary, POST, POST from base64, the charset from Content-Type and from `<meta>`
(windows-1256 Arabic), 404; the update check against a canned releases list (stable 0.62.0 with this OS's asset, beta
0.63.0, nothing after 0.62.0); window state saved and read back as the next start would; the clipboard round trip (not
required); every stub answers as documented. Results go to `kr_selftest_done`, which writes them and exits 0/1; a
watchdog exits 2 after `KR_SELFTEST_TIMEOUT` (140 in CI) seconds. `.github/workflows/tauri-check-reader.yml` runs it
on Linux under Xvfb and on Windows (both required), and on macOS (reported only). `selftest-report.cjs` prints the
results as a table. Not tested by the self-test: the file dialogs (they wait for a person) and `openDefaultApps` (it
opens the system's settings).

`tests/tauribridge.cjs` keeps the bridge, the preload, the Rust command list and the self-test script in step (plain
node; `--node-only` in CI), and loads the built app in Chromium with the bridge and a fake Tauri IPC: the library
renders with the computer's sidebar, a book opens in the reader, Settings open, no page errors, and each ported function
sends the right command and arguments from the page.

## The 47 functions (and `platform`)

`docs/RUST-PORT-READER.md` says 38; `desktop/preload.cjs` today gives 47 functions and `platform`. All are here.

**Done: 14** (R0: 12, the title bar: 2; + `platform`) · **stubs: 10** (R2: 2, R3: 1, R5: 5, R6: 2) · **left out: 23** (R3: 5, R4: 4, R5:
12, R6: 2).

| Function | Electron (`main.cjs`) | R0 | How the page copes with the stub | Stage |
|---|---|---|---|---|
| `platform` | `process.platform` | **done** (`__KR_BOOT__.os`) | | |
| `readFile(p)` | `kr:read-file`: the bytes, ArrayBuffer | **done** `kr_read_file` | | |
| `fileSize(p)` | `kr:file-size`: size, -1 if none | **done** `kr_file_size` | | |
| `readTextFile(p)` | `kr:folder-read`: UTF-8 text or null | **done** `kr_folder_read` | | |
| `writeTextFile(p, text)` | `kr:folder-write`: write UTF-8 → true | **done** `kr_folder_write` | | |
| `writeBinary(p, b64, append)` | `kr:write-binary`: write / append bytes → true | **done** `kr_write_binary` | | |
| `scanDevice(exts)` | `kr:scan-device`: home (+ drives D:–Z: on Windows), 7 deep, 8000 files / 20000 folders | **done** `kr_scan_device` (`scan.rs`, same walk) | | |
| `pickFolder()` | `kr:folder-pick`: folder dialog → path / null | **done** `kr_folder_pick` | | |
| `archivePickDir()` | `kr:archive-pick-dir`: folder dialog → path / null | **done** `kr_archive_pick_dir` | | |
| `archivePickFile(o)` | `kr:archive-pick-file`: file dialog ({multiple}) → paths / [] | **done** `kr_archive_pick_file` | | |
| `openDefaultApps()` | `kr:default-apps`: the system's default-apps page (Windows, macOS); false elsewhere | **done** `kr_default_apps` | | |
| `http(o)` | `kr:http`: request without cross-site limits, session cookies, text in the page's charset | **done** `kr_http` (no cookie jar yet: R3/R4) | | |
| `isPortable()` | `kr:is-portable` | **done**: `false` (this build is never Electron's portable .exe) | | |
| `appIcon(o)` | `kr:appIcon`: the user's own icon on window, taskbar, shortcuts | **left out** | no app-icon option in Settings (`appIconWay()` is null) | R5 |
| `titleBar(o)` | `app:titleBar`: the app's own bar's colours, `{platform, height, …}` | **done** `kr_title_bar` (`titlebar.rs`): `o.own` asks for the app's own bar or the system's frame, `o.act` works the window (`minimize`, `maximize` = maximise / restore, `close`, `drag`) → `{platform, height, own, wanted, controls, maximized, fullscreen, focused}` — a different protocol from Electron's (see below) | | |
| `onTitleBarState(cb)` | `app:titleBarState` events | **done**: the `kr:titleBarState` Tauri event (the state above, on each change) | | |
| `setZoom(f)` | `webFrame.setZoomFactor` | stub: nothing | the interface stays at 100% (Appearance → size has no effect) | R5 |
| `onOpenFile(cb)` | `kr:open-file` events (double-click, open-with, second instance) + `kr:ready` | stub: nothing | files are added from inside the app only | R2 |
| `installUpdate(url, o)` | `kr:install-update`: download, then install / swap | stub: rejects | the update sheet shows its error | R6 |
| `downloadUpdate(o)` | `kr:update-download`: electron-updater in the background | **left out** | no «download in the background» switch; the page's own check and update sheet | R6 |
| `installDownloadedUpdate()` | `kr:update-install` | **left out** | (never offered: nothing is downloaded) | R6 |
| `onUpdateProgress(cb)` | `kr:update-progress` events | stub: nothing | | R6 |
| `archiveList(o)` | `kr:archive-list` (7-Zip) | **left out** | no Archives button (`canArchive()` is false) | R5 |
| `archiveExtract(o)` | `kr:archive-extract` | **left out** | as above | R5 |
| `archiveCancel(id)` | `kr:archive-cancel` | **left out** | as above | R5 |
| `archiveCreate(o)` | `kr:archive-create` | **left out** | as above | R5 |
| `archiveTest(o)` | `kr:archive-test` | **left out** | as above | R5 |
| `archiveRestore(o)` | `kr:archive-restore` | **left out** | as above | R5 |
| `archiveFree(o)` | `kr:archive-free` | **left out** | as above | R5 |
| `archiveExisting(o)` | `kr:archive-existing` | **left out** | as above | R5 |
| `onArchiveProgress(cb)` | `kr:archive-progress` events | **left out** | as above | R5 |
| `setFullscreen(v)` | `kr:fullscreen`: the window full screen → new state | **left out** | F11 / the reader's full-screen button use the HTML full screen (`toggleFullscreen`), or the reader's immersive mode where the web view has no Fullscreen API | R5 |
| `setImmersive(on)` | `kr:immersive` | stub: `false` | the reader's immersive mode hides the app's bars only | R5 |
| `copyImage(b64)` | `kr:copy-image`: image to the clipboard | stub: `false` | the page falls back to `navigator.clipboard.write` | R5 |
| `printToPdf(html, o)` | `kr:print-pdf`: a hidden window prints a text PDF | **left out** | the converter's PDF output is the picture PDF (searchable text over page pictures), as on the web | R5 |
| `setDoh(provider, test)` | `kr:set-doh`: Chromium's secure DNS | **left out** | no DNS-over-HTTPS section (`hasDoh()` is false) | R3 |
| `openWebView(o)` | `kr:open-webview`: a site's check passed in the app's browser window | **left out** | no in-app browser (`hasBrowser()` is false: Settings says there is none); a site behind a check reports it as not passed | R4 |
| `browserFetch(o)` | `kr:browser-fetch`: a request from the site's own page | **left out** | the sources' requests go the plain way (`http`) | R4 |
| `browserReset(url)` | `kr:browser-reset` | **left out** | | R4 |
| `browserForget(url, all)` | `kr:browser-forget` | **left out** | (no in-app browser section) | R4 |
| `notify(o)` | `kr:notify`: a system notification | stub: `false` | no notification for new chapters | R3 |
| `download(url, name, id)` | `kr:download`: into the app's data folder (aria2c or ranges), progress events | **left out** | the downloads list and OPDS «Get» use the plain request (`http`), in one piece; starter decks still fail («dk.download is not a function»: decks.ts calls it on every computer without a test) | R3 |
| `deleteDownload(p)` | `kr:delete-download` | **left out** | | R3 |
| `onDownloadProgress(cb)` | `kr:download-progress` events | **left out** | | R3 |
| `addDownloadListener(cb)` | `kr:download-progress` events, per caller | **left out** | | R3 |
| `onOpenUrl(cb)` | `kurokawareader://` links (cloud-sync sign-in) | stub: nothing | sign-ins that come back by such a link do not finish | R2 |
| `onCommand(cb)` | the application menu's commands | stub: nothing | (no menu; the keyboard shortcuts are the page's own) | R5 |
| `setProgress(p)` | `kr:progress`: taskbar progress, no background throttling | stub: nothing | no taskbar progress | R5 |

Kept as stubs on purpose: `setZoom` (Appearance → interface size is shown on every computer and has no effect until
R5 — the page has no fallback either way), `copyImage` (answers false: the page then uses `navigator.clipboard.write`),
`notify` (no notification either way: the page treats the desktop as allowed and never asks the web's permission),
`setImmersive`, `onOpenFile` (called without a test), `onOpenUrl`, `onCommand`,
`setProgress`, `installUpdate` / `onUpdateProgress`.

## The window's title bar (from R5, done ahead of it)

The page draws the whole bar in this shell (`src/ui/winbar.ts`; Electron keeps `src/ui/titlebar.ts`, a strip under
the system's own buttons, unchanged). `bridge.js` marks the shell with `window.__KR_SHELL__ = 'tauri'`; `src/main.ts`
starts the one bar or the other by it, and `src/platform.ts`'s `windowBar` need offers the settings (Appearance →
Title bar: the app's own / the system's; Transparent title bar; The app's name in the title bar — device settings, in
`GLOBAL_ONLY`) only here.

- **Windows, Linux**: the window is made without the system's frame (`decorations(false)`); the page draws the icon,
  the name, the drag strip (a press calls `kr_title_bar({act:'drag'})` → `start_dragging`, the second press of a
  double-click `{act:'maximize'}`, as Tauri's own drag script does) and minimise / maximise-restore / close (46×32).
  Choosing the system's frame calls `set_decorations(true)` at once; the choice is kept in `<config>/titlebar.json`
  (read by `main.rs` before the window is made) as well as in the page's settings, which tell it at each start.
- **macOS**: `title_bar_style(Overlay)` + `hidden_title(true)` — the system's lights over the page, which keeps 78 px
  for them and draws no buttons; a change of bar waits for the next start (the Settings row says so).
- State: `titlebar.rs` emits `kr:titleBarState` on `Resized` / `Focused` when the state changed (maximised → the icon
  turns to «restore»; not in front → the bar quietens; full screen → hidden).
- Commands of the app need no permission (`capabilities/default.json` unchanged): no JS window API is used, so no
  `core:window:allow-*` permission is granted.
- Left out: Mica / acrylic / vibrancy (needs a transparent window and web view, `macos-private-api` on a Mac, and a
  page whose surfaces are see-through — a design change of its own); Windows 11's snap layouts on hovering maximise
  (they need the system to see a caption button: `WM_NCHITTEST` → `HTMAXBUTTON` from a native subclass of the window,
  not reachable from the page).
- Tests: `tests/titlebar.cjs` (the bar, its settings, mirroring, hiding, nothing under its buttons), `tests/tauribridge.cjs`
  (the command and the event), `selftest.js` (in CI: the state, maximise → event → restore; required on Windows),
  `enginetest.js` case 10 (screenshots of the real window: solid and transparent, library and reader, maximise tried).

## Engine test (stage R1)

With `KR_ENGINETEST=<file>` set (and no `KR_SELFTEST`), `src-tauri/src/enginetest.rs` adds `enginetest.js` to the
initialization script and starts the shared frame's watchdog (`KR_ENGINETEST_TIMEOUT` seconds; `KR_ENGINETEST_BUDGET`
seconds after which the cases not yet run are written as skipped). The page drives the real web app — a small driver:
wait for a selector or a condition, click, type, read texts and boxes — and makes every book in code (EPUBs with its
own stored-zip writer, PDFs with its own PDF writer — Helvetica text, Arabic as letters mapped by a ToUnicode table —,
plain text). It reloads the page twice (where it stands is kept in `localStorage`, `kr.enginetest.<runId>`) and
reports through `kr_selftest_progress` / `kr_selftest_done`, as the self-test does. Cases (each check: ok/FAIL, a
detail, a time; «required» ones fail the job on Linux and Windows):

1. **Environment**: engine and version from the user agent, DPR, `deviceMemory`, screen; about 35 features the app
   uses, present or not (a module worker tried for real); every script of the app fetched to see the type the shell
   serves it with, and that none has «%PDF» in its first kilobyte; a blob module with «%PDF» near its start (does the
   engine sniff a declared type?). The non-universal built-ins the bundle uses (a grep of `dist/`), each present or not
   *as the engine has it* (read before the app's scripts and their polyfills run) and whether the app does without it;
   one missing with no fallback is a required failure named «missing, no fallback: …».
2. **Storage**: an EPUB imported (through the library's file input) → in IndexedDB → the page reloaded → still there and
   in the library; where the profile lives (`kr_engine_profile`: the candidate folders, their size, the IndexedDB
   folder found), `navigator.storage.estimate()`.
3. **EPUB**: opened, first text shown; contents → Chapter Two at the top; in-book search finds «quick brown» across
   `<b>` (and whether the hit is marked with `CSS.highlights`); a highlight made from a selection; reopened → back in the
   same paragraph, kept in IndexedDB. **Arabic** book: right to left; letters joined (a word's width ≠ the sum of its
   letters set apart, in the reader's font); the digits the app writes through `Intl` (`-nu-arab` ١٢٣, `-nu-latn` 123,
   percent, Hijri); screenshot. After the second reload, the interface in Arabic (`dir=rtl`) with the book open;
   screenshot.
4. **Text book** of 700 paragraphs: opens, `content-visibility: auto` in use, scrolled to 50 %, the place saved and
   restored (± 2 paragraphs).
5. **PDF**: page 1 drawn (canvas pixels sampled), text layer, page 2 after a scroll, search finds a word, zoom in;
   screenshot; a 300-page PDF made, imported, opened and scrolled to page 250 (times reported).
6. **Converter**: a PDF with English and Arabic → Word; finishes (a «Conversion failed» in the sheet ends the wait at
   once, with its message), the saved file (its download link caught) is a zip whose `word/document.xml` holds both
   texts (read with the test's own inflater); time. Reported with it: what the converter did — the stage and progress
   the sheet shows, pdf.js timing marks (`krTiming`), every worker the page started (script, kind, messages, errors;
   the test wraps `Worker`), console errors, the lane settings, whether `for await` over a stream is native or
   polyfilled. On a failure it tries once more with lanes and the second document off (`krLanes = 0`,
   `krTwoWorkers = false`); on success it converts eight pages in two lanes and then with a second document
   (reported).
7. **Read-aloud** (reported): `speechSynthesis`, voices (count, Arabic ones), speak/cancel, the reader's read-aloud
   (with no `speechSynthesis` — WebKitGTK — the reader must say it cannot read aloud).
8. **Window** (reported): F11 in the reader → HTML full screen or immersive mode; `window.print` present (not called);
   a file dropped on the library (a DOM drop event).
9. **Fonts**: each bundled family loads (`document.fonts`); Noto Naskh Arabic renders at a width unlike a fallback's.
10. **The window's title bar** (reported): the app's own bar and its buttons; screenshots of the real window — the
   library and the reader with the bar solid (`04`, `05`) and transparent (`06`, `07`) —; the maximise button pressed
   and pressed again (`08` while toggled; under Xvfb, without a window manager, nothing changes and that is said).

Screenshots: `kr_engine_shot` runs the system's tool — `import -window root` (ImageMagick, under Xvfb), `screencapture
-x` (macOS; without the screen-recording permission it may show only the desktop), PowerShell `CopyFromScreen`
(Windows) — into `KR_ENGINETEST_SHOTS`. `enginetest-report.cjs` writes the report as Markdown; the workflow keeps the
report (JSON and Markdown), the versions and the pictures as the `tauri-reader-engine-<os>` artifact.
`tests/tauriengine.cjs` checks the test's own zip / inflate / PDF / EPUB code in node, and runs the whole test in
Chromium (the built app, the bridge, a fake IPC): every required check passes there, so a failure in CI is the
engine's. With `--webkit` Chromium is first made to lack what CI's WebKit lacked (async iteration of a
`ReadableStream`, `requestIdleCallback`, `scheduler`, `deviceMemory`, `performance.memory` — in the page and, rewriting
the scripts as they are served, in the workers), so a missing fallback shows here first.

**R1, first run** (WebKitGTK 2.50.4, macOS 26 / Safari 27.2): everything passed but the PDF's text layer and
PDF → Word. Both stopped at `PDFPageProxy.getTextContent`, which in pdf.js 6 is `for await (… of readableStream)`;
WebKit cannot iterate a `ReadableStream` («undefined is not a function (near '...i of e...')», four times). The
converter in fact failed at once («Conversion failed — …» in its sheet), but the test's wait took the thrown message
for «not yet» and waited out its 180 s. Fixed: `scripts/pdfjs-stream-iter.js`, put first in pdf.js's main build and its
worker by `scripts/patch-pdfjs.mjs`, defines `ReadableStream.prototype[Symbol.asyncIterator]` / `values` only where
missing; the test's waits end on a failure the page states (`fatal`). Reproduced and checked in Chromium with
`--webkit`.
