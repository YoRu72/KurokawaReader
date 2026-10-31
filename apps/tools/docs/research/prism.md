# Prism Download Manager — feature inventory (from source)

Source inspected: `FortoGraphy/prism-download-manager` (Rust workspace: `prism-engine`, `prism-core`, `prism-video`, `prism-torrent`, `prism-native-host`; Tauri 2 + React 19 UI; MV3 browser extension). Versions up to 1.2.3 (Oct 2026).

Stack facts that matter for us: engine is a UI-less library (`prism-engine`), core is UI-less too (`prism-core`: SQLite WAL, axum loopback IPC, yt-dlp/ffmpeg manager, librqbit torrents). Everything below is implementable on top of our own HTTP stack (OkHttp on Android, Node/undici or aria2c on desktop); where Prism's behaviour depends on owning the sockets, we note it.

---

## 1. Multi-connection HTTP engine (`prism-engine`)

### 1.1 Probe without an extra round trip
- First request is **`GET` with `Range: bytes=0-<min_request-1>`** (not HEAD). Outcomes:
  - `206` + `Content-Range: bytes 0-x/total` → size known, ranges supported, and **the same response body is worker #0's first segment**.
  - `200` → no range support → single connection; `resumable:false` unless size + validators allow a restart check later.
  - `Content-Length: 0`/empty → `ProbeMode::Empty`.
- Captured from the probe into `ProbeInfo`: `size`, `file_name`, `resumable`, `etag`, `last_modified`, `final_url` (after ≤10 redirects), `mime`.
- Two sanity checks on the probe response:
  - **Browser/robot check**: header `cf-mitigated: challenge` → fatal `BrowserCheck` (download is left to the browser).
  - **Web page instead of file**: if the request was flagged `expect_file` (name like `setup.exe`, `disc.iso`, any non-text extension) and the response is `text/html`/`application/xhtml` **and** size < 2 MiB → fatal `WebPage` error instead of saving HTML under the binary name.
- POST downloads (form posts) are always single-connection.

### 1.2 Dynamic segmentation ("work stealing until the last byte")
Data structure: `SegmentTable` = one mutex-protected `Vec<Seg>`; each `Seg { start, pos, end, req_end, written, owner, racer, retrying, failed, meter, peak_rate }`. Invariant: segments always partition `[0,total)`; `[start,pos)` received; `[start,written)` durable on disk.

Idle-worker `acquire()` policy, in order:
1. **Unowned unfinished segment** with the largest remainder → take it.
2. **Split**: among owned segments without a racer and with `remaining >= 2*min_split`, take the one with the largest remainder. Split point = `align_down(pos + (end-pos)/2)` to **4 KiB**; but if the victim's current bounded HTTP request ends beyond the midpoint (`req_end`), split at `align_up(req_end)` instead when `end - hint >= min_split`, so the victim's socket survives and gets reused. Victim's `end` shrinks; it notices on its next chunk (`advance()` returns `stop`) and drops/retires that request.
3. **Race a slow tail** (only when no limiter is active): candidate = owned, unraced, unfinished segment whose own ETA (`remaining / own EWMA rate`) is `> 3 s` **and** `> 4×` the ETA at the *typical* rate (median of per-segment `peak_rate`s). Pick the one with the worst ETA. The racer downloads the same bytes from the current frontier; both write identical bytes to the same offsets; `pos = max(both)`; whoever reaches `end` first finishes the segment, the other stops at its next chunk. Bytes are not double-counted.
- `min_split_size` default **1 MiB** (clamped ≥ 16 KiB); `SPLIT_ALIGN = 4096`.
- Unknown-size streams (`UNKNOWN_END = u64::MAX`) are never split; `complete_unknown()` fixes the size at EOF.

