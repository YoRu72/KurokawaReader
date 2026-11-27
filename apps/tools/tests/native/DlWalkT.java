// The phone's file downloader (KrDownloader.java, compiled outside its package) walked against the misbehaving server
// of tests/dlwalk.cjs (127.0.0.1, made-up bytes): one case per argument, each printed as one «WALK {json}» line —
// how it ended (done / failed and the reason the engine would show, KtEngine.java's mapping), the bytes it counted,
// the file's SHA-256, where a resumed run began, what was left in its folder, the threads still running.
// Usage: java DlWalkT <base url> <work dir> <case> [<case>…]   (the case «crashchild» is the child the crash case kills)
import java.io.*; import java.net.*; import java.util.*; import java.util.concurrent.atomic.*; import java.security.*;
public class DlWalkT {
  static String base; static File work;
  static final KrDownloader.Opener OP = x -> { HttpURLConnection c = (HttpURLConnection) x.openConnection(Proxy.NO_PROXY); c.setConnectTimeout(5000); c.setReadTimeout(20000); c.setInstanceFollowRedirects(false); c.setRequestProperty("User-Agent", "KurokawaTools/walk"); return c; };
  static String q(String s) { if (s == null) return "null"; StringBuilder b = new StringBuilder("\""); for (char ch : s.toCharArray()) { if (ch == '"' || ch == '\\') b.append('\\').append(ch); else if (ch < 0x20) b.append(String.format("\\u%04x", (int) ch)); else b.append(ch); } return b.append('"').toString(); }
  static String sha(File f) { try (InputStream in = new FileInputStream(f)) { MessageDigest d = MessageDigest.getInstance("SHA-256"); byte[] b = new byte[1 << 16]; int r; while ((r = in.read(b)) > 0) d.update(b, 0, r); StringBuilder s = new StringBuilder(); for (byte x : d.digest()) s.append(String.format("%02x", x)); return s.toString(); } catch (Exception e) { return null; } }
  static void ctl(String c, String op) { try { HttpURLConnection h = (HttpURLConnection) new URL(base + "/ctl?c=" + c + "&op=" + op).openConnection(Proxy.NO_PROXY); h.getResponseCode(); h.disconnect(); } catch (IOException e) { throw new UncheckedIOException(e); } }
  /** KtEngine's words for a failure (KtEngine.java: «page», «HTTP n», errOf). */
  static String reason(Throwable e) { if (e instanceof KrDownloader.WebPage) return "page"; if (e instanceof KrDownloader.Status) return "HTTP " + ((KrDownloader.Status) e).code; String m = String.valueOf(e.getMessage()); return m.contains("EPERM") || m.contains("EACCES") || m.contains("Permission denied") ? "noFolderAccess" : m; }
  /** The wait the downloader tells (read by name: a version without it says nothing). */
  static long rAt(Object res) { try { return res.getClass().getDeclaredField("retryAt").getLong(res); } catch (Exception e) { return 0; } }
  static String rWhy(Object res) { try { return (String) res.getClass().getDeclaredField("retryWhy").get(res); } catch (Exception e) { return null; } }
  static int threads() { int n = 0; for (Thread t : Thread.getAllStackTraces().keySet()) if (t.isAlive() && !t.isDaemon() && t != Thread.currentThread() && !t.getName().startsWith("HttpClient") && !t.getName().equals("main") && !t.getName().startsWith("Keep-Alive") && !t.getName().equals("DestroyJavaVM")) n++; return n; }

