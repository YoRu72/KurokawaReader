# Performance and size: what was measured, what was done, what is left

Measured on the web build of Tools 0.16 (dist/, Chromium through Playwright, a 412×900 phone viewport, Arabic UI), 2026‑11‑05.

## Startup

| What | Figure |
|---|---|
| First view drawn (Downloads) | 214 ms from navigation, cold |
| DOMContentLoaded / load | 103 ms / 103 ms |
| HTML | 3 KB |
| Slowest resources | `app.js` 77 ms (13 KB), Inter woff2 66 ms (151 KB), the first chunks 50–65 ms (3–28 KB each) |
| Route switches (warm) | 10–23 ms each (`/settings` 23, `/anime` 18, `/videos` 16, `/` 13, `/tv` 12, `/files` 10) |
| Long tasks (>50 ms) during five settings↔downloads round trips | none |
| JS heap after the tour | 10 MB |

The page is already in the "nothing to feel" range; the cost on a phone is the WebView's own start and the native plugin's start (libtorrent, mpv's libraries are loaded lazily by their add-ons).

## Bundle

| Before | After | What changed |
|---|---|---|
| 2.5 MB dist, Arabic chunk 304 KB | 2.2 MB dist, Arabic chunk 136 KB | esbuild `charset: 'utf8'`: non‑ASCII strings were written as `\uXXXX` escapes (six bytes a letter); now as UTF‑8. Japanese 96→60 KB, Korean and Chinese likewise. The same in the Reader's build. |
| `app.css` 248 KB | unchanged | One stylesheet for every page; splitting it per view would save ~150 KB on first paint but complicate theming (the tokens are shared). Left as is: it gzips to ~35 KB. |

Chunks are split per view already (`chunk-player`, `chunk-files`, `chunk-settings`, the language chunks), so a page pays only for itself.

## APK

| Before | After | What changed |
|---|---|---|
| arm64 ≈ 16.8 MB, universal ≈ 30.3 MB, no R8 | R8 (`minifyEnabled` + `shrinkResources`) with keep rules for what is reached by name | The Reader already shrank this way (11.5 → 6.2 MB). Tools carries libtorrent4j's JNI, mpv, youtubedl‑android, commons‑compress, zip4j, junrar, jsch, smbj (+ bouncycastle), commons‑net, Shizuku, security‑crypto (+ Tink): R8 drops the unused parts of all of them. The Android check now builds the release so a rule that strips too much is caught before release day. Figures after the first R8 release go in the release notes. |
| ML Kit text recognition | unchanged | Already the Play‑services flavour (models fetched by the phone, not carried). |
| mpv, ffmpeg | unchanged | Packs downloaded on demand (`KtPacks`), not in the APK. |

Candidates not taken: dropping bouncycastle entirely (smbj needs it only for some auth paths; R8 keeps what is referenced), splitting the language chunks further (they are lazy already), a lighter Latin font (Inter at 151 KB could be subset to the glyphs the UI uses, ~40 KB).

## Native work that is hot

- Folder listing (`KtFiles.list`): `DirectoryStream` + one `readAttributes` per entry, counts inside folders optional (Files settings → "Counts inside folders"), thumbnails lazy (IntersectionObserver), 20 000‑entry cap with a notice.
- Archives (`KtArchive`): zip read by its central directory (one seek), entries streamed; in place with batches of 64 entries / 512 MB and one `fsync` per batch; volumes joined through one random‑access view.
- DoH (`KrDoh`): positive and negative caches by TTL, stale answers when no resolver answers, resolvers ordered by health, one connection per resolver kept (HttpURLConnection pool).
- The proxy (`KrDohProxy`): one thread per tunnel, 32 KB copies, no timeouts in tunnels, the hello read whole once and written the way the ladder says.

## Leak hunt

`tests/hunt.cjs` (both apps): every page opened and left 40 times with listeners on window/document, intervals, observers and the DOM counted; sheets opened from each page's top bar and closed. It found one leak — a sheet replaced by another kept its Escape listener — fixed in `openSheet` (sheets are now closed, never merely removed). Counters stay flat across the rounds.

## Still worth doing (tracked as tasks)

- Subset the Latin UI font (~110 KB on first paint for Arabic users who rarely see Latin UI text).
- Per‑view CSS when the token layer is extracted.
- A measurement on a real phone (cold start to first paint, Files listing of 10 000 entries, a 2 GB in‑place extraction) to put device figures beside these.
