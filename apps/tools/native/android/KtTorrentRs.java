package app.kurokawa.tools;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The Rust torrent engine (stage M3; libkt_torrent.so through {@link KtTorrentCore}) as plain calls — librqbit holds
 * the torrents, kt-core's tormobile decides; this only shapes the arguments. Plain Java (no Android, no org.json), so
 * the host test drives it against a build of the library. KtTorrentRsEngine ties it to KtEngine's tasks.
 * Every method throws {@link KtCore.Failure} on any Rust error or when the library is absent; the caller falls back
 * to libtorrent4j.
 */
final class KtTorrentRs {
    private KtTorrentRs() {}

    /** Torrents the Rust engine handed to libtorrent (failed before metadata, or after with bytes) — deviceInfo. */
    static final AtomicInteger FALLBACKS = new AtomicInteger();
    /** Torrents the Rust engine took (tests: proof it, not libtorrent, ran them). */
    static final AtomicInteger TAKEN = new AtomicInteger();
    private static volatile boolean started;

    static boolean available() { return KtTorrentCore.available(); }
    static boolean started() { return started; }

    static synchronized void start(String dataDir, int listenPort, boolean dht, boolean upnp, List<String> trackers, boolean addTrackers, long down, long up) throws KtCore.Failure {
        if (started) return;
        KtTorrentCore.r("tor.start", "dataDir", dataDir, "listenPort", (long) listenPort, "dht", dht, "upnp", upnp, "trackers", trackers == null ? new ArrayList<String>() : trackers, "addTrackers", addTrackers, "down", down, "up", up);
        started = true;
    }

    /** A torrent given to librqbit: a magnet or a .torrent (base64), its folder (a real path), its name and whether
     *  it has several files when known (a .torrent's), the files wanted (null: all), added paused or not. The add goes
     *  on in Rust (metadata, the check of the files there); {@link #poll} tells how it went. */
    static void add(String id, String hash, String magnet, String torrentB64, String dir, String name, boolean multi, List<Integer> files, boolean paused) throws KtCore.Failure {
        List<Object> kv = new ArrayList<>(java.util.Arrays.asList("id", id, "hash", hash, "dir", dir, "paused", paused, "multi", multi, "name", name == null ? "" : name));
        if (torrentB64 != null) { kv.add("torrent"); kv.add(torrentB64); } else { kv.add("magnet"); kv.add(magnet); }
        if (files != null) { List<Long> l = new ArrayList<>(); for (int i : files) l.add((long) i); kv.add("files"); kv.add(l); }
        KtTorrentCore.r("tor.add", kv.toArray());
        TAKEN.incrementAndGet();
    }

    /** Every task whose row changed since the last poll ({@code rows}) and the failures ({@code failed}, each told
     *  once: {@code then} is «restartClassic» or «pauseForClassic»). The seeding rules are applied in Rust. */
    static Map<?, ?> poll(boolean seed, double ratio, int minutes, boolean held) throws KtCore.Failure {
        Object r = KtTorrentCore.r("tor.poll", "now", System.currentTimeMillis(), "seed", seed, "ratioPct", Math.round(Math.max(0, ratio) * 100), "minutes", (long) minutes, "held", held);
        return r instanceof Map ? (Map<?, ?>) r : new LinkedHashMap<>();
    }
    static void pause(String id) throws KtCore.Failure { KtTorrentCore.r("tor.pause", "id", id); }
    static void resume(String id) throws KtCore.Failure { KtTorrentCore.r("tor.resume", "id", id); }
    static boolean remove(String id, boolean deleteFiles) throws KtCore.Failure { return Boolean.TRUE.equals(KtTorrentCore.r("tor.remove", "id", id, "deleteFiles", deleteFiles)); }
    /** The page's priorities (0 skip, 1 normal, 2 high) — librqbit has wanted / not wanted. */
    static void files(String id, int[] prios) throws KtCore.Failure { List<Long> l = new ArrayList<>(); for (int p : prios) l.add((long) p); KtTorrentCore.r("tor.files", "id", id, "files", l); }
    /** True when applied now; false: from the next start of the Rust session. */
    static boolean limits(long down, long up) throws KtCore.Failure { return Boolean.TRUE.equals(KtTorrentCore.r("tor.limits", "down", down, "up", up)); }
    /** Up to `len` bytes of file `file` from `off` (fewer at a piece's end), waited for at most `timeoutMs`. */
    static byte[] read(String id, int file, long off, int len, long timeoutMs) throws KtCore.Failure {
        Map<String, Object> a = new LinkedHashMap<>(); a.put("id", id); a.put("file", (long) file); a.put("off", off); a.put("len", (long) len); a.put("timeoutMs", timeoutMs);
        return KtTorrentCore.callBytes("bytes.tor.read", a);
    }
    /** Every torrent let go, files kept: the list handed back ({id, hash, bytes, folder, paused}). */
    static synchronized List<?> shutdown() throws KtCore.Failure {
        if (!started) return new ArrayList<>();
        started = false;
        Object r = KtTorrentCore.r("tor.shutdown");
        return r instanceof Map ? KtTorrentCore.list(((Map<?, ?>) r).get("handedBack")) : new ArrayList<>();
    }
}
