//! The draw output: a COMMAND LIST — one layer-begin command per layer, in drawing order — and an INSTANCE buffer the
//! particle and fog layers' commands point into. Both are flat `f32` buffers the page reads straight out of wasm
//! memory; both are allocated once at load, a step only overwrites. The page never hard-codes the numbers below: it
//! reads every stride and offset from the module (`kt_layout`, abi.rs), so a later version can add fields.
//!
//! THE INSTANCE (`INST_STRIDE` = 16 floats), in scene units (the command's transform maps them to CSS pixels):
//!
//! | float | field   | meaning                                                                       |
//! |-------|---------|-------------------------------------------------------------------------------|
//! | 0     | x       | centre                                                                        |
//! | 1     | y       | centre                                                                        |
//! | 2     | sx      | width                                                                         |
//! | 3     | sy      | height (sx × the particle's stretch: streaks, flattened puffs)                |
//! | 4     | rot     | radians                                                                       |
//! | 5     | alpha   | 0–1, fade and layer opacity applied                                           |
//! | 6     | rgba    | the palette colour, 0xRRGGBBAA, as the f32's BITS (read it with a Uint32Array) |
//! | 7     | sprite  | 0 soft dot, 1 crisp dot, 2 streak, 3 ring, 4 puff, 5–7 crystal flakes, 8 petal, 9 leaf, 10 feather, 11 curtain (ribbon) |
//! | 8     | layer   | the layer's index                                                             |
//! | 9     | depth   | the layer's depth, 0 far … 1 near                                             |
//! | 10    | colour  | the palette index                                                             |
//! | 11–15 | —       | spare (0)                                                                     |
//!
//! THE COMMAND (`CMD_STRIDE` = 16 floats), one per layer:
//!
//! | float | field    | meaning                                                                        |
//! |-------|----------|--------------------------------------------------------------------------------|
//! | 0     | kind     | scenefile.rs LayerKind::code (0 particles, 1 sky, 2 silhouette, 3 disc, 4 fog, 5 band, 6 bokeh, 7 grain, 8 halftone, 9 ribbon, 10 mirror, 11 accum, 255 unknown) |
//! | 1     | blend    | 0 normal, 1 add, 2 screen, 3 multiply, 4 soft light                            |
//! | 2     | opacity  | 0–1                                                                            |
//! | 3     | depth    | 0 far … 1 near                                                                 |
//! | 4     | parallax | how much it follows the camera                                                 |
//! | 5     | start    | its first instance                                                             |
//! | 6     | count    | its instances                                                                  |
//! | 7     | layer    | the layer's index (also the key of its geometry: `scene_geom`)                 |
//! | 8     | scale    | CSS pixels per scene unit (cover/contain fit × the camera's zoom at this depth) |
//! | 9     | tx       | CSS pixels: screen x = x × scale + tx                                          |
//! | 10    | ty       | CSS pixels: screen y = y × scale + ty                                          |
//! | 11    | static   | 1: drawn once by the page from its geometry and blitted; 0: instances           |
//! | 12    | geomLen  | floats of its geometry                                                         |
//! | 13    | geomVer  | changes when the geometry is made again                                         |
//! | 14    | known    | 1: this engine knows the kind; 0: kept from the file but not drawn              |
//! | 15    | —        | spare                                                                          |
//!
//! Standalone: `rustc --edition 2021 --test src/drawlist.rs`.

pub const INST_STRIDE: usize = 16;
pub const I_X: usize = 0;
pub const I_Y: usize = 1;
pub const I_SX: usize = 2;
pub const I_SY: usize = 3;
pub const I_ROT: usize = 4;
pub const I_ALPHA: usize = 5;
pub const I_RGBA: usize = 6;
pub const I_SPRITE: usize = 7;
pub const I_LAYER: usize = 8;
pub const I_DEPTH: usize = 9;
pub const I_COLOUR: usize = 10;

pub const CMD_STRIDE: usize = 16;
pub const C_KIND: usize = 0;
pub const C_BLEND: usize = 1;
pub const C_OPACITY: usize = 2;
pub const C_DEPTH: usize = 3;
pub const C_PARALLAX: usize = 4;
pub const C_START: usize = 5;
pub const C_COUNT: usize = 6;
pub const C_LAYER: usize = 7;
pub const C_SCALE: usize = 8;
pub const C_TX: usize = 9;
pub const C_TY: usize = 10;
pub const C_STATIC: usize = 11;
pub const C_GEOM_LEN: usize = 12;
pub const C_GEOM_VER: usize = 13;
pub const C_KNOWN: usize = 14;

/// One instance's values.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Inst {
    pub x: f32,
    pub y: f32,
    pub sx: f32,
    pub sy: f32,
    pub rot: f32,
    pub alpha: f32,
    pub rgba: u32,
    pub sprite: u8,
    pub layer: u8,
    pub depth: f32,
    pub colour: u8,
}

/// One layer-begin command's values.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cmd {
    pub kind: u32,
    pub blend: u32,
    pub opacity: f32,
    pub depth: f32,
    pub parallax: f32,
    pub start: u32,
    pub count: u32,
    pub layer: u32,
    pub scale: f32,
    pub tx: f32,
    pub ty: f32,
    pub is_static: bool,
    pub geom_len: u32,
    pub geom_ver: u32,
    pub known: bool,
}

pub struct DrawList {
    /// (Words: f32 bits, but the rgba word as it is — never a float that could be a NaN pattern in Rust's hands.)
    inst: Vec<u32>,
    count: usize,
    cmds: Vec<f32>,
    ncmd: usize,
}

