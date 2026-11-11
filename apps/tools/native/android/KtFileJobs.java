package app.kurokawa.tools;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The Files add-on's jobs — copy, move, delete — and rename, in plain Java (no android.*, so tests/native/files.sh runs
 * the very code on temp folders). The rule of a move: a source item is removed only when that item itself was copied
 * whole (its size checked) to a place that is not itself; a folder only when all inside it moved and it is empty;
 * whatever was skipped, failed or cancelled stays where it was, and the end event says how many files were left.
 * A name taken and replaced: the new copy is written beside it first, and the old one goes only once it is complete.
 */
final class KtFileJobs {
    private KtFileJobs() {}

    interface Events { void on(JSONObject ev); }
    static final class Job { final String id; final AtomicBoolean cancel = new AtomicBoolean(); volatile String conflict = "ask"; final Object lock = new Object(); volatile String answer; Job(String id) { this.id = id; } }
    static final Map<String, Job> jobs = new ConcurrentHashMap<>();
    static void cancel(String id) { Job j = jobs.get(id); if (j != null) { j.cancel.set(true); synchronized (j.lock) { j.answer = "skip"; j.lock.notifyAll(); } } }
    /** The page's answer to a name already taken: skip, replace, keep (both), or the same for all that follow (…All). */
    static void answer(String id, String what) { Job j = jobs.get(id); if (j == null) return; synchronized (j.lock) { if (what.endsWith("All")) j.conflict = what.substring(0, what.length() - 3); j.answer = what.replace("All", ""); j.lock.notifyAll(); } }

    /** One copy or move under way: where it stands, what failed, what was skipped and left behind. */
    static final class Run {
        final Job j; final Events ev; final boolean move; boolean sameVol; final long[] done = { 0, 0 }, total = { 0, 0 }, lastTold = { 0 }; final JSONArray failed = new JSONArray(); int skipped, left;
        Run(Job j, Events ev, boolean move) { this.j = j; this.ev = ev; this.move = move; }
        void fail(File f, String why) { failed.put(f.getName() + ": " + why); }
        /** `f` stays where it was (a move): its files counted as left. */
        void leave(File f) { if (move) { long[] t = { 0, 0 }; count(f, t, null); left += Math.max(1, (int) t[1]); } }
    }

    /** `op` (copy | move | delete) on `paths`, into `dest` (a folder) for copy and move. */
    static void run(String id, String op, List<File> paths, File dest, String conflict, Events ev) {
        Job j = new Job(id); j.conflict = conflict == null ? "ask" : conflict; jobs.put(id, j);
        Run r = new Run(j, ev, op.equals("move"));
        try {
            if (!op.equals("delete")) for (File f : paths) count(f, r.total, j.cancel);
            else for (File f : paths) { long[] t = { 0, 0, 0 }; walkSize(f, t, j.cancel); r.total[0] += t[0]; r.total[1] += t[1] + t[2] + 1; }
            JSONArray remaining = new JSONArray();
            for (File f : paths) {
                if (j.cancel.get()) { if (r.move && f.exists()) { r.leave(f); remaining.put(f.getAbsolutePath()); } continue; }
                try {
                    if (op.equals("delete")) { deleteTree(f, j, r.done, r.total, ev, r.lastTold); continue; }
                    if (!f.exists()) { r.fail(f, "not found"); continue; }
                    File to = new File(dest, f.getName());
                    // (A folder into itself or a folder below it: it would copy itself until the storage is full.)
                    if (f.isDirectory() && inside(dest, f)) { r.fail(f, "into itself"); r.leave(f); remaining.put(f.getAbsolutePath()); continue; }
                    // (Pasted where it already is: a move has nothing to do; a copy makes a second one beside it — never «replace» it with itself.)
                    if (same(f, to)) { if (r.move) continue; to = keepBoth(to, f.isDirectory()); }
                    r.sameVol = r.move && sameStorage(f, dest);
                    transfer(f, to, r);
                } catch (Exception e) { if (!j.cancel.get()) r.fail(f, String.valueOf(e.getMessage())); }
                if (r.move && f.exists()) remaining.put(f.getAbsolutePath());
            }
            JSONObject end = new JSONObject(); end.put("id", id); end.put("status", j.cancel.get() ? "cancelled" : "done"); end.put("done", r.done[0]); end.put("total", r.total[0]); end.put("files", r.done[1]); end.put("failed", r.failed);
            end.put("skipped", r.skipped); if (r.move) { end.put("left", r.left); end.put("remaining", remaining); }
            ev.on(end);
        } catch (Exception e) {
            try { JSONObject end = new JSONObject(); end.put("id", id); end.put("status", "failed"); end.put("message", String.valueOf(e.getMessage())); ev.on(end); } catch (Exception ignored) {}
        } finally { jobs.remove(id); }
    }

