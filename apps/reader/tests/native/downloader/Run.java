// The Android downloader (native/android/KrDownloader.java) on its own, against tests/native/downloader/server.cjs:
// the time taken over one connection and over several, and the file whole, from a server that cuts its answers
// short, one that ignores ranges, one that does not say the size, and an empty file.
package app.kurokawa.reader;

import java.io.File;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

public class Run {
    static int fails = 0;
    static String sha(byte[] b) throws Exception { MessageDigest md = MessageDigest.getInstance("SHA-256"); StringBuilder hex = new StringBuilder(); for (byte x : md.digest(b)) hex.append(String.format("%02x", x)); return hex.toString(); }
    static void one(String label, URL url, int n, File dir, String want, long wantSize) throws Exception {
        File out = new File(dir, "dl.part"); out.delete();
        AtomicLong got = new AtomicLong(); KrDownloader.Result r = new KrDownloader.Result();
        long t0 = System.nanoTime();
        try {
            KrDownloader.fetch(url, out, n, (u) -> { HttpURLConnection c = (HttpURLConnection) u.openConnection(); c.setInstanceFollowRedirects(true); c.setConnectTimeout(5000); c.setReadTimeout(20000); return c; }, new AtomicBoolean(false), got, r, () -> {});
        } catch (Exception e) { System.out.println("FAIL " + label + ": " + e); fails++; return; }
        double s = (System.nanoTime() - t0) / 1e9;
        byte[] b = Files.readAllBytes(out.toPath());
        boolean ok = b.length == wantSize && (want == null || sha(b).equals(want)) && got.get() == wantSize;
        if (!ok) fails++;
        System.out.printf("%s %s: %d connection(s), ranged %s, %.2f s, %.0f KB/s, %d bytes, counted %d%n", ok ? "ok  " : "FAIL", label, r.connections, r.ranged, s, got.get() / 1024.0 / s, b.length, got.get());
    }
    public static void main(String[] a) throws Exception {
        String base = a[0]; String want = a[1]; File dir = new File(a[2]); long size = Long.parseLong(a[3]);
        for (int n : new int[] { 1, 4, 8 }) one("redirected, " + n + " asked", new URL(base + "/file"), n, dir, want, size);
        one("answers cut short", new URL(base + "/flaky"), 8, dir, want, size);
        one("ranges ignored", new URL(base + "/noranges"), 8, dir, want, size);
        one("size unknown", new URL(base + "/unknown"), 8, dir, want, size);
        one("empty file", new URL(base + "/empty"), 8, dir, null, 0);
        System.out.println(fails == 0 ? "all passed" : fails + " FAILED");
        System.exit(fails == 0 ? 0 : 1);
    }
}
