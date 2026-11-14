# Porting the desktop shell to Tauri v2

The Electron shell (`../desktop/`) keeps shipping; this Tauri shell grows beside it until it has every channel
below, then replaces it. Why: Electron bundles are ~84 MB (Windows), ~87 MB (Linux AppImage), ~168 MB (macOS
universal dmg). A Tauri shell uses the system's web view (WebView2 / WKWebView / WebKitGTK), so the shell itself
should be a few MB; `.github/workflows/tauri-check.yml` prints the real sizes.

How it works: `src-tauri/src/main.rs` opens the window (made in Rust, `app.windows` is empty in
`tauri.conf.json`) on the same built web UI (`../dist`), and runs `bridge.js` as its initialization script, so the
page finds the same `window.kurokawaTools` the Electron preload gives it. Each Electron channel `kt:xyz` becomes the
Tauri command `kt_xyz` (`src-tauri/src/commands.rs`). A method that is not ported yet is **absent** from the bridge
(the page asks for each feature by its method). Events the main process pushes (`kt:tasks`, `kt:engineState`) are
Tauri events (`app.emit`), listened to in bridge.js with `window.__TAURI__.event.listen` (`core:event:default`,
part of `core:default`). `tests/tauribridge.cjs` keeps the bridge, the preload and the Rust command list in step,
and tests the self-test script against a fake bridge.

