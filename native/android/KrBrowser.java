package app.kurokawa.reader;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The app's own browser, for the sites that answer only a browser.
 *
 * A site behind Cloudflare (or DDoS-Guard and the like) may turn the app's plain requests away: its check wants
 * a browser, and some sites' rules look at the connection itself, so that even the clearance a passed check
 * leaves behind does not let the app's own requests through. A web view of the app's — Chromium, with the
 * app's cookies and the same identity (User-Agent) as its requests — does the work instead:
 *  - check: the site opened to pass its check: out of sight first (the JavaScript checks pass by themselves),
 *    else in a window the reader acts in ("confirm you are human"), which closes by itself once the site shows
 *    a page of its own;
 *  - fetch: a request made by a page of the site itself — a view opened on the site once (its check passed as
 *    any browser passes it) and kept out of sight behind the app for a few minutes, each request that page's
 *    own fetch, its answer handed back in pieces through a bridge;
 *  - forget: the site's clearance (or all its cookies) cleared and its view closed, for a check gone stale.
 * Every WebView call is made on the main thread; the bridge's calls arrive on its own.
 */
final class KrBrowser {
    private static final long IDLE = 4 * 60_000L;          // a view unused this long is closed
    private final KurokawaPlugin plugin;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Map<String, Lane> lanes = new HashMap<>();                  // the main thread's only
    private final ConcurrentHashMap<String, Pending> pending = new ConcurrentHashMap<>();
    private boolean sweeping = false;

    KrBrowser(KurokawaPlugin plugin) { this.plugin = plugin; }

    /* ---------- a page's state, read by a script ---------- */

    /** The page as "readyState␁origin␁check␁refused␁title": a check (Cloudflare's, DDoS-Guard's…) still running,
     *  or a refusal no waiting will pass ("Sorry, you have been blocked", Cloudflare's errors 1006–1020). */
    static final String STATE_JS = "(function(){try{"
        + "var t=document.title||'',b=document.body?(document.body.innerText||'').slice(0,700):'';"
        + "var bl=/used Cloudflare to restrict access|Sorry, you have been blocked|You are unable to access|has banned you|banned your IP|Error 10(06|07|08|09|10|12|20)\\b/i.test(t+' '+b);"
        + "var ch=!bl&&(/Just a moment|Attention Required|Verifying you are human|Verify you are human|Checking your browser|Checking if the site connection is secure|Please wait|DDoS-Guard|One moment|لحظة|Один момент/i.test(t)"
        + "||!!document.querySelector('#challenge-form,#challenge-running,#challenge-stage,#cf-challenge-running,.cf-browser-verification,#cf-please-wait,#turnstile-wrapper,[name=\"cf-turnstile-response\"],#ddg-captcha,.ddg-captcha,#sucuri_cloudproxy_js'));"
        + "return [document.readyState,location.origin,ch?1:0,bl?1:0,t.slice(0,140)].join('\\u0001');"
        + "}catch(e){return 'error';}})()";

    /** The request a lane's page makes for the app (`id`, `o` given): its answer sent back in pieces of 384 KB as
     *  they arrive, then its status, headers and address. Headers a page may not set are left to the page. */
    static final String FETCH_JS = "var B=window.KrLane;if(!B)return;"
        + "var h={},k;for(k in (o.headers||{})){if(!/^(user-agent|referer|cookie|cookie2|accept-encoding|host|origin|connection|content-length|keep-alive|te|trailer|transfer-encoding|upgrade|via|sec-.*|proxy-.*)$/i.test(k))h[k]=o.headers[k];}"
        + "var init={method:o.method||'GET',headers:h,credentials:'include',cache:'no-store',redirect:'follow'};"
        + "if(o.body!=null){if(o.bodyBase64){var s=atob(o.body),a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);init.body=a;}else init.body=o.body;}"
        + "var ctl=typeof AbortController=='function'?new AbortController():null,tm=0;if(ctl){init.signal=ctl.signal;tm=setTimeout(function(){ctl.abort();},o.timeout||90000);}"
        + "var CH=o.dl?1048576:393216,buf=new Uint8Array(0);"
        + "function b64(u){var s='';for(var j=0;j<u.length;j+=8192)s+=String.fromCharCode.apply(null,u.subarray(j,j+8192));return btoa(s);}"
        + "function flush(all){while(buf.length>=CH||(all&&buf.length)){var n=Math.min(CH,buf.length);B.chunk(id,b64(buf.subarray(0,n)));buf=buf.slice(n);}}"
        + "fetch(o.url,init).then(function(r){var hs={};r.headers.forEach(function(v,n){hs[n.toLowerCase()]=v;});if(o.dl&&B.meta)B.meta(id,parseInt(hs['content-length']||'0',10)||0);"
        + "function end(){flush(true);if(tm)clearTimeout(tm);B.done(id,r.status,JSON.stringify(hs),r.url||o.url);}"
        + "if(!r.body||!r.body.getReader)return r.arrayBuffer().then(function(ab){buf=new Uint8Array(ab);end();});"
        + "var rd=r.body.getReader();"
        + "return (function pump(){return rd.read().then(function(x){if(x.done){end();return;}var v=x.value,m=new Uint8Array(buf.length+v.length);m.set(buf);m.set(v,buf.length);buf=m;flush(false);return pump();});})();"
        + "}).catch(function(e){if(tm)clearTimeout(tm);B.fail(id,String(e&&e.message||e));});";

