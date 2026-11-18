package app.kurokawa.tools;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** KtStream's signed addresses, the plain part (no Android, so tests/native/sign.sh runs it on a JVM): an HMAC-SHA256
 *  over what the address opens and its expiry, with the server's own random key — so no other app on the phone can
 *  make this server read a file, a document, a site or (for /audio) run ffmpeg on a source it picks. */
final class KtSign {
    private KtSign() {}
    /** Twelve hours, as /file's. */
    static final long LIFE_MS = 12L * 3600_000;

    static String sign(byte[] secret, String what, long e) {
        try {
            javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
            mac.init(new javax.crypto.spec.SecretKeySpec(secret, "HmacSHA256"));
            byte[] d = mac.doFinal((what + "|" + e).getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 12; i++) sb.append(String.format(Locale.US, "%02x", d[i]));
            return sb.toString();
        } catch (Exception ex) { return ""; }
    }

    /** The query's token (t) checked against `what` and its expiry (e), at `now`. */
    static boolean signed(byte[] secret, String what, Map<String, String> q, long now) {
        try {
            long e = Long.parseLong(q.getOrDefault("e", "0"));
            if (e < now) return false;
            String t = q.getOrDefault("t", ""); String want = sign(secret, what, e);
            return !t.isEmpty() && !want.isEmpty() && java.security.MessageDigest.isEqual(t.getBytes(StandardCharsets.US_ASCII), want.getBytes(StandardCharsets.US_ASCII));
        } catch (Exception ex) { return false; }
    }

    static Map<String, String> query(String path) {
        Map<String, String> m = new HashMap<>(); int q = path.indexOf('?'); if (q < 0) return m;
        for (String kv : path.substring(q + 1).split("&")) { int eq = kv.indexOf('='); if (eq <= 0) continue; try { m.put(kv.substring(0, eq), java.net.URLDecoder.decode(kv.substring(eq + 1), "UTF-8")); } catch (Exception ignored) {} }
        return m;
    }

    /** /audio's base for one source, signed over it: the page adds &ss=<seconds>&a=<track>. */
    static String audioUrl(byte[] secret, int port, String src, long now) {
        long e = now + LIFE_MS;
        try { return "http://127.0.0.1:" + port + "/audio?src=" + java.net.URLEncoder.encode(src, "UTF-8") + "&e=" + e + "&t=" + sign(secret, "audio\n" + src, e); }
        catch (Exception ex) { return ""; }
    }

    /** /audio's request checked → { src, ss, a }, or null (refused: unsigned, expired, another source, or a start or
     *  a track that is not a plain number). */
    static String[] audioArgs(byte[] secret, String path, long now) {
        Map<String, String> q = query(path); String src = q.get("src");
        if (src == null || src.isEmpty() || !signed(secret, "audio\n" + src, q, now)) return null;
        String ss = q.getOrDefault("ss", "0"); String a = q.getOrDefault("a", "0");
        if (!ss.matches("\\d{1,7}(\\.\\d{1,3})?") || !a.matches("\\d{1,3}")) return null;
        return new String[] { src, ss, a };
    }
}
