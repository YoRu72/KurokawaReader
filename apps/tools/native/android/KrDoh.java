package app.kurokawa.tools;

import java.io.ByteArrayOutputStream;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.Socket;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * DNS over HTTPS for the app's own requests (the downloads, the sources' requests, the pages of its browser),
 * as 1DM+ offers it: a site's name asked of a resolver over HTTPS instead of the network's DNS — a site a
 * provider hides by its name is reached all the same.
 *
 * Made to keep working on a network that fights back:
 *  - several resolvers (Cloudflare, Google, Quad9, AdGuard, Mullvad, DNS.SB, ControlD, OpenDNS, or one the reader
 *    gives), the chosen one first and the others after it when it does not answer; the one that answered last is
 *    asked first next time ("auto" lets the app choose);
 *  - each resolver asked by its own address (no DNS at all), in several shapes — a POST with the question in it,
 *    the same with the TLS hello split in two (a filter reading the server's name in the first packet sees none),
 *    a GET, the address alone without the name in the hello (the resolvers whose certificates carry their
 *    addresses), and the JSON form by name as a last resort — the shape that worked remembered per resolver;
 *  - the connection to the site made to the address found, the site's name kept in the Host header, the TLS
 *    handshake (SNI) and the certificate's check; the hello split for a site the network hides (or always, as
 *    the reader chooses), so a filter that reads names out of hellos lets it through;
 *  - a site the browser could not reach by the network's own way forced through the resolver (see force).
 * Plain Java (no Android classes), so it is tested on its own.
 */
final class KrDoh {
    private KrDoh() {}

    /** "off", "auto", a provider's name, or the address of a resolver ("https://…/dns-query"). */
    static volatile String provider = "off";
    /** The TLS hello split in two: "auto" (for sites the network hides, and for the resolver when it did not answer whole), "always", "off". */
    static volatile String split = "auto";

    static boolean on() { String p = provider; return p != null && !p.isEmpty() && !"off".equals(p); }

    /* ---------- what is going on, for the reader to see: counters, the last events, a listener ---------- */
    interface Listener { void on(String json); }
    static volatile Listener listener;
    static final java.util.concurrent.atomic.AtomicLong queries = new java.util.concurrent.atomic.AtomicLong(), hits = new java.util.concurrent.atomic.AtomicLong(), fails = new java.util.concurrent.atomic.AtomicLong(), unblocked = new java.util.concurrent.atomic.AtomicLong();
    static volatile String lastResolver = "", lastError = "", lastShape = ""; static volatile long lastMs = -1, lastAt = 0;
    /** «off», «idle» (on, nothing asked yet), «resolving», «ok» (the resolver answered), «failed» (the last ask failed). */
    static volatile String state = "off";
    private static final java.util.ArrayDeque<String> log = new java.util.ArrayDeque<>();
    static void note(String kind, String host, String ip, long ms, String msg) {
        String j;
        try { org.json.JSONObject o = new org.json.JSONObject(); o.put("at", System.currentTimeMillis()); o.put("kind", kind); if (host != null) o.put("host", host); if (ip != null) o.put("ip", ip); if (ms >= 0) o.put("ms", ms); if (msg != null) o.put("msg", msg); o.put("state", state); j = o.toString(); } catch (Exception e) { return; }
        synchronized (log) { log.addLast(j); while (log.size() > 80) log.removeFirst(); }
        Listener l = listener; if (l != null) try { l.on(j); } catch (Throwable ignored) {}
    }
    /** Everything the page shows: the state, the counters, the last events, the resolvers and how each fared. */
    static org.json.JSONObject status() {
        org.json.JSONObject o = new org.json.JSONObject();
        try {
            if (!on()) state = "off"; else if ("off".equals(state)) state = "idle";
            o.put("provider", provider); o.put("split", split); o.put("state", state); o.put("queries", queries.get()); o.put("hits", hits.get()); o.put("fails", fails.get()); o.put("unblocked", unblocked.get());
            o.put("lastResolver", lastResolver); o.put("lastShape", lastShape); o.put("lastMs", lastMs); o.put("lastAt", lastAt); o.put("lastError", lastError); o.put("cached", cache.size()); o.put("forced", forced.size());
            org.json.JSONArray rs = new org.json.JSONArray(); for (Resolver r : resolvers(provider)) { org.json.JSONObject x = new org.json.JSONObject(); x.put("id", r.id); x.put("url", r.url); x.put("ok", r.lastOk); x.put("ms", r.lastMs); x.put("shape", r.shape); x.put("error", r.lastError == null ? "" : r.lastError); rs.put(x); } o.put("resolvers", rs);
            org.json.JSONArray a = new org.json.JSONArray(); synchronized (log) { for (String j : log) a.put(new org.json.JSONObject(j)); } o.put("log", a);
        } catch (Exception ignored) {}
        return o;
    }
    /** Every resolver tried on purpose, at once (a known name asked of each): which answer, from which address, by which shape, in how long; the fastest kept first. */
    static org.json.JSONObject probe() {
        org.json.JSONObject o = new org.json.JSONObject();
        try {
            if (!on()) { o.put("ok", false); o.put("why", "off"); return o; }
            List<Resolver> rs = resolvers(provider); if (rs.isEmpty()) { o.put("ok", false); o.put("why", "noResolver"); return o; }
            state = "resolving"; note("probe", "example.com", null, -1, "start");
            final org.json.JSONArray tries = new org.json.JSONArray(); List<Thread> ts = new ArrayList<>();
            for (final Resolver r : rs) {
                Thread t = new Thread(() -> {
                    org.json.JSONObject tr = new org.json.JSONObject(); long t0 = System.currentTimeMillis();
                    try { tr.put("resolver", r.id); tr.put("url", r.url); Answer a = askResolver(r, query("example.com", 1), 9000); tr.put("ok", a.ips.length > 0); tr.put("ms", System.currentTimeMillis() - t0); tr.put("from", a.from); tr.put("shape", a.shape); }
                    catch (Exception e) { try { tr.put("ok", false); tr.put("ms", System.currentTimeMillis() - t0); tr.put("error", clean(e.getMessage())); } catch (Exception ignored) {} }
                    synchronized (tries) { tries.put(tr); }
                }, "kt-doh-probe"); t.setDaemon(true); ts.add(t); t.start();
            }
            for (Thread t : ts) t.join(12000);
            org.json.JSONObject best = null;
            synchronized (tries) { for (int i = 0; i < tries.length(); i++) { org.json.JSONObject tr = tries.getJSONObject(i); if (tr.optBoolean("ok") && (best == null || tr.optLong("ms") < best.optLong("ms"))) best = tr; } }
            o.put("tries", tries); o.put("ok", best != null);
            if (best != null) { o.put("resolver", best.optString("from", best.optString("resolver"))); o.put("ms", best.optLong("ms")); o.put("shape", best.optString("shape")); state = "ok"; lastResolver = o.optString("resolver"); lastShape = best.optString("shape"); lastMs = best.optLong("ms"); lastAt = System.currentTimeMillis(); lastError = ""; preferred = best.optString("resolver"); }
            else { state = "failed"; lastError = tries.length() > 0 ? tries.getJSONObject(0).optString("error") : "no answer"; }
            note("probe", "example.com", best != null ? lastResolver : null, best != null ? best.optLong("ms") : -1, best != null ? "ok" : "failed");
        } catch (Exception e) { try { o.put("ok", false); o.put("why", String.valueOf(e.getMessage())); } catch (Exception ignored) {} }
        return o;
    }

