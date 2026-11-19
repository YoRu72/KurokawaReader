// Device battery on the phone (0.21 P2): KtBatPure — a paired device's kind from its Bluetooth class and name, the
// levels a headset tells in Apple's and Plantronics' own words, the low notices' «once per drop» rule. Made-up names.
public class BatT {
    static int fails = 0;
    static void check(String what, boolean ok) { System.out.println((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; }
    static void eq(String what, Object want, Object got) { check(what + " → " + got, want.equals(got)); }

    public static void main(String[] a) {
        // Kinds from the class (major, device) — android.bluetooth.BluetoothClass's numbers.
        eq("a headset (AV wearable headset)", "headset", KtBatPure.kindOf(0x0400, 0x0404, "Field Headset"));
        eq("headphones", "headset", KtBatPure.kindOf(0x0400, 0x0418, "Studio Cans"));
        eq("earbuds calling themselves headphones", "earbuds", KtBatPure.kindOf(0x0400, 0x0418, "Lake Buds 2"));
        eq("a pair of «pods»", "earbuds", KtBatPure.kindOf(0x0400, 0x0404, "Test Pods Pro"));
        eq("a loudspeaker", "speaker", KtBatPure.kindOf(0x0400, 0x0414, "Garden Box"));
        eq("portable audio", "speaker", KtBatPure.kindOf(0x0400, 0x041C, "Pocket Box"));
        eq("a keyboard (peripheral 0x40)", "keyboard", KtBatPure.kindOf(0x0500, 0x0540, "Desk Keys"));
        eq("a mouse (peripheral 0x80)", "mouse", KtBatPure.kindOf(0x0500, 0x0580, "Desk Mouse"));
        eq("keyboard and pointer together: a keyboard", "keyboard", KtBatPure.kindOf(0x0500, 0x05C0, "Combo"));
        eq("a gamepad (peripheral 0x08)", "controller", KtBatPure.kindOf(0x0500, 0x0508, "Pad One"));
        eq("a joystick (peripheral 0x04)", "controller", KtBatPure.kindOf(0x0500, 0x0504, "Stick"));
        eq("a pad sent as a plain peripheral, its name says it", "controller", KtBatPure.kindOf(0x0500, 0x0500, "Wireless Controller"));
        eq("a wrist watch", "watch", KtBatPure.kindOf(0x0700, 0x0704, "Wrist One"));
        eq("a phone", "phone", KtBatPure.kindOf(0x0200, 0x020C, "Other Phone"));
        eq("no class, a watch by name", "watch", KtBatPure.kindOf(-1, -1, "Runner Watch 3"));
        eq("no class, unknown name", "other", KtBatPure.kindOf(-1, -1, "Thing 42"));
        eq("no class, no name", "other", KtBatPure.kindOf(-1, -1, null));
        eq("a computer is not a watch for its name", "other", KtBatPure.kindOf(0x0100, 0x010C, "Watchtower PC"));
        for (String k : new String[] { KtBatPure.kindOf(0x0400, 0x0404, "x"), KtBatPure.kindOf(0x0700, 0x0704, "x") }) check("a kind the page knows: " + k, java.util.Arrays.asList(KtBatPure.KINDS).contains(k));

        // Apple's +IPHONEACCEV: count, then key/value pairs; key 1 = battery 0–9.
        eq("Apple: battery 9 → 100 %", 100, KtBatPure.fromAppleEvent(new Object[] { 1, 1, 9 }));
        eq("Apple: battery 0 → 10 %", 10, KtBatPure.fromAppleEvent(new Object[] { 1, 1, 0 }));
        eq("Apple: two pairs, battery second (as strings)", 50, KtBatPure.fromAppleEvent(new Object[] { "2", "2", "0", "1", "4" }));
        eq("Apple: no battery pair", -1, KtBatPure.fromAppleEvent(new Object[] { 1, 2, 1 }));
        eq("Apple: out of range", -1, KtBatPure.fromAppleEvent(new Object[] { 1, 1, 12 }));
        eq("Apple: too short", -1, KtBatPure.fromAppleEvent(new Object[] { 2, 1, 3 }));
        eq("Apple: nothing", -1, KtBatPure.fromAppleEvent(null));
        // Hostile events (a crafted headset, or a broadcast sent with junk): never a throw, never a level.
        eq("Apple: count 2^30 (pairs × 2 would overflow)", -1, KtBatPure.fromAppleEvent(new Object[] { 1073741824, 0, 0 }));
        eq("Apple: count 2^30 as a string", -1, KtBatPure.fromAppleEvent(new Object[] { "1073741824", 1, 9 }));
        eq("Apple: count Integer.MAX_VALUE", -1, KtBatPure.fromAppleEvent(new Object[] { Integer.MAX_VALUE, 1, 9 }));
        eq("Apple: count negative", -1, KtBatPure.fromAppleEvent(new Object[] { -2, 1, 9 }));
        eq("Apple: count Integer.MIN_VALUE", -1, KtBatPure.fromAppleEvent(new Object[] { Integer.MIN_VALUE, 1, 9 }));
        eq("Apple: count a Long beyond int (2^32 + 1 is not 1)", -1, KtBatPure.fromAppleEvent(new Object[] { 4294967297L, 1, 9 }));
        eq("Apple: count a fraction", -1, KtBatPure.fromAppleEvent(new Object[] { 1.5, 1, 9 }));
        eq("Apple: junk words", -1, KtBatPure.fromAppleEvent(new Object[] { "x", "y", "z" }));
        eq("Apple: nulls", -1, KtBatPure.fromAppleEvent(new Object[] { null, null, null }));
        eq("Apple: a null value", -1, KtBatPure.fromAppleEvent(new Object[] { 1, 1, null }));
        eq("Apple: empty", -1, KtBatPure.fromAppleEvent(new Object[0]));
        eq("Apple: value a Long beyond int", -1, KtBatPure.fromAppleEvent(new Object[] { 1, 1, 4294967300L }));
        eq("Apple: a Long count in range still read", 50, KtBatPure.fromAppleEvent(new Object[] { 1L, 1L, 4L }));
        eq("XEVENT: level and levels MAX_VALUE (level × 100 overflowed)", 100, KtBatPure.fromXEvent(new Object[] { "BATTERY", Integer.MAX_VALUE, Integer.MAX_VALUE }));
        eq("XEVENT: a large level of more levels, in range", 50, KtBatPure.fromXEvent(new Object[] { "BATTERY", 1000000000, 2000000001 }));
        eq("XEVENT: nulls", -1, KtBatPure.fromXEvent(new Object[] { null, null, null }));
        eq("XEVENT: empty", -1, KtBatPure.fromXEvent(new Object[0]));
        eq("XEVENT: junk numbers", -1, KtBatPure.fromXEvent(new Object[] { "BATTERY", "lots", "5" }));
        eq("XEVENT: a Long level beyond int", -1, KtBatPure.fromXEvent(new Object[] { "BATTERY", 1L << 40, 5 }));
        // Plantronics' +XEVENT=BATTERY,level,levels,…
        eq("XEVENT: 3 of 5 levels → 75 %", 75, KtBatPure.fromXEvent(new Object[] { "BATTERY", 3, 5, 120, 0 }));
        eq("XEVENT: full → 100 %", 100, KtBatPure.fromXEvent(new Object[] { "BATTERY", "4", "5" }));
        eq("XEVENT: level = levels kept at 100 %", 100, KtBatPure.fromXEvent(new Object[] { "BATTERY", 5, 5 }));
        eq("XEVENT: another event", -1, KtBatPure.fromXEvent(new Object[] { "USER-AGENT", 1, 2 }));
        eq("XEVENT: one level only", -1, KtBatPure.fromXEvent(new Object[] { "BATTERY", 0, 1 }));
        eq("XEVENT: negative", -1, KtBatPure.fromXEvent(new Object[] { "BATTERY", -1, 5 }));
        // The system's level.
        eq("system level 57", 57, KtBatPure.systemLevel(57));
        eq("system level unknown (-1)", -1, KtBatPure.systemLevel(-1));
        eq("system level 120: unknown", -1, KtBatPure.systemLevel(120));
        // Marks.
        eq("a mark offered kept", 25, KtBatPure.mark(25));
        eq("a mark not offered: 15", 15, KtBatPure.mark(17));

        // One notice per drop.
        KtBatPure.Notices n = new KtBatPure.Notices();
        check("above the mark: no notice", !n.feed("A", 40, 20));
        check("reaches the mark: told", n.feed("A", 20, 20));
        check("lower still: not told again", !n.feed("A", 12, 20));
        check("back just above (21): still not armed", !n.feed("A", 21, 20) && n.told("A"));
        check("down again without climbing back: not told", !n.feed("A", 19, 20));
        check("climbed back to mark + 5: armed again", !n.feed("A", 25, 20) && !n.told("A"));
        check("the next drop: told", n.feed("A", 18, 20));
        check("another device: its own", n.feed("B", 5, 10));
        check("unknown level changes nothing", !n.feed("C", -1, 20) && !n.told("C"));
        check("mark 0 (no notice) never tells", !n.feed("D", 3, 0));

        System.out.println(fails == 0 ? "device battery (phone): all passed" : "device battery (phone): " + fails + " failed");
        System.exit(fails == 0 ? 0 : 1);
    }
}
