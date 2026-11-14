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
`kt_selftest_done`, which writes them and exits 0/1; a watchdog exits 2 after `KT_SELFTEST_TIMEOUT` (290 in CI) s.
Since P5 merged CI runs it as **two launches** (`KT_SELFTEST_PART=1`: files, archives, DoH and the updater, the icon,
the video tools; `=2`: the engine, streaming, the Wi-Fi share and local API, the in-app browser, the desktop side),
each under its own watchdog (290 s; the step's outer limit 340 s), so neither half has to fit the whole; unset, one
launch runs all (tests/tauribridge.cjs checks that the two halves add up to the whole). On Linux under
`dbus-run-session`, so the single-instance hand-over has a session bus.
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
  transcode.cjs's arguments word for word (kt-core: `videotools.rs` for /audio and /video since P5 merged,
  `streamlogic.rs` for the remux), ffmpeg found and run as the video tools do, its whole tree ended when its reader
  leaves (see «Stage P5», the transcode stream).
- **Self-test** (`streamtest.rs`, `torrentmake.rs`): required everywhere — a stand-in engine whose pieces the test lets
  in (a read held until its pieces come while the start is served, eight readers at once, 416 / 403 / 404 / OPTIONS,
  stats, streamDone ending a waiting reader, no connection left), `fileUrl`, the audio/video addresses, the proxy
  against the test server, the server stopped with its port free. **The real swarm on loopback — required wherever
  aria2c runs** since CI runs 43543045018 and 43543617161 passed it on every build that ran (Linux, Windows in the
  first, both macOS builds): a private two-file torrent made in the test from made-up bytes (std SHA-1 and bencoding), a
  tracker on 127.0.0.1 naming one peer, a second aria2c bound to 127.0.0.1 seeding at 256 KiB/s (DHT, LPD, PEX off), the
  app's engine fetching it while the page streams start, middle, end and the second file, compared byte for byte. P4's
  reported «AAC from ffmpeg» row (it needed a real ffmpeg; no runner had one) is gone: a self-test run only ever starts
  the app's stand-in ffmpeg, and P5's «transcode stream» row checks the bytes of `/video` and `/audio` on this server.
  Page-level: `tests/streamtauri.cjs`.
- **librqbit**: `cargo check --features rqbit` passed against librqbit 8.1.1 in run 43543045018 (every «GUESS» call
  compiled; in run 43543617161 the step failed only on its own `grep` having nothing to print — fixed with `|| true`). It
  stays behind the feature: no build with it has streamed the swarm yet (see «Stages», 6).

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
`GET /version`, `POST /add`, `POST /tasks/<id>/pause|resume|remove`); `video`/`audio` adds become video jobs (since P5).
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

### The screen translator (`screentr.rs`, `screencap.rs`; rules in kt-core's `screenlogic.rs`) — the last 8 channels

Electron's `desktop/screentr.cjs` (the page: `src/views/screen.ts`, `src/views/overlay.ts`, `src/screen/*` — translation,
lettering, the words taken off the picture, the region drawn, the caption's text: all the page's, nothing of it moved).
**No new crate.** Same channel names, arguments, results and event shapes:
- **Settings / status**: `kt:screenConfig` (kept in `<app data>/screen.json`; the region forgotten on `clearFixed`; keys,
  tray and start-with-the-computer applied again) and `kt:screenStatus` answer Electron's `{ platform, on, keys { action:
  { acc, ok } }, tray, auto, region, ocr }` plus this shell's `capture { kind, why }` and, on a Mac, `permission`
  (`granted` / `denied`) — the page shows a step for each (`scrCapNone` with the system's reason, `scrCapPortal`,
  `scrPermNeed` with a button: `screenAction('permission')`), in five languages; Electron sends neither, so its page is
  unchanged. `kt:screenOcrLangs`: Windows OCR's languages (the same PowerShell script, `-list`), Tesseract's
  `--list-langs`, else `{ kind }`.
- **Keys** (`Alt+Shift+T/F/R/A/C` unless set): one registry with the clipboard hotkeys — desktop.rs's `hotkeys_apply`
  lets every key go, registers the clipboard ones, then `screentr::register_keys`; its handler hands a key that is not a
  clipboard one to `screentr::on_shortcut`. A clash (another program, or a clipboard hotkey) → that key `ok: false`, which
  the page already says. Without the plugin's API, or on Linux without an X display: every key `ok: false`.
- **Tray** (`kt-screen`, its own icon as Electron's): the five actions with their shortcuts shown, «Open the app» (the
  window on `#/screen`), «Quit», in the page's words (`config.labels`); «again» / «auto» greyed without a region; the
  menu made again when the region or «auto» changes. Linux: only with appindicator (desktop.rs's rule). **Close to tray**:
  the main window's close is turned into a hide while `keepInTray()` (on + tray chosen + the icon made) — main.rs's
  window events call `screentr::on_event`. **Start with the computer** (`pc.startup`): Windows' Run key (`reg.exe`, value
  «Kurokawa Tools», `"<exe>" --hidden`), a Mac's launch agent (`~/Library/LaunchAgents/app.kurokawa.tools.screen.plist`),
  none on Linux (as Electron); written or removed only when the choice changes, removed only if this app wrote it. A
  `--hidden` start hides the window only once the tray icon exists (else the app could not be reached).
- **Capture** (`screencap.rs`, the display under the mouse at full resolution, as Electron's thumbnail): Windows GDI
  `BitBlt` + `GetDIBits` (raw FFI to user32/gdi32; physical pixels — the process is per-monitor DPI aware); Linux X11
  `XGetImage` of the root window through libX11 loaded with `dlopen` (on a connection of its own: GTK ignores X errors on
  displays it did not open; the rectangle is kept inside the root window); Linux Wayland: `grim` where installed, else the
  desktop portal's Screenshot through `gdbus` (`gdbus monitor` started first, the request's `Response` read, the picture
  the portal saved removed again; the system may ask the user); a Mac: `/usr/sbin/screencapture -x -R` in points, the
  Screen Recording permission checked with `CGPreflightScreenCaptureAccess` and asked once with
  `CGRequestScreenCaptureAccess` (both looked up with `dlsym`, so older macOS still starts; never a loop: the second time
  the button opens the settings pane). The picture goes to the page as a PNG data: address (kt-core's PNG writer, rows
  «Sub»-filtered, flate2 — already in the build); system PNGs (grim, portal, screencapture) decoded with Tauri's own image
  reader. Monitors and the mouse from Tauri (the main window's `available_monitors` / `primary_monitor`; `cursor_position`
  where build.rs finds it — `kt_cursor` —, else `GetCursorPos` / `XQueryPointer`), the monitor under the mouse as
  Electron's `getDisplayNearestPoint` (`screenlogic::nearest`).
