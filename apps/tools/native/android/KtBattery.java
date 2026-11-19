package app.kurokawa.tools;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothClass;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Device battery on the phone (0.21 P2): the phone's PAIRED Bluetooth devices, read only — their name, our kind for
 * the drawing, connected or not, and the battery level Android already knows (the hidden but long-stable
 * BluetoothDevice.getBatteryLevel, by reflection and guarded; the BATTERY_LEVEL_CHANGED broadcast; a headset's own
 * hands-free indicators, Apple's and Plantronics', when Android passes them on). Nothing is scanned (no location), no
 * device is connected to, paired or written to, no PIN is ever asked: pairing is the system's Bluetooth settings'.
 * Android 12+ needs «Nearby devices» (BLUETOOTH_CONNECT), asked only when the user taps «Allow» on the page.
 * Low-battery notices (their own channel «Device batteries»): one per drop below a device's mark, while the app runs —
 * in the foreground, or kept alive by its downloads' service; no service of its own (the page says so).
 * Kept: per device when it was last seen connected and its last level (SharedPreferences «ktbat»).
 */
final class KtBattery {
    private KtBattery() {}
    static final String CH = "kt_devbat";
    static final int REQ = 4714;
    static final String ACTION_LEVEL = "android.bluetooth.device.action.BATTERY_LEVEL_CHANGED";
    static final String EXTRA_LEVEL = "android.bluetooth.device.extra.BATTERY_LEVEL";
    static final String ACTION_VENDOR = "android.bluetooth.headset.action.VENDOR_SPECIFIC_HEADSET_EVENT";
    static final String EXTRA_CMD = "android.bluetooth.headset.extra.VENDOR_SPECIFIC_HEADSET_EVENT_CMD";
    static final String EXTRA_ARGS = "android.bluetooth.headset.extra.VENDOR_SPECIFIC_HEADSET_EVENT_ARGS";
    static final String CAT_COMPANY = "android.bluetooth.headset.intent.category.companyid.";

    /** The page's listener (KtPlugin: the «btBattery» event). */
    interface Sink { void changed(JSONObject state); }
    static volatile Sink sink;
    /** A permission dialog is open: the state is sent when the app comes back (KtPlugin.handleOnResume). */
    static volatile boolean askPending = false;
    private static volatile long askAt = 0;
    private static volatile boolean pageOpen = false;
    private static BroadcastReceiver receiver;
    private static final KtBatPure.Notices NOTICES = new KtBatPure.Notices();
    /** Levels heard from a headset's own indicators (address → level), used where the system has none. */
    private static final java.util.Map<String, Integer> HFP = new java.util.concurrent.ConcurrentHashMap<>();

    private static SharedPreferences sp(Context c) { return c.getSharedPreferences("ktbat", Context.MODE_PRIVATE); }

    static boolean granted(Context c) {
        if (Build.VERSION.SDK_INT >= 31) return c.checkSelfPermission("android.permission.BLUETOOTH_CONNECT") == PackageManager.PERMISSION_GRANTED;
        return c.checkSelfPermission("android.permission.BLUETOOTH") == PackageManager.PERMISSION_GRANTED;
    }
    /** 'granted' | 'ask' (never asked) | 'refused' (may be asked again) | 'blocked' (only App info can allow it now). */
    static String access(Context c, android.app.Activity a) {
        if (granted(c)) return "granted";
        if (Build.VERSION.SDK_INT < 31) return "blocked";
        // (The dialog still open: not answered yet — for half a minute at most, should Android never show it.)
        if (askPending && System.currentTimeMillis() - askAt < 30_000) return "ask";
        boolean asked = sp(c).getBoolean("asked", false);
        if (!asked) return "ask";
        boolean rationale = false; try { rationale = a != null && a.shouldShowRequestPermissionRationale("android.permission.BLUETOOTH_CONNECT"); } catch (Throwable ignored) {}
        return rationale ? "refused" : "blocked";
    }
    /** The system's dialog for «Nearby devices» (Android 12+); App info when Android will not show it again. */
    static String ask(Context c, android.app.Activity a) {
        String st = access(c, a);
        if ("granted".equals(st)) return st;
        if (("ask".equals(st) || "refused".equals(st)) && a != null) {
            sp(c).edit().putBoolean("asked", true).apply(); askAt = System.currentTimeMillis(); askPending = true;
            a.runOnUiThread(() -> { try { a.requestPermissions(new String[] { "android.permission.BLUETOOTH_CONNECT" }, REQ); } catch (Throwable e) { askPending = false; } });
            return "asking";
        }
        open(c, "app"); return st;
    }
    /** The system's Bluetooth settings (pairing is done there), or this app's App info. */
    static void open(Context c, String what) {
        Intent i = "app".equals(what) ? new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:" + c.getPackageName())) : new Intent(android.provider.Settings.ACTION_BLUETOOTH_SETTINGS);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { c.startActivity(i); } catch (Throwable e) { try { c.startActivity(new Intent(android.provider.Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Throwable ignored) {} }
    }

