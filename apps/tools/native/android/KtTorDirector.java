package app.kurokawa.tools;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Stage M3, «Torrent engine: Director»: the streaming decisions of a torrent being watched — which pieces first, how
 * far ahead, with what deadlines, a seek seen at once — made by kt-core's tordirector (libkt_android.so, `tdir.*`)
 * and laid on libtorrent4j's handle by KtStream through {@link Wires}. Java's own rules (KtEngine.prepareStream,
 * KtStream.waitForPiece) stay the reference and the fallback: the core absent, or any Rust error → false is returned
 * and the caller does what it did before, counted in {@link #FALLBACKS}. Plain Java, so the host test drives it with
 * made-up wires.
 */
final class KtTorDirector {
    /** What the director acts through: a torrent's pieces (libtorrent4j's TorrentHandle in the app). */
    interface Wires {
        boolean have(int piece);
        /** Top priority and a deadline (ms from now). */
        void deadline(int piece, int ms);
        /** High priority, no deadline. */
        void high(int piece);
        void clearDeadlines();
    }

    static final AtomicInteger FALLBACKS = new AtomicInteger(), PLANS = new AtomicInteger();
    private static final class Open { final long h; final int first, last; volatile long planAt; volatile long rateAt; Open(long h, int first, int last) { this.h = h; this.first = first; this.last = last; } }
    private final Map<String, Open> open = new ConcurrentHashMap<>();
    /** The last plan's mode and window per stream (diagnostics). */
    final Map<String, String> lastMode = new ConcurrentHashMap<>();

    /** A file to be watched: the director made for it (once per key). False: the core cannot — Java's rules. */
    boolean open(String key, long pieceLen, int numPieces, long fileOff, long fileLen, long now) {
        if (open.containsKey(key)) return true;
        if (!KtCore.available()) return false;
        try {
            Object r = KtCore.r("tdir.open", "pieceLen", pieceLen, "numPieces", (long) numPieces, "fileOff", fileOff, "fileLen", fileLen, "now", now);
            Map<?, ?> m = (Map<?, ?>) r;
            open.put(key, new Open(((Number) m.get("h")).longValue(), ((Number) m.get("first")).intValue(), ((Number) m.get("last")).intValue()));
            return true;
        } catch (Throwable e) { FALLBACKS.incrementAndGet(); return false; }
    }
    boolean isOpen(String key) { return open.containsKey(key); }
    /** The player's byte rate (file size ÷ its length). */
    void hint(String key, double bytesPerSecond) { Open o = open.get(key); if (o == null) return; try { KtCore.r("tdir.hint", "h", o.h, "rate", Math.round(bytesPerSecond)); } catch (Throwable ignored) {} }
    /** The torrent's download rate (bytes/s), at most once a second. */
    void rate(String key, long bps, long now) { Open o = open.get(key); if (o == null || now - o.rateAt < 1000) return; o.rateAt = now; try { KtCore.r("tdir.rate", "h", o.h, "bps", Math.max(0, bps)); } catch (Throwable ignored) {} }

    /** A read at file byte `pos`: told to the director, and a plan laid on the wires when it is a seek or 500 ms after
     *  the last one (or `force`, at the open). False: the director failed — the caller uses Java's rules (and this
     *  stream stays on them). */
    boolean read(String key, long pos, Wires w, long now, boolean force) {
        Open o = open.get(key); if (o == null) return false;
        try {
            boolean seek = Boolean.TRUE.equals(KtCore.r("tdir.read", "h", o.h, "pos", Math.max(0, pos), "now", now));
            if (!seek && !force && now - o.planAt < 500) return true;
            o.planAt = now;
            StringBuilder hex = new StringBuilder((o.last - o.first) / 4 + 2);
            for (int k = o.first; k <= o.last; k += 4) { int v = 0; for (int b = 0; b < 4; b++) if (k + b <= o.last && w.have(k + b)) v |= 8 >> b; hex.append(Character.forDigit(v, 16)); }
            Map<?, ?> p = (Map<?, ?>) KtCore.r("tdir.plan", "h", o.h, "now", now, "have", hex.toString(), "from", (long) o.first);
            if (Boolean.TRUE.equals(p.get("clear"))) w.clearDeadlines();
            for (Object d : (List<?>) p.get("deadlines")) { List<?> x = (List<?>) d; w.deadline(((Number) x.get(0)).intValue(), (int) Math.min(Integer.MAX_VALUE, ((Number) x.get(1)).longValue())); }
            for (Object hr : (List<?>) p.get("high")) { List<?> x = (List<?>) hr; int a = ((Number) x.get(0)).intValue(), b = ((Number) x.get(1)).intValue(); for (int k = a; k <= b; k++) if (!w.have(k)) w.high(k); }
            lastMode.put(key, p.get("mode") + " " + p.get("window"));
            PLANS.incrementAndGet();
            return true;
        } catch (Throwable e) { FALLBACKS.incrementAndGet(); close(key); return false; }
    }
    void close(String key) { Open o = open.remove(key); if (o != null) try { KtCore.r("tdir.close", "h", o.h); } catch (Throwable ignored) {} }
}