### 1.3 Bounded, adaptively sized range requests
- Workers do **not** request `bytes=a-` to the end; they request **bounded** ranges sized to ≈ **2 s of transfer at the connection's measured speed** (`tune_request_size`), clamped to `[min_request_size=4 MiB, max_request_size=16 MiB]`. Per-download override `max_request_size` (YouTube formats: 10 MiB — larger ranges get throttled/403).
- Why: a bounded request fully drained lets the keep-alive socket be reused; a split rarely has to abort a socket; the "between requests" moment is used to **retire** a worker when the target connection count dropped.
- Each worker owns its **own HTTP client** (HTTP/1.1 by default ⇒ one TCP connection per segment ⇒ separate congestion windows). HTTP/2 optional per download; HTTP/3 compile-time feature.

### 1.4 Connection ramp-up, server limits, retries
- Supervisor tick every **250 ms**.
- **Ramp-up**: `initial_connections` (default 4) start immediately; once they all deliver data, the rest up to the target (default 8, cap 32, hard clamp 64) open at once.
- **Server connection limit detection** — a worker exits `Refused { retry_after }` when a *non-first* connection gets `429`, `503`, `403` after a successful probe, or connect refused/reset **twice in a row before any byte**. Then: `learned = currently connected count`; recorded into a shared **per-host `HostLimits` table** (`host[:port]` → connections, TTL 24 h, exportable JSON so later downloads start below the limit); event `ServerLimitDetected{connections}`.
- **Probe up**: periodically try `learned+1`: first after 20 s, doubling, max 300 s; if the server sent `Retry-After`, probe backoff ≥ 300 s (rate-limited servers count every request).
- **Retries**: transient (timeout, reset, 5xx, 429, short read) → exponential backoff with jitter `0.5 s · 2^n`, cap 30 s. After progress the first retry is immediate. A worker gives up after `max_retries` (default 10) *consecutive failures without progress*; the download fails only when **no worker can make progress** (`GIVE_UP_HOLD` 10 s before spawning replacements). Fatal: 404, 410, 401 without credentials, disk full, validator mismatch, `WebPage`, `BrowserCheck`.
- **Stall detection**: `read_timeout` 30 s without bytes → drop & reopen the connection. `connect_timeout` 15 s.
- Global `max_connections_per_host` (optional), enforced with per-host permits across all downloads.

### 1.5 Resume & validation
`ResumeState` (JSON, version 1):
```json
{ "version":1, "kind":"http|ftp|media", "url":"…", "final_url":"…|null",
  "part_path":"…/name.ext.prismpart", "final_path":"…/name.ext",
  "total_size":123, "etag":"\"abc\"", "last_modified":"…", "resumable":true,
  "segments":[{"start":0,"pos":10,"end":50},{"start":50,"pos":100,"end":100}],
  "media": null | {"kind":"hls|dash","tracks":[…],"segment_counts":[…],"completed":[…],"work_dir":"…"} }
```
- `validate()`: segments sorted, contiguous, `start<=pos<=end`, cover exactly `[0,total)`.
- `verify_against_disk()`: part file exists and `len == total_size` (file is pre-allocated / sparse). Mismatch → delete part, emit `Restarted{reason}`, start over (keeping the chosen final path).
- First request on resume: range request with **`If-Range`** = ETag if **strong** (not `W/`), else `Last-Modified`. A `200` answer, or changed size/ETag ⇒ `ValidatorMismatch` → the manager asks the user to restart.
- **No validators at all** ⇒ `verify_overlap`: re-download up to **64 KiB immediately before the resume point** of the segment with the most data on disk and byte-compare with the local file; mismatch ⇒ `ValidatorMismatch`.
- Checkpointing (manager, every 2 s): `snapshot → fsync data → persist snapshot`, so the persisted state never claims bytes not on disk.
- Non-resumable (no ranges): a failure restarts from 0 (`reset_single`).

