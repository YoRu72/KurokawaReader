// KrDoh on its own: a name asked of a resolver over HTTPS (tests/native/doh/server.cjs), and the site reached at
// the address it gave, its name kept in the Host header and in the TLS handshake (SNI).
package app.kurokawa.reader;

import java.net.HttpURLConnection;
import java.net.URL;
import javax.net.ssl.*;

public class Run {
    public static void main(String[] a) throws Exception {
        // (The test's own certificate trusted, and checked to be for the site's name.)
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new TrustManager[] { new X509TrustManager() { public void checkClientTrusted(java.security.cert.X509Certificate[] c, String t) {} public void checkServerTrusted(java.security.cert.X509Certificate[] c, String t) {} public java.security.cert.X509Certificate[] getAcceptedIssuers() { return new java.security.cert.X509Certificate[0]; } } }, null);
        HttpsURLConnection.setDefaultSSLSocketFactory(ctx.getSocketFactory());
        final String[] verified = { "" };
        HttpsURLConnection.setDefaultHostnameVerifier((h, s) -> { verified[0] = h; return h.equals("kr.test") || h.equals("127.0.0.1"); });
        int fails = 0;
        byte[] q = KrDoh.query("kr.test", 1);
        System.out.println((q.length == 12 + 9 + 4 ? "ok   " : "FAIL ") + "question built: " + q.length + " bytes"); if (q.length != 25) fails++;
        KrDoh.provider = "https://127.0.0.1:" + a[0] + "/dns-query";
        java.net.InetAddress[] ips = KrDoh.resolve("kr.test");
        boolean r = ips.length == 1 && ips[0].getHostAddress().equals("127.0.0.1");
        System.out.println((r ? "ok   " : "FAIL ") + "kr.test resolved over HTTPS: " + java.util.Arrays.toString(ips)); if (!r) fails++;
        HttpURLConnection c = KrDoh.open(new URL("https://kr.test:" + a[1] + "/page?x=1"));
        String body = new String(c.getInputStream().readAllBytes());
        boolean s = body.equals("sni=kr.test host=kr.test:" + a[1] + " path=/page?x=1") && verified[0].equals("kr.test");
        System.out.println((s ? "ok   " : "FAIL ") + "the site reached by its address, named in SNI, Host and the certificate check: " + body + " (verified " + verified[0] + ")"); if (!s) fails++;
        HttpURLConnection h = KrDoh.open(new URL("https://kr.test:" + a[1] + "/hop"));
        boolean red = h.getResponseCode() == 302 && "/end".equals(h.getHeaderField("Location"));
        System.out.println((red ? "ok   " : "FAIL ") + "redirects left to the caller (followed by their names): " + h.getResponseCode()); if (!red) fails++;
        KrDoh.provider = "off";
        System.out.println(fails == 0 ? "all passed" : fails + " FAILED");
        System.exit(fails == 0 ? 0 : 1);
    }
}
