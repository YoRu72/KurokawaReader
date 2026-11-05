package app.kurokawa.tools;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The app's own proxy for its web views (and anything else told to use it): a small HTTP proxy on the device
 * itself, 127.0.0.1 and a free port, that the web views are pointed at while DNS over HTTPS is on. Every
 * connection a page makes — pages, scripts, pictures, forms sent, WebSockets, a site's check — then comes
 * here, and here:
 *  - the site's name is looked up through the resolver (KrDoh), never the network's DNS;
 *  - an HTTPS connection (CONNECT) is tunnelled as it is — TLS stays end to end between the page and the site,
 *    so certificates, cookies and a site's check are the web view's own — but its first record, the TLS hello,
 *    is cut in two on the wire (KrDoh.splitHello) when the site is one the network hides or blocks (or always,
 *    as chosen): a filter reading the site's name out of the first packet reads none;
 *  - a plain HTTP request is forwarded by the address found, with Connection: close so each is whole.
 * A site whose tunnel dies before the site said anything is marked (KrDoh.force), so the next attempt splits
 * the hello. Plain Java (no Android classes), so it is tested on its own.
 */
final class KrDohProxy {
    private KrDohProxy() {}
    private static ServerSocket server; private static volatile int port;
    static final AtomicLong tunnels = new AtomicLong(), bytesUp = new AtomicLong(), bytesDown = new AtomicLong(); static final AtomicInteger open = new AtomicInteger();

    static synchronized int start() throws IOException {
        if (server != null && !server.isClosed()) return port;
        ServerSocket s = new ServerSocket(); s.setReuseAddress(true); s.bind(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 64);
        server = s; port = s.getLocalPort();
        Thread t = new Thread(() -> { while (!s.isClosed()) { try { Socket c = s.accept(); Thread w = new Thread(() -> serve(c), "kt-proxy"); w.setDaemon(true); w.start(); } catch (IOException e) { break; } catch (Throwable e) { KrDoh.note("proxy", null, null, -1, "accept: " + e); } } }, "kt-proxy-accept");
        t.setDaemon(true); t.start();
        // (Asked of itself before anyone else is pointed at it: a ping through its own port, answered at once.)
        try { selfTest(port); } catch (IOException e) { stop(); throw new IOException("proxy self-test: " + e.getMessage()); }
        KrDoh.note("proxy", null, "127.0.0.1:" + port, -1, "started");
        return port;
    }
    private static void selfTest(int port) throws IOException {
        try (Socket c = new Socket()) {
            c.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 3000); c.setSoTimeout(3000);
            c.getOutputStream().write("GET http://127.0.0.1/__kt/ping HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); c.getOutputStream().flush();
            String line = KtStream.readLine(c.getInputStream()); if (line == null || !line.contains("200")) throw new IOException("no answer: " + line);
        }
    }
    static synchronized void stop() { if (server != null) { try { server.close(); } catch (IOException ignored) {} server = null; port = 0; KrDoh.note("proxy", null, null, -1, "stopped"); } }
    static boolean running() { ServerSocket s = server; return s != null && !s.isClosed(); }
    static int port() { return running() ? port : 0; }

