# Kurokawa Tools on Android — the Rust core (stages M0–M6)

The plan is docs/RUST-PORT.md §5; this file is how the Android side is built. Written 2026-11-14 (M0 and M1; M2 the same
day).

## What is here

| | |
|---|---|
| `kt-core/` (beside) | the shared std-only rules; Android adds `dlrules.rs` (KtDlRules), `translatekey.rs` (KtTranslate's cache key) and `httpdl.rs` (KrDownloader's decisions, M2) |
| `kt-android/src/jni.rs` | the **only** unsafe code: one JNI function, written by hand, and `JNI_OnLoad` |
| `kt-android/src/dispatch.rs` | the table of named methods (safe Rust) and their tests |
| `kt-android/src/httpcall.rs` | M2: the downloader's `http.*` methods (a table of downloads under way, by number) and `bytes.megaCtr` |
| `kt-android/src/m4call.rs` | M4: `bytes.scrTrack`, `bytes.moShift`, `bytes.inpaint` (+ the patch cache), `bytes.hlsVariants` / `bytes.hlsMedia`, `hls.choose`; shadow-only `scr.ahead`, `lt.*` |
| `native/android/KtScreenRs.java`, `KtHlsRs.java` | M4: the screen translator's and HLS's door to Rust — encoders, the shadow, the per-call fallback, the pixel tolerance |
| `jvmtest/screen-rust.sh`, `ScreenRustT.java` | M4: TkT/MoT/InT/TrT/HlsT under shadow mode and through the Rust engine (strict), parity fuzz, the benchmark, no-library run; `GenJavaChar.java` writes kt-core's `javachar.in` |
| `native/android/KrDownloaderRs.java` | M2: the second download engine — KrDownloader's surface, every decision asked of Rust |
| `native/android/KtCore.java` | Java's door: lazy load, `available()`, `version()`, `call`, `callBytes`, `r`, shadow mode |
| `jvmtest/` | the library built for the computer, loaded by a plain JVM through `KtCore` (no emulator); `downloader-rust.sh` runs T.java's runs 1–19 through the Rust engine |
| `build-android.sh` | the three ABIs with the runner's NDK |
| `sizes.py` | each APK checked for its library; the size table |
| `switch-over/` | the patch for release-tools.yml and how to flip it |
| `.github/workflows/android-rust-check.yml` | all of the above in CI |

## The call shape (one for every stage)

```java
private static native byte[] nCall(byte[] method, byte[] args, byte[] data);   // KtCore
```

- `method`: a UTF-8 name, `area.verb` (`dl.pickName`, `tr.cacheKey`, later `http.start`, `mega.decrypt`…).
- `args`: a JSON object (UTF-8). Java writes it ASCII-only (`\uXXXX` escapes), so any Java string — emoji,
  NUL, Arabic — crosses intact.
- `data`: bytes beside the arguments, for methods named `bytes.*` (null: none).
- answer: one status byte, then the payload — `0` + the method's answer (JSON `{"r": …}`, or bytes for `bytes.*`),
  `1` + a UTF-8 error message. A panic is caught (`catch_unwind`) and comes back as `1` + `panic: …`.

Why bytes and not `jstring`: JNI's string functions speak «modified UTF-8», and Android's CheckJNI (on in every
debuggable app) aborts the process on a 4-byte UTF-8 sequence. Byte arrays need five table entries
(`GetArrayLength` 171, `NewByteArray` 176, `GetByteArrayRegion` 200, `SetByteArrayRegion` 208, `ExceptionCheck` 228,
plus `ExceptionClear` 17), checked against the JDK's `jni.h`.

**Why hand-written JNI and not the `jni` crate.** The `jni` crate (0.21.1, with `combine`, `jni-sys`, `cesu8`,
`thiserror`, `log`, `cfg-if`, `walkdir` and more — some 10 crates) cannot be compiled in the workspace, so any API
slip would cost a 20-minute CI round. One function over byte arrays is ~100 lines against a table whose layout is
fixed by the JNI specification, and with no crates.io dependency the whole crate builds here with
`cargo build --offline` — so the exact library the APK carries (for the host) is loaded and tested by a JVM on this
machine before CI ever sees it. The cost: the unsafe surface is ours to keep right, which is why it is one file.

`panic = "unwind"` stays in the release profile: with `abort`, `catch_unwind` catches nothing and a bug in a rule
would close the app instead of falling back to Java. Unwinding tables cost some tens of KB.

