package app.kurokawa.tools;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Cloud storages behind the Files add-on's one client face (see KtRemote): Google Drive, Dropbox and OneDrive
 * through OAuth 2 with PKCE and the reader's own app registration (a client id — these services hand them out to
 * whoever registers an app; the app ships none), and Nextcloud/ownCloud through its Login Flow v2 (no client id:
 * the server mints an app password) over WebDAV. Tokens live with the connection in the encrypted store; a
 * refresh token renews the access token when it runs out. Paths are the service's own folders by name.
 */
final class KtCloud {
    /** Where each service's sign-in goes and what it needs. The redirect is intercepted inside the sign-in WebView, so nothing listens on it. */
    static final class Oauth { String auth, token, scope, redirect; }
    static Oauth oauth(String kind) {
        Oauth o = new Oauth();
        switch (kind) {
            case "gdrive": o.auth = "https://accounts.google.com/o/oauth2/v2/auth"; o.token = "https://oauth2.googleapis.com/token"; o.scope = "https://www.googleapis.com/auth/drive"; o.redirect = "http://127.0.0.1:8976/oauth"; break;
            case "dropbox": o.auth = "https://www.dropbox.com/oauth2/authorize"; o.token = "https://api.dropboxapi.com/oauth2/token"; o.scope = ""; o.redirect = "http://localhost:8976/oauth"; break;
            case "onedrive": o.auth = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"; o.token = "https://login.microsoftonline.com/common/oauth2/v2.0/token"; o.scope = "Files.ReadWrite.All offline_access"; o.redirect = "http://localhost:8976/oauth"; break;
            default: return null;
        }
        return o;
    }
    static String b64url(byte[] b) { return android.util.Base64.encodeToString(b, android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP | android.util.Base64.NO_PADDING); }
    static String enc(String s) { try { return URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { return s; } }
    /** The sign-in address for a connection and the verifier to keep until the code comes back: [url, verifier]. */
    static String[] beginAuth(JSONObject c) throws Exception {
        Oauth o = oauth(c.getString("kind")); if (o == null) throw new IOException("noOauth"); String clientId = c.optString("clientId", ""); if (clientId.isEmpty()) throw new IOException("clientIdNeeded");
        byte[] v = new byte[48]; new SecureRandom().nextBytes(v); String verifier = b64url(v); String challenge = b64url(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
        StringBuilder u = new StringBuilder(o.auth).append("?response_type=code&client_id=").append(enc(clientId)).append("&redirect_uri=").append(enc(o.redirect)).append("&code_challenge=").append(challenge).append("&code_challenge_method=S256");
        if (!o.scope.isEmpty()) u.append("&scope=").append(enc(o.scope));
        if (c.getString("kind").equals("gdrive")) u.append("&access_type=offline&prompt=consent"); if (c.getString("kind").equals("dropbox")) u.append("&token_access_type=offline");
        return new String[] { u.toString(), verifier };
    }
    /** The code from the redirect swapped for tokens, written into the connection (access, refresh, expiry). */
    static void finishAuth(JSONObject c, String redirectedUrl, String verifier) throws Exception {
        Oauth o = oauth(c.getString("kind")); java.util.regex.Matcher m = java.util.regex.Pattern.compile("[?&#]code=([^&#]+)").matcher(redirectedUrl); if (!m.find()) { java.util.regex.Matcher e = java.util.regex.Pattern.compile("[?&#]error=([^&#]+)").matcher(redirectedUrl); throw new IOException(e.find() ? java.net.URLDecoder.decode(e.group(1), "UTF-8") : "noCode"); }
        String body = "grant_type=authorization_code&code=" + enc(java.net.URLDecoder.decode(m.group(1), "UTF-8")) + "&redirect_uri=" + enc(o.redirect) + "&client_id=" + enc(c.optString("clientId", "")) + "&code_verifier=" + enc(verifier) + (c.optString("clientSecret", "").isEmpty() ? "" : "&client_secret=" + enc(c.optString("clientSecret", "")));
        JSONObject t = post(o.token, body); c.put("access", t.getString("access_token")); if (t.has("refresh_token")) c.put("refresh", t.getString("refresh_token")); c.put("expires", System.currentTimeMillis() + t.optLong("expires_in", 3600) * 1000L - 60000);
    }
    static void refresh(JSONObject c) throws Exception {
        Oauth o = oauth(c.getString("kind")); String r = c.optString("refresh", ""); if (r.isEmpty()) throw new IOException("login");
        JSONObject t = post(o.token, "grant_type=refresh_token&refresh_token=" + enc(r) + "&client_id=" + enc(c.optString("clientId", "")) + (c.optString("clientSecret", "").isEmpty() ? "" : "&client_secret=" + enc(c.optString("clientSecret", ""))));
        c.put("access", t.getString("access_token")); if (t.has("refresh_token")) c.put("refresh", t.getString("refresh_token")); c.put("expires", System.currentTimeMillis() + t.optLong("expires_in", 3600) * 1000L - 60000);
    }
    static JSONObject post(String url, String form) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection(); h.setConnectTimeout(15000); h.setReadTimeout(30000); h.setDoOutput(true); h.setRequestMethod("POST"); h.setRequestProperty("Content-Type", "application/x-www-form-urlencoded"); h.setRequestProperty("Accept", "application/json");
        try (OutputStream out = h.getOutputStream()) { out.write(form.getBytes(StandardCharsets.UTF_8)); }
        int code = h.getResponseCode(); String text = new String(KtRemote.readAll(code >= 400 ? h.getErrorStream() : h.getInputStream()), StandardCharsets.UTF_8);
        if (code >= 400) { try { JSONObject e = new JSONObject(text); throw new IOException(e.optString("error_description", e.optString("error", "http " + code))); } catch (org.json.JSONException x) { throw new IOException("http " + code); } }
        return new JSONObject(text);
    }

    /* ---------- Nextcloud / ownCloud Login Flow v2: the server mints an app password after the reader signs in ---------- */
    static JSONObject nextcloudBegin(String server) throws Exception {
        if (!server.startsWith("http")) server = "https://" + server; server = server.replaceAll("/+$", "");
        HttpURLConnection h = (HttpURLConnection) new URL(server + "/index.php/login/v2").openConnection(); h.setRequestMethod("POST"); h.setConnectTimeout(15000); h.setReadTimeout(30000); h.setRequestProperty("User-Agent", "Kurokawa Tools");
        int code = h.getResponseCode(); if (code >= 400) throw new IOException("http " + code);
        JSONObject r = new JSONObject(new String(KtRemote.readAll(h.getInputStream()), StandardCharsets.UTF_8)); r.put("server", server); return r; // {poll:{token,endpoint}, login}
    }
    /** Polled until the server hands over the account (null while the reader is still signing in). */
    static JSONObject nextcloudPoll(JSONObject begin) throws Exception {
        JSONObject p = begin.getJSONObject("poll"); HttpURLConnection h = (HttpURLConnection) new URL(p.getString("endpoint")).openConnection(); h.setRequestMethod("POST"); h.setDoOutput(true); h.setConnectTimeout(15000); h.setReadTimeout(30000); h.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
        try (OutputStream out = h.getOutputStream()) { out.write(("token=" + enc(p.getString("token"))).getBytes(StandardCharsets.UTF_8)); }
        int code = h.getResponseCode(); if (code == 404) return null; if (code >= 400) throw new IOException("http " + code);
        return new JSONObject(new String(KtRemote.readAll(h.getInputStream()), StandardCharsets.UTF_8)); // {server, loginName, appPassword}
    }

    /* ---------- the REST clients ---------- */
    static abstract class Rest implements KtRemote.Client {
        final Context ctx; final JSONObject c; Rest(Context ctx, JSONObject c) { this.ctx = ctx; this.c = c; }
        String token() throws Exception { if (c.optLong("expires", 0) < System.currentTimeMillis()) { refresh(c); KtRemote.save(ctx, c); } return c.optString("access", ""); }
        HttpURLConnection req(String method, String url, String contentType) throws Exception {
            HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection(); h.setConnectTimeout(15000); h.setReadTimeout(60000); h.setInstanceFollowRedirects(true);
            try { h.setRequestMethod(method); } catch (java.net.ProtocolException e) { KtRemote.Dav.setMethod(h, method); }
            h.setRequestProperty("Authorization", "Bearer " + token()); if (contentType != null) h.setRequestProperty("Content-Type", contentType); h.setRequestProperty("User-Agent", "Kurokawa Tools"); return h;
        }
        JSONObject json(HttpURLConnection h, String body) throws Exception {
            if (body != null) { h.setDoOutput(true); try (OutputStream out = h.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); } }
            int code = h.getResponseCode(); if (code == 401) throw new IOException("login"); byte[] data = KtRemote.readAll(code >= 400 ? (h.getErrorStream() == null ? new java.io.ByteArrayInputStream(new byte[0]) : h.getErrorStream()) : h.getInputStream());
            if (code >= 400) throw new IOException(errorText(code, new String(data, StandardCharsets.UTF_8))); String text = new String(data, StandardCharsets.UTF_8); return text.trim().isEmpty() ? new JSONObject() : new JSONObject(text);
        }
        static String errorText(int code, String body) { try { JSONObject e = new JSONObject(body); if (e.has("error_summary")) return e.getString("error_summary"); JSONObject er = e.optJSONObject("error"); if (er != null) return er.optString("message", "http " + code); return e.optString("message", "http " + code); } catch (Exception x) { return "http " + code; } }
        static long when(String iso) { try { return java.time.Instant.parse(iso).toEpochMilli(); } catch (Exception e) { return 0; } }
        void pumpTo(InputStream in, OutputStream out, KtRemote.Progress pr) throws IOException { KtRemote.pump(in, out, pr); }
        @Override public void close() {}
    }

