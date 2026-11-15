import app.kurokawa.tools.KtCore;
import java.io.*; import java.nio.file.*; import java.security.MessageDigest; import java.util.*; import org.json.*;

/** Stage M5 on the computer, through the host library: the two planners (Java's KtFilePlan, Rust's fj.plan) asked the
 *  same of many random trees — odd names (Arabic, emoji, trailing dots and spaces, 255-byte names), every operation
 *  and answer — and required to agree step for step; the Rust engine's jobs on temp folders against the classic
 *  engine's (the same trees after); a rename that fails (a move across storages) re-planned as a copy; a full «disk»
 *  (a quota hook) that leaves the source and the old file whole; Rust's plan tampered with — the item skipped, nothing
 *  overwritten; and THE JOURNAL: a random job killed before every one of its journal records (and with the record torn
 *  in half), then resumed or rolled back, never a file lost, a resume ending as the whole job would, a rollback where
 *  the job made no replace back at the start; a finished move undone. Also the bin's, archives', the vault's and the
 *  network storages' rules, Java's against Rust's. `absent`: with no library, a Rust choice runs the classic engine. */
public class FileJobsRustT {
  static int fails = 0, oks = 0; static void ok(String what, boolean c) { if (c) oks++; else { System.out.println("FAIL " + what); fails++; } }
  static void say(String s) { System.out.println(s); }
  static File mk(File d, String rel, String text) throws IOException { File f = new File(d, rel); f.getParentFile().mkdirs(); Files.write(f.toPath(), text.getBytes("UTF-8")); return f; }
  static String read(File f) { try { return new String(Files.readAllBytes(f.toPath()), "UTF-8"); } catch (IOException e) { return null; } }
  static int seq = 0;
  static File fresh(File root, String name) { File d = new File(root, name + "-" + (++seq)); d.mkdirs(); return d; }
  static void deleteAll(File f) { if (f.isDirectory() && !Files.isSymbolicLink(f.toPath())) { File[] k = f.listFiles(); if (k != null) for (File c : k) deleteAll(c); } f.delete(); }

  /** A tree as text: relative path → content (folders as «/»), sorted — what «the same tree» means here. */
  static TreeMap<String, String> tree(File d) { TreeMap<String, String> m = new TreeMap<>(); walk(d, "", m); return m; }
  static void walk(File d, String pre, Map<String, String> m) { File[] k = d.listFiles(); if (k == null) return; for (File c : k) { String r = pre + c.getName(); if (Files.isSymbolicLink(c.toPath())) m.put(r, "->link"); else if (c.isDirectory()) { m.put(r + "/", "/"); walk(c, r + "/", m); } else m.put(r, read(c)); } }
  static Set<String> contents(File... ds) { Set<String> s = new HashSet<>(); for (File d : ds) for (Map.Entry<String, String> e : tree(d).entrySet()) if (!e.getValue().equals("/")) s.add(e.getValue()); return s; }
  static boolean stray(File d) { for (String k : tree(d).keySet()) if (k.contains(".ktpart") || k.contains(".ktold")) return true; return false; }
  static void copyTree(File from, File to) throws IOException { to.mkdirs(); File[] k = from.listFiles(); if (k == null) return; for (File c : k) { File t = new File(to, c.getName()); if (c.isDirectory()) copyTree(c, t); else Files.copy(c.toPath(), t.toPath()); } }

  /** A job run to its end on the engine set: «conflict» the standing answer, or «ask:x» answered x each time. */
  static JSONObject job(String op, List<File> paths, File dest, String conflict, List<JSONObject> events) {
    String id = "j" + (++seq); JSONObject[] end = { null }; String ans = conflict.startsWith("ask:") ? conflict.substring(4) : null;
    KtFileExec.run(id, op, paths, dest, ans == null ? conflict : "ask", (ev) -> {
      String st = ev.optString("status"); if (events != null) events.add(ev);
      if (st.equals("conflict")) KtFileJobs.answer(id, ans == null ? "skip" : ans); else if (!st.equals("progress")) end[0] = ev;
    });
    return end[0];
  }

