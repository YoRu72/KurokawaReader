# Kurokawa Tools — desktop engine modules

The computer app is the Rust (Tauri) one, in `../desktop-tauri/`; there is no Electron program any more (`docs/RUST-PORT.md`, status).
This folder, `../desktop/`, holds what the Rust build and the tests still read:

- **package.json** — the version the release gate reads (`scripts/release-check.mjs`), and the packages the release workflow uses:
  `7zip-bin` (the Rust bundle's 7za), `ffmpeg-static` (the computer ffmpeg pack: `ffmpeg-pack.cjs`), `webtorrent` (`tests/webstream.cjs`).
- **icon.png, icon.ico** — the app's icon (`tauri icon`, and compiled into the Rust shell).
- **fetch-aria2.mjs** — run by the release workflow before the Rust build: downloads aria2c for the build's platform (Windows: aria2's own
  release zip; Linux x64/arm64: abcfy2's static musl builds). macOS has no static build: the app looks for Homebrew's `aria2c`; without
  it, torrents need a remote aria2. **ffmpeg-pack.cjs** makes the computer ffmpeg pack the app downloads.
- **archsafe.cjs, namesafe.json, inplace.cjs** — shared with the web build (`src/archives/safety.ts`, `src/views/*`) and the shared test vectors.
- **aria2.cjs, aria2rpc.cjs, archive.cjs, dohchain.cjs, extcmd.cjs, extplayer.cjs, ffmpeg.cjs, gh.cjs, ownerlock.cjs, packs.cjs, paths.cjs,
  relay.cjs, screentr.cjs, sniff.cjs, streamproxy.cjs, torrentstream.cjs, transcode.cjs, webstream.cjs, ytdlp.cjs** — the engines as they were
  in the Electron program. Nothing ships them; they stay as the reference the Rust ports (`../core/`, `../desktop-tauri/src-tauri/`) are
  tested against (`tests/aria2.cjs`, `tests/transcode.cjs`, `tests/ytjobs.cjs`, the shared vectors…) and go with those tests when the ports
  carry their own.
- What an old Electron copy of Tools does on the way to the new app (the frozen bridge build, `scripts/bridge-assets.json`): see `docs/RELEASING.md`.
