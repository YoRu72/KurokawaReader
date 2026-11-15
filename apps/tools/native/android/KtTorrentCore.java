package app.kurokawa.tools;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * The Rust torrent engine's library (libkt_torrent.so, apps/tools/core/kt-android-torrent; stage M3) as Java sees it —
 * the same door as {@link KtCore}, for a second library: loaded on first use, never required. Absent (a build without
 * it: it is packed only when it built for all three ABIs), for another ABI, failing to load or answering another
 * protocol → {@link #available()} is false and every torrent stays on libtorrent4j; nothing here throws an Error.
 * One native method, the same shape: method, JSON arguments, optional bytes → status byte + JSON or bytes. Plain Java
 * (no Android class), so the host test (core/kt-android/jvmtest/torrent.sh) loads a build of it through this class.
 */
public final class KtTorrentCore {
    private KtTorrentCore() {}

    /** The call shape this Java knows (kt-android-torrent's dispatch.rs PROTOCOL). */
    static final long PROTOCOL = 1;

    private static native byte[] nCall(byte[] method, byte[] args, byte[] data);

    private static volatile int state;          // 0: not tried, 1: loaded, -1: absent
    private static volatile String version, backend, build, whyAbsent;

    public static boolean available() {
        if (state == 0) load();
        return state == 1;
    }
    /** «0.1.0», or null when absent. */
    public static String version() { return available() ? version : null; }
    /** «librqbit 8.1.1 (every call)», or null when absent. */
    public static String backend() { return available() ? backend + " (" + build + ")" : null; }
    public static String status() { return available() ? "Rust torrent engine: " + version + ", " + backend() : "Rust torrent engine: absent" + (whyAbsent == null ? "" : " (" + whyAbsent + ")"); }

    private static synchronized void load() {
        if (state != 0) return;
        try {
            String path = System.getProperty("kt.torrent.lib");
            if (path != null && !path.isEmpty()) System.load(path); else System.loadLibrary("kt_torrent");
            Object v = KtCore.parse(new String(invoke("core.version", "{}", null), StandardCharsets.UTF_8));
            Map<?, ?> m = v instanceof Map ? (Map<?, ?>) v : null; Object r = m == null ? null : m.get("r");
            Map<?, ?> info = r instanceof Map ? (Map<?, ?>) r : null;
            if (info == null || !Objects.equals(info.get("protocol"), PROTOCOL)) throw new KtCore.Failure("protocol " + (info == null ? "?" : info.get("protocol")));
            version = String.valueOf(info.get("version")); backend = String.valueOf(info.get("backend")); build = String.valueOf(info.get("build"));
            state = 1;
        } catch (Throwable t) {
            whyAbsent = t.getClass().getSimpleName(); state = -1;
        }
        java.util.function.Consumer<String> l = KtCore.log; if (l != null) try { l.accept(status()); } catch (Throwable ignored) {}
    }

    /** A method's `r` from name/value pairs (as KtCore.r). */
    public static Object r(String method, Object... kv) throws KtCore.Failure {
        if (!available()) throw new KtCore.Failure("absent");
        StringBuilder b = new StringBuilder("{");
        for (int k = 0; k + 1 < kv.length; k += 2) { if (k > 0) b.append(','); KtCore.quote(b, String.valueOf(kv[k])); b.append(':'); KtCore.write(b, kv[k + 1]); }
        Object v; try { v = KtCore.parse(new String(invoke(method, b.append('}').toString(), null), StandardCharsets.UTF_8)); } catch (IllegalArgumentException e) { throw new KtCore.Failure("bad answer"); }
        return v instanceof Map ? ((Map<?, ?>) v).get("r") : null;
    }
    /** A bytes method: the bytes back. */
    public static byte[] callBytes(String method, Map<String, Object> args) throws KtCore.Failure {
        if (!available()) throw new KtCore.Failure("absent");
        return invoke(method, KtCore.json(args), null);
    }
    private static byte[] invoke(String method, String json, byte[] data) throws KtCore.Failure {
        byte[] out;
        try { out = nCall(method.getBytes(StandardCharsets.UTF_8), (json == null ? "{}" : json).getBytes(StandardCharsets.UTF_8), data); }
        catch (Throwable t) { throw new KtCore.Failure(t.getClass().getSimpleName()); }
        if (out == null || out.length == 0) throw new KtCore.Failure("no answer");
        if (out[0] != 0) throw new KtCore.Failure(new String(out, 1, out.length - 1, StandardCharsets.UTF_8));
        byte[] b = new byte[out.length - 1]; System.arraycopy(out, 1, b, 0, b.length); return b;
    }
    /** (A list of the answer, or empty.) */
    static List<?> list(Object o) { return o instanceof List ? (List<?>) o : java.util.Collections.emptyList(); }
}
