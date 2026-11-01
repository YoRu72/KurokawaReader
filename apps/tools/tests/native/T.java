// The Android downloader on its own, against a local server that takes two connections at a time: eight asked,
// six refused and their chunks taken by the two; stopped at 6 MB and resumed from there (If-Range); stopped
// again and the file changed on the server: downloaded afresh. Run by downloader.sh.
import com.sun.net.httpserver.*; import java.io.*; import java.net.*; import java.util.*; import java.util.concurrent.atomic.*; import java.security.*;
public class T {
  static byte[] data; static String etag = "\"v1\""; static AtomicInteger busy = new AtomicInteger(); static int limit = 2; static AtomicLong served = new AtomicLong(); static AtomicInteger refusals = new AtomicInteger();
  public static void main(String[] a) throws Exception {
    data = new byte[20 << 20]; new Random(1).nextBytes(data);
    HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 50); s.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
    s.createContext("/f", ex -> {
      String range = ex.getRequestHeaders().getFirst("Range"); String ir = ex.getRequestHeaders().getFirst("If-Range");
      boolean probe = "bytes=0-0".equals(range);
      if (!probe && busy.incrementAndGet() > limit) { busy.decrementAndGet(); refusals.incrementAndGet(); ex.sendResponseHeaders(503, -1); ex.close(); return; }
      try {
        ex.getResponseHeaders().add("ETag", etag); ex.getResponseHeaders().add("Accept-Ranges", "bytes");
        if (range == null || (ir != null && !ir.equals(etag))) { ex.sendResponseHeaders(200, data.length); try (OutputStream o = ex.getResponseBody()) { o.write(data); } served.addAndGet(data.length); return; }
        String[] p = range.substring(6).split("-"); long f = Long.parseLong(p[0]), t = p.length > 1 && !p[1].isEmpty() ? Long.parseLong(p[1]) : data.length - 1;
        ex.getResponseHeaders().add("Content-Range", "bytes " + f + "-" + t + "/" + data.length); ex.sendResponseHeaders(206, t - f + 1);
        try (OutputStream o = ex.getResponseBody()) { for (long i = f; i <= t; i += 65536) { int n = (int) Math.min(65536, t - i + 1); o.write(data, (int) i, n); served.addAndGet(n); Thread.sleep(2); } } catch (InterruptedException e) {}
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
    s.stop(0); System.exit(ok2 && ok3 && ok4 && first.get() > (4 << 20) ? 0 : 1);
  }
}
