# Kurokawa Tools

[العربية](README.ar.md) · part of the [Kurokawa apps](../../README.md), beside [KurokawaReader](../reader/)

Downloads, torrents, streaming — and the tools around them. Android · Windows · macOS · Linux · web.

- **Downloads:** links (many at once), magnets, .torrent files; a torrent's files picked before it starts; sequential download to play a file while it comes; speed limits, seeding, a listening port of your choice.
- **Engines:** the app's own on Android (libtorrent, eight connections for plain files, resumed after a restart, a notification while they run); aria2c beside the desktop app; or a remote aria2 anywhere.
- **Add-ons** from the [Kurokawa repository](../../repo/), installed only when you want them: torrent search (Hayase and Seanime extensions, Torrentio), anime (AniList, AniChart, LiveChart), subtitles from many sites at once (SubDL, Subf2m, OpenSubtitles, Podnapisi, Gestdown, AnimeTosho, SubSource…) linked to IMDb, AniList and MAL, debrid services, archives (zip and unzip, in place), and a video player — coming release by release.
- **Other Kurokawa apps:** KurokawaReader opened when installed, or fetched and installed from here with its progress.
- Arabic · English · 日本語 · 한국어 · 中文, the reader's Material 3 Expressive look.

```bash
npm install && npm run build       # web → dist/
npm run android:prepare            # Android project
cd desktop && npm install && npm run dist:win   # desktop (win / mac / linux)
```
