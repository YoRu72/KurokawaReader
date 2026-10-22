package app.kurokawa.reader;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.ActionMode;
import android.view.KeyEvent;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KurokawaPlugin.class);
        asView(getIntent());
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        asView(intent);
        super.onNewIntent(intent);
    }

    /** "Share to KurokawaReader" arrives as SEND with a stream extra; hand it to the web side like an open-with. */
    private static void asView(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (uri == null) {
            java.util.ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null && !list.isEmpty()) uri = list.get(0);
        }
        if (uri == null) return;
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(uri);
    }

    /** The reader draws its own selection toolbar; keep the WebView's floating menu out of the way. */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (KurokawaPlugin.volumeKeys && (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN)) {
            if (event.getRepeatCount() == 0) {
                String dir = keyCode == KeyEvent.KEYCODE_VOLUME_UP ? "up" : "down";
                getBridge().getWebView().evaluateJavascript("document.dispatchEvent(new CustomEvent('kr:volume',{detail:'" + dir + "'}))", null);
            }
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (KurokawaPlugin.volumeKeys && (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN)) return true;
        return super.onKeyUp(keyCode, event);
    }

    @Override
    public void onActionModeStarted(ActionMode mode) {
        mode.getMenu().clear();
        super.onActionModeStarted(mode);
    }
}
