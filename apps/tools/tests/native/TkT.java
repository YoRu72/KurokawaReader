// The floating translator's following of the screen (KtScreenTrack) on made-up sequences: a steady scroll read now and
// then by a jittery OCR, a fast fling, a line read a letter differently, a line leaving the screen and coming back,
// two alike lines trading places, a sideways pan, the page's movement not found, our own translation read back, a
// line cut at the screen's edge — never two lines swapped, nothing translated again that did not change, every box
// within a few pixels of its words, nothing that stayed on the screen dropped for a reading. Then the movement from
// frames (a slow scroll that used to be lost), the app's scroll reports, the pacing, the strip read first, and what is
// translated ahead (order, caps, the budget). Run by screen.sh.
import java.util.*;
public class TkT {
  static int fails = 0; static void check(String w, boolean ok) { System.out.println((ok ? "ok   " : "FAIL ") + w); if (!ok) fails++; }
  static final int VW = 1080, VH = 2400;
  /** A page of lines: text and page y; the screen shows page rows [top, top+VH). */
  static String[] LINES = new String[60]; static int[] PY = new int[60];
  static { String[] w = { "the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog", "river", "stone", "night", "light", "garden", "letter" };
    Random r = new Random(5); for (int k = 0; k < 60; k++) { StringBuilder b = new StringBuilder("Line " + (char) ('A' + k % 26) + (char) ('a' + k / 26)); for (int j = 0; j < 4 + r.nextInt(5); j++) b.append(' ').append(w[r.nextInt(w.length)]); LINES[k] = b.toString(); PY[k] = 100 + k * 130; } }
  /** An OCR reading of the screen at page offset `top`: boxes off by a pixel or two, now and then a letter misread. */
  static List<KtScreenTrack.Obs> read(int top, int dx, Random r, double typo) {
    List<KtScreenTrack.Obs> o = new ArrayList<>();
    for (int k = 0; k < LINES.length; k++) { int y = PY[k] - top; if (y + 60 <= 0 || y >= VH) continue; String t = LINES[k];
      if (r.nextDouble() < typo) { char[] c = t.toCharArray(); int i = 6 + r.nextInt(c.length - 6); c[i] = c[i] == 'l' ? '1' : 'l'; t = new String(c); }
      int y0 = Math.max(0, y), y1 = Math.min(VH, y + 60); o.add(new KtScreenTrack.Obs(t, 40 + dx + r.nextInt(5) - 2, y0 + r.nextInt(5) - 2, 800 + r.nextInt(7) - 3, y1 - y0 + r.nextInt(3) - 1, k)); }
    return o;
  }
  /** The worst distance between a followed box and where its line really is. */
  static int worst(KtScreenTrack t, int top, int dx) { int m = 0; for (KtScreenTrack.Item i : t.items) { int k = idx(i); if (k < 0) continue; int y = PY[k] - top; if (y + 60 <= 0 || y >= VH) continue; if (i.clipped) continue; m = Math.max(m, Math.max(Math.abs(i.y - y), Math.abs(i.x - (40 + dx)))); } return m; }
  static int idx(KtScreenTrack.Item i) { return i.data instanceof Integer ? (Integer) i.data : -1; }
  /** Every item still the line it first was (identity by the line it was made from). */
  static Map<Integer, Integer> born = new HashMap<>();
  static boolean noSwap(KtScreenTrack t, KtScreenTrack.Update u, List<KtScreenTrack.Obs> obs) {
    boolean ok = true;
    for (int k = 0; k < obs.size(); k++) { KtScreenTrack.Item i = u.of[k]; if (i == null) continue; int line = (Integer) obs.get(k).data; Integer b = born.putIfAbsent(i.id, line); if (b != null && b != line) { ok = false; System.out.println("   swapped: #" + i.id + " was line " + b + ", now " + line); } }
    return ok;
  }
  static int retexts = 0, adds = 0, drops = 0;
  static KtScreenTrack.Update apply(KtScreenTrack t, List<KtScreenTrack.Obs> obs) {
    KtScreenTrack.Update u = t.update(obs, null); retexts += u.retext.size(); adds += u.added.size(); drops += u.dropped.size();
    for (KtScreenTrack.Item i : u.added) i.tr = "tr:" + i.text; return u;
  }

