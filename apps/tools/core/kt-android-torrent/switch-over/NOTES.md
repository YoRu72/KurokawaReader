# The Rust torrent engine in the released APKs (stage M3)

**Held — the loopback swarm must pass first.** (0.19.0, 2026-11-15: run 43684755996 built `libkt_torrent.so` for all
three ABIs with every call — arm64 6.05 MB `.so` / +2.67 MB APK, armeabi-v7a 3.66 / +1.98, x86_64 6.79 / +2.75, universal
+7.40 — but «M3: librqbit for the computer — loopback swarm» failed: the download stopped one 32 KiB piece short of the
12 582 912-byte file, peers coming and going, never «done» in 300 s. 0.19.0 ships without it; the patch stays unapplied.)

**Not applied.** `release-tools-torrent.patch` (beside this file) adds one step to the Android job of
`.github/workflows/release-tools.yml`, right after «Rust core for Android (optional)»: build `libkt_torrent.so` for the
three ABIs (`core/kt-android-torrent/build-android.sh`) and copy it into `android/app/src/main/jniLibs/<abi>/`
before Gradle runs. Checked with `git apply --check` against release-tools.yml as of b515d88.

Apply it with `git apply apps/tools/core/kt-android-torrent/switch-over/release-tools-torrent.patch` once
`android-rust-check.yml` has shown, in one run: «M3: libkt_torrent.so for Android» green for the three ABIs, «M3:
librqbit for the computer — loopback swarm» green, and the size table read and accepted by the owner.

## How it is safe (the same as the M0 core)

- **Unconditional but never blocking**: `continue-on-error: true`; the libraries are copied only when all three ABIs
  built, and a copy broken off midway deletes what it put there. Otherwise the APKs are built exactly as before.
- **Absent is normal**: without `libkt_torrent.so` the app reports `rustTorrent: null`, Settings → Advanced offers no
  «Rust» torrent engine, and every torrent is libtorrent4j's as today.
- **Default unchanged**: even with the library in the APK, «Torrent engine» is **Classic** until the owner chooses
  otherwise; a torrent's engine is chosen when it is added and kept, so a release changes no torrent under way.
- The build needs crates.io (librqbit, tokio, rustls/ring): the release runner has it. The build takes several
  minutes per ABI (LTO); the Android job's time grows by that.

## What the build says

`build.txt` (printed by the step) names, per ABI, «every call» or «proven calls only» — the second when a librqbit
call the PC never compiled failed and the library was built again with the calls stream_rqbit.rs proved
(`--no-default-features`). A «proven calls only» library: pausing drops the torrent and adding it again checks its
files; magnets are refused (handed to libtorrent at once, counted) because their folder cannot be known before the
metadata; no per-file progress, no upload count (the ratio limit then never stops seeding; the time limit does);
speed limits not applied; no extra trackers.

## How to turn it off

- Delete the step «Rust torrent engine for Android (optional)» from release-tools.yml, or `git apply -R` the patch.
- In the app nothing needs undoing: a torrent marked «rust» whose library is gone is given to libtorrent at the next
  start (marked classic; libtorrent checks the files in its folder and keeps every good piece).
