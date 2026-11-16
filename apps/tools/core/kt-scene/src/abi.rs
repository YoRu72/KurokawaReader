//! The ABI the page calls (hand-written `extern "C"`, no wasm-bindgen; sceneHost.ts is its only caller). Every
//! function takes and returns plain numbers; a scene is a handle (1–8), an error a negative code.
//!
//! | export                                   | returns                                                          |
//! |------------------------------------------|------------------------------------------------------------------|
//! | `kt_abi() -> u32`                        | ABI version (1)                                                  |
//! | `kt_alloc(len) -> ptr`                   | `len` bytes for the page to write a scene file into (0: refused) |
//! | `kt_free(ptr, len)`                      | gives them back                                                  |
//! | `scene_load(ptr, len, seed) -> i32`      | a handle (> 0), or `ERR_*` (scenefile.rs, and −20… below)        |
//! | `scene_viewport(h, w, hgt) -> i32`       | 0, CSS pixels                                                    |
//! | `scene_palette(h, role, rgba) -> i32`    | the scene's role count; `ERR_ARG` for a role it does not have    |
//! | `scene_roles(h) -> i32`                  | the role count                                                   |
//! | `scene_param(h, id, value) -> i32`       | 0; `ERR_ARG` for an unknown id (0 speed, 1 density)              |
//! | `scene_step(h, dt_ms) -> i32`            | instances to draw (fixed 1/60 s steps inside, at most 4)         |
//! | `scene_substeps(h) -> i32`               | fixed steps the last `scene_step` took (0: nothing moved)        |
//! | `scene_inst(h) -> ptr`                   | the instances, `count × scene_stride()` f32 (drawlist.rs layout) |
//! | `scene_stride() -> i32`                  | floats per instance (8)                                          |
//! | `scene_hint(h, id) -> f32`               | 0 fps, 1 resolution (the file's view hints)                      |
//! | `scene_live(h) -> i32`                   | particles alive                                                  |
//! | `scene_state_hash(h) -> u32`             | the state hash (tests)                                           |
//! | `scene_free(h) -> i32`                   | 0                                                                |
//!
//! Memory: a scene allocates everything at load, so memory grows only then; the page re-takes its views when
//! `memory.buffer` changes anyway. Single-threaded (wasm32 has one thread; natively each test thread has its table).

#[cfg(kt_alone = "abi")]
#[path = "drawlist.rs"]
mod drawlist;
#[cfg(kt_alone = "abi")]
#[path = "forces.rs"]
mod forces;
#[cfg(kt_alone = "abi")]
#[path = "graph.rs"]
mod graph;
#[cfg(kt_alone = "abi")]
#[path = "math.rs"]
mod math;
#[cfg(kt_alone = "abi")]
#[path = "particles.rs"]
mod particles;
#[cfg(kt_alone = "abi")]
#[path = "scene.rs"]
mod scene;
#[cfg(kt_alone = "abi")]
#[path = "scenefile.rs"]
mod scenefile;

use crate::drawlist::STRIDE;
use crate::scene::Scene;
use crate::scenefile::MAX_JSON;
use std::cell::RefCell;

pub const ABI_VERSION: u32 = 1;
/// No scene with that handle.
pub const ERR_HANDLE: i32 = -20;
/// Already 8 scenes loaded.
pub const ERR_FULL: i32 = -21;
/// A bad argument (a null pointer, a length over the limit, an unknown parameter or role).
pub const ERR_ARG: i32 = -22;
pub const MAX_SCENES: usize = 8;

thread_local! {
    static SCENES: RefCell<Vec<Option<Box<Scene>>>> = const { RefCell::new(Vec::new()) };
}

fn with<R>(h: i32, f: impl FnOnce(&mut Scene) -> R) -> Result<R, i32> {
    SCENES.with(|t| {
        let mut t = t.borrow_mut();
        if h < 1 || h as usize > t.len() {
            return Err(ERR_HANDLE);
        }
        match t[h as usize - 1].as_deref_mut() {
            Some(s) => Ok(f(s)),
            None => Err(ERR_HANDLE),
        }
    })
}

fn code(r: Result<i32, i32>) -> i32 {
    r.unwrap_or_else(|e| e)
}

#[no_mangle]
pub extern "C" fn kt_abi() -> u32 {
    ABI_VERSION
}

