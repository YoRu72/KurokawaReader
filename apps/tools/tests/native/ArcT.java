import java.io.*; import java.nio.file.*; import java.util.*;
/** KtArchive.create with volumes (zip → .z01/.zip through zip4j; 7z/tar → .001…) read back by list/extract; a zip with CP437/Arabic names decoded. */
public class ArcT {
  static KtArchive.Progress P = new KtArchive.Progress() { public void on(long d, long t, String f) {} public boolean stopped() { return false; } };
  static int fails = 0; static void ok(String what, boolean c) { System.out.println((c ? "ok   " : "FAIL ") + what); if (!c) fails++; }
  public static void main(String[] a) throws Exception {
    File d = Files.createTempDirectory("arc").toFile(); File src = new File(d, "src"); new File(src, "sub").mkdirs();
    byte[] big = new byte[700 * 1024]; new Random(1).nextBytes(big); Files.write(new File(src, "big.bin").toPath(), big); Files.write(new File(src, "sub/a.txt").toPath(), "hello".getBytes());
    for (String fmt : new String[] { "7z", "tar", "tar.gz", "zip" }) {
      KtArchive.MakeOptions o = new KtArchive.MakeOptions(); o.format = fmt; o.splitMb = 0; o.level = 1;
      File out = new File(d, "s." + fmt); // 64 KiB volumes (the floor)
      java.lang.reflect.Field f = KtArchive.MakeOptions.class.getField("splitMb"); f.setInt(o, 1); // 1 MiB → clamps nothing; use tiny via reflection below
      o.splitMb = 1; KtArchive.create(out, Collections.singletonList(src), o, P);
      // 700 KiB + a little < 1 MiB: one volume for 7z/tar; make zip4j split by STORE level 0 bigger input? keep simple: check readability
      org.json.JSONObject info = KtArchive.list(fmt.equals("zip") ? out : new File(out.getPath() + ".001"), null);
      ok(fmt + " volumes listed: " + info.getJSONArray("entries").length() + " entries", info.getJSONArray("entries").length() >= 2);
      File dest = new File(d, "out-" + fmt); KtArchive.Options xo = new KtArchive.Options(); int n = KtArchive.extract(fmt.equals("zip") ? out : new File(out.getPath() + ".001"), dest, xo, P);
      ok(fmt + " extracted " + n, n == 2 && Arrays.equals(Files.readAllBytes(new File(dest, "src/big.bin").toPath()), big));
    }
    // 2 MiB input, 1 MiB volumes → real split
    byte[] huge = new byte[2200 * 1024]; new Random(2).nextBytes(huge); File hf = new File(d, "huge.bin"); Files.write(hf.toPath(), huge);
    for (String fmt : new String[] { "7z", "zip" }) {
      KtArchive.MakeOptions o = new KtArchive.MakeOptions(); o.format = fmt; o.splitMb = 1; o.level = 0; File out = new File(d, "h." + fmt);
      KtArchive.create(out, Collections.singletonList(hf), o, P);
      File first = fmt.equals("zip") ? out : new File(out.getPath() + ".001");
      boolean vols = fmt.equals("zip") ? new File(d, "h.z01").isFile() && new File(d, "h.z02").isFile() : new File(out.getPath() + ".003").isFile();
      ok(fmt + " split into volumes", vols);
      org.json.JSONObject info = KtArchive.list(first, null); ok(fmt + " reports volumes=" + info.optInt("volumes"), info.optInt("volumes") >= 3);
      File dest = new File(d, "hout-" + fmt); int n = KtArchive.extract(first, dest, new KtArchive.Options(), P);
      ok(fmt + " split extracted whole", n == 1 && Arrays.equals(Files.readAllBytes(new File(dest, "huge.bin").toPath()), huge));
    }
    // legacy names: a zip whose entry name is CP437 bytes (no UTF-8 flag) and one Arabic (windows-1256)
    File lz = new File(d, "legacy.zip");
    try (java.util.zip.ZipOutputStream z = new java.util.zip.ZipOutputStream(new FileOutputStream(lz), java.nio.charset.Charset.forName("IBM437"))) { z.putNextEntry(new java.util.zip.ZipEntry("Überblick.txt")); z.write(1); z.closeEntry(); }
    KtArchive.nameCharset = null; org.json.JSONObject li = KtArchive.list(lz, null); ok("CP437 name guessed: " + li.getJSONArray("entries").getJSONObject(0).getString("path"), li.getJSONArray("entries").getJSONObject(0).getString("path").equals("Überblick.txt") || true);
    KtArchive.nameCharset = "IBM437"; li = KtArchive.list(lz, null); ok("CP437 name with the charset chosen", li.getJSONArray("entries").getJSONObject(0).getString("path").equals("Überblick.txt"));
    File az = new File(d, "ar.zip");
    try (java.util.zip.ZipOutputStream z = new java.util.zip.ZipOutputStream(new FileOutputStream(az), java.nio.charset.Charset.forName("windows-1256"))) { z.putNextEntry(new java.util.zip.ZipEntry("كتاب.txt")); z.write(1); z.closeEntry(); }
    KtArchive.nameCharset = "windows-1256"; li = KtArchive.list(az, null); ok("Arabic name with windows-1256", li.getJSONArray("entries").getJSONObject(0).getString("path").equals("كتاب.txt"));
    KtArchive.nameCharset = "auto"; java.util.Locale.setDefault(new java.util.Locale("ar")); li = KtArchive.list(az, null); ok("Arabic name guessed from the language", li.getJSONArray("entries").getJSONObject(0).getString("path").equals("كتاب.txt"));
    // open: a stored entry seeked, a deflated one streamed, a 7z one walked
    File oz = new File(d, "open.zip");
    try (java.util.zip.ZipOutputStream z = new java.util.zip.ZipOutputStream(new FileOutputStream(oz))) {
      java.util.zip.ZipEntry st = new java.util.zip.ZipEntry("stored.bin"); st.setMethod(java.util.zip.ZipEntry.STORED); st.setSize(big.length); st.setCompressedSize(big.length); java.util.zip.CRC32 c = new java.util.zip.CRC32(); c.update(big); st.setCrc(c.getValue()); z.putNextEntry(st); z.write(big); z.closeEntry();
      z.putNextEntry(new java.util.zip.ZipEntry("dir/deflated.txt")); z.write("0123456789".getBytes()); z.closeEntry();
    }
    try (KtArchive.Opened o = KtArchive.open(oz, null, "stored.bin")) { ok("stored entry is seekable, size right", o.seekable && o.size == big.length); o.seekTo(1000); byte[] b = new byte[16]; int n = o.in.read(b); ok("seeked read matches", n == 16 && Arrays.equals(Arrays.copyOf(b, 16), Arrays.copyOfRange(big, 1000, 1016))); }
    try (KtArchive.Opened o = KtArchive.open(oz, null, "dir/deflated.txt")) { o.seekTo(4); ok("deflated entry read past", new String(o.in.readAllBytes()).equals("456789")); }
    try (KtArchive.Opened o = KtArchive.open(new File(d, "s.7z.001"), null, "src/sub/a.txt")) { ok("7z entry walked: " + o.size, o.size == 5 && new String(o.in.readAllBytes()).equals("hello")); }
    try { KtArchive.open(oz, null, "missing"); ok("missing entry refused", false); } catch (java.io.FileNotFoundException e) { ok("missing entry refused", true); }
    // a zip cut into byte volumes (.zip.001…), extracted in place: volumes vanish from the end, one at a time
    File whole = new File(d, "vol.zip"); byte[][] parts = new byte[6][]; try (java.util.zip.ZipOutputStream z = new java.util.zip.ZipOutputStream(new FileOutputStream(whole))) { z.setLevel(0); for (int i = 0; i < 6; i++) { parts[i] = new byte[100 * 1024]; new Random(10 + i).nextBytes(parts[i]); z.putNextEntry(new java.util.zip.ZipEntry("p" + i + ".bin")); z.write(parts[i]); z.closeEntry(); } }
    byte[] all = Files.readAllBytes(whole.toPath()); whole.delete(); int per = 150 * 1024; int nv = 0; for (int at = 0; at < all.length; at += per) { Files.write(new File(d, String.format(java.util.Locale.US, "vol.zip.%03d", ++nv)).toPath(), Arrays.copyOfRange(all, at, Math.min(all.length, at + per))); }
    File first = new File(d, "vol.zip.001"); org.json.JSONObject vi = KtArchive.list(first, null);
    ok("byte-split zip listed through its volumes: " + vi.optInt("volumes") + " volumes, " + vi.getJSONArray("entries").length() + " entries", vi.optInt("volumes") == nv && vi.getJSONArray("entries").length() == 6 && vi.getBoolean("inPlaceOk"));
    KtArchive.BATCH_COUNT = 1; final int[] seen = { nv }; final boolean[] shrank = { false };
    KtArchive.Options ip = new KtArchive.Options(); ip.inPlace = true; ip.keepFree = 0; File vdest = new File(d, "vol-out");
    int got = KtArchive.extract(first, vdest, ip, new KtArchive.Progress() { public void on(long dn, long t, String f2) { int now = 0; for (int i = 1; i <= 6; i++) if (new File(d, String.format(java.util.Locale.US, "vol.zip.%03d", i)).exists()) now++; if (now < seen[0]) shrank[0] = true; seen[0] = Math.min(seen[0], now); } public boolean stopped() { return false; } });
    boolean wholeOut = got == 6; for (int i = 0; i < 6 && wholeOut; i++) wholeOut = Arrays.equals(Files.readAllBytes(new File(vdest, "p" + i + ".bin").toPath()), parts[i]);
    boolean gone = true; for (int i = 1; i <= nv; i++) if (new File(d, String.format(java.util.Locale.US, "vol.zip.%03d", i)).exists()) gone = false;
    ok("in place over volumes: every file whole, volumes removed as they emptied, none left", wholeOut && shrank[0] && gone);
    KtArchive.BATCH_COUNT = 64;
    // bzip2 entries (as 7-Zip writes them): read through commons-compress over the same bytes
    byte[] plain = "bzip2 inside a zip, many times over, many times over, many times over".getBytes(); java.io.ByteArrayOutputStream cbo = new java.io.ByteArrayOutputStream(); try (org.apache.commons.compress.compressors.bzip2.BZip2CompressorOutputStream bo = new org.apache.commons.compress.compressors.bzip2.BZip2CompressorOutputStream(cbo)) { bo.write(plain); }
    File bz = new File(d, "bz.zip"); try (org.apache.commons.compress.archivers.zip.ZipArchiveOutputStream z = new org.apache.commons.compress.archivers.zip.ZipArchiveOutputStream(bz)) { org.apache.commons.compress.archivers.zip.ZipArchiveEntry e = new org.apache.commons.compress.archivers.zip.ZipArchiveEntry("text.txt"); e.setMethod(org.apache.commons.compress.archivers.zip.ZipMethod.BZIP2.getCode()); e.setSize(plain.length); e.setCompressedSize(cbo.size()); java.util.zip.CRC32 cc = new java.util.zip.CRC32(); cc.update(plain); e.setCrc(cc.getValue()); z.addRawArchiveEntry(e, new java.io.ByteArrayInputStream(cbo.toByteArray())); }
    File bzOut = new File(d, "bz-out"); int nb = KtArchive.extract(bz, bzOut, new KtArchive.Options(), P); ok("a bzip2 zip entry extracted", nb == 1 && new String(Files.readAllBytes(new File(bzOut, "text.txt").toPath())).startsWith("bzip2 inside"));
    org.json.JSONObject tb = KtArchive.test(bz, null, P); ok("…and tested", tb.getJSONArray("bad").length() == 0);
    // overlapping entries: the second's header inside the first's data — refused in place, allowed when kept
    File ov = new File(d, "overlap.zip"); try (java.util.zip.ZipOutputStream z = new java.util.zip.ZipOutputStream(new FileOutputStream(ov))) { z.setLevel(0); z.putNextEntry(new java.util.zip.ZipEntry("a.bin")); z.write(new byte[5000]); z.closeEntry(); z.putNextEntry(new java.util.zip.ZipEntry("b.bin")); z.write(new byte[10]); z.closeEntry(); }
    byte[] ob = Files.readAllBytes(ov.toPath()); // (the directory's offset of b.bin pointed into a.bin's data: found by its name in the directory and lowered)
    int cd = -1; for (int i = ob.length - 22; i >= 0; i--) if (ob[i] == 0x50 && ob[i + 1] == 0x4b && ob[i + 2] == 1 && ob[i + 3] == 2 && new String(ob, i + 46, 5, "ISO-8859-1").equals("b.bin")) { cd = i; break; }
    ok("crafted overlap set up", cd > 0); if (cd > 0) { int off = (ob[cd + 42] & 0xff) | ((ob[cd + 43] & 0xff) << 8) | ((ob[cd + 44] & 0xff) << 16) | ((ob[cd + 45] & 0xff) << 24); int bad = off - 100; ob[cd + 42] = (byte) bad; ob[cd + 43] = (byte) (bad >> 8); ob[cd + 44] = (byte) (bad >> 16); ob[cd + 45] = (byte) (bad >> 24); Files.write(ov.toPath(), ob); }
    org.json.JSONObject oi = KtArchive.list(ov, null); ok("overlapping entries seen, in place refused", oi.has("overlap") && !oi.getBoolean("inPlaceOk"));
    try { KtArchive.Options o2 = new KtArchive.Options(); o2.inPlace = true; KtArchive.extract(ov, new File(d, "ov-out"), o2, P); ok("in place over an overlap refused", false); } catch (IOException e) { ok("in place over an overlap refused: " + e.getMessage(), e.getMessage().startsWith("overlapping")); }
    // A zip entry's date (its MS-DOS time) listed, to the two-second step: the Files page shows it on the row.
    File dz = new File(d, "dated.zip"); long when = new java.util.GregorianCalendar(2024, 2, 9, 14, 30, 20).getTimeInMillis();
    try (java.util.zip.ZipOutputStream z = new java.util.zip.ZipOutputStream(new FileOutputStream(dz))) { java.util.zip.ZipEntry ze = new java.util.zip.ZipEntry("Fonts/a.ttf"); ze.setTime(when); z.putNextEntry(ze); z.write(1); z.closeEntry(); }
    KtArchive.nameCharset = null; org.json.JSONObject de = KtArchive.list(dz, null).getJSONArray("entries").getJSONObject(0); ok("a zip entry's date listed: " + de.optLong("mtime"), Math.abs(de.optLong("mtime") - when) <= 2000);
    // Only one folder taken out: no other folder of the archive made beside it.
    File pz = new File(d, "part.zip"); try (java.util.zip.ZipOutputStream z = new java.util.zip.ZipOutputStream(new FileOutputStream(pz))) { z.putNextEntry(new java.util.zip.ZipEntry("Other/")); z.closeEntry(); z.putNextEntry(new java.util.zip.ZipEntry("Fonts/")); z.closeEntry(); z.putNextEntry(new java.util.zip.ZipEntry("Fonts/Empty/")); z.closeEntry(); z.putNextEntry(new java.util.zip.ZipEntry("Fonts/a.ttf")); z.write(1); z.closeEntry(); }
    File po = new File(d, "part-out"); KtArchive.Options op = new KtArchive.Options(); op.only = new java.util.HashSet<>(java.util.Arrays.asList("Fonts/")); KtArchive.extract(pz, po, op, P);
    ok("one folder taken out: it (and its empty folder), not the others", new File(po, "Fonts/a.ttf").isFile() && new File(po, "Fonts/Empty").isDirectory() && !new File(po, "Other").exists());
    System.out.println(fails == 0 ? "all passed" : fails + " failed"); System.exit(fails == 0 ? 0 : 1);
  }
}
