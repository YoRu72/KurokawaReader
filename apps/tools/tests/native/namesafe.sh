#!/bin/sh
# KtNameSafe (the phone's twin of desktop/archsafe.cjs) compiled outside its package and run on the shared vectors.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
sed 's/^package app.kurokawa.tools;//' "$HERE/../../native/android/KtNameSafe.java" > "$D/KtNameSafe.java"; cp "$HERE/NameSafeT.java" "$D/"
cd "$D"; javac -encoding UTF-8 -nowarn -d out KtNameSafe.java NameSafeT.java
java -Dfile.encoding=UTF-8 -cp out NameSafeT "$HERE/../data/namesafe-vectors.tsv"
