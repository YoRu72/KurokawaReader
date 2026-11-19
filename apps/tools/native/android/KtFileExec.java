package app.kurokawa.tools;

import app.kurokawa.tools.KtCore;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Stage M5 of the Rust port: the Files jobs' second engine. «Classic» (the default) is KtFileJobs.run, unchanged; on a
 * debuggable build with the core, its plan is also made by Java's planner and by Rust's and the two compared (counted,
 * the first few kept) — the classic engine still does the job. «Rust» (Settings → Advanced, phones with the core):
 * the job is PLANNED by Rust (`fj.plan`) and executed here, by Java — every byte, rename and delete; Java's planner
 * (KtFilePlan) plans it too, and
 *  - any Rust error before the first step: Java's plan is the one run (counted: FALLBACKS); a job never changes planner
 *    once its first step ran;
 *  - DATA SAFETY: every step of Rust's plan that deletes, overwrites or moves must be, exactly, in Java's plan for that
 *    item; an item where it is not is skipped whole and reported («the two planners disagree»), the job going on;
 *  - every step is re-checked against what is really there before it touches anything (a copy never lands on a file the
 *    plan did not expect, a rename never over anything);
 *  - the job is JOURNALED (private storage, see filejournal.rs): cut short by a crash or a kill it can be resumed or
 *    rolled back; finished, it can be undone when every step it took can be.
 * Plain Java (org.json), so the host tests run it with the host library.
 */
final class KtFileExec {
    private KtFileExec() {}

    /** «classic» | «rust» (KtPlugin sets it from the `kt` preferences; configure({fileEngine}) changes it). */
    static volatile String choice = "classic";
    /** Compare the two plans of classic jobs (debuggable builds; KtPlugin sets it with KtCore.shadow). */
    static volatile boolean shadow;
    /** Where the journals go (the app's private files; null: none kept). */
    static volatile File journalDir;
    /** (Tests: called before each write of a copy, with the bytes about to go — throw to play a full disk.) */
    interface WriteHook { void before(File to, long already, int n) throws IOException; }
    static volatile WriteHook writeHook;
    /** (Tests: the executor dies, as a process killed, before the n-th journal record is written; `torn`: half of it written.) */
    static volatile int dieAt = -1; static volatile boolean dieTorn;
    static final class Died extends Error { Died() { super("died (test)"); } }
    /** (Tests: Rust's plan altered before it runs, to prove the cross-check.) */
    interface Tamper { void on(List<JSONArray> steps); }
    static volatile Tamper tamper;
    /** (Tests: every move planned as across storages; a rename that fails as across storages it would.) */
    static volatile boolean crossVolume; static volatile java.util.function.Predicate<File> renameFails;
    /** (Tests: the planned engine even without the core — Java's plan executed here; tests/native/fileplan.sh.) */
    static volatile boolean planned;
    /** (Tests: the core required — no silent fall back to Java's plan.) */
    static volatile boolean strict;

    static final AtomicLong FALLBACKS = new AtomicLong(), CHECKS = new AtomicLong(), MISMATCHES = new AtomicLong(), DISPUTED = new AtomicLong(), JOBS_RUST = new AtomicLong(), REPLAN_ERRORS = new AtomicLong();
    static final List<String> FIRST = new ArrayList<>();

    static boolean rustChosen() { return "rust".equals(choice); }
    static String inUse() { try { return rustChosen() && KtCore.available() ? "rust" : "classic"; } catch (Throwable e) { return "classic"; } }

    /** A Files job, on the engine chosen. */
    static void run(String id, String op, List<File> paths, File dest, String conflict, KtFileJobs.Events ev) {
        boolean rust = false; try { rust = rustChosen() && KtCore.available(); } catch (Throwable ignored) {}
        if (!rust && !planned) {
            if (shadow) try { if (KtCore.available()) shadowPlans(op, paths, dest, conflict); } catch (Throwable ignored) {}
            KtFileJobs.run(id, op, paths, dest, conflict, ev);
            return;
        }
        new Exec(id, op, dest, ev).start(paths, conflict);
    }

    /** The classic engine's job planned by both planners beside it (nothing executed), the difference counted. */
    static void shadowPlans(String op, List<File> paths, File dest, String conflict) {
        KtFilePlan.Snap s = KtFilePlan.snapshot(op, paths, dest, conflict, null);
        if (s.nodes > 20000) return;   // (a big tree: not worth a second walk's memory on every classic job)
        List<String> none = new ArrayList<>(); Set<String> rf = new HashSet<>();
        KtFilePlan.Plan j = KtFilePlan.plan(s, none, rf);
        List<JSONArray> r; try { r = rustPlan(s, none, rf).steps; } catch (Exception e) { note("fj.plan error: " + e.getMessage()); return; }
        compare(j.steps, r);
    }
    static void compare(List<JSONArray> java, List<JSONArray> rust) {
        CHECKS.incrementAndGet();
        int n = Math.max(java.size(), rust.size());
        for (int i = 0; i < n; i++) {
            String a = i < java.size() ? java.get(i).toString() : "(none)", b = i < rust.size() ? rust.get(i).toString() : "(none)";
            if (!a.equals(b)) { MISMATCHES.incrementAndGet(); note("step " + i + ": java=" + a + " rust=" + b); return; }
        }
    }
    private static void note(String s) {
        synchronized (FIRST) { if (FIRST.size() < 5) FIRST.add(s.length() > 400 ? s.substring(0, 400) + "…" : s); }
        java.util.function.Consumer<String> l = KtCore.log; if (l != null) try { l.accept("File jobs: " + s); } catch (Throwable ignored) {}
    }