### 1.6 Disk I/O
- Writes go **directly into `<final>.prismpart` at the final offset** (positioned writes: `seek_write`/`write_all_at`) from a blocking pool; **no per-segment temp files, no merge step**. 1 MiB coalescing buffer per stream; global **memory budget 64 MiB** of received-not-written data → when exhausted, sockets stop reading (TCP backpressure).
- Pre-allocation: Windows marks the file **sparse** before `set_len` (avoids NTFS zero-fill stalls); Linux `fallocate`. Free-space check before allocation and before resume (for the remaining bytes).
- Completion: flush + fsync, verify size, atomic rename to final name. Optional MD5/SHA-1/SHA-256 streaming verification (`ExpectedChecksum{algo, hex}`).

### 1.7 Speed limiting
- Hierarchical token buckets: each worker acquires from `[download, queue, global]` limiters, ≤ 16 KiB per acquire. Live-adjustable; `0` = unlimited. Speed meter = EWMA.

### 1.8 Request context (`DownloadRequest`)
Fields: `url`, `mirrors[]` (validated same-size, round-robin, failing mirror benched), `method` GET|POST(+`body`), `headers{}`, `cookies`, `referer`, `user_agent`, `credentials{username,password,scheme: Auto|Basic|Digest|Ntlm}`, `proxy: None|System|Http{url,user,pass}|Socks5{…}`, `destination{dir, file_name?, conflict: Rename|Overwrite|Fail}`, `connections` (0=default), `http: Http1|Auto|Http3`, `checksum?`, `speed_limit`, `max_retries?`, `max_request_size?`, `expect_file`, `byte_range{from,to}?` (download only part of a resource, saved as a whole file).
- `change_url()` ("Refresh download address"): validates the new URL's size/validators via a `[0,1)` range fetch then swaps the source for running/paused downloads.
- Redirect target expired? workers fall back from `final_url` to the original `url`.

### 1.9 File name derivation (`filename.rs`)
`Content-Disposition` (`filename*` RFC 5987/6266 `UTF-8''…` wins over `filename`) → last non-empty URL path segment (percent-decoded) → `download`; add an extension from MIME if none. Sanitize: strip dir components, replace reserved/control chars with `_`, trim spaces/trailing dots, escape `CON`, `COM1`…, cap length (~200 bytes keeping extension). Conflicts: `name (1).ext` … up to 10 000; checks both the final and the `.part` path.

### 1.10 Other protocols
- **FTP/FTPS** (`suppaftp`): multi-connection with `REST` + `RETR`.
- **HLS** (`m3u8-rs`): master → variant selection (`Best | MaxHeight(px) | Index(i)`), audio rendition of the variant's group (default → autoselect → first with URI), AES-128-CBC decryption (`IV=0x…` or IV from media sequence number per RFC 8216 §5.2), `EXT-X-MAP` init segments, `EXT-X-BYTERANGE`; parallel segment fetch; ffmpeg remux to `.mp4` (optional; raw concatenation kept if ffmpeg missing). `VariantProbeRequest` lists variants cheaply for a quality picker before committing.
- **DASH** (`dash-mpd`): representations, parallel segments, ffmpeg mux.
- Media resume state = per-track segment counts + completed global indices + work dir (validated on resume).

---

## 2. Application core (`prism-core`)

### 2.1 Data model (SQLite)
- `downloads { id, kind: http|ftp|hls|dash|video|torrent, url, final_url, file_name, save_dir, size, downloaded, status, error, category, queue_id, description, referer, added_at, last_try_at, finished_at, resumable, connections, speed_limit, checksum "algo:hex", trashed, position, mirrors[], grabber_project, request(json), resume(json, never sent to UI), media{title,thumbnail,duration,quality,site,page_url,playlist_index,section} }`
- Status: `Pending` ("Download later") | `Queued` | `Connecting` | `Downloading` | `Paused` | `Processing` (mux/checksum/AV) | `Completed` | `Failed`.
- `categories { id, name, icon, extensions[], save_dir?, builtin, position }`
- `queues { id, name, max_concurrent, speed_limit, position, builtin, schedule{…}, running }`
- `settings` key/value typed JSON; import/export JSON; partial-patch merge from the UI.
- Live `Progress { id, status, downloaded, size, speed, eta_secs, connections, detail("Muxing", "Retrying in 4 s"), fraction? }` batched at 4 Hz; `SegmentInfo { start, pos, end, speed, state }` for the details window.

