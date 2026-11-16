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
 *  - several resolvers (core/kt-core/src/doh-providers.txt — the one table — or one the reader gives), the chosen
 *    one first and the others after it when it does not answer; «auto» asks the quickest healthy one first (the health
 *    probe: on demand, and at most every half hour when a name is asked — no timer); the order, the cache, which
 *    answers are kept and the system-DNS rule are kt-core dohchain.rs's, checked on the same lines
 *    (doh-cases.txt) by tests/native/doh/CT.java (0.21 P9);
 *  - the network's DNS never asked for a site's name unless the reader allowed it (`allowSystem`) and every resolver
 *    failed — and then the event and the per-name record say so; names of this device or its network (.local, .lan…)
 *    are the system's by rule;
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
    /** The reader's choice: the system's DNS when every resolver failed (off by default — a privacy trade-off). */
    static volatile boolean allowSystem = false;
    /** The app's browser's own choice, apart from the app's (Settings): it reaches the browser's pages only, through
     *  KtDohWeb — the app's requests and the app's page never see it. */
    static volatile String browserProvider = "off";
    private static final ThreadLocal<Boolean> inBrowser = new ThreadLocal<>();
    /** The choice in force for this thread: the browser's inside `browser(…)`, the app's elsewhere. */
    static String prov() { return Boolean.TRUE.equals(inBrowser.get()) ? browserProvider : provider; }
    interface Work<T> { T run() throws Exception; }
    /** `w` done under the browser's own choice (its resolver, its forced sites). */
    static <T> T browser(Work<T> w) throws Exception { Boolean was = inBrowser.get(); inBrowser.set(true); try { return w.run(); } finally { if (was == null) inBrowser.remove(); else inBrowser.set(was); } }
    static boolean browserOn() { String p = browserProvider; return p != null && !p.isEmpty() && !"off".equals(p); }
    /** The TLS hello split in two: "auto" (for sites the network hides, and for the resolver when it did not answer whole), "always", "off". */
    static volatile String split = "auto";

    static boolean on() { String p = prov(); return p != null && !p.isEmpty() && !"off".equals(p); }

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
            o.put("provider", prov()); o.put("split", split); o.put("state", state); o.put("ways", waysJson()); o.put("queries", queries.get()); o.put("hits", hits.get()); o.put("fails", fails.get()); o.put("unblocked", unblocked.get());
            o.put("lastResolver", lastResolver); o.put("lastShape", lastShape); o.put("lastMs", lastMs); o.put("lastAt", lastAt); o.put("lastError", lastError); o.put("cached", cache.size()); o.put("forced", forced.size());
            org.json.JSONArray rs = new org.json.JSONArray(); org.json.JSONArray ord = new org.json.JSONArray(); for (Resolver r : resolvers(prov())) { ord.put(r.id); org.json.JSONObject x = new org.json.JSONObject(); x.put("id", r.id); x.put("url", r.url); x.put("ok", r.lastOk); x.put("ms", r.lastMs); x.put("shape", r.shape); x.put("error", r.lastError == null ? "" : r.lastError); rs.put(x); } o.put("resolvers", rs); o.put("order", ord);
            // (The shared status shape — Electron's and Tauri's too: every provider of the table with its health.)
            org.json.JSONArray ps = new org.json.JSONArray(); for (Resolver r : table) { org.json.JSONObject x = new org.json.JSONObject(); x.put("id", r.id); x.put("label", r.label); x.put("url", r.url); x.put("filters", r.filters); if (r.lastAt > 0) { x.put("ok", r.lastOk); x.put("ms", r.lastMs); x.put("at", r.lastAt); } x.put("reason", r.lastError == null ? "" : r.lastError); ps.put(x); } o.put("providers", ps);
            Resolver cu = prov().contains("://") ? custom.get(prov()) : null; if (cu != null && cu.lastAt > 0) { org.json.JSONObject x = new org.json.JSONObject(); x.put("ok", cu.lastOk); x.put("ms", cu.lastMs); x.put("at", cu.lastAt); x.put("reason", cu.lastError == null ? "" : cu.lastError); o.put("custom", x); }
            o.put("on", on()); o.put("allowSystem", allowSystem); o.put("system", systemUsed.get()); if (lastProbeAt > 0) o.put("lastProbe", lastProbeAt);
            org.json.JSONArray a = new org.json.JSONArray(); synchronized (log) { for (String j : log) a.put(new org.json.JSONObject(j)); } o.put("log", a);
        } catch (Exception ignored) {}
        return o;
    }
    /** Every resolver tried on purpose, at once (a known name asked of each): which answer, from which address, by which shape, in how long; the fastest kept first. */
    static org.json.JSONObject probe() { return probe(true); }
    /** `all`: every resolver («Check now»); else those the chain asks first (probeSet). */
    static org.json.JSONObject probe(boolean all) {
        org.json.JSONObject o = new org.json.JSONObject();
        try {
            if (!on()) { o.put("ok", false); o.put("why", "off"); return o; }
            List<Resolver> rs = probeSet(prov(), all); if (rs.isEmpty()) { o.put("ok", false); o.put("why", "noResolver"); return o; }
            state = "resolving"; note("probe", "example.com", null, -1, "start");
            final org.json.JSONArray tries = new org.json.JSONArray(); List<Thread> ts = new ArrayList<>();
            for (final Resolver r : rs) {
                Thread t = new Thread(() -> {
                    org.json.JSONObject tr = new org.json.JSONObject(); long t0 = System.currentTimeMillis();
                    try { tr.put("resolver", r.id); tr.put("url", r.url); Answer a = askResolver(r, query("example.com", 1), 5000); boolean ok = false; for (InetAddress x : a.ips) if (addressOk(x, "custom".equals(r.id))) ok = true; if (!ok) health(r, false, System.currentTimeMillis() - t0, "no usable address"); tr.put("ok", ok); tr.put("ms", System.currentTimeMillis() - t0); tr.put("from", a.from); tr.put("shape", a.shape); }
                    catch (Exception e) { try { tr.put("ok", false); tr.put("ms", System.currentTimeMillis() - t0); tr.put("error", clean(e.getMessage())); } catch (Exception ignored) {} }
                    synchronized (tries) { tries.put(tr); }
                }, "kt-doh-probe"); t.setDaemon(true); ts.add(t); t.start();
            }
            for (Thread t : ts) t.join(12000);
            lastProbeAt = System.currentTimeMillis(); chainFailed = false;
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
        final String id, url, label, filters; final String[] ips; final boolean json;
        /** Whether it documents the JSON form (Cloudflare's and Google's). */
        boolean json() { return json; }
        /** How it was last reached: the shape that worked (asked first next time). */
        volatile String shape = ""; volatile boolean lastOk; volatile long lastMs = -1; volatile String lastError; volatile long lastAt = 0;
        Resolver(String id, String label, String url, String[] ips, boolean json, String filters) { this.id = id; this.label = label; this.url = url; this.ips = ips; this.json = json; this.filters = filters; }
        Resolver(String id, String url, String... ips) { this(id, id, url, ips, false, "none"); }
    }
    /** core/kt-core/src/doh-providers.txt, field by field (tests/dohchain.cjs checks the copy). */
    static final Resolver[] KNOWN = {
        new Resolver("cloudflare", "Cloudflare", "https://cloudflare-dns.com/dns-query", new String[] { "1.1.1.1", "1.0.0.1", "2606:4700:4700::1111", "2606:4700:4700::1001" }, true, "none"),
        new Resolver("google", "Google", "https://dns.google/dns-query", new String[] { "8.8.8.8", "8.8.4.4", "2001:4860:4860::8888", "2001:4860:4860::8844" }, true, "none"),
        new Resolver("quad9", "Quad9", "https://dns.quad9.net/dns-query", new String[] { "9.9.9.9", "149.112.112.112", "2620:fe::fe", "2620:fe::9" }, false, "malware"),
        new Resolver("adguard", "AdGuard", "https://dns.adguard-dns.com/dns-query", new String[] { "94.140.14.14", "94.140.15.15", "2a10:50c0::ad1:ff", "2a10:50c0::ad2:ff" }, false, "ads"),
        new Resolver("adguard-unfiltered", "AdGuard (unfiltered)", "https://unfiltered.adguard-dns.com/dns-query", new String[] { "94.140.14.140", "94.140.14.141", "2a10:50c0::1:ff", "2a10:50c0::2:ff" }, false, "none"),
        new Resolver("dnssb", "DNS.SB", "https://185.222.222.222/dns-query", new String[] { "185.222.222.222" }, false, "none"),
        new Resolver("controld", "Control D", "https://freedns.controld.com/p0", new String[] { "76.76.2.0", "76.76.10.0", "2606:1a40::", "2606:1a40:1::" }, false, "none"),
        new Resolver("wikimedia", "Wikimedia DNS", "https://wikimedia-dns.org/dns-query", new String[] { "185.71.138.138", "2001:67c:930::1" }, false, "none"),
        new Resolver("dns4eu", "DNS4EU", "https://unfiltered.joindns4.eu/dns-query", new String[] { "86.54.11.100", "86.54.11.200", "2a13:1001::86:54:11:100", "2a13:1001::86:54:11:200" }, false, "legal"),
    };
    /** The table in use (tests put loopback resolvers here; the app never changes it). */
    static volatile Resolver[] table = KNOWN;
    /** The system's own lookup (tests count its calls; the app's is InetAddress's). */
    interface SysDns { InetAddress[] lookup(String host) throws IOException; }
    static volatile SysDns sys = InetAddress::getAllByName;
    static final long FAIL_FORGET_MS = 600_000L, PROBE_EVERY_MS = 1_800_000L, TTL_MIN_S = 30, TTL_MAX_S = 3600, NEG_TTL_S = 30; static final int CACHE_MAX = 512;
    private static final Map<String, Resolver> custom = new ConcurrentHashMap<>();
    /** (Kept for the old status field: the one that answered last.) */
    static volatile String preferred = "";
    static String hostOf(String url) { try { String h = new URL(url).getHost(); if (h.startsWith("[")) h = h.substring(1, h.length() - 1); return h.toLowerCase(java.util.Locale.ROOT); } catch (Exception e) { return ""; } }
    /** A resolver on this device (plain http to 127.0.0.1, localhost, ::1): asked alone. */
    static boolean onDevice(String url) { if (url == null || !url.trim().toLowerCase(java.util.Locale.ROOT).startsWith("http://")) return false; String h = hostOf(url.trim()); return h.equals("127.0.0.1") || h.equals("localhost") || h.equals("::1"); }
    /** The user's own address checked (dohchain.rs validate_custom): "ok" or why not. */
    static String validateCustom(String url) {
        String u = url == null ? "" : url.trim(); if (u.length() > 512) return "tooLong";
        for (int i = 0; i < u.length(); i++) { char c = u.charAt(i); if (Character.isWhitespace(c) || c < 0x20 || c == 0x7f) return "space"; }
        String lower = u.toLowerCase(java.util.Locale.ROOT), rest;
        if (lower.startsWith("https://")) rest = lower.substring(8);
        else if (lower.startsWith("http://")) { String h = authHost(lower.substring(7)); if (!(h.equals("127.0.0.1") || h.equals("localhost") || h.equals("::1"))) return "notHttps"; rest = lower.substring(7); }
        else return "notHttps";
        int end = rest.length(); for (char c : new char[] { '/', '?', '#' }) { int i = rest.indexOf(c); if (i >= 0 && i < end) end = i; }
        String auth = rest.substring(0, end), path = rest.substring(end);
        if (auth.contains("@")) return "userinfo";
        String host, port = null;
        if (auth.startsWith("[")) { int i = auth.indexOf(']'); if (i < 0) return "noHost"; host = auth.substring(1, i); String after = auth.substring(i + 1); if (after.startsWith(":")) port = after.substring(1); }
        else { int i = auth.indexOf(':'); host = i < 0 ? auth : auth.substring(0, i); if (i >= 0) port = auth.substring(i + 1); }
        if (host.isEmpty()) return "noHost";
        if (port != null) { if (!port.matches("\\d{1,5}") || Integer.parseInt(port) < 1 || Integer.parseInt(port) > 65535) return "badPort"; }
        if (path.contains("#") || !path.startsWith("/") || path.equals("/") || path.startsWith("/?")) return "badPath";
        return "ok";
    }
    private static String authHost(String rest) { int end = rest.length(); for (char c : new char[] { '/', '?', '#' }) { int i = rest.indexOf(c); if (i >= 0 && i < end) end = i; } String a = rest.substring(0, end); a = a.substring(a.lastIndexOf('@') + 1); if (a.startsWith("[")) { int i = a.indexOf(']'); return i < 0 ? "" : a.substring(1, i); } int i = a.indexOf(':'); return i < 0 ? a : a.substring(0, i); }
    private static Resolver known(String id) { for (Resolver r : table) if (r.id.equals(id)) return r; return null; }
    /** The resolvers for `p`, in the order to try them (dohchain.rs order): the chosen one first («custom»: alone when
     *  on this device), then the rest — the healthy ones quickest first, the ones not checked (or whose failure is old)
     *  in the table's order, the ones that failed lately last. «mullvad» (discontinued) is «auto»; an unknown name, off. */
    static List<Resolver> resolvers(String p) {
        List<Resolver> out = new ArrayList<>();
        if (p == null) return out; p = p.trim(); if (p.isEmpty() || "off".equals(p)) return out;
        Resolver chosen = null;
        if (p.contains("://")) { if (!"ok".equals(validateCustom(p))) return out; chosen = custom.get(p); if (chosen == null) { chosen = new Resolver("custom", p); custom.put(p, chosen); } if (onDevice(p)) { out.add(chosen); return out; } }
        else if (!"auto".equals(p) && !"mullvad".equals(p) && !"opendns".equals(p)) { chosen = known(p); if (chosen == null) return out; }
        if (chosen != null) out.add(chosen);
        final long now = System.currentTimeMillis();
        final List<Resolver> tab = java.util.Arrays.asList(table);
        List<Resolver> rest = new ArrayList<>(); for (Resolver r : tab) if (r != chosen) rest.add(r);
        java.util.Collections.sort(rest, (x, y) -> { int a = rank(x, now), b = rank(y, now); if (a != b) return a - b; if (a == 0 && x.lastMs != y.lastMs) return Long.compare(x.lastMs, y.lastMs); return tab.indexOf(x) - tab.indexOf(y); });
        out.addAll(rest); return out;
    }
    private static int rank(Resolver r, long now) { if (r.lastAt == 0) return 1; if (r.lastOk) return 0; return now - r.lastAt < FAIL_FORGET_MS ? 2 : 1; }
    /** Its health noted (by the chain's questions and the probe). */
    static void health(Resolver r, boolean ok, long ms, String why) { r.lastOk = ok; r.lastMs = ms; r.lastAt = System.currentTimeMillis(); r.lastError = ok ? null : why; }

    /** Names of this device or its network: the system's own lookup, by rule (never sent to a public resolver). */
    static boolean isLocalName(String name) { String n = name.toLowerCase(java.util.Locale.ROOT); if (n.endsWith(".")) n = n.substring(0, n.length() - 1); return (!n.isEmpty() && !n.contains(".")) || n.equals("localhost") || n.endsWith(".localhost") || n.endsWith(".local") || n.endsWith(".home.arpa") || n.endsWith(".lan") || n.endsWith(".internal"); }
    /** An answered address worth connecting to (dohchain.rs address_ok): never the unspecified, this device, link-local,
     *  multicast or broadcast; from a public resolver not a private network's (a filter's «blocked», or a rebinding). */
    static boolean addressOk(InetAddress a, boolean fromCustom) {
        byte[] b = a.getAddress();
        if (b.length == 16) { boolean mapped = true; for (int i = 0; i < 10; i++) if (b[i] != 0) mapped = false; if (mapped && (b[10] & 0xff) == 0xff && (b[11] & 0xff) == 0xff) { try { return addressOk(InetAddress.getByAddress(java.util.Arrays.copyOfRange(b, 12, 16)), fromCustom); } catch (Exception e) { return false; } } }
        if (a.isAnyLocalAddress() || a.isLinkLocalAddress() || a.isMulticastAddress()) return false;
        if (a.isLoopbackAddress()) return fromCustom;   // (the user's own resolver may name this device)
        if (b.length == 4) { int o0 = b[0] & 0xff, o1 = b[1] & 0xff; if (o0 == 0 || o0 >= 240) return false; boolean priv = o0 == 10 || (o0 == 172 && o1 >= 16 && o1 <= 31) || (o0 == 192 && o1 == 168) || (o0 == 100 && o1 >= 64 && o1 <= 127) || (o0 == 198 && (o1 == 18 || o1 == 19)); return fromCustom || !priv; }
        // (An IPv6 form that carries an IPv4 address — IPv4-compatible ::/96, NAT64 64:ff9b::/96, 6to4 2002::/16 — is
        // judged by the address it carries.)
        boolean zero6 = true; for (int i = 0; i < 12; i++) if (b[i] != 0) zero6 = false;
        boolean nat64 = (b[0] & 0xff) == 0 && (b[1] & 0xff) == 0x64 && (b[2] & 0xff) == 0xff && (b[3] & 0xff) == 0x9b; for (int i = 4; i < 12 && nat64; i++) if (b[i] != 0) nat64 = false;
        try {
            if (zero6 || nat64) return addressOk(InetAddress.getByAddress(java.util.Arrays.copyOfRange(b, 12, 16)), fromCustom);
            if ((b[0] & 0xff) == 0x20 && (b[1] & 0xff) == 0x02) return addressOk(InetAddress.getByAddress(java.util.Arrays.copyOfRange(b, 2, 6)), fromCustom);
        } catch (Exception e) { return false; }
        return fromCustom || (b[0] & 0xfe) != 0xfc;
    }

    /** Whether a resolver blocks names by itself: its «0.0.0.0» is an answer (dohchain.rs filters). */
    static boolean filters(String id) { if ("custom".equals(id)) return true; Resolver r = known(id); return r != null && !"none".equals(r.filters); }
    /** The resolvers the probe asks (dohchain.rs probe_ids): «Check now» (`all`) every one; the automatic probe those
     *  the chain asks first — all in «auto», the chosen one alone when pinned or one's own. */
    static List<Resolver> probeSet(String p, boolean all) {
        List<Resolver> chain = resolvers(p); List<Resolver> out = new ArrayList<>(); if (chain.isEmpty()) return out;
        Resolver first = chain.get(0); boolean auto = "auto".equals(p) || "mullvad".equals(p) || "opendns".equals(p);
        if (!all && !auto) { out.add(first); return out; }
        if ("custom".equals(first.id)) { out.add(first); if (onDevice(p)) return out; }   // (a resolver on this device: asked alone, the probe too)
        for (Resolver k : table) out.add(k);
        return out;
    }
    /** Whether the connection is metered (KtPlugin sets this from Android's ConnectivityManager): no automatic probe then. */
    static volatile java.util.function.BooleanSupplier metered = () -> false;
    /** The whole lookup's limit (the shapes, addresses and the AAAA retry of every resolver within it). */
    static volatile long chainDeadlineMs = 20000;

    /* ---------- which resolver answered each name (the details pages' line), and the probe's timing ---------- */
    private static final Map<String, String[]> used = new ConcurrentHashMap<>();   // host → {via code, at}
    static void used(String host, String via) { if (host == null) return; if (used.size() > 400) { String oldest = null; long o = Long.MAX_VALUE; for (Map.Entry<String, String[]> e : used.entrySet()) { long at = Long.parseLong(e.getValue()[1]); if (at < o) { o = at; oldest = e.getKey(); } } if (oldest != null) used.remove(oldest); } used.put(host.toLowerCase(java.util.Locale.ROOT), new String[] { via, String.valueOf(System.currentTimeMillis()) }); }
    /** { on, hosts: { host: { via, at } } }: via is doh:<id>:<ms>, cache:<id>, stale:<id>, system, local, none:<id>, failed. */
    static org.json.JSONObject usedFor(List<String> hosts) {
        org.json.JSONObject o = new org.json.JSONObject();
        try { org.json.JSONObject hs = new org.json.JSONObject(); for (String h : hosts) { String[] u = used.get(h.toLowerCase(java.util.Locale.ROOT)); if (u != null) { org.json.JSONObject x = new org.json.JSONObject(); x.put("via", u[0]); x.put("at", Long.parseLong(u[1])); hs.put(h, x); } } o.put("on", on()); o.put("hosts", hs); } catch (Exception ignored) {}
        return o;
    }
    static volatile long lastProbeAt = 0; static volatile boolean chainFailed = false; private static final java.util.concurrent.atomic.AtomicBoolean probing = new java.util.concurrent.atomic.AtomicBoolean();
    /** The probe again when due (dohchain.rs probe_due): on a plain thread, only when a name is asked — no timer. */
    static void probeIfDue() {
        if (!on()) return; long now = System.currentTimeMillis();
        boolean due = lastProbeAt == 0 || now - lastProbeAt >= PROBE_EVERY_MS || (chainFailed && now - lastProbeAt >= 60_000L);
        try { if (due && metered.getAsBoolean()) return; } catch (Throwable ignored) {}
        if (!due || !probing.compareAndSet(false, true)) return;
        final String p = prov(); final boolean br = Boolean.TRUE.equals(inBrowser.get());
        Thread t = new Thread(() -> { try { if (br) browser(() -> probe(false)); else probe(false); } catch (Exception ignored) {} finally { probing.set(false); } }, "kt-doh-health"); t.setDaemon(true); t.start();
    }

    private static final class Entry { final InetAddress[] ips; final long until, stored; final String by; Entry(InetAddress[] ips, long until, String by) { this.ips = ips; this.until = until; this.by = by; this.stored = System.currentTimeMillis(); } }
    private static final Map<String, Entry> cache = new ConcurrentHashMap<>();
    /** Kept by TTL within [TTL_MIN_S, TTL_MAX_S]; «no such name» NEG_TTL_S; at most CACHE_MAX names (the expired first,
     *  then the soonest to expire). */
    static void cachePut(String key, InetAddress[] ips, long ttl, String by) {
        long keep = ips.length == 0 ? NEG_TTL_S : Math.max(TTL_MIN_S, Math.min(TTL_MAX_S, ttl)); long now = System.currentTimeMillis();
        if (!cache.containsKey(key) && cache.size() >= CACHE_MAX) { cache.entrySet().removeIf(e -> e.getValue().until <= now); while (cache.size() >= CACHE_MAX) { String k = null; long u = Long.MAX_VALUE; for (Map.Entry<String, Entry> e : cache.entrySet()) if (e.getValue().until < u) { u = e.getValue().until; k = e.getKey(); } if (k == null) break; cache.remove(k); } }
        cache.put(key, new Entry(ips, now + keep * 1000, by));
    }
    static int cacheSize() { return cache.size(); }
    static void forget() { cache.clear(); neededAt.clear(); forced.clear(); state = on() ? "idle" : "off"; lastResolver = ""; lastError = ""; lastShape = ""; lastMs = -1; }

    /** The addresses of `host` by the chain (dohchain.rs resolve): the cache; each resolver in turn (addresses
     *  `addressOk` refuses dropped — an answer left with none is that resolver's failure); every resolver failed: an
     *  earlier answer of theirs however old (up to a day), else the system's DNS only when `allowSystem` — said so in
     *  the events and in `used`. A name of this device or its network: the system's, by rule. */
    static InetAddress[] resolve(String host) throws IOException {
        if (isLiteral(host)) return new InetAddress[] { InetAddress.getByName(host) };
        String hk = host.toLowerCase(java.util.Locale.ROOT);
        if (isLocalName(hk)) { InetAddress[] l = sys.lookup(host); used(hk, "local"); return l; }
        String p = prov(); String key = p + "|" + hk;
        Entry e = cache.get(key);
        if (e != null && e.until > System.currentTimeMillis()) { hits.incrementAndGet(); if (e.ips.length == 0) throw new java.net.UnknownHostException(e.by.startsWith("blocked:") ? "DNS over HTTPS: " + host + " is blocked by " + e.by.substring(8) : host); used(hk, "cache:" + e.by); return e.ips; }
        List<Resolver> rs = resolvers(p);
        if (rs.isEmpty()) return InetAddress.getAllByName(host);   // (DoH off: the system's, as asked)
        IOException last = null; queries.incrementAndGet(); state = "resolving"; long t0 = System.currentTimeMillis();
        long deadline = t0 + chainDeadlineMs; List<String> failed = new ArrayList<>(); boolean allPrivate = true;
        try {
            for (Resolver r : rs) {
                if (System.currentTimeMillis() >= deadline) { failed.add(r.id + ": deadline"); allPrivate = false; break; }
                long a0 = System.currentTimeMillis();
                try {
                    Answer a = askResolver(r, query(host, 1), 6000, deadline);
                    InetAddress[] ips = a.ips; long ttl = a.ttl;
                    if (ips.length == 0) { Answer b = askResolver(r, query(host, 28), 6000, deadline); ips = b.ips; ttl = b.ttl; }   // (no IPv4 address: its IPv6 ones)
                    // (A filtering resolver's 0.0.0.0: blocked by it, on purpose — an answer; no other resolver asked, its health untouched.)
                    if (ips.length > 0 && filters(r.id)) { boolean unspec = true; for (InetAddress x : ips) if (!x.isAnyLocalAddress()) unspec = false; if (unspec) { cachePut(key, new InetAddress[0], 0, "blocked:" + r.id); used(hk, "blocked:" + r.id); note("blocked", host, null, -1, r.id); throw new java.net.UnknownHostException("DNS over HTTPS: " + host + " is blocked by " + r.id); } }
                    List<InetAddress> kept = new ArrayList<>(); for (InetAddress x : ips) if (addressOk(x, "custom".equals(r.id))) kept.add(x);
                    if (kept.isEmpty() && ips.length > 0) { failed.add(r.id + ": private"); note("retry", host, r.id, -1, "private"); continue; }
                    if (kept.isEmpty()) throw new java.net.UnknownHostException(host);
                    InetAddress[] out = kept.toArray(new InetAddress[0]);
                    cachePut(key, out, ttl, r.id);
                    long ms = System.currentTimeMillis() - t0; state = "ok"; lastResolver = a.from; lastShape = a.shape; lastMs = ms; lastAt = System.currentTimeMillis(); lastError = ""; preferred = r.id;
                    used(hk, "doh:" + r.id + ":" + (System.currentTimeMillis() - a0));
                    note("resolve", host, out[0].getHostAddress(), ms, r.id + " " + a.shape);
                    return out;
                } catch (java.net.UnknownHostException nx) { if (String.valueOf(nx.getMessage()).contains(" is blocked by ")) throw nx; cachePut(key, new InetAddress[0], 0, r.id); state = "ok"; lastAt = System.currentTimeMillis(); used(hk, "none:" + r.id); note("none", host, null, System.currentTimeMillis() - t0, r.id); throw nx; }   // (a resolver answered: no such name — remembered briefly)
                catch (IOException ex) { last = ex; allPrivate = false; failed.add(r.id + ": " + clean(ex.getMessage())); note("retry", host, r.id, -1, String.valueOf(ex.getMessage())); }
            }
            // (No resolver answered: an address of theirs known from before, however old, beats none.)
            if (e != null && e.ips.length > 0 && System.currentTimeMillis() - e.stored < 86_400_000L) { used(hk, "stale:" + e.by); note("stale", host, e.ips[0].getHostAddress(), System.currentTimeMillis() - t0, "no resolver answered"); return e.ips; }
            if (allowSystem) {
                try { InetAddress[] sy = sys.lookup(host); if (sy.length > 0) { systemUsed.incrementAndGet(); used(hk, "system"); note("system", host, sy[0].getHostAddress(), System.currentTimeMillis() - t0, "every resolver failed: the system's DNS, as allowed"); return sy; } } catch (IOException ignored) {}
            }
            chainFailed = true; fails.incrementAndGet(); state = "failed"; lastError = last != null ? clean(last.getMessage()) : "unknown host"; lastAt = System.currentTimeMillis(); used(hk, allPrivate && !failed.isEmpty() ? "private" : "failed");
            note("fail", host, null, System.currentTimeMillis() - t0, lastError);
            String why = "DNS over HTTPS: no resolver answered for " + host + " (" + String.join("; ", failed.subList(0, Math.min(3, failed.size()))) + ")" + (allowSystem ? "" : " — the system's DNS is not allowed in Settings");
            throw new java.net.UnknownHostException(why);
        } finally { probeIfDue(); }
    }
    static final java.util.concurrent.atomic.AtomicLong systemUsed = new java.util.concurrent.atomic.AtomicLong();
    /** Whether a caller may go the network's own way for `host` (a download tried once more by the system's DNS, a
     *  site whose TLS refused the resolver's way): only when the reader allowed the system's DNS — and then said. */
    static boolean systemOk(String host, String why) {
        if (!on()) return true;
        String k = (host == null ? "" : host.toLowerCase(java.util.Locale.ROOT)) + (allowSystem ? "|y" : "|n"); long now = System.currentTimeMillis(); Long was = saidAt.get(k);
        boolean say = was == null || now - was > 60_000L; if (say) { if (saidAt.size() > 200) saidAt.clear(); saidAt.put(k, now); }   // (said once a minute a host, not at every connection)
        if (!allowSystem) { if (say) note("nosystem", host, null, -1, why + ": the system's DNS is not allowed"); return false; }
        systemUsed.incrementAndGet(); if (host != null) used(host, "system"); if (say) note("system", host, null, -1, why); return true;
    }
    private static final Map<String, Long> saidAt = new ConcurrentHashMap<>();

    /** What a resolver answered: the addresses, their time to live, the address it answered from and the shape that got through. */
    static final class Answer { final InetAddress[] ips; final long ttl; final String from, shape; Answer(InetAddress[] ips, long ttl, String from, String shape) { this.ips = ips; this.ttl = ttl; this.from = from; this.shape = shape; } }
    /** The shapes a question takes, in the order tried (the one that last worked first): see the class note. */
    static final String[] SHAPES = { "post", "post-split", "get", "post-noname", "json" };
    /** `r` asked `q` by each of its addresses and each shape until one answers; what worked is kept with it. Every
     *  shape goes to the resolver's own addresses (its bootstrap; the user's resolver's name found by the public
     *  ones), never by the network's DNS; a POST carries an id of its own, and every answer is read trusting nothing. */
    static Answer askResolver(Resolver r, byte[] q0, int timeoutMs) throws IOException { return askResolver(r, q0, timeoutMs, System.currentTimeMillis() + Math.max(timeoutMs, 1) * 4L); }
    /** The same, never past `until` (the lookup's own deadline): every shape and address within it. */
    static Answer askResolver(Resolver r, byte[] q0, int timeoutMs, long until) throws IOException {
        URL u = new URL(r.url); IOException last = null; long t0 = System.currentTimeMillis();
        String[] qn = questionOf(q0); int qtype = Integer.parseInt(qn[1]);
        List<String> shapes = new ArrayList<>(); if (!r.shape.isEmpty()) shapes.add(r.shape); for (String s : SHAPES) if (!shapes.contains(s)) shapes.add(s);
        String[] by = bootstrap(r);
        for (String shape : shapes) {
            if (shape.equals("json") && !r.json()) continue;
            for (String ip : by) {
                if (ip == null && (shape.equals("post-split") || shape.equals("post-noname"))) continue;
                int id = shape.equals("get") ? 0 : RND.nextInt(65536); byte[] q = withId(q0, id);
                int left = (int) Math.min(timeoutMs, until - System.currentTimeMillis()); if (left < 50) { if (last == null) last = new IOException("deadline"); health(r, false, System.currentTimeMillis() - t0, "deadline"); throw last; }
                try {
                    byte[] m = shape.equals("json") ? askJson(u, ip, q, left) : ask(u, ip, q, shape, left);
                    long[] ttl = { 300 }; InetAddress[] ips = parseStrict(m, qn[0], qtype, id, ttl);
                    r.shape = shape; health(r, true, System.currentTimeMillis() - t0, null);
                    return new Answer(ips, ttl[0], ip != null ? ip : u.getHost(), shape);
                } catch (java.net.UnknownHostException nx) { r.shape = shape; health(r, true, System.currentTimeMillis() - t0, null); throw nx; }   // (the resolver answered: the name is no site's)
                catch (IOException e) { last = e; }
            }
        }
        health(r, false, System.currentTimeMillis() - t0, last == null ? "no answer" : clean(last.getMessage()));
        throw last != null ? last : new IOException("no answer");
    }
    private static final java.security.SecureRandom RND = new java.security.SecureRandom();
    static byte[] withId(byte[] q, int id) { byte[] c = q.clone(); c[0] = (byte) (id >> 8); c[1] = (byte) id; return c; }
    /** The addresses a resolver is reached at: its own (the table's); for the user's resolver, its address when it is
     *  one, this device when it is on it, else its name asked of the public resolvers — never the network's DNS. */
    static String[] bootstrap(Resolver r) throws IOException {
        if (r.ips.length > 0) return r.ips;
        String h = hostOf(r.url); if (h.isEmpty()) throw new IOException("no host");
        if (isLiteral(h)) return new String[] { h };
        if (onDevice(r.url)) return new String[] { "localhost".equals(h) ? "127.0.0.1" : h };
        String[] had = bootCache.get(h); if (had != null) return had;
        InetAddress[] ips = null; IOException last = null;
        for (Resolver k : resolvers("auto")) { try { Answer a = askResolver(k, query(h, 1), 5000); if (a.ips.length > 0) { ips = a.ips; break; } } catch (IOException e) { last = e; } }
        if (ips == null || ips.length == 0) throw new IOException("the resolver's own name not found: " + (last == null ? h : clean(last.getMessage())));
        String[] out = new String[ips.length]; for (int i = 0; i < ips.length; i++) out[i] = ips[i].getHostAddress(); bootCache.put(h, out); return out;
    }
    private static final Map<String, String[]> bootCache = new ConcurrentHashMap<>();

    /* ---------- torrents: UDP trackers by the chain's addresses (dohchain.rs tracker_rewrite / magnet_rewrite) ---------- */
    /** A UDP tracker's address with `ip` in place of its name (the UDP tracker protocol carries no name); null when it
     *  is left as it is — an HTTP(S) tracker (its name is needed for the Host header and the certificate), one given by
     *  address, a local name. */
    static String trackerRewrite(String url, String ip) {
        if (url == null || url.length() < 6 || !url.substring(0, 6).equalsIgnoreCase("udp://")) return null; String rest = url.substring(6);
        int end = rest.length(); for (char c : new char[] { '/', '?' }) { int i = rest.indexOf(c); if (i >= 0 && i < end) end = i; }
        String auth = rest.substring(0, end), tail = rest.substring(end); if (auth.startsWith("[")) return null;
        int i = auth.lastIndexOf(':'); String host = i < 0 ? auth : auth.substring(0, i), port = i < 0 ? null : auth.substring(i + 1);
        if (host.isEmpty() || isLiteral(host) || isLocalName(host)) return null;
        return "udp://" + (ip.contains(":") ? "[" + ip + "]" : ip) + (port != null ? ":" + port : "") + tail;
    }
    static String trackerHost(String url) { if (trackerRewrite(url, "192.0.2.1") == null) return null; String a = url.substring(6); int end = a.length(); for (char c : new char[] { '/', '?', ':' }) { int i = a.indexOf(c); if (i >= 0 && i < end) end = i; } return a.substring(0, end).toLowerCase(java.util.Locale.ROOT); }
    interface HostIp { String ip(String host); }
    static String pctDecode(String s) { try { return java.net.URLDecoder.decode(s, "UTF-8"); } catch (Exception e) { return s; } }
    static String pctEncode(String s) { StringBuilder b = new StringBuilder(); for (byte c : s.getBytes(java.nio.charset.StandardCharsets.UTF_8)) { int x = c & 0xff; if ((x >= 'A' && x <= 'Z') || (x >= 'a' && x <= 'z') || (x >= '0' && x <= '9') || x == '-' || x == '.' || x == '_' || x == '~') b.append((char) x); else b.append('%').append(String.format(java.util.Locale.ROOT, "%02X", x)); } return b.toString(); }
    /** A magnet's UDP trackers (tr=) by address; everything else left exactly as it was. */
    static String magnetRewrite(String magnet, HostIp resolve) {
        int q = magnet.indexOf('?'); if (q < 0) return magnet; String[] parts = magnet.substring(q + 1).split("&", -1); StringBuilder out = new StringBuilder(magnet.substring(0, q + 1)); boolean first = true;
        for (String p : parts) {
            int j = p.indexOf('='); String n = p;
            if (j > 0 && p.substring(0, j).equalsIgnoreCase("tr")) { String url = pctDecode(p.substring(j + 1)); String h = trackerHost(url); if (h != null) { String ip = resolve.ip(h); String r = ip == null ? null : trackerRewrite(url, ip); if (r == null) continue; n = p.substring(0, j) + "=" + pctEncode(r); } }   // (a UDP tracker the chain could not answer: left out)
            if (!first) out.append('&'); first = false; out.append(n);
        }
        return out.toString();
    }
    /** The UDP trackers left out because the chain could not answer for them (the swarm page lists them). */
    static final java.util.Set<String> droppedTrackers = java.util.concurrent.ConcurrentHashMap.newKeySet();
    /** rewritten → {original, via}: the swarm page shows the tracker's own name and what answered it. */
    static final Map<String, String[]> trackerOrigin = new ConcurrentHashMap<>();
    /** A torrent's tracker list with its UDP trackers by the chain's addresses — the hosts asked at once, within
     *  `budgetMs`; one the chain could not answer is left as it is (the engine's own lookup: said on the swarm page). */
    static List<String> trackersViaDoh(List<String> urls, long budgetMs) {
        if (!on() || urls == null) return urls;
        java.util.Set<String> hosts = new java.util.LinkedHashSet<>(); for (String u : urls) { String h = trackerHost(u); if (h != null) hosts.add(h); }
        final Map<String, String> got = new ConcurrentHashMap<>(); List<Thread> ts = new ArrayList<>();
        for (final String h : hosts) { Thread t = new Thread(() -> { try { InetAddress[] a = resolve(h); if (a.length > 0) got.put(h, a[0].getHostAddress()); } catch (Exception ignored) {} }, "kt-doh-tracker"); t.setDaemon(true); ts.add(t); t.start(); }
        long until = System.currentTimeMillis() + budgetMs; for (Thread t : ts) { long left = until - System.currentTimeMillis(); if (left <= 0) break; try { t.join(left); } catch (InterruptedException e) { break; } }
        List<String> out = new ArrayList<>();
        for (String u : urls) {
            String h = trackerHost(u); if (h == null) { out.add(u); continue; }   // (HTTP(S), by address, local: as it was)
            String ip = got.get(h); String r = ip == null ? null : trackerRewrite(u, ip);
            if (r != null) { String[] w = used.get(h); trackerOrigin.put(r, new String[] { u, w == null ? "" : w[0] }); out.add(r); }
            else { droppedTrackers.add(u); String[] w = used.get(h); trackerOrigin.put(u, new String[] { u, "dropped:" + (w == null ? "failed" : w[0]) }); }   // (not answered: left out, never a name for libtorrent)
        }
        return out;
    }

    /* ---------- the sites: whether a site needs the resolver, and the ones forced through it ---------- */
    /** For the web views: whether `host` needs the resolver at all — the network's DNS gives it no address, or
     *  one that is no site's (0.0.0.0, the device itself, a home network's), or addresses none of which the
     *  resolver gives (a provider's page put in the site's place), or it was forced (the browser could not
     *  reach it the network's way). A site the network's DNS gives as it is is left to the web view's own
     *  requests: a site's check (Cloudflare) wants the browser's own connection. Kept ten minutes a name. */
    private static final Map<String, long[]> neededAt = new ConcurrentHashMap<>();
    private static final Map<String, Long> forced = new ConcurrentHashMap<>();
    /** The sites the app's browser forced (kept apart from the app's: they reach the browser's pages only). */
    private static final Map<String, Long> browserForced = new ConcurrentHashMap<>();
    private static Map<String, Long> forcedHere() { return Boolean.TRUE.equals(inBrowser.get()) ? browserForced : forced; }
    static void forceBrowser(String host) { try { browser(() -> { force(host); return null; }); } catch (Exception ignored) {} }
    static boolean isForcedBrowser(String host) { try { return browser(() -> isForced(host)); } catch (Exception e) { return false; } }
    /** Sites whose TLS handshake failed through the resolver's way (AniList refusing the rewritten hello on some
     *  networks) and answered the plain way: asked the plain way — the network's DNS, the hello as it is — for a day. */
    private static final Map<String, Long> direct = new ConcurrentHashMap<>();
    /** False (and nothing kept) when the reader did not allow the system's DNS: no silent fall-back. */
    static boolean goDirect(String host) { if (host == null || host.isEmpty()) return false; if (!systemOk(host, "TLS refused through the resolver: the plain way")) return false; direct.put(host.toLowerCase(), System.currentTimeMillis() + 86_400_000L); note("direct", host, null, -1, "TLS refused through the resolver: the plain way"); return true; }
    static boolean isDirect(String host) { if (host == null) return false; Long until = direct.get(host.toLowerCase()); if (until == null) return false; if (until < System.currentTimeMillis()) { direct.remove(host.toLowerCase()); return false; } return true; }
    /** `host` (and its subdomains) sent through the resolver for an hour whatever the network's DNS says: the browser
     *  could not reach it the network's way (a reset, a timeout, a handshake refused — a filter reading names). */
    static void force(String host) {
        if (host == null || host.isEmpty()) return;
        String h = host.toLowerCase(); forcedHere().put(h, System.currentTimeMillis() + 3600_000L);
        for (String k : neededAt.keySet()) if (k.endsWith("|" + h) || k.endsWith("." + h)) neededAt.remove(k);
        unblocked.incrementAndGet(); note("force", host, null, -1, "unreachable");
    }
    static void unforce(String host) { if (host == null) return; String h = host.toLowerCase(); forcedHere().remove(h); for (String k : neededAt.keySet()) if (k.endsWith("|" + h)) neededAt.remove(k); }
    private static final Map<String, Long> silentAt = new ConcurrentHashMap<>();
    /** A second unanswered drop of an untouched tunnel to `host` within five minutes. */
    static boolean silentTwice(String host) { String h = host.toLowerCase(); long now = System.currentTimeMillis(); Long was = silentAt.put(h, now); return was != null && now - was < 300_000L; }
    /** Whether the network's DNS hides `host` (as last looked at), forcing left out; null when not looked at yet. */
    static Boolean neededByDns(String host) { long[] had = neededAt.get(prov() + "|" + host.toLowerCase()); return had == null || had[0] < System.currentTimeMillis() ? null : had[1] == 1; }
    static boolean isForced(String host) {
        if (host == null) return false; String h = host.toLowerCase(); long now = System.currentTimeMillis();
        Map<String, Long> fm = forcedHere(); for (Map.Entry<String, Long> e : fm.entrySet()) { if (e.getValue() < now) { fm.remove(e.getKey()); continue; } if (h.equals(e.getKey()) || h.endsWith("." + e.getKey())) return true; }
        return false;
    }
    /** What `needed` last found for `host`, when it looked within ten minutes; null when it has not (no network here). */
    static Boolean neededCached(String host) { if (!on() || host == null) return null; if (isForced(host)) return true; long[] had = neededAt.get(prov() + "|" + host.toLowerCase()); return had == null || had[0] <= System.currentTimeMillis() ? null : had[1] == 1; }
    static boolean needed(String host) {
        if (!on() || isLiteral(host)) return false;
        if (isForced(host)) return true;
        // (0.21 P9: the app's own choice — its web views behind the app's proxy — never asks the network's DNS to compare:
        // every name goes through the chain, and the hello is split only for a site that failed the plain way (forced).
        // The in-app browser's own switch, without the proxy, still compares — its pages need the web view's own way.)
        if (!Boolean.TRUE.equals(inBrowser.get())) return false;
        String key = prov() + "|" + host.toLowerCase();
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
    /** An answer read trusting nothing (shared/shell-rs doh.rs decode_strict's twin): at most 65535 bytes, an answer,
     *  not truncated, the id and the one question asked; the records of the name asked, CNAMEs followed (at most 8, a
     *  loop refused), class IN and the type asked only. «No such name» → UnknownHostException; no record → none. */
    static InetAddress[] parseStrict(byte[] m, String qname, int qtype, int id, long[] ttl) throws IOException {
        if (m.length > 65535) throw new IOException("DNS answer too big"); if (m.length < 12) throw new IOException("DNS answer cut short");
        if (u16(m, 0) != id) throw new IOException("DNS answer for another question (id)");
        int flags = u16(m, 2); if ((flags & 0x8000) == 0) throw new IOException("not a DNS answer"); if ((flags & 0x0200) != 0) throw new IOException("DNS answer truncated");
        int rc = flags & 15; if (rc == 3) throw new java.net.UnknownHostException("NXDOMAIN"); if (rc != 0) throw new IOException("the resolver failed (code " + rc + ")");
        if (u16(m, 4) != 1) throw new IOException("DNS answer for another question");
        int an = u16(m, 6); String want = qname.toLowerCase(java.util.Locale.ROOT); if (want.endsWith(".")) want = want.substring(0, want.length() - 1);
        Object[] qr = readName(m, 12); int i = (Integer) qr[1]; if (i + 4 > m.length) throw new IOException("DNS answer cut short");
        if (!qr[0].equals(want) || u16(m, i) != qtype) throw new IOException("DNS answer for another question"); i += 4;
        List<Object[]> recs = new ArrayList<>();   // owner, type, class, ttl, data, len
        for (int k = 0; k < an; k++) { Object[] o = readName(m, i); int at = (Integer) o[1]; if (at + 10 > m.length) throw new IOException("DNS answer cut short"); int len = u16(m, at + 8), data = at + 10; if (data + len > m.length) throw new IOException("DNS answer cut short"); recs.add(new Object[] { o[0], u16(m, at), u16(m, at + 2), ((long) u16(m, at + 4) << 16) | u16(m, at + 6), data, len }); i = data + len; }
        String name = want; List<String> seen = new ArrayList<>(); seen.add(name); long least = Long.MAX_VALUE;
        for (int hop = 0; hop <= 8; hop++) {
            List<InetAddress> out = new ArrayList<>();
            for (Object[] r : recs) { if (!r[0].equals(name) || (Integer) r[2] != 1 || (Integer) r[1] != qtype) continue; int at = (Integer) r[4], len = (Integer) r[5]; if ((qtype == 1 && len != 4) || (qtype == 28 && len != 16)) throw new IOException("DNS answer: an address of the wrong size"); out.add(InetAddress.getByAddress(java.util.Arrays.copyOfRange(m, at, at + len))); least = Math.min(least, (Long) r[3]); }
            if (!out.isEmpty()) { ttl[0] = least; return out.toArray(new InetAddress[0]); }
            Object[] c = null; for (Object[] r : recs) if (r[0].equals(name) && (Integer) r[1] == 5 && (Integer) r[2] == 1) { c = r; break; }
            if (c == null) return new InetAddress[0];
            String to = (String) readName(m, (Integer) c[4])[0]; if (seen.contains(to)) throw new IOException("DNS answer: a CNAME loop"); least = Math.min(least, (Long) c[3]); seen.add(to); name = to;
        }
        throw new IOException("DNS answer: too many CNAMEs");
    }
    /** A name at `i`, pointers followed (only backwards, at most 32, at most 255 bytes) → {name, position after it}. */
    static Object[] readName(byte[] m, int i) throws IOException {
        StringBuilder sb = new StringBuilder(); int end = -1, jumps = 0, total = 0;
        while (true) {
            if (i >= m.length) throw new IOException("DNS answer cut short"); int len = m[i] & 0xff;
            if (len == 0) return new Object[] { sb.toString(), end >= 0 ? end : i + 1 };
            if ((len & 0xc0) == 0xc0) { if (i + 1 >= m.length) throw new IOException("DNS answer cut short"); int to = ((len & 0x3f) << 8) | (m[i + 1] & 0xff); if (++jumps > 32 || to >= i) throw new IOException("DNS answer: a name that points at itself"); if (end < 0) end = i + 2; i = to; continue; }
            if ((len & 0xc0) != 0) throw new IOException("DNS answer: a label of an unknown kind");
            if (i + 1 + len > m.length) throw new IOException("DNS answer cut short"); total += len + 1; if (total > 255) throw new IOException("DNS answer: a name too long");
            if (sb.length() > 0) sb.append('.'); sb.append(new String(m, i + 1, len, java.nio.charset.StandardCharsets.ISO_8859_1).toLowerCase(java.util.Locale.ROOT)); i += 1 + len;
        }
    }
    /** A DNS answer made out of the JSON form's (RFC 8427-ish: {Status, Answer:[{type, TTL, data}]}): the same bytes `parse` reads. */
    static byte[] fromJson(String json) throws IOException { return fromJson(json, null); }
    /** The same, with the question `q` echoed (its id and question): what parseStrict reads. */
    static byte[] fromJson(String json, byte[] q) throws IOException {
        org.json.JSONObject o; try { o = new org.json.JSONObject(json); } catch (Exception e) { throw new IOException("DoH JSON: " + e.getMessage()); }
        int status = o.optInt("Status", 0); if (status == 3) throw new java.net.UnknownHostException("NXDOMAIN"); if (status != 0) throw new IOException("DoH JSON status " + status);
        ByteArrayOutputStream b = new ByteArrayOutputStream(); org.json.JSONArray ans = o.optJSONArray("Answer"); int n = 0;
        ByteArrayOutputStream recs = new ByteArrayOutputStream();
        // (0.21 P9: each record keeps its own owner name — parseStrict then follows the question and its CNAMEs, as for the
        // wire form; an address is taken only when it is written as one — never looked up.)
        if (ans != null) for (int i = 0; i < ans.length(); i++) {
            org.json.JSONObject a = ans.optJSONObject(i); if (a == null) continue; int type = a.optInt("type", 0); if (type != 1 && type != 28 && type != 5) continue;
            byte[] owner = wireName(a.optString("name", "")), data;
            if (owner == null) continue;
            if (type == 5) { data = wireName(a.optString("data", "")); if (data == null) continue; }
            else { data = literal(a.optString("data", ""), type == 1 ? 4 : 16); if (data == null) continue; }
            long ttl = a.optLong("TTL", 300);
            recs.write(owner, 0, owner.length); recs.write(type >> 8); recs.write(type); recs.write(0); recs.write(1);
            recs.write((int) (ttl >> 24)); recs.write((int) (ttl >> 16)); recs.write((int) (ttl >> 8)); recs.write((int) ttl); recs.write(data.length >> 8); recs.write(data.length); recs.write(data, 0, data.length); n++;
        }
        if (q != null) { b.write(q[0]); b.write(q[1]); b.write(0x81); b.write(0x80); b.write(0); b.write(1); b.write(n >> 8); b.write(n); b.write(0); b.write(0); b.write(0); b.write(0); b.write(q, 12, q.length - 12); }
        else { b.write(0); b.write(0); b.write(0x81); b.write(0x80); b.write(0); b.write(0); b.write(n >> 8); b.write(n); b.write(0); b.write(0); b.write(0); b.write(0); }   // (no question kept: parse skips none)
        byte[] r = recs.toByteArray(); b.write(r, 0, r.length);
        return b.toByteArray();
    }
    /** A host name in wire form (labels of 1–63 letters, digits, «-» or «_»; the trailing dot allowed); null otherwise. */
    static byte[] wireName(String n) {
        if (n.endsWith(".")) n = n.substring(0, n.length() - 1); if (n.isEmpty() || n.length() > 253) return null;
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        for (String l : n.split("\\.", -1)) { if (l.isEmpty() || l.length() > 63 || !l.matches("[A-Za-z0-9_-]+")) return null; b.write(l.length()); byte[] x = l.getBytes(java.nio.charset.StandardCharsets.US_ASCII); b.write(x, 0, x.length); }
        b.write(0); return b.toByteArray();
    }
    /** An address written as one (dotted IPv4, or IPv6 of hex digits and colons) as `len` bytes; never looked up. */
    static byte[] literal(String s, int len) {
        try {
            if (len == 4) { if (!s.matches("\\d{1,3}(\\.\\d{1,3}){3}")) return null; String[] p = s.split("\\."); byte[] b = new byte[4]; for (int i = 0; i < 4; i++) { int v = Integer.parseInt(p[i]); if (v > 255) return null; b[i] = (byte) v; } return b; }
            if (!s.matches("[0-9A-Fa-f:.]+") || !s.contains(":")) return null;
            byte[] b = InetAddress.getByName(s).getAddress();   // (a literal of hex and colons: parsed, not looked up)
            return b.length == 16 ? b : null;
        } catch (Exception e) { return null; }
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
        try (InputStream in = c.getInputStream()) { return readCapped(in); }
        finally { c.disconnect(); }
    }
    /** A resolver's answer read whole, refused past 65536 bytes (a DNS message is at most 65535). */
    static byte[] readCapped(InputStream in) throws IOException { ByteArrayOutputStream b = new ByteArrayOutputStream(); byte[] buf = new byte[4096]; int n; while ((n = in.read(buf)) > 0) { b.write(buf, 0, n); if (b.size() > 65536) throw new IOException("DNS answer too big"); } return b.toByteArray(); }
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
    private static byte[] askJson(URL resolver, String ip, byte[] q, int timeoutMs) throws IOException {
        String[] qn = questionOf(q);
        String base = resolver.toString().replaceAll("/dns-query$", "/resolve"); if (resolver.getHost().contains("cloudflare")) base = resolver.toString();
        URL u = new URL(base + (base.contains("?") ? "&" : "?") + "name=" + java.net.URLEncoder.encode(qn[0], "UTF-8") + "&type=" + qn[1]);
        // (By the resolver's own address — its name kept for TLS — like every other shape: never the network's DNS.)
        HttpURLConnection c = ip == null ? (HttpURLConnection) u.openConnection() : connectTo(u, ip, false);
        c.setInstanceFollowRedirects(false); c.setConnectTimeout(Math.min(8000, timeoutMs)); c.setReadTimeout(timeoutMs); c.setRequestProperty("Accept", "application/dns-json"); c.setRequestProperty("User-Agent", "KurokawaTools");
        try {
            int code = c.getResponseCode(); if (code != 200) throw new IOException("DoH JSON HTTP " + code);
            try (InputStream in = c.getInputStream()) { return fromJson(new String(readCapped(in), java.nio.charset.StandardCharsets.UTF_8), q); }
        } finally { c.disconnect(); }
    }

    /**
     * A connection to `url` that goes to the address the resolver gives for its host (redirects not followed:
     * the caller follows them, by their own names). With DoH off, the plain connection.
     */
    static HttpURLConnection open(URL url) throws IOException {
        if (!on() || isDirect(url.getHost())) return (HttpURLConnection) url.openConnection();
        InetAddress[] ips = resolve(url.getHost());
        String sp = split; boolean frag = "always".equals(sp) || ("auto".equals(sp) && Boolean.TRUE.equals(neededCached(url.getHost())));
        HttpURLConnection c = connectTo(url, ips[0].getHostAddress(), frag);
        c.setInstanceFollowRedirects(false);
        return c;
    }

    /**
     * A connection that follows redirects through the chain (0.21 P9), for callers that relied on the system opener's
     * own following (KtTranslate's default opener, the browser's media probe): up to MAX_HOPS, each hop resolved
     * through DoH again (KrDoh.open), http(s) only, a loop refused; 303 → GET without a body (HEAD stays HEAD), 301/302 →
     * GET after a POST, 307/308 keep the method and body; Authorization, Cookie and Proxy-Authorization dropped when the
     * host changes. With DoH off: the plain connection, which follows by itself as before. Callers that want to see the
     * redirect (the downloader, the packs, the browser's own requests) keep KrDoh.open.
     */
    static HttpURLConnection openFollowing(URL url) throws IOException {
        if (!on()) return (HttpURLConnection) url.openConnection();
        return new Following(url, Boolean.TRUE.equals(inBrowser.get()));
    }
    static final int MAX_HOPS = 5;
    static final class Following extends HttpURLConnection {
        private final boolean br; private final Map<String, List<String>> props = new java.util.LinkedHashMap<>();
        private ByteArrayOutputStream body; private HttpURLConnection fin; private URL at;
        Following(URL u, boolean br) { super(u); this.br = br; this.at = u; }
        private static String key(Map<String, List<String>> m, String k) { for (String x : m.keySet()) if (x.equalsIgnoreCase(k)) return x; return k; }
        @Override public void setRequestProperty(String k, String v) { if (k == null) throw new NullPointerException("key"); List<String> l = new ArrayList<>(); l.add(v); props.remove(key(props, k)); props.put(k, l); }
        @Override public void addRequestProperty(String k, String v) { if (k == null) throw new NullPointerException("key"); props.computeIfAbsent(key(props, k), x -> new ArrayList<>()).add(v); }
        @Override public String getRequestProperty(String k) { List<String> l = props.get(key(props, k)); return l == null || l.isEmpty() ? null : l.get(l.size() - 1); }
        @Override public Map<String, List<String>> getRequestProperties() { return java.util.Collections.unmodifiableMap(props); }
        @Override public void setFixedLengthStreamingMode(int n) {}
        @Override public void setFixedLengthStreamingMode(long n) {}
        @Override public void setChunkedStreamingMode(int n) {}
        @Override public void setInstanceFollowRedirects(boolean f) {}
        @Override public OutputStream getOutputStream() throws IOException { if (fin != null) throw new IOException("already sent"); setDoOutput(true); if (body == null) body = new ByteArrayOutputStream(); return body; }
        @Override public boolean usingProxy() { return false; }
        @Override public void disconnect() { if (fin != null) fin.disconnect(); }
        @Override public void connect() throws IOException { send(); }
        @Override public URL getURL() { return at; }
        @Override public int getResponseCode() throws IOException { send(); return fin.getResponseCode(); }
        @Override public String getResponseMessage() throws IOException { send(); return fin.getResponseMessage(); }
        @Override public InputStream getInputStream() throws IOException { send(); return fin.getInputStream(); }
        @Override public InputStream getErrorStream() { try { send(); } catch (IOException e) { return null; } return fin.getErrorStream(); }
        @Override public String getHeaderField(String n) { try { send(); } catch (IOException e) { return null; } return fin.getHeaderField(n); }
        @Override public String getHeaderField(int i) { try { send(); } catch (IOException e) { return null; } return fin.getHeaderField(i); }
        @Override public String getHeaderFieldKey(int i) { try { send(); } catch (IOException e) { return null; } return fin.getHeaderFieldKey(i); }
        @Override public Map<String, List<String>> getHeaderFields() { try { send(); } catch (IOException e) { return java.util.Collections.emptyMap(); } return fin.getHeaderFields(); }
        @Override public String getContentType() { return getHeaderField("Content-Type"); }
        @Override public long getContentLengthLong() { try { send(); } catch (IOException e) { return -1; } return fin.getContentLengthLong(); }
        @Override public int getContentLength() { long l = getContentLengthLong(); return l > Integer.MAX_VALUE ? -1 : (int) l; }
        /** The request sent, hop by hop, until an answer that is not a redirect. */
        private synchronized void send() throws IOException {
            if (fin != null) return;
            URL u = url; String m = getRequestMethod(); byte[] b = body == null ? null : body.toByteArray();
            Map<String, List<String>> hs = new java.util.LinkedHashMap<>(props); java.util.Set<String> seen = new java.util.HashSet<>();
            for (int hop = 0; ; hop++) {
                if (!seen.add(u.toString())) throw new IOException("redirect loop at " + u);
                final URL target = u; HttpURLConnection c;
                try { c = br ? browser(() -> open(target)) : open(target); } catch (IOException e) { throw e; } catch (Exception e) { throw new IOException(e); }
                c.setInstanceFollowRedirects(false); c.setConnectTimeout(getConnectTimeout()); c.setReadTimeout(getReadTimeout()); c.setUseCaches(false); c.setRequestMethod(m);
                for (Map.Entry<String, List<String>> e : hs.entrySet()) for (String v : e.getValue()) c.addRequestProperty(e.getKey(), v);
                if (b != null && !"GET".equals(m) && !"HEAD".equals(m)) { c.setDoOutput(true); c.setFixedLengthStreamingMode(b.length); try (OutputStream o = c.getOutputStream()) { o.write(b); } }
                int code = c.getResponseCode(); String loc = c.getHeaderField("Location");
                boolean redirect = (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) && loc != null;
                if (!redirect) { fin = c; at = u; connected = true; return; }
                c.disconnect();
                if (hop >= MAX_HOPS) throw new IOException("too many redirects (more than " + MAX_HOPS + ")");
                URL next = new URL(u, loc); String sch = next.getProtocol().toLowerCase(java.util.Locale.ROOT);
                if (!sch.equals("http") && !sch.equals("https")) throw new IOException("redirect to a non-http address: " + sch);
                if (code == 303 && !"HEAD".equals(m) || (code == 301 || code == 302) && "POST".equals(m)) { m = "GET"; b = null; hs.remove(key(hs, "Content-Type")); hs.remove(key(hs, "Content-Length")); }
                if (!next.getHost().equalsIgnoreCase(u.getHost())) for (String k : new String[] { "Authorization", "Cookie", "Proxy-Authorization" }) hs.remove(key(hs, k));
                u = next;
            }
        }
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
        @Override public Socket createSocket(Socket s, String h, int port, boolean autoClose) throws IOException { int way = wayOf(host, frag); return name(base.createSocket(way > 0 ? new SplitSocket(s, host, way) : new SplitSocket(s, host, 0), host, port, autoClose)); }
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
    /* ---------- how a site's hello goes out: a ladder of ways, the one that works remembered a day per host ----------
     *  plain — whole, as the page sent it.
     *  split — two TLS records, the cut inside the site's name (a filter reading the first record reads none).
     *  frag  — four small records with a breath between them (a filter that puts two together, not more).
     *  tcp   — the record whole, but its first bytes in a packet of their own (a filter that reads one packet).
     *  fake  — a decoy hello first, with a TTL too short to reach the site but long enough for the filter, then the
     *          real one split (the filter judges the decoy, the site never sees it).
     *  A site that answers with a TLS alert right after the hello, or never answers, moves to the next way; the one
     *  that got an answer is kept. */
    static final String[] WAYS = { "plain", "split", "frag", "tcp", "fake" };
    static final Map<String, long[]> ways = new ConcurrentHashMap<>();   // host → {way, failures, since}
    static volatile int fakeTtl = 5;
    private static String wayKey(String host) { return host == null ? "" : host.toLowerCase(); }
    /** The way to send `host`'s hello now. */
    static int wayOf(String host, boolean cutWanted) {
        if ("off".equals(split)) return 0;
        long[] w = ways.get(wayKey(host)); if (w != null) { if (System.currentTimeMillis() - w[2] > 86_400_000L) ways.remove(wayKey(host)); else return (int) w[0]; }
        return cutWanted || "always".equals(split) ? 1 : 0;
    }
    /** `way` got no proper answer from `host`: the next way from now (round the ladder; past the end, back to plain after a rest). */
    static void wayFailed(String host, int way, String why) {
        if ("off".equals(split)) return; String k = wayKey(host); long[] w = ways.get(k); if (w != null && w[0] != way) return;   // (already moved on)
        int next = (way + 1) % WAYS.length; ways.put(k, new long[] { next, w == null ? 1 : w[1] + 1, System.currentTimeMillis() });
        note("way", host, null, -1, WAYS[way] + " " + why + " → " + WAYS[next]);
    }
    /** `way` got an answer from `host`: kept. */
    static void wayWorked(String host, int way) { String k = wayKey(host); long[] w = ways.get(k); if (w == null && way == 0) return; if (w == null || w[0] != way) ways.put(k, new long[] { way, 0, System.currentTimeMillis() }); }
    static org.json.JSONArray waysJson() { org.json.JSONArray a = new org.json.JSONArray(); for (Map.Entry<String, long[]> e : ways.entrySet()) { try { org.json.JSONObject o = new org.json.JSONObject(); o.put("host", e.getKey()); o.put("way", WAYS[(int) e.getValue()[0]]); o.put("failures", e.getValue()[1]); a.put(o); } catch (Exception ignored) {} } return a; }
    static int sniAt(byte[] rec, int off, int len, String host) { byte[] name = host.getBytes(java.nio.charset.StandardCharsets.US_ASCII); outer: for (int i = off + 5; i + name.length <= off + len; i++) { for (int j = 0; j < name.length; j++) if (rec[i + j] != name[j]) continue outer; return i - (off + 5); } return -1; }
    /** The hello record `rec` cut into records at `cuts` (offsets into the body, ascending). */
    static byte[][] cutRecord(byte[] rec, int off, int len, int[] cuts) {
        int recLen = len - 5; List<byte[]> out = new ArrayList<>(); int from = 0;
        for (int c : cuts) { if (c <= from || c >= recLen) continue; out.add(record(rec, off, from, c)); from = c; }
        out.add(record(rec, off, from, recLen)); return out.toArray(new byte[0][]);
    }
    private static byte[] record(byte[] rec, int off, int from, int to) { byte[] b = new byte[5 + to - from]; b[0] = rec[off]; b[1] = rec[off + 1]; b[2] = rec[off + 2]; b[3] = (byte) ((to - from) >> 8); b[4] = (byte) (to - from); System.arraycopy(rec, off + 5 + from, b, 5, to - from); return b; }
    private static void breath(int ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) {} }
    /** The socket's packets' TTL (IPv4) or hop limit (IPv6) set; false when the system will not let us. */
    static boolean ttl(Socket s, int ttl) {
        try {
            // (android.os / android.system by name, so this class also builds and runs off Android.)
            Class<?> pfdC = Class.forName("android.os.ParcelFileDescriptor"); Object pfd = pfdC.getMethod("fromSocket", Socket.class).invoke(null, s); Object fd = pfdC.getMethod("getFileDescriptor").invoke(pfd);
            Class<?> cons = Class.forName("android.system.OsConstants"); boolean v6 = s.getInetAddress() instanceof java.net.Inet6Address;
            int level = cons.getField(v6 ? "IPPROTO_IPV6" : "IPPROTO_IP").getInt(null), opt = cons.getField(v6 ? "IPV6_UNICAST_HOPS" : "IP_TTL").getInt(null);
            Class.forName("android.system.Os").getMethod("setsockoptInt", java.io.FileDescriptor.class, int.class, int.class, int.class).invoke(null, fd, level, opt, ttl);
            return true;
        } catch (Throwable e) { return false; }
    }
    /** `rec` (the page's first record) sent to `up` the `way` asked; a way that cannot be done here falls back to split. */
    static void sendHello(Socket s, OutputStream up, byte[] rec, String host, int way) throws IOException {
        boolean tls = rec.length > 5 && rec[0] == 0x16 && (((rec[3] & 0xff) << 8) | (rec[4] & 0xff)) == rec.length - 5;
        if (!tls || way == 0) { up.write(rec); up.flush(); return; }
        int at = sniAt(rec, 0, rec.length, host); int body = rec.length - 5; int nameLen = host.length();
        switch (WAYS[way]) {
            case "split": { byte[][] two = splitHello(rec, 0, rec.length, host); if (two == null) { up.write(rec); } else { up.write(two[0]); up.flush(); up.write(two[1]); } up.flush(); return; }
            case "frag": { int a = at > 0 ? at : body / 3; int[] cuts = { Math.max(1, Math.min(a + 1, body - 1)), Math.max(2, Math.min(a + Math.max(2, nameLen / 2), body - 1)), Math.max(3, Math.min(a + nameLen + 1, body - 1)) }; for (byte[] r : cutRecord(rec, 0, rec.length, cuts)) { up.write(r); up.flush(); breath(6); } return; }
            case "tcp": { int first = at > 0 ? Math.min(5 + at + 1, rec.length - 1) : 7; up.write(rec, 0, first); up.flush(); breath(40); up.write(rec, first, rec.length - first); up.flush(); return; }
            case "fake": {
                // (The decoy: the same record with another name's bytes and random session/randoms, sent with a short TTL.)
                byte[] decoy = rec.clone(); java.security.SecureRandom rnd = new java.security.SecureRandom(); byte[] junk = new byte[32]; rnd.nextBytes(junk); if (decoy.length > 5 + 11 + 32) System.arraycopy(junk, 0, decoy, 5 + 11, 32);
                if (at > 0) { byte[] other = "www.wikipedia.org".getBytes(java.nio.charset.StandardCharsets.US_ASCII); for (int i = 0; i < nameLen; i++) decoy[5 + at + i] = other[i % other.length]; }
                boolean set = ttl(s, fakeTtl);
                if (set) { up.write(decoy); up.flush(); breath(25); ttl(s, 64); }
                byte[][] two = splitHello(rec, 0, rec.length, host); if (two == null) up.write(rec); else { up.write(two[0]); up.flush(); up.write(two[1]); } up.flush(); return;
            }
            default: up.write(rec); up.flush();
        }
    }
    /** A connected socket whose first write (the hello) goes out in two records; everything else as it is. */
    private static final class SplitSocket extends Socket {
        private final Socket in; private final String host; private OutputStream out; private InputStream ins; final int way; private boolean sentHello = false;
        SplitSocket(Socket in, String host, int way) { this.in = in; this.host = host; this.way = way; try { in.setTcpNoDelay(true); } catch (Exception ignored) {} }
        @Override public synchronized OutputStream getOutputStream() throws IOException {
            if (out == null) out = new FilterOutputStream(in.getOutputStream()) {
                boolean first = true;
                @Override public void write(int b) throws IOException { write(new byte[] { (byte) b }, 0, 1); }
                @Override public void write(byte[] b, int off, int len) throws IOException {
                    if (first) { first = false; sentHello = true; sendHello(in, super.out, java.util.Arrays.copyOfRange(b, off, off + len), host, way); return; }
                    super.out.write(b, off, len);
                }
            };
            return out;
        }
        /** The site's first bytes watched: an alert straight after the hello, or nothing at all, moves the host to the next way. */
        @Override public synchronized InputStream getInputStream() throws IOException {
            if (ins == null) ins = new java.io.FilterInputStream(in.getInputStream()) {
                boolean first = true;
                @Override public int read() throws IOException { byte[] one = new byte[1]; int n = read(one, 0, 1); return n == 1 ? one[0] & 0xff : -1; }
                @Override public int read(byte[] b, int off, int len) throws IOException {
                    int n; try { n = super.read(b, off, len); } catch (IOException e) { if (first && sentHello) { first = false; wayFailed(host, way, "reset"); } throw e; }
                    if (first && n > 0) { first = false; if (b[off] == 0x15) wayFailed(host, way, "alert"); else wayWorked(host, way); }
                    else if (first && n < 0 && sentHello) { first = false; wayFailed(host, way, "silent"); }
                    return n;
                }
            };
            return ins;
        }
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
