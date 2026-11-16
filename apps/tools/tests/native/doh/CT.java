import com.sun.net.httpserver.HttpServer;
import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.atomic.*;

/** The DoH chain on the phone (0.21 P9), against loopback resolvers with made-up names — never a real one:
 *  doh-cases.txt's lines (the order, the user's address, trackers, magnets, the addresses kept, local names) as
 *  kt-core's dohchain.rs reads them; the wire forms (POST, GET, JSON); every resolver reached by its bootstrap
 *  address (the system's lookup never asked); hostile answers; failover; the no-silent-fallback rule and the
 *  opt-in; the cache; the probe's auto pick; UDP trackers through the chain; no thread left behind. */
public class CT {
  static int fails = 0; static void ok(String w, boolean c) { System.out.println((c ? "ok   " : "FAIL ") + w); if (!c) fails++; }
  static final Map<String, AtomicInteger> hits = new HashMap<>(); static final List<String> seen = Collections.synchronizedList(new ArrayList<>());
  static int port;

  static byte[] b64urlDecode(String s) { return Base64.getUrlDecoder().decode(s); }
  /** The answer a mock resolver in `mode` gives to `q`. */
  static byte[] answer(String mode, byte[] q) throws IOException {
    ByteArrayOutputStream b = new ByteArrayOutputStream(); int id = ((q[0] & 0xff) << 8) | (q[1] & 0xff); if (mode.equals("badid")) id = (id + 1) & 0xffff;
    int flags = 0x8180; if (mode.equals("trunc")) flags |= 0x0200; if (mode.equals("nx")) flags |= 3;
    String[] qn = KrDoh.questionOf(q); int qtype = Integer.parseInt(qn[1]);
    List<byte[]> recs = new ArrayList<>();
    byte[] ptr = { (byte) 0xc0, 12 };
    if (mode.equals("loop")) { recs.add(rec(ptr, 5, 60, wire("b.test"))); recs.add(rec(wire("b.test"), 5, 60, wire(qn[0]))); }
    else if (!mode.equals("nx") && qtype == 1) {
      byte[] ip = qn[0].startsWith("resolver-") ? new byte[] { 127, 0, 0, 1 } : mode.equals("private") ? new byte[] { 10, 0, 0, 5 } : mode.startsWith("zero") ? new byte[] { 0, 0, 0, 0 } : new byte[] { (byte) 203, 0, 113, (byte) (5 + mode.length()) };
      if (mode.equals("cname")) { recs.add(rec(ptr, 5, 300, wire("cdn.test"))); recs.add(rec(wire("cdn.test"), 1, 5, ip)); } else recs.add(rec(ptr, 1, 120, ip));
    }
    b.write(id >> 8); b.write(id); b.write(flags >> 8); b.write(flags); b.write(0); b.write(1); b.write(0); b.write(recs.size()); b.write(new byte[4]); b.write(q, 12, q.length - 12);
    for (byte[] r : recs) b.write(r);
    if (mode.equals("big")) b.write(new byte[70000]);
    return b.toByteArray();
  }
  static byte[] wire(String n) { ByteArrayOutputStream b = new ByteArrayOutputStream(); for (String l : n.split("\\.")) { b.write(l.length()); b.write(l.getBytes(), 0, l.length()); } b.write(0); return b.toByteArray(); }
  static byte[] rec(byte[] owner, int type, int ttl, byte[] data) { ByteArrayOutputStream b = new ByteArrayOutputStream(); b.write(owner, 0, owner.length); b.write(0); b.write(type); b.write(0); b.write(1); b.write(ttl >> 24); b.write(ttl >> 16); b.write(ttl >> 8); b.write(ttl); b.write(data.length >> 8); b.write(data.length); b.write(data, 0, data.length); return b.toByteArray(); }

