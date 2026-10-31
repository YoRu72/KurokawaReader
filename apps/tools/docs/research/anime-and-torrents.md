# Anime & torrent ecosystem research for Kurokawa Tools

Research date: 2026-10-31. Everything below was read from source code cloned under
`/tmp/claude-0/-home-claude/31db5f1c-a6c2-54e2-a5c4-2730cae2d727/scratchpad/ref/`:

| Project | Local path | Version read |
|---|---|---|
| Seanime (5rahim/seanime, sparse) | `ref/seanime/` | v3.10.4 (`internal/constants`) |
| Seanime official extensions / marketplace | `ref/ext/seanime-extensions/` | main |
| Seanime community extensions | `ref/ext/animetosho-provider/`, `ref/ext/seanime-mikan-provider/`, `ref/ext/Seanime-Marketplace/`, `ref/ext/Seanime-Providers/` | main |
| Hayase interface (hayase-app/interface) | `ref/ext/hayase-interface/` | ui 6.5.25 |
| Hayase torrent client (hayase-app/torrent-client) | `ref/ext/hayase-torrent-client/` | main |
| Hayase example extension (hayase-app/free-torrents) | `ref/ext/hayase-free-torrents/` | 0.0.2 |
| Hayase community extensions (tanzim2000/hayase-extension) | `ref/ext/tanzim2000_hayase-extension/` | 2.1.0 |
| Senpwai (SenZmaKi/Senpwai, Flutter v3) | `ref/Senpwai/` | master |
| Torrentio addon (TheBeastLT/torrentio-scraper, Rust rewrite) | `ref/ext/torrentio-scraper/addon/` | manifest 0.0.15 |

Live endpoints were probed on the research date (AniList GraphQL, torrentio.strem.fun, livechart.me RSS,
api.ani.zip, arm.haglund.dev, releases.moe). Where a payload is marked "live", it was copied from the
actual response.

Context: Kurokawa Tools is a TypeScript web UI shipped in Capacitor (Android) and Electron (desktop), with
an existing AniList link (OAuth token + GraphQL client) that must be reused.

---

## 1. Seanime

### 1.1 Features (exhaustive, user-facing)

Source: `README.md`, `CHANGELOG.md`, `internal/*` package list.

Architecture: Go server (`internal/`) + React web UI (`seanime-web/`, Rsbuild + TanStack Router) +
Electron desktop ("Denshi") with libmpv built-in player ("MpvCore") + iOS/Android companion ("Tenji").
AniList is the only tracker (MAL/Trakt/SIMKL explicitly "not planned"; trackers can be extensions, see
`hibike/tracker`). No built-in localization.

**Library**
- Scan local folders without strict naming; multi-layer matcher (`internal/library/scanner/matcher.go`):
  exact → normalized → token → fuzzy (efficient Sørensen–Dice, `efficient_dice.go`), with season/part/year
  extraction, format score (special vs main), synonym handling, "media tree analysis" (walks AniList
  relations to collect candidate seasons), hydration of episode numbers (absolute → relative via AniDB
  offsets from `api.ani.zip` "animap" metadata), filename parsing via `habari` (Go anitomy port,
  `internal/vendor_habari`).
- Auto-scanner (filesystem watcher, `internal/library/autoscanner`), library explorer, manual match,
  ignore rules, unmatched file resolution, "missing episodes" list, "missed sequels" list, library stats.
- Playlists (up to 200 episodes), continuity (resume positions, `internal/continuity`), watch history.
- Offline mode (`internal/offline`, `platforms/offline_platform`): snapshot of collection + metadata + images.
- Custom sources (non-AniList media) via extensions (`custom-source`), IDs ≥ 2^31 with embedded extension id.

**Torrents**
- Torrent search engine via extensions (`anime-torrent-provider`), two modes: *smart search* (media-aware:
  batch / episode / resolution / best releases / AniDB ids) and *simple* (free query). Per-provider caches
  (`internal/torrents/torrent/search.go`: 1 min miss TTL, 5 min TTL for releasing media). Previews map
  torrent → episode via habari parse.
- Torrent "analyzer" (`internal/torrents/analyzer`): downloads metadata, maps files to episodes.
- "Auto select" (`internal/torrents/autoselect`): picks best torrent automatically for streaming
  (language parsing, resolution preference, seeders).
