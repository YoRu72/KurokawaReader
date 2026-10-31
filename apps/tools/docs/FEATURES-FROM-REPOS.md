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
- [x] yt-dlp: qualities, audio only, subtitles, SponsorBlock, cover; [ ] chapters embedded, [ ] only a part (time range)
- [x] HLS/DASH links (.m3u8/.mpd) go to yt-dlp
- [ ] Dynamic segmentation (a finished connection takes half of the largest remaining part); per-host connection limit remembered
- [ ] Resume checks the file has not changed (ETag / Last-Modified, If-Range)
- [x] What is inside a ZIP before downloading it (central directory read with range requests)
- [x] Queues with a schedule (start/stop times, days) and their own speed limit; action when done (desktop: sleep/shut down)
- [x] Clipboard monitor (ask before adding copied links)
- [x] Site grabber: links of chosen types collected from a page
- [x] Convert (pictures, music, video) and Make smaller (fit 8/10/20/25/50 MB) with ffmpeg, saved beside the original
- [x] Done sheet: open, show in folder, verify checksum (MD5/SHA-1/SHA-256)
- [ ] Trash for removed downloads; remove entries whose files were deleted
- [ ] Hugging Face models by name or link, files checked by SHA-256
- [ ] Compact list view

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
- [~] Episodes already downloaded are marked and skipped (from the downloads); a disk scan still to do
- [ ] Review uncertain matches before queueing
- [ ] Torrent options: seed ratio/time limits, encryption, DHT/LSD/UPnP/NAT-PMP, proxy, bind to a VPN interface
- [ ] Storage usage

## Seanime (5rahim/seanime and the community repos)
- [x] Torrent providers (Seanime and Hayase extensions), debrid
- [x] Extension marketplaces browsed in the app (Seanime Marketplace, ASleepyDrink, Pal-droid, Hayase repos): status, language, one-tap install
- [ ] Online streaming extensions (`onlinestream-provider`): watch or download episodes over HTTP/HLS
- [x] Stremio add-ons (any manifest URL with streams) as providers
- [x] Auto Downloader: rules per show (group, resolution, terms), checked on a schedule
- [ ] Local anime library (match files to shows), Continue watching / Up next
- [ ] Missed episodes in the schedule
- [ ] Season guide: For you (by your taste from AniList), top-10 tiers, list status tints, + Plan
- [ ] Anime diary: calendar/heatmap of watched episodes, unfinished shows, year in review
- [ ] Open AniList / MyAnimeList links in the app

## The owner's own asks (this round)
- [x] Torrent search: covers and titles matched on AniList and IMDb (as OTL in the reader), results grouped under them
- [x] Anime: fixes (countdowns, long series, episode titles, paging, my-list statuses, Arabic durations)
- [x] Subtitle search: anime episodes mapped to IMDb seasons, busy states, typing finds titles
- [x] Settings folded like the reader's, with search
- [ ] Reader settings worth having here (digits, fonts, haptics, reduce motion, backups)
