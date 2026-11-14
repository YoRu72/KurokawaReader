#!/usr/bin/env bash
# Builds libkt_android.so for the APK's three ABIs with the Android NDK already on the machine (GitHub's Ubuntu
# runners carry one) and puts them in <out>/<abi>/libkt_android.so — all three or none, so an APK never carries the
# library for one ABI and not another. Usage: build-android.sh <out-dir>
# No cargo-ndk: three linker variables are all it would set, and it is one more program fetched from crates.io.
# The API level is the app's minSdk (24: native/android/overlay.mjs raises Capacitor's to it; KT_ANDROID_API overrides).
set -euo pipefail
OUT="${1:?usage: build-android.sh <out-dir>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
API="${KT_ANDROID_API:-24}"
NDK="${ANDROID_NDK_LATEST_HOME:-${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-${ANDROID_NDK:-}}}}"
BIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
if [ -z "$NDK" ] || [ ! -d "$BIN" ]; then echo "::error::no Android NDK found (ANDROID_NDK_LATEST_HOME / ANDROID_NDK_HOME / ANDROID_NDK_ROOT / ANDROID_NDK)"; exit 1; fi
echo "NDK: $NDK ($(grep -m1 Pkg.Revision "$NDK/source.properties" 2>/dev/null || echo 'revision unknown')), API $API"
[ -n "${GITHUB_ENV:-}" ] && echo "KT_NDK_BIN=$BIN" >> "$GITHUB_ENV"

# triple | ABI folder | linker (the NDK's clang wrapper for that triple and API)
TARGETS=(
  "aarch64-linux-android|arm64-v8a|aarch64-linux-android$API-clang"
  "armv7-linux-androideabi|armeabi-v7a|armv7a-linux-androideabi$API-clang"
  "x86_64-linux-android|x86_64|x86_64-linux-android$API-clang"
)
for t in "${TARGETS[@]}"; do IFS='|' read -r triple abi cc <<<"$t"; [ -x "$BIN/$cc" ] || { echo "::error::missing $BIN/$cc"; ls "$BIN" | grep -- "-clang$" | head -40; exit 1; }; done
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android

export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$BIN/aarch64-linux-android$API-clang"
export CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_LINKER="$BIN/armv7a-linux-androideabi$API-clang"
export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER="$BIN/x86_64-linux-android$API-clang"
# (16 KB pages: Android 15 devices may use them; a 64-bit library linked for 4 KB pages does not load there.)
export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384"
export CARGO_TARGET_X86_64_LINUX_ANDROID_RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384"
export KT_CORE_REV="${GITHUB_SHA:-local}"; KT_CORE_REV="${KT_CORE_REV:0:7}"
TD="${CARGO_TARGET_DIR:-$HERE/target}"

STAGE="$(mktemp -d)"
for t in "${TARGETS[@]}"; do
  IFS='|' read -r triple abi cc <<<"$t"
  echo "::group::cargo build --release --target $triple"
  cargo build --release --locked --manifest-path "$HERE/Cargo.toml" --target "$triple"
  echo "::endgroup::"
  mkdir -p "$STAGE/$abi"; cp "$TD/$triple/release/libkt_android.so" "$STAGE/$abi/libkt_android.so"
done
mkdir -p "$OUT"; cp -R "$STAGE"/. "$OUT"/
ls -la "$OUT"/*/libkt_android.so