    private static BluetoothAdapter adapter(Context c) {
        try { BluetoothManager m = (BluetoothManager) c.getSystemService(Context.BLUETOOTH_SERVICE); return m == null ? null : m.getAdapter(); } catch (Throwable e) { return null; }
    }
    /** BluetoothDevice.getBatteryLevel (hidden, there since Android 8.1): 0–100, or -1. */
    static int systemLevel(BluetoothDevice d) {
        try { Object v = d.getClass().getMethod("getBatteryLevel").invoke(d); return v instanceof Integer ? KtBatPure.systemLevel((Integer) v) : -1; } catch (Throwable e) { return -1; }
    }
    /** BluetoothDevice.isConnected (hidden): connected now; false when it cannot be asked. */
    static boolean connected(BluetoothDevice d) {
        try { Object v = d.getClass().getMethod("isConnected").invoke(d); return Boolean.TRUE.equals(v); } catch (Throwable e) { return false; }
    }

    /** The settings the page keeps here, for the notices: on or off, the low mark, a device's own mark, their words. */
    static JSONObject config(Context c) {
        SharedPreferences p = sp(c); JSONObject o = new JSONObject();
        try {
            o.put("notify", p.getBoolean("notify", false)); o.put("low", KtBatPure.mark(p.getInt("low", 15)));
            o.put("marks", new JSONObject(p.getString("marks", "{}")));
        } catch (Exception ignored) {}
        return o;
    }
    static JSONObject configure(Context c, JSONObject set, JSONObject labels) {
        SharedPreferences.Editor e = sp(c).edit();
        if (set != null) {
            if (set.has("notify")) e.putBoolean("notify", set.optBoolean("notify"));
            if (set.has("low")) e.putInt("low", KtBatPure.mark(set.optInt("low", 15)));
            JSONObject m = set.optJSONObject("marks");
            if (m != null) { JSONObject keep = new JSONObject(); for (java.util.Iterator<String> it = m.keys(); it.hasNext(); ) { String k = it.next(); int v = m.optInt(k, -1); try { if (v == 0) keep.put(k, 0); else if (v > 0) keep.put(k, KtBatPure.mark(v)); } catch (Exception ignored) {} } e.putString("marks", keep.toString()); }
        }
        if (labels != null) e.putString("labels", labels.toString());
        e.apply();
        watch(c);
        return config(c);
    }

