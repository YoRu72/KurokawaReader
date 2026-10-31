package app.kurokawa.tools;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Installing apps: a plain APK, or a split bundle (.apks, .xapk, .apkm — a zip of a base APK and its splits)
 * streamed straight out of the bundle into the system's installer session, HatchZip-minded: nothing is extracted
 * first, so it needs no room for a second copy. What the app is (name, icon, package, version, the version
 * installed now) is read before anything is asked; the install reports its progress and its result.
 */
final class KtApk {
    interface Events { void on(JSONObject ev); }
    static final String ACTION = "app.kurokawa.tools.INSTALL_RESULT";

    static boolean isBundle(File f) { String n = f.getName().toLowerCase(Locale.ROOT); return n.endsWith(".apks") || n.endsWith(".xapk") || n.endsWith(".apkm") || (n.endsWith(".zip") && zipHasApk(f)); }
    static boolean zipHasApk(File f) { try (ZipFile z = new ZipFile(f)) { Enumeration<? extends ZipEntry> e = z.entries(); while (e.hasMoreElements()) if (e.nextElement().getName().toLowerCase(Locale.ROOT).endsWith(".apk")) return true; } catch (Exception ignored) {} return false; }

    /** The APKs of a bundle to install: the base, the feature splits, and the configuration splits that fit this
     *  device's processor (all densities and languages are kept: the system takes what it needs). */
    static List<ZipEntry> chosen(ZipFile z) {
        List<ZipEntry> all = new ArrayList<>(); Enumeration<? extends ZipEntry> e = z.entries();
        while (e.hasMoreElements()) { ZipEntry x = e.nextElement(); String n = x.getName(); if (!x.isDirectory() && n.toLowerCase(Locale.ROOT).endsWith(".apk") && !n.contains("/")) all.add(x); }
        if (all.isEmpty()) { e = z.entries(); while (e.hasMoreElements()) { ZipEntry x = e.nextElement(); if (!x.isDirectory() && x.getName().toLowerCase(Locale.ROOT).endsWith(".apk")) all.add(x); } }
        // A bundle may carry its native code for several processors: only the best one for this device is taken.
        String best = null; for (String a : Build.SUPPORTED_ABIS) { String k = a.replace('-', '_').toLowerCase(Locale.ROOT); if (hasAbi(all, k)) { best = k; break; } }
        List<ZipEntry> out = new ArrayList<>();
        for (ZipEntry x : all) { String abi = abiOf(x.getName()); if (abi != null && best != null && !abi.equals(best)) continue; out.add(x); }
        return out;
    }
    static final String[] ABIS = { "arm64_v8a", "armeabi_v7a", "x86_64", "x86", "armeabi", "mips64", "mips" };
    static String abiOf(String name) { String n = name.toLowerCase(Locale.ROOT); for (String k : ABIS) if (n.contains("." + k + ".") || n.endsWith("_" + k + ".apk") || n.endsWith("-" + k + ".apk")) return k; return null; }
    static boolean hasAbi(List<ZipEntry> all, String abi) { for (ZipEntry x : all) if (abi.equals(abiOf(x.getName()))) return true; return false; }
    static ZipEntry baseOf(ZipFile z, List<ZipEntry> apks) { for (ZipEntry x : apks) { String n = x.getName().toLowerCase(Locale.ROOT); if (n.equals("base.apk") || n.endsWith("/base.apk")) return x; } ZipEntry big = null; for (ZipEntry x : apks) if (!x.getName().toLowerCase(Locale.ROOT).startsWith("split") && (big == null || x.getSize() > big.getSize())) big = x; return big != null ? big : apks.isEmpty() ? null : apks.get(0); }

