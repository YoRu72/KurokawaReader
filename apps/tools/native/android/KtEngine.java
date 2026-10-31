package app.kurokawa.tools;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;
import org.libtorrent4j.AddTorrentParams;
import org.libtorrent4j.AlertListener;
import org.libtorrent4j.FileStorage;
import org.libtorrent4j.Priority;
import org.libtorrent4j.SessionHandle;
import org.libtorrent4j.SessionManager;
import org.libtorrent4j.SessionParams;
import org.libtorrent4j.SettingsPack;
import org.libtorrent4j.Sha1Hash;
import org.libtorrent4j.TorrentFlags;
import org.libtorrent4j.TorrentHandle;
import org.libtorrent4j.TorrentInfo;
import org.libtorrent4j.TorrentStatus;
import org.libtorrent4j.Vectors;
import org.libtorrent4j.alerts.AddTorrentAlert;
import org.libtorrent4j.alerts.Alert;
import org.libtorrent4j.alerts.AlertType;
import org.libtorrent4j.alerts.MetadataReceivedAlert;
import org.libtorrent4j.alerts.SaveResumeDataAlert;
import org.libtorrent4j.alerts.TorrentAlert;
import org.libtorrent4j.alerts.TorrentErrorAlert;
import org.libtorrent4j.alerts.TorrentFinishedAlert;
import org.libtorrent4j.swig.add_torrent_params;
import org.libtorrent4j.swig.error_code;
import org.libtorrent4j.swig.libtorrent;
import org.libtorrent4j.swig.settings_pack;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The downloads: torrents through libtorrent (one session for the app), plain files through KrDownloader (several
 * connections), every one a Task with the same JSON shape the page shows. The tasks and the torrents' resume
 * data are kept in the app's files dir, so what was under way comes back after the app restarts.
 *
 * Everything here runs off the main thread (the plugin calls it from a background executor; libtorrent's alerts
 * arrive on its own thread). `Listener.changed` is called at most every ~700 ms while anything moves.
 */
final class KtEngine {
    private static final String TAG = "KtEngine";
    interface Listener { void changed(JSONArray tasks); }

    /** One download, torrent or file. */
    static final class Task {
        String id, kind, name, dir, state = "queued", error, infoHash;
        JSONObject source = new JSONObject(), meta;
        long done, total, downSpeed, upSpeed, addedAt = System.currentTimeMillis(), doneAt;
        int peers, seeds, connections; java.util.List<KrDownloader.Seg> segs;
        boolean sequential, paused;
        int[] priorities; // per file: 0 skip, 1 normal, 2 high (null = all normal)
        // torrent
        TorrentHandle th; String magnet; byte[] torrentBytes;
        // http
        AtomicBoolean cancel; Thread httpThread; AtomicLong got = new AtomicLong(); File httpOut; int wantConnections = 8; long lastT; long lastGot;
    }

    private final Context ctx;
    private final Listener listener;
    private final File stateDir;
    private final Map<String, Task> tasks = new LinkedHashMap<>();
    private SessionManager session;
    private final Map<String, Task> byHash = new ConcurrentHashMap<>();
    private volatile boolean seedAfterDone = false;
    private int listenPort = 0, maxActive = 3;
    private Thread ticker;
    private volatile long lastTell = 0;
    private final KtStream stream;

    KtEngine(Context ctx, Listener listener) {
        this.ctx = ctx.getApplicationContext(); this.listener = listener;
        stateDir = new File(this.ctx.getFilesDir(), "kt"); stateDir.mkdirs();
        stream = new KtStream(this);
        load();
    }

