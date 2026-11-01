package app.kurokawa.tools;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The app's browser: a page opened in a web view of the app's own (its cookies are the ones the app's downloads
 * send, so a site's check passed here holds for them), with DNS over HTTPS when it is on (see KtDohWeb). A file
 * the page starts downloading, or a magnet tapped, goes to the app's Add sheet with the page's cookies and
 * address; «Grab» collects what the page links to and the media it loaded (videos a player fetched by script
 * included) and hands them to the app to pick from.
 */
public class KtBrowserActivity extends Activity {
    public static final String EXTRA_URL = "url";
    /** Media the page asked for (a player's video, its playlist), seen as it loads. */
    private final Map<String, String> media = new LinkedHashMap<>();
    private WebView wv; private EditText bar; private ProgressBar prog;

    private int dp(float v) { return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()); }
    private boolean dark() { return (getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES; }
    private Button btn(String label, View.OnClickListener on) {
        Button b = new Button(this, null, android.R.attr.borderlessButtonStyle); b.setText(label); b.setAllCaps(false); b.setTextSize(15); b.setMinWidth(dp(44)); b.setMinimumWidth(dp(44)); b.setPadding(dp(8), 0, dp(8), 0);
        b.setTextColor(dark() ? Color.rgb(226, 226, 230) : Color.rgb(30, 30, 34)); b.setOnClickListener(on); return b;
    }
    private static boolean ar(Activity a) { return "ar".equals(a.getResources().getConfiguration().getLocales().get(0).getLanguage()); }

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        boolean ar = ar(this);
        int bg = dark() ? Color.rgb(23, 24, 26) : Color.rgb(246, 246, 248);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(bg);
        root.setFitsSystemWindows(true);
        LinearLayout top = new LinearLayout(this); top.setOrientation(LinearLayout.HORIZONTAL); top.setGravity(Gravity.CENTER_VERTICAL); top.setPadding(dp(4), dp(4), dp(4), dp(4));
        bar = new EditText(this); bar.setSingleLine(true); bar.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI); bar.setImeOptions(EditorInfo.IME_ACTION_GO); bar.setTextSize(14);
        bar.setTextColor(dark() ? Color.WHITE : Color.BLACK); bar.setHint(ar ? "عنوان أو بحث" : "Address or search"); bar.setSelectAllOnFocus(true); bar.setTextDirection(View.TEXT_DIRECTION_LTR);
        bar.setOnEditorActionListener((v, id, ev) -> { if (id == EditorInfo.IME_ACTION_GO || (ev != null && ev.getKeyCode() == KeyEvent.KEYCODE_ENTER)) { go(bar.getText().toString()); return true; } return false; });
        top.addView(btn("✕", v -> finish()));
        top.addView(btn("‹", v -> { if (wv.canGoBack()) wv.goBack(); }));
        top.addView(bar, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        top.addView(btn("↻", v -> wv.reload()));
        Button grab = btn(ar ? "التقِط" : "Grab", v -> grab()); grab.setTypeface(Typeface.DEFAULT_BOLD); top.addView(grab);
        root.addView(top, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        prog = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal); prog.setMax(100); prog.setIndeterminate(false);
        root.addView(prog, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(3)));
        wv = new WebView(this);
        root.addView(wv, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setLoadWithOverviewMode(true); s.setUseWideViewPort(true); s.setBuiltInZoomControls(true); s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true); s.setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true);
        wv.setWebChromeClient(new WebChromeClient() { @Override public void onProgressChanged(WebView v, int p) { prog.setProgress(p); prog.setVisibility(p >= 100 ? View.INVISIBLE : View.VISIBLE); } });
        wv.setWebViewClient(new KtDohWeb() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                String u = r.getUrl().toString();
                if (u.startsWith("magnet:")) { hand(u, null, null); return true; }
                if (!u.startsWith("http:") && !u.startsWith("https:")) return true;   // (other apps' links stay out)
                return false;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                String u = r.getUrl().toString();
                String kind = mediaKind(u, r.getRequestHeaders());
                if (kind != null) synchronized (media) { if (media.size() < 400 && !media.containsKey(u)) media.put(u, kind); }
                return super.shouldInterceptRequest(v, r);
            }
            @Override public void onPageStarted(WebView v, String u, android.graphics.Bitmap icon) { if (!bar.hasFocus()) bar.setText(u); }
            @Override public void onPageFinished(WebView v, String u) { if (!bar.hasFocus()) bar.setText(u); CookieManager.getInstance().flush(); }
        });
        // A file the page downloads: to the app, with the page's cookies and address (the site expects them).
        wv.setDownloadListener((url, ua, cd, mime, len) -> hand(url, URLUtil.guessFileName(url, cd, mime), wv.getUrl()));
        String start = getIntent().getStringExtra(EXTRA_URL);
        go(start == null || start.isEmpty() ? "https://duckduckgo.com/" : start);
    }

    private void go(String text) {
        String t = text == null ? "" : text.trim(); if (t.isEmpty()) return;
        String u = t.matches("(?i)^(https?|magnet):.*") ? t : t.matches("^[\\w.-]+\\.[a-z]{2,}(/.*)?$") ? "https://" + t : "https://duckduckgo.com/?q=" + android.net.Uri.encode(t);
        if (u.startsWith("magnet:")) { hand(u, null, null); return; }
        bar.clearFocus(); try { ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(bar.getWindowToken(), 0); } catch (Exception ignored) {}
        wv.loadUrl(u);
    }

    private static final java.util.regex.Pattern FILE_EXT = java.util.regex.Pattern.compile("(?i)^https?://[^#?]*\\.(m3u8|mpd|mp4|mkv|webm|m4v|mov|mp3|m4a|flac|ogg|opus|zip|7z|rar|apk|pdf|epub)(\\?.*)?$");
    private static final java.util.regex.Pattern AUDIO_EXT = java.util.regex.Pattern.compile("(?i)^https?://[^#?]*\\.(mp3|m4a|flac|ogg|opus|aac|wav)(\\?.*)?$");
    private static final java.util.regex.Pattern MANIFEST = java.util.regex.Pattern.compile("(?i)(\\.m3u8|\\.mpd|/manifest(\\.|/|\\?|$)|[?&](mime|type|format)=(video|audio|m3u8|hls|dash)|/videoplayback\\?|/hls/[^?]*master|/playlist\\.m3u)");
    private static final java.util.regex.Pattern SEGMENT = java.util.regex.Pattern.compile("(?i)(\\.(ts|m4s|aac|vtt|webvtt|key)(\\?|$)|[/_-](seg|segment|chunk|frag|fragment|init)[-_]?\\d*\\.(m4s|mp4|m4v|m4a|ts)(\\?|$)|[?&]range=\\d)");
    /** Whether a request is a medium (and which: «video», «music», or «» for a file): a file by its extension, a
     *  player's playlist or manifest by its address, or what a <video> or <audio> element asks for — the browser
     *  asks for those in ranges («Range: bytes=…»), which images and pages never are. The pieces of a stream
     *  (segments) are left out: its playlist stands for them. */
    static String mediaKind(String u, Map<String, String> headers) {
        if (!u.startsWith("http")) return null;
        if (SEGMENT.matcher(u).find() && !MANIFEST.matcher(u).find()) return null;
        if (AUDIO_EXT.matcher(u).matches()) return "music";
        if (FILE_EXT.matcher(u).matches()) return u.matches("(?i)^[^?#]*\\.(zip|7z|rar|apk|pdf|epub)(\\?.*)?$") ? "" : "video";
        if (MANIFEST.matcher(u).find()) return "video";
        String range = null, accept = null, dest = null;
        if (headers != null) for (Map.Entry<String, String> e : headers.entrySet()) { String k = e.getKey() == null ? "" : e.getKey().toLowerCase(java.util.Locale.ROOT); if (k.equals("range")) range = e.getValue(); else if (k.equals("accept")) accept = e.getValue(); else if (k.equals("sec-fetch-dest")) dest = e.getValue(); }
        if ("video".equals(dest)) return "video"; if ("audio".equals(dest)) return "music";
        if (accept != null && accept.matches("(?i).*\\b(video|audio)/.*")) return accept.toLowerCase(java.util.Locale.ROOT).contains("video") ? "video" : "music";
        if (range != null && range.startsWith("bytes=") && !u.matches("(?i)^[^?#]*\\.(jpe?g|png|gif|webp|avif|svg|ico|css|js|json|woff2?|ttf|html?)(\\?.*)?$")) return "video";
        return null;
    }

    /** One link to the app's Add sheet (the browser closes; the page is there to come back to). */
    private void hand(String url, String name, String referer) {
        try {
            JSONObject o = new JSONObject(); o.put("kind", "download"); o.put("url", url); if (name != null) o.put("name", name); if (referer != null) o.put("referer", referer);
            o.put("ua", wv.getSettings().getUserAgentString());
            KtPlugin.browserEvent(o);
            Toast.makeText(this, ar(this) ? "أُرسل إلى التطبيق" : "Sent to the app", Toast.LENGTH_SHORT).show();
            finish();
        } catch (Exception ignored) {}
    }

    /** The page's own reading of what it offers (native/grab.js, put here by native/embed-grab.mjs). */
    static final String GRAB_JS = "(function () {\nvar o = [], s = {};\nfunction add(u, t, k) {\nif (!u || typeof u !== 'string') return;\ntry { u = new URL(u.replace(/\\\\\\//g, '/').replace(/\\\\u0026/gi, '&').replace(/&amp;/g, '&'), location.href).href; } catch (x) { return; }\nif (s[u] || !/^(https?:|magnet:)/i.test(u)) return;\ns[u] = 1; o.push({ href: u, text: (t || '').trim().slice(0, 200), kind: k || '' });\n}\nvar media = /\\.(m3u8|mpd|mp4|mkv|webm|m4v|mov)(\\?|#|$)/i, audio = /\\.(mp3|m4a|flac|ogg|opus|aac|wav)(\\?|#|$)/i;\nvar title = document.title;\ndocument.querySelectorAll('video, audio').forEach(function (v) {\nvar k = v.tagName === 'AUDIO' ? 'music' : 'video', name = v.getAttribute('title') || v.getAttribute('aria-label') || title;\nif (v.currentSrc && !/^blob:/.test(v.currentSrc)) add(v.currentSrc, name, k);\nif (v.src && !/^blob:/.test(v.src)) add(v.src, name, k);\nv.querySelectorAll('source[src]').forEach(function (x) { add(x.src, name, k); });\n});\ndocument.querySelectorAll('a[href]').forEach(function (a) { add(a.href, a.textContent || a.title || a.getAttribute('download'), media.test(a.href) ? 'video' : audio.test(a.href) ? 'music' : 'a'); });\ndocument.querySelectorAll('source[src], img[src], iframe[src], track[src], embed[src], object[data]').forEach(function (e) { add(e.currentSrc || e.src || e.data, e.alt || e.title || '', e.tagName.toLowerCase()); });\ndocument.querySelectorAll('[data-src], [data-href], [data-url], [data-file], [data-video], [data-video-src], [data-hls], [data-mp4]').forEach(function (e) {\nvar d = e.dataset, u = d.video || d.videoSrc || d.hls || d.mp4 || d.src || d.href || d.url || d.file;\nadd(u, e.textContent || e.title, d.video || d.videoSrc || d.hls || d.mp4 || media.test(u || '') ? 'video' : 'data');\n});\ndocument.querySelectorAll('meta[property^=\"og:video\"], meta[name^=\"og:video\"], meta[property=\"og:audio\"], meta[name=\"twitter:player:stream\"], meta[itemprop=\"contentUrl\"], link[rel=\"video_src\"]').forEach(function (m) {\nvar u = m.getAttribute('content') || m.getAttribute('href') || '', p = (m.getAttribute('property') || m.getAttribute('name') || '');\nif (/:(type|width|height|duration|tag|release_date)$/.test(p) || !/^(https?:)?\\/\\//i.test(u)) return;\nadd(u, title, /audio/.test(p) ? 'music' : 'video');\n});\ndocument.querySelectorAll('script[type=\"application/ld+json\"]').forEach(function (sc) {\n(sc.textContent.match(/\"(contentUrl|embedUrl)\"\\s*:\\s*\"[^\"]+\"/g) || []).forEach(function (m) { add(m.replace(/^[^:]*:\\s*\"/, '').replace(/\"$/, ''), title, 'video'); });\n});\ntry {\nvar html = document.documentElement.innerHTML;\n(html.match(/https?:(?:\\\\?\\/){2}[^\"'\\s<>()\\\\]+(?:\\\\\\/[^\"'\\s<>()\\\\]+)*?\\.(?:m3u8|mpd|mp4|webm|mkv|m4v|mov|mp3|m4a|flac)(?:\\?[^\"'\\s<>()]*)?/gi) || []).slice(0, 300).forEach(function (u) { add(u, '', audio.test(u) ? 'music' : 'video'); });\n} catch (x) {}\ntry {\nperformance.getEntriesByType('resource').forEach(function (r) {\nif (media.test(r.name) || r.initiatorType === 'video' || /\\.m3u8|\\.mpd|\\/manifest|videoplayback/i.test(r.name)) { if (!/\\.(ts|m4s)(\\?|$)/i.test(r.name)) add(r.name, '', 'video'); }\nelse if (audio.test(r.name) || r.initiatorType === 'audio') add(r.name, '', 'music');\nelse if (/\\.(zip|7z|rar|apk|pdf|epub)(\\?|$)/i.test(r.name)) add(r.name, '', 'media');\n});\n} catch (x) {}\nreturn { url: location.href, title: title, links: o.slice(0, 3000) };\n})()";
    /** What the page links to and shows (after its scripts ran), and the media it loaded: to the app to pick from. */
    private void grab() {
        String js = "JSON.stringify(" + GRAB_JS + ")";
        wv.evaluateJavascript(js, (res) -> {
            try {
                JSONObject page = new JSONObject(new JSONArray("[" + res + "]").getString(0));
                JSONArray links = page.getJSONArray("links");
                synchronized (media) { for (Map.Entry<String, String> e : media.entrySet()) { JSONObject l = new JSONObject(); l.put("href", e.getKey()); l.put("text", ""); l.put("kind", e.getValue() == null || e.getValue().isEmpty() ? "media" : e.getValue()); links.put(l); } }
                JSONObject o = new JSONObject(); o.put("kind", "links"); o.put("url", page.optString("url")); o.put("title", page.optString("title")); o.put("links", links); o.put("ua", wv.getSettings().getUserAgentString());
                KtPlugin.browserEvent(o);
                finish();
            } catch (Exception e) { Toast.makeText(this, String.valueOf(e.getMessage()), Toast.LENGTH_SHORT).show(); }
        });
    }

    @Override public void onBackPressed() { if (wv != null && wv.canGoBack()) wv.goBack(); else super.onBackPressed(); }
    @Override protected void onDestroy() { if (wv != null) { wv.stopLoading(); wv.destroy(); } super.onDestroy(); }
}
