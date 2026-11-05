import java.io.*; import java.net.*; import java.util.*;
/** The ladder of ways a hello goes out: each way's bytes put back together make the hello whole; an alert from the site moves the host to the next way, an answer keeps it. */
public class WT {
  static int fails = 0; static void ok(String w, boolean c) { System.out.println((c ? "ok   " : "FAIL ") + w); if (!c) fails++; }
  static byte[] hello(String host) { byte[] name = host.getBytes(); byte[] body = new byte[200]; new Random(1).nextBytes(body); System.arraycopy(name, 0, body, 120, name.length); byte[] rec = new byte[5 + body.length]; rec[0] = 0x16; rec[1] = 3; rec[2] = 1; rec[3] = (byte) (body.length >> 8); rec[4] = (byte) body.length; System.arraycopy(body, 0, rec, 5, body.length); return rec; }
  /** All TLS records read from `in` until the stream ends, their bodies joined. */
  static byte[] join(InputStream in) throws IOException { ByteArrayOutputStream out = new ByteArrayOutputStream(); int recs = 0; while (true) { byte[] h = new byte[5]; int p = 0; while (p < 5) { int n = in.read(h, p, 5 - p); if (n < 0) return recs == 0 ? null : out.toByteArray(); p += n; } int len = ((h[3] & 0xff) << 8) | (h[4] & 0xff); byte[] b = new byte[len]; p = 0; while (p < len) { int n = in.read(b, p, len - p); if (n < 0) break; p += n; } out.write(b); recs++; } }
  public static void main(String[] a) throws Exception {
    KrDoh.split = "auto"; String host = "example.test"; byte[] rec = hello(host);
    for (int way = 0; way < KrDoh.WAYS.length; way++) {
      ServerSocket srv = new ServerSocket(0, 1, InetAddress.getLoopbackAddress()); final byte[][] got = { null };
      Thread t = new Thread(() -> { try (Socket c = srv.accept()) { c.setSoTimeout(3000); got[0] = join(c.getInputStream()); } catch (IOException e) { } }); t.start();
      try (Socket s = new Socket(InetAddress.getLoopbackAddress(), srv.getLocalPort())) { KrDoh.sendHello(s, s.getOutputStream(), rec, host, way); s.shutdownOutput(); t.join(4000); }
      // (fake: off Android the TTL cannot be set, so no decoy goes out; on Android the decoy never reaches the site.)
      byte[] body = Arrays.copyOfRange(rec, 5, rec.length);
      ok("way " + KrDoh.WAYS[way] + " arrives whole", got[0] != null && Arrays.equals(got[0], body));
      srv.close();
    }
    // the ladder's memory
    KrDoh.ways.clear(); ok("starts plain when the network gives the site", KrDoh.wayOf(host, false) == 0); ok("starts split when the site is hidden", KrDoh.wayOf(host, true) == 1);
    KrDoh.wayFailed(host, 1, "alert"); ok("an alert moves to frag", KrDoh.wayOf(host, true) == 2);
    KrDoh.wayFailed(host, 1, "alert"); ok("a late report of the old way changes nothing", KrDoh.wayOf(host, true) == 2);
    KrDoh.wayFailed(host, 2, "silent"); KrDoh.wayFailed(host, 3, "silent"); ok("…to fake", KrDoh.wayOf(host, true) == 4);
    KrDoh.wayFailed(host, 4, "alert"); ok("past the end, round to plain", KrDoh.wayOf(host, true) == 0);
    KrDoh.wayWorked(host, 0); ok("a way that worked is kept", KrDoh.wayOf(host, true) == 0 && KrDoh.waysJson().length() == 1);
    KrDoh.split = "off"; ok("split off: always plain", KrDoh.wayOf(host, true) == 0); KrDoh.split = "auto";
    System.out.println(fails == 0 ? "ways: all passed" : fails + " failed"); System.exit(fails == 0 ? 0 : 1);
  }
}
