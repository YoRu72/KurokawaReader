#!/bin/sh
# Compiles KrDownloader.java (outside its package) with T.java and runs it in a scratch folder.
set -e
D=$(mktemp -d); HERE=$(cd "$(dirname "$0")" && pwd)
trap 'rm -rf "$D"' EXIT   # (the test files — some 300 MB a run — gone when it ends)
sed 's/^final class KrDownloader/public final class KrDownloader/; s/^package .*;//' "$HERE/../../native/android/KrDownloader.java" > "$D/KrDownloader.java"
cp "$HERE/T.java" "$D/"; cd "$D"; javac -nowarn -d out KrDownloader.java T.java 2>/dev/null || javac -d out KrDownloader.java T.java
java -cp out T && echo "downloader: all passed"
