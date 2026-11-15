package app.kurokawa.tools;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Stage M3: KtEngine's torrents on the Rust engine (librqbit, {@link KtTorrentRs}) — the second torrent engine beside
 * libtorrent4j, with the surface KtEngine uses for a torrent: add, the polled numbers, pause / resume / remove, files,
 * limits, the stream's bytes, the hand-back. Chosen PER TORRENT when it is added («Torrent engine» in Settings →
 * Advanced, phones only, default Classic; kept in the task's meta as `torEngine`), never two engines on one torrent:
 * a task is the Rust engine's only while {@link #holds} says so, and KtEngine's libtorrent paths skip it then.
 * A Rust failure before any byte → the same source restarted on libtorrent at once (counted); after bytes → paused
 * with «rust: …» and marked classic: resuming it hands the folder to libtorrent, which checks the files there.
 * The foreground service, notifications, wake locks and the Wi-Fi-only / battery holds are KtEngine's, unchanged:
 * they act through pause / resume, which come here for a Rust task.
 */
final class KtTorrentRsEngine {
    /** What KtEngine gives this (its private parts, through an object it makes). */
    interface Host {
        File stateDir();
        boolean seedAfterDone();
        double seedRatio();
        int seedMinutes();
        /** A hold (Wi-Fi only on mobile data, a low battery) that applies to downloads now. */
        boolean held();
        int listenPort();
        boolean dht();
        boolean upnp();
        boolean addTrackers();
        List<String> trackers();
        /** The task given to libtorrent now (it starts it, or leaves it paused): the hand-over. */
        void toClassic(KtEngine.Task x, boolean start);
        void changed();
        /** The tasks by id, now. */
        Map<String, KtEngine.Task> byId();
    }

    /** One Rust task's last numbers (the poll sends only rows that changed). */
    static final class Row { volatile String state = "metadata", name, folder; volatile long done, total, down, up; volatile int peers; volatile JSONArray files; volatile String error; }

    private final Host host;
    private final Map<String, Row> rows = new ConcurrentHashMap<>();
    KtTorrentRsEngine(Host host) { this.host = host; }

    /** Whether this engine holds the task now. */
    boolean holds(KtEngine.Task x) { return x != null && rows.containsKey(x.id); }
    int count() { return rows.size(); }

    /** The engine the settings name for a new torrent, decided by kt-core's tormobile (`tor.choose`): «rust» only with
     *  the torrent library here, a real folder path (librqbit cannot write into a SAF tree), no proxy, no bound
     *  interface, no anonymous mode, encryption not forced; «director» with the core; else «classic». Without the core
     *  only «classic» or (the same checks, in Java) «rust». */
    static String choose(String choice, String dir, boolean proxy, String bindIface, boolean anonymous, String enc, boolean failedBefore) {
        boolean lib = KtTorrentRs.available();
        if (KtCore.available()) {
            try { Object r = KtCore.r("tor.choose", "choice", choice, "torrentLib", lib, "dir", dir, "proxy", proxy, "bindIface", bindIface, "anonymous", anonymous, "enc", enc, "failedBefore", failedBefore); return String.valueOf(((Map<?, ?>) r).get("engine")); }
            catch (Throwable ignored) { return "classic"; }
        }
        boolean ok = "rust".equals(choice) && lib && !failedBefore && dir != null && dir.startsWith("/") && !proxy && (bindIface == null || bindIface.trim().isEmpty()) && !anonymous && !"forced".equals(enc);
        return ok ? "rust" : "classic";
    }

