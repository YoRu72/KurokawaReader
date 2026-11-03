package app.kurokawa.tools;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;

import is.xyz.mpv.MPVLib;

/**
 * The Player add-on's engine on Android: mpv (libmpv, as mpv-android and the players built on it — mpvEx, REX
 * Player — use it), from the mpv pack. Its picture is drawn on a SurfaceView put behind the app's web view, which
 * turns see-through while it plays, so the player's own controls, gestures and subtitles stay on top as they are.
 * mpv plays what the web view cannot: AC-3, E-AC-3, DTS, TrueHD, HEVC and 10-bit video, every Matroska feature,
 * the subtitles inside the file (ASS drawn by libass). The page drives it with commands and properties and hears
 * back what changed (event «mpv»).
 */
final class KtMpv {
    private static final String TAG = "KtMpv";
    interface Events { void on(JSONObject o); }
    private static KtMpv self;
    static synchronized KtMpv get() { if (self == null) self = new KtMpv(); return self; }

    private final Handler ui = new Handler(Looper.getMainLooper());
    private boolean created = false; private SurfaceView view; private WebView web; private android.graphics.drawable.Drawable webBg; private boolean bgSaved = false; private String pendingUrl; private Events events;
    private String voInUse = "gpu";

    static File libDir(android.content.Context ctx) { return new File(KtPacks.dir(ctx, "mpv"), "usr/lib"); }
    static boolean available(android.content.Context ctx) { return KtPacks.installed(ctx, "mpv") != null && libDir(ctx).isDirectory(); }

    /** mpv made once for the app's life (its native side allows one), with phone-minded options. */
    private void ensure(Activity a) {
        if (created) return;
        MPVLib.load(libDir(a));
        MPVLib.create(a.getApplicationContext());
        MPVLib.setOptionString("config", "no");
        MPVLib.setOptionString("profile", "fast");
        MPVLib.setOptionString("vo", voInUse);
        MPVLib.setOptionString("gpu-context", "android");
        MPVLib.setOptionString("opengl-es", "yes");
        MPVLib.setOptionString("hwdec", "mediacodec,mediacodec-copy");
        MPVLib.setOptionString("hwdec-codecs", "h264,hevc,mpeg4,mpeg2video,vp8,vp9,av1");
        MPVLib.setOptionString("ao", "audiotrack,opensles");
        MPVLib.setOptionString("audio-set-media-role", "yes");
        MPVLib.setOptionString("input-default-bindings", "no");
        MPVLib.setOptionString("flatten-editions", "yes");
        MPVLib.setOptionString("keep-open", "yes");
        MPVLib.setOptionString("save-position-on-quit", "no");
        MPVLib.setOptionString("osd-level", "0");
        // (Subtitles: libass for the file's own and those added; the page's renderer is left for the ones it draws.)
        MPVLib.setOptionString("sub-auto", "no");
        MPVLib.setOptionString("embeddedfonts", "yes");
        long megs = Build.VERSION.SDK_INT >= 27 ? 64 : 32;
        MPVLib.setOptionString("demuxer-max-bytes", String.valueOf(megs << 20));
        MPVLib.setOptionString("demuxer-max-back-bytes", String.valueOf(megs << 20));
        MPVLib.setOptionString("cache", "yes");
        MPVLib.setOptionString("network-timeout", "60");
        try { android.view.Display d = a.getWindowManager().getDefaultDisplay(); MPVLib.setOptionString("display-fps-override", String.valueOf(d.getRefreshRate())); } catch (Throwable ignored) {}
        MPVLib.init();
        MPVLib.setOptionString("force-window", "no");
        MPVLib.setOptionString("idle", "yes");
        String[][] props = {
            { "time-pos", "5" }, { "duration", "5" }, { "pause", "3" }, { "paused-for-cache", "3" }, { "speed", "5" }, { "volume", "5" }, { "mute", "3" },
            { "eof-reached", "3" }, { "demuxer-cache-time", "5" }, { "track-list", "1" }, { "video-params/w", "4" }, { "video-params/h", "4" },
            { "chapter-list", "1" }, { "hwdec-current", "1" }, { "aid", "1" }, { "sid", "1" }, { "seeking", "3" }, { "core-idle", "3" },
        };
        for (String[] p : props) MPVLib.observeProperty(p[0], Integer.parseInt(p[1]));
        MPVLib.addObserver(new MPVLib.EventObserver() {
            @Override public void eventProperty(String property) { tell(property, JSONObject.NULL); }
            @Override public void eventProperty(String property, long value) { tell(property, value); }
            @Override public void eventProperty(String property, boolean value) { tell(property, value); }
            @Override public void eventProperty(String property, String value) { tell(property, value); }
            @Override public void eventProperty(String property, double value) { tell(property, value); }
            @Override public void event(int id) { try { JSONObject o = new JSONObject(); o.put("event", id == MPVLib.MPV_EVENT_FILE_LOADED ? "loaded" : id == MPVLib.MPV_EVENT_END_FILE ? "end" : id == MPVLib.MPV_EVENT_PLAYBACK_RESTART ? "restart" : id == MPVLib.MPV_EVENT_SEEK ? "seek" : id == MPVLib.MPV_EVENT_START_FILE ? "start" : "e" + id); Events e = events; if (e != null) e.on(o); } catch (Exception ignored) {} }
        });
        MPVLib.addLogObserver((prefix, level, text) -> { if (level <= 20) { try { JSONObject o = new JSONObject(); o.put("log", prefix + ": " + text.trim()); Events e = events; if (e != null) e.on(o); } catch (Exception ignored) {} } });
        created = true;
    }
    private void tell(String property, Object value) {
        Events e = events; if (e == null) return;
        try { JSONObject o = new JSONObject(); o.put("prop", property); o.put("value", value); e.on(o); } catch (Exception ignored) {}
    }

