package app.kurokawa.tools;

import app.kurokawa.tools.KtCore;   // (the same package; named so tests/native/screen.sh compiles this file outside it)

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Stage M4: the screen translator's jobs asked of the Rust core (kt-core screentrack / screenmotion / inpaint, through
 * kt-android's bytes.scrTrack, bytes.moShift, bytes.inpaint). Java's own code stays the reference and the fallback:
 *  - Settings → Advanced → «Screen translator engine» (phones with the core only; default Classic) sets {@link #rust};
 *    then the jobs that proved identical AND faster on the host benchmark (jvmtest/ScreenBench, ANDROID-PORT.md M4) go
 *    to Rust, each call falling back to Java on any error (counted in {@link #FALLBACKS}).
 *  - On a debuggable build with the core, every call of every job is also asked of Rust beside Java (shadow mode):
 *    the differences counted through KtCore's shadow report, Java's answer used.
 * One copy across JNI each way per call: the text as UTF-16 units, the pixels as little-endian words, no JSON for them.
 */
final class KtScreenRs {
    private KtScreenRs() {}

    /** The reader's choice (KtEngine.configure «screenEngine», read at the service's start): Rust when true. */
    static volatile boolean rust;
    /** Rust errors that sent a call back to Java while the Rust engine was chosen. */
    static final AtomicLong FALLBACKS = new AtomicLong(), CALLS = new AtomicLong();

    /** Which jobs the Rust engine takes (the host benchmark's verdict, ANDROID-PORT.md M4: identical and faster with the
     *  JNI copies counted). A job set false here stays on Java even with Rust chosen; the shadow still checks it. */
    static final boolean TRACK_ON_RUST = true, SHIFT_ON_RUST = true, INPAINT_ON_RUST = true;

    /**
     * The one tolerance for pixels (KtInpaint): the largest difference allowed in any colour channel between Java's
     * cleaned patch and Rust's, alpha exactly equal. Both compute the same IEEE-754 doubles in the same order with no
     * fused multiply-add (Java forbids it, Rust/LLVM does not contract without being told to) and correctly rounded
     * sqrt, so 0 is what the host tests measure; 1 level leaves room for a CPU or runtime that rounds one intermediate
     * differently, which could move a guess by one level at most before the box blur — invisible, and still far under
     * the 46 levels that tell ink from background. Anything above it is a real difference: counted.
     */
    static final int PIXEL_TOL = 1;

    static boolean use(boolean job) { return job && rust && KtCore.available(); }
    static boolean shadowing() { return KtCore.shadowing(); }

    private static void failed(String job, Throwable e) {
        FALLBACKS.incrementAndGet();
        java.util.function.Consumer<String> l = KtCore.log; if (l != null) try { l.accept("Rust screen engine: " + job + " back to Java (" + e.getMessage() + ")"); } catch (Throwable ignored) {}
    }

    /* ---------- a little-endian writer ---------- */
    static final class Buf {
        private byte[] b = new byte[256]; private int n;
        private void room(int k) { if (n + k > b.length) b = java.util.Arrays.copyOf(b, Math.max(b.length * 2, n + k)); }
        Buf i32(int v) { room(4); b[n++] = (byte) v; b[n++] = (byte) (v >> 8); b[n++] = (byte) (v >> 16); b[n++] = (byte) (v >> 24); return this; }
        Buf str(String s) { int l = s.length(); i32(l); room(2 * l); for (int k = 0; k < l; k++) { char c = s.charAt(k); b[n++] = (byte) c; b[n++] = (byte) (c >> 8); } return this; }
        byte[] done() { return java.util.Arrays.copyOf(b, n); }
    }
    static int[] ints(byte[] b) { if (b.length % 4 != 0) throw new IllegalStateException("answer: not whole numbers"); int[] o = new int[b.length / 4]; ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN).asIntBuffer().get(o); return o; }

    /* ---------- tracking (KtScreenTrack.update) ---------- */

    /** The request kt-core's screentrack::read_request reads; `blind` asked of every piece before the reading. */
    static byte[] trackRequest(List<KtScreenTrack.Item> items, List<KtScreenTrack.Obs> obs, java.util.function.Predicate<KtScreenTrack.Item> blind) {
        Buf b = new Buf().i32(items.size()).i32(obs.size());
        for (KtScreenTrack.Item i : items) {
            b.i32(i.x).i32(i.y).i32(i.w).i32(i.h).i32(i.miss).i32(i.clipped ? 1 : 0).i32(blind != null && blind.test(i) ? 1 : 0).i32(i.tr != null ? 1 : 0);
            b.str(i.text).str(KtTranslate.norm(i.text)); if (i.tr != null) b.str(i.tr);
        }
        for (KtScreenTrack.Obs o : obs) b.i32(o.x).i32(o.y).i32(o.w).i32(o.h).str(o.text).str(KtTranslate.norm(o.text));
        return b.done();
    }
    static String trackArgs(KtScreenTrack t, int[] area) {
        return "{\"vw\":" + t.vw + ",\"vh\":" + t.vh + ",\"keepMisses\":" + t.keepMisses + ",\"keepOff\":" + t.keepOff + ",\"cap\":" + t.cap + ",\"area\":" + (area == null ? "null" : "[" + area[0] + "," + area[1] + "," + area[2] + "," + area[3] + "]") + "}";
    }
    /** Rust's answer applied to `t` (its items and its next id), as Java's update would have left them; checked whole
     *  before anything is changed (a malformed answer throws and changes nothing). */
    static KtScreenTrack.Update apply(KtScreenTrack t, int[] a, List<KtScreenTrack.Obs> obs) {
        int n = obs.size(), m0 = t.items.size(), p = 0;
        int feedback = a[p++], e = a[p++];
        if (e < m0 || a.length < 2 + n + 9 * e + 6) throw new IllegalStateException("answer: short");
        int[] of = new int[n]; for (int k = 0; k < n; k++) { of[k] = a[p++]; if (of[k] < -1 || of[k] >= e) throw new IllegalStateException("answer: bad piece"); }
        int st = p; p += 9 * e;
        int[][] lists = new int[6][];
        for (int l = 0; l < 6; l++) { if (p >= a.length) throw new IllegalStateException("answer: short"); int c = a[p++]; if (c < 0 || p + c > a.length) throw new IllegalStateException("answer: bad list"); lists[l] = java.util.Arrays.copyOfRange(a, p, p + c); p += c; for (int v : lists[l]) if (v < 0 || v >= e) throw new IllegalStateException("answer: bad index"); }
        if (p != a.length) throw new IllegalStateException("answer: trailing");
        for (int m = 0; m < e; m++) { int tf = a[st + 9 * m + 6], df = a[st + 9 * m + 7]; if (tf < -1 || tf >= n || df < -1 || df >= n || (m >= m0 && (tf < 0 || df < 0))) throw new IllegalStateException("answer: bad source"); }
        // (Sound: applied.)
        List<KtScreenTrack.Item> ext = new ArrayList<>(t.items);
        for (int m = 0; m < e; m++) {
            int q = st + 9 * m; KtScreenTrack.Item i;
            if (m >= m0) { KtScreenTrack.Obs o = obs.get(a[q + 6]); i = new KtScreenTrack.Item(t.nextId++, o.text, o.x, o.y, o.w, o.h); ext.add(i); }
            else { i = ext.get(m); if (a[q + 6] >= 0) i.text = obs.get(a[q + 6]).text; }
            if (a[q + 7] >= 0) i.data = obs.get(a[q + 7]).data;
            i.x = a[q]; i.y = a[q + 1]; i.w = a[q + 2]; i.h = a[q + 3]; i.miss = a[q + 4]; i.clipped = a[q + 5] != 0;
        }
        KtScreenTrack.Update u = new KtScreenTrack.Update(); u.feedback = feedback; u.of = new KtScreenTrack.Item[n];
        for (int k = 0; k < n; k++) u.of[k] = of[k] < 0 ? null : ext.get(of[k]);
        List<List<KtScreenTrack.Item>> ul = java.util.Arrays.asList(u.added, u.dropped, u.retext, u.resized, u.glide, u.snap);
        for (int l = 0; l < 6; l++) for (int v : lists[l]) ul.get(l).add(ext.get(v));
        t.items.clear(); for (int m = 0; m < e; m++) if (a[st + 9 * m + 8] == 0) t.items.add(ext.get(m));
        return u;
    }
    /** The Rust engine's update, or null (an error: counted, the caller uses Java's). */
    static KtScreenTrack.Update track(KtScreenTrack t, List<KtScreenTrack.Obs> obs, int[] area, java.util.function.Predicate<KtScreenTrack.Item> blind) {
        try { CALLS.incrementAndGet(); return apply(t, ints(KtCore.callBytes("bytes.scrTrack", trackArgs(t, area), trackRequest(t.items, obs, blind))), obs); }
        catch (Throwable e) { failed("scrTrack", e); return null; }
    }
    /** Before Java's update: what Rust needs to answer the same question afterwards. */
    static final class Pre { final List<KtScreenTrack.Item> items = new ArrayList<>(); int nextId; byte[] req; String args; }
    static Pre before(KtScreenTrack t, List<KtScreenTrack.Obs> obs, int[] area, java.util.function.Predicate<KtScreenTrack.Item> blind) {
        Pre p = new Pre(); for (KtScreenTrack.Item i : t.items) p.items.add(copy(i)); p.nextId = t.nextId; p.req = trackRequest(t.items, obs, blind); p.args = trackArgs(t, area); return p;
    }
    static KtScreenTrack.Item copy(KtScreenTrack.Item i) { KtScreenTrack.Item c = new KtScreenTrack.Item(i.id, i.text, i.x, i.y, i.w, i.h); c.tr = i.tr; c.trOf = i.trOf; c.miss = i.miss; c.clipped = i.clipped; c.view = i.view; c.data = i.data; return c; }
    /** After Java's update: Rust's answer applied to the copies, compared with what Java did. */
    static void shadowTrack(KtScreenTrack t, Pre p, List<KtScreenTrack.Obs> obs, KtScreenTrack.Update javaAnswer) {
        String want = digest(t.items, javaAnswer), got;
        try {
            KtScreenTrack r = new KtScreenTrack(); r.items.addAll(p.items); r.nextId = p.nextId;
            KtScreenTrack.Update u = apply(r, ints(KtCore.callBytes("bytes.scrTrack", p.args, p.req)), obs); got = digest(r.items, u);
        } catch (Throwable e) { got = "error: " + e.getMessage(); }
        KtCore.shadowNote("bytes.scrTrack", want.equals(got), "java=" + cut(want) + " rust=" + cut(got));
    }
    /** What an update left, as one line: the pieces (id, words, box, misses, clipped, its data's identity) and the lists. */
    static String digest(List<KtScreenTrack.Item> items, KtScreenTrack.Update u) {
        StringBuilder b = new StringBuilder("fb=").append(u.feedback).append(" of=");
        for (KtScreenTrack.Item i : u.of) b.append(i == null ? "-" : String.valueOf(i.id)).append(',');
        for (KtScreenTrack.Item i : items) b.append(" #").append(i.id).append('«').append(i.text).append('»').append(i.x).append(',').append(i.y).append(',').append(i.w).append(',').append(i.h).append(" m").append(i.miss).append(i.clipped ? " c" : "").append(" d").append(System.identityHashCode(i.data));
        List<List<KtScreenTrack.Item>> ls = java.util.Arrays.asList(u.added, u.dropped, u.retext, u.resized, u.glide, u.snap);
        for (List<KtScreenTrack.Item> l : ls) { b.append(" |"); for (KtScreenTrack.Item i : l) b.append(i.id).append(','); }
        return b.toString();
    }
    private static String cut(String s) { return s.length() > 300 ? s.substring(0, 300) + "…" : s; }

    /* ---------- the scroll finder (KtScreenMotion.shift) ---------- */

    static byte[] sigPair(short[][] a, short[][] b) {
        int rows = a.length; ByteBuffer o = ByteBuffer.allocate(4 * rows * KtScreenMotion.COLS).order(ByteOrder.LITTLE_ENDIAN);
        for (short[] r : a) for (short v : r) o.putShort(v);
        for (short[] r : b) for (short v : r) o.putShort(v);
        return o.array();
    }
    /** Whether Rust can be asked at all (Java's own guards first: Java answers these itself). */
    static boolean shiftable(short[][] a, short[][] b) {
        if (a == null || b == null || a.length != b.length || a.length < 8) return false;
        for (short[] r : a) if (r == null || r.length != KtScreenMotion.COLS) return false;
        for (short[] r : b) if (r == null || r.length != KtScreenMotion.COLS) return false;
        return true;
    }
    static int shiftRaw(short[][] a, short[][] b, int maxPx) throws KtCore.Failure {
        int[] r = ints(KtCore.callBytes("bytes.moShift", "{\"rows\":" + a.length + ",\"maxPx\":" + maxPx + "}", sigPair(a, b)));
        if (r.length != 1) throw new KtCore.Failure("answer: not one number"); return r[0];
    }
    /** The Rust engine's shift, or null (not askable, or an error: counted). */
    static Integer shift(short[][] a, short[][] b, int maxPx) {
        if (!shiftable(a, b)) return null;
        try { CALLS.incrementAndGet(); return shiftRaw(a, b, maxPx); } catch (Throwable e) { failed("moShift", e); return null; }
    }
    static void shadowShift(short[][] a, short[][] b, int maxPx, int javaAnswer) {
        if (!shiftable(a, b)) return;
        String got; try { got = String.valueOf(shiftRaw(a, b, maxPx)); } catch (Throwable e) { got = "error: " + e.getMessage(); }
        KtCore.shadowNote("bytes.moShift", got.equals(String.valueOf(javaAnswer)), "rows=" + a.length + " java=" + javaAnswer + " rust=" + got);
    }

    /* ---------- the words taken off (KtInpaint.clean) ---------- */

    static int[] inpaintRaw(int[] px, int w, int h, boolean cache) throws KtCore.Failure {
        ByteBuffer in = ByteBuffer.allocate(px.length * 4).order(ByteOrder.LITTLE_ENDIAN); in.asIntBuffer().put(px);
        int[] out = ints(KtCore.callBytes("bytes.inpaint", "{\"w\":" + w + ",\"h\":" + h + ",\"cache\":" + cache + "}", in.array()));
        if (out.length != px.length) throw new KtCore.Failure("answer: " + out.length + " pixels for " + px.length); return out;
    }
    /** The Rust engine's clean (through the patch cache: the same bytes cleaned before answer at once), or null. */
    static int[] inpaint(int[] px, int w, int h) {
        try { CALLS.incrementAndGet(); return inpaintRaw(px, w, h, true); } catch (Throwable e) { failed("inpaint", e); return null; }
    }
    /** The largest channel difference between two pictures (alpha must match: else Integer.MAX_VALUE). */
    static int worst(int[] a, int[] b) {
        if (a.length != b.length) return Integer.MAX_VALUE; int m = 0;
        for (int i = 0; i < a.length; i++) { int p = a[i], q = b[i]; if (p == q) continue; if ((p >>> 24) != (q >>> 24)) return Integer.MAX_VALUE; for (int s = 0; s < 24; s += 8) m = Math.max(m, Math.abs(((p >> s) & 255) - ((q >> s) & 255))); }
        return m;
    }
    static boolean samePixels(int[] a, int[] b) { return worst(a, b) <= PIXEL_TOL; }
    static void shadowInpaint(int[] px, int w, int h, int[] javaAnswer) {
        String why; boolean ok;
        try { int[] r = inpaintRaw(px, w, h, false); int d = worst(javaAnswer, r); ok = d <= PIXEL_TOL; why = "w=" + w + " h=" + h + " worst=" + d; }
        catch (Throwable e) { ok = false; why = "error: " + e.getMessage(); }
        KtCore.shadowNote("bytes.inpaint", ok, why);
    }

    /* ---------- the rules kept on Java by design, shadow-checked (translating ahead, lettering's kinds / markers) ---------- */

    static void shadowAhead(List<KtScreenTrack.Cand> all, int vh, int dir, int max, int maxChars, double screens, java.util.function.Predicate<String> known, List<String> javaAnswer) {
        try {
            List<Object> cs = new ArrayList<>();
            for (KtScreenTrack.Cand c : all) { String t = c.text == null ? "" : c.text.trim(); cs.add(java.util.Arrays.asList(c.text == null ? "" : c.text, (long) c.order, c.on, (long) c.top, (long) c.bottom, KtTranslate.norm(t), known != null && !t.isEmpty() && known.test(t))); }
            Object r = KtCore.r("scr.ahead", "cands", cs, "vh", (long) vh, "dir", (long) dir, "max", (long) max, "maxChars", (long) maxChars, "screensMilli", Math.round(screens * 1000));
            List<String> got = new ArrayList<>(); if (r instanceof List) for (Object k : (List<?>) r) { KtScreenTrack.Cand c = all.get(((Number) k).intValue()); got.add(c.text == null ? "" : c.text.trim()); }
            KtCore.shadowNote("scr.ahead", got.equals(javaAnswer), "java=" + javaAnswer + " rust=" + got);
        } catch (Throwable e) { KtCore.shadowNote("scr.ahead", false, "error: " + e.getMessage()); }
    }
}