  static KrDoh.Resolver mock(String mode) { return new KrDoh.Resolver(mode, mode, "http://resolver-" + mode + ".test:" + port + "/" + mode + "/dns-query", new String[] { "127.0.0.1" }, mode.equals("json") || mode.equals("ok"), mode.equals("zero") ? "ads" : "none"); }
  static String kindOf(String e) { String[][] k = { { "id", "(id)" }, { "question", "another question" }, { "trunc", "truncated" }, { "notanswer", "not a DNS answer" }, { "server", "(code" }, { "loop", "loop" }, { "toomany", "too many" }, { "short", "cut short" }, { "pointer", "points at itself" }, { "size", "wrong size" } }; for (String[] x : k) if (e.contains(x[1])) return x[0]; return "other"; }
  static String canon(String ip) { try { return InetAddress.getByName(ip).getHostAddress(); } catch (Exception e) { return ip; } }
  static int hit(String mode) { AtomicInteger a = hits.get(mode); return a == null ? 0 : a.get(); }
  static void reset(KrDoh.Resolver... rs) { for (KrDoh.Resolver r : rs) { r.lastAt = 0; r.lastOk = false; r.lastMs = -1; r.shape = ""; } }

  static String follow(String url, String method, String body, boolean creds) throws IOException {
    HttpURLConnection c = KrDoh.openFollowing(new URL(url)); c.setRequestMethod(method); c.setConnectTimeout(3000); c.setReadTimeout(3000);
    if (creds) { c.setRequestProperty("Authorization", "Bearer x"); c.setRequestProperty("Cookie", "c=1"); }
    if (body != null) { c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded"); try (OutputStream o = c.getOutputStream()) { o.write(body.getBytes("UTF-8")); } }
    int code = c.getResponseCode(); String t = new String(c.getInputStream().readAllBytes(), "UTF-8"); c.disconnect(); return code == 200 ? t : "HTTP " + code;
  }
  static String followErr(String url) { try { return "no error: " + follow(url, "GET", null, false); } catch (IOException e) { return String.valueOf(e.getMessage()); } }
  public static void main(String[] a) throws Exception {
    // ---------- doh-cases.txt ----------
    List<String> lines = Files.readAllLines(Paths.get(a[0])); int n = 0;
    long now = System.currentTimeMillis();
    for (String l : lines) {
      if (l.startsWith("#") || l.isEmpty()) continue; String[] f = l.split("\\|", -1);
      switch (f[0]) {
        case "order": {
          KrDoh.table = KrDoh.KNOWN; for (KrDoh.Resolver r : KrDoh.KNOWN) { r.lastAt = 0; r.lastOk = false; r.lastMs = -1; }
          for (String part : f[2].split(",")) { if (part.isEmpty()) continue; String[] kv = part.split("="); KrDoh.Resolver r = null; for (KrDoh.Resolver k : KrDoh.KNOWN) if (k.id.equals(kv[0])) r = k; if (kv[1].startsWith("ok:")) { r.lastOk = true; r.lastMs = Long.parseLong(kv[1].substring(3)); r.lastAt = now; } else { r.lastOk = false; r.lastAt = kv[1].equals("fail") ? now : now - KrDoh.FAIL_FORGET_MS - 60000; } }
          StringBuilder got = new StringBuilder(); for (KrDoh.Resolver r : KrDoh.resolvers(f[1])) got.append(got.length() > 0 ? "," : "").append(r.id);
          ok("order " + f[1] + " " + f[2] + (got.toString().equals(f[3]) ? "" : " → " + got), got.toString().equals(f[3])); n++; break; }
        case "custom": { String got = KrDoh.validateCustom(f[1]); ok("custom " + f[1] + (got.equals(f[2]) ? "" : " → " + got), got.equals(f[2])); n++; break; }
        case "tracker": { String got = KrDoh.trackerRewrite(f[1], f[2]); if (got == null) got = "-"; ok("tracker " + f[1] + (got.equals(f[3]) ? "" : " → " + got), got.equals(f[3])); n++; break; }
        case "magnet": { Map<String, String> m = new HashMap<>(); for (String kv : f[2].split(",")) if (!kv.isEmpty()) m.put(kv.substring(0, kv.indexOf('=')), kv.substring(kv.indexOf('=') + 1)); String got = KrDoh.magnetRewrite(f[1], m::get); ok("magnet " + f[1].substring(0, 40) + "… " + (got.equals(f[3]) ? "" : " → " + got), got.equals(f[3])); n++; break; }
        case "addr": { boolean got = KrDoh.addressOk(InetAddress.getByName(f[1]), f[2].equals("custom")); ok("addr " + f[1] + " " + f[2], (got ? "kept" : "dropped").equals(f[3])); n++; break; }
        case "local": { ok("local " + f[1], KrDoh.isLocalName(f[1]) == f[2].equals("yes")); n++; break; }
        case "probe": { KrDoh.table = KrDoh.KNOWN; StringBuilder got = new StringBuilder(); for (KrDoh.Resolver r : KrDoh.probeSet(f[1], f[2].equals("all"))) got.append(got.length() > 0 ? "," : "").append(r.id); ok("probe " + f[1] + " " + f[2] + (got.toString().equals(f[3]) ? "" : " → " + got), got.toString().equals(f[3])); n++; break; }
        case "wire": {
          byte[] m = new byte[f[5].length() / 2]; for (int i = 0; i < m.length; i++) m[i] = (byte) Integer.parseInt(f[5].substring(2 * i, 2 * i + 2), 16);
          String got; try { long[] ttl = { 0 }; InetAddress[] ips = KrDoh.parseStrict(m, f[2], Integer.parseInt(f[3]), Integer.parseInt(f[4]), ttl); StringBuilder b = new StringBuilder(); for (InetAddress x : ips) b.append(b.length() > 0 ? "," : "").append(x.getHostAddress()); got = "ok:" + b + ":" + (ips.length == 0 ? 0 : ttl[0]); }
          catch (UnknownHostException e) { got = "err:nx"; } catch (IOException e) { got = "err:" + kindOf(String.valueOf(e.getMessage())); }
          String want = f[6]; if (want.startsWith("ok:")) { int c = want.lastIndexOf(':'); String[] ips = want.substring(3, c).split(","); StringBuilder b = new StringBuilder(); for (String x : ips) if (!x.isEmpty()) b.append(b.length() > 0 ? "," : "").append(canon(x)); want = "ok:" + b + want.substring(c); }
          ok("wire " + f[1] + (got.equals(want) ? "" : " → " + got + " (want " + want + ")"), got.equals(want)); n++; break; }
        default: ok("a known kind of line: " + f[0], false);
      }
    }
    ok("cases read: " + n, n >= 100);

    // ---------- the loopback resolvers ----------
    HttpServer srv = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 16);
    for (String mode : new String[] { "ok", "fail", "badid", "trunc", "big", "loop", "private", "nx", "slow", "cname", "json", "zero", "zeroU" }) {
      hits.put(mode, new AtomicInteger());
      srv.createContext("/" + mode + "/", ex -> {
        try {
          hits.get(mode).incrementAndGet(); String path = ex.getRequestURI().getPath(); String host = ex.getRequestHeaders().getFirst("Host");
          seen.add(mode + " " + ex.getRequestMethod() + " " + (path.endsWith("/resolve") ? "json" : ex.getRequestURI().getQuery() != null && ex.getRequestURI().getQuery().startsWith("dns=") ? "get" : "post") + " " + host + " " + ex.getRequestHeaders().getFirst("Content-Type") + " " + ex.getRequestHeaders().getFirst("Accept"));
          if (mode.equals("slow")) Thread.sleep(400);
          if (mode.equals("fail")) { ex.sendResponseHeaders(500, -1); ex.close(); return; }
          byte[] body; String type = "application/dns-message";
          if (path.endsWith("/resolve")) { Map<String, String> qs = new HashMap<>(); for (String kv : ex.getRequestURI().getQuery().split("&")) qs.put(kv.split("=")[0], URLDecoder.decode(kv.split("=")[1], "UTF-8")); body = ("{\"Status\":0,\"Answer\":[{\"name\":\"" + qs.get("name") + "\",\"type\":1,\"TTL\":77,\"data\":\"203.0.113.77\"}]}").getBytes(); type = "application/dns-json"; }
          else { byte[] q = ex.getRequestMethod().equals("GET") ? b64urlDecode(ex.getRequestURI().getQuery().substring(4)) : ex.getRequestBody().readAllBytes(); body = answer(mode, q); }
          ex.getResponseHeaders().set("Content-Type", type); ex.sendResponseHeaders(200, body.length); ex.getResponseBody().write(body); ex.close();
        } catch (Exception e) { e.printStackTrace(); ex.close(); }
      });
    }
    // (Redirects: /r/same → /r/final; /r/other307 and /r/other303 → another host's /r/echo; /r/loop → itself; /r/n/<k> → /r/n/<k+1>; /r/ftp → ftp://.)
    srv.createContext("/r/", ex -> {
      try {
        String path = ex.getRequestURI().getPath(); int p0 = ex.getLocalAddress().getPort(); String loc = null; int code = 302;
        if (path.equals("/r/same")) loc = "/r/final";
        else if (path.equals("/r/other307")) { code = 307; loc = "http://resolver-b.test:" + p0 + "/r/echo"; }
        else if (path.equals("/r/other303")) { code = 303; loc = "http://resolver-b.test:" + p0 + "/r/echo"; }
        else if (path.equals("/r/loop")) loc = "/r/loop";
        else if (path.startsWith("/r/n/")) loc = "/r/n/" + (Integer.parseInt(path.substring(5)) + 1);
        else if (path.equals("/r/ftp")) loc = "ftp://resolver-b.test/file";
        if (loc != null) { ex.getResponseHeaders().set("Location", loc); ex.sendResponseHeaders(code, -1); ex.close(); return; }
        byte[] in = ex.getRequestBody().readAllBytes();
        String out = path + "|" + ex.getRequestMethod() + "|" + ex.getRequestHeaders().getFirst("Host") + "|auth=" + ex.getRequestHeaders().getFirst("Authorization") + "|cookie=" + ex.getRequestHeaders().getFirst("Cookie") + "|body=" + new String(in, "UTF-8");
        byte[] b = out.getBytes("UTF-8"); ex.sendResponseHeaders(200, b.length); ex.getResponseBody().write(b); ex.close();
      } catch (Exception e) { e.printStackTrace(); ex.close(); }
    });
    srv.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());   // (each request on its own thread: a slow resolver holds none of the others back)
    srv.start(); port = srv.getAddress().getPort();
    KrDoh.lastProbeAt = System.currentTimeMillis();   // (the automatic probe later, on its own)
    final AtomicInteger sysCalls = new AtomicInteger(); KrDoh.sys = h -> { sysCalls.incrementAndGet(); return new InetAddress[] { InetAddress.getByName("198.51.100.99") }; };

