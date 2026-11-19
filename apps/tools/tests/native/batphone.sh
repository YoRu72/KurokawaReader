#!/bin/sh
# Device battery on the phone (0.21 P2): KtBatPure (kinds, the headsets' own battery words, the notices' rule) compiled
# outside its package and run with BatT.java; then KtBattery.java compiled against batstubs.txt (the Android, AndroidX
# and Android's org.json signatures it uses, empty — nothing fetched) — a check of the Java itself, not of Android: GitHub's Android
# build is the real compile.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
mkdir -p "$D/a" "$D/b"
sed 's/^package app.kurokawa.tools;//; s/^final class KtBatPure/public final class KtBatPure/' "$HERE/../../native/android/KtBatPure.java" > "$D/a/KtBatPure.java"
cp "$HERE/BatT.java" "$D/a/"
javac -encoding UTF-8 -nowarn -d "$D/a/out" "$D/a/KtBatPure.java" "$D/a/BatT.java"
java -Dfile.encoding=UTF-8 -cp "$D/a/out" BatT
# (The stubs: one file per «//// path» section.)
awk -v d="$D/b" '/^\/\/\/\/ /{ f = d "/" $2; n = split($2, p, "/"); dir = d; for (i = 1; i < n; i++) dir = dir "/" p[i]; system("mkdir -p \"" dir "\""); next } f { print > f }' "$HERE/batstubs.txt"
cp "$D/a/KtBatPure.java" "$D/b/"
sed 's/^package app.kurokawa.tools;//' "$HERE/../../native/android/KtBattery.java" > "$D/b/KtBattery.java"
cd "$D/b"; javac -encoding UTF-8 -nowarn -d out $(find . -name '*.java')
echo "KtBattery: compiles against the stubs"
