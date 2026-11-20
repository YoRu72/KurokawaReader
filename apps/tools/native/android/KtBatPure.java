package app.kurokawa.tools;

/**
 * Device battery on the phone (0.21 P2), the plain-Java part (no Android classes, tested by tests/native/batphone.sh):
 * a paired device's kind from its Bluetooth class (and its name when the class says little), the levels a headset
 * tells over the hands-free link in its makers' own words (Apple's +IPHONEACCEV, Plantronics' +XEVENT=BATTERY — read
 * the way Android's own HeadsetStateMachine reads them), and the low-battery notices' rule: one notice per drop
 * below the device's mark, armed again only once the level is back a little above it.
 */
final class KtBatPure {
    private KtBatPure() {}

    /** The kinds the page draws (views/batphone.ts). */
    static final String[] KINDS = { "headset", "earbuds", "speaker", "controller", "keyboard", "mouse", "watch", "phone", "other" };

    // (android.bluetooth.BluetoothClass's constants, written out: this file must build without Android.)
    static final int MAJOR_COMPUTER = 0x0100, MAJOR_PHONE = 0x0200, MAJOR_AUDIO_VIDEO = 0x0400, MAJOR_PERIPHERAL = 0x0500, MAJOR_WEARABLE = 0x0700, MAJOR_TOY = 0x0800;
    static final int AV_HEADSET = 0x0404, AV_HANDSFREE = 0x0408, AV_MICROPHONE = 0x0410, AV_LOUDSPEAKER = 0x0414, AV_HEADPHONES = 0x0418, AV_PORTABLE = 0x041C, AV_CAR = 0x0420, AV_HIFI = 0x0428;
    static final int WEAR_WATCH = 0x0704;

    /**
     * The kind of a paired device. major / device: BluetoothClass.getMajorDeviceClass() / getDeviceClass() (-1 when
     * the device gave none). The name decides only what the class leaves open (earbuds call themselves «headphones»,
     * many pads and watches send no useful class).
     */
    static String kindOf(int major, int device, String name) {
        String n = name == null ? "" : name.toLowerCase(java.util.Locale.ROOT);
        boolean budsName = n.contains("buds") || n.contains("airpods") || n.contains("earbud") || n.contains("pods") || n.matches(".*\\btws\\b.*") || n.contains("earphone");
        boolean padName = n.contains("controller") || n.contains("gamepad") || n.contains("dualsense") || n.contains("dualshock") || n.contains("xbox") || n.contains("joy-con") || n.contains("8bitdo") || n.contains("pro controller");
        boolean watchName = n.contains("watch") || n.contains("band ") || n.endsWith(" band") || n.contains("fitbit");
        if (major == MAJOR_PERIPHERAL) {
            int minor = device & 0xFF;
            // (The two top bits: keyboard 0x40, pointing 0x80; the low ones: joystick 0x04, gamepad 0x08.)
            int sub = minor & 0x3C;
            if (sub == 0x04 || sub == 0x08 || padName) return "controller";
            if ((minor & 0x40) != 0) return "keyboard";
            if ((minor & 0x80) != 0) return "mouse";
            return padName ? "controller" : "other";
        }
        if (major == MAJOR_AUDIO_VIDEO) {
            if (device == AV_LOUDSPEAKER || device == AV_PORTABLE || device == AV_HIFI || device == AV_CAR) return budsName ? "earbuds" : "speaker";
            if (device == AV_HEADSET || device == AV_HANDSFREE || device == AV_HEADPHONES || device == AV_MICROPHONE) return budsName ? "earbuds" : "headset";
            return budsName ? "earbuds" : "headset";
        }
        if (major == MAJOR_WEARABLE) return device == WEAR_WATCH || watchName ? "watch" : budsName ? "earbuds" : "other";
        if (major == MAJOR_PHONE) return "phone";
        if (major == MAJOR_TOY && padName) return "controller";
        if (padName) return "controller";
        if (budsName) return "earbuds";
        if (watchName && major != MAJOR_COMPUTER) return "watch";
        if (n.contains("headset") || n.contains("headphone")) return "headset";
        if (n.contains("speaker") || n.contains("soundbar")) return "speaker";
        if (n.contains("keyboard")) return "keyboard";
        if (n.contains("mouse")) return "mouse";
        return "other";
    }