- Availability badges (`internal/torrents/availability`): recently released episodes marked if a torrent exists.
- Torrent clients: qBittorrent (WebUI API), Transmission (RPC), built-in client (anacrolix/torrent, "classic
  file-based downloading"), plus debrid "clients" (TorBox, Real-Debrid, AllDebrid, Premiumize) for downloading.
- **Auto Downloader** (`internal/library/autodownloader`): polls provider `getLatest()` (RSS-like) every N
  minutes (default 20, min 15), rules + profiles (global or per-rule), conditions with score/block/require,
  delay minutes + skip-delay score, min seeders/size, providers whitelist, episode type (recent/selected),
  title comparison (contains/likely), additional/exclude terms, custom absolute episode offset. See 1.3.
- Torrent streaming (`internal/torrentstream`): built-in anacrolix client, piece prioritisation, served over
  HTTP to MPV/VLC/MPC-HC/IINA/built-in player; batch file selection; autoplay next episode;
  "directstream" (`internal/directstream`) for faster seeking.
- Debrid streaming & downloading (`internal/debrid`): **Real-Debrid, AllDebrid, TorBox, Premiumize**
  (interface in 1.3). Instant-availability check, stream URL resolution, local download of debrid files.

**Streaming / Playback**
- Online streaming via extensions (`onlinestream-provider`): provider → episode list → servers → video
  sources (mp4/m3u8) + subtitles + headers; HLS quality memory, provider fallback/recovery.
- Media players: MPV (IPC), VLC (HTTP interface), MPC-HC (web interface), IINA, built-in web player
  ("VideoCore": hls.js, JASSUB subtitles, Anime4K shaders, deband, volume boost 300%, speed slider,
  chapter skip patterns), MpvCore (libmpv in Electron, mpv.conf options & shaders), mobile players via
  intents/deep links (Outplayer, VLC).
- Playback tracking (`internal/library/playbackmanager`): progress watched → AniList progress update,
  next-episode autoplay, "Nakama" watch parties (peer relay, `internal/nakama`).
- Transcoding & direct play (`internal/mediastream`: ffmpeg transcoder, embedded font extraction, PGS
  subtitle conversion `internal/pgs`, matroska parser).

**Manga**
- Manga reader (local folders incl. PDF, or extensions `manga-provider`), chapter download
  (`internal/manga/downloader`), source refresh / find alternatives across providers, image proxy with headers.

**Discovery / AniList**
- Browse/search/discover anime & manga, lists management, schedule (upcoming + missed episodes),
  filters (last added/updated), studio details, "InSight" character data (Tenrai), trailer,
  AniList rate-limit retry on 429 only.

**Misc**
- Discord Rich Presence (`internal/discordrpc`, custom activities via plugins), system notifications,
  auto-update (`internal/updater`, GitHub releases), issue recorder (rrweb), DoH resolver (`internal/doh`),
  UI themes/background images/layouts, Sea-Command palette, tour, extension marketplace + playground.

**Extension system** (types): `anime-torrent-provider`, `manga-provider`, `onlinestream-provider`,
`custom-source`, `plugin` (+ `tracker` interface exists in `hibike/tracker` but is not yet in the
`Type` enum). Languages: `javascript`, `typescript`, `go` (Go only for built-ins; the only built-in left in
v3.10.4 is the Local manga provider – Nyaa/AnimeTosho/SeaDex built-ins were removed and now live as
marketplace extensions).

### 1.2 Formats / APIs

#### 1.2.1 Extension manifest (`internal/extension/extension.go`)

A manifest is a JSON object. The same struct is used in the marketplace list and in the installed-extension
record.

```jsonc
{
  "id": "seanime-mikan-provider",        // REQUIRED. Unique; must start with a letter, alphanumeric (+ '-' '_' in practice)
  "name": "Mikan Smart Provider",         // REQUIRED, max 50 chars
  "version": "1.0.6",                     // REQUIRED, basic semver "X.Y.Z"
  "semverConstraint": ">=3.0.0",          // optional, constraint on Seanime version
  "manifestURI": "https://raw.githubusercontent.com/roogue/seanime-mikan-provider/refs/heads/main/seanime-mikan-provider.json",
                                          // REQUIRED for external; "builtin" for built-ins; "" for local dev
  "language": "typescript",               // REQUIRED: "javascript" | "typescript" | "go"
  "type": "anime-torrent-provider",       // REQUIRED: "anime-torrent-provider" | "manga-provider" | "onlinestream-provider" | "custom-source" | "plugin"
  "description": "…",
  "author": "roogue",                     // REQUIRED, max 25 chars
  "icon": "https://…/mikan-icon.png",
  "website": "https://…",
  "readme": "https://…/README.md",        // URL to readme (rendered in UI)
  "notes": "",                            // arbitrary text (guide/changelog)
  "lang": "zh",                           // ISO 639-1 of the CONTENT; "multi" (or "all") for many; default "en"
  "permissions": [],                      // NOT IMPLEMENTED
  "userConfig": { … },                    // optional, see below
  "payload": "…",                         // inline source code (alternative to payloadURI)
  "payloadURI": "https://raw.githubusercontent.com/…/index.ts", // remote code; REQUIRED if payload empty
  "plugin": { … },                        // only for type "plugin", see below
  "isDevelopment": false                  // true = load code from local payloadURI path; cannot be installed remotely
}
```

Sanity check (`extension_repo/utils.go: manifestSanityCheck`): `id,name,version,language,type,author`
non-empty; `payload` or `payloadURI` set; id valid; name ≤ 50; author ≤ 25; semver valid; language/type in
enums; plugin manifest valid; `lang` lower-cased.

Install flow (`extension_repo/external.go`): GET `manifestURI` (10 s timeout) → decode JSON → if
`payloadURI` GET it (10 s) and store into `payload` → sanity check → refuse if `isDevelopment` → saved as a
JSON file in the extensions dir. Updates: re-fetch manifest, compare `version`. Development mode: payload
re-read from disk on reload.

**userConfig** (generates a settings form; values are strings):

```jsonc
"userConfig": {
  "version": 1,                 // bump to invalidate saved values
  "requiresConfig": false,      // true = extension disabled until user saves config
  "fields": [
    { "type": "text",   "name": "preferred_subgroups", "label": "Preferred Subtitle Group IDs", "default": "" },
    { "type": "switch", "name": "use_proxy", "label": "Use proxy", "default": "false" },
    { "type": "select", "name": "quality", "label": "Quality", "default": "1080",
      "options": [ { "value": "1080", "label": "1080p" }, { "value": "720", "label": "720p" } ] }
  ]
}
```
Saved as `{ "version": 1, "values": { "<name>": "<string>" } }`; read in code via
`$getUserPreference(name)` (returns saved value, else field `default`, else `undefined`).

**plugin manifest** (type `plugin` only; `internal/extension/plugin.go`):

```jsonc
"plugin": {
  "version": "1",
  "permissions": {
    "scopes": ["storage","database","playback","debrid","anilist","anilist-token","custom-client",
               "system","cron","notification","discord","torrent-client","auth","extensions","settings"],
    "allow": {
      "networkAccess": { "allowedDomains": ["raw.githubusercontent.com", "*.example.com", "*"],
                         "reasoning": "required when allowedDomains contains \"*\"" },
      "unsafeFlags": [ { "flag": "dom-script-manipulation" | "dom-link-manipulation", "reason": "…" } ],
      "readPaths":  ["$SEANIME_ANIME_LIBRARY", "$HOME", "$CACHE", "$TEMP", "$CONFIG", "$DOWNLOAD", "$DESKTOP", "$DOCUMENT"],
      "writePaths": ["$DOWNLOAD/foo"],
      "commandScopes": [ { "description": "…", "command": "ffmpeg",
                           "args": [ { "value": "-i" }, { "validator": "$PATH" }, { "validator": "$ARGS" } ] } ]
    }
  }
}
```
A sha256 hash of the permissions is stored on grant; a change re-prompts the user. Unsafe flags disable
auto-update. Plugins cannot be installed through a `{urls:[…]}` repository (only one-by-one or via
marketplace).

Real plugin example (`ref/ext/Seanime-Marketplace/Plugin/Marketplace-Plus.json`):
```json
{ "id": "Marketplace-Plus", "name": "Marketplace+", "version": "1.2.2",
  "manifestURI": "https://raw.githubusercontent.com/Bas1874/Seanime-Marketplace/refs/heads/main/Plugin/Marketplace-Plus.json",
  "language": "javascript", "type": "plugin", "author": "bas1874", "lang": "multi",
  "payloadURI": "https://raw.githubusercontent.com/Bas1874/Seanime-Marketplace/refs/heads/main/Plugin/Marketplace-Plus.js",
  "isDevelopment": false,
  "plugin": { "version": "1", "permissions": { "scopes": ["storage","settings","extensions"],
     "allow": { "networkAccess": { "allowedDomains": ["raw.githubusercontent.com"], "reasoning": "Fetches extension metadata…" } } } } }
```

#### 1.2.2 Marketplace & repository JSON

- **Marketplace** (`extension_repo/marketplace.go`): a URL returning a **JSON array of manifest objects**
  (same `Extension` shape, usually without `payload`/`payloadURI`). Entries without `id` or `manifestURI`
  are dropped. Default URL (base64 in `constants`):
  `https://raw.githubusercontent.com/5rahim/seanime-extensions/refs/heads/main/marketplace.json`.
  Plugins may change the marketplace URL (v3.10.3). Entry example (live file):
  ```json
  { "id": "custom-banner-images", "name": "Custom Banner Images",
    "description": "Customize the banner images of anime and manga in your AniList collection.",
    "author": "Seanime",
    "manifestURI": "https://raw.githubusercontent.com/5rahim/seanime-extensions/main/plugins/custom-banner-images/custom-banner-images.json",
    "icon": "https://raw.githubusercontent.com/5rahim/seanime-extensions/main/plugins/custom-banner-images/icon.png",
    "type": "plugin", "language": "typescript", "lang": "multi",
    "website": "https://github.com/5rahim/seanime-extensions" }
  ```
  Community marketplaces add non-standard fields that Seanime ignores but the Marketplace+ plugin reads
  (`ref/ext/Seanime-Marketplace/Marketplace/Main.json`): `flags` ("0/61" VirusTotal), `flaggedBy`,
  `permalink`, `timestamp`, `hadWorkingTag`, `lastWorkingVersion`, `status` (Working/Broken/Deprecated),
  `stars`, `tags` (sub/dub), `support` (Discord URL).
- **Repository** (`InstallExternalExtensions`): either a URL or an inline JSON string of the form
  `{ "urls": ["https://…/manifest-a.json", "https://…/manifest-b.json"] }`. Each manifest is fetched in
  parallel; plugins are skipped; `install=true` installs all.
- Single-extension install: just the manifest URL.

#### 1.2.3 Runtime: how a JS/TS provider is executed (`extension_repo/goja_base.go`, `goja.go`)

- Engine: **goja** (Go ECMAScript 5.1+ interpreter with ES2018 features). TypeScript is transpiled with
  **esbuild** (`api.Transform`, `Target: ES2018, Loader: TS, MinifyWhitespace+Syntax`) — type-only, no
  bundling, no `import`. Code is compiled once (`goja.Compile`) and run in a **pool of VMs** per extension.
- Contract: the payload must define a **global class named `Provider`**. For each call Seanime does
  `typeof Provider` (runs program if undefined) → `new Provider()` → calls the method by name with the
  options object (struct → camelCase map) → awaits if a Promise → unmarshals the result into the Go type.
  Methods: torrent `search|smartSearch|getTorrentInfoHash|getTorrentMagnetLink|getLatest|getSettings`;
  manga `search|findChapters|findChapterPages|getSettings`; onlinestream
  `search|findEpisodes|findEpisodeServer|getSettings`; custom-source as in 1.2.5. Every call creates a new
  instance, so instance fields do not persist; use `$store` for in-memory state.
- **Globals available to providers** (`ShareBinds` + `BindFetch` + `BindUserConfig`; typed in
  `goja_plugin_types/core.d.ts`):
  - `fetch(url, { method, headers, body, noCloudflareBypass, redirect, timeout(s, default 35) })` →
    `Promise<FetchResponse>`; response has `status, statusText, ok, url, headers, rawHeaders, cookies,
    redirected, contentType, contentLength` and **synchronous** `text(): string`, `json<T>(): T`
    (`await res.json()` also works). Goes through Go HTTP client with an optional Cloudflare bypass.
  - DOM scraping: `LoadDoc(html) → (selector) => DocSelection` and `new Doc(html)`; `DocSelection` is a
    goquery/cheerio-like API: `attr, attrs, children, closest, contents, contentsFiltered, data, each,
    end, eq, filter, find, first, has, text, html, is, last, length(), map, next, nextAll, nextUntil, not,
    parent, parents, parentsUntil, prev, prevAll, prevUntil, siblings`.
  - `$habari.parse(filename) → Metadata` (anitomy fields: `title, formatted_title, episode_number[],
    season_number[], part_number[], release_group, video_resolution, audio_term[], video_term[], source[],
    subtitles[], language[], file_checksum, file_extension, year, anime_type[] …`).
  - `$goFeed.parse(xml)` RSS/Atom → `{ items:[{ title, link, published, enclosures:[{url,length}] }] }`.
  - `CryptoJS` (AES encrypt/decrypt, `enc.Utf8/Base64/Hex/Latin1/Utf16/Utf16LE`), `crypto`, `Buffer`,
    `url`, `formData`, `console`, `ChromeDP` (headless Chrome: `scrape/screenshot/evaluate/newBrowser`).
  - `$torrentUtils.getMagnetLinkFromTorrentData(b64)`.
  - `$scannerUtils.{normalizeTitle, extractSeasonNumber, extractPartNumber, extractYear, compareTitles,
    findBestMatch, getSignificantTokens, buildSearchQuery, buildAdvancedQuery, sanitizeQuery,
    buildSeasonQuery, buildPartQuery, buildSmartSearchTitles}` – title normalization helpers,
    e.g. `buildSeasonQuery("Overlord", 2) → "(Overlord S02 | Overlord Season 2 | Overlord 2nd Season)"`.
  - `$store` (in-memory per extension: `set/get/getUnsafe/has/getOrSet/setIfLessThanLimit/reset/values/
    getAll/watch/marshalJSON/unmarshalJSON`), `$getUserPreference(key)`, `$sleep(ms)`, `$await`,
    `$replace`, `$clone`, `$toString`, `$toBytes`, `$unmarshalJSON`, `$isOffline()`, `$shared.define/use`.
  - Plugins additionally get `$storage` (persistent KV: `set/get/getUnsafe/remove/drop/clear/keys/has`),
    `$anilist` (list/collection/entry mutations, token), `$database` (localFiles, autoDownloader rules /
    profiles / items, silenced media, filler), `$app` (version, invalidateClientQuery + **111 hooks**
    `$app.onXxx` such as `onAnimeEntryRequested`, `onAutoDownloaderBeforeDownloadTorrent`,
    `onTorrentSearch…`, `onScanCompleted`, `onDiscordPresenceAnimeActivityRequested`…), `$ui.register(ctx => …)`
    (tray, screen navigation, toast, actions/menu items, DOM manipulation, playback, mpv, notifications,
    manga/anime/discord/continuity/autoScanner/autoSelect/torrentSearch APIs, command palette), `$os`,
    `$filepath`, `$osExtra`, `$downloader`, `$mime`, `$io`, `$cron`, `$debug`.

#### 1.2.4 Anime torrent provider API (exact, `hibike/torrent/types.go` and `goja_torrent_test/anime-torrent-provider.d.ts`)

```ts
declare type AnimeProviderSmartSearchFilter = "batch" | "episodeNumber" | "resolution" | "query" | "bestReleases"
declare type AnimeProviderType = "main" | "special"   // "special" (e.g. adult-only) cannot be default and must return [] from getLatest

declare interface AnimeProviderSettings {
    canSmartSearch: boolean
    smartSearchFilters: AnimeProviderSmartSearchFilter[]
    supportsAdult: boolean
    type: AnimeProviderType
}

declare interface Media {                 // built by Seanime from AniList
    id: number                            // AniList id
    idMal?: number
    status?: string                       // FINISHED | RELEASING | NOT_YET_RELEASED | CANCELLED | HIATUS (defaults NOT_YET_RELEASED)
    format?: string                       // TV | TV_SHORT | MOVIE | SPECIAL | OVA | ONA | MUSIC (defaults TV)
    englishTitle?: string
    romajiTitle?: string
    episodeCount?: number                 // -1 if unknown
    absoluteSeasonOffset?: number         // 0 if not seasonal/unknown (from AniDB mapping)
    synonyms: string[]
    isAdult: boolean
    startDate?: { year: number; month?: number; day?: number }
}

declare interface AnimeSearchOptions { media: Media; query: string }

declare interface AnimeSmartSearchOptions {
    media: Media
    query: string          // "" unless filter "query" supported
    batch: boolean         // false unless "batch" supported
    episodeNumber: number  // 0 unless "episodeNumber" supported
    resolution: string     // "" | "1080" | "720" | "540" | "480"  (hibiketorrent.Resolutions)
    anidbAID: number       // AniDB anime id (0 if unknown)
    anidbEID: number       // AniDB episode id (0 if unknown)
    bestReleases: boolean
}

declare interface AnimeTorrent {
    name: string
    date: string            // RFC3339 "2006-01-02T15:04:05Z07:00"
    size: number            // bytes
    formattedSize: string   // "" => Seanime formats
    seeders: number
    leechers: number
    downloadCount: number
    link: string            // torrent page URL
    downloadUrl: string     // .torrent URL or ""
    magnetLink?: string     // "" if it must be scraped later
    infoHash?: string       // "" if it must be scraped later
    resolution?: string     // "1080p"
    isBatch?: boolean       // else parsed from name
    episodeNumber?: number  // -1 => Seanime parses the name
    releaseGroup?: string   // "" => parsed from name
    isBestRelease: boolean
    confirmed: boolean      // true when found via AniDB ids (skips title verification)
    // provider: string     // set by Seanime to the extension id
}

declare interface AnimeTorrentProvider {
    search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]>
    smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]>
    getTorrentInfoHash(torrent: AnimeTorrent): Promise<string>    // return torrent.infoHash if already present
    getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string>  // return torrent.magnetLink if present
    getLatest(): Promise<AnimeTorrent[]>                          // used by Auto Downloader (RSS equivalent)
    getSettings(): AnimeProviderSettings
}
```
Go side also defines `AnimeTorrentFile { index, path, name, episodeNumber }` and `BatchEpisodeFiles`
(used by the analyzer, not by providers).

How Seanime calls it (`internal/torrents/torrent/search.go`): the UI sends
`{ provider, type: "smart"|"simple", media, query, batch, episodeNumber, bestReleases, resolution,
includeSpecialProviders, skipPreviews }`; Seanime fills `anidbAID/anidbEID` from ani.zip metadata and
`absoluteSeasonOffset`; "main" providers without `canSmartSearch` error on smart requests, "special"
providers fall back to simple search with `CleanMediaTitle(romaji)`; results are run through habari to build
episode previews; results cached per provider+media+filters.

**Real example 1** (`ref/ext/animetosho-provider/animetosho.ts`, TypeScript, 400 lines):
```ts
/// <reference path="./anime-torrent-provider.d.ts" />
const BASE_URL = "https://feed.animetosho.org/json"
const ARM_URL = "https://arm.haglund.dev/api/v2/ids"                       // AniList -> AniDB id
const ZENSHIN_URL = "https://zenshin-supabase-api.onrender.com/mappings"   // AniList -> AniDB episode ids
class Provider {
  async getLatest() { const res = await fetch(BASE_URL); const data = await res.json(); return this.mapEntries(data, false) }
  async search(o: AnimeSearchOptions) { const res = await fetch(`${BASE_URL}?q=${encodeURIComponent(o.query)}&qx=1`); … }
  async smartSearch(o: AnimeSmartSearchOptions) {
    // resolve AniDB aid via arm, episode eid via zenshin; then
    // single:  `${BASE_URL}?eid=${anidbEid}${qualityFilter}` or `?aid=${anidbId}` + filter by episode
    // batch:   `${BASE_URL}?order=size-d&aid=${anidbId}${qualityFilter}`
    // movie:   `${BASE_URL}?aid=${anidbId}${qualityFilter}`
    // fallback text: `?q=${encodeURIComponent(`${title} ${ep}`)}&qx=1`
    // qualityFilter = `&qx=1&q=("${resolution}"+!"other"+!"res")`
  }
  async getTorrentInfoHash(t: AnimeTorrent) { return t.infoHash || "" }
  async getTorrentMagnetLink(t: AnimeTorrent) { return t.magnetLink || "" }
  getSettings(): AnimeProviderSettings { return { canSmartSearch: true, smartSearchFilters: ["batch","episodeNumber","resolution"], supportsAdult: false, type: "main" } }
}
```
AnimeTosho JSON feed fields used: `title, torrent_name, magnet_uri, torrent_url, info_hash, total_size,
seeders, leechers, torrent_downloaded_count, timestamp, num_files, anidb_fid`.

**Real example 2** (`ref/ext/seanime-mikan-provider/index.ts`): RSS via
`https://mikanani.me/RSS/Search?searchstr=<q>` parsed with `$goFeed.parse(response.text())`; maps
`item.enclosures[0].url/length`, sets `episodeNumber: -1`, `confirmed: false`; smart search maps AniList →
Bangumi → Mikan id using `https://raw.githubusercontent.com/xiaoyvyv/bangumi-data/main/data/mikan/bangumi-mikan.json`;
userConfig field `preferred_subgroups` read via `$getUserPreference`.

#### 1.2.5 Other provider APIs (exact)

**Online streaming** (`hibike/onlinestream/types.go`):
```ts
interface Provider {
  search(opts: { media: Media /* same as torrent Media minus absoluteSeasonOffset */; query: string; dub: boolean; year: number }): Promise<SearchResult[]>
  findEpisodes(id: string): Promise<EpisodeDetails[]>
  findEpisodeServer(episode: EpisodeDetails, server: string /* "default" or one of settings.episodeServers */): Promise<EpisodeServer>
  getSettings(): { episodeServers: string[]; supportsDub: boolean }
}
interface SearchResult   { id: string; title: string; url: string; subOrDub: "sub" | "dub" | "both" }
interface EpisodeDetails { provider: string; id: string; number: number; url: string; title?: string }
interface EpisodeServer  { provider: string; server: string; headers: Record<string,string>; videoSources: VideoSource[] }
interface VideoSource    { url: string; type: "mp4" | "m3u8" | "unknown"; label?: string; quality: string /* "default"|"auto"|"1080p" */; subtitles: { id: string; url: string; language: string; isDefault: boolean }[] }
```

**Manga** (`hibike/manga/types.go`):
```ts
interface Provider {
  search(opts: { query: string; year: number }): Promise<SearchResult[]>
  findChapters(id: string): Promise<ChapterDetails[]>
  findChapterPages(id: string): Promise<ChapterPage[]>
  getSettings(): { supportsMultiScanlator: boolean; supportsMultiLanguage: boolean }
}
interface SearchResult   { provider: string; id: string; title: string; synonyms?: string[]; year?: number; image?: string; imageHeaders?: Record<string,string>; searchRating?: number /* 0..1 */ }
interface ChapterDetails { provider: string; id: string /* may embed keys with "$" e.g. "one-piece-001$chapter-1$en" */; url: string; title: string /* "Chapter X.Y - title" */; chapter: string; index: number; scanlator?: string; language?: string; rating?: number; updatedAt?: string /* YYYY-MM-DD */; localIsPDF?: boolean }
interface ChapterPage    { provider: string; url: string; index: number; headers: Record<string,string> }
```

**Custom source** (`hibike/customsource/types.go`, Go-typed, returns AniList-shaped objects):
`getExtensionIdentifier(): number`, `getSettings(): { supportsAnime, supportsManga }`,
`getAnime(ids: number[])`, `listAnime(search, page, perPage) → { media, page, totalPages, total }`,
`getAnimeWithRelations(id)`, `getAnimeMetadata(id)`, `getAnimeDetails(id)`, `getManga(ids)`,
`listManga(...)`, `getMangaDetails(id)`. IDs ≥ 2^31 with embedded extension identifier; `siteUrl` is
`"ext_custom_source_{extId}|END|https://…"`.

**Tracker** (`hibike/tracker/types.go`, preview): `Settings { supportsAnime, supportsManga,
supportsBidirectionalSync, maxRequestsPerSecond, cacheVersion }`, `MediaEntry { source, mediaId, malId,
externalId, mediaType, status, score(0-100), progress, repeat, startedAt, completedAt, updatedAt }`.

#### 1.2.6 Debrid provider interface (`internal/debrid/debrid/debrid.go`)

```go
type Provider interface {
    GetSettings() Settings                                   // { id, name }
    Authenticate(apiKey string) error
    AddTorrent(opts AddTorrentOptions) (string, error)       // { magnetLink, infoHash, selectFileId /* RD only: id, ids or "all" */ } -> torrent id
    GetTorrentStreamUrl(ctx, opts StreamTorrentOptions, itemCh chan TorrentItem) (string, error) // { id, fileId } blocks until ready
    GetTorrentDownloadUrl(opts DownloadTorrentOptions) (string, error)  // { id, fileId }
    GetInstantAvailability(hashes []string) map[string]TorrentItemInstantAvailability // hash -> { cachedFiles: { [fileId]: { size, name } } }
    GetTorrent(id string) (*TorrentItem, error)
    GetTorrentInfo(opts GetTorrentInfoOptions) (*TorrentInfo, error)   // { magnetLink, infoHash } -> { id?, name, hash, size, files[] }
    GetTorrents() ([]*TorrentItem, error)
    DeleteTorrent(id string) error
}
// TorrentItem: id, name, hash, size, formattedSize, completionPercentage, eta, status(downloading|completed|seeding|error|stalled|paused|other), added(RFC3339), speed, seeders, isReady, files[{id,index,name,path,size}]
```
Implementations: `realdebrid`, `alldebrid`, `torbox`, `premiumize` (+ `dummy` for tests).

### 1.3 Implementation notes

- **Auto Downloader data model** (`internal/library/anime/autodownloader_types.go`):
  ```ts
  Rule { dbId, enabled, mediaId, destination, profileId?, releaseGroups?[], resolutions?[], episodeNumbers?[],
         episodeType: "recent"|"selected", comparisonTitle, titleComparisonType: "contains"|"likely",
         additionalTerms[], excludeTerms[], minSeeders, minSize, maxSize, customEpisodeNumberAbsoluteOffset?, providers[] }
  Profile { dbId, name, global, releaseGroups?[], resolutions[] /* ordered */, conditions[], minimumScore,
            minSeeders?, minSize?, maxSize?, delayMinutes, skipDelayScore, providers[] }
  Condition { id, term, isRegex, action: "score"|"block"|"require", score }
  ```
  Loop: ticker every `settings.Interval` minutes (≥15, default 20) → `getLatest()` on each provider →
  parse names with habari → match rules → score with profile conditions → delay queue → add to torrent
  client (or debrid) → mark item downloaded.
- Title matching helper in Go `util/comparison` (Dice/Levenshtein/Jaro-Winkler) mirrors `$scannerUtils`.
- Seanime's "smart search" protocol (media object + filters, provider returns typed torrents with
  `confirmed`/`isBatch`/`episodeNumber` hints and lets the host parse the rest) is the most complete design
  among the three apps and maps 1:1 to what a TypeScript host can implement with anitomy-like parsing.
