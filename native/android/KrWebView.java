package app.kurokawa.reader;

import android.content.Context;
import android.util.AttributeSet;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import android.webkit.WebView;

/**
 * The reader draws its own selection toolbar, so the system's floating
 * "Copy · Select all · Web search" menu is suppressed here: Chromium populates
 * it in onCreateActionMode/onPrepareActionMode, and an empty menu never shows.
 */
public class KrWebView extends WebView {
    public KrWebView(Context c) { super(c); }
    public KrWebView(Context c, AttributeSet a) { super(c, a); }
    public KrWebView(Context c, AttributeSet a, int s) { super(c, a, s); }

    @Override
    public ActionMode startActionMode(ActionMode.Callback callback) {
        return super.startActionMode(wrap(callback));
    }

    @Override
    public ActionMode startActionMode(ActionMode.Callback callback, int type) {
        return super.startActionMode(wrap(callback), type);
    }

    private static ActionMode.Callback wrap(final ActionMode.Callback inner) {
        return new ActionMode.Callback2() {
            @Override public boolean onCreateActionMode(ActionMode mode, Menu menu) {
                boolean r = inner.onCreateActionMode(mode, menu);
                menu.clear();
                return r;
            }
            @Override public boolean onPrepareActionMode(ActionMode mode, Menu menu) {
                inner.onPrepareActionMode(mode, menu);
                menu.clear();
                return true;
            }
            @Override public boolean onActionItemClicked(ActionMode mode, MenuItem item) { return inner.onActionItemClicked(mode, item); }
            @Override public void onDestroyActionMode(ActionMode mode) { inner.onDestroyActionMode(mode); }
            @Override public void onGetContentRect(ActionMode mode, android.view.View view, android.graphics.Rect outRect) {
                if (inner instanceof ActionMode.Callback2) ((ActionMode.Callback2) inner).onGetContentRect(mode, view, outRect);
                else super.onGetContentRect(mode, view, outRect);
            }
        };
    }
}
