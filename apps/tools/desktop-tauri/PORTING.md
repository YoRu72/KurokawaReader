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

## Stage P5: the video tools (written, waiting for CI)

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
- **The transcode stream** (`vtstream.rs`): `/video` (H.264/VP9 as it plays, the card's encoder tried once, x264 after a
  refusal within the same request) and `/audio` on a loopback server of its own — **to be merged with P4's Range server**
  (streamproxy.cjs's /p, /f, /audio, /video are one server in Electron).
- **Self-test** (CI): the app's own executable stands in for yt-dlp, gallery-dl, ffmpeg and ffprobe (`vtfake.rs`: only
  with KT_SELFTEST and KT_FAKE_TOOLS=1, only under those file names; a trailer names its version or «broken»), fetched
  from a loopback release server (`vtselftest.rs`): fetched and resumed → checked → `-J` → a job's phases and file → a
  running job removed with its tree → a failing job → an update (the one before kept) → a broken update rolled back →
  a wrong checksum refused → a rollback by hand → gallery-dl → the pack (wrong checksum, cancel, resumed install) →
  ffmpeg's progress and file → a cancel ending the tree → ffprobe → the transcode stream's and the sound track's bytes.
  `tests/videotauri.cjs` runs those checks against a pretend shell, and the page over the real bridge.

## The 98 channels (stocktaking, P3)

Every `ipcMain.handle` of `../desktop` (89 in main.cjs, 8 in screentr.cjs, 1 in titlebar.cjs), grouped by the stage of
docs/RUST-PORT.md that brings it. **done**: in bridge.js and a Rust command; **missing**: absent from bridge.js (the page
asks for each feature by its method, so nothing is a stub). Counts: P1–P2 35 done · P3 8 done · P4 5 missing, 2 written in P5 (`kt:audioUrl`, `kt:videoUrl`) · P5 17
written · P6 1 done, 5 missing · P7 7 done, 9 missing (`kt:archiveFree` counted in P3) · P8 3 done, 6 missing — **54 of 98
done**. Besides these, the shell has its own (no Electron channel): the Files page's jobs `filesJob` / `filesCancel` /
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

### P4 — torrent streaming and the local stream server (7 missing)

| Channel | Status | Notes |
|---|---|---|
| `kt:streamUrl` | missing | librqbit + range server, aria2 head/tail fallback |
| `kt:streamDone` | missing |  |
| `kt:streamStats` | missing |  |
| `kt:fileUrl` | missing | the local stream server serves files |
| `kt:audioUrl` | written (P5) | `vtstream.rs` (/audio), P5's own loopback server — to be merged with P4's |
| `kt:videoUrl` | written (P5) | `vtstream.rs` (/video: the transcode stream) — same |
| `kt:proxyUrl` | missing | forwards headers |

### P5 — video tools and packs (17 written, waiting for CI)

