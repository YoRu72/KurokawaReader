package app.kurokawa.tools;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The floating translator's glossary, the same rules as the page's (src/screen/lettering.ts): the reader's terms kept
 * through any translator — masked as [[n]] and put back as the reader's own translation; told to an AI model. Plain
 * Java (tested outside Android: tests/native/screen.sh); the kinds and fonts are KtLetterFace's.
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

    @SuppressWarnings("unused") private static String lower(String s) { return s.toLowerCase(Locale.ROOT); }
}
