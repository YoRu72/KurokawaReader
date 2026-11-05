package app.kurokawa.tools;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** HLS without yt-dlp: the master playlist read and a variant chosen (the tallest at or under the height wanted,
 *  else the best), its media playlist's pieces fetched several at once in their order, AES‑128 pieces decrypted
 *  with the playlist's keys, pieces disguised as pictures (a JPEG/PNG header glued before the MPEG‑TS bytes, as some
 *  sites do) uncovered, and the whole joined: MPEG‑TS pieces to one «.ts» remuxed to «.mp4» by ffmpeg when its pack
 *  is here, fMP4 pieces (an «EXT-X-MAP» head) to one «.mp4» directly. Progress is pieces i/n plus bytes, resumable
 *  by the pieces already on disk. */
final class KtHls {
    private KtHls() {}
    private static final String TAG = "KtHls";

    interface Progress { void on(int piece, int pieces, long bytes, String phase); }
    static final class Result { File out; int pieces; long bytes; String container; }

    static final class Piece { final String url; final String keyUrl; final byte[] iv; final long seq; final long[] byteRange; Piece(String u, String k, byte[] iv, long seq, long[] br) { url = u; keyUrl = k; this.iv = iv; this.seq = seq; byteRange = br; } }
    static final class Playlist { final List<Piece> pieces = new ArrayList<>(); String map; long[] mapRange; boolean live; double seconds; }
    static final class Variant { final String url; final int height, bandwidth; final String codecs; Variant(String u, int h, int b, String c) { url = u; height = h; bandwidth = b; codecs = c; } }

    /** Is this a playlist? By its path, or by its first bytes once fetched. */
    static boolean looksLike(String url) { String p = url.toLowerCase(Locale.ROOT); int q = p.indexOf('?'); if (q > 0) p = p.substring(0, q); return p.endsWith(".m3u8") || p.endsWith(".m3u"); }