    // The wire forms, each by the bootstrap address (the made-up name kept in Host).
    KrDoh.Resolver okr = mock("ok"); KrDoh.table = new KrDoh.Resolver[] { okr };
    for (String shape : new String[] { "post", "get", "json" }) {
      seen.clear(); okr.shape = shape; KrDoh.Answer an = KrDoh.askResolver(okr, KrDoh.query("site.test", 1), 4000);
      String s0 = seen.isEmpty() ? "" : seen.get(0);
      ok("shape " + shape + ": answered (" + s0 + ")", an.ips.length == 1 && an.shape.equals(shape) && s0.startsWith("ok " + (shape.equals("post") ? "POST post" : "GET " + shape) + " resolver-ok.test:" + port));
      if (shape.equals("post")) ok("POST: application/dns-message both ways", s0.endsWith("application/dns-message application/dns-message"));
      if (shape.equals("json")) ok("JSON: the answer read (TTL 77)", an.ips[0].getHostAddress().equals("203.0.113.77") && an.ttl == 77);
    }
    ok("the system's lookup never asked for the resolver", sysCalls.get() == 0);

    // Hostile answers: each refused, the resolver failing with the reason.
    for (String mode : new String[] { "badid", "trunc", "big", "loop" }) {
      KrDoh.Resolver r = mock(mode); r.shape = "post"; String why = "";
      try { KrDoh.askResolver(r, KrDoh.query("site.test", 1), 3000); } catch (IOException e) { why = String.valueOf(e.getMessage()); }
      ok("hostile " + mode + " refused: " + why, !why.isEmpty() && !r.lastOk && r.lastAt > 0);
    }
    { KrDoh.Resolver r = mock("cname"); r.shape = "post"; KrDoh.Answer an = KrDoh.askResolver(r, KrDoh.query("site.test", 1), 3000); ok("a CNAME chain followed (TTL the least)", an.ips.length == 1 && an.ttl == 5); }

