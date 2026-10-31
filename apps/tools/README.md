# Kurokawa Tools

[العربية](README.ar.md) · [日本語](README.ja.md) · [中文](README.zh.md) · [한국어](README.ko.md) · part of the [Kurokawa apps](../../README.md), beside [KurokawaReader](../reader/)

Downloads, torrents, video sites, anime, subtitles, archives and a player — one app. Android · Windows · macOS · Linux · web.

## The downloader
- **One Add bar for everything:** links (many at once, or ranges like `[001-100]`), magnets, .torrent files, and pages of video sites — the downloader looks at what you pasted and does the right thing. A torrent's files are picked before it starts; a ZIP's contents are shown before it is downloaded.
- **Video sites (the Video add-on, yt-dlp):** YouTube and over a thousand other sites, HLS/DASH streams too — title, picture, every quality with its size, audio only, subtitles; playlists whole. yt-dlp comes from its own releases and keeps itself up to date.
- **The Prism way:** many connections per file, a map of its pieces, a speed chart and a log; categories (video, music, documents, programs, archives, pictures, subtitles, your own) with their own folders; sort; a scheduler with hours and days; a clipboard monitor; a grabber that collects a page's links by kind; checksums (MD5, SHA-1, SHA-256) compared with the site's; **Convert** (video, music, pictures) and **Make smaller** (to fit 8–100 MB) with ffmpeg.
- **Engines:** the app's own on Android (libtorrent, segmented HTTP, resumed after a restart, a notification while it works); aria2c beside the desktop app; or a remote aria2.
- **Debrid:** Real-Debrid, AllDebrid, Premiumize and TorBox — a magnet or hoster link fetched by the cloud, then downloaded at full speed.

## Add-ons (Settings → Add-ons, installed only when you want them; they update themselves)
- **Torrent search** — works found on AniList and IMDb shown as covers, the releases grouped under the work each belongs to (as OTL in the reader); Knaben, The Pirate Bay, Nyaa, YTS, EZTV and Torrentio (by IMDb or Kitsu id).
- **Anime** — AniList sign-in and tracking, the season chart (AniChart), the week's schedule (LiveChart), your lists by status, every episode found through the built-in sources or **any Seanime, Hayase or Stremio extension** — browse the community marketplaces right in the app. Download a range of episodes with your choices (resolution, group, dub or sub, words to require or avoid), leave out fillers, skip what you have, and let new episodes come by themselves as they air.
- **Subtitles** — one box takes a title or an AniList / MyAnimeList / IMDb link; SubDL, OpenSubtitles, SubSource, Gestdown, Podnapisi, Subf2m, AnimeTosho, Jimaku and YIFY searched at once, an anime episode mapped to its IMDb season and episode for the western sites.
- **Archives (the HatchZip way)** — zip, 7z, rar, tar, gzip/xz/bzip2: a space plan before anything changes; extraction **in place** for ZIP and tar when the disk is short (the archive shrinks as files come out, resumes after a stop, or is restored whole if you give up); Test and Verify first; `.sfv` checks; hostile archives refused; several archives one after another; zips made.
- **App installer (Android)** — APKs and split bundles (.apks, .xapk, .apkm) installed straight from the file, with the app's name, icon and version (new, update or older) shown first.
- **Player** — REX Player's gestures and VLC's tools: speed, A/B loop and cuts with burnt-in subtitles, subtitles found online for the episode playing, styled and dragged into place, openings and endings skipped (AniSkip, chapters), picture filters, an ambient glow, picture-in-picture, another player on a tap.

Arabic · English · 日本語 · 한국어 · 中文, right-to-left or left-to-right, Material 3 Expressive, dark by default, the interface size yours to set.

```bash
npm install && npm run build       # web → dist/
npm run android:prepare            # Android project
cd desktop && npm install && npm run dist:win   # desktop (win / mac / linux)
```