    /** Google Drive: folders by name, resolved to ids (cached); «Shared with me» as a folder of the root. */
    static final class GDrive extends Rest {
        static final String API = "https://www.googleapis.com/drive/v3/"; final Map<String, String> ids = new ConcurrentHashMap<>(); static final String SHARED = "Shared with me";
        GDrive(Context ctx, JSONObject c) { super(ctx, c); ids.put("/", "root"); }
        String idOf(String path) throws Exception {
            path = KtRemote.norm(path); String had = ids.get(path); if (had != null) return had; if (path.equals("/" + SHARED)) return "sharedWithMe";
            String parent = path.substring(0, Math.max(1, path.lastIndexOf('/'))); String name = path.substring(path.lastIndexOf('/') + 1); String pid = idOf(parent);
            JSONObject r = json(req("GET", API + "files?q=" + enc((pid.equals("sharedWithMe") ? "sharedWithMe=true" : "'" + pid + "' in parents") + " and name='" + name.replace("'", "\\'") + "' and trashed=false") + "&fields=files(id)&pageSize=2&supportsAllDrives=true&includeItemsFromAllDrives=true", null), null);
            JSONArray fs = r.optJSONArray("files"); if (fs == null || fs.length() == 0) throw new java.io.FileNotFoundException(path); String id = fs.getJSONObject(0).getString("id"); ids.put(path, id); return id;
        }
        @Override public List<KtRemote.Entry> list(String path) throws Exception {
            String pid = idOf(path); List<KtRemote.Entry> out = new ArrayList<>(); String token = null;
            if (pid.equals("root") && KtRemote.norm(path).equals("/")) { KtRemote.Entry s = new KtRemote.Entry(); s.name = SHARED; s.dir = true; out.add(s); }
            do {
                JSONObject r = json(req("GET", API + "files?q=" + enc(pid.equals("sharedWithMe") ? "sharedWithMe=true and trashed=false" : "'" + pid + "' in parents and trashed=false") + "&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime)&pageSize=500&supportsAllDrives=true&includeItemsFromAllDrives=true" + (token == null ? "" : "&pageToken=" + enc(token)), null), null);
                JSONArray fs = r.optJSONArray("files"); if (fs != null) for (int i = 0; i < fs.length(); i++) { JSONObject f = fs.getJSONObject(i); KtRemote.Entry e = new KtRemote.Entry(); e.name = f.getString("name"); e.dir = "application/vnd.google-apps.folder".equals(f.optString("mimeType")); e.size = f.optLong("size", 0); e.mtime = when(f.optString("modifiedTime")); ids.put(KtRemote.join(path, e.name), f.getString("id")); out.add(e); }
                token = r.optString("nextPageToken", null); if (token != null && token.isEmpty()) token = null;
            } while (token != null);
            return out;
        }
        @Override public InputStream read(String path, long offset) throws Exception { HttpURLConnection h = req("GET", API + "files/" + idOf(path) + "?alt=media&supportsAllDrives=true", null); if (offset > 0) h.setRequestProperty("Range", "bytes=" + offset + "-"); int code = h.getResponseCode(); if (code == 401) throw new IOException("login"); if (code >= 400) throw new IOException(errorText(code, new String(KtRemote.readAll(h.getErrorStream()), StandardCharsets.UTF_8))); return h.getInputStream(); }
        @Override public void write(String path, InputStream in, long size, KtRemote.Progress pr) throws Exception {
            path = KtRemote.norm(path); String pid = idOf(path.substring(0, Math.max(1, path.lastIndexOf('/')))); String name = path.substring(path.lastIndexOf('/') + 1);
            String existing = null; try { existing = idOf(path); } catch (java.io.FileNotFoundException ignored) {}
            // (A resumable session, then the bytes in one go: the way for files of any size.)
            HttpURLConnection s = req(existing == null ? "POST" : "PATCH", "https://www.googleapis.com/upload/drive/v3/files" + (existing == null ? "" : "/" + existing) + "?uploadType=resumable&supportsAllDrives=true", "application/json; charset=UTF-8");
            s.setRequestProperty("X-Upload-Content-Type", KtFiles.mimeOf(name)); if (size >= 0) s.setRequestProperty("X-Upload-Content-Length", String.valueOf(size));
            JSONObject meta = new JSONObject(); meta.put("name", name); if (existing == null) meta.put("parents", new JSONArray().put(pid)); json(s, meta.toString()); String loc = s.getHeaderField("Location"); if (loc == null) throw new IOException("noSession");
            HttpURLConnection u = req("PUT", loc, KtFiles.mimeOf(name)); if (size >= 0) u.setFixedLengthStreamingMode(size); else u.setChunkedStreamingMode(1 << 16); u.setDoOutput(true);
            try (OutputStream out = u.getOutputStream()) { pumpTo(in, out, pr); }
            int code = u.getResponseCode(); if (code >= 400) throw new IOException(errorText(code, new String(KtRemote.readAll(u.getErrorStream()), StandardCharsets.UTF_8))); ids.remove(path);
        }
        @Override public void mkdir(String path) throws Exception { path = KtRemote.norm(path); String pid = idOf(path.substring(0, Math.max(1, path.lastIndexOf('/')))); JSONObject meta = new JSONObject(); meta.put("name", path.substring(path.lastIndexOf('/') + 1)); meta.put("mimeType", "application/vnd.google-apps.folder"); meta.put("parents", new JSONArray().put(pid)); JSONObject r = json(req("POST", API + "files?supportsAllDrives=true", "application/json; charset=UTF-8"), meta.toString()); ids.put(path, r.getString("id")); }
        @Override public void delete(String path, boolean dir) throws Exception { json(req("DELETE", API + "files/" + idOf(path) + "?supportsAllDrives=true", null), null); ids.remove(KtRemote.norm(path)); }
        @Override public void rename(String from, String to) throws Exception {
            String id = idOf(from); String fromDir = KtRemote.norm(from).substring(0, Math.max(1, KtRemote.norm(from).lastIndexOf('/'))), toDir = KtRemote.norm(to).substring(0, Math.max(1, KtRemote.norm(to).lastIndexOf('/')));
            JSONObject meta = new JSONObject(); meta.put("name", KtRemote.norm(to).substring(KtRemote.norm(to).lastIndexOf('/') + 1)); String q = fromDir.equals(toDir) ? "" : "&addParents=" + idOf(toDir) + "&removeParents=" + idOf(fromDir);
            json(req("PATCH", API + "files/" + id + "?supportsAllDrives=true" + q, "application/json; charset=UTF-8"), meta.toString()); ids.remove(KtRemote.norm(from)); ids.put(KtRemote.norm(to), id);
        }
        @Override public long size(String path) throws Exception { JSONObject r = json(req("GET", API + "files/" + idOf(path) + "?fields=size,mimeType&supportsAllDrives=true", null), null); if ("application/vnd.google-apps.folder".equals(r.optString("mimeType"))) throw new IOException("isFolder"); return r.optLong("size", 0); }
    }