    /* ---------- the resolvers ---------- */
    static final class Resolver {
        final String id, url; final String[] ips;
        /** Whether it answers the JSON form (Cloudflare's, Google's, AdGuard's, DNS.SB's do; Quad9 and ControlD do not). */
        boolean json() { return id.equals("cloudflare") || id.equals("google") || id.equals("adguard") || id.equals("dnssb") || id.equals("custom"); }
        /** How it was last reached: the shape that worked (asked first next time). */
        volatile String shape = ""; volatile boolean lastOk; volatile long lastMs = -1; volatile String lastError;
        Resolver(String id, String url, String... ips) { this.id = id; this.url = url; this.ips = ips; }
    }
    private static final Resolver[] KNOWN = {
        new Resolver("cloudflare", "https://cloudflare-dns.com/dns-query", "1.1.1.1", "1.0.0.1"),
        new Resolver("google", "https://dns.google/dns-query", "8.8.8.8", "8.8.4.4"),
        new Resolver("quad9", "https://dns.quad9.net/dns-query", "9.9.9.9", "149.112.112.112"),
        new Resolver("adguard", "https://dns.adguard-dns.com/dns-query", "94.140.14.14", "94.140.15.15"),
        new Resolver("mullvad", "https://dns.mullvad.net/dns-query", "194.242.2.2"),
        new Resolver("dnssb", "https://doh.dns.sb/dns-query", "185.222.222.222", "45.11.45.11"),
        new Resolver("controld", "https://freedns.controld.com/p0", "76.76.2.0", "76.76.10.0"),
        new Resolver("opendns", "https://doh.opendns.com/dns-query", "208.67.222.222", "208.67.220.220"),
    };
    private static final Map<String, Resolver> custom = new ConcurrentHashMap<>();
    /** The one that answered last: asked first. */
    static volatile String preferred = "";
    /** The resolvers for `p`, in the order to try them: the chosen (or the last that answered) first, the rest after it. */
    static List<Resolver> resolvers(String p) {
        List<Resolver> out = new ArrayList<>();
        if (p == null || p.isEmpty() || "off".equals(p)) return out;
        Resolver chosen = null;
        if (p.startsWith("https://")) { chosen = custom.get(p); if (chosen == null) { chosen = new Resolver("custom", p); custom.put(p, chosen); } }
        else if (!"auto".equals(p)) for (Resolver r : KNOWN) if (r.id.equals(p)) chosen = r;
        if (chosen != null) out.add(chosen);
        String pref = preferred;
        if (!pref.isEmpty()) for (Resolver r : KNOWN) if (r.id.equals(pref) && !out.contains(r)) out.add(r);
        for (Resolver r : KNOWN) if (!out.contains(r)) out.add(r);
        return out;
    }

