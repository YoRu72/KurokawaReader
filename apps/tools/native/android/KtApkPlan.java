package app.kurokawa.tools;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * What an archive offers to install, read from its list of files (no Android here, so it is tested on its own):
 * a bundle (.apks, .xapk, .apkm) inside it, an app split into APKs lying together in a folder (base.apk and its
 * split_ / config. parts), or single APKs. Each is one «app» to choose, named by a selector — «bundle:path»,
 * «dir:folder/», «apk:path» — and for the chosen one, the parts to install: the base, the feature splits, and the
 * configuration splits for the best processor this device has (other processors' left out).
 */
final class KtApkPlan {
    private KtApkPlan() {}
    static final class Entry { final String path; final long size; Entry(String path, long size) { this.path = path; this.size = size; } }
    static final class App { final String select, label; final long size; App(String select, String label, long size) { this.select = select; this.label = label; this.size = size; } }

    static String lower(String s) { return s.toLowerCase(Locale.ROOT); }
    static boolean isApk(String p) { return lower(p).endsWith(".apk"); }
    static boolean isBundle(String p) { String n = lower(p); return n.endsWith(".apks") || n.endsWith(".xapk") || n.endsWith(".apkm"); }
    static String name(String p) { int k = p.lastIndexOf('/'); return k >= 0 ? p.substring(k + 1) : p; }
    static String folder(String p) { int k = p.lastIndexOf('/'); return k >= 0 ? p.substring(0, k + 1) : ""; }
    /** A part of a split app (not an app of its own): base.apk, split_*.apk, config.*.apk, *.config.*.apk. */
    static boolean isSplitPart(String p) { String n = lower(name(p)); return n.equals("base.apk") || n.startsWith("split_") || n.startsWith("config.") || n.contains(".config."); }

    /** The apps an archive's files offer, in the archive's order. */
    static List<App> apps(List<Entry> entries) {
        List<App> out = new ArrayList<>(); Map<String, long[]> splitDirs = new LinkedHashMap<>();
        for (Entry e : entries) if (isApk(e.path) && isSplitPart(e.path)) { long[] s = splitDirs.computeIfAbsent(folder(e.path), k -> new long[1]); s[0] += Math.max(0, e.size); }
        java.util.Set<String> added = new java.util.HashSet<>();
        for (Entry e : entries) {
            if (isBundle(e.path)) out.add(new App("bundle:" + e.path, name(e.path), e.size));
            else if (isApk(e.path)) {
                String dir = folder(e.path);
                if (splitDirs.containsKey(dir) && hasBase(entries, dir)) { if (added.add(dir)) out.add(new App("dir:" + dir, dir.isEmpty() ? name(e.path) : name(dir.substring(0, dir.length() - 1)), splitDirs.get(dir)[0])); }
                else out.add(new App("apk:" + e.path, name(e.path), e.size));
            }
        }
        return out;
    }
    static boolean hasBase(List<Entry> entries, String dir) { for (Entry e : entries) if (folder(e.path).equals(dir) && isApk(e.path) && (lower(name(e.path)).equals("base.apk") || !isSplitPart(e.path))) return true; return false; }

    static final String[] ABIS = { "arm64_v8a", "armeabi_v7a", "x86_64", "x86", "armeabi", "mips64", "mips" };
    static String abiOf(String path) { String n = lower(name(path)); for (String k : ABIS) if (n.contains("." + k + ".") || n.endsWith("_" + k + ".apk") || n.endsWith("-" + k + ".apk") || n.equals(k + ".apk")) return k; return null; }
    /** The APKs to install of a split app: all of them, but of the native-code splits only the best processor's. */
    static List<Entry> parts(List<Entry> apks, String[] deviceAbis) {
        String best = null;
        outer: for (String a : deviceAbis) { String k = lower(a.replace('-', '_')); for (Entry e : apks) if (k.equals(abiOf(e.path))) { best = k; break outer; } }
        List<Entry> out = new ArrayList<>();
        for (Entry e : apks) { String abi = abiOf(e.path); if (abi != null && best != null && !abi.equals(best)) continue; out.add(e); }
        return out;
    }
    /** The base APK among the parts: base.apk, else the one that is not a split part, else the largest. */
    static Entry base(List<Entry> parts) {
        for (Entry e : parts) if (lower(name(e.path)).equals("base.apk")) return e;
        for (Entry e : parts) if (!isSplitPart(e.path)) return e;
        Entry big = null; for (Entry e : parts) if (big == null || e.size > big.size) big = e; return big;
    }
    /** The APKs a selector points at, among the archive's files (a bundle's own come from inside it). */
    static List<Entry> apksOf(List<Entry> entries, String select) {
        List<Entry> out = new ArrayList<>();
        if (select.startsWith("apk:")) { for (Entry e : entries) if (e.path.equals(select.substring(4))) out.add(e); }
        else if (select.startsWith("dir:")) { String d = select.substring(4); for (Entry e : entries) if (isApk(e.path) && folder(e.path).equals(d)) out.add(e); }
        else for (Entry e : entries) if (isApk(e.path) && !e.path.contains("/")) out.add(e);   // (a bundle's list: its top-level APKs)
        if (out.isEmpty() && !select.startsWith("apk:")) for (Entry e : entries) if (isApk(e.path)) out.add(e);
        return out;
    }

    /** What a part of a split app is: the base, a processor's native code, a screen density's pictures, a
     *  language's texts, or a feature of its own. */
    static String kindOf(String path) {
        String n = lower(name(path)); if (n.equals("base.apk") || !isSplitPart(path)) return "base";
        if (abiOf(path) != null) return "abi";
        String q = n.replaceAll("\\.apk$", "").replaceAll("^(split_)?config\\.", "").replaceAll("^.*\\.config\\.", "");
        if (q.matches("(l|m|tv|h|xh|xxh|xxxh|no|any)dpi")) return "density";
        if (q.matches("[a-z]{2,3}(_[a-z0-9]{2,4})?")) return "lang";
        return "feature";
    }
    /** Whether a part may be left out by choice (languages and densities; the base, code and features must go). */
    static boolean optional(String path) { String k = kindOf(path); return k.equals("lang") || k.equals("density"); }
}