    static KtFilePlan.Plan rustPlan(KtFilePlan.Snap s, List<String> answers, Set<String> rf) throws Exception {
        StringBuilder b = new StringBuilder(64 + (int) Math.min(1 << 24, s.nodes * 96)); b.append("{\"snapshot\":"); KtFilePlan.json(s, b);
        b.append(",\"answers\":["); for (int i = 0; i < answers.size(); i++) { if (i > 0) b.append(','); KtFilePlan.q(b, answers.get(i)); }
        b.append("],\"renameFailed\":["); int k = 0; for (String x : rf) { if (k++ > 0) b.append(','); KtFilePlan.q(b, x); } b.append("]}");
        JSONObject r = new JSONObject(KtCore.call("fj.plan", b.toString())).getJSONObject("r");
        KtFilePlan.Plan p = new KtFilePlan.Plan(); JSONArray st = r.getJSONArray("steps");
        for (int i = 0; i < st.length(); i++) p.steps.add(st.getJSONArray(i));
        p.totalBytes = r.getLong("totalBytes"); p.totalFiles = r.getLong("totalFiles"); p.copyBytes = r.getLong("copyBytes"); p.asks = r.getBoolean("asks");
        return p;
    }

    /* ---------- the journal (written here; read back by Rust, filejournal.rs) ---------- */
    static final class Journal implements java.io.Closeable {
        final File file; private final FileOutputStream out; static final AtomicLong WRITES = new AtomicLong();
        Journal(File file) throws IOException { this.file = file; out = new FileOutputStream(file, true); }
        static String esc(String s) { StringBuilder b = new StringBuilder(s.length()); for (int i = 0; i < s.length(); i++) { char c = s.charAt(i); if (c == '\\') b.append("\\\\"); else if (c == '\t') b.append("\\t"); else if (c == '\n') b.append("\\n"); else if (c == '\r') b.append("\\r"); else b.append(c); } return b.toString(); }
        static String line(String kind, Object... f) {
            StringBuilder b = new StringBuilder(esc(kind)); for (Object x : f) b.append('\t').append(esc(String.valueOf(x)));
            byte[] body = b.toString().getBytes(StandardCharsets.UTF_8); java.util.zip.CRC32 c = new java.util.zip.CRC32(); c.update(body);
            String h = Long.toHexString(c.getValue()); while (h.length() < 8) h = "0" + h; return h + "\t" + b + "\n";
        }
        /** One record appended; `sync`: on the disk before the step that follows touches anything. */
        void put(boolean sync, String kind, Object... f) throws IOException {
            byte[] l = line(kind, f).getBytes(StandardCharsets.UTF_8);
            long n = WRITES.incrementAndGet();
            if (dieAt >= 0 && n >= dieAt) { if (dieTorn) { out.write(l, 0, l.length / 2); out.flush(); } throw new Died(); }
            out.write(l); if (sync) out.getFD().sync();
        }
        void plan(String op, String dest, int from, List<JSONArray> steps, Set<Integer> disputed, List<String> items) throws IOException {
            StringBuilder b = new StringBuilder(); b.append(line("P", "1", op, dest, from, steps.size() - from));
            if (items != null) for (int i = 0; i < items.size(); i++) b.append(line("I", i, items.get(i)));
            for (int i = from; i < steps.size(); i++) { JSONArray s = steps.get(i); Object[] f = new Object[s.length() + 1]; f[0] = i; for (int k = 0; k < s.length(); k++) f[k + 1] = s.opt(k); b.append(line("S", f)); }
            for (int d : disputed) b.append(line("X", d));
            byte[] l = b.toString().getBytes(StandardCharsets.UTF_8); long n = WRITES.incrementAndGet();
            if (dieAt >= 0 && n >= dieAt) throw new Died();
            out.write(l); put(true, "R");
        }
        @Override public void close() { try { out.close(); } catch (IOException ignored) {} }
    }
    static String journalId(String id) { return System.currentTimeMillis() + "-" + id.replaceAll("[^A-Za-z0-9_-]", "_"); }
    static File journalFile(String jid) { File d = journalDir; return d == null ? null : new File(d, jid + ".ktj"); }
    static File doneFile(String jid) { File d = journalDir; return d == null ? null : new File(d, jid + ".done.ktj"); }
    static final int MAX_JOURNAL_STEPS = 200_000;
    static final AtomicLong JOURNALS_SKIPPED = new AtomicLong();

    /** The journals kept: finished beyond the newest 30 or older than 14 days, cut-short ones older than 28, dropped. */
    static void prune() {
        File d = journalDir; if (d == null) return; File[] fs = d.listFiles(); if (fs == null) return;
        try {
            StringBuilder b = new StringBuilder("{\"list\":["); int k = 0;
            for (File f : fs) if (f.getName().endsWith(".ktj")) { if (k++ > 0) b.append(','); b.append('['); KtFilePlan.q(b, f.getName()); b.append(',').append(f.lastModified()).append(',').append(f.getName().endsWith(".done.ktj")).append(']'); }
            b.append("],\"now\":").append(System.currentTimeMillis()).append(",\"keep\":30,\"maxAge\":").append(14L * 86400000L).append('}');
            JSONArray del = new JSONObject(KtCore.call("fj.prune", b.toString())).getJSONArray("r");
            for (int i = 0; i < del.length(); i++) { File f = new File(d, del.getString(i)); if (f.getName().endsWith(".ktj")) f.delete(); }
        } catch (Exception ignored) {}
    }

    /* ---------- one job executed ---------- */
    static final class Exec {
        final String id, op; final File dest; final KtFileJobs.Events ev; final boolean mv;
        KtFileJobs.Job j; KtFilePlan.Snap snap; final List<String> answers = new ArrayList<>(); final Set<String> renameFailed = new LinkedHashSet<>();
        List<JSONArray> steps; List<JSONArray> ref; boolean onRust, resuming; Set<Integer> disputed = new HashSet<>(); List<String> itemPaths = new ArrayList<>();
        final long[] done = { 0, 0 }, total = { 0, 0 }, told = { 0 }; final JSONArray failed = new JSONArray(); int skipped, replans; final JSONArray remaining = new JSONArray();
        final Map<Integer, Boolean> ok = new HashMap<>(); final Set<Integer> dead = new HashSet<>(); final Map<Integer, Integer> parentOf = new HashMap<>(); final Set<Integer> toldDisputed = new HashSet<>(); final Set<Integer> delFailed = new HashSet<>(); final Set<Integer> settled = new HashSet<>();
        Journal jr; String jid; List<File> paths = new ArrayList<>();
        Exec(String id, String op, File dest, KtFileJobs.Events ev) { this.id = id; this.op = op; this.dest = dest; this.ev = ev; mv = op.equals("move"); }

