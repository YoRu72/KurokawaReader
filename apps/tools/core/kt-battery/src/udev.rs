// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery), piece P1: the udev rule that lets the signed-in user read the raw HID
// nodes of the devices Tools has a reader for — and no other.
// Derived from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// linux/99-wireless-battery.rules at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its
// contributors, GPL-3.0-or-later.
// Changed here (the original's §9.11 fault): its one line gave the desktop user every hidraw node of the computer —
// keyboards (and what is typed on them), security keys, everything. This rule names each vendor and product the
// readers' tables list (pads/*.rs, mice/*.rs, heads/*.rs) — and of each, only what its reader needs:
// - udev matches all the ATTRS/KERNELS keys of one rule on ONE parent, so a rule cannot ask «this product's HID device»
//   and «its USB interface number» at once. Hence two lines: the first marks the event by the HID device's own name
//   (KERNELS=="0003:VID:PID.*" — USB, cable or receiver) with ENV{KT_BATTERY_IF_nn}="1" (the table knows the interface
//   its reader uses) or ENV{KT_BATTERY_HID}="1" (it does not); the second grants by the USB interface itself
//   (SUBSYSTEMS=="usb", ATTRS{bInterfaceClass}=="03" and ATTRS{bInterfaceNumber}=="nn" — or, for an unknown interface,
//   a HID interface whose boot protocol is neither keyboard (01) nor mouse (02)). A product's other interfaces — its
//   keyboard, its pointer — stay closed.
// - A keyboard whose interface the table does not know gets nothing at all (any of its interfaces may carry the keys
//   typed): such products are listed in a comment in the file.
// - Bluetooth (0005): game controllers only (one HID device per pad; nothing typed on them).
// logind's «uaccess» tag gives the active session's user access, nobody else. The file is numbered 70 so the tag is set
// before logind's own rule (73) reads it. Tools only writes the text to its own folder and shows the steps: it never
// runs sudo or writes /etc itself.
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::model::Kind;

/// The name the rule should have in /etc/udev/rules.d.
pub const RULE_FILE: &str = "70-kurokawa-tools-battery.rules";

/// Every (vendor, product) a reader of Tools may open, sorted, once each.
pub fn listed_ids() -> Vec<(u16, u16)> {
    let mut v: Vec<(u16, u16)> = crate::pads::all_models().map(|m| (m.vid, m.pid)).chain(crate::mice::all_models().map(|m| (m.vid, m.pid))).filter(|(v, p)| *v != 0 && *p != 0).collect();
    v.sort();
    v.dedup();
    v
}

/// What the rule grants of one product.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub vid: u16,
    pub pid: u16,
    /// A game controller (pads/*.rs): also over Bluetooth.
    pub pad: bool,
    /// A keyboard (some table says so).
    pub keyboard: bool,
    /// The USB interfaces its readers use, when every table entry of it names one; None: not known.
    pub ifaces: Option<Vec<i32>>,
    pub name: &'static str,
}

/// The tables' facts about one product, None when no reader lists it.
pub fn entry(vid: u16, pid: u16) -> Option<Entry> {
    let pads: Vec<&crate::pads::Model> = crate::pads::all_models().filter(|m| m.vid == vid && m.pid == pid).collect();
    let mice: Vec<&crate::mice::Model> = crate::mice::all_models().filter(|m| m.vid == vid && m.pid == pid).collect();
    if pads.is_empty() && mice.is_empty() {
        return None;
    }
    // (A pad's table names no interface: unknown, unless only mice tables list it and all name theirs.)
    let ifaces = if pads.is_empty() && mice.iter().all(|m| m.iface.map_or(false, |i| (0..=255).contains(&i))) {
        let mut v: Vec<i32> = mice.iter().filter_map(|m| m.iface).collect();
        v.sort();
        v.dedup();
        Some(v)
    } else {
        None
    };
    let name = pads.first().map(|m| m.name).or_else(|| mice.first().map(|m| m.name)).unwrap_or("");
    Some(Entry { vid, pid, pad: !pads.is_empty(), keyboard: mice.iter().any(|m| m.kind == Kind::Keyboard), ifaces, name })
}

/// The rule file's text for `ids` (products no reader lists get nothing).
pub fn rules_for(ids: &[(u16, u16)]) -> String {
    let mut ids: Vec<(u16, u16)> = ids.to_vec();
    ids.sort();
    ids.dedup();
    render(&ids.into_iter().filter_map(|(v, p)| entry(v, p)).collect::<Vec<_>>())
}

