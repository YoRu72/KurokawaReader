import java.nio.file.*; import java.util.*;
// KtSign (KtStream's signed addresses) on a JVM: /audio's address is signed over its one source with an expiry, as
// /file's is; another source, another key, a late or altered token, or a start or track that is not a plain number:
// refused. And KtStream's /audio itself: checked by KtSign before ffmpeg runs, CORS for the app's page only.
public class SignT {
  static int bad = 0;
  static void check(String what, boolean ok) { System.out.println((ok ? "ok   " : "FAIL ") + what); if (!ok) bad++; }
  static String pathOf(String url) { return url.substring(url.indexOf('/', "http://".length())); }
  public static void main(String[] a) throws Exception {
    byte[] key = new byte[32]; new Random(1).nextBytes(key); byte[] other = new byte[32]; new Random(2).nextBytes(other);
    long now = 1_800_000_000_000L; String src = "http://127.0.0.1:5000/stream/t1/0";
    String u = KtSign.audioUrl(key, 5000, src, now);
    check("address: this server, /audio, the source, an expiry and a token", u.startsWith("http://127.0.0.1:5000/audio?src=") && u.contains("&e=") && u.contains("&t="));
    String[] r = KtSign.audioArgs(key, pathOf(u) + "&ss=12.50&a=1", now + 1000);
    check("signed: accepted, with its start and track", r != null && src.equals(r[0]) && "12.50".equals(r[1]) && "1".equals(r[2]));
    String[] d = KtSign.audioArgs(key, pathOf(u), now);
    check("no start or track: 0 and 0", d != null && "0".equals(d[1]) && "0".equals(d[2]));
    check("no token at all: refused", KtSign.audioArgs(key, "/audio?src=" + java.net.URLEncoder.encode(src, "UTF-8") + "&ss=0&a=0", now) == null);
    check("another source with this token: refused", KtSign.audioArgs(key, pathOf(u).replace("t1", "t2"), now) == null);
    check("another server's key: refused", KtSign.audioArgs(other, pathOf(u), now) == null);
    check("past its twelve hours: refused", KtSign.audioArgs(key, pathOf(u), now + KtSign.LIFE_MS + 1) == null);
    String t = KtSign.query(pathOf(u)).get("t"); String flipped = (t.charAt(0) == 'a' ? 'b' : 'a') + t.substring(1);
    check("an altered token: refused", KtSign.audioArgs(key, pathOf(u).replace("&t=" + t, "&t=" + flipped), now) == null);
    check("a later expiry with the same token: refused", KtSign.audioArgs(key, pathOf(u).replaceAll("&e=\\d+", "&e=" + (now + 99 * KtSign.LIFE_MS)), now) == null);
    check("a start that is not a number: refused", KtSign.audioArgs(key, pathOf(u) + "&ss=-i", now) == null && KtSign.audioArgs(key, pathOf(u) + "&ss=1e9", now) == null);
    check("a track that is not a number: refused", KtSign.audioArgs(key, pathOf(u) + "&a=0%3Av", now) == null);
    check("/file's own signing unchanged in form (what|expiry)", KtSign.sign(key, "/a.mkv", 5).length() == 24 && !KtSign.sign(key, "/a.mkv", 5).equals(KtSign.sign(key, "/a.mkv", 6)));
    check("an /audio token is not a /file token for the same text", !KtSign.sign(key, "audio\n" + src, 5).equals(KtSign.sign(key, src, 5)));
    String ks = new String(Files.readAllBytes(Paths.get(a[0])), "UTF-8");
    int at = ks.indexOf("private void audio("); String body = at < 0 ? "" : ks.substring(at, ks.indexOf("\n    }\n", at));
    check("KtStream /audio: KtSign.audioArgs before anything, 403 when refused", body.indexOf("KtSign.audioArgs(") >= 0 && body.indexOf("KtSign.audioArgs(") < body.indexOf("200 OK") && body.contains("403 Forbidden"));
    check("KtStream /audio: CORS for the app's page only, never *", body.contains("APP_CORS") && !body.contains("Allow-Origin: *"));
    check("KtStream: no unsigned /audio base left", !ks.contains("audioBase()") && ks.contains("KtSign.audioUrl("));
    String kp = new String(Files.readAllBytes(Paths.get(a[1])), "UTF-8");
    check("KtPlugin.audioUrl: signed for the source the page names", kp.contains("audioUrl(src)") && kp.contains("call.getString(\"src\""));
    if (bad > 0) { System.out.println(bad + " failed"); System.exit(1); }
    System.out.println("sign: all passed");
  }
}
