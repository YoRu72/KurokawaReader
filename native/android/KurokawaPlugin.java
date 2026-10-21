package app.kurokawa.reader;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.os.ParcelFileDescriptor;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;

/**
 * Native helpers for the reader:
 *  - processText: hand selected text to Google Translate / dictionaries (ACTION_PROCESS_TEXT)
 *  - setImmersive: hide or show the status and navigation bars while reading
 *  - pdfOpen / pdfRender / pdfClose: render PDF pages with Android's own renderer, which
 *    substitutes system fonts for non-embedded fonts (pdf.js cannot shape Arabic in that case).
 */
@CapacitorPlugin(name = "Kurokawa")
public class KurokawaPlugin extends Plugin {
    private PdfRenderer renderer;
    private ParcelFileDescriptor pfd;
    private final Object lock = new Object();

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

    @PluginMethod
    public void deviceInfo(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("abis", new JSArray(java.util.Arrays.asList(Build.SUPPORTED_ABIS)));
        ret.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    /** Opens the system package installer for a downloaded APK (in-app update). */
    @PluginMethod
    public void installApk(PluginCall call) {
        String path = call.getString("path", "");
        if (path.startsWith("file://")) path = path.substring(7);
        try {
            File apk = new File(path);
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Cannot start installer: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void setImmersive(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", true));
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            View decor = window.getDecorView();
            WindowInsetsControllerCompat c = WindowCompat.getInsetsController(window, decor);
            WindowCompat.setDecorFitsSystemWindows(window, !on);
            if (on) {
                c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                c.hide(WindowInsetsCompat.Type.systemBars());
            } else {
                c.show(WindowInsetsCompat.Type.systemBars());
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void pdfOpen(PluginCall call) {
        String path = call.getString("path", "");
        if (path.startsWith("file://")) path = path.substring(7);
        try {
            synchronized (lock) {
                closeInternal();
                pfd = ParcelFileDescriptor.open(new File(path), ParcelFileDescriptor.MODE_READ_ONLY);
                renderer = new PdfRenderer(pfd);
                JSObject ret = new JSObject();
                ret.put("pageCount", renderer.getPageCount());
                call.resolve(ret);
            }
        } catch (Exception e) {
            call.reject("Cannot open PDF: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void pdfRender(PluginCall call) {
        int page = call.getInt("page", 1);
        int width = call.getInt("width", 1080);
        int quality = call.getInt("quality", 85);
        try {
            synchronized (lock) {
                if (renderer == null) { call.reject("No PDF open"); return; }
                PdfRenderer.Page p = renderer.openPage(page - 1);
                int w = Math.max(64, Math.min(width, 4096));
                int h = Math.max(1, (int) Math.round(w * (p.getHeight() / (double) p.getWidth())));
                Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
                bmp.eraseColor(Color.WHITE);
                p.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                p.close();
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                bmp.compress(Bitmap.CompressFormat.JPEG, quality, out);
                bmp.recycle();
                JSObject ret = new JSObject();
                ret.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
                ret.put("width", w);
                ret.put("height", h);
                call.resolve(ret);
            }
        } catch (Exception e) {
            call.reject("Render failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void pdfClose(PluginCall call) {
        synchronized (lock) { closeInternal(); }
        call.resolve();
    }

    private void closeInternal() {
        try { if (renderer != null) renderer.close(); } catch (Exception ignored) {}
        try { if (pfd != null) pfd.close(); } catch (Exception ignored) {}
        renderer = null; pfd = null;
    }
}
