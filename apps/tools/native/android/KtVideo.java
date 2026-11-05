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
        // (Python and ffmpeg are packs downloaded with the Video add-on; without Python nothing runs.)
        if (KtPacks.installed(ctx, "python") == null) throw new IllegalStateException("pack:python");
        YoutubeDL.getInstance().init(ctx);
        if (KtPacks.installed(ctx, "ffmpeg") != null) { try { com.yausername.ffmpeg.FFmpeg.getInstance().init(ctx); } catch (Throwable e) { Log.w(TAG, "ffmpeg module: " + e); } }
        inited = true;
    }
    /** After a pack comes or goes: initialised again on next use. */
    static synchronized void reset() { inited = false; }
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
    /** What is known live of a running download — phase (info/video/audio/merge/finish), fragment i/n, the stream's
     *  resolution, codecs, container and approximate size — read by the engine on each progress call. */
    static final java.util.Map<String, JSONObject> live = new java.util.concurrent.ConcurrentHashMap<>();
    static final Pattern FRAG = Pattern.compile("\\(frag (\\d+)/(\\d+)\\)");
    private static void note(String id, String line, String[] dest, int[] dests) {
        try {
            JSONObject o = live.get(id); if (o == null) { o = new JSONObject(); live.put(id, o); }
            String l = line.trim();
            if (l.startsWith("KT|")) { String[] p = l.split("\\|", -1); if (p.length >= 7) { if (!"NA".equals(p[1])) o.put("res", p[1]); if (!"NA".equals(p[2]) && !"none".equals(p[2])) o.put("vcodec", p[2].replaceAll("\\..*$", "")); if (!"NA".equals(p[3]) && !"none".equals(p[3])) o.put("acodec", p[3].replaceAll("\\..*$", "")); if (!"NA".equals(p[4])) o.put("ext", p[4]); try { o.put("sizeApprox", Long.parseLong(p[5])); } catch (Exception ignored) {} try { o.put("duration", (long) Double.parseDouble(p[6])); } catch (Exception ignored) {} } return; }
            if (l.startsWith("[download] Destination:")) { dests[0]++; String f = l.substring(24).trim(); boolean audio = dests[0] > 1 || f.matches(".*\\.(m4a|opus|webm|mp3|ogg|aac)$") && dest[0] == null; o.put("phase", audio && dests[0] > 1 ? "audio" : "video"); o.remove("frag"); o.remove("frags"); return; }
            if (l.startsWith("[Merger]")) { o.put("phase", "merge"); return; }
            if (l.startsWith("[EmbedThumbnail]") || l.startsWith("[Metadata]") || l.startsWith("[ExtractAudio]") || l.startsWith("[SponsorBlock]") || l.startsWith("[ModifyChapters]") || l.startsWith("[FixupM3u8]") || l.startsWith("[VideoRemuxer]") || l.startsWith("[VideoConvertor]") || l.startsWith("[EmbedSubtitle]")) { o.put("phase", "finish"); return; }
            if (l.startsWith("[info]") || l.startsWith("[youtube]") || l.startsWith("[generic]") || l.startsWith("[hlsnative]") || l.startsWith("[dashsegments]")) { if (!o.has("phase")) o.put("phase", "info"); }
            Matcher f = FRAG.matcher(l); if (f.find()) { o.put("frag", Integer.parseInt(f.group(1))); o.put("frags", Integer.parseInt(f.group(2))); }
        } catch (Exception ignored) {}
    }
    /** Runs one download; blocks until it ends; `id` lets it be cancelled with cancel(). Throws on failure. */
    /** The exact arguments of the last attempt, by download id (shown as «the command», taken as the start of «edit and try again»). */
    static final java.util.Map<String, java.util.List<String>> lastCommand = new java.util.concurrent.ConcurrentHashMap<>();
    /** The ladder a refusal climbs (OmniGet's cascade): each step the extra arguments it adds, tried in turn when the
     *  one before failed the way the step mends — a 429 or a signature/SABR fault with another YouTube player client,
     *  a TLS-fingerprint block with impersonation, a postprocessing fault with a plainer format. */
    static final String[][] LADDER = {
        { },                                                                                   // as asked
        { "--extractor-args", "youtube:player_client=android,web", "--retry-sleep", "exp=1:30" },  // 429 / nsig / SABR: another client, backing off
        { "--extractor-args", "youtube:player_client=ios,mweb", "--sleep-requests", "1", "--throttled-rate", "100K" },
        { "--impersonate", "chrome", "--retry-sleep", "exp=2:60" },                                    // a block on the connection's fingerprint
        { "-f", "best", "--no-embed-metadata", "--no-embed-thumbnail" },                               // a postprocessing fault: the plainest format, nothing embedded
    };
    static int stepFor(String err, int step) {
        String e = err == null ? "" : err.toLowerCase(java.util.Locale.ROOT);
        if (e.contains("429") || e.contains("too many requests") || e.contains("nsig") || e.contains("sabr") || e.contains("sign in to confirm") || e.contains("player response") || e.contains("unable to extract")) return Math.max(step + 1, 1);
        if (e.contains("handshake") || e.contains("ssl") || e.contains("403") || e.contains("forbidden") || e.contains("fingerprint") || e.contains("impersonat")) return Math.max(step + 1, 3);
        if (e.contains("postprocess") || e.contains("ffmpeg") || e.contains("merging") || e.contains("embed")) return 4;
        if (e.contains("http error 5") || e.contains("timed out") || e.contains("connection reset") || e.contains("incomplete")) return step + 1;
        return -1;   // (not a fault another way mends: a private video, a missing file, a wrong address)
    }
    static File run(Context ctx, String id, String url, File dir, JSONObject meta, Progress pr) throws Exception {
        init(ctx);
        Exception last = null; int step = meta != null && meta.has("ladderStep") ? meta.optInt("ladderStep", 0) : 0;
        for (int attempt = 0; attempt < LADDER.length; attempt++) {
            try { return runOnce(ctx, id, url, dir, meta, pr, step); }
            catch (Exception e) {
                last = e; if (cancelled(id)) throw e; int next = stepFor(e.getMessage(), step); if (next < 0 || next >= LADDER.length || next <= step) throw e;
                step = next; pr.on(0, 0, 0, null, "retry: " + String.join(" ", LADDER[step]));
            }
        }
        throw last;
    }
    private static final java.util.Set<String> stopped = java.util.Collections.newSetFromMap(new java.util.concurrent.ConcurrentHashMap<>());
    private static boolean cancelled(String id) { return stopped.remove(id); }
    private static File runOnce(Context ctx, String id, String url, File dir, JSONObject meta, Progress pr, int step) throws Exception {
        boolean audioOnly = meta != null && meta.optBoolean("audioOnly", false); String format = meta != null ? meta.optString("format", "") : ""; String container = meta != null ? meta.optString("container", "") : "";
        int idx = meta != null ? meta.optInt("playlistIndex", 0) : 0;
        YoutubeDLRequest r = new YoutubeDLRequest(url);
        r.addOption("--no-warnings"); r.addOption("--no-playlist"); r.addOption("--continue"); r.addOption("--no-mtime"); r.addOption("--newline");
        String outName = meta != null ? meta.optString("outName", "").replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]+", " ").trim() : "";
        String tpl = meta != null ? meta.optString("template", "") : ""; if (tpl.isEmpty() || tpl.contains("/") || tpl.contains("\\") || tpl.contains("..")) tpl = "%(title)s [%(id)s]";
        r.addOption("-o", new File(dir, !outName.isEmpty() ? outName + ".%(ext)s" : (idx > 0 ? String.format("%02d - ", idx) : "") + tpl + ".%(ext)s").getAbsolutePath());
        if (meta != null && meta.optBoolean("chapters", false)) r.addOption("--embed-chapters");
        String section = meta != null ? meta.optString("section", "") : ""; if (section.matches("[\\d:.]+-[\\d:.]+")) r.addOption("--download-sections", "*" + section);
        JSONObject hd = meta != null ? meta.optJSONObject("headers") : null;
        if (hd != null) for (java.util.Iterator<String> it = hd.keys(); it.hasNext(); ) { String k = it.next(); String v = hd.optString(k, ""); if (!k.isEmpty() && !v.isEmpty()) r.addOption("--add-header", k + ":" + v); }
        if (audioOnly) { r.addOption("-f", format.isEmpty() ? "bestaudio/best" : format); r.addOption("-x"); if (!container.isEmpty()) r.addOption("--audio-format", container); }
        else { r.addOption("-f", format.isEmpty() ? "bestvideo+bestaudio/best" : format + "/best"); r.addOption("--merge-output-format", container.isEmpty() ? "mp4" : container); }
        if (meta != null && meta.has("subs")) { r.addOption("--write-subs"); r.addOption("--sub-langs", meta.optString("subs")); r.addOption("--embed-subs"); }
        if (meta != null && meta.optBoolean("embedThumb", false)) r.addOption("--embed-thumbnail");
        if (meta == null || meta.optBoolean("embedMeta", true)) r.addOption("--embed-metadata");
        if (meta != null && meta.optBoolean("sponsorblock", false)) r.addOption("--sponsorblock-remove", "sponsor");
        // The step of the ladder, then the reader's own arguments («edit and try again»: whole words, split on spaces, quotes kept together).
        { String[] st = LADDER[step]; for (int i = 0; i < st.length; i++) { if (st[i].startsWith("-") && i + 1 < st.length && !st[i + 1].startsWith("-")) r.addOption(st[i], st[++i]); else r.addOption(st[i]); } }
        String extra = meta != null ? meta.optString("extraArgs", "") : "";
        if (!extra.isEmpty()) { java.util.List<String> xs = splitArgs(extra); for (int i = 0; i < xs.size(); i++) { String a = xs.get(i); if (a.startsWith("-") && i + 1 < xs.size() && !xs.get(i + 1).startsWith("-")) { r.addOption(a, xs.get(++i)); } else r.addOption(a); } }
        r.addOption("--print", "pre_process:KT|%(resolution)s|%(vcodec)s|%(acodec)s|%(ext)s|%(filesize_approx)s|%(duration)s");
        lastCommand.put(id, r.buildCommand()); live.remove(id);
        final String[] dest = { null }; final long[] last = { 0 }; final int[] dests = { 0 };
        YoutubeDLResponse res = YoutubeDL.getInstance().execute(r, id, (progress, eta, line) -> {
            try {
                note(id, line, dest, dests); Matcher d = DEST.matcher(line.trim()); if (d.find()) dest[0] = d.group(1);
                Matcher m = LINE.matcher(line); long total = 0, speed = 0, done = 0;
                if (m.find()) { total = (long) (Double.parseDouble(m.group(2)) * unit(m.group(3))); done = (long) (total * Double.parseDouble(m.group(1)) / 100.0); if (m.group(4) != null) speed = (long) (Double.parseDouble(m.group(4)) * unit(m.group(5))); }
                long now = System.currentTimeMillis(); if (now - last[0] > 300 || done >= total) { last[0] = now; pr.on(done, total, speed, dest[0] != null ? new File(dest[0]).getName() : null, line.startsWith("[download]") ? null : line.trim()); }
            } catch (Exception ignored) {}
            return kotlin.Unit.INSTANCE;
        });
        if (res.getExitCode() != 0) throw new Exception(lastError(res.getErr()));
        return dest[0] != null ? new File(dest[0].replaceAll("\\.f\\d+\\.(\\w+)$", ".$1")) : null;
    }
    static java.util.List<String> splitArgs(String s) { java.util.List<String> out = new java.util.ArrayList<>(); Matcher m = java.util.regex.Pattern.compile("\"([^\"]*)\"|'([^']*)'|(\\S+)").matcher(s); while (m.find()) out.add(m.group(1) != null ? m.group(1) : m.group(2) != null ? m.group(2) : m.group(3)); return out; }
    static boolean cancel(String id) { stopped.add(id); try { return YoutubeDL.getInstance().destroyProcessById(id); } catch (Throwable e) { return false; } }
    private static double unit(String u) { return "K".equals(u) ? 1024 : "M".equals(u) ? 1048576 : 1073741824; }
    static String lastError(String err) { if (err == null) return "yt-dlp failed"; String out = null; for (String l : err.split("\n")) if (l.contains("ERROR")) out = l; if (out == null) { String[] ls = err.trim().split("\n"); out = ls[ls.length - 1]; } return out.replaceFirst("^ERROR:\\s*", "").trim(); }
}
