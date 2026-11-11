package app.kurokawa.tools;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The floating translator's memory of the screen between readings: which piece of text is which from one reading to
 * the next (so its translation and its drawn box are kept, moved, never rebuilt or asked again for a few pixels or a
 * letter read differently), how far the page moved (from frames, or from the app's own scroll reports), when to read
 * again and what to read first, and which text out of view to translate ahead. Plain Java: no Android here, tested
 * off the phone (tests/native/TkT.java, run by screen.sh); KtScreenService does the drawing.
 */
final class KtScreenTrack {
    /* ---------- text, compared loosely (an OCR reading changes a letter, a space, a full stop from frame to frame) ---------- */
    /** Lower case, without spaces, punctuation or symbols: what two readings of the same words share. */
    static String loose(String s) {
        if (s == null) return ""; StringBuilder b = new StringBuilder(s.length());
        for (int k = 0; k < s.length(); k++) { char c = s.charAt(k); if (Character.isLetterOrDigit(c)) b.append(Character.toLowerCase(c)); }
        return b.toString();
    }
    /** How alike two texts are, 0..1 (1 − edit distance / the longer length, on their loose forms; long texts compared on their first 160 letters). */
    static double similar(String a, String b) { return similarLoose(loose(a), loose(b)); }
    static double similarLoose(String x, String y) {
        if (x.equals(y)) return 1; if (x.isEmpty() || y.isEmpty()) return 0;
        int lx = Math.min(x.length(), 160), ly = Math.min(y.length(), 160), longer = Math.max(lx, ly);
        if (Math.abs(lx - ly) > longer / 2) return 1 - (double) Math.abs(lx - ly) / longer;   // (too far apart in length to be the same: no need to count)
        int[] prev = new int[ly + 1], cur = new int[ly + 1]; for (int j = 0; j <= ly; j++) prev[j] = j;
        for (int i = 1; i <= lx; i++) { cur[0] = i; char c = x.charAt(i - 1); for (int j = 1; j <= ly; j++) cur[j] = Math.min(Math.min(cur[j - 1], prev[j]) + 1, prev[j - 1] + (c == y.charAt(j - 1) ? 0 : 1)); int[] t = prev; prev = cur; cur = t; }
        return 1 - (double) prev[ly] / longer;
    }
    /** The numbers of a text in order: «3 likes» and «4 likes» are alike as text but not the same news. (Only numbers
     *  standing alone: a «1» inside a word is OCR taking an «l» for it.) */
    static String digits(String s) {
        StringBuilder b = new StringBuilder(); if (s == null) return ""; int k = 0, n = s.length();
        while (k < n) { if (!Character.isLetterOrDigit(s.charAt(k))) { k++; continue; } int e = k; boolean letters = false; while (e < n && Character.isLetterOrDigit(s.charAt(e))) { if (Character.isLetter(s.charAt(e))) letters = true; e++; } if (!letters) b.append(s, k, e).append(' '); k = e; }
        return b.toString();
    }
    /** Alike enough to be the same words read again (its translation kept, nothing asked). */
    static final double SAME = 0.8;

    /* ---------- the pieces of text followed ---------- */
    /** One piece of text followed on the screen (screen pixels, where it is now — off the screen too, for a page scrolled back). */
    static final class Item {
        final int id; String text, tr, /** the words `tr` translates (when they changed, it is translated again) */ trOf; int x, y, w, h; int miss; boolean clipped; /** the service's own: its drawn view, its latest reading */ Object view, data;
        Item(int id, String text, int x, int y, int w, int h) { this.id = id; this.text = text; this.x = x; this.y = y; this.w = w; this.h = h; }
        public String toString() { return "#" + id + " «" + text + "» " + x + "," + y + " " + w + "×" + h; }
    }
    /** One piece of text in a new reading. */
    static final class Obs { final String text; final int x, y, w, h; final Object data; Obs(String text, int x, int y, int w, int h, Object data) { this.text = text; this.x = x; this.y = y; this.w = w; this.h = h; this.data = data; } }
    /** What a reading changed: pieces new, gone, whose words changed (to translate again), resized, moved a little
     *  (glided) or a lot (put there at once); `of[k]`: the piece the k-th reading is now. */
    static final class Update {
        final List<Item> added = new ArrayList<>(), dropped = new ArrayList<>(), retext = new ArrayList<>(), resized = new ArrayList<>(), glide = new ArrayList<>(), snap = new ArrayList<>(); Item[] of; int feedback;
        boolean changed() { return !added.isEmpty() || !dropped.isEmpty() || !retext.isEmpty() || !resized.isEmpty() || !snap.isEmpty(); }
    }

    /** Within this many pixels a box stays where it is (a reading's box wobbles); beyond `GLIDE` it is put there at once. */
    static final int STILL = 3, GLIDE = 32;
    final List<Item> items = new ArrayList<>(); private int nextId = 1;
    /** Readings a piece may be missed in before it goes (OCR misses a line now and then; the text tree does not). */
    int keepMisses = 1; /** Pieces scrolled out of view kept (for when the page comes back) — by a picture's reading. */ boolean keepOff = true; int cap = 400;
    int vw = 1080, vh = 2400;
    KtScreenTrack viewport(int w, int h) { vw = w; vh = h; return this; }

    /** How far the whole screen has moved in all (a reading taken while it moved is put right by the difference). */
    int movedX, movedY;
    void clear() { items.clear(); }
    /** The page moved by (dx, dy) (content up: dy negative) — inside `area` (left, top, right, bottom) only, when given:
     *  the list that scrolled, not the bar above it. */
    void moved(int dx, int dy, int[] area) {
        if (dx == 0 && dy == 0) return; if (area == null) { movedX += dx; movedY += dy; }
        for (Item i : items) { if (area != null && !(i.x + i.w / 2 >= area[0] && i.x + i.w / 2 < area[2] && i.y + i.h / 2 >= area[1] && i.y + i.h / 2 < area[3])) continue; i.x += dx; i.y += dy; }
    }
    boolean onScreen(Item i) { return i.y + i.h > 0 && i.y < vh && i.x + i.w > 0 && i.x < vw; }

    /** A new reading of `area` (null: all of the screen) put with what is followed. Pieces are paired by their words
     *  first and their place second (after the page's movement is applied, so two alike lines that traded places are
     *  not swapped); our own translations read back from the screen are left out. */
    Update update(List<Obs> obs, int[] area) { return update(obs, area, null); }
    /** `blind`: pieces this reading could not see (under our own box, for a reading that left the boxes showing) — not missed. */
    Update update(List<Obs> obs, int[] area, java.util.function.Predicate<Item> blind) {
        Update u = new Update(); int n = obs.size(); u.of = new Item[n];
        String[] lo = new String[n]; boolean[] own = new boolean[n];
        Map<String, List<Item>> byText = new HashMap<>(); for (Item i : items) byText.computeIfAbsent(loose(i.text), k -> new ArrayList<>()).add(i);
        for (int k = 0; k < n; k++) {
            Obs o = obs.get(k); lo[k] = loose(o.text);
            // (Our own words read back — a translation where its box is, more like it than like the words it replaced —:
            // not the page's text.)
            for (Item i : items) { if (i.tr == null || lo[k].isEmpty() || !near(o, i, 1)) continue; double st = similarLoose(loose(i.tr), lo[k]); if (st >= 0.9 && st > similarLoose(loose(i.text), lo[k]) + 0.1) { own[k] = true; u.feedback++; break; } }
        }
        // Every pair that could be the same piece, best first: words alike, then overlap, then nearness.
        List<double[]> pairs = new ArrayList<>();
        for (int k = 0; k < n; k++) {
            if (own[k]) continue; Obs o = obs.get(k);
            for (int m = 0; m < items.size(); m++) {
                Item i = items.get(m); boolean nearBy = near(o, i, 1.5); String li = loose(i.text);
                boolean exact = li.equals(lo[k]); if (!nearBy && !exact) continue;
                double sim = exact ? 1 : similarLoose(lo[k], li), iou = iou(o, i);
                boolean ok = sim >= SAME || (nearBy && iou >= 0.5 && sim >= 0.3) || containsLoose(li, lo[k]) && nearBy;
                if (!ok) continue;
                double dist = Math.hypot((o.x + o.w / 2.0) - (i.x + i.w / 2.0), (o.y + o.h / 2.0) - (i.y + i.h / 2.0));
                // (The very same characters weigh more than overlap: two lines alike but for a «!» that moved by a line
                // while the movement was not known are not swapped.)
                boolean twin = KtTranslate.norm(o.text).equals(KtTranslate.norm(i.text));
                pairs.add(new double[] { sim * 2 + (twin ? 1.5 : 0) + iou + (nearBy ? 0.5 : 0) - Math.min(1, dist / Math.max(vh, 1)), k, m, sim });
            }
        }
        Collections.sort(pairs, (p, q) -> Double.compare(q[0], p[0]));
        boolean[] usedItem = new boolean[items.size()];
        for (double[] p : pairs) {
            int k = (int) p[1], m = (int) p[2]; if (u.of[k] != null || usedItem[m]) continue;
            usedItem[m] = true; Item i = items.get(m); Obs o = obs.get(k); u.of[k] = i; double sim = p[3];
            boolean clippedNow = clippedAt(o);
            // Words: the same read again keeps its translation; a clipped reading (half the line at the screen's edge)
            // never replaces the whole one; a whole reading of a line first met clipped replaces it.
            boolean same = sim >= SAME && digits(o.text).equals(digits(i.text));
            boolean part = clippedNow && !i.clipped && containsLoose(loose(i.text), lo[k]);
            if (part) { /* kept as it was */ }
            else if (!same || (i.clipped && !clippedNow && lo[k].length() > loose(i.text).length())) { i.text = o.text; u.retext.add(i); i.data = o.data; i.clipped = clippedNow; }
            else i.clipped = clippedNow && i.clipped;
            // Place: a wobble of a few pixels left alone; a small correction glided; a big one put there at once.
            if (!part) {
                // (A box cut by the screen's edge: only its other edge says where the piece is; its size is not news.)
                boolean cutTop = o.y <= 2 && o.h < i.h, cutBottom = o.y + o.h >= vh - 2 && o.h < i.h;
                int oy = cutTop ? o.y + o.h - i.h : o.y;
                int ex = o.x - i.x, ey = oy - i.y, e = Math.max(Math.abs(ex), Math.abs(ey));
                if (e > STILL) { i.x = o.x; i.y = oy; (e <= GLIDE ? u.glide : u.snap).add(i); }
                if (!cutTop && !cutBottom && (Math.abs(o.w - i.w) > Math.max(6, i.w * 0.08) || Math.abs(o.h - i.h) > Math.max(4, i.h * 0.12))) { i.w = o.w; i.h = o.h; if (!u.retext.contains(i)) { u.resized.add(i); i.data = o.data; } }
            }
            i.miss = 0;
        }
        // New pieces.
        for (int k = 0; k < n; k++) { if (own[k] || u.of[k] != null) continue; Obs o = obs.get(k); Item i = new Item(nextId++, o.text, o.x, o.y, o.w, o.h); i.data = o.data; i.clipped = clippedAt(o); items.add(i); u.of[k] = i; u.added.add(i); }
        // Pieces not met again: inside what was read, missed (gone after `keepMisses` readings); out of it, kept.
        for (int m = items.size() - 1; m >= 0; m--) {
            Item i = items.get(m); if (m < usedItem.length && usedItem[m]) continue; if (u.added.contains(i)) continue;
            boolean inRead = area == null ? onScreen(i) : i.x + i.w / 2 >= area[0] && i.x + i.w / 2 < area[2] && i.y + i.h / 2 >= area[1] && i.y + i.h / 2 < area[3];
            if (inRead && blind != null && blind.test(i)) continue;
            if (inRead) { if (++i.miss > keepMisses) { items.remove(m); u.dropped.add(i); } }
            else if (!onScreen(i) && !keepOff) { items.remove(m); u.dropped.add(i); }
        }
        // (Not more than `cap`: the farthest from the screen go first.)
        if (items.size() > cap) {
            List<Item> far = new ArrayList<>(items); Collections.sort(far, (p, q) -> Integer.compare(off(q), off(p)));
            for (int k = 0; items.size() > cap && k < far.size(); k++) { items.remove(far.get(k)); u.dropped.add(far.get(k)); }
        }
        return u;
    }
    private int off(Item i) { return i.y + i.h < 0 ? -(i.y + i.h) : i.y > vh ? i.y - vh : 0; }
    private boolean clippedAt(Obs o) { return o.y <= 2 || o.y + o.h >= vh - 2; }
    private static boolean near(Obs o, Item i, double f) {
        double hh = Math.max(o.h, i.h), ww = Math.max(o.w, i.w);
        return Math.abs((o.y + o.h / 2.0) - (i.y + i.h / 2.0)) <= hh * f + 24 && Math.abs((o.x + o.w / 2.0) - (i.x + i.w / 2.0)) <= ww * 0.5 * f + 48;
    }
    static double iou(Obs o, Item i) {
        int l = Math.max(o.x, i.x), t = Math.max(o.y, i.y), r = Math.min(o.x + o.w, i.x + i.w), b = Math.min(o.y + o.h, i.y + i.h);
        if (r <= l || b <= t) return 0; double in = (double) (r - l) * (b - t); return in / ((double) o.w * o.h + (double) i.w * i.h - in);
    }
    /** `part` is a piece of `whole` (a line cut at the screen's edge): its letters found in order, mostly together. */
    static boolean containsLoose(String whole, String part) { return part.length() >= 3 && whole.length() > part.length() && (whole.contains(part) || similarLoose(whole.substring(0, Math.min(whole.length(), part.length())), part) >= SAME || similarLoose(whole.substring(whole.length() - Math.min(whole.length(), part.length())), part) >= SAME); }

    /* ---------- how far the page moved, from the frames (KtScreenMotion) ---------- */
    /** Frames compared with a key frame, not each with the one before: a slow scroll of a pixel or two a frame adds up
     *  instead of being lost as «standing still» every time; the key is renewed after a quarter screen. */
    static final class Follow {
        private short[][] key; private int keyAt, total; int fails; final int maxPx;
        Follow(int maxPx) { this.maxPx = maxPx; }
        void reset() { key = null; fails = 0; }
        /** How far the content moved up since the last frame (px; 0: still), or KtScreenMotion.NONE (not the same page). */
        int feed(short[][] sig) {
            if (key == null) { key = sig; keyAt = total; return 0; }
            int d = KtScreenMotion.shift(key, sig, maxPx);
            if (d == KtScreenMotion.NONE) { fails++; key = sig; keyAt = total; return KtScreenMotion.NONE; }
            fails = 0; int now = keyAt + d, delta = now - total; total = now;
            if (Math.abs(d) >= maxPx / 4) { key = sig; keyAt = total; }
            return delta;
        }
    }

    /* ---------- the app's own scroll reports (accessibility), with or without a «by how much» ---------- */
    /** A report that says how far is taken as said; one that only says where the list is now is compared with the
     *  last from the same list; the first from a list says nothing (null). */
    static final class Scrolls {
        private final Map<String, int[]> last = new HashMap<>();
        int[] delta(String list, int sx, int sy, int dx, int dy, boolean hasDelta) {
            int[] was = last.put(list, new int[] { sx, sy }); if (last.size() > 64) { last.clear(); last.put(list, new int[] { sx, sy }); }
            if (hasDelta && (dx != 0 || dy != 0)) return new int[] { dx, dy };
            // (No change of position said is no news: a list that does not keep one — RecyclerView — says 0 every time.)
            if (was == null || (sx < 0 && sy < 0) || (sx == was[0] && sy == was[1])) return null;
            return new int[] { sx - was[0], sy - was[1] };
        }
        void clear() { last.clear(); }
    }

    /* ---------- when to read ---------- */
    /** Reads faster while the screen changes, slower (up to `maxMs`) while readings find nothing new; nothing heavy
     *  while the page moves (a fling): the boxes are moved, and the screen read once it settles. */
    static final class Pace {
        final long minMs, maxMs; long gap; long movedAt = Long.MIN_VALUE / 2;
        Pace(long minMs, long maxMs) { this.minMs = minMs; this.maxMs = maxMs; gap = minMs; }
        void moved(long now) { movedAt = now; gap = minMs; }
        boolean settled(long now, long settleMs) { return now - movedAt >= settleMs; }
        /** After a reading: the wait before the next one (when nothing moves). */
        long afterRead(boolean changed) { gap = changed ? minMs : Math.min(maxMs, gap * 2); return gap; }
        /** How often a frame is compared: often while moving (the boxes keep up), less when still. */
        long frameGap(long now) { return now - movedAt < 800 ? 45 : 100; }
    }
    /** The strip of the screen a scroll brought in (left, top, right, bottom), `unread` px of new rows at the bottom
     *  (content moved up) or the top, with `margin` px of overlap — read first, the rest is known. Null: nothing new. */
    static int[] strip(int unread, int vw, int vh, int margin) {
        if (unread == 0) return null; int a = Math.min(vh, Math.abs(unread) + margin);
        return unread > 0 ? new int[] { 0, vh - a, vw, vh } : new int[] { 0, 0, vw, a };
    }

    /* ---------- translating ahead what is not on the screen yet ---------- */
    /** A text in the app's tree: its place in reading order, whether it is on the screen, its top and bottom on the
     *  screen when known (Android gives off-screen nodes clipped bounds in many apps: then top == bottom). */
    static final class Cand { final String text; final int order; final boolean on; final int top, bottom; Cand(String text, int order, boolean on, int top, int bottom) { this.text = text; this.order = order; this.on = on; this.top = top; this.bottom = bottom; } }
    /** The texts to translate ahead, in order: those after the screen's last line in reading order (or before its
     *  first, scrolling up) first, then a few the other way; at most `max` texts and `maxChars` letters, not past
     *  `screens` screens when their place is known; nothing already translated (`known`), nothing twice, none hidden
     *  between the lines on the screen (another tab's page). */
    static List<String> ahead(List<Cand> all, int vh, int dir, int max, int maxChars, double screens, java.util.function.Predicate<String> known) {
        List<String> out = new ArrayList<>(); int first = Integer.MAX_VALUE, last = Integer.MIN_VALUE;
        for (Cand c : all) if (c.on) { first = Math.min(first, c.order); last = Math.max(last, c.order); }
        if (last == Integer.MIN_VALUE || max <= 0) return out;
        List<Cand> below = new ArrayList<>(), above = new ArrayList<>();
        for (Cand c : all) { if (c.on) continue; boolean placed = c.bottom > c.top; if (placed && c.bottom > 0 && c.top < vh) continue; if (c.order > last) below.add(c); else if (c.order < first) above.add(c); }
        Collections.sort(below, (p, q) -> Integer.compare(p.order, q.order)); Collections.sort(above, (p, q) -> Integer.compare(q.order, p.order));
        List<Cand> main = dir < 0 ? above : below, back = dir < 0 ? below : above;
        int mainMax = Math.max(1, max * 3 / 4); int[] chars = { 0 }; Set<String> seen = new HashSet<>();
        take(main, mainMax, maxChars, vh, screens, dir < 0 ? -1 : 1, known, seen, chars, out);
        take(back, max - out.size(), maxChars, vh, 0.5, dir < 0 ? 1 : -1, known, seen, chars, out);
        return out;
    }
    private static void take(List<Cand> l, int max, int maxChars, int vh, double screens, int side, java.util.function.Predicate<String> known, Set<String> seen, int[] chars, List<String> out) {
        int got = 0;
        for (Cand c : l) {
            if (got >= max) return;
            if (c.bottom > c.top && (side > 0 ? c.top - vh : -c.bottom) > screens * vh) return;
            String t = c.text == null ? "" : c.text.trim(); if (t.isEmpty() || t.length() > 1500 || !KtTranslate.hasLetters(t)) continue;
            String key = KtTranslate.norm(t); if (!seen.add(key) || (known != null && known.test(t))) continue;
            if (chars[0] + t.length() > maxChars) return;
            chars[0] += t.length(); out.add(t); got++;
        }
    }
    /** How much may be translated ahead: letters a minute, and a pause after a refusal — so translating ahead never
     *  uses up a paid key's quota or gets the free translators to refuse what is on the screen. */
    static final class Budget {
        final int perMinute; private final ArrayDeque<long[]> used = new ArrayDeque<>(); private long pausedUntil;
        Budget(int perMinute) { this.perMinute = perMinute; }
        /** Paid or limited (a key: DeepL, an AI service) little; the free ones more. */
        static Budget of(String engine) { return new Budget("deepl".equals(engine) || "ai".equals(engine) ? 1500 : 6000); }
        synchronized boolean take(int chars, long now) {
            if (now < pausedUntil) return false;
            while (!used.isEmpty() && now - used.peekFirst()[0] >= 60000) used.pollFirst();
            int sum = 0; for (long[] u : used) sum += (int) u[1];
            if (sum + chars > perMinute) return false;
            used.addLast(new long[] { now, chars }); return true;
        }
        synchronized void refused(long now) { pausedUntil = now + 120000; }
    }
}