- Hosting model: everything runs server-side in Go; the web UI never touches providers. For Kurokawa,
  provider code would run in the renderer/webview with a sandbox (Web Worker) instead of goja.

---

## 2. Hayase (formerly Miru)

### 2.1 Features (from `hayase-app/interface` modules, routes and settings defaults)

Architecture: SvelteKit UI (`interface`, BUSL-1.1), Electron wrapper (`electron`), Capacitor wrapper
(`capacitor`, Android/iOS), native IPC schema (`native`), `torrent-client` (WebTorrent fork
`thaunknown/webtorrent#aio`, `bittorrent-dht`, `bittorrent-tracker`, NAT-PMP/UPnP, mDNS/LSD, DLNA,
Chromecast, NZB (`nzb-parser`, `nzb-file`), HTTP webseeds, EBML/matroska parsing for attachments &
metadata). Routes: `home, search, schedule, anime/[id], player, w2g (watch-together), chat (IRC via
@thaunknown/web-irc), extensions, settings, profile, client, debug, license, update, authorize, setup, local`.

- **Torrent streaming**: WebTorrent, sequential/streamed download (`torrentStreamedDownload`), stores only
  one torrent unless `torrentPersist`, seeds while open (upload forced ≥1.5× download), DHT/PeX toggles,
  port, max connections (80) / connection budget (500), speed cap (`torrentSpeed` MB/s), background downloads,
  Local Service Discovery for LAN sharing, per-torrent file picker, peer list, tracker stats, library of
  cached torrents.
