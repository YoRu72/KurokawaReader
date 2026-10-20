package app.kurokawa.reader;

import android.content.Intent;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Hands selected text to other apps (Google Translate, dictionaries…) through
 *  Android's PROCESS_TEXT action — the same chooser the system text menu uses. */
@CapacitorPlugin(name = "SystemText")
public class SystemTextPlugin extends Plugin {
    @PluginMethod
    public void processText(PluginCall call) {
        String text = call.getString("text", "");
        Boolean readonly = call.getBoolean("readonly", true);
        Intent intent = new Intent(Intent.ACTION_PROCESS_TEXT);
        intent.setType("text/plain");
        intent.putExtra(Intent.EXTRA_PROCESS_TEXT, text);
        intent.putExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, readonly != null && readonly);
        try {
            getActivity().startActivity(Intent.createChooser(intent, null));
            call.resolve();
        } catch (Exception e) {
            call.reject("No app can process text", e);
        }
    }
}