        void start(List<File> paths, String conflict) {
            this.paths = paths;
            j = new KtFileJobs.Job(id); j.conflict = conflict == null ? "ask" : conflict; KtFileJobs.jobs.put(id, j);
            try {
                snap = KtFilePlan.snapshot(op, paths, dest, j.conflict, j.cancel);
                for (KtFilePlan.Item it : snap.items) { itemPaths.add(it.path); if (crossVolume) it.sameVol = false; }
                plan(true);
                JOBS_RUST.incrementAndGet();
                openJournal();
                loop(0);
                finish(null);
            } catch (Died d) { throw d;
            } catch (Exception e) { finish(String.valueOf(e.getMessage()));
            } finally { if (jr != null) jr.close(); KtFileJobs.jobs.remove(id); }
        }
        /** Both plans made; the one to run: at first Rust's (Java's when Rust errs), afterwards always the same planner. */
        void plan(boolean first) throws Exception {
            KtFilePlan.Plan jp = null, rp = null; String rerr = null;
            try { jp = KtFilePlan.plan(snap, answers, renameFailed); } catch (RuntimeException e) { note("java planner: " + e); }
            if (first || onRust) { try { rp = rustPlan(snap, answers, renameFailed); Tamper t = tamper; if (t != null) t.on(rp.steps); } catch (Exception e) { rerr = String.valueOf(e.getMessage()); } }
            if (first) {
                if (rp == null) { if (strict) throw new IOException("rust: " + rerr); FALLBACKS.incrementAndGet(); note("fj.plan failed, Java's plan run: " + rerr); }
                onRust = rp != null;
                if (rp == null && jp == null) throw new IOException("no plan");
                KtFilePlan.Plan run = onRust ? rp : jp; total[0] = run.totalBytes; total[1] = run.totalFiles;
            } else if (onRust && rp == null) { REPLAN_ERRORS.incrementAndGet(); throw new IOException("rust: " + rerr); }
            KtFilePlan.Plan run = onRust ? rp : jp;
            if (onRust && jp != null) compare(jp.steps, rp.steps);
            steps = run.steps; ref = jp == null ? null : jp.steps;
            disputed = onRust ? KtFilePlan.disputed(steps, ref) : new HashSet<>();
            if (!disputed.isEmpty()) { DISPUTED.addAndGet(disputed.size()); note("items skipped, the planners disagree: " + disputed); }
            for (JSONArray s : steps) { String k = s.optString(0); if (k.equals("dir") || k.equals("endDir")) parentOf.put(s.optInt(2), s.optInt(3)); }
        }
        void openJournal() {
            if (journalDir == null) return;
            if (steps.size() > MAX_JOURNAL_STEPS) { JOURNALS_SKIPPED.incrementAndGet(); return; }
            try { journalDir.mkdirs(); prune(); jid = journalId(id); jr = new Journal(journalFile(jid)); jr.plan(op, snap.dest, 0, steps, disputed, itemPaths); }
            catch (Died d) { throw d; } catch (Exception e) { note("journal: " + e.getMessage()); if (jr != null) jr.close(); jr = null; }
        }
        void rec(boolean sync, String kind, Object... f) { if (jr == null) return; try { jr.put(sync, kind, f); } catch (IOException e) { note("journal: " + e.getMessage()); jr.close(); jr = null; } }

        boolean frameDead(int f) { int guard = 0; for (Integer x = f; x != null && guard++ < 100000; x = parentOf.get(x)) if (dead.contains(x)) return true; return false; }
        void notOk(int f) { ok.put(f, false); }
        void fail(String from, String why) { failed.put(new File(from).getName() + ": " + why); }
        void progress(String name, boolean force) { KtFileJobs.progress(ev, j, done, total, name, told, force); }
        String itemPath(int i) { return i < itemPaths.size() ? itemPaths.get(i) : "/"; }

        /** The steps from `k` to the end (or a cancel); a question or a failed rename re-plans in place. */
        void loop(int k) throws Exception {
            while (k < steps.size()) {
                if (j.cancel.get()) return;
                if (settled.contains(k)) { k++; continue; }   // (a resume: the journal shows it finished)
                JSONArray s = steps.get(k); String kind = s.optString(0); int item = s.optInt(1);
                if (disputed.contains(item) && !kind.equals("end")) {
                    if (toldDisputed.add(item)) { failed.put(new File(itemPath(item)).getName() + ": skipped — the two planners disagree"); rec(false, "K", k); }
                    k++; continue;
                }
                if (kind.equals("ask")) {
                    if (resuming) { failed.put("resume: stopped before a question — run the job again for the rest"); return; }
                    String a = ask(s.optString(2), s.optString(3)); if (j.cancel.get()) return;
                    answers.add(a); replan(k); continue;
                }
                if (!kind.equals("del") && !kind.equals("end")) {
                    int fr = s.optInt(2);
                    if (kind.equals("dir") && frameDead(s.optInt(3))) { dead.add(fr); k++; continue; }
                    if (frameDead(fr)) { k++; continue; }
                }
                if (kind.equals("del") && delFailed.contains(item)) { k++; continue; }
                if (!step(k, s)) {
                    if (resuming) { fail(s.optString(3), "cannot move it (resume)"); notOk(s.optInt(2)); rec(false, "F", k, "rename"); k++; continue; }
                    replan(k); continue;
                }
                k++;
            }
        }
        /** A new plan (an answer came, or a rename failed): the steps already run must be its first ones, unchanged. */
        void replan(int k) throws Exception {
            if (++replans > steps.size() * 2 + 100) throw new IOException("the plan does not settle");
            List<JSONArray> old = steps; plan(false);
            for (int i = 0; i < k; i++) if (i >= steps.size() || !steps.get(i).toString().equals(old.get(i).toString())) throw new IOException("the plan changed under the job");
            if (jr != null) try { jr.plan(op, snap.dest, k, steps, disputed, null); } catch (IOException e) { jr.close(); jr = null; }
        }