/// The text for these products' facts.
fn render(entries: &[Entry]) -> String {
    let mut s = String::from(
        "# Kurokawa Tools — device battery: read access for the signed-in user (logind's «uaccess») to the raw HID nodes\n\
         # of the devices Tools has a reader for — and of each, only the interface its reader uses:\n\
         # - over USB (cable or receiver): the USB interface the reader's table names; when it names none, the HID\n\
         #   interfaces that are neither a boot keyboard nor a boot mouse. Never a product's keyboard or pointer interface.\n\
         # - keyboards whose interface Tools does not know: nothing (listed at the end).\n\
         # - over Bluetooth: game controllers only.\n\
         # udev matches one rule's ATTRS on one parent, so each product is first marked by its HID device's name, then the\n\
         # mark and the USB interface grant. Generated by Kurokawa Tools.\n\
         # Install: sudo install -m 0644 70-kurokawa-tools-battery.rules /etc/udev/rules.d/\n\
         #          sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=hidraw\n\
         # Remove:  sudo rm /etc/udev/rules.d/70-kurokawa-tools-battery.rules\n",
    );
    let mut used: Vec<i32> = Vec::new();
    let mut unknown = false;
    let mut withheld: Vec<Entry> = Vec::new();
    let mut bt: Vec<Entry> = Vec::new();
    s.push_str("\n# 1. Marks: the listed products' HID devices on USB.\n");
    for e in entries {
        let (v, p) = (e.vid, e.pid);
        if e.pad {
            bt.push(e.clone());
        }
        match &e.ifaces {
            Some(list) => {
                for i in list {
                    s.push_str(&format!("SUBSYSTEM==\"hidraw\", KERNELS==\"0003:{:04X}:{:04X}.*\", ENV{{KT_BATTERY_IF_{:02x}}}=\"1\"\n", v, p, i));
                    if !used.contains(i) {
                        used.push(*i);
                    }
                }
            }
            None if e.keyboard => withheld.push(e.clone()),
            None => {
                s.push_str(&format!("SUBSYSTEM==\"hidraw\", KERNELS==\"0003:{:04X}:{:04X}.*\", ENV{{KT_BATTERY_HID}}=\"1\"\n", v, p));
                unknown = true;
            }
        }
    }
    used.sort();
    s.push_str("\n# 2. Grants: by the USB interface of a marked device.\n");
    for i in &used {
        s.push_str(&format!(
            "SUBSYSTEM==\"hidraw\", ENV{{KT_BATTERY_IF_{:02x}}}==\"1\", SUBSYSTEMS==\"usb\", ATTRS{{bInterfaceClass}}==\"03\", ATTRS{{bInterfaceNumber}}==\"{:02x}\", TAG+=\"uaccess\"\n",
            i, i
        ));
    }
    if unknown {
        s.push_str("SUBSYSTEM==\"hidraw\", ENV{KT_BATTERY_HID}==\"1\", SUBSYSTEMS==\"usb\", ATTRS{bInterfaceClass}==\"03\", ATTRS{bInterfaceProtocol}!=\"01\", ATTRS{bInterfaceProtocol}!=\"02\", TAG+=\"uaccess\"\n");
    }
    s.push_str("\n# 3. Bluetooth: game controllers only.\n");
    for e in &bt {
        s.push_str(&format!("SUBSYSTEM==\"hidraw\", KERNELS==\"0005:{:04X}:{:04X}.*\", TAG+=\"uaccess\"\n", e.vid, e.pid));
    }
    if !withheld.is_empty() {
        s.push_str("\n# Not granted (keyboards whose interface Tools does not know — any of their interfaces may carry what is typed):\n");
        for e in &withheld {
            s.push_str(&format!("#   {:04X}:{:04X} {}\n", e.vid, e.pid, e.name.replace(['\n', '\r'], " ")));
        }
    }
    s
}

/// The rule for every device the readers list.
pub fn rules() -> String {
    rules_for(&listed_ids())
}

/// The commands the page shows, with the folder the file was saved in (quoted for a shell).
pub fn install_steps(saved_in: &str) -> Vec<String> {
    let q = shell_quote(&format!("{}/{}", saved_in.trim_end_matches('/'), RULE_FILE));
    vec![
        format!("sudo install -m 0644 {} /etc/udev/rules.d/{}", q, RULE_FILE),
        "sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=hidraw".to_string(),
    ]
}