    /** A number the event carries; Integer.MIN_VALUE when there is none (a Number beyond int's range is none). */
    static int num(Object o) {
        if (o instanceof Integer) return (Integer) o;
        if (o instanceof Long || o instanceof Short || o instanceof Byte) {
            long v = ((Number) o).longValue();
            return v < Integer.MIN_VALUE + 1L || v > Integer.MAX_VALUE ? Integer.MIN_VALUE : (int) v;
        }
        if (o instanceof Number) {
            double v = ((Number) o).doubleValue();
            return Double.isNaN(v) || v != Math.rint(v) || v <= Integer.MIN_VALUE || v > Integer.MAX_VALUE ? Integer.MIN_VALUE : (int) v;
        }
        if (o instanceof String) { try { return Integer.parseInt(((String) o).trim()); } catch (NumberFormatException e) { return Integer.MIN_VALUE; } }
        return Integer.MIN_VALUE;
    }

    /**
     * Apple's +IPHONEACCEV: a count, then that many key/value pairs; key 1 is the battery, 0–9 (9 = full) — read as
     * (value + 1) × 10 %. -1 when the event carries no battery.
     */
    static int fromAppleEvent(Object[] args) {
        if (args == null || args.length < 3) return -1;
        int pairs = num(args[0]);
        // (Compared by division: a hostile count such as 2^30 must not overflow pairs × 2.)
        if (pairs <= 0 || pairs > (args.length - 1) / 2) return -1;
        for (int i = 0; i < pairs; i++) {
            int key = num(args[1 + i * 2]), val = num(args[2 + i * 2]);
            if (key == 1) return val < 0 || val > 9 ? -1 : (val + 1) * 10;
        }
        return -1;
    }

    /** Plantronics' +XEVENT=BATTERY,level,levels,minutes,charging: level of levels − 1 as a percentage. -1 otherwise. */
    static int fromXEvent(Object[] args) {
        if (args == null || args.length < 3) return -1;
        if (!(args[0] instanceof String) || !"BATTERY".equalsIgnoreCase(((String) args[0]).trim())) return -1;
        int level = num(args[1]), levels = num(args[2]);
        if (level < 0 || levels <= 1 || level > levels) return -1;
        // (In long: level × 100 overflows int for a hostile level.)
        return (int) Math.min(100L, (long) level * 100L / ((long) levels - 1L));
    }

    /** A level the system gave (BluetoothDevice.getBatteryLevel, the BATTERY_LEVEL_CHANGED broadcast): 0–100, else -1. */
    static int systemLevel(int v) { return v < 0 || v > 100 ? -1 : v; }

    /** The low marks offered (as on the computer: kt-battery notice.rs CHOICES). */
    static final int[] MARKS = { 5, 10, 15, 20, 25, 30, 35, 40 };
    static int mark(int v) { for (int m : MARKS) if (m == v) return v; return 15; }
    /** How far above its mark a device must come back before it may be told low again. */
    static final int REARM = 5;

    /** One notice per drop: told once when a level reaches the mark, again only after it climbed back above it. */
    static final class Notices {
        private final java.util.Set<String> told = new java.util.HashSet<>();
        /** True when this reading should be told now. level -1 (unknown) and mark 0 (none) change nothing. */
        synchronized boolean feed(String key, int level, int mark) {
            if (key == null || level < 0 || mark <= 0) return false;
            if (level <= mark) return told.add(key);
            if (level >= mark + REARM) told.remove(key);
            return false;
        }
        synchronized boolean told(String key) { return told.contains(key); }
        synchronized void forget(String key) { told.remove(key); }
    }

    /* ---------- 0.22.1: connected or not from Android's public sources, which links are up, the details' words ---------- */

    /** The links the page shows a device using, in this order (the chip, the details sheet). */
    static final String[] PROFILES = { "audio", "calls", "leAudio", "hearingAid", "input", "le" };
    // (android.bluetooth.BluetoothProfile's numbers, written out: HID_HOST is 4 though not public on every Android.)
    static final int P_HEADSET = 1, P_A2DP = 2, P_HID_HOST = 4, P_GATT = 7, P_GATT_SERVER = 8, P_HEARING_AID = 21, P_LE_AUDIO = 22;
    /** A profile proxy's (or a profile broadcast's) link word; null for one the page does not show. */
    static String profileTag(int profile) {
        switch (profile) {
            case P_A2DP: return "audio"; case P_HEADSET: return "calls"; case P_HID_HOST: return "input";
            case P_GATT: case P_GATT_SERVER: return "le"; case P_HEARING_AID: return "hearingAid"; case P_LE_AUDIO: return "leAudio";
            default: return null;
        }
    }
    /** android.media.AudioDeviceInfo's Bluetooth types as link words (SCO 7, A2DP 8, hearing aid 23, LE headset 26, LE speaker 27, LE broadcast 30). */
    static String audioTag(int type) {
        switch (type) {
            case 7: return "calls"; case 8: return "audio"; case 23: return "hearingAid";
            case 26: case 27: case 30: return "leAudio";
            default: return null;
        }
    }
    /** A Bluetooth address as one key (upper case); null for anything that is not one. */
    static String addrKey(String a) {
        if (a == null) return null; String u = a.trim().toUpperCase(java.util.Locale.ROOT);
        return u.matches("[0-9A-F]{2}(:[0-9A-F]{2}){5}") && !"00:00:00:00:00:00".equals(u) && !"02:00:00:00:00:00".equals(u) ? u : null;
    }
    /** A device name as one key (case and spacing set aside); null when empty. */
    static String nameKey(String n) {
        if (n == null) return null; String k = n.trim().replaceAll("\\s+", " ").toLowerCase(java.util.Locale.ROOT);
        return k.isEmpty() ? null : k;
    }

