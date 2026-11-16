//! kt-scene: the scene engine of Kurokawa Tools' animated backgrounds (a computer only). A scene is data — a
//! `ktscene/1` JSON file (scenefile.rs): a composition of layers (sky, silhouettes, disc, fog, particles…) with its own
//! palette —; this crate simulates it and hands the page a command list and an instance buffer to draw (drawlist.rs).
//! Compiled to wasm32-unknown-unknown in CI (scripts/build-scene-wasm.sh, a pinned toolchain) into
//! apps/tools/public/scene/ktscene.wasm, never committed; apps/tools/src/theme/sceneHost.ts loads it lazily and draws
//! with Canvas2D. Std only, no crates: `cargo test --offline` here, and each module alone (test-alone.sh).
//!
//! - json: the strict JSON reader (hard limits, error codes)
//! - math: Vec2, PCG32, smooth value noise, the state hash (basic float operations only: deterministic everywhere)
//! - scenefile: the validator (palette, params, layers and their kinds, emitters; clamps, caps; never panics)
//! - particles: the pool (struct of arrays, allocated once), emitters (own seeded streams) and initializers
//! - forces: drift noise, gravity, drag, pointer and click, wind, bounds (wrap/kill), the fade over life
//! - scenery: static layers' geometry (made once, from a seed) and fog
//! - graph: the layer stack, in file order
//! - drawlist: the command list, the instance buffer and their layouts (the one place they are defined)
//! - scene: a running scene — scene space, fit, camera, fixed 1/60 s steps, at most 4 a call
//! - abi: the `extern "C"` functions the page calls
pub mod abi;
pub mod drawlist;
pub mod forces;
pub mod graph;
pub mod json;
pub mod math;
pub mod particles;
pub mod scene;
pub mod scenefile;
pub mod scenery;