| Channel | Status | Notes |
|---|---|---|
| `kt:videoInfo` | written (P5) | `vtools.rs`: `-J` (90 s), kt-core `vidjson::normalise` |
| `kt:videoReady` | written (P5) | fetched when missing / older than 2025.01.01; progress `kt:update-progress` (what: yt-dlp) |
| `kt:videoVersion` | written (P5) | asked once per file (path, size, time) |
| `kt:videoUpdate` | written (P5) | forced; the one before kept as `yt-dlp.<v>.old` (three); a new one that does not start rolled back at once (`kt-video:rolledback:…`, worded by the page) |
| `kt:videoRollback` | written (P5) | the newest kept copy put back, pinned |
| `kt:videoBinary` | written (P5) | the user's own program when it exists |
| `kt:isVideoHost` | written (P5) | kt-core `is_video_host` (ytdlp.cjs VIDEO_HOSTS) |
| `kt:galleryList` | written (P5) | gallery-dl `-j --no-download` (120 s), kt-core `vidjson::gallery_items`; none on a Mac (no standalone build — Electron fetched Linux's) |
| `kt:galleryReady` | written (P5) |  |
| `kt:ffmpegAvailable` | written (P5) | `vtffmpeg.rs`: the pack's, else the PATH's (a Mac also Homebrew's) |
| `kt:ffmpeg` | written (P5) | progress `kt:ffmpegProgress` (300 ms); «pack:ffmpeg» when there is none |
| `kt:ffmpegCancel` | written (P5) | SIGINT, the tree ended 3 s later (Windows: at once) |
| `kt:ffprobe` | written (P5) | beside the ffmpeg in use, else the PATH's |
| `kt:packStatus` | written (P5) |  |
| `kt:packInstall` | written (P5) | resumed (six tries), SHA-256, gunzip; `kt:packProgress` |
| `kt:packCancel` | written (P5) |  |
| `kt:packRemove` | written (P5) |  |

### P6 — desktop integration (1 done, 5 missing)

| Channel | Status | Notes |
|---|---|---|
| `kt:appIcon` | done (P6 part) | the shared crate's `appicon.rs` + `iconlogic.rs` (the Reader's, moved) with Tools' Spec (`appicon.rs`); cfgs `kt_set_icon`/`kt_default_icon` |
| `kt:mini` | missing | second always-on-top window on `#/mini` |
| `kt:desktopPrefs` | missing | tray, notifications, keep-awake, when-done, global shortcuts |
| `kt:registerMagnet` | missing | deep links + single instance (the Reader's `openfile.rs`/`openargs.rs`) |
| `kt:captureUrl` | missing | second window (the Reader's `browser.rs`) |
| `kt:siteWindow` | missing | same |

### P7 — archives, the in-app browser, the screen translator (7 done, 9 missing; `kt:archiveFree` in P3)

| Channel | Status | Notes |
|---|---|---|
| `kt:archiveList` | done (P7) | the shared `archive.rs` (zip/tar read here, 7-Zip for the rest) + `archives.rs`; entry dates |
| `kt:archiveExtract` | done (P7) | whole, in place, or `only` some entries; «cache:» |
| `kt:archiveTest` | done (P7) |  |
| `kt:archiveCreate` | done (P7) | zip |
| `kt:archiveCancel` | done (P7) | a cancel before its job starts is kept for it |
| `kt:archiveRestore` | done (P7) |  |
| `kt:archiveExisting` | done (P7) |  |
| `kt:browse` | missing | the Reader's `browser.rs` + `browserlogic.rs` (caught downloads, cookies), plus media sniffing |
| `kt:screenConfig` | missing | screen capture + OCR helpers |
| `kt:screenStatus` | missing |  |
| `kt:screenAction` | missing |  |
| `kt:screenJob` | missing |  |
| `kt:screenRegion` | missing |  |
| `kt:screenClose` | missing |  |
| `kt:screenOcrLangs` | missing |  |
| `kt:screenCaption` | missing |  |

### P8 — servers, DoH, antivirus, update install (3 done, 6 missing)

| Channel | Status | Notes |
|---|---|---|
| `kt:shareWifi` | missing | HTTP server on all interfaces, random key |
| `kt:shareWifiStop` | missing |  |
| `kt:shareWifiStatus` | missing |  |
| `kt:localApi` | missing | same routes and token |
| `kt:setDoh` | done (P8) | `net::set_doh` with kt-core `dohnames` (Tools' names) |
| `kt:dohProbe` | done (P8) | example.com asked of the resolver in force (`net::doh_lookup`), timed |
| `kt:avScan` | missing | the system's scanner |
| `kt:avAvailable` | missing |  |
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
4. **P7 archives, P8 DoH + updater, P6 app icon — written, waiting for CI.** Left of P6: `kt:mini`, `kt:desktopPrefs`,
   `kt:registerMagnet`, `kt:captureUrl`, `kt:siteWindow`; of P7: the in-app browser and the screen translator; of P8:
   Wi-Fi share, the local API, antivirus. P4, P5; P9 the switch-over with the hand-over (and the release job that
   publishes the file names above).
