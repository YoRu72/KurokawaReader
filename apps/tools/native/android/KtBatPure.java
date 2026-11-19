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

    private static int num(Object o) {
        if (o instanceof Integer) return (Integer) o;
        if (o instanceof Number) return ((Number) o).intValue();
        if (o instanceof String) { try { return Integer.parseInt(((String) o).trim()); } catch (NumberFormatException e) { return Integer.MIN_VALUE; } }
        return Integer.MIN_VALUE;
    }

    /**
     * Apple's +IPHONEACCEV: a count, then that many key/value pairs; key 1 is the battery, 0–9 (9 = full) — read as
     * (value + 1) × 10 %. -1 when the event carries no battery.
     */
    static int fromAppleEvent(Object[] args) {
        if (args == null || args.length < 3) return -1;
        int pairs = num(args[0]); if (pairs <= 0 || args.length < 1 + pairs * 2) return -1;
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
        return Math.min(100, level * 100 / (levels - 1));
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
}
