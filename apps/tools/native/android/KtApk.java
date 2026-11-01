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

    static boolean isBundle(File f) { String n = f.getName().toLowerCase(Locale.ROOT); return n.endsWith(".apks") || n.endsWith(".xapk") || n.endsWith(".apkm"); }
    /** Any other archive (ZIP, 7z, RAR, tar): the app is found inside it and streamed out of it. */
    static boolean isContainer(File f) { return !f.getName().toLowerCase(Locale.ROOT).endsWith(".apk") && !isBundle(f); }
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
    static JSONObject info(Context ctx, File f) throws Exception { return info(ctx, f, null, null); }
    static JSONObject info(Context ctx, File f, String password, String select) throws Exception {
        PackageManager pm = ctx.getPackageManager(); File apk = f; File tmp = null; JSONObject o = new JSONObject(); int splits = 0; long size = f.length();
        if (isContainer(f)) {
            // (An app inside an archive: what the archive offers listed, one chosen — asked when there are several —,
            // its base APK read out to learn what it is; the parts to install handed back for the install.)
            List<KtApkPlan.Entry> all = list(f, password); List<KtApkPlan.App> apps = KtApkPlan.apps(all);
            if (apps.isEmpty()) throw new Exception("noApkInside");
            KtApkPlan.App app = null; for (KtApkPlan.App a : apps) if (a.select.equals(select)) app = a;
            if (app == null && apps.size() > 1) { JSONArray ch = new JSONArray(); for (KtApkPlan.App a : apps) { JSONObject c = new JSONObject(); c.put("select", a.select); c.put("label", a.label); c.put("size", a.size); ch.put(c); } o.put("choose", ch); return o; }
            if (app == null) app = apps.get(0);
            List<KtApkPlan.Entry> parts; String inner = null;
            if (app.select.startsWith("bundle:")) { inner = app.select.substring(7); parts = KtApkPlan.parts(KtApkPlan.apksOf(listInner(f, password, inner), "bundle:"), Build.SUPPORTED_ABIS); }
            else parts = KtApkPlan.parts(KtApkPlan.apksOf(all, app.select), Build.SUPPORTED_ABIS);
            KtApkPlan.Entry base = KtApkPlan.base(parts); if (base == null) throw new Exception("noApkInside");
            tmp = new File(ctx.getCacheDir(), "kt-base-" + System.nanoTime() + ".apk");
            final File out = tmp; final String want = base.path; final String in2 = inner;
            KtArchive.walk(f, password, (name, sz, in) -> {
                if (in2 == null) { if (!name.equals(want)) return true; try (OutputStream os = new FileOutputStream(out)) { copy(in, os, null); } return false; }
                if (!name.equals(in2)) return true;
                java.util.zip.ZipInputStream z = new java.util.zip.ZipInputStream(in); ZipEntry e;
                while ((e = z.getNextEntry()) != null) if (e.getName().equals(want)) { try (OutputStream os = new FileOutputStream(out)) { copy(z, os, null); } break; }
                return false;
            });
            apk = tmp; long s = 0; JSONArray pa = new JSONArray(); for (KtApkPlan.Entry e : parts) { s += Math.max(0, e.size); pa.put(e.path); } size = s; splits = parts.size() > 1 ? parts.size() : 0;
            o.put("select", app.select); o.put("parts", pa); o.put("container", true);
            { JSONArray all2 = new JSONArray(); for (KtApkPlan.Entry e : parts) { JSONObject x = new JSONObject(); x.put("name", e.path); x.put("size", e.size); x.put("kind", KtApkPlan.kindOf(e.path)); x.put("optional", KtApkPlan.optional(e.path)); all2.put(x); } o.put("partsAll", all2); }
        } else if (isBundle(f)) {
            try (ZipFile z = new ZipFile(f)) {
                List<ZipEntry> apks = chosen(z); splits = apks.size(); ZipEntry base = baseOf(z, apks); if (base == null) throw new Exception("noApkInside");
                tmp = new File(ctx.getCacheDir(), "kt-base-" + System.nanoTime() + ".apk");
                try (InputStream in = z.getInputStream(base); OutputStream os = new FileOutputStream(tmp)) { copy(in, os, null); }
                apk = tmp; long s = 0; for (ZipEntry x : apks) s += Math.max(0, x.getSize()); size = s;
                ZipEntry man = z.getEntry("manifest.json"); if (man != null) { try (InputStream in = z.getInputStream(man)) { JSONObject m = new JSONObject(new String(readAll(in), "UTF-8")); if (m.has("expansions") || m.has("obb")) o.put("obb", true); } catch (Exception ignored) {} }
                // (Every part, for choosing: languages and densities may be left out; the chosen ones ticked.)
                JSONArray pa = new JSONArray(); for (ZipEntry x : apks) pa.put(x.getName()); o.put("parts", pa); o.put("partsAll", partsJson(apks));
                int obb = 0; Enumeration<? extends ZipEntry> en = z.entries(); while (en.hasMoreElements()) { ZipEntry x = en.nextElement(); if (!x.isDirectory() && x.getName().toLowerCase(Locale.ROOT).endsWith(".obb")) obb++; } if (obb > 0) { o.put("obb", true); o.put("obbFiles", obb); }
            }
        }
        try {
            int flags = PackageManager.GET_PERMISSIONS | (Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES);
            PackageInfo p = pm.getPackageArchiveInfo(apk.getPath(), flags); if (p == null) p = pm.getPackageArchiveInfo(apk.getPath(), 0); if (p == null) throw new Exception("notAnApk");
            details(ctx, pm, p, apk, o);
            ApplicationInfo ai = p.applicationInfo; if (ai != null) { ai.sourceDir = apk.getPath(); ai.publicSourceDir = apk.getPath(); }
            o.put("package", p.packageName); o.put("version", p.versionName == null ? "" : p.versionName); o.put("versionCode", Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode);
            if (ai != null) { o.put("label", String.valueOf(ai.loadLabel(pm))); if (Build.VERSION.SDK_INT >= 24) o.put("minSdk", ai.minSdkVersion); try { o.put("icon", png(ai.loadIcon(pm))); } catch (Exception ignored) {} }
            try { PackageInfo cur = pm.getPackageInfo(p.packageName, 0); long cv = Build.VERSION.SDK_INT >= 28 ? cur.getLongVersionCode() : cur.versionCode; long nv = o.getLong("versionCode"); o.put("installed", cur.versionName == null ? "" : cur.versionName); o.put("change", nv > cv ? "upgrade" : nv == cv ? "same" : "downgrade"); }
            catch (PackageManager.NameNotFoundException e) { o.put("change", "new"); }
            o.put("splits", splits); o.put("size", size); o.put("bundle", splits > 0);
            try { o.put("free", android.os.Environment.getDataDirectory().getUsableSpace()); } catch (Exception ignored) {} o.put("supported", !o.has("minSdk") || o.getInt("minSdk") <= Build.VERSION.SDK_INT);
            return o;
        } finally { if (tmp != null) tmp.delete(); }
    }
    /** The rest of what is shown before installing: target and minimum Android, the processors its code is
     *  built for (and whether this phone's is among them), what it asks to access (the risky ones marked), and
     *  who signed it — compared with the copy installed now, whose signer must be the same for an update. */
    static void details(Context ctx, PackageManager pm, PackageInfo p, File apk, JSONObject o) {
        try {
            if (p.applicationInfo != null) o.put("targetSdk", p.applicationInfo.targetSdkVersion);
            // Processors: the lib/<abi>/ folders of the base (a bundle's code splits are judged by their names).
            java.util.Set<String> abis = new java.util.TreeSet<>();
            try (ZipFile z = new ZipFile(apk)) { Enumeration<? extends ZipEntry> e = z.entries(); while (e.hasMoreElements()) { String n = e.nextElement().getName(); if (n.startsWith("lib/") && n.indexOf('/', 4) > 4) abis.add(n.substring(4, n.indexOf('/', 4))); } } catch (Exception ignored) {}
            if (o.has("partsAll")) { JSONArray pa = o.getJSONArray("partsAll"); for (int i = 0; i < pa.length(); i++) { String a = KtApkPlan.abiOf(pa.getJSONObject(i).getString("name")); if (a != null) abis.add(a.replace('_', '-')); } }
            JSONArray ab = new JSONArray(); for (String a : abis) ab.put(a); o.put("abis", ab);
            boolean fits = abis.isEmpty(); for (String a : Build.SUPPORTED_ABIS) if (abis.contains(a)) fits = true; o.put("abiFits", fits);
            JSONArray dev = new JSONArray(); for (String a : Build.SUPPORTED_ABIS) dev.put(a); o.put("deviceAbis", dev);
            // Permissions.
            JSONArray perms = new JSONArray(); int risky = 0;
            if (p.requestedPermissions != null) for (String name : p.requestedPermissions) {
                boolean danger = false; String label = null;
                try { android.content.pm.PermissionInfo pi = pm.getPermissionInfo(name, 0); int prot = Build.VERSION.SDK_INT >= 28 ? pi.getProtection() : (pi.protectionLevel & android.content.pm.PermissionInfo.PROTECTION_MASK_BASE); danger = prot == android.content.pm.PermissionInfo.PROTECTION_DANGEROUS; CharSequence l = pi.loadLabel(pm); if (l != null && !l.toString().equals(name)) label = l.toString(); } catch (Exception ignored) {}
                if (danger) risky++; JSONObject x = new JSONObject(); x.put("name", name); x.put("danger", danger); if (label != null) x.put("label", label); perms.put(x);
                if (perms.length() >= 120) break;
            }
            o.put("permissions", perms); o.put("riskyPermissions", risky);
            // Signers.
            java.util.List<String> mine = signers(p);
            if (!mine.isEmpty()) o.put("signer", mine.get(0));
            try {
                int f2 = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
                PackageInfo cur = pm.getPackageInfo(p.packageName, f2); java.util.List<String> theirs = signers(cur);
                boolean same = mine.isEmpty() || theirs.isEmpty(); for (String x : mine) if (theirs.contains(x)) same = true;
                o.put("sameSigner", same); if (!same && !theirs.isEmpty()) o.put("installedSigner", theirs.get(0));
            } catch (PackageManager.NameNotFoundException ignored) {}
        } catch (Exception ignored) {}
    }
    /** Every certificate an app was signed with (its rotation history too), as SHA-256 fingerprints. */
    @SuppressWarnings("deprecation")
    static java.util.List<String> signers(PackageInfo p) {
        java.util.List<String> out = new ArrayList<>(); android.content.pm.Signature[] sig = null;
        if (Build.VERSION.SDK_INT >= 28 && p.signingInfo != null) sig = p.signingInfo.hasMultipleSigners() ? p.signingInfo.getApkContentsSigners() : p.signingInfo.getSigningCertificateHistory();
        if (sig == null) sig = p.signatures;
        if (sig != null) for (android.content.pm.Signature s : sig) { try { java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256"); StringBuilder b = new StringBuilder(); for (byte x : md.digest(s.toByteArray())) b.append(String.format("%02X", x)); out.add(b.toString()); } catch (Exception ignored) {} }
        return out;
    }
    static JSONArray partsJson(List<ZipEntry> apks) throws Exception { JSONArray a = new JSONArray(); for (ZipEntry x : apks) { JSONObject o = new JSONObject(); o.put("name", x.getName()); o.put("size", Math.max(0, x.getSize())); o.put("kind", KtApkPlan.kindOf(x.getName())); o.put("optional", KtApkPlan.optional(x.getName())); a.put(o); } return a; }
    /** A bundle's game data (Android/obb/<package>/…): put where the game reads it — straight into Android/obb when
     *  the system allows it, else into Download/obb/<package> to be moved there by hand. */
    static JSONObject copyObb(Context ctx, File f, String pkg) throws Exception {
        JSONObject r = new JSONObject(); int n = 0; File root = android.os.Environment.getExternalStorageDirectory();
        File direct = new File(root, "Android/obb/" + pkg); File fallback = new File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS), "obb/" + pkg);
        boolean useDirect = (direct.isDirectory() || direct.mkdirs()) && direct.canWrite(); File to = useDirect ? direct : fallback; to.mkdirs();
        try (ZipFile z = new ZipFile(f)) { Enumeration<? extends ZipEntry> e = z.entries(); while (e.hasMoreElements()) { ZipEntry x = e.nextElement(); String nm = x.getName(); if (x.isDirectory() || !nm.toLowerCase(Locale.ROOT).endsWith(".obb")) continue; File out = new File(to, nm.replaceAll(".*/", "")); try (InputStream in = z.getInputStream(x); OutputStream os = new FileOutputStream(out)) { copy(in, os, null); } n++; } }
        r.put("copied", n); r.put("to", to.getAbsolutePath()); r.put("direct", useDirect); return r;
    }

    static String png(Drawable d) { Bitmap b; if (d instanceof BitmapDrawable && ((BitmapDrawable) d).getBitmap() != null) b = ((BitmapDrawable) d).getBitmap(); else { int w = Math.max(1, Math.min(192, d.getIntrinsicWidth() > 0 ? d.getIntrinsicWidth() : 144)), h = Math.max(1, Math.min(192, d.getIntrinsicHeight() > 0 ? d.getIntrinsicHeight() : 144)); b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888); Canvas c = new Canvas(b); d.setBounds(0, 0, w, h); d.draw(c); } ByteArrayOutputStream o = new ByteArrayOutputStream(); b.compress(Bitmap.CompressFormat.PNG, 100, o); return "data:image/png;base64," + Base64.encodeToString(o.toByteArray(), Base64.NO_WRAP); }

    /** One install session: the APK (or every chosen split of a bundle) written into it with progress, then
     *  committed; the system's answer comes back through the result receiver. */
    static void install(Context ctx, String id, File f, boolean deleteAfter, Events ev) throws Exception { install(ctx, id, f, deleteAfter, null, null, null, ev); }
    static void install(Context ctx, String id, File f, boolean deleteAfter, String password, String select, JSONArray partList, Events ev) throws Exception {
        PackageInstaller pi = ctx.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        int sid = pi.createSession(params); PackageInstaller.Session s = pi.openSession(sid);
        try {
            if (isContainer(f)) {
                // (Straight out of the archive into the session — out of a bundle inside it too —, nothing extracted.)
                if (select == null || partList == null) { JSONObject plan = info(ctx, f, password, select); if (plan.has("choose")) throw new Exception("chooseApp"); select = plan.getString("select"); partList = plan.getJSONArray("parts"); }
                final java.util.Set<String> want = new java.util.HashSet<>(); for (int k = 0; k < partList.length(); k++) want.add(partList.getString(k));
                List<KtApkPlan.Entry> listed = select.startsWith("bundle:") ? listInner(f, password, select.substring(7)) : list(f, password);
                long total = 0; for (KtApkPlan.Entry e : listed) if (want.contains(e.path)) total += Math.max(0, e.size);
                final long T = total; final long[] done = { 0 }; final String inner = select.startsWith("bundle:") ? select.substring(7) : null; final int[] wrote = { 0 };
                KtArchive.walk(f, password, (name, sz, in) -> {
                    if (inner == null) { if (!want.contains(name)) return true; write(s, name, sz, in, ev, id, done, T); wrote[0]++; return wrote[0] < want.size(); }
                    if (!name.equals(inner)) return true;
                    java.util.zip.ZipInputStream z = new java.util.zip.ZipInputStream(in); ZipEntry e;
                    while ((e = z.getNextEntry()) != null) if (want.contains(e.getName())) { write(s, e.getName(), e.getSize(), z, ev, id, done, T); wrote[0]++; }
                    return false;
                });
                if (wrote[0] < want.size()) throw new Exception("missingParts " + wrote[0] + "/" + want.size());
            } else if (isBundle(f)) {
                try (ZipFile z = new ZipFile(f)) {
                    List<ZipEntry> apks = chosen(z);
                    // (Parts chosen in the sheet — languages or densities left out — when it gave them.)
                    if (partList != null && partList.length() > 0) { java.util.Set<String> want = new java.util.HashSet<>(); for (int k = 0; k < partList.length(); k++) want.add(partList.getString(k)); List<ZipEntry> keep = new ArrayList<>(); Enumeration<? extends ZipEntry> en = z.entries(); while (en.hasMoreElements()) { ZipEntry x = en.nextElement(); if (want.contains(x.getName())) keep.add(x); } if (!keep.isEmpty()) apks = keep; }
                    long total = 0; for (ZipEntry x : apks) total += Math.max(0, x.getSize()); final long[] done = { 0 }; final long T = total;
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
    /** The archive's files (names and sizes; nothing read). */
    static List<KtApkPlan.Entry> list(File f, String password) throws Exception { List<KtApkPlan.Entry> out = new ArrayList<>(); KtArchive.walk(f, password, (n, sz, in) -> { out.add(new KtApkPlan.Entry(n, sz)); return true; }); return out; }
    /** A bundle's files, inside an archive (read through once: a zip read as a stream tells sizes as it goes). */
    static List<KtApkPlan.Entry> listInner(File f, String password, String inner) throws Exception {
        List<KtApkPlan.Entry> out = new ArrayList<>(); byte[] skip = new byte[1 << 16];
        KtArchive.walk(f, password, (n, sz, in) -> {
            if (!n.equals(inner)) return true;
            java.util.zip.ZipInputStream z = new java.util.zip.ZipInputStream(in); ZipEntry e;
            while ((e = z.getNextEntry()) != null) { if (e.isDirectory()) continue; long size = e.getSize(); if (size < 0) { size = 0; int r; while ((r = z.read(skip)) > 0) size += r; } out.add(new KtApkPlan.Entry(e.getName(), size)); }
            return false;
        });
        return out;
    }
    /** One APK into the session, under its own file name (sizes unknown are given as -1, which the session allows). */
    static void write(PackageInstaller.Session s, String path, long size, InputStream in, Events ev, String id, long[] done, long total) throws Exception {
        String name = path.replaceAll(".*/", ""); if (!name.toLowerCase(Locale.ROOT).endsWith(".apk")) name = name + ".apk";
        try (OutputStream os = s.openWrite(name, 0, size > 0 ? size : -1)) { copy(in, os, (k) -> { done[0] += k; progress(ev, id, done[0], Math.max(total, done[0])); }); s.fsync(os); }
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
