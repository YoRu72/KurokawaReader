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
    static boolean valid(String name) { return "python".equals(name) || "ffmpeg".equals(name); }

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
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            HttpURLConnection c = null; URL u = new URL(url);
            for (int hop = 0; hop < 8; hop++) {
                c = KrDoh.open(u); c.setInstanceFollowRedirects(false); c.setConnectTimeout(20000); c.setReadTimeout(60000);
                c.setRequestProperty("User-Agent", "KurokawaTools");
                int code = c.getResponseCode();
                if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) { u = new URL(u, c.getHeaderField("Location")); c.disconnect(); continue; }
                if (code != 200) throw new java.io.IOException("HTTP " + code);
                break;
            }
            long total = c.getContentLengthLong(); long done = 0, lastTell = 0;
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(tmp)) {
                byte[] buf = new byte[1 << 16]; int n;
                while ((n = in.read(buf)) > 0) {
                    if (cancel != null && cancel.get()) throw new InterruptedException("cancelled");
                    out.write(buf, 0, n); md.update(buf, 0, n); done += n;
                    long now = System.currentTimeMillis(); if (pr != null && now - lastTell > 250) { lastTell = now; pr.on(done, total); }
                }
            } finally { c.disconnect(); }
            if (pr != null) pr.on(done, total);
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
