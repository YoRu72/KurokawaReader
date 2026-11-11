# Porting the desktop shell to Tauri v2

The Electron shell (`../desktop/`) keeps shipping; this Tauri shell grows beside it until it has every channel
below, then replaces it. Why: Electron bundles are ~84 MB (Windows), ~87 MB (Linux AppImage), ~168 MB (macOS
universal dmg). A Tauri shell uses the system's web view (WebView2 / WKWebView / WebKitGTK), so the shell itself
should be a few MB; `.github/workflows/tauri-check.yml` prints the real sizes.

How it works: `src-tauri/src/main.rs` opens the window (made in Rust, `app.windows` is empty in
`tauri.conf.json`) on the same built web UI (`../dist`), and runs `bridge.js` as its initialization script, so the
page finds the same `window.kurokawaTools` the Electron preload gives it. Each Electron channel `kt:xyz` becomes the
Tauri command `kt_xyz` (`src-tauri/src/commands.rs`). A method that is not ported yet is **absent** from the bridge
(the page asks for each feature by its method), except the engine's methods that `DesktopEngine` calls without
asking: those are present and refuse with "The download engine is not in this preview build yet", and `state`
says `available: false`, so the page shows its own no-engine state. `tests/tauribridge.cjs` keeps the bridge,
the preload and the Rust command list in step.

Version: `tauri.conf.json` has `"version": "../../package.json"`, so the app's version is always
`apps/tools/package.json`'s (Cargo.toml's own version is unused and stays `0.0.0`).

Icons: not committed; CI runs `npx @tauri-apps/cli icon ../desktop/icon.png` first (it writes `src-tauri/icons/`).
Do the same once before a local `tauri build` / `tauri dev`.

## The 98 channels

Status: **done** (stage 1) · **refuses** (present, rejects until its stage) · **stage N** · **hard** (see below).

