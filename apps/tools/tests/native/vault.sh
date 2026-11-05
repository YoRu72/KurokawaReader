#!/bin/sh
# The archive engine: KtArchive compiled outside its package (android.util.Log stubbed) with VaultT.java — volumes, names' charsets.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); D=$(mktemp -d); LIB=${KT_JARS:-$HOME/.cache/kt-test-jars}; mkdir -p "$LIB" "$D/src/android/util"
M=https://repo1.maven.org/maven2
for a in org/apache/commons/commons-compress/1.27.1/commons-compress-1.27.1.jar org/tukaani/xz/1.10/xz-1.10.jar commons-io/commons-io/2.16.1/commons-io-2.16.1.jar org/apache/commons/commons-lang3/3.16.0/commons-lang3-3.16.0.jar com/github/junrar/junrar/7.5.5/junrar-7.5.5.jar org/slf4j/slf4j-api/1.7.36/slf4j-api-1.7.36.jar net/lingala/zip4j/zip4j/2.11.5/zip4j-2.11.5.jar org/json/json/20240303/json-20240303.jar; do
  f="$LIB/$(basename "$a")"; [ -s "$f" ] || for t in 1 2 3 4; do curl -sSfL -o "$f" "$M/$a" && break; sleep 4; done
done
echo 'package android.util; public final class Log { public static int w(String t, String m) { return 0; } public static int w(String t, String m, Throwable e) { return 0; } public static int i(String t, String m) { return 0; } public static int e(String t, String m, Throwable e) { return 0; } public static int d(String t, String m) { return 0; } }' > "$D/src/android/util/Log.java"
sed 's/^package app.kurokawa.tools;//; s/^public final class KtArchive/public final class KtArchive/' "$HERE/../../native/android/KtArchive.java" > "$D/src/KtArchive.java"
sed 's/^package app.kurokawa.tools;//; s/^final class KtVault/public final class KtVault/' "$HERE/../../native/android/KtVault.java" > "$D/src/KtVault.java"
# (KtFiles pulls in Android; the two bits KtVault needs are stubbed.)
printf 'import java.io.File; final class KtFiles { interface Events { void on(org.json.JSONObject ev); } static File keepBoth(File to) { String n = to.getName(); String ext = ""; int dot = n.lastIndexOf(46); if (dot > 0) { ext = n.substring(dot); n = n.substring(0, dot); } File f = to; for (int i = 2; f.exists(); i++) f = new File(to.getParentFile(), n + " (" + i + ")" + ext); return f; } }' > "$D/src/KtFilesStub.java"

cp "$HERE/VaultT.java" "$D/src/"
CP=$(ls "$LIB"/*.jar | tr '\n' ':'); cd "$D"
javac -nowarn -cp "$CP" -d out src/android/util/Log.java src/KtArchive.java src/KtVault.java src/KtFilesStub.java src/VaultT.java
java -cp "out:$CP" VaultT