## Adding a function

1. The logic in kt-core as a std-only module with `#[cfg(test)]` tests (`rustc --edition 2021 --test src/x.rs`).
2. A name in `METHODS` and an arm in `dispatch::call_json` (or `call_raw` for `bytes.*`), reading arguments with the
   strict helpers there (a missing or mistyped argument is an error, never a default) and a test in `dispatch.rs`.
3. Java calls it through `KtCore.r("area.verb", "k", v, …)` (scalars, lists, maps) or `KtCore.call` / `callBytes`, and
   keeps its own code as the fallback for `!KtCore.available()` and for any `KtCore.Failure`.
4. While Java is the reference: a shadow hook (`if (KtCore.shadowing()) KtCore.shadow(method, javaAnswer, args…)`)
   and the cases in `jvmtest/RustBridgeT.java` asked of both.
5. A new method never needs a new JNI signature; if the call shape itself must change, raise `PROTOCOL` on both
   sides (a library of another protocol is treated as absent).

## Build

`build-android.sh <out>`: `rustup target add` the three triples; `CARGO_TARGET_<TRIPLE>_LINKER` set to the NDK's
`<triple><API>-clang` wrappers (`aarch64-linux-android24-clang`, `armv7a-linux-androideabi24-clang`,
`x86_64-linux-android24-clang`; API 24 = the app's minSdk after overlay.mjs); 16 KB pages for the 64-bit ABIs;
all three ABIs or none. No cargo-ndk: it would only set those variables, and it is one more program from crates.io.
Release profile: `opt-level = "z"`, `lto = true`, `codegen-units = 1`, `strip = true`, `panic = "unwind"`.
The `.so` files go into `android/app/src/main/jniLibs/<abi>/` — the app module's default folder, so Gradle needs
no change, and a build without them is today's build.

## The fallback rule

The Rust core is never required. `KtCore.available()` is false when the library is absent, for another ABI, fails to
load or answers another protocol — and then every caller uses its Java code. No `Error` reaches a caller (each call
catches `Throwable` and throws the checked `KtCore.Failure` instead). In M0–M1 Java's answer is always the one
used; Rust is only asked beside it in debuggable builds (shadow mode: counts, the first five differences, a log line;
shown in `deviceInfo().rustShadow`).

## Size budget

Measured here, host build (x86_64 glibc): **358 KB** `.so`, 189 KB compressed after M1. Measured by CI after M1
(run 43596554460): +193 KB arm64-v8a, +183 KB armeabi-v7a, +200 KB x86_64, +576 KB universal APK.
**M2, host: 460 096 bytes (+93 KB), 236 501 compressed (+43 KB)** — the downloader's rules, the session table, AES for
MEGA. Expected on Android from that ratio: about +40–50 KB per ABI in the APK (≈ +235–250 KB arm64), the universal APK
≈ +0.7 MB in all; CI's size table is the measure. Budget kept: under 250 KB compressed per ABI. M3 (torrents) is where
size really moves.

## Next stages

**M2 — the HTTP downloader (high risk): written 2026-11-14, waiting for CI and the owner's phone.**
- *Split*: Rust takes the decisions, Java keeps the sockets. kt-core's `httpdl.rs` is KrDownloader's rules as a state
  machine with no I/O and no clock (`now` is given): the probe's meaning (a page, the server's name, 200 whole, no
  ranges, a refusal, a cut file), the plan (connections, chunk size), going on from the record (zero tails asked of
  Java, a few chunks compared with the server's by Java, the chunks of a file with no record), the next range for a
  connection (a chunk, a part given back, the second half of the slowest part), what of a read is still a part's own,
  the speeds, the record every 3 s / 1.5 s, an error's meaning (again after 250 ms / 400·n ms ×3 for 429/503 /
  Retry-After up to 60 s, from the first or the direct address; 429/503, a 403/401 among accepted connections once
  bytes came, a connection cut twice before its first byte → this connection leaves and its part goes back; give up
  after the retries), connections added each second while the speed rises 6 %, and the end (done, a second round,
  incomplete). Java (`KrDownloaderRs`) follows redirects, reads and writes, sleeps, runs the threads and the limiters,
  and tells Rust what happened (`http.probe`, `http.begin`/`zero`/`checked`, `http.next`, `http.take` + `http.wrote` per
  read, `http.error`, `http.segEnd`, `http.workerEnd`, `http.scale*`, `http.finish`, `http.close`). MEGA:
  `bytes.megaCtr` (kt-core's `mega.rs` AES, the counter at any offset). Header parsing for the file's name
  (`dispositionName`) and the classing of an exception as «cut by the server» stay Java's (they read Java objects);
  so do the after-the-download checks in KtEngine (file type sniffing, a page instead of media).
- *Record*: the same «kt1» text, read and written alike (proved both ways in RustBridgeT); the only difference is the
  order of the begun-chunk list (Java's HashMap order, Rust's ascending), which neither reader cares about.
- *Switch*: Settings → Advanced, «Download engine: Java / Rust», phones only and only when deviceInfo reports a core;
  stored by the engine in the `kt` preferences (`configure({dlEngine})`), read when a download starts; default Java.
  A Rust error before the run's first byte: the same download restarted on Java at once and counted
  (`deviceInfo().dlEngineFallbacks`); after bytes: the download pauses with «rust: …» as its reason and is marked to
  run on Java next time, going on from the shared record. `deviceInfo` also gives `dlEngine` (in use) and
  `dlEngineChoice`. The in-app updater's own downloads stay on Java.
- *Proof*: `httpdl.rs` 14 std-only tests; `httpcall.rs` 4 (a run through the table, planning steps, MEGA at odd offsets);
  RustBridgeT: the record both ways, MEGA against Java's CtrFile, a download through each door (and through
  KrDownloaderRs with no core: Java, silently); **T.java's runs 1–19 through the Rust engine** (`downloader-rust.sh`,
  the test unchanged but for the class it calls, strict — no silent fallback) beside Java's own runs, both required in
  android-rust-check.yml. All passed here before CI.
