#!/bin/sh
# Stage M4's proof on the computer: the screen translator's jobs (KtScreenTrack, KtScreenMotion, KtInpaint, KtLettering's
# rules) and KtHls's playlists asked of the host build of the library through the app's own KtCore door.
#  1. tests/native's TkT, MoT, InT, TrT and HlsT under shadow mode — every call asked of Java and Rust, any difference
#     fails —, then TkT, MoT, InT and HlsT with the Rust engine chosen (strict: no call may fall back to Java);
#  2. ScreenRustT parity (random readings, signatures, pictures, playlists, addresses; the tolerance; the patch cache);
#  3. ScreenRustT bench (Java against Rust, JNI copies counted; host numbers) — printed, never failing on speed;
#  4. with no library: Java alone.
# Usage: sh screen-rust.sh <libkt_android.so built for this computer>
set -e
SO=$(cd "$(dirname "$1")" && pwd)/$(basename "$1"); [ -f "$SO" ] || { echo "no library at $1"; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd); A="$HERE/../../../native/android"; N="$HERE/../../../tests/native"; D=$(mktemp -d)
trap 'rm -rf "$D"' EXIT
mkdir -p "$D/android/util" "$D/android/content"
echo 'package android.util; public final class Log { public static int w(String t, String m) { return 0; } public static int w(String t, String m, Throwable e) { return 0; } public static int i(String t, String m) { return 0; } public static int e(String t, String m, Throwable e) { return 0; } public static int d(String t, String m) { return 0; } }' > "$D/android/util/Log.java"
echo 'package android.content; public class Context {}' > "$D/android/content/Context.java"
printf 'import java.io.*; import java.net.*; final class KrDownloader { interface Opener { HttpURLConnection open(URL url) throws IOException; } static final class Status extends IOException { final int code; Status(int c) { super("HTTP " + c); code = c; } } }' > "$D/KrDownloader.java"
printf 'import java.io.File; final class KtPacks { static String installed(android.content.Context c, String n) { return null; } static File ffmpegBin(android.content.Context c) { return null; } static ProcessBuilder command(android.content.Context c, File b, java.util.List<String> a) throws Exception { throw new IllegalStateException("pack:ffmpeg"); } }' > "$D/KtPacks.java"
for f in KtJson KtTranslate KtLettering KtScreenMotion KtScreenTrack KtInpaint KtScreenRs KtHls KtHlsRs KrDoh; do sed "s/^final class $f/public final class $f/; s/^package .*;//" "$A/$f.java" > "$D/$f.java"; done
cp "$A/KtCore.java" "$HERE/ScreenRustT.java" "$N/TkT.java" "$N/MoT.java" "$N/InT.java" "$N/TrT.java" "$N/HlsT.java" "$D/"; cp -r "$N/doh/org" "$D/"
# (The Rust-engine run of HlsT: its one KtHls.run call asks for the Rust reading.)
sed 's/last\[1\] = pieces; });/last[1] = pieces; }, true);/' "$N/HlsT.java" > "$D/HlsRsT.java"; sed -i 's/public class HlsT/public class HlsRsT/' "$D/HlsRsT.java"
grep -q '}, true);' "$D/HlsRsT.java" || { echo "HlsT not switched to the Rust reading"; exit 1; }
cd "$D"; S="org/json/JSONObject.java org/json/JSONArray.java KrDoh.java android/util/Log.java android/content/Context.java KrDownloader.java KtPacks.java KtCore.java KtJson.java KtTranslate.java KtLettering.java KtScreenMotion.java KtScreenTrack.java KtInpaint.java KtScreenRs.java KtHls.java KtHlsRs.java TkT.java MoT.java InT.java TrT.java HlsT.java HlsRsT.java ScreenRustT.java"
javac -encoding UTF-8 -nowarn -d out $S 2>/dev/null || javac -encoding UTF-8 -d out $S
J="java -Dkt.core.lib=$SO -cp out"
for t in TkT MoT InT TrT HlsT; do echo "== $t under shadow mode"; $J ScreenRustT shadow $t > log.txt 2>&1 || { cat log.txt; exit 1; }; grep -v '^ok' log.txt | tail -3; done
for t in TkT MoT InT HlsRsT; do echo "== $t with the Rust engine"; $J ScreenRustT rust $t > log.txt 2>&1 || { cat log.txt; exit 1; }; grep -v '^ok' log.txt | tail -3; done
echo "== parity"; $J ScreenRustT parity
echo "== benchmark (host numbers)"; $J ScreenRustT bench
echo "== no library"; java -Dkt.core.lib="$D/no-such-lib.so" -cp out ScreenRustT absent
echo "screen translator and HLS through the Rust core: all passed"
