package app.kurokawa.tools;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedList;
import java.util.List;

/**
 * The documents provider's plain logic (no Android): which roots it publishes and what each is called, the recent
 * files for Android's «Recent», and the rule for the first run's default. tests/native/pickprov.sh runs it.
 */
final class KtPickLogic {
    private KtPickLogic() {}

    static final int RECENT_LIMIT = 64, RECENT_VISIT = 20000, RECENT_DEPTH = 6;
    /** Root kinds: the phone's storage, the app's own folder (all-files access missing), a card or USB drive. */
    static final int PHONE = 0, APP = 1, CARD = 2;

    static final class Root { final File dir; final int kind; Root(File dir, int kind) { this.dir = dir; this.kind = kind; } }

    /** The roots: with all-files access ONE for the phone's storage (the app's own folder lies inside it) plus one per
     *  card; without it, the app's own folder alone. */
    static List<Root> roots(File app, boolean allFiles, File phone, List<File> cards) {
        List<Root> out = new ArrayList<>();
        if (!allFiles || phone == null) { if (app != null) out.add(new Root(app, APP)); return out; }
        out.add(new Root(phone, PHONE));
        if (cards != null) for (File c : cards) if (c != null && !c.equals(phone)) out.add(new Root(c, CARD));
        return out;
    }
    /** The root's title: «Kurokawa Tools» for the first; a card's own name after it. */
    static String title(Root r, int index, boolean ar) {
        String base = ar ? "أدوات كوروكاوا" : "Kurokawa Tools";
        if (index == 0) return base;
        String n = r.dir.getName(); return base + " · " + (n.isEmpty() ? r.dir.getPath() : n);
    }
    /** The summary under the title: «Internal storage» for the phone, «Downloads» for the app's folder, the path for a card. */
    static String summary(Root r, boolean ar) {
        if (r.kind == PHONE) return ar ? "التخزين الداخلي" : "Internal storage";
        if (r.kind == APP) return ar ? "التنزيلات" : "Downloads";
        return r.dir.getAbsolutePath();
    }

    /** The newest files under the folders given (not hidden ones): at most `limit`, newest first; the walk stops at
     *  `visit` entries seen and goes `depth` folders down. */
    static List<File> recents(List<File> bases, int limit, int visit, int depth) {
        final List<File> found = new ArrayList<>(); int seen = 0;
        LinkedList<Object[]> q = new LinkedList<>();
        for (File b : bases) if (b != null) q.add(new Object[] { b, 0 });
        while (!q.isEmpty() && seen < visit) {
            Object[] it = q.removeFirst(); File d = (File) it[0]; int lv = (Integer) it[1];
            File[] kids = d.listFiles(); if (kids == null) continue;
            for (File f : kids) {
                if (++seen > visit) break;
                if (f.getName().startsWith(".")) continue;
                if (f.isDirectory()) { if (lv < depth) q.add(new Object[] { f, lv + 1 }); }
                else found.add(f);
            }
        }
        Collections.sort(found, new Comparator<File>() { @Override public int compare(File a, File b) { return Long.compare(b.lastModified(), a.lastModified()); } });
        return found.size() > limit ? new ArrayList<>(found.subList(0, limit)) : found;
    }

    /** First run after the update: the default («its own browser», the provider off) is applied once; a choice made
     *  since is never overridden. */
    static boolean applyDefaultNow(boolean alreadyApplied) { return !alreadyApplied; }
}
