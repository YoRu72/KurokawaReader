package app.kurokawa.reader;

import android.os.Bundle;
import android.view.ActionMode;
import android.view.KeyEvent;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KurokawaPlugin.class);
        super.onCreate(savedInstanceState);
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
