package app.kurokawa.tools;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Android's record of a native crash (a «tombstone», protobuf, from ApplicationExitInfo.getTraceInputStream), read
 * into a report a person can send: the signal and its cause, the abort message, the thread that crashed with its
 * frames (library and function), the other threads by name only, and the app's last log lines before the end.
 * Only the fields named in AOSP's tombstone.proto are read; the rest is skipped.
 */
final class KtTombstone {
    private KtTombstone() {}

    /* ---------- a minimal protobuf reader ---------- */
    static final class P {
        final byte[] b; int i; final int end;
        P(byte[] b, int from, int to) { this.b = b; this.i = from; this.end = to; }
        boolean more() { return i < end; }
        long varint() { long r = 0; int s = 0; while (i < end) { int x = b[i++] & 0xff; r |= (long) (x & 0x7f) << s; if ((x & 0x80) == 0) break; s += 7; if (s > 63) break; } return r; }
        /** The next field: {number, wire type}; for length-delimited ones `from`/`to` hold the bytes. */
        int field, wire; long num; int from, to;
        boolean next() {
            if (!more()) return false;
            long key = varint(); field = (int) (key >>> 3); wire = (int) (key & 7);
            switch (wire) {
                case 0: num = varint(); break;
                case 1: num = 0; for (int k = 0; k < 8 && i < end; k++) num |= (long) (b[i++] & 0xff) << (8 * k); break;
                case 2: { int len = (int) varint(); from = i; to = Math.min(end, i + Math.max(0, len)); i = to; break; }
                case 5: num = 0; for (int k = 0; k < 4 && i < end; k++) num |= (long) (b[i++] & 0xff) << (8 * k); break;
                default: i = end; return false;
            }
            return true;
        }
        String str() { return new String(b, from, to - from, java.nio.charset.StandardCharsets.UTF_8); }
        P sub() { return new P(b, from, to); }
    }

    static final class Frame { long relPc; String fn = "", file = ""; long off; }
    static final class Thread { int id; String name = ""; final List<Frame> frames = new ArrayList<>(); }
    static final class Log { int pid, tid, prio; String tag = "", msg = "", time = ""; }

    static Frame frame(P p) { Frame f = new Frame(); while (p.next()) { if (p.field == 1 && p.wire == 0) f.relPc = p.num; else if (p.field == 4 && p.wire == 2) f.fn = p.str(); else if (p.field == 5 && p.wire == 0) f.off = p.num; else if (p.field == 6 && p.wire == 2) f.file = p.str(); } return f; }
    static Thread thread(P p) { Thread t = new Thread(); while (p.next()) { if (p.field == 1 && p.wire == 0) t.id = (int) p.num; else if (p.field == 2 && p.wire == 2) t.name = p.str(); else if (p.field == 4 && p.wire == 2) t.frames.add(frame(p.sub())); } return t; }
    static Log log(P p) { Log l = new Log(); while (p.next()) { if (p.field == 1 && p.wire == 2) l.time = p.str(); else if (p.field == 2 && p.wire == 0) l.pid = (int) p.num; else if (p.field == 3 && p.wire == 0) l.tid = (int) p.num; else if (p.field == 4 && p.wire == 0) l.prio = (int) p.num; else if (p.field == 5 && p.wire == 2) l.tag = p.str(); else if (p.field == 6 && p.wire == 2) l.msg = p.str(); } return l; }

    static String base(String file) { int k = file.lastIndexOf('/'); String s = k >= 0 ? file.substring(k + 1) : file; int bang = s.indexOf('!'); return bang >= 0 ? s.substring(bang + 1) : s; }
    static String line(int n, Frame f) {
        return String.format(Locale.ROOT, "  #%02d %08x %s%s", n, f.relPc, f.file.isEmpty() ? "?" : base(f.file), f.fn.isEmpty() ? "" : " (" + f.fn + (f.off > 0 ? "+" + f.off : "") + ")");
    }

