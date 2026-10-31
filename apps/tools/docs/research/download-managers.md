# Download managers and in-place extraction — reference inventory for Kurokawa Tools

Source trees read (shallow clones, 2026-10-31):

| Project | Commit | Where |
|---|---|---|
| Prism Download Manager (FortoGraphy/prism-download-manager, v1.2.3) | `96e56fb` | `scratchpad/ref/prism-download-manager/` |
| HatchZip (xevrion/hatchzip, v0.1.8) | `50fa69c` | `scratchpad/ref/hatchzip/` |

Both are Rust. Everything below is written so it can be re-implemented in TypeScript (Electron/Node) and Kotlin/Java (Capacitor/Android) without reading Rust. Where a behaviour depends on a syscall, the syscall is named for each OS. A sibling file, `prism.md`, holds an earlier pass over Prism; this document is the complete spec and supersedes it where they differ.

---

# Part 1 — Prism Download Manager

Prism is an IDM-style download manager: a UI-less engine crate (`prism-engine`: segmented HTTP/FTP, HLS/DASH, resume, limiters), a UI-less core crate (`prism-core`: SQLite WAL, queues, scheduler, categories, grabber, clipboard, browser IPC, antivirus, ZIP peek, Hugging Face), a video crate (`prism-video`: yt-dlp + ffmpeg + deno management, quality choices, planning, muxing), a torrent crate (librqbit), a native-messaging host, a Tauri 2 + React 19 shell, and an MV3 browser extension (Chromium + Firefox from one TypeScript source).

## 1.1 Features

### 1.1.1 Download engine (HTTP/HTTPS)

- Up to **32 parallel connections per file** (`max_connections_cap` 32; default 8; `initial_connections` 4 start at once, the rest open once those deliver data).
- **Dynamic segmentation (work stealing)**: when a connection finishes its range it takes half of the largest remaining range; every connection stays busy to the last byte; the slow tail is split down instead of waited on.
- **Slow-tail racing**: when nothing can be split, an idle connection downloads the same bytes as the slowest tail; whoever finishes first wins.
- **Probe without an extra round trip**: the first request is a `GET` with `Range: bytes=0-<4 MiB-1>`; a `206` proves range support, gives the size and its body becomes connection #0's first stream; a `200` means single-connection, non-resumable.
- **Server-aware connection limits**: notices `429`/`503`/`403`-after-probe/refused connects, settles on the number that works, remembers it **per host for 24 h** (shared by all downloads; exportable), and probes one more connection later with doubling backoff.
- **Retries**: exponential backoff with jitter `0.5 s · 2ⁿ` capped at 30 s; `max_retries` consecutive failures *without progress* (engine default 10, app default 20); the download fails only when no connection can progress; fatal errors (404/410/401 without credentials/disk full/validator mismatch/web page instead of file/browser check) stop at once with a typed error.
- **Stall detection**: `read_timeout` (30 s) without bytes drops and reopens the connection; `connect_timeout` 15 s.
- **Straight-to-disk**: bytes are written at their final offset into `<name>.prismpart` — no per-segment temp files, no merge/assembly step; sparse on NTFS, `fallocate` on Linux; free-space check before allocation.
- **Crash-safe resume**: checkpoints every 2 s with the rule "flush → fsync → snapshot segments", so the persisted state never claims bytes not on disk; on resume `If-Range` (strong ETag, else Last-Modified) validates the file; without validators a 64 KiB overlap just before the resume point is re-downloaded and compared.
- **Live speed limits** at three levels: per download, per queue, global (hierarchical token buckets, `0` = unlimited, live-adjustable, a tray toggle).
- **Bounded range requests** sized to ≈2 s of transfer (4–16 MiB; 10 MiB for YouTube) so keep-alive sockets are reused and splits rarely cut a socket.
- **HTTP/1.1 by default** (one TCP connection per segment = separate congestion windows), HTTP/2 optional ("Automatic"), HTTP/3 experimental (compile-time).
- **Redirects** (max 10), reuse of the final URL by all workers, fall back to the original URL on 403/404/410 of an expired signed target.
- **Mirrors**: validated in the background (same size), used round-robin, a failing mirror benched for 60 s.
- **Refresh download address** ("change URL"): replace an expired link of a running/paused download after checking size and strong ETag; progress kept.
- **Cookies, Referer, User-Agent and arbitrary headers** forwarded from the browser; **Basic, Digest and NTLM** auth (per-connection 3-leg NTLM handshake); **proxy** none/system/HTTP(S)/SOCKS5(h) with user/pass and bypass list, global or per download.
- **POST downloads** (form posts) single-connection.
- **Integrity**: optional MD5/SHA-1/SHA-256 verification after completion (streaming hash; user enters `md5:…`, `sha1:…`, `sha256:…` in Properties).
- **Web-page / robot-check protection**: a small HTML answer (< 2 MiB, `text/html`/`application/xhtml`) for a binary file name is an error, never saved as the file; Cloudflare `cf-mitigated: challenge` is detected and the download is left to the browser.
- **File naming**: `Content-Disposition` (`filename*` RFC 5987 wins) → URL path → `download`; extension from MIME when missing; cross-platform sanitising; conflict policy Ask / Rename (`name (1).ext`) / Overwrite; checks both the final and the `.prismpart` name.
- **Memory budget**: 64 MiB engine-wide of received-but-unwritten data; beyond that sockets stop being read (TCP backpressure).
- **Unknown size** (no Content-Length): single stream to EOF, size fixed at the end.
- **Byte-range downloads**: download only `[from,to)` of a resource as a whole file (used by "part of a video").

### 1.1.2 Other protocols

- **FTP / FTPS (explicit `AUTH TLS`)**: `SIZE`, `REST` probe, multi-connection `REST`+`RETR` per segment, passive mode with NAT workaround, credentials from URL → request → anonymous; resume checks size and `MDTM`.
- **HLS** (`.m3u8`): master/variant selection (`Best | MaxHeight(h) | Index(i)`), separate audio rendition, AES-128-CBC (IV from tag or media sequence), `EXT-X-MAP` init segments, byte ranges, N parallel segments written as `<final>.prismpart.d/seg-NNNNNN.bin` (write, fsync, rename → resume skips done segments), concatenate + `ffmpeg -c copy` into `.mp4`; without ffmpeg the raw `.ts` is kept and `Completed.warning` says so. No live playlists, no SAMPLE-AES, subtitles ignored.
- **DASH** (`.mpd`): `SegmentTemplate` (`$Number%0Nd$`/`$Time$`/`$Bandwidth$`), `SegmentTimeline`, `SegmentList`, single-file `SegmentBase`/`BaseURL`; static single-period unencrypted only; extra tracks saved as `<name>.audio.<ext>` when not muxed.
- **BitTorrent / magnet** (librqbit): session persisted with fast-resume, inspect metadata (DHT/trackers) before adding, file-selection dialog, multi-file torrents get their own folder (name sanitised for every OS), pause/resume/remove-with-files, down/up limit (upload limited to the same value), `.torrent` links captured from the browser are fetched **with the browser's cookies and referer** and validated as bencode (max 16 MiB), a link that gives a web page is downloaded as a plain file instead.
- **Hugging Face models**: by `owner/name`, link or search; picks one GGUF quantization (+ its `mmproj`), weights in one format (safetensors preferred), small files first, skips files already on disk; links pinned to a commit `…/resolve/<commit>/<path>`; token (settings, `HF_TOKEN`, or `hf auth login`'s) sent only to the HF server (never to redirect targets); SHA-256 from the API verified after download; downloads go to a built-in "Hugging Face" queue (2 at a time); hf-mirror.com / `HF_ENDPOINT` mirrors; detects LM Studio's models folder.

### 1.1.3 Video & audio (yt-dlp + ffmpeg)

- Any site yt-dlp supports (1,800+); **MP4 + quality (up to 8K/HDR) or MP3 only**; also M4A, Opus, FLAC, WAV; containers MP4/MKV/WebM.
- **Quality picker**: one entry per (height, HDR) pair, labels like `2160p60 · HDR · AV1` / `MP4 · ~743 MB`; audio-only group.
- **Accelerated path**: progressive HTTP formats are downloaded by the segmented engine (exact yt-dlp `http_headers` + cookies + Referer, ranges ≤ 10 MiB on YouTube), then ffmpeg muxes `-c copy`, embeds subtitles (mov_text/WebVTT), thumbnail (attached_pic / MKV attachment), metadata and chapters (FFMETADATA1), `+faststart`; **falls back to yt-dlp on 403**.
- **yt-dlp path** when formats are HLS/DASH/fragmented, live, DRM, SponsorBlock-remove or a part is asked.
- **Subtitles** (patterns `en.*`, `all`; manual before auto), **chapters**, **thumbnail**, **metadata**, **SponsorBlock** mark/remove (mark via privacy-preserving hash-prefix endpoint `/api/skipSegments/<sha256(id)[:4]>`, becomes chapters).
- **Playlists & channels**: flat probe (`--flat-playlist`), entry picker, "Download N videos", **"One at a time"** built-in queue, optional `01 - Title` numbering.
- **Only a part**: two handles / typed times / click a chapter; the stream's index is read and only the pieces around the part are fetched over several connections, cut on the exact frame; audio parts stream-copied; name suffix ` (1m23s–2m45s)`; progress by fraction; no subs/chapters/SponsorBlock for a part.
- **File name template** subset of yt-dlp's (`title`, `id`, `ext`, `uploader`, `channel`, `upload_date`, `extractor`, `duration`, `/` makes subfolders) with yt-dlp's `--windows-filenames` replacement characters.
- **Cookies from browser** (yt-dlp `--cookies-from-browser`) for age-restricted/member videos; the browser tab's own session is used when the request came from the extension (Netscape `cookies.txt` scoped to the page's site, deleted after).
- **Managed tools**: yt-dlp (stable/nightly, `SHA2-256SUMS` from the same tag), ffmpeg/ffprobe (BtbN builds / martin-riedl on macOS, checksums), deno (`--js-runtimes deno:<path>` for YouTube signatures); resolution order custom path → managed → PATH; auto-update; whole-process-tree kill on cancel (Job Object on Windows, process group on Unix); an old distro yt-dlp that lacks `--js-runtimes` triggers a managed download.
- **Sniffed streams** from the extension (HLS/DASH/direct + headers) download without yt-dlp.
- **Live/upcoming** detected and refused for the accelerated path; DRM formats marked unusable; all-DRM video → "no choices".

### 1.1.4 Browser integration (extension + native host)