    /* ---------- the session ---------- */
    synchronized SessionManager session() {
        if (session != null && session.isRunning()) return session;
        session = new SessionManager(false);
        SettingsPack sp = new SettingsPack();
        sp.setBoolean(settings_pack.bool_types.enable_dht.swigValue(), true);
        sp.setBoolean(settings_pack.bool_types.enable_lsd.swigValue(), true);
        sp.setBoolean(settings_pack.bool_types.enable_upnp.swigValue(), true);
        sp.setBoolean(settings_pack.bool_types.enable_natpmp.swigValue(), true);
        sp.setInteger(settings_pack.int_types.out_enc_policy.swigValue(), settings_pack.enc_policy.pe_enabled.swigValue());
        sp.setInteger(settings_pack.int_types.in_enc_policy.swigValue(), settings_pack.enc_policy.pe_enabled.swigValue());
        sp.setString(settings_pack.string_types.user_agent.swigValue(), "KurokawaTools/0.1 libtorrent/2.0");
        sp.activeDownloads(maxActive); sp.setInteger(settings_pack.int_types.active_seeds.swigValue(), seedAfterDone ? 5 : 0);
        sp.connectionsLimit(200);
        if (listenPort > 0) sp.setString(settings_pack.string_types.listen_interfaces.swigValue(), "0.0.0.0:" + listenPort + ",[::]:" + listenPort);
        session.addListener(new AlertListener() {
            @Override public int[] types() { return new int[]{ AlertType.ADD_TORRENT.swig(), AlertType.METADATA_RECEIVED.swig(), AlertType.TORRENT_FINISHED.swig(), AlertType.SAVE_RESUME_DATA.swig(), AlertType.TORRENT_ERROR.swig(), AlertType.STATE_UPDATE.swig() }; }
            @Override public void alert(Alert<?> a) { try { onAlert(a); } catch (Exception e) { Log.w(TAG, "alert", e); } }
        });
        session.start(new SessionParams(sp));
        startTicker();
        return session;
    }

    private void onAlert(Alert<?> a) {
        AlertType t = a.type();
        if (t == AlertType.ADD_TORRENT) {
            AddTorrentAlert aa = (AddTorrentAlert) a;
            if (aa.error().isError()) { Task x = byHash.get(hashOf(aa.params())); if (x != null) { x.state = "failed"; x.error = aa.error().getMessage(); } persist(); tell(true); return; }
            TorrentHandle th = aa.handle(); String h = th.infoHash().toHex();
            Task x = byHash.get(h);
            if (x != null) { x.th = th; if (x.priorities != null) applyPriorities(x); if (x.sequential) th.setFlags(TorrentFlags.SEQUENTIAL_DOWNLOAD); if (x.paused) th.pause(); else th.resume(); }
            tell(true);
        } else if (t == AlertType.METADATA_RECEIVED) {
            TorrentHandle th = ((MetadataReceivedAlert) a).handle(); Task x = byHash.get(th.infoHash().toHex());
            if (x != null) { TorrentInfo ti = th.torrentFile(); if (ti != null) { x.name = ti.name(); x.total = ti.totalSize(); if (x.priorities != null) applyPriorities(x); } th.saveResumeData(); persist(); tell(true); }
        } else if (t == AlertType.TORRENT_FINISHED) {
            TorrentHandle th = ((TorrentFinishedAlert) a).handle(); Task x = byHash.get(th.infoHash().toHex());
            if (x != null) { if (x.doneAt == 0) x.doneAt = System.currentTimeMillis(); th.saveResumeData(); if (!seedAfterDone) th.pause(); persist(); tell(true); }
        } else if (t == AlertType.SAVE_RESUME_DATA) {
            SaveResumeDataAlert sa = (SaveResumeDataAlert) a; Task x = byHash.get(sa.handle().infoHash().toHex());
            if (x != null) { try { byte[] data = AddTorrentParams.writeResumeDataBuf(sa.params()); try (FileOutputStream fo = new FileOutputStream(new File(stateDir, x.id + ".fastresume"))) { fo.write(data); } } catch (Exception e) { Log.w(TAG, "resume", e); } }
        } else if (t == AlertType.TORRENT_ERROR) {
            TorrentErrorAlert ea = (TorrentErrorAlert) a; Task x = byHash.get(ea.handle().infoHash().toHex());
            if (x != null) { x.error = ea.error().getMessage(); tell(true); }
        } else if (t == AlertType.STATE_UPDATE) {
            tell(false);
        }
    }
    private static String hashOf(AddTorrentParams p) { try { return p.getInfoHashes().getBest().toHex(); } catch (Exception e) { return ""; } }

