package app.kurokawa.reader;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Fetches one file over several connections at once, the way download managers (aria2, 1DM, ADM) do:
 * the file is cut into chunks of a few megabytes and each connection takes the next chunk still to do —
 * a slow connection holds up only its own chunk, not a quarter of the file — reusing its connection
 * (keep-alive) from chunk to chunk. A server that answers one connection at some hundreds of kilobytes a
 * second (latency, per-connection limits: GitHub's storage, archive.org) gives its full speed this way.
 *
 * Plain Java (java.net only), so it is tested on its own (tests/native/downloader). The plugin gives it the
 * connections (the app's identity and cookies) and reports the progress it counts.
 */
final class KrDownloader {
    interface Opener { HttpURLConnection open(URL url) throws IOException; }

    /** What is learnt as the download goes (read by the progress reports while it runs). */
    static final class Result { volatile long total = -1; volatile boolean ranged; volatile int connections = 1; volatile URL finalUrl; }

    private KrDownloader() {}

    /**
     * Downloads `url` into `out` (a ".part" file the caller renames when whole). `got` counts the bytes as they
     * come; `tick` is called after each read (the caller rate-limits its reports). Returns what was learnt:
     * the size, whether it came in ranges, and over how many connections — into `res`, as soon as known.
     */
    static Result fetch(URL url, File out, int maxConnections, Opener opener, AtomicBoolean cancelled, AtomicLong got, Result res, Runnable tick) throws Exception {
        // A one-byte range asked first: the file's size, whether it can be cut, and where the redirects end
        // (GitHub → a signed storage address: asked there directly afterwards, a round trip less per chunk).
        HttpURLConnection probe = opener.open(url);
        probe.setRequestProperty("Range", "bytes=0-0");
        probe.setRequestProperty("Accept-Encoding", "identity");
        int code = probe.getResponseCode();
        if (code >= 400) { probe.disconnect(); throw new IOException("HTTP " + code); }
        String cr = probe.getHeaderField("Content-Range");
        if (code == 206 && cr != null && cr.contains("/")) try { res.total = Long.parseLong(cr.substring(cr.lastIndexOf('/') + 1).trim()); } catch (Exception ignored) {}
        if (res.total < 0 && code == 200) { try { res.total = Long.parseLong(probe.getHeaderField("Content-Length")); } catch (Exception ignored) {} }
        res.finalUrl = probe.getURL() != null ? probe.getURL() : url;
        res.ranged = code == 206 && res.total > 0;
        if (code == 200) {
            // (The server ignored the range and sends the whole file: read it from this answer, not asked again.)
            try (InputStream in = probe.getInputStream(); RandomAccessFile raf = new RandomAccessFile(out, "rw")) {
                raf.setLength(0); copy(in, raf, Long.MAX_VALUE, cancelled, got, tick);
            } finally { probe.disconnect(); }
            if (res.total < 0) res.total = got.get();
            return res;
        }
        drain(probe);
        if (!res.ranged) throw new IOException("HTTP " + code);
        final long total = res.total;
        // Chunks: about a sixteenth of the file per connection, between 1 and 8 MB.
        int n = (int) Math.max(1, Math.min(maxConnections, total / (512 * 1024)));
        final long chunk = Math.max(1L << 20, Math.min(8L << 20, total / Math.max(1, n * 4)));
        res.connections = n;
        try (RandomAccessFile raf = new RandomAccessFile(out, "rw")) { raf.setLength(total); }
        final AtomicLong next = new AtomicLong(0);
        final AtomicReference<Exception> fail = new AtomicReference<>();
        final URL direct = res.finalUrl;
        Thread[] workers = new Thread[n];
        for (int i = 0; i < n; i++) {
            workers[i] = new Thread(() -> {
                try (RandomAccessFile raf = new RandomAccessFile(out, "rw")) {
                    while (fail.get() == null && !cancelled.get()) {
                        long from = next.getAndAdd(chunk);
                        if (from >= total) break;
                        long to = Math.min(total - 1, from + chunk - 1);
                        long pos = from;
                        for (int attempt = 0; pos <= to && !cancelled.get(); attempt++) {
                            // (The signed address may have run out: the first address again, redirects and all.)
                            URL u = attempt >= 2 ? url : direct;
                            HttpURLConnection c = null;
                            try {
                                c = opener.open(u);
                                c.setRequestProperty("Range", "bytes=" + pos + "-" + to);
                                c.setRequestProperty("Accept-Encoding", "identity");
                                int rc = c.getResponseCode();
                                if (rc != 206) throw new IOException("HTTP " + rc);
                                try (InputStream in = c.getInputStream()) {
                                    raf.seek(pos);
                                    pos += copy(in, raf, to - pos + 1, cancelled, got, tick);
                                }
                            } catch (Exception e) {
                                if (c != null) c.disconnect();
                                if (attempt >= 4) throw e;
                                try { Thread.sleep(400L * (attempt + 1)); } catch (InterruptedException ie) { throw e; }
                            }
                        }
                    }
                } catch (Exception e) { fail.compareAndSet(null, e); }
            });
            workers[i].start();
        }
        for (Thread w : workers) w.join();
        if (fail.get() != null && !cancelled.get()) throw fail.get();
        return res;
    }

    /** Copies up to `max` bytes; returns how many. */
    private static long copy(InputStream in, RandomAccessFile raf, long max, AtomicBoolean cancelled, AtomicLong got, Runnable tick) throws IOException {
        byte[] buf = new byte[1 << 17]; long n = 0; int r;
        while (n < max && !cancelled.get() && (r = in.read(buf, 0, (int) Math.min(buf.length, max - n))) > 0) {
            raf.write(buf, 0, r); n += r; got.addAndGet(r); tick.run();
        }
        return n;
    }

    /** A finished answer read to its end, so its connection goes back to the pool for the next request. */
    private static void drain(HttpURLConnection c) {
        try (InputStream in = c.getInputStream()) { byte[] b = new byte[256]; while (in.read(b) > 0) { /* the one byte */ } } catch (Exception ignored) {}
    }
}
