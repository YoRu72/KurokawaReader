// The Android downloader on its own, against a local server that takes two connections at a time: eight asked,
// six refused and their chunks taken by the two; stopped at 6 MB and resumed from there (If-Range); stopped
// again and the file changed on the server: downloaded afresh. Run by downloader.sh.
import com.sun.net.httpserver.*; import java.io.*; import java.net.*; import java.util.*; import java.util.concurrent.atomic.*; import java.security.*;
public class T {
  static byte[] data; static String etag = "\"v1\""; static AtomicInteger busy = new AtomicInteger(); static int limit = 2; static AtomicLong served = new AtomicLong(); static AtomicInteger refusals = new AtomicInteger(); static volatile boolean slowFirst = false; static AtomicInteger splits = new AtomicInteger(); static volatile boolean rotating = false; static volatile boolean apk = false; static volatile int deny = 0; static volatile boolean capped = false; static volatile long cutAfter = 0; static AtomicInteger tag = new AtomicInteger(); static volatile int resetOver = 0; static byte[] small = new byte[24000];
  public static void main(String[] a) throws Exception {
    data = new byte[20 << 20]; new Random(1).nextBytes(data);
    HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 50); s.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
    s.createContext("/f", ex -> {
      String range = ex.getRequestHeaders().getFirst("Range"); String ir = ex.getRequestHeaders().getFirst("If-Range");
      boolean probe = "bytes=0-0".equals(range);
      if (!probe && busy.incrementAndGet() > limit) { busy.decrementAndGet(); refusals.incrementAndGet(); ex.sendResponseHeaders(503, -1); ex.close(); return; }
      try {
        if (apk) ex.getResponseHeaders().add("Content-Type", "application/vnd.android.package-archive");
        // (A server that drops the connection — no answer at all — beyond `resetOver` at once.)
        if (resetOver > 0 && !probe && busy.get() > resetOver) { refusals.incrementAndGet(); throw new IOException("reset"); }
        if (deny > 0 && !probe && busy.get() > 1) { deny--; ex.sendResponseHeaders(403, -1); ex.close(); return; }
        ex.getResponseHeaders().add("ETag", rotating ? "\"r" + tag.incrementAndGet() + "\"" : etag); ex.getResponseHeaders().add("Accept-Ranges", "bytes");
        if (range == null || (ir != null && !ir.equals(etag))) { ex.sendResponseHeaders(200, data.length); try (OutputStream o = ex.getResponseBody()) { o.write(data); } served.addAndGet(data.length); return; }
        String[] p = range.substring(6).split("-"); long f = Long.parseLong(p[0]), t = p.length > 1 && !p[1].isEmpty() ? Long.parseLong(p[1]) : data.length - 1;
        ex.getResponseHeaders().add("Content-Range", "bytes " + f + "-" + t + "/" + data.length); ex.sendResponseHeaders(206, t - f + 1);
        if (slowFirst && f % (1310720) != 0) splits.incrementAndGet();
        final boolean slow = slowFirst && f == 0; long sent = 0;
        try (OutputStream o = ex.getResponseBody()) { for (long i = f; i <= t; i += 65536) { int n = (int) Math.min(65536, t - i + 1); o.write(data, (int) i, n); served.addAndGet(n); sent += n; if (cutAfter > 0 && sent >= cutAfter) { ex.getResponseBody().flush(); throw new java.io.IOException("cut"); } Thread.sleep(slow ? 150 : capped ? 40 : 2); } } catch (InterruptedException e) {}
      } finally { if (!probe) busy.decrementAndGet(); }
    });
    s.createContext("/s", ex -> {
      String range = ex.getRequestHeaders().getFirst("Range"); ex.getResponseHeaders().add("Accept-Ranges", "bytes");
      if (range == null) { ex.sendResponseHeaders(200, small.length); try (OutputStream o = ex.getResponseBody()) { o.write(small); } return; }
      String[] p = range.substring(6).split("-"); int f = Integer.parseInt(p[0]), t = p.length > 1 && !p[1].isEmpty() ? Integer.parseInt(p[1]) : small.length - 1;
      ex.getResponseHeaders().add("Content-Range", "bytes " + f + "-" + t + "/" + small.length); ex.sendResponseHeaders(206, t - f + 1); try (OutputStream o = ex.getResponseBody()) { o.write(small, f, t - f + 1); }
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
    // 11: a server that gives each connection only so much (1.6 MB/s here): connections added while the speed rises.
    capped = true; limit = 16; File out11 = new File(dir, "capped.part"); out11.delete(); KrDownloader.Result r11 = new KrDownloader.Result(); long t11 = System.currentTimeMillis();
    KrDownloader.fetch(u, out11, 12, op, new AtomicBoolean(), new AtomicLong(), r11, () -> {}, new KrDownloader.Opts());
    long ms11 = System.currentTimeMillis() - t11; boolean ok11 = Arrays.equals(java.nio.file.Files.readAllBytes(out11.toPath()), data) && r11.connections > 3; capped = false;
    System.out.println("run11 scaled to " + r11.connections + " connections (started with 3) in " + ms11 + " ms, match=" + ok11);
    // 13: a weak phone link that drops every connection after 200 KB (each chunk needs many tries, each going on
    // from where the last stopped): finished all the same, not given up after the retries.
    cutAfter = 200 << 10; limit = 16; File out13 = new File(dir, "cut.part"); out13.delete(); boolean ok13;
    try { KrDownloader.fetch(u, out13, Integer.getInteger("c13", 6), op, new AtomicBoolean(), new AtomicLong(), new KrDownloader.Result(), () -> {}, new KrDownloader.Opts()); ok13 = Arrays.equals(java.nio.file.Files.readAllBytes(out13.toPath()), data); } catch (Exception e) { System.out.println("run13 threw " + e); ok13 = false; }
    cutAfter = 0; System.out.println("run13 connections cut every 200 KB, done anyway: " + ok13);
    // 15: speed limits under the 16 KB a read asks (10 KB/s): the reads go on at that speed, not stopped for good; a
    // limit taken off while a read waits lets it through at once; a download under its own limit (8 KB/s) and the
    // global one (12 KB/s) both, the slower kept.
    boolean ok15; { KrDownloader.Limiter l = new KrDownloader.Limiter(10_000); long t15 = System.currentTimeMillis();
      Thread th = new Thread(() -> { try { l.take(16384); l.take(16384); } catch (InterruptedException e) {} }); th.setDaemon(true); th.start(); th.join(8000); long ms1 = System.currentTimeMillis() - t15;
      KrDownloader.Limiter l2 = new KrDownloader.Limiter(1000); Thread th2 = new Thread(() -> { try { l2.take(16384); } catch (InterruptedException e) {} }); th2.setDaemon(true); th2.start(); Thread.sleep(400); long t1 = System.currentTimeMillis(); l2.set(0); th2.join(3000); long ms2 = System.currentTimeMillis() - t1;
      long t2 = System.currentTimeMillis(); new KrDownloader.Limiter(0).take(1 << 20); long ms3 = System.currentTimeMillis() - t2;
      new Random(3).nextBytes(small); File o15 = new File(dir, "lim.part"); o15.delete(); KrDownloader.Opts p15 = new KrDownloader.Opts(); p15.limiter = new KrDownloader.Limiter(8000); KrDownloader.GLOBAL.set(12000);
      final boolean[] fin = { false }; long t3 = System.currentTimeMillis(); URL us = new URL("http://127.0.0.1:" + s.getAddress().getPort() + "/s");
      Thread th3 = new Thread(() -> { try { KrDownloader.fetch(us, o15, 4, op, new AtomicBoolean(), new AtomicLong(), new KrDownloader.Result(), () -> {}, p15); fin[0] = true; } catch (Exception e) { System.out.println("run15 " + e); } }); th3.setDaemon(true); th3.start(); th3.join(12000); long ms4 = System.currentTimeMillis() - t3; KrDownloader.GLOBAL.set(0);
      boolean m15 = fin[0] && Arrays.equals(java.nio.file.Files.readAllBytes(o15.toPath()), small);
      ok15 = !th.isAlive() && ms1 >= 2500 && ms1 < 5000 && !th2.isAlive() && ms2 < 1000 && ms3 < 100 && m15 && ms4 >= 2000;
      System.out.println("run15 10 KB/s: 32 KB in " + (th.isAlive() ? "never" : ms1 + " ms") + "; limit taken off, waited " + (th2.isAlive() ? "for ever" : ms2 + " ms") + "; none: " + ms3 + " ms; 24 KB at 8 KB/s under 12 KB/s: " + (fin[0] ? ms4 + " ms" : "never") + " match=" + m15 + " ok=" + ok15); }
    // 16: a weak phone link that drops every connection after 300 KB, 6 connections asked: a drop after bytes is the
    // network, not the server refusing — the range tried again, the connections kept (not cut down one by one to 1).
    cutAfter = 300 << 10; limit = 16; refusals.set(0); File out16 = new File(dir, "flaky.part"); out16.delete(); KrDownloader.Result r16 = new KrDownloader.Result(); KrDownloader.Opts o16 = new KrDownloader.Opts(); o16.scale = false; boolean ok16;
    try { KrDownloader.fetch(u, out16, 6, op, new AtomicBoolean(), new AtomicLong(), r16, () -> {}, o16); ok16 = Arrays.equals(java.nio.file.Files.readAllBytes(out16.toPath()), data) && !r16.refused && r16.connections >= 5; } catch (Exception e) { System.out.println("run16 threw " + e); ok16 = false; }
    cutAfter = 0; System.out.println("run16 drops every 300 KB on 6 connections: refused=" + r16.refused + " connections=" + r16.connections + " ok=" + ok16);
    // 17: a server that truly takes 3 connections at a time, 8 asked: refused by 503 — and, another time, by a dropped
    // connection with nothing sent —: down to 3, and told as refused (the engine keeps 3 for this host).
    limit = 3; File out17 = new File(dir, "three.part"); out17.delete(); KrDownloader.Result r17 = new KrDownloader.Result(); KrDownloader.Opts o17 = new KrDownloader.Opts(); o17.scale = false; boolean ok17a, ok17b;
    try { KrDownloader.fetch(u, out17, 8, op, new AtomicBoolean(), new AtomicLong(), r17, () -> {}, o17); ok17a = Arrays.equals(java.nio.file.Files.readAllBytes(out17.toPath()), data) && r17.refused && r17.connections >= 2 && r17.connections <= 3; } catch (Exception e) { System.out.println("run17 threw " + e); ok17a = false; }
    limit = 16; resetOver = 3; out17.delete(); KrDownloader.Result r17b = new KrDownloader.Result();
    try { KrDownloader.fetch(u, out17, 8, op, new AtomicBoolean(), new AtomicLong(), r17b, () -> {}, o17); ok17b = Arrays.equals(java.nio.file.Files.readAllBytes(out17.toPath()), data) && r17b.refused && r17b.connections >= 2 && r17b.connections <= 3; } catch (Exception e) { System.out.println("run17 threw " + e); ok17b = false; }
    resetOver = 0; System.out.println("run17 a server taking 3: by 503 refused=" + r17.refused + " connections=" + r17.connections + "; by dropping refused=" + r17b.refused + " connections=" + r17b.connections + " ok=" + (ok17a && ok17b));
    // 18: both: a server taking 3 at a time, on a link that drops every connection after 300 KB: 3, not 1.
    limit = 3; cutAfter = 300 << 10; File out18 = new File(dir, "mix.part"); out18.delete(); KrDownloader.Result r18 = new KrDownloader.Result(); boolean ok18;
    try { KrDownloader.fetch(u, out18, 8, op, new AtomicBoolean(), new AtomicLong(), r18, () -> {}, o17); ok18 = Arrays.equals(java.nio.file.Files.readAllBytes(out18.toPath()), data) && r18.refused && r18.connections >= 2 && r18.connections <= 3; } catch (Exception e) { System.out.println("run18 threw " + e); ok18 = false; }
    cutAfter = 0; limit = 16; System.out.println("run18 taking 3 and dropping every 300 KB: refused=" + r18.refused + " connections=" + r18.connections + " ok=" + ok18);
    // 14: a MEGA file: the server sends it encrypted (AES-128-CTR), the file is written decrypted — over several
    // connections, each at its own place, and resumed halfway.
    byte[] plain = data.clone(); byte[] mk = new byte[32]; new Random(7).nextBytes(mk);
    { byte[] a16 = new byte[16]; for (int i = 0; i < 16; i++) a16[i] = (byte) (mk[i] ^ mk[i + 16]); byte[] iv = new byte[16]; System.arraycopy(mk, 16, iv, 0, 8);
      javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES/CTR/NoPadding"); c.init(javax.crypto.Cipher.ENCRYPT_MODE, new javax.crypto.spec.SecretKeySpec(a16, "AES"), new javax.crypto.spec.IvParameterSpec(iv)); data = c.doFinal(plain); }
    etag = "\"mega\""; limit = 16; File out14 = new File(dir, "mega.part"); out14.delete(); File st14 = new File(dir, "mega.state"); st14.delete();
    KrDownloader.Opts o14 = new KrDownloader.Opts(); o14.megaKey = mk; o14.state = st14; AtomicBoolean c14 = new AtomicBoolean(); AtomicLong g14 = new AtomicLong();
    KrDownloader.fetch(u, out14, 6, op, c14, g14, new KrDownloader.Result(), () -> { if (g14.get() > (7 << 20)) c14.set(true); }, o14);
    c14.set(false); KrDownloader.fetch(u, out14, 6, op, c14, new AtomicLong(), new KrDownloader.Result(), () -> {}, o14);
    boolean ok14 = Arrays.equals(java.nio.file.Files.readAllBytes(out14.toPath()), plain); data = plain; etag = "\"v1\"";
    System.out.println("run14 MEGA file decrypted as written, resumed: " + ok14);
    // 19: the same MEGA file from a server that gives no ETag (nor a date): stopped at 7 MB and resumed — what is here
    // (decrypted) checked against the server's (encrypted) by decrypting those, so it goes on instead of starting again.
    { byte[] a16 = new byte[16]; for (int i = 0; i < 16; i++) a16[i] = (byte) (mk[i] ^ mk[i + 16]); byte[] iv = new byte[16]; System.arraycopy(mk, 16, iv, 0, 8);
      javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES/CTR/NoPadding"); c.init(javax.crypto.Cipher.ENCRYPT_MODE, new javax.crypto.spec.SecretKeySpec(a16, "AES"), new javax.crypto.spec.IvParameterSpec(iv)); data = c.doFinal(plain); }
    etag = ""; File out19 = new File(dir, "mega2.part"); out19.delete(); File st19 = new File(dir, "mega2.state"); st19.delete();
    KrDownloader.Opts o19 = new KrDownloader.Opts(); o19.megaKey = mk; o19.state = st19; AtomicBoolean c19 = new AtomicBoolean(); AtomicLong g19 = new AtomicLong();
    KrDownloader.fetch(u, out19, 6, op, c19, g19, new KrDownloader.Result(), () -> { if (g19.get() > (7 << 20)) c19.set(true); }, o19);
    long b19 = served.get(); c19.set(false); AtomicLong g19b = new AtomicLong(); AtomicLong f19 = new AtomicLong(-1);
    KrDownloader.fetch(u, out19, 6, op, c19, g19b, new KrDownloader.Result(), () -> f19.compareAndSet(-1, g19b.get()), o19);
    boolean ok19 = Arrays.equals(java.nio.file.Files.readAllBytes(out19.toPath()), plain) && f19.get() >= (5 << 20) && served.get() - b19 < (16L << 20); data = plain; etag = "\"v1\"";
    System.out.println("run19 MEGA without an ETag resumed from=" + f19.get() + " served=" + (served.get() - b19) + " ok=" + ok19);
    // 12: what a finished file is, from its bytes: an APK, a bundle, an e-book, a video, a PDF, a ZIP — and only weak names changed.
    java.util.function.BiFunction<String, String[], File> zipOf = (nm, entries) -> { try { File z = new File(dir, nm); try (java.util.zip.ZipOutputStream zo = new java.util.zip.ZipOutputStream(new java.io.FileOutputStream(z))) { for (String e : entries) { zo.putNextEntry(new java.util.zip.ZipEntry(e)); zo.write(e.equals("mimetype") ? "application/epub+zip".getBytes() : new byte[] { 1, 2, 3 }); zo.closeEntry(); } } return z; } catch (Exception e) { throw new RuntimeException(e); } };
    java.util.function.BiFunction<String, byte[], File> raw = (nm, head) -> { try { File z = new File(dir, nm); byte[] all = Arrays.copyOf(head, 1024); java.nio.file.Files.write(z.toPath(), all); return z; } catch (Exception e) { throw new RuntimeException(e); } };
    String[][] cases = {
      { KrDownloader.sniffExt(zipOf.apply("a.bin", new String[] { "META-INF/MANIFEST.MF", "AndroidManifest.xml", "classes.dex", "resources.arsc" })), "apk" },
      { KrDownloader.sniffExt(zipOf.apply("b.bin", new String[] { "manifest.json", "icon.png", "com.x.apk", "config.arm64_v8a.apk" })), "xapk" },
      { KrDownloader.sniffExt(zipOf.apply("c.bin", new String[] { "info.json", "base.apk", "split_config.en.apk" })), "apkm" },
      { KrDownloader.sniffExt(zipOf.apply("d", new String[] { "mimetype", "META-INF/container.xml", "OEBPS/a.xhtml" })), "epub" },
      { KrDownloader.sniffExt(zipOf.apply("e.dat", new String[] { "readme.md", "src/a.c" })), "zip" },
      { KrDownloader.sniffExt(raw.apply("f.bin", "%PDF-1.7".getBytes())), "pdf" },
      { KrDownloader.sniffExt(raw.apply("g.bin", new byte[] { 0, 0, 0, 0x20, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm' })), "mp4" },
      { KrDownloader.sniffExt(raw.apply("h.bin", new byte[] { 0x1a, 0x45, (byte) 0xdf, (byte) 0xa3, 0, 'm', 'a', 't', 'r', 'o', 's', 'k', 'a' })), "mkv" },
      { KrDownloader.sniffExt(raw.apply("i.bin", "<!doctype html><html>".getBytes())), null },
      { KrDownloader.withSniffed("Game-0.bin", "apk"), "Game-0.apk" }, { KrDownloader.withSniffed("download.php", "pdf"), "download.pdf" },
      { KrDownloader.withSniffed("1234567", "mkv"), "1234567.mkv" }, { KrDownloader.withSniffed("pack.zip", "xapk"), "pack.xapk" },
      { KrDownloader.withSniffed("notes.txt", "zip"), null }, { KrDownloader.withSniffed("app.apk", "apk"), null }, { KrDownloader.withSniffed("lib.jar", "zip"), null },
      { KrDownloader.withSniffed("Movie.S01E01", "mkv"), "Movie.S01E01.mkv" },
    };
    boolean ok12 = true; for (String[] c : cases) if (!java.util.Objects.equals(c[0], c[1])) { ok12 = false; System.out.println("  sniff got " + c[0] + " wanted " + c[1]); }
    System.out.println("run12 file types from their bytes: " + ok12);
    s.stop(0); System.exit(ok2 && ok3 && ok4 && ok5 && ok6 && ok7 && ok8 && ok9 && ok10 && ok11 && ok12 && ok13 && ok14 && ok15 && ok16 && ok17a && ok17b && ok18 && ok19 && splits.get() > 0 && got.get() == data.length && first.get() > (4 << 20) ? 0 : 1);
  }
}
