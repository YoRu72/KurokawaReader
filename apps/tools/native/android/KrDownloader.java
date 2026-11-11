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
    static final class Result { volatile File out; volatile String fileName, mime; volatile long total = -1; volatile boolean ranged, refused; volatile int connections = 1; volatile URL finalUrl; final java.util.List<Seg> segs = java.util.Collections.synchronizedList(new java.util.ArrayList<>()); }
    /** One range a connection is fetching (or fetched): what the details page draws as the file map and the lanes. */
    static final class Seg { final long start, end; volatile long pos; /** where this part stops now: brought nearer when an idle connection takes its second half */ volatile long stopAt; int chunk = -1; volatile double speed; volatile boolean active; volatile int worker; long lastT, lastPos; Seg(long s, long e, int w) { start = s; end = e; stopAt = e; pos = s; worker = w; active = true; lastT = System.currentTimeMillis(); lastPos = s; }
        void advance(long p) { pos = p; long now = System.currentTimeMillis(); if (now - lastT >= 500) { double inst = (p - lastPos) / ((now - lastT) / 1000.0); speed = speed == 0 ? inst : speed * 0.6 + inst * 0.4; lastT = now; lastPos = p; } } }

    private KrDownloader() {}

    /** What the engine sets: how many times a chunk is tried again, and where the progress is kept between runs. */
    /** A token bucket: bytes allowed per second, drawn by every reader before it reads (the global one over every download, a task's own over its segments); 0 lets everything through. */
    static final class Limiter {
        private volatile long rate; private double tokens; private long lastNs = System.nanoTime();
        Limiter(long bytesPerSecond) { rate = bytesPerSecond; }
        void set(long bytesPerSecond) { rate = Math.max(0, bytesPerSecond); }
        long rate() { return rate; }
        /** Blocks until `n` bytes may pass (at most a quarter second a turn, so a changed rate is felt soon: the rate read
         *  again each turn, a limit taken off lets the read through at once). The bucket holds at least `n` — capped at
         *  the rate alone, a limit under the 16 KB a read asks never let one through and the download stood still. */
        void take(int n) throws InterruptedException {
            for (;;) {
                long r = rate; if (r <= 0) return; long wait;
                synchronized (this) { long now = System.nanoTime(); tokens = Math.min(Math.max(r, n), tokens + (now - lastNs) / 1e9 * r); lastNs = now; if (tokens >= n) { tokens -= n; return; } wait = (long) ((n - tokens) / r * 1000); }
                Thread.sleep(Math.max(5, Math.min(250, wait)));
            }
        }
    }
    /** The limit over every HTTP download at once (set from the settings). */
    static final Limiter GLOBAL = new Limiter(0);
    /** The file a download is written to: as it is, or — a MEGA file — through its decryption. */
    static RandomAccessFile writer(File out, Opts opt) throws IOException { return opt != null && opt.megaKey != null && opt.megaKey.length == 32 ? new CtrFile(out, opt.megaKey) : new RandomAccessFile(out, "rw"); }
    /** A file whose every write is decrypted at its own place (MEGA: AES-128-CTR, the key the two halves of the node key
     *  XORed, the counter's first half the key's third quarter, its second half the block number) — so ranges, several
     *  connections and resuming all work as for any download. */
    static final class CtrFile extends RandomAccessFile {
        private final javax.crypto.spec.SecretKeySpec key; private final byte[] nonce = new byte[8];
        CtrFile(File f, byte[] k) throws IOException { super(f, "rw"); key = keyOf(k); System.arraycopy(k, 16, nonce, 0, 8); }
        static javax.crypto.spec.SecretKeySpec keyOf(byte[] k) { byte[] a = new byte[16]; for (int i = 0; i < 16; i++) a[i] = (byte) (k[i] ^ k[i + 16]); return new javax.crypto.spec.SecretKeySpec(a, "AES"); }
        /** The server's (encrypted) bytes at `pos` as they are in the file here. */
        static byte[] plain(byte[] k, long pos, byte[] b) throws IOException { return decrypt(keyOf(k), java.util.Arrays.copyOfRange(k, 16, 24), pos, b, 0, b.length); }
        static byte[] decrypt(javax.crypto.spec.SecretKeySpec key, byte[] nonce, long pos, byte[] b, int off, int len) throws IOException {
            try {
                byte[] iv = new byte[16]; System.arraycopy(nonce, 0, iv, 0, 8); long blk = pos >>> 4; for (int i = 15; i >= 8; i--) { iv[i] = (byte) blk; blk >>>= 8; }
                javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES/CTR/NoPadding"); c.init(javax.crypto.Cipher.DECRYPT_MODE, key, new javax.crypto.spec.IvParameterSpec(iv));
                int skip = (int) (pos & 15); if (skip > 0) c.update(new byte[skip]);
                return c.update(b, off, len);
            } catch (java.security.GeneralSecurityException e) { throw new IOException("mega: " + e.getMessage()); }
        }
        @Override public void write(byte[] b, int off, int len) throws IOException { if (len <= 0) return; super.write(decrypt(key, nonce, getFilePointer(), b, off, len), 0, len); }
        @Override public void write(byte[] b) throws IOException { write(b, 0, b.length); }
        @Override public void write(int x) throws IOException { write(new byte[] { (byte) x }, 0, 1); }
    }
    static final class Opts { int retries = 5; File state; /** A MEGA file's key (32 bytes): what comes is decrypted as it is written (AES-128-CTR, any offset). */ byte[] megaKey; /** This download's own speed limit, when it has one. */ Limiter limiter; /** The cookies a site sets (DDoS-Guard, Cloudflare…), kept for its next requests. */ java.util.function.BiConsumer<URL, java.util.List<String>> cookies; /** The name the file is expected to have (to tell a web page sent in its place). */ String expectName;
        /** Told the server's name and type as soon as it answers; the .part file to use from then on (null: as it is). */ java.util.function.BiFunction<String, String, File> named;
        /** Connections added while they help (Ookla's «connection scaling»): a few first, more while the speed still
         *  rises, none once it holds — a server that limits each connection is filled, one that does not is not
         *  crowded. Off: all of them at once. */ boolean scale = true; }
    /** `name` with the extension its type calls for when its own says nothing (.bin, none): an APK, a zip… */
    static String withTypeExt(String name, String mime) {
        if (name == null || mime == null) return null; String m = mime.toLowerCase(java.util.Locale.ROOT).replaceAll(";.*", "").trim();
        String ext = m.equals("application/vnd.android.package-archive") ? "apk" : m.equals("application/zip") || m.equals("application/x-zip-compressed") ? "zip" : m.equals("application/x-7z-compressed") ? "7z" : m.equals("application/vnd.rar") || m.equals("application/x-rar-compressed") ? "rar" : m.equals("video/mp4") ? "mp4" : m.equals("video/x-matroska") ? "mkv" : m.equals("application/pdf") ? "pdf" : m.equals("application/epub+zip") ? "epub" : null;
        if (ext == null) return null;
        String low = name.toLowerCase(java.util.Locale.ROOT); if (low.endsWith("." + ext)) return null;
        if (low.endsWith(".bin") || low.endsWith(".dat") || !low.matches(".*\\.[a-z0-9]{1,5}$")) return name.replaceAll("\\.(bin|dat)$", "") + "." + ext;
        return null;
    }
    /** What a finished file really is, from its first bytes (and, for a ZIP, what is inside): its extension, or null
     *  when it cannot be told. Sites that send everything as «application/octet-stream», or name it «file.bin». */
    static String sniffExt(File f) {
        byte[] b = new byte[4096]; int n = 0;
        try (java.io.FileInputStream in = new java.io.FileInputStream(f)) { int r; while (n < b.length && (r = in.read(b, n, b.length - n)) > 0) n += r; } catch (IOException e) { return null; }
        if (n < 4) return null;
        String head = new String(b, 0, n, java.nio.charset.StandardCharsets.ISO_8859_1);
        if (head.startsWith("PK\u0003\u0004") || head.startsWith("PK\u0005\u0006")) return zipKind(f);
        if (head.startsWith("%PDF")) return "pdf";
        if (head.startsWith("7z¼¯'\u001c")) return "7z";
        if (head.startsWith("Rar!")) return "rar";
        if ((b[0] & 255) == 0x1f && (b[1] & 255) == 0x8b) return "gz";
        if (head.startsWith("ý7zXZ")) return "xz";
        if (head.startsWith("BZh")) return "bz2";
        if (n >= 12 && head.startsWith("ftyp", 4)) { String brand = head.substring(8, 12); return brand.startsWith("M4A") ? "m4a" : brand.startsWith("qt") ? "mov" : brand.startsWith("hei") || brand.startsWith("mif1") ? "heic" : brand.startsWith("avif") ? "avif" : brand.startsWith("3gp") ? "3gp" : "mp4"; }
        if ((b[0] & 255) == 0x1a && (b[1] & 255) == 0x45 && (b[2] & 255) == 0xdf && (b[3] & 255) == 0xa3) return head.contains("webm") ? "webm" : "mkv";
        if (head.startsWith("OggS")) return head.contains("OpusHead") ? "opus" : "ogg";
        if (head.startsWith("fLaC")) return "flac";
        if (head.startsWith("ID3") || ((b[0] & 255) == 0xff && ((b[1] & 255) & 0xe6) == 0xe2)) return "mp3";
        if (n >= 12 && head.startsWith("RIFF")) { String k = head.substring(8, 12); return k.equals("WAVE") ? "wav" : k.equals("AVI ") ? "avi" : k.equals("WEBP") ? "webp" : null; }
        if (head.startsWith("\u0089PNG")) return "png";
        if ((b[0] & 255) == 0xff && (b[1] & 255) == 0xd8 && (b[2] & 255) == 0xff) return "jpg";
        if (head.startsWith("GIF8")) return "gif";
        if (head.startsWith("#EXTM3U")) return "m3u8";
        if (head.startsWith("d8:announce") || head.startsWith("d13:announce") || (head.startsWith("d") && head.contains("4:infod"))) return "torrent";
        if (head.startsWith("MZ")) return "exe";
        if (head.startsWith("ÐÏ\u0011à")) return null;   // (an old Office file or an MSI: cannot be told apart here)
        if (head.startsWith("G") && n > 376 && (b[188] & 255) == 0x47 && (b[376] & 255) == 0x47) return "ts";
        return null;
    }
    /** A file named as media or an archive whose first bytes are a web page or an XML error (what a storage answers
     *  when a link expired): the download was a page, not the file. */
    static boolean isPageNotMedia(File f, String name) {
        if (name == null || !name.toLowerCase(java.util.Locale.ROOT).matches(".*\\.(mp4|mkv|webm|avi|mov|m4v|ts|mp3|m4a|flac|ogg|opus|wav|aac|zip|7z|rar|apk|xapk|apkm|pdf|epub|cbz|jpe?g|png|gif|webp|iso|exe|msi|dmg|tar|gz|xz)$")) return false;
        byte[] b = new byte[1024]; int n = 0; try (java.io.FileInputStream in = new java.io.FileInputStream(f)) { int r; while (n < b.length && (r = in.read(b, n, b.length - n)) > 0) n += r; } catch (IOException e) { return false; }
        if (n < 16) return false; String head = new String(b, 0, n, java.nio.charset.StandardCharsets.ISO_8859_1).trim().toLowerCase(java.util.Locale.ROOT);
        return head.startsWith("<!doctype html") || head.startsWith("<html") || (head.startsWith("<?xml") && head.contains("<error")) || head.startsWith("{\"error\"") || head.startsWith("<error");
    }
    /** A ZIP's kind from its entries: an APK, an app bundle (XAPK, APKM, APKS), an e-book, an Office file, or a ZIP. */
    private static String zipKind(File f) {
        try (java.util.zip.ZipFile z = new java.util.zip.ZipFile(f)) {
            boolean manifest = false, dex = false, apks = false, xapkManifest = false, apkmInfo = false, epub = false, word = false, xl = false, ppt = false, cbz = true; int files = 0;
            java.util.Enumeration<? extends java.util.zip.ZipEntry> en = z.entries();
            while (en.hasMoreElements()) {
                java.util.zip.ZipEntry e = en.nextElement(); String nm = e.getName(); String low = nm.toLowerCase(java.util.Locale.ROOT);
                if (nm.equals("AndroidManifest.xml")) manifest = true; else if (nm.equals("classes.dex") || nm.equals("resources.arsc")) dex = true;
                else if (low.endsWith(".apk")) apks = true; else if (nm.equals("manifest.json")) xapkManifest = true; else if (nm.equals("info.json")) apkmInfo = true;
                else if (nm.equals("mimetype")) { try (InputStream in = z.getInputStream(e)) { byte[] m = new byte[40]; int k = in.read(m); epub = k > 0 && new String(m, 0, k, "US-ASCII").startsWith("application/epub+zip"); } }
                else if (nm.startsWith("word/")) word = true; else if (nm.startsWith("xl/")) xl = true; else if (nm.startsWith("ppt/")) ppt = true;
                if (!e.isDirectory()) { files++; if (!low.matches(".*\\.(jpe?g|png|webp|gif|avif|xml|txt|json)$")) cbz = false; }
            }
            if (manifest && dex) return "apk";
            if (apks) return xapkManifest ? "xapk" : apkmInfo ? "apkm" : "apks";
            if (epub) return "epub"; if (word) return "docx"; if (xl) return "xlsx"; if (ppt) return "pptx";
            if (cbz && files > 2) return "cbz";
            return "zip";
        } catch (IOException e) { return "zip"; }
    }
    /** The name with the sniffed extension, when its own says nothing (none, «.bin», «.dat»…) or only «a ZIP» of what is
     *  more (an APK, a bundle, an e-book); null: keep the name. */
    static String withSniffed(String name, String ext) {
        if (name == null || ext == null) return null; String low = name.toLowerCase(java.util.Locale.ROOT);
        if (low.endsWith("." + ext)) return null;
        int dot = low.lastIndexOf('.'); String cur = dot > 0 ? low.substring(dot + 1) : "";
        // (A meaningless extension is replaced; a name whose last dot is not one — «Movie.S01E01», «v1.2» — kept whole.)
        boolean junk = cur.matches("bin|dat|tmp|file|download|dl|php|aspx?|jsp|cgi|octet-stream|unknown");
        boolean weak = junk || cur.isEmpty() || !cur.matches("[a-z0-9]{1,5}") || cur.matches("\\d+");
        boolean zipOf = cur.equals("zip") && !ext.equals("zip") && !ext.equals("cbz");
        // (Things that are ZIPs inside, kept as their own name says: a «.jar», «.apks» named on purpose, «.cbz», «.ipa»…)
        if (!weak && !zipOf) return null;
        String stem = dot > 0 && (junk || zipOf) ? name.substring(0, dot) : name;
        return stem + "." + ext;
    }
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
        /** Chunks begun but not finished: how many bytes from each one's start are in the file already. */
        final java.util.Map<Integer, Long> partial = new java.util.HashMap<>();
        static State read(File f) {
            if (f == null || !f.exists()) return null;
            try { String[] l = new String(java.nio.file.Files.readAllBytes(f.toPath()), java.nio.charset.StandardCharsets.UTF_8).split("\n", -1);
                if (l.length < 5 || !"kt1".equals(l[0])) return null;
                State s = new State(); s.total = Long.parseLong(l[1].trim()); s.validator = l[2].trim(); s.chunk = Long.parseLong(l[3].trim());
                for (String n : l[4].split(",")) if (!n.trim().isEmpty()) s.done.set(Integer.parseInt(n.trim()));
                if (l.length > 5) for (String kv : l[5].split(",")) { int c = kv.indexOf(':'); if (c > 0) try { s.partial.put(Integer.parseInt(kv.substring(0, c).trim()), Long.parseLong(kv.substring(c + 1).trim())); } catch (Exception ignored) {} }
                return s.total > 0 && s.chunk > 0 ? s : null;
            } catch (Exception e) { return null; }
        }
        synchronized void write(File f) {
            if (f == null) return;
            StringBuilder b = new StringBuilder("kt1\n").append(total).append('\n').append(validator.replace('\n', ' ')).append('\n').append(chunk).append('\n');
            for (int i = done.nextSetBit(0); i >= 0; i = done.nextSetBit(i + 1)) b.append(i).append(',');
            b.append('\n'); for (java.util.Map.Entry<Integer, Long> e : partial.entrySet()) if (e.getValue() > 0 && !done.get(e.getKey())) b.append(e.getKey()).append(':').append(e.getValue()).append(',');
            File tmp = new File(f.getPath() + ".tmp");
            try { java.nio.file.Files.write(tmp.toPath(), b.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)); if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f); } } catch (IOException ignored) {}
        }
        synchronized void mark(int i) { done.set(i); partial.remove(i); }
        synchronized void unmark(int i) { done.clear(i); }
        synchronized long partialOf(int i) { Long v = partial.get(i); return v == null ? 0 : v; }
        synchronized void setPartial(int i, long v) { if (v > 0) partial.put(i, v); else partial.remove(i); }
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
        // (No If-Range: a server whose validator changes from one answer to the next — CDNs, signed links — would
        // send the whole file again, and what was downloaded was thrown away. What is here is checked instead.)
        HttpURLConnection probe = follow(url, opener, "bytes=0-0", at, null);
        int code = probe.getResponseCode();
        res.finalUrl = at[0];
        res.fileName = dispositionName(probe.getHeaderField("Content-Disposition")); res.mime = probe.getContentType();
        // (A page in the file's place — a site's check or sign-in — said so, not saved under the file's name.)
        // (A site's own check in the way — Cloudflare says so in a header — : a browser's work, not a download's.)
        if ("challenge".equalsIgnoreCase(probe.getHeaderField("cf-mitigated"))) { probe.disconnect(); throw new WebPage(); }
        String ct = res.mime == null ? "" : res.mime.toLowerCase(java.util.Locale.ROOT);
        if ((ct.startsWith("text/html") || ct.startsWith("application/xhtml")) && opt.expectName != null && !opt.expectName.toLowerCase(java.util.Locale.ROOT).matches(".*\\.(html?|xhtml|php|aspx?)$") && (code == 200 || code == 206 || code == 403 || code == 503 || code == 429)) {
            long len = -1; try { len = Long.parseLong(probe.getHeaderField("Content-Length")); } catch (Exception ignored) {}
            if (len < 2_000_000) { probe.disconnect(); throw new WebPage(); }
        }
        // (The file's own name, as soon as it is known: the download goes on under it.)
        if (opt.named != null && (code == 200 || code == 206)) { java.util.function.BiFunction<String, String, File> nm = opt.named; opt.named = null; File to = nm.apply(res.fileName, res.mime);
            if (to != null && !to.equals(out)) { probe.disconnect(); if (out.exists() && !to.exists()) out.renameTo(to); res.out = to; return fetch(url, to, maxConnections, opener, cancelled, got, res, tick, opt); } }
        String cr = probe.getHeaderField("Content-Range");
        if (code == 206 && cr != null && cr.contains("/")) try { res.total = Long.parseLong(cr.substring(cr.lastIndexOf('/') + 1).trim()); } catch (Exception ignored) {}
        res.ranged = code == 206 && res.total > 0;
        if (code == 200) {
            // (The server ignored the range — or the file changed since — and sends the whole file: read from this answer.)
            if (opt.state != null) opt.state.delete();
            try { res.total = Long.parseLong(probe.getHeaderField("Content-Length")); } catch (Exception ignored) {}
            got.set(0);
            try (InputStream in = probe.getInputStream(); RandomAccessFile raf = writer(out, opt)) {
                raf.setLength(0); copy(in, raf, Long.MAX_VALUE, cancelled, got, tick, new long[1], opt.limiter);
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
            try (InputStream in = c.getInputStream(); RandomAccessFile raf = writer(out, opt)) {
                raf.setLength(0); copy(in, raf, Long.MAX_VALUE, cancelled, got, tick, new long[1], opt.limiter);
            } finally { c.disconnect(); }
            if (res.total < 0) res.total = got.get();
            return res;
        }
        final String validator = validatorOf(probe);
        drain(probe);
        final long total = res.total;
        int n = (int) Math.max(1, Math.min(maxConnections, total / (512 * 1024)));
        // Going on from before: the same size; the same version by its validator, or — when the validator changed
        // or is missing — by the bytes: pieces of what is here compared with the server's.
        final boolean sameSize = prev != null && prev.total == total && out.length() == total;
        boolean resumed = false; State st0 = null;
        if (sameSize) {
            localCheck(prev, out);
            boolean sameVersion = !prev.validator.isEmpty() && prev.validator.equals(validator);
            if (sameVersion || matches(res.finalUrl, opener, out, prev, Math.max(1, Math.min(4, maxConnections)), 12, mega(opt))) { st0 = prev; resumed = true; }
        } else if (prev == null && out.exists() && out.length() > 0 && out.length() <= total) {
            // (No record kept — lost, or a download begun elsewhere under this name —: the chunks already here found
            // by their bytes, each checked against the server's before it is kept.)
            State r = new State(); r.total = total; r.chunk = Math.max(1L << 20, Math.min(8L << 20, total / Math.max(1, n * 4)));
            int found = recover(res.finalUrl, opener, out, r, Math.max(1, Math.min(8, maxConnections)), cancelled, mega(opt));
            if (found > 0) { try (RandomAccessFile raf = new RandomAccessFile(out, "rw")) { if (raf.length() < total) raf.setLength(total); } st0 = r; resumed = true; }
        }
        final State st;
        if (resumed) st = st0;
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
            else if (i < chunks && st.partialOf(i) > 0) have += Math.min(st.partialOf(i), Math.min(total, (long) (i + 1) * chunk) - (long) i * chunk);
            if (!d && runFrom >= 0) { Seg s = new Seg((long) runFrom * chunk, Math.min(total, (long) i * chunk), -1); s.pos = s.end; s.active = false; res.segs.add(s); runFrom = -1; }
        }
        got.set(have);
        st.write(opt.state);
        final java.util.concurrent.atomic.AtomicInteger next = new java.util.concurrent.atomic.AtomicInteger(0);
        final java.util.concurrent.ConcurrentLinkedQueue<long[]> back = new java.util.concurrent.ConcurrentLinkedQueue<>();   // {chunk, from, to}: given back by a refused connection
        final int first = opt.scale && n > 3 ? Math.max(3, (n + 2) / 4) : n;
        final java.util.concurrent.atomic.AtomicInteger alive = new java.util.concurrent.atomic.AtomicInteger(first); res.connections = first;
        final AtomicReference<Exception> fail = new AtomicReference<>();
        final URL direct = res.finalUrl;
        final long[] lastSave = { System.currentTimeMillis() };
        // (A chunk may be shared at the end: how many of its parts are still coming — marked done when none is.)
        final java.util.concurrent.atomic.AtomicInteger[] parts = new java.util.concurrent.atomic.AtomicInteger[chunks];
        for (int i = 0; i < chunks; i++) parts[i] = new java.util.concurrent.atomic.AtomicInteger(0);
        final long MIN_SPLIT = 256L << 10;
        Thread[] workers = new Thread[n];
        for (int i = 0; i < n; i++) {
            final int wid = i;
            workers[i] = new Thread(() -> {
                final boolean[] gone = { false };
                // (Whether this connection has brought bytes in this download, and how many tries in a row it was cut
                // before the first byte: what tells a server refusing one more connection from a link that dropped.)
                final boolean[] servedOnce = { false }; final int[] blanks = { 0 };
                try (RandomAccessFile raf = writer(out, opt)) {
                    while (fail.get() == null && !cancelled.get()) {
                        long[] given = back.poll(); int idx; long from, toIncl;
                        if (given != null) { idx = (int) given[0]; from = given[1]; toIncl = given[2]; }
                        else {
                            idx = next.getAndIncrement(); while (idx < chunks && st.has(idx)) idx = next.getAndIncrement();
                            if (idx < chunks) { from = (long) idx * chunk + Math.min(st.partialOf(idx), chunk - 1); toIncl = Math.min(total, (long) (idx + 1) * chunk) - 1; parts[idx].incrementAndGet(); }
                            else {
                                // The end of the file, the way download accelerators and speed tests keep every
                                // connection busy: no chunk left, so the part that will take longest is cut in two
                                // and this connection takes its second half — a slow connection no longer holds
                                // up the last minutes.
                                Seg victim = null; double worst = 0;
                                synchronized (res.segs) { for (Seg sg : res.segs) { if (!sg.active || sg.chunk < 0) continue; long rem = sg.stopAt - sg.pos; if (rem < 2 * MIN_SPLIT) continue; double eta = rem / Math.max(16_384.0, sg.speed); if (eta > worst) { worst = eta; victim = sg; } } }
                                if (victim == null) break;
                                synchronized (victim) { long rem = victim.stopAt - victim.pos; if (rem < 2 * MIN_SPLIT || !victim.active) continue; from = victim.pos + rem / 2; toIncl = victim.stopAt - 1; victim.stopAt = from; idx = victim.chunk; parts[idx].incrementAndGet(); }
                            }
                        }
                        final Seg seg = new Seg(from, toIncl + 1, wid); seg.chunk = idx; res.segs.add(seg);
                        // (A chunk's own run from its start — not a half taken from another —: how far it got is kept.)
                        final boolean fromStart = given == null && from == (long) idx * chunk + st.partialOf(idx); final long chunkStart = (long) idx * chunk;
                        long pos = from;
                        boolean leave = false;
                        for (int attempt = 0; pos < seg.stopAt && !cancelled.get(); attempt++) {
                            // (The signed address may have run out: the first address again, redirects and all.)
                            URL u = attempt >= 2 ? url : direct;
                            HttpURLConnection c = null;
                            long[] wrote = new long[1];
                            final long tryFrom = pos;
                            try {
                                c = follow(u, opener, "bytes=" + pos + "-" + (seg.stopAt - 1));
                                int rc = c.getResponseCode();
                                if (rc != 206) throw new Status(rc);
                                try (InputStream in = c.getInputStream()) {
                                    final long base = pos; final long[] w = wrote;
                                    copySeg(in, raf, seg, base, cancelled, got, () -> { seg.advance(base + w[0]); if (fromStart) st.setPartial(seg.chunk, base + w[0] - chunkStart); long now = System.currentTimeMillis(); if (now - lastSave[0] > 3000) { lastSave[0] = now; st.write(opt.state); } tick.run(); }, wrote, opt.limiter);
                                }
                                pos += wrote[0]; wrote[0] = 0; if (pos > tryFrom) { servedOnce[0] = true; blanks[0] = 0; }
                                // (An answer that ended early without an error is a failed attempt too.)
                                if (pos < seg.stopAt && !cancelled.get()) throw new IOException("Connection closed early");
                            } catch (Exception e) {
                                // (What came before the break is in the file already: the next attempt goes on from there. An
                                // attempt that brought bytes is no failure to count — a weak phone link drops a connection every
                                // few hundred kilobytes and still gets there —; only attempts that brought nothing use the retries.)
                                pos += wrote[0]; final boolean moved = pos > tryFrom; if (moved) { attempt = -1; servedOnce[0] = true; blanks[0] = 0; }
                                if (c != null) c.disconnect();
                                int sc = e instanceof Status ? ((Status) e).code : 0;
                                // (A connection cut is taken as the server refusing one more only when this connection never got a
                                // byte through and was cut before the first one twice running while others go on — some servers
                                // drop the extra connection instead of answering 429/503. A cut after bytes came is the network (a
                                // weak phone link): the range is tried again and the connection kept; taken as a refusal, every
                                // drop retired a connection for the rest of the download and lowered what this host is asked
                                // next time, down to one.)
                                if (sc == 0 && !servedOnce[0] && cut(e) && ++blanks[0] >= 2 && alive.get() > 1) sc = 429;
                                // (Some storage answers 403 to one connection too many while the others go on: taken as a refusal.)
                                if ((sc == 403 || sc == 401) && alive.get() > 1 && got.get() > 0) sc = 429;
                                // A server refusing one connection too many: this one stops, its part to the others.
                                if ((sc == 429 || sc == 503) && alive.decrementAndGet() >= 1) { gone[0] = true; synchronized (seg) { seg.active = false; back.add(new long[]{ idx, pos, seg.stopAt - 1 }); } res.refused = true; res.connections = alive.get(); leave = true; break; } else if (sc == 429 || sc == 503) alive.incrementAndGet();
                                if (attempt >= opt.retries) throw e;
                                if (moved) { try { Thread.sleep(250); } catch (InterruptedException ie) { throw e; } continue; }
                                long after = 0; try { String ra = c == null ? null : c.getHeaderField("Retry-After"); if (ra != null) { ra = ra.trim(); after = ra.matches("\\d+") ? Long.parseLong(ra) * 1000 : Math.max(0, java.util.Date.parse(ra) - System.currentTimeMillis()); } } catch (Throwable ignored) {}
                                try { Thread.sleep(after > 0 ? Math.min(60000L, after) : Math.min(8000L, 400L * (attempt + 1) * (sc == 429 || sc == 503 ? 3 : 1))); } catch (InterruptedException ie) { throw e; }
                            } finally { if (c != null) c.disconnect(); }
                        }
                        synchronized (seg) { seg.pos = Math.min(pos, seg.stopAt); seg.active = false; seg.speed = 0; }
                        if (leave) return;
                        if (pos >= seg.stopAt && parts[idx].decrementAndGet() == 0) { st.mark(idx); long now = System.currentTimeMillis(); if (now - lastSave[0] > 1500) { lastSave[0] = now; st.write(opt.state); } }
                    }
                } catch (Exception e) { fail.compareAndSet(null, e); }
                finally { if (!gone[0]) alive.decrementAndGet(); }
            });
        }
        for (int i = 0; i < first; i++) workers[i].start();
        // (Scaling, the way speed tests fill a line: every second the speed's quick and slow averages; while the
        // quick one still climbs past what it was before the last connections were added, as many again are
        // added — up to all of them; once a step brings nothing, or the server refuses one, no more.)
        int started = first;
        if (started < n) {
            long lastT = System.currentTimeMillis(), lastGot = got.get(); double fast = 0, slow = 0, before = 0; int wait = 1;
            while (started < n && fail.get() == null && !cancelled.get() && !res.refused) {
                Thread.sleep(1000);
                boolean any = false; for (int i = 0; i < started; i++) if (workers[i].isAlive()) { any = true; break; } if (!any) break;
                long now = System.currentTimeMillis(), g = got.get(); double sp = (g - lastGot) / Math.max(0.001, (now - lastT) / 1000.0); lastT = now; lastGot = g;
                fast = fast == 0 ? sp : fast * 0.5 + sp * 0.5; slow = slow == 0 ? sp : slow * 0.8 + sp * 0.2;
                if (--wait > 0) continue;
                if (before > 0 && fast < before * 1.06) break;   // (the last step brought nothing: the line is full)
                int add = Math.min(n - started, Math.max(2, started)); before = Math.max(fast, slow);
                alive.addAndGet(add); for (int i = started; i < started + add; i++) workers[i].start(); started += add; res.connections = started; wait = 2;
            }
        }
        res.connections = Math.min(res.connections, started);
        for (int i = 0; i < started; i++) workers[i].join();
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

    /** Done chunks whose last bytes are all zero in the file were never really written (the app was stopped before
     *  the disk had them): fetched again. A chunk begun is trusted up to its last non-zero stretch. */
    static void localCheck(State st, File out) {
        try (RandomAccessFile raf = new RandomAccessFile(out, "r")) {
            int chunks = (int) ((st.total + st.chunk - 1) / st.chunk); byte[] b = new byte[4096];
            for (int i = st.done.nextSetBit(0); i >= 0 && i < chunks; i = st.done.nextSetBit(i + 1)) { long end = Math.min(st.total, (long) (i + 1) * st.chunk); if (zero(raf, end - Math.min(b.length, end - (long) i * st.chunk), b)) st.unmark(i); }
            for (java.util.Map.Entry<Integer, Long> e : new java.util.ArrayList<>(st.partial.entrySet())) { long p = e.getValue(); long at = (long) e.getKey() * st.chunk + p; if (p < b.length || zero(raf, at - b.length, b)) st.setPartial(e.getKey(), 0); }
        } catch (IOException ignored) {}
    }
    private static boolean zero(RandomAccessFile raf, long at, byte[] b) throws IOException { raf.seek(Math.max(0, at)); int r = raf.read(b); if (r <= 0) return true; for (int k = 0; k < r; k++) if (b[k] != 0) return false; return true; }
    /** A few done chunks' last 16 KB compared with the server's (the first, the last and some between): whether the
     *  file here is the same as the one there. No done chunk: nothing to lose, so yes. */
    /** A MEGA file's key, or null. */
    private static byte[] mega(Opts opt) { return opt != null && opt.megaKey != null && opt.megaKey.length == 32 ? opt.megaKey : null; }
    static boolean matches(URL url, Opener opener, File out, State st, int threads, int samples) { return matches(url, opener, out, st, threads, samples, null); }
    /** `megaKey`: the file here is the server's decrypted (MEGA), so the server's bytes are decrypted before they are
     *  compared — compared as they came, they never matched and a MEGA download whose server gave no ETag began again. */
    static boolean matches(URL url, Opener opener, File out, State st, int threads, int samples, byte[] megaKey) {
        java.util.List<Integer> done = new java.util.ArrayList<>(); for (int i = st.done.nextSetBit(0); i >= 0; i = st.done.nextSetBit(i + 1)) done.add(i);
        if (done.isEmpty()) return true;
        java.util.List<Integer> pick = new java.util.ArrayList<>(); for (int k = 0; k < samples && k < done.size(); k++) pick.add(done.get((int) ((long) k * (done.size() - 1) / Math.max(1, samples - 1))));
        java.util.List<Integer> ok = check(url, opener, out, st, new java.util.ArrayList<>(new java.util.LinkedHashSet<>(pick)), threads, new AtomicBoolean(false), megaKey);
        return ok != null && ok.size() == new java.util.LinkedHashSet<>(pick).size();
    }
    /** The chunks of a file with no record: those with bytes in them, checked against the server's; how many kept. */
    static int recover(URL url, Opener opener, File out, State st, int threads, AtomicBoolean cancelled, byte[] megaKey) {
        java.util.List<Integer> cand = new java.util.ArrayList<>(); int chunks = (int) ((st.total + st.chunk - 1) / st.chunk);
        try (RandomAccessFile raf = new RandomAccessFile(out, "r")) { byte[] b = new byte[4096]; long len = raf.length();
            for (int i = 0; i < chunks; i++) { long end = Math.min(st.total, (long) (i + 1) * st.chunk); if (end > len) break; if (!zero(raf, end - Math.min(b.length, end - (long) i * st.chunk), b)) cand.add(i); } } catch (IOException e) { return 0; }
        java.util.List<Integer> ok = check(url, opener, out, st, cand, threads, cancelled, megaKey); if (ok == null) return 0;
        for (int i : ok) st.mark(i); return ok.size();
    }
    /** The chunks among `which` whose last 16 KB here are the server's (null: the server could not be asked). */
    private static java.util.List<Integer> check(URL url, Opener opener, File out, State st, java.util.List<Integer> which, int threads, AtomicBoolean cancelled, byte[] megaKey) {
        final java.util.List<Integer> ok = java.util.Collections.synchronizedList(new java.util.ArrayList<>()); final java.util.concurrent.atomic.AtomicInteger next = new java.util.concurrent.atomic.AtomicInteger(); final AtomicBoolean broken = new AtomicBoolean();
        Thread[] ts = new Thread[Math.max(1, Math.min(threads, which.size()))];
        for (int t = 0; t < ts.length; t++) { ts[t] = new Thread(() -> {
            try (RandomAccessFile raf = new RandomAccessFile(out, "r")) {
                for (int k; !cancelled.get() && !broken.get() && (k = next.getAndIncrement()) < which.size(); ) {
                    int i = which.get(k); long start = (long) i * st.chunk, end = Math.min(st.total, (long) (i + 1) * st.chunk); int len = (int) Math.min(16384, end - start);
                    // (Its first and its last 16 KB, both: a change at either end is seen.)
                    boolean same = true;
                    for (long from : new long[] { start, end - len }) {
                        byte[] mine = new byte[len]; raf.seek(from); raf.readFully(mine);
                        HttpURLConnection c = null;
                        try { c = follow(url, opener, "bytes=" + from + "-" + (from + len - 1)); if (c.getResponseCode() != 206) { broken.set(true); same = false; break; }
                            byte[] theirs = new byte[len]; int got = 0; try (InputStream in = c.getInputStream()) { int r; while (got < len && (r = in.read(theirs, got, len - got)) > 0) got += r; }
                            if (got == len && megaKey != null) theirs = CtrFile.plain(megaKey, from, theirs);
                            if (got != len || !java.util.Arrays.equals(mine, theirs)) { same = false; break; }
                        } catch (IOException e) { broken.set(true); same = false; break; } finally { if (c != null) c.disconnect(); }
                        if (len == end - start) break;
                    }
                    if (broken.get()) break; if (same) ok.add(i);
                }
            } catch (IOException ignored) {}
        }); ts[t].start(); }
        for (Thread t : ts) try { t.join(); } catch (InterruptedException e) { return null; }
        return broken.get() && ok.isEmpty() ? null : ok;
    }

    /** Copies a part's bytes until its end — which may be brought nearer while it runs (its second half taken by
     *  another connection): only what is still this part's is written and counted. */
    private static void copySeg(InputStream in, RandomAccessFile raf, Seg seg, long base, AtomicBoolean cancelled, AtomicLong got, Runnable tick, long[] wrote) throws IOException { copySeg(in, raf, seg, base, cancelled, got, tick, wrote, null); }
    private static void copySeg(InputStream in, RandomAccessFile raf, Seg seg, long base, AtomicBoolean cancelled, AtomicLong got, Runnable tick, long[] wrote, Limiter own) throws IOException {
        byte[] buf = new byte[1 << 17]; int r;
        while (!cancelled.get()) {
            long left; synchronized (seg) { left = seg.stopAt - (base + wrote[0]); } if (left <= 0) break;
            boolean limited = GLOBAL.rate() > 0 || (own != null && own.rate() > 0);   // (each read: a limit set while it runs is felt at once)
            int want = (int) Math.min(limited ? 1 << 14 : buf.length, left);
            try { if (own != null) own.take(want); GLOBAL.take(want); } catch (InterruptedException ie) { throw new IOException("cancelled"); }
            r = in.read(buf, 0, want); if (r <= 0) break;
            synchronized (seg) { long allow = seg.stopAt - (base + wrote[0]); int n = (int) Math.min(r, Math.max(0, allow)); if (n > 0) { raf.seek(base + wrote[0]); raf.write(buf, 0, n); wrote[0] += n; got.addAndGet(n); seg.pos = base + wrote[0]; } if (n < r) break; }
            tick.run();
        }
    }
    /** Copies up to `max` bytes, counting them in `wrote[0]` as they are written. */
    private static void copy(InputStream in, RandomAccessFile raf, long max, AtomicBoolean cancelled, AtomicLong got, Runnable tick, long[] wrote) throws IOException { copy(in, raf, max, cancelled, got, tick, wrote, null); }
    private static void copy(InputStream in, RandomAccessFile raf, long max, AtomicBoolean cancelled, AtomicLong got, Runnable tick, long[] wrote, Limiter own) throws IOException {
        byte[] buf = new byte[1 << 17]; int r;
        while (wrote[0] < max && !cancelled.get()) {
            boolean limited = GLOBAL.rate() > 0 || (own != null && own.rate() > 0);
            int want = (int) Math.min(limited ? 1 << 14 : buf.length, max - wrote[0]);
            try { if (own != null) own.take(want); GLOBAL.take(want); } catch (InterruptedException ie) { throw new IOException("cancelled"); }
            if ((r = in.read(buf, 0, want)) <= 0) break;
            raf.write(buf, 0, r); wrote[0] += r; got.addAndGet(r); tick.run();
        }
    }

    /** A finished answer read to its end, so its connection goes back to the pool for the next request. */
    private static void drain(HttpURLConnection c) {
        try (InputStream in = c.getInputStream()) { byte[] b = new byte[256]; while (in.read(b) > 0) { /* the one byte */ } } catch (Exception ignored) {}
    }
}
