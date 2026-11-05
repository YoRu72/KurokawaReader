package app.kurokawa.tools;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** The installed apps as Solid Explorer shows them: each a folder of its own with its APK and split APKs (opened as
 *  archives), its data and obb folders, backed up to a folder (one .apk, or an .apks bundle when it has splits),
 *  shared, launched, its settings page opened, uninstalled. */
final class KtApps {
    private KtApps() {}
    private static final java.util.Map<String, String> icons = new java.util.concurrent.ConcurrentHashMap<>();

    /** Every launchable app (and the system's when asked), with name, version, size on disk, dates, a small icon. */
    static JSONArray list(Context ctx, boolean system) throws Exception {
        PackageManager pm = ctx.getPackageManager(); JSONArray out = new JSONArray();
        for (PackageInfo pi : pm.getInstalledPackages(0)) {
            ApplicationInfo ai = pi.applicationInfo; if (ai == null) continue;
            boolean sys = (ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0 && (ai.flags & ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) == 0;
            if (sys && !system) continue;
            JSONObject o = new JSONObject(); o.put("pkg", pi.packageName); o.put("name", String.valueOf(ai.loadLabel(pm))); o.put("version", pi.versionName == null ? "" : pi.versionName); o.put("versionCode", android.os.Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode);
            long size = 0; if (ai.sourceDir != null) size += new File(ai.sourceDir).length(); if (ai.splitSourceDirs != null) for (String s : ai.splitSourceDirs) size += new File(s).length();
            o.put("size", size); o.put("system", sys); o.put("installedAt", pi.firstInstallTime); o.put("updatedAt", pi.lastUpdateTime); o.put("splits", ai.splitSourceDirs == null ? 0 : ai.splitSourceDirs.length); o.put("enabled", ai.enabled);
            out.put(o);
        }
        return out;
    }
    static String icon(Context ctx, String pkg) {
        String had = icons.get(pkg); if (had != null) return had;
        try {
            PackageManager pm = ctx.getPackageManager(); Drawable d = pm.getApplicationIcon(pkg); int px = 96;
            Bitmap b = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888); Canvas c = new Canvas(b); d.setBounds(0, 0, px, px); d.draw(c);
            ByteArrayOutputStream bo = new ByteArrayOutputStream(); b.compress(Bitmap.CompressFormat.PNG, 90, bo); b.recycle();
            String url = "data:image/png;base64," + Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP); if (icons.size() > 400) icons.clear(); icons.put(pkg, url); return url;
        } catch (Throwable e) { return null; }
    }
    /** One app up close: its APK files, where its data and obb live (and whether those folders exist), its native library folder. */
    static JSONObject detail(Context ctx, String pkg) throws Exception {
        PackageManager pm = ctx.getPackageManager(); PackageInfo pi = pm.getPackageInfo(pkg, 0); ApplicationInfo ai = pi.applicationInfo;
        JSONObject o = new JSONObject(); o.put("pkg", pkg); o.put("name", String.valueOf(ai.loadLabel(pm))); o.put("version", pi.versionName == null ? "" : pi.versionName);
        JSONArray files = new JSONArray();
        if (ai.sourceDir != null) { File f = new File(ai.sourceDir); files.put(new JSONObject().put("name", "base.apk").put("path", f.getAbsolutePath()).put("size", f.length()).put("mtime", f.lastModified())); }
        if (ai.splitSourceDirs != null) for (String s : ai.splitSourceDirs) { File f = new File(s); files.put(new JSONObject().put("name", f.getName()).put("path", f.getAbsolutePath()).put("size", f.length()).put("mtime", f.lastModified())); }
        o.put("apks", files);
        File ext = android.os.Environment.getExternalStorageDirectory();
        File data = new File(ext, "Android/data/" + pkg), obb = new File(ext, "Android/obb/" + pkg), media = new File(ext, "Android/media/" + pkg);
        o.put("data", data.getAbsolutePath()); o.put("dataExists", data.isDirectory()); o.put("dataReadable", data.isDirectory() && data.canRead() && data.list() != null);
        o.put("obb", obb.getAbsolutePath()); o.put("obbExists", obb.isDirectory()); o.put("obbReadable", obb.isDirectory() && obb.canRead() && obb.list() != null);
        o.put("media", media.getAbsolutePath()); o.put("mediaExists", media.isDirectory());
        o.put("nativeLibs", ai.nativeLibraryDir == null ? "" : ai.nativeLibraryDir); o.put("system", (ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0); o.put("installedAt", pi.firstInstallTime); o.put("updatedAt", pi.lastUpdateTime);
        o.put("installer", android.os.Build.VERSION.SDK_INT >= 30 ? String.valueOf(pm.getInstallSourceInfo(pkg).getInstallingPackageName()) : String.valueOf(pm.getInstallerPackageName(pkg)));
        return o;
    }
    /** The app's APK copied into `dest`: «Name_version.apk», or «Name_version.apks» (a zip of base + splits) when it has splits. */
    static File backup(Context ctx, String pkg, File dest) throws Exception {
        PackageManager pm = ctx.getPackageManager(); PackageInfo pi = pm.getPackageInfo(pkg, 0); ApplicationInfo ai = pi.applicationInfo; dest.mkdirs();
        String stem = (String.valueOf(ai.loadLabel(pm)) + "_" + (pi.versionName == null ? "" : pi.versionName)).replaceAll("[\\\\/:*?\"<>|\\u0000-\\u001f]+", " ").trim();
        List<File> parts = new ArrayList<>(); parts.add(new File(ai.sourceDir)); if (ai.splitSourceDirs != null) for (String s : ai.splitSourceDirs) parts.add(new File(s));
        if (parts.size() == 1) { File out = KtFiles.keepBoth(new File(dest, stem + ".apk")); copy(parts.get(0), out); return out; }
        File out = KtFiles.keepBoth(new File(dest, stem + ".apks"));
        try (java.util.zip.ZipOutputStream z = new java.util.zip.ZipOutputStream(new java.io.BufferedOutputStream(new FileOutputStream(out), 1 << 16))) {
            z.setLevel(0);
            for (File f : parts) { java.util.zip.ZipEntry e = new java.util.zip.ZipEntry(f == parts.get(0) ? "base.apk" : f.getName()); e.setTime(f.lastModified()); z.putNextEntry(e); try (InputStream in = new FileInputStream(f)) { byte[] b = new byte[1 << 16]; int n; while ((n = in.read(b)) > 0) z.write(b, 0, n); } z.closeEntry(); }
        }
        return out;
    }
    static void launch(Context ctx, String pkg) throws Exception { Intent i = ctx.getPackageManager().getLaunchIntentForPackage(pkg); if (i == null) throw new IOException("notLaunchable"); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); ctx.startActivity(i); }
    static void info(Context ctx, String pkg) { Intent i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg)); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); ctx.startActivity(i); }
    static void uninstall(Context ctx, String pkg) { Intent i = new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + pkg)); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); ctx.startActivity(i); }
    private static void copy(File from, File to) throws IOException { try (InputStream in = new FileInputStream(from); OutputStream o = new java.io.BufferedOutputStream(new FileOutputStream(to), 1 << 16)) { byte[] b = new byte[1 << 16]; int n; while ((n = in.read(b)) > 0) o.write(b, 0, n); } }
    static String lower(String s) { return s == null ? "" : s.toLowerCase(Locale.ROOT); }
}