        String ask(String from, String to) throws Exception {
            File f = new File(from), t = new File(to);
            JSONObject o = new JSONObject(); o.put("id", id); o.put("status", "conflict"); o.put("from", f.getAbsolutePath()); o.put("to", t.getAbsolutePath()); o.put("size", f.isFile() ? f.length() : 0); o.put("existingSize", t.isFile() ? t.length() : 0); o.put("mtime", f.lastModified()); o.put("existingMtime", t.lastModified()); o.put("dir", f.isDirectory());
            String standing = j.conflict;
            synchronized (j.lock) { j.answer = null; j.asking = o; try { ev.on(o); while (j.answer == null && !j.cancel.get()) j.lock.wait(60000); } finally { j.asking = null; } String a = j.answer == null ? "skip" : j.answer; return !standing.equals(j.conflict) && j.conflict.equals(a) ? a + "All" : a; }
        }

        /** One step; false: a rename failed (to be re-planned with it copied). */
        boolean step(int k, JSONArray s) throws Exception {
            String kind = s.optString(0);
            switch (kind) {
                case "rename": {
                    File from = new File(s.optString(3)), to = new File(s.optString(4));
                    // (A resume after the rename went through: nothing to do but count it.)
                    if (resuming && !from.exists() && !KtFileJobs.link(from) && to.exists()) { done[0] += s.optLong(6); done[1] += s.optLong(5); rec(false, "D", k, to.length(), to.lastModified()); return true; }
                    if (to.exists() || KtFileJobs.link(to)) { renameFailed.add(from.getPath()); return false; }
                    rec(true, "B", k);
                    java.util.function.Predicate<File> rf = renameFails;
                    if ((rf != null && rf.test(from)) || !from.renameTo(to)) { renameFailed.add(from.getPath()); return false; }
                    done[0] += s.optLong(6); done[1] += s.optLong(5); rec(false, "D", k, to.length(), to.lastModified()); progress(to.getName(), true); return true;
                }
                case "dir": {
                    File into = new File(s.optString(5)); int fr = s.optInt(2); ok.put(fr, true);
                    rec(false, "B", k);
                    if (!into.isDirectory() && !into.mkdirs()) { fail(s.optString(4), "cannot make " + into.getName()); dead.add(fr); notOk(s.optInt(3)); rec(false, "F", k, "cannot make"); return true; }
                    rec(false, "D", k, 0, 0); return true;
                }
                case "copy": copy(k, s); return true;
                case "skip": { skipped++; if (!s.optBoolean(6)) { done[0] += s.optLong(4); done[1]++; progress(new File(s.optString(3)).getName(), true); } notOk(s.optInt(2)); rec(false, "K", k); return true; }
                case "fail": { fail(s.optString(3), s.optString(4)); notOk(s.optInt(2)); rec(false, "F", k, s.optString(4)); return true; }
                case "endDir": endDir(k, s); return true;
                case "del": {
                    File f = new File(s.optString(2)); long sz = f.isFile() ? f.length() : 0;
                    rec(true, "B", k);
                    if (!f.delete() && (f.exists() || KtFileJobs.link(f))) { int item = s.optInt(1); delFailed.add(item); fail(itemPath(item), "cannot delete " + f.getName()); rec(false, "F", k, "cannot delete"); return true; }
                    done[0] += sz; done[1]++; rec(false, "D", k, 0, 0); progress(f.getName(), false); return true;
                }
                case "end": { File f = new File(itemPath(s.optInt(1))); if (mv && s.optBoolean(2) && f.exists()) remaining.put(f.getAbsolutePath()); rec(false, "D", k, 0, 0); return true; }
                default: throw new IOException("unknown step " + kind);
            }
        }

