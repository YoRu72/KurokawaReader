// Stage M4 on the computer: the screen translator's jobs and the HLS reader, Java's and Rust's, through the app's own
// KtCore door and the host build of libkt_android.so. Run by screen-rust.sh:
//   ScreenRustT shadow <Test>  — tests/native's Test run as it is, every call also asked of Rust (shadow mode): any
//                                difference fails the run (checked at exit).
//   ScreenRustT rust <Test>    — the same test with the Rust engine chosen: its own checks must pass, and no call may
//                                have fallen back to Java (strict).
//   ScreenRustT parity         — more cases than the tests have: random readings tracked by both and compared step by
//                                step, random pictures cleaned by both (at the tolerance), awkward playlists and
//                                addresses (Java's java.net.URL against Rust's), the tolerance itself, the patch cache.
//   ScreenRustT bench          — Java against Rust with the JNI copies counted (host numbers, not a phone's).
//   ScreenRustT absent         — no library: the Rust engine chosen, everything Java, nothing counted as a failure.
import app.kurokawa.tools.KtCore;
import java.io.*; import java.net.URL; import java.util.*;

public class ScreenRustT {
  static int fails = 0;
  static void check(String what, boolean ok, Object got) { System.out.println((ok ? "ok   " : "FAIL ") + what + (ok ? "" : ": " + got)); if (!ok) fails++; }

  public static void main(String[] a) throws Exception {
    String mode = a.length > 0 ? a[0] : "parity";
    if (mode.equals("shadow") || mode.equals("rust")) { wrap(mode, a[1]); return; }
    if (mode.equals("absent")) { absent(); return; }
    check("library loaded", KtCore.available(), KtCore.status());
    if (mode.equals("parity")) parity(); else bench();
    System.out.println(fails == 0 ? "all passed" : fails + " failed"); System.exit(fails == 0 ? 0 : 1);
  }

  /** Another test's main under shadow mode or the Rust engine; its exit code kept unless Rust differed or fell back. */
  static void wrap(String mode, String test) throws Exception {
    if (!KtCore.available()) { System.out.println("FAIL no library: " + KtCore.status()); System.exit(2); }
    if (mode.equals("shadow")) KtCore.shadow = true; else KtScreenRs.rust = true;
    Runtime.getRuntime().addShutdownHook(new Thread(() -> {
      Map<String, Object> r = KtCore.shadowReport();
      if (mode.equals("shadow")) {
        System.out.println("     shadow: " + r.get("calls") + " calls asked of both, " + r.get("mismatches") + " different " + r.get("first"));
        if (((Number) r.get("calls")).longValue() == 0 || ((Number) r.get("mismatches")).longValue() != 0) { System.out.println("FAIL " + test + " under shadow mode"); Runtime.getRuntime().halt(3); }
      } else {
        System.out.println("     rust engine: " + KtScreenRs.CALLS.get() + " calls, " + KtScreenRs.FALLBACKS.get() + " handed back to Java; HLS: " + KtHlsRs.CALLS.get() + " readings, " + KtHlsRs.FALLBACKS.get() + " handed back");
        if (KtScreenRs.FALLBACKS.get() != 0 || KtHlsRs.FALLBACKS.get() != 0 || KtScreenRs.CALLS.get() + KtHlsRs.CALLS.get() == 0) { System.out.println("FAIL " + test + ": Rust fell back to Java"); Runtime.getRuntime().halt(4); }
      }
    }));
    Class.forName(test).getMethod("main", String[].class).invoke(null, (Object) new String[0]);
  }

  static void absent() throws Exception {
    check("no library: absent", !KtCore.available(), KtCore.status());
    KtScreenRs.rust = true;
    KtScreenTrack t = new KtScreenTrack(); KtScreenTrack.Update u = t.update(Arrays.asList(new KtScreenTrack.Obs("Hello", 1, 1, 50, 20, null)), null);
    check("tracking: Java's answer", u.added.size() == 1, u.added);
    check("shift: Java's answer", KtScreenMotion.shift(new short[8][24], new short[8][24], 32) == 0, "");
    int[] px = new int[16]; Arrays.fill(px, 0xFFFFFFFF); check("inpaint: Java's answer", Arrays.equals(KtInpaint.clean(px, 4, 4), px), "");
    check("nothing counted as a Rust failure", KtScreenRs.FALLBACKS.get() == 0 && KtScreenRs.CALLS.get() == 0, KtScreenRs.FALLBACKS.get());
    KtHls.Playlist pl = KtHlsRs.media("#EXTM3U\n#EXTINF:4,\np.ts\n#EXT-X-ENDLIST\n", new URL("http://h/a.m3u8"), true);
    check("HLS with the Rust engine chosen, no library: Java's reading", pl.pieces.size() == 1 && KtHlsRs.FALLBACKS.get() == 0, pl.pieces.size());
    System.out.println(fails == 0 ? "all passed (no library: Java alone)" : fails + " failed"); System.exit(fails == 0 ? 0 : 1);
  }

