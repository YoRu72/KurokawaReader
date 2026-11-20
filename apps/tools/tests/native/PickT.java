import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public class PickT {
    static int fails = 0;
    static void ok(String n, boolean c) { System.out.println((c ? "ok   " : "FAIL ") + n); if (!c) fails++; }
    static void w(File f, long mtime) throws Exception { f.getParentFile().mkdirs(); new java.io.FileOutputStream(f).close(); f.setLastModified(mtime); }

    public static void main(String[] a) throws Exception {
        File app = new File("/sdcard/Download/Kurokawa"), phone = new File("/storage/emulated/0"), card = new File("/storage/ABCD-1234");
        List<KtPickLogic.Root> r = KtPickLogic.roots(app, true, phone, Arrays.asList(card, null, phone));
        ok("all-files access: one phone root and one per card, the app's folder not a root of its own", r.size() == 2 && r.get(0).kind == KtPickLogic.PHONE && r.get(1).kind == KtPickLogic.CARD);
        ok("the phone root: «Kurokawa Tools», summary «Internal storage»", KtPickLogic.title(r.get(0), 0, false).equals("Kurokawa Tools") && KtPickLogic.summary(r.get(0), false).equals("Internal storage"));
        ok("in Arabic too", KtPickLogic.title(r.get(0), 0, true).equals("أدوات كوروكاوا") && KtPickLogic.summary(r.get(0), true).equals("التخزين الداخلي"));
        ok("a card: its own name, its path", KtPickLogic.title(r.get(1), 1, false).equals("Kurokawa Tools · ABCD-1234") && KtPickLogic.summary(r.get(1), false).equals("/storage/ABCD-1234"));
        List<KtPickLogic.Root> n = KtPickLogic.roots(app, false, phone, Arrays.asList(card));
        ok("without all-files access: the app's folder alone, «Downloads»", n.size() == 1 && n.get(0).kind == KtPickLogic.APP && KtPickLogic.summary(n.get(0), false).equals("Downloads"));
        ok("no phone storage found: the app's folder", KtPickLogic.roots(app, true, null, null).size() == 1);
        ok("the default applied once only", KtPickLogic.applyDefaultNow(false) && !KtPickLogic.applyDefaultNow(true));

        File d = java.nio.file.Files.createTempDirectory("ktrec").toFile(); long t = 1700000000000L;
        for (int i = 0; i < 80; i++) w(new File(d, "Download/f" + i + ".txt"), t + i * 1000L);
        w(new File(d, "Download/.hidden.txt"), t + 999999L); w(new File(d, "Pictures/a/b/c/d/e/f/g/deep.jpg"), t + 888888L); w(new File(d, "Documents/new.pdf"), t + 500000L);
        List<File> got = KtPickLogic.recents(Arrays.asList(new File(d, "Download"), new File(d, "Documents"), new File(d, "Pictures"), new File(d, "Missing")), 64, 20000, 6);
        ok("at most 64, newest first", got.size() == 64 && got.get(0).getName().equals("new.pdf") && got.get(1).getName().equals("f79.txt"));
        boolean hid = false, deep = false; for (File f : got) { if (f.getName().startsWith(".")) hid = true; if (f.getName().equals("deep.jpg")) deep = true; }
        ok("hidden files left out; a file below the depth bound not reached", !hid && !deep);
        ok("the walk stops at the entries bound", KtPickLogic.recents(Arrays.asList(new File(d, "Download")), 64, 10, 6).size() <= 10);
        ok("no folders: nothing", KtPickLogic.recents(new ArrayList<File>(), 64, 100, 6).isEmpty());
        ok("first run, no other app holds anything on the provider: its own browser", KtPickLogic.firstRunChoice(false, 0) == KtPickLogic.OWN_BROWSER);
        ok("first run, other apps hold links or folder access: storage places kept", KtPickLogic.firstRunChoice(false, 3) == KtPickLogic.STORAGE_PLACES);
        ok("a choice already made: kept, whatever is held", KtPickLogic.firstRunChoice(true, 0) == KtPickLogic.KEEP && KtPickLogic.firstRunChoice(true, 5) == KtPickLogic.KEEP);
        ok("switching to its own browser by hand asks only when something is held", KtPickLogic.askBeforeOwnBrowser(2) && !KtPickLogic.askBeforeOwnBrowser(0));
        // (A symlink inside the folder leading out of it: neither followed nor listed.)
        File out = java.nio.file.Files.createTempDirectory("ktout").toFile(); w(new File(out, "secret.txt"), t + 9999999L); w(new File(out, "sub/s2.txt"), t + 9999998L);
        File base = new File(d, "Linked"); base.mkdirs(); w(new File(base, "mine.txt"), t);
        boolean linked = true; try { java.nio.file.Files.createSymbolicLink(new File(base, "away").toPath(), out.toPath()); java.nio.file.Files.createSymbolicLink(new File(base, "away.txt").toPath(), new File(out, "secret.txt").toPath()); } catch (Exception e) { linked = false; }
        List<File> lk = KtPickLogic.recents(Arrays.asList(base), 64, 1000, 6); boolean leaked = false; for (File f : lk) if (!f.getName().equals("mine.txt")) leaked = true;
        ok("links leading out of the folder: not followed, not listed" + (linked ? "" : " (no symlinks here: not checked)"), !leaked && lk.size() == 1);
        System.out.println(fails == 0 ? "all passed" : fails + " failed"); System.exit(fails == 0 ? 0 : 1);
    }
}
