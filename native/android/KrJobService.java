package app.kurokawa.reader;

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

/**
 * Long work in the app (a conversion) keeps going when the app is left: this foreground service holds the app
 * alive and shows the work's progress in a notification; the last notification says it is done, and opens the
 * app when tapped.
 */
public class KrJobService extends Service {
    static final String CH_RUN = "kr_jobs";
    static final String CH_DONE = "kr_jobs_done";
    static final int NOTE_RUN = 7301;
    private static int doneSeq = 7400;

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        channels(this);
        String title = intent != null ? intent.getStringExtra("title") : null;
        String text = intent != null ? intent.getStringExtra("text") : null;
        int pct = intent != null ? intent.getIntExtra("pct", 0) : 0;
        Notification n = running(this, title != null ? title : "", text != null ? text : "", pct);
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTE_RUN, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(NOTE_RUN, n);
        return START_NOT_STICKY;
    }

    static void channels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        @SuppressWarnings("deprecation") boolean ar = "ar".equals(c.getResources().getConfiguration().locale.getLanguage());
        if (nm.getNotificationChannel(CH_RUN) == null) {
            NotificationChannel ch = new NotificationChannel(CH_RUN, ar ? "التحويل الجاري" : "Conversions in progress", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        if (nm.getNotificationChannel(CH_DONE) == null) {
            nm.createNotificationChannel(new NotificationChannel(CH_DONE, ar ? "التحويلات المنتهية" : "Finished conversions", NotificationManager.IMPORTANCE_DEFAULT));
        }
    }

    static PendingIntent openApp(Context c) {
        Intent i = c.getPackageManager().getLaunchIntentForPackage(c.getPackageName());
        if (i == null) i = new Intent(c, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        i.putExtra("krJobs", true);
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static Notification running(Context c, String title, String text, int pct) {
        return new NotificationCompat.Builder(c, CH_RUN)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(title)
            .setContentText(text)
            .setProgress(100, Math.max(0, Math.min(100, pct)), pct <= 0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(openApp(c))
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
    }

    /** Progress: starts the service the first time, then only updates its notification. */
    static void progress(Context c, String title, String text, int pct, boolean started) {
        if (!started) {
            Intent i = new Intent(c, KrJobService.class).putExtra("title", title).putExtra("text", text).putExtra("pct", pct);
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
            return;
        }
        try { NotificationManagerCompat.from(c).notify(NOTE_RUN, running(c, title, text, pct)); } catch (SecurityException ignored) { /* notifications not allowed */ }
    }

    /** Done (or failed): the service stops, and a notification says so (when there is something to say). */
    static void done(Context c, String title, String text, boolean ok, boolean stop) {
        if (stop) {
            c.stopService(new Intent(c, KrJobService.class));
            try { NotificationManagerCompat.from(c).cancel(NOTE_RUN); } catch (Exception ignored) { }
        }
        if (text == null || text.isEmpty()) return;
        channels(c);
        Notification n = new NotificationCompat.Builder(c, CH_DONE)
            .setSmallIcon(ok ? android.R.drawable.stat_sys_download_done : android.R.drawable.stat_notify_error)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(openApp(c))
            .build();
        try { NotificationManagerCompat.from(c).notify(doneSeq++, n); } catch (SecurityException ignored) { }
    }
}