    private static void serve(Socket client) {
        open.incrementAndGet();
        try (Socket c = client) {
            // (A page's connection waits for its request a while — the web view opens some ahead of need and may
            // send nothing for a time — then, once a tunnel, as long as either side keeps it.)
            c.setSoTimeout(90000); c.setTcpNoDelay(true);
            BufferedInputStream in = new BufferedInputStream(c.getInputStream(), 1 << 14); OutputStream out = c.getOutputStream();
            String line = KtStream.readLine(in); if (line == null || line.isEmpty()) return;
            String[] req = line.split(" "); if (req.length < 2) { reply(out, 400, "Bad Request"); return; }
            java.util.Map<String, String> headers = new java.util.LinkedHashMap<>();
            for (String h; (h = KtStream.readLine(in)) != null && !h.isEmpty(); ) { int k = h.indexOf(':'); if (k > 0) headers.put(h.substring(0, k).trim(), h.substring(k + 1).trim()); }
            if (req[1].endsWith("/__kt/ping")) { byte[] b = "pong".getBytes(StandardCharsets.US_ASCII); out.write(("HTTP/1.1 200 OK\r\nContent-Length: " + b.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); out.write(b); out.flush(); return; }
            try {
                if ("CONNECT".equalsIgnoreCase(req[0])) { tunnel(c, in, out, req[1]); return; }
                forward(c, in, out, req, headers);
            } catch (Throwable e) {
                // (Whatever went wrong, the page is answered, never left with a closed connection — which the web view
                // takes for a proxy that is down and stops using.)
                KrDoh.note("proxy", req[1], null, -1, "error: " + KrDoh.clean(String.valueOf(e)));
                try { reply(out, 502, "Bad Gateway"); } catch (IOException ignored) {}
            }
        } catch (Throwable ignored) { /* the connection is gone */ }
        finally { open.decrementAndGet(); }
    }
    private static void reply(OutputStream out, int code, String text) throws IOException { out.write(("HTTP/1.1 " + code + " " + text + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); out.flush(); }

    /** Whether the hello to `host` is cut: always, never, or for a site the network hides or blocks (see KrDoh.split). */
    static boolean cut(String host) {
        String sp = KrDoh.split;
        if ("off".equals(sp)) return false; if ("always".equals(sp)) return true;
        if (KrDoh.isForced(host)) return true;
        Boolean n = KrDoh.neededCached(host); if (n != null) return n;
        try { return KrDoh.needed(host); } catch (Exception e) { return false; }
    }

    /** The site's address, through the resolver; the connection to it. */
    private static Socket connect(String host, int port) throws IOException {
        InetAddress[] ips = KrDoh.on() ? KrDoh.resolve(host) : InetAddress.getAllByName(host);
        IOException last = null;
        for (int i = 0; i < Math.min(3, ips.length); i++) {
            Socket s = new Socket();
            try { s.setTcpNoDelay(true); s.connect(new InetSocketAddress(ips[i], port), 12000); s.setSoTimeout(0); return s; }
            catch (IOException e) { last = e; try { s.close(); } catch (IOException ignored) {} }
        }
        throw last != null ? last : new IOException("no address: " + host);
    }

    /** CONNECT host:port — the tunnel: the hello cut when asked, then the bytes carried both ways. */
    private static void tunnel(Socket client, InputStream in, OutputStream out, String target) throws IOException {
        int k = target.lastIndexOf(':'); String host = k > 0 ? target.substring(0, k) : target; int port = 443; try { if (k > 0) port = Integer.parseInt(target.substring(k + 1)); } catch (NumberFormatException ignored) {}
        if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
        Socket site;
        try { site = connect(host, port); }
        catch (Throwable e) { KrDoh.note("proxy", host, null, -1, "unreachable: " + KrDoh.clean(String.valueOf(e.getMessage()))); reply(out, 502, "Bad Gateway"); return; }
        tunnels.incrementAndGet();
        // (Whether the hello is cut is settled before the page is told to go on: the web view sends it at once.)
        final String h = host; final boolean split = cut(host); final int way = KrDoh.wayOf(host, split); final boolean[] siteSpoke = { false }; final boolean[] alert = { false }; boolean sent = false;
        out.write("HTTP/1.1 200 Connection established\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); out.flush();
        client.setSoTimeout(0); site.setSoTimeout(0);
        try (Socket s = site) {
            OutputStream up = s.getOutputStream(); InputStream down = s.getInputStream();
            // (The first bytes from the page: the hello, cut in two on the wire when asked; whole otherwise.)
            byte[] first = hello(in); if (first == null) return; sent = true;
            KrDoh.sendHello(s, up, first, h, way); bytesUp.addAndGet(first.length);
            Thread pump = new Thread(() -> { try { copy(down, out, bytesDown, siteSpoke, alert); } catch (IOException ignored) {} finally { try { client.shutdownOutput(); } catch (IOException ignored) {} try { s.close(); } catch (IOException ignored) {} } }, "kt-proxy-down");
            pump.setDaemon(true); pump.start();
            try { copy(in, up, bytesUp, null); } catch (IOException ignored) {}
            try { s.shutdownOutput(); } catch (IOException ignored) {}
            // (The page done sending: the site's answer carried to its end, however long.)
            try { pump.join(); } catch (InterruptedException ignored) {}
        } finally {
            // (A tunnel the site never spoke on — reset or dropped before its first byte — on a name the network
            // gives as it is: a filter on the way; the site is forced through the split hello from now.)
            if (sent && KrDoh.on()) {
                if (alert[0]) KrDoh.wayFailed(h, way, "alert");
                else if (!siteSpoke[0]) { if (!split && way == 0) KrDoh.force(h); KrDoh.wayFailed(h, way, "silent"); }
                else KrDoh.wayWorked(h, way);
            }
        }
    }
    /** The page's first record (a TLS hello is one record: read whole, so the cut lands inside it), or whatever came first. */
    static byte[] hello(InputStream in) throws IOException {
        byte[] head = new byte[5]; int got = 0;
        while (got < 5) { int n = in.read(head, got, 5 - got); if (n < 0) return got == 0 ? null : java.util.Arrays.copyOf(head, got); got += n; }
        if (head[0] != 0x16) return head;   // (not TLS: sent on as it is; the rest follows in the pump)
        int len = ((head[3] & 0xff) << 8) | (head[4] & 0xff); if (len <= 0 || len > 16384 + 2048) return head;
        byte[] rec = new byte[5 + len]; System.arraycopy(head, 0, rec, 0, 5); int p = 5;
        while (p < rec.length) { int n = in.read(rec, p, rec.length - p); if (n < 0) return java.util.Arrays.copyOf(rec, p); p += n; }
        return rec;
    }
    private static void copy(InputStream from, OutputStream to, AtomicLong count, boolean[] spoke) throws IOException { copy(from, to, count, spoke, null); }
    private static void copy(InputStream from, OutputStream to, AtomicLong count, boolean[] spoke, boolean[] alert) throws IOException {
        byte[] b = new byte[1 << 15]; int n; boolean first = true;
        while ((n = from.read(b)) > 0) { if (first) { first = false; if (alert != null && b[0] == 0x15) alert[0] = true; } if (spoke != null && !(alert != null && alert[0])) spoke[0] = true; to.write(b, 0, n); to.flush(); count.addAndGet(n); }
    }

    /** A plain request (GET http://site/path …): sent to the site by the address found, the answer carried back, the connection closed after. */
    private static void forward(Socket client, InputStream in, OutputStream out, String[] req, java.util.Map<String, String> headers) throws IOException {
        String url = req[1]; String host; int port = 80; String path;
        if (url.regionMatches(true, 0, "http://", 0, 7)) { String rest = url.substring(7); int slash = rest.indexOf('/'); String hp = slash < 0 ? rest : rest.substring(0, slash); path = slash < 0 ? "/" : rest.substring(slash); int k = hp.lastIndexOf(':'); host = k > 0 ? hp.substring(0, k) : hp; try { if (k > 0) port = Integer.parseInt(hp.substring(k + 1)); } catch (NumberFormatException ignored) {} }
        else { String hp = headers.get("Host"); if (hp == null) { reply(out, 400, "Bad Request"); return; } int k = hp.lastIndexOf(':'); host = k > 0 ? hp.substring(0, k) : hp; try { if (k > 0) port = Integer.parseInt(hp.substring(k + 1)); } catch (NumberFormatException ignored) {} path = url; }
        Socket site;
        try { site = connect(host, port); } catch (IOException e) { KrDoh.note("proxy", host, null, -1, "unreachable: " + e.getMessage()); reply(out, 502, "Bad Gateway"); return; }
        tunnels.incrementAndGet();
        try (Socket s = site) {
            OutputStream up = s.getOutputStream(); InputStream down = s.getInputStream();
            StringBuilder sb = new StringBuilder(req[0]).append(' ').append(path).append(' ').append(req.length > 2 ? req[2] : "HTTP/1.1").append("\r\n");
            long len = -1; boolean chunked = false;
            for (java.util.Map.Entry<String, String> e : headers.entrySet()) {
                String k = e.getKey().toLowerCase(Locale.ROOT);
                if (k.equals("proxy-connection") || k.equals("connection") || k.equals("keep-alive") || k.equals("proxy-authorization")) continue;
                if (k.equals("content-length")) try { len = Long.parseLong(e.getValue().trim()); } catch (NumberFormatException ignored) {}
                if (k.equals("transfer-encoding") && e.getValue().toLowerCase(Locale.ROOT).contains("chunked")) chunked = true;
                sb.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
            }
            sb.append("Connection: close\r\n\r\n");
            up.write(sb.toString().getBytes(StandardCharsets.ISO_8859_1)); up.flush();
            // (The request's body, when it has one: by its length, or chunked to the end.)
            if (len > 0) { byte[] b = new byte[1 << 14]; long left = len; while (left > 0) { int n = in.read(b, 0, (int) Math.min(b.length, left)); if (n < 0) break; up.write(b, 0, n); left -= n; } up.flush(); }
            else if (chunked) { Thread t = new Thread(() -> { try { copy(in, up, bytesUp, null); } catch (IOException ignored) {} }, "kt-proxy-body"); t.setDaemon(true); t.start(); }
            copy(down, out, bytesDown, null);
        } catch (IOException ignored) {}
    }

    /** What the page shows: whether it runs, where, and how much went through. */
    static org.json.JSONObject status() {
        org.json.JSONObject o = new org.json.JSONObject();
        try { o.put("running", running()); o.put("port", port()); o.put("tunnels", tunnels.get()); o.put("open", open.get()); o.put("up", bytesUp.get()); o.put("down", bytesDown.get()); } catch (Exception ignored) {}
        return o;
    }
}