    private void startTicker() {
        if (ticker != null && ticker.isAlive()) return;
        ticker = new Thread(() -> {
            while (session != null && session.isRunning()) {
                try { Thread.sleep(700); } catch (InterruptedException e) { return; }
                try { if (anyTorrentActive()) session.postTorrentUpdates(); else tell(false); } catch (Exception ignored) {}
                // (Resume data saved now and then, so a kill loses little.)
                if (System.currentTimeMillis() % 30000 < 700) for (Task x : snapshot()) if (x.th != null && x.th.isValid() && x.th.needSaveResumeData()) x.th.saveResumeData();
            }
        }, "kt-ticker");
        ticker.setDaemon(true); ticker.start();
    }
    private boolean anyTorrentActive() { for (Task x : snapshot()) if (x.th != null && !x.paused && !"done".equals(x.state)) return true; return false; }
    private synchronized List<Task> snapshot() { return new ArrayList<>(tasks.values()); }

    /* ---------- the tasks ---------- */
    synchronized JSONArray list() { JSONArray arr = new JSONArray(); for (Task x : tasks.values()) arr.put(json(x)); return arr; }
    JSONObject get(String id) { Task x; synchronized (this) { x = tasks.get(id); } return x == null ? null : json(x); }
    Task task(String id) { synchronized (this) { return tasks.get(id); } }

    JSONObject add(JSONObject o) throws Exception {
        Task x = new Task();
        x.id = o.optString("id", Long.toString(System.currentTimeMillis(), 36) + Integer.toString((int) (Math.random() * 46655), 36));
        x.source = o.getJSONObject("source"); x.meta = o.optJSONObject("meta");
        x.dir = o.optString("dir", ""); if (x.dir.isEmpty()) x.dir = defaultDir().getAbsolutePath();
        x.sequential = o.optBoolean("sequential", false); x.paused = o.optBoolean("paused", false);
        x.wantConnections = Math.max(1, Math.min(16, o.optInt("connections", 8)));
        String name = o.optString("name", ""); if (!name.isEmpty()) x.name = name;
        JSONArray files = o.optJSONArray("files");
        if (files != null) { x.priorities = new int[0]; List<Integer> want = new ArrayList<>(); for (int i = 0; i < files.length(); i++) want.add(files.getInt(i)); x.priorities = new int[Math.max(0, max(want) + 1)]; for (int i : want) x.priorities[i] = 1; }
        if (o.has("video") && x.source.has("url")) { x.kind = "video"; JSONObject v = o.getJSONObject("video"); if (x.meta == null) x.meta = new JSONObject(); x.meta.put("kind", "video"); for (java.util.Iterator<String> it = v.keys(); it.hasNext(); ) { String k = it.next(); x.meta.put(k, v.get(k)); } if (x.name == null) x.name = v.optString("title", x.source.getString("url")); synchronized (this) { tasks.put(x.id, x); } if (!x.paused) startVideo(x); else x.state = "paused"; }
        else if (x.source.has("magnet") || x.source.has("torrent")) { x.kind = "torrent"; addTorrent(x); }
        else if (x.source.has("url")) { x.kind = "http"; if (x.name == null) x.name = nameFromUrl(x.source.getString("url")); synchronized (this) { tasks.put(x.id, x); } if (!x.paused) startHttp(x); else x.state = "paused"; }
        else throw new IllegalArgumentException("source");
        persist(); tell(true);
        return json(x);
    }
    private static int max(List<Integer> l) { int m = -1; for (int i : l) m = Math.max(m, i); return m; }

