#!/bin/sh
# Stage M2's proof: tests/native/T.java — the Android downloader's runs 1–19 against its loopback server — driven
# through the Rust engine (KrDownloaderRs: every decision asked of the library built for this computer, through the
# app's own KtCore door), the test itself unchanged but for the class it calls. `kt.dl.strict` makes a missing or
# unloadable library fail the run instead of falling back to Java silently. Java's own runs stay in
# tests/native/downloader.sh, unchanged beside this. Usage: sh downloader-rust.sh <libkt_android.so for this computer>
set -e
SO=$(cd "$(dirname "$1")" && pwd)/$(basename "$1"); [ -f "$SO" ] || { echo "no library at $1"; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd); A="$HERE/../../../native/android"; N="$HERE/../../../tests/native"; D=$(mktemp -d)
trap 'rm -rf "$D"' EXIT   # (the test files — some 300 MB a run — gone when it ends)
for f in KrDownloader KrDownloaderRs; do sed "s/^final class $f/public final class $f/; s/^package .*;//" "$A/$f.java" > "$D/$f.java"; done
cp "$A/KtCore.java" "$D/"
# (Only the engine changes: every KrDownloader.fetch( becomes KrDownloaderRs.fetch( — the same arguments, Result, Opts.)
sed 's/KrDownloader\.fetch(/KrDownloaderRs.fetch(/g' "$N/T.java" > "$D/T.java"
grep -q 'KrDownloaderRs.fetch(' "$D/T.java" && ! grep -q 'KrDownloader\.fetch(' "$D/T.java" || { echo "T.java not switched to the Rust engine"; exit 1; }
cd "$D"; S="KtCore.java KrDownloader.java KrDownloaderRs.java T.java"
javac -encoding UTF-8 -nowarn -d out $S 2>/dev/null || javac -encoding UTF-8 -d out $S
java -Dkt.core.lib="$SO" -Dkt.dl.strict=true -cp out T && echo "downloader through the Rust engine: all passed"
