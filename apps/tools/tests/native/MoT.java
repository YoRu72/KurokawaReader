// The screen translator's scroll finder (KtScreenMotion) on made-up pages: a comic-like page (mostly white, some
// panels and speech bubbles) scrolled down and back by various amounts — found to the pixel row step; standing still
// said as 0; another page entirely said as no match; the translator's own boxes, which move with the page, left out;
// a blank page not taken for a scroll. Run by screen.sh.
import java.util.*;
public class MoT {
  static int fails = 0; static void check(String w, boolean ok) { System.out.println((ok ? "ok   " : "FAIL ") + w); if (!ok) fails++; }
  static int[] page(int w, int h, long seed) { int[] p = new int[w * h]; Arrays.fill(p, 0xFFFFFFFF); Random r = new Random(seed);
    for (int k = 0; k < 40; k++) { int x = r.nextInt(w - 200), y = r.nextInt(h - 200), bw = 80 + r.nextInt(300), bh = 60 + r.nextInt(300), c = 0xFF000000 | r.nextInt(0xFFFFFF); for (int yy = y; yy < Math.min(h, y + bh); yy++) for (int xx = x; xx < Math.min(w, x + bw); xx++) p[yy * w + xx] = c; }
    for (int k = 0; k < 400; k++) { int x = r.nextInt(w - 20), y = r.nextInt(h - 4); for (int xx = x; xx < x + 18; xx++) p[y * w + xx] = 0xFF111111; } return p; }
  static short[][] view(int[] pg, int W, int H, int top, int vh, int[][] masks, int[][] paint) {
    return KtScreenMotion.signature((x, y) -> { if (paint != null) for (int[] m : paint) if (x >= m[0] && x < m[2] && y >= m[1] && y < m[3]) return 0xFF20A040; int yy = y + top; return yy < H ? pg[yy * W + x] : 0xFFFFFFFF; }, W, vh, masks);
  }
  public static void main(String[] a) {
    int W = 1080, H = 8000, VH = 2400; int[] pg = page(W, H, 7);
    short[][] s0 = view(pg, W, H, 2000, VH, null, null);
    check("standing still: 0", KtScreenMotion.shift(s0, view(pg, W, H, 2000, VH, null, null), VH) == 0);
    for (int d : new int[] { 8, 40, 200, 600, 1500, -12, -300, -1200 }) {
      int got = KtScreenMotion.shift(s0, view(pg, W, H, 2000 + d, VH, null, null), VH);
      check("scrolled " + d + " px: found " + got, Math.abs(got - d) <= KtScreenMotion.STEP);
    }
    Random nz = new Random(3); short[][] noisy = view(pg, W, H, 2000, VH, null, null); for (short[] r : noisy) for (int c = 0; c < r.length; c++) r[c] = (short) Math.max(0, Math.min(255, r[c] + nz.nextInt(7) - 3));
    check("standing still with a little noise (a compressed picture): 0", KtScreenMotion.shift(s0, noisy, VH) == 0);
    check("another page: no match", KtScreenMotion.shift(s0, view(page(W, H, 99), W, H, 1000, VH, null, null), VH) == KtScreenMotion.NONE);
    // The translator's boxes stay where they were drawn on screen (they are moved only after the scroll is found):
    // left out, the scroll is still found.
    int[][] boxes = { { 100, 300, 700, 500 }, { 300, 1200, 1000, 1500 }, { 0, 2000, 1080, 2300 } };
    int got = KtScreenMotion.shift(view(pg, W, H, 1000, VH, boxes, boxes), view(pg, W, H, 1300, VH, boxes, boxes), VH);
    check("with the translator's own boxes left out: found " + got, Math.abs(got - 300) <= KtScreenMotion.STEP);
    int[] blank = new int[W * H]; Arrays.fill(blank, 0xFFFFFFFF);
    check("a blank page: not a scroll", KtScreenMotion.shift(view(blank, W, H, 0, VH, null, null), view(blank, W, H, 400, VH, null, null), VH) == 0);
    long t0 = System.nanoTime(); for (int i = 0; i < 20; i++) KtScreenMotion.shift(s0, view(pg, W, H, 2000 + 17 * i, VH, null, null), VH); long ms = (System.nanoTime() - t0) / 20_000_000;
    check("fast enough to follow a scroll (" + ms + " ms a frame here)", ms < 40);
    System.exit(fails == 0 ? 0 : 1);
  }
}