- *Left*: CI's Android build of it; then **the owner's phone run** (debug or release APK with the library):
  Settings → Advanced → Rust; on Wi-Fi and on mobile data: a big file from a fast host, a GitHub release asset (signed
  redirect), a link that drops (lift / underground), pause and resume, stop the app mid-download and resume, switch
  back to Java mid-download and resume (the shared record), a MEGA link, a host that refuses connections; watch speed,
  battery and that «handed back to Java» stays 0. Default changes only after that run (and its fixes).

**M3 — torrents (refreshed 2026-11-14).** The plan was «the engine proven on PC in P4 replaces libtorrent4j». What P4
became (branch `work-tt-p4`, commit 2ef84b6) changes that: the PC's torrent engine is a **hybrid** — aria2 (a C++
program run beside the app) keeps every torrent *download* and seed; librqbit (8.1.1, behind a cargo feature, with
tokio) only *streams* a torrent the player opens (far seeks) and hands it back to aria2 on any failure. So:
- *What PC proves is narrower than Android needs.* libtorrent4j does everything on the phone (downloads, seeding, magnet
  metadata, DHT/LSD/UPnP/NAT-PMP, encryption modes, proxy, interface binding, file priorities, sequential, ratio and
  time limits, resume data). Android has no aria2 to fall back to, so librqbit would have to be the whole engine there,
  with libtorrent4j as the fallback behind the switch — a parity list PC never ran (RUST-PORT.md §1a).