    private void addTorrent(Task x) throws Exception {
        SessionManager s = session();
        AddTorrentParams p;
        if (x.source.has("torrent")) {
            x.torrentBytes = android.util.Base64.decode(x.source.getString("torrent"), android.util.Base64.DEFAULT);
            TorrentInfo ti = TorrentInfo.bdecode(x.torrentBytes);
            p = new AddTorrentParams(); p.setTorrentInfo(ti); if (x.name == null) x.name = ti.name(); x.total = ti.totalSize();
            x.infoHash = ti.infoHash().toHex();
            // (Kept with the task, so it comes back after a restart.)
            try (FileOutputStream fo = new FileOutputStream(new File(stateDir, x.id + ".torrent"))) { fo.write(x.torrentBytes); }
        } else {
            x.magnet = x.source.getString("magnet");
            p = AddTorrentParams.parseMagnetUri(x.magnet);
            if (x.name == null) { String dn = p.getName(); x.name = dn != null && !dn.isEmpty() ? dn : "magnet"; }
            x.infoHash = hashOf(p);
        }
        File res = new File(stateDir, x.id + ".fastresume");
        if (res.exists()) { try { byte[] rd = java.nio.file.Files.readAllBytes(res.toPath()); error_code ec = new error_code(); add_torrent_params rp = libtorrent.read_resume_data_ex(Vectors.bytes2byte_vector(rd), ec); if (!ec.failed()) { AddTorrentParams q = new AddTorrentParams(rp); if (x.torrentBytes != null) q.setTorrentInfo(TorrentInfo.bdecode(x.torrentBytes)); p = q; } } catch (Exception e) { Log.w(TAG, "fastresume", e); } }
        p.setSavePath(x.dir);
        p.setFlags(p.getFlags().or_(TorrentFlags.AUTO_MANAGED).or_(TorrentFlags.UPDATE_SUBSCRIBE).or_(TorrentFlags.DUPLICATE_IS_ERROR));
        if (x.sequential) p.setFlags(p.getFlags().or_(TorrentFlags.SEQUENTIAL_DOWNLOAD));
        if (x.paused) p.setFlags(p.getFlags().or_(TorrentFlags.PAUSED));
        if (x.priorities != null && x.total > 0) p.filePriorities(prioArray(x, p.getTorrentInfo()));
        x.state = x.paused ? "paused" : (x.torrentBytes != null ? "downloading" : "metadata");
        synchronized (this) { tasks.put(x.id, x); } byHash.put(x.infoHash, x);
        s.swig().async_add_torrent(p.swig());
        KtService.ensure(ctx);
    }
    private Priority[] prioArray(Task x, TorrentInfo ti) {
        int n = ti == null ? (x.priorities == null ? 0 : x.priorities.length) : ti.numFiles();
        Priority[] out = new Priority[n];
        for (int i = 0; i < n; i++) { int v = x.priorities != null && i < x.priorities.length ? x.priorities[i] : (x.priorities == null ? 1 : 0); out[i] = v == 0 ? Priority.IGNORE : v == 2 ? Priority.TOP_PRIORITY : Priority.DEFAULT; }
        return out;
    }
    private void applyPriorities(Task x) { if (x.th == null || !x.th.isValid()) return; TorrentInfo ti = x.th.torrentFile(); if (ti == null) return; if (x.priorities != null && x.priorities.length < ti.numFiles()) { int[] np = new int[ti.numFiles()]; System.arraycopy(x.priorities, 0, np, 0, x.priorities.length); x.priorities = np; } x.th.prioritizeFiles(prioArray(x, ti)); }