- Chrome, Edge, Brave, Opera, Vivaldi, Helium (Chrome Web Store, stable ID) and Firefox/Zen (temporary add-on or Dev/Nightly/ESR).
- **Download capture**: a browser download is handed over when capture is on and not paused, the bypass key (default **Alt**, configurable alt/shift/ctrl/meta/none) was not held, the URL is http(s)/ftp (`blob:`/`data:` stay), the request was a GET (POST stays), the page/URL is not excluded, the extension **or** MIME matches, and the size (when known) ≥ minimum. Hand-off ≈ 250 ms. **Fail-open**: if the app is unreachable or declines, the browser keeps the download and the toolbar badge shows a red `!`.
- Forwarded: URL, final URL, Referer actually sent, page URL, file name, size, MIME, `Cookie` header (sent header merged with `cookies.getAll`, incl. incognito store; separate cookies for a cross-origin final URL), Origin, UA, incognito flag.
- **Try the link first** (≤ 2.5 s, inside the 5 s hand-off window): if the server answers with a robot check / web page / 403, the app declines and the browser downloads.
- **Media sniffing** per tab (non-blocking `webRequest.onHeadersReceived`): HLS/DASH manifests, progressive video/audio (≥ 64 KiB), size from `Content-Length`/`Content-Range`; segments (`.ts`, `.m4s`, `.cmfv`…) dropped once a manifest is known; googlevideo ignored; list stored in `storage.session`, cleared on navigation, count in the badge; quality guessed from URL (`1080p`, `4k`).
- **Floating "Download video" button** over a hovered `<video>` (Shadow DOM pill; skips players < 200×120 and small muted autoplay loops; follows scroll/resize/fullscreen; YouTube SPA navigation aware). On video sites the menu shows the app's yt-dlp formats (probe after ~0.4 s hover, cached 10 min, "Best quality" immediately); on feeds (X, Instagram, Facebook, Reddit, TikTok, LinkedIn) the hovered **post's** URL is resolved, not the page's; elsewhere "This video" (`currentSrc`/`<source>`/`data-sources`) then other sniffed streams. Setting: only for videos longer than N seconds.
- **Popup**: connection state + fix hint, pause-capture toggle, media on page with per-item Download, "All links / images / videos", Open Prism, Options.
- **Context menus**: Download with Prism (link/image/video/audio), Download selection links, all links, all images, all videos (collected in every frame).
- **Options**: capture on/off, video button, bypass key, extension list, MIME list, min size, excluded sites, video sites, *Sync from Prism*.
- **Settings → Browser integration** page in the app: per-browser status (installed / registered / points to this host / extension connected, last message time), one-click **Repair**, guided store install, "add by hand" fallback, older-extension reminder (only for `installType` ≠ normal/admin), Firefox temporary add-on instructions, Flatpak browsers reported unsupported.

### 1.1.5 Organisation

- **Categories** (built-in, editable not deletable; custom with icon, name, extensions, own folder): Video, Music, Documents, Programs, Compressed, Images, Other; per-category sub-folders under the download folder (toggle); the capture dialog can "remember this folder for the category"; **custom categories win over built-ins**.
- **Queues**: several, each with name, `max_concurrent` (1–32), speed limit, ordered items (drag, Alt+↑/↓, move to top/bottom), built-in main queue plus on-demand "One at a time" and "Hugging Face"; Start/Stop queue, Stop all, Run now.
- **Scheduler** per queue: enabled, start time, stop time, days of week (every day / weekdays / weekends / pick), once on a date, retry failed items on start, wake the computer (OS wake timer 30 s before), **when finished**: nothing / exit / sleep / hibernate / shut down / lock / play sound / run command — power actions show a **30 s cancellable banner**; "Next scheduled start" shown.
- **Download later** (idle), **Add to queue**, **Start now** modes.
- **Trash**: deleted items go to Trash (restorable) unless "use the trash" is off; "Delete with files" asks once; "Remove downloads whose files were deleted" (off by default).
- **Description** note per item; **Properties** (F2): address, file name, folder, category, description, connections, checksum.
- **Search** downloads; sidebar filters All / Unfinished / Finished / per category / per queue / Grabber / Trash with counts and "N active" badge.
- **Export**: all downloads with their state as JSON; settings import/export JSON; **Diagnostics** zip (logs, settings with passwords removed, integration status).

### 1.1.6 Adding downloads

- **Add URL** window (address, optional note, folder/category, start mode); pasting a Hugging Face model name or link opens the model window; `.m3u8`/`.mpd` → stream; `magnet:`/`.torrent` → Add torrent.
- **Batch download**: pattern `file[001-100].zip` (zero-padding, step `[1-10:2]`, descending, letters `[a-z]`, cartesian product, max 10,000), paste a list (every http(s)/ftp/magnet in any text), text-file import; selection dialog with filter by extension, select all/none, de-duplication.
- **Clipboard monitor**: copied links whose path ends with a capture extension, or magnets, trigger the Download File dialog ("Ask before adding copied links") or go straight into the list as Download later; never reads concealed clipboard content (password managers); reads only after the OS change counter moved; ignores clipboard content at startup; max 200 URLs.
- **Drop zone** window (floating orb, drop links/.torrent files, double-click opens the app); drag-and-drop onto the main window.
- **Site grabber**: project (name), start URL, depth (default 2), scope same host / same site / below start path / any, file types to collect (empty = any non-HTML), include embedded media (img/video/audio/source/srcset), accept files on other hosts (CDNs), max pages (2000), parallel requests (6, clamp 1–16), skip addresses containing…, look up file sizes (HEAD), respect robots.txt, login (HTTP auth or a form POST with `{username}`/`{password}` placeholders), cookies header, UA; live results tree, filter, select, "Review N files", "Keep the site's folder structure", projects saved and reopened.

### 1.1.7 Post-download

- **Completion dialog** (Open, Show in folder, Convert, Make smaller), **completion sound** (10 choices + classic, volume; separate sounds for failed and queue done), **system notifications** when in background.
- **Antivirus scan** of finished files: Windows Defender `MpCmdRun -Scan -ScanType 3 -File {file} -DisableRemediation`, `clamscan --no-summary {file}`, or a custom command with `{file}`; extension filter; results Clean / Infected (file not kept) / Error / Skipped.
- **Checksum verification** when known.
- **Tools** (sidebar section; also in the item menu and the completion dialog): **Convert to** MP3/WAV/FLAC/M4A/JPG/PNG/WebP/MP4/WebM/GIF (short clips)/audio-of-video, pack several files into a ZIP; **Make smaller** to fit Discord (20 MB), e-mail (25 MB), WhatsApp (16 MB) or a custom size, with predicted size/resolution/quality and a re-encode if the result overshoots; results saved next to the originals; one ffmpeg job at a time, jobs survive closing the Tools window.
- **"What's inside a ZIP"** in the Download File window: the archive's directory is read from its **end over range requests** (a few KB), shown as a tree, and **one file can be downloaded on its own** (stored or deflated, not encrypted), unpacked as its bytes arrive, CRC-checked.

### 1.1.8 UI

- Main window: custom title bar, glass sidebar, dense **virtualised** table (columns Name, Size, Status, Progress, Speed, Time left, Last try, Added, Folder, Category, Description — user-selectable, sortable), bottom details pane (connections, speed, info), status bar (total speed, running queues, limiter toggle, integration status), toasts, "What's new" sheet after update, Onboarding (3 steps: browser extension, folders, done), empty state, compact view (list only).
- **Details window** per download: *File map* (one bar, each segment at its byte share, filled by `pos`, coloured per connection), *connection lanes* (one per active connection with range, head, speed, "+N more"), **speed graph** (last 60 s, average and peak), event log (probed, split, server limit, retrying in N s, restarted), "Download complete — no open connections".
- **Mini window** (always-on-top glass strip with active downloads; pin/unpin), **drop zone**, **tray** (Open, Add URL, Pause all, Resume all, Speed limiter check item, Mini window, Drop zone, Quit), close-to-tray, start minimized, launch at startup, hide Dock icon (macOS), window freed after a minute in the tray.
- Item context menu: Open, Show in folder, Convert to ▸, Make smaller ▸, Resume, Pause (Space), Redownload, Refresh download address…, Speed limit…, Move to queue ▸ / Remove from queue, Move up/down, Copy link(s) (Ctrl+C), Details, Properties… (F2), Delete (Del), Delete with files…; Trash: Restore, Delete permanently.
- Dialogs: Download File (name, folder, category, queue/start mode, description, connections, remember folder, ZIP contents, live probe update, credentials retry, free-space line), Download video (quality list, container, audio format, embeds, subtitles, only-a-part, playlist entries, one-at-a-time, folder), Add torrent (files tree with select, category, queue, free space, info hash, "Fetching from peers…"), Batch, Complete, Properties, Speed limit (this download / N downloads; `500k`, `2M`, `1.5 MB/s`), Refresh address, Delete / Delete with files / Move to trash confirmations, post-action countdown banner, update banner (in-app updater: checkpoint all downloads, install, restart, resume).
- Appearance: theme system/dark/light, 6 accent colours, density comfortable/compact, motion system/full/reduced, reduce transparency, window material (Mica/vibrancy), visible columns, compact view; **10 languages incl. Arabic with full RTL mirroring**.
- Keyboard: Ctrl+L limiter, Enter open, Space pause, Del delete, F2 properties, Ctrl+C copy links, Alt+↑/↓ reorder; configurable `shortcuts` map in settings.

### 1.1.9 Settings (complete)

- **General**: launch at startup (on), start minimized, close to tray (on), show Download File dialog (on), open a progress window for new downloads (off), completion dialog (on), notifications (on), confirm before deleting (on), use trash (on), check updates (on), remove deleted files (off), language, hide Dock icon.
- **Appearance**: see above.
- **Downloads**: default folder, sort into category folders (on), connections per download (8), maximum connections (32), when the file exists (ask/rename/overwrite), retries before failing (20), global speed limit (5 MiB/s, off), verify checksums (on), start downloads automatically (on).
- **Connection**: user agent (empty = current Chrome UA), connect timeout 15 s, read timeout 30 s, HTTP version (HTTP/1.1 / Automatic / HTTP/3), connections per server (0 = no limit; "Prism also learns limits servers enforce").
- **Proxy**: none/system/HTTP/SOCKS5, address, user, password, bypass hosts.
- **Browser capture**: take over downloads (on), captured extensions (60 defaults incl. zip 7z rar iso exe msi dmg deb rpm apk mp4 mkv mp3 pdf torrent …), captured MIME types (octet-stream, zip, x-msdownload, rar, 7z, iso, bittorrent), never capture from (`*.update.microsoft.com`, `*.windowsupdate.com`, `accounts.google.com`), ignore files smaller than N KB, bypass key, show "Download video" button, minimum video duration.
- **Sounds**: enabled, on complete/failed/queue done, volume 0.6, completion sound.
- **Clipboard**: watch (on), ask before adding (on).
- **Site grabber defaults**: depth 2, max pages 2000, parallel requests 6, respect robots (on).
- **Antivirus**: enabled, scanner auto/Defender/ClamAV/custom, program, arguments, scanned extensions.
- **Video**: yt-dlp path, ffmpeg path, auto-update yt-dlp (on), preferred quality (1080), container (mp4), audio format (m4a), embed subtitles (off) + languages (`en.*`), embed thumbnail (on), metadata (on), chapters (on), SponsorBlock off/mark/remove, accelerate with engine (on), cookies from browser, file name template `%(title)s [%(id)s].%(ext)s`, number playlist videos (off); Install/repair tools; Update yt-dlp now.
- **AI models**: server (huggingface.co / hf-mirror / `HF_ENDPOINT`), access token, models folder (default `<downloads>/Models`).
- **Shortcuts** map; onboarding done; last seen version.

