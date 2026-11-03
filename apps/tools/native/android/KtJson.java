package app.kurokawa.tools;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A small JSON reader and writer in plain Java (maps, lists, strings, numbers, booleans, null), so the screen
 * translator's requests and answers are read and tested off Android (tests/native/screen.sh).
 */
final class KtJson {
    private final String s; private int i;
    private KtJson(String s) { this.s = s; }

    static Object parse(String text) { KtJson p = new KtJson(text); p.ws(); Object v = p.value(); return v; }

    private void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
    private Object value() {
        ws(); if (i >= s.length()) throw new IllegalArgumentException("end");
        char c = s.charAt(i);
        if (c == '{') { i++; Map<String, Object> m = new LinkedHashMap<>(); ws(); if (peek('}')) { i++; return m; } for (;;) { ws(); String k = str(); ws(); expect(':'); m.put(k, value()); ws(); if (peek(',')) { i++; continue; } expect('}'); return m; } }
        if (c == '[') { i++; List<Object> l = new ArrayList<>(); ws(); if (peek(']')) { i++; return l; } for (;;) { l.add(value()); ws(); if (peek(',')) { i++; continue; } expect(']'); return l; } }
        if (c == '"') return str();
        if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
        if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
        if (s.startsWith("null", i)) { i += 4; return null; }
        int a = i; while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
        if (a == i) throw new IllegalArgumentException("at " + i);
        String n = s.substring(a, i); if (n.contains(".") || n.contains("e") || n.contains("E")) return Double.parseDouble(n); long v = Long.parseLong(n); return v;
    }
    private boolean peek(char c) { return i < s.length() && s.charAt(i) == c; }
    private void expect(char c) { if (!peek(c)) throw new IllegalArgumentException("expected " + c + " at " + i); i++; }
    private String str() {
        expect('"'); StringBuilder b = new StringBuilder();
        while (i < s.length()) {
            char c = s.charAt(i++);
            if (c == '"') return b.toString();
            if (c != '\\') { b.append(c); continue; }
            char e = s.charAt(i++);
            switch (e) { case 'n': b.append('\n'); break; case 't': b.append('\t'); break; case 'r': b.append('\r'); break; case 'b': b.append('\b'); break; case 'f': b.append('\f'); break;
                case 'u': b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break; default: b.append(e); }
        }
        throw new IllegalArgumentException("unterminated string");
    }

    static String write(Object v) { StringBuilder b = new StringBuilder(); write(b, v); return b.toString(); }
    @SuppressWarnings("unchecked")
    private static void write(StringBuilder b, Object v) {
        if (v == null) b.append("null");
        else if (v instanceof String) quote(b, (String) v);
        else if (v instanceof Number || v instanceof Boolean) b.append(v);
        else if (v instanceof Map) { b.append('{'); boolean first = true; for (Map.Entry<String, Object> e : ((Map<String, Object>) v).entrySet()) { if (!first) b.append(','); first = false; quote(b, e.getKey()); b.append(':'); write(b, e.getValue()); } b.append('}'); }
        else if (v instanceof List) { b.append('['); boolean first = true; for (Object x : (List<Object>) v) { if (!first) b.append(','); first = false; write(b, x); } b.append(']'); }
        else quote(b, String.valueOf(v));
    }
    private static void quote(StringBuilder b, String s) {
        b.append('"');
        for (int k = 0; k < s.length(); k++) { char c = s.charAt(k); switch (c) { case '"': b.append("\\\""); break; case '\\': b.append("\\\\"); break; case '\n': b.append("\\n"); break; case '\r': b.append("\\r"); break; case '\t': b.append("\\t"); break; default: if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c); } }
        b.append('"');
    }

    /* (Small helpers for reading what came back.) */
    @SuppressWarnings("unchecked") static Map<String, Object> obj(Object v) { return v instanceof Map ? (Map<String, Object>) v : new LinkedHashMap<>(); }
    @SuppressWarnings("unchecked") static List<Object> arr(Object v) { return v instanceof List ? (List<Object>) v : new ArrayList<>(); }
    static String str(Object v, String def) { return v instanceof String ? (String) v : v == null ? def : String.valueOf(v); }
    static Map<String, Object> map(Object... kv) { Map<String, Object> m = new LinkedHashMap<>(); for (int k = 0; k + 1 < kv.length; k += 2) m.put((String) kv[k], kv[k + 1]); return m; }
    static List<Object> list(Object... xs) { List<Object> l = new ArrayList<>(); for (Object x : xs) l.add(x); return l; }
    /** A path into nested maps and lists: "choices.0.message.content". */
    static Object at(Object v, String path) { for (String p : path.split("\\.")) { if (v instanceof Map) v = ((Map<?, ?>) v).get(p); else if (v instanceof List) { try { int n = Integer.parseInt(p); List<?> l = (List<?>) v; v = n < l.size() ? l.get(n) : null; } catch (NumberFormatException e) { return null; } } else return null; } return v; }
    static Iterator<String> keys(Map<String, Object> m) { return m.keySet().iterator(); }
}