- **Search & auto-select**: `searchQuality` (2160/1080/720/540/480), `searchAutoSelect` (auto-pick best
  result), `lookupPreference: quality | size | seeders`; results from all enabled extensions merged, deduped
  by hash, peer counts re-scraped via trackers (`updatePeers`), exclusions (e.g. HEVC/x265/H.265 added when
  `<video>.canPlayType` fails, unless `enableExternal` player).
- **Extensions** (4 source types: torrent, nzb, subtitle, http/webseed) + Chrome-extension "plugins"
  (.crx/.zip/unpacked). Installed from a repository URL (JSON array), auto-update at startup, per-extension
  options UI, enable/disable, online/offline status (10 s timeout), DoH (`enableDoH`, `doHURL`).
- **AniList**: OAuth, lists, progress/score/status mutations, favourites, following/activity, forum threads
  & comments (read + post), search with `genre/tag/format/status/season/seasonYear/isAdult/sort/onList`,
  recursive relations, trailer, `titleType` (ANILIST/ROMAJI/ENGLISH/NATIVE), `showHentai`, `hideSpoilers`.
- **Episode matching & metadata**: `hayase.ani.zip` (`/v1/episodes`, `/v1/mappings`, `/v2/images/tmdb`)
  for AniDB/TVDB/IMDb/TMDB/Kitsu ids, per-episode `anidbEid`, `tvdbId`, `absoluteEpisodeNumber`, airdate,
  thumbnails; `episodeByAirDate` fallback; filler list from
  `https://raw.githubusercontent.com/ThaUnknown/filler-scrape/master/filler.json` (`{ [anilistId]: number[] }`),
  `playerSkipFiller`; anitomyscript (`anitomyscript` package) for file/torrent names; parent-for-special
  resolution.
- **Player**: HTML5 video + `jassub` (ASS/SSA WASM renderer; `subtitleRenderHeight`, `subtitleStyle`
  fonts), `mediabunny` demuxing/transcoding path, `video-deband`, autoplay/autocomplete (mark watched),
  PiP, skip intro/outro via **AnimeThemes** module (`animethemes`), chapter skip, subtitle & audio language
  preferences (`subtitleLanguage: eng`, `audioLanguage: jpn`), external player (`playerPath`, mpv/vlc),
  gamepad, keybinds, Chromecast, DLNA, screenshot, ANGLE backend choice, UI scale, minimal UI.
- **Social**: Watch-together rooms (`w2g`, WebRTC via `p2pt`), IRC chat, Discord RPC
  (`showDetailsInRPC`), remote control (`remoteAccess: off|local|localAndRemote`) via `client` route.
- **Schedule**: season charts (current, previous residue, next) with airing countdowns (query in 2.2.5).
- **Themes**: default/light/catppuccin/dracula/gruvbox/lavender/system/custom (CSS vars), hide-to-tray,
  update checks, GeoIP (`doc999tor-fast-geoip`) for peer flags, speedtest.
- **NZB**: `nzbDomain/nzbLogin/nzbPassword/nzbPort(119)/nzbPoolSize(4)` – Usenet NNTP client in the
  torrent-client module; HTTP webseeds likewise.

### 2.2 Formats / APIs

#### 2.2.1 Manifest (v2) — `src/lib/modules/extensions/types.d.ts` + wiki "Creating Extensions"

A **repository is a JSON array of manifests** (one file lists many extensions). Fields:

| Field | Type | Req | Meaning |
|---|---|---|---|
| `manifestVersion` | number | yes | currently `2` (`MANIFEST_VERSION = 2`) |
| `deprecated` | boolean | no | hides/marks deprecated |
| `name` | string | yes | display name |
| `description` | string | yes | |
| `id` | string | yes | unique id, e.g. `anime.nyaasi` |
| `version` | string | yes | compared (semver) for updates |
| `type` | `"torrent"\|"nzb"\|"subtitle"\|"http"` | yes | picks base class |
| `accuracy` | `"high"\|"medium"\|"low"` | yes | ranking + cap for result accuracy |
| `ratio` | `"perma"\|number` | no | seeding ratio (not implemented) |
| `icon` | string URL | yes | |
| `media` | `"sub"\|"dub"\|"both"` | yes | informational |
| `url` | string | no | **base64-encoded** base URL; Hayase calls `native.enableCORS([atob(url)])` so the worker's `fetch` can reach that host |
| `languages` | ISO-3166 alpha-2 codes[] (`"ALL"` allowed) | yes | informational |
| `update` | string | no | URL to a manifest (array) with a higher `version`; `gh:`/`npm:` prefixes allowed |
| `code` | string | yes | URL to the bundled ESM script; must be CORS-enabled (raw.githubusercontent.com works); `gh:user/repo/path` → `https://esm.sh/gh/user/repo/es2022/path.mjs`, `npm:pkg/path` → `https://esm.sh/pkg/es2022/path.mjs` |
| `options` | `Record<string,{type:"string"\|"number"\|"boolean"\|"select", description, values?, default}>` | no | settings form; values passed as 2nd arg |
| `updatePeers` | `false` | no | `false` disables Hayase's tracker scrape of seeders/leechers (default: scrape) |
| `rateLimit` | number | no | max requests/second to the source (Hayase throttles) |

Live example (`ref/ext/tanzim2000_hayase-extension/index.json`, repo URL
`https://raw.githubusercontent.com/tanzim2000/hayase-extension/refs/heads/main/index.json`):
```json
{ "manifestVersion": 2, "name": "Nyaa", "id": "anime.nyaasi", "version": "2.2.0",
  "description": "Anime torrents with infoHash extraction.", "type": "torrent", "accuracy": "low",
  "updatePeers": true, "ratio": 0, "media": "sub", "languages": ["US","JP"],
  "url": "aHR0cHM6Ly9ueWFhLnNp",
  "icon": "https://nyaa.si/static/favicon.png",
  "update": "https://raw.githubusercontent.com/Tanzim2000/hayase-extension/refs/heads/main/index.json",
  "code": "https://raw.githubusercontent.com/Tanzim2000/hayase-extension/refs/heads/main/dist/nyaasi.js",
  "options": {
    "domain": { "type": "string", "description": "Nyaa base URL. Change to a mirror (e.g. https://nyaa.land) if nyaa.si is blocked.", "default": "https://nyaa.si" },
    "filter": { "type": "string", "description": "Quality filter. 0 = no filter, 1 = no remakes, 2 = trusted only.", "default": "0" } } }
```
Official example (`ref/ext/hayase-free-torrents/index.json`) uses the short form
`"update": "gh:hayase-app/free-torrents", "code": "gh:hayase-app/free-torrents/example"`.

#### 2.2.2 Loading model (`storage.ts`, `worker.ts`)

1. Repository JSON fetched (`safejson`), each manifest saved in `localStorage` (`extensions`), options in
   `extensionoptions`; code text downloaded (`safejs`) and stored in **IndexedDB** (`idb-keyval`, key = id).
2. One **Web Worker per extension** (`worker?worker`), proxied with `abslink` (Comlink-like). The worker does
   `URL.createObjectURL(new Blob([code], {type:'application/javascript'}))` → `await import(url)` →
   `module.default` must be an **object/class instance** with the methods. "Bundle your script — no module
   resolution."
