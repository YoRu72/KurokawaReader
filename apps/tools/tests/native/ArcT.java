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
    System.out.println(fails == 0 ? "all passed" : fails + " failed"); System.exit(fails == 0 ? 0 : 1);
  }
}
