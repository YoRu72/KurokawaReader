//! The ABI the page calls (hand-written `extern "C"`, no wasm-bindgen; sceneHost.ts is its only caller). Every
//! function takes and returns plain numbers; a scene is a handle (1–8), an error a negative code.
//!
//! ABI 2 (ABI 1, the first slice, had one instance layout of 8 floats and no commands):
//!
//! | export                                     | returns                                                       |
//! |--------------------------------------------|---------------------------------------------------------------|
//! | `kt_abi() -> u32`                          | 2                                                             |
//! | `kt_feature(id) -> u32`                    | 1 when the engine has feature `id` (0 pointer, 1 click, 2 camera, 3 groups, 4 fog, 5 silhouettes, 6 ribbons, 7 mirror, 8 accumulation, 9 children on death and the react param, 10 springing offsets, twinkle, swell, gust, shafts, arcs, clicks giving birth), else 0 |
//! | `kt_layout(id) -> i32`                     | the layouts (drawlist.rs): 0 instance stride, 1 command stride, 100 + an instance field's name number → its offset, 200 + a command field's → its offset (see `LAYOUT`); −1 unknown |
//! | `kt_alloc(len) -> ptr`, `kt_free(ptr, len)`| `len` bytes (1 … 256 KB) for the page to write a scene file into |
//! | `scene_load(ptr, len, seed) -> i32`        | a handle (> 0), or `ERR_*` (json.rs, and −20… below)          |
//! | `scene_viewport(h, w, hgt) -> i32`         | 0 — the window, CSS pixels                                    |
//! | `scene_camera(h, px, py, zoom) -> i32`     | 0 — shift −1…1 (× each layer's parallax), zoom 1–1.5          |
//! | `scene_pointer(h, x, y, buttons) -> i32`   | 0 — CSS pixels; outside the window: no pointer                |
//! | `scene_click(h, x, y) -> i32`              | 0 — answered at the next fixed step                          |
//! | `scene_palette(h, i, rgba) -> i32`         | the palette's size; `ERR_ARG` for no such entry                |
//! | `scene_palette_get(h, i) -> u32`           | an entry's colour now (0xRRGGBBAA; a literal's own until set)  |
//! | `scene_roles(h) -> i32`                    | the palette's size                                            |
//! | `scene_param(h, id, v) -> i32`             | 0; `ERR_ARG` for no such param (0 speed, 1 density, 2 wind x, 3 wind y, 4 size, 5 react, 16 + i the file's) |
//! | `scene_param_get(h, id) -> f32`            | its value (NaN: none)                                         |
//! | `scene_group(h, g, density, size) -> i32`  | 0; `ERR_ARG` for no such group                                 |
//! | `scene_step(h, dt_ms) -> i32`              | instances to draw (fixed 1/60 s steps inside, at most 4)      |
//! | `scene_substeps(h) -> i32`                 | fixed steps the last `scene_step` took (0: nothing moved)     |
//! | `scene_cmds(h) -> ptr`, `scene_ncmd(h)`    | the command list (one per layer)                              |
//! | `scene_inst(h) -> ptr`                     | the instances                                                 |
//! | `scene_geom(h, layer) -> ptr`              | a layer's geometry (scenery.rs; its length is in its command) |
//! | `scene_hint(h, id) -> f32`                 | 0 fps, 1 resolution, 2 space w, 3 space h, 4 overscan          |
//! | `scene_live(h) -> i32`                     | particles alive                                               |
//! | `scene_state_hash(h) -> u32`               | the state hash (tests; the golden hash)                        |
//! | `scene_free(h) -> i32`                     | 0                                                             |
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
#[path = "json.rs"]
mod json;
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
#[cfg(kt_alone = "abi")]
#[path = "scenery.rs"]
mod scenery;

use crate::drawlist as dl;
use crate::json::MAX_JSON;
use crate::scene::Scene;
use std::alloc::{alloc, dealloc, Layout};
use std::cell::RefCell;