## 1.2 Implementation notes (concrete)

### 1.2.1 Data model

```ts
type ItemKind = 'http'|'ftp'|'hls'|'dash'|'video'|'torrent';
type Status = 'idle'|'queued'|'connecting'|'downloading'|'retrying'|'paused'|'processing'|'completed'|'failed';
// active (holds a queue slot): connecting|downloading|retrying|processing
interface DownloadItem {
  id: string; kind: ItemKind; url: string; finalUrl?: string;
  fileName: string; saveDir: string; size?: number; downloaded: number;
  status: Status; error?: string; category: string; queueId?: string;
  description: string; referer?: string; addedAt: number; lastTryAt?: number; finishedAt?: number;
  resumable?: boolean; connections: number; speedLimit: number /*B/s, 0=none*/;
  checksum?: string /* "sha256:hex" */; trashed: boolean; position: number /* order in queue */;
  mirrors: string[]; grabberProject?: string;
  request?: DownloadRequest;   // serialised request/job spec
  resume?: ResumeState;        // never sent to the UI
  media?: { title?, thumbnail?, duration?, quality?, site?, pageUrl?, playlistIndex?, section?: {from,to} };
}
interface Category { id; name; icon; extensions: string[]; saveDir?: string; builtin: boolean; position: number }
interface Queue { id; name; maxConcurrent: number; speedLimit: number; position; builtin; schedule: Schedule; running: boolean }
interface Schedule { enabled; startTime?: 'HH:MM'; stopTime?: 'HH:MM'; days: number[] /* ISO 1..7, [] = every day */;
  onceDate?: 'YYYY-MM-DD'; retryFailed: boolean; onComplete: PostAction; wake: boolean }
type PostAction = {type:'none'|'exit'|'sleep'|'hibernate'|'shutdown'|'lock'|'sound'} | {type:'command', value:string};
```

SQLite tables: `downloads` (one row per item, `resume_json`, `request_json`), `categories`, `queues`, `schedules` (json per queue), `grabber_projects {id,name,config,results,created_at,updated_at}`, `settings {key,value}` (one JSON document, partial-patch merge: objects merge recursively, everything else replaces). WAL, `synchronous=NORMAL`.

Live progress is **not** persisted: `Progress { id, status, downloaded, size, speed, etaSecs, connections, detail?: "Muxing"|"Retrying in 4 s", fraction? }` batched to the UI at **4 Hz** as a diff; discrete `item-added/updated/removed` events; the list is virtualised.

### 1.2.2 The segment table (the core algorithm)

State: one mutex-protected array of segments. The file `[0,total)` is always partitioned.

```ts
interface Seg {
  start: number; pos: number; end: number;   // [start,pos) received; [start,end) owned range
  reqEnd: number;        // end of owner's current bounded HTTP request (split hint), 0 = none
  written: number;       // [start,written) durably handed to the OS by the writer
  extra?: [number,number]; // a flushed range beyond `written` (race partner ahead), merged when contiguous
  owner?: WorkerId; racer?: WorkerId; retrying: boolean; failed: boolean;
  received: number; meter: EWMA; peakRate: number;
}
const SPLIT_ALIGN = 4096; const UNKNOWN_END = 2**53;
```

`acquire(worker, allowRace)` — called by an idle worker, under the lock:

