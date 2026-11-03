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
        int limitDown, limitUp;   // this torrent's own speed limits (bytes/s; 0 = none)
        /** A torrent's pieces seen from afar (one digit 0–9 for each of 100 stretches: how much of it is here), how
         *  many pieces there are and are here, and when that was last read. */
        String pieceMap; int numPieces, havePieces; long mapAt;
        int[] priorities; // per file: 0 skip, 1 normal, 2 high (null = all normal)
        // torrent
        TorrentHandle th; String magnet; byte[] torrentBytes; TorrentInfo info;
        // http
        AtomicBoolean cancel; Thread httpThread; AtomicLong got = new AtomicLong(); File httpOut; int wantConnections = 8; long lastT; long lastGot; boolean autoName;
    }

    private final Context ctx;
    Context context() { return ctx; }
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
    /** Connections for one torrent (Hayase's 80); the session's budget is connections_limit. */
    private volatile int connsPerTorrent = 150;
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
        // (A crash inside libtorrent last time — its memory-mapped disk access on a phone whose storage does not take it:
        // seen as heap corruption on its disk threads, Android 16–17 —: the simple disk access from now on, by itself.)
        if (!simpleDisk) try {
            File cf = new File(new File(ctx.getFilesDir(), "kt"), "crash.txt");
            if (cf.isFile()) { String c = new String(java.nio.file.Files.readAllBytes(cf.toPath()), java.nio.charset.StandardCharsets.UTF_8);
                if (c.contains("libtorrent4j") && (c.contains("SIGABRT") || c.contains("SIGSEGV") || c.contains("SIGBUS"))) { simpleDisk = true; ctx.getSharedPreferences("kt", Context.MODE_PRIVATE).edit().putBoolean("simpleDisk", true).putBoolean("simpleDiskAuto", true).apply(); Log.w(TAG, "libtorrent crashed last time: simple disk access on"); } }
        } catch (Throwable ignored) {}
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
            if (x != null) { TorrentHandle own = session.find(th.infoHash()); x.th = own; if (own == null) { tell(true); return; } th = own; applyOwn(x); if (x.priorities != null) applyPriorities(x); if (x.sequential) th.setFlags(TorrentFlags.SEQUENTIAL_DOWNLOAD); if (x.paused) th.pause(); else th.resume(); }
            tell(true);
        } else if (t == AlertType.METADATA_RECEIVED) {
            TorrentHandle th = ((MetadataReceivedAlert) a).handle(); Task x = byHash.get(th.infoHash().toHex());
            if (x != null) { TorrentInfo ti = own(th.torrentFile()); if (ti != null) { x.name = ti.name(); x.total = ti.totalSize(); if (x.priorities != null) applyPriorities(x); keepInfo(x, ti); } th.saveResumeData(TorrentHandle.SAVE_INFO_DICT); persist(); tell(true); }
        } else if (t == AlertType.TORRENT_FINISHED) {
            TorrentHandle th = ((TorrentFinishedAlert) a).handle(); Task x = byHash.get(th.infoHash().toHex());
            if (x != null) { if (x.doneAt == 0) x.doneAt = System.currentTimeMillis(); TorrentInfo ti = own(th.torrentFile()); if (ti != null) { keepInfo(x, ti); scan(x); } th.saveResumeData(TorrentHandle.SAVE_INFO_DICT); if (!seedAfterDone) th.pause(); persist(); tell(true); }
        } else if (t == AlertType.SAVE_RESUME_DATA) {
            SaveResumeDataAlert sa = (SaveResumeDataAlert) a; Task x = byHash.get(sa.handle().infoHash().toHex());
            if (x != null) { try { byte[] data = AddTorrentParams.writeResumeDataBuf(sa.params()); try (FileOutputStream fo = new FileOutputStream(new File(stateDir, x.id + ".fastresume"))) { fo.write(data); } } catch (Exception e) { Log.w(TAG, "resume", e); } }
        } else if (t == AlertType.TORRENT_ERROR) {
            TorrentErrorAlert ea = (TorrentErrorAlert) a; Task x = byHash.get(ea.handle().infoHash().toHex());
            if (x != null) { x.error = errOf(ea.error().getMessage()); tell(true); }
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
                try { for (Task x : snapshot()) if ("torrent".equals(x.kind) && x.th == null && x.infoHash != null && !x.infoHash.isEmpty()) { TorrentHandle h = session.find(org.libtorrent4j.Sha1Hash.parseHex(x.infoHash)); if (h != null) { x.th = h; applyOwn(x); if (x.paused) h.pause(); } } } catch (Throwable ignored) {}
                try { if (anyTorrentActive()) session.postTorrentUpdates(); else tell(false); } catch (Throwable ignored) {}
                try { if (System.currentTimeMillis() % 600000 < 700) saveDht(); } catch (Throwable ignored) {}
                try { releaseOthers(); } catch (Throwable ignored) {}
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
        x.wantConnections = Math.max(1, Math.min(32, o.optInt("connections", 24)));
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
        if (!x.dir.startsWith("content:") && !writable(new File(x.dir))) { x.state = "failed"; x.error = "noFolderAccess"; x.paused = true; synchronized (this) { tasks.put(x.id, x); } if (x.infoHash == null && x.source.has("magnet")) { try { x.infoHash = hashOf(AddTorrentParams.parseMagnetUri(x.source.getString("magnet"))); } catch (Exception ignored) {} } return; }
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
    private void applyPriorities(Task x) { if (x.th == null || !x.th.isValid()) return; TorrentInfo ti = infoOf(x); if (ti == null) return; if (x.priorities != null && x.priorities.length < ti.numFiles()) { int[] np = new int[ti.numFiles()]; System.arraycopy(x.priorities, 0, np, 0, x.priorities.length); x.priorities = np; } x.th.prioritizeFiles(prioArray(x, ti)); }

    void pause(String id) { Task x = task(id); if (x == null) return; x.paused = true; if ("video".equals(x.kind)) KtVideo.cancel(x.id); if (x.th != null) { x.th.unsetFlags(TorrentFlags.AUTO_MANAGED); x.th.pause(); x.th.saveResumeData(TorrentHandle.SAVE_INFO_DICT); } if (x.cancel != null) { x.cancel.set(true); } x.state = "paused"; persist(); tell(true); if ("http".equals(x.kind)) bg.execute(() -> { try { if (x.httpThread != null) x.httpThread.join(3000); } catch (InterruptedException ignored) {} pumpQueue(); }); }
    void resume(String id) throws Exception { Task x = task(id); if (x == null) return; x.paused = false; x.error = null; if ("torrent".equals(x.kind)) { if (x.th != null && x.th.isValid()) { x.th.setFlags(TorrentFlags.AUTO_MANAGED); x.th.resume(); x.state = x.th.status().hasMetadata() ? "downloading" : "metadata"; } else addTorrent(x); KtService.ensure(ctx); } else if ("video".equals(x.kind)) startVideo(x); else if (busyHttp() >= maxActive) x.state = "queued"; else startHttp(x); persist(); tell(true); }
    void remove(String id, boolean deleteFiles) {
        Task x; synchronized (this) { x = tasks.remove(id); } if (x == null) return;
        boolean loaded = x.th != null && x.th.isValid() && session != null;
        // (A finished torrent not loaded after a restart: its files found from the copy kept, and deleted here.)
        TorrentInfo kept = deleteFiles && !loaded && "torrent".equals(x.kind) ? infoOf(x) : null;
        if (loaded) { infoOf(x); TorrentHandle h = x.th; x.th = null; if (deleteFiles) session.remove(h, SessionHandle.DELETE_FILES); else session.remove(h); }
        if (kept != null) { java.util.Set<File> dirs = new java.util.HashSet<>(); for (int i = 0; i < kept.numFiles(); i++) { File f = new File(kept.files().filePath(i, x.dir)); f.delete(); new File(f.getPath() + ".part").delete(); File d = f.getParentFile(); while (d != null && !d.getAbsolutePath().equals(new File(x.dir).getAbsolutePath())) { dirs.add(d); d = d.getParentFile(); } } List<File> ds = new ArrayList<>(dirs); ds.sort((a, b) -> b.getAbsolutePath().length() - a.getAbsolutePath().length()); for (File d : ds) { String[] k = d.list(); if (k != null && k.length == 0) d.delete(); } }
        if (x.infoHash != null) byHash.remove(x.infoHash);
        if (x.cancel != null) x.cancel.set(true);
        if ("video".equals(x.kind)) { KtVideo.cancel(x.id); if (deleteFiles && x.httpOut != null) { File[] kids = new File(x.dir).listFiles(); String stem = x.httpOut.getName().replaceAll("\\.[^.]+$", ""); if (kids != null) for (File k : kids) if (k.getName().startsWith(stem)) k.delete(); } }
        if (deleteFiles && x.httpOut != null && !"video".equals(x.kind)) { x.httpOut.delete(); new File(x.httpOut.getPath() + ".part").delete(); }
        new File(stateDir, id + ".http").delete(); new File(stateDir, id + ".fastresume").delete(); new File(stateDir, id + ".torrent").delete();
        persist(); tell(true); KtService.maybeStop(ctx, this);
        if ("http".equals(x.kind)) bg.execute(() -> { try { if (x.httpThread != null) x.httpThread.join(3000); } catch (InterruptedException ignored) {} pumpQueue(); });
    }
    void setFiles(String id, int[] prios) {
        Task x = task(id); if (x == null) return; x.priorities = prios; applyPriorities(x);
        // (A finished torrent given more files to fetch: woken up again, unless it was paused by hand.)
        try { if (!x.paused && x.th != null && x.th.isValid()) { long[] prog = x.th.fileProgress(); TorrentInfo ti = infoOf(x); boolean more = false;
            if (ti != null) for (int i = 0; i < Math.min(prios.length, ti.numFiles()); i++) if (prios[i] > 0 && prog[i] < ti.files().fileSize(i)) { more = true; break; }
            if (more && ("done".equals(x.state) || "seeding".equals(x.state) || x.th.status().isFinished())) { x.doneAt = 0; x.th.setFlags(TorrentFlags.AUTO_MANAGED); x.th.resume(); x.state = "downloading"; KtService.ensure(ctx); } } } catch (Throwable ignored) {}
        persist(); tell(true);
    }
    void setSequential(String id, boolean on) { Task x = task(id); if (x == null || x.th == null) return; x.sequential = on; if (on) x.th.setFlags(TorrentFlags.SEQUENTIAL_DOWNLOAD); else x.th.unsetFlags(TorrentFlags.SEQUENTIAL_DOWNLOAD); persist(); }
    void setLimits(long down, long up) { SessionManager s = session(); s.downloadRateLimit((int) Math.min(Integer.MAX_VALUE, down)); s.uploadRateLimit((int) Math.min(Integer.MAX_VALUE, up)); }
    /** A torrent's own settings on its handle: speed limits, its share of connections. */
    private void applyOwn(Task x) {
        try { TorrentHandle h = x.th; if (h == null || !h.isValid()) return; h.setDownloadLimit(x.limitDown > 0 ? x.limitDown : -1); h.setUploadLimit(x.limitUp > 0 ? x.limitUp : -1); h.swig().set_max_connections(connsPerTorrent > 0 ? connsPerTorrent : 16777215); } catch (Throwable e) { Log.w(TAG, "own", e); }
    }
    /* ---------- one torrent up close: its peers and trackers; checked again, announced again, its own limits ---------- */
    JSONObject torrentDetail(String id) throws Exception {
        Task x = task(id); JSONObject o = new JSONObject(); if (x == null || x.th == null || !x.th.isValid()) return o;
        JSONArray peers = new JSONArray(); int n = 0;
        for (org.libtorrent4j.PeerInfo p : x.th.peerInfo()) { if (n++ >= 200) break; JSONObject q = new JSONObject(); q.put("ip", p.ip()); q.put("client", p.client()); q.put("down", p.downSpeed()); q.put("up", p.upSpeed()); q.put("progress", p.progress()); q.put("total", p.totalDownload()); q.put("utp", String.valueOf(p.connectionType()).toLowerCase(java.util.Locale.ROOT).contains("utp")); peers.put(q); }
        JSONArray trs = new JSONArray();
        for (org.libtorrent4j.AnnounceEntry e : x.th.trackers()) {
            JSONObject q = new JSONObject(); q.put("url", e.url()); q.put("tier", e.tier()); String state = "waiting", msg = ""; int fails = 0;
            for (org.libtorrent4j.AnnounceEndpoint ep : e.endpoints()) { org.libtorrent4j.AnnounceInfohash ih = ep.infohashV1(); if (ih == null) continue; if (ih.updating()) state = "updating"; else if (ih.isWorking() && !"updating".equals(state)) state = "working"; else if (ih.fails() > 0 && "waiting".equals(state)) state = "failing"; if (!ih.message().isEmpty()) msg = ih.message(); fails = Math.max(fails, ih.fails()); }
            q.put("state", state); q.put("message", msg); q.put("fails", fails); trs.put(q);
        }
        o.put("peers", peers); o.put("trackers", trs); o.put("limitDown", x.limitDown); o.put("limitUp", x.limitUp);
        try { TorrentStatus st = x.th.status(); o.put("seeds", st.numSeeds()); o.put("peersConnected", st.numPeers()); o.put("seedsInSwarm", st.listSeeds()); o.put("peersInSwarm", st.listPeers()); o.put("ratio", st.allTimeDownload() > 0 ? (double) st.allTimeUpload() / st.allTimeDownload() : 0); } catch (Throwable ignored) {}
        return o;
    }
    /* ---------- watching first: while a stream is read, the other torrents wait (a trickle each) ---------- */
    private volatile long streamAt = 0; private volatile String streamHash = null; private volatile boolean othersHeld = false;
    void streaming(TorrentHandle th) {
        streamAt = System.currentTimeMillis();
        try { String hsh = th.infoHash().toHex(); if (othersHeld && hsh.equals(streamHash)) return; streamHash = hsh; othersHeld = true;
            for (Task x : snapshot()) if (x.th != null && x.th.isValid() && !hsh.equals(x.infoHash)) x.th.setDownloadLimit(48 * 1024);
        } catch (Throwable e) { Log.w(TAG, "streaming", e); }
    }
    /** No stream read for a minute: the others back to their own limits. */
    private void releaseOthers() { if (!othersHeld || System.currentTimeMillis() - streamAt < 60000) return; othersHeld = false; streamHash = null; for (Task x : snapshot()) applyOwn(x); }
    void recheck(String id) { Task x = task(id); if (x != null && x.th != null && x.th.isValid()) { x.th.forceRecheck(); x.state = "checking"; tell(true); } }
    void reannounce(String id) { Task x = task(id); if (x != null && x.th != null && x.th.isValid()) { x.th.forceReannounce(); try { x.th.swig().force_dht_announce(); } catch (Throwable ignored) {} } }
    void setTaskLimits(String id, int down, int up) { Task x = task(id); if (x == null) return; x.limitDown = Math.max(0, down); x.limitUp = Math.max(0, up); applyOwn(x); persist(); tell(true); }
    /** Watching a file while it comes (Seanime's order): its first 8 MB now, the next 24 MB soon, its last 4 MB
     *  early too (where a video keeps its index, which players read first to seek), then the rest in order. */
    void prepareStream(String id, int fileIndex) {
        try {
            Task x = task(id); if (x == null || x.th == null || !x.th.isValid()) return; TorrentInfo ti = infoOf(x); if (ti == null) return;
            FileStorage fs = ti.files(); if (fileIndex < 0 || fileIndex >= fs.numFiles()) return; long size = fs.fileSize(fileIndex); if (size <= 0) return;
            int first = fs.mapFile(fileIndex, 0, 1).piece(), last = fs.mapFile(fileIndex, size - 1, 1).piece();
            int now = fs.mapFile(fileIndex, Math.min(size - 1, 8L << 20), 1).piece(), soon = fs.mapFile(fileIndex, Math.min(size - 1, 32L << 20), 1).piece(), tail = fs.mapFile(fileIndex, Math.max(0, size - (4L << 20)), 1).piece();
            for (int k = first; k <= last; k++) { if (x.th.havePiece(k)) continue; if (k <= now) { x.th.piecePriority(k, Priority.TOP_PRIORITY); x.th.setPieceDeadline(k, (k - first) * 300); } else if (k <= soon || k >= tail) x.th.piecePriority(k, Priority.SIX); }
            if (!x.sequential) { x.sequential = true; x.th.setFlags(TorrentFlags.SEQUENTIAL_DOWNLOAD); }
        } catch (Throwable e) { Log.w(TAG, "prepare stream", e); }
    }
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
        sp.setInteger(settings_pack.int_types.aio_threads.swigValue(), 4);
        sp.setInteger(settings_pack.int_types.hashing_threads.swigValue(), Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors() / 2)));
        sp.setInteger(settings_pack.int_types.active_limit.swigValue(), 60);
        sp.setInteger(settings_pack.int_types.dht_upload_rate_limit.swigValue(), 50000);
        sp.setInteger(settings_pack.int_types.max_peerlist_size.swigValue(), 4000);
        sp.setBoolean(settings_pack.bool_types.smooth_connects.swigValue(), false);
        // (TCP before µTP when a peer has both — µTP backs off sooner, and phones see slower µTP than TCP — and
        // bigger socket buffers, so a fast peer is not held back by a small window.)
        sp.setInteger(settings_pack.int_types.mixed_mode_algorithm.swigValue(), settings_pack.bandwidth_mixed_algo_t.prefer_tcp.swigValue());
        sp.setInteger(settings_pack.int_types.recv_socket_buffer_size.swigValue(), 1 << 20);
        sp.setInteger(settings_pack.int_types.send_socket_buffer_size.swigValue(), 1 << 20);
        // (More requests kept with each peer — ten seconds' worth instead of three — so a fast or far peer is never
        // left waiting between them; pieces taken next to each other, so the disk writes in long runs; a peer that
        // went away tried again sooner; whole pieces asked of fast peers, so pieces finish instead of all being
        // half-filled at once.)
        sp.setInteger(settings_pack.int_types.request_queue_time.swigValue(), 10);
        sp.setBoolean(settings_pack.bool_types.piece_extent_affinity.swigValue(), true);
        sp.setInteger(settings_pack.int_types.min_reconnect_time.swigValue(), 10);
        sp.setInteger(settings_pack.int_types.whole_pieces_threshold.swigValue(), 30);
        sp.setInteger(settings_pack.int_types.max_failcount.swigValue(), 5);
        sp.setInteger(settings_pack.int_types.peer_timeout.swigValue(), 60);
        sp.setInteger(settings_pack.int_types.inactivity_timeout.swigValue(), 240);
        sp.setInteger(settings_pack.int_types.unchoke_slots_limit.swigValue(), 16);
        // (More peers at once, and more room for what they send before it is written: a fast connection kept
        // full instead of waiting on the disk or on a small peer list.)
        sp.setInteger(settings_pack.int_types.connections_limit.swigValue(), 500);
        sp.setInteger(settings_pack.int_types.max_queued_disk_bytes.swigValue(), 16 << 20);
        sp.setInteger(settings_pack.int_types.max_peer_recv_buffer_size.swigValue(), 4 << 20);
        sp.setInteger(settings_pack.int_types.send_not_sent_low_watermark.swigValue(), 512 << 10);
        // (The DHT found at once on a first start — several well-known nodes, not one —; uploads given to the
        // peers that give back the most (rate-based: libtorrent's 2 = rate_based_choker, and 1 = fastest_upload
        // when seeding), which is what keeps them sending; and peers behind one shared address all let in.)
        sp.setString(settings_pack.string_types.dht_bootstrap_nodes.swigValue(), "dht.libtorrent.org:25401,router.bittorrent.com:6881,dht.transmissionbt.com:6881,router.utorrent.com:6881");
        sp.setInteger(settings_pack.int_types.choking_algorithm.swigValue(), 2);
        sp.setInteger(settings_pack.int_types.seed_choking_algorithm.swigValue(), 1);
        sp.setBoolean(settings_pack.bool_types.allow_multiple_connections_per_ip.swigValue(), true);
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
        if (o.has("connsPerTorrent")) { connsPerTorrent = Math.max(0, o.optInt("connsPerTorrent", 150)); for (Task t : snapshot()) applyOwn(t); }
        if (o.has("connsTotal")) { int n = Math.max(20, o.optInt("connsTotal", 500)); try { SessionManager sm = session; if (sm != null && sm.isRunning()) { SettingsPack sp = new SettingsPack(); sp.connectionsLimit(n); sm.applySettings(sp); } } catch (Throwable ignored) {} }
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
                x.done = x.total; x.downSpeed = 0; x.state = "done"; x.doneAt = System.currentTimeMillis(); scan(x); persist(); tell(true); KtService.maybeStop(ctx, this);
            } catch (Exception e) {
                if (x.paused) { x.state = "paused"; } else { x.state = "failed"; x.error = errOf(e); }
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
                if (!writable(dir)) throw new IOException("EPERM");
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
                // (The server's own name for the file — Content-Disposition, or the right extension for its type — taken
                // as soon as the server answers, not at the end: an APK no longer shows as «.bin» while it comes.)
                final File dirF = dir;
                opt.named = (n, mime) -> {
                    if (!x.autoName) return null; String nn = n == null ? null : n.replaceAll("[\\\\/:*?\"<>|\\u0000-\\u001f]+", " ").trim();
                    if (nn == null || nn.isEmpty()) nn = KrDownloader.withTypeExt(x.name, mime); if (nn == null || nn.equals(x.name)) { x.autoName = false; return null; }
                    if (new File(dirF, nn).exists() && !"overwrite".equals(conflict)) nn = freeName(dirF, nn);
                    x.name = nn; x.httpOut = new File(dirF, nn); x.autoName = false; persist(); tell(true); return new File(dirF, nn + ".part");
                };
                opt.cookies = (u, set) -> { try { android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance(); for (String c : set) cm.setCookie(u.toString(), c); } catch (Throwable ignored) {} };
                final int conns = lim == null ? x.wantConnections : Math.max(1, Math.min(x.wantConnections, lim));
                final Runnable tick = () -> { x.total = info.total; x.done = x.got.get(); x.connections = info.connections; long now = System.currentTimeMillis(); if (now - x.lastT >= 700) { long g = x.got.get(); x.downSpeed = x.lastT == 0 ? 0 : (long) ((g - x.lastGot) / ((now - x.lastT) / 1000.0)); x.lastT = now; x.lastGot = g; tell(false); } };
                KrDownloader.Result r;
                final File part0 = part;
                try { r = KrDownloader.fetch(new URL(url), part0, conns, u -> open(u, headers, false), x.cancel, x.got, info, tick, opt); }
                catch (IOException e) {
                    // (With DNS over HTTPS on, a connection that failed on the way — not an answer the server gave —
                    // tried once more by the network's own DNS.)
                    if (!KrDoh.on() || e instanceof KrDownloader.Status || e instanceof KrDownloader.WebPage || x.cancel.get()) throw e;
                    r = KrDownloader.fetch(new URL(url), part0, conns, u -> open(u, headers, true), x.cancel, x.got, info, tick, opt);
                }
                if (r.out != null) part = r.out;
                // (The name the server gives — Content-Disposition — when the user gave none and the link's was a code.)
                if (x.autoName && r.fileName != null) { String n = r.fileName.replaceAll("[\\\\/:*?\"<>|\\u0000-\\u001f]+", " ").trim(); if (!n.isEmpty() && !n.equals(safe)) { File want = new File(dir, n); if (want.exists() && !"overwrite".equals(conflict)) n = freeName(dir, n); x.name = n; x.httpOut = new File(dir, n); } x.autoName = false; }
                // (A server that refused connections: asked no more than it accepted next time.)
                if (r.refused && !host.isEmpty()) { hostLimit.put(host, Math.max(1, r.connections)); saveHosts(); }
                if (x.cancel.get()) { x.downSpeed = 0; x.done = x.got.get(); persist(); return; }
                if (r.total > 0 && part.length() != r.total) throw new IOException("incomplete");
                if (x.httpOut.exists()) x.httpOut.delete();
                if (!part.renameTo(x.httpOut)) throw new IOException("cannot keep the file");
                state.delete();
                // (What the file really is, from its first bytes — sites that send every file as «.bin» or with no type —:
                // its extension put right, so an APK is an APK, a video plays, a book opens.)
                try { String nm = KrDownloader.withSniffed(x.name, KrDownloader.sniffExt(x.httpOut)); if (nm != null) { File to = new File(dir, nm); if (to.exists()) to = new File(dir, freeName(dir, nm)); if (x.httpOut.renameTo(to)) { x.name = to.getName(); x.httpOut = to; } } } catch (Throwable ignored) {}
                x.done = x.total = x.httpOut.length(); x.state = "done"; x.doneAt = System.currentTimeMillis(); x.downSpeed = 0; scan(x);
            } catch (Throwable e) { if (!x.cancel.get()) { x.state = "failed"; x.error = e instanceof KrDownloader.WebPage ? "page" : e instanceof KrDownloader.Status ? "HTTP " + ((KrDownloader.Status) e).code : errOf(e); x.done = x.got.get(); } x.downSpeed = 0; }
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
    void setUrl(String id, String url) throws Exception { setUrl(id, url, null); }
    void setUrl(String id, String url, JSONObject headers) throws Exception {
        Task x = task(id); if (x == null || !"http".equals(x.kind)) throw new IllegalArgumentException("not a file download");
        if (x.cancel != null) x.cancel.set(true); if (x.httpThread != null) x.httpThread.join(5000);
        x.source.put("url", url); if (headers != null && headers.length() > 0) x.source.put("headers", headers); x.paused = false; x.error = null; persist(); startHttp(x); tell(true);
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
                x.total = st.totalWanted() > 0 ? st.totalWanted() : st.total();
                // (libtorrent counts a piece only once it is whole and checked; with many peers each filling its own
                // piece, the count stood still at 0 B for long stretches. The blocks already in — 16 KiB each — of the
                // pieces under way are counted too, so the progress moves as the bytes come.)
                long partial = 0; java.util.Map<Integer, Float> part = new java.util.HashMap<>();
                boolean active = !x.paused && st.state() == TorrentStatus.State.DOWNLOADING;
                if (active) { try { for (org.libtorrent4j.PartialPieceInfo pp : x.th.getDownloadQueue()) { int got = pp.finished() + pp.writing(); partial += (long) got * 16384; if (pp.blocksInPiece() > 0) part.put(pp.pieceIndex(), got / (float) pp.blocksInPiece()); } } catch (Throwable ignored) {} }
                x.done = Math.min(x.total > 0 ? x.total : Long.MAX_VALUE, st.totalWantedDone() + partial);
                long nowMs = System.currentTimeMillis();
                if (nowMs - x.mapAt > (active ? 1500 : 15000)) { x.mapAt = nowMs; try { pieceMap(x, part); } catch (Throwable ignored) {} } x.downSpeed = st.downloadPayloadRate(); x.upSpeed = st.uploadPayloadRate(); x.seeds = st.numSeeds(); x.peers = Math.max(0, st.numPeers() - x.seeds);   // (libtorrent's peers count the seeds too)
                if (x.name == null || x.name.isEmpty() || "magnet".equals(x.name)) { String n = st.name(); if (n != null && !n.isEmpty()) x.name = n; }
                if (x.paused) x.state = "paused";
                else if (st.errorCode() != null && st.errorCode().isError()) { x.state = "failed"; x.error = errOf(st.errorCode().getMessage()); }
                else switch (st.state()) {
                    case CHECKING_FILES: case CHECKING_RESUME_DATA: x.state = "checking"; break;
                    case DOWNLOADING_METADATA: x.state = "metadata"; break;
                    case FINISHED: case SEEDING: x.state = seedAfterDone ? "seeding" : "done"; if (x.doneAt == 0) x.doneAt = System.currentTimeMillis(); break;
                    default: x.state = "downloading";
                }
            } catch (Exception ignored) {}
        }
    }
    /** The pieces in a hundred stretches, each a digit for how much of it is here (partly filled pieces counted by
     *  their blocks); the count of pieces here. */
    private void pieceMap(Task x, java.util.Map<Integer, Float> part) {
        TorrentStatus ps = x.th.status(TorrentHandle.QUERY_PIECES); org.libtorrent4j.PieceIndexBitfield bf = ps.pieces(); int n = bf.size(); if (n <= 0) return;
        int buckets = Math.min(100, n); float[] fill = new float[buckets]; int[] count = new int[buckets]; int have = 0;
        for (int i = 0; i < n; i++) { int b = (int) ((long) i * buckets / n); count[b]++; if (bf.getBit(i)) { fill[b] += 1; have++; } else { Float f = part.get(i); if (f != null) fill[b] += f; } }
        StringBuilder sb = new StringBuilder(buckets); for (int b = 0; b < buckets; b++) { float f = count[b] > 0 ? fill[b] / count[b] : 0; sb.append((char) ('0' + Math.min(9, (int) Math.ceil(f * 9 - 0.0001)))); }
        x.pieceMap = sb.toString(); x.numPieces = n; x.havePieces = have;
    }
    JSONObject json(Task x) {
        JSONObject o = new JSONObject();
        try {
            o.put("id", x.id); o.put("kind", x.kind); o.put("name", x.name == null ? "" : x.name); o.put("source", x.source); o.put("dir", x.dir); o.put("state", x.state);
            o.put("done", x.done); o.put("total", x.total); o.put("downSpeed", x.downSpeed); o.put("upSpeed", x.upSpeed);
            if (x.downSpeed > 0 && x.total > x.done) o.put("eta", (x.total - x.done) / x.downSpeed);
            if ("torrent".equals(x.kind)) { o.put("peers", x.peers); o.put("seeds", x.seeds); if (x.pieceMap != null) { o.put("pieceMap", x.pieceMap); o.put("numPieces", x.numPieces); o.put("havePieces", x.havePieces); } if (x.infoHash != null) o.put("infoHash", x.infoHash); } else { o.put("connections", x.connections);
                if (x.segs != null && "downloading".equals(x.state)) { JSONArray sa = new JSONArray(); synchronized (x.segs) { for (KrDownloader.Seg sg : x.segs) { JSONObject so = new JSONObject(); so.put("start", sg.start); so.put("pos", sg.pos); so.put("end", sg.end); so.put("speed", (long) sg.speed); so.put("active", sg.active); so.put("worker", sg.worker); sa.put(so); } } o.put("segments", sa); } }
            o.put("files", files(x)); o.put("sequential", x.sequential); if (x.limitDown > 0) o.put("limitDown", x.limitDown); if (x.limitUp > 0) o.put("limitUp", x.limitUp); if (x.error != null) o.put("error", x.error);
            o.put("addedAt", x.addedAt); if (x.doneAt > 0) o.put("doneAt", x.doneAt); if (x.meta != null) o.put("meta", x.meta); o.put("engine", "native");
        } catch (Exception ignored) {}
        return o;
    }
    private JSONArray files(Task x) {
        JSONArray arr = new JSONArray();
        try {
            if (x.th != null && x.th.isValid()) {
                TorrentInfo ti = infoOf(x);
                if (ti != null) {
                    FileStorage fs = ti.files(); long[] prog = x.th.fileProgress(); Priority[] pr = x.th.filePriorities();
                    for (int i = 0; i < fs.numFiles(); i++) { JSONObject f = new JSONObject(); f.put("index", i); f.put("path", fs.filePath(i)); f.put("size", fs.fileSize(i)); f.put("done", prog != null && i < prog.length ? prog[i] : 0); int p = pr != null && i < pr.length ? pr[i].swig() : 4; f.put("priority", p == 0 ? 0 : p >= 7 ? 2 : 1); arr.put(f); }
                }
            } else if ("torrent".equals(x.kind) && infoOf(x) != null) {
                FileStorage fs = infoOf(x).files(); boolean done = "done".equals(x.state) || "seeding".equals(x.state);
                for (int i = 0; i < fs.numFiles(); i++) { int p = x.priorities == null || i >= x.priorities.length ? 1 : x.priorities[i]; JSONObject f = new JSONObject(); f.put("index", i); f.put("path", fs.filePath(i)); f.put("size", fs.fileSize(i)); f.put("done", done && p > 0 ? fs.fileSize(i) : 0); f.put("priority", p == 0 ? 0 : p >= 2 ? 2 : 1); arr.put(f); }
            } else if ("http".equals(x.kind) || "video".equals(x.kind)) { JSONObject f = new JSONObject(); f.put("index", 0); f.put("path", x.httpOut != null ? x.httpOut.getName() : x.name); f.put("size", x.total); f.put("done", x.done); f.put("priority", 1); arr.put(f); }
        } catch (Exception ignored) {}
        return arr;
    }

    /** The file of a task on disk (a torrent's by index). */
    File fileOf(Task x, int index) {
        if ("http".equals(x.kind) || "video".equals(x.kind)) return x.httpOut != null ? x.httpOut : new File(x.dir, x.name);
        TorrentInfo ti = infoOf(x); if (ti == null) return null;
        if (index < 0 || index >= ti.numFiles()) index = mainFile(x, ti);
        return new File(ti.files().filePath(index, x.th != null && x.th.isValid() ? x.th.savePath() : x.dir));
    }
    /** The file «Open» means for a torrent: the largest of the files chosen and here (not the first in its list). */
    int mainFile(Task x, TorrentInfo ti) {
        FileStorage fs = ti.files(); long[] prog = null; try { if (x.th != null && x.th.isValid()) prog = x.th.fileProgress(); } catch (Throwable ignored) {}
        int best = 0; long size = -1;
        for (int i = 0; i < fs.numFiles(); i++) { boolean chosen = x.priorities == null || i >= x.priorities.length || x.priorities[i] > 0; boolean here = prog == null || (i < prog.length && prog[i] >= fs.fileSize(i)); if (chosen && here && fs.fileSize(i) > size) { size = fs.fileSize(i); best = i; } }
        return best;
    }
    /** A torrent's description: from its handle, else the copy kept beside the task (a finished torrent is not
     *  loaded again after a restart — its files are still found, opened and listed). */
    TorrentInfo infoOf(Task x) {
        // (Always the app's own copy: the handle's torrentFile() is libtorrent's object itself, freed when the torrent is
        // removed — a list or a stream still reading it then ended the whole app, SIGABRT in free, 0.12.4.)
        if (x.info != null) return x.info;
        try { if (x.th != null && x.th.isValid()) { TorrentInfo ti = own(x.th.torrentFile()); if (ti != null) { x.info = ti; return ti; } } } catch (Throwable ignored) {}
        try { File tf = new File(stateDir, x.id + ".torrent"); if (tf.exists()) x.info = new TorrentInfo(tf); } catch (Throwable ignored) {}
        return x.info;
    }
    /** An owned copy of a torrent's description (freed by Java, not with the torrent). */
    static TorrentInfo own(TorrentInfo ti) { try { return ti == null ? null : new TorrentInfo(new org.libtorrent4j.swig.torrent_info(ti.swig())); } catch (Throwable e) { return null; } }
    private void keepInfo(Task x, TorrentInfo ti) {
        if (x.info == null) x.info = ti; File tf = new File(stateDir, x.id + ".torrent"); if (tf.exists()) return;
        try (FileOutputStream fo = new FileOutputStream(tf)) { org.libtorrent4j.swig.add_torrent_params ap = new org.libtorrent4j.swig.add_torrent_params(); ap.set_ti(ti.swig()); fo.write(org.libtorrent4j.Vectors.byte_vector2bytes(org.libtorrent4j.swig.libtorrent.write_torrent_file_buf_ex(ap))); } catch (Throwable e) { Log.w(TAG, "keep torrent", e); }
    }
    /** Finished downloads in another folder moved to `dest` (the app's folder in Download, by default): their files
     *  renamed there, or copied and the old ones deleted when the two are on different storage; how many moved. */
    int moveFinished(String dest) {
        File to = dest == null || dest.isEmpty() ? defaultDir() : new File(dest); to.mkdirs(); int n = 0;
        for (Task x : snapshot()) {
            if (!"done".equals(x.state) || x.dir == null || x.dir.startsWith("content:") || new File(x.dir).getAbsolutePath().equals(to.getAbsolutePath())) continue;
            if (x.th != null && x.th.isValid()) continue;   // (one seeding is left where it is)
            try {
                List<String> rels = new ArrayList<>();
                if ("torrent".equals(x.kind)) { TorrentInfo ti = infoOf(x); if (ti == null) continue; for (int i = 0; i < ti.numFiles(); i++) rels.add(ti.files().filePath(i)); }
                else if (x.httpOut != null) rels.add(x.httpOut.getName()); else continue;
                boolean ok = true;
                for (String rel : rels) { File a = new File(x.dir, rel); if (!a.exists()) continue; File b = new File(to, rel); b.getParentFile().mkdirs(); if (!a.renameTo(b)) { try { java.nio.file.Files.copy(a.toPath(), b.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING); a.delete(); } catch (Exception e) { ok = false; } } }
                if (!ok) continue;
                if (!"torrent".equals(x.kind)) x.httpOut = new File(to, x.httpOut.getName());
                x.dir = to.getAbsolutePath(); n++; scan(x);
            } catch (Throwable e) { Log.w(TAG, "move", e); }
        }
        if (n > 0) { persist(); tell(true); }
        return n;
    }
    /** Finished files told to the phone's media store, so the gallery, music and file apps show them at once. */
    void scan(Task x) {
        try {
            List<String> paths = new ArrayList<>();
            if ("torrent".equals(x.kind)) { TorrentInfo ti = infoOf(x); if (ti != null) for (int i = 0; i < ti.numFiles() && paths.size() < 500; i++) if (x.priorities == null || i >= x.priorities.length || x.priorities[i] > 0) paths.add(new File(ti.files().filePath(i, x.dir)).getAbsolutePath()); }
            else if (x.httpOut != null) paths.add(x.httpOut.getAbsolutePath());
            if (!paths.isEmpty()) android.media.MediaScannerConnection.scanFile(ctx, paths.toArray(new String[0]), null, null);
        } catch (Throwable ignored) {}
    }
    KtStream stream() { return stream; }
    /** A folder Android does not let the app write to (Android 11+: a folder of its own at the storage's root, or
     *  outside Download and Documents, without «All files access»): said as «noFolderAccess», which the page offers
     *  to fix. */
    static String errOf(Throwable e) { String m = e == null ? null : e.getMessage(); return errOf(m); }
    static String errOf(String m) { if (m == null) return null; return m.contains("EPERM") || m.contains("EACCES") || m.contains("Operation not permitted") || m.contains("Permission denied") ? "noFolderAccess" : m; }
    /** Whether files can be made in `dir` (made if missing). */
    static boolean writable(File dir) {
        try { if (!dir.isDirectory() && !dir.mkdirs()) return false; File probe = new File(dir, ".kt-probe-" + System.nanoTime()); try (FileOutputStream fo = new FileOutputStream(probe)) { fo.write(1); } return probe.delete() || !probe.exists(); } catch (Throwable e) { return false; }
    }
    /** Where downloads go when no folder was chosen: the app's own folder in the phone's Download folder
     *  (Download/Kurokawa) — seen by every file manager, kept if the app is removed — when the phone lets the app
     *  write there; else the app's own storage, as before. */
    private volatile File defaultDirCache;
    File defaultDir() {
        File c = defaultDirCache; if (c != null) return c;
        File d = null;
        try {
            File pub = new File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS), "Kurokawa");
            boolean allowed = android.os.Build.VERSION.SDK_INT >= 29 || androidx.core.content.ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.WRITE_EXTERNAL_STORAGE) == android.content.pm.PackageManager.PERMISSION_GRANTED;
            if (allowed && (pub.isDirectory() || pub.mkdirs())) { File probe = new File(pub, ".kt-probe"); try (FileOutputStream fo = new FileOutputStream(probe)) { fo.write(1); } if (probe.delete() || !probe.exists()) d = pub; }
        } catch (Throwable ignored) {}
        if (d == null) { File ext = ctx.getExternalFilesDir(null); d = new File(ext != null ? ext : ctx.getFilesDir(), "Downloads"); d.mkdirs(); }
        defaultDirCache = d; return d;
    }

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
                x.limitDown = o.optInt("limitDown", 0); x.limitUp = o.optInt("limitUp", 0); x.done = o.optLong("done"); x.total = o.optLong("total"); x.addedAt = o.optLong("addedAt", System.currentTimeMillis()); x.doneAt = o.optLong("doneAt"); x.meta = o.optJSONObject("meta"); x.sequential = o.optBoolean("sequential"); x.paused = o.optBoolean("paused"); x.infoHash = o.optString("infoHash", null); x.error = o.optString("error", null); x.wantConnections = o.optInt("connections", 8);
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
