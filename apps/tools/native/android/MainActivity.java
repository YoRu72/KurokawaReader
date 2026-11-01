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
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            Uri d = intent.getData();
            if ("magnet".equals(d.getScheme()) || "http".equals(d.getScheme()) || "https".equals(d.getScheme())) u = d.toString();
            else if ("content".equals(d.getScheme()) || "file".equals(d.getScheme())) u = readTorrent(d);
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri s = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (s != null) u = readTorrent(s); else { String text = intent.getStringExtra(Intent.EXTRA_TEXT); if (text != null) u = text.trim(); }
        }
        if (u == null) return;
        final String link = u;
        if (getBridge() != null && getBridge().getWebView() != null) getBridge().getWebView().postDelayed(() -> getBridge().getWebView().evaluateJavascript("location.hash='#/open?u='+encodeURIComponent(" + org.json.JSONObject.quote(link) + ")", null), 400);
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
