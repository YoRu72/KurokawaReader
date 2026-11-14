# Kurokawa Tools on Android — the Rust core (stages M0–M6)

The plan is docs/RUST-PORT.md §5; this file is how the Android side is built. Written 2026-11-14 (M0 and M1).

## What is here

| | |
|---|---|
| `kt-core/` (beside) | the shared std-only rules; Android adds `dlrules.rs` (KtDlRules) and `translatekey.rs` (KtTranslate's cache key) |
| `kt-android/src/jni.rs` | the **only** unsafe code: one JNI function, written by hand, and `JNI_OnLoad` |
| `kt-android/src/dispatch.rs` | the table of named methods (safe Rust) and their tests |
| `native/android/KtCore.java` | Java's door: lazy load, `available()`, `version()`, `call`, `callBytes`, `r`, shadow mode |
| `jvmtest/` | the library built for the computer, loaded by a plain JVM through `KtCore` (no emulator) |
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

Measured here, host build (x86_64 glibc): **358 KB** `.so`, 189 KB compressed. Estimate for Android before CI
measures: arm64-v8a 330–380 KB (≈170–190 KB in the APK), armeabi-v7a 250–300 KB (≈140–160 KB), x86_64 350–400 KB
(≈180–200 KB); the universal APK ≈ +0.5 MB. Budget for M1: under 250 KB compressed per ABI. Most of it is std
(formatting, panics, unwinding); each later stage's logic adds less than that floor did. M3 (torrents, replacing
libtorrent4j's 5.9 MB) is where size really moves.

## Next stages

**M2 — the HTTP downloader (high risk).** Java now: `KrDownloader` (segments, If-Range resume, the record and its
recovery by bytes, slow-chunk splitting, connection growth, the 403/429/503 and dropped-link rules, MEGA's
AES-128-CTR, the file-type sniffing) driven by `KtEngine`. Proposal: Rust takes the *decisions*, Java keeps the
*sockets* — a sans-I/O engine in kt-core (`http.plan` / `http.event` methods: which ranges to ask, when to split,
add or drop a connection, retry, give up, what the record holds) while Java's `HttpURLConnection` (with DoH, the
cookie jar, the proxy, Android's certificate store) moves the bytes; `mega.decrypt` as a `bytes.*` method (kt-core's
`mega.rs` is ready). A Rust socket stack would need rustls and its own resolver: +1–2 MB per ABI and a second DoH —
only if the decisions-only engine proves too chatty. Proof: tests/native/T.java's runs 1–19 driven through the Rust
engine against the same loopback server (in the JVM test, as here), Java's runs unchanged beside them. Switch:
«Download engine: Java / Rust» under Settings → Advanced, **phones only** (hidden on PC, where aria2 is the engine;
hidden when the core is absent), stored in the `kt` preferences, read when a download starts; default Java. A Rust
error before the first byte restarts that download on Java and is counted; after bytes, the download pauses with the
error shown (the record is shared, so Java can resume it). New strings in all five languages. Then the owner's
phone run on Wi-Fi and mobile data before the default changes.

**M3 — torrents** with the Rust engine proven on PC in P4 (librqbit), replacing libtorrent4j; same switch pattern
(«Torrent engine»); proof: P4's loopback torrent tests on the Android build (emulator in CI if affordable), then the
owner's phone with the parity list of RUST-PORT.md §1a. Not before P4 is done.

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
