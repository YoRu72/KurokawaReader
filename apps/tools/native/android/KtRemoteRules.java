package app.kurokawa.tools;

import app.kurokawa.tools.KtCore;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Stage M5 of the Rust port: the network storages' rules that need no network, in two hands — Java's (KtRemote's own
 * code, copied here unchanged as the reference) and Rust's (kt-core's remoterules.rs, the `rm.*` methods). KtRemote
 * asks here for what it used to work out inline: the WebDAV base URL, a PROPFIND href made a path, an upload's order.
 * With the file jobs engine on «Rust» (and the core here) Rust's answer is used, Java's on any error; on a debuggable
 * build both are asked and a difference counted. No secret is ever an argument: the Authorization header, the
 * passwords, keys and tokens stay in KtRemote (and the Keystore). Plain Java, so the host tests run it.
 */
final class KtRemoteRules {
    private KtRemoteRules() {}

    static final AtomicLong CHECKS = new AtomicLong(), MISMATCHES = new AtomicLong(), FALLBACKS = new AtomicLong();

    /* ---------- Java's (KtRemote's, as they are) ---------- */
    static String norm(String p) { if (p == null || p.isEmpty()) return "/"; p = p.replace('\\', '/'); if (!p.startsWith("/")) p = "/" + p; if (p.length() > 1 && p.endsWith("/")) p = p.substring(0, p.length() - 1); return p; }
    static String join(String dir, String name) { dir = norm(dir); return dir.equals("/") ? "/" + name : dir + "/" + name; }
    static String enc(String s) { try { return java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20"); } catch (Exception e) { return s; } }
    static String davBaseJava(String host, String kind, String user) {
        String u = host; if (!u.startsWith("http://") && !u.startsWith("https://")) u = "https://" + u; if (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        if (kind.equals("nextcloud") && !u.contains("/remote.php/")) u = u + "/remote.php/dav/files/" + enc(user);
        return u;
    }
    static String davPathJava(String path) { try { return java.net.URLEncoder.encode(norm(path), "UTF-8").replace("%2F", "/").replace("+", "%20"); } catch (Exception e) { return null; } }
    static String hrefJava(String href, String basePath) throws Exception { String p = java.net.URLDecoder.decode(href.replaceFirst("^https?://[^/]+", ""), "UTF-8"); if (!basePath.isEmpty() && p.startsWith(basePath)) p = p.substring(basePath.length()); return norm(p); }
    static void collectLocal(File f, String rdir, List<File[]> out, long[] total) { if (f.isDirectory()) { File[] k = f.listFiles(); if (k != null) for (File x : k) collectLocal(x, join(rdir, f.getName()), out, total); return; } out.add(new File[] { f, new File(join(rdir, f.getName())) }); total[0] += f.length(); total[1]++; }

    private static boolean rust() { try { return KtFileExec.rustChosen() && KtCore.available(); } catch (Throwable e) { return false; } }
    private static boolean check() { try { return KtCore.shadowing() || rust(); } catch (Throwable e) { return false; } }
    private static void differ(String what, Object java, Object rust) {
        MISMATCHES.incrementAndGet();
        synchronized (KtFileExec.FIRST) { if (KtFileExec.FIRST.size() < 5) KtFileExec.FIRST.add("remote " + what + ": java=" + java + " rust=" + rust); }
    }

    /** Dav's base URL (the user's name only: no password here). */
    static String davBase(String host, String kind, String user) {
        String j = davBaseJava(host, kind, user);
        if (!check()) return j;
        try { CHECKS.incrementAndGet(); Object r = KtCore.r("rm.davBase", "host", host, "kind", kind, "user", user); if (!j.equals(r)) differ("davBase", j, r); return rust() && r instanceof String ? (String) r : j; }
        catch (KtCore.Failure e) { FALLBACKS.incrementAndGet(); return j; }
    }
    /** A PROPFIND href as a path; an exception as Java's decoder throws it (Rust's «no» is that same refusal). */
    static String href(String href, String basePath) throws Exception {
        String j; Exception je = null; try { j = hrefJava(href, basePath); } catch (Exception e) { j = null; je = e; }
        if (check()) {
            try {
                CHECKS.incrementAndGet(); Object r = KtCore.r("rm.hrefs", "hrefs", java.util.Collections.singletonList(href), "basePath", basePath);
                Object one = r instanceof List && ((List<?>) r).size() == 1 ? ((List<?>) r).get(0) : "?";
                if (!java.util.Objects.equals(j, one)) differ("href", j, one);
                if (rust() && (one == null || one instanceof String)) { if (one == null) throw new IllegalArgumentException("URLDecoder: bad escape"); return (String) one; }
            } catch (KtCore.Failure e) { FALLBACKS.incrementAndGet(); }
        }
        if (je != null) throw je;
        return j;
    }
    /** An upload's files in order, [local, remote] (KtRemote.transfer «up»); `total` filled as Java's collectLocal does. */
    static List<File[]> upload(List<String> paths, String dest, long[] total) {
        List<File[]> jf = new ArrayList<>(); long[] jt = { 0, 0 }; for (String p : paths) collectLocal(new File(p), norm(dest), jf, jt);
        List<File[]> out = jf;
        if (check()) {
            try {
                CHECKS.incrementAndGet();
                StringBuilder b = new StringBuilder("{\"paths\":["); for (int i = 0; i < paths.size(); i++) { if (i > 0) b.append(','); local(new File(paths.get(i)), b); }
                b.append("],\"dest\":"); KtFilePlan.q(b, dest); b.append('}');
                org.json.JSONArray st = new org.json.JSONObject(KtCore.call("rm.upload", b.toString())).getJSONObject("r").getJSONArray("steps");
                List<File[]> rf = new ArrayList<>(); for (int i = 0; i < st.length(); i++) { org.json.JSONArray s = st.getJSONArray(i); if (s.getString(0).equals("put")) rf.add(new File[] { new File(s.getString(1)), new File(s.getString(2)) }); }
                boolean same = rf.size() == jf.size(); for (int i = 0; same && i < rf.size(); i++) same = rf.get(i)[0].getPath().equals(jf.get(i)[0].getPath()) && rf.get(i)[1].getPath().equals(jf.get(i)[1].getPath());
                if (!same) differ("upload", jf.size() + " files", rf.size() + " files");
                if (rust()) out = rf;
            } catch (Exception e) { FALLBACKS.incrementAndGet(); }
        }
        total[0] += jt[0]; total[1] += jt[1];
        return out;
    }
    private static void local(File f, StringBuilder b) {
        b.append("{\"path\":"); KtFilePlan.q(b, f.getPath()); b.append(",\"n\":"); KtFilePlan.q(b, f.getName()); boolean d = f.isDirectory(); b.append(",\"s\":").append(d ? 0 : f.length()).append(",\"d\":").append(d);
        if (d) { File[] k = f.listFiles(); if (k != null) { b.append(",\"c\":["); for (int i = 0; i < k.length; i++) { if (i > 0) b.append(','); local(k[i], b); } b.append(']'); } }
        b.append('}');
    }
}
