package app.kurokawa.tools;

/**
 * The words taken off the picture behind them (Ascent's way of lettering a translation): what is behind a block of
 * text is guessed from the ring of pixels around it — its four edges, smoothed, blended across the block (a Coons
 * patch: a plain balloon comes out plain, a gradient or a soft sky as it was) —; every pixel that is far from that
 * guess (a letter's stroke, its outline) and a little around it is replaced by the guess, softened. The translation
 * is then drawn on the cleaned picture instead of a box of one colour. Plain Java on ARGB ints (tested on its own:
 * tests/native/screen.sh).
 */
final class KtInpaint {
    private KtInpaint() {}

    /** `px` (w × h ARGB, a block with a few pixels of margin all round) with its text taken off; a new array. */
    static int[] clean(int[] px, int w, int h) {
        if (w < 4 || h < 4 || px.length < w * h) return px.clone();
        int[][] top = edge(px, w, h, 0), bottom = edge(px, w, h, 1), left = edge(px, w, h, 2), right = edge(px, w, h, 3);
        int[] guess = new int[w * h];
        for (int y = 0; y < h; y++) {
            double v = y / (double) (h - 1);
            for (int x = 0; x < w; x++) {
                double u = x / (double) (w - 1); int out = 0xFF000000;
                for (int c = 0; c < 3; c++) {
                    double e = (1 - v) * top[c][x] + v * bottom[c][x] + (1 - u) * left[c][y] + u * right[c][y]
                        - ((1 - u) * (1 - v) * top[c][0] + u * (1 - v) * top[c][w - 1] + (1 - u) * v * bottom[c][0] + u * v * bottom[c][w - 1]);
                    int k = (int) Math.round(Math.max(0, Math.min(255, e))); out |= k << (16 - 8 * c);
                }
                guess[y * w + x] = out;
            }
        }
        // (The letters: far from the guess. Grown by two pixels — anti-aliasing, outlines — then filled.)
        boolean[] ink = new boolean[w * h];
        for (int i = 0; i < w * h; i++) ink[i] = dist(px[i], guess[i]) > 46;
        boolean[] mask = new boolean[w * h]; final int R = 2;
        for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
            if (!ink[y * w + x]) continue;
            for (int dy = -R; dy <= R; dy++) for (int dx = -R; dx <= R; dx++) { int xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) mask[yy * w + xx] = true; }
        }
        int[] out = px.clone();
        for (int i = 0; i < w * h; i++) if (mask[i]) out[i] = guess[i];
        // (Softened where it was filled, so no hard seam is left at the letters' edges.)
        for (int pass = 0; pass < 2; pass++) {
            int[] b = out.clone();
            for (int y = 1; y < h - 1; y++) for (int x = 1; x < w - 1; x++) {
                int i = y * w + x; if (!mask[i]) continue;
                int r = 0, g = 0, bl = 0;
                for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) { int p = out[i + dy * w + dx]; r += (p >> 16) & 255; g += (p >> 8) & 255; bl += p & 255; }
                b[i] = 0xFF000000 | ((r / 9) << 16) | ((g / 9) << 8) | (bl / 9);
            }
            out = b;
        }
        return out;
    }

    /** One edge (0 top, 1 bottom, 2 left, 3 right) as three channels, each smoothed by a running median (a letter
     *  touching the edge does not colour the guess). */
    private static int[][] edge(int[] px, int w, int h, int side) {
        int n = side < 2 ? w : h; int[][] ch = new int[3][n];
        for (int i = 0; i < n; i++) {
            int p = side == 0 ? px[i] : side == 1 ? px[(h - 1) * w + i] : side == 2 ? px[i * w] : px[i * w + w - 1];
            ch[0][i] = (p >> 16) & 255; ch[1][i] = (p >> 8) & 255; ch[2][i] = p & 255;
        }
        int win = Math.max(2, n / 6);
        for (int c = 0; c < 3; c++) {
            int[] src = ch[c].clone(); int[] buf = new int[2 * win + 1];
            for (int i = 0; i < n; i++) {
                int m = 0; for (int j = i - win; j <= i + win; j++) buf[m++] = src[Math.max(0, Math.min(n - 1, j))];
                java.util.Arrays.sort(buf, 0, m); ch[c][i] = buf[m / 2];
            }
        }
        return ch;
    }
    private static int dist(int a, int b) {
        int dr = ((a >> 16) & 255) - ((b >> 16) & 255), dg = ((a >> 8) & 255) - ((b >> 8) & 255), db = (a & 255) - (b & 255);
        return (int) Math.sqrt((dr * dr * 3 + dg * dg * 4 + db * db * 2) / 9.0);
    }
    /** The cleaned picture's main colour (for the text's colour on it). */
    static int average(int[] px) { long r = 0, g = 0, b = 0; for (int p : px) { r += (p >> 16) & 255; g += (p >> 8) & 255; b += p & 255; } int n = Math.max(1, px.length); return 0xFF000000 | (int) (r / n) << 16 | (int) (g / n) << 8 | (int) (b / n); }
}
