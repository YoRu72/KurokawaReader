package app.kurokawa.tools;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.security.MessageDigest;

/** Files known by what they hold: each finished download's SHA-256 kept in an index (hash → path); a second download
 *  of the same bytes, on the same file system, becomes a hard link to the first — the room taken once — and the
 *  bytes saved are counted. Hashing is streamed (one megabyte at a time) after the download, off the UI. */
final class KtDedupe {
    private KtDedupe() {}
    private static final String TAG = "KtDedupe";
    private static final Object lock = new Object();

    static File indexFile(Context ctx) { return new File(new File(ctx.getFilesDir(), "kt"), "dedupe.json"); }
    static JSONObject index(Context ctx) { synchronized (lock) { try { File f = indexFile(ctx); if (f.length() > 0) return new JSONObject(new String(java.nio.file.Files.readAllBytes(f.toPath()), java.nio.charset.StandardCharsets.UTF_8)); } catch (Throwable e) { Log.w(TAG, "index: " + e); } return new JSONObject(); } }
    private static void save(Context ctx, JSONObject o) { synchronized (lock) { try { File f = indexFile(ctx); File tmp = new File(f.getParentFile(), "dedupe.json.tmp"); java.nio.file.Files.write(tmp.toPath(), o.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)); if (!tmp.renameTo(f)) { java.nio.file.Files.move(tmp.toPath(), f.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING); } } catch (Throwable e) { Log.w(TAG, "save: " + e); } } }

    static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256"); byte[] buf = new byte[1 << 20];
        try (InputStream in = new FileInputStream(f)) { int n; while ((n = in.read(buf)) > 0) md.update(buf, 0, n); }
        StringBuilder sb = new StringBuilder(); for (byte b : md.digest()) sb.append(String.format(java.util.Locale.US, "%02x", b)); return sb.toString();
    }
    /** The finished file hashed and indexed; when the same bytes already sit elsewhere on the same file system, this
     *  file becomes a hard link to them. Returns {sha256, linked, savedBytes}. */
    static JSONObject onDone(Context ctx, File f) throws Exception {
        JSONObject r = new JSONObject(); if (!f.isFile() || f.length() == 0) return r;
        String sha = sha256(f); r.put("sha256", sha);
        JSONObject idx = index(ctx); JSONObject files = idx.optJSONObject("files"); if (files == null) { files = new JSONObject(); idx.put("files", files); }
        JSONObject had = files.optJSONObject(sha); File prior = had == null ? null : new File(had.optString("path"));
        if (prior != null && prior.isFile() && prior.length() == f.length() && !prior.getCanonicalPath().equals(f.getCanonicalPath()) && !sameInode(prior, f)) {
            // (Linked: the new file replaced by a link to the old one — atomically, by a link made beside it and renamed over.)
            File tmp = new File(f.getParentFile(), "." + f.getName() + ".lnk");
            try { tmp.delete(); android.system.Os.link(prior.getAbsolutePath(), tmp.getAbsolutePath()); if (!tmp.renameTo(f)) { tmp.delete(); throw new java.io.IOException("rename"); } r.put("linked", true); r.put("savedBytes", f.length()); idx.put("saved", idx.optLong("saved") + f.length()); idx.put("links", idx.optInt("links") + 1); }
            catch (Throwable e) { tmp.delete(); Log.i(TAG, "no link (" + e.getMessage() + "): kept as a copy"); }
        }
        if (prior == null || !prior.isFile()) { JSONObject rec = new JSONObject(); rec.put("path", f.getAbsolutePath()); rec.put("size", f.length()); rec.put("at", System.currentTimeMillis()); files.put(sha, rec); }
        // (The index kept at a size: the oldest records dropped past two thousand.)
        if (files.length() > 2000) { java.util.List<String> keys = new java.util.ArrayList<>(); for (java.util.Iterator<String> it = files.keys(); it.hasNext(); ) keys.add(it.next()); final JSONObject fl = files; keys.sort((a, b) -> Long.compare(fl.optJSONObject(a).optLong("at"), fl.optJSONObject(b).optLong("at"))); for (int i = 0; i < keys.size() - 2000; i++) files.remove(keys.get(i)); }
        idx.put("hashed", idx.optInt("hashed") + 1); save(ctx, idx); return r;
    }
    private static boolean sameInode(File a, File b) { try { android.system.StructStat sa = android.system.Os.stat(a.getAbsolutePath()), sb = android.system.Os.stat(b.getAbsolutePath()); return sa.st_ino == sb.st_ino && sa.st_dev == sb.st_dev; } catch (Throwable e) { return false; } }
    /** What the index knows: files hashed, links made, bytes saved, and how many indexed files are still there. */
    static JSONObject stats(Context ctx) throws Exception {
        JSONObject idx = index(ctx); JSONObject files = idx.optJSONObject("files"); int present = 0; long bytes = 0;
        if (files != null) for (java.util.Iterator<String> it = files.keys(); it.hasNext(); ) { JSONObject rec = files.optJSONObject(it.next()); File f = new File(rec.optString("path")); if (f.isFile()) { present++; bytes += f.length(); } }
        JSONObject o = new JSONObject(); o.put("hashed", idx.optInt("hashed")); o.put("links", idx.optInt("links")); o.put("saved", idx.optLong("saved")); o.put("present", present); o.put("bytes", bytes); return o;
    }
}