3. Methods get the query plus `fetch` (on iOS rewritten to `cors://` scheme). The worker wraps the query in a
   `Proxy` recording which fields the extension read, and derives a **max accuracy** from them
   (`QUERY_RULES`): reading `anidbEid`/`tvdbEId` allows `high`; `anilistId/anidbAid/tvdbId/imdbId/tmdbId`
   set `medium` (max `high`); `titles`/`media` cap at `medium`; `absoluteEpisodeNumber` caps at `medium`.
   `sanitizeResults` then drops results without a 40/64-hex `hash` or empty `link`, clamps numbers, lowercases
   hash, caps `accuracy`, validates `type ∈ {batch,best,alt}`, `date` must be a valid `Date`.
4. Host (`extensions.ts`) builds the query, calls `single` (and `batch`/`movie` when applicable:
   `checkMovie = !singleEp && isMovie`, `checkBatch = !singleEp && !isMovie`), races with a 3 s/10 s timeout,
   dedupes by hash (merging the set of extensions that returned it), updates peer counts through
   `bittorrent-tracker` scrape (cached per hash), then sorts by `lookupPreference`.

#### 2.2.3 Module interface (exact, `types.d.ts`)

```ts
type Accuracy = 'high' | 'medium' | 'low'

interface AnimeQuery {
  media: any                     // AniList Media object (as fetched by Hayase)
  anilistId: number
  anidbAid?: number; anidbEid?: number
  tvdbId?: number;  tvdbEId?: number
  imdbId?: string;  tmdbId?: string
  titles: string[]               // romaji/english/native/userPreferred + synonyms (>3 chars), plus "Season 2"→"S2" variants and '-'-stripped variants
  episode: number
  episodeCount?: number
  absoluteEpisodeNumber?: number
  resolution: '2160' | '1080' | '720' | '540' | '480' | ''
  exclusions: string[]           // e.g. ["HEVC","x265","H.265"] when the device can't decode HEVC
}
type AnimeQueryWithFetch = AnimeQuery & { fetch: typeof fetch }

interface TorrentResult {
  title: string
  link: string                   // magnet, .torrent URL, or bare infoHash
  id?: number
  seeders: number; leechers: number; downloads: number
  accuracy: Accuracy
  hash: string                   // 40-hex (or 64-hex v2) info hash — REQUIRED
  size: number                   // bytes
  date: Date
  type?: 'batch' | 'best' | 'alt'
}
type SearchFunction = (query: AnimeQueryWithFetch, options?: Record<string, number | string | boolean>) => Promise<TorrentResult[]>

class TorrentSource  { test: () => Promise<boolean>; single: SearchFunction; batch: SearchFunction; movie: SearchFunction }
class NZBSource      { test: () => Promise<boolean>; single: NZBFunction<{file: string}>; batch: NZBFunction<{files: string[]}> }   // returns URL to (optionally gzipped) .nzb
class WebSeedSource  { test; single(q: WebSeedQuery<{file: WebSeedFile}>, o?) => Promise<WebSeedResult|undefined>; batch(q: WebSeedQuery<{files: WebSeedFile[]}>, o?) => Promise<WebSeedResult[]|undefined> }
class SubtitleSource { test; single(q: Omit<AnimeQueryWithFetch,'resolution'|'exclusions'>, o?) => Promise<{url: string, language: string}[]> }

type NZBQuery<T>     = { hash: string; name: string } & Omit<AnimeQuery,'resolution'|'exclusions'> & T
type WebSeedQuery<T> = NZBQuery<T>
interface WebSeedFile   { name: string; index?: number }
interface WebSeedResult { url: string; authorization?: string; index?: number; rateLimit?: number }
```
Export form (both work):
```js
export default new class extends TorrentSource { async test(){…} single(q,o){…} batch(q,o){…} movie(q,o){…} }
export default { async test(query){…}, async single(query, options = {}){…}, async batch(query, options = {}){…}, async movie(query, options = {}){…} }
```
Errors thrown are shown verbatim to the user (so messages must be user-friendly). `test()` returns `true`
or throws. `navigator.isOnline` for offline behaviour.

#### 2.2.4 Real community source implementations (`ref/ext/tanzim2000_hayase-extension/src/`)

- `nyaasi.js`: RSS `GET {domain}/?page=rss&q=<query>&c=<category>&f=<filter>` (defaults
  `c=1_2` Anime-English-translated, `f=0`), parses `<item>` with regexes incl. `<nyaa:seeders|leechers|
  downloads|infoHash|size|categoryId>`; query variants per title (first 3 titles): `"${title} - ${ep2}"`,
  `"${title} ${ep2}"`, absolute-number variant, bare title; optional `keyword` option appended (e.g.
  "Dubbed", "Arabic"); results filtered to the requested episode by parsing names; batch queries
  `"${title} batch|complete|season"`; exclusions applied; 15 s timeout, 2 retries with backoff; `test()` =
  `GET {domain}/?page=rss`. Variants in index: Nyaa, Nyaa (Dub) (`keyword: "Dubbed"`), Nyaa (Non-English)
  (`c=1_3`).
- `seadex.js`: `GET https://releases.moe/api/collections/entries/records?filter=alID="<anilistId>"&expand=trs`
  (PocketBase API); each `expand.trs[]` has `infoHash, isBest, releaseGroup, dualAudio, files[{name,length}],
  tracker, url`; builds magnet from hash + tracker list; `type: isBest ? 'best' : 'alt'`; skips
  `infoHash === "<redacted>"` (private trackers). `accuracy: 'high'`.
- `subsplease.js`: `GET https://subsplease.org/api/?f=search&tz=UTC&s=<title>` → items with
  `downloads: [{res, magnet}]`; magnets use **base32** btih hashes → decoded to hex.
- `tokyotosho.js` RSS (`https://www.tokyotosho.info/rss.php?filter=1&terms=…`), `acgrip.js`
  (`https://acg.rip/.xml?term=…`, `.torrent` URL only → hash derived from torrent), `anirena.js`
  (HTML search `https://www.anirena.com/?q=…&cat=anime&sub=sub-audio&per_page=250`), `mikan.js`
  (`https://mikanani.me/RSS/Search?searchstr=…`, hash in `<link>` `/Home/Episode/<40-hex>`),
  `sukebei.js` (sukebei.nyaa.si RSS).
- Build: esbuild `bundle:true, format:'esm', target:'es2022', platform:'browser', minify` → `dist/*.js`;
  tests with vitest against saved fixtures; GitHub Action `check-sources.yml` pings each source.

#### 2.2.5 Hayase AniList schedule query (`anilist/queries.ts`)

```graphql
fragment ScheduleMedia on Media {
  id, coverImage { extraLarge, color }, title { userPreferred }
  aired: airingSchedule(page: 1, perPage: 50, notYetAired: false) { n: nodes { a: airingAt, e: episode } }
  notaired: airingSchedule(page: 1, perPage: 50, notYetAired: true) { n: nodes { a: airingAt, e: episode } }
}
query Schedule($seasonCurrent: MediaSeason, $seasonYearCurrent: Int, $seasonLast: MediaSeason, $seasonYearLast: Int,
               $seasonNext: MediaSeason, $seasonYearNext: Int, $onList: Boolean, $ids: [Int], $formatNot: MediaFormat, $nsfw: [String]) {
  curr1: Page(page: 1) { media(type: ANIME, season: $seasonCurrent, seasonYear: $seasonYearCurrent, format_not: $formatNot, onList: $onList, id_in: $ids, genre_not_in: $nsfw) { ...ScheduleMedia } }
  curr2: Page(page: 2) { media(…same…) { ...ScheduleMedia } }
  curr3: Page(page: 3) { media(…same…) { ...ScheduleMedia } }
  residue: Page(page: 1) { media(type: ANIME, season: $seasonLast, seasonYear: $seasonYearLast, status_in: [RELEASING, HIATUS], format_not: $formatNot, onList: $onList, id_in: $ids, genre_not_in: $nsfw) { ...ScheduleMedia } }
  residueFinished: Page(page: 1) { media(type: ANIME, season: $seasonLast, seasonYear: $seasonYearLast, status: FINISHED, episodes_greater: 11, …) { ...ScheduleMedia } }
  next1: Page(page: 1) { media(type: ANIME, season: $seasonNext, seasonYear: $seasonYearNext, sort: [START_DATE], …) { ...ScheduleMedia } }
  next2: Page(page: 2) { media(…) { ...ScheduleMedia } }
}
```
(Multiple `Page` aliases in one request to fetch 150 current-season entries in one round-trip; AniList
`Page` max `perPage` is 50.)

### 2.3 Implementation notes

- Hayase's ID-first query object (`anidbEid`, `tvdbEId`, `imdbId`, `tmdbId`, `absoluteEpisodeNumber`) and
  the accuracy proxy trick are the best way to keep string-search providers honest.
- Web Worker + Blob-URL `import()` is directly reusable in Electron/Capacitor; CORS is handled by the native
  shell (Electron `session.webRequest` header rewrite; Capacitor `CapacitorHttp` or a native fetch bridge).
  Hayase's manifest `url` (base64) exists only to pre-authorize that origin.
- ani.zip (`https://api.ani.zip/mappings?anilist_id=`) returns `mappings { anidb_id, mal_id, kitsu_id,
  thetvdb_id, imdb_id, themoviedb_id, livechart_id, animeplanet_id, anisearch_id, notifymoe_id, type }` and
  `episodes { "<n>": { anidbEid, tvdbId, tvdbShowId, seasonNumber, episodeNumber, absoluteEpisodeNumber,
  airDate, airDateUtc, runtime, title{…}, overview, image, rating } }` (live-verified for id 21).

---

## 3. Senpwai (v3, Flutter)

### 3.1 Features (exhaustive)

- Platforms: Windows x64/ARM64, Linux x86_64/aarch64 AppImage, macOS universal, Android (ARM64/ARMv7/x64).
  Responsive phone/tablet/desktop.
- **Discovery**: AniList search with filters (`search, genre_in, season, seasonYear, format_in, status_in,
  isAdult, sort`), season browse, optional AniList login to browse own lists; title language preference
  (romaji/english/native), adult toggle, hide ratings.
- **Sources** (4): AnimeHeaven (HTTP direct mp4), Nyaa (torrents via `libtorrent_dart`), Animepahe (HTTP via
  Kwik, behind Cloudflare, disabled by default), Tokyo Insider (HTTP, Cloudflare, disabled by default).
  Source priority order, per-source enable, per-source request concurrency, Cloudflare "browser
  verification" using `flutter_inappwebview` (`shared/net/browser_transport`) with idle timeout.