        void copy(int k, JSONArray s) throws Exception {
            File from = new File(s.optString(3)), to = new File(s.optString(4)); long size = s.optLong(5); boolean replace = s.optBoolean(6); int fr = s.optInt(2);
            // (What is really there now, before anything is touched: a file the plan did not expect is never written over.)
            if (!replace && (to.exists() || KtFileJobs.link(to))) { fail(from.getPath(), "exists"); notOk(fr); rec(false, "F", k, "exists"); return; }
            if (replace && to.isDirectory()) { fail(from.getPath(), "cannot replace the folder " + to.getName()); notOk(fr); rec(false, "F", k, "folder"); return; }
            rec(true, "B", k);
            File part = new File(to.getParentFile(), to.getName() + ".ktpart"); long len = from.length(), wrote = 0;
            try (InputStream in = new FileInputStream(from); OutputStream out = new FileOutputStream(part)) {
                byte[] b = new byte[1 << 18]; int n;
                while ((n = in.read(b)) > 0) { if (j.cancel.get()) break; WriteHook h = writeHook; if (h != null) h.before(to, wrote, n); out.write(b, 0, n); wrote += n; done[0] += n; progress(from.getName(), false); }
            } catch (IOException e) { part.delete(); fail(from.getPath(), String.valueOf(e.getMessage())); notOk(fr); rec(false, "F", k, "io"); return; }
            if (j.cancel.get()) { part.delete(); notOk(fr); return; }
            if (wrote != len || part.length() != len) { part.delete(); fail(from.getPath(), "size changed while copying"); notOk(fr); rec(false, "F", k, "size"); return; }
            if (!putInPlace(k, part, to)) { part.delete(); fail(from.getPath(), "cannot write " + to.getName()); notOk(fr); rec(false, "F", k, "place"); return; }
            to.setLastModified(from.lastModified()); done[1]++; progress(from.getName(), true);
            if (s.optBoolean(7) && !from.delete()) { fail(from.getPath(), "copied, but cannot remove the original"); notOk(fr); rec(false, "F", k, "source"); return; }
            rec(false, "D", k, to.length(), to.lastModified());
        }
        /** KtFileJobs.putInPlace, the old file's new name journaled (on the disk) before it is set aside. */
        boolean putInPlace(int k, File part, File to) {
            if (!to.exists()) { boolean r = part.renameTo(to); if (r) rec(true, "L", k); return r; }
            File old = KtFileJobs.keepBoth(new File(to.getParentFile(), to.getName() + ".ktold"), false);
            rec(true, "A", k, old.getPath());
            if (!to.renameTo(old)) return false;
            if (!part.renameTo(to)) { old.renameTo(to); return false; }
            rec(true, "L", k); old.delete(); return true;
        }
        void endDir(int k, JSONArray s) throws Exception {
            int fr = s.optInt(2), parent = s.optInt(3); File from = new File(s.optString(4)), to = new File(s.optString(5)), into = new File(s.optString(6));
            if (Boolean.FALSE.equals(ok.get(fr))) { notOk(parent); return; }
            rec(true, "B", k);
            if (s.optBoolean(7)) {
                // (A folder replacing a file: the file set aside (journaled), the folder put in its place, then the file dropped.)
                if (to.isDirectory()) { fail(from.getPath(), "cannot replace " + to.getName()); notOk(parent); rec(false, "F", k, "swap"); return; }
                File old = KtFileJobs.keepBoth(new File(to.getParentFile(), to.getName() + ".ktold"), false);
                boolean had = to.exists();
                if (had) { rec(true, "A", k, old.getPath()); if (!to.renameTo(old)) { fail(from.getPath(), "cannot replace " + to.getName()); notOk(parent); rec(false, "F", k, "swap"); return; } }
                if (!into.renameTo(to)) { if (had) old.renameTo(to); fail(from.getPath(), "cannot replace " + to.getName()); notOk(parent); rec(false, "F", k, "swap"); return; }
                rec(true, "L", k); if (had) old.delete();
            }
            if (s.optBoolean(8) && !(resuming && !from.exists() && !KtFileJobs.link(from))) { String[] rest = from.list(); if (!(rest != null && rest.length == 0 && from.delete())) { fail(from.getPath(), "cannot remove the folder"); notOk(parent); rec(false, "F", k, "rmdir"); return; } }
            rec(false, "D", k, 0, 0);
        }

        void finish(String error) {
            try {
                JSONObject end = new JSONObject(); end.put("id", id);
                if (error != null) { end.put("status", "failed"); end.put("message", error); }
                else {
                    end.put("status", j.cancel.get() ? "cancelled" : "done"); end.put("done", done[0]); end.put("total", total[0]); end.put("files", done[1]); end.put("failed", failed); end.put("skipped", skipped);
                    if (mv) {
                        // (What a move left: the files still under the chosen paths that are still there — counted on the disk.)
                        JSONArray rem = remaining; long left = 0;
                        if (j.cancel.get()) { rem = new JSONArray(); for (String p : itemPaths) { File f = new File(p); if (f.exists()) rem.put(f.getAbsolutePath()); } }
                        for (int i = 0; i < rem.length(); i++) { long[] t = { 0, 0 }; KtFileJobs.count(new File(rem.getString(i)), t, null); left += Math.max(1, t[1]); }
                        end.put("left", left); end.put("remaining", rem);
                    }
                }
                end.put("engine", onRust ? "rust" : "java");
                if (jr != null) {
                    rec(true, "E", end.optString("status"));
                    if (jr != null) {
                        jr.close(); File fin = doneFile(jid); if (!jr.file.renameTo(fin)) fin = jr.file; jr = null;
                        end.put("journal", jid);
                        try { end.put("undoable", journalInfo(fin).optBoolean("undoable")); } catch (Exception ignored) {}
                    }
                }
                ev.on(end);
            } catch (Died d) { throw d; } catch (Exception ignored) {}
        }
    }

    /* ---------- journals: the list, resume, roll back, undo ---------- */
    static String read(File f) throws IOException { try (InputStream in = new FileInputStream(f)) { java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream(); byte[] x = new byte[1 << 16]; int n; while ((n = in.read(x)) > 0) b.write(x, 0, n); return new String(b.toByteArray(), StandardCharsets.UTF_8); } }
    static String textArgs(File f) throws IOException { StringBuilder b = new StringBuilder("{\"text\":"); KtFilePlan.q(b, read(f)); return b.append('}').toString(); }
    static JSONObject journalInfo(File f) throws Exception { return new JSONObject(KtCore.call("fj.journal", textArgs(f))).getJSONObject("r"); }
    /** A journal whose last record was torn (a crash mid-write) cut back to its last whole record, so what is appended
     *  next is read. */
    static void cutTorn(File f) throws IOException {
        String t = read(f); int at = 0, good = 0;
        while (at < t.length()) { int nl = t.indexOf('\n', at); if (nl < 0) break; String l = t.substring(at, nl); if (l.length() < 9 || l.charAt(8) != '\t') break; java.util.zip.CRC32 c = new java.util.zip.CRC32(); c.update(l.substring(9).getBytes(StandardCharsets.UTF_8)); long crc; try { crc = Long.parseLong(l.substring(0, 8), 16); } catch (NumberFormatException e) { break; } if (c.getValue() != crc) break; at = nl + 1; good = at; }
        if (good < t.length()) { long len = t.substring(0, good).getBytes(StandardCharsets.UTF_8).length; try (java.io.RandomAccessFile r = new java.io.RandomAccessFile(f, "rw")) { r.setLength(len); r.getFD().sync(); } }
    }
    static File findJournal(String jid) { if (jid == null || !jid.matches("[A-Za-z0-9_-]+")) return null; File a = journalFile(jid), b = doneFile(jid); if (a != null && a.isFile()) return a; if (b != null && b.isFile()) return b; return null; }