pub const ABI_VERSION: u32 = 2;
/// No scene with that handle.
pub const ERR_HANDLE: i32 = -20;
/// Already 8 scenes loaded.
pub const ERR_FULL: i32 = -21;
/// A bad argument (a null pointer, a length over the limit, an unknown parameter, entry or group).
pub const ERR_ARG: i32 = -22;
pub const MAX_SCENES: usize = 8;

/// The layouts by number, for `kt_layout`: (id, value). Instance fields are 100 + n, command fields 200 + n, in the
/// order of drawlist.rs's tables (x, y, sx, sy, rot, alpha, rgba, sprite, layer, depth, colour; kind, blend, opacity,
/// depth, parallax, start, count, layer, scale, tx, ty, static, geomLen, geomVer, known).
pub const LAYOUT: [(u32, i32); 28] = [
    (0, dl::INST_STRIDE as i32),
    (1, dl::CMD_STRIDE as i32),
    (100, dl::I_X as i32),
    (101, dl::I_Y as i32),
    (102, dl::I_SX as i32),
    (103, dl::I_SY as i32),
    (104, dl::I_ROT as i32),
    (105, dl::I_ALPHA as i32),
    (106, dl::I_RGBA as i32),
    (107, dl::I_SPRITE as i32),
    (108, dl::I_LAYER as i32),
    (109, dl::I_DEPTH as i32),
    (110, dl::I_COLOUR as i32),
    (200, dl::C_KIND as i32),
    (201, dl::C_BLEND as i32),
    (202, dl::C_OPACITY as i32),
    (203, dl::C_DEPTH as i32),
    (204, dl::C_PARALLAX as i32),
    (205, dl::C_START as i32),
    (206, dl::C_COUNT as i32),
    (207, dl::C_LAYER as i32),
    (208, dl::C_SCALE as i32),
    (209, dl::C_TX as i32),
    (210, dl::C_TY as i32),
    (211, dl::C_STATIC as i32),
    (212, dl::C_GEOM_LEN as i32),
    (213, dl::C_GEOM_VER as i32),
    (214, dl::C_KNOWN as i32),
];

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

fn ok_or_arg(b: bool) -> i32 {
    if b {
        0
    } else {
        ERR_ARG
    }
}

#[no_mangle]
pub extern "C" fn kt_abi() -> u32 {
    ABI_VERSION
}

#[no_mangle]
pub extern "C" fn kt_feature(id: u32) -> u32 {
    (id <= 10) as u32
}

#[no_mangle]
pub extern "C" fn kt_layout(id: u32) -> i32 {
    LAYOUT.iter().find(|(k, _)| *k == id).map(|(_, v)| *v).unwrap_or(-1)
}

/// The allocation layout of `len` bytes (8-aligned: any scalar fits).
fn layout_of(len: usize) -> Option<Layout> {
    if len == 0 || len > MAX_JSON {
        return None;
    }
    Layout::from_size_align(len, 8).ok()
}

/// `len` bytes (1 … MAX_JSON) the page writes into; null when refused.
#[no_mangle]
pub extern "C" fn kt_alloc(len: u32) -> *mut u8 {
    match layout_of(len as usize) {
        // (SAFETY: a non-zero size and a valid alignment.)
        Some(l) => unsafe { alloc(l) },
        None => core::ptr::null_mut(),
    }
}

