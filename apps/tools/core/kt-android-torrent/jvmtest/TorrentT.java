package app.kurokawa.tools;

import java.util.*;

/** Stage M3 from a plain JVM: the Rust torrent engine's Java door (KtTorrentCore, KtTorrentRs) against a build of
 *  libkt_torrent.so, and the streaming director (KtTorDirector) against libkt_android.so with made-up wires.
 *  `java TorrentT fake`: the stand-in backend (test-host.sh) — the whole table: add → metadata → bytes identical →
 *  pause/resume (with and without librqbit's pause) → the two failures and what Java is told → remove → shutdown
 *  hands back. `java TorrentT absent`: no library — nothing throws an Error, every call a KtCore.Failure. */
public class TorrentT {
    static int fails = 0;
    static void check(String what, boolean ok) { System.out.println((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; }
    static Map<?, ?> waitRow(String id, String state) throws Exception {
        for (int i = 0; i < 300; i++) { Map<?, ?> p = KtTorrentRs.poll(false, 0, 0, false); for (Object o : (List<?>) p.get("rows")) { Map<?, ?> r = (Map<?, ?>) o; if (id.equals(r.get("id")) && state.equals(r.get("state"))) return r; } Thread.sleep(10); }
        throw new Exception(id + " never " + state);
    }
    static Map<?, ?> waitFailed(String id) throws Exception {
        for (int i = 0; i < 300; i++) { Map<?, ?> p = KtTorrentRs.poll(false, 0, 0, false); for (Object o : (List<?>) p.get("failed")) { Map<?, ?> r = (Map<?, ?>) o; if (id.equals(r.get("id"))) return r; } Thread.sleep(10); }
        throw new Exception(id + " never failed");
    }
    static int pat(long i) { return (int) ((i * 31 + 7) % 251); }

    public static void main(String[] a) throws Exception {
        String mode = a.length > 0 ? a[0] : "fake";
        if (mode.equals("real")) {
            // (CI: the real librqbit build through JNI — the call shape and a forced failure; the swarm itself is
            // tests/loopback.rs through the same dispatch.)
            check("torrent library loaded: " + KtTorrentCore.status(), KtTorrentRs.available() && KtTorrentCore.backend().startsWith("librqbit"));
            String dir = System.getProperty("java.io.tmpdir") + "/kt-tor-jvm-real";
            KtTorrentRs.start(dir, 0, false, false, null, false, 0, 0);
            check("session started (DHT off, no tracker)", KtTorrentRs.started());
            // (A magnet nobody has, DHT off and no tracker: no metadata — after librqbit's 90 s, or at once in a build
            // without «listonly» — told as a failure before metadata.)
            KtTorrentRs.add("r1", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=x", null, dir, null, false, null, false);
            Map<?, ?> f = null; for (int i = 0; i < 400 && f == null; i++) { Map<?, ?> p = KtTorrentRs.poll(false, 0, 0, false); for (Object o : (List<?>) p.get("failed")) if ("r1".equals(((Map<?, ?>) o).get("id"))) f = (Map<?, ?>) o; Thread.sleep(300); }
            check("a magnet with no metadata: told failed, «restartClassic»: " + f, f != null && "restartClassic".equals(f.get("then")));
            check("shutdown", KtTorrentRs.shutdown() != null && !KtTorrentRs.started());
        } else if (mode.equals("absent")) {
            check("no torrent library: available() false", !KtTorrentRs.available());
            check("…its status says absent", KtTorrentCore.status().startsWith("Rust torrent engine: absent"));
            boolean threw = false; try { KtTorrentRs.start("/tmp/x", 0, false, false, null, false, 0, 0); } catch (KtCore.Failure f) { threw = true; }
            check("…a call is a Failure, not an Error", threw);
            check("…the director without the core: not opened (Java's rules)", KtCore.available() || !new KtTorDirector().open("k", 262144, 100, 0, 1 << 20, 0));
        } else {
            check("torrent library loaded: " + KtTorrentCore.status(), KtTorrentRs.available() && KtTorrentCore.backend().startsWith("fake"));
            String dir = System.getProperty("java.io.tmpdir") + "/kt-tor-jvm";
            KtTorrentRs.start(dir, 0, false, false, Arrays.asList("udp://127.0.0.1:1/announce"), false, 0, 0);
            KtTorrentRs.add("t1", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=Ep 01 — مرحبا.mkv&xl=1000000", null, dir, null, false, null, false);
            Map<?, ?> r = waitRow("t1", "downloading");
            check("add → metadata → downloading, the name as given (non-ASCII intact)", "Ep 01 — مرحبا.mkv".equals(r.get("name")) && r.get("files") instanceof List);
            r = waitRow("t1", "done");
            check("…done, every byte", ((Number) r.get("done")).longValue() == 1000000L);
            byte[] b = KtTorrentRs.read("t1", 0, 999_000, 4096, 1000); boolean same = b.length == 1000; for (int i = 0; same && i < b.length; i++) same = (b[i] & 0xff) == pat(999_000 + i);
            check("a far range read: identical bytes, short at the end", same);
            KtTorrentRs.add("t2", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "magnet:?dn=p&xl=8000000&kt-nopause=1", null, dir, null, false, Arrays.asList(0), false);
            waitRow("t2", "downloading"); KtTorrentRs.pause("t2"); waitRow("t2", "paused"); KtTorrentRs.resume("t2"); waitRow("t2", "downloading");
            check("pause / resume without librqbit's pause (dropped, added again)", true);
            KtTorrentRs.add("f1", "cccccccccccccccccccccccccccccccccccccccc", "magnet:?dn=f&kt-fail=meta", null, dir, null, false, null, false);
            Map<?, ?> f = waitFailed("f1");
            check("a failure before metadata: «restartClassic»", "restartClassic".equals(f.get("then")) && String.valueOf(f.get("error")).startsWith("rust: "));
            KtTorrentRs.add("f2", "dddddddddddddddddddddddddddddddddddddddd", "magnet:?dn=g&xl=8000000&kt-fail=after", null, dir, null, false, null, false);
            f = waitFailed("f2");
            check("a failure after bytes: «pauseForClassic»", "pauseForClassic".equals(f.get("then")));
            boolean refused = false; try { KtTorrentRs.add("s", "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "magnet:?dn=s", null, "content://x/tree", null, false, null, false); } catch (KtCore.Failure e) { refused = "safFolder".equals(e.getMessage()); }
            check("a SAF folder refused", refused);
            check("remove", KtTorrentRs.remove("t1", false) && !KtTorrentRs.remove("t1", false));
            List<?> back = KtTorrentRs.shutdown();
            check("shutdown hands back what it held", back.size() == 1 && "t2".equals(((Map<?, ?>) back.get(0)).get("id")));
            boolean err = false; try { KtTorrentCore.r("core.panic"); } catch (KtCore.Failure e) { err = e.getMessage().startsWith("panic: "); }
            check("a panic in the library comes back as an error", err);
            // The director through libkt_android, with made-up wires: 400 MB file, 256 KiB pieces, nothing here.
            if (KtCore.available()) {
                KtTorDirector d = new KtTorDirector(); final Set<Integer> have = new HashSet<>(); final Map<Integer, Integer> dl = new HashMap<>(); final int[] cleared = { 0 }; final Set<Integer> high = new HashSet<>();
                KtTorDirector.Wires w = new KtTorDirector.Wires() { public boolean have(int k) { return have.contains(k); } public void deadline(int k, int ms) { dl.put(k, ms); } public void high(int k) { high.add(k); } public void clearDeadlines() { cleared[0]++; dl.clear(); } };
                long pl = 262144, len = 400L << 20; int np = (int) ((len + (1 << 20) + pl - 1) / pl);
                check("director opened", d.open("x:0", pl, np, 1 << 20, len, 0));
                check("first plan laid", d.read("x:0", 0, w, 0, true));
                check("…head and the file's last piece both asked first", dl.containsKey(4) && dl.containsKey(np - 1) && dl.get(np - 1) < 1000);
                check("…a stretch after the window at high priority", !high.isEmpty());
                d.read("x:0", 300L << 20, w, 10_000, false);
                check("a seek: the old deadlines dropped, the target asked", cleared[0] == 1 && dl.containsKey((int) (((1L << 20) + (300L << 20)) / pl)));
                check("plans counted, no fallback", KtTorDirector.PLANS.get() >= 2 && KtTorDirector.FALLBACKS.get() == 0);
                d.close("x:0");
                check("closed: a read is refused (Java's rules then)", !d.read("x:0", 0, w, 20_000, true));
            } else check("libkt_android absent here: director part skipped", true);
        }
        System.out.println(fails == 0 ? "all passed" : fails + " failed");
        System.exit(fails == 0 ? 0 : 1);
    }
}