    static final class Dropbox extends Rest {
        static final String API = "https://api.dropboxapi.com/2/", CONTENT = "https://content.dropboxapi.com/2/";
        Dropbox(Context ctx, JSONObject c) { super(ctx, c); }
        static String p(String path) { path = KtRemote.norm(path); return path.equals("/") ? "" : path; }
        @Override public List<KtRemote.Entry> list(String path) throws Exception {
            List<KtRemote.Entry> out = new ArrayList<>(); JSONObject r = json(req("POST", API + "files/list_folder", "application/json"), new JSONObject().put("path", p(path)).put("limit", 1000).toString());
            while (true) { JSONArray es = r.getJSONArray("entries"); for (int i = 0; i < es.length(); i++) { JSONObject f = es.getJSONObject(i); KtRemote.Entry e = new KtRemote.Entry(); e.name = f.getString("name"); e.dir = "folder".equals(f.optString(".tag")); e.size = f.optLong("size", 0); e.mtime = when(f.optString("server_modified")); out.add(e); }
                if (!r.optBoolean("has_more")) break; r = json(req("POST", API + "files/list_folder/continue", "application/json"), new JSONObject().put("cursor", r.getString("cursor")).toString()); }
            return out;
        }
        @Override public InputStream read(String path, long offset) throws Exception { HttpURLConnection h = req("POST", CONTENT + "files/download", null); h.setRequestProperty("Dropbox-API-Arg", new JSONObject().put("path", p(path)).toString()); if (offset > 0) h.setRequestProperty("Range", "bytes=" + offset + "-"); h.setDoOutput(true); h.getOutputStream().close(); int code = h.getResponseCode(); if (code == 401) throw new IOException("login"); if (code >= 400) throw new IOException(errorText(code, new String(KtRemote.readAll(h.getErrorStream()), StandardCharsets.UTF_8))); return h.getInputStream(); }
        @Override public void write(String path, InputStream in, long size, KtRemote.Progress pr) throws Exception {
            // Sessions of 100 MB pieces: the one way that takes any size.
            final long PIECE = 100L << 20; byte[] buf = new byte[1 << 16]; String session = null; long offset = 0; boolean done = false;
            while (!done) {
                java.io.ByteArrayOutputStream piece = new java.io.ByteArrayOutputStream(); long got = 0; int n;
                while (got < PIECE && (n = in.read(buf, 0, (int) Math.min(buf.length, PIECE - got))) > 0) { piece.write(buf, 0, n); got += n; if (pr != null && pr.stopped()) throw new IOException("stopped"); }
                done = got < PIECE;
                if (session == null && done) { HttpURLConnection h = req("POST", CONTENT + "files/upload", "application/octet-stream"); h.setRequestProperty("Dropbox-API-Arg", new JSONObject().put("path", p(path)).put("mode", "overwrite").put("mute", true).toString()); h.setFixedLengthStreamingMode(got); h.setDoOutput(true); try (OutputStream out = h.getOutputStream()) { piece.writeTo(out); } json(h, null); if (pr != null) pr.on(got); return; }
                if (session == null) { HttpURLConnection h = req("POST", CONTENT + "files/upload_session/start", "application/octet-stream"); h.setRequestProperty("Dropbox-API-Arg", "{}"); h.setFixedLengthStreamingMode(got); h.setDoOutput(true); try (OutputStream out = h.getOutputStream()) { piece.writeTo(out); } session = json(h, null).getString("session_id"); }
                else if (!done) { HttpURLConnection h = req("POST", CONTENT + "files/upload_session/append_v2", "application/octet-stream"); h.setRequestProperty("Dropbox-API-Arg", new JSONObject().put("cursor", new JSONObject().put("session_id", session).put("offset", offset)).toString()); h.setFixedLengthStreamingMode(got); h.setDoOutput(true); try (OutputStream out = h.getOutputStream()) { piece.writeTo(out); } json(h, null); }
                else { HttpURLConnection h = req("POST", CONTENT + "files/upload_session/finish", "application/octet-stream"); h.setRequestProperty("Dropbox-API-Arg", new JSONObject().put("cursor", new JSONObject().put("session_id", session).put("offset", offset)).put("commit", new JSONObject().put("path", p(path)).put("mode", "overwrite").put("mute", true)).toString()); h.setFixedLengthStreamingMode(got); h.setDoOutput(true); try (OutputStream out = h.getOutputStream()) { piece.writeTo(out); } json(h, null); }
                offset += got; if (pr != null) pr.on(got);
            }
        }
        @Override public void mkdir(String path) throws Exception { json(req("POST", API + "files/create_folder_v2", "application/json"), new JSONObject().put("path", p(path)).toString()); }
        @Override public void delete(String path, boolean dir) throws Exception { json(req("POST", API + "files/delete_v2", "application/json"), new JSONObject().put("path", p(path)).toString()); }
        @Override public void rename(String from, String to) throws Exception { json(req("POST", API + "files/move_v2", "application/json"), new JSONObject().put("from_path", p(from)).put("to_path", p(to)).toString()); }
        @Override public long size(String path) throws Exception { JSONObject r = json(req("POST", API + "files/get_metadata", "application/json"), new JSONObject().put("path", p(path)).toString()); if ("folder".equals(r.optString(".tag"))) throw new IOException("isFolder"); return r.optLong("size", 0); }
    }