- **Windows** (made hidden, placed in physical pixels, then shown — per-monitor DPI right on mixed monitors): the frozen
  screen `kts-overlay` (#/overlay, `?go=1` for «again»): no frame, on top, not on the taskbar, on every desktop where the
  build has it (`kt_all_spaces`), focused; closed when it loses the focus unless a region is being drawn or
  `closeOnBlur` is off (Electron's rule). «Auto»'s caption `kts-caption` (#/overlay?caption=1): under the region (or over
  it), as wide as it (≥ 260), 120 tall, transparent (not on a Mac — below), **click-through** (`set_ignore_cursor_events`,
  `kt_ignore_cursor`), never focused (`focused(false)`, and `focusable(false)` where the build has it — `kt_focusable`),
  its height from `kt:screenCaption` (40–400). The clipboard's window `kts-popup` (#/overlay?text=1): 420×220 by the mouse,
  kept on the monitor, closed on blur. All three run the page with the bridge (not the self-test); capability
  `capabilities/screen.json` (core only). On Wayland, where no window may place itself, the frozen screen is made full
  screen instead.
- **Reading** (`kt:screenRegion`): the region drawn kept (`screen-region.json`, with its monitor's id), cropped from the
  frozen picture with Electron's arithmetic (`screenlogic::crop_rect`), then the crop for an AI model (`{ ai, offset,
  scale }`) or the same OCR helpers as Electron, run directly (no shell, no console window, 60 s, each one's tree ended
  when «auto» stops or the app ends): Windows OCR through the **same PowerShell script** (`src/kt-ocr.ps1`, cut out of
  screentr.cjs; tests/tauribridge.cjs keeps them equal, as grab.js), Vision through the **same JavaScript for Automation
  script** (`src/kt-ocr.js`, kept equal the same way), Tesseract's TSV; both written to the app's data folder as Electron does. No OCR → `ocr-missing`, which the
  page says.
- **Auto**: a thread per run (a generation counter stops it), every `interval` s (≥ 1), `autoStop` minutes; the region
  taken again off the monitor it was drawn on (Electron took it off the monitor under the mouse at each look), read,
  compared loosely (`screenlogic::loose`), sent as `kt:screenCaption { text }` (`emit_to` the caption where build.rs
  finds it — `kt_emit_to` —, else to all: only the caption listens). The caption closed → «auto» stops.
- **Tests**: `screenlogic.rs` (rustc; Electron's TSV and JSON samples from tests/screenpc.cjs, monitors, regions, the
  caption's and popup's places, «repeat», the loose comparison, the Run key and the launch agent, GDI / X11 pixels, the
  PNG read back, the portal's answers) — CI's «Std-only unit tests (screen translator)» on every system; `apidetect.rs`
  (`detect_tauri_scr`); tests/tauribridge.cjs (the 8 methods, a null region, the caption event; the self-test's screen
  rows against tests/screenfake.cjs); tests/screentauri.cjs (the real bridge.js over a pretend IPC, en and ar: the
  settings page and this shell's steps, the frozen screen, «again», «full», no OCR, the caption, the clipboard; and the
  self-test's rows: all pass, wrong pixels fail them); selftest.js `screen:` rows (part 2) — a window the test draws
  (colour bars, black text on white) captured and compared pixel by pixel, the frozen screen's window and its picture, a
  region's crop through the scale, closed, the OCR reading the drawn text (required on Linux, where CI installs
  Tesseract), OCR languages (reported), «auto»'s caption click-through and unfocused, then stopped with no window and no
  helper left, the clipboard's window, all off at the end — required on Windows and on Linux (X11 under Xvfb), reported on
  a Mac (no Screen Recording permission on its runners). Checked here for real before CI: the X11 capture code (cut out of
  screencap.rs into a harness) under Xvfb gave a drawn window's pixels exactly, its PNG equal to the drawn one, and
  Tesseract read «TOOLS» / «2468» from it through `tsv_lines`; screentr.rs / screencap.rs type-checked against mock
  crates for Windows', Linux's and a Mac's branches (not the real Tauri: its API is guarded by build.rs as above).

## Stage P5: the video tools (written, waiting for its first CI compile)

- **yt-dlp** (`vtools.rs`, kt-core `videotools.rs` + `vidjson.rs`, rule for rule from `ytdlp.cjs`): the release's program for
  this system (`yt-dlp.exe` / `yt-dlp_macos` / `yt-dlp_linux`, Linux ARM `yt-dlp_linux_aarch64`) into `<app data>/bin`,
  resumed (`vtfetch.rs`, the updater's way), checked against `SHA2-256SUMS`; the one in use kept as `yt-dlp.<v>.old`
  (newest three); then — new here — the new program is asked `--version` and one that does not answer is removed and
  the one before put back at once (kt-core `Swap`; the page words the code `kt-video:rolledback:<tool>:<v>` /
  `kt-video:broken:<tool>` — `src/video/ytdlp.ts toolError`, five languages). Updates as `ytdlp.cjs` (once a day; a
  rollback pins; forced from Settings; 15 s after start and every 6 h). The JavaScript runtime: Electron gave its own
  Node; this shell names the first of deno / node / bun on the PATH (`--js-runtimes`), only to a yt-dlp that knows it.
- **Video jobs** (`vtjobs.rs`): kt:add with `o.video` → a task of kind «video» listed after aria2's (kt:list and the
  kt:tasks push — `engine.rs` now hands its list to `vtjobs::emit_tasks`), kept in `video-jobs.json`; the page's argument
  list vetted (kt-core `vet_args`) or a task's older settings built (`job_args`); yt-dlp's lines read into the task
  (`LineReader`: one bar over the streams, phases, fragments; pushed every 400 ms or at a phase change); pause / remove
  end yt-dlp's **whole tree** (Electron killed yt-dlp alone); the bilingual .srt merged when done.
- **gallery-dl**: the release's standalone program (digest checked), asked its version before use; `-j` read by
  `vidjson::gallery_items`.
- **ffmpeg** (`vtffmpeg.rs`): runs, cancel, ffprobe, the pack (resumed, SHA-256, gunzipped beside its marker).
- **Running programs** (`vtproc.rs`, std only): an argument list, never a shell; stdin closed; no console window on
  Windows; a process group of its own off Windows so the group is killed, `taskkill /T /F` on Windows; timeouts.
- **The transcode stream — one server since the merge**: P5 had written `/video` and `/audio` on a loopback server of its
  own (`vtstream.rs`, deleted with the merge); they are now only routes of P4's stream server (`streamserver.rs`: a port
  of the system's choosing, the run's token in every address — 403 without it —, 64 connections at most, stopped at
  quit), as streamproxy.cjs's /p, /f, /audio, /video are one server in Electron. `streamproxy.rs` runs them with P5's
  rules: the arguments from kt-core `videotools.rs` (`transcode_args`, `audio_args`, `encoder_candidates`,
  `encoder_test_args`, the query read by `video_query` / `audio_query`; streamlogic.rs's copies removed, its tests moved
  there), ffmpeg found by `vtffmpeg::binary()` (the pack, else the PATH, a Mac's Homebrew; in a self-test run only the
  pack's stand-in), started by `vtproc::command` (no window, a group of its own) and its **whole tree** ended when the
  reader leaves or the server stops; the card's encoder asked once, x264 after it fails within the same request
  (`X-KT-Encoder` says which). One registration of `kt_video_url` / `kt_audio_url` (streamserver.rs).
- **Self-test** (CI): the app's own executable stands in for yt-dlp, gallery-dl, ffmpeg and ffprobe (`vtfake.rs`: only
  with KT_SELFTEST and KT_FAKE_TOOLS=1, only under those file names; a trailer names its version or «broken»), fetched
  from a loopback release server (`vtselftest.rs`): fetched and resumed → checked → `-J` → a job's phases and file → a
  running job removed with its tree → a failing job → an update (the one before kept) → a broken update rolled back →
  a wrong checksum refused → a rollback by hand → gallery-dl → the pack (wrong checksum, cancel, resumed install) →
  ffmpeg's progress and file → a cancel ending the tree → ffprobe → the transcode stream's and the sound track's bytes
  (through P4's server: its token, a forged one refused; P4's «audioUrl / videoUrl» row checks the same routes' heads).
  `tests/videotauri.cjs` runs those checks against a pretend shell, and the page over the real bridge.
- **The local API's video adds** (P8's `lanshare.rs`): `video` / `audio` in `POST /add` now become video jobs (main.cjs's
  add: `meta.audioOnly`, `bestaudio/best`, the name as the title); `GET /tasks` lists them after aria2's; pause / resume /
  remove reach them by id. **The desktop side** (P6's `desktop::on_tasks`) is handed aria2's list and the video tasks, as
  main.cjs's `onDesktopTasks(allTasks())`.

### CI runs 43545725648 (P5's first compile everywhere) and 43549144577 (the screen translator's first compile)

- Both compiled on all four builds; «KT build:» found cursor_position, set_ignore_cursor_events, focusable and emit_to.
  P5's rows all passed up to the pack's on Windows and Linux (the stand-ins start as `.exe`, trees end, SIGINT works).
- **The pack's row failed on all three systems** with a real ffmpeg (0.18.1, 46–83 MB) already in the run's pack folder:
  the page's first-start helper (`src/desktopStarter.ts`, 4 s after start) installed every add-on and fetched the
  release's real pack from GitHub. A self-test reaches no network: selftest.js now marks the starter done before the page
  runs, and `vtffmpeg::install` refuses a pack from anywhere but 127.0.0.1 in a self-test run. The rows after it (ffmpeg's
  run, cancel, ffprobe, the transcode stream, the pack removed) never ran there yet.
- **Linux, screen**: the test's window showed only GTK's grey (246,245,244) — WebKitGTK painted nothing of about:blank and
  its script —, so the capture, frozen-screen, crop and OCR rows failed. The test page is now a data: address on Linux
  and «draw» waits until a red pixel is on the screen (8 s; then a size nudge; then hidden and shown again), saying
  which helped; the reported row «a window made hidden, then shown, paints without help» tells whether the app's own
  hidden-made windows (frozen screen, caption, clipboard) need the same.
- **Windows, screen**: the caption took the focus (a shown window is activated): the window in front before is given the
  focus back (GetForegroundWindow / SetForegroundWindow); the clipboard's window now closes on a loss of focus only after
  it had the focus and still lacks it 200 ms later; the «auto» row stops «auto» whatever fails, so a failure no longer
  leaves the caption running beside the next rows (the popup's timeout followed that one).
- Reported only: Linux «kept awake» (systemd-inhibit refused on the runner: no logind authorisation, exit 1); a Mac's
  screen rows (white pixels; Vision read the system's local-network prompt).

## The 98 channels (stocktaking, P3)

Every `ipcMain.handle` of `../desktop` (89 in main.cjs, 8 in screentr.cjs, 1 in titlebar.cjs), grouped by the stage of
docs/RUST-PORT.md that brings it. **done**: in bridge.js and a Rust command; **missing**: absent from bridge.js (the page
asks for each feature by its method, so nothing is a stub). Counts: P1–P2 35 done · P3 8 done · P4 7 done · P5 17
done · P6 6 done · P7 8 done + the screen translator's 8 (`kt:archiveFree` counted in P3) · P8 9 done —
**98 of 98 written**: 90 as before (P4, P6, the browser and P8 compiled and passed in CI; P5's and the screen translator's compiled on all four builds in run 43545725648 / 43549144577 with their fixes written after those runs, not yet re-run), and P9 (hand-over, setup program) written only, waiting for its first compile. Besides these, the shell has its own (no Electron channel): the Files page's jobs `filesJob` / `filesCancel` /
`filesAnswer` / `onFilesJob` (P3), `homeDir` / `filesRoots` / `filesStat` / `filesMkdir` / `filesRename` (after P3),
`updateDownload` / `updateInstall` (P8).

### P1–P2 — done before this pass (35)

| Channel | Status | Notes |
|---|---|---|
| `kt:state` | done | the engine's `available`/`reason`, `os`/`arch` in Node's words |
| `kt:engineRetry` | done |  |
| `kt:list` | done | the last list while aria2c is down |
| `kt:add` | done | `o.video`: a yt-dlp job (P5, `vtjobs.rs`) |
| `kt:pause` | done |  |
| `kt:resume` | done |  |
| `kt:remove` | done | waits up to 3 s for `forceRemove` |
| `kt:setFiles` | done |  |
| `kt:setUrl` | done |  |
| `kt:move` | done |  |
| `kt:setLimits` | done |  |
| `kt:configure` | done |  |
| `kt:torrentInfo` | done |  |
| `kt:rename` | done | `sniff.cjs` renaming of finished files not ported |
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

### P4 — torrent streaming and the local stream server (7 done; compiled and passed in CI run 43543045018)

| Channel | Status | Notes |
|---|---|---|
| `kt:streamUrl` | done (P4) | `streamserver.rs` + the engine trait (`stream_engine.rs`): aria2's in-order fetch (torrentstream.cjs's options, reads wait on aria2's bitfield); librqbit only with `--features rqbit` (hand-over as WebTorrent's) |
| `kt:streamDone` | done (P4) | the download's addresses withdrawn, their waiting readers ended (Electron's aria2 path kept them) |
| `kt:streamStats` | done (P4) | `{ down, up, peers, progress, buffered, engine }` for any download being watched (Electron: only WebTorrent's, else null) |
| `kt:fileUrl` | done (P4) | the same server, `/<token>/f?p=` |
| `kt:audioUrl` | done (P4+P5) | a route of the stream server (`/<token>/audio`); P5's ffmpeg rules (`vtffmpeg::binary()`: the pack, else the PATH / Homebrew); «pack:ffmpeg» without |
| `kt:videoUrl` | done (P4+P5) | the same server (`/<token>/video`): transcode.cjs's encoders (card's first, x264 after a failure), kt-core videotools' arguments |
| `kt:proxyUrl` | done (P4) | the shared web client (cookies, DoH), ranges passed, HLS remuxed by ffmpeg |

### P5 — video tools and packs (17 done — written, waiting for CI)

| Channel | Status | Notes |
|---|---|---|
| `kt:videoInfo` | done (P5) | `vtools.rs`: `-J` (90 s), kt-core `vidjson::normalise` |
| `kt:videoReady` | done (P5) | fetched when missing / older than 2025.01.01; progress `kt:update-progress` (what: yt-dlp) |
| `kt:videoVersion` | done (P5) | asked once per file (path, size, time) |
| `kt:videoUpdate` | done (P5) | forced; the one before kept as `yt-dlp.<v>.old` (three); a new one that does not start rolled back at once (`kt-video:rolledback:…`, worded by the page) |
| `kt:videoRollback` | done (P5) | the newest kept copy put back, pinned |
| `kt:videoBinary` | done (P5) | the user's own program when it exists |
| `kt:isVideoHost` | done (P5) | kt-core `is_video_host` (ytdlp.cjs VIDEO_HOSTS) |
| `kt:galleryList` | done (P5) | gallery-dl `-j --no-download` (120 s), kt-core `vidjson::gallery_items`; none on a Mac (no standalone build — Electron fetched Linux's) |
| `kt:galleryReady` | done (P5) |  |
| `kt:ffmpegAvailable` | done (P5) | `vtffmpeg.rs`: the pack's, else the PATH's (a Mac also Homebrew's) |
| `kt:ffmpeg` | done (P5) | progress `kt:ffmpegProgress` (300 ms); «pack:ffmpeg» when there is none |
| `kt:ffmpegCancel` | done (P5) | SIGINT, the tree ended 3 s later (Windows: at once) |
| `kt:ffprobe` | done (P5) | beside the ffmpeg in use, else the PATH's |
| `kt:packStatus` | done (P5) |  |
| `kt:packInstall` | done (P5) | resumed (six tries), SHA-256, gunzip; `kt:packProgress` |
| `kt:packCancel` | done (P5) |  |
| `kt:packRemove` | done (P5) |  |

### P6 — desktop integration (6 done)

| Channel | Status | Notes |
|---|---|---|
| `kt:appIcon` | done (P6 part) | the shared crate's `appicon.rs` + `iconlogic.rs` (the Reader's, moved) with Tools' Spec (`appicon.rs`); cfgs `kt_set_icon`/`kt_default_icon` |
| `kt:mini` | done (P6) | `desktop.rs`: 320×200 (≥260×120), no frame, above the others, off the taskbar, on every desktop (cfg `kt_all_spaces`), its place kept (`mini-state.json`); `auto` opens it when the main window is minimised |
| `kt:desktopPrefs` | done (P6) | `desktop.rs` + `desklogic.rs`: tray, notices, keep-awake, when-done, taskbar progress, the clipboard hotkeys; also takes `labels`, answers `hotkeyErrors` |
| `kt:registerMagnet` | done (P6) | Windows HKCU\Software\Classes\magnet (reg.exe), Linux xdg-mime on the entry that runs this program, a Mac its Info.plist; single instance + launch arguments + Apple Events → the page's `kt:open` |
| `kt:captureUrl` | done (P6) | `sitewin.rs`: a window of its own (profile `<app local data>/signin` on Windows/Linux), navigations + redirects + in-page address polled |
| `kt:siteWindow` | done (P6) | `sitewin.rs`: https only, new windows refused by a script, true once closed |

### P7 — archives, the in-app browser, the screen translator (8 done, 8 written and waiting for CI; `kt:archiveFree` in P3)

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
| `kt:screenConfig` | written (screen translator) | `screentr.rs`: kept in `screen.json`; keys (one registry with the hotkeys), tray, start with the computer applied |
| `kt:screenStatus` | written (screen translator) | Electron's shape + `capture { kind, why }`, a Mac's `permission` |
| `kt:screenAction` | written (screen translator) | region / full / repeat / auto / clipboard, and this shell's `permission` |
| `kt:screenJob` | written (screen translator) | the frozen screen as a PNG data: address (`screencap.rs`: GDI, X11, grim / portal, screencapture) |
| `kt:screenRegion` | written (screen translator) | Electron's crop; the same OCR helpers (PowerShell Windows OCR, Vision JXA, Tesseract TSV) or the crop for AI |
| `kt:screenClose` | written (screen translator) |  |
| `kt:screenOcrLangs` | written (screen translator) |  |
| `kt:screenCaption` | written (screen translator) | the caption's height; the `kt:screenCaption { text }` event to the click-through caption |

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
Done without a capture crate (the earlier plan named `xcap`): each system's own facility, called directly — see «The
screen translator (`screentr.rs`, …)» above. OCR as Electron's: the same helper processes.

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
4. **P4, P6, the in-app browser (P7), P8 — compiled and passed**: P4 in CI run 43543045018 (all four builds; the
   self-test passed everywhere, the swarm too); P6 + browser + P8 in run 43543617161 on Linux and both macOS builds
   (Windows stopped at the web step — tests/tauribridge.cjs compared grab.js with Windows' CRLF; fixed —, so Windows has
   not compiled P6/P8/the browser yet). Fixed from that run's reported rows: the notification plugin's own page script
   was refused `is_permission_granted` on every load (now `notification:default`, as the Reader's); the keep-awake row
   raced the downloads' own rule (held off during the row now) and says why a Linux inhibitor ended; the second-launch
   row says what that launch printed, and Linux's self-test has a session bus of its own.
5. **P5 — compiled on all four builds in run 43545725648** (its pack row fixed since, not re-run): 17 channels; the transcode stream joined P4's
   server. The screen translator's 8 channels written after it (`screentr.rs`, `screencap.rs`, kt-core `screenlogic.rs`; first
   compiled on all four builds in run 43549144577, fixes since not yet re-run). **All 98 of 98 channels are now written.**
6. **Left before P9** (the switch-over with the hand-over, and the release job that publishes the file names above):
   Windows' first compile of P6/P8/the browser, a green re-run of P5 and the screen translator after the fixes of run
   43549144577; a build with
   `--features rqbit` streaming the swarm before librqbit is switched on; the losses below decided.
7. **P9 — prepared, switch OFF** (written, waiting for its first CI compile; see «Stage P9» below): the hand-over (Electron
   writes, the Rust build carries the engine's files before aria2c starts and brings the rest at its first start), the
   bridge flow behind `RUST_SWITCH = false`, the installer's one screen and keep/replace hooks, the designed setup
   program (a checked copy of the Reader's), the first-run screen, CI's installer / setup / hand-over steps, and the
   release wiring as a patch (not applied).

## Known losses against Electron (so far)

- **A notice's click** (P6): the plugin gives no click on a computer; the window brought to the front within two
  minutes opens the download instead.
- **Media told by content type** (P7 browser): no system web view gives response headers; Grab finds media by address,
  by the page's elements and by resource timing — media a server marks only by `Content-Type` is missed.
- **yt-dlp's JavaScript runtime** (P5): Electron handed yt-dlp its own Node; this shell names the first of deno / node /
  bun on the PATH (`--js-runtimes`). With none, yt-dlp goes on but warns «No supported JavaScript runtime could be
  found … YouTube extraction without a JS runtime has been deprecated, and some formats may be missing», its signature
  and «n» challenges unsolved, so YouTube's formats thin out or vanish. Proposed: a «deno» pack beside the ffmpeg pack
  (the same fetch, SHA-256 and marker; one program per system), offered in the page's words when yt-dlp prints that
  warning. Until then the user is told nothing.
- **Far seeks in a torrent** (P4): aria2 fetches in order (head 16 MiB, tail 4 MiB first), so a seek far ahead waits for
  the fetch to get there; WebTorrent fetched that place first. librqbit, behind its feature, is the cure.
- **Finished files renamed by sniffing** (`sniff.cjs`): not ported.
- **DNS over HTTPS for the page's own requests**: the system web views keep the system's DNS (see «DoH»).
- **The Wi-Fi share's address**: the default route's IPv4, not the interface list by name.
- **Close to tray**: only with the screen translator, as in Electron (ported: see below).
- (Screen translator.) **Over full-screen programs**: Electron put its windows at the «screen-saver» level, above a
  full-screen game or video (a Mac's full-screen spaces too); Tauri's `always_on_top` is the ordinary top level, so a
  program in exclusive full screen may stay above the frozen screen and the caption — borderless/windowed full screen is
  fine.
- (Screen translator.) **A Mac's caption is not transparent**: a transparent web view needs Tauri's `macos-private-api`
  (a Cargo feature and `app.macOSPrivateApi` in tauri.conf.json, not App Store safe); left off, the caption keeps the
  page's own dark box on an opaque window. Turning it on is two lines if wanted.
- (Screen translator.) **What GDI cannot see** (Windows): a game in exclusive full screen or a DRM-protected video comes
  out black, as some do with Electron's capturer; the lock screen and elevation prompts cannot be taken at all.
- (Screen translator.) **Wayland**: no window may place itself, so the caption is put where the compositor likes and the
  frozen screen is made full screen; each capture goes through grim or the desktop portal (which may ask the user — then
  «auto» asks often); the global shortcuts work only while an X11 program has the keyboard (the plugin grabs through X).
  An X11 session works as on Windows.
- (Screen translator.) **«Auto» on several monitors**: the region is taken off the monitor it was drawn on (Electron took
  it off the monitor under the mouse at each look — a fix, not a loss).
- **(P9) At the switch-over, once**: sites' sign-ins in the sign-in window and the in-app browser are asked again
  (cookies stay in Electron's encrypted profile; AniList and the debrid key are tokens and cross); yt-dlp, gallery-dl and
  the ffmpeg / mpv packs are downloaded again when first needed; the window opens at its default size once.
- **(P9) Start-up not timed**: the Reader's `boot.rs` (first paint, ready, the window in the theme's colour before the
  page paints) has no Tools copy yet.

## Stage P9 — the switch-over, prepared (the switch stays OFF)

The owner's decisions, as the Reader's 0.62.0 took them: the Rust build becomes the main download; updating keeps the
person's data intact; backups (Settings → the settings file, `src/backup.ts`) restore in either build; the designed
Material 3 setup program and a fast first run; the same title bar and icon system; Electron stays downloadable as
«previous build» for two versions; nothing of the person's is ever deleted; a manual install over an Electron copy
with no verified hand-over keeps the old program side by side. The web view's profile cannot be shared (Electron's page
lives at `app://` in its own Chromium, the Rust build's at `http://tauri.localhost` / `tauri://localhost` in the
system's web view), so the data is **handed over**: the LAST Electron build (the bridge build, published under the old
asset names so every Electron updater fetches it) writes it into a folder before it installs the Rust build; the Rust
build takes the download engine's part before its engine first starts and offers the rest on its first start.

### What a Tools user has, and how each part crosses

Electron's data folder (`userData`): installed — `%APPDATA%\Kurokawa Tools`, `~/Library/Application Support/Kurokawa
Tools`, `~/.config/Kurokawa Tools`; the portable .exe uses the same; `electron .` (CI) — `…/kurokawa-tools-desktop`.
The Rust build's: `<app data>` = `%APPDATA%\app.kurokawa.tools`, `~/Library/Application Support/app.kurokawa.tools`,
`~/.local/share/app.kurokawa.tools`; `<app config>` the same folder on Windows and Linux' config dir; its web view's
profile under `%LOCALAPPDATA%\app.kurokawa.tools\EBWebView`, WebKit's `…/WebsiteData`, WebKitGTK's data folder.

| What (from the code) | Electron | Rust build | How it crosses |
|---|---|---|---|
| Settings — `kt.settings` (theme, accent, language `kr.lang`, direction `kr.dir`, downloads folder, connections, DoH, update channel and cadence, add-ons on, desktop prefs: tray, keep-awake, when done, hotkeys) | localStorage | localStorage | `handover/local.json`: **every key** but `kt.handover.*`, `kt.rustSwitch.*` and `kt.update.file` (a downloaded installer's path in the old build's temp folder). Applied at the reload (DoH, tray, hotkeys are read from settings at start) |
| The library's lists: anime (`kt.anime.listStatus`, `.diary`, `.studios`, fillers, art…), TV (`kt.tv.watchlist`, `.seen`, `.schedMine`…), videos (`kt.videos.*`, `kt.videoArchive`), follows, notes, courses, the Files page's bookmarks and trash list, Grab projects, trackers, search histories, the recorder's log | localStorage | localStorage | the same file, copied as they are |
| Watch progress, the player's memory and subtitle choices (`kt.player.memory`, `kt.player`, `kt.subPacks`, `kt.stream.*`, `kt.watchedTasks`, `kt.watchPick`) | localStorage | localStorage | the same file |
| Accounts and tokens: AniList (`kt.anilist.token`, `.user`), the debrid key, trackers, the Wi-Fi share's user, the local API's token | localStorage | localStorage | the same file — kept, unlike the settings backup the person shares (it never leaves this computer and its user's own data folder); never printed, never in a log |
| The database `kurokawa-tools`: `meta` (add-on manifests, versions, children, saved subtitle translations `subtr:*`), `files` (add-ons' code `addon:*`, fonts `font:*`, providers), `history` | IndexedDB | IndexedDB | `handover/idb.jsonl` (meta + history, record by record, keys kept; dates, bytes, odd numbers and pictures by tagged stand-ins) + `files/<n>` (8 MiB pieces both ways) + `handover/files.json` |
| Downloads in progress: aria2's session (`aria2.session`), the app's notes on each download (`tasks.json`: name, source, added/done times, renames), the engine's settings (`aria2-config.json`), the DHT's nodes (`dht.dat`, `dht6.dat`) | userData | `<app data>`, the same names | `engine/*` — **put in place by the Rust build before its engine starts** (`handover.rs engine_prestart`), once per hand-over and only when it has no downloads of its own; the downloads that were moving go on by themselves, the ones the person paused stay paused |
| The downloaded files, partial files and aria2's `.aria2` control files; `.torrent` files aria2 saved for magnets | the person's download folders | the same folders (`<Downloads>/Kurokawa` by default, as Electron's) | **not moved, not copied**: the session names them where they are; aria2 here takes each up from its control file |
| Torrents and their state (pieces, selected files, seeding choice) | aria2's session + control files | the same | as above. A torrent being **streamed** at the switch: the bridge build ends every stream first (`webstream.cjs stopAll` hands it back to aria2 with `check-integrity`, as closing the player does), then pauses; the Rust build's aria2 resumes it from the file and its control file — pieces WebTorrent fetched while watching are kept by that check |
| Video jobs (yt-dlp, gallery-dl) — `video-jobs.json`; their `.part` files | userData; download folders | `<app data>/video-jobs.json` | `engine/video-jobs.json` with the engine's files; a job that was running comes back paused (both builds' loaders do that) and yt-dlp continues its `.part` |
| yt-dlp, gallery-dl (`userData/bin`), the ffmpeg / mpv packs (`userData/packs`) | userData | `<app data>/bin`, `<app data>/packs` | **not carried: fetched again when first needed** (each build checks its own downloads and markers; an unverified program is never copied into the new one) — tens of MB once |
| Screen translator: its settings (`screen.json`), last region (`screen-region.json`), its own fonts (`screen-fonts/*`) | userData | `<app data>/screen-fonts` (P3) | fonts → `shell/screen-fonts/<n>` with their names in `shell/screen-fonts.json`, copied in under their own names at the Rust start; `kt.screen`'s font paths moved to the new folder by the page; `screen.json` and the region kept in the hand-over for the screen translator's stage (not ported yet) |
| The custom icon (`custom-icon.png` + `.ico`) | userData | `appicon.rs`'s file | `shell/custom-icon.png` kept; restored through `appIcon({ set })` from `app.icon` (localStorage) |
| Window state (`window-state.json`), the mini window's (`mini-state.json`) | userData | `<app config>/window-state.json`, `mini-state.json` | kept in `shell/`, not applied (the first window opens at the default size once) |
| The title bar's choice | localStorage / `titlebar.json` | `<app config>/titlebar.json` | the page's setting crosses; the shell's file is made again |
| Cookies and sessions (sign-in windows, the in-app browser, the app's own requests) | Chromium's profile (encrypted by the system's key store) | `cookies.txt` (P3), the browser's profile (P7) | **not carried**: a site asks to sign in again once (AniList and the debrid service are tokens: they cross) |
| Cache Storage, the HTTP cache, service worker caches | the profile | — | not carried: fetched again |
| Shared-file lists (the Wi-Fi share's picks) | in memory | in memory | nothing to carry (a share ends with the app) |
| Hotkeys | `kt.settings` (desktop prefs) | the same | crosses with the settings; re-registered at start |
| The `kurokawatools://`, `magnet:` links and `.torrent` files | registry (Windows), `.desktop` (Linux) | Tauri's installer / `kt:registerMagnet` | moved to the new program by the installer **only when it replaces the old one**; kept as they were when the old one stays (below) |

### The folder

`<userData>/handover/` — written by `desktop/handover.cjs` (an adapted copy of the Reader's: the Writer is the same,
`tests/shared-copies.cjs` keeps it so) for the page (`src/handover.ts makeHandover`):

    handover/local.json, idb.jsonl, files.json   localStorage, the database's records, its kept files' index
    files/<n>, blobs/<n>                          kept files (8 MiB pieces), pictures and bytes inside records
    engine/aria2.session, tasks.json, aria2-config.json, dht.dat, dht6.dat, video-jobs.json, moving.json
    shell/custom-icon.png, window-state.json, mini-state.json, screen.json, screen-region.json,
          screen-fonts/<n>, screen-fonts.json
    marker.json      written last: { app: "KurokawaTools", kind: "handover", format: 1, id, createdAt,
                     from: { shell, platform, version, portable, userData }, counts, bytes, files: [{ rel, size, sha256 }] }

The Reader's rules hold: everything into `handover.part/`, each file hashed as it arrives, read back and hashed again,
flushed; the page reads the records back and compares; the marker written (temp, flush, rename); only then
`handover.part` → `handover` (an older one replaced at that moment). Broken off anywhere: no marker, no hand-over.
Space: `statfs` against the database's size (or the origin's usage) + 2 % + 256 MB; short → nothing written, said;
unknown → the estimate shown and «Go on» asked. Pointers: `<Rust app data>/handover-from.json`, and beside a portable
.exe `KurokawaTools-handover.json`.

**The engine's part** (`kt:handover-engine`, after the page's own files): every stream ended (`webstream.cjs stopAll`),
the ids of the downloads that are active or waiting noted, `pauseAll` (then `forcePauseAll` after 8 s if a torrent is
still saying goodbye to its trackers), `saveSession` awaited, the files copied, `engine/moving.json` written. If the
hand-over then fails or is cancelled, or the switch does not happen (a checksum refused, a download broken), the
paused downloads are set going again (`unpause` of exactly those). After a hand-over that worked, a portable copy and a
Mac (whose disk image is only opened) **keep them paused**: the new copy takes them up from the same files, and two
engines must never write one download at once.

**The Rust build** (`src-tauri/src/handover.rs`, rules in kt-core `handoverlogic.rs` — the Reader's functions, Tools'
names, checked equal by `tests/shared-copies.cjs` — plus Tools' own: `ENGINE_FILES`, `engine_target_empty`,
`session_gids`, `session_unpause`, `parse_moving`, `font_name_ok`, `electron_has_data`, `old_decision`):
`engine_prestart` runs in `main.rs` setup **before** the video tools and the engine read their files: the first whole
hand-over found (KT_HANDOVER_FROM, the pointers, Electron's default folders); not taken before (`handover-engine.json`
names its id); the engine's files and the fonts checked by SHA-256 (damaged → `damaged`, nothing copied); this build
has downloads of its own → `kept-own`, nothing copied (the old list stays where it was); else copied (temp + rename),
the session with ` pause=true` taken off the moving downloads' entries → `carried` with the counts. Never fails the
start. Commands (`window.kurokawaHandover`, `handover-bridge.js`): `kt_handover_find` (+ `engine`, `dataDir`;
`electron: { library, program }` when none), `kt_handover_verify`, `kt_handover_read` (ranges), `kt_handover_mark`,
`kt_handover_free` (only a folder named `handover` with its marker), `kt_handover_open_old`; CI's
`kt_handover_check_progress` / `_done` (KTH_SELFTEST, `handovercheck.js`).

**The page** (`src/handover.ts restoreHandover`): into an empty profile (no history, kept file, add-on or list) it is
COPIED — every key and record as it was, the icon put on the window, `kt.screen`'s font paths moved —; into a profile
with things of its own it is MERGED (only what is missing added; its own values kept). The offer
(`ui/handoversheet.ts`): what it holds («Settings: n · Lists: n · Add-ons: n · Downloads: n», «العدد: n» in Arabic),
its size, the downloads already here, where the old data stays; «Bring it now» with its progress, then «Free the space»
(asks first; deletes the copy only — never Electron's folder, never a download) and «Continue» (reload). «Not now»:
declined, not offered at the start again; Settings → About has «Bring my data from the previous version» and «From a
folder…» (the Tauri build only).

### The Electron side (`desktop/main.cjs`, the `RUST_SWITCH` block)

`RUST_SWITCH = false` in this stage: nothing changes for Electron users (the hand-over's IPC channels and
`window.kurokawaHandover` exist but nothing calls them; `kt:rustSwitchInfo` answers null; the page's offer timer finds
nothing). With it true (the bridge build): `rustswitch.cjs` (the Reader's, Tools' tags `tools-v*`, GitHub's pre-release
mark not read — every Tools release has it) picks the newest release of this version or newer with this system's
Tauri file; the page (`src/rustswitch.ts`) offers it in its own sheet 20 s after the start («Move now» / «Not now»,
asked again after a day, a week with weekly checks, at once for a newer version); «Move now», or «Download and install»
in Tools' own update sheet, reaches `kt:installUpdate` → `rustSwitch`: (1) `Handover.prepare()` — the page's
`handoverBeforeInstall()` with its progress sheet — nothing else unless it answers ok; (2) the file downloaded and
checked (size; SHA-256 from GitHub's digest and/or the release's SHA256SUMS — both must agree; none → refused);
(3) Windows: `/P /R` and quit; Linux AppImage: replaced and restarted; a Mac: the disk image opened. Every refusal is a
`kt-update:<code>` the page turns into words (`switchErrorText`: handover, portable-ready, mac-opened, checksum, size,
nochecksum, norelease) — inside Electron's «Error invoking remote method …», which the page now searches rather than
anchors. `kt:installUpdate('rust-switch')` never falls back to an Electron update.

### Installer, setup program, first run

- **`installer/`** — `onepage.cjs` (the Reader's, names in comments only), `onepage.nsh` (Tools' kinds: «Open .torrent
  files and magnet links with Kurokawa Tools» takes back `.torrent` → `Torrent` and the `magnet` / `kurokawatools`
  links when unticked, only where they name this program), `onepage-lang.nsh` (five languages), `hooks.nsh`: the
  Electron install found by its uninstall entry (DisplayName «Kurokawa Tools», `resources\app.asar` and «Kurokawa
  Tools.exe» in its InstallLocation) or `%LOCALAPPDATA%\Programs\Kurokawa Tools`; **KR_OLD_DECISION** — `/KROLD=` wins;
  else replace when `%APPDATA%\Kurokawa Tools\handover\marker.json` is there, keep when its Local Storage, IndexedDB or
  tasks.json is there, replace when none is (a copy never opened). **Kept**: its program, entry and data untouched, and
  the links and `.torrent` kind PREINSTALL read are written back where they named the Electron program (Tauri's
  install had pointed them at the new one). **Replaced**: shortcuts (desktop, pinned, Start menu) re-pointed, the links
  and `.torrent` made the new program's, its program folder removed (retried, else at restart), its entry removed;
  its data folder never touched, its uninstaller never run. `KR_TRACE` with `KR_INSTALL_TRACE` as the Reader's.
  `tauri.conf.json` `bundle.windows`: per user, five languages, LZMA, WebView2 bootstrapper, the hooks.
- **`setup/`** — the designed setup program, a **copy** of the Reader's `setup/` (lifting it into a shared folder would
  have meant changing the released Reader's crate paths and CI; `tests/shared-copies.cjs` keeps the copy equal:
  `setup.js`, `setup.css`, `index.html`, `tauri.conf.json` the same apart from the names; every Rust function the same
  but `electron_data` (Tools' data rule); `words.js` the same keys in the same five languages). Its `build.rs` reads the
  Reader's `apidetect.rs` / `bootdetect.rs` in place (one source); `KR_SETUP_APP_EXE` names the program Tauri's
  installer puts in place (CI reads `MAINBINARYNAME` from the rendered script; «Kurokawa Tools.exe» by default).
- **First run** (`src/ui/firstrun.ts`, the Tauri build only, once per profile, never under the self-test, the hand-over
  check or a test driver): the language (five), the look (System / Light / Dark), «Your data from the previous
  version» (the hand-over's offer IS the tile; none found but the old copy's data there → «open the previous Kurokawa
  Tools once and let it update», with a button when its program is found), «Torrents and magnet links» (the shell's
  `registerMagnet`, only when pressed), «Start». One screen; the offer alone when the first run was done before.
  Not yet: the Reader's boot timing (`boot.rs`: first paint, ready, the window's colour before the page paints) — Tools
  has no `boot.rs`; the start is not timed in CI.

### Tests

`tests/handover.cjs` (Chromium, the built app; desktop/handover.cjs's real `install()` over a pretend ipcMain and a
pretend aria2, the Rust side's rules in Node): a full disk refused (nothing written, nothing paused); unknown space
asked (Cancel → nothing; «Go on» → made); a write broken at the check → no hand-over, the paused downloads going again;
made: marker, hashes, pointer, the engine paused after the streams ended, its session saved, `moving.json`; the partial
download and its `.aria2` untouched; a killed write leaves only a part folder; the Rust start: the engine's files in
place (moving going, the person's paused one paused), the screen font under its own name, the offer with its counts,
brought (a 17 MiB file in three pieces), every key / record / file the same (deep compare), the icon, marked, not
offered again, not taken twice; damaged refused, truncated not offered; «kept-own»; «Not now»; a merge keeping the
profile's own; a picked folder; «Free the space» only the copy. `tests/firstrun.cjs` (en/ar, light/dark; the Electron
offer with Playwright's clock). `tests/installerpatch.cjs`, `tests/updatenames.cjs` (+ the switch's names and picking),
`tests/setupui.cjs` (the setup page: every state in en/ar, light/dark), `tests/shared-copies.cjs` (the copies). Std
only: kt-core `handoverlogic.rs` (8 tests), `setup/src-tauri/src/logic.rs` (13). CI (`tauri-check.yml`, the «stage P9»
steps): the checks above on every system; the one-page installer, the setup program and the portable zip (Windows);
`installtest.ps1` (an Electron install kept with its links, then replaced after a marker; the installed app's self-test;
an update over it as the updater runs it; uninstall keeping the data); `setup/setuptest.ps1`; the hand-over for real
(`tests/handover-electron.cjs` — the real Electron Tools with a moving and a paused download from a loopback server —,
then the Tauri build with `KTH_SELFTEST`, `handovercheck.js`): Windows required, Linux reported.

### What to flip at the switch-over (and what stays)

1. The screen translator's 8 channels (written, compiled once in run 43549144577; a green re-run still due) and the
   losses listed under «Known losses» decided.
2. A green CI run of this stage on all systems (its first compile: `handover.rs`, `main.rs`'s block, the setup crate
   under Tools' paths).
3. `desktop/main.cjs`: `const RUST_SWITCH = true;` (the bridge build).
4. `git apply` the release patch (`release-tools.yml`: the `rust-desktop` job, SHA256SUMS, the notes' table, the
   Electron jobs kept as «previous build»; the paths filter takes `shared/shell-rs/**` again).
5. The version: a minor bump (`apps/tools/package.json`, `desktop/package.json`), the notes `docs/notes/NEXT-rust.md`
   renamed to that version.
6. Two versions later: the Electron jobs removed from `release-tools.yml` (keep `desktop/` in the repository).
