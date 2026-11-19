// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): how a reader talks to one HID collection.
// Derived from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor), src/hid.h
// (HidDev) at commit 285d64254216857e94ca3ea3e1deb536f863e282, by krisgfx9 and its contributors, GPL-3.0-or-later.
// Changed here: every call takes a deadline and a call past it fails at once (the original's cancelled reads waited
// without limit); a device is opened for queries only unless allow.rs names it (the original opened read/write where
// reading sufficed); a write is an `AllowedWrite` or nothing — `send` refuses one made for another device; the report
// kept with its report id so a reply is checked against its request (`checked_reply`).
// Copyright (C) 2026 Kurokawa contributors. Std only.
use crate::allow::{self, AllowedWrite, HidIdent};
use std::time::Instant;

/// How a collection is opened. QueryOnly (no read or write access) is enough for feature and input reports through
/// the control pipe; Read for listening to input reports; ReadWrite only for a device allow.rs names. Feature (piece
/// 5): no read or write access either — a mouse's or keyboard's own collection is held by Windows, which lets other
/// handles only through the control pipe — but a feature report allow.rs lists may be set on it (a status request
/// sent as a feature report, as Razer's, Glorious', LAMZU's and others' are); nothing else may be sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenMode {
    QueryOnly,
    Read,
    ReadWrite,
    Feature,
}

