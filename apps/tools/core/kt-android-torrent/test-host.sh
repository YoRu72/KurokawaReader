#!/bin/sh
# The torrent library's std part on a computer with no crates.io (stage M3): kt-core built by cargo (std only), then
# this crate's dispatch with the stand-in backend (src/fake.rs, `--cfg kt_fake`) — its unit test, and the cdylib the
# JVM test loads through Java's KtTorrentCore (jvmtest/torrent.sh). librqbit is not in either: CI builds and tests the
# real one. Usage: sh test-host.sh <out-dir>   → <out-dir>/libkt_torrent.so (the stand-in)
set -e
HERE=$(cd "$(dirname "$0")" && pwd); OUT=$(mkdir -p "${1:?usage: test-host.sh <out-dir>}" && cd "$1" && pwd)
LOCK="$HERE/../kt-core/Cargo.lock"; had=0; [ -f "$LOCK" ] && had=1
cargo build --offline --release --manifest-path "$HERE/../kt-core/Cargo.toml" --target-dir "$OUT/kt-core-target" -q
[ "$had" = 1 ] || rm -f "$LOCK"   # (kt-core keeps no lock of its own)
export CARGO_PKG_VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$HERE/Cargo.toml" | head -1)"
RLIB="$OUT/kt-core-target/release/libkt_core.rlib"
rustc --edition 2021 --cfg kt_fake --test "$HERE/src/lib.rs" --crate-name kt_torrent --extern kt_core="$RLIB" -L "$OUT/kt-core-target/release/deps" -o "$OUT/kt-torrent-tests"
"$OUT/kt-torrent-tests"
rustc --edition 2021 --cfg kt_fake -C opt-level=2 -C panic=unwind --crate-type cdylib "$HERE/src/lib.rs" --crate-name kt_torrent --extern kt_core="$RLIB" -L "$OUT/kt-core-target/release/deps" -o "$OUT/libkt_torrent.so"
ls -la "$OUT/libkt_torrent.so"
