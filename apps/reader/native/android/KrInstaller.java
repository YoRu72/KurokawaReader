package app.kurokawa.reader;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Kurokawa Installer, the reader's own (the Tools app's, trimmed to what an update needs): an APK — or a bundle
 * of split APKs (.apks, .xapk, .apkm) — read out of its file straight into a PackageInstaller session, nothing
 * copied, with the progress told as it goes; what the file is (name, version, package, signers) read first and
 * the signers compared with the installed app's, so a swapped file is caught before anything is installed. The
 * system's answer — its confirmation screen, success, a failure with its reason — comes back as events.
 */
final class KrInstaller {
    interface Events { void on(JSONObject ev); }
    static final String ACTION = "app.kurokawa.reader.INSTALL_RESULT";
    private KrInstaller() {}

    static boolean isBundle(File f) { String n = f.getName().toLowerCase(Locale.ROOT); return n.endsWith(".apks") || n.endsWith(".xapk") || n.endsWith(".apkm"); }

    /** The APKs of a bundle the phone needs: the base and the splits of its own processor, language and density (all when unsure). */
    static List<ZipEntry> chosen(ZipFile z) {
        List<ZipEntry> all = new ArrayList<>(); Enumeration<? extends ZipEntry> en = z.entries();
        while (en.hasMoreElements()) { ZipEntry e = en.nextElement(); if (!e.isDirectory() && e.getName().toLowerCase(Locale.ROOT).endsWith(".apk")) all.add(e); }
        String[] abis = Build.SUPPORTED_ABIS; String lang = Locale.getDefault().getLanguage(); int dpi = android.content.res.Resources.getSystem().getDisplayMetrics().densityDpi;
        String dens = dpi >= 560 ? "xxxhdpi" : dpi >= 400 ? "xxhdpi" : dpi >= 280 ? "xhdpi" : dpi >= 200 ? "hdpi" : dpi >= 180 ? "tvdpi" : "mdpi";
        List<ZipEntry> out = new ArrayList<>(); boolean anyAbi = false;
        for (ZipEntry e : all) { String n = e.getName().toLowerCase(Locale.ROOT).replaceAll(".*/", ""); if (n.matches("config\\.(arm64_v8a|armeabi_v7a|x86|x86_64)\\.apk")) anyAbi = true; }
        for (ZipEntry e : all) {
            String n = e.getName().toLowerCase(Locale.ROOT).replaceAll(".*/", "");
            boolean take;
            if (n.equals("base.apk") || !n.startsWith("config.")) take = true;
            else if (n.matches("config\\.(arm64_v8a|armeabi_v7a|x86|x86_64)\\.apk")) { take = false; for (String a : abis) if (n.equals("config." + a.replace('-', '_') + ".apk")) { take = true; break; } }
            else if (n.matches("config\\.(ldpi|mdpi|tvdpi|hdpi|xhdpi|xxhdpi|xxxhdpi)\\.apk")) take = n.equals("config." + dens + ".apk");
            else take = n.equals("config." + lang + ".apk") || n.equals("config.en.apk");
            if (take) out.add(e);
        }
        if (anyAbi && out.size() == all.size()) return out;
        return out;
    }

