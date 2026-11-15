#!/bin/sh
# Stage M5 (the Rust port's file jobs), its Java half alone — no Rust library: FilesT.java's cases run through the
# planned engine (KtFilePlan plans, KtFileExec executes; the Rust core absent, so Java's plan is the one run), the very
# classes the app ships, on temp folders with a second volume (/dev/shm) for the moves that copy. Beside files.sh,
# which runs the same cases through the classic KtFileJobs.run.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); D=$(mktemp -d); LIB=${KT_JARS:-$HOME/.cache/kt-test-jars}; mkdir -p "$LIB" "$D/src"
J="$LIB/json-20240303.jar"; [ -s "$J" ] || for t in 1 2 3 4; do curl -sSfL -o "$J" https://repo1.maven.org/maven2/org/json/json/20240303/json-20240303.jar && break; sleep 4; done
A="$HERE/../../native/android"
for f in KtFileJobs KtFilePlan KtFileExec KtRemoteRules; do sed "s/^package app.kurokawa.tools;//; s/^final class $f/public final class $f/" "$A/$f.java" > "$D/src/$f.java"; done
cp "$A/KtCore.java" "$D/src/"
sed 's/KtFileJobs\.run(id, op/KtFileExec.run(id, op/; s/public class FilesT/public class FilesPlanT/; 1s/^/import app.kurokawa.tools.KtCore; /; s/public static void main(String\[\] a) throws Exception {/public static void main(String[] a) throws Exception { KtFileExec.planned = true; KtFileExec.choice = "rust"; if (KtCore.available()) throw new Error("a library was found: this test is for Java alone");/' "$HERE/FilesT.java" > "$D/src/FilesPlanT.java"
grep -q 'KtFileExec.run(id, op' "$D/src/FilesPlanT.java" || { echo "FilesT no longer calls KtFileJobs.run as expected"; exit 1; }
cd "$D"; javac -encoding UTF-8 -nowarn -cp "$J" -d out src/*.java
s=0; java -Dkt.core.lib="$D/none.so" -cp "out:$J" FilesPlanT || s=$?; rm -rf "$D"; exit $s