  /* ---------------- parity ---------------- */

  static final String[] WORDS = { "the", "quick", "brown", "fox", "مرحبا", "بالعالم", "こんにちは", "世界", "3", "42", "likes", "Line", "İstanbul", "x!", "𠀋字", "a,b", "Yes", "I", "know" };
  static String sentence(Random r) { StringBuilder b = new StringBuilder(); int n = 1 + r.nextInt(6); for (int k = 0; k < n; k++) { if (k > 0) b.append(r.nextInt(5) == 0 ? "  " : " "); b.append(WORDS[r.nextInt(WORDS.length)]); } if (r.nextInt(4) == 0) b.append(r.nextBoolean() ? "." : "!"); return b.toString(); }
  static String typo(String s, Random r) { if (s.length() < 2 || r.nextInt(3) > 0) return s; char[] c = s.toCharArray(); int i = r.nextInt(c.length); c[i] = c[i] == 'l' ? 'I' : c[i] == 'o' ? '0' : c[i]; return new String(c); }

  static void parity() throws Exception {
    // --- tracking: random pages, readings and movements, Java's tracker and Rust's (applied) side by side ---
    int steps = 0, same = 0;
    for (int seed = 1; seed <= 60; seed++) {
      Random r = new Random(seed); int vh = 2400, vw = 1080;
      List<String> page = new ArrayList<>(); for (int k = 0; k < 40; k++) page.add(sentence(r));
      KtScreenTrack j = new KtScreenTrack().viewport(vw, vh), q = new KtScreenTrack().viewport(vw, vh);
      j.keepMisses = q.keepMisses = r.nextInt(3); j.keepOff = q.keepOff = r.nextBoolean(); j.cap = q.cap = 10 + r.nextInt(40);
      int top = 0;
      for (int step = 0; step < 25; step++) {
        int d = r.nextInt(5) == 0 ? r.nextInt(3000) - 1500 : r.nextInt(120) - 60; top += d; if (r.nextBoolean()) { j.moved(0, -d, null); q.moved(0, -d, null); }
        List<KtScreenTrack.Obs> obs = new ArrayList<>();
        for (int k = 0; k < page.size(); k++) { int y = 100 + k * 90 - top; if (y + 50 <= 0 || y >= vh || r.nextInt(8) == 0) continue; int y0 = Math.max(0, y), y1 = Math.min(vh, y + 50); obs.add(new KtScreenTrack.Obs(typo(page.get(k), r), 40 + r.nextInt(7) - 3, y0 + r.nextInt(7) - 3, 700 + r.nextInt(9) - 4, y1 - y0 + r.nextInt(5) - 2, k)); }
        if (r.nextInt(6) == 0 && !j.items.isEmpty()) { KtScreenTrack.Item i = j.items.get(r.nextInt(j.items.size())); obs.add(new KtScreenTrack.Obs(r.nextBoolean() ? "tr " + i.text : sentence(r), i.x + 2, i.y + 3, i.w, i.h, -1)); }
        for (int k = 0; k < j.items.size(); k++) if (r.nextInt(3) == 0) { String tr = "tr " + j.items.get(k).text; j.items.get(k).tr = tr; q.items.get(k).tr = tr; }
        int[] area = r.nextInt(4) == 0 ? new int[] { 0, vh - 600, vw, vh } : null;
        java.util.function.Predicate<KtScreenTrack.Item> blind = area != null ? (i) -> i.tr != null : null;
        KtScreenTrack.Update uj = j.updateJava(obs, area, blind);
        KtScreenTrack.Update uq = KtScreenRs.track(q, obs, area, blind);
        steps++;
        String dj = KtScreenRs.digest(j.items, uj).replaceAll(" d-?\\d+", ""), dq = uq == null ? "null" : KtScreenRs.digest(q.items, uq).replaceAll(" d-?\\d+", "");
        boolean dataSame = uq != null && j.items.size() == q.items.size(); if (dataSame) for (int k = 0; k < j.items.size(); k++) dataSame &= Objects.equals(j.items.get(k).data, q.items.get(k).data);
        if (dj.equals(dq) && dataSame) same++; else if (steps - same <= 3) System.out.println("     differs at seed " + seed + " step " + step + "\n       java " + dj + "\n       rust " + dq);
      }
    }
    check("tracking: " + same + " of " + steps + " random readings decided alike (pieces, words, boxes, misses, lists, data)", same == steps, steps - same);

    // --- shift: random pages and scrolls, masks ---
    int sh = 0, shSame = 0;
    for (int seed = 1; seed <= 40; seed++) {
      Random r = new Random(seed); int rows = 8 + r.nextInt(600); short[][] a = new short[rows][24], b = new short[rows][24];
      for (short[] row : a) for (int c = 0; c < 24; c++) row[c] = (short) (r.nextInt(10) == 0 ? -1 : r.nextInt(256));
      int s = r.nextInt(rows / 2 + 1) - rows / 4;
      for (int y = 0; y < rows; y++) for (int c = 0; c < 24; c++) { int yy = y + s; b[y][c] = yy >= 0 && yy < rows ? (short) Math.max(-1, Math.min(255, a[yy][c] + (a[yy][c] < 0 ? 0 : r.nextInt(5) - 2))) : (short) r.nextInt(256); }
      if (seed % 7 == 0) b = a; if (seed % 11 == 0) for (short[] row : b) Arrays.fill(row, (short) 200);
      int maxPx = 64 + r.nextInt(2400);
      int jv = KtScreenMotion.shiftJava(a, b, maxPx); Integer rv = KtScreenRs.shift(a, b, maxPx); sh++; if (rv != null && rv == jv) shSame++; else System.out.println("     shift differs: seed " + seed + " java " + jv + " rust " + rv);
    }
    check("shift: " + shSame + " of " + sh + " random signature pairs alike", shSame == sh, sh - shSame);

    // --- inpaint: random pictures, at the tolerance ---
    int ip = 0, ipSame = 0, worstSeen = 0;
    for (int seed = 1; seed <= 30; seed++) {
      Random r = new Random(seed); int w = 4 + r.nextInt(300), h = 4 + r.nextInt(120); int[] px = new int[w * h];
      int bg = 0xFF000000 | r.nextInt(0xFFFFFF), ink = 0xFF000000 | r.nextInt(0xFFFFFF);
      for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) { int g = (bg & 0xFF) + (x * 40 / w); px[y * w + x] = (r.nextInt(9) == 0) ? ink : (bg & 0xFFFFFF00) | Math.min(255, g) | (seed % 5 == 0 ? (r.nextInt(256) << 24) : 0xFF000000); }
      int[] jv = KtInpaint.cleanJava(px, w, h), rv = KtScreenRs.inpaint(px, w, h); ip++;
      int d = rv == null ? Integer.MAX_VALUE : KtScreenRs.worst(jv, rv); worstSeen = Math.max(worstSeen, d); if (d <= KtScreenRs.PIXEL_TOL) ipSame++;
    }
    check("inpaint: " + ipSame + " of " + ip + " random patches within " + KtScreenRs.PIXEL_TOL + " level (worst seen: " + worstSeen + ")", ipSame == ip, worstSeen);
    check("inpaint: in fact exactly equal on this machine", worstSeen == 0, worstSeen);
    // The tolerance itself: one level passes, two do not, alpha must match.
    int[] p = { 0xFF102030 }; check("tolerance: 1 level accepted", KtScreenRs.samePixels(p, new int[] { 0xFF112030 }), ""); check("tolerance: 2 levels refused", !KtScreenRs.samePixels(p, new int[] { 0xFF102032 }), ""); check("tolerance: another alpha refused", !KtScreenRs.samePixels(p, new int[] { 0xFE102030 }), "");
    // The patch cache: the same patch answers the same, a pixel changed is cleaned anew.
    int w = 220, h = 90; int[] patch = new int[w * h]; Random r = new Random(9); for (int i = 0; i < patch.length; i++) patch[i] = r.nextInt(12) == 0 ? 0xFF000000 : 0xFFF0F0F0;
    KtCore.r("scr.cacheClear"); Map<?, ?> st0 = (Map<?, ?>) KtCore.r("scr.stats"); int[] first = KtScreenRs.inpaint(patch, w, h), again = KtScreenRs.inpaint(patch, w, h); int[] changed = patch.clone(); changed[500] = 0xFFFF0000; int[] other = KtScreenRs.inpaint(changed, w, h);
    Map<?, ?> st = (Map<?, ?>) KtCore.r("scr.stats");
    long hits = ((Number) st.get("cacheHits")).longValue() - ((Number) st0.get("cacheHits")).longValue(), misses = ((Number) st.get("cacheMisses")).longValue() - ((Number) st0.get("cacheMisses")).longValue();
    check("patch cache: a repeat answers the same (" + st + ")", Arrays.equals(first, again) && Arrays.equals(first, KtInpaint.cleanJava(patch, w, h)) && hits == 1, st);
    check("patch cache: one pixel changed, cleaned anew and as Java", Arrays.equals(other, KtInpaint.cleanJava(changed, w, h)) && misses == 2, st);