    private static final class Entry { final InetAddress[] ips; final long until; Entry(InetAddress[] ips, long until) { this.ips = ips; this.until = until; } }
    private static final Map<String, Entry> cache = new ConcurrentHashMap<>();
    static void forget() { cache.clear(); neededAt.clear(); forced.clear(); state = on() ? "idle" : "off"; lastResolver = ""; lastError = ""; lastShape = ""; lastMs = -1; }

    /** The addresses of `host`, asked of the resolvers (kept for their time to live, at least a minute). */
    static InetAddress[] resolve(String host) throws IOException {
        if (isLiteral(host)) return new InetAddress[] { InetAddress.getByName(host) };
        String p = provider; String key = p + "|" + host.toLowerCase();
        Entry e = cache.get(key);
        if (e != null && e.until > System.currentTimeMillis()) { hits.incrementAndGet(); return e.ips; }
        List<Resolver> rs = resolvers(p);
        if (rs.isEmpty()) return InetAddress.getAllByName(host);
        byte[] query = query(host, 1);
        IOException last = null; queries.incrementAndGet(); state = "resolving"; long t0 = System.currentTimeMillis();
        long deadline = t0 + 25000;
        for (Resolver r : rs) {
            if (System.currentTimeMillis() > deadline) break;
            try {
                long[] ttl = { 300 };
                Answer a = askResolver(r, query, (int) Math.max(3000, Math.min(9000, deadline - System.currentTimeMillis())));
                InetAddress[] ips = a.ips; ttl[0] = a.ttl;
                if (ips.length == 0) { Answer b = askResolver(r, query(host, 28), 6000); ips = b.ips; ttl[0] = b.ttl; }   // (no IPv4 address: its IPv6 ones)
                if (ips.length == 0) throw new java.net.UnknownHostException(host);
                cache.put(key, new Entry(ips, System.currentTimeMillis() + Math.max(60, Math.min(3600, ttl[0])) * 1000));
                long ms = System.currentTimeMillis() - t0; state = "ok"; lastResolver = a.from; lastShape = a.shape; lastMs = ms; lastAt = System.currentTimeMillis(); lastError = ""; preferred = r.id;
                note("resolve", host, ips[0].getHostAddress(), ms, r.id + " " + a.shape);
                return ips;
            } catch (IOException ex) { last = ex; note("retry", host, r.id, -1, String.valueOf(ex.getMessage())); }
        }
        fails.incrementAndGet(); state = "failed"; lastError = last != null ? clean(last.getMessage()) : "unknown host"; lastAt = System.currentTimeMillis();
        note("fail", host, null, System.currentTimeMillis() - t0, lastError);
        throw last != null ? last : new java.net.UnknownHostException(host);
    }

    /** What a resolver answered: the addresses, their time to live, the address it answered from and the shape that got through. */
    static final class Answer { final InetAddress[] ips; final long ttl; final String from, shape; Answer(InetAddress[] ips, long ttl, String from, String shape) { this.ips = ips; this.ttl = ttl; this.from = from; this.shape = shape; } }
    /** The shapes a question takes, in the order tried (the one that last worked first): see the class note. */
    static final String[] SHAPES = { "post", "post-split", "get", "post-noname", "json" };
    /** `r` asked `q` by each of its addresses and each shape until one answers; what worked is kept with it. */
    static Answer askResolver(Resolver r, byte[] q, int timeoutMs) throws IOException {
        URL u = new URL(r.url); IOException last = null; long t0 = System.currentTimeMillis();
        List<String> shapes = new ArrayList<>(); if (!r.shape.isEmpty()) shapes.add(r.shape); for (String s : SHAPES) if (!shapes.contains(s)) shapes.add(s);
        String[] by = r.ips.length > 0 ? r.ips : new String[] { null };
        for (String shape : shapes) {
            // (The JSON form goes by the resolver's name alone; the others by each of its addresses — by name when none is known.)
            if (shape.equals("json") && !r.json()) continue;
            String[] over = shape.equals("json") ? new String[] { null } : by;
            for (String ip : over) {
                if (ip == null && (shape.equals("post-split") || shape.equals("post-noname"))) continue;
                try {
                    byte[] m = shape.equals("json") ? askJson(u, q, timeoutMs) : ask(u, ip, q, shape, timeoutMs);
                    long[] ttl = { 300 }; InetAddress[] ips = parse(m, ttl);
                    r.shape = shape; r.lastOk = true; r.lastMs = System.currentTimeMillis() - t0; r.lastError = null;
                    return new Answer(ips, ttl[0], ip != null ? ip : u.getHost(), shape);
                } catch (java.net.UnknownHostException nx) { r.lastOk = true; r.lastMs = System.currentTimeMillis() - t0; r.shape = shape; throw nx; }   // (the resolver answered: the name is no site's)
                catch (IOException e) { last = e; }
            }
        }
        r.lastOk = false; r.lastMs = System.currentTimeMillis() - t0; r.lastError = last == null ? "no answer" : clean(last.getMessage());
        throw last != null ? last : new IOException("no answer");
    }