- *Size.* librqbit pulls tokio, its own HTTP stack for trackers (reqwest with rustls → ring, which builds C/assembly with
  the NDK's clang — workable, but the first C in this library), sha1, serde and more: on PC it is «a few MB». Per ABI on
  Android expect roughly 2–4 MB of `.so` (≈1–2 MB compressed) against libtorrent4j's 5.9 MB, so the APK could shrink
  only once libtorrent4j is removed (M6); while both ship (the switch), it grows by that much per ABI. CI must measure
  it (a `cargo build` of librqbit for the three targets, as P4's «what it adds» step) before any decision.
- *Shape.* Not sans-I/O like M2: librqbit owns its sockets and its runtime, so the JNI side needs a long-lived session,
  polling of its state (`tor.*` methods answering JSON through the same one native call), and its HTTP made to honour
  the app's DNS over HTTPS and proxy — or those options documented as not applying to the Rust engine.
- *Order.* Measure size and build first (no app change), then a streaming-only use mirroring PC (the player's torrent
  through librqbit, libtorrent4j for the rest), then downloads behind «Torrent engine», then the phone run. Not before
  P4 is merged.

**M4 — screen translator and HLS logic: written 2026-11-15 (branch `work-and-m4`), waiting for CI and the phone.**
- *What moved* (kt-core, std only, each module alone under `rustc --test`): `screentrack.rs` — KtScreenTrack's update
  (pairing by words then place, own translations read back, clipped lines, glide/snap/resize, misses, blind pieces,
  the cap), its loose text comparison and translating ahead; `screenmotion.rs` — the signature and the scroll finder;
  `inpaint.rs` — KtInpaint.clean, plus a **patch cache** (new); `lettering.rs` — KtLettering's markers put back and
  its AI prompt, KtLetterFace's look rules for a block's kind; `hls.rs` — KtHls's master and media playlists
  (variants, the choice, keys and IVs, sequence numbers, byte ranges, EXT-X-MAP, «live», durations) and
  **java.net.URL's own resolution** ported rule for rule (`url:` prefixes, a same-scheme relative, `?`-only lines,
  Java's `./` and `../` removal), and the TS sync search. `javachar.in` holds Java's `Character.isLetter` / `isDigit`
  / `toLowerCase(char)` (generated from Java by `jvmtest/GenJavaChar.java`, checksum-tested), so «a letter» is Java's
  (Rust's `is_alphanumeric` keeps Arabic vowel marks and letter numbers; Java does not). Text crosses as UTF-16 units.
  **NFC decided: kept in Java** — Rust never normalises; Java hands over `KtTranslate.norm` of each text beside it.
- *Calls*: one copy each way, no JSON or base64 for bulk: a tracking request is binary (UTF-16 units and ints), a
  patch is little-endian ARGB words, a signature pair i16s, a playlist UTF-16LE in and binary out. **The JNI round
  trip of a 1080×2400 RGBA frame (10.4 MB, bytes.echo) is 7.7–14 ms on this host** (one Java array copy of it:
  2.7–3.0 ms — the door copies five times: in, the Vec, the status byte's shift, out, Java's trim). So no frame
  crosses: the signature (14 400 pixels read in place from the Android Image) stays Java's; only the 57 KB signature
  pair and patches (≤ 2.4 MB, typically 64 KB) cross.
- *Measured (host JVM 21 vs the release library, median of many runs, rust/java with the JNI copies counted; two runs
  on a loaded 2-core machine, so ranges)*: scroll between two frames 0.43–0.87; a reading paired (45 read, 60
  followed) 0.53–0.55; inpaint 200×80 0.22–0.29, 600×300 0.41–0.65, the same patch again through the cache 0.02–0.10;
  translating ahead (120 candidates) **4.0–5.6 (slower)**; markers put back in 30 translations **4.7–6.1 (slower)**;
  a 2 000-segment playlist 0.57–1.66 (parity within noise). At kt-android's `opt-level = "z"` Rust lost (shift 1.9×,
  big patches 2.6× slower), so `kt-core` is built at `opt-level = 3` (Cargo.toml profile override) and the hot loops
  were made exact-but-faster (a 256-bin sliding median for Java's sorted windows, an integer form of `dist > 46`,
  exact rounding without libm, separable dilation and box sums, an exactly-pruned shift search).
- *The switch*: Settings → Advanced, «Screen translator engine: Classic / Rust», phones with the core only, default
  Classic (`configure({screenEngine})`, the `kt` preferences, read at the service's start). Rust takes the jobs that
  proved identical and faster — **tracking, the scroll finder, inpaint (with the patch cache)** — each call back to
  Java on any error (counted: `deviceInfo().screenEngineFallbacks`; `screenEngineCalls`, `screenCache` beside it).
  **Kept on Java by design**: translating ahead (it asks Java's translation cache for each text; the round trip costs
  more than the work), lettering's markers, prompt and kinds (microseconds of work), the signature (see above).
  HLS has no switch of its own: it **follows the download engine** (M2) — `KtEngine.runHls` passes `rust` to
  `KtHls.run` when «Download engine» is Rust and the core is here; any Rust error reads that playlist with Java
  (`deviceInfo().hlsRustFallbacks`; a DRM key or a bad number then fails in Java exactly as before, so it counts
  once there too).
- *Stays Java by nature*: everything that draws or measures with Android — the boxes' TextView auto-size with the
  chosen Typeface and Paint (font metrics, line breaking, RTL/CJK shaping), shadows/outlines, Bitmaps —; MediaProjection
  and the Image planes; the accessibility tree and overlays; ML Kit OCR; the glossary's regex matching (Unicode case
  folding, the Latin script class); KtHls's I/O, AES (javax.crypto, hardware AES on phones), ffmpeg, the files.
- *Shadow* (debuggable builds): every tracking update, shift, inpaint, translating ahead, restore/prompt/kinds and
  playlist reading asked of both; tracking compared as a whole digest (ids, words, boxes, misses, clipped, data
  identity, the six lists), pixels within **`KtScreenRs.PIXEL_TOL` = 1 level per channel, alpha exact** (both
  sides are the same IEEE doubles in the same order with no fused multiply-add, so 0 is measured; 1 allows a
  runtime that rounds one intermediate differently). Counted in KtCore's shadow report (`KtCore.shadowNote`).
- *Where Rust differs from Java*: nowhere measured. By construction: a URL Java would resolve through another scheme
  handler (ftp, file, jar), an IPv6 or odd authority, a hexadecimal EXTINF, or «İ» in a RESOLUTION is an error in
  Rust and read by Java (15 of 170 cases in the parity run). Unicode version: the tables are Java 21's (Unicode 15);
  an Android with an older ICU could judge a character added since then differently (counted by the shadow if met).
  Android's libcore URL is OpenJDK's with Android changes not checked here — the shadow is the check.
- *New (behind the Rust switch only)*: the **patch cache** — cleaned patches kept by their exact bytes (hash to find,
  bytes compared, 8 MB, least recently used out); in auto mode the same balloon is re-read every few hundred ms, and a
  repeat costs 2–10 % of a clean. Not built (ideas): a frame change map (work per changed tile — needs the frame in
  Rust, i.e. a direct-buffer JNI entry), scroll-velocity look-ahead pre-placing boxes, an adaptive HLS variant
  chooser with throughput/buffer hysteresis, segment resume by byte range after a drop.
- *Proof*: 5 modules' std-only tests (24); m4call's 2; `jvmtest/screen-rust.sh`: TkT (384 calls), MoT, InT, TrT, HlsT
  under shadow with 0 differences; TkT/MoT/InT/HlsT through the Rust engine with 0 fallbacks; parity: 1 500 random
  tracking steps, 40 signature pairs, 30 random patches (worst 0), 170 addresses, 80 playlists, every height wanted —
  all alike; no library: Java alone. Page test `tests/screenengine.cjs`.
- *Size*: host library 460 416 → 599 976 bytes, **236 590 → 306 225 compressed (+69.6 KB)**, of which ≈ 19 KB is
  `opt-level = 3` for all of kt-core. Expect about +70 KB per ABI in the APK — **over the 250 KB-per-ABI budget**
  (≈ 300 KB arm64); CI's size table is the measure. If that matters more than speed: drop the override (the jobs then
  stay on Java: set `*_ON_RUST` false) or the shadow-only methods.
- *On the phone* (debug APK with the library; Settings → Advanced → Screen translator engine → Rust): auto mode on a
  long comic (scroll slowly, fling, scroll back: boxes stay on their words, nothing re-translated), a chat app with
  numbers changing, a page with alike lines, a speech-balloon comic in «erase» mode (cleaned backgrounds look as with
  Classic; watch the cache in deviceInfo), and an HLS download with «Download engine: Rust»; watch `rustShadow`
  (0 mismatches), `screenEngineFallbacks` 0, battery and smoothness against Classic.
- *Before the Java can go*: the phone run with 0 shadow mismatches over real apps, CI on Java 17's Unicode and on an
  emulator if feasible, one release with Rust as default; the Java stays for what Rust leaves to it (other URL
  schemes, ahead, lettering) unless those move too.
- *Not changed*: the kt-android version (0.2.0 — the three stages' merge raises it once; RustBridgeT checks it).

**M5 — file jobs and remote storage**: KtFileJobs's rules are already kt-core's `filejobs.rs` (P3, the same rules):
wire them through the bridge with FilesT's cases; KtRemote's protocol-free logic after.

**M6 — removal**: the replaced Java and libtorrent4j removed one release after each Rust default ran without
problems; final size and speed table.

**Subtitle matching** (listed under M1 in RUST-PORT.md) has no Java side: it is `src/player/subMatch.ts`, run in
the web view on every platform, so there is no Java to shadow and nothing on Android calls it natively. It moves
when a Rust caller needs it.
