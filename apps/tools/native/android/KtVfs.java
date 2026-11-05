package app.kurokawa.tools;

import android.content.Context;
import android.net.Uri;
import android.provider.DocumentsContract;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Two more places the Files page can browse, behind the same small face as the network storages:
 *  · root://<path> — the whole file system through a root shell (`su`) or Shizuku's shell when one is granted:
 *    listing, reading (copied into the cache), writing, folders, delete, rename, chmod/chown, mounts remounted
 *    read-write, symbolic links.
 *  · saf://<n>/<path> — a folder tree the reader granted through the system picker (Android/data, Android/obb
 *    on Android 11+, or any folder), through the documents provider.
 */
final class KtVfs {
    static final class Entry { String name; boolean dir; long size, mtime; String mode, owner, link; }

    /* ---------- the shell: su, or Shizuku ---------- */
    static final class Shell {
        final String kind; Shell(String kind) { this.kind = kind; }
        /** The first shell that answers: su (root), else Shizuku (its permission granted), else null. */
        static Shell any(Context ctx) {
            try { Process p = new ProcessBuilder("su", "-c", "id").redirectErrorStream(true).start(); String out = read(p.getInputStream()); if (p.waitFor() == 0 && out.contains("uid=0")) return new Shell("root"); } catch (Throwable ignored) {}
            try { if (shizukuReady()) return new Shell("shizuku"); } catch (Throwable ignored) {}
            return null;
        }
        static boolean shizukuReady() throws Exception {
            Class<?> sz = Class.forName("rikka.shizuku.Shizuku");
            boolean alive = (Boolean) sz.getMethod("pingBinder").invoke(null); if (!alive) return false;
            int perm = (Integer) sz.getMethod("checkSelfPermission").invoke(null); return perm == android.content.pm.PackageManager.PERMISSION_GRANTED;
        }
        /** Asks Shizuku for its permission (the result comes to its listener; the page asks again after). */
        static boolean shizukuAsk() { try { Class<?> sz = Class.forName("rikka.shizuku.Shizuku"); sz.getMethod("requestPermission", int.class).invoke(null, 7331); return true; } catch (Throwable e) { return false; } }
        Process start(String cmd) throws Exception {
            if (kind.equals("root")) return new ProcessBuilder("su", "-c", cmd).redirectErrorStream(false).start();
            Class<?> sz = Class.forName("rikka.shizuku.Shizuku"); java.lang.reflect.Method m = sz.getDeclaredMethod("newProcess", String[].class, String[].class, String.class); m.setAccessible(true);
            return (Process) m.invoke(null, new String[] { "sh", "-c", cmd }, null, null);
        }
        String run(String cmd) throws Exception { Process p = start(cmd); String out = read(p.getInputStream()); String err = read(p.getErrorStream()); int code = p.waitFor(); if (code != 0) throw new IOException((err.isEmpty() ? out : err).trim().isEmpty() ? "exit " + code : (err.isEmpty() ? out : err).trim()); return out; }
        static String read(InputStream in) throws IOException { java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream(); byte[] b = new byte[1 << 14]; int n; while ((n = in.read(b)) > 0) bo.write(b, 0, n); return new String(bo.toByteArray(), StandardCharsets.UTF_8); }
    }
    static Shell shell; static long shellAt;
    static synchronized Shell shell(Context ctx) { if (shell == null || System.currentTimeMillis() - shellAt > 60000) { shell = Shell.any(ctx); shellAt = System.currentTimeMillis(); } return shell; }
    static String q(String s) { return "'" + s.replace("'", "'\\''") + "'"; }

