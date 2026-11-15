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
| `kt-android/src/m5call.rs` | M5: `fj.*` (the file jobs' planner and journal), `ar.*`, `vt.*`, `rm.*` (kt-core's `fileplan.rs`, `filejournal.rs`, `remoterules.rs`) |
| `native/android/KtFilePlan.java`, `KtFileExec.java`, `KtRemoteRules.java` | M5: Java's planner (the reference), the executor with the engine choice, the cross-check and the journal; the network storages' rules in two hands |
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
**M5, host: 569 288 bytes (+108 872 from M2's 460 416 rebuilt here), 287 129 gzip -9 (+50 565)** — the planner,
the journal's reader and rules, the remote rules, and their JSON. M2's CI run (43617047751) measured arm64 +234.3 KB in
the APK for a host build of 236.5 KB compressed, so expect ≈ +50 KB per ABI more: arm64 ≈ 285 KB, **about 35 KB over
the 250 KB budget** — CI's size table decides; if it holds, M6's removals pay it back, or `fj.*`'s JSON can be slimmed.

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

**M5 — file jobs and remote storage: written 2026-11-15 (branch `work-and-m5`), waiting for CI and the owner's phone.**
- *The claim checked.* The plan said KtFileJobs's rules «are already kt-core's `filejobs.rs`». They are — rule for
  rule — but `filejobs.rs` is the PC's port *with its I/O inside* (std::fs copies, renames, deletes), and Android must
  keep every byte in Java (plain files today; SAF, which only Java can do, tomorrow). So the rules are taken a second
  time as a **planner**: kt-core's new `fileplan.rs` plans a job from a snapshot Java takes (the trees, what stands at
  each target, the folder listings for «keep both») into ordered steps (`ask`, `rename`, `dir`, `copy`, `skip`, `fail`,
  `endDir`, `del`, `end`, each a JSON array with fixed places); Java's `KtFileExec` executes them; Java's `KtFilePlan`
  (built on KtFileJobs's own helpers: extOf, keepBoth's split, inside, same, sameStorage, link) is the reference
  planner. `filejobs.rs` is untouched (the PC keeps it). Where it and Android differ, the planner follows Android:
  1. a standing answer other than ask/skip/replace/keep is kept as Java keeps it (and acts as «replace»), where
     filejobs.rs turns it into «ask»; an unknown page answer is «replace» in both Java and the planner;
  2. a move's `left` on a **cancel** is counted on the disk (the files still under the chosen paths) by the executor,
     where KtFileJobs adds up each `leave()`: they differ only for empty folders in flight at the cancel;
  3. a folder replacing a file: KtFileJobs deletes the file then renames the folder in; the executor sets the file
     aside first (journaled) and drops it only once the folder stands there — same end, no window where both are gone;
  4. «exists» is the snapshot's stat plus what the job itself made; a name the case-blind volume takes for another
     spelling is not foreseen by either planner — the executor's re-check (below) catches it.
  The bin's slot names and expiry, a rename's checks, the archive's path safety, `wanted` and its own «keep both»
  (KtArchive's: any extension length, case kept — not KtFileJobs's), the vault's choice of files and its name check
  are ported too (`fj.trash*`, `fj.renameBad`, `ar.*`, `vt.*`), compared with Java's in FileJobsRustT; not yet wired
  into KtFiles/KtArchive/KtVault (no executor change there in M5). **Batch rename is not Java**: it is
  `src/views/filesNames.ts` + `filesMore.ts` in the web view (one `filesRename` per item), like subtitle matching —
  nothing to port on Android. Java has **no** reserved-name or per-filesystem length rules and **no** free-space
  check in its file jobs (only KtArchive and KtApk check space); none were invented — the plan reports `copyBytes`
  (what the copies will write) for a later check, and a full disk ends a copy as Java's does (proved with a quota hook).