- **Signed source directory** fetched from `https://senpwai.com/source-directory.json` (Ed25519-signed
  payload, public key embedded) so hosts can move without an app release:
  ```json
  { "version": 4, "issuedAt": "2026-10-04T00:00:00Z", "expiresAt": "2027-07-31T00:00:00Z",
    "sources": {
      "animeheaven":  { "baseUrl": "https://animeheaven.me", "allowedHosts": ["animeheaven.me"], "maxConcurrentRequests": 5 },
      "animepahe":    { "baseUrl": "https://animepahe.pw", "apiEntryPoint": "https://animepahe.pw/api?m=", "allowedHosts": ["animepahe.pw"] },
      "kwik":         { "baseUrl": "https://kwik.cx", "allowedHosts": ["kwik.cx"] },
      "nyaa":         { "baseUrl": "https://nyaa.si", "allowedHosts": ["nyaa.si"], "maxConcurrentRequests": 5 },
      "tokyoinsider": { "baseUrl": "https://www.tokyoinsider.com", "allowedHosts": ["www.tokyoinsider.com"] } } }
  ```
- **Download request**: source, episode range, resolution (144p…4320p enum), audio (Japanese/English),
  allow quality fallback, allow audio fallback, destination root(s) + custom per-anime folders, max
  download speed, max active downloads, connections per download, skip fillers, notification style
  (per episode / per batch).
- **Library scan** (`target_path_planner.dart`): resolves the anime folder from title candidates
  (sanitized romaji/english/synonyms, season parsing), scans existing files with anitomy to compute
  "haved" episodes and skips them; Nyaa planner inspects torrent contents (≤15 candidates) and maps video
  files (extension whitelist) to episodes.
- **Filler skipping**: scrapes AnimeFillerList (3.2.5).
- **Nyaa match review**: UI sheet (`ui/pages/anime_page/nyaa_review/*`) listing per-episode scored
  candidates with filters (resolution, language signal, trusted/remake), manual pick, countdown auto-start,
  "skip review when unambiguous", "skip unavailable Nyaa episodes" settings.
- **Download queue**: pause/resume/reorder/cancel, progress, speed, ETA, torrent activity (peers/seeds),
  Android foreground service (`flutter_foreground_task`), isolate-based runtime, persisted queue,
  HTTP link refresh/recovery (expired links re-resolved), Nyaa recovery.
- **Torrent settings** (libtorrent): download/upload limits, max active downloads/seeds, max connections,
  seed ratio/time limits, seeding mode (disabled / until target / indefinitely), port, encryption
  (enabled/forced/disabled), anonymous mode, incoming/outgoing TCP/uTP, DHT, LSD, UPnP, NAT-PMP, VPN
  interface binding, proxy (none/SOCKS4/SOCKS5/SOCKS5+pw/HTTP/HTTP+pw).
- **Tracking**: tracked ongoing anime re-checked on a timer (`Timer.periodic(hours: intervalHours)`),
  uses each show's saved download choices, resolves last available episode via AniList
  `nextAiringEpisode`, auto-enqueues new episodes, notifications.
- **Appearance**: brightness mode, theme presets, display/body font family, card view (poster / landscape /
  table), compact cards, hide synopses, pause banner rotation, show native title, show genres, reduce
  motion; window prefs; update checks (`update-manifest/`).

### 3.2 Source scraping (from `lib/sources/*.dart`)

#### 3.2.1 AnimeHeaven (`animeheaven.dart`)
- Search: `GET {base}/search.php?s=<term>` where term has non-alphanumerics replaced by spaces (site matches
  words literally). Results: `div.similarname > a` → `title = a.text`, `url = resolve(href)`.
- Anime page: alternative titles from `.infotitlejp` (comma-split aliases). Episodes:
  `a[onclick^="gatea"]` → `key = a.id` (32-hex), label `.watch2` text = episode number; skip
  `"<n> raw"` rows and fractional (recap) numbers.
- Download: `GET {base}/gate.php` with header `Cookie: key=<key>` (cookie-manager bypassed) → page contains
  `a[href*="video.mp4"]` → direct mp4. 3 retries on transient errors (500 ms × attempt).
- Only one subbed file per episode: quality/audio cannot be selected (reported as fallback notice).

#### 3.2.2 Nyaa (`nyaa.dart`, matcher `shared/matcher/nyaa.dart`, planner `planners/nyaa.dart`)
- Search HTML: `GET {base}/?q=<term>&s=seeders&o=desc&p=<page>` (75 per page; cached `forceCache`
  with live-search TTL). Rows: `table tbody tr` filtered to `td > a[title="Anime - English-translated"]`;
  columns: `td[1]` last `a` text = filename; `td[2] a[0]` = `.torrent` href (prefix base), `a[1]` = magnet;
  `td[3]` size ("1.5 GiB"); `td[4][data-timestamp]`; `td[5]` seeders; `td[6]` leechers; `td[7]` downloads.
  Pagination: `ul.pagination > li` second-to-last = total pages.
- Query generation: episode `"${title} ${ep.padLeft(2,'0')}"`; season batch `"${title} S02 complete"` and
  `"${title} Season 2 complete"`; movies bare title; base title/season split via anitomy.
- Validation: anitomy parse must yield resolution+title; language signal from audio terms
  (`dualaudio`) and subtitle terms (`dub`/`sub`) vs preferred language; title similarity ≥ 90 (0–100 fuzzy
  score) against candidates; `isCompleteSeason = parsed.episode == null` must match intent.
- Scoring: `score = -pardonedSizePenalty*0.325 + resolutionScore*0.3 + seedersScore*0.375`, where
  `seedersScore = min(seeders/min(100,maxSeeders),1)`, `resolutionScore = 1 - |res-pref|/(maxRes-minRes)`,
  `sizePenalty = size/maxSize` pardoned by `0.6 * (res-minRes)/(maxRes-minRes)`.
- Planner inspects up to 15 torrents (metadata via libtorrent) to map files → episodes; review sheet.

#### 3.2.3 Animepahe (`animepahe.dart`)
- API: `GET {apiEntryPoint}search&q=<term>&page=<n>` → `{ data:[{id,title,session,episodes,…}], total, per_page }`;
  episodes `GET {apiEntryPoint}release&id=<animeSession>&sort=episode_asc&page=<n>` → `{ data:[{episode, session}], per_page }`.
  Sequels may continue numbering (e.g. S2 ep1 shown as 14) → normalized `episode - (firstEpisode - 1)`.
- Episode page `GET {base}/play/{animeSession}/{episodeSession}` → `a.dropdown-item[target="_blank"]`
  → text like `"… 1080p (300MB) eng"`: resolution via regex `\b(?:(\d{3,4})p|\d+x(\d+))\b`, audio =
  English if text ends with `eng` else Japanese, size via `\b(\d+)MB\b`.
- Kwik resolution: follow the pahe link (Referer = episode page) to `https://kwik.cx/f/<id>`; page has
  obfuscated JS `("<fullKey>",\d+,"<key>",<v1>,<v2>,\d+)`; decoded with the classic Kwik unpacker
  (`_extractAndDecryptKwikForm`: split by `key[v2]`, map chars to digits, base-`v2` to int, minus `v1`),
  yielding a `<form action=POST_URL><input value=TOKEN>`; `POST` with `_token` and Referer → 302 to the
  direct mp4 (host ≠ kwik, `?file=` query).
- Cloudflare: requests go through the in-app WebView transport when challenged.

#### 3.2.4 Tokyo Insider (`tokyoinsider.dart`)
- Anime list cached daily from `GET {base}/anime/list` → `div.c_h2 > a, div.c_h2b > a` (~6000 titles);
  search is local fuzzy match (`titleSimilarity ≥ minMatchScore`).
- Anime page: episode links `a[href*="/episode/"]` (number parsed from text).
- Episode page: encoded rows `div.episode span.download-link[data-a][data-b]` (or legacy `span.dlk`,
  `div.c_h2 > div > a`); decoder key from inline script `var K = r13("<seed>")`: `key = rot13(reverse(seed))`;
  each link `decode(payload) = xor(base64(rot13(reverse(payload))), key)`; `<em>` = media type,
  `<strong>` = filename (resolution/audio parsed from filename).

#### 3.2.5 Filler episodes (`downloads/filler_episodes.dart`)
- Index: `GET https://www.animefillerlist.com/shows` → `#ShowList li a[href]` (title → path); lookup keys
  are normalized titles (brackets/parentheticals removed, non-alphanumerics stripped, "Filler List" suffix
  removed). Sequels are skipped (`_isSequel`).
- Show page: `h1` title must match; `table.EpisodeList tr.filler td.Number` → filler episode numbers;
  discarded if last filler number > episodeCount.
- (Hayase instead uses the pre-scraped `ThaUnknown/filler-scrape/filler.json`; Seanime uses an
  `animefillerlist` provider in `internal/library/fillermanager`.)

### 3.3 Implementation notes

- Senpwai is a *downloader*, not a streamer: its planners produce `{ episode → url/torrent+fileIndex,
  resolution, audio, size, destination path }` batches, then a queue runtime executes them. This planner /
  session / runtime split (`downloads/planners/*`, `anime_download_session.dart`, `in_process_runtime.dart`,
  `android_foreground_runtime.dart`) is a good template for Kurokawa's download queue.
- Anitomy (`anitomy_dart`) is used everywhere (library scan, Nyaa match, Tokyo Insider filenames). For TS use
  `anitomyscript` (WASM, used by Hayase) or a JS port.
- Signed remote "source directory" is a cheap way to survive domain changes without shipping updates.

---

## 4. Torrentio (Stremio addon) public HTTP API

Base: `https://torrentio.strem.fun` (Rust rewrite; routes in `crates/addon/src/http/server.rs`).

### 4.1 Endpoints