  static final Random R = new Random(20261115);
  static final String[] NAMES = { "a.txt", "b.TXT", "صورة.jpg", "مجلد", "😀.png", "x.😀", "trail.", "trail ", "dots...", ".hidden", "no ext", "a (2).txt", "Ж.dat", "k.tar.gz", "q.verylongext" };
  static String name(int depth) {
    int r = R.nextInt(20);
    if (r == 0) { StringBuilder b = new StringBuilder(); while (b.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length < 251) b.append('n'); return b.append(".bin").toString(); }   // (255 bytes)
    if (r == 1) { StringBuilder b = new StringBuilder(); for (int i = 0; i < 63; i++) b.append('ب'); return b.append(".txt").toString(); }   // (130 bytes, 67 chars)
    return NAMES[R.nextInt(NAMES.length)];
  }
  /** A random tree under d (files of random text, folders, now and then the same names as in another tree). */
  static void randomTree(File d, int depth, int budget) throws IOException {
    int n = 1 + R.nextInt(4);
    for (int i = 0; i < n && budget > 0; i++, budget--) {
      String nm = name(depth); File f = new File(d, nm); if (f.exists()) continue;
      if (depth < 3 && R.nextInt(3) == 0) { f.mkdirs(); randomTree(f, depth + 1, budget / 2); }
      else try { Files.write(f.toPath(), ("c" + R.nextInt(1000000) + "-" + nm).getBytes("UTF-8")); } catch (IOException e) { /* a name too long for this disk: none */ }
    }
  }