### 2.2 Categories
Built-ins (sidebar order) with extension lists:
- video: 3gp asf avi flv m2ts m4v mkv mov mp4 mpe mpeg mpg ogv qt rm rmvb ts vob webm wmv
- music: aac aif aiff alac ape flac m4a mid mp3 mpa oga ogg opus ra wav wma
- documents: csv doc docx epub md odp ods odt pdf pps ppt pptx rtf txt xls xlsx xps
- programs: apk appimage bin deb dmg exe flatpak jar msi msix msu pkg rpm run snap
- compressed: 7z ace arj bz2 cab gz gzip img iso lz lzh lzma r00 r01 rar sit sitx tar tbz tgz txz xz z zip zst
- images: avif bmp gif heic ico jpeg jpg png psd raw svg tif tiff webp
- other: (fallback)
Rules: **custom categories win over built-ins** (a "Linux ISOs" category can claim `iso`); save dir = category's `save_dir`, else `<default>/<CategoryName>` when `use_category_folders`, else default dir (Other never gets a sub-folder). Capture dialog can "remember this folder for the category".

### 2.3 Queues & scheduler
- Multiple queues; each has `max_concurrent`, `speed_limit` (a limiter shared by its downloads), ordered items (`position`; move up/down/to-edge), `running` flag. Built-ins created on demand: **"One at a time"** (playlists; max_concurrent 1) and **"Hugging Face"** (2 at a time).
- `Schedule { enabled, start_time "HH:MM", stop_time "HH:MM", days [1..7 ISO, empty=every day], once_date "YYYY-MM-DD", retry_failed, on_complete: PostAction, wake }`.
- `PostAction`: None | Exit | Sleep | Hibernate | Shutdown | Lock | RunCommand | PlaySound. Power actions show a **30 s cancellable grace banner**.
- Scheduler is **crossing-based**: a 1 s tick remembers the previous tick time and fires events whose moment lies in `(prev, now]`; a missed start (sleep/resume) is fired once on wake if < **30 min** old (`CATCH_UP`); never fires twice. `next_start()` searches two weeks ahead (for the UI and for OS wake timers when `wake`).
- Admission (`admit()`): every tick, each running queue starts `Queued` items up to its free slots; counting+starting is one atomic step. Queue finish detection: no items Queued/active/in-jobs → `running=false`, `QueueFinished` event, sound, post action; a `once_date` schedule disables itself. A queue started with nothing to download does **not** run its finishing action.
- Add modes: `Start now | Download later (Pending) | Add to queue {queueId}`.

### 2.4 Clipboard monitor
- Polls the OS clipboard change counter (reads contents only after the system says it changed; never reads content flagged concealed by password managers — nspasteboard.org / Windows `ExcludeClipboardContentFromMonitorProcessing` formats). Ignores what's on the clipboard at startup.
- Extracts URLs whose path ends with a capture extension, or **magnet links**; max 200 URLs (bigger lists → batch dialog). Setting `ask: true` → capture dialog; `false` → added silently as "Download later" (JDownloader-style link list). Video pages always get the quality picker.

