package app.kurokawa.tools;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothClass;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
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
 * Kept: per device when it was first listed, last seen connected and its last level (SharedPreferences «ktbat»).
 * 0.22.1: «connected» from Android's public sources together (KtBatPure.Presence): the profile proxies (hands-free,
 * audio, input, hearing aids, LE audio — open only while the page is shown), the GATT links, the audio routes, the input
 * devices, the link and profile broadcasts, and the hidden isConnected as one more voice (recent Android refuses it).
 * Those broadcasts push the page a fresh reading within a moment. The details (alias and name, type, class, pairing,
 * services, codec, true-wireless parts) are only what Android already holds: still nothing is connected to by us.
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
    /**
     * BluetoothDevice.isConnected (hidden): its answer, or null when Android refuses it (recent Android does, for an
     * ordinary app) — one voice among the public ones (presence), never the only one.
     */
    static Boolean reflected(BluetoothDevice d) {
        try { Object v = d.getClass().getMethod("isConnected").invoke(d); return v instanceof Boolean ? (Boolean) v : null; } catch (Throwable e) { return null; }
    }

    /* ---------- 0.22.1: connected from Android's public sources (KtBatPure.Presence), and the links up ---------- */
    /** The profile proxies open while the page is shown (profile number → BluetoothProfile), closed when it goes. */
    private static final java.util.Map<Integer, BluetoothProfile> PROXIES = new java.util.concurrent.ConcurrentHashMap<>();
    private static volatile boolean proxiesWanted = false;
    /** What the broadcasts said (a link or a profile up or down) since the receiver was put on. */
    private static final KtBatPure.Live LIVE = new KtBatPure.Live();
    private static final BluetoothProfile.ServiceListener PROXY_LISTENER = new BluetoothProfile.ServiceListener() {
        @Override public void onServiceConnected(int profile, BluetoothProfile proxy) {
            if (proxy == null) return;
            // (Arrived after the page went: given back at once.)
            if (!proxiesWanted) { BluetoothAdapter ad = appCtx == null ? null : adapter(appCtx); try { if (ad != null) ad.closeProfileProxy(profile, proxy); } catch (Throwable ignored) {} return; }
            PROXIES.put(profile, proxy); soon();
        }
        @Override public void onServiceDisconnected(int profile) { PROXIES.remove(profile); soon(); }
    };
    private static volatile Context appCtx;
    /** The profiles asked for: hands-free, audio, input (HID_HOST, 4, asked though not public everywhere), hearing aids (10+), LE audio (13+). */
    private static int[] profilesAsked() {
        java.util.List<Integer> l = new java.util.ArrayList<>(java.util.Arrays.asList(KtBatPure.P_HEADSET, KtBatPure.P_A2DP, KtBatPure.P_HID_HOST));
        if (Build.VERSION.SDK_INT >= 29) l.add(KtBatPure.P_HEARING_AID);
        if (Build.VERSION.SDK_INT >= 33) l.add(KtBatPure.P_LE_AUDIO);
        int[] r = new int[l.size()]; for (int i = 0; i < r.length; i++) r[i] = l.get(i); return r;
    }
    /** Opened only while the page is shown, Bluetooth on and allowed; each one refused stays silent. */
    private static synchronized void proxies(Context c, boolean want) {
        Context app = c.getApplicationContext(); appCtx = app;
        BluetoothAdapter ad = adapter(app);
        boolean on = false; try { on = ad != null && ad.isEnabled(); } catch (Throwable ignored) {}
        want = want && on && granted(app);
        if (want && !proxiesWanted) {
            proxiesWanted = true;
            for (int pr : profilesAsked()) { if (PROXIES.containsKey(pr)) continue; try { ad.getProfileProxy(app, PROXY_LISTENER, pr); } catch (Throwable ignored) {} }
        } else if (!want && proxiesWanted) {
            proxiesWanted = false;
            for (java.util.Map.Entry<Integer, BluetoothProfile> e : PROXIES.entrySet()) { try { if (ad != null) ad.closeProfileProxy(e.getKey(), e.getValue()); } catch (Throwable ignored) {} }
            PROXIES.clear();
        }
    }
    /** Everything Android's public sources say is connected now (plus what the broadcasts said). */
    static KtBatPure.Presence presence(Context c) {
        KtBatPure.Presence pr = new KtBatPure.Presence();
        for (java.util.Map.Entry<Integer, BluetoothProfile> e : PROXIES.entrySet()) {
            String tag = KtBatPure.profileTag(e.getKey()); if (tag == null) continue;
            try { java.util.List<BluetoothDevice> l = e.getValue().getConnectedDevices(); if (l != null) for (BluetoothDevice d : l) pr.add(d.getAddress(), tag); } catch (Throwable ignored) {}
        }
        // (LE devices: the GATT links Android holds — for any app, not one we opened.)
        try {
            BluetoothManager m = (BluetoothManager) c.getSystemService(Context.BLUETOOTH_SERVICE);
            if (m != null) for (int g : new int[] { KtBatPure.P_GATT, KtBatPure.P_GATT_SERVER }) { try { java.util.List<BluetoothDevice> l = m.getConnectedDevices(g); if (l != null) for (BluetoothDevice d : l) pr.add(d.getAddress(), "le"); } catch (Throwable ignored) {} }
        } catch (Throwable ignored) {}
        // (The audio routes: a Bluetooth output or input there is a device in use — by address, else by its name.)
        try {
            android.media.AudioManager am = (android.media.AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
            if (am != null) for (android.media.AudioDeviceInfo ai : am.getDevices(android.media.AudioManager.GET_DEVICES_ALL)) {
                String tag = KtBatPure.audioTag(ai.getType()); if (tag == null) continue;
                if (Build.VERSION.SDK_INT >= 28) { try { pr.add(ai.getAddress(), tag); } catch (Throwable ignored) {} }
                CharSequence pn = ai.getProductName(); if (pn != null) pr.addByName(pn.toString(), tag);
            }
        } catch (Throwable ignored) {}
        // (Keyboards, mice, pads: Android lists them as input devices, by name only.)
        try {
            for (int id : android.view.InputDevice.getDeviceIds()) {
                android.view.InputDevice in = android.view.InputDevice.getDevice(id); if (in == null || in.isVirtual()) continue;
                if (Build.VERSION.SDK_INT >= 29 && !in.isExternal()) continue;
                pr.addByName(in.getName(), "input");
            }
        } catch (Throwable ignored) {}
        LIVE.into(pr);
        return pr;
    }
    /** The A2DP codec in use (BluetoothA2dp.getCodecStatus, by reflection): null when refused or unknown. */
    private static volatile boolean codecRefused = false;
    private static String codec(BluetoothDevice d) {
        BluetoothProfile a2dp = PROXIES.get(KtBatPure.P_A2DP); if (a2dp == null || codecRefused) return null;
        try {
            Object st = a2dp.getClass().getMethod("getCodecStatus", BluetoothDevice.class).invoke(a2dp, d); if (st == null) return null;
            Object cfg = st.getClass().getMethod("getCodecConfig").invoke(st); if (cfg == null) return null;
            Object ty = cfg.getClass().getMethod("getCodecType").invoke(cfg);
            return ty instanceof Integer ? KtBatPure.codecName((Integer) ty) : null;
        } catch (NoSuchMethodException | SecurityException e) { codecRefused = true; return null; }
        catch (Throwable e) { if (e.getCause() instanceof SecurityException) codecRefused = true; return null; }
    }
    /** True-wireless parts' levels (hidden getMetadata keys 10 left, 11 right, 12 case): tried once, silent when refused. */
    private static volatile boolean metaRefused = false;
    private static JSONObject parts(BluetoothDevice d) {
        if (metaRefused) return null;
        JSONObject o = new JSONObject(); String[] names = { "left", "right", "case" };
        try {
            java.lang.reflect.Method m = d.getClass().getMethod("getMetadata", int.class);
            for (int i = 0; i < 3; i++) { Object v = m.invoke(d, 10 + i); int l = v instanceof byte[] ? KtBatPure.metaLevel((byte[]) v) : -1; if (l >= 0) o.put(names[i], l); }
        } catch (NoSuchMethodException | SecurityException e) { metaRefused = true; return null; }
        catch (Throwable e) { if (e.getCause() instanceof SecurityException) metaRefused = true; return null; }
        return o.length() > 0 ? o : null;
    }
    private static JSONArray arr(java.util.List<String> l) { JSONArray a = new JSONArray(); for (String x : l) a.put(x); return a; }

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
            // (Off, or not allowed: no work at all — the page shows one clear card.)
            if (ad == null || !on || !"granted".equals(acc)) return r;
            java.util.Set<BluetoothDevice> bonded = null;
            try { bonded = ad.getBondedDevices(); } catch (SecurityException e) { r.put("access", "refused"); return r; }
            if (bonded == null) return r;
            SharedPreferences p = sp(c); JSONObject seen = new JSONObject(p.getString("seen", "{}")); long now = System.currentTimeMillis(); boolean changed = false;
            KtBatPure.Presence pres = presence(c);
            for (BluetoothDevice d : bonded) {
                String addr = d.getAddress(); if (addr == null) continue;
                String alias = null, sysName = null;
                try { if (Build.VERSION.SDK_INT >= 30) alias = d.getAlias(); } catch (Throwable ignored) {}
                try { sysName = d.getName(); } catch (Throwable ignored) {}
                String name = alias == null || alias.isEmpty() ? sysName : alias;
                int major = -1, dev = -1; try { BluetoothClass bc = d.getBluetoothClass(); if (bc != null) { major = bc.getMajorDeviceClass(); dev = bc.getDeviceClass(); } } catch (Throwable ignored) {}
                // (Any source saying yes: the profiles, GATT, the audio routes, the input devices, the broadcasts, the hidden call.)
                java.util.List<String> links = pres.profiles(addr, alias, sysName);
                boolean conn = pres.connected(addr, alias, sysName, reflected(d));
                int lvl = conn ? systemLevel(d) : -1; String src = lvl >= 0 ? "system" : "";
                if (lvl < 0 && conn) { Integer hv = HFP.get(addr); if (hv != null) { lvl = hv; src = "hfp"; } }
                JSONObject old = seen.optJSONObject(addr); if (old == null) old = new JSONObject();
                if (!old.has("first")) { old.put("first", now); changed = true; }
                if (conn) { old.put("at", now); changed = true; if (lvl >= 0) { old.put("lvl", lvl); old.put("lvlAt", now); old.put("src", src); } }
                seen.put(addr, old);
                if (lvl >= 0) notice(c, d, addr, lvl);
                JSONObject o = new JSONObject();
                o.put("key", addr); o.put("name", name == null ? "" : name); o.put("kind", KtBatPure.kindOf(major, dev, name)); o.put("connected", conn);
                o.put("level", lvl); o.put("source", src); o.put("seenAt", old.optLong("at", 0));
                // (Not connected: the last level known, and when — said as «last known» on the page.)
                o.put("lastLevel", old.optInt("lvl", -1)); o.put("lastLevelAt", old.optLong("lvlAt", 0)); o.put("lastSource", old.optString("src", ""));
                // (The details, read only and without connecting: what Android already holds about the device.)
                o.put("profiles", arr(links)); o.put("firstSeen", old.optLong("first", 0));
                if (alias != null && !alias.isEmpty()) o.put("alias", alias);
                if (sysName != null && !sysName.isEmpty()) o.put("sysName", sysName);
                try { String ty = KtBatPure.typeKey(d.getType()); if (ty != null) o.put("type", ty); } catch (Throwable ignored) {}
                try { String b = KtBatPure.bondKey(d.getBondState()); if (b != null) o.put("bond", b); } catch (Throwable ignored) {}
                String mk = KtBatPure.majorKey(major), mn = KtBatPure.minorKey(major, dev); if (mk != null) o.put("major", mk); if (mn != null) o.put("minor", mn);
                try { android.os.ParcelUuid[] us = d.getUuids(); if (us != null) { String[] u = new String[us.length]; for (int i = 0; i < us.length; i++) u[i] = us[i] == null ? null : us[i].toString(); java.util.List<String> sv = KtBatPure.services(u); if (!sv.isEmpty()) o.put("services", arr(sv)); } } catch (Throwable ignored) {}
                if (conn && links.contains("audio")) { String cd = codec(d); if (cd != null) o.put("codec", cd); }
                if (conn) { JSONObject pt = parts(d); if (pt != null) o.put("parts", pt); }
                list.put(o);
            }
            if (changed) p.edit().putString("seen", seen.toString()).apply();
        } catch (Exception ignored) {}
        return r;
    }

    /** The page is open (or closed): the broadcasts heard while it is, or while the notices are on. */
    static void page(Context c, boolean open) { pageOpen = open; watch(c); proxies(c, open); }
    /** The page's renderer was made again (MainActivity's restart path): the old page never said it went. */
    static void reset(Context c) { pageOpen = false; proxies(c, false); watch(c); }
    /** The receiver on while it is wanted and allowed; off otherwise. */
    static synchronized void watch(Context c) {
        Context app = c.getApplicationContext(); appCtx = app;
        boolean want = (pageOpen || sp(app).getBoolean("notify", false)) && granted(app);
        if (want && receiver == null) {
            // (Every callback guarded: onReceive runs on the main thread, and nothing a broadcast carries may close the app.)
            receiver = new BroadcastReceiver() { @Override public void onReceive(Context cx, Intent i) { try { heard(app, i); } catch (Throwable ignored) {} } };
            IntentFilter f = new IntentFilter(); f.addAction(ACTION_LEVEL); f.addAction(BluetoothDevice.ACTION_ACL_CONNECTED); f.addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED); f.addAction(BluetoothAdapter.ACTION_STATE_CHANGED); f.addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
            for (String a : PROFILE_ACTIONS.keySet()) f.addAction(a);
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
            // (No longer heard: what the broadcasts said could go stale.)
            receiver = null; LIVE.clear();
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
        } else if (BluetoothDevice.ACTION_ACL_DISCONNECTED.equals(act) && addr != null) { HFP.remove(addr); LIVE.heard(addr, KtBatPure.Presence.LINK, false); }
        else if (BluetoothDevice.ACTION_ACL_CONNECTED.equals(act)) LIVE.heard(addr, KtBatPure.Presence.LINK, true);
        else if (PROFILE_ACTIONS.containsKey(act)) { Boolean up = KtBatPure.profileState(i.getIntExtra(EXTRA_PROFILE_STATE, -1)); if (up != null) LIVE.heard(addr, PROFILE_ACTIONS.get(act), up); }
        else if (BluetoothAdapter.ACTION_STATE_CHANGED.equals(act)) {
            int st = i.getIntExtra(BluetoothAdapter.EXTRA_STATE, -1);
            // (Off: nothing is connected any more — the list is not left stale; on again: the proxies asked for anew.)
            if (st == BluetoothAdapter.STATE_OFF || st == BluetoothAdapter.STATE_TURNING_OFF) { LIVE.clear(); HFP.clear(); proxies(c, false); }
            else if (st == BluetoothAdapter.STATE_ON && pageOpen) proxies(c, true);
        }
        if (addr != null && lvl >= 0) notice(c, d, addr, lvl);
        soon();
    }

    /** The profiles' own «connection state changed» broadcasts → their link word. */
    static final java.util.Map<String, String> PROFILE_ACTIONS = new java.util.HashMap<>();
    static final String EXTRA_PROFILE_STATE = "android.bluetooth.profile.extra.STATE";
    static {
        PROFILE_ACTIONS.put("android.bluetooth.a2dp.profile.action.CONNECTION_STATE_CHANGED", "audio");
        PROFILE_ACTIONS.put("android.bluetooth.headset.profile.action.CONNECTION_STATE_CHANGED", "calls");
        PROFILE_ACTIONS.put("android.bluetooth.input.profile.action.CONNECTION_STATE_CHANGED", "input");
        PROFILE_ACTIONS.put("android.bluetooth.hearingaid.profile.action.CONNECTION_STATE_CHANGED", "hearingAid");
        PROFILE_ACTIONS.put("android.bluetooth.action.LE_AUDIO_CONNECTION_STATE_CHANGED", "leAudio");
    }
    /**
     * The page told within a moment: changes coming together (a link, then its profiles, then a level) gathered into one
     * reading a quarter of a second after the first — no polling; nothing while the page is not shown.
     */
    private static final java.util.concurrent.atomic.AtomicBoolean PENDING = new java.util.concurrent.atomic.AtomicBoolean(false);
    private static java.util.concurrent.ScheduledExecutorService pusher;
    private static synchronized java.util.concurrent.ScheduledExecutorService pusher() {
        if (pusher == null) pusher = java.util.concurrent.Executors.newSingleThreadScheduledExecutor(r -> { Thread t = new Thread(r, "kt-btbat"); t.setDaemon(true); return t; });
        return pusher;
    }
    static void soon() {
        final Context c = appCtx; if (c == null || !pageOpen || sink == null) return;
        if (!PENDING.compareAndSet(false, true)) return;
        try { pusher().schedule(() -> { PENDING.set(false); Sink s = sink; if (s != null && pageOpen) { try { s.changed(state(c, null)); } catch (Throwable ignored) {} } }, 250, java.util.concurrent.TimeUnit.MILLISECONDS); }
        catch (Throwable e) { PENDING.set(false); }
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