    // --- lettering's rules and translating ahead, asked as the shadow asks ---
    Map<String, Object> rep0 = KtCore.shadowReport(); KtCore.shadow = true;
    Map<Integer, String> used = new HashMap<>(); used.put(0, "كوروكاوا"); used.put(12, "Item");
    KtLettering.restore(Arrays.asList("Hello [[0]] and [ [ 12 ] ]!", "[[3]] stays, [[[0]] too", null, "[[\t0\n]]"), used);
    List<KtLettering.Entry> g = new ArrayList<>(); for (String[] e : new String[][] { { "Kurokawa", "كوروكاوا" }, { "x", "" }, { "Item", "آيتم" } }) { KtLettering.Entry x = new KtLettering.Entry(); x.from = e[0]; x.to = e[1]; x.kind = ""; g.add(x); }
    KtLettering.prompt(g); KtLettering.prompt(new ArrayList<>());
    List<KtScreenTrack.Cand> cs = new ArrayList<>(); Random cr = new Random(3);
    for (int k = 0; k < 120; k++) { boolean on = k >= 40 && k < 55; int top = on ? (k - 40) * 150 : cr.nextInt(3) == 0 ? 0 : (k < 40 ? -3000 + k * 70 : 2400 + (k - 55) * 120); cs.add(new KtScreenTrack.Cand(cr.nextInt(15) == 0 ? "   " : " " + sentence(cr) + " ", k, on, top, top == 0 && !on ? 0 : top + 60)); }
    Set<String> known = new HashSet<>(); for (KtScreenTrack.Cand c : cs) if (cr.nextInt(5) == 0) known.add(c.text.trim());
    for (int dir : new int[] { 1, -1 }) for (int max : new int[] { 0, 5, 20, 80 }) for (int chars : new int[] { 30, 1500, 6000 }) KtScreenTrack.ahead(cs, 2400, dir, max, chars, 2, known::contains);
    Map<String, Object> rep = KtCore.shadowReport(); KtCore.shadow = false;
    long calls = ((Number) rep.get("calls")).longValue() - ((Number) rep0.get("calls")).longValue(), diff = ((Number) rep.get("mismatches")).longValue() - ((Number) rep0.get("mismatches")).longValue();
    check("lettering's markers and prompt, translating ahead: " + calls + " asked of both, all alike " + rep.get("first"), diff == 0 && calls >= 27, rep);