    /** Everything the page shows: Bluetooth here and on, the permission, the paired devices. */
    static JSONObject state(Context c, android.app.Activity a) {
        JSONObject r = new JSONObject();
        try {
            BluetoothAdapter ad = adapter(c);
            r.put("sdk", Build.VERSION.SDK_INT); r.put("now", System.currentTimeMillis()); r.put("adapter", ad != null);
            String acc = access(c, a); r.put("access", acc);
            boolean on = false; try { on = ad != null && ad.isEnabled(); } catch (Throwable ignored) {}
            r.put("on", on); r.put("config", config(c));
            JSONArray list = new JSONArray(); r.put("devices", list);
            if (ad == null || !"granted".equals(acc)) return r;
            java.util.Set<BluetoothDevice> bonded = null;
            try { bonded = ad.getBondedDevices(); } catch (SecurityException e) { r.put("access", "refused"); return r; }
            if (bonded == null) return r;
            SharedPreferences p = sp(c); JSONObject seen = new JSONObject(p.getString("seen", "{}")); long now = System.currentTimeMillis(); boolean changed = false;
            for (BluetoothDevice d : bonded) {
                String addr = d.getAddress(); if (addr == null) continue;
                String name = null;
                try { if (Build.VERSION.SDK_INT >= 30) name = d.getAlias(); } catch (Throwable ignored) {}
                try { if (name == null || name.isEmpty()) name = d.getName(); } catch (Throwable ignored) {}
                int major = -1, dev = -1; try { BluetoothClass bc = d.getBluetoothClass(); if (bc != null) { major = bc.getMajorDeviceClass(); dev = bc.getDeviceClass(); } } catch (Throwable ignored) {}
                boolean conn = connected(d);
                int lvl = conn ? systemLevel(d) : -1; String src = lvl >= 0 ? "system" : "";
                if (lvl < 0 && conn) { Integer hv = HFP.get(addr); if (hv != null) { lvl = hv; src = "hfp"; } }
                JSONObject old = seen.optJSONObject(addr); if (old == null) old = new JSONObject();
                if (conn) { old.put("at", now); changed = true; if (lvl >= 0) { old.put("lvl", lvl); old.put("lvlAt", now); } }
                seen.put(addr, old);
                if (lvl >= 0) notice(c, d, addr, lvl);
                JSONObject o = new JSONObject();
                o.put("key", addr); o.put("name", name == null ? "" : name); o.put("kind", KtBatPure.kindOf(major, dev, name)); o.put("connected", conn);
                o.put("level", lvl); o.put("source", src); o.put("seenAt", old.optLong("at", 0));
                // (Not connected: the last level known, and when — said as «last known» on the page.)
                o.put("lastLevel", old.optInt("lvl", -1)); o.put("lastLevelAt", old.optLong("lvlAt", 0));
                list.put(o);
            }
            if (changed) p.edit().putString("seen", seen.toString()).apply();
        } catch (Exception ignored) {}
        return r;
    }

