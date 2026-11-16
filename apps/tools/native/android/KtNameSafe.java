package app.kurokawa.tools;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Archive names made safe — the twin of desktop/archsafe.cjs (the page and the PC) and kt-core's archsafe.rs, all three
 * run on tests/data/namesafe-vectors.tsv: the one table (desktop/namesafe.json) per target («android» for the phone's
 * own storage, «android-fat» for an SD card or a USB stick formatted FAT/exFAT), the names of a whole archive checked
 * together, and which target a folder is on. Pure Java (no Android class), so it is tested on a computer.
 */
public final class KtNameSafe {
    private KtNameSafe() {}
    public static final char REPLACEMENT = '_';
    public static final String TEMP_SUFFIX = ".kt-part";
    public static final String ASIDE_DIR = ".kurokawa-replaced";
    public static final int EXT_KEEP = 9;
    public static final String PORTABLE_ILLEGAL = "\\/:*?\"<>|";
    /** The characters no portable name holds, as a regex class with the control characters (the downloader's and the batch rename's rule). */
    public static final String PORTABLE_RUN = "[\\\\/:*?\"<>|\\u0000-\\u001f]+";
    public static final String[] RESERVED_NAMES = { "CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "COM¹", "COM²", "COM³", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "LPT¹", "LPT²", "LPT³", "CONIN$", "CONOUT$" };
    public static final int[] BIDI = { 1564, 8206, 8207, 8234, 8235, 8236, 8237, 8238, 8294, 8295, 8296, 8297 };

    /** One target's rules (namesafe.json «platforms»). */
    public static final class Platform {
        public final String name, illegal; public final boolean controlRewrite, trailingRewrite, reserved, utf16, foldCase, foldForm; public final int maxName, maxPath, longPath;
        Platform(String name, String illegal, boolean controlRewrite, boolean trailingRewrite, boolean reserved, int maxName, boolean utf16, int maxPath, int longPath, boolean foldCase, boolean foldForm) { this.name = name; this.illegal = illegal; this.controlRewrite = controlRewrite; this.trailingRewrite = trailingRewrite; this.reserved = reserved; this.maxName = maxName; this.utf16 = utf16; this.maxPath = maxPath; this.longPath = longPath; this.foldCase = foldCase; this.foldForm = foldForm; }
    }
    public static final Platform[] PLATFORMS = {
        new Platform("linux", "", false, false, false, 255, false, 4095, 0, false, false),
        new Platform("android", "", false, false, false, 255, false, 4095, 0, false, false),
        new Platform("android-fat", "\\:*?\"<>|", true, true, false, 255, true, 4095, 0, true, false),
        new Platform("macos", "", false, false, false, 255, false, 1023, 0, true, true),
        new Platform("windows", "\\:*?\"<>|", true, true, true, 255, true, 32000, 259, true, false),
    };
    public static Platform platform(String name) { for (Platform p : PLATFORMS) if (p.name.equals(name)) return p; throw new IllegalArgumentException("platform " + name); }

    public static final class Verdict {
        public final String action, out; public final List<String> reasons, flags;
        Verdict(String action, String out, List<String> reasons, List<String> flags) { this.action = action; this.out = out; this.reasons = reasons; this.flags = flags; }
        public boolean refused() { return action.equals("refuse"); }
    }
    static Verdict refuse(String r) { return new Verdict("refuse", "", new ArrayList<>(Arrays.asList(r)), new ArrayList<>()); }
    static void add(List<String> l, String x) { if (!l.contains(x)) l.add(x); }

    /** Length in the target's unit (UTF-8 bytes or UTF-16 code units). */
    public static int measure(String s, boolean utf16) { return utf16 ? s.length() : s.getBytes(java.nio.charset.StandardCharsets.UTF_8).length; }
    /** `name` cut between characters to `max` units, its extension (a last dot within EXT_KEEP of the end) kept. */
    public static String cutName(String name, int max, boolean utf16) {
        if (measure(name, utf16) <= max) return name;
        int dot = name.lastIndexOf('.'); boolean hasExt = dot > 0 && name.length() - dot <= EXT_KEEP; String ext = hasExt ? name.substring(dot) : "", stem = hasExt ? name.substring(0, dot) : name;
        int room = Math.max(1, max - measure(ext, utf16)), n = 0; StringBuilder b = new StringBuilder();
        for (int i = 0; i < stem.length(); ) { int cp = stem.codePointAt(i); int w = measure(new String(Character.toChars(cp)), utf16); if (n + w > room) break; b.appendCodePoint(cp); n += w; i += Character.charCount(cp); }
        return b + ext;
    }
    static boolean control(int c) { return (c >= 1 && c <= 0x1f) || c == 0x7f; }
    static boolean bidi(int c) { for (int b : BIDI) if (b == c) return true; return false; }

    /** One path component for one target (desktop/archsafe.cjs nameRule). */
    public static Verdict nameRule(String comp, Platform p) {
        if (comp.isEmpty()) return refuse("empty");
        if (comp.indexOf('\0') >= 0) return refuse("nul");
        if (comp.equals(".")) return refuse("dot");
        if (comp.equals("..")) return refuse("dotdot");
        if (comp.toLowerCase(java.util.Locale.ROOT).endsWith(TEMP_SUFFIX)) return refuse("reservedSuffix");
        List<String> reasons = new ArrayList<>(), flags = new ArrayList<>(); StringBuilder out = new StringBuilder();
        for (int i = 0; i < comp.length(); ) {
            int c = comp.codePointAt(i); i += Character.charCount(c);
            if (c < 0x10000 && p.illegal.indexOf(c) >= 0) { out.append(REPLACEMENT); add(reasons, c == ':' ? "colon" : "illegal"); continue; }
            if (control(c)) { if (p.controlRewrite) { out.append(REPLACEMENT); add(reasons, "control"); continue; } add(flags, "control"); }
            if (bidi(c)) add(flags, "bidi");
            out.appendCodePoint(c);
        }
        String o = trail(out.toString(), p, reasons);
        if (p.reserved) { String st = o.split("\\.", -1)[0].replaceAll(" +$", "").toUpperCase(java.util.Locale.ROOT); for (String r : RESERVED_NAMES) if (r.equals(st)) { o = REPLACEMENT + o; reasons.add("reserved"); break; } }
        int limit = p.maxName - TEMP_SUFFIX.length();
        if (measure(o, p.utf16) > limit) { o = cutName(o, limit, p.utf16); reasons.add("long"); o = trail(o, p, reasons); }
        if (o.startsWith(" ") || o.endsWith(" ")) flags.add("spaces");
        if (o.startsWith(".")) flags.add("hidden");
        return new Verdict(o.equals(comp) ? "allow" : "rewrite", o, reasons, flags);
    }
    static String trail(String o, Platform p, List<String> reasons) {
        if (!p.trailingRewrite) return o; int k = o.length(); while (k > 0 && (o.charAt(k - 1) == '.' || o.charAt(k - 1) == ' ')) k--;
        if (k == o.length()) return o; StringBuilder b = new StringBuilder(o.substring(0, k)); for (int i = k; i < o.length(); i++) b.append(REPLACEMENT); add(reasons, "trailing"); return b.toString();
    }
    static boolean drive(String s) { return s.length() >= 2 && s.charAt(1) == ':' && ((s.charAt(0) >= 'a' && s.charAt(0) <= 'z') || (s.charAt(0) >= 'A' && s.charAt(0) <= 'Z')); }

    /** A whole relative path for one target (desktop/archsafe.cjs pathRule); `destLen` the folder's length with its separator. */
    public static Verdict pathRule(String path, Platform p, int destLen) {
        if (path.isEmpty()) return refuse("empty");
        if (path.indexOf('\0') >= 0) return refuse("nul");
        if (path.startsWith("/") || path.startsWith("\\")) return refuse("absolute");
        if (drive(path)) return refuse("drive");
        List<String> comps = new ArrayList<>(); for (String c : path.split("/", -1)) if (!c.isEmpty() && !c.equals(".")) comps.add(c);
        if (comps.isEmpty()) return refuse("empty");
        List<String> outs = new ArrayList<>(), reasons = new ArrayList<>(), flags = new ArrayList<>();
        for (String c : comps) { Verdict r = nameRule(c, p); if (r.refused()) return refuse(r.reasons.get(0)); outs.add(r.out); for (String x : r.reasons) add(reasons, x); for (String x : r.flags) add(flags, x); }
        String out = String.join("/", outs); int len = destLen + measure(out, p.utf16);
        if (len > p.maxPath) return refuse("pathLong");
        if (p.longPath > 0 && len > p.longPath) flags.add("longPath");
        return new Verdict(out.equals(String.join("/", comps)) && reasons.isEmpty() ? "allow" : "rewrite", out, reasons, flags);
    }
    /** The key two names share when the target cannot keep them apart. */
    public static String foldKey(String path, Platform p) {
        String k = path; if (p.foldForm) k = java.text.Normalizer.normalize(k, java.text.Normalizer.Form.NFD); if (p.foldCase) k = k.toLowerCase(java.util.Locale.ROOT); return k;
    }

    /** One archive entry as the set check sees it: `link` «sym» or «hard» with its target, else null. */
    public static final class Entry { public final String path, link, target; public final boolean dir; public Entry(String path, boolean dir, String link, String target) { this.path = path; this.dir = dir; this.link = link; this.target = target == null ? "" : target; } }
    public static final class Problem { public final String kind, path; Problem(String kind, String path) { this.kind = kind; this.path = path; } @Override public String toString() { return kind + ":" + path; } }

    /** The names of a whole archive checked together (desktop/archsafe.cjs checkSet), problems in the order found. */
    public static List<Problem> checkSet(List<Entry> entries, Platform p, int destLen) {
        List<Problem> problems = new ArrayList<>(); Map<String, String> byOut = new HashMap<>(), byKey = new HashMap<>(); Set<String> dirKeys = new HashSet<>(), links = new HashSet<>(); List<String[]> files = new ArrayList<>(), outs = new ArrayList<>();
        for (Entry e : entries) {
            Verdict r = pathRule(e.path, p, destLen);
            if (r.refused()) { problems.add(new Problem(r.reasons.get(0), e.path)); continue; }
            outs.add(new String[] { e.path, r.out }); String[] parts = r.out.split("/", -1);
            for (int i = 1; i < parts.length; i++) dirKeys.add(foldKey(String.join("/", Arrays.copyOfRange(parts, 0, i)), p));
            if (e.dir) { dirKeys.add(foldKey(r.out, p)); continue; }
            if ("sym".equals(e.link)) {
                links.add(r.out); String t = e.target; boolean bad = t.isEmpty() || t.startsWith("/") || t.startsWith("\\") || drive(t);
                if (!bad) { List<String> st = new ArrayList<>(Arrays.asList(parts).subList(0, parts.length - 1)); for (String c : t.split("[\\\\/]", -1)) { if (c.isEmpty() || c.equals(".")) continue; if (c.equals("..")) { if (st.isEmpty()) { bad = true; break; } st.remove(st.size() - 1); } else st.add(c); } }
                if (bad) { problems.add(new Problem("linkOutside", e.path)); continue; }
            }
            if ("hard".equals(e.link)) { boolean found = false; for (Entry x : entries) if (x != e && !x.dir && x.path.equals(e.target)) { found = true; break; } if (!found) { problems.add(new Problem("linkOutside", e.path)); continue; } }
            String prev = byOut.get(r.out);
            if (prev != null) { problems.add(new Problem(prev.equals(e.path) ? "duplicate" : "rewriteClash", e.path)); continue; }
            String k = foldKey(r.out, p);
            if (byKey.containsKey(k)) { problems.add(new Problem("caseClash", e.path)); continue; }
            byOut.put(r.out, e.path); byKey.put(k, e.path); if (e.link == null) files.add(new String[] { k, e.path });
        }
        for (String[] f : files) if (dirKeys.contains(f[0])) problems.add(new Problem("fileDir", f[1]));
        for (String[] o : outs) { String[] parts = o[1].split("/", -1); for (int i = 1; i < parts.length; i++) if (links.contains(String.join("/", Arrays.copyOfRange(parts, 0, i)))) { problems.add(new Problem("throughLink", o[0])); break; } }
        return problems;
    }

    /** The target a folder is on: «android-fat» on a removable volume (an SD card or a USB stick — /storage/XXXX-XXXX, /mnt/media_rw/…), formatted FAT/exFAT on nearly every phone; «android» on the phone's own storage. */
    public static String platformOf(String dir) {
        if (dir == null) return "android"; String d = dir.replace('\\', '/');
        if (d.matches("^/(storage|mnt/media_rw)/[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}(/.*)?$")) return "android-fat";
        return "android";
    }
    /** An archive entry name refused for the phone (the old KtArchive.unsafe, now from the table). */
    public static boolean refused(String name, String platform) { return pathRule(name, platform(platform), 0).refused(); }
}
