import java.io.*; import java.net.*; import javax.net.ssl.*;
// The proxy against a local TLS-less server: a CONNECT tunnel carrying a fake hello split in two records (the server
// reads two records that join back to the hello), and a plain GET forwarded with Connection: close.
public class PT { public static void main(String[] a) throws Exception {
  ServerSocket site = new ServerSocket(0, 8, InetAddress.getLoopbackAddress()); final int sitePort = site.getLocalPort();
  final String[] seen = new String[2];
  Thread t = new Thread(() -> { try { for (int k = 0; k < 2; k++) { Socket c = site.accept(); c.setSoTimeout(5000); InputStream in = c.getInputStream(); ByteArrayOutputStream got = new ByteArrayOutputStream(); byte[] b = new byte[4096]; int n;
      if (k == 0) { // the hello: read two records, join
        int recs = 0; while (recs < 2) { byte[] h = new byte[5]; int p = 0; while (p < 5) { n = in.read(h, p, 5 - p); if (n < 0) break; p += n; } int len = ((h[3]&0xff)<<8)|(h[4]&0xff); byte[] body = new byte[len]; p = 0; while (p < len) { n = in.read(body, p, len - p); if (n < 0) break; p += n; } got.write(body); recs++; }
        seen[0] = new String(got.toByteArray(), "ISO-8859-1"); c.getOutputStream().write("SERVER-HELLO".getBytes()); c.getOutputStream().flush(); c.close();
      } else { // plain GET
        String line; StringBuilder sb = new StringBuilder(); BufferedReader r = new BufferedReader(new InputStreamReader(in)); while ((line = r.readLine()) != null && !line.isEmpty()) sb.append(line).append('\n'); seen[1] = sb.toString();
        byte[] body = "hi".getBytes(); c.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n").getBytes()); c.getOutputStream().write(body); c.getOutputStream().flush(); c.close(); }
    } } catch (Exception e) { e.printStackTrace(); } }); t.setDaemon(true); t.start();
  KrDoh.provider = "off"; KrDoh.split = "always";
  int pp = KrDohProxy.start();
  // CONNECT
  Socket p = new Socket("127.0.0.1", pp); OutputStream o = p.getOutputStream(); InputStream i = p.getInputStream();
  o.write(("CONNECT 127.0.0.1:" + sitePort + " HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").getBytes()); o.flush();
  String st = KtStream.readLine(i); while (!"".equals(KtStream.readLine(i))) {} if (!st.startsWith("HTTP/1.1 200")) throw new Error("connect: " + st);
  String host = "127.0.0.1"; byte[] name = host.getBytes(); byte[] payload = new byte[100]; for (int k=0;k<100;k++) payload[k]=(byte)('a'+k%26); System.arraycopy(name,0,payload,40,name.length);
  byte[] rec = new byte[105]; rec[0]=0x16; rec[1]=3; rec[2]=1; rec[3]=0; rec[4]=100; System.arraycopy(payload,0,rec,5,100);
  o.write(rec); o.flush();
  byte[] back = new byte[64]; int n = i.read(back); if (n <= 0 || !new String(back, 0, n).equals("SERVER-HELLO")) throw new Error("tunnel back: " + (n > 0 ? new String(back,0,n) : n));
  p.close(); Thread.sleep(200);
  if (!new String(payload, "ISO-8859-1").equals(seen[0])) throw new Error("hello not joined: " + seen[0]);
  // plain GET
  Socket p2 = new Socket("127.0.0.1", pp); p2.getOutputStream().write(("GET http://127.0.0.1:" + sitePort + "/x?y=1 HTTP/1.1\r\nHost: 127.0.0.1:" + sitePort + "\r\nProxy-Connection: keep-alive\r\nX-Q: 1\r\n\r\n").getBytes()); p2.getOutputStream().flush();
  ByteArrayOutputStream all = new ByteArrayOutputStream(); byte[] b = new byte[4096]; while ((n = p2.getInputStream().read(b)) > 0) all.write(b, 0, n);
  String resp = all.toString("ISO-8859-1"); if (!resp.endsWith("hi") || !resp.startsWith("HTTP/1.1 200")) throw new Error("forward: " + resp);
  if (!seen[1].startsWith("GET /x?y=1 HTTP/1.1") || seen[1].contains("Proxy-Connection") || !seen[1].contains("X-Q: 1") || !seen[1].contains("Connection: close")) throw new Error("request rewritten wrong:\n" + seen[1]);
  if (KrDohProxy.tunnels.get() != 2) throw new Error("count");
  KrDohProxy.stop();
  System.out.println("proxy: all passed");
}}