| Area | Channel | Status | Notes |
|---|---|---|---|
| State | `kt:state` | done | `available: false`, reason, `os`/`arch` in Node's words |
| Engine | `kt:engineRetry` | stage 2 | bridge's `retryEngine` re-reads `kt_state` meanwhile |
| Engine | `kt:list` | done | `[]` until the engine |
| Engine | `kt:add` | refuses → stage 2 | aria2 sidecar |
| Engine | `kt:pause` | refuses → stage 2 | |
| Engine | `kt:resume` | refuses → stage 2 | |
| Engine | `kt:remove` | refuses → stage 2 | |
| Engine | `kt:setFiles` | refuses → stage 2 | |
| Engine | `kt:setUrl` | stage 2 | |
| Engine | `kt:move` | stage 2 | |
| Engine | `kt:setLimits` | refuses → stage 2 | |
| Engine | `kt:configure` | stage 2 | |
| Engine | `kt:torrentInfo` | refuses → stage 2 | |
| Engine | `kt:rename` | refuses → stage 2 | |
| Engine | `kt:open` | refuses → stage 2 | needs a task's path; then opener `open_path` / `reveal_item_in_dir` |
| Engine | `kt:megaDecrypt` | stage 2 | AES-128-CTR (`aes` + `ctr` crates), streamed |
| Files | `kt:defaultDir` | done | `<Downloads>/Kurokawa` |
| Files | `kt:roots` | done | |
| Files | `kt:listDir` | done | |
| Files | `kt:pathInfo` | done | |
| Files | `kt:exists` | done | |
| Files | `kt:siblings` | done | |
| Files | `kt:readFile` | done | raw bytes (`ipc::Response`) → ArrayBuffer |
| Files | `kt:writeText` | done | |
| Files | `kt:writeTemp` | done | |
| Files | `kt:writeTempBytes` | done | |
| Files | `kt:removeFile` | done | |
| Files | `kt:hashFile` | done | md5/sha1/sha256 in one streamed pass |
| Files | `kt:deletePath` | stage 2 | to the trash: `trash` crate, then `remove_dir_all` as Electron does |
| Files | `kt:fontDirs` | stage 2 | plain path list |
| Files | `kt:fontIndex` | stage 2 | the `name`-table reader ported as is (or `ttf-parser`) |
| Opening | `kt:openPath` | done | `tauri-plugin-opener` |
| Opening | `kt:openExternal` | done | file:// → `open_path`, else `open_url` |
| Opening | `kt:fileUrl` | stage 3 | the local stream server (below) serves files |
| Dialogs | `kt:pickDir` | done | `tauri-plugin-dialog`, blocking form in an async command |
| Dialogs | `kt:pickFile` | done | multiple, filters |
| Dialogs | `kt:saveText` | done | |
| Clipboard | `kt:clipboardText` | done | `tauri-plugin-clipboard-manager` |
| Network | `kt:http` | done | reqwest (rustls, gzip/brotli/deflate), same result shape |
| Network | `kt:captureUrl` | stage 4 | second `WebviewWindow` + `on_navigation`, own data dir for the sign-in |
| Network | `kt:siteWindow` | stage 4 | second `WebviewWindow`; resolve on close |
| Network | `kt:setDoh` | hard | see DoH |
| Network | `kt:dohProbe` | hard | see DoH |
| Updates | `kt:checkUpdate` | done | same GitHub tools-v* logic and result |
| Updates | `kt:installUpdate` | stage 3 | absent: the page falls back to opening the asset; later `tauri-plugin-updater` (needs signed update manifests) or the Electron logic in Rust |
| Streaming | `kt:streamUrl` | hard | see torrents |
| Streaming | `kt:streamDone` | hard | |
| Streaming | `kt:streamStats` | hard | |
| Streaming | `kt:audioUrl` | stage 3 | `streamproxy.cjs` → a 127.0.0.1 HTTP server in Rust (`tiny_http` or hyper) |
| Streaming | `kt:videoUrl` | stage 3 | same server |
| Streaming | `kt:proxyUrl` | stage 3 | same server, forwards headers |
| Videos | `kt:videoInfo` | stage 3 | yt-dlp is already an external binary: spawn it from Rust (`tokio::process`), same args |
| Videos | `kt:videoReady` | stage 3 | download/update of yt-dlp, progress as a Tauri event |
| Videos | `kt:videoVersion` | stage 3 | |
| Videos | `kt:videoUpdate` | stage 3 | |
| Videos | `kt:videoRollback` | stage 3 | |
| Videos | `kt:videoBinary` | stage 3 | |
| Videos | `kt:isVideoHost` | stage 3 | the host regex moved to Rust (`regex` crate) or into bridge.js |
| Videos | `kt:galleryList` | stage 3 | gallery-dl binary, same as yt-dlp |
| Videos | `kt:galleryReady` | stage 3 | |
| ffmpeg | `kt:ffmpegAvailable` | stage 3 | ffmpeg is a pack (downloaded), spawned from Rust |
| ffmpeg | `kt:ffmpeg` | stage 3 | progress as events |
| ffmpeg | `kt:ffmpegCancel` | stage 3 | |
| ffmpeg | `kt:ffprobe` | stage 3 | |
| Archives | `kt:archiveList` | stage 3 | `zip` crate for ZIP; 7-Zip as a sidecar for the rest (as 7zip-bin today) |
| Archives | `kt:archiveExtract` | stage 3 | the in-place HatchZip extraction is a careful port |
| Archives | `kt:archiveTest` | stage 3 | |
| Archives | `kt:archiveCreate` | stage 3 | |
| Archives | `kt:archiveCancel` | stage 3 | |
| Archives | `kt:archiveRestore` | stage 3 | |
| Archives | `kt:archiveFree` | stage 3 | free space: `fs2`/`sysinfo` |
| Archives | `kt:archiveExisting` | stage 3 | |
| Packs | `kt:packStatus` | stage 3 | download + SHA-256 check, plain Rust |
| Packs | `kt:packInstall` | stage 3 | |
| Packs | `kt:packCancel` | stage 3 | |
| Packs | `kt:packRemove` | stage 3 | |
| Antivirus | `kt:avScan` | stage 3 | spawns the system's scanner |
| Antivirus | `kt:avAvailable` | stage 3 | |
| Browser | `kt:browse` | hard | see the in-app browser |
| Screen | `kt:screenConfig` | hard | see the screen translator |
| Screen | `kt:screenStatus` | hard | |
| Screen | `kt:screenAction` | hard | |
| Screen | `kt:screenJob` | hard | |
| Screen | `kt:screenRegion` | hard | |
| Screen | `kt:screenClose` | hard | |
| Screen | `kt:screenOcrLangs` | hard | |
| Screen | `kt:screenCaption` | hard | |
| Screen | `kt:screenFontAdd` | stage 3 | plain file write in app data |
| Screen | `kt:screenFontRemove` | stage 3 | |
| Wi-Fi share | `kt:shareWifi` | stage 3 | the same small HTTP server (all interfaces, random key) |
| Wi-Fi share | `kt:shareWifiStop` | stage 3 | |
| Wi-Fi share | `kt:shareWifiStatus` | stage 3 | |
| Window | `app:titleBar` | stage 4 | frameless window + `data-tauri-drag-region`; Windows has no `titleBarOverlay`, so the min/max/close buttons are drawn by the page |
| Window | `kt:appIcon` | stage 4 | `Window::set_icon`; the Windows taskbar overlay of `appicon.cjs` needs `windows` crate calls |
| Window | `kt:mini` | stage 4 | second always-on-top `WebviewWindow` on `#/mini` |
| Desktop | `kt:desktopPrefs` | stage 4 | tray (`tray-icon` feature), notifications (`tauri-plugin-notification`), keep-awake (`keepawake` crate), when-done actions, global shortcuts (`tauri-plugin-global-shortcut`) |
| Desktop | `kt:registerMagnet` | stage 4 | `tauri-plugin-deep-link` (magnet:, kurokawatools:) + `tauri-plugin-single-instance` for the second-instance hand-over |
| Desktop | `kt:localApi` | stage 4 | the local API server in Rust (same routes, token) |

