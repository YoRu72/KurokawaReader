package app.kurokawa.tools;

import app.kurokawa.tools.KtCore;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The HTTP downloader with its decisions made by the Rust core (stage M2; kt-core's httpdl.rs through KtCore's
 * `http.*` methods): the same public surface as {@link KrDownloader#fetch} — the same Result, Seg, Opts and Limiter,
 * the same record file — and the same rules, ported; Java still moves every byte here (HttpURLConnection with the
 * app's DNS over HTTPS, cookies, proxy and Android's certificates; the file writes; the threads, the limiters, the
 * sleeps). What Rust answers: what the first answer means, whether and how to go on from the record, which range a
 * connection takes next (a split at the end), what of a read is still a part's own, the speeds and the record, what an
 * error means (again after how long, a refusal, give up), connections added, how the run ends. MEGA files are
 * decrypted by Rust too (`bytes.megaCtr`).
 *
 * No core (or `KtCore` absent): {@link KrDownloader#fetch} itself, silently. A Rust error is thrown as {@link RustError}
 * with the bytes this run wrote, so the engine can tell «before the first byte» (start again on Java) from «after»
 * (pause; the record is shared, so Java goes on from it). Plain Java (java.net only), like KrDownloader, so the host
 * test (apps/tools/core/kt-android/jvmtest/downloader-rust.sh) runs tests/native/T.java through it.
 */
final class KrDownloaderRs {
    private KrDownloaderRs() {}

    /** Downloads restarted on Java because the Rust core failed before their first byte (deviceInfo shows it). */
    static final AtomicInteger FALLBACKS = new AtomicInteger();
    /** Runs made with the Rust core (tests: proof that it, not the Java engine, did them). */
    static final AtomicInteger RUST_RUNS = new AtomicInteger();

    /** The Rust core failed (an error answer, a panic caught there, a call that could not be made). */
    static final class RustError extends IOException {
        /** Bytes this run had written when it failed (0: nothing yet — Java may start it again at once). */
        final long wrote;
        RustError(String m, long wrote) { super("rust: " + m); this.wrote = wrote; }
    }

    static KrDownloader.Result fetch(URL url, File out, int maxConnections, KrDownloader.Opener opener, AtomicBoolean cancelled, AtomicLong got, KrDownloader.Result res, Runnable tick) throws Exception {
        return fetch(url, out, maxConnections, opener, cancelled, got, res, tick, new KrDownloader.Opts());
    }

    static KrDownloader.Result fetch(URL url, File out, int maxConnections, KrDownloader.Opener opener, AtomicBoolean cancelled, AtomicLong got, KrDownloader.Result res, Runnable tick, KrDownloader.Opts opt) throws Exception {
        if (!KtCore.available()) {
            // (Tests ask for the Rust engine or a failure: a silent Java run would prove nothing.)
            if (Boolean.getBoolean("kt.dl.strict")) throw new IllegalStateException("Rust core absent: " + KtCore.status());
            return KrDownloader.fetch(url, out, maxConnections, opener, cancelled, got, res, tick, opt);
        }
        RUST_RUNS.incrementAndGet();
        Run r = new Run(url, opener, cancelled, got, res, tick, opt);
        try { return r.fetch(out, maxConnections); }
        catch (KtCore.Failure f) { throw new RustError(f.getMessage(), r.mine.get()); }
        catch (RustError e) { throw new RustError(e.getMessage().replaceFirst("^rust: ", ""), r.mine.get()); }
    }

    /* ---------- the Rust core's answers ---------- */

    private static Object call(String method, Object... kv) throws KtCore.Failure { return KtCore.r(method, kv); }
    @SuppressWarnings("unchecked")
    private static Map<String, Object> obj(Object o) throws KtCore.Failure { if (o instanceof Map) return (Map<String, Object>) o; throw new KtCore.Failure("bad answer"); }
    private static Map<String, Object> ask(String method, Object... kv) throws KtCore.Failure { return obj(call(method, kv)); }
    private static long num(Object o) throws KtCore.Failure { if (o instanceof Number) return ((Number) o).longValue(); throw new KtCore.Failure("bad number"); }
    private static double dbl(Object o) { return o instanceof Number ? ((Number) o).doubleValue() : 0; }
    private static boolean yes(Object o) { return Boolean.TRUE.equals(o); }
    private static long now() { return System.currentTimeMillis(); }

    /** MEGA's decryption at `pos` by the Rust core (KrDownloader.CtrFile's, ported). */
    static byte[] megaPlain(byte[] key, long pos, byte[] b, int off, int len) throws RustError {
        StringBuilder hx = new StringBuilder(64); for (byte x : key) hx.append(String.format("%02x", x & 255));
        byte[] in = new byte[len]; System.arraycopy(b, off, in, 0, len);
        try { byte[] o = KtCore.callBytes("bytes.megaCtr", "{\"key\":\"" + hx + "\",\"pos\":" + pos + "}", in); if (o.length != len) throw new RustError("megaCtr length", 0); return o; }
        catch (KtCore.Failure f) { throw new RustError(f.getMessage(), 0); }
    }
    /** The file a download is written to: as it is, or — a MEGA file — decrypted by the Rust core at its own place. */
    private static RandomAccessFile writer(File out, KrDownloader.Opts opt) throws IOException {
        final byte[] k = opt != null && opt.megaKey != null && opt.megaKey.length == 32 ? opt.megaKey : null;
        if (k == null) return new RandomAccessFile(out, "rw");
        return new RandomAccessFile(out, "rw") {
            @Override public void write(byte[] b, int off, int len) throws IOException { if (len <= 0) return; super.write(megaPlain(k, getFilePointer(), b, off, len), 0, len); }
            @Override public void write(byte[] b) throws IOException { write(b, 0, b.length); }
            @Override public void write(int x) throws IOException { write(new byte[] { (byte) x }, 0, 1); }
        };
    }

    /** One fetch (and its second rounds): what every thread of it shares. */
    private static final class Run {
        final URL url; final KrDownloader.Opener opener; final AtomicBoolean cancelled; final AtomicLong got; final KrDownloader.Result res; final Runnable tick; final KrDownloader.Opts opt;
        /** Bytes this engine wrote in this call (to tell a Rust failure before the first byte from one after). */
        final AtomicLong mine = new AtomicLong();
        /** The newest record written (the Rust core numbers them; an older one never overwrites a newer). */
        private long savedSeq = -1;
        Run(URL url, KrDownloader.Opener opener, AtomicBoolean cancelled, AtomicLong got, KrDownloader.Result res, Runnable tick, KrDownloader.Opts opt) { this.url = url; this.opener = opener; this.cancelled = cancelled; this.got = got; this.res = res; this.tick = tick; this.opt = opt; }

        synchronized void save(Object text, Object seq) throws KtCore.Failure {
            if (!(text instanceof String) || opt.state == null) return; long s = num(seq); if (s <= savedSeq) return; savedSeq = s;
            File f = opt.state, tmp = new File(f.getPath() + ".tmp");
            // (java.io, not java.nio.file: the app's oldest Android, 7.0, has no Path.)
            try (java.io.FileOutputStream o = new java.io.FileOutputStream(tmp)) { o.write(((String) text).getBytes(java.nio.charset.StandardCharsets.UTF_8)); } catch (IOException e) { return; }
            if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f); }
        }
        static String readText(File f) {
            if (f == null || !f.exists()) return null;
            try (java.io.FileInputStream in = new java.io.FileInputStream(f)) { java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream(); byte[] buf = new byte[4096]; int r; while ((r = in.read(buf)) > 0) b.write(buf, 0, r); return new String(b.toByteArray(), java.nio.charset.StandardCharsets.UTF_8); } catch (Exception e) { return null; }
        }

        KrDownloader.Result fetch(File out, int maxConnections) throws Exception {
            if (opt.cookies != null) KrDownloader.cookieSink = opt.cookies;
            if (opt.state == null) { opt.state = File.createTempFile("kt-download-", ".state", out.getAbsoluteFile().getParentFile()); opt.state.delete(); opt.state.deleteOnExit(); }
            String prev = out.exists() ? readText(opt.state) : null;
            URL[] at = { url };
            // (D4: asked again while the server is busy or the connection fails on the way — KrDownloader.probe, the same as Java's.)
            HttpURLConnection probe = KrDownloader.probe(url, opener, at, opt, res, cancelled, tick);
            if (probe == null) return res;
            int code = probe.getResponseCode();
            res.finalUrl = at[0];
            res.fileName = KrDownloader.dispositionName(probe.getHeaderField("Content-Disposition")); res.mime = probe.getContentType();
            Map<String, Object> p = ask("http.probe", "code", code, "contentType", res.mime, "cfMitigated", probe.getHeaderField("cf-mitigated"), "contentRange", probe.getHeaderField("Content-Range"),
                "contentLength", probe.getHeaderField("Content-Length"), "etag", probe.getHeaderField("ETag"), "lastModified", probe.getHeaderField("Last-Modified"), "expectName", opt.expectName, "named", opt.named != null, "total", res.total);
            if (yes(p.get("page"))) { probe.disconnect(); throw new KrDownloader.WebPage(); }
            // (The file's own name, as soon as it is known: the download goes on under it.)
            if (yes(p.get("askName")) && opt.named != null) { java.util.function.BiFunction<String, String, File> nm = opt.named; opt.named = null; File to = nm.apply(res.fileName, res.mime);
                if (to != null && !to.equals(out)) { probe.disconnect(); if (out.exists() && !to.exists()) out.renameTo(to); res.out = to; return fetch(to, maxConnections); } }
            res.total = num(p.get("total")); res.ranged = yes(p.get("ranged"));
            String kind = String.valueOf(p.get("kind"));
            if (kind.equals("whole")) {
                // (The server ignored the range — or the file changed since — and sends the whole file: read from this answer.)
                if (opt.state != null) opt.state.delete();
                got.set(0);
                try (InputStream in = probe.getInputStream(); RandomAccessFile raf = writer(out, opt)) { raf.setLength(0); copy(in, raf); }
                finally { probe.disconnect(); }
                KrDownloader.whole(res, got, cancelled);
                if (res.total < 0) res.total = got.get();
                return res;
            }
            if (kind.equals("fail")) { probe.disconnect(); throw new KrDownloader.Status((int) num(p.get("code"))); }
            if (kind.equals("single")) {
                // (Cut but of unknown size, an empty file the range does not fit — 416 —, …: the whole file at once.)
                probe.disconnect();
                HttpURLConnection c = KrDownloader.follow(url, opener, null);
                int rc = c.getResponseCode();
                Map<String, Object> s = ask("http.single", "code", rc, "contentLength", c.getHeaderField("Content-Length"), "total", res.total);
                if (s.get("fail") != null) { c.disconnect(); throw new KrDownloader.Status(rc); }
                res.total = num(s.get("total"));
                got.set(0);
                try (InputStream in = c.getInputStream(); RandomAccessFile raf = writer(out, opt)) { raf.setLength(0); copy(in, raf); }
                finally { c.disconnect(); }
                KrDownloader.whole(res, got, cancelled);
                if (res.total < 0) res.total = got.get();
                return res;
            }
            if (!kind.equals("ranged")) throw new KtCore.Failure("kind " + kind);
            final String validator = String.valueOf(p.get("validator"));
            KrDownloader.drain(probe);
            return ranged(out, maxConnections, res.total, validator, prev);
        }

        /** The file cut into chunks over several connections, every choice the Rust core's. */
        private KrDownloader.Result ranged(File out, int maxConnections, final long total, String validator, String prev) throws Exception {
            Map<String, Object> b = ask("http.begin", "total", total, "validator", validator, "maxConnections", maxConnections, "scale", opt.scale, "retries", opt.retries,
                "prev", prev, "outLength", out.length(), "outExists", out.exists(), "refused", res.refused, "now", now());
            final long h = num(b.get("h"));
            try {
                Map<String, Object> need = obj(b.get("need"));
                // Going on from before: the places asked whether they are zero; chunks compared with the server's.
                for (int guard = 0; guard < 8 && !"go".equals(need.get("k")); guard++) {
                    if ("zero".equals(need.get("k"))) need = ask("http.zero", "h", h, "zero", zeros(out, (List<?>) need.get("at")), "now", now());
                    else if ("check".equals(need.get("k"))) { List<Long> ok = new ArrayList<>(); boolean broken = check(out, (List<?>) need.get("chunks"), (List<?>) need.get("windows"), (int) num(need.get("threads")), ok); need = ask("http.checked", "h", h, "ok", ok, "broken", broken, "now", now()); }
                    else throw new KtCore.Failure("need " + need.get("k"));
                }
                if (!"go".equals(need.get("k"))) throw new KtCore.Failure("plan never ended");
                if (yes(need.get("fresh"))) { try (RandomAccessFile raf = new RandomAccessFile(out, "rw")) { raf.setLength(0); raf.setLength(total); } }
                else if (yes(need.get("grow"))) { try (RandomAccessFile raf = new RandomAccessFile(out, "rw")) { if (raf.length() < total) raf.setLength(total); } }
                // What is done already: counted, and shown on the file map.
                for (Object o : (List<?>) need.get("runs")) { List<?> se = (List<?>) o; KrDownloader.Seg s = new KrDownloader.Seg(num(se.get(0)), num(se.get(1)), -1); s.pos = s.end; s.active = false; res.segs.add(s); }
                got.set(num(need.get("have")));
                save(need.get("record"), need.get("seq"));
                return run(out, h, (int) num(need.get("n")), (int) num(need.get("first")), total, maxConnections);
            } finally { try { call("http.close", "h", h); } catch (KtCore.Failure ignored) {} }
        }

        private KrDownloader.Result run(File out, final long h, final int n, final int first, final long total, int maxConnections) throws Exception {
            res.connections = first;
            final AtomicReference<Exception> fail = new AtomicReference<>();
            final URL direct = res.finalUrl;
            final java.util.concurrent.ConcurrentHashMap<Long, KrDownloader.Seg> segs = new java.util.concurrent.ConcurrentHashMap<>();
            Thread[] workers = new Thread[n];
            for (int i = 0; i < n; i++) { final int wid = i; workers[i] = new Thread(() -> worker(out, h, wid, direct, segs, fail)); }
            for (int i = 0; i < first; i++) workers[i].start();
            // (Scaling: every second the Rust core is told; it says how many more to start, or that it is enough.)
            int started = first;
            if (started < n) {
                call("http.scaleBegin", "h", h, "now", now());
                while (yes(call("http.scaling", "h", h, "cancelled", cancelled.get(), "failed", fail.get() != null))) {
                    Thread.sleep(1000);
                    boolean any = false; for (int i = 0; i < started; i++) if (workers[i].isAlive()) { any = true; break; }
                    Map<String, Object> s = ask("http.scale", "h", h, "now", now(), "anyAlive", any);
                    if (yes(s.get("stop"))) break;
                    int add = (int) Math.min(n - started, num(s.get("add")));
                    for (int i = started; i < started + add; i++) workers[i].start();
                    started += add; if (add > 0) res.connections = (int) num(s.get("connections"));
                }
            }
            res.connections = Math.min(res.connections, started);
            for (int i = 0; i < started; i++) workers[i].join();
            Map<String, Object> f = ask("http.finish", "h", h, "cancelled", cancelled.get(), "failed", fail.get() != null);
            save(f.get("record"), f.get("seq"));
            res.refused = res.refused || yes(f.get("refused")); res.connections = (int) num(f.get("connections"));
            String what = String.valueOf(f.get("do"));
            if (what.equals("throw")) { Exception e = fail.get(); throw e != null ? e : new IOException("failed"); }
            if (what.equals("again")) {
                // (A chunk given back after the others had finished: a second round, over the connections still accepted.)
                for (KrDownloader.Seg s : res.segs) s.active = false; res.segs.clear();
                try { call("http.close", "h", h); } catch (KtCore.Failure ignored) {}
                return fetch(out, Math.max(1, res.connections));
            }
            if (what.equals("incomplete")) throw new IOException("incomplete (" + got.get() + " of " + total + ")");
            if (what.equals("done") && opt.state != null) opt.state.delete();
            return res;
        }

        /** One connection: ranges from the Rust core until it says there is none. */
        private void worker(File out, long h, int wid, URL direct, java.util.concurrent.ConcurrentHashMap<Long, KrDownloader.Seg> segs, AtomicReference<Exception> fail) {
            boolean failed = false;
            try (RandomAccessFile raf = writer(out, opt)) {
                while (fail.get() == null && !cancelled.get()) {
                    Map<String, Object> nx = ask("http.next", "h", h, "w", wid, "now", now());
                    if (!"range".equals(nx.get("k"))) break;
                    Object sp = nx.get("split");
                    if (sp instanceof Map) { Map<String, Object> m = obj(sp); KrDownloader.Seg v = segs.get(num(m.get("seg"))); if (v != null) synchronized (v) { v.stopAt = num(m.get("stopAt")); } }
                    final long sid = num(nx.get("seg"));
                    final KrDownloader.Seg seg = new KrDownloader.Seg(num(nx.get("from")), num(nx.get("to")), wid); seg.chunk = (int) num(nx.get("idx")); segs.put(sid, seg); res.segs.add(seg);
                    long pos = seg.start; boolean leave = false, first = false;
                    while (pos < seg.stopAt && !cancelled.get()) {
                        // (The signed address may have run out: the first address again, redirects and all.)
                        URL u = first ? url : direct;
                        HttpURLConnection c = null; long[] wrote = new long[1];
                        try {
                            c = KrDownloader.follow(u, opener, "bytes=" + pos + "-" + (seg.stopAt - 1));
                            int rc = c.getResponseCode();
                            if (rc != 206) throw new KrDownloader.Status(rc);
                            try (InputStream in = c.getInputStream()) { copySeg(in, raf, h, sid, seg, pos, wrote); }
                            pos += wrote[0]; wrote[0] = 0;
                            // (An answer that ended early without an error is a failed attempt too.)
                            if (pos < seg.stopAt && !cancelled.get()) throw new IOException("Connection closed early");
                        } catch (Exception e) {
                            if (e instanceof KtCore.Failure || e instanceof RustError) throw e;
                            pos += wrote[0];
                            if (c != null) c.disconnect();
                            int sc = e instanceof KrDownloader.Status ? ((KrDownloader.Status) e).code : 0;
                            String ra = null; try { ra = c == null ? null : c.getHeaderField("Retry-After"); } catch (Throwable ignored) {}
                            Map<String, Object> d = ask("http.error", "h", h, "seg", sid, "status", sc, "cut", KrDownloader.cut(e), "retryAfter", ra, "now", now());
                            String act = String.valueOf(d.get("do"));
                            if (act.equals("leave")) { res.refused = true; res.connections = (int) num(d.get("connections")); leave = true; break; }
                            if (act.equals("fail")) throw e;
                            first = yes(d.get("first"));
                            try { Thread.sleep(num(d.get("wait"))); } catch (InterruptedException ie) { throw e; }
                        } finally { if (c != null) c.disconnect(); }
                    }
                    Map<String, Object> end = ask("http.segEnd", "h", h, "seg", sid, "now", now());
                    synchronized (seg) { seg.pos = num(end.get("pos")); seg.active = false; seg.speed = 0; }
                    save(end.get("save"), end.get("seq"));
                    if (leave) return;
                }
            } catch (Exception e) { failed = true; fail.compareAndSet(null, e); }
            finally { try { call("http.workerEnd", "h", h, "w", wid, "failed", failed); } catch (KtCore.Failure e) { fail.compareAndSet(null, e); } }
        }

        /** A part's bytes until its end — which the Rust core may bring nearer while it runs (its second half taken by
         *  another connection): only what is still this part's is written and counted. */
        private void copySeg(InputStream in, RandomAccessFile raf, long h, long sid, KrDownloader.Seg seg, long base, long[] wrote) throws IOException, KtCore.Failure {
            byte[] buf = new byte[1 << 17]; int r; final KrDownloader.Stall stall = new KrDownloader.Stall(opt.stallMs, opt.limiter);
            while (!cancelled.get()) {
                long left = seg.stopAt - (base + wrote[0]); if (left <= 0) break;
                boolean limited = KrDownloader.GLOBAL.rate() > 0 || (opt.limiter != null && opt.limiter.rate() > 0);   // (each read: a limit set while it runs is felt at once)
                int want = (int) Math.min(limited ? 1 << 14 : buf.length, left);
                try { if (opt.limiter != null) opt.limiter.take(want); KrDownloader.GLOBAL.take(want); } catch (InterruptedException ie) { throw new IOException("cancelled"); }
                r = in.read(buf, 0, want); if (r <= 0) break;
                stall.saw(r);
                int n = (int) num(call("http.take", "h", h, "seg", sid, "n", r));
                if (n > 0) { raf.seek(base + wrote[0]); raf.write(buf, 0, n); wrote[0] += n; got.addAndGet(n); mine.addAndGet(n); seg.pos = base + wrote[0]; }
                if (n < r) break;   // (cut short by a split: its end reached, nothing more to note)
                Map<String, Object> w = ask("http.wrote", "h", h, "seg", sid, "now", now());
                seg.stopAt = num(w.get("stopAt")); seg.speed = dbl(w.get("speed"));
                save(w.get("save"), w.get("seq"));
                tick.run();
            }
        }

        /** Copies the whole answer (no ranges), counting as it goes. */
        private void copy(InputStream in, RandomAccessFile raf) throws IOException {
            byte[] buf = new byte[1 << 17]; int r; final KrDownloader.Stall stall = new KrDownloader.Stall(opt.stallMs, opt.limiter);
            while (!cancelled.get()) {
                boolean limited = KrDownloader.GLOBAL.rate() > 0 || (opt.limiter != null && opt.limiter.rate() > 0);
                int want = limited ? 1 << 14 : buf.length;
                try { if (opt.limiter != null) opt.limiter.take(want); KrDownloader.GLOBAL.take(want); } catch (InterruptedException ie) { throw new IOException("cancelled"); }
                if ((r = in.read(buf, 0, want)) <= 0) break;
                stall.saw(r);
                raf.write(buf, 0, r); got.addAndGet(r); mine.addAndGet(r); tick.run();
            }
        }

        /** For each place, whether the file's bytes from there (4 KB, or to its end) are all zero (KrDownloader.zero). */
        private static List<Boolean> zeros(File out, List<?> at) throws KtCore.Failure {
            List<Boolean> z = new ArrayList<>(); byte[] b = new byte[4096];
            try (RandomAccessFile raf = new RandomAccessFile(out, "r")) {
                for (Object o : at) { raf.seek(Math.max(0, num(o))); int r = raf.read(b); boolean all = true; for (int k = 0; k < r; k++) if (b[k] != 0) { all = false; break; } z.add(r <= 0 || all); }
            } catch (IOException e) { while (z.size() < at.size()) z.add(false); }
            return z;
        }

        /** The chunks among `chunks` whose windows here are the server's (KrDownloader.check: the network and the bytes
         *  are Java's); answers whether the server could not be asked. */
        private boolean check(File out, List<?> chunks, List<?> windows, int threads, List<Long> okOut) throws KtCore.Failure {
            final List<long[][]> w = new ArrayList<>(); final List<Long> idx = new ArrayList<>();
            for (int k = 0; k < chunks.size(); k++) { idx.add(num(chunks.get(k))); List<?> ws = (List<?>) windows.get(k); long[][] a = new long[ws.size()][]; for (int j = 0; j < a.length; j++) { List<?> p = (List<?>) ws.get(j); a[j] = new long[] { num(p.get(0)), num(p.get(1)) }; } w.add(a); }
            final List<Long> ok = java.util.Collections.synchronizedList(new ArrayList<>()); final AtomicInteger next = new AtomicInteger(); final AtomicBoolean broken = new AtomicBoolean();
            final byte[] megaKey = opt.megaKey != null && opt.megaKey.length == 32 ? opt.megaKey : null; final URL u = res.finalUrl;
            Thread[] ts = new Thread[Math.max(1, Math.min(threads, idx.size()))];
            for (int t = 0; t < ts.length; t++) { ts[t] = new Thread(() -> {
                try (RandomAccessFile raf = new RandomAccessFile(out, "r")) {
                    for (int k; !cancelled.get() && !broken.get() && (k = next.getAndIncrement()) < idx.size(); ) {
                        boolean same = true;
                        for (long[] win : w.get(k)) {
                            long from = win[0]; int len = (int) win[1];
                            byte[] mineB = new byte[len]; raf.seek(from); raf.readFully(mineB);
                            HttpURLConnection c = null;
                            try { c = KrDownloader.follow(u, opener, "bytes=" + from + "-" + (from + len - 1)); if (c.getResponseCode() != 206) { broken.set(true); same = false; break; }
                                byte[] theirs = new byte[len]; int got = 0; try (InputStream in = c.getInputStream()) { int r; while (got < len && (r = in.read(theirs, got, len - got)) > 0) got += r; }
                                if (got == len && megaKey != null) theirs = megaPlain(megaKey, from, theirs, 0, len);
                                if (got != len || !java.util.Arrays.equals(mineB, theirs)) { same = false; break; }
                            } catch (RustError e) { broken.set(true); same = false; break; }
                            catch (IOException e) { broken.set(true); same = false; break; } finally { if (c != null) c.disconnect(); }
                        }
                        if (broken.get()) break; if (same) ok.add(idx.get(k));
                    }
                } catch (IOException ignored) {}
            }); ts[t].start(); }
            for (Thread t : ts) try { t.join(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); broken.set(true); ok.clear(); break; }
            okOut.addAll(ok);
            return broken.get();
        }
    }
}
