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
    @Override public void onConfigurationChanged(android.content.res.Configuration c) { super.onConfigurationChanged(c); measure(); clear(); if (bubble != null) snap(); }

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
        KtScreenCapture.stop(); try { if (tts != null) tts.shutdown(); } catch (Throwable ignored) {} work.shutdownNow();
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
    private void working(boolean on) { busy = on; ui.post(() -> { if (bubbleText != null) bubbleText.setText(on ? "…" : autoOn ? "文A●" : "文A"); if (on) wake(); }); }

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
        TextView eng = chip(engineLabel(), (v) -> { cycleEngine(); showMenu(); }); TextView lang = chip("→ " + langLabel(s(cfg, "target", "ar")), (v) -> { remove(menu); menu = null; showLangs(); });
        head.addView(eng); head.addView(lang); box.addView(head);
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
        cfg.put("engine", next); save(); KtTranslate.forget(); toast(engineLabel());
    }
    private String langLabel(String code) { for (Object o : KtJson.arr(cfg.get("langs"))) { List<Object> l = KtJson.arr(o); if (l.size() >= 2 && code.equals(l.get(0))) return String.valueOf(l.get(1)); } return code; }
    /** The language to translate into, chosen from a list by the bubble. */
    private void showLangs() {
        ScrollView sv = new ScrollView(this); LinearLayout list = new LinearLayout(this); list.setOrientation(LinearLayout.VERTICAL); list.setPadding(px(8), px(8), px(8), px(8)); sv.addView(list);
        GradientDrawable g = new GradientDrawable(); g.setColor(0xF51E1F22); g.setCornerRadius(px(20)); sv.setBackground(g);
        String cur = s(cfg, "target", "ar");
        for (Object o : KtJson.arr(cfg.get("langs"))) { List<Object> l = KtJson.arr(o); if (l.size() < 2) continue; final String code = String.valueOf(l.get(0));
            TextView t = new TextView(this); t.setText((code.equals(cur) ? "✓  " : "    ") + l.get(1)); t.setTextColor(code.equals(cur) ? 0xFF8AB4F8 : Color.WHITE); t.setTextSize(15); t.setPadding(px(14), px(9), px(14), px(9)); t.setMinWidth(px(200));
            t.setOnClickListener((v) -> { remove(menu); menu = null; cfg.put("target", code); save(); toast("→ " + langLabel(code)); if (!shown.isEmpty()) translate(lastArea, true); });
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
        autoOn = !autoOn; ui.removeCallbacks(tick); working(false); KtScreenCapture.watcher = null; following = false;
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
    private void stopAuto() { autoOn = false; following = false; KtScreenCapture.watcher = null; ui.removeCallbacks(tick); working(false); }
    private final Runnable settled = () -> { if (autoOn && !busy) translate(lastArea, true); };
    /** The screen scrolled or changed (the accessibility service says): the translations moved with it when it says by
     *  how much, else hidden; read again once the screen is still (auto) — the words met before cost nothing. */
    void screenMoved(boolean scrolled, int dy) {
        ui.post(() -> {
            if (following) return;   // (the picture itself is followed instead)
            if (scrolled && !shown.isEmpty() && panel == null) { if (dy != 0) { scrollY += dy; placeAll(); } else hideResults(); }
            if (autoOn && !"interval".equals(s(cfg, "auto", "scroll"))) { if (System.currentTimeMillis() > autoUntil) { stopAuto(); return; } ui.removeCallbacks(settled); ui.postDelayed(settled, (long) (Math.min(n(cfg, "settle", 0.7), 0.4) * 1000)); }
        });
    }
    void captureStopped() { ui.post(() -> { if (autoOn && following) stopAuto(); }); }

    /* ---------- following a page in the picture (auto, read as a picture) ----------
       The translations are remembered where they are on the page, not on the screen: «scrollY» is how far the page
       has moved since the first reading, found frame by frame from the picture (KtScreenMotion). A scroll moves every
       translation with the page at once — those scrolled back into view are there again straight away — and once the
       page stands still it is read again, and only lines not met before are translated. */
    private volatile boolean following = false; private volatile int scrollY = 0; private short[][] prevSig; private volatile long movedAt = 0; private volatile boolean needRead = false; private int noMatch = 0;
    private volatile int[][] masks = new int[0][];
    private final List<KtScreenA11y.Block> memory = new ArrayList<>();
    private void startFollowing() {
        if (following) return; following = true; prevSig = null; noMatch = 0; needRead = false;
        KtScreenCapture.watcher = new KtScreenCapture.Watcher() {
            @Override public int[][] masks() { return masks; }
            @Override public void frame(short[][] sig, long at) {
                if (!following || reading) { prevSig = null; return; }
                short[][] prev = prevSig; prevSig = sig; if (prev == null) return;
                int d = KtScreenMotion.shift(prev, sig, sh);
                if (d == KtScreenMotion.NONE) { if (++noMatch == 2) { movedAt = at; needRead = true; ui.post(() -> { memory.clear(); scrollY = 0; if (results != null) results.removeAllViews(); shown = new ArrayList<>(); masks = new int[0][]; }); } return; }   // (another page: what was remembered no longer belongs)
                noMatch = 0;
                if (d != 0) { scrollY += d; movedAt = at; needRead = true; ui.post(KtScreenService.this::placeAll); return; }
                if (needRead && at - movedAt > (long) (Math.max(0.25, n(cfg, "settle", 0.7)) * 1000) && !busy && autoOn) { needRead = false; ui.post(() -> { if (autoOn && !busy) translate(null, true); }); }
            }
        };
    }
    private volatile boolean reading = false;

    /* ---------- reading and translating ---------- */
    private void translate(Rect area, boolean quiet) {
        final int my = ++gen; lastArea = area; working(true);
        work.execute(() -> {
            try {
                List<KtScreenA11y.Block> blocks = new ArrayList<>(); String read = s(cfg, "read", "auto"); boolean picture = false; int at = scrollY;
                if (!"picture".equals(read) && KtScreenA11y.self != null) blocks = KtScreenA11y.read(area);
                if (blocks.isEmpty() && !"text".equals(read)) {
                    if (!KtScreenCapture.ready()) {
                        if ("text".equals(read)) { if (!quiet) toast(label("needA11y", "Turn on the accessibility service")); return; }
                        pendingAfterConsent = () -> translate(area, quiet);
                        ui.post(() -> { try { startActivity(new Intent(this, KtScreenCapture.Consent.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION)); } catch (Throwable ignored) {} });
                        return;
                    }
                    reading = true; at = scrollY;
                    long since = hideAll(true);
                    Bitmap shot = KtScreenCapture.grab(since);
                    hideAll(false); reading = false;
                    if (shot == null) { if (!quiet) toast(label("captureFailed", "The screen could not be read")); return; }
                    blocks = KtScreenOcr.read(shot, area, s(cfg, "source", "auto")); shot.recycle(); picture = true;
                } else if (blocks.isEmpty() && KtScreenA11y.self == null && !quiet) { toast(label("needA11y", "Turn on the accessibility service")); return; }
                if (my != gen) return;
                if (blocks.isEmpty() && !(autoOn && picture)) { if (!quiet) toast(label("noText", "No text found here")); ui.post(this::clear); return; }
                if (quiet && !picture && same(blocks, shown) && results != null && results.getVisibility() == View.VISIBLE) return;
                // (Lines met before keep their translation — a page scrolled back costs nothing.)
                List<String> texts = new ArrayList<>(); for (KtScreenA11y.Block k : blocks) texts.add(k.text);
                List<String> tr = KtTranslate.translate(texts, KtTranslate.Config.from(cfg));
                for (int k = 0; k < blocks.size(); k++) blocks.get(k).tr = tr.get(k);
                if (my != gen) return;
                final List<KtScreenA11y.Block> done = blocks; final boolean pic = picture; final int base = at;
                ui.post(() -> {
                    if (my != gen) return;
                    if ("panel".equals(s(cfg, "display", "overlay"))) { shown = done; showPanel(); }
                    else if (autoOn && pic && area == null) { merge(done, base); startFollowing(); }
                    else { scrollY = 0; memory.clear(); for (KtScreenA11y.Block k : done) { k.y = k.r.top; memory.add(k); } drawMemory(); }
                    remember(done); speak(done);
                });
            } catch (Throwable e) {
                reading = false;
                String m = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                if (!quiet) toast(m.contains("deeplKey") ? label("needDeepl", "Add your DeepL key in the app") : label("failed", "Translation failed") + ": " + m);
            } finally { if (my == gen) working(false); }
        });
    }
    /** A new reading of the page (at page offset `base`) put with what is remembered: the lines in view now replace
     *  those remembered there; the ones out of view are kept for when the page comes back. */
    private void merge(List<KtScreenA11y.Block> fresh, int base) {
        int top = base, bottom = base + sh; List<KtScreenA11y.Block> keep = new ArrayList<>();
        for (KtScreenA11y.Block m : memory) { int y = m.y, y2 = m.y + m.r.height(); if (y2 < top + px(8) || y > bottom - px(8)) keep.add(m); }
        for (KtScreenA11y.Block k : fresh) { k.y = k.r.top + base; keep.add(k); }
        while (keep.size() > 400) keep.remove(0);
        memory.clear(); memory.addAll(keep); drawMemory();
    }
    private static boolean same(List<KtScreenA11y.Block> a, List<KtScreenA11y.Block> b) { if (a.size() != b.size()) return false; for (int k = 0; k < a.size(); k++) if (!a.get(k).text.equals(b.get(k).text) || !a.get(k).r.equals(b.get(k).r)) return false; return true; }
    /** The translator's own views hidden (true) for a picture of the screen, or shown again; when hidden. */
    private long hideAll(boolean hide) {
        CountDownLatch l = new CountDownLatch(1);
        ui.post(() -> { int v = hide ? View.INVISIBLE : View.VISIBLE; for (View x : new View[] { bubble, results, panel }) if (x != null) x.setVisibility(v); l.countDown(); });
        try { l.await(1, TimeUnit.SECONDS); if (hide) Thread.sleep(70); } catch (InterruptedException ignored) {}
        return System.currentTimeMillis();
    }

    /* ---------- drawing the translations over the words ---------- */
    private void redraw() { drawMemory(); }
    @SuppressLint("ClickableViewAccessibility")
    private void drawMemory() {
        Map<String, Object> st = sub("style"); boolean tapClose = b(cfg, "tapClose", true) && !autoOn;
        if (results == null) {
            results = new FrameLayout(this);
            // (Over the other app, the translations let touches through — scrolling goes on. The accessibility
            // service's own layer is trusted by Android to do that at full opacity; an ordinary overlay is kept at
            // Android 12's 80% for it.)
            KtScreenA11y a = KtScreenA11y.self; boolean trusted = a != null && Build.VERSION.SDK_INT >= 22;
            resultsWm = trusted ? (WindowManager) a.getSystemService(Context.WINDOW_SERVICE) : wm;
            WindowManager.LayoutParams p = params(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, tapClose ? 0 : WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE);
            if (trusted) p.type = WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY; else if (!tapClose && Build.VERSION.SDK_INT >= 31) p.alpha = 0.8f;
            results.setOnTouchListener((v, e) -> { if (e.getActionMasked() == MotionEvent.ACTION_DOWN) { clear(); return true; } return false; });
            try { resultsWm.addView(results, p); } catch (Throwable e) { try { resultsWm = wm; p.type = overlayType(); if (!tapClose && Build.VERSION.SDK_INT >= 31) p.alpha = 0.8f; wm.addView(results, p); } catch (Throwable e2) { results = null; return; } }
        }
        results.removeAllViews(); results.setVisibility(View.VISIBLE);
        float size = (float) n(st, "size", 15); boolean smart = b(st, "smart", true); int bg = color(s(st, "bg", "#1E1E1E"), 0xFF1E1E1E), fg = color(s(st, "fg", "#FFFFFF"), Color.WHITE); int alpha = (int) Math.round(255 * n(st, "bgAlpha", 0.88));
        float radius = px(n(st, "radius", 6)); boolean center = b(st, "center", false), outline = b(st, "outline", false), bold = b(st, "bold", false); float sd = getResources().getDisplayMetrics().scaledDensity;
        List<KtScreenA11y.Block> list = new ArrayList<>();
        for (KtScreenA11y.Block k : memory) {
            if (k.tr == null || k.tr.isEmpty()) continue;
            TextView t = new TextView(this); t.setText(k.tr);
            int fgc = smart && k.bg != 0 ? k.fg : fg; int bgc = smart && k.bg != 0 ? k.bg : bg;
            t.setTextColor(fgc); if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
            if (outline) t.setShadowLayer(px(2), 0, 0, (fgc & 0xFFFFFF) > 0x888888 ? Color.BLACK : Color.WHITE);
            GradientDrawable g = new GradientDrawable(); g.setColor((alpha << 24) | (bgc & 0xFFFFFF)); g.setCornerRadius(radius); if (!"none".equals(s(st, "bgMode", "fill"))) t.setBackground(g);
            t.setGravity((center ? Gravity.CENTER_HORIZONTAL : Gravity.START) | Gravity.CENTER_VERTICAL); t.setPadding(px(2), 0, px(2), 0); t.setIncludeFontPadding(false);
            int w = Math.max(k.r.width(), px(36)), h = Math.max(k.r.height(), px(14));
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, size);
            // (As big as the words' box allows — up to twice the size set —, never under 8.)
            TextViewCompat.setAutoSizeTextTypeUniformWithConfiguration(t, 8, (int) Math.max(9, Math.min(size * 2, h / sd)), 1, TypedValue.COMPLEX_UNIT_SP);
            results.addView(t, new FrameLayout.LayoutParams(w, h)); t.setTag(k); list.add(k);
        }
        shown = list; placeAll();
        double hideAfter = n(cfg, "hideAfter", 0); ui.removeCallbacks(hideRun); if (hideAfter > 0 && !autoOn) ui.postDelayed(hideRun, (long) (hideAfter * 1000));
    }
    /** Every translation put where its words are now: its place on the page less how far the page has moved. */
    private void placeAll() {
        if (results == null) return; results.setVisibility(View.VISIBLE);
        int[] at = new int[2]; results.getLocationOnScreen(at); List<int[]> m = new ArrayList<>();
        for (int c = 0; c < results.getChildCount(); c++) {
            View v = results.getChildAt(c); KtScreenA11y.Block k = (KtScreenA11y.Block) v.getTag(); if (k == null) continue;
            int y = k.y - scrollY; v.setX(k.r.left - at[0]); v.setY(y - at[1]);
            boolean in = y + v.getLayoutParams().height > 0 && y < sh; v.setVisibility(in ? View.VISIBLE : View.GONE);
            if (in) m.add(new int[] { k.r.left - px(2), y - px(2), k.r.left + v.getLayoutParams().width + px(2), y + v.getLayoutParams().height + px(2) });
        }
        masks = m.toArray(new int[0][]);
    }
    private final Runnable hideRun = this::clear;
    private void hideResults() { if (results != null) results.setVisibility(View.INVISIBLE); masks = new int[0][]; }
    void clear() { remove(results); results = null; remove(panel); panel = null; shown = new ArrayList<>(); memory.clear(); scrollY = 0; masks = new int[0][]; }

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
        if (tts == null) { tts = new TextToSpeech(this, (st) -> { ttsReady = st == TextToSpeech.SUCCESS; if (ttsReady) { try { tts.setLanguage(Locale.forLanguageTag(s(cfg, "target", "ar"))); tts.setSpeechRate((float) n(cfg, "ttsRate", 1)); } catch (Throwable ignored) {} tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "kt"); } }); return; }
        if (ttsReady) { try { tts.setLanguage(Locale.forLanguageTag(s(cfg, "target", "ar"))); } catch (Throwable ignored) {} tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "kt"); }
    }
    private void toast(String m) { ui.post(() -> { try { Toast.makeText(getApplicationContext(), m, Toast.LENGTH_SHORT).show(); } catch (Throwable ignored) {} }); }

    /* ---------- from the app ---------- */
    static void start(Context c, String action) { Intent i = new Intent(c, KtScreenService.class).setAction(action); if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i); }
    static void stop(Context c) { try { c.startService(new Intent(c, KtScreenService.class).setAction(ACT_STOP)); } catch (Throwable e) { c.stopService(new Intent(c, KtScreenService.class)); } }
}