    /** The journals kept: {id, finished, op, dest, steps, done, resumable, undoable, at}, newest first. */
    static JSONArray journals() {
        JSONArray out = new JSONArray(); File d = journalDir; File[] fs = d == null ? null : d.listFiles(); if (fs == null) return out;
        List<File> l = new ArrayList<>(); for (File f : fs) if (f.getName().endsWith(".ktj")) l.add(f); l.sort((a, b) -> Long.compare(b.lastModified(), a.lastModified()));
        for (File f : l) { try { JSONObject o = journalInfo(f); String n = f.getName(); boolean fin = n.endsWith(".done.ktj"); o.put("id", n.substring(0, n.length() - (fin ? 9 : 4))); o.put("finished", fin); o.put("at", f.lastModified()); if (fin) o.put("resumable", false); else o.put("undoable", false); out.put(o); } catch (Exception ignored) {} }
        return out;
    }
    static int count(String flag) { int n = 0; JSONArray a = journals(); for (int i = 0; i < a.length(); i++) if (a.optJSONObject(i).optBoolean(flag)) n++; return n; }

    /** One action of a repair or a rollback, carried out only when what stands there allows it; false: not done (kept). */
    static boolean act(JSONArray a, Journal jr) throws Exception {
        String k = a.getString(0);
        switch (k) {
            case "unlinkPart": { File f = new File(a.getString(1)); if (f.isFile() && f.getName().endsWith(".ktpart")) f.delete(); return true; }
            case "unlink": { File f = new File(a.getString(1)); long size = Long.parseLong(a.getString(2)), mt = Long.parseLong(a.getString(3)); if (!f.exists()) return true; if (f.isFile() && f.length() == size && (mt < 0 || f.lastModified() == mt)) return f.delete(); return false; }
            case "restoreAside": { File old = new File(a.getString(1)), to = new File(a.getString(2)); if (old.exists() && !to.exists()) return old.renameTo(to); return !old.exists(); }
            case "dropAside": { File old = new File(a.getString(1)), to = new File(a.getString(2)); if (old.isFile() && to.exists()) return old.delete(); return !old.exists(); }
            case "moveBack": { File from = new File(a.getString(1)), to = new File(a.getString(2)); if (!from.exists() && !KtFileJobs.link(from)) return true; if (to.exists() || KtFileJobs.link(to)) return false; File p = to.getParentFile(); if (p != null) p.mkdirs(); if (from.renameTo(to)) return true; KtFileJobs.moveWhole(from, to); return true; }
            case "finishMove": { File from = new File(a.getString(1)), to = new File(a.getString(2)); long size = Long.parseLong(a.getString(3)); if (!from.exists()) return true; if (to.isFile() && to.length() == size && from.isFile() && from.length() == size) return from.delete(); return false; }
            case "swapIn": { File into = new File(a.getString(1)), to = new File(a.getString(2)); if (!to.exists() && into.isDirectory()) return into.renameTo(to); return to.isDirectory(); }
            case "rmdirEmpty": { File f = new File(a.getString(1)); String[] r = f.list(); if (r != null && r.length == 0) return f.delete(); return !f.exists(); }
            case "mkdir": { File f = new File(a.getString(1)); return f.isDirectory() || f.mkdirs(); }
            case "settleCopy": {
                File from = new File(a.getString(2)), to = new File(a.getString(3)), part = new File(to.getParentFile(), to.getName() + ".ktpart"); long size = Long.parseLong(a.getString(4)); boolean mv = Boolean.parseBoolean(a.getString(5)), replace = Boolean.parseBoolean(a.getString(6)); String o = a.getString(7);
                if (part.isFile()) part.delete();
                boolean placed;
                if (!o.isEmpty()) { File old = new File(o); if (!to.exists() && old.exists()) { old.renameTo(to); placed = false; } else if (to.exists() && old.exists()) { old.delete(); placed = true; } else placed = false; }
                else placed = !replace && to.isFile() && to.length() == size;   // (the step checked `to` was free before it began)
                if (!placed) return true;
                if (mv && from.isFile() && from.length() == size && to.isFile() && to.length() == size) from.delete();
                if (jr != null) jr.put(false, "D", a.getString(1), to.length(), to.lastModified());
                return true;
            }
            case "unsettleCopy": {
                File from = new File(a.getString(1)), to = new File(a.getString(2)), part = new File(to.getParentFile(), to.getName() + ".ktpart"); long size = Long.parseLong(a.getString(3)); boolean mv = Boolean.parseBoolean(a.getString(4)), replace = Boolean.parseBoolean(a.getString(5)); String o = a.getString(6);
                if (part.isFile()) part.delete();
                boolean ours = !o.isEmpty() ? to.exists() && new File(o).exists() : !replace && to.isFile() && to.length() == size;
                if (ours) { if (mv && !from.exists()) { if (!to.renameTo(from)) KtFileJobs.moveWhole(to, from); } else if (!to.delete()) return false; }
                if (!o.isEmpty()) { File old = new File(o); if (old.exists() && !to.exists()) return old.renameTo(to); }
                return true;
            }
            case "settleSwap": {
                File from = new File(a.getString(2)), to = new File(a.getString(3)), into = new File(a.getString(4)); String o = a.getString(5); boolean rmdir = Boolean.parseBoolean(a.getString(6)); File old = o.isEmpty() ? null : new File(o);
                if (old != null && old.exists() && !to.exists() && into.isDirectory()) into.renameTo(to);
                boolean placed = to.isDirectory() && !into.exists();
                if (!placed) { if (old != null && old.exists() && !to.exists()) old.renameTo(to); return true; }
                if (old != null && old.isFile()) old.delete();
                if (rmdir) { String[] r = from.list(); if (r != null && r.length == 0) from.delete(); }
                if (jr != null) jr.put(false, "D", a.getString(1), 0, 0);
                return true;
            }
            case "unsettleSwap": {
                File to = new File(a.getString(1)), into = new File(a.getString(2)); String o = a.getString(3); File old = o.isEmpty() ? null : new File(o);
                if (to.isDirectory() && !into.exists() && (old == null || old.exists())) to.renameTo(into);
                if (old != null && old.exists() && !to.exists()) return old.renameTo(to);
                return true;
            }
            case "markDone": if (jr != null) jr.put(false, "D", a.getString(1), 0, 0); return true;
            case "markUndone": if (jr != null) jr.put(false, "Z", a.getString(1)); return true;
            default: return false;
        }
    }