Events the preload listens for (`kt:tasks`, `kt:engineState`, `kt:packProgress`, `kt:archiveProgress`,
`kt:ffmpegProgress`, `kt:update-progress`, `kt:hotkeyAdd`, `kt:openTask`, `kt:browser`, `kt:screenCaption`,
`app:titleBarState`, `kt:open`) become Tauri events (`app.emit(...)`, listened to in bridge.js with
`window.__TAURI__.event.listen`, which needs `core:event:default` — already in `core:default`).

## The hard parts

### aria2 (stage 2)
aria2c is already a separate binary spoken to over JSON-RPC (`aria2.cjs`, `aria2rpc.cjs`); only the Node glue moves.
Ship it as a Tauri sidecar: `bundle.externalBin: ["binaries/aria2c"]`, with `binaries/aria2c-<target-triple>[.exe]`
fetched in CI by a port of `fetch-aria2.mjs` (one per triple; macOS universal needs both arch binaries or a `lipo`ed
one named `-universal-apple-darwin`). Start it with `tauri-plugin-shell`'s `sidecar("aria2c")` (or plain
`std::process::Command` on the path next to the executable), same arguments, a random port and secret; keep the
JSON-RPC client in Rust (`tokio-tungstenite` for the WebSocket notifications, reqwest for calls) so the secret
never reaches the page, and push `kt:tasks` as events on a timer as `aria2.cjs`
does. The task model (`aria2.cjs`'s mapping of tellActive/tellWaiting/tellStopped to `Task`) is the bulk of the work
and is pure data mapping.

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

1. **Done here**: window, bridge, files, dialogs, clipboard, `kt:http`, `kt:checkUpdate`; CI builds and sizes.
2. aria2 sidecar + tasks + events (`kt:tasks`, `kt:engineState`), `kt:open`, `deletePath`, fonts, `megaDecrypt`.
3. The binaries and servers: yt-dlp, gallery-dl, ffmpeg packs, archives (+7-Zip sidecar), the local stream/proxy
   server (`fileUrl`, `audioUrl`, `videoUrl`, `proxyUrl`), Wi-Fi share, antivirus, screen fonts, updates install.
4. Desktop integration: single instance, deep links (magnet:, .torrent), tray, notifications, keep-awake, global
   hotkeys, mini window, title bar, app icon, captureUrl / siteWindow windows, local API.
5. Torrent streaming (librqbit, with the aria2 fallback), the in-app browser, DoH.
6. The screen translator. Then parity review, and the Tauri builds into release-tools.yml.