    /**
     * What Android's public sources say is connected now, gathered once per reading: the profile proxies' connected
     * devices, the GATT links, the audio routes, the input devices (by name: Android gives them no address), the
     * broadcasts heard (Live), and the hidden isConnected as one more voice — any one saying yes is enough.
     */
    static final class Presence {
        static final String LINK = "link";
        private final java.util.Map<String, java.util.Set<String>> byAddr = new java.util.HashMap<>(), byName = new java.util.HashMap<>();
        void add(String addr, String tag) { String k = addrKey(addr); if (k != null && tag != null) byAddr.computeIfAbsent(k, x -> new java.util.HashSet<>()).add(tag); }
        void addByName(String name, String tag) { String k = nameKey(name); if (k != null && tag != null) byName.computeIfAbsent(k, x -> new java.util.HashSet<>()).add(tag); }
        private java.util.Set<String> all(String addr, String alias, String name) {
            java.util.Set<String> s = new java.util.HashSet<>();
            String a = addrKey(addr); if (a != null && byAddr.containsKey(a)) s.addAll(byAddr.get(a));
            for (String n : new String[] { alias, name }) { String k = nameKey(n); if (k != null && byName.containsKey(k)) s.addAll(byName.get(k)); }
            return s;
        }
        /** The links up for one paired device, in PROFILES' order. */
        java.util.List<String> profiles(String addr, String alias, String name) {
            java.util.Set<String> s = all(addr, alias, name); java.util.List<String> r = new java.util.ArrayList<>();
            for (String p : PROFILES) if (s.contains(p)) r.add(p);
            return r;
        }
        /** Connected: any source says so. reflected: the hidden isConnected's answer, null when Android refused it. */
        boolean connected(String addr, String alias, String name, Boolean reflected) { return Boolean.TRUE.equals(reflected) || !all(addr, alias, name).isEmpty(); }
    }

    /** What the broadcasts said since they were first heard (a link up or down, a profile connected or not). */
    static final class Live {
        private final java.util.Map<String, java.util.Set<String>> on = new java.util.HashMap<>();
        /** tag Presence.LINK for the ACL link itself: its end ends every profile too. */
        synchronized void heard(String addr, String tag, boolean up) {
            String k = addrKey(addr); if (k == null || tag == null) return;
            if (up) on.computeIfAbsent(k, x -> new java.util.HashSet<>()).add(tag);
            else if (Presence.LINK.equals(tag)) on.remove(k);
            else { java.util.Set<String> s = on.get(k); if (s != null) { s.remove(tag); if (s.isEmpty()) on.remove(k); } }
        }
        /** Bluetooth turned off, or the broadcasts no longer heard: nothing known any more. */
        synchronized void clear() { on.clear(); }
        synchronized void into(Presence p) { for (java.util.Map.Entry<String, java.util.Set<String>> e : on.entrySet()) for (String t : e.getValue()) p.add(e.getKey(), t); }
    }
    /** A profile broadcast's state (BluetoothProfile.STATE_*): 2 connected → true, 0 disconnected → false, else null. */
    static Boolean profileState(int st) { return st == 2 ? Boolean.TRUE : st == 0 ? Boolean.FALSE : null; }

