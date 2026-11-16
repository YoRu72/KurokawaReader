//! The draw list: one instance per particle drawn, in a flat `f32` buffer the page reads straight out of wasm memory
//! (a Float32Array over `scene_inst(handle)`, `count × STRIDE` floats). Allocated once at load; a step only overwrites.
//!
//! THE INSTANCE LAYOUT (the one place it is defined; sceneHost.ts mirrors these numbers and checks `scene_stride()`):
//!
//! | float | field     | meaning                                                                 |
//! |-------|-----------|-------------------------------------------------------------------------|
//! | 0     | x         | centre, CSS pixels from the viewport's left                             |
//! | 1     | y         | centre, CSS pixels from the viewport's top                              |
//! | 2     | size      | diameter, CSS pixels                                                    |
//! | 3     | rotation  | radians (the page turns sprites that are not round)                     |
//! | 4     | alpha     | 0–1, already multiplied by the fade and the layer's opacity             |
//! | 5     | sprite    | sprite id (0 = soft dot), a whole number                                |
//! | 6     | colour    | index into the palette's roles, a whole number                          |
//! | 7     | depth     | the layer's depth, 0 far … 1 near                                       |
//!
//! Instances come far to near (the drawing order). Standalone: `rustc --edition 2021 --test src/drawlist.rs`.

pub const STRIDE: usize = 8;
pub const F_X: usize = 0;
pub const F_Y: usize = 1;
pub const F_SIZE: usize = 2;
pub const F_ROT: usize = 3;
pub const F_ALPHA: usize = 4;
pub const F_SPRITE: usize = 5;
pub const F_COLOUR: usize = 6;
pub const F_DEPTH: usize = 7;

/// One instance's values, in the order of the layout above.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Inst {
    pub x: f32,
    pub y: f32,
    pub size: f32,
    pub rot: f32,
    pub alpha: f32,
    pub sprite: u8,
    pub colour: u8,
    pub depth: f32,
}

pub struct DrawList {
    buf: Vec<f32>,
    count: usize,
}

impl DrawList {
    /// Room for `cap` instances, allocated now and never again.
    pub fn new(cap: usize) -> DrawList {
        DrawList { buf: vec![0.0; cap.max(1) * STRIDE], count: 0 }
    }
    pub fn clear(&mut self) {
        self.count = 0;
    }
    pub fn capacity(&self) -> usize {
        self.buf.len() / STRIDE
    }
    pub fn count(&self) -> usize {
        self.count
    }
    /// Adds one; false (and nothing written) when full.
    pub fn push(&mut self, i: Inst) -> bool {
        let at = self.count * STRIDE;
        if at + STRIDE > self.buf.len() {
            return false;
        }
        let s = &mut self.buf[at..at + STRIDE];
        s[F_X] = i.x;
        s[F_Y] = i.y;
        s[F_SIZE] = i.size;
        s[F_ROT] = i.rot;
        s[F_ALPHA] = i.alpha;
        s[F_SPRITE] = i.sprite as f32;
        s[F_COLOUR] = i.colour as f32;
        s[F_DEPTH] = i.depth;
        self.count += 1;
        true
    }
    /// The buffer's start (stable for the life of the list: it never grows).
    pub fn ptr(&self) -> *const f32 {
        self.buf.as_ptr()
    }
    /// The instances written, as floats.
    pub fn floats(&self) -> &[f32] {
        &self.buf[..self.count * STRIDE]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_and_capacity() {
        let mut d = DrawList::new(2);
        let p = d.ptr();
        let a = Inst { x: 1.0, y: 2.0, size: 3.0, rot: 4.0, alpha: 0.5, sprite: 6, colour: 7, depth: 0.8 };
        assert!(d.push(a));
        assert!(d.push(a));
        assert!(!d.push(a));
        assert_eq!(d.count(), 2);
        assert_eq!(&d.floats()[..STRIDE], &[1.0, 2.0, 3.0, 4.0, 0.5, 6.0, 7.0, 0.8]);
        d.clear();
        assert_eq!(d.count(), 0);
        assert_eq!(d.ptr(), p);
        assert_eq!(DrawList::new(0).capacity(), 1);
    }
}