    /** What the file holds: name, version, package, size, whether it is this app, and whether its signers match the installed one's. */
    static JSONObject info(Context ctx, File f) throws Exception {
        JSONObject o = new JSONObject(); PackageManager pm = ctx.getPackageManager();
        File apk = f; File tmp = null;
        if (isBundle(f)) {
            try (ZipFile z = new ZipFile(f)) { ZipEntry base = null; for (ZipEntry e : chosen(z)) { String n = e.getName().toLowerCase(Locale.ROOT).replaceAll(".*/", ""); if (n.equals("base.apk") || (base == null && !n.startsWith("config."))) base = e; }
                if (base == null) throw new Exception("noBase");
                tmp = File.createTempFile("kr-base", ".apk", ctx.getCacheDir()); try (InputStream in = z.getInputStream(base); OutputStream os = new java.io.FileOutputStream(tmp)) { byte[] b = new byte[1 << 16]; int n; while ((n = in.read(b)) > 0) os.write(b, 0, n); }
                apk = tmp; o.put("bundle", true); o.put("parts", chosen(z).size()); }
        }
        try {
            int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
            PackageInfo p = pm.getPackageArchiveInfo(apk.getAbsolutePath(), flags); if (p == null) throw new Exception("notAnApk");
            p.applicationInfo.sourceDir = apk.getAbsolutePath(); p.applicationInfo.publicSourceDir = apk.getAbsolutePath();
            o.put("package", p.packageName); o.put("version", p.versionName == null ? "" : p.versionName); o.put("versionCode", Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode);
            try { o.put("label", String.valueOf(pm.getApplicationLabel(p.applicationInfo))); } catch (Exception e) { o.put("label", p.packageName); }
            o.put("size", f.length()); o.put("sameApp", ctx.getPackageName().equals(p.packageName));
            o.put("minSdk", Build.VERSION.SDK_INT >= 24 ? p.applicationInfo.minSdkVersion : 0); o.put("targetSdk", p.applicationInfo.targetSdkVersion);
            List<String> mine = signers(p); JSONArray sa = new JSONArray(); for (String s : mine) sa.put(s); o.put("signers", sa);
            try {
                PackageInfo inst = pm.getPackageInfo(p.packageName, flags); List<String> have = signers(inst);
                o.put("installed", true); o.put("installedVersion", inst.versionName == null ? "" : inst.versionName); o.put("installedVersionCode", Build.VERSION.SDK_INT >= 28 ? inst.getLongVersionCode() : inst.versionCode);
                boolean match = !mine.isEmpty() && !have.isEmpty(); for (String s : mine) if (!have.contains(s)) match = false;
                o.put("signerMatch", match);
            } catch (PackageManager.NameNotFoundException e) { o.put("installed", false); }
        } finally { if (tmp != null) tmp.delete(); }
        return o;
    }
    static List<String> signers(PackageInfo p) {
        List<String> out = new ArrayList<>();
        try {
            android.content.pm.Signature[] sigs = Build.VERSION.SDK_INT >= 28 && p.signingInfo != null ? (p.signingInfo.hasMultipleSigners() ? p.signingInfo.getApkContentsSigners() : p.signingInfo.getSigningCertificateHistory()) : p.signatures;
            if (sigs != null) for (android.content.pm.Signature s : sigs) { java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256"); StringBuilder sb = new StringBuilder(); for (byte x : md.digest(s.toByteArray())) sb.append(String.format("%02X", x)); out.add(sb.toString()); }
        } catch (Exception ignored) {}
        return out;
    }

    /** The file streamed into an install session; the system then asks (its screen) or installs; told back as events. */
    static void install(Context ctx, String id, File f, boolean deleteAfter, Events ev) throws Exception {
        PackageInstaller pi = ctx.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        params.setSize(f.length());
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
            Intent cb = new Intent(ACTION).setPackage(ctx.getPackageName()).putExtra("kr.id", id);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            try {
                final android.os.Handler hd = new android.os.Handler(android.os.Looper.getMainLooper());
                pi.registerSessionCallback(new PackageInstaller.SessionCallback() {
                    int last = -1;
                    @Override public void onCreated(int i) {} @Override public void onBadgingChanged(int i) {} @Override public void onActiveChanged(int i, boolean a) {}
                    @Override public void onProgressChanged(int i, float pr) { if (i != sid) return; int pc = Math.round(pr * 100); if (pc == last) return; last = pc; try { JSONObject o = new JSONObject(); o.put("id", id); o.put("status", "installing"); o.put("pct", pc); ev.on(o); } catch (Exception ignored) {} }
                    @Override public void onFinished(int i, boolean ok) { if (i == sid) try { pi.unregisterSessionCallback(this); } catch (Exception ignored) {} }
                }, hd);
            } catch (Exception ignored) {}
            s.commit(PendingIntent.getBroadcast(ctx, sid, cb, flags).getIntentSender());
            JSONObject o = new JSONObject(); o.put("id", id); o.put("status", "committed"); ev.on(o);
        } catch (Exception e) { s.abandon(); throw e; }
        finally { s.close(); }
    }
    interface Tick { void on(int n); }
    private static long lastTick = 0;
    static void progress(Events ev, String id, long done, long total) { long now = System.currentTimeMillis(); if (now - lastTick < 150 && done < total) return; lastTick = now; try { JSONObject o = new JSONObject(); o.put("id", id); o.put("status", "progress"); o.put("done", done); o.put("total", total); ev.on(o); } catch (Exception ignored) {} }
    static void copy(InputStream in, OutputStream os, Tick t) throws Exception { byte[] b = new byte[1 << 20]; int n; while ((n = in.read(b)) > 0) { os.write(b, 0, n); if (t != null) t.on(n); } }

    private static BroadcastReceiver receiver;
    static synchronized void register(Context ctx, Events ev, String id, File f, boolean deleteAfter) {
        if (receiver != null) try { ctx.getApplicationContext().unregisterReceiver(receiver); } catch (Exception ignored) {}
        receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE); String msg = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE); String rid = i.getStringExtra("kr.id");
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
