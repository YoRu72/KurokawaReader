# OmniGet (OpenSelena/omniget) — exhaustive feature inventory

Source: shallow clone of https://github.com/OpenSelena/omniget (v0.14.x, docs changelog "October 2026"), read-only.
Paths below are relative to the repository root (`src/` in the scratchpad clone = `.../scratchpad/omniget/src/`).
Each line = one concrete feature, with its evidence in brackets.

---

## 1. What it is (platform, language, architecture)

- Free GPL-3.0 desktop downloader + "media toolbox"; no account, no ads, no telemetry on downloads [README.md "Privacy and what OmniGet refuses to do"; LICENSE]
- Platforms: Windows 10/11 (setup .exe, portable .exe, .msi, winget), macOS 10.15+ (arm64/x64 .dmg, Homebrew cask), Linux (.deb/.rpm amd64+arm64, AppImage with .zsync self-update), Flatpak manifest present but "not on Flathub" [README.md "Download and install"; flatpak/com.openselena.omniget.yml; .github/workflows/release.yml, homebrew.yml, winget.yml]
- Stack: Tauri 2 shell, Rust backend, SvelteKit + Svelte 5 frontend, SQLite (rusqlite bundled), yt-dlp, FFmpeg, librqbit (BitTorrent), whisper.cpp, aria2, gallery-dl [README.md "Build from source"; src-tauri/Cargo.toml; src-tauri/src/core/db.rs]
- Workspace crates: `omniget-core` (engine, platforms, tools; also used by CLI), the Tauri app `src-tauri/src`, `omniget-cli`, `omniget-plugin-sdk`, embedded plugins `plugins/courses`, `plugins/telegram`, `plugins/convert`, `grammers-session` (Telegram MTProto session store), `omnidisc-*` (chat/voice crates) [src-tauri/Cargo.toml; src-tauri/omniget-core/src/lib.rs]
- Pinned Rust toolchain because the plugin ABI depends on it [rust-toolchain.toml; README.md "Build from source"]
- Platform-downloader abstraction: trait `PlatformDownloader { name, can_handle, get_media_info, download }` + registry; native extractors for YouTube, Instagram, Threads, TikTok, Twitter/X, Reddit, Twitch clips, Pinterest, Bluesky, Vimeo, Bilibili, Douyin, direct files, magnet/torrent, P2P, generic yt-dlp fallback, gallery-dl [src-tauri/omniget-core/src/platforms/traits.rs; src-tauri/omniget-core/src/platforms/mod.rs; src-tauri/src/platforms/mod.rs]
- URL -> downloader resolution with a HEAD probe for unknown extensions (non-page content-type and ≥1 MiB, or `Content-Disposition: attachment` => direct segmented fetcher instead of waiting for yt-dlp's generic extractor; probe cached 10 min) [src-tauri/src/core/url_resolver.rs; src-tauri/omniget-core/src/platforms/direct_file.rs `looks_like_direct_file`, `probe_says_direct_file`]
- Direct-file extension list (archives, installers, iso, pdf/epub/office, images, bin/dat…) routes to the native HTTP fetcher without yt-dlp [src-tauri/omniget-core/src/platforms/mod.rs `DIRECT_FILE_EXTENSIONS`]
- Single-instance app; second launch forwards CLI/`omniget://` args to the running instance [src-tauri/src/lib.rs tauri_plugin_single_instance; src-tauri/src/external_url.rs]
- Auto-updater signed with minisign key, endpoint on GitHub releases; in-app update banner + Settings badge [src-tauri/tauri.conf.json plugins.updater; src/lib/stores/update-store.svelte.ts; docs/changelog v0.12.1]
- Portable mode: `portable.txt`/`.portable` next to the exe moves settings, DB, cookies, plugins, caches, yt-dlp, FFmpeg into `data/`; WebView2 user-data redirected too [README.md "Portable mode"; src-tauri/src/core/portable.rs; settings.storage.portable_* strings]
- Startup banner logs version/pid/portable/data dir [src-tauri/src/core/portable.rs `startup_banner`]
- Strict CSP, asset protocol scoped to app-data/downloads/temp, shell open limited to http/https/mailto, 0600 perms on cached tokens, CRLF-sanitised cookie/auth headers [docs/changelog v0.11.0 "Security Hardening"]
- Windows builds signed via SignPath Foundation [README.md "Code signing policy"; .github/workflows/signpath-test.yml]
- 12 UI languages (en, pt, es, fr, it, el, ru, ja, fa, lo, zh, zh-TW), translations on Weblate, key-parity invariant tests [src/lib/i18n/*.json; .weblate; src/lib/telegram-i18n-invariants.test.ts]
- "Loop" mascot on the home screen; confetti on completion [src/components/mascot/Mascot.svelte; src/components/celebrate/Confetti.svelte]
- Docs website shipped in-repo (quickstart, installation, MCP, courses, OpenNami, troubleshooting, changelog) with its own 4-tier test suite [docs/*/index.html; tests/tier1_features.mjs…tier4_realworld.mjs]
- AI-agent instructions and glossary for contributors [AGENTS.md; GLOSSARY.md; docs/agents/*.md; llms.txt]

---

## 2. Download engine

### Protocols
- HTTP/HTTPS direct file download via native Rust fetcher (reqwest, rustls, http2, gzip/brotli/deflate, socks) [src-tauri/omniget-core/src/core/direct_downloader.rs; src-tauri/Cargo.toml reqwest features]
- HLS (.m3u8) native downloader: master/variant parsing, picks highest variant ≤ target height, parallel segment fetch (`max_concurrent`), AES-128-CBC decryption with key fetch retries, SAMPLE-AES/FairPlay detected and refused ("DRM"), segments disguised as PNG/JPEG unwrapped (walks PNG chunk table / JPEG EOI), concatenated TS remuxed to real MP4 with ffmpeg `-c copy` when MP4 requested [src-tauri/omniget-core/src/core/hls_downloader.rs lines 445-680, 532-590, 761-825]
- Raw HLS referer chain: explicit referer -> page URL -> known per-platform referer -> m3u8 origin; empty referer = send none [src-tauri/omniget-core/src/platforms/generic_ytdlp.rs 525-529; hls_downloader.rs 503-517]
- Direct media URL detection (mp4/m3u8/mpd…) in the generic downloader bypasses yt-dlp [src-tauri/omniget-core/src/platforms/generic_ytdlp.rs `is_direct_media_url`]
- HLS/DASH manifest tool: paste `.m3u8`/`.mpd` with Referer + cookie, FFmpeg `-c copy` to MP4 (no DRM) [src-tauri/omniget-core/src/core/tools/manifest_dl.rs; README "Downloads (2)"]
- BitTorrent via librqbit 8: magnet links, `.torrent` URLs and local `.torrent` files; shared session, configurable listen port range (port..port+10), DHT with persistence fallback -> DHT off (trackers/PEX only), UPnP port forwarding toggle, auto-inject public tracker list, selective file download (`only_files`), 500 ms progress with speed/ETA, cancel deletes torrent, completion then "Seeding" state kept in queue [src-tauri/src/platforms/magnet/mod.rs; src-tauri/src/core/trackers.rs; src-tauri/src/core/queue.rs QueueStatus::Seeding; settings.advanced.torrent_* strings]
- Torrent contents listing before download so user picks files (`torrent_contents` command; "{{selected}} of {{total}} files selected") [src-tauri/src/commands/downloads.rs `torrent_contents`; omnibox.torrent_selected string]
- Torrent 99% endgame stall fix + remaining-bytes telemetry [docs/changelog v0.14.0]
- Torrent streaming/playback readiness: piece priority plan (playhead window of 8 pieces, first/last-piece), `can_start_playback`/`request_order`; librqbit's `FileStream` does actual ordering [src-tauri/src/core/torrent_stream.rs; src-tauri/src/commands/torrent_playback.rs]
- Person-to-person file transfer between two OmniGet installs through a relay (`relay.tonho.wtf:9009`, overridable via `OMNIGET_RELAY`), short word code (`p2p:` URLs), pause/resume/cancel on sender side, accept/decline dialog on receiver [src-tauri/omniget-core/src/platforms/p2p.rs; p2p_words.rs; src-tauri/src/commands/p2p.rs; src/components/p2p/*.svelte; p2p.* strings]
- yt-dlp as engine for ~1,800 sites; can delegate http/ftp downloads to aria2c as external downloader (never fragmented manifests, CVE-2026-50574) [src-tauri/omniget-core/src/core/ytdlp.rs lines 66-70, 169-200, 3446-3451, 3621-3640]
- aria2 "accelerated download" tool: 16 connections, resume, checksum [src-tauri/omniget-core/src/core/tools/aria2.rs; README "Downloads (2)"]
- Metalink: not supported (no reference found). FTP only via yt-dlp/aria2c delegation [ytdlp.rs `ARIA2C_ALLOWED_PROTOCOLS`]

### Segments / connections
- Native segmented HTTP fetcher: default 8 segments, 4 MiB hint (10 MiB chunks in direct path), chunked only when server supports Range and size > threshold (10 MiB direct / 50 MiB default), work-stealing between segments (steal threshold 3 s, min chunk 512 KiB), per-segment retries (3), connect/read timeouts (10 s/30 s), preallocates file with `set_len` [src-tauri/omniget-core/src/core/http_fetcher.rs 15-74, 853-905, 1121]
- Global connection budget of 24 across all active downloads; per-download ceiling = budget / active, never below 1 [src-tauri/omniget-core/src/core/adaptive_concurrency.rs `GLOBAL_CONNECTION_BUDGET`, `per_download_ceiling`]
- Adaptive per-host concurrency tuner (AIMD-style: slow up on ≥10 % measured gain, halve on 429), shared between direct fetcher and yt-dlp `-N`; YouTube hosts (googlevideo/youtu.be/youtube.com) share one key, YouTube ceiling 16 [adaptive_concurrency.rs; ytdlp.rs 329-408; direct_downloader.rs 342-405]
- Settings-level knobs: `max_concurrent_segments` (HLS pieces), `concurrent_fragments` (upper limit for `-N`, starts at 8), `max_concurrent_downloads` (default 2), `stagger_delay_ms` between starts (150 ms; 2 s for YouTube; ≥1 s when batch >3) [src-tauri/omniget-core/src/models/settings.rs AdvancedSettings; queue.rs `try_start_next`]
- Per-host request limiter: concurrent leases (default 4; YouTube/Instagram/TikTok/Twitter 2; Reddit 3) and minimum request interval (YouTube 1.5 s, Instagram 2 s, …) [src-tauri/src/core/host_limiter.rs]
- Per-host semaphore of 16 connections in the direct downloader [direct_downloader.rs `MAX_PER_HOST`]
- yt-dlp process slot semaphore (3) to avoid PyInstaller bootstrap storms; boot slot released on first output line [ytdlp.rs 1323-1400]
- yt-dlp runs as zipapp on system Python ≥3.10 when present (0.4 s start vs 12-90 s onefile) [ytdlp.rs 1690-1790; README "first download"]
- Stale PyInstaller `_MEI*` temp dirs cleaned (>1 day old) [ytdlp.rs `cleanup_stale_pyinstaller_dirs`]

### Resume
- `.part` file + `.part.resume.json` sidecar with per-segment `begin/end/downloaded`, saved every 2 s; resumes from sidecar on restart [http_fetcher.rs `ResumeState`, `sidecar_path_for`, 220-262, 478-483]
- Single-stream resume via Range from existing `.part` length when server supports ranges [direct_downloader.rs 293-307]
- Range header stripping to avoid double `Range` lines (corruption guard) [http_fetcher.rs 1615-1629]
- yt-dlp continues partial files; `--no-part` only for live-from-start [ytdlp.rs 3524-3527]
- Pause/resume of running yt-dlp processes (SIGSTOP-style `pause_download_process`/`resume_download_process`) and of torrents (`is_paused`) [ytdlp.rs 654-660; magnet/mod.rs 237]
- Queue write-ahead log: append-only state transitions, replay on start, last corrupt line discarded, compaction [src-tauri/src/core/queue_wal.rs]
- Recovery dialog on launch: "found N unfinished downloads — resume / discard", restores URL/options/format/referer [src-tauri/src/core/recovery.rs; src/components/dialog/RecoveryDialog.svelte; recovery.* strings]
- Download history (SQLite-backed, with thumbnail/kind/size/error) and "Download again" from history [src-tauri/src/core/queue_history.rs; downloads.history_* strings]
- Hydrate queue from history on start [queue.rs `hydrate_from_history`]

### Speed limits
- Global speed limit string passed as yt-dlp `--limit-rate`; "No limit" when empty [settings.rs `speed_limit`; ytdlp.rs 3519-3522; settings.download.speed_limit strings]
- YouTube: `--throttled-rate 100K` (re-extract when throttled), `--sleep-subtitles 5`, and after the first 429 of the session `--sleep-requests 1 --sleep-interval 2 --max-sleep-interval 5` [ytdlp.rs 3420-3438]
- Buffer size 16M; `--http-chunk-size 10M` for non-YouTube [ytdlp.rs 3441-3444]
- Extra yt-dlp flag toggles in Settings: limit rate, sleep interval, force IPv4, geo bypass, restrict filenames, no overwrites, prefer free formats, embed subs, write thumbnail/description/comments [settings.ytdlp_flags.* strings; settings.rs `extra_ytdlp_flags`]

### Mirrors / CDN
- Bilibili CDN fallback: user-provided alternative mirror hosts, "prefer alternatives" toggle [settings.rs `bilibili_cdn_hosts`, `bilibili_cdn_prefer_alternatives`; src-tauri/src/platforms/bilibili/cdn.rs]
- No generic multi-mirror/metalink support for HTTP downloads (none found).

### Checksums / integrity
- Content-Length vs actual size mismatch check after download; mismatch deletes `.part` [direct_downloader.rs 310-320]
- Binary signature sniff of first 512 bytes: rejects HTML served as media (MP4/WebM/MKV/MPEG-TS/… signatures; HTML/`<Error` detection tolerant of BOM; XML/SVG/MPD not treated as errors); mirrored in the browser extension [src-tauri/omniget-core/src/core/media_signature.rs; direct_downloader.rs `reject_html_masquerading_as_media`; browser-extension/chrome/src/media-signature.js]
- Output validation: success only if the file/dir exists and is non-empty ("check disk space and antivirus") [queue.rs `validate_download_output`]
- Managed binaries verified fail-closed against published SHA-256 (yt-dlp) [src-tauri/omniget-core/src/core/dependencies.rs 14-18; README "first download"]
- Minimum yt-dlp version gate (2026.06.09 for CVE fixes), `--update-to` channel check once per session, "Outdated" status in dependency table [ytdlp.rs 142-167, 1117-1140; settings.dependencies.status_outdated]
- aria2 tool exposes checksum verification [tools/aria2.rs header]

### Proxies
- App proxy settings: enabled, type (http default; reqwest built with socks), host, port, username, password; applied to reqwest client and to yt-dlp `--proxy`, aria2c args; logs "system/env proxy honored" when disabled [settings.rs ProxySettings; queue.rs 1249-1268; ytdlp.rs `proxy_args`; src-tauri/src/core/http_client.rs]
- CLI `--proxy` global flag [src-tauri/omniget-cli/src/main.rs 14]
- Insecure-TLS toggle (`--no-check-certificates`) for corporate MITM networks, default off, with migration test [settings.rs `insecure_tls`; ytdlp.rs `insecure_tls_args`]

### Auth / cookies / headers
- Cookie Manager: per-root-domain buckets, multiple accounts per domain (`_default.txt` + `<slug>.txt`, Netscape format), `_meta.json` registry (alias, source URL/label, captured_at, cookie count, last used), 24 h trash bin, enable/disable per bucket, rename, view/filter/copy, export to file, test button per domain, fresh/aging/stale/expired indicators [src-tauri/src/cookies/storage.rs; src-tauri/src/cookies/commands.rs; settings.cookies.* strings]
- Cookie import: Netscape `.txt`, JSON (EditThisCookie), paste modal, "add generic domain" bucket [src-tauri/src/cookies/parsers.rs; settings.cookies.import_* strings]
- Correct registrable-domain grouping incl. `.com.br`-style suffixes [src-tauri/src/cookies/platform.rs `root_domain_of`]
- Legacy single `chrome-extension-cookies.txt` kept for SDK v2 plugins, migrated into buckets [src-tauri/src/extension_storage.rs; cookies/mod.rs header]
- yt-dlp gets a disposable copy of the cookie file (yt-dlp rewrites `--cookies` files) [ytdlp.rs 2242-2262]
- Per-download cookie account picker in the omnibox (`cookie_slug`) [src/components/omnibox/CookieAccountPicker.svelte; downloads.rs `download_from_url(cookie_slug)`]
- Stale/expired cookie hint shown in omnibox for the target site [omnibox.cookie_hint_* strings]
- "Always use managed cookies" toggle; `cookies-from-browser` (firefox/chrome/edge profile) advanced option; manual `Cookie:` header override (any site) [settings.rs `always_use_managed_cookies`, `cookies_from_browser`, `twitter_manual_cookie`]
- Login webview inside the app for course platforms and Bilibili; Bilibili QR login, SMS login with captcha, "import Watch Later / History" into queue [src-tauri/src/commands/auth_webview.rs; src-tauri/src/commands/bilibili_auth.rs; src-tauri/src/platforms/bilibili/auth/*.rs; settings.cookies.bilibili.* strings]
- Bilibili session-expired banner [src/lib/components/BilibiliSessionExpiredBanner.svelte]
- Custom headers per download from the extension (allow-listed: referer, origin, cookie, authorization, token-style headers) registered per URL and passed via `--add-headers`; referer field in omnibox [src-tauri/src/core/queue.rs 1718-1723; ytdlp.rs `register_ext_headers`; browser-extension/chrome/src/header-allowlist.js; omnibox.referer_label]
- Custom User-Agent setting; default Chrome UA; extension-provided UA per URL [settings.rs `user_agent`; ytdlp.rs 3453-3461, `register_ext_user_agent`]
- HTTP 403 "ladder": retry with `Range: bytes=0-`, then + `sec-fetch-mode/site` hints [direct_downloader.rs 165-216]
- yt-dlp 403 recovery: add `--force-ipv4`, add fallback `--referer` (page origin) [ytdlp.rs 3973-3978, 4060-4077]
- TLS-fingerprint block detection -> retry with `--impersonate <best Chrome target>` using curl_cffi targets listed once per session [src-tauri/omniget-core/src/core/impersonation.rs; ytdlp.rs 3980-4005]
- YouTube PO-token provider support: `OMNIGET_POT_PROVIDER_URL` (bgutil) probed for health, `--extractor-args youtubepot…` only when alive [src-tauri/omniget-core/src/core/pot_provider.rs; ytdlp.rs 4007-4038]
- YouTube `player_client` cascade: default / `default,web_safari` with cookies; rotate to `mweb`/`ios` on 429, `ios`/`mweb` on nsig errors, SABR-only fallback chain (`tv_downgraded`, …), drop cookies on reload errors or when an authenticated download degrades to 360p (format 18) [ytdlp.rs 71-90, 3409-3418, 3771-3786, 3936-3971]
- JS runtime for yt-dlp nsig solver: finds Node/Deno/Bun or auto-downloads Deno; passed via `--js-runtimes` [dependencies.rs `ensure_js_runtime`; ytdlp.rs 2262-2270]
- Subtitle 429s isolated: disable subtitles for remaining retries instead of the whole download [ytdlp.rs 3888-3906]

### Retries / errors
- Queue-level retries with exponential backoff (1,2,4,8,16,30 s), only for `unknown`/`rate_limited` categories; retry counter reset after >5 MiB progressed; `max_retries` setting [queue.rs 1925-1974; settings.advanced.max_retries]
- yt-dlp-level 3 attempts: 429 waits 10·2^n + jitter; format/postprocessing errors simplify `-f` and `--merge-output-format`; Errno 22 adds `--restrict-filenames`; aria2c failure falls back to native; `--retries 5 --fragment-retries 5 --extractor-retries 3 --file-access-retries 3 --retry-sleep exp=1:30 --skip-unavailable-fragments` [ytdlp.rs 3457-3485, 3585-4130]
- Terminal-error classification (source gone / fragments 404 / DRM / postprocess) stops retries early [src-tauri/omniget-core/src/core/errors.rs; ytdlp.rs 4679-4690]
- Error categories with user hints: broken_source, postprocess_failed, auth_required, rate_limited, restricted, … + translated error table (login required, 429, 403, geo, copyright, ffmpeg missing, disk full, path too long, console encoding, DRM, output missing…) [errors.rs; errors.* strings; src/lib/error-translate.ts]
- Root-cause diagnosis of yt-dlp stderr mapped to an actionable remedy button (ImportCookies, UseImpersonation, SetUpPotProvider, SwitchPlayerClient, WaitAndRetry, FreeDiskSpace, UpdateYtdlp) [src-tauri/src/core/root_cause.rs; src/components/downloads/RootCauseHint.svelte; `diagnose_download_error` command]
- Stall detection: no progress for 6 s => phase "stalled" with speed 0 [queue.rs 1513-1560; downloads.phase_stalled]
- Exact yt-dlp command recorded per attempt (redacted) and shown in UI; "Edit & retry" runs the user-edited argv once, instrumented automatically [ytdlp.rs `CommandRecord`, 415-418, 4350-4360; downloads.command.* strings; `retry_download_with_command`]
- Per-download log lines (`[omniget]`, `[network]`, `[cookies]`, `[subtitles]`) viewable/copyable [src-tauri/src/core/download_log.rs; downloads.log.* strings]
- Global "flight recorder" of last N events with secret redaction for bug reports [src-tauri/src/core/flight_recorder.rs; `flight_recorder_dump`]
- Output-path length validation (Windows MAX_PATH reserve) before enqueue [src-tauri/src/core/path_limits.rs; errors.path_too_long]
- Corrupt state files quarantined (`.corrupt-<ts>`) instead of silently reset [src-tauri/src/core/state_file.rs]
- Generic titles ("video", "untitled") replaced by `video_<pokemon>` [queue.rs `is_generic_title`; src-tauri/omniget-core/src/core/pokemon_names.rs]
- Rate-limit stats exposed (`get_rate_limit_stats`) [ytdlp.rs 4814]

---

## 3. Sites & extractors

- Native extractors: YouTube (videos, playlists, channels, live, chapters, SponsorBlock, format list with vcodec/acodec/fps/size), Instagram (post/reel/IGTV/carousel/stories/highlights via session), Threads, TikTok, X/Twitter (FxTwitter API for public), Reddit (v.redd.it with audio, galleries, images), Twitch (VODs, clips, live), Vimeo (incl. private/showcase tools), Bluesky, Pinterest (pins, boards, profiles), Douyin, Bilibili, Facebook (albums/video via Open Nami extractor) [src-tauri/omniget-core/src/platforms/*.rs; src/lib/open_nami/extractors/*.ts; README "What OmniGet downloads"]
- Generic yt-dlp fallback for ~1,800 sites; search box does `ytsearchN:` [src-tauri/omniget-core/src/platforms/generic_ytdlp.rs; src-tauri/src/commands/search.rs]
- gallery-dl integration for 250+ image sites (DeviantArt, Pixiv, ArtStation, Flickr, Tumblr, Imgur, Kemono…), gallery/bulk URL detection, managed gallery-dl binary [src-tauri/src/platforms/gallerydl/mod.rs `is_gallery_url`/`is_bulk_media_url`; dependencies.rs `ensure_gallerydl`; tools/gallery.rs]
- Bilibili native engine: 11 URL kinds (video, multi-part, bangumi episode/season/media, cheese course, space, favlist, collection, series, popular, watch-later, history, festival), WBI signing, quality ladder 360p…8K/HDR/Dolby Vision/AI upscale, codecs AVC/HEVC/AV1, audio 64k/132k/192k/Hi-Res/Dolby Atmos, MP4/MKV container, DASH fetch + ffmpeg mux, premium/paid/preview badges, cover sidecar (jpg/webp/avif/png), NFO (tvshow/episode), danmaku XML/ASS/JSON (+ burn-in, filters, lane layout), per-kind naming templates [src-tauri/src/platforms/bilibili/**; settings.download.bilibili_* and platforms.bilibili.* strings]
- Playlists: entries listing with per-item selection, `--lazy-playlist`, `--playlist-end`, `--flat-playlist` for channels [downloads.rs `playlist_entries`; omnibox.playlist_* strings; ytdlp.rs flags]
- Incremental channel listing with `--download-archive` + `--break-on-existing` for followed channels [ytdlp.rs `get_playlist_info_incremental`, `archive_extractor_prefix`]
- Qualities: Best / 2160p / 1440p / 1080p / 720p / 480p / 360p presets, format selectors `bv*[height<=h]+ba[ext=m4a]/…`, modes Auto / Audio only / Mute (video-only), explicit `format_id` from a formats table (type, quality, A/V, codec, size, bitrate), presets Best / Music / Custom [ytdlp.rs 3153-3193, `parse_formats`; omnibox.quality_* and fmt_* strings; src/components/omnibox/FormatSelector.svelte]
- Audio-only output formats MP3/M4A/Opus/FLAC/WAV (`--audio-format`), music hotkey format setting [settings.rs `music_audio_format`; README FAQ]
- Time-range download (`--download-sections *start-end`) [downloads.rs 882-887; omnibox.timerange_* strings]
- Subtitles: download, auto-generated captions, language selection with availability probe, SRT conversion or keep VTT, embedded or sidecar, `--sub-format best`; bilingual merge of two languages (SRT/VTT/ASS) [ytdlp.rs 3533-3583; src-tauri/omniget-core/src/core/subtitle_merge.rs; settings.download.caption_locale etc.]
- Live streams: record live from start (`--live-from-start --no-part`), Twitch live, live-chat replay export JSON/CSV [settings.rs `live_from_start`; src-tauri/omniget-core/src/core/livechat.rs; `livechat_fetch`]
- DRM handling: no circumvention; HLS SAMPLE-AES refused, DRM-protected course lectures skipped and counted, toast "N videos skipped — DRM" [hls_downloader.rs 453-455; plugins/courses/src/platforms/udemy/downloader.rs 104-186; toast.drm_skipped; errors.drm_protected]
- Metadata translation: YouTube `lang=` extractor arg to localise titles/chapters [settings.rs `translate_metadata`; ytdlp.rs `YoutubeExtractorArgs`]
- Site logins: extension-captured cookies; in-app webview login for 38 course platforms (Hotmart, Udemy, Kiwify, Skool, Gumroad, Rocketseat, Teachable, Kajabi, Thinkific, Pluralsight, Great Courses, MasterClass, Greenn, Kirvano, Cademi, MemberKit, Cakto, Curseduca, DSA, Entrega Digital, Estratégia ×3, Fluency Academy, Gran Cursos, Medcel, MedCof, Medway, Eduzz Nutror, The Members, Voomp, Afya, Alpaclass, Área de Membros, Astron Members, Matemática pra Passar…) [src-tauri/plugins/courses/src/catalog.rs; plugins/courses/src/platforms/*]
- Courses plugin: list purchases, course outline with section selection, attachments, descriptions, continuous lecture numbering, resume, index into Study [README "Courses"; settings.download.download_attachments/continuous_lecture_numbers]
- Telegram plugin: QR or phone login, browse channels/groups, filter by media type, search, per-media or whole-archive download, parallel chunked MTProto download with cross-DC handling, thumbnail cache, `OmniGram/<channel>/` folders, fix file extensions, concurrent downloads setting, account switcher, channel cloner wizard, perf panel, in-app media player (chapters, thumbnail scrubber, seek heatmap, SponsorBlock overlay, skip-gaps, binge toast, keyboard help), upload modal [src-tauri/plugins/telegram/**; src/lib/telegram-components/**; settings.telegram.*]
- Open Nami social archiver: bulk profile downloads for Instagram (photos/videos/stories/highlights), TikTok, X, Facebook; native extractor first then gallery-dl fallback ("multi-tier"); saved profiles; own output dir/cookies file [src/lib/open_nami/**; src-tauri/src/commands/open_nami/**; open_nami.* strings]
- Media-changed detection: snapshot of duration/chapters/title per URL; re-downloading warns "This link changed since you last downloaded it" [src-tauri/src/core/media_diff.rs; src-tauri/src/commands/media_history.rs; omnibox.media_changed]
- Batch pre-flight: resolves each URL, flags Unsupported / NeedsAuth / NotFound / AlreadyHave, estimates size vs free disk, verdict before starting [src-tauri/src/core/preflight.rs; `preflight_batch`; omnibox.preflight_* strings]
- Media info cache (TTL) + in-flight de-dup + preview prefetch (2 concurrent) emitting title/author/thumbnail/duration to omnibox [queue.rs 2019-2173; src/components/omnibox/MediaPreview.svelte]

---

## 4. Queue & scheduling

- Queue states: Queued, Active, Paused, Seeding, Complete{success}, Error{message, retryable} [queue.rs `QueueStatus`]
- Queue "kinds" for UI badges: video, audio, image, pdf, book, webpage, telegram_media, course_lesson, generic [queue.rs `QueueKind`; src/components/common/QueueKindBadge.svelte]
- Concurrency cap + stagger delay; next items auto-start when a slot frees; RAII slot guard prevents leaked slots on panic [queue.rs `try_start_next`, `ActiveJobSlot`]
- Pause / resume / cancel / retry / remove single, pause-all / resume-all, drag-to-reorder, clear finished, duplicate-URL guard [downloads.rs commands; queue.rs `reorder`; downloads.* strings]
- Per-item scheduling: `scheduled_at` start time and `stop_at` stop time (presets "in 1 hour / tonight / tomorrow"), 15 s scheduler tick starts due items and cancels past stop time [downloads.rs `download_from_url(scheduled_at, stop_at)`; queue.rs `start_scheduler`; omnibox.schedule_* strings]
- No bandwidth-by-time-of-day schedule and no priority levels (ordering only) [queue.rs — absence]
- Rules engine ("Sieve-like"): conditions HostIs / UrlContains / PlatformIs; actions output_dir, quality, audio_only, subtitles, tags; first match wins; ordering, enable toggle, "test a link" preview, "Rule X applied" toast [src-tauri/src/core/rules.rs; src-tauri/src/commands/rules.rs; settings.rules.* strings; omnibox.rule_applied]
- Followed channels/playlists: background poller with per-channel interval, enabled/auto-download toggles, seen-id list, "check now", tray submenu, toasts "N new videos" / auto-download [src-tauri/src/core/channels.rs; channel_poller.rs; settings.channels.* strings; toast.channel_new*]
- Post-actions after download: embed metadata/thumbnail (ffmpeg), NFO sidecar, copy file to clipboard (hotkey downloads), native notification, confetti; no user-defined run-command post-action [queue.rs 1828-1881; src/lib/stores/download-listener.ts]
- Batch: paste many URLs (auto-detected count), load `.txt` file, "Download all"; CLI `batch` with `-m` concurrency [omnibox.batch_* strings; `parse_batch_file`; omniget-cli/src/commands/batch.rs]
- External/plugin downloads join the same queue ("host queue": enqueue_external, report_progress, report_complete) [src-tauri/src/commands/host_queue.rs]
- Prevent system sleep while downloads active (toggle) [src-tauri/src/core/awake.rs; settings.advanced.prevent_sleep]
- Download stats line ("N downloads · X saved") and home value line [downloads.stats_line; home.value_line; src/lib/stores/download-stats.svelte.ts]

---

## 5. Browser integration

- Chrome (MV3) and Firefox extensions bundled inside the app and exportable from Settings (Update/Install opens the folder for "Load unpacked"); release zip also published [browser-extension/chrome/manifest.json; browser-extension/firefox/manifest.json; src-tauri/tauri.conf.json bundle.resources; `browser_extension_export`]
- One-click / Alt+O "send page to OmniGet" on recognised sites (YouTube, Instagram, TikTok, X, Reddit, Twitch, Pinterest, Bluesky, Telegram, Vimeo, Udemy, Hotmart, Rocketseat, Bilibili, SoundCloud) with cookies, referer and title forwarded [manifest.json host_permissions, commands; src/action-click.js; src/detect.js]
- Media sniffer on any site: watches network for MP4/WebM/FLV/MKV/MOV/… audio formats, HLS/DASH manifests (content-type + extension rules, size floors), lists them in popup, "Send all" [src/media-sniffer.js; src/sniffer-filters.js; popup strings popup_videos_found etc.]
- Video+audio track pairing (200 ms window) so adaptive streams become one file [src/track-pairing.js]
- HLS size estimation by sampling 10 segments with HEAD [src/hls-size.js]
- HLS variant grouping [src/hls-grouping.js]
- First-bytes signature check in extension so HTML error pages are never offered [src/media-signature.js]
- Deep search: MAIN-world hooks on fetch/XHR/JSON.parse/TextDecoder/Worker to catch playlists that never hit the network; `blob:` playlists shipped as synthetic manifests (`deep-search.omniget.invalid`); optional all-sites permission [src/deep-search.js; src/synthetic-manifest.js; src/deep-search-toggle.js]
- User-editable capture rules (extensions / content types / regex / size comparisons) in the options page [src/capture-rules.js; src/capture-store.js; tests/capture-rules-ui.test.mjs]
- Blocked-host list for analytics/ads so they never appear as media [src/blocked-hosts.js]
- Force H.264 (and optional block-60fps) on YouTube by patching `canPlayType`/`isTypeSupported`/`decodingInfo` [src/h264ify.js; src/h264ify-60.js; src/h264-toggle.js]
- Manual "capture cookies from this site" to the app; platform mapping (youtube, youtube_music, soundcloud, spotify, twitch, instagram, x_twitter, vimeo, tiktok, bilibili, reddit, pinterest, bluesky, hotmart, udemy…) [src/cookie-capture.js; src/cookies.js]
- Context menu "Download with OmniGet" on links, video, audio, images [src/context-menu.js]
- Extension backup/inventory (MV2 sunset): JSON/Markdown/HTML export, optional `management` permission [src/ext-backup.js; pages/ext-backup.html]
- Localhost bridge: `127.0.0.1:47720-47729`, bearer token per install, endpoints `/v1/health`, `/v1/pair` (time-limited auto pairing), `/v1/enqueue`, `/v1/queue`, `/v1/log/{id}`, `/v1/cookies`, `/mcp`, `/media/{token}`; token rotate/reveal/copy in Settings [src-tauri/src/local_bridge.rs 12-24, 502-519; settings.bridge.* strings; `rotate_bridge_token`]
- Fallback to `omniget://` URL scheme when app closed (queues URL, no cookies); scheme also accepts `omniget:magnet:…` and `p2p:` [README "Level 3"; src-tauri/src/external_url.rs; tauri.conf.json deep-link schemes]
- "Open app" toggle and action feedback (badge/title) in extension [src/open-app-toggle.js; src/action-feedback.js; src/action-title.js]
- Clipboard: optional URL/magnet/`p2p:` detection poller with toast "Link detected", optional auto-download on paste; global hotkeys Ctrl+Shift+D (download clipboard URL), Ctrl+Shift+M (audio-only), Ctrl+Shift+B (clip), rebindable with key recorder; result toasts (queued / already queued / not a URL / unsupported) [src/lib/stores/clipboard-monitor.ts; src-tauri/src/hotkey.rs; settings.download.hotkey_*; toast.hotkey_* strings]
- Local media streaming server with Range support for the in-app player (tokenised, expiring grants) [local_bridge.rs 75-230; `media_stream_url`]

---

## 6. UI

- Views/routes: Home (omnibox + inspector), Downloads (queue / History / Tools tabs, status filter), Marketplace, Tools hub (25 categories, bilingual PT/EN keyword search, OS filter, beta/planned badges), Convert, Courses, Telegram, Open Nami, League, OmniDisc chat, Settings (grouped sidebar, searchable, drill-in), About (changelog, project, terms), kitchen-sink dev page [src/routes/**; src/lib/nav-config.ts; src/lib/tools/catalog.ts]
- Omnibox: single box for URL / magnet / .torrent / search; preview card; quality picker; download mode; advanced mode with raw yt-dlp args + saved templates; referer; time range; schedule; playlist/torrent item selection; cookie account; batch detection [src/components/omnibox/*.svelte; src-tauri/src/commands/yt_templates.rs]
- Download card: phases (fetching_info, starting, connecting, downloading_video/audio, merging, postprocessing, finalizing, stalled, waiting_rate_limit, extracting_audio, embedding_subtitles), step strip (Info/Video/Audio/Download/Merge/Finish), fragment i/n, connections, attempt n/m, player client, elapsed, speed graph, poster, exact command, log, root-cause hint, "Show in folder", "Delete file from disk" [src/components/download/*.svelte; downloads.* strings; queue.rs `QueueItemProgress`]
- Progress template parses yt-dlp `info.*` so resolution/codec/container/size of current stream are shown live [ytdlp.rs 409-413, 4820-4960]
- Themes: system/light/dark + Catppuccin (latte/frappe/macchiato/mocha), Dracula, One Dark Pro, e-ink day/night/sepia, Nyxvamp obsidian/radiance/veil (14 themes); reduce motion / reduce transparency / disable haptics accessibility toggles [src/app.css data-theme values; settings.rs AccessibilitySettings; settings.appearance.*]
- Typography settings: display/body/mono fonts, line-height, global spacing scale, presets (Omniget default, Notion-like, Compact, Reading, Tech minimal) [settings.rs TypographySettings; settings.typography.*]
- Command palette Ctrl/Cmd+K (navigate pages/settings/tools, paste URL action, `/omnidisc`) [src/components/shell/CommandPalette.svelte; command_palette.*]
- Keyboard shortcuts dialog (Ctrl+?, Ctrl+, settings, Ctrl+F, Ctrl+1/2 nav, Ctrl+H history, Enter/Esc) [src/components/dialog/ShortcutsDialog.svelte]
- Notifications: native OS notification on completion, in-app toasts (download started/complete/error with retry, clipboard, channel, DRM skipped), notification centre with unread filter (lessons) [src/lib/stores/download-listener.ts; src/components/toast/Toast.svelte; notifications.* strings]
- System tray: icon, menu (Open, "Downloads — N active", Channels submenu with check-now, Quit), tooltip with active count + aggregate speed, localised labels; start with system; start minimised to tray; confirm-close dialog [src-tauri/src/tray.rs; src-tauri/src/commands/autostart.rs; settings.general.*; src/components/dialog/ConfirmCloseDialog.svelte]
- Onboarding wizard: language, theme, one-click install yt-dlp+FFmpeg, download folder [src/components/onboarding/OnboardingWizard.svelte; onboarding.* strings]
- Announcement / changelog / legal (terms & ethics acknowledgement) dialogs; contextual hints with "reset hints" [src/components/dialog/*.svelte; src/components/hints/ContextHint.svelte]
- Debug panel + `get_debug_info`, hwaccel info [src/components/debug/DebugPanel.svelte; src-tauri/src/commands/diagnostics.rs]
- Mobile: Android/iOS icon sets and `cfg(not(target_os="android"))` guards exist, but no mobile build is published (desktop only) [src-tauri/icons/android, ios; queue.rs 1865]
- macOS private API window styling [tauri.conf.json macOSPrivateApi; src/lib/style/macos-shell.css]
- Discord Rich Presence (listening/watching/reading; downloads private; custom app id/image key; test connection) [src-tauri/src/core/rpc.rs; src/components/settings/RichPresencePanel.svelte]

---

## 7. Organization

- Default output folder; "always ask where to save"; organise by platform subfolder; skip existing (`--no-overwrites`) [settings.rs DownloadSettings; queue.rs 1459-1478]
- yt-dlp filename template (default `%(title).200s [%(id)s].%(ext)s`) with live preview; `--trim-filenames`, `--windows-filenames` on Windows [settings.rs `default_filename_template`; ytdlp.rs 3474-3475, 3529-3531]
- Bilibili per-kind naming templates with `{title} {bvid} {series_title} {season_number} {episode_number_pad2} …`, slash creates folders [settings.rs bilibili_naming_*; settings.download.bilibili_naming_help]
- Telegram `OmniGram/<channel>/` folders with sanitised names [docs/changelog v0.10.5]
- Rules can route host/platform to folder + quality + tags [rules.rs `Actions.tags`]
- Metadata: embed title/artist/thumbnail via ffmpeg (`--embed-metadata --embed-thumbnail --convert-thumbnails jpg`), `.nfo` sidecar for Jellyfin/Kodi/Emby, Bilibili cover sidecar + tvshow/episode NFO, descriptions saved, comments/chapters/metadata JSON tools [queue.rs 1828-1862; src-tauri/src/core/nfo_sidecar.rs; `metadata_fetch`, `chapters_fetch`, `comments_fetch`]
- Split by chapters into separate files (`--split-chapters`) [settings.rs `split_by_chapters`]
- Content-addressed store dedupe: SHA-256 hard-linked objects under `content-store/`, post-download "Deduplicate…" on picked files with savings stats (Unix only measurable) [src-tauri/src/core/cas.rs; src-tauri/src/commands/dedupe.rs; settings.storage.dedupe_*]
- Download history with kinds/thumbnails; recovery of unfinished items [queue_history.rs; recovery.rs]
- No free-form user tags on queue items beyond rule `tags` (no tag UI found) [rules.rs]

---

## 8. Conversion & post-processing

- FFmpeg managed (auto-download, ad-hoc codesign on macOS, version check, rollback to previous versions, custom path) [dependencies.rs `ensure_ffmpeg`, `replace_managed_binary`; src-tauri/src/core/binary_versions.rs; settings.dependencies.*]
- Merge separate video+audio (`--merge-output-format mp4`, `mux_video_audio`), HLS TS->MP4 remux [ytdlp.rs; src-tauri/omniget-core/src/core/ffmpeg.rs `mux_video_audio`; hls_downloader.rs 585-590]
- Convert plugin: container/codec/resolution/bitrate/preset/trim, GPU hw-accel detection (`get_hwaccel_info`), batch files/folder, probe [src-tauri/plugins/convert/src/lib.rs; convert.* strings]
- Re-encode dialog: HEVC/H.264/AV1 with optional replace-original-if-smaller, savings toast [src-tauri/src/commands/reencode.rs; reencode.* strings]
- "Video ops" overlay on a downloaded file: quick presets extract_audio, mute, to_mp4, to_gif, voice_boost, smart_speed (silenceremove), trim; natural-language -> ffmpeg command via configured AI with allow-list validation and user review [src-tauri/src/commands/video_ops.rs; src-tauri/omniget-core/src/core/ffmpeg_ops.rs; downloads.vop.* strings]
- Silence map for playback-time skipping (Overcast-style Smart Speed) computed once per file [src-tauri/src/core/silence_map.rs; src-tauri/src/commands/smart_speed.rs]
- Clip cutter (file on disk -> section -> queue) with Ctrl+Shift+B clip hotkey; scene-change detection; waveform peaks [src-tauri/src/commands/clip.rs; video_ops.rs `detect_shot_changes`, `waveform_peaks`]
- Thumbnails: embed as cover, list/save YouTube thumbnails at any resolution, "real thumbnail" frames at 25/50/75 % [`thumbnails_list`, `thumbnail_save`; src/components/tools/youtube/FramesTool.svelte]
- SponsorBlock: remove or mark (chapters) with category selection (sponsor, selfpromo, interaction, intro, outro, preview, filler, music_offtopic) in downloads; SponsorBlock viewer/submit tools; Return YouTube Dislike [ytdlp.rs 3489-3503; settings.download.sb_*; tools/sponsorblock.rs; tools/ryd.rs]
- Subtitles post-processing: convert SRT/VTT/ASS, burn-in, resync (shift / stretch / two-point), Subtitle Workshop (waveform, find/replace, auto-fix QC: negative, overlap, reading speed; AI grammar fix with style; AI translate) [src/components/downloads/SubtitleWorkshop.svelte; src-tauri/src/commands/subtitle_ws.rs; tools/subtitle.rs; tools/srt_translate.rs]
- Audio: EBU R128 loudness normalisation, noise removal, ID3/tagging, cover art [tools/audio_clean.rs; tools/audio_tag.rs; ffmpeg_ops.rs 175-178]
- Video tools: compress to target size (two-pass), GIF/WebP with palette, cut silence, restore (deflicker/denoise/deband), stabilise (vidstab two-pass), sticker (WhatsApp/Telegram size limits), screen record with replay buffer (beta) [tools/video_compress.rs; video_gif.rs; silence_cut.rs; video_restore.rs; sticker.rs; screen_record.rs; README "Video editing (14)"]
- Transcription: whisper.cpp offline (models on demand, Metal on macOS), AI-provider transcription fallback; TTS via Microsoft Edge voices with synced subtitles; dub from SRT; VoiceStudio clone/design/isolate; dictation hotkey [tools/whisper.rs; ai.rs `transcribe`; tools/edge_tts.rs; tools/dub.rs; tools/voicestudio.rs; tools/dictation.rs]
- Images: Real-ESRGAN upscale (Vulkan), resize, compress-to-KB, EXIF/GPS view+strip, perceptual duplicate finder, screenshot stitch, icon pack, spritesheet, OCR (ONNX runtime), background removal [tools/upscale.rs; image_*.rs; exif.rs; ocr.rs; onnx.rs; img_bg.rs]
- PDF: merge, split, compress, convert, OCR, repair, password/permissions (AES-128), watermark/Bates, crop margins, outline/TOC, redaction check, "safe PDF" rasterise, PDF->Markdown, tables, forms, JPEG->PDF; PDFium managed dependency [tools/pdf*.rs; jpeg_pdf.rs; src-tauri/omniget-core/src/core/pdfium.rs]

---

## 9. Integrations

- MCP server (beta) on the local bridge `/mcp`, 37 tools incl. download_enqueue/downloads_queue/download_status/pause/resume/cancel, youtube_sponsorblock/dislikes, pdf_*, tts_speak, transcribe, image_resize, ocr, find_duplicates, file_search, ai_prices, humanize, x_post/thread/profile/search/trends, instagram_profile, gallery_download, disk_*, clean_scan, startup_items, installed_apps, ai_keys; ready-made config snippets for Claude Code, Claude Desktop, Cursor, VS Code, Goose, Codex [src-tauri/src/mcp.rs 216-509, 630-650; docs/mcp/index.html]
- Claude Code plugin (`claude-plugin/` referenced; `/omniget:setup|fetch|transcribe|research|doctor`) using `omniget-cli` [README "OmniGet for AI agents"] (folder not present in this checkout)
- CLI `omniget-cli`: `info <url>` (title/formats/size), `download <url> -q 1080 -o DIR --audio-only --subs en,pt --format mp4|mkv|webm`, `batch links.txt -m 3`, `import-cookies cookies.txt --name --dry-run`, global `--json` and `--proxy`; `OMNIGET_COOKIES_FROM_BROWSER` retry on login walls [src-tauri/omniget-cli/src/main.rs; commands/*.rs; cookies.rs]
- Plugin system: manifest (id, version, min_omniget_version, nav items with localised labels, events, capabilities such as core:events/core:toast/core:settings/core:filesystem/core:tools, settings schema, frontend dir), SDK crate, loader, marketplace registry (`fetch_marketplace_registry`, install/update/uninstall/enable), permission display [src-tauri/omniget-plugin-sdk/src/manifest.rs; src-tauri/src/plugin_loader.rs; src-tauri/src/commands/plugins.rs; marketplace.* strings]
- Embedded plugins: Courses, Telegram, Convert (statically compiled); Study (library/player/reader PDF-EPUB-DJVU-MOBI-AZW3-FB2-CBZ-CBR/notes/Anki/focus timers/music) lives in external `omniget-plugin-study` [README "Plugins"; docs/changelog v0.14.0, v0.10.5]
- RSS: only "RSS feeds" mentioned in a Settings hero description; actual implementation is yt-dlp-based channel/playlist polling, not RSS [settings.hero_desc_channels; channel_poller.rs]
- Cloud storage upload: none found. Remote control: only via local MCP/bridge HTTP on 127.0.0.1 (`/v1/queue`, `/v1/enqueue`) [local_bridge.rs]
- AI provider settings: OpenAI, Anthropic, local OpenAI-compatible (Ollama/LM Studio), model, key vault, test, usage ledger, history; video summariser (fetch subtitles -> summary short/balanced/detailed in chosen language) [src-tauri/omniget-core/src/core/ai.rs; src-tauri/src/commands/ai.rs `ai_summarize_url`; settings.ai.*]
- KDE Connect "send to phone" [tools/kdeconnect.rs]
- Discord Rich Presence [rpc.rs]
- Spicetify (Spotify client themes/extensions) [src-tauri/omniget-core/src/core/spicetify.rs; src-tauri/src/commands/spicetify.rs]
- OmniDisc self-hosted Discord-style chat (text, DMs, friends, roles, voice, video, screen share with hw encoding, MLS E2EE), off by default [src-tauri/omnidisc-*/; src/routes/omnidisc/**; settings.rs OmnidiscSettings]
- League of Legends client companion (scouting, live stats, automation, skin roulette, AI coach), off-switchable [src-tauri/src/commands/league/*.rs; settings.rs LeagueSettings]
- Package tracking (Brazilian carriers: Correios, Loggi, Cainiao, Shopee, J&T…) via plugin bridge with notifications and streamer-mode code hiding [src/lib/tracker-bridge.ts; tracking.* strings]
- Social/data-export tools: Instagram (24 tools incl. stories without marking seen, unfollow audits, giveaway picker, publish/schedule), X (10 tools), Pinterest (10), Reddit (3), Twitch (2), Tumblr, LinkedIn/Reddit/Spotify/X/Instagram data-zip readers, Goodreads/Letterboxd/Trakt list export, Medium/Substack, arXiv [src-tauri/omniget-core/src/core/tools/**; README "Tools section"]
- System tools: cache cleaner, disk treemap, hosts ad-block, startup manager, uninstaller, Windows privacy/harden/debloat/registry/updater (winget/choco/scoop); Files: duplicate finder, bulk rename, secure delete, file search (Everything/Spotlight/fd), keep awake; CTF utilities [tools/sysclean.rs, disk.rs, hosts_block.rs, startup.rs, uninstall.rs, win_*.rs, dupes.rs, rename.rs, shred.rs, file_search.rs; tools/ctf/]

---

## 10. Settings (complete map)

- Appearance: theme (14 + system), language (12) [AppearanceSettings]
- Accessibility: reduce_motion, reduce_transparency, disable_haptics [AccessibilitySettings]
- Typography: font_display/body/mono, line_height_base, spacing_scale, preset_name [TypographySettings]
- Downloads/Output: default_output_dir, always_ask_path, filename_template, organize_by_platform, skip_existing, download_attachments, download_descriptions [DownloadSettings]
- Downloads/Quality: video_quality (default 720p), quick presets Fast/Quality/Compact/Music-only, extra_ytdlp_flags, music_audio_format [DownloadSettings; settings.download.preset_*]
- Downloads/Subtitles & extras: download_subtitles, include_auto_subtitles, caption_locale ("match app language"), keep_vtt, embed_metadata, embed_thumbnail, write_nfo_sidecar, translate_metadata, youtube_sponsorblock + sponsorblock_mode + categories, split_by_chapters, live_from_start [DownloadSettings]
- Downloads/Clipboard & hotkeys: clipboard_detection, auto_download_on_paste, hotkey_enabled/binding, music_hotkey_enabled/binding, clip_hotkey_enabled/binding, copy_to_clipboard_on_hotkey [DownloadSettings]
- Downloads/Per-platform: courses continuous_lecture_numbers; Bilibili danmaku/format/container/nfo/cover/naming/cdn/preferred qn-codec-audio; Telegram concurrent_downloads, fix_file_extensions [DownloadSettings; TelegramSettings]
- Network: proxy (enabled/type/host/port/user/pass), bridge (enabled/port/token), speed_limit, user_agent, insecure_tls, cookies_from_browser, twitter_manual_cookie [ProxySettings; BridgeSettings; AdvancedSettings]
- Advanced/Performance: max_concurrent_downloads, concurrent_fragments, max_concurrent_segments, max_retries, stagger_delay_ms, prevent_sleep [AdvancedSettings]
- Advanced/Torrent: torrent_listen_port (6881), torrent_auto_trackers, torrent_upnp [AdvancedSettings]
- Advanced: start_with_system, start_minimized, portable_mode, legal_acknowledged, onboarding_completed, last_download_options (remembers mode/quality), reset defaults, debug section, League enable, OmniDisc enable + voice settings (PTT key, noise suppression, devices, VAD threshold, ducking, relay-only) [AppSettings; LeagueSettings; OmnidiscSettings]
- Integrations: Discord RPC (enabled/app_id/large_image_key), AI provider, Channels, Cookies, Rules, Storage (dedupe, silence map, portable info), Dependencies (yt-dlp/FFmpeg/PDFium/… managed vs system, variants, custom path, previous versions rollback, open folder), Browser extension export + pairing [RpcSettings; settings.* strings; src/components/settings/*.svelte]
- Env-var knobs: `OMNIGET_YTDLP`, `OMNIGET_YTDLP_CHANNEL` (stable/nightly), `OMNIGET_POT_PROVIDER_URL`, `OMNIGET_RELAY`, `OMNIGET_DATA_DIR` [ytdlp.rs; pot_provider.rs; p2p.rs; portable.rs]
- Settings schema with serde defaults and back-compat migration tests so old files never wipe preferences [settings.rs `backcompat_tests`]

---

## 11. Anything else

- yt-dlp "edit & retry" with user argv normalisation (keeps URL, injects `--newline/--progress/template/--print after_move`) [ytdlp.rs 415-418]
- Progress throttle 250 ms; ETA tracking per download; `--progress-delta 0.5` [queue.rs `ProgressThrottle`; ytdlp.rs `record_eta`]
- Info-fetch timeouts tuned per platform (YouTube 190 s total, Douyin 30 s, default 110 s) [queue.rs 1330-1339; ytdlp.rs 1469-1471]
- Windows `--windows-filenames`, Errno 22 fallback, UTF-8 console encoding handling (`--encoding`) [ytdlp.rs]
- Dependency variants/custom binary paths and three-version rollback for managed binaries [binary_versions.rs; dependencies commands]
- `check_media_changed`/`record_media_snapshot` "archivist" diff of re-downloaded media [media_history.rs]
- Host queue allows plugins to show their own downloads in the main Downloads page [host_queue.rs]
- Flatpak packaging with cargo/node sources and patches [flatpak/]
- UI lint policy + a11y/contrast audits in CI [scripts/lint-ui.mjs; scripts/a11y-audit.mjs; scripts/contrast-audit.mjs; ui-policy.app.json]
- Extensive unit tests for engine decisions (sidecar resume, work stealing, 403 ladder, media signatures, rules, WAL replay, torrent piece order, error classification) [http_fetcher.rs tests; queue_wal.rs; torrent_stream.rs; browser-extension/chrome/tests/*.test.mjs]

---

## 12. Candidates for Kurokawa Tools

### (a) Features that would improve the existing downloader / player / torrent / video core

1. **Resume sidecar with per-segment state + work-stealing** between segments (3 s stall threshold, 512 KiB min chunk) — more robust than a plain `.part` byte offset, survives kill -9 [http_fetcher.rs].
2. **Adaptive per-host connection tuner** (AIMD: +10 % gain to grow, halve on 429) with a **global connection budget** split across active downloads, shared between the native fetcher and yt-dlp `-N` [adaptive_concurrency.rs; ytdlp.rs 329-408].
3. **Per-host request limiter** (concurrent leases + minimum interval for YouTube/Instagram/TikTok/X/Reddit) to avoid rate limits before they happen [host_limiter.rs].
4. **Media signature sniff of the first 512 bytes** to reject HTML/`<Error>` pages saved as media, plus Content-Length mismatch check — fits the existing HEAD-probe/Save-as sniffing [media_signature.rs; direct_downloader.rs].
5. **HTTP 403 retry ladder** (`Range: bytes=0-`, then `sec-fetch-*` hints) and **fallback Referer = page origin**, **force-IPv4** on 403 [direct_downloader.rs 165-216; ytdlp.rs 3973-4077].
6. **Direct-file HEAD probe for unknown extensions** (non-page content-type + ≥1 MiB or `Content-Disposition: attachment` => native fetcher, cached 10 min) so unknown URLs don't wait on yt-dlp's generic extractor [direct_file.rs; url_resolver.rs].
7. **Native HLS downloader** with AES-128 decryption, variant selection by target height, PNG/JPEG-disguised segment unwrapping, TS->MP4 remux; SAMPLE-AES detected and refused cleanly [hls_downloader.rs].
8. **Queue write-ahead log** (append-only transitions, replay, compaction) + recovery dialog listing unfinished downloads with their options [queue_wal.rs; recovery.rs].
9. **Error classification -> retryable vs terminal** with exponential backoff and retry-counter reset after real progress; **root-cause diagnosis with a remedy button** (import cookies, impersonate, update yt-dlp, free disk…) [errors.rs; root_cause.rs; queue.rs 1925-1990].
10. **yt-dlp resilience cascade** for the video add-on: player_client rotation on 429/nsig/SABR, drop cookies when download degrades to 360p, `--impersonate` on TLS-fingerprint blocks, PO-token provider hook, subtitle-only 429 isolation, format simplification on postprocessing errors, `--retry-sleep exp=1:30`, `--throttled-rate`, sleep intervals after first 429 [ytdlp.rs 3400-4130; impersonation.rs; pot_provider.rs].
11. **Record the exact yt-dlp command per attempt and "Edit & retry"** with automatic instrumentation of the user's argv; saved argument templates [ytdlp.rs `CommandRecord`; yt_templates.rs].
12. **Live progress template** that reports current stream's resolution/codec/container/size and fragment i/n, with phase steps (Info/Video/Audio/Merge/Finish) and a stall state after 6 s [ytdlp.rs 409-413; queue.rs 1513-1560].
13. **Scheduled start + stop time per item** (presets: in 1 h / tonight / tomorrow) — extends the existing start/stop scheduler to per-download granularity [downloads.rs `scheduled_at/stop_at`; queue.rs `start_scheduler`].
14. **Rules engine** (host is / URL contains / platform is -> folder, quality, audio-only, subtitles, tags; first match wins; "test a link") on top of existing categories/folders [rules.rs].
15. **Batch pre-flight** (unsupported / needs-auth / not-found / already-have, size vs free disk) before a batch starts [preflight.rs].
16. **Torrent: tracker auto-injection, UPnP toggle, DHT persistence fallback chain, selective files before start, Seeding state in queue, playback-readiness check for stream-while-downloading** (libtorrent can do piece deadlines) [magnet/mod.rs; trackers.rs; torrent_stream.rs; torrent_playback.rs].
17. **Time-range download** (`--download-sections`) and **split by chapters** in the video add-on [downloads.rs 882-887; settings split_by_chapters].
18. **SponsorBlock "mark only" mode with category selection** (not just remove) and **chapter markers** [ytdlp.rs 3489-3503; settings.sb_*].
19. **Bilingual subtitle merge** (two languages -> one SRT/VTT/ASS) and availability-probe before requesting subtitle languages [subtitle_merge.rs; ytdlp.rs `select_available_subtitle_lang`].
20. **Metadata/NFO sidecars** for Jellyfin/Kodi/Emby and cover sidecar; embed thumbnail+metadata post-step [nfo_sidecar.rs; queue.rs 1828-1862].
21. **Media-changed detection** (snapshot of duration/chapters/title per URL; warn on re-download) [media_diff.rs].
22. **Cookie manager with multiple accounts per domain, freshness/expiry indicators, test button, trash bin, per-download account picker**, and giving yt-dlp a disposable cookie copy [cookies/storage.rs; ytdlp.rs 2242-2262].
23. **Player: silence map for skip-during-playback (Smart Speed)**, SponsorBlock overlay, seek heatmap, thumbnail scrubber, chapters list — mpv can consume the computed span list [silence_map.rs; telegram-components/player/*].
24. **Prevent-sleep while downloading, tray tooltip with aggregate speed, native completion notification, "copy file to clipboard after hotkey download"** [awake.rs; tray.rs; download-listener.ts; queue.rs 1864-1881].
25. **Clipboard hotkeys with distinct modes** (video / audio-only / clip) and explicit result toasts (not a URL / unsupported / already queued) [hotkey.rs; toast.hotkey_*].
26. **Managed-binary integrity**: SHA-256 verification, minimum-version gate, previous-version rollback (keep 3), custom binary path, zipapp-on-system-Python fast start for yt-dlp [dependencies.rs; binary_versions.rs; ytdlp.rs 1690-1790].
27. **Corrupt state-file quarantine** instead of silent reset; settings back-compat tests [state_file.rs; settings.rs tests].
28. **Content-addressed dedupe** of downloaded files via hard links with a storage stats panel [cas.rs; dedupe.rs].
29. **Flight recorder** (last N redacted events) for bug reports [flight_recorder.rs].
30. **Local Range-capable media streaming endpoint with expiring tokens** for the in-app player (if Kurokawa's webview ever needs to play local files) [local_bridge.rs 75-306].
31. **Browser extension / in-app browser link grabbing upgrades**: network sniffer with content-type+extension+size rules, video/audio track pairing within 200 ms, HLS size estimation by sampling, deep-search hooks on fetch/XHR/JSON.parse for blob playlists, blocked analytics hosts, header allow-list, first-bytes signature check, user-editable capture rules [browser-extension/chrome/src/*].
32. **Force H.264 toggle for YouTube pages** in the in-app browser (patch `canPlayType`/`isTypeSupported`) [h264ify.js].
33. **`omniget://`-style URL scheme fallback** that also wraps magnet/p2p payloads, and a localhost bridge with per-install bearer token + time-limited auto-pairing [external_url.rs; local_bridge.rs `/v1/pair`].
34. **Quick presets** for download settings (Fast / Quality / Compact / Music only) and "remember last mode/quality" [settings.download.preset_*; LastDownloadOptions].

### (b) Features that make sense as separate add-ons

1. **Followed channels / playlists poller** with per-channel interval, auto-download, tray submenu, incremental listing via `--download-archive` + `--break-on-existing` [channels.rs; channel_poller.rs; ytdlp.rs 2916-2960].
2. **Courses add-on** (38 learning platforms with webview login, outline selection, attachments, DRM-skip reporting, continuous numbering) [plugins/courses].
3. **Telegram media add-on** (QR/phone login, channel browser, filters, archive download, parallel MTProto chunks, OmniGram folders) [plugins/telegram].
4. **Bilibili add-on** (11 URL kinds, premium qualities, danmaku XML/ASS/JSON + burn-in, NFO, naming templates, CDN mirrors, QR/SMS login) [src-tauri/src/platforms/bilibili/**].
5. **Social archiver (Open Nami style)**: bulk profile/stories/highlights for Instagram, TikTok, X, Facebook with native-then-gallery-dl fallback and saved profiles [src/lib/open_nami/**].
6. **gallery-dl add-on** for 250+ image sites, managed binary [gallerydl/mod.rs; dependencies.rs `ensure_gallerydl`].
7. **aria2 accelerator / HLS-DASH manifest tool** (paste m3u8/mpd with referer+cookie -> ffmpeg) [tools/aria2.rs; tools/manifest_dl.rs].
8. **P2P file transfer** between two installs via relay with word codes and pause/resume [p2p.rs; p2p_words.rs] (Wi-Fi share already exists; this is the over-internet variant).
9. **Subtitle Workshop** (waveform editor, two-point sync, find/replace, QC auto-fix, AI grammar/translate, SRT/VTT/ASS convert, burn-in, resync) — extends the subtitles add-on [SubtitleWorkshop.svelte; subtitle_ws.rs; tools/subtitle.rs].
10. **Transcription / speech add-on**: whisper.cpp offline, Edge TTS with synced subs, SRT translate (AI or LibreTranslate), dub from SRT, dictation hotkey [tools/whisper.rs; edge_tts.rs; srt_translate.rs; dub.rs; dictation.rs].
11. **Convert / re-encode add-on**: container/codec/resolution/bitrate with GPU hw-accel, HEVC/H.264/AV1 re-encode with replace-if-smaller, compress-to-size, GIF/WebP, stabilise, restore, silence cut, sticker [plugins/convert; reencode.rs; tools/video_*.rs].
12. **AI video ops**: natural language -> validated ffmpeg command with review; video summariser from subtitles; AI provider settings (OpenAI/Anthropic/local) [video_ops.rs; ffmpeg_ops.rs; ai.rs].
13. **YouTube extras add-on**: metadata/thumbnails/subtitles/comments/chapters/live-chat export, SponsorBlock viewer/submit, Return YouTube Dislike, "real thumbnail" frames [downloads.rs tool commands; tools/sponsorblock.rs; tools/ryd.rs; FramesTool.svelte].
14. **Audio tools**: EBU R128 normalisation, denoise, tagging, synced lyrics (LRCLIB), playlist->M3U matching [tools/audio_*.rs; tools/music/*].
15. **Image tools** (upscale, resize, compress-to-KB, EXIF strip, duplicates, stitch, icon pack, spritesheet, OCR, background removal) [tools/image_*.rs; upscale.rs; ocr.rs].
16. **PDF/document tools** (13 PDF ops, SlideShare/Google Docs/Calameo export, PDF->Markdown) [tools/pdf*.rs; slides.rs; gdocs.rs; calameo.rs].
17. **Social data tools**: Instagram/X/Pinterest/Reddit/Twitch/Tumblr/LinkedIn tool packs and data-export readers [tools/instagram, x, pinterest, reddit, twitch, tumblr, linkedin].
18. **Study add-on** (library/player with timestamped notes, multi-format reader, notes/knowledge graph, Anki SRS, focus timers, music library) [README "Study"; external omniget-plugin-study].
19. **System/Files utilities** (cache cleaner, disk treemap, hosts ad-block, startup, uninstaller, dupes, bulk rename, secure delete, keep awake, Windows tweaks) [tools/sysclean.rs etc.].
20. **MCP server / local HTTP API add-on** exposing queue control and tools to AI agents with bearer token and config snippets [mcp.rs; local_bridge.rs].
21. **CLI companion** (`info`, `download`, `batch`, `import-cookies`, `--json`) [omniget-cli].
22. **Discord Rich Presence**, **KDE Connect send-to-phone**, **Spicetify**, **package tracking**, **League companion**, **OmniDisc chat** — niche integrations best left as optional add-ons [rpc.rs; tools/kdeconnect.rs; spicetify.rs; tracker-bridge.ts; commands/league; omnidisc-*].
23. **Browser-extension pair (Chrome MV3 + Firefox)** with media sniffer and cookie capture, if Kurokawa wants to catch links from the user's real browser in addition to the in-app browser [browser-extension/].
24. **Content-addressed dedupe + silence-map "Storage" panel** as a standalone maintenance add-on [cas.rs; dedupe.rs; silence_map.rs].
25. **CTF/analysis utilities** (hash/HMAC, file identification, ciphers, XOR, encodings, frequency) [tools/ctf/].
