package app.kurokawa.tools;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Keeps the downloads going when the app is left: a foreground service with one notification that says how
 * many are under way, how far and how fast; stopped when nothing moves any more.
 */
public class KtService extends Service {
    static final String CH_RUN = "kt_downloads";
    static final String CH_DONE = "kt_done";
    static final int NOTE_RUN = 8301;
    private static boolean running = false;
    /** startForeground() done in this run; a stop asked before it waits for it (stopping first crashes the app). */
    private static volatile boolean foreground = false, stopWhenStarted = false;
    private static int doneSeq = 8400;

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        channels(this);
        Notification n = note(this, ar(this) ? "التنزيلات جارية" : "Downloads in progress", "", 0, true);
        // Android 14+: «special use» has no daily time limit (Android 15 stops «data sync» after six hours a day,
        // and a service that cannot start in the foreground any more would bring the app down with it).
        try {
            if (Build.VERSION.SDK_INT >= 34) { try { startForeground(NOTE_RUN, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE); } catch (RuntimeException e) { startForeground(NOTE_RUN, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC); } }
            else startForeground(NOTE_RUN, n);
            foreground = true;
        } catch (RuntimeException e) { running = false; foreground = false; stopSelf(); return START_NOT_STICKY; }
        running = true; hold(this);
        if (stopWhenStarted) { stopWhenStarted = false; stop(this); }
        return START_NOT_STICKY;
    }
    /** Android 15's time limit reached for this kind of service: stopped at once (not stopping crashes the app); the
     *  downloads go on while the app is open. */
    public void onTimeout(int startId, int fgsType) { stop(this); }
    public void onTimeout(int startId) { stop(this); }
    private static void stop(Service s) { let(); try { if (Build.VERSION.SDK_INT >= 24) s.stopForeground(STOP_FOREGROUND_REMOVE); else s.stopForeground(true); } catch (Exception ignored) {} running = false; foreground = false; s.stopSelf(); }
    @Override public void onDestroy() { let(); running = false; foreground = false; super.onDestroy(); }
    // (The phone kept awake enough for the downloads while they run — the CPU, and Wi-Fi at full speed —: with the screen
    // off, some phones put the network to sleep under a running download. Let go as soon as nothing moves.)
    private static android.os.PowerManager.WakeLock wake; private static android.net.wifi.WifiManager.WifiLock wifi;
    private static synchronized void hold(Context c) {
        try { if (wake == null) { android.os.PowerManager pm = (android.os.PowerManager) c.getSystemService(Context.POWER_SERVICE); wake = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "kurokawa:downloads"); wake.setReferenceCounted(false); } if (!wake.isHeld()) wake.acquire(6 * 3600 * 1000L); } catch (Throwable ignored) {}
        try { if (wifi == null) { android.net.wifi.WifiManager wm = (android.net.wifi.WifiManager) c.getApplicationContext().getSystemService(Context.WIFI_SERVICE); @SuppressWarnings("deprecation") int mode = android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF; wifi = wm.createWifiLock(mode, "kurokawa:downloads"); wifi.setReferenceCounted(false); } if (!wifi.isHeld()) wifi.acquire(); } catch (Throwable ignored) {}
    }
    private static synchronized void let() {
        try { if (wake != null && wake.isHeld()) wake.release(); } catch (Throwable ignored) {}
        try { if (wifi != null && wifi.isHeld()) wifi.release(); } catch (Throwable ignored) {}
    }

    static boolean ar(Context c) { @SuppressWarnings("deprecation") String l = c.getResources().getConfiguration().locale.getLanguage(); return "ar".equals(l); }

    static void channels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class); if (nm == null) return;
        boolean ar = ar(c);
        if (nm.getNotificationChannel(CH_RUN) == null) { NotificationChannel ch = new NotificationChannel(CH_RUN, ar ? "التنزيلات الجارية" : "Downloads in progress", NotificationManager.IMPORTANCE_LOW); ch.setShowBadge(false); nm.createNotificationChannel(ch); }
        if (nm.getNotificationChannel(CH_DONE) == null) nm.createNotificationChannel(new NotificationChannel(CH_DONE, ar ? "التنزيلات المنتهية" : "Finished downloads", NotificationManager.IMPORTANCE_DEFAULT));
    }
    static PendingIntent openApp(Context c) {
        Intent i = c.getPackageManager().getLaunchIntentForPackage(c.getPackageName());
        if (i == null) i = new Intent(c, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
    static Notification note(Context c, String title, String text, int pct, boolean indeterminate) { return builder(c, title, text, pct, indeterminate).build(); }
    static NotificationCompat.Builder builder(Context c, String title, String text, int pct, boolean indeterminate) {
        return new NotificationCompat.Builder(c, CH_RUN).setSmallIcon(android.R.drawable.stat_sys_download).setContentTitle(title).setContentText(text).setProgress(100, Math.max(0, Math.min(100, pct)), indeterminate).setOngoing(true).setOnlyAlertOnce(true).setSilent(true).setContentIntent(openApp(c)).setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE).setCategory(NotificationCompat.CATEGORY_PROGRESS).setShowWhen(false);
    }

    static final String ACT_PAUSE_ALL = "app.kurokawa.tools.PAUSE_ALL", ACT_RESUME_ALL = "app.kurokawa.tools.RESUME_ALL";
    static PendingIntent action(Context c, String act) { return PendingIntent.getBroadcast(c, act.hashCode(), new Intent(c, Actions.class).setAction(act), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT); }
    /** The notification's and the tile's buttons: everything paused or resumed, the app open or not. */
    public static class Actions extends android.content.BroadcastReceiver {
        @Override public void onReceive(Context c, Intent i) {
            KtEngine e = KtPlugin.engineIfAny(); if (e == null) return;
            if (ACT_PAUSE_ALL.equals(i.getAction())) { e.pauseAll(); pausedNote(c); } else if (ACT_RESUME_ALL.equals(i.getAction())) { e.resumeAll(); try { NotificationManagerCompat.from(c).cancel(NOTE_PAUSED); } catch (Exception ignored) {} }
        }
    }
    static final int NOTE_PAUSED = 8302;
    /** «Downloads paused» with a Resume all button, after Pause all. */
    static void pausedNote(Context c) {
        channels(c); boolean ar = ar(c);
        Notification n = new NotificationCompat.Builder(c, CH_RUN).setSmallIcon(android.R.drawable.ic_media_pause).setContentTitle(ar ? "التنزيلات متوقّفة مؤقتًا" : "Downloads paused").setContentIntent(openApp(c)).setAutoCancel(true).setOnlyAlertOnce(true)
            .addAction(0, ar ? "استئناف الكل" : "Resume all", action(c, ACT_RESUME_ALL)).build();
        try { NotificationManagerCompat.from(c).notify(NOTE_PAUSED, n); } catch (SecurityException ignored) {}
    }
    /** Started when a download begins (once). */
    static void ensure(Context c) {
        stopWhenStarted = false;
        if (running) return;
        try { Intent i = new Intent(c, KtService.class); if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i); running = true; } catch (Exception ignored) { /* background start not allowed: the download still runs while the app lives */ }
    }
    /** The notification brought up to date with the tasks (called by the plugin on each change): how far, how
     *  fast and how long is left — for one download its own; for several, a line for each under the total. */
    private static long lastNote = 0;
    static void update(Context c, JSONArray tasks) {
        // (Once a second at most: Android drops faster updates anyway, and each one costs the main thread.)
        long now = System.currentTimeMillis(); if (now - lastNote < 1000) return; lastNote = now;
        int active = 0; long done = 0, total = 0, speed = 0; String one = null; java.util.List<String> lines = new java.util.ArrayList<>();
        boolean ar = ar(c);
        for (int i = 0; i < tasks.length(); i++) { JSONObject t = tasks.optJSONObject(i); if (t == null) continue; String st = t.optString("state"); if ("downloading".equals(st) || "metadata".equals(st) || "checking".equals(st)) {
            active++; long d = t.optLong("done"), tt = t.optLong("total"), sp = t.optLong("downSpeed"); done += d; total += tt; speed += sp; one = t.optString("name");
            if (lines.size() < 6) lines.add((tt > 0 ? Math.round(d * 100.0 / tt) + "% · " : "") + one + (sp > 0 && tt > d ? " · " + left(ar, (tt - d) / sp) : "")); } }
        if (active == 0) return;
        // (Not started — the app was in the background when the first download began: started now.)
        if (!running) { ensure(c); if (!running) return; }
        String title = active == 1 && one != null ? one : (ar ? arCount(active) : active + " downloads");
        String text = (total > 0 ? Math.round(done * 100.0 / total) + "% · " : "") + (total > 0 ? human(done) + " / " + human(total) + " · " : "") + human(speed) + "/s" + (speed > 0 && total > done ? " · " + left(ar, (total - done) / speed) : "");
        NotificationCompat.Builder b = builder(c, title, text, total > 0 ? (int) (done * 100 / total) : 0, total <= 0);
        // (Pause all / Resume all from the notification itself.)
        b.addAction(0, ar ? "إيقاف الكل مؤقتًا" : "Pause all", action(c, ACT_PAUSE_ALL));
        if (active > 1) { NotificationCompat.InboxStyle st = new NotificationCompat.InboxStyle().setSummaryText(text); for (String l : lines) st.addLine(l); b.setStyle(st); }
        try { NotificationManagerCompat.from(c).notify(NOTE_RUN, b.build()); } catch (SecurityException ignored) {}
    }
    /** «4 min left» / «بقي ٤ دقائق» (hours and minutes, or seconds under a minute). */
    static String left(boolean ar, long s) {
        if (s < 0 || s > 86400L * 30) return ar ? "وقت غير معروف" : "time unknown";
        long h = s / 3600, m = (s % 3600) / 60;
        if (ar) return "بقي " + (h > 0 ? h + " س " + m + " د" : m > 0 ? m + " د" : s + " ث");
        return (h > 0 ? h + " h " + m + " min" : m > 0 ? m + " min" : s + " s") + " left";
    }
    private static String arCount(int n) { if (n == 2) return "تنزيلان"; if (n >= 3 && n <= 10) return n + " تنزيلات"; return n + " تنزيلًا"; }
    static String human(long b) { if (b < 1024) return b + " B"; if (b < 1048576) return String.format(java.util.Locale.US, "%.0f KB", b / 1024.0); if (b < 1073741824L) return String.format(java.util.Locale.US, "%.1f MB", b / 1048576.0); return String.format(java.util.Locale.US, "%.2f GB", b / 1073741824.0); }
    /** Stopped once nothing is under way (the notification goes); a finished one said in its own notification. */
    static void maybeStop(Context c, KtEngine e) {
        if (e == null || e.anyActive()) return;
        if (running && !foreground) { stopWhenStarted = true; return; }
        if (running) { let(); try { c.stopService(new Intent(c, KtService.class)); } catch (Exception ignored) {} running = false; foreground = false; try { NotificationManagerCompat.from(c).cancel(NOTE_RUN); } catch (Exception ignored) {} }
    }
    static void finished(Context c, String name, boolean ok, String error) {
        channels(c);
        boolean ar = ar(c);
        Notification n = new NotificationCompat.Builder(c, CH_DONE).setSmallIcon(ok ? android.R.drawable.stat_sys_download_done : android.R.drawable.stat_notify_error).setContentTitle(ok ? (ar ? "اكتمل التنزيل" : "Download finished") : (ar ? "تعذّر التنزيل" : "Download failed")).setContentText(ok ? name : name + (error != null ? " — " + error : "")).setAutoCancel(true).setContentIntent(openApp(c)).build();
        try { NotificationManagerCompat.from(c).notify(doneSeq++, n); } catch (SecurityException ignored) {}
    }
}
