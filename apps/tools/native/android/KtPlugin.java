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
            // (Not sent to the page while the app is in the background: every second the whole list went to a web view that
            // was not drawing, piling up on the main thread until Android found the app not responding and closed it —
            // the downloads with it. Sent once when the app comes back.)
            if (visible) { JSObject ev = new JSObject(); try { ev.put("tasks", new JSArray(tasks.toString())); } catch (Exception ignored) {} notifyListeners("tasksChanged", ev); } else behind = true;
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
    private volatile boolean visible = true, behind = false;
    @Override protected void handleOnPause() { super.handleOnPause(); visible = false; }
    @Override protected void handleOnResume() { super.handleOnResume(); visible = true; if (behind) { behind = false; JSObject ev = new JSObject(); try { ev.put("tasks", new JSArray(lastTasks.toString())); } catch (Exception ignored) {} notifyListeners("tasksChanged", ev); } }
    private static KtPlugin self;
    /** The engine when the app made it (for the notification's and the tile's buttons). */
    static KtEngine engineIfAny() { KtPlugin p = self; return p == null ? null : p.engine; }
    /** From the app's browser: a link to add, or the links of a page to pick from (event «browser»). */
    static void browserEvent(JSONObject o) { KtPlugin p = self; if (p == null) return; try { p.notifyListeners("browser", JSObject.fromJSONObject(o), true); } catch (Exception ignored) {} }
    @PluginMethod public void browse(PluginCall call) {
        Intent i = new Intent(getContext(), KtBrowserActivity.class); i.putExtra(KtBrowserActivity.EXTRA_URL, call.getString("url", "")); JSObject rp = call.getObject("replay", null); if (rp != null) i.putExtra("replay", rp.toString()); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i); call.resolve();
    }
    @Override public void load() { wireDoh(); self = this; try { KrDoh.provider = getContext().getSharedPreferences("kt", android.content.Context.MODE_PRIVATE).getString("doh", "off"); } catch (Exception ignored) {} bg.execute(this::engine); }

    private interface Work { void run() throws Exception; }
    private void run(PluginCall call, Work w) { bg.execute(() -> { try { w.run(); } catch (Throwable e) { call.reject(e.getMessage() == null ? e.toString() : e.getMessage(), e instanceof Exception ? (Exception) e : new Exception(e)); } }); }
    private static JSObject obj(JSONObject o) { try { return JSObject.fromJSONObject(o); } catch (Exception e) { return new JSObject(); } }

    @PluginMethod public void pauseAll(PluginCall call) { run(call, () -> { engine().pauseAll(); call.resolve(); }); }
    @PluginMethod public void resumeAll(PluginCall call) { run(call, () -> { engine().resumeAll(); call.resolve(); }); }
    /** A finished file handed to Android's share sheet (another app, a chat, Nearby Share). */
    /** Files shared over Wi-Fi: a page another device opens; its address (null when the phone has no network). */
    @PluginMethod public void shareWifi(PluginCall call) {
        try {
            java.util.List<String> paths = new java.util.ArrayList<>(), names = new java.util.ArrayList<>();
            JSArray a = call.getArray("paths"); for (int i = 0; i < a.length(); i++) paths.add(a.getString(i));
            JSArray b = call.getArray("names"); if (b != null) for (int i = 0; i < b.length(); i++) names.add(b.getString(i));
            String url = KtShare.get().start(paths, names); JSObject r = new JSObject(); r.put("url", url); r.put("files", KtShare.get().fileCount()); call.resolve(r);
        } catch (Exception e) { call.reject(e.getMessage()); }
    }
    /** The player closed on something another app asked to play: its position handed back (MainActivity). */
    @PluginMethod public void playerDone(PluginCall call) { android.app.Activity a = getActivity(); if (a instanceof MainActivity) ((MainActivity) a).playerDone(call.getInt("position", 0), call.getInt("duration", 0), call.getString("endBy", "user")); call.resolve(); }
    @PluginMethod public void shareWifiStop(PluginCall call) { KtShare.get().stop(); call.resolve(); }
    @PluginMethod public void shareWifiStatus(PluginCall call) { KtShare s = KtShare.get(); JSObject r = new JSObject(); r.put("running", s.running()); r.put("url", s.url()); r.put("sent", s.sentBytes()); r.put("hits", s.hitCount()); call.resolve(r); }
    @PluginMethod public void shareFile(PluginCall call) {
        try {
            File f = new File(call.getString("path", "")); if (!f.isFile()) { call.reject("notFound"); return; }
            Uri u = androidx.core.content.FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_SEND).setType(mimeOf(f.getName()) == null ? "*/*" : mimeOf(f.getName())).putExtra(Intent.EXTRA_STREAM, u).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent ch = Intent.createChooser(i, call.getString("title", f.getName())); ch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(ch); call.resolve();
        } catch (Exception e) { call.reject(e.getMessage()); }
    }
    @PluginMethod public void list(PluginCall call) { run(call, () -> { JSObject r = new JSObject(); r.put("tasks", new JSArray(engine().list().toString())); call.resolve(r); }); }
    /** Android 13+: notifications are off for an app until it asks — so the downloads' progress never showed. Asked
     *  once, when the first download is added (the system's own dialog). */
    private static volatile boolean notifyAsked = false;
    private void askNotify() {
        if (Build.VERSION.SDK_INT < 33 || notifyAsked) return; notifyAsked = true;
        try { if (getContext().checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED) return; android.app.Activity a = getActivity(); if (a != null) a.runOnUiThread(() -> { try { a.requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 4712); } catch (Throwable ignored) {} }); } catch (Throwable ignored) {}
    }
    /* ---------- the screen translator (Translate on screen add-on) ---------- */
    private static boolean a11yOn(android.content.Context c) {
        if (KtScreenA11y.self != null) return true;
        try { String on = android.provider.Settings.Secure.getString(c.getContentResolver(), android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES); return on != null && on.contains(c.getPackageName() + "/") && on.contains("KtScreenA11y"); } catch (Throwable e) { return false; }
    }
    /** What the floating translator may do now: appear on top, read the screen's text, a picture of it; running or not. */
    @PluginMethod public void screenStatus(PluginCall call) {
        android.content.Context c = getContext(); JSObject r = new JSObject();
        r.put("overlay", android.provider.Settings.canDrawOverlays(c)); r.put("a11y", a11yOn(c)); r.put("a11yLive", KtScreenA11y.self != null); r.put("running", KtScreenService.self != null); r.put("capture", KtScreenCapture.ready());
        r.put("notify", androidx.core.app.NotificationManagerCompat.from(c).areNotificationsEnabled());
        try { android.os.PowerManager pm = (android.os.PowerManager) c.getSystemService(android.content.Context.POWER_SERVICE); r.put("battery", pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName())); } catch (Throwable e) { r.put("battery", false); }
        r.put("tile", Build.VERSION.SDK_INT >= 33); r.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(r);
    }
    /** The system's page for one permission: appear on top, accessibility, battery, notifications; or the tile added (Android 13+). */
    @PluginMethod public void screenPermission(PluginCall call) {
        android.content.Context c = getContext(); String what = call.getString("what", "overlay"); android.content.Intent i = null;
        switch (what) {
            case "overlay": i = new android.content.Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION, android.net.Uri.parse("package:" + c.getPackageName())); break;
            case "a11y": i = new android.content.Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS); break;
            case "battery": i = new android.content.Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS); break;
            case "app": i = new android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:" + c.getPackageName())); break;
            case "tile":
                if (Build.VERSION.SDK_INT >= 33) { try { android.app.StatusBarManager sb = c.getSystemService(android.app.StatusBarManager.class); sb.requestAddTileService(new android.content.ComponentName(c, KtScreenTile.class), c.getString(c.getResources().getIdentifier("kt_screen_tile", "string", c.getPackageName())), android.graphics.drawable.Icon.createWithResource(c, android.R.drawable.ic_menu_view), c.getMainExecutor(), (res) -> {}); } catch (Throwable ignored) {} }
                call.resolve(); return;
        }
        try { if (i != null) { i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK); c.startActivity(i); } } catch (Throwable e) { try { c.startActivity(new android.content.Intent(android.provider.Settings.ACTION_SETTINGS).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Throwable ignored) {} }
        call.resolve();
    }
    /** The translator's settings kept (the bubble reads them; a running one is told). */
    @PluginMethod public void screenConfig(PluginCall call) {
        JSObject cfg = call.getObject("config", new JSObject());
        getContext().getSharedPreferences(KtScreenService.PREFS, android.content.Context.MODE_PRIVATE).edit().putString("config", cfg.toString()).apply();
        if (Boolean.TRUE.equals(call.getBoolean("clearFixed", false))) getContext().getSharedPreferences(KtScreenService.PREFS, android.content.Context.MODE_PRIVATE).edit().remove("fl").remove("ft").remove("fr").remove("fb").apply();
        KtTranslate.forget();
        if (KtScreenService.self != null) try { getContext().startService(new android.content.Intent(getContext(), KtScreenService.class).setAction(KtScreenService.ACT_CONFIG)); } catch (Throwable ignored) {}
        call.resolve();
    }
    /** «Translate screen» as an app of its own (the app drawer, the phone's sidebar): shown or hidden; `pin`: also
     *  offered for the home screen (Android's own dialog). */
    @PluginMethod public void screenShortcut(PluginCall call) {
        android.content.Context c = getContext(); android.content.ComponentName cn = new android.content.ComponentName(c, KtScreenLaunch.class); PackageManager pm = c.getPackageManager();
        Boolean show = call.getBoolean("show", null);
        if (show != null) pm.setComponentEnabledSetting(cn, show ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED : PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP);
        boolean pinned = false;
        if (Boolean.TRUE.equals(call.getBoolean("pin", false))) {
            try {
                androidx.core.content.pm.ShortcutInfoCompat sc = new androidx.core.content.pm.ShortcutInfoCompat.Builder(c, "kt-screen").setShortLabel(c.getString(c.getResources().getIdentifier("kt_screen_tile", "string", c.getPackageName())))
                    .setIcon(androidx.core.graphics.drawable.IconCompat.createWithResource(c, c.getResources().getIdentifier("ic_launcher", "mipmap", c.getPackageName())))
                    .setIntent(new Intent(c, KtScreenLaunch.class).setAction(Intent.ACTION_VIEW).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).build();
                if (pm.getComponentEnabledSetting(cn) != PackageManager.COMPONENT_ENABLED_STATE_ENABLED) pm.setComponentEnabledSetting(cn, PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP);
                pinned = androidx.core.content.pm.ShortcutManagerCompat.isRequestPinShortcutSupported(c) && androidx.core.content.pm.ShortcutManagerCompat.requestPinShortcut(c, sc, null);
            } catch (Throwable ignored) {}
        }
        JSObject r = new JSObject(); r.put("shown", pm.getComponentEnabledSetting(cn) == PackageManager.COMPONENT_ENABLED_STATE_ENABLED); r.put("pinned", pinned); call.resolve(r);
    }
    @PluginMethod public void screenStart(PluginCall call) {
        if (!android.provider.Settings.canDrawOverlays(getContext())) { call.reject("overlay"); return; }
        askNotify();
        try { KtScreenService.start(getContext(), KtScreenService.ACT_START); call.resolve(); } catch (Throwable e) { call.reject(String.valueOf(e.getMessage())); }
    }
    @PluginMethod public void screenStop(PluginCall call) { KtScreenService.stop(getContext()); call.resolve(); }
    /** A try of the translator as set: the lines given, translated (the page's «Try it»). */
    @PluginMethod public void screenTranslate(PluginCall call) {
        final JSObject cfg = call.getObject("config", null); final JSArray texts = call.getArray("texts", new JSArray());
        bg.execute(() -> {
            try {
                java.util.List<String> in = new java.util.ArrayList<>(); for (int k = 0; k < texts.length(); k++) in.add(texts.getString(k));
                java.util.Map<String, Object> m = cfg != null ? KtJson.obj(KtJson.parse(cfg.toString())) : KtScreenService.config(getContext());
                java.util.List<String> out = KtTranslate.translate(in, KtTranslate.Config.from(m));
                JSObject r = new JSObject(); r.put("texts", new JSArray(out)); call.resolve(r);
            } catch (Throwable e) { call.reject(String.valueOf(e.getMessage())); }
        });
    }
    @PluginMethod public void screenHistory(PluginCall call) {
        android.content.SharedPreferences sp = getContext().getSharedPreferences(KtScreenService.PREFS, android.content.Context.MODE_PRIVATE);
        if (Boolean.TRUE.equals(call.getBoolean("clear", false))) sp.edit().remove("history").apply();
        try { JSObject r = new JSObject(); r.put("items", new JSArray(sp.getString("history", "[]"))); call.resolve(r); } catch (Exception e) { call.reject(e.getMessage()); }
    }
    /** Whether the app may write to `dir`; whether it has «All files access» (Android 11+), or the storage
     *  permission (older); `ask`: Android's page for it (or its dialog). */
    @PluginMethod public void folderAccess(PluginCall call) {
        String dir = call.getString("dir", ""); boolean ask = Boolean.TRUE.equals(call.getBoolean("ask", false)); android.content.Context c = getContext();
        boolean all = Build.VERSION.SDK_INT >= 30 ? android.os.Environment.isExternalStorageManager() : c.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
        if (ask && !all) {
            if (Build.VERSION.SDK_INT >= 30) {
                try { c.startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + c.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
                catch (Throwable e) { try { c.startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Throwable ignored) {} }
            } else if (getActivity() != null) getActivity().requestPermissions(new String[] { android.Manifest.permission.WRITE_EXTERNAL_STORAGE }, 4713);
        }
        JSObject r = new JSObject(); r.put("all", all); r.put("writable", !dir.isEmpty() && !dir.startsWith("content:") && KtEngine.writable(new File(dir))); r.put("defaultDir", engine().defaultDir().getAbsolutePath()); call.resolve(r);
    }
    /** Whether notifications are allowed; `ask`: the system's dialog, or — once refused for good — the app's notification settings. */
    @PluginMethod public void notifyAccess(PluginCall call) {
        android.content.Context c = getContext(); boolean on = androidx.core.app.NotificationManagerCompat.from(c).areNotificationsEnabled();
        if (!on && Boolean.TRUE.equals(call.getBoolean("ask", false))) {
            android.app.Activity a = getActivity();
            boolean dialog = Build.VERSION.SDK_INT >= 33 && a != null && c.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED && (!notifyAsked || a.shouldShowRequestPermissionRationale("android.permission.POST_NOTIFICATIONS"));
            if (dialog) { notifyAsked = true; a.runOnUiThread(() -> { try { a.requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 4712); } catch (Throwable ignored) {} }); }
            else try { android.content.Intent i = new android.content.Intent("android.settings.APP_NOTIFICATION_SETTINGS").putExtra("android.provider.extra.APP_PACKAGE", c.getPackageName()).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK); c.startActivity(i); } catch (Throwable ignored) {}
        }
        JSObject r = new JSObject(); r.put("granted", on); call.resolve(r);
    }
    @PluginMethod public void add(PluginCall call) { askNotify(); run(call, () -> { JSObject r = new JSObject(); r.put("task", obj(engine().add(new JSONObject(call.getData().toString())))); call.resolve(r); }); }
    @PluginMethod public void pause(PluginCall call) { run(call, () -> { engine().pause(call.getString("id", "")); call.resolve(); }); }
    @PluginMethod public void resume(PluginCall call) { run(call, () -> { engine().resume(call.getString("id", "")); call.resolve(); }); }
    @PluginMethod public void moveFinished(PluginCall call) { bg.execute(() -> { try { JSObject r = new JSObject(); r.put("moved", engine().moveFinished(call.getString("dir", ""))); r.put("dir", engine().defaultDir().getAbsolutePath()); call.resolve(r); } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); } }); }
    @PluginMethod public void remove(PluginCall call) { run(call, () -> { engine().remove(call.getString("id", ""), Boolean.TRUE.equals(call.getBoolean("deleteFiles", false))); call.resolve(); }); }
    @PluginMethod public void setFiles(PluginCall call) { run(call, () -> { JSArray a = call.getArray("priorities"); int[] p = new int[a.length()]; for (int i = 0; i < a.length(); i++) p[i] = a.getInt(i); engine().setFiles(call.getString("id", ""), p); call.resolve(); }); }
    @PluginMethod public void setSequential(PluginCall call) { run(call, () -> { engine().setSequential(call.getString("id", ""), Boolean.TRUE.equals(call.getBoolean("on", true))); call.resolve(); }); }
    /** The device's network interfaces that are up (for binding torrents to a VPN's). */
    @PluginMethod public void interfaces(PluginCall call) { run(call, () -> { JSArray out = new JSArray(); java.util.Enumeration<java.net.NetworkInterface> e = java.net.NetworkInterface.getNetworkInterfaces(); while (e != null && e.hasMoreElements()) { java.net.NetworkInterface n = e.nextElement(); if (!n.isUp() || n.isLoopback()) continue; JSObject o = new JSObject(); o.put("name", n.getName()); o.put("vpn", n.getName().matches("(tun|wg|ppp|tap|ipsec).*")); out.put(o); } JSObject r = new JSObject(); r.put("interfaces", out); call.resolve(r); }); }
    /** What went wrong last time (written down by the app as it happened, or from Android's record at the start). Given once. */
    @PluginMethod public void lastCrash(PluginCall call) {
        JSObject r = new JSObject(); java.io.File f = new java.io.File(new java.io.File(getContext().getFilesDir(), "kt"), "crash.txt"); String text = null;
        try { if (f.exists()) { text = new String(java.nio.file.Files.readAllBytes(f.toPath()), java.nio.charset.StandardCharsets.UTF_8).trim(); f.delete(); } } catch (Exception ignored) {}
        r.put("text", text == null || text.isEmpty() ? null : text); call.resolve(r);
    }
    @PluginMethod public void torrentDetail(PluginCall call) { run(call, () -> call.resolve(new JSObject(engine().torrentDetail(call.getString("id", "")).toString()))); }
    @PluginMethod public void recheck(PluginCall call) { run(call, () -> { engine().recheck(call.getString("id", "")); call.resolve(); }); }
    @PluginMethod public void reannounce(PluginCall call) { run(call, () -> { engine().reannounce(call.getString("id", "")); call.resolve(); }); }
    @PluginMethod public void setTaskLimits(PluginCall call) { run(call, () -> { engine().setTaskLimits(call.getString("id", ""), call.getInt("down", 0), call.getInt("up", 0)); call.resolve(); }); }
    @PluginMethod public void move(PluginCall call) { run(call, () -> { engine().move(call.getString("id", ""), call.getInt("how", 0)); call.resolve(); }); }
    @PluginMethod public void setUrl(PluginCall call) { run(call, () -> { JSObject hd = call.getObject("headers", null); engine().setUrl(call.getString("id", ""), call.getString("url", ""), hd == null ? null : new JSONObject(hd.toString())); call.resolve(); }); }
    @PluginMethod public void hosts(PluginCall call) { run(call, () -> { JSObject r = new JSObject(); r.put("hosts", engine().hosts()); call.resolve(r); }); }
    @PluginMethod public void setLimits(PluginCall call) { run(call, () -> { engine().setLimits(call.getLong("down", 0L), call.getLong("up", 0L)); call.resolve(); }); }
    @PluginMethod public void configure(PluginCall call) { run(call, () -> { engine().configure(new JSONObject(call.getData().toString())); call.resolve(); }); }
    @PluginMethod public void torrentInfo(PluginCall call) { run(call, () -> { JSObject r = new JSObject(); r.put("info", obj(engine().torrentInfo(new JSONObject(call.getObject("source").toString())))); call.resolve(r); }); }
    @PluginMethod public void streamUrl(PluginCall call) { run(call, () -> { JSObject r = new JSObject(); r.put("url", engine().stream().url(call.getString("id", ""), call.getInt("fileIndex", 0))); call.resolve(r); }); }
    @PluginMethod public void defaultDir(PluginCall call) { JSObject r = new JSObject(); r.put("dir", engine().defaultDir().getAbsolutePath()); call.resolve(r); }

    /** Opens a finished file with the system (fileIndex -1: its folder, as far as Android lets a folder be opened). */
    @PluginMethod public void open(PluginCall call) {
        run(call, () -> {
            KtEngine.Task x = engine().task(call.getString("id", "")); if (x == null) throw new Exception("notFound");
            // (No file named: the torrent's main file — the largest chosen and here —, not simply its first.)
            Integer given = call.getInt("fileIndex"); int idx = given == null ? -2 : given;
            File f = engine().fileOf(x, idx == -1 ? -2 : idx);
            if (f == null || !f.exists()) { File d = new File(x.dir); f = d.exists() ? d : null; if (f == null) throw new Exception("notFound"); }
            // (A folder: the system's Files app at that folder when it will open one; else the page is told to show the
            // folder itself — never a file picker in a folder's place.)
            if (idx < 0 || f.isDirectory()) { File d = f.isDirectory() ? f : f.getParentFile(); JSObject r = new JSObject(); r.put("dir", d.getAbsolutePath()); r.put("opened", openFolder(d)); call.resolve(r); return; }
            if (!f.exists()) throw new Exception("notFound");
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_VIEW); i.setDataAndType(uri, mimeOf(f.getName())); i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i); call.resolve();
        });
    }
    /** The system's Files app (DocumentsUI) at `d`, when `d` is on the shared storage; false when nothing opens it. */
    private boolean openFolder(File d) {
        try {
            String root = android.os.Environment.getExternalStorageDirectory().getAbsolutePath(); String p = d.getAbsolutePath();
            if (!p.startsWith(root)) return false;
            String rel = p.substring(root.length()).replaceFirst("^/", "");
            Uri doc = android.provider.DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:" + rel);
            Intent i = new Intent(Intent.ACTION_VIEW); i.setDataAndType(doc, "vnd.android.document/directory"); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (i.resolveActivity(getContext().getPackageManager()) == null) return false;
            getContext().startActivity(i); return true;
        } catch (Exception e) { return false; }
    }
    /** «Open with…»: the system's chooser for a finished file, whatever app the reader picks. */
    @PluginMethod public void openChooser(PluginCall call) {
        try { File f = fileOf(call.getString("path", "")); if (!f.exists()) { call.reject("notFound"); return; } Uri u = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f); Intent i = new Intent(Intent.ACTION_VIEW); i.setDataAndType(u, call.getString("mime", mimeOf(f.getName()))); i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION); Intent ch = Intent.createChooser(i, call.getString("title", "")); ch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(ch); call.resolve(); }
        catch (Exception e) { call.reject(e.getMessage()); }
    }
    /** A download renamed — the file on disk (an HTTP download, a torrent's single file; a torrent's folder when it holds many) and its name. */
    @PluginMethod public void rename(PluginCall call) { run(call, () -> { JSObject r = new JSObject(); r.put("name", engine().rename(call.getString("id", ""), call.getString("name", ""))); call.resolve(r); }); }
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
        JSObject r = new JSObject(); r.put("dir", path != null ? path : tree.toString()); r.put("writable", path != null && KtEngine.writable(new File(path))); call.resolve(r);
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
    /** A video (a link, or a file here) handed to another player through Android's chooser (VLC, MX, mpv…). */
    @PluginMethod public void openWith(PluginCall call) {
        try {
            String path = call.getString("path", null), url = call.getString("url", null), mime = call.getString("mime", "video/*");
            Intent i = new Intent(Intent.ACTION_VIEW);
            if (path != null && !path.isEmpty()) { Uri u = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", fileOf(path)); i.setDataAndType(u, mime); i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION); }
            else i.setDataAndType(Uri.parse(url), mime);
            i.putExtra("title", call.getString("title", ""));
            Intent ch = Intent.createChooser(i, call.getString("title", "")); ch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(ch); call.resolve();
        } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); }
    }
    /** A file's checksums (Prism's «verify»): MD5, SHA-1 and SHA-256 in one read. */
    /** Whether files are there (for «Remove the ones whose files are gone»). */
    @PluginMethod public void exists(PluginCall call) { run(call, () -> { JSArray in = call.getArray("paths"); JSArray out = new JSArray(); if (in != null) for (int i = 0; i < in.length(); i++) out.put(fileOf(in.optString(i, "")).exists()); JSObject r = new JSObject(); r.put("exists", out); call.resolve(r); }); }
    @PluginMethod public void hashFile(PluginCall call) {
        final File f = fileOf(call.getString("path", ""));
        bg.execute(() -> { try { java.security.MessageDigest md5 = java.security.MessageDigest.getInstance("MD5"), sha1 = java.security.MessageDigest.getInstance("SHA-1"), sha256 = java.security.MessageDigest.getInstance("SHA-256"); byte[] b = new byte[1 << 16]; try (java.io.InputStream in = new java.io.FileInputStream(f)) { int n; while ((n = in.read(b)) > 0) { md5.update(b, 0, n); sha1.update(b, 0, n); sha256.update(b, 0, n); } } JSObject r = new JSObject(); r.put("md5", hex(md5.digest())); r.put("sha1", hex(sha1.digest())); r.put("sha256", hex(sha256.digest())); r.put("size", f.length()); call.resolve(r); } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); } });
    }
    private static String hex(byte[] d) { StringBuilder sb = new StringBuilder(); for (byte x : d) sb.append(String.format("%02x", x)); return sb.toString(); }
    /** What is on the clipboard (read while the app is in front, as Android allows), for the clipboard monitor. */
    @PluginMethod public void clipboardText(PluginCall call) {
        getActivity().runOnUiThread(() -> { try { android.content.ClipboardManager cm = (android.content.ClipboardManager) getContext().getSystemService(android.content.Context.CLIPBOARD_SERVICE); JSObject r = new JSObject(); String text = ""; if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip() != null && cm.getPrimaryClip().getItemCount() > 0) { CharSequence c = cm.getPrimaryClip().getItemAt(0).coerceToText(getContext()); if (c != null) text = c.toString(); } r.put("text", text); call.resolve(r); } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); } });
    }
    /** DNS over HTTPS (the reader's resolver): {provider: off | cloudflare | google | quad9 | adguard | https://…}; {test: host}. */
    /** DNS over HTTPS up close: its state, counters and last events; `probe` tries the resolver first. */
    @PluginMethod public void dohStatus(PluginCall call) {
        final boolean probe = Boolean.TRUE.equals(call.getBoolean("probe", false));
        bg.execute(() -> { try { org.json.JSONObject r = new org.json.JSONObject(); if (probe) r.put("probe", KrDoh.probe()); org.json.JSONObject st = KrDoh.status(); for (java.util.Iterator<String> it = st.keys(); it.hasNext(); ) { String k = it.next(); r.put(k, st.get(k)); } call.resolve(JSObject.fromJSONObject(r)); } catch (Exception e) { call.reject(e.getMessage()); } });
    }
    /** Each DoH event handed to the page as «doh» (the Settings page's live feed, the status chip). */
    static void wireDoh() { KrDoh.listener = (json) -> { KtPlugin p = self; if (p == null) return; try { p.notifyListeners("doh", JSObject.fromJSONObject(new org.json.JSONObject(json)), true); } catch (Exception ignored) {} KtBrowserActivity.dohEvent(json); }; }
    @PluginMethod public void setDoh(PluginCall call) {
        String p = call.getString("provider", null);
        if (p != null) { KrDoh.provider = p; KrDoh.forget(); getContext().getSharedPreferences("kt", android.content.Context.MODE_PRIVATE).edit().putString("doh", p).apply(); }
        final String test = call.getString("test", null); JSObject r = new JSObject(); r.put("provider", KrDoh.provider);
        if (test == null) { call.resolve(r); return; }
        bg.execute(() -> { try { java.net.InetAddress[] ips = KrDoh.resolve(test); org.json.JSONArray a = new org.json.JSONArray(); for (java.net.InetAddress ip : ips) a.put(ip.getHostAddress()); r.put("ips", a); call.resolve(r); } catch (Exception e) { call.reject("DoH: " + e.getMessage(), e); } });
    }
    /** Screenshots and the recent-apps preview blocked (privacy). */
    @PluginMethod public void secureScreen(PluginCall call) { final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false)); getActivity().runOnUiThread(() -> { if (on) getActivity().getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE); else getActivity().getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE); call.resolve(); }); }
    @PluginMethod public void openUrl(PluginCall call) {
        try { Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(call.getString("url", ""))); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(i); call.resolve(); } catch (Exception e) { call.reject(e.getMessage()); }
    }

    /* ---------- a file with its progress (an APK), and the installer ---------- */
    @PluginMethod public void downloadFile(PluginCall call) {
        final String urlStr = call.getString("url", ""); final String name = call.getString("name", "download.bin"); final String id = call.getString("id", "");
        final int connections = Math.max(1, Math.min(24, call.getInt("connections", 16)));
        final AtomicBoolean cancelled = new AtomicBoolean(false); if (!id.isEmpty()) downloads.put(id, cancelled);
        bg.execute(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "kt-files"); dir.mkdirs();
                final File done0 = new File(dir, name); File out = new File(dir, name + ".part");
                final AtomicLong got = new AtomicLong(); final KrDownloader.Result info = new KrDownloader.Result();
                Runnable report = new Runnable() { long lastT = System.currentTimeMillis(), lastGot = 0; double speed = 0; public synchronized void run() { long now = System.currentTimeMillis(); if (now - lastT < 300) return; long g = got.get(); double inst = (g - lastGot) / ((now - lastT) / 1000.0); speed = speed == 0 ? inst : speed * 0.6 + 0.4 * inst; lastT = now; lastGot = g; JSObject ev = new JSObject(); ev.put("id", id); ev.put("got", g); ev.put("total", info.total); ev.put("speed", speed); ev.put("pct", info.total > 0 ? (int) (g * 100 / info.total) : 0); ev.put("connections", info.connections); notifyListeners("downloadProgress", ev); } };
                KrDownloader.Result res = KrDownloader.fetch(new URL(urlStr), out, connections, u -> { HttpURLConnection c = KrDoh.open(u); c.setConnectTimeout(20000); c.setReadTimeout(60000); c.setInstanceFollowRedirects(false); c.setRequestProperty("User-Agent", "KurokawaTools/0.1"); return c; }, cancelled, got, info, report);
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
    @PluginMethod public void apkInfo(PluginCall call) { final File f = fileOf(call.getString("path", "")); final String pw = call.getString("password", null), sel = call.getString("select", null); bg.execute(() -> { try { call.resolve(new JSObject(KtApk.info(getContext(), f, pw, sel).toString())); } catch (Exception e) { call.reject(String.valueOf(e.getMessage()), e); } }); }
    /** Installs through a session (a bundle's splits streamed from it, no extracting): progress and the system's
     *  answer come as `apkInstall` events. */
    @PluginMethod public void apkInstall(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName())); s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(s);
            call.reject("permission"); return;
        }
        final String id = call.getString("id", ""); final File f = fileOf(call.getString("path", "")); final boolean del = Boolean.TRUE.equals(call.getBoolean("deleteAfter", false));
        final String pw = call.getString("password", null), sel = call.getString("select", null); final JSArray parts = call.getArray("parts", null);
        bg.execute(() -> { try { KtApk.install(getContext(), id, f, del, pw, sel, parts, (ev) -> { try { notifyListeners("apkInstall", new JSObject(ev.toString())); } catch (Exception ignored) {} }); call.resolve(); } catch (Exception e) { call.reject(String.valueOf(e.getMessage()), e); } });
    }
    /** The system's page to uninstall an app (asked of the person; nothing is removed without them). */
    @PluginMethod public void uninstallApp(PluginCall call) { try { Intent i = new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + call.getString("pkg", ""))); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(i); call.resolve(); } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); } }
    /** An app's page in the system's settings. */
    @PluginMethod public void appDetails(PluginCall call) { try { Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + call.getString("pkg", ""))); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(i); call.resolve(); } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); } }
    /** Whether an app is installed now (after the uninstall page closes), and its version. */
    @PluginMethod public void appInstalled(PluginCall call) { JSObject r = new JSObject(); try { android.content.pm.PackageInfo p = getContext().getPackageManager().getPackageInfo(call.getString("pkg", ""), 0); r.put("installed", true); r.put("version", p.versionName); } catch (Exception e) { r.put("installed", false); } call.resolve(r); }
    /** A bundle's game data put where the game reads it (see KtApk.copyObb). */
    @PluginMethod public void apkObb(PluginCall call) { final File f = fileOf(call.getString("path", "")); final String pkg = call.getString("pkg", ""); bg.execute(() -> { try { call.resolve(new JSObject(KtApk.copyObb(getContext(), f, pkg).toString())); } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); } }); }
    @PluginMethod public void launchApp(PluginCall call) { Intent i = getContext().getPackageManager().getLaunchIntentForPackage(call.getString("pkg", "")); if (i == null) { call.reject("notLaunchable"); return; } i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(i); call.resolve(); }
    @PluginMethod public void canInstall(PluginCall call) { JSObject r = new JSObject(); r.put("granted", Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls()); call.resolve(r); }

    /* ---------- archives: what is inside, taking it out (in place when asked), making one ---------- */
    private final java.util.Map<String, AtomicBoolean> archiveJobs = new java.util.concurrent.ConcurrentHashMap<>();
    /** A picked document's own file, when it lives on the phone's storage and the app may read it directly. */
    private static File realFile(Uri u) {
        try {
            if ("file".equals(u.getScheme())) { File f = new File(u.getPath()); return f.canRead() ? f : null; }
            if (!"com.android.externalstorage.documents".equals(u.getAuthority()) && !"com.android.providers.downloads.documents".equals(u.getAuthority())) return null;
            String id = android.provider.DocumentsContract.getDocumentId(u); File f = null;
            if ("com.android.externalstorage.documents".equals(u.getAuthority())) { int c = id.indexOf(':'); String vol = c > 0 ? id.substring(0, c) : "primary"; String rel = c >= 0 ? id.substring(c + 1) : ""; f = "primary".equalsIgnoreCase(vol) ? new File(android.os.Environment.getExternalStorageDirectory(), rel) : new File("/storage/" + vol, rel); }
            else if ("com.android.providers.downloads.documents".equals(u.getAuthority()) && id.startsWith("raw:")) f = new File(id.substring(4));
            return f != null && f.isFile() && f.canRead() ? f : null;
        } catch (Throwable e) { return null; }
    }
    private static File fileOf(String p) { if (p.startsWith("file://")) p = Uri.parse(p).getPath(); return new File(p); }
    @PluginMethod public void archiveList(PluginCall call) {
        bg.execute(() -> { try { File f = fileOf(call.getString("path", "")); JSObject r = new JSObject(new org.json.JSONObject(KtArchive.list(f, call.getString("password", null)).toString()).toString()); r.put("resumable", KtArchive.hasJournal(f)); call.resolve(r); } catch (Exception e) { call.reject(e.getMessage() == null ? e.toString() : e.getMessage(), e); } });
    }
    @PluginMethod public void archiveExtract(PluginCall call) {
        final String id = call.getString("id", ""); final AtomicBoolean stop = new AtomicBoolean(false); if (!id.isEmpty()) archiveJobs.put(id, stop);
        final File f = fileOf(call.getString("path", "")); final String destS = call.getString("dest", f.getParent()); final File dest = "cache:".equals(destS) ? new File(getContext().getCacheDir(), "archive-view") : fileOf(destS);
        final KtArchive.Options o = new KtArchive.Options(); o.inPlace = Boolean.TRUE.equals(call.getBoolean("inPlace", false)) && call.getArray("only") == null; o.deleteAfter = Boolean.TRUE.equals(call.getBoolean("deleteAfter", false)); o.replace = call.getString("replace", "replace"); o.password = call.getString("password", null);
        o.verifyFirst = Boolean.TRUE.equals(call.getBoolean("verifyFirst", false)); try { com.getcapacitor.JSArray only = call.getArray("only"); if (only != null && only.length() > 0) { o.only = new java.util.HashSet<>(); for (int i = 0; i < only.length(); i++) o.only.add(only.getString(i)); } } catch (Exception ignored) {} Double kf = call.getDouble("keepFree"); if (kf != null && kf >= 0) o.keepFree = kf.longValue();
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
                    // (A file the app can read where it is — shared storage, with the access it has — is used there: an
                    // archive or an app is read in place, the HatchZip way, not copied first.)
                    File real = realFile(u); if (real != null) { paths.put(real.getAbsolutePath()); continue; }
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

    /* ---------- the video library (REX Player's): the phone's videos, from Android's media index ---------- */
    private static String mediaPerm() { return Build.VERSION.SDK_INT >= 33 ? "android.permission.READ_MEDIA_VIDEO" : "android.permission.READ_EXTERNAL_STORAGE"; }
    /** Whether the app may read the phone's videos (all of them, or only those picked — Android 14's choice); asked
     *  when `ask` is set (the system's own dialog; its answer read again by the page). */
    @PluginMethod public void mediaAccess(PluginCall call) {
        android.content.Context c = getContext(); boolean all = c.checkSelfPermission(mediaPerm()) == PackageManager.PERMISSION_GRANTED;
        boolean some = Build.VERSION.SDK_INT >= 34 && c.checkSelfPermission("android.permission.READ_MEDIA_VISUAL_USER_SELECTED") == PackageManager.PERMISSION_GRANTED;
        if (!all && Boolean.TRUE.equals(call.getBoolean("ask", false)) && getActivity() != null) {
            String[] want = Build.VERSION.SDK_INT >= 34 ? new String[] { mediaPerm(), "android.permission.READ_MEDIA_VISUAL_USER_SELECTED" } : new String[] { mediaPerm() };
            getActivity().requestPermissions(want, 4711);
        }
        JSObject r = new JSObject(); r.put("granted", all); r.put("partial", !all && some); call.resolve(r);
    }
    /** The phone's videos (newest first): path, name, folder, length, size, picture size, when changed. */
    @PluginMethod public void mediaVideos(PluginCall call) {
        bg.execute(() -> {
            JSArray out = new JSArray();
            String[] cols = { android.provider.MediaStore.Video.Media._ID, android.provider.MediaStore.Video.Media.DATA, android.provider.MediaStore.Video.Media.DISPLAY_NAME, android.provider.MediaStore.Video.Media.BUCKET_DISPLAY_NAME, android.provider.MediaStore.Video.Media.DURATION, android.provider.MediaStore.Video.Media.SIZE, android.provider.MediaStore.Video.Media.WIDTH, android.provider.MediaStore.Video.Media.HEIGHT, android.provider.MediaStore.Video.Media.DATE_MODIFIED };
            try (android.database.Cursor cu = getContext().getContentResolver().query(android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI, cols, null, null, android.provider.MediaStore.Video.Media.DATE_MODIFIED + " DESC")) {
                if (cu != null) while (cu.moveToNext() && out.length() < 20000) {
                    JSObject o = new JSObject(); o.put("id", cu.getLong(0)); o.put("path", cu.getString(1)); o.put("name", cu.getString(2)); o.put("folder", cu.getString(3)); o.put("duration", cu.getLong(4)); o.put("size", cu.getLong(5)); o.put("width", cu.getInt(6)); o.put("height", cu.getInt(7)); o.put("mtime", cu.getLong(8) * 1000); out.put(o);
                }
                JSObject r = new JSObject(); r.put("videos", out); call.resolve(r);
            } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); }
        });
    }
    /** A video's small picture (Android's own thumbnail), as a data: URL. */
    @PluginMethod public void videoThumb(PluginCall call) {
        final long id = call.getLong("id", 0L);
        bg.execute(() -> {
            try {
                Uri u = android.content.ContentUris.withAppendedId(android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI, id); android.graphics.Bitmap b;
                if (Build.VERSION.SDK_INT >= 29) b = getContext().getContentResolver().loadThumbnail(u, new android.util.Size(320, 180), null);
                else b = android.provider.MediaStore.Video.Thumbnails.getThumbnail(getContext().getContentResolver(), id, android.provider.MediaStore.Video.Thumbnails.MINI_KIND, null);
                if (b == null) { call.reject("none"); return; }
                java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream(); b.compress(android.graphics.Bitmap.CompressFormat.JPEG, 72, bo);
                JSObject r = new JSObject(); r.put("url", "data:image/jpeg;base64," + android.util.Base64.encodeToString(bo.toByteArray(), android.util.Base64.NO_WRAP)); call.resolve(r);
            } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); }
        });
    }

    /* ---------- the player: local files over the stream server, files beside a video, ffmpeg for clips ---------- */
    @PluginMethod public void proxyUrl(PluginCall call) { run(call, () -> { JSObject r = new JSObject(); JSObject hd = call.getObject("headers", new JSObject()); r.put("url", engine().stream().proxyUrl(call.getString("url", ""), hd.toString())); call.resolve(r); }); }
    /* ---------- the Player add-on's engine: mpv (KtMpv), from the mpv pack ---------- */
    @PluginMethod public void mpvAvailable(PluginCall call) { JSObject r = new JSObject(); r.put("available", KtMpv.available(getContext())); call.resolve(r); }
    @PluginMethod public void mpvOpen(PluginCall call) {
        if (!KtMpv.available(getContext())) { call.reject("pack:mpv"); return; }
        try { KtMpv.get().open(getActivity(), getBridge().getWebView(), call.getString("url", ""), new org.json.JSONObject(call.getObject("options", new JSObject()).toString()), (o) -> { try { notifyListeners("mpv", JSObject.fromJSONObject(o)); } catch (Exception ignored) {} }); call.resolve(); }
        catch (Exception e) { call.reject(e.getMessage()); }
    }
    @PluginMethod public void mpvCommand(PluginCall call) { try { KtMpv.get().command(new org.json.JSONArray(call.getArray("args", new com.getcapacitor.JSArray()).toString())); call.resolve(); } catch (Exception e) { call.reject(e.getMessage()); } }
    @PluginMethod public void mpvSet(PluginCall call) { try { KtMpv.get().set(call.getString("name", ""), call.getString("value", "")); call.resolve(); } catch (Throwable e) { call.reject(String.valueOf(e.getMessage())); } }
    @PluginMethod public void mpvGet(PluginCall call) { try { JSObject r = new JSObject(); r.put("value", KtMpv.get().getString(call.getString("name", ""))); call.resolve(r); } catch (Throwable e) { call.reject(String.valueOf(e.getMessage())); } }
    @PluginMethod public void mpvClose(PluginCall call) { KtMpv.get().close(); call.resolve(); }
    /** The player's sound for tracks a web view cannot decode: ffmpeg turning them into AAC as they play (needs the ffmpeg pack). */
    @PluginMethod public void audioUrl(PluginCall call) { run(call, () -> { if (KtPacks.installed(getContext(), "ffmpeg") == null) throw new Exception("pack:ffmpeg"); JSObject r = new JSObject(); r.put("url", engine().stream().audioBase()); call.resolve(r); }); }
    @PluginMethod public void localUrl(PluginCall call) { run(call, () -> { JSObject r = new JSObject(); r.put("url", engine().stream().fileUrl(call.getString("path", ""))); call.resolve(r); }); }
    @PluginMethod public void siblings(PluginCall call) {
        File f = fileOf(call.getString("path", "")); JSArray out = new JSArray(); File dir = f.getParentFile(); String base = f.getName().replaceAll("\\.[^.]+$", "").toLowerCase();
        File[] kids = dir != null ? dir.listFiles() : null; if (kids != null) for (File k : kids) if (k.isFile() && !k.equals(f) && k.getName().toLowerCase().startsWith(base)) out.put(k.getAbsolutePath());
        JSObject r = new JSObject(); r.put("paths", out); call.resolve(r);
    }
    @PluginMethod public void clipsDir(PluginCall call) { File d = new File(engine().defaultDir(), "Clips"); d.mkdirs(); JSObject r = new JSObject(); r.put("dir", d.getAbsolutePath()); call.resolve(r); }
    /** A small text file the user keeps (an exported list, a settings backup): put in Downloads/Kurokawa. */
    @PluginMethod public void saveText(PluginCall call) {
        bg.execute(() -> {
            try {
                String name = call.getString("name", "kurokawa.txt").replaceAll("[\\\\/:*?\"<>|]+", "_");
                File dir = new File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS), "Kurokawa"); dir.mkdirs();
                File f = new File(dir, name);
                try (java.io.OutputStream o = new java.io.FileOutputStream(f)) { o.write(call.getString("text", "").getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
                try { android.media.MediaScannerConnection.scanFile(getContext(), new String[] { f.getAbsolutePath() }, null, null); } catch (Throwable ignored) {}
                JSObject r = new JSObject(); r.put("path", f.getAbsolutePath()); call.resolve(r);
            } catch (Exception e) { call.reject(e.getMessage()); }
        });
    }
    /** A binary file (a font for a burnt subtitle) in the clip folder, under `sub` when given; its path. */
    @PluginMethod public void writeTempBytes(PluginCall call) {
        try { File dir = new File(getContext().getCacheDir(), "clip"); String sub = call.getString("sub", ""); if (!sub.isEmpty()) dir = new File(dir, sub.replaceAll("[\\\\/]", "_")); dir.mkdirs(); File f = new File(dir, call.getString("name", "file.bin").replaceAll("[\\\\/]", "_")); try (java.io.FileOutputStream o = new java.io.FileOutputStream(f)) { o.write(android.util.Base64.decode(call.getString("b64", ""), android.util.Base64.DEFAULT)); } JSObject r = new JSObject(); r.put("path", f.getAbsolutePath()); call.resolve(r); }
        catch (Exception e) { call.reject(e.getMessage()); }
    }
    @PluginMethod public void writeTemp(PluginCall call) {
        try { File dir = new File(getContext().getCacheDir(), "clip"); new File(dir, "fonts").mkdirs(); File f = new File(dir, call.getString("name", "clip.txt").replaceAll("[\\\\/]", "_")); try (java.io.Writer w = new java.io.OutputStreamWriter(new java.io.FileOutputStream(f), java.nio.charset.StandardCharsets.UTF_8)) { w.write(call.getString("text", "")); } JSObject r = new JSObject(); r.put("path", f.getAbsolutePath()); call.resolve(r); }
        catch (Exception e) { call.reject(e.getMessage()); }
    }
    private final java.util.Map<String, Process> ffJobs = new java.util.concurrent.ConcurrentHashMap<>();
    /** ffmpeg as a program (yt-dlp's, from the ffmpeg pack): the arguments as given, progress read from `-progress pipe:1`. */
    @PluginMethod public void ffmpeg(PluginCall call) {
        final String id = call.getString("id", ""); final java.util.List<String> args = new java.util.ArrayList<>();
        try { JSArray a = call.getArray("args"); for (int i = 0; i < a.length(); i++) args.add(a.getString(i)); } catch (Exception e) { call.reject("args"); return; }
        bg.execute(() -> {
            Process p;
            try { p = KtPacks.command(getContext(), KtPacks.ffmpegBin(getContext()), args).start(); } catch (Exception e) { call.reject(e.getMessage()); return; }
            ffJobs.put(id, p); final StringBuilder log = new StringBuilder();
            Thread err = new Thread(() -> { try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(p.getErrorStream()))) { for (String l; (l = r.readLine()) != null; ) { synchronized (log) { log.append(l).append('\n'); if (log.length() > 40000) log.delete(0, log.length() - 20000); } } } catch (Exception ignored) {} });
            err.start();
            try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(p.getInputStream()))) {
                double time = 0; long size = 0; double speed = 0; long last = 0;
                for (String l; (l = r.readLine()) != null; ) {
                    int eq = l.indexOf('='); if (eq < 0) continue; String k = l.substring(0, eq), v = l.substring(eq + 1).trim();
                    try { if (k.equals("out_time_us") || k.equals("out_time_ms")) time = Long.parseLong(v) / 1e6; else if (k.equals("total_size")) size = Long.parseLong(v); else if (k.equals("speed")) speed = Double.parseDouble(v.replace("x", "")); } catch (Exception ignored) {}
                    if (k.equals("progress")) { long now = System.currentTimeMillis(); if (now - last >= 300) { last = now; JSObject ev = new JSObject(); ev.put("id", id); ev.put("time", time); ev.put("size", size); ev.put("speed", speed); notifyListeners("ffmpegProgress", ev); } }
                }
            } catch (Exception ignored) {}
            int code; try { code = p.waitFor(); err.join(2000); } catch (InterruptedException e) { code = 255; }
            ffJobs.remove(id);
            JSObject res = new JSObject(); res.put("code", code); synchronized (log) { res.put("log", log.length() > 20000 ? log.substring(log.length() - 20000) : log.toString()); } call.resolve(res);
        });
    }
    /* ---------- yt-dlp (the video add-on): what a page offers, its version, and updating it ---------- */
    @PluginMethod public void videoInfo(PluginCall call) {
        final String url = call.getString("url", ""); final boolean playlist = Boolean.TRUE.equals(call.getBoolean("playlist", false));
        bg.execute(() -> { try { JSObject r = new JSObject(); r.put("json", KtVideo.info(getContext(), url, playlist)); call.resolve(r); } catch (Throwable e) { call.reject(KtVideo.lastError(e.getMessage())); } });
    }
    @PluginMethod public void videoVersion(PluginCall call) { bg.execute(() -> { JSObject r = new JSObject(); String v = KtVideo.version(getContext()); r.put("version", v == null ? JSObject.NULL : v); r.put("ready", v != null); call.resolve(r); }); }
    @PluginMethod public void videoUpdate(PluginCall call) { bg.execute(() -> { KtVideo.update(getContext()); JSObject r = new JSObject(); String v = KtVideo.version(getContext()); r.put("version", v == null ? JSObject.NULL : v); call.resolve(r); }); }
    @PluginMethod public void ffmpegCancel(PluginCall call) { Process p = ffJobs.remove(call.getString("id", "")); if (p != null) p.destroy(); call.resolve(); }
    @PluginMethod public void ffprobe(PluginCall call) {
        bg.execute(() -> {
            try {
                java.util.List<String> a = java.util.Arrays.asList("-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", call.getString("path", ""));
                Process p = KtPacks.command(getContext(), KtPacks.ffprobeBin(getContext()), a).redirectErrorStream(false).start();
                java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream(); try (java.io.InputStream in = p.getInputStream()) { byte[] buf = new byte[8192]; int n; while ((n = in.read(buf)) > 0) b.write(buf, 0, n); }
                p.waitFor(); JSObject r = new JSObject(); String j = b.toString("UTF-8").trim(); r.put("json", j.isEmpty() ? "{}" : j); call.resolve(r);
            } catch (Exception e) { call.reject(e.getMessage()); }
        });
    }
    /* ---------- packs: the heavy native parts, downloaded when an add-on needs them ---------- */
    private final java.util.Map<String, java.util.concurrent.atomic.AtomicBoolean> packJobs = new java.util.concurrent.ConcurrentHashMap<>();
    @PluginMethod public void packStatus(PluginCall call) {
        bg.execute(() -> { JSObject r = new JSObject(); for (String n : new String[] { "python", "ffmpeg", "mpv" }) { JSObject o = new JSObject(); String v = KtPacks.installed(getContext(), n); o.put("version", v == null ? JSObject.NULL : v); o.put("size", v == null ? 0 : KtPacks.sizeOnDisk(getContext(), n)); r.put(n, o); } r.put("abi", android.os.Build.SUPPORTED_ABIS[0]); call.resolve(r); });
    }
    @PluginMethod public void packInstall(PluginCall call) {
        final String name = call.getString("name", ""); final String url = call.getString("url", ""); final String sha = call.getString("sha256", ""); final String ver = call.getString("version", "1");
        final java.util.concurrent.atomic.AtomicBoolean cancel = new java.util.concurrent.atomic.AtomicBoolean(false); packJobs.put(name, cancel);
        bg.execute(() -> {
            try { KtPacks.install(getContext(), name, url, sha, ver, (d, t) -> { JSObject ev = new JSObject(); ev.put("name", name); ev.put("done", d); ev.put("total", t); notifyListeners("packProgress", ev); }, cancel); call.resolve(); }
            catch (Throwable e) { call.reject(String.valueOf(e.getMessage())); }
            finally { packJobs.remove(name); }
        });
    }
    @PluginMethod public void packCancel(PluginCall call) { java.util.concurrent.atomic.AtomicBoolean c = packJobs.get(call.getString("name", "")); if (c != null) c.set(true); call.resolve(); }
    @PluginMethod public void packRemove(PluginCall call) { bg.execute(() -> { KtPacks.remove(getContext(), call.getString("name", "")); call.resolve(); }); }

    /* ---------- requests for the add-ons (past the page's CORS), with the WebView's identity and cookies ---------- */
    @PluginMethod public void httpRequest(PluginCall call) {
        final String urlStr = call.getString("url", ""); final String method = call.getString("method", "GET"); final String body = call.getString("body", null);
        final JSObject headers = call.getObject("headers", new JSObject()); final boolean binary = Boolean.TRUE.equals(call.getBoolean("binary", false));
        bg.execute(() -> {
            try {
                // With DNS over HTTPS on, the connection goes to the address the resolver gave and redirects are
                // followed here, each by its own name.
                URL at = new URL(urlStr); HttpURLConnection conn; int code; int hop = 0;
                while (true) {
                    conn = KrDoh.open(at); if (!KrDoh.on()) conn.setInstanceFollowRedirects(true);
                    conn.setRequestMethod(method); conn.setConnectTimeout(20000); conn.setReadTimeout(60000);
                    boolean hasUa = false; Iterator<String> it = headers.keys();
                    while (it.hasNext()) { String k = it.next(); if (k.equalsIgnoreCase("accept-encoding")) continue; conn.setRequestProperty(k, headers.getString(k)); if (k.equalsIgnoreCase("user-agent")) hasUa = true; }
                    if (!hasUa) { try { conn.setRequestProperty("User-Agent", android.webkit.WebSettings.getDefaultUserAgent(getContext())); } catch (Exception ignored) {} }
                    try { String ck = android.webkit.CookieManager.getInstance().getCookie(at.toString()); if (ck != null && !ck.isEmpty() && !headers.has("cookie") && !headers.has("Cookie")) conn.setRequestProperty("Cookie", ck); } catch (Exception ignored) {}
                    if (body != null) { conn.setDoOutput(true); try (java.io.OutputStream os = conn.getOutputStream()) { os.write(Boolean.TRUE.equals(call.getBoolean("bodyBase64", false)) ? android.util.Base64.decode(body, android.util.Base64.DEFAULT) : body.getBytes(java.nio.charset.StandardCharsets.UTF_8)); } }
                    code = conn.getResponseCode();
                    String loc = conn.getHeaderField("Location");
                    if (!KrDoh.on() || code < 300 || code >= 400 || loc == null || hop++ >= 9) break;
                    at = new URL(at, loc); conn.disconnect();
                }
                final URL finalUrl = at;
                try { java.util.List<String> set = conn.getHeaderFields().get("Set-Cookie"); if (set != null) { android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance(); for (String c : set) cm.setCookie(urlStr, c); } } catch (Exception ignored) {}
                java.io.InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                if (in != null) { byte[] buf = new byte[1 << 16]; int n; while ((n = in.read(buf)) > 0) { bos.write(buf, 0, n); if (bos.size() > 50_000_000) break; } }
                byte[] bytes = bos.toByteArray();
                JSObject ret = new JSObject(); ret.put("status", code); ret.put("url", KrDoh.on() ? finalUrl.toString() : conn.getURL().toString());
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