  public static void main(String[] a) {
    // ---- text compared loosely ----
    check("alike: a letter misread", KtScreenTrack.similar("Hello world, again", "HeIlo world. again") >= KtScreenTrack.SAME);
    check("not alike: other words", KtScreenTrack.similar("Hello world", "Goodbye moon") < 0.5);
    check("digits told apart", !KtScreenTrack.digits("3 likes").equals(KtScreenTrack.digits("4 likes")));

    // ---- a steady scroll, 14 px a frame, read every 6th frame by a jittery OCR ----
    KtScreenTrack t = new KtScreenTrack().viewport(VW, VH); Random r = new Random(11); int top = 0, maxErr = 0; boolean swapOk = true, kept = true;
    KtScreenTrack.Update u = apply(t, read(top, 0, r, 0)); swapOk &= noSwap(t, u, read(top, 0, new Random(11), 0)); retexts = 0; int first = adds;
    for (int f = 1; f <= 240; f++) {
      top += 14; t.moved(0, -14, null);   // (the movement found from the frames, applied at once)
      maxErr = Math.max(maxErr, worst(t, top, 0));
      if (f % 6 == 0) { List<KtScreenTrack.Obs> o = read(top, 0, r, 0.15); u = apply(t, o); swapOk &= noSwap(t, u, o);
        for (KtScreenTrack.Item d : u.dropped) { int k = idx(d), y = PY[k] - top; if (y + 60 > 0 && y < VH) kept = false; } }
    }
    int lines = adds;
    check("steady scroll: no line swapped", swapOk);
    check("steady scroll: boxes within " + maxErr + " px of their words (≤ " + (KtScreenTrack.STILL + 3) + ")", maxErr <= KtScreenTrack.STILL + 3);
    check("steady scroll: misread letters translated again " + retexts + " times (0; " + (int) (40 * 0.15 * 22) + " misreadings or so)", retexts == 0);
    check("steady scroll: each line made once (" + lines + " for " + (first) + " at first + those scrolled in)", lines <= 60);
    check("steady scroll: no line on the screen dropped", kept);

    // ---- a fast fling: 900 px a frame, nothing read meanwhile, then read: the same pieces, put right ----
    int idsBefore = t.items.size(); adds = 0; retexts = 0;
    for (int f = 0; f < 2; f++) { top += 900; t.moved(0, -900, null); }
    top -= 1800; t.moved(0, 1800, null);   // (and back)
    u = apply(t, read(top, 0, r, 0.1)); swapOk = noSwap(t, u, read(top, 0, new Random(1), 0));
    check("a fling there and back: nothing made again (" + adds + "), nothing translated again (" + retexts + ")", adds == 0 && retexts == 0 && t.items.size() >= idsBefore - 1);
    check("a fling: boxes within " + worst(t, top, 0) + " px", worst(t, top, 0) <= KtScreenTrack.STILL + 3);

    // ---- a line read a letter differently, a number changed, a line missed once ----
    KtScreenTrack j = new KtScreenTrack().viewport(VW, VH);
    j.update(Arrays.asList(new KtScreenTrack.Obs("Welcome back, traveller", 40, 300, 600, 50, 0), new KtScreenTrack.Obs("3 new messages", 40, 400, 400, 50, 1)), null);
    KtScreenTrack.Update u2 = j.update(Arrays.asList(new KtScreenTrack.Obs("WeIcome back, traveIler.", 41, 302, 604, 49, 0), new KtScreenTrack.Obs("4 new messages", 40, 400, 400, 50, 1)), null);
    check("a letter misread: kept, not translated again; a number changed: translated again", u2.retext.size() == 1 && u2.retext.get(0).text.startsWith("4") && j.items.get(0).text.equals("Welcome back, traveller"));
    check("a box off by 2 px: left where it is (no redraw)", u2.glide.isEmpty() && u2.snap.isEmpty() && u2.resized.isEmpty());
    KtScreenTrack.Update u3 = j.update(Arrays.asList(new KtScreenTrack.Obs("4 new messages", 40, 400, 400, 50, 1)), null);
    check("a line missed in one reading: kept (no flicker)", u3.dropped.isEmpty() && j.items.size() == 2);
    KtScreenTrack.Update u4 = j.update(Arrays.asList(new KtScreenTrack.Obs("4 new messages", 40, 400, 400, 50, 1)), null);
    check("missed in two readings: gone", u4.dropped.size() == 1);
    KtScreenTrack.Update u5 = j.update(Arrays.asList(new KtScreenTrack.Obs("4 new messages", 40, 420, 400, 50, 1)), null);
    check("corrected by 20 px: glided, not snapped", u5.glide.size() == 1 && u5.snap.isEmpty());

    // ---- leaving the screen and coming back: the same piece, its translation kept ----
    KtScreenTrack l = new KtScreenTrack().viewport(VW, VH); l.keepMisses = 1;
    KtScreenTrack.Item it = l.update(Arrays.asList(new KtScreenTrack.Obs("A line that leaves", 40, 200, 600, 50, 0)), null).added.get(0); it.tr = "سطر يغادر";
    l.moved(0, -1500, null); l.update(new ArrayList<>(), null); l.update(new ArrayList<>(), null);
    l.moved(0, 1500, null); KtScreenTrack.Update back = l.update(Arrays.asList(new KtScreenTrack.Obs("A line that leaves", 40, 201, 600, 50, 0)), null);
    check("left the screen and came back: the same piece, translation kept", back.of[0] == it && "سطر يغادر".equals(it.tr) && back.added.isEmpty() && back.retext.isEmpty());

    // ---- two alike lines trading places ----
    KtScreenTrack s = new KtScreenTrack().viewport(VW, VH);
    KtScreenTrack.Update s0 = s.update(Arrays.asList(new KtScreenTrack.Obs("Yes, I know.", 40, 1000, 300, 50, 0), new KtScreenTrack.Obs("Yes, I know!", 40, 1060, 300, 50, 1)), null);
    KtScreenTrack.Item A = s0.of[0], B = s0.of[1];
    s.moved(0, -60, null);   // B is now where A was
    KtScreenTrack.Update s1 = s.update(Arrays.asList(new KtScreenTrack.Obs("Yes, I know.", 40, 940, 300, 50, 0), new KtScreenTrack.Obs("Yes, I know!", 40, 1000, 300, 50, 1)), null);
    check("two alike lines, scrolled by one line: not swapped", s1.of[0] == A && s1.of[1] == B && s1.retext.isEmpty());
    KtScreenTrack.Update s2 = s.update(Arrays.asList(new KtScreenTrack.Obs("Yes, I know.", 40, 880, 300, 50, 0), new KtScreenTrack.Obs("Yes, I know!", 40, 940, 300, 50, 1)), null);
    check("…and when the movement was not known: still not swapped", s2.of[0] == A && s2.of[1] == B && s2.retext.isEmpty());

    // ---- a sideways pan ----
    KtScreenTrack h = new KtScreenTrack().viewport(VW, VH); born.clear(); retexts = 0; adds = 0; Random hr = new Random(2);
    h.update(read(0, 0, hr, 0), null); int hn = h.items.size(); int hx = 0, hErr = 0;
    for (int f = 1; f <= 10; f++) { hx -= 30; h.moved(-30, 0, null); hErr = Math.max(hErr, worst(h, 0, hx)); }
    u = apply(h, read(0, hx, hr, 0.1));
    check("a sideways pan of 300 px: within " + hErr + " px, nothing made or translated again", hErr <= 3 && adds == 0 && retexts == 0 && h.items.size() == hn);

    // ---- the movement not found (another app's animation): readings pair by words, boxes put right at once ----
    KtScreenTrack e = new KtScreenTrack().viewport(VW, VH); born.clear(); Random er = new Random(4);
    List<KtScreenTrack.Obs> e0 = read(0, 0, er, 0); KtScreenTrack.Update eu = e.update(e0, null); noSwap(e, eu, e0); retexts = 0; adds = 0;
    List<KtScreenTrack.Obs> e1 = read(300, 0, er, 0); eu = apply(e, e1);
    check("movement not found, 300 px: lines paired by their words (no swap, none made again " + eu.added.size() + ")", noSwap(e, eu, e1) && retexts == 0 && eu.added.size() <= 3 && worst(e, 300, 0) <= 3);

    // ---- our own translation read back from the screen ----
    KtScreenTrack o = new KtScreenTrack().viewport(VW, VH);
    KtScreenTrack.Item oi = o.update(Arrays.asList(new KtScreenTrack.Obs("Bonjour tout le monde", 40, 500, 500, 50, 0)), null).added.get(0); oi.tr = "Hello everyone";
    KtScreenTrack.Update ou = o.update(Arrays.asList(new KtScreenTrack.Obs("Bonjour tout le monde", 40, 500, 500, 50, 0), new KtScreenTrack.Obs("Hello everyone", 42, 505, 480, 45, 1)), null);
    check("our own translation read back: left out", ou.feedback == 1 && ou.added.isEmpty() && o.items.size() == 1);

    // ---- a line cut at the screen's edge ----
    KtScreenTrack c = new KtScreenTrack().viewport(VW, VH);
    KtScreenTrack.Item ci = c.update(Arrays.asList(new KtScreenTrack.Obs("The quick brown fox jumps over", 40, VH - 30, 800, 30, 0)), null).added.get(0);
    c.moved(0, -40, null); KtScreenTrack.Update cu = c.update(Arrays.asList(new KtScreenTrack.Obs("The quick brown fox jumps over the lazy dog", 40, VH - 70, 800, 60, 0)), null);
    check("a line met cut at the bottom, then whole: the same piece, translated once more", cu.of[0] == ci && cu.retext.size() == 1);
    c.moved(0, -(VH - 50), null); cu = c.update(Arrays.asList(new KtScreenTrack.Obs("the lazy dog", 40, 0, 800, 20, 0)), null);
    check("a whole line cut at the top: kept whole, not translated again", cu.of[0] == ci && cu.retext.isEmpty() && ci.text.endsWith("lazy dog") && ci.text.startsWith("The quick"));

    // ---- the movement from frames: a slow scroll (2 px a frame) adds up instead of being lost ----
    int W = 1080, H = 8000, SH = 2400; int[] pg = MoTPage.page(W, H, 7);
    KtScreenTrack.Follow fo = new KtScreenTrack.Follow(SH); int sum = 0, naive = 0; short[][] prev = null; int y0 = 1000;
    for (int f = 0; f <= 150; f++) { short[][] sig = MoTPage.view(pg, W, H, y0 + 2 * f, SH); int d = fo.feed(sig); if (d != KtScreenMotion.NONE) sum += d; if (prev != null) { int n = KtScreenMotion.shift(prev, sig, SH); if (n != KtScreenMotion.NONE) naive += n; } prev = sig; }
    check("a slow scroll of 300 px, 2 px a frame: followed to " + sum + " px (each frame against the last: " + naive + ")", Math.abs(sum - 300) <= KtScreenMotion.STEP);
    fo = new KtScreenTrack.Follow(SH); sum = 0; int[] steps = { 0, 700, 900, 850, 600, 300, 120, 40, 10, 3, 1, 0, 0 }; int at = 1000;
    for (int st : steps) { at += st; int d = fo.feed(MoTPage.view(pg, W, H, at, SH)); if (d != KtScreenMotion.NONE) sum += d; }
    check("a fling slowing down (3524 px): followed to " + sum + " px", Math.abs(sum - 3524) <= 2 * KtScreenMotion.STEP);
    check("another page: not followed", fo.feed(MoTPage.view(MoTPage.page(W, H, 99), W, H, 0, SH)) == KtScreenMotion.NONE);

    // ---- the app's scroll reports ----
    KtScreenTrack.Scrolls sc = new KtScreenTrack.Scrolls();
    check("a report with its delta: taken", Arrays.equals(sc.delta("w1/list", 0, 0, 0, 120, true), new int[] { 0, 120 }));
    check("only a position, first from this list: unknown", sc.delta("w2/web", 0, 500, 0, 0, false) == null);
    check("only a position, then another: the difference", Arrays.equals(sc.delta("w2/web", 0, 740, 0, 0, false), new int[] { 0, 240 }));
    check("a list that keeps no position (0 every time): unknown, not «still»", sc.delta("w3/rv", 0, 0, 0, 0, false) == null && sc.delta("w3/rv", 0, 0, 0, 0, true) == null);
    KtScreenTrack bl = new KtScreenTrack().viewport(VW, VH); KtScreenTrack.Item bi = bl.update(Arrays.asList(new KtScreenTrack.Obs("Under our box", 40, 2200, 500, 50, 0)), null).added.get(0); bi.tr = "x";
    bl.update(new ArrayList<>(), new int[] { 0, 2000, VW, VH }, (i) -> i.tr != null); bl.update(new ArrayList<>(), new int[] { 0, 2000, VW, VH }, (i) -> i.tr != null);
    check("a strip read with the boxes showing: a piece under its own box not missed", bl.items.size() == 1);
    bl.moved(0, -100, null); bl.moved(0, -50, new int[] { 0, 0, 10, 10 }); check("whole-screen movement added up (area-only movement not)", bl.movedY == -100);

    // ---- pacing ----
    KtScreenTrack.Pace p = new KtScreenTrack.Pace(400, 3200);
    check("readings that find nothing new: slower, up to the most", p.afterRead(false) == 800 && p.afterRead(false) == 1600 && p.afterRead(false) == 3200 && p.afterRead(false) == 3200);
    p.moved(10_000); check("moved: fast again; nothing heavy until it settles", p.afterRead(true) == 400 && !p.settled(10_300, 500) && p.settled(10_600, 500));
    check("frames compared often while moving, less when still", p.frameGap(10_100) < p.frameGap(20_000));
    check("the strip a scroll brought in, read first", Arrays.equals(KtScreenTrack.strip(300, VW, VH, 60), new int[] { 0, VH - 360, VW, VH }) && Arrays.equals(KtScreenTrack.strip(-200, VW, VH, 60), new int[] { 0, 0, VW, 260 }) && KtScreenTrack.strip(0, VW, VH, 60) == null);

    // ---- translating ahead ----
    List<KtScreenTrack.Cand> cs = new ArrayList<>();
    for (int k = 0; k < 10; k++) cs.add(new KtScreenTrack.Cand("Above " + k, k, false, 0, 0));
    cs.add(new KtScreenTrack.Cand("Hidden tab", 10, false, 500, 600));   // (inside the screen, not shown: another tab's page)
    for (int k = 11; k < 20; k++) cs.add(new KtScreenTrack.Cand("On screen " + k, k, true, (k - 11) * 200, (k - 11) * 200 + 60));
    for (int k = 20; k < 80; k++) cs.add(new KtScreenTrack.Cand(k == 25 ? "Below 21" : "Below " + k, k, false, k < 40 ? VH + (k - 20) * 300 : 0, k < 40 ? VH + (k - 20) * 300 + 60 : 0));
    List<String> ah = KtScreenTrack.ahead(cs, VH, 1, 20, 10_000, 2, (x) -> x.equals("Below 22"));
    check("ahead, scrolling down: below first, in reading order " + ah, ah.get(0).equals("Below 20") && ah.get(1).equals("Below 21") && ah.indexOf("Below 23") == 2);
    check("ahead: nothing on the screen, nothing hidden, nothing known, nothing twice", !ah.contains("Hidden tab") && !ah.contains("Below 22") && ah.stream().noneMatch((x) -> x.startsWith("On screen")) && ah.stream().filter((x) -> x.equals("Below 21")).count() == 1);
    check("ahead: at most 20, three quarters below, then a few above (nearest first)", ah.size() == 20 && ah.stream().filter((x) -> x.startsWith("Below")).count() == 15 && ah.get(15).equals("Above 9"));
    List<String> ah2 = KtScreenTrack.ahead(cs, VH, 1, 200, 10_000, 2, null);
    check("ahead: not past two screens when their places are known (" + ah2.stream().filter((x) -> x.startsWith("Below")).count() + " below)", !ah2.contains("Below 39") && ah2.contains("Below 35"));
    List<String> up = KtScreenTrack.ahead(cs, VH, -1, 8, 10_000, 2, null);
    check("ahead, scrolling up: above first " + up, up.get(0).equals("Above 9") && up.get(5).equals("Above 4") && up.get(6).startsWith("Below"));
    check("ahead: at most so many letters", KtScreenTrack.ahead(cs, VH, 1, 200, 30, 2, null).size() == 3);
    check("ahead: nothing on the screen known, nothing ahead", KtScreenTrack.ahead(cs.subList(0, 10), VH, 1, 20, 1000, 2, null).isEmpty());
    KtScreenTrack.Budget bg = KtScreenTrack.Budget.of("deepl");
    check("budget, a paid key: 1500 letters a minute", bg.take(1000, 0) && !bg.take(600, 1000) && bg.take(500, 2000) && !bg.take(1, 3000) && bg.take(1000, 61_000));
    bg.refused(70_000); check("budget: a refusal pauses it for two minutes", !bg.take(1, 100_000) && bg.take(1, 200_000));
    check("budget: the free translators more", KtScreenTrack.Budget.of("google").perMinute > KtScreenTrack.Budget.of("ai").perMinute);
    System.exit(fails == 0 ? 0 : 1);
  }
}
/** The made-up comic page of MoT.java. */
class MoTPage {
  static int[] page(int w, int h, long seed) { int[] p = new int[w * h]; Arrays.fill(p, 0xFFFFFFFF); Random r = new Random(seed);
    for (int k = 0; k < 40; k++) { int x = r.nextInt(w - 200), y = r.nextInt(h - 200), bw = 80 + r.nextInt(300), bh = 60 + r.nextInt(300), c = 0xFF000000 | r.nextInt(0xFFFFFF); for (int yy = y; yy < Math.min(h, y + bh); yy++) for (int xx = x; xx < Math.min(w, x + bw); xx++) p[yy * w + xx] = c; }
    for (int k = 0; k < 400; k++) { int x = r.nextInt(w - 20), y = r.nextInt(h - 4); for (int xx = x; xx < x + 18; xx++) p[y * w + xx] = 0xFF111111; } return p; }
  static short[][] view(int[] pg, int W, int H, int top, int vh) { return KtScreenMotion.signature((x, y) -> { int yy = y + top; return yy < H ? pg[yy * W + x] : 0xFFFFFFFF; }, W, vh, null); }
}
