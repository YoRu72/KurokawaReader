package app.kurokawa.tools;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Cookie jars: one or more signed-in states a site, each a Netscape «cookies.txt» kept encrypted (the Keystore
 *  through EncryptedSharedPreferences, as the remotes are), named by the reader. A jar comes from the app's own
 *  browser (the cookies the WebView holds for a site), from a cookies.txt pasted or picked, or from a text typed.
 *  Each jar knows when it was taken and when its soonest cookie expires (its freshness); it can be tested against
 *  the site (a request with it: signed in or not); a download names the jar it uses and gets a throw-away copy, so
 *  whatever the engine rewrites never touches the jar. */
final class KtCookies {
    private KtCookies() {}
    private static final String TAG = "KtCookies";

    static SharedPreferences prefs(Context ctx) {
        try {
            String key = androidx.security.crypto.MasterKeys.getOrCreate(androidx.security.crypto.MasterKeys.AES256_GCM_SPEC);
            return androidx.security.crypto.EncryptedSharedPreferences.create("kt-cookies", key, ctx, androidx.security.crypto.EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV, androidx.security.crypto.EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
        } catch (Throwable e) { Log.w(TAG, "encrypted prefs unavailable: " + e); return ctx.getSharedPreferences("kt-cookies-plain", Context.MODE_PRIVATE); }
    }
    static JSONArray all(Context ctx) { try { return new JSONArray(prefs(ctx).getString("jars", "[]")); } catch (Exception e) { return new JSONArray(); } }
    private static void write(Context ctx, JSONArray a) { prefs(ctx).edit().putString("jars", a.toString()).apply(); }
    static JSONObject get(Context ctx, String id) throws IOException { JSONArray a = all(ctx); for (int i = 0; i < a.length(); i++) { JSONObject j = a.optJSONObject(i); if (j != null && id.equals(j.optString("id"))) return j; } throw new IOException("noJar"); }

    /** The list for the page: no cookie values, only what describes each jar. */
    static JSONArray publicList(Context ctx) throws Exception {
        JSONArray a = all(ctx), out = new JSONArray();
        for (int i = 0; i < a.length(); i++) { JSONObject j = a.getJSONObject(i); JSONObject p = new JSONObject(); for (String k : new String[] { "id", "name", "domain", "savedAt", "count", "expiresAt", "source", "testedAt", "testOk" }) if (j.has(k)) p.put(k, j.get(k)); out.put(p); }
        return out;
    }
    /** Saved from a cookies.txt text (Netscape lines; a «Set-Cookie»-less header line «name=value; …» is taken too, for the domain given). */
    static JSONObject save(Context ctx, String id, String name, String domain, String text, String source) throws Exception {
        String dom = domain == null ? "" : domain.trim().toLowerCase(Locale.ROOT).replaceFirst("^https?://", "").replaceFirst("/.*$", "").replaceFirst("^www\\.", "");
        List<String[]> rows = parse(text, dom);
        if (rows.isEmpty()) throw new IOException("noCookies");
        long soonest = Long.MAX_VALUE; for (String[] r : rows) { try { long e = Long.parseLong(r[4]); if (e > 0) soonest = Math.min(soonest, e * 1000); } catch (Exception ignored) {} }
        JSONObject j = new JSONObject(); j.put("id", id == null || id.isEmpty() ? java.util.UUID.randomUUID().toString().substring(0, 8) : id); j.put("name", name == null || name.trim().isEmpty() ? dom : name.trim()); j.put("domain", dom); j.put("savedAt", System.currentTimeMillis()); j.put("count", rows.size()); if (soonest != Long.MAX_VALUE) j.put("expiresAt", soonest); j.put("source", source == null ? "text" : source); j.put("text", netscape(rows));
        JSONArray a = all(ctx), out = new JSONArray(); boolean put = false; for (int i = 0; i < a.length(); i++) { JSONObject o = a.getJSONObject(i); if (o.optString("id").equals(j.getString("id"))) { out.put(j); put = true; } else out.put(o); } if (!put) out.put(j);
        write(ctx, out); return j;
    }
    /** The cookies the app's browser holds for a site, as a jar (names and values; the WebView tells no expiry, so a year is written). */
    static JSONObject fromBrowser(Context ctx, String id, String name, String url) throws Exception {
        String ck; try { ck = android.webkit.CookieManager.getInstance().getCookie(url); } catch (Throwable e) { ck = null; }
        if (ck == null || ck.isEmpty()) throw new IOException("noCookies");
        String host = new URL(url).getHost().toLowerCase(Locale.ROOT).replaceFirst("^www\\.", "");
        return save(ctx, id, name, host, ck, "browser");
    }
    static void delete(Context ctx, String id) throws Exception { JSONArray a = all(ctx), out = new JSONArray(); for (int i = 0; i < a.length(); i++) { JSONObject o = a.getJSONObject(i); if (!o.optString("id").equals(id)) out.put(o); } write(ctx, out); }
    /** A throw-away copy of the jar as a file (for yt-dlp's --cookies, which rewrites the file it is given). */
    static File disposable(Context ctx, String id) throws Exception {
        JSONObject j = get(ctx, id); File dir = new File(ctx.getCacheDir(), "kt-cookies"); dir.mkdirs();
        File f = new File(dir, id + "-" + System.nanoTime() + ".txt"); try (FileOutputStream o = new FileOutputStream(f)) { o.write(j.optString("text").getBytes(StandardCharsets.UTF_8)); }
        return f;
    }
    /** The «Cookie» header the jar gives a host (its cookies whose domain matches, not expired). */
    static String headerFor(Context ctx, String id, String host) {
        try {
            JSONObject j = get(ctx, id); StringBuilder sb = new StringBuilder(); long now = System.currentTimeMillis() / 1000; String h = host.toLowerCase(Locale.ROOT);
            for (String[] r : parse(j.optString("text"), j.optString("domain"))) { String d = r[0].toLowerCase(Locale.ROOT).replaceFirst("^\\.", ""); if (!(h.equals(d) || h.endsWith("." + d))) continue; try { long e = Long.parseLong(r[4]); if (e > 0 && e < now) continue; } catch (Exception ignored) {} if (sb.length() > 0) sb.append("; "); sb.append(r[5]).append('=').append(r[6]); }
            return sb.toString();
        } catch (Exception e) { return ""; }
    }
    /** The jar tried against a URL: a request with its cookies; signed in when the answer is not a sign-in (2xx, and not sent to a login page). */
    static JSONObject test(Context ctx, String id, String url) throws Exception {
        JSONObject j = get(ctx, id); URL u = new URL(url == null || url.isEmpty() ? "https://" + j.optString("domain") + "/" : url);
        HttpURLConnection c = KrDoh.open(u); c.setInstanceFollowRedirects(false); c.setConnectTimeout(15000); c.setReadTimeout(20000); c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36");
        String ck = headerFor(ctx, id, u.getHost()); if (!ck.isEmpty()) c.setRequestProperty("Cookie", ck);
        int code = c.getResponseCode(); String loc = c.getHeaderField("Location"); c.disconnect();
        boolean ok = code >= 200 && code < 300 || (code >= 300 && code < 400 && loc != null && !loc.toLowerCase(Locale.ROOT).matches(".*(login|signin|sign-in|auth|account/log).*"));
        JSONArray a = all(ctx); for (int i = 0; i < a.length(); i++) { JSONObject o = a.getJSONObject(i); if (o.optString("id").equals(id)) { o.put("testedAt", System.currentTimeMillis()); o.put("testOk", ok); } } write(ctx, a);
        JSONObject r = new JSONObject(); r.put("ok", ok); r.put("status", code); return r;
    }
    /** The jars whose domain fits a host, the exact one first. */
    static JSONArray forHost(Context ctx, String host) throws Exception {
        JSONArray a = publicList(ctx), out = new JSONArray(); String h = host.toLowerCase(Locale.ROOT).replaceFirst("^www\\.", "");
        for (int i = 0; i < a.length(); i++) { JSONObject o = a.getJSONObject(i); String d = o.optString("domain"); if (h.equals(d)) out.put(o); } for (int i = 0; i < a.length(); i++) { JSONObject o = a.getJSONObject(i); String d = o.optString("domain"); if (!h.equals(d) && !d.isEmpty() && (h.endsWith("." + d) || d.endsWith("." + h))) out.put(o); }
        return out;
    }

    /* ---------- the text ---------- */
    /** Rows of (domain, flag, path, secure, expires, name, value) from Netscape lines, or from a header-style «a=b; c=d» for the domain given. */
    static List<String[]> parse(String text, String domain) {
        List<String[]> out = new ArrayList<>(); if (text == null) return out;
        boolean any = false;
        for (String raw : text.split("\r?\n")) { String l = raw.trim(); if (l.isEmpty() || l.startsWith("#") && !l.startsWith("#HttpOnly_")) continue; if (l.startsWith("#HttpOnly_")) l = l.substring(10); String[] p = l.split("\t"); if (p.length >= 7) { out.add(new String[] { p[0], p[1], p[2], p[3], p[4], p[5], p[6] }); any = true; } }
        if (!any && domain != null && !domain.isEmpty()) {
            long year = System.currentTimeMillis() / 1000 + 365L * 86400;
            for (String part : text.split(";\\s*|\r?\n")) { String s = part.trim(); int eq = s.indexOf('='); if (eq <= 0) continue; String n = s.substring(0, eq).trim(), v = s.substring(eq + 1).trim(); if (n.isEmpty() || n.equalsIgnoreCase("path") || n.equalsIgnoreCase("domain") || n.equalsIgnoreCase("expires") || n.equalsIgnoreCase("max-age")) continue; out.add(new String[] { "." + domain, "TRUE", "/", "TRUE", String.valueOf(year), n, v }); }
        }
        return out;
    }
    static String netscape(List<String[]> rows) { StringBuilder sb = new StringBuilder("# Netscape HTTP Cookie File\n"); for (String[] r : rows) sb.append(String.join("\t", r)).append('\n'); return sb.toString(); }
}