impl DrawList {
    /// Room for `cap` instances and `cmds` commands, allocated now and never again.
    pub fn new(cap: usize, cmds: usize) -> DrawList {
        DrawList { inst: vec![0; cap.max(1) * INST_STRIDE], count: 0, cmds: vec![0.0; cmds.max(1) * CMD_STRIDE], ncmd: 0 }
    }
    pub fn clear(&mut self) {
        self.count = 0;
        self.ncmd = 0;
    }
    pub fn capacity(&self) -> usize {
        self.inst.len() / INST_STRIDE
    }
    pub fn count(&self) -> usize {
        self.count
    }
    pub fn cmd_count(&self) -> usize {
        self.ncmd
    }
    /// Adds one instance; false (and nothing written) when full.
    pub fn push(&mut self, i: Inst) -> bool {
        let at = self.count * INST_STRIDE;
        if at + INST_STRIDE > self.inst.len() {
            return false;
        }
        let s = &mut self.inst[at..at + INST_STRIDE];
        s[I_X] = i.x.to_bits();
        s[I_Y] = i.y.to_bits();
        s[I_SX] = i.sx.to_bits();
        s[I_SY] = i.sy.to_bits();
        s[I_ROT] = i.rot.to_bits();
        s[I_ALPHA] = i.alpha.to_bits();
        s[I_RGBA] = i.rgba;
        s[I_SPRITE] = (i.sprite as f32).to_bits();
        s[I_LAYER] = (i.layer as f32).to_bits();
        s[I_DEPTH] = i.depth.to_bits();
        s[I_COLOUR] = (i.colour as f32).to_bits();
        self.count += 1;
        true
    }
    /// Adds one command; false when full.
    pub fn push_cmd(&mut self, c: Cmd) -> bool {
        let at = self.ncmd * CMD_STRIDE;
        if at + CMD_STRIDE > self.cmds.len() {
            return false;
        }
        let s = &mut self.cmds[at..at + CMD_STRIDE];
        s[C_KIND] = c.kind as f32;
        s[C_BLEND] = c.blend as f32;
        s[C_OPACITY] = c.opacity;
        s[C_DEPTH] = c.depth;
        s[C_PARALLAX] = c.parallax;
        s[C_START] = c.start as f32;
        s[C_COUNT] = c.count as f32;
        s[C_LAYER] = c.layer as f32;
        s[C_SCALE] = c.scale;
        s[C_TX] = c.tx;
        s[C_TY] = c.ty;
        s[C_STATIC] = if c.is_static { 1.0 } else { 0.0 };
        s[C_GEOM_LEN] = c.geom_len as f32;
        s[C_GEOM_VER] = c.geom_ver as f32;
        s[C_KNOWN] = if c.known { 1.0 } else { 0.0 };
        s[15] = 0.0;
        self.ncmd += 1;
        true
    }
    /// The buffers' starts (stable for the life of the list: they never grow).
    pub fn ptr(&self) -> *const u32 {
        self.inst.as_ptr()
    }
    pub fn cmd_ptr(&self) -> *const f32 {
        self.cmds.as_ptr()
    }
    /// Field `f` of instance `k` as a float (the rgba word: use `word`).
    pub fn get(&self, k: usize, f: usize) -> f32 {
        f32::from_bits(self.inst[k * INST_STRIDE + f])
    }
    pub fn word(&self, k: usize, f: usize) -> u32 {
        self.inst[k * INST_STRIDE + f]
    }
    /// Every float field of every instance finite (the rgba word left out).
    pub fn all_finite(&self) -> bool {
        (0..self.count).all(|k| (0..INST_STRIDE).all(|f| f == I_RGBA || self.get(k, f).is_finite()))
    }
    pub fn cmd_floats(&self) -> &[f32] {
        &self.cmds[..self.ncmd * CMD_STRIDE]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_and_capacity() {
        let mut d = DrawList::new(2, 1);
        let p = d.ptr();
        let a = Inst { x: 1.0, y: 2.0, sx: 3.0, sy: 4.0, rot: 5.0, alpha: 0.5, rgba: 0xaabbccdd, sprite: 6, layer: 7, depth: 0.8, colour: 9 };
        assert!(d.push(a));
        assert!(d.push(a));
        assert!(!d.push(a));
        assert_eq!(d.count(), 2);
        assert_eq!((0..6).map(|k| d.get(1, k)).collect::<Vec<_>>(), vec![1.0, 2.0, 3.0, 4.0, 5.0, 0.5]);
        assert_eq!(d.word(1, I_RGBA), 0xaabbccdd);
        assert_eq!((d.get(0, I_SPRITE), d.get(0, I_LAYER), d.get(0, I_DEPTH), d.get(0, I_COLOUR)), (6.0, 7.0, 0.8, 9.0));
        assert!(d.all_finite());
        let c = Cmd { kind: 2, blend: 1, opacity: 0.5, depth: 0.4, parallax: 0.3, start: 0, count: 0, layer: 3, scale: 0.8, tx: -10.0, ty: 4.0, is_static: true, geom_len: 99, geom_ver: 1, known: true };
        assert!(d.push_cmd(c));
        assert!(!d.push_cmd(c));
        assert_eq!(&d.cmd_floats()[..15], &[2.0, 1.0, 0.5, 0.4, 0.3, 0.0, 0.0, 3.0, 0.8, -10.0, 4.0, 1.0, 99.0, 1.0, 1.0]);
        d.clear();
        assert_eq!((d.count(), d.cmd_count()), (0, 0));
        assert_eq!(d.ptr(), p);
        assert_eq!(DrawList::new(0, 0).capacity(), 1);
    }
}
