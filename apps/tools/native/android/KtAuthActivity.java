package app.kurokawa.tools;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** A sign-in page in a WebView of its own: finishes with the first address carrying the marker (the token
 *  AniList puts in its pin page's address). Only the address is read; the page's content is never touched. */
public class KtAuthActivity extends Activity {
    @Override protected void onDestroy() { if (KtPlugin.nextcloudActivity == this) KtPlugin.nextcloudActivity = null; super.onDestroy(); }
    public static final String EXTRA_URL = "url", EXTRA_MARKER = "marker", EXTRA_TITLE = "title", RESULT_URL = "result";
    private boolean done = false;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b); KtPlugin.nextcloudActivity = this;
        String url = getIntent().getStringExtra(EXTRA_URL), marker = getIntent().getStringExtra(EXTRA_MARKER), title = getIntent().getStringExtra(EXTRA_TITLE);
        if (title != null) setTitle(title);
        WebView wv = new WebView(this);
        wv.getSettings().setJavaScriptEnabled(true);
        wv.getSettings().setDomStorageEnabled(true);
        wv.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return check(r.getUrl().toString()); }
            @Override public void onPageStarted(WebView v, String u, android.graphics.Bitmap icon) { check(u); }
            @Override public void doUpdateVisitedHistory(WebView v, String u, boolean reload) { check(u); }
            private boolean check(String u) {
                if (done || marker == null || u == null || !u.contains(marker)) return false;
                done = true;
                Intent out = new Intent(); out.putExtra(RESULT_URL, u); setResult(RESULT_OK, out); finish();
                return true;
            }
        });
        setContentView(wv);
        if (url != null) wv.loadUrl(url);
    }
}
