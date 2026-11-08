// KtInpaint on its own: words taken off a plain balloon (white, black letters) and off a gradient (a dark-to-light
// sky with white letters) — what is left matches what was behind the letters, within a few levels.
public class InT {
  static int fails = 0;
  static void ok(String n, boolean c, String x) { System.out.println((c ? "ok   " : "FAIL ") + n + (c ? "" : "  " + x)); if (!c) fails++; }
  static int[] scene(int w, int h, java.util.function.IntBinaryOperator bg, int ink) {
    int[] p = new int[w * h];
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) p[y * w + x] = bg.applyAsInt(x, y);
    // letters: strokes in the middle, kept 6 px from the edges
    for (int y = 8; y < h - 8; y++) for (int x = 8; x < w - 8; x++) if ((x / 3) % 3 == 0 || (y % 9) < 2) p[y * w + x] = ink;
    return p;
  }
  static int worst(int[] a, int w, int h, java.util.function.IntBinaryOperator bg) {
    int m = 0; for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) { int p = a[y * w + x], q = bg.applyAsInt(x, y); for (int s = 0; s < 24; s += 8) m = Math.max(m, Math.abs(((p >> s) & 255) - ((q >> s) & 255))); } return m;
  }
  public static void main(String[] a) {
    int w = 160, h = 60;
    java.util.function.IntBinaryOperator white = (x, y) -> 0xFFFFFFFF;
    int[] r1 = KtInpaint.clean(scene(w, h, white, 0xFF000000), w, h);
    int m1 = worst(r1, w, h, white); ok("a plain balloon: the letters gone", m1 <= 6, "off by " + m1);
    java.util.function.IntBinaryOperator sky = (x, y) -> { int v = 40 + x * 150 / w; int g = 60 + y * 100 / h; return 0xFF000000 | v << 16 | g << 8 | 200; };
    int[] r2 = KtInpaint.clean(scene(w, h, sky, 0xFFFFFFFF), w, h);
    int m2 = worst(r2, w, h, sky); ok("a gradient: the letters gone, the gradient kept", m2 <= 14, "off by " + m2);
    int[] plain = new int[w * h]; for (int i = 0; i < plain.length; i++) plain[i] = sky.applyAsInt(i % w, i / w);
    ok("nothing to take off: left as it was", worst(KtInpaint.clean(plain, w, h), w, h, sky) <= 3, "");
    System.exit(fails == 0 ? 0 : 1);
  }
}
