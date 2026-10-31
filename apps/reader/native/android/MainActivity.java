package app.kurokawa.reader;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.ActionMode;
import android.view.KeyEvent;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KurokawaPlugin.class);
        asView(getIntent());
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        asView(intent);
        super.onNewIntent(intent);
        kick();
    }

    @Override
    public void onResume() {
        super.onResume();
        kick();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) kick();
    }

    /**
     * When the app is opened from another app (open with / share), the WebView can keep showing a stale
     * frame until the screen is touched. Invalidate it a few times while it settles so new content paints.
     */
    void kick() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        final android.webkit.WebView w = getBridge().getWebView();
        for (long d : new long[]{ 0, 120, 400, 1000, 2000 }) {
            w.postDelayed(() -> { w.invalidate(); w.requestLayout(); getWindow().getDecorView().invalidate(); }, d);
        }
    }

    /** "Share to KurokawaReader" arrives as SEND with a stream extra; hand it to the web side like an open-with. */
    private static void asView(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (uri == null) {
            java.util.ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null && !list.isEmpty()) uri = list.get(0);
        }
        if (uri == null) {
            // (A link or a few words shared from a browser or another app — no file: the app opens the page it
            // names, or searches its sources for the words; see native.ts.)
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            if (text == null || text.toString().trim().isEmpty()) return;
            String s = text.toString().trim();
            if (s.length() > 2000) s = s.substring(0, 2000);
            CharSequence subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT);
            String q = "kurokawareader://open?shared=" + Uri.encode(s) + (subject != null ? "&subject=" + Uri.encode(subject.toString().trim()) : "");
            intent.setAction(Intent.ACTION_VIEW);
            intent.setData(Uri.parse(q));
            return;
        }
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(uri);
    }

    /** The reader draws its own selection toolbar; keep the WebView's floating menu out of the way. */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (KurokawaPlugin.volumeKeys && (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN)) {
            if (event.getRepeatCount() == 0) {
                String dir = keyCode == KeyEvent.KEYCODE_VOLUME_UP ? "up" : "down";
                getBridge().getWebView().evaluateJavascript("document.dispatchEvent(new CustomEvent('kr:volume',{detail:'" + dir + "'}))", null);
            }
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (KurokawaPlugin.volumeKeys && (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN)) return true;
        return super.onKeyUp(keyCode, event);
    }

    @Override
    public void onActionModeStarted(ActionMode mode) {
        mode.getMenu().clear();
        super.onActionModeStarted(mode);
    }
}
