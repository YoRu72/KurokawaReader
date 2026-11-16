#!/bin/sh
# KtSign — KtStream's signed addresses (/audio's over its one source, as /file's and /proxy's) — compiled outside its
# package with SignT.java; SignT also reads KtStream.java and KtPlugin.java for /audio's check and CORS.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); D=$(mktemp -d)
sed 's/^package app.kurokawa.tools;//; s/^final class KtSign/public final class KtSign/' "$HERE/../../native/android/KtSign.java" > "$D/KtSign.java"
cp "$HERE/SignT.java" "$D/"; cd "$D"
javac -nowarn -d out KtSign.java SignT.java
java -cp out SignT "$HERE/../../native/android/KtStream.java" "$HERE/../../native/android/KtPlugin.java"
rm -rf "$D"
