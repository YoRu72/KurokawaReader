package app.kurokawa.tools;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Rect;
import android.os.Build;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.util.ArrayList;
import java.util.List;

/**
 * The screen translator's way of reading text without a picture: what the other app shows, read from Android's
 * accessibility tree — exact words, where they are, in any script, no OCR model and no screen capture. It also
 * says when the screen scrolled or changed, so the translations follow while reading («auto»). Nothing is read
 * unless the floating translator asks, and nothing leaves the phone except the words sent to the translator.
 */
public class KtScreenA11y extends AccessibilityService {
    static volatile KtScreenA11y self;
    private static Boolean declaredCache;
    /** Whether this build declares the service at all (the «-a11y» build does; the ordinary one reads a picture instead). */
    static boolean declared(android.content.Context c) {
        Boolean d = declaredCache; if (d != null) return d;
        try { c.getPackageManager().getServiceInfo(new android.content.ComponentName(c, KtScreenA11y.class), android.content.pm.PackageManager.MATCH_DISABLED_COMPONENTS); d = true; } catch (Throwable e) { d = false; }
        declaredCache = d; return d;
    }

    @Override protected void onServiceConnected() { self = this; }
    @Override public boolean onUnbind(android.content.Intent intent) { self = null; return super.onUnbind(intent); }
    @Override public void onDestroy() { self = null; super.onDestroy(); }
    @Override public void onInterrupt() {}

    @Override public void onAccessibilityEvent(AccessibilityEvent e) {
        if (e == null || e.getPackageName() == null || getPackageName().contentEquals(e.getPackageName())) return;
        KtScreenService s = KtScreenService.self; if (s == null) return;
        int t = e.getEventType();
        // (How far it scrolled, when the app says — most lists do —, else from where the list says it is now (a web
        // page, a ScrollView): the translations in that list moved with it at once, not the bar above it.)
        if (t == AccessibilityEvent.TYPE_VIEW_SCROLLED) {
            boolean said = Build.VERSION.SDK_INT >= 28;
            int[] d = scrolls.delta(e.getWindowId() + "/" + e.getClassName(), e.getScrollX(), e.getScrollY(), said ? e.getScrollDeltaX() : 0, said ? e.getScrollDeltaY() : 0, said);
            int[] area = null; try { AccessibilityNodeInfo src = e.getSource(); if (src != null) { Rect b = new Rect(); src.getBoundsInScreen(b); if (b.width() > 0 && b.height() > 0) area = new int[] { b.left, b.top, b.right, b.bottom }; } } catch (Throwable ignored) {}
            s.screenMoved(true, d, area);
        }
        else if (t == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) { scrolls.clear(); s.screenMoved(true, null, null); }
        else if (t == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) s.screenMoved(false, null, null);
    }
    private static final KtScreenTrack.Scrolls scrolls = new KtScreenTrack.Scrolls();
    /** Where the keyboard covers the screen (from the last reading): no translation drawn there. */
    static volatile Rect[] covered = new Rect[0];

    /** One piece of text on the screen and where it is. */
    static final class Block { final Rect r; final String text; String tr; String kind; int bg = 0, fg = 0; /** the picture behind the words with the words taken off (KtInpaint), the block's size with `pad` all round */ int[] patch; int pw, ph, pad; /** where it is on the page (screen y when read, plus how far the page had moved) */ int y; Block(Rect r, String text) { this.r = r; this.text = text; } }

    /** The text of the other apps' windows (not this app's, not the keyboard's), inside `area` (null: all of the
     *  screen). `ahead` (null: not wanted): every text of the tree in reading order — those on the screen, and those
     *  the app keeps out of view (a web page's or a long page's text below, a list's next rows), for translating ahead. */
    static List<Block> read(Rect area) { return read(area, null); }
    static List<Block> read(Rect area, List<KtScreenTrack.Cand> ahead) {
        KtScreenA11y a = self; List<Block> out = new ArrayList<>(); if (a == null) return out;
        List<AccessibilityNodeInfo> roots = new ArrayList<>(); List<Rect> keys = new ArrayList<>();
        try { for (AccessibilityWindowInfo w : a.getWindows()) {
            if (w.getType() == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY) continue;
            // (The keyboard: its keys are not the page's text, and what it covers is not shown.)
            if (w.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) { Rect b = new Rect(); w.getBoundsInScreen(b); if (!b.isEmpty()) keys.add(b); continue; }
            AccessibilityNodeInfo r = w.getRoot(); if (r != null) roots.add(r); } } catch (Throwable ignored) {}
        if (roots.isEmpty()) { AccessibilityNodeInfo r = a.getRootInActiveWindow(); if (r != null) roots.add(r); }
        covered = keys.toArray(new Rect[0]);
        String mine = a.getPackageName(); int[] budget = { 2500, 0 };
        for (AccessibilityNodeInfo r : roots) { if (r.getPackageName() != null && mine.contentEquals(r.getPackageName())) continue; walk(r, area, out, 0, ahead, budget); }
        if (!keys.isEmpty()) for (int k = out.size() - 1; k >= 0; k--) { Rect r = out.get(k).r; for (Rect c : keys) if (Rect.intersects(r, c)) { if (r.top >= c.top - 4) { out.remove(k); break; } r.bottom = Math.min(r.bottom, c.top); } }
        // (A button and the label inside it both say the same words: the smaller one kept.)
        List<Block> keep = new ArrayList<>();
        outer: for (Block b : out) { for (Block c : out) if (c != b && c.text.equals(b.text) && b.r.contains(c.r) && !b.r.equals(c.r)) continue outer; for (Block c : keep) if (c.text.equals(b.text) && c.r.equals(b.r)) continue outer; keep.add(b); }
        return keep;
    }
    /** (`budget`: nodes left to visit out of view — each a call into the other app —, and letters gathered ahead;
     *  so a huge web page is never walked whole.) */
    private static void walk(AccessibilityNodeInfo n, Rect area, List<Block> out, int depth, List<KtScreenTrack.Cand> ahead, int[] budget) {
        if (n == null || depth > 60 || out.size() > 400) return;
        try {
            boolean on = n.isVisibleToUser();
            if (!on && (ahead == null || budget[0]-- <= 0 || ahead.size() >= 400 || budget[1] > 20000)) return;
            Rect r = new Rect(); n.getBoundsInScreen(r);
            if (on && (r.width() <= 2 || r.height() <= 2 || (area != null && !Rect.intersects(r, area)))) return;
            CharSequence t = n.getText(); if ((t == null || t.length() == 0) && n.getChildCount() == 0) t = n.getContentDescription();
            boolean password = n.isPassword(); boolean editable = Build.VERSION.SDK_INT >= 18 && n.isEditable();
            if (t != null && !password && !editable) { String s = t.toString().trim(); if (!s.isEmpty() && KtTranslate.hasLetters(s)) {
                if (ahead != null) { ahead.add(new KtScreenTrack.Cand(s, ahead.size(), on, r.top, r.bottom)); if (!on) budget[1] += s.length(); }
                if (on) { if (area != null) r.intersect(area); out.add(new Block(r, s)); } } }
            for (int k = 0; k < n.getChildCount(); k++) walk(n.getChild(k), area, out, depth + 1, ahead, budget);
        } catch (Throwable ignored) {}
    }
}
