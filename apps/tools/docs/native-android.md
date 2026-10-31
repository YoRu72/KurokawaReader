# Kurokawa Tools — Android native layer

`native/android/` is copied into the Capacitor project by `overlay.mjs` (run after `npx cap add android`).

- **KtPlugin.java** — the Capacitor plugin `KurokawaTools`: `add`, `list`, `pause`, `resume`, `remove`, `setFiles`, `setSequential`, `setLimits`, `configure`, `torrentInfo`, `streamUrl`, `open`, `defaultDir`, `pickDir`, `deviceInfo`, `isInstalled`, `launch`, `openUrl`, `downloadFile` (+ `downloadProgress` events, for APKs), `cancelDownload`, `installApk`, `canInstall`. Events: `tasksChanged { tasks }`. The TypeScript side is `src/engine/native.ts` and `src/installer.ts`.
- **KtEngine.java** — the engine: one libtorrent4j session (DHT, LSD, UPnP/NAT-PMP, encryption enabled), torrents added from magnets or .torrent bytes with resume data, file priorities, sequential flag; plain files through `KrDownloader` (the reader's multi-connection downloader) into `<dir>/<name>` via a `.part` file. Tasks and config persisted in `files/kt/` (`tasks.json`, `<id>.fastresume`, `<id>.torrent`, `config.json`); unfinished torrents re-added at start, unfinished HTTP downloads left paused (resumed on tap).
- **KtService.java** — the foreground service (`dataSync`) with one progress notification while anything downloads, a notification per finished or failed download.
- **KtStream.java** — `http://127.0.0.1:<port>/<taskId>/<fileIndex>`: the file served with Range support while it downloads; a missing piece is given a deadline and waited for (up to 2 minutes).
- **Folders:** `pickDir` returns a path for the primary storage (libtorrent writes to paths); a tree on another storage comes back as a `content://` URI, which the engine cannot write to yet — downloads then go to the app's own folder.
- **libtorrent4j** 2.1.0-39 from Maven Central (`libtorrent4j`, `-android-arm64`, `-android-arm`, `-android-x86_64`), kept through R8 by `proguard-kt.pro`.