    /** The whole thing: playlist(s) read, pieces fetched to {@code work}, joined into {@code out} (its extension put right). */
    static Result run(android.content.Context ctx, String url, File out, File work, int threads, int wantHeight, KrDownloader.Opener opener, AtomicBoolean cancelled, Progress progress) throws Exception {
        work.mkdirs();
        String text = textOf(url, opener); URL base = new URL(url);
        if (!text.contains("#EXTM3U")) throw new IOException("not a playlist");
        List<Variant> vs = variants(text, base);
        if (!vs.isEmpty()) {
            Variant pick = choose(vs, wantHeight);
            progress.on(0, 0, 0, "variant " + (pick.height > 0 ? pick.height + "p" : pick.bandwidth / 1000 + " kb/s"));
            base = new URL(pick.url); text = textOf(pick.url, opener);
        }
        Playlist pl = media(text, base);
        if (pl.pieces.isEmpty()) throw new IOException("empty playlist");
        if (pl.live) throw new IOException("live");
        final int n = pl.pieces.size(); final AtomicLong bytes = new AtomicLong(); final java.util.concurrent.atomic.AtomicInteger doneN = new java.util.concurrent.atomic.AtomicInteger();
        final java.util.Map<String, byte[]> keys = new java.util.concurrent.ConcurrentHashMap<>();
        // (What came before this run — the same pieces on disk — counts; a piece half written is fetched again.)
        File marks = new File(work, "pieces"); marks.mkdirs();
        for (int i = 0; i < n; i++) { File f = piece(marks, i); if (f.exists() && new File(marks, i + ".ok").exists()) { bytes.addAndGet(f.length()); doneN.incrementAndGet(); } }
        progress.on(doneN.get(), n, bytes.get(), "pieces");
        ExecutorService pool = Executors.newFixedThreadPool(Math.max(1, Math.min(threads, 16)));
        List<Future<?>> fs = new ArrayList<>();
        final boolean fmp4 = pl.map != null;
        try {
            if (pl.map != null) { File m = new File(work, "init.mp4"); if (!m.exists() || m.length() == 0) { fetchTo(pl.map, pl.mapRange, m, opener, cancelled); } }
            for (int i = 0; i < n; i++) {
                final int idx = i; final Piece p = pl.pieces.get(i);
                if (new File(marks, idx + ".ok").exists()) continue;
                fs.add(pool.submit(() -> {
                    if (cancelled.get()) return null;
                    File f = piece(marks, idx); File tmp = new File(marks, idx + ".tmp");
                    IOException last = null;
                    for (int attempt = 0; attempt < 4 && !cancelled.get(); attempt++) {
                        try {
                            fetchTo(p.url, p.byteRange, tmp, opener, cancelled);
                            byte[] data = readAll(tmp);
                            if (p.keyUrl != null) { byte[] key = keys.computeIfAbsent(p.keyUrl, k -> { try { return bytesOf(k, opener); } catch (IOException e) { return null; } }); if (key == null) throw new IOException("key"); data = decrypt(data, key, p.iv != null ? p.iv : ivOf(p.seq)); }
                            if (!fmp4) data = uncover(data);
                            try (FileOutputStream o = new FileOutputStream(f)) { o.write(data); }
                            tmp.delete(); new File(marks, idx + ".ok").createNewFile();
                            bytes.addAndGet(data.length); progress.on(doneN.incrementAndGet(), n, bytes.get(), "pieces"); return null;
                        } catch (IOException e) { last = e; try { Thread.sleep(600L * (attempt + 1)); } catch (InterruptedException ie) { return null; } }
                    }
                    if (last != null && !cancelled.get()) throw last; return null;
                }));
            }
            for (Future<?> f : fs) { try { f.get(); } catch (java.util.concurrent.ExecutionException e) { Throwable c = e.getCause(); if (c instanceof Exception) throw (Exception) c; throw new IOException(String.valueOf(c)); } }
        } finally { pool.shutdownNow(); }
        if (cancelled.get()) { Result r = new Result(); r.pieces = doneN.get(); r.bytes = bytes.get(); return r; }
        // (All here: joined. fMP4 straight into «.mp4»; TS joined, then remuxed by ffmpeg to «.mp4» when it is here.)
        progress.on(n, n, bytes.get(), "join");
        File joined = new File(work, fmp4 ? "joined.mp4" : "joined.ts");
        try (OutputStream o = new java.io.BufferedOutputStream(new FileOutputStream(joined), 1 << 16)) {
            if (fmp4) copy(new File(work, "init.mp4"), o);
            for (int i = 0; i < n; i++) copy(piece(marks, i), o);
        }
        Result r = new Result(); r.pieces = n; r.bytes = joined.length();
        File target = withExt(out, fmp4 ? "mp4" : "ts"); r.container = fmp4 ? "mp4" : "ts";
        if (!fmp4 && KtPacks.installed(ctx, "ffmpeg") != null) {
            progress.on(n, n, bytes.get(), "remux");
            File mp4 = withExt(out, "mp4");
            try {
                List<String> args = new ArrayList<>(java.util.Arrays.asList("-y", "-hide_banner", "-loglevel", "error", "-i", joined.getAbsolutePath(), "-c", "copy", "-movflags", "+faststart", "-bsf:a", "aac_adtstoasc", mp4.getAbsolutePath()));
                Process p = KtPacks.command(ctx, KtPacks.ffmpegBin(ctx), args).redirectErrorStream(true).start();
                String log = new String(readAll(p.getInputStream()), StandardCharsets.UTF_8); int code = p.waitFor();
                if (code == 0 && mp4.length() > 0) { joined.delete(); target = mp4; r.container = "mp4"; r.bytes = mp4.length(); }
                else { android.util.Log.w(TAG, "remux failed (" + code + "): " + log); mp4.delete(); }
            } catch (Throwable e) { android.util.Log.w(TAG, "remux: " + e); mp4.delete(); }
        }
        if (target != joined) { if (target.exists()) target.delete(); if (!joined.renameTo(target)) { try (OutputStream o = new FileOutputStream(target)) { copy(joined, o); } joined.delete(); } }
        r.out = target; deleteTree(marks); new File(work, "init.mp4").delete();
        return r;
    }

