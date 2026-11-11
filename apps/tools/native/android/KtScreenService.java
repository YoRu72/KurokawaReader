package app.kurokawa.tools;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.util.DisplayMetrics;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.app.NotificationCompat;
import androidx.core.widget.TextViewCompat;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * The floating translator: a bubble over every app. A tap translates what is on the screen (or a region drawn
 * with a finger, or a fixed region kept for a game's dialogue or a video's subtitles); the translations are drawn
 * over the words they replace, on their own colours, or listed in a panel. «Auto» follows the screen: on every
 * scroll (the text read by the accessibility service) or every few seconds (a picture, read by OCR). The bubble
 * is dragged anywhere, dims when idle, sits on the screen's edge, and is closed by dropping it on the ×, from its
 * menu, from its notification, or from the quick-settings tile. What it does is set in the app (Translate on
 * screen), kept here so it starts without the app.
 */
public class KtScreenService extends Service {
    static volatile KtScreenService self;
    static final String ACT_START = "kt.screen.START", ACT_STOP = "kt.screen.STOP", ACT_CONSENT = "kt.screen.CONSENT", ACT_CONFIG = "kt.screen.CONFIG", ACT_TRANSLATE = "kt.screen.TRANSLATE";
    static final String PREFS = "kt_screen", CH = "kt_screen"; static final int NOTE = 8501;

    private WindowManager wm; private final Handler ui = new Handler(Looper.getMainLooper()); private final ExecutorService work = Executors.newSingleThreadExecutor((r) -> { Thread t = new Thread(r, "kt-screen"); t.setDaemon(true); return t; });
    private Map<String, Object> cfg; private float dp; private int sw, sh;
    private FrameLayout bubble; private TextView bubbleText; private WindowManager.LayoutParams bp; private View closeTarget;
    private FrameLayout results; private WindowManager resultsWm; private View panel, menu, picker;
    private volatile int gen = 0; private volatile boolean busy = false; private Rect lastArea = null; private boolean autoOn = false; private long autoUntil = 0;
    private Runnable pendingAfterConsent; private TextToSpeech tts; private boolean ttsReady;
    private List<KtScreenA11y.Block> shown = new ArrayList<>();

    @Override public IBinder onBind(Intent i) { return null; }
    @Override public void onCreate() {
        super.onCreate(); self = this; wm = (WindowManager) getSystemService(WINDOW_SERVICE); dp = getResources().getDisplayMetrics().density; measure(); cfg = config(this);
    }
    private void measure() { DisplayMetrics dm = new DisplayMetrics(); wm.getDefaultDisplay().getRealMetrics(dm); sw = dm.widthPixels; sh = dm.heightPixels; }
    @Override public void onConfigurationChanged(android.content.res.Configuration c) {
        super.onConfigurationChanged(c); measure(); clear(); if (bubble != null) snap();
        // (Turned: what was followed no longer fits — read again once it settles.)
        if (following) follow = new KtScreenTrack.Follow(sh); if (autoOn) { ui.removeCallbacks(settled); ui.postDelayed(settled, 700); }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String a = intent == null ? ACT_START : String.valueOf(intent.getAction());
        if (ACT_STOP.equals(a)) { stopSelf(); return START_NOT_STICKY; }
        foreground(KtScreenCapture.ready());
        if (ACT_CONSENT.equals(a)) {
            int code = intent.getIntExtra("code", 0); Intent data = intent.getParcelableExtra("data");
            if (code == android.app.Activity.RESULT_OK && data != null) { foreground(true); if (KtScreenCapture.start(this, code, data)) { Runnable p = pendingAfterConsent; pendingAfterConsent = null; if (p != null) ui.postDelayed(p, 350); } else toast(label("captureFailed", "Screen capture could not start")); }
            else { pendingAfterConsent = null; toast(label("needCapture", "Screen capture was not allowed")); }
            return START_NOT_STICKY;
        }
        if (ACT_CONFIG.equals(a)) { cfg = config(this); applyBubbleStyle(); return START_NOT_STICKY; }
        if (!Settings.canDrawOverlays(this)) { toast(label("needOverlay", "Allow Kurokawa Tools to appear on top")); stopSelf(); return START_NOT_STICKY; }
        if (bubble == null) showBubble();
        if (ACT_TRANSLATE.equals(a)) ui.postDelayed(() -> translate(null, false), 300);
        return START_STICKY;
    }
    @Override public void onDestroy() {
        self = null; autoOn = false; ui.removeCallbacksAndMessages(null); clear(); remove(menu); remove(picker); remove(closeTarget); remove(bubble); bubble = null;
        KtScreenCapture.stop(); try { if (tts != null) tts.shutdown(); } catch (Throwable ignored) {} work.shutdownNow(); aheadWork.shutdownNow();
        super.onDestroy();
    }

    /* ---------- settings (written by the app: KtPlugin.screenConfig) ---------- */
    static Map<String, Object> config(Context c) { try { return KtJson.obj(KtJson.parse(c.getSharedPreferences(PREFS, MODE_PRIVATE).getString("config", "{}"))); } catch (Throwable e) { return KtJson.map(); } }
    private Map<String, Object> sub(String k) { return KtJson.obj(cfg.get(k)); }
    private String s(Map<String, Object> m, String k, String d) { Object v = m.get(k); return v instanceof String && !((String) v).isEmpty() ? (String) v : d; }
    private double n(Map<String, Object> m, String k, double d) { Object v = m.get(k); return v instanceof Number ? ((Number) v).doubleValue() : d; }
    private boolean b(Map<String, Object> m, String k, boolean d) { Object v = m.get(k); return v instanceof Boolean ? (Boolean) v : d; }
    private String label(String k, String d) { return s(sub("labels"), k, d); }
    private int color(String hex, int d) { try { return Color.parseColor(hex); } catch (Throwable e) { return d; } }
    private int px(double v) { return Math.round((float) (v * dp)); }