    // Failover in order: the failing ones noted, the private «public» answer dropped, the healthy one used.
    KrDoh.provider = "auto"; KrDoh.allowSystem = false; KrDoh.forget();
    KrDoh.Resolver[] chain = { mock("fail"), mock("badid"), mock("private"), mock("ok") }; reset(chain); KrDoh.table = chain;
    InetAddress[] got = KrDoh.resolve("site.test");
    ok("failover: the healthy one answered", got.length == 1 && got[0].getHostAddress().startsWith("203.0.113."));
    ok("failover: the failing ones noted; the private answer passed over, its resolver not marked failing", !chain[0].lastOk && !chain[1].lastOk && chain[2].lastOk && chain[3].lastOk);
    String via = KrDoh.usedFor(Arrays.asList("site.test")).optJSONObject("hosts").get("site.test").toString();
    ok("per-use: which one answered (" + via + ")", via.contains("doh:ok:"));
    { List<KrDoh.Resolver> o2 = KrDoh.resolvers("auto"); ok("auto now asks the healthy ones first, the failing last (" + o2.get(0).id + ")", (o2.get(0).id.equals("ok") || o2.get(0).id.equals("private")) && o2.get(3).id.matches("fail|badid") && o2.get(2).id.matches("fail|badid")); }
    int before = hit("ok"); KrDoh.resolve("SITE.test"); ok("cached: not asked again", hit("ok") == before && KrDoh.usedFor(Arrays.asList("site.test")).toString().contains("cache:ok"));
    // A name that does not exist: no other resolver asked; kept briefly.
    KrDoh.forget(); KrDoh.Resolver[] nx = { mock("nx"), mock("ok") }; reset(nx); KrDoh.table = nx; int okb = hit("ok");
    boolean nxThrown = false; try { KrDoh.resolve("none.test"); } catch (UnknownHostException e) { nxThrown = true; }
    ok("no such name: an answer, the next resolver not asked", nxThrown && hit("ok") == okb);
    // Every resolver failed: no silent fall-back…
    KrDoh.forget(); KrDoh.Resolver[] dead = { mock("fail"), mock("trunc") }; reset(dead); KrDoh.table = dead; sysCalls.set(0); String msg = "";
    try { KrDoh.resolve("down.test"); } catch (IOException e) { msg = e.getMessage(); }
    ok("all failed, system not allowed: an error that says so", msg.contains("not allowed") && sysCalls.get() == 0 && KrDoh.usedFor(Arrays.asList("down.test")).toString().contains("failed"));
    ok("…and no plain retry either", !KrDoh.systemOk("down.test", "test") && !KrDoh.goDirect("down.test") && !KrDoh.isDirect("down.test"));
    // …unless allowed, and then said.
    KrDoh.allowSystem = true; got = KrDoh.resolve("down.test");
    ok("allowed: the system's answer, marked «system»", got[0].getHostAddress().equals("198.51.100.99") && sysCalls.get() == 1 && KrDoh.usedFor(Arrays.asList("down.test")).toString().contains("system"));
    KrDoh.allowSystem = false;
    // Local names: the system's, by rule.
    KrDoh.resolve("printer.local"); ok("a local name: the system's lookup, marked «local»", KrDoh.usedFor(Arrays.asList("printer.local")).toString().contains("local"));

