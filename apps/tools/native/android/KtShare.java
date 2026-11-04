package app.kurokawa.tools;

import android.util.Log;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Files shared over Wi-Fi (REX Player's web share): a small server on every interface, at an address with a random
 * key, that another phone or computer opens in its browser — a page listing the files, each downloadable with
 * ranges — until it is stopped. No discovery: the address is shown as a QR code and typed or scanned.
 */
final class KtShare {
    private static final String TAG = "KtShare";
    private static KtShare self;
    static synchronized KtShare get() { if (self == null) self = new KtShare(); return self; }

    private ServerSocket server; private int port; private String key = ""; private final List<File> files = new ArrayList<>(); private final List<String> names = new ArrayList<>();
    private volatile long sent = 0; private volatile int hits = 0;

    /** Starts (or restarts) with these files; the address to scan. */
    synchronized String start(List<String> paths, List<String> labels) throws IOException {
        stop();
        files.clear(); names.clear();
        for (int i = 0; i < paths.size(); i++) { File f = new File(paths.get(i)); if (f.isFile()) { files.add(f); names.add(i < labels.size() && labels.get(i) != null && !labels.get(i).isEmpty() ? labels.get(i) : f.getName()); } }
        if (files.isEmpty()) throw new IOException("no files");
        byte[] rnd = new byte[6]; new java.security.SecureRandom().nextBytes(rnd); StringBuilder k = new StringBuilder(); for (byte b : rnd) k.append(String.format("%02x", b)); key = k.toString();
        server = new ServerSocket(0, 8, InetAddress.getByName("0.0.0.0")); port = server.getLocalPort(); sent = 0; hits = 0;
        final ServerSocket srv = server;
        Thread t = new Thread(() -> { while (!srv.isClosed()) { try { Socket s = srv.accept(); new Thread(() -> serve(s), "kt-share").start(); } catch (IOException e) { break; } } }, "kt-share-accept");
        t.setDaemon(true); t.start();
        return url();
    }
    synchronized void stop() { if (server != null) { try { server.close(); } catch (IOException ignored) {} server = null; } }
    synchronized boolean running() { return server != null && !server.isClosed(); }
    synchronized String url() { String ip = lanIp(); return ip == null || !running() ? null : "http://" + ip + ":" + port + "/" + key + "/"; }
    long sentBytes() { return sent; } int hitCount() { return hits; } int fileCount() { return files.size(); }

    /** The phone's address on its Wi-Fi (a site-local IPv4; the hotspot's 192.168.43.1 and the like included). */
    static String lanIp() {
        try {
            String fallback = null;
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue; String nm = ni.getName();
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof java.net.Inet4Address) || a.isLoopbackAddress()) continue;
                    if (nm.startsWith("wlan") || nm.startsWith("ap") || nm.startsWith("swlan") || nm.startsWith("eth")) return a.getHostAddress();
                    if (a.isSiteLocalAddress() && fallback == null) fallback = a.getHostAddress();
                }
            }
            return fallback;
        } catch (Exception e) { return null; }
    }

    private static String esc(String s) { return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;"); }
    private static String human(long b) { if (b < 1024) return b + " B"; double v = b / 1024.0; String[] u = { "KB", "MB", "GB", "TB" }; int i = 0; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return String.format(java.util.Locale.US, v >= 100 ? "%.0f %s" : "%.1f %s", v, u[i]); }

    private void serve(Socket s) {
        try (Socket sock = s) {
            sock.setSoTimeout(30000);
            InputStream in = sock.getInputStream(); OutputStream rawOut = sock.getOutputStream();
            String line = KtStream.readLine(in); if (line == null) return; String[] req = line.split(" "); if (req.length < 2) return;
            String path = req[1]; long rangeStart = 0, rangeEnd = -1; boolean ranged = false;
            for (String h; (h = KtStream.readLine(in)) != null && !h.isEmpty(); ) { if (h.toLowerCase().startsWith("range:")) { String v = h.substring(6).trim().replace("bytes=", ""); String[] p = v.split("-"); try { rangeStart = Long.parseLong(p[0].trim()); if (p.length > 1 && !p[1].trim().isEmpty()) rangeEnd = Long.parseLong(p[1].trim()); ranged = true; } catch (NumberFormatException ignored) {} } }
            BufferedOutputStream out = new BufferedOutputStream(rawOut, 1 << 16);
            String prefix = "/" + key + "/";
            if (!path.startsWith(prefix)) { out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
            String rest = path.substring(prefix.length()); int q = rest.indexOf('?'); if (q >= 0) rest = rest.substring(0, q);
            hits++;
            if (rest.isEmpty() || rest.equals("index.html")) {
                StringBuilder html = new StringBuilder("<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Kurokawa Tools</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#141218;color:#e6e0e9}h1{font-size:18px;padding:18px 20px;margin:0;background:#211f26}a{display:flex;justify-content:space-between;gap:12px;padding:14px 20px;color:#d0bcff;text-decoration:none;border-bottom:1px solid #2b2930}a:hover{background:#1d1b20}small{color:#cac4d0}p{padding:10px 20px;color:#cac4d0;font-size:13px}</style></head><body><h1>Kurokawa Tools</h1>");
                for (int i = 0; i < files.size(); i++) html.append("<a href='d/").append(i).append("/").append(java.net.URLEncoder.encode(names.get(i), "UTF-8").replace("+", "%20")).append("' download>").append("<span>").append(esc(names.get(i))).append("</span><small>").append(human(files.get(i).length())).append("</small></a>");
                html.append("<p>").append(files.size()).append(" file(s)</p></body></html>");
                byte[] body = html.toString().getBytes(StandardCharsets.UTF_8);
                out.write(("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                if (!"HEAD".equals(req[0])) out.write(body); out.flush(); return;
            }
            if (rest.startsWith("d/")) {
                String[] parts = rest.split("/"); int i; try { i = Integer.parseInt(parts[1]); } catch (Exception e) { i = -1; }
                if (i < 0 || i >= files.size()) { out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
                File lf = files.get(i); long lsize = lf.length(); if (rangeEnd < 0 || rangeEnd >= lsize) rangeEnd = lsize - 1;
                if (rangeStart > rangeEnd) { out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + lsize + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
                long llen = rangeEnd - rangeStart + 1;
                out.write(((ranged ? "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes " + rangeStart + "-" + rangeEnd + "/" + lsize + "\r\n" : "HTTP/1.1 200 OK\r\n") + "Content-Type: " + KtStream.mimeOf(lf.getName()) + "\r\nAccept-Ranges: bytes\r\nContent-Length: " + llen + "\r\nContent-Disposition: attachment; filename*=UTF-8''" + java.net.URLEncoder.encode(names.get(i), "UTF-8").replace("+", "%20") + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                if ("HEAD".equals(req[0])) { out.flush(); return; }
                try (RandomAccessFile raf = new RandomAccessFile(lf, "r")) { raf.seek(rangeStart); byte[] b = new byte[1 << 17]; long left = llen; while (left > 0) { int n = raf.read(b, 0, (int) Math.min(b.length, left)); if (n <= 0) break; out.write(b, 0, n); left -= n; sent += n; } }
                out.flush(); return;
            }
            out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); out.flush();
        } catch (Exception e) { Log.d(TAG, "serve: " + e); }
    }
}
