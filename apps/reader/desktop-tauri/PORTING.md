# Porting the Reader's desktop shell to Tauri v2

The Electron shell (`../desktop/`) keeps shipping; this Tauri shell grows beside it, stage by stage
(`docs/RUST-PORT-READER.md`), until it has every function below, then replaces it. **Stage R0**: the shared crate, the
Tauri project, the interface opening in it, and the bridge's round trips proven by a self-test in CI. **Stage R1**: the
engine test — the web app's key cases run in each system's own web view in CI (see «Engine test» below). **Stage R2**:
files and library — files opened from outside, single instance, file associations, drag and drop, folders by path (see
«Files and library» below). **Stage R3**: network — downloads with progress, cookies, DNS over HTTPS, notifications (see
«Network» below). **Stage R4**: the in-app browser the sources use — a site's check passed, a site opened for the
reader, requests made by the site's own page, its sign-ins forgotten (see «The in-app browser» below). **Stage R5**:
archives through the app's own ZIP and tar readers and the 7-Zip program shipped with it, full screen, the interface's
size, taskbar progress, an image on the clipboard, a Mac's menu bar, and the user's own app icon put on everything the
system lets the app change (see «Archives, the window, the app's icon» below); the converter's PDF stays the page's
picture PDF (no silent PDF printing here). Since R5 only R6's functions (the updater) are not real.

## How it works

- `src-tauri/src/main.rs` opens the window — made in Rust (`app.windows` is empty in `tauri.conf.json`) so it can carry
  the initialization script — on the same built web app (`../dist`, from `node scripts/build.mjs`). The window is
  `desktop/main.cjs`'s: titled KurokawaReader, 1180×820 or as it was left, at least 420×600; Tauri's own drag-and-drop
  handling is off so the page gets the HTML drop events it imports books with. The window-state file always holds a
  size: a window that is maximized before any size was saved (macOS calls a window maximized when its default size
  fills a small screen) saves the size it has, as Electron always saves its normal bounds.
- `bridge.js` runs before the page's own scripts on every load, after a line that sets `window.__KR_BOOT__ = { os,
  arch }`, and defines the same `window.kurokawaDesktop` the Electron preload does: **all 48 names** (47 functions and
  `platform`) — except the 3 **left out** (below: R6's two, and `printToPdf`, whose page fallback is this shell's
  answer) —, and four of its own (`scanFolder`, R2; `cancelDownload`, R3; `menuText`, R5; `printFile`, R5, a Mac and
  Linux only: its `EXTRA`, `window.__KR_BRIDGE_EXTRA__`). Each Electron channel `kr:a-b` is the Tauri
  command `kr_a_b` (`src-tauri/src/commands.rs`); arguments
  are sent under one-word keys (`p`, `o`, `text`, `b64`, `append`, `exts`, `url`, `name`, `id`, `provider`, `test`),
  so Tauri's camelCase mapping never matters.
- The commands are thin wrappers over **kurokawa-shell** (`shared/shell-rs`), the Rust both apps' shells share (see
  below). Only `scan.rs` (the whole-computer scan, std only) is the Reader's own — and, since R4, the in-app browser
  (`browser.rs`, `browserlogic.rs`).
- **Only the main window calls the app's commands** (R4): `main.rs` wraps `generate_handler!` in `main_only`, which
  refuses every command from a window whose label is not `main` — except `kr_browser_deliver` from a window of the
  in-app browser (`krb-…`), which takes an answer for that window only. The plugins' commands are refused there by
  Tauri itself (`capabilities/default.json` names the main window). A site's page in the in-app browser therefore gets
  nothing of the app (the self-test proves it).
- What is not ported yet is a **stub** in `bridge.js` (its `STUBS` table): it never reaches Rust, and answers as
  Electron itself answers when it cannot do the thing (`false`, `null`, `'unsupported'`, `{ cleared: 0 }`…), or —
  where Electron has no such answer — rejects with `Error('<name> is not in this preview build yet (Tauri stage
  Rn)')`. The table below says how the page copes with each. `window.__KR_BRIDGE_STUBS__` lists them with their stage.
- R0 found that a stub being **present** makes the page skip a fallback that works. So a name the page tests for before
  it uses it is **left out** of `window.kurokawaDesktop` until its stage — or for good, `'fallback'`, where the page's
  own way is this shell's answer (`printToPdf`) — (`bridge.js`'s `LEFT_OUT`,
  `window.__KR_BRIDGE_LEFT_OUT__`): the page then takes its own way, and shows no control that cannot work. A name the
  page calls without a test (`onOpenFile`), or whose stub answers better than its absence (`installUpdate`: «not in
  this preview build yet» rather than «desktop»), stays a stub.
- `kr:http` (web requests without the page's cross-site limits) is the shared `net.rs` (reqwest, rustls, gzip /
  brotli / deflate); the bridge always asks for the body as base64 and makes it text itself, in the page's charset —
  the Content-Type's, else a `<meta>` in the first 2048 bytes, else UTF-8 — with `TextDecoder`, exactly as
  `main.cjs`'s `decodeText` does (an older Arabic site in windows-1256 reads right). `accept-encoding` is dropped
  from the page's headers, as `main.cjs` drops it. The user agent of requests that do not set their own is a plain
  Chrome's (as Electron's, with its tokens taken out); the sources send the page's own. Since R3 the requests keep
  cookies, may go through a DNS-over-HTTPS resolver and take the system's proxy — see «Network».
- Version: `tauri.conf.json` has `"version": "../../package.json"`, so the app's version is `apps/reader/package.json`'s.
  Product name `KurokawaReader`, identifier `app.kurokawa.reader` — the Electron build's own (as Tools' Tauri shell
  reuses its Electron ids). The program is `KurokawaReader` too (`Cargo.toml`'s package name, since R2; it was
  `kurokawa-reader`): a Mac shows the program's name in the menu bar when it runs outside its bundle (as CI runs it),
  and keys the web view's data by it there — `~/Library/WebKit/KurokawaReader/WebsiteData/` (was
  `…/kurokawa-reader/…`); inside the .app the bundle's name and identifier are used (`~/Library/WebKit/app.kurokawa.reader/`
  expected; the engine test lists both). Windows (`%LOCALAPPDATA%\app.kurokawa.reader\EBWebView`) and Linux
  (`~/.local/share/app.kurokawa.reader`) key it by the identifier: unchanged. Nothing was released with the old name.
- Icons: not committed; CI runs `npx @tauri-apps/cli icon ../desktop/icon.png` first (it writes `src-tauri/icons/`).
  Do the same once before a local `tauri build` / `tauri dev`.
- `samples/alice-in-wonderland.epub` is taken out of `dist/` before the build in CI, as the Electron build leaves it out
  (the app fetches it from the web app when asked).