| Route | Purpose |
|---|---|
| `GET /manifest.json` | default manifest |
| `GET /{configuration}/manifest.json` | manifest for a config string (name becomes "Torrentio RD" etc.) |
| `GET /configure`, `/{configuration}/configure` | HTML configurator |
| `GET /stream/{type}/{id}.json` | streams, no config (`{type}` = `movie` \| `series` \| `anime`) |
| `GET /{configuration}/stream/{type}/{id}.json` | streams with config |
| `GET /{configuration}/catalog/other/torrentio-{moch}.json` and `/meta/other/{moch}:{id}.json` | debrid account catalogs (only when a debrid key is configured and `nocatalog` not set) |
| `GET /resolve/{moch}/{api_key}/{info_hash}/{entry}/{index}[/{filename}]` | resolves a debrid stream to a direct URL (302) |
| `GET /lite`, `/brazuca` | preset configs |

`{id}`:
- `tt1234567` (IMDb movie), `tt1234567:1:5` (IMDb series season:episode).
- **Anime**: `kitsu:<kitsuId>` (movie / whole show) or `kitsu:<kitsuId>:<episode>` (absolute episode
  number as on Kitsu). Regex `^kitsu:[0-9]+(:[0-9]+)?$` (case-insensitive). `idPrefixes` in the manifest
  are `["tt","kitsu"]`. There is **no AniList/MAL id support** – map AniList → Kitsu first (see 4.5).

### 4.2 Configuration string

`key=value` pairs joined with `|` (URL-encoded or raw), keys case-insensitive; invalid pairs ignored.
Example: `providers=nyaasi,horriblesubs|sort=seeders|qualityfilter=480p,scr,cam|limit=5|realdebrid=XXXX`.

| Key | Values |
|---|---|
| `providers` | comma list of keys; default = all. General: `yts, eztv, rarbg, 1337x, ext, thepiratebay, kickasstorrents, torrentgalaxy, magnetdl`; **anime**: `horriblesubs, nyaasi, tokyotosho, anidex, nekobt`; foreign: `rutor, rutracker, comando, bludv, micoleaodublado, torrent9, ilcorsaronero, mejortorrent, wolfmax4k, cinecalidad, besttorrents` |
| `sort` | `quality` (default: quality then seeders), `qualitysize`, `seeders`, `size` |
| `qualityfilter` | qualities to **exclude**: `brremux, hdrall, dolbyvision, dolbyvisionwithhdr, threed, nonthreed, 4k, 1080p, 720p, 480p, other, scr, cam, unknown` |
| `sizefilter` | `"<movieMax>,<episodeMax>"` e.g. `sizefilter=4GB,1GB` (first applies to movies, last to episodes) |
| `limit` | positive int, max results per quality group |
| `language` | comma list of language keys to prioritise: `dubbed, english, japanese, russian, italian, portuguese, spanish, latino, korean, chinese, taiwanese, french, german, dutch, hindi, telugu, tamil, polish, lithuanian, latvian, estonian, czech, slovakian, slovenian, hungarian, romanian, bulgarian, serbian, croatian, ukrainian, greek, danish, finnish, swedish, norwegian, turkish, arabic, persian, hebrew, vietnamese, indonesian, malay, thai` |
| `debridoptions` | `nodownloadlinks` (don't add "[RD download]" entries for uncached torrents), `nocatalog` |
| debrid keys | `realdebrid=<apiKey>`, `premiumize=<apiKey>`, `alldebrid=<apiKey>`, `debridlink=<apiKey>`, `easydebrid=<apiKey>`, `offcloud=<apiKey>`, `torbox=<apiKey>`, `putio=<clientId>@<token>`, `highway=<apiKey>`; several may be set (order preserved) |

### 4.3 Response shape (`domain/stream.rs`, `stream_info.rs`)

```ts
interface StreamsResponse { streams: Stream[]; cacheMaxAge?: number; staleRevalidate?: number; staleError?: number }
interface Stream {
  name: string            // "Torrentio\n1080p" (+ " 3D", " HDR | DV"); debrid: "[RD+] Torrentio\n1080p", "[RD download] …", "Torrentio\nRD error"
  title: string           // line1 torrent title, line2 file path (if differs), line3 "👤 <seeders> 💾 <size> ⚙️ <Provider>", line4 languages "Dubbed / Dual Audio / 🇬🇧"
  infoHash?: string       // present for P2P streams
  fileIdx?: number        // index of the video file inside the torrent (absent for single-file)
  behaviorHints?: { bingeGroup?: string /* "torrentio|<hash>" or "torrentio|<quality>|<codec>…" */; filename?: string; videoSize?: number; videoHash?: string }
  sources?: string[]      // ["tracker:udp://…/announce", …, "dht:<infohash>"]
  url?: string            // debrid-resolved streams only: "https://torrentio.strem.fun/resolve/<moch>/<apiKey>/<infoHash>/<entry>/<fileIdx>/<filename>"
}
```
Live payload (`GET /providers=nyaasi,horriblesubs|limit=3/stream/series/kitsu:1555:1.json`, trimmed):
```json
{"streams":[{"name":"Torrentio\n1080p",
  "title":"Naruto Shippuden (001-500) [Complete Series + Movies (1080p)] (Dual Audio)\nSeason 01 (001-032)/Naruto Shippuden Episode 001 Homecoming.mkv\n👤 225 💾 262.85 MB ⚙️ NyaaSi\nDubbed / Dual Audio / 🇬🇧",
  "infoHash":"ee34425d5595f37297bc8c94dab3184c02d43daf","fileIdx":11,
  "behaviorHints":{"bingeGroup":"torrentio|ee34425d5595f37297bc8c94dab3184c02d43daf","filename":"Naruto Shippuden Episode 001 Homecoming.mkv"},
  "sources":["tracker:udp://tracker.opentrackr.org:1337/announce","tracker:http://nyaa.tracker.wf:7777/announce","dht:ee34425d5595f37297bc8c94dab3184c02d43daf"]}]}
```
Parse `title` with `/👤 (\d+) 💾 ([\d.]+ \w+) ⚙️ (\S+)/` to get seeders/size/provider; build a magnet as
`magnet:?xt=urn:btih:<infoHash>&dn=<line1>&tr=<each tracker>`.

### 4.4 Debrid-resolved streams

When a debrid key is configured the addon checks instant availability for all hashes and:
- cached → stream replaced: `name = "[RD+] " + name`, `url = {host}/resolve/realdebrid/{apiKey}/{infoHash}/{entryUrl}/{fileIdx}/{filename}`
  (`entryUrl` is provider-specific, e.g. RD `"{apiKey}/{infoHash}/null/{fileIdx}"`), `infoHash`/`sources`
  removed, `behaviorHints` merged.
- not cached and healthy (seeders > 0, or 4k, or ≤5 seeded results) → an extra entry
  `name = "[RD download] …"` with a resolve URL that adds the torrent to the account and redirects to a
  "downloading" placeholder video (unless `debridoptions=nodownloadlinks`).
- auth errors → a synthetic stream `name: "Torrentio\nRD error"`, `title: "Invalid RealDebrid ApiKey/Token!"`
  pointing to `{host}/videos/failed_access_v2.mp4` (or `failed_unavailable`).
- After processing, **all P2P streams without `url` are dropped** (debrid-configured requests return only
  debrid URLs). Debrid short names: RD, PM, AD, DL, ED, OC, TB, Putio, HW. EasyDebrid never offers downloads.
- `GET /resolve/...` → 302 to the direct video URL (follows per-provider API: RD `unrestrict/link`, etc.).
  Clients should pass the user's IP (the addon forwards `X-Forwarded-For` to RD/AD for geo-locked links).

### 4.5 Kitsu ids for anime

- Torrentio's anime rows are keyed by `kitsu_id` + absolute `episode`. To query from AniList:
  `GET https://arm.haglund.dev/api/v2/ids?source=anilist&id=<anilistId>` → live:
  `{"anidb":69,"anilist":21,"animecountdown":38636,"animenewsnetwork":836,"anime-planet":"one-piece","anisearch":2227,"imdb":"tt0388629","kitsu":12,"livechart":321,"myanimelist":21,"media":"TV","simkl":38636,"themoviedb":37854,"thetvdb":81797}`
  or `GET https://api.ani.zip/mappings?anilist_id=<id>` → `mappings.kitsu_id`. Also `imdb` lets you use
  `tt…:season:episode` for shows that Torrentio only indexed from non-anime providers.
- Kitsu itself: `GET https://kitsu.io/api/edge/mappings?filter[externalSite]=anilist/anime&filter[externalId]=<id>&include=item`
  (JSON:API, no key).
- Episode numbering: Torrentio expects the Kitsu episode number (per Kitsu entry, so seasons split like
  AniList/MAL; long-runners like Naruto Shippuden are absolute within the entry).

### 4.6 Manifest (`http/manifest.rs`, live)

```json
{"id":"com.stremio.torrentio.addon","version":"0.0.15","name":"Torrentio",
 "description":"Provides torrent streams from scraped torrent providers. Currently supports YTS(+), EZTV(+), … nekoBT(+), …",
 "catalogs":[],
 "resources":[{"name":"stream","types":["movie","series","anime"],"idPrefixes":["tt","kitsu"]}],
 "types":["movie","series","anime","other"],
 "background":"https://torrentio.strem.fun/images/background_v1.jpg","logo":"https://torrentio.strem.fun/images/logo_v1.png",
 "behaviorHints":{"configurable":true,"configurationRequired":false}}
```
Caching: responses carry `cacheMaxAge` (1 h default, shorter when empty); the server rate-limits per IP
(Redis) – batch requests and cache locally. Torrentio may block aggressive non-Stremio clients; send a
descriptive User-Agent and respect `cacheMaxAge`.

---

## 5. AniChart and LiveChart

### 5.1 What they show
- **AniChart** (anichart.net, by the AniList team, data = AniList GraphQL): season charts (Winter/Spring/
  Summer/Fall of a year, plus "TBA"/"Leftovers"), each card with cover, titles, studio, format, episode
  count, airing countdown of the next episode, genres, description, external/streaming links, trailer,
  score/popularity, "add to list" when logged in; filters (format, genres, on-list, adult); sort
  (popularity, score, title, start date); airing schedule view by day with countdowns.
- **LiveChart.me**: season charts with "simulcast" tags, schedule by weekday/timezone (JST vs user TZ),
  countdowns to the *episode* (episode-level air times incl. streaming vs TV premiere), headlines/news,
  franchise pages, user lists & notifications, "Anime of the Day". **No public API**; HTML is JS-heavy
  and ToS forbids scraping. Available without an API: RSS feeds (`/feeds/episodes` recent episode
  releases, `/feeds/headlines` news), both live-verified:
  ```xml
  <item><guid>https://www.livechart.me/anime/13150#episode7421918:1793460600</guid>
    <link>https://www.livechart.me/anime/13150</link>
    <title>Seitokai ni mo Ana wa Aru! #5</title>
    <pubDate>Sat, 31 Oct 2026 15:30:00 +0000</pubDate>
    <category>Anime/Television/Episodes</category>
    <enclosure url="https://u.livechart.me/anime/13150/poster_image/…/small.jpg" length="0" type="image/jpeg"/>
    <media:thumbnail url="…" width="175" height="250"/></item>
  ```
  (`guid` embeds `episode<id>:<unix airtime>`; LiveChart anime id maps to AniList via arm/ani.zip
  `livechart_id`.) Everything else (season chart, countdown) should come from AniList.

### 5.2 AniList GraphQL (endpoint `https://graphql.anilist.co`, POST JSON `{query, variables}`)

Rate limit (live header on 2026-10-31): `x-ratelimit-limit: 30` requests/minute (degraded state; nominal
90), `x-ratelimit-remaining`, `Retry-After` on 429. Reuse Kurokawa's existing AniList client; unauthenticated
works for both queries; with a token `mediaListEntry` and `onList` are populated.

**Season chart** (what AniChart renders), validated live:
```graphql
query SeasonChart($season: MediaSeason, $year: Int, $page: Int, $perPage: Int = 50, $isAdult: Boolean = false, $sort: [MediaSort] = [POPULARITY_DESC], $format: [MediaFormat], $onList: Boolean) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage perPage }
    media(type: ANIME, season: $season, seasonYear: $year, isAdult: $isAdult, sort: $sort, format_in: $format, onList: $onList) {
      id idMal
      title { romaji english native userPreferred }
      format status episodes duration
      startDate { year month day } endDate { year month day }
      season seasonYear
      coverImage { extraLarge large medium color } bannerImage
      genres tags { name rank isMediaSpoiler }
      averageScore meanScore popularity favourites
      description(asHtml: false) source countryOfOrigin hashtag isAdult siteUrl
      trailer { id site thumbnail }
      studios(isMain: true) { nodes { id name } }
      nextAiringEpisode { id airingAt timeUntilAiring episode }
      airingSchedule(notYetAired: true, perPage: 1) { nodes { airingAt episode } }
      externalLinks { id site url type language icon color }
      streamingEpisodes { title thumbnail url site }
      mediaListEntry { id status progress score }
      relations { edges { relationType(version: 2) node { id title { romaji } format status } } }
    }
  }
}
```
Variables: `{"season":"FALL","year":2026,"page":1}`. `MediaSeason ∈ WINTER|SPRING|SUMMER|FALL` (AniList
seasons: Winter = Jan–Mar, Spring = Apr–Jun, Summer = Jul–Sep, Fall = Oct–Dec). "Leftovers" = Hayase's
`residue` query above (`season: <previous>, status_in: [RELEASING, HIATUS]`). "TBA" = `status: NOT_YET_RELEASED`
with `season: null`/`startDate_like: "2027%"`. Other sorts: `SCORE_DESC, TRENDING_DESC, START_DATE,
TITLE_ROMAJI, FAVOURITES_DESC`.

**Airing schedule / countdown calendar** (what both sites show per day), validated live:
```graphql
query AiringSchedule($start: Int, $end: Int, $page: Int, $perPage: Int = 50) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage hasNextPage }
    airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME) {
      id airingAt timeUntilAiring episode mediaId
      media {
        id idMal title { romaji english native userPreferred }
        format status episodes duration season seasonYear isAdult siteUrl
        coverImage { extraLarge large color } bannerImage genres averageScore popularity
        externalLinks { site url type }
        studios(isMain: true) { nodes { name } }
        nextAiringEpisode { airingAt episode }
        mediaListEntry { status progress }
      }
    }
  }
}
```
Variables: `{"start": <unix seconds of day start>, "end": <unix seconds of day end>, "page": 1}`. Filter
`media.isAdult`/format client-side (there is no `isAdult` arg on `airingSchedules`; use
`notYetAired: true` to drop already-aired entries). `timeUntilAiring` is seconds; recompute locally from
`airingAt` for live countdowns. Up to 50 per page; a 7-day window typically needs 3–6 pages.

**Per-media schedule** (episode list with air times, for the entry page):
```graphql
query MediaSchedule($id: Int!) {
  Media(id: $id, type: ANIME) {
    id title { userPreferred } episodes status nextAiringEpisode { airingAt episode timeUntilAiring }
    airingSchedule(perPage: 50) { pageInfo { hasNextPage } nodes { id airingAt episode timeUntilAiring } }
  }
}
```

**AniList → other ids** (for Torrentio/Kitsu, AniDB, LiveChart): `Media.idMal` plus
`https://arm.haglund.dev/api/v2/ids?source=anilist&id=<id>` or `https://api.ani.zip/mappings?anilist_id=<id>`
(both live-verified, no key).

---

## 6. What to take for Kurokawa Tools (ranked)

1. **Extension/provider model = Seanime's typed smart-search API, loaded Hayase-style.**
   Adopt Seanime's `AnimeTorrentProvider` method set and `AnimeTorrent` result (keep `confirmed`,
   `isBatch`, `episodeNumber: -1`, `infoHash`/`magnetLink` lazy getters, `getLatest()` for auto-download)
   and its manifest fields (`id,name,version,type,language,author,lang,icon,payloadURI,userConfig,
   manifestURI,isDevelopment`), but execute code the Hayase way: bundled ESM, downloaded to IndexedDB,
   imported through a Blob URL inside a dedicated **Web Worker** with an injected `fetch` bridged to native
   (Electron `net.fetch`/session CORS rewrite; Capacitor `CapacitorHttp`), per-call timeout, `test()`
   health check, and Hayase's accuracy proxy + result sanitizer. Add Hayase's ID-rich query fields
   (`anidbAid, anidbEid, tvdbId, tvdbEId, imdbId, tmdbId, kitsuId, absoluteEpisodeNumber, titles[],
   exclusions[]`) to Seanime's `media` object so both styles of provider can be ported with thin adapters.
   Provide the host helpers Seanime extensions expect as an injected `$`-less module: `parseFilename`
   (anitomyscript), `loadDoc` (linkedom/cheerio-lite in worker), `parseFeed` (fast-xml-parser),
   `getUserPreference`, `store`, `sleep`, `CryptoJS`-compatible AES. Compatibility shim: wrap Seanime
   payloads by evaluating them in the worker and instantiating `new Provider()`.