/// A path in single quotes for a POSIX shell («'» written as «'\''»).
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules_lines(r: &str) -> Vec<&str> {
        r.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()).collect()
    }

    #[test]
    fn no_grant_by_vendor_and_product_alone_and_never_all_nodes() {
        let r = rules();
        assert!(listed_ids().len() > 20, "the readers' tables");
        for l in rules_lines(&r) {
            assert!(l.starts_with("SUBSYSTEM==\"hidraw\", "), "{l}");
            assert!(!l.contains("MODE") && !l.contains("GROUP"), "no mode for everyone, no group: {l}");
            if l.contains("TAG+=\"uaccess\"") {
                // (A grant: by a USB interface of a marked device, or a Bluetooth game controller — never a USB product
                // by its ids alone.)
                let usb = l.contains("SUBSYSTEMS==\"usb\", ATTRS{bInterfaceClass}==\"03\"") && l.contains("ENV{KT_BATTERY_") && !l.contains("KERNELS");
                let bt = l.contains("KERNELS==\"0005:");
                assert!(usb || bt, "{l}");
                assert!(!l.contains("KERNELS==\"0003:") && !l.contains("KERNELS==\"*:"), "{l}");
            } else {
                assert!(l.contains("KERNELS==\"0003:") && l.contains("ENV{KT_BATTERY_") && l.ends_with("=\"1\""), "a mark: {l}");
            }
        }
        assert!(!r.lines().any(|l| l.trim() == "SUBSYSTEM==\"hidraw\", TAG+=\"uaccess\""), "the original's rule for every node");
        // (Every grant line comes after every mark line: udev reads the file in order.)
        let ls = rules_lines(&r);
        let last_mark = ls.iter().rposition(|l| !l.contains("uaccess")).unwrap();
        let first_grant = ls.iter().position(|l| l.contains("uaccess")).unwrap();
        assert!(last_mark < first_grant);
    }

    #[test]
    fn bluetooth_only_for_game_controllers() {
        let r = rules();
        for l in r.lines().filter(|l| l.contains("KERNELS==\"0005:")) {
            let id = &l[l.find("0005:").unwrap() + 5..][..9];
            let (v, p) = (u16::from_str_radix(&id[..4], 16).unwrap(), u16::from_str_radix(&id[5..], 16).unwrap());
            assert!(entry(v, p).unwrap().pad, "{l}");
        }
        // (A DualSense: on Bluetooth; over USB marked, its interface unknown — only non-boot HID interfaces.)
        assert!(r.contains("SUBSYSTEM==\"hidraw\", KERNELS==\"0005:054C:0CE6.*\", TAG+=\"uaccess\""));
        assert!(r.contains("SUBSYSTEM==\"hidraw\", KERNELS==\"0003:054C:0CE6.*\", ENV{KT_BATTERY_HID}=\"1\""));
        assert!(r.contains("ENV{KT_BATTERY_HID}==\"1\", SUBSYSTEMS==\"usb\", ATTRS{bInterfaceClass}==\"03\", ATTRS{bInterfaceProtocol}!=\"01\", ATTRS{bInterfaceProtocol}!=\"02\", TAG+=\"uaccess\""));
        // (A mouse or keyboard never over Bluetooth.)
        let kb = crate::mice::all_models().find(|m| m.kind == Kind::Keyboard).unwrap();
        if !entry(kb.vid, kb.pid).unwrap().pad {
            assert!(!r.contains(&format!("0005:{:04X}:{:04X}", kb.vid, kb.pid)));
        }
    }

    #[test]
    fn a_known_interface_is_granted_alone() {
        // (A product whose tables all name its interface: marked with that interface, granted only there.)
        let m = crate::mice::all_models().find(|m| m.iface.is_some() && entry(m.vid, m.pid).map_or(false, |e| e.ifaces.is_some())).expect("a model with its interface");
        let e = entry(m.vid, m.pid).unwrap();
        let i = e.ifaces.as_ref().unwrap()[0];
        let r = rules_for(&[(m.vid, m.pid)]);
        let mark = format!("SUBSYSTEM==\"hidraw\", KERNELS==\"0003:{:04X}:{:04X}.*\", ENV{{KT_BATTERY_IF_{:02x}}}=\"1\"", m.vid, m.pid, i);
        let grant = format!("SUBSYSTEM==\"hidraw\", ENV{{KT_BATTERY_IF_{:02x}}}==\"1\", SUBSYSTEMS==\"usb\", ATTRS{{bInterfaceClass}}==\"03\", ATTRS{{bInterfaceNumber}}==\"{:02x}\", TAG+=\"uaccess\"", i, i);
        assert!(r.lines().any(|l| l == mark), "{r}");
        assert!(r.lines().any(|l| l == grant), "{r}");
        assert!(!r.contains("KT_BATTERY_HID"), "no unknown-interface grant for it");
        assert_eq!(rules_lines(&r).iter().filter(|l| l.contains("uaccess")).count(), e.ifaces.as_ref().unwrap().len() + usize::from(e.pad));
    }

    fn made_up(pad: bool, keyboard: bool, ifaces: Option<Vec<i32>>) -> Entry {
        Entry { vid: 0x1234, pid: 0x5678, pad, keyboard, ifaces, name: "Made-up device" }
    }

    #[test]
    fn made_up_units() {
        // (A keyboard, its interface unknown: nothing granted, named in the comment.)
        let r = render(&[made_up(false, true, None)]);
        assert!(rules_lines(&r).is_empty(), "{r}");
        assert!(r.contains("#   1234:5678 Made-up device"));
        // (A keyboard whose reader uses interface 2: that interface alone.)
        let r = render(&[made_up(false, true, Some(vec![2]))]);
        assert_eq!(rules_lines(&r), vec![
            "SUBSYSTEM==\"hidraw\", KERNELS==\"0003:1234:5678.*\", ENV{KT_BATTERY_IF_02}=\"1\"",
            "SUBSYSTEM==\"hidraw\", ENV{KT_BATTERY_IF_02}==\"1\", SUBSYSTEMS==\"usb\", ATTRS{bInterfaceClass}==\"03\", ATTRS{bInterfaceNumber}==\"02\", TAG+=\"uaccess\"",
        ]);
        // (A mouse, its interface unknown: non-boot HID interfaces; never Bluetooth.)
        let r = render(&[made_up(false, false, None)]);
        assert_eq!(rules_lines(&r).len(), 2);
        assert!(r.contains("ATTRS{bInterfaceProtocol}!=\"01\", ATTRS{bInterfaceProtocol}!=\"02\"") && !r.contains("0005:"));
        // (A pad: Bluetooth too; interface 10 written as the kernel writes it.)
        let r = render(&[made_up(true, false, Some(vec![10]))]);
        assert!(r.contains("ENV{KT_BATTERY_IF_0a}") && r.contains("ATTRS{bInterfaceNumber}==\"0a\"") && r.contains("KERNELS==\"0005:1234:5678.*\", TAG+=\"uaccess\""));
    }

    #[test]
    fn a_keyboard_whose_interface_is_unknown_gets_nothing() {
        let kb = crate::mice::all_models().find(|m| m.kind == Kind::Keyboard && entry(m.vid, m.pid).map_or(false, |e| e.ifaces.is_none() && !e.pad));
        if let Some(m) = kb {
            let r = rules_for(&[(m.vid, m.pid)]);
            assert!(rules_lines(&r).is_empty(), "{r}");
            assert!(r.contains(&format!("#   {:04X}:{:04X}", m.vid, m.pid)), "listed as not granted");
        }
        // (A keyboard whose interface is known: that interface only.)
        let known = crate::mice::all_models().find(|m| m.kind == Kind::Keyboard && entry(m.vid, m.pid).map_or(false, |e| e.ifaces.is_some()));
        if let Some(m) = known {
            let r = rules_for(&[(m.vid, m.pid)]);
            assert!(rules_lines(&r).iter().all(|l| !l.contains("KT_BATTERY_HID")), "{r}");
        }
        // (A product no reader lists: nothing.)
        assert!(rules_lines(&rules_for(&[(0x1234, 0x00AB)])).is_empty());
    }

    #[test]
    fn steps_quote_the_folder() {
        let s = install_steps("/home/u/My Files/it's");
        assert_eq!(s[0], "sudo install -m 0644 '/home/u/My Files/it'\\''s/70-kurokawa-tools-battery.rules' /etc/udev/rules.d/70-kurokawa-tools-battery.rules");
    }
}
