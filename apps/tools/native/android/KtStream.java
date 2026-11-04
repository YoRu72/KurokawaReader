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
    synchronized String contentUrl(String uri) throws IOException { url("", 0); return "http://127.0.0.1:" + port + "/content?u=" + java.net.URLEncoder.encode(uri, "UTF-8"); }
    /** A local file's URL on this server. */
    synchronized String fileUrl(String path) throws IOException { url("", 0); return "http://127.0.0.1:" + port + "/file?p=" + java.net.URLEncoder.encode(path, "UTF-8"); }

    /** A remote stream's URL on this server, fetched with the headers it needs (a referer, a cookie): what an online
     *  source's `<video>` reads, since a web view cannot set those itself. HLS playlists are rewritten so their
     *  parts come the same way. */
    synchronized String proxyUrl(String u, String headersJson) throws IOException { url("", 0); return "http://127.0.0.1:" + port + "/proxy?u=" + java.net.URLEncoder.encode(u, "UTF-8") + "&h=" + java.net.URLEncoder.encode(headersJson == null ? "{}" : headersJson, "UTF-8"); }
    private static String param(String q, String k) throws IOException { for (String kv : q.split("&")) { int i = kv.indexOf('='); if (i > 0 && kv.substring(0, i).equals(k)) return java.net.URLDecoder.decode(kv.substring(i + 1), "UTF-8"); } return null; }
    private void proxy(String path, String method, String range, OutputStream out) throws Exception {
        String q = path.substring(path.indexOf('?') + 1); String u = param(q, "u"); String hj = param(q, "h"); if (hj == null) hj = "{}";
        org.json.JSONObject hd = new org.json.JSONObject(hj);
        java.net.HttpURLConnection c = null; java.net.URL url = new java.net.URL(u);
        for (int hop = 0; hop < 6; hop++) {
            c = KrDoh.open(url); c.setInstanceFollowRedirects(false); c.setConnectTimeout(15000); c.setReadTimeout(30000); c.setRequestMethod("HEAD".equals(method) ? "HEAD" : "GET");
            for (java.util.Iterator<String> it = hd.keys(); it.hasNext(); ) { String k = it.next(); c.setRequestProperty(k, hd.optString(k)); }
            if (!hd.has("User-Agent") && !hd.has("user-agent")) c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Mobile Safari/537.36");
            if (range != null) c.setRequestProperty("Range", range);
            int code = c.getResponseCode();
            if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) { url = new java.net.URL(url, c.getHeaderField("Location")); c.disconnect(); continue; }
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
            out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: " + body.length + "\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            if (!"HEAD".equals(method)) out.write(body); out.flush(); return;
        }
        StringBuilder head = new StringBuilder("HTTP/1.1 " + code + " " + (c.getResponseMessage() == null ? "" : c.getResponseMessage()) + "\r\n");
        for (String k : new String[] { "Content-Type", "Content-Length", "Content-Range", "Accept-Ranges" }) { String v = c.getHeaderField(k); if (v != null) head.append(k).append(": ").append(v).append("\r\n"); }
        head.append("Connection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n");
        out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
        if (in != null && !"HEAD".equals(method)) { byte[] buf = new byte[1 << 16]; int n; while ((n = in.read(buf)) > 0) out.write(buf, 0, n); in.close(); }
        out.flush(); c.disconnect();
    }

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
            if (path.startsWith("/audio?")) { audio(path, req[0], sock, out); return; }
            // /content?u=<uri>: a document another app handed over (its file descriptor read with ranges when it seeks).
            if (path.startsWith("/content?u=")) {
                android.net.Uri cu = android.net.Uri.parse(java.net.URLDecoder.decode(path.substring(11), "UTF-8"));
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
                File lf = new File(java.net.URLDecoder.decode(path.substring(8), "UTF-8"));
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
            final String key = (th != null && th.isValid() ? th.infoHash().toHex() : x.id) + ":" + index; final long me = requests.incrementAndGet(); owner.put(key, me);
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
    private void waitForPiece(TorrentHandle th, TorrentInfo ti, int index, long pos, long end, Socket sock, String key, long me) throws InterruptedException {
        FileStorage fs = ti.files();
        PeerRequest pr = fs.mapFile(index, pos, 1); int piece = pr.piece();
        Long own = owner.get(key); boolean steer = own == null || own == me;
        // (The window ahead kept moving with playback — laid again each time the player reaches a new piece, even
        // one already here — so the download stays ahead of what is watched instead of stopping to wait at each
        // gap: about 48 MB after it, on deadlines that grow with the distance.)
        Integer at = windowAt.get(key);
        if (steer && (at == null || at != piece)) {
            int ahead = Math.max(12, (int) ((48L << 20) / Math.max(1, ti.pieceLength())));
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
