import com.yausername.youtubedl_android.YoutubeDL;
import java.io.File; import java.util.*; import org.json.JSONObject; import org.json.JSONArray;

/** tests/native/video.sh: KtVideo against a scripted stand-in of youtubedl-android. */
public class VideoT {
  static int fails = 0;
  static void ok(String n, boolean c, Object x) { System.out.println((c ? "ok   " : "FAIL ") + n + (c ? "" : "  " + x)); if (!c) fails++; }
  static List<String> last() { return YoutubeDL.ran.get(YoutubeDL.ran.size() - 1); }
  public static void main(String[] a) throws Exception {
    File root = java.nio.file.Files.createTempDirectory("ktv").toFile(); android.content.Context.root = root; File libs = new File(root, "lib"); libs.mkdirs(); android.content.Context.libs = libs.getPath();
    File y = new File(root, "nobackup/youtubedl-android/yt-dlp/yt-dlp"); y.getParentFile().mkdirs(); java.nio.file.Files.write(y.toPath(), new byte[200_000]);
    android.content.Context ctx = new android.content.Context();
    // The look: its flags; one --no-playlist.
    YoutubeDL.script.add(new Object[] { 10, 0, "{\"id\":\"abc\"}", "" });
    String out = KtVideo.info(ctx, "https://www.youtube.com/watch?v=abc", false, "", "t1"); List<String> c = last();
    ok("the look answers", out.contains("abc"), out);
    ok("15 s a try, one extractor retry", String.join(" ", c).contains("--socket-timeout 15") && String.join(" ", c).contains("--extractor-retries 1"), c);
    ok("one --no-playlist, the address last", Collections.frequency(c, "--no-playlist") == 1 && c.get(c.size() - 1).equals("https://www.youtube.com/watch?v=abc"), c);
    ok("no JavaScript runtime named when the APK has none", !c.contains("--js-runtimes"), c);
    String id = KtVideo.infoId("https://www.youtube.com/watch?v=abc", false, ""); ok("the answer kept under its id for a few minutes", KtVideo.freshInfo(ctx, id) != null && id.matches("[0-9a-f]{16}"), id);
    ok("an id that is a path is refused", KtVideo.freshInfo(ctx, "../../etc/passwd") == null, "");
    // The look given up after its time, yt-dlp's process ended.
    KtVideo.INFO_TIMEOUT_MS = 300; YoutubeDL.script.add(new Object[] { 5000, 0, "{}", "" }); long t0 = System.currentTimeMillis(); String err = null;
    try { KtVideo.info(ctx, "https://www.youtube.com/watch?v=slow", false, "", "t2"); } catch (Exception e) { err = e.getMessage(); }
    long ms = System.currentTimeMillis() - t0;
    ok("a look that hangs is given up after its time («timed out»)", "ERROR: timed out".equals(err) && ms < 2000, err + " " + ms);
    ok("…and its yt-dlp process ended", !YoutubeDL.destroyed.isEmpty() && YoutubeDL.destroyed.get(YoutubeDL.destroyed.size() - 1).startsWith("info-"), YoutubeDL.destroyed);
    // Cancelled by its token (the sheet moved on).
    KtVideo.INFO_TIMEOUT_MS = 10_000; YoutubeDL.script.add(new Object[] { 5000, 0, "{}", "" }); final String[] got = { null };
    Thread th = new Thread(() -> { try { KtVideo.info(ctx, "https://www.youtube.com/watch?v=c", false, "", "t3"); got[0] = "answered"; } catch (Exception e) { got[0] = e.getMessage(); } }); th.start();
    Thread.sleep(200); boolean cancelled = KtVideo.cancelInfo("t3"); th.join(3000);
    ok("a look cancelled by its token stops at once", cancelled && got[0] != null && !"answered".equals(got[0]), got[0]);
    ok("an unknown token cancels nothing", !KtVideo.cancelInfo("nope"), "");
    // The download: the kept look reused (no address), and the automatic run with the address when that fails.
    File dir = new File(root, "dl"); dir.mkdirs();
    JSONObject meta = new JSONObject().put("infoId", id).put("args", new JSONArray(Arrays.asList("-f", "22", "--yes-playlist", "-o", "%(title)s.%(ext)s")));
    YoutubeDL.script.add(new Object[] { 5, 1, "", "ERROR: [youtube] abc: Requested format is not available" }); YoutubeDL.script.add(new Object[] { 5, 0, "", "" });
    int before = YoutubeDL.ran.size(); KtVideo.run(ctx, "d1", "https://www.youtube.com/watch?v=abc", dir, meta, (d, t, s, f, det) -> {});
    List<String> r1 = YoutubeDL.ran.get(before), r2 = YoutubeDL.ran.get(before + 1);
    ok("the download reads the kept look, not the site", r1.contains("--load-info-json") && !r1.contains("https://www.youtube.com/watch?v=abc"), r1);
    ok("that failing, it runs again at once with the address", !r2.contains("--load-info-json") && r2.get(r2.size() - 1).equals("https://www.youtube.com/watch?v=abc") && meta.optBoolean("noInfo"), r2);
    ok("one deliberate playlist flag: the page's --yes-playlist alone", !r1.contains("--no-playlist") && r1.contains("--yes-playlist"), r1);
    // An older task (no list from the page): --no-playlist, once.
    YoutubeDL.script.add(new Object[] { 5, 0, "", "" }); KtVideo.run(ctx, "d2", "https://www.youtube.com/watch?v=old", dir, new JSONObject(), (d, t, s, f, det) -> {});
    ok("the older way: --no-playlist once", Collections.frequency(last(), "--no-playlist") == 1, last());
    // Self-healing: an extractor error → one update → one more try.
    YoutubeDL.verAfterUpdate = "2026.11.01"; YoutubeDL.script.add(new Object[] { 5, 1, "", "ERROR: [youtube] h: Unable to extract nsig function; please report this issue" }); YoutubeDL.script.add(new Object[] { 5, 0, "", "" });
    JSONObject hm = new JSONObject(); before = YoutubeDL.ran.size(); KtVideo.run(ctx, "d3", "https://www.youtube.com/watch?v=h", dir, hm, (d, t, s, f, det) -> {});
    ok("an extractor error → yt-dlp updated once → tried again, done", YoutubeDL.updates == 1 && YoutubeDL.ran.size() == before + 2 && "2026.11.01".equals(hm.optString("healed")), hm + " " + YoutubeDL.updates);
    System.out.println(fails == 0 ? "all passed" : fails + " failed"); System.exit(fails == 0 ? 0 : 1);
  }
}
