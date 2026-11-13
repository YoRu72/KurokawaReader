import java.io.*; import java.nio.file.*; import java.util.*; import org.json.*;
/** KtFileJobs on real temp folders: a move never deletes what was not copied whole (skip, same folder, failed, cancelled,
 *  a folder merge with one file skipped), replace keeps the old file until the new one is complete, a folder into itself
 *  refused, links neither followed into loops nor deleted through, rename never over another file. */
public class FilesT {
  static int fails = 0; static void ok(String what, boolean c) { System.out.println((c ? "ok   " : "FAIL ") + what); if (!c) fails++; }
  static File mk(File d, String rel, String text) throws IOException { File f = new File(d, rel); f.getParentFile().mkdirs(); Files.write(f.toPath(), text.getBytes("UTF-8")); return f; }
  static File big(File d, String rel, int mb) throws IOException { File f = new File(d, rel); f.getParentFile().mkdirs(); byte[] b = new byte[mb << 20]; new Random(7).nextBytes(b); Files.write(f.toPath(), b); return f; }
  static String read(File f) { try { return new String(Files.readAllBytes(f.toPath()), "UTF-8"); } catch (IOException e) { return null; } }
  static int seq = 0;
  /** A job run to its end: `conflict` the standing answer, or «ask:x» — asked, answered x; `cancelAt` cancels at the first progress (or the forced one naming it, «done:name»). */
  static JSONObject job(String op, List<File> paths, File dest, String conflict, String cancelAt, List<JSONObject> asked) {
    String id = "t" + (++seq); JSONObject[] end = { null }; String ans = conflict.startsWith("ask:") ? conflict.substring(4) : null;
    KtFileJobs.run(id, op, paths, dest, ans == null ? conflict : "ask", (ev) -> {
      String st = ev.optString("status");
      if (st.equals("conflict")) { if (asked != null) asked.add(ev); KtFileJobs.answer(id, ans == null ? "skip" : ans); }
      else if (st.equals("progress") && cancelAt != null && (cancelAt.equals("first") || (cancelAt.startsWith("done:") && ev.optString("name").equals(cancelAt.substring(5)) && ev.optLong("files") > 0))) KtFileJobs.cancel(id);
      else if (!st.equals("progress")) end[0] = ev;
    });
    return end[0];
  }
  static File fresh(File root, String name) throws IOException { File d = new File(root, name + "-" + (++seq)); d.mkdirs(); return d; }
  static boolean parts(File d) { File[] k = d.listFiles(); if (k == null) return false; for (File c : k) { if (c.getName().contains(".ktpart") || c.getName().contains(".ktold")) return true; if (c.isDirectory() && parts(c)) return true; } return false; }