  static final class Run { String state = "?", error; long got, total, firstAt = -1, ms; KrDownloader.Result res; File out, st; long maxRetryWait; String retryWhy; }
  /** One fetch as the engine runs it, with its after-check (KtEngine.java: a known size not met is «incomplete»). */
  static Run fetch(String path, File out, File st, int conns, AtomicBoolean cancel, java.util.function.LongPredicate stopAt) {
    Run r = new Run(); r.out = out; r.st = st; AtomicLong got = new AtomicLong(); KrDownloader.Result res = new KrDownloader.Result(); r.res = res; long t0 = System.currentTimeMillis();
    KrDownloader.Opts o = new KrDownloader.Opts(); o.state = st; o.expectName = out.getName().replaceAll("\\.part$", "");
    try {
      KrDownloader.Result x = KrDownloader.fetch(new URL(base + path), out, conns, OP, cancel, got, res, () -> { if (r.firstAt < 0 && got.get() > 0) r.firstAt = got.get(); if (rAt(res) > 0) { r.maxRetryWait = Math.max(r.maxRetryWait, rAt(res) - System.currentTimeMillis()); r.retryWhy = rWhy(res); } if (stopAt != null && stopAt.test(got.get())) cancel.set(true); }, o);
      File p = x.out != null ? x.out : out; r.out = p;
      if (cancel.get()) r.state = "paused";
      else if (x.total > 0 && p.length() != x.total) { r.state = "failed"; r.error = "incomplete"; }
      else r.state = "done";
    } catch (Throwable e) { r.state = cancel.get() ? "paused" : "failed"; r.error = reason(e); }
    r.got = got.get(); r.total = res.total; r.ms = System.currentTimeMillis() - t0; return r;
  }
  static String left(File dir) { String[] k = dir.list(); Arrays.sort(k); return String.join(",", k); }
  static void print(String c, Run r, String extra) {
    System.out.println("WALK {\"case\":" + q(c) + ",\"state\":" + q(r.state) + ",\"error\":" + q(r.error) + ",\"got\":" + r.got + ",\"total\":" + r.total + ",\"firstAt\":" + r.firstAt + ",\"ms\":" + r.ms
      + ",\"sha\":" + q(r.out != null && r.out.exists() ? sha(r.out) : null) + ",\"size\":" + (r.out != null && r.out.exists() ? r.out.length() : -1) + ",\"name\":" + q(r.res == null ? null : r.res.fileName)
      + ",\"retryWhy\":" + q(r.retryWhy) + ",\"retryWait\":" + r.maxRetryWait + ",\"left\":" + q(r.out == null ? null : left(r.out.getParentFile())) + ",\"threads\":" + threads() + (extra == null ? "" : "," + extra) + "}");
  }
  static File dirFor(String c) { File d = new File(work, c); if (d.exists()) for (File f : d.listFiles()) f.delete(); d.mkdirs(); return d; }
  static final long SIZE = 6L << 20;
  static java.util.function.LongPredicate at40 = g -> g >= SIZE * 4 / 10;

