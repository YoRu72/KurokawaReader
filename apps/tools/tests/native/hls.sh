#!/bin/sh
# The HLS downloader: KtHls compiled outside its package (KtPacks and KrDownloader stubbed) with HlsT.java — variants, AES-128, byte ranges, disguised pieces, retries.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); D=$(mktemp -d); mkdir -p "$D/src/android/util" "$D/src/android/content"
echo 'package android.util; public final class Log { public static int w(String t, String m) { return 0; } public static int w(String t, String m, Throwable e) { return 0; } public static int i(String t, String m) { return 0; } public static int e(String t, String m, Throwable e) { return 0; } public static int d(String t, String m) { return 0; } }' > "$D/src/android/util/Log.java"
echo 'package android.content; public class Context {}' > "$D/src/android/content/Context.java"
sed 's/^package app.kurokawa.tools;//; s/^final class KtHls/public final class KtHls/' "$HERE/../../native/android/KtHls.java" > "$D/src/KtHls.java"
printf 'import java.io.*; import java.net.*; final class KrDownloader { interface Opener { HttpURLConnection open(URL url) throws IOException; } static final class Status extends IOException { final int code; Status(int c) { super("HTTP " + c); code = c; } } }' > "$D/src/KrDownloader.java"
printf 'import java.io.File; final class KtPacks { static String installed(android.content.Context c, String n) { return null; } static File ffmpegBin(android.content.Context c) { return null; } static ProcessBuilder command(android.content.Context c, File b, java.util.List<String> a) throws Exception { throw new IllegalStateException("pack:ffmpeg"); } }' > "$D/src/KtPacks.java"
cp "$HERE/HlsT.java" "$D/src/"; cd "$D"
javac -nowarn -d out src/android/util/Log.java src/android/content/Context.java src/KrDownloader.java src/KtPacks.java src/KtHls.java src/HlsT.java
java -cp out HlsT
