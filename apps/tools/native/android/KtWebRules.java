package app.kurokawa.tools;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The app's browser's plain rules (no Android): what is typed in its address bar becomes. The same rule as the page's
 * (src/browser.ts addressOf) and the computer's bar (browser.rs INIT_JS addr); tests/browsewalk.cjs runs all three on
 * one table (this one with javac). An address with its scheme as it is; a local name or number (localhost,
 * 192.168.1.5:8080) on plain http, as local servers are; a name with a dot in any script, a port allowed
 * (example.org:8443, a non-Latin name) on https; anything else — words, a space — a web search on `search`.
 */
final class KtWebRules {
    private KtWebRules() {}

    private static final Pattern SCHEME = Pattern.compile("(?i)^(https?|magnet):.*", Pattern.DOTALL);
    private static final Pattern LOCAL = Pattern.compile("(?i)^(localhost|\\d{1,3}(\\.\\d{1,3}){3}|\\[[0-9a-f:.]+\\])(:\\d{1,5})?$");
    private static final Pattern NAME = Pattern.compile("^(?:[\\p{L}\\p{N}-]+\\.)+([\\p{L}\\p{N}-]{2,})(?::\\d{1,5})?$");
    private static final Pattern LETTER = Pattern.compile("\\p{L}");

    /** The address for `text`, or "" for nothing typed. */
    static String addressOf(String text, String search) {
        String t = text == null ? "" : text.trim(); if (t.isEmpty()) return "";
        if (SCHEME.matcher(t).matches()) return t;
        if (!t.matches("(?s).*\\s.*")) {
            String host = t.split("[/?#]", 2)[0];
            if (LOCAL.matcher(host).matches()) return "http://" + t;
            Matcher m = NAME.matcher(host); if (m.matches() && LETTER.matcher(m.group(1)).find()) return "https://" + t;
        }
        try { return search + java.net.URLEncoder.encode(t, "UTF-8").replace("+", "%20"); } catch (Exception e) { return search; }
    }
}