    /** `from` copied (moved, for a move) to `to`; true when all of it arrived whole — for a move, it is then gone from where it was. */
    static boolean transfer(File from, File to, Run r) throws Exception {
        Job j = r.j; if (j.cancel.get()) { r.leave(from); return false; }
        boolean link = link(from);
        // (A move on one storage: a rename, the whole of it at once — only when nothing is in the way.)
        if (r.move && r.sameVol && !to.exists() && from.renameTo(to)) { long[] t = { 0, 0 }; count(to, t, null); r.done[0] += t[0]; r.done[1] += t[1]; progress(r, to.getName(), true); return true; }
        if (from.isDirectory() && link) { r.fail(from, "a link to a folder, left as it is"); r.leave(from); return false; }
        if (from.isDirectory()) {
            File into = to; boolean swap = false;
            if (to.exists() && !to.isDirectory()) {
                String a = resolve(j, from, to, r.ev);
                if (j.cancel.get() || a.equals("skip")) { if (!j.cancel.get()) r.skipped++; r.leave(from); return false; }
                if (a.equals("keep")) into = to = keepBoth(to, true); else { into = keepBoth(new File(to.getParentFile(), to.getName() + ".ktpart"), true); swap = true; }
            }
            if (!into.isDirectory() && !into.mkdirs()) { r.fail(from, "cannot make " + into.getName()); r.leave(from); return false; }
            File[] k = from.listFiles(); if (k == null) { r.fail(from, "cannot read"); r.leave(from); return false; }
            boolean all = true;
            for (File c : k) { if (j.cancel.get()) { r.leave(c); all = false; continue; } if (!transfer(c, new File(into, c.getName()), r)) all = false; }
            // (A folder replacing a file: built under another name, put in the file's place only once complete.)
            if (swap && all) { if (!to.delete() || !into.renameTo(to)) { r.fail(from, "cannot replace " + to.getName()); return false; } }
            if (!all || !r.move) return all;
            String[] rest = from.list(); if (rest != null && rest.length == 0 && from.delete()) return true;
            r.fail(from, "cannot remove the folder"); return false;
        }
        if (to.exists()) {
            String a = same(from, to) ? "keep" : resolve(j, from, to, r.ev);
            if (j.cancel.get()) { r.leave(from); return false; }
            if (a.equals("skip")) { r.skipped++; r.done[0] += from.length(); r.done[1]++; r.leave(from); progress(r, from.getName(), true); return false; }
            if (a.equals("keep")) to = keepBoth(to, false);
            else if (to.isDirectory()) { r.fail(from, "cannot replace the folder " + to.getName()); r.leave(from); return false; }
        }
        File part = new File(to.getParentFile(), to.getName() + ".ktpart"); long size = from.length(), wrote = 0;
        try (InputStream in = new FileInputStream(from); OutputStream out = new FileOutputStream(part)) {
            byte[] b = new byte[1 << 18]; int n;
            while ((n = in.read(b)) > 0) { if (j.cancel.get()) break; out.write(b, 0, n); wrote += n; r.done[0] += n; progress(r, from.getName(), false); }
        } catch (IOException e) { part.delete(); r.fail(from, String.valueOf(e.getMessage())); r.leave(from); return false; }
        if (j.cancel.get()) { part.delete(); r.leave(from); return false; }
        // (Whole, or not at all: a file that changed while it was read, or a short write, is not taken for a copy.)
        if (wrote != size || part.length() != size) { part.delete(); r.fail(from, "size changed while copying"); r.leave(from); return false; }
        if (!putInPlace(part, to)) { part.delete(); r.fail(from, "cannot write " + to.getName()); r.leave(from); return false; }
        to.setLastModified(from.lastModified()); r.done[1]++; progress(r, from.getName(), true);
        if (r.move && !from.delete()) { r.fail(from, "copied, but cannot remove the original"); r.leave(from); return false; }
        return true;
    }
    /** The finished `part` named `to`; a file already there is set aside first and put back if the rename fails. */
    private static boolean putInPlace(File part, File to) {
        if (!to.exists()) return part.renameTo(to);
        File old = keepBoth(new File(to.getParentFile(), to.getName() + ".ktold"), false);
        if (!to.renameTo(old)) return false;
        if (!part.renameTo(to)) { old.renameTo(to); return false; }
        old.delete(); return true;
    }
    /** `dest` is `f` or lies below it (the canonical paths compared by whole parts, and each folder above `dest` asked
     *  whether it is `f` — the same folder by another spelling: another letter case, a link). */
    static boolean inside(File dest, File f) {
        try {
            String fc = f.getCanonicalPath();
            for (File a = dest.getCanonicalFile(); a != null; a = a.getParentFile()) if (a.getPath().equals(fc) || same(a, f)) return true;
        } catch (IOException ignored) {}
        return false;
    }
    /** The same file or folder (one inode), whatever the spelling. */
    static boolean same(File a, File b) { if (!a.exists() || !b.exists()) return false; try { return Files.isSameFile(a.toPath(), b.toPath()); } catch (IOException e) { return false; } catch (LinkageError e) { try { return a.getCanonicalPath().equals(b.getCanonicalPath()); } catch (IOException e2) { return false; } } }
    /** A symbolic link (java.nio.file is Android 8+: on 7 the page's listing needs it already; here a link is then not seen). */
    static boolean link(File f) { try { return Files.isSymbolicLink(f.toPath()); } catch (LinkageError e) { return false; } }
    private static void progress(Run r, String name, boolean force) { progress(r.ev, r.j, r.done, r.total, name, r.lastTold, force); }
    static void count(File f, long[] t, AtomicBoolean cancel) { if (cancel != null && cancel.get()) return; if (f.isDirectory() && !link(f)) { File[] k = f.listFiles(); if (k != null) for (File c : k) count(c, t, cancel); } else { t[0] += f.length(); t[1]++; } }
    static void walkSize(File d, long[] t, AtomicBoolean cancel) {
        File[] k = d.listFiles(); if (k == null) return;
        for (File c : k) { if (cancel != null && cancel.get()) return; if (c.isDirectory() && !link(c)) { t[2]++; walkSize(c, t, cancel); } else { t[1]++; t[0] += c.length(); } }
    }
    static boolean sameStorage(File a, File b) { try { return Files.getFileStore(a.toPath()).equals(Files.getFileStore(b.toPath())); } catch (Exception | LinkageError e) { return false; } }
    static void progress(Events ev, Job j, long[] done, long[] total, String name, long[] lastTold, boolean force) {
        long now = System.currentTimeMillis(); if (!force && now - lastTold[0] < 200) return; lastTold[0] = now;
        try { JSONObject o = new JSONObject(); o.put("id", j.id); o.put("status", "progress"); o.put("done", done[0]); o.put("total", total[0]); o.put("files", done[1]); o.put("ofFiles", total[1]); o.put("name", name); ev.on(o); } catch (Exception ignored) {}
    }
    /** What to do about `to` already there: the job's standing answer, else the page asked and waited for. */
    private static String resolve(Job j, File from, File to, Events ev) throws Exception {
        if (!j.conflict.equals("ask")) return j.conflict;
        JSONObject o = new JSONObject(); o.put("id", j.id); o.put("status", "conflict"); o.put("from", from.getAbsolutePath()); o.put("to", to.getAbsolutePath()); o.put("size", from.isFile() ? from.length() : 0); o.put("existingSize", to.isFile() ? to.length() : 0); o.put("mtime", from.lastModified()); o.put("existingMtime", to.lastModified()); o.put("dir", from.isDirectory());
        synchronized (j.lock) { j.answer = null; ev.on(o); while (j.answer == null && !j.cancel.get()) j.lock.wait(60000); return j.answer == null ? "skip" : j.answer; }
    }
    static String extOf(String name) { int i = name.lastIndexOf('.'); return i > 0 && i < name.length() - 1 && name.length() - i <= 8 ? name.substring(i + 1).toLowerCase(Locale.ROOT) : ""; }
    static File keepBoth(File to) { return keepBoth(to, false); }
    /** A free name beside `to`: «name (1).ext» — a folder's whole name numbered, its dots no extension. */
    static File keepBoth(File to, boolean dir) { String n = to.getName(); String ext = dir ? "" : extOf(n); String stem = ext.isEmpty() ? n : n.substring(0, n.length() - ext.length() - 1); String e = ext.isEmpty() ? "" : n.substring(n.length() - ext.length() - 1); for (int i = 1; i < 10000; i++) { File c = new File(to.getParentFile(), stem + " (" + i + ")" + e); if (!c.exists()) return c; } return to; }
    /** `f` and everything in it deleted (a link: the link only — never what it points at). */
    static void deleteTree(File f, Job j, long[] done, long[] total, Events ev, long[] lastTold) throws Exception {
        if (j.cancel.get()) return;
        if (f.isDirectory() && !link(f)) { File[] k = f.listFiles(); if (k != null) for (File c : k) deleteTree(c, j, done, total, ev, lastTold); }
        long sz = f.isFile() ? f.length() : 0;
        if (!f.delete() && (f.exists() || link(f))) throw new IOException("cannot delete " + f.getName());
        done[0] += sz; done[1]++; if (ev != null) progress(ev, j, done, total, f.getName(), lastTold, false);
    }
    /** `from` moved to `to` whole (nothing in the way), for the bin and its restore: a rename, else a copy then a delete
     *  of what arrived; an IOException when any of it stayed behind. */
    static void moveWhole(File from, File to) throws Exception {
        Run r = new Run(new Job("x"), (ev) -> {}, true); r.sameVol = true; r.j.conflict = "keep";
        if (!transfer(from, to, r)) throw new IOException(r.failed.length() > 0 ? r.failed.getString(0) : "cannot move " + from.getName());
    }

