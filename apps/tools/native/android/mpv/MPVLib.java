package is.xyz.mpv;

import android.content.Context;
import android.graphics.Bitmap;
import android.view.Surface;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * libmpv, as mpv-android builds it (its libmpv.so and its JNI glue libplayer.so, MIT): the same class name and
 * methods its native code binds to, written in Java for this app. Its libraries are not in the APK: they come with
 * the mpv pack (the Player add-on's engine), and are loaded from where the pack was unpacked — the ones the others
 * need first, so that each finds its own already there.
 */
@SuppressWarnings("unused")
public final class MPVLib {
    private MPVLib() {}
    private static volatile boolean loaded = false;

    /** The pack's libraries loaded (each once): those another needs first, by trying until none is left. */
    public static synchronized void load(File libDir) {
        if (loaded) return;
        File[] all = libDir.listFiles((d, n) -> n.endsWith(".so"));
        if (all == null || all.length == 0) throw new UnsatisfiedLinkError("mpv pack: no libraries in " + libDir);
        List<File> left = new ArrayList<>(); for (File f : all) left.add(f);
        // (libmpv and the glue last; the rest in whatever order lets each one load.)
        left.sort((a, b) -> Integer.compare(rank(a.getName()), rank(b.getName())));
        UnsatisfiedLinkError last = null;
        for (int round = 0; round < all.length + 1 && !left.isEmpty(); round++) {
            boolean progress = false;
            for (java.util.Iterator<File> it = left.iterator(); it.hasNext(); ) {
                File f = it.next();
                try { System.load(f.getAbsolutePath()); it.remove(); progress = true; } catch (UnsatisfiedLinkError e) { last = e; }
            }
            if (!progress) break;
        }
        if (!left.isEmpty()) throw last != null ? last : new UnsatisfiedLinkError("mpv pack: " + left);
        loaded = true;
    }
    private static int rank(String n) { return n.equals("libplayer.so") ? 3 : n.equals("libmpv.so") ? 2 : n.startsWith("libc++") ? 0 : 1; }
    public static boolean isLoaded() { return loaded; }

    public static native void create(Context appctx);
    public static native void init();
    public static native void destroy();
    public static native void attachSurface(Surface surface);
    public static native void detachSurface();
    public static native void command(String[] cmd);
    public static native int setOptionString(String name, String value);
    public static native Bitmap grabThumbnail(int dimension);
    public static native Integer getPropertyInt(String property);
    public static native void setPropertyInt(String property, int value);
    public static native Double getPropertyDouble(String property);
    public static native void setPropertyDouble(String property, double value);
    public static native Boolean getPropertyBoolean(String property);
    public static native void setPropertyBoolean(String property, boolean value);
    public static native String getPropertyString(String property);
    public static native void setPropertyString(String property, String value);
    public static native void observeProperty(String property, int format);

    /** What mpv tells (from its own thread). */
    public interface EventObserver {
        void eventProperty(String property);
        void eventProperty(String property, long value);
        void eventProperty(String property, boolean value);
        void eventProperty(String property, String value);
        void eventProperty(String property, double value);
        void event(int eventId);
    }
    public interface LogObserver { void logMessage(String prefix, int level, String text); }
    private static final List<EventObserver> observers = new ArrayList<>();
    private static final List<LogObserver> logObservers = new ArrayList<>();
    public static void addObserver(EventObserver o) { synchronized (observers) { observers.add(o); } }
    public static void removeObserver(EventObserver o) { synchronized (observers) { observers.remove(o); } }
    public static void addLogObserver(LogObserver o) { synchronized (logObservers) { logObservers.add(o); } }
    public static void removeLogObserver(LogObserver o) { synchronized (logObservers) { logObservers.remove(o); } }

    // Called by the native code (the names and signatures it looks for).
    public static void eventProperty(String property, long value) { synchronized (observers) { for (EventObserver o : observers) o.eventProperty(property, value); } }
    public static void eventProperty(String property, boolean value) { synchronized (observers) { for (EventObserver o : observers) o.eventProperty(property, value); } }
    public static void eventProperty(String property, double value) { synchronized (observers) { for (EventObserver o : observers) o.eventProperty(property, value); } }
    public static void eventProperty(String property, String value) { synchronized (observers) { for (EventObserver o : observers) o.eventProperty(property, value); } }
    public static void eventProperty(String property) { synchronized (observers) { for (EventObserver o : observers) o.eventProperty(property); } }
    public static void event(int eventId) { synchronized (observers) { for (EventObserver o : observers) o.event(eventId); } }
    public static void logMessage(String prefix, int level, String text) { synchronized (logObservers) { for (LogObserver o : logObservers) o.logMessage(prefix, level, text); } }

    public static final int MPV_FORMAT_NONE = 0, MPV_FORMAT_STRING = 1, MPV_FORMAT_FLAG = 3, MPV_FORMAT_INT64 = 4, MPV_FORMAT_DOUBLE = 5;
    public static final int MPV_EVENT_SHUTDOWN = 1, MPV_EVENT_START_FILE = 6, MPV_EVENT_END_FILE = 7, MPV_EVENT_FILE_LOADED = 8, MPV_EVENT_VIDEO_RECONFIG = 17, MPV_EVENT_SEEK = 20, MPV_EVENT_PLAYBACK_RESTART = 21;
}