    /** A job cut short, resumed: its half-done steps repaired (Rust's fj.repair), then the rest of its plan run (a step
     *  that would need a new plan — a question, a rename that fails — ends the resume there: run the job again for it). */
    static void resume(String jid, String id, KtFileJobs.Events ev) {
        File f = findJournal(jid); KtFileJobs.Job job = new KtFileJobs.Job(id); KtFileJobs.jobs.put(id, job);
        Journal jr = null;
        try {
            if (f == null || f.getName().endsWith(".done.ktj")) throw new IOException("noJournal");
            cutTorn(f);
            String args = textArgs(f);
            JSONObject info = new JSONObject(KtCore.call("fj.journal", args)).getJSONObject("r");
            if (!info.optBoolean("resumable")) throw new IOException("notResumable");
            JSONArray repair = new JSONObject(KtCore.call("fj.repair", args)).getJSONArray("r");
            List<JSONArray> steps = new ArrayList<>(); List<String> sts = new ArrayList<>(); Set<Integer> disputed = new HashSet<>(); List<String> items = new ArrayList<>();
            String op = parseJournal(read(f), steps, sts, disputed, items);
            if (steps.size() != info.optInt("steps")) throw new IOException("journal read differently");
            jr = new Journal(f); jr.put(true, "W");
            List<String> kept = new ArrayList<>();
            for (int i = 0; i < repair.length(); i++) { JSONArray a = repair.getJSONArray(i); if (!act(a, jr)) kept.add(a.getString(0) + " " + a.optString(1)); }
            // (The repairs marked what they finished: the states read again.)
            steps.clear(); sts.clear(); disputed.clear(); items.clear(); parseJournal(read(f), steps, sts, disputed, items);
            Exec x = new Exec(id, op, new File(info.optString("dest")), ev); x.j = job; x.jr = jr; x.jid = jid; x.onRust = true; x.resuming = true; x.steps = steps; x.disputed = disputed; x.itemPaths = items;
            x.snap = new KtFilePlan.Snap(); x.snap.op = op; x.snap.dest = info.optString("dest");
            // (A step that does nothing writes no record — the endDir of a folder a file of which failed, a step under a
            // folder that could not be made —, so a finished step can stand after the first unfinished one: it is SETTLED,
            // counted as it ended and never run again; run again, a moved file would find itself «exists».)
            int next = -1;
            for (int i = 0; i < steps.size(); i++) {
                JSONArray s = steps.get(i); String k = s.optString(0), st = sts.get(i);
                if (k.equals("dir") || k.equals("endDir")) x.parentOf.put(s.optInt(2), s.optInt(3));
                if (st.equals("pending") || st.equals("begun") || st.equals("aside") || st.equals("placed")) { if (next < 0) next = i; continue; }
                if (next >= 0) x.settled.add(i);
                if (k.equals("dir")) { if (st.equals("failed")) x.dead.add(s.optInt(2)); else x.ok.put(s.optInt(2), true); }
                else if (k.equals("del") && st.equals("failed")) x.delFailed.add(s.optInt(1));
                else if ((st.equals("failed") || st.equals("skipped")) && !k.equals("del") && !k.equals("end")) x.notOk(s.optInt(2));
            }
            jr = null;   // (the Exec closes it)
            try { x.loop(next < 0 ? steps.size() : next); } catch (Died d) { throw d; } catch (Exception e) { x.failed.put("resume: " + e.getMessage()); }
            if (!kept.isEmpty()) x.failed.put("resume: kept as it was — " + kept);
            x.finish(null);
            if (x.jr != null) x.jr.close();
        } catch (Died d) { throw d;
        } catch (Exception e) {
            try { JSONObject end = new JSONObject(); end.put("id", id); end.put("status", "failed"); end.put("message", String.valueOf(e.getMessage())); ev.on(end); } catch (Exception ignored) {}
        } finally { if (jr != null) jr.close(); KtFileJobs.jobs.remove(id); }
    }
    /** The plan, the steps' states, the disputed items and the items' paths as written (the reading of filejournal.rs;
     *  `fj.journal` is asked first, and a count that differs refuses the resume). */
    static String parseJournal(String text, List<JSONArray> steps, List<String> sts, Set<Integer> disputed, List<String> items) {
        String op = ""; List<JSONArray> pending = new ArrayList<>(); int from = 0, want = 0;
        int at = 0;
        while (at < text.length()) {
            int nl = text.indexOf('\n', at); if (nl < 0) break;
            String l = text.substring(at, nl); at = nl + 1;
            if (l.length() < 9 || l.charAt(8) != '\t') break;
            String body = l.substring(9); java.util.zip.CRC32 c = new java.util.zip.CRC32(); c.update(body.getBytes(StandardCharsets.UTF_8));
            long crc; try { crc = Long.parseLong(l.substring(0, 8), 16); } catch (NumberFormatException e) { break; }
            if (c.getValue() != crc) break;
            String[] f = body.split("\t", -1); for (int i = 0; i < f.length; i++) f[i] = unesc(f[i]);
            try {
                switch (f[0]) {
                    case "P": op = f[2]; from = Integer.parseInt(f[4]); want = Integer.parseInt(f[5]); pending.clear(); break;
                    case "S": pending.add(stepOf(f)); break;
                    case "I": { int i = Integer.parseInt(f[1]); while (items.size() <= i) items.add("/"); items.set(i, f[2]); break; }
                    case "R": if (pending.size() == want && from <= steps.size()) { while (steps.size() > from) { steps.remove(steps.size() - 1); sts.remove(sts.size() - 1); } for (JSONArray s : pending) { steps.add(s); sts.add("pending"); } pending.clear(); } break;
                    case "X": disputed.add(Integer.parseInt(f[1])); break;
                    case "B": case "A": case "L": case "D": case "F": case "K": { int i = Integer.parseInt(f[1]); if (i < sts.size()) sts.set(i, f[0].equals("B") ? "begun" : f[0].equals("A") ? "aside" : f[0].equals("L") ? "placed" : f[0].equals("D") ? "done" : f[0].equals("F") ? "failed" : "skipped"); break; }
                    default: break;
                }
            } catch (RuntimeException e) { break; }
        }
        return op;
    }
    private static String unesc(String s) { if (s.indexOf('\\') < 0) return s; StringBuilder b = new StringBuilder(); for (int i = 0; i < s.length(); i++) { char c = s.charAt(i); if (c != '\\' || i + 1 >= s.length()) { b.append(c); continue; } char e = s.charAt(++i); b.append(e == 't' ? '\t' : e == 'n' ? '\n' : e == 'r' ? '\r' : e); } return b.toString(); }
    /** A step back from its fields: the numbers and flags at their places (fileplan::Step::to_json's layout). */
    static JSONArray stepOf(String[] f) {
        String k = f[2]; String types;
        switch (k) { case "ask": types = "nss"; break; case "rename": types = "nnssnn"; break; case "dir": types = "nnnssbn"; break; case "copy": types = "nnssnbb"; break; case "skip": types = "nnsnnb"; break; case "fail": types = "nnssn"; break; case "endDir": types = "nnnsssbb"; break; case "del": types = "nsn"; break; case "end": types = "nb"; break; default: throw new IllegalArgumentException("step " + k); }
        JSONArray a = new JSONArray(); a.put(k);
        for (int i = 0; i < types.length(); i++) { String v = f[3 + i]; char t = types.charAt(i); if (t == 'n') { long n = Long.parseLong(v); if (n >= Integer.MIN_VALUE && n <= Integer.MAX_VALUE) a.put((int) n); else a.put(n); } else if (t == 'b') a.put(Boolean.parseBoolean(v)); else a.put(v); }
        return a;
    }