    void pause(String id) { Task x = task(id); if (x == null) return; x.paused = true; if ("video".equals(x.kind)) KtVideo.cancel(x.id); if (x.th != null) { x.th.unsetFlags(TorrentFlags.AUTO_MANAGED); x.th.pause(); x.th.saveResumeData(); } if (x.cancel != null) { x.cancel.set(true); } x.state = "paused"; persist(); tell(true); }
    void resume(String id) throws Exception { Task x = task(id); if (x == null) return; x.paused = false; x.error = null; if ("torrent".equals(x.kind)) { if (x.th != null && x.th.isValid()) { x.th.setFlags(TorrentFlags.AUTO_MANAGED); x.th.resume(); x.state = x.th.status().hasMetadata() ? "downloading" : "metadata"; } else addTorrent(x); KtService.ensure(ctx); } else if ("video".equals(x.kind)) startVideo(x); else startHttp(x); persist(); tell(true); }
    void remove(String id, boolean deleteFiles) {
        Task x; synchronized (this) { x = tasks.remove(id); } if (x == null) return;
        if (x.th != null && x.th.isValid() && session != null) { if (deleteFiles) session.remove(x.th, SessionHandle.DELETE_FILES); else session.remove(x.th); }
        if (x.infoHash != null) byHash.remove(x.infoHash);
        if (x.cancel != null) x.cancel.set(true);
        if ("video".equals(x.kind)) { KtVideo.cancel(x.id); if (deleteFiles && x.httpOut != null) { File[] kids = new File(x.dir).listFiles(); String stem = x.httpOut.getName().replaceAll("\\.[^.]+$", ""); if (kids != null) for (File k : kids) if (k.getName().startsWith(stem)) k.delete(); } }
        if (deleteFiles && x.httpOut != null && !"video".equals(x.kind)) { x.httpOut.delete(); new File(x.httpOut.getPath() + ".part").delete(); }
        new File(stateDir, id + ".fastresume").delete(); new File(stateDir, id + ".torrent").delete();
        persist(); tell(true); KtService.maybeStop(ctx, this);
    }
    void setFiles(String id, int[] prios) { Task x = task(id); if (x == null) return; x.priorities = prios; applyPriorities(x); persist(); tell(true); }
    void setSequential(String id, boolean on) { Task x = task(id); if (x == null || x.th == null) return; x.sequential = on; if (on) x.th.setFlags(TorrentFlags.SEQUENTIAL_DOWNLOAD); else x.th.unsetFlags(TorrentFlags.SEQUENTIAL_DOWNLOAD); persist(); }
    void setLimits(long down, long up) { SessionManager s = session(); s.downloadRateLimit((int) Math.min(Integer.MAX_VALUE, down)); s.uploadRateLimit((int) Math.min(Integer.MAX_VALUE, up)); }
    void configure(JSONObject o) {
        if (o.has("seed")) seedAfterDone = o.optBoolean("seed");
        if (o.has("listenPort")) listenPort = o.optInt("listenPort");
        if (o.has("maxActive")) maxActive = Math.max(1, o.optInt("maxActive", 3));
        if (session != null && session.isRunning()) {
            SettingsPack sp = new SettingsPack(); sp.activeDownloads(maxActive); sp.setInteger(settings_pack.int_types.active_seeds.swigValue(), seedAfterDone ? 5 : 0);
            if (o.has("listenPort")) sp.setString(settings_pack.string_types.listen_interfaces.swigValue(), listenPort > 0 ? "0.0.0.0:" + listenPort + ",[::]:" + listenPort : "0.0.0.0:6881,[::]:6881");
            session.applySettings(sp);
            if (o.has("seed")) for (Task x : snapshot()) if (x.th != null && x.th.isValid() && x.th.status().isFinished()) { if (seedAfterDone) x.th.resume(); else x.th.pause(); }
        }
        try { JSONObject cfg = new JSONObject(); cfg.put("seed", seedAfterDone); cfg.put("listenPort", listenPort); cfg.put("maxActive", maxActive); write(new File(stateDir, "config.json"), cfg.toString()); } catch (Exception ignored) {}
    }

    /** A magnet's (or .torrent's) metadata without keeping it: name, size, files. */
    JSONObject torrentInfo(JSONObject source) throws Exception {
        TorrentInfo ti;
        if (source.has("torrent")) ti = TorrentInfo.bdecode(android.util.Base64.decode(source.getString("torrent"), android.util.Base64.DEFAULT));
        else { byte[] data = session().fetchMagnet(source.getString("magnet"), 60, new File(ctx.getCacheDir(), "kt-meta")); if (data == null) throw new Exception("timeout"); ti = TorrentInfo.bdecode(data); }
        JSONObject out = new JSONObject(); out.put("name", ti.name()); out.put("infoHash", ti.infoHash().toHex()); out.put("total", ti.totalSize());
        JSONArray files = new JSONArray(); FileStorage fs = ti.files();
        for (int i = 0; i < fs.numFiles(); i++) { JSONObject f = new JSONObject(); f.put("index", i); f.put("path", fs.filePath(i)); f.put("size", fs.fileSize(i)); files.put(f); }
        out.put("files", files); return out;
    }

