import com.sun.net.httpserver.*; import java.io.*; import java.net.*; import java.nio.file.*; import java.util.*; import java.util.concurrent.atomic.AtomicBoolean; import javax.crypto.Cipher; import javax.crypto.spec.*;
/** HlsT: a playlist served locally — a master with two variants, a media playlist with AES‑128 pieces (one IV given, the rest by sequence), byte‑range pieces, one piece disguised as a picture — downloaded by KtHls and compared byte for byte. */
public class HlsT {
  static int fails = 0; static void ok(String w, boolean c) { System.out.println((c ? "ok   " : "FAIL ") + w); if (!c) fails++; }
  public static void main(String[] a) throws Exception {
    byte[] key = new byte[16]; new Random(7).nextBytes(key); Random rnd = new Random(1);
    byte[][] plain = new byte[6][]; for (int i = 0; i < 6; i++) { plain[i] = new byte[188 * (20 + i)]; for (int k = 0; k < plain[i].length; k += 188) { plain[i][k] = 0x47; for (int j = 1; j < 188; j++) plain[i][k + j] = (byte) rnd.nextInt(256); } }
    byte[] ivGiven = new byte[16]; ivGiven[15] = 9;
    byte[] big = new byte[plain[4].length + plain[5].length]; System.arraycopy(plain[4], 0, big, 0, plain[4].length); System.arraycopy(plain[5], 0, big, plain[4].length, plain[5].length);
    HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0); int port = s.getAddress().getPort(); String base = "http://127.0.0.1:" + port;
    s.createContext("/master.m3u8", ex -> send(ex, ("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS=\"avc1.64001f,mp4a.40.2\"\nhigh/index.m3u8\n").getBytes()));
    s.createContext("/high/index.m3u8", ex -> send(ex, ("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-KEY:METHOD=AES-128,URI=\"../k.key\",IV=0x00000000000000000000000000000009\n#EXTINF:4.0,\np0.ts\n#EXT-X-KEY:METHOD=AES-128,URI=\"../k.key\"\n#EXTINF:4.0,\np1.ts\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4.0,\np2.jpg\n#EXTINF:4.0,\np3.ts\n#EXT-X-BYTERANGE:" + plain[4].length + "@0\n#EXTINF:4.0,\nbig.ts\n#EXT-X-BYTERANGE:" + plain[5].length + "\n#EXTINF:4.0,\nbig.ts\n#EXT-X-ENDLIST\n").getBytes()));
    s.createContext("/low/index.m3u8", ex -> send(ex, "#EXTM3U\n#EXT-X-ENDLIST\n".getBytes()));
    s.createContext("/k.key", ex -> send(ex, key));
    s.createContext("/high/p0.ts", ex -> send(ex, enc(plain[0], key, ivGiven)));
    s.createContext("/high/p1.ts", ex -> { byte[] iv = new byte[16]; iv[15] = 6; send(ex, enc(plain[1], key, iv)); });
    s.createContext("/high/p2.jpg", ex -> { byte[] d = new byte[300 + plain[2].length]; d[0] = (byte) 0xFF; d[1] = (byte) 0xD8; for (int i = 2; i < 300; i++) d[i] = (byte) 0x11; System.arraycopy(plain[2], 0, d, 300, plain[2].length); send(ex, d); });
    int[] hits = { 0 }; s.createContext("/high/p3.ts", ex -> { if (hits[0]++ == 0) { ex.sendResponseHeaders(503, -1); ex.close(); return; } send(ex, plain[3]); });
    s.createContext("/high/big.ts", ex -> { String r = ex.getRequestHeaders().getFirst("Range"); String[] p = r.substring(6).split("-"); int from = Integer.parseInt(p[0]), to = Integer.parseInt(p[1]); byte[] d = Arrays.copyOfRange(big, from, to + 1); ex.getResponseHeaders().set("Content-Type", "video/mp2t"); ex.sendResponseHeaders(206, d.length); ex.getResponseBody().write(d); ex.close(); });
    s.start();
    Path d = Files.createTempDirectory("hlst"); File out = new File(d.toFile(), "show.mp4"); File work = new File(d.toFile(), "work");
    List<String> phases = new ArrayList<>(); int[] last = { 0, 0 };
    KtHls.Result r = KtHls.run(null, base + "/master.m3u8", out, work, 3, 1080, u -> (HttpURLConnection) u.openConnection(), new AtomicBoolean(false), (piece, pieces, bytes, phase) -> { if (!phases.contains(phase)) phases.add(phase); last[0] = piece; last[1] = pieces; });
    ok("the tallest variant at or under 1080p chosen: " + phases.get(0), phases.get(0).equals("variant 1080p"));
    ok("six pieces counted (" + last[0] + "/" + last[1] + ")", last[0] == 6 && last[1] == 6);
    ok("joined as .ts without ffmpeg: " + r.out.getName(), r.out.getName().equals("show.ts") && "ts".equals(r.container));
    ByteArrayOutputStream want = new ByteArrayOutputStream(); for (byte[] p : plain) want.write(p);
    ok("bytes equal the plain pieces in order (decrypted, uncovered, byte-ranged)", Arrays.equals(Files.readAllBytes(r.out.toPath()), want.toByteArray()));
    ok("a 503 on a piece retried", hits[0] >= 2);
    ok("the work folder's pieces gone", !new File(work, "pieces").exists());
    // The variant choice on its own.
    List<KtHls.Variant> vs = KtHls.variants("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\na\n#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=640x360\nb\n#EXT-X-STREAM-INF:BANDWIDTH=3,RESOLUTION=1920x1080\nc\n", new URL("http://x/")); 
    ok("480p wanted → 360p", KtHls.choose(vs, 480).height == 360); ok("nothing wanted → 1080p", KtHls.choose(vs, 0).height == 1080); ok("240p wanted (none under) → the smallest", KtHls.choose(vs, 240).height == 360);
    ok("attr with quotes and commas", "avc1.64001f,mp4a.40.2".equals(KtHls.attr("BANDWIDTH=3,CODECS=\"avc1.64001f,mp4a.40.2\",RESOLUTION=1x2", "CODECS")) && "1x2".equals(KtHls.attr("BANDWIDTH=3,CODECS=\"a,b\",RESOLUTION=1x2", "RESOLUTION")));
    // Live playlists refused; DRM refused.
    try { KtHls.media("#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"k\"\n#EXTINF:4,\np\n", new URL("http://x/")); ok("SAMPLE-AES refused", false); } catch (IOException e) { ok("SAMPLE-AES refused: " + e.getMessage(), e.getMessage().startsWith("drm:")); }
    ok("a growing short playlist is live", KtHls.media("#EXTM3U\n#EXTINF:4,\np\n", new URL("http://x/")).live && !KtHls.media("#EXTM3U\n#EXTINF:4,\np\n#EXT-X-ENDLIST\n", new URL("http://x/")).live);
    s.stop(0); System.out.println(fails == 0 ? "all passed" : fails + " failed"); System.exit(fails == 0 ? 0 : 1);
  }
  static void send(HttpExchange ex, byte[] d) throws IOException { ex.sendResponseHeaders(200, d.length); ex.getResponseBody().write(d); ex.close(); }
  static byte[] enc(byte[] p, byte[] key, byte[] iv) { try { Cipher c = Cipher.getInstance("AES/CBC/PKCS5Padding"); c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(iv)); return c.doFinal(p); } catch (Exception e) { throw new RuntimeException(e); } }
}
