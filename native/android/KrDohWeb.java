package app.kurokawa.reader;

import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The app's web views with DNS over HTTPS (see KrDoh): while the reader has a resolver chosen, the requests
 * (GET: pages, pictures, scripts, styles) to a site the network's DNS hides are made by the app, the site asked
 * at the address the resolver gave, and handed to the page — the site opens all the same. A request the
 * app cannot make for the page (a form sent, an error on the way) goes the web view's own way.
 */
class KrDohWeb extends WebViewClient {
    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
        if (!KrDoh.on()) return null;
        String scheme = req.getUrl() != null ? req.getUrl().getScheme() : null;
        if (!"GET".equalsIgnoreCase(req.getMethod()) || scheme == null || !(scheme.equals("http") || scheme.equals("https"))) return null;
        // (Only a site the network's DNS hides: the others go the web view's own way — see KrDoh.needed.)
        String host = req.getUrl().getHost();
        if (host == null || !KrDoh.needed(host)) return null;
        try { return fetch(req); } catch (Exception e) { return null; }
    }

    private static WebResourceResponse fetch(WebResourceRequest req) throws Exception {
        URL url = new URL(req.getUrl().toString());
        Map<String, String> asked = req.getRequestHeaders();
        CookieManager cm = CookieManager.getInstance();
        HttpURLConnection c = null; int code = 0;
        for (int hop = 0; hop < 10; hop++) {
            c = KrDoh.open(url);
            c.setConnectTimeout(20000); c.setReadTimeout(60000);
            if (asked != null) for (Map.Entry<String, String> e : asked.entrySet()) {
                String k = e.getKey();
                if (k == null || k.equalsIgnoreCase("accept-encoding") || k.equalsIgnoreCase("host") || k.equalsIgnoreCase("cookie")) continue;
                c.setRequestProperty(k, e.getValue());
            }
            String ck = cm.getCookie(url.toString());
            if (ck != null && !ck.isEmpty()) c.setRequestProperty("Cookie", ck);
            code = c.getResponseCode();
            List<String> set = c.getHeaderFields().get("Set-Cookie");
            if (set != null) for (String v : set) cm.setCookie(url.toString(), v);
            String loc = code >= 300 && code < 400 ? c.getHeaderField("Location") : null;
            if (loc == null) break;
            c.disconnect();
            URL next = new URL(url, loc);
            // (A page moved: the web view sent there by name — its address bar, its links and its own next
            // requests then go from the new address.)
            if (req.isForMainFrame()) {
                String to = next.toString().replace("\\", "\\\\").replace("\"", "\\\"").replace("<", "\\u003c");
                String html = "<!doctype html><meta name=\"referrer\" content=\"no-referrer\"><script>location.replace(\"" + to + "\")</script>";
                return new WebResourceResponse("text/html", "utf-8", 200, "OK", Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(html.getBytes("UTF-8")));
            }
            url = next;
        }
        String type = c.getContentType(); String mime = "application/octet-stream", charset = null;
        if (type != null) {
            String[] parts = type.split(";"); mime = parts[0].trim();
            for (String p : parts) { p = p.trim(); if (p.toLowerCase().startsWith("charset=")) charset = p.substring(8).replace("\"", "").trim(); }
        }
        Map<String, String> out = new HashMap<>();
        for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet()) {
            String k = e.getKey(); if (k == null) continue;
            if (k.equalsIgnoreCase("content-encoding") || k.equalsIgnoreCase("content-length") || k.equalsIgnoreCase("transfer-encoding") || k.equalsIgnoreCase("set-cookie")) continue;
            StringBuilder v = new StringBuilder(); for (String x : e.getValue()) { if (v.length() > 0) v.append(", "); v.append(x); }
            out.put(k, v.toString());
        }
        InputStream body = code >= 400 ? c.getErrorStream() : c.getInputStream();
        if (body == null) body = new ByteArrayInputStream(new byte[0]);
        String reason = c.getResponseMessage(); if (reason == null || reason.trim().isEmpty()) reason = "OK";
        int status = code < 100 || (code >= 300 && code < 400) ? 200 : code;
        return new WebResourceResponse(mime, charset, status, reason, out, body);
    }
}