    /** `f` renamed `name` in its folder; a name taken by another file refused («exists») — a change of letter case alone
     *  is let through only when the name taken is `f` itself (a volume that ignores case). */
    static JSONObject rename(File f, String name) throws Exception {
        if (name.isEmpty() || name.contains("/") || name.contains("\u0000") || name.equals(".") || name.equals("..")) throw new IOException("bad name");
        if (!f.exists() && !link(f)) throw new IOException("not found");
        File to = new File(f.getParentFile(), name);
        if (to.getName().equals(f.getName())) { JSONObject o = new JSONObject(); o.put("ok", true); o.put("path", f.getAbsolutePath()); return o; }
        if ((to.exists() || link(to)) && !same(f, to)) throw new IOException("exists");
        boolean ok;
        // (The letter case alone on a volume that ignores it — `to` is `f` —: by way of a passing name, which every volume takes.)
        if (same(f, to)) { File mid = keepBoth(new File(f.getParentFile(), name + ".ktrename"), false); ok = f.renameTo(mid) && mid.renameTo(to); if (!ok && mid.exists()) mid.renameTo(f); }
        else ok = f.renameTo(to);
        if (!ok) throw new IOException("cannot rename");
        JSONObject o = new JSONObject(); o.put("ok", true); o.put("path", to.getAbsolutePath()); return o;
    }
}
