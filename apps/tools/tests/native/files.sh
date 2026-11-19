#!/bin/sh
# The Files jobs: KtFileJobs (copy / move / delete / rename — the very code the app runs) compiled outside its package
# with FilesT.java, which moves and copies real files in temp folders (a second volume, /dev/shm, for the moves that copy).
set -e
HERE=$(cd "$(dirname "$0")" && pwd); D=$(mktemp -d); LIB=${KT_JARS:-$HOME/.cache/kt-test-jars}; mkdir -p "$LIB" "$D/src"
J=$(sh "$HERE/jsonjar.sh")
sed 's/^package app.kurokawa.tools;//; s/^final class KtFileJobs/public final class KtFileJobs/' "${KT_FILEJOBS:-$HERE/../../native/android/KtFileJobs.java}" > "$D/src/KtFileJobs.java"
cp "$HERE/FilesT.java" "$D/src/"
cd "$D"; javac -nowarn -cp "$J" -d out src/KtFileJobs.java src/FilesT.java
s=0; java -cp "out:$J" FilesT || s=$?; rm -rf "$D"; exit $s
