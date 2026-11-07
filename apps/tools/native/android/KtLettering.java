package app.kurokawa.tools;

import android.graphics.Typeface;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The floating translator's lettering, the same rules as the page's (src/screen/lettering.ts): the reader's glossary
 * kept through any translator (terms masked as [[n]] and put back as the reader's own translation; told to an AI
 * model), each block's kind — a balloon's words, a thought, a box, a sound effect, a sign —, and the font file the
 * reader set for that kind.
 */
final class KtLettering {
    static final class Entry { String from, to, kind; Pattern p; }

    /** The glossary's entries for this target language (or any), the longest first. */
    static List<Entry> glossary(Map<String, Object> cfg) {
        List<Entry> out = new ArrayList<>(); if (cfg == null) return out;
        Map<String, Object> g = KtJson.obj(cfg.get("glossary")); if (Boolean.FALSE.equals(g.get("on"))) return out;
        String target = KtJson.str(cfg.get("target"), "");
        for (Object o : KtJson.arr(g.get("entries"))) {
            Map<String, Object> e = KtJson.obj(o); Entry x = new Entry();
            x.from = KtJson.str(e.get("from"), "").trim(); x.to = KtJson.str(e.get("to"), "").trim(); x.kind = KtJson.str(e.get("kind"), "");
            String lang = KtJson.str(e.get("lang"), "");
            if (x.from.isEmpty() || (x.to.isEmpty() && x.kind.isEmpty()) || (!lang.isEmpty() && !lang.equals(target))) continue;
            boolean latin = x.from.matches("[\\p{IsLatin}\\p{N}\\s'’.-]+");
            x.p = Pattern.compile(latin ? "(?<![\\p{L}\\p{N}])" + Pattern.quote(x.from) + "(?![\\p{L}\\p{N}])" : Pattern.quote(x.from), Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
            out.add(x);
        }
        Collections.sort(out, (a, b) -> b.from.length() - a.from.length());
        return out;
    }
    /** The texts with each term masked; `used` gets each marker's translation. */
    static List<String> protect(List<String> texts, List<Entry> g, Map<Integer, String> used) {
        if (g.isEmpty()) return texts; List<String> out = new ArrayList<>();
        for (String t : texts) {
            String s = t;
            for (int i = 0; i < g.size(); i++) { Entry e = g.get(i); if (e.to.isEmpty()) continue; Matcher m = e.p.matcher(s); if (m.find()) { used.put(i, e.to); s = m.replaceAll(Matcher.quoteReplacement("[[" + i + "]]")); } }
            out.add(s);
        }
        return out;
    }
    private static final Pattern MARK = Pattern.compile("\\[\\s*\\[\\s*(\\d+)\\s*\\]\\s*\\]");
    static List<String> restore(List<String> texts, Map<Integer, String> used) {
        if (used.isEmpty()) return texts; List<String> out = new ArrayList<>();
        for (String s : texts) { if (s == null) { out.add(null); continue; } Matcher m = MARK.matcher(s); StringBuffer b = new StringBuffer(); while (m.find()) { String to = used.get(Integer.parseInt(m.group(1))); m.appendReplacement(b, Matcher.quoteReplacement(to == null ? m.group() : to)); } m.appendTail(b); out.add(b.toString()); }
        return out;
    }
    static String prompt(List<Entry> g) {
        StringBuilder b = new StringBuilder(); int n = 0;
        for (Entry e : g) { if (e.to.isEmpty() || n++ >= 200) continue; b.append('\n').append(e.from).append(" → ").append(e.to); }
        return b.length() == 0 ? "" : "\n\nGlossary — always translate these terms exactly this way:" + b;
    }
    /** A key that changes with the glossary (for the translations kept). */
    static String key(List<Entry> g) { StringBuilder b = new StringBuilder(); for (Entry e : g) b.append(e.from).append('\u0001').append(e.to).append('\u0002'); return Integer.toString(b.toString().hashCode(), 36); }

    /** Each block's kind: the glossary first, then how it looks (as the page decides it). */
    static void kinds(List<KtScreenA11y.Block> blocks, List<Entry> g) {
        List<Integer> hs = new ArrayList<>(); for (KtScreenA11y.Block k : blocks) if (k.r.height() > 0) hs.add(k.r.height()); Collections.sort(hs);
        int median = hs.isEmpty() ? 0 : hs.get(hs.size() / 2);
        for (KtScreenA11y.Block k : blocks) {
            String kind = null;
            for (Entry e : g) if (!e.kind.isEmpty() && e.p.matcher(k.text).find()) { kind = e.kind; break; }
            if (kind == null) {
                String s = k.text.trim(); int letters = 0; for (int i = 0; i < s.length(); ) { int cp = s.codePointAt(i); if (Character.isLetter(cp)) letters++; i += Character.charCount(cp); }
                boolean hasBg = k.bg != 0; int r = (k.bg >> 16) & 255, gr = (k.bg >> 8) & 255, bl = k.bg & 255;
                double lum = (0.2126 * r + 0.7152 * gr + 0.0722 * bl) / 255; int mx = Math.max(r, Math.max(gr, bl)), mn = Math.min(r, Math.min(gr, bl)); double sat = mx == 0 ? 0 : (mx - mn) / (double) mx;
                boolean light = !hasBg || (lum > 0.82 && sat < 0.18);
                if (s.matches("(?s)^[(（〔［\\[].*[)）〕］\\]]$")) kind = "thought";
                else if (letters > 0 && letters <= 6 && median > 0 && k.r.height() > median * 1.7 && !light) kind = "sfx";
                else if (hasBg && (lum < 0.55 || sat > 0.25)) kind = "box";
                else kind = "dialogue";
            }
            k.kind = kind;
        }
    }
    private static final Map<String, Typeface> faces = new HashMap<>();
    /** The typeface set for a kind (its own, else the default one); null for the system's. */
    static Typeface face(Map<String, Object> cfg, String kind) {
        Map<String, Object> l = KtJson.obj(cfg == null ? null : cfg.get("letter")); Map<String, Object> f = KtJson.obj(l.get("fonts"));
        String id = !Boolean.FALSE.equals(l.get("kinds")) ? KtJson.str(f.get(kind == null ? "dialogue" : kind), "") : "";
        if (id.isEmpty()) id = KtJson.str(f.get("default"), ""); if (id.isEmpty()) return null;
        for (Object o : KtJson.arr(l.get("lib"))) {
            Map<String, Object> e = KtJson.obj(o); if (!id.equals(KtJson.str(e.get("id"), ""))) continue;
            String path = KtJson.str(e.get("path"), ""); if (path.isEmpty() || !new File(path).isFile()) return null;
            synchronized (faces) { Typeface t = faces.get(path); if (t == null) { try { t = Typeface.createFromFile(path); } catch (Throwable ex) { return null; } faces.put(path, t); } return t; }
        }
        return null;
    }
    static boolean centred(String kind) { return kind == null || "dialogue".equals(kind) || "thought".equals(kind) || "sfx".equals(kind); }
    @SuppressWarnings("unused") private static String lower(String s) { return s.toLowerCase(Locale.ROOT); }
}