1. **Unowned, unfinished segment with the largest remainder** → set `owner`, clear `failed`, `reqEnd=0`, return `{seg, cursor: pos}`.
2. If splitting is disabled (unknown size, non-resumable, POST) → nothing.
3. **Split**: among segments with an owner, no racer and `end - pos >= 2*minSplit` (minSplit default 1 MiB, never below 4 KiB), pick the largest remainder. `mid = alignDown(pos + (end-pos)/2)`; `hint = alignUp(reqEnd)`; use `at = hint` if `hint > mid && hint < end && end-hint >= minSplit` (split *behind* the victim's in-flight request so its socket survives), else `at = mid`. Set `victim.end = at`; push a new `Seg{start:at,pos:at,end:oldEnd, owner:worker}`; return `{seg: newIndex, cursor: at}`. The victim notices the shrunk `end` in its next `advance()`.
4. **Race** (only if `allowRace`, i.e. no speed limiter active): compute `typical = median(peakRate of all segments with peakRate>0)`; candidates = owned, unraced, unfinished, known-end segments with `ownEta > 3 s && ownEta > 4 × etaAtTypical` where `eta = remaining / rate`; take the worst ETA; set `racer = worker`; return `{seg, cursor: pos, race: true}`.

`advance(seg, worker, cursor, n)` — after each received chunk, under the lock: if the worker is neither owner nor racer, or the segment is done, or `cursor >= end` → `{accept:0, stop:true}`. Else `accept = min(n, end-cursor)`, `newPos = cursor+accept`, `progressed = max(0, newPos - pos)`; `pos = max(pos,newPos)`; if `pos >= end` → clear owner/racer/retrying. Return `{accept, progressed, stop: done || newPos >= end}`. Only `accept` bytes are written; `progressed` bytes are credited to the download counter (races never double-count).

`release(seg, worker, failed)`: owner leaving → `owner = racer` (racer promoted), `reqEnd=0`; `failed` flag only if nobody owns it and it isn't done. Racer leaving → `racer = undefined`.

`onFlushed(seg, offset, len)` from the writer: if `offset <= written` → `written = max(written, offset+len)`; else keep as `extra` (merge overlaps), and fold `extra` into `written` once contiguous; clamp `written ≤ end`.

`durableStates()` → `[{start, pos: clamp(written, start, end), end}]` sorted by start — this is what gets persisted.

`fromStates(states, total)` rebuilds the table on resume (validated: sorted, contiguous, `start ≤ pos ≤ end`, covering `[0,total)`).

### 1.2.3 Workers, requests, ramp-up, limits

- Each worker owns **its own HTTP client / connection** (HTTP/1.1; `Connection: keep-alive`); on Android use one OkHttp client per worker or a `ConnectionPool` sized 1; in Node use `undici.Agent({connections:1})` per worker. All workers share one TLS session cache.
- Bounded requests: `len = clamp(rate × 2 s, 4 MiB, 16 MiB)` (per-request override, e.g. 10 MiB for googlevideo), rounded to 4 KiB; request `Range: bytes=cursor-(cursor+len-1)`; call `setRequestEnd(seg, worker, cursor+len)` so splits prefer that boundary. When a bounded request drains fully the socket is reused for the next range; "between requests" is also when a worker **retires** if the target connection count dropped.
- **Ramp-up**: start `initial_connections` (4); once each has delivered data, spawn the rest up to the target (8 default, user max 32). Supervisor tick 250 ms (speed meters, ramp-up, limit probing).
- **Server limit** (`Refused`): a *non-first* connection gets `429`/`503`, `403` after a successful probe, FTP `421`, or a connect refused/reset **twice in a row before any byte** → target = number currently connected; record `{host[:port] → connections}` in the shared `HostLimits` table with TTL 24 h (persist as JSON `[{host, connections}]` in settings); emit `ServerLimitDetected`; probe one more connection after **20 s**, doubling to **300 s** max; after a `Retry-After` wait ≥ 300 s. Every worker holds a per-host permit = `min(learned, globalCapPerHost)`.
- **Retry policy** per worker: `delay(attempt) = d/2 + d/2·rand()` with `d = min(30 s, 0.5 s · 2^attempt)` ("equal jitter"); attempt resets after any progress; after `429`/`503` the next request covers the whole remaining segment (fewer requests); a dropped connection *after progress* reopens immediately; `Retry-After` honoured up to 60 s; give up after `max_retries` consecutive no-progress failures; after a worker gives up wait 10 s before spawning a replacement; the job fails only when no worker can progress. Transient = timeout, reset, 5xx, 429, short read. Fatal = 404, 410, 401 without credentials, `NoSpace`, `ValidatorMismatch`, `WebPage`, `BrowserCheck`, `ChecksumMismatch`.
- **Stall**: no bytes for `read_timeout` (30 s) → drop the connection and retry.

### 1.2.4 Probe, resume, validators

- Probe request: `GET` with `Range: bytes=0-4194303` + all request headers (cookies, referer, UA, auth). `206` + `Content-Range: bytes 0-x/total` → `size=total, resumable=true`, keep reading the body as worker 0. `200` → `size = Content-Length?`, `resumable=false`, single connection. Record `etag`, `last_modified`, `accept_ranges`, `mime`, `final_url`, derive the file name.
- Reject as **web page**: `Content-Type` starts with `text/html` or `application/xhtml` and (size unknown or < 2 MiB) **and** the expected name is binary (any extension in the built-in category lists except csv/md/rtf/svg/txt). Reject as **browser check**: header `cf-mitigated: challenge` (trimmed, case-insensitive).
- `ResumeState` (JSON, `version: 1`):

```json
{ "version":1, "kind":"http|ftp|media", "url":"…", "final_url":"…|null",
  "part_path":"…/name.ext.prismpart", "final_path":"…/name.ext",
  "total_size":123456, "etag":"\"abc\"", "last_modified":"Sat, …", "resumable":true,
  "segments":[{"start":0,"pos":10,"end":50},{"start":50,"pos":100,"end":100}],
  "media":null }
```

- Resume: check `part_path` exists and `len == total_size`; else delete and restart (event `Restarted`). First request on the first pending segment carries `If-Range: <strong ETag>` or `If-Range: <Last-Modified>` (never a weak `W/` ETag). A `200`, a changed total, or a changed strong ETag → `ValidatorMismatch` → UI asks to restart. **No validators**: re-download up to 64 KiB just before the resume point of the segment with the most data and byte-compare with the part file; mismatch → `ValidatorMismatch`.
- **Checkpoint** (manager every 2 s and on pause): `writer.flush(sync=true)` = write all buffers, `fsync`, then capture `durableStates()`; persist that JSON. Never persist a snapshot taken before the fsync.
- Completion: flush + fsync, size check, checksum, atomic rename honouring the conflict policy; the Windows sparse flag is cleared best-effort.

### 1.2.5 Writer and disk

- One writer thread per download; workers push chunks through a channel; the writer coalesces each worker's contiguous chunks into **1 MiB** positioned writes (`pwrite` / `FileChannel.write(buf, position)` / `fs.write(fd, buf, 0, len, position)`); idle flush after 200 ms; the writer alone advances `written`.
- Engine-wide memory budget (64 MiB semaphore): a worker reserves bytes before handing a chunk over; released when written; when exhausted workers stop reading sockets.
- Pre-allocation: Windows `FSCTL_SET_SPARSE` then `SetEndOfFile`; Linux `fallocate` (fallback `ftruncate`); others `ftruncate` (sparse on APFS). Android: `FileChannel.truncate/position` grows sparse on ext4/f2fs; check free space (`StatFs`) first.

### 1.2.6 Rate limiter (GCRA)

Single shared timeline per limiter: `acquire(bytes ≤ 64 KiB)` reserves the next slot under a short lock (`slot = max(now, tail); tail = slot + bytes/rate`) then sleeps once until `slot` **outside** the lock; burst tolerance 250 ms (min 64 KiB) is credited so oversleeping isn't lost; slots come from the monotonic clock, never from measured sleep. Workers acquire from `[download, queue…, global]` in that order; `setRate(0)` = unlimited, live. Speed meter: EWMA with τ = 2 s.

### 1.2.7 File names

`deriveFileName(contentDisposition, url, mime)`: `filename*=UTF-8''…` (RFC 5987, also ISO-8859-1) wins over `filename=`; then last non-empty URL path segment percent-decoded; then `download`; append an extension from MIME when none. `sanitize`: strip directory parts, replace `<>:"/\|?*` and control chars with `_`, trim spaces and trailing dots, escape `CON COM1 … LPT9`, limit ~200 bytes keeping the extension. `uniquePath(dir, name, suffix, overwrite)`: try `name`, `name (1).ext`, … up to 10,000, requiring both the final and the `.part` path to be free.

### 1.2.8 Queues, admission, scheduler

- `admit()` runs on every 1 s tick and after `startQueue`: for each running queue, `free = maxConcurrent − count(items active or with a live job)`; start the first `free` items with `status == queued` ordered by `position`. Counting and starting are one atomic step (a mutex), or two ticks fill the same slots.
- `startQueue(id)`: `running=true`; items idle/paused (+ failed if `retryFailed`) → queued; if nothing is queued or active, mark not running and emit `QueueFinished` **without** running the post action (empty "Run now" used to put the PC to sleep).
- `stopQueue(id)`: pause active items, queued → idle.
- Finish detection each tick: a queue that was busy and now has nothing queued/active → `running=false`, `QueueFinished`, queue-done sound, post action if `schedule.enabled || onComplete != none`; a `onceDate` schedule disables itself.
- **Scheduler is crossing-based**: keep `prevTick`; a moment `t` fires when `prev < t ≤ now` on a day the schedule runs (ISO weekday in `days`, or `onceDate`), scanning each calendar day touched by `(prev, now]` (windows may span midnight); `prev = max(prev, now − 30 min)` so a missed start after sleep fires once but a start missed by hours is skipped. `nextStart` searches 15 days ahead (UI text and wake timers; the wake timer is armed 30 s early).
- Post actions: sleep/hibernate/shutdown/lock → emit `PostActionPending{action, seconds:30}`, cancellable token; on expiry checkpoint everything then call the OS power API. `command` → shell. `exit` → quit app. `sound` → play.

### 1.2.9 Categories

`classify(categories, fileName)`: lower-case extension; first matching **custom** category, else first matching built-in, else `other`. `saveDirFor(category, defaultDir, useCategoryFolders)`: category's own folder, else `defaultDir/<CategoryName>` (never for Other), else `defaultDir`. Built-in extension lists (video/music/documents/programs/compressed/images) are in `prism.md §2.2` and `crates/prism-core/src/categories.rs`.

### 1.2.10 Clipboard monitor

Thread polling every 700 ms: read the OS change counter (`GetClipboardSequenceNumber` / `NSPasteboard.changeCount`; Android: `ClipboardManager.addPrimaryClipChangedListener`, note Android 10+ restricts background clipboard reads to the foreground app/IME); skip when the content is flagged concealed (`ExcludeClipboardContentFromMonitorProcessing` / `org.nspasteboard.ConcealedType|TransientType`; Android: `ClipDescription.EXTRA_IS_SENSITIVE`); ignore unchanged text; tokenise on whitespace and `"'<>`, trim `,;()[]`; keep `magnet:?…` and `http(s)|ftp` URLs whose last path segment's extension is in the capture list; max 200; dedupe.

### 1.2.11 Batch pattern expansion

Grammar: `[a-b]`, `[a-b:step]`; numeric bounds → zero-pad to the wider bound's width if either has a leading zero; descending counts down; single ASCII letters `[a-z]`, `[A-F]` (+step, same case); mixed case or step 0 → `InvalidRange`; brackets that aren't ranges (e.g. `[::1]`) are literal; several ranges → cartesian product, leftmost slowest; total > 10,000 → `TooMany`.

### 1.2.12 Site grabber

BFS from `startUrl` with `(url, depth)` queue; fetch `concurrency` pages at a time (reqwest-equivalent with cookie jar, 30 s timeout, optional `Cookie` header and Basic auth; form login POST first with placeholders replaced); non-HTML `Content-Type` → the "page" is a file (`download.php?id=1`); parse `<base href>`, `a[href] area[href] frame[src] iframe[src]` as links, `img[src|data-src] video[src] audio[src] source[src] embed[src]` + `srcset` as embedded media; link is a file if its extension matches `extensions` (or is not an HTML extension `html htm php asp aspx jsp shtml cgi ""` when the list is empty); follow pages only if `depth < max`, HTML-ish extension, in scope (same host / registrable domain heuristic: last two labels, three for `co.uk`-style / below start path / any) and unseen; skip URLs containing any `exclude` substring; files may be off-scope when `filesAnyHost`; dedupe files; stop at `maxPages` or cancel; stream events `PageVisited{url,depth,pages,queued}`, `FileFound{file}`, `PageError`, `Finished{pages,files,cancelled}`; then optional HEAD pass for size/MIME with bounded concurrency.

### 1.2.13 Remote ZIP peek (central directory over HTTP ranges)

Fetch the last `TAIL_LEN = 22 + 65535 + 20 + 56` bytes (EOCD with max comment + ZIP64 locator + ZIP64 EOCD) with `Range: bytes=-N`; scan backwards for `0x06054b50`; read `entries`, `cd_size`, `cd_offset`; if any 32-bit field is `0xFFFF(FFFF)` follow the ZIP64 locator (`0x07064b50`) → ZIP64 EOCD (`0x06064b50`); compute `shift` = (actual EOCD position − cd_offset − cd_size) for self-extractor prefixes; if the directory isn't inside the tail already, fetch `[cd_offset+shift, +cd_size)` (cap 16 MiB ≈ 150k entries); parse `0x02014b50` entries (`name, method, flags, crc, compressed, uncompressed, local_header_offset`, ZIP64 extra). An entry is **extractable alone** when method is Stored (0) or Deflated (8) and not encrypted (flag bit 0 / method 99 AES). Extract one: fetch its local header (30 bytes + name + extra lengths) at `lho+shift`, then `[dataStart, dataStart+compressed)`, inflate on the fly (raw deflate), check size and CRC-32; reuse the capture's cookies/referer/UA/credentials/proxy; abort if the server's ETag/size changed between requests. Error codes: no ranges, split archive, too many files, needs sign-in, file changed, corrupt, encrypted/unsupported, cancelled, antivirus found a threat.

### 1.2.14 HLS / DASH job

Resolve manifest → list variants (height/bandwidth) for a picker → choose video rendition (+ audio rendition from the variant's group: default → autoselect → first with URI) → segment lists per track → N workers fetch segments to `<final>.prismpart.d/seg-NNNNNN.bin` (write, fsync, rename; AES-128 decrypt with `IV` from `EXT-X-KEY` or 16-byte big-endian media sequence; `EXT-X-MAP` prepended; byte ranges honoured) → `MediaResumeState { kind, tracks[], segment_counts[], completed[], work_dir }` persisted → concat per track → `ffmpeg -i v -i a -c copy -movflags +faststart out.mp4` (or keep raw `.ts`/fMP4 and `<name>.audio.<ext>` with a warning). DASH: resolve `$Number%0Nd$`/`$Time$`/`$Bandwidth$` templates, `SegmentTimeline` `S@t/@d/@r`, `SegmentList`, or whole-file `SegmentBase`; refuse live/multi-period/DRM.

### 1.2.15 yt-dlp integration

- Probe: `yt-dlp --ignore-config [--ffmpeg-location D] [--js-runtimes deno:PATH] [--proxy P] [--cookies-from-browser B] [--cookies F] [--add-headers "Referer:…" "User-Agent:…"] -J --no-warnings --flat-playlist (--no-playlist|--yes-playlist) -- URL`; follow one `_type: url` redirect; parse tolerantly (numbers as strings, `has_drm: "maybe"` = not DRM).
- Choice building: per (height, HDR) bucket, highest first: fps ↓, codec preference by container (MP4: H.264 > AV1 > VP9 > HEVC; MP4 HDR: AV1 > VP9 > HEVC; MKV: VP9 > AV1 > H.264; WebM: VP9 > AV1 > VP8), separate A+V before pre-muxed, progressive HTTP before HLS/DASH, bitrate. Audio pairing: original language, non-DRC, codec for container (MP4 AAC > Opus; WebM/MKV Opus first), HTTP, bitrate. Container fallback to MKV when codecs don't fit. Audio-only: MP3 320k (encode), M4A (copy AAC else AAC 256k), Opus (copy else libopus 160k), FLAC, WAV. Estimated size shown.
- Plan = accelerated iff every referenced format is one `http(s)` file, not live/upcoming/post-live, no DRM, SponsorBlock ≠ remove, no section. Else yt-dlp with args:
  `-f <id>+<id>/bv*[height<=H]+ba/b[height<=H]/b (--merge-output-format C --remux-video C | -x --audio-format F --audio-quality Q) -N 8 [--download-sections *S-E --force-keyframes-at-cuts] [--sub-langs L --write-subs --write-auto-subs --embed-subs] [--embed-thumbnail --convert-thumbnails jpg] [--embed-metadata] [--embed-chapters] [--sponsorblock-mark|--sponsorblock-remove CATS] --newline --progress --color never --progress-delta 0.5 --progress-template "download:PRISM %(progress)j" --progress-template "postprocess:PRISMPP %(progress)j" --print "after_move:PRISMFILE %(filepath)s" --no-mtime --windows-filenames --no-playlist -P <dir> -o <template>` (PRISMPP lines on stderr, the others on stdout).
- Post-process (accelerated): `-map 0:v:0 -map 1:a:0 -c copy`; subs `mov_text` (MP4) / copy (MKV) / `webvtt` (WebM) with ISO 639-2 tags; thumbnail WebP→JPEG, MP4 `-disposition:v:1 attached_pic`, MKV `-attach cover.jpg -metadata:s mimetype=image/jpeg`; FFMETADATA1 file for title/artist/date/comment/description (≤ 2000 chars) + chapters; `-movflags +faststart`; progress from `-progress pipe:1` `out_time_us/duration`; output to `<name>.prismtmp.<ext>` then rename; cancel kills ffmpeg and removes the partial.
- Tool install: stream to temp in tools dir, hash on the fly, verify against the publisher's checksum file **from the same release tag** (resolve `releases/latest` to a tag with a non-following request first), extract, `chmod 755`, remove macOS quarantine, atomic rename; on Windows move a running `yt-dlp.exe` aside to `.old-N`. Child processes: `CREATE_NO_WINDOW`, `PYTHONUTF8=1`, kill the whole tree (Job Object / process group).

### 1.2.16 Browser-extension bridge protocol (v1) — for a desktop Electron build

Transport: extension → native messaging host (`u32` native-endian length-prefixed JSON frames ≤ 64 MiB on stdio) → `POST http://127.0.0.1:<port>/v1/message` with `Authorization: Bearer <64-hex token>` and the message bytes unchanged; `GET /v1/health` → `{"ok":true,"version":"x.y.z"}`. The app writes `ipc.json = {"port","token","pid","version"}` atomically into its data dir after the server listens and deletes it on exit; the host stats it on every request; a stale file costs one 600 ms connect timeout; the host launches the app with `--background` (detached, own process group/`CREATE_BREAKAWAY_FROM_JOB`) when the file is missing or the port is dead and the message lacks `noLaunch`, then polls `ipc.json` + `/v1/health` for 8 s; one launch at a time. Host timeout 20 s (90 s for `probeVideo`); replies < 1 MiB; non-object replies wrapped `{"ok":true,"data":…}`; 401/403 → re-read `ipc.json` once then `unauthorized`. Host error codes: `bad_json, bad_request, app_not_running, app_unreachable, unauthorized, app_error, bad_reply, reply_too_large, timeout, too_large`. `hostPing` is answered by the host itself. Each message handled on its own thread. Registration writes per-user manifests (Windows `HKCU\Software\<vendor>\NativeMessagingHosts\<name>`; Linux `~/.config/<browser>/NativeMessagingHosts/<name>.json`, Firefox `~/.mozilla/native-messaging-hosts/`; macOS `~/Library/Application Support/<browser>/NativeMessagingHosts/`), idempotent, run on every app start ("self-healing"), and the app exposes `status()` per browser.

Envelope: `{ id, type, noLaunch? }`; every reply `{ ok:true, … }` or `{ ok:false, error:{code, message} }`, **answered immediately** (never block on a dialog; a captured browser download is held until the reply). Extension timeouts: `hello` 4 s, `status` 2.5 s, actions 5 s (12 s when the app may need launching), `probeVideo` 60 s.

| type | request | reply |
|---|---|---|
| `hello` | `{protocol:1, version, browser, userAgent, installType}` (on worker start, browser start, install, every minute with `noLaunch`) | `{app:{name,version}, protocol:1, settings:{captureEnabled, extensions:["ZIP","R0*"…], mimeTypes:["video/","application/x-"…], minSize, excludedSites, bypassKey, showVideoButton, videoSites}}` |
| `download` | `{url, finalUrl?, referrer?, pageUrl?, filename?, fileSize?, mime?, method:"GET", headers?:{Origin}, cookies, finalUrlCookies?, userAgent, incognito, source:"capture"|"contextMenu"}` | `{accepted:true, downloadId}`; `accepted:false` or any error ⇒ browser keeps it |
| `batch` | `{pageUrl, title, kind:"links"|"images"|"videos"|"selection", items:[{url, referrer, kind, filename?, text?, cookies}], userAgent, incognito}` | `{accepted:true, count}` |
| `probeVideo` | `{pageUrl, cookies, userAgent}` | `{title, thumbnail, duration, formats:[{id, label, kind:"video"|"muxed"|"audio", ext, height?, fps?, size?, note?}]}` |
| `video` | `{pageUrl, title, formatId, formatLabel, streams:[], cookies…}` **or** `{pageUrl, title, streams:[{url, kind:"hls"|"dash"|"direct", mime?, size?, quality?, headers?}], cookies…}` | `{accepted:true}` |
| `status` | `{noLaunch:true}` | `{app:{name,version}, captureEnabled}` |
| `open` | `{page:"main"|"browserIntegration"|"settings"}` | `{ok:true}` |

Rule semantics: `extensions` upper-case, no dot, `*`/`?` wildcards; `mimeTypes` entries ending in `/` or `-` are prefixes, else exact; `excludedSites`: `host` (incl. subdomains), `*.host`, or a URL glob when it contains `://` or `/`; `bypassKey` `alt|shift|ctrl|meta|none`. Chromium capture point: `downloads.onDeterminingFilename` (hold, ask, cancel+erase on accept); Firefox: blocking `webRequest.onHeadersReceived` for `Content-Disposition: attachment` + `downloads.onCreated` backstop. Keep one `connectNative` port open (keeps the MV3 worker alive), id-correlated requests, 5 s reconnect backoff, one-shot `sendNativeMessage` fallback, 1-min `alarms` watchdog `hello`.

Media sniffing classifier (reusable in an Android WebView via `shouldInterceptRequest` or a desktop webview's `webRequest`): HLS if MIME in `application/vnd.apple.mpegurl, application/x-mpegurl, audio/mpegurl, audio/x-mpegurl` or ext `M3U8` with a generic MIME; DASH if `application/dash+xml` or ext `MPD`; segment if MIME `video/mp2t, video/iso.segment, audio/iso.segment` or ext `TS M4S M4F CMFV CMFA` (listed only until a manifest appears); `video/*`/`audio/*` direct; generic MIME (`""`, octet-stream, text/plain, application/binary…) + media extension (`MP4 M4V WEBM MKV MOV FLV AVI OGV 3GP WMV` / `MP3 M4A AAC OGG OGA OPUS FLAC WAV WMA`) direct. Identity key = URL without fragment and without `range, bytes, rn, rbuf, bytestart, byteend, _` params. Size = `Content-Range` total for 206 else `Content-Length`. Ignore `googlevideo.com`, `blob:`, `data:`.

### 1.2.17 Video sites and post-URL resolution

Default `videoSites`: youtube.com, youtu.be, youtube-nocookie.com, vimeo.com, twitch.tv, x.com, twitter.com, instagram.com, tiktok.com, facebook.com, fb.watch, reddit.com, dailymotion.com, soundcloud.com, bilibili.com, rumble.com, streamable.com, bandcamp.com, ted.com, nicovideo.jp, odysee.com, vk.com, vk.ru, vkvideo.ru, ok.ru, linkedin.com. Single-post path regexes for feeds (X `/status/\d+`, Reddit `/comments/`, Instagram `/(p|reel|tv)/`, TikTok `/@u/video/\d+`, Facebook `/videos|reel|posts/`, YouTube `/shorts/`, Vimeo `/\d{5,}`, LinkedIn `/feed/update/urn:li:…`) are in `extension/src/shared/media.ts`. Feed/profile pages of LinkedIn/Instagram are refused without calling yt-dlp.

### 1.2.18 Libraries Prism uses (for picking equivalents)

| Purpose | Rust crate | JS/Node | Android/Kotlin |
|---|---|---|---|
| HTTP | reqwest 0.13 / hyper 1 / rustls | undici (one `Agent` per worker) or Node `http(s)` | OkHttp (per-worker client), or Cronet |
| FTP | suppaftp | basic-ftp | Apache Commons Net |
| HLS parse | m3u8-rs | m3u8-parser | own parser / ExoPlayer's HlsPlaylistParser |
| DASH parse | dash-mpd-core | mpd-parser | ExoPlayer DashManifestParser |
| AES-128-CBC | aes + cbc | `crypto` | `javax.crypto` |
| Hashes | sha2/sha1/md-5 | `crypto` | `MessageDigest` |
| Torrent | librqbit 9 | webtorrent / aria2c RPC | libtorrent4j (already in `ref/`) |
| SQLite | rusqlite (WAL) | better-sqlite3 | Room / SQLDelight |
| HTML parse | scraper | cheerio / parse5 | jsoup |
| Clipboard | arboard + OS APIs | Electron `clipboard` + polling | `ClipboardManager` |
| yt-dlp/ffmpeg | child processes | child_process | youtubedl-android / ffmpeg-kit |
| ZIP peek | own (`zipdir.rs`) + flate2 | own + `zlib.inflateRawSync` | own + `Inflater(nowrap=true)` |

---

# Part 2 — HatchZip

HatchZip extracts ZIP, 7z, RAR, tar, `.tar.gz` and split archives **in place**: it reads the archive's index, saves it to a side file, extracts the archive's independent pieces starting from the **last** one, and after each committed batch **truncates the archive** to where that batch began, so the disk only needs room for the output (plus roughly the largest piece), not for archive + output. It checks that the plan fits before touching anything, keeps a reserved margin, and survives a kill or power cut at any moment via a journal. Workspace: `crates/core` (engine library `hatchzip-core`), `crates/cli` (`hatchzip` / `hz`), `crates/shell` (right-click menu registration), `crates/gui` (Slint desktop app).

## 2.1 Features

### 2.1.1 Formats

- **ZIP, ZIP64, self-extracting `.exe` ZIPs**: Stored, Deflate, Deflate64, bzip2, LZMA, PPMd, XZ, Zstandard; entries past 4 GiB; unit = one entry; freed per file.
- **7z** solid and non-solid: LZMA2, LZMA, BCJ+LZMA2, bzip2, Deflate, PPMd, Zstandard; unit = one solid block (or one file in a non-solid archive); encrypted headers supported with the password; **anti-items refused**; one huge solid block works but needs free space for the whole block (reported by `check`).
- **tar** (uncompressed): long names (GNU/pax), symlinks, hard links; pax global headers skipped; unit = one entry incl. its long-name/pax records; device files, FIFOs and sparse entries refused.
- **`.tar.gz` / `.tgz`**: single- or multi-member gzip (`bgzip`, `pigz -i`), split `.tar.gz.001` sets; extracted **front to back** with hole punching behind the decoder every 256 MiB; every gzip member's CRC-32 and ISIZE verified in a first full pass before anything is touched; on FAT32/exFAT it still extracts and resumes but frees nothing until the end (and `check` says so).
- **Split archives** `.001/.002/…` of ZIP or 7z (7-Zip style byte splits): any part's name finds the set; a volume is deleted as soon as everything in it is extracted; the one the cut falls in is shortened.
- **RAR 5 and RAR 4** (release builds, UnRAR): single files and volume sets (`.part1.rar…` or `.rar,.r00…`), encrypted files, **encrypted file names** (`-hp`, headers decrypted in Rust), stored files streamed while written, volumes deleted once every file reaching into them is out; **solid RAR only with keep-archive**; refused: links, dictionaries > 4 GB, missing or stray volumes, headers failing checksums.
- **Passwords**: ZIP (ZipCrypto, AES), 7z (AES incl. encrypted file lists), RAR; asked in the UI / `--password` / `HATCHZIP_PASSWORD`; **proven before anything is deleted** (ZIP/7z: decode the start of the smallest encrypted unit; RAR 5: PBKDF2 check value from headers; RAR 4: decode the smallest encrypted file whole); never saved — a resumed run asks again.
- **`.sfv` check**: an `.sfv` named after the archive next to it is checked against every volume before anything changes.
- Planned/refused: `.tar.zst`, `.tar.xz`, `.tar.bz2` (research in `docs/formats.md`), native split ZIP `.z01`, nested archives, `.dmg`.

### 2.1.2 In-place extraction engine

- **Space check before anything** ("will it fit"): replays the whole extraction unit by unit, counting what each step adds (files rounded up to 4 KiB) and frees (the unit's span), including the saved tail; the peak of the running total is what's required; refuses unless `free ≥ required + keep_free`. Also reports "standard extraction needs" (keep-archive plan) and "available after".
- **Safety margin** `--keep-free` / "reserved space": default **2 GB** (CLI `2GB`; GUI setting in GB); never used by the run; the disk never fills to zero.
- **Batches** of up to **512 units / 2 GB**, sized against the free space measured at that moment, extracted **in parallel** (one thread per unit; `threads = cores / units` hint for multi-threaded codecs), each file written as `<name>.hatchzip-part` then renamed; CRC verified per file; size checked against the declared size.
- **Commit order**: extract → flush (one `syncfs` on Linux; per-file `F_FULLFSYNC`/`FlushFileBuffers` elsewhere, plus directory fsync) → verify files still exist with the right size (antivirus quarantine guard) → journal write (atomic) → truncate the archive. "The journal never claims a file before it is durable, and the archive is never truncated past a unit before the journal claims it."
- **Resume after crash / Ctrl+C / power cut / disk full**: run the same command again; the journal + saved tail next to the archive hold everything; uncommitted part files are deleted and redone; a truncation left pending is finished; links are made at the end.
- **Streaming large files with hole punching** (ZIP stored/deflated ≥ 512 MiB, any tar file, RAR stored in one volume): when the file doesn't fit whole in the free space, it is streamed and the archive bytes behind it are freed every **256 MiB** at a resume point (deflate block boundary in bits + the last 32 KiB of output as the window, read back from the flushed part file); detected per filesystem by punching a 1 MiB scratch file and measuring the allocation drop (ext4, XFS, btrfs, tmpfs; NTFS and APFS unverified; FAT32/exFAT none).
- **Keep archive** (`--keep-archive`, "Remove the archive during extraction" off, "Extract here (keep archive)"): same engine, same checks and resume, but the storage is protected (truncate/punch/write/delete refuse); space plan = whole output; a resumed run keeps keeping; an in-place run can't switch to keeping.
- **Replace existing files** (`--replace`): existing files/links at entry paths are **renamed** into `<out>/.hatchzip-replaced/` (same relative path, no copy, no extra space) before the first extraction and deleted at the end; `--skip-existing` keeps them (the archive's copy is extracted then discarded); GUI asks per file **Replace / Skip / Keep both** (`name (2).ext`) with "do this for the rest"; `restore` moves them back. Folders are never replaced.
- **Several archives** in one run (CLI, GUI task window, file-manager multi-select): one after another, each checked just before it starts so freed space flows to the next; first failure stops the run with a summary and its exit code.
- **Extract here rule**: an archive whose entries all sit under one top-level name (one folder or one file) is extracted next to the archive; anything else goes into a new folder named after it (`game.zip`, `game.7z.001`, `game.tar.gz`, `game.part1.rar` → `game`; a name that wouldn't change gets `-extracted`).
- **Never overwrites** without being asked; refuses a folder where the archive has a file and vice versa; refuses symlinks on the way to any path; refuses anything already at a `.hatchzip-part` name.
- **Hostile-archive protection** before anything is deleted: paths escaping the output (`..`, absolute, drive letters), duplicate paths (case-insensitive, read from the raw central directory), overlapping ZIP entries (zip-bomb technique), entries inside links, hard links to non-files, 7z anti-items, tar device/FIFO/sparse; setuid/setgid/sticky never restored; symlinks created only after every regular file; journals next to an archive are trusted only when the user's profile recorded that extraction (archive + output folder) or `-o` names the folder again.
- **Restore** (`hatchzip restore`, GUI "Restore archive"): a half-extracted archive becomes a normal archive again holding exactly the entries left (ZIP: rebuilt central directory + end records; 7z: new header + rewritten signature header; tar: trailing zero blocks + hard-link entries; RAR: end-of-archive header); needs only the space of the new index; interrupted restores are undone/finished on the next run; refused when a streamed unit has a resume point (holes) or for RAR with encrypted names.
- **`--verify-first`** ("Verify archive before extracting"): read the whole archive and check every checksum before deleting anything.
- **List** and **test** (checksums; plain tar only proves readability); **check** prints the plan without changes.
- Progress: bytes written (sampled), commits (archive length), "Reading archive… N%" while a `.tar.gz` is scanned, speed over the last few seconds, time left; pause (first Ctrl+C finishes the files in flight, saves, exits 130; second quits at once — also safe).
- Exit codes: 0 ok, 1 failure (progress saved), 2 bad command line, 3 not enough space (nothing changed), 4 damaged archive (nothing deleted), 5 password missing/wrong, 130 paused.
- Works on any filesystem that can shrink a file (ext4, btrfs, XFS, NTFS, APFS, exFAT, FAT32); snapshots (btrfs/APFS) keep the space until deleted; output on another disk → nothing is reclaimed on that disk and the check says so.
- No network code at all (CI denies HTTP/TLS/socket crates).

### 2.1.3 CLI (`hatchzip`, alias `hz`)

`extract|x [-o DIR] [--keep-archive] [--replace|--skip-existing] [--keep-free SIZE=2GB] [--verify-first] [-y] [-p/--password|HATCHZIP_PASSWORD] ARCHIVE…` · `check|c [--keep-archive] ARCHIVE…` · `list|l ARCHIVE…` · `test|t ARCHIVE…` · `restore [-o DIR] ARCHIVE` · `completions bash|zsh|fish|powershell` · `man` · global `-q/--quiet`. `check` output: archive size and format, uncompressed size and entry count, available, standard extraction needs, required (+ reserved), available after. `-y` is required when not on a terminal unless `--keep-archive`.

### 2.1.4 Desktop app (Slint) and shell integration

- Main window: open an archive (file dialog, drag-and-drop, `Open with`), flat entry list with sizes, space plan panel (fits / needed / free after; keep-archive plan in bold when enabled; says when only in-place fits), Extract / Extract to…, Test, Settings menu (reserved space in GB, verify first, remove archive during extraction, close progress window when done, show in Explorer context menu), Help → Check for updates (opens the releases page; app makes no network calls), About.
- Task window (from right-click entries): starts at once (the click was the confirmation) unless the space check says no; progress bar, speed, time left, pause/resume, cancel, "Restore archive" for a paused/half-extracted archive (not for a kept one); queues several archives; closes when done (setting).
- Detects a half-extracted archive on open and offers to continue.
- Password dialog (asks again on a wrong password; warns when a RAR 4 check must decode a ≥ 64 MiB file); replace prompt per file.
- Right-click menu entries (per user, no admin; Windows registry `HKCU`, Linux `.desktop` actions for Dolphin/GNOME Files/Nemo, macOS not yet): **Extract files…**, **Extract here**, **Extract here (keep archive)**, **Extract to a new folder**, **Test archive**, registered for `zip 7z tar tgz gz 001 rar r00`.
- GUI CLI flags: `--extract-here`, `--extract-to`, `--extract-files`, `--test`, `--keep-archive`, `--register-shell`, `--unregister-shell`.
- Settings file `settings.json` in the per-OS config dir, written atomically; light/dark follows the system; software renderer fallback without OpenGL.

## 2.2 Implementation notes (algorithms, reproducible without Rust)

### 2.2.1 Terms

- **Unit**: a byte range `[start, nextUnitStart)` of the archive that decodes on its own and can be truncated away once every file in it is safely on disk. ZIP: one entry (local header + data), `start = local header offset`. 7z: one solid block (folder), `start = pack position` (after the 32-byte signature header); directories and empty files form one extra unit starting at the header offset (freed first). tar: one entry including the GNU long-name / pax records that precede it; `start` = offset of the first of those records. RAR: one file from its first header (across volumes). `.tar.gz`: the whole archive is one unit, streamed front to back.
- **Tail**: everything after the last unit's data — ZIP's central directory + EOCD (+ ZIP64 records), 7z's header, tar's closing zero blocks, RAR's nothing. Saved to `<archive>.hatchzip-tail` before the first truncation; CRC-32 recorded in the journal.
- **Storage**: the logical archive = concatenation of volumes (`Part { path, start, len }`). `setLen(len)`: iterate parts from the last: a part wholly past `len` is deleted (`unlink`; `ENOENT` ignored), the part containing `len` is truncated to `len − part.start`, the first part uses the open handle. Reads of already-truncated regions return **zeros** (format parsers scanning backwards for signatures never match zeros; tar sees zeros as the end).
- **Reader with tail**: serves bytes `< tail_start` from the live volumes and `≥ tail_start` from the saved tail file, so the format library sees the original archive.

### 2.2.2 Journal (`<archive>.hatchzip`, JSON)

```json
{
  "version": 3,                       // 4 when keep, 5 when replace, 6 when replace has choices; readable: 2..6
  "format": "zip|7z|tar|tar.gz|rar",
  "parts": [["game.7z.001", 41943040], ["game.7z.002", 41943040]],   // every volume with its ORIGINAL length
  "tail_start": 180203520, "tail_crc": 1234567890,
  "output": "/abs/path/game",
  "total_size": 200000000,
  "committed_len": 150000000,         // archive length after the last commit; every unit starting at or past it is done
  "links": [{"path":"a/b","target":"../c","hard":false}],   // created at the very end
  "resume": null | { "unit": 150000000, "written": 268435456, "bit": 1200000000, "crc": 987654321,
                     "stream": null | { /* tar.gz only: member start?, member crc+len so far, 64 KiB window hex, tar offset, TarAt */ } },
  "restoring": null | [[offset, "bytes"]],                  // bytes a restore will overwrite (7z signature header)
  "keep": false,
  "replace": null | { "moved": true, "keep": ["rel/path"], "both": ["rel/path"] }
}
```

Write protocol (every save): write `<journal>.tmp`, fsync, rename over the journal, fsync the directory. Same for the tail via `<tail>.tmp`. Remove whatever is at a temp name first (a link, never its target), create only where nothing exists (`O_EXCL`, `O_NOFOLLOW`). No "done" counter: units start at distinct offsets, so `committed_len` alone says which are finished. Version bumps are *refusals for older builds*: a build that doesn't know a field that changes resume semantics must refuse the journal.

**Whose journal**: the user's profile (`%LOCALAPPDATA%\HatchZip`, `~/Library/Application Support/HatchZip`, `$XDG_STATE_HOME/hatchzip`) records `(archive, output)` for every extraction started; a journal found next to an archive is used only when that record matches or the user re-specifies `-o`; the record is removed on completion/restore. The journal may only name the archive's own volumes (none a link) and link paths inside the output.

### 2.2.3 Opening an archive (before anything is touched)

1. Locate the first volume (any volume's name works: `name.7z.001` → `name.7z.*` numeric suffix ≥ 3 digits; RAR `.partN.rar` / `.rar + .r00…`). Open read-only for `check/list/test`, writable + locked for extract.
2. If an `.sfv` named after the archive exists, verify every volume's CRC-32; a missing/damaged volume stops here.
3. If a journal exists and is ours: load it, validate, open the storage from `parts` (what is left must be an untouched prefix of each recorded length), build the reader with the saved tail, finish any pending `restoring` undo or pending truncation (cut to `committed_len`), and list units from the reader — only units with `start < committed_len` remain.
4. Else parse the format: build `units` sorted by **descending start**, compute `tail_start = max(dataStart + compressedSize)` over all entries, and run the **refusal checks**: path escapes, duplicate paths (case-insensitive), overlapping entries (ZIP), link/dir conflicts, anti-items, unsupported tar kinds, total size ≤ 2⁶², tail ≤ 1 GB, encrypted entries need a password (prove it now), collisions in the output (file where a dir is needed, dir where a file is, anything at `<name>.hatchzip-part`, links on the way), path lengths the OS can't create (macOS 1024), a link at the default output path.
5. Compute the space plan (§2.2.4). Refuse with exit 3 if `free < peak + keep_free`.
6. Write the journal (fresh: `committed_len = original length`), then save the tail (`[tail_start, end)` with CRC). Record `(archive, output)` in the profile.

### 2.2.4 Space check ("will it fit")

```
extra = fresh ? tailLen : 0          // the saved tail is written first
peak  = extra
for each unit u (descending start, i.e. extraction order):
    span = (i == 0 ? top : units[i-1].start) - u.start   // bytes freed when u commits
    if u is streamable (or solid tar.gz): (rise, net) = streamCost(...)   // see below
    else: rise = net = sum(roundUp4K(item.size) for item in u.items)
    peak  = max(peak, extra + rise)
    extra += net
    if reclaims: extra -= span       // freed archive bytes land on the same disk
if reclaims: extra -= (stub before the first unit) + tailLen   // deleted at the end
required = max(peak, 0); after = -extra
```

`reclaims` = archive and output on the same filesystem **and** not keep-archive. Keep-archive plan = same loop with `reclaims=false` (whole output rounded to 4 KiB + tail). Streamed unit `rise = min(outLeft, (outLeft − dataLeft)⁺ + slack + STEP + BUF + 2·granule)` where `STEP = 256 MiB`, `BUF = 1 MiB`, `granule` = what the FS keeps allocated at each punched end (64 KiB default, 1 MiB NTFS, 16 MiB ZFS, 128 MiB btrfs), `slack = 0` for stored and `outLeft/1024` for deflate; `net = outLeft − (span − alreadyFreed)`. Without punch support a streamed unit costs its whole output. The run itself never exceeds the plan because each batch is sized against the free space measured right then; if another program fills the disk, the run stops before the next unit with "N more is required; progress is saved".

### 2.2.5 One batch (the main loop)

```
next = 0
while next < units.length:
    if stopRequested: return Paused
    if format is solid tar.gz: streamSolid(...) ; commit(next, next+1); next++ ; continue
    if unit is resumable-streamable and (already half-streamed or its output > free - keepFree):
        streamUnit(next); commit(next, next+1); next++; continue
    end = nextBatch(next)             // §2.2.6
    links = extractBatch(units[next..end])   // parallel; returns None if stop requested → Paused (archive untouched)
    commit(next, end, links)
    next = end
finish(): create links (replace existing), delete the remaining archive (stub / signature header) and all volumes,
          put back replaced files to keep, delete .hatchzip-replaced, delete journal, then tail, remove profile record
```

`nextBatch(start)`: `avail = freeSpace(out) − keepFree`; `first = onDisk(units[start])`; if `first > avail` → stop with the "not enough disk space to continue" error (progress saved); `budget = min(avail, max(2 GB, first))`; take units while `count < 512` and `used + size ≤ budget` (the first always fits).

`extractBatch(batch)`: for non-serial formats, `par_iter` over units, each with its own decoder worker and a `DiskSink` that: creates parent dirs, opens `<dest>.hatchzip-part` with create-new + no-follow (anything existing there is an error), writes, verifies CRC at stream end and written size == declared size, sets mtime/mode (no setuid/setgid/sticky), renames to `dest`. Symlinks and hard links are only *recorded* (`links`). Byte counts go to an atomic the UI samples on a timer. For `serial` formats (RAR) one worker walks the batch lowest unit first. Directories are created; empty files written.

`commit(start, end, links)`:

1. `syncBatch(out)`: Linux `syncfs(fd of out)`; macOS `fcntl(F_FULLFSYNC)` per file + `fsync` dirs; Windows `FlushFileBuffers` per file (NTFS journals renames, no dir flush).
2. If no streamed resume point is pending: `removeAfterExtract` (delete stray part files) and **verify** every file of the batch still exists with the right size (antivirus may have quarantined one; claiming it would cut the only copy).
3. `journal.committed_len = batch.last.start`; `journal.links += links`; `journal.resume = null`; save atomically.
4. Unless keep: `storage.setLen(committed_len)`; report commit.

### 2.2.6 Crash matrix (what a resume does)

| Interrupted during | On disk | Resume |
|---|---|---|
| choosing/extracting/flushing | part files or finished files the journal doesn't list; archive intact | delete them (they're ours: the path was empty or moved aside) and redo the batch |
| committing | the rename happened or not | one of the two neighbouring rows |
| truncating | journal lists the batch, archive longer than `committed_len` | truncate to `committed_len`, continue |
| creating links at the end | all committed | recreate every link (replacing existing); an impossible link stops with everything extracted and is listed |
| deleting archive/side files | archive gone, journal present | recreate links, remove side files |

### 2.2.7 Streaming a large file with hole punching

Applies when the FS can punch (probe: create a 1 MiB scratch file next to the archive, punch it, check allocated blocks dropped — `st_blocks` / `GetCompressedFileSizeW`), the unit holds one file ≥ 512 MiB (2 × STEP) that is Stored or Deflated (ZIP), any tar regular file, or a RAR stored file inside one volume, and its output doesn't fit whole right now.

```
part = open(<dest>.hatchzip-part, create-new)
decoder = Decoder(archive reader at data_start [or at resume.bit with window = last 32 KiB of part], codec)
loop:
    write decoder output to part until ≥ 256 MiB since the last point AND decoder reports a restart point
    (stored: any byte; deflate: next block boundary, position in BITS; obtained via zlib inflate with Z_BLOCK
     and `data_type` bit 6 == 0 ⇒ at a block boundary; restart later with inflatePrime(bits) + inflateSetDictionary(window))
    1. fsync(part) and its directories
    2. journal.resume = { unit: u.start, written: part.len, bit, crc: crc32 so far }; save journal atomically
    3. punch archive [lastPunchedEnd (first time: data_start), bit/8)  — length unchanged, bytes read as zeros
on EOF: check CRC-32 and size; rename part → dest; commit() as usual (the same journal write clears `resume`)
```

Never punch the local/tar header in front of the data. Never punch past the last *durable* point; a point is durable only after the output it vouches for is flushed. Resume: cut `part` back to `resume.written`, restart decoding from `resume.bit` with the window read back from the part file, never read archive bytes before the point. `restore` refuses an archive with a pending resume point. Deflate caveat: an encoder that writes one giant block (zlib level 1 variants) offers no resume point, so nothing is freed until the end.

Hole punch calls: Linux `fallocate(fd, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE, off, len)`; macOS `fcntl(F_PUNCHHOLE, fpunchhole_t)` (block-aligned, shrink inwards; ENOSPC on cloned files ⇒ unsupported); Windows `FSCTL_SET_SPARSE` then `FSCTL_SET_ZERO_DATA` (align inwards to 64 KiB). Node has **no** punch API — use a tiny native addon (N-API) that calls the syscall above; on Android `android.system.Os` has `ftruncate` and `posix_fallocate` but no `fallocate(FALLOC_FL_PUNCH_HOLE)`, so call `fallocate` from NDK/JNI (`libc`); ext4 and f2fs support it. Truncation: Node `fs.ftruncate`, Java `FileChannel.truncate` / `Os.ftruncate`.

### 2.2.8 `.tar.gz` (solid stream, front to back)

First pass (`open`): decode the entire stream once (gzip framing: header flags FTEXT/FHCRC/FEXTRA/FNAME/FCOMMENT; members back to back; each trailer's CRC-32 and ISIZE checked), listing entries for the refusal checks and measuring the space profile (`lead` = max files-ahead-of-consumed-input at any point, `gap` = max output between two consecutive points, `files`, `links`); refuse trailing garbage after the tar end other than zeros, header records > 1 MiB, non-tar gzip, `.tar.zst/.xz/.bz2`. Second pass extracts: every 256 MiB at a restart point (deflate block boundary or member start, not inside a header record): flush files finished since the last point + the open one + dirs; journal `resume.stream = { memberStart?, memberCrc, memberLen, window (64 KiB hex), tarOffset, at: Between | File{written} | Padding | PastEnd }` + links found; punch `[lastPunched, bit/8)` (a run's first punch starts at 0). Archive length stays until the single commit truncates it to 0 and the file is deleted. Resume replays from the point: delete files after the point, cut the open file to its recorded length, decode from the point. Without punching: same stream and points, nothing freed until the end.

### 2.2.9 Restore (undo an in-place extraction)

1. Undo an interrupted restore (`restoring` bytes) and finish a pending truncation so the archive is exactly `committed_len` bytes.
2. Build the new index in memory for the units with `start < committed_len` (ZIP: copy their saved central-directory records verbatim — local header offsets still point at the same bytes — then EOCD / ZIP64 records; 7z: encode a new header for the first N blocks with the library's writer, writing nothing for block data; tar: hard-link entries whose targets are still inside + two 512-byte zero blocks; RAR: an end-of-archive header for the last volume left).
3. Delete uncommitted output; create the journal's links for entries already cut off.
4. Save the journal with `restoring = [[offset, bytes]]` for bytes step 6 will overwrite.
5. Append the index at `committed_len`; flush. 6. Overwrite changed bytes below (7z signature header); flush.
7. Re-open the result with the normal parser and verify it lists exactly the remaining entries; otherwise undo and stop.
8. Move replaced files back (keep-archive: all; in-place: those whose entries were not yet extracted). 9. Delete journal, then tail.

### 2.2.10 Replace / skip / keep both

Journal `replace` written first without `moved` (so a crash before the moves deletes nothing); rename every existing file/link at an entry path into `<out>/.hatchzip-replaced/<rel>` (same FS rename, links moved not followed); flush; save `moved: true`; from then on the run is ordinary. At the end: `keep` paths are renamed back over the extracted file; `both` paths: extracted file renamed to `name (2).ext` (first free), then the kept one renamed back; each step idempotent on resume; the folder is deleted before the journal. Refused: an archive entry named `.hatchzip-replaced` at the root, a pre-existing `.hatchzip-replaced`, too-long replaced paths.

### 2.2.11 Keep archive

Same engine; the storage object is "protected" from the moment the journal (`keep: true`, version 4) is written: `setLen/punch/writeAt/remove` all refuse. Commit still advances `committed_len` as a progress record; truncation skipped; nothing streamed or punched; plan counts every file. On resume the archive must still have its original length. Restore of a kept extraction just discards progress (deletes uncommitted output, journal and tail).

### 2.2.12 Passwords

Order: given/typed password → `check_password()` before anything is deleted: `PasswordCheck::Sample` (ZIP/7z: decode the start of the smallest encrypted unit, writing nothing), `Headers` (RAR 5: derive PBKDF2-HMAC-SHA256 check value for every distinct salt and compare), `WholeUnit` (RAR 4: decode the smallest encrypted file whole; the UI warns when ≥ 64 MiB). Encrypted-header archives (7z, RAR `-hp`) raise `PasswordNeeded` even for listing. Wrong → `WrongPassword` → ask again. Never persisted.

### 2.2.13 Format libraries HatchZip uses → equivalents

| Format | Rust crate (license) | What it is used for | JS/Node equivalent | Java/Kotlin (Android) equivalent |
|---|---|---|---|---|
| ZIP | `zip` 9 (MIT) with `ZipArchive::unsafe_new_with_metadata` (central directory parsed once, shared by workers), features deflate/deflate64/bzip2/lzma/xz/zstd/ppmd/aes | listing, per-entry decode, writing a new central directory on restore | parse the central directory yourself (it's 46-byte records) or `yauzl` for reading; inflate with `zlib.inflateRaw`; bzip2 `seek-bzip`; xz `lzma-native`; zstd `fzstd`/`zstd-codec`; AES-ZIP needs own PBKDF2+AES-CTR (no mainstream lib) | Apache Commons Compress `ZipFile` (random access, Deflate64, bzip2, zstd via zstd-jni, xz via xz-java; no ZipCrypto/AES) or `net.lingala.zip4j` (ZipCrypto + AES, Deflate only); Android `java.util.zip.Inflater(nowrap=true)` for raw deflate |
| Resumable deflate | `libz-rs-sys` 0.6 (Zlib) C API: `inflatePrime`, `inflateSetDictionary`, `inflateGetDictionary`, `Z_BLOCK`, `data_type` bit 6 | restart a deflate stream at a block boundary (zran technique) | Node's `zlib` exposes none of these → compile zlib (or zlib-ng) in a native addon; or `pako` fork (JS inflate where block boundaries and bit position are reachable) | `java.util.zip.Inflater` has `setDictionary` but no bit-level prime/`Z_BLOCK` → JNI to zlib (bundled in the NDK as `libz`) |
| 7z | `sevenz-rust2` 0.24 (Apache-2.0), features aes256/bzip2/deflate/ppmd/zstd (+ LZMA/LZMA2/BCJ built in); `BlockDecoder::new(threads, block, archive, password, reader)` decodes one folder from an arbitrary `Read+Seek`; `ArchiveWriter` for restore headers | per-block decode, pack positions/sizes are public | no complete JS 7z decoder with per-block random access; options: `7z-wasm` (7-Zip compiled to WASM, whole-archive API), or bundle `7zz`/`7za` and drive it by command (`7z x -so` per block isn't exposed → extract per file list from the end) | Apache Commons Compress `SevenZFile` (LZMA/LZMA2/BCJ/Deflate/bzip2/AES; PPMd and Zstd via extra codecs) reads entries sequentially per folder — works for "extract units from the end" since a folder is the unit; `getNextEntry` walks folders in order, so seek by skipping |
| tar | `tar` 0.4 (MIT/Apache) | headers, long names, pax, links | `tar-stream` (streaming; offsets computable since headers are 512-byte blocks) or hand-written parser | Commons Compress `TarArchiveInputStream`; or own parser |
| gzip framing | own (`resumable.rs`) over libz-rs | multi-member gzip, CRC/ISIZE | own over the native inflate | own over JNI inflate |
| RAR | `unrar-ng-sys` =0.7.7 (bindings MIT/Apache; **UnRAR 7.21 C++ source under the UnRAR freeware license**: free to extract, forbidden to build a RAR archiver; ship `LICENSE-UNRAR`), used via the C API with the data callback (`RARProcessFile` + `UCM_PROCESSDATA`); headers (RAR4/RAR5, encrypted ones with `aes`+`cbc`+`pbkdf2`+`sha2`) parsed in Rust | decode only; one handle at a time; serial | `node-unrar-js` (UnRAR compiled to WASM, same license) or spawn the `unrar` binary; headers you parse yourself | `com.github.junrar:junrar` (pure Java, RAR 4 only, no RAR 5 compression, LGPL/… check) or JNI to UnRAR source (same freeware license); libarchive via NDK reads RAR5 (BSD) |
| CRC-32 | `crc32fast` | every file | `zlib.crc32` (Node ≥ 22) / `crc-32` | `java.util.zip.CRC32` |
| FS | `fs4` (available space, locks), `libc`/`windows-sys` (punch, syncfs, F_FULLFSYNC) | space, flush, punch | `fs.statfs`, `fs.fsync`; punch via native addon | `StatFs`, `FileDescriptor.sync()`, JNI `fallocate` |
| parallelism | `rayon` | one thread per unit in a batch | `worker_threads` pool | coroutines over `Dispatchers.IO` / `Executors` |

Platform notes to carry over: Windows symlinks are written as small text files holding the target (like Git without developer mode); hard links copied where the FS has none (FAT32/exFAT); Unix mode restored minus setuid/setgid/sticky; same-disk check by device ID (Unix) or volume prefix of the canonical path (Windows); on Android only your own app dirs and SAF trees are writable — in-place extraction needs a real file path (app-private storage, or `MANAGE_EXTERNAL_STORAGE`/`/sdcard` via `File`), since `ftruncate`/`fallocate` need an fd you own (SAF gives `ParcelFileDescriptor` in `rw` mode — `ftruncate` works through `Os.ftruncate`, `fallocate` PUNCH_HOLE via JNI on the fd; test per device).

---

# Part 3 — What to take for Kurokawa Tools (ranked by value)

1. **Prism's segment table**: `{start,pos,end,reqEnd,written}` partition, acquire = unowned → split largest at the 4 KiB-aligned midpoint (or behind the victim's in-flight request) when ≥ 2 × 1 MiB remains → race a slow tail (ETA > 3 s and > 4× median peak rate); `advance()` accepting only up to the (possibly shrunk) end; durable states from `written`. This is the whole multi-connection engine for Android (OkHttp) and Electron (undici) in ~400 lines.
2. **Crash-safe resume**: positioned writes into `<name>.part`, checkpoint = flush → fsync → snapshot (every 2 s and on pause), `ResumeState` JSON, `If-Range` with strong ETag else Last-Modified, 64 KiB overlap compare when no validators, part-length check, restart on mismatch with a user prompt.
3. **HatchZip's in-place extraction engine for ZIP/tar/7z**: units from the end, saved tail, journal with `committed_len`, batch = extract → fsync → verify → journal → truncate, the crash matrix, the "will it fit" replay with a 2 GB reserve, Extract-here single-root rule, never-overwrite + replace-by-rename. On a phone with 10 GB free and a 6 GB archive this is the difference between working and failing. Start with ZIP (stored/deflate) and tar; add 7z via Commons Compress folders; RAR via UnRAR/junrar last.
4. **Probe-by-GET (`Range: bytes=0-4194303`) + web-page/robot-check detection** (`text/html` < 2 MiB for a binary name; `cf-mitigated: challenge`) + "try the link first" before taking a download away from a WebView — prevents saving error pages as files.
5. **Server-aware connection limits and retry policy**: 429/503/403-after-probe/double connect failure → clamp to connected count, learn per host for 24 h, probe up 20 s→300 s doubling, ≥ 300 s after Retry-After; backoff `0.5 s·2ⁿ` cap 30 s with equal jitter, resets on progress; bounded 4–16 MiB requests (10 MiB for googlevideo).
6. **Queues + crossing-based scheduler + post actions**: per-queue concurrency and limiter, ISO-weekday/once-date schedules, 30-minute catch-up after sleep, "when finished" actions with a 30 s cancellable countdown, no action for an empty queue, built-in "One at a time" queue for playlists.
7. **Media sniffing classifier + stream downloader (HLS/DASH)**: the MIME/extension tables, identity key stripping range params, segment-vs-manifest rule, per-segment files with fsync+rename for resume, AES-128 IV rule, `ffmpeg -c copy` remux with raw fallback — directly usable inside Kurokawa's in-app browser/WebView.
8. **yt-dlp model**: `-J --flat-playlist` probe → one choice per (height, HDR) with codec/container preferences → accelerate progressive formats with our engine using yt-dlp's `http_headers` → ffmpeg mux/embeds → yt-dlp fallback on 403; managed binaries verified against same-tag checksum files; progress templates `PRISM %(progress)j`.
9. **Categories, clipboard monitor, batch patterns, remote ZIP peek**: custom-wins classification with the built-in extension lists; clipboard change-counter polling with concealed-content exclusion and magnet support; `[001-100:2]` cartesian expansion capped at 10,000; central-directory-over-ranges listing with single-entry extraction (also the seed of HatchZip-style unit lists for downloaded ZIPs — the same parser serves both).
10. **UI patterns**: details view with file map + per-connection lanes + 60 s speed graph; Download File sheet that opens instantly and updates from the probe; completion sheet with Open / Show / Convert / Make smaller; HatchZip's space-plan panel ("available / needs / required (+reserved) / after"), per-file Replace/Skip/Keep-both prompt, "Restore archive" for abandoned extractions, and progress that never sits silent ("Reading archive… 37%").
11. HatchZip's **streaming with hole punching** for one huge file (256 MiB steps, deflate block-boundary resume points, window from the part file) — valuable on Android (ext4/f2fs punch) once item 3 works; requires JNI/native `fallocate`.
12. **Hierarchical GCRA limiters** `[download, queue, global]` (64 KiB reservations, 250 ms burst credit) and the EWMA (τ 2 s) speed meter.
13. **File-name derivation/sanitising and conflict naming**, free-space checks before allocation, sparse/`fallocate` pre-allocation.
14. **Site grabber** (config schema, BFS with scope rules, streamed results, HEAD size pass) and **Hugging Face downloader** (API, GGUF preference, commit-pinned URLs, token only on `/resolve/`) — lower priority for a reader-adjacent tools app.
15. **Browser-extension bridge** (native messaging host → loopback HTTP with bearer token, `ipc.json`, auto-launch, fail-open, the v1 message set) — only if Kurokawa Tools ships a desktop extension; the protocol table in §1.2.16 is complete enough to implement against.
16. **Post-download hooks**: antivirus command (`{file}` placeholder), checksum verification, completion sounds, notifications; HatchZip's **`.sfv` pre-check** and **`--verify-first`** for archives that can't be re-downloaded.