    /** What the file installs: name, package, version, icon (PNG, base64), the version installed now. */
    static JSONObject info(Context ctx, File f) throws Exception {
        PackageManager pm = ctx.getPackageManager(); File apk = f; File tmp = null; JSONObject o = new JSONObject(); int splits = 0; long size = f.length();
        if (isBundle(f)) {
            try (ZipFile z = new ZipFile(f)) {
                List<ZipEntry> apks = chosen(z); splits = apks.size(); ZipEntry base = baseOf(z, apks); if (base == null) throw new Exception("noApkInside");
                tmp = new File(ctx.getCacheDir(), "kt-base-" + System.nanoTime() + ".apk");
                try (InputStream in = z.getInputStream(base); OutputStream os = new FileOutputStream(tmp)) { copy(in, os, null); }
                apk = tmp; long s = 0; for (ZipEntry x : apks) s += Math.max(0, x.getSize()); size = s;
                ZipEntry man = z.getEntry("manifest.json"); if (man != null) { try (InputStream in = z.getInputStream(man)) { JSONObject m = new JSONObject(new String(readAll(in), "UTF-8")); if (m.has("expansions") || m.has("obb")) o.put("obb", true); } catch (Exception ignored) {} }
            }
        }
        try {
            PackageInfo p = pm.getPackageArchiveInfo(apk.getPath(), 0); if (p == null) throw new Exception("notAnApk");
            ApplicationInfo ai = p.applicationInfo; if (ai != null) { ai.sourceDir = apk.getPath(); ai.publicSourceDir = apk.getPath(); }
            o.put("package", p.packageName); o.put("version", p.versionName == null ? "" : p.versionName); o.put("versionCode", Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode);
            if (ai != null) { o.put("label", String.valueOf(ai.loadLabel(pm))); if (Build.VERSION.SDK_INT >= 24) o.put("minSdk", ai.minSdkVersion); try { o.put("icon", png(ai.loadIcon(pm))); } catch (Exception ignored) {} }
            try { PackageInfo cur = pm.getPackageInfo(p.packageName, 0); long cv = Build.VERSION.SDK_INT >= 28 ? cur.getLongVersionCode() : cur.versionCode; long nv = o.getLong("versionCode"); o.put("installed", cur.versionName == null ? "" : cur.versionName); o.put("change", nv > cv ? "upgrade" : nv == cv ? "same" : "downgrade"); }
            catch (PackageManager.NameNotFoundException e) { o.put("change", "new"); }
            o.put("splits", splits); o.put("size", size); o.put("bundle", splits > 0); o.put("supported", !o.has("minSdk") || o.getInt("minSdk") <= Build.VERSION.SDK_INT);
            return o;
        } finally { if (tmp != null) tmp.delete(); }
    }
    static String png(Drawable d) { Bitmap b; if (d instanceof BitmapDrawable && ((BitmapDrawable) d).getBitmap() != null) b = ((BitmapDrawable) d).getBitmap(); else { int w = Math.max(1, Math.min(192, d.getIntrinsicWidth() > 0 ? d.getIntrinsicWidth() : 144)), h = Math.max(1, Math.min(192, d.getIntrinsicHeight() > 0 ? d.getIntrinsicHeight() : 144)); b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888); Canvas c = new Canvas(b); d.setBounds(0, 0, w, h); d.draw(c); } ByteArrayOutputStream o = new ByteArrayOutputStream(); b.compress(Bitmap.CompressFormat.PNG, 100, o); return "data:image/png;base64," + Base64.encodeToString(o.toByteArray(), Base64.NO_WRAP); }

    /** One install session: the APK (or every chosen split of a bundle) written into it with progress, then
     *  committed; the system's answer comes back through the result receiver. */
    static void install(Context ctx, String id, File f, boolean deleteAfter, Events ev) throws Exception {
        PackageInstaller pi = ctx.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        int sid = pi.createSession(params); PackageInstaller.Session s = pi.openSession(sid);
        try {
            if (isBundle(f)) {
                try (ZipFile z = new ZipFile(f)) {
                    List<ZipEntry> apks = chosen(z); long total = 0; for (ZipEntry x : apks) total += Math.max(0, x.getSize()); final long[] done = { 0 }; final long T = total;
                    for (ZipEntry x : apks) { String name = x.getName().replaceAll(".*/", ""); try (InputStream in = z.getInputStream(x); OutputStream os = s.openWrite(name, 0, x.getSize() > 0 ? x.getSize() : -1)) { copy(in, os, (k) -> { done[0] += k; progress(ev, id, done[0], T); }); s.fsync(os); } }
                }
            } else {
                try (InputStream in = new FileInputStream(f); OutputStream os = s.openWrite("base.apk", 0, f.length())) { final long[] done = { 0 }; copy(in, os, (k) -> { done[0] += k; progress(ev, id, done[0], f.length()); }); s.fsync(os); }
            }
            register(ctx, ev, id, f, deleteAfter);
            Intent cb = new Intent(ACTION).setPackage(ctx.getPackageName()).putExtra("kt.id", id);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            s.commit(PendingIntent.getBroadcast(ctx, sid, cb, flags).getIntentSender());
            JSONObject o = new JSONObject(); o.put("id", id); o.put("status", "committed"); ev.on(o);
        } catch (Exception e) { s.abandon(); throw e; }
        finally { s.close(); }
    }
    interface Tick { void on(int n); }
    static long lastTick = 0;
    static void progress(Events ev, String id, long done, long total) { long now = System.currentTimeMillis(); if (now - lastTick < 200 && done < total) return; lastTick = now; try { JSONObject o = new JSONObject(); o.put("id", id); o.put("status", "progress"); o.put("done", done); o.put("total", total); ev.on(o); } catch (Exception ignored) {} }
    static void copy(InputStream in, OutputStream os, Tick t) throws Exception { byte[] b = new byte[1 << 16]; int n; while ((n = in.read(b)) > 0) { os.write(b, 0, n); if (t != null) t.on(n); } }
    static byte[] readAll(InputStream in) throws Exception { ByteArrayOutputStream o = new ByteArrayOutputStream(); copy(in, o, null); return o.toByteArray(); }

    private static BroadcastReceiver receiver;
    /** The system's answer: asked to confirm (its screen opened), installed, or failed with its reason. */
    static synchronized void register(Context ctx, Events ev, String id, File f, boolean deleteAfter) {
        if (receiver != null) try { ctx.getApplicationContext().unregisterReceiver(receiver); } catch (Exception ignored) {}
        receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE); String msg = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE); String rid = i.getStringExtra("kt.id");
                try {
                    JSONObject o = new JSONObject(); o.put("id", rid == null ? id : rid);
                    if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) { Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT); if (confirm != null) { confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); c.startActivity(confirm); } o.put("status", "confirm"); }
                    else if (st == PackageInstaller.STATUS_SUCCESS) { o.put("status", "success"); o.put("package", i.getStringExtra(PackageInstaller.EXTRA_PACKAGE_NAME)); if (deleteAfter) f.delete(); }
                    else { o.put("status", "failure"); o.put("code", st); o.put("message", msg == null ? "" : msg); }
                    ev.on(o);
                } catch (Exception ignored) {}
            }
        };
        IntentFilter filter = new IntentFilter(ACTION);
        if (Build.VERSION.SDK_INT >= 33) ctx.getApplicationContext().registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED); else ctx.getApplicationContext().registerReceiver(receiver, filter);
    }
}