/// The least a device needs: ReadWrite only when the allow-list has an entry for it.
pub fn open_mode_for(id: &HidIdent, wants_input: bool) -> OpenMode {
    if allow::may_write(id) {
        OpenMode::ReadWrite
    } else if wants_input {
        OpenMode::Read
    } else {
        OpenMode::QueryOnly
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TErr {
    /// The deadline passed (before the call, or while it ran).
    Timeout,
    /// The device is gone (unplugged, its handle invalid).
    Gone,
    /// Not allowed: a write for another device, or a write on a query-only handle.
    Refused,
    /// The reply is shorter than asked, or carries another report id.
    BadReply,
    Failed(String),
}

/// One HID collection, open. Implemented by the Windows reader (win/hid.rs) and by the tests' fakes.
pub trait HidTransport {
    fn ident(&self) -> &HidIdent;
    fn mode(&self) -> OpenMode;
    /// A feature report: `len` bytes, the first the report id.
    fn get_feature(&mut self, report_id: u8, len: usize, deadline: Instant) -> Result<Vec<u8>, TErr>;
    /// The current input report through the control pipe: `len` bytes, the first the report id.
    fn get_input(&mut self, report_id: u8, len: usize, deadline: Instant) -> Result<Vec<u8>, TErr>;
    /// The next input report the device sends on its own (the interrupt pipe), by `deadline`: the report id first (0
    /// when the collection does not number its reports, as Windows gives it). Every open handle gets its own copy of
    /// each report, so listening takes nothing from a game reading the same pad. Timeout when nothing came in time.
    fn read_input(&mut self, _deadline: Instant) -> Result<Vec<u8>, TErr> {
        Err(TErr::Failed("no input pipe".into()))
    }
    /// The collection's feature report length (Windows' count, the report id included), 0 when not known — piece 6's
    /// readers that get a feature report of the collection's own length.
    fn feature_len(&self) -> usize {
        0
    }
    /// Drops the reports this handle has queued (not the device's, not another program's): a reply read after a
    /// request is then the device's answer to it, not an older report.
    fn flush(&mut self) {}
    /// Sends what `w` carries, nothing else — only reached through `send`.
    fn send_allowed(&mut self, w: &AllowedWrite, deadline: Instant) -> Result<(), TErr>;
    /// The one way to send: refused unless `w` was made for this very collection and it is open for writing (or, on
    /// a Feature handle, `w` is a feature report).
    fn send(&mut self, w: &AllowedWrite, deadline: Instant) -> Result<(), TErr> {
        let open = match self.mode() {
            OpenMode::ReadWrite => true,
            OpenMode::Feature => w.kind() == allow::ReportKind::Feature,
            OpenMode::QueryOnly | OpenMode::Read => false,
        };
        if w.ident() != self.ident() || !open {
            return Err(TErr::Refused);
        }
        if Instant::now() >= deadline {
            return Err(TErr::Timeout);
        }
        self.send_allowed(w, deadline)
    }
}

/// A reply as the reader may use it: at least `min_len` bytes, and its first byte the report id asked for (when the
/// device numbers its reports, `report_id` != 0).
pub fn checked_reply(reply: &[u8], report_id: u8, min_len: usize) -> Result<(), TErr> {
    if reply.len() < min_len.max(1) {
        return Err(TErr::BadReply);
    }
    if report_id != 0 && reply[0] != report_id {
        return Err(TErr::BadReply);
    }
    Ok(())
}

/// Time left before `deadline`, or Timeout.
pub fn left(deadline: Instant) -> Result<std::time::Duration, TErr> {
    let now = Instant::now();
    if now >= deadline {
        Err(TErr::Timeout)
    } else {
        Ok(deadline - now)
    }
}

#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use std::collections::{HashMap, VecDeque};

    /// A transport that answers from a table and records every byte sent. `stream`: the input reports the device
    /// sends on its own, in order; `replies`: what it sends after each write (the n-th list after the n-th write);
    /// `flushes`: how often the queue was dropped.
    pub struct FakeHid {
        pub id: HidIdent,
        pub mode: OpenMode,
        pub features: HashMap<u8, Vec<u8>>,
        pub inputs: HashMap<u8, Vec<u8>>,
        pub sent: Vec<Vec<u8>>,
        pub stream: VecDeque<Vec<u8>>,
        pub replies: VecDeque<Vec<Vec<u8>>>,
        /// What a feature report set makes the device hold (the n-th set report answers with the n-th entry, kept as
        /// the feature report of its first byte's id; an empty entry: nothing changes).
        pub feature_replies: VecDeque<Vec<u8>>,
        /// The kinds of the reports sent, in order (sent[i] went as kinds[i]).
        pub kinds: Vec<crate::allow::ReportKind>,
        pub flushes: usize,
        pub reads: usize,
        /// A sibling collection's fake: its queued reports stand for what the device sends after the request made on
        /// the other collection, so a flush counts but keeps them.
        pub keep_on_flush: bool,
    }
    impl FakeHid {
        pub fn new(id: HidIdent) -> FakeHid {
            let mode = open_mode_for(&id, false);
            FakeHid { id, mode, features: HashMap::new(), inputs: HashMap::new(), sent: Vec::new(), stream: VecDeque::new(), replies: VecDeque::new(), feature_replies: VecDeque::new(), kinds: Vec::new(), flushes: 0, reads: 0, keep_on_flush: false }
        }
    }
    impl HidTransport for FakeHid {
        fn ident(&self) -> &HidIdent {
            &self.id
        }
        fn mode(&self) -> OpenMode {
            self.mode
        }
        fn get_feature(&mut self, report_id: u8, len: usize, deadline: Instant) -> Result<Vec<u8>, TErr> {
            left(deadline)?;
            let mut r = self.features.get(&report_id).cloned().ok_or(TErr::Failed("no such report".into()))?;
            r.truncate(len);
            Ok(r)
        }
        fn get_input(&mut self, report_id: u8, len: usize, deadline: Instant) -> Result<Vec<u8>, TErr> {
            left(deadline)?;
            let mut r = self.inputs.get(&report_id).cloned().ok_or(TErr::Failed("no such report".into()))?;
            r.truncate(len);
            Ok(r)
        }
        fn read_input(&mut self, deadline: Instant) -> Result<Vec<u8>, TErr> {
            left(deadline)?;
            self.reads += 1;
            // (Nothing queued: the device is quiet — the real read would wait for the deadline.)
            self.stream.pop_front().ok_or(TErr::Timeout)
        }
        fn flush(&mut self) {
            self.flushes += 1;
            if !self.keep_on_flush {
                self.stream.clear();
            }
        }
        fn send_allowed(&mut self, w: &AllowedWrite, _deadline: Instant) -> Result<(), TErr> {
            self.sent.push(w.bytes().to_vec());
            self.kinds.push(w.kind());
            if w.kind() == crate::allow::ReportKind::Feature && !self.feature_replies.is_empty() {
                if let Some(r) = self.feature_replies.pop_front() {
                    if let Some(&id) = r.first() {
                        self.features.insert(id, r);
                    }
                }
            } else if let Some(r) = self.replies.pop_front() {
                // (An output request's reply — or a feature request's that comes back as input reports.)
                self.stream.extend(r);
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeHid;
    use super::*;
    use crate::allow::{permit, permit_test, AllowEntry, DeviceMatch, ReportKind};
    use std::time::Duration;

    fn id(pid: u16) -> HidIdent {
        HidIdent { vid: 0x1234, pid, usage_page: 0x0C, usage: 1, interface: -1 }
    }
    static TABLE: &[AllowEntry] = &[AllowEntry { device: DeviceMatch::product(0x1234, 0x0001), kind: ReportKind::Output, bytes: &[0x05, 0x01], why: "test" }];

    #[test]
    fn a_device_not_listed_is_opened_for_queries_only_and_nothing_can_be_sent() {
        let mut d = FakeHid::new(id(0x0001));
        assert_eq!(d.mode(), OpenMode::QueryOnly, "the shipped table lists nothing");
        assert_eq!(open_mode_for(&id(1), true), OpenMode::Read);
        // (The shipped table makes no AllowedWrite; one from a test table is refused on a query-only handle.)
        assert!(permit(&id(0x0001), ReportKind::Output, &[0x05, 0x01]).is_none());
        let w = permit_test(TABLE, &id(0x0001), ReportKind::Output, &[0x05, 0x01]).unwrap();
        let far = Instant::now() + Duration::from_secs(5);
        assert_eq!(d.send(&w, far), Err(TErr::Refused));
        assert!(d.sent.is_empty());
    }

    #[test]
    fn a_permit_for_another_device_is_refused() {
        let w = permit_test(TABLE, &id(0x0001), ReportKind::Output, &[0x05, 0x01]).unwrap();
        let mut other = FakeHid::new(id(0x0002));
        other.mode = OpenMode::ReadWrite;
        let far = Instant::now() + Duration::from_secs(5);
        assert_eq!(other.send(&w, far), Err(TErr::Refused));
        let mut same = FakeHid::new(id(0x0001));
        same.mode = OpenMode::ReadWrite;
        assert_eq!(same.send(&w, far), Ok(()));
        assert_eq!(same.sent, vec![vec![0x05, 0x01]], "exactly the listed bytes, nothing else");
    }

    #[test]
    fn deadlines() {
        let mut d = FakeHid::new(id(1));
        d.features.insert(3, vec![3, 50]);
        let past = Instant::now() - Duration::from_millis(1);
        assert_eq!(d.get_feature(3, 2, past), Err(TErr::Timeout));
        assert_eq!(d.get_feature(3, 2, Instant::now() + Duration::from_secs(1)), Ok(vec![3, 50]));
        assert!(left(past).is_err());
    }

    #[test]
    fn replies_are_checked_against_their_request() {
        assert_eq!(checked_reply(&[3, 50], 3, 2), Ok(()));
        assert_eq!(checked_reply(&[4, 50], 3, 2), Err(TErr::BadReply), "another report's reply");
        assert_eq!(checked_reply(&[3], 3, 2), Err(TErr::BadReply), "short");
        assert_eq!(checked_reply(&[], 0, 0), Err(TErr::BadReply), "empty");
        assert_eq!(checked_reply(&[9, 1], 0, 2), Ok(()), "unnumbered reports: any first byte");
    }
}
