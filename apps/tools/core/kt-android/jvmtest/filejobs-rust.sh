#!/bin/sh
# Stage M5 on the computer: the Files jobs through the Rust engine (Rust plans, Java executes), with the host build of
# the library. (1) tests/native/FilesT.java's cases unchanged but for the door they call — KtFileExec, the Rust engine,
# strict (no silent Java plan); (2) FileJobsRustT.java: the two planners on random trees, the two engines on temp
# folders, a failed rename, a full disk, odd names, a tampered plan, the journal killed at every record and resumed or
# rolled back, undo, and the small rules; (3) the same with no library: the classic engine, silently.
# Usage: sh filejobs-rust.sh <path to libkt_android.so built for this computer>
set -e
SO=$(cd "$(dirname "$1")" && pwd)/$(basename "$1"); [ -f "$SO" ] || { echo "no library at $1"; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd); A="$HERE/../../../native/android"; T="$HERE/../../../tests/native"; D=$(mktemp -d)
J=$(sh "$T/jsonjar.sh")
trap 'rm -rf "$D"' EXIT
mkdir -p "$D/src"
for f in KtFileJobs KtFilePlan KtFileExec KtRemoteRules; do sed "s/^final class $f/public final class $f/; s/^package .*;//" "$A/$f.java" > "$D/src/$f.java"; done
cp "$A/KtCore.java" "$D/src/"
# (FilesT through the Rust engine: its job() calls KtFileExec.run, and main() first chooses Rust, strictly.)
sed 's/KtFileJobs\.run(id, op/KtFileExec.run(id, op/; s/public class FilesT/public class FilesRustT/; 1s/^/import app.kurokawa.tools.KtCore; /; s/public static void main(String\[\] a) throws Exception {/public static void main(String[] a) throws Exception { if (!KtCore.available()) throw new Error("no core"); KtFileExec.choice = "rust"; KtFileExec.strict = true;/' "$T/FilesT.java" > "$D/src/FilesRustT.java"
grep -q 'KtFileExec.run(id, op' "$D/src/FilesRustT.java" || { echo "FilesT no longer calls KtFileJobs.run as expected"; exit 1; }
cp "$HERE/FileJobsRustT.java" "$D/src/"
export LC_ALL=C.UTF-8 LANG=C.UTF-8   # (file names in UTF-8: the Arabic and emoji names)
cd "$D"; javac -encoding UTF-8 -nowarn -cp "$J" -d out src/*.java
echo "== FilesT through the Rust engine"; java -Dkt.core.lib="$SO" -cp "out:$J" FilesRustT
echo "== FileJobsRustT"; java -Dkt.core.lib="$SO" -cp "out:$J" FileJobsRustT
echo "== no library"; java -Dkt.core.lib="$D/no-such-lib.so" -cp "out:$J" FileJobsRustT absent