    /** Plays `url` (a local path or this app's own stream address), its surface put behind the page. */
    void open(Activity a, WebView webView, String url, JSONObject opt, Events ev) {
        events = ev;
        ui.post(() -> {
            try {
                ensure(a);
                // (Per file: where it starts, the tracks and languages wanted, the decoding — each set before it loads.)
                MPVLib.setOptionString("start", opt.has("start") ? opt.optString("start") : "none");
                for (String k : new String[] { "aid", "sid", "alang", "slang", "speed", "volume", "hwdec", "user-agent", "http-header-fields" }) { String v = opt.optString(k, ""); if (!v.isEmpty()) MPVLib.setOptionString(k, v); }
                if (opt.optBoolean("paused", false)) MPVLib.setPropertyBoolean("pause", true); else MPVLib.setPropertyBoolean("pause", false);
                web = webView; if (!bgSaved) { webBg = webView.getBackground(); bgSaved = true; }
                if (view == null) {
                    view = new SurfaceView(a);
                    view.getHolder().addCallback(new SurfaceHolder.Callback() {
                        @Override public void surfaceCreated(SurfaceHolder h) {
                            MPVLib.attachSurface(h.getSurface()); MPVLib.setOptionString("force-window", "yes");
                            if (pendingUrl != null) { MPVLib.command(new String[] { "loadfile", pendingUrl }); pendingUrl = null; } else MPVLib.setPropertyString("vo", voInUse);
                        }
                        @Override public void surfaceChanged(SurfaceHolder h, int f, int w, int hh) { MPVLib.setPropertyString("android-surface-size", w + "x" + hh); }
                        @Override public void surfaceDestroyed(SurfaceHolder h) { MPVLib.setPropertyString("vo", "null"); MPVLib.setPropertyString("force-window", "no"); MPVLib.detachSurface(); }
                    });
                }
                ViewGroup parent = (ViewGroup) webView.getParent();
                if (view.getParent() == null && parent != null) parent.addView(view, 0, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                webView.setBackgroundColor(Color.TRANSPARENT);
                if (view.getHolder().getSurface() != null && view.getHolder().getSurface().isValid()) MPVLib.command(new String[] { "loadfile", url });
                else pendingUrl = url;
                view.setVisibility(View.VISIBLE);
            } catch (Throwable e) {
                Log.w(TAG, "open", e);
                try { JSONObject o = new JSONObject(); o.put("error", String.valueOf(e.getMessage() == null ? e : e.getMessage())); if (ev != null) ev.on(o); } catch (Exception ignored) {}
            }
        });
    }
    /** Playing stopped: the file let go, the surface taken away, the page opaque again. */
    void close() {
        ui.post(() -> {
            try { if (created) { MPVLib.command(new String[] { "stop" }); } } catch (Throwable ignored) {}
            if (view != null) { ViewGroup p = (ViewGroup) view.getParent(); if (p != null) p.removeView(view); }
            if (web != null && bgSaved) { web.setBackground(webBg); bgSaved = false; }
            pendingUrl = null; events = null;
        });
    }
    void command(JSONArray args) throws Exception {
        if (!created) throw new IllegalStateException("mpv not started");
        String[] a = new String[args.length()]; for (int i = 0; i < a.length; i++) a[i] = args.getString(i);
        MPVLib.command(a);
    }
    void set(String name, String value) { if (created) MPVLib.setPropertyString(name, value); }
    String getString(String name) { return created ? MPVLib.getPropertyString(name) : null; }
}
