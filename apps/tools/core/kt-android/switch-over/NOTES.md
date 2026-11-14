# Switching the Rust core on in the released APKs

**Applied in 0.17.0, unconditionally** (no repository variable): the step runs in every release with
`continue-on-error`, and the libraries are copied only when all three ABIs built — otherwise the APKs are built exactly
as before. To turn it off: delete the step «Rust core for Android (optional)» in release-tools.yml. The text below is
the plan as it was written.

`release-tools-android.patch` (beside this file) adds one step to the Android job of
`.github/workflows/release-tools.yml`, right after «Create Android project»: build `libkt_android.so` for the three
ABIs (`core/kt-android/build-android.sh`) and copy it into `android/app/src/main/jniLibs/<abi>/`, before Gradle runs.
Checked with `git apply --check` against release-tools.yml as of 649dd1d.

Apply it with `git apply apps/tools/core/kt-android/switch-over/release-tools-android.patch` when stage M1 has
passed `android-rust-check.yml` and a debug APK has been tried on the owner's phone.

## What flips it

- The step runs only when the repository variable **`KT_RUST_ANDROID` is `1`**
  (Settings → Secrets and variables → Actions → Variables). Without the variable the release is exactly today's.
- `continue-on-error: true` and copy-after-success: a Rust or NDK failure leaves `jniLibs` empty, Gradle builds as
  today (the default `jniLibs` folder needs no Gradle change), the app reports «Rust core: absent» and keeps its Java
  code. A Rust build failure can never block an Android release.

## What changes for users when it is on (stage M1)

Nothing visible. The library is loaded once in the background at start, its state goes to the log, `deviceInfo`
gains `rustCore` / `rustCoreStatus` / `rustShadow` (no UI reads them). The shadow mode is on only in debuggable builds,
so a released APK never asks Rust anything. The APKs grow by the library's compressed size (the size table of
`android-rust-check.yml`; about 0.15–0.2 MB per ABI APK, about 0.5 MB on the universal one).

## How to turn it off

- Quick: delete the variable or set it to anything but `1`; the next release has no library.
- For good: revert the patch (`git apply -R …`).
- In the app nothing needs undoing: every caller falls back to Java when the library is absent.