    /** The script's answer ("…␁…"), parsed: null when the page could not say. */
    static String[] state(String v) {
        try {
            if (v == null || v.equals("null")) return null;
            String s = new JSONArray("[" + v + "]").getString(0);
            String[] p = s.split("\u0001", -1);
            return p.length >= 5 ? p : null;
        } catch (Exception e) { return null; }
    }
    static boolean clear(String[] st, String origin) { return st != null && origin.equals(st[1]) && !"loading".equals(st[0]) && "0".equals(st[2]) && "0".equals(st[3]); }
    /** The site an origin belongs to, for a check: its host without "www." (a site sending example.com to
     *  www.example.com, or http to https, has still been passed). */
    static String siteOf(String origin) {
        String h = origin.replaceFirst("^[a-z]+://", "").replaceFirst(":\\d+$", "").toLowerCase(Locale.ROOT);
        return h.startsWith("www.") ? h.substring(4) : h;
    }
    static boolean clearFor(String[] st, String origin) { return st != null && st[1].startsWith("http") && siteOf(st[1]).equals(siteOf(origin)) && !"loading".equals(st[0]) && "0".equals(st[2]) && "0".equals(st[3]); }
    /** A page shown without a check, but on another site than the one asked for (a lane's requests from there
     *  would be another site's). */
    static boolean movedAway(String[] st, String origin) { return st != null && st[1].startsWith("http") && !origin.equals(st[1]) && !"loading".equals(st[0]) && "0".equals(st[2]) && "0".equals(st[3]); }

    /** "https://host[:port]" of an address (as a page's location.origin says it), or null. */
    static String originOf(String url) {
        try {
            java.net.URL u = new java.net.URL(url);
            String scheme = u.getProtocol().toLowerCase(Locale.ROOT);
            if (!scheme.equals("http") && !scheme.equals("https")) return null;
            int port = u.getPort();
            return scheme + "://" + u.getHost().toLowerCase(Locale.ROOT) + (port != -1 && port != u.getDefaultPort() ? ":" + port : "");
        } catch (Exception e) { return null; }
    }

    /* ---------- views ---------- */