    /* ---------- the notification (Android keeps the service — and the bubble — alive with it) ---------- */
    private void foreground(boolean capture) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null && nm.getNotificationChannel(CH) == null) { NotificationChannel ch = new NotificationChannel(CH, label("channel", "Floating translator"), NotificationManager.IMPORTANCE_MIN); ch.setShowBadge(false); nm.createNotificationChannel(ch); }
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, KtScreenService.class).setAction(ACT_STOP), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent go = PendingIntent.getService(this, 2, new Intent(this, KtScreenService.class).setAction(ACT_TRANSLATE), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, CH).setSmallIcon(android.R.drawable.ic_menu_view).setContentTitle(label("noteTitle", "Floating translator is on")).setContentText(label("noteText", "Tap the bubble to translate the screen"))
            .setOngoing(true).setSilent(true).setPriority(NotificationCompat.PRIORITY_MIN).setContentIntent(KtService.openApp(this))
            .addAction(0, label("translate", "Translate"), go).addAction(0, label("close", "Close"), stop).build();
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(NOTE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE | (capture ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION : 0));
            else if (Build.VERSION.SDK_INT >= 29 && capture) startForeground(NOTE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            else startForeground(NOTE, n);
        } catch (Throwable e) { try { startForeground(NOTE, n); } catch (Throwable ignored) {} }
    }

    /* ---------- windows ---------- */
    private static int overlayType() { return Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE; }
    private WindowManager.LayoutParams params(int w, int h, int flags) {
        WindowManager.LayoutParams p = new WindowManager.LayoutParams(w, h, overlayType(), flags | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS, PixelFormat.TRANSLUCENT);
        p.gravity = Gravity.TOP | Gravity.START; if (Build.VERSION.SDK_INT >= 28) p.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        return p;
    }
    private void remove(View v) { if (v == null) return; try { WindowManager m = v == results && resultsWm != null ? resultsWm : wm; m.removeView(v); } catch (Throwable ignored) {} }

    /* ---------- the bubble ---------- */
    @SuppressLint("ClickableViewAccessibility")
    private void showBubble() {
        Map<String, Object> bc = sub("bubble"); int size = px(n(bc, "size", 52));
        bubble = new FrameLayout(this); bubbleText = new TextView(this); bubbleText.setText("文A"); bubbleText.setTextColor(Color.WHITE); bubbleText.setTypeface(Typeface.DEFAULT_BOLD); bubbleText.setGravity(Gravity.CENTER); bubbleText.setTextSize(TypedValue.COMPLEX_UNIT_PX, size * 0.32f);
        bubble.addView(bubbleText, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        bubble.setContentDescription(label("bubble", "Floating translator"));
        bp = params(size, size, 0); SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE); bp.x = sp.getInt("bx", sw - size); bp.y = sp.getInt("by", sh / 3);
        applyBubbleStyle();
        final int slop = ViewConfiguration.get(this).getScaledTouchSlop();
        bubble.setOnTouchListener(new View.OnTouchListener() {
            float dx, dy, rx, ry; boolean drag, longDone; long lastTap; final Runnable longPress = () -> { longDone = true; act(s(sub("actions"), "long", "menu")); };
            final Runnable single = () -> act(s(sub("actions"), "tap", "translate"));
            @Override public boolean onTouch(View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN: wake(); rx = e.getRawX(); ry = e.getRawY(); dx = bp.x - rx; dy = bp.y - ry; drag = false; longDone = false; ui.postDelayed(longPress, ViewConfiguration.getLongPressTimeout()); return true;
                    case MotionEvent.ACTION_MOVE:
                        if (!drag && Math.hypot(e.getRawX() - rx, e.getRawY() - ry) > slop) { drag = true; ui.removeCallbacks(longPress); showCloseTarget(true); }
                        if (drag) { bp.x = (int) (e.getRawX() + dx); bp.y = (int) (e.getRawY() + dy); try { wm.updateViewLayout(bubble, bp); } catch (Throwable ignored) {} highlightClose(nearClose()); }
                        return true;
                    case MotionEvent.ACTION_UP: case MotionEvent.ACTION_CANCEL:
                        ui.removeCallbacks(longPress);
                        if (drag) { boolean close = nearClose(); showCloseTarget(false); if (close) { stopSelf(); return true; } snap(); return true; }
                        if (longDone || e.getActionMasked() == MotionEvent.ACTION_CANCEL) return true;
                        String dbl = s(sub("actions"), "double", "none");
                        if ("none".equals(dbl)) { single.run(); return true; }
                        long now = System.currentTimeMillis();
                        if (now - lastTap < ViewConfiguration.getDoubleTapTimeout()) { ui.removeCallbacks(single); lastTap = 0; act(dbl); }
                        else { lastTap = now; ui.postDelayed(single, ViewConfiguration.getDoubleTapTimeout()); }
                        return true;
                }
                return false;
            }
        });
        try { wm.addView(bubble, bp); } catch (Throwable e) { toast(label("needOverlay", "Allow Kurokawa Tools to appear on top")); stopSelf(); return; }
        snap(); wake();
    }
    private void applyBubbleStyle() {
        if (bubble == null) return; Map<String, Object> bc = sub("bubble");
        GradientDrawable g = new GradientDrawable(); g.setShape(GradientDrawable.OVAL); g.setColor(color(s(bc, "color", "#6750A4"), 0xFF6750A4)); g.setStroke(px(2), 0x66FFFFFF); bubble.setBackground(g);
        if (Build.VERSION.SDK_INT >= 21) bubble.setElevation(px(6));
        int size = px(n(bc, "size", 52)); if (bp != null && bp.width != size) { bp.width = bp.height = size; bubbleText.setTextSize(TypedValue.COMPLEX_UNIT_PX, size * 0.32f); try { wm.updateViewLayout(bubble, bp); } catch (Throwable ignored) {} }
        wake();
    }
    private final Runnable dim = () -> { if (bubble != null && !busy) bubble.setAlpha((float) n(sub("bubble"), "alpha", 0.92) * 0.4f); };
    private void wake() { if (bubble == null) return; bubble.setAlpha((float) n(sub("bubble"), "alpha", 0.92)); ui.removeCallbacks(dim); if (b(sub("bubble"), "dim", true)) ui.postDelayed(dim, (long) (n(sub("bubble"), "dimAfter", 4) * 1000)); }
    /** To the nearest side (when set), inside the screen, kept for next time. */
    private void snap() {
        if (bubble == null) return; int size = bp.width;
        if (b(sub("bubble"), "edge", true)) bp.x = bp.x + size / 2 < sw / 2 ? 0 : sw - size;
        bp.x = Math.max(0, Math.min(sw - size, bp.x)); bp.y = Math.max(px(24), Math.min(sh - size - px(24), bp.y));
        try { wm.updateViewLayout(bubble, bp); } catch (Throwable ignored) {}
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putInt("bx", bp.x).putInt("by", bp.y).apply();
    }
    private void showCloseTarget(boolean on) {
        if (!on) { remove(closeTarget); closeTarget = null; return; }
        if (closeTarget != null) return;
        TextView x = new TextView(this); x.setText("✕"); x.setTextColor(Color.WHITE); x.setGravity(Gravity.CENTER); x.setTextSize(22);
        GradientDrawable g = new GradientDrawable(); g.setShape(GradientDrawable.OVAL); g.setColor(0xCC333333); g.setStroke(px(2), 0xAAFFFFFF); x.setBackground(g);
        WindowManager.LayoutParams p = params(px(64), px(64), WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE); p.x = sw / 2 - px(32); p.y = sh - px(140);
        closeTarget = x; try { wm.addView(x, p); } catch (Throwable ignored) {}
    }
    private boolean nearClose() { if (bp == null) return false; int cx = bp.x + bp.width / 2, cy = bp.y + bp.height / 2; return Math.hypot(cx - sw / 2.0, cy - (sh - px(108))) < px(80); }
    private void highlightClose(boolean on) { if (closeTarget != null) { closeTarget.setScaleX(on ? 1.25f : 1f); closeTarget.setScaleY(on ? 1.25f : 1f); } }
    private void working(boolean on) { working(on, true); }
    /** Busy (another reading waits) — said on the bubble when `show`. */
    private void working(boolean on, boolean show) { busy = on; if (on && !show) return; ui.post(() -> { if (bubbleText != null) bubbleText.setText(on ? "…" : autoOn ? "文A●" : "文A"); if (on) wake(); }); }

    /* ---------- what a tap, a double tap or a long press does ---------- */
    private void act(String what) {
        wake();
        switch (what) {
            case "translate": if (!shown.isEmpty() && !autoOn) { clear(); return; } translate(fullOrFixed(), false); break;
            case "region": pick(false); break;
            case "fixed": { Rect f = fixed(); if (f == null) pick(true); else translate(f, false); break; }
            case "auto": toggleAuto(); break;
            case "panel": showPanel(); break;
            case "menu": showMenu(); break;
            case "clear": clear(); break;
            default: break;
        }
    }
    private Rect fullOrFixed() { return "fixed".equals(s(cfg, "mode", "full")) ? fixed() : null; }
    private Rect fixed() { Map<String, Object> f = KtJson.obj(cfg.get("fixed")); SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE); if (sp.contains("fl")) return new Rect(sp.getInt("fl", 0), sp.getInt("ft", 0), sp.getInt("fr", 0), sp.getInt("fb", 0)); return f.isEmpty() ? null : new Rect((int) n(f, "l", 0), (int) n(f, "t", 0), (int) n(f, "r", 0), (int) n(f, "b", 0)); }

    /** The bubble's menu: what it translates with and into (both changed here), then its actions as tiles —
     *  translate, a region, the fixed region, auto, how the screen is read, the list, copy, clear, the text's size,
     *  the app, close. */
    private void showMenu() {
        remove(menu); menu = null;
        LinearLayout box = new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(px(10), px(10), px(10), px(10));
        GradientDrawable g = new GradientDrawable(); g.setColor(0xF51E1F22); g.setCornerRadius(px(22)); g.setStroke(px(1), 0x33FFFFFF); box.setBackground(g); if (Build.VERSION.SDK_INT >= 21) box.setElevation(px(10));
        // The head: engine · language, each a chip that changes it.
        LinearLayout head = new LinearLayout(this); head.setGravity(Gravity.CENTER_VERTICAL);
        TextView eng = chip(engineLabel(), (v) -> { cycleEngine(); showMenu(); }); TextView from = chip(langLabel(s(cfg, "source", "auto")), (v) -> { remove(menu); menu = null; showLangs("source"); }); TextView lang = chip("→ " + langLabel(s(cfg, "target", "en")), (v) -> { remove(menu); menu = null; showLangs("target"); });
        head.addView(eng); head.addView(from); head.addView(lang); box.addView(head);
        String[][] items = { { "translate", "文A", label("translateScreen", "Translate the screen") }, { "region", "▭", label("region", "Translate a region") },
            { "fixed", "▣", fixed() == null ? label("fixedSet", "Set a fixed region") : label("fixed", "Translate the fixed region") }, { "auto", autoOn ? "■" : "▶", autoOn ? label("autoOff", "Stop auto translation") : label("autoOn", "Auto translate") },
            { "read", "\uD83D\uDC41", label("readAs", "Read as") + ": " + readLabel() }, { "panel", "☰", label("list", "Show as a list") }, { "copy", "⧉", label("copy", "Copy") }, { "clear", "⌫", label("clear", "Clear") },
            { "smaller", "A−", label("smaller", "Smaller text") }, { "bigger", "A+", label("bigger", "Bigger text") }, { "fixedSet", "✎", label("fixedChange", "Change the fixed region") }, { "app", "⚙", label("openApp", "Open the app") }, { "close", "✕", label("close", "Close") } };
        LinearLayout row = null; int n = 0;
        for (String[] it : items) {
            if (it[0].equals("fixedSet") && fixed() == null) continue;
            if ((it[0].equals("copy") || it[0].equals("panel")) && shown.isEmpty()) continue;
            if (n % 3 == 0) { row = new LinearLayout(this); box.addView(row); } n++;
            LinearLayout tile = new LinearLayout(this); tile.setOrientation(LinearLayout.VERTICAL); tile.setGravity(Gravity.CENTER); tile.setPadding(px(4), px(8), px(4), px(8));
            GradientDrawable tg = new GradientDrawable(); tg.setColor(it[0].equals("auto") && autoOn ? 0xFF4A3F8C : 0xFF2B2C31); tg.setCornerRadius(px(14)); tile.setBackground(tg);
            TextView ic = new TextView(this); ic.setText(it[1]); ic.setTextColor(0xFFE8EAED); ic.setTextSize(18); ic.setGravity(Gravity.CENTER);
            TextView lb = new TextView(this); lb.setText(it[2]); lb.setTextColor(0xFFBDC1C6); lb.setTextSize(11); lb.setGravity(Gravity.CENTER); lb.setMaxLines(2);
            tile.addView(ic); tile.addView(lb);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(px(88), px(74)); lp.setMargins(px(3), px(3), px(3), px(3)); row.addView(tile, lp);
            final String id = it[0];
            tile.setOnClickListener((v) -> {
                if (id.equals("smaller") || id.equals("bigger")) { Map<String, Object> st = sub("style"); double sz = Math.max(9, Math.min(30, n(st, "size", 15) + (id.equals("bigger") ? 1 : -1))); st.put("size", sz); cfg.put("style", st); save(); if (!shown.isEmpty()) redraw(); toast(label("textSize", "Text size") + ": " + (int) sz); return; }
                remove(menu); menu = null; switch (id) {
                case "fixedSet": pick(true); break;
                case "read": cycleRead(); break;
                case "copy": copyAll(); break;
                case "app": { Intent i = getPackageManager().getLaunchIntentForPackage(getPackageName()); if (i != null) { i.setData(android.net.Uri.parse("kurokawatools://screen")); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); startActivity(i); } break; }
                case "close": stopSelf(); break;
                default: act(id);
            } });
        }
        placeMenu(box);
    }
    private TextView chip(String text, View.OnClickListener on) {
        TextView c = new TextView(this); c.setText(text); c.setTextColor(0xFFE8EAED); c.setTextSize(13); c.setPadding(px(12), px(6), px(12), px(6)); c.setSingleLine(true);
        GradientDrawable g = new GradientDrawable(); g.setColor(0xFF3C3D43); g.setCornerRadius(px(999)); c.setBackground(g);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT); lp.setMargins(px(3), 0, px(3), px(6)); c.setLayoutParams(lp);
        c.setOnClickListener(on); return c;
    }
    private void placeMenu(View box) {
        box.measure(View.MeasureSpec.makeMeasureSpec(sw, View.MeasureSpec.AT_MOST), View.MeasureSpec.makeMeasureSpec(sh, View.MeasureSpec.AT_MOST));
        WindowManager.LayoutParams p = params(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH);
        int w = box.getMeasuredWidth(), h = box.getMeasuredHeight();
        p.x = bp.x + bp.width / 2 < sw / 2 ? bp.x + bp.width + px(8) : bp.x - w - px(8); p.x = Math.max(0, Math.min(sw - w, p.x)); p.y = Math.max(px(24), Math.min(sh - h - px(24), bp.y - h / 3));
        box.setOnTouchListener((v, e) -> { if (e.getActionMasked() == MotionEvent.ACTION_OUTSIDE) { remove(menu); menu = null; return true; } return false; });
        menu = box; try { wm.addView(box, p); } catch (Throwable ignored) {}
    }
    private String engineLabel() { String e = s(cfg, "engine", "google"); return "deepl".equals(e) ? "DeepL" : "ai".equals(e) ? label("ai", "AI") : "Google"; }
    /** Google → DeepL (with a key) → AI (when set) → Google. */
    private void cycleEngine() {
        String e = s(cfg, "engine", "google"); boolean deepl = !s(cfg, "deeplKey", "").trim().isEmpty(); Map<String, Object> ai = sub("ai"); boolean hasAi = !s(ai, "key", "").isEmpty() || (!s(ai, "base", "").isEmpty() && !s(ai, "model", "").isEmpty() && !s(ai, "base", "").contains("googleapis") && !s(ai, "base", "").contains("openai.com") && !s(ai, "base", "").contains("anthropic") && !s(ai, "base", "").contains("openrouter"));
        String next = "google".equals(e) ? (deepl ? "deepl" : hasAi ? "ai" : "google") : "deepl".equals(e) ? (hasAi ? "ai" : "google") : "google";
        if (next.equals(e)) { toast(label("onlyGoogle", "Add a DeepL key or an AI model in the app to switch")); return; }
        cfg.put("engine", next); save(); staleAll(); toast(engineLabel());   // (the cache kept: it is keyed by the translator too; what is shown asked again at the next reading)
    }
    private String langLabel(String code) { if ("auto".equals(code)) return label("detect", "Detect"); for (Object o : KtJson.arr(cfg.get("langs"))) { List<Object> l = KtJson.arr(o); if (l.size() >= 2 && code.equals(l.get(0))) return String.valueOf(l.get(1)); } return code; }
    /** The language to translate from (`which` = source, «Detect» first) or into (target), chosen from a list by the bubble. */
    private void showLangs(final String which) {
        ScrollView sv = new ScrollView(this); LinearLayout list = new LinearLayout(this); list.setOrientation(LinearLayout.VERTICAL); list.setPadding(px(8), px(8), px(8), px(8)); sv.addView(list);
        GradientDrawable g = new GradientDrawable(); g.setColor(0xF51E1F22); g.setCornerRadius(px(20)); sv.setBackground(g);
        String cur = s(cfg, which, "source".equals(which) ? "auto" : "en");
        List<Object> all = new ArrayList<>(); if ("source".equals(which)) all.add(java.util.Arrays.asList((Object) "auto", label("detect", "Detect"))); all.addAll(KtJson.arr(cfg.get("langs")));
        for (Object o : all) { List<Object> l = KtJson.arr(o); if (l.size() < 2) continue; final String code = String.valueOf(l.get(0));
            TextView t = new TextView(this); t.setText((code.equals(cur) ? "✓  " : "    ") + l.get(1)); t.setTextColor(code.equals(cur) ? 0xFF8AB4F8 : Color.WHITE); t.setTextSize(15); t.setPadding(px(14), px(9), px(14), px(9)); t.setMinWidth(px(200));
            t.setOnClickListener((v) -> { remove(menu); menu = null; cfg.put(which, code); save(); toast(("source".equals(which) ? "" : "→ ") + langLabel(code)); if (!shown.isEmpty()) { staleAll(); translate(lastArea, true); } });
            list.addView(t); }
        sv.setLayoutParams(new ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Math.min((int) (sh * 0.6), px(44) * Math.max(1, list.getChildCount()) + px(16))));
        FrameLayout wrap = new FrameLayout(this); wrap.addView(sv, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Math.min((int) (sh * 0.6), px(44) * Math.max(1, list.getChildCount()) + px(16))));
        placeMenu(wrap);
    }
    private String readLabel() { String r = s(cfg, "read", "auto"); return "text".equals(r) ? label("readText", "Text") : "picture".equals(r) ? label("readPicture", "Picture (OCR)") : label("readAuto", "Text, else picture"); }
    private void cycleRead() { String r = s(cfg, "read", "auto"); String next = "auto".equals(r) ? "text" : "text".equals(r) ? "picture" : "auto"; cfg.put("read", next); save(); toast(label("readAs", "Read as") + ": " + readLabel()); }
    private void save() { getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("config", KtJson.write(cfg)).apply(); }

    /* ---------- a region drawn with a finger ---------- */
    @SuppressLint("ClickableViewAccessibility")
    private void pick(boolean asFixed) {
        clear(); remove(picker);
        final Rect r = new Rect(); final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG); stroke.setStyle(Paint.Style.STROKE); stroke.setStrokeWidth(px(2.5)); stroke.setColor(0xFF8AB4F8);
        final Paint shade = new Paint(); shade.setColor(0x66000000); final Paint hint = new Paint(Paint.ANTI_ALIAS_FLAG); hint.setColor(Color.WHITE); hint.setTextSize(px(16)); hint.setTextAlign(Paint.Align.CENTER);
        final String say = asFixed ? label("drawFixed", "Draw the region to keep (a game's dialogue, subtitles)") : label("drawRegion", "Draw around the text to translate");
        View v = new View(this) { @Override protected void onDraw(Canvas c) { c.drawRect(0, 0, getWidth(), getHeight(), shade); if (!r.isEmpty()) { c.drawRect(r, stroke); } else c.drawText(say, getWidth() / 2f, getHeight() / 2f, hint); } };
        final float[] start = new float[2];
        v.setOnTouchListener((view, e) -> {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN: start[0] = e.getRawX(); start[1] = e.getRawY(); r.setEmpty(); return true;
                case MotionEvent.ACTION_MOVE: r.set((int) Math.min(start[0], e.getRawX()), (int) Math.min(start[1], e.getRawY()), (int) Math.max(start[0], e.getRawX()), (int) Math.max(start[1], e.getRawY())); int[] off = new int[2]; view.getLocationOnScreen(off); r.offset(-off[0], -off[1]); view.invalidate(); return true;
                case MotionEvent.ACTION_UP: {
                    int[] loc = new int[2]; view.getLocationOnScreen(loc); Rect area = new Rect(r); area.offset(loc[0], loc[1]);
                    remove(picker); picker = null;
                    if (area.width() < px(24) || area.height() < px(12)) return true;
                    if (asFixed) { getSharedPreferences(PREFS, MODE_PRIVATE).edit().putInt("fl", area.left).putInt("ft", area.top).putInt("fr", area.right).putInt("fb", area.bottom).apply(); }
                    ui.postDelayed(() -> translate(area, false), 120); return true;
                }
            }
            return false;
        });
        WindowManager.LayoutParams p = params(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, 0);
        picker = v; try { wm.addView(v, p); } catch (Throwable ignored) {}
    }

    /* ---------- auto ---------- */
    private void toggleAuto() {
        autoOn = !autoOn; ui.removeCallbacks(tick); ui.removeCallbacks(settled); readAgain = false; working(false); KtScreenCapture.watcher = null; following = false;
        if (!autoOn) { toast(label("autoStopped", "Auto translation stopped")); return; }
        double mins = n(cfg, "autoStop", 30); autoUntil = mins > 0 ? System.currentTimeMillis() + (long) (mins * 60000) : Long.MAX_VALUE;
        toast(label("autoStarted", "Auto translation on"));
        lastArea = fullOrFixed();
        translate(lastArea, true);
        if ("interval".equals(s(cfg, "auto", "scroll")) || lastArea != null) ui.postDelayed(tick, (long) (n(cfg, "interval", 3) * 1000));
    }
    private final Runnable tick = new Runnable() { @Override public void run() {
        if (!autoOn) return; if (System.currentTimeMillis() > autoUntil) { stopAuto(); return; }
        if (!busy) translate(lastArea, true);
        ui.postDelayed(this, (long) (Math.max(1, n(cfg, "interval", 3)) * 1000));
    } };
    private void stopAuto() { autoOn = false; following = false; readAgain = false; KtScreenCapture.watcher = null; ui.removeCallbacks(tick); ui.removeCallbacks(settled); working(false); }
    /** Read again once the screen is still; when a reading is under way, right after it (a scroll during a reading is not left unread). */
    private final Runnable settled = () -> { if (!autoOn) return; if (busy) { readAgain = true; return; } translate(lastArea, true); };
    private boolean lookAhead() { return b(cfg, "lookAhead", true); }
    /** The screen scrolled or changed (the accessibility service says): the translations moved with it at once when it
     *  says by how much (`d`: dx, dy; only those inside `area`, the list that scrolled — not the bar above it), else
     *  hidden until read again; while it scrolls, what is known already (translated ahead, or met before) drawn as it
     *  comes in; read again once the screen is still (auto), sooner while it changes, later while readings find nothing new. */
    void screenMoved(boolean scrolled, int[] d, int[] area) {
        ui.post(() -> {
            if (following) return;   // (the picture itself is followed instead)
            long now = System.currentTimeMillis();
            if (scrolled) { pace.moved(now); if (d != null && d[1] != 0) dir = d[1] > 0 ? 1 : -1; }
            if (scrolled && results != null && panel == null) { if (d != null) { synchronized (track) { track.moved(-d[0], -d[1], area); } placeAll(null); } else hideResults(); }
            if (!autoOn || "interval".equals(s(cfg, "auto", "scroll"))) return;
            if (now > autoUntil) { stopAuto(); return; }
            if (scrolled && !busy && KtScreenA11y.self != null && now - peekAt > 300 && !"panel".equals(s(cfg, "display", "overlay"))) { peekAt = now; translate(lastArea, true, true, null); }
            long settle = (long) (Math.min(n(cfg, "settle", 0.7), 0.4) * 1000);
            ui.removeCallbacks(settled); ui.postDelayed(settled, scrolled ? settle : Math.max(settle, pace.gap));
        });
    }
    void captureStopped() { ui.post(() -> { if (autoOn && following) stopAuto(); }); }

    /* ---------- following a page in the picture (auto, read as a picture) ----------
       Each frame is compared with a key frame (KtScreenTrack.Follow — a slow scroll adds up instead of being lost), and
       the boxes moved with the page at once; those scrolled out are kept for when it comes back. While it scrolls
       slowly (reading, not flinging) the rows it brings in are read first, the boxes left showing; once it stands
       still what it brought in is read (all of it, boxes hidden, now and then or when the page was lost). */
    private volatile boolean following = false; private volatile long movedAt = 0; private volatile boolean needRead = false, lost = false; private volatile int unread = 0; private volatile long fullAt = 0;
    private volatile int[][] masks = new int[0][]; private int[][] lastMasks = new int[0][];
    private final KtScreenTrack track = new KtScreenTrack(); private final KtScreenTrack.Pace pace = new KtScreenTrack.Pace(400, 3200); private volatile KtScreenTrack.Follow follow;
    private volatile boolean readAgain = false; private long peekAt = 0; private volatile int dir = 1;
    private void startFollowing() {
        if (following) return; following = true; follow = new KtScreenTrack.Follow(sh); needRead = false; lost = false; unread = 0;
        KtScreenCapture.watcher = new KtScreenCapture.Watcher() {
            @Override public int[][] masks() { return masks; }
            @Override public void frame(short[][] sig, long at) {
                KtScreenTrack.Follow f = follow; if (f == null) return;
                if (!following || reading) { f.reset(); return; }
                KtScreenCapture.gapMs = pace.frameGap(at);
                int d = f.feed(sig);
                // (Not the same page twice running: the boxes hidden, not thrown away — a reading pairs them again by their words.)
                if (d == KtScreenMotion.NONE) { if (f.fails == 2) { movedAt = at; needRead = true; lost = true; unread = 0; ui.post(KtScreenService.this::hideResults); } return; }
                if (d != 0) {
                    movedAt = at; needRead = true; unread += d; pace.moved(at);
                    ui.post(() -> { synchronized (track) { track.moved(0, -d, null); } placeAll(null); });
                    if (Math.abs(d) <= px(24) && Math.abs(unread) >= sh / 4 && !busy && autoOn && !lost) { final int[] st = KtScreenTrack.strip(unread, sw, sh, px(48)); unread = 0; ui.post(() -> { if (autoOn && !busy) translate(null, true, false, rect(st)); }); }
                    return;
                }
                if (needRead && at - movedAt > (long) (Math.max(0.25, n(cfg, "settle", 0.7)) * 1000) && !busy && autoOn) {
                    needRead = false; boolean full = lost || at - fullAt > 15000; final int[] st = full ? null : KtScreenTrack.strip(unread, sw, sh, px(48)); unread = 0;
                    if (full || st != null) ui.post(() -> { if (autoOn && !busy) translate(null, true, false, st == null ? null : rect(st)); });
                }
            }
        };
    }
    private volatile boolean reading = false;
    private static Rect rect(int[] a) { return a == null ? null : new Rect(a[0], a[1], a[2], a[3]); }
    private static int[] box(Rect r) { return r == null ? null : new int[] { r.left, r.top, r.right, r.bottom }; }

    /* ---------- reading and translating ---------- */
    private void translate(Rect area, boolean quiet) { translate(area, quiet, false, null); }
    /** The screen (or `area`) read, what is read paired with what is shown (KtScreenTrack: a line read again keeps its
     *  box and its translation), what is new or changed translated — first from what is known, then asked — and drawn.
     *  `cacheOnly`: nothing asked of the translator, no picture taken (a scroll under way); `strip`: a picture of that
     *  strip read with the boxes left showing (what a slow scroll brought in). */
    private void translate(Rect area, boolean quiet, boolean cacheOnly, Rect strip) {
        final int my = ++gen; if (!cacheOnly && strip == null) lastArea = area; working(true, !cacheOnly && strip == null);
        work.execute(() -> {
            try {
                List<KtScreenA11y.Block> blocks = new ArrayList<>(); String read = s(cfg, "read", "auto"); boolean picture = false, fresh = false; int[] mark;
                List<KtScreenTrack.Cand> cands = lookAhead() && autoOn && !cacheOnly && area == null ? new ArrayList<>() : null;
                if ("text".equals(read) && !KtScreenA11y.declared(this)) read = "auto"; // (a build without the service: a picture then)
                synchronized (track) { mark = new int[] { track.movedX, track.movedY }; }
                if (strip == null && !"picture".equals(read) && KtScreenA11y.self != null) blocks = KtScreenA11y.read(area, cands);
                if ((blocks.isEmpty() || strip != null) && !"text".equals(read)) {
                    if (cacheOnly) return;
                    if (!KtScreenCapture.ready()) {
                        if ("text".equals(read)) { if (!quiet) toast(label("needA11y", "Turn on the accessibility service")); return; }
                        pendingAfterConsent = () -> translate(area, quiet);
                        ui.post(() -> { try { startActivity(new Intent(this, KtScreenCapture.Consent.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION)); } catch (Throwable ignored) {} });
                        return;
                    }
                    // (Read as a picture with the text tree there too: the tree only to translate ahead, the picture says where.)
                    if (cands != null && cands.isEmpty() && strip == null && KtScreenA11y.self != null) KtScreenA11y.read(null, cands);
                    Bitmap shot;
                    if (strip == null) { reading = true; long since = hideAll(true); shot = KtScreenCapture.grab(since); hideAll(false); reading = false; }
                    else shot = KtScreenCapture.grab(System.currentTimeMillis() - 1);
                    synchronized (track) { mark = new int[] { track.movedX, track.movedY }; }
                    if (shot == null) { if (!quiet) toast(label("captureFailed", "The screen could not be read")); return; }
                    blocks = KtScreenOcr.read(shot, strip != null ? strip : area, s(cfg, "source", "auto")); shot.recycle(); picture = true;
                    if (strip == null) fullAt = System.currentTimeMillis(); else blocks = outsideOurBoxes(blocks);
                    if (strip == null && lost) { lost = false; fresh = true; }
                } else if (blocks.isEmpty() && KtScreenA11y.self == null && !quiet) { toast(label("needA11y", "Turn on the accessibility service")); return; }
                if (my != gen) return;
                if (blocks.isEmpty() && !(autoOn && picture)) { if (!quiet) toast(label("noText", "No text found here")); if (!cacheOnly) ui.post(this::clear); return; }
                KtTranslate.Config tc = KtTranslate.Config.from(cfg);
                KtLetterFace.kinds(blocks, KtLettering.glossary(cfg));
                if ("panel".equals(s(cfg, "display", "overlay"))) {
                    if (cacheOnly) return;
                    List<String> texts = new ArrayList<>(); for (KtScreenA11y.Block k : blocks) texts.add(k.text);
                    List<String> tr = KtTranslate.translate(texts, tc); for (int k = 0; k < blocks.size(); k++) blocks.get(k).tr = tr.get(k);
                    final List<KtScreenA11y.Block> done = blocks; ui.post(() -> { if (my != gen) return; shown = done; showPanel(); remember(done); speak(done); }); return;
                }
                // Paired with what is shown; what is known drawn at once.
                final KtScreenTrack.Update u; final List<KtScreenTrack.Item> need = new ArrayList<>(); final boolean pic = picture, isStrip = strip != null;
                synchronized (track) {
                    if (fresh) track.items.removeIf((i) -> !track.onScreen(i));   // (another page: what was kept out of view no longer belongs)
                    track.viewport(sw, sh); track.keepMisses = picture ? 1 : 0; track.keepOff = picture && autoOn && area == null;
                    int ox = track.movedX - mark[0], oy = track.movedY - mark[1];   // (the page moved since the picture was taken)
                    List<KtScreenTrack.Obs> obs = new ArrayList<>(); for (KtScreenA11y.Block k : blocks) obs.add(new KtScreenTrack.Obs(k.text, k.r.left + ox, k.r.top + oy, k.r.width(), k.r.height(), k));
                    u = track.update(obs, box(strip != null ? strip : area), isStrip ? (i) -> i.tr != null : null);
                    for (KtScreenTrack.Item i : track.items) {
                        if (!track.onScreen(i) || (i.tr != null && i.text.equals(i.trOf))) continue;
                        String hit = KtTranslate.peek(i.text, tc); if (hit != null) { i.tr = hit; i.trOf = i.text; } else need.add(i);
                    }
                }
                pace.afterRead(u.changed() || !need.isEmpty());
                ui.post(() -> { if (my != gen) return; render(u.glide, u.resized); if (autoOn && pic && area == null) startFollowing(); });
                if (cands != null && !cands.isEmpty()) translateAhead(cands, tc, my);
                if (cacheOnly || need.isEmpty()) return;
                // What is new or changed, asked of the translator (each text once).
                List<String> texts = new ArrayList<>(); for (KtScreenTrack.Item i : need) if (!texts.contains(i.text)) texts.add(i.text);
                List<String> tr = KtTranslate.translate(texts, tc);
                final List<KtScreenA11y.Block> done = new ArrayList<>();
                synchronized (track) { for (KtScreenTrack.Item i : need) { int k = texts.indexOf(i.text); if (k < 0) continue; i.tr = tr.get(k); i.trOf = i.text; if (i.data instanceof KtScreenA11y.Block) { KtScreenA11y.Block b = (KtScreenA11y.Block) i.data; b.tr = i.tr; done.add(b); } } }
                if (my != gen) return;
                ui.post(() -> { if (my != gen) return; render(null, null); remember(done); speak(done); });
            } catch (Throwable e) {
                reading = false;
                String m = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                if (!quiet) toast(m.contains("deeplKey") ? label("needDeepl", "Add your DeepL key in the app") : label("failed", "Translation failed") + ": " + m);
            } finally { if (my == gen) { working(false); ui.post(() -> { if (readAgain && autoOn && !busy) { readAgain = false; ui.postDelayed(settled, 150); } }); } }
        });
    }
    /** What a picture read with the boxes showing found under them is our own translation: left out. */
    private List<KtScreenA11y.Block> outsideOurBoxes(List<KtScreenA11y.Block> blocks) {
        int[][] m = masks; List<KtScreenA11y.Block> out = new ArrayList<>();
        for (KtScreenA11y.Block k : blocks) { long a = (long) Math.max(1, k.r.width()) * Math.max(1, k.r.height()), over = 0; for (int[] b : m) { int w = Math.min(k.r.right, b[2]) - Math.max(k.r.left, b[0]), h = Math.min(k.r.bottom, b[3]) - Math.max(k.r.top, b[1]); if (w > 0 && h > 0) over += (long) w * h; } if (over * 10 < a * 3) out.add(k); }
        return out;
    }
    /** Translating ahead (auto, when set): the text the app keeps out of view, below first (the way it scrolls), a
     *  little above — translated into the cache after what is on the screen, in batches, within a budget (little for
     *  a paid key), stopped when a reading of the screen begins; when it scrolls into view it is drawn at once. */
    private final ExecutorService aheadWork = Executors.newSingleThreadExecutor((r) -> { Thread t = new Thread(r, "kt-screen-ahead"); t.setDaemon(true); t.setPriority(Thread.MIN_PRIORITY); return t; });
    private final java.util.concurrent.atomic.AtomicBoolean aheadQueued = new java.util.concurrent.atomic.AtomicBoolean(false);
    private KtScreenTrack.Budget budget; private String budgetFor = "";
    private void translateAhead(List<KtScreenTrack.Cand> cands, KtTranslate.Config tc, int my) {
        if (!aheadQueued.compareAndSet(false, true)) return;
        aheadWork.execute(() -> {
            try {
                if (budget == null || !budgetFor.equals(tc.engine)) { budget = KtScreenTrack.Budget.of(tc.engine); budgetFor = tc.engine; }
                boolean paid = "deepl".equals(tc.engine) || "ai".equals(tc.engine);
                List<String> todo = KtScreenTrack.ahead(cands, sh, dir, paid ? 30 : 80, paid ? 1500 : 6000, 2, (t) -> KtTranslate.peek(t, tc) != null);
                for (int k = 0; k < todo.size(); k += 20) {
                    if (my != gen || !autoOn) return;
                    List<String> batch = new ArrayList<>(todo.subList(k, Math.min(todo.size(), k + 20))); int chars = 0; for (String t : batch) chars += t.length();
                    if (!budget.take(chars, System.currentTimeMillis())) return;
                    try { KtTranslate.translate(batch, tc); } catch (Throwable e) { budget.refused(System.currentTimeMillis()); return; }
                }
            } catch (Throwable ignored) {} finally { aheadQueued.set(false); }
        });
    }
    /** After the language or the translator changed: every translation shown asked again (from the cache when known). */
    private void staleAll() { synchronized (track) { for (KtScreenTrack.Item i : track.items) i.trOf = null; } }
    /** The translator's own views hidden (true) for a picture of the screen, or shown again; when hidden. */
    private long hideAll(boolean hide) {
        CountDownLatch l = new CountDownLatch(1);
        ui.post(() -> { int v = hide ? View.INVISIBLE : View.VISIBLE; for (View x : new View[] { bubble, results, panel }) if (x != null) x.setVisibility(v); l.countDown(); });
        try { l.await(1, TimeUnit.SECONDS); if (hide) Thread.sleep(70); } catch (InterruptedException ignored) {}
        return System.currentTimeMillis();
    }

    /* ---------- drawing the translations over the words ---------- */
    /** Every translation drawn again (its text's size changed). */
    private void redraw() { if (results != null) results.removeAllViews(); synchronized (track) { for (KtScreenTrack.Item i : track.items) i.view = null; } render(null, null); }
    @SuppressLint("ClickableViewAccessibility")
    private boolean ensureResults() {
        if (results != null) return true;
        boolean tapClose = b(cfg, "tapClose", true) && !autoOn;
        results = new FrameLayout(this);
        // (Over the other app, the translations let touches through — scrolling goes on. The accessibility
        // service's own layer is trusted by Android to do that at full opacity; an ordinary overlay is kept at
        // Android 12's 80% for it.)
        KtScreenA11y a = KtScreenA11y.self; boolean trusted = a != null && Build.VERSION.SDK_INT >= 22;
        resultsWm = trusted ? (WindowManager) a.getSystemService(Context.WINDOW_SERVICE) : wm;
        WindowManager.LayoutParams p = params(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, tapClose ? 0 : WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE);
        if (trusted) p.type = WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY; else if (!tapClose && Build.VERSION.SDK_INT >= 31) p.alpha = 0.8f;
        results.setOnTouchListener((v, e) -> { if (e.getActionMasked() == MotionEvent.ACTION_DOWN) { clear(); return true; } return false; });
        try { resultsWm.addView(results, p); } catch (Throwable e) { try { resultsWm = wm; p.type = overlayType(); if (!tapClose && Build.VERSION.SDK_INT >= 31) p.alpha = 0.8f; wm.addView(results, p); } catch (Throwable e2) { results = null; return false; } }
        return true;
    }
    /** The boxes brought in line with what is followed: those gone removed, those new (or whose translation or size
     *  changed) made — no other box is touched, so nothing flickers —, then every box put where its words are now
     *  (`glide`: corrected by a few pixels, glided there rather than jumping). */
    private void render(List<KtScreenTrack.Item> glide, List<KtScreenTrack.Item> rebuild) {
        if (!ensureResults()) return;
        List<KtScreenTrack.Item> items; synchronized (track) { items = new ArrayList<>(track.items); }
        java.util.Set<KtScreenTrack.Item> live = new java.util.HashSet<>(items);
        for (int c = results.getChildCount() - 1; c >= 0; c--) { View v = results.getChildAt(c); Object tg = v.getTag(); if (!(tg instanceof KtScreenTrack.Item) || !live.contains(tg)) { v.animate().cancel(); results.removeViewAt(c); if (tg instanceof KtScreenTrack.Item && ((KtScreenTrack.Item) tg).view == v) ((KtScreenTrack.Item) tg).view = null; } }
        Map<String, Object> st = sub("style"); List<KtScreenA11y.Block> list = new ArrayList<>();
        for (KtScreenTrack.Item i : items) {
            String tr = i.tr; if (tr == null || tr.isEmpty() || !(i.data instanceof KtScreenA11y.Block)) continue;
            KtScreenA11y.Block k = (KtScreenA11y.Block) i.data; k.tr = tr; list.add(k);
            View old = i.view instanceof View ? (View) i.view : null;
            if (old != null && old.getParent() == results && old instanceof TextView && tr.contentEquals(((TextView) old).getText()) && (rebuild == null || !rebuild.contains(i))) continue;
            if (old != null && old.getParent() == results) results.removeView(old);
            TextView t = makeView(i, k, tr, st); results.addView(t, new FrameLayout.LayoutParams(t.getLayoutParams().width, t.getLayoutParams().height)); i.view = t;
        }
        java.util.Collections.sort(list, (p, q) -> p.r.top != q.r.top ? Integer.compare(p.r.top, q.r.top) : Integer.compare(p.r.left, q.r.left));
        shown = list; placeAll(glide == null ? null : new java.util.HashSet<>(glide));
        double hideAfter = n(cfg, "hideAfter", 0); ui.removeCallbacks(hideRun); if (hideAfter > 0 && !autoOn) ui.postDelayed(hideRun, (long) (hideAfter * 1000));
    }
    /** One translation's box, on its own colours (or the picture behind its words with the words taken off). */
    private TextView makeView(KtScreenTrack.Item i, KtScreenA11y.Block k, String tr, Map<String, Object> st) {
        float size = (float) n(st, "size", 15); boolean smart = b(st, "smart", true); int bg = color(s(st, "bg", "#1E1E1E"), 0xFF1E1E1E), fg = color(s(st, "fg", "#FFFFFF"), Color.WHITE); int alpha = (int) Math.round(255 * n(st, "bgAlpha", 0.88));
        float radius = px(n(st, "radius", 6)); boolean center = b(st, "center", false), outline = b(st, "outline", false), bold = b(st, "bold", false); float sd = getResources().getDisplayMetrics().scaledDensity;
        TextView t = new TextView(this); t.setText(tr);
        int fgc = smart && k.bg != 0 ? k.fg : fg; int bgc = smart && k.bg != 0 ? k.bg : bg;
        // (Lettered in the font set for its kind — a balloon's words, a thought, a box, a sound effect —, balloons centred.)
        Typeface face = KtLetterFace.face(cfg, k.kind); t.setTextColor(fgc); if (face != null) t.setTypeface(face, bold ? Typeface.BOLD : Typeface.NORMAL); else if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        if (outline) t.setShadowLayer(px(2), 0, 0, (fgc & 0xFFFFFF) > 0x888888 ? Color.BLACK : Color.WHITE);
        GradientDrawable g = new GradientDrawable(); g.setColor((alpha << 24) | (bgc & 0xFFFFFF)); g.setCornerRadius(radius);
        // (The picture behind with the words taken off, when there is one: the translation lettered on it.)
        if (!"none".equals(s(st, "bgMode", "erase"))) { if (smart && k.patch != null && "erase".equals(s(st, "bgMode", "erase"))) { try { Bitmap pb = Bitmap.createBitmap(k.patch, k.pw, k.ph, Bitmap.Config.ARGB_8888); Bitmap in = Bitmap.createBitmap(pb, k.pad, k.pad, Math.max(1, Math.min(k.pw - 2 * k.pad, i.w)), Math.max(1, Math.min(k.ph - 2 * k.pad, i.h))); t.setBackground(new android.graphics.drawable.BitmapDrawable(getResources(), in)); } catch (Throwable e) { t.setBackground(g); } } else t.setBackground(g); }
        t.setGravity((center || (k.kind != null && !"box".equals(k.kind) && !"sign".equals(k.kind) && b(sub("letter"), "kinds", true)) ? Gravity.CENTER_HORIZONTAL : Gravity.START) | Gravity.CENTER_VERTICAL); t.setPadding(px(2), 0, px(2), 0); t.setIncludeFontPadding(false);
        boolean er = k.patch != null && smart && "erase".equals(s(st, "bgMode", "erase")); int w = er ? i.w : Math.max(i.w, px(36)), h = er ? i.h : Math.max(i.h, px(14));
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, size);
        // (As big as the words' box allows — up to twice the size set —, never under 8.)
        TextViewCompat.setAutoSizeTextTypeUniformWithConfiguration(t, 8, (int) Math.max(9, Math.min(size * 2, h / sd)), 1, TypedValue.COMPLEX_UNIT_SP);
        t.setLayoutParams(new FrameLayout.LayoutParams(w, h)); t.setTag(i); return t;
    }
    /** Every translation put where its words are now; those off the screen or under the keyboard not shown. The boxes
     *  (where they are now and where they were a frame ago) left out of the frames the page's movement is found from. */
    private void placeAll(java.util.Set<KtScreenTrack.Item> glide) {
        if (results == null) return; results.setVisibility(View.VISIBLE);
        int[] at = new int[2]; results.getLocationOnScreen(at); List<int[]> m = new ArrayList<>(); Rect[] cov = KtScreenA11y.covered;
        synchronized (track) {
            for (int c = 0; c < results.getChildCount(); c++) {
                View v = results.getChildAt(c); Object tg = v.getTag(); if (!(tg instanceof KtScreenTrack.Item)) continue; KtScreenTrack.Item i = (KtScreenTrack.Item) tg;
                int w = v.getLayoutParams().width, h = v.getLayoutParams().height, x = i.x, y = i.y;
                boolean in = y + h > 0 && y < sh && x + w > 0 && x < sw; if (in) for (Rect r : cov) if (r.intersects(x, y, x + w, y + h)) { in = false; break; }
                v.setVisibility(in ? View.VISIBLE : View.GONE);
                float tx = x - at[0], ty = y - at[1];
                if (in && glide != null && glide.contains(i) && Math.abs(v.getX() - tx) + Math.abs(v.getY() - ty) <= 2 * KtScreenTrack.GLIDE) v.animate().x(tx).y(ty).setDuration(140).start();
                else { v.animate().cancel(); v.setX(tx); v.setY(ty); }
                if (in) m.add(new int[] { x - px(2), y - px(2), x + w + px(2), y + h + px(2) });
            }
        }
        int[][] now = m.toArray(new int[0][]), was = lastMasks; int[][] both = new int[now.length + was.length][];
        System.arraycopy(now, 0, both, 0, now.length); System.arraycopy(was, 0, both, now.length, was.length); lastMasks = now; masks = both;
    }
    private final Runnable hideRun = this::clear;
    private void hideResults() { if (results != null) results.setVisibility(View.INVISIBLE); masks = new int[0][]; lastMasks = new int[0][]; }
    void clear() { remove(results); results = null; remove(panel); panel = null; shown = new ArrayList<>(); synchronized (track) { track.clear(); } masks = new int[0][]; lastMasks = new int[0][]; }
    /* ---------- the translations as a list ---------- */
    private void showPanel() {
        if (shown.isEmpty()) return; List<KtScreenA11y.Block> keep = shown; remove(results); results = null; remove(panel); shown = keep;
        LinearLayout card = new LinearLayout(this); card.setOrientation(LinearLayout.VERTICAL); card.setPadding(px(12), px(8), px(12), px(8));
        GradientDrawable g = new GradientDrawable(); g.setColor(0xF5202124); g.setCornerRadius(px(18)); card.setBackground(g);
        LinearLayout head = new LinearLayout(this); head.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = new TextView(this); title.setText(label("translations", "Translations")); title.setTextColor(0xFFE8EAED); title.setTextSize(15); title.setTypeface(Typeface.DEFAULT_BOLD);
        head.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        TextView copy = new TextView(this); copy.setText(label("copy", "Copy")); copy.setTextColor(0xFF8AB4F8); copy.setPadding(px(10), px(8), px(10), px(8)); copy.setOnClickListener((v) -> copyAll()); head.addView(copy);
        TextView x = new TextView(this); x.setText("✕"); x.setTextColor(0xFFE8EAED); x.setTextSize(16); x.setPadding(px(10), px(8), px(4), px(8)); x.setOnClickListener((v) -> clear()); head.addView(x);
        card.addView(head);
        ScrollView sv = new ScrollView(this); LinearLayout list = new LinearLayout(this); list.setOrientation(LinearLayout.VERTICAL); sv.addView(list);
        for (KtScreenA11y.Block k : shown) {
            TextView a = new TextView(this); a.setText(k.tr); a.setTextColor(Color.WHITE); a.setTextSize((float) n(sub("style"), "size", 15)); a.setTextIsSelectable(false); a.setPadding(0, px(6), 0, 0);
            TextView o = new TextView(this); o.setText(k.text); o.setTextColor(0xFF9AA0A6); o.setTextSize(12); o.setPadding(0, 0, 0, px(6));
            a.setOnLongClickListener((v) -> { copy(k.tr); return true; });
            list.addView(a); list.addView(o);
        }
        card.addView(sv, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.min((int) (sh * 0.42), px(60) * Math.max(1, shown.size()))));
        WindowManager.LayoutParams p = params(sw - px(16), ViewGroup.LayoutParams.WRAP_CONTENT, 0); p.x = px(8); p.y = sh - px(16) - Math.min((int) (sh * 0.42), px(60) * Math.max(1, shown.size())) - px(56);
        panel = card; try { wm.addView(card, p); } catch (Throwable ignored) {}
    }
    private void copyAll() { StringBuilder b = new StringBuilder(); for (KtScreenA11y.Block k : shown) { if (b.length() > 0) b.append('\n'); b.append(k.tr); } copy(b.toString()); }
    private void copy(String s) { try { ((ClipboardManager) getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("translation", s)); toast(label("copied", "Copied")); } catch (Throwable ignored) {} }

    /* ---------- history and reading aloud ---------- */
    private void remember(List<KtScreenA11y.Block> blocks) {
        if (!b(cfg, "history", true)) return;
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE); List<Object> h = KtJson.arr(KtJson.parse(sp.getString("history", "[]")));
            java.util.Set<String> seen = new java.util.HashSet<>(); for (Object o : h) seen.add(KtJson.str(KtJson.obj(o).get("o"), ""));
            long now = System.currentTimeMillis(); List<Object> add = new ArrayList<>();
            for (KtScreenA11y.Block k : blocks) if (k.tr != null && seen.add(k.text) && k.text.length() > 1) add.add(KtJson.map("o", k.text, "t", k.tr, "at", now));
            add.addAll(h); while (add.size() > 300) add.remove(add.size() - 1);
            sp.edit().putString("history", KtJson.write(add)).apply();
        } catch (Throwable ignored) {}
    }
    private void speak(List<KtScreenA11y.Block> blocks) {
        if (!b(cfg, "speak", false)) return;
        StringBuilder sb = new StringBuilder(); for (KtScreenA11y.Block k : blocks) if (k.tr != null) sb.append(k.tr).append(". ");
        final String text = sb.toString();
        if (tts == null) { tts = new TextToSpeech(this, (st) -> { ttsReady = st == TextToSpeech.SUCCESS; if (ttsReady) { try { tts.setLanguage(Locale.forLanguageTag(s(cfg, "target", "en"))); tts.setSpeechRate((float) n(cfg, "ttsRate", 1)); } catch (Throwable ignored) {} tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "kt"); } }); return; }
        if (ttsReady) { try { tts.setLanguage(Locale.forLanguageTag(s(cfg, "target", "en"))); } catch (Throwable ignored) {} tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "kt"); }
    }
    private void toast(String m) { ui.post(() -> { try { Toast.makeText(getApplicationContext(), m, Toast.LENGTH_SHORT).show(); } catch (Throwable ignored) {} }); }

    /* ---------- from the app ---------- */
    static void start(Context c, String action) { Intent i = new Intent(c, KtScreenService.class).setAction(action); if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i); }
    static void stop(Context c) { try { c.startService(new Intent(c, KtScreenService.class).setAction(ACT_STOP)); } catch (Throwable e) { c.stopService(new Intent(c, KtScreenService.class)); } }
}