  public static void main(String[] a) throws Exception {
    boolean absent = a.length > 0 && a[0].equals("absent");
    File root = Files.createTempDirectory("ktfj").toFile();
    if (absent) {
      ok("no library: the core is absent", !KtCore.available());
      KtFileExec.choice = "rust";
      File s = fresh(root, "s"), d = fresh(root, "d"); File f = mk(s, "a.txt", "A");
      JSONObject e = job("move", Arrays.asList(f), d, "skip", null);
      ok("no library: a Rust choice runs the classic engine, the job done", "A".equals(read(new File(d, "a.txt"))) && !f.exists() && !e.has("engine"));
      deleteAll(root); say(fails == 0 ? "all passed (" + oks + " checks, no library)" : fails + " failed"); System.exit(fails == 0 ? 0 : 1);
    }
    ok("the core is here", KtCore.available());
    KtFileExec.strict = true;

    // ---- 1. the two planners on random trees: the same steps
    int plans = 0, differ = 0;
    for (int round = 0; round < 160; round++) {
      File s = fresh(root, "ps"), d = fresh(root, "pd"); randomTree(s, 0, 14);
      // (the destination: some of the same names, files where folders are and back)
      for (String k : tree(s).keySet()) if (R.nextInt(3) == 0) { File t = new File(d, k.endsWith("/") ? k.substring(0, k.length() - 1) : k); t.getParentFile().mkdirs(); if (R.nextBoolean()) t.mkdirs(); else try { Files.write(t.toPath(), "old".getBytes()); } catch (IOException e) {} }
      File[] top = s.listFiles(); List<File> paths = new ArrayList<>(Arrays.asList(top == null ? new File[0] : top)); if (R.nextInt(4) == 0) paths.add(new File(s, "missing")); if (R.nextInt(5) == 0) paths.add(d);
      String op = new String[] { "copy", "move", "delete" }[R.nextInt(3)]; String conflict = new String[] { "ask", "skip", "replace", "keep" }[R.nextInt(4)];
      File dest = R.nextInt(6) == 0 ? s : d;
      KtFilePlan.Snap snap = KtFilePlan.snapshot(op, paths, dest, conflict, null); if (R.nextBoolean()) for (KtFilePlan.Item it : snap.items) it.sameVol = !it.sameVol;
      List<String> answers = new ArrayList<>(); Set<String> rf = new HashSet<>();
      for (int step = 0; step < 6; step++) {
        KtFilePlan.Plan j = KtFilePlan.plan(snap, answers, rf), r = KtFileExec.rustPlan(snap, answers, rf); plans++;
        boolean same = j.steps.size() == r.steps.size() && j.totalBytes == r.totalBytes && j.totalFiles == r.totalFiles && j.asks == r.asks && j.copyBytes == r.copyBytes;
        for (int i = 0; same && i < j.steps.size(); i++) same = j.steps.get(i).toString().equals(r.steps.get(i).toString());
        if (!same) { differ++; if (differ < 4) { say("plans differ (" + op + ", " + conflict + ", " + answers + "):"); for (int i = 0; i < Math.max(j.steps.size(), r.steps.size()); i++) { String x = i < j.steps.size() ? j.steps.get(i).toString() : "-", y = i < r.steps.size() ? r.steps.get(i).toString() : "-"; if (!x.equals(y)) { say("  java " + x); say("  rust " + y); break; } } } }
        if (j.asks) answers.add(new String[] { "skip", "replace", "keep", "skipAll", "keepAll", "replaceAll" }[R.nextInt(6)]);
        else { boolean any = false; for (JSONArray x : j.steps) if (x.optString(0).equals("rename") && R.nextBoolean()) { rf.add(x.optString(3)); any = true; } if (!any) break; }
      }
      deleteAll(s); deleteAll(d);
    }
    ok("the two planners agree on " + plans + " plans of random trees (" + differ + " differ)", differ == 0);
    say("planners compared: " + plans + " plans, " + differ + " differ");

    // ---- 2. the Rust engine's jobs against the classic engine's: the same trees after
    int same = 0, runs = 0;
    for (int round = 0; round < 60; round++) {
      File base = fresh(root, "base"); File s0 = new File(base, "s"), d0 = new File(base, "d"); s0.mkdirs(); d0.mkdirs(); randomTree(s0, 0, 10);
      for (String k : tree(s0).keySet()) if (R.nextInt(3) == 0 && !k.endsWith("/")) try { mk(d0, k, "old"); } catch (IOException e) {}
      String op = new String[] { "copy", "move", "delete" }[R.nextInt(3)]; String conflict = new String[] { "skip", "replace", "keep", "ask:keep", "ask:replace" }[R.nextInt(5)];
      TreeMap<String, String>[] out = new TreeMap[2]; JSONObject[] ends = new JSONObject[2];
      for (int e = 0; e < 2; e++) {
        File w = fresh(root, "w"); copyTree(base, w); File s = new File(w, "s"), d = new File(w, "d"); List<File> paths = listTop(s);
        KtFileExec.choice = e == 0 ? "classic" : "rust"; ends[e] = job(op, paths, d, conflict, null); out[e] = tree(w); deleteAll(w);
      }
      runs++; if (out[0].equals(out[1]) && ends[0].optInt("skipped") == ends[1].optInt("skipped") && ends[0].optJSONArray("failed").length() == ends[1].optJSONArray("failed").length() && ends[0].optLong("left", -1) == ends[1].optLong("left", -1)) same++;
      else if (runs - same < 3) say("engines differ: " + op + " " + conflict + "\n classic " + out[0] + " " + ends[0] + "\n rust    " + out[1] + " " + ends[1]);
      deleteAll(base);
    }
    ok("classic and Rust engines leave the same trees and ends (" + same + "/" + runs + ")", same == runs);
    KtFileExec.choice = "rust";

    // ---- 3. a rename that fails (across storages): re-planned as a copy, all there, the source gone
    { File s = fresh(root, "s"), d = fresh(root, "d"); mk(s, "D/x.txt", "X"); mk(s, "D/sub/y.txt", "Y"); mk(s, "f.txt", "F");
      KtFileExec.renameFails = (f) -> true;
      JSONObject e = job("move", Arrays.asList(new File(s, "D"), new File(s, "f.txt")), d, "skip", null); KtFileExec.renameFails = null;
      ok("rename fails → copied then deleted: all moved", "X".equals(read(new File(d, "D/x.txt"))) && "Y".equals(read(new File(d, "D/sub/y.txt"))) && "F".equals(read(new File(d, "f.txt"))) && !new File(s, "D").exists() && !new File(s, "f.txt").exists() && "rust".equals(e.optString("engine"))); }

    // ---- 4. a full «disk»: the copy fails, the source and the old file whole, no part left
    { File s = fresh(root, "s"), d = fresh(root, "d"); File big = new File(s, "big.bin"); byte[] b = new byte[3 << 20]; R.nextBytes(b); Files.write(big.toPath(), b); mk(d, "big.bin", "OLD"); mk(s, "small.txt", "S");
      KtFileExec.writeHook = (to, already, n) -> { if (already + n > (1 << 20)) throw new IOException("No space left on device"); };
      JSONObject e = job("move", Arrays.asList(big, new File(s, "small.txt")), d, "replace", null); KtFileExec.writeHook = null;
      ok("full disk: the move fails, told; the source whole; the old file kept; no part", big.length() == 3 << 20 && "OLD".equals(read(new File(d, "big.bin"))) && !stray(d) && e.getJSONArray("failed").length() == 1 && e.getJSONArray("failed").getString(0).contains("No space"));
      ok("full disk: the small file after it still moved", "S".equals(read(new File(d, "small.txt"))) && e.optLong("left") == 1); }

    // ---- 5. long and odd names: a 255-byte name kept both cannot be made longer — refused, the source kept
    { File s = fresh(root, "s"), d = fresh(root, "d"); StringBuilder nb = new StringBuilder(); while (nb.length() < 251) nb.append('n'); String n255 = nb + ".bin";
      boolean made = true; try { mk(s, n255, "LONG"); mk(d, n255, "OLD"); } catch (IOException e) { made = false; }
      if (made) { JSONObject e = job("copy", Arrays.asList(new File(s, n255)), d, "keep", null);
        ok("255-byte name, keep both: «… (2)» too long, the job tells it, nothing lost", "LONG".equals(read(new File(s, n255))) && "OLD".equals(read(new File(d, n255))) && e.getJSONArray("failed").length() == 1 && !stray(d)); }
      for (String odd : new String[] { "trail. ", "x.😀", "مجلد مسافة", "a\tb", ".." + "x" }) { File f = mk(s, odd, odd); JSONObject e = job("copy", Arrays.asList(f), d, "keep", null); ok("odd name «" + odd + "» copied", odd.equals(read(new File(d, odd))) && e.getJSONArray("failed").length() == 0); } }

    // ---- 6. Rust's plan tampered with: the item skipped and told, nothing overwritten, the job goes on
    { File s = fresh(root, "s"), d = fresh(root, "d"); File f = mk(s, "a.txt", "NEW"); File g = mk(s, "b.txt", "B"); mk(d, "a.txt", "OLD"); mk(d, "victim.txt", "PRECIOUS");
      KtFileExec.tamper = (st) -> { for (int i = 0; i < st.size(); i++) { JSONArray x = st.get(i); if (x.optString(0).equals("copy") && x.optString(3).endsWith("/a.txt")) { JSONArray y = new JSONArray(x.toString()); y.put(4, new File(d, "victim.txt").getPath()); y.put(6, true); st.set(i, y); } } };
      long before = KtFileExec.DISPUTED.get(); JSONObject e = job("move", Arrays.asList(f, g), d, "replace", null); KtFileExec.tamper = null;
      ok("tampered plan: the victim untouched, the item skipped and told", "PRECIOUS".equals(read(new File(d, "victim.txt"))) && "NEW".equals(read(f)) && "OLD".equals(read(new File(d, "a.txt"))) && KtFileExec.DISPUTED.get() == before + 1 && e.getJSONArray("failed").toString().contains("disagree"));
      ok("tampered plan: the other item moved", "B".equals(read(new File(d, "b.txt"))) && !g.exists()); }

    // ---- 7. THE JOURNAL: killed before every record, resumed or rolled back
    File jd = fresh(root, "journals"); KtFileExec.journalDir = jd;
    int kills = 0, resumed = 0, rolled = 0, lost = 0, badResume = 0, badRollback = 0, notStarted = 0;
    for (int round = 0; round < 24; round++) {
      File base = fresh(root, "jb"); File s0 = new File(base, "s"), d0 = new File(base, "d"); s0.mkdirs(); d0.mkdirs(); randomTree(s0, 0, 8);
      boolean conflicts = round % 3 == 0;
      // (conflicts: some files there already, and now and then a FILE where the source has a folder — the swap)
      if (conflicts) for (String k : tree(s0).keySet()) if (R.nextInt(3) == 0) try { if (!k.endsWith("/")) mk(d0, k, "old-" + k.hashCode()); else if (k.indexOf('/') == k.length() - 1 && !new File(d0, k).exists()) mk(d0, k.substring(0, k.length() - 1), "file-" + k.hashCode()); } catch (IOException e) {}
      String op = new String[] { "copy", "move", "move", "delete" }[round % 4]; String conflict = conflicts ? new String[] { "skip", "keep", "replace" }[(round / 3) % 3] : "skip";
      boolean cross = round % 2 == 1;
      // the whole job, uninterrupted: its result and its number of records
      File w = fresh(root, "jw"); copyTree(base, w); KtFileExec.crossVolume = cross; long w0 = KtFileExec.Journal.WRITES.get();
      job(op, listTop(new File(w, "s")), new File(w, "d"), conflict, null); long records = KtFileExec.Journal.WRITES.get() - w0; TreeMap<String, String> want = tree(w); deleteAll(w);
      Set<String> all = contents(s0, d0);
      for (long n = 1; n <= records; n++) for (int torn = 0; torn < 2; torn++) {
        if (torn == 1 && n % 3 != 0) continue;
        File x = fresh(root, "jx"); copyTree(base, x); for (File f : jd.listFiles()) f.delete();
        KtFileExec.dieAt = (int) (KtFileExec.Journal.WRITES.get() + n); KtFileExec.dieTorn = torn == 1; boolean died = false;
        try { job(op, listTop(new File(x, "s")), new File(x, "d"), conflict, null); } catch (KtFileExec.Died d) { died = true; }
        KtFileExec.dieAt = -1; KtFileExec.dieTorn = false; if (!died) { deleteAll(x); continue; } kills++;
        String jid = null; for (File f : jd.listFiles()) if (f.getName().endsWith(".ktj") && !f.getName().endsWith(".done.ktj")) jid = f.getName().substring(0, f.getName().length() - 4);
        JSONObject info = jid == null ? null : KtFileExec.journalInfo(new File(jd, jid + ".ktj"));
        if (info == null || !info.optBoolean("resumable")) { notStarted++; if (!tree(x).equals(tree(base))) { badRollback++; say("killed before the plan was whole, yet the tree changed: " + op + " n=" + n); } deleteAll(x); continue; }
        boolean doResume = (n + torn) % 2 == 0;
        if (doResume) {
          String before = System.getenv("KT_DEBUG") == null ? null : KtFileExec.read(new File(jd, jid + ".ktj")); TreeMap<String, String> tb = before == null ? null : tree(x);
          JSONObject[] end = { null }; KtFileExec.resume(jid, "r" + n, (ev) -> { if (!ev.optString("status").equals("progress")) end[0] = ev; }); resumed++;
          TreeMap<String, String> got = tree(x);
          if (!got.equals(want) && before != null && badResume == 0) { say("JOURNAL BEFORE RESUME:\n" + before.replaceAll("[n]{20,}", "N").replaceAll("[ب]{20,}", "B") + "\nTREE AT KILL " + tb.toString().replaceAll("[n]{20,}", "N").replaceAll("[ب]{20,}", "B") + "\nAFTER " + KtFileExec.read(new File(jd, jid + ".done.ktj")).replaceAll("[n]{20,}", "N").replaceAll("[ب]{20,}", "B")); }
          if (!got.equals(want)) { badResume++; if (badResume < 4) say("resume differs (" + op + " " + conflict + " cross=" + cross + " n=" + n + " torn=" + torn + "):\n want " + want + "\n got  " + got + "\n end " + end[0]); }
        } else {
          JSONObject r = KtFileExec.rollback(jid, false); rolled++;
          if (r.getJSONArray("lost").length() == 0 && !tree(x).equals(tree(base))) { if (System.getenv("KT_DEBUG") != null && badRollback == 0) say("JOURNAL AFTER ROLLBACK:\n" + KtFileExec.read(new File(jd, jid + ".done.ktj")).replaceAll("[n]{20,}", "N").replaceAll("[ب]{20,}", "B")); badRollback++; if (badRollback < 4) say("rollback differs (" + op + " " + conflict + " n=" + n + "):\n base " + tree(base) + "\n got  " + tree(x) + "\n " + r); }
        }
        Set<String> now = contents(new File(x, "s"), new File(x, "d"));
        if (!op.equals("delete") && !conflict.equals("replace")) for (String c : all) if (!now.contains(c)) { lost++; say("LOST «" + c + "» after " + (doResume ? "resume" : "rollback") + " (" + op + " n=" + n + ")"); break; }
        if (stray(x)) { lost++; say("stray part/old file left (" + op + " n=" + n + "): " + tree(x).keySet()); }
        deleteAll(x);
      }
      KtFileExec.crossVolume = false; deleteAll(base);
    }
    say("journal: " + kills + " kills, " + resumed + " resumed, " + rolled + " rolled back, " + notStarted + " before the plan was whole");
    ok("journal: no file ever lost, no part left", lost == 0);
    ok("journal: every resume ends as the whole job", badResume == 0);
    ok("journal: every rollback (no replace) back at the start", badRollback == 0);
    ok("journal: it was really tried (kills > 100)", kills > 100);

    // ---- 8. a finished move undone; a finished copy over a file not undoable
    { for (File f : jd.listFiles()) f.delete(); File s = fresh(root, "s"), d = fresh(root, "d"); mk(s, "D/x.txt", "X"); mk(s, "D/sub/y.txt", "Y"); mk(s, "f.txt", "F"); TreeMap<String, String> t0 = tree(s);
      JSONObject e = job("move", listTop(s), d, "skip", null);
      ok("a finished move: journaled, undoable", e.has("journal") && e.optBoolean("undoable"));
      JSONObject u = KtFileExec.rollback(e.getString("journal"), true);
      ok("…undone: all back where it was, the destination empty", tree(s).equals(t0) && tree(d).isEmpty() && u.getJSONArray("lost").length() == 0);
      boolean refused = false; try { KtFileExec.rollback(e.getString("journal"), true); } catch (IOException x) { refused = true; } ok("…and not undone twice", refused);
      mk(d, "f.txt", "OLD"); JSONObject e2 = job("copy", Arrays.asList(new File(s, "f.txt")), d, "replace", null);
      ok("a copy that replaced a file: not undoable", e2.has("journal") && !e2.optBoolean("undoable"));
      ok("the journals listed", KtFileExec.journals().length() == 2); }
    KtFileExec.journalDir = null;

    // ---- 9. the small rules: Java's against Rust's
    { long now = 1731650000123L;
      for (String p : new String[] { "/storage/emulated/0/a.txt", "/storage/AB12-CD34/مجلد/😀.png", "", "x" }) ok("trash slot of «" + p + "»", (now + "-" + Integer.toHexString(p.hashCode())).equals(KtCore.r("fj.trashSlot", "now", now, "path", p)));
      for (String n : new String[] { "a.txt", "a.TAR.GZ", ".x", "a.", "a.12345678", "مجلد.ملف", "😀.😀", "x" }) for (boolean dir : new boolean[] { false, true }) {
        File t = new File(root, n); ok("keepBoth «" + n + "» dir=" + dir, KtFileJobs.keepBoth(t, dir).getName().equals(KtCore.r("fj.keepBoth", "name", n, "dir", dir, "taken", new ArrayList<>())));
        ok("extOf «" + n + "»", KtFileJobs.extOf(n).equals(KtCore.r("fj.ext", "name", n))); }
      for (String n : new String[] { "", "a/b", ".", "..", "ok", "\u0000x", " " }) { String j; try { if (n.isEmpty() || n.contains("/") || n.contains("\u0000") || n.equals(".") || n.equals("..")) throw new IOException("bad name"); j = null; } catch (IOException e) { j = e.getMessage(); } ok("rename name «" + n + "»", Objects.equals(j, KtCore.r("fj.renameBad", "name", n))); }
      for (String n : new String[] { "/etc/passwd", "a/../b", "..", "C:\\x", "c:x", "ab:c", "a..b", "...", "ش:x" }) {
        // (KtArchive.unsafe, as it is written there)
        boolean j = n.startsWith("/") || n.contains("../") || n.equals("..") || n.contains(":") && n.indexOf(':') < 3 && n.length() > 1 && Character.isLetter(n.charAt(0)) && n.charAt(1) == ':';
        ok("archive unsafe «" + n + "»", Boolean.valueOf(j).equals(KtCore.r("ar.unsafe", "name", n))); }
      for (String[] v : new String[][] { { "cloud.example/", "nextcloud", "a b" }, { "http://h/dav", "webdav", "u" }, { "https://h/remote.php/dav/files/u/", "nextcloud", "u" }, { "h", "nextcloud", "عمر+1" } })
        ok("davBase " + Arrays.toString(v), KtRemoteRules.davBaseJava(v[0], v[1], v[2]).equals(KtCore.r("rm.davBase", "host", v[0], "kind", v[1], "user", v[2])));
      for (String p : new String[] { "/my files/a+b.txt", "مجلد/😀", "/a~b(c)*.-_", "\\win\\path\\", "" }) ok("davPath «" + p + "»", KtRemoteRules.davPathJava(p).equals(KtCore.r("rm.davPath", "path", p)));
      for (String[] h : new String[][] { { "/remote.php/dav/files/u/a%20b/", "/remote.php/dav/files/u" }, { "https://h/dav/x+y", "/dav" }, { "/dav/", "/dav" }, { "http://host", "" }, { "/a%2", "" }, { "/%D9%85", "" }, { "/a%zz", "" } }) {
        String j; try { j = KtRemoteRules.hrefJava(h[0], h[1]); } catch (Exception e) { j = null; }
        Object r = ((List<?>) KtCore.r("rm.hrefs", "hrefs", Arrays.asList(h[0]), "basePath", h[1])).get(0); ok("href «" + h[0] + "»: java=" + j + " rust=" + r, Objects.equals(j, r)); }
      for (String p : new String[] { "", "a\\b\\", "/", "//", "x/" }) ok("norm «" + p + "»", KtRemoteRules.norm(p).equals(KtCore.r("rm.norm", "path", p)));
      File up = fresh(root, "up"); mk(up, "D/a.txt", "a"); mk(up, "D/s/b.txt", "bb"); mk(up, "c.txt", "c");
      List<String> ps = Arrays.asList(new File(up, "D").getPath(), new File(up, "c.txt").getPath());
      KtFileExec.choice = "classic"; long[] t1 = { 0, 0 }; List<File[]> j1 = KtRemoteRules.upload(ps, "/up/", t1);
      KtFileExec.choice = "rust"; long m0 = KtRemoteRules.MISMATCHES.get(); long[] t2 = { 0, 0 }; List<File[]> r1 = KtRemoteRules.upload(ps, "/up/", t2);
      boolean eq = j1.size() == r1.size() && t1[0] == t2[0]; for (int i = 0; eq && i < j1.size(); i++) eq = j1.get(i)[1].getPath().equals(r1.get(i)[1].getPath());
      ok("an upload's order: Java's and Rust's the same, no difference counted", eq && j1.size() == 3 && KtRemoteRules.MISMATCHES.get() == m0); }

    ok("no plan mismatch counted in the Rust jobs but the tampered one", KtFileExec.MISMATCHES.get() == 1);
    ok("no Rust fallback", KtFileExec.FALLBACKS.get() == 0);
    say("report: " + KtFileExec.report());
    deleteAll(root);
    say(fails == 0 ? "all passed (" + oks + " checks)" : fails + " failed of " + (oks + fails)); System.exit(fails == 0 ? 0 : 1);
  }
  static List<File> listTop(File s) { File[] k = s.listFiles(); List<File> l = new ArrayList<>(); if (k != null) { Arrays.sort(k); l.addAll(Arrays.asList(k)); } return l; }
}
