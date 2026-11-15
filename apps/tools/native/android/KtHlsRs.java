package app.kurokawa.tools;

import app.kurokawa.tools.KtCore;   // (the same package; named so tests/native/hls.sh compiles this file outside it)

import java.io.IOException;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Stage M4: KtHls's playlists read by the Rust core (kt-core hls: the variants, the choice, the media playlist's
 * pieces, every address resolved as java.net.URL does) when the download engine is Rust (Settings → Advanced, M2's
 * «Download engine» — HLS is a file download, so it follows that choice rather than a switch of its own). Any Rust
 * error: Java reads the playlist instead (counted in {@link #FALLBACKS}); Java's exceptions (a DRM key, a bad number)
 * then come from Java as before. On a debuggable build with the core, Java's reading is checked against Rust's.
 * The text crosses once as UTF-16 units (Java's own string, no re-decoding); the answer is binary.
 */
final class KtHlsRs {
    private KtHlsRs() {}
    static final AtomicLong FALLBACKS = new AtomicLong(), CALLS = new AtomicLong();

    private static byte[] units(String s) { return s.getBytes(StandardCharsets.UTF_16LE); }
    private static String args(URL base) { return KtCore.json(java.util.Collections.singletonMap("base", base.toString())); }

    /** A little-endian reader over Rust's answer. */
    private static final class R {
        final ByteBuffer b; R(byte[] a) { b = ByteBuffer.wrap(a).order(ByteOrder.LITTLE_ENDIAN); }
        int i32() { return b.getInt(); } long i64() { return b.getLong(); }
        String str() { int n = b.getInt(); if (n < 0) return null; if (n > b.remaining() / 2) throw new IllegalStateException("answer: bad string"); byte[] x = new byte[2 * n]; b.get(x); return new String(x, StandardCharsets.UTF_16LE); }
        void end() { if (b.hasRemaining()) throw new IllegalStateException("answer: trailing bytes"); }
    }
    static List<KtHls.Variant> variantsRust(String text, URL base) throws KtCore.Failure {
        R r = new R(KtCore.callBytes("bytes.hlsVariants", args(base), units(text)));
        int n = r.i32(); List<KtHls.Variant> vs = new ArrayList<>();
        for (int k = 0; k < n; k++) { String u = r.str(), c = r.str(); int h = r.i32(), bw = r.i32(); vs.add(new KtHls.Variant(u, h, bw, c)); }
        r.end(); return vs;
    }
    static KtHls.Playlist mediaRust(String text, URL base) throws KtCore.Failure {
        R r = new R(KtCore.callBytes("bytes.hlsMedia", args(base), units(text)));
        KtHls.Playlist pl = new KtHls.Playlist();
        pl.live = r.i32() != 0; pl.seconds = Double.longBitsToDouble(r.i64()); pl.map = r.str();
        boolean hasRange = r.i32() != 0; long mo = r.i64(), ml = r.i64(); pl.mapRange = hasRange ? new long[] { mo, ml } : null;
        int n = r.i32();
        for (int k = 0; k < n; k++) {
            String u = r.str(), key = r.str(); boolean hasIv = r.i32() != 0; byte[] iv = new byte[16]; r.b.get(iv); long seq = r.i64(); boolean hasBr = r.i32() != 0; long off = r.i64(), len = r.i64();
            pl.pieces.add(new KtHls.Piece(u, key, hasIv ? iv : null, seq, hasBr ? new long[] { off, len } : null));
        }
        r.end(); return pl;
    }
    static int chooseRust(List<KtHls.Variant> vs, int want) throws KtCore.Failure {
        List<Object> l = new ArrayList<>(); for (KtHls.Variant v : vs) l.add(java.util.Arrays.asList((long) v.height, (long) v.bandwidth));
        Object r = KtCore.r("hls.choose", "vs", l, "want", (long) want);
        if (!(r instanceof Long)) throw new KtCore.Failure("answer: no choice"); return ((Long) r).intValue();
    }

    /* ---------- what KtHls.run asks (Rust when `rust`, else Java and the shadow) ---------- */

    static List<KtHls.Variant> variants(String text, URL base, boolean rust) throws IOException {
        if (rust && KtCore.available()) { try { CALLS.incrementAndGet(); return variantsRust(text, base); } catch (Throwable e) { FALLBACKS.incrementAndGet(); } }
        List<KtHls.Variant> j = KtHls.variants(text, base);
        if (KtCore.shadowing()) { String got; try { got = show(variantsRust(text, base)); } catch (Throwable e) { got = "error: " + e.getMessage(); } KtCore.shadowNote("bytes.hlsVariants", got.equals(show(j)), "java=" + cut(show(j)) + " rust=" + cut(got)); }
        return j;
    }
    static KtHls.Variant choose(List<KtHls.Variant> vs, int want, boolean rust) {
        if (rust && KtCore.available() && !vs.isEmpty()) { try { CALLS.incrementAndGet(); return vs.get(chooseRust(vs, want)); } catch (Throwable e) { FALLBACKS.incrementAndGet(); } }
        KtHls.Variant j = KtHls.choose(vs, want);
        if (KtCore.shadowing() && !vs.isEmpty()) { String got; try { got = String.valueOf(chooseRust(vs, want)); } catch (Throwable e) { got = "error: " + e.getMessage(); } KtCore.shadowNote("hls.choose", got.equals(String.valueOf(vs.indexOf(j))), "java=" + vs.indexOf(j) + " rust=" + got); }
        return j;
    }
    static KtHls.Playlist media(String text, URL base, boolean rust) throws IOException {
        if (rust && KtCore.available()) { try { CALLS.incrementAndGet(); return mediaRust(text, base); } catch (Throwable e) { FALLBACKS.incrementAndGet(); } }
        KtHls.Playlist j = KtHls.media(text, base);
        if (KtCore.shadowing()) { String got; try { got = show(mediaRust(text, base)); } catch (Throwable e) { got = "error: " + e.getMessage(); } String want = show(j); KtCore.shadowNote("bytes.hlsMedia", got.equals(want), "java=" + cut(want) + " rust=" + cut(got)); }
        return j;
    }

    /** One line for a reading (the shadow compares these). */
    static String show(List<KtHls.Variant> vs) { StringBuilder b = new StringBuilder(); for (KtHls.Variant v : vs) b.append(v.url).append(' ').append(v.height).append(' ').append(v.bandwidth).append(' ').append(v.codecs).append('\n'); return b.toString(); }
    static String show(KtHls.Playlist p) {
        StringBuilder b = new StringBuilder().append(p.live).append(' ').append(Double.doubleToLongBits(p.seconds)).append(' ').append(p.map).append(' ').append(java.util.Arrays.toString(p.mapRange)).append('\n');
        for (KtHls.Piece x : p.pieces) b.append(x.url).append(' ').append(x.keyUrl).append(' ').append(java.util.Arrays.toString(x.iv)).append(' ').append(x.seq).append(' ').append(java.util.Arrays.toString(x.byteRange)).append('\n');
        return b.toString();
    }
    private static String cut(String s) { return s.length() > 300 ? s.substring(0, 300) + "…" : s; }
}
