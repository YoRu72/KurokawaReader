package app.kurokawa.tools;

import org.json.JSONArray;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Stage M5 of the Rust port: KtFileJobs's decisions written as a PLAN — ordered steps from a snapshot of the trees —
 * in Java, the reference the Rust planner (kt-core's fileplan.rs, `fj.plan`) is compared with, step for step, and the
 * fallback when the core is absent or errs. It uses KtFileJobs's own helpers (extOf, inside, same, sameStorage, link),
 * so its answers are the classic engine's. KtFileExec executes the plan (every byte and rename is Java's). Plain Java
 * (org.json only), so the host tests run it.
 *
 * A step is a JSON array with fixed positions (fileplan::Step::to_json):
 *   ["ask", item, from, to]                          ["rename", item, frame, from, to, files, bytes]
 *   ["dir", item, frame, parent, from, into, mkdir, files]   ["copy", item, frame, from, to, size, replace, move]
 *   ["skip", item, frame, from, size, files, dir]    ["fail", item, frame, from, why, files]
 *   ["endDir", item, frame, parent, from, to, into, swap, rmdir]   ["del", item, path, size]   ["end", item, remaining]
 */
final class KtFilePlan {
    private KtFilePlan() {}

    /* ---------- the snapshot ---------- */
    static final class Tgt { boolean e, d, f, same; List<String> names = Collections.emptyList(); }
    static final class Node { String name; char k; long size; boolean isFile; List<Node> kids; Tgt t = new Tgt(); }
    static final class Item { String path; boolean exists, intoItself, sameVol; Node node; }
    static final class Snap { String op, conflict, dest; List<String> destNames = Collections.emptyList(); List<Item> items = new ArrayList<>(); long nodes; }

    /** The trees of `paths` and what stands at their places in `dest`, as KtFileJobs would see them now. */
    static Snap snapshot(String op, List<File> paths, File dest, String conflict, AtomicBoolean cancel) {
        Snap s = new Snap(); s.op = op; s.conflict = conflict == null ? "ask" : conflict; s.dest = dest == null ? "" : dest.getPath();
        boolean del = op.equals("delete");
        if (!del && dest != null) s.destNames = names(dest);
        for (File f : paths) {
            Item it = new Item(); it.path = f.getPath(); it.exists = f.exists();
            if (del) it.node = scan(f, null, true, true, s, cancel);
            else {
                it.node = scan(f, new File(dest, f.getName()), false, true, s, cancel);
                it.intoItself = f.isDirectory() && KtFileJobs.inside(dest, f);
                it.sameVol = op.equals("move") && KtFileJobs.sameStorage(f, dest);
            }
            s.items.add(it);
        }
        return s;
    }
    private static List<String> names(File d) { String[] n = d.list(); if (n == null) return Collections.emptyList(); List<String> l = new ArrayList<>(n.length); Collections.addAll(l, n); return l; }
    private static Node scan(File f, File t, boolean del, boolean top, Snap s, AtomicBoolean cancel) {
        Node n = new Node(); n.name = f.getName(); s.nodes++;
        boolean d = f.isDirectory(); n.k = d ? (KtFileJobs.link(f) ? 'l' : 'd') : 'f'; n.size = f.length(); n.isFile = f.isFile();
        if (t != null) { n.t.e = t.exists(); n.t.d = t.isDirectory(); n.t.f = t.isFile(); n.t.same = n.t.e && KtFileJobs.same(f, t); if (n.t.d) n.t.names = names(t); }
        // (A delete's top-level path is listed even through a link, as walkSize counts it; below, only real folders.)
        if (n.k == 'd' || (del && top && d)) {
            File[] k = f.listFiles();
            if (k != null) { n.kids = new ArrayList<>(k.length); for (File c : k) { if (cancel != null && cancel.get()) break; n.kids.add(scan(c, t != null && n.t.d ? new File(t, c.getName()) : null, del, false, s, cancel)); } }
        }
        return n;
    }

