#!/bin/sh
# The Files jobs: KtFileJobs (copy / move / delete / rename — the very code the app runs) compiled outside its package
# with FilesT.java, which moves and copies real files in temp folders (a second volume, /dev/shm, for the moves that copy).
set -e
HERE=$(cd "$(dirname "$0")" && pwd); D=$(mktemp -d); LIB=${KT_JARS:-$HOME/.cache/kt-test-jars}; mkdir -p "$LIB" "$D/src"
J="$LIB/json-20240303.jar"; [ -s "$J" ] || for t in 1 2 3 4; do curl -sSfL -o "$J" https://repo1.maven.org/maven2/org/json/json/20240303/json-20240303.jar && break; sleep 4; done
sed 's/^package app.kurokawa.tools;//; s/^final class KtFileJobs/public final class KtFileJobs/' "${KT_FILEJOBS:-$HERE/../../native/android/KtFileJobs.java}" > "$D/src/KtFileJobs.java"
cp "$HERE/FilesT.java" "$D/src/"
cd "$D"; javac -nowarn -cp "$J" -d out src/KtFileJobs.java src/FilesT.java
s=0; java -cp "out:$J" FilesT || s=$?; rm -rf "$D"; exit $s