    /* ---------- the sites: whether a site needs the resolver, and the ones forced through it ---------- */
    /** For the web views: whether `host` needs the resolver at all — the network's DNS gives it no address, or
     *  one that is no site's (0.0.0.0, the device itself, a home network's), or addresses none of which the
     *  resolver gives (a provider's page put in the site's place), or it was forced (the browser could not
     *  reach it the network's way). A site the network's DNS gives as it is is left to the web view's own
     *  requests: a site's check (Cloudflare) wants the browser's own connection. Kept ten minutes a name. */
    private static final Map<String, long[]> neededAt = new ConcurrentHashMap<>();
    private static final Map<String, Long> forced = new ConcurrentHashMap<>();
    /** `host` (and its subdomains) sent through the resolver for an hour whatever the network's DNS says: the browser
     *  could not reach it the network's way (a reset, a timeout, a handshake refused — a filter reading names). */
    static void force(String host) {
        if (host == null || host.isEmpty()) return;
        String h = host.toLowerCase(); forced.put(h, System.currentTimeMillis() + 3600_000L);
        for (String k : neededAt.keySet()) if (k.endsWith("|" + h) || k.endsWith("." + h)) neededAt.remove(k);
        unblocked.incrementAndGet(); note("force", host, null, -1, "unreachable");
    }
    static boolean isForced(String host) {
        if (host == null) return false; String h = host.toLowerCase(); long now = System.currentTimeMillis();
        for (Map.Entry<String, Long> e : forced.entrySet()) { if (e.getValue() < now) { forced.remove(e.getKey()); continue; } if (h.equals(e.getKey()) || h.endsWith("." + e.getKey())) return true; }
        return false;
    }
    /** What `needed` last found for `host`, when it looked within ten minutes; null when it has not (no network here). */
    static Boolean neededCached(String host) { if (!on() || host == null) return null; if (isForced(host)) return true; long[] had = neededAt.get(provider + "|" + host.toLowerCase()); return had == null || had[0] <= System.currentTimeMillis() ? null : had[1] == 1; }
    static boolean needed(String host) {
        if (!on() || isLiteral(host)) return false;
        if (isForced(host)) return true;
        String key = provider + "|" + host.toLowerCase();
        long[] had = neededAt.get(key);
        if (had != null && had[0] > System.currentTimeMillis()) return had[1] == 1;
        boolean need;
        InetAddress[] sys;
        try { sys = InetAddress.getAllByName(host); } catch (IOException e) { sys = new InetAddress[0]; }
        boolean usable = false;
        for (InetAddress a : sys) if (!(a.isAnyLocalAddress() || a.isLoopbackAddress() || a.isSiteLocalAddress() || a.isLinkLocalAddress())) usable = true;
        if (!usable) need = true;
        else {
            try {
                InetAddress[] doh = resolve(host);
                java.util.Set<String> mine = new java.util.HashSet<>();
                for (InetAddress a : doh) mine.add(a.getHostAddress());
                boolean shared = false;
                for (InetAddress a : sys) if (mine.contains(a.getHostAddress())) shared = true;
                // (Addresses that differ but lie in the same network — a CDN answering each resolver its own — are
                // the site's all the same.)
                if (!shared) for (InetAddress a : sys) for (InetAddress b : doh) if (sameNet(a, b)) shared = true;
                need = !shared;
            } catch (IOException e) { need = false; }
        }
        neededAt.put(key, new long[] { System.currentTimeMillis() + 600_000L, need ? 1 : 0 });
        if (need) unblocked.incrementAndGet();
        note(need ? "unblock" : "direct", host, null, -1, need ? (usable ? "hidden" : "noAnswer") : null);
        return need;
    }
    private static boolean sameNet(InetAddress a, InetAddress b) {
        byte[] x = a.getAddress(), y = b.getAddress();
        if (x.length != y.length) return false;
        int n = x.length == 4 ? 2 : 4;   // (a /16 of IPv4, a /32 of IPv6)
        for (int i = 0; i < n; i++) if (x[i] != y[i]) return false;
        return true;
    }