2. **Repository & marketplace format**: a URL returning a JSON array of manifests (works for both
   Seanime's marketplace.json and Hayase's index.json). Support three inputs: single manifest URL, array
   URL, Seanime `{urls:[…]}`. Track `version` for updates, keep community-marketplace extras
   (`status`, `flags/permalink` VirusTotal, `tags`, `support`) as optional display fields. Default to
   shipping **no** content-source extensions in the app (Hayase/Seanime stance); ship only a
   public-domain example and allow adding repository URLs.
3. **Torrentio as a zero-maintenance provider**: implement a built-in or bundled extension that maps
   AniList → Kitsu (arm / ani.zip), calls
   `/{providers=nyaasi,horriblesubs,tokyotosho,anidex,nekobt|sort=…}/stream/series/kitsu:<id>:<ep>.json`,
   parses `title` lines into seeders/size/provider and `sources` into a magnet. Offer optional debrid keys
   (`realdebrid|alldebrid|premiumize|torbox|debridlink|offcloud|putio|easydebrid|highway`) so the same
   provider returns direct `url` streams; honour `cacheMaxAge`.
4. **Debrid layer**: implement Seanime's `debrid.Provider` interface in TS for Real-Debrid, AllDebrid,
   TorBox, Premiumize (`authenticate, addTorrent, getInstantAvailability, getTorrentInfo, getTorrents,
   getTorrentStreamUrl, getTorrentDownloadUrl, deleteTorrent`) so torrent search results can be streamed or
   downloaded without a BitTorrent client on Android.
5. **Download queue & planners (Senpwai)**: planner → session → runtime split; per-episode targets with
   resolution/audio fallback notices; library scan with anitomy to skip owned episodes; pause/resume/
   reorder; Android foreground service; HTTP link refresh/recovery for expiring direct links; torrent
   settings surface (limits, seeding mode, encryption, proxy, VPN binding) if libtorrent (Electron) /
   libtorrent4j (Android) is used.
6. **Auto-downloader (Seanime)**: rules + profiles + conditions (score/block/require), delay with
   skip-delay score, min seeders/size, provider whitelist, polling `getLatest()` every ≥15 min, habari/
   anitomy matching of release names to AniList entries; "tracking" (Senpwai) is the simpler subset
   (check `nextAiringEpisode`, enqueue missing episodes with saved choices).
7. **Schedule/season chart (AniChart/LiveChart)**: implement with the two AniList queries in §5.2 through
   the existing client, with local countdown recomputation, day grouping in user TZ, Hayase's
   multi-`Page` alias trick for the current season, and LiveChart RSS only as a "recent releases" ticker.
   Cache aggressively (30 req/min limit).
8. **Episode metadata & id mapping**: `api.ani.zip` mappings/episodes (titles, thumbnails, `anidbEid`,
   `absoluteEpisodeNumber`, airdates) and arm.haglund.dev; filler data from `filler-scrape/filler.json`
   (cheap) with AnimeFillerList scraping as fallback.
9. **Best-release curation**: SeaDex (`releases.moe` PocketBase API, `filter=alID="<id>"&expand=trs`) as a
   `bestReleases` filter/provider (`isBestRelease`, `type: best|alt`, dual-audio flag, file lists).
10. **Quality-of-life ideas**: Senpwai's Nyaa review sheet (scored candidates, manual override,
    countdown auto-start); Seanime's availability badges and torrent previews (file → episode mapping);
    Hayase's exclusions derived from `canPlayType` (skip HEVC on devices that can't decode it); signed
    remote source-directory for host changes; Discord RPC; schedule-aware "missed episodes".
