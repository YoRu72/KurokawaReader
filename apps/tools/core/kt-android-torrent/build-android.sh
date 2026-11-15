#!/usr/bin/env bash
# Builds libkt_torrent.so (stage M3: librqbit) for the APK's three ABIs with the runner's Android NDK and puts them in
# <out>/<abi>/libkt_torrent.so — all three or none. Usage: build-android.sh <out-dir>
# The first library of this app with C in it: librqbit's TLS (rustls → ring, or aws-lc-rs if a crate asks for it)
# compiles C and assembly through the `cc` crate, which reads CC_<triple> / AR_<triple> — set here to the NDK's clang
# wrapper for the triple and API, and its llvm-ar. Linker, API (24 = the app's minSdk) and 16 KB pages as in
# ../kt-android/build-android.sh. No cargo-ndk (it would set only these). Each ABI is built first with every librqbit
# call («unproven», the default features) and, when that fails, again with the calls the PC proved only
# (--no-default-features; deviceInfo then reports «proven calls only»); the build that worked is said in the log
# and in <out>/build.txt. Needs crates.io (Cargo.lock is made here: none is committed for this crate).
set -euo pipefail
OUT="${1:?usage: build-android.sh <out-dir>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
API="${KT_ANDROID_API:-24}"
NDK="${ANDROID_NDK_LATEST_HOME:-${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-${ANDROID_NDK:-}}}}"
BIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
if [ -z "$NDK" ] || [ ! -d "$BIN" ]; then echo "::error::no Android NDK found"; exit 1; fi
echo "NDK: $NDK ($(grep -m1 Pkg.Revision "$NDK/source.properties" 2>/dev/null || echo 'revision unknown')), API $API"
export ANDROID_NDK_HOME="$NDK" ANDROID_NDK_ROOT="$NDK"
TARGETS=(
  "aarch64-linux-android|arm64-v8a|aarch64-linux-android$API-clang"
  "armv7-linux-androideabi|armeabi-v7a|armv7a-linux-androideabi$API-clang"
  "x86_64-linux-android|x86_64|x86_64-linux-android$API-clang"
)
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
for t in "${TARGETS[@]}"; do
  IFS='|' read -r triple abi cc <<<"$t"
  [ -x "$BIN/$cc" ] || { echo "::error::missing $BIN/$cc"; exit 1; }
  u=$(echo "$triple" | tr 'a-z-' 'A-Z_'); l=$(echo "$triple" | tr '-' '_')
  export "CARGO_TARGET_${u}_LINKER=$BIN/$cc" "CC_${l}=$BIN/$cc" "CXX_${l}=$BIN/${cc}++" "AR_${l}=$BIN/llvm-ar" "RANLIB_${l}=$BIN/llvm-ranlib"
done
export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384"
export CARGO_TARGET_X86_64_LINUX_ANDROID_RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384"
TD="${CARGO_TARGET_DIR:-$HERE/target}"
STAGE="$(mktemp -d)"; : > "$STAGE/build.txt"
for t in "${TARGETS[@]}"; do
  IFS='|' read -r triple abi cc <<<"$t"
  echo "::group::cargo build --release --target $triple (every call)"
  if cargo build --release --manifest-path "$HERE/Cargo.toml" --target "$triple"; then how="every call"
  else
    echo "::endgroup::"; echo "::warning::libkt_torrent for $abi: the build with every librqbit call failed — again with the proven calls only"
    echo "::group::cargo build --release --target $triple --no-default-features (proven calls only)"
    cargo build --release --manifest-path "$HERE/Cargo.toml" --target "$triple" --no-default-features; how="proven calls only"
  fi
  echo "::endgroup::"
  mkdir -p "$STAGE/$abi"; cp "$TD/$triple/release/libkt_torrent.so" "$STAGE/$abi/libkt_torrent.so"
  echo "$abi: $how" | tee -a "$STAGE/build.txt"
done
mkdir -p "$OUT"; cp -R "$STAGE"/. "$OUT"/
ls -la "$OUT"/*/libkt_torrent.so
