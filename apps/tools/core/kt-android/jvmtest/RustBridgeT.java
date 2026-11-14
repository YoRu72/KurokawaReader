// The Rust core through Java's own door (KtCore), on the computer: the library built for the host (cargo build
// --release in kt-android) loaded by a plain JVM — the same JNI call shape the APK uses, proven without an emulator.
// Then stage M1: tests/native/RuT.java's cases asked of Java's KtDlRules and of Rust, which must answer alike (and as
// RuT expects), the shadow mode counting no difference; the screen translator's cache keys alike on awkward text.
// Run by run.sh: `java -Dkt.core.lib=<libkt_android.so> RustBridgeT` (or `RustBridgeT absent` with no library).
import app.kurokawa.tools.KtCore;
import java.io.*; import java.util.*; import java.util.concurrent.*; import java.util.concurrent.atomic.*;

public class RustBridgeT {
  static int fails = 0;
  static void check(String what, boolean ok, Object got) { System.out.println((ok ? "ok   " : "FAIL ") + what + (ok ? "" : ": " + got)); if (!ok) fails++; }
  static void eq(String what, Object got, Object want) { check(what, Objects.equals(norm(got), norm(want)), got + " (wanted " + want + ")"); }
  static Object norm(Object o) { return o instanceof Integer ? (Object) ((Integer) o).longValue() : o; }

  /** Java's answer and Rust's for one RuT case: both must be `want`. */
  static void both(String what, Object java, String method, Object want, Object... kv) throws Exception {
    eq("java: " + what, java, want);
    eq("rust: " + what, KtCore.r(method, kv), want);
  }