    /** The snapshot as `fj.plan` reads it (ASCII only: every other character as a \\u escape). */
    static void json(Snap s, StringBuilder b) {
        b.append("{\"op\":"); q(b, s.op); b.append(",\"conflict\":"); q(b, s.conflict); b.append(",\"dest\":"); q(b, s.dest); b.append(",\"destNames\":"); strs(b, s.destNames); b.append(",\"items\":[");
        for (int i = 0; i < s.items.size(); i++) { Item it = s.items.get(i); if (i > 0) b.append(','); b.append("{\"path\":"); q(b, it.path); b.append(",\"exists\":").append(it.exists).append(",\"intoItself\":").append(it.intoItself).append(",\"sameVol\":").append(it.sameVol).append(",\"node\":"); node(it.node, b); b.append('}'); }
        b.append("]}");
    }
    private static void node(Node n, StringBuilder b) {
        b.append("{\"n\":"); q(b, n.name); b.append(",\"k\":\"").append(n.k).append("\",\"s\":").append(n.size).append(",\"isFile\":").append(n.isFile);
        if (n.t.e) { b.append(",\"t\":{\"e\":true,\"d\":").append(n.t.d).append(",\"f\":").append(n.t.f).append(",\"same\":").append(n.t.same).append(",\"names\":"); strs(b, n.t.names); b.append('}'); }
        if (n.kids != null) { b.append(",\"c\":["); for (int i = 0; i < n.kids.size(); i++) { if (i > 0) b.append(','); node(n.kids.get(i), b); } b.append(']'); }
        b.append('}');
    }
    private static void strs(StringBuilder b, List<String> l) { b.append('['); for (int i = 0; i < l.size(); i++) { if (i > 0) b.append(','); q(b, l.get(i)); } b.append(']'); }
    static void q(StringBuilder b, String s) {
        b.append('"');
        for (int k = 0; k < s.length(); k++) { char c = s.charAt(k); if (c == '"') b.append("\\\""); else if (c == '\\') b.append("\\\\"); else if (c < 0x20 || c > 0x7e) { String h = Integer.toHexString(c); b.append("\\u"); for (int z = h.length(); z < 4; z++) b.append('0'); b.append(h); } else b.append(c); }
        b.append('"');
    }

    /* ---------- the plan ---------- */
    static final class Plan { final List<JSONArray> steps = new ArrayList<>(); long totalBytes, totalFiles, copyBytes; boolean asks; }

    static String join(String p, String n) { return p.endsWith("/") ? p + n : p + "/" + n; }
    static String parentOf(String p) { int i = p.lastIndexOf('/'); return i == 0 ? "/" : i > 0 ? p.substring(0, i) : ""; }
    static String nameOf(String p) { int i = p.lastIndexOf('/'); return i >= 0 ? p.substring(i + 1) : p; }

    interface Taken { boolean has(String name); }
    /** KtFileJobs.keepBoth's naming with `taken` for exists() (the same split of the name, the same numbers). */
    static String keepBothName(String n, boolean dir, Taken taken) {
        String ext = dir ? "" : KtFileJobs.extOf(n);
        String stem = ext.isEmpty() ? n : n.substring(0, n.length() - ext.length() - 1); String e = ext.isEmpty() ? "" : n.substring(n.length() - ext.length() - 1);
        for (int i = 2; i < 10000; i++) { String c = stem + " (" + i + ")" + e; if (!taken.has(c)) return c; }
        return n;
    }

    private static long[] count(Node n) { if (n.k == 'd') { long[] t = { 0, 0 }; if (n.kids != null) for (Node c : n.kids) { long[] x = count(c); t[0] += x[0]; t[1] += x[1]; } return t; } return new long[] { n.size, 1 }; }
    private static long leaveOf(Node n) { return Math.max(1, count(n)[1]); }
    private static void walkSize(Node n, long[] t) { if (n.kids == null) return; for (Node c : n.kids) { if (c.k == 'd') { t[2]++; walkSize(c, t); } else { t[1]++; t[0] += c.size; } } }

