# Kurokawa Tools — desktop (Electron)

- **main.cjs** — the window (app:// origin), magnets / .torrent files / `kurokawatools://` links from the system (handed to the page as `kt:open`), the engine's IPC (`kt:*`), the updater (the repository's `tools-v*` releases, read with the GitHub API; Windows and Linux install in place, macOS opens the DMG).
- **aria2.cjs** — the engine: spawns `aria2c` (bundled under `resources/aria2/<plat>-<arch>/`, else one on the PATH) with RPC on a free port and a random secret, `--save-session` in the app's data folder (downloads survive restarts), DHT/LPD on, `--bt-save-metadata`; maps aria2's status to the page's Task shape; `tasks.json` keeps the names and meta aria2 does not. True sequential download is not available in aria2 (`bt-prioritize-piece=head,tail` is used instead), so streaming while downloading is not offered on the desktop yet.
- **aria2rpc.cjs** — JSON-RPC over WebSocket (Node's), with HTTP POST as the fallback.
- **fetch-aria2.mjs** — run before electron-builder: downloads aria2c for the build's platform (Windows: aria2's own release zip; Linux x64/arm64: abcfy2's static musl builds). macOS has no static build: the app looks for Homebrew's `aria2c`; without it, torrents need a remote aria2.
- **preload.cjs** — `window.kurokawaTools` (see `src/engine/desktop.ts`).
