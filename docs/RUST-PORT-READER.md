# Kurokawa Reader — Rust port plan for PC

Written 2026-11-12. For the Reader's computer app (Windows, macOS, Linux). The Tools app has its own plan (`docs/RUST-PORT.md`); the two share ground work.
Starts after the Reader release now being collected, and after or beside the Tools PC stages — the owner decides the order.

## 1. Goal and non-goals

**Goal.** The Reader on the computer becomes a small Tauri (Rust) program in place of the Electron one: same interface, same features, a far smaller download, less memory, faster start.

**Not goals.**
- The interface is not rewritten. It stays the same TypeScript web app the phone uses; it runs in the system's web view.
- The phone apps are not touched by this plan.
- No feature is removed to make the port easier. Where the system's web view cannot match Electron, that part stays in a helper and is said plainly.

## 2. Where the Reader stands on PC

| | Today (Electron) |
|---|---|
| Shell code | `desktop/main.cjs` and 5 small files — about 1,100 lines |
| Bridge | 38 functions between the interface and the shell |
| What the shell does | files and folders (pick, read, write, sizes, linked folders), downloads, web requests that skip the browser's cross-site limits, DNS-over-HTTPS, the in-app browser window used by sources (its session, fetching through it, forgetting it), archives (7-Zip program), printing a PDF, copying an image, notifications, full screen and immersive, title bar, default-app registration (opening .epub/.pdf with the Reader), update download and install, antivirus scan of a download, portable mode |
| Sizes | Windows installer 81.6 MB, portable 81.5 MB, macOS 166 MB, Linux AppImage 82.5 MB |

This is a much smaller shell than Tools' (about 20 files and 98 functions), and it has no download engine or torrents. Most of the 38 functions are ones the Tools port has already written in Rust (stages P1–P2 on branch `work-tauri`): files, dialogs, clipboard, web requests, update check, window state.

## 3. What decides success: the web view

