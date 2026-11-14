package app.kurokawa.tools;

import app.kurokawa.tools.KtCore;   // (the same package; named so tests/native/dlrules.sh compiles this file outside it)
import java.io.File;
import java.util.Collection;
import java.util.Locale;
import java.util.Set;

/**
 * The download queue's decisions, apart from KtEngine (which needs Android and libtorrent): plain Java, so
 * tests/native/dlrules.sh runs them — which name a download takes, whether a hold keeps it from starting, what a
 * host is asked next time, whether one resumed while it was still stopping starts again.
 *
 * Stage M1 of the Rust port: the same rules are in apps/tools/core/kt-core/src/dlrules.rs. This Java stays the reference
 * and the answer used; on a debuggable build with the Rust core present each answer is also asked of Rust and a
 * difference recorded (KtCore.shadow) — the `*0` methods are the rules, the others add that check.
 */
final class KtDlRules {
    private KtDlRules() {}

    /** The hold that keeps a download from starting now (the first that applies), or null. `anyway`: the user asked for
     *  it now («Download now» on one waiting for Wi-Fi). */
    static String holdOf(Collection<String> holds, boolean wifiOnlyAll, boolean taskWifiOnly, boolean anyway) {
        String r = holdOf0(holds, wifiOnlyAll, taskWifiOnly, anyway);
        if (KtCore.shadowing()) KtCore.shadow("dl.holdOf", r, "holds", holds == null ? null : new java.util.ArrayList<>(holds), "wifiOnlyAll", wifiOnlyAll, "taskWifiOnly", taskWifiOnly, "anyway", anyway);
        return r;
    }
    private static String holdOf0(Collection<String> holds, boolean wifiOnlyAll, boolean taskWifiOnly, boolean anyway) {
        if (anyway || holds == null) return null;
        String metered = null;
        for (String h : holds) { if (!holds0(h, wifiOnlyAll, taskWifiOnly)) continue; if (!"metered".equals(h)) return h; metered = h; }
        return metered;   // (a reason held by every download — the battery — said first; Wi-Fi only after)
    }
    /** Whether `reason` holds a download: a metered network only those marked Wi-Fi only (or all, by the switch). */
    static boolean holds(String reason, boolean wifiOnlyAll, boolean taskWifiOnly) {
        boolean r = holds0(reason, wifiOnlyAll, taskWifiOnly);
        if (KtCore.shadowing() && reason != null) KtCore.shadow("dl.holds", r, "reason", reason, "wifiOnlyAll", wifiOnlyAll, "taskWifiOnly", taskWifiOnly);
        return r;
    }
    private static boolean holds0(String reason, boolean wifiOnlyAll, boolean taskWifiOnly) { return !"metered".equals(reason) || wifiOnlyAll || taskWifiOnly; }

    /** The name a download not yet begun takes in `dir` (null: skip it, the file is there). `reserved`: the names —
     *  lower case — of the other downloads into this folder not finished, begun or not: never shared, whatever the
     *  setting says (two downloads of one name wrote into one .part; a Google Drive folder may hold two files of one
     *  name, and both are wanted). A file there already: as the settings say. A .part there that no other download
     *  holds is this one's from before (its record lost): kept, its chunks found by their bytes. */
    static String pickName(File dir, String safe, boolean begun, String conflict, Set<String> reserved) {
        String r = pickName0(dir, safe, begun, conflict, reserved);
        if (KtCore.shadowing() && dir != null && safe != null && conflict != null) KtCore.shadow("dl.pickName", r, "dir", dir.getPath(), "safe", safe, "begun", begun, "conflict", conflict, "reserved", reserved == null ? null : new java.util.ArrayList<>(reserved));
        return r;
    }
    private static String pickName0(File dir, String safe, boolean begun, String conflict, Set<String> reserved) {
        if (begun) return safe;
        if (reserved != null && reserved.contains(safe.toLowerCase(Locale.ROOT))) return freeName0(dir, safe, reserved);
        if (new File(dir, safe).exists() && !new File(dir, safe + ".part").exists()) { if ("skip".equals(conflict)) return null; if (!"overwrite".equals(conflict)) return freeName0(dir, safe, reserved); }
        return safe;
    }
    /** «name (2).ext»: the first name not taken in `dir` (by a file, a .part, or another download's name). */
    static String freeName(File dir, String name, Set<String> reserved) {
        String r = freeName0(dir, name, reserved);
        if (KtCore.shadowing() && dir != null && name != null) KtCore.shadow("dl.freeName", r, "dir", dir.getPath(), "name", name, "reserved", reserved == null ? null : new java.util.ArrayList<>(reserved));
        return r;
    }
    private static String freeName0(File dir, String name, Set<String> reserved) {
        int dot = name.lastIndexOf('.'); String stem = dot > 0 ? name.substring(0, dot) : name, ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 2; i < 10000; i++) { String n = stem + " (" + i + ")" + ext; if (!new File(dir, n).exists() && !new File(dir, n + ".part").exists() && (reserved == null || !reserved.contains(n.toLowerCase(Locale.ROOT)))) return n; }
        return stem + " (" + System.currentTimeMillis() + ")" + ext;
    }

    /** What a host is asked next time, after a download that asked it `want` connections with `lim` known before (null:
     *  none) and ended with `connections`: a refusal (429/503, or connections dropped before any byte — never a link
     *  that dropped after bytes came: KrDownloader tells them apart) keeps what it took; a download that used every
     *  connection the limit allowed with no refusal doubles it, up to what is asked — a limit learnt long ago, or
     *  lowered wrongly, is back in a few downloads (1 → 24 in five) instead of a tenth at a time. */
    static Integer nextHostLimit(Integer lim, int want, boolean refused, int connections) {
        Integer r = nextHostLimit0(lim, want, refused, connections);
        if (KtCore.shadowing()) KtCore.shadow("dl.nextHostLimit", r, "lim", lim, "want", want, "refused", refused, "connections", connections);
        return r;
    }
    private static Integer nextHostLimit0(Integer lim, int want, boolean refused, int connections) {
        if (refused) return Math.max(1, connections);
        if (lim != null && lim < want && connections >= lim) return Math.min(want, lim * 2);
        return lim;
    }

    /** A download resumed while its last run was still stopping (pause, then resume at once): started again when that
     *  run ends — unless paused again meanwhile, finished, or removed. */
    static boolean restartAfterStop(boolean resumedWhileStopping, boolean paused, String state) {
        boolean r = restartAfterStop0(resumedWhileStopping, paused, state);
        if (KtCore.shadowing() && state != null) KtCore.shadow("dl.restartAfterStop", r, "resumedWhileStopping", resumedWhileStopping, "paused", paused, "state", state);
        return r;
    }
    private static boolean restartAfterStop0(boolean resumedWhileStopping, boolean paused, String state) {
        return resumedWhileStopping && !paused && !"done".equals(state) && !"removed".equals(state) && !"seeding".equals(state);
    }
}
