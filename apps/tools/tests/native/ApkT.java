import java.io.*; import java.util.*; import java.util.zip.*;
import org.apache.commons.compress.archivers.sevenz.*; import org.apache.commons.compress.archivers.tar.*; import org.apache.commons.compress.compressors.gzip.*;
public class ApkT {
  static int fails = 0; static void ok(String what, boolean c) { System.out.println((c ? "ok   " : "FAIL ") + what); if (!c) fails++; }
  static byte[] apk(String tag) throws Exception { ByteArrayOutputStream b = new ByteArrayOutputStream(); try (ZipOutputStream z = new ZipOutputStream(b)) { z.putNextEntry(new ZipEntry("AndroidManifest.xml")); z.write(("manifest of " + tag).getBytes()); byte[] pad = new byte[20000 + tag.length() * 977]; new Random(tag.hashCode()).nextBytes(pad); z.putNextEntry(new ZipEntry("classes.dex")); z.write(pad); } return b.toByteArray(); }
  static byte[] zip(Map<String, byte[]> files, boolean descriptor) throws Exception { ByteArrayOutputStream b = new ByteArrayOutputStream(); try (ZipOutputStream z = new ZipOutputStream(b)) { for (Map.Entry<String, byte[]> e : files.entrySet()) { ZipEntry ze = new ZipEntry(e.getKey()); if (!descriptor) { ze.setMethod(ZipEntry.STORED); ze.setSize(e.getValue().length); CRC32 c = new CRC32(); c.update(e.getValue()); ze.setCrc(c.getValue()); } z.putNextEntry(ze); z.write(e.getValue()); } } return b.toByteArray(); }
  static Map<String, byte[]> m(Object... kv) { Map<String, byte[]> r = new LinkedHashMap<>(); for (int i = 0; i < kv.length; i += 2) r.put((String) kv[i], (byte[]) kv[i + 1]); return r; }
  static List<KtApkPlan.Entry> list(File f, String pw) throws Exception { List<KtApkPlan.Entry> out = new ArrayList<>(); KtArchive.walk(f, pw, (n, s, in) -> { out.add(new KtApkPlan.Entry(n, s)); return true; }); return out; }
  static List<KtApkPlan.Entry> listInner(File f, String pw, String inner) throws Exception { List<KtApkPlan.Entry> out = new ArrayList<>(); byte[] skip = new byte[65536]; KtArchive.walk(f, pw, (n, sz, in) -> { if (!n.equals(inner)) return true; ZipInputStream z = new ZipInputStream(in); ZipEntry e; while ((e = z.getNextEntry()) != null) { if (e.isDirectory()) continue; long size = e.getSize(); if (size < 0) { size = 0; int r; while ((r = z.read(skip)) > 0) size += r; } out.add(new KtApkPlan.Entry(e.getName(), size)); } return false; }); return out; }
  /** What the installer would write into the session: name → bytes. */
  static Map<String, byte[]> install(File f, String pw, String select, List<KtApkPlan.Entry> parts) throws Exception {
    Set<String> want = new HashSet<>(); for (KtApkPlan.Entry e : parts) want.add(e.path); Map<String, byte[]> out = new LinkedHashMap<>(); String inner = select.startsWith("bundle:") ? select.substring(7) : null;
    KtArchive.walk(f, pw, (n, sz, in) -> { if (inner == null) { if (want.contains(n)) out.put(n.replaceAll(".*/", ""), in.readAllBytes()); return out.size() < want.size(); } if (!n.equals(inner)) return true; ZipInputStream z = new ZipInputStream(in); ZipEntry e; while ((e = z.getNextEntry()) != null) if (want.contains(e.getName())) out.put(e.getName().replaceAll(".*/", ""), z.readAllBytes()); return false; });
    return out;
  }
  static final String[] ARM = { "arm64-v8a", "armeabi-v7a", "armeabi" };
  public static void main(String[] a) throws Exception {
    File dir = new File("work"); dir.mkdirs();
    byte[] base = apk("base"), arm = apk("arm64"), x86 = apk("x86_64"), ar = apk("ar"), en = apk("en");
    byte[] xapk = zip(m("manifest.json", "{}".getBytes(), "base.apk", base, "split_config.arm64_v8a.apk", arm, "split_config.x86_64.apk", x86, "split_config.ar.apk", ar, "icon.png", new byte[50]), true);
    // 1) an .xapk inside a 7z
    File sz = new File(dir, "game.7z"); try (SevenZOutputFile o = new SevenZOutputFile(sz)) { SevenZArchiveEntry e = o.createArchiveEntry(new File("README.txt"), "README.txt"); o.putArchiveEntry(e); o.write("read me".getBytes()); o.closeArchiveEntry(); e = o.createArchiveEntry(new File("Game v1.2.xapk"), "Game v1.2.xapk"); e.setSize(xapk.length); o.putArchiveEntry(e); o.write(xapk); o.closeArchiveEntry(); }
    List<KtApkPlan.Entry> all = list(sz, null); List<KtApkPlan.App> apps = KtApkPlan.apps(all);
    ok("7z: one app, the bundle inside", apps.size() == 1 && apps.get(0).select.equals("bundle:Game v1.2.xapk"));
    List<KtApkPlan.Entry> parts = KtApkPlan.parts(KtApkPlan.apksOf(listInner(sz, null, "Game v1.2.xapk"), "bundle:"), ARM);
    List<String> names = new ArrayList<>(); for (KtApkPlan.Entry e : parts) names.add(e.path);
    ok("7z: parts are base, arm64, ar (not x86_64) " + names, names.equals(Arrays.asList("base.apk", "split_config.arm64_v8a.apk", "split_config.ar.apk")));
    ok("7z: sizes known from the stream", parts.get(0).size == base.length);
    ok("7z: base found", KtApkPlan.base(parts).path.equals("base.apk"));
    Map<String, byte[]> wrote = install(sz, null, apps.get(0).select, parts);
    ok("7z: streamed bytes equal the parts", wrote.size() == 3 && Arrays.equals(wrote.get("base.apk"), base) && Arrays.equals(wrote.get("split_config.arm64_v8a.apk"), arm) && Arrays.equals(wrote.get("split_config.ar.apk"), ar));
    // 2) split APKs in a folder of a tar.gz, with another single app beside them
    File tg = new File(dir, "apps.tar.gz"); try (TarArchiveOutputStream t = new TarArchiveOutputStream(new GzipCompressorOutputStream(new FileOutputStream(tg)))) { for (Map.Entry<String, byte[]> e : m("MyApp/base.apk", base, "MyApp/split_config.arm64_v8a.apk", arm, "MyApp/split_config.x86_64.apk", x86, "Tools/Other.apk", en).entrySet()) { TarArchiveEntry te = new TarArchiveEntry(e.getKey()); te.setSize(e.getValue().length); t.putArchiveEntry(te); t.write(e.getValue()); t.closeArchiveEntry(); } }
    apps = KtApkPlan.apps(list(tg, null)); List<String> sel = new ArrayList<>(); for (KtApkPlan.App x : apps) sel.add(x.select + "=" + x.label);
    ok("tar.gz: two apps to choose " + sel, sel.equals(Arrays.asList("dir:MyApp/=MyApp", "apk:Tools/Other.apk=Other.apk")));
    parts = KtApkPlan.parts(KtApkPlan.apksOf(list(tg, null), "dir:MyApp/"), ARM); wrote = install(tg, null, "dir:MyApp/", parts);
    ok("tar.gz: the folder's base and arm64 split streamed " + wrote.keySet(), wrote.keySet().equals(new HashSet<>(Arrays.asList("base.apk", "split_config.arm64_v8a.apk"))) && Arrays.equals(wrote.get("base.apk"), base));
    parts = KtApkPlan.parts(KtApkPlan.apksOf(list(tg, null), "apk:Tools/Other.apk"), ARM); wrote = install(tg, null, "apk:Tools/Other.apk", parts);
    ok("tar.gz: the single app streamed", wrote.size() == 1 && Arrays.equals(wrote.get("Other.apk"), en));
    // 3) a password-protected zip holding an .apks
    File ez = new File(dir, "locked.zip"); File tmpApks = new File(dir, "Thing.apks"); try (FileOutputStream o = new FileOutputStream(tmpApks)) { o.write(xapk); }
    net.lingala.zip4j.model.ZipParameters zp = new net.lingala.zip4j.model.ZipParameters(); zp.setEncryptFiles(true); zp.setEncryptionMethod(net.lingala.zip4j.model.enums.EncryptionMethod.AES);
    try (net.lingala.zip4j.ZipFile z = new net.lingala.zip4j.ZipFile(ez, "s3cret".toCharArray())) { z.addFile(tmpApks, zp); }
    String err = ""; try { list(ez, null); } catch (IOException e) { err = e.getMessage(); } ok("locked zip without a password: «password»", err.equals("password"));
    err = ""; try { listInner(ez, "wrong", "Thing.apks"); } catch (Exception e) { err = e.getMessage(); } ok("locked zip, wrong password: «password» (" + err + ")", "password".equals(err));
    apps = KtApkPlan.apps(list(ez, "s3cret")); ok("locked zip: the .apks found", apps.size() == 1 && apps.get(0).select.equals("bundle:Thing.apks"));
    parts = KtApkPlan.parts(KtApkPlan.apksOf(listInner(ez, "s3cret", "Thing.apks"), "bundle:"), ARM); wrote = install(ez, "s3cret", "bundle:Thing.apks", parts);
    ok("locked zip: streamed bytes equal the parts", wrote.size() == 3 && Arrays.equals(wrote.get("split_config.arm64_v8a.apk"), arm));
    // 4) a plain zip with two separate apps, and one of loose split parts at its root
    File two = new File(dir, "two.zip"); try (FileOutputStream o = new FileOutputStream(two)) { o.write(zip(m("a.apk", base, "b.apk", en, "notes.txt", new byte[3]), false)); }
    apps = KtApkPlan.apps(list(two, null)); ok("zip: two apps to choose", apps.size() == 2 && apps.get(0).select.equals("apk:a.apk") && apps.get(1).select.equals("apk:b.apk"));
    File loose = new File(dir, "loose.zip"); try (FileOutputStream o = new FileOutputStream(loose)) { o.write(zip(m("base.apk", base, "split_config.arm64_v8a.apk", arm, "split_config.x86_64.apk", x86), true)); }
    apps = KtApkPlan.apps(list(loose, null)); ok("zip: loose split parts are one app", apps.size() == 1 && apps.get(0).select.equals("dir:"));
    parts = KtApkPlan.parts(KtApkPlan.apksOf(list(loose, null), "dir:"), new String[]{ "x86_64" }); names.clear(); for (KtApkPlan.Entry e : parts) names.add(e.path);
    ok("zip on an x86_64 device: base and x86_64 " + names, names.equals(Arrays.asList("base.apk", "split_config.x86_64.apk")));
    // 5) nothing to install
    File none = new File(dir, "docs.zip"); try (FileOutputStream o = new FileOutputStream(none)) { o.write(zip(m("a.txt", new byte[5]), false)); }
    ok("no apps in a zip of documents", KtApkPlan.apps(list(none, null)).isEmpty());
    // What each part of a split app is, and which may be left out.
    ok("kinds: base, abi, lang, density, feature", KtApkPlan.kindOf("base.apk").equals("base") && KtApkPlan.kindOf("split_config.arm64_v8a.apk").equals("abi") && KtApkPlan.kindOf("split_config.ar.apk").equals("lang") && KtApkPlan.kindOf("config.xxhdpi.apk").equals("density") && KtApkPlan.kindOf("split_feature_maps.apk").equals("feature") && KtApkPlan.kindOf("Game/com.x.config.en_US.apk").equals("lang"));
    ok("only languages and densities are optional", KtApkPlan.optional("split_config.fr.apk") && KtApkPlan.optional("config.hdpi.apk") && !KtApkPlan.optional("base.apk") && !KtApkPlan.optional("split_config.x86_64.apk") && !KtApkPlan.optional("split_feature_maps.apk"));
    System.out.println(fails == 0 ? "apk installer: all passed" : fails + " failed"); System.exit(fails == 0 ? 0 : 1);
  }
}
