package app.kurokawa.tools;

import android.content.Context;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.RandomAccessFile;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** A dub from a subtitle: every cue spoken by the phone's own voice (Android's TextToSpeech, offline when the voice
 *  is), each utterance placed at its cue's time in one WAV (a line that runs past its slot is sped up a little by
 *  ffmpeg later, never cut), and the WAV muxed into a copy of the video as another audio track — or kept beside it
 *  as .wav/.m4a when there is no video. Needs the ffmpeg pack for the muxing. */
final class KtDub {
    private KtDub() {}
    private static final String TAG = "KtDub";
    interface Progress { void on(int done, int total, String phase); }

    /** cues: [{start (s), end (s), text}]; lang like "en" or "ar"; returns the WAV written. */
    static File speak(Context ctx, JSONArray cues, String lang, File work, Progress pr, java.util.concurrent.atomic.AtomicBoolean cancel) throws Exception {
        work.mkdirs(); final CountDownLatch ready = new CountDownLatch(1); final int[] init = { TextToSpeech.ERROR };
        final TextToSpeech[] holder = new TextToSpeech[1];
        holder[0] = new TextToSpeech(ctx, (status) -> { init[0] = status; ready.countDown(); });
        if (!ready.await(15, TimeUnit.SECONDS) || init[0] != TextToSpeech.SUCCESS) throw new java.io.IOException("ttsUnavailable");
        TextToSpeech tts = holder[0];
        try {
            Locale loc = Locale.forLanguageTag(lang == null || lang.isEmpty() ? "en" : lang); int avail = tts.setLanguage(loc);
            if (avail == TextToSpeech.LANG_MISSING_DATA || avail == TextToSpeech.LANG_NOT_SUPPORTED) throw new java.io.IOException("ttsNoVoice:" + lang);
            final java.util.Map<String, CountDownLatch> waits = new java.util.concurrent.ConcurrentHashMap<>(); final java.util.Set<String> failed = java.util.Collections.synchronizedSet(new java.util.HashSet<>());
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) {}
                @Override public void onDone(String id) { CountDownLatch l = waits.get(id); if (l != null) l.countDown(); }
                @Override public void onError(String id) { failed.add(id); CountDownLatch l = waits.get(id); if (l != null) l.countDown(); }
            });
            int n = cues.length(); File[] parts = new File[n];
            for (int i = 0; i < n; i++) {
                if (cancel.get()) throw new java.io.IOException("cancelled");
                JSONObject c = cues.getJSONObject(i); String text = c.optString("text", "").replaceAll("<[^>]+>", "").replaceAll("\\{[^}]*\\}", "").trim(); if (text.isEmpty()) continue;
                File f = new File(work, String.format(Locale.US, "cue-%05d.wav", i)); String id = "kt" + i; CountDownLatch l = new CountDownLatch(1); waits.put(id, l);
                android.os.Bundle params = new android.os.Bundle(); params.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, id);
                if (tts.synthesizeToFile(text, params, f, id) != TextToSpeech.SUCCESS) continue;
                l.await(30, TimeUnit.SECONDS); waits.remove(id); if (failed.contains(id) || f.length() < 100) continue; parts[i] = f;
                pr.on(i + 1, n, "speak");
            }
            // The mix: one 16-bit mono WAV at the voice's rate; each utterance's samples copied in at its cue's start.
            int rate = 0; for (File f : parts) if (f != null) { rate = wavRate(f); if (rate > 0) break; } if (rate <= 0) throw new java.io.IOException("ttsNothing");
            double endS = 0; for (int i = 0; i < n; i++) endS = Math.max(endS, cues.getJSONObject(i).optDouble("end", 0) + 1);
            long totalSamples = (long) (endS * rate); if (totalSamples > 600L * 60 * rate) throw new java.io.IOException("tooLong");
            File out = new File(work, "dub.wav");
            try (RandomAccessFile raf = new RandomAccessFile(out, "rw")) {
                raf.setLength(44 + totalSamples * 2); writeWavHeader(raf, rate, totalSamples * 2);
                for (int i = 0; i < n; i++) {
                    File f = parts[i]; if (f == null) continue; JSONObject c = cues.getJSONObject(i); long at = 44 + (long) (c.optDouble("start", 0) * rate) * 2;
                    byte[] pcm = pcmOf(f, rate); long room = 44 + totalSamples * 2 - at; int len = (int) Math.min(pcm.length, Math.max(0, room)); if (len <= 0) continue;
                    // (Lines overlapping the next cue are mixed, not clipped: added sample by sample where both speak.)
                    raf.seek(at); byte[] had = new byte[len]; raf.readFully(had); for (int k = 0; k + 1 < len; k += 2) { int a = (short) ((had[k] & 0xff) | (had[k + 1] << 8)), b = (short) ((pcm[k] & 0xff) | (pcm[k + 1] << 8)); int s = Math.max(-32768, Math.min(32767, a + b)); had[k] = (byte) s; had[k + 1] = (byte) (s >> 8); }
                    raf.seek(at); raf.write(had);
                    f.delete(); pr.on(i + 1, n, "mix");
                }
            }
            return out;
        } finally { try { tts.shutdown(); } catch (Throwable ignored) {} }
    }
    /** The WAV muxed into a copy of the video as a second audio track named by its language; the copy's path. */
    static File mux(Context ctx, File video, File wav, String lang, File out) throws Exception {
        java.util.List<String> args = new java.util.ArrayList<>(java.util.Arrays.asList("-y", "-hide_banner", "-loglevel", "error", "-i", video.getAbsolutePath(), "-i", wav.getAbsolutePath(), "-map", "0", "-map", "1:a", "-c", "copy", "-c:a:1", "aac", "-b:a:1", "96k", "-metadata:s:a:1", "language=" + (lang == null || lang.isEmpty() ? "und" : lang), "-metadata:s:a:1", "title=Kurokawa dub", "-disposition:a:1", "0", out.getAbsolutePath()));
        if (out.getName().toLowerCase(Locale.ROOT).endsWith(".mp4")) { args.add(args.size() - 1, "-movflags"); args.add(args.size() - 1, "+faststart"); }
        Process p = KtPacks.command(ctx, KtPacks.ffmpegBin(ctx), args).redirectErrorStream(true).start();
        String log = new String(readAll(p.getInputStream()), java.nio.charset.StandardCharsets.UTF_8); int code = p.waitFor();
        if (code != 0 || out.length() == 0) { Log.w(TAG, "mux failed: " + log); throw new java.io.IOException("mux: " + log.trim().replaceAll("\\s+", " ").substring(0, Math.min(160, log.trim().length()))); }
        return out;
    }
    /** The WAV packed to an .m4a beside the subtitle (no video to mux into). */
    static File toM4a(Context ctx, File wav, File out) throws Exception {
        Process p = KtPacks.command(ctx, KtPacks.ffmpegBin(ctx), java.util.Arrays.asList("-y", "-hide_banner", "-loglevel", "error", "-i", wav.getAbsolutePath(), "-c:a", "aac", "-b:a", "96k", out.getAbsolutePath())).redirectErrorStream(true).start();
        readAll(p.getInputStream()); if (p.waitFor() != 0 || out.length() == 0) throw new java.io.IOException("m4a"); return out;
    }

    /* ---------- WAV bits (TextToSpeech writes 16-bit PCM WAV) ---------- */
    private static int wavRate(File f) { try (RandomAccessFile r = new RandomAccessFile(f, "r")) { byte[] h = new byte[44]; r.readFully(h); return (h[24] & 0xff) | ((h[25] & 0xff) << 8) | ((h[26] & 0xff) << 16) | ((h[27] & 0xff) << 24); } catch (Exception e) { return 0; } }
    /** The samples as mono 16-bit at `rate` (a stereo or other-rate utterance brought to it the plain way). */
    private static byte[] pcmOf(File f, int rate) throws Exception {
        try (RandomAccessFile r = new RandomAccessFile(f, "r")) {
            byte[] h = new byte[44]; r.readFully(h); int ch = (h[22] & 0xff) | ((h[23] & 0xff) << 8); int fr = (h[24] & 0xff) | ((h[25] & 0xff) << 8) | ((h[26] & 0xff) << 16) | ((h[27] & 0xff) << 24);
            // (The data chunk found by its tag: some engines put a LIST chunk first.)
            long pos = 12; r.seek(pos); long dataAt = 44; int dataLen = (int) (r.length() - 44);
            while (pos + 8 <= r.length()) { r.seek(pos); byte[] c = new byte[8]; r.readFully(c); String tag = new String(c, 0, 4, java.nio.charset.StandardCharsets.US_ASCII); int len = (c[4] & 0xff) | ((c[5] & 0xff) << 8) | ((c[6] & 0xff) << 16) | ((c[7] & 0xff) << 24); if (tag.equals("data")) { dataAt = pos + 8; dataLen = (int) Math.min(len, r.length() - dataAt); break; } pos += 8 + len + (len & 1); }
            byte[] raw = new byte[Math.max(0, dataLen)]; r.seek(dataAt); r.readFully(raw);
            if (ch == 1 && fr == rate) return raw;
            int frames = raw.length / (2 * Math.max(1, ch)); int outFrames = (int) ((long) frames * rate / Math.max(1, fr)); byte[] out = new byte[outFrames * 2];
            for (int i = 0; i < outFrames; i++) { int src = (int) ((long) i * fr / rate); if (src >= frames) break; int sum = 0; for (int c = 0; c < ch; c++) { int k = (src * ch + c) * 2; sum += (short) ((raw[k] & 0xff) | (raw[k + 1] << 8)); } int s = sum / Math.max(1, ch); out[i * 2] = (byte) s; out[i * 2 + 1] = (byte) (s >> 8); }
            return out;
        }
    }
    private static void writeWavHeader(RandomAccessFile raf, int rate, long dataLen) throws Exception {
        raf.seek(0); java.nio.ByteBuffer b = java.nio.ByteBuffer.allocate(44).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt((int) (36 + dataLen)).put("WAVE".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).put("fmt ".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1).putInt(rate).putInt(rate * 2).putShort((short) 2).putShort((short) 16).put("data".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt((int) dataLen);
        raf.write(b.array());
    }
    private static byte[] readAll(java.io.InputStream in) throws java.io.IOException { java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream(); byte[] buf = new byte[8192]; int n; while ((n = in.read(buf)) > 0) b.write(buf, 0, n); return b.toByteArray(); }
}
