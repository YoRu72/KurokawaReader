package app.kurokawa.tools;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        catchCrashes(getApplicationContext());
        noteLastExit(getApplicationContext());
        registerPlugin(KtPlugin.class);
        super.onCreate(savedInstanceState);
        // The page's renderer ending (a crash or Android reclaiming its memory) would take the whole app with it:
        // written down, and the page loaded again instead.
        try {
            getBridge().setWebViewClient(new com.getcapacitor.BridgeWebViewClient(getBridge()) {
                @Override public boolean onRenderProcessGone(android.webkit.WebView view, android.webkit.RenderProcessGoneDetail detail) {
                    note(getApplicationContext(), "the page's renderer ended (" + (detail != null && detail.didCrash() ? "crashed" : "stopped by Android to free memory") + ")");
                    try { recreate(); } catch (Throwable ignored) {}
                    return true;
                }
            });
        } catch (Throwable ignored) {}
        handOver(getIntent());
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); handOver(intent); }

    /** A magnet or a .torrent opened with the app, or a link shared to it: handed to the page as #/open?u=… */
    private void handOver(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction(); String u = null;
        if ("android.intent.action.INSTALL_PACKAGE".equals(action) && intent.getData() != null) { handApp(intent.getData()); return; }
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            Uri d = intent.getData();
            // (An app to install, opened with «Kurokawa Installer» from a file manager or a browser: copied here and
            // shown in the app's installer — what it is, its parts, then installed.)
            if (isAppFile(intent, d)) { handApp(d); return; }
            // (From the floating translator's menu or its tile: its page in the app.)
            if ("kurokawatools".equals(d.getScheme()) && "screen".equals(d.getHost())) { if (getBridge() != null && getBridge().getWebView() != null) getBridge().getWebView().postDelayed(() -> getBridge().getWebView().evaluateJavascript("location.hash='#/screen'", null), 400); return; }
            // (A video or a sound file opened with «Kurokawa Player»: straight into the player, with what the caller
            // says — where to start, the title, subtitles, headers (MX Player's extras) —, the position handed back.)
            if (isMedia(intent, d)) { handMedia(intent, d); return; }
            if ("magnet".equals(d.getScheme()) || "http".equals(d.getScheme()) || "https".equals(d.getScheme())) u = d.toString();
            else if ("content".equals(d.getScheme()) || "file".equals(d.getScheme())) u = readTorrent(d);
        } else if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            // (Files shared to «Save to device» — the alias .KtSave — or anything shared that is not a torrent: kept for
            // the Files page to save where the reader chooses.)
            boolean toSave = intent.getComponent() != null && intent.getComponent().getClassName().endsWith("KtSave");
            java.util.List<Uri> us = new java.util.ArrayList<>();
            if (Intent.ACTION_SEND_MULTIPLE.equals(action)) { java.util.ArrayList<Uri> l = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM); if (l != null) us.addAll(l); }
            else { Uri s = intent.getParcelableExtra(Intent.EXTRA_STREAM); if (s != null) us.add(s); }
            if (toSave || us.size() > 1 || (us.size() == 1 && !isTorrentLike(intent, us.get(0)))) {
                if (us.isEmpty()) { String text = intent.getStringExtra(Intent.EXTRA_TEXT); if (text != null) u = text.trim(); }
                else { KtPlugin.sharedIn(us); if (getBridge() != null && getBridge().getWebView() != null) getBridge().getWebView().postDelayed(() -> getBridge().getWebView().evaluateJavascript("location.hash='#/files?save=1'", null), 400); return; }
            } else if (!us.isEmpty()) u = readTorrent(us.get(0));
            else { String text = intent.getStringExtra(Intent.EXTRA_TEXT); if (text != null) u = text.trim(); }
        }
        if (u == null) return;
        final String link = u;
        if (getBridge() != null && getBridge().getWebView() != null) getBridge().getWebView().postDelayed(() -> getBridge().getWebView().evaluateJavascript("location.hash='#/open?u='+encodeURIComponent(" + org.json.JSONObject.quote(link) + ")", null), 400);
    }
    private boolean isTorrentLike(Intent intent, Uri d) {
        String type = intent.getType(); if (type != null && type.contains("bittorrent")) return true;
        try { String t = getContentResolver().getType(d); if (t != null && t.contains("bittorrent")) return true; } catch (Throwable ignored) {}
        return nameOf(d).toLowerCase(java.util.Locale.ROOT).endsWith(".torrent");
    }
    private boolean isMedia(Intent intent, Uri d) {
        if (intent.getComponent() != null && intent.getComponent().getClassName().endsWith("KtPlayer")) return true;
        String type = intent.getType(); if (type == null) try { type = getContentResolver().getType(d); } catch (Throwable ignored) {}
        if (type != null && (type.startsWith("video/") || type.startsWith("audio/") || type.contains("mpegurl"))) return true;
        String n = nameOf(d).toLowerCase(java.util.Locale.ROOT);
        return n.matches(".*\\.(mkv|mp4|m4v|webm|avi|mov|ts|m2ts|flv|wmv|3gp|mp3|m4a|flac|ogg|opus|wav|aac|m3u8)$") && !"magnet".equals(d.getScheme());
    }
    /** Launched to play something: the activity ends when the player closes, its position handed to the caller. */
    static volatile boolean playingForCaller = false;
    private void handMedia(Intent intent, Uri d) { handMedia(intent, d, 0); }
    private void handMedia(Intent intent, Uri d, int tries) {
        // (The engine and the page come up a moment after a cold start: waited for, a little at a time.)
        if ((KtPlugin.engineIfAny() == null || getBridge() == null || getBridge().getWebView() == null) && tries < 20) { new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> handMedia(intent, d, tries + 1), 300); return; }
        try {
            org.json.JSONObject o = new org.json.JSONObject();
            String url = d.toString();
            if ("content".equals(d.getScheme())) url = KtPlugin.engineIfAny() != null ? KtPlugin.engineIfAny().stream().contentUrl(d.toString()) : url;
            else if ("file".equals(d.getScheme())) { o.put("path", d.getPath()); url = KtPlugin.engineIfAny() != null ? KtPlugin.engineIfAny().stream().fileUrl(d.getPath()) : url; }
            o.put("url", url); o.put("name", intent.hasExtra("title") ? intent.getStringExtra("title") : nameOf(d));
            if (intent.hasExtra("position")) o.put("position", intent.getIntExtra("position", 0) / 1000.0);
            if (intent.hasExtra("return_result")) playingForCaller = true; if (getCallingActivity() != null) playingForCaller = true;
            String[] hs = intent.getStringArrayExtra("headers"); if (hs != null && hs.length >= 2) { org.json.JSONObject h = new org.json.JSONObject(); for (int i = 0; i + 1 < hs.length; i += 2) h.put(hs[i], hs[i + 1]); o.put("headers", h); }
            android.os.Parcelable[] subs = intent.getParcelableArrayExtra("subs"); if (subs != null) { org.json.JSONArray a = new org.json.JSONArray(); for (android.os.Parcelable p : subs) if (p instanceof Uri) { Uri su = (Uri) p; a.put("content".equals(su.getScheme()) && KtPlugin.engineIfAny() != null ? KtPlugin.engineIfAny().stream().contentUrl(su.toString()) : su.toString()); } o.put("subs", a); }
            final String js = "window.dispatchEvent(new CustomEvent('kt:play',{detail:" + o.toString() + "}))";
            if (getBridge() != null && getBridge().getWebView() != null) getBridge().getWebView().postDelayed(() -> getBridge().getWebView().evaluateJavascript(js, null), 600);
        } catch (Exception e) { android.util.Log.w("KtMain", "media", e); }
    }
    /** The player closed: the position and the length to whoever asked (MX Player's result), the activity ended. */
    void playerDone(long positionMs, long durationMs, String endBy) {
        if (!playingForCaller) return; playingForCaller = false;
        Intent r = new Intent("app.kurokawa.tools.player.result"); r.putExtra("position", (int) positionMs); r.putExtra("duration", (int) durationMs); r.putExtra("end_by", endBy);
        setResult(RESULT_OK, r); runOnUiThread(this::finish);
    }
    private boolean isAppFile(Intent intent, Uri d) {
        String type = intent.getType(); if (type == null) try { type = getContentResolver().getType(d); } catch (Throwable ignored) {}
        if ("application/vnd.android.package-archive".equals(type)) return true;
        if (intent.getComponent() != null && intent.getComponent().getClassName().endsWith("KtInstaller")) return true;
        String n = nameOf(d).toLowerCase(java.util.Locale.ROOT); return n.endsWith(".apk") || n.endsWith(".apks") || n.endsWith(".xapk") || n.endsWith(".apkm");
    }
    private String nameOf(Uri d) {
        String n = null;
        try (android.database.Cursor c = getContentResolver().query(d, new String[] { android.provider.OpenableColumns.DISPLAY_NAME }, null, null, null)) { if (c != null && c.moveToFirst()) n = c.getString(0); } catch (Throwable ignored) {}
        if (n == null) n = d.getLastPathSegment(); if (n == null) n = "app.apk"; return n.replaceAll(".*/", "");
    }
    /** The app file (a file path as it is; anything else copied to the app's cache) handed to the page's installer. */
    private void handApp(Uri d) {
        new Thread(() -> {
            String path = null;
            try {
                if ("file".equals(d.getScheme())) path = d.getPath();
                else {
                    String n = nameOf(d); if (!n.toLowerCase(java.util.Locale.ROOT).matches(".*\\.(apk|apks|xapk|apkm)$")) n = n + ".apk";
                    java.io.File dir = new java.io.File(getCacheDir(), "kt-install"); dir.mkdirs(); java.io.File[] old = dir.listFiles(); if (old != null) for (java.io.File f : old) if (System.currentTimeMillis() - f.lastModified() > 86400000L) f.delete();
                    java.io.File out = new java.io.File(dir, n);
                    try (java.io.InputStream in = getContentResolver().openInputStream(d); java.io.OutputStream os = new java.io.FileOutputStream(out)) { byte[] b = new byte[1 << 20]; int r; while ((r = in.read(b)) > 0) os.write(b, 0, r); }
                    path = out.getAbsolutePath();
                }
            } catch (Throwable e) { note(this, "install hand-over: " + e); }
            final String p = path; if (p == null) return;
            runOnUiThread(() -> { if (getBridge() != null && getBridge().getWebView() != null) getBridge().getWebView().postDelayed(() -> getBridge().getWebView().evaluateJavascript("location.hash='#/install?p='+encodeURIComponent(" + org.json.JSONObject.quote(p) + ")", null), 400); });
        }, "kt-install-handover").start();
    }
    /** A line added to the crash file the page shows next time. */
    static void note(android.content.Context c, String what) {
        try { java.io.File f = new java.io.File(new java.io.File(c.getFilesDir(), "kt"), "crash.txt"); f.getParentFile().mkdirs();
            String head = "time: " + new java.util.Date() + "\nandroid: " + android.os.Build.VERSION.RELEASE + " (" + android.os.Build.VERSION.SDK_INT + ") " + android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL + "\n";
            try (java.io.FileOutputStream o = new java.io.FileOutputStream(f, true)) { o.write((head + what + "\n\n").getBytes(java.nio.charset.StandardCharsets.UTF_8)); } } catch (Throwable ignored) {}
    }
    /** What Android recorded of the app's last end, when it was not the user's doing (a crash in native code —
     *  the torrent engine's —, not answering, memory), written down at once: the page may not live long enough
     *  to ask for it if the same thing happens again. */
    static void noteLastExit(android.content.Context c) {
        if (android.os.Build.VERSION.SDK_INT < 30) return;
        try {
            android.app.ActivityManager am = (android.app.ActivityManager) c.getSystemService(android.content.Context.ACTIVITY_SERVICE);
            java.util.List<android.app.ApplicationExitInfo> l = am.getHistoricalProcessExitReasons(c.getPackageName(), 0, 5);
            android.content.SharedPreferences sp = c.getSharedPreferences("kt", android.content.Context.MODE_PRIVATE); long seen = sp.getLong("exitSeen", 0); long newest = seen; long prevStart = sp.getLong("startAt", 0), newestBad = 0; boolean quick = false;
            String[] names = { "unknown", "exit self", "signaled", "low memory", "crash", "native crash", "not responding (ANR)", "initialization failure", "permission change", "excessive resource use", "user requested", "user stopped", "dependency died", "other", "freezer", "package state change", "package updated" };
            StringBuilder sb = new StringBuilder();
            for (android.app.ApplicationExitInfo x : l) {
                int why = x.getReason(); long at = x.getTimestamp(); if (at <= seen) continue; newest = Math.max(newest, at);
                boolean bad = why == android.app.ApplicationExitInfo.REASON_CRASH || why == android.app.ApplicationExitInfo.REASON_CRASH_NATIVE || why == android.app.ApplicationExitInfo.REASON_ANR || why == android.app.ApplicationExitInfo.REASON_LOW_MEMORY || why == android.app.ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE || why == android.app.ApplicationExitInfo.REASON_INITIALIZATION_FAILURE || why == android.app.ApplicationExitInfo.REASON_SIGNALED;
                // (Signals: only a crash's — a bad memory read, an abort, a bus or arithmetic fault, an illegal
                // instruction. SIGINT, SIGTERM, SIGKILL and SIGHUP are sent from outside: Android or the phone's power
                // manager closing the app, an update replacing it, the app swiped away. Not crashes: not told, not counted.)
                if (why == android.app.ApplicationExitInfo.REASON_SIGNALED) { int sig = x.getStatus(); if (sig != 4 && sig != 5 && sig != 6 && sig != 7 && sig != 8 && sig != 11 && sig != 31) bad = false; }
                if (!bad) continue;
                // (Low memory and heavy use are Android's choice, not the app ending by itself: told, not counted.)
                boolean counts = why != android.app.ApplicationExitInfo.REASON_LOW_MEMORY && why != android.app.ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE;
                sb.append("android says: ").append(why < names.length ? names[why] : String.valueOf(why)).append(" at ").append(new java.util.Date(at)).append(x.getDescription() != null ? " — " + x.getDescription() : "").append(" (process ").append(x.getProcessName()).append(", status ").append(x.getStatus()).append(")\n");
                // (A native crash: Android's record of it read properly — the thread that crashed with its frames, the
                // other threads by name, the last log lines; an ANR's trace is text, its first lines kept.)
                if (why == android.app.ApplicationExitInfo.REASON_CRASH_NATIVE || why == android.app.ApplicationExitInfo.REASON_ANR) {
                    try (java.io.InputStream in = x.getTraceInputStream()) {
                        if (in != null) {
                            byte[] b = KtTombstone.all(in, 4_000_000); String r = why == android.app.ApplicationExitInfo.REASON_CRASH_NATIVE ? KtTombstone.read(b, b.length) : null;
                            if (r != null) sb.append(r).append('\n');
                            else { String text = new String(b, 0, Math.min(b.length, 12000), java.nio.charset.StandardCharsets.UTF_8); String[] ls = text.split("\n"); for (int k = 0; k < Math.min(120, ls.length); k++) sb.append("  ").append(ls[k].replaceAll("[\\p{Cntrl}&&[^\\t]]", "")).append('\n'); }
                        }
                    } catch (Throwable ignored) {}
                }
                // (The app ending this way within a minute and a half of starting: counted; twice in a row, the next
                // start keeps the torrents paused, so the app can be opened and the cause told apart.)
                if (counts && at - prevStart < 90_000 && prevStart > 0 && at >= newestBad) { newestBad = at; quick = true; }
            }
            int count = quick ? sp.getInt("quickCrashes", 0) + 1 : (newest != seen ? 0 : sp.getInt("quickCrashes", 0));
            android.content.SharedPreferences.Editor ed = sp.edit().putInt("quickCrashes", count >= 2 ? 0 : count).putLong("startAt", System.currentTimeMillis());
            if (count >= 2) { ed.putBoolean("safeStart", true); sb.append("\nThe app closed shortly after starting twice in a row: this time the torrents are kept paused. Resume them one by one from Downloads — if the app closes again right after one is resumed, that torrent's download is what ends it.\n"); }
            ed.apply();
            if (newest != seen) sp.edit().putLong("exitSeen", newest).apply();
            if (sb.length() > 0) note(c, sb.toString().trim());
        } catch (Throwable ignored) {}
    }
    private static boolean catching = false;
    /** A crash written down (when, which thread, the stack) before the app goes, for the page to show next time. */
    static void catchCrashes(android.content.Context c) {
        if (catching) return; catching = true;
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        final java.io.File f = new java.io.File(new java.io.File(c.getFilesDir(), "kt"), "crash.txt");
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            try { f.getParentFile().mkdirs(); java.io.StringWriter sw = new java.io.StringWriter(); e.printStackTrace(new java.io.PrintWriter(sw));
                String head = "time: " + new java.util.Date() + "\nthread: " + t.getName() + "\nandroid: " + android.os.Build.VERSION.RELEASE + " (" + android.os.Build.VERSION.SDK_INT + ") " + android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL + "\n\n";
                try (java.io.FileOutputStream o = new java.io.FileOutputStream(f)) { o.write((head + sw).getBytes(java.nio.charset.StandardCharsets.UTF_8)); } } catch (Throwable ignored) {}
            if (prev != null) prev.uncaughtException(t, e);
        });
    }
    /** A .torrent file as a data: URL the page turns into a task. */
    private String readTorrent(Uri uri) {
        try (java.io.InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) return null;
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream(); byte[] b = new byte[8192]; int n; long total = 0;
            while ((n = in.read(b)) > 0) { bo.write(b, 0, n); total += n; if (total > 20_000_000) return null; }
            return "data:application/x-bittorrent;base64," + android.util.Base64.encodeToString(bo.toByteArray(), android.util.Base64.NO_WRAP);
        } catch (Exception e) { return null; }
    }
}
