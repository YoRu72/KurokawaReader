package app.kurokawa.tools;

/**
 * How far the screen scrolled between two frames, from the pictures alone (no accessibility needed): each frame is
 * boiled down to a «signature» — the brightness of a few columns on every few rows — and the newer one slid over
 * the older until they agree. Pixels under the translator's own boxes are left out, so its translations, which move
 * with the page, do not mislead it. Plain Java, tested off Android (tests/native/screen.sh).
 */
final class KtScreenMotion {
    /** Rows of a signature: one every `STEP` pixels; columns: `COLS` across the screen. -1: left out. */
    static final int STEP = 4, COLS = 24;
    static final int NONE = Integer.MIN_VALUE;

    /** A signature from ARGB pixels read by `px(x, y)`, `masks` (left, top, right, bottom; screen pixels) left out. */
    interface Pixels { int at(int x, int y); }
    static short[][] signature(Pixels px, int width, int height, int[][] masks) {
        int rows = height / STEP; short[][] sig = new short[rows][COLS];
        for (int r = 0; r < rows; r++) {
            int y = r * STEP;
            for (int c = 0; c < COLS; c++) {
                int x = (int) ((c + 0.5) * width / COLS);
                boolean masked = false; if (masks != null) for (int[] m : masks) if (x >= m[0] && x < m[2] && y >= m[1] && y < m[3]) { masked = true; break; }
                if (masked) { sig[r][c] = -1; continue; }
                int p = px.at(x, y); int lum = (((p >> 16) & 255) * 77 + ((p >> 8) & 255) * 150 + (p & 255) * 29) >> 8;
                sig[r][c] = (short) lum;
            }
        }
        return sig;
    }

    /** How many pixels the content moved up from `a` to `b` (scrolling down the page: positive), 0 when it stood
     *  still, NONE when the two do not match at any shift (another page, a video playing). */
    static int shift(short[][] a, short[][] b, int maxPx) {
        if (a == null || b == null || a.length != b.length || a.length < 8) return NONE;
        int rows = a.length, max = Math.min(rows - rows / 4, maxPx / STEP);
        double still = diff(a, b, 0, rows, 1);
        if (still < 0.3) return 0;
        // (Coarse first — every second shift, every third row —, then the best found refined: about a tenth of the work.)
        double best = Double.MAX_VALUE; int bestS = NONE;
        for (int s = -max; s <= max; s += 2) { if (s == 0) continue; double d = diff(a, b, s, rows, 3); if (d < best) { best = d; bestS = s; } }
        if (bestS == NONE) return still < 6 ? 0 : NONE;
        int c0 = bestS; best = Double.MAX_VALUE;
        for (int s = c0 - 2; s <= c0 + 2; s++) { if (s == 0 || Math.abs(s) > max) continue; double d = diff(a, b, s, rows, 1); if (d < best) { best = d; bestS = s; } }
        // (A match much better than standing still, and close in itself; and the page must show some detail.)
        if (bestS == NONE || best > 6 || best > still * 0.6 || flat(b)) return still < 6 ? 0 : NONE;
        return bestS * STEP;
    }
    /** Mean difference of a's row r+s against b's row r, over the pairs both have (∞ when too few). */
    private static double diff(short[][] a, short[][] b, int s, int rows, int every) {
        long sum = 0; int n = 0;
        for (int r = Math.max(0, -s); r < rows && r + s < rows; r += every) {
            if (r + s < 0) continue; short[] x = a[r + s], y = b[r];
            for (int c = 0; c < COLS; c++) { if (x[c] < 0 || y[c] < 0) continue; sum += Math.abs(x[c] - y[c]); n++; }
        }
        return n < rows * COLS / 5 / every ? Double.MAX_VALUE : (double) sum / n;
    }
    /** A frame with nearly nothing on it (one colour): no scroll can be told from it. */
    private static boolean flat(short[][] s) {
        int lo = 255, hi = 0; for (short[] r : s) for (short v : r) { if (v < 0) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
        return hi - lo < 12;
    }
}
