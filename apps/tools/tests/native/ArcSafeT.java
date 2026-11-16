import java.io.*; import java.nio.file.*; import java.util.*;
/** KtArchive's in-place safety (Tools 0.21 P5): an entry this phone cannot decode, or a name refused, stops the job
 *  BEFORE anything changes — no journal, no tail, the archive byte for byte as it was; names from the one table. */
public class ArcSafeT {
  static KtArchive.Progress P = new KtArchive.Progress() { public void on(long d, long t, String f) {} public boolean stopped() { return false; } };
  static int fails = 0; static void ok(String what, boolean c) { System.out.println((c ? "ok   " : "FAIL ") + what); if (!c) fails++; }
  static byte[] zip(String[] names, int badMethodAt) throws Exception {
    ByteArrayOutputStream b = new ByteArrayOutputStream(); try (java.util.zip.ZipOutputStream z = new java.util.zip.ZipOutputStream(b)) { for (String n : names) { z.putNextEntry(new java.util.zip.ZipEntry(n)); z.write(("body of " + n).getBytes()); z.closeEntry(); } }
    byte[] a = b.toByteArray(); if (badMethodAt < 0) return a;
    // the method of entry `badMethodAt` set to 93 (Zstandard) in its local header and its directory record
    int seen = 0; for (int i = 0; i + 4 < a.length; i++) { int sig = (a[i] & 0xff) | (a[i + 1] & 0xff) << 8 | (a[i + 2] & 0xff) << 16 | (a[i + 3] & 0xff) << 24; if (sig == 0x04034b50) { if (seen == badMethodAt) { a[i + 8] = 93; a[i + 9] = 0; } seen++; } }
    seen = 0; for (int i = 0; i + 4 < a.length; i++) { int sig = (a[i] & 0xff) | (a[i + 1] & 0xff) << 8 | (a[i + 2] & 0xff) << 16 | (a[i + 3] & 0xff) << 24; if (sig == 0x02014b50) { if (seen == badMethodAt) { a[i + 10] = 93; a[i + 11] = 0; } seen++; } }
    return a;
  }
  public static void main(String[] x) throws Exception {
    File d = Files.createTempDirectory("arcsafe").toFile(); String[] names = { "a.txt", "b/c.txt", "d.txt", "e.txt" };
    for (int at : new int[] { 0, 2, 3 }) {
      File f = new File(d, "m" + at + ".zip"); byte[] orig = zip(names, at); Files.write(f.toPath(), orig);
      KtArchive.Options o = new KtArchive.Options(); o.inPlace = true; o.keepFree = 0; String err = null;
      try { KtArchive.extract(f, new File(d, "out" + at), o, P); } catch (IOException e) { err = e.getMessage(); }
      ok("unsupported method at " + at + ": refused before any change (" + err + ")", err != null && err.startsWith("unsupportedMethod 93") && err.endsWith("nothing was modified") && Arrays.equals(Files.readAllBytes(f.toPath()), orig) && !new File(f.getPath() + ".kurokawa-unzip").exists() && !new File(f.getPath() + ".kurokawa-tail").exists());
    }
    // a tar with «../evil»: refused, and no stale journal left (the journal used to be written first)
    File t = new File(d, "x.tar"); try (org.apache.commons.compress.archivers.tar.TarArchiveOutputStream o = new org.apache.commons.compress.archivers.tar.TarArchiveOutputStream(new FileOutputStream(t))) { for (String n : new String[] { "ok.txt", "../evil.txt" }) { org.apache.commons.compress.archivers.tar.TarArchiveEntry e = new org.apache.commons.compress.archivers.tar.TarArchiveEntry(n, true); byte[] b = n.getBytes(); e.setSize(b.length); o.putArchiveEntry(e); o.write(b); o.closeArchiveEntry(); } }
    byte[] torig = Files.readAllBytes(t.toPath()); KtArchive.Options o = new KtArchive.Options(); o.inPlace = true; o.keepFree = 0; String err = null;
    try { KtArchive.extractTarInPlace(t, new File(d, "tout"), o, P); } catch (IOException e) { err = e.getMessage(); }
    ok("tar «../evil.txt» refused, no journal left (" + err + ")", err != null && err.startsWith("unsafePath") && !new File(t.getPath() + ".kurokawa-unzip").exists() && Arrays.equals(Files.readAllBytes(t.toPath()), torig));
    // names allowed on the phone that the old rule got wrong
    ok("«foo../bar» allowed, «a/..» refused, «meeting 10:30.txt» allowed", !KtArchive.unsafe("foo../bar") && KtArchive.unsafe("a/..") && !KtArchive.unsafe("meeting 10:30.txt") && KtArchive.unsafe("C:x") && KtArchive.unsafe("x.kt-part"));
    ok("an SD card rewrites «:»", KtArchive.nameFor(new File("/storage/1A2B-3C4D/Download"), "dir/a:b").out.equals("dir/a_b") && KtArchive.nameFor(new File("/storage/emulated/0/Download"), "dir/a:b").out.equals("dir/a:b"));
    // a clean zip in place still works end to end, and its temp files use the new suffix
    File g = new File(d, "good.zip"); Files.write(g.toPath(), zip(names, -1)); KtArchive.Options go = new KtArchive.Options(); go.inPlace = true; go.keepFree = 0; int n = KtArchive.extract(g, new File(d, "gout"), go, P);
    ok("a clean zip in place: " + n + " files, archive gone", n == 4 && !g.exists() && new String(Files.readAllBytes(new File(d, "gout/b/c.txt").toPath())).equals("body of b/c.txt"));
    System.out.println(fails == 0 ? "all passed" : "errors"); if (fails > 0) System.exit(1);
  }
}
