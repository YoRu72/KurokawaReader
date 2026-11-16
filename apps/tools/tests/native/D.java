// The Android downloader and its names for a plain file link (the owner's: an Internet Archive download host serving an
// Arabic-named PDF): the request line goes out exactly as given (no re-encoding, no «+» for a space, no double encoding of «%»);
// a redirect to a mirror on another host is followed and a resumed download asks that mirror for the rest by Range; the
// saved name is the percent-decoded UTF-8 name, what a file system refuses made a space (runs of those joined), double spaces
// kept; Content-Disposition filename* wins over the link's name; a too-long name is cut between characters, extension kept.
// Run by direct.sh, against two local servers (127.0.0.1 and localhost: two hosts), made-up names only.
import com.sun.net.httpserver.*; import java.io.*; import java.net.*; import java.nio.charset.StandardCharsets; import java.util.*; import java.util.concurrent.atomic.*;
public class D {
  static int fails = 0;
  static void ok(String n, boolean c, Object x) { System.out.println((c ? "ok   " : "FAIL ") + n + (c || x == null ? "" : "  " + x)); if (!c) fails++; }
  static void ok(String n, boolean c) { ok(n, c, null); }
  static final List<String> seen = Collections.synchronizedList(new ArrayList<>());      // «METHOD rawpath?rawquery [Range]» at the mirror
  static final List<String> hopped = Collections.synchronizedList(new ArrayList<>());    // the same at the first host
  static byte[] data = new byte[300_000];
  static String disposition = null;
  public static void main(String[] a) throws Exception {
    new Random(7).nextBytes(data);
    HttpServer mirror = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 20); mirror.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
    mirror.createContext("/", ex -> {
      String raw = ex.getRequestURI().getRawPath() + (ex.getRequestURI().getRawQuery() != null ? "?" + ex.getRequestURI().getRawQuery() : ""); String range = ex.getRequestHeaders().getFirst("Range");
      seen.add(ex.getRequestMethod() + " " + raw + (range != null ? " " + range : ""));
      ex.getResponseHeaders().add("Accept-Ranges", "bytes"); ex.getResponseHeaders().add("ETag", "\"m1\""); ex.getResponseHeaders().add("Content-Type", "application/pdf");
      if (disposition != null) ex.getResponseHeaders().add("Content-Disposition", disposition);
      if (range == null) { ex.sendResponseHeaders(200, data.length); try (OutputStream o = ex.getResponseBody()) { o.write(data); } return; }
      String[] p = range.substring(6).split("-"); int f = Integer.parseInt(p[0]), t = p.length > 1 && !p[1].isEmpty() ? Integer.parseInt(p[1]) : data.length - 1;
      ex.getResponseHeaders().add("Content-Range", "bytes " + f + "-" + t + "/" + data.length); ex.sendResponseHeaders(206, t - f + 1); try (OutputStream o = ex.getResponseBody()) { o.write(data, f, t - f + 1); }
    });
    mirror.start(); int mp = mirror.getAddress().getPort();
    // The first host: every path answers 302 to the same path on the mirror (another host name: «localhost»), twice over (a chain).
    HttpServer front = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 20);
    front.createContext("/", ex -> {
      String raw = ex.getRequestURI().getRawPath() + (ex.getRequestURI().getRawQuery() != null ? "?" + ex.getRequestURI().getRawQuery() : ""); hopped.add(ex.getRequestMethod() + " " + raw);
      boolean first = !raw.startsWith("/hop2"); String to = first ? "http://127.0.0.1:" + ex.getLocalAddress().getPort() + "/hop2" + raw : "http://localhost:" + mp + raw.substring(5);
      ex.getResponseHeaders().add("Location", to); ex.sendResponseHeaders(302, -1); ex.close();
    });
    front.start(); int fp = front.getAddress().getPort();
    KrDownloader.Opener op = x -> { HttpURLConnection c = (HttpURLConnection) x.openConnection(Proxy.NO_PROXY); c.setInstanceFollowRedirects(false); return c; };
    File dir = new File("dl"); dir.mkdirs();

    // The owner's link: an Arabic name (percent-encoded UTF-8) with double spaces, an Arabic comma and digits.
    String ar = "/0/items/made-up-item/%D8%AB%D9%84%D8%A7%D8%AB%20%20%D8%B1%D8%B3%D8%A7%D8%A6%D9%84%D8%8C%20%201688.pdf";
    String[] paths = { ar, "/a/x%2By%20z+w.pdf", "/a/h%23k.pdf", "/a/q%3Fq.pdf", "/a/UP.PDF", "/a/file.pdf?token=a%20b&x=%2B", "/a/100%25.pdf", "/a/%E2%82%AC%20.epub" };
    for (String p : paths) {
      seen.clear(); hopped.clear(); disposition = null; File out = new File(dir, "o" + Math.abs(p.hashCode()) + ".part"); out.delete();
      KrDownloader.Result r = KrDownloader.fetch(new URL("http://127.0.0.1:" + fp + p), out, 2, op, new AtomicBoolean(), new AtomicLong(), new KrDownloader.Result(), () -> {}, new KrDownloader.Opts());
      boolean allSame = !seen.isEmpty(); for (String s : seen) if (!s.contains(" " + p)) allSame = false;
      ok("request line exact at the mirror: " + p, allSame, seen);
      ok("first host asked exactly: " + p, !hopped.isEmpty() && hopped.get(0).equals("GET " + p), hopped);
      ok("bytes whole: " + p, out.length() == data.length || new File(dir, out.getName().replace(".part", "")).length() == data.length, out.length());
    }
    // Resume across the redirects: cancelled part-way, the rest asked of the mirror by Range.
    { seen.clear(); hopped.clear(); disposition = null; File out = new File(dir, "resume.part"); File st = new File(dir, "resume.state"); out.delete(); st.delete();
      KrDownloader.Opts opt = new KrDownloader.Opts(); opt.state = st; URL u = new URL("http://127.0.0.1:" + fp + ar); AtomicBoolean cancel = new AtomicBoolean(); AtomicLong got = new AtomicLong();
      try { KrDownloader.fetch(u, out, 1, op, cancel, got, new KrDownloader.Result(), () -> { if (got.get() > 100_000) cancel.set(true); }, opt); } catch (Exception e) { /* cancelled */ }
      long partial = out.length(); ok("stopped part-way", got.get() > 0 && got.get() < data.length, got.get());
      seen.clear(); hopped.clear();
      KrDownloader.Result r = KrDownloader.fetch(u, out, 1, op, new AtomicBoolean(), new AtomicLong(), new KrDownloader.Result(), () -> {}, opt);
      boolean ranged = false; for (String s : seen) if (s.contains("Range: ") || s.matches(".* bytes=[1-9]\\d*-.*")) ranged = true;
      ok("resume asks the mirror for the rest by Range (after the redirects)", ranged, seen);
      boolean exactAgain = true; for (String s : seen) if (!s.contains(" " + ar)) exactAgain = false; ok("resume request line still exact", exactAgain && !seen.isEmpty(), seen);
      byte[] got2 = java.nio.file.Files.readAllBytes(out.exists() ? out.toPath() : new File(dir, "resume").toPath()); ok("resumed file equals the source", Arrays.equals(got2, data));
    }
    // Names: the link's own (percent-decoded UTF-8; «+» is a plus; double spaces kept), what the file system refuses, the cut.
    String arName = "ثلاث  رسائل،  1688.pdf";
    ok("name from the owner's link", arName.equals(KrDownloader.nameFromUrl("https://dn721300.ca.archive.org" + ar)), KrDownloader.nameFromUrl("https://dn721300.ca.archive.org" + ar));
    ok("«+» stays a plus; %2B a plus", "x+y z+w.pdf".equals(KrDownloader.nameFromUrl("https://h/a/x%2By%20z+w.pdf")), KrDownloader.nameFromUrl("https://h/a/x%2By%20z+w.pdf"));
    ok("%23 and %3F in the name", "h#k.pdf".equals(KrDownloader.nameFromUrl("https://h/a/h%23k.pdf")) && "q?q.pdf".equals(KrDownloader.nameFromUrl("https://h/a/q%3Fq.pdf")));
    ok("uppercase extension kept", "UP.PDF".equals(KrDownloader.nameFromUrl("https://h/a/UP.PDF")));
    ok("the query after the extension is no part of the name", "file.pdf".equals(KrDownloader.nameFromUrl("https://h/a/file.pdf?token=1")), KrDownloader.nameFromUrl("https://h/a/file.pdf?token=1"));
    ok("illegal characters become a space (a run, one)", "a b c.pdf".equals(KrDownloader.cleanName("a:?b<>c.pdf")) && "h#k.pdf".equals(KrDownloader.cleanName("h#k.pdf")), KrDownloader.cleanName("a:?b<>c.pdf"));
    ok("double spaces and U+060C survive the sanitiser", arName.equals(KrDownloader.cleanName(arName)), KrDownloader.cleanName(arName));
    // Content-Disposition filename* (UTF-8) wins over the link's name.
    seen.clear(); disposition = "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''%D9%85%D9%84%D9%81%20%20%D8%A7%D9%84%D9%86%D8%B3%D8%AE%D8%A9%20%2B%D9%A1.pdf";
    { File out = new File(dir, "cd.part"); out.delete(); KrDownloader.Result r = KrDownloader.fetch(new URL("http://127.0.0.1:" + mp + "/a/link-name.pdf"), out, 1, op, new AtomicBoolean(), new AtomicLong(), new KrDownloader.Result(), () -> {}, new KrDownloader.Opts());
      ok("filename* wins: " + r.fileName, "ملف  النسخة +١.pdf".equals(r.fileName), r.fileName); }
    disposition = null;
    { File out = new File(dir, "nocd.part"); out.delete(); KrDownloader.Result r = KrDownloader.fetch(new URL("http://127.0.0.1:" + mp + "/a/link-name.pdf"), out, 1, op, new AtomicBoolean(), new AtomicLong(), new KrDownloader.Result(), () -> {}, new KrDownloader.Opts()); ok("no Content-Disposition: the link's name stands", r.fileName == null, r.fileName); }
    // The cut: 255 bytes is the limit; names cut at 200 between characters, the extension kept.
    StringBuilder sb = new StringBuilder(); for (int i = 0; i < 150; i++) sb.append("عبد"); String longName = sb + ".pdf"; String cut = KrDownloader.cleanName(longName);
    ok("long Arabic name cut to <= 200 bytes", cut.getBytes(StandardCharsets.UTF_8).length <= 200 && cut.endsWith(".pdf"), cut.getBytes(StandardCharsets.UTF_8).length);
    ok("the cut is valid UTF-8 (no half character)", new String(cut.getBytes(StandardCharsets.UTF_8), StandardCharsets.UTF_8).equals(cut) && !cut.contains("�"));
    StringBuilder em = new StringBuilder(); for (int i = 0; i < 80; i++) em.append("😀"); String cut2 = KrDownloader.cleanName(em + ".mkv");
    boolean pairs = true; for (int i = 0; i < cut2.length(); i++) { char c = cut2.charAt(i); if (Character.isHighSurrogate(c)) { if (i + 1 >= cut2.length() || !Character.isLowSurrogate(cut2.charAt(i + 1))) pairs = false; i++; } else if (Character.isLowSurrogate(c)) pairs = false; }
    ok("no cut inside a surrogate pair; extension kept", pairs && cut2.endsWith(".mkv") && cut2.getBytes(StandardCharsets.UTF_8).length <= 200, cut2.length());
    ok("a short name is left alone", "a.pdf".equals(KrDownloader.cleanName("a.pdf")));
    System.out.println(fails == 0 ? "direct: all passed" : fails + " failed"); System.exit(fails == 0 ? 0 : 1);
  }
}
