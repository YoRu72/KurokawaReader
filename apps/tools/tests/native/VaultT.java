import java.io.*; import java.nio.file.*; import java.util.*;
/** KtVault: a file locked, its name hidden, unlocked back whole; a wrong password refused; a folder walked by the job. */
public class VaultT {
  static int fails = 0; static void ok(String what, boolean c) { System.out.println((c ? "ok   " : "FAIL ") + what); if (!c) fails++; }
  public static void main(String[] a) throws Exception {
    File d = Files.createTempDirectory("vault").toFile(); byte[] data = new byte[300 * 1024 + 7]; new Random(3).nextBytes(data); File src = new File(d, "secret photo.jpg"); Files.write(src.toPath(), data);
    File locked = KtVault.lock(src, "hunter2!", false, null);
    ok("locked file is named at random with the extension", locked.getName().endsWith(".kurokawa") && !locked.getName().contains("secret"));
    ok("nothing of the name in the bytes", !new String(Files.readAllBytes(locked.toPath()), "ISO-8859-1").contains("secret photo"));
    ok("peek with the password gives the name", "secret photo.jpg".equals(KtVault.peek(locked, "hunter2!")));
    ok("peek with a wrong password gives nothing", KtVault.peek(locked, "hunter3!") == null);
    File back = KtVault.unlock(locked, "hunter2!", new File(d, "out"), false, null);
    ok("unlocked whole with the name back", back.getName().equals("secret photo.jpg") && Arrays.equals(Files.readAllBytes(back.toPath()), data));
    try { KtVault.unlock(locked, "wrong", new File(d, "out2"), false, null); ok("wrong password refused", false); } catch (IOException e) { ok("wrong password refused: " + e.getMessage(), "wrongPassword".equals(e.getMessage())); }
    ok("no rubbish left by the refusal", new File(d, "out2").listFiles() == null || new File(d, "out2").listFiles().length == 0);
    // a folder, as the job
    File dir = new File(d, "album"); new File(dir, "sub").mkdirs(); Files.write(new File(dir, "a.txt").toPath(), "A".getBytes()); Files.write(new File(dir, "sub/b.txt").toPath(), "BB".getBytes());
    List<org.json.JSONObject> evs = new ArrayList<>();
    KtVault.run("j1", true, Collections.singletonList(dir), "pw", true, new java.util.concurrent.atomic.AtomicBoolean(), evs::add);
    org.json.JSONObject end = evs.get(evs.size() - 1);
    ok("folder locked file by file: " + end, end.getString("status").equals("done") && end.getInt("files") == 2 && !new File(dir, "a.txt").exists() && new File(dir, "sub").listFiles()[0].getName().endsWith(".kurokawa"));
    evs.clear(); KtVault.run("j2", false, Collections.singletonList(dir), "pw", true, new java.util.concurrent.atomic.AtomicBoolean(), evs::add);
    end = evs.get(evs.size() - 1); ok("and unlocked back: " + end.getString("status"), end.getString("status").equals("done") && new String(Files.readAllBytes(new File(dir, "sub/b.txt").toPath())).equals("BB"));
    evs.clear(); KtVault.run("j3", true, Collections.singletonList(dir), "pw", true, new java.util.concurrent.atomic.AtomicBoolean(), evs::add);
    evs.clear(); KtVault.run("j4", false, Collections.singletonList(dir), "nope", true, new java.util.concurrent.atomic.AtomicBoolean(), evs::add);
    end = evs.get(evs.size() - 1); ok("a wrong password stops the job with the reason", end.getString("status").equals("failed") && "wrongPassword".equals(end.optString("message")));
    System.out.println(fails == 0 ? "all passed" : fails + " failed"); System.exit(fails == 0 ? 0 : 1);
  }
}
