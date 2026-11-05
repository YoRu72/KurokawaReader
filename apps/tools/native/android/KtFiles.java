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
