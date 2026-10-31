package app.kurokawa.tools;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The page's door to the engine (KtEngine): every call runs off the main thread and answers with the task
 * JSON the page knows; `tasksChanged` events carry the whole list as it moves. Also: a plain file download with
 * progress (`downloadFile`, for an app's APK), the installer, the device's ABIs, another app's presence.
 */
@CapacitorPlugin(name = "KurokawaTools")
public class KtPlugin extends Plugin {
    private KtEngine engine;
    private final ExecutorService bg = Executors.newCachedThreadPool();
    private final java.util.Map<String, AtomicBoolean> downloads = new java.util.concurrent.ConcurrentHashMap<>();
    private JSONArray lastTasks = new JSONArray();

    private synchronized KtEngine engine() {
        if (engine == null) engine = new KtEngine(getContext(), (tasks) -> {
            // (A finished or failed one, told once in its own notification.)
            try { noteFinished(lastTasks, tasks); } catch (Exception ignored) {}
            lastTasks = tasks;
            JSObject ev = new JSObject(); try { ev.put("tasks", new JSArray(tasks.toString())); } catch (Exception ignored) {}
            notifyListeners("tasksChanged", ev);
            KtService.update(getContext(), tasks);
            KtService.maybeStop(getContext(), engine);
        });
        return engine;
    }
    private void noteFinished(JSONArray before, JSONArray after) {
        java.util.Map<String, String> was = new java.util.HashMap<>();
        for (int i = 0; i < before.length(); i++) { JSONObject t = before.optJSONObject(i); if (t != null) was.put(t.optString("id"), t.optString("state")); }
        for (int i = 0; i < after.length(); i++) { JSONObject t = after.optJSONObject(i); if (t == null) continue; String st = t.optString("state"); String w = was.get(t.optString("id")); if (w == null || w.equals(st)) continue; if ("done".equals(st) || "seeding".equals(st) && !"seeding".equals(w) && "downloading".equals(w)) KtService.finished(getContext(), t.optString("name"), true, null); else if ("failed".equals(st)) KtService.finished(getContext(), t.optString("name"), false, t.optString("error", null)); }
    }
    @Override public void load() { bg.execute(this::engine); }

    private interface Work { void run() throws Exception; }
    private void run(PluginCall call, Work w) { bg.execute(() -> { try { w.run(); } catch (Exception e) { call.reject(e.getMessage() == null ? e.toString() : e.getMessage(), e); } }); }
    private static JSObject obj(JSONObject o) { try { return JSObject.fromJSONObject(o); } catch (Exception e) { return new JSObject(); } }

    @PluginMethod public void list(PluginCall call) { run(call, () -> { JSObject r = new JSObject(); r.put("tasks", new JSArray(engine().list().toString())); call.resolve(r); }); }
    @PluginMethod public void add(PluginCall call) { run(call, () -> { JSObject r = new JSObject(); r.put("task", obj(engine().add(new JSONObject(call.getData().toString())))); call.resolve(r); }); }
    @PluginMethod public void pause(PluginCall call) { run(call, () -> { engine().pause(call.getString("id", "")); call.resolve(); }); }
    @PluginMethod public void resume(PluginCall call) { run(call, () -> { engine().resume(call.getString("id", "")); call.resolve(); }); }
    @PluginMethod public void remove(PluginCall call) { run(call, () -> { engine().remove(call.getString("id", ""), Boolean.TRUE.equals(call.getBoolean("deleteFiles", false))); call.resolve(); }); }
    @PluginMethod public void setFiles(PluginCall call) { run(call, () -> { JSArray a = call.getArray("priorities"); int[] p = new int[a.length()]; for (int i = 0; i < a.length(); i++) p[i] = a.getInt(i); engine().setFiles(call.getString("id", ""), p); call.resolve(); }); }
    @PluginMethod public void setSequential(PluginCall call) { run(call, () -> { engine().setSequential(call.getString("id", ""), Boolean.TRUE.equals(call.getBoolean("on", true))); call.resolve(); }); }
    @PluginMethod public void setLimits(PluginCall call) { run(call, () -> { engine().setLimits(call.getLong("down", 0L), call.getLong("up", 0L)); call.resolve(); }); }
    @PluginMethod public void configure(PluginCall call) { run(call, () -> { engine().configure(new JSONObject(call.getData().toString())); call.resolve(); }); }
    @PluginMethod public void torrentInfo(PluginCall call) { run(call, () -> { JSObject r = new JSObject(); r.put("info", obj(engine().torrentInfo(new JSONObject(call.getObject("source").toString())))); call.resolve(r); }); }
    @PluginMethod public void streamUrl(PluginCall call) { run(call, () -> { JSObject r = new JSObject(); r.put("url", engine().stream().url(call.getString("id", ""), call.getInt("fileIndex", 0))); call.resolve(r); }); }
    @PluginMethod public void defaultDir(PluginCall call) { JSObject r = new JSObject(); r.put("dir", engine().defaultDir().getAbsolutePath()); call.resolve(r); }

    /** Opens a finished file with the system (fileIndex -1: its folder, as far as Android lets a folder be opened). */
    @PluginMethod public void open(PluginCall call) {
        run(call, () -> {
            KtEngine.Task x = engine().task(call.getString("id", "")); if (x == null) throw new Exception("notFound");
            int idx = call.getInt("fileIndex", 0);
            File f = engine().fileOf(x, Math.max(0, idx));
            if (f == null || !f.exists()) { File d = new File(x.dir); f = d.exists() ? d : null; if (f == null) throw new Exception("notFound"); }
            if (idx < 0 || f.isDirectory()) { File d = f.isDirectory() ? f : f.getParentFile(); Intent i = new Intent(Intent.ACTION_VIEW); i.setDataAndType(Uri.parse(d.toURI().toString()), "resource/folder"); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); try { getContext().startActivity(i); } catch (Exception e) { Intent g = new Intent(Intent.ACTION_GET_CONTENT); g.setType("*/*"); g.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(Intent.createChooser(g, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } call.resolve(); return; }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_VIEW); i.setDataAndType(uri, mimeOf(f.getName())); i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i); call.resolve();
        });
    }
    static String mimeOf(String name) {
        String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase() : "";
        String m = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        if (m == null) m = KtStream.mimeOf(name);
        return m;
    }

    /* ---------- a folder of the user's choosing ---------- */
    @PluginMethod public void pickDir(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, i, "dirPicked");
    }
    @ActivityCallback private void dirPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData(); Uri tree = data != null ? data.getData() : null;
        if (tree == null) { call.reject("cancelled"); return; }
        try { getContext().getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION); } catch (Exception ignored) {}
        // (libtorrent and the downloader write to paths: a tree on the primary storage is turned into its path;
        // another storage keeps the URI, and the engine downloads into the app's folder — the limitation is said
        // in the docs.)
        String path = pathOfTree(tree);
        JSObject r = new JSObject(); r.put("dir", path != null ? path : tree.toString()); call.resolve(r);
    }
    private static String pathOfTree(Uri tree) {
        try { String id = android.provider.DocumentsContract.getTreeDocumentId(tree); String[] parts = id.split(":", 2); if ("primary".equalsIgnoreCase(parts[0])) return new File(android.os.Environment.getExternalStorageDirectory(), parts.length > 1 ? parts[1] : "").getAbsolutePath(); } catch (Exception ignored) {}
        return null;
    }

    /* ---------- the device, other apps ---------- */
    @PluginMethod public void deviceInfo(PluginCall call) {
        JSObject r = new JSObject(); JSArray abis = new JSArray(); for (String a : Build.SUPPORTED_ABIS) abis.put(a); r.put("abis", abis); r.put("sdk", Build.VERSION.SDK_INT); call.resolve(r);
    }
    @PluginMethod public void isInstalled(PluginCall call) {
        JSObject r = new JSObject(); try { getContext().getPackageManager().getPackageInfo(call.getString("pkg", ""), 0); r.put("installed", true); } catch (PackageManager.NameNotFoundException e) { r.put("installed", false); } call.resolve(r);
    }
    @PluginMethod public void launch(PluginCall call) {
        Intent i = getContext().getPackageManager().getLaunchIntentForPackage(call.getString("pkg", ""));
        if (i == null) { call.reject("notInstalled"); return; }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(i); call.resolve();
    }
    @PluginMethod public void openUrl(PluginCall call) {
        try { Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(call.getString("url", ""))); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(i); call.resolve(); } catch (Exception e) { call.reject(e.getMessage()); }
    }

    /* ---------- a file with its progress (an APK), and the installer ---------- */
    @PluginMethod public void downloadFile(PluginCall call) {
        final String urlStr = call.getString("url", ""); final String name = call.getString("name", "download.bin"); final String id = call.getString("id", "");
        final int connections = Math.max(1, Math.min(16, call.getInt("connections", 8)));
        final AtomicBoolean cancelled = new AtomicBoolean(false); if (!id.isEmpty()) downloads.put(id, cancelled);
        bg.execute(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "kt-files"); dir.mkdirs();
                final File done0 = new File(dir, name); File out = new File(dir, name + ".part");
                final AtomicLong got = new AtomicLong(); final KrDownloader.Result info = new KrDownloader.Result();
                Runnable report = new Runnable() { long lastT = System.currentTimeMillis(), lastGot = 0; double speed = 0; public synchronized void run() { long now = System.currentTimeMillis(); if (now - lastT < 300) return; long g = got.get(); double inst = (g - lastGot) / ((now - lastT) / 1000.0); speed = speed == 0 ? inst : speed * 0.6 + 0.4 * inst; lastT = now; lastGot = g; JSObject ev = new JSObject(); ev.put("id", id); ev.put("got", g); ev.put("total", info.total); ev.put("speed", speed); ev.put("pct", info.total > 0 ? (int) (g * 100 / info.total) : 0); ev.put("connections", info.connections); notifyListeners("downloadProgress", ev); } };
                KrDownloader.Result res = KrDownloader.fetch(new URL(urlStr), out, connections, u -> { HttpURLConnection c = (HttpURLConnection) u.openConnection(); c.setConnectTimeout(20000); c.setReadTimeout(60000); c.setInstanceFollowRedirects(false); c.setRequestProperty("User-Agent", "KurokawaTools/0.1"); return c; }, cancelled, got, info, report);
                if (cancelled.get()) { out.delete(); call.reject("cancelled"); return; }
                if (res.total > 0 && out.length() != res.total) { out.delete(); call.reject("Download failed: incomplete"); return; }
                done0.delete(); if (!out.renameTo(done0)) { out.delete(); call.reject("Download failed: cannot keep the file"); return; }
                JSObject fin = new JSObject(); fin.put("id", id); fin.put("got", got.get()); fin.put("total", got.get()); fin.put("pct", 100); notifyListeners("downloadProgress", fin);
                JSObject r = new JSObject(); r.put("path", "file://" + done0.getAbsolutePath()); r.put("size", done0.length()); call.resolve(r);
            } catch (Exception e) { call.reject("Download failed: " + e.getMessage(), e); }
            finally { if (!id.isEmpty()) downloads.remove(id); }
        });
    }
    @PluginMethod public void cancelDownload(PluginCall call) { AtomicBoolean c = downloads.get(call.getString("id", "")); if (c != null) c.set(true); call.resolve(); }
    @PluginMethod public void installApk(PluginCall call) {
        String path = call.getString("path", ""); if (path.startsWith("file://")) path = path.substring(7);
        try {
            if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                // (The system's page to allow this app to install others; the page says so and asks again after.)
                Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName())); s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(s);
                call.reject("permission"); return;
            }
            File apk = new File(path); if (!apk.exists()) { call.reject("APK not found"); return; }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_INSTALL_PACKAGE); intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true); intent.putExtra(Intent.EXTRA_INSTALLER_PACKAGE_NAME, getContext().getPackageName()); intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(intent); call.resolve();
        } catch (Exception e) { call.reject("Cannot start installer: " + e.getMessage(), e); }
    }
    @PluginMethod public void canInstall(PluginCall call) { JSObject r = new JSObject(); r.put("granted", Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls()); call.resolve(r); }

    @SuppressWarnings("unused") private static Iterator<String> keys(JSONObject o) { return o.keys(); }
    @SuppressWarnings("unused") static DocumentFile tree(android.content.Context c, Uri u) { return DocumentFile.fromTreeUri(c, u); }
}