    private static JSONArray a(Object... v) { JSONArray x = new JSONArray(); for (Object o : v) x.put(o); return x; }

    private static final class P {
        final Snap s; final boolean mv; String standing; final List<String> answers; int next; final Set<String> renameFailed;
        /** What the job will have made at a path: "d", "f", or "-" (gone). */
        final Map<String, String> made = new HashMap<>(); final Map<String, Set<String>> names = new HashMap<>();
        final Plan out = new Plan(); int frames; boolean stop;
        P(Snap s, List<String> answers, Set<String> rf) { this.s = s; mv = s.op.equals("move"); standing = s.conflict; this.answers = answers; renameFailed = rf; }

        String have(String p, Tgt snap) { if (made.containsKey(p)) { String h = made.get(p); return h.equals("-") ? null : h; } if (snap != null && snap.e) return snap.d ? "d" : "f"; return null; }
        boolean taken(String folder, String name) { String p = join(folder, name); if (made.containsKey(p)) return !made.get(p).equals("-"); Set<String> n = names.get(folder); return n != null && n.contains(name); }
        String keepBoth(String to, boolean dir) { final String folder = parentOf(to); return join(folder, keepBothName(nameOf(to), dir, (c) -> taken(folder, c))); }
        String resolve() {
            if (!standing.equals("ask")) return standing;
            if (next >= answers.size()) return null;
            String x = answers.get(next++); if (x.endsWith("All")) standing = x.substring(0, x.length() - 3);
            return x.replace("All", "");
        }
        void ask(int item, String from, String to) { out.steps.add(a("ask", item, from, to)); stop = true; }

        void transfer(int item, int frame, Node n, String from, String to, boolean natural) {
            if (stop) return;
            Tgt snap = natural ? n.t : null;
            if (mv && s.items.get(item).sameVol && have(to, snap) == null && !renameFailed.contains(from)) {
                long[] c = count(n); out.steps.add(a("rename", item, frame, from, to, c[1], c[0])); made.put(to, n.k == 'f' ? "f" : "d"); return;
            }
            if (n.k == 'l') { out.steps.add(a("fail", item, frame, from, "a link to a folder, left as it is", leaveOf(n))); return; }
            if (n.k == 'd') {
                String into = to; boolean swap = false, fresh = !natural;
                if ("f".equals(have(to, snap))) {
                    String ans = resolve(); if (ans == null) { ask(item, from, to); return; }
                    if (ans.equals("skip")) { out.steps.add(a("skip", item, frame, from, 0L, leaveOf(n), true)); return; }
                    if (ans.equals("keep")) { to = keepBoth(to, true); into = to; } else { into = keepBoth(join(parentOf(to), nameOf(to) + ".ktpart"), true); swap = true; }
                    fresh = true;
                }
                String intoHave = into.equals(to) ? have(into, snap) : have(into, null);
                boolean mkdir = !"d".equals(intoHave);
                int f = ++frames;
                out.steps.add(a("dir", item, f, frame, from, into, mkdir, leaveOf(n)));
                if (mkdir) made.put(into, "d");
                else if (natural && !fresh && n.t.e && n.t.d && !names.containsKey(into)) names.put(into, new HashSet<>(n.t.names));
                if (n.kids == null) { out.steps.add(a("fail", item, frame, from, "cannot read", leaveOf(n))); return; }
                for (Node c : n.kids) { if (stop) return; transfer(item, f, c, join(from, c.name), join(into, c.name), natural && !fresh && !mkdir); }
                if (stop) return;
                out.steps.add(a("endDir", item, f, frame, from, to, into, swap, mv));
                if (swap) { made.put(into, "-"); made.put(to, "d"); }
                return;
            }
            String h = have(to, snap);
            if (h != null) {
                boolean same = snap != null && snap.same;
                String ans = same ? "keep" : resolve(); if (ans == null) { ask(item, from, to); return; }
                if (ans.equals("skip")) { out.steps.add(a("skip", item, frame, from, n.size, 1L, false)); return; }
                if (ans.equals("keep")) to = keepBoth(to, false);
                else if (h.equals("d")) { out.steps.add(a("fail", item, frame, from, "cannot replace the folder " + nameOf(to), 1L)); return; }
                else { out.copyBytes += n.size; out.steps.add(a("copy", item, frame, from, to, n.size, true, mv)); made.put(to, "f"); return; }
            }
            out.copyBytes += n.size; out.steps.add(a("copy", item, frame, from, to, n.size, false, mv)); made.put(to, "f");
        }
        void delete(int item, Node n, String path) {
            if (n.k == 'd' && n.kids != null) for (Node c : n.kids) delete(item, c, join(path, c.name));
            out.steps.add(a("del", item, path, n.isFile ? n.size : 0L));
        }
    }

