//! kt-scene: the scene engine of Kurokawa Tools' animated backgrounds (a computer only). A scene is data — a
//! `ktscene/1` JSON file (scenefile.rs) —; this crate simulates it and hands the page a flat list of instances to draw
//! (drawlist.rs). Compiled to wasm32-unknown-unknown in CI (scripts/build-scene-wasm.sh, a pinned toolchain) into
//! apps/tools/public/scene/ktscene.wasm, never committed; apps/tools/src/theme/sceneHost.ts loads it lazily and draws
//! with Canvas2D. Std only, no crates: `cargo test --offline` here, and each module alone (test-alone.sh).
//!
//! - math: Vec2, PCG32, smooth value noise, the state hash (basic float operations only: deterministic everywhere)
//! - scenefile: the JSON reader (hard limits) and the validator (clamps, caps, error codes; never panics)
//! - particles: the pool (struct of arrays, allocated once), emitters and their initializers
//! - forces: drift noise, gravity, drag, bounds (wrap/kill), the fade over life
//! - graph: layers with depth, drawn far to near
//! - drawlist: the instance buffer and its layout (the one place it is defined)
//! - scene: a running scene — fixed 1/60 s steps, at most 4 a call
//! - abi: the `extern "C"` functions the page calls
pub mod abi;
pub mod drawlist;
pub mod forces;
pub mod graph;
pub mod math;
pub mod particles;
pub mod scene;
pub mod scenefile;
