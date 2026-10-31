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
    private static int doneSeq = 8400;

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        channels(this);
        Notification n = note(this, ar(this) ? "التنزيلات جارية" : "Downloads in progress", "", 0, true);
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTE_RUN, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC); else startForeground(NOTE_RUN, n);
        running = true;
        return START_NOT_STICKY;
    }
    @Override public void onDestroy() { running = false; super.onDestroy(); }

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
    static Notification note(Context c, String title, String text, int pct, boolean indeterminate) {
        return new NotificationCompat.Builder(c, CH_RUN).setSmallIcon(android.R.drawable.stat_sys_download).setContentTitle(title).setContentText(text).setProgress(100, Math.max(0, Math.min(100, pct)), indeterminate).setOngoing(true).setOnlyAlertOnce(true).setSilent(true).setContentIntent(openApp(c)).setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE).build();
    }

    /** Started when a download begins (once). */
    static void ensure(Context c) {
        if (running) return;
        try { Intent i = new Intent(c, KtService.class); if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i); running = true; } catch (Exception ignored) { /* background start not allowed: the download still runs while the app lives */ }
    }
    /** The notification brought up to date with the tasks (called by the plugin on each change). */
    static void update(Context c, JSONArray tasks) {
        if (!running) return;
        int active = 0; long done = 0, total = 0, speed = 0; String one = null;
        for (int i = 0; i < tasks.length(); i++) { JSONObject t = tasks.optJSONObject(i); if (t == null) continue; String st = t.optString("state"); if ("downloading".equals(st) || "metadata".equals(st) || "checking".equals(st)) { active++; done += t.optLong("done"); total += t.optLong("total"); speed += t.optLong("downSpeed"); one = t.optString("name"); } }
        if (active == 0) return;
        boolean ar = ar(c);
        String title = active == 1 && one != null ? one : (ar ? arCount(active) : active + " downloads");
        String text = (total > 0 ? Math.round(done * 100.0 / total) + "% · " : "") + human(speed) + "/s";
        try { NotificationManagerCompat.from(c).notify(NOTE_RUN, note(c, title, text, total > 0 ? (int) (done * 100 / total) : 0, total <= 0)); } catch (SecurityException ignored) {}
    }
    private static String arCount(int n) { if (n == 2) return "تنزيلان"; if (n >= 3 && n <= 10) return n + " تنزيلات"; return n + " تنزيلًا"; }
    static String human(long b) { if (b < 1024) return b + " B"; if (b < 1048576) return String.format(java.util.Locale.US, "%.0f KB", b / 1024.0); if (b < 1073741824L) return String.format(java.util.Locale.US, "%.1f MB", b / 1048576.0); return String.format(java.util.Locale.US, "%.2f GB", b / 1073741824.0); }
    /** Stopped once nothing is under way (the notification goes); a finished one said in its own notification. */
    static void maybeStop(Context c, KtEngine e) {
        if (e.anyActive()) return;
        if (running) { try { c.stopService(new Intent(c, KtService.class)); } catch (Exception ignored) {} running = false; try { NotificationManagerCompat.from(c).cancel(NOTE_RUN); } catch (Exception ignored) {} }
    }
    static void finished(Context c, String name, boolean ok, String error) {
        channels(c);
        boolean ar = ar(c);
        Notification n = new NotificationCompat.Builder(c, CH_DONE).setSmallIcon(ok ? android.R.drawable.stat_sys_download_done : android.R.drawable.stat_notify_error).setContentTitle(ok ? (ar ? "اكتمل التنزيل" : "Download finished") : (ar ? "تعذّر التنزيل" : "Download failed")).setContentText(ok ? name : name + (error != null ? " — " + error : "")).setAutoCancel(true).setContentIntent(openApp(c)).build();
        try { NotificationManagerCompat.from(c).notify(doneSeq++, n); } catch (SecurityException ignored) {}
    }
}
