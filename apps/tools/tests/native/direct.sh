#!/bin/sh
# Compiles KrDownloader.java (outside its package) with D.java and runs it in a scratch folder (two local servers, made-up names).
set -e
D=$(mktemp -d); HERE=$(cd "$(dirname "$0")" && pwd)
trap 'rm -rf "$D"' EXIT
sed 's/^final class KrDownloader/public final class KrDownloader/; s/^package .*;//' "$HERE/../../native/android/KrDownloader.java" > "$D/KrDownloader.java"; sed 's/^package .*;//' "$HERE/../../native/android/KtNameSafe.java" > "$D/KtNameSafe.java"
cp "$HERE/D.java" "$D/"; cd "$D"; javac -nowarn -d out KrDownloader.java KtNameSafe.java D.java 2>/dev/null || javac -d out KrDownloader.java KtNameSafe.java D.java
java -cp out D
