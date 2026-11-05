package app.kurokawa.tools;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * A folder of the phone shared on the Wi‑Fi two ways, until stopped: a web page (browse the folders, download with
 * ranges, upload from the browser, make folders, delete) at an address with a random key, and a plain FTP server
 * (user/password chosen by the reader; passive mode; list, get, put, rename, delete, folders) that any file manager
 * or computer connects to. A foreground notification keeps it alive and shows the addresses; a Quick Settings tile
 * turns it on and off. No encryption on either — a home Wi‑Fi's trust, said so in the sheet.
 */
final class KtFolderShare {
    private static final String TAG = "KtFolderShare";
    private static KtFolderShare self;
    static synchronized KtFolderShare get() { if (self == null) self = new KtFolderShare(); return self; }

    private File root; private boolean writable; private String key = ""; private String ftpUser = "", ftpPass = "";
    private ServerSocket web, ftp; private int webPort, ftpPort;
    private volatile long sent = 0, received = 0; private volatile int hits = 0;
    private volatile long ftpSent = 0; private volatile int ftpLogins = 0;

    synchronized void start(Context ctx, File root, boolean writable, boolean withWeb, boolean withFtp, String user, String pass, int wantWeb, int wantFtp) throws IOException {
        stop();
        if (!root.isDirectory()) throw new IOException("notFolder");
        this.root = root; this.writable = writable; this.ftpUser = user == null ? "" : user; this.ftpPass = pass == null ? "" : pass; sent = received = 0; hits = 0; ftpSent = 0; ftpLogins = 0;
        byte[] rnd = new byte[5]; new java.security.SecureRandom().nextBytes(rnd); StringBuilder k = new StringBuilder(); for (byte b : rnd) k.append(String.format("%02x", b)); key = k.toString();
        if (withWeb) { web = bind(wantWeb > 0 ? wantWeb : 8080); webPort = web.getLocalPort(); final ServerSocket s = web; Thread t = new Thread(() -> { while (!s.isClosed()) { try { Socket c = s.accept(); new Thread(() -> serveWeb(c), "kt-fshare-web").start(); } catch (IOException e) { break; } } }, "kt-fshare-web-accept"); t.setDaemon(true); t.start(); }
        if (withFtp) { ftp = bind(wantFtp > 0 ? wantFtp : 2121); ftpPort = ftp.getLocalPort(); final ServerSocket s = ftp; Thread t = new Thread(() -> { while (!s.isClosed()) { try { Socket c = s.accept(); new Thread(() -> serveFtp(c), "kt-fshare-ftp").start(); } catch (IOException e) { break; } } }, "kt-fshare-ftp-accept"); t.setDaemon(true); t.start(); }
        try { ctx.startForegroundService(new Intent(ctx, Fg.class)); } catch (Throwable e) { Log.w(TAG, "fg: " + e); }
    }
    private static ServerSocket bind(int want) throws IOException { try { return new ServerSocket(want, 8, InetAddress.getByName("0.0.0.0")); } catch (IOException e) { return new ServerSocket(0, 8, InetAddress.getByName("0.0.0.0")); } }
    synchronized void stop() { for (ServerSocket s : new ServerSocket[] { web, ftp }) if (s != null) try { s.close(); } catch (IOException ignored) {} web = ftp = null; }
    synchronized void stop(Context ctx) { stop(); try { ctx.stopService(new Intent(ctx, Fg.class)); } catch (Throwable ignored) {} }
    synchronized boolean running() { return (web != null && !web.isClosed()) || (ftp != null && !ftp.isClosed()); }
    synchronized String webUrl() { String ip = KtShare.lanIp(); return ip == null || web == null || web.isClosed() ? null : "http://" + ip + ":" + webPort + "/" + key + "/"; }
    synchronized String ftpUrl() { String ip = KtShare.lanIp(); return ip == null || ftp == null || ftp.isClosed() ? null : "ftp://" + (ftpUser.isEmpty() ? "" : ftpUser + "@") + ip + ":" + ftpPort + "/"; }
    org.json.JSONObject status() throws Exception { org.json.JSONObject o = new org.json.JSONObject(); o.put("running", running()); o.put("web", webUrl()); o.put("ftp", ftpUrl()); o.put("root", root == null ? null : root.getAbsolutePath()); o.put("writable", writable); o.put("sent", sent + ftpSent); o.put("received", received); o.put("hits", hits); o.put("ftpLogins", ftpLogins); o.put("user", ftpUser); return o; }

