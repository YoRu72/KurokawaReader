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
        AtomicBoolean cancel; Thread httpThread; AtomicLong got = new AtomicLong(); File httpOut; int wantConnections = 8; long lastT; long lastGot; boolean autoName;
    }

    private final Context ctx;
    private final Listener listener;
    private final File stateDir;
    private final Map<String, Task> tasks = new LinkedHashMap<>();
    private SessionManager session;
    private final Map<String, Task> byHash = new ConcurrentHashMap<>();
    private volatile boolean seedAfterDone = false;
    /* Senpwai's torrent options: peer discovery, encryption, and when seeding stops (0 = never). */
    /** Public trackers added to every public torrent (the page refreshes the list daily; this one until then). */
    static final String[] TRACKERS = { "udp://tracker.opentrackr.org:1337/announce", "udp://open.demonii.com:1337/announce", "udp://open.stealth.si:80/announce", "udp://tracker.torrent.eu.org:451/announce", "udp://exodus.desync.com:6969/announce", "udp://explodie.org:6969/announce", "udp://tracker.qu.ax:6969/announce", "udp://opentracker.io:6969/announce", "udp://tracker.dler.org:6969/announce", "udp://tracker.tiny-vps.com:6969/announce", "udp://tracker-udp.gbitt.info:80/announce", "udp://tracker.0x7c0.com:6969/announce", "http://tracker.opentrackr.org:1337/announce", "http://nyaa.tracker.wf:7777/announce" };
    private volatile String[] extraTrackers = TRACKERS; private volatile boolean addTrackers = true;
    private volatile boolean dht = true, lsd = true, upnp = true, natpmp = true; private volatile String enc = "enabled"; private volatile double seedRatio = 0; private volatile int seedMinutes = 0;
    private int listenPort = 0, maxActive = 3;
    /* Prism's connection settings: the name the app gives servers, tries per chunk, how long to wait, a proxy,
       and what to do when the file is there already. Plus what each server was found to accept. */
    static final String APP_UA = "Mozilla/5.0 (Linux; Android 13) KurokawaTools/0.1";
    private volatile String ua = APP_UA, proxy = "", conflict = "rename", bindIface = ""; private volatile int retries = 5, timeoutS = 60; private volatile boolean torrentProxy = false, anonymous = false;
    private final Map<String, Integer> hostLimit = new ConcurrentHashMap<>();
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
        applyNet(sp);
        sp.setString(settings_pack.string_types.user_agent.swigValue(), "KurokawaTools/0.1 libtorrent/2.0");
        sp.activeDownloads(maxActive); sp.setInteger(settings_pack.int_types.active_seeds.swigValue(), seedAfterDone ? 5 : 0);
        sp.connectionsLimit(500);
        tune(sp);
        if (listenPort > 0) sp.setString(settings_pack.string_types.listen_interfaces.swigValue(), "0.0.0.0:" + listenPort + ",[::]:" + listenPort);
        session.addListener(new AlertListener() {
            @Override public int[] types() { return new int[]{ AlertType.ADD_TORRENT.swig(), AlertType.METADATA_RECEIVED.swig(), AlertType.TORRENT_FINISHED.swig(), AlertType.SAVE_RESUME_DATA.swig(), AlertType.TORRENT_ERROR.swig(), AlertType.STATE_UPDATE.swig() }; }
            @Override public void alert(Alert<?> a) { try { onAlert(a); } catch (Throwable e) { Log.w(TAG, "alert", e); } }
        });
        // libtorrent's own disk access (memory-mapped, on its own threads) — fast. The simple one (posix) does every
        // read, write and check on the network's thread, so peers wait while a big torrent is checked: it is only a
        // choice in Settings («Simple disk access»), for a phone whose storage misbehaves with the fast one.
        SessionParams params = new SessionParams(sp);
        boolean simpleDisk = false; try { simpleDisk = ctx.getSharedPreferences("kt", Context.MODE_PRIVATE).getBoolean("simpleDisk", false); } catch (Throwable ignored) {}
        if (simpleDisk) try { params.setPosixDiskIO(); } catch (Throwable e) { Log.w(TAG, "posix disk io", e); }
        // (The DHT's table of nodes from last time: peers are asked at once instead of the DHT starting cold.)
        try { File st = new File(stateDir, "dht.dat"); if (st.length() > 0) { SessionParams old = new SessionParams(java.nio.file.Files.readAllBytes(st.toPath())); params.swig().setDht_state(old.swig().getDht_state()); } } catch (Throwable e) { Log.w(TAG, "dht state", e); }
        session.start(params);
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
            // The handle an alert gives points into the alert itself, which libtorrent frees once the alert has been
            // handled: kept, it was read later from another thread (the page asking for the list) and the whole app
            // ended (SIGSEGV in torrent_handle::is_valid, from KtEngine.files). The session's own copy is kept instead.
            if (x != null) { TorrentHandle own = session.find(th.infoHash()); x.th = own; if (own == null) { tell(true); return; } th = own; if (x.priorities != null) applyPriorities(x); if (x.sequential) th.setFlags(TorrentFlags.SEQUENTIAL_DOWNLOAD); if (x.paused) th.pause(); else th.resume(); }
            tell(true);
        } else if (t == AlertType.METADATA_RECEIVED) {
            TorrentHandle th = ((MetadataReceivedAlert) a).handle(); Task x = byHash.get(th.infoHash().toHex());
            if (x != null) { TorrentInfo ti = th.torrentFile(); if (ti != null) { x.name = ti.name(); x.total = ti.totalSize(); if (x.priorities != null) applyPriorities(x); } th.saveResumeData(TorrentHandle.SAVE_INFO_DICT); persist(); tell(true); }
        } else if (t == AlertType.TORRENT_FINISHED) {
            TorrentHandle th = ((TorrentFinishedAlert) a).handle(); Task x = byHash.get(th.infoHash().toHex());
            if (x != null) { if (x.doneAt == 0) x.doneAt = System.currentTimeMillis(); th.saveResumeData(TorrentHandle.SAVE_INFO_DICT); if (!seedAfterDone) th.pause(); persist(); tell(true); }
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
                // (A torrent whose handle could not be had when it was added: asked of the session again.)
                try { for (Task x : snapshot()) if ("torrent".equals(x.kind) && x.th == null && x.infoHash != null && !x.infoHash.isEmpty()) { TorrentHandle h = session.find(org.libtorrent4j.Sha1Hash.parseHex(x.infoHash)); if (h != null) { x.th = h; if (x.paused) h.pause(); } } } catch (Throwable ignored) {}
                try { if (anyTorrentActive()) session.postTorrentUpdates(); else tell(false); } catch (Throwable ignored) {}
                try { if (System.currentTimeMillis() % 600000 < 700) saveDht(); } catch (Throwable ignored) {}
                // (Resume data saved now and then, so a kill loses little.)
                try { if (System.currentTimeMillis() % 30000 < 700) for (Task x : snapshot()) if (x.th != null && x.th.isValid() && x.th.needSaveResumeData()) x.th.saveResumeData(TorrentHandle.SAVE_INFO_DICT); } catch (Throwable ignored) {}
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
        else if (x.source.has("url")) { x.kind = "http"; if (x.name == null) { x.name = nameFromUrl(x.source.getString("url")); x.autoName = true; } synchronized (this) { tasks.put(x.id, x); } if (x.paused) x.state = "paused"; else if (busyHttp() >= maxActive) x.state = "queued"; else startHttp(x); }
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
        // (Public trackers added — never to a private torrent, whose tracker alone may know of it.)
        try {
            TorrentInfo pti = p.getTorrentInfo(); boolean priv = pti != null && pti.isPrivate();
            if (addTrackers && !priv) {
                java.util.List<String> tr = new java.util.ArrayList<>(p.getTrackers()); java.util.List<Integer> tiers = new java.util.ArrayList<>(p.getTrackerTiers());
                while (tiers.size() < tr.size()) tiers.add(0); int next = 0; for (int t : tiers) next = Math.max(next, t + 1);
                java.util.Set<String> have = new java.util.HashSet<>(tr); for (String u : extraTrackers) if (u != null && !u.isEmpty() && have.add(u)) { tr.add(u); tiers.add(next); }
                p.setTrackers(tr); p.setTrackerTiers(tiers);
            }
        } catch (Throwable e) { Log.w(TAG, "trackers", e); }
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

    void pause(String id) { Task x = task(id); if (x == null) return; x.paused = true; if ("video".equals(x.kind)) KtVideo.cancel(x.id); if (x.th != null) { x.th.unsetFlags(TorrentFlags.AUTO_MANAGED); x.th.pause(); x.th.saveResumeData(TorrentHandle.SAVE_INFO_DICT); } if (x.cancel != null) { x.cancel.set(true); } x.state = "paused"; persist(); tell(true); if ("http".equals(x.kind)) bg.execute(() -> { try { if (x.httpThread != null) x.httpThread.join(3000); } catch (InterruptedException ignored) {} pumpQueue(); }); }
    void resume(String id) throws Exception { Task x = task(id); if (x == null) return; x.paused = false; x.error = null; if ("torrent".equals(x.kind)) { if (x.th != null && x.th.isValid()) { x.th.setFlags(TorrentFlags.AUTO_MANAGED); x.th.resume(); x.state = x.th.status().hasMetadata() ? "downloading" : "metadata"; } else addTorrent(x); KtService.ensure(ctx); } else if ("video".equals(x.kind)) startVideo(x); else if (busyHttp() >= maxActive) x.state = "queued"; else startHttp(x); persist(); tell(true); }
    void remove(String id, boolean deleteFiles) {
        Task x; synchronized (this) { x = tasks.remove(id); } if (x == null) return;
        if (x.th != null && x.th.isValid() && session != null) { if (deleteFiles) session.remove(x.th, SessionHandle.DELETE_FILES); else session.remove(x.th); }
        if (x.infoHash != null) byHash.remove(x.infoHash);
        if (x.cancel != null) x.cancel.set(true);
        if ("video".equals(x.kind)) { KtVideo.cancel(x.id); if (deleteFiles && x.httpOut != null) { File[] kids = new File(x.dir).listFiles(); String stem = x.httpOut.getName().replaceAll("\\.[^.]+$", ""); if (kids != null) for (File k : kids) if (k.getName().startsWith(stem)) k.delete(); } }
        if (deleteFiles && x.httpOut != null && !"video".equals(x.kind)) { x.httpOut.delete(); new File(x.httpOut.getPath() + ".part").delete(); }
        new File(stateDir, id + ".http").delete(); new File(stateDir, id + ".fastresume").delete(); new File(stateDir, id + ".torrent").delete();
        persist(); tell(true); KtService.maybeStop(ctx, this);
        if ("http".equals(x.kind)) bg.execute(() -> { try { if (x.httpThread != null) x.httpThread.join(3000); } catch (InterruptedException ignored) {} pumpQueue(); });
    }
    void setFiles(String id, int[] prios) { Task x = task(id); if (x == null) return; x.priorities = prios; applyPriorities(x); persist(); tell(true); }
    void setSequential(String id, boolean on) { Task x = task(id); if (x == null || x.th == null) return; x.sequential = on; if (on) x.th.setFlags(TorrentFlags.SEQUENTIAL_DOWNLOAD); else x.th.unsetFlags(TorrentFlags.SEQUENTIAL_DOWNLOAD); persist(); }
    void setLimits(long down, long up) { SessionManager s = session(); s.downloadRateLimit((int) Math.min(Integer.MAX_VALUE, down)); s.uploadRateLimit((int) Math.min(Integer.MAX_VALUE, up)); }
    /** Finding peers fast and keeping them busy (what Flud and qBittorrent change from libtorrent's cautious defaults):
     *  every tracker announced to at once, more connection attempts a second and a bigger boost for a new torrent,
     *  a shorter wait on peers that do not answer, deeper request queues, and more threads for the disk. */
    private void tune(SettingsPack sp) {
        sp.setBoolean(settings_pack.bool_types.announce_to_all_trackers.swigValue(), true);
        sp.setBoolean(settings_pack.bool_types.announce_to_all_tiers.swigValue(), true);
        sp.setInteger(settings_pack.int_types.connection_speed.swigValue(), 100);
        sp.setInteger(settings_pack.int_types.torrent_connect_boost.swigValue(), 100);
        sp.setInteger(settings_pack.int_types.peer_connect_timeout.swigValue(), 7);
        sp.setInteger(settings_pack.int_types.max_out_request_queue.swigValue(), 1500);
        sp.setInteger(settings_pack.int_types.max_allowed_in_request_queue.swigValue(), 2000);
        sp.setInteger(settings_pack.int_types.send_buffer_watermark.swigValue(), 3 * 1024 * 1024);
        sp.setInteger(settings_pack.int_types.send_buffer_watermark_factor.swigValue(), 150);
        sp.setInteger(settings_pack.int_types.aio_threads.swigValue(), 8);
        sp.setInteger(settings_pack.int_types.hashing_threads.swigValue(), Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors() / 2)));
        sp.setInteger(settings_pack.int_types.active_limit.swigValue(), 60);
        sp.setInteger(settings_pack.int_types.dht_upload_rate_limit.swigValue(), 50000);
        sp.setInteger(settings_pack.int_types.max_peerlist_size.swigValue(), 4000);
        sp.setBoolean(settings_pack.bool_types.smooth_connects.swigValue(), false);
    }
    /** The DHT's nodes kept for the next start. */
    void saveDht() {
        try { SessionManager s = session; if (s == null || !s.isRunning()) return;
            org.libtorrent4j.swig.session_params sp = s.swig().session_state(org.libtorrent4j.swig.session_handle.save_dht_state);
            byte[] b = Vectors.byte_vector2bytes(org.libtorrent4j.swig.session_params.write_session_params_buf(sp, org.libtorrent4j.swig.session_handle.save_dht_state));
            if (b.length > 0) { File tmp = new File(stateDir, "dht.dat.tmp"); try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(b); } tmp.renameTo(new File(stateDir, "dht.dat")); }
        } catch (Throwable e) { Log.w(TAG, "save dht", e); }
    }
    private void applyNet(SettingsPack sp) {
        sp.setBoolean(settings_pack.bool_types.enable_dht.swigValue(), dht);
        sp.setBoolean(settings_pack.bool_types.enable_lsd.swigValue(), lsd);
        sp.setBoolean(settings_pack.bool_types.enable_upnp.swigValue(), upnp);
        sp.setBoolean(settings_pack.bool_types.enable_natpmp.swigValue(), natpmp);
        int pol = "forced".equals(enc) ? settings_pack.enc_policy.pe_forced.swigValue() : "disabled".equals(enc) ? settings_pack.enc_policy.pe_disabled.swigValue() : settings_pack.enc_policy.pe_enabled.swigValue();
        sp.setInteger(settings_pack.int_types.out_enc_policy.swigValue(), pol); sp.setInteger(settings_pack.int_types.in_enc_policy.swigValue(), pol);
        sp.setInteger(settings_pack.int_types.share_ratio_limit.swigValue(), seedRatio > 0 ? (int) Math.round(seedRatio * 100) : 1000000);
        sp.setInteger(settings_pack.int_types.seed_time_limit.swigValue(), seedMinutes > 0 ? seedMinutes * 60 : Integer.MAX_VALUE);
        // Senpwai's: the Connection proxy for torrents too (peers, trackers, names), a network interface to keep to
        // (a VPN's: tun0, wg0…), anonymous mode.
        java.net.Proxy px = torrentProxy ? proxyOf(proxy) : null;
        if (px != null && px.address() instanceof java.net.InetSocketAddress) {
            java.net.InetSocketAddress ad = (java.net.InetSocketAddress) px.address();
            sp.setInteger(settings_pack.int_types.proxy_type.swigValue(), px.type() == java.net.Proxy.Type.SOCKS ? settings_pack.proxy_type_t.socks5.swigValue() : settings_pack.proxy_type_t.http.swigValue());
            sp.setString(settings_pack.string_types.proxy_hostname.swigValue(), ad.getHostString()); sp.setInteger(settings_pack.int_types.proxy_port.swigValue(), ad.getPort());
            sp.setBoolean(settings_pack.bool_types.proxy_peer_connections.swigValue(), true); sp.setBoolean(settings_pack.bool_types.proxy_tracker_connections.swigValue(), true); sp.setBoolean(settings_pack.bool_types.proxy_hostnames.swigValue(), true);
        } else sp.setInteger(settings_pack.int_types.proxy_type.swigValue(), settings_pack.proxy_type_t.none.swigValue());
        sp.setString(settings_pack.string_types.outgoing_interfaces.swigValue(), bindIface);
        if (!bindIface.isEmpty()) sp.setString(settings_pack.string_types.listen_interfaces.swigValue(), bindIface + ":" + (listenPort > 0 ? listenPort : 6881));
        sp.setBoolean(settings_pack.bool_types.anonymous_mode.swigValue(), anonymous);
    }
    void configure(JSONObject o) {
        if (o.has("seed")) seedAfterDone = o.optBoolean("seed");
        if (o.has("dht")) dht = o.optBoolean("dht", true); if (o.has("lsd")) lsd = o.optBoolean("lsd", true); if (o.has("upnp")) upnp = o.optBoolean("upnp", true); if (o.has("natpmp")) natpmp = o.optBoolean("natpmp", true);
        if (o.has("enc")) enc = o.optString("enc", "enabled"); if (o.has("seedRatio")) seedRatio = o.optDouble("seedRatio", 0); if (o.has("seedMinutes")) seedMinutes = o.optInt("seedMinutes", 0);
        if (o.has("listenPort")) listenPort = o.optInt("listenPort");
        if (o.has("maxActive")) { maxActive = Math.max(1, o.optInt("maxActive", 3)); pumpQueue(); }
        if (o.has("net")) { JSONObject n = o.optJSONObject("net"); if (n != null) { String u = n.optString("ua", "").trim(); ua = u.isEmpty() ? APP_UA : u; retries = Math.max(0, Math.min(30, n.optInt("retries", 5))); timeoutS = Math.max(5, Math.min(600, n.optInt("timeout", 60))); proxy = n.optString("proxy", "").trim(); conflict = n.optString("conflict", "rename"); } }
        if (o.optBoolean("forgetHosts", false)) { hostLimit.clear(); saveHosts(); }
        if (o.has("simpleDisk")) try { ctx.getSharedPreferences("kt", Context.MODE_PRIVATE).edit().putBoolean("simpleDisk", o.optBoolean("simpleDisk", false)).apply(); } catch (Throwable ignored) {}   // (from the next start)
        if (o.has("addTrackers")) addTrackers = o.optBoolean("addTrackers", true);
        if (o.has("trackers")) { JSONArray a = o.optJSONArray("trackers"); if (a != null && a.length() > 0) { java.util.List<String> l = new java.util.ArrayList<>(); for (int i = 0; i < a.length(); i++) { String u = a.optString(i, "").trim(); if (u.matches("(?i)^(udp|https?|wss?)://\\S+$")) l.add(u); } if (!l.isEmpty()) extraTrackers = l.toArray(new String[0]); } }
        if (o.has("torrentProxy")) torrentProxy = o.optBoolean("torrentProxy"); if (o.has("bindIface")) bindIface = o.optString("bindIface", "").trim(); if (o.has("anonymous")) anonymous = o.optBoolean("anonymous");
        if (session != null && session.isRunning()) {
            SettingsPack sp = new SettingsPack(); sp.activeDownloads(maxActive); sp.setInteger(settings_pack.int_types.active_seeds.swigValue(), seedAfterDone ? 5 : 0);
            if (o.has("listenPort")) sp.setString(settings_pack.string_types.listen_interfaces.swigValue(), listenPort > 0 ? "0.0.0.0:" + listenPort + ",[::]:" + listenPort : "0.0.0.0:6881,[::]:6881");
            applyNet(sp); session.applySettings(sp);
            if (o.has("seed")) for (Task x : snapshot()) if (x.th != null && x.th.isValid() && x.th.status().isFinished()) { if (seedAfterDone) x.th.resume(); else x.th.pause(); }
        }
        try { JSONObject cfg = new JSONObject(); cfg.put("ua", ua); cfg.put("torrentProxy", torrentProxy); cfg.put("bindIface", bindIface); cfg.put("anonymous", anonymous); cfg.put("retries", retries); cfg.put("timeout", timeoutS); cfg.put("proxy", proxy); cfg.put("conflict", conflict); cfg.put("seed", seedAfterDone); cfg.put("listenPort", listenPort); cfg.put("maxActive", maxActive); cfg.put("dht", dht); cfg.put("lsd", lsd); cfg.put("upnp", upnp); cfg.put("natpmp", natpmp); cfg.put("enc", enc); cfg.put("seedRatio", seedRatio); cfg.put("seedMinutes", seedMinutes); write(new File(stateDir, "config.json"), cfg.toString()); } catch (Exception ignored) {}
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
                File state = new File(stateDir, x.id + ".http");
                File part = new File(dir, safe + ".part");
                // A file of that name there already, and this download not begun: as the settings say.
                if (new File(dir, safe).exists() && !part.exists() && !state.exists() && x.done == 0) {
                    if ("skip".equals(conflict)) { x.httpOut = new File(dir, safe); x.done = x.total = x.httpOut.length(); x.state = "done"; x.doneAt = System.currentTimeMillis(); x.error = null; x.downSpeed = 0; if (x.meta == null) x.meta = new JSONObject(); x.meta.put("skipped", true); persist(); tell(true); KtService.maybeStop(ctx, KtEngine.this); return; }
                    if (!"overwrite".equals(conflict)) { safe = freeName(dir, safe); x.name = safe; part = new File(dir, safe + ".part"); }
                }
                x.httpOut = new File(dir, safe);
                final KrDownloader.Result info = new KrDownloader.Result(); x.segs = info.segs;
                final String host = hostOf(url); Integer lim = hostLimit.get(host);
                final KrDownloader.Opts opt = new KrDownloader.Opts(); opt.retries = retries; opt.state = state; opt.expectName = safe;
                opt.cookies = (u, set) -> { try { android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance(); for (String c : set) cm.setCookie(u.toString(), c); } catch (Throwable ignored) {} };
                final int conns = lim == null ? x.wantConnections : Math.max(1, Math.min(x.wantConnections, lim));
                final Runnable tick = () -> { x.total = info.total; x.done = x.got.get(); x.connections = info.connections; long now = System.currentTimeMillis(); if (now - x.lastT >= 700) { long g = x.got.get(); x.downSpeed = x.lastT == 0 ? 0 : (long) ((g - x.lastGot) / ((now - x.lastT) / 1000.0)); x.lastT = now; x.lastGot = g; tell(false); } };
                KrDownloader.Result r;
                try { r = KrDownloader.fetch(new URL(url), part, conns, u -> open(u, headers, false), x.cancel, x.got, info, tick, opt); }
                catch (IOException e) {
                    // (With DNS over HTTPS on, a connection that failed on the way — not an answer the server gave —
                    // tried once more by the network's own DNS.)
                    if (!KrDoh.on() || e instanceof KrDownloader.Status || e instanceof KrDownloader.WebPage || x.cancel.get()) throw e;
                    r = KrDownloader.fetch(new URL(url), part, conns, u -> open(u, headers, true), x.cancel, x.got, info, tick, opt);
                }
                // (The name the server gives — Content-Disposition — when the user gave none and the link's was a code.)
                if (x.autoName && r.fileName != null) { String n = r.fileName.replaceAll("[\\\\/:*?\"<>|\\u0000-\\u001f]+", " ").trim(); if (!n.isEmpty() && !n.equals(safe)) { File want = new File(dir, n); if (want.exists() && !"overwrite".equals(conflict)) n = freeName(dir, n); x.name = n; x.httpOut = new File(dir, n); } x.autoName = false; }
                // (A server that refused connections: asked no more than it accepted next time.)
                if (r.refused && !host.isEmpty()) { hostLimit.put(host, Math.max(1, r.connections)); saveHosts(); }
                if (x.cancel.get()) { x.downSpeed = 0; x.done = x.got.get(); persist(); return; }
                if (r.total > 0 && part.length() != r.total) throw new IOException("incomplete");
                if (x.httpOut.exists()) x.httpOut.delete();
                if (!part.renameTo(x.httpOut)) throw new IOException("cannot keep the file");
                state.delete();
                x.done = x.total = x.httpOut.length(); x.state = "done"; x.doneAt = System.currentTimeMillis(); x.downSpeed = 0;
            } catch (Throwable e) { if (!x.cancel.get()) { x.state = "failed"; x.error = e instanceof KrDownloader.WebPage ? "page" : e instanceof KrDownloader.Status ? "HTTP " + ((KrDownloader.Status) e).code : e.getMessage(); x.done = x.got.get(); } x.downSpeed = 0; }
            persist(); tell(true); pumpQueue(); KtService.maybeStop(ctx, KtEngine.this);
        }, "kt-http-" + x.id);
        x.httpThread.start();
        KtService.ensure(ctx);
    }
    /* ---------- the queue (Prism's): no more file downloads at once than set; the rest wait in their order ---------- */
    private int busyHttp() { int n = 0; for (Task t : snapshot()) if ("http".equals(t.kind) && "downloading".equals(t.state)) n++; return n; }
    /** The next waiting ones started, in the list's order, while there is room. */
    private void pumpQueue() { for (Task t : snapshot()) { if (busyHttp() >= maxActive) break; if ("http".equals(t.kind) && "queued".equals(t.state) && !t.paused) startHttp(t); } }
    /** A download moved in the list: -1 up, +1 down, -2 to the top, +2 to the bottom (what waits starts in this order). */
    void move(String id, int how) {
        synchronized (this) {
            List<String> ids = new ArrayList<>(tasks.keySet()); int i = ids.indexOf(id); if (i < 0) return;
            ids.remove(i); int to = how == -2 ? 0 : how == 2 ? ids.size() : Math.max(0, Math.min(ids.size(), i + how)); ids.add(to, id);
            Map<String, Task> copy = new LinkedHashMap<>(tasks); tasks.clear(); for (String k : ids) tasks.put(k, copy.get(k));
        }
        persist(); tell(true);
    }
    private static String hostOf(String url) { try { return new URL(url).getHost().toLowerCase(java.util.Locale.ROOT); } catch (Exception e) { return ""; } }
    /** «name (2).ext»: the first name not taken in `dir`. */
    static String freeName(File dir, String name) {
        int dot = name.lastIndexOf('.'); String stem = dot > 0 ? name.substring(0, dot) : name, ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 2; i < 10000; i++) { String n = stem + " (" + i + ")" + ext; if (!new File(dir, n).exists() && !new File(dir, n + ".part").exists()) return n; }
        return stem + " (" + System.currentTimeMillis() + ")" + ext;
    }
    private void saveHosts() { try { JSONObject h = new JSONObject(); for (Map.Entry<String, Integer> e : hostLimit.entrySet()) h.put(e.getKey(), e.getValue()); write(new File(stateDir, "hosts.json"), h.toString()); } catch (Exception ignored) {} }
    JSONObject hosts() { JSONObject h = new JSONObject(); try { for (Map.Entry<String, Integer> e : hostLimit.entrySet()) h.put(e.getKey(), e.getValue()); } catch (Exception ignored) {} return h; }
    /** A new address for a download whose link ran out (a signed or expiring link): the same file, gone on from where it stopped. */
    void setUrl(String id, String url) throws Exception {
        Task x = task(id); if (x == null || !"http".equals(x.kind)) throw new IllegalArgumentException("not a file download");
        if (x.cancel != null) x.cancel.set(true); if (x.httpThread != null) x.httpThread.join(5000);
        x.source.put("url", url); x.paused = false; x.error = null; persist(); startHttp(x); tell(true);
    }
    private HttpURLConnection open(URL u, JSONObject headers, boolean plainDns) throws IOException {
        java.net.Proxy px = proxyOf(proxy);
        HttpURLConnection c = px != null ? (HttpURLConnection) u.openConnection(px) : plainDns ? (HttpURLConnection) u.openConnection() : KrDoh.open(u);
        // (The cookies the site set — here or in the app's browser, where a site's check is passed.)
        try { String ck = android.webkit.CookieManager.getInstance().getCookie(u.toString()); if (ck != null && !ck.isEmpty() && (headers == null || (!headers.has("Cookie") && !headers.has("cookie")))) c.setRequestProperty("Cookie", ck); } catch (Throwable ignored) {}
        c.setConnectTimeout(Math.min(30000, timeoutS * 1000)); c.setReadTimeout(timeoutS * 1000); c.setInstanceFollowRedirects(false);
        c.setRequestProperty("User-Agent", ua);
        if (headers != null) { Iterator<String> it = headers.keys(); while (it.hasNext()) { String k = it.next(); c.setRequestProperty(k, headers.optString(k)); } }
        return c;
    }
    /** «http://host:port» or «socks5://host:port» (or «host:port», http) — or none. */
    static java.net.Proxy proxyOf(String p) {
        if (p == null || p.trim().isEmpty()) return null;
        try { String s = p.trim(); java.net.Proxy.Type t = s.toLowerCase(java.util.Locale.ROOT).startsWith("socks") ? java.net.Proxy.Type.SOCKS : java.net.Proxy.Type.HTTP;
            s = s.replaceFirst("^[a-zA-Z0-9]+://", ""); int c = s.lastIndexOf(':'); String h = c > 0 ? s.substring(0, c) : s; int port = c > 0 ? Integer.parseInt(s.substring(c + 1).replaceAll("/.*$", "")) : (t == java.net.Proxy.Type.SOCKS ? 1080 : 8080);
            return new java.net.Proxy(t, java.net.InetSocketAddress.createUnresolved(h, port)); } catch (Exception e) { return null; }
    }
    static String nameFromUrl(String url) {
        try {
            URL u = new URL(url); String p = u.getPath(); String n = java.net.URLDecoder.decode(p.substring(p.lastIndexOf('/') + 1).replace("+", "%2B"), "UTF-8");
            // (A name in the query — ?f=, ?filename=, ?name=, ?file=, ?title= — with an extension: that one.)
            String q = u.getQuery();
            if (q != null) for (String kv : q.split("&")) { int i = kv.indexOf('='); if (i <= 0) continue; String k = kv.substring(0, i).toLowerCase(java.util.Locale.ROOT); if (!(k.equals("f") || k.equals("filename") || k.equals("name") || k.equals("file") || k.equals("title") || k.equals("fn") || k.equals("response-content-disposition"))) continue;
                String v = java.net.URLDecoder.decode(kv.substring(i + 1), "UTF-8"); if (k.equals("response-content-disposition")) { String d = KrDownloader.dispositionName(v); if (d == null) continue; v = d; } v = v.replaceAll(".*[\\\\/]", "").trim(); if (v.matches(".+\\.[A-Za-z0-9]{1,5}")) return v; }
            return n.isEmpty() ? "download" : n;
        } catch (Exception e) { return "download"; }
    }

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
            // (The list as it was kept beside the new one: read back if the new one is ever cut short.)
            File cur = new File(stateDir, "tasks.json"); if (cur.length() > 2) { try { java.nio.file.Files.copy(cur.toPath(), new File(stateDir, "tasks.json.bak").toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING); } catch (Exception ignored) {} }
            write(cur, arr.toString());
        } catch (Exception e) { Log.w(TAG, "persist", e); }
    }
    private static List<Integer> toList(int[] a) { List<Integer> l = new ArrayList<>(); for (int v : a) l.add(v); return l; }
    private static void write(File f, String s) throws IOException { File tmp = new File(f.getPath() + ".tmp"); try (FileOutputStream fo = new FileOutputStream(tmp)) { fo.write(s.getBytes(StandardCharsets.UTF_8)); } if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f); } }
    private void load() {
        try { File cfg = new File(stateDir, "config.json"); if (cfg.exists()) { JSONObject c = new JSONObject(new String(java.nio.file.Files.readAllBytes(cfg.toPath()), StandardCharsets.UTF_8)); seedAfterDone = c.optBoolean("seed", false); listenPort = c.optInt("listenPort", 0); maxActive = c.optInt("maxActive", 3); dht = c.optBoolean("dht", true); lsd = c.optBoolean("lsd", true); upnp = c.optBoolean("upnp", true); natpmp = c.optBoolean("natpmp", true); enc = c.optString("enc", "enabled"); seedRatio = c.optDouble("seedRatio", 0); seedMinutes = c.optInt("seedMinutes", 0); ua = c.optString("ua", APP_UA); torrentProxy = c.optBoolean("torrentProxy", false); bindIface = c.optString("bindIface", ""); anonymous = c.optBoolean("anonymous", false); retries = c.optInt("retries", 5); timeoutS = c.optInt("timeout", 60); proxy = c.optString("proxy", ""); conflict = c.optString("conflict", "rename"); } } catch (Exception ignored) {}
        try { File hf = new File(stateDir, "hosts.json"); if (hf.exists()) { JSONObject h = new JSONObject(new String(java.nio.file.Files.readAllBytes(hf.toPath()), StandardCharsets.UTF_8)); for (Iterator<String> it = h.keys(); it.hasNext(); ) { String k = it.next(); hostLimit.put(k, h.optInt(k, 8)); } } } catch (Exception ignored) {}
        File f = new File(stateDir, "tasks.json"), bak = new File(stateDir, "tasks.json.bak"); if (!f.exists() && !bak.exists()) return;
        try {
            // (The last good copy when this one cannot be read — a write cut short.)
            JSONArray arr; try { arr = new JSONArray(new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8)); } catch (Exception e) { arr = new JSONArray(new String(java.nio.file.Files.readAllBytes(bak.toPath()), StandardCharsets.UTF_8)); }
            boolean any = false;
            for (int i = 0; i < arr.length(); i++) { try {
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
            } catch (Exception e) { Log.w(TAG, "load one", e); } }
            // (A safe start, after the app closed twice right after starting: the torrents kept paused and the torrent
            // engine not started at all — resuming one starts it, so the one that ends the app is told apart.)
            boolean safe = false; try { android.content.SharedPreferences sp = ctx.getSharedPreferences("kt", Context.MODE_PRIVATE); safe = sp.getBoolean("safeStart", false); if (safe) sp.edit().putBoolean("safeStart", false).apply(); } catch (Throwable ignored) {}
            if (safe) { for (Task x : snapshot()) if ("torrent".equals(x.kind) && !"done".equals(x.state)) { x.paused = true; x.state = "paused"; } any = false; persist(); }
            if (any) { for (Task x : snapshot()) if ("torrent".equals(x.kind) && (!"done".equals(x.state) || seedAfterDone)) { try { if ("done".equals(x.state)) x.paused = !seedAfterDone; addTorrent(x); } catch (Exception e) { x.state = "failed"; x.error = e.getMessage(); } } }
        } catch (Exception e) { Log.w(TAG, "load", e); }
    }
}