    /** An error's words fit to show: printable, one line, short. */
    static String clean(String m) { if (m == null) return "error"; String t = m.replaceAll("[^\\p{Print}\\p{L}\\p{N} ]+", " ").replaceAll("\\s+", " ").trim(); return t.length() > 90 ? t.substring(0, 90) + "…" : t; }
    private static boolean isLiteral(String host) { return host.matches("\\d+\\.\\d+\\.\\d+\\.\\d+") || host.contains(":"); }

    /** A DNS question (RFC 1035) for `host`, record type 1 (A) or 28 (AAAA), id 0 as RFC 8484 asks. */
    static byte[] query(String host, int type) {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        b.write(0); b.write(0); b.write(1); b.write(0); // id 0, recursion desired
        b.write(0); b.write(1); b.write(0); b.write(0); b.write(0); b.write(0); b.write(0); b.write(0); // 1 question
        for (String label : host.split("\\.")) { if (label.isEmpty()) continue; byte[] l = label.getBytes(java.nio.charset.StandardCharsets.US_ASCII); b.write(l.length); b.write(l, 0, l.length); }
        b.write(0); b.write(0); b.write(type); b.write(0); b.write(1);
        return b.toByteArray();
    }
    /** The name and type asked in a question (for the JSON form). */
    static String[] questionOf(byte[] q) {
        StringBuilder name = new StringBuilder(); int p = 12;
        while (p < q.length) { int l = q[p] & 0xff; if (l == 0) { p++; break; } if (name.length() > 0) name.append('.'); name.append(new String(q, p + 1, l, java.nio.charset.StandardCharsets.US_ASCII)); p += l + 1; }
        int type = p + 1 < q.length ? ((q[p] & 0xff) << 8) | (q[p + 1] & 0xff) : 1;
        return new String[] { name.toString(), String.valueOf(type) };
    }

    /** The A / AAAA records of a DNS answer; `ttl[0]` the least time to live among them. */
    static InetAddress[] parse(byte[] m, long[] ttl) throws IOException {
        if (m.length < 12) throw new IOException("DNS answer too short");
        int rcode = m[3] & 0x0f; if (rcode == 3) throw new java.net.UnknownHostException("NXDOMAIN");
        int qd = u16(m, 4), an = u16(m, 6);
        int p = 12;
        for (int i = 0; i < qd; i++) { p = skipName(m, p); p += 4; }
        List<InetAddress> out = new ArrayList<>(); long least = Long.MAX_VALUE;
        for (int i = 0; i < an && p + 10 <= m.length; i++) {
            p = skipName(m, p);
            int type = u16(m, p), len = u16(m, p + 8); long t = ((long) u16(m, p + 4) << 16) | u16(m, p + 6);
            p += 10;
            if (p + len > m.length) break;
            if ((type == 1 && len == 4) || (type == 28 && len == 16)) { byte[] a = new byte[len]; System.arraycopy(m, p, a, 0, len); out.add(InetAddress.getByAddress(a)); least = Math.min(least, t); }
            p += len;
        }
        if (least != Long.MAX_VALUE) ttl[0] = least;
        return out.toArray(new InetAddress[0]);
    }
    /** A DNS answer made out of the JSON form's (RFC 8427-ish: {Status, Answer:[{type, TTL, data}]}): the same bytes `parse` reads. */
    static byte[] fromJson(String json) throws IOException {
        org.json.JSONObject o; try { o = new org.json.JSONObject(json); } catch (Exception e) { throw new IOException("DoH JSON: " + e.getMessage()); }
        int status = o.optInt("Status", 0); if (status == 3) throw new java.net.UnknownHostException("NXDOMAIN"); if (status != 0) throw new IOException("DoH JSON status " + status);
        ByteArrayOutputStream b = new ByteArrayOutputStream(); org.json.JSONArray ans = o.optJSONArray("Answer"); int n = 0;
        ByteArrayOutputStream recs = new ByteArrayOutputStream();
        if (ans != null) for (int i = 0; i < ans.length(); i++) {
            org.json.JSONObject a = ans.optJSONObject(i); if (a == null) continue; int type = a.optInt("type", 0); if (type != 1 && type != 28) continue;
            byte[] addr; try { addr = InetAddress.getByName(a.optString("data")).getAddress(); } catch (Exception e) { continue; }
            if ((type == 1 && addr.length != 4) || (type == 28 && addr.length != 16)) continue;
            long ttl = a.optLong("TTL", 300);
            recs.write(0xc0); recs.write(0x0c); recs.write(type >> 8); recs.write(type); recs.write(0); recs.write(1);
            recs.write((int) (ttl >> 24)); recs.write((int) (ttl >> 16)); recs.write((int) (ttl >> 8)); recs.write((int) ttl); recs.write(addr.length >> 8); recs.write(addr.length); recs.write(addr, 0, addr.length); n++;
        }
        b.write(0); b.write(0); b.write(0x81); b.write(0x80); b.write(0); b.write(0); b.write(n >> 8); b.write(n); b.write(0); b.write(0); b.write(0); b.write(0);   // (no question kept: parse skips none)
        byte[] r = recs.toByteArray(); b.write(r, 0, r.length);
        return b.toByteArray();
    }
    private static int u16(byte[] m, int i) { return ((m[i] & 0xff) << 8) | (m[i + 1] & 0xff); }
    private static int skipName(byte[] m, int p) {
        while (p < m.length) { int l = m[p] & 0xff; if (l == 0) return p + 1; if ((l & 0xc0) == 0xc0) return p + 2; p += l + 1; }
        return p;
    }