    /** The plan (fileplan::plan's twin): `answers` the page's answers so far, `renameFailed` the sources whose rename failed. */
    static Plan plan(Snap s, List<String> answers, Set<String> renameFailed) {
        P p = new P(s, answers, renameFailed); p.names.put(s.dest, new HashSet<>(s.destNames));
        boolean del = s.op.equals("delete");
        for (Item it : s.items) { if (del) { long[] t = { 0, 0, 0 }; walkSize(it.node, t); p.out.totalBytes += t[0]; p.out.totalFiles += t[1] + t[2] + 1; } else { long[] c = count(it.node); p.out.totalBytes += c[0]; p.out.totalFiles += c[1]; } }
        for (int i = 0; i < s.items.size(); i++) {
            if (p.stop) break;
            Item it = s.items.get(i);
            if (del) { p.delete(i, it.node, it.path); p.out.steps.add(a("end", i, false)); continue; }
            int root = ++p.frames;
            if (!it.exists) { p.out.steps.add(a("fail", i, root, it.path, "not found", 0L)); p.out.steps.add(a("end", i, false)); continue; }
            String to = join(s.dest, nameOf(it.path));
            if (it.node.k != 'f' && it.intoItself) { p.out.steps.add(a("fail", i, root, it.path, "into itself", leaveOf(it.node))); p.out.steps.add(a("end", i, true)); continue; }
            boolean natural = true;
            if (it.node.t.same) { if (p.mv) { p.out.steps.add(a("end", i, false)); continue; } to = p.keepBoth(to, it.node.k != 'f'); natural = false; }
            p.transfer(i, root, it.node, it.path, to, natural);
            if (!p.stop) p.out.steps.add(a("end", i, true));
        }
        p.out.asks = p.stop; return p.out;
    }

    /** A step that deletes, overwrites or moves users' data. */
    static boolean destructive(JSONArray s) {
        switch (s.optString(0)) {
            case "rename": case "del": return true;
            case "copy": return s.optBoolean(6) || s.optBoolean(7);
            case "endDir": return s.optBoolean(7) || s.optBoolean(8);
            default: return false;
        }
    }
    /** Data safety: the items whose destructive steps in `run` (the plan to be executed) are not all, exactly, in
     *  `ref`'s steps for that item (null `ref`: every item with a destructive step). Computed in Java, always. */
    static Set<Integer> disputed(List<JSONArray> run, List<JSONArray> ref) {
        Map<Integer, Set<String>> by = new HashMap<>();
        if (ref != null) for (JSONArray s : ref) by.computeIfAbsent(s.optInt(1), (k) -> new HashSet<>()).add(s.toString());
        Set<Integer> out = new java.util.LinkedHashSet<>();
        for (JSONArray s : run) if (destructive(s)) { Set<String> x = by.get(s.optInt(1)); if (x == null || !x.contains(s.toString())) out.add(s.optInt(1)); }
        return out;
    }
}
