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
      byte[] ip = qn[0].startsWith("resolver-") ? new byte[] { 127, 0, 0, 1 } : mode.equals("private") ? new byte[] { 10, 0, 0, 5 } : new byte[] { (byte) 203, 0, 113, (byte) (5 + mode.length()) };
      if (mode.equals("cname")) { recs.add(rec(ptr, 5, 300, wire("cdn.test"))); recs.add(rec(wire("cdn.test"), 1, 5, ip)); } else recs.add(rec(ptr, 1, 120, ip));
    }
    b.write(id >> 8); b.write(id); b.write(flags >> 8); b.write(flags); b.write(0); b.write(1); b.write(0); b.write(recs.size()); b.write(new byte[4]); b.write(q, 12, q.length - 12);
    for (byte[] r : recs) b.write(r);
    if (mode.equals("big")) b.write(new byte[70000]);
    return b.toByteArray();
  }
  static byte[] wire(String n) { ByteArrayOutputStream b = new ByteArrayOutputStream(); for (String l : n.split("\\.")) { b.write(l.length()); b.write(l.getBytes(), 0, l.length()); } b.write(0); return b.toByteArray(); }
  static byte[] rec(byte[] owner, int type, int ttl, byte[] data) { ByteArrayOutputStream b = new ByteArrayOutputStream(); b.write(owner, 0, owner.length); b.write(0); b.write(type); b.write(0); b.write(1); b.write(ttl >> 24); b.write(ttl >> 16); b.write(ttl >> 8); b.write(ttl); b.write(data.length >> 8); b.write(data.length); b.write(data, 0, data.length); return b.toByteArray(); }

  static KrDoh.Resolver mock(String mode) { return new KrDoh.Resolver(mode, mode, "http://resolver-" + mode + ".test:" + port + "/" + mode + "/dns-query", new String[] { "127.0.0.1" }, mode.equals("json") || mode.equals("ok"), "none"); }
  static int hit(String mode) { AtomicInteger a = hits.get(mode); return a == null ? 0 : a.get(); }
  static void reset(KrDoh.Resolver... rs) { for (KrDoh.Resolver r : rs) { r.lastAt = 0; r.lastOk = false; r.lastMs = -1; r.shape = ""; } }

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
        default: ok("a known kind of line: " + f[0], false);
      }
    }
    ok("cases read: " + n, n >= 60);

    // ---------- the loopback resolvers ----------
    HttpServer srv = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 16);
    for (String mode : new String[] { "ok", "fail", "badid", "trunc", "big", "loop", "private", "nx", "slow", "cname", "json" }) {
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
    ok("failover: the others failing, private refused as «blocked»", !chain[0].lastOk && !chain[1].lastOk && !chain[2].lastOk && "blocked".equals(chain[2].lastError) && chain[3].lastOk);
    String via = KrDoh.usedFor(Arrays.asList("site.test")).optJSONObject("hosts").get("site.test").toString();
    ok("per-use: which one answered (" + via + ")", via.contains("doh:ok:"));
    ok("auto now asks the healthy one first", KrDoh.resolvers("auto").get(0).id.equals("ok"));
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

    // No thread of ours left behind.
    srv.stop(0); Thread.sleep(300); int left = 0; for (Thread t : Thread.getAllStackTraces().keySet()) if (t.getName().startsWith("kt-doh") && t.isAlive()) { left++; System.out.println("left: " + t.getName()); }
    ok("no DoH thread left running", left == 0);
    KrDoh.provider = "off"; KrDoh.table = KrDoh.KNOWN;
    System.out.println(fails == 0 ? "chain: all passed" : fails + " failed"); System.exit(fails == 0 ? 0 : 1);
  }
}
