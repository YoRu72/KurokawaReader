# Features taken from the repositories the owner pointed to

Status: [x] done · [~] partly · [ ] to do. Kept current as each batch lands.

## HatchZip (xevrion/hatchzip) — Archives add-on, both apps; also the APK installer
- [x] In-place ZIP extraction from the end, journal + tail file, resume after a stop or crash
- [x] Space plan before anything changes: free now, a normal extraction's need, in place's need (largest unit + margin), free after
- [x] Keep-free margin (default 2 GB; smaller on phones) never used
- [~] In place for tar (done); split volumes (.001 …) still to do
- [x] Verify first (every CRC read before anything is deleted) and Test (verify without writing)
- [x] Restore (give up): what is left becomes a normal ZIP again (central directory rewritten for the entries not yet out)
- [x] Smart "Extract here": one top-level item lands beside the archive, several go into a folder named after it
- [x] Existing files: Replace / Skip / Keep both ("name (2).ext"), "the same for the rest"
- [x] Several archives one after another, each space-checked as it starts
- [x] .sfv checked first when one sits beside the archive
- [x] Hostile archives refused before anything is deleted: paths escaping the folder, duplicate and overlapping entries; links last
- [ ] Password proven on one file before anything is deleted
- [x] "Close when done" for the progress sheet
- [x] APK installer: split bundles (.apks, .xapk, .apkm) installed straight out of the archive (no extracting first), the APK's details (name, version, installed version, upgrade/downgrade), install progress and result, delete the file after installing, install an APK found inside any archive

## Prism download manager (FortoGraphy/prism-download-manager)
- [x] Segments per connection, file map, speed chart, log; categories with folders; sort; batch patterns `[001-100]`
- [x] yt-dlp: qualities, audio only, subtitles, SponsorBlock, cover; [x] chapters embedded, [x] only a part (time range), name template, cookies
- [x] HLS/DASH links (.m3u8/.mpd) go to yt-dlp
- [x] Dynamic segmentation — as small chunks each free connection takes next (a slow one holds up only its chunk); per-host connection limit remembered (Android; aria2 on a computer)
- [x] Resume after a pause or restart, checked with If-Range (ETag / Last-Modified); a changed file is downloaded afresh
- [x] What is inside a ZIP before downloading it (central directory read with range requests)
- [x] Queues with a schedule (start/stop times, days) and their own speed limit; action when done (desktop: sleep/shut down)
- [x] Clipboard monitor (ask before adding copied links)
- [x] Site grabber: links of chosen types collected from a page; crawl depth (3 levels, under the folder) and saved projects
- [x] Convert (pictures, music, video) and Make smaller (fit 8/10/20/25/50 MB) with ffmpeg, saved beside the original
- [x] Done sheet: open, show in folder, verify checksum (MD5/SHA-1/SHA-256)
- [x] Trash (Recently removed, put back); remove entries whose files were deleted
- [x] Hugging Face models by name, link, search or trending; GGUF version picks; files checked by SHA-256
- [x] Compact list view (Minimal look), grouping, filters, search, selection, keyboard
- [x] Speed chart, connection lanes, KPIs, status bar, completion card and sounds, antivirus check, drop zone, shortcuts
- [x] Connection settings: identify as, tries, wait, proxy, file already there (keep both / replace / skip)
- [x] New address for an expired link; download again; queue order moved up/down
- [x] Mini window (computer)

## REX Player (mpvRex/REX-Player) — the player
- [x] Gestures (seek, volume, brightness, long-press speed, pinch zoom), A/B loop, cut, subtitle styling, resume, sleep timer pref
- [x] Online subtitle search inside the player (the Subtitles add-on), secondary subtitles
- [~] Drag subtitles to move (done); pinch to resize, swipe to the next line still to do
- [x] Chapters (sheet and marks on the bar), skip a custom amount (e.g. 85 s opening), AniSkip opening/ending skip for anime
- [x] Frame step, screenshot (with subtitles), video filters (brightness, contrast, saturation, gamma), ambient glow
- [~] Repeat/shuffle, autoplay next, picture-in-picture (done); background audio still to do
- [x] Double-tap area width, invert remaining time, speed-adjusted remaining time, remember brightness
- [x] Open in an external player (VLC, MX, mpv) — also from Seanime
- [ ] Share a file over Wi-Fi with a QR code (local server)

## Senpwai (SenZmaKi/Senpwai)
- [x] Episode range download (from–to) with resolution and sub/dub preference, saved per show
- [x] Track airing shows and fetch new episodes automatically with the saved choices; notification
- [x] Skip fillers (animefillerlist)
- [x] Episodes already downloaded are marked and skipped (from the downloads and from a scan of the disk — the library)
- [x] Review the picks before queueing (change any; a countdown when all are clear)
- [x] Torrent options: seed ratio/time limits, encryption, DHT/LSD/UPnP/NAT-PMP, proxy, bind to a VPN interface, anonymous mode
- [x] Storage usage (by kind, free space, packs)

## Hayase (hayase-app/interface)
- [x] Watch an episode now: the best release by quality and the lookup preference (quality / size / seeders), played while it downloads
- [x] Search by genres and tags (required or left out), format, status, season, year, score, sort
- [x] Hide spoilers; filler list (filler-scrape) first; HEVC left out where it cannot play

## Seanime (5rahim/seanime and the community repos)
- [x] Torrent providers (Seanime and Hayase extensions), debrid
- [x] Extension marketplaces browsed in the app (Seanime Marketplace, ASleepyDrink, Pal-droid, Hayase repos): status, language, one-tap install
- [x] Online streaming extensions (`onlinestream-provider`): watch or download episodes over HTTP/HLS — match kept per show, server fallback, subtitles, headers through a local proxy (HLS remuxed by ffmpeg on the desktop); TypeScript payloads compiled with the TypeScript compiler; `CryptoJS` (AES/MD5), `Buffer`, goquery-style `Doc`/`LoadDoc` shimmed. Not possible: `ChromeDP` (a headless browser)
- [x] Stremio add-ons (any manifest URL with streams) as providers
- [x] Auto Downloader: rules per show (group, resolution, terms), checked on a schedule
- [x] Local anime library (files matched to shows, by hand when needed), Continue watching, missing episodes
- [x] Missed episodes (episodes ready on My list; missing ones in the library); missed sequels
- [x] Season guide: For you (by your taste from AniList), top-10 tiers, list status tints, + Plan
- [x] Anime diary: calendar/heatmap of watched episodes, unfinished shows, year in review
- [x] Open AniList / MyAnimeList links in the app

## The owner's own asks (this round)
- [x] Torrent search: covers and titles matched on AniList and IMDb (as OTL in the reader), results grouped under them
- [x] Anime: fixes (countdowns, long series, episode titles, paging, my-list statuses, Arabic durations)
- [x] Subtitle search: anime episodes mapped to IMDb seasons, busy states, typing finds titles
- [x] Settings folded like the reader's, with search
- [ ] Reader settings worth having here (digits, fonts, haptics, reduce motion, backups)
