package app.kurokawa.tools;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
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
