# Kurokawa Tools

[العربية](README.ar.md) · part of the [Kurokawa apps](../../README.md), beside [KurokawaReader](../reader/)

Downloads, torrents, streaming — and the tools around them. Android · Windows · macOS · Linux · web.

- **Downloads:** links (many at once), magnets, .torrent files; a torrent's files picked before it starts; sequential download to play a file while it comes; speed limits, seeding, a listening port of your choice.
- **Engines:** the app's own on Android (libtorrent, eight connections for plain files, resumed after a restart, a notification while they run); aria2c beside the desktop app; or a remote aria2 anywhere.
- **Add-ons** from the [Kurokawa repository](../../repo/), installed only when you want them (Settings → Add-ons):
  - **Torrent search** — Nyaa and Torrentio (with your debrid key for cached links) from the Search tab.
  - **Anime** — an Anime tab: AniList sign-in and tracking (status, progress, score; changes queued offline), the season chart with countdowns (as AniChart), the week's schedule (as LiveChart), your list with what is left to watch, and every episode found as a torrent through Nyaa, Torrentio, SeaDex and AnimeTosho — or through **Hayase and Seanime extension repositories** you add, whose providers run inside the app. Episodes are marked watched as their downloads finish.
  - **Subtitles** — one box takes a title or an AniList / MyAnimeList / IMDb link; the show is resolved through AniList and IMDb, then SubDL, OpenSubtitles, SubSource, Gestdown (Addic7ed), Podnapisi, Subf2m, AnimeTosho, Jimaku and YIFY are searched at once, by season, episode and language; a tap downloads the file.
  - **Archives** — zip, 7z, rar, tar and gzip/xz/bzip2: see inside, extract beside the archive or elsewhere, extract a ZIP **in place** when the disk is short (the archive shrinks as files come out; a stopped run continues later), make zips; subtitle archives are unpacked as they arrive.
  - Coming: debrid services, the video player (A/B cuts with burnt-in subtitles).
- **Other Kurokawa apps:** KurokawaReader opened when installed, or fetched and installed from here with its progress.
- Arabic · English · 日本語 · 한국어 · 中文, the reader's Material 3 Expressive look.

```bash
npm install && npm run build       # web → dist/
npm run android:prepare            # Android project
cd desktop && npm install && npm run dist:win   # desktop (win / mac / linux)
```
