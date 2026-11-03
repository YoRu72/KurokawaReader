// The Android downloader on its own, against a local server that takes two connections at a time: eight asked,
// six refused and their chunks taken by the two; stopped at 6 MB and resumed from there (If-Range); stopped
// again and the file changed on the server: downloaded afresh. Run by downloader.sh.
import com.sun.net.httpserver.*; import java.io.*; import java.net.*; import java.util.*; import java.util.concurrent.atomic.*; import java.security.*;
public class T {
  static byte[] data; static String etag = "\"v1\""; static AtomicInteger busy = new AtomicInteger(); static int limit = 2; static AtomicLong served = new AtomicLong(); static AtomicInteger refusals = new AtomicInteger(); static volatile boolean slowFirst = false; static AtomicInteger splits = new AtomicInteger(); static volatile boolean rotating = false; static volatile boolean apk = false; static volatile int deny = 0; static AtomicInteger tag = new AtomicInteger();
  public static void main(String[] a) throws Exception {
    data = new byte[20 << 20]; new Random(1).nextBytes(data);
    HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 50); s.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
    s.createContext("/f", ex -> {
      String range = ex.getRequestHeaders().getFirst("Range"); String ir = ex.getRequestHeaders().getFirst("If-Range");
      boolean probe = "bytes=0-0".equals(range);
      if (!probe && busy.incrementAndGet() > limit) { busy.decrementAndGet(); refusals.incrementAndGet(); ex.sendResponseHeaders(503, -1); ex.close(); return; }
      try {
        if (apk) ex.getResponseHeaders().add("Content-Type", "application/vnd.android.package-archive");
        if (deny > 0 && !probe && busy.get() > 1) { deny--; ex.sendResponseHeaders(403, -1); ex.close(); return; }
        ex.getResponseHeaders().add("ETag", rotating ? "\"r" + tag.incrementAndGet() + "\"" : etag); ex.getResponseHeaders().add("Accept-Ranges", "bytes");
        if (range == null || (ir != null && !ir.equals(etag))) { ex.sendResponseHeaders(200, data.length); try (OutputStream o = ex.getResponseBody()) { o.write(data); } served.addAndGet(data.length); return; }
        String[] p = range.substring(6).split("-"); long f = Long.parseLong(p[0]), t = p.length > 1 && !p[1].isEmpty() ? Long.parseLong(p[1]) : data.length - 1;
        ex.getResponseHeaders().add("Content-Range", "bytes " + f + "-" + t + "/" + data.length); ex.sendResponseHeaders(206, t - f + 1);
        if (slowFirst && f % (1310720) != 0) splits.incrementAndGet();
        final boolean slow = slowFirst && f == 0;
        try (OutputStream o = ex.getResponseBody()) { for (long i = f; i <= t; i += 65536) { int n = (int) Math.min(65536, t - i + 1); o.write(data, (int) i, n); served.addAndGet(n); Thread.sleep(slow ? 150 : 2); } } catch (InterruptedException e) {}
      } finally { if (!probe) busy.decrementAndGet(); }
    });
    s.start(); URL u = new URL("http://127.0.0.1:" + s.getAddress().getPort() + "/f");
    File dir = new File("dl"); dir.mkdirs(); File out = new File(dir, "f.part"); File st = new File(dir, "f.state"); out.delete(); st.delete();
    KrDownloader.Opener op = x -> { HttpURLConnection c = (HttpURLConnection) x.openConnection(Proxy.NO_PROXY); c.setInstanceFollowRedirects(false); return c; };
    KrDownloader.Opts opt = new KrDownloader.Opts(); opt.state = st;
    // 1: 8 connections asked, the server takes 2; cancelled at 6 MB.
    AtomicBoolean cancel = new AtomicBoolean(); AtomicLong got = new AtomicLong(); KrDownloader.Result r = new KrDownloader.Result();
    KrDownloader.fetch(u, out, 8, op, cancel, got, r, () -> { if (got.get() > (6 << 20)) cancel.set(true); }, opt);
    System.out.println("run1 got=" + got.get() + " refused=" + r.refused + " conns=" + r.connections + " refusals=" + refusals.get() + " stateExists=" + st.exists());
    long before = served.get();
    // 2: resumed.
    cancel.set(false); got.set(0); r = new KrDownloader.Result(); AtomicLong first = new AtomicLong(-1);
    KrDownloader.fetch(u, out, 8, op, cancel, got, r, () -> first.compareAndSet(-1, got.get()), opt);
    boolean ok2 = Arrays.equals(java.nio.file.Files.readAllBytes(out.toPath()), data);
    System.out.println("run2 startedAt=" + first.get() + " servedNow=" + (served.get() - before) + " match=" + ok2 + " stateGone=" + !st.exists());
    // 3: cancelled again, then the file changes: downloaded afresh.
    out.delete(); cancel.set(false); got.set(0); r = new KrDownloader.Result();
    KrDownloader.fetch(u, out, 4, op, cancel, got, r, () -> { if (got.get() > (4 << 20)) cancel.set(true); }, opt);
    data = data.clone(); data[123] ^= 1; data[19 << 20] ^= 1; etag = "\"v2\"";
    cancel.set(false); got.set(0); r = new KrDownloader.Result();
    KrDownloader.fetch(u, out, 4, op, cancel, got, r, () -> {}, opt);
    boolean ok3 = Arrays.equals(java.nio.file.Files.readAllBytes(out.toPath()), data);
    System.out.println("run3 match=" + ok3);
    // 4: the plain call (no progress file given — the in-app updater's): a temporary one is made for it.
    File out4 = new File(dir, "plain.part"); out4.delete(); limit = 8; got.set(0);
    KrDownloader.fetch(u, out4, 4, op, new AtomicBoolean(), got, new KrDownloader.Result(), () -> {});
    boolean ok4 = Arrays.equals(java.nio.file.Files.readAllBytes(out4.toPath()), data);
    System.out.println("run4 plain match=" + ok4);
    // 5: one connection very slow (its chunk crawls): at the end its part is cut and the rest taken by the others.
    File out5 = new File(dir, "slow.part"); out5.delete(); slowFirst = true; got.set(0); long t0 = System.currentTimeMillis();
    KrDownloader.fetch(u, out5, 4, op, new AtomicBoolean(), got, new KrDownloader.Result(), () -> {});
    long ms = System.currentTimeMillis() - t0; boolean ok5 = Arrays.equals(java.nio.file.Files.readAllBytes(out5.toPath()), data);
    System.out.println("run5 slow connection match=" + ok5 + " parts taken over=" + splits.get() + " ms=" + ms + " counted=" + got.get());
    slowFirst = false;
    // 6: a server whose ETag changes on every answer (CDNs, signed links): stopped at 8 MB, then resumed — the bytes
    // here checked against the server's instead of downloading it all again.
    File out6 = new File(dir, "cdn.part"), st6 = new File(dir, "cdn.state"); out6.delete(); st6.delete(); KrDownloader.Opts o6 = new KrDownloader.Opts(); o6.state = st6; rotating = true;
    AtomicBoolean c6 = new AtomicBoolean(); AtomicLong g6 = new AtomicLong();
    KrDownloader.fetch(u, out6, 4, op, c6, g6, new KrDownloader.Result(), () -> { if (g6.get() > (8 << 20)) c6.set(true); }, o6);
    long b6 = served.get(); c6.set(false); g6.set(0); AtomicLong f6 = new AtomicLong(-1);
    KrDownloader.fetch(u, out6, 4, op, c6, g6, new KrDownloader.Result(), () -> f6.compareAndSet(-1, g6.get()), o6);
    boolean ok6 = Arrays.equals(java.nio.file.Files.readAllBytes(out6.toPath()), data) && f6.get() >= (7 << 20) && served.get() - b6 < (14L << 20);
    System.out.println("run6 changing ETag resumed from=" + f6.get() + " served=" + (served.get() - b6) + " match=" + ok6);
    // 7: the record lost (only the .part left): the chunks there found by their bytes, checked, and kept.
    st6.delete(); out6.delete(); c6.set(false); g6.set(0);
    KrDownloader.fetch(u, out6, 4, op, c6, g6, new KrDownloader.Result(), () -> { if (g6.get() > (10 << 20)) c6.set(true); }, o6);
    st6.delete(); long b7 = served.get(); g6.set(0); c6.set(false); AtomicLong f7 = new AtomicLong(-1);
    KrDownloader.fetch(u, out6, 4, op, c6, g6, new KrDownloader.Result(), () -> f7.compareAndSet(-1, g6.get()), o6);
    boolean ok7 = Arrays.equals(java.nio.file.Files.readAllBytes(out6.toPath()), data) && f7.get() >= (5 << 20) && served.get() - b7 < (16L << 20);
    System.out.println("run7 no record: found=" + f7.get() + " served=" + (served.get() - b7) + " match=" + ok7);
    // 8: one big chunk stopped halfway: what it had is kept (not just whole chunks).
    File out8 = new File(dir, "one.part"), st8 = new File(dir, "one.state"); out8.delete(); st8.delete(); KrDownloader.Opts o8 = new KrDownloader.Opts(); o8.state = st8; rotating = false;
    AtomicBoolean c8 = new AtomicBoolean(); AtomicLong g8 = new AtomicLong();
    KrDownloader.fetch(u, out8, 1, op, c8, g8, new KrDownloader.Result(), () -> { if (g8.get() > (5 << 20)) c8.set(true); }, o8);
    g8.set(0); c8.set(false); AtomicLong f8 = new AtomicLong(-1);
    KrDownloader.fetch(u, out8, 1, op, c8, g8, new KrDownloader.Result(), () -> f8.compareAndSet(-1, g8.get()), o8);
    boolean ok8 = Arrays.equals(java.nio.file.Files.readAllBytes(out8.toPath()), data) && f8.get() >= (4 << 20);
    System.out.println("run8 partial chunk kept from=" + f8.get() + " match=" + ok8);
    // 9: an APK served under a «.bin» name: renamed as soon as the server answers, the download going on under it.
    apk = true; File out9 = new File(dir, "Game-0.bin.part"), st9 = new File(dir, "g.state"); out9.delete(); st9.delete(); new File(dir, "Game-0.apk.part").delete(); KrDownloader.Opts o9 = new KrDownloader.Opts(); o9.state = st9;
    final File[] named = { null }; o9.named = (n, mime) -> { String nn = KrDownloader.withTypeExt("Game-0.bin", mime); named[0] = nn == null ? null : new File(dir, nn + ".part"); return named[0]; };
    KrDownloader.Result r9 = KrDownloader.fetch(u, out9, 4, op, new AtomicBoolean(), new AtomicLong(), new KrDownloader.Result(), () -> {}, o9);
    boolean ok9 = named[0] != null && named[0].getName().equals("Game-0.apk.part") && r9.out != null && r9.out.equals(named[0]) && Arrays.equals(java.nio.file.Files.readAllBytes(named[0].toPath()), data) && !out9.exists();
    System.out.println("run9 named from its type: " + (named[0] == null ? null : named[0].getName()) + " match=" + ok9); apk = false;
    // 10: a few connections answered 403 while the others go on (storage refusing one too many): not the end.
    File out10 = new File(dir, "deny.part"); out10.delete(); deny = 3; limit = 8; AtomicLong g10 = new AtomicLong(); KrDownloader.Result r10 = new KrDownloader.Result();
    boolean ok10; try { KrDownloader.fetch(u, out10, 6, op, new AtomicBoolean(), g10, r10, () -> {}, new KrDownloader.Opts()); ok10 = Arrays.equals(java.nio.file.Files.readAllBytes(out10.toPath()), data); } catch (Exception e) { System.out.println("run10 " + e); ok10 = false; }
    System.out.println("run10 403 on some connections, done anyway: " + ok10 + " connections now " + r10.connections); deny = 0;
    s.stop(0); System.exit(ok2 && ok3 && ok4 && ok5 && ok6 && ok7 && ok8 && ok9 && ok10 && splits.get() > 0 && got.get() == data.length && first.get() > (4 << 20) ? 0 : 1);
  }
}
