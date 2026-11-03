package app.kurokawa.tools;

import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/** The quick-settings tile: the floating translator started or stopped from the notification shade — the quick
 *  way to bring the bubble back after it was closed. */
public class KtScreenTile extends TileService {
    @Override public void onStartListening() { show(); }
    @Override public void onClick() {
        if (KtScreenService.self != null) KtScreenService.stop(this);
        else if (Settings.canDrawOverlays(this)) KtScreenService.start(this, KtScreenService.ACT_START);
        else {
            // (Not allowed to appear on top yet: the app's page about it opened.)
            Intent i = getPackageManager().getLaunchIntentForPackage(getPackageName());
            if (i != null) { i.setData(android.net.Uri.parse("kurokawatools://screen")); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(android.app.PendingIntent.getActivity(this, 0, i, android.app.PendingIntent.FLAG_IMMUTABLE)); else startActivityAndCollapse(i); }
        }
        getQsTile(); new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(this::show, 600);
    }
    private void show() { Tile t = getQsTile(); if (t == null) return; t.setState(KtScreenService.self != null ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE); t.updateTile(); }
}
