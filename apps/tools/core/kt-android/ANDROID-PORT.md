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

**M4 — screen translator and HLS logic**: KtScreenTrack, KtScreenMotion, KtLettering, KtInpaint, KtHls into kt-core;
their tests (TkT, MoT, InT, HlsT) ported; shadow first, then switched. NFC (Unicode tables) decided then: a crate or
kept in Java.

**M5 — file jobs and remote storage**: KtFileJobs's rules are already kt-core's `filejobs.rs` (P3, the same rules):
wire them through the bridge with FilesT's cases; KtRemote's protocol-free logic after.

**M6 — removal**: the replaced Java and libtorrent4j removed one release after each Rust default ran without
problems; final size and speed table.

**Subtitle matching** (listed under M1 in RUST-PORT.md) has no Java side: it is `src/player/subMatch.ts`, run in
the web view on every platform, so there is no Java to shadow and nothing on Android calls it natively. It moves
when a Rust caller needs it.