    /** The torrent given to librqbit (its session started first). False: not taken — libtorrent takes it, counted. */
    boolean add(KtEngine.Task x, String name, boolean multi) {
        try {
            if (!KtTorrentRs.started()) KtTorrentRs.start(new File(host.stateDir(), "rqbit").getAbsolutePath(), host.listenPort(), host.dht(), host.upnp(), host.trackers(), host.addTrackers(), 0, 0);
            List<Integer> files = null; if (x.priorities != null) { files = new ArrayList<>(); for (int i = 0; i < x.priorities.length; i++) if (x.priorities[i] > 0) files.add(i); if (files.isEmpty()) files = null; }
            String b64 = x.source.has("torrent") ? x.source.optString("torrent", null) : null;
            KtTorrentRs.add(x.id, x.infoHash, x.source.optString("magnet", null), b64, x.dir, name, multi, files, x.paused);
            Row r = new Row(); r.name = name; r.state = x.paused ? "paused" : b64 != null ? "checking" : "metadata"; rows.put(x.id, r);
            x.state = r.state; mark(x, "rust");
            startPoller();
            return true;
        } catch (Throwable e) {
            KtTorrentRs.FALLBACKS.incrementAndGet(); mark(x, "classic");
            return false;
        }
    }
    private static void mark(KtEngine.Task x, String engine) { try { if (x.meta == null) x.meta = new JSONObject(); x.meta.put("torEngine", engine); } catch (Exception ignored) {} }

    private Thread poller;
    /** Polled every 700 ms while the Rust session runs (libtorrent's ticker runs only with its own session). */
    private synchronized void startPoller() {
        if (poller != null && poller.isAlive()) return;
        poller = new Thread(() -> { while (KtTorrentRs.started()) { try { Thread.sleep(700); } catch (InterruptedException e) { return; } try { poll(host.byId()); } catch (Throwable ignored) {} } }, "kt-tor-rs");
        poller.setDaemon(true); poller.start();
    }

    /** One poll for every Rust task (KtEngine's ticker, ~0.7 s): changed rows into the tasks; failures handed over. */
    void poll(Map<String, KtEngine.Task> byId) {
        if (rows.isEmpty() || !KtTorrentRs.started()) return;
        Map<?, ?> p;
        try { p = KtTorrentRs.poll(host.seedAfterDone(), host.seedRatio(), host.seedMinutes(), host.held()); }
        catch (Throwable e) { failAll(byId, "rust: " + e.getMessage()); return; }
        boolean any = false;
        for (Object o : KtTorrentCore.list(p.get("rows"))) {
            Map<?, ?> m = (Map<?, ?>) o; String id = String.valueOf(m.get("id")); Row r = rows.get(id); KtEngine.Task x = byId.get(id); if (r == null || x == null) continue;
            r.state = String.valueOf(m.get("state")); r.done = num(m.get("done")); r.total = num(m.get("total")); r.down = num(m.get("down")); r.up = num(m.get("up")); r.peers = (int) num(m.get("peers")); r.folder = String.valueOf(m.get("folder"));
            Object nm = m.get("name"); if (nm instanceof String && !((String) nm).isEmpty()) r.name = (String) nm; r.error = m.get("error") instanceof String ? (String) m.get("error") : null;
            Object fs = m.get("files"); if (fs instanceof List) { JSONArray a = new JSONArray(); int i = 0; for (Object f : (List<?>) fs) { List<?> q = (List<?>) f; try { JSONObject jf = new JSONObject(); long size = num(q.get(1)), dn = num(q.get(2)); int pr = x.priorities == null || i >= x.priorities.length ? 1 : x.priorities[i]; jf.put("index", i); jf.put("path", String.valueOf(q.get(0))); jf.put("size", size); jf.put("done", dn >= 0 ? dn : ("done".equals(r.state) || "seeding".equals(r.state)) && pr > 0 ? size : 0); jf.put("priority", pr == 0 ? 0 : pr >= 2 ? 2 : 1); a.put(jf); } catch (Exception ignored) {} i++; } r.files = a; }
            if (x.paused && !"paused".equals(r.state)) r.state = "paused";
            x.state = r.state; x.done = r.done; x.total = r.total; x.downSpeed = r.down; x.upSpeed = r.up; x.peers = r.peers; x.seeds = 0; x.error = r.error;
            if (r.name != null && (x.name == null || x.name.isEmpty() || "magnet".equals(x.name))) x.name = r.name;
            if (("done".equals(r.state) || "seeding".equals(r.state)) && x.doneAt == 0) x.doneAt = System.currentTimeMillis();
            any = true;
        }
        for (Object o : KtTorrentCore.list(p.get("failed"))) {
            Map<?, ?> m = (Map<?, ?>) o; String id = String.valueOf(m.get("id")); KtEngine.Task x = byId.get(id); rows.remove(id); if (x == null) continue;
            handOver(x, String.valueOf(m.get("error")), "restartClassic".equals(m.get("then"))); any = true;
        }
        if (any) host.changed();
    }
    /** A failure: marked classic for good; restarted on libtorrent at once (nothing written yet), or paused with the
     *  line — resuming it gives libtorrent the same folder, which it checks. */
    private void handOver(KtEngine.Task x, String err, boolean restart) {
        KtTorrentRs.FALLBACKS.incrementAndGet(); mark(x, "classic");
        try { if (x.meta != null) x.meta.put("rustFailed", true); } catch (Exception ignored) {}
        if (restart && !x.paused) { x.error = null; host.toClassic(x, true); }
        else { x.paused = true; x.state = "paused"; x.error = err; host.toClassic(x, false); }
    }
    private void failAll(Map<String, KtEngine.Task> byId, String err) { for (String id : new ArrayList<>(rows.keySet())) { rows.remove(id); KtEngine.Task x = byId.get(id); if (x != null) handOver(x, err, x.done == 0); } host.changed(); }

