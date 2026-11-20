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

        // 0.22.1: connected from the public sources (made-up addresses and names).
        KtBatPure.Presence pr = new KtBatPure.Presence();
        pr.add("aa:00:00:00:00:01", KtBatPure.profileTag(KtBatPure.P_A2DP));
        check("refused reflection (null) + the A2DP proxy says connected → connected", pr.connected("AA:00:00:00:00:01", "Lake Buds", "Lake Buds", null));
        eq("…its links: audio", "[audio]", pr.profiles("AA:00:00:00:00:01", null, "Lake Buds").toString());
        check("refused reflection and no source → not connected", !pr.connected("AA:00:00:00:00:09", null, "Nobody", null));
        check("the hidden call alone still counts (one voice)", pr.connected("AA:00:00:00:00:09", null, "Nobody", Boolean.TRUE));
        check("the hidden call saying no does not overrule a profile", pr.connected("AA:00:00:00:00:01", null, null, Boolean.FALSE));
        pr.add("AA:00:00:00:00:01", KtBatPure.profileTag(KtBatPure.P_HEADSET)); pr.add("AA:00:00:00:00:01", KtBatPure.audioTag(8));
        eq("A2DP + hands-free + the audio route: audio, calls (each once, in order)", "[audio, calls]", pr.profiles("AA:00:00:00:00:01", null, null).toString());
        pr.addByName("  Desk   KEYS ", "input");
        eq("an input device matched by name (case and spaces aside)", "[input]", pr.profiles("AA:00:00:00:00:05", "desk keys", null).toString());
        check("…and so connected", pr.connected("AA:00:00:00:00:05", null, "Desk Keys", null));
        pr.add("AA:00:00:00:00:07", KtBatPure.profileTag(KtBatPure.P_GATT));
        eq("an LE device on GATT", "[le]", pr.profiles("AA:00:00:00:00:07", null, null).toString());
        pr.add("AA:00:00:00:00:08", KtBatPure.Presence.LINK);
        check("a link heard up without a profile: connected, no link word shown", pr.connected("AA:00:00:00:00:08", null, null, null) && pr.profiles("AA:00:00:00:00:08", null, null).isEmpty());
        pr.add("not an address", "audio"); pr.add("02:00:00:00:00:00", "audio");
        check("junk and the hidden placeholder address ignored", !pr.connected("02:00:00:00:00:00", null, null, null));
        eq("profile numbers: hearing aid 21, LE audio 22, input 4", "hearingAid leAudio input", KtBatPure.profileTag(21) + " " + KtBatPure.profileTag(22) + " " + KtBatPure.profileTag(4));
        check("unknown profile and audio types: none", KtBatPure.profileTag(99) == null && KtBatPure.audioTag(2) == null);
        eq("audio types: SCO calls, LE headset", "calls leAudio hearingAid", KtBatPure.audioTag(7) + " " + KtBatPure.audioTag(26) + " " + KtBatPure.audioTag(23));
        // The broadcasts heard.
        KtBatPure.Live live = new KtBatPure.Live();
        live.heard("AA:00:00:00:00:01", "audio", true); live.heard("AA:00:00:00:00:01", "calls", true); live.heard("AA:00:00:00:00:02", KtBatPure.Presence.LINK, true);
        KtBatPure.Presence p2 = new KtBatPure.Presence(); live.into(p2);
        check("broadcasts: audio and calls up, a link up", p2.profiles("AA:00:00:00:00:01", null, null).size() == 2 && p2.connected("AA:00:00:00:00:02", null, null, null));
        live.heard("AA:00:00:00:00:01", "calls", false); live.heard("AA:00:00:00:00:02", KtBatPure.Presence.LINK, false);
        p2 = new KtBatPure.Presence(); live.into(p2);
        check("a profile down, a link down", "[audio]".equals(p2.profiles("AA:00:00:00:00:01", null, null).toString()) && !p2.connected("AA:00:00:00:00:02", null, null, null));
        live.clear(); p2 = new KtBatPure.Presence(); live.into(p2);
        check("Bluetooth off: nothing left connected", !p2.connected("AA:00:00:00:00:01", null, null, null));
        check("profile states: 2 up, 0 down, 1 (connecting) nothing", Boolean.TRUE.equals(KtBatPure.profileState(2)) && Boolean.FALSE.equals(KtBatPure.profileState(0)) && KtBatPure.profileState(1) == null);
        // The details' words.
        eq("types", "classic le dual null", KtBatPure.typeKey(1) + " " + KtBatPure.typeKey(2) + " " + KtBatPure.typeKey(3) + " " + KtBatPure.typeKey(0));
        eq("bond", "bonded bonding none", KtBatPure.bondKey(12) + " " + KtBatPure.bondKey(11) + " " + KtBatPure.bondKey(10));
        eq("class words: audio/video, headphones", "audioVideo headphones", KtBatPure.majorKey(0x0400) + " " + KtBatPure.minorKey(0x0400, 0x0418));
        eq("class words: peripheral combo, gamepad, uncategorized", "combo gamepad null", KtBatPure.minorKey(0x0500, 0x05C0) + " " + KtBatPure.minorKey(0x0500, 0x0508) + " " + KtBatPure.majorKey(0x1F00));
        eq("services: sink, hands-free, HID, battery; unknown and doubles left out", "[audioSink, handsFree, hid, battery]", KtBatPure.services(new String[] {
            "0000110b-0000-1000-8000-00805f9b34fb", "0000111E-0000-1000-8000-00805F9B34FB", "00001124-0000-1000-8000-00805f9b34fb", "00001812-0000-1000-8000-00805f9b34fb", "0000180f-0000-1000-8000-00805f9b34fb", "12345678-0000-1000-8000-00805f9b34fb", "0000abcd-0000-1000-8000-00805f9b34fb", null }).toString());
        eq("services: none", "[]", KtBatPure.services(null).toString());
        eq("codecs", "SBC AAC LDAC LC3 null", KtBatPure.codecName(0) + " " + KtBatPure.codecName(1) + " " + KtBatPure.codecName(4) + " " + KtBatPure.codecName(5) + " " + KtBatPure.codecName(1000000));
        eq("a part's level (ASCII)", 70, KtBatPure.metaLevel("70".getBytes()));
        eq("a part's level: junk, too big, none", "-1 -1 -1", KtBatPure.metaLevel("x".getBytes()) + " " + KtBatPure.metaLevel("101".getBytes()) + " " + KtBatPure.metaLevel(null));

        System.out.println(fails == 0 ? "device battery (phone): all passed" : "device battery (phone): " + fails + " failed");
        System.exit(fails == 0 ? 0 : 1);
    }
}