    static final class OneDrive extends Rest {
        static final String API = "https://graph.microsoft.com/v1.0/me/drive/";
        OneDrive(Context ctx, JSONObject c) { super(ctx, c); }
        static String item(String path) { path = KtRemote.norm(path); if (path.equals("/")) return "root"; StringBuilder sb = new StringBuilder("root:"); for (String part : path.substring(1).split("/")) sb.append('/').append(enc(part).replace("+", "%20")); return sb.append(':').toString(); }
        @Override public List<KtRemote.Entry> list(String path) throws Exception {
            List<KtRemote.Entry> out = new ArrayList<>(); String url = API + item(path) + "/children?$top=500&$select=name,size,folder,lastModifiedDateTime";
            while (url != null) { JSONObject r = json(req("GET", url, null), null); JSONArray v = r.getJSONArray("value"); for (int i = 0; i < v.length(); i++) { JSONObject f = v.getJSONObject(i); KtRemote.Entry e = new KtRemote.Entry(); e.name = f.getString("name"); e.dir = f.has("folder"); e.size = f.optLong("size", 0); e.mtime = when(f.optString("lastModifiedDateTime")); out.add(e); } url = r.optString("@odata.nextLink", null); if (url != null && url.isEmpty()) url = null; }
            return out;
        }
        @Override public InputStream read(String path, long offset) throws Exception { HttpURLConnection h = req("GET", API + item(path) + "/content", null); if (offset > 0) h.setRequestProperty("Range", "bytes=" + offset + "-"); int code = h.getResponseCode(); if (code == 401) throw new IOException("login"); if (code >= 400) throw new IOException(errorText(code, new String(KtRemote.readAll(h.getErrorStream()), StandardCharsets.UTF_8))); return h.getInputStream(); }
        @Override public void write(String path, InputStream in, long size, KtRemote.Progress pr) throws Exception {
            if (size >= 0 && size < (4L << 20)) { HttpURLConnection h = req("PUT", API + item(path) + "/content", "application/octet-stream"); h.setFixedLengthStreamingMode(size); h.setDoOutput(true); try (OutputStream out = h.getOutputStream()) { pumpTo(in, out, pr); } json(h, null); return; }
            JSONObject s = json(req("POST", API + item(path) + "/createUploadSession", "application/json"), new JSONObject().put("item", new JSONObject().put("@microsoft.graph.conflictBehavior", "replace")).toString()); String up = s.getString("uploadUrl");
            final long PIECE = 60L << 20; byte[] buf = new byte[1 << 16]; long offset = 0; boolean done = false;
            while (!done) {
                java.io.ByteArrayOutputStream piece = new java.io.ByteArrayOutputStream(); long got = 0; int n; while (got < PIECE && (n = in.read(buf, 0, (int) Math.min(buf.length, PIECE - got))) > 0) { piece.write(buf, 0, n); got += n; if (pr != null && pr.stopped()) throw new IOException("stopped"); }
                done = got < PIECE || (size >= 0 && offset + got >= size); long total = size >= 0 ? size : (done ? offset + got : -1);
                HttpURLConnection h = (HttpURLConnection) new URL(up).openConnection(); h.setRequestMethod("PUT"); h.setDoOutput(true); h.setFixedLengthStreamingMode(got); h.setRequestProperty("Content-Range", "bytes " + offset + "-" + (offset + got - 1) + "/" + (total < 0 ? "*" : total));
                try (OutputStream out = h.getOutputStream()) { piece.writeTo(out); } int code = h.getResponseCode(); if (code >= 400) throw new IOException("http " + code); KtRemote.readAll(h.getInputStream()).clone();
                offset += got; if (pr != null) pr.on(got);
            }
        }
        @Override public void mkdir(String path) throws Exception { path = KtRemote.norm(path); json(req("POST", API + item(path.substring(0, Math.max(1, path.lastIndexOf('/')))) + "/children", "application/json"), new JSONObject().put("name", path.substring(path.lastIndexOf('/') + 1)).put("folder", new JSONObject()).put("@microsoft.graph.conflictBehavior", "fail").toString()); }
        @Override public void delete(String path, boolean dir) throws Exception { json(req("DELETE", API + item(path), null), null); }
        @Override public void rename(String from, String to) throws Exception { to = KtRemote.norm(to); JSONObject body = new JSONObject().put("name", to.substring(to.lastIndexOf('/') + 1)); String toDir = to.substring(0, Math.max(1, to.lastIndexOf('/'))); if (!toDir.equals(KtRemote.norm(from).substring(0, Math.max(1, KtRemote.norm(from).lastIndexOf('/'))))) body.put("parentReference", new JSONObject().put("path", "/drive/" + item(toDir).replaceAll(":$", ""))); json(req("PATCH", API + item(from), "application/json"), body.toString()); }
        @Override public long size(String path) throws Exception { JSONObject r = json(req("GET", API + item(path) + "?$select=size,folder", null), null); if (r.has("folder")) throw new IOException("isFolder"); return r.optLong("size", 0); }
    }
}