    /** BluetoothDevice.getType(): 1 classic, 2 LE, 3 both; null when unknown. */
    static String typeKey(int t) { return t == 1 ? "classic" : t == 2 ? "le" : t == 3 ? "dual" : null; }
    /** BluetoothDevice.getBondState(): 10 none, 11 bonding, 12 bonded. */
    static String bondKey(int b) { return b == 12 ? "bonded" : b == 11 ? "bonding" : b == 10 ? "none" : null; }
    /** The major class in one word; null for «uncategorized» or none. */
    static String majorKey(int major) {
        switch (major) {
            case MAJOR_COMPUTER: return "computer"; case MAJOR_PHONE: return "phone"; case 0x0300: return "network"; case MAJOR_AUDIO_VIDEO: return "audioVideo";
            case MAJOR_PERIPHERAL: return "peripheral"; case 0x0600: return "imaging"; case MAJOR_WEARABLE: return "wearable"; case MAJOR_TOY: return "toy"; case 0x0900: return "health";
            default: return null;
        }
    }
    /** The minor class in one word, for the classes the page names; null otherwise. */
    static String minorKey(int major, int device) {
        if (major == MAJOR_AUDIO_VIDEO) switch (device) {
            case AV_HEADSET: return "headset"; case AV_HANDSFREE: return "handsFree"; case AV_MICROPHONE: return "microphone"; case AV_LOUDSPEAKER: return "loudspeaker";
            case AV_HEADPHONES: return "headphones"; case AV_PORTABLE: return "portableAudio"; case AV_CAR: return "carAudio"; case AV_HIFI: return "hifi"; default: return null;
        }
        if (major == MAJOR_COMPUTER) return device == 0x0104 ? "desktop" : device == 0x010C ? "laptop" : null;
        if (major == MAJOR_PHONE) return device == 0x020C ? "smartphone" : null;
        if (major == MAJOR_WEARABLE) return device == WEAR_WATCH ? "watch" : null;
        if (major == MAJOR_PERIPHERAL) {
            int minor = device & 0xFF, sub = minor & 0x3C;
            if (sub == 0x04) return "joystick"; if (sub == 0x08) return "gamepad"; if (sub == 0x0C) return "remote";
            if ((minor & 0xC0) == 0xC0) return "combo"; if ((minor & 0x40) != 0) return "keyboard"; if ((minor & 0x80) != 0) return "pointing";
        }
        return null;
    }
    /** The 16-bit services the page names (Bluetooth SIG numbers) → their word. */
    private static final java.util.Map<Integer, String> SERVICES = new java.util.HashMap<>();
    static {
        int[][] n = { { 0x1101 }, { 0x1105, 0x1106 }, { 0x1108 }, { 0x110A }, { 0x110B }, { 0x110C, 0x110E, 0x110F }, { 0x111E }, { 0x1124, 0x1812 }, { 0x180F },
            { 0x184E, 0x184F, 0x1850, 0x1853 }, { 0xFDF0, 0x1854 }, { 0x112F }, { 0x1132 }, { 0x180A }, { 0x180D } };
        String[] w = { "serial", "fileTransfer", "headset", "audioSource", "audioSink", "remote", "handsFree", "hid", "battery", "leAudio", "hearingAid", "phonebook", "messages", "deviceInfo", "heartRate" };
        for (int i = 0; i < n.length; i++) for (int v : n[i]) SERVICES.put(v, w[i]);
    }
    /** The device's advertised service UUIDs as words, each once, in the order given; unknown ones left out. */
    static java.util.List<String> services(String[] uuids) {
        java.util.LinkedHashSet<String> r = new java.util.LinkedHashSet<>();
        if (uuids != null) for (String u : uuids) {
            if (u == null) continue; String s = u.trim().toLowerCase(java.util.Locale.ROOT);
            if (!s.matches("0000[0-9a-f]{4}-0000-1000-8000-00805f9b34fb")) continue;
            String w = SERVICES.get(Integer.parseInt(s.substring(4, 8), 16)); if (w != null) r.add(w);
        }
        return new java.util.ArrayList<>(r);
    }
    /** BluetoothCodecConfig's codec type in its usual name; null when unknown. */
    static String codecName(int type) {
        switch (type) { case 0: return "SBC"; case 1: return "AAC"; case 2: return "aptX"; case 3: return "aptX HD"; case 4: return "LDAC"; case 5: return "LC3"; case 6: return "Opus"; default: return null; }
    }
    /** A battery metadata value (BluetoothDevice.getMetadata: ASCII digits): 0–100, else -1. */
    static int metaLevel(byte[] v) {
        if (v == null || v.length == 0 || v.length > 4) return -1;
        try { return systemLevel(Integer.parseInt(new String(v, java.nio.charset.StandardCharsets.US_ASCII).trim())); } catch (NumberFormatException e) { return -1; }
    }
}
