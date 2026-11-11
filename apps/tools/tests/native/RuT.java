// The download queue's decisions (KtDlRules): which name a download takes in a folder where other downloads are under
// way, whether a hold (Wi-Fi only on mobile data, a low battery) keeps it from starting, what a host is asked next
// time after a download, and whether one resumed while it was still stopping starts again. Run by dlrules.sh.
import java.io.*; import java.util.*;
public class RuT {
  static boolean ok = true;
  static void eq(String what, Object got, Object want) { boolean same = Objects.equals(got, want); if (!same) ok = false; System.out.println((same ? "ok   " : "FAIL ") + what + ": " + got + (same ? "" : " (wanted " + want + ")")); }
  public static void main(String[] a) throws Exception {
    File dir = new File("rules"); dir.mkdirs(); for (File f : dir.listFiles()) f.delete();
    Set<String> none = new HashSet<>();
    // Names. Two downloads of «ep.mkv» into one folder, neither begun: the second waits on the first's name, so it takes «ep (2).mkv».
    Set<String> first = new HashSet<>(Collections.singleton("ep.mkv"));
    eq("two of one name, nothing on disk yet", KtDlRules.pickName(dir, "ep.mkv", false, "rename", first), "ep (2).mkv");
    eq("a third, with (2) taken too", KtDlRules.pickName(dir, "ep.mkv", false, "rename", new HashSet<>(Arrays.asList("ep.mkv", "ep (2).mkv"))), "ep (3).mkv");
    eq("the other's name in another case (storage that ignores case)", KtDlRules.pickName(dir, "EP.mkv", false, "rename", first), "EP (2).mkv");
    eq("Google Drive's two files of one name, conflict «overwrite»: still not one .part", KtDlRules.pickName(dir, "ep.mkv", false, "overwrite", first), "ep (2).mkv");
    eq("conflict «skip»: a download under way is not a file there", KtDlRules.pickName(dir, "ep.mkv", false, "skip", first), "ep (2).mkv");
    eq("this one begun already (its record kept): its name kept", KtDlRules.pickName(dir, "ep.mkv", true, "rename", first), "ep.mkv");
    eq("alone: its name", KtDlRules.pickName(dir, "ep.mkv", false, "rename", none), "ep.mkv");
    new FileOutputStream(new File(dir, "ep.mkv")).close();
    eq("the file there (done before), rename", KtDlRules.pickName(dir, "ep.mkv", false, "rename", none), "ep (2).mkv");
    eq("the file there, skip", KtDlRules.pickName(dir, "ep.mkv", false, "skip", none), null);
    eq("the file there, overwrite", KtDlRules.pickName(dir, "ep.mkv", false, "overwrite", none), "ep.mkv");
    new FileOutputStream(new File(dir, "ep.mkv.part")).close();
    eq("the file there and a .part of no other download (this one's, record lost): kept, to be found by its bytes", KtDlRules.pickName(dir, "ep.mkv", false, "rename", none), "ep.mkv");
    new File(dir, "ep.mkv").delete();
    eq("only another download's .part there", KtDlRules.pickName(dir, "ep.mkv", false, "rename", first), "ep (2).mkv");
    eq("a free name passes over files and .parts and names taken", KtDlRules.freeName(dir, "ep.mkv", new HashSet<>(Collections.singleton("ep (2).mkv"))), "ep (3).mkv");
    // Holds.
    List<String> metered = Collections.singletonList("metered"), battery = Collections.singletonList("battery"), both = Arrays.asList("battery", "metered");
    eq("mobile data, the Wi-Fi only switch on", KtDlRules.holdOf(metered, true, false, false), "metered");
    eq("mobile data, this download marked Wi-Fi only", KtDlRules.holdOf(metered, false, true, false), "metered");
    eq("mobile data, neither", KtDlRules.holdOf(metered, false, false, false), null);
    eq("a low battery holds every download", KtDlRules.holdOf(battery, false, false, false), "battery");
    eq("both, not Wi-Fi only: the battery", KtDlRules.holdOf(both, false, false, false), "battery");
    eq("no hold", KtDlRules.holdOf(Collections.<String>emptyList(), true, true, false), null);
    eq("«download now» asked by the user: not held", KtDlRules.holdOf(both, true, true, true), null);
    // A host's limit after a download.
    eq("refused: what it took", KtDlRules.nextHostLimit(null, 8, true, 3), 3);
    eq("refused again with a limit", KtDlRules.nextHostLimit(6, 8, true, 2), 2);
    eq("no limit known, not refused: none kept", KtDlRules.nextHostLimit(null, 8, false, 8), null);
    eq("a limit of 1, every connection used, not refused: doubles", KtDlRules.nextHostLimit(1, 24, false, 1), 2);
    eq("4 → 8", KtDlRules.nextHostLimit(4, 24, false, 4), 8);
    eq("16 → 24 (no more than asked)", KtDlRules.nextHostLimit(16, 24, false, 16), 24);
    eq("fewer used than allowed (a small file): kept", KtDlRules.nextHostLimit(4, 24, false, 2), 4);
    int lim = 1, n = 0; while (lim < 24 && n < 50) { lim = KtDlRules.nextHostLimit(lim, 24, false, lim); n++; }
    eq("downloads from 1 back to 24", n, 5);
    // Resumed while it was still stopping.
    eq("resumed while stopping", KtDlRules.restartAfterStop(true, false, "queued"), true);
    eq("resumed, then paused again before it stopped", KtDlRules.restartAfterStop(true, true, "paused"), false);
    eq("not resumed", KtDlRules.restartAfterStop(false, false, "paused"), false);
    eq("removed meanwhile", KtDlRules.restartAfterStop(true, false, "removed"), false);
    System.out.println(ok ? "dlrules: all passed" : "dlrules: FAILED"); System.exit(ok ? 0 : 1);
  }
}
