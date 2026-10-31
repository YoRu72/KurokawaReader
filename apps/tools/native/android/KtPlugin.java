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
    /** A sign-in page shown in the app, resolved with the address it ends on (null when closed first). */
    @PluginMethod public void captureUrl(PluginCall call) {
        Intent i = new Intent(getContext(), KtAuthActivity.class);
        i.putExtra(KtAuthActivity.EXTRA_URL, call.getString("url", "")); i.putExtra(KtAuthActivity.EXTRA_MARKER, call.getString("marker", "")); i.putExtra(KtAuthActivity.EXTRA_TITLE, call.getString("title", ""));
        startActivityForResult(call, i, "urlCaptured");
    }
    @ActivityCallback private void urlCaptured(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject o = new JSObject(); Intent d = result.getData();
        o.put("url", result.getResultCode() == android.app.Activity.RESULT_OK && d != null ? d.getStringExtra(KtAuthActivity.RESULT_URL) : null);
        call.resolve(o);
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
    /** What an APK or a split bundle installs (name, icon, package, version, the version here now). */
    @PluginMethod public void apkInfo(PluginCall call) { final File f = fileOf(call.getString("path", "")); bg.execute(() -> { try { call.resolve(new JSObject(KtApk.info(getContext(), f).toString())); } catch (Exception e) { call.reject(String.valueOf(e.getMessage()), e); } }); }
    /** Installs through a session (a bundle's splits streamed from it, no extracting): progress and the system's
     *  answer come as `apkInstall` events. */
    @PluginMethod public void apkInstall(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName())); s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(s);
            call.reject("permission"); return;
        }
        final String id = call.getString("id", ""); final File f = fileOf(call.getString("path", "")); final boolean del = Boolean.TRUE.equals(call.getBoolean("deleteAfter", false));
        bg.execute(() -> { try { KtApk.install(getContext(), id, f, del, (ev) -> { try { notifyListeners("apkInstall", new JSObject(ev.toString())); } catch (Exception ignored) {} }); call.resolve(); } catch (Exception e) { call.reject(String.valueOf(e.getMessage()), e); } });
    }
    @PluginMethod public void launchApp(PluginCall call) { Intent i = getContext().getPackageManager().getLaunchIntentForPackage(call.getString("pkg", "")); if (i == null) { call.reject("notLaunchable"); return; } i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(i); call.resolve(); }
    @PluginMethod public void canInstall(PluginCall call) { JSObject r = new JSObject(); r.put("granted", Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls()); call.resolve(r); }

    /* ---------- archives: what is inside, taking it out (in place when asked), making one ---------- */
    private final java.util.Map<String, AtomicBoolean> archiveJobs = new java.util.concurrent.ConcurrentHashMap<>();
    private static File fileOf(String p) { if (p.startsWith("file://")) p = Uri.parse(p).getPath(); return new File(p); }
    @PluginMethod public void archiveList(PluginCall call) {
        bg.execute(() -> { try { File f = fileOf(call.getString("path", "")); JSObject r = new JSObject(new org.json.JSONObject(KtArchive.list(f, call.getString("password", null)).toString()).toString()); r.put("resumable", KtArchive.hasJournal(f)); call.resolve(r); } catch (Exception e) { call.reject(e.getMessage() == null ? e.toString() : e.getMessage(), e); } });
    }
    @PluginMethod public void archiveExtract(PluginCall call) {
        final String id = call.getString("id", ""); final AtomicBoolean stop = new AtomicBoolean(false); if (!id.isEmpty()) archiveJobs.put(id, stop);
        final File f = fileOf(call.getString("path", "")); final File dest = fileOf(call.getString("dest", f.getParent()));
        final KtArchive.Options o = new KtArchive.Options(); o.inPlace = Boolean.TRUE.equals(call.getBoolean("inPlace", false)); o.deleteAfter = Boolean.TRUE.equals(call.getBoolean("deleteAfter", false)); o.replace = call.getString("replace", "replace"); o.password = call.getString("password", null);
        o.verifyFirst = Boolean.TRUE.equals(call.getBoolean("verifyFirst", false)); Double kf = call.getDouble("keepFree"); if (kf != null && kf >= 0) o.keepFree = kf.longValue();
        bg.execute(() -> {
            final long[] last = { 0 };
            try {
                int n = KtArchive.extract(f, dest, o, new KtArchive.Progress() {
                    public void on(long done, long total, String file) { long now = System.currentTimeMillis(); if (now - last[0] < 250 && done < total) return; last[0] = now; JSObject ev = new JSObject(); ev.put("id", id); ev.put("done", done); ev.put("total", total); ev.put("file", file); notifyListeners("archiveProgress", ev); }
                    public boolean stopped() { return stop.get(); }
                });
                JSObject r = new JSObject(); r.put("files", n); r.put("dest", dest.getAbsolutePath()); call.resolve(r);
            } catch (Exception e) { call.reject(e.getMessage() == null ? e.toString() : e.getMessage(), e); }
            finally { if (!id.isEmpty()) archiveJobs.remove(id); }
        });
    }
    /** HatchZip's other verbs: test (read every file, write nothing), restore (give up an extraction in place),
     *  the free space of a folder, and which of an archive's files already exist where it would go. */
    private KtArchive.Progress progressFor(String id, AtomicBoolean stop) { final long[] last = { 0 }; return new KtArchive.Progress() { public void on(long done, long total, String file) { long now = System.currentTimeMillis(); if (now - last[0] < 250 && done < total) return; last[0] = now; JSObject ev = new JSObject(); ev.put("id", id); ev.put("done", done); ev.put("total", total); ev.put("file", file); notifyListeners("archiveProgress", ev); } public boolean stopped() { return stop.get(); } }; }
    @PluginMethod public void archiveTest(PluginCall call) {
        final String id = call.getString("id", ""); final AtomicBoolean stop = new AtomicBoolean(false); if (!id.isEmpty()) archiveJobs.put(id, stop);
        final File f = fileOf(call.getString("path", ""));
        bg.execute(() -> { try { call.resolve(new JSObject(KtArchive.test(f, call.getString("password", null), progressFor(id, stop)).toString())); } catch (Exception e) { call.reject(String.valueOf(e.getMessage()), e); } finally { archiveJobs.remove(id); } });
    }
    @PluginMethod public void archiveRestore(PluginCall call) { final File f = fileOf(call.getString("path", "")); bg.execute(() -> { try { JSObject r = new JSObject(); r.put("left", KtArchive.restore(f)); call.resolve(r); } catch (Exception e) { call.reject(String.valueOf(e.getMessage()), e); } }); }
    @PluginMethod public void archiveFree(PluginCall call) { File d = fileOf(call.getString("dir", "")); while (d != null && !d.exists()) d = d.getParentFile(); JSObject r = new JSObject(); r.put("free", d == null ? -1 : d.getUsableSpace()); call.resolve(r); }
    @PluginMethod public void archiveExisting(PluginCall call) {
        final File dest = fileOf(call.getString("dest", "")); JSArray names = call.getArray("names", new JSArray());
        bg.execute(() -> { JSArray out = new JSArray(); try { for (int i = 0; i < names.length(); i++) { String n = names.getString(i); if (new File(dest, n).isFile()) out.put(n); } } catch (Exception ignored) {} JSObject r = new JSObject(); r.put("existing", out); call.resolve(r); });
    }
    @PluginMethod public void archiveCancel(PluginCall call) { AtomicBoolean c = archiveJobs.get(call.getString("id", "")); if (c != null) c.set(true); call.resolve(); }
    @PluginMethod public void archiveCreate(PluginCall call) {
        final String id = call.getString("id", ""); final AtomicBoolean stop = new AtomicBoolean(false); if (!id.isEmpty()) archiveJobs.put(id, stop);
        final File out = fileOf(call.getString("out", "")); final java.util.List<File> ins = new java.util.ArrayList<>();
        try { JSArray a = call.getArray("inputs"); for (int i = 0; i < a.length(); i++) ins.add(fileOf(a.getString(i))); } catch (Exception e) { call.reject("inputs"); return; }
        bg.execute(() -> {
            final long[] last = { 0 };
            try { int n = KtArchive.createZip(out, ins, new KtArchive.Progress() { public void on(long done, long total, String file) { long now = System.currentTimeMillis(); if (now - last[0] < 250 && done < total) return; last[0] = now; JSObject ev = new JSObject(); ev.put("id", id); ev.put("done", done); ev.put("total", total); ev.put("file", file); notifyListeners("archiveProgress", ev); } public boolean stopped() { return stop.get(); } });
                JSObject r = new JSObject(); r.put("files", n); r.put("path", out.getAbsolutePath()); r.put("size", out.length()); call.resolve(r);
            } catch (Exception e) { call.reject(e.getMessage() == null ? e.toString() : e.getMessage(), e); }
            finally { if (!id.isEmpty()) archiveJobs.remove(id); }
        });
    }
    /** A file picked by the user (an archive to open), copied into the app's files when it is a content URI. */
    @PluginMethod public void pickFile(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT); i.addCategory(Intent.CATEGORY_OPENABLE); i.setType("*/*");
        if (Boolean.TRUE.equals(call.getBoolean("multiple", false))) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(call, i, "filePicked");
    }
    @ActivityCallback private void filePicked(PluginCall call, ActivityResult result) {
        if (call == null) return; Intent data = result.getData(); if (data == null) { call.reject("cancelled"); return; }
        final java.util.List<Uri> uris = new java.util.ArrayList<>();
        if (data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri()); else if (data.getData() != null) uris.add(data.getData());
        if (uris.isEmpty()) { call.reject("cancelled"); return; }
        bg.execute(() -> {
            try {
                JSArray paths = new JSArray();
                for (Uri u : uris) {
                    String name = "file"; try (android.database.Cursor c = getContext().getContentResolver().query(u, null, null, null, null)) { if (c != null && c.moveToFirst()) { int ix = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME); if (ix >= 0) name = c.getString(ix); } }
                    File dir = new File(engine().defaultDir(), "Archives"); dir.mkdirs(); File out = new File(dir, name);
                    // (A file already in the app's folders is used where it is; anything else is copied in.)
                    try (java.io.InputStream in = getContext().getContentResolver().openInputStream(u); java.io.OutputStream os = new java.io.FileOutputStream(out)) { byte[] b = new byte[1 << 16]; int n; while ((n = in.read(b)) > 0) os.write(b, 0, n); }
                    paths.put(out.getAbsolutePath());
                }
                JSObject r = new JSObject(); r.put("paths", paths); call.resolve(r);
            } catch (Exception e) { call.reject(e.getMessage() == null ? e.toString() : e.getMessage(), e); }
        });
    }

    /* ---------- the Files add-on: folders of the device ---------- */
    @PluginMethod public void listDir(PluginCall call) {
        bg.execute(() -> {
            try {
                File d = fileOf(call.getString("path", "")); File[] kids = d.listFiles(); JSArray out = new JSArray();
                if (kids != null) for (File k : kids) { JSObject o = new JSObject(); o.put("name", k.getName()); o.put("path", k.getAbsolutePath()); o.put("dir", k.isDirectory()); o.put("size", k.isFile() ? k.length() : 0); o.put("mtime", k.lastModified()); out.put(o); }
                JSObject r = new JSObject(); r.put("entries", out); r.put("exists", d.isDirectory()); call.resolve(r);
            } catch (Exception e) { call.reject(e.getMessage()); }
        });
    }
    @PluginMethod public void deletePath(PluginCall call) {
        bg.execute(() -> { try { File f = fileOf(call.getString("path", "")); boolean ok = deleteTree(f); JSObject r = new JSObject(); r.put("ok", ok); call.resolve(r); } catch (Exception e) { call.reject(e.getMessage()); } });
    }
    private static boolean deleteTree(File f) { if (f.isDirectory()) { File[] k = f.listFiles(); if (k != null) for (File c : k) deleteTree(c); } return f.delete(); }
    @PluginMethod public void roots(PluginCall call) { JSArray a = new JSArray(); a.put(engine().defaultDir().getAbsolutePath()); for (File f : getContext().getExternalFilesDirs(null)) if (f != null) a.put(f.getAbsolutePath()); JSObject r = new JSObject(); r.put("roots", a); call.resolve(r); }

    /* ---------- the player: local files over the stream server, files beside a video, ffmpeg for clips ---------- */
    @PluginMethod public void localUrl(PluginCall call) { run(call, () -> { JSObject r = new JSObject(); r.put("url", engine().stream().fileUrl(call.getString("path", ""))); call.resolve(r); }); }
    @PluginMethod public void siblings(PluginCall call) {
        File f = fileOf(call.getString("path", "")); JSArray out = new JSArray(); File dir = f.getParentFile(); String base = f.getName().replaceAll("\\.[^.]+$", "").toLowerCase();
        File[] kids = dir != null ? dir.listFiles() : null; if (kids != null) for (File k : kids) if (k.isFile() && !k.equals(f) && k.getName().toLowerCase().startsWith(base)) out.put(k.getAbsolutePath());
        JSObject r = new JSObject(); r.put("paths", out); call.resolve(r);
    }
    @PluginMethod public void clipsDir(PluginCall call) { File d = new File(engine().defaultDir(), "Clips"); d.mkdirs(); JSObject r = new JSObject(); r.put("dir", d.getAbsolutePath()); call.resolve(r); }
    @PluginMethod public void writeTemp(PluginCall call) {
        try { File dir = new File(getContext().getCacheDir(), "clip"); new File(dir, "fonts").mkdirs(); File f = new File(dir, call.getString("name", "clip.txt").replaceAll("[\\\\/]", "_")); try (java.io.Writer w = new java.io.OutputStreamWriter(new java.io.FileOutputStream(f), java.nio.charset.StandardCharsets.UTF_8)) { w.write(call.getString("text", "")); } JSObject r = new JSObject(); r.put("path", f.getAbsolutePath()); call.resolve(r); }
        catch (Exception e) { call.reject(e.getMessage()); }
    }
    private final java.util.Map<String, Long> ffJobs = new java.util.concurrent.ConcurrentHashMap<>();
    @PluginMethod public void ffmpeg(PluginCall call) {
        final String id = call.getString("id", ""); final java.util.List<String> args = new java.util.ArrayList<>();
        try { JSArray a = call.getArray("args"); for (int i = 0; i < a.length(); i++) args.add(a.getString(i)); } catch (Exception e) { call.reject("args"); return; }
        final long[] last = { 0 };
        com.arthenica.ffmpegkit.FFmpegSession s = com.arthenica.ffmpegkit.FFmpegKit.executeWithArgumentsAsync(args.toArray(new String[0]), session -> {
            ffJobs.remove(id); JSObject r = new JSObject(); r.put("code", session.getReturnCode() != null ? session.getReturnCode().getValue() : 1); String log = session.getAllLogsAsString(); r.put("log", log.length() > 20000 ? log.substring(log.length() - 20000) : log); call.resolve(r);
        }, log -> {}, st -> {
            long now = System.currentTimeMillis(); if (now - last[0] < 300) return; last[0] = now;
            JSObject ev = new JSObject(); ev.put("id", id); ev.put("time", st.getTime() / 1000.0); ev.put("size", st.getSize()); ev.put("speed", st.getSpeed()); notifyListeners("ffmpegProgress", ev);
        });
        ffJobs.put(id, s.getSessionId());
    }
    /* ---------- yt-dlp (the video add-on): what a page offers, its version, and updating it ---------- */
    @PluginMethod public void videoInfo(PluginCall call) {
        final String url = call.getString("url", ""); final boolean playlist = Boolean.TRUE.equals(call.getBoolean("playlist", false));
        bg.execute(() -> { try { JSObject r = new JSObject(); r.put("json", KtVideo.info(getContext(), url, playlist)); call.resolve(r); } catch (Throwable e) { call.reject(KtVideo.lastError(e.getMessage())); } });
    }
    @PluginMethod public void videoVersion(PluginCall call) { bg.execute(() -> { JSObject r = new JSObject(); String v = KtVideo.version(getContext()); r.put("version", v == null ? JSObject.NULL : v); r.put("ready", v != null); call.resolve(r); }); }
    @PluginMethod public void videoUpdate(PluginCall call) { bg.execute(() -> { KtVideo.update(getContext()); JSObject r = new JSObject(); String v = KtVideo.version(getContext()); r.put("version", v == null ? JSObject.NULL : v); call.resolve(r); }); }
    @PluginMethod public void ffmpegCancel(PluginCall call) { Long sid = ffJobs.get(call.getString("id", "")); if (sid != null) com.arthenica.ffmpegkit.FFmpegKit.cancel(sid); call.resolve(); }
    @PluginMethod public void ffprobe(PluginCall call) {
        bg.execute(() -> { try { com.arthenica.ffmpegkit.MediaInformationSession s = com.arthenica.ffmpegkit.FFprobeKit.getMediaInformation(call.getString("path", "")); com.arthenica.ffmpegkit.MediaInformation mi = s.getMediaInformation(); JSObject r = new JSObject(); r.put("json", mi != null && mi.getAllProperties() != null ? mi.getAllProperties().toString() : "{}"); call.resolve(r); } catch (Exception e) { call.reject(e.getMessage()); } });
    }

    /* ---------- requests for the add-ons (past the page's CORS), with the WebView's identity and cookies ---------- */
    @PluginMethod public void httpRequest(PluginCall call) {
        final String urlStr = call.getString("url", ""); final String method = call.getString("method", "GET"); final String body = call.getString("body", null);
        final JSObject headers = call.getObject("headers", new JSObject()); final boolean binary = Boolean.TRUE.equals(call.getBoolean("binary", false));
        bg.execute(() -> {
            try {
                HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
                conn.setInstanceFollowRedirects(true); conn.setRequestMethod(method); conn.setConnectTimeout(20000); conn.setReadTimeout(60000);
                boolean hasUa = false; Iterator<String> it = headers.keys();
                while (it.hasNext()) { String k = it.next(); if (k.equalsIgnoreCase("accept-encoding")) continue; conn.setRequestProperty(k, headers.getString(k)); if (k.equalsIgnoreCase("user-agent")) hasUa = true; }
                if (!hasUa) { try { conn.setRequestProperty("User-Agent", android.webkit.WebSettings.getDefaultUserAgent(getContext())); } catch (Exception ignored) {} }
                try { String ck = android.webkit.CookieManager.getInstance().getCookie(urlStr); if (ck != null && !ck.isEmpty() && !headers.has("cookie") && !headers.has("Cookie")) conn.setRequestProperty("Cookie", ck); } catch (Exception ignored) {}
                if (body != null) { conn.setDoOutput(true); try (java.io.OutputStream os = conn.getOutputStream()) { os.write(Boolean.TRUE.equals(call.getBoolean("bodyBase64", false)) ? android.util.Base64.decode(body, android.util.Base64.DEFAULT) : body.getBytes(java.nio.charset.StandardCharsets.UTF_8)); } }
                int code = conn.getResponseCode();
                try { java.util.List<String> set = conn.getHeaderFields().get("Set-Cookie"); if (set != null) { android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance(); for (String c : set) cm.setCookie(urlStr, c); } } catch (Exception ignored) {}
                java.io.InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                if (in != null) { byte[] buf = new byte[1 << 16]; int n; while ((n = in.read(buf)) > 0) { bos.write(buf, 0, n); if (bos.size() > 50_000_000) break; } }
                byte[] bytes = bos.toByteArray();
                JSObject ret = new JSObject(); ret.put("status", code); ret.put("url", conn.getURL().toString());
                if (binary) ret.put("body", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)); else ret.put("body", new String(bytes, charsetOf(conn.getContentType(), bytes)));
                JSObject hs = new JSObject(); for (java.util.Map.Entry<String, java.util.List<String>> e : conn.getHeaderFields().entrySet()) if (e.getKey() != null && !e.getValue().isEmpty()) hs.put(e.getKey().toLowerCase(), e.getValue().get(0));
                ret.put("headers", hs); call.resolve(ret);
            } catch (Exception e) { call.reject(e.getMessage() == null ? e.toString() : e.getMessage(), e); }
        });
    }
    private static java.nio.charset.Charset charsetOf(String contentType, byte[] head) {
        try { if (contentType != null) { java.util.regex.Matcher m = java.util.regex.Pattern.compile("charset=\"?([\\w-]+)", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(contentType); if (m.find()) return java.nio.charset.Charset.forName(m.group(1)); } } catch (Exception ignored) {}
        try { String s = new String(head, 0, Math.min(head.length, 2048), java.nio.charset.StandardCharsets.ISO_8859_1); java.util.regex.Matcher m = java.util.regex.Pattern.compile("<meta[^>]+charset=[\"']?([\\w-]+)", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(s); if (m.find()) return java.nio.charset.Charset.forName(m.group(1)); } catch (Exception ignored) {}
        return java.nio.charset.StandardCharsets.UTF_8;
    }

    @SuppressWarnings("unused") private static Iterator<String> keys(JSONObject o) { return o.keys(); }
    @SuppressWarnings("unused") static DocumentFile tree(android.content.Context c, Uri u) { return DocumentFile.fromTreeUri(c, u); }
}