    // --- HLS: addresses as java.net.URL resolves them, playlists Java and Rust read alike ---
    String[] bases = { "http://h:8080/a/b/c.m3u8?tok=1#f", "https://cdn.example/x/y/", "http://h", "http://u@h/a", "HTTPS://Host.Example/A/B.m3u8" };
    String[] specs = { "p.ts", "../p.ts", "../../../p.ts", "./x/./y/../p.ts?q", "/root.ts", "//cdn2.example/x.ts", "https://o/x.ts", "HTTP:rel.ts", "?only", "", "#g", "  url:p.ts  ", "x/..", ".", "..", "p q.ts", "a/../../b/./c/..", "seg-1.ts?x=1&y=../2", "//h:81/x", "//h:/x", "http://h:65536/x", "/a/./b/../../../c", "مقطع.ts", "😀/x.ts", "%2e%2e/p.ts", "\tp.ts\r", "a:b/c.ts", "//u@v@h/x", "https:", "http:", "http:/x", "//", "?", "#" };
    int urls = 0, urlSame = 0, leftToJava = 0;
    for (String b : bases) for (String sp : specs) {
      String want; try { want = new URL(new URL(b), sp).toString(); } catch (Exception e) { want = "error"; }
      String got = rustUrl(b, sp); urls++;
      if (got.equals("error") && !want.equals("error")) leftToJava++;
      if (got.equals(want) || got.equals("error")) urlSame++; else System.out.println("     url differs: «" + b + "» + «" + sp + "»: java " + want + " rust " + got);
    }
    check("addresses: " + urlSame + " of " + urls + " resolved as java.net.URL does (" + leftToJava + " left to Java: another scheme, an odd authority)", urlSame == urls, urls - urlSame);
    String[] lists = {
      "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS=\"avc1.64001f,mp4a.40.2\"\nhigh/index.m3u8\n",
      "#EXTM3U\r\n#EXT-X-STREAM-INF:resolution=1x٧٢٠,bandwidth=99999999999\r\nv1\r\n#EXT-X-STREAM-INF:BANDWIDTH=+5,RESOLUTION=x\n\n  v2  \n#EXT-X-STREAM-INF:BANDWIDTH=4294967297\n#comment\nv3\n",
      "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE: 18446744073709551616\n#EXT-X-KEY:METHOD=AES-128,URI=\"../k.key\",IV=0x9\n#EXTINF:4.0f,\np0.ts\n#EXT-X-KEY:METHOD=AES-128,URI=\"k2\",IV=+f00\n#EXTINF:abc\np1.ts\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:,,\np2.jpg\n#EXT-X-BYTERANGE:10@20@30\n#EXTINF:1e1\np3.ts\n#EXT-X-BYTERANGE:7\nbig.ts\n#EXT-X-BYTERANGE:10@@\nbig.ts\n#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"720@0\"\n#EXT-X-ENDLIST\n",
      "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"k\"\n#EXTINF:4,\np\n", "#EXTM3U\n#EXTINF:4,\np\n", "#EXTM3U\n#EXT-X-BYTERANGE:@5\np\n", "", "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\np\n" };
    int pls = 0, plSame = 0;
    for (String b : bases) for (String t : lists) {
      URL base = new URL(b); String wv, wm, gv, gm;
      try { wv = KtHlsRs.show(KtHls.variants(t, base)); } catch (Exception e) { wv = "error"; }
      try { wm = KtHlsRs.show(KtHls.media(t, base)); } catch (Exception e) { wm = "error"; }
      try { gv = KtHlsRs.show(KtHlsRs.variantsRust(t, base)); } catch (Exception e) { gv = "error"; }
      try { gm = KtHlsRs.show(KtHlsRs.mediaRust(t, base)); } catch (Exception e) { gm = "error"; }
      pls += 2; if (gv.equals(wv) || (gv.equals("error") && wv.equals("error"))) plSame++; else System.out.println("     variants differ:\n" + wv + "\n---\n" + gv);
      if (gm.equals(wm) || (gm.equals("error") && wm.equals("error"))) plSame++; else System.out.println("     media differs:\n" + wm + "\n---\n" + gm);
    }
    check("playlists: " + plSame + " of " + pls + " read alike (an error on both sides counts as alike)", plSame == pls, pls - plSame);
    List<KtHls.Variant> vs = KtHls.variants(lists[0] + "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\na\n#EXT-X-STREAM-INF:BANDWIDTH=9,RESOLUTION=1280x720\nb\n", new URL(bases[0]));
    boolean ch = true; for (int want : new int[] { 0, 240, 360, 480, 720, 1080, 4000 }) ch &= KtHls.choose(vs, want) == vs.get(KtHlsRs.chooseRust(vs, want));
    check("the variant chosen alike for every height wanted", ch, "");
    check("an address with a scheme Rust leaves to Java: an error, not a guess", rustUrl("http://h/", "ftp://x/y").equals("error"), rustUrl("http://h/", "ftp://x/y"));
  }
  static String rustUrl(String base, String spec) {
    // (Through the playlist reader: a one-piece media playlist whose piece is `spec`.)
    try { if (spec.contains("\n") || spec.trim().isEmpty() || spec.trim().startsWith("#")) return "error"; KtHls.Playlist p = KtHlsRs.mediaRust("#EXTM3U\n#EXTINF:1,\n" + spec + "\n#EXT-X-ENDLIST\n", new URL(base)); return p.pieces.isEmpty() ? "error" : p.pieces.get(0).url; } catch (Exception e) { return "error"; }
  }

  /* ---------------- the benchmark ---------------- */

  interface Job { void run() throws Exception; }
  /** The median of `n` timed runs after `warm` untimed ones (the JIT given its chance), in microseconds. */
  static double time(int warm, int n, Job j) throws Exception { for (int i = 0; i < warm; i++) j.run(); double[] t = new double[n]; for (int i = 0; i < n; i++) { long a = System.nanoTime(); j.run(); t[i] = (System.nanoTime() - a) / 1000.0; } Arrays.sort(t); return t[n / 2]; }
  static void row(String what, double java, double rust) { System.out.println(String.format(Locale.ROOT, "     %-58s java %10.1f µs   rust %10.1f µs   rust/java %.2f", what, java, rust, rust / java)); }

  static void bench() throws Exception {
    KtCore.shadow = false;
    // The JNI round trip for one 1080 × 2400 RGBA frame (bytes.echo: in once, out once).
    byte[] frame = new byte[1080 * 2400 * 4]; new Random(1).nextBytes(frame);
    double echo = time(5, 21, () -> KtCore.callBytes("bytes.echo", "{}", frame));
    double copy = time(5, 21, () -> frame.clone());
    System.out.println(String.format(Locale.ROOT, "     JNI round trip of a 1080×2400 RGBA frame (%.1f MB): %.0f µs (one Java array copy of it: %.0f µs)", frame.length / 1e6, echo, copy));

    // Tracking a frame pair: the scroll found between two signatures (600 rows) ...
    int W = 1080, H = 8000, VH = 2400; int[] pg = MoTPage.page(W, H, 7);
    short[][] s0 = MoTPage.view(pg, W, H, 2000, VH), s1 = MoTPage.view(pg, W, H, 2137, VH);
    double shJ = time(50, 101, () -> KtScreenMotion.shiftJava(s0, s1, VH)), shR = time(50, 101, () -> KtScreenRs.shiftRaw(s0, s1, VH));
    row("scroll between two frames (signatures, 600 rows)", shJ, shR);
    // ... and a reading paired with what is followed (45 lines on the screen, 60 followed).
    KtScreenTrack base = new KtScreenTrack().viewport(1080, 2400); Random r = new Random(4); List<String> page = new ArrayList<>(); for (int k = 0; k < 60; k++) page.add(sentence(r) + " " + sentence(r));
    List<KtScreenTrack.Obs> o0 = new ArrayList<>(), o1 = new ArrayList<>();
    for (int k = 0; k < 60; k++) o0.add(new KtScreenTrack.Obs(page.get(k), 40, 50 + k * 52, 800, 40, k));
    for (int k = 0; k < 45; k++) o1.add(new KtScreenTrack.Obs(typo(page.get(k + 3), r), 41, 50 + k * 52 + 9, 801, 40, k + 3));
    base.updateJava(o0, null, null);
    double trJ = time(30, 101, () -> { KtScreenTrack t = clone(base); t.updateJava(o1, null, null); });
    double trR = time(30, 101, () -> { KtScreenTrack t = clone(base); if (KtScreenRs.track(t, o1, null, null) == null) throw new Exception("rust failed"); });
    double trC = time(30, 101, () -> clone(base));
    row("a reading paired (45 read, 60 followed)", trJ - trC, trR - trC);
    // Planning: what to translate ahead (120 texts of the app's tree).
    List<KtScreenTrack.Cand> cs = new ArrayList<>(); for (int k = 0; k < 120; k++) { boolean on = k >= 40 && k < 55; cs.add(new KtScreenTrack.Cand(sentence(r), k, on, on ? (k - 40) * 150 : 0, on ? (k - 40) * 150 + 60 : 0)); }
    Set<String> known = new HashSet<>(); java.util.function.Predicate<String> kn = known::contains;
    double ahJ = time(200, 301, () -> KtScreenTrack.aheadJava(cs, 2400, 1, 80, 6000, 2, kn));
    double ahR = time(200, 301, () -> { List<Object> l = new ArrayList<>(); for (KtScreenTrack.Cand c : cs) { String t = c.text.trim(); l.add(Arrays.asList(c.text, (long) c.order, c.on, (long) c.top, (long) c.bottom, KtTranslate.norm(t), kn.test(t))); } KtCore.r("scr.ahead", "cands", l, "vh", 2400L, "dir", 1L, "max", 80L, "maxChars", 6000L, "screensMilli", 2000L); });
    row("planning: translating ahead (120 candidates)", ahJ, ahR);
    // A lettering fit's rules: the kinds of 30 blocks and the markers put back in 30 translations.
    List<String> trs = new ArrayList<>(); for (int k = 0; k < 30; k++) trs.add(sentence(r) + " [[" + (k % 3) + "]] " + sentence(r)); Map<Integer, String> used = new HashMap<>(); used.put(0, "كوروكاوا"); used.put(1, "Item"); used.put(2, "x");
    List<Object> blocks = new ArrayList<>(); for (int k = 0; k < 30; k++) blocks.add(Arrays.asList(sentence(r), (long) (30 + k % 7 * 20), (long) (0xFF000000 | r.nextInt(0xFFFFFF)), null));
    List<Object> u = new ArrayList<>(); for (Map.Entry<Integer, String> e : used.entrySet()) u.add(Arrays.asList((long) e.getKey(), e.getValue()));
    double ltJ = time(300, 501, () -> KtLettering.restoreJava(trs, used));
    double ltR = time(300, 501, () -> KtCore.r("lt.restore", "texts", trs, "used", u));
    row("lettering: markers put back in 30 translations", ltJ, ltR);
    double kR = time(300, 501, () -> KtCore.r("lt.kinds", "blocks", blocks));
    System.out.println(String.format(Locale.ROOT, "     %-58s (Java's kinds need Android's Rect: not timed here)  rust %10.1f µs", "lettering: the kinds of 30 blocks", kR));
    // An inpaint region: a speech balloon of 200 × 80 and a caption of 600 × 300.
    for (int[] wh : new int[][] { { 200, 80 }, { 600, 300 } }) {
      int w = wh[0], h = wh[1]; int[] px = new int[w * h]; for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) px[y * w + x] = ((x / 3) % 3 == 0 && y > 8 && y < h - 8 && x > 8 && x < w - 8) ? 0xFF000000 : 0xFF000000 | (40 + x * 150 / w) << 16 | (60 + y * 100 / h) << 8 | 200;
      double ij = time(10, 31, () -> KtInpaint.cleanJava(px, w, h)), ir = time(10, 31, () -> KtScreenRs.inpaintRaw(px, w, h, false));
      row("inpaint: a " + w + "×" + h + " patch", ij, ir);
      KtCore.r("scr.cacheClear"); KtScreenRs.inpaintRaw(px, w, h, true);
      double ic = time(10, 31, () -> KtScreenRs.inpaintRaw(px, w, h, true));
      row("inpaint: the same " + w + "×" + h + " patch again (Rust's patch cache)", ij, ic);
    }
    // Parsing a 2 000-segment playlist (AES keys every 100, byte ranges every third).
    StringBuilder pl = new StringBuilder("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:100\n");
    for (int k = 0; k < 2000; k++) { if (k % 100 == 0) pl.append("#EXT-X-KEY:METHOD=AES-128,URI=\"../keys/k").append(k / 100).append(".key\",IV=0x").append(String.format("%032x", k)).append('\n'); pl.append("#EXTINF:6.006,\n"); if (k % 3 == 0) pl.append("#EXT-X-BYTERANGE:").append(100000 + k).append('\n'); pl.append("../seg/").append(k).append(".ts?t=abc123&e=99999\n"); }
    pl.append("#EXT-X-ENDLIST\n"); String text = pl.toString(); URL purl = new URL("https://cdn.example/v/1080p/index.m3u8?token=xyz");
    double hj = time(20, 41, () -> KtHls.media(text, purl)), hr = time(20, 41, () -> KtHlsRs.mediaRust(text, purl));
    row("parsing a 2 000-segment media playlist (" + text.length() / 1024 + " KB)", hj, hr);
    check("the benchmark's playlist read alike", KtHlsRs.show(KtHls.media(text, purl)).equals(KtHlsRs.show(KtHlsRs.mediaRust(text, purl))), "");
  }
  static KtScreenTrack clone(KtScreenTrack b) { KtScreenTrack t = new KtScreenTrack().viewport(b.vw, b.vh); for (KtScreenTrack.Item i : b.items) t.items.add(KtScreenRs.copy(i)); t.nextId = b.nextId; return t; }
}