    /* ---------- playlists ---------- */
    static List<Variant> variants(String text, URL base) throws IOException {
        List<Variant> vs = new ArrayList<>(); String[] lines = text.split("\r?\n"); String pending = null;
        for (String raw : lines) {
            String l = raw.trim(); if (l.isEmpty()) continue;
            if (l.startsWith("#EXT-X-STREAM-INF:")) { pending = l.substring(18); continue; }
            if (l.startsWith("#")) continue;
            if (pending != null) { vs.add(new Variant(new URL(base, l).toString(), heightOf(attr(pending, "RESOLUTION")), (int) numOf(attr(pending, "BANDWIDTH")), attr(pending, "CODECS"))); pending = null; }
        }
        return vs;
    }
    static Variant choose(List<Variant> vs, int wantHeight) {
        Variant best = null;
        for (Variant v : vs) { if (wantHeight > 0 && v.height > 0 && v.height > wantHeight) continue; if (best == null || v.height > best.height || (v.height == best.height && v.bandwidth > best.bandwidth)) best = v; }
        if (best == null) for (Variant v : vs) if (best == null || v.height < best.height || (v.height == best.height && v.bandwidth > best.bandwidth)) best = v;
        return best;
    }
    static Playlist media(String text, URL base) throws IOException {
        Playlist pl = new Playlist(); String keyUrl = null; byte[] iv = null; long seq = 0; long[] range = null; long[] lastRange = null; boolean ended = false; double dur = 0;
        for (String raw : text.split("\r?\n")) {
            String l = raw.trim(); if (l.isEmpty()) continue;
            if (l.startsWith("#EXT-X-MEDIA-SEQUENCE:")) { seq = numOf(l.substring(22)); continue; }
            if (l.startsWith("#EXT-X-ENDLIST")) { ended = true; continue; }
            if (l.startsWith("#EXT-X-KEY:")) { String a = l.substring(11); String m = attr(a, "METHOD"); if (m == null || "NONE".equals(m)) { keyUrl = null; iv = null; } else if ("AES-128".equals(m)) { keyUrl = new URL(base, attr(a, "URI")).toString(); String ivs = attr(a, "IV"); iv = ivs == null ? null : hex(ivs); } else throw new IOException("drm:" + m); continue; }
            if (l.startsWith("#EXT-X-MAP:")) { String a = l.substring(11); pl.map = new URL(base, attr(a, "URI")).toString(); String br = attr(a, "BYTERANGE"); pl.mapRange = br == null ? null : rangeOf(br, null); continue; }
            if (l.startsWith("#EXT-X-BYTERANGE:")) { range = rangeOf(l.substring(17), lastRange); continue; }
            if (l.startsWith("#EXTINF:")) { try { dur = Double.parseDouble(l.substring(8).split(",")[0].trim()); } catch (Exception ignored) {} continue; }
            if (l.startsWith("#")) continue;
            pl.pieces.add(new Piece(new URL(base, l).toString(), keyUrl, iv, seq, range)); pl.seconds += dur; dur = 0; seq++; if (range != null) lastRange = range; range = null;
        }
        pl.live = !ended && pl.pieces.size() < 3; // (a playlist still growing and short: a live stream, which this does not record)
        return pl;
    }
    private static long[] rangeOf(String s, long[] prev) { String[] p = s.split("@"); long len = Long.parseLong(p[0].trim()); long off = p.length > 1 ? Long.parseLong(p[1].trim()) : (prev == null ? 0 : prev[0] + prev[1]); return new long[] { off, len }; }
    static String attr(String attrs, String name) {
        int i = 0; while (i < attrs.length()) {
            int eq = attrs.indexOf('=', i); if (eq < 0) return null; String k = attrs.substring(i, eq).trim(); int j = eq + 1; String v;
            if (j < attrs.length() && attrs.charAt(j) == '"') { int e = attrs.indexOf('"', j + 1); if (e < 0) e = attrs.length(); v = attrs.substring(j + 1, e); i = e + 1; } else { int e = attrs.indexOf(',', j); if (e < 0) e = attrs.length(); v = attrs.substring(j, e).trim(); i = e; }
            if (i < attrs.length() && attrs.charAt(i) == ',') i++;
            if (k.equalsIgnoreCase(name)) return v;
        }
        return null;
    }
    private static int heightOf(String res) { if (res == null) return 0; int x = res.toLowerCase(Locale.ROOT).indexOf('x'); try { return x < 0 ? 0 : Integer.parseInt(res.substring(x + 1).trim()); } catch (Exception e) { return 0; } }
    private static long numOf(String s) { if (s == null) return 0; try { return Long.parseLong(s.trim()); } catch (Exception e) { return 0; } }
    static byte[] hex(String s) { if (s.startsWith("0x") || s.startsWith("0X")) s = s.substring(2); if (s.length() % 2 == 1) s = "0" + s; byte[] b = new byte[16]; byte[] raw = new byte[s.length() / 2]; for (int i = 0; i < raw.length; i++) raw[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16); System.arraycopy(raw, Math.max(0, raw.length - 16), b, Math.max(0, 16 - raw.length), Math.min(16, raw.length)); return b; }
    static byte[] ivOf(long seq) { byte[] iv = new byte[16]; for (int i = 0; i < 8; i++) iv[15 - i] = (byte) (seq >>> (8 * i)); return iv; }

