// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): the Windows side of Galaxy Buds' reading (piece 6) — one RFCOMM
// connection to Samsung's status service, listened to, closed.
// Ported from Wireless Device Battery Monitor (https://github.com/krisgfx9/Wireless-Device-Battery-Monitor),
// src/drivers/galaxy_buds.cpp (StartWinsock, WaitSocket, ReadStatus) at commit 285d64254216857e94ca3ea3e1deb536f863e282,
// by krisgfx9 and its contributors, GPL-3.0-or-later.
// Nothing is sent: the buds push their status frame when the service opens. Only called for buds Windows reports
// connected, and only when the user turned «Galaxy Buds» on (win/mod.rs). Non-blocking socket; connect and every wait
// bounded by the caller's deadline (the original: 4 s to connect, then 3 s); at most 8 KB read; always closed.
// UNVERIFIED here: compiled only on Windows (type-checked elsewhere); real buds decide.
// Copyright (C) 2026 Kurokawa contributors.
use super::ffi::*;
use crate::galaxybuds::{find_status, Status, SERVICES};
use crate::transport::TErr;
use std::sync::OnceLock;
use std::time::Instant;

fn started() -> bool {
    static OK: OnceLock<bool> = OnceLock::new();
    *OK.get_or_init(|| {
        let mut data = [0u8; 512];
        unsafe { WSAStartup(0x0202, data.as_mut_ptr() as *mut std::ffi::c_void) == 0 }
    })
}

/// Waits until `s` is writable (connected) or readable, by `deadline`.
fn wait(s: SOCKET, write: bool, deadline: Instant) -> bool {
    let now = Instant::now();
    if now >= deadline {
        return false;
    }
    let left = deadline - now;
    let tv = TIMEVAL { tv_sec: left.as_secs().min(30) as i32, tv_usec: left.subsec_micros() as i32 };
    let mut set = FD_SET::one(s);
    let mut err = FD_SET::one(s);
    let r = unsafe {
        if write {
            select(0, std::ptr::null_mut(), &mut set, &mut err, &tv)
        } else {
            select(0, &mut set, std::ptr::null_mut(), &mut err, &tv)
        }
    };
    r > 0 && set.has(s) && !err.has(s)
}

fn one(addr: u64, svc: &(u32, u16, u16, [u8; 8], bool), deadline: Instant) -> Option<Status> {
    let s = unsafe { socket(AF_BTH, SOCK_STREAM, BTHPROTO_RFCOMM) };
    if s == INVALID_SOCKET {
        return None;
    }
    let mut nb: u32 = 1;
    unsafe { ioctlsocket(s, FIONBIO, &mut nb) };
    let sa = SOCKADDR_BTH { addressFamily: AF_BTH as u16, btAddr: addr, serviceClassId: GUID::new(svc.0, svc.1, svc.2, svc.3), port: 0 };
    let r = unsafe { connect(s, &sa as *const SOCKADDR_BTH as *const std::ffi::c_void, std::mem::size_of::<SOCKADDR_BTH>() as i32) };
    let mut found = None;
    if r == 0 || (unsafe { WSAGetLastError() } == WSAEWOULDBLOCK && wait(s, true, deadline)) {
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 512];
        while found.is_none() && buf.len() < 8192 && wait(s, false, deadline) {
            let n = unsafe { recv(s, chunk.as_mut_ptr(), chunk.len() as i32, 0) };
            if n <= 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n as usize]);
            found = find_status(&buf, svc.4);
        }
    }
    unsafe { closesocket(s) };
    found
}

/// The buds' status, from the first of Samsung's services that answers.
pub fn read(addr: u64, deadline: Instant) -> Result<Status, TErr> {
    if !started() {
        return Err(TErr::Failed("winsock".into()));
    }
    for svc in SERVICES.iter() {
        if Instant::now() >= deadline {
            return Err(TErr::Timeout);
        }
        if let Some(st) = one(addr, svc, deadline) {
            return Ok(st);
        }
    }
    Err(TErr::Timeout)
}
