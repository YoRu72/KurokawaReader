package app.kurokawa.tools;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;

/**
 * «Translate screen» as an app of its own — in the app drawer, the phone's sidebar (realme, Samsung…) and on the
 * home screen when added there: opening it starts the floating bubble (or closes it), without the app's window.
 * Not allowed to appear on top yet: the app's page about it opens instead.
 */
public class KtScreenLaunch extends Activity {
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        try {
            if (Settings.canDrawOverlays(this)) {
                if (KtScreenService.self != null && !"translate".equals(getIntent().getStringExtra("do"))) KtScreenService.stop(this);
                else KtScreenService.start(this, "translate".equals(getIntent().getStringExtra("do")) ? KtScreenService.ACT_TRANSLATE : KtScreenService.ACT_START);
            } else {
                Intent i = getPackageManager().getLaunchIntentForPackage(getPackageName());
                if (i != null) { i.setData(android.net.Uri.parse("kurokawatools://screen")); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); startActivity(i); }
            }
        } catch (Throwable ignored) {}
        finish(); overridePendingTransition(0, 0);
    }
}