Electron carries its own Chromium, so the Reader behaves the same on every computer. Tauri uses the system's:
- **Windows**: WebView2 (Chromium-based, kept up to date by Windows) — close to today's behaviour. This is the main target.
- **macOS**: WKWebView (Safari's engine) — the same engine the iPhone app already uses, so the interface is known to work there.
- **Linux**: WebKitGTK — the weakest of the three, version depends on the distribution.

Things to prove early, because they depend on the engine, not on Rust:
1. **PDF reading and the PDF → Word converter** (pdf.js, workers, large memory) on each engine.
2. **Fonts and Arabic shaping** look the same.
3. **IndexedDB storage** — the library lives there. Its location and format differ per engine, so the library must be **carried over** from the Electron profile on first start (see stage R6).
4. **The in-app browser window** used by sources: a second web view with its own session, whose pages the app can read and whose cookies it can use for its own requests.
5. **Read-aloud voices** (the system's speech), **printing**, **full screen**.

## 4. Constraints

1. Rust cannot be compiled in my workspace (the package registry is unreachable). GitHub is the only compiler, about 10 minutes a try. So stages are small, and pure logic is written so it can be checked without the full build.
2. No real Windows PC can be run from here. CI starts the built app on Windows, macOS and Linux and runs a self-test through the bridge (as the Tools port already does: 26 checks on all three). What CI cannot see — how it looks and feels — needs the owner.
3. The Electron Reader keeps shipping until the switch-over. The Tauri build is offered as a preview beside it.

## 5. Stages

| Stage | Contents | Proof (CI self-test on all three systems) | Risk |
|---|---|---|---|
| R0 | **Shared shell crate.** The Rust already written for Tools (files, dialogs, clipboard, web requests, update check, window state) moved into a crate both apps use; the Reader's Tauri project created; the Reader's interface opens in it. | the app starts; bridge round-trips | low |
| R1 | **Engine proof.** The existing Reader test suite's key cases run inside the Tauri build's web view: open EPUB/PDF/text, search, highlights, the converter on a test PDF, Arabic rendering screenshots compared with Electron's. Findings listed per system before going further. | those cases pass; differences listed | **high — this decides the plan** |
| R2 | **Files and library**: pick/read/write, linked folders, file sizes, opening a file passed on the command line or by double-click, default-app registration, drag and drop, single instance. | open-with and second-instance hand-off | low |
| R3 | **Network**: web requests without cross-site limits, DNS-over-HTTPS, downloads with progress, antivirus scan, notifications. | loopback server checks | medium (DNS-over-HTTPS needs its own resolver) |
| R4 | **The in-app browser window** for sources: second web view, its own session, fetch through it, reset/forget. Where an engine cannot do it (most likely Linux), it stays in a small helper there. | a local test site with a cookie-gated page | **high** |
| R5 | **Archives, printing, images, window**: archives through the same 7-Zip program (unchanged), print a PDF, copy an image, full screen, immersive, title bar, tray if any, portable mode. | archive list/extract/create; print to file | medium |
| R6 | **Carry-over and updater**: on first start, the library, settings, covers and positions are copied from the Electron profile (read with a small bundled exporter if the storage formats differ — nothing is deleted from the old profile); in-app update download, verification and install; the Electron build updates into the Tauri one only at the switch-over. | an Electron profile made in CI opened by the Tauri build: same books, same positions, same highlights | **high — users' libraries** |
| R7 | **Preview period**: Tauri builds published beside each Electron release; the owner uses it daily on Windows; a list of every difference found. | — | — |
| R8 | **Switch-over**: Tauri becomes the main download; Electron kept as a fallback download for two versions. Needs the owner's go-ahead. | full suite; size table | low, but hard to undo for users |

**R5, as done** (see `apps/reader/desktop-tauri/PORTING.md`, «Archives, the window, the app's icon»): archives as
`archive.cjs` does them (its own ZIP and tar readers in Rust, the same 7-Zip program shipped beside the app for the
rest); full screen, the interface's size, taskbar progress, an image on the clipboard, a Mac's menu bar; the user's own
app icon kept outside the program and put on the window, the title bar, Windows' shortcuts and Linux's desktop entry
(a Mac's Dock refuses it), carried in backups. Printing a text PDF has no Tauri equivalent: the converter keeps its
picture PDF on every system (WebView2's own `PrintToPdf` would need unsafe COM code, not written); the viewer's Print
opens the system's PDF program on a Mac and Linux. Portable mode stays Electron's (`isPortable` is false here). No tray:
Electron's Reader has none.

**R6a, as done** (the data; see `apps/reader/desktop-tauri/PORTING.md`, «The hand-over»): the last Electron build writes
a hand-over — the stores copied whole (ids kept), every localStorage key, the local AI's models, its own icon, window
and DNS files; linked books as links — into `<userData>/handover/`, streamed, hashed, read back and checked, marked
last and only then renamed into place; a full disk or any failure means no install and a plain message. The Rust build
offers it on its first start (count, size, «your old data is untouched at …»), copies it into its empty profile (or
merges it into one with books), never twice, and frees its space only when asked. Backups read every format version in
both builds and on the phones. Proved by `tests/handover.cjs` here and, in CI, the real Electron app handing over to
the Tauri build (Windows required). The updater and installer half is R6b.

## 6. What to expect

- **Size** (from the Tools port's measured figures with the same toolkit): Windows installer about 5–10 MB in place of 82 MB; macOS a few MB in place of 166 MB; Linux .deb small, AppImage stays near 80 MB because it must carry its own engine.
- **Memory and start-up**: lower and faster on Windows and macOS, since no second browser is loaded. To be measured in R1, not promised.
- **Speed of reading itself**: the same — that is the web code, which the performance work improves for every platform.
- **Requirements**: Windows 10/11 with WebView2 (part of Windows 11 and most Windows 10; the installer can fetch it). macOS 12 or later. Linux with a recent WebKitGTK.

## 7. Risks, said plainly

- **Linux** may end with a few features in a helper or behaving differently; if R1 shows it is poor there, Linux can stay on Electron while Windows and macOS move.
- **macOS** uses Safari's engine: anything that today leans on a Chromium-only feature must be found in R1 (the iPhone app is a good sign, not a proof — the desktop has more features).
- **The library carry-over** is the one step that can hurt a user. It copies, never moves; the old profile stays; it is tested on real Electron profiles in CI before any user sees it.
- **Updates**: Windows users on the Electron build must be moved by an installer that replaces it cleanly; portable users move by hand.

## 8. Decisions for the owner (none block planning)

1. **Order**: Reader PC port before, after, or beside the Tools PC port? (R0 serves both.)
2. **Linux**: accept "stays on Electron if the engine proves poor"?
3. **Switch-over**: go-ahead when the time comes, after using the preview.
