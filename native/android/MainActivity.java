package app.kurokawa.reader;

import android.os.Bundle;
import android.view.ActionMode;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KurokawaPlugin.class);
        super.onCreate(savedInstanceState);
    }

    /** The reader draws its own selection toolbar; keep the WebView's floating menu out of the way. */
    @Override
    public void onActionModeStarted(ActionMode mode) {
        mode.getMenu().clear();
        super.onActionModeStarted(mode);
    }
}
