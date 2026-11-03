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

    @Override protected void onServiceConnected() { self = this; }
    @Override public boolean onUnbind(android.content.Intent intent) { self = null; return super.onUnbind(intent); }
    @Override public void onDestroy() { self = null; super.onDestroy(); }
    @Override public void onInterrupt() {}

    @Override public void onAccessibilityEvent(AccessibilityEvent e) {
        if (e == null || e.getPackageName() == null || getPackageName().contentEquals(e.getPackageName())) return;
        KtScreenService s = KtScreenService.self; if (s == null) return;
        int t = e.getEventType();
        if (t == AccessibilityEvent.TYPE_VIEW_SCROLLED) s.screenMoved(true);
        else if (t == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) s.screenMoved(true);
        else if (t == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) s.screenMoved(false);
    }

    /** One piece of text on the screen and where it is. */
    static final class Block { final Rect r; final String text; String tr; int bg = 0, fg = 0; Block(Rect r, String text) { this.r = r; this.text = text; } }

    /** The text of the other apps' windows (not this app's), inside `area` (null: all of the screen). */
    static List<Block> read(Rect area) {
        KtScreenA11y a = self; List<Block> out = new ArrayList<>(); if (a == null) return out;
        List<AccessibilityNodeInfo> roots = new ArrayList<>();
        try { for (AccessibilityWindowInfo w : a.getWindows()) { if (w.getType() == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY) continue; AccessibilityNodeInfo r = w.getRoot(); if (r != null) roots.add(r); } } catch (Throwable ignored) {}
        if (roots.isEmpty()) { AccessibilityNodeInfo r = a.getRootInActiveWindow(); if (r != null) roots.add(r); }
        String mine = a.getPackageName();
        for (AccessibilityNodeInfo r : roots) { if (r.getPackageName() != null && mine.contentEquals(r.getPackageName())) continue; walk(r, area, out, 0); }
        // (A button and the label inside it both say the same words: the smaller one kept.)
        List<Block> keep = new ArrayList<>();
        outer: for (Block b : out) { for (Block c : out) if (c != b && c.text.equals(b.text) && b.r.contains(c.r) && !b.r.equals(c.r)) continue outer; for (Block c : keep) if (c.text.equals(b.text) && c.r.equals(b.r)) continue outer; keep.add(b); }
        return keep;
    }
    private static void walk(AccessibilityNodeInfo n, Rect area, List<Block> out, int depth) {
        if (n == null || depth > 60 || out.size() > 400) return;
        try {
            if (!n.isVisibleToUser()) return;
            Rect r = new Rect(); n.getBoundsInScreen(r);
            if (r.width() <= 2 || r.height() <= 2 || (area != null && !Rect.intersects(r, area))) return;
            CharSequence t = n.getText(); if ((t == null || t.length() == 0) && n.getChildCount() == 0) t = n.getContentDescription();
            boolean password = n.isPassword(); boolean editable = Build.VERSION.SDK_INT >= 18 && n.isEditable();
            if (t != null && !password && !editable) { String s = t.toString().trim(); if (!s.isEmpty() && KtTranslate.hasLetters(s)) { if (area != null) r.intersect(area); out.add(new Block(r, s)); } }
            for (int k = 0; k < n.getChildCount(); k++) walk(n.getChild(k), area, out, depth + 1);
        } catch (Throwable ignored) {}
    }
}