    /** A web view with the app's identity: the same User-Agent as its requests, the shared cookie jar. */
    private static WebView makeView(Activity act, boolean images) {
        WebView web = new WebView(act);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setUserAgentString(WebSettings.getDefaultUserAgent(act));
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setBlockNetworkImage(!images);
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);
        return web;
    }

    /** A view kept out of sight: the window's full size (a check reads it), behind the app's own page. */
    private static void behind(Activity act, WebView web) {
        ViewGroup content = act.findViewById(android.R.id.content);
        web.setFocusable(false);
        web.setFocusableInTouchMode(false);
        web.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        // (Fully transparent: whatever shows through the app's own view — a moment of transition, a page drawn
        // without a background — never lets the site's page be seen. Still visible to its own scripts.)
        web.setAlpha(0f);
        content.addView(web, 0, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private static void dispose(WebView web) {
        try { web.stopLoading(); } catch (Exception ignored) {}
        try { ViewGroup p = (ViewGroup) web.getParent(); if (p != null) p.removeView(web); } catch (Exception ignored) {}
        try { web.destroy(); } catch (Exception ignored) {}
    }

    private static int dp(Activity act, int v) { return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, act.getResources().getDisplayMetrics())); }

    /** The site's cookies made to expire: its clearance only (cf_clearance, Cloudflare's other check cookies,
     *  DDoS-Guard's), or all of them. Returns how many names were cleared. */
    static int clearCookies(String url, boolean all) {
        try {
            CookieManager cm = CookieManager.getInstance();
            String have = cm.getCookie(url);
            if (have == null || have.isEmpty()) return 0;
            String host = new java.net.URL(url).getHost();
            List<String> domains = new ArrayList<>();
            domains.add(null);
            String[] parts = host.split("\\.");
            for (int i = 0; i < parts.length - 1; i++) {
                StringBuilder d = new StringBuilder();
                for (int j = i; j < parts.length; j++) d.append('.').append(parts[j]);
                domains.add(d.toString());
            }
            int n = 0;
            for (String c : have.split(";")) {
                String name = c.trim();
                int eq = name.indexOf('=');
                if (eq >= 0) name = name.substring(0, eq).trim();
                if (name.isEmpty()) continue;
                if (!all && !(name.equals("cf_clearance") || name.startsWith("__cf") || name.startsWith("cf_chl") || name.startsWith("__ddg"))) continue;
                // (Secure on an https site, as a clearance is set: an expired copy then replaces it.)
                String secure = url.startsWith("https:") ? "; Secure" : "";
                for (String d : domains) cm.setCookie(url, name + "=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/" + secure + (d == null ? "" : "; Domain=" + d));
                n++;
            }
            cm.flush();
            return n;
        } catch (Exception e) { return 0; }
    }

    /* ---------- check: a site's check passed, out of sight or by the reader ---------- */

    /** {url, hidden?, timeout?, fresh?, stay?, message?, done?, reload?} → {passed, blocked, title}. `fresh` clears
     *  the site's old clearance first; `stay` keeps the window until the reader closes it; `message` is the line
     *  shown above the page, `done` and `reload` its buttons. */
    void check(final PluginCall call) {
        final String url = call.getString("url", "");
        final String origin = originOf(url);
        if (origin == null) { call.reject("No url"); return; }
        final boolean hidden = Boolean.TRUE.equals(call.getBoolean("hidden", false));
        final int timeout = call.getInt("timeout", hidden ? 15000 : 300000);
        final boolean fresh = Boolean.TRUE.equals(call.getBoolean("fresh", false));
        // (A window that stays — the site opened for the reader to use, as Mihon's WebView — closes only when they close it.)
        final boolean stay = !hidden && Boolean.TRUE.equals(call.getBoolean("stay", false));
        final String message = call.getString("message", "");
        final String doneLabel = call.getString("done", "✓");
        final String reloadLabel = call.getString("reload", "↻");
        ui.post(() -> {
            final Activity act = plugin.getActivity();
            if (act == null) { call.reject("No activity"); return; }
            if (fresh) clearCookies(url, false);
            final WebView web;
            try { web = makeView(act, true); } catch (Exception e) { call.reject("WebView failed: " + e.getMessage()); return; }
            final boolean[] done = { false };
            final boolean[] passed = { false };
            final boolean[] blocked = { false };
            final String[] last = { "" };
            final Dialog[] dialog = { null };
            final Runnable finish = () -> {
                if (done[0]) return;
                done[0] = true;
                try { CookieManager.getInstance().flush(); } catch (Exception ignored) {}
                try { if (dialog[0] != null && dialog[0].isShowing()) dialog[0].dismiss(); } catch (Exception ignored) {}
                dispose(web);
                JSObject r = new JSObject();
                r.put("passed", passed[0]);
                r.put("blocked", blocked[0]);
                r.put("title", last[0]);
                call.resolve(r);
            };
            // (Read once more before closing: a check passed a moment before the reader closed the window counts.)
            final Runnable closeAfterLook = () -> {
                if (done[0]) return;
                try {
                    web.evaluateJavascript(STATE_JS, (v) -> { String[] st = state(v); if (clearFor(st, origin)) passed[0] = true; finish.run(); });
                    ui.postDelayed(finish, 1500);
                } catch (Exception e) { finish.run(); }
            };
            web.setWebViewClient(new WebViewClient());
            final long start = SystemClock.uptimeMillis();
            final Runnable[] poll = new Runnable[1];
            // (Asked every 600 ms whether or not the last question was answered — a page replaced mid-question, as a
            // check reloads, never answers it — and given up at the time allowed, answers or not. A window that
            // stays is closed by the reader only.)
            poll[0] = () -> {
                if (done[0]) return;
                if (!stay && SystemClock.uptimeMillis() - start > timeout) { finish.run(); return; }
                ui.postDelayed(poll[0], 600);
                try {
                    web.evaluateJavascript(STATE_JS, (v) -> {
                        if (done[0]) return;
                        String[] st = state(v);
                        if (st != null) last[0] = st[4];
                        if (clearFor(st, origin)) { passed[0] = true; blocked[0] = false; if (!stay) ui.postDelayed(finish, hidden ? 0 : 900); return; }
                        if (st != null && "1".equals(st[3])) { blocked[0] = true; if (hidden) finish.run(); }
                    });
                } catch (Exception e) { finish.run(); }
            };
            try {
                if (hidden) behind(act, web);
                else {
                    final Dialog d = new Dialog(act, android.R.style.Theme_DeviceDefault_NoActionBar);
                    final LinearLayout box = new LinearLayout(act);
                    box.setOrientation(LinearLayout.VERTICAL);
                    final LinearLayout bar = new LinearLayout(act);
                    bar.setOrientation(LinearLayout.HORIZONTAL);
                    bar.setGravity(Gravity.CENTER_VERTICAL);
                    bar.setBackgroundColor(0xFF1E1F22);
                    bar.setPadding(dp(act, 14), dp(act, 10), dp(act, 8), dp(act, 10));
                    final TextView text = new TextView(act);
                    text.setText(message.isEmpty() ? url : message);
                    text.setTextColor(0xFFECECEC);
                    text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
                    text.setTypeface(Typeface.DEFAULT_BOLD);
                    bar.addView(text, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
                    final Button again = new Button(act);
                    again.setText(reloadLabel);
                    again.setOnClickListener(v -> { try { web.reload(); } catch (Exception ignored) {} });
                    bar.addView(again, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
                    final Button close = new Button(act);
                    close.setText(doneLabel);
                    close.setOnClickListener(v -> closeAfterLook.run());
                    bar.addView(close, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
                    box.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
                    box.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
                    d.setContentView(box);
                    d.setOnDismissListener(x -> closeAfterLook.run());
                    dialog[0] = d;
                    d.show();
                }
                web.loadUrl(url);
            } catch (Exception e) { finish.run(); return; }
            ui.postDelayed(poll[0], 800);
        });
    }

    /* ---------- fetch: requests made by a page of the site ---------- */

    private static final class Lane {
        final String origin; WebView web; boolean ready, opening; long used; String title = "";
        final List<Waiter> waiting = new ArrayList<>();
        Lane(String origin) { this.origin = origin; }
    }
    private interface Waiter { void ready(Lane l); void failed(String why, String title); }
    private static final class Pending {
        final PluginCall call; final boolean binary; final Lane lane; final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        /** A download: written to a file as it comes, its progress told (downloadProgress events under `dlId`). */
        String dlId; java.io.File file; java.io.OutputStream out; long got, total, lastT, lastGot; double speed;
        Pending(PluginCall call, boolean binary, Lane lane) { this.call = call; this.binary = binary; this.lane = lane; }
    }

    /** The page's half of a request, called from the page (on the bridge's thread): its answer in pieces. */
    public final class Bridge {
        @JavascriptInterface public void meta(String id, long total) { Pending p = pending.get(id); if (p != null) synchronized (p) { p.total = total; } }
        @JavascriptInterface public void chunk(String id, String b64) {
            Pending p = pending.get(id);
            if (p == null || b64 == null) return;
            try {
                byte[] b = Base64.decode(b64, Base64.DEFAULT);
                synchronized (p) {
                    if (p.out != null) p.out.write(b, 0, b.length); else p.bytes.write(b, 0, b.length);
                    p.got += b.length;
                    if (p.dlId != null) {
                        long now = System.currentTimeMillis();
                        if (p.lastT == 0) { p.lastT = now; }
                        else if (now - p.lastT >= 300) {
                            p.speed = p.speed * 0.5 + 0.5 * ((p.got - p.lastGot) / ((now - p.lastT) / 1000.0)); p.lastT = now; p.lastGot = p.got;
                            JSObject ev = new JSObject(); ev.put("id", p.dlId); ev.put("got", p.got); ev.put("total", p.total); ev.put("speed", p.speed); ev.put("pct", p.total > 0 ? (int) (p.got * 100 / p.total) : 0);
                            plugin.notifyEvent("downloadProgress", ev);
                        }
                    }
                }
            } catch (Exception ignored) {}
        }
        @JavascriptInterface public void done(String id, int status, String headers, String url) {
            Pending p = pending.remove(id);
            if (p == null) return;
            try {
                byte[] bytes;
                synchronized (p) { if (p.out != null) { try { p.out.close(); } catch (Exception ignored) {} } bytes = p.bytes.toByteArray(); }
                JSObject hs = new JSObject(headers == null || headers.isEmpty() ? "{}" : headers);
                JSObject ret = new JSObject();
                ret.put("status", status);
                ret.put("headers", hs);
                if (p.file != null) {
                    // (The file as it came: a page in error — a check's page — small enough comes back as text too.)
                    if (status >= 400 && p.file.length() < 262144) { byte[] small = java.nio.file.Files.readAllBytes(p.file.toPath()); ret.put("body", new String(small, KurokawaPlugin.charsetOf(hs.optString("content-type", ""), small))); }
                    else { ret.put("bodyPath", p.file.getAbsolutePath()); ret.put("body", ""); ret.put("bodySize", p.file.length()); }
                    if (p.dlId != null) { JSObject ev = new JSObject(); ev.put("id", p.dlId); ev.put("got", p.got); ev.put("total", p.got); ev.put("speed", 0); ev.put("pct", 100); plugin.notifyEvent("downloadProgress", ev); }
                } else if (p.binary) KurokawaPlugin.putBinaryBody(ret, bytes); else ret.put("body", new String(bytes, KurokawaPlugin.charsetOf(hs.optString("content-type", ""), bytes)));
                ret.put("url", url == null ? "" : url);
                ret.put("via", "browser");
                p.call.resolve(ret);
            } catch (Exception e) { p.call.reject("Browser request failed: " + e.getMessage()); }
        }
        @JavascriptInterface public void fail(String id, String message) {
            Pending p = pending.remove(id);
            if (p != null) { synchronized (p) { if (p.out != null) { try { p.out.close(); } catch (Exception ignored) {} if (p.file != null) p.file.delete(); } } p.call.reject("Browser request failed: " + message); }
        }
    }

    /** {url, method?, headers?, body?, bodyBase64?, binary?, timeout?, page?, openTimeout?} → {status, headers,
     *  body, url, via}. A site whose check needs the reader answers as a check would (403, cf-mitigated:
     *  challenge), one that refuses even a browser with x-kr-lane: blocked; the request is refused outright only
     *  when the browser could not reach the site at all. */
    void fetch(final PluginCall call) {
        final String url = call.getString("url", "");
        final String origin = originOf(url);
        if (origin == null) { call.reject("Bad address"); return; }
        final String page = call.getString("page", origin + "/");
        final int openTimeout = call.getInt("openTimeout", 25000);
        final int timeout = call.getInt("timeout", 90000);
        final boolean binary = Boolean.TRUE.equals(call.getBoolean("binary", false));
        final JSObject o = new JSObject();
        o.put("url", url);
        o.put("method", call.getString("method", "GET"));
        o.put("headers", call.getObject("headers", new JSObject()));
        String body = call.getString("body", null);
        if (body != null) o.put("body", body);
        o.put("bodyBase64", Boolean.TRUE.equals(call.getBoolean("bodyBase64", false)));
        o.put("timeout", timeout);
        final String dlId = call.getString("downloadId", null);
        if (dlId != null) o.put("dl", dlId);
        ui.post(() -> open(origin, page, openTimeout, new Waiter() {
            @Override public void ready(Lane l) { send(l, call, o, binary, timeout, dlId); }
            @Override public void failed(String why, String title) {
                if (why.startsWith("error:")) call.reject("Browser could not open the site: " + why.substring(6));
                else call.resolve(refusal(url, "blocked".equals(why), title, binary));
            }
        }));
    }

    /** {url} → the site's view set aside (the next request opens it again, with the cookies as they are now). */
    void reset(final PluginCall call) {
        final String origin = originOf(call.getString("url", ""));
        ui.post(() -> { if (origin != null) { Lane l = lanes.get(origin); if (l != null) retire(l, "reset"); } call.resolve(); });
    }

    /** {url, all?} → {cleared}: the site's clearance (or every cookie of it) cleared, its view closed. */
    void forget(final PluginCall call) {
        final String url = call.getString("url", "");
        final String origin = originOf(url);
        final boolean all = Boolean.TRUE.equals(call.getBoolean("all", false));
        ui.post(() -> {
            if (origin != null) { Lane l = lanes.get(origin); if (l != null) retire(l, "reset"); }
            JSObject r = new JSObject();
            r.put("cleared", origin == null ? 0 : clearCookies(url, all));
            call.resolve(r);
        });
    }

    /** Every view closed (the app going away). */
    void closeAll() { ui.post(() -> { for (Lane l : new ArrayList<>(lanes.values())) close(l, "closed"); }); }

    /** What a lane answers when the site will not let it through: a check for the reader to pass, or a refusal. */
    private static JSObject refusal(String url, boolean blocked, String title, boolean binary) {
        JSObject hs = new JSObject();
        hs.put("content-type", "text/html; charset=utf-8");
        // (x-kr-lane says the browser already waited out of sight: the reader is asked at once.)
        if (blocked) hs.put("x-kr-lane", "blocked"); else { hs.put("cf-mitigated", "challenge"); hs.put("x-kr-lane", "challenge"); }
        String t = title == null || title.isEmpty() ? (blocked ? "Access denied" : "Just a moment...") : title.replace("&", "&amp;").replace("<", "&lt;");
        String html = "<html><head><title>" + t + "</title></head><body></body></html>";
        JSObject ret = new JSObject();
        ret.put("status", 403);
        ret.put("headers", hs);
        ret.put("url", url);
        ret.put("via", "browser");
        ret.put("body", binary ? Base64.encodeToString(html.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP) : html);
        return ret;
    }

    /** The site's view, ready (its page loaded, no check on it), else the reason: "challenge" (a check that did not
     *  pass by itself in time), "blocked" (a refusal), "error:…" (the page did not load). */
    private void open(final String origin, final String page, final int timeout, final Waiter w) {
        Lane had = lanes.get(origin);
        if (had != null && had.ready && had.web != null) { had.used = SystemClock.uptimeMillis(); w.ready(had); return; }
        if (had != null && had.opening) { had.waiting.add(w); return; }
        final Activity act = plugin.getActivity();
        if (act == null) { w.failed("error:the app is not on screen", ""); return; }
        final Lane lane = new Lane(origin);
        lane.opening = true;
        lane.waiting.add(w);
        lanes.put(origin, lane);
        try {
            // (Pictures load as in any browser: a check may look for them.)
            final WebView web = makeView(act, true);
            web.addJavascriptInterface(new Bridge(), "KrLane");
            web.setWebViewClient(new WebViewClient() {
                // (The page itself not loading — no network, no such site. Called for the main frame only, on every
                // Android version: the newer callback hands the main frame's errors to this one.)
                @SuppressWarnings("deprecation")
                @Override public void onReceivedError(WebView v, int code, String description, String failingUrl) {
                    settle(lane, "error:" + (description != null ? description : "the page did not load"), "");
                }
            });
            behind(act, web);
            lane.web = web;
            lane.used = SystemClock.uptimeMillis();
            web.loadUrl(page);
        } catch (Exception e) { settle(lane, "error:" + e.getMessage(), ""); return; }
        final long start = SystemClock.uptimeMillis();
        final Runnable[] poll = new Runnable[1];
        // (Asked every half second whether or not the last question was answered, and given up at the time allowed.)
        poll[0] = () -> {
            if (!lane.opening || lane.web == null) return;
            if (SystemClock.uptimeMillis() - start > timeout) { settle(lane, "challenge", lane.title); return; }
            ui.postDelayed(poll[0], 500);
            try {
                lane.web.evaluateJavascript(STATE_JS, (v) -> {
                    if (!lane.opening) return;
                    String[] st = state(v);
                    if (st != null) lane.title = st[4];
                    if (clear(st, origin)) { settle(lane, null, st[4]); return; }
                    if (st != null && "1".equals(st[3])) { settle(lane, "blocked", st[4]); return; }
                    if (movedAway(st, origin)) settle(lane, "error:the site sends its pages to " + st[1], "");
                });
            } catch (Exception e) { settle(lane, "error:" + e.getMessage(), ""); }
        };
        ui.postDelayed(poll[0], 700);
        sweep();
    }

    private void settle(Lane lane, String why, String title) {
        if (!lane.opening) return;
        lane.opening = false;
        List<Waiter> ws = new ArrayList<>(lane.waiting);
        lane.waiting.clear();
        if (why == null) {
            lane.ready = true;
            lane.used = SystemClock.uptimeMillis();
            for (Waiter x : ws) x.ready(lane);
            return;
        }
        close(lane, why);
        for (Waiter x : ws) x.failed(why, title);
    }

    private void send(final Lane l, final PluginCall call, final JSObject o, final boolean binary, final int timeout, final String dlId) {
        final String id = UUID.randomUUID().toString();
        final Pending pend = new Pending(call, binary, l);
        if (dlId != null) {
            // (A download: straight to a file in the cache, nothing held in memory, its progress told.)
            try { java.io.File dir = new java.io.File(plugin.getContext().getCacheDir(), "kr-http"); dir.mkdirs(); pend.file = new java.io.File(dir, "dl-" + dlId.replaceAll("[^A-Za-z0-9_-]", "") + ".bin"); pend.out = new java.io.BufferedOutputStream(new java.io.FileOutputStream(pend.file), 1 << 16); pend.dlId = dlId; }
            catch (Exception e) { pend.file = null; pend.out = null; }
        }
        pending.put(id, pend);
        l.used = SystemClock.uptimeMillis();
        try { l.web.evaluateJavascript("(function(id,o){" + FETCH_JS + "})(" + JSONObject.quote(id) + "," + o.toString() + ")", null); }
        catch (Exception e) { Pending gone = pending.remove(id); if (gone != null) { dropFile(gone); call.reject("Browser request failed: " + e.getMessage()); } return; }
        ui.postDelayed(() -> { Pending gone = pending.remove(id); if (gone != null) { dropFile(gone); gone.call.reject("Browser request timed out"); } }, timeout + 15000L);
    }
    /** A download's file given up: its stream closed, the part written deleted. */
    private static void dropFile(Pending q) {
        try { if (q.out != null) q.out.close(); } catch (Exception ignored) { }
        if (q.file != null) { try { q.file.delete(); } catch (Exception ignored) { } }
        q.out = null; q.file = null;
    }

    private void close(Lane l, String why) {
        if (lanes.get(l.origin) == l) lanes.remove(l.origin);
        l.ready = false;
        // (Requests waiting for it to open are told, not left waiting.)
        if (l.opening) { l.opening = false; List<Waiter> ws = new ArrayList<>(l.waiting); l.waiting.clear(); for (Waiter w : ws) w.failed("error:" + why, ""); }
        if (l.web != null) { dispose(l.web); l.web = null; }
        for (Map.Entry<String, Pending> e : pending.entrySet()) {
            if (e.getValue().lane != l) continue;
            Pending p = pending.remove(e.getKey());
            if (p != null) p.call.reject("Browser closed (" + why + ")");
        }
    }

    private boolean busy(Lane l) { for (Pending p : pending.values()) if (p.lane == l) return true; return false; }

    /** A view set aside: new requests open the site afresh (with the cookies as they are now), the requests
     *  under way in it finish first — it is closed once they have (or after a minute). */
    private void retire(final Lane l, final String why) {
        // (One still opening goes on: it is reading the site with the cookies as they are now.)
        if (l.opening) return;
        if (lanes.get(l.origin) == l) lanes.remove(l.origin);
        if (!busy(l)) { close(l, why); return; }
        final long until = SystemClock.uptimeMillis() + 60_000L;
        ui.postDelayed(new Runnable() {
            @Override public void run() {
                if (l.web == null) return;
                if (!busy(l) || SystemClock.uptimeMillis() > until) { close(l, why); return; }
                ui.postDelayed(this, 2000L);
            }
        }, 2000L);
    }

    /** Views unused for a few minutes closed, once a minute while any is open. */
    private void sweep() {
        if (sweeping) return;
        sweeping = true;
        ui.postDelayed(new Runnable() {
            @Override public void run() {
                long now = SystemClock.uptimeMillis();
                for (Lane l : new ArrayList<>(lanes.values())) if (!l.opening && now - l.used > IDLE && !busy(l)) close(l, "idle");
                if (lanes.isEmpty()) { sweeping = false; return; }
                ui.postDelayed(this, 60_000L);
            }
        }, 60_000L);
    }
}
