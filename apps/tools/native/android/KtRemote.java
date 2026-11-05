package app.kurokawa.tools;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The Files add-on's network storages — FTP and FTPS, SFTP (a password or a key), SMB shares (SMB2/3) and WebDAV —
 * behind one small client face: list, read, write, make a folder, delete, rename. Connections are kept encrypted
 * (the Keystore through EncryptedSharedPreferences); a server's host key or certificate is trusted once, by its
 * fingerprint, after the reader has seen it ("hostkey:…" / "cert:…" errors carry the fingerprint to ask with).
 * Transfers run as jobs that report on the «files» channel like local copies do.
 */
final class KtRemote {
    private static final String TAG = "KtRemote";
    private static final Map<String, Client> OPEN = new ConcurrentHashMap<>();

    /* ---------- the saved connections ---------- */
    static SharedPreferences prefs(Context ctx) {
        try {
            String key = androidx.security.crypto.MasterKeys.getOrCreate(androidx.security.crypto.MasterKeys.AES256_GCM_SPEC);
            return androidx.security.crypto.EncryptedSharedPreferences.create("kt-remotes", key, ctx, androidx.security.crypto.EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV, androidx.security.crypto.EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
        } catch (Throwable e) { Log.w(TAG, "encrypted prefs unavailable: " + e); return ctx.getSharedPreferences("kt-remotes-plain", Context.MODE_PRIVATE); }
    }
    static JSONArray all(Context ctx) { try { return new JSONArray(prefs(ctx).getString("list", "[]")); } catch (Exception e) { return new JSONArray(); } }
    static JSONObject get(Context ctx, String id) throws Exception { JSONArray a = all(ctx); for (int i = 0; i < a.length(); i++) if (a.getJSONObject(i).getString("id").equals(id)) return a.getJSONObject(i); throw new IOException("noConnection"); }
    /** Saved (a new id given when none); the secret fields stay inside, the list handed to the page is stripped (see `publicList`). */
    static JSONObject save(Context ctx, JSONObject c) throws Exception {
        JSONArray a = all(ctx); String id = c.optString("id", ""); if (id.isEmpty()) { id = "r" + Long.toString(System.currentTimeMillis(), 36); c.put("id", id); }
        JSONArray out = new JSONArray(); boolean put = false;
        for (int i = 0; i < a.length(); i++) { JSONObject o = a.getJSONObject(i); if (o.getString("id").equals(id)) { if (c.optString("pass", "").isEmpty() && !c.has("passCleared")) c.put("pass", o.optString("pass", "")); if (c.optString("key", "").isEmpty()) c.put("key", o.optString("key", "")); if (!c.has("trust")) c.put("trust", o.optString("trust", "")); for (String k : new String[] { "access", "refresh", "expires", "clientSecret" }) if (!c.has(k) && o.has(k)) c.put(k, o.get(k)); out.put(c); put = true; } else out.put(o); }
        if (!put) out.put(c);
        prefs(ctx).edit().putString("list", out.toString()).apply(); Client cl = OPEN.remove(id); if (cl != null) cl.close(); return c;
    }
    static void remove(Context ctx, String id) throws Exception { JSONArray a = all(ctx), out = new JSONArray(); for (int i = 0; i < a.length(); i++) if (!a.getJSONObject(i).getString("id").equals(id)) out.put(a.getJSONObject(i)); prefs(ctx).edit().putString("list", out.toString()).apply(); Client cl = OPEN.remove(id); if (cl != null) cl.close(); }
    static void trust(Context ctx, String id, String fp) throws Exception { JSONObject c = get(ctx, id); c.put("trust", fp); save(ctx, c); }
    static JSONArray publicList(Context ctx) throws Exception {
        JSONArray a = all(ctx), out = new JSONArray();
        for (int i = 0; i < a.length(); i++) { JSONObject o = new JSONObject(a.getJSONObject(i).toString()); o.remove("pass"); o.remove("key"); o.remove("access"); o.remove("refresh"); o.remove("clientSecret"); o.put("signedIn", !a.getJSONObject(i).optString("refresh", "").isEmpty() || !a.getJSONObject(i).optString("access", "").isEmpty()); o.put("hasPass", !a.getJSONObject(i).optString("pass", "").isEmpty()); o.put("hasKey", !a.getJSONObject(i).optString("key", "").isEmpty()); out.put(o); }
        return out;
    }

    /* ---------- one face for every kind ---------- */
    static final class Entry { String name; boolean dir; long size, mtime; }
    interface Client extends java.io.Closeable {
        List<Entry> list(String path) throws Exception;
        InputStream read(String path, long offset) throws Exception;
        /** Writes `size` bytes (-1: unknown) from `in` to `path`. */
        void write(String path, InputStream in, long size, Progress pr) throws Exception;
        void mkdir(String path) throws Exception;
        void delete(String path, boolean dir) throws Exception;
        void rename(String from, String to) throws Exception;
        long size(String path) throws Exception;
        @Override void close();
    }
    interface Progress { void on(long done); boolean stopped(); }

    static synchronized Client client(Context ctx, String id) throws Exception {
        Client c = OPEN.get(id); if (c != null) return c;
        JSONObject o = get(ctx, id); String kind = o.optString("kind", "ftp");
        switch (kind) {
            case "ftp": case "ftps": c = new Ftp(o, kind.equals("ftps")); break;
            case "sftp": c = new Sftp(o); break;
            case "smb": c = new Smb(o); break;
            case "webdav": case "nextcloud": c = new Dav(o); break;
            case "gdrive": c = new KtCloud.GDrive(ctx, o); break;
            case "dropbox": c = new KtCloud.Dropbox(ctx, o); break;
            case "onedrive": c = new KtCloud.OneDrive(ctx, o); break;
            default: throw new IOException("unknownKind");
        }
        OPEN.put(id, c); return c;
    }
    static void drop(String id) { Client c = OPEN.remove(id); if (c != null) c.close(); }
    /** Runs `w` once; a dropped connection (the first failure) is opened again and `w` retried. */
    interface Work<T> { T run(Client c) throws Exception; }
    static <T> T with(Context ctx, String id, Work<T> w) throws Exception {
        try { return w.run(client(ctx, id)); }
        catch (Exception e) { String m = String.valueOf(e.getMessage()); if (m.startsWith("hostkey:") || m.startsWith("cert:") || m.startsWith("login")) throw e; drop(id); return w.run(client(ctx, id)); }
    }
    static String norm(String p) { if (p == null || p.isEmpty()) return "/"; p = p.replace('\\', '/'); if (!p.startsWith("/")) p = "/" + p; if (p.length() > 1 && p.endsWith("/")) p = p.substring(0, p.length() - 1); return p; }
    static String join(String dir, String name) { dir = norm(dir); return dir.equals("/") ? "/" + name : dir + "/" + name; }
    static String fingerprint(byte[] der) throws Exception { byte[] d = MessageDigest.getInstance("SHA-256").digest(der); StringBuilder sb = new StringBuilder(); for (byte b : d) { if (sb.length() > 0) sb.append(':'); sb.append(String.format(Locale.US, "%02X", b)); } return sb.toString(); }
    static JSONArray toJson(List<Entry> es) throws Exception { JSONArray a = new JSONArray(); for (Entry e : es) { JSONObject o = new JSONObject(); o.put("name", e.name); o.put("dir", e.dir); o.put("size", e.size); o.put("mtime", e.mtime); a.put(o); } return a; }

    /* ---------- FTP / FTPS (commons-net) ---------- */
    static final class Ftp implements Client {
        final org.apache.commons.net.ftp.FTPClient f; final JSONObject o;
        Ftp(JSONObject o, boolean tls) throws Exception {
            this.o = o;
            if (tls) { org.apache.commons.net.ftp.FTPSClient s = new org.apache.commons.net.ftp.FTPSClient("TLS", false); s.setTrustManager(trustManager(o)); f = s; } else f = new org.apache.commons.net.ftp.FTPClient();
            f.setConnectTimeout(12000); f.setDefaultTimeout(20000); f.setControlEncoding("UTF-8"); f.setAutodetectUTF8(true);
            f.connect(o.getString("host"), o.optInt("port", 21)); f.setSoTimeout(30000);
            if (!f.login(o.optString("user", "anonymous").isEmpty() ? "anonymous" : o.optString("user", "anonymous"), o.optString("pass", "").isEmpty() ? "kurokawa@" : o.optString("pass", ""))) { f.disconnect(); throw new IOException("login"); }
            if (tls) { ((org.apache.commons.net.ftp.FTPSClient) f).execPBSZ(0); ((org.apache.commons.net.ftp.FTPSClient) f).execPROT("P"); }
            f.enterLocalPassiveMode(); f.setFileType(org.apache.commons.net.ftp.FTP.BINARY_FILE_TYPE); f.setListHiddenFiles(true);
        }
        @Override public List<Entry> list(String path) throws Exception {
            List<Entry> out = new ArrayList<>(); org.apache.commons.net.ftp.FTPFile[] fs = f.listFiles(norm(path));
            if (fs == null) fs = new org.apache.commons.net.ftp.FTPFile[0];
            for (org.apache.commons.net.ftp.FTPFile x : fs) { if (x == null || x.getName().equals(".") || x.getName().equals("..")) continue; Entry e = new Entry(); e.name = x.getName(); e.dir = x.isDirectory(); e.size = x.getSize(); e.mtime = x.getTimestamp() == null ? 0 : x.getTimestamp().getTimeInMillis(); out.add(e); }
            return out;
        }
        @Override public InputStream read(String path, long offset) throws Exception {
            f.setRestartOffset(offset); final InputStream in = f.retrieveFileStream(norm(path)); if (in == null) throw new IOException("read " + f.getReplyString());
            return new java.io.FilterInputStream(in) { @Override public void close() throws IOException { super.close(); try { f.completePendingCommand(); } catch (IOException ignored) {} } };
        }
        @Override public void write(String path, InputStream in, long size, Progress pr) throws Exception {
            try (OutputStream out = f.storeFileStream(norm(path))) { if (out == null) throw new IOException("write " + f.getReplyString()); pump(in, out, pr); }
            if (!f.completePendingCommand()) throw new IOException("write " + f.getReplyString());
        }
        @Override public void mkdir(String path) throws Exception { if (!f.makeDirectory(norm(path))) throw new IOException("mkdir " + f.getReplyString()); }
        @Override public void delete(String path, boolean dir) throws Exception {
            path = norm(path);
            if (dir) { for (Entry e : list(path)) delete(join(path, e.name), e.dir); if (!f.removeDirectory(path)) throw new IOException("delete " + f.getReplyString()); }
            else if (!f.deleteFile(path)) throw new IOException("delete " + f.getReplyString());
        }
        @Override public void rename(String from, String to) throws Exception { if (!f.rename(norm(from), norm(to))) throw new IOException("rename " + f.getReplyString()); }
        @Override public long size(String path) throws Exception { String s = f.getSize(norm(path)); return s == null ? -1 : Long.parseLong(s.trim()); }
        @Override public void close() { try { f.logout(); } catch (Exception ignored) {} try { f.disconnect(); } catch (Exception ignored) {} }
    }

    /* ---------- SFTP (jsch) ---------- */
    static final class Sftp implements Client {
        final com.jcraft.jsch.Session s; final com.jcraft.jsch.ChannelSftp ch;
        Sftp(JSONObject o) throws Exception {
            com.jcraft.jsch.JSch j = new com.jcraft.jsch.JSch();
            String key = o.optString("key", ""); if (!key.isEmpty()) j.addIdentity("key", key.getBytes(StandardCharsets.UTF_8), null, o.optString("pass", "").isEmpty() ? null : o.optString("pass", "").getBytes(StandardCharsets.UTF_8));
            final String trusted = o.optString("trust", "");
            j.setHostKeyRepository(new com.jcraft.jsch.HostKeyRepository() {
                @Override public int check(String host, byte[] k) { try { String fp = fingerprint(k); if (fp.equals(trusted)) return OK; throw new RuntimeException("hostkey:" + fp + ":" + keyType(k)); } catch (RuntimeException e) { throw e; } catch (Exception e) { return NOT_INCLUDED; } }
                @Override public void add(com.jcraft.jsch.HostKey hk, com.jcraft.jsch.UserInfo ui) {}
                @Override public void remove(String host, String type) {}
                @Override public void remove(String host, String type, byte[] k) {}
                @Override public String getKnownHostsRepositoryID() { return "kurokawa"; }
                @Override public com.jcraft.jsch.HostKey[] getHostKey() { return new com.jcraft.jsch.HostKey[0]; }
                @Override public com.jcraft.jsch.HostKey[] getHostKey(String host, String type) { return new com.jcraft.jsch.HostKey[0]; }
            });
            s = j.getSession(o.optString("user", ""), o.getString("host"), o.optInt("port", 22));
            if (key.isEmpty()) s.setPassword(o.optString("pass", ""));
            s.setConfig("StrictHostKeyChecking", "yes"); s.setConfig("PreferredAuthentications", key.isEmpty() ? "password,keyboard-interactive" : "publickey"); s.setTimeout(30000);
            try { s.connect(15000); }
            catch (com.jcraft.jsch.JSchException e) {
                Throwable c = e; while (c != null) { if (String.valueOf(c.getMessage()).startsWith("hostkey:")) throw new IOException(c.getMessage()); c = c.getCause(); }
                if (String.valueOf(e.getMessage()).toLowerCase(Locale.ROOT).contains("auth")) throw new IOException("login"); throw e;
            }
            ch = (com.jcraft.jsch.ChannelSftp) s.openChannel("sftp"); ch.connect(15000);
        }
        static String keyType(byte[] k) { try { int n = ((k[0] & 0xff) << 24) | ((k[1] & 0xff) << 16) | ((k[2] & 0xff) << 8) | (k[3] & 0xff); return new String(k, 4, n, StandardCharsets.US_ASCII); } catch (Exception e) { return ""; } }
        @Override public List<Entry> list(String path) throws Exception {
            List<Entry> out = new ArrayList<>();
            @SuppressWarnings("unchecked") java.util.Vector<com.jcraft.jsch.ChannelSftp.LsEntry> v = ch.ls(norm(path));
            for (com.jcraft.jsch.ChannelSftp.LsEntry x : v) { if (x.getFilename().equals(".") || x.getFilename().equals("..")) continue; Entry e = new Entry(); e.name = x.getFilename(); e.dir = x.getAttrs().isDir(); e.size = x.getAttrs().getSize(); e.mtime = x.getAttrs().getMTime() * 1000L; out.add(e); }
            return out;
        }
        @Override public InputStream read(String path, long offset) throws Exception { return ch.get(norm(path), null, offset); }
        @Override public void write(String path, InputStream in, long size, Progress pr) throws Exception { try (OutputStream out = ch.put(norm(path), com.jcraft.jsch.ChannelSftp.OVERWRITE)) { pump(in, out, pr); } }
        @Override public void mkdir(String path) throws Exception { ch.mkdir(norm(path)); }
        @Override public void delete(String path, boolean dir) throws Exception { path = norm(path); if (dir) { for (Entry e : list(path)) delete(join(path, e.name), e.dir); ch.rmdir(path); } else ch.rm(path); }
        @Override public void rename(String from, String to) throws Exception { ch.rename(norm(from), norm(to)); }
        @Override public long size(String path) throws Exception { return ch.stat(norm(path)).getSize(); }
        @Override public void close() { try { ch.disconnect(); } catch (Exception ignored) {} try { s.disconnect(); } catch (Exception ignored) {} }
    }

    /* ---------- SMB2/3 (smbj) — the path's first part is the share ---------- */
    static final class Smb implements Client {
        final com.hierynomus.smbj.SMBClient client; final com.hierynomus.smbj.connection.Connection conn; final com.hierynomus.smbj.session.Session sess; final Map<String, com.hierynomus.smbj.share.DiskShare> shares = new ConcurrentHashMap<>(); final JSONObject o;
        Smb(JSONObject o) throws Exception {
            this.o = o;
            com.hierynomus.smbj.SmbConfig cfg = com.hierynomus.smbj.SmbConfig.builder().withTimeout(20, java.util.concurrent.TimeUnit.SECONDS).withSoTimeout(30, java.util.concurrent.TimeUnit.SECONDS).withMultiProtocolNegotiate(true).build();
            client = new com.hierynomus.smbj.SMBClient(cfg); conn = client.connect(o.getString("host"), o.optInt("port", 445));
            com.hierynomus.smbj.auth.AuthenticationContext ac = o.optString("user", "").isEmpty() ? com.hierynomus.smbj.auth.AuthenticationContext.guest() : new com.hierynomus.smbj.auth.AuthenticationContext(o.optString("user", ""), o.optString("pass", "").toCharArray(), o.optString("domain", ""));
            try { sess = conn.authenticate(ac); } catch (Exception e) { throw new IOException("login"); }
        }
        String[] split(String path) { path = norm(path); String[] p = path.substring(1).split("/", 2); return new String[] { p[0], p.length > 1 ? p[1].replace('/', '\\') : "" }; }
        com.hierynomus.smbj.share.DiskShare share(String name) throws Exception { com.hierynomus.smbj.share.DiskShare s = shares.get(name); if (s != null && s.isConnected()) return s; s = (com.hierynomus.smbj.share.DiskShare) sess.connectShare(name); shares.put(name, s); return s; }
        @Override public List<Entry> list(String path) throws Exception {
            List<Entry> out = new ArrayList<>(); String[] sp = split(path);
            if (sp[0].isEmpty()) {
                // The root: the shares, through the server service (needs the IPC$ pipe); without it the one the reader named.
                try { com.rapid7.client.dcerpc.transport.RPCTransport t = com.rapid7.client.dcerpc.transport.SMBTransportFactories.SRVSVC.getTransport(sess); com.rapid7.client.dcerpc.mssrvs.ServerService ss = new com.rapid7.client.dcerpc.mssrvs.ServerService(t); for (com.rapid7.client.dcerpc.mssrvs.dto.NetShareInfo0 si : ss.getShares0()) { if (si.getNetName().endsWith("$")) continue; Entry e = new Entry(); e.name = si.getNetName(); e.dir = true; e.size = 0; out.add(e); } }
                catch (Throwable e) { String one = o.optString("share", ""); if (!one.isEmpty()) { Entry en = new Entry(); en.name = one; en.dir = true; out.add(en); } else throw new IOException("sharesUnlisted"); }
                return out;
            }
            for (com.hierynomus.msfscc.fileinformation.FileIdBothDirectoryInformation fi : share(sp[0]).list(sp[1])) {
                if (fi.getFileName().equals(".") || fi.getFileName().equals("..")) continue;
                Entry e = new Entry(); e.name = fi.getFileName(); e.dir = (fi.getFileAttributes() & com.hierynomus.msfscc.FileAttributes.FILE_ATTRIBUTE_DIRECTORY.getValue()) != 0; e.size = fi.getEndOfFile(); e.mtime = fi.getLastWriteTime().toEpochMillis(); out.add(e);
            }
            return out;
        }
        com.hierynomus.smbj.share.File open(String path, boolean write) throws Exception {
            String[] sp = split(path); java.util.Set<com.hierynomus.msdtyp.AccessMask> am = java.util.EnumSet.of(write ? com.hierynomus.msdtyp.AccessMask.GENERIC_WRITE : com.hierynomus.msdtyp.AccessMask.GENERIC_READ);
            return share(sp[0]).openFile(sp[1], am, null, com.hierynomus.mssmb2.SMB2ShareAccess.ALL, write ? com.hierynomus.mssmb2.SMB2CreateDisposition.FILE_OVERWRITE_IF : com.hierynomus.mssmb2.SMB2CreateDisposition.FILE_OPEN, null);
        }
        @Override public InputStream read(String path, long offset) throws Exception { final com.hierynomus.smbj.share.File f = open(path, false); InputStream in = f.getInputStream(); if (offset > 0) { long left = offset; while (left > 0) { long k = in.skip(left); if (k <= 0) break; left -= k; } } return new java.io.FilterInputStream(in) { @Override public void close() throws IOException { super.close(); f.close(); } }; }
        @Override public void write(String path, InputStream in, long size, Progress pr) throws Exception { try (com.hierynomus.smbj.share.File f = open(path, true); OutputStream out = f.getOutputStream()) { pump(in, out, pr); } }
        @Override public void mkdir(String path) throws Exception { String[] sp = split(path); share(sp[0]).mkdir(sp[1]); }
        @Override public void delete(String path, boolean dir) throws Exception { String[] sp = split(path); if (dir) share(sp[0]).rmdir(sp[1], true); else share(sp[0]).rm(sp[1]); }
        @Override public void rename(String from, String to) throws Exception {
            String[] a = split(from), b = split(to);
            try (com.hierynomus.smbj.share.DiskEntry e = share(a[0]).open(a[1], java.util.EnumSet.of(com.hierynomus.msdtyp.AccessMask.DELETE, com.hierynomus.msdtyp.AccessMask.GENERIC_READ), null, com.hierynomus.mssmb2.SMB2ShareAccess.ALL, com.hierynomus.mssmb2.SMB2CreateDisposition.FILE_OPEN, null)) { e.rename(b[1]); }
        }
        @Override public long size(String path) throws Exception { String[] sp = split(path); return share(sp[0]).getFileInformation(sp[1]).getStandardInformation().getEndOfFile(); }
        @Override public void close() { for (com.hierynomus.smbj.share.DiskShare s : shares.values()) try { s.close(); } catch (Exception ignored) {} try { sess.close(); } catch (Exception ignored) {} try { conn.close(); } catch (Exception ignored) {} try { client.close(); } catch (Exception ignored) {} }
    }

    /* ---------- WebDAV (plain HTTP: PROPFIND, GET, PUT, MKCOL, DELETE, MOVE) ---------- */
    static final class Dav implements Client {
        final JSONObject o; final String base; final String auth;
        Dav(JSONObject o) throws Exception {
            this.o = o; String u = o.getString("host"); if (!u.startsWith("http://") && !u.startsWith("https://")) u = "https://" + u; if (u.endsWith("/")) u = u.substring(0, u.length() - 1);
            if (o.optString("kind", "").equals("nextcloud") && !u.contains("/remote.php/")) u = u + "/remote.php/dav/files/" + enc(o.optString("user", ""));
            base = u; auth = o.optString("user", "").isEmpty() ? null : "Basic " + android.util.Base64.encodeToString((o.optString("user", "") + ":" + o.optString("pass", "")).getBytes(StandardCharsets.UTF_8), android.util.Base64.NO_WRAP);
            HttpURLConnection c = req("PROPFIND", "/", 0); c.setRequestProperty("Depth", "0"); int code = c.getResponseCode(); if (code == 401) throw new IOException("login"); if (code >= 400) throw new IOException("http " + code); c.disconnect();
        }
        HttpURLConnection req(String method, String path, long offset) throws Exception {
            String enc = java.net.URLEncoder.encode(norm(path), "UTF-8").replace("%2F", "/").replace("+", "%20");
            URL url = new URL(base + enc); HttpURLConnection c = (HttpURLConnection) url.openConnection();
            if (c instanceof javax.net.ssl.HttpsURLConnection) { javax.net.ssl.SSLContext sc = javax.net.ssl.SSLContext.getInstance("TLS"); sc.init(null, new javax.net.ssl.TrustManager[] { trustManager(o) }, null); ((javax.net.ssl.HttpsURLConnection) c).setSSLSocketFactory(sc.getSocketFactory()); }
            c.setConnectTimeout(15000); c.setReadTimeout(30000); c.setInstanceFollowRedirects(false);
            try { c.setRequestMethod(method); } catch (java.net.ProtocolException e) { setMethod(c, method); }
            if (auth != null) c.setRequestProperty("Authorization", auth); c.setRequestProperty("User-Agent", "Kurokawa Tools");
            if (offset > 0) c.setRequestProperty("Range", "bytes=" + offset + "-");
            return c;
        }
        static void setMethod(HttpURLConnection c, String m) { try { java.lang.reflect.Field f = HttpURLConnection.class.getDeclaredField("method"); f.setAccessible(true); f.set(c, m); } catch (Exception ignored) {} }
        @Override public List<Entry> list(String path) throws Exception {
            HttpURLConnection c = req("PROPFIND", norm(path) + (norm(path).equals("/") ? "" : "/"), 0); c.setRequestProperty("Depth", "1"); c.setRequestProperty("Content-Type", "application/xml"); c.setDoOutput(true);
            try (OutputStream out = c.getOutputStream()) { out.write("<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:displayname/></d:prop></d:propfind>".getBytes(StandardCharsets.UTF_8)); }
            int code = c.getResponseCode(); if (code == 401) throw new IOException("login"); if (code >= 400) throw new IOException("http " + code);
            String xml; try (InputStream in = c.getInputStream()) { xml = new String(readAll(in), StandardCharsets.UTF_8); }
            List<Entry> out = new ArrayList<>(); String self = norm(path);
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("<(?:\\w+:)?response>(.*?)</(?:\\w+:)?response>", java.util.regex.Pattern.DOTALL).matcher(xml);
            while (m.find()) {
                String r = m.group(1); String href = tag(r, "href"); if (href == null) continue;
                String p = java.net.URLDecoder.decode(href.replaceFirst("^https?://[^/]+", ""), "UTF-8"); String basePath = new URL(base).getPath(); if (!basePath.isEmpty() && p.startsWith(basePath)) p = p.substring(basePath.length());
                boolean dir = r.contains("<d:collection") || r.contains("<D:collection") || r.matches("(?s).*<(?:\\w+:)?collection\\s*/?>.*"); p = norm(p);
                if (p.equals(self)) continue;
                Entry e = new Entry(); e.name = p.substring(p.lastIndexOf('/') + 1); e.dir = dir; String len = tag(r, "getcontentlength"); e.size = len == null || len.trim().isEmpty() ? 0 : Long.parseLong(len.trim()); String lm = tag(r, "getlastmodified"); e.mtime = lm == null ? 0 : parseHttpDate(lm.trim()); out.add(e);
            }
            return out;
        }
        static String tag(String xml, String name) { java.util.regex.Matcher m = java.util.regex.Pattern.compile("<(?:\\w+:)?" + name + "(?:\\s[^>]*)?>(.*?)</(?:\\w+:)?" + name + ">", java.util.regex.Pattern.DOTALL).matcher(xml); return m.find() ? m.group(1).replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">") : null; }
        static long parseHttpDate(String s) { try { return new java.text.SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US).parse(s).getTime(); } catch (Exception e) { return 0; } }
        @Override public InputStream read(String path, long offset) throws Exception { HttpURLConnection c = req("GET", path, offset); int code = c.getResponseCode(); if (code >= 400) throw new IOException("http " + code); return c.getInputStream(); }
        @Override public void write(String path, InputStream in, long size, Progress pr) throws Exception {
            HttpURLConnection c = req("PUT", path, 0); c.setDoOutput(true); if (size >= 0) c.setFixedLengthStreamingMode(size); else c.setChunkedStreamingMode(1 << 16); c.setRequestProperty("Content-Type", "application/octet-stream");
            try (OutputStream out = c.getOutputStream()) { pump(in, out, pr); }
            int code = c.getResponseCode(); if (code >= 400) throw new IOException("http " + code); c.disconnect();
        }
        @Override public void mkdir(String path) throws Exception { HttpURLConnection c = req("MKCOL", path, 0); int code = c.getResponseCode(); if (code >= 400) throw new IOException("http " + code); c.disconnect(); }
        @Override public void delete(String path, boolean dir) throws Exception { HttpURLConnection c = req("DELETE", path, 0); int code = c.getResponseCode(); if (code >= 400) throw new IOException("http " + code); c.disconnect(); }
        @Override public void rename(String from, String to) throws Exception { HttpURLConnection c = req("MOVE", from, 0); c.setRequestProperty("Destination", base + java.net.URLEncoder.encode(norm(to), "UTF-8").replace("%2F", "/").replace("+", "%20")); c.setRequestProperty("Overwrite", "F"); int code = c.getResponseCode(); if (code >= 400) throw new IOException("http " + code); c.disconnect(); }
        @Override public long size(String path) throws Exception { HttpURLConnection c = req("HEAD", path, 0); int code = c.getResponseCode(); if (code >= 400) throw new IOException("http " + code); long n = c.getContentLengthLong(); c.disconnect(); return n; }
        @Override public void close() {}
    }

    static String enc(String s) { try { return java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20"); } catch (Exception e) { return s; } }
    /* ---------- trust: the system's roots, else a certificate the reader accepted by its fingerprint ---------- */
    static javax.net.ssl.X509TrustManager trustManager(final JSONObject o) throws Exception {
        javax.net.ssl.TrustManagerFactory tf = javax.net.ssl.TrustManagerFactory.getInstance(javax.net.ssl.TrustManagerFactory.getDefaultAlgorithm()); tf.init((java.security.KeyStore) null);
        final javax.net.ssl.X509TrustManager sys = (javax.net.ssl.X509TrustManager) tf.getTrustManagers()[0]; final String trusted = o.optString("trust", "");
        return new javax.net.ssl.X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] c, String a) throws java.security.cert.CertificateException { sys.checkClientTrusted(c, a); }
            @Override public void checkServerTrusted(X509Certificate[] c, String a) throws java.security.cert.CertificateException {
                try { sys.checkServerTrusted(c, a); return; } catch (java.security.cert.CertificateException e) { /* ask */ }
                try { String fp = fingerprint(c[0].getEncoded()); if (fp.equals(trusted)) return; throw new java.security.cert.CertificateException("cert:" + fp + ":" + c[0].getSubjectDN().getName()); } catch (java.security.cert.CertificateException e) { throw e; } catch (Exception e) { throw new java.security.cert.CertificateException(e); }
            }
            @Override public X509Certificate[] getAcceptedIssuers() { return sys.getAcceptedIssuers(); }
        };
    }
    /** The message of a failure, with a certificate's or host key's fingerprint surfaced for the page to ask with. */
    static String reason(Throwable e) {
        Throwable c = e; while (c != null) { String m = String.valueOf(c.getMessage()); if (m.startsWith("cert:") || m.startsWith("hostkey:")) return m; c = c.getCause(); }
        String m = e.getMessage(); return m == null ? e.toString() : m;
    }

    /* ---------- the LAN: hosts answering on 445 (SMB), 21 (FTP), 22 (SSH) ---------- */
    static JSONArray scan(Context ctx, AtomicBoolean stop) throws Exception {
        JSONArray out = new JSONArray(); String mine = localIp(); if (mine == null) return out; String prefix = mine.substring(0, mine.lastIndexOf('.') + 1);
        java.util.concurrent.ExecutorService ex = java.util.concurrent.Executors.newFixedThreadPool(48); List<java.util.concurrent.Future<JSONObject>> fs = new ArrayList<>();
        for (int i = 1; i < 255; i++) { final String ip = prefix + i; if (ip.equals(mine)) continue; fs.add(ex.submit(() -> { JSONArray ports = new JSONArray(); for (int port : new int[] { 445, 21, 22, 5000, 8080 }) { if (stop.get()) break; try (Socket s = new Socket()) { s.connect(new InetSocketAddress(ip, port), 350); ports.put(port); } catch (Exception ignored) {} } if (ports.length() == 0) return null; JSONObject o = new JSONObject(); o.put("ip", ip); o.put("ports", ports); try { String n = java.net.InetAddress.getByName(ip).getCanonicalHostName(); if (!n.equals(ip)) o.put("name", n); } catch (Exception ignored) {} return o; })); }
        for (java.util.concurrent.Future<JSONObject> f : fs) { try { JSONObject o = f.get(); if (o != null) out.put(o); } catch (Exception ignored) {} }
        ex.shutdownNow(); return out;
    }
    static String localIp() { try { for (java.net.NetworkInterface ni : java.util.Collections.list(java.net.NetworkInterface.getNetworkInterfaces())) { if (!ni.isUp() || ni.isLoopback()) continue; for (java.net.InetAddress a : java.util.Collections.list(ni.getInetAddresses())) if (a instanceof java.net.Inet4Address && a.isSiteLocalAddress()) return a.getHostAddress(); } } catch (Exception ignored) {} return null; }

    /* ---------- transfers as jobs: down (remote → local folder), up (local → remote folder) ---------- */
    static final Map<String, AtomicBoolean> JOBS = new ConcurrentHashMap<>();
    static void cancel(String id) { AtomicBoolean b = JOBS.get(id); if (b != null) b.set(true); }
    static void transfer(Context ctx, String id, String op, String connId, List<String> paths, String dest, boolean deleteAfter, KtFiles.Events ev) {
        AtomicBoolean stop = new AtomicBoolean(); JOBS.put(id, stop); long[] done = { 0, 0 }; long[] total = { 0, 0 }; final long[] told = { 0 }; List<String> failed = new ArrayList<>();
        try {
            Client c = client(ctx, connId);
            if (op.equals("down")) {
                List<String[]> files = new ArrayList<>(); for (String p : paths) collectRemote(c, p, new File(dest), files, total, stop);
                for (String[] pf : files) { if (stop.get()) break; File out = KtFiles.keepBoth(new File(pf[1])); out.getParentFile().mkdirs(); File part = new File(out.getPath() + ".part"); try { try (InputStream in = c.read(pf[0], 0); OutputStream os = new FileOutputStream(part)) { byte[] b = new byte[1 << 16]; int n; while ((n = in.read(b)) > 0) { os.write(b, 0, n); done[0] += n; if (stop.get()) throw new IOException("stopped"); tell(ev, id, done, total, out.getName(), told); } } if (!part.renameTo(out)) throw new IOException("rename"); done[1]++; if (deleteAfter) c.delete(pf[0], false); } catch (Exception e) { part.delete(); failed.add(pf[0]); if ("stopped".equals(e.getMessage())) break; } }
            } else {
                List<File[]> files = new ArrayList<>(); for (String p : paths) { File f = new File(p); collectLocal(f, norm(dest), files, total); }
                java.util.Set<String> made = new java.util.HashSet<>();
                for (File[] pf : files) { if (stop.get()) break; String rp = pf[1].getPath().replace('\\', '/'); String rdir = rp.substring(0, rp.lastIndexOf('/')); if (!rdir.isEmpty() && made.add(rdir)) mkdirs(c, rdir); try (InputStream in = new FileInputStream(pf[0])) { final String name = pf[0].getName(); c.write(rp, in, pf[0].length(), new Progress() { public void on(long n) { done[0] += n; tell(ev, id, done, total, name, told); } public boolean stopped() { return stop.get(); } }); done[1]++; if (deleteAfter) pf[0].delete(); } catch (Exception e) { failed.add(pf[0].getPath()); if (stop.get()) break; } }
            }
            JSONObject end = new JSONObject(); end.put("id", id); end.put("status", stop.get() ? "cancelled" : "done"); end.put("done", done[0]); end.put("total", total[0]); end.put("files", done[1]); end.put("failed", new JSONArray(failed)); ev.on(end);
        } catch (Exception e) {
            try { JSONObject end = new JSONObject(); end.put("id", id); end.put("status", "failed"); end.put("message", reason(e)); ev.on(end); } catch (Exception ignored) {}
        } finally { JOBS.remove(id); }
    }
    static void tell(KtFiles.Events ev, String id, long[] done, long[] total, String name, long[] told) { long now = System.currentTimeMillis(); if (now - told[0] < 300) return; told[0] = now; try { JSONObject o = new JSONObject(); o.put("id", id); o.put("status", "progress"); o.put("done", done[0]); o.put("total", total[0]); o.put("files", done[1]); o.put("ofFiles", total[1]); o.put("name", name); ev.on(o); } catch (Exception ignored) {} }
    static void collectRemote(Client c, String path, File into, List<String[]> out, long[] total, AtomicBoolean stop) throws Exception {
        if (stop.get()) return; path = norm(path); String name = path.substring(path.lastIndexOf('/') + 1); if (name.isEmpty()) name = "root";
        List<Entry> kids = null; try { kids = c.list(path); } catch (Exception ignored) {}
        boolean dir = false; if (kids != null) { if (kids.isEmpty()) { try { c.size(path); } catch (Exception e) { dir = true; } } else dir = true; }
        // (A file's listing may answer itself on some servers.)
        if (dir && kids.size() == 1 && kids.get(0).name.equals(name) && !kids.get(0).dir) dir = false;
        if (dir) { File sub = new File(into, name); for (Entry e : kids) collectRemote(c, join(path, e.name), sub, out, total, stop); return; }
        long size = 0; try { size = c.size(path); } catch (Exception ignored) {} out.add(new String[] { path, new File(into, name).getPath() }); total[0] += Math.max(0, size); total[1]++;
    }
    static void collectLocal(File f, String rdir, List<File[]> out, long[] total) { if (f.isDirectory()) { File[] k = f.listFiles(); if (k != null) for (File x : k) collectLocal(x, join(rdir, f.getName()), out, total); return; } out.add(new File[] { f, new File(join(rdir, f.getName())) }); total[0] += f.length(); total[1]++; }
    static void mkdirs(Client c, String path) { String[] parts = norm(path).substring(1).split("/"); String at = ""; for (String p : parts) { if (p.isEmpty()) continue; at += "/" + p; try { c.mkdir(at); } catch (Exception ignored) { /* there already */ } } }

    static void pump(InputStream in, OutputStream out, Progress pr) throws IOException { byte[] b = new byte[1 << 16]; int n; while ((n = in.read(b)) > 0) { if (pr != null && pr.stopped()) throw new IOException("stopped"); out.write(b, 0, n); if (pr != null) pr.on(n); } out.flush(); }
    static byte[] readAll(InputStream in) throws IOException { java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream(); byte[] b = new byte[1 << 14]; int n; while ((n = in.read(b)) > 0) bo.write(b, 0, n); return bo.toByteArray(); }
    /** A remote file brought into the app's cache (for opening, playing, installing); the path of the copy. */
    static File fetch(Context ctx, String connId, String path, AtomicBoolean stop, KtFiles.Events ev, String jobId) throws Exception {
        Client c = client(ctx, connId); path = norm(path); String name = path.substring(path.lastIndexOf('/') + 1); File dir = new File(ctx.getCacheDir(), "remote/" + connId + path.substring(0, path.lastIndexOf('/') + 1)); dir.mkdirs(); File out = new File(dir, name);
        long size = -1; try { size = c.size(path); } catch (Exception ignored) {}
        if (out.isFile() && size >= 0 && out.length() == size) return out;
        File part = new File(out.getPath() + ".part"); long[] done = { 0, 0 }; long[] total = { Math.max(0, size), 1 }; long[] told = { 0 };
        try (InputStream in = c.read(path, 0); OutputStream os = new FileOutputStream(part)) { byte[] b = new byte[1 << 16]; int n; while ((n = in.read(b)) > 0) { if (stop != null && stop.get()) throw new IOException("stopped"); os.write(b, 0, n); done[0] += n; if (ev != null) tell(ev, jobId, done, total, name, told); } }
        if (!part.renameTo(out)) throw new IOException("rename"); return out;
    }
}
