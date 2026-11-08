package app.kurokawa.tools;

import android.content.Context;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The heavy native parts, downloaded when an add-on first needs them instead of riding in every APK: Python (for
 * yt-dlp) and ffmpeg (yt-dlp's merging, Convert, clips, chapters). Each pack is the library bundle youtubedl-android
 * would have unpacked from inside the APK, unpacked by the same code into the same folder, with the same marker it
 * checks — so youtubedl-android finds it ready and never looks for the bundle in the APK. The small launchers
 * (libpython.so, libffmpeg.so, libffprobe.so) stay in the APK: Android runs programs only from there.
 */
final class KtPacks {
    interface Progress { void on(long done, long total); }
    private KtPacks() {}

    static File dir(Context ctx, String name) { return new File(ctx.getNoBackupFilesDir(), "youtubedl-android/packages/" + name); }
    private static File marker(Context ctx, String name) { return new File(dir(ctx, name), ".kurokawa-pack"); }
    private static String prefKey(String name) { return "python".equals(name) ? "pythonLibVersion" : "ffmpegLibVersion"; }
    static boolean valid(String name) { return "python".equals(name) || "ffmpeg".equals(name) || "mpv".equals(name); }

    /** The version of an installed pack, or null. */
    static String installed(Context ctx, String name) {
        File m = marker(ctx, name); if (!m.isFile() || !new File(dir(ctx, name), "usr/lib").isDirectory()) return null;
        try (InputStream in = new java.io.FileInputStream(m)) { return new String(readAll(in), java.nio.charset.StandardCharsets.UTF_8).trim(); } catch (Exception e) { return null; }
    }
    static long sizeOnDisk(Context ctx, String name) { return du(dir(ctx, name)); }
    private static long du(File f) { if (f.isFile()) return f.length(); long n = 0; File[] k = f.listFiles(); if (k != null) for (File x : k) if (!isLink(x)) n += du(x); return n; }
    private static boolean isLink(File f) { try { return android.system.OsConstants.S_ISLNK(android.system.Os.lstat(f.getAbsolutePath()).st_mode); } catch (Exception e) { return false; } }

    /** Downloads `url`, checks its SHA-256, and unpacks it where youtubedl-android looks. */
    static void install(Context ctx, String name, String url, String sha256, String version, Progress pr, AtomicBoolean cancel) throws Exception {
        if (!valid(name)) throw new IllegalArgumentException("pack " + name);
        File tmp = new File(ctx.getCacheDir(), "pack-" + name + ".zip");
        try {
            // (GitHub answers 5xx and times out now and then: the fetch is tried up to six times with a growing pause, taking
            // up where it stopped (a Range from the bytes already here), through the resolver on the way the site is reached.)
            long done = 0, total = -1, lastTell = 0; java.io.IOException last = null; tmp.delete();
            // (First over several connections at once, as the downloads are — a pack is tens of megabytes and GitHub's
            // storage gives one connection only so much; a weak link's dropped connections taken up where they stopped.
            // The single connection below is the fallback.)
            boolean fast = false;
            try {
                final java.util.concurrent.atomic.AtomicLong gotB = new java.util.concurrent.atomic.AtomicLong(); final KrDownloader.Result res = new KrDownloader.Result(); final long[] told = { 0 };
                File part = new File(ctx.getCacheDir(), "pack-" + name + ".part");
                KrDownloader.Opts opt = new KrDownloader.Opts(); opt.retries = 8; opt.state = new File(ctx.getCacheDir(), "pack-" + name + ".state");
                KrDownloader.fetch(new URL(url), part, 8, u -> { HttpURLConnection c = KrDoh.open(u); c.setInstanceFollowRedirects(false); c.setConnectTimeout(20000); c.setReadTimeout(60000); c.setRequestProperty("User-Agent", "KurokawaTools"); return c; },
                    cancel != null ? cancel : new AtomicBoolean(), gotB, res, () -> { long now = System.currentTimeMillis(); if (pr != null && now - told[0] > 250) { told[0] = now; pr.on(gotB.get(), res.total); } }, opt);
                if (cancel != null && cancel.get()) { part.delete(); opt.state.delete(); throw new InterruptedException("cancelled"); }
                if (res.total > 0 && part.length() == res.total && part.renameTo(tmp)) { fast = true; done = total = res.total; } else part.delete();
            } catch (InterruptedException e) { throw e; } catch (Exception e) { if (cancel != null && cancel.get()) throw new InterruptedException("cancelled"); }
            for (int attempt = 0; attempt < 6 && !fast; attempt++) {
                if (cancel != null && cancel.get()) throw new InterruptedException("cancelled");
                if (attempt > 0) { try { Thread.sleep(Math.min(20000L, 1500L * (1L << (attempt - 1)))); } catch (InterruptedException ie) { throw new InterruptedException("cancelled"); } }
                HttpURLConnection c = null; URL u = new URL(url);
                try {
                    boolean resume = done > 0;
                    for (int hop = 0; hop < 8; hop++) {
                        c = attempt % 2 == 1 ? (HttpURLConnection) u.openConnection() : KrDoh.open(u); c.setInstanceFollowRedirects(false); c.setConnectTimeout(20000); c.setReadTimeout(60000);
                        c.setRequestProperty("User-Agent", "KurokawaTools"); if (resume) c.setRequestProperty("Range", "bytes=" + done + "-");
                        int code = c.getResponseCode();
                        if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) { u = new URL(u, c.getHeaderField("Location")); c.disconnect(); c = null; continue; }
                        if (resume && code == 200) { done = 0; tmp.delete(); resume = false; }
                        else if (code != 200 && code != 206) { c.disconnect(); c = null; throw new java.io.IOException("HTTP " + code); }
                        break;
                    }
                    if (c == null) throw new java.io.IOException("too many redirects");
                    if (total < 0 || !resume) { long len = c.getContentLengthLong(); total = len > 0 ? len + (resume ? done : 0) : -1; }
                    try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(tmp, resume)) {
                        byte[] buf = new byte[1 << 16]; int n;
                        while ((n = in.read(buf)) > 0) {
                            if (cancel != null && cancel.get()) throw new InterruptedException("cancelled");
                            out.write(buf, 0, n); done += n;
                            long now = System.currentTimeMillis(); if (pr != null && now - lastTell > 250) { lastTell = now; pr.on(done, total); }
                        }
                    }
                    if (total > 0 && done < total) throw new java.io.IOException("cut short");
                    last = null; break;
                } catch (java.io.IOException e) {
                    last = e; String m = String.valueOf(e.getMessage());
                    // (A plain refusal — not found, forbidden — is final; a 5xx, a timeout, a reset or a short answer is tried again.)
                    if (m.matches("HTTP 4\\d\\d")) throw e;
                } finally { if (c != null) c.disconnect(); }
            }
            if (last != null) throw last;
            if (pr != null) pr.on(done, total);
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            try (InputStream in = new java.io.FileInputStream(tmp)) { byte[] buf = new byte[1 << 16]; int n; while ((n = in.read(buf)) > 0) md.update(buf, 0, n); }
            StringBuilder hex = new StringBuilder(); for (byte b : md.digest()) hex.append(String.format("%02x", b));
            if (sha256 != null && !sha256.isEmpty() && !hex.toString().equalsIgnoreCase(sha256)) throw new java.io.IOException("checksum");
            File d = dir(ctx, name); deleteTree(d); d.mkdirs();
            com.yausername.youtubedl_common.utils.ZipUtils.INSTANCE.unzip(tmp, d);
            try (OutputStream m = new FileOutputStream(marker(ctx, name))) { m.write((version == null ? "1" : version).getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
            // (What youtubedl-android compares with the size of the bundle in the APK — none there, so 0.)
            ctx.getSharedPreferences("youtubedl-android", Context.MODE_PRIVATE).edit().putString(prefKey(name), "0").apply();
            KtVideo.reset();
        } finally { tmp.delete(); }
    }
    static void remove(Context ctx, String name) {
        if (!valid(name)) return;
        deleteTree(dir(ctx, name));
        ctx.getSharedPreferences("youtubedl-android", Context.MODE_PRIVATE).edit().remove(prefKey(name)).apply();
        KtVideo.reset();
    }
    private static void deleteTree(File f) { boolean link = isLink(f); if (!link && !f.exists()) return; if (!link && f.isDirectory()) { File[] k = f.listFiles(); if (k != null) for (File x : k) deleteTree(x); } f.delete(); }
    private static byte[] readAll(InputStream in) throws java.io.IOException { java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream(); byte[] buf = new byte[4096]; int n; while ((n = in.read(buf)) > 0) b.write(buf, 0, n); return b.toByteArray(); }

    /* ---------- ffmpeg run directly (Convert, clips, chapters): the launcher in the APK, its libraries from the pack ---------- */
    static File ffmpegBin(Context ctx) { return new File(ctx.getApplicationInfo().nativeLibraryDir, "libffmpeg.so"); }
    static File ffprobeBin(Context ctx) { return new File(ctx.getApplicationInfo().nativeLibraryDir, "libffprobe.so"); }
    static ProcessBuilder command(Context ctx, File bin, java.util.List<String> args) throws Exception {
        if (installed(ctx, "ffmpeg") == null) throw new IllegalStateException("pack:ffmpeg");
        java.util.List<String> cmd = new java.util.ArrayList<>(); cmd.add(bin.getAbsolutePath()); cmd.addAll(args);
        ProcessBuilder pb = new ProcessBuilder(cmd);
        File lib = new File(dir(ctx, "ffmpeg"), "usr/lib");
        pb.environment().put("LD_LIBRARY_PATH", lib.getAbsolutePath());
        pb.environment().put("TMPDIR", ctx.getCacheDir().getAbsolutePath());
        File fc = new File(dir(ctx, "ffmpeg"), "usr/etc/fonts"); if (fc.isDirectory()) pb.environment().put("FONTCONFIG_PATH", fc.getAbsolutePath());
        return pb;
    }
}