  public static void main(String[] a) throws Exception {
    base = a[0]; work = new File(a[1]); work.mkdirs();
    for (int i = 2; i < a.length; i++) { String c = a[i]; try { one(c); } catch (Throwable e) { System.out.println("WALK {\"case\":" + q(c) + ",\"state\":\"crashed\",\"error\":" + q(String.valueOf(e)) + "}"); } }
    System.exit(0);
  }
  static void one(String c) throws Exception {
    File d = dirFor(c); File out = new File(d, c + ".bin.part"), st = new File(d, c + ".state");
    switch (c) {
      // (One run to its end.)
      case "nolen": case "badlen": case "r429": case "r503": case "drop5": case "dropnr": case "stall": case "redir5": case "loop": case "ok": case "nolenr": {
        Run r = fetch("/f/" + c, out, st, 4, new AtomicBoolean(), null); print(c, r, null); break;
      }
      // (Paused at 40 %, resumed: a server that cannot go on restarts honestly; one whose file changed starts afresh.)
      case "norange": case "r200": case "changed": case "changedmid": case "changedpart": case "rotate": {
        AtomicBoolean cancel = new AtomicBoolean(); Run r1 = fetch("/f/" + c, out, st, c.equals("changedpart") ? 1 : 4, cancel, c.equals("changedpart") ? (g -> g >= SIZE / 5) : at40);   // (changedpart: stopped inside its first chunk, so only a part is begun)
        if (c.startsWith("changed")) ctl(c, "change");
        // (The record as the pause left it — what each chunk had saved —, and the server told to log the ranges asked from here.)
        String rec = null; try { rec = new String(java.nio.file.Files.readAllBytes(st.toPath()), "UTF-8"); } catch (IOException ignored) {}
        ctl(c, "mark");
        Run r2 = fetch("/f/" + c, out, st, c.equals("changedpart") ? 1 : 4, new AtomicBoolean(), null);
        print(c, r2, "\"pausedAt\":" + r1.got + ",\"pausedState\":" + q(r1.state) + ",\"record\":" + q(rec)); break;
      }
      // (Paused, the link then refused — it ran out —: failed with the reason, the bytes kept; a new link goes on from them.)
      case "expired": {
        AtomicBoolean cancel = new AtomicBoolean(); Run r1 = fetch("/f/expired", out, st, 4, cancel, at40);
        ctl(c, "expire"); Run r2 = fetch("/f/expired", out, st, 4, new AtomicBoolean(), null);
        long kept = out.exists() ? out.length() : -1; boolean stKept = st.exists();
        Run r3 = fetch("/f/expired?fresh=1", out, st, 4, new AtomicBoolean(), null);
        print(c, r3, "\"pausedAt\":" + r1.got + ",\"expiredState\":" + q(r2.state) + ",\"expiredError\":" + q(r2.error) + ",\"partKept\":" + kept + ",\"recordKept\":" + stKept); break;
      }
      // (Paused and resumed ten times quickly.)
      case "quick": {
        long[] pauses = new long[10]; for (int k = 0; k < 10; k++) { final long stop = (k + 1) * (SIZE / 14); AtomicBoolean cancel = new AtomicBoolean(); Run r = fetch("/f/quick", out, st, 4, cancel, g -> g >= stop); pauses[k] = r.got; }
        Run r = fetch("/f/quick", out, st, 4, new AtomicBoolean(), null); print(c, r, "\"pauses\":" + Arrays.toString(pauses)); break;
      }
      // (Removed while it runs — the engine's remove: cancelled, its .part and record deleted at once —: what is left.)
      case "del": {
        AtomicBoolean cancel = new AtomicBoolean(); final Run[] hold = { null };
        Thread t = new Thread(() -> hold[0] = fetch("/f/del", out, st, 4, cancel, null)); t.start();
        long until = System.currentTimeMillis() + 20000; while (System.currentTimeMillis() < until && (!out.exists() || out.length() == 0 || hold[0] == null && st.length() == 0)) Thread.sleep(20);
        Thread.sleep(300); cancel.set(true); out.delete(); st.delete(); t.join(20000); Thread.sleep(500);
        Run r = hold[0] == null ? new Run() : hold[0]; r.out = new File(d, "x"); print(c, r, "\"leftAfter\":" + q(left(d))); break;
      }
      // (The app killed mid-way: a child JVM downloading, killed at about 40 %; a new run goes on from its record.)
      case "crash": {
        String java = System.getProperty("java.home") + "/bin/java";
        Process p = new ProcessBuilder(java, "-cp", System.getProperty("java.class.path"), "DlWalkT", base, work.getPath(), "crashchild").redirectErrorStream(true).start();
        BufferedReader br = new BufferedReader(new InputStreamReader(p.getInputStream())); String line; long seen = 0; long until = System.currentTimeMillis() + 60000;
        while (System.currentTimeMillis() < until && (line = br.readLine()) != null) { if (line.startsWith("GOT ")) { seen = Long.parseLong(line.substring(4)); if (seen >= SIZE * 4 / 10) break; } }
        p.destroyForcibly(); p.waitFor();
        File cd = new File(work, "crashchild"); File co = new File(cd, "crashchild.bin.part"), cs = new File(cd, "crashchild.state");
        ctl("crash", "fast"); Run r = fetch("/f/crash", co, cs, 4, new AtomicBoolean(), null); print(c, r, "\"killedAt\":" + seen); break;
      }
      case "crashchild": {
        File cd = dirFor("crashchild"); File co = new File(cd, "crashchild.bin.part"), cs = new File(cd, "crashchild.state"); AtomicLong last = new AtomicLong();
        AtomicLong got = new AtomicLong(); KrDownloader.Opts o = new KrDownloader.Opts(); o.state = cs;
        KrDownloader.fetch(new URL(base + "/f/crash"), co, 4, OP, new AtomicBoolean(), got, new KrDownloader.Result(), () -> { long g = got.get(); if (g - last.get() > (64 << 10)) { last.set(g); System.out.println("GOT " + g); System.out.flush(); } }, o);
        break;
      }
      // (Two downloads to the same name at once into one folder: the engine's rule gives the second another name.)
      case "same": {
        java.util.Set<String> reserved = new java.util.HashSet<>();
        String n1 = KtDlRules.pickName(d, "same.bin", false, "rename", reserved); reserved.add(n1.toLowerCase(Locale.ROOT));
        String n2 = KtDlRules.pickName(d, "same.bin", false, "rename", reserved);
        File o1 = new File(d, n1 + ".part"), o2 = new File(d, n2 + ".part"); final Run[] rr = new Run[2];
        Thread t1 = new Thread(() -> rr[0] = fetch("/f/same", o1, new File(d, "1.state"), 4, new AtomicBoolean(), null)), t2 = new Thread(() -> rr[1] = fetch("/f/same", o2, new File(d, "2.state"), 4, new AtomicBoolean(), null));
        t1.start(); t2.start(); t1.join(); t2.join();
        print(c, rr[1], "\"n1\":" + q(n1) + ",\"n2\":" + q(n2) + ",\"sha1\":" + q(sha(o1)) + ",\"state1\":" + q(rr[0].state)); break;
      }
      // (Names from Content-Disposition: what the engine would name the file.)
      case "names": {
        StringBuilder b = new StringBuilder("\"names\":["); String[] ks = { "rtl", "slash", "long", "con", "dot", "dotdot", "bidi", "nul" };
        for (int k = 0; k < ks.length; k++) { File o = new File(d, ks[k] + ".part"); Run r = fetch("/f/names?k=" + ks[k], o, new File(d, ks[k] + ".state"), 1, new AtomicBoolean(), null);
          String nm = r.res.fileName == null ? null : KrDownloader.cleanName(r.res.fileName); b.append(k > 0 ? "," : "").append("{\"k\":").append(q(ks[k])).append(",\"raw\":").append(q(r.res.fileName)).append(",\"clean\":").append(q(nm)).append(",\"bytes\":").append(nm == null ? -1 : nm.getBytes("UTF-8").length).append(",\"state\":").append(q(r.state)).append("}"); }
        Run r = new Run(); r.state = "done"; print(c, r, b.append("]").toString()); break;
      }
      // (The folder cannot be written — a path through a file —, and a disk that is full: the engine's reason.)
      case "nofolder": { File f = new File(d, "afile"); f.createNewFile(); File o = new File(f, "x.bin.part"); Run r = fetch("/f/ok", o, new File(d, "nf.state"), 4, new AtomicBoolean(), null); r.out = new File(d, "zz"); print(c, r, null); break; }
      // (A full disk: the file the engine writes to runs out of room after 1 MB and says what the system says then — the
      // same on every machine, root or not; a 1 MB tmpfs answered «no access» on a runner whose mount was not its own.)
      case "full": { final long room = 1L << 20;
        KrDownloader.testWriters = (f) -> new RandomAccessFile(f, "rw") {
          private void need(long n) throws IOException { if (getFilePointer() + n > room) throw new IOException("No space left on device"); }
          @Override public void write(int b) throws IOException { need(1); super.write(b); }
          @Override public void write(byte[] b) throws IOException { need(b.length); super.write(b); }
          @Override public void write(byte[] b, int off, int len) throws IOException { need(len); super.write(b, off, len); } };
        try { File o = new File(d, "full.bin.part"); Run r = fetch("/f/ok", o, new File(d, "full.state"), 4, new AtomicBoolean(), null); print(c, r, null); o.delete(); new File(d, "full.state").delete(); }
        finally { KrDownloader.testWriters = null; } break; }
      // (No server at all — offline —, then back.)
      case "offline": { Run r = new Run(); long t0 = System.currentTimeMillis(); AtomicLong got = new AtomicLong(); KrDownloader.Result res = new KrDownloader.Result(); r.res = res; r.out = out;
        Thread back = new Thread(() -> { try { Thread.sleep(2500); ctl("offline", "online"); } catch (Exception ignored) {} }); ctl("offline", "offline"); back.start();
        try { KrDownloader.Opts o = new KrDownloader.Opts(); o.state = st; KrDownloader.fetch(new URL(base + "/f/offline"), out, 4, OP, new AtomicBoolean(), got, res, () -> { if (rAt(res) > 0) { r.retryWhy = rWhy(res); r.maxRetryWait = Math.max(r.maxRetryWait, rAt(res) - System.currentTimeMillis()); } }, o); r.state = "done"; } catch (Throwable e) { r.state = "failed"; r.error = reason(e); }
        back.join(); r.got = got.get(); r.total = res.total; r.ms = System.currentTimeMillis() - t0; print(c, r, null); break; }
      default: System.out.println("WALK {\"case\":" + q(c) + ",\"state\":\"unknown\"}");
    }
  }
}
