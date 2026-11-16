#!/bin/sh
# The Rust core's JNI door tested on the computer (no emulator): KtCore.java with KtDlRules / KtTranslate (outside
# their package, as tests/native/*.sh do), the downloader's two engines (stage M2) and RustBridgeT.java, run once with the host build of the library and once
# with none (Java must carry on alone). Usage: sh run.sh <path to libkt_android.so built for this computer>
set -e
SO=$(cd "$(dirname "$1")" && pwd)/$(basename "$1"); [ -f "$SO" ] || { echo "no library at $1"; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd); A="$HERE/../../../native/android"; D=$(mktemp -d)
trap 'rm -rf "$D"' EXIT   # (the test files — some 300 MB a run — gone when it ends)
for f in KtDlRules KtJson KtLettering KtTranslate KtNameSafe KrDownloader KrDownloaderRs; do sed "s/^final class $f/public final class $f/; s/^package .*;//" "$A/$f.java" > "$D/$f.java"; done
cp "$A/KtCore.java" "$HERE/RustBridgeT.java" "$D/"; cd "$D"
S="KtCore.java KtDlRules.java KtJson.java KtLettering.java KtTranslate.java KtNameSafe.java KrDownloader.java KrDownloaderRs.java RustBridgeT.java"
javac -encoding UTF-8 -nowarn -d out $S 2>/dev/null || javac -encoding UTF-8 -d out $S
java -Dkt.core.lib="$SO" -cp out RustBridgeT
java -Dkt.core.lib="$D/no-such-lib.so" -cp out RustBridgeT absent
