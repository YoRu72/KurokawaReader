package app.kurokawa.reader;

import java.io.ByteArrayOutputStream;
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
 * as 1DM+ offers it: a site's name asked of a resolver over HTTPS (Cloudflare, Google, Quad9, AdGuard, or one
 * the reader gives) instead of the network's DNS — a site a provider hides by its name is reached all the same.
 *
 * Done the way HTTPDNS libraries do it on Android, with the platform's own connection: the request goes to the
 * address found, the site's name kept in its Host header, in the TLS handshake (SNI) and in the check of its
 * certificate. Plain Java (no Android classes), so it is tested on its own (tests/native/doh).
 */
final class KrDoh {
    private KrDoh() {}

    /** "off", a provider's name, or the address of a resolver ("https://…/dns-query"). */
    static volatile String provider = "off";

    static boolean on() { String p = provider; return p != null && !p.isEmpty() && !"off".equals(p); }

    /** Each provider: its resolver's address and the addresses to reach it by (asked of no DNS at all). */
    private static String[] endpoint(String p) {
        switch (p) {
            case "cloudflare": return new String[] { "https://cloudflare-dns.com/dns-query", "1.1.1.1", "1.0.0.1" };
            case "google": return new String[] { "https://dns.google/dns-query", "8.8.8.8", "8.8.4.4" };
            case "quad9": return new String[] { "https://dns.quad9.net/dns-query", "9.9.9.9", "149.112.112.112" };
            case "adguard": return new String[] { "https://dns.adguard-dns.com/dns-query", "94.140.14.14", "94.140.15.15" };
            default: return p.startsWith("https://") ? new String[] { p } : null;
        }
    }

    private static final class Entry { final InetAddress[] ips; final long until; Entry(InetAddress[] ips, long until) { this.ips = ips; this.until = until; } }
    private static final Map<String, Entry> cache = new ConcurrentHashMap<>();
    static void forget() { cache.clear(); neededAt.clear(); }

    /** The addresses of `host`, asked of the resolver (kept for their time to live, at least a minute). */
    static InetAddress[] resolve(String host) throws IOException {
        if (isLiteral(host)) return new InetAddress[] { InetAddress.getByName(host) };
        String p = provider; String key = p + "|" + host.toLowerCase();
        Entry e = cache.get(key);
        if (e != null && e.until > System.currentTimeMillis()) return e.ips;
        String[] ep = endpoint(p);
        if (ep == null) return InetAddress.getAllByName(host);
        byte[] query = query(host, 1);
        IOException last = null;
        // (The resolver by each of its own addresses in turn; one given by address only, by its name.)
        for (int i = ep.length > 1 ? 1 : 0; i < ep.length; i++) {
            try {
                long[] ttl = { 300 };
                InetAddress[] ips = parse(ask(new URL(ep[0]), ep.length > 1 ? ep[i] : null, query), ttl);
                if (ips.length == 0) {
                    // (No IPv4 address: its IPv6 ones.)
                    ips = parse(ask(new URL(ep[0]), ep.length > 1 ? ep[i] : null, query(host, 28)), ttl);
                }
                if (ips.length == 0) throw new java.net.UnknownHostException(host);
                cache.put(key, new Entry(ips, System.currentTimeMillis() + Math.max(60, Math.min(3600, ttl[0])) * 1000));
                return ips;
            } catch (IOException ex) { last = ex; }
        }
        throw last != null ? last : new java.net.UnknownHostException(host);
    }