### 2.5 Browser capture / "Download File" dialog flow
- Probe runs in the background; the dialog opens immediately with the browser's suggested name/size and updates when the real name/size arrive; retry probe after entering credentials. Items: name, folder (category-aware), category, queue/start mode, description, connections, "remember folder". Also "What's inside a ZIP" (see 2.9).
- **Try-link-first**: before taking over a browser download Prism tries the link for ≤ ~3 s (within the extension's 5 s hand-off); if the server answers with a robot check it declines and the browser keeps the download (fail-open).
- Capture rules handed to the extension: extensions (upper-case, wildcards), MIME prefixes, min size, excluded sites, bypass key (`alt|shift|ctrl|meta|none`), video button, video sites list.

### 2.6 Batch downloads
- Pattern expansion (`expand_batch_pattern`): `[1-10]`, zero-padded `[001-100]`, step `[1-10:2]`, descending `[10-1]`, letters `[a-z]`/`[A-F]` (+step); multiple ranges = cartesian product (leftmost slowest); non-range brackets (IPv6 `[::1]`) kept literal; max **10 000** URLs.
- Text-file import of links; batch selection dialog with filters (by kind/extension/size), de-duplicated.

### 2.7 Site grabber (crawler)
`GrabberConfig { start_url, depth, scope: SameHost|SameDomain|BelowStartDir|Any, extensions[] (empty=any non-HTML), include_embedded (img/video/audio/source), files_any_host, max_pages, concurrency, exclude[] (URL substrings), fetch_sizes (HEAD), login: { username, password, form_url?, form_fields[(k,v)] with {username}/{password} placeholders }, user_agent, cookies }`. BFS to depth; results stream as events (`FoundFile { url, file_name, size?, mime?, referer, depth }`) so the UI renders a live file tree; projects persisted (`grabber_projects {id,name,config,results}`); respects robots optionally.

### 2.8 Video (yt-dlp + ffmpeg)
- Tool management: resolution order custom path → managed copy → PATH; managed yt-dlp from GitHub releases (stable/nightly) verified against `SHA2-256SUMS`; ffmpeg from BtbN builds (`checksums.sha256`) / martin-riedl static on macOS; deno for YouTube JS challenges (`--js-runtimes`). Version cache keyed by (mtime, len).
- `yt-dlp -J` → formats → **quality picker** (`choices.rs`): one entry per height/HDR flag (≤ 8K) + audio-only entries; audio ranking: original language, non-DRC, codec, accelerable, bitrate; labels like `1080p60 · MP4 · 145 MB`.
- **Accelerated path**: if every chosen format is a plain progressive HTTP file (not live, not DRM, no SponsorBlock-remove), the engine downloads each stream with `http_headers`+cookies, `max_request_size` 10 MiB for YouTube, then ffmpeg muxes/embeds (subs, thumbnail, metadata, chapters); on 403 fall back to yt-dlp. Else yt-dlp runs with Prism adding tool paths, proxy, cookies, headers.
- Subtitles: patterns `en` (matches en-US), `en.*`, `all`; manual tracks first, auto captions only if enabled and no manual matched.
- Playlists: pick entries; "One at a time" queue; `number_playlist_videos` → `01 - Title.ext`; file template `%(title)s [%(id)s].%(ext)s` style.
- "Only a part": `Section{from,to}` → the index of each stream is read and only pieces around the part are fetched, then ffmpeg cuts; name `Title [id] (1m23s–2m45s).mp4`; progress by `fraction`.
- Settings: `preferred_height`, `container`, `audio_format`, embeds, `sponsorblock: Off|Mark|Remove`, `accelerate`, `cookies_from_browser`, `file_template`, `auto_update`.
- Sniffed streams from the extension (`hls|dash|direct` + headers) are downloaded without yt-dlp (`MediaRequest`).

### 2.9 Tools
- **What's inside a ZIP** (`peek.rs`/`zipdir.rs`): reads the central directory from the **end of the remote ZIP with range requests**, lists entries `{index, path, size, encrypted, extractable}`, and can download a single stored/deflated entry on its own with the capture's cookies/referer/UA. Error codes: no ranges, split archive, too many files, needs sign-in, file changed, corrupt, encrypted.
- **Convert to / Make smaller** (fit a size limit) / **ZIP** finished files — one ffmpeg at a time (`prism_video::media`).
- **Hugging Face models** (`huggingface.rs`): input `owner/name`, `datasets/owner/name`, or any hf.co/hf-mirror link (`/tree/<rev>/<path>`, `/blob/` → `/resolve/`). API: `GET {server}/api/models/{id}/revision/{rev}?blobs=true` (siblings with `size`, `lfs.sha256`), search `GET {server}/api/models?search=…&sort=downloads&direction=-1&limit=12` (trending: `sort=trendingScore`). Suggests files: one GGUF quantization (default preference list `Q4_K_M, UD-Q4_K_XL, Q4_K_XL, Q4_K_S, IQ4_XS, IQ4_NL, Q4_0, MXFP4, …, Q8_0`), its `mmproj`, weights in one format (safetensors over .bin/onnx/tf/original), small files first; skips files already on disk with the right size or already in the list; download links pinned to the commit `{server}/{kind}/{id}/resolve/{commit}/{path}`; token added at start only for `/resolve/` on the HF server (never to redirect targets); SHA-256 verified after download; goes into the "Hugging Face" queue (2 concurrent). Detects LM Studio's models folder.
- **Antivirus hook** after completion: Defender `MpCmdRun`, `clamscan`, or custom `{file}` command; extension filter.
- **Torrents**: librqbit; magnet/.torrent (fetched with browser cookies; max size guarded; bencode validated), file-selection dialog with metadata resolve, category/queue/free-space, "Delete with files".

### 2.10 Settings surface (full list worth mirroring)
- General: launch at startup, start minimized, close to tray, show capture dialog, show progress window, completion dialog, notifications, confirm delete, use trash, check updates, remove deleted files, language, hide dock icon.
- Appearance: theme (system/dark/light), accent (6), density, motion, reduce transparency, window material, visible columns, compact view.
- Downloads: default dir, use category folders, default/max connections, conflict (rename/overwrite/ask), max retries, global speed limit + toggle, verify checksums, auto start.
- Connection: user agent, connect/read timeouts, HTTP version, max connections per host.
- Proxy: mode none/system/http/socks5, address, user, pass, bypass list.
- Capture: enabled, extensions, MIME types, excluded sites, min size KB, bypass key, video button, video min duration.
- Sounds: on complete/failed/queue done, volume, sound choice.
- Clipboard: monitor, ask. Grabber: default depth, max pages, concurrent requests, respect robots. Antivirus. Video (2.8). Hugging Face: endpoint, token, folder. Shortcuts map.

---

## 3. Browser extension protocol (v1)
Transport: extension ⇄ native host (`dev.prism.host`) ⇄ `POST http://127.0.0.1:<port>/v1/message` with `Authorization: Bearer <256-bit token>`; `ipc.json` (port+token) in app data dir; host launches `prism --background` if stale and waits 5 s. `GET /v1/health` → `{"ok":true,"version":"…"}`.
Envelope `{id, type, noLaunch?}`; replies `{ok:true,…}` or `{ok:false,error:{code,message}}`, < 1 MiB, **answered immediately** (dialogs open asynchronously; a captured browser download is paused until the reply).
Messages: `hello` (→ app version + capture settings), `download {url, finalUrl?, referrer, pageUrl, filename?, fileSize?, mime?, method, headers?, cookies, finalUrlCookies?, userAgent, incognito, source: capture|contextMenu}` → `{accepted, downloadId}` (accepted:false ⇒ browser keeps it, fail-open), `batch {pageUrl,title,kind: links|images|videos|selection, items:[{url,referrer,kind,filename?,text?,cookies}]}`, `probeVideo {pageUrl,cookies,userAgent}` → `{title,thumbnail,duration,formats:[{id,label,kind: video|muxed|audio,ext,height,fps,size,note}]}`, `video` (chosen `formatId` or `streams:[{url,kind: hls|dash|direct,mime,size,quality,headers}]`), `status`, `open {page}`.
Extension-side behaviour worth copying even without a browser extension (for an in-app WebView browser on Android): media sniffing via response headers (HLS/DASH manifests, progressive video/audio ≥ 64 KiB; drop `.ts/.m4s` once a manifest is known; ignore googlevideo chunks), floating video button on hovered `<video>` (skip < 200×120 and muted autoplay loops), bypass key for links, context menus "download all links/images/videos/selection".

---

## 4. UI worth copying
- **Main window**: sidebar (categories with counts, queues, Tools, Grabber, Trash), dense virtualized table with columns Name, Size, Status, Progress, Speed, Time left, Last try, Added, Folder, Category, Description (sortable, user-selectable), bottom details pane, status bar (global speed, limiter toggle), toasts, "What's new" sheet, compact view toggle.
- **Details window** per download: `FileMap` — one bar where each segment occupies its `[start,end)` share of the file, filled `(pos-start)/(end-start)` in a per-connection colour (8-colour spectrum, HLS/DASH use segment indices as the unit); `ConnectionLanes` — one lane per *active* connection with id, track, head marker, byte range, per-connection speed (+ "N more"); **speed area chart** with MB/s gridlines; log of events (probed, split, server limit detected, retrying in N s, restarted).
- **Mini window**: always-on-top glass strip listing active downloads; shrinks/grows to content keeping the bottom edge fixed; click opens main window. **Drop zone**: floating orb accepting links/.torrent files.
- **Download File dialog**: name/folder/category/queue/connections, live probe update, remember-folder, ZIP contents tree. **Complete dialog**: open / open folder / convert.
- **Video window**: quality list grouped Video/Audio-only with size, container choice, subtitles, "Only a part" range picker, playlist entry selection, "One at a time".
- **Post-action banner**: 30 s countdown with Cancel before sleep/shutdown.
- Design system: CSS tokens, 6 accents, light/dark, density, reduced motion/transparency; RTL (Arabic) mirrored.

---

## 5. What we should take (ranked for Kurokawa Tools)
1. **Segment table with midpoint splitting at 4 KiB alignment + bounded adaptive range requests (~2 s, 4–16 MiB)** — on desktop aria2c already segments, but on Android we need our own engine over OkHttp; this is the exact algorithm.
2. **Slow-tail racing** (ETA > 3 s and > 4× median) — removes the "last 2 %" stall.
3. **Resume state JSON + If-Range (strong ETag else Last-Modified) + 64 KiB overlap comparison when no validators + part-file length check** — makes resume safe across app kills.
4. **Learned per-host connection limits** (429/503/403-after-probe → clamp, remember 24 h, probe up with doubling backoff, respect Retry-After) — avoids bans on CDNs.
5. **Probe-by-GET with `Range: bytes=0-N`** instead of HEAD, with browser-check (`cf-mitigated`) and "small HTML for a binary name" detection.
6. **Queues with schedules (crossing-based tick, 30 min catch-up, ISO weekdays, once-date, post actions with 30 s grace) + per-queue limiter + "One at a time" queue**.
7. **Categories with extension lists, custom-wins rule, per-category folders** (lists above).
8. **Clipboard monitor** with change-counter polling, concealed-format exclusion, magnet support, ask/silent modes.
9. **Batch pattern expansion** grammar (`[001-100]`, `[a-z:2]`, cartesian, cap 10 000).
10. **HLS/DASH downloader details**: variant probe for a picker, audio rendition group, AES-128 IV rules, EXT-X-MAP, media resume by completed segment indices.
11. **yt-dlp integration model**: `-J` → choices (one per height) → accelerate progressive formats with our engine (10 MiB max range for YouTube) → ffmpeg mux; fall back on 403; managed binaries with checksum verification.
12. **Details window visuals** (FileMap + ConnectionLanes + speed area chart) and **mini window**.
13. **Remote ZIP peek** (central directory via range requests, single-entry extraction).
14. **Site grabber** config schema and streaming results.
15. **Hugging Face downloader** (API endpoints, GGUF preference list, commit-pinned URLs, token only on `/resolve/`).
16. Hierarchical token-bucket limiters `[download, queue, global]`; file-name derivation/sanitization rules; antivirus hook; browser-extension protocol if we ever ship a desktop extension.
