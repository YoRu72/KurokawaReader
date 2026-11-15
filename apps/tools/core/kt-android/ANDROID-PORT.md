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
| `kt-core/src/tordirector.rs`, `tormobile.rs`; `kt-android/src/m3call.rs` | M3: the streaming director (`tdir.*`) and the torrent engines' rules (`tor.choose`, `tor.onFail`) |
| `../kt-android-torrent/` | M3: libkt_torrent.so — librqbit as the phone's Rust torrent engine, its own JNI door, build, tests, size table, release patch |
| `native/android/KtTorDirector.java`, `KtTorrentCore.java`, `KtTorrentRs.java`, `KtTorrentRsEngine.java` | M3: the Java side |

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

**M3 — torrents: written 2026-11-15, waiting for CI and the owner's phone. Nothing of it has run on a phone; librqbit
has never run anywhere as a whole-download engine (the PC uses it only to stream, beside aria2).**

*The choice.* librqbit for Android with the NDK is possible but unproven on every axis that matters here: the PC built
it only with its default features (native-tls and sha1 through OpenSSL, which Android lacks), so Android needs
`default-features = false, features = ["rust-tls"]` (rustls → ring, C and assembly through the NDK's clang), a
combination nobody built; and it cannot follow the phone's SAF folders, proxy, bound interface or forced encryption.
So M3 is two things: **(1) the director** — an original streaming brain in kt-core (std, tested here with a simulated
swarm) that drives libtorrent4j's existing wires (piece priorities and deadlines) — certain to build, in
libkt_android.so; and **(2) the Rust engine** — librqbit in a library of its own (libkt_torrent.so), a CI try-step that
can fail without touching anything.

*Setting.* Settings → Advanced, «Torrent engine: Classic / Director / Rust», phones only; Director listed when
libkt_android.so is here, Rust when libkt_torrent.so is; neither → the row is absent (no card at all when both are).
Default **Classic** (unchanged behaviour). Kept in the `kt` preferences (`configure({torEngine})`), read when a torrent
is **added**; the torrent keeps that engine in its meta (`torEngine`); torrents from before M3 stay classic.
`deviceInfo`: `torEngineChoice`, `torEngine`, `rustTorrent` (version or null), `rustTorrentStatus`,
`torEngineFallbacks`, `torEngineHeld`, `torDirectorPlans`, `torDirectorFallbacks`, `debuggable`. In a debuggable build a
torrent's row and details show «engine: Rust / Director».

*The director* (kt-core `tordirector.rs`; kt-android `m3call.rs` `tdir.open/hint/rate/read/plan/close`; Java
`KtTorDirector` with `KtStream.wires(th)`). For a torrent on «director», `prepareStream` and `KtStream.waitForPiece`
ask it instead of Java's fixed rules: the file's tail (index) asked with its head; a read-ahead window of 8–60 s of
video (the player's byte rate, else measured from the reads) — 20 s when the swarm gives less than the video needs or
at the start, 60 s when it gives 3× more, 8 s while scrubbing (≥ 2 seeks in 30 s); deadlines from when playback reaches
each piece (½ of that time, ≥ 80 ms); a seek (backwards, or beyond the window) drops the old deadlines at once; the
next window's worth at high priority. Peer choking, request queues and end-game duplicate requests stay libtorrent's
(libtorrent4j gives Java no per-peer choke; its time-critical picking does end-game for deadline pieces). Any Rust error
→ Java's rules for that stream, counted. Simulated swarm (`tordirector.rs` tests, 12 peers, 400 MB file, 256 KiB
pieces, a 1 MB/s video, first frame = first 2 MB + last 1 MB, seek to 65 % at 30 s; mean of 5 seeds; tuned on this
simulator, so it shows direction, not phone numbers):

| swarm | strategy | time to first frame | time to seek target | stalls in 90 s after |
|---|---|---:|---:|---:|
| 4 MB/s | plain sequential | 109.7 s | 42.1 s | 0.0 s |
| 4 MB/s | Java today | 11.1 s | 1.8 s | 0.0 s |
| 4 MB/s | director | **3.0 s** | **1.7 s** | 0.0 s |
| 1.4 MB/s | plain sequential | > 400 s (never) | 172.1 s | 0.0 s |
| 1.4 MB/s | Java today | 77.8 s | 4.5 s | 0.0 s |
| 1.4 MB/s | director | **8.1 s** | **4.3 s** | 0.3 s |

The gain is the first frame (the index no longer waits behind the head and the 32 MB «soon» stretch); seeks are on a par
with Java's rules (both drop deadlines at once); on the tight swarm the director stalls 0.3 s where Java does not.

*The Rust engine* (`apps/tools/core/kt-android-torrent`: `src/dispatch.rs` std-only `tor.*` table, `src/rqbit.rs`
librqbit glue, `src/fake.rs` stand-in for host tests; kt-core `tormobile.rs` decides; Java `KtTorrentCore` (loader,
own PROTOCOL 1), `KtTorrentRs` (calls), `KtTorrentRsEngine` (KtEngine's torrent surface)). One JNI call shape as
kt-android (`KtTorrentCore.nCall`), catch_unwind on every call and every librqbit call, panic = "unwind". One tokio
runtime (2 workers) entered for every call, as on the PC. `tor.start` (fresh data dir, DHT on/off, UPnP, port),
`tor.add` (magnet or .torrent bytes, folder, wanted files, paused; the add runs on its own thread), `tor.poll` (every
changed task and every failure in one call, ~0.7 s, seeding rules applied), `tor.pause/resume/remove/files/limits`,
`bytes.tor.read(id, file, off, len, timeout)` for the stream, `tor.shutdown` (every torrent let go, files kept, list
handed back). **Stream: `bytes.tor.read` behind Java's existing KtStream server** (not a second HTTP server in Rust):
KtStream keeps its ranges, headers, signed URLs and player hints; only the byte source changes, and librqbit's file
stream already fetches the pieces under the reader first — the fewest new moving parts.
*Ownership and fallback.* One engine per info-hash (a hash libtorrent holds is never given to Rust; Rust refuses a
duplicate). Not eligible (SAF folder, proxy, bound interface, anonymous mode, forced encryption, library absent) →
director or classic at add time. A failure with nothing written → the same source restarted on libtorrent at once,
counted; with bytes → paused with «rust: …», marked classic: resume gives libtorrent the same folder. **Existing files:
librqbit is added with `overwrite: true` and checks what is there, keeping good pieces; libtorrent with no resume data
hashes the files in its save path and keeps good pieces.** librqbit's folder is chosen so its files are where
libtorrent puts them (`tormobile::rqbit_folder`: multi-file under `<dir>/<name>`). The foreground service, wake locks,
notifications and Wi-Fi-only / battery holds are KtEngine's and act through pause/resume, which route to the Rust
engine for its tasks. Recheck, reannounce, add trackers, rename, sequential and per-torrent limits do nothing on a Rust
task.

*What differs from libtorrent4j, feature by feature (Rust engine).* DHT: on/off as set; no saved node table (cold
start each run), no custom bootstrap, no «turn DHT on when no peers» nudge. PEX: librqbit's own, not configurable
(unverified). LSD: none. uTP: none in 8.1.1 as far as known (TCP) — unverified. Encryption: none (forced → refused,
classic). Proxy: not used → refused. IPv6: as librqbit does (unverified). Sequential/streaming: no sequential flag; the
file stream prioritises under the reader. Seeding limits: ours (tormobile), ratio needs librqbit's upload count
(«upload» feature). Resume: no librqbit persistence; each start re-adds every Rust torrent and **re-checks its files**
(slow on big torrents) — libtorrent has fastresume. Magnet metadata: fetched twice (list-only, then add) and only in a
build with «listonly». Port mapping: UPnP only (no NAT-PMP). Limits: session-wide, at session start only; none per
torrent. File priorities: wanted / not wanted (no «high»). Interface binding, anonymous mode: refused.

*Calls the PC never compiled* (each behind its own cargo feature, built with all, again with none on failure —
`build-android.sh`; `build.txt` says which): the dependency set itself (no default features + rust-tls; ring or
aws-lc with the NDK), `Session::pause/unpause`, `SessionOptions.listen_port_range`, `.disable_dht_persistence`,
`.ratelimits` (`librqbit::limits::LimitsConfig`), `AddTorrentOptions.trackers`, `.list_only` +
`AddTorrentResponse::ListOnly(r)` with `r.info.name/.files/.length`, `TorrentStats.file_progress`, `.uploaded_bytes`.

*Size.* Measured here: libkt_android.so host 480 240 bytes (+20 KB for the director), 246 932 gzip (+10 KB).
libkt_torrent.so: not measurable here; estimate **+2–4 MB .so, ≈ 1–2 MB compressed per ABI** while both engines ship
(libtorrent4j is 5.9 MB) — the CI step «M3: the torrent library's size» prints the real per-ABI table and the APKs with
and without it.

*Proof.* Here: `tordirector.rs` 8 and `tormobile.rs` 10 std tests; kt-android `m3call.rs` 3; the torrent library's
dispatch with the stand-in backend (`test-host.sh`) and its Java door from a JVM (`jvmtest/torrent.sh`: add →
metadata → bytes identical, pause/resume with and without librqbit's pause, both failures, SAF refused, remove,
shutdown hand-back, a panic as an error, the director with made-up wires, no library → Failure only);
`KtTorrentRsEngine` compiled against KtEngine.Task's fields; KtEngine/KtStream checked differentially (no new javac
error but the Android/libtorrent4j classes absent here). CI (`android-rust-check.yml` «M3» blocks): the same, then
librqbit built for the computer with `tests/loopback.rs` — a made-up file, a private torrent, a loopback tracker and
aria2c seeding on 127.0.0.1, DHT off: add → metadata → done with identical bytes, a far range streamed before the
middle is in, pause/resume, remove, a forced failure told — and the JVM call shape on the real build; then the three
ABIs, packed only if all built; the size table. The release patch: `../kt-android-torrent/switch-over/`.

*Phone test list (owner).* Debug APK with both libraries. Director: a torrent video opened at once (first frame time
vs Classic), seeks far ahead and back, scrubbing; the row says «engine: Director». Rust: a .torrent and a magnet into
Download/Kurokawa, on Wi-Fi and mobile data with «Wi-Fi only» on and off; pause/resume; stop the app mid-download and
reopen (it re-checks); watch while downloading and seek far; a torrent with several files, some unticked; remove with
and without files; a SAF folder and a proxy set (must go to Classic, counted); battery and heat over 30 min; that
`torEngineFallbacks` stays 0 on healthy torrents.

*Before libtorrent4j can be removed (M6).* The Rust engine must be the default after a clean phone run, and all of
this must hold: every ABI builds «every call» (not «proven only»); resume without re-hashing (librqbit persistence
wired, or our own resume record); NAT-PMP or proof UPnP suffices; encryption support (or proof peers do without);
proxy and bound-interface support or the owner's word that they may go; uTP or measured speeds on a par; SAF folders
(librqbit writing through file descriptors Java opens, or a copy-out step); magnet metadata once; per-torrent limits,
recheck, trackers, rename and the peer list on the Rust engine; the director's rules moved onto librqbit if it keeps
streaming. Until then libtorrent4j ships and stays the default.

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
