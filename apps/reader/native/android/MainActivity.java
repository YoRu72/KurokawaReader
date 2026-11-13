package app.kurokawa.reader;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.ActionMode;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KurokawaPlugin.class);
        asView(getIntent());
        super.onCreate(savedInstanceState);
        // The page's renderer ended under the app (the system took its memory back, or it crashed): unhandled, Android
        // ends the whole app with it. The activity is made again instead — the app starts afresh and opens again the
        // book that was open, at its saved place (src/resume.ts). Android's contract for a listener that answers true:
        // that WebView is never used again — taken out of the window and destroyed first. What happened (crashed or
        // killed, the renderer's priority then) is kept for the page's own record (src/diag.ts, takeCrashInfo).
        if (getBridge() != null) getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                boolean crashed = false; int prio = -1;
                if (Build.VERSION.SDK_INT >= 26 && detail != null) {
                    try { crashed = detail.didCrash(); prio = detail.rendererPriorityAtExit(); } catch (Throwable ignored) {}
                }
                int recent = noteGone(getApplicationContext(), crashed, prio, resumed);
                if (webView != null) {
                    try { ViewGroup p = (ViewGroup) webView.getParent(); if (p != null) p.removeView(webView); } catch (Throwable ignored) {}
                    try { webView.destroy(); } catch (Throwable ignored) {}
                }
                // (Gone again and again within a few minutes: the app is closed rather than started afresh in a loop.)
                if (recent >= GONE_LIMIT) { if (!isFinishing()) finish(); return true; }
                // (In the background: made again when it comes back — not loaded again behind other apps, where the
                // system that took the memory would take it again.)
                if (resumed) remake(); else remakeOnResume = true;
                return true;
            }
        });
    }

    /* ---------- the renderer gone, memory short: kept for the page's record ---------- */
    static final String CRASH_PREFS = "kr_crash";
    private static final int GONE_LIMIT = 3;              // this many ends of the renderer…
    private static final long GONE_WINDOW_MS = 3 * 60_000L; // …within this long: the app is closed instead
    private boolean resumed = false;
    private boolean remakeOnResume = false;

    private void remake() {
        remakeOnResume = false;
        if (isFinishing() || (Build.VERSION.SDK_INT >= 17 && isDestroyed())) return;
        try { recreate(); } catch (Throwable t) { try { finish(); } catch (Throwable ignored) {} }
    }

    /** The renderer's end kept (its time, whether it crashed, its priority then, the app on screen or not), the last
     *  few only. Returns how many ends in this process fall within GONE_WINDOW_MS, this one counted. */
    /** The renderer's ends in this process (it outlives the activity made again): the loop guard's count — the record
     *  in the preferences is handed to the page and let go at each start, so it cannot count them. */
    private static final java.util.ArrayDeque<Long> GONE_TIMES = new java.util.ArrayDeque<>();

    static synchronized int noteGone(Context ctx, boolean crashed, int prio, boolean fg) {
        long now = System.currentTimeMillis();
        GONE_TIMES.addLast(now);
        while (!GONE_TIMES.isEmpty() && now - GONE_TIMES.peekFirst() > GONE_WINDOW_MS) GONE_TIMES.pollFirst();
        int recent = GONE_TIMES.size();
        try {
            SharedPreferences sp = ctx.getSharedPreferences(CRASH_PREFS, Context.MODE_PRIVATE);
            org.json.JSONArray was = new org.json.JSONArray(sp.getString("gone", "[]"));
            org.json.JSONArray all = new org.json.JSONArray();
            for (int i = Math.max(0, was.length() - 9); i < was.length(); i++) {
                org.json.JSONObject o = was.optJSONObject(i); if (o == null) continue;
                all.put(o);
            }
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("at", now); o.put("crashed", crashed); o.put("prio", prio); o.put("fg", fg);
            long trimAt = sp.getLong("trimAt", 0);
            if (trimAt > 0 && now - trimAt <= 120_000L) { o.put("trim", sp.getInt("trim", 0)); o.put("trimAgo", now - trimAt); }
            all.put(o);
            // (commit: the process may be ended a moment from now.)
            sp.edit().putString("gone", all.toString()).commit();
        } catch (Throwable ignored) {}
        return recent;
    }

    /** The system asks the app to give memory back: the level kept (with its time) for the record, and told to the page
     *  (`kr:trim`). Android 14 and later send only UI_HIDDEN (20, not kept) and BACKGROUND (40). */
    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (level == TRIM_MEMORY_UI_HIDDEN) return;
        try {
            SharedPreferences sp = getSharedPreferences(CRASH_PREFS, Context.MODE_PRIVATE);
            sp.edit().putInt("trim", level).putLong("trimAt", System.currentTimeMillis()).apply();
        } catch (Throwable ignored) {}
        if (getBridge() != null && getBridge().getWebView() != null && getBridge().getWebView().getParent() != null) {
            try { getBridge().getWebView().evaluateJavascript("document.dispatchEvent(new CustomEvent('kr:trim',{detail:" + level + "}))", null); } catch (Throwable ignored) {}
        }
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
        resumed = true;
        if (remakeOnResume) { remake(); return; }
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
        // (A WebView whose renderer is gone is out of the window, destroyed: not touched again.)
        if (w.getParent() == null) return;
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

    /**
     * The volume keys turn pages while the web side asks for it (src/readkeys.ts: a book open, the setting on, nothing
     * open over the book, nothing being read aloud) — and nothing else on the device is playing sound. Taken here,
     * before the WebView and the system see them, so the volume panel does not show; the key's release is taken with
     * its press. Each press goes to the page as the document event `kr:volume` ('up' | 'down'). Held down, the key
     * turns again at most every VOLUME_REPEAT_MS (the system repeats it every ~50 ms). Anything else, and every other
     * key, goes on as usual.
     */
    private static final long VOLUME_REPEAT_MS = 450;
    private int volumeTaken = 0;      // the key code whose press was taken (its release is taken too), or 0
    private long volumeSentAt = 0;

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event != null) {
            int code = event.getKeyCode();
            if (code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN) {
                if (volumeKey(code, event)) return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    private boolean volumeKey(int code, KeyEvent event) {
        int action = event.getAction();
        if (action == KeyEvent.ACTION_DOWN) {
            if (event.getRepeatCount() == 0) {
                volumeTaken = 0;
                if (!KurokawaPlugin.volumeKeys || soundPlaying()) return false;
                volumeTaken = code;
                volumeSentAt = event.getEventTime();
                sendVolume(code);
                return true;
            }
            if (volumeTaken != code) return false;
            if (KurokawaPlugin.volumeKeys && event.getEventTime() - volumeSentAt >= VOLUME_REPEAT_MS) {
                volumeSentAt = event.getEventTime();
                sendVolume(code);
            }
            return true;
        }
        if (action == KeyEvent.ACTION_UP) {
            if (volumeTaken != code) return false;
            volumeTaken = 0;
            return true;
        }
        return volumeTaken == code;
    }

    private void sendVolume(int code) {
        if (getBridge() == null || getBridge().getWebView() == null || getBridge().getWebView().getParent() == null) return;
        String dir = code == KeyEvent.KEYCODE_VOLUME_UP ? "up" : "down";
        getBridge().getWebView().evaluateJavascript("document.dispatchEvent(new CustomEvent('kr:volume',{detail:'" + dir + "'}))", null);
    }

    /** Sound playing on the device (this app's voice or player, or another app's music): the keys are its volume. */
    private boolean soundPlaying() {
        try {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            return am != null && am.isMusicActive();
        } catch (Exception e) {
            return false;
        }
    }

    /** In the background the keys are the system's again; the web side asks anew when the app comes back. */
    @Override
    public void onPause() {
        resumed = false;
        KurokawaPlugin.volumeKeys = false;
        volumeTaken = 0;
        super.onPause();
    }

    /** The reader draws its own selection toolbar; keep the WebView's floating menu out of the way. */
    @Override
    public void onActionModeStarted(ActionMode mode) {
        mode.getMenu().clear();
        super.onActionModeStarted(mode);
    }
}