- *Remote storage* (`KtRemote`: FTP/FTPS, SFTP, SMB, WebDAV/Nextcloud, Google Drive): kt-core's `remoterules.rs` has
  its protocol-free rules — `norm`/`join`, SMB's share split, WebDAV's URL encoding (java.net.URLEncoder's exactly),
  the base URL (Nextcloud's files root from the user's *name*), a PROPFIND href made a path (URLDecoder's errors kept),
  the «collection» test, the one retry on a new connection, an upload's order, a download's local names, the cache's
  «already whole» rule. KtRemote asks `KtRemoteRules` for the base URL, each href and the upload order (Java's lines
  kept there as the reference; Rust's answer used with the Rust engine, Java's on any error, both compared on debuggable
  builds). **Secrets never cross**: the Authorization header, passwords, keys, tokens and the Keystore stay in KtRemote.
- *Switch*: Settings → Advanced, «File jobs engine: Classic / Rust», phones with the core only; default **Classic**
  (`configure({fileEngine})`, kept in the `kt` preferences, read when a job starts). Classic is KtFileJobs.run,
  unchanged; on a debuggable build with the core both planners also plan each classic job (≤ 20 000 entries) and the
  difference is counted. With Rust: a Rust error before the first step → Java's plan runs (counted); later (a re-plan
  after an answer or a failed rename) a Rust error ends the job, never switching planner mid-job. **Data safety**:
  every step of Rust's plan that deletes, overwrites or moves must be, exactly, in Java's plan for that item —
  computed in Java, every time — or the item is skipped whole and reported («the two planners disagree»); and every
  step re-checks the disk before it touches anything (a copy never lands on a file the plan did not expect; a rename
  never over anything). Said in the setting's hint.
- *New, not in Java: the journal* (`filejournal.rs`, written by KtFileExec in the app's private files, `filejobs/`):
  the plan written as ordered, CRC-checked lines before it runs, each step marked as it begins, at its risky moments
  (an old file set aside, a new one in place) and as it ends; fsync before every risky step; a torn last line is not
  believed and is cut off before anything is appended; no file contents, only paths, sizes, times; at most 200 000
  steps (larger jobs run unjournaled, counted); finished journals kept 30 / 14 days. A job cut short (crash, kill, card
  pulled) can be **resumed** — its half-done steps settled by what is really on the disk, then the rest of its plan —
  or **rolled back**; a finished job can be **undone** when all its steps can (copies, moves, renames, new folders; a
  replace or a delete cannot — the bin is for those). `deviceInfo().fileJournalResumable/Undoable`; the status card
  lists the interrupted jobs with Resume / Roll back; `filesJournals`, `filesJournalResume`, `filesJournalRollback`
  (`undo: true` for a finished one), `filesJournalDismiss`. The end event of a Rust job carries `journal` and
  `undoable`, the foundation for the page's Undo (not wired into the page's undo bar in M5).
- *Proof (all passed here):* fileplan.rs 9, filejournal.rs 7, remoterules.rs 3 std-only tests; m5call.rs 3 through the
  table; `tests/native/fileplan.sh` (FilesT through Java's plan + the executor, no library) beside `files.sh`;
  `jvmtest/filejobs-rust.sh`: FilesT's cases through the Rust engine (strict), FileJobsRustT — 198 plans of random
  trees (Arabic, emoji, trailing dots/spaces, 255-byte names, files where folders are, missing paths, a folder into
  itself) identical step for step; 60 random jobs leaving the same trees and ends on both engines; a failed rename
  re-planned as copy+delete; a full disk; odd names; a tampered Rust plan (the victim untouched, the item skipped);
  the journal killed before each of its records (and torn in half) over 24 random jobs — 531 kills, every resume
  equal to the whole job, every rollback without a replace back at the start, never a file lost, never a part left;
  a finished move undone; the small rules and the remote rules against Java's. CI block «Stage M5» in
  android-rust-check.yml.
- *Not built:* the second candidate (a transfer order that minimises peak extra space for moves on a nearly full
  device); the page's Undo bar for Rust jobs; journaling of the bin's own moves (KtFiles.trash, which has its restore);
  SAF jobs (KtFileJobs has none today); wiring the archive/vault rules into their classes.
- *Owner's phone run* (APK with the library): Settings → Advanced → File jobs engine → Rust. Copy and move a folder of
  photos inside the phone (renames) and to an SD card or USB stick (copies); paste where a name is taken and answer
  each of Skip / Replace / Keep both (and «for all»); move a large video to the card and swipe the app away mid-move,
  open it again → Settings → Advanced → Interrupted jobs → Resume (and once Roll back); delete a folder; an Arabic- and
  emoji-named folder; a WebDAV/Nextcloud listing and an upload; then «Copy report» and send it — every «differed»,
  «fell back» and «planners disagree» should read 0.

**M6 — removal**: the replaced Java and libtorrent4j removed one release after each Rust default ran without
problems; final size and speed table.

**Subtitle matching** (listed under M1 in RUST-PORT.md) has no Java side: it is `src/player/subMatch.ts`, run in
the web view on every platform, so there is no Java to shadow and nothing on Android calls it natively. It moves
when a Rust caller needs it.

## M6 — what removal needs (checklist, written with M5 on 2026-11-15; nothing removed yet)

A Java engine goes only when (a) its Rust twin has been the **default** for one release with no problem reported,
(b) the evidence below is in, and (c) the owner says so. Until then every Java class stays as reference and fallback.
Note: the Release tools run 43651129552 (main, 2026-11-14) already packs `libkt_android.so` («Unable to strip …
libkt_android.so, … libtorrent4j.so») — released APKs carry the core, so released users can pick the Rust engines;
the defaults are still Java/Classic.

| What goes | Replaced by | Evidence required before removal | Saves (APK) |
|---|---|---|---|
| `KtDlRules` (M1) | kt-core `dlrules.rs` through `dl.*` | first a stage that **uses** Rust's answers (M1 only shadows); CI: «Std-only unit tests», «The JNI door from a plain JVM» (RustBridgeT); `rustShadow.mismatches` = 0 with `rustShadow.calls` ≥ 5 000 on the owner's debug build over ≥ 2 weeks | a few KB of dex (estimate) |
| `KtTranslate`'s cache key (M1) | `translatekey.rs` through `tr.*` | as KtDlRules; plus a translator session with a glossary on the phone (no cache miss after the switch) | < 5 KB (estimate) |
| `KrDownloader` (M2) — **not the in-app updater's use**, which stays Java unless moved | `KrDownloaderRs` + `httpdl.rs` | CI: «Java's downloader, runs 1–19» and «The same runs 1–19 through the Rust engine»; `dlEngineFallbacks` = 0 over ≥ 50 real downloads by the owner (Wi-Fi and mobile data, a signed GitHub redirect, a MEGA link, pause/resume, app killed mid-download, a refusing host); Rust the default for one release | ≈ 20–40 KB dex (estimate); the class itself stays while the updater uses it |
| `KtFileJobs.run` / `transfer` (M5) — its helpers (`inside`, `same`, `link`, `keepBoth`, `count`, `moveWhole`, `rename`) stay: the bin, KtFilePlan and KtFiles use them | `KtFileExec` executing `fileplan.rs`'s plan | CI: the «Stage M5» block (std-only, `fileplan.sh`, `filejobs-rust.sh`); `fileMismatches` = 0, `fileDisputed` = 0, `fileEngineFallbacks` = 0 and `fileReplanErrors` = 0 over ≥ 200 real jobs by the owner, with ≥ 20 moves to an SD card/USB stick, every conflict answer, ≥ 1 resume and ≥ 1 rollback after a kill; Rust the default for one release | ≈ 8 KB dex (estimate) |
| `KtFilePlan` (M5, Java's planner) | — **keep it** as the data-safety guard (Rust's destructive steps are checked against it), unless the owner decides otherwise after the row above holds for a further release | — | ≈ 6 KB dex (estimate) |
| `KtRemoteRules`'s Java half (M5) | `remoterules.rs` through `rm.*` | `remoteMismatches` = 0 and `remoteEngineFallbacks` = 0 over ≥ 30 remote sessions (WebDAV and Nextcloud listings with spaces/Arabic names, ≥ 5 uploads of folders) | < 5 KB dex (estimate) |
| `KtScreenTrack`, `KtScreenMotion`, `KtLettering`, `KtInpaint`, `KtHls` (M4, sister stage) | their kt-core modules | the M4 plan's CI rows (TkT, MoT, InT, HlsT ported, through the host library); its shadow counters (fields below) at 0 over ≥ 1 hour of screen translation and ≥ 20 HLS videos on the phone; NFC decided (crate or Java) | tens of KB dex (estimate) |
| **libtorrent4j** (M3, sister stage) | the Rust torrent engine (librqbit, M3) — not built yet | the M3 parity list (downloads, seeding, magnets, DHT/LSD/UPnP/NAT-PMP, encryption, proxy, binding, priorities, sequential, ratio/time limits, resume data) each proven in CI or on the phone; `torEngineFallbacks` = 0 over ≥ 30 torrents (incl. magnets, a seed to ratio, a resume after reboot); the Rust torrent engine the default for one release | **≈ 5.9 MB per ABI — an estimate** from docs/RUST-PORT.md: the CI logs readable here (runs 43617047751, 43651129552) list neither the APK's contents nor libtorrent4j's size; measure with `unzip -l` on the APK in CI before deciding |

**Order of removal** (lowest risk first, each its own release): M1's rules (after a stage that uses them) → M5's
classic executor and KtRemoteRules's Java half → M2's KrDownloader for user downloads (the updater's path last, or
never) → M4's classes → libtorrent4j last (it is the biggest and the riskiest, and M3 is not built). After each: the
full suite, the size table, the owner's phone run.

**The diagnostics readout** — Settings → Advanced → «Rust core status» (built in M5, `src/views/rustStatus.ts`,
tested by `tests/rustcore.cjs`): the core's version, each engine in use and chosen with its fallbacks, checks and
mismatches, the shadow's calls and mismatches, the file jobs' journal (resumable / undoable), the items skipped for
disagreement, and «Copy report» (every deviceInfo field as text; deviceInfo carries no secret). It reads whatever
deviceInfo gives and shows a line per engine it finds, so a stage not merged yet simply has none. **The contract each
stage's deviceInfo must follow** (one prefix per area: `dl`, `file`, `remote`, `tor`, `screen`, `hls`):
- `<area>Engine` (in use: `java`/`classic`/`rust`), `<area>EngineChoice`, `<area>EngineFallbacks` (number);
- `<area>Checks`, `<area>Mismatches` (numbers: comparisons with the Java reference and their differences) and
  `<area>First` (≤ 5 strings) when the stage compares;
- or, instead, rows in a list `rustEngines: [{area, inUse, choice, fallbacks, checks, mismatches}]`.
Already exposed: M1 `rustCore`, `rustCoreStatus`, `rustShadow{on, calls, mismatches, first}`; M2 `dlEngine`,
`dlEngineChoice`, `dlEngineFallbacks` (M2 has no `dlChecks`/`dlMismatches` — its decisions are not shadowed; the
fallback count is its evidence); M5 `fileEngine*`, `fileChecks`, `fileMismatches`, `fileFirst`, `fileDisputed`,
`fileJobsRust`, `fileReplanErrors`, `fileJournalResumable`, `fileJournalUndoable`, `fileJournalSkipped`,
`remoteEngine*`, `remoteChecks`, `remoteMismatches`. M3 and M4 must add theirs under `tor`, `screen`, `hls` (the
card already has names for them in all five languages).
