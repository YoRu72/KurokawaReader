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
        return "http://127.0.0.1:" + port + "/" + taskId + "/" + fileIndex;
    }

    private void serve(Socket s) {
        try (Socket sock = s) {
            sock.setSoTimeout(30000);
            InputStream in = sock.getInputStream(); OutputStream rawOut = sock.getOutputStream();
            String line = readLine(in); if (line == null) return;
            String[] req = line.split(" "); if (req.length < 2) return;
            String path = req[1]; long rangeStart = 0, rangeEnd = -1; boolean ranged = false;
            for (String h; (h = readLine(in)) != null && !h.isEmpty(); ) { if (h.toLowerCase().startsWith("range:")) { String v = h.substring(6).trim().replace("bytes=", ""); String[] p = v.split("-"); try { rangeStart = Long.parseLong(p[0].trim()); if (p.length > 1 && !p[1].trim().isEmpty()) rangeEnd = Long.parseLong(p[1].trim()); ranged = true; } catch (Exception ignored) {} } }
            String[] parts = path.replaceFirst("^/", "").split("/");
            KtEngine.Task x = parts.length >= 1 ? engine.task(parts[0]) : null; int index = parts.length >= 2 ? Integer.parseInt(parts[1]) : 0;
            BufferedOutputStream out = new BufferedOutputStream(rawOut, 1 << 16);
            if (x == null) { out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
            File f = engine.fileOf(x, index); long size;
            TorrentHandle th = x.th; TorrentInfo ti = th != null && th.isValid() ? th.torrentFile() : null;
            if (ti != null) size = ti.files().fileSize(index); else if (f != null && f.exists()) size = f.length(); else { out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
            if (rangeEnd < 0 || rangeEnd >= size) rangeEnd = size - 1;
            if (rangeStart > rangeEnd) { out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + size + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); out.flush(); return; }
            long len = rangeEnd - rangeStart + 1;
            String mime = mimeOf(f != null ? f.getName() : "");
            out.write(((ranged ? "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes " + rangeStart + "-" + rangeEnd + "/" + size + "\r\n" : "HTTP/1.1 200 OK\r\n") + "Content-Type: " + mime + "\r\nAccept-Ranges: bytes\r\nContent-Length: " + len + "\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            if ("HEAD".equals(req[0])) { out.flush(); return; }
            // (The file is read from disk as its pieces land; a piece missing is asked for first and waited for.)
            long pos = rangeStart; byte[] buf = new byte[1 << 17];
            while (pos <= rangeEnd) {
                if (ti != null) waitForPiece(th, ti, index, pos, rangeEnd);
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
    private void waitForPiece(TorrentHandle th, TorrentInfo ti, int index, long pos, long end) throws InterruptedException {
        FileStorage fs = ti.files();
        PeerRequest pr = fs.mapFile(index, pos, 1); int piece = pr.piece();
        if (th.havePiece(piece)) return;
        int last = Math.min(ti.numPieces() - 1, fs.mapFile(index, end, 1).piece());
        // (The window ahead: this piece now, the next ones soon after — a sequential download from here.)
        for (int k = piece; k <= Math.min(last, piece + 8); k++) { if (!th.havePiece(k)) { th.piecePriority(k, Priority.TOP_PRIORITY); th.setPieceDeadline(k, (k - piece) * 1000); } }
        long until = System.currentTimeMillis() + 120000;
        while (!th.havePiece(piece)) { if (System.currentTimeMillis() > until || !th.isValid()) throw new InterruptedException("timeout"); Thread.sleep(150); }
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder(); int c;
        while ((c = in.read()) >= 0) { if (c == '\n') break; if (c != '\r') sb.append((char) c); if (sb.length() > 8192) break; }
        return c < 0 && sb.length() == 0 ? null : sb.toString();
    }
    static String mimeOf(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".mp4") || n.endsWith(".m4v")) return "video/mp4"; if (n.endsWith(".mkv")) return "video/x-matroska"; if (n.endsWith(".webm")) return "video/webm"; if (n.endsWith(".avi")) return "video/x-msvideo"; if (n.endsWith(".mov")) return "video/quicktime"; if (n.endsWith(".ts")) return "video/mp2t"; if (n.endsWith(".mp3")) return "audio/mpeg"; if (n.endsWith(".flac")) return "audio/flac"; if (n.endsWith(".m4a")) return "audio/mp4";
        return "application/octet-stream";
    }
}