    void pause(KtEngine.Task x) { try { KtTorrentRs.pause(x.id); } catch (Throwable ignored) {} Row r = rows.get(x.id); if (r != null) r.state = "paused"; }
    void resume(KtEngine.Task x) { try { KtTorrentRs.resume(x.id); Row r = rows.get(x.id); if (r != null) r.state = "downloading"; x.state = "downloading"; } catch (Throwable e) { rows.remove(x.id); handOver(x, "rust: " + e.getMessage(), x.done == 0); } }
    void remove(KtEngine.Task x, boolean deleteFiles) { rows.remove(x.id); try { KtTorrentRs.remove(x.id, deleteFiles); } catch (Throwable ignored) {} }
    void setFiles(KtEngine.Task x, int[] prios) { try { KtTorrentRs.files(x.id, prios); } catch (Throwable ignored) {} }
    void setLimits(long down, long up) { try { if (KtTorrentRs.started()) KtTorrentRs.limits(down, up); } catch (Throwable ignored) {} }
    /** The task's files as the page shows them (null: not known yet). */
    JSONArray files(KtEngine.Task x) { Row r = rows.get(x.id); return r == null ? null : r.files; }
    /** File `index` on the disk, and its size (null: not known yet). */
    File fileOf(KtEngine.Task x, int index) {
        Row r = rows.get(x.id); if (r == null || r.files == null || r.files.length() == 0) return null;
        if (index < 0 || index >= r.files.length()) index = 0;
        JSONObject f = r.files.optJSONObject(index); return f == null ? null : new File(r.folder == null ? x.dir : r.folder, f.optString("path"));
    }
    long sizeOf(KtEngine.Task x, int index) { Row r = rows.get(x.id); JSONObject f = r == null || r.files == null ? null : r.files.optJSONObject(index); return f == null ? -1 : f.optLong("size", -1); }
    /** Bytes of the file for the stream server: librqbit's file stream fetches what is under it first. */
    byte[] read(KtEngine.Task x, int index, long off, int len) throws KtCore.Failure { return KtTorrentRs.read(x.id, index, off, len, 120000); }
    /** The app stopping the engine: every torrent let go (files kept) and marked to come back on the Rust engine
     *  next start (KtEngine adds them again; librqbit checks their files). */
    void shutdown() { rows.clear(); try { KtTorrentRs.shutdown(); } catch (Throwable ignored) {} }

    private static long num(Object o) { return o instanceof Number ? ((Number) o).longValue() : 0; }
}
