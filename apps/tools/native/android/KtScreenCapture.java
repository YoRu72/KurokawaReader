package app.kurokawa.tools;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import java.nio.ByteBuffer;

/**
 * The screen as a picture, for text no app exposes (games, comics, videos, pictures): Android's screen capture,
 * asked once a session (the system's own dialog), kept while the floating translator runs, and read only when a
 * translation is asked for. The newest frame is held; a picture is made of it only then.
 */
final class KtScreenCapture {
    private static MediaProjection projection; private static VirtualDisplay display; private static ImageReader reader; private static HandlerThread thread;
    private static Image held; private static long heldAt; private static int width, height;

    static boolean ready() { return projection != null && reader != null; }
    /** Told of each new frame (at most about ten a second) as its signature (KtScreenMotion): the translator follows
     *  a scroll with it. */
    interface Watcher { void frame(short[][] sig, long at); int[][] masks(); }
    static volatile Watcher watcher; private static long sigAt;
    private static void watch(Image i) {
        Watcher w = watcher; long now = System.currentTimeMillis(); if (w == null || now - sigAt < 90) return; sigAt = now;
        try {
            Image.Plane p = i.getPlanes()[0]; final ByteBuffer b = p.getBuffer(); final int ps = p.getPixelStride(), rs = p.getRowStride();
            short[][] sig = KtScreenMotion.signature((x, y) -> { int o = y * rs + x * ps; return ((b.get(o) & 255) << 16) | ((b.get(o + 1) & 255) << 8) | (b.get(o + 2) & 255); }, i.getWidth(), i.getHeight(), w.masks());
            w.frame(sig, now);
        } catch (Throwable ignored) {}
    }

    /** Started with the system's consent (from KtScreenCapture.Consent), inside the running foreground service. */
    static synchronized boolean start(Context ctx, int code, Intent data) {
        stop();
        try {
            MediaProjectionManager m = (MediaProjectionManager) ctx.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            projection = m.getMediaProjection(code, data); if (projection == null) return false;
            thread = new HandlerThread("kt-capture"); thread.start(); Handler h = new Handler(thread.getLooper());
            projection.registerCallback(new MediaProjection.Callback() { @Override public void onStop() { synchronized (KtScreenCapture.class) { release(); } KtScreenService s = KtScreenService.self; if (s != null) s.captureStopped(); } }, h);
            DisplayMetrics dm = new DisplayMetrics(); ((WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(dm);
            width = dm.widthPixels; height = dm.heightPixels;
            reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 3);
            reader.setOnImageAvailableListener((r) -> { synchronized (KtScreenCapture.class) { try { Image i = r.acquireLatestImage(); if (i != null) { if (held != null) held.close(); held = i; heldAt = System.currentTimeMillis(); watch(i); } } catch (Throwable ignored) {} } }, h);
            display = projection.createVirtualDisplay("kt-screen", width, height, dm.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, h);
            return true;
        } catch (Throwable e) { release(); return false; }
    }
    static synchronized void stop() { try { if (projection != null) projection.stop(); } catch (Throwable ignored) {} release(); }
    private static void release() {
        try { if (display != null) display.release(); } catch (Throwable ignored) {} display = null;
        try { if (held != null) held.close(); } catch (Throwable ignored) {} held = null;
        try { if (reader != null) reader.close(); } catch (Throwable ignored) {} reader = null;
        try { if (thread != null) thread.quitSafely(); } catch (Throwable ignored) {} thread = null;
        projection = null;
    }

    /** The screen as it is after `since` (the translator's own views hidden by then): waits up to 700 ms for a frame
     *  after it, else the newest there is. */
    static Bitmap grab(long since) {
        long until = System.currentTimeMillis() + 700;
        while (System.currentTimeMillis() < until) { synchronized (KtScreenCapture.class) { if (held != null && heldAt > since) break; } try { Thread.sleep(25); } catch (InterruptedException e) { break; } }
        synchronized (KtScreenCapture.class) {
            if (held == null) return null;
            try {
                Image.Plane p = held.getPlanes()[0]; ByteBuffer buf = p.getBuffer(); int ps = p.getPixelStride(), rs = p.getRowStride(); int w = held.getWidth(), h = held.getHeight();
                Bitmap b = Bitmap.createBitmap(w + (rs - ps * w) / ps, h, Bitmap.Config.ARGB_8888); buf.rewind(); b.copyPixelsFromBuffer(buf);
                return b.getWidth() == w ? b : Bitmap.createBitmap(b, 0, 0, w, h);
            } catch (Throwable e) { return null; }
        }
    }

    /** The system's «start recording or casting?» question, asked from a see-through screen; its answer handed to the service. */
    public static class Consent extends Activity {
        @Override protected void onCreate(Bundle b) {
            super.onCreate(b);
            try { MediaProjectionManager m = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE); startActivityForResult(m.createScreenCaptureIntent(), 7301); }
            catch (Throwable e) { finish(); }
        }
        @Override protected void onActivityResult(int req, int code, Intent data) {
            super.onActivityResult(req, code, data);
            Intent i = new Intent(this, KtScreenService.class).setAction(KtScreenService.ACT_CONSENT).putExtra("code", code);
            if (data != null) i.putExtra("data", data);
            try { startService(i); } catch (Throwable ignored) {}
            finish(); overridePendingTransition(0, 0);
        }
    }
}