  public static void main(String[] a) throws Exception {
    File root = Files.createTempDirectory("ktfiles").toFile();
    File shm = new File("/dev/shm"); File other = null;
    if (shm.isDirectory() && shm.canWrite()) { File o = Files.createTempDirectory(shm.toPath(), "ktfiles").toFile(); if (!Files.getFileStore(o.toPath()).equals(Files.getFileStore(root.toPath()))) other = o; }
    System.out.println(other == null ? "(no second volume: the moves that copy are tried on one volume only)" : "second volume: " + other);

    // ---- 1. a move whose copy was skipped keeps its source
    { File s = fresh(root, "s"), d = fresh(root, "d"); File f = mk(s, "a.txt", "NEW"); mk(d, "a.txt", "OLD");
      JSONObject e = job("move", Arrays.asList(f), d, "skip", null, null);
      ok("move + skip: the source stays", "NEW".equals(read(f)) && "OLD".equals(read(new File(d, "a.txt"))));
      ok("move + skip: the end says one skipped, one left, the path remaining", e.optInt("skipped") == 1 && e.optInt("left") == 1 && e.optJSONArray("remaining") != null && e.getJSONArray("remaining").length() == 1); }
    { File s = fresh(root, "s"), d = fresh(root, "d"); File f = mk(s, "a.txt", "NEW"); mk(d, "a.txt", "OLD"); List<JSONObject> asked = new ArrayList<>();
      job("move", Arrays.asList(f), d, "ask:skip", null, asked); ok("move + asked, Skip answered: the source stays", asked.size() == 1 && "NEW".equals(read(f))); }
    // replace and keep both
    { File s = fresh(root, "s"), d = fresh(root, "d"); File f = mk(s, "a.txt", "NEW"); mk(d, "a.txt", "OLD");
      job("move", Arrays.asList(f), d, "ask:replace", null, null); ok("move + replace: replaced, the source gone, no part left", "NEW".equals(read(new File(d, "a.txt"))) && !f.exists() && !parts(d)); }
    { File s = fresh(root, "s"), d = fresh(root, "d"); File f = mk(s, "a.txt", "NEW"); mk(d, "a.txt", "OLD");
      job("move", Arrays.asList(f), d, "ask:keep", null, null); ok("move + keep both: both there, the source gone", "OLD".equals(read(new File(d, "a.txt"))) && "NEW".equals(read(new File(d, "a (2).txt"))) && !f.exists()); }
    // the same folder: nothing ever deleted
    for (String c : new String[] { "replace", "skip", "keep", "ask:replace" }) {
      File s = fresh(root, "s"); File f = mk(s, "a.txt", "MINE"); List<JSONObject> asked = new ArrayList<>();
      JSONObject e = job("move", Arrays.asList(f), s, c, null, asked);
      ok("cut + paste into the same folder (" + c + "): a no-op, nothing asked", "MINE".equals(read(f)) && asked.isEmpty() && s.list().length == 1 && e.optJSONArray("failed").length() == 0); }
    { File s = fresh(root, "s"); File f = mk(s, "a.txt", "MINE"); List<JSONObject> asked = new ArrayList<>();
      job("copy", Arrays.asList(f), s, "ask:replace", null, asked); ok("copy + paste into the same folder: a second one beside it, nothing asked", "MINE".equals(read(f)) && "MINE".equals(read(new File(s, "a (2).txt"))) && asked.isEmpty()); }
    { File s = fresh(root, "s"); File dd = new File(s, "my.folder"); mk(dd, "x.txt", "X");
      job("copy", Arrays.asList(dd), s, "ask:replace", null, null); ok("a folder copied into its own folder: «my.folder (2)» beside it", "X".equals(read(new File(s, "my.folder (2)/x.txt"))) && "X".equals(read(new File(dd, "x.txt"))));
      job("move", Arrays.asList(dd), s, "replace", null, null); ok("a folder cut and pasted where it is: untouched", "X".equals(read(new File(dd, "x.txt")))); }
    // folder merge with one file skipped
    { File s = fresh(root, "s"), d = fresh(root, "d"); File dd = new File(s, "D"); mk(dd, "x.txt", "X"); mk(dd, "sub/y.txt", "Y-NEW"); mk(dd, "sub/z.txt", "Z"); mk(d, "D/sub/y.txt", "Y-OLD");
      JSONObject e = job("move", Arrays.asList(dd), d, "skip", null, null);
      ok("merge, one skipped: the skipped file and its folders stay", "Y-NEW".equals(read(new File(dd, "sub/y.txt"))) && "Y-OLD".equals(read(new File(d, "D/sub/y.txt"))));
      ok("merge, one skipped: the rest moved", !new File(dd, "x.txt").exists() && !new File(dd, "sub/z.txt").exists() && "X".equals(read(new File(d, "D/x.txt"))) && "Z".equals(read(new File(d, "D/sub/z.txt"))));
      ok("merge, one skipped: one left", e.optInt("left") == 1); }
    // a copy that fails (a folder in the way of the part file): the source stays, the old file too
    { File s = fresh(root, "s"), d = fresh(root, "d"); File f = mk(s, "a.txt", "NEW"); mk(d, "a.txt", "OLD"); mk(d, "a.txt.ktpart/block", "B");
      JSONObject e = job("copy", Arrays.asList(f), d, "replace", null, null); ok("copy + replace that fails: the old file kept, failure told", "OLD".equals(read(new File(d, "a.txt"))) && e.getJSONArray("failed").length() == 1); }
    // a cancelled copy over a file: the old one stays whole
    { File s = fresh(root, "s"), d = fresh(root, "d"); File f = big(s, "b.bin", 4); mk(d, "b.bin", "OLD");
      job("copy", Arrays.asList(f), d, "replace", "first", null); ok("copy + replace cancelled mid-file: the old file kept, no part left", "OLD".equals(read(new File(d, "b.bin"))) && !parts(d)); }
    // moves that copy (across volumes)
    File far = other != null ? other : root;
    { File s = fresh(root, "s"), d = fresh(far, "d"); File f = mk(s, "a.txt", "NEW"); mk(d, "a.txt.ktpart/block", "B");
      JSONObject e = job("move", Arrays.asList(f), d, "ask:replace", null, null);
      if (other != null) ok("move across that fails: the source stays", "NEW".equals(read(f)) && !new File(d, "a.txt").exists() && e.getJSONArray("failed").length() == 1 && e.optInt("left") == 1);
      else ok("move on one volume past a blocked part name: renamed whole", "NEW".equals(read(new File(d, "a.txt"))) && !f.exists()); }
    if (other != null) {
      { File s = fresh(root, "s"), d = fresh(other, "d"); File f = big(s, "b.bin", 4);
        JSONObject e = job("move", Arrays.asList(f), d, "ask:replace", "first", null);
        ok("move across cancelled mid-file: the source stays, nothing half at the destination", f.length() == 4 << 20 && d.list().length == 0 && "cancelled".equals(e.optString("status")) && e.optInt("left") == 1); }
      { File s = fresh(root, "s"), d = fresh(other, "d"); File x = mk(s, "x.txt", "X"), y = mk(s, "y.txt", "Y"), z = mk(s, "z.txt", "Z");
        JSONObject e = job("move", Arrays.asList(x, y, z), d, "replace", "done:x.txt", null);
        ok("move across cancelled between files: the first moved, the rest stay", !x.exists() && "X".equals(read(new File(d, "x.txt"))) && "Y".equals(read(y)) && "Z".equals(read(z)) && !new File(d, "y.txt").exists());
        ok("… the end tells two left, their paths remaining", e.optInt("left") == 2 && e.getJSONArray("remaining").length() == 2); }
      { File s = fresh(root, "s"), d = fresh(other, "d"); File dd = new File(s, "D"); mk(dd, "x.txt", "X"); mk(dd, "sub/y.txt", "Y-NEW"); mk(dd, "sub/z.txt", "Z"); mk(d, "D/sub/y.txt", "Y-OLD");
        job("move", Arrays.asList(dd), d, "ask:skip", null, null);
        ok("merge across, one skipped: it and its folders stay, the rest moved", "Y-NEW".equals(read(new File(dd, "sub/y.txt"))) && !new File(dd, "x.txt").exists() && !new File(dd, "sub/z.txt").exists() && "Z".equals(read(new File(d, "D/sub/z.txt")))); }
      { File s = fresh(root, "s"), d = fresh(other, "d"); File dd = new File(s, "D"); mk(dd, "x.txt", "X"); mk(dd, "sub/y.txt", "Y");
        job("move", Arrays.asList(dd), d, "ask:skip", null, null); ok("a whole folder moved across: all there, the source gone", !dd.exists() && "Y".equals(read(new File(d, "D/sub/y.txt")))); }
    }
    // ---- 2. a folder into itself
    { File s = fresh(root, "s"); File dd = new File(s, "D"); mk(dd, "x.txt", "X"); new File(dd, "sub").mkdirs();
      JSONObject e = job("copy", Arrays.asList(dd), dd, "replace", null, null); ok("a folder copied into itself: refused", !new File(dd, "D").exists() && e.getJSONArray("failed").length() == 1);
      e = job("move", Arrays.asList(dd), new File(dd, "sub"), "replace", null, null); ok("a folder moved into its own sub-folder: refused, untouched", "X".equals(read(new File(dd, "x.txt"))) && !new File(dd, "sub/D").exists() && e.getJSONArray("failed").length() == 1);
      e = job("copy", Arrays.asList(dd), new File(dd.getPath() + "/sub/"), "replace", null, null); ok("… a trailing separator changes nothing", !new File(dd, "sub/D").exists() && e.getJSONArray("failed").length() == 1);
      File ln = new File(s, "toSub"); Files.createSymbolicLink(ln.toPath(), new File(dd, "sub").toPath());
      e = job("copy", Arrays.asList(dd), ln, "replace", null, null); ok("… nor a link to the sub-folder", !new File(dd, "sub/D").exists() && e.getJSONArray("failed").length() == 1);
      File bc = new File(s, "Dc"); bc.mkdirs(); e = job("copy", Arrays.asList(dd), bc, "replace", null, null); ok("a sibling sharing the prefix (D → Dc) is not refused", "X".equals(read(new File(bc, "D/x.txt"))) && e.getJSONArray("failed").length() == 0); }
    // links: a loop not followed, a delete not gone through
    { File s = fresh(root, "s"), d = fresh(far, "d"); File dd = new File(s, "D"); mk(dd, "x.txt", "X"); Files.createSymbolicLink(new File(dd, "loop").toPath(), dd.toPath());
      JSONObject e = job("copy", Arrays.asList(dd), d, "replace", null, null); ok("a folder holding a link to itself copies once", "X".equals(read(new File(d, "D/x.txt"))) && !new File(d, "D/loop/x.txt").exists() && e.getJSONArray("failed").length() == 1);
      File keep = fresh(root, "keep"); mk(keep, "precious.txt", "P"); Files.createSymbolicLink(new File(dd, "out").toPath(), keep.toPath());
      job("delete", Arrays.asList(dd), null, "ask", null, null); ok("deleting a folder with a link out deletes the link, not what it points at", !dd.exists() && "P".equals(read(new File(keep, "precious.txt")))); }
    // ---- rename
    { File s = fresh(root, "s"); File x = mk(s, "a.txt", "A"); mk(s, "b.txt", "B"); String err = null;
      try { KtFileJobs.rename(x, "b.txt"); } catch (IOException e) { err = e.getMessage(); } ok("rename onto another file: refused (exists), both kept", "exists".equals(err) && "A".equals(read(x)) && "B".equals(read(new File(s, "b.txt")))); }
    { File s = fresh(root, "s"); File up = mk(s, "A.txt", "UPPER"); mk(s, "a.txt", "lower"); String err = null;
      try { KtFileJobs.rename(up, "a.txt"); } catch (IOException e) { err = e.getMessage(); } ok("rename by letter case onto another file (a volume that keeps case): refused", "exists".equals(err) && "lower".equals(read(new File(s, "a.txt"))) && "UPPER".equals(read(up))); }
    { File s = fresh(root, "s"); File up = mk(s, "Notes.TXT", "N"); JSONObject r = KtFileJobs.rename(up, "notes.txt");
      ok("rename by letter case alone", r.optBoolean("ok") && Arrays.asList(s.list()).equals(Arrays.asList("notes.txt")) && "N".equals(read(new File(s, "notes.txt")))); }
    if (other != null) deleteAll(other); deleteAll(root);
    System.out.println(fails == 0 ? "all passed" : fails + " failed"); System.exit(fails == 0 ? 0 : 1);
  }
  static void deleteAll(File f) { if (f.isDirectory() && !Files.isSymbolicLink(f.toPath())) { File[] k = f.listFiles(); if (k != null) for (File c : k) deleteAll(c); } f.delete(); }
}