    /** The question put to the resolver (RFC 8484) by `ip` when given (its name kept for TLS), in `shape`:
     *  "post" (the wire form posted), "post-split" (the same, the TLS hello in two records), "get" (the wire
     *  form base64url in the address), "post-noname" (to the address alone — no name in the hello — for a
     *  resolver whose certificate carries its address). */
    private static byte[] ask(URL resolver, String ip, byte[] q, String shape, int timeoutMs) throws IOException {
        boolean get = shape.equals("get"); boolean noName = shape.equals("post-noname"); boolean frag = shape.equals("post-split");
        URL u = resolver;
        if (get) u = new URL(resolver.toString() + (resolver.getQuery() == null ? "?" : "&") + "dns=" + b64url(q));
        HttpURLConnection c;
        if (ip == null) c = (HttpURLConnection) u.openConnection();
        else if (noName) { if (ip.contains(":")) throw new IOException("no name: IPv6"); c = (HttpURLConnection) new URL(u.getProtocol(), ip, u.getPort(), u.getFile()).openConnection(); c.setRequestProperty("Host", u.getHost()); }
        else c = connectTo(u, ip, frag);
        c.setConnectTimeout(Math.min(8000, timeoutMs)); c.setReadTimeout(timeoutMs); c.setInstanceFollowRedirects(false);
        c.setRequestProperty("Accept", "application/dns-message"); c.setRequestProperty("User-Agent", "KurokawaTools");
        if (!get) { c.setRequestMethod("POST"); c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/dns-message"); c.setFixedLengthStreamingMode(q.length); try (OutputStream os = c.getOutputStream()) { os.write(q); } }
        else c.setRequestMethod("GET");
        int code = c.getResponseCode();
        if (code != 200) { c.disconnect(); throw new IOException("DoH HTTP " + code + " (" + shape + ")"); }
        try (InputStream in = c.getInputStream()) { ByteArrayOutputStream b = new ByteArrayOutputStream(); byte[] buf = new byte[4096]; int n; while ((n = in.read(buf)) > 0) b.write(buf, 0, n); return b.toByteArray(); }
        finally { c.disconnect(); }
    }
    private static final String B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    /** base64url without padding (RFC 4648 §5), as the GET form wants it. */
    static String b64url(byte[] d) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < d.length; i += 3) {
            int n = (d[i] & 0xff) << 16 | (i + 1 < d.length ? (d[i + 1] & 0xff) << 8 : 0) | (i + 2 < d.length ? d[i + 2] & 0xff : 0);
            sb.append(B64.charAt(n >> 18 & 63)).append(B64.charAt(n >> 12 & 63));
            if (i + 1 < d.length) sb.append(B64.charAt(n >> 6 & 63)); if (i + 2 < d.length) sb.append(B64.charAt(n & 63));
        }
        return sb.toString();
    }
    /** The JSON form (Cloudflare's, Google's, AdGuard's…), by the resolver's name: a last resort when the wire form is refused everywhere. */
    private static byte[] askJson(URL resolver, byte[] q, int timeoutMs) throws IOException {
        String[] qn = questionOf(q);
        String base = resolver.toString().replaceAll("/dns-query$", "/resolve"); if (resolver.getHost().contains("cloudflare")) base = resolver.toString();
        URL u = new URL(base + (base.contains("?") ? "&" : "?") + "name=" + java.net.URLEncoder.encode(qn[0], "UTF-8") + "&type=" + qn[1]);
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        c.setConnectTimeout(Math.min(8000, timeoutMs)); c.setReadTimeout(timeoutMs); c.setRequestProperty("Accept", "application/dns-json"); c.setRequestProperty("User-Agent", "KurokawaTools");
        try {
            int code = c.getResponseCode(); if (code != 200) throw new IOException("DoH JSON HTTP " + code);
            try (InputStream in = c.getInputStream()) { ByteArrayOutputStream b = new ByteArrayOutputStream(); byte[] buf = new byte[4096]; int n; while ((n = in.read(buf)) > 0) b.write(buf, 0, n); return fromJson(new String(b.toByteArray(), java.nio.charset.StandardCharsets.UTF_8)); }
        } finally { c.disconnect(); }
    }

    /**
     * A connection to `url` that goes to the address the resolver gives for its host (redirects not followed:
     * the caller follows them, by their own names). With DoH off, the plain connection.
     */
    static HttpURLConnection open(URL url) throws IOException {
        if (!on()) return (HttpURLConnection) url.openConnection();
        InetAddress[] ips = resolve(url.getHost());
        String sp = split; boolean frag = "always".equals(sp) || ("auto".equals(sp) && Boolean.TRUE.equals(neededCached(url.getHost())));
        HttpURLConnection c = connectTo(url, ips[0].getHostAddress(), frag);
        c.setInstanceFollowRedirects(false);
        return c;
    }

    /** `url` asked of `ip`: the name kept in the Host header, the TLS handshake and the certificate's check; the hello split when asked. */
    private static HttpURLConnection connectTo(URL url, String ip, boolean frag) throws IOException {
        final String host = url.getHost();
        String literal = ip.contains(":") ? "[" + ip + "]" : ip;
        URL byIp = new URL(url.getProtocol(), literal, url.getPort(), url.getFile());
        HttpURLConnection c = (HttpURLConnection) byIp.openConnection();
        c.setRequestProperty("Host", url.getPort() > 0 && url.getPort() != url.getDefaultPort() ? host + ":" + url.getPort() : host);
        if (c instanceof HttpsURLConnection) {
            HttpsURLConnection s = (HttpsURLConnection) c;
            s.setSSLSocketFactory(new SniFactory(HttpsURLConnection.getDefaultSSLSocketFactory(), host, frag));
            final HostnameVerifier def = HttpsURLConnection.getDefaultHostnameVerifier();
            s.setHostnameVerifier((String h, SSLSession session) -> def.verify(host, session));
        }
        return c;
    }

    /** TLS sockets that name the site, not the address they were opened to — and, when asked, send the hello in two records. */
    private static final class SniFactory extends SSLSocketFactory {
        private final SSLSocketFactory base; private final String host; private final boolean frag;
        SniFactory(SSLSocketFactory base, String host, boolean frag) { this.base = base; this.host = host; this.frag = frag; }
        @Override public String[] getDefaultCipherSuites() { return base.getDefaultCipherSuites(); }
        @Override public String[] getSupportedCipherSuites() { return base.getSupportedCipherSuites(); }
        @Override public Socket createSocket(Socket s, String h, int port, boolean autoClose) throws IOException { return name(base.createSocket(frag ? new SplitSocket(s, host) : s, host, port, autoClose)); }
        @Override public Socket createSocket(String h, int port) throws IOException { return name(base.createSocket(h, port)); }
        @Override public Socket createSocket(String h, int port, InetAddress local, int localPort) throws IOException { return name(base.createSocket(h, port, local, localPort)); }
        @Override public Socket createSocket(InetAddress a, int port) throws IOException { return name(base.createSocket(a, port)); }
        @Override public Socket createSocket(InetAddress a, int port, InetAddress local, int localPort) throws IOException { return name(base.createSocket(a, port, local, localPort)); }
        @Override public Socket createSocket() throws IOException { return name(base.createSocket()); }
        private Socket name(Socket s) {
            if (s instanceof SSLSocket) {
                try {
                    javax.net.ssl.SSLParameters p = ((SSLSocket) s).getSSLParameters();
                    p.setServerNames(java.util.Collections.singletonList(new javax.net.ssl.SNIHostName(host)));
                    ((SSLSocket) s).setSSLParameters(p);
                } catch (Throwable ignored) { /* (an old Android: the name given to createSocket stands) */ }
            }
            return s;
        }
    }

    /** The TLS hello (the first record written) cut into two records, the cut inside the site's name — a filter
     *  that reads names out of the first packet reads none; the server, as TLS allows, puts the two together. */
    static byte[][] splitHello(byte[] rec, int off, int len, String host) {
        if (len < 6 || rec[off] != 0x16) return null;
        int recLen = ((rec[off + 3] & 0xff) << 8) | (rec[off + 4] & 0xff);
        if (recLen != len - 5 || recLen < 8) return null;   // (more than one record, or not a whole one: left as it is)
        byte[] name = host.getBytes(java.nio.charset.StandardCharsets.US_ASCII); int at = -1;
        outer: for (int i = off + 5; i + name.length <= off + len; i++) { for (int j = 0; j < name.length; j++) if (rec[i + j] != name[j]) continue outer; at = i - (off + 5); break; }
        int cut = at > 0 ? at + Math.max(1, name.length / 2) : recLen / 2;
        if (cut <= 0 || cut >= recLen) cut = recLen / 2;
        byte[] a = new byte[5 + cut], b = new byte[5 + recLen - cut];
        a[0] = b[0] = rec[off]; a[1] = b[1] = rec[off + 1]; a[2] = b[2] = rec[off + 2];
        a[3] = (byte) (cut >> 8); a[4] = (byte) cut; b[3] = (byte) ((recLen - cut) >> 8); b[4] = (byte) (recLen - cut);
        System.arraycopy(rec, off + 5, a, 5, cut); System.arraycopy(rec, off + 5 + cut, b, 5, recLen - cut);
        return new byte[][] { a, b };
    }
    /** A connected socket whose first write (the hello) goes out in two records; everything else as it is. */
    private static final class SplitSocket extends Socket {
        private final Socket in; private final String host; private OutputStream out;
        SplitSocket(Socket in, String host) { this.in = in; this.host = host; try { in.setTcpNoDelay(true); } catch (Exception ignored) {} }
        @Override public synchronized OutputStream getOutputStream() throws IOException {
            if (out == null) out = new FilterOutputStream(in.getOutputStream()) {
                boolean first = true;
                @Override public void write(int b) throws IOException { write(new byte[] { (byte) b }, 0, 1); }
                @Override public void write(byte[] b, int off, int len) throws IOException {
                    if (first) { first = false; byte[][] two = splitHello(b, off, len, host); if (two != null) { super.out.write(two[0]); super.out.flush(); super.out.write(two[1]); super.out.flush(); return; } }
                    super.out.write(b, off, len);
                }
            };
            return out;
        }
        @Override public InputStream getInputStream() throws IOException { return in.getInputStream(); }
        @Override public void connect(java.net.SocketAddress a) throws IOException { in.connect(a); }
        @Override public void connect(java.net.SocketAddress a, int t) throws IOException { in.connect(a, t); }
        @Override public void bind(java.net.SocketAddress a) throws IOException { in.bind(a); }
        @Override public InetAddress getInetAddress() { return in.getInetAddress(); }
        @Override public InetAddress getLocalAddress() { return in.getLocalAddress(); }
        @Override public int getPort() { return in.getPort(); }
        @Override public int getLocalPort() { return in.getLocalPort(); }
        @Override public java.net.SocketAddress getRemoteSocketAddress() { return in.getRemoteSocketAddress(); }
        @Override public java.net.SocketAddress getLocalSocketAddress() { return in.getLocalSocketAddress(); }
        @Override public java.nio.channels.SocketChannel getChannel() { return in.getChannel(); }
        @Override public void setTcpNoDelay(boolean on) throws java.net.SocketException { in.setTcpNoDelay(on); }
        @Override public boolean getTcpNoDelay() throws java.net.SocketException { return in.getTcpNoDelay(); }
        @Override public void setSoLinger(boolean on, int l) throws java.net.SocketException { in.setSoLinger(on, l); }
        @Override public int getSoLinger() throws java.net.SocketException { return in.getSoLinger(); }
        @Override public void sendUrgentData(int d) throws IOException { in.sendUrgentData(d); }
        @Override public void setOOBInline(boolean on) throws java.net.SocketException { in.setOOBInline(on); }
        @Override public boolean getOOBInline() throws java.net.SocketException { return in.getOOBInline(); }
        @Override public synchronized void setSoTimeout(int t) throws java.net.SocketException { in.setSoTimeout(t); }
        @Override public synchronized int getSoTimeout() throws java.net.SocketException { return in.getSoTimeout(); }
        @Override public synchronized void setSendBufferSize(int s) throws java.net.SocketException { in.setSendBufferSize(s); }
        @Override public synchronized int getSendBufferSize() throws java.net.SocketException { return in.getSendBufferSize(); }
        @Override public synchronized void setReceiveBufferSize(int s) throws java.net.SocketException { in.setReceiveBufferSize(s); }
        @Override public synchronized int getReceiveBufferSize() throws java.net.SocketException { return in.getReceiveBufferSize(); }
        @Override public void setKeepAlive(boolean on) throws java.net.SocketException { in.setKeepAlive(on); }
        @Override public boolean getKeepAlive() throws java.net.SocketException { return in.getKeepAlive(); }
        @Override public void setTrafficClass(int tc) throws java.net.SocketException { in.setTrafficClass(tc); }
        @Override public int getTrafficClass() throws java.net.SocketException { return in.getTrafficClass(); }
        @Override public void setReuseAddress(boolean on) throws java.net.SocketException { in.setReuseAddress(on); }
        @Override public boolean getReuseAddress() throws java.net.SocketException { return in.getReuseAddress(); }
        @Override public synchronized void close() throws IOException { in.close(); }
        @Override public void shutdownInput() throws IOException { in.shutdownInput(); }
        @Override public void shutdownOutput() throws IOException { in.shutdownOutput(); }
        @Override public String toString() { return "Split" + in.toString(); }
        @Override public boolean isConnected() { return in.isConnected(); }
        @Override public boolean isBound() { return in.isBound(); }
        @Override public boolean isClosed() { return in.isClosed(); }
        @Override public boolean isInputShutdown() { return in.isInputShutdown(); }
        @Override public boolean isOutputShutdown() { return in.isOutputShutdown(); }
        @Override public void setPerformancePreferences(int a, int b, int c) { in.setPerformancePreferences(a, b, c); }
    }
}