    // The cache's caps.
    for (int i = 0; i < 600; i++) KrDoh.cachePut("x|n" + i + ".test", new InetAddress[] { InetAddress.getByName("203.0.113.1") }, 60 + i, "ok");
    ok("cache capped at 512", KrDoh.cacheSize() == 512);

    // The probe: every resolver at once, the quickest healthy first afterwards.
    KrDoh.forget(); KrDoh.Resolver[] pr = { mock("slow"), mock("fail"), mock("ok") }; reset(pr); KrDoh.table = pr; KrDoh.provider = "auto";
    org.json.JSONObject p = KrDoh.probe(); List<KrDoh.Resolver> ord = KrDoh.resolvers("auto");
    ok("probe: best is the quick one", p.optBoolean("ok") && ord.get(0).id.equals("ok") && ord.get(1).id.equals("slow") && ord.get(2).id.equals("fail"));
    ok("probe: each one's time and health shown", KrDoh.status().toString().contains("providers"));
    ok("pinned: the chosen one first even when slower", KrDoh.resolvers("slow").get(0).id.equals("slow"));

    // The user's own resolver: its name found through the public ones, never the system's lookup.
    KrDoh.forget(); KrDoh.Resolver[] pub = { mock("ok") }; reset(pub); KrDoh.table = pub; sysCalls.set(0);
    KrDoh.provider = "http://127.0.0.1:" + port + "/ok/dns-query"; ok("on this device: asked alone", KrDoh.resolvers(KrDoh.provider).size() == 1);
    KrDoh.Resolver mine = new KrDoh.Resolver("custom", "http://resolver-mine.test:" + port + "/ok/dns-query"); String[] boot = KrDoh.bootstrap(mine);
    ok("custom bootstrap: through the chain (" + String.join(",", boot) + ")", boot.length == 1 && boot[0].equals("127.0.0.1") && sysCalls.get() == 0);