    /** The report; null when the bytes are not a tombstone. */
    static String read(byte[] b, int n) {
        P p = new P(b, 0, n);
        int tid = -1, pid = -1; String sig = "", code = "", abort = "", fault = ""; List<String> causes = new ArrayList<>(); List<Thread> threads = new ArrayList<>(); List<Log> logs = new ArrayList<>();
        while (p.next()) {
            if (p.field == 5 && p.wire == 0) pid = (int) p.num;
            else if (p.field == 6 && p.wire == 0) tid = (int) p.num;
            else if (p.field == 10 && p.wire == 2) { P s = p.sub(); while (s.next()) { if (s.field == 2 && s.wire == 2) sig = s.str(); else if (s.field == 4 && s.wire == 2) code = s.str(); else if (s.field == 9 && s.wire == 0) fault = "0x" + Long.toHexString(s.num); } }
            else if (p.field == 14 && p.wire == 2) abort = p.str();
            else if (p.field == 15 && p.wire == 2) { P s = p.sub(); while (s.next()) if (s.field == 1 && s.wire == 2) causes.add(s.str()); }
            else if (p.field == 16 && p.wire == 2) { P e = p.sub(); while (e.next()) if (e.field == 2 && e.wire == 2) threads.add(thread(e.sub())); }
            else if (p.field == 18 && p.wire == 2) { P lb = p.sub(); while (lb.next()) if (lb.field == 2 && lb.wire == 2) logs.add(log(lb.sub())); }
        }
        if (sig.isEmpty() && threads.isEmpty()) return null;
        StringBuilder sb = new StringBuilder();
        sb.append("signal: ").append(sig).append(code.isEmpty() ? "" : " (" + code + ")").append(fault.isEmpty() ? "" : " at " + fault).append('\n');
        for (String c : causes) sb.append("cause: ").append(c).append('\n');
        if (!abort.isEmpty()) sb.append("abort: ").append(abort).append('\n');
        Thread crashed = null; for (Thread t : threads) if (t.id == tid) crashed = t;
        if (crashed != null) {
            sb.append("crashed in thread «").append(crashed.name).append("» (").append(tid).append("):\n");
            for (int k = 0; k < Math.min(48, crashed.frames.size()); k++) sb.append(line(k, crashed.frames.get(k))).append('\n');
        }
        // (The others: their names and where each stands, in one line — enough to see what was running.)
        StringBuilder others = new StringBuilder(); int shown = 0;
        for (Thread t : threads) {
            if (t == crashed || shown >= 40) continue; shown++;
            Frame top = null; for (Frame f : t.frames) { if (!f.file.contains("/libc.so") && !f.file.contains("libutils.so")) { top = f; break; } }
            others.append("  ").append(t.name).append(top != null ? " — " + base(top.file) + (top.fn.isEmpty() ? "" : " " + top.fn) : "").append('\n');
        }
        if (others.length() > 0) sb.append("other threads:\n").append(others);
        // (The last lines the app logged, warnings and errors first in mind: the moments before.)
        if (!logs.isEmpty()) {
            List<Log> mine = new ArrayList<>(); for (Log l : logs) if (pid < 0 || l.pid == pid) mine.add(l);
            int from = Math.max(0, mine.size() - 40);
            sb.append("last log lines:\n");
            for (int k = from; k < mine.size(); k++) { Log l = mine.get(k); String pr = l.prio >= 6 ? "E" : l.prio == 5 ? "W" : l.prio == 4 ? "I" : "D"; String msg = l.msg.length() > 300 ? l.msg.substring(0, 300) + "…" : l.msg; sb.append("  ").append(pr).append(' ').append(l.tag).append(": ").append(msg.replace('\n', ' ')).append('\n'); }
        }
        return sb.toString().trim();
    }

    static byte[] all(java.io.InputStream in, int max) throws java.io.IOException {
        ByteArrayOutputStream o = new ByteArrayOutputStream(); byte[] buf = new byte[65536]; int r;
        while (o.size() < max && (r = in.read(buf)) > 0) o.write(buf, 0, Math.min(r, max - o.size()));
        return o.toByteArray();
    }
}