The download engine (`src-tauri/src/engine.rs`, pure parts in kt-core's `engine_core.rs`): aria2c, found as `aria2.cjs` finds
it — `<resources>/aria2/<win|linux|mac>-<arch>/aria2c[.exe]`, then `<resources>/aria2/<plat>/`, the same under the
executable's folder, then the PATH (on macOS also Homebrew's `/opt/homebrew/bin` and `/usr/local/bin`) —, started
with `aria2.cjs`'s arguments (free loopback port, random secret, session file, the same option list) plus
`--stop-with-process=<the app's pid>`, so it ends with the app however the app ends; on a normal exit the session
is saved and the child killed (`RunEvent::Exit`). No console window on Windows (`CREATE_NO_WINDOW`). Restarted
after 2/4/6 s when it dies while in use, three times at most, as `aria2.cjs` does. JSON-RPC goes over aria2's
**HTTP** endpoint (`POST /jsonrpc`, a small std-only client in `rpc.rs`), not the WebSocket: no new crate, and
everything runs on plain threads. Notifications are replaced by polling — `tellActive` / `tellWaiting` /
`tellStopped` every 0.7 s while something moves, 4 s otherwise, at once after a change made from the page (the
cadence of `aria2.cjs`'s loop) —, and `kt:tasks` is emitted only when the list's JSON changed. Downloads the app
kept nothing of get a first-seen `addedAt`/`doneAt` (Electron gave them `Date.now()` on every pass), so an idle list
stays still.

aria2c in the bundle: CI runs `desktop/fetch-aria2.mjs` (as the Electron build does: Windows x64, Linux x64/arm64,
none for macOS — Homebrew's at run time) and copies `desktop/aria2/*` into `desktop-tauri/aria2/`, which
`tauri.conf.json`'s `bundle.resources` maps to `aria2/` in the resource folder. The folder is committed with only a
README so local builds work without it; to bundle aria2c locally, run `node fetch-aria2.mjs` in `../desktop` and copy
`../desktop/aria2/<plat>-<arch>/` here.

Self-test: with `KT_SELFTEST=<file>` set, `selftest.rs` starts a loopback test server and adds `selftest.js` to the
initialization script; the page checks the bridge, files, hashes, `kt:http` (headers, redirect, gzip, binary, POST),
the clipboard (not required), that the UI rendered, the P3 functions (the recycle bin — required on Linux, reported
elsewhere —, free space, fonts, MEGA) and the Files page's jobs on temp folders (copy, keep both, replace for all, a
skipped move, a folder into itself, cancel mid-copy with the file it replaced kept whole; a folder moved to another
disk and a cancelled move there, where the machine has a second disk — /dev/shm on Linux, the runner's D: on Windows —,
else reported as skipped with the reason), and — where aria2c is found — a 2 MiB download from the test
server through the engine (paused mid-way, resumed, its hash checked, renamed, removed), then hands the results to
`kt_selftest_done`, which writes them and exits 0/1; a watchdog exits 2 after `KT_SELFTEST_TIMEOUT` (170 in CI) s.
Since the P3 gaps, P7, P8 and P6's icon also: the storages, new folder / rename / stat, a cancel sent at once and one sent
before its job; the archives (the shipped 7-Zip found — required on Windows and Linux —, a zip made → listed with
dates → tested → extracted byte for byte, a part of it taken out with no other folder made, entries copied out through
a hidden staging folder and a file job, extracted in place, a zip-slip refused, a 7z with a made-up password, a
tar.gz in two layers); DNS over HTTPS against the test server's resolver; the updater's resumed download and its
checksum refusals, a bare program refusing to install; the app icon chosen, kept, put on the window, reset.
`tauri-check.yml` runs it on Linux under Xvfb and on Windows (both required), and on macOS (the bare executable,
reported only).

Paths on Windows: aria2 reports a file's path with «/» and its folder as given (with «\\»). The shell hands the page
`dir` (and the paths of `kt:open`, a renamed file) in native form — backslashes, no `\\?\` prefix, as Node's path
functions give —, and `files[].path` relative to `dir` with «/» between its parts, which is what the page's code
splits on (kt-core `engine_core.rs`'s `native_path` / `rel_path_on`). Electron compared the two forms as they came, so on
Windows it handed the page the whole «C:/…» path as `files[].path`; the Tauri shell fixes that.
`selftest-report.cjs` prints the results as a table.

Version: `tauri.conf.json` has `"version": "../../package.json"`, so the app's version is always
`apps/tools/package.json`'s (Cargo.toml's own version is unused and stays `0.0.0`).

Icons: not committed; CI runs `npx @tauri-apps/cli icon ../desktop/icon.png` first (it writes `src-tauri/icons/`).
Do the same once before a local `tauri build` / `tauri dev`.

## Stage P3 (this pass)

- **The shared crate.** `src-tauri` takes `kurokawa-shell` (`../../../shared/shell-rs`, the Reader's too) for files,
  dialogs, clipboard, opening, web requests (now with the cookie jar, as Electron's session), the update check, window
  state, hashes, the self-test's frame and its test server; Tools' own copies (`util`, `files`, `hash`, `net`,
  `winstate`, `testserver`, the frame of `selftest`) are gone. `commands.rs` is thin wrappers under Tools' names.
- **kt-core** (`../core/kt-core`, docs/RUST-PORT.md §6): std only, every module tested alone with rustc —
  `engine_core` (moved from the shell), `filejobs`, `fontnames`, `mega`. The Android stages will take it as it is. Not a
  Cargo workspace yet (it would move `target/` and the workflow's paths); the shell takes it by path.
- **API detection** (`src-tauri/build.rs` + `apidetect.rs`, the Reader's way): `kt_reveal` (tauri-plugin-opener's
  `reveal_item_in_dir` on its Opener, for «show in folder» with the item chosen), and for later stages `kt_set_icon`,
  `kt_default_icon`, `kt_progress`. Not found → that part is left out; the build never fails for it; the log says
  «KT build: …».
- **The Files page's jobs** (`src-tauri/src/filecmds.rs` over kt-core `filejobs.rs`, a rule-for-rule port of
  `native/android/KtFileJobs.java` with tests/native/FilesT.java's cases): copy, move, delete; an original removed only
  after its copy arrived whole (size checked); replace writes beside (`.ktpart`) and swaps only when complete; keep both
  → «name (2).ext»; skip; «…All» for the rest; a folder never into itself (trailing separator, a link, letter case); a
  link to a folder neither followed nor deleted through; cancel; per-item failures in `failed`; a move's `left` and
  `remaining`. Events `kt:files` with the phone plugin's shapes; the page (src/views/files.ts) takes the shell's
  `filesJob` / `filesCancel` / `filesAnswer` / `onFilesJob` where they are, so Copy, Cut, Paste, the clipboard bar and
  Delete (to the system's recycle bin, or for good) appear on the Tauri shell only — Electron's bridge has none.
- **The title bar** (`src-tauri/src/titlebar.rs`, the Reader's with Tools' names; the window made without the system's
  frame unless chosen): the page draws it with `src/ui/winbar.ts` — one file in both apps (tests/shared-copies.cjs) —
  and offers its settings (the app's own / the system's, transparent, the name) in Settings on the Tauri shell only.
  Electron keeps `ui/titlebar.ts`. The custom app icon system (`kt:appIcon`) is P6.

## After P3: the Files page's gaps, P7 archives, P8 DoH and updater, P6 app icon

- **Files on a computer** (`filecmds.rs`, kt-core `places.rs`): the shell's own `homeDir`, `filesRoots` (home, Downloads,
  Desktop, Documents where they exist, then the disks — Linux's mount table without pseudo file systems, a Mac's
  /Volumes, Windows' drive letters that answer — each with `free`/`total`), `filesStat` (shallow: exists, dir, size,
  mtime, readable, writable — a folder's writability tried with a probe file), `filesMkdir`, `filesRename` (kt-core's
  rename: «exists» when taken) — the phone plugin's shapes, so src/views/files.ts takes them through one helper
  (`fsx()`): storages named in the page's language by kind, New folder, Rename (F2), Properties, Paste's «read-only
  here». Electron's bridge has none of them: its Files page is as it was (tests/filestauri.cjs checks both).
- **Cancel never lost**: kt-core `filejobs::prepare` registers a job before its thread exists, and a cancel for an id
  no job has yet is kept a minute for the job that starts under it (the same for archive jobs).
- **The Linux recycle bin** writes DeletionDate in local time (localtime_r's offset), as the specification says.
- **Archives (P7)**: `archive.rs` moved from the Reader into the shared crate (`shared/shell-rs/src/archive.rs`, its unit
  tests with it; the Reader's workflow points there) — one copy for both apps. Tools' additions to archive.cjs are in
  it, each off unless the app asks, so the Reader's answers are unchanged: entry dates (zip DOS times, 7-Zip's
  «Modified», local time with the offset Tools sets at start), a partial extraction `only` (folders made only for what
  is taken out; never in place), split volumes routed to 7-Zip. Path safety as the Reader's: no absolute names, «..»,
  drive letters or stream names, links that leave the folder refuse the archive. Tools' commands are `archives.rs`
  (the Reader's with Tools' names; progress `kt:archiveProgress` at most every 250 ms; «cache:» the temp folder's
  kurokawa-archive-view; passwords only on 7-Zip's command line). 7-Zip: CI installs the npm package 7zip-bin at the
  version desktop/package.json names and copies this system's 7za into `7zip/<plat>/<arch>/` (bundled as resources).
  The Files page on this shell: an archive's sheet offers Extract here / Extract to… / Compress; an archive is browsed
  as a folder; its entries copied out the phone's way (into a hidden `.kurokawa-extract-*` folder at the destination,
  moved in by a file job — the name-taken question, Cancel —, the hidden folder always removed); a zip made of the
  chosen. Electron's Files page offers none of it (it has no file jobs).
- **DNS over HTTPS (P8)**: `setDoh` / `dohProbe` over the shared resolver (`net::set_doh`, `net::doh_lookup`), Tools'
  provider names from kt-core `dohnames.rs` (main.cjs's table; «auto» is its first). What the web view fetches itself
  keeps the system's DNS (see «DoH» below).
- **The updater (P8)**: `update.rs` + kt-core `updatelogic.rs` — the Reader's (download resumed up to six tries, size and
  SHA-256 against GitHub's digest and/or the release's SHA256SUMS, refused and removed on a mismatch or with neither,
  NSIS run as an update / AppImage replaced in place / .deb and .dmg opened, a background download installed silently
  when the app quits) with Tools' names and tags (`tools-v<v>`; every Tools release is marked a pre-release on GitHub,
  so the beta channel is a «-» in the version). `installUpdate(url)` takes the file the page picked by the Electron
  patterns and fetches this build's own file of the same release; `updateDownload` / `updateInstall` are this shell's
  own (the page does not call them yet). The page turns «kt-update:checksum|size|nochecksum» into its «damaged»
  sentence and a copy that cannot replace itself into «updateByHand». Nothing publishes these files yet (P9).
  The release files this shell will look for (P9's release job must name them so; none matches the Electron Tools'
  patterns /win-x64\.exe$/, /\.dmg$/, /\.AppImage$/ — tests/updatenames.cjs):
  `KurokawaTools-<v>-windows-x64-setup.exe` (NSIS), `KurokawaTools-<v>-windows-x64-portable.zip`,
  `KurokawaTools-<v>-macos-universal.DMG` (or `-macos-arm64.DMG` / `-macos-x64.DMG`),
  `KurokawaTools-<v>-linux-x64.appimage`, `KurokawaTools-<v>-linux-x64.deb`, and `KurokawaTools-<v>-SHA256SUMS.txt`
  (sha256sum's format). A portable copy carries `KurokawaTools.portable` beside the program.
  **Duplication**: kt-core's updatelogic.rs is an adapted copy of the Reader's (the decisions are the same, the names
  are not); tests/shared-copies.cjs fails when any function both have (all but the two that read tags) drifts apart.
- **The app icon of the user's choosing (P6 part)**: the Reader's `appicon.rs` steps and `iconlogic.rs` moved into the
  shared crate (`appicon::Spec` gives each app's names — shortcuts, desktop entries, the entry's marker — and its two
  window calls; the cfg detection of those calls stays in each app's build.rs/apidetect.rs, since the calls stay in the
  app). The Reader's `appicon.rs` is now a thin wrapper with the same command names, files and answers. Tools:
  `kt:appIcon` (the page's existing Settings row on a computer, the title bar's logo, the window and taskbar, Windows'
  «Kurokawa Tools.lnk» shortcuts, Linux's desktop entry copy marked `X-KurokawaTools-CustomIcon=true`; the backup
  already carries the icon), the .ico's sizes drawn by bridge.js's canvas as the Reader's.

## Stage P4: torrent streaming and the local stream server

- **The server** (`src-tauri/src/streamserver.rs`, rules in kt-core's `streamlogic.rs`): std only, 127.0.0.1 on a port the
  system picks, this run's random token in every address (wrong: 403) — Electron's servers had one only for files —, a
  torrent file's address its own session token too (`/<token>/t/<session>/<name>`), withdrawn by `streamDone`. Range
  answers as Electron's (200 / 206 / 416 / HEAD; «500-100» and an empty file now answered right), Content-Type from the
  name (webstream's table, the files' table for `fileUrl`), CORS open plus an OPTIONS preflight answer, a thread per
  connection (64 at most, then 503), blocking writes with a 60 s timeout (back-pressure), `Connection: close`. Stopped
  at quit: its port free, every reader and ffmpeg ended.
- **The engine** behind one trait (`stream_engine.rs`: add → files, select, prioritise, read_at that waits for pieces,
  stats, stop). `Aria2Stream` works today: the download gets `stream-piece-selector=inorder` and
  `bt-prioritize-piece=head=16M,tail=4M` (torrentstream.cjs), each read waits until aria2's bitfield has its pieces and
  reads the growing file — no file handle kept between reads. aria2 cannot fetch an arbitrary place first, so a far
  seek waits for the in-order fetch (Electron's reason for WebTorrent). `stream_rqbit.rs` (librqbit 8, the plan's
  engine) pauses aria2, streams with librqbit's file streams in the same folder and hands back with check-integrity —
  compiled only with `--features rqbit`, which the main build leaves out entirely (its dependency lines are added only
  by the non-required CI step «librqbit try», so neither librqbit's API nor its dependency resolution can break the
  main build). Its calls are written from memory, each marked GUESS; that step prints the compiler's verdict.
- **ffmpeg routes** (`streamproxy.rs`): `/audio`, `/video`, the proxy's HLS remux — streamproxy.cjs's and
  transcode.cjs's arguments word for word (kt-core), each ffmpeg killed when its reader leaves.
- **Self-test** (`streamtest.rs`, `torrentmake.rs`): required everywhere — a stand-in engine whose pieces the test lets
  in (a read held until its pieces come while the start is served, eight readers at once, 416 / 403 / 404 / OPTIONS,
  stats, streamDone ending a waiting reader, no connection left), `fileUrl`, the audio/video addresses, the proxy
  against the test server, the server stopped with its port free. Reported only for now: ffmpeg's AAC; a real swarm on
  loopback — a private two-file torrent made in the test from made-up bytes (std SHA-1 and bencoding), a tracker on
  127.0.0.1 naming one peer, a second aria2c bound to 127.0.0.1 seeding at 256 KiB/s (DHT, LPD, PEX off), the app's
  engine fetching it while the page streams start, middle, end and the second file, compared byte for byte. Make the
  swarm rows required once CI has shown them steady. Page-level: `tests/streamtauri.cjs`.

## Stage P6 — desktop integration (`desktop.rs`, `desklogic.rs` std only, `sitewin.rs`)

- **Tray** (Tauri's `tray-icon` feature): made when chosen (main.cjs's `trayUpdate`), its tooltip the speed over every
  moving download, its menu (the app's name → the window; Quit) in the interface's language — the page sends the words
  (`desktopPrefs({labels})`, src/downloads/power.ts; Electron's menu is English). A left click brings the window back
  (cfg `kt_tray_left` / `kt_tray_left_old` keep the menu to the right click); Linux's tray gives no clicks, its menu has
  the same item. On Linux a tray is made only where libayatana-appindicator3 / libappindicator3 is installed (the crate
  would stop the program otherwise); the self-test says why when not. **Close to tray**: Electron hides instead of
  closing only while the screen translator keeps itself in the tray (`ScreenTr.keepInTray()`) — that comes with the
  screen translator (below); nothing else of Electron closes to the tray. **Autostart**: Electron has none; none here.
- **Notices** (tauri-plugin-notification, from Rust only): main.cjs's rule (a download seen moving that finishes; its
  name and size). **The plugin gives no click on a computer** — what Tools loses is Electron's «click the notice →
  the download's page». The nearest thing here: a download told of while the window was not in front is opened
  (`kt:openTask`, as the click did) the first time the window comes to the front within two minutes
  (`desklogic::NoticeOpen`).
- **Clipboard hotkeys** (tauri-plugin-global-shortcut, cfg `kt_shortcuts`): Electron accelerators turned into the
  plugin's words (`desklogic::accelerator`); all let go, each registered; a press sends `kt:hotkeyAdd {mode, text}` and
  brings the window back. A clash is said plainly: `hotkeyErrors {mode: 'key'|'taken'|'none'}`, one toast in the
  page's language (`hotkeyRefused`, `hotkeyWhy*`; Electron dropped them silently); on Linux only with an X display.
- **Taskbar progress** (`set_progress_bar`, cfg `kt_progress`), a Mac's dock count (cfg `kt_badge`, not on Windows as
  main.cjs). **Keep-awake** while something downloads (Electron's `prevent-app-suspension`; Electron has none for
  playing): Windows `SetThreadExecutionState` on a thread that holds it; a Mac `caffeinate -i -w <pid>`; Linux
  `systemd-inhibit --what=idle:sleep … tail --pid=<pid>` — each child ends with the app. **When done**: main.cjs's
  commands after 5 s (quit after 3 s).
- **Single instance + hand-over** (tauri-plugin-single-instance, on Linux only with a D-Bus session bus — the Reader's
  rule): a second launch's arguments, this launch's, and a Mac's Apple Events (`RunEvent::Opened`) sorted as main.cjs's
  `takeArg` (`desklogic::sort_args`: magnet:, http(s):, `kurokawatools://open?u=`, an existing `.torrent` — relative or
  `file://` too — read into a data: address, at most 64 MiB) and kept until the page listens for `kt:open` (bridge.js
  takes them with `kt_open_take` and dispatches the preload's DOM event; again on `kt:openPending`). The schemes and the
  .torrent association are in tauri.conf.json (`plugins.deep-link.desktop.schemes`, `bundle.fileAssociations`), which
  the bundler writes into the installer, the .deb's entry and the Info.plist, as electron-builder's `protocols`.
- **The mini window** («Prism's»): `#/mini` with the bridge (no self-test), the `mini` capability; dragged by its head.
- **A Mac's menu bar** (the Reader's `menu.rs` way): Electron's roles (app, File, Edit, View, Window) in the page's words.
- **Sign-in and site windows** (`sitewin.rs`): see the table. Neither gets the bridge; neither is the main window's child.

New crates: `tauri-plugin-single-instance` "2" and `tauri-plugin-notification` "2" (the Reader's, already built on CI),
`tauri-plugin-global-shortcut` "2" (new: brings `global-hotkey`, which uses x11-dl on Linux — loaded at run time — and
the Windows/macOS bindings the tray already brings; std has no system-wide key grab), and Tauri's own `tray-icon`
feature (the `tray-icon` crate; muda is already in). Each uncertain call is behind a cfg from `build.rs`/`apidetect.rs`
(`kt_tray_left`, `kt_tray_left_old`, `kt_badge`, `kt_all_spaces`, `kt_shortcuts`); not found → that part left out, the
build never fails for it. Tests: `desklogic.rs` (rustc, CI's «P6-P8» step), `apidetect.rs`, tests/tauribridge.cjs (the
methods, `kt:open`'s hand-over, the events, the self-test's P6 rows against a pretend shell), tests/desktauri.cjs (the
page sends the words and says a refused hotkey, five languages), selftest.js's `desktop:` rows (required on Windows;
the tray wherever it can be made but a Mac; the mini window and the sign-in window but on a Mac; `siteWindow`'s refusal
everywhere; a notice reported only).

## Stage P7 — the in-app browser (`browser.rs`, `grab.js`; rules in `shared/shell-rs/src/browserlogic.rs`)

`browserlogic.rs` moved from the Reader into the shared crate **unchanged** (the Reader's `browser.rs` takes it as
`kurokawa_shell::browserlogic`; its std-only tests, tests/tauribrowser.cjs — which now reads it there — and
tests/tauribridge.cjs pass as before; the Reader's workflow tests it at its new path). Electron's Tools browser
(main.cjs `openBrowser`) is smaller than the Reader's: one window, no `browserFetch`, no forget/reset — so neither is
here (never more than Electron). What this shell does:
- **The window** (`ktb-browse-<n>`, 1100×800, an external address — http(s), else DuckDuckGo, as main.cjs): no bridge,
  no IPC from the site (no capability names it), titled «<page> — Kurokawa Tools». Opened again → the same window sent
  to the new address and brought to the front. Closed with the main window.
- **Its own profile** on Windows and Linux (`<app local data>/browser`), with the Reader's **keeper rule**: a hidden
  `ktb-keep-<n>` window (about:blank) opened first and kept while the app runs — on Windows WebView2 otherwise ends
  the profile's process (and its session cookies) with its last window; on Linux it is the one window with
  `on_download` (WebKitGTK asks the first handler connected; a gone window's answers «cancel»). A Mac: WKWebView's
  default store (the Reader's way). Electron used the app's one session.
- **The channel** (page → app): the Reader's sender, by addresses only (`https://kr-lane.invalid/<nonce>/…`, refused
  by the navigation handler, each piece acknowledged; 24 KiB pieces on a Mac — the Reader's **large-answer lesson**: a
  hidden WKWebView is slow with long addresses; nothing here is large but a grab, and the window is shown). Messages:
  `t` the title (and the browser's user agent), `c` a bar command — it must carry the bar's own token, which lives
  only in the bar's closure (a site's script can find the channel, not that) —, `g` a grab's answer, taken only when
  asked for. Unasked messages are one piece each.
- **The bar** (Electron's window menu: ‹ › ↻ Grab links (Ctrl+G), Copy address (Ctrl+L), Open in system browser): a
  small bar in a corner of the page (a closed shadow root, the start side; the Reader's), in the interface's words
  (`desktopPrefs` labels `browser*`, five languages), plus Alt+← / Alt+→ / F5. **Grab** runs main.cjs's GRAB_JS
  unchanged (`grab.js`, tests/tauribridge.cjs keeps them equal) → `kt:browser {kind:'links', url, title, links, ua}`.
- **Magnets** the page goes to or opens (`on_navigation`) → `kt:browser {kind:'download', url}`, the page stays.
  **Downloads** (`on_download`, cfg `kt_download_api`): the web view's own cancelled, `{kind:'download', url, name,
  referer, ua, cookie}` to the app (Electron's will-download), on every system; `blob:`/`data:` left to the web view.
- **Cookies shared with the app's client**: the site's cookies (cfg `kt_cookie_read`; a Mac every cookie (`kt_cookie_all`)
  matched by `browserlogic::cookie_for_host` — the Reader's **domain-matching lesson**) go in the download's `cookie`
  and into the app's jar (`net::put_cookie`) when a download or a grab is handed over — asked off the main thread
  (WebView2 deadlocks a cookie call made on it).
- **Not here**, said plainly: Electron's `webRequest.onCompleted` list (media told by the answers' content types) — no
  system web view gives response headers; Grab has what GRAB_JS finds, including the page's resource timing (the media
  it loaded by address). New windows a site opens stay in this window (Electron loaded http(s) ones there too).
- Tests: tests/tauribrowsertools.cjs (the page scripts in Chromium against a local site, the channel answered as
  browser.rs answers it: title + user agent, the bar closed and right-to-left, Ctrl+G / Ctrl+L, a forged command told
  apart, a grab in pieces whole and in main.cjs's shape, an unasked answer refused, new windows kept, the site's own load
  finishing); tests/tauribridge.cjs (methods, GRAB_JS equal, the self-test's browser rows against a pretend browser);
  apidetect.rs (`detect_tauri_p7`); selftest.js `browser:` rows on the loopback test site (`/site/`: opened, Grab,
  a magnet, a download with the site's cookies — required on Windows where `on_download` is found —, the app's request
  then signed in and a target=_blank link kept — reported —, closed).

## Stage P8 — the Wi-Fi share, the local API, the antivirus (`lanshare.rs`, `lanlogic.rs` std only)

Plain `std::net` servers on threads (no new crate). As Electron's and no more: the **Wi-Fi share** listens on every
interface (as wifishare.cjs: `0.0.0.0`, a free port) and answers only under its random key — the list page and each
shared file **by its number in the list the app made** (never a path from the request, so no traversal: «..», encoded
or not, backslashes, a NUL, a number out of range → 404) with ranges and HEAD; no upload (Electron has none: other
methods → 405). A shared file is resolved when shared and served only while it still resolves to that same real file
(no link swapped in). The **local API** listens on 127.0.0.1 only (port 8977 unless given), the token on every request
but the CORS preflight (localapi.cjs's order), by `Authorization: Bearer` or `?token=`; the same routes (`GET /tasks`,
`GET /version`, `POST /add`, `POST /tasks/<id>/pause|resume|remove`); `video`/`audio` adds answer an error until P5.
Stricter, said plainly: the key is 24 hex digits (Electron 12) from the system's generator (`/dev/urandom`,
`BCryptGenRandom`), key and token compared in constant time; a head over 16 KiB → 400, an API body over 1 MiB → 413
(Electron dropped the connection), a chunked body → 411; 30 s idle timeouts; at most 32 connections; a refused body
read off before the answer (at most 4 MiB). A port the local API cannot take answers `on: false` with `error` (Electron
said `on: true` and listened nowhere). The address shown is the default-route IPv4 (a private one first) — std cannot
list interfaces by name as wifishare.cjs did. **Antivirus**: antivirus.cjs's rules (Defender's newest MpCmdRun under
`ProgramData\…\Platform`, else Program Files; ClamAV on the PATH; the user's own program with `{file}`, run directly,
never through a shell; Defender 2 / ClamAV 1 / a custom non-zero → infected; ten minutes, then killed → error; only the
kinds chosen). Tests: `lanlogic.rs` (rustc; hostile heads, routes, ranges, tokens, names in the page), selftest.js's
`wifi share:` / `local API:` / `antivirus:` rows from loopback, required everywhere (wrong key / traversal / a number
out refused, a range byte for byte, 416, an upload refused, stopped; none / wrong token 401, query and Bearer 200,
preflight 204, 1.1 MB 413, off; a stand-in scanner — the system's own shell told to exit 0 / 3 — clean, infected,
skipped by kind, no scanner). Any remaining update-install channel: none — `kt:installUpdate` was done with the updater.

### The screen translator — the plan (its 8 channels left untouched)

What Electron does (`desktop/screentr.cjs`, 234 lines; the page: `src/views/overlay.ts`, `src/views/screen.ts`,
`src/screen/{config,translate,lettering,inpaint}.ts`):
- **Settings / status**: `kt:screenConfig` (the page's config saved to `screen.json`; keys, tray re-applied),
  `kt:screenStatus`, `kt:screenOcrLangs` (Windows OCR's installed languages / Tesseract's `--list-langs` / Vision's).
- **Triggers**: global shortcuts per action (`region`, `full`, `repeat`, `auto`, `clipboard`; `DEFAULT_KEYS`), its own
  tray with a menu of the same actions, and **close to tray** while it is on (`keepInTray()` — main.cjs hides the
  main window instead of closing it then).
- **Capture**: the display under the mouse at full resolution (`desktopCapturer` thumbnail), its scale.
- **Overlay**: a frameless always-on-top window over that display (`#/overlay`), the frozen picture as its background;
  the page draws the region (`kt:screenJob` gives it the picture, `kt:screenRegion` the rectangle back); closed on blur.
- **Reading** (`kt:screenRegion`): the crop's text blocks — Windows OCR through a PowerShell script (WinRT
  `Windows.Media.Ocr`), a Mac's Vision through `osascript -l JavaScript`, else Tesseract's TSV — or the crop itself as
  a data: address for an AI model.
- **Auto / tracking**: the last region re-captured every `interval` s, read, compared loosely, and a transparent
  click-through caption window under (or over) it gets `kt:screenCaption {text}`; `kt:screenCaption` (size) lets the
  page resize it; `autoStop` minutes.
- **Clipboard popup**: the clipboard's text translated in a small window by the mouse; `kt:screenClose`.
- **Page code already** (nothing to port): translation (`translate.ts`), the look-ahead / glossary / kind of block and
  its font (`lettering.ts`), the words taken off the picture (`inpaint.ts`), the overlay's drawing and region choice,
  the caption's text. 

What the Rust side must provide (a `screentr.rs` + std-only `screenlogic.rs`):
1. **Capture** — a new crate is unavoidable (std has no screen access): `xcap` (pure Rust over each OS's API:
   Windows GDI / DXGI, macOS CoreGraphics `CGDisplayCreateImage` — the Screen Recording permission, asked once by the
   system —, Linux X11 via xcb and Wayland via the xdg-desktop-portal Screenshot (asks the user each time; no silent
   repeat → «auto» says it cannot run there)). Behind `apidetect` like the rest. Monitor under the cursor: xcap's
   `Monitor::from_point` and the cursor from `tauri::AppHandle::cursor_position` (2.x). PNG encode: `image-png` is
   already in.
2. **Windows**: overlay = `WebviewWindowBuilder` on `#/overlay` with the bridge, `decorations(false)`,
   `always_on_top(true)`, `skip_taskbar`, the monitor's position/size, `visible_on_all_workspaces` (cfg
   `kt_all_spaces`); caption = the same plus `transparent(true)` (on a Mac `macos-private-api`, a Cargo feature and
   `app.macOSPrivateApi` in tauri.conf.json — not App Store safe, said in PORTING) and `set_ignore_cursor_events(true)`
   (click-through), `focused(false)`; blur → `WindowEvent::Focused(false)`. The capability adds `overlay`/`caption`.
3. **OCR**: the same helper processes, std::process: the PowerShell script (written to app data as screentr.cjs does,
   `CREATE_NO_WINDOW`), `osascript` with the JXA script, `tesseract … tsv`; their parsing (`parseLines`, `tsvLines`)
   std-only in `screenlogic.rs` with tests from screentr.cjs's outputs. No OCR crate.
4. **Keys, tray, close-to-tray**: the global-shortcut plugin and tray of P6 (`desktop.rs`): the screen keys registered
   beside the clipboard hotkeys (one registry, both apps' clash reports), a second tray icon or extra items, and
   `CloseRequested` → `prevent_close` + hide while `keepInTray()`.
5. **Events**: `kt:screenCaption` to the caption window only (`emit_to`).
What stays uncertain until a CI run: xcap on the Windows runner without a desktop session, Wayland's portal under
Xvfb (none: X11 there), the transparent click-through caption on WebKitGTK.

## The 98 channels (stocktaking, P3)

Every `ipcMain.handle` of `../desktop` (89 in main.cjs, 8 in screentr.cjs, 1 in titlebar.cjs), grouped by the stage of
docs/RUST-PORT.md that brings it. **done**: in bridge.js and a Rust command; **missing**: absent from bridge.js (the page
asks for each feature by its method, so nothing is a stub). Counts: P1–P2 35 done · P3 8 done · P4 7 done · P5 17
missing · P6 6 done · P7 8 done, 8 missing (`kt:archiveFree` counted in P3; the 8 are the screen translator's) · P8 9 done — **73 of 98
done** (P4, P6, the browser and P8's rest). Besides these, the shell has its own (no Electron channel): the Files page's jobs `filesJob` / `filesCancel` /
`filesAnswer` / `onFilesJob` (P3), `homeDir` / `filesRoots` / `filesStat` / `filesMkdir` / `filesRename` (after P3),
`updateDownload` / `updateInstall` (P8).

### P1–P2 — done before this pass (35)

| Channel | Status | Notes |
|---|---|---|
| `kt:state` | done | the engine's `available`/`reason`, `os`/`arch` in Node's words |
| `kt:engineRetry` | done |  |
| `kt:list` | done | the last list while aria2c is down |
| `kt:add` | done | `o.video` (yt-dlp) refused until P5 |
| `kt:pause` | done |  |
| `kt:resume` | done |  |
| `kt:remove` | done | waits up to 3 s for `forceRemove` |
| `kt:setFiles` | done |  |
| `kt:setUrl` | done |  |
| `kt:move` | done |  |
| `kt:setLimits` | done |  |
| `kt:configure` | done |  |
| `kt:torrentInfo` | done |  |
| `kt:rename` | done | `sniff.cjs` renaming of finished files not ported (P5) |
| `kt:open` | done | «show in folder» now chooses the item where the opener can (P3, `kt_reveal`) |
| `kt:defaultDir` | done |  |
| `kt:roots` | done |  |
| `kt:listDir` | done | shared crate |
| `kt:pathInfo` | done | shared crate |
| `kt:exists` | done | shared crate |
| `kt:siblings` | done | shared crate |
| `kt:readFile` | done | raw bytes → ArrayBuffer (shared crate) |
| `kt:writeText` | done | shared crate |
| `kt:writeTemp` | done | shared crate |
| `kt:writeTempBytes` | done | shared crate |
| `kt:removeFile` | done | shared crate |
| `kt:hashFile` | done | shared crate |
| `kt:openPath` | done | shared crate |
| `kt:openExternal` | done | shared crate |
| `kt:pickDir` | done | shared crate |
| `kt:pickFile` | done | shared crate |
| `kt:saveText` | done | shared crate |
| `kt:clipboardText` | done | shared crate |
| `kt:http` | done | shared crate: since P3 with a cookie jar kept in `<app data>/cookies.txt`, as Electron's session |
| `kt:checkUpdate` | done | shared crate (`tools-v*`, pre-releases) |

### P3 — this stage (8 done)

| Channel | Status | Notes |
|---|---|---|
| `kt:deletePath` | done (P3) | `trash.rs`: Windows SHFileOperationW (shell32), macOS NSFileManager trashItemAtURL (Objective-C runtime), Linux the freedesktop.org Trash spec; then removed, as main.cjs falls back to fs.rm; also answers `trashed` |
| `kt:fontDirs` | done (P3) | kt-core `fontnames::font_dirs` |
| `kt:fontIndex` | done (P3) | kt-core `fontnames::index` (name-table reader, cached by size + time) |
| `kt:megaDecrypt` | done (P3) | kt-core `mega` (AES-128-CTR written here, FIPS-197 / SP 800-38A vectors and Node's output in its tests) |
| `kt:archiveFree` | done (P3) | free space (statvfs / GetDiskFreeSpaceExW, the Reader's code); the other archive channels are P7 |
| `kt:screenFontAdd` | done (P3) | `<app data>/screen-fonts` |
| `kt:screenFontRemove` | done (P3) |  |
| `app:titleBar` | done (P3) | `kt_title_bar` — the Reader's `titlebar.rs` (own bar / system frame, act, `kt:titleBarState`); the page draws it (`src/ui/winbar.ts`, shared) |

### P4 — torrent streaming and the local stream server (7 done — written, waiting for CI)

| Channel | Status | Notes |
|---|---|---|
| `kt:streamUrl` | done (P4) | `streamserver.rs` + the engine trait (`stream_engine.rs`): aria2's in-order fetch (torrentstream.cjs's options, reads wait on aria2's bitfield); librqbit only with `--features rqbit` (hand-over as WebTorrent's) |
| `kt:streamDone` | done (P4) | the download's addresses withdrawn, their waiting readers ended (Electron's aria2 path kept them) |
| `kt:streamStats` | done (P4) | `{ down, up, peers, progress, buffered, engine }` for any download being watched (Electron: only WebTorrent's, else null) |
| `kt:fileUrl` | done (P4) | the same server, `/<token>/f?p=` |
| `kt:audioUrl` | done (P4) | ffmpeg: `<app data>/packs/ffmpeg/` (P5 installs it), else the PATH's; «pack:ffmpeg» without |
| `kt:videoUrl` | done (P4) | transcode.cjs's encoders (card's first, x264 after a failure) |
| `kt:proxyUrl` | done (P4) | the shared web client (cookies, DoH), ranges passed, HLS remuxed by ffmpeg |

### P5 — video tools and packs (17 missing)

| Channel | Status | Notes |
|---|---|---|
| `kt:videoInfo` | missing | yt-dlp spawned from Rust |
| `kt:videoReady` | missing |  |
| `kt:videoVersion` | missing |  |
| `kt:videoUpdate` | missing |  |
| `kt:videoRollback` | missing |  |
| `kt:videoBinary` | missing |  |
| `kt:isVideoHost` | missing |  |
| `kt:galleryList` | missing | gallery-dl |
| `kt:galleryReady` | missing |  |
| `kt:ffmpegAvailable` | missing | ffmpeg pack |
| `kt:ffmpeg` | missing | progress as events |
| `kt:ffmpegCancel` | missing |  |
| `kt:ffprobe` | missing |  |
| `kt:packStatus` | missing | download + SHA-256 |
| `kt:packInstall` | missing |  |
| `kt:packCancel` | missing |  |
| `kt:packRemove` | missing |  |

### P6 — desktop integration (6 done)

| Channel | Status | Notes |
|---|---|---|
| `kt:appIcon` | done (P6 part) | the shared crate's `appicon.rs` + `iconlogic.rs` (the Reader's, moved) with Tools' Spec (`appicon.rs`); cfgs `kt_set_icon`/`kt_default_icon` |
| `kt:mini` | done (P6) | `desktop.rs`: 320×200 (≥260×120), no frame, above the others, off the taskbar, on every desktop (cfg `kt_all_spaces`), its place kept (`mini-state.json`); `auto` opens it when the main window is minimised |
| `kt:desktopPrefs` | done (P6) | `desktop.rs` + `desklogic.rs`: tray, notices, keep-awake, when-done, taskbar progress, the clipboard hotkeys; also takes `labels`, answers `hotkeyErrors` |
| `kt:registerMagnet` | done (P6) | Windows HKCU\Software\Classes\magnet (reg.exe), Linux xdg-mime on the entry that runs this program, a Mac its Info.plist; single instance + launch arguments + Apple Events → the page's `kt:open` |
| `kt:captureUrl` | done (P6) | `sitewin.rs`: a window of its own (profile `<app local data>/signin` on Windows/Linux), navigations + redirects + in-page address polled |
| `kt:siteWindow` | done (P6) | `sitewin.rs`: https only, new windows refused by a script, true once closed |

### P7 — archives, the in-app browser, the screen translator (8 done, 8 missing; `kt:archiveFree` in P3)

| Channel | Status | Notes |
|---|---|---|
| `kt:archiveList` | done (P7) | the shared `archive.rs` (zip/tar read here, 7-Zip for the rest) + `archives.rs`; entry dates |
| `kt:archiveExtract` | done (P7) | whole, in place, or `only` some entries; «cache:» |
| `kt:archiveTest` | done (P7) |  |
| `kt:archiveCreate` | done (P7) | zip |
| `kt:archiveCancel` | done (P7) | a cancel before its job starts is kept for it |
| `kt:archiveRestore` | done (P7) |  |
| `kt:archiveExisting` | done (P7) |  |
| `kt:browse` | done (P7) | `browser.rs` over the shared crate's `browserlogic.rs` (the Reader's, moved): own profile + keeper, the bar, Grab, magnets and downloads to the app with the site's cookies; no content-type sniffing (see «Stage P7 — the in-app browser») |
| `kt:screenConfig` | missing | screen capture + OCR helpers |
| `kt:screenStatus` | missing |  |
| `kt:screenAction` | missing |  |
| `kt:screenJob` | missing |  |
| `kt:screenRegion` | missing |  |
| `kt:screenClose` | missing |  |
| `kt:screenOcrLangs` | missing |  |
| `kt:screenCaption` | missing |  |

### P8 — servers, DoH, antivirus, update install (9 done)

| Channel | Status | Notes |
|---|---|---|
| `kt:shareWifi` | done (P8) | `lanshare.rs` + `lanlogic.rs`: 0.0.0.0, a free port, a 24-hex key; the list page and each file by its number, ranges |
| `kt:shareWifiStop` | done (P8) |  |
| `kt:shareWifiStatus` | done (P8) | `{running, url, sent, hits}` |
| `kt:localApi` | done (P8) | 127.0.0.1 only, port 8977 unless given; the same routes, token (Bearer or ?token=) and CORS |
| `kt:setDoh` | done (P8) | `net::set_doh` with kt-core `dohnames` (Tools' names) |
| `kt:dohProbe` | done (P8) | example.com asked of the resolver in force (`net::doh_lookup`), timed |
| `kt:avScan` | done (P8) | Defender's MpCmdRun / ClamAV's clamscan / the user's program, run directly (no shell), 10 min |
| `kt:avAvailable` | done (P8) |  |
| `kt:installUpdate` | done (P8) | `update.rs` + kt-core `updatelogic.rs` (the Reader's, Tools' names); progress `kt:update-progress` |

### What the Reader's port gives each stage

| Stage | Reused nearly as is | Adapted | Nothing to reuse |
|---|---|---|---|
| P3 | shared crate (`shell`, `files`, `hash`, `net`, `winstate`, `selftest`, `testserver`, `cookiejar`); `titlebar.rs`; `src/ui/winbar.ts` (one file in both apps); free space (`archives.rs`) | `apidetect.rs` (Tools' cfgs) | the file job engine (ported from the Android `KtFileJobs.java`), the recycle bin |
| P4 | `testserver` (Range answers) for the stream tests | `download.rs`/`dlplan.rs` for `proxyUrl` | librqbit, the stream server, the WebTorrent hand-over |
| P5 | — | `download.rs` + `updatelogic.rs` (fetch, SHA-256, replace, roll back) for packs and yt-dlp | yt-dlp / gallery-dl / ffmpeg running and parsing |
| P6 | the notification plugin, single instance, `winbits.rs` (taskbar progress), `menu.rs` (a Mac's menu) | `appicon.rs` + `iconlogic.rs`, `openfile.rs` + `openargs.rs` (magnet, .torrent) | tray, global shortcuts, mini window, keep-awake, when-done |
| P7 | `archive.rs` (moved into the shared crate) + `archives.rs` (and the 7-Zip resources step of its workflow) | `browser.rs` + `browserlogic.rs` | the screen translator (capture, OCR, overlays) |
| P8 | `doh.rs` + `net::set_doh` / `doh_try` | `update.rs` + `installer/*` + `setup/` | Wi-Fi share, local API, antivirus |
| P9 | release.yml's rust-desktop job, SHA256SUMS, asset names | `handover.rs` + `handoverlogic.rs` (settings, download list, library) | — |

Events the preload listens for (`kt:tasks` and `kt:engineState` — done —, `kt:packProgress`, `kt:archiveProgress`,
`kt:ffmpegProgress`, `kt:update-progress`, `kt:hotkeyAdd`, `kt:openTask`, `kt:browser`, `kt:screenCaption`,
`app:titleBarState`, `kt:open`) become Tauri events (`app.emit(...)`, listened to in bridge.js with
`window.__TAURI__.event.listen`, which needs `core:event:default` — already in `core:default`).

## The hard parts

### aria2 (done in stage 2)
See «The download engine» above. Left for later: a Windows Job Object (needs the `windows` crate) as a second guard
besides `--stop-with-process`; the WebSocket notifications (`tokio-tungstenite`) if polling ever proves too slow;
`sniff.cjs`'s renaming of finished files whose name says nothing; the WebTorrent hand-over (`watching`,
`handedOver`), which comes with torrent streaming.

### Torrent streaming (WebTorrent today)
WebTorrent runs in Electron's Node, which Tauri does not have. Options:
1. **librqbit** (Rust BitTorrent library with a built-in HTTP streaming API that prioritises the pieces under the
   reader's position): in-process, no Node, small. Risks: a second BitTorrent engine beside aria2 on the same files
   (the same hand-over as today: pause aria2, stream, `check-integrity` on hand-back — librqbit can be pointed at the
   existing output folder), and its API still moves between minor versions.
2. A **Node/Bun sidecar** running the existing `webstream.cjs` + WebTorrent unchanged: least porting, but it brings a
   JS runtime back (Bun single-file ≈ 50–90 MB, Node SEA ≈ 40–80 MB per platform), which undoes most of the size win.
3. **aria2 alone** with `--bt-prioritize-piece=head,tail` and the existing `torrentstream.cjs`-style range server:
   no new engine, but aria2 cannot jump to the seek position, which is why WebTorrent was added.

Recommendation: librqbit as the streaming engine (option 1), compiled in (a few MB); keep aria2 for downloads and
today's hand-over protocol. Fall back to
option 3 (aria2 head/tail + range server) when librqbit fails on a torrent, so streaming never disappears.

### The in-app browser (`kt:browse`)
Electron gives `will-download`, `webRequest.onCompleted` (every response with headers), cookies, and a custom menu.
Tauri 2's `WebviewWindowBuilder` gives `on_navigation`, `on_page_load`, `on_download` (2.1+), `on_new_window`
(newer 2.x) and `initialization_script`; it has **no** response-headers hook on any OS. Plan:
- downloads: `on_download` → hand the URL to the app (cookies via `Webview::cookies_for_url`, 2.x);
- media sniffing: an initialization script in the browser window that wraps `fetch`/`XMLHttpRequest`, watches
  `<video>/<audio>` `src` and `PerformanceObserver` resource entries, and posts what it sees back through a Tauri
  command — catches what pages load from script, not what the server labels by `content-type` only;
- WebView2 (Windows) does expose `WebResourceResponseReceived` through `with_webview` + the `webview2-com` crate,
  so Windows can match Electron fully; WKWebView and WebKitGTK cannot, so the script path is the cross-platform one;
- the grab-links script (`GRAB_JS`) runs unchanged with `Webview::eval` + a command to return its result.

### The screen translator
Needs: capture of the whole screen (Electron `desktopCapturer`), global shortcuts, a tray, transparent always-on-top
overlay windows, OCR. In Tauri: `xcap` crate for screen capture on all three OSes (macOS needs the Screen Recording
permission, Wayland goes through the portal and is limited), `tauri-plugin-global-shortcut`, the `tray-icon` feature,
transparent windows (`transparent(true)`; macOS needs the `macos-private-api` feature). OCR stays as today: Windows
OCR / macOS Vision / Tesseract through the same helper processes `screentr.cjs` runs. A late stage on its own.

### DoH (`kt:setDoh`, `kt:dohProbe`)
Electron sets Chromium's resolver for every request of the app. The system web views have no such switch. What
the app itself fetches goes through `kt:http` (reqwest), which can take a DoH resolver (`hickory-resolver` with
`dns-over-https-rustls`, plugged in with `ClientBuilder::dns_resolver`); the probe resolves example.com through
it. Requests the page makes itself (images, `fetch`) keep the system's DNS, except on Windows where WebView2 takes
`--enable-features=DnsOverHttps` style browser arguments (`additional_browser_args`) — only at start, not live.

## Stages

The stage names are docs/RUST-PORT.md's (P1–P9); the table above says which channel each brings.

1. **P1 done**: window, bridge, files, dialogs, clipboard, `kt:http`, `kt:checkUpdate`; CI builds and sizes.
2. **P2 done**: the aria2 engine (bundled aria2c, tasks, `kt:tasks` / `kt:engineState` events), `kt:open`, the window's
   size and place kept (`window-state.json` in the app's config folder), the runtime self-test in CI.
3. **P3 done** (CI run 43533929457 green on all four builds; the self-test passed on Linux, Windows and both macOS
   builds): the shared crate, kt-core, API detection, the recycle bin, free space, fonts, MEGA, screen fonts, the Files
   page's jobs, the title bar; then its gaps (storages, new folder, rename, stat, a cancel never lost, local trash
   dates). Left of P3: the preview builds beside each Electron release.
4. **P7 archives, P8 DoH + updater, P6 app icon — written, waiting for CI.** P6's other five channels written since
   (see «Stage P6»), and the in-app browser (P7), waiting for CI. Left of P7: the screen translator (planned above); P8's rest written too (see
   «Stage P8»). P4, P5; P9 the switch-over with the hand-over (and the release job that
   publishes the file names above).