    /** The page is open (or closed): the broadcasts heard while it is, or while the notices are on. */
    static void page(Context c, boolean open) { pageOpen = open; watch(c); }
    /** The receiver on while it is wanted and allowed; off otherwise. */
    static synchronized void watch(Context c) {
        Context app = c.getApplicationContext();
        boolean want = (pageOpen || sp(app).getBoolean("notify", false)) && granted(app);
        if (want && receiver == null) {
            // (Every callback guarded: onReceive runs on the main thread, and nothing a broadcast carries may close the app.)
            receiver = new BroadcastReceiver() { @Override public void onReceive(Context cx, Intent i) { try { heard(app, i); } catch (Throwable ignored) {} } };
            IntentFilter f = new IntentFilter(); f.addAction(ACTION_LEVEL); f.addAction(BluetoothDevice.ACTION_ACL_CONNECTED); f.addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED); f.addAction(BluetoothAdapter.ACTION_STATE_CHANGED); f.addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
            IntentFilter v = new IntentFilter(ACTION_VENDOR); v.addCategory(CAT_COMPANY + 76); v.addCategory(CAT_COMPANY + 85);
            // (Only a sender holding Bluetooth's own permission is heard — the Bluetooth process holds it, an ordinary
            // app does not: BLUETOOTH_CONNECT on Android 12+, the legacy BLUETOOTH below. Still exported on 13+: the
            // sender is another process.)
            String perm = Build.VERSION.SDK_INT >= 31 ? "android.permission.BLUETOOTH_CONNECT" : "android.permission.BLUETOOTH";
            try {
                if (Build.VERSION.SDK_INT >= 33) { app.registerReceiver(receiver, f, perm, null, Context.RECEIVER_EXPORTED); app.registerReceiver(receiver, v, perm, null, Context.RECEIVER_EXPORTED); }
                else { app.registerReceiver(receiver, f, perm, null); app.registerReceiver(receiver, v, perm, null); }
            } catch (Throwable e) { try { app.unregisterReceiver(receiver); } catch (Throwable ignored) {} receiver = null; }
        } else if (!want && receiver != null) {
            try { app.unregisterReceiver(receiver); } catch (Throwable ignored) {}
            receiver = null;
        }
    }

    private static void heard(Context c, Intent i) {
        String act = i.getAction(); if (act == null) return;
        BluetoothDevice d = null; try { d = i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE); } catch (Throwable ignored) {}
        String addr = d == null ? null : d.getAddress();
        int lvl = -1;
        if (ACTION_LEVEL.equals(act)) lvl = KtBatPure.systemLevel(i.getIntExtra(EXTRA_LEVEL, -1));
        else if (ACTION_VENDOR.equals(act)) {
            String cmd = i.getStringExtra(EXTRA_CMD); Object[] args = null;
            try { Object o = i.getExtras() == null ? null : i.getExtras().get(EXTRA_ARGS); if (o instanceof Object[]) args = (Object[]) o; } catch (Throwable ignored) {}
            if ("+IPHONEACCEV".equals(cmd)) lvl = KtBatPure.fromAppleEvent(args); else if ("+XEVENT".equals(cmd)) lvl = KtBatPure.fromXEvent(args);
            if (addr != null && lvl >= 0) HFP.put(addr, lvl);
        } else if (BluetoothDevice.ACTION_ACL_DISCONNECTED.equals(act) && addr != null) HFP.remove(addr);
        if (addr != null && lvl >= 0) notice(c, d, addr, lvl);
        Sink s = sink; if (s != null && pageOpen) s.changed(state(c, null));
    }

    /** A low level told once per drop, in the channel «Device batteries», in the page's words. */
    private static void notice(Context c, BluetoothDevice d, String addr, int lvl) {
        JSONObject cfg = config(c); if (!cfg.optBoolean("notify")) return;
        JSONObject marks = cfg.optJSONObject("marks"); int mark = marks != null && marks.has(addr) ? marks.optInt(addr) : cfg.optInt("low", 15);
        if (!NOTICES.feed(addr, lvl, mark)) return;
        JSONObject words; try { words = new JSONObject(sp(c).getString("labels", "{}")); } catch (Exception e) { words = new JSONObject(); }
        String name = null; try { if (Build.VERSION.SDK_INT >= 30) name = d.getAlias(); if (name == null) name = d.getName(); } catch (Throwable ignored) {}
        if (name == null || name.isEmpty()) name = words.optString("unnamed", "Device");
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = c.getSystemService(NotificationManager.class);
            // (Created, or renamed when the page's language changed.)
            if (nm != null) { NotificationChannel ch = new NotificationChannel(CH, words.optString("channel", "Device batteries"), NotificationManager.IMPORTANCE_DEFAULT); ch.setShowBadge(false); nm.createNotificationChannel(ch); }
        }
        String title = words.optString("title", "{name} is low").replace("{name}", name);
        String text = words.optString("text", "{n}% left").replace("{n}", String.valueOf(lvl)).replace("{name}", name);
        android.app.Notification n = new NotificationCompat.Builder(c, CH).setSmallIcon(android.R.drawable.stat_sys_warning).setContentTitle(title).setContentText(text).setAutoCancel(true).setContentIntent(KtService.openApp(c)).setCategory(NotificationCompat.CATEGORY_STATUS).build();
        try { NotificationManagerCompat nm = NotificationManagerCompat.from(c); if (nm.areNotificationsEnabled()) nm.notify(CH, addr.hashCode(), n); } catch (SecurityException ignored) {}
    }
}
