# Kurokawa Tools — Rust port plan (PC, then mobile)

Written 2026-11-11. Starts when the Reader work (bug hunt, fixes, mobile performance) is done.
Stage status is kept in this file; channel-level status for the PC shell is in
`apps/tools/desktop-tauri/PORTING.md` (branch `work-tauri`).

## 1. Goal and non-goals

**Goal.** Move the parts of Tools that are not the interface into Rust, so that:
- the PC app is a small Tauri (Rust) program instead of an Electron one;
- PC and Android share one engine code base instead of JavaScript on PC and Java on Android;
- nothing the app does today is lost.

**Not goals.**
- The interface stays as it is: TypeScript in a web view, on every platform. It is not rewritten.
- Archives stay as they are for now (owner's decision).
- No feature is removed to make the port easier. Where Rust cannot match Electron, the part stays hybrid
  (existing JavaScript in a helper process) and is said plainly.

## 1a. Torrents are a hard requirement (owner, 2026-11-11)

Torrents are central to the app. The port may not weaken them at any point:
- **Never without a working torrent engine.** On PC, aria2 and the present streaming stay in place until the Rust
  engine matches them; on Android, libtorrent4j stays until the Rust engine matches it. The old engine is removed
  only after the new one has been the default for a release without problems.
- **Parity list the Rust engine must pass before it becomes the default** (each as a test where CI can run it, and
  in the owner's phone run on Android): magnet links and .torrent files; metadata fetch from a magnet; choosing
  files and changing the choice mid-download; download and upload limits; pause, resume, and resume after the app
  restarts (no re-download of finished pieces); trackers (HTTP and UDP), DHT and peer exchange; seeding and its
  limits; sequential download for **streaming with seeking** while the rest downloads; moving and renaming; many
  torrents at once; a torrent of thousands of files; private torrents (no DHT/PEX); recovery from a dropped
  network; the same progress, speed and peer figures in the interface.
- **Speed is measured, not assumed**: the same public test torrent downloaded with the old and the new engine on
  the same connection, on PC and on the owner's phone. The Rust engine must not be slower.
- If the Rust engine cannot reach parity on a point, that point keeps using the old engine (hybrid) and it is
  reported before any default changes.

## 2. Where things stand

| | PC (Electron) | Android |
|---|---|---|
| Interface | web view, `apps/tools/src` | the same |
| Shell | `desktop/main.cjs` + ~20 `.cjs` files, 98 bridge functions | `KtPlugin.java` (1,100 lines) |
| Downloads | aria2c (bundled program) | `KrDownloader.java`, `KtEngine.java` |
| Torrents | aria2c + WebTorrent (Node) for streaming | libtorrent4j (5.9 MB native library) |
| Video sites | yt-dlp (program) | yt-dlp (Python inside the app, as packs) |
| Size | Windows 84 MB, macOS 168 MB, Linux 87 MB | 11.5 MB per APK |

Android Java is about 10,700 lines. The parts already written as plain logic with their own tests
(`KrDownloader`, `KtDlRules`, `KtScreenTrack`, `KtScreenMotion`, `KtInpaint`, `KtLettering`, `KtTranslate`, `KtHls`,
`KtArchive`, `KtFiles`' job code) are the natural candidates to become shared Rust.

**Already done (PC, branch `work-tauri`, not shipped):**
- Stage 1 — the Tauri shell opens the same interface; files, dialogs, clipboard, web requests, update check.
- Stage 2 — the aria2 download engine driven from Rust; window size remembered; a self-test that starts the built
  app in CI and exercises the bridge, including a real download paused and resumed: 26 of 26 checks on Windows,
  Linux and macOS.
- Measured sizes with the engine bundled: Windows installer 4.8 MB, macOS 3.5 MB, Linux .deb 9.4 MB,
  Linux AppImage 83.6 MB (it must carry its own browser engine, so no gain there).

## 3. Constraints that shape the plan

1. **Rust cannot be compiled in the development workspace** (the package registry is unreachable there). GitHub
   CI is the only compiler: about 10 minutes per attempt. So every stage is small, written conservatively, and
   pure logic goes into modules with no outside dependencies that *can* be checked and unit-tested locally.
2. **Nothing can be run on a real phone or a real Windows PC from the workspace.** CI runs the PC app for real on
   all three systems (the self-test). Android can only be compiled in CI; behaviour on a phone needs the owner.
3. **One release at a time**, each stage shippable on its own, Electron and the Java engines kept working until
   their replacements are proven.

## 4. Part one — PC

The Electron build keeps shipping throughout. The Tauri build is offered as a **preview download** from stage P3
on, and becomes the main download at P9.

| Stage | Contents | Proof it works (CI self-test, all three systems) | Risk |
|---|---|---|---|
| P1 ✔ | Shell, files, dialogs, clipboard, web requests, update check | bridge round-trips | done |
| P2 ✔ | aria2 engine, tasks, events, window state | real download, pause, resume, hash | done |
| P3 | **Shared core crate** `kt-core` created (see §6): engine rules, path rules, task mapping moved into it from the shell. Remaining small file functions (trash, fonts index, MEGA decrypt). **Preview builds published** beside each Electron release. | existing checks still pass through the core | low |
| P4 | **Torrent streaming in Rust** (librqbit) with the local stream server the player reads from; aria2 kept for torrent *downloads* and as the fallback for streaming. | a small test torrent served by a local tracker/peer in CI: add, stream, seek to the middle, bytes match | **high** — the largest unknown |
| P5 | Video tools: yt-dlp and gallery-dl (fetch, verify, run, progress, update, rollback), ffmpeg packs, probe, transcode stream | a fake yt-dlp/ffmpeg program in CI answering as the real ones do; pack download from the loopback server | low |
| P6 | Desktop integration: tray, global shortcuts, notifications, single instance, magnet and .torrent handling, deep links, title bar, mini window, taskbar progress, keep-awake | second-instance hand-off, deep link, window flags (what CI can observe); the rest by owner on Windows | medium (differs per system) |
| P7 | **The helper process** (hybrid): a small JavaScript runtime carrying the existing code for **archives** (unchanged), then the **in-app browser window** and the **screen translator**. Delivered as an on-demand pack, like ffmpeg, so the base installer stays small; fetched the first time one of these is opened. | archive list/extract/create through the helper; helper install, update, removal | medium |
| P8 | Wi-Fi share, local API, DNS-over-HTTPS, antivirus scan, in-app update install | loopback checks for each | medium (DNS-over-HTTPS needs its own resolver) |
| P9 | **Switch-over**: Tauri becomes the release; Electron kept as a fallback download for two versions; settings and download list carried over from the Electron build on first start | migration test: an Electron profile opened by the Tauri build | low, but irreversible for users — needs owner's go-ahead |

**Sizes to expect.** Windows installer around 5–10 MB without the helper; roughly 30–40 MB if the helper were
bundled instead of on-demand (estimate). macOS similar. Linux: .deb small, AppImage stays ~80 MB.

**Requirements this brings.** Windows needs the WebView2 runtime (part of Windows 11 and most Windows 10
installs; the installer can fetch it). macOS 12 or later.

**Where full parity may not be reached.** The in-app browser's download catching and the screen translator's
screen capture depend on what each system's web view and capture APIs allow. If one cannot match Electron on a
system, it stays in the helper there. This is reported before P9, not after.

## 5. Part two — mobile (Android)

The Android app keeps its web interface and its thin Java layer for everything that *is* Android (services,
notifications, storage access, accessibility, screen capture, mpv). What moves to Rust is the engine logic, as
the same `kt-core` the PC uses, built for Android as a native library per processor type and called from Java.

Every stage goes behind a **switch in Settings** (default: the current Java engine). **A phone run by the owner
comes before each stage becomes the default (confirmed 2026-11-11) — its purpose is to find the flaws to fix.**
For each stage the owner gets a short checklist of what to try and what to look for; whatever the run turns up is
fixed and the run repeated before the default changes. One release after the default has changed without
problems, the Java version is removed.

| Stage | Contents | Proof | Risk |
|---|---|---|---|
| M0 | Build plumbing: `kt-core` compiled for arm64, v7a and x86_64 in CI and packed into the APK; one trivial function called from Java end to end. **Measure the size added.** | CI builds; the APK contains the library; size table | medium (first NDK build) |
| M1 | **Download rules and small logic** from the core: name reservation, holds, host limits, path rules (today `KtDlRules`), translate cache keys, subtitle matching — the pieces already unit-tested | the same tests run against Rust (locally) and through Java (CI) | low |
| M2 | **The HTTP downloader in Rust** (today `KrDownloader`): multi-connection, resume, limits, MEGA decrypt, the retry and connection-count rules | the existing downloader test runs (1–19) ported to drive the Rust engine against the same local test server; then a phone run by the owner on Wi-Fi and mobile data | **high** — this is the engine people rely on most |
| M3 | **Torrents on Android with the same Rust engine as PC** (P4), replacing libtorrent4j. Only after P4 has proven it on PC. | torrent test from P4 on the Android build (compile + emulator in CI if feasible); phone run by the owner | **high** |
| M4 | Screen translator logic (tracking, look-ahead planning, lettering, inpaint) and HLS handling from the core | the existing native tests ported | medium |
| M5 | File jobs (copy/move/delete rules) and remote-storage logic from the core | the file-job tests on temp folders | medium |
| M6 | Remove the replaced Java and libtorrent4j; final size and speed measurements | full suite; size table | low |

**What Rust on Android will and will not give.**
- One engine to fix instead of two: a download or torrent bug is fixed once for PC and phone.
- Size: unknown until M0 and M3 measure it. The Rust library adds a few MB per processor type; removing
  libtorrent4j takes 5.9 MB away. It may end up smaller, the same, or slightly larger. No promise before measuring.
- Speed: downloads are limited by the network, not by Java, so no speed-up should be expected from the language
  alone. Start-up and memory may improve a little.
- yt-dlp stays Python (it *is* yt-dlp). mpv stays as it is. The interface stays as it is.

## 6. The shared core

```
apps/tools/core/            Rust workspace
  kt-core/                  pure logic, no platform code, unit-tested locally with plain rustc
    paths, names, task model, engine rules, limits, host memory
    downloader (M2), torrent glue (P4), subtitle matching, tracking, lettering, inpaint, hls
  kt-desktop/               the Tauri shell (today apps/tools/desktop-tauri/src-tauri)
  kt-android/               the JNI layer: thin functions Java calls
```

Rules: `kt-core` never touches the screen, the file dialogs or Android APIs; it takes plain data in and gives
plain data out, so the same tests cover PC and phone. Anything platform-specific lives in the two outer crates.

## 7. How each stage is run

- Roles: orchestrator plans, integrates and verifies; an Opus worker writes the Rust (conservatively — CI is the
  compiler); a Haiku tester runs suites; Sonnet takes contained fixes.
- Each stage: write → push to the `work-tauri` / `work-rust-android` branch → CI compiles on all targets and
  runs the self-test → fix from the CI log → full Tools suite → release.
- A stage is done only when its proof column passes in CI on **Windows** (the main PC target) and nothing in the
  existing suite regressed.
- After each stage this file's status is updated, with measured sizes.

## 8. Decisions needed from the owner (none block the start)

1. **P7 helper**: on-demand pack (recommended, keeps the installer small) or bundled in the installer?
2. **P9 switch-over**: go-ahead when the time comes, after trying the preview builds.
3. **Each M stage**: a run on your phone before its switch becomes the default.

## 9. Order

Reader work finishes → P3 → P4 → P5 → P6 → P7 → P8 → P9 → M0 → M1 → M2 → M3 → M4 → M5 → M6.
M0 and M1 may be brought forward to run beside P5–P8 if wanted, since they do not depend on them; M3 must wait for P4.
