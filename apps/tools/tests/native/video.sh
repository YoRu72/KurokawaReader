#!/bin/sh
# yt-dlp on the phone: KtVideo compiled outside its package against stand-ins of youtubedl-android (a scripted yt-dlp
# that answers late, fails or succeeds as told — never a real one, no network), Android's Context and Log, the packs and
# cookie jars, with VideoT.java: the look given up after its time with yt-dlp's process ended, a look cancelled by its
# token, the look's flags, the read page reused by the download and the automatic run with the address when that fails,
# one deliberate playlist flag, QuickJS named when the APK carries it, and the one update-and-retry on an extractor error.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); D=$(mktemp -d); LIB=${KT_JARS:-$HOME/.cache/kt-test-jars}; mkdir -p "$LIB"
J="$LIB/json-20240303.jar"; [ -s "$J" ] || for t in 1 2 3 4; do curl -sSfL -o "$J" "https://repo1.maven.org/maven2/org/json/json/20240303/json-20240303.jar" && break; sleep 4; done
mkdir -p "$D/src/android/util" "$D/src/android/content/pm" "$D/src/kotlin/jvm/functions" "$D/src/com/yausername/youtubedl_android" "$D/src/com/yausername/ffmpeg"
echo 'package android.util; public final class Log { public static int w(String t, String m) { return 0; } public static int w(String t, String m, Throwable e) { return 0; } public static int i(String t, String m) { return 0; } public static int e(String t, String m, Throwable e) { return 0; } public static int d(String t, String m) { return 0; } }' > "$D/src/android/util/Log.java"
echo 'package android.content.pm; public class ApplicationInfo { public String nativeLibraryDir; }' > "$D/src/android/content/pm/ApplicationInfo.java"
echo 'package android.content; public class Context { public static java.io.File root; public static String libs; public java.io.File getCacheDir() { return new java.io.File(root, "cache"); } public java.io.File getNoBackupFilesDir() { return new java.io.File(root, "nobackup"); } public android.content.pm.ApplicationInfo getApplicationInfo() { android.content.pm.ApplicationInfo a = new android.content.pm.ApplicationInfo(); a.nativeLibraryDir = libs; return a; } }' > "$D/src/android/content/Context.java"
echo 'package kotlin; public final class Unit { public static final Unit INSTANCE = new Unit(); }' > "$D/src/kotlin/Unit.java"
echo 'package kotlin.jvm.functions; public interface Function3<A, B, C, R> { R invoke(A a, B b, C c); }' > "$D/src/kotlin/jvm/functions/Function3.java"
echo 'package com.yausername.ffmpeg; public class FFmpeg { static final FFmpeg I = new FFmpeg(); public static FFmpeg getInstance() { return I; } public void init(android.content.Context c) {} }' > "$D/src/com/yausername/ffmpeg/FFmpeg.java"
cat > "$D/src/com/yausername/youtubedl_android/YoutubeDLRequest.java" <<'J'
package com.yausername.youtubedl_android; import java.util.*;
public class YoutubeDLRequest { public final List<String> urls; public final List<String> opts = new ArrayList<>();
  public YoutubeDLRequest(String url) { urls = new ArrayList<>(Collections.singletonList(url)); } public YoutubeDLRequest(List<String> u) { urls = new ArrayList<>(u); }
  public YoutubeDLRequest addOption(String o) { opts.add(o); return this; } public YoutubeDLRequest addOption(String o, String v) { opts.add(o); opts.add(v); return this; }
  public List<String> buildCommand() { List<String> c = new ArrayList<>(opts); c.addAll(urls); return c; } }
J
cat > "$D/src/com/yausername/youtubedl_android/YoutubeDLResponse.java" <<'J'
package com.yausername.youtubedl_android;
public class YoutubeDLResponse { final int code; final String out, err; public YoutubeDLResponse(int c, String o, String e) { code = c; out = o; err = e; } public int getExitCode() { return code; } public String getOut() { return out; } public String getErr() { return err; } }
J
cat > "$D/src/com/yausername/youtubedl_android/YoutubeDL.java" <<'J'
package com.yausername.youtubedl_android; import java.util.*;
/** A scripted stand-in: each execute() takes the next answer (delay ms, exit code, out, err) and records the command. */
public class YoutubeDL { static final YoutubeDL I = new YoutubeDL(); public static YoutubeDL getInstance() { return I; }
  public static final class UpdateChannel { public static final class STABLE { public static final STABLE INSTANCE = new STABLE(); } }
  public static final Deque<Object[]> script = new ArrayDeque<>(); public static final List<List<String>> ran = Collections.synchronizedList(new ArrayList<>()); public static final List<String> destroyed = Collections.synchronizedList(new ArrayList<>());
  public static String ver = "2026.10.10"; public static String verAfterUpdate = null; public static int updates = 0;
  private final Map<String, Thread> running = new java.util.concurrent.ConcurrentHashMap<>();
  public void init(android.content.Context c) {} public String version(android.content.Context c) { return ver; }
  public void updateYoutubeDL(android.content.Context c, Object ch) { updates++; if (verAfterUpdate != null) ver = verAfterUpdate; }
  public YoutubeDLResponse execute(YoutubeDLRequest r, String id, kotlin.jvm.functions.Function3<Float, Long, String, kotlin.Unit> cb) throws Exception {
    ran.add(r.buildCommand()); Object[] s = script.isEmpty() ? new Object[] { 0, 0, "{}", "" } : script.poll();
    if (id != null) running.put(id, Thread.currentThread());
    try { Thread.sleep(((Number) s[0]).longValue()); } catch (InterruptedException e) { throw new Exception("killed"); } finally { if (id != null) running.remove(id); }
    return new YoutubeDLResponse((Integer) s[1], (String) s[2], (String) s[3]); }
  public boolean destroyProcessById(String id) { destroyed.add(id); Thread t = running.remove(id); if (t != null) t.interrupt(); return t != null; } }
J
printf 'import java.io.File; final class KtPacks { static String installed(android.content.Context c, String n) { return "python".equals(n) ? "3.11" : null; } static File dir(android.content.Context c, String n) { return new File(android.content.Context.root, "packs/" + n); } }' > "$D/src/KtPacks.java"
printf 'import java.io.File; final class KtCookies { static File disposable(android.content.Context c, String jar) throws Exception { File f = File.createTempFile("jar", ".txt"); return f; } }' > "$D/src/KtCookies.java"
sed 's/^package app.kurokawa.tools;//; s/^final class KtVideo/public final class KtVideo/' "$HERE/../../native/android/KtVideo.java" > "$D/src/KtVideo.java"
cp "$HERE/VideoT.java" "$D/src/"; cd "$D"
javac -nowarn -cp "$J" -d out $(find src -name '*.java')
java -cp "out:$J" VideoT