    /* ---------- root:// ---------- */
    static List<Entry> rootList(Context ctx, String path) throws Exception {
        Shell sh = shell(ctx); if (sh == null) throw new IOException("noRoot");
        // (toybox ls: mode, links, owner, group, size, date, time, name [-> target]; -A keeps dot files, -L not used so links show.)
        String out = sh.run("ls -lA --time-style=+%s " + q(path) + " 2>/dev/null || ls -lA " + q(path));
        List<Entry> es = new ArrayList<>();
        for (String line : out.split("\n")) {
            line = line.trim(); if (line.isEmpty() || line.startsWith("total ")) continue; String[] p = line.split("\\s+", 7); if (p.length < 7) continue;
            Entry e = new Entry(); e.mode = p[0]; e.owner = p[2] + ":" + p[3]; try { e.size = Long.parseLong(p[4]); } catch (Exception ex) { e.size = 0; }
            String rest = p[6]; String tm = p[5];
            if (tm.matches("\\d{9,}")) { e.mtime = Long.parseLong(tm) * 1000L; } else { // the fallback ls: "YYYY-MM-DD HH:MM name"
                String[] r2 = rest.split("\\s+", 2); try { e.mtime = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).parse(tm + " " + r2[0]).getTime(); } catch (Exception ex) { e.mtime = 0; } rest = r2.length > 1 ? r2[1] : rest; }
            int arrow = rest.indexOf(" -> "); if (arrow > 0) { e.link = rest.substring(arrow + 4); rest = rest.substring(0, arrow); }
            e.name = rest; e.dir = e.mode.startsWith("d") || (e.mode.startsWith("l") && e.link != null && e.link.endsWith("/"));
            if (e.mode.startsWith("l") && !e.dir) { try { String t = sh.run("[ -d " + q(path + "/" + e.name) + " ] && echo d || echo f").trim(); e.dir = t.equals("d"); } catch (Exception ignored) {} }
            es.add(e);
        }
        return es;
    }
    static File rootFetch(Context ctx, String path, AtomicBoolean stop) throws Exception {
        Shell sh = shell(ctx); if (sh == null) throw new IOException("noRoot");
        File dir = new File(ctx.getCacheDir(), "root" + path.substring(0, path.lastIndexOf('/') + 1)); dir.mkdirs(); File out = new File(dir, path.substring(path.lastIndexOf('/') + 1)); File part = new File(out.getPath() + ".part");
        Process p = sh.start("cat " + q(path)); try (InputStream in = p.getInputStream(); OutputStream os = new FileOutputStream(part)) { byte[] b = new byte[1 << 16]; int n; while ((n = in.read(b)) > 0) { if (stop != null && stop.get()) { p.destroy(); throw new IOException("stopped"); } os.write(b, 0, n); } }
        if (p.waitFor() != 0) { part.delete(); throw new IOException(Shell.read(p.getErrorStream()).trim()); }
        if (!part.renameTo(out)) throw new IOException("rename"); return out;
    }
    static void rootPut(Context ctx, File src, String dest) throws Exception {
        Shell sh = shell(ctx); if (sh == null) throw new IOException("noRoot");
        Process p = sh.start("cat > " + q(dest)); try (OutputStream os = p.getOutputStream(); InputStream in = new FileInputStream(src)) { byte[] b = new byte[1 << 16]; int n; while ((n = in.read(b)) > 0) os.write(b, 0, n); }
        if (p.waitFor() != 0) throw new IOException(Shell.read(p.getErrorStream()).trim());
    }
    static String rootRun(Context ctx, String cmd) throws Exception { Shell sh = shell(ctx); if (sh == null) throw new IOException("noRoot"); return sh.run(cmd); }
    /** The mounts, each with its device, mount point, type and whether it is read-only. */
    static JSONArray mounts(Context ctx) throws Exception {
        String out = rootRun(ctx, "cat /proc/mounts"); JSONArray a = new JSONArray();
        for (String line : out.split("\n")) { String[] p = line.trim().split("\\s+"); if (p.length < 4) continue; if (p[2].matches("proc|sysfs|cgroup2?|tmpfs|devpts|debugfs|tracefs|selinuxfs|binder|bpf|configfs|functionfs|pstore|fusectl|securityfs|overlay")) continue; JSONObject o = new JSONObject(); o.put("device", p[0]); o.put("point", p[1]); o.put("type", p[2]); o.put("ro", p[3].startsWith("ro") || p[3].contains(",ro,") || p[3].endsWith(",ro")); a.put(o); }
        return a;
    }

    /* ---------- saf://<n>/… : the trees the reader granted ---------- */
    static List<Uri> trees(Context ctx) { List<Uri> out = new ArrayList<>(); for (android.content.UriPermission p : ctx.getContentResolver().getPersistedUriPermissions()) if (p.isReadPermission() && DocumentsContract.isTreeUri(p.getUri())) out.add(p.getUri()); return out; }
    static JSONArray treeList(Context ctx) throws Exception { JSONArray a = new JSONArray(); List<Uri> ts = trees(ctx); for (int i = 0; i < ts.size(); i++) { JSONObject o = new JSONObject(); o.put("id", i); o.put("uri", ts.get(i).toString()); o.put("name", treeName(ts.get(i))); a.put(o); } return a; }
    static String treeName(Uri u) { String id = DocumentsContract.getTreeDocumentId(u); int c = id.indexOf(':'); String vol = c > 0 ? id.substring(0, c) : id, rel = c > 0 ? id.substring(c + 1) : ""; return (rel.isEmpty() ? vol : rel.substring(rel.lastIndexOf('/') + 1)) + (vol.equals("primary") ? "" : " · " + vol); }
    static void forgetTree(Context ctx, int i) { List<Uri> ts = trees(ctx); if (i < ts.size()) ctx.getContentResolver().releasePersistableUriPermission(ts.get(i), android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION | android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION); }
    /** The document id of `sub` under tree `i` ("" for the root). */
    static Uri docOf(Context ctx, int i, String sub) throws IOException {
        List<Uri> ts = trees(ctx); if (i >= ts.size()) throw new IOException("noTree"); Uri tree = ts.get(i); String base = DocumentsContract.getTreeDocumentId(tree);
        String id = sub == null || sub.isEmpty() || sub.equals("/") ? base : base + (base.endsWith("/") || sub.startsWith("/") ? "" : "/") + sub.replaceAll("^/+", "");
        return DocumentsContract.buildDocumentUriUsingTree(tree, id);
    }
    static List<Entry> safList(Context ctx, int i, String sub) throws Exception {
        Uri parent = docOf(ctx, i, sub); Uri kids = DocumentsContract.buildChildDocumentsUriUsingTree(parent, DocumentsContract.getDocumentId(parent)); List<Entry> out = new ArrayList<>();
        try (android.database.Cursor c = ctx.getContentResolver().query(kids, new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED }, null, null, null)) {
            if (c == null) throw new IOException("noAccess");
            while (c.moveToNext()) { Entry e = new Entry(); e.name = c.getString(0); e.dir = DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(1)); e.size = c.isNull(2) ? 0 : c.getLong(2); e.mtime = c.isNull(3) ? 0 : c.getLong(3); out.add(e); }
        }
        return out;
    }
    static File safFetch(Context ctx, int i, String sub, AtomicBoolean stop) throws Exception {
        Uri u = docOf(ctx, i, sub); String name = sub.substring(sub.lastIndexOf('/') + 1); File dir = new File(ctx.getCacheDir(), "saf/" + i + sub.substring(0, sub.lastIndexOf('/') + 1)); dir.mkdirs(); File out = new File(dir, name); File part = new File(out.getPath() + ".part");
        try (InputStream in = ctx.getContentResolver().openInputStream(u); OutputStream os = new FileOutputStream(part)) { if (in == null) throw new IOException("noAccess"); byte[] b = new byte[1 << 16]; int n; while ((n = in.read(b)) > 0) { if (stop != null && stop.get()) throw new IOException("stopped"); os.write(b, 0, n); } }
        if (!part.renameTo(out)) throw new IOException("rename"); return out;
    }
    static void safPut(Context ctx, File src, int i, String dirSub) throws Exception {
        Uri dir = docOf(ctx, i, dirSub); Uri doc = DocumentsContract.createDocument(ctx.getContentResolver(), dir, KtFiles.mimeOf(src.getName()), src.getName()); if (doc == null) throw new IOException("cannotCreate");
        try (OutputStream os = ctx.getContentResolver().openOutputStream(doc); InputStream in = new FileInputStream(src)) { byte[] b = new byte[1 << 16]; int n; while ((n = in.read(b)) > 0) os.write(b, 0, n); }
    }
    static void safMkdir(Context ctx, int i, String dirSub, String name) throws Exception { if (DocumentsContract.createDocument(ctx.getContentResolver(), docOf(ctx, i, dirSub), DocumentsContract.Document.MIME_TYPE_DIR, name) == null) throw new IOException("cannotCreate"); }
    static void safDelete(Context ctx, int i, String sub) throws Exception { if (!DocumentsContract.deleteDocument(ctx.getContentResolver(), docOf(ctx, i, sub))) throw new IOException("cannotDelete"); }
    static void safRename(Context ctx, int i, String sub, String name) throws Exception { if (DocumentsContract.renameDocument(ctx.getContentResolver(), docOf(ctx, i, sub), name) == null) throw new IOException("cannotRename"); }

    /* ---------- one face: scheme://… ---------- */
    static String[] split(String vpath) { int i = vpath.indexOf("://"); String scheme = vpath.substring(0, i), rest = vpath.substring(i + 3); if (scheme.equals("saf")) { int s = rest.indexOf('/'); return new String[] { scheme, s < 0 ? rest : rest.substring(0, s), s < 0 ? "/" : rest.substring(s) }; } return new String[] { scheme, "", "/" + rest.replaceAll("^/+", "") }; }
    static JSONArray list(Context ctx, String vpath) throws Exception {
        String[] p = split(vpath); List<Entry> es = p[0].equals("root") ? rootList(ctx, p[2]) : safList(ctx, Integer.parseInt(p[1]), p[2]); JSONArray a = new JSONArray();
        for (Entry e : es) { JSONObject o = new JSONObject(); o.put("name", e.name); o.put("dir", e.dir); o.put("size", e.size); o.put("mtime", e.mtime); if (e.mode != null) o.put("mode", e.mode); if (e.owner != null) o.put("owner", e.owner); if (e.link != null) o.put("link", e.link); a.put(o); }
        return a;
    }
    static File fetch(Context ctx, String vpath, AtomicBoolean stop) throws Exception { String[] p = split(vpath); return p[0].equals("root") ? rootFetch(ctx, p[2], stop) : safFetch(ctx, Integer.parseInt(p[1]), p[2], stop); }
    static void put(Context ctx, File src, String vdir) throws Exception { String[] p = split(vdir); if (p[0].equals("root")) rootPut(ctx, src, (p[2].equals("/") ? "" : p[2]) + "/" + src.getName()); else safPut(ctx, src, Integer.parseInt(p[1]), p[2]); }
    static void mkdir(Context ctx, String vdir, String name) throws Exception { String[] p = split(vdir); if (p[0].equals("root")) rootRun(ctx, "mkdir -p " + q((p[2].equals("/") ? "" : p[2]) + "/" + name)); else safMkdir(ctx, Integer.parseInt(p[1]), p[2], name); }
    static void delete(Context ctx, String vpath) throws Exception { String[] p = split(vpath); if (p[0].equals("root")) rootRun(ctx, "rm -rf " + q(p[2])); else safDelete(ctx, Integer.parseInt(p[1]), p[2]); }
    static void rename(Context ctx, String vpath, String name) throws Exception { String[] p = split(vpath); if (p[0].equals("root")) rootRun(ctx, "mv " + q(p[2]) + " " + q(p[2].substring(0, p[2].lastIndexOf('/') + 1) + name)); else safRename(ctx, Integer.parseInt(p[1]), p[2], name); }
    /** Folders walked for a transfer out of a virtual place: [vpath, local path] pairs. */
    static void collect(Context ctx, String vpath, File into, List<String[]> out, AtomicBoolean stop) throws Exception {
        if (stop.get()) return; String name = vpath.substring(vpath.lastIndexOf('/') + 1); JSONArray kids = null; try { kids = list(ctx, vpath); } catch (Exception ignored) {}
        boolean dir = kids != null && (kids.length() > 0 || vpath.endsWith("/"));
        if (dir) { for (int i = 0; i < kids.length(); i++) collect(ctx, vpath + "/" + kids.getJSONObject(i).getString("name"), new File(into, name), out, stop); return; }
        out.add(new String[] { vpath, new File(into, name).getPath() });
    }
    static void transfer(Context ctx, String id, String op, List<String> paths, String dest, boolean deleteAfter, KtFiles.Events ev) {
        AtomicBoolean stop = new AtomicBoolean(); KtRemote.JOBS.put(id, stop); long[] done = { 0, 0 }; long[] total = { 0, 0 }; long[] told = { 0 }; List<String> failed = new ArrayList<>();
        try {
            if (op.equals("down")) {
                List<String[]> files = new ArrayList<>(); for (String p : paths) collect(ctx, p, new File(dest), files, stop); total[1] = files.size();
                for (String[] pf : files) { if (stop.get()) break; try { File got = fetch(ctx, pf[0], stop); File out = KtFiles.keepBoth(new File(pf[1])); out.getParentFile().mkdirs(); if (!got.renameTo(out)) { java.nio.file.Files.copy(got.toPath(), out.toPath()); got.delete(); } done[0] += out.length(); done[1]++; KtRemote.tell(ev, id, done, total, out.getName(), told); if (deleteAfter) delete(ctx, pf[0]); } catch (Exception e) { failed.add(pf[0]); if ("stopped".equals(e.getMessage())) break; } }
            } else {
                List<File[]> files = new ArrayList<>(); for (String p : paths) KtRemote.collectLocal(new File(p), "/", files, total);
                java.util.Set<String> made = new java.util.HashSet<>();
                for (File[] pf : files) { if (stop.get()) break; String rel = pf[1].getPath().replace('\\', '/'); String rdir = rel.substring(0, rel.lastIndexOf('/')); String vdir = dest + (rdir.equals("/") || rdir.isEmpty() ? "" : rdir); if (!rdir.isEmpty() && !rdir.equals("/") && made.add(vdir)) { String acc = dest; for (String part : rdir.split("/")) { if (part.isEmpty()) continue; try { mkdir(ctx, acc, part); } catch (Exception ignored) {} acc = acc + "/" + part; } } try { put(ctx, pf[0], vdir); done[0] += pf[0].length(); done[1]++; KtRemote.tell(ev, id, done, total, pf[0].getName(), told); if (deleteAfter) pf[0].delete(); } catch (Exception e) { failed.add(pf[0].getPath()); } }
            }
            JSONObject end = new JSONObject(); end.put("id", id); end.put("status", stop.get() ? "cancelled" : "done"); end.put("done", done[0]); end.put("total", total[0]); end.put("files", done[1]); end.put("failed", new JSONArray(failed)); ev.on(end);
        } catch (Exception e) { try { JSONObject end = new JSONObject(); end.put("id", id); end.put("status", "failed"); end.put("message", String.valueOf(e.getMessage())); ev.on(end); } catch (Exception ignored) {} }
        finally { KtRemote.JOBS.remove(id); }
    }
}
