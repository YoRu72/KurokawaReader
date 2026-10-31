package app.kurokawa.reader;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;

/**
 * Read aloud with the screen off: a foreground service ("media playback") that keeps the app speaking behind
 * others, with a media notification — previous, play/pause, next, stop — and a media session, so a headset's
 * and the lock screen's buttons work too. The speaking itself is the plugin's queue (KurokawaPlugin.ttsQueue);
 * this service only holds the app up and passes the buttons on.
 */
public class KrTtsService extends Service {
    static final String CH = "kr_tts";
    static final int NOTE = 7501;
    private static MediaSession session;
    private static boolean running = false;

    @Override public IBinder onBind(Intent intent) { return null; }

    /** Shown (the service started the first time) or brought up to date. */
    static void show(Context c, String title, String text, boolean playing) {
        Intent i = new Intent(c, KrTtsService.class);
        i.putExtra("title", title); i.putExtra("text", text); i.putExtra("playing", playing);
        try {
            if (!running && Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
            running = true;
        } catch (Exception ignored) { /* not allowed from the background: the reading goes on without it */ }
    }
    /** Gone, with its notification. */
    static void end(Context c) {
        if (!running) return;
        running = false;
        try { c.stopService(new Intent(c, KrTtsService.class)); } catch (Exception ignored) {}
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String act = intent != null ? intent.getAction() : null;
        if (act != null) {
            KurokawaPlugin p = KurokawaPlugin.current;
            if (p != null) p.control(act);
            else if ("stop".equals(act)) { running = false; stopSelf(); }
            return START_NOT_STICKY;
        }
        channel(this);
        if (session == null) {
            session = new MediaSession(this, "KurokawaReader");
            session.setCallback(new MediaSession.Callback() {
                @Override public void onPlay() { send("play"); }
                @Override public void onPause() { send("pause"); }
                @Override public void onSkipToNext() { send("next"); }
                @Override public void onSkipToPrevious() { send("prev"); }
                @Override public void onStop() { send("stop"); }
            });
            session.setActive(true);
        }
        String title = intent != null ? intent.getStringExtra("title") : "";
        String text = intent != null ? intent.getStringExtra("text") : "";
        boolean playing = intent == null || intent.getBooleanExtra("playing", true);
        session.setPlaybackState(new PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_STOP)
            .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f).build());
        Notification n = build(title == null ? "" : title, text == null ? "" : text, playing);
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(NOTE, n);
        return START_NOT_STICKY;
    }

    private static void send(String what) { KurokawaPlugin p = KurokawaPlugin.current; if (p != null) p.control(what); }

    private PendingIntent action(String what, int code) {
        Intent i = new Intent(this, KrTtsService.class); i.setAction(what);
        return PendingIntent.getService(this, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @SuppressWarnings("deprecation")
    private Notification build(String title, String text, boolean playing) {
        boolean ar = "ar".equals(getResources().getConfiguration().locale.getLanguage());
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH) : new Notification.Builder(this);
        b.setSmallIcon(playing ? android.R.drawable.ic_media_play : android.R.drawable.ic_media_pause)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(playing)
            .setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setContentIntent(KrJobService.openApp(this))
            .setDeleteIntent(action("stop", 5))
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_previous, ar ? "السابق" : "Previous", action("prev", 1)).build())
            .addAction(new Notification.Action.Builder(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play, playing ? (ar ? "إيقاف مؤقت" : "Pause") : (ar ? "تشغيل" : "Play"), action("toggle", 2)).build())
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_next, ar ? "التالي" : "Next", action("next", 3)).build())
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, ar ? "إيقاف" : "Stop", action("stop", 4)).build())
            .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2));
        return b.build();
    }

    static void channel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CH) != null) return;
        @SuppressWarnings("deprecation") boolean ar = "ar".equals(c.getResources().getConfiguration().locale.getLanguage());
        NotificationChannel ch = new NotificationChannel(CH, ar ? "القراءة الصوتية" : "Read aloud", NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    @Override
    public void onDestroy() {
        running = false;
        if (session != null) { try { session.setActive(false); session.release(); } catch (Exception ignored) {} session = null; }
        super.onDestroy();
    }
}
