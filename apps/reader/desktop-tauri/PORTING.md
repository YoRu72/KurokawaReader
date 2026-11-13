# Porting the Reader's desktop shell to Tauri v2

The Electron shell (`../desktop/`) keeps shipping; this Tauri shell grows beside it, stage by stage
(`docs/RUST-PORT-READER.md`), until it has every function below, then replaces it. This is **stage R0**: the shared
crate, the Tauri project, the interface opening in it, and the bridge's round trips proven by a self-test in CI.

## How it works

- `src-tauri/src/main.rs` opens the window — made in Rust (`app.windows` is empty in `tauri.conf.json`) so it can carry
  the initialization script — on the same built web app (`../dist`, from `node scripts/build.mjs`). The window is
  `desktop/main.cjs`'s: titled KurokawaReader, 1180×820 or as it was left, at least 420×600; Tauri's own drag-and-drop
  handling is off so the page gets the HTML drop events it imports books with.
- `bridge.js` runs before the page's own scripts on every load, after a line that sets `window.__KR_BOOT__ = { os,
  arch }`, and defines the same `window.kurokawaDesktop` the Electron preload does: **all 48 names** (47 functions and
  `platform`). Each Electron channel `kr:a-b` is the Tauri command `kr_a_b` (`src-tauri/src/commands.rs`); arguments
  are sent under one-word keys (`p`, `o`, `text`, `b64`, `append`, `exts`), so Tauri's camelCase mapping never matters.
- The commands are thin wrappers over **kurokawa-shell** (`shared/shell-rs`), the Rust both apps' shells share (see
  below). Only `scan.rs` (the whole-computer scan, std only) is the Reader's own.
- What is not ported yet is a **stub** in `bridge.js` (its `STUBS` table): it never reaches Rust, and answers as
  Electron itself answers when it cannot do the thing (`false`, `null`, `'unsupported'`, `{ cleared: 0 }`…), or —
  where Electron has no such answer — rejects with `Error('<name> is not in this preview build yet (Tauri stage
  Rn)')`. The table below says how the page copes with each. `window.__KR_BRIDGE_STUBS__` lists them with their stage.
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

