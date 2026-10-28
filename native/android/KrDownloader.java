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
 * A server that cannot cut the file (no ranges, size unknown, an empty file) is read in one piece.
 *
 * Plain Java (java.net only), so it is tested on its own (tests/native/downloader). The plugin gives it the
 * connections (the app's identity and cookies) and reports the progress it counts.
 */
final class KrDownloader {
    interface Opener { HttpURLConnection open(URL url) throws IOException; }

    /** What is learnt as the download goes (read by the progress reports while it runs). */
    static final class Result { volatile long total = -1; volatile boolean ranged; volatile int connections = 1; volatile URL finalUrl; }

    private KrDownloader() {}

    /** A connection to `url` with its redirects followed here — also from http to https, which
     *  HttpURLConnection does not follow itself. */
    private static HttpURLConnection follow(URL url, Opener opener, String range) throws IOException {
        for (int hop = 0; hop < 10; hop++) {
            HttpURLConnection c = opener.open(url);
            if (range != null) c.setRequestProperty("Range", range);
            c.setRequestProperty("Accept-Encoding", "identity");
            int code = c.getResponseCode();
            String loc = code >= 300 && code < 400 ? c.getHeaderField("Location") : null;
            if (loc == null) return c;
            c.disconnect();
            url = new URL(url, loc);
        }
        throw new IOException("Too many redirects");
    }

    /**
     * Downloads `url` into `out` (a ".part" file the caller renames when whole). `got` counts the bytes as they
     * come; `tick` is called after each read (the caller rate-limits its reports). What is learnt — the size,
     * whether it came in ranges, over how many connections — goes into `res` as soon as known.
     */
    static Result fetch(URL url, File out, int maxConnections, Opener opener, AtomicBoolean cancelled, AtomicLong got, Result res, Runnable tick) throws Exception {
        // A one-byte range asked first: the file's size, whether it can be cut, and where the redirects end
        // (GitHub → a signed storage address: asked there directly afterwards, a round trip less per chunk).
        HttpURLConnection probe = follow(url, opener, "bytes=0-0");
        int code = probe.getResponseCode();
        res.finalUrl = probe.getURL() != null ? probe.getURL() : url;
        String cr = probe.getHeaderField("Content-Range");
        if (code == 206 && cr != null && cr.contains("/")) try { res.total = Long.parseLong(cr.substring(cr.lastIndexOf('/') + 1).trim()); } catch (Exception ignored) {}
        res.ranged = code == 206 && res.total > 0;
        if (code == 200) {
            // (The server ignored the range and sends the whole file: read from this answer, not asked again.)
            try { res.total = Long.parseLong(probe.getHeaderField("Content-Length")); } catch (Exception ignored) {}
            try (InputStream in = probe.getInputStream(); RandomAccessFile raf = new RandomAccessFile(out, "rw")) {
                raf.setLength(0); copy(in, raf, Long.MAX_VALUE, cancelled, got, tick, new long[1]);
            } finally { probe.disconnect(); }
            if (res.total < 0) res.total = got.get();
            return res;
        }
        if (!res.ranged) {
            // (Cut but of unknown size, an empty file the range does not fit — 416 —, …: the whole file at once.)
            probe.disconnect();
            if (code >= 400 && code != 416) throw new IOException("HTTP " + code);
            HttpURLConnection c = follow(url, opener, null);
            int rc = c.getResponseCode();
            if (rc >= 400) { c.disconnect(); throw new IOException("HTTP " + rc); }
            try { res.total = Long.parseLong(c.getHeaderField("Content-Length")); } catch (Exception ignored) {}
            try (InputStream in = c.getInputStream(); RandomAccessFile raf = new RandomAccessFile(out, "rw")) {
                raf.setLength(0); copy(in, raf, Long.MAX_VALUE, cancelled, got, tick, new long[1]);
            } finally { c.disconnect(); }
            if (res.total < 0) res.total = got.get();
            return res;
        }
        drain(probe);
        final long total = res.total;
        // Chunks: about a quarter of each connection's share, between 1 and 8 MB.
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
                            long[] wrote = new long[1];
                            try {
                                c = follow(u, opener, "bytes=" + pos + "-" + to);
                                int rc = c.getResponseCode();
                                if (rc != 206) throw new IOException("HTTP " + rc);
                                try (InputStream in = c.getInputStream()) {
                                    raf.seek(pos);
                                    copy(in, raf, to - pos + 1, cancelled, got, tick, wrote);
                                }
                                pos += wrote[0]; wrote[0] = 0;
                                // (An answer that ended early without an error is a failed attempt too.)
                                if (pos <= to && !cancelled.get()) throw new IOException("Connection closed early");
                            } catch (Exception e) {
                                // (What came before the break is in the file already: the next attempt goes on from there.)
                                pos += wrote[0];
                                if (c != null) c.disconnect();
                                if (attempt >= 5) throw e;
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
        // (Every chunk is counted as it comes; anything less than the whole file is a hole in it.)
        if (!cancelled.get() && got.get() < total) throw new IOException("incomplete (" + got.get() + " of " + total + ")");
        return res;
    }

    /** Copies up to `max` bytes, counting them in `wrote[0]` as they are written. */
    private static void copy(InputStream in, RandomAccessFile raf, long max, AtomicBoolean cancelled, AtomicLong got, Runnable tick, long[] wrote) throws IOException {
        byte[] buf = new byte[1 << 17]; int r;
        while (wrote[0] < max && !cancelled.get() && (r = in.read(buf, 0, (int) Math.min(buf.length, max - wrote[0]))) > 0) {
            raf.write(buf, 0, r); wrote[0] += r; got.addAndGet(r); tick.run();
        }
    }

    /** A finished answer read to its end, so its connection goes back to the pool for the next request. */
    private static void drain(HttpURLConnection c) {
        try (InputStream in = c.getInputStream()) { byte[] b = new byte[256]; while (in.read(b) > 0) { /* the one byte */ } } catch (Exception ignored) {}
    }
}