    // UDP trackers through the chain.
    KrDoh.provider = "auto"; KrDoh.forget(); reset(pub);
    List<String> tr = KrDoh.trackersViaDoh(Arrays.asList("udp://tracker.test:1337/announce", "http://web.test/announce", "udp://203.0.113.9:80"), 4000);
    ok("trackers: the UDP one by address, the others as they were (" + tr + ")", tr.get(0).matches("udp://203\\.0\\.113\\.\\d+:1337/announce") && tr.get(1).equals("http://web.test/announce") && tr.get(2).equals("udp://203.0.113.9:80"));
    ok("trackers: the original name kept for the swarm page", KrDoh.trackerOrigin.get(tr.get(0))[0].equals("udp://tracker.test:1337/announce") && KrDoh.trackerOrigin.get(tr.get(0))[1].startsWith("doh:ok"));

    // The automatic probe: due when nothing is known, run once on a plain thread when a name is asked — no timer.
    KrDoh.forget(); reset(pub); KrDoh.lastProbeAt = 0; int probesBefore = hit("ok"); KrDoh.resolve("again.test");
    for (int i = 0; i < 50 && KrDoh.lastProbeAt == 0; i++) Thread.sleep(100);
    ok("the probe ran by itself once a name was asked", KrDoh.lastProbeAt > 0 && hit("ok") >= probesBefore + 2);
    long lp = KrDoh.lastProbeAt; KrDoh.resolve("again2.test"); Thread.sleep(200); ok("…and not again within the half hour", KrDoh.lastProbeAt == lp);