  public static void main(String[] a) throws Exception {
    if (a.length > 0 && a[0].equals("absent")) { absent(); return; }
    // --- M0: the plumbing ---
    check("library loaded", KtCore.available(), KtCore.status());
    System.out.println("     " + KtCore.status());
    eq("version", KtCore.version(), "0.2.0");
    eq("core.sum 2 + 40", KtCore.r("core.sum", "a", 2, "b", 40), 42L);
    eq("core.sum negative", KtCore.r("core.sum", "a", -7, "b", 3), -4L);
    String odd = "مرحبا \u0000 \t \"q\" \\ 😀 　 é";
    eq("core.echo carries any text both ways", ((Map<?, ?>) KtCore.r("core.echo", "s", odd, "n", null, "b", true, "l", Arrays.asList("x", 1))).get("s"), odd);
    byte[] all = new byte[256]; for (int i = 0; i < 256; i++) all[i] = (byte) i;
    check("bytes.echo: all 256 byte values", Arrays.equals(KtCore.callBytes("bytes.echo", "{}", all), all), "differs");
    check("bytes.echo: null data → empty", KtCore.callBytes("bytes.echo", null, null).length == 0, "not empty");
    try { KtCore.r("core.panic"); check("a panic comes back as an error", false, "no error"); } catch (KtCore.Failure f) { check("a panic comes back as an error, not a crash", f.getMessage().startsWith("panic: "), f.getMessage()); }
    eq("a call after the panic still answers", KtCore.r("core.sum", "a", 1, "b", 1), 2L);
    try { KtCore.r("no.such"); check("unknown method", false, "no error"); } catch (KtCore.Failure f) { check("an unknown method is an error", f.getMessage().contains("no such method"), f.getMessage()); }
    try { KtCore.r("core.sum", "a", 1); check("missing argument", false, "no error"); } catch (KtCore.Failure f) { check("a missing argument is an error", f.getMessage().contains("missing"), f.getMessage()); }
    try { KtCore.call("core.sum", "{bad"); check("bad JSON", false, "no error"); } catch (KtCore.Failure f) { check("bad JSON is an error", true, null); }
    // Many threads at once (the downloader's pool calls from several).
    ExecutorService pool = Executors.newFixedThreadPool(8); AtomicInteger wrong = new AtomicInteger(); List<Future<?>> fs = new ArrayList<>();
    for (int t = 0; t < 8; t++) { final int base = t * 1000; fs.add(pool.submit(() -> { for (int i = 0; i < 500; i++) try { if (!Objects.equals(KtCore.r("core.sum", "a", base, "b", i), (long) (base + i))) wrong.incrementAndGet(); } catch (Exception e) { wrong.incrementAndGet(); } })); }
    for (Future<?> f : fs) f.get(); pool.shutdown();
    eq("4000 calls from 8 threads, all right", wrong.get(), 0);

    // --- M1: KtDlRules, tests/native/RuT.java's cases, Java and Rust alike ---
    File dir = new File("rules"); dir.mkdirs(); for (File f : dir.listFiles()) f.delete();
    String d = dir.getPath();
    Set<String> none = new HashSet<>(); Set<String> first = new HashSet<>(Collections.singleton("ep.mkv")); Set<String> two = new HashSet<>(Arrays.asList("ep.mkv", "ep (2).mkv"));
    both("two of one name, nothing on disk yet", KtDlRules.pickName(dir, "ep.mkv", false, "rename", first), "dl.pickName", "ep (2).mkv", "dir", d, "safe", "ep.mkv", "begun", false, "conflict", "rename", "reserved", first);
    both("a third, with (2) taken too", KtDlRules.pickName(dir, "ep.mkv", false, "rename", two), "dl.pickName", "ep (3).mkv", "dir", d, "safe", "ep.mkv", "begun", false, "conflict", "rename", "reserved", two);
    both("the other's name in another case", KtDlRules.pickName(dir, "EP.mkv", false, "rename", first), "dl.pickName", "EP (2).mkv", "dir", d, "safe", "EP.mkv", "begun", false, "conflict", "rename", "reserved", first);
    both("conflict overwrite, still not one .part", KtDlRules.pickName(dir, "ep.mkv", false, "overwrite", first), "dl.pickName", "ep (2).mkv", "dir", d, "safe", "ep.mkv", "begun", false, "conflict", "overwrite", "reserved", first);
    both("conflict skip, a download is not a file", KtDlRules.pickName(dir, "ep.mkv", false, "skip", first), "dl.pickName", "ep (2).mkv", "dir", d, "safe", "ep.mkv", "begun", false, "conflict", "skip", "reserved", first);
    both("begun already: its name kept", KtDlRules.pickName(dir, "ep.mkv", true, "rename", first), "dl.pickName", "ep.mkv", "dir", d, "safe", "ep.mkv", "begun", true, "conflict", "rename", "reserved", first);
    both("alone: its name", KtDlRules.pickName(dir, "ep.mkv", false, "rename", none), "dl.pickName", "ep.mkv", "dir", d, "safe", "ep.mkv", "begun", false, "conflict", "rename", "reserved", none);
    new FileOutputStream(new File(dir, "ep.mkv")).close();
    both("the file there, rename", KtDlRules.pickName(dir, "ep.mkv", false, "rename", none), "dl.pickName", "ep (2).mkv", "dir", d, "safe", "ep.mkv", "begun", false, "conflict", "rename", "reserved", none);
    both("the file there, skip", KtDlRules.pickName(dir, "ep.mkv", false, "skip", none), "dl.pickName", null, "dir", d, "safe", "ep.mkv", "begun", false, "conflict", "skip", "reserved", none);
    both("the file there, overwrite", KtDlRules.pickName(dir, "ep.mkv", false, "overwrite", none), "dl.pickName", "ep.mkv", "dir", d, "safe", "ep.mkv", "begun", false, "conflict", "overwrite", "reserved", none);
    new FileOutputStream(new File(dir, "ep.mkv.part")).close();
    both("the file and its own .part: kept", KtDlRules.pickName(dir, "ep.mkv", false, "rename", none), "dl.pickName", "ep.mkv", "dir", d, "safe", "ep.mkv", "begun", false, "conflict", "rename", "reserved", none);
    new File(dir, "ep.mkv").delete();
    both("only another download's .part there", KtDlRules.pickName(dir, "ep.mkv", false, "rename", first), "dl.pickName", "ep (2).mkv", "dir", d, "safe", "ep.mkv", "begun", false, "conflict", "rename", "reserved", first);
    Set<String> t2 = new HashSet<>(Collections.singleton("ep (2).mkv"));
    both("a free name passes over files, .parts and names", KtDlRules.freeName(dir, "ep.mkv", t2), "dl.freeName", "ep (3).mkv", "dir", d, "name", "ep.mkv", "reserved", t2);
    List<String> metered = Collections.singletonList("metered"), battery = Collections.singletonList("battery"), bothH = Arrays.asList("battery", "metered");
    both("mobile data, Wi-Fi only switch on", KtDlRules.holdOf(metered, true, false, false), "dl.holdOf", "metered", "holds", metered, "wifiOnlyAll", true, "taskWifiOnly", false, "anyway", false);
    both("mobile data, this download Wi-Fi only", KtDlRules.holdOf(metered, false, true, false), "dl.holdOf", "metered", "holds", metered, "wifiOnlyAll", false, "taskWifiOnly", true, "anyway", false);
    both("mobile data, neither", KtDlRules.holdOf(metered, false, false, false), "dl.holdOf", null, "holds", metered, "wifiOnlyAll", false, "taskWifiOnly", false, "anyway", false);
    both("a low battery holds every download", KtDlRules.holdOf(battery, false, false, false), "dl.holdOf", "battery", "holds", battery, "wifiOnlyAll", false, "taskWifiOnly", false, "anyway", false);
    both("both: the battery", KtDlRules.holdOf(bothH, false, false, false), "dl.holdOf", "battery", "holds", bothH, "wifiOnlyAll", false, "taskWifiOnly", false, "anyway", false);
    both("no hold", KtDlRules.holdOf(Collections.<String>emptyList(), true, true, false), "dl.holdOf", null, "holds", Collections.emptyList(), "wifiOnlyAll", true, "taskWifiOnly", true, "anyway", false);
    both("«download now»: not held", KtDlRules.holdOf(bothH, true, true, true), "dl.holdOf", null, "holds", bothH, "wifiOnlyAll", true, "taskWifiOnly", true, "anyway", true);
    both("holds: metered, not Wi-Fi only", KtDlRules.holds("metered", false, false), "dl.holds", false, "reason", "metered", "wifiOnlyAll", false, "taskWifiOnly", false);
    both("refused: what it took", KtDlRules.nextHostLimit(null, 8, true, 3), "dl.nextHostLimit", 3L, "lim", null, "want", 8, "refused", true, "connections", 3);
    both("refused again with a limit", KtDlRules.nextHostLimit(6, 8, true, 2), "dl.nextHostLimit", 2L, "lim", 6, "want", 8, "refused", true, "connections", 2);
    both("no limit known, not refused", KtDlRules.nextHostLimit(null, 8, false, 8), "dl.nextHostLimit", null, "lim", null, "want", 8, "refused", false, "connections", 8);
    both("1 → 2", KtDlRules.nextHostLimit(1, 24, false, 1), "dl.nextHostLimit", 2L, "lim", 1, "want", 24, "refused", false, "connections", 1);
    both("4 → 8", KtDlRules.nextHostLimit(4, 24, false, 4), "dl.nextHostLimit", 8L, "lim", 4, "want", 24, "refused", false, "connections", 4);
    both("16 → 24", KtDlRules.nextHostLimit(16, 24, false, 16), "dl.nextHostLimit", 24L, "lim", 16, "want", 24, "refused", false, "connections", 16);
    both("fewer used than allowed: kept", KtDlRules.nextHostLimit(4, 24, false, 2), "dl.nextHostLimit", 4L, "lim", 4, "want", 24, "refused", false, "connections", 2);
    both("resumed while stopping", KtDlRules.restartAfterStop(true, false, "queued"), "dl.restartAfterStop", true, "resumedWhileStopping", true, "paused", false, "state", "queued");
    both("resumed, then paused again", KtDlRules.restartAfterStop(true, true, "paused"), "dl.restartAfterStop", false, "resumedWhileStopping", true, "paused", true, "state", "paused");
    both("not resumed", KtDlRules.restartAfterStop(false, false, "paused"), "dl.restartAfterStop", false, "resumedWhileStopping", false, "paused", false, "state", "paused");
    both("removed meanwhile", KtDlRules.restartAfterStop(true, false, "removed"), "dl.restartAfterStop", false, "resumedWhileStopping", true, "paused", false, "state", "removed");

    // --- M1: shadow mode — KtDlRules and KtTranslate ask Rust beside Java; no difference may be counted ---
    KtCore.shadow = true;
    check("shadowing on", KtCore.shadowing(), KtCore.shadowReport());
    for (File f : dir.listFiles()) f.delete(); new FileOutputStream(new File(dir, "ep.mkv")).close();
    for (String c : new String[] { "rename", "skip", "overwrite" }) for (boolean begun : new boolean[] { false, true }) for (Set<String> r : Arrays.asList(none, first, two, null)) { KtDlRules.pickName(dir, "ep.mkv", begun, c, r); KtDlRules.pickName(dir, "Ünï.mkv", begun, c, r); }
    KtDlRules.freeName(dir, ".hidden", null); KtDlRules.freeName(dir, "a.b.c", first); KtDlRules.freeName(dir, "noext", two);
    for (List<String> h : Arrays.asList(metered, battery, bothH, Arrays.asList("metered", "battery"), Collections.<String>emptyList(), null)) for (int m = 0; m < 8; m++) KtDlRules.holdOf(h, (m & 1) != 0, (m & 2) != 0, (m & 4) != 0);
    for (Integer lim : new Integer[] { null, 1, 4, 16, 24, 30 }) for (int conn : new int[] { 0, 1, 2, 4, 16, 24 }) { KtDlRules.nextHostLimit(lim, 24, false, conn); KtDlRules.nextHostLimit(lim, 24, true, conn); }
    for (String st : new String[] { "queued", "paused", "done", "removed", "seeding", "" }) for (int m = 0; m < 4; m++) KtDlRules.restartAfterStop((m & 1) != 0, (m & 2) != 0, st);
    Map<String, Object> cfgA = new HashMap<>(); cfgA.put("engine", "ai"); cfgA.put("target", "ar"); Map<String, Object> ai = new HashMap<>(); ai.put("base", "http://127.0.0.1:9/oa//"); ai.put("model", "m1"); ai.put("prompt", "Be brief. 😀"); cfgA.put("ai", ai);
    Map<String, Object> gl = new HashMap<>(); Map<String, Object> e1 = new HashMap<>(); e1.put("from", "Kurokawa"); e1.put("to", "كوروكاوا"); gl.put("entries", Arrays.asList(e1)); cfgA.put("glossary", gl);
    Map<String, Object> cfgB = new HashMap<>(); cfgB.put("engine", "deepl"); cfgB.put("source", "ja"); cfgB.put("target", "en");
    String[] texts = { "  Hello   world  ", "line one \n line two", "a \n \n b", "\n\r x \r\n", "a\r\nb", "こんにちは　　世界", "é (é, composed by NFC)", "بِسْمِ ٱللَّٰهِ", "😀   x", "" };
    for (Map<String, Object> cfg : Arrays.asList(cfgA, cfgB, new HashMap<String, Object>())) { KtTranslate.Config c = KtTranslate.Config.from(cfg); for (String t : texts) KtTranslate.cacheKey(c, t); }
    Map<String, Object> rep = KtCore.shadowReport();
    check("shadow: rules asked of both (" + rep.get("calls") + " calls)", ((Long) rep.get("calls")) >= 200, rep);
    eq("shadow: no difference between Java and Rust", rep.get("mismatches"), 0L);
    if (!Long.valueOf(0).equals(rep.get("mismatches"))) System.out.println("     first: " + rep.get("first"));
    // A difference is seen and kept (a wrong «Java» answer handed in on purpose).
    KtCore.shadow("dl.holds", Boolean.TRUE, "reason", "metered", "wifiOnlyAll", false, "taskWifiOnly", false);
    rep = KtCore.shadowReport();
    check("shadow: a difference counted and kept for the diagnostics", Long.valueOf(1).equals(rep.get("mismatches")) && ((List<?>) rep.get("first")).size() == 1 && String.valueOf(((List<?>) rep.get("first")).get(0)).startsWith("dl.holds"), rep);
    KtCore.shadow = false;
    m2();
    System.out.println(fails == 0 ? "rust bridge: all passed" : "rust bridge: " + fails + " FAILED"); System.exit(fails == 0 ? 0 : 1);
  }

