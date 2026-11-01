package app.kurokawa.tools;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        catchCrashes(getApplicationContext());
        registerPlugin(KtPlugin.class);
        super.onCreate(savedInstanceState);
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
