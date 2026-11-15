package app.kurokawa.tools;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The Rust core (libkt_android.so, apps/tools/core/kt-android; docs/RUST-PORT.md §5) as Java sees it: loaded on first
 * use, never required. When the library is absent (a build without it, an ABI it was not built for) or fails to load,
 * {@link #available()} is false and every caller keeps its Java code — nothing here throws an Error at a caller.
 *
 * One native method carries every call: a method name, its arguments as a JSON object, optional bytes; the answer is
 * {"r": …} (JSON) or bytes. Later stages add Rust methods, not JNI signatures (ANDROID-PORT.md).
 *
 * Shadow mode (stage M1): on a debuggable build ({@link #shadow} set by KtPlugin) each rule KtDlRules and KtTranslate
 * decide in Java is also asked of Rust, and a different answer is counted and its first cases kept for the
 * diagnostics. Java's answer is the one used, always, in this stage. Plain Java (no Android class), so the host test
 * (apps/tools/core/kt-android/jvmtest) loads the library built for the computer through this same class.
 */
public final class KtCore {
    private KtCore() {}

    /** The call shape this Java knows (dispatch.rs PROTOCOL); a library answering another is treated as absent. */
    static final long PROTOCOL = 1;

    private static native byte[] nCall(byte[] method, byte[] args, byte[] data);

    /** A call the Rust core answered with an error (or could not be made). */
    public static final class Failure extends Exception { public Failure(String m) { super(m); } }

    /** Where a line for the log goes (KtPlugin points it at android.util.Log; null: nowhere). */
    public static volatile java.util.function.Consumer<String> log;
    /** Shadow mode: set on debuggable builds only (KtPlugin.load); off in released builds. */
    public static volatile boolean shadow;

    private static volatile int state;          // 0: not tried, 1: loaded, -1: absent
    private static volatile String version, whyAbsent;
    private static volatile int methods;

    /** Whether the Rust core is here and answers in this Java's call shape (loads it the first time). */
    public static boolean available() {
        if (state == 0) load();
        return state == 1;
    }
    /** Its version («0.1.0»), or null when absent. */
    public static String version() { return available() ? version : null; }
    /** One line for the diagnostics and the log: «Rust core: 0.1.0» or «Rust core: absent». */
    public static String status() { return available() ? "Rust core: " + version + " (" + methods + " methods)" : "Rust core: absent" + (whyAbsent == null ? "" : " (" + whyAbsent + ")"); }

    private static synchronized void load() {
        if (state != 0) return;
        try {
            // (The host test names the file; on Android the APK's lib/<abi>/ folder is searched.)
            String path = System.getProperty("kt.core.lib");
            if (path != null && !path.isEmpty()) System.load(path); else System.loadLibrary("kt_android");
            Object v = parse(callRaw("core.version", "{}"));
            Map<?, ?> m = v instanceof Map ? (Map<?, ?>) v : null; Object r = m == null ? null : m.get("r");
            Map<?, ?> info = r instanceof Map ? (Map<?, ?>) r : null;
            if (info == null || !Objects.equals(info.get("protocol"), PROTOCOL)) throw new Failure("protocol " + (info == null ? "?" : info.get("protocol")));
            version = String.valueOf(info.get("version"));
            Object ms = info.get("methods"); methods = ms instanceof List ? ((List<?>) ms).size() : 0;
            state = 1;
        } catch (Throwable t) {   // (UnsatisfiedLinkError: no library, or not for this ABI; anything else: a bad one)
            whyAbsent = t.getClass().getSimpleName(); state = -1;
        }
        java.util.function.Consumer<String> l = log; if (l != null) try { l.accept(status()); } catch (Throwable ignored) {}
    }

    /** method + JSON arguments → the JSON answer ({"r": …}). */
    public static String call(String method, String json) throws Failure {
        if (!available()) throw new Failure("absent");
        return callRaw(method, json);
    }
    private static String callRaw(String method, String json) throws Failure {
        return new String(invoke(method, json, null), StandardCharsets.UTF_8);
    }
    /** A bytes method («bytes.…»): the bytes beside the arguments, the bytes back. */
    public static byte[] callBytes(String method, String json, byte[] data) throws Failure {
        if (!available()) throw new Failure("absent");
        return invoke(method, json, data);
    }
    private static byte[] invoke(String method, String json, byte[] data) throws Failure {
        byte[] out;
        try { out = nCall(method.getBytes(StandardCharsets.UTF_8), (json == null ? "{}" : json).getBytes(StandardCharsets.UTF_8), data); }
        catch (Throwable t) { throw new Failure(t.getClass().getSimpleName()); }
        if (out == null || out.length == 0) throw new Failure("no answer");
        if (out[0] != 0) throw new Failure(new String(out, 1, out.length - 1, StandardCharsets.UTF_8));
        byte[] b = new byte[out.length - 1]; System.arraycopy(out, 1, b, 0, b.length); return b;
    }

    /** A method's `r` from name/value pairs: r("core.sum", "a", 2, "b", 40) → 42L. Values: String, Boolean, a whole
     *  number, null, a List or a Map of those; answers come back as String, Boolean, Long, null, List or Map. */
    public static Object r(String method, Object... kv) throws Failure {
        StringBuilder b = new StringBuilder("{");
        for (int k = 0; k + 1 < kv.length; k += 2) { if (k > 0) b.append(','); quote(b, String.valueOf(kv[k])); b.append(':'); write(b, kv[k + 1]); }
        Object v; try { v = parse(call(method, b.append('}').toString())); } catch (IllegalArgumentException e) { throw new Failure("bad answer"); }
        return v instanceof Map ? ((Map<?, ?>) v).get("r") : null;
    }

    /* ---------- shadow mode ---------- */

    private static final AtomicLong shadowCalls = new AtomicLong(), shadowMismatches = new AtomicLong();
    private static final List<String> firstMismatches = new ArrayList<>();
    /** Whether rule calls are to be checked against Rust now (debuggable build, library here). Cheap when off. */
    public static boolean shadowing() { return shadow && available(); }
    /** Asks Rust the same question Java has answered (`javaAnswer`) and records a difference. Never throws. */
    public static void shadow(String method, Object javaAnswer, Object... kv) {
        try {
            shadowCalls.incrementAndGet();
            Object rust; try { rust = r(method, kv); } catch (Failure f) { rust = "error: " + f.getMessage(); }
            boolean alike = same(javaAnswer, rust); countArea(method, alike, "java=" + javaAnswer + " rust=" + rust);   // (per area: the merge)
            if (!alike) {
                shadowMismatches.incrementAndGet();
                synchronized (firstMismatches) { if (firstMismatches.size() < 5) { StringBuilder b = new StringBuilder(); write(b, java.util.Arrays.asList(kv)); firstMismatches.add(method + " " + b + " java=" + javaAnswer + " rust=" + rust); } }
                java.util.function.Consumer<String> l = log; if (l != null) l.accept("Rust core shadow: " + method + " differs (java=" + javaAnswer + ", rust=" + rust + ")");
            }
        } catch (Throwable ignored) {}
    }
    private static boolean same(Object a, Object b) {
        if (a instanceof Number && b instanceof Number) return ((Number) a).longValue() == ((Number) b).longValue();
        return Objects.equals(a, b);
    }
    /** The shadow's figures for the diagnostics: calls, differences, the first few. */
    public static Map<String, Object> shadowReport() {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("on", shadowing()); m.put("calls", shadowCalls.get()); m.put("mismatches", shadowMismatches.get());
        synchronized (firstMismatches) { m.put("first", new ArrayList<>(firstMismatches)); }
        return m;
    }
    /* (Stage M4: a shadow check whose answers are not JSON — pixels, a tracking update — compared by its caller,
       KtScreenRs / KtHlsRs, and counted here with the others.) */
    /** One shadow comparison made by the caller: counted, and the first differences kept. Never throws. */
    public static void shadowNote(String method, boolean same, String detail) {
        try {
            shadowCalls.incrementAndGet(); countArea(method, same, detail); if (same) return;   // (per area: the merge)
            shadowMismatches.incrementAndGet();
            synchronized (firstMismatches) { if (firstMismatches.size() < 5) firstMismatches.add(method + " " + detail); }
            java.util.function.Consumer<String> l = log; if (l != null) l.accept("Rust core shadow: " + method + " differs (" + detail + ")");
        } catch (Throwable ignored) {}
    }
    /* (The three stages' merge, for the «Rust core status» card: the same checks counted again per area — the prefix a
       stage's deviceInfo fields carry (ANDROID-PORT.md «M6»): dl, tr, screen, hls, tor, file, remote.) */
    private static final Map<String, long[]> byArea = new java.util.LinkedHashMap<>();
    private static final Map<String, List<String>> firstByArea = new java.util.LinkedHashMap<>();
    /** The area a method belongs to («dl.pickName» → dl, «bytes.inpaint» → screen, «bytes.hlsMedia» → hls…). */
    public static String areaOf(String m) {
        if (m == null) return "other";
        if (m.startsWith("bytes.hls") || m.startsWith("hls.")) return "hls";
        if (m.startsWith("bytes.scr") || m.startsWith("bytes.mo") || m.startsWith("bytes.inpaint") || m.startsWith("scr.") || m.startsWith("lt.")) return "screen";
        if (m.startsWith("tdir.") || m.startsWith("tor.")) return "tor";
        if (m.startsWith("fj.") || m.startsWith("ar.") || m.startsWith("vt.")) return "file";
        if (m.startsWith("rm.")) return "remote";
        if (m.startsWith("dl.") || m.startsWith("http.")) return "dl";
        if (m.startsWith("tr.")) return "tr";
        return "other";
    }
    private static void countArea(String method, boolean same, String detail) {
        try {
            String a = areaOf(method);
            synchronized (byArea) {
                long[] c = byArea.get(a); if (c == null) { c = new long[2]; byArea.put(a, c); } c[0]++; if (same) return; c[1]++;
                List<String> f = firstByArea.get(a); if (f == null) { f = new ArrayList<>(); firstByArea.put(a, f); } if (f.size() < 5) f.add(method + " " + detail);
            }
        } catch (Throwable ignored) {}
    }
    /** The shadow's figures per area: {area: {checks, mismatches, first}}. */
    public static Map<String, Map<String, Object>> shadowByArea() {
        Map<String, Map<String, Object>> out = new java.util.LinkedHashMap<>();
        synchronized (byArea) {
            for (Map.Entry<String, long[]> e : byArea.entrySet()) {
                Map<String, Object> m = new java.util.LinkedHashMap<>(); m.put("checks", e.getValue()[0]); m.put("mismatches", e.getValue()[1]);
                List<String> f = firstByArea.get(e.getKey()); m.put("first", f == null ? new ArrayList<String>() : new ArrayList<>(f)); out.put(e.getKey(), m);
            }
        }
        return out;
    }
    /** (Tests: the shadow's figures back to zero.) */
    static void shadowReset() { shadowCalls.set(0); shadowMismatches.set(0); synchronized (firstMismatches) { firstMismatches.clear(); } synchronized (byArea) { byArea.clear(); firstByArea.clear(); } }

    /* ---------- a little JSON: written ASCII-only (\\u escapes), read for what the Rust side writes ---------- */

    /** A value as JSON text (ASCII only). */
    public static String json(Object v) { StringBuilder b = new StringBuilder(); write(b, v); return b.toString(); }
    static void write(StringBuilder b, Object v) {
        if (v == null) b.append("null");
        else if (v instanceof String) quote(b, (String) v);
        else if (v instanceof Boolean || v instanceof Integer || v instanceof Long || v instanceof Short || v instanceof Byte) b.append(v);
        else if (v instanceof Map) { b.append('{'); boolean first = true; for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) { if (!first) b.append(','); first = false; quote(b, String.valueOf(e.getKey())); b.append(':'); write(b, e.getValue()); } b.append('}'); }
        else if (v instanceof Iterable) { b.append('['); boolean first = true; for (Object x : (Iterable<?>) v) { if (!first) b.append(','); first = false; write(b, x); } b.append(']'); }
        else if (v instanceof Object[]) write(b, java.util.Arrays.asList((Object[]) v));
        else quote(b, String.valueOf(v));
    }
    static void quote(StringBuilder b, String s) {
        b.append('"');
        for (int k = 0; k < s.length(); k++) {
            char c = s.charAt(k);
            if (c == '"') b.append("\\\""); else if (c == '\\') b.append("\\\\");
            else if (c < 0x20 || c > 0x7e) b.append(String.format("\\u%04x", (int) c)); else b.append(c);
        }
        b.append('"');
    }
    static Object parse(String s) { int[] i = { 0 }; Object v = value(s, i); ws(s, i); if (i[0] != s.length()) throw new IllegalArgumentException("trailing"); return v; }
    private static void ws(String s, int[] i) { while (i[0] < s.length() && " \t\r\n".indexOf(s.charAt(i[0])) >= 0) i[0]++; }
    private static Object value(String s, int[] i) {
        ws(s, i); if (i[0] >= s.length()) throw new IllegalArgumentException("end");
        char c = s.charAt(i[0]);
        if (c == '{') { i[0]++; Map<String, Object> m = new java.util.LinkedHashMap<>(); ws(s, i); if (s.charAt(i[0]) == '}') { i[0]++; return m; }
            for (;;) { ws(s, i); String k = str(s, i); ws(s, i); expect(s, i, ':'); m.put(k, value(s, i)); ws(s, i); if (s.charAt(i[0]) == ',') { i[0]++; continue; } expect(s, i, '}'); return m; } }
        if (c == '[') { i[0]++; List<Object> l = new ArrayList<>(); ws(s, i); if (s.charAt(i[0]) == ']') { i[0]++; return l; }
            for (;;) { l.add(value(s, i)); ws(s, i); if (s.charAt(i[0]) == ',') { i[0]++; continue; } expect(s, i, ']'); return l; } }
        if (c == '"') return str(s, i);
        if (s.startsWith("true", i[0])) { i[0] += 4; return Boolean.TRUE; }
        if (s.startsWith("false", i[0])) { i[0] += 5; return Boolean.FALSE; }
        if (s.startsWith("null", i[0])) { i[0] += 4; return null; }
        int a = i[0]; while (i[0] < s.length() && "+-0123456789.eE".indexOf(s.charAt(i[0])) >= 0) i[0]++;
        String n = s.substring(a, i[0]); if (n.isEmpty()) throw new IllegalArgumentException("at " + a);
        return n.matches("-?\\d+") ? (Object) Long.parseLong(n) : (Object) Double.parseDouble(n);
    }
    private static void expect(String s, int[] i, char c) { if (i[0] >= s.length() || s.charAt(i[0]) != c) throw new IllegalArgumentException("expected " + c); i[0]++; }
    private static String str(String s, int[] i) {
        expect(s, i, '"'); StringBuilder b = new StringBuilder();
        while (i[0] < s.length()) {
            char c = s.charAt(i[0]++);
            if (c == '"') return b.toString();
            if (c != '\\') { b.append(c); continue; }
            char e = s.charAt(i[0]++);
            switch (e) { case 'n': b.append('\n'); break; case 't': b.append('\t'); break; case 'r': b.append('\r'); break; case 'b': b.append('\b'); break; case 'f': b.append('\f'); break;
                case 'u': b.append((char) Integer.parseInt(s.substring(i[0], i[0] + 4), 16)); i[0] += 4; break; default: b.append(e); }
        }
        throw new IllegalArgumentException("unterminated string");
    }
}
