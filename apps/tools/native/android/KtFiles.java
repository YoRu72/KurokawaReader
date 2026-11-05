package app.kurokawa.tools;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.ThumbnailUtils;
import android.os.Build;
import android.os.Environment;
import android.os.StatFs;
import android.util.Base64;
import android.webkit.MimeTypeMap;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The Files add-on's hands on the device: a folder listed fast (one directory stream, the attributes read with each
 * entry — no second call per file — in the order they come; the page sorts), the storages (the phone, SD cards, USB
 * drives, the app's own folder) with their free space, pictures made small, and the operations — copy, move,
 * delete, rename, new folder — run as jobs with their progress told as events (bytes, the file at hand), cancellable,
 * a name taken by another file resolved as the page asks (skip, replace, keep both). A move on one storage is a
 * rename; across storages a copy then a delete. Plain Android, no libraries.
 */
final class KtFiles {
    private KtFiles() {}

    /* ---------- listing ---------- */
    /** The entries of `dir`: name, path, dir, size, mtime, ext, hidden (and a child count for folders when `counts`). */
    static JSONObject list(File dir, boolean counts, boolean hidden) throws Exception {
        JSONObject r = new JSONObject(); JSONArray out = new JSONArray();
        if (!dir.isDirectory()) { r.put("exists", false); r.put("entries", out); return r; }
        Path p = dir.toPath(); int n = 0;
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(p)) {
            for (Path c : ds) {
                String name = c.getFileName().toString(); if (!hidden && name.startsWith(".")) continue;
                BasicFileAttributes a; try { a = Files.readAttributes(c, BasicFileAttributes.class); } catch (IOException e) { continue; }
                JSONObject o = new JSONObject(); o.put("name", name); o.put("path", c.toString()); boolean d = a.isDirectory(); o.put("dir", d);
                o.put("size", d ? 0 : a.size()); o.put("mtime", a.lastModifiedTime().toMillis()); if (!d) o.put("ext", extOf(name)); if (name.startsWith(".")) o.put("hidden", true);
                if (d && counts) { String[] k = c.toFile().list(); o.put("count", k == null ? -1 : k.length); }
                out.put(o); if (++n >= 20000) break;
            }
        }
        r.put("exists", true); r.put("entries", out); r.put("path", dir.getAbsolutePath()); r.put("truncated", n >= 20000);
        return r;
    }
    static String extOf(String name) { int i = name.lastIndexOf('.'); return i > 0 && i < name.length() - 1 && name.length() - i <= 8 ? name.substring(i + 1).toLowerCase(Locale.ROOT) : ""; }
    static String mimeOf(String name) { String e = extOf(name); String m = e.isEmpty() ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(e); if (m == null) m = KtStream.mimeOf(name); return m == null || m.isEmpty() ? "application/octet-stream" : m; }

    /** One file or folder up close: its size (a folder's counted whole, with how many files and folders), times, kind. */
    static JSONObject stat(File f, AtomicBoolean cancel) throws Exception {
        JSONObject o = new JSONObject(); o.put("name", f.getName()); o.put("path", f.getAbsolutePath()); o.put("exists", f.exists()); o.put("dir", f.isDirectory()); o.put("mtime", f.lastModified());
        o.put("readable", f.canRead()); o.put("writable", f.canWrite()); o.put("hidden", f.getName().startsWith("."));
        if (f.isDirectory()) { long[] t = { 0, 0, 0 }; walkSize(f, t, cancel); o.put("size", t[0]); o.put("files", t[1]); o.put("folders", t[2]); }
        else { o.put("size", f.length()); o.put("ext", extOf(f.getName())); o.put("mime", mimeOf(f.getName())); }
        return o;
    }
    private static void walkSize(File d, long[] t, AtomicBoolean cancel) {
        File[] k = d.listFiles(); if (k == null) return;
        for (File c : k) { if (cancel != null && cancel.get()) return; if (c.isDirectory()) { t[2]++; walkSize(c, t, cancel); } else { t[1]++; t[0] += c.length(); } }
    }

    /* ---------- the storages ---------- */
    /** Every storage the phone has: the app's folder, the phone's own storage, each SD card and USB drive, with free
     *  and total space; and whether the app may read everything (All files access) — else only its own folders. */
    static JSONObject roots(Context ctx, File appDir) throws Exception {
        JSONObject r = new JSONObject(); JSONArray a = new JSONArray();
        boolean all = Build.VERSION.SDK_INT < 30 ? ctx.checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE) == android.content.pm.PackageManager.PERMISSION_GRANTED : Environment.isExternalStorageManager();
        r.put("allFiles", all);
        a.put(root("app", appDir, "Kurokawa", true));
        File ext = Environment.getExternalStorageDirectory(); if (ext != null) a.put(root("phone", ext, null, all));
        for (File f : ctx.getExternalFilesDirs(null)) {
            if (f == null) continue; String p = f.getAbsolutePath(); int i = p.indexOf("/Android/"); if (i <= 0) continue; File vol = new File(p.substring(0, i));
            if (ext != null && vol.getAbsolutePath().equals(ext.getAbsolutePath())) continue;
            boolean removable = true; try { removable = Environment.isExternalStorageRemovable(f); } catch (Exception ignored) {}
            a.put(root(removable ? "sd" : "phone2", vol, null, all).put("appFolder", f.getAbsolutePath()));
        }
        // (Drives mounted at /storage that the system did not list for the app — a USB stick on some phones.)
        File st = new File("/storage"); File[] ks = st.listFiles();
        if (ks != null) for (File k : ks) { String n = k.getName(); if (n.equals("emulated") || n.equals("self") || !k.isDirectory() || !k.canRead()) continue; boolean had = false; for (int i = 0; i < a.length(); i++) if (a.getJSONObject(i).optString("path").equals(k.getAbsolutePath())) had = true; if (!had) a.put(root("usb", k, null, all)); }
        r.put("roots", a); return r;
    }
    private static JSONObject root(String kind, File f, String name, boolean readable) throws Exception {
        JSONObject o = new JSONObject(); o.put("kind", kind); o.put("path", f.getAbsolutePath()); o.put("name", name == null ? f.getName() : name); o.put("readable", readable && f.canRead());
        try { StatFs s = new StatFs(f.getAbsolutePath()); o.put("free", s.getAvailableBytes()); o.put("total", s.getTotalBytes()); } catch (Exception ignored) {}
        return o;
    }

    /* ---------- a small picture of a file (a photo, a video's frame, an app's icon) ---------- */
    static final Map<String, String> thumbs = new ConcurrentHashMap<>();
    /** A small picture inside an archive, as a data: URL (pictures only; the entry is decoded from its stream). */
    static String archiveThumb(File f, String password, String entry, int px) {
        if (!entry.toLowerCase(java.util.Locale.ROOT).matches(".*\\.(jpe?g|png|webp|gif|bmp)$")) return null;
        try (KtArchive.Opened o = KtArchive.open(f, password, entry)) {
            if (o.size > 24L << 20) return null;
            byte[] bytes = new byte[(int) Math.max(0, o.size)]; int at = 0; while (at < bytes.length) { int n = o.in.read(bytes, at, bytes.length - at); if (n <= 0) break; at += n; }
            android.graphics.BitmapFactory.Options bo = new android.graphics.BitmapFactory.Options(); bo.inJustDecodeBounds = true; android.graphics.BitmapFactory.decodeByteArray(bytes, 0, at, bo);
            int s = 1; while (bo.outWidth / s > px * 2 && bo.outHeight / s > px * 2) s *= 2;
            android.graphics.BitmapFactory.Options b2 = new android.graphics.BitmapFactory.Options(); b2.inSampleSize = s; android.graphics.Bitmap full = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, at, b2); if (full == null) return null;
            android.graphics.Bitmap b = android.media.ThumbnailUtils.extractThumbnail(full, px, px, android.media.ThumbnailUtils.OPTIONS_RECYCLE_INPUT);
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream(); b.compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, out); b.recycle();
            return "data:image/jpeg;base64," + android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP);
        } catch (Throwable e) { return null; }
    }

    static String thumb(Context ctx, File f, int px) {
        String key = f.getAbsolutePath() + "|" + f.lastModified() + "|" + px; String had = thumbs.get(key); if (had != null) return had;
        Bitmap b = null; String name = f.getName().toLowerCase(Locale.ROOT);
        try {
            if (name.matches(".*\\.(jpe?g|png|webp|gif|bmp|heic|avif)$")) {
                BitmapFactory.Options o = new BitmapFactory.Options(); o.inJustDecodeBounds = true; BitmapFactory.decodeFile(f.getAbsolutePath(), o);
                int s = 1; while (o.outWidth / s > px * 2 && o.outHeight / s > px * 2) s *= 2;
                BitmapFactory.Options o2 = new BitmapFactory.Options(); o2.inSampleSize = s; Bitmap full = BitmapFactory.decodeFile(f.getAbsolutePath(), o2);
                if (full != null) { b = ThumbnailUtils.extractThumbnail(full, px, px, ThumbnailUtils.OPTIONS_RECYCLE_INPUT); }
            } else if (name.matches(".*\\.(mp4|mkv|webm|m4v|mov|avi|3gp|ts|flv|wmv)$")) {
                b = Build.VERSION.SDK_INT >= 29 ? ThumbnailUtils.createVideoThumbnail(f, new android.util.Size(px, px), null) : ThumbnailUtils.createVideoThumbnail(f.getAbsolutePath(), android.provider.MediaStore.Images.Thumbnails.MINI_KIND);
            } else if (name.endsWith(".apk")) {
                android.content.pm.PackageInfo pi = ctx.getPackageManager().getPackageArchiveInfo(f.getAbsolutePath(), 0);
                if (pi != null) { pi.applicationInfo.sourceDir = f.getAbsolutePath(); pi.applicationInfo.publicSourceDir = f.getAbsolutePath(); android.graphics.drawable.Drawable d = pi.applicationInfo.loadIcon(ctx.getPackageManager()); b = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888); android.graphics.Canvas c = new android.graphics.Canvas(b); d.setBounds(0, 0, px, px); d.draw(c); }
            }
        } catch (Throwable ignored) {}
        if (b == null) return null;
        ByteArrayOutputStream bo = new ByteArrayOutputStream(); b.compress(name.endsWith(".apk") || name.endsWith(".png") ? Bitmap.CompressFormat.PNG : Bitmap.CompressFormat.JPEG, 80, bo); b.recycle();
        String url = "data:image/" + (name.endsWith(".apk") || name.endsWith(".png") ? "png" : "jpeg") + ";base64," + Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP);
        if (thumbs.size() > 600) thumbs.clear(); thumbs.put(key, url); return url;
    }

    /* ---------- the jobs: copy, move, delete ---------- */
    interface Events { void on(JSONObject ev); }
    static final class Job { final String id; final AtomicBoolean cancel = new AtomicBoolean(); volatile String conflict = "ask"; final Object lock = new Object(); volatile String answer; Job(String id) { this.id = id; } }
    static final Map<String, Job> jobs = new ConcurrentHashMap<>();
    static void cancel(String id) { Job j = jobs.get(id); if (j != null) { j.cancel.set(true); synchronized (j.lock) { j.answer = "skip"; j.lock.notifyAll(); } } }
    /** The page's answer to a name already taken: skip, replace, keep (both), or the same for all that follow (…All). */
    static void answer(String id, String what) { Job j = jobs.get(id); if (j == null) return; synchronized (j.lock) { if (what.endsWith("All")) j.conflict = what.substring(0, what.length() - 3); j.answer = what.replace("All", ""); j.lock.notifyAll(); } }

    /** `op` (copy | move | delete) on `paths`, into `dest` (a folder) for copy and move. */
    static void run(String id, String op, List<File> paths, File dest, String conflict, Events ev) {
        Job j = new Job(id); j.conflict = conflict == null ? "ask" : conflict; jobs.put(id, j);
        long[] total = { 0, 0 }; // bytes, files
        try {
            if (!op.equals("delete")) for (File f : paths) count(f, total, j.cancel);
            else for (File f : paths) { long[] t = { 0, 0, 0 }; walkSize(f, t, j.cancel); total[0] += t[0]; total[1] += t[1] + t[2] + 1; }
            long[] done = { 0, 0 }; JSONArray failed = new JSONArray(); long[] lastTold = { 0 };
            for (File f : paths) {
                if (j.cancel.get()) break;
                try {
                    if (op.equals("delete")) deleteTree(f, j, done, total, ev, lastTold);
                    else {
                        File to = new File(dest, f.getName());
                        if (op.equals("move") && sameStorage(f, dest) && !to.exists() && f.renameTo(to)) { done[0] += sizeOfQuick(f, total); done[1]++; progress(ev, j, done, total, f.getName(), lastTold, true); continue; }
                        copyTree(f, to, j, done, total, ev, lastTold);
                        if (op.equals("move") && !j.cancel.get()) deleteTree(f, j, new long[2], new long[2], null, lastTold);
                    }
                } catch (Exception e) { if (j.cancel.get()) break; failed.put(f.getName() + ": " + e.getMessage()); }
            }
            JSONObject end = new JSONObject(); end.put("id", id); end.put("status", j.cancel.get() ? "cancelled" : "done"); end.put("done", done[0]); end.put("total", total[0]); end.put("files", done[1]); end.put("failed", failed); ev.on(end);
        } catch (Exception e) {
            try { JSONObject end = new JSONObject(); end.put("id", id); end.put("status", "failed"); end.put("message", String.valueOf(e.getMessage())); ev.on(end); } catch (Exception ignored) {}
        } finally { jobs.remove(id); }
    }
    private static long sizeOfQuick(File f, long[] total) { return f.isDirectory() ? 0 : f.length(); }
    private static void count(File f, long[] t, AtomicBoolean cancel) { if (cancel.get()) return; if (f.isDirectory()) { File[] k = f.listFiles(); if (k != null) for (File c : k) count(c, t, cancel); } else { t[0] += f.length(); t[1]++; } }
    private static boolean sameStorage(File a, File b) { try { return Files.getFileStore(a.toPath()).equals(Files.getFileStore(b.toPath())); } catch (Exception e) { return false; } }
    private static void progress(Events ev, Job j, long[] done, long[] total, String name, long[] lastTold, boolean force) {
        long now = System.currentTimeMillis(); if (!force && now - lastTold[0] < 200) return; lastTold[0] = now;
        try { JSONObject o = new JSONObject(); o.put("id", j.id); o.put("status", "progress"); o.put("done", done[0]); o.put("total", total[0]); o.put("files", done[1]); o.put("ofFiles", total[1]); o.put("name", name); ev.on(o); } catch (Exception ignored) {}
    }
    /** What to do about `to` already there: the job's standing answer, else the page asked and waited for. */
    private static String resolve(Job j, File from, File to, Events ev) throws Exception {
        if (!j.conflict.equals("ask")) return j.conflict;
        JSONObject o = new JSONObject(); o.put("id", j.id); o.put("status", "conflict"); o.put("from", from.getAbsolutePath()); o.put("to", to.getAbsolutePath()); o.put("size", from.isFile() ? from.length() : 0); o.put("existingSize", to.isFile() ? to.length() : 0); o.put("mtime", from.lastModified()); o.put("existingMtime", to.lastModified()); o.put("dir", from.isDirectory());
        synchronized (j.lock) { j.answer = null; ev.on(o); while (j.answer == null && !j.cancel.get()) j.lock.wait(60000); String a = j.answer == null ? "skip" : j.answer; return a; }
    }
    static File keepBoth(File to) { String n = to.getName(); String ext = extOf(n); String stem = ext.isEmpty() ? n : n.substring(0, n.length() - ext.length() - 1); for (int i = 1; i < 10000; i++) { File c = new File(to.getParentFile(), stem + " (" + i + ")" + (ext.isEmpty() ? "" : "." + ext)); if (!c.exists()) return c; } return to; }
    private static void copyTree(File from, File to, Job j, long[] done, long[] total, Events ev, long[] lastTold) throws Exception {
        if (j.cancel.get()) return;
        if (from.isDirectory()) {
            if (to.isFile()) { String a = resolve(j, from, to, ev); if (a.equals("skip")) return; if (a.equals("keep")) to = keepBoth(to); else if (!to.delete()) throw new IOException("cannot replace " + to.getName()); }
            if (!to.isDirectory() && !to.mkdirs()) throw new IOException("cannot make " + to.getName());
            File[] k = from.listFiles(); if (k != null) for (File c : k) copyTree(c, new File(to, c.getName()), j, done, total, ev, lastTold);
            return;
        }
        if (to.exists()) { String a = resolve(j, from, to, ev); if (a.equals("skip")) { done[0] += from.length(); done[1]++; return; } if (a.equals("keep")) to = keepBoth(to); }
        File part = new File(to.getParentFile(), to.getName() + ".ktpart");
        try (InputStream in = new FileInputStream(from); OutputStream out = new FileOutputStream(part)) {
            byte[] b = new byte[1 << 18]; int n;
            while ((n = in.read(b)) > 0) { if (j.cancel.get()) { part.delete(); return; } out.write(b, 0, n); done[0] += n; progress(ev, j, done, total, from.getName(), lastTold, false); }
        }
        if (to.exists() && !to.delete()) { part.delete(); throw new IOException("cannot replace " + to.getName()); }
        if (!part.renameTo(to)) { part.delete(); throw new IOException("cannot write " + to.getName()); }
        to.setLastModified(from.lastModified()); done[1]++; progress(ev, j, done, total, from.getName(), lastTold, true);
    }
    private static void deleteTree(File f, Job j, long[] done, long[] total, Events ev, long[] lastTold) throws Exception {
        if (j.cancel.get()) return;
        if (f.isDirectory()) { File[] k = f.listFiles(); if (k != null) for (File c : k) deleteTree(c, j, done, total, ev, lastTold); }
        long sz = f.isFile() ? f.length() : 0;
        if (!f.delete() && f.exists()) throw new IOException("cannot delete " + f.getName());
        done[0] += sz; done[1]++; if (ev != null) progress(ev, j, done, total, f.getName(), lastTold, false);
    }

    /* ---------- the collections: the phone's media index by kind, and what changed last ---------- */
    /** `kind`: recent | image | audio | video | doc | apk | archive — the files of that kind from Android's media index, newest first. */
    static JSONArray collection(Context ctx, String kind, int limit) {
        JSONArray out = new JSONArray();
        android.net.Uri uri = android.provider.MediaStore.Files.getContentUri("external");
        String sel = null; String[] args = null;
        switch (kind) {
            case "image": sel = android.provider.MediaStore.Files.FileColumns.MEDIA_TYPE + "=" + android.provider.MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE; break;
            case "audio": sel = android.provider.MediaStore.Files.FileColumns.MEDIA_TYPE + "=" + android.provider.MediaStore.Files.FileColumns.MEDIA_TYPE_AUDIO; break;
            case "video": sel = android.provider.MediaStore.Files.FileColumns.MEDIA_TYPE + "=" + android.provider.MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO; break;
            case "doc": sel = "(" + android.provider.MediaStore.Files.FileColumns.MIME_TYPE + " LIKE 'application/pdf' OR " + android.provider.MediaStore.Files.FileColumns.MIME_TYPE + " LIKE 'application/epub%' OR " + android.provider.MediaStore.Files.FileColumns.MIME_TYPE + " LIKE 'application/vnd.openxmlformats%' OR " + android.provider.MediaStore.Files.FileColumns.MIME_TYPE + " LIKE 'application/msword' OR " + android.provider.MediaStore.Files.FileColumns.MIME_TYPE + " LIKE 'text/%' OR " + android.provider.MediaStore.Files.FileColumns.DISPLAY_NAME + " LIKE '%.epub' OR " + android.provider.MediaStore.Files.FileColumns.DISPLAY_NAME + " LIKE '%.pdf')"; break;
            case "apk": sel = "(" + android.provider.MediaStore.Files.FileColumns.DISPLAY_NAME + " LIKE '%.apk' OR " + android.provider.MediaStore.Files.FileColumns.DISPLAY_NAME + " LIKE '%.apks' OR " + android.provider.MediaStore.Files.FileColumns.DISPLAY_NAME + " LIKE '%.xapk' OR " + android.provider.MediaStore.Files.FileColumns.DISPLAY_NAME + " LIKE '%.apkm')"; break;
            case "archive": sel = "(" + android.provider.MediaStore.Files.FileColumns.DISPLAY_NAME + " LIKE '%.zip' OR " + android.provider.MediaStore.Files.FileColumns.DISPLAY_NAME + " LIKE '%.7z' OR " + android.provider.MediaStore.Files.FileColumns.DISPLAY_NAME + " LIKE '%.rar' OR " + android.provider.MediaStore.Files.FileColumns.DISPLAY_NAME + " LIKE '%.tar' OR " + android.provider.MediaStore.Files.FileColumns.DISPLAY_NAME + " LIKE '%.gz' OR " + android.provider.MediaStore.Files.FileColumns.DISPLAY_NAME + " LIKE '%.xz')"; break;
            default: sel = android.provider.MediaStore.Files.FileColumns.MEDIA_TYPE + "!=" + android.provider.MediaStore.Files.FileColumns.MEDIA_TYPE_NONE + " OR " + android.provider.MediaStore.Files.FileColumns.MIME_TYPE + " IS NOT NULL";
        }
        String[] cols = { android.provider.MediaStore.Files.FileColumns.DATA, android.provider.MediaStore.Files.FileColumns.DISPLAY_NAME, android.provider.MediaStore.Files.FileColumns.SIZE, android.provider.MediaStore.Files.FileColumns.DATE_MODIFIED };
        try (android.database.Cursor c = ctx.getContentResolver().query(uri, cols, sel, args, android.provider.MediaStore.Files.FileColumns.DATE_MODIFIED + " DESC")) {
            if (c != null) while (c.moveToNext() && out.length() < limit) {
                String path = c.getString(0); if (path == null) continue; File f = new File(path); if (!f.isFile()) continue;
                JSONObject o = new JSONObject(); String name = c.getString(1) == null ? f.getName() : c.getString(1); o.put("name", name); o.put("path", path); o.put("dir", false); o.put("size", c.getLong(2)); o.put("mtime", c.getLong(3) * 1000); o.put("ext", extOf(name)); out.put(o);
            }
        } catch (Exception ignored) {}
        return out;
    }

    /* ---------- the recycle bin: a hidden folder on each storage, each item with where it came from ---------- */
    static final String TRASH = ".kurokawa-trash";
    /** The storage root `f` lies on (the phone's, a card's) — where its bin is. */
    static File trashDirFor(Context ctx, File f) {
        String p; try { p = f.getCanonicalPath(); } catch (IOException e) { p = f.getAbsolutePath(); }
        File best = null; try { JSONArray rs = roots(ctx, KtEngine.defaultDirOf(ctx)).getJSONArray("roots"); for (int i = 0; i < rs.length(); i++) { String rp = rs.getJSONObject(i).optString("path"); String kind = rs.getJSONObject(i).optString("kind"); if (kind.equals("app")) continue; if (p.equals(rp) || p.startsWith(rp + "/")) if (best == null || rp.length() > best.getAbsolutePath().length()) best = new File(rp); } } catch (Exception ignored) {}
        if (best == null) best = Environment.getExternalStorageDirectory();
        return new File(best, TRASH);
    }
    /** `paths` moved into their storages' bins (a rename; copied and deleted across storages), each with a note of where it was. */
    static JSONObject trash(Context ctx, List<File> paths, AtomicBoolean cancel) throws Exception {
        JSONArray moved = new JSONArray(), failed = new JSONArray();
        for (File f : paths) {
            if (cancel != null && cancel.get()) break;
            try {
                File bin = trashDirFor(ctx, f); if (!bin.isDirectory() && !bin.mkdirs()) throw new IOException("cannot make the bin");
                try { new File(bin, ".nomedia").createNewFile(); } catch (IOException ignored) {}
                String id = System.currentTimeMillis() + "-" + Integer.toHexString(f.getAbsolutePath().hashCode()); File slot = new File(bin, id); if (!slot.mkdirs()) throw new IOException("cannot make the slot");
                File to = new File(slot, f.getName()); long size = f.isFile() ? f.length() : 0;
                if (!f.renameTo(to)) { Job j = new Job("trash"); long[] done = { 0, 0 }, total = { 0, 0 }; copyTree(f, to, j, done, total, (ev) -> {}, new long[1]); deleteTree(f, j, new long[2], new long[2], null, new long[1]); }
                JSONObject meta = new JSONObject(); meta.put("from", f.getAbsolutePath()); meta.put("name", f.getName()); meta.put("at", System.currentTimeMillis()); meta.put("dir", to.isDirectory()); meta.put("size", size);
                try (OutputStream o = new FileOutputStream(new File(slot, ".meta.json"))) { o.write(meta.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
                moved.put(f.getAbsolutePath());
            } catch (Exception e) { failed.put(f.getName() + ": " + e.getMessage()); }
        }
        JSONObject r = new JSONObject(); r.put("moved", moved); r.put("failed", failed); return r;
    }
    /** What the bins hold, newest first: the slot, the name, where it was, when, the size. */
    static JSONArray trashList(Context ctx) throws Exception {
        JSONArray out = new JSONArray(); JSONArray rs = roots(ctx, KtEngine.defaultDirOf(ctx)).getJSONArray("roots");
        for (int i = 0; i < rs.length(); i++) {
            if (rs.getJSONObject(i).optString("kind").equals("app")) continue; File bin = new File(rs.getJSONObject(i).optString("path"), TRASH); File[] slots = bin.listFiles(); if (slots == null) continue;
            for (File slot : slots) { if (!slot.isDirectory()) continue; File mf = new File(slot, ".meta.json"); if (!mf.isFile()) continue; try { JSONObject m = new JSONObject(head(mf, 65536)); m.put("slot", slot.getAbsolutePath()); File item = new File(slot, m.optString("name")); m.put("path", item.getAbsolutePath()); m.put("exists", item.exists()); if (item.isFile()) m.put("size", item.length()); out.put(m); } catch (Exception ignored) {} }
        }
        List<JSONObject> l = new ArrayList<>(); for (int i = 0; i < out.length(); i++) l.add(out.getJSONObject(i)); l.sort((a, b) -> Long.compare(b.optLong("at"), a.optLong("at")));
        JSONArray sorted = new JSONArray(); for (JSONObject o : l) sorted.put(o); return sorted;
    }
    /** A slot's item put back where it came from (beside it under another name when the place is taken). */
    static JSONObject trashRestore(File slot) throws Exception {
        JSONObject m = new JSONObject(head(new File(slot, ".meta.json"), 65536)); File item = new File(slot, m.optString("name")); File to = new File(m.optString("from"));
        if (to.getParentFile() != null && !to.getParentFile().isDirectory()) to.getParentFile().mkdirs();
        if (to.exists()) to = keepBoth(to);
        if (!item.renameTo(to)) { Job j = new Job("restore"); long[] d = { 0, 0 }; copyTree(item, to, j, d, d, (ev) -> {}, new long[1]); deleteTree(item, j, new long[2], new long[2], null, new long[1]); }
        deleteTree(slot, new Job("x"), new long[2], new long[2], null, new long[1]);
        JSONObject r = new JSONObject(); r.put("path", to.getAbsolutePath()); return r;
    }
    /** Slots deleted for good: the ones named, or all, or those older than `olderThanMs`. */
    static int trashEmpty(Context ctx, List<File> slots, long olderThanMs) throws Exception {
        int n = 0;
        if (slots != null) { for (File s : slots) { deleteTree(s, new Job("x"), new long[2], new long[2], null, new long[1]); n++; } return n; }
        JSONArray all = trashList(ctx); long now = System.currentTimeMillis();
        for (int i = 0; i < all.length(); i++) { JSONObject m = all.getJSONObject(i); if (olderThanMs <= 0 || now - m.optLong("at") > olderThanMs) { deleteTree(new File(m.optString("slot")), new Job("x"), new long[2], new long[2], null, new long[1]); n++; } }
        return n;
    }

    /* ---------- what a file says about itself: a photo's EXIF, a recording's tags, an app's name and version ---------- */
    static JSONObject meta(Context ctx, File f) throws Exception {
        JSONObject o = new JSONObject(); String n = f.getName().toLowerCase(Locale.ROOT);
        if (n.matches(".*\\.(jpe?g|png|webp|heic|dng|tiff?)$")) {
            try {
                android.media.ExifInterface ex = new android.media.ExifInterface(f.getAbsolutePath()); JSONObject e = new JSONObject();
                String[][] tags = { { "make", android.media.ExifInterface.TAG_MAKE }, { "model", android.media.ExifInterface.TAG_MODEL }, { "aperture", android.media.ExifInterface.TAG_F_NUMBER }, { "exposure", android.media.ExifInterface.TAG_EXPOSURE_TIME }, { "iso", android.media.ExifInterface.TAG_ISO_SPEED_RATINGS }, { "focal", android.media.ExifInterface.TAG_FOCAL_LENGTH }, { "flash", android.media.ExifInterface.TAG_FLASH }, { "whiteBalance", android.media.ExifInterface.TAG_WHITE_BALANCE }, { "taken", android.media.ExifInterface.TAG_DATETIME_ORIGINAL }, { "software", android.media.ExifInterface.TAG_SOFTWARE }, { "width", android.media.ExifInterface.TAG_IMAGE_WIDTH }, { "height", android.media.ExifInterface.TAG_IMAGE_LENGTH }, { "orientation", android.media.ExifInterface.TAG_ORIENTATION } };
                for (String[] t : tags) { String v = ex.getAttribute(t[1]); if (v != null && !v.isEmpty()) e.put(t[0], v); }
                float[] ll = new float[2]; if (ex.getLatLong(ll)) { e.put("lat", ll[0]); e.put("lon", ll[1]); }
                if (!e.has("width")) { BitmapFactory.Options bo = new BitmapFactory.Options(); bo.inJustDecodeBounds = true; BitmapFactory.decodeFile(f.getAbsolutePath(), bo); if (bo.outWidth > 0) { e.put("width", bo.outWidth); e.put("height", bo.outHeight); } }
                o.put("exif", e);
            } catch (Exception ignored) {}
        } else if (n.matches(".*\\.(mp3|m4a|flac|ogg|opus|wav|aac|wma|mp4|mkv|webm|m4v|mov|avi|3gp|ts)$")) {
            android.media.MediaMetadataRetriever r = new android.media.MediaMetadataRetriever();
            try {
                r.setDataSource(f.getAbsolutePath()); JSONObject m = new JSONObject();
                int[][] keys = { { android.media.MediaMetadataRetriever.METADATA_KEY_TITLE }, { android.media.MediaMetadataRetriever.METADATA_KEY_ARTIST }, { android.media.MediaMetadataRetriever.METADATA_KEY_ALBUM }, { android.media.MediaMetadataRetriever.METADATA_KEY_GENRE }, { android.media.MediaMetadataRetriever.METADATA_KEY_YEAR }, { android.media.MediaMetadataRetriever.METADATA_KEY_DURATION }, { android.media.MediaMetadataRetriever.METADATA_KEY_BITRATE }, { android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH }, { android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT }, { android.media.MediaMetadataRetriever.METADATA_KEY_MIMETYPE } };
                String[] names = { "title", "artist", "album", "genre", "year", "duration", "bitrate", "width", "height", "mime" };
                for (int i = 0; i < keys.length; i++) { String v = r.extractMetadata(keys[i][0]); if (v != null && !v.isEmpty()) m.put(names[i], v); }
                o.put("media", m);
            } catch (Exception ignored) {} finally { try { r.release(); } catch (Exception ignored) {} }
        } else if (n.endsWith(".apk")) {
            try { android.content.pm.PackageInfo pi = ctx.getPackageManager().getPackageArchiveInfo(f.getAbsolutePath(), 0); if (pi != null) { pi.applicationInfo.sourceDir = f.getAbsolutePath(); pi.applicationInfo.publicSourceDir = f.getAbsolutePath(); JSONObject a = new JSONObject(); a.put("label", String.valueOf(ctx.getPackageManager().getApplicationLabel(pi.applicationInfo))); a.put("package", pi.packageName); a.put("version", pi.versionName == null ? "" : pi.versionName); a.put("minSdk", Build.VERSION.SDK_INT >= 24 ? pi.applicationInfo.minSdkVersion : 0); a.put("targetSdk", pi.applicationInfo.targetSdkVersion); try { android.content.pm.PackageInfo inst = ctx.getPackageManager().getPackageInfo(pi.packageName, 0); a.put("installedVersion", inst.versionName); } catch (Exception ignored) {} o.put("apk", a); } } catch (Exception ignored) {}
        }
        return o;
    }
    /** Text written to a file (the editor's save), by way of a part file. */
    static void write(File f, String text) throws IOException {
        File part = new File(f.getParentFile(), f.getName() + ".ktpart");
        try (OutputStream o = new FileOutputStream(part)) { o.write(text.getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
        if (f.exists() && !f.delete()) { part.delete(); throw new IOException("cannot replace"); } if (!part.renameTo(f)) { part.delete(); throw new IOException("cannot write"); }
    }

    /* ---------- the storage analyzer: what takes the room, what is doubled, old, screenshots, leftovers ---------- */
    static final class Seen { final File f; final long size; Seen(File f, long size) { this.f = f; this.size = size; } }
    static JSONObject analyze(File root, AtomicBoolean cancel, Events progress) throws Exception {
        List<Seen> all = new ArrayList<>(); Map<String, long[]> byKind = new LinkedHashMap<>(); Map<String, long[]> byFolder = new LinkedHashMap<>();
        long[] count = { 0 }; long[] lastTold = { 0 };
        walkAnalyze(root, root, all, byKind, byFolder, count, cancel, progress, lastTold, 0);
        JSONObject r = new JSONObject(); long total = 0; for (Seen x : all) total += x.size; r.put("total", total); r.put("files", all.size());
        all.sort((a, b) -> Long.compare(b.size, a.size));
        r.put("largest", seenList(all.subList(0, Math.min(60, all.size()))));
        long year = System.currentTimeMillis() - 365L * 86400000; List<Seen> old = new ArrayList<>(); for (Seen x : all) if (x.f.lastModified() < year && x.size > 1 << 20) old.add(x); r.put("old", seenList(old.subList(0, Math.min(60, old.size()))));
        List<Seen> shots = new ArrayList<>(); for (Seen x : all) { String p = x.f.getAbsolutePath(); if (p.contains("/Screenshots/") || x.f.getName().toLowerCase(Locale.ROOT).startsWith("screenshot")) shots.add(x); } r.put("screenshots", seenList(shots.subList(0, Math.min(200, shots.size())))); long sh = 0; for (Seen x : shots) sh += x.size; r.put("screenshotsSize", sh); r.put("screenshotsCount", shots.size());
        List<Seen> temp = new ArrayList<>(); for (Seen x : all) { String n = x.f.getName().toLowerCase(Locale.ROOT); String p = x.f.getAbsolutePath(); if (n.endsWith(".part") || n.endsWith(".ktpart") || n.endsWith(".tmp") || n.endsWith(".temp") || n.endsWith(".crdownload") || n.endsWith(".log") || p.contains("/cache/") || p.contains("/.cache/") || p.contains("/.thumbnails/") || p.contains("/.trash") || p.contains("/.kurokawa-trash/")) temp.add(x); } r.put("temp", seenList(temp.subList(0, Math.min(200, temp.size())))); long tp = 0; for (Seen x : temp) tp += x.size; r.put("tempSize", tp); r.put("tempCount", temp.size());
        List<Seen> apks = new ArrayList<>(); for (Seen x : all) if (x.f.getName().toLowerCase(Locale.ROOT).matches(".*\\.(apk|apks|xapk|apkm)$")) apks.add(x); r.put("apks", seenList(apks.subList(0, Math.min(60, apks.size()))));
        // (Doubles: the same size, then the same first and last pieces, then the same whole hash — only then are two the same.)
        Map<Long, List<Seen>> bySize = new java.util.HashMap<>(); for (Seen x : all) if (x.size >= 64 << 10) bySize.computeIfAbsent(x.size, k -> new ArrayList<>()).add(x);
        JSONArray dups = new JSONArray(); long dupSize = 0; int groups = 0;
        for (List<Seen> l : bySize.values()) { if (l.size() < 2 || (cancel != null && cancel.get()) || groups >= 80) continue; Map<String, List<Seen>> byHash = new java.util.HashMap<>(); for (Seen x : l) { String hsh = quickHash(x.f); if (hsh != null) byHash.computeIfAbsent(hsh, k -> new ArrayList<>()).add(x); } for (List<Seen> g : byHash.values()) { if (g.size() < 2) continue; JSONObject o = new JSONObject(); o.put("size", g.get(0).size); o.put("files", seenList(g)); dups.put(o); dupSize += g.get(0).size * (g.size() - 1); groups++; } }
        r.put("duplicates", dups); r.put("duplicatesSize", dupSize);
        JSONArray kinds = new JSONArray(); for (Map.Entry<String, long[]> e : byKind.entrySet()) { JSONObject o = new JSONObject(); o.put("kind", e.getKey()); o.put("size", e.getValue()[0]); o.put("count", e.getValue()[1]); kinds.put(o); } r.put("kinds", kinds);
        List<Map.Entry<String, long[]>> folders = new ArrayList<>(byFolder.entrySet()); folders.sort((a, b) -> Long.compare(b.getValue()[0], a.getValue()[0]));
        JSONArray fa = new JSONArray(); for (Map.Entry<String, long[]> e : folders.subList(0, Math.min(40, folders.size()))) { JSONObject o = new JSONObject(); o.put("path", e.getKey()); o.put("size", e.getValue()[0]); o.put("count", e.getValue()[1]); fa.put(o); } r.put("folders", fa);
        return r;
    }
    private static JSONArray seenList(List<Seen> l) throws Exception { JSONArray a = new JSONArray(); for (Seen x : l) { JSONObject o = new JSONObject(); o.put("name", x.f.getName()); o.put("path", x.f.getAbsolutePath()); o.put("size", x.size); o.put("mtime", x.f.lastModified()); o.put("dir", false); o.put("ext", extOf(x.f.getName())); a.put(o); } return a; }
    static String kindOf(String name) { String e = extOf(name); if (e.matches("jpe?g|png|gif|webp|bmp|heic|avif|svg")) return "image"; if (e.matches("mp3|m4a|flac|ogg|opus|wav|aac|wma")) return "audio"; if (e.matches("mp4|mkv|webm|m4v|mov|avi|ts|m2ts|flv|wmv|3gp")) return "video"; if (e.matches("pdf|epub|mobi|azw3?|docx?|xlsx?|pptx?|txt|md|rtf|odt|cbz|cbr")) return "doc"; if (e.matches("zip|7z|rar|tar|gz|tgz|xz|bz2|zst|lz4|iso|001")) return "archive"; if (e.matches("apk|apks|xapk|apkm")) return "apk"; return "other"; }
    private static void walkAnalyze(File root, File d, List<Seen> all, Map<String, long[]> byKind, Map<String, long[]> byFolder, long[] count, AtomicBoolean cancel, Events progress, long[] lastTold, int depth) {
        if (depth > 24 || (cancel != null && cancel.get())) return; File[] k = d.listFiles(); if (k == null) return;
        for (File c : k) {
            if (cancel != null && cancel.get()) return;
            if (c.isDirectory()) { if (c.getName().equals("Android") && depth == 0) continue; walkAnalyze(root, c, all, byKind, byFolder, count, cancel, progress, lastTold, depth + 1); continue; }
            long sz = c.length(); all.add(new Seen(c, sz)); count[0]++;
            String kind = kindOf(c.getName()); long[] kk = byKind.computeIfAbsent(kind, x -> new long[2]); kk[0] += sz; kk[1]++;
            // (A file counts for its own folder and the ones above it, so a big folder shows whole.)
            File f = c.getParentFile(); int up = 0; while (f != null && up < 3 && (f.getAbsolutePath().equals(root.getAbsolutePath()) || f.getAbsolutePath().startsWith(root.getAbsolutePath() + "/"))) { long[] ff = byFolder.computeIfAbsent(f.getAbsolutePath(), x -> new long[2]); ff[0] += sz; ff[1]++; if (f.getAbsolutePath().equals(root.getAbsolutePath())) break; f = f.getParentFile(); up++; }
            long now = System.currentTimeMillis(); if (progress != null && now - lastTold[0] > 300) { lastTold[0] = now; try { JSONObject o = new JSONObject(); o.put("id", "analyze"); o.put("status", "progress"); o.put("files", count[0]); o.put("name", c.getName()); progress.on(o); } catch (Exception ignored) {} }
        }
    }
    private static String quickHash(File f) {
        try (java.io.RandomAccessFile r = new java.io.RandomAccessFile(f, "r")) {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-1"); byte[] b = new byte[64 << 10]; int n = r.read(b); if (n > 0) md.update(b, 0, n);
            long len = r.length(); if (len > (128 << 10)) { r.seek(len - (64 << 10)); n = r.read(b); if (n > 0) md.update(b, 0, n); r.seek(len / 2); n = r.read(b); if (n > 0) md.update(b, 0, n); }
            StringBuilder sb = new StringBuilder(); for (byte x : md.digest()) sb.append(String.format("%02x", x)); return sb.toString();
        } catch (Exception e) { return null; }
    }

    /* ---------- small things ---------- */
    static JSONObject mkdir(File d) throws Exception { JSONObject o = new JSONObject(); o.put("ok", d.isDirectory() || d.mkdirs()); o.put("path", d.getAbsolutePath()); return o; }
    static JSONObject rename(File f, String name) throws Exception {
        if (name.isEmpty() || name.contains("/") || name.equals(".") || name.equals("..")) throw new IOException("bad name");
        File to = new File(f.getParentFile(), name); if (to.exists() && !to.getAbsolutePath().equalsIgnoreCase(f.getAbsolutePath())) throw new IOException("exists");
        JSONObject o = new JSONObject(); o.put("ok", f.renameTo(to)); o.put("path", to.getAbsolutePath()); return o;
    }
    /** A folder's files that match `q` (their names, the folders below walked), up to a few hundred. */
    static JSONArray search(File dir, String q, boolean hidden, AtomicBoolean cancel) throws Exception {
        JSONArray out = new JSONArray(); String needle = q.toLowerCase(Locale.ROOT); walkSearch(dir, needle, hidden, out, cancel, 0); return out;
    }
    private static void walkSearch(File d, String q, boolean hidden, JSONArray out, AtomicBoolean cancel, int depth) throws Exception {
        if (depth > 12 || out.length() >= 400 || (cancel != null && cancel.get())) return;
        File[] k = d.listFiles(); if (k == null) return;
        for (File c : k) {
            if (!hidden && c.getName().startsWith(".")) continue;
            if (c.getName().toLowerCase(Locale.ROOT).contains(q)) { JSONObject o = new JSONObject(); o.put("name", c.getName()); o.put("path", c.getAbsolutePath()); o.put("dir", c.isDirectory()); o.put("size", c.isFile() ? c.length() : 0); o.put("mtime", c.lastModified()); if (c.isFile()) o.put("ext", extOf(c.getName())); out.put(o); if (out.length() >= 400) return; }
            if (c.isDirectory() && !c.getName().equals("Android")) walkSearch(c, q, hidden, out, cancel, depth + 1);
        }
    }
    /** A file read as text (its first part), for a quick look. */
    static String head(File f, int max) throws IOException { try (InputStream in = new FileInputStream(f)) { byte[] b = new byte[Math.min(max, (int) Math.min(Integer.MAX_VALUE, f.length()))]; int got = 0, n; while (got < b.length && (n = in.read(b, got, b.length - got)) > 0) got += n; return new String(b, 0, got, java.nio.charset.StandardCharsets.UTF_8); } }
    /** Shared content (content:// from another app) saved into `dir` under `name`; the file written. */
    static File saveShared(Context ctx, android.net.Uri u, File dir, String name) throws IOException {
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot make " + dir.getName());
        File to = new File(dir, name.replaceAll("[\\\\/:*?\"<>|\\u0000-\\u001f]+", " ").trim()); if (to.exists()) to = keepBoth(to);
        try (InputStream in = ctx.getContentResolver().openInputStream(u); OutputStream out = new FileOutputStream(to)) { if (in == null) throw new IOException("cannot read"); byte[] b = new byte[1 << 18]; int n; while ((n = in.read(b)) > 0) out.write(b, 0, n); }
        return to;
    }
    static Map<String, Object> nameAndSize(Context ctx, android.net.Uri u) {
        Map<String, Object> m = new LinkedHashMap<>(); String name = null; long size = -1;
        try (android.database.Cursor c = ctx.getContentResolver().query(u, null, null, null, null)) { if (c != null && c.moveToFirst()) { int ni = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME), si = c.getColumnIndex(android.provider.OpenableColumns.SIZE); if (ni >= 0) name = c.getString(ni); if (si >= 0 && !c.isNull(si)) size = c.getLong(si); } } catch (Exception ignored) {}
        if (name == null) name = u.getLastPathSegment() == null ? "file" : u.getLastPathSegment();
        m.put("name", name); m.put("size", size); m.put("mime", ctx.getContentResolver().getType(u)); return m;
    }
}