What differs from Electron in this stage, on purpose: the window's title bar is drawn whole by the page — its buttons
too — instead of Electron's strip under the system's buttons (see «The window's title bar» below), a menu bar on a Mac only (R5; on Windows and Linux the page's own keyboard shortcuts and buttons, as
Electron's menu was hidden there), the in-app browser's cookies reaching `http` only where this build can read them (see «The in-app browser»),
and the page's origin is Tauri's
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
| `net.rs` | `http`, the update check | user agent set by the app (`configure`); the update check split into `check_update_at(url, prefix, current, prereleases)` and a pure `pick_release`; Tools' `check_update(current)` kept, same behaviour. R3: a cookie jar (`configure_cookies`, `forget_cookies`), DNS over HTTPS (`set_doh`, `doh_lookup`, `doh_try`; a second client with reqwest's resolver hook), `client()` public; reqwest features `cookies`, `macos-system-configuration`; `pub use reqwest` in `lib.rs`. R4: `put_cookie` (a cookie of the in-app browser put in the jar), `forget_picked_cookies` |
| `cookiejar.rs` | the cookies of the apps' own requests (std only) | new (R3); R4: `forget_picked` (a site's, or every site's, cookies of the names asked for) |
| `doh.rs` | DNS over HTTPS: providers, RFC 8484 / 1035 wire format, a cache (std only) | new (R3) |
| `winstate.rs` | window size/place kept between runs | default and smallest sizes given by the app (`Defaults`; were Tools' 1100×780 / 420×560); `save`, `file`, `parse` public |
| `shell.rs` | system folders, file dialogs, clipboard, opening a path / an address, a file's bytes for the IPC | new file, bodies moved unchanged from Tools' `commands.rs`; added `set_clipboard_text` |
| `selftest.rs` | the self-tests' frame: `<PREFIX>_SELFTEST`, watchdog, verdict, results file | the app-neutral half of Tools' `selftest.rs`; prefix and exit hook given by the app |
| `testserver.rs` | loopback test server (std only) | added `/latin`, `/meta`, `/releases`; R3: `/cookie/set`, `/cookie/hop`, `/cookie/echo`, `/chain/<n>`, `/headers`, `/large/<name>` (3 MiB), `POST /dns-query` (a resolver: `kr-doh-selftest.test` → 127.0.0.1), `/dns-count`; R4: a small site — `/site/` (sets a session cookie, HttpOnly, and a clearance), `/site/private` (signed in only), `/site/file.epub` (a download), `/site/popup`, `/site/token` (→ `/site/landing#access_token=…`), `/site/landing`, `/site/check` (a check that stays) |

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
(windows-1256 Arabic), 404; (R3) cookies set → sent back (path kept, one set on a redirect), a 12-hop redirect chain,
Referer / Origin / User-Agent / Cookie sent as the page gives them and a plain Chrome's user agent otherwise, a download
with progress (2 MiB: whole file by CRC, the name made safe, `deleteDownload` only inside the folder), one in parts
(3 MiB, several connections), one cancelled by its id, one of a missing file (HTTP 404), DNS over HTTPS through the
test server's resolver (a made-up name reached, the resolver asked, the try of an unknown name answered `ok: false`,
then off again; that the name is unknown without it: reported), `notify` answering (reported); the update check against a canned releases list (stable 0.62.0 with this OS's asset, beta
0.63.0, nothing after 0.62.0); window state saved and read back as the next start would; (R4) the in-app browser on
the test server's small site (see «The in-app browser»); (R5) archives, the window's parts and the app's icon (see
«Archives, the window, the app's icon»); the clipboard round trip (not required); every stub answers as
documented. Results go to `kr_selftest_done`, which writes them and exits 0/1; a
watchdog exits 2 after `KR_SELFTEST_TIMEOUT` (330 in CI since R5) seconds. `.github/workflows/tauri-check-reader.yml` runs it
on Linux under Xvfb and on Windows (both required), and on macOS (reported only). `selftest-report.cjs` prints the
results as a table. Not tested by the self-test: the file dialogs (they wait for a person) and `openDefaultApps` (it
opens the system's settings).

`tests/tauribridge.cjs` keeps the bridge, the preload, the Rust command list and the self-test script in step (plain
node; `--node-only` in CI), and loads the built app in Chromium with the bridge and a fake Tauri IPC: the library
renders with the computer's sidebar, a book opens in the reader, Settings open, no page errors, and each ported function
sends the right command and arguments from the page.

## The 47 functions (and `platform`)

`docs/RUST-PORT-READER.md` says 38; `desktop/preload.cjs` today gives 47 functions and `platform`. All are here.

**Done: 42** (R0: 12, the title bar: 2, R2: 2, R3: 6, R4: 4, R5: 16; + `platform`) · **stubs: 2** (R6) · **left out:
3** (R6: 2; `printToPdf`: the page's picture PDF, for good) · **extra: 4** (`scanFolder`, R2; `cancelDownload`, R3;
`menuText`, `printFile` — a Mac and Linux —, R5).

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
| `http(o)` | `kr:http`: request without cross-site limits, session cookies, text in the page's charset | **done** `kr_http`; R3: cookies kept, DoH, the system's proxy | | |
| `isPortable()` | `kr:is-portable` | **done**: `false` (this build is never Electron's portable .exe) | | |
| `appIcon(o)` | `kr:appIcon`: the user's own icon on window, taskbar, shortcuts | **done** (R5) `kr_app_icon` (`appicon.rs`, `iconlogic.rs`; see below) | | |
| `titleBar(o)` | `app:titleBar`: the app's own bar's colours, `{platform, height, …}` | **done** `kr_title_bar` (`titlebar.rs`): `o.own` asks for the app's own bar or the system's frame, `o.act` works the window (`minimize`, `maximize` = maximise / restore, `close`, `drag`) → `{platform, height, own, wanted, controls, maximized, fullscreen, focused}` — a different protocol from Electron's (see below) | | |
| `onTitleBarState(cb)` | `app:titleBarState` events | **done**: the `kr:titleBarState` Tauri event (the state above, on each change) | | |
| `setZoom(f)` | `webFrame.setZoomFactor` | **done** (R5) `kr_set_zoom`: the web view's `set_zoom`, else the page's CSS zoom | | |
| `onOpenFile(cb)` | `kr:open-file` events (double-click, open-with, second instance) + `kr:ready` | **done** (R2) `kr_open_take` + `kr_read_file`, the `kr:openPending` event (`openfile.rs`) | | |
| `installUpdate(url, o)` | `kr:install-update`: download, then install / swap | stub: rejects | the update sheet shows its error | R6 |
| `downloadUpdate(o)` | `kr:update-download`: electron-updater in the background | **left out** | no «download in the background» switch; the page's own check and update sheet | R6 |
| `installDownloadedUpdate()` | `kr:update-install` | **left out** | (never offered: nothing is downloaded) | R6 |
| `onUpdateProgress(cb)` | `kr:update-progress` events | stub: nothing | | R6 |
| `archiveList(o)` | `kr:archive-list` (its own ZIP and tar readers; 7-Zip for the rest) | **done** (R5) `kr_archive_list` (`archives.rs`, `archive.rs`) | | |
| `archiveExtract(o)` | `kr:archive-extract` | **done** (R5) `kr_archive_extract` (`archives.rs`, `archive.rs`) | | |
| `archiveCancel(id)` | `kr:archive-cancel` | **done** (R5) `kr_archive_cancel` (`archives.rs`, `archive.rs`) | | |
| `archiveCreate(o)` | `kr:archive-create` | **done** (R5) `kr_archive_create` (`archives.rs`, `archive.rs`) | | |
| `archiveTest(o)` | `kr:archive-test` | **done** (R5) `kr_archive_test` (`archives.rs`, `archive.rs`) | | |
| `archiveRestore(o)` | `kr:archive-restore` | **done** (R5) `kr_archive_restore` (`archives.rs`, `archive.rs`) | | |
| `archiveFree(o)` | `kr:archive-free` | **done** (R5) `kr_archive_free` (`archives.rs`, `archive.rs`) | | |
| `archiveExisting(o)` | `kr:archive-existing` | **done** (R5) `kr_archive_existing` (`archives.rs`, `archive.rs`) | | |
| `onArchiveProgress(cb)` | `kr:archive-progress` events | **done** (R5): the `kr:archive-progress` Tauri event | | |
| `setFullscreen(v)` | `kr:fullscreen`: the window full screen → new state | **done** (R5) `kr_fullscreen` (`winbits.rs`) | | |
| `setImmersive(on)` | `kr:immersive` | **done** (R5) `kr_immersive`: the window full screen → true | | |
| `copyImage(b64)` | `kr:copy-image`: image to the clipboard | **done** (R5) `kr_copy_image` (the clipboard plugin's `write_image`; any picture made a PNG by the bridge first) | | |
| `printToPdf(html, o)` | `kr:print-pdf`: a hidden window prints a text PDF | **left out for good** (`'fallback'`) | the converter's PDF output is the picture PDF (searchable text over page pictures), as on the web — see below | — |
| `setDoh(provider, test)` | `kr:set-doh`: Chromium's secure DNS | **done** (R3) `kr_set_doh`: DoH for the app's own requests (see «Network») | | |
| `openWebView(o)` | `kr:open-webview`: a site's check passed in the app's browser window | **done** (R4) `kr_open_webview` (`browser.rs`) | | |
| `browserFetch(o)` | `kr:browser-fetch`: a request from the site's own page | **done** (R4) `kr_browser_fetch` | | |
| `browserReset(url)` | `kr:browser-reset` | **done** (R4) `kr_browser_reset` | | |
| `browserForget(url, all)` | `kr:browser-forget` | **done** (R4) `kr_browser_forget`; `all` = every site (see below) | | |
| `notify(o)` | `kr:notify`: a system notification | **done** (R3) `kr_notify` (the notification plugin; no click action) | | |
| `download(url, name, id)` | `kr:download`: into the app's data folder (aria2c or ranges), progress events | **done** (R3) `kr_download` (`download.rs`: ranges, as main.cjs's built-in downloader) | | |
| `deleteDownload(p)` | `kr:delete-download` | **done** (R3) `kr_delete_download` | | |
| `onDownloadProgress(cb)` | `kr:download-progress` events | **done** (R3): the `kr:download-progress` Tauri event | | |
| `addDownloadListener(cb)` | `kr:download-progress` events, per caller | **done** (R3): the same event | | |
| `onOpenUrl(cb)` | `kurokawareader://` links (cloud-sync sign-in) | **done** (R2) `kr_open_take`, the `kr:openPending` event; the scheme registered by the installers (see below) | | |
| `scanFolder(root, exts)` | — (Electron: the web view's folder picker) | **extra** (R2) `kr_scan_folder` | | |
| `cancelDownload(id)` | — (Electron's downloads cannot be stopped) | **extra** (R3) `kr_download_cancel` | | |
| `onCommand(cb)` | the application menu's commands | **done** (R5): the `kr:command` Tauri event — a Mac's menu bar (`menu.rs`) | | |
| `setProgress(p)` | `kr:progress`: taskbar progress, no background throttling | **done** (R5) `kr_progress`: `set_progress_bar` (no throttling switch in a Tauri web view) | | |
| `menuText(labels)` | — | **extra** (R5) `kr_menu`: a Mac's menu bar in the interface's words | | |
| `printFile(b64, name)` | — (Electron prints in its PDF viewer's frame) | **extra** (R5, a Mac and Linux) `kr_print_file`: the system's PDF program opens it to print | | |

Kept as stubs on purpose: `installUpdate` / `onUpdateProgress` (R6).

## Files and library (stage R2)

- **Opened from outside** (`openfile.rs`, `openargs.rs`; `main.cjs`'s `queueFile` / `handleUrl` / `kr:ready`): what a
  launch carries is sorted as `main.cjs` sorts it — `kurokawareader:` links for `onOpenUrl`; files with one of its
  `DOC_EXT` extensions that are there for `onOpenFile` (relative paths from the launch's folder; switches, missing
  files and other kinds left alone; `file://` addresses made paths) — and kept in the shell until the page takes them.
  Sources: this launch's command line (Windows and Linux double-click / «Open with», a file given in a terminal — read
  in `setup`, after the window is made), a second launch's (below), and a Mac's Apple Events (`RunEvent::Opened`, at a
  cold start too: `main.rs` now builds the app and runs it with an event handler). The bridge's `onOpenFile(cb)` /
  `onOpenUrl(cb)` take what is kept (`kr_open_take { kind: 'file' | 'url' }`) when the page sets them up — so a file
  that came before the page was ready waits, as `main.cjs`'s `pending` until `kr:ready` — and again on each
  `kr:openPending` event; a file is `{ name, path }`, its bytes read by path (`kr_read_file`) and handed to the page as
  `main.cjs` hands them, `{ name, data: ArrayBuffer }` (`src/native.ts` then imports it and opens it in the reader).
  Each one handed over is noted in `window.__KR_OPEN_LOG__` (for the self-test).
- **Single instance**: `tauri-plugin-single-instance` (the official plugin, `"2"`, a new dependency — registered first, as
  its documentation asks): a second launch hands its arguments to the running window (restored, shown, focused) and
  ends. On Linux it needs a D-Bus session bus; without one (a bare X server, CI's runner unless the workflow starts one)
  it is not registered and each launch is its own window, as before (`openfile::single_instance_possible`).
- **File associations**: `tauri.conf.json` `bundle.fileAssociations` — Electron's list (`desktop/package.json`
  `build.fileAssociations`: epub, pdf, docx, xlsx, pptx, txt, md, fb2, cbz, otf, ttf, odt; names, role Viewer, the two
  MIME types), written by the installers (NSIS / .deb / the .app's Info.plist). The `kurokawareader://` scheme:
  `plugins.deep-link.desktop.schemes` in `tauri.conf.json` — config only, read by Tauri's bundler for the installers'
  registrations (the deep-link plugin crate itself is not used: the links come as launch arguments / Apple Events, which
  `openfile.rs` already handles). The bare program and the AppImage register nothing (Electron registers the scheme
  itself at start: `setAsDefaultProtocolClient`; not ported). `openDefaultApps` opens the system's default-apps page.
- **Drag and drop**: Tauri's own handler is off on the window (`disable_drag_drop_handler`, since R0), so the page gets
  the HTML drop events it already imports books with — files dropped from the system included, as in Electron
  (engine test case 8 simulates one; a real drop needs a person).
- **Folders by path**: reading and writing go through the app's own commands (`std::fs`, as the user who runs the app):
  no Tauri scope or capability is involved, so any folder works — another drive, outside the home folder. Linked books
  (from the whole-computer scan, or moved out to a folder with `pickFolder` + `writeBinary`) are read by `readFile(path)`
  (`src/db.ts`). The scan sheet's «Choose folder» uses the bridge's own `scanFolder` where it is (this shell): the
  folder dialog, then the scan's walk of that folder by path (`kr_scan_folder`, `scan.rs`), so its books can be linked
  where they are — on every system (WebKit has no `showDirectoryPicker`, which Electron's «Choose folder» uses; its books
  there are copied in, unchanged).
- Tests: `tests/tauribridge.cjs` (the take-and-read protocol, the event, a file handed over opened in the reader in
  Chromium, «Choose folder» → `kr_folder_pick` + `kr_scan_folder`, the single-instance registration, Electron's file
  associations and `DOC_EXT` kept equal), `openargs.rs`'s std-only unit tests (CI), `selftest.js` in CI: a file given on
  the command line reaches the page (on Windows from `D:`), a folder made outside the home folder walked and read by
  path, and a second launch with a file and a link hands both over and ends — required on Windows, reported on Linux
  (under `dbus-run-session`) and macOS.

## Network (stage R3)

- **Downloads** (`src-tauri/src/download.rs`, `dlplan.rs`; `main.cjs`'s `kr:download` / `downloadSegmented` /
  `kr:delete-download`): into `<app data>/downloads/` (Electron: `<userData>/downloads/`), under the name the page
  gives made safe — `main.cjs`'s `[\/:*?"<>|]` → `_`, and here also control characters; «», «.», «..» → `download`;
  over 200 bytes cut with the extension kept. A first request asks for one byte: a file over 2 MiB whose server answers
  ranges is fetched in parts (up to 8 connections, parts of 1–8 MiB, each tried again up to 5 times — the address the
  redirects led to, then the one given), any other in one stream (from that first answer when the server ignored the
  range). Progress: the `kr:download-progress` event, `{ id, pct, got, total, speed, connections }`, at most every
  400 ms, and once at the end (100 %). Result: the file's path; errors as `main.cjs`'s (`HTTP 404`…). The requests are
  `net.rs`'s: the app's cookies, user agent, DoH. Differences: aria2c (which `main.cjs` prefers when it is installed)
  is not used — the same file comes; a download can be **cancelled** — `cancelDownload(id)`, an extra of this shell
  that `src/downloads.ts` uses where it is (Electron's downloads run on) — and it then rejects with `cancelled`; what
  was written of a download that failed or was cancelled is removed. No resume (Electron has none). `deleteDownload(p)`
  removes a file only inside that folder («..» worked out first) → true, else false. The page's callers: the downloads
  list (`downloads.ts`, with ids, `addDownloadListener`), OPDS «Get» (`opds.ts`, `onDownloadProgress`), the starter
  decks (`decks.ts`, which calls `download` without a test — it works now).
- **Cookies** (`shared/shell-rs/src/cookiejar.rs` behind reqwest's `CookieStore` hook): what a site sets is sent back
  (domain, host-only, path, Secure, Max-Age / Expires, deletion; also on each hop of a redirect), as `main.cjs`'s
  `useSessionCookies`. Cookies with an expiry are kept between runs in `<app data>/cookies.txt` (Chromium keeps the
  session's on disk too); the others until the app ends. A `Cookie` header the page sets itself goes as given (reqwest
  adds the jar's only when there is none). `set-cookie` is shown to the page in the response's headers (`ranobe.ts`
  reads it). Since R4 the in-app browser's cookies are put in this jar where the build can read them (see «The in-app
  browser»).
- **Headers**: any header the page gives is sent — Referer, Origin, User-Agent, Cookie (a browser forbids those) —;
  redirects followed up to 20; no time limit (Electron's has none); bodies of any size, binary as base64; charsets as
  before.
- **Proxy**: the system's, as reqwest finds it — the proxy environment variables everywhere, Windows' Internet
  settings, a Mac's system settings (reqwest's `macos-system-configuration` feature, which `default-features = false`
  had taken away). Linux desktop proxy settings (GNOME's) are not read — Chromium reads them. **TLS**: rustls with its
  own root certificates (as before), not the system's store.
- **DNS over HTTPS** (`doh.rs`, `net.rs`). Electron sets Chromium's own secure DNS — for the page, its browser and its
  downloads. This shell cannot give the web view (WebView2, WKWebView, WebKitGTK) a resolver, so its scope is **the
  app's own requests**: `http` (the sources, the catalogues), downloads, the update check. Pictures inside web pages
  and (R4) the in-app browser keep the system's DNS; Settings says so in this shell (`dohHintApp`, five languages).
  The choices are Electron's: off, Cloudflare, Google, Quad9, AdGuard, or an `https://` address (here also an
  `http://` one on this computer — a local resolver, and the self-test's). With one chosen, a client with reqwest's
  resolver hook asks it — RFC 8484 POST, `application/dns-message`, A and AAAA at once, answers kept for their time to
  live (30 s – 1 h) —; strictly, as Electron's `secureDnsMode: 'secure'`: no falling back to the system's DNS when it
  fails. The resolver's own name is found by the system (a separate plain client), as Chromium does. «Off» is the
  untouched client (Electron's «automatic»). Kept in `<config>/doh.json` and applied at each start (`main.rs`), as
  `main.cjs`'s `doh.json`. `setDoh(null, host)` tries `https://host/` (HEAD, 12 s) with the answers forgotten first →
  `{ provider, ok, status, ms }` / `{ provider, ok: false, error }`. Behind a proxy the proxy finds the sites. Settings
  shows the choice in this shell though there is no in-app browser yet (`views/settings.ts`: the DoH section no longer
  waits for one; every other shell that has DoH — Electron, Android — has a browser, so nothing changes there).
- **Notifications**: `tauri-plugin-notification` (the official plugin, `"2"`, registered in `main.rs`; called from Rust
  only, so no permission is granted to the page — `capabilities/default.json` unchanged) → true when shown. Chosen over
  the web's `Notification` API, which WKWebView in an app does not have and WebKitGTK / WebView2 gate behind
  permission requests the shell would have to answer. Differences: a click on the notification does not open the app at
  `o.hash` (the plugin gives no click on a computer, so there is nothing for `onCommand` to carry); `silent`
  is not passed (the caller never sets it).
- **Antivirus scan of a download**: the Reader's Electron shell has none (no `MpCmdRun` or the like in `main.cjs` or
  its other files; the plan's list named it by mistake) — nothing to port.
- **Not done here, said plainly**: the PDF converter's lanes on Windows still give up at once (a worker started from a
  worker fails in WebView2 under `http://tauri.localhost`) and convert on one thread. Starting each lane's pdf.js
  worker from the page instead needs the page to relay every message between the lane and that worker (pdf.js's
  worker listens on its own global scope, not on a port it is handed), with transfer lists the relay cannot know —
  not small, not safe; left as it is.
- Tests: std-only unit tests (CI) of `cookiejar.rs`, `doh.rs`, `dlplan.rs` and the test server's new routes;
  `tests/tauribridge.cjs` (the six functions' commands and arguments, the progress listeners' Electron rules, the extra
  `cancelDownload`, the DoH section in Settings with this shell's hint); `selftest.js` in CI (above).

## The in-app browser (stage R4)

`src-tauri/src/browser.rs` (windows, commands), `browserlogic.rs` (std only: origins, when a page counts as passed, the
channel's messages, `until`, clearance names, a download's place), `apidetect.rs` + `build.rs` (which of Tauri's newer
web-view functions the resolved Tauri has).

**What Electron's does** (`main.cjs`; the callers: `src/sources/http.ts`, `views/sources.ts`, `views/settings.ts`,
`ui/anilistlink.ts`, `sources/linkopen.ts`, `sources/ranobe.ts`): windows sharing the app's one session (cookies, user
agent).
- `openWebView(o)` → `{ passed, blocked, title, url? }`. `{hidden}`: out of sight, 15 s — the site's own scripts run,
  as in any browser (the page's `solveChallenge` tries this first); else a window titled `o.message` the reader acts
  in (5 min); passed once the site shows a page of its own (no check: title / known check elements), blocked on a
  refusal page. `{fresh}` forgets the site's clearance first; `{stay}` keeps the window until the reader closes it
  (`openSite`: sign in, look around); `{until}` (a regular expression) ends it once the address matches and gives the
  address back (AniList's sign-in: `access_token=`); `{browse}`: the browser as a browser (Settings → Open the
  browser; «solve in the browser»): a bar — back, forward, reload, an address or words searched for (DuckDuckGo) —,
  resolves `{passed: true}` when closed. `done` / `reload` / `browserLabel` are not used by Electron's windows.
- `browserFetch(o)` (`{url, method, headers, body, bodyBase64, binary, timeout, page, openTimeout}`) → `{status,
  headers, body, url, via: 'browser'}`: a hidden window per origin opened on `o.page` (or the origin's `/`) and kept
  four minutes; the request is that page's own `fetch` (cookies included, the headers a browser sets itself left
  out); a site whose check does not pass out of sight in `openTimeout` answers 403 with `x-kr-lane: challenge`
  (`cf-mitigated`), a refusal 403 `x-kr-lane: blocked`; a page that will not load throws (the page then goes the plain
  way).
- `browserReset(url)` → `true`: the origin's window set aside (requests under way finish; closed within a minute).
- `browserForget(url, all)` → `{cleared}`: the window set aside and the site's clearance cookies (`cf_clearance`,
  `__cf*`, `cf_chl*`, `__ddg*`) — or with `all` every cookie of that one site — removed.
- New windows a site opens: in the same window (browse mode); downloads: Electron's default (a save dialog).

**What this shell does.** The same functions, the same answers, with these windows (`WebviewWindowBuilder`, an
external address; labels `krb-<kind>-<n>`; never the bridge, never the app's title bar):
- **Profile**: on Windows and Linux the browser's own (`data_directory`: `<app local data>/browser`), apart from the
  library; on a Mac WKWebView's default store, which is the app's too (`data_store_identifier` not used: not sure of it
  in the resolved Tauri) — sites' cookies are per site anyway; nothing ever clears that store whole.
- **Answers from the site's page** (fetch results, the page's state). Rust runs a script in the page (`eval`); the page
  answers by `kr_browser_deliver` — the one command a browser window may call (see «How it works»), for its own window
  and with its random token —, or, where Tauri's IPC does not carry it from a site's page (an `https` site, a strict
  CSP), by asking to go to `https://kr-lane.invalid/<token>/<id>/<part>/<parts>?<base64url>`: the window's navigation
  handler reads and refuses it, so the page stays; one message at a time (96 KiB of body each), each acknowledged; never
  within 8 s of a navigation the site itself started (it would cancel it), and the site's `beforeunload` handlers do
  not run for it. Which way the answers came: the self-test's row says.
- **Checks**: as Electron's — polled every 0.6 s (the same title and element tests), hidden 15 s, visible 5 min, `stay`,
  `until` (tested on each address the window goes to when it is plain text, and by the page's own `RegExp` on its
  address), `fresh`. Nothing is clicked or typed for the reader: a check that wants a person stays in its window until
  they pass it or close it.
- **The bar** (`browse`): Electron's bar is a strip above the page (a second web view); a Tauri window holds one web
  view without the `unstable` feature, so here the bar floats in a corner of the page (the start side; a closed shadow
  root the site's styles and scripts cannot reach): ← → ↻ and the address, in the page's words; Alt+← / Alt+→; the
  window titled with the page's title.
- **New windows** (window.open, links and forms aimed at another window) open in the same window, in every mode.
- **Requests**: a hidden window per origin, kept four minutes, as Electron's; the same `fetch`, the same headers left
  out, the same refusals; cross-origin requests from that page are the page's own (CORS applies, as in Electron); POST
  and binary bodies of any size; several at once; `timeout` (90 s) + 15 s.
- **Cookies shared with the app's own requests** (`http`): Electron has one session. Here the browser's cookies are put
  in the app's jar (`net::put_cookie`) after a check, when a lane opens, and every 5 s while the browser is open as a
  browser — every cookie where Tauri can list them all (`cookies()`), else the site's (`cookies_for_url`); not at all
  where it can do neither (the build's log and the self-test say which).
- **Forget**: the site's clearance deleted in the browser where Tauri can delete a cookie (`delete_cookie`), and in the
  app's jar always. **`all` means every site** (Settings' «Forget all sites' sign-ins», its only caller): every cookie
  deleted where Tauri can list and delete them, and on Windows / Linux the browser's own profile cleared whole
  (`clear_all_browsing_data`); the app's jar emptied; → how many sites. (Electron's `all` clears only the one site
  given — `example.com` from that Settings button.)
- **Downloads** a site offers: into the system's Downloads folder under the name it suggests (never over a file), a
  notification with its name and place — where Tauri's `on_download` is found; else the web view's own way
  (WebView2: its download bar; WKWebView / WebKitGTK: nothing happens).
- **Closing**: the main window closing closes every browser window (they would keep the app running); a window the
  reader closes ends its `openWebView` with what it had seen (polled each 0.6 s).
- **DNS over HTTPS**: not for the browser (the system's DNS, said in Settings: `dohHintApp`, five languages).

**After the first CI run** (tauri 2.12.5, every function found): on Windows a site signed in by one browser window was
signed out to the next — WebView2 ends a profile's browser process when its last window closes, and session cookies
(no expiry) go with it; now a hidden window (`krb-keep-…`, about:blank) keeps the profile open while the app runs, as
Electron's session lives as long as the app. On a Mac the channel's pieces are 24 KiB (a 2 MiB answer by addresses did
not come whole in 75 s with 96 KiB); a timed-out request now says how many of its messages came. A Mac's download
finishes without its path: the path it was sent to is given. A «forget» looks at the browser's cookies again for up to
3 s and counts only those gone (on a Mac the clearance was still listed and still sent after `delete_cookie`); the
self-test says which were left, and, when a signed-in page answers «signed out», which cookies the browser holds for
the site and which its page's request sent. Linux (WebKitGTK) reported a download not saved: the self-test now shows
the path asked for and the web view's answer.

**Which newer Tauri functions** (`apidetect.rs`, run by `build.rs`: the version in `Cargo.lock`, its source in Cargo's
registry, each signature found on both `Webview` and `WebviewWindow`): `cookies_for_url` → `kr_cookie_read`, `cookies`
→ `kr_cookie_all`, `delete_cookie` → `kr_cookie_delete`, `clear_all_browsing_data` → `kr_clear_all`, `on_download` →
`kr_download_api`. Code using one is compiled only when it is found, with the signature written for it; the build's log
says what was found (`warning: … KR build: tauri 2.x.y — yes …; no …`).

**Gaps against Electron**, said plainly: without the cookie functions the app's own requests do not carry what was done
in the browser (a site signed in there is signed out to `http`; the sources still reach it through `browserFetch` once
it has turned them away); without `delete_cookie` a site's clearance cannot be forgotten in the browser alone (only in
the app's jar), and on a Mac `all` then clears nothing in the browser; the bar floats over the page instead of above
it; hidden windows may be slowed by the system (no `backgroundThrottling: false` here); downloads where `on_download`
is missing go the web view's way.

Tests: `browserlogic.rs`, `apidetect.rs` std-only unit tests (CI); `tests/tauribrowser.cjs` — the page's scripts taken
from `browser.rs` and run in Chromium on a local site, by the command and by addresses (204 for the refused
navigation), read back as `browserlogic.rs` reads them (and by `browserlogic.rs` itself through `rustc`): state, the
signed-in page (HttpOnly cookie), binary, POST, 300 KB in pieces, an error, `until`, three at once, new windows kept,
the site's own navigation kept, a check page, the bar, the title; `tests/tauribridge.cjs` (the four functions'
commands and arguments, the body's charset, the guard, the Settings card: «Open the browser» opens it as a browser,
«Forget all sites» forgets every site); `selftest.js` in CI (14 rows, required on Windows): a site opened out of sight
sets its cookies; `browserFetch` of the signed-in page carries them and the browser's user agent; binary, POST, 2 MiB;
the app's requests carry the browser's cookies (reported); the site's page refused the app's commands (two of the
app's, the browser's own, a plugin's, an event); a link aimed at a new window stays (reported); a download saved
(reported); a check window and a sign-in's end close by themselves; a check that stays answers the refusal; reset;
forget (the clearance, then everything); the browser as a browser ends when closed (reported); no window left.

## Archives, the window, the app's icon (stage R5)

**Archives** (`src-tauri/src/archive.rs` — std only, unit-tested by the workflow —, `archives.rs` — the commands).
`desktop/archive.cjs` ported whole, the same approach, the same answers to the same callers (`src/archives.ts`,
`src/ui/archives.ts`): ZIP read by the app's own parser (deflate by `flate2`, pure Rust) — listed, tested by CRC,
extracted, or extracted **in place** the HatchZip way (last entry first, the archive cut after each committed batch of
at most 64 files / 512 MB within the free space less `keepFree`, a journal `<archive>.kurokawa-unzip` beside it so a
stop or a crash resumes, «give up» making what is left a whole ZIP again); tar listed and extracted in place by its own
reader (GNU long names, pax `path`); an `.sfv` beside an archive checked before anything is written; «verify first»;
a zip made by streaming (stored for pictures, video, audio and archives; deflate level 6 otherwise; ZIP64 end
records, data descriptors, UTF-8 names, as Electron's); 7z, rar (as far as 7za reads it — Electron's limit too),
encrypted zips, gz/xz/bz2 and tar.gz/xz/bz2 (two layers: the inner tar into a folder of its own, then its files)
through the **7-Zip program shipped with the app**: 7zip-bin's `7za` (the npm package the Electron build already
ships), bundled as `resources/7zip/<win|mac|linux>/<arch>/7za[.exe]` (`tauri.conf.json` `bundle.resources`; the
workflow installs `desktop/`'s dependencies without its devDependencies and copies this system's `7za` and the
package's licence files into `desktop-tauri/7zip/`; `7zip/README.txt` keeps the folder), found in the resource folder,
then beside the program (a bare build), then on the PATH (`7za`, `7z`, as `archive.cjs` falls back to `7z`). It runs
with `std::process::Command` — no shell, the arguments a list, stdin closed, no console window on Windows,
`-sccUTF-8` on Windows so names that are not ASCII come back right —, its progress lines read (`-bsp1 -bb1`, cut at
returns and backspaces), a listing given up after 10 minutes, any job stopped by `archiveCancel` (the process
killed). Progress: the `kr:archive-progress` event `{ id, done, total, file }`, at most every 250 ms and at the end
(main.cjs's throttle). Errors are `archive.cjs`'s words, which the sheet turns into sentences (`unsafePath …`,
`duplicateEntry …`, `crcMismatch …`, `damaged …`, `sfvMismatch …`, `noSpace`, `notArchive`, `wrongPassword`,
`stopped`); a locked 7z listed without its password answers `passwordNeeded` (Electron passed 7-Zip's «Wrong
password?» either way). Passwords go to 7-Zip as its `-p` switch, as Electron's do, and are never logged or kept.
**Path safety**, better than Electron: an entry is refused when any part of its name would leave the folder — absolute,
a `..` part, a drive or stream (`a:b`), a backslash left in it — checked on the name's parts, before anything is
written (the whole archive is refused at listing, as Electron's); a link in a tar (own reader, or 7-Zip's listing:
`Symbolic Link`, `Hard Link`) that points out of the folder refuses the archive too (Electron let 7-Zip make it); the
inner tar of a tar.gz is checked before it is extracted; `archiveExisting` ignores a name that would leave the folder.
Other differences: the in-place ZIP keeps only the archive's directory beside it (`.kurokawa-tail`, from the
directory's offset, `tailBase` in the journal) where Electron writes a sparse file as long as the archive — which
Windows fills with zeros, the space in-place extraction is for; a journal Electron wrote is still read. A zip's times
are UTC (Electron's local time). Free space: `statvfs` (Unix, `libc`) / `GetDiskFreeSpaceExW` (Windows), as Node's
`statfs`. **Bundle size**: one `7za` per system — about 1.1 MB (Windows x64), 2.5–3 MB (Linux x64), 2.5 MB (macOS
arm64), as 7zip-bin ships them —, and `flate2` adds little (it is in the build through reqwest's gzip already).

**Printing a PDF** (`printToPdf`, `printFile`). Electron lays the converter's HTML out in a hidden window and prints a
text PDF (`webContents.printToPDF`). Tauri has no such function on any system; WebView2 has one (`PrintToPdf`), but it
is reached only through the web view's COM interface (`with_webview` and the webview2-com crate, unsafe COM code and
an asynchronous completion handler) — not written here, as it could not be written with certainty without a Windows
build to try it on. So `printToPdf` stays **left out for good** (`'fallback'`): the converter makes its picture PDF
(searchable text over page pictures), as on the web, on every system. The PDF viewer's **Print** (`src/ui/share.ts`
`printPdf`, a PDF in a frame and the frame's `print()`): on Windows WebView2 prints it as Electron does; a Mac's and
Linux's web views print no PDF in a frame, so there the bridge's `printFile` writes it to the temporary folder and
opens it in the system's PDF program, to print from there.

**Images**: `copyImage(b64)` — the clipboard plugin's `write_image` (a PNG read by Tauri's `image-png` feature); any
other picture (JPEG, WebP…) drawn on the page's canvas and made a PNG first by the bridge; false when it is no picture
(the page then tries the web's clipboard).

**The window** (`winbits.rs`, `menu.rs`): `setFullscreen(v)` / `setImmersive(on)` — the window full screen (the app's
own title bar hides then, told by `titlebar.rs`'s state); `setZoom(f)` — Tauri's `set_zoom` on the web view (0.5–2,
as the preload) where the resolved Tauri has it (`apidetect.rs`: `kr_zoom`), else the page zoomed with CSS (the
bridge); `setProgress(p)` — the taskbar button's progress (`set_progress_bar`, `kr_progress`; Windows' taskbar, a Mac's
Dock, Linux's where the desktop reads Unity's launcher API), taken away below 0 (Electron also lifts the page's
background throttling meanwhile: a Tauri web view has no such switch); `onCommand(cb)` — the `kr:command` event. Only a
Mac gets a **menu bar** (as a Mac app must: without an Edit menu ⌘C / ⌘V do nothing in its web view): the app's menu
(About, Settings… ⌘,, Hide, Hide Others, Show All, Quit), File (Add books…, Scan this computer…, Library, Close
Window), Edit (Undo, Redo, Cut, Copy, Paste, Select All), View (Visual options, Search in book, Full screen), Window
(Minimize, Zoom), Help (Check for updates, Releases on GitHub) — Electron's items, in the interface's language (the
page sends the words with `menuText` at its start and when the language changes; English before that), its own items
sent to the page as `kr:command` (`import`, `scan`, `library`, `settings`, `options`, `search`, `update`), as
`main.cjs`'s `buildMenu` sends them. Windows and Linux have none: the window has the app's own title bar, and
Electron's menu was hidden there (its items are the page's own keys and buttons). No global shortcuts or tray icon:
Electron's Reader has none. A notification's click still does not open the app (the plugin gives none on a computer).

**The app's icon of the user's choosing** (`appicon.rs`, `iconlogic.rs` — std only, unit-tested). Electron
(`desktop/appicon.cjs`): the picture the user crops in Settings (any picture → a 512 px PNG, `src/ui/iconCrop.ts`; no
built-in alternatives, no custom name on a computer — Android's launcher name is its own option) kept as
`<userData>/custom-icon.png`, put on every window and the Dock, and on Windows the desktop, Start-menu and pinned
shortcuts pointed at an `.ico` written beside it; the page shows it in its own logos (`src/ui/brandIcon.ts`). Here:
- **One choice, kept outside the program's folder** (so it outlives updates): `<config>/custom-icon.png` — the
  picture, checked as a PNG (signature, header), at most 4 MiB, 16–4096 px a side, and decoded by Tauri before it is
  taken (a picture that is no PNG is refused with an Error, as Electron's «not a PNG» / «too large») — and
  `<config>/custom-icon.ico`, made of PNG entries at 16, 24, 32, 48, 64, 128 and 256 px that the bridge draws from the
  picture with the page's canvas (halved step by step, smoothed) before it hands it over; no file means the app's own
  icon. The same name as Electron's, so R6's hand-over copies it as it is.
- **Put on, now and at every start** (`setup` → `appicon::at_start`): the window and its taskbar button (`set_icon`,
  `apidetect.rs` `kr_set_icon`); the app's own title bar and sidebar — the page asks the shell for the icon in force at
  its start (`src/native.ts`, Tauri only) and shows it in every `img[data-brand]` (`brandIcon.ts`), so they follow the
  shell's record even in a fresh profile; on **Windows** the shortcuts the installer made (desktop, Start menu — also in
  a folder of the app's name —, pinned on the taskbar, the all-users ones where it may write) pointed at the `.ico`, only
  those whose target is this program, through Windows' own WScript.Shell run by PowerShell with the paths in its
  environment (no COM code here; about a second, in the background), and again at a start after an update made them
  anew (their paths and times are kept as a stamp); on **Linux**, where the .deb's desktop entry is
  (`/usr/share/applications/KurokawaReader.desktop`), a copy of it in `~/.local/share/applications` with its `Icon`
  pointed at the picture and marked as the app's (`X-KurokawaReader-CustomIcon=true`; one the user made is never
  touched) — the menus and the dock read that one first; refreshed at each start so an upgraded entry is followed.
- **Reset to default** (Settings' «Back to the original icon» — `appIcon({ set: null })`): the files removed, the window
  given Tauri's default icon again, the shortcuts pointed back at the program, the Linux copy removed.
- **In the backup** (`src/backup.ts`, every shell): the picture as a PNG data URL (`appIcon`, at most 3 MiB of text),
  brought back by a restore of the settings where the app's own icon can be set (the desktop shells — so it crosses
  from Electron to this build with a backup, and with R6's hand-over); a phone's icon is a shortcut pinned with the
  user's consent, so a restore there leaves it to them.
- **Settings**: the row appears where it acts (`appIconWay()`: the desktop shells and Android), with a hint that says
  what this system lets it change (`appIconHint()`: on this build a Mac's and Linux's own words, `myIconHintMac`,
  `myIconHintLinux`, five languages; Windows and Electron keep `myIconHintPc`).
- **What each system refuses**, said plainly: **macOS** — the Dock and the Finder keep the bundle's icon (Tauri cannot
  change the Dock's icon at run time; NSApplication's `setApplicationIconImage` needs Objective-C calls this build does
  not make; a Mac's windows have no icon of their own), so there the title bar and sidebar show it; **Windows** —
  Explorer may show a shortcut's old picture until its icon cache is refreshed (a sign-out, or `ie4uinit -show`); a
  shortcut the user made elsewhere is not looked for; notifications show the app's registered icon; **Linux** — under
  Wayland the dock takes the desktop entry's icon, so the AppImage (which installs no entry) and a bare program show it
  on the window only; the X11 taskbar shows the window's.

**Tests**: `archive.rs`, `iconlogic.rs`, `apidetect.rs` std-only unit tests (CI): a zip made, listed, tested,
extracted (`both`, `skip`), a damaged byte named, stopped and cleaned up; zip-slip names and an absolute link refused
before anything is written; in place stopped mid-batch, given up (a whole ZIP again) and resumed; tar in place, GNU
long names; an `.sfv` checked; `7z l -slt` output as 7-Zip writes it, its progress lines; the icon's PNG checks, the
`.ico`, the desktop entry; `tests/tauribridge.cjs` (the sixteen functions' commands and arguments from node and from
the page, the extras, the Archives button in the library, the 7-Zip resources and crates named); `selftest.js` in CI
(R5 rows, required on Windows and Linux): the shipped 7-Zip found; a zip of a folder and a file made → listed → tested
→ extracted, every byte the same, progress heard; extracted in place, the archive gone; a hostile zip refused, nothing
written; a 7z with a password (refused without it, «wrongPassword» with a wrong one, extracted and tested with it) and
a tar.gz in two layers, made by the shipped 7-Zip; a menu command reaching the page; the app icon chosen → kept (and its
`.ico` of seven sizes on Windows), put on the window, refused when no PNG, reset; reported: full screen and back, the
zoom, taskbar progress, an image on the clipboard read back; `enginetest.js` case 11 (the Archives button → «Open an
archive» → the extraction sheet → «Extract», the file there after) and case 12 (an icon chosen, the page reloaded, the
title bar's logo is the picture — screenshot `09-titlebar-custom-icon` —, reset); case 8 reads the window's full screen
from the shell now.

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
   uses, present or not (a module worker tried for real; a worker started from a worker — the app's
   `pdf.worker.min.mjs` from inside a blob worker, as the converter's lanes start pdf.js's —, and a worker's own
   `fetch` of the app's file, reported); every script of the app fetched to see the type the shell
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

**R1, Windows** (WebView2 156, `http://tauri.localhost`): PDF → Word in two lanes (`krLanes = 2`) never finished — both
lane workers started and said nothing (0 messages, no error), and the converter waited for ever (the test's 60 s ran
out). Everything else of the converter passed. Reproduced in Chromium by making pdf.js's own worker inside a lane fail
to load: pdf.js listens to none of its worker's errors when it is handed the worker, so the document waits for ever —
the same picture. Likely cause (to be confirmed by the next run): the worker a lane starts from inside itself is not
served under `http://tauri.localhost` on WebView2. Fixed so it cannot hang anywhere: the lane says each step it reaches
(`started`, `pdf.js loaded`, `its worker made`, `opening the document`) and reports its pdf.js worker's `error`; the
page gives lanes up when one fails, or when one is silent 20 s before it is ready (`krLaneWait` to change it), and
reads the pages itself — with the reason, and where each lane stopped, in the console (the engine test's row shows
it). `tests/pdf2docxlanes.cjs`: silent lanes (given up after 20 s, same text), lanes whose pdf.js worker cannot start
(given up at once), working lanes (not given up); the old code hangs on the second.

## The hand-over (stage R6a)

The owner's decision: the Rust build becomes the main download, an update «rebuilds the app and keeps the user's data
intact», and backups of either build restore in the other. The web view's profile cannot be shared — Electron's page
lives at `app://kurokawa` in its own Chromium, the Rust build's at `http://tauri.localhost` / `tauri://localhost` in
the system's web view —, so the data is handed over: the LAST Electron build (the bridge build, R6b: published under
the old asset names so existing users' updaters fetch it) writes everything into a folder before it installs the Rust
build; the Rust build brings it back on its first start. Nothing is deleted from the old profile, ever, by either
build; the hand-over folder goes only when the reader asks. (Downloading and running the Rust installer, the installer
itself and the Rust build's updater are R6b's; R6a owns the data.)

### What the Electron Reader keeps for a user, and how each part crosses

Electron's data folder (`userData`): installed — `%APPDATA%\KurokawaReader`, `~/Library/Application Support/KurokawaReader`,
`~/.config/KurokawaReader`; the portable .exe uses the same (electron-builder's portable does not move it); `electron .`
(CI) — `…/kurokawa-reader-desktop`. Its Chromium profile (IndexedDB, localStorage, cookies…) is inside it. The Rust
build's web-view profile: WebView2 `%LOCALAPPDATA%\app.kurokawa.reader\EBWebView`; WKWebView
`~/Library/WebKit/app.kurokawa.reader/WebsiteData` (`…/KurokawaReader/…` for the bare program); WebKitGTK
`~/.local/share/app.kurokawa.reader`. Its own files: `<app data>` = `%APPDATA%\app.kurokawa.reader`,
`~/Library/Application Support/app.kurokawa.reader`, `~/.local/share/app.kurokawa.reader`.

| What (from the code) | Electron | Rust build | How it crosses |
|---|---|---|---|
| Book records — IndexedDB `kurokawa-reader`, store `books`: title, file name and size, place (`progress`, `progressAt`), bookmarks, highlights and notes, PDF highlights, pins and ink, tags, folder, rating, review, chapter marks and stars, reading stats (`stats`, `statsSync`), series, online source, per-book `prefs`, covers (`cover`, `coverOrig` as Blobs) | its profile | its profile | `handover/books.jsonl`, record by record, **ids kept**; covers `books/<n>/cover`, `cover-orig` |
| Book files — store `files`, keyed by the book's id | its profile | its profile | `books/<n>/file`, read and written 8 MiB at a time |
| Linked books — the record's `source.path`; the file stays in the reader's folder | the record | the record | **the link crosses, the file is not copied** |
| Fonts (`font:<id>`), the reader's background picture (`bg-image`) — store `files` | its profile | its profile | `fonts/<n>`, `files/<n>` |
| Every other record — store `meta`: folders, tags, the fonts list, translations (`tr:`, `trs:`), Anki progress, audiobook places, PDF crops and passwords, sources' repositories, indexes and caches, sync state, the automatic backups… | its profile | its profile | `handover/meta.jsonl`, every key; Blobs, bytes, dates kept by tagged stand-ins |
| Search text — store `texts` | its profile | — | not carried: a cache, rebuilt when a book is searched |
| localStorage: settings `kr.visual` (sync's WebDAV account in it), per-book `kr.bookVisual`, language, direction, sort, glossary (`kr.glossary*`), text rules, kept words, the reading queue, migration flags, sources' filters and extension stores (`kr.ext.store.*`), sign-ins (`kr.dbx.*`, `kr.anilist.*`, `kr.shamelalink.*`), the icon's picture (`app.icon`), scan folders (`kr.scan`)… | its profile | its profile | `handover/local.json`: **every key** but `kr.diag` (the old shell's diagnostics) and `kr.handover.*`. Keys and tokens included: unlike a backup the reader shares, the hand-over stays in the user's own data folder — they stay signed in |
| sessionStorage (a jump in progress) | per window | — | not carried: lives for one run |
| Local AI models (wllama: the origin's private files, OPFS) | its profile | its profile | `opfs/<n>` + `handover/opfs.json`; a web view that cannot write them gets the models list emptied (shown as not downloaded, never as there and broken) |
| Cache Storage (voices, the local AI's engine, dictionaries, sources' covers) | its profile | its profile | not carried: both shells (and the phones) empty it at every start (`src/main.ts`); fetched again when used |
| `custom-icon.png` (+ `.ico`, Windows) | userData | `appicon.rs`'s file | `shell/custom-icon.png` kept; restored through `appIcon({ set })` from `app.icon` |
| `window-state.json` | userData | `<app config>/window-state.json`, the same format | `shell/window-state.json` kept; not applied (the first window opens at the default size once) |
| `doh.json` (DNS over HTTPS) | userData | `doh.json` (commands.rs) | `shell/doh.json` → `setDoh(provider)` |
| `downloads/` (files in flight) | userData | its downloads folder | not carried: a book that arrived is in the library; an unfinished download starts again |
| Cookies and sessions: the app's requests and the in-app browser (one `defaultSession`; encrypted by the system's key store) | its profile | `cookies.txt` (R3), the browser's profile (R4) | not carried: a site the sources use asks to sign in again (sync and AniList are tokens in localStorage and cross) |

### The folder

`<userData>/handover/` — written by `desktop/handover.cjs` (Writer) for the page (`src/handover.ts` makeHandover):

    kurokawa-backup.json      a full backup's manifest (src/backup.ts, credentials left out) — the folder is also a
    paths.json                full backup, its files at safe names: { "books/<id>/<fileName>": "books/3/file", … }
    books/<n>/file, cover, cover-orig, translations.json
    fonts/<n>, files/<n>, blobs/<n>, opfs/<n>
    handover/books.jsonl, meta.jsonl, files.json, local.json, opfs.json
    shell/custom-icon.png, window-state.json, doh.json
    marker.json               written last: { app, kind: 'handover', format: 1, id, createdAt, from, counts, bytes,
                              files: [{ rel, size, sha256 }] }

- **Streamed**: each file is written in 8 MiB pieces through the shell (Electron's IPC carries the bytes as they
  are); the record files are written a few megabytes at a time. Nothing holds the library as one string or one Blob.
- **Atomic**: everything goes into `<userData>/handover.part/`; each file is hashed as it arrives, then read back from
  the disk and hashed again, its size checked, flushed (`fsync`); the page reads the records back and compares them
  with its stores (ids, places, highlights, counts); then the marker is written (temp file, flush, rename) and only
  then `handover.part` becomes `handover` (an older hand-over is replaced only at that moment). A run broken off at any
  point leaves no folder with a marker, so nothing half-written is taken for a hand-over. Not resumable: a new run
  starts again.
- **Space**: before writing, the shell checks the disk's free space (`fs.statfs`) against the library's size (the
  stores' Blobs, or the origin's own usage figure when larger) + 2 % + 256 MB; short → nothing is written.
- **Pointers**: `<Rust app data>/handover-from.json` and, for the portable .exe, `KurokawaReader-handover.json`
  beside it: `{ dir, id }`.

### What each side does

**Electron (bridge build)**: `window.kurokawaHandover` (`preload.cjs`; `main.cjs` installs `handover.cjs`):
`begin({need})`, `write(rel, bytes, append)`, `shellFiles()`, `readPart(rel)`, `verify(list)`, `finish({counts})`,
`abort()`, `status()`. The page's `makeHandover()` answers `{ ok, dir, id, counts }` or `{ ok: false, reason:
'space' | 'verify' | 'error' | 'unsupported', … }`; `ui/handoversheet.ts` `handoverBeforeInstall()` shows its
progress and, on failure, says why plainly («Not enough free space… Nothing was changed and this version keeps
working») and answers **false: R6b must not install the Rust build then**. (`window.__KR_HANDOVER__.beforeInstall()`
reaches it without an import.) `KR_HANDOVER_FREE=<bytes>` makes the shell assume that much free space (tests).

**Rust build**: `window.kurokawaHandover` (`handover-bridge.js`, injected after `bridge.js`) over `handover.rs`:
`kr_handover_find { p }` (a folder the reader picked — it, or its `handover` folder —, else `KR_HANDOVER_FROM`, the
pointers, then Electron's default folders: every marker checked, every listed file's size), `kr_handover_verify { p }`
(every file's SHA-256), `kr_handover_read { p, rel }` (bytes), `kr_handover_mark { o }` (`<app data>/handover-state.json`:
`{ id, state: restored | declined, at, counts }`), `kr_handover_free { p }` (only a folder named `handover` holding a
hand-over's marker). The pure parts are `handoverlogic.rs` (std only; CI's std-only tests run it).
On the first start (`src/main.ts` → `handoverAtStart`, 1.5 s after the start) the screen «Your library from the
previous version» shows when a whole hand-over is found, it was neither restored nor declined here, and this profile is
empty (no book, folder or tag — the settings are not a sign: the app writes them at its first start) or a restore of it
was broken off: how many books («Books: n», «العدد: n»), its size, «Your old data is untouched, at: <folder>», and
«Bring it now» / «Not now». Bringing it: the SHA-256 of every file checked, then into an empty profile everything is
**copied** — each book's file before its record, every record and key as it was, the icon put on the window, the DNS
choice applied —, the books checked to be there, the hand-over marked `restored` (and `kr.handover.done` set), and
«Free the space» (asks first; deletes the copy only — never Electron's profile) and «Continue» (the page reloads with
its settings). «Not now» marks it `declined`: not asked at the start again. Settings → Backup (the Rust build only:
the rows appear where the shell reads a hand-over, never on a phone or the web): «Bring my library from the previous
version», «Import from the previous version's hand-over folder» (a folder picked: Electron's data folder or the
`handover` folder), «Import from the previous version's backup file» (the usual restore), and «Free the space» once it
came. Into a library that already has books the hand-over is **merged**: the books it lacks added as they were (with
their files, covers, notes, places; linked ones linked; their folder found by name), then the full backup's rules
(`restoreManifest`: notes merged by id, the later place kept, settings the backup's, credentials the device's). Never
twice: a restored or declined hand-over is not offered at the start again (`handover-state.json` and
`kr.handover.done`); a restore broken off is taken up again as a copy at the next start (`kr.handover.progress`).

### Backups between the builds and the phones

The same code makes and reads backups everywhere (`src/backup.ts`), so a backup made by the Rust build restores in the
Electron build (an older user, a rollback) and on the phones, and the reverse. `readManifest` now names the format's
rule: any version is read — a field this app does not know is passed by, one it misses left as the device has it, a
NEWER version's backup restored as far as it goes —; only a file that is not a KurokawaReader backup is refused; one
without a version is read as version 1. The PC-only part of a backup — the app's icon — is applied only where a
desktop shell sets icons (`appIconWay() === 'desktop'`); the window state and linked folders are not in a backup (a
full backup copies a linked book's file in, read from where it lives). What a backup did NOT carry, and the hand-over
does: every localStorage key beyond the backup's (sources' filters and stores, sign-ins, the queue, flags), every
`meta` record beyond folders, tags, fonts, translations, Anki and audio places, the original covers, linked books' own
records (a backup restores a linked book only where its file is), the local AI's models. A full backup is built in
memory by JSZip and read whole by it: fine for most libraries, not for many GBs — the hand-over, not a backup, is the
way between the builds.

### Tests

- `tests/handover.cjs` (Playwright, the built app; here): an Electron-shaped profile (desktop/handover.cjs's real
  Writer in a temp folder) with an EPUB, a PDF, a long text read to its 120th paragraph, a linked book, notes of every
  kind, per-book settings, a font, translations, Anki, folders, tags, a custom icon, sign-ins, a model in the private
  files → a full disk refused (nothing written, the reader told, false for the installer) → the hand-over made
  (marker, hashes, pointer, the linked file not copied, no part folder) → a run broken off and a killed write leave no
  hand-over (the older one stands), a damaged copy refused by hash, a truncated one not even offered → a Rust-shaped
  page (the real bridge.js and handover-bridge.js over a fake IPC doing handover.rs's rules) offers it with the count
  and the folder, brings it, and after the reload every store and key is the same (deep compare), the icon and DNS
  applied, the text book opens at the same paragraph; the second start neither offers nor reads it; «Free the space»
  deletes only the copy → a library with a book gets the missing ones and merged notes, folders by name → «Not now»
  is kept; a picked folder is found → CI's own check script (`handovercheck.js`) passes here → backups: a phone's full
  backup restores on the computer and the reverse, the icon left off the phone, a newer version's backup read, a
  stranger's refused.
- CI (`tauri-check-reader.yml`, «Hand-over» steps; Windows required, Linux reported): the real Electron app
  (`electron .`, Playwright's `_electron`, `tests/handover-electron.cjs`) is given a library and makes its hand-over;
  its snapshot is the expectation (`KRH_EXPECT`); the Tauri build then starts with an emptied web-view profile and
  `KRH_SELFTEST=<file>` (`handover.rs` adds `handovercheck.js`; the shared self-test frame writes the verdict, its
  watchdog `KRH_SELFTEST_TIMEOUT`): the screen offers it with the count, brings it; after the reload the same books
  (ids and fields), files (sizes), records, keys, icon; marked restored and not offered again; the text book opens at
  its paragraph (reported). `selftest-report.cjs` prints the table.
