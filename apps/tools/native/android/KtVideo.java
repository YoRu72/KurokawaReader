package app.kurokawa.tools;

import android.content.Context;
import android.util.Log;

import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;
import com.yausername.youtubedl_android.YoutubeDLResponse;

import org.json.JSONObject;

import java.io.File;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** yt-dlp on the phone (youtubedl-android: Python and yt-dlp inside the app, ffmpeg beside): what a page offers,
 *  and a download run with its progress read from yt-dlp's own lines. */
final class KtVideo {
    private static final String TAG = "KtVideo";
    private static volatile boolean inited = false;
    static final Pattern LINE = Pattern.compile("\\[download\\]\\s+([\\d.]+)% of\\s+~?\\s*([\\d.]+)(K|M|G)iB(?: at\\s+([\\d.]+)(K|M|G)iB/s)?");
    static final Pattern DEST = Pattern.compile("\\[(?:download|Merger|ExtractAudio)\\] (?:Destination: |Merging formats into \")(.+?)\"?$");

    static synchronized void init(Context ctx) throws Exception {
        if (inited) return;
        YoutubeDL.getInstance().init(ctx);
        try { com.yausername.ffmpeg.FFmpeg.getInstance().init(ctx); } catch (Throwable e) { Log.w(TAG, "ffmpeg module: " + e); }
        inited = true;
    }
    static void update(Context ctx) { try { init(ctx); YoutubeDL.getInstance().updateYoutubeDL(ctx, YoutubeDL.UpdateChannel.STABLE.INSTANCE); } catch (Throwable e) { Log.w(TAG, "update: " + e); } }
    static String version(Context ctx) { try { init(ctx); return YoutubeDL.getInstance().version(ctx); } catch (Throwable e) { return null; } }

    /** `-J` for a page: the raw JSON yt-dlp prints (the app shapes it). */
    static String info(Context ctx, String url, boolean playlist) throws Exception {
        init(ctx);
        YoutubeDLRequest r = new YoutubeDLRequest(url); r.addOption("-J"); r.addOption("--no-warnings"); r.addOption(playlist ? "--flat-playlist" : "--no-playlist");
        YoutubeDLResponse res = YoutubeDL.getInstance().execute(r, null, null);
        return res.getOut();
    }
    interface Progress { void on(long done, long total, long speed, String file, String detail); }
    /** Runs one download; blocks until it ends; `id` lets it be cancelled with cancel(). Throws on failure. */
    static File run(Context ctx, String id, String url, File dir, JSONObject meta, Progress pr) throws Exception {
        init(ctx);
        boolean audioOnly = meta != null && meta.optBoolean("audioOnly", false); String format = meta != null ? meta.optString("format", "") : ""; String container = meta != null ? meta.optString("container", "") : "";
        int idx = meta != null ? meta.optInt("playlistIndex", 0) : 0;
        YoutubeDLRequest r = new YoutubeDLRequest(url);
        r.addOption("--no-warnings"); r.addOption("--no-playlist"); r.addOption("--continue"); r.addOption("--no-mtime"); r.addOption("--newline");
        String outName = meta != null ? meta.optString("outName", "").replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]+", " ").trim() : "";
        r.addOption("-o", new File(dir, !outName.isEmpty() ? outName + ".%(ext)s" : (idx > 0 ? String.format("%02d - ", idx) : "") + "%(title)s [%(id)s].%(ext)s").getAbsolutePath());
        JSONObject hd = meta != null ? meta.optJSONObject("headers") : null;
        if (hd != null) for (java.util.Iterator<String> it = hd.keys(); it.hasNext(); ) { String k = it.next(); String v = hd.optString(k, ""); if (!k.isEmpty() && !v.isEmpty()) r.addOption("--add-header", k + ":" + v); }
        if (audioOnly) { r.addOption("-f", format.isEmpty() ? "bestaudio/best" : format); r.addOption("-x"); if (!container.isEmpty()) r.addOption("--audio-format", container); }
        else { r.addOption("-f", format.isEmpty() ? "bestvideo+bestaudio/best" : format + "/best"); r.addOption("--merge-output-format", container.isEmpty() ? "mp4" : container); }
        if (meta != null && meta.has("subs")) { r.addOption("--write-subs"); r.addOption("--sub-langs", meta.optString("subs")); r.addOption("--embed-subs"); }
        if (meta != null && meta.optBoolean("embedThumb", false)) r.addOption("--embed-thumbnail");
        if (meta == null || meta.optBoolean("embedMeta", true)) r.addOption("--embed-metadata");
        if (meta != null && meta.optBoolean("sponsorblock", false)) r.addOption("--sponsorblock-remove", "sponsor");
        final String[] dest = { null }; final long[] last = { 0 };
        YoutubeDLResponse res = YoutubeDL.getInstance().execute(r, id, (progress, eta, line) -> {
            try {
                Matcher d = DEST.matcher(line.trim()); if (d.find()) dest[0] = d.group(1);
                Matcher m = LINE.matcher(line); long total = 0, speed = 0, done = 0;
                if (m.find()) { total = (long) (Double.parseDouble(m.group(2)) * unit(m.group(3))); done = (long) (total * Double.parseDouble(m.group(1)) / 100.0); if (m.group(4) != null) speed = (long) (Double.parseDouble(m.group(4)) * unit(m.group(5))); }
                long now = System.currentTimeMillis(); if (now - last[0] > 300 || done >= total) { last[0] = now; pr.on(done, total, speed, dest[0] != null ? new File(dest[0]).getName() : null, line.startsWith("[download]") ? null : line.trim()); }
            } catch (Exception ignored) {}
            return kotlin.Unit.INSTANCE;
        });
        if (res.getExitCode() != 0) throw new Exception(lastError(res.getErr()));
        return dest[0] != null ? new File(dest[0].replaceAll("\\.f\\d+\\.(\\w+)$", ".$1")) : null;
    }
    static boolean cancel(String id) { try { return YoutubeDL.getInstance().destroyProcessById(id); } catch (Throwable e) { return false; } }
    private static double unit(String u) { return "K".equals(u) ? 1024 : "M".equals(u) ? 1048576 : 1073741824; }
    static String lastError(String err) { if (err == null) return "yt-dlp failed"; String out = null; for (String l : err.split("\n")) if (l.contains("ERROR")) out = l; if (out == null) { String[] ls = err.trim().split("\n"); out = ls[ls.length - 1]; } return out.replaceFirst("^ERROR:\\s*", "").trim(); }
}
