package app.kurokawa.tools;

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
    /** A connection cut by the server (not a timeout, not a refused address). */
    static boolean cut(Throwable e) {
        for (Throwable x = e; x != null; x = x.getCause()) {
            String m = String.valueOf(x.getMessage()).toLowerCase(java.util.Locale.ROOT);
            if (x instanceof javax.net.ssl.SSLException || (x instanceof java.net.SocketException && !(x instanceof java.net.ConnectException)) || m.contains("connection reset") || m.contains("closed early") || m.contains("unexpected end of stream") || m.contains("broken pipe")) return true;
        }
        return false;
    }
    static final class Result { volatile String fileName, mime; volatile long total = -1; volatile boolean ranged, refused; volatile int connections = 1; volatile URL finalUrl; final java.util.List<Seg> segs = java.util.Collections.synchronizedList(new java.util.ArrayList<>()); }
    /** One range a connection is fetching (or fetched): what the details page draws as the file map and the lanes. */
    static final class Seg { final long start, end; volatile long pos; volatile double speed; volatile boolean active; volatile int worker; long lastT, lastPos; Seg(long s, long e, int w) { start = s; end = e; pos = s; worker = w; active = true; lastT = System.currentTimeMillis(); lastPos = s; }
        void advance(long p) { pos = p; long now = System.currentTimeMillis(); if (now - lastT >= 500) { double inst = (p - lastPos) / ((now - lastT) / 1000.0); speed = speed == 0 ? inst : speed * 0.6 + inst * 0.4; lastT = now; lastPos = p; } } }

    private KrDownloader() {}

    /** What the engine sets: how many times a chunk is tried again, and where the progress is kept between runs. */
    static final class Opts { int retries = 5; File state; /** The cookies a site sets (DDoS-Guard, Cloudflare…), kept for its next requests. */ java.util.function.BiConsumer<URL, java.util.List<String>> cookies; /** The name the file is expected to have (to tell a web page sent in its place). */ String expectName; }
    /** Where Set-Cookie headers go (the engine's: Android's cookie store, shared with its web views). */
    static volatile java.util.function.BiConsumer<URL, java.util.List<String>> cookieSink;
    /** A web page sent where a file was expected (a site's check, a sign-in, an error page). */
    static final class WebPage extends IOException { WebPage() { super("page"); } }
    /** The file's name from a Content-Disposition header (filename*=UTF-8''… first, then filename="…"). */
    static String dispositionName(String cd) {
        if (cd == null) return null;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("filename\\*\\s*=\\s*([^']*)'[^']*'([^;]+)", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(cd);
        if (m.find()) try { return java.net.URLDecoder.decode(m.group(2).trim().replace("+", "%2B"), m.group(1).isEmpty() ? "UTF-8" : m.group(1)); } catch (Exception ignored) {}
        m = java.util.regex.Pattern.compile("filename\\s*=\\s*\"([^\"]+)\"|filename\\s*=\\s*([^;]+)", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(cd);
        if (m.find()) { String n = m.group(1) != null ? m.group(1) : m.group(2).trim(); return n.isEmpty() ? null : n; }
        return null;
    }
    /** An answer with an unwanted status (kept, so a refusal can be told from a fault). */
    static final class Status extends IOException { final int code; Status(int c) { super("HTTP " + c); code = c; } }

    /** A connection to `url` with its redirects followed here — also from http to https, which
     *  HttpURLConnection does not follow itself. */
    private static HttpURLConnection follow(URL url, Opener opener, String range) throws IOException { return follow(url, opener, range, null, null); }
    /** `at[0]`: the address the redirects ended at, by its own name (a connection asked by address — DNS over
     *  HTTPS, see KrDoh — would say the address). `ifRange`: the part asked only if the file is still the same. */
    private static HttpURLConnection follow(URL url, Opener opener, String range, URL[] at, String ifRange) throws IOException {
        for (int hop = 0; hop < 10; hop++) {
            HttpURLConnection c = opener.open(url);
            if (range != null) c.setRequestProperty("Range", range);
            if (ifRange != null && !ifRange.isEmpty()) c.setRequestProperty("If-Range", ifRange);
            c.setRequestProperty("Accept-Encoding", "identity");
            int code = c.getResponseCode();
            if (cookieSink != null) { java.util.List<String> set = c.getHeaderFields().get("Set-Cookie"); if (set != null && !set.isEmpty()) try { cookieSink.accept(url, set); } catch (Exception ignored) {} }
            String loc = code >= 300 && code < 400 ? c.getHeaderField("Location") : null;
            if (loc == null) { if (at != null) at[0] = c.getURL() != null && c.getURL().getHost().equals(url.getHost()) ? c.getURL() : url; return c; }
            c.disconnect();
            url = new URL(url, loc);
        }
        throw new IOException("Too many redirects");
    }

    /** The progress kept between runs: the size, what identifies this version of the file, the chunk size, the
     *  chunks done. Plain text: «kt1», total, validator, chunk, the done chunks' numbers. */
    static final class State {
        long total, chunk; String validator = ""; java.util.BitSet done = new java.util.BitSet();
        static State read(File f) {
            if (f == null || !f.exists()) return null;
            try { String[] l = new String(java.nio.file.Files.readAllBytes(f.toPath()), java.nio.charset.StandardCharsets.UTF_8).split("\n", -1);
                if (l.length < 5 || !"kt1".equals(l[0])) return null;
                State s = new State(); s.total = Long.parseLong(l[1].trim()); s.validator = l[2].trim(); s.chunk = Long.parseLong(l[3].trim());
                for (String n : l[4].split(",")) if (!n.trim().isEmpty()) s.done.set(Integer.parseInt(n.trim()));
                return s.total > 0 && s.chunk > 0 ? s : null;
            } catch (Exception e) { return null; }
        }
        synchronized void write(File f) {
            if (f == null) return;
            StringBuilder b = new StringBuilder("kt1\n").append(total).append('\n').append(validator.replace('\n', ' ')).append('\n').append(chunk).append('\n');
            for (int i = done.nextSetBit(0); i >= 0; i = done.nextSetBit(i + 1)) b.append(i).append(',');
            File tmp = new File(f.getPath() + ".tmp");
            try { java.nio.file.Files.write(tmp.toPath(), b.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)); if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f); } } catch (IOException ignored) {}
        }
        synchronized void mark(int i) { done.set(i); }
        synchronized boolean has(int i) { return done.get(i); }
    }
    /** What tells this version of the file from another: a strong ETag, or else its date. */
    private static String validatorOf(HttpURLConnection c) {
        String e = c.getHeaderField("ETag"); if (e != null && !e.isEmpty() && !e.startsWith("W/")) return e;
        String m = c.getHeaderField("Last-Modified"); return m == null ? "" : m;
    }

    static Result fetch(URL url, File out, int maxConnections, Opener opener, AtomicBoolean cancelled, AtomicLong got, Result res, Runnable tick) throws Exception { return fetch(url, out, maxConnections, opener, cancelled, got, res, tick, new Opts()); }
    /**
     * Downloads `url` into `out` (a ".part" file the caller renames when whole). `got` counts the bytes as they
     * come; `tick` is called after each read (the caller rate-limits its reports). What is learnt — the size,
     * whether it came in ranges, over how many connections — goes into `res` as soon as known.
     *
     * With `opt.state`, the chunks done are kept there as they finish, and a later run goes on from them — once
     * the server confirms (If-Range) that the file is the one begun; a changed file is downloaded afresh.
     * A server that refuses the extra connections (429, 503) keeps the ones it accepts: the refused connection's
     * chunk goes back to the others, and `res.refused` tells the engine to ask fewer of this server next time.
     */
    static Result fetch(URL url, File out, int maxConnections, Opener opener, AtomicBoolean cancelled, AtomicLong got, Result res, Runnable tick, Opts opt) throws Exception {
        if (opt.cookies != null) cookieSink = opt.cookies;
        if (opt.state == null) { opt.state = File.createTempFile("kt-download-", ".state", out.getAbsoluteFile().getParentFile()); opt.state.delete(); opt.state.deleteOnExit(); }
        State prev = out.exists() ? State.read(opt.state) : null;
        // A one-byte range asked first: the file's size, whether it can be cut, and where the redirects end
        // (GitHub → a signed storage address: asked there directly afterwards, a round trip less per chunk).
        URL[] at = { url };
        HttpURLConnection probe = follow(url, opener, "bytes=0-0", at, prev != null ? prev.validator : null);
        int code = probe.getResponseCode();
        res.finalUrl = at[0];
        res.fileName = dispositionName(probe.getHeaderField("Content-Disposition")); res.mime = probe.getContentType();
        // (A page in the file's place — a site's check or sign-in — said so, not saved under the file's name.)
        String ct = res.mime == null ? "" : res.mime.toLowerCase(java.util.Locale.ROOT);
        if ((ct.startsWith("text/html") || ct.startsWith("application/xhtml")) && opt.expectName != null && !opt.expectName.toLowerCase(java.util.Locale.ROOT).matches(".*\\.(html?|xhtml|php|aspx?)$") && (code == 200 || code == 206 || code == 403 || code == 503 || code == 429)) {
            long len = -1; try { len = Long.parseLong(probe.getHeaderField("Content-Length")); } catch (Exception ignored) {}
            if (len < 2_000_000) { probe.disconnect(); throw new WebPage(); }
        }
        String cr = probe.getHeaderField("Content-Range");
        if (code == 206 && cr != null && cr.contains("/")) try { res.total = Long.parseLong(cr.substring(cr.lastIndexOf('/') + 1).trim()); } catch (Exception ignored) {}
        res.ranged = code == 206 && res.total > 0;
        if (code == 200) {
            // (The server ignored the range — or the file changed since — and sends the whole file: read from this answer.)
            if (opt.state != null) opt.state.delete();
            try { res.total = Long.parseLong(probe.getHeaderField("Content-Length")); } catch (Exception ignored) {}
            got.set(0);
            try (InputStream in = probe.getInputStream(); RandomAccessFile raf = new RandomAccessFile(out, "rw")) {
                raf.setLength(0); copy(in, raf, Long.MAX_VALUE, cancelled, got, tick, new long[1]);
            } finally { probe.disconnect(); }
            if (res.total < 0) res.total = got.get();
            return res;
        }
        if (!res.ranged) {
            // (Cut but of unknown size, an empty file the range does not fit — 416 —, …: the whole file at once.)
            probe.disconnect();
            if (code >= 400 && code != 416) throw new Status(code);
            HttpURLConnection c = follow(url, opener, null);
            int rc = c.getResponseCode();
            if (rc >= 400) { c.disconnect(); throw new Status(rc); }
            try { res.total = Long.parseLong(c.getHeaderField("Content-Length")); } catch (Exception ignored) {}
            got.set(0);
            try (InputStream in = c.getInputStream(); RandomAccessFile raf = new RandomAccessFile(out, "rw")) {
                raf.setLength(0); copy(in, raf, Long.MAX_VALUE, cancelled, got, tick, new long[1]);
            } finally { c.disconnect(); }
            if (res.total < 0) res.total = got.get();
            return res;
        }
        final String validator = validatorOf(probe);
        drain(probe);
        final long total = res.total;
        int n = (int) Math.max(1, Math.min(maxConnections, total / (512 * 1024)));
        // Going on from before: the same size, and the server said (206 to If-Range) it is the same file.
        final boolean resumed = prev != null && prev.total == total && out.length() == total && (prev.validator.isEmpty() || prev.validator.equals(validator) || validator.isEmpty());
        final State st;
        if (resumed) st = prev;
        else {
            // Chunks: about a quarter of each connection's share, between 1 and 8 MB.
            st = new State(); st.total = total; st.chunk = Math.max(1L << 20, Math.min(8L << 20, total / Math.max(1, n * 4)));
            try (RandomAccessFile raf = new RandomAccessFile(out, "rw")) { raf.setLength(0); raf.setLength(total); }
        }
        st.validator = validator.isEmpty() ? st.validator : validator;
        final long chunk = st.chunk; final int chunks = (int) ((total + chunk - 1) / chunk);
        // What is done already: counted, and shown on the file map.
        long have = 0; int runFrom = -1;
        for (int i = 0; i <= chunks; i++) {
            boolean d = i < chunks && st.has(i);
            if (d) { have += Math.min(total, (long) (i + 1) * chunk) - (long) i * chunk; if (runFrom < 0) runFrom = i; }
            else if (runFrom >= 0) { Seg s = new Seg((long) runFrom * chunk, Math.min(total, (long) i * chunk), -1); s.pos = s.end; s.active = false; res.segs.add(s); runFrom = -1; }
        }
        got.set(have);
        st.write(opt.state);
        res.connections = n;
        final java.util.concurrent.atomic.AtomicInteger next = new java.util.concurrent.atomic.AtomicInteger(0);
        final java.util.concurrent.ConcurrentLinkedQueue<long[]> back = new java.util.concurrent.ConcurrentLinkedQueue<>();   // {chunk, from}: given back by a refused connection
        final java.util.concurrent.atomic.AtomicInteger alive = new java.util.concurrent.atomic.AtomicInteger(n);
        final AtomicReference<Exception> fail = new AtomicReference<>();
        final URL direct = res.finalUrl;
        final long[] lastSave = { System.currentTimeMillis() };
        Thread[] workers = new Thread[n];
        for (int i = 0; i < n; i++) {
            final int wid = i;
            workers[i] = new Thread(() -> {
                final boolean[] gone = { false };
                try (RandomAccessFile raf = new RandomAccessFile(out, "rw")) {
                    while (fail.get() == null && !cancelled.get()) {
                        long[] given = back.poll(); int idx; long from;
                        if (given != null) { idx = (int) given[0]; from = given[1]; }
                        else { idx = next.getAndIncrement(); while (idx < chunks && st.has(idx)) idx = next.getAndIncrement(); if (idx >= chunks) break; from = (long) idx * chunk; }
                        long to = Math.min(total, (long) (idx + 1) * chunk) - 1;
                        long pos = from;
                        final Seg seg = new Seg(from, to + 1, wid); res.segs.add(seg);
                        boolean leave = false;
                        for (int attempt = 0; pos <= to && !cancelled.get(); attempt++) {
                            // (The signed address may have run out: the first address again, redirects and all.)
                            URL u = attempt >= 2 ? url : direct;
                            HttpURLConnection c = null;
                            long[] wrote = new long[1];
                            try {
                                c = follow(u, opener, "bytes=" + pos + "-" + to);
                                int rc = c.getResponseCode();
                                if (rc != 206) throw new Status(rc);
                                try (InputStream in = c.getInputStream()) {
                                    raf.seek(pos);
                                    final long base = pos; final long[] w = wrote;
                                    copy(in, raf, to - pos + 1, cancelled, got, () -> { seg.advance(base + w[0]); tick.run(); }, wrote);
                                }
                                pos += wrote[0]; wrote[0] = 0;
                                // (An answer that ended early without an error is a failed attempt too.)
                                if (pos <= to && !cancelled.get()) throw new IOException("Connection closed early");
                            } catch (Exception e) {
                                // (What came before the break is in the file already: the next attempt goes on from there.)
                                pos += wrote[0];
                                if (c != null) c.disconnect();
                                int sc = e instanceof Status ? ((Status) e).code : 0;
                                // (A connection the server cuts — reset, closed mid-handshake — as protected sites do to
                                // a client opening many at once: refused like a 429, when others are still going.)
                                if (sc == 0 && cut(e) && alive.get() > 1) sc = 429;
                                // A server refusing one connection too many: this one stops, its chunk to the others.
                                if ((sc == 429 || sc == 503) && alive.decrementAndGet() >= 1) { gone[0] = true; back.add(new long[]{ idx, pos }); res.refused = true; res.connections = alive.get(); leave = true; break; } else if (sc == 429 || sc == 503) alive.incrementAndGet();
                                if (attempt >= opt.retries) throw e;
                                try { Thread.sleep(Math.min(8000L, 400L * (attempt + 1) * (sc == 429 || sc == 503 ? 3 : 1))); } catch (InterruptedException ie) { throw e; }
                            }
                        }
                        seg.pos = Math.min(pos, to + 1); seg.active = false; seg.speed = 0;
                        if (leave) return;
                        if (pos > to) { st.mark(idx); long now = System.currentTimeMillis(); if (now - lastSave[0] > 1500) { lastSave[0] = now; st.write(opt.state); } }
                    }
                } catch (Exception e) { fail.compareAndSet(null, e); }
                finally { if (!gone[0]) alive.decrementAndGet(); }
            });
            workers[i].start();
        }
        for (Thread w : workers) w.join();
        st.write(opt.state);
        if (fail.get() != null && !cancelled.get()) throw fail.get();
        // (A chunk given back after the others had finished: a second round, over the connections still accepted.)
        if (!cancelled.get() && res.refused && !back.isEmpty()) { for (Seg s : res.segs) s.active = false; res.segs.clear(); return fetch(url, out, Math.max(1, res.connections), opener, cancelled, got, res, tick, opt); }
        if (!cancelled.get()) for (int i = 0; i < chunks; i++) if (!st.has(i)) throw new IOException("incomplete (" + got.get() + " of " + total + ")");
        // (Every chunk is counted as it comes; anything less than the whole file is a hole in it.)
        if (!cancelled.get() && got.get() < total) throw new IOException("incomplete (" + got.get() + " of " + total + ")");
        if (!cancelled.get() && opt.state != null) opt.state.delete();
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