    /** A job cut short rolled back, or a finished one undone: {undone, kept: […], lost: […]}. */
    static JSONObject rollback(String jid, boolean finishedOnly) throws Exception {
        File f = findJournal(jid); if (f == null) throw new IOException("noJournal");
        boolean fin = f.getName().endsWith(".done.ktj"); if (finishedOnly && !fin) throw new IOException("notFinished");
        cutTorn(f);
        String args = textArgs(f);
        JSONObject info = new JSONObject(KtCore.call("fj.journal", args)).getJSONObject("r");
        if (finishedOnly && !info.optBoolean("undoable")) throw new IOException("notUndoable");
        if (!fin && !info.optBoolean("resumable")) throw new IOException("notResumable");
        JSONObject r = new JSONObject(KtCore.call("fj.rollback", args)).getJSONObject("r");
        JSONArray acts = r.getJSONArray("acts"); JSONArray kept = new JSONArray(); int undone = 0;
        try (Journal jr = new Journal(f)) {
            for (int i = 0; i < acts.length(); i++) { JSONArray a = acts.getJSONArray(i); if (a.getString(0).equals("markUndone")) { act(a, jr); undone++; continue; } if (!act(a, jr)) kept.put(a.getString(0) + " " + a.optString(1)); }
            jr.put(true, "Y");
        }
        if (!fin) { File d = doneFile(jid); if (d != null) f.renameTo(d); }
        JSONObject o = new JSONObject(); o.put("undone", undone); o.put("kept", kept); o.put("lost", r.getJSONArray("lost")); return o;
    }
    static boolean dismiss(String jid) { File f = findJournal(jid); return f != null && f.delete(); }

    /** The figures for deviceInfo (and the «Rust core status» card). */
    static JSONObject report() {
        JSONObject o = new JSONObject();
        try {
            o.put("fileEngineChoice", rustChosen() ? "rust" : "classic"); o.put("fileEngine", inUse()); o.put("fileEngineFallbacks", FALLBACKS.get());
            o.put("fileChecks", CHECKS.get()); o.put("fileMismatches", MISMATCHES.get()); o.put("fileDisputed", DISPUTED.get()); o.put("fileJobsRust", JOBS_RUST.get()); o.put("fileReplanErrors", REPLAN_ERRORS.get());
            synchronized (FIRST) { o.put("fileFirst", new JSONArray(FIRST)); }
            o.put("fileJournalResumable", journalDir == null ? 0 : count("resumable")); o.put("fileJournalUndoable", journalDir == null ? 0 : count("undoable")); o.put("fileJournalSkipped", JOURNALS_SKIPPED.get());
            // (the network storages' rules follow the file jobs' choice)
            o.put("remoteEngine", inUse().equals("rust") ? "rust" : "java"); o.put("remoteEngineChoice", rustChosen() ? "rust" : "java"); o.put("remoteEngineFallbacks", KtRemoteRules.FALLBACKS.get()); o.put("remoteChecks", KtRemoteRules.CHECKS.get()); o.put("remoteMismatches", KtRemoteRules.MISMATCHES.get());
        } catch (Throwable ignored) {}
        return o;
    }
}
