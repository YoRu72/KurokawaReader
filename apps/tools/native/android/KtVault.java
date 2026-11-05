package app.kurokawa.tools;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.crypto.Cipher;
import javax.crypto.CipherInputStream;
import javax.crypto.CipherOutputStream;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Files locked with a password: AES-256-GCM, the key from PBKDF2-HMAC-SHA256 (200 000 rounds, a fresh salt each),
 * the original name kept inside the ciphertext so the locked file shows only «<random>.kurokawa». Folders are locked
 * file by file (their shape kept). Unlocking checks the tag, so a wrong password or a damaged file is refused
 * rather than written out as rubbish. Nothing of the password is stored by this class.
 *
 * Layout: "KRV1" · salt[16] · iv[12] · GCM( nameLen[2] · name[utf8] · bytes… )
 */
final class KtVault {
    static final String EXT = ".kurokawa";
    private static final byte[] MAGIC = "KRV1".getBytes(StandardCharsets.US_ASCII);
    private static final int ROUNDS = 200_000;

    static SecretKeySpec key(String password, byte[] salt) throws Exception {
        SecretKeyFactory f = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
        byte[] k = f.generateSecret(new PBEKeySpec(password.toCharArray(), salt, ROUNDS, 256)).getEncoded(); return new SecretKeySpec(k, "AES");
    }
    static boolean isLocked(File f) { return f.getName().endsWith(EXT) && f.isFile(); }

