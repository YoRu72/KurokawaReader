package app.kurokawa.reader;

import android.content.Intent;
import android.net.Uri;
import android.content.ContentValues;
import android.provider.MediaStore;
import android.os.Environment;
import android.media.MediaScannerConnection;
import java.io.FileOutputStream;
import java.io.OutputStream;
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
import java.io.InputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import android.app.Activity;
import android.database.Cursor;
import android.provider.DocumentsContract;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.PermissionState;
import android.Manifest;
import android.content.Context;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.provider.Settings;

/**
 * Native helpers for the reader:
 *  - processText: hand selected text to Google Translate / dictionaries (ACTION_PROCESS_TEXT)
 *  - setImmersive: hide or show the status and navigation bars while reading
 *  - pdfOpen / pdfRender / pdfClose: render PDF pages with Android's own renderer, which
 *    substitutes system fonts for non-embedded fonts (pdf.js cannot shape Arabic in that case).
 */
@CapacitorPlugin(name = "Kurokawa", permissions = { @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }) })
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

    /* ---------- Scanning the device for readable files (Storage Access Framework) ---------- */

    /** Lets the user pick a folder (or the whole storage); the grant is persisted. */
    @PluginMethod
    public void pickTree(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "treeResult");
    }

    @ActivityCallback
    private void treeResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) { call.reject("cancelled"); return; }
        Uri tree = result.getData().getData();
        try { getContext().getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) {}
        JSObject ret = new JSObject();
        ret.put("uri", tree.toString());
        String name = tree.getLastPathSegment();
        ret.put("name", name == null ? "" : name.replaceFirst("^primary:", "").replaceFirst("^[^:]*:$", "Storage"));
        call.resolve(ret);
    }

    /** Walks a picked tree and lists files whose extension is in `exts` (lower-case, no dot). */
    @PluginMethod
    public void listTree(PluginCall call) {
        String treeStr = call.getString("uri");
        JSArray extsArr = call.getArray("exts");
        if (treeStr == null) { call.reject("uri required"); return; }
        List<String> exts = new ArrayList<>();
        try { if (extsArr != null) for (int i = 0; i < extsArr.length(); i++) exts.add(extsArr.getString(i).toLowerCase()); } catch (Exception ignored) {}
        Uri tree = Uri.parse(treeStr);
        String rootDoc;
        try { rootDoc = DocumentsContract.getTreeDocumentId(tree); } catch (Exception e) { call.reject("bad tree uri"); return; }
        JSArray out = new JSArray();
        ArrayDeque<String[]> queue = new ArrayDeque<>();
        queue.add(new String[]{ rootDoc, "" });
        int visited = 0;
        while (!queue.isEmpty() && visited < 4000 && out.length() < 5000) {
            String[] cur = queue.poll();
            visited++;
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, cur[0]);
            try (Cursor c = getContext().getContentResolver().query(children, new String[]{
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED }, null, null, null)) {
                if (c == null) continue;
                while (c.moveToNext()) {
                    String id = c.getString(0), name = c.getString(1), mime = c.getString(2);
                    if (name == null) continue;
                    if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                        if (!name.startsWith(".") && !name.equals("Android")) queue.add(new String[]{ id, cur[1] + name + "/" });
                        continue;
                    }
                    int dot = name.lastIndexOf('.');
                    String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase() : "";
                    if (!exts.isEmpty() && !exts.contains(ext)) continue;
                    JSObject f = new JSObject();
                    f.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString());
                    f.put("name", name);
                    f.put("path", cur[1] + name);
                    f.put("mime", mime == null ? "" : mime);
                    f.put("size", c.isNull(3) ? 0 : c.getLong(3));
                    f.put("modified", c.isNull(4) ? 0 : c.getLong(4));
                    out.put(f);
                }
            } catch (Exception ignored) {}
        }
        JSObject ret = new JSObject();
        ret.put("files", out);
        ret.put("truncated", !queue.isEmpty() || out.length() >= 5000);
        call.resolve(ret);
    }

    /* ---------- Scanning the whole device ---------- */

    private boolean allFilesAccess() {
        if (Build.VERSION.SDK_INT >= 30) return Environment.isExternalStorageManager();
        return getPermissionState("storage") == PermissionState.GRANTED;
    }

    /** { granted: boolean, needsSettings: boolean } — on Android 11+ the grant lives in system settings. */
    @PluginMethod
    public void storageAccess(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", allFilesAccess());
        ret.put("needsSettings", Build.VERSION.SDK_INT >= 30);
        call.resolve(ret);
    }

    /** Asks for whole-device read access: the runtime permission below Android 11, the "All files access" settings page from Android 11. */
    @PluginMethod
    public void requestStorageAccess(PluginCall call) {
        if (allFilesAccess()) { JSObject r = new JSObject(); r.put("granted", true); call.resolve(r); return; }
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
                startActivityForResult(call, i, "storageSettingsResult");
            } catch (Exception e) {
                Intent i = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                startActivityForResult(call, i, "storageSettingsResult");
            }
        } else {
            requestPermissionForAlias("storage", call, "storagePermResult");
        }
    }

    @ActivityCallback
    private void storageSettingsResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject r = new JSObject(); r.put("granted", allFilesAccess()); call.resolve(r);
    }

    @PermissionCallback
    private void storagePermResult(PluginCall call) {
        JSObject r = new JSObject(); r.put("granted", allFilesAccess()); call.resolve(r);
    }

    /** Walks the shared storage (and any mounted SD card) for files with the given extensions. */
    @PluginMethod
    public void scanDevice(PluginCall call) {
        if (!allFilesAccess()) { call.reject("no storage access", "NO_ACCESS"); return; }
        JSArray extsArr = call.getArray("exts");
        List<String> exts = new ArrayList<>();
        try { if (extsArr != null) for (int i = 0; i < extsArr.length(); i++) exts.add(extsArr.getString(i).toLowerCase()); } catch (Exception ignored) {}
        List<File> roots = new ArrayList<>();
        roots.add(Environment.getExternalStorageDirectory());
        for (File f : getContext().getExternalFilesDirs(null)) {
            // /storage/XXXX-XXXX/Android/data/<pkg>/files → /storage/XXXX-XXXX
            if (f == null) continue;
            File p = f;
            for (int i = 0; i < 4 && p != null; i++) p = p.getParentFile();
            if (p != null && !roots.contains(p) && p.canRead()) roots.add(p);
        }
        JSArray out = new JSArray();
        ArrayDeque<File> queue = new ArrayDeque<>(roots);
        int visited = 0;
        while (!queue.isEmpty() && visited < 20000 && out.length() < 8000) {
            File dir = queue.poll();
            visited++;
            File[] kids = dir.listFiles();
            if (kids == null) continue;
            for (File k : kids) {
                String name = k.getName();
                if (k.isDirectory()) {
                    if (!name.startsWith(".") && !name.equals("Android") && !name.equalsIgnoreCase("LOST.DIR")) queue.add(k);
                    continue;
                }
                int dot = name.lastIndexOf('.');
                String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase() : "";
                if (!exts.isEmpty() && !exts.contains(ext)) continue;
                JSObject f = new JSObject();
                f.put("uri", Uri.fromFile(k).toString());
                f.put("name", name);
                f.put("path", k.getAbsolutePath());
                f.put("mime", "");
                f.put("size", k.length());
                f.put("modified", k.lastModified());
                out.put(f);
            }
        }
        JSObject ret = new JSObject();
        ret.put("files", out);
        ret.put("truncated", !queue.isEmpty() || out.length() >= 8000);
        call.resolve(ret);
    }

    /** Puts a PNG (base64) on the clipboard as an image. */
    @PluginMethod
    public void copyImage(PluginCall call) {
        String data = call.getString("data", "");
        try {
            File dir = new File(getContext().getCacheDir(), "kr-share");
            dir.mkdirs();
            File f = new File(dir, "clip-" + System.currentTimeMillis() + ".png");
            try (FileOutputStream out = new FileOutputStream(f)) { out.write(Base64.decode(data, Base64.DEFAULT)); }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = ClipData.newUri(getContext().getContentResolver(), "image", uri);
            cm.setPrimaryClip(clip);
            call.resolve();
        } catch (Exception e) { call.reject("copy failed: " + e.getMessage(), e); }
    }

    /** Reads one document as base64 so the web side can import it. */
    @PluginMethod
    public void readDocument(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null) { call.reject("uri required"); return; }
        try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uriStr))) {
            if (in == null) { call.reject("cannot open"); return; }
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[1 << 16]; int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            JSObject ret = new JSObject();
            ret.put("data", Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) { call.reject("read failed: " + e.getMessage(), e); }
    }

    /** Saves a PNG/JPEG (base64) into the device gallery under Pictures/<folder>. */
    @PluginMethod
    public void saveToGallery(PluginCall call) {
        String data = call.getString("data", "");
        String name = call.getString("name", "snapshot.png");
        String folder = call.getString("folder", "Screenshots");
        String mime = name.toLowerCase().endsWith(".jpg") || name.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : "image/png";
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            String shown;
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Images.Media.DISPLAY_NAME, name);
                v.put(MediaStore.Images.Media.MIME_TYPE, mime);
                v.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/" + folder);
                v.put(MediaStore.Images.Media.IS_PENDING, 1);
                Uri uri = getContext().getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                if (uri == null) { call.reject("MediaStore insert failed"); return; }
                try (OutputStream out = getContext().getContentResolver().openOutputStream(uri)) { out.write(bytes); }
                v.clear(); v.put(MediaStore.Images.Media.IS_PENDING, 0);
                getContext().getContentResolver().update(uri, v, null, null);
                shown = Environment.DIRECTORY_PICTURES + "/" + folder + "/" + name;
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), folder);
                dir.mkdirs();
                File f = new File(dir, name);
                try (FileOutputStream out = new FileOutputStream(f)) { out.write(bytes); }
                MediaScannerConnection.scanFile(getContext(), new String[]{ f.getAbsolutePath() }, new String[]{ mime }, null);
                shown = f.getAbsolutePath();
            }
            JSObject ret = new JSObject(); ret.put("path", shown); call.resolve(ret);
        } catch (Exception e) {
            call.reject("Save failed: " + e.getMessage(), e);
        }
    }

    /** Volume keys turn pages when the reader asks for it (MainActivity consults this flag). */
    public static volatile boolean volumeKeys = false;

    @PluginMethod
    public void setVolumeKeys(PluginCall call) {
        volumeKeys = call.getBoolean("on", false);
        call.resolve();
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