  /** Stage M2 beside the downloader's runs (downloader-rust.sh): the record Java writes is the record Rust writes, each
   *  reads the other's; MEGA's decryption at any offset as Java's CtrFile; one small download through each engine. */
  static void m2() throws Exception {
    File dir = new File("m2"); dir.mkdirs(); File st = new File(dir, "x.state");
    KrDownloader.State s = new KrDownloader.State(); s.total = 20 << 20; s.chunk = 1310720; s.validator = "\"v1\""; s.mark(0); s.mark(1); s.mark(5); s.setPartial(2, 65536); s.setPartial(7, 1);
    s.write(st); String javaText = new String(java.nio.file.Files.readAllBytes(st.toPath()), "UTF-8");
    eq("record: Rust writes what Java wrote", KtCore.r("http.record", "text", javaText), javaText);
    String rustText = (String) KtCore.r("http.record", "text", "kt1\n20971520\n\"v1\"\n1310720\n5,0,1,\n7:1,2:65536,1:99,");
    java.nio.file.Files.write(st.toPath(), rustText.getBytes("UTF-8")); KrDownloader.State back = KrDownloader.State.read(st);
    check("record: Java reads what Rust wrote", back != null && back.total == s.total && back.chunk == s.chunk && back.validator.equals(s.validator) && back.done.equals(s.done) && back.partial.equals(s.partial), rustText);
    eq("record: what Java refuses Rust refuses", KtCore.r("http.record", "text", "kt1\n0\n\n1\n\n"), null);
    byte[] k = new byte[32]; new Random(7).nextBytes(k); byte[] enc = new byte[70000]; new Random(9).nextBytes(enc); boolean same = true;
    for (int[] r : new int[][] { { 0, 70000 }, { 1, 17 }, { 15, 16 }, { 16, 48 }, { 12345, 60001 }, { 69999, 70000 } }) {
      byte[] part = Arrays.copyOfRange(enc, r[0], r[1]);
      if (!Arrays.equals(KrDownloader.CtrFile.plain(k, r[0], part), KrDownloaderRs.megaPlain(k, r[0], part, 0, part.length))) { same = false; System.out.println("     differs at " + r[0]); }
    }
    check("MEGA: Rust decrypts as Java at any offset", same, null);
    eq("a small download through the Rust engine", smallDownload(dir, true), true);
  }

