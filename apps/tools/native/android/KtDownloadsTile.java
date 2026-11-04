package app.kurokawa.tools;

import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/** The quick-settings tile for downloads: everything paused, or everything resumed, from the notification shade.
 *  Shown active while something downloads. (The app must be running — its engine lives in it.) */
public class KtDownloadsTile extends TileService {
    @Override public void onStartListening() { show(); }
    @Override public void onClick() {
        KtEngine e = KtPlugin.engineIfAny();
        if (e == null) { Tile t = getQsTile(); if (t != null) { t.setState(Tile.STATE_UNAVAILABLE); t.updateTile(); } return; }
        if (e.anyActive()) { e.pauseAll(); KtService.pausedNote(this); } else e.resumeAll();
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(this::show, 500);
    }
    private void show() {
        Tile t = getQsTile(); if (t == null) return; KtEngine e = KtPlugin.engineIfAny();
        t.setState(e == null ? Tile.STATE_UNAVAILABLE : e.anyActive() ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE); t.updateTile();
    }
}