    // A filtering resolver's 0.0.0.0: blocked by it — an answer: the next one not asked, its health untouched.
    KrDoh.provider = "auto"; KrDoh.forget(); KrDoh.Resolver[] flt = { mock("zero"), mock("ok") }; reset(flt); KrDoh.table = flt; int okz = hit("ok"); String bmsg = "";
    try { InetAddress[] z = KrDoh.resolve("ads.test"); bmsg = "resolved " + z[0] + " " + KrDoh.usedFor(Arrays.asList("ads.test")); } catch (UnknownHostException e) { bmsg = e.getMessage(); } catch (IOException e) { bmsg = "io " + e.getMessage(); }
    ok("filtered 0.0.0.0: «blocked by» it, the next not asked, still healthy (" + bmsg + ")", bmsg.contains("blocked by zero") && hit("ok") == okz && flt[0].lastOk && KrDoh.usedFor(Arrays.asList("ads.test")).toString().contains("blocked:zero"));
    // An unfiltered resolver's 0.0.0.0 / private answer for a public name: the next one asked («private»).
    KrDoh.forget(); KrDoh.Resolver[] unf = { mock("zeroU"), mock("ok") }; reset(unf); KrDoh.table = unf;
    ok("unfiltered 0.0.0.0: the next one asked", KrDoh.resolve("lan.test")[0].getHostAddress().startsWith("203.0.113."));
    // A blackholed resolver: the lookup ends at its deadline, whatever the shapes, addresses and AAAA retries.
    ServerSocket hole = new ServerSocket(0, 50, InetAddress.getLoopbackAddress()); List<Socket> held = Collections.synchronizedList(new ArrayList<>());
    Thread ht = new Thread(() -> { try { while (!hole.isClosed()) held.add(hole.accept()); } catch (IOException ignored) {} }); ht.setDaemon(true); ht.start();
    KrDoh.Resolver bh = new KrDoh.Resolver("hole", "hole", "http://resolver-hole.test:" + hole.getLocalPort() + "/dns-query", new String[] { "127.0.0.1", "127.0.0.1" }, false, "none");
    KrDoh.forget(); reset(bh); KrDoh.table = new KrDoh.Resolver[] { bh }; KrDoh.chainDeadlineMs = 1500; long tb = System.currentTimeMillis(); String hmsg = "";
    try { KrDoh.resolve("slow.test"); } catch (IOException e) { hmsg = e.getMessage(); }
    long took = System.currentTimeMillis() - tb; ok("blackhole: the lookup ends at its deadline (" + took + " ms)", took < 2600 && !hmsg.isEmpty());
    KrDoh.chainDeadlineMs = 20000; hole.close(); for (Socket x : held) try { x.close(); } catch (IOException ignored) {}
    // UDP trackers no resolver answers: left out, listed — never a name for the engine.
    KrDoh.forget(); KrDoh.Resolver[] nxr = { mock("nx") }; reset(nxr); KrDoh.table = nxr; KrDoh.droppedTrackers.clear();
    List<String> tr2 = KrDoh.trackersViaDoh(Arrays.asList("udp://gone.test:80/announce", "https://web.test/a"), 3000);
    ok("an unanswered UDP tracker is left out and listed", tr2.equals(Arrays.asList("https://web.test/a")) && KrDoh.droppedTrackers.contains("udp://gone.test:80/announce"));
    // The JSON form: a record of another name, and an address that is not written as one, both left out (never looked up).
    byte[] q7 = KrDoh.withId(KrDoh.query("site.test", 1), 77);
    long[] t7 = { 0 }; InetAddress[] j7 = KrDoh.parseStrict(KrDoh.fromJson("{\"Status\":0,\"Answer\":[{\"name\":\"other.test\",\"type\":1,\"TTL\":5,\"data\":\"203.0.113.9\"},{\"name\":\"site.test\",\"type\":1,\"TTL\":5,\"data\":\"attacker.test\"}]}", q7), "site.test", 1, 77, t7);
    ok("JSON: another name's record and a non-address left out", j7.length == 0);
    InetAddress[] j8 = KrDoh.parseStrict(KrDoh.fromJson("{\"Status\":0,\"Answer\":[{\"name\":\"site.test.\",\"type\":5,\"TTL\":50,\"data\":\"cdn.test.\"},{\"name\":\"cdn.test.\",\"type\":1,\"TTL\":7,\"data\":\"203.0.113.10\"}]}", q7), "site.test", 1, 77, t7);
    ok("JSON: a CNAME chain followed", j8.length == 1 && j8[0].getHostAddress().equals("203.0.113.10") && t7[0] == 7);
    // A single label: this network's name — the system's lookup, by rule.
    KrDoh.forget(); KrDoh.table = pub; KrDoh.resolve("router"); ok("a single label: never a public resolver", KrDoh.usedFor(Arrays.asList("router")).toString().contains("local"));