  /** 300 KB from a loopback server through KrDownloaderRs (`viaRs`) — the Rust engine, or Java when the core is absent. */
  static boolean smallDownload(File dir, boolean viaRs) throws Exception {
    dir.mkdirs(); final byte[] data = new byte[300_000]; new Random(5).nextBytes(data);
    com.sun.net.httpserver.HttpServer srv = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 10);
    srv.createContext("/f", ex -> {
      String range = ex.getRequestHeaders().getFirst("Range"); ex.getResponseHeaders().add("Accept-Ranges", "bytes"); ex.getResponseHeaders().add("ETag", "\"s\"");
      if (range == null) { ex.sendResponseHeaders(200, data.length); try (OutputStream o = ex.getResponseBody()) { o.write(data); } return; }
      String[] p = range.substring(6).split("-"); int f = Integer.parseInt(p[0]), t = p.length > 1 && !p[1].isEmpty() ? Integer.parseInt(p[1]) : data.length - 1;
      ex.getResponseHeaders().add("Content-Range", "bytes " + f + "-" + t + "/" + data.length); ex.sendResponseHeaders(206, t - f + 1); try (OutputStream o = ex.getResponseBody()) { o.write(data, f, t - f + 1); }
    });
    srv.start();
    try {
      File out = new File(dir, "small.part"); out.delete(); int runs = KrDownloaderRs.RUST_RUNS.get();
      java.net.URL u = new java.net.URL("http://127.0.0.1:" + srv.getAddress().getPort() + "/f");
      KrDownloader.Opener op = x -> { java.net.HttpURLConnection c = (java.net.HttpURLConnection) x.openConnection(java.net.Proxy.NO_PROXY); c.setInstanceFollowRedirects(false); return c; };
      KrDownloaderRs.fetch(u, out, 4, op, new AtomicBoolean(), new AtomicLong(), new KrDownloader.Result(), () -> {});
      boolean viaRust = KrDownloaderRs.RUST_RUNS.get() > runs;
      return Arrays.equals(java.nio.file.Files.readAllBytes(out.toPath()), data) && viaRust == viaRs;
    } finally { srv.stop(0); }
  }

  /** No library: Java carries on, nothing throws at a caller. */
  static void absent() throws Exception {
    check("absent: available() is false", !KtCore.available(), KtCore.status());
    check("absent: status says so", KtCore.status().startsWith("Rust core: absent"), KtCore.status());
    check("absent: version null", KtCore.version() == null, KtCore.version());
    try { KtCore.r("core.sum", "a", 1, "b", 2); check("absent: a call fails cleanly", false, "answered"); } catch (KtCore.Failure f) { check("absent: a call fails cleanly (Failure, not an Error)", true, null); }
    KtCore.shadow = true;
    check("absent: shadowing off whatever the switch", !KtCore.shadowing(), null);
    eq("absent: Java's rules unchanged", KtDlRules.nextHostLimit(4, 24, false, 4), 8);
    eq("absent: no shadow call made", KtCore.shadowReport().get("calls"), 0L);
    eq("absent: the Rust engine's door downloads with Java, silently", smallDownload(new File("m2-absent"), false), true);
    System.out.println(fails == 0 ? "rust bridge (absent): all passed" : "rust bridge (absent): " + fails + " FAILED"); System.exit(fails == 0 ? 0 : 1);
  }
}