    /** One file locked beside itself (the source removed when asked); the locked file's path. */
    static File lock(File src, String password, boolean deleteAfter, Progress pr) throws Exception {
        byte[] salt = new byte[16], iv = new byte[12]; SecureRandom rnd = new SecureRandom(); rnd.nextBytes(salt); rnd.nextBytes(iv);
        byte[] rn = new byte[6]; rnd.nextBytes(rn); StringBuilder sb = new StringBuilder(); for (byte b : rn) sb.append(String.format(java.util.Locale.US, "%02x", b));
        File out = new File(src.getParentFile(), sb + EXT); File part = new File(out.getPath() + ".part");
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.ENCRYPT_MODE, key(password, salt), new GCMParameterSpec(128, iv));
        byte[] name = src.getName().getBytes(StandardCharsets.UTF_8);
        try (OutputStream raw = new java.io.BufferedOutputStream(new FileOutputStream(part), 1 << 16)) {
            raw.write(MAGIC); raw.write(salt); raw.write(iv);
            try (CipherOutputStream cs = new CipherOutputStream(raw, c); InputStream in = new java.io.BufferedInputStream(new FileInputStream(src), 1 << 16)) {
                cs.write(new byte[] { (byte) (name.length >> 8), (byte) name.length }); cs.write(name);
                byte[] b = new byte[1 << 16]; int n; while ((n = in.read(b)) > 0) { if (pr != null && pr.stopped()) throw new IOException("stopped"); cs.write(b, 0, n); if (pr != null) pr.on(n); }
            }
        } catch (Exception e) { part.delete(); throw e; }
        if (!part.renameTo(out)) { part.delete(); throw new IOException("rename"); }
        if (deleteAfter && !src.delete()) throw new IOException("cannotDeleteSource");
        return out;
    }
    /** The name inside a locked file, when the password opens it (null: wrong password or not ours). */
    static String peek(File f, String password) { try (Opened o = open(f, password)) { return o.name; } catch (Exception e) { return null; } }
    static final class Opened implements java.io.Closeable { final InputStream in; final String name; Opened(InputStream in, String name) { this.in = in; this.name = name; } @Override public void close() throws IOException { in.close(); } }
    /** The plain bytes of a locked file, streamed; the name read first. A wrong password fails here or at the end (the tag). */
    static Opened open(File f, String password) throws Exception {
        InputStream raw = new java.io.BufferedInputStream(new FileInputStream(f), 1 << 16);
        byte[] m = new byte[4], salt = new byte[16], iv = new byte[12];
        if (raw.read(m) != 4 || !java.util.Arrays.equals(m, MAGIC)) { raw.close(); throw new IOException("notLocked"); }
        readFully(raw, salt); readFully(raw, iv);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.DECRYPT_MODE, key(password, salt), new GCMParameterSpec(128, iv));
        CipherInputStream cs = new CipherInputStream(raw, c);
        byte[] ln = new byte[2]; readFully(cs, ln); int n = ((ln[0] & 0xff) << 8) | (ln[1] & 0xff); if (n < 1 || n > 1024) { cs.close(); throw new IOException("wrongPassword"); }
        byte[] name = new byte[n]; readFully(cs, name); String s = new String(name, StandardCharsets.UTF_8);
        if (s.contains("/") || s.contains("\0")) { cs.close(); throw new IOException("wrongPassword"); }
        return new Opened(cs, s);
    }
    static void readFully(InputStream in, byte[] b) throws IOException { int at = 0; while (at < b.length) { int n = in.read(b, at, b.length - at); if (n <= 0) throw new IOException("short"); at += n; } }
    /** Unlocked beside itself (or into `into`); a name already there gets « (2)». The locked file removed when asked. */
    static File unlock(File f, String password, File into, boolean deleteAfter, Progress pr) throws Exception {
        File part = null;
        try (Opened o = open(f, password)) {
            File dir = into == null ? f.getParentFile() : into; dir.mkdirs(); File out = KtFiles.keepBoth(new File(dir, o.name)); part = new File(out.getPath() + ".part");
            try (OutputStream os = new java.io.BufferedOutputStream(new FileOutputStream(part), 1 << 16)) { byte[] b = new byte[1 << 16]; int n; while ((n = o.in.read(b)) > 0) { if (pr != null && pr.stopped()) throw new IOException("stopped"); os.write(b, 0, n); if (pr != null) pr.on(n); } }
            if (!part.renameTo(out)) throw new IOException("rename");
            if (deleteAfter) f.delete();
            return out;
        } catch (javax.crypto.AEADBadTagException | java.io.IOException e) {
            if (part != null) part.delete();
            if (e instanceof javax.crypto.AEADBadTagException || String.valueOf(e.getMessage()).contains("tag") || String.valueOf(e.getCause()).contains("BadTag")) throw new IOException("wrongPassword");
            throw e;
        }
    }
    interface Progress { void on(long n); boolean stopped(); }

    /** Lock or unlock many (folders walked), as a job on the «files» channel. */
    static void run(String id, boolean lock, List<File> paths, String password, boolean deleteAfter, AtomicBoolean stop, KtFiles.Events ev) {
        java.util.List<File> files = new java.util.ArrayList<>(); long[] total = { 0, 0 }; long[] done = { 0, 0 }; long[] told = { 0 }; java.util.List<String> failed = new java.util.ArrayList<>(); String[] why = { null };
        for (File p : paths) collect(p, files, total, lock);
        try {
            for (File f : files) {
                if (stop.get()) break;
                try {
                    Progress pr = new Progress() { public void on(long n) { done[0] += n; tell(ev, id, done, total, f.getName(), told); } public boolean stopped() { return stop.get(); } };
                    if (lock) lock(f, password, deleteAfter, pr); else unlock(f, password, null, deleteAfter, pr);
                    done[1]++;
                } catch (Exception e) { failed.add(f.getAbsolutePath()); if ("wrongPassword".equals(e.getMessage())) { why[0] = "wrongPassword"; break; } if (stop.get()) break; }
            }
            org.json.JSONObject end = new org.json.JSONObject(); end.put("id", id); end.put("status", why[0] != null ? "failed" : stop.get() ? "cancelled" : "done"); if (why[0] != null) end.put("message", why[0]); end.put("done", done[0]); end.put("total", total[0]); end.put("files", done[1]); end.put("failed", new org.json.JSONArray(failed)); ev.on(end);
        } catch (Exception e) { try { org.json.JSONObject end = new org.json.JSONObject(); end.put("id", id); end.put("status", "failed"); end.put("message", String.valueOf(e.getMessage())); ev.on(end); } catch (Exception ignored) {} }
    }
    static void collect(File f, List<File> out, long[] total, boolean lock) {
        if (f.isDirectory()) { File[] k = f.listFiles(); if (k != null) for (File x : k) collect(x, out, total, lock); return; }
        if (!f.isFile()) return; if (lock == isLocked(f)) return; // (already locked / not locked)
        out.add(f); total[0] += f.length(); total[1]++;
    }
    static void tell(KtFiles.Events ev, String id, long[] done, long[] total, String name, long[] told) { long now = System.currentTimeMillis(); if (now - told[0] < 300) return; told[0] = now; try { org.json.JSONObject o = new org.json.JSONObject(); o.put("id", id); o.put("status", "progress"); o.put("done", done[0]); o.put("total", total[0]); o.put("files", done[1]); o.put("ofFiles", total[1]); o.put("name", name); ev.on(o); } catch (Exception ignored) {} }
}
