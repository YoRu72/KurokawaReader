package app.kurokawa.reader;

import android.content.Intent;
import android.net.Uri;
import android.content.ContentValues;
import android.provider.MediaStore;
import android.os.Environment;
import android.media.MediaScannerConnection;
import java.io.FileOutputStream;
import java.io.OutputStream;
import android.os.Build;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.os.ParcelFileDescriptor;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import android.app.Activity;
import android.database.Cursor;
import android.provider.DocumentsContract;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.PermissionState;
import android.Manifest;
import android.content.Context;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import java.util.Locale;
import java.util.Set;

/**
 * Native helpers for the reader:
 *  - processText: hand selected text to Google Translate / dictionaries (ACTION_PROCESS_TEXT)
 *  - setImmersive: hide or show the status and navigation bars while reading
 *  - pdfOpen / pdfRender / pdfClose: render PDF pages with Android's own renderer, which
 *    substitutes system fonts for non-embedded fonts (pdf.js cannot shape Arabic in that case).
 */
@CapacitorPlugin(name = "Kurokawa", permissions = { @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }), @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" }) })
public class KurokawaPlugin extends Plugin {
    private final Object lock = new Object();

    /* ---------- long work (conversions): background service and notifications ---------- */

    private boolean jobStarted = false;

    @PluginMethod
    public void notifyPermission(PluginCall call) {
        boolean ask = Boolean.TRUE.equals(call.getBoolean("ask", false));
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject r = new JSObject(); r.put("granted", androidx.core.app.NotificationManagerCompat.from(getContext()).areNotificationsEnabled()); call.resolve(r); return;
        }
        if (!ask) { JSObject r = new JSObject(); r.put("granted", false); call.resolve(r); return; }
        requestPermissionForAlias("notifications", call, "notifyPermCallback");
    }

    @PermissionCallback
    private void notifyPermCallback(PluginCall call) {
        JSObject r = new JSObject(); r.put("granted", getPermissionState("notifications") == PermissionState.GRANTED); call.resolve(r);
    }

    /** A notification of the app's (new chapters, extension updates): {id, title, body, hash}; a tap opens the
     *  app at `hash` (a route of the web side). Asks for the permission the first time on Android 13+. */
    @PluginMethod
    public void notify(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) { requestPermissionForAlias("notifications", call, "notifyThenPost"); return; }
        postNotification(call);
    }

    @PermissionCallback
    private void notifyThenPost(PluginCall call) {
        if (getPermissionState("notifications") == PermissionState.GRANTED) postNotification(call);
        else { JSObject r = new JSObject(); r.put("shown", false); call.resolve(r); }
    }

    private void postNotification(PluginCall call) {
        try {
            android.content.Context c = getContext();
            final String ch = "kr_updates";
            if (Build.VERSION.SDK_INT >= 26) {
                android.app.NotificationManager nm = c.getSystemService(android.app.NotificationManager.class);
                if (nm != null && nm.getNotificationChannel(ch) == null) {
                    @SuppressWarnings("deprecation") boolean ar = "ar".equals(c.getResources().getConfiguration().locale.getLanguage());
                    nm.createNotificationChannel(new android.app.NotificationChannel(ch, ar ? "جديد الكتب والمصادر" : "New chapters and extension updates", android.app.NotificationManager.IMPORTANCE_DEFAULT));
                }
            }
            int id = call.getInt("id", 7100);
            String hash = call.getString("hash", "/");
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse("kurokawareader://open?to=" + Uri.encode(hash)), c, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            android.app.PendingIntent pi = android.app.PendingIntent.getActivity(c, id, i, android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT);
            String body = call.getString("body", "");
            android.app.Notification n = new androidx.core.app.NotificationCompat.Builder(c, ch)
                .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                .setContentTitle(call.getString("title", "KurokawaReader"))
                .setContentText(body)
                .setStyle(new androidx.core.app.NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(pi)
                .build();
            androidx.core.app.NotificationManagerCompat.from(c).notify(id, n);
            JSObject r = new JSObject(); r.put("shown", true); call.resolve(r);
        } catch (Exception e) { JSObject r = new JSObject(); r.put("shown", false); call.resolve(r); }
    }

    @PluginMethod
    public void jobProgress(PluginCall call) {
        KrWebView.keepAwake = true;
        try { KrJobService.progress(getContext(), call.getString("title", ""), call.getString("text", ""), call.getInt("pct", 0), jobStarted); jobStarted = true; }
        catch (Exception e) { /* a service the system refuses to start now: the work goes on in the app */ }
        call.resolve();
    }

    @PluginMethod
    public void jobDone(PluginCall call) {
        boolean stop = !Boolean.FALSE.equals(call.getBoolean("stop", true));
        KrJobService.done(getContext(), call.getString("title", ""), call.getString("text", ""), Boolean.TRUE.equals(call.getBoolean("ok", true)), stop);
        if (stop) {
            jobStarted = false;
            getActivity().runOnUiThread(() -> { android.webkit.WebView w = getBridge().getWebView(); if (w instanceof KrWebView) ((KrWebView) w).release(); else KrWebView.keepAwake = false; });
        }
        call.resolve();
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        // (While work runs, the page goes on at full speed behind other apps.)
        if (KrWebView.keepAwake && getBridge() != null && getBridge().getWebView() != null) { android.webkit.WebView w = getBridge().getWebView(); w.postDelayed(() -> { if (KrWebView.keepAwake) { w.onResume(); w.resumeTimers(); } }, 150); }
    }

    @PluginMethod
    public void processText(PluginCall call) {
        String text = call.getString("text", "");
        Boolean readonly = call.getBoolean("readonly", true);
        Intent intent = new Intent(Intent.ACTION_PROCESS_TEXT);
        intent.setType("text/plain");
        intent.putExtra(Intent.EXTRA_PROCESS_TEXT, text);
        intent.putExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, readonly != null && readonly);
        try {
            getActivity().startActivity(Intent.createChooser(intent, null));
            call.resolve();
        } catch (Exception e) {
            call.reject("No app can process text", e);
        }
    }

    @PluginMethod
    public void deviceInfo(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("abis", new JSArray(java.util.Arrays.asList(Build.SUPPORTED_ABIS)));
        ret.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    /** Opens the system package installer for a downloaded APK (in-app update). */
    /** Generic HTTP request from native code (no CORS): used for sync back-ends. Body/response as text. */
    @PluginMethod
    public void httpRequest(PluginCall call) {
        if (bodyDir == null) bodyDir = new File(getContext().getCacheDir(), "kr-http");
        final String urlStr = call.getString("url", "");
        final String method = call.getString("method", "GET");
        final String body = call.getString("body", null);
        final JSObject headers = call.getObject("headers", new JSObject());
        final boolean binary = call.getBoolean("binary", false);
        new Thread(() -> {
            try {
                // (With DNS over HTTPS the redirects are followed here, each by its own name; else by the connection.)
                java.net.URL at = new java.net.URL(urlStr); String verb = method; String sent = body;
                java.net.HttpURLConnection conn; int code;
                for (int hop = 0; ; hop++) {
                    conn = KrDoh.open(at);
                    if (!KrDoh.on()) conn.setInstanceFollowRedirects(true);
                    conn.setRequestMethod(verb);
                    conn.setConnectTimeout(20000); conn.setReadTimeout(60000);
                    boolean hasUa = false, hasCookie = false;
                    java.util.Iterator<String> it = headers.keys();
                    // (Compression is the connection's own business: a caller naming an encoding would get raw gzip back.)
                    while (it.hasNext()) { String k = it.next(); if (k.equalsIgnoreCase("accept-encoding")) continue; conn.setRequestProperty(k, headers.getString(k)); if (k.equalsIgnoreCase("user-agent")) hasUa = true; if (k.equalsIgnoreCase("cookie")) hasCookie = true; }
                    // The app's own identity and cookies go with the request (a Cloudflare clearance passed in the
                    // app's web view is bound to both), and what the site sets comes back into the same jar.
                    if (!hasUa) { try { conn.setRequestProperty("User-Agent", android.webkit.WebSettings.getDefaultUserAgent(getContext())); } catch (Exception ignored) {} }
                    if (!hasCookie || hop > 0) { try { String ck = android.webkit.CookieManager.getInstance().getCookie(at.toString()); if (ck != null && !ck.isEmpty()) conn.setRequestProperty("Cookie", ck); } catch (Exception ignored) {} }
                    if (sent != null) { conn.setDoOutput(true); try (OutputStream os = conn.getOutputStream()) { os.write(call.getBoolean("bodyBase64", false) ? Base64.decode(sent, Base64.DEFAULT) : sent.getBytes("UTF-8")); } }
                    code = conn.getResponseCode();
                    final String here = at.toString();
                    try { java.util.List<String> set = conn.getHeaderFields().get("Set-Cookie"); if (set != null) { android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance(); for (String c : set) cm.setCookie(here, c); cm.flush(); } } catch (Exception ignored) {}
                    String loc = code >= 300 && code < 400 ? conn.getHeaderField("Location") : null;
                    if (loc == null || !KrDoh.on() || hop >= 9) break;
                    conn.disconnect();
                    at = new java.net.URL(at, loc);
                    if (code == 303 || ((code == 301 || code == 302) && "POST".equalsIgnoreCase(verb))) { verb = "GET"; sent = null; }
                }
                InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                if (in != null) { byte[] buf = new byte[1 << 16]; int n; while ((n = in.read(buf)) > 0) bos.write(buf, 0, n); }
                JSObject ret = new JSObject();
                ret.put("status", code);
                byte[] bytes = bos.toByteArray();
                if (binary) putBinaryBody(ret, bytes); else ret.put("body", new String(bytes, charsetOf(conn.getContentType(), bytes)));
                JSObject hs = new JSObject();
                for (java.util.Map.Entry<String, java.util.List<String>> e : conn.getHeaderFields().entrySet()) if (e.getKey() != null) hs.put(e.getKey().toLowerCase(), e.getValue().get(0));
                ret.put("headers", hs);
                ret.put("url", KrDoh.on() ? at.toString() : conn.getURL().toString());
                call.resolve(ret);
            } catch (Exception e) { call.reject("Request failed: " + e.getMessage(), e); }
        }).start();
    }

    /** The charset a page's text is in: the header's, else a <meta> in its first bytes, else UTF-8. */
    /** A binary answer for the page: small ones as base64 in the result; big ones (a cover, a file) written to a
     *  file the page reads itself through the app's file server — a megabyte of base64 pushed through the bridge
     *  as JSON, parsed on the page's main thread, dropped frames while the reader scrolled. */
    private static int bodySeq = 0;
    static void putBinaryBody(JSObject ret, byte[] bytes) {
        if (bytes.length > 262144 && bodyDir != null) {
            try {
                bodyDir.mkdirs();
                File f = new File(bodyDir, "b" + (bodySeq++ % 8) + ".bin");
                try (OutputStream out = new java.io.BufferedOutputStream(new FileOutputStream(f), 1 << 16)) { out.write(bytes); }
                ret.put("bodyPath", f.getAbsolutePath()); ret.put("body", ""); ret.put("bodySize", bytes.length);
                return;
            } catch (Exception ignored) { /* as base64, then */ }
        }
        ret.put("body", Base64.encodeToString(bytes, Base64.NO_WRAP));
    }
    static File bodyDir = null;

    static java.nio.charset.Charset charsetOf(String contentType, byte[] body) {
        try {
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("charset=\"?'?([\\w-]+)", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(contentType == null ? "" : contentType);
            if (m.find()) return java.nio.charset.Charset.forName(m.group(1));
            String head = new String(body, 0, Math.min(body.length, 2048), "ISO-8859-1");
            java.util.regex.Matcher mm = java.util.regex.Pattern.compile("<meta[^>]+charset=\"?'?([\\w-]+)", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(head);
            if (mm.find()) return java.nio.charset.Charset.forName(mm.group(1));
        } catch (Exception ignored) {}
        return java.nio.charset.StandardCharsets.UTF_8;
    }

    /* ---------- the app's own browser: a site's check passed, the sites that answer only a browser ---------- */
    // (See KrBrowser: the check — out of sight, else a window the reader passes it in — and the requests a page
    // of the site makes for the app when the site turns the app's own requests away.)
    private KrBrowser browser;
    private KrBrowser browser() { if (browser == null) browser = new KrBrowser(this); return browser; }

    /** {url, hidden?, timeout?, fresh?, message?, done?, reload?} → {passed, blocked, title}. */
    @PluginMethod
    public void openWebView(PluginCall call) { browser().check(call); }

    /** An event for the page, from the browser lane (its downloads' progress). */
    void notifyEvent(String name, JSObject data) { notifyListeners(name, data); }

    /** A request made by a page of the site itself, in the app's own browser (see KrBrowser.fetch). */
    @PluginMethod
    public void browserFetch(PluginCall call) { if (bodyDir == null) bodyDir = new File(getContext().getCacheDir(), "kr-http"); browser().fetch(call); }

    /** The site's browser view closed: the next request opens it again with the cookies as they are now. */
    @PluginMethod
    public void browserReset(PluginCall call) { browser().reset(call); }

    /** The site's clearance (or all its cookies, {all: true}) cleared. */
    @PluginMethod
    public void browserForget(PluginCall call) { browser().forget(call); }

    /** A page of HTML printed to a PDF as the system prints (real text, not pictures of pages): {html, width,
     *  height, margin} in points → {data: base64} (see KrPrint). */
    @PluginMethod
    public void printToPdf(PluginCall call) {
        String html = call.getString("html");
        if (html == null || html.isEmpty()) { call.reject("no html"); return; }
        double w = call.getDouble("width", 595.28), h = call.getDouble("height", 841.89), m = call.getDouble("margin", 45.35);
        getActivity().runOnUiThread(() -> KrPrint.run(getActivity(), html, w, h, m, call));
    }

    /* ---------- DNS over HTTPS (see KrDoh): the reader's resolver, kept across starts ---------- */
    @Override
    public void load() {
        super.load();
        try { KrDoh.provider = getContext().getSharedPreferences("kr", android.content.Context.MODE_PRIVATE).getString("doh", "off"); } catch (Exception ignored) {}
    }

    /** {provider: "off" | "cloudflare" | "google" | "quad9" | "adguard" | "https://…/dns-query"}; {test: host}
     *  answers with the addresses found for it (or the error). */
    @PluginMethod
    public void setDoh(PluginCall call) {
        String p = call.getString("provider", null);
        if (p != null) {
            KrDoh.provider = p; KrDoh.forget();
            getContext().getSharedPreferences("kr", android.content.Context.MODE_PRIVATE).edit().putString("doh", p).apply();
        }
        final String test = call.getString("test", null);
        JSObject r = new JSObject(); r.put("provider", KrDoh.provider);
        if (test == null) { call.resolve(r); return; }
        new Thread(() -> {
            try { java.net.InetAddress[] ips = KrDoh.resolve(test); org.json.JSONArray a = new org.json.JSONArray(); for (java.net.InetAddress ip : ips) a.put(ip.getHostAddress()); r.put("ips", a); call.resolve(r); }
            catch (Exception e) { call.reject("DoH failed: " + e.getMessage(), e); }
        }).start();
    }

    /** Downloads a file (following redirects, no CORS) with progress events. Returns file:// path.
     *  Large files that the server can serve in ranges are fetched over several connections at once
     *  (the way aria2 splits a download), each writing its own segment of the file. */
    /** The downloads under way, by id, so one can be cancelled. */
    private final java.util.Map<String, java.util.concurrent.atomic.AtomicBoolean> downloads = new java.util.concurrent.ConcurrentHashMap<>();

    @PluginMethod
    public void downloadFile(PluginCall call) {
        final String urlStr = call.getString("url", "");
        final String name = call.getString("name", "download.bin");
        final String id = call.getString("id", "");
        // "persist": keep the file (e.g. a downloaded deck the library links to) instead of the cache.
        final boolean persist = Boolean.TRUE.equals(call.getBoolean("persist", false));
        final int connections = Math.max(1, Math.min(16, call.getInt("connections", 8)));
        final JSObject headers = call.getObject("headers", new JSObject());
        final java.util.concurrent.atomic.AtomicBoolean cancelled = new java.util.concurrent.atomic.AtomicBoolean(false);
        if (!id.isEmpty()) downloads.put(id, cancelled);
        new Thread(() -> {
            try {
                java.net.URL url = new java.net.URL(urlStr);
                File dir = persist ? new File(getContext().getFilesDir(), "downloads") : new File(getContext().getCacheDir(), "kr-update"); dir.mkdirs();
                // (Written under a ".part" name and renamed when whole: a file under its own name is always complete —
                // a downloaded update is kept and used again, so a half one must never pass for it.)
                final File done0 = new File(dir, name);
                File out = new File(dir, name + ".part");
                final java.util.concurrent.atomic.AtomicLong got = new java.util.concurrent.atomic.AtomicLong();
                final KrDownloader.Result info = new KrDownloader.Result();
                Runnable report = new Runnable() {
                    long lastT = System.currentTimeMillis(), lastGot = 0; double speed = 0;
                    public synchronized void run() {
                        long now = System.currentTimeMillis(); if (now - lastT < 300) return;
                        long g = got.get(); double inst = (g - lastGot) / ((now - lastT) / 1000.0); speed = speed == 0 ? inst : speed * 0.6 + 0.4 * inst; lastT = now; lastGot = g;
                        long tot = info.total;
                        JSObject ev = new JSObject(); ev.put("id", id); ev.put("got", g); ev.put("total", tot); ev.put("speed", speed); ev.put("pct", tot > 0 ? (int) (g * 100 / tot) : 0); ev.put("connections", info.connections);
                        notifyListeners("downloadProgress", ev);
                    }
                };
                KrDownloader.Result res = KrDownloader.fetch(url, out, connections, u -> open(u, headers), cancelled, got, info, report);
                final long fTotal = res.total;
                if (cancelled.get()) { out.delete(); call.reject("cancelled"); return; }
                if (fTotal > 0 && out.length() != fTotal) { out.delete(); call.reject("Download failed: incomplete (" + out.length() + " of " + fTotal + ")"); return; }
                done0.delete();
                if (!out.renameTo(done0)) { out.delete(); call.reject("Download failed: cannot keep the file"); return; }
                JSObject done = new JSObject(); done.put("id", id); done.put("got", got.get()); done.put("total", got.get()); done.put("speed", 0); done.put("pct", 100);
                notifyListeners("downloadProgress", done);
                JSObject ret = new JSObject(); ret.put("path", "file://" + done0.getAbsolutePath()); ret.put("size", done0.length());
                call.resolve(ret);
            } catch (Exception e) { call.reject("Download failed: " + e.getMessage(), e); }
            finally { if (!id.isEmpty()) downloads.remove(id); }
        }).start();
    }

    /** A file downloaded earlier into the cache (an update not installed yet), when it is there whole: its
     *  path, else nothing. `prune`: the other APKs there are removed (older updates). */
    @PluginMethod
    public void cachedFile(PluginCall call) {
        String name = call.getString("name", "");
        long size = call.getLong("size", -1L);
        File dir = new File(getContext().getCacheDir(), "kr-update");
        JSObject r = new JSObject();
        if (name.isEmpty() || name.contains("/") || name.contains("..")) { call.resolve(r); return; }
        File f = new File(dir, name);
        if (Boolean.TRUE.equals(call.getBoolean("prune", false))) {
            File[] all = dir.listFiles();
            if (all != null) for (File x : all) if (!x.getName().equals(name) && !x.getName().equals(name + ".part") && x.getName().toLowerCase().matches(".*\\.apk(\\.part)?$")) x.delete();
        }
        if (f.isFile() && (size <= 0 || f.length() == size)) { r.put("path", "file://" + f.getAbsolutePath()); r.put("size", f.length()); }
        call.resolve(r);
    }

    /** Stops a download by its id; its file is removed. */
    @PluginMethod
    public void cancelDownload(PluginCall call) {
        java.util.concurrent.atomic.AtomicBoolean c = downloads.get(call.getString("id", ""));
        if (c != null) c.set(true);
        call.resolve();
    }

    /** A connection with the app's identity — the headers given, else the web view's User-Agent and the cookies
     *  the site set it (a site's check once passed in the browser lane is passed here too). */
    private java.net.HttpURLConnection open(java.net.URL url, JSObject headers) throws java.io.IOException {
        // (With DNS over HTTPS the site is asked at the address its resolver gives; its redirects are followed by the
        // caller, by their names.)
        java.net.HttpURLConnection c = KrDoh.open(url);
        if (!KrDoh.on()) c.setInstanceFollowRedirects(true);
        boolean hasUa = false, hasCookie = false;
        if (headers != null) {
            java.util.Iterator<String> it = headers.keys();
            while (it.hasNext()) { String k = it.next(); String v = headers.optString(k, null); if (v == null) continue; if (k.equalsIgnoreCase("user-agent")) hasUa = true; if (k.equalsIgnoreCase("cookie")) hasCookie = true; c.setRequestProperty(k, v); }
        }
        if (!hasUa) { String ua = null; try { ua = android.webkit.WebSettings.getDefaultUserAgent(getContext()); } catch (Exception ignored) {} c.setRequestProperty("User-Agent", ua != null ? ua : "KurokawaReader"); }
        if (!hasCookie) { try { String ck = android.webkit.CookieManager.getInstance().getCookie(url.toString()); if (ck != null && !ck.isEmpty()) c.setRequestProperty("Cookie", ck); } catch (Exception ignored) {} }
        c.setConnectTimeout(20000); c.setReadTimeout(60000);
        return c;
    }

    /** Removes a file this app downloaded earlier (deleting a downloaded deck). */
    @PluginMethod
    public void deleteDownload(PluginCall call) {
        String p = call.getString("path", "");
        if (p.startsWith("file://")) p = p.substring(7);
        File f = new File(p);
        boolean ok = f.getAbsolutePath().startsWith(new File(getContext().getFilesDir(), "downloads").getAbsolutePath()) && f.delete();
        JSObject r = new JSObject(); r.put("deleted", ok); call.resolve(r);
    }

    /** Can this app launch the package installer? (Android 8+ needs the per-app "install unknown apps" grant.) */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls());
        call.resolve(r);
    }

    /** Opens the system page where the user allows this app to install updates; resolves when they come back. */
    @PluginMethod
    public void requestInstallPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls()) { JSObject r = new JSObject(); r.put("granted", true); call.resolve(r); return; }
        Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
        startActivityForResult(call, i, "installPermResult");
    }

    @ActivityCallback
    private void installPermResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject r = new JSObject(); r.put("granted", Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls()); call.resolve(r);
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        String path = call.getString("path", "");
        if (path.startsWith("file://")) path = path.substring(7);
        try {
            File apk = new File(path);
            if (!apk.exists()) { call.reject("APK not found: " + path); return; }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_INSTALL_PACKAGE);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true);
            intent.putExtra(Intent.EXTRA_INSTALLER_PACKAGE_NAME, getContext().getPackageName());
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            // Launched from the activity (no NEW_TASK) so the installer's result and prompt are tied to us.
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Cannot start installer: " + e.getMessage(), e);
        }
    }

    /* ---------- Scanning the device for readable files (Storage Access Framework) ---------- */

    /** Lets the user pick a folder (or the whole storage); the grant is persisted. */
    @PluginMethod
    public void pickTree(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "treeResult");
    }

    /** Pick one or more documents with a persistable grant, so the library can link them instead of copying. */
    @PluginMethod
    public void pickDocuments(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "documentsResult");
    }

    @ActivityCallback
    private void documentsResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) { call.reject("cancelled"); return; }
        Intent data = result.getData();
        java.util.List<Uri> uris = new java.util.ArrayList<>();
        if (data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
        else if (data.getData() != null) uris.add(data.getData());
        com.getcapacitor.JSArray files = new com.getcapacitor.JSArray();
        for (Uri u : uris) {
            try { getContext().getContentResolver().takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) {}
            JSObject f = new JSObject();
            f.put("uri", u.toString());
            f.put("name", displayName(u));
            long size = -1;
            try (android.database.Cursor c = getContext().getContentResolver().query(u, new String[]{ android.provider.OpenableColumns.SIZE }, null, null, null)) { if (c != null && c.moveToFirst()) size = c.getLong(0); } catch (Exception ignored) {}
            f.put("size", size);
            f.put("mime", getContext().getContentResolver().getType(u));
            files.put(f);
        }
        JSObject ret = new JSObject();
        ret.put("files", files);
        call.resolve(ret);
    }

    @ActivityCallback
    private void treeResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) { call.reject("cancelled"); return; }
        Uri tree = result.getData().getData();
        try { getContext().getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION); } catch (Exception e) { try { getContext().getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) {} }
        JSObject ret = new JSObject();
        ret.put("uri", tree.toString());
        String name = tree.getLastPathSegment();
        ret.put("name", name == null ? "" : name.replaceFirst("^primary:", "").replaceFirst("^[^:]*:$", "Storage"));
        call.resolve(ret);
    }

    /** Walks a picked tree and lists files whose extension is in `exts` (lower-case, no dot). */
    @PluginMethod
    public void listTree(PluginCall call) {
        String treeStr = call.getString("uri");
        JSArray extsArr = call.getArray("exts");
        if (treeStr == null) { call.reject("uri required"); return; }
        List<String> exts = new ArrayList<>();
        try { if (extsArr != null) for (int i = 0; i < extsArr.length(); i++) exts.add(extsArr.getString(i).toLowerCase()); } catch (Exception ignored) {}
        Uri tree = Uri.parse(treeStr);
        String rootDoc;
        try { rootDoc = DocumentsContract.getTreeDocumentId(tree); } catch (Exception e) { call.reject("bad tree uri"); return; }
        JSArray out = new JSArray();
        ArrayDeque<String[]> queue = new ArrayDeque<>();
        queue.add(new String[]{ rootDoc, "" });
        int visited = 0;
        while (!queue.isEmpty() && visited < 4000 && out.length() < 5000) {
            String[] cur = queue.poll();
            visited++;
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, cur[0]);
            try (Cursor c = getContext().getContentResolver().query(children, new String[]{
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED }, null, null, null)) {
                if (c == null) continue;
                while (c.moveToNext()) {
                    String id = c.getString(0), name = c.getString(1), mime = c.getString(2);
                    if (name == null) continue;
                    if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                        if (!name.startsWith(".") && !name.equals("Android")) queue.add(new String[]{ id, cur[1] + name + "/" });
                        continue;
                    }
                    int dot = name.lastIndexOf('.');
                    String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase() : "";
                    if (!exts.isEmpty() && !exts.contains(ext)) continue;
                    JSObject f = new JSObject();
                    f.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString());
                    f.put("name", name);
                    f.put("path", cur[1] + name);
                    f.put("mime", mime == null ? "" : mime);
                    f.put("size", c.isNull(3) ? 0 : c.getLong(3));
                    f.put("modified", c.isNull(4) ? 0 : c.getLong(4));
                    out.put(f);
                }
            } catch (Exception ignored) {}
        }
        JSObject ret = new JSObject();
        ret.put("files", out);
        ret.put("truncated", !queue.isEmpty() || out.length() >= 5000);
        call.resolve(ret);
    }

    /* ---------- Scanning the whole device ---------- */

    private boolean allFilesAccess() {
        if (Build.VERSION.SDK_INT >= 30) return Environment.isExternalStorageManager();
        return getPermissionState("storage") == PermissionState.GRANTED;
    }

    /** { granted: boolean, needsSettings: boolean } — on Android 11+ the grant lives in system settings. */
    @PluginMethod
    public void storageAccess(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", allFilesAccess());
        ret.put("needsSettings", Build.VERSION.SDK_INT >= 30);
        call.resolve(ret);
    }

    /** Asks for whole-device read access: the runtime permission below Android 11, the "All files access" settings page from Android 11. */
    @PluginMethod
    public void requestStorageAccess(PluginCall call) {
        if (allFilesAccess()) { JSObject r = new JSObject(); r.put("granted", true); call.resolve(r); return; }
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
                startActivityForResult(call, i, "storageSettingsResult");
            } catch (Exception e) {
                Intent i = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                startActivityForResult(call, i, "storageSettingsResult");
            }
        } else {
            requestPermissionForAlias("storage", call, "storagePermResult");
        }
    }

    @ActivityCallback
    private void storageSettingsResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject r = new JSObject(); r.put("granted", allFilesAccess()); call.resolve(r);
    }

    @PermissionCallback
    private void storagePermResult(PluginCall call) {
        JSObject r = new JSObject(); r.put("granted", allFilesAccess()); call.resolve(r);
    }

    /** Walks the shared storage (and any mounted SD card) for files with the given extensions. */
    @PluginMethod
    public void scanDevice(PluginCall call) {
        if (!allFilesAccess()) { call.reject("no storage access", "NO_ACCESS"); return; }
        JSArray extsArr = call.getArray("exts");
        List<String> exts = new ArrayList<>();
        try { if (extsArr != null) for (int i = 0; i < extsArr.length(); i++) exts.add(extsArr.getString(i).toLowerCase()); } catch (Exception ignored) {}
        List<File> roots = new ArrayList<>();
        // A named shared folder only ("Download", "Documents"), or everything.
        String only = call.getString("root", "");
        if (only != null && !only.isEmpty()) {
            File d = Environment.getExternalStoragePublicDirectory(only.equals("Documents") ? Environment.DIRECTORY_DOCUMENTS : Environment.DIRECTORY_DOWNLOADS);
            if (d != null && d.canRead()) roots.add(d);
        } else roots.add(Environment.getExternalStorageDirectory());
        if ((only == null || only.isEmpty()) && Build.VERSION.SDK_INT >= 30) {
            try {
                android.os.storage.StorageManager sm = (android.os.storage.StorageManager) getContext().getSystemService(Context.STORAGE_SERVICE);
                for (android.os.storage.StorageVolume v : sm.getStorageVolumes()) { File d = v.getDirectory(); if (d != null && d.canRead() && !roots.contains(d)) roots.add(d); }
            } catch (Exception ignored) {}
        }
        if (only == null || only.isEmpty()) for (File f : getContext().getExternalFilesDirs(null)) {
            // /storage/XXXX-XXXX/Android/data/<pkg>/files → /storage/XXXX-XXXX
            if (f == null) continue;
            File p = f;
            for (int i = 0; i < 4 && p != null; i++) p = p.getParentFile();
            if (p != null && !roots.contains(p) && p.canRead()) roots.add(p);
        }
        JSArray out = new JSArray();
        ArrayDeque<File> queue = new ArrayDeque<>(roots);
        int visited = 0;
        // (Wide: every shared folder, apps' shared media — WhatsApp and Telegram keep received documents under
        // Android/media — and every mounted card or drive; apps' private data and caches left out.)
        java.util.HashSet<String> seenDirs = new java.util.HashSet<>();
        while (!queue.isEmpty() && visited < 80000 && out.length() < 30000) {
            File dir = queue.poll();
            visited++;
            try { if (!seenDirs.add(dir.getCanonicalPath())) continue; } catch (Exception ignored) {}
            File[] kids = dir.listFiles();
            if (kids == null) continue;
            for (File k : kids) {
                String name = k.getName();
                if (k.isDirectory()) {
                    boolean inAndroid = dir.getName().equals("Android") && dir.getParentFile() != null && roots.contains(dir.getParentFile());
                    if (name.equals("Android")) { queue.add(k); continue; }            // only its media folder (below)
                    if (inAndroid && !name.equals("media")) continue;                    // data, obb: private to apps
                    if (name.startsWith(".") && !name.equalsIgnoreCase(".Telegram")) continue;
                    if (name.equalsIgnoreCase("LOST.DIR") || name.equalsIgnoreCase(".thumbnails") || name.equalsIgnoreCase("cache")) continue;
                    queue.add(k);
                    continue;
                }
                int dot = name.lastIndexOf('.');
                String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase() : "";
                if (!exts.isEmpty() && !exts.contains(ext)) continue;
                JSObject f = new JSObject();
                f.put("uri", Uri.fromFile(k).toString());
                f.put("name", name);
                f.put("path", k.getAbsolutePath());
                f.put("mime", "");
                f.put("size", k.length());
                f.put("modified", k.lastModified());
                out.put(f);
            }
        }
        JSObject ret = new JSObject();
        ret.put("files", out);
        ret.put("truncated", !queue.isEmpty() || out.length() >= 30000);
        call.resolve(ret);
    }

    /** Opens a file in another app of the user's choosing (a PDF in a printing or viewing app, say). */
    @PluginMethod
    public void openWith(PluginCall call) {
        String uriStr = call.getString("uri");
        String mime = call.getString("mime", "*/*");
        if (uriStr == null) { call.reject("uri required"); return; }
        try {
            Uri uri = Uri.parse(uriStr);
            if ("file".equals(uri.getScheme())) uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", new File(uri.getPath()));
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, mime);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(Intent.createChooser(intent, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION));
            call.resolve();
        } catch (Exception e) { call.reject("open failed: " + e.getMessage(), e); }
    }

    /** Puts a PNG (base64) on the clipboard as an image. */
    @PluginMethod
    public void copyImage(PluginCall call) {
        String data = call.getString("data", "");
        try {
            File dir = new File(getContext().getCacheDir(), "kr-share");
            dir.mkdirs();
            File f = new File(dir, "clip-" + System.currentTimeMillis() + ".png");
            try (FileOutputStream out = new FileOutputStream(f)) { out.write(Base64.decode(data, Base64.DEFAULT)); }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = new ClipData(new android.content.ClipDescription("image", new String[]{ "image/png" }), new ClipData.Item(uri));
            // The clipboard service grants the pasting app read access to the URI when it pastes.
            cm.setPrimaryClip(clip);
            call.resolve();
        } catch (Exception e) { call.reject("copy failed: " + e.getMessage(), e); }
    }

    /** Reads one document as base64 so the web side can import it. */
    @PluginMethod
    public void readDocument(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null) { call.reject("uri required"); return; }
        try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uriStr))) {
            if (in == null) { call.reject("cannot open"); return; }
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[1 << 16]; int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            JSObject ret = new JSObject();
            ret.put("data", Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
            ret.put("name", displayName(Uri.parse(uriStr)));
            call.resolve(ret);
        } catch (Exception e) { call.reject("read failed: " + e.getMessage(), e); }
    }

    /** Name, size and whether the app may keep reading this URI later (so it can be linked instead of copied). */
    @PluginMethod
    public void docInfo(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null) { call.reject("uri required"); return; }
        Uri uri = Uri.parse(uriStr);
        JSObject ret = new JSObject();
        ret.put("name", displayName(uri));
        long size = -1;
        if ("file".equals(uri.getScheme())) { java.io.File f = new java.io.File(uri.getPath()); if (f.exists()) size = f.length(); }
        else try (android.database.Cursor c = getContext().getContentResolver().query(uri, new String[]{ android.provider.OpenableColumns.SIZE }, null, null, null)) {
            if (c != null && c.moveToFirst()) { int i = c.getColumnIndex(android.provider.OpenableColumns.SIZE); if (i >= 0 && !c.isNull(i)) size = c.getLong(i); }
        } catch (Exception ignored) { }
        boolean persistable = false;
        if ("content".equals(uri.getScheme())) {
            try { getContext().getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); persistable = true; } catch (Exception ignored) { }
        }
        ret.put("size", size);
        ret.put("persistable", persistable);
        call.resolve(ret);
    }

    /** Make the WebView draw again (after the app is brought up by another app it can sit on a stale frame until touched). */
    @PluginMethod
    public void repaint(PluginCall call) {
        if (getActivity() instanceof MainActivity) ((MainActivity) getActivity()).kick();
        call.resolve();
    }

    /** The file name a content:// URI stands for (what the sharing app calls it). */
    private String displayName(Uri uri) {
        if ("file".equals(uri.getScheme())) return uri.getLastPathSegment();
        try (android.database.Cursor c = getContext().getContentResolver().query(uri, new String[]{ android.provider.OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) { int i = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME); if (i >= 0) { String n = c.getString(i); if (n != null && !n.isEmpty()) return n; } }
        } catch (Exception ignored) { }
        String last = uri.getLastPathSegment();
        return last == null ? "" : last;
    }

    /**
     * Copies a file the app wrote to its cache (`path`, a file:// URI or a path) into the device's Downloads
     * folder, under `name` (Android numbers it when that name is taken). The file is streamed, never held whole.
     */
    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        String path = call.getString("path", "");
        String name = call.getString("name", "file");
        String mime = call.getString("mime", "application/octet-stream");
        try {
            File src = new File(path.startsWith("file://") ? Uri.parse(path).getPath() : path);
            if (!src.exists()) { call.reject("No such file"); return; }
            String shown;
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                v.put(MediaStore.Downloads.MIME_TYPE, mime);
                v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                v.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = getContext().getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) { call.reject("MediaStore insert failed"); return; }
                try (InputStream in = new java.io.FileInputStream(src); OutputStream out = getContext().getContentResolver().openOutputStream(uri)) { copy(in, out); }
                v.clear(); v.put(MediaStore.Downloads.IS_PENDING, 0);
                getContext().getContentResolver().update(uri, v, null, null);
                String shownName = name;
                try (Cursor c = getContext().getContentResolver().query(uri, new String[]{ MediaStore.Downloads.DISPLAY_NAME }, null, null, null)) {
                    if (c != null && c.moveToFirst()) shownName = c.getString(0);
                } catch (Exception ignored) { }
                shown = Environment.DIRECTORY_DOWNLOADS + "/" + shownName;
            } else {
                File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                dir.mkdirs();
                File f = new File(dir, name);
                int dot = name.lastIndexOf('.');
                String stem = dot > 0 ? name.substring(0, dot) : name, ext = dot > 0 ? name.substring(dot) : "";
                for (int i = 1; f.exists(); i++) f = new File(dir, stem + " (" + i + ")" + ext);
                try (InputStream in = new java.io.FileInputStream(src); OutputStream out = new FileOutputStream(f)) { copy(in, out); }
                MediaScannerConnection.scanFile(getContext(), new String[]{ f.getAbsolutePath() }, new String[]{ mime }, null);
                shown = Environment.DIRECTORY_DOWNLOADS + "/" + f.getName();
            }
            src.delete();
            JSObject ret = new JSObject(); ret.put("path", shown); call.resolve(ret);
        } catch (Exception e) {
            call.reject("Save failed: " + e.getMessage(), e);
        }
    }

    private static void copy(InputStream in, OutputStream out) throws java.io.IOException {
        byte[] buf = new byte[1 << 16];
        for (int n; (n = in.read(buf)) > 0;) out.write(buf, 0, n);
    }

    /** Saves a PNG/JPEG (base64) into the device gallery under Pictures/<folder>. */
    @PluginMethod
    public void saveToGallery(PluginCall call) {
        String data = call.getString("data", "");
        String name = call.getString("name", "snapshot.png");
        String folder = call.getString("folder", "Screenshots");
        String mime = name.toLowerCase().endsWith(".jpg") || name.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : "image/png";
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            String shown;
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Images.Media.DISPLAY_NAME, name);
                v.put(MediaStore.Images.Media.MIME_TYPE, mime);
                v.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/" + folder);
                v.put(MediaStore.Images.Media.IS_PENDING, 1);
                Uri uri = getContext().getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                if (uri == null) { call.reject("MediaStore insert failed"); return; }
                try (OutputStream out = getContext().getContentResolver().openOutputStream(uri)) { out.write(bytes); }
                v.clear(); v.put(MediaStore.Images.Media.IS_PENDING, 0);
                getContext().getContentResolver().update(uri, v, null, null);
                shown = Environment.DIRECTORY_PICTURES + "/" + folder + "/" + name;
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), folder);
                dir.mkdirs();
                File f = new File(dir, name);
                try (FileOutputStream out = new FileOutputStream(f)) { out.write(bytes); }
                MediaScannerConnection.scanFile(getContext(), new String[]{ f.getAbsolutePath() }, new String[]{ mime }, null);
                shown = f.getAbsolutePath();
            }
            JSObject ret = new JSObject(); ret.put("path", shown); call.resolve(ret);
        } catch (Exception e) {
            call.reject("Save failed: " + e.getMessage(), e);
        }
    }

    /** Volume keys turn pages when the reader asks for it (MainActivity consults this flag). */
    public static volatile boolean volumeKeys = false;

    private static long dirSize(File f) {
        if (f == null || !f.exists()) return 0;
        if (f.isFile()) return f.length();
        long n = 0; File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) n += dirSize(k);
        return n;
    }
    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    /** Where the app's space goes: WebView data (library database), cache, everything else. */
    @PluginMethod
    public void storageInfo(PluginCall call) {
        File data = getContext().getDataDir();
        JSObject ret = new JSObject();
        ret.put("webview", dirSize(new File(data, "app_webview")));
        ret.put("cache", dirSize(getContext().getCacheDir()) + dirSize(getContext().getCodeCacheDir()));
        ret.put("files", dirSize(getContext().getFilesDir()));
        ret.put("total", dirSize(data) + dirSize(getContext().getCacheDir()));
        call.resolve(ret);
    }

    /** Frees everything that can be rebuilt: page caches, downloaded updates, the WebView's HTTP / code caches. */
    @PluginMethod
    public void clearCaches(PluginCall call) {
        long before = dirSize(getContext().getCacheDir()) + dirSize(getContext().getCodeCacheDir());
        deleteTree(new File(getContext().getCacheDir(), "kr-pdf"));
        deleteTree(new File(getContext().getCacheDir(), "kr-update"));
        File[] kids = getContext().getCacheDir().listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        getActivity().runOnUiThread(() -> {
            try { getBridge().getWebView().clearCache(true); } catch (Exception ignored) {}
            long after = dirSize(getContext().getCacheDir()) + dirSize(getContext().getCodeCacheDir());
            JSObject ret = new JSObject();
            ret.put("freed", Math.max(0, before - after));
            call.resolve(ret);
        });
    }

    /** Write a file into a folder the user picked (tree URI). Call with append=true for further chunks to the returned uri. */
    @PluginMethod
    public void writeDocument(PluginCall call) {
        String data = call.getString("data", "");
        String target = call.getString("uri", null);
        try {
            Uri uri;
            if (target == null) {
                Uri tree = Uri.parse(call.getString("tree", ""));
                Uri parent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
                uri = DocumentsContract.createDocument(getContext().getContentResolver(), parent, call.getString("mime", "application/octet-stream"), call.getString("name", "file"));
                if (uri == null) { call.reject("cannot create"); return; }
            } else uri = Uri.parse(target);
            try (java.io.OutputStream out = getContext().getContentResolver().openOutputStream(uri, target == null ? "w" : "wa")) {
                if (out == null) { call.reject("cannot write"); return; }
                out.write(Base64.decode(data, Base64.DEFAULT));
            }
            try { getContext().getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) {}
            JSObject ret = new JSObject();
            ret.put("uri", uri.toString());
            call.resolve(ret);
        } catch (Exception e) { call.reject("write failed: " + e.getMessage(), e); }
    }

    /** Which launcher alias (and so which app name) is shown: "auto" follows the system language, or en/ar/ja/zh/ko. */
    @PluginMethod
    public void setAppName(PluginCall call) {
        String lang = call.getString("lang", "auto");
        String[] all = { "Auto", "En", "Ar", "Ja", "Zh", "Ko" };
        String want = lang.equals("auto") ? "Auto" : Character.toUpperCase(lang.charAt(0)) + lang.substring(1).toLowerCase();
        android.content.pm.PackageManager pm = getContext().getPackageManager();
        String pkg = getContext().getPackageName();
        boolean found = false;
        for (String a : all) if (a.equals(want)) found = true;
        if (!found) want = "Auto";
        // Enable the wanted alias first so the launcher never sees a moment without an entry.
        pm.setComponentEnabledSetting(new android.content.ComponentName(pkg, pkg + ".Launcher" + want), android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED, android.content.pm.PackageManager.DONT_KILL_APP);
        for (String a : all) if (!a.equals(want)) pm.setComponentEnabledSetting(new android.content.ComponentName(pkg, pkg + ".Launcher" + a), android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DISABLED, android.content.pm.PackageManager.DONT_KILL_APP);
        call.resolve();
    }

    /** Screen brightness of this window: 0–1, or -1 to follow the system setting. */
    @PluginMethod
    public void setBrightness(PluginCall call) {
        final double v = call.getDouble("value", -1.0);
        getActivity().runOnUiThread(() -> {
            android.view.WindowManager.LayoutParams lp = getActivity().getWindow().getAttributes();
            lp.screenBrightness = v < 0 ? android.view.WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE : (float) Math.max(0.01, Math.min(1.0, v));
            getActivity().getWindow().setAttributes(lp);
            call.resolve();
        });
    }

    /** Current brightness: the window override if set, else the system level (0–1). */
    @PluginMethod
    public void getBrightness(PluginCall call) {
        JSObject ret = new JSObject();
        float lp = getActivity().getWindow().getAttributes().screenBrightness;
        double v = lp >= 0 ? lp : -1;
        if (v < 0) {
            try { v = android.provider.Settings.System.getInt(getContext().getContentResolver(), android.provider.Settings.System.SCREEN_BRIGHTNESS) / 255.0; } catch (Exception e) { v = 0.5; }
        }
        ret.put("value", v);
        call.resolve(ret);
    }

    @PluginMethod
    public void setVolumeKeys(PluginCall call) {
        volumeKeys = call.getBoolean("on", false);
        call.resolve();
    }

    @PluginMethod
    public void setImmersive(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", true));
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            View decor = window.getDecorView();
            WindowInsetsControllerCompat c = WindowCompat.getInsetsController(window, decor);
            WindowCompat.setDecorFitsSystemWindows(window, !on);
            if (on) {
                c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                c.hide(WindowInsetsCompat.Type.systemBars());
            } else {
                c.show(WindowInsetsCompat.Type.systemBars());
            }
            call.resolve();
        });
    }

    /** The PDFs open for drawing: the reader's (id 0, the default) and the tools' (ids given at open). */
    private static final class Opened { PdfRenderer renderer; ParcelFileDescriptor pfd; }
    private final java.util.Map<Integer, Opened> opened = new java.util.HashMap<>();
    private int openSeq = 0;

    /** {path, keep?} → {id, pageCount, pages: [[w, h] in points…]}. Without `keep`, the document replaces the
     *  reader's (id 0); with it, the document gets an id of its own and the others stay open — the PDF tools
     *  draw their thumbnails while a book is being read. */
    @PluginMethod
    public void pdfOpen(PluginCall call) {
        String path = call.getString("path", "");
        if (path.startsWith("file://")) path = path.substring(7);
        boolean keep = Boolean.TRUE.equals(call.getBoolean("keep", false));
        try {
            synchronized (lock) {
                int id = keep ? ++openSeq : 0;
                closeInternal(id);
                Opened o = new Opened();
                // Linked books open straight from where they live (no copy in the cache).
                o.pfd = path.startsWith("content://")
                    ? getContext().getContentResolver().openFileDescriptor(Uri.parse(path), "r")
                    : ParcelFileDescriptor.open(new File(path), ParcelFileDescriptor.MODE_READ_ONLY);
                o.renderer = new PdfRenderer(o.pfd);
                opened.put(id, o);
                JSObject ret = new JSObject();
                ret.put("id", id);
                int n = o.renderer.getPageCount();
                ret.put("pageCount", n);
                // (The pages' sizes, so the page can lay a grid out before any is drawn — cheap: no drawing.)
                if (Boolean.TRUE.equals(call.getBoolean("sizes", false))) {
                    JSArray sizes = new JSArray();
                    for (int i = 0; i < Math.min(n, 4000); i++) { PdfRenderer.Page pg = o.renderer.openPage(i); try { JSArray wh = new JSArray(); wh.put(pg.getWidth()); wh.put(pg.getHeight()); sizes.put(wh); } finally { pg.close(); } }
                    ret.put("pages", sizes);
                }
                call.resolve(ret);
            }
        } catch (Exception e) {
            call.reject("Cannot open PDF: " + e.getMessage(), e);
        }
    }

    private int renderSeq = 0;

    /**
     * One page, or one tile of it, as a JPEG (or a PNG with `format: "png"`). `width` is the whole page's width in
     * pixels at the size wanted; with `tileW`/`tileH` only that part of it (from `tileX`, `tileY`) is drawn — a
     * zoomed page is drawn in pieces, never as one huge picture. With `toFile` the picture is written to the cache
     * and its path returned (the web view fetches it as bytes), else returned as base64. `id` names the document
     * (the reader's when absent).
     */
    @PluginMethod
    public void pdfRender(PluginCall call) {
        int id = call.getInt("id", 0);
        int page = call.getInt("page", 1);
        int width = call.getInt("width", 1080);
        int quality = call.getInt("quality", 85);
        boolean png = "png".equals(call.getString("format", "jpeg"));
        int tileW = call.getInt("tileW", 0), tileH = call.getInt("tileH", 0);
        int tileX = call.getInt("tileX", 0), tileY = call.getInt("tileY", 0);
        boolean toFile = Boolean.TRUE.equals(call.getBoolean("toFile", false));
        try {
            Bitmap bmp; int w, h;
            synchronized (lock) {
                Opened o = opened.get(id);
                if (o == null) { call.reject("No PDF open"); return; }
                PdfRenderer.Page p = o.renderer.openPage(page - 1);
                try {
                    if (tileW > 0 && tileH > 0) {
                        w = Math.min(tileW, 4096); h = Math.min(tileH, 4096);
                        float k = width / (float) p.getWidth();
                        bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
                        bmp.eraseColor(Color.WHITE);
                        android.graphics.Matrix m = new android.graphics.Matrix();
                        m.setScale(k, k); m.postTranslate(-tileX, -tileY);
                        p.render(bmp, null, m, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                    } else {
                        // (A whole page up to 5000 px wide — 300 dpi of a Letter page — for the tools' pictures.)
                        w = Math.max(64, Math.min(width, 5000));
                        h = Math.max(1, (int) Math.round(w * (p.getHeight() / (double) p.getWidth())));
                        bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
                        bmp.eraseColor(Color.WHITE);
                        p.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                    }
                } finally { p.close(); }
            }
            JSObject ret = new JSObject();
            ret.put("width", w);
            ret.put("height", h);
            Bitmap.CompressFormat fmt = png ? Bitmap.CompressFormat.PNG : Bitmap.CompressFormat.JPEG;
            if (toFile) {
                File dir = new File(getContext().getCacheDir(), "kr-pdfr"); dir.mkdirs();
                File f = new File(dir, "r" + (renderSeq++ % 12) + (png ? ".png" : ".jpg"));
                try (OutputStream out = new java.io.BufferedOutputStream(new FileOutputStream(f), 1 << 16)) { bmp.compress(fmt, quality, out); }
                bmp.recycle();
                ret.put("path", f.getAbsolutePath());
            } else {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                bmp.compress(fmt, quality, out);
                bmp.recycle();
                ret.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            }
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Render failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void pdfClose(PluginCall call) {
        synchronized (lock) { closeInternal(call.getInt("id", 0)); }
        call.resolve();
    }

    private void closeInternal(int id) {
        Opened o = opened.remove(id);
        if (o == null) return;
        try { if (o.renderer != null) o.renderer.close(); } catch (Exception ignored) {}
        try { if (o.pfd != null) o.pfd.close(); } catch (Exception ignored) {}
    }

    // ---- Read aloud: the system's text-to-speech engine (the WebView has no speechSynthesis) ----

    private TextToSpeech tts;
    private boolean ttsReady = false;
    private final List<Runnable> ttsWaiting = new ArrayList<>();

    private void withTts(Runnable r) {
        if (tts != null && ttsReady) { r.run(); return; }
        synchronized (ttsWaiting) { ttsWaiting.add(r); }
        if (tts != null) return;
        tts = new TextToSpeech(getContext(), status -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            if (ttsReady) {
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) { JSObject o = new JSObject(); o.put("id", id); notifyListeners("ttsStart", o); }
                    @Override public void onDone(String id) { JSObject o = new JSObject(); o.put("id", id); notifyListeners("ttsDone", o); }
                    @Override @SuppressWarnings("deprecation") public void onError(String id) { JSObject o = new JSObject(); o.put("id", id); notifyListeners("ttsError", o); }
                    @Override public void onError(String id, int code) { JSObject o = new JSObject(); o.put("id", id); o.put("code", code); notifyListeners("ttsError", o); }
                });
            }
            List<Runnable> w;
            synchronized (ttsWaiting) { w = new ArrayList<>(ttsWaiting); ttsWaiting.clear(); }
            for (Runnable x : w) x.run();
        });
    }

    @PluginMethod
    public void ttsSpeak(PluginCall call) {
        final String text = call.getString("text", "");
        final String lang = call.getString("lang", "");
        final String id = call.getString("id", "kr");
        final String voiceName = call.getString("voice", "");
        final double rate = call.getDouble("rate", 1.0);
        withTts(() -> {
            if (!ttsReady) { JSObject r = new JSObject(); r.put("ok", false); r.put("reason", "unavailable"); call.resolve(r); return; }
            Locale loc = lang.isEmpty() ? Locale.getDefault() : Locale.forLanguageTag(lang);
            int avail = tts.isLanguageAvailable(loc);
            if (avail < TextToSpeech.LANG_AVAILABLE) {
                JSObject r = new JSObject(); r.put("ok", false); r.put("reason", avail == TextToSpeech.LANG_MISSING_DATA ? "missing-data" : "not-supported"); call.resolve(r); return;
            }
            Voice chosen = null;
            try {
                Set<Voice> vs = tts.getVoices();
                if (vs != null && !voiceName.isEmpty()) for (Voice v : vs) if (v.getName().equals(voiceName)) { chosen = v; break; }
            } catch (Exception ignored) {}
            if (chosen != null) tts.setVoice(chosen); else tts.setLanguage(loc);
            tts.setSpeechRate((float) rate);
            int res = tts.speak(text, TextToSpeech.QUEUE_FLUSH, new android.os.Bundle(), id);
            JSObject r = new JSObject(); r.put("ok", res == TextToSpeech.SUCCESS); if (res != TextToSpeech.SUCCESS) r.put("reason", "unavailable"); call.resolve(r);
        });
    }

    @PluginMethod
    public void ttsStop(PluginCall call) {
        if (tts != null) tts.stop();
        call.resolve();
    }

    @PluginMethod
    public void ttsVoices(PluginCall call) {
        withTts(() -> {
            JSArray a = new JSArray();
            try {
                Set<Voice> vs = ttsReady ? tts.getVoices() : null;
                if (vs != null) for (Voice v : vs) {
                    JSObject o = new JSObject();
                    o.put("name", v.getName());
                    o.put("lang", v.getLocale().toLanguageTag());
                    o.put("network", v.isNetworkConnectionRequired());
                    o.put("quality", v.getQuality());
                    Set<String> f = v.getFeatures();
                    o.put("installed", f == null || !f.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED));
                    a.put(o);
                }
            } catch (Exception ignored) {}
            JSObject r = new JSObject(); r.put("voices", a); call.resolve(r);
        });
    }

    @PluginMethod
    public void ttsInstallData(PluginCall call) {
        try {
            Intent i = new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            try { Intent i = new Intent("com.android.settings.TTS_SETTINGS"); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(i); call.resolve(); }
            catch (Exception e2) { call.reject(e2.getMessage()); }
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) { try { tts.shutdown(); } catch (Exception ignored) {} tts = null; ttsReady = false; }
        if (browser != null) { browser.closeAll(); browser = null; }
        super.handleOnDestroy();
    }
}
