import java.nio.file.*; import java.util.*;
/** KtNameSafe on the shared vectors (tests/data/namesafe-vectors.tsv): the same answers as archsafe.cjs and archsafe.rs. */
public class NameSafeT {
  static String un(String s) { StringBuilder o = new StringBuilder(); for (int i = 0; i < s.length(); ) { char c = s.charAt(i); if (c == '\\' && i + 1 < s.length() && s.charAt(i + 1) == '\\') { o.append('\\'); i += 2; continue; } if (c == '\\' && i + 2 < s.length() && s.charAt(i + 1) == 'u' && s.charAt(i + 2) == '{') { int e = s.indexOf('}', i); o.appendCodePoint(Integer.parseInt(s.substring(i + 3, e), 16)); i = e + 1; continue; } o.append(c); i++; } return o.toString(); }
  static String j(List<String> l) { return l.isEmpty() ? "-" : String.join(",", l); }
  public static void main(String[] a) throws Exception {
    int n = 0, bad = 0;
    for (String line : Files.readAllLines(Paths.get(a[0]), java.nio.charset.StandardCharsets.UTF_8)) {
      if (line.isEmpty() || line.startsWith("#")) continue; String[] f = line.split("\t", -1); KtNameSafe.Platform p = KtNameSafe.platform(f[1]); n++;
      List<String> got;
      if (f[0].equals("set")) {
        List<KtNameSafe.Entry> es = new ArrayList<>(); for (String x : un(f[2]).split(" \\| ")) { if (x.isEmpty()) continue; String t = x.substring(0, 1), r = x.substring(2); if (t.equals("d")) es.add(new KtNameSafe.Entry(r, true, null, null)); else if (t.equals("s") || t.equals("h")) { int g = r.indexOf('>'); es.add(new KtNameSafe.Entry(r.substring(0, g), false, t.equals("s") ? "sym" : "hard", r.substring(g + 1))); } else es.add(new KtNameSafe.Entry(r, false, null, null)); }
        List<String> ps = new ArrayList<>(); for (KtNameSafe.Problem x : KtNameSafe.checkSet(es, p, 0)) ps.add(x.toString()); Collections.sort(ps);
        got = Arrays.asList(j(ps), "-", "-", "-");
      } else {
        KtNameSafe.Verdict r = f[0].equals("name") ? KtNameSafe.nameRule(un(f[2]), p) : KtNameSafe.pathRule(un(f[2]), p, 0);
        got = Arrays.asList(r.action, r.refused() ? "-" : r.out, j(r.reasons), j(r.flags));
      }
      List<String> want = Arrays.asList(f[0].equals("set") ? un(f[3]) : f[3], un(f[4]), f[5], f[6]);
      if (!got.equals(want)) { bad++; System.out.println("MISMATCH " + f[0] + " " + f[1] + " " + f[2] + "\n  want " + want + "\n  got  " + got); }
    }
    // The phone's targets from a folder; the downloader's rule from the same table.
    String[][] where = { { "/storage/emulated/0/Download", "android" }, { "/storage/1A2B-3C4D/Movies", "android-fat" }, { "/mnt/media_rw/ABCD-1234", "android-fat" }, { "/data/user/0/app/files", "android" } };
    for (String[] w : where) if (!KtNameSafe.platformOf(w[0]).equals(w[1])) { bad++; System.out.println("FAIL platformOf " + w[0]); }
    if (!"a b c".equals("a:b?c".replaceAll(KtNameSafe.PORTABLE_RUN, " "))) { bad++; System.out.println("FAIL PORTABLE_RUN"); }
    System.out.println(n + " vectors, " + bad + " bad"); System.out.println(bad == 0 && n > 100 ? "all passed" : "errors"); if (bad > 0 || n <= 100) System.exit(1);
  }
}