    /** A path under the root, or null when it would leave it. */
    private File under(String rel) { try { File f = new File(root, rel.replace('\\', '/')).getCanonicalFile(); String r = root.getCanonicalPath(); return f.getPath().equals(r) || f.getPath().startsWith(r + File.separator) ? f : null; } catch (IOException e) { return null; } }
    private static String esc(String s) { return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;"); }
    private static String human(long b) { if (b < 1024) return b + " B"; double v = b / 1024.0; String[] u = { "KB", "MB", "GB", "TB" }; int i = 0; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return String.format(Locale.US, v >= 100 ? "%.0f %s" : "%.1f %s", v, u[i]); }
    private static String enc(String s) { try { return java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20").replace("%2F", "/"); } catch (Exception e) { return s; } }
    private static String dec(String s) { try { return java.net.URLDecoder.decode(s.replace("+", "%2B"), "UTF-8"); } catch (Exception e) { return s; } }
    private static void head(OutputStream out, int code, String text, String type, long len, String extra) throws IOException { out.write(("HTTP/1.1 " + code + " " + text + "\r\n" + (type == null ? "" : "Content-Type: " + type + "\r\n") + (len >= 0 ? "Content-Length: " + len + "\r\n" : "") + (extra == null ? "" : extra) + "Connection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); }

    /* ---------- the web side ---------- */
    private void serveWeb(Socket s) {
        try (Socket sock = s) {
            sock.setSoTimeout(60000); InputStream in = sock.getInputStream(); BufferedOutputStream out = new BufferedOutputStream(sock.getOutputStream(), 1 << 16);
            String line = KtStream.readLine(in); if (line == null) return; String[] req = line.split(" "); if (req.length < 2) return; String method = req[0], path = req[1];
            long rangeStart = 0, rangeEnd = -1, length = -1; boolean ranged = false; String ctype = "";
            for (String h; (h = KtStream.readLine(in)) != null && !h.isEmpty(); ) { String l = h.toLowerCase(Locale.ROOT); if (l.startsWith("range:")) { String v = h.substring(6).trim().replace("bytes=", ""); String[] p = v.split("-"); try { rangeStart = Long.parseLong(p[0].trim()); if (p.length > 1 && !p[1].trim().isEmpty()) rangeEnd = Long.parseLong(p[1].trim()); ranged = true; } catch (Exception ignored) {} } else if (l.startsWith("content-length:")) length = Long.parseLong(h.substring(15).trim()); else if (l.startsWith("content-type:")) ctype = h.substring(13).trim(); }
            String prefix = "/" + key + "/";
            if (!path.startsWith(prefix)) { head(out, 404, "Not Found", null, 0, null); out.flush(); return; }
            String rest = path.substring(prefix.length()); String query = ""; int q = rest.indexOf('?'); if (q >= 0) { query = rest.substring(q + 1); rest = rest.substring(0, q); }
            hits++;
            if (rest.startsWith("d/")) { File f = under(dec(rest.substring(2))); if (f == null || !f.isFile()) { head(out, 404, "Not Found", null, 0, null); out.flush(); return; } sendFile(f, method, ranged, rangeStart, rangeEnd, out, true); return; }
            if (rest.startsWith("v/")) { File f = under(dec(rest.substring(2))); if (f == null || !f.isFile()) { head(out, 404, "Not Found", null, 0, null); out.flush(); return; } sendFile(f, method, ranged, rangeStart, rangeEnd, out, false); return; }
            if (rest.startsWith("up/") && method.equals("POST")) {
                File dir = under(dec(rest.substring(3))); if (!writable || dir == null || !dir.isDirectory()) { head(out, 403, "Forbidden", "text/plain", 0, null); out.flush(); return; }
                int n = receiveMultipart(in, length, ctype, dir); byte[] body = ("{\"files\":" + n + "}").getBytes(StandardCharsets.UTF_8); head(out, 200, "OK", "application/json", body.length, null); out.write(body); out.flush(); return;
            }
            if (rest.startsWith("mk/") && method.equals("POST")) { File dir = under(dec(rest.substring(3))); String name = dec(param(query, "name")); if (!writable || dir == null || name.isEmpty() || name.contains("/") || name.contains("..")) { head(out, 403, "Forbidden", null, 0, null); out.flush(); return; } new File(dir, name).mkdirs(); head(out, 200, "OK", null, 0, null); out.flush(); return; }
            if (rest.startsWith("rm/") && method.equals("POST")) { File f = under(dec(rest.substring(3))); if (!writable || f == null || f.equals(root)) { head(out, 403, "Forbidden", null, 0, null); out.flush(); return; } KtArchive.deleteTree(f); head(out, 200, "OK", null, 0, null); out.flush(); return; }
            // the listing: a page, or JSON when asked (?json=1)
            String relDir = rest.startsWith("b/") ? dec(rest.substring(2)) : ""; File dir = under(relDir); if (dir == null || !dir.isDirectory()) { head(out, 404, "Not Found", null, 0, null); out.flush(); return; }
            File[] kids = dir.listFiles(); if (kids == null) kids = new File[0]; java.util.Arrays.sort(kids, (a, b) -> a.isDirectory() != b.isDirectory() ? (a.isDirectory() ? -1 : 1) : a.getName().compareToIgnoreCase(b.getName()));
            String relClean = relDir.replaceAll("^/+|/+$", "");
            if (query.contains("json=1")) { org.json.JSONArray a = new org.json.JSONArray(); for (File k : kids) { if (k.getName().startsWith(".")) continue; org.json.JSONObject o = new org.json.JSONObject(); o.put("name", k.getName()); o.put("dir", k.isDirectory()); o.put("size", k.isFile() ? k.length() : 0); o.put("mtime", k.lastModified()); a.put(o); } byte[] body = a.toString().getBytes(StandardCharsets.UTF_8); head(out, 200, "OK", "application/json; charset=utf-8", body.length, null); out.write(body); out.flush(); return; }
            StringBuilder html = new StringBuilder("<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>" + esc(root.getName()) + "</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#111;color:#eee}header{padding:14px 18px;background:#1c1c1e;position:sticky;top:0;display:flex;gap:10px;align-items:center;flex-wrap:wrap}h1{font-size:17px;margin:0;flex:1}a{color:#9ecbff;text-decoration:none}ul{list-style:none;margin:0;padding:8px}li{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px}li:hover{background:#1c1c1e}li span.n{flex:1;word-break:break-all}li small{color:#9a9a9a}button{background:#2d2d30;color:#eee;border:0;border-radius:20px;padding:8px 14px;font:inherit}button.x{padding:6px 10px}input[type=file]{display:none}.crumbs a{margin-inline-end:6px}#drop{border:2px dashed #444;border-radius:16px;margin:10px;padding:16px;text-align:center;color:#9a9a9a}#drop.on{border-color:#9ecbff;color:#eee}</style></head><body>");
            html.append("<header><h1>").append(esc(root.getName())).append("</h1>");
            if (writable) html.append("<label><button type=button onclick=\"document.getElementById('f').click()\">Upload</button><input id=f type=file multiple onchange=\"up(this.files)\"></label><button type=button onclick=\"mk()\">New folder</button>");
            html.append("</header><div class=crumbs style='padding:8px 18px'><a href='").append(prefix).append("'>").append(esc(root.getName())).append("</a>");
            String acc = ""; for (String part : relClean.isEmpty() ? new String[0] : relClean.split("/")) { acc = acc.isEmpty() ? part : acc + "/" + part; html.append("› <a href='").append(prefix).append("b/").append(enc(acc)).append("'>").append(esc(part)).append("</a> "); }
            html.append("</div>");
            if (writable) html.append("<div id=drop>Drop files here to upload</div>");
            html.append("<ul>");
            for (File k : kids) {
                if (k.getName().startsWith(".")) continue; String rel = (relClean.isEmpty() ? "" : relClean + "/") + k.getName();
                if (k.isDirectory()) html.append("<li>📁 <a class=n href='").append(prefix).append("b/").append(enc(rel)).append("'>").append(esc(k.getName())).append("</a>");
                else html.append("<li>📄 <span class=n><a href='").append(prefix).append("v/").append(enc(rel)).append("'>").append(esc(k.getName())).append("</a></span><small>").append(human(k.length())).append("</small><a href='").append(prefix).append("d/").append(enc(rel)).append("' download>⬇</a>");
                if (writable) html.append("<button class=x type=button onclick=\"rm('").append(enc(rel).replace("'", "%27")).append("')\">✕</button>");
                html.append("</li>");
            }
            html.append("</ul><script>const P='").append(prefix).append("',D='").append(enc(relClean)).append("';function up(fs){if(!fs||!fs.length)return;const fd=new FormData();for(const f of fs)fd.append('file',f,f.name);fetch(P+'up/'+D,{method:'POST',body:fd}).then(()=>location.reload())}function mk(){const n=prompt('Folder name');if(n)fetch(P+'mk/'+D+'?name='+encodeURIComponent(n),{method:'POST'}).then(()=>location.reload())}function rm(r){if(confirm('Delete?'))fetch(P+'rm/'+r,{method:'POST'}).then(()=>location.reload())}const d=document.getElementById('drop');if(d){d.ondragover=e=>{e.preventDefault();d.classList.add('on')};d.ondragleave=()=>d.classList.remove('on');d.ondrop=e=>{e.preventDefault();d.classList.remove('on');up(e.dataTransfer.files)}}</script></body></html>");
            byte[] body = html.toString().getBytes(StandardCharsets.UTF_8); head(out, 200, "OK", "text/html; charset=utf-8", body.length, null); if (!method.equals("HEAD")) out.write(body); out.flush();
        } catch (Exception e) { Log.d(TAG, "web: " + e); }
    }
    private static String param(String q, String k) { for (String kv : q.split("&")) { int i = kv.indexOf('='); if (i > 0 && kv.substring(0, i).equals(k)) return kv.substring(i + 1); } return ""; }
    private void sendFile(File lf, String method, boolean ranged, long rangeStart, long rangeEnd, OutputStream out, boolean attachment) throws IOException {
        long lsize = lf.length(); if (rangeEnd < 0 || rangeEnd >= lsize) rangeEnd = lsize - 1;
        if (rangeStart > rangeEnd) { head(out, 416, "Range Not Satisfiable", null, 0, "Content-Range: bytes */" + lsize + "\r\n"); out.flush(); return; }
        long llen = rangeEnd - rangeStart + 1;
        out.write(((ranged ? "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes " + rangeStart + "-" + rangeEnd + "/" + lsize + "\r\n" : "HTTP/1.1 200 OK\r\n") + "Content-Type: " + KtStream.mimeOf(lf.getName()) + "\r\nAccept-Ranges: bytes\r\nContent-Length: " + llen + (attachment ? "\r\nContent-Disposition: attachment; filename*=UTF-8''" + enc(lf.getName()) : "") + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        if (method.equals("HEAD")) { out.flush(); return; }
        try (RandomAccessFile raf = new RandomAccessFile(lf, "r")) { raf.seek(rangeStart); byte[] b = new byte[1 << 17]; long left = llen; while (left > 0) { int n = raf.read(b, 0, (int) Math.min(b.length, left)); if (n <= 0) break; out.write(b, 0, n); left -= n; sent += n; } }
        out.flush();
    }
    /** multipart/form-data parts named `file` written into `dir` (names kept; a taken name gets « (2)»). */
    private int receiveMultipart(InputStream in, long length, String ctype, File dir) throws IOException {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("boundary=\"?([^\";]+)").matcher(ctype); if (!m.find()) throw new IOException("noBoundary");
        byte[] boundary = ("\r\n--" + m.group(1)).getBytes(StandardCharsets.US_ASCII); int n = 0;
        // (The body is read in full through a window that looks for the boundary; files of any size, one at a time.)
        java.io.PushbackInputStream p = new java.io.PushbackInputStream(in, 1 << 16);
        // first boundary line
        String first = KtStream.readLine(p); if (first == null) return 0;
        while (true) {
            String name = null; String h;
            while ((h = KtStream.readLine(p)) != null && !h.isEmpty()) { java.util.regex.Matcher fm = java.util.regex.Pattern.compile("filename\\*?=\"?([^\";]+)").matcher(h); if (h.toLowerCase(Locale.ROOT).startsWith("content-disposition") && fm.find()) name = dec(fm.group(1).replaceFirst("^UTF-8''", "")); }
            if (h == null) break;
            File out = name == null || name.isEmpty() ? null : KtFiles.keepBoth(new File(dir, new File(name).getName()));
            try (OutputStream os = out == null ? new java.io.ByteArrayOutputStream() : new BufferedOutputStream(new FileOutputStream(out), 1 << 16)) {
                // copy until the boundary
                int matched = 0; byte[] buf = new byte[1 << 16];
                while (true) {
                    int c = p.read(); if (c < 0) { os.flush(); return n; }
                    if (c == boundary[matched]) { matched++; if (matched == boundary.length) break; }
                    else { if (matched > 0) { os.write(boundary, 0, matched); if (out != null) received += matched; matched = 0; if (c == boundary[0]) { matched = 1; continue; } } os.write(c); if (out != null) received++; }
                }
            }
            if (out != null) n++;
            String tail = KtStream.readLine(p); if (tail == null || tail.startsWith("--")) break;
        }
        return n;
    }

    /* ---------- the FTP side (RFC 959, passive mode, UTF-8 names) ---------- */
    private void serveFtp(Socket s) {
        ServerSocket pasv = null;
        try (Socket sock = s) {
            sock.setSoTimeout(300000); InputStream in = sock.getInputStream(); OutputStream out = sock.getOutputStream();
            java.io.PrintWriter w = new java.io.PrintWriter(new java.io.OutputStreamWriter(out, StandardCharsets.UTF_8), true) { @Override public void println(String x) { print(x + "\r\n"); flush(); } };
            w.println("220 Kurokawa Tools"); String cwd = "/"; String user = ""; boolean ok = ftpUser.isEmpty() && ftpPass.isEmpty(); File rnfr = null; long rest = 0;
            for (String line; (line = KtStream.readLine(in)) != null; ) {
                String cmd = line.trim(), arg = ""; int sp = cmd.indexOf(' '); if (sp > 0) { arg = cmd.substring(sp + 1).trim(); cmd = cmd.substring(0, sp); } cmd = cmd.toUpperCase(Locale.ROOT);
                if (cmd.equals("USER")) { user = arg; if (ok) w.println("230 Logged in"); else w.println("331 Password"); continue; }
                if (cmd.equals("PASS")) { if (ok || (user.equals(ftpUser) && arg.equals(ftpPass))) { ok = true; ftpLogins++; w.println("230 Logged in"); } else w.println("530 Login incorrect"); continue; }
                if (cmd.equals("QUIT")) { w.println("221 Bye"); return; }
                if (!ok) { w.println("530 Please login"); continue; }
                switch (cmd) {
                    case "SYST": w.println("215 UNIX Type: L8"); break;
                    case "FEAT": w.println("211-Features\r\n UTF8\r\n SIZE\r\n REST STREAM\r\n MLSD\r\n EPSV\r\n211 End"); break;
                    case "OPTS": w.println("200 OK"); break;
                    case "NOOP": w.println("200 OK"); break;
                    case "TYPE": w.println("200 Type set"); break;
                    case "PWD": case "XPWD": w.println("257 \"" + cwd.replace("\"", "\"\"") + "\""); break;
                    case "CWD": case "XCWD": { String to = resolve(cwd, arg); File f = under(to); if (f != null && f.isDirectory()) { cwd = to; w.println("250 OK"); } else w.println("550 No such folder"); break; }
                    case "CDUP": case "XCUP": cwd = resolve(cwd, ".."); w.println("250 OK"); break;
                    case "PASV": { if (pasv != null) pasv.close(); pasv = new ServerSocket(0, 1, InetAddress.getByName("0.0.0.0")); String ip = KtShare.lanIp(); if (ip == null) ip = "127.0.0.1"; int p = pasv.getLocalPort(); w.println("227 Entering Passive Mode (" + ip.replace('.', ',') + "," + (p >> 8) + "," + (p & 255) + ")"); break; }
                    case "EPSV": { if (pasv != null) pasv.close(); pasv = new ServerSocket(0, 1, InetAddress.getByName("0.0.0.0")); w.println("229 Entering Extended Passive Mode (|||" + pasv.getLocalPort() + "|)"); break; }
                    case "PORT": case "EPRT": w.println("502 Passive only"); break;
                    case "LIST": case "NLST": case "MLSD": {
                        String target = arg.startsWith("-") || arg.isEmpty() ? cwd : resolve(cwd, arg); File d = under(target); if (d == null || !d.exists()) { w.println("550 No such folder"); break; }
                        if (pasv == null) { w.println("425 Use PASV first"); break; }
                        w.println("150 Here comes the listing"); try (Socket data = accept(pasv); OutputStream dout = new BufferedOutputStream(data.getOutputStream())) {
                            File[] kids = d.isDirectory() ? d.listFiles() : new File[] { d }; if (kids == null) kids = new File[0]; StringBuilder sb = new StringBuilder();
                            for (File k : kids) { if (cmd.equals("NLST")) sb.append(k.getName()).append("\r\n"); else if (cmd.equals("MLSD")) sb.append("type=").append(k.isDirectory() ? "dir" : "file").append(";size=").append(k.isFile() ? k.length() : 0).append(";modify=").append(mlsdTime(k.lastModified())).append("; ").append(k.getName()).append("\r\n"); else sb.append(k.isDirectory() ? "drwxr-xr-x" : "-rw-r--r--").append(" 1 kurokawa kurokawa ").append(String.format(Locale.US, "%13d", k.isFile() ? k.length() : 4096)).append(' ').append(lsTime(k.lastModified())).append(' ').append(k.getName()).append("\r\n"); }
                            dout.write(sb.toString().getBytes(StandardCharsets.UTF_8)); dout.flush();
                        } finally { pasv.close(); pasv = null; }
                        w.println("226 Done"); break;
                    }
                    case "SIZE": { File f = under(resolve(cwd, arg)); if (f != null && f.isFile()) w.println("213 " + f.length()); else w.println("550 No such file"); break; }
                    case "MDTM": { File f = under(resolve(cwd, arg)); if (f != null && f.exists()) w.println("213 " + mlsdTime(f.lastModified())); else w.println("550 No such file"); break; }
                    case "REST": try { rest = Long.parseLong(arg); w.println("350 Restarting at " + rest); } catch (Exception e) { w.println("501 Bad offset"); } break;
                    case "RETR": {
                        File f = under(resolve(cwd, arg)); if (f == null || !f.isFile()) { w.println("550 No such file"); break; } if (pasv == null) { w.println("425 Use PASV first"); break; }
                        w.println("150 Opening data connection"); try (Socket data = accept(pasv); OutputStream dout = new BufferedOutputStream(data.getOutputStream(), 1 << 16); RandomAccessFile raf = new RandomAccessFile(f, "r")) { raf.seek(rest); byte[] b = new byte[1 << 16]; int n; while ((n = raf.read(b)) > 0) { dout.write(b, 0, n); ftpSent += n; } dout.flush(); } finally { pasv.close(); pasv = null; rest = 0; }
                        w.println("226 Done"); break;
                    }
                    case "STOR": case "APPE": {
                        File f = under(resolve(cwd, arg)); if (!writable || f == null || f.isDirectory()) { w.println("550 Not allowed"); break; } if (pasv == null) { w.println("425 Use PASV first"); break; }
                        w.println("150 Ready"); try (Socket data = accept(pasv); InputStream din = data.getInputStream(); RandomAccessFile raf = new RandomAccessFile(f, "rw")) { if (cmd.equals("APPE")) raf.seek(raf.length()); else if (rest > 0) raf.seek(rest); else raf.setLength(0); byte[] b = new byte[1 << 16]; int n; while ((n = din.read(b)) > 0) { raf.write(b, 0, n); received += n; } } finally { pasv.close(); pasv = null; rest = 0; }
                        w.println("226 Done"); break;
                    }
                    case "DELE": { File f = under(resolve(cwd, arg)); if (writable && f != null && f.isFile() && f.delete()) w.println("250 Deleted"); else w.println("550 Not allowed"); break; }
                    case "RMD": case "XRMD": { File f = under(resolve(cwd, arg)); if (writable && f != null && f.isDirectory() && !f.equals(root)) { KtArchive.deleteTree(f); w.println("250 Removed"); } else w.println("550 Not allowed"); break; }
                    case "MKD": case "XMKD": { File f = under(resolve(cwd, arg)); if (writable && f != null && (f.isDirectory() || f.mkdirs())) w.println("257 \"" + resolve(cwd, arg) + "\" created"); else w.println("550 Not allowed"); break; }
                    case "RNFR": { rnfr = under(resolve(cwd, arg)); if (writable && rnfr != null && rnfr.exists()) w.println("350 Ready"); else { rnfr = null; w.println("550 No such file"); } break; }
                    case "RNTO": { File to = under(resolve(cwd, arg)); if (rnfr != null && to != null && !to.exists() && rnfr.renameTo(to)) w.println("250 Renamed"); else w.println("550 Cannot rename"); rnfr = null; break; }
                    default: w.println("502 Not implemented");
                }
            }
        } catch (Exception e) { Log.d(TAG, "ftp: " + e); }
        finally { if (pasv != null) try { pasv.close(); } catch (IOException ignored) {} }
    }
    private static Socket accept(ServerSocket pasv) throws IOException { pasv.setSoTimeout(15000); Socket d = pasv.accept(); d.setSoTimeout(120000); return d; }
    private static String resolve(String cwd, String arg) { String p = arg.startsWith("/") ? arg : (cwd.endsWith("/") ? cwd : cwd + "/") + arg; java.util.ArrayDeque<String> parts = new java.util.ArrayDeque<>(); for (String x : p.split("/")) { if (x.isEmpty() || x.equals(".")) continue; if (x.equals("..")) { if (!parts.isEmpty()) parts.removeLast(); continue; } parts.addLast(x); } return "/" + String.join("/", parts); }
    private static String mlsdTime(long t) { java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("yyyyMMddHHmmss", Locale.US); f.setTimeZone(java.util.TimeZone.getTimeZone("UTC")); return f.format(new java.util.Date(t)); }
    private static String lsTime(long t) { boolean recent = System.currentTimeMillis() - t < 180L * 86400000L; return new java.text.SimpleDateFormat(recent ? "MMM dd HH:mm" : "MMM dd  yyyy", Locale.US).format(new java.util.Date(t)); }

    /* ---------- the notification that keeps it alive ---------- */
    public static class Fg extends Service {
        static final int NOTE = 8311; static final String CH = "kt_share"; static final String ACT_STOP = "app.kurokawa.tools.SHARE_STOP";
        @Override public IBinder onBind(Intent i) { return null; }
        @Override public int onStartCommand(Intent i, int flags, int id) {
            if (i != null && ACT_STOP.equals(i.getAction())) { get().stop(); stopSelf(); return START_NOT_STICKY; }
            if (Build.VERSION.SDK_INT >= 26) { android.app.NotificationManager nm = getSystemService(android.app.NotificationManager.class); if (nm != null && nm.getNotificationChannel(CH) == null) nm.createNotificationChannel(new android.app.NotificationChannel(CH, KtService.ar(this) ? "مشاركة المجلدات" : "Folder sharing", android.app.NotificationManager.IMPORTANCE_LOW)); }
            KtFolderShare fs = get(); boolean ar = KtService.ar(this); String web = fs.webUrl(), ftp = fs.ftpUrl();
            String text = (web == null ? "" : web) + (web != null && ftp != null ? "  ·  " : "") + (ftp == null ? "" : ftp);
            PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, Fg.class).setAction(ACT_STOP), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification n = new NotificationCompat.Builder(this, CH).setSmallIcon(android.R.drawable.stat_sys_upload).setContentTitle(ar ? "المجلد مُشارَك على الشبكة" : "Folder shared on the network").setContentText(text).setStyle(new NotificationCompat.BigTextStyle().bigText(text)).setOngoing(true).setContentIntent(KtService.openApp(this)).addAction(0, ar ? "إيقاف" : "Stop", stop).build();
            try { if (Build.VERSION.SDK_INT >= 34) startForeground(NOTE, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE); else startForeground(NOTE, n); } catch (Throwable e) { Log.w(TAG, "startForeground: " + e); }
            return START_STICKY;
        }
        @Override public void onDestroy() { get().stop(); super.onDestroy(); }
    }
    /** The Quick Settings tile: on → off; off → the last folder shared (or the app's Downloads), both ways, read-only. */
    public static class TileSvc extends android.service.quicksettings.TileService {
        @Override public void onStartListening() { show(); }
        @Override public void onClick() {
            KtFolderShare fs = get();
            if (fs.running()) fs.stop(this);
            else { try { android.content.SharedPreferences sp = getSharedPreferences("kt-fshare", MODE_PRIVATE); String last = sp.getString("root", null); File root = last != null && new File(last).isDirectory() ? new File(last) : KtEngine.defaultDirOf(this); fs.start(this, root, sp.getBoolean("writable", false), true, true, sp.getString("user", ""), sp.getString("pass", ""), sp.getInt("webPort", 8080), sp.getInt("ftpPort", 2121)); } catch (Exception e) { Log.w(TAG, "tile: " + e); } }
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(this::show, 400);
        }
        private void show() { android.service.quicksettings.Tile t = getQsTile(); if (t == null) return; t.setState(get().running() ? android.service.quicksettings.Tile.STATE_ACTIVE : android.service.quicksettings.Tile.STATE_INACTIVE); t.updateTile(); }
    }
}