    /* ---------- HTTP ---------- */
    /** A video page through yt-dlp: progress from its lines; the file it names becomes the task's file. */
    private void startVideo(Task x) {
        x.state = "downloading"; x.error = null; KtService.ensure(ctx); tell(true);
        bg.execute(() -> {
            try {
                File out = KtVideo.run(ctx, x.id, x.source.getString("url"), new File(x.dir), x.meta, (done, total, speed, file, detail) -> { if (total > 0) { x.total = total; x.done = done; } x.downSpeed = speed; if (file != null) { x.httpOut = new File(x.dir, file.replaceAll("\\.f\\d+\\.(\\w+)$", ".$1")); x.name = x.httpOut.getName().replaceAll("\\.[^.]+$", ""); } tell(false); });
                if (x.paused) return;
                if (out != null) { x.httpOut = out; x.name = out.getName().replaceAll("\\.[^.]+$", ""); if (out.exists()) { x.total = out.length(); } }
                x.done = x.total; x.downSpeed = 0; x.state = "done"; x.doneAt = System.currentTimeMillis(); persist(); tell(true); KtService.maybeStop(ctx, this);
            } catch (Exception e) {
                if (x.paused) { x.state = "paused"; } else { x.state = "failed"; x.error = e.getMessage(); }
                x.downSpeed = 0; persist(); tell(true); KtService.maybeStop(ctx, this);
            }
        });
    }
    private void startHttp(Task x) {
        if (x.httpThread != null && x.httpThread.isAlive()) return;
        x.cancel = new AtomicBoolean(false); x.state = "downloading"; x.error = null;
        final String url = x.source.optString("url"); final JSONObject headers = x.source.optJSONObject("headers");
        x.httpThread = new Thread(() -> {
            try {
                File dir = new File(x.dir); dir.mkdirs();
                String safe = x.name.replaceAll("[\\\\/:*?\"<>|\\u0000-\\u001f]+", " ").trim(); if (safe.isEmpty()) safe = "download";
                x.httpOut = new File(dir, safe); File part = new File(dir, safe + ".part");
                final KrDownloader.Result info = new KrDownloader.Result(); x.segs = info.segs;
                x.got.set(0);
                KrDownloader.Result r = KrDownloader.fetch(new URL(url), part, x.wantConnections, u -> open(u, headers), x.cancel, x.got, info, () -> { x.total = info.total; x.done = x.got.get(); x.connections = info.connections; long now = System.currentTimeMillis(); if (now - x.lastT >= 700) { long g = x.got.get(); x.downSpeed = x.lastT == 0 ? 0 : (long) ((g - x.lastGot) / ((now - x.lastT) / 1000.0)); x.lastT = now; x.lastGot = g; tell(false); } });
                if (x.cancel.get()) { x.downSpeed = 0; return; }
                if (r.total > 0 && part.length() != r.total) throw new IOException("incomplete");
                if (x.httpOut.exists()) x.httpOut.delete();
                if (!part.renameTo(x.httpOut)) throw new IOException("cannot keep the file");
                x.done = x.total = x.httpOut.length(); x.state = "done"; x.doneAt = System.currentTimeMillis(); x.downSpeed = 0;
            } catch (Exception e) { if (!x.cancel.get()) { x.state = "failed"; x.error = e.getMessage(); } x.downSpeed = 0; }
            persist(); tell(true); KtService.maybeStop(ctx, KtEngine.this);
        }, "kt-http-" + x.id);
        x.httpThread.start();
        KtService.ensure(ctx);
    }
    private HttpURLConnection open(URL u, JSONObject headers) throws IOException {
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        c.setConnectTimeout(20000); c.setReadTimeout(60000); c.setInstanceFollowRedirects(false);
        c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13) KurokawaTools/0.1");
        if (headers != null) { Iterator<String> it = headers.keys(); while (it.hasNext()) { String k = it.next(); c.setRequestProperty(k, headers.optString(k)); } }
        return c;
    }
    static String nameFromUrl(String url) { try { String p = new URL(url).getPath(); String n = p.substring(p.lastIndexOf('/') + 1); n = java.net.URLDecoder.decode(n, "UTF-8"); return n.isEmpty() ? "download" : n; } catch (Exception e) { return "download"; } }

    /* ---------- what the page sees ---------- */
    boolean anyActive() { for (Task x : snapshot()) if ("downloading".equals(x.state) || "metadata".equals(x.state) || "checking".equals(x.state) || ("seeding".equals(x.state) && seedAfterDone)) return true; return false; }

    private void tell(boolean force) {
        long now = System.currentTimeMillis();
        if (!force && now - lastTell < 700) return;
        lastTell = now;
        refreshTorrents();
        JSONArray arr = list();
        try { listener.changed(arr); } catch (Exception e) { Log.w(TAG, "listener", e); }
    }
    private void refreshTorrents() {
        for (Task x : snapshot()) {
            if (x.th == null || !x.th.isValid()) continue;
            try {
                TorrentStatus st = x.th.status();
                x.done = st.totalWantedDone(); x.total = st.totalWanted() > 0 ? st.totalWanted() : st.total(); x.downSpeed = st.downloadPayloadRate(); x.upSpeed = st.uploadPayloadRate(); x.peers = st.numPeers(); x.seeds = st.numSeeds();
                if (x.name == null || x.name.isEmpty() || "magnet".equals(x.name)) { String n = st.name(); if (n != null && !n.isEmpty()) x.name = n; }
                if (x.paused) x.state = "paused";
                else if (st.errorCode() != null && st.errorCode().isError()) { x.state = "failed"; x.error = st.errorCode().getMessage(); }
                else switch (st.state()) {
                    case CHECKING_FILES: case CHECKING_RESUME_DATA: x.state = "checking"; break;
                    case DOWNLOADING_METADATA: x.state = "metadata"; break;
                    case FINISHED: case SEEDING: x.state = seedAfterDone ? "seeding" : "done"; if (x.doneAt == 0) x.doneAt = System.currentTimeMillis(); break;
                    default: x.state = "downloading";
                }
            } catch (Exception ignored) {}
        }
    }
    JSONObject json(Task x) {
        JSONObject o = new JSONObject();
        try {
            o.put("id", x.id); o.put("kind", x.kind); o.put("name", x.name == null ? "" : x.name); o.put("source", x.source); o.put("dir", x.dir); o.put("state", x.state);
            o.put("done", x.done); o.put("total", x.total); o.put("downSpeed", x.downSpeed); o.put("upSpeed", x.upSpeed);
            if (x.downSpeed > 0 && x.total > x.done) o.put("eta", (x.total - x.done) / x.downSpeed);
            if ("torrent".equals(x.kind)) { o.put("peers", x.peers); o.put("seeds", x.seeds); if (x.infoHash != null) o.put("infoHash", x.infoHash); } else { o.put("connections", x.connections);
                if (x.segs != null && "downloading".equals(x.state)) { JSONArray sa = new JSONArray(); synchronized (x.segs) { for (KrDownloader.Seg sg : x.segs) { JSONObject so = new JSONObject(); so.put("start", sg.start); so.put("pos", sg.pos); so.put("end", sg.end); so.put("speed", (long) sg.speed); so.put("active", sg.active); so.put("worker", sg.worker); sa.put(so); } } o.put("segments", sa); } }
            o.put("files", files(x)); o.put("sequential", x.sequential); if (x.error != null) o.put("error", x.error);
            o.put("addedAt", x.addedAt); if (x.doneAt > 0) o.put("doneAt", x.doneAt); if (x.meta != null) o.put("meta", x.meta); o.put("engine", "native");
        } catch (Exception ignored) {}
        return o;
    }
    private JSONArray files(Task x) {
        JSONArray arr = new JSONArray();
        try {
            if (x.th != null && x.th.isValid()) {
                TorrentInfo ti = x.th.torrentFile();
                if (ti != null) {
                    FileStorage fs = ti.files(); long[] prog = x.th.fileProgress(); Priority[] pr = x.th.filePriorities();
                    for (int i = 0; i < fs.numFiles(); i++) { JSONObject f = new JSONObject(); f.put("index", i); f.put("path", fs.filePath(i)); f.put("size", fs.fileSize(i)); f.put("done", prog != null && i < prog.length ? prog[i] : 0); int p = pr != null && i < pr.length ? pr[i].swig() : 4; f.put("priority", p == 0 ? 0 : p >= 7 ? 2 : 1); arr.put(f); }
                }
            } else if ("http".equals(x.kind) || "video".equals(x.kind)) { JSONObject f = new JSONObject(); f.put("index", 0); f.put("path", x.httpOut != null ? x.httpOut.getName() : x.name); f.put("size", x.total); f.put("done", x.done); f.put("priority", 1); arr.put(f); }
        } catch (Exception ignored) {}
        return arr;
    }

    /** The file of a task on disk (a torrent's by index). */
    File fileOf(Task x, int index) {
        if ("http".equals(x.kind) || "video".equals(x.kind)) return x.httpOut != null ? x.httpOut : new File(x.dir, x.name);
        if (x.th == null || !x.th.isValid()) return null;
        TorrentInfo ti = x.th.torrentFile(); if (ti == null) return null;
        return new File(ti.files().filePath(Math.max(0, index), x.th.savePath()));
    }
    KtStream stream() { return stream; }
    File defaultDir() { File ext = ctx.getExternalFilesDir(null); File d = new File(ext != null ? ext : ctx.getFilesDir(), "Downloads"); d.mkdirs(); return d; }

    /* ---------- kept across restarts ---------- */
    private final java.util.concurrent.ExecutorService bg = java.util.concurrent.Executors.newCachedThreadPool(r -> { Thread t = new Thread(r, "kt-video"); t.setDaemon(true); return t; });
    private synchronized void persist() {
        try {
            JSONArray arr = new JSONArray();
            for (Task x : tasks.values()) { JSONObject o = json(x); o.put("priorities", x.priorities == null ? JSONObject.NULL : new JSONArray(toList(x.priorities))); o.put("paused", x.paused); o.put("connections", x.wantConnections); o.put("files", JSONObject.NULL); if ("video".equals(x.kind) && x.httpOut != null) o.put("file", x.httpOut.getName()); arr.put(o); }
            write(new File(stateDir, "tasks.json"), arr.toString());
        } catch (Exception e) { Log.w(TAG, "persist", e); }
    }
    private static List<Integer> toList(int[] a) { List<Integer> l = new ArrayList<>(); for (int v : a) l.add(v); return l; }
    private static void write(File f, String s) throws IOException { File tmp = new File(f.getPath() + ".tmp"); try (FileOutputStream fo = new FileOutputStream(tmp)) { fo.write(s.getBytes(StandardCharsets.UTF_8)); } if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f); } }
    private void load() {
        try { File cfg = new File(stateDir, "config.json"); if (cfg.exists()) { JSONObject c = new JSONObject(new String(java.nio.file.Files.readAllBytes(cfg.toPath()), StandardCharsets.UTF_8)); seedAfterDone = c.optBoolean("seed", false); listenPort = c.optInt("listenPort", 0); maxActive = c.optInt("maxActive", 3); } } catch (Exception ignored) {}
        File f = new File(stateDir, "tasks.json"); if (!f.exists()) return;
        try {
            JSONArray arr = new JSONArray(new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
            boolean any = false;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i); Task x = new Task();
                x.id = o.getString("id"); x.kind = o.getString("kind"); x.name = o.optString("name"); x.source = o.optJSONObject("source"); if (x.source == null) x.source = new JSONObject(); x.dir = o.optString("dir"); x.state = o.optString("state", "paused");
                x.done = o.optLong("done"); x.total = o.optLong("total"); x.addedAt = o.optLong("addedAt", System.currentTimeMillis()); x.doneAt = o.optLong("doneAt"); x.meta = o.optJSONObject("meta"); x.sequential = o.optBoolean("sequential"); x.paused = o.optBoolean("paused"); x.infoHash = o.optString("infoHash", null); x.error = o.optString("error", null); x.wantConnections = o.optInt("connections", 8);
                JSONArray pr = o.optJSONArray("priorities"); if (pr != null) { x.priorities = new int[pr.length()]; for (int k = 0; k < pr.length(); k++) x.priorities[k] = pr.getInt(k); }
                if ("http".equals(x.kind)) { x.httpOut = new File(x.dir, x.name); if (!"done".equals(x.state)) { x.state = "paused"; x.paused = true; } }
                if ("video".equals(x.kind)) { String vf = o.optString("file", ""); if (!vf.isEmpty()) x.httpOut = new File(x.dir, vf); if (!"done".equals(x.state)) { x.state = "paused"; x.paused = true; } }
                tasks.put(x.id, x);
                if ("torrent".equals(x.kind)) {
                    File tf = new File(stateDir, x.id + ".torrent"); if (tf.exists()) { try { x.source.put("torrent", android.util.Base64.encodeToString(java.nio.file.Files.readAllBytes(tf.toPath()), android.util.Base64.NO_WRAP)); } catch (Exception ignored) {} }
                    if (!"done".equals(x.state) || seedAfterDone) { any = true; }
                }
            }
            if (any) { for (Task x : snapshot()) if ("torrent".equals(x.kind) && (!"done".equals(x.state) || seedAfterDone)) { try { if ("done".equals(x.state)) x.paused = !seedAfterDone; addTorrent(x); } catch (Exception e) { x.state = "failed"; x.error = e.getMessage(); } } }
        } catch (Exception e) { Log.w(TAG, "load", e); }
    }
}
