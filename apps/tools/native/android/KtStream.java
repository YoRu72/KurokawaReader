package app.kurokawa.tools;

import org.libtorrent4j.FileStorage;
import org.libtorrent4j.PeerRequest;
import org.libtorrent4j.Priority;
import org.libtorrent4j.TorrentHandle;
import org.libtorrent4j.TorrentInfo;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * A small HTTP server on 127.0.0.1 that plays a torrent's file while it comes: GET /{taskId}/{fileIndex}
 * with Range requests; a piece not here yet is asked for first (a deadline on it and the ones after) and
 * waited for. A player (the app's own, or any other on the phone) reads it like any URL.
 */
final class KtStream {
    private final KtEngine engine;
    private ServerSocket server; private int port;
    KtStream(KtEngine engine) { this.engine = engine; }

    synchronized String url(String taskId, int fileIndex) throws IOException {
        if (server == null || server.isClosed()) {
            server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1")); port = server.getLocalPort();
            Thread t = new Thread(() -> { while (!server.isClosed()) { try { Socket s = server.accept(); new Thread(() -> serve(s), "kt-stream").start(); } catch (IOException e) { break; } } }, "kt-stream-accept");
            t.setDaemon(true); t.start();
        }
        if (!taskId.isEmpty()) engine.prepareStream(taskId, fileIndex);
        return "http://127.0.0.1:" + port + "/" + taskId + "/" + fileIndex;
    }
    /** A content:// document's URL on this server (a video handed over by another app), served with ranges. */
    synchronized String contentUrl(String uri) throws IOException { url("", 0); long e = System.currentTimeMillis() + 12L * 3600_000; return "http://127.0.0.1:" + port + "/content?u=" + java.net.URLEncoder.encode(uri, "UTF-8") + "&e=" + e + "&t=" + sign(uri, e); }
    /** Entries inside archives handed out by id (the password stays here, never in the URL): id → {archive, password, entry}. */
    private final java.util.Map<String, String[]> arcEntries = java.util.Collections.synchronizedMap(new java.util.LinkedHashMap<String, String[]>(64, 0.75f, true) { @Override protected boolean removeEldestEntry(java.util.Map.Entry<String, String[]> e) { return size() > 200; } });
    /** A file inside an archive's URL on this server, read straight from the archive. */
    synchronized String archiveEntryUrl(String archive, String password, String entry) throws IOException {
        url("", 0); String id = java.util.UUID.randomUUID().toString().replace("-", ""); arcEntries.put(id, new String[] { archive, password == null ? "" : password, entry });
        return "http://127.0.0.1:" + port + "/arc/" + id + "/" + java.net.URLEncoder.encode(entry.replaceAll(".*/", ""), "UTF-8").replace("+", "%20");
    }
    /** A local file's URL on this server. */
    /** A local file's URL: signed and expiring (twelve hours), so nothing else on the phone can read files through this server by guessing a path. */
    synchronized String fileUrl(String path) throws IOException { url("", 0); long e = System.currentTimeMillis() + 12L * 3600_000; return "http://127.0.0.1:" + port + "/file?p=" + java.net.URLEncoder.encode(path, "UTF-8") + "&e=" + e + "&t=" + sign(path, e); }
    private final byte[] secret = new byte[32]; { new java.security.SecureRandom().nextBytes(secret); }
    private String sign(String what, long e) { try { javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256"); mac.init(new javax.crypto.spec.SecretKeySpec(secret, "HmacSHA256")); byte[] d = mac.doFinal((what + "|" + e).getBytes(StandardCharsets.UTF_8)); StringBuilder sb = new StringBuilder(); for (int i = 0; i < 12; i++) sb.append(String.format(java.util.Locale.US, "%02x", d[i])); return sb.toString(); } catch (Exception ex) { return ""; } }
    /** The query's token checked against its path and expiry. */
    private boolean signed(String what, java.util.Map<String, String> q) { try { long e = Long.parseLong(q.getOrDefault("e", "0")); if (e < System.currentTimeMillis()) return false; String t = q.getOrDefault("t", ""); return !t.isEmpty() && java.security.MessageDigest.isEqual(t.getBytes(StandardCharsets.US_ASCII), sign(what, e).getBytes(StandardCharsets.US_ASCII)); } catch (Exception ex) { return false; } }
    private static java.util.Map<String, String> query(String path) { java.util.Map<String, String> m = new java.util.HashMap<>(); int q = path.indexOf('?'); if (q < 0) return m; for (String kv : path.substring(q + 1).split("&")) { int eq = kv.indexOf('='); if (eq <= 0) continue; try { m.put(kv.substring(0, eq), java.net.URLDecoder.decode(kv.substring(eq + 1), "UTF-8")); } catch (Exception ignored) {} } return m; }

    /** A remote stream's URL on this server, fetched with the headers it needs (a referer, a cookie): what an online
     *  source's `<video>` reads, since a web view cannot set those itself. HLS playlists are rewritten so their
     *  parts come the same way. */
    synchronized String proxyUrl(String u, String headersJson) throws IOException {
        if (!isHttp(u)) throw new IOException("refused: not http(s)");
        url("", 0); String hj = headersJson == null ? "{}" : headersJson; long e = System.currentTimeMillis() + 12L * 3600_000;
        // (Signed over the source and its headers, with an expiry, as /file is: no other app on the phone can use this server as a proxy.)
        return "http://127.0.0.1:" + port + "/proxy?u=" + java.net.URLEncoder.encode(u, "UTF-8") + "&h=" + java.net.URLEncoder.encode(hj, "UTF-8") + "&e=" + e + "&t=" + sign(u + "\n" + hj, e);
    }
    static boolean isHttp(String u) { if (u == null) return false; String l = u.toLowerCase(java.util.Locale.ROOT); return l.startsWith("http://") || l.startsWith("https://"); }
    /** CORS for the app's own page only (Capacitor's https://localhost), never «*». */
    private static final String APP_CORS = "Access-Control-Allow-Origin: https://localhost\r\nVary: Origin\r\n";
    private static String param(String q, String k) throws IOException { for (String kv : q.split("&")) { int i = kv.indexOf('='); if (i > 0 && kv.substring(0, i).equals(k)) return java.net.URLDecoder.decode(kv.substring(i + 1), "UTF-8"); } return null; }
    private void proxy(String path, String method, String range, OutputStream out) throws Exception {
        String q = path.substring(path.indexOf('?') + 1); String u = param(q, "u"); String hj = param(q, "h"); if (hj == null) hj = "{}";
        java.util.Map<String, String> qm = query(path);
        if (u == null || !isHttp(u) || !signed(u + "\n" + hj, qm)) { out.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
        org.json.JSONObject hd = new org.json.JSONObject(hj);
        java.net.HttpURLConnection c = null; java.net.URL url = new java.net.URL(u);
        for (int hop = 0; hop < 6; hop++) {
            c = KrDoh.open(url); c.setInstanceFollowRedirects(false); c.setConnectTimeout(15000); c.setReadTimeout(30000); c.setRequestMethod("HEAD".equals(method) ? "HEAD" : "GET");
            for (java.util.Iterator<String> it = hd.keys(); it.hasNext(); ) { String k = it.next(); c.setRequestProperty(k, hd.optString(k)); }
            if (!hd.has("User-Agent") && !hd.has("user-agent")) c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Mobile Safari/537.36");
            if (range != null) c.setRequestProperty("Range", range);
            int code = c.getResponseCode();
            if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) { url = new java.net.URL(url, c.getHeaderField("Location")); c.disconnect(); if (!isHttp(url.toString())) throw new IOException("refused: redirect"); continue; }
            break;
        }
        int code = c.getResponseCode(); String type = c.getContentType() == null ? "" : c.getContentType();
        boolean playlist = type.toLowerCase().contains("mpegurl") || url.getPath().toLowerCase().endsWith(".m3u8");
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        if (playlist && code < 400) {
            java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream(); byte[] buf = new byte[16384]; int n; while ((n = in.read(buf)) > 0) b.write(buf, 0, n); in.close();
            String text = new String(b.toByteArray(), StandardCharsets.UTF_8); StringBuilder sb = new StringBuilder(); java.util.regex.Pattern attr = java.util.regex.Pattern.compile("URI=\"([^\"]+)\"");
            for (String line : text.split("\r?\n")) {
                String t = line.trim();
                if (t.isEmpty()) { sb.append('\n'); continue; }
                if (t.startsWith("#")) { java.util.regex.Matcher m = attr.matcher(t); StringBuffer r = new StringBuffer(); while (m.find()) m.appendReplacement(r, java.util.regex.Matcher.quoteReplacement("URI=\"" + proxyUrl(new java.net.URL(url, m.group(1)).toString(), hj) + "\"")); m.appendTail(r); sb.append(r).append('\n'); }
                else sb.append(proxyUrl(new java.net.URL(url, t).toString(), hj)).append('\n');
            }
            byte[] body = sb.toString().getBytes(StandardCharsets.UTF_8);
            out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n" + APP_CORS + "\r\n").getBytes(StandardCharsets.US_ASCII));
            if (!"HEAD".equals(method)) out.write(body); out.flush(); return;
        }
        StringBuilder head = new StringBuilder("HTTP/1.1 " + code + " " + (c.getResponseMessage() == null ? "" : c.getResponseMessage()) + "\r\n");
        for (String k : new String[] { "Content-Type", "Content-Length", "Content-Range", "Accept-Ranges" }) { String v = c.getHeaderField(k); if (v != null) head.append(k).append(": ").append(v).append("\r\n"); }
        head.append("Connection: close\r\n" + APP_CORS + "\r\n");
        out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
        if (in != null && !"HEAD".equals(method)) { byte[] buf = new byte[1 << 16]; int n; while ((n = in.read(buf)) > 0) out.write(buf, 0, n); in.close(); }
        out.flush(); c.disconnect();
    }

    /* ---------- the relay for another app's player (src/player/external; desktop/relay.cjs's twin) ----------
     * A session per playback, its random token in the path (/r/<token>/v|u|s/…), closed when the playback ends
     * (relayClose) or after six idle hours: a source's headers sent for the player, an HLS playlist rewritten so
     * every segment, key and sub-playlist is a numbered address of the same session (no URL taken from a request),
     * a site's subtitles served beside it. Only http(s); redirects followed here one hop at a time; the cookie,
     * authorisation and the page's other headers go only to the source's own origin (another host gets the user agent
     * and the referer only). No file is ever read for another app here, and no CORS: players, not pages. */
    private static final class Relay { String url, origin, headers; org.json.JSONArray subs; final java.util.ArrayList<String> urls = new java.util.ArrayList<>(); final java.util.HashMap<String, Integer> ids = new java.util.HashMap<>(); volatile long last = System.currentTimeMillis(); volatile int reads, reading; volatile boolean gone; }
    private final java.util.Map<String, Relay> relays = java.util.Collections.synchronizedMap(new java.util.HashMap<>());
    private static String originOf(String u) { try { java.net.URL x = new java.net.URL(u); return x.getProtocol() + "://" + x.getHost() + ":" + (x.getPort() < 0 ? x.getDefaultPort() : x.getPort()); } catch (Exception e) { return ""; } }
    synchronized org.json.JSONObject relayOpen(org.json.JSONObject o) throws Exception {
        url("", 0);
        synchronized (relays) { java.util.Iterator<Relay> it = relays.values().iterator(); while (it.hasNext()) { Relay x = it.next(); if (System.currentTimeMillis() - x.last > 6L * 3600_000) { x.gone = true; it.remove(); } } }
        String u = o.optString("url", ""); if (!u.isEmpty() && !isHttp(u)) throw new IOException("refused: target");
        byte[] b = new byte[16]; new java.security.SecureRandom().nextBytes(b); StringBuilder tk = new StringBuilder(); for (byte x : b) tk.append(String.format(java.util.Locale.US, "%02x", x));
        Relay r = new Relay(); r.url = u; r.origin = originOf(u); r.headers = o.optJSONObject("headers") == null ? "{}" : o.optJSONObject("headers").toString();
        r.subs = new org.json.JSONArray(); org.json.JSONArray in = o.optJSONArray("subs");
        for (int i = 0; in != null && i < in.length() && i < 20; i++) { org.json.JSONObject x = in.optJSONObject(i); org.json.JSONObject y = new org.json.JSONObject(); String su = x == null ? "" : x.optString("url", ""); y.put("url", isHttp(su) ? su : ""); y.put("name", x == null ? "" : x.optString("name", "")); if (x != null && x.optJSONObject("headers") != null) y.put("headers", x.optJSONObject("headers")); r.subs.put(y); }
        relays.put(tk.toString(), r);
        String at = "http://127.0.0.1:" + port + "/r/" + tk;
        org.json.JSONObject out = new org.json.JSONObject(); out.put("token", tk.toString());
        out.put("url", r.url.isEmpty() ? "" : at + "/v/" + nameOf(o.optString("name", ""), "video"));
        org.json.JSONArray su = new org.json.JSONArray(); for (int i = 0; i < r.subs.length(); i++) { org.json.JSONObject x = r.subs.getJSONObject(i); su.put(x.optString("url").isEmpty() ? "" : at + "/s/" + i + "/" + nameOf(x.optString("name", ""), "sub" + i + ".srt")); }
        out.put("subs", su); return out;
    }
    private static String nameOf(String n, String d) throws IOException { String x = (n == null || n.isEmpty() ? d : n).replaceAll("[\\\\/]", "_"); if (x.length() > 100) x = x.substring(0, 100); return java.net.URLEncoder.encode(x, "UTF-8").replace("+", "%20"); }
    boolean relayClose(String token) { Relay r = relays.remove(token); if (r != null) r.gone = true; return r != null; }
    /** Whether the session is open, when it was last read, how often, and whether a read is under way. */
    org.json.JSONObject relayStatus(String token) throws org.json.JSONException { Relay r = relays.get(token); org.json.JSONObject o = new org.json.JSONObject(); o.put("open", r != null); if (r != null) { o.put("lastRead", r.last); o.put("reads", r.reads); o.put("reading", r.reading); } return o; }
    private void relay(String path, String method, String range, OutputStream out) throws Exception {
        String[] p = path.split("\\?")[0].split("/"); // ["", "r", token, kind, n?, name?]
        Relay r = p.length > 3 ? relays.get(p[2]) : null;
        if (r == null) { out.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
        r.last = System.currentTimeMillis(); r.reads++; r.reading++;
        try { relayOne(r, p, method, range, out); } finally { r.reading--; r.last = System.currentTimeMillis(); }
    }
    private void relayOne(Relay r, String[] p, String method, String range, OutputStream out) throws Exception {
        String at = "http://127.0.0.1:" + port + "/r/" + p[2]; String target; String hj = r.headers; boolean mayList = true;
        if ("v".equals(p[3])) target = r.url;
        else if ("u".equals(p[3]) && p.length > 4) { int n; try { n = Integer.parseInt(p[4]); } catch (NumberFormatException e) { n = -1; } synchronized (r) { target = n >= 0 && n < r.urls.size() ? r.urls.get(n) : ""; } }
        else if ("s".equals(p[3]) && p.length > 4) {
            int n; try { n = Integer.parseInt(p[4]); } catch (NumberFormatException e) { n = -1; }
            org.json.JSONObject x = n >= 0 ? r.subs.optJSONObject(n) : null; mayList = false;
            target = x == null ? "" : x.optString("url", "");
            if (x != null) { org.json.JSONObject m = new org.json.JSONObject(r.headers); org.json.JSONObject sh = x.optJSONObject("headers"); if (sh != null) for (java.util.Iterator<String> it = sh.keys(); it.hasNext(); ) { String k = it.next(); m.put(k, sh.optString(k)); } hj = m.toString(); }
        } else target = "";
        if (target.isEmpty() || !isHttp(target)) { out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
        org.json.JSONObject hd = new org.json.JSONObject(hj);
        java.net.HttpURLConnection c = null; java.net.URL url = new java.net.URL(target);
        boolean listByName = url.getPath().toLowerCase(java.util.Locale.ROOT).endsWith(".m3u8");
        for (int hop = 0; ; hop++) {
            if (hop > 6 || !isHttp(url.toString())) { out.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
            boolean same = originOf(url.toString()).equals(r.origin);
            c = KrDoh.open(url); c.setInstanceFollowRedirects(false); c.setConnectTimeout(15000); c.setReadTimeout(30000); c.setRequestMethod("HEAD".equals(method) && !listByName ? "HEAD" : "GET");
            for (java.util.Iterator<String> it = hd.keys(); it.hasNext(); ) { String k = it.next(); String l = k.toLowerCase(java.util.Locale.ROOT); String v = hd.optString(k); if (l.equals("range") || l.equals("host") || v.indexOf('\r') >= 0 || v.indexOf('\n') >= 0) continue; if (same || l.equals("user-agent") || l.equals("referer")) c.setRequestProperty(k, v); }
            if (!hd.has("User-Agent") && !hd.has("user-agent")) c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Mobile Safari/537.36");
            if (range != null && !listByName) c.setRequestProperty("Range", range);
            int code = c.getResponseCode();
            if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) { url = new java.net.URL(url, c.getHeaderField("Location")); c.disconnect(); continue; }
            break;
        }
        int code = c.getResponseCode(); String type = c.getContentType() == null ? "" : c.getContentType();
        boolean playlist = mayList && code < 400 && (type.toLowerCase(java.util.Locale.ROOT).contains("mpegurl") || url.getPath().toLowerCase(java.util.Locale.ROOT).endsWith(".m3u8"));
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        if (playlist) {
            java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream(); byte[] buf = new byte[16384]; int n; while ((n = in.read(buf)) > 0) b.write(buf, 0, n); in.close();
            StringBuilder sb = new StringBuilder(); java.util.regex.Pattern attr = java.util.regex.Pattern.compile("URI=\"([^\"]+)\"");
            for (String line : new String(b.toByteArray(), StandardCharsets.UTF_8).split("\r?\n")) {
                String t = line.trim();
                if (t.isEmpty()) { sb.append('\n'); continue; }
                if (t.startsWith("#")) { java.util.regex.Matcher m = attr.matcher(line); StringBuffer o = new StringBuffer(); while (m.find()) m.appendReplacement(o, java.util.regex.Matcher.quoteReplacement("URI=\"" + relayId(r, at, url, m.group(1)) + "\"")); m.appendTail(o); sb.append(o).append('\n'); }
                else { String id = relayId(r, at, url, t); if (!id.isEmpty()) sb.append(id).append('\n'); }
            }
            byte[] body = sb.toString().getBytes(StandardCharsets.UTF_8);
            out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: " + body.length + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            if (!"HEAD".equals(method)) out.write(body); out.flush(); c.disconnect(); return;
        }
        StringBuilder head = new StringBuilder("HTTP/1.1 " + code + " " + (c.getResponseMessage() == null ? "" : c.getResponseMessage()) + "\r\n");
        for (String k : new String[] { "Content-Type", "Content-Length", "Content-Range", "Accept-Ranges" }) { String v = c.getHeaderField(k); if (v != null) head.append(k).append(": ").append(v).append("\r\n"); }
        head.append("Connection: close\r\n\r\n"); out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
        if (in != null && !"HEAD".equals(method)) { byte[] buf = new byte[1 << 16]; int n; while (!r.gone && (n = in.read(buf)) > 0) { out.write(buf, 0, n); r.last = System.currentTimeMillis(); } in.close(); }
        out.flush(); c.disconnect();
    }
    /** A playlist's address as a numbered one of this session; "" for anything not http(s). */
    private static String relayId(Relay r, String at, java.net.URL base, String rel) { String u; try { u = new java.net.URL(base, rel).toString(); } catch (Exception e) { return ""; } if (!isHttp(u)) return ""; synchronized (r) { Integer n = r.ids.get(u); if (n == null) { if (r.urls.size() >= 200000) return ""; n = r.urls.size(); r.urls.add(u); r.ids.put(u, n); } return at + "/u/" + n; } }

    /** The base address of the sound a web view cannot decode itself (AC-3, E-AC-3, DTS, TrueHD…). */
    synchronized String audioBase() throws IOException { url("", 0); return "http://127.0.0.1:" + port + "/audio"; }
    /** /audio?src=&ss=&a=: one audio track of a video (any address ffmpeg reads, this server's own included), from
     *  `ss` seconds, turned into AAC as it plays — the player plays it beside the muted video, in step with it. */
    private void audio(String path, String method, Socket sock, OutputStream out) throws Exception {
        String q = path.substring(path.indexOf('?') + 1); String src = param(q, "src"); String ss = param(q, "ss"); String a = param(q, "a");
        out.write("HTTP/1.1 200 OK\r\nContent-Type: audio/aac\r\nCache-Control: no-store\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
        if ("HEAD".equals(method) || src == null) { out.flush(); return; }
        java.util.List<String> args = java.util.Arrays.asList("-nostdin", "-hide_banner", "-loglevel", "error", "-ss", ss == null ? "0" : ss, "-i", src, "-map", "0:a:" + (a == null ? "0" : a), "-vn", "-sn", "-dn", "-ac", "2", "-c:a", "aac", "-b:a", "192k", "-f", "adts", "pipe:1");
        Process p = KtPacks.command(engine.context(), KtPacks.ffmpegBin(engine.context()), args).redirectErrorStream(false).start();
        // (Its messages drained, so it never stops on a full pipe.)
        Thread drain = new Thread(() -> { try (InputStream e = p.getErrorStream()) { byte[] b = new byte[4096]; while (e.read(b) > 0) { /* dropped */ } } catch (IOException ignored) {} }, "kt-audio-err"); drain.setDaemon(true); drain.start();
        try (InputStream in = p.getInputStream()) { byte[] b = new byte[16384]; int n; while ((n = in.read(b)) > 0) { out.write(b, 0, n); out.flush(); } }
        finally { p.destroy(); }
    }
    private void serve(Socket s) {
        try (Socket sock = s) {
            sock.setSoTimeout(30000);
            InputStream in = sock.getInputStream(); OutputStream rawOut = sock.getOutputStream();
            String line = readLine(in); if (line == null) return;
            String[] req = line.split(" "); if (req.length < 2) return;
            String path = req[1]; long rangeStart = 0, rangeEnd = -1; boolean ranged = false;
            String rawRange = null;
            for (String h; (h = readLine(in)) != null && !h.isEmpty(); ) { if (h.toLowerCase().startsWith("range:")) { rawRange = h.substring(6).trim(); String v = h.substring(6).trim().replace("bytes=", ""); String[] p = v.split("-"); try { rangeStart = Long.parseLong(p[0].trim()); if (p.length > 1 && !p[1].trim().isEmpty()) rangeEnd = Long.parseLong(p[1].trim()); ranged = true; } catch (Exception ignored) {} } }
            String[] parts = path.replaceFirst("^/", "").split("/");
            BufferedOutputStream out = new BufferedOutputStream(rawOut, 1 << 16);
            if (path.startsWith("/proxy?")) { proxy(path, req[0], rawRange, out); return; }
            if (path.startsWith("/r/")) { relay(path, req[0], rawRange, out); return; }
            // /arc/<id>: a file inside an archive, read straight from it (ranges by seeking in a stored zip entry, by reading past otherwise).
            if (path.startsWith("/arc/")) {
                String[] ent = arcEntries.get(path.substring(5).split("[?]")[0]);
                if (ent == null) { out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
                try (KtArchive.Opened o = KtArchive.open(new File(ent[0]), ent[1], ent[2])) {
                    long lsize = o.size; String mime = mimeOf(ent[2]);
                    if (lsize < 0) { out.write(("HTTP/1.1 200 OK\r\nContent-Type: " + mime + "\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); if (!"HEAD".equals(req[0])) { byte[] b = new byte[1 << 16]; int n; while ((n = o.in.read(b)) > 0) out.write(b, 0, n); } out.flush(); return; }
                    if (rangeEnd < 0 || rangeEnd >= lsize) rangeEnd = lsize - 1; if (rangeStart > rangeEnd) { out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + lsize + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
                    long llen = rangeEnd - rangeStart + 1;
                    out.write(((ranged ? "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes " + rangeStart + "-" + rangeEnd + "/" + lsize + "\r\n" : "HTTP/1.1 200 OK\r\n") + "Content-Type: " + mime + "\r\nAccept-Ranges: bytes\r\nContent-Length: " + llen + "\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                    if ("HEAD".equals(req[0])) { out.flush(); return; }
                    if (rangeStart > 0) o.seekTo(rangeStart);
                    byte[] b = new byte[1 << 16]; long left = llen; while (left > 0) { int n = o.in.read(b, 0, (int) Math.min(b.length, left)); if (n <= 0) break; out.write(b, 0, n); left -= n; }
                    out.flush(); return;
                } catch (java.io.FileNotFoundException e) { out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
            }
            if (path.startsWith("/audio?")) { audio(path, req[0], sock, out); return; }
            // /content?u=<uri>: a document another app handed over (its file descriptor read with ranges when it seeks).
            if (path.startsWith("/content?u=")) {
                java.util.Map<String, String> cq = query(path); String cus = cq.getOrDefault("u", "");
                if (!signed(cus, cq)) { out.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
                android.net.Uri cu = android.net.Uri.parse(cus);
                android.os.ParcelFileDescriptor pfd;
                try { pfd = engine.context().getContentResolver().openFileDescriptor(cu, "r"); } catch (Exception e) { pfd = null; }
                if (pfd == null) { out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
                try (android.os.ParcelFileDescriptor keep = pfd; java.io.FileInputStream fin = new java.io.FileInputStream(keep.getFileDescriptor())) {
                    long lsize = keep.getStatSize(); String mime = null; try { mime = engine.context().getContentResolver().getType(cu); } catch (Exception ignored) {} if (mime == null) mime = "application/octet-stream";
                    if (lsize < 0) { out.write(("HTTP/1.1 200 OK\r\nContent-Type: " + mime + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); if (!"HEAD".equals(req[0])) { byte[] b = new byte[1 << 16]; int n; while ((n = fin.read(b)) > 0) out.write(b, 0, n); } out.flush(); return; }
                    if (rangeEnd < 0 || rangeEnd >= lsize) rangeEnd = lsize - 1; if (rangeStart > rangeEnd) { out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + lsize + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
                    long llen = rangeEnd - rangeStart + 1;
                    out.write(((ranged ? "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes " + rangeStart + "-" + rangeEnd + "/" + lsize + "\r\n" : "HTTP/1.1 200 OK\r\n") + "Content-Type: " + mime + "\r\nAccept-Ranges: bytes\r\nContent-Length: " + llen + "\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                    if ("HEAD".equals(req[0])) { out.flush(); return; }
                    java.nio.channels.FileChannel ch = fin.getChannel(); ch.position(rangeStart); java.nio.ByteBuffer bb = java.nio.ByteBuffer.allocate(1 << 17); long left = llen;
                    while (left > 0) { bb.clear(); if (left < bb.capacity()) bb.limit((int) left); int n = ch.read(bb); if (n <= 0) break; out.write(bb.array(), 0, n); left -= n; }
                    out.flush(); return;
                }
            }
            // /file?p=<path>: any file of the device (the player's local files and their subtitles), served with ranges.
            if (path.startsWith("/file?p=")) {
                java.util.Map<String, String> q = query(path); String lp = q.getOrDefault("p", "");
                if (!signed(lp, q)) { out.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
                File lf = new File(lp);
                if (!lf.isFile()) { out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
                long lsize = lf.length(); if (rangeEnd < 0 || rangeEnd >= lsize) rangeEnd = lsize - 1; if (rangeStart > rangeEnd) { out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + lsize + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
                long llen = rangeEnd - rangeStart + 1;
                out.write(((ranged ? "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes " + rangeStart + "-" + rangeEnd + "/" + lsize + "\r\n" : "HTTP/1.1 200 OK\r\n") + "Content-Type: " + mimeOf(lf.getName()) + "\r\nAccept-Ranges: bytes\r\nContent-Length: " + llen + "\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                if ("HEAD".equals(req[0])) { out.flush(); return; }
                try (RandomAccessFile raf = new RandomAccessFile(lf, "r")) { raf.seek(rangeStart); byte[] b = new byte[1 << 17]; long left = llen; while (left > 0) { int n = raf.read(b, 0, (int) Math.min(b.length, left)); if (n <= 0) break; out.write(b, 0, n); left -= n; } }
                out.flush(); return;
            }
            KtEngine.Task x = parts.length >= 1 ? engine.task(parts[0]) : null; int index = parts.length >= 2 ? Integer.parseInt(parts[1]) : 0;
            if (x == null) { out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
            if (engine.rsTor.holds(x)) { serveRust(x, index, req[0], ranged, rangeStart, rangeEnd, out); return; }   // (stage M3: a torrent on the Rust engine)
            File f = engine.fileOf(x, index); long size;
            TorrentHandle th = x.th; TorrentInfo ti = th != null && th.isValid() ? engine.infoOf(x) : null;
            if (ti != null) size = ti.files().fileSize(index); else if (f != null && f.exists()) size = f.length(); else { out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
            if (rangeEnd < 0 || rangeEnd >= size) rangeEnd = size - 1;
            if (rangeStart > rangeEnd) { out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + size + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
            long len = rangeEnd - rangeStart + 1;
            String mime = mimeOf(f != null ? f.getName() : "");
            out.write(((ranged ? "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes " + rangeStart + "-" + rangeEnd + "/" + size + "\r\n" : "HTTP/1.1 200 OK\r\n") + "Content-Type: " + mime + "\r\nAccept-Ranges: bytes\r\nContent-Length: " + len + "\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            if ("HEAD".equals(req[0])) { out.flush(); return; }
            // (The file is read from disk as its pieces land; a piece missing is asked for first and waited for.)
            long pos = rangeStart; byte[] buf = new byte[1 << 17];
            // (The newest request for a file steers the download: an older one, left behind by a seek, still finishes
            // what it sends but no longer pulls the download back to where it was — the two used to take turns.)
            final String key = (th != null && th.isValid() ? th.infoHash().toHex() : x.id) + ":" + index; final long me = requests.incrementAndGet(); owner.put(key, me); if (th != null) ids.put(th, x.id);
            while (pos <= rangeEnd) {
                if (ti != null) waitForPiece(th, ti, index, pos, rangeEnd, sock, key, me);
                if (f == null || !f.exists()) { Thread.sleep(300); continue; }
                try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
                    raf.seek(pos); int want = (int) Math.min(buf.length, rangeEnd - pos + 1); int n = raf.read(buf, 0, want);
                    if (n <= 0) { Thread.sleep(200); continue; }
                    out.write(buf, 0, n); pos += n;
                }
                if (pos % (1 << 20) < buf.length) out.flush();
            }
            out.flush();
        } catch (Exception ignored) { /* the player went away */ }
    }

    /** The piece holding `pos` of file `index`: made the most urgent (with a few after it), waited for. */
    /** Where the window ahead was last laid for each file being played (it is laid again as playback moves on). */
    private final java.util.Map<String, Integer> windowAt = new java.util.concurrent.ConcurrentHashMap<>();
    private final java.util.concurrent.atomic.AtomicLong requests = new java.util.concurrent.atomic.AtomicLong();
    private final java.util.Map<String, Long> owner = new java.util.concurrent.ConcurrentHashMap<>();
    /** Whether the player is still there (it closes a request it no longer wants: a seek, the player shut). */
    private static boolean gone(Socket sock) {
        try { sock.setSoTimeout(1); return sock.getInputStream().read() < 0; } catch (java.net.SocketTimeoutException e) { return false; } catch (IOException e) { return true; }
        finally { try { sock.setSoTimeout(30000); } catch (IOException ignored) {} }
    }
    /** The video's byte rate (file size ÷ length) per task and file, told by the player once it knows the length. */
    final java.util.Map<String, Long> byteRate = new java.util.concurrent.ConcurrentHashMap<>();
    void hint(String taskId, int index, double seconds, long size) { if (seconds > 1 && size > 0) { byteRate.put(taskId + ":" + index, (long) (size / seconds)); engine.director.hint(taskId + ":" + index, size / seconds); } }
    private final java.util.Map<TorrentHandle, String> ids = new java.util.concurrent.ConcurrentHashMap<>();
    private String task(TorrentHandle th) { String id = ids.get(th); return id == null ? "" : id; }
    private void waitForPiece(TorrentHandle th, TorrentInfo ti, int index, long pos, long end, Socket sock, String key, long me) throws InterruptedException {
        FileStorage fs = ti.files();
        PeerRequest pr = fs.mapFile(index, pos, 1); int piece = pr.piece();
        Long own = owner.get(key); boolean steer = own == null || own == me;
        // (The window ahead kept moving with playback — laid again each time the player reaches a new piece, even
        // one already here — so the download stays ahead of what is watched instead of stopping to wait at each
        // gap: about 48 MB after it, on deadlines that grow with the distance.)
        Integer at = windowAt.get(key);
        // (Stage M3: a torrent on «director» — kt-core's director lays the window; Java's own below when it is not, or fails.)
        boolean directed = false;
        if (steer) { KtEngine.Task dx = engine.task(task(th)); String dk = dx == null ? null : dx.id + ":" + index;
            if (dx != null && engine.directed(dx) && engine.director.isOpen(dk)) { long now = System.currentTimeMillis(); directed = engine.director.read(dk, pos, wires(th), now, false); if (directed) { try { engine.director.rate(dk, th.status().downloadPayloadRate(), now); } catch (Throwable ignored) {} engine.streaming(th); } } }
        if (!directed && steer && (at == null || at != piece)) {
            // (About half a minute of the video ahead (torrentplayer's window), at its byte rate when the player has said
            // it — its length known —, else the old 48 MB; never under 16 MB nor over 256 MB.)
            Long rate = byteRate.get(task(th) + ":" + index); long want = rate != null && rate > 0 ? rate * 30 : (48L << 20);
            want = Math.max(16L << 20, Math.min(256L << 20, want));
            int ahead = Math.max(12, (int) (want / Math.max(1, ti.pieceLength())));
            // (A jump — a seek —: the old window's deadlines dropped, so the download turns here at once.)
            if (at != null && (piece < at || piece > at + ahead)) { try { th.clearPieceDeadlines(); } catch (Throwable ignored) {} }
            windowAt.put(key, piece);
            int last = Math.min(ti.numPieces() - 1, fs.mapFile(index, end, 1).piece());
            for (int k = piece; k <= Math.min(last, piece + ahead); k++) { if (!th.havePiece(k)) { th.piecePriority(k, Priority.TOP_PRIORITY); th.setPieceDeadline(k, 100 + (k - piece) * 180); } }
            engine.streaming(th);
        }
        if (th.havePiece(piece)) return;
        long until = System.currentTimeMillis() + 120000; int n = 0;
        while (!th.havePiece(piece)) {
            if (System.currentTimeMillis() > until || !th.isValid()) throw new InterruptedException("timeout");
            // (A request the player gave up on ends now, instead of waiting two minutes for its piece.)
            if (++n % 8 == 0 && gone(sock)) throw new InterruptedException("gone");
            Thread.sleep(100);
        }
    }

    /* ---------- stage M3 ---------- */
    /** libtorrent4j's handle as the director's wires: top priority with a deadline, high priority, deadlines dropped. */
    KtTorDirector.Wires wires(TorrentHandle th) {
        return new KtTorDirector.Wires() {
            @Override public boolean have(int k) { return th.havePiece(k); }
            @Override public void deadline(int k, int ms) { th.piecePriority(k, Priority.TOP_PRIORITY); th.setPieceDeadline(k, ms); }
            @Override public void high(int k) { th.piecePriority(k, Priority.SIX); }
            @Override public void clearDeadlines() { try { th.clearPieceDeadlines(); } catch (Throwable ignored) {} }
        };
    }
    /** A file of a torrent on the Rust engine: its bytes asked of librqbit (`bytes.tor.read`, which fetches the pieces
     *  under the reader first and waits for them), the same ranges and headers as the libtorrent path. */
    private void serveRust(KtEngine.Task x, int index, String method, boolean ranged, long rangeStart, long rangeEnd, OutputStream out) throws Exception {
        // (A .torrent's files are known from its own description; a magnet's from the Rust engine's rows.)
        long size = engine.rsTor.sizeOf(x, index); File f = engine.fileOf(x, index);
        if (size < 0) { TorrentInfo ti = engine.infoOf(x); if (ti != null && index >= 0 && index < ti.numFiles()) size = ti.files().fileSize(index); }
        if (size < 0) { out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
        if (rangeEnd < 0 || rangeEnd >= size) rangeEnd = size - 1;
        if (rangeStart > rangeEnd) { out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + size + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
        long len = rangeEnd - rangeStart + 1;
        out.write(((ranged ? "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes " + rangeStart + "-" + rangeEnd + "/" + size + "\r\n" : "HTTP/1.1 200 OK\r\n") + "Content-Type: " + mimeOf(f != null ? f.getName() : "") + "\r\nAccept-Ranges: bytes\r\nContent-Length: " + len + "\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        if ("HEAD".equals(method)) { out.flush(); return; }
        long pos = rangeStart;
        while (pos <= rangeEnd) {
            byte[] b = engine.rsTor.read(x, index, pos, (int) Math.min(1 << 17, rangeEnd - pos + 1));
            if (b.length == 0) break;
            out.write(b); pos += b.length;
            if (pos % (1 << 20) < b.length) out.flush();
        }
        out.flush();
    }

    static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder(); int c;
        while ((c = in.read()) >= 0) { if (c == '\n') break; if (c != '\r') sb.append((char) c); if (sb.length() > 8192) break; }
        return c < 0 && sb.length() == 0 ? null : sb.toString();
    }
    static String mimeOf(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".mp4") || n.endsWith(".m4v")) return "video/mp4"; if (n.endsWith(".mkv")) return "video/webm"; /* (a web view plays Matroska under WebM's name, and refuses it under its own) */ if (n.endsWith(".webm")) return "video/webm"; if (n.endsWith(".avi")) return "video/x-msvideo"; if (n.endsWith(".mov")) return "video/quicktime"; if (n.endsWith(".ts")) return "video/mp2t"; if (n.endsWith(".mp3")) return "audio/mpeg"; if (n.endsWith(".flac")) return "audio/flac"; if (n.endsWith(".m4a")) return "audio/mp4";
        return "application/octet-stream";
    }
}
