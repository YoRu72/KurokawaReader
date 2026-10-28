// The Android downloader (native/android/KrDownloader.java) on its own, against tests/native/downloader/server.cjs:
// a file served in ranges behind a redirect, every connection held to a set speed. Prints the time taken over
// one connection and over several, and whether the bytes came whole.
package app.kurokawa.reader;

import java.io.File;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

public class Run {
    public static void main(String[] a) throws Exception {
        URL url = new URL(a[0]); String want = a[1]; File dir = new File(a[2]);
        for (int n : new int[] { 1, 4, 8 }) {
            File out = new File(dir, "dl-" + n + ".part"); out.delete();
            AtomicLong got = new AtomicLong();
            long t0 = System.nanoTime();
            KrDownloader.Result r = KrDownloader.fetch(url, out, n, (u) -> { HttpURLConnection c = (HttpURLConnection) u.openConnection(); c.setInstanceFollowRedirects(true); c.setConnectTimeout(5000); c.setReadTimeout(20000); return c; }, new AtomicBoolean(false), got, new KrDownloader.Result(), () -> {});
            double s = (System.nanoTime() - t0) / 1e9;
            MessageDigest md = MessageDigest.getInstance("SHA-256"); byte[] h = md.digest(Files.readAllBytes(out.toPath()));
            StringBuilder hex = new StringBuilder(); for (byte b : h) hex.append(String.format("%02x", b));
            System.out.printf("connections %d (used %d, ranged %s): %.2f s, %.0f KB/s, size %d, %s%n", n, r.connections, r.ranged, s, got.get() / 1024.0 / s, out.length(), hex.toString().equals(want) ? "whole" : "CORRUPT");
        }
    }
}