    // Redirects followed through the chain (openFollowing): each hop's host found by DoH again.
    KrDoh.forget(); KrDoh.table = pub; KrDoh.provider = "http://127.0.0.1:" + port + "/ok/dns-query"; KrDoh.allowSystem = false; sysCalls.set(0);
    String base = "http://resolver-a.test:" + port;
    String r1 = follow(base + "/r/same", "GET", null, true);
    ok("redirect, same host: followed, Authorization and Cookie kept (" + r1 + ")", r1.startsWith("/r/final|GET|resolver-a.test:") && r1.contains("auth=Bearer x") && r1.contains("cookie=c=1"));
    String r2 = follow(base + "/r/other307", "POST", "data=1", true);
    ok("redirect 307 to another host: POST and body kept, Authorization and Cookie dropped (" + r2 + ")", r2.startsWith("/r/echo|POST|resolver-b.test:") && r2.contains("auth=null") && r2.contains("cookie=null") && r2.endsWith("body=data=1"));
    String r3 = follow(base + "/r/other303", "POST", "data=1", false);
    ok("redirect 303: GET without the body (" + r3 + ")", r3.startsWith("/r/echo|GET|") && r3.endsWith("body="));
    ok("each hop's host asked of the resolver, never the system", KrDoh.usedFor(Arrays.asList("resolver-b.test")).toString().matches(".*via=(doh|cache):custom.*") && sysCalls.get() == 0);
    ok("a redirect loop refused", followErr(base + "/r/loop").contains("loop"));
    ok("more than five hops refused", followErr(base + "/r/n/0").contains("too many"));
    ok("a redirect to a non-http address refused", followErr(base + "/r/ftp").contains("non-http"));
    KrDoh.Following fl = (KrDoh.Following) KrDoh.openFollowing(new URL(base + "/r/same")); fl.getResponseCode(); ok("the final address reported", fl.getURL().getPath().equals("/r/final"));
    KrDoh.provider = "off"; ok("DoH off: the plain connection (it follows by itself)", !(KrDoh.openFollowing(new URL(base + "/r/same")) instanceof KrDoh.Following));
    KrDoh.provider = "auto";

    // No thread of ours left behind.
    srv.stop(0); Thread.sleep(300); int left = 0; for (Thread t : Thread.getAllStackTraces().keySet()) if (t.getName().startsWith("kt-doh") && t.isAlive()) { left++; System.out.println("left: " + t.getName()); }
    ok("no DoH thread left running", left == 0);
    KrDoh.provider = "off"; KrDoh.table = KrDoh.KNOWN;
    System.out.println(fails == 0 ? "chain: all passed" : fails + " failed"); System.exit(fails == 0 ? 0 : 1);
  }
}