/// `len` bytes (1 … MAX_JSON) the page writes into; null when refused.
#[no_mangle]
pub extern "C" fn kt_alloc(len: u32) -> *mut u8 {
    let len = len as usize;
    if len == 0 || len > MAX_JSON {
        return core::ptr::null_mut();
    }
    let mut v: Vec<u8> = Vec::with_capacity(len);
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

/// Gives back what `kt_alloc(len)` gave (the same `len`).
///
/// # Safety
/// `ptr` must come from `kt_alloc(len)` with this `len`, and be freed once.
#[no_mangle]
pub unsafe extern "C" fn kt_free(ptr: *mut u8, len: u32) {
    let len = len as usize;
    if ptr.is_null() || len == 0 || len > MAX_JSON {
        return;
    }
    drop(Vec::from_raw_parts(ptr, 0, len));
}

/// Loads a scene file the page wrote at `ptr` (`len` bytes).
///
/// # Safety
/// `ptr .. ptr + len` must be memory the page wrote (from `kt_alloc`).
#[no_mangle]
pub unsafe extern "C" fn scene_load(ptr: *const u8, len: u32, seed: u32) -> i32 {
    let len = len as usize;
    if ptr.is_null() || len == 0 || len > MAX_JSON {
        return ERR_ARG;
    }
    let bytes = core::slice::from_raw_parts(ptr, len);
    let free = SCENES.with(|t| {
        let t = t.borrow();
        t.iter().position(|s| s.is_none()).or(if t.len() < MAX_SCENES { Some(t.len()) } else { None })
    });
    let slot = match free {
        Some(i) => i,
        None => return ERR_FULL,
    };
    let scene = match Scene::load(bytes, seed) {
        Ok(s) => s,
        Err(e) => return e,
    };
    SCENES.with(|t| {
        let mut t = t.borrow_mut();
        if slot == t.len() {
            t.push(Some(Box::new(scene)));
        } else {
            t[slot] = Some(Box::new(scene));
        }
    });
    slot as i32 + 1
}

#[no_mangle]
pub extern "C" fn scene_viewport(h: i32, w: f32, hgt: f32) -> i32 {
    code(with(h, |s| {
        s.viewport(w, hgt);
        0
    }))
}

#[no_mangle]
pub extern "C" fn scene_palette(h: i32, role: u32, rgba: u32) -> i32 {
    code(with(h, |s| if s.palette(role, rgba) { s.roles() as i32 } else { ERR_ARG }))
}

#[no_mangle]
pub extern "C" fn scene_roles(h: i32) -> i32 {
    code(with(h, |s| s.roles() as i32))
}

#[no_mangle]
pub extern "C" fn scene_param(h: i32, id: u32, value: f32) -> i32 {
    code(with(h, |s| if s.param(id, value) { 0 } else { ERR_ARG }))
}

#[no_mangle]
pub extern "C" fn scene_step(h: i32, dt_ms: f32) -> i32 {
    code(with(h, |s| s.step(dt_ms) as i32))
}

#[no_mangle]
pub extern "C" fn scene_substeps(h: i32) -> i32 {
    code(with(h, |s| s.last_substeps() as i32))
}

#[no_mangle]
pub extern "C" fn scene_inst(h: i32) -> *const f32 {
    with(h, |s| s.instances().ptr()).unwrap_or(core::ptr::null())
}

#[no_mangle]
pub extern "C" fn scene_stride() -> i32 {
    STRIDE as i32
}

#[no_mangle]
pub extern "C" fn scene_hint(h: i32, id: u32) -> f32 {
    with(h, |s| match id {
        0 => s.def_fps,
        1 => s.def_resolution,
        _ => -1.0,
    })
    .unwrap_or(-1.0)
}

#[no_mangle]
pub extern "C" fn scene_live(h: i32) -> i32 {
    code(with(h, |s| s.live() as i32))
}

#[no_mangle]
pub extern "C" fn scene_state_hash(h: i32) -> u32 {
    with(h, |s| s.state_hash()).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn scene_free(h: i32) -> i32 {
    SCENES.with(|t| {
        let mut t = t.borrow_mut();
        if h < 1 || h as usize > t.len() || t[h as usize - 1].is_none() {
            return ERR_HANDLE;
        }
        t[h as usize - 1] = None;
        0
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenefile::{ERR_DEPTH, ERR_FORMAT, ERR_SIZE, ERR_SYNTAX, ERR_TYPE, ERR_UTF8};

    const MOTES: &str = include_str!("../../../src/theme/scenes/motes.json");

    /// As the page does: kt_alloc, copy, scene_load, kt_free.
    fn load(bytes: &[u8], seed: u32) -> i32 {
        let p = kt_alloc(bytes.len() as u32);
        if p.is_null() {
            return unsafe { scene_load(core::ptr::null(), bytes.len() as u32, seed) };
        }
        unsafe {
            core::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
            let h = scene_load(p, bytes.len() as u32, seed);
            kt_free(p, bytes.len() as u32);
            h
        }
    }

    #[test]
    fn the_page_s_path() {
        assert_eq!(kt_abi(), 1);
        assert_eq!(scene_stride(), 8);
        let h = load(MOTES.as_bytes(), 42);
        assert!(h > 0, "{h}");
        assert_eq!(scene_viewport(h, 1280.0, 800.0), 0);
        assert_eq!(scene_roles(h), 3);
        assert_eq!(scene_palette(h, 2, 0xaabbccff), 3);
        assert_eq!(scene_palette(h, 3, 0), ERR_ARG);
        assert_eq!(scene_param(h, 0, 0.5), 0);
        assert_eq!(scene_param(h, 7, 0.5), ERR_ARG);
        assert_eq!(scene_hint(h, 0), 24.0);
        assert_eq!(scene_hint(h, 1), 0.5);
        let p0 = scene_inst(h);
        let n = scene_step(h, 40.0);
        assert!(n > 0);
        assert_eq!(scene_substeps(h), 1);
        // (The buffer never moves: the page's view stays valid.)
        assert_eq!(scene_inst(h), p0);
        let floats = unsafe { core::slice::from_raw_parts(p0, n as usize * 8) };
        assert!(floats.iter().all(|v| v.is_finite()));
        assert!(scene_live(h) >= n);
        assert_eq!(scene_free(h), 0);
        assert_eq!(scene_free(h), ERR_HANDLE);
        assert_eq!(scene_step(h, 16.0), ERR_HANDLE);
        assert!(scene_inst(h).is_null());
        assert_eq!(scene_state_hash(h), 0);
        assert_eq!(scene_step(0, 16.0), ERR_HANDLE);
        assert_eq!(scene_step(-5, 16.0), ERR_HANDLE);
        assert_eq!(scene_step(i32::MAX, 16.0), ERR_HANDLE);
    }

    #[test]
    fn determinism_through_the_abi() {
        let a = load(MOTES.as_bytes(), 5);
        let b = load(MOTES.as_bytes(), 5);
        assert_ne!(a, b);
        for _ in 0..300 {
            scene_step(a, 16.7);
            scene_step(b, 16.7);
        }
        assert_eq!(scene_state_hash(a), scene_state_hash(b));
        scene_free(a);
        scene_free(b);
    }

    #[test]
    fn slots_are_capped_and_reused() {
        let hs: Vec<i32> = (0..MAX_SCENES).map(|k| load(MOTES.as_bytes(), k as u32)).collect();
        assert!(hs.iter().all(|&h| h > 0));
        assert_eq!(load(MOTES.as_bytes(), 99), ERR_FULL);
        scene_free(hs[3]);
        assert_eq!(load(MOTES.as_bytes(), 99), hs[3]);
        for h in 1..=MAX_SCENES as i32 {
            scene_free(h);
        }
    }

    #[test]
    fn hostile_files_give_codes() {
        assert!(kt_alloc(0).is_null());
        assert!(kt_alloc(MAX_JSON as u32 + 1).is_null());
        unsafe { kt_free(core::ptr::null_mut(), 5) };
        assert_eq!(unsafe { scene_load(core::ptr::null(), 10, 1) }, ERR_ARG);
        assert_eq!(load(&vec![b'['; MAX_JSON + 5], 1), ERR_ARG);
        assert_eq!(load("[".repeat(5000).as_bytes(), 1), ERR_DEPTH);
        assert_eq!(load(b"\xff\xfe{}", 1), ERR_UTF8);
        assert_eq!(load(b"{\"format\":\"ktscene/1\",\"emitters\":[{\"max\":[1]}]}", 1), ERR_TYPE);
        assert_eq!(load(b"{\"format\":\"ktscene/1\",\"emitters\":[{\"max\":1e400}]}", 1), crate::scenefile::ERR_NUMBER);
        assert_eq!(load(b"{\"format\":\"ktscene/1\",\"emitters\":[{\"max\":1e300}]}", 1) > 0, true);
        assert_eq!(load(b"{}", 1), ERR_FORMAT);
        assert_eq!(load(b"   ", 1), ERR_SYNTAX);
        assert_eq!(load(b"", 1), ERR_ARG);
        let _ = ERR_SIZE;
        // (No handle leaked by the refusals: 8 still fit after the one that loaded is freed.)
        for h in 1..=MAX_SCENES as i32 {
            scene_free(h);
        }
        let hs: Vec<i32> = (0..MAX_SCENES).map(|_| load(MOTES.as_bytes(), 1)).collect();
        assert!(hs.iter().all(|&h| h > 0));
        for h in hs {
            scene_free(h);
        }
    }
}