What differs from Electron in this stage, on purpose: the system's own window frame (the app's title bar is R5;
`titleBar` answers `null`, so the page removes its bar), no application menu (R5; the page's own keyboard shortcuts
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

**Done in R0: 12** (+ `platform`) · **stubs: 35** (R2: 2, R3: 6, R4: 4, R5: 19, R6: 4).

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
| `appIcon(o)` | `kr:appIcon`: the user's own icon on window, taskbar, shortcuts | stub: asked → `null`; set → rejects | Settings shows the icon option; «none chosen»; setting one shows the error toast | R5 |
| `titleBar(o)` | `app:titleBar`: the app's own bar's colours, `{platform, height, …}` | stub: `null` | the page removes its bar: the system frame is used | R5 |
| `onTitleBarState(cb)` | `app:titleBarState` events | stub: a remover, never called | (no bar) | R5 |
| `setZoom(f)` | `webFrame.setZoomFactor` | stub: nothing | the interface stays at 100% (Appearance → size has no effect) | R5 |
| `onOpenFile(cb)` | `kr:open-file` events (double-click, open-with, second instance) + `kr:ready` | stub: nothing | files are added from inside the app only | R2 |
| `installUpdate(url, o)` | `kr:install-update`: download, then install / swap | stub: rejects | the update sheet shows its error | R6 |
| `downloadUpdate(o)` | `kr:update-download`: electron-updater in the background | stub: `'unsupported'` | the page falls back to its own check and shows the update sheet | R6 |
| `installDownloadedUpdate()` | `kr:update-install` | stub: `false` | (never offered: nothing is downloaded) | R6 |
| `onUpdateProgress(cb)` | `kr:update-progress` events | stub: nothing | | R6 |
| `archiveList(o)` | `kr:archive-list` (7-Zip) | stub: rejects | the Archives button shows (the page asks for `archiveList`); opening one shows its error | R5 |
| `archiveExtract(o)` | `kr:archive-extract` | stub: rejects | as above | R5 |
| `archiveCancel(id)` | `kr:archive-cancel` | stub: `undefined` | | R5 |
| `archiveCreate(o)` | `kr:archive-create` | stub: rejects | «Create zip» shows its error | R5 |
| `archiveTest(o)` | `kr:archive-test` | stub: rejects | as above | R5 |
| `archiveRestore(o)` | `kr:archive-restore` | stub: rejects | as above | R5 |
| `archiveFree(o)` | `kr:archive-free` | stub: rejects | as above | R5 |
| `archiveExisting(o)` | `kr:archive-existing` | stub: rejects | as above | R5 |
| `onArchiveProgress(cb)` | `kr:archive-progress` events | stub: a remover | | R5 |
| `setFullscreen(v)` | `kr:fullscreen`: the window full screen → new state | stub: `false` | F11 / the reader's full-screen button do nothing (the page does not fall back while the function is there) | R5 |
| `setImmersive(on)` | `kr:immersive` | stub: `false` | the reader's immersive mode hides the app's bars only | R5 |
| `copyImage(b64)` | `kr:copy-image`: image to the clipboard | stub: `false` | the page falls back to `navigator.clipboard.write` | R5 |
| `printToPdf(html, o)` | `kr:print-pdf`: a hidden window prints a text PDF | stub: rejects | the converter's PDF output fails with its error (the page does not fall back to its picture PDF while the function is there) | R5 |
| `setDoh(provider, test)` | `kr:set-doh`: Chromium's secure DNS | stub: asked → `{provider:'off'}`; test → `{ok:false, error}`; set → rejects | Settings shows DNS-over-HTTPS; «Test» says it failed and why; choosing a resolver does nothing | R3 |
| `openWebView(o)` | `kr:open-webview`: a site's check passed in the app's browser window | stub: `{passed:false, blocked:false, title:''}` | a site behind a check reports the check as not passed; «Open the browser» does nothing | R4 |
| `browserFetch(o)` | `kr:browser-fetch`: a request from the site's own page | stub: rejects | the sources' request goes the plain way (`http`) | R4 |
| `browserReset(url)` | `kr:browser-reset` | stub: `true` | | R4 |
| `browserForget(url, all)` | `kr:browser-forget` | stub: `{cleared:0}` | «Forget all sites» says 0 | R4 |
| `notify(o)` | `kr:notify`: a system notification | stub: `false` | no notification for new chapters | R3 |
| `download(url, name, id)` | `kr:download`: into the app's data folder (aria2c or ranges), progress events | stub: rejects | the downloads list falls back to the sources' own request in one piece; OPDS «Get» and starter decks show the error | R3 |
| `deleteDownload(p)` | `kr:delete-download` | stub: `false` | | R3 |
| `onDownloadProgress(cb)` | `kr:download-progress` events | stub: nothing | | R3 |
| `addDownloadListener(cb)` | `kr:download-progress` events, per caller | stub: a remover | | R3 |
| `onOpenUrl(cb)` | `kurokawareader://` links (cloud-sync sign-in) | stub: nothing | sign-ins that come back by such a link do not finish | R2 |
| `onCommand(cb)` | the application menu's commands | stub: nothing | (no menu; the keyboard shortcuts are the page's own) | R5 |
| `setProgress(p)` | `kr:progress`: taskbar progress, no background throttling | stub: nothing | no taskbar progress | R5 |

Where a present stub hides a fallback the page would take if the function were missing (`printToPdf`: the picture PDF;
`setFullscreen`: the HTML full screen; `download` for OPDS: the plain request), the stub could be left out of the bridge
instead — a decision for the stage that ports it, or now if the preview should degrade more gently.
