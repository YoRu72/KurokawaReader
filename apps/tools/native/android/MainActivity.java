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
            android.content.SharedPreferences sp = c.getSharedPreferences("kt", android.content.Context.MODE_PRIVATE); long seen = sp.getLong("exitSeen", 0); long newest = seen;
            String[] names = { "unknown", "exit self", "signaled", "low memory", "crash", "native crash", "not responding (ANR)", "initialization failure", "permission change", "excessive resource use", "user requested", "user stopped", "dependency died", "other", "freezer", "package state change", "package updated" };
            StringBuilder sb = new StringBuilder();
            for (android.app.ApplicationExitInfo x : l) {
                int why = x.getReason(); long at = x.getTimestamp(); if (at <= seen) continue; newest = Math.max(newest, at);
                boolean bad = why == android.app.ApplicationExitInfo.REASON_CRASH || why == android.app.ApplicationExitInfo.REASON_CRASH_NATIVE || why == android.app.ApplicationExitInfo.REASON_ANR || why == android.app.ApplicationExitInfo.REASON_LOW_MEMORY || why == android.app.ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE || why == android.app.ApplicationExitInfo.REASON_INITIALIZATION_FAILURE || why == android.app.ApplicationExitInfo.REASON_SIGNALED;
                if (!bad) continue;
                sb.append("android says: ").append(why < names.length ? names[why] : String.valueOf(why)).append(" at ").append(new java.util.Date(at)).append(x.getDescription() != null ? " — " + x.getDescription() : "").append(" (process ").append(x.getProcessName()).append(", status ").append(x.getStatus()).append(")\n");
                // (A native crash's or an ANR's trace: its readable lines — the signal, the abort message, the frames.)
                if (why == android.app.ApplicationExitInfo.REASON_CRASH_NATIVE || why == android.app.ApplicationExitInfo.REASON_ANR) {
                    try (java.io.InputStream in = x.getTraceInputStream()) {
                        if (in != null) { byte[] b = new byte[200_000]; int n = 0, r; while (n < b.length && (r = in.read(b, n, b.length - n)) > 0) n += r;
                            StringBuilder run = new StringBuilder(); int lines = 0;
                            for (int i = 0; i < n && lines < 60; i++) { int ch = b[i] & 0xff; if (ch >= 32 && ch < 127) run.append((char) ch); else { if (run.length() >= 6 && !run.toString().matches("[A-Za-z0-9+/=]{30,}")) { sb.append("  ").append(run).append('\n'); lines++; } run.setLength(0); } }
                        }
                    } catch (Throwable ignored) {}
                }
            }
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