/// Gives back what `kt_alloc(len)` gave (the same `len`).
///
/// # Safety
/// `ptr` must come from `kt_alloc(len)` with this `len`, and be freed once.
#[no_mangle]
pub unsafe extern "C" fn kt_free(ptr: *mut u8, len: u32) {
    if ptr.is_null() {
        return;
    }
    if let Some(l) = layout_of(len as usize) {
        dealloc(ptr, l);
    }
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
pub extern "C" fn scene_camera(h: i32, px: f32, py: f32, zoom: f32) -> i32 {
    code(with(h, |s| {
        s.camera(px, py, zoom);
        0
    }))
}

#[no_mangle]
pub extern "C" fn scene_pointer(h: i32, x: f32, y: f32, buttons: u32) -> i32 {
    code(with(h, |s| {
        s.pointer(x, y, buttons);
        0
    }))
}

#[no_mangle]
pub extern "C" fn scene_click(h: i32, x: f32, y: f32) -> i32 {
    code(with(h, |s| {
        s.click(x, y);
        0
    }))
}

#[no_mangle]
pub extern "C" fn scene_palette(h: i32, i: u32, rgba: u32) -> i32 {
    code(with(h, |s| if s.palette(i, rgba) { s.roles() as i32 } else { ERR_ARG }))
}

#[no_mangle]
pub extern "C" fn scene_palette_get(h: i32, i: u32) -> u32 {
    with(h, |s| s.palette_get(i).unwrap_or(0)).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn scene_roles(h: i32) -> i32 {
    code(with(h, |s| s.roles() as i32))
}

#[no_mangle]
pub extern "C" fn scene_param(h: i32, id: u32, value: f32) -> i32 {
    code(with(h, |s| ok_or_arg(s.param(id, value))))
}

#[no_mangle]
pub extern "C" fn scene_param_get(h: i32, id: u32) -> f32 {
    with(h, |s| s.param_get(id).unwrap_or(f32::NAN)).unwrap_or(f32::NAN)
}

#[no_mangle]
pub extern "C" fn scene_group(h: i32, g: u32, density: f32, size: f32) -> i32 {
    code(with(h, |s| ok_or_arg(s.group(g, density, size))))
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
pub extern "C" fn scene_cmds(h: i32) -> *const f32 {
    with(h, |s| s.instances().cmd_ptr()).unwrap_or(core::ptr::null())
}

#[no_mangle]
pub extern "C" fn scene_ncmd(h: i32) -> i32 {
    code(with(h, |s| s.instances().cmd_count() as i32))
}

#[no_mangle]
pub extern "C" fn scene_inst(h: i32) -> *const u32 {
    with(h, |s| s.instances().ptr()).unwrap_or(core::ptr::null())
}

#[no_mangle]
pub extern "C" fn scene_geom(h: i32, layer: u32) -> *const f32 {
    with(h, |s| {
        let g = s.geom(layer as usize);
        if g.is_empty() {
            core::ptr::null()
        } else {
            g.as_ptr()
        }
    })
    .unwrap_or(core::ptr::null())
}

#[no_mangle]
pub extern "C" fn scene_hint(h: i32, id: u32) -> f32 {
    with(h, |s| match id {
        0 => s.def_fps,
        1 => s.def_resolution,
        2 => s.transform_space().0,
        3 => s.transform_space().1,
        4 => s.transform_space().2,
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
    use crate::json::{ERR_DEPTH, ERR_FORMAT, ERR_NUMBER, ERR_SYNTAX, ERR_TYPE, ERR_UTF8};

    const MOTES: &str = include_str!("../../../src/theme/scenes/motes.json");
    const SNOW: &str = include_str!("../../../src/theme/scenes/night-snowfall.json");

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
        assert_eq!(kt_abi(), 2);
        assert_eq!((kt_layout(0), kt_layout(1), kt_layout(106), kt_layout(209), kt_layout(999)), (16, 16, 6, 9, -1));
        assert_eq!((kt_feature(0), kt_feature(10), kt_feature(11)), (1, 1, 0));
        let h = load(SNOW.as_bytes(), 42);
        assert!(h > 0, "{h}");
        assert_eq!(scene_viewport(h, 1280.0, 800.0), 0);
        assert_eq!(scene_camera(h, 0.2, -0.1, 1.02), 0);
        assert_eq!(scene_pointer(h, 300.0, 200.0, 0), 0);
        assert_eq!(scene_click(h, 300.0, 200.0), 0);
        let n = scene_roles(h);
        assert_eq!(n, 14);
        assert_eq!(scene_palette_get(h, 0), 0x040822ff);
        assert_eq!(scene_palette(h, 2, 0xaabbccff), n);
        assert_eq!(scene_palette_get(h, 2), 0xaabbccff);
        assert_eq!(scene_palette(h, n as u32, 0), ERR_ARG);
        assert_eq!(scene_param(h, 0, 0.5), 0);
        assert_eq!(scene_param(h, 16, 0.5), 0);
        assert_eq!(scene_param_get(h, 16), 0.5);
        assert!(scene_param_get(h, 17).is_nan());
        assert_eq!(scene_param(h, 7, 0.5), ERR_ARG);
        assert_eq!(scene_group(h, 0, 1.0, 1.0), 0);
        assert_eq!(scene_group(h, 1, 1.0, 1.0), ERR_ARG);
        assert_eq!((scene_hint(h, 0), scene_hint(h, 1), scene_hint(h, 2), scene_hint(h, 3), scene_hint(h, 4)), (24.0, 0.5, 1600.0, 1000.0, 0.06));
        let (p0, c0) = (scene_inst(h), scene_cmds(h));
        let count = scene_step(h, 40.0);
        assert!(count > 0);
        assert_eq!(scene_substeps(h), 1);
        assert_eq!(scene_ncmd(h), 9);
        // (The buffers never move: the page's views stay valid.)
        assert_eq!((scene_inst(h), scene_cmds(h)), (p0, c0));
        let cmds = unsafe { core::slice::from_raw_parts(c0, 9 * dl::CMD_STRIDE) };
        assert!(cmds.iter().all(|v| v.is_finite()));
        let sky_len = cmds[dl::C_GEOM_LEN] as usize;
        assert!(sky_len > 0 && !scene_geom(h, 0).is_null());
        let sky = unsafe { core::slice::from_raw_parts(scene_geom(h, 0), sky_len) };
        assert_eq!(sky[0], 4.0);
        assert!(scene_geom(h, 3).is_null(), "a particle layer has no geometry");
        let words = unsafe { core::slice::from_raw_parts(p0, count as usize * dl::INST_STRIDE) };
        // (Every instance's colour is the palette's, opaque; the floats finite.)
        assert!((0..count as usize).all(|k| words[k * 16 + dl::I_RGBA] & 0xff == 0xff && f32::from_bits(words[k * 16 + dl::I_ALPHA]).is_finite()));
        assert!(scene_live(h) > 0);
        assert_eq!(scene_free(h), 0);
        assert_eq!(scene_free(h), ERR_HANDLE);
        assert_eq!(scene_step(h, 16.0), ERR_HANDLE);
        assert!(scene_inst(h).is_null() && scene_cmds(h).is_null() && scene_geom(h, 0).is_null());
        assert_eq!(scene_state_hash(h), 0);
        assert_eq!(scene_step(0, 16.0), ERR_HANDLE);
        assert_eq!(scene_step(-5, 16.0), ERR_HANDLE);
        assert_eq!(scene_step(i32::MAX, 16.0), ERR_HANDLE);
    }

    #[test]
    fn golden_through_the_abi() {
        let h = load(MOTES.as_bytes(), 42);
        scene_viewport(h, 1312.0, 832.0);
        for _ in 0..600 {
            scene_step(h, 1000.0 / 60.0);
        }
        assert_eq!(scene_state_hash(h), crate::scene::GOLDEN);
        scene_free(h);
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
        assert_eq!(load(b"{\"format\":\"ktscene/1\",\"emitters\":[{\"max\":1e400}]}", 1), ERR_NUMBER);
        assert!(load(b"{\"format\":\"ktscene/1\",\"emitters\":[{\"max\":1e300}]}", 1) > 0);
        assert_eq!(load(b"{}", 1), ERR_FORMAT);
        assert_eq!(load(b"   ", 1), ERR_SYNTAX);
        assert_eq!(load(b"", 1), ERR_ARG);
        for h in 1..=MAX_SCENES as i32 {
            scene_free(h);
        }
        let hs: Vec<i32> = (0..MAX_SCENES).map(|_| load(MOTES.as_bytes(), 1)).collect();
        assert!(hs.iter().all(|&h| h > 0));
        for h in hs {
            scene_free(h);
        }
        // (Many allocations of every size given back: the allocator's layout matches.)
        for n in [1u32, 7, 8, 9, 4096, MAX_JSON as u32] {
            for _ in 0..50 {
                let p = kt_alloc(n);
                assert!(!p.is_null() && (p as usize).is_multiple_of(8));
                unsafe { kt_free(p, n) };
            }
        }
    }
}