    /** For the web views: whether `host` needs the resolver at all — the network's DNS gives it no address, or
     *  one that is no site's (0.0.0.0, the device itself, a home network's), or addresses none of which the
     *  resolver gives (a provider's page put in the site's place). A site the network's DNS gives as it is is left
     *  to the web view's own requests: a site's check (Cloudflare) wants the browser's own connection, and the
     *  clearance it gives holds for that connection only. Kept ten minutes a name. */
    private static final Map<String, long[]> neededAt = new ConcurrentHashMap<>();
    static boolean needed(String host) {
        if (!on() || isLiteral(host)) return false;
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
        return need;
    }
    private static boolean sameNet(InetAddress a, InetAddress b) {
        byte[] x = a.getAddress(), y = b.getAddress();
        if (x.length != y.length) return false;
        int n = x.length == 4 ? 2 : 4;   // (a /16 of IPv4, a /32 of IPv6)
        for (int i = 0; i < n; i++) if (x[i] != y[i]) return false;
        return true;
    }

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
    private static int u16(byte[] m, int i) { return ((m[i] & 0xff) << 8) | (m[i + 1] & 0xff); }
    private static int skipName(byte[] m, int p) {
        while (p < m.length) { int l = m[p] & 0xff; if (l == 0) return p + 1; if ((l & 0xc0) == 0xc0) return p + 2; p += l + 1; }
        return p;
    }

    /** The question posted to the resolver (RFC 8484), by `ip` when given (its name kept for TLS). */
    private static byte[] ask(URL resolver, String ip, byte[] q) throws IOException {
        HttpURLConnection c = ip != null ? connectTo(resolver, ip) : (HttpURLConnection) resolver.openConnection();
        c.setConnectTimeout(8000); c.setReadTimeout(8000);
        c.setRequestMethod("POST"); c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/dns-message");
        c.setRequestProperty("Accept", "application/dns-message");
        try (OutputStream os = c.getOutputStream()) { os.write(q); }
        if (c.getResponseCode() != 200) { c.disconnect(); throw new IOException("DoH HTTP " + c.getResponseCode()); }
        try (InputStream in = c.getInputStream()) { ByteArrayOutputStream b = new ByteArrayOutputStream(); byte[] buf = new byte[4096]; int n; while ((n = in.read(buf)) > 0) b.write(buf, 0, n); return b.toByteArray(); }
    }

    /**
     * A connection to `url` that goes to the address the resolver gives for its host (redirects not followed:
     * the caller follows them, by their own names). With DoH off, the plain connection.
     */
    static HttpURLConnection open(URL url) throws IOException {
        if (!on()) return (HttpURLConnection) url.openConnection();
        InetAddress[] ips = resolve(url.getHost());
        HttpURLConnection c = connectTo(url, ips[0].getHostAddress());
        c.setInstanceFollowRedirects(false);
        return c;
    }

    /** `url` asked of `ip`: the name kept in the Host header, the TLS handshake and the certificate's check. */
    private static HttpURLConnection connectTo(URL url, String ip) throws IOException {
        final String host = url.getHost();
        String literal = ip.contains(":") ? "[" + ip + "]" : ip;
        URL byIp = new URL(url.getProtocol(), literal, url.getPort(), url.getFile());
        HttpURLConnection c = (HttpURLConnection) byIp.openConnection();
        c.setRequestProperty("Host", url.getPort() > 0 && url.getPort() != url.getDefaultPort() ? host + ":" + url.getPort() : host);
        if (c instanceof HttpsURLConnection) {
            HttpsURLConnection s = (HttpsURLConnection) c;
            s.setSSLSocketFactory(new SniFactory(HttpsURLConnection.getDefaultSSLSocketFactory(), host));
            final HostnameVerifier def = HttpsURLConnection.getDefaultHostnameVerifier();
            s.setHostnameVerifier((String h, SSLSession session) -> def.verify(host, session));
        }
        return c;
    }

    /** TLS sockets that name the site, not the address they were opened to. */
    private static final class SniFactory extends SSLSocketFactory {
        private final SSLSocketFactory base; private final String host;
        SniFactory(SSLSocketFactory base, String host) { this.base = base; this.host = host; }
        @Override public String[] getDefaultCipherSuites() { return base.getDefaultCipherSuites(); }
        @Override public String[] getSupportedCipherSuites() { return base.getSupportedCipherSuites(); }
        @Override public Socket createSocket(Socket s, String h, int port, boolean autoClose) throws IOException { return name(base.createSocket(s, host, port, autoClose)); }
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
}