    /* ---------- pieces ---------- */
    static byte[] decrypt(byte[] data, byte[] key, byte[] iv) throws IOException {
        try { Cipher c = Cipher.getInstance("AES/CBC/PKCS5Padding"); c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(iv)); return c.doFinal(data); }
        catch (Exception e) { try { Cipher c = Cipher.getInstance("AES/CBC/NoPadding"); c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(iv)); return c.doFinal(data, 0, data.length - data.length % 16); } catch (Exception e2) { throw new IOException("decrypt: " + e.getMessage()); } }
    }
    /** A TS piece with something glued before it (a picture's header, a few bytes of noise): the bytes from the first
     *  true sync point on — a 0x47 followed by another 0x47 188 bytes later, twice. */
    static byte[] uncover(byte[] d) {
        if (d.length >= 376 && d[0] == 0x47 && d[188] == 0x47) return d;
        for (int i = 0; i + 376 < d.length && i < 1 << 20; i++) if (d[i] == 0x47 && d[i + 188] == 0x47 && (i + 376 >= d.length || d[i + 376] == 0x47)) { byte[] o = new byte[d.length - i]; System.arraycopy(d, i, o, 0, o.length); return o; }
        return d;
    }
    private static File piece(File marks, int i) { return new File(marks, String.format(Locale.US, "%06d.bin", i)); }
    private static void fetchTo(String url, long[] range, File to, KrDownloader.Opener opener, AtomicBoolean cancelled) throws IOException {
        HttpURLConnection c = opener.open(new URL(url));
        if (range != null) c.setRequestProperty("Range", "bytes=" + range[0] + "-" + (range[0] + range[1] - 1));
        c.setConnectTimeout(20000); c.setReadTimeout(30000);
        int code = c.getResponseCode(); if (code >= 400) { c.disconnect(); throw new KrDownloader.Status(code); }
        try (InputStream in = c.getInputStream(); OutputStream o = new java.io.BufferedOutputStream(new FileOutputStream(to), 1 << 16)) { byte[] b = new byte[1 << 15]; int n; while ((n = in.read(b)) > 0) { if (cancelled.get()) throw new IOException("cancelled"); o.write(b, 0, n); } }
        finally { c.disconnect(); }
    }
    private static String textOf(String url, KrDownloader.Opener opener) throws IOException { return new String(bytesOf(url, opener), StandardCharsets.UTF_8); }
    private static byte[] bytesOf(String url, KrDownloader.Opener opener) throws IOException {
        HttpURLConnection c = opener.open(new URL(url)); c.setConnectTimeout(20000); c.setReadTimeout(30000);
        int code = c.getResponseCode(); if (code >= 400) { c.disconnect(); throw new KrDownloader.Status(code); }
        try (InputStream in = c.getInputStream()) { return readAll(in); } finally { c.disconnect(); }
    }
    private static byte[] readAll(InputStream in) throws IOException { ByteArrayOutputStream b = new ByteArrayOutputStream(); byte[] buf = new byte[1 << 15]; int n; while ((n = in.read(buf)) > 0) b.write(buf, 0, n); return b.toByteArray(); }
    private static byte[] readAll(File f) throws IOException { try (RandomAccessFile r = new RandomAccessFile(f, "r")) { byte[] b = new byte[(int) r.length()]; r.readFully(b); return b; } }
    private static void copy(File f, OutputStream o) throws IOException { try (InputStream in = new java.io.FileInputStream(f)) { byte[] b = new byte[1 << 16]; int n; while ((n = in.read(b)) > 0) o.write(b, 0, n); } }
    private static File withExt(File f, String ext) { String n = f.getName(); int d = n.lastIndexOf('.'); String stem = d > 0 && n.length() - d <= 5 ? n.substring(0, d) : n; return new File(f.getParentFile(), stem + "." + ext); }
    static void deleteTree(File f) { if (f.isDirectory()) { File[] k = f.listFiles(); if (k != null) for (File x : k) deleteTree(x); } f.delete(); }
}
