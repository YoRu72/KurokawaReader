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
                if (u.matches("(?i)^https?://[^#]*\\.(m3u8|mpd|mp4|mkv|webm|m4v|mov|mp3|m4a|flac|ogg|opus|zip|7z|rar|apk|pdf|epub)(\\?.*)?$")) synchronized (media) { if (media.size() < 400) media.put(u, r.getRequestHeaders() != null ? r.getRequestHeaders().get("Referer") : null); }
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

    /** What the page links to and shows (after its scripts ran), and the media it loaded: to the app to pick from. */
    private void grab() {
        String js = "(function(){var o=[],s={};function add(u,t,k){if(!u||s[u])return;if(!/^(https?:|magnet:)/i.test(u))return;s[u]=1;o.push({href:u,text:(t||'').trim().slice(0,200),kind:k||''});}"
            + "document.querySelectorAll('a[href]').forEach(function(a){add(a.href,a.textContent||a.title||a.getAttribute('download'),'a');});"
            + "document.querySelectorAll('video[src],audio[src],source[src],img[src],iframe[src],track[src],embed[src],object[data]').forEach(function(e){add(e.currentSrc||e.src||e.data,e.alt||e.title||'',e.tagName.toLowerCase());});"
            + "document.querySelectorAll('[data-src],[data-href],[data-url],[data-file]').forEach(function(e){var u=e.dataset.src||e.dataset.href||e.dataset.url||e.dataset.file;try{add(new URL(u,location.href).href,e.textContent,'data');}catch(x){}});"
            + "try{performance.getEntriesByType('resource').forEach(function(r){if(/\\.(m3u8|mpd|mp4|mkv|webm|m4v|mov|mp3|m4a|flac|ogg|opus|zip|7z|rar|apk|pdf|epub)(\\?|$)/i.test(r.name))add(r.name,'','media');});}catch(x){}"
            + "return JSON.stringify({url:location.href,title:document.title,links:o.slice(0,3000)});})()";
        wv.evaluateJavascript(js, (res) -> {
            try {
                JSONObject page = new JSONObject(new JSONArray("[" + res + "]").getString(0));
                JSONArray links = page.getJSONArray("links");
                synchronized (media) { for (Map.Entry<String, String> e : media.entrySet()) { JSONObject l = new JSONObject(); l.put("href", e.getKey()); l.put("text", ""); l.put("kind", "media"); links.put(l); } }
                JSONObject o = new JSONObject(); o.put("kind", "links"); o.put("url", page.optString("url")); o.put("title", page.optString("title")); o.put("links", links); o.put("ua", wv.getSettings().getUserAgentString());
                KtPlugin.browserEvent(o);
                finish();
            } catch (Exception e) { Toast.makeText(this, String.valueOf(e.getMessage()), Toast.LENGTH_SHORT).show(); }
        });
    }

    @Override public void onBackPressed() { if (wv != null && wv.canGoBack()) wv.goBack(); else super.onBackPressed(); }
    @Override protected void onDestroy() { if (wv != null) { wv.stopLoading(); wv.destroy(); } super.onDestroy(); }
}
